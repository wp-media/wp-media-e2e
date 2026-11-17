import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import {
  WP_ROCKET_BASENAME,
  stopWpRocketWorkReport,
} from "../support/background-work";
import {
  judgeForcedDeactivation,
  readDeactivationCauses,
} from "../support/deactivation-causes";
import { describeFootprint, isStaleFootprint } from "../support/footprint";
import { readInstalledAt } from "../support/install-time";
import { findUninstallLeftovers } from "../support/uninstall-leftovers";
import {
  pageCacheVerdict,
  readWpCacheState,
  webServerIdentity,
} from "../support/wp-cache";
import type { PageVisit } from "../support/visitor";
import type { PageFootprint } from "../support/footprint";
import { LEFT_WORK_ALLOWANCE_MS } from "../../../common/hooks/plugin-lifecycle";
import { uninstallPlugin } from "../../../common/wp/plugin";
import {
  resolveSiteIdentity,
  siteIdentityVerdict,
} from "../../../common/wp/site-identity";

/**
 * WP Rocket's page cache as the public meets it, and its removal.
 *
 * Pages are asked for over HTTP by a visitor who is not logged in (`visitor`): WP Rocket caches no
 * logged-in user by default. Whether a page came from the cache is read from WP Rocket's footprint
 * (`support/footprint.ts`) — only a page served from its cache file carries a `cached@` timestamp —
 * never from timing.
 */

/**
 * A visit the visitor made, by its position (1-based), failing clearly when it was never made.
 *
 * @param visits - the visits so far.
 * @param nth - which one.
 */
function visitNumber(visits: readonly PageVisit[], nth: number): PageVisit {
  const visit = visits[nth - 1];
  if (visit === undefined) {
    throw new Error(
      `visit ${String(nth)} was asked about, but the visitor made ${String(visits.length)}.`,
    );
  }
  return visit;
}

/**
 * When this scenario's install happened, failing clearly when no step read it.
 *
 * @param installedAt - what the premise step stored.
 */
function installTime(installedAt: number | undefined): number {
  if (installedAt === undefined) {
    throw new Error(
      "when WP Rocket was installed was never read: the scenario must start with its page-cache premise.",
    );
  }
  return installedAt;
}

/**
 * A footprint judged against this install: `none`, `stale` (a cached copy dated before the install —
 * an earlier run's), else its kind.
 *
 * @param footprint - the page's footprint.
 * @param installedAt - when this install happened.
 */
function freshKind(
  footprint: PageFootprint,
  installedAt: number,
): PageFootprint["kind"] | "stale" {
  return isStaleFootprint(footprint, installedAt) ? "stale" : footprint.kind;
}

/**
 * How long the web server may take to run the `wp-config.php` WP Rocket just edited: PHP's opcache
 * re-reads a changed file only every `opcache.revalidate_freq` seconds (2 by default; measured on the
 * twins), so a page asked for within that window still runs without `WP_CACHE`. Generous, since the
 * setting is the server's.
 */
const WP_CACHE_IN_EFFECT_MS = 15_000;

/**
 * The premise of every cached page: `WP_CACHE` on, in the file and for the web server. WP Rocket
 * writes it as the site's commands (its activation) or as the web server's PHP (an admin request, the
 * settling one): only a site whose `wp-config.php` **neither** can write is skipped, saying so and
 * naming both users (the `@plugin` teardown still runs) — its setup, not WP Rocket. `WP_CACHE` off
 * with either able to write it is a failure, and so is not knowing who PHP runs as. Once on, the home
 * page is asked for (not as one of the scenario's visits) until WP Rocket handles it: when the settling
 * admin request is what wrote `WP_CACHE`, the web server may still be running the file it compiled
 * before. When WP Rocket was installed is read first: a cached copy dated before it is an earlier
 * run's, and counts for nothing here or in the steps after.
 */
Given(
  "WP Rocket has turned on WordPress's page cache",
  async ({ site, visitor, pageCache, $testInfo }) => {
    const installedAt = await readInstalledAt(
      site.transport,
      WP_ROCKET_BASENAME,
    );
    pageCache.installedAt = installedAt;
    const web = webServerIdentity(
      await resolveSiteIdentity(site.transport),
      siteIdentityVerdict(site.transport),
    );
    const verdict = pageCacheVerdict(
      await readWpCacheState(site.transport),
      web,
    );
    if (verdict.kind === "unwritable-config") {
      $testInfo.skip(true, verdict.reason);
      return;
    }
    expect(
      verdict.kind,
      verdict.kind === "off" ? verdict.reason : "WP_CACHE is on",
    ).toBe("on");
    await expect
      .poll(
        async () => freshKind((await visitor.peek("/")).footprint, installedAt),
        {
          message: `WP_CACHE is on in wp-config.php, but within ${String(WP_CACHE_IN_EFFECT_MS / 1000)} s the web server served no page WP Rocket handled since its install (cached@ ≥ ${String(installedAt)})`,
          timeout: WP_CACHE_IN_EFFECT_MS,
        },
      )
      .toMatch(/^(?:generated|cached)$/);
  },
);

When("an anonymous visitor opens the home page twice", async ({ visitor }) => {
  await visitor.open("/");
  await visitor.open("/");
});

/**
 * Either footprint passes: preload may have cached the home page before the first visit, so whether
 * that visit was generated or already cached is not WP Rocket's promise — that it handled it is. A
 * copy cached before this install is not this install's handling.
 */
Then(
  "WP Rocket handled the page of the first visit",
  ({ visitor, pageCache }) => {
    const installedAt = installTime(pageCache.installedAt);
    const first = visitNumber(visitor.visits, 1);
    expect(first.status, "the first visit's status").toBe(200);
    expect(
      freshKind(first.footprint, installedAt),
      `the first visit's page should carry WP Rocket's footprint from this install (installed at ${String(installedAt)}), but has ${describeFootprint(first.footprint)}; it ends ${JSON.stringify(first.ending)}`,
    ).toMatch(/^(?:generated|cached)$/);
  },
);

/**
 * By the second visit, the first has written the page to the cache (if preload had not already) — a
 * copy cached since this install, not one an earlier run left.
 */
Then(
  "the page of the second visit is served from WP Rocket's cache",
  ({ visitor, pageCache }) => {
    const installedAt = installTime(pageCache.installedAt);
    const second = visitNumber(visitor.visits, 2);
    expect(second.status, "the second visit's status").toBe(200);
    expect(
      freshKind(second.footprint, installedAt),
      `the second visit's page should be served from WP Rocket's cache, written since its install (at ${String(installedAt)}), but has ${describeFootprint(second.footprint)}; it ends ${JSON.stringify(second.ending)}`,
    ).toBe("cached");
  },
);

/**
 * The removal the `@plugin` teardown would make, made here so its outcome can be asserted: WP Rocket
 * is deactivated and the background work the visits started (preload, its Action Scheduler runner)
 * is let finish — uninstalling under running requests races them —, then WordPress uninstalls it,
 * running WP Rocket's own uninstall, and nothing may be left at its path. The teardown then finds it
 * gone and puts back the files WP Rocket edited (`wp-config.php`, `.htaccess`, `advanced-cache.php`).
 *
 * A deactivation WP Rocket refused, which the stop then forced, is judged by WP Rocket's own causes
 * for the site's commands: none holding (`wp-config.php`, and on Apache `.htaccess`, writable) is WP
 * Rocket's regression and fails the scenario; otherwise it is the site's setup and warned as the
 * `@plugin` hooks warn a recovered deactivation (a `forced-deactivation` attachment).
 */
When(
  "WP Rocket is removed from the site",
  async ({ site, pluginArtifact, $testInfo }) => {
    // Stopping the work may wait for it, as the teardown's stop does.
    $testInfo.setTimeout($testInfo.timeout + LEFT_WORK_ALLOWANCE_MS);
    const stop = await stopWpRocketWorkReport(site.transport);
    if (stop.deactivation?.kind === "forced") {
      const forced = judgeForcedDeactivation(
        stop.deactivation,
        await readDeactivationCauses(site.transport),
      );
      expect(forced.kind, forced.message).toBe("expected");
      const message = `[wp-rocket] "${$testInfo.title}": ${forced.message}`;
      console.warn(message);
      await $testInfo.attach("forced-deactivation", {
        body: message,
        contentType: "text/plain",
      });
    }
    // Running work is expected here — the visits started it —, so it is kept with the scenario, not
    // warned.
    if (stop.said !== undefined) {
      await $testInfo.attach("stopped-running-work", {
        body: stop.said,
        contentType: "text/plain",
      });
    }
    await uninstallPlugin(site.transport, pluginArtifact("plugin").slug);
  },
);

/**
 * What the public sees once WP Rocket is gone: WordPress's own page, with no footprint — neither a
 * page WP Rocket still processes nor a stale copy its cache (or its `.htaccess` rules, which a
 * WP-CLI deactivation does not remove) still serves.
 */
Then(
  "an anonymous visitor's home page carries no trace of WP Rocket",
  async ({ visitor }) => {
    const visit = await visitor.open("/");
    expect(visit.status, "the home page's status").toBe(200);
    expect(
      visit.footprint.kind,
      `the home page should carry no WP Rocket footprint, but has ${describeFootprint(visit.footprint)}; it ends ${JSON.stringify(visit.ending)}`,
    ).toBe("none");
  },
);

/**
 * WP Rocket's own uninstall deletes its cache folders and its config folder; the teardown would sweep
 * what it left silently, so it is checked before the teardown runs.
 */
Then(
  "nothing WP Rocket's uninstall deletes is left on the site",
  async ({ site }) => {
    expect(
      await findUninstallLeftovers(site.transport),
      "what WP Rocket's uninstall should have deleted",
    ).toEqual([]);
  },
);
