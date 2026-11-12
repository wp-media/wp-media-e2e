import {
  DebugLogFatalError,
  PluginActivationFailedError,
  PluginUninstallBrokenError,
  SiteResidueRemovalFailedError,
} from "../wp/errors";
import { isEmptyDbResidue, removeSiteDbResidue } from "../wp/db-residue";
import { clearDebugLog, scanDebugLog } from "../wp/log";
import {
  ensurePluginAbsent,
  isPluginActive,
  pluginBreaksBoot,
} from "../wp/plugin";
import { describePluginDir } from "../wp/plugin-dir";
import {
  prepareResolvedDataDirs,
  prepareSiteDataDirs,
  removeSiteResidue,
} from "../wp/residue";
import { pluginSitePath } from "../wp/paths";
import {
  recordInstallOutputs,
  settleInstallOutputs,
} from "../wp/install-outputs";
import { stageAndInstallPlugin } from "../wp/staging";
import {
  getInstallOutputs,
  getSiteDataDirResolver,
  getSiteDbResidue,
  getSiteResidue,
  getStopRunningWork,
} from "../config/metadata";
import { withinBudget } from "../deadline";
import { errorMessage } from "../guards";
import type { ScanDebugLogOptions } from "../wp/log";
import type { ClearedPluginDir } from "../wp/plugin";
import type { FoundDbResidue, SiteDbResidue } from "../wp/db-residue";
import type { TestInfo } from "@playwright/test";
import type { ResolvedArtifact } from "../artifacts/types";
import type {
  ResolveSiteDataDirs,
  SiteResidue,
  StopRunningWork,
  Transport,
} from "../config/types";

/**
 * The policy behind the {@link PLUGIN_TAG} scenario hooks: what "a freshly installed plugin under
 * test, and a verdict on what PHP logged" actually means. Split out from `./plugin.hooks.ts` so
 * it is unit-testable against a stub `wp`, leaving that file a thin binding to the BDD runtime.
 *
 * Two operations, mirroring the hook pair:
 *  - {@link installPluginUnderTest} — scope the log, stop what an earlier run left running, guarantee
 *    a clean baseline, install.
 *  - {@link teardownPluginUnderTest} — judge what PHP wrote, then restore the baseline: stop what the
 *    plugin is still doing, remove it *and* the data it left behind, on disk and in the database.
 */

/**
 * What one product leaves on a site, in the two places a plugin's own uninstall does not reach.
 *
 * Grouped because the hooks always carry both and neither means much alone: `files` is what the
 * uninstall *deliberately* keeps (a user's backups are not the installer's to delete), `db` is what
 * it would have removed had it been able to run at all. Passing them as one value also keeps the
 * teardown's parameter list readable, which two more positional lists would not.
 */
export interface DeclaredResidue {
  /** Paths relative to the WordPress root, or families of directories — `ProductConfig.siteResidue`. */
  readonly files: readonly SiteResidue[];
  /** The database footprint — `ProductConfig.siteDbResidue`. */
  readonly db: SiteDbResidue;
  /**
   * How to ask the installed plugin for the data directories it names at runtime —
   * `ProductConfig.resolveSiteDataDirs`.
   */
  readonly resolveDataDirs?: ResolveSiteDataDirs | undefined;
  /**
   * What activation writes outside the plugin's folder, validated — `ProductConfig.installOutputs`.
   * Not leftovers to remove: the outputs the install hands over when it created them.
   */
  readonly installOutputs?: readonly string[] | undefined;
}

/** A product that declares neither kind of leftover; every step below then costs nothing. */
const NO_RESIDUE: DeclaredResidue = { files: [], db: {} };

/**
 * What a product says it leaves on a site — paths on disk, rows in the database — from the
 * per-process registries the config factory filled. One reading for the `@plugin` hooks and for any
 * step that reinstalls on their behalf, so the two can never sweep different things.
 *
 * @param product - the product under test, from the project's routing metadata.
 */
export function declaredResidue(product: string): DeclaredResidue {
  return {
    files: getSiteResidue(product),
    db: getSiteDbResidue(product),
    resolveDataDirs: getSiteDataDirResolver(product),
    installOutputs: getInstallOutputs(product),
  };
}

/**
 * Tag that opts a scenario into the plugin lifecycle: the artifact under test is installed and
 * activated before it runs, `debug.log` is scoped to it and checked afterwards, and the plugin is
 * removed again. Opt-in rather than automatic, because scenarios that assert on a site *without*
 * the plugin (or need no site at all) must not pay for an install.
 */
export const PLUGIN_TAG = "@plugin";

/**
 * Budget for one hook's worth of WP-CLI round-trips and file transfer. Generous because the work is
 * remote. Measured per phase against an SSH-hosted staging box, installing a 9.2 MB / 5822-file
 * plugin: clear ~1.5 s, remove-when-absent ~1.5 s, upload ~4.5 s, install+activate ~3.5 s,
 * re-assert ~2 s ⇒ **Before ≈ 13 s**; scan ~2 s, remove-when-present ~10 s ⇒ **After ≈ 12 s**.
 * A plugin whose uninstall procedure does more, a slower link, or a busier host multiply those, so
 * the budget keeps room for roughly a 4–5× worse environment before it fires.
 *
 * Later additions widen that, and no longer marginally. Re-measured against the same box with
 * BackWPup's two declared data paths: **preparation ≈ 15 s** — per path a symlink probe, `mkdir`,
 * `chmod`, then the ownership handover's own probe, `chmod -R`, `chown -R` and verifying re-read —
 * and the plugin's own handover ≈ 1.8 s once the plan is cached. So **Before ≈ 30 s** on that link.
 * With a third declared path and the directory the installed plugin names at runtime (one `wp eval`
 * to ask, then prepared like the others), measured over three rounds on `pro@nginx`: **Before
 * 44–50 s, After ≈ 23 s** — about 2.4× inside this budget, where the breakdown above had 4–5×. The
 * cost is round-trips rather than work: a product declaring many data paths pays linearly, and
 * batching the paths into single commands is the lever when the margin needs widening.
 *
 * The leftover-files sweep pulls that lever, because what it **finds** is not bounded by any
 * declaration: a family of runtime-named directories piles up wherever an earlier build or a killed
 * run left them. Removing them one by one cost ~6 round-trips each (~0.8 s apiece, measured), and 28
 * of them took a teardown past this budget. Now the sweep's commands are the same for one leftover
 * as for thirty — the root resolved once, a family checked through its parent, one `rm` per pass.
 *
 * The leftover-footprint sweep adds **one `wp eval` per hook** on the ordinary path — a product that
 * declares one stops after the scan that finds nothing, and one that declares none pays no
 * round-trip at all. Only a site that really is carrying a footprint pays the removal and the
 * verifying re-read, which is exactly the run that has time to spare.
 *
 * Stopping the product's running work adds **one more `wp eval` to each hook** on an idle site.
 * One that has to act is bounded by its own budgets — about 70 s at the very worst for BackWPup —
 * which the After hook's ≈ 23 s leaves room for here. The Before hook's install does not (44–73 s
 * measured, 73 s beside another run on the same server), so it gets {@link LEFT_WORK_ALLOWANCE_MS}
 * on top of this.
 *
 * Applied per hook — so a hang is reported as a hook timeout naming the hook, rather than as an
 * opaque scenario timeout — **and** added to the scenario's own budget by {@link extendedTimeout},
 * since Playwright times a scenario and its hooks against one clock. The trade-off of raising it
 * is how long a genuinely stuck scenario takes to fail: a default 30 s scenario becomes 30 s plus
 * both hooks' budgets.
 */
export const HOOK_TIMEOUT_MS = 120_000;

/**
 * Room the Before hook gets, on top of {@link HOOK_TIMEOUT_MS}, for stopping work a killed run left
 * running before it installs — **the bound every `ProductConfig.stopRunningWork` must finish
 * within.**
 *
 * The teardown normally leaves nothing running, so this is spent only by the run that recovers a
 * killed one. Sized from BackWPup's stop, the one product that declares a stop: 30 s for a running
 * job to go and 30 s for its run to record its end, plus a few probes of ~1.3 s each, is about 70 s
 * at worst; 90 s keeps a margin for a slow link. Without it, that worst case beside the install
 * measured above would overrun the hook, and a timed-out hook is abandoned rather than cancelled —
 * its install would go on beside the teardown.
 */
export const LEFT_WORK_ALLOWANCE_MS = 90_000;

/** The Before hook's budget: an install, plus stopping what a killed run left running. */
export const BEFORE_HOOK_TIMEOUT_MS = HOOK_TIMEOUT_MS + LEFT_WORK_ALLOWANCE_MS;

/**
 * Cap on the `debug.log` body attached to a report, in characters. A fatal inside a loop, or one
 * raised by a hook that fires per row, turns a scenario's log into megabytes; attaching that to
 * every failing scenario bloats reports and CI artifact uploads for no diagnostic gain. ~256k
 * characters is thousands of lines — far more than anyone reads.
 */
export const MAX_ATTACHED_LOG_CHARS = 256 * 1024;

/**
 * Bounds a log for attachment, keeping the **start**: the first occurrence is the root cause, and
 * everything after a repeating fatal is that same line again. A truncated body says so and gives
 * both sizes, so nobody mistakes it for the whole log.
 *
 * Counted in characters, not bytes — a plain `.length` check, which for a PHP error log is
 * effectively the same thing and never needs the log encoded twice just to measure it.
 */
export function boundLogForAttachment(raw: string): string {
  if (raw.length <= MAX_ATTACHED_LOG_CHARS) return raw;
  return (
    `${raw.slice(0, MAX_ATTACHED_LOG_CHARS)}\n\n` +
    `[truncated by the test suite: first ${String(MAX_ATTACHED_LOG_CHARS)} of ` +
    `${String(raw.length)} characters; the rest is not retained]\n`
  );
}

/**
 * The scenario timeout a {@link PLUGIN_TAG} scenario needs: its own budget plus room for both
 * lifecycle hooks — {@link BEFORE_HOOK_TIMEOUT_MS} and {@link HOOK_TIMEOUT_MS}. Additive on purpose:
 * a scenario that asked for more time (a slow backup job) keeps every millisecond it asked for.
 *
 * @param current - the scenario's effective timeout, `testInfo.timeout`.
 * @returns the extended timeout, or `0` unchanged — zero means "no timeout" in Playwright, so
 * adding to it would silently impose one.
 */
export function extendedTimeout(current: number): number {
  return current === 0 ? 0 : current + BEFORE_HOOK_TIMEOUT_MS + HOOK_TIMEOUT_MS;
}

/**
 * Prepares a site for a scenario that tests a plugin: clears `debug.log`, stops any work an earlier
 * run left the plugin doing, removes any existing copy of the plugin — part of one WordPress no longer
 * lists included, reported when found — then installs and activates the resolved artifact.
 *
 * The order is deliberate. Clearing **first** scopes the log to this scenario yet still captures
 * anything the stop and the removal trigger — a fatal in the outgoing plugin's uninstall procedure is
 * a real defect and must not be cleared away. The one exception is an uninstall that fails outright:
 * its copy is removed by path and reported (`leftover-plugin-files`), and its fatal — what an earlier
 * run left behind, not this scenario's doing — is cleared with it; that run's teardown failed on it
 * already. Removing before installing is what makes the
 * install *fresh*: `ensurePluginAbsent` runs that uninstall procedure, so leftover options and
 * tables from an earlier (or crashed) run cannot leak into this scenario's assertions.
 *
 * Stopping comes before that removal for the reason the teardown stops first: uninstalling a plugin
 * underneath its own running work races it. The teardown normally leaves nothing running, but a run
 * that was killed never reached its teardown, and the job it started goes on in a web request of
 * its own — so this is what makes recovering from a kill complete. On a site where the plugin is not
 * there, or idle, it costs the product's one probe.
 *
 * Between the removal and the install sits the one step that copes with a site the removal could
 * not clean: the plugin's **database footprint**, swept off what is actually there rather than off
 * whether the plugin is installed. A site whose plugin directory has gone while its rows remain has
 * no uninstall left for `ensurePluginAbsent` to run — nor does one whose uninstall failed and whose
 * folder it removed by path — and the install would land on top of a previous run's state — see {@link removeSiteDbResidue} for what that costs. It runs
 * *after* the removal on purpose: a still-installed plugin re-creates its own rows on the next
 * request, so sweeping before that point would achieve nothing.
 *
 * The install is followed by an explicit **is-it-active?** check rather than trusting
 * `wp plugin install --activate` to fail loudly, mirroring the discipline the removal path already
 * applies to WP-CLI's ambiguous exit codes. It is also the one assertion that catches an archive
 * installing under a different directory than the slug the artifact promised: every tagged
 * scenario assumes an *active* plugin at that slug, and without this check a silent
 * non-activation would surface much later as a baffling UI failure.
 *
 * What activation writes **outside** the plugin's folder (`installOutputs`) is checked once before
 * the install and once after that re-assert; only what the install created is handed over, or
 * verified as the identity's in the `site` state (`../wp/install-outputs.ts`).
 *
 * The install itself has the same two-user problem, one step earlier: WP-CLI unpacks the zip as
 * the *transport's* user, so the plugin's own files arrive owned by someone the web server is not,
 * and its next admin request cannot write them. Passing the artifact's `slug` is what lets the
 * install hand that directory back to the ownership the site uses — see `wp/ownership.ts`. It is
 * best-effort, so a host that cannot do it is reported rather than failing the scenario.
 *
 * Last, the plugin's own **data directories are opened to both users** that share this site's
 * docroot. On a real cell WP-CLI and the web server are different users, and whichever of them
 * creates one of those directories first would otherwise lock the other out of it — see
 * {@link prepareSiteDataDirs} for the fatal that caused. That covers the declared directories and
 * those the installed plugin names at runtime, asked of it first (`resolveDataDirs`) and prepared
 * the same way ({@link prepareResolvedDataDirs}).
 *
 * @param transport - the target site's transport.
 * @param artifact - the resolved artifact under test. Its `slug` addresses the plugin without
 * knowing the edition, and its `zipPath` is staged onto the site first — a runner path means
 * nothing to a remote `wp`.
 * @param residue - what this product leaves behind, on disk and in the database. Defaults to
 * neither, so a product that declares nothing pays nothing.
 * @param leftWork - how the product stops work it may still be doing on the site
 * (`ProductConfig.stopRunningWork`), and the scenario to report having had to; omitted for a
 * product that runs nothing in the background.
 * @param report - the scenario to attach a cleared plugin folder's report to; without it, the report
 * is only printed.
 * @throws Error if the artifact's slug is unusable, if work left running would not stop, if the
 * removal, the install, asking the plugin for its runtime-named directories or the directory
 * preparation fails (an undeclared one included), or {@link PluginActivationFailedError} if the
 * plugin is not active afterwards. Ownership normalisation is best-effort and never throws.
 */
export async function installPluginUnderTest(
  transport: Transport,
  artifact: ResolvedArtifact,
  residue: DeclaredResidue = NO_RESIDUE,
  leftWork?: LeftWork,
  report?: ScenarioReport,
): Promise<void> {
  // Before the first command: `stageAndInstallPlugin` validates the slug too, but by then the log
  // has been cleared and an uninstall has been attempted with it. A slug this suite cannot use is
  // our own mistake, and it should cost the site nothing.
  pluginSitePath(artifact.slug);
  await clearDebugLog(transport);
  if (leftWork !== undefined) {
    // Work that would not stop ends the install here, before anything is removed: unlike the
    // teardown, there are no duties worth running anyway — installing over work still writing to the
    // site would hand the scenario a site nobody can vouch for.
    await stopWorkLeftRunning(
      transport,
      artifact.slug,
      leftWork.stop,
      leftWork.report,
      "before",
      leftWork.budgetMs,
    );
  }
  const cleared = await removeOldCopy(transport, artifact.slug, report);
  // A copy whose uninstall failed wrote that failure to the log just cleared. It is reported above,
  // and it belongs to the run that left the copy behind — never to this scenario, which has not begun.
  if (cleared?.cause === "uninstall-failed") await clearDebugLog(transport);
  await installFresh(transport, artifact, residue);
}

/**
 * What the Before hook hands {@link installPluginUnderTest}: the product's registered stop
 * (`ProductConfig.stopRunningWork`) with the scenario to report to, or `undefined` for a product that
 * declares none — then there is nothing to ask, and no round trip to pay.
 *
 * @param product - the product under test, from the project's routing metadata.
 * @param report - the scenario's report sink.
 */
export function leftWorkOf(
  product: string,
  report: ScenarioReport,
): LeftWork | undefined {
  const stop = getStopRunningWork(product);
  return stop === undefined ? undefined : { stop, report };
}

/**
 * How a product stops its leftover work, and the scenario to report it to — see
 * {@link installPluginUnderTest}.
 */
export interface LeftWork {
  /** The product's `ProductConfig.stopRunningWork`. */
  readonly stop: StopRunningWork;
  /** The scenario whose Before hook found the work. */
  readonly report: ScenarioReport;
  /** How long the stop may take; {@link LEFT_WORK_ALLOWANCE_MS} unless a spec needs it shorter. */
  readonly budgetMs?: number;
}

/**
 * {@link installPluginUnderTest} without the log reset — for a scenario that has to reinstall the
 * plugin part-way, whose `debug.log` is still to be judged whole by the teardown. Clearing it there
 * would throw away whatever PHP logged before the reinstall, a fatal included.
 *
 * @param transport - the target site's transport.
 * @param artifact - the resolved artifact under test.
 * @param residue - what this product leaves behind, on disk and in the database.
 * @param report - the scenario to attach a cleared plugin folder's report to.
 * @throws what {@link installPluginUnderTest} throws, bar the log reset's own failures.
 */
export async function replacePluginUnderTest(
  transport: Transport,
  artifact: ResolvedArtifact,
  residue: DeclaredResidue = NO_RESIDUE,
  report?: ScenarioReport,
): Promise<void> {
  pluginSitePath(artifact.slug);
  await removeOldCopy(transport, artifact.slug, report);
  await installFresh(transport, artifact, residue);
}

/**
 * Removes whatever copy of the plugin is on the site — what is left at its path included — and
 * reports what had to go by path.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin's slug.
 * @param report - the scenario to attach the report to, when there is one.
 * @returns what was removed by path, or `undefined`.
 * @throws what {@link ensurePluginAbsent} throws.
 */
async function removeOldCopy(
  transport: Transport,
  slug: string,
  report?: ScenarioReport,
): Promise<ClearedPluginDir | undefined> {
  const cleared = await ensurePluginAbsent(transport, slug);
  await reportClearedPluginDir(cleared, "before", report);
  return cleared;
}

/**
 * The install on a site the old copy has left: sweep its database footprint, install and activate
 * the artifact, hand over (or verify) the outputs its activation created outside its folder, then
 * prepare its data directories — see {@link installPluginUnderTest}.
 *
 * @param transport - the target site's transport.
 * @param artifact - the resolved artifact under test.
 * @param residue - what this product leaves behind, on disk and in the database.
 */
async function installFresh(
  transport: Transport,
  artifact: ResolvedArtifact,
  residue: DeclaredResidue,
): Promise<void> {
  // After the old copy's removal: a plugin removed by path after its uninstall failed leaves exactly
  // the rows this sweep takes.
  await sweepDbResidue(transport, residue.db, "before");
  // Right before the install, so an output present now is the site's (or an earlier run's), never
  // this install's: only what the install creates is handed over. No command when none is declared.
  const outputsBefore = await recordInstallOutputs(
    transport,
    residue.installOutputs ?? [],
  );
  await stageAndInstallPlugin(transport, artifact.zipPath, {
    activate: true,
    slug: artifact.slug,
  });
  if (!(await isPluginActive(transport, artifact.slug))) {
    throw new PluginActivationFailedError(artifact.slug);
  }
  // Once activation is proved: it is what writes them. Best-effort, never throws, and bounded
  // (`SETTLE_BUDGET_MS`), so a slow handover cannot run the hook out of time.
  await settleInstallOutputs(transport, outputsBefore);
  // Asked of the plugin now installed, since each install names these anew — and asked before any
  // directory is handed over, because asking boots WordPress over WP-CLI, as the transport's user.
  const resolved =
    residue.resolveDataDirs === undefined
      ? []
      : await residue.resolveDataDirs(transport);
  // After the install, because a fresh install is what removes the previous scenario's copy of these
  // directories; before any scenario step, because the first writer is otherwise whoever gets there
  // first. See `prepareSiteDataDirs` for the failure this prevents.
  await prepareSiteDataDirs(transport, residue.files);
  await prepareResolvedDataDirs(transport, resolved, residue.files);
}

/**
 * The report for a plugin folder cleanup had to remove by path — what was there, and its likely cause
 * in one sentence, which depends on how it came to be there ({@link ClearedPluginDir}). Pure, so its
 * wording is pinned without a site.
 *
 * @param cleared - what {@link ensurePluginAbsent} removed by path.
 * @param when - whether the scenario is about to begin or has just ended.
 * @param title - the scenario's title, when known.
 */
export function clearedPluginDirMessage(
  cleared: ClearedPluginDir,
  when: "before" | "after",
  title?: string,
): string {
  const moment =
    title === undefined
      ? when === "before"
        ? "before installing"
        : "after the scenario"
      : `${when} "${title}"`;
  const what = describePluginDir(cleared.dir);
  const stopped =
    "a removal stopped part-way — e.g. by a PHP-FPM restart or a reboot — leaves part of a plugin";
  switch (cleared.cause) {
    case "unlisted":
      return (
        `[hooks] ${moment}, removed a plugin folder WordPress no longer lists: ${what}. Likely ` +
        `cause: ${stopped}; left there, it would have blocked every later install.`
      );
    case "uninstall-left":
      return (
        `[hooks] ${moment}, removed what the plugin's own uninstall left at its path, which WordPress ` +
        `no longer lists: ${what}. Likely cause: files the uninstall could not delete, or ${stopped}; ` +
        "left there, it would have blocked every later install."
      );
    case "uninstall-failed":
      // After the scenario, the copy is the artifact this scenario installed: its own uninstall is what
      // failed, here and now — no earlier removal is to blame.
      return when === "after"
        ? `[hooks] ${moment}, the plugin's own uninstall failed in this scenario's teardown ` +
            `(${cleared.uninstallError}), so it was removed by path: ${what}. The scenario fails on ` +
            "it; its database footprint is swept next."
        : `[hooks] ${moment}, removed a plugin whose own uninstall failed (${cleared.uninstallError}): ` +
            `${what}. Likely cause: ${stopped}, and its uninstall cannot load what is gone — that copy ` +
            "is an earlier run's, whose teardown answers for it. Its database footprint is swept next.";
    default: {
      const exhaustive: never = cleared;
      throw new Error(`unsupported cleared folder: ${String(exhaustive)}`);
    }
  }
}

/**
 * Says a plugin folder was removed by path, when one was: a warning, and an attachment on the
 * scenario. Reporting never fails — before a scenario, what is there is an earlier run's, and the one
 * about to run would otherwise inherit its failure; the teardown alone fails on a failed uninstall,
 * after this. The attachment is best-effort, like every report here.
 *
 * @param cleared - what {@link ensurePluginAbsent} removed by path; `undefined` reports nothing.
 * @param when - whether the scenario is about to begin or has just ended.
 * @param report - the scenario to name and attach to, when there is one.
 */
async function reportClearedPluginDir(
  cleared: ClearedPluginDir | undefined,
  when: "before" | "after",
  report?: ScenarioReport,
): Promise<void> {
  if (cleared === undefined) return;
  const message = clearedPluginDirMessage(cleared, when, report?.title);
  console.warn(message);
  await report
    ?.attach("leftover-plugin-files", message)
    .catch((attachError: unknown) => {
      console.warn(
        `[hooks] could not attach the leftover-plugin-files report: ${errorMessage(attachError)}`,
      );
    });
}

/**
 * Clears a leftover database footprint and says so when there was one.
 *
 * Silent on the common path — a site that was left clean has nothing to report, and a line per
 * scenario would train everyone to ignore it. When it *does* fire, something abnormal happened — to
 * an earlier run, or to this teardown's uninstall — and the counts are the evidence, so they are
 * printed rather than swallowed ({@link dbResidueMessage}).
 *
 * @param transport - the target site's transport.
 * @param db - the product's declared footprint.
 * @param when - whether the scenario is about to begin or has just ended.
 * @param uninstallFailed - whether this teardown's own uninstall of the plugin failed just before.
 * @throws whatever {@link removeSiteDbResidue} throws; the caller decides what that means.
 */
async function sweepDbResidue(
  transport: Transport,
  db: SiteDbResidue,
  when: "before" | "after",
  uninstallFailed = false,
): Promise<void> {
  const removed = await removeSiteDbResidue(transport, db);
  if (isEmptyDbResidue(removed)) return;
  console.warn(dbResidueMessage(removed, when, uninstallFailed));
}

/**
 * The line for a footprint the sweep had to clear, with how it came to be there, which depends on
 * when: before a scenario it is an earlier run's; after one, this teardown's own uninstall failed, or
 * did not take it all. Pure, so its wording is pinned without a site.
 *
 * @param removed - what the sweep removed.
 * @param when - whether the scenario is about to begin or has just ended.
 * @param uninstallFailed - whether this teardown's own uninstall of the plugin failed just before.
 */
export function dbResidueMessage(
  removed: FoundDbResidue,
  when: "before" | "after",
  uninstallFailed: boolean,
): string {
  const cause =
    when === "before"
      ? "An earlier run's plugin files were removed without its uninstall ever running."
      : uninstallFailed
        ? "The plugin's own uninstall failed in this scenario's teardown, so it could not remove them."
        : "The plugin's own uninstall did not remove them, or a request that outlived it re-created them.";
  return (
    `[hooks] ${when === "before" ? "before installing" : "after the scenario"}, cleared a leftover ` +
    `plugin footprint from the site: ${String(removed.options.length)} option(s), ` +
    `${String(removed.tables.length)} table(s)${describeRemovedRoles(removed)}. ${cause}`
  );
}

/**
 * The roles part of {@link dbResidueMessage}, empty when the sweep removed none: the roles by name,
 * and how many capabilities on which roles — a stale role is what makes a fresh install test
 * capabilities the product no longer defines, so it is named.
 *
 * @param removed - what the sweep removed.
 */
function describeRemovedRoles(removed: FoundDbResidue): string {
  const parts: string[] = [];
  if (removed.roles.length > 0) {
    parts.push(
      `${String(removed.roles.length)} role(s) (${removed.roles.join(", ")})`,
    );
  }
  if (removed.capabilities.length > 0) {
    const holders = [...new Set(removed.capabilities.map(({ role }) => role))];
    parts.push(
      `${String(removed.capabilities.length)} capability grant(s) on ${holders.join(", ")}`,
    );
  }
  return parts.map((part) => `, ${part}`).join("");
}

/**
 * Where {@link teardownPluginUnderTest} reports to — the scenario's identity, its result so far,
 * and its attachment sink. Narrowed to just these, which is what lets the gate be tested without a
 * Playwright `TestInfo`.
 */
export interface ScenarioReport {
  /** The scenario's title, so a console line names which scenario it came from under parallelism. */
  readonly title: string;
  /** Whether the scenario has already failed (then the log is attached for diagnosis either way). */
  readonly failed: boolean;
  /** Attaches a text body to the scenario's report. */
  attach(name: string, body: string): Promise<void>;
}

/**
 * Adapts Playwright's `TestInfo` to the narrow {@link ScenarioReport} the gate needs. In an `After`
 * hook (a `test.afterEach`) `status` is the scenario's outcome, so the gate can tell one that already
 * failed — and therefore wants the log attached — from a clean one. Inside a step it still reads
 * `"passed"`, Playwright's starting value, so a scenario that has not failed yet reads as not failed.
 *
 * @param testInfo - the scenario's own test info.
 */
export function scenarioReport(
  testInfo: Pick<TestInfo, "title" | "status" | "expectedStatus" | "attach">,
): ScenarioReport {
  return {
    title: testInfo.title,
    failed:
      testInfo.status !== undefined &&
      testInfo.status !== testInfo.expectedStatus,
    attach: (name, body) =>
      testInfo.attach(name, { body, contentType: "text/plain" }),
  };
}

/**
 * Closes out a plugin scenario: judge what PHP wrote to `debug.log`, stop whatever the plugin is
 * still doing, remove it, then clear the data it left behind.
 *
 * **All five duties always run, whatever the ones before them did.** That independence is the point
 * of the last two: uninstalling a plugin does not delete the files it wrote — nor should it, for a
 * real user — so a suite that reinstalls per scenario accumulates them until the cell runs out of
 * disk. Skipping a sweep because the uninstall failed would lose exactly the runs most likely to
 * have left a mess behind. The database sweep is ordered straight after the removal, and is what
 * catches a footprint the plugin's own uninstall did not take with it — a table re-created by a
 * request that outlived the uninstall, or rows left by a run killed between the two. Stopping the
 * plugin's running work comes before the removal for the same reason: it is the work that would
 * otherwise outlive the uninstall — see {@link stopWorkLeftRunning}.
 *
 * When more than one fails, the **debug-log verdict wins**: it is a statement about the product
 * under test, whereas a cleanup failure is about the environment. Cleanup failures are never merely
 * swallowed though — the first is thrown when no fatal claimed the verdict (a site left with a
 * half-removed plugin breaks later scenarios for a reason none of them can explain), and logged when
 * one did. The exception is leftover data the transport's user is not *permitted* to remove, which
 * is reported rather than thrown — see {@link sweepResidue}. One cleanup failure is about the product:
 * the plugin's own uninstall failing. Its folder is still removed by path, so later scenarios run, and
 * the failure is thrown ({@link PluginUninstallBrokenError}) — the log was judged before it, so this
 * is the only place it shows.
 *
 * The log is judged **as the scenario left it**, before any cleanup, so the verdict is about the
 * scenario and not about this hook's own work. A removal the scenario itself performs is a step, so
 * it falls inside that window and is judged normally.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin slug to remove; from the resolved artifact, so no edition branching.
 * @param options - the product's `debug.log` scan preset (`ignore` / `source` patterns).
 * @param residue - what this product leaves behind, on disk and in the database. Either being empty
 * costs nothing.
 * @param report - the scenario's result and attachment sink.
 * @param stopRunningWork - how the product stops work it may still be doing on the site
 * (`ProductConfig.stopRunningWork`); omitted for a product that runs nothing in the background.
 * @throws {@link DebugLogFatalError} when PHP logged a fatal, else the first cleanup failure — work
 * that would not stop, then {@link ensurePluginAbsent} or {@link PluginUninstallBrokenError} (the
 * plugin's own uninstall failed and its folder was removed by path: the site is clean, the plugin is
 * not), the database sweep (a footprint that survived removal, or a declaration the site refuses), or
 * a residue path that is not a usable declaration.
 */
export async function teardownPluginUnderTest(
  transport: Transport,
  slug: string,
  options: ScanDebugLogOptions,
  residue: DeclaredResidue,
  report: ScenarioReport,
  stopRunningWork?: StopRunningWork,
): Promise<void> {
  let failure: Error | undefined;

  try {
    await checkDebugLog(transport, options, report);
  } catch (error) {
    failure = toError(error);
  }

  /** Runs one cleanup duty, keeping the first failure and logging any that a verdict outranks. */
  const cleanUp = async (duty: () => Promise<void>): Promise<void> => {
    try {
      await duty();
    } catch (error) {
      if (failure === undefined) {
        failure = toError(error);
      } else {
        console.error(
          `[hooks] a cleanup step also failed, after the failure reported above: ${errorMessage(error)}`,
        );
      }
    }
  };

  await cleanUp(async () => {
    if (stopRunningWork === undefined) return;
    await stopWorkLeftRunning(
      transport,
      slug,
      stopRunningWork,
      report,
      "after",
    );
  });
  let uninstallFailed = false;
  await cleanUp(async () => {
    const cleared = await ensurePluginAbsent(transport, slug);
    await reportClearedPluginDir(cleared, "after", report);
    // This copy is the artifact under test: healed, so later scenarios run, but WordPress could not
    // uninstall it — which a user's WordPress could not either.
    if (cleared?.cause === "uninstall-failed") {
      uninstallFailed = true;
      throw new PluginUninstallBrokenError(slug, cleared.uninstallError);
    }
  });
  await cleanUp(() =>
    sweepDbResidue(transport, residue.db, "after", uninstallFailed),
  );
  await cleanUp(() => sweepResidue(transport, residue.files, report));

  if (failure !== undefined) throw failure;
}

/**
 * Has the product stop whatever it is still doing on the site, and says so when it had to.
 *
 * Ahead of a removal, because uninstalling a plugin underneath its own running work races that
 * work. Having had to stop something is **reported, not failed**: a scenario that failed midway is
 * expected to leave work behind, one that passed while leaving work running deserves to be seen
 * without turning a clean result red, and work found *before* a scenario is an earlier run's, not
 * this one's. Work that *would not* stop is the product's function throwing, which each caller
 * treats as its own position demands — unless the plugin cannot even boot
 * ({@link pluginBreaksBoot}): a product's stop asks the plugin itself, and a copy every request dies
 * on can run nothing, so that is reported and the removal goes ahead to heal it.
 *
 * @param transport - the target site's transport.
 * @param slug - the plugin under test, whose boot is judged when its stop fails.
 * @param stopRunningWork - the product's `ProductConfig.stopRunningWork`.
 * @param report - the scenario to name in the message, and to attach it to.
 * Bounded by {@link LEFT_WORK_ALLOWANCE_MS}: a stop whose WP-CLI call hangs would otherwise run the
 * hook out of time, and a timed-out hook is abandoned, not cancelled — its removal would then run on
 * beside whatever comes next. Past the allowance the stop fails, as work that would not stop does;
 * the stop itself is not cancelled (nothing can cancel a remote command), so it may still finish.
 *
 * @param when - whether the scenario is about to begin or has just ended, for the message.
 * @param budgetMs - how long the stop may take.
 * @throws whatever `stopRunningWork` throws — work that would not stop — or, past `budgetMs`, an
 *   error saying so.
 */
async function stopWorkLeftRunning(
  transport: Transport,
  slug: string,
  stopRunningWork: StopRunningWork,
  report: ScenarioReport,
  when: "before" | "after",
  budgetMs: number = LEFT_WORK_ALLOWANCE_MS,
): Promise<void> {
  let stopped: string | undefined;
  try {
    stopped = await withinBudget(
      stopRunningWork(transport),
      budgetMs,
      "stopping the plugin's running work",
    );
  } catch (error) {
    const boot = await pluginBreaksBoot(transport, slug);
    if (boot === undefined) throw error;
    stopped =
      `its running work could not be asked about, and none can run: WordPress cannot boot with ` +
      `"${slug}" loaded (${boot}), and boots without it. The plugin is removed next.`;
  }
  if (stopped === undefined) return;
  const message = `[hooks] ${when} "${report.title}": ${stopped}`;
  console.warn(message);
  await report
    .attach("stopped-running-work", message)
    .catch((attachError: unknown) => {
      console.warn(
        `[hooks] could not attach the stopped-work report: ${errorMessage(attachError)}`,
      );
    });
}

/**
 * Clears the product's leftovers, treating "the transport user is not allowed to" as a fact about
 * the environment rather than a failure of the scenario.
 *
 * The split matters, and it is between two different kinds of wrong:
 *
 *  - **A path that survives removal** is almost always ownership: plugins write as the web-server
 *    user, and a directory that user created without group/other write cannot have its contents
 *    unlinked by whoever WP-CLI runs as. Removal escalates for exactly that reason, so reaching here
 *    means privileges did not close the gap either — the site cannot escalate, or something other
 *    than permissions is holding the paths. Nothing the scenario did caused it and nothing it does
 *    can fix it, and unlike a half-removed plugin it breaks no later scenario. Failing every run over
 *    it would be a poor trade, so it is warned about, with the next step in the message.
 *  - **Anything else** — a path that is not a usable residue declaration, a transport that cannot
 *    run a command — is a defect in our own configuration or environment setup, and is thrown so it
 *    is dealt with.
 *
 * The warning still reaches the report: a passing scenario prints it, a failing one carries it as an
 * attachment, so a cell quietly accumulating data cannot go unnoticed for long.
 */
async function sweepResidue(
  transport: Transport,
  residue: readonly SiteResidue[],
  report: ScenarioReport,
): Promise<void> {
  try {
    await removeSiteResidue(transport, residue);
  } catch (error) {
    if (!(error instanceof SiteResidueRemovalFailedError)) throw error;
    // The error already names every survivor and the next step for this site's elevation state, so
    // this adds only what it cannot know: which scenario left them behind.
    const message = `[hooks] after "${report.title}": ${error.message}`;
    console.warn(message);
    await report
      .attach("uncleared-site-data", message)
      .catch((attachError: unknown) => {
        console.warn(
          `[hooks] could not attach the uncleared-data report: ${errorMessage(attachError)}`,
        );
      });
  }
}

/**
 * Narrows a caught `unknown` to an `Error`, passing a real one through untouched so the typed
 * error (e.g. {@link DebugLogFatalError}) survives all the way to the reporter.
 */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

/**
 * Reads `debug.log` and turns it into a verdict on the scenario.
 *
 * A PHP fatal is a defect no UI assertion is guaranteed to notice — WordPress may render a
 * perfectly plausible page around it — so a fatal fails the scenario outright. Warnings and
 * notices are reported to the console instead: worth seeing, but too common in a real WordPress
 * install to gate on, and the product's `ignore` preset is the place to silence the ones
 * confirmed benign.
 *
 * The log is attached when it can help — on a fatal, or whenever the scenario failed for any
 * other reason, which is exactly when the log usually holds the cause; a passing, quiet scenario
 * attaches nothing, and what is attached is bounded ({@link boundLogForAttachment}), so reports
 * stay small either way.
 *
 * Also exported for a step about to **overwrite** the log — a restore puts back the `debug.log` its
 * archive holds, which would hide whatever PHP logged since the backup from the teardown's reading —
 * so the log so far is judged first, by the same rule.
 *
 * @param transport - the target site's transport.
 * @param options - the product's `debug.log` scan preset.
 * @param report - the scenario's result and attachment sink.
 * @throws {@link DebugLogFatalError} when the scan matched at least one fatal.
 */
export async function checkDebugLog(
  transport: Transport,
  options: ScanDebugLogOptions,
  report: ScenarioReport,
): Promise<void> {
  const scan = await scanDebugLog(transport, options);

  if (scan.raw !== "" && (report.failed || scan.fatals.length > 0)) {
    // Attaching is diagnostics: a reporter fault must never replace the real verdict.
    const body = boundLogForAttachment(scan.raw);
    await report.attach("debug.log", body).catch((error: unknown) => {
      console.warn(
        `[hooks] could not attach debug.log: ${errorMessage(error)}`,
      );
    });
  }

  if (scan.warnings.length + scan.notices.length > 0) {
    // Named, because several workers write to one terminal — and the name is what tells you which
    // scenario to reproduce, or whose lines belong in the product's `ignore` preset.
    console.warn(
      `[hooks] debug.log for "${report.title}": ${String(scan.warnings.length)} warning(s), ` +
        `${String(scan.notices.length)} notice(s).`,
    );
  }

  if (scan.fatals.length > 0) throw new DebugLogFatalError(scan.fatals);
}
