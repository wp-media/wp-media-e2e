import {
  test,
  expect,
  type APIRequest,
  type APIRequestContext,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WP_ROCKET_SITE_DB_RESIDUE } from "./db-residue";
import { LICENCE_PLUGIN_PATH, writeLicencePlugin } from "./licence";
import { WP_ROCKET_INSTALL_OUTPUTS, WP_ROCKET_SITE_RESIDUE } from "./residue";
import {
  BACKGROUND_WORK_BUDGETS,
  readBackgroundWork,
  staleWork,
} from "./background-work";
import { forceDeactivateWpRocket } from "./deactivation";
import { WP_ROCKET_CONFIG_EDITS } from "./config-edits";
import { normaliseConfigEdits } from "../../../common/wp/config-edits-declaration";
import { recordStemFor } from "../../../common/wp/config-edits";
import { WP_ROCKET_LOG_OPTIONS } from "./debug-log";
import type { ScanDebugLogOptions } from "../../../common/wp/log";
import { wpRocket } from "../config/wp-rocket.config";
import {
  buildArtifactPlan,
  readArtifactEnv,
} from "../../../common/artifacts/request";
import { resolveArtifacts } from "../../../common/artifacts/resolve";
import {
  installPluginUnderTest,
  teardownPluginUnderTest,
  type DeclaredResidue,
  type LeftWork,
  type ScenarioReport,
} from "../../../common/hooks/plugin-lifecycle";
import {
  disposeConnections,
  installKey,
  resetElevationCaches,
  wpCli,
  wpRootDir,
} from "../../../common/wp/exec";
import { isPluginActive } from "../../../common/wp/plugin";
import { findSiteDbResidue } from "../../../common/wp/db-residue";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { resetOwnershipCaches } from "../../../common/wp/ownership";
import {
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "../../../common/wp/site-identity";
import { checkWebIdentity } from "../../../common/wp/web-identity";
import {
  RESTING_VARIANT,
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  resetTwin,
  sshTwinsEnabled,
  twinSite,
  withTwin,
  type TwinCell,
  type TwinStack,
  type TwinVariant,
} from "../../../common/__fixtures__/ssh-twins";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import type { ResolvedArtifact } from "../../../common/artifacts/types";
import type { IdentityState } from "../../../common/wp/site-identity";
import type { StopRunningWork, Transport } from "../../../common/config/types";

/**
 * WP Rocket's declarations and licence through the real `@plugin` install and teardown on the SSH
 * twins, with the zip a run would build (`E2E_PLUGIN_REF`/`E2E_PLUGIN_ZIP` honoured; APVM caches it).
 * Licensed by the must-use plugin alone, activation writes `WP_CACHE`; the install's settling request
 * (logged in, as a scenario's) writes the site's config file and, on Apache, the `.htaccess` block
 * before anything else asks the site, and a logged-out page is then served from cache; the outputs
 * end the site's
 * (verified in `site`, handed over in `legacy-777`, attempted and refused for want of sudo in
 * `no-sudo`); with `wp-config.php` root's (`wpconfig-root`), the deactivation WP Rocket refuses is
 * forced and the file never touched; what an earlier run left owned by the transport's user is reclaimed when its whole tree
 * is that user's and it is no shared parent, else left with its contents untouched; and the teardown
 * leaves no declared file or database row, after a normal run or one whose plugin folder vanished.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, twins up). Each test holds its twin, resets it and puts it back in
 * {@link RESTING_VARIANT}. A runner killed mid-test: `npm run env:cells:reset -- <stack> legacy-777`.
 */

/** The footer WP Rocket prints on a page it optimized. */
const FOOTER = "Performance optimized by WP Rocket";

/** One cell per twin: WP Rocket's. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "wp-rocket");

/** What the hooks would read from the registries, straight from the declarations. */
const RESIDUE: DeclaredResidue = {
  files: WP_ROCKET_SITE_RESIDUE,
  db: WP_ROCKET_SITE_DB_RESIDUE,
  installOutputs: WP_ROCKET_INSTALL_OUTPUTS,
  prepareActivation: (transport) => writeLicencePlugin(transport),
  settleAfterInstall: "admin-request",
  forceDeactivate: forceDeactivateWpRocket,
  configEdits: normaliseConfigEdits(WP_ROCKET_CONFIG_EDITS, "wp-rocket"),
};

/** A scenario report that only prints. */
const REPORT: ScenarioReport = {
  title: "WP Rocket twin lifecycle",
  failed: false,
  attach: () => Promise.resolve(),
};

/**
 * The teardown's log scan for a test that removes the plugin's folder under requests still running
 * (the settle's background work, the pages and sitemaps WP Rocket's preload fetches): a request
 * booting while `rm -rf` is part-way runs a half-deleted plugin and dies inside it. Measured: `Class
 * "ActionScheduler_Lock" not found` as Action Scheduler's runner wakes; and a `TypeError` from
 * `Lazyload\Subscriber::__construct()` (`string given`), reproduced by deleting only
 * `inc/Dependencies/RocketLazyload/Assets.php`: its container hands over the class name when the
 * class cannot load — never seen with the folder intact. Any of these is the test's own doing, so a
 * fatal raised in a file of WP Rocket's folder, or a failed `require` of one, is let through; any
 * other fatal (core, another plugin, the database) still fails it.
 */
const FOLDER_LOST_LOG_OPTIONS: ScanDebugLogOptions = {
  ...WP_ROCKET_LOG_OPTIONS,
  ignore: [
    ...(WP_ROCKET_LOG_OPTIONS.ignore ?? []),
    // Raised in one of its files: `… in <file>:<line>` (uncaught) or `… in <file> on line <n>`.
    /PHP Fatal error: .* in \/\S*\/wp-content\/plugins\/wp-rocket\/\S+\.php(?::\d+| on line \d+)$/,
    /Failed opening required '[^']*\/wp-content\/plugins\/wp-rocket\//,
  ],
};

/** The product's stop, as the hooks read it from the registry: before each removal of the plugin. */
const STOP: StopRunningWork = requireStop(wpRocket.stopRunningWork);

/** What the Before hook hands the install: the stop, and the scenario to report to. */
const LEFT_WORK: LeftWork = { stop: STOP, report: REPORT };

/** The resolved zip, shared by every test of the run; built (or read from APVM's cache) once. */
let artifact: ResolvedArtifact | undefined;
let artifactsDir: string | undefined;

test.describe("SSH twins: WP Rocket's licence, outputs and leftovers", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // A build on a cold cache, two resets, a dozen remote WordPress boots and a few web requests.
  test.setTimeout(600_000);

  test.afterAll(() => {
    if (artifactsDir !== undefined) removeTempDir(artifactsDir);
  });

  for (const twin of CELLS) {
    test(`${twin.stack} site: licensed by the must-use plugin, outputs the identity's, caching, and a clean teardown`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const warnings = captureWarnings();
      try {
        await onVariant(
          twin,
          "site",
          playwright.request,
          async (transport, root) => {
            const tracked = trackedFiles(twin.stack, root);
            // Logged in before the install, as a scenario's saved login is.
            const openSettleClient = await settleOpener(
              playwright.request,
              twin,
            );
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              openSettleClient,
            );

            expectSettled(twin.stack, root, warnings.said());
            expect(ownerOf(twin.stack, `${root}/${LICENCE_PLUGIN_PATH}`)).toBe(
              "www-data:www-data",
            );
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);
            for (const output of [
              "wp-content/advanced-cache.php",
              "wp-content/cache",
              "wp-content/cache/wp-rocket",
              "wp-content/wp-rocket-config",
            ]) {
              expect(ownerOf(twin.stack, `${root}/${output}`), output).toBe(
                "www-data:www-data",
              );
            }
            expect(warnings.said()).not.toMatch(/\[wp\/install-outputs\]/);
            await expectCaching(twin, playwright.request, root);

            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            await expectNothingRecreated(transport, twin.stack, root);
            expectPutBack(twin.stack, root, transport, zip.slug, tracked);
            expect(debugLogFatals(twin.stack, root)).toEqual([]);
          },
        );
      } finally {
        warnings.restore();
      }
    });

    // A run killed mid-scenario never reaches its teardown: WP Rocket active, wp-config.php and (on
    // Apache) .htaccess edited, the record left in /tmp. The next run's Before removes the old copy,
    // puts the files back from that record and records anew; its teardown leaves them as first found.
    test(`${twin.stack} site: a run killed mid-scenario is put back by the next run's record, byte for byte`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const logs: string[] = [];
      const realLog = console.log;
      console.log = (...args: unknown[]): void => {
        logs.push(args.map(String).join(" "));
      };
      try {
        await onVariant(
          twin,
          "site",
          playwright.request,
          async (transport, root) => {
            const tracked = trackedFiles(twin.stack, root);
            const killed = await settleOpener(playwright.request, twin);
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              killed,
            );
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);
            // Killed here: no teardown.

            const next = await settleOpener(playwright.request, twin);
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              next,
            );
            expect(logs.join("\n")).toMatch(
              /a killed run's record of the files the plugin edits was found/,
            );
            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            expectPutBack(twin.stack, root, transport, zip.slug, tracked);
          },
        );
      } finally {
        console.log = realLog;
      }
    });

    // The settle's requests are still running when the folder goes (Action Scheduler's runner sleeps
    // 5 s after its last batch; preloaded pages render after their action): the teardown's stop must
    // wait for them before it sweeps, or they re-create rows behind it.
    test(`${twin.stack} site: a run that lost the plugin folder leaves rows the teardown sweeps`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      await onVariant(
        twin,
        "site",
        playwright.request,
        async (transport, root) => {
          const tracked = trackedFiles(twin.stack, root);
          // Logged in before the install, as a scenario's saved login is.
          const openSettleClient = await settleOpener(playwright.request, twin);
          await installPluginUnderTest(
            transport,
            zip,
            RESIDUE,
            LEFT_WORK,
            REPORT,
            openSettleClient,
          );
          // The copy removed at once, under the settle's requests still running: no uninstall can run.
          twinExec(twin.stack, [
            "rm",
            "-rf",
            "--",
            `${root}/wp-content/plugins/${zip.slug}`,
          ]);
          const left = await findSiteDbResidue(
            transport,
            WP_ROCKET_SITE_DB_RESIDUE,
          );
          expect(left.tables.length).toBe(8);
          expect(left.options).toContain("wpr_rocket_cache_version");
          expect(left.capabilities.length).toBe(10);

          await teardownPluginUnderTest(
            transport,
            zip.slug,
            FOLDER_LOST_LOG_OPTIONS,
            RESIDUE,
            REPORT,
            STOP,
          );
          await expectNothingRecreated(transport, twin.stack, root);
          expectPutBack(twin.stack, root, transport, zip.slug, tracked);
        },
      );
    });

    // The stop's probe against Action Scheduler's real tables, on rows shaped as its store writes them:
    // only WP Rocket's groups count, a claim counts while it holds a pending or running action, and
    // what is older than the wait's budget is named, never waited for.
    test(`${twin.stack} site: the stop counts only WP Rocket's own Action Scheduler work, and names stale work without waiting`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      await onVariant(twin, "site", playwright.request, async (transport) => {
        // Action Scheduler's tables, as a real install and its settle leave them; then quiet.
        const openSettleClient = await settleOpener(playwright.request, twin);
        await installPluginUnderTest(
          transport,
          zip,
          RESIDUE,
          LEFT_WORK,
          REPORT,
          openSettleClient,
        );
        await STOP(transport);

        // Another plugin's batch running (WooCommerce's, say): none of WP Rocket's work.
        const other = await seedQueue(transport, [
          { claim: 0, group: "e2e-other", status: "in-progress", ago: 0 },
          {
            claim: 0,
            group: "e2e-other",
            status: "complete",
            ago: 0,
            logged: true,
          },
        ]);
        const before = await readBackgroundWork(transport);
        expect(before.claims).toEqual([]);
        expect(before.inProgress).toEqual([]);
        expect(before.lastRunAt ?? 0).toBeLessThan(before.now - 5);
        let started = Date.now();
        expect(await STOP(transport)).toBeUndefined();
        expect(Date.now() - started).toBeLessThan(
          BACKGROUND_WORK_BUDGETS.quietMs,
        );

        // WP Rocket's own: a running batch, a batch still pending, a batch done, one left stale.
        const stale = 120;
        const rocket = await seedQueue(
          transport,
          [
            {
              claim: 0,
              group: "rocket-preload",
              status: "in-progress",
              ago: 0,
            },
            { claim: 1, group: "rocket", status: "pending", ago: 0 },
            {
              claim: 2,
              group: "rocket-preload",
              status: "complete",
              ago: 0,
              logged: true,
            },
            {
              claim: 3,
              group: "rocket-preload",
              status: "in-progress",
              ago: stale,
            },
          ],
          [0, 0, 0, stale],
        );
        const look = await readBackgroundWork(transport);
        expect(new Set(look.claims.map((c) => c.name))).toEqual(
          new Set([0, 1, 3].map((i) => `claim ${String(rocket.claims[i])}`)),
        );
        expect(look.claims.map((c) => c.name)).not.toContain(
          `claim ${String(other.claims[0])}`,
        );
        expect(new Set(look.inProgress.map((a) => a.name))).toEqual(
          new Set(
            [0, 3].map(
              (i) =>
                `action ${String(rocket.actions[i])} (e2e_hook_${String(i)})`,
            ),
          ),
        );
        expect(look.lastRunAt).toBeGreaterThan(look.now - 5);
        expect(staleWork(look, BACKGROUND_WORK_BUDGETS.drainMs)).toEqual([
          expect.stringMatching(
            new RegExp(
              `^claim ${String(rocket.claims[3])}, created 1[12]\\d\\.\\d s ago$`,
            ),
          ),
          expect.stringMatching(
            new RegExp(
              `^action ${String(rocket.actions[3])} \\(e2e_hook_3\\), started 1[12]\\d\\.\\d s ago$`,
            ),
          ),
        ]);

        // Only the stale batch left (what a request killed outright leaves): a warning at once.
        await evalPhp(
          transport,
          `global $wpdb;
            $wpdb->query( "DELETE FROM {$wpdb->prefix}actionscheduler_actions WHERE action_id IN (${[0, 1, 2].map((i) => String(rocket.actions[i])).join(",")})" );`,
          "dropping the twin's live batches",
          "twin",
          { skipPlugins: true, skipThemes: true },
        );
        started = Date.now();
        const said = await STOP(transport);
        expect(Date.now() - started).toBeLessThan(
          BACKGROUND_WORK_BUDGETS.quietMs,
        );
        expect(said).toMatch(
          new RegExp(
            `^WP Rocket's Action Scheduler holds work no request is running any more \\(claim ${String(rocket.claims[3])}, created .*; action ${String(rocket.actions[3])} \\(e2e_hook_3\\), started .*\\): left by a request killed outright`,
          ),
        );
      });
    });

    test(`${twin.stack} legacy-777: new outputs handed over; ubuntu's leftover leaves reclaimed, a shared parent and a leaf holding root's file left`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const warnings = captureWarnings();
      try {
        await onVariant(
          twin,
          "legacy-777",
          playwright.request,
          async (transport, root) => {
            // What a fallback run killed before its handover leaves: the transport's user's.
            const ubuntuDir = (path: string): string =>
              twinExec(twin.stack, [
                "install",
                "-d",
                "-o",
                "ubuntu",
                "-g",
                "ubuntu",
                "-m",
                "0755",
                `${root}/${path}`,
              ]);
            ubuntuDir("wp-content/cache");
            ubuntuDir("wp-content/cache/wp-rocket");
            ubuntuDir("wp-content/cache/min");
            twinExec(twin.stack, [
              "install",
              "-o",
              "ubuntu",
              "-g",
              "ubuntu",
              "-m",
              "0644",
              "/dev/null",
              `${root}/wp-content/advanced-cache.php`,
            ]);
            // Someone else's file in one leftover: a recursive handover would open and take it.
            const rootFile = `${root}/wp-content/cache/min/root-only.css`;
            twinExec(twin.stack, [
              "install",
              "-o",
              "root",
              "-g",
              "root",
              "-m",
              "0600",
              "/dev/null",
              rootFile,
            ]);
            const tracked = trackedFiles(twin.stack, root);

            // Logged in before the install, as a scenario's saved login is.
            const openSettleClient = await settleOpener(
              playwright.request,
              twin,
            );
            const started = Date.now();
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              openSettleClient,
            );
            console.log(
              `[twin] ${twin.stack} legacy-777 install: ${String(Date.now() - started)} ms`,
            );
            expectSettled(twin.stack, root, warnings.said());

            for (const output of [
              LICENCE_PLUGIN_PATH,
              "wp-content/advanced-cache.php",
              "wp-content/cache/wp-rocket",
              "wp-content/wp-rocket-config",
            ]) {
              expect(ownerOf(twin.stack, `${root}/${output}`), output).toBe(
                "sftp_twin:www-data",
              );
            }
            for (const left of ["wp-content/cache", "wp-content/cache/min"]) {
              expect(ownerOf(twin.stack, `${root}/${left}`), left).toBe(
                "ubuntu:ubuntu",
              );
            }
            expect(
              twinExec(twin.stack, ["stat", "-c", "%U:%G %a", "--", rootFile]),
            ).toBe("root:root 600\n");
            const said = warnings.said();
            for (const reclaimed of [
              "wp-content/advanced-cache.php",
              "wp-content/cache/wp-rocket",
            ]) {
              expect(said).toContain(
                `"${reclaimed}" existed before the install, owned whole by the transport's user`,
              );
            }
            expect(said).toMatch(
              /"wp-content\/cache" existed before the install.*was left.*other declared outputs live beneath it/,
            );
            expect(said).toMatch(
              /"wp-content\/cache\/min" existed before the install.*was left.*another user's/,
            );
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);
            await expectCaching(twin, playwright.request, root);

            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            expectNoDeclaredFiles(twin.stack, root);
            // The killed run's empty advanced-cache.php was reclaimed (handed to the site) by design.
            expectPutBack(twin.stack, root, transport, zip.slug, {
              ...tracked,
              "wp-content/advanced-cache.php": (
                tracked["wp-content/advanced-cache.php"] ?? ""
              ).replace("ubuntu:ubuntu 644", "sftp_twin:www-data 777"),
            });
          },
        );
      } finally {
        warnings.restore();
      }
    });

    // WP Rocket refuses its own deactivation while it cannot write `wp-config.php`, and WP-CLI exits 0
    // on it: the hooks' stop and removal must force it, report it, and leave the site clean.
    test(`${twin.stack} wpconfig-root: a refused deactivation is forced and reported, wp-config.php untouched, the site left clean`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const warnings = captureWarnings();
      try {
        await onVariant(
          twin,
          "wpconfig-root",
          playwright.request,
          async (transport, root) => {
            const tracked = trackedFiles(twin.stack, root);
            const config = `${root}/wp-config.php`;
            const before = fileState(twin.stack, config);
            expect(before).toMatch(/^root:www-data 644 /);
            const openSettleClient = await settleOpener(
              playwright.request,
              twin,
            );
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              openSettleClient,
            );
            // Licensed, yet no `WP_CACHE`: the file is not writable.
            expect(wpCacheLine(twin.stack, root)).toBe("");

            // The premise: a plain deactivation exits 0, leaves it active and stores its refusal.
            const plain = await wpCli(transport, [
              "plugin",
              "deactivate",
              zip.slug,
            ]);
            expect(plain.exitCode).toBe(0);
            expect(await isPluginActive(transport, zip.slug)).toBe(true);
            expect(await refusalTransients(transport)).not.toEqual([]);

            // The force alone: deactivated, its refusals gone.
            await forceDeactivateWpRocket(transport, zip.slug);
            expect(await isPluginActive(transport, zip.slug)).toBe(false);
            expect(await refusalTransients(transport)).toEqual([]);

            // Active again (activation is never refused), for the teardown to meet the refusal itself.
            expect(
              (await wpCli(transport, ["plugin", "activate", zip.slug]))
                .exitCode,
            ).toBe(0);
            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            // The stop forced it and said so; the removal after it found it inactive (no report of
            // its own) and needed no last resort.
            expect(warnings.said()).toMatch(
              /deactivated first — forced, as a plain deactivation did not take \(`wp plugin deactivate` exited 0 but left it active\)|WP Rocket stayed active \(`wp plugin deactivate` exited 0 but left it active\), so its forced deactivation ran/,
            );
            expect(warnings.said()).not.toContain('"wp-rocket" stayed active');
            expect(warnings.said()).not.toMatch(/without loading it/);
            await expectNothingRecreated(transport, twin.stack, root);
            expect(debugLogFatals(twin.stack, root)).toEqual([]);
            expect(fileState(twin.stack, config)).toBe(before);
            expectPutBack(twin.stack, root, transport, zip.slug, tracked);
          },
        );
      } finally {
        warnings.restore();
      }
    });

    // The web server edits `wp-config.php` (and Apache's `.htaccess`) through its settling request,
    // while site commands run as ubuntu, who cannot write either: the teardown's put-back goes
    // through root, in place, and leaves both as first found. On Apache `index.php` is made 664 first,
    // so WordPress's FS_CHMOD_FILE is 664 and WP Rocket's write opens `wp-config.php` to the group:
    // ubuntu then writes its bytes back itself, and only its mode needs root. The first run is killed
    // mid-scenario: the next run's Before reconciles through root, its teardown again.
    test(`${twin.stack} web-config: files only the web server can write are put back by root, byte for byte and in place`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const warnings = captureWarnings();
      const notes = captureLogs();
      try {
        await onVariant(
          twin,
          "web-config",
          playwright.request,
          async (transport, root) => {
            const tracked = trackedFiles(twin.stack, root);
            const edited =
              twin.stack === "apache"
                ? ["wp-config.php", ".htaccess"]
                : ["wp-config.php"];
            for (const name of edited) {
              expect(tracked[name], name).toMatch(
                /^regular file www-data:www-data 644 /,
              );
            }
            if (twin.stack === "apache") {
              twinExec(twin.stack, ["chmod", "664", `${root}/index.php`]);
            }
            const openSettleClient = await settleOpener(
              playwright.request,
              twin,
            );
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              openSettleClient,
            );
            // The premise: the web server's settling request wrote what WP-CLI could not.
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);
            expectSettled(twin.stack, root, warnings.said());
            // Killed here: no teardown. The next run's Before puts the files back from the record.
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              await settleOpener(playwright.request, twin),
            );
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);

            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            expect(warnings.said()).not.toMatch(/cannot write it|mode is/);
            const rootNotes =
              twin.stack === "apache"
                ? [
                    `"wp-config.php"'s mode set back to 0644 as root (the scenario left 0664).`,
                    `".htaccess" put back as root: this run's commands cannot write it.`,
                  ]
                : [
                    `"wp-config.php" put back as root: this run's commands cannot write it.`,
                  ];
            for (const moment of ["before", "after"]) {
              for (const note of rootNotes) {
                expect(notes.said()).toContain(
                  `[hooks] ${moment} "${REPORT.title}", ${note}`,
                );
              }
            }
            await expectNothingRecreated(transport, twin.stack, root);
            expectPutBack(twin.stack, root, transport, zip.slug, tracked);
            expect(debugLogFatals(twin.stack, root)).toEqual([]);
          },
        );
      } finally {
        warnings.restore();
        notes.restore();
      }
    });

    test(`${twin.stack} no-sudo: licensed, the handover attempted and refused for want of sudo`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      const warnings = captureWarnings();
      try {
        await onVariant(
          twin,
          "no-sudo",
          playwright.request,
          async (transport, root) => {
            const tracked = trackedFiles(twin.stack, root);
            // Logged in before the install, as a scenario's saved login is.
            const openSettleClient = await settleOpener(
              playwright.request,
              twin,
            );
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              LEFT_WORK,
              REPORT,
              openSettleClient,
            );

            expectSettled(twin.stack, root, warnings.said());
            expect(wpCacheLine(twin.stack, root)).toMatch(/'WP_CACHE', true/);
            expect(ownerOf(twin.stack, `${root}/wp-content/cache`)).toBe(
              "ubuntu:ubuntu",
            );
            expect(warnings.said()).toMatch(
              /file ownership cannot be corrected \(elevation: /,
            );

            await teardownPluginUnderTest(
              transport,
              zip.slug,
              WP_ROCKET_LOG_OPTIONS,
              RESIDUE,
              REPORT,
              STOP,
            );
            expectNoDeclaredFiles(twin.stack, root);
            expectPutBack(twin.stack, root, transport, zip.slug, tracked);
          },
        );
      } finally {
        warnings.restore();
      }
    });
  }
});

/**
 * WP Rocket's zip, resolved as a run resolves it (default ref unless overridden) into a temporary
 * folder of its own; once per worker.
 */
async function wpRocketZip(): Promise<ResolvedArtifact> {
  if (artifact !== undefined) return artifact;
  const plan = buildArtifactPlan({
    product: wpRocket.artifacts,
    edition: undefined,
    serial: false,
    env: readArtifactEnv(),
  });
  artifactsDir = mkdtempSync(join(tmpdir(), "e2e-wpr-twin-zip-"));
  const outcomes = await resolveArtifacts({
    requests: plan.requests.filter((request) => request.role === "plugin"),
    artifactsDir,
    slug: "wp-rocket",
  });
  const [outcome] = outcomes;
  if (outcome?.kind !== "resolved") {
    throw new Error(
      `WP Rocket's zip did not resolve: ${JSON.stringify(outcome)}`,
    );
  }
  artifact = outcome.artifact;
  return artifact;
}

/** One action to seed: its claim (by index into the claims seeded), group, status and age. */
interface SeededAction {
  readonly claim: number;
  readonly group: string;
  readonly status: "pending" | "in-progress" | "complete";
  /** Seconds since its last attempt (and its scheduled time, a second earlier). */
  readonly ago: number;
  /** Whether a log line records it, at its last attempt: a finished action's. */
  readonly logged?: boolean;
}

/**
 * Writes Action Scheduler rows straight into its tables, as its database store writes them (a claim's
 * creation time; an action's group, status, claim and last attempt; a log line), with no plugin loaded
 * so no runner picks them up. Hooks are `e2e_hook_<index>`.
 *
 * @param actions - the actions, in order.
 * @param claimAges - each claim's age in seconds; one claim (age 0) when omitted.
 * @returns the ids of the claims and actions, in order.
 */
async function seedQueue(
  transport: Transport,
  actions: readonly SeededAction[],
  claimAges: readonly number[] = [0],
): Promise<{ claims: number[]; actions: number[] }> {
  const ids = JSON.parse(
    await evalPhp(
      transport,
      `global $wpdb;
      $p      = $wpdb->prefix;
      $at     = function ( $ago ) { return gmdate( 'Y-m-d H:i:s', time() - $ago ); };
      $claims = [];
      foreach ( ${phpLiteral([...claimAges])} as $ago ) {
        $wpdb->insert( "{$p}actionscheduler_claims", [ 'date_created_gmt' => $at( $ago ) ] );
        $claims[] = (int) $wpdb->insert_id;
      }
      $ids = [];
      foreach ( ${phpLiteral(actions.map((a) => ({ ...a, logged: a.logged === true })))} as $i => $a ) {
        $group = $wpdb->get_var( $wpdb->prepare( "SELECT group_id FROM {$p}actionscheduler_groups WHERE slug = %s", $a['group'] ) );
        if ( null === $group ) {
          $wpdb->insert( "{$p}actionscheduler_groups", [ 'slug' => $a['group'] ] );
          $group = $wpdb->insert_id;
        }
        $wpdb->insert( "{$p}actionscheduler_actions", [
          'hook'                 => 'e2e_hook_' . $i,
          'status'               => $a['status'],
          'scheduled_date_gmt'   => $at( $a['ago'] + 1 ),
          'scheduled_date_local' => $at( $a['ago'] + 1 ),
          'args'                 => '[]',
          'group_id'             => (int) $group,
          'attempts'             => 'pending' === $a['status'] ? 0 : 1,
          'last_attempt_gmt'     => $at( $a['ago'] ),
          'last_attempt_local'   => $at( $a['ago'] ),
          'claim_id'             => $claims[ $a['claim'] ],
        ] );
        $ids[] = (int) $wpdb->insert_id;
        if ( $a['logged'] ) {
          $wpdb->insert( "{$p}actionscheduler_logs", [ 'action_id' => $wpdb->insert_id, 'message' => 'action complete via e2e', 'log_date_gmt' => $at( $a['ago'] ), 'log_date_local' => $at( $a['ago'] ) ] );
        }
        if ( '' !== $wpdb->last_error ) {
          WP_CLI::error( $wpdb->last_error );
        }
      }
      echo wp_json_encode( [ 'claims' => $claims, 'actions' => $ids ] );`,
      "seeding the twin's Action Scheduler rows",
      "twin",
      { skipPlugins: true, skipThemes: true },
    ),
  ) as { claims: number[]; actions: number[] };
  return ids;
}

/** The paths WP Rocket edits or creates beside its folder, which the teardown must leave as found. */
const TRACKED = [
  "wp-config.php",
  ".htaccess",
  "wp-content/advanced-cache.php",
  "wp-content/cache",
] as const;

/**
 * Each tracked path's type, owner, mode and inode, and a file's SHA-256 — or `absent` — read as root.
 */
function trackedFiles(stack: TwinStack, root: string): Record<string, string> {
  return Object.fromEntries(
    TRACKED.map((path) => [
      path,
      twinExec(stack, [
        "sh",
        "-c",
        'if [ ! -e "$1" ] && [ ! -L "$1" ]; then echo absent; exit; fi; stat -c "%F %U:%G %a %i" -- "$1"; if [ -f "$1" ]; then sha256sum -- "$1" | cut -d" " -f1; fi',
        "sh",
        `${root}/${path}`,
      ]).trim(),
    ]),
  );
}

/** The teardown put every tracked path back as {@link trackedFiles} saw it, and left no record (of any identity). */
function expectPutBack(
  stack: TwinStack,
  root: string,
  transport: Transport,
  slug: string,
  before: Record<string, string>,
): void {
  expect(trackedFiles(stack, root)).toEqual(before);
  expect(
    twinExec(stack, [
      "sh",
      "-c",
      // Any identity's: the engine appends the effective uid to the stem.
      'for d in "$1"-*; do if [ -e "$d" ]; then echo kept; exit; fi; done; echo gone',
      "sh",
      recordStemFor(transport, slug),
    ]).trim(),
  ).toBe("gone");
}

/**
 * Holds `twin`, resets it to `variant`, registers the web probe's verdict and checks the state, runs
 * `work`, then — whatever happened — closes connections and resets the twin to
 * {@link RESTING_VARIANT}. `work`'s error wins over the cleanup's.
 */
async function onVariant(
  twin: TwinCell,
  variant: TwinVariant,
  request: APIRequest,
  work: (transport: Transport, root: string) => Promise<void>,
): Promise<void> {
  await withTwin(twin.stack, async () => {
    let failure: Error | undefined;
    try {
      resetTwin(twin.stack, variant);
      resetSiteIdentityCaches();
      resetElevationCaches();
      resetOwnershipCaches();
      const site = twinSite(twin);
      const verdict = await checkWebIdentity(site, request);
      registerSiteIdentityVerdicts(
        new Map([[installKey(site.transport), verdict]]),
      );
      const expected: IdentityState["kind"] =
        variant === "site" || variant === "wpconfig-root" ? "site" : "fallback";
      expect((await resolveSiteIdentity(site.transport)).kind).toBe(expected);
      await work(site.transport, await wpRootDir(site.transport));
    } catch (error) {
      failure = error instanceof Error ? error : new Error(String(error));
    }
    disposeConnections();
    try {
      resetTwin(twin.stack, RESTING_VARIANT);
    } catch (error) {
      failure ??= error instanceof Error ? error : new Error(String(error));
    }
    if (failure !== undefined) throw failure;
  });
}

/**
 * Asks for the front page twice logged out: both carry WP Rocket's footer and a cached copy exists.
 * No admin request of its own: the install's settling request wrote the config file caching needs.
 */
async function expectCaching(
  twin: TwinCell,
  request: APIRequest,
  root: string,
): Promise<void> {
  const visitor = await request.newContext({ baseURL: twinSite(twin).baseURL });
  try {
    for (let i = 0; i < 2; i += 1) {
      expect(await (await visitor.get("/")).text()).toContain(FOOTER);
    }
  } finally {
    await visitor.dispose();
  }
  const cached = twinExec(twin.stack, [
    "find",
    `${root}/wp-content/cache/wp-rocket`,
    "-name",
    "index*.html",
    "-size",
    "+0",
  ]);
  expect(cached.trim()).not.toBe("");
}

/**
 * Logs in as the twin's administrator the way the auth setup does — the login POST alone, its
 * redirect to wp-admin not followed (that GET would run the plugin's `admin_init` and do the settle's
 * work for it) — and returns an opener for the settling request's client: a fresh context from that
 * saved session, as the Before hook opens one from a scenario's `storageState`.
 */
async function settleOpener(
  request: APIRequest,
  twin: TwinCell,
): Promise<() => Promise<APIRequestContext>> {
  const site = twinSite(twin);
  const login = await request.newContext({ baseURL: site.baseURL });
  let session: Awaited<ReturnType<APIRequestContext["storageState"]>>;
  try {
    const answer = await login.post("/wp-login.php", {
      form: { log: site.username, pwd: site.password, testcookie: "1" },
      headers: { Cookie: "wordpress_test_cookie=WP%20Cookie%20check" },
      maxRedirects: 0,
    });
    expect(answer.status()).toBe(302);
    session = await login.storageState();
  } finally {
    await login.dispose();
  }
  expect(
    session.cookies.some((cookie) =>
      cookie.name.startsWith("wordpress_logged_in_"),
    ),
  ).toBe(true);
  return () =>
    request.newContext({ baseURL: site.baseURL, storageState: session });
}

/**
 * Right after the install, whose settling request is the only one the site has had since its login (a
 * POST whose redirect was not followed, sent before the plugin was installed): what only an admin
 * request writes is there — the site's config file, and on Apache the `.htaccess` block — written by the web
 * server (`www-data`), and the settle warned nothing.
 */
function expectSettled(stack: TwinStack, root: string, said: string): void {
  expect(said).not.toMatch(/settling request/);
  const configs = twinExec(stack, [
    "find",
    `${root}/wp-content/wp-rocket-config`,
    "-maxdepth",
    "1",
    "-name",
    "*.php",
    "-printf",
    "%u %f\\n",
  ]).trim();
  expect(configs).toMatch(/^www-data \S+\.php$/m);
  if (stack === "apache") {
    expect(
      twinExec(stack, [
        "grep",
        "-c",
        "# BEGIN WP Rocket",
        `${root}/.htaccess`,
      ]).trim(),
    ).toBe("1");
  }
}

/**
 * After the teardown, once anything still running would have finished (the stop's quiet window):
 * no declared file or database row is back. A request the teardown raced writes them after its
 * sweep (measured on nginx: `_transient_wpr_dynamic_lists`).
 */
async function expectNothingRecreated(
  transport: Transport,
  stack: TwinStack,
  root: string,
): Promise<void> {
  expectNoDeclaredFiles(stack, root);
  await new Promise((resolve) =>
    setTimeout(resolve, BACKGROUND_WORK_BUDGETS.quietMs),
  );
  expectNoDeclaredFiles(stack, root);
  // Compared whole, so a failure names what came back.
  expect(await findSiteDbResidue(transport, WP_ROCKET_SITE_DB_RESIDUE)).toEqual(
    { options: [], tables: [], roles: [], capabilities: [] },
  );
}

/** The fatal lines of the site's `debug.log`, read as root; none when there is no log. */
function debugLogFatals(stack: TwinStack, root: string): string[] {
  return twinExec(stack, [
    "sh",
    "-c",
    'if [ -f "$1" ]; then grep "PHP Fatal" "$1" || true; fi',
    "d",
    `${root}/wp-content/debug.log`,
  ])
    .split("\n")
    .filter((line) => line !== "");
}

/** Asserts no declared residue path is left: the cache folders, the config folder, the licence. */
function expectNoDeclaredFiles(stack: TwinStack, root: string): void {
  for (const entry of WP_ROCKET_SITE_RESIDUE) {
    const path =
      typeof entry === "string"
        ? entry
        : "path" in entry
          ? entry.path
          : entry.parent;
    const left = twinExec(stack, [
      "sh",
      "-c",
      'if [ -e "$1" ] || [ -h "$1" ]; then echo left; fi',
      "e",
      `${root}/${path}`,
    ]);
    expect(left.trim(), path).toBe("");
  }
}

/** The `WP_CACHE` line of `wp-config.php`, or an empty string. */
function wpCacheLine(stack: TwinStack, root: string): string {
  return twinExec(stack, [
    "sh",
    "-c",
    'grep -m1 "\'WP_CACHE\'," "$1" || true',
    "g",
    `${root}/wp-config.php`,
  ]);
}

/** Collects `console.warn` lines while still printing them. */
function captureWarnings(): { said: () => string; restore: () => void } {
  const lines: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
    realWarn(...args);
  };
  return {
    said: () => lines.join("\n"),
    restore: () => {
      console.warn = realWarn;
    },
  };
}

/** Collects `console.log` lines while still printing them. */
function captureLogs(): { said: () => string; restore: () => void } {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
    realLog(...args);
  };
  return {
    said: () => lines.join("\n"),
    restore: () => {
      console.log = realLog;
    },
  };
}

/** Runs a command as root in a twin's container, outside the suite; returns its stdout. */
function twinExec(stack: TwinStack, argv: readonly string[]): string {
  return execFileSync("docker", ["exec", `wpme-ssh-${stack}`, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/** The product's stop, which it must declare: the settling request starts work that outlives it. */
function requireStop(stop: StopRunningWork | undefined): StopRunningWork {
  if (stop === undefined)
    throw new Error("WP Rocket declares no stopRunningWork");
  return stop;
}

/** A file's owner, mode, inode and SHA-256, read as root: what must not change. */
function fileState(stack: TwinStack, path: string): string {
  const stat = twinExec(stack, ["stat", "-c", "%U:%G %a %i", "--", path]);
  const sum = twinExec(stack, ["sha256sum", "--", path]).split(" ")[0] ?? "";
  return `${stat.trim()} ${sum}`;
}

/** The names of WP Rocket's refusal transients on the site (any user's), WordPress booted bare. */
async function refusalTransients(transport: Transport): Promise<string[]> {
  return JSON.parse(
    await evalPhp(
      transport,
      `global $wpdb;
      echo wp_json_encode( $wpdb->get_col( $wpdb->prepare( "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s", '%' . $wpdb->esc_like( '_donotdeactivaterocket' ) ) ) );`,
      "reading WP Rocket's refusal transients",
      "twin",
      { skipPlugins: true, skipThemes: true },
    ),
  ) as string[];
}

/** `user:group` of a path, read as root. */
function ownerOf(stack: TwinStack, path: string): string {
  return twinExec(stack, ["stat", "-c", "%U:%G", "--", path]).trim();
}
