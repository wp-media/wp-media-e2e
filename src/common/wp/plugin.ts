import { posix } from "node:path";

import {
  CommandKilledError,
  PluginDeactivationFailedError,
  PluginDestinationBlockedError,
  PluginDestinationExistsError,
  PluginNotInstalledError,
  PluginUninstallFailedError,
} from "./errors";
import { flushObjectCache } from "./cache";
import { wpCli } from "./exec";
import { isPathSegment } from "./paths";
import { errorMessage } from "../guards";
import { plain, redactSecrets } from "../text";
import {
  describePluginDir,
  inspectPluginDir,
  removePluginDir,
} from "./plugin-dir";
import type { DestinationVerdict } from "./errors";
import type { ExecResult } from "./exec";
import type { PresentPluginDir } from "./plugin-dir";
import type { ForceDeactivate, Transport } from "../config/types";

/**
 * WordPress plugin lifecycle over WP-CLI (transport-agnostic — see ./exec).
 *
 * Removal uses `wp plugin uninstall`, NOT `wp plugin delete`. `delete` only removes the plugin's
 * files ("without deactivating or uninstalling" — WP-CLI handbook), so it leaves the plugin's
 * database footprint (options, custom tables, cron events) behind. `uninstall` runs the plugin's
 * uninstall procedure — `uninstall.php`, or the callback registered via
 * `register_uninstall_hook()` — which is where a well-behaved plugin clears that state, and then
 * deletes the files (we do NOT pass `--skip-delete`).
 *
 * Deactivate and uninstall are always TWO SEPARATE WP-CLI calls — never `uninstall --deactivate`.
 * That flag deactivates and uninstalls in one PHP process, but the plugin's main file was already
 * `include`d for that process to boot, and PHP cannot unload an include: deactivating just flips
 * a DB flag, it doesn't remove the plugin's class from memory. So the uninstall procedure still
 * finds the plugin "loaded", and a well-behaved plugin guards its uninstall.php against exactly
 * that (loaded ⇒ might still be active ⇒ skip) — cleanup silently never runs. Deactivating first,
 * as its own WP-CLI call, means the second call (plain `uninstall`, no `--deactivate` — the
 * plugin is already inactive, so passing it would just draw a WP-CLI warning) starts a fresh PHP
 * process that never loads the plugin at all, so its guard passes and cleanup actually runs.
 *
 * Two removal intents are deliberately separated: idempotent CLEANUP for Before/After
 * hooks (`ensurePluginAbsent` — already-absent ⇒ no-op) vs. asserted REMOVAL-UNDER-TEST
 * (`uninstallPlugin` — absent-when-expected ⇒ failure). `wp plugin uninstall` exits non-zero for
 * both "not found" and a real failure, so its exit code is not trusted.
 *
 * **"Absent" means nothing at the plugin's path**, never "WordPress lists no plugin there" — which is
 * all `is-installed` can say. A removal stopped part-way leaves part of a folder WordPress no longer
 * lists, which blocks every later install (see ./plugin-dir.ts), so both intents judge removal by the
 * path. Cleanup heals: it removes what is left by path and returns it for the hooks to report.
 * Removal under test judges: it fails on what is left, and leaves it for the cleanup after it.
 */

/** True if the plugin is installed (regardless of active state). */
export async function isPluginInstalled(
  transport: Transport,
  slug: string,
): Promise<boolean> {
  const { exitCode } = await wpCli(transport, ["plugin", "is-installed", slug]);
  return exitCode === 0;
}

/** True if the plugin is installed AND active. */
export async function isPluginActive(
  transport: Transport,
  slug: string,
): Promise<boolean> {
  const { exitCode } = await wpCli(transport, ["plugin", "is-active", slug]);
  return exitCode === 0;
}

/** How {@link ensurePluginDeactivated} deactivates a plugin a plain deactivation leaves active. */
export interface DeactivationOptions {
  /**
   * The product's own forced deactivation (`ProductConfig.forceDeactivate`), tried once a plain
   * `wp plugin deactivate` has left the plugin active; the state is read back after it either way.
   */
  readonly forceDeactivate?: ForceDeactivate | undefined;
}

/**
 * What {@link ensurePluginDeactivated} found and did: `inactive` — nothing to do; `deactivated` — a
 * plain `wp plugin deactivate` took; `forced` — that left it active (`plainSaid`, from
 * {@link stillActiveAfter}) and the product's {@link DeactivationOptions.forceDeactivate} deactivated
 * it (`forceError`: what the force threw, when it threw yet the plugin is inactive all the same).
 */
export type DeactivationOutcome =
  | { readonly kind: "inactive" | "deactivated" }
  | {
      readonly kind: "forced";
      readonly plainSaid: string;
      readonly forceError?: string;
    };

/**
 * What a plain `wp plugin deactivate` that left the plugin active did, in words. Pure. Exit 0 is
 * said as such — a hook stopping the deactivation before WordPress saved it, most likely, but not
 * read —; any other exit with its first error line ({@link firstError}), masked and plain.
 *
 * @param result - the plain deactivation's result.
 */
export function stillActiveAfter(result: ExecResult): string {
  if (result.exitCode === 0) {
    return "`wp plugin deactivate` exited 0 but left it active";
  }
  return `\`wp plugin deactivate\` failed (exit ${String(result.exitCode)}: ${printableFirstError(result)})`;
}

/**
 * {@link firstError}, masked before it is cut and made one plain line: a deactivation's output is the
 * site's, and lands in reports.
 *
 * @param result - a command's result.
 */
function printableFirstError(result: ExecResult): string {
  return plain(
    firstError({
      ...result,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
    }),
  );
}

/**
 * A plain `wp plugin deactivate`, its effect read back (never its exit code: a plugin refusing from
 * its own deactivation hook can still exit 0). For a caller that already knows the plugin is active.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 * @returns `undefined` once it is inactive, else what the deactivation did ({@link stillActiveAfter}).
 * @throws Error if a command could not run.
 */
export async function deactivatePlainly(
  transport: Transport,
  slug: string,
): Promise<string | undefined> {
  const result = await wpCli(transport, ["plugin", "deactivate", slug]);
  if (!(await isPluginActive(transport, slug))) return undefined;
  return stillActiveAfter(result);
}

/**
 * Runs a product's forced deactivation, catching what it throws: whether it took is read back by
 * the caller, since a force may throw after deactivating.
 *
 * @param force - the product's forced deactivation.
 * @param transport - the site.
 * @param slug - the plugin's slug.
 * @returns what it threw, masked and plain; `undefined` when it did not.
 */
export async function tryForceDeactivate(
  force: ForceDeactivate,
  transport: Transport,
  slug: string,
): Promise<string | undefined> {
  try {
    await force(transport, slug);
    return undefined;
  } catch (error) {
    return plain(redactSecrets(errorMessage(error)));
  }
}

/**
 * CLEANUP (idempotent). Deactivates the plugin if it's active, then no-ops — nothing left to do.
 * Always its own WP-CLI call, kept separate from uninstall — see the module doc for why.
 *
 * A plain deactivation a plugin refuses from its own deactivation hook still exits 0 (WP Rocket with
 * an unwritable `wp-config.php`: its hook `die()`s before WordPress saves `active_plugins`), so the
 * state is read back, never the exit code ({@link deactivatePlainly}). Then the product's
 * `forceDeactivate`, when given, and the state read back again. It never goes further: taking a plugin
 * off `active_plugins` without loading it skips its deactivation hook, which removal under test must
 * not hide — {@link ensurePluginAbsent} alone does that, as its last resort.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 * @param options - the product's forced deactivation, if it has one.
 * @returns what it found and did.
 * @throws {@link PluginDeactivationFailedError} if the plugin is still active, saying what the plain
 * deactivation did (and what the force threw); Error if a command could not run.
 */
export async function ensurePluginDeactivated(
  transport: Transport,
  slug: string,
  options: DeactivationOptions = {},
): Promise<DeactivationOutcome> {
  if (!(await isPluginActive(transport, slug))) return { kind: "inactive" };
  const plainSaid = await deactivatePlainly(transport, slug);
  if (plainSaid === undefined) return { kind: "deactivated" };
  const force = options.forceDeactivate;
  if (force === undefined) {
    throw new PluginDeactivationFailedError(slug, plainSaid);
  }
  const forceError = await tryForceDeactivate(force, transport, slug);
  if (!(await isPluginActive(transport, slug))) {
    return forceError === undefined
      ? { kind: "forced", plainSaid }
      : { kind: "forced", plainSaid, forceError };
  }
  throw new PluginDeactivationFailedError(
    slug,
    `${plainSaid}; its product's forced deactivation left it active too` +
      (forceError === undefined ? "" : ` (it failed: ${forceError})`),
  );
}

/**
 * A deactivation {@link ensurePluginAbsent} had to recover, for the caller to report:
 *
 *  - `forced` — a plain `wp plugin deactivate` left the plugin active; the product's forced
 *    deactivation deactivated it ({@link DeactivationOutcome});
 *  - `unloaded` — that was not enough (`refusal`: what {@link ensurePluginDeactivated} said), so the
 *    plugin was taken off `active_plugins` with no plugin loaded: its deactivation hook never ran, and
 *    whatever that hook undoes (a `wp-config.php` constant, an `.htaccess` block) is left as it is.
 */
export type DeactivationRecovery =
  | Extract<DeactivationOutcome, { readonly kind: "forced" }>
  | { readonly kind: "unloaded"; readonly refusal: string };

/**
 * One sentence on a recovered deactivation, without a prefix: the caller says where and when. Pure,
 * so its wording is pinned without a site.
 *
 * @param slug - the plugin's slug.
 * @param recovery - what had to be done.
 */
export function deactivationRecoveryMessage(
  slug: string,
  recovery: DeactivationRecovery,
): string {
  if (recovery.kind === "unloaded") {
    return (
      `"${slug}" would not deactivate (${recovery.refusal}), so it was taken off active_plugins ` +
      "without loading it (`wp --skip-plugins plugin deactivate`): its deactivation hook never ran, " +
      "and what that hook undoes on the site is left as it is."
    );
  }
  return (
    `"${slug}" stayed active (${recovery.plainSaid}), so its product's forced deactivation ran and ` +
    "deactivated it" +
    (recovery.forceError === undefined
      ? "."
      : `, though it reported a failure: ${recovery.forceError}`)
  );
}

/**
 * Says a deactivation was recovered when no caller asked to be told: a warning, never silence.
 *
 * @param slug - the plugin's slug.
 * @param recovery - what had to be done.
 */
function warnRecovered(slug: string, recovery: DeactivationRecovery): void {
  console.warn(`[wp/plugin] ${deactivationRecoveryMessage(slug, recovery)}`);
}

/** What {@link ensurePluginAbsent} uses to deactivate, and whom it tells when it had to recover. */
export interface RemovalOptions extends DeactivationOptions {
  /**
   * Told of each recovered deactivation ({@link DeactivationRecovery}), awaited; a `[wp/plugin]`
   * warning when omitted.
   */
  readonly onRecovered?:
    ((recovery: DeactivationRecovery) => void | Promise<void>) | undefined;
}

/**
 * Deactivates a plugin about to be uninstalled, whatever it takes: {@link ensurePluginDeactivated}
 * (plain, then the product's force), then, as the last resort, {@link deactivateUnloaded}. Reports
 * each recovery it needed.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 * @param options - the force, and whom to tell.
 * @throws {@link PluginDeactivationFailedError} if even the last resort leaves it active; Error if a
 * command could not run.
 */
async function deactivateForRemoval(
  transport: Transport,
  slug: string,
  options: RemovalOptions,
): Promise<void> {
  const report =
    options.onRecovered ??
    ((recovery: DeactivationRecovery): void => {
      warnRecovered(slug, recovery);
    });
  let outcome: DeactivationOutcome;
  try {
    outcome = await ensurePluginDeactivated(transport, slug, options);
  } catch (error) {
    if (!(error instanceof PluginDeactivationFailedError)) throw error;
    const refusal = error.reason ?? "still active";
    await deactivateUnloaded(
      transport,
      slug,
      `${refusal}; still active after \`wp --skip-plugins plugin deactivate\``,
    );
    await report({ kind: "unloaded", refusal });
    return;
  }
  if (outcome.kind === "forced") await report(outcome);
}

/**
 * What {@link ensurePluginAbsent} had to clear by path, for the hooks to report — and how it came to
 * be there, since each has its own likely cause:
 *
 *  - `unlisted` — WordPress listed no plugin there to begin with: part of a plugin an earlier removal
 *    stopped part-way left;
 *  - `uninstall-left` — WordPress's uninstall ran and no longer lists a plugin there, but left part of
 *    the folder behind;
 *  - `uninstall-failed` — WordPress still listed the plugin after its uninstall, which failed with
 *    `uninstallError` (its first error line).
 */
export type ClearedPluginDir =
  | {
      /** What was at the plugin's path, as found just before it was removed. */
      readonly dir: PresentPluginDir;
      readonly cause: "unlisted" | "uninstall-left";
    }
  | {
      /** What was at the plugin's path, as found just before it was removed. */
      readonly dir: PresentPluginDir;
      readonly cause: "uninstall-failed";
      /** Why WordPress's own uninstall failed: its first error line. */
      readonly uninstallError: string;
    };

/**
 * CLEANUP (idempotent). For Before/After hooks: removes the plugin so its files and its database
 * footprint are gone, leaving a clean baseline. Already-absent is success.
 *
 * Decided by what is at the plugin's path ({@link inspectPluginDir}), never by `is-installed`, and in
 * that order, so a plugin WordPress lists is never removed by path before its uninstall was tried:
 *
 *  - **a plugin WordPress lists** is deactivated and uninstalled through WordPress, so its own cleanup
 *    runs. A deactivation it refuses is recovered ({@link deactivateForRemoval}: the product's force,
 *    then, last, off `active_plugins` unloaded) and reported. When that uninstall fails — a half-removed copy whose `uninstall.php` cannot load what it
 *    needs — the plugin is first taken off `active_plugins` without loading it
 *    ({@link deactivateUnloaded}: such a copy cannot boot, so the ordinary deactivation never saw it
 *    active), then its folder is removed by path, and the caller's database sweep takes the footprint
 *    the uninstall could not. Left active, the next `install --activate` would find it "already
 *    active" and never run its activation (measured);
 *  - **a folder WordPress does not list** — part of a plugin a removal stopped part-way left, or what
 *    its uninstall just left — is removed by path ({@link removePluginDir}).
 *
 * A clean site pays one read.
 *
 * **The object-cache flush runs even when there was nothing to uninstall**, which is the one place
 * this function is not a no-op on an already-absent plugin. The point of the flush is that "absent"
 * should mean absent *to WordPress*, and the state that can outlive a removal was not necessarily
 * written by the removal this call performed — a run that was killed between uninstall and teardown
 * leaves exactly that. Skipping it on the cheap path would make the baseline depend on which
 * previous run happened to end tidily. It is best-effort and cannot fail this call — see
 * {@link flushObjectCache}, which also explains why it is a no-op on a cell with no persistent
 * cache, as ours are expected to be.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin's slug.
 * @param options - the product's forced deactivation, and whom to tell of a recovered deactivation
 * (a warning by default).
 * @returns what had to be removed by path, or `undefined` when nothing was there or WordPress's own
 * uninstall removed it all.
 * @throws {@link PluginDeactivationFailedError} if a listed plugin will not deactivate, even unloaded —
 * before its uninstall, or after a failed one; Error if the slug is not one path segment, the folder cannot be
 * inspected, or removal by path refuses it (outside the root, or a listed plugin whose uninstall was
 * never tried — one that appeared meanwhile); `PluginDirRemovalFailedError` if what is left cannot be
 * removed by path.
 */
export async function ensurePluginAbsent(
  transport: Transport,
  slug: string,
  options: RemovalOptions = {},
): Promise<ClearedPluginDir | undefined> {
  let found = await inspectPluginDir(transport, slug);
  let cause: "unlisted" | "uninstall-left" = "unlisted";
  let uninstallError: string | undefined;
  if (found.kind === "recognised") {
    // Deactivate first, as its own WP-CLI call — see the module doc for why `uninstall
    // --deactivate` can't be trusted to run the plugin's cleanup.
    await deactivateForRemoval(transport, slug, options);
    // Fires the uninstall procedure (DB cleanup) and deletes the files; exit code is ambiguous,
    // so what is left is read again below.
    const uninstall = await wpCli(transport, ["plugin", "uninstall", slug]);
    found = await inspectPluginDir(transport, slug);
    cause = "uninstall-left";
    if (found.kind === "recognised") {
      uninstallError = firstError(uninstall);
      // While WP-CLI still sees the plugin: once its folder is gone, it can no longer deactivate it.
      await deactivateUnloaded(
        transport,
        slug,
        "still active after `wp --skip-plugins plugin deactivate`, with its uninstall failed",
      );
    }
  }
  let cleared: ClearedPluginDir | undefined;
  if (found.kind !== "absent") {
    const dir = await removePluginDir(transport, slug, {
      recognised: uninstallError !== undefined,
    });
    if (dir !== undefined) {
      cleared =
        uninstallError === undefined
          ? { dir, cause }
          : { dir, cause: "uninstall-failed", uninstallError };
    }
  }
  await flushObjectCache(transport);
  return cleared;
}

/**
 * Takes a plugin off `active_plugins` with **no plugin loaded** (`--skip-plugins`), and verifies it.
 *
 * Never the ordinary deactivation: an unloaded plugin's deactivation hook cannot run. For two cases
 * only: a copy whose uninstall failed — one that cannot boot makes `wp plugin is-active` die on its
 * own fatal and exit 1, read as "inactive" (measured), so {@link ensurePluginDeactivated} never
 * deactivated it —, and the last resort for a plugin whose deactivation refuses even its product's
 * force ({@link deactivateForRemoval}).
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin's slug.
 * @param stillActive - the error's reason when it is still active afterwards.
 * @throws {@link PluginDeactivationFailedError} if it is still active, or that cannot be told.
 */
async function deactivateUnloaded(
  transport: Transport,
  slug: string,
  stillActive: string,
): Promise<void> {
  await wpCli(transport, ["--skip-plugins", "plugin", "deactivate", slug]);
  const { exitCode } = await wpCli(transport, [
    "--skip-plugins",
    "plugin",
    "is-active",
    slug,
  ]);
  // `is-active` exits 1 for "not active"; anything else is "active" (0) or no answer at all.
  if (exitCode === 1) return;
  throw new PluginDeactivationFailedError(
    slug,
    exitCode === 0
      ? stillActive
      : `whether it is still active could not be read (\`wp --skip-plugins plugin is-active\` exit ${String(exitCode)})`,
  );
}

/**
 * Whether a slug can be named in `--skip-plugins=<slug>`: one path segment, and no comma, which
 * WP-CLI reads as a list — `a,b` would skip a plugin that is not this one.
 *
 * @param slug - the plugin's slug.
 */
export function isSkippableSlug(slug: string): boolean {
  return isPathSegment(slug) && !slug.includes(",");
}

/**
 * Why WordPress cannot boot with this plugin loaded, when it boots without it — the shape a removal
 * cut short leaves (main file kept, part of `vendor` gone): every request that loads it dies.
 * Asked only once something has failed: a boot that loads such a copy writes its fatal to
 * `debug.log`.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 * @returns the line the boot died on (or the signal that killed it), or `undefined` when the plugin is
 * not what stops WordPress booting (it boots with it, or not even without it — a crash counts), or the
 * slug cannot be skipped alone.
 * @throws Error when a command could not be run at all.
 */
export async function pluginBreaksBoot(
  transport: Transport,
  slug: string,
): Promise<string | undefined> {
  if (!isSkippableSlug(slug)) return undefined;
  const without = await bootFailure(transport, [`--skip-plugins=${slug}`]);
  if (without !== undefined) return undefined;
  return bootFailure(transport, []);
}

/**
 * Why a no-op `wp eval` could not boot WordPress, a crash included: PHP killed by a signal (a
 * segfault, the kernel's OOM kill) fails the boot just as a fatal does.
 *
 * @param transport - the site.
 * @param options - WP-CLI's global options before `eval`, e.g. `--skip-plugins=<slug>`.
 * @returns `undefined` when it booted; else the line it died on, or the signal's message (which
 * names no argument).
 * @throws Error when the command could not be run at all.
 */
async function bootFailure(
  transport: Transport,
  options: readonly string[],
): Promise<string | undefined> {
  try {
    const result = await wpCli(transport, [...options, "eval", "echo 1;"]);
    return result.exitCode === 0 ? undefined : firstError(result);
  } catch (error) {
    if (error instanceof CommandKilledError) return error.message;
    throw error;
  }
}

/**
 * The line that says why a WP-CLI command failed: its first PHP fatal or `Error:`, else its first
 * line of output — bounded, since a fatal carries a stack trace.
 *
 * @param result - the failed command's result.
 */
export function firstError(result: ExecResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const line =
    lines.find((candidate) => /Fatal error|^Error:/.test(candidate)) ??
    lines[0] ??
    `exit ${String(result.exitCode)}, no output`;
  return line.length > 300 ? `${line.slice(0, 300)}…` : line;
}

/**
 * UNINSTALL UNDER TEST. For scenarios that verify the uninstall flow: the plugin must be one
 * WordPress lists first (throws {@link PluginNotInstalledError} otherwise, naming what is at its path
 * when something is), then deactivated (its own WP-CLI
 * call — see the module doc for why) and uninstalled — running its uninstall procedure and
 * deleting its files — and removal is re-asserted by path: anything left there throws
 * {@link PluginUninstallFailedError} naming it, and is left for cleanup — never swept here.
 */
export async function uninstallPlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (!(await isPluginInstalled(transport, slug))) {
    throw new PluginNotInstalledError(slug, await whatIsAt(transport, slug));
  }
  await ensurePluginDeactivated(transport, slug);
  await wpCli(transport, ["plugin", "uninstall", slug]);
  const left = await inspectPluginDir(transport, slug);
  if (left.kind !== "absent") {
    throw new PluginUninstallFailedError(slug, describePluginDir(left));
  }
}

/**
 * What is at a plugin's path, described, for an error that would otherwise call it absent —
 * `undefined` when nothing is. Never throws: the caller's error is the verdict, and this only
 * sharpens it.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 */
async function whatIsAt(
  transport: Transport,
  slug: string,
): Promise<string | undefined> {
  try {
    const at = await inspectPluginDir(transport, slug);
    return at.kind === "absent" ? undefined : describePluginDir(at);
  } catch (error) {
    return `its path could not be inspected (${errorMessage(error)})`;
  }
}

/** Options for {@link installPlugin}. */
export interface InstallPluginOptions {
  /** Activate immediately after install. */
  readonly activate?: boolean;
  /** Reinstall/overwrite if already present (`--force`). */
  readonly force?: boolean;
}

/**
 * Installs a plugin from a source (slug, local zip path, or URL).
 *
 * @throws {@link PluginDestinationExistsError} when a folder is already at the plugin's path, saying
 * whether WordPress lists a plugin there; {@link PluginDestinationBlockedError} when WordPress could
 * not create the plugin's folder because something that is no folder — a file, a dangling link — is
 * at that path; else Error on any other non-zero exit.
 */
export async function installPlugin(
  transport: Transport,
  source: string,
  options: InstallPluginOptions = {},
): Promise<void> {
  const args = ["plugin", "install", source];
  if (options.force) args.push("--force");
  if (options.activate) args.push("--activate");
  const { exitCode, stdout, stderr } = await wpCli(transport, args);
  if (exitCode === 0) return;
  const output = `${stderr}\n${stdout}`;
  const destination = existingDestination(output);
  if (destination !== undefined) {
    throw new PluginDestinationExistsError(
      destination,
      await destinationVerdict(transport, destination),
    );
  }
  const blocked = uncreatedDestination(output);
  const found =
    blocked === undefined ? undefined : await blockerAt(transport, blocked);
  if (blocked !== undefined && found !== undefined) {
    throw new PluginDestinationBlockedError(blocked, describePluginDir(found));
  }
  throw new Error(
    `[wp/plugin] install "${source}" failed (exit ${String(exitCode)}): ${stderr.trim()}`,
  );
}

/**
 * The folder WordPress's installer refused to overwrite, from its own words —
 * `Destination folder already exists. "<path>"` — or `undefined` when the output says nothing of it.
 *
 * @param output - the install's standard error and output.
 */
export function existingDestination(output: string): string | undefined {
  return /Destination folder already exists\.\s*"([^"]+)"/.exec(output)?.[1];
}

/**
 * The folder WordPress's installer could not create, from its own words —
 * `Could not create directory. "<path>"` — or `undefined` when the output says nothing of it. WordPress
 * takes only a folder for one in the way (`is_dir`), so a file or a dangling link at the plugin's path
 * ends here, not on "Destination folder already exists" (measured: WP-CLI exit 1, that warning on
 * standard error). So does a plugins folder it may not write in, with nothing at the path.
 *
 * @param output - the install's standard error and output.
 */
export function uncreatedDestination(output: string): string | undefined {
  return /Could not create directory\.\s*"([^"]+)"/.exec(output)?.[1];
}

/**
 * What stands at the plugin's own path when WordPress could not create its folder — `undefined` when
 * nothing does, the path is not `WP_PLUGIN_DIR/<slug>` itself (a folder deeper in the copy), or it
 * cannot be inspected. Never throws: the install's failure is the verdict, and this only sharpens it.
 *
 * @param transport - the site.
 * @param destination - the folder, as WP-CLI named it.
 */
async function blockerAt(
  transport: Transport,
  destination: string,
): Promise<PresentPluginDir | undefined> {
  const path = destination.replace(/\/+$/, "");
  const slug = posix.basename(path);
  if (!isPathSegment(slug)) return undefined;
  try {
    const found = await inspectPluginDir(transport, slug);
    return found.kind !== "absent" && found.path === path ? found : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether WordPress lists a plugin in the folder an install refused — read only on that failure.
 * Never throws: the install's failure is what the caller reports, and this only sharpens it.
 *
 * @param transport - the site.
 * @param destination - the folder, as WP-CLI named it.
 */
async function destinationVerdict(
  transport: Transport,
  destination: string,
): Promise<DestinationVerdict> {
  const slug = posix.basename(destination);
  if (!isPathSegment(slug)) return "unknown";
  try {
    return (await inspectPluginDir(transport, slug)).kind;
  } catch {
    return "unknown";
  }
}

/** Activates an installed plugin. Throws on a non-zero exit. */
export async function activatePlugin(
  transport: Transport,
  slug: string,
): Promise<void> {
  const { exitCode, stderr } = await wpCli(transport, [
    "plugin",
    "activate",
    slug,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/plugin] activate "${slug}" failed (exit ${String(exitCode)}): ${stderr.trim()}`,
    );
  }
}
