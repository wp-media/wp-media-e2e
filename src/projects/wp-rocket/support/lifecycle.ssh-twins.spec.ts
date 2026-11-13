import { test, expect, type APIRequest } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WP_ROCKET_SITE_DB_RESIDUE } from "./db-residue";
import { LICENCE_PLUGIN_PATH, writeLicencePlugin } from "./licence";
import { WP_ROCKET_INSTALL_OUTPUTS, WP_ROCKET_SITE_RESIDUE } from "./residue";
import { WP_ROCKET_LOG_OPTIONS } from "./debug-log";
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
  type ScenarioReport,
} from "../../../common/hooks/plugin-lifecycle";
import {
  disposeConnections,
  installKey,
  resetElevationCaches,
  wpRootDir,
} from "../../../common/wp/exec";
import {
  findSiteDbResidue,
  isEmptyDbResidue,
} from "../../../common/wp/db-residue";
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
import type { Transport } from "../../../common/config/types";

/**
 * WP Rocket's declarations and licence through the real `@plugin` install and teardown on the SSH
 * twins, with the zip a run would build (`E2E_PLUGIN_REF`/`E2E_PLUGIN_ZIP` honoured; APVM caches it).
 * Licensed by the must-use plugin alone, activation writes `WP_CACHE` and a logged-out page is served
 * from cache once an admin request has written the site's config file; the outputs end the site's
 * (verified in `site`, handed over in `legacy-777`, attempted and refused for want of sudo in
 * `no-sudo`); what an earlier run left owned by the transport's user is reclaimed when its whole tree
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
};

/** A scenario report that only prints. */
const REPORT: ScenarioReport = {
  title: "WP Rocket twin lifecycle",
  failed: false,
  attach: () => Promise.resolve(),
};

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
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              undefined,
              REPORT,
            );

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
            );
            expectNoDeclaredFiles(twin.stack, root);
            expect(
              isEmptyDbResidue(
                await findSiteDbResidue(transport, WP_ROCKET_SITE_DB_RESIDUE),
              ),
            ).toBe(true);
          },
        );
      } finally {
        warnings.restore();
      }
    });

    test(`${twin.stack} site: a run that lost the plugin folder leaves rows the teardown sweeps`, async ({
      playwright,
    }) => {
      const zip = await wpRocketZip();
      await onVariant(
        twin,
        "site",
        playwright.request,
        async (transport, root) => {
          await installPluginUnderTest(
            transport,
            zip,
            RESIDUE,
            undefined,
            REPORT,
          );
          // A run killed before its teardown, its copy then removed by hand: no uninstall can run.
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
            WP_ROCKET_LOG_OPTIONS,
            RESIDUE,
            REPORT,
          );
          expectNoDeclaredFiles(twin.stack, root);
          expect(
            isEmptyDbResidue(
              await findSiteDbResidue(transport, WP_ROCKET_SITE_DB_RESIDUE),
            ),
          ).toBe(true);
        },
      );
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

            const started = Date.now();
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              undefined,
              REPORT,
            );
            console.log(
              `[twin] ${twin.stack} legacy-777 install: ${String(Date.now() - started)} ms`,
            );

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
            );
            expectNoDeclaredFiles(twin.stack, root);
          },
        );
      } finally {
        warnings.restore();
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
            await installPluginUnderTest(
              transport,
              zip,
              RESIDUE,
              undefined,
              REPORT,
            );

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
            );
            expectNoDeclaredFiles(twin.stack, root);
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
        variant === "site" ? "site" : "fallback";
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
 * Logs in, loads wp-admin (WP Rocket writes the site's config file on an admin request), then asks
 * for the front page twice logged out: both carry WP Rocket's footer and a cached copy exists.
 */
async function expectCaching(
  twin: TwinCell,
  request: APIRequest,
  root: string,
): Promise<void> {
  const site = twinSite(twin);
  const admin = await request.newContext({ baseURL: site.baseURL });
  try {
    await admin.post("/wp-login.php", {
      form: { log: site.username, pwd: site.password, testcookie: "1" },
      headers: { Cookie: "wordpress_test_cookie=WP%20Cookie%20check" },
    });
    const dashboard = await admin.get("/wp-admin/");
    expect(new URL(dashboard.url()).pathname).toMatch(/^\/wp-admin\//);
  } finally {
    await admin.dispose();
  }
  const visitor = await request.newContext({ baseURL: site.baseURL });
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

/** Runs a command as root in a twin's container, outside the suite; returns its stdout. */
function twinExec(stack: TwinStack, argv: readonly string[]): string {
  return execFileSync("docker", ["exec", `wpme-ssh-${stack}`, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/** `user:group` of a path, read as root. */
function ownerOf(stack: TwinStack, path: string): string {
  return twinExec(stack, ["stat", "-c", "%U:%G", "--", path]).trim();
}
