import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";

import {
  disposeConnections,
  exec,
  execAsTransport,
  execElevated,
  installKey,
  resetElevationCaches,
  wpRootDir,
} from "./exec";
import { listFiles } from "./files";
import { clearDebugLog, readDebugLog } from "./log";
import {
  normalizeOwnership,
  probeSiteOwnership,
  resetOwnershipCaches,
} from "./ownership";
import { ensurePluginAbsent } from "./plugin";
import { prepareSiteDataDirs, removeSiteResidue } from "./residue";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import { cleanSiteStaging, stageAndInstallPlugin } from "./staging";
import { checkWebIdentity } from "./web-identity";
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
import { removeTempDir } from "../__fixtures__/temp-dir";
import { escapeRegExp } from "../text";
import type { Transport } from "../config/types";

/**
 * Housekeeping on the SSH twins, by identity state. In `site` a fake plugin goes through
 * `stageAndInstallPlugin`, its data directory is prepared, written, listed, and removed with the
 * debug log read and cleared — everything `www-data:www-data` with the umask's modes, and **no**
 * command run as root; a survivor only root can remove is the one root call. In `legacy-777`
 * (`fallback/owner-not-web`) the handover is today's: a root `chown` to the install's owner.
 *
 * Root use is read from sudo's own log: the twins log every call to a file, and a drop-in sudoers
 * file (removed by the reset) turns on `log_allowed` for `ubuntu` with unwrapped lines, so each call
 * is one line naming `USER=`. A negative control proves a root call is seen.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin, resets it,
 * and puts it back in {@link RESTING_VARIANT}. A runner killed mid-test leaves its twin as it was:
 * `npm run env:cells:reset -- <stack> legacy-777` clears the site (and any sudoers drop-in), and
 * `npm run env:cells:up` removes a stray logging drop-in from a twin no spec holds. Nothing it plants
 * is in the docroot, and what the log check plants stops acting within {@link NO_BOOT_SECONDS}.
 */

/** The fake plugin's slug: a folder no product uses. */
const SLUG = "e2e-housekeeping-probe";

/** The data directory a product would declare. */
const DATA_DIR = "wp-content/uploads/e2e-housekeeping";

/** sudo's log on a twin (`TWIN_SUDO_LOG` in `docker/ssh-cells/lib.sh`). */
const SUDO_LOG = "/var/log/sudo-twin.log";

/** The drop-in logging `ubuntu`'s allowed calls; sorted after `90-ubuntu`, whose `!log_allowed` it overrides. */
const LOG_DROP_IN = "/etc/sudoers.d/99-e2e-log-allowed";

/** How long the log check's no-boot file makes WP-CLI fail: past it, a leftover copy does nothing. */
const NO_BOOT_SECONDS = 120;

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

/**
 * The fake plugin's zip, built in a temporary folder of its own and removed after the test. Never in
 * the test's output folder: every Playwright run of this config empties that whole folder as it
 * starts, so a second run in the checkout (another spec, a gate) would delete the zip while this test
 * waits for its twin. A runner killed first leaves the folder to the system's temporary-file cleanup.
 *
 * @returns the zip's path, and its removal.
 */
function buildProbeZip(): {
  readonly path: string;
  readonly remove: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "e2e-housekeeping-zip-"));
  mkdirSync(join(dir, SLUG));
  writeFileSync(
    join(dir, SLUG, `${SLUG}.php`),
    `<?php\n/**\n * Plugin Name: E2E housekeeping probe\n * Version: 1.0.0\n */\n`,
  );
  execFileSync("zip", ["-qr", `${SLUG}.zip`, SLUG], { cwd: dir });
  return {
    path: join(dir, `${SLUG}.zip`),
    remove: () => {
      removeTempDir(dir);
    },
  };
}

test.describe("SSH twins: ownership, residue, log and files by identity state", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // Two resets (~6 s each), the web probe, remote WP-CLI booting WordPress a dozen times.
  test.setTimeout(300_000);

  test.afterEach(() => {
    disposeConnections();
  });

  for (const twin of CELLS) {
    test(`${twin.stack} site: plugin, data directory, log and residue as www-data, with no root call`, async ({
      playwright,
    }) => {
      const zip = buildProbeZip();
      await onVariant(twin, "site", zip.remove, async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        const root = await wpRootDir(transport);
        const log = sudoLog(twin.stack);

        await stageAndInstallPlugin(transport, zip.path, { slug: SLUG });
        const plugin = `wp-content/plugins/${SLUG}`;
        await expect(
          ownerAndMode(transport, `${root}/${plugin}`),
        ).resolves.toBe("www-data:www-data 755");
        await expect(
          ownerAndMode(transport, `${root}/${plugin}/${SLUG}.php`),
        ).resolves.toBe("www-data:www-data 644");
        await expect(normalizeOwnership(transport, plugin)).resolves.toBe(
          "unnecessary",
        );

        await prepareSiteDataDirs(transport, [DATA_DIR]);
        const data = `${root}/${DATA_DIR}`;
        await expect(ownerAndMode(transport, data)).resolves.toBe(
          "www-data:www-data 777",
        );
        expect(
          (
            await exec(transport, "sh", [
              "-c",
              'echo data > "$1/a.log"',
              "write",
              data,
            ])
          ).exitCode,
        ).toBe(0);
        await expect(ownerAndMode(transport, `${data}/a.log`)).resolves.toBe(
          "www-data:www-data 644",
        );
        // `writable` is the identity's answer: www-data's own file is writable; the transport's user,
        // outside its group, is refused the same 644 file.
        await expect(listFiles(transport, data)).resolves.toMatchObject([
          { name: "a.log", writable: true },
        ]);
        await expect(
          listFiles(asTransportUser(transport), data),
        ).resolves.toMatchObject([{ name: "a.log", writable: false }]);

        expect(
          (
            await exec(transport, "sh", [
              "-c",
              "echo 'PHP Notice: e2e' >> wp-content/debug.log",
            ])
          ).exitCode,
        ).toBe(0);
        await expect(readDebugLog(transport)).resolves.toContain(
          "PHP Notice: e2e",
        );
        await clearDebugLog(transport);
        await expect(
          execAsTransport(transport, "test", [
            "-e",
            `${root}/wp-content/debug.log`,
          ]),
        ).resolves.toMatchObject({ exitCode: 1 });
        await directLogRoute(twin.stack, transport, root);

        await removeSiteResidue(transport, [DATA_DIR]);
        await expect(
          execAsTransport(transport, "test", ["-e", data]),
        ).resolves.toMatchObject({ exitCode: 1 });
        await ensurePluginAbsent(transport, SLUG);
        await cleanSiteStaging(transport);

        const calls = log.since();
        expect(
          calls.filter((line) => line.includes("USER=www-data")).length,
        ).toBeGreaterThan(10);
        expect(rootCalls(calls)).toEqual([]);

        // The negative control: one root call, and the log shows exactly it.
        await execElevated(transport, "true", []);
        const control = rootCalls(log.since().slice(calls.length));
        expect(control).toHaveLength(1);
        expect(control[0]).toMatch(/COMMAND=\S*\/true$/);
      });
    });

    test(`${twin.stack} site: what only root may create is handed to www-data, its existing parent kept`, async ({
      playwright,
    }) => {
      await onVariant(twin, "site", noCleanup, async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        const root = await wpRootDir(transport);
        const uploads = `${root}/wp-content/uploads`;
        // A parent www-data may not write: its `mkdir` is refused, and root's makes two folders.
        twinExec(twin.stack, [
          "sh",
          "-c",
          'mkdir -p -- "$1" && chown root:root -- "$1" && chmod 0755 -- "$1"',
          "plant",
          uploads,
        ]);
        const made = `${DATA_DIR}/made`;
        const log = sudoLog(twin.stack);

        await prepareSiteDataDirs(transport, [made]);

        await expect(ownerAndMode(transport, uploads)).resolves.toBe(
          "root:root 755",
        );
        await expect(
          ownerAndMode(transport, `${root}/${DATA_DIR}`),
        ).resolves.toMatch(/^www-data:www-data /);
        // Opened by www-data itself, now that it owns it.
        await expect(ownerAndMode(transport, `${root}/${made}`)).resolves.toBe(
          "www-data:www-data 777",
        );
        const roots = rootCalls(log.since());
        expect(
          roots.some((line) =>
            /COMMAND=\S*\/chown -h -- 33:33 \S+\/made \S+\/e2e-housekeeping$/.test(
              line,
            ),
          ),
        ).toBe(true);
        expect(
          roots.filter(
            (line) => !/COMMAND=\S*\/(true|test|mkdir|chown)( |$)/.test(line),
          ),
        ).toEqual([]);
      });
    });

    test(`${twin.stack} site: root removes only the survivor www-data cannot`, async ({
      playwright,
    }) => {
      await onVariant(twin, "site", noCleanup, async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        const root = await wpRootDir(transport);
        await prepareSiteDataDirs(transport, [DATA_DIR]);
        // What only root can remove: a root-owned folder holding a file, inside the data directory.
        const survivor = `${root}/${DATA_DIR}/root-only`;
        twinExec(twin.stack, [
          "sh",
          "-c",
          'mkdir -- "$1" && touch -- "$1/f" && chmod 0755 -- "$1"',
          "plant",
          survivor,
        ]);
        const log = sudoLog(twin.stack);

        await removeSiteResidue(transport, [DATA_DIR]);

        await expect(
          execAsTransport(transport, "test", ["-e", `${root}/${DATA_DIR}`]),
        ).resolves.toMatchObject({ exitCode: 1 });
        const roots = rootCalls(log.since());
        // Elevation is probed, then root removes the survivor and re-checks it; nothing else.
        expect(roots.some((line) => /COMMAND=\S*\/rm -rf -- /.test(line))).toBe(
          true,
        );
        expect(
          roots.filter(
            (line) => !/COMMAND=\S*\/(true|rm|test)( |$)/.test(line),
          ),
        ).toEqual([]);
      });
    });

    test(`${twin.stack} legacy-777: the plugin is handed to the install's owner by a root chown, as today`, async ({
      playwright,
    }) => {
      const zip = buildProbeZip();
      await onVariant(twin, "legacy-777", zip.remove, async (transport) => {
        await verify(twin, transport, playwright.request, "fallback");
        const root = await wpRootDir(transport);
        const owner = await probeSiteOwnership(transport);
        expect(owner).toBeDefined();
        const log = sudoLog(twin.stack);

        await stageAndInstallPlugin(transport, zip.path, { slug: SLUG });

        await expect(
          ownerAndMode(transport, `${root}/wp-content/plugins/${SLUG}`),
        ).resolves.toMatch(
          new RegExp(
            `^${escapeRegExp(owner?.user ?? "")}:${escapeRegExp(owner?.group ?? "")} `,
          ),
        );
        expect(
          rootCalls(log.since()).some((line) =>
            /COMMAND=\S*\/chown -Rh -- /.test(line),
          ),
        ).toBe(true);
        await ensurePluginAbsent(transport, SLUG);
      });
    });

    test(`${twin.stack} legacy-777: a symbolic link at the target is refused by root's grant, what it points to untouched`, async ({
      playwright,
    }) => {
      await onVariant(
        twin,
        "legacy-777",
        () => undefined,
        async (transport) => {
          await verify(twin, transport, playwright.request, "fallback");
          const root = await wpRootDir(transport);
          // Inside the root, so both root guards pass: only the grant's own check stands between GNU
          // `chmod -R` and the folder the link leads to.
          const pointee = `${root}/wp-content/uploads/e2e-link-target`;
          const link = `${root}/wp-content/plugins/${SLUG}`;
          twinExec(twin.stack, [
            "sh",
            "-c",
            'mkdir -p -- "$1" && chmod 0700 -- "$1" && ln -s -- "$1" "$2"',
            "e2e",
            pointee,
            link,
          ]);
          const log = sudoLog(twin.stack);

          await expect(
            normalizeOwnership(transport, `wp-content/plugins/${SLUG}`),
          ).resolves.toBe("failed");

          expect(
            twinExec(twin.stack, ["stat", "-c", "%U:%G %a", "--", pointee]),
          ).toBe("root:root 700\n");
          const calls = rootCalls(log.since());
          expect(calls.some((line) => /COMMAND=\S*\/sh -c /.test(line))).toBe(
            true,
          );
          // No bare `chmod` and no `chown`: the grant's script is the only command naming the path.
          expect(calls.some((line) => /COMMAND=\S*\/chmod /.test(line))).toBe(
            false,
          );
          expect(calls.some((line) => line.includes("chown"))).toBe(false);
        },
      );
    });
  }
});

/**
 * The log's direct route, as the site: WordPress made unbootable for WP-CLI, so the read and the
 * removal fall back to `cat` and `rm`, which the identity is allowed. WP-CLI reads a `wp-cli.yml`
 * from the folder **above** the root too (it looks upward from its working directory), so that is
 * where one goes, planted and removed as root outside the suite, requiring a file that exits 1 —
 * only until {@link NO_BOOT_SECONDS} from now, by the twin's clock: left behind by a killed runner,
 * neither touches the docroot, and both stop acting (the reset removes them). Removed `wp-cli.yml`
 * first: one requiring a missing file would break WP-CLI for good.
 *
 * @param stack - which twin.
 * @param transport - its transport, in `site`.
 * @param root - its WordPress root.
 */
async function directLogRoute(
  stack: TwinStack,
  transport: Transport,
  root: string,
): Promise<void> {
  expect(
    (
      await exec(transport, "sh", [
        "-c",
        "echo 'PHP Notice: direct' >> wp-content/debug.log",
      ])
    ).exitCode,
  ).toBe(0);
  const above = posix.dirname(root);
  twinExec(stack, [
    "sh",
    "-c",
    `umask 022 && printf '<?php if (time() < %s) { exit(1); }\\n' "$(($(date +%s) + $2))" > "$1/e2e-no-boot.php" && printf '%s\\n' 'require:' '  - e2e-no-boot.php' > "$1/wp-cli.yml"`,
    "plant",
    above,
    String(NO_BOOT_SECONDS),
  ]);
  try {
    expect(
      (await exec(transport, "wp", ["--skip-plugins", "eval", "echo 1;"]))
        .exitCode,
    ).toBe(1);
    await expect(readDebugLog(transport)).resolves.toContain(
      "PHP Notice: direct",
    );
    await clearDebugLog(transport);
  } finally {
    twinExec(stack, [
      "rm",
      "-f",
      "--",
      `${above}/wp-cli.yml`,
      `${above}/e2e-no-boot.php`,
    ]);
  }
  await expect(
    execAsTransport(transport, "test", ["-e", `${root}/wp-content/debug.log`]),
  ).resolves.toMatchObject({ exitCode: 1 });
}

/** For a test with nothing of its own to clean up. */
const noCleanup = (): void => undefined;

/**
 * Holds `twin`, resets it to `variant`, turns on sudo's logging of allowed calls, runs `work` on its
 * transport with fresh caches, then — each step whatever the others did — removes the drop-in, puts
 * the twin back in {@link RESTING_VARIANT} (whose reset removes any other sudoers file too) and runs
 * `cleanup`. `work`'s error wins; a cleanup's is thrown only after a passing `work`.
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
        twinExec(twin.stack, [
          "sh",
          "-c",
          `printf '%s\\n' 'Defaults:ubuntu log_allowed' 'Defaults loglinelen=0' > ${LOG_DROP_IN} && chmod 0440 ${LOG_DROP_IN} && visudo -cq`,
        ]);
        await work(twinSite(twin).transport);
      } catch (error) {
        outcome.failed = true;
        throw error;
      } finally {
        const errors = runAll([
          disposeConnections,
          () => twinExec(twin.stack, ["rm", "-f", "--", LOG_DROP_IN]),
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
 * Runs a command as root in a twin's container, outside the suite (so it never shows in sudo's log).
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
 * A mark in a twin's sudo log: `since()` returns the lines written after it.
 *
 * @param stack - which twin.
 */
function sudoLog(stack: TwinStack): { since(): string[] } {
  const read = (): string[] =>
    twinExec(stack, ["cat", "--", SUDO_LOG]).split("\n").filter(Boolean);
  const mark = read().length;
  return { since: () => read().slice(mark) };
}

/**
 * The log lines of calls run as root.
 *
 * @param lines - sudo log lines.
 */
function rootCalls(lines: readonly string[]): string[] {
  return lines.filter((line) => line.includes("USER=root"));
}

/**
 * Registers the pre-flight's verdict, asked of the twin's web server, and checks the state reached.
 *
 * @param twin - the cell.
 * @param transport - its transport.
 * @param request - Playwright's `request`, for the web probe.
 * @param kind - the state's kind it must reach.
 */
async function verify(
  twin: TwinCell,
  transport: Transport,
  request: Parameters<typeof checkWebIdentity>[1],
  kind: "site" | "fallback",
): Promise<void> {
  const verdict = await checkWebIdentity(twinSite(twin), request);
  registerSiteIdentityVerdicts(new Map([[installKey(transport), verdict]]));
  expect((await resolveSiteIdentity(transport)).kind).toBe(kind);
}

/**
 * `user:group mode` of a path, read as the transport's user.
 *
 * @param transport - the twin's transport.
 * @param path - the path.
 */
async function ownerAndMode(
  transport: Transport,
  path: string,
): Promise<string> {
  const { stdout } = await execAsTransport(transport, "stat", [
    "-c",
    "%U:%G %a",
    "--",
    path,
  ]);
  return stdout;
}
