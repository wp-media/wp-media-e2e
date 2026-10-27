import { resolve } from "node:path";

import { defineConfig } from "@playwright/test";
import type { PlaywrightTestConfig, Project } from "@playwright/test";
import { defineBddConfig } from "playwright-bdd";

import { registerManifest } from "../artifacts/registry";
import {
  BDD_CONFIGS_ENV,
  assertNoForeignBddConfigs,
  assertPinKnown,
  assertSelectionFitsPin,
  cellsReached,
  pinnedCell,
} from "./cell-pin";
import { DESKTOP } from "./devices";
import { env, intEnv } from "./env";
import {
  registerDebugLogOptions,
  registerPool,
  registerSettleLeftovers,
  registerSiteDataDirResolver,
  registerSiteDbResidue,
  registerSiteResidue,
  registerStopRunningWork,
  routingMetadata,
} from "./metadata";
import { cellProjectNames } from "./project-names";
import {
  REPORTS_KEEP_ENV,
  REQUESTED_REF_ENV,
  RETRIES_ENV,
  RUN_NAME_ENV,
} from "./run-env";
import type { RunDescription } from "../reporting/run-description";
import { reporters } from "./reporting";
import { DEFAULT_RETENTION, MAX_REPORTS_KEEP } from "../reporting/retention";
import {
  assertNotStoppedYet,
  assertStopFileFolder,
  stopFileFromEnv,
} from "./drain";
import {
  NO_CELL,
  REPO_ROOT,
  RUN_ID,
  cellOwningOutput,
  dirs,
  outputDirFor,
  projectSelection,
  seedSelectedCells,
  selectedCells,
} from "./run-context";
import { VISUAL_EXPECT, snapshotPathTemplateFor } from "./visual";
import type { Edition, ProductConfig, SiteConfig, SitePool } from "./types";

/** Per-product Playwright config factory: expands a {@link ProductConfig} into a runnable Playwright config. */

// True when running under CI (the `CI` env var is present and non-empty).
const isCI = process.env.CI !== undefined && process.env.CI !== "";

/**
 * How many times a failed scenario is retried — **the single place retries are configured.**
 *
 * Two by default, so a scenario gets three attempts, everywhere rather than only on CI. These
 * scenarios drive a real WordPress over a network: an SSH hiccup, a slow first backup, a cell that
 * was briefly busy. Failing a run on the first such blip taught us to re-run by hand, which is the
 * same retry with a worse feedback loop and no record of having happened. Playwright marks a
 * scenario that only passed on a retry **flaky** rather than green, so the noise stays visible
 * instead of being laundered into a pass.
 *
 * A retry is a genuinely fresh attempt, not a resumption: the `@plugin` lifecycle hooks are
 * per-scenario (`Before`/`After` run as `beforeEach`/`afterEach`), so every attempt reinstalls the
 * plugin, clears `debug.log`, and sweeps residue before it starts.
 *
 * Override with `E2E_RETRIES` — `0` to fail fast while debugging, higher to ride out a sick cell.
 * Deliberately applied to the scenario projects only: the auth and artifact setups are not tests,
 * and a setup that cannot succeed should say so at once rather than three times.
 */
const RETRIES = intEnv(RETRIES_ENV, 2, 0, 10);

/**
 * How long a navigation may take — `goto`, `reload`, `waitForURL`, `waitForNavigation`, `goBack`,
 * `goForward`, `setContent` — unless the call passes its own `timeout`, which wins.
 *
 * Playwright's default is **no limit**: a page whose document was lost mid-load never fires `load`,
 * and the navigation then waits out the scenario's whole budget (measured: 16 minutes on one
 * attempt) before failing as a bare test timeout. Measured over a whole cell's run (58 navigations)
 * and a run's failing attempts, the slowest navigation bound by this took 5.6 s (the dashboard's
 * `goto`); the restore wizard's waits, which last minutes, pass their own timeouts. So a minute is a
 * margin of 10× that still fails a stuck page within one.
 */
export const NAVIGATION_TIMEOUT_MS = 60_000;

/**
 * How many reports the run's report folder keeps as the run ends (`reporting/run-pruning.ts`):
 * `E2E_REPORTS_KEEP`, 20 by default, `0` for no cap — the age rules still apply. Read here, as the
 * config is built, so a bad value fails the run at its start, naming the variable.
 */
const REPORTS_KEEP = intEnv(
  REPORTS_KEEP_ENV,
  DEFAULT_RETENTION.keep,
  0,
  MAX_REPORTS_KEEP,
);

/**
 * The auth setup's trace: kept for a failed attempt, like every project's, but without DOM snapshots.
 *
 * A snapshot records every form field's value — the login's password included, however it was
 * entered — and turning snapshots off also stops the trace recording network traffic, which carries
 * the session cookies WordPress sets. The setup only logs in and reads Site Health, so its trace
 * loses little: the actions, their timings and the screenshots stay.
 */
const SETUP_TRACE = {
  mode: "retain-on-failure",
  snapshots: { dom: false },
} as const;

/**
 * What the run is called and the plugin ref it was asked for, from the two display-only variables an
 * orchestrator sets (`E2E_RUN_NAME`, `E2E_REQUESTED_REF`) — it pins the run itself to the commit it
 * built, so the ref a person asked for would otherwise be lost. The reports show them; nothing acts
 * on them. A blank one is absent.
 */
function displayOnlyFacts(): Pick<RunDescription, "runName" | "requestedRef"> {
  const runName = env(RUN_NAME_ENV);
  const requestedRef = env(REQUESTED_REF_ENV);
  return {
    ...(runName !== "" ? { runName } : {}),
    ...(requestedRef !== "" ? { requestedRef } : {}),
  };
}

/**
 * Assigns each pooled site its per-run `storageState` path under the cell's auth dir. The path
 * is absolute: Playwright and `fs` resolve a relative one against the working directory, which
 * would put the logins wherever the run was started.
 */
function withState(pool: SitePool, authDir: string): SiteConfig[] {
  return pool.map((site, index) => ({
    ...site,
    storageState: resolve(REPO_ROOT, authDir, `site-${String(index)}.json`),
  }));
}

/**
 * The Cucumber tag expression that scopes a cell to its edition: a Pro cell excludes
 * `@free`, a Free cell excludes `@pro`. Editionless cells get no filter (run everything).
 */
function editionFilter(edition: Edition | undefined): string | undefined {
  if (edition === "pro") return "not @free";
  if (edition === "free") return "not @pro";
  return undefined;
}

/**
 * The cells this config holds: every cell of the product, or only the one `E2E_CELL` pins the run
 * to — so `bddgen`, which generates every cell a config holds, touches that cell's specs alone.
 *
 * @param product - the product being built.
 * @param pin - the pinned cell, from `pinnedCell()`; `undefined` when the run is not pinned.
 * @throws {@link Error} when the pin names no cell of the product, a `--project` selects none of
 *   the pinned cell's projects, or this process inherited other cells' BDD configs — each naming
 *   `E2E_CELL` and the fix.
 */
function cellsToBuild(
  product: ProductConfig,
  pin: string | undefined,
): string[] {
  const cells = Object.keys(product.sites);
  if (pin === undefined) return cells;
  assertPinKnown(pin, product.name, cells);
  assertSelectionFitsPin(
    pin,
    Object.values(cellProjectNames(pin)),
    projectSelection(),
  );
  // Read before this process defines its own BDD config, so only what it inherited is judged.
  assertNoForeignBddConfigs(env(BDD_CONFIGS_ENV), product.name, pin);
  return [pin];
}

/**
 * Builds the config for one product. Each `cell` becomes three projects: two sibling setup
 * projects — one authenticates the cell's site pool, one resolves & verifies its plugin
 * artifacts — and the BDD project that depends on both (either failing skips the
 * scenarios). A run targets exactly one cell — pinned with `E2E_CELL=<cell>`, which builds that
 * cell alone, or selected with `--project=<cell>` — which keeps the global `parallelIndex` in
 * range for the worker→site binding; selecting more than one cell at once is rejected fail-fast
 * below.
 */
export function createProductConfig(
  product: ProductConfig,
): PlaywrightTestConfig {
  // Publish the CLI's cell selection to the environment before anything reads it: worker
  // processes rebuild this config with an empty argv, so this is their only way to tell an
  // explicitly selected cell from a broad serial run (see run-context.ts).
  seedSelectedCells();

  // Publish the product's artifact manifest to the per-process registry the artifacts setup
  // reads by product name (it never imports product configs — see artifacts/registry.ts).
  registerManifest(product.name, product.artifacts);

  // Same channel for the product's debug-log preset: its `ignore`/`source` patterns are RegExps,
  // which cannot ride project metadata (Playwright serializes that into reports), and the shared
  // scenario hooks must not import product code.
  registerDebugLogOptions(product.name, product.debugLog);

  // Same channel for the paths this product leaves on a site after it is uninstalled: the shared
  // scenario hooks clear them, and must not import product code to learn what they are.
  registerSiteResidue(product.name, product.siteResidue);

  // And for the footprint it leaves in the site's *database* when its files go without its own
  // uninstall running — swept off what is found, not off whether the plugin is installed.
  registerSiteDbResidue(product.name, product.siteDbResidue);

  // And for how to ask the installed plugin for the data directories it names at runtime, which the
  // shared install prepares beside the declared ones — a function, so this is its only channel too.
  registerSiteDataDirResolver(product.name, product.resolveSiteDataDirs);

  // And for how to stop work it may still be doing on a site, which the shared teardown asks for
  // before it removes the plugin — a function, so this registry is its only possible channel.
  registerStopRunningWork(product.name, product.stopRunningWork);

  // And for how to settle what its killed runs left, which the auth setup's preflight asks for
  // before its gates — a function too.
  registerSettleLeftovers(product.name, product.settleLeftovers);

  // A stop file the drain gate could never see fails the run here, as it starts — not every
  // scenario, and not silently, as a gate that never closes would; so does one already there, which
  // would skip every scenario. A worker (Playwright sets `TEST_WORKER_INDEX`) may start after a stop.
  const stopFile = stopFileFromEnv();
  if (stopFile !== undefined) {
    assertStopFileFolder(stopFile);
    assertNotStoppedYet(stopFile, env("TEST_WORKER_INDEX") !== "");
  }

  const pin = pinnedCell();
  const cells = cellsToBuild(product, pin);

  // Resolve the targeted cell. Selecting multiple cells in one invocation is unsafe
  // (parallelIndex is global), so fail fast instead of silently mis-sizing workers. A cell named
  // exactly targets it, so the run is sized for its pool — unless the selection also reaches another
  // cell by Playwright's looser matching (`SMALL`, `sm*`, `*`), whose workers would then index past
  // their own pool. A selection of wildcards alone is a broad, serial run, as without `--project`.
  const selection = selectedCells();
  const requested = selection.filter((c) => cells.includes(c));
  const reached = cellsReached(cells, selection);
  if (requested.length > 1 || (requested.length === 1 && reached.length > 1)) {
    throw new Error(
      `Multiple cells selected (${reached.join(", ")}). Run one cell per ` +
        "invocation, e.g. E2E_CELL=<cell> or --project=<cell>, so parallelIndex stays in range.",
    );
  }
  const selected = requested[0];
  const selectedCellConfig =
    selected === undefined ? undefined : product.sites[selected];
  // A cell-less run (no / `*` / unknown --project) is serial and safe; its report goes
  // to an `_all` bucket so it is never mislabeled as belonging to a single cell.
  const reportDir = dirs(product.name, selected ?? NO_CELL).report;
  const outputOwner = cellOwningOutput(selected, projectSelection());

  const projects: Project[] = cells.flatMap((cell): Project[] => {
    const cellConfig = product.sites[cell];
    const pool = cellConfig?.sites ?? [];
    const edition = cellConfig?.edition;
    const cellDirs = dirs(product.name, cell);
    const pooled = withState(pool, cellDirs.auth);
    // Hand the credential-bearing pool to workers in-process; never via metadata,
    // which Playwright serializes into reports (see config/metadata.ts).
    registerPool(product.name, cell, pooled);
    const names = cellProjectNames(cell);
    const firstSite = pooled[0];
    const tags = editionFilter(edition);
    const routing = routingMetadata(product.name, cell, edition);
    // All three projects of a cell share one output folder, which Playwright empties for each
    // project a run selects; see `outputDirFor` for which runs may own the cell's own folder.
    const outputDir = outputDirFor(product.name, cell, outputOwner);

    return [
      {
        name: names.setup,
        testDir: "src/common/auth",
        testMatch: /auth\.setup\.ts$/,
        use: { ...DESKTOP, trace: SETUP_TRACE },
        outputDir,
        metadata: routing,
      },
      {
        // Sibling of the auth setup (no dependency between them): resolves & verifies the
        // cell's plugin artifacts. Needs no browser. Skips on placeholder-only pools.
        name: names.artifacts,
        testDir: "src/common/artifacts",
        testMatch: /artifacts\.setup\.ts$/,
        outputDir,
        metadata: routing,
      },
      {
        name: names.scenarios,
        testDir: defineBddConfig({
          outputDir: cellDirs.bdd,
          features: product.features,
          steps: product.steps,
          // Edition-ful cells generate only their edition's scenarios (untagged run on both).
          ...(tags !== undefined ? { tags } : {}),
        }),
        use: {
          ...DESKTOP,
          ...(firstSite ? { baseURL: firstSite.baseURL } : {}),
        },
        outputDir,
        dependencies: [names.setup, names.artifacts],
        // Defensive upper bound only: per-project `workers` caps how many workers a
        // project uses, not which parallelIndex slots it sees, so it cannot by itself
        // keep parallelIndex within a smaller pool. Correctness rests on the
        // single-cell global `workers` below.
        workers: pool.length > 0 ? pool.length : 1,
        retries: RETRIES,
        metadata: routing,
      },
    ];
  });

  return defineConfig({
    forbidOnly: isCI,
    // Off, and said so: left unset, Playwright turns both on under CI (GitHub Actions, GitLab,
    // Jenkins), and the HTML report then carries the commit's author and committer emails and the
    // pull request's diff.
    captureGitInfo: { commit: false, diff: false },
    fullyParallel: true,
    // Global workers = the SELECTED cell's pool size, so parallelIndex ∈ 0…N-1 and
    // `pool[parallelIndex]` is always in range for a single-cell invocation.
    workers:
      selectedCellConfig && selectedCellConfig.sites.length > 0
        ? selectedCellConfig.sites.length
        : 1,
    reporter: reporters({
      product: product.name,
      ...(selected !== undefined ? { cell: selected } : {}),
      ...(selectedCellConfig?.edition !== undefined
        ? { edition: selectedCellConfig.edition }
        : {}),
      pinned: pin !== undefined,
      runId: RUN_ID,
      reportCell: selected ?? NO_CELL,
      reportDir,
      reportPath: resolve(REPO_ROOT, reportDir),
      ...displayOnlyFacts(),
      reportsKeep: REPORTS_KEEP,
    }),
    // Committed-baseline visual checks (`toHaveScreenshot`): comparison tolerance + where the
    // per-product/cell baselines live. WP Rocket's A/B check (visual/ab.ts) diffs live renders and
    // does NOT use this — it is the wiring for the general committed-baseline capability.
    expect: VISUAL_EXPECT,
    snapshotPathTemplate: snapshotPathTemplateFor(product.name),
    use: {
      navigationTimeout: NAVIGATION_TIMEOUT_MS,
      trace: "retain-on-failure",
      screenshot: "only-on-failure",
      video: "retain-on-failure",
    },
    projects,
  });
}
