import { test as setup } from "@playwright/test";

import { resolveIdentity } from "../artifacts/manifest";
import { getManifest } from "../artifacts/registry";
import { getPool, getSettleLeftovers, readRouting } from "../config/metadata";
import { isPlaceholderSite } from "../config/sites";
import { SETTLE_LEFTOVERS_ALLOWANCE_MS, verifyPool } from "../setup/preflight";
import { ensurePluginAbsent } from "../wp/plugin";
import {
  BEST_EFFORT_ALLOWANCE_PER_SITE_MS,
  authenticatePool,
  endSessionsWhenSetupFails,
  keepSecretsOutOfFailureSnapshots,
} from "./authenticate";

/**
 * Authentication setup project (plain Playwright, not BDD). For each real site in the
 * cell's pool it:
 *   1. Settles what the product's killed runs left (`ProductConfig.settleLeftovers`, before the
 *      gates: it can stop WordPress booting), then verifies the site's transport (SSH/Docker/local)
 *      is reachable and functional — removing a broken copy of the cell's own plugin when WordPress
 *      boots only without it (see setup/cell-plugin.ts), which would otherwise fail every login
 *      before a scenario could heal it.
 *   2. Ends the WordPress session the cell's previous run saved, so a cookie in an older report's
 *      trace is dead (see session.ts).
 *   3. Logs in once through the WordPress UI and saves the session to that site's
 *      `storageState` file, which the BDD project reuses (one site per worker — see
 *      fixtures.ts).
 *   4. Reads the versions the site runs from Site Health, and attaches them to the reports
 *      as `site-info.json` — best-effort, never failing the setup.
 *
 * The BDD project declares this as a `dependency`, so it always runs first.
 * Logins run in isolated browser contexts, so saved sessions never bleed across sites.
 *
 * When the pool holds only placeholder/example sites (no sites.json yet), the whole
 * setup is skipped so the scaffold's `@noauth` smoke tests stay green on a fresh checkout.
 *
 * Pre-flight failures (transport unreachable, WP-CLI missing, wrong path) surface here
 * with actionable guidance — not as cryptic per-scenario failures later.
 */

// This setup types the sites' passwords: no failure snapshot may print them (see authenticate.ts).
keepSecretsOutOfFailureSnapshots(setup);
// A setup that fails — a timeout included — ends the sessions it saved: its trace holds their cookies.
const saved = endSessionsWhenSetupFails(setup);

setup("authenticate site pool", async ({ browser }, testInfo) => {
  const { product, cell, edition } = readRouting(testInfo.project.metadata);
  const pool = getPool(product, cell);
  const real = pool.filter((site) => !isPlaceholderSite(site));

  setup.skip(
    real.length === 0,
    `No real sites configured for "${product}/${cell}" (placeholder example data ` +
      "in use). Create sites.json for real runs.",
  );

  // Preflight (concurrent, but SSH round-trips add up) plus one SERIAL UI login per
  // site can far exceed the default per-test timeout on slow remote sites, so the
  // budget scales with the pool instead of failing spuriously on a healthy fleet —
  // plus what the best-effort steps around each login may spend, so that none of them
  // can run the setup out of time.
  const settle = getSettleLeftovers(product);
  setup.setTimeout(
    60_000 +
      real.length * (60_000 + BEST_EFFORT_ALLOWANCE_PER_SITE_MS) +
      (settle === undefined ? 0 : SETTLE_LEFTOVERS_ALLOWANCE_MS),
  );

  // Verify every site's transport before attempting authentication. A failure here
  // throws a formatted report, which Playwright surfaces as a setup error and uses
  // to skip the dependent BDD project — preventing cascading failures.
  // The folder checked is the one this cell installs, which its @plugin scenarios clear — and the one
  // plugin this setup may remove, the same cleanup they run.
  const { slug } = resolveIdentity(getManifest(product), edition);
  await verifyPool(pool, product, cell, [slug], ensurePluginAbsent, settle);

  await authenticatePool(browser, real, testInfo, undefined, saved);
});
