import "./src/common/config/load-env";

import { chromium, request } from "@playwright/test";
import type { Browser } from "@playwright/test";

import { loginViaUi } from "./src/common/auth/login";
import { boolEnv, intEnv } from "./src/common/config/env";
import { consolePrinters } from "./src/common/config/output";
import type { Printer } from "./src/common/config/output";
import { isPlaceholderSite } from "./src/common/config/sites";
import type { ProductConfig, SiteInput } from "./src/common/config/types";
import {
  verifySite,
  warnAboutElevation,
  warnAboutIdentity,
  warnAboutPluginDirs,
} from "./src/common/setup/preflight";
import {
  headerLines,
  productHeaderLines,
  productTallyLine,
  siteResultLines,
  skipLine,
  summaryLines,
} from "./src/common/setup/healthcheck-lines";
import type {
  CellSkip,
  SiteResult,
} from "./src/common/setup/healthcheck-lines";
import { resolveIdentity } from "./src/common/artifacts/manifest";
import type { CheckResult } from "./src/common/setup/preflight";
import { disposeConnections } from "./src/common/wp/exec";
import { PRODUCTS } from "./src/projects/products";

/**
 * Fleet-wide health check: for every product × cell × site, verifies the transport
 * (SSH/Docker/local reachable, WP-CLI works, WordPress is installed — see
 * `src/common/setup/preflight.ts`), reports who its commands run as (a site asking for an identity
 * has its web server probed; the verdict stays in memory), and then exercises a real login through the
 * WordPress UI (`src/common/auth/login.ts`). No `storageState` is ever written —
 * this never touches `.auth/`, it only reports whether each site is reachable and
 * usable.
 *
 * Output is grouped BY PRODUCT: each product prints its own section (its sites, each
 * with the individual checks that ran, plus a per-product tally) and the final
 * summary breaks the fleet down per product too, so wp-rocket / backwpup / (future)
 * imagify never blur together. Products are processed one at a time so each section
 * stays contiguous; the sites WITHIN a product run concurrently (bounded by
 * `HEALTHCHECK_CONCURRENCY`).
 *
 * One site's failure never aborts the run: every site is checked independently, its
 * result is printed as soon as it is known, and the summary aggregates all of them.
 * The process exits non-zero if ANY real site failed, so this is safe to wire into
 * CI/cron as a fleet monitor. Cells with no real sites configured yet
 * (placeholder/example data — see `sites.example.json`) are reported as skipped, not
 * failed: that is expected on a fresh checkout, not a fleet problem.
 *
 * Usage: `npm run healthcheck` (headless) or `npm run healthcheck:ui` (headed — the browser is
 * visible on screen so you can watch each login; everything else is identical).
 */

// Bounded so a large fleet does not open unbounded SSH connections / browser contexts
// at once. Override with HEALTHCHECK_CONCURRENCY for bigger/smaller fleets.
const CONCURRENCY = intEnv("HEALTHCHECK_CONCURRENCY", 4, 1, 32);

// Per-login settle budget (ms). Playwright's default `expect` timeout (5s) is too tight
// for a slow remote (SSH-hosted) site's POST → dashboard redirect; a monitor favours
// patience over speed. Override with HEALTHCHECK_LOGIN_TIMEOUT_MS.
const LOGIN_TIMEOUT_MS = intEnv(
  "HEALTHCHECK_LOGIN_TIMEOUT_MS",
  30_000,
  1_000,
  300_000,
);

// When true, run the browser headed (a real window on screen) so each login is visible instead of
// running invisibly. Set by `npm run healthcheck:ui` (which passes `--headed`) or
// HEALTHCHECK_HEADED=true. Nothing else changes — same checks, same output, same exit code.
const HEADED =
  process.argv.includes("--headed") || boolEnv("HEALTHCHECK_HEADED", false);

// Where the report goes: stdout, styled as its stream and `E2E_OUTPUT` allow (`healthcheck >
// fleet.log` gets no escape). Read once, after `.env` is loaded.
const OUT: Printer = consolePrinters().out;

// ── Discovery ────────────────────────────────────────────────────────────────────

/** One checkable site: which product/cell it belongs to, the site itself, and its pool index. */
interface SiteTask {
  readonly product: string;
  readonly cell: string;
  readonly site: SiteInput;
  readonly index: number;
  /** The slug the cell installs as — whose folder the check looks at, and its @plugin scenarios clear. */
  readonly slugs: readonly string[];
}

/** Everything to do for one product: the sites to check and the cells that were skipped. */
interface ProductPlan {
  readonly product: string;
  readonly tasks: SiteTask[];
  readonly skips: CellSkip[];
}

/** Splits every product's cells into checkable sites vs. skipped (placeholder-only) cells, one plan per product. */
function discover(products: readonly ProductConfig[]): ProductPlan[] {
  return products.map((product) => {
    const tasks: SiteTask[] = [];
    const skips: CellSkip[] = [];
    const cells = Object.keys(product.sites);

    if (cells.length === 0) {
      skips.push({
        product: product.name,
        cell: "(none)",
        reason: "no cells configured",
      });
    }

    for (const cell of cells) {
      const pool = product.sites[cell]?.sites ?? [];
      const real = pool
        .map((site, index) => ({ site, index }))
        .filter(({ site }) => !isPlaceholderSite(site));

      if (real.length === 0) {
        skips.push({
          product: product.name,
          cell,
          reason: "no real sites configured (placeholder/example data)",
        });
        continue;
      }

      const { slug } = resolveIdentity(
        product.artifacts,
        product.sites[cell]?.edition,
      );
      for (const { site, index } of real) {
        tasks.push({ product: product.name, cell, site, index, slugs: [slug] });
      }
    }

    return { product: product.name, tasks, skips };
  });
}

// ── Per-site checking ────────────────────────────────────────────────────────────

/** Logs in through the WordPress UI in a throwaway browser context; never persists state. */
async function checkLogin(
  browser: Browser,
  site: SiteInput,
): Promise<CheckResult> {
  const context = await browser.newContext({ baseURL: site.baseURL });
  try {
    const page = await context.newPage();
    await loginViaUi(page, site, { timeoutMs: LOGIN_TIMEOUT_MS });
    return {
      name: "WordPress login",
      ok: true,
      detail: "Logged in via wp-login.php and reached wp-admin.",
    };
  } catch (err) {
    // Playwright errors often append a multi-line "Call log:" block to `.message`;
    // keep the report's per-check line to the summary, which is self-contained.
    const raw = err instanceof Error ? err.message : String(err);
    const msg = (raw.split("\n")[0] ?? raw).trim();
    return {
      name: "WordPress login",
      ok: false,
      detail: `Could not log in: ${msg}`,
      hint: [
        "Confirm the site's username/password in sites.json are correct and the",
        "account is not locked, disabled, or gated behind extra auth (2FA / a security plugin).",
      ].join("\n"),
    };
  } finally {
    await context.close();
  }
}

/** Runs preflight + login for one site. Login only runs if every preflight check passed. */
async function checkSite(
  browser: Browser,
  task: SiteTask,
): Promise<SiteResult> {
  const start = Date.now();
  // The web probe's verdict stays in this process: the healthcheck writes no file.
  const preflight = await verifySite(
    task.site,
    task.index,
    task.slugs,
    undefined,
    {
      request,
    },
  );
  const checks: CheckResult[] = [...preflight.checks];

  if (checks.every((c) => c.ok)) {
    checks.push(await checkLogin(browser, task.site));
  } else {
    checks.push({
      name: "WordPress login",
      ok: false,
      detail: "Skipped — transport verification failed above.",
    });
  }

  return {
    product: task.product,
    cell: task.cell,
    index: task.index,
    baseURL: task.site.baseURL,
    transport: task.site.transport,
    checks,
    durationMs: Date.now() - start,
    ok: checks.every((c) => c.ok),
    ...(preflight.elevation !== undefined
      ? { elevation: preflight.elevation }
      : {}),
    ...(preflight.ownershipPending !== undefined
      ? { ownershipPending: preflight.ownershipPending }
      : {}),
    ...(preflight.leftoverPluginDirs !== undefined
      ? { leftoverPluginDirs: preflight.leftoverPluginDirs }
      : {}),
    ...(preflight.identityIssues !== undefined
      ? { identityIssues: preflight.identityIssues }
      : {}),
  };
}

/** Converts an unexpected throw (a bug, not a check failure) into a failed result instead of crashing the run. */
function crashResult(task: SiteTask, err: unknown): SiteResult {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    product: task.product,
    cell: task.cell,
    index: task.index,
    baseURL: task.site.baseURL,
    transport: task.site.transport,
    checks: [
      { name: "Health check", ok: false, detail: `Unexpected error: ${msg}` },
    ],
    durationMs: 0,
    ok: false,
  };
}

// ── Bounded concurrency ────────────────────────────────────────────────────────────

/** Runs at most `concurrency` async tasks at once; excess calls queue in submission order. */
type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;

/** Builds a {@link Limiter} that never has more than `concurrency` calls in flight. */
function createLimiter(concurrency: number): Limiter {
  let active = 0;
  const queue: (() => void)[] = [];

  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      active -= 1;
      const next = queue.shift();
      if (next !== undefined) next();
    }
  };
}

/** Checks all of one product's sites concurrently (bounded by `limit`), printing each as it finishes. */
async function runProduct(
  browser: Browser,
  plan: ProductPlan,
  limit: Limiter,
): Promise<SiteResult[]> {
  return Promise.all(
    plan.tasks.map((task) =>
      limit(async () => {
        const result = await checkSite(browser, task).catch((err: unknown) =>
          crashResult(task, err),
        );
        printSiteResult(result);
        return result;
      }),
    ),
  );
}

// ── Reporting ────────────────────────────────────────────────────────────────────

/**
 * Prints lines to stdout.
 *
 * @param lines - the lines, each printed with its line end.
 */
function printLines(lines: readonly string[]): void {
  for (const line of lines) OUT.print(line);
}

/**
 * Prints one site's result the moment it is known.
 *
 * @param result - the site's result.
 */
function printSiteResult(result: SiteResult): void {
  printLines(siteResultLines(result, OUT.palette));
}

// ── Entry point ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startedAt = Date.now();
  const plans = discover(PRODUCTS);

  printLines(headerLines(plans, OUT.palette));

  const totalTasks = plans.reduce((n, p) => n + p.tasks.length, 0);
  // Only pay for a browser when there is at least one real site to log into. `HEADED` shows the
  // window on screen (`npm run healthcheck:ui`); the checks are otherwise identical.
  const browser =
    totalTasks > 0 ? await chromium.launch({ headless: !HEADED }) : null;
  const limit = createLimiter(CONCURRENCY);
  const allResults: SiteResult[] = [];

  try {
    // Products run sequentially so each section's live output stays contiguous; sites within a
    // product run concurrently via `limit`.
    for (const [index, plan] of plans.entries()) {
      printLines(productHeaderLines(plan.product, index, OUT.palette));
      printLines(plan.skips.map((skip) => skipLine(skip, OUT.palette)));
      if (plan.skips.length > 0) OUT.print("");

      let results: SiteResult[] = [];
      if (plan.tasks.length > 0 && browser !== null) {
        results = await runProduct(browser, plan, limit);
      }
      allResults.push(...results);
      printLines([productTallyLine(plan, results, OUT.palette), ""]);
    }

    // Inside the `try`, so a failure while printing a later product still leaves the operator with
    // what was learned about the earlier ones. After every product section and before the summary:
    // a warning buried between two products is one nobody reads, and this is the last thing on
    // screen that is not a verdict. Rendered by the same function a suite run uses, so a fleet check
    // and a run can never disagree — but sent to **stdout**, because unlike a suite run this
    // program's entire output is the report, and `healthcheck > fleet.log` must not drop it.
    warnAboutElevation(allResults, OUT.print, OUT.palette);
    warnAboutPluginDirs(allResults, OUT.print, OUT.palette);
    warnAboutIdentity(allResults, OUT.print, OUT.palette);
  } finally {
    if (browser !== null) await browser.close();
    disposeConnections();
  }

  printLines(
    summaryLines(plans, allResults, Date.now() - startedAt, OUT.palette),
  );
  process.exit(allResults.every((result) => result.ok) ? 0 : 1);
}

await main();
