import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { replacePluginUnderTest } from "./plugin-lifecycle";
import {
  disposeConnections,
  installKey,
  resetElevationCaches,
  wpRootDir,
} from "../wp/exec";
import { resetOwnershipCaches } from "../wp/ownership";
import {
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "../wp/site-identity";
import { checkWebIdentity } from "../wp/web-identity";
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
} from "../__fixtures__/ssh-twins";
import type { ResolvedArtifact } from "../artifacts/types";
import type { FallbackReason, IdentityState } from "../wp/site-identity";
import type { Transport } from "../config/types";

/**
 * Install outputs through the real install path (`replacePluginUnderTest`) on the SSH twins: a fake
 * plugin whose activation writes a file and a folder outside its own, under a shared parent that
 * existed before (root's, so a handover of it would show). Only what activation created is handed
 * over where commands run as the transport's user; in `site` they are already the identity's.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin, resets it,
 * and puts it back in {@link RESTING_VARIANT} — whose reset recreates the docroot, so nothing the
 * test wrote survives it. A runner killed mid-test: `npm run env:cells:reset -- <stack> legacy-777`.
 */

/** The fake plugin's slug: a folder no product uses. */
const SLUG = "e2e-install-outputs-probe";

/** What its activation writes, relative to the root, and the shared parent that exists before. */
const DROP_IN = "wp-content/e2e-io-drop-in.php";
const SHARED = "wp-content/e2e-io-cache";
const PAGES = `${SHARED}/e2e-io-pages`;

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

/**
 * The fake plugin's zip, built in this test's output folder (emptied by the next run should the
 * runner die first).
 *
 * @returns the artifact, and its removal.
 */
function buildProbe(): {
  readonly artifact: ResolvedArtifact;
  readonly remove: () => void;
} {
  const dir = test.info().outputPath("probe-zip");
  mkdirSync(join(dir, SLUG), { recursive: true });
  writeFileSync(
    join(dir, SLUG, `${SLUG}.php`),
    `<?php
/**
 * Plugin Name: E2E install outputs probe
 * Version: 1.0.0
 */
register_activation_hook(__FILE__, function () {
\twp_mkdir_p(WP_CONTENT_DIR . '/e2e-io-cache/e2e-io-pages');
\tfile_put_contents(WP_CONTENT_DIR . '/e2e-io-drop-in.php', "<?php\\n");
});
`,
  );
  const zipFilename = `${SLUG}.zip`;
  execFileSync("zip", ["-qr", zipFilename, SLUG], { cwd: dir });
  return {
    artifact: {
      role: "plugin",
      slug: SLUG,
      zipPath: join(dir, zipFilename),
      zipFilename,
      source: "default-ref",
      origin: "built",
      resolvedAt: "2026-11-12T00:00:00.000Z",
    },
    remove: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.describe("SSH twins: install outputs by identity state", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // Two resets (~6 s each), the web probe, a dozen remote WP-CLI boots.
  test.setTimeout(300_000);

  const cases: readonly {
    readonly variant: TwinVariant;
    readonly state: IdentityState["kind"];
    readonly reason?: FallbackReason;
    /** The owner each new output must end with. */
    readonly owner: string;
    /** A warning the run must print, if any. */
    readonly warns?: RegExp;
  }[] = [
    {
      variant: "no-sudo",
      state: "fallback",
      reason: "no-sudo",
      // No sudo: the handover is attempted and skipped, as for the plugin's own folder.
      owner: "ubuntu:ubuntu",
      warns: /file ownership cannot be corrected \(elevation: /,
    },
    {
      variant: "legacy-777",
      state: "fallback",
      reason: "owner-not-web",
      owner: "sftp_twin:www-data",
    },
    { variant: "site", state: "site", owner: "www-data:www-data" },
  ];

  for (const twin of CELLS) {
    for (const { variant, state, reason, owner, warns } of cases) {
      test(`${twin.stack} ${variant}: only the outputs activation created end ${owner}`, async ({
        playwright,
      }) => {
        const probe = buildProbe();
        const warnings: string[] = [];
        const realWarn = console.warn;
        console.warn = (...args: unknown[]): void => {
          warnings.push(args.map(String).join(" "));
          realWarn(...args);
        };
        try {
          await onVariant(twin, variant, probe.remove, async (transport) => {
            const verdict = await checkWebIdentity(
              twinSite(twin),
              playwright.request,
            );
            registerSiteIdentityVerdicts(
              new Map([[installKey(transport), verdict]]),
            );
            const resolved = await resolveSiteIdentity(transport);
            expect(resolved.kind).toBe(state);
            if (resolved.kind === "fallback") {
              expect(resolved.reason).toBe(reason);
            }
            const root = await wpRootDir(transport);
            // The shared parent exists before the install, root's: a handover of it would show.
            twinExec(twin.stack, [
              "install",
              "-d",
              "-m",
              "0777",
              `${root}/${SHARED}`,
            ]);

            await replacePluginUnderTest(transport, probe.artifact, {
              files: [],
              db: {},
              installOutputs: [DROP_IN, SHARED, PAGES],
            });

            expect(ownerOf(twin.stack, `${root}/${DROP_IN}`)).toBe(owner);
            expect(ownerOf(twin.stack, `${root}/${PAGES}`)).toBe(owner);
            expect(ownerOf(twin.stack, `${root}/${SHARED}`)).toBe("root:root");
            const said = warnings.join("\n");
            if (warns === undefined) {
              expect(said).not.toMatch(/\[wp\/install-outputs\]/);
            } else {
              expect(said).toMatch(warns);
            }
          });
        } finally {
          console.warn = realWarn;
        }
      });
    }
  }
});

/**
 * Holds `twin`, resets it to `variant`, runs `work` on its transport with fresh caches, then — each
 * step whatever the others did — puts it back in {@link RESTING_VARIANT} and runs `cleanup`.
 * `work`'s error wins; a cleanup's is thrown only after a passing `work`.
 *
 * @param twin - the cell.
 * @param variant - the variant to test.
 * @param cleanup - the test's own host-side cleanup.
 * @param work - the checks.
 * @throws what `work` threw, else every cleanup failure.
 */
async function onVariant(
  twin: TwinCell,
  variant: TwinVariant,
  cleanup: () => void,
  work: (transport: Transport) => Promise<void>,
): Promise<void> {
  // An object, not a `let`: set inside the callback, read after it.
  const outcome = { failed: false };
  try {
    await withTwin(twin.stack, async () => {
      try {
        resetTwin(twin.stack, variant);
        resetSiteIdentityCaches();
        resetElevationCaches();
        resetOwnershipCaches();
        await work(twinSite(twin).transport);
      } catch (error) {
        outcome.failed = true;
        throw error;
      } finally {
        const errors = runAll([
          disposeConnections,
          () => {
            resetTwin(twin.stack, RESTING_VARIANT);
          },
        ]);
        if (!outcome.failed) throwAll(errors);
      }
    });
  } finally {
    const errors = runAll([cleanup]);
    if (!outcome.failed) throwAll(errors);
  }
}

/**
 * Runs every step, each whatever the ones before it threw.
 *
 * @param steps - the steps, in order.
 * @returns what they threw, in order.
 */
function runAll(steps: readonly (() => unknown)[]): unknown[] {
  const errors: unknown[] = [];
  for (const step of steps) {
    try {
      step();
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

/**
 * Throws `errors`: none, nothing; one, itself; more, all of them together.
 *
 * @param errors - what cleanup steps threw.
 * @throws the error, or an `AggregateError` of them.
 */
function throwAll(errors: readonly unknown[]): void {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "twin cleanup failed in several steps");
  }
}

/**
 * Runs a command as root in a twin's container, outside the suite.
 *
 * @param stack - which twin.
 * @param argv - the command.
 * @returns its stdout.
 */
function twinExec(stack: TwinStack, argv: readonly string[]): string {
  return execFileSync("docker", ["exec", `wpme-ssh-${stack}`, ...argv], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
  });
}

/**
 * `user:group` of a path, read as root.
 *
 * @param stack - which twin.
 * @param path - the absolute path.
 */
function ownerOf(stack: TwinStack, path: string): string {
  return twinExec(stack, ["stat", "-c", "%U:%G", "--", path]).trim();
}
