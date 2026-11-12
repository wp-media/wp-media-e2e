import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { test as base, createBdd } from "playwright-bdd";

import { readResolvedArtifact } from "./artifacts/consume";
import type { ArtifactRole, ResolvedArtifact } from "./artifacts/types";
import { deviceForTags } from "./config/devices";
import { getPool, readRouting } from "./config/metadata";
import { REPO_ROOT, RUN_ID, dirs } from "./config/run-context";
import { isPlaceholderSite } from "./config/sites";
import { registerRunVerdict } from "./setup/identity-verdicts";
import {
  STOPPED_ANNOTATION,
  drainReason,
  stopFileFromEnv,
} from "./config/drain";
import { releaseSite } from "./wp/teardown";
import {
  reportPageLoads,
  siteOrigin,
  watchPageLoads,
} from "./reporting/page-loads";
import type { Edition, SiteConfig } from "./config/types";

/**
 * Shared test instance. It binds each worker to one site from its project's pool
 * (by `parallelIndex`) and reuses that site's `storageState`, so scenarios run
 * authenticated against an isolated WordPress instance. Scenarios tagged `@noauth`
 * start unauthenticated (e.g. login/logout flows).
 *
 * Two things are driven by a scenario's tags rather than by its project, because they are
 * per-scenario client concerns that must not multiply the project matrix: the session
 * (`@noauth`) and the device profile (`@mobile`). Both are applied as `use` overrides, so they
 * take effect at browser-context creation.
 */

interface TestFixtures {
  /** The WordPress site bound to the current worker. Throws if the scenario needs one but none is configured. */
  site: SiteConfig;
  /** The bound cell's edition (Free/Pro). Throws if read in a cell that declares no edition. */
  edition: Edition;
  /**
   * Looks up a resolved plugin zip for this cell by role — `pluginArtifact("plugin").zipPath`
   * is the artifact under test, `"previous"` the version to compare against. The artifacts
   * setup resolved and verified it; this reads that result. Throws if the role is
   * unsupported or the setup did not run for this cell.
   */
  pluginArtifact: (role: ArtifactRole) => ResolvedArtifact;
  /**
   * Automatic: skips a scenario's first attempt, annotated {@link STOPPED_ANNOTATION}, once the
   * run's stop file exists — the drain (see `config/drain.ts`). No gate when the run names none.
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Playwright's type for a fixture that produces no value; it only gates.
  drainGate: void;
}

interface WorkerFixtures {
  /** The site this worker is pinned to (by parallelIndex), or `undefined` when the project has no pool. */
  boundSite: SiteConfig | undefined;
  /**
   * Automatic worker teardown: after this worker's last scenario, removes the staging area it
   * copied artifacts into and closes its pooled SSH connections. `auto` so no scenario has to
   * remember it, and best-effort so it can never fail a passing run (see `wp/teardown.ts`).
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Playwright's type for a fixture that produces no value; the work is entirely in its teardown.
  releaseBoundSite: void;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  boundSite: [
    // Worker-scoped: pin this worker to one pooled site by its global parallelIndex, and give this
    // process the auth setup's site identity verdict for it before any site command (an `auto` site
    // without one runs as the transport's user, and says so).
    // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
    async ({}, use, workerInfo) => {
      const { product, cell } = readRouting(workerInfo.project.metadata);
      const pool = getPool(product, cell);
      if (pool.length === 0) {
        await use(undefined);
        return;
      }
      const site = pool[workerInfo.parallelIndex];
      if (site === undefined) {
        throw new Error(
          `No site for parallelIndex ${String(workerInfo.parallelIndex)} in a pool of ${String(pool.length)}. ` +
            "Run one cell per invocation with workers = pool size.",
        );
      }
      if (!isPlaceholderSite(site)) {
        await registerRunVerdict(
          site,
          resolve(REPO_ROOT, dirs(product, cell).auth),
          RUN_ID,
        );
      }
      await use(site);
    },
    { scope: "worker" },
  ],

  releaseBoundSite: [
    // Worker-scoped and automatic: the body is pure teardown, which runs after `use()` returns.
    async ({ boundSite }, use) => {
      await use();
      await releaseSite(boundSite);
    },
    { scope: "worker", auto: true, box: true },
  ],

  // Automatic, so every scenario passes the gate before its Before hooks: a skip thrown here runs no
  // `beforeEach`, while the `afterEach` still runs (measured), which is why the `@plugin` After hook
  // checks `wasDrained` first. `storageState` depends on it, so it also precedes the one context
  // option that can throw. Boxed: it is plumbing, not a report line.
  drainGate: [
    // eslint-disable-next-line no-empty-pattern -- no fixture deps; the gate reads testInfo and the environment.
    async ({}, use, testInfo) => {
      const reason = drainReason(stopFileFromEnv(), testInfo, existsSync);
      if (reason !== undefined) {
        testInfo.annotations.push({
          type: STOPPED_ANNOTATION,
          description: reason,
        });
        testInfo.skip(true, reason);
      }
      await use();
    },
    { auto: true, box: true },
  ],

  // Scenario-facing handle to the bound site; fails loudly when the project has no pool.
  site: async ({ boundSite }, use) => {
    if (boundSite === undefined) {
      throw new Error(
        "This scenario requires a bound WordPress site, but the project has no site pool. " +
          "Configure the product's sites.json, or tag the scenario @noauth if it needs no site.",
      );
    }
    await use(boundSite);
  },

  // The bound cell's edition (BackWPup Free/Pro), read from the project's routing metadata.
  // Throws if a scenario reads it but the cell declares none — editionless products never do.
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; edition comes from testInfo.
  edition: async ({}, use, testInfo) => {
    const { edition } = readRouting(testInfo.project.metadata);
    if (edition === undefined) {
      throw new Error(
        "Fixture `edition` was requested, but this cell declares no edition. " +
          "Editions are configured per cell for edition-ful products.",
      );
    }
    await use(edition);
  },

  // Role → resolved zip lookup for this cell. Returns a plain function (fixtures cannot take
  // arguments), so a step calls `pluginArtifact("plugin").zipPath`. Reading comes from the
  // per-process memo or `resolution.json` (see artifacts/consume.ts); routing is from testInfo.
  // eslint-disable-next-line no-empty-pattern -- no fixture deps; routing comes from testInfo.
  pluginArtifact: async ({}, use, testInfo) => {
    const { product, cell } = readRouting(testInfo.project.metadata);
    await use((role) => readResolvedArtifact(product, cell, role));
  },

  // Override: the browser context, watched for the site's own requests that never arrived. A
  // scenario that fails after a page lost its scripts or styles says so in one warning line and a
  // `page-load-failures` attachment instead of only a locator timeout (see `reporting/page-loads.ts`).
  // Wrapping `context` rather than adding an automatic fixture keeps scenarios without a browser free
  // of one; the report runs before Playwright closes the context, and can never fail the scenario.
  context: async ({ context, baseURL }, use, testInfo) => {
    const origin = siteOrigin(baseURL);
    const watch =
      origin === undefined ? undefined : watchPageLoads(context, origin);
    await use(context);
    if (watch === undefined) return;
    watch.stop();
    await reportPageLoads(watch.log, testInfo);
  },

  // Override: point Playwright's baseURL at the bound site, so relative navigations target it.
  baseURL: async ({ boundSite, baseURL }, use) => {
    await use(boundSite?.baseURL ?? baseURL);
  },

  // Override: `@noauth` scenarios start with an empty session; all others reuse the site's saved login.
  // It names `drainGate` so the gate is set up first: Playwright's own automatic fixtures, registered
  // before ours, set up the context options before any of ours, so without this a placeholder site's
  // refusal below would fail a scenario the drain should skip (measured).
  storageState: async (
    // `drainGate` is named for its ordering alone; it produces no value.
    { $tags, boundSite, storageState, drainGate: _drainGate },
    use,
  ) => {
    if ($tags.includes("@noauth")) {
      await use({ cookies: [], origins: [] });
      return;
    }
    // The auth setup skips placeholder sites, so no storageState file exists for one; failing
    // here with the cause beats the ENOENT Playwright would otherwise throw reading that file.
    if (boundSite !== undefined && isPlaceholderSite(boundSite)) {
      throw new Error(
        "This scenario needs an authenticated session, but this worker is bound to a " +
          `placeholder/example site (${boundSite.baseURL}) that the auth setup skips. ` +
          "Create the product's sites.json for real runs, or tag the scenario @noauth.",
      );
    }
    await use(boundSite?.storageState ?? storageState);
  },

  // Overrides: `@mobile` scenarios run under a mobile device profile; everything else keeps the
  // project's desktop default. Playwright exposes each context option as its own option fixture,
  // so the profile is applied one option at a time — and each override falls back to the value the
  // project already resolved, never to a hard-coded desktop value.
  viewport: async ({ $tags, viewport }, use) => {
    await use(deviceForTags($tags)?.viewport ?? viewport);
  },
  userAgent: async ({ $tags, userAgent }, use) => {
    await use(deviceForTags($tags)?.userAgent ?? userAgent);
  },
  deviceScaleFactor: async ({ $tags, deviceScaleFactor }, use) => {
    await use(deviceForTags($tags)?.deviceScaleFactor ?? deviceScaleFactor);
  },
  isMobile: async ({ $tags, isMobile }, use) => {
    await use(deviceForTags($tags)?.isMobile ?? isMobile);
  },
  hasTouch: async ({ $tags, hasTouch }, use) => {
    await use(deviceForTags($tags)?.hasTouch ?? hasTouch);
  },
});

export const { Given, When, Then, Step, Before, After, BeforeAll, AfterAll } =
  createBdd(test);
