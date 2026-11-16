import { After, Before } from "../fixtures";
import { wasDrained } from "../config/drain";
import {
  getDebugLogOptions,
  getStopRunningWork,
  readRouting,
} from "../config/metadata";
import {
  BEFORE_HOOK_TIMEOUT_MS,
  HOOK_TIMEOUT_MS,
  PLUGIN_TAG,
  declaredResidue,
  extendedTimeout,
  installPluginUnderTest,
  leftWorkOf,
  scenarioReport,
  teardownPluginUnderTest,
} from "./plugin-lifecycle";

/**
 * Product-agnostic scenario hooks for the plugin under test, scoped to `@plugin`.
 *
 * A tagged scenario gets the cell's own edition installed and activated beforehand, a `debug.log`
 * scoped to just that scenario, a failure if PHP logged a fatal, and a clean site afterwards —
 * clean including the **files** the plugin wrote, which its own uninstall keeps. Work the plugin is
 * still doing is stopped before each removal: before the install, work a killed run left behind;
 * afterwards, the scenario's own. A scenario the drain skipped (`config/drain.ts`) is left alone.
 * A product that asks for it (`ProductConfig.settleAfterInstall`) also gets a settling request —
 * wp-admin, then the front page — once its plugin is active. Neither the edition nor the product is
 * named here: the slug comes from the resolved artifact and the product policy from the product's own
 * config, so one hook pair serves `backwpup`, `backwpup-pro` and `wp-rocket` alike.
 *
 * **This file must be listed in every product's `steps` globs.** A hook file outside them is
 * never imported, so its hooks register silently and the lifecycle simply never runs — the
 * failure mode is a scenario that finds no plugin, not an error.
 *
 * The policy itself lives in `./plugin-lifecycle.ts`; this file only binds it to the runtime.
 */

Before(
  {
    name: "install the plugin under test",
    tags: PLUGIN_TAG,
    timeout: BEFORE_HOOK_TIMEOUT_MS,
  },
  async ({
    site,
    pluginArtifact,
    $testInfo,
    playwright,
    baseURL,
    storageState,
  }) => {
    // Playwright times a scenario and its hooks against one clock, so make room for both hooks
    // before spending any of the budget.
    $testInfo.setTimeout(extendedTimeout($testInfo.timeout));
    const { product } = readRouting($testInfo.project.metadata);
    const report = scenarioReport($testInfo);
    await installPluginUnderTest(
      site.transport,
      pluginArtifact("plugin"),
      declaredResidue(product),
      leftWorkOf(product, report),
      report,
      // The settling request's client: the bound site with the scenario's session (an empty one for
      // `@noauth`). A request context, not the browser `context`, so a scenario without a page still
      // launches no browser; opened only for a product that asks for the request.
      () => playwright.request.newContext({ baseURL, storageState }),
    );
  },
);

After(
  {
    name: "check debug.log, stop the plugin's running work, remove it and its leftovers",
    tags: PLUGIN_TAG,
    timeout: HOOK_TIMEOUT_MS,
  },
  async ({ site, pluginArtifact, $testInfo }) => {
    // A drained scenario never began: no Before hook ran, so there is no log of its own to judge and
    // nothing it installed to remove — and a run being stopped should not spend minutes here.
    if (wasDrained($testInfo.annotations)) return;
    const { product } = readRouting($testInfo.project.metadata);
    await teardownPluginUnderTest(
      site.transport,
      pluginArtifact("plugin").slug,
      getDebugLogOptions(product),
      declaredResidue(product),
      scenarioReport($testInfo),
      getStopRunningWork(product),
    );
  },
);
