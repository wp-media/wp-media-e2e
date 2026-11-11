/**
 * Distinct error types for the WordPress automation layer, so steps and reports can tell apart
 * its failure modes — including the two that WP-CLI's ambiguous plugin-removal exit codes cannot
 * (see ./plugin.ts): "expected present but absent" and "still present after removal". The WP-CLI
 * path removes plugins with `wp plugin uninstall` ({@link PluginUninstallFailedError}); the
 * admin-UI Delete action removes them through the browser ({@link PluginDeletionFailedError},
 * see ../pages/plugins.page.ts). {@link PluginActivationFailedError} and
 * {@link PluginDeactivationFailedError} each cover both paths: the admin-UI actions
 * (../pages/plugins.page.ts) and WP-CLI's own (./plugin.ts).
 * {@link PluginUninstallBrokenError} is an uninstall that failed after cleanup healed what it left.
 * {@link DebugLogFatalError} is the one that is not about a plugin action at all: PHP wrote a
 * fatal to `debug.log` while the scenario ran (see ./log.ts), and
 * {@link SiteResidueRemovalFailedError} is about what a plugin left on the *filesystem* after it
 * was removed (see ./residue.ts). {@link PluginDirRemovalFailedError} and
 * {@link PluginDestinationExistsError} are about the plugin's own folder when WordPress no longer
 * sees a plugin in it (see ./plugin-dir.ts). {@link CommandKilledError} is the exec layer's own: a
 * command ended by a signal (see ./exec.ts); {@link SiteIdentityRefusedError} a command `sudo` refused
 * the site's identity after it was verified.
 */

// Type-only, so it is erased at runtime and this module stays free of a cycle with the exec layer.
import type { CapabilityGrant, FoundDbResidue } from "./db-residue";
import type { ElevationSupport } from "./transport-exec";

/** A plugin expected to be installed is not one WordPress lists (e.g. before a removal-under-test). */
export class PluginNotInstalledError extends Error {
  /**
   * @param slug - the plugin's slug.
   * @param left - what is at its path nonetheless, already described — a folder WordPress lists no
   * plugin in; omitted when nothing is there, or nothing was asked.
   */
  constructor(slug: string, left?: string) {
    super(
      left === undefined
        ? `Plugin "${slug}" was expected to be installed, but is absent.`
        : `Plugin "${slug}" was expected to be installed, but WordPress lists no plugin there; ` +
            `at its path: ${left}`,
    );
    this.name = "PluginNotInstalledError";
  }
}

/**
 * A plugin is not active when it should be — the admin-UI Activate action did not take, or a
 * WP-CLI install with `--activate` left it inactive. Raised from a re-check of the state rather
 * than from an exit code, so it also catches an archive that installed under a directory other
 * than the slug it was expected to carry.
 */
export class PluginActivationFailedError extends Error {
  constructor(slug: string) {
    super(`Plugin "${slug}" could not be activated.`);
    this.name = "PluginActivationFailedError";
  }
}

/** A plugin could not be deactivated (admin UI or WP-CLI). */
export class PluginDeactivationFailedError extends Error {
  /**
   * @param slug - the plugin's slug.
   * @param reason - what was seen, when more than "still active" is known.
   */
  constructor(slug: string, reason?: string) {
    super(
      `Plugin "${slug}" could not be deactivated${reason === undefined ? "." : `: ${reason}`}`,
    );
    this.name = "PluginDeactivationFailedError";
  }
}

/**
 * Something is still at a plugin's path after a WP-CLI `plugin uninstall` — a genuine uninstall
 * failure, whether WordPress still lists the plugin or only part of its folder survived.
 */
export class PluginUninstallFailedError extends Error {
  /**
   * @param slug - the plugin's slug.
   * @param left - what is still at the plugin's path, already described; omitted when only
   * WordPress's own answer is known.
   */
  constructor(slug: string, left?: string) {
    super(
      left === undefined
        ? `Plugin "${slug}" is still installed after uninstall; uninstall FAILED.`
        : `Plugin "${slug}" was not removed by its uninstall; uninstall FAILED. Still at its path: ${left}`,
    );
    this.name = "PluginUninstallFailedError";
  }
}

/**
 * A plugin's own uninstall failed, and cleanup removed it by path instead — so the site is clean, but
 * WordPress could not uninstall the plugin, as a user's could not either. Raised after a scenario,
 * where the copy is the artifact under test (see `../hooks/plugin-lifecycle.ts`).
 */
export class PluginUninstallBrokenError extends Error {
  /** The uninstall's first error line, as `firstError` (./plugin.ts) picks it. */
  readonly uninstallError: string;

  /**
   * @param slug - the plugin's slug.
   * @param uninstallError - the uninstall's first error line.
   */
  constructor(slug: string, uninstallError: string) {
    super(
      `Plugin "${slug}" could not be uninstalled by WordPress: ${uninstallError}\n  Cleanup removed ` +
        "its folder by path and sweeps its database footprint, so the next scenario starts clean; " +
        "the uninstall itself is what failed.",
    );
    this.name = "PluginUninstallBrokenError";
    this.uninstallError = uninstallError;
  }
}

/**
 * The admin-UI Delete action did not remove a plugin — WordPress answered that it could not, the
 * request never landed or failed, or the plugin is still listed afterwards.
 */
export class PluginDeletionFailedError extends Error {
  /**
   * @param slug - the plugin's slug.
   * @param reason - what went wrong, in WordPress's words where it gave any; omitted when the plugin
   * is simply still listed.
   */
  constructor(slug: string, reason?: string) {
    super(
      reason === undefined
        ? `Plugin "${slug}" is still installed after delete; deletion FAILED.`
        : `Plugin "${slug}" could not be deleted; deletion FAILED: ${reason}`,
    );
    this.name = "PluginDeletionFailedError";
  }
}

/**
 * A plugin's folder is still there after cleanup removed it by path (see ./plugin-dir.ts). Thrown,
 * unlike {@link SiteResidueRemovalFailedError}: the next install of the plugin cannot succeed with
 * anything at its path.
 */
export class PluginDirRemovalFailedError extends Error {
  /** The folder's absolute path on the site. */
  readonly path: string;

  /**
   * @param path - the folder's absolute path on the site.
   * @param left - what is still there, already described.
   * @param elevation - how far privileges could go, when the removal got as far as asking; omitted
   * when every pass reported the folder gone and it was found there again.
   */
  constructor(path: string, left: string, elevation?: ElevationSupport) {
    super(
      `The plugin folder "${path}" could not be removed from the site; still there: ${left}\n  ` +
        (elevation === undefined
          ? "Every removal pass reported it gone, so something re-created it — look for a request or " +
            "process still installing the plugin."
          : residueAdvice(elevation)),
    );
    this.name = "PluginDirRemovalFailedError";
    this.path = path;
  }
}

/** What WordPress makes of a folder in the way of an install — see {@link PluginDestinationExistsError}. */
export type DestinationVerdict =
  "recognised" | "orphaned" | "absent" | "unknown";

/**
 * An install stopped on WP-CLI's "Destination folder already exists": something is at the plugin's
 * path. Names whether WordPress lists a plugin there, because the two need different fixes — a listed
 * one was never removed, an unlisted one is what a removal stopped part-way leaves.
 */
export class PluginDestinationExistsError extends Error {
  /** The folder's path, as WP-CLI named it. */
  readonly path: string;

  /** Whether WordPress lists a plugin there, looked at right after the install refused. */
  readonly verdict: DestinationVerdict;

  /**
   * @param path - the folder, as WP-CLI named it.
   * @param verdict - what an inspection right after the refusal found there; `unknown` when it could
   * not be inspected (an unusable name, a failed read).
   */
  constructor(path: string, verdict: DestinationVerdict) {
    const seen: Record<DestinationVerdict, string> = {
      recognised:
        "WordPress lists a plugin there: an earlier copy was never removed.",
      orphaned:
        "WordPress lists no plugin there: part of a plugin is left, as a removal stopped part-way " +
        "(a PHP-FPM restart, a reboot) leaves it.",
      absent:
        "nothing is there any more, so something removed it right after the install refused.",
      unknown: "the folder could not be inspected.",
    };
    super(
      `Plugin install refused: the destination folder "${path}" already exists; ${seen[verdict]}`,
    );
    this.name = "PluginDestinationExistsError";
    this.path = path;
    this.verdict = verdict;
  }
}

/**
 * An install failed on WP-CLI's "Could not create directory" for the plugin's own path, where
 * something that is no folder stands — a file, or a link WordPress cannot follow (a dangling one).
 * WordPress takes only a folder for one in the way, so it neither refuses with "Destination folder
 * already exists" nor offers to replace it ({@link PluginDestinationExistsError}).
 */
export class PluginDestinationBlockedError extends Error {
  /** The folder WordPress could not create, as WP-CLI named it. */
  readonly path: string;

  /**
   * @param path - the folder, as WP-CLI named it.
   * @param found - what stands at it, described (`describePluginDir`).
   */
  constructor(path: string, found: string) {
    super(
      `Plugin install failed: WordPress could not create the plugin's folder "${path}", because ` +
        `something that is no folder is there — ${found}. Remove it (or point a link at a real ` +
        "folder), then install again.",
    );
    this.name = "PluginDestinationBlockedError";
    this.path = path;
  }
}

/**
 * The operator's next step after residue survived, which depends entirely on how far privileges
 * reached — "make it writable" is useless advice if the delete already ran as root, and misleading
 * if elevation was switched off.
 */
function residueAdvice(elevation: ElevationSupport): string {
  switch (elevation) {
    case "available":
      return (
        "These survived an elevated `rm -rf`, so permissions are not what is holding them: look " +
        "for a read-only mount, an immutable attribute, or a process still writing to them."
      );
    case "unavailable":
      return (
        "The transport's user cannot unlink inside them, and it has no passwordless `sudo` on " +
        "this host to fall back on. Grant it that, or make the paths writable by it."
      );
    case "disabled":
      return (
        "The transport's user cannot unlink inside them, and this site declares " +
        "`transport.elevate: false`, so cleanup did not escalate. Allow elevation, or make the " +
        "paths writable by that user."
      );
    default: {
      const exhaustive: never = elevation;
      throw new Error(`unsupported elevation state: ${String(exhaustive)}`);
    }
  }
}

/**
 * Data a plugin wrote to the site's filesystem is still there after cleanup tried to remove it.
 *
 * Distinct from a failed uninstall: the plugin may be perfectly gone while the archives, logs or
 * caches it produced remain — residue that accumulates across runs until the cell runs out of disk
 * (see ./residue.ts). Naming every survivor at once, because a cleanup that half-worked is more
 * confusing than one that did not run.
 */
export class SiteResidueRemovalFailedError extends Error {
  /** The absolute paths that were still present after removal. */
  readonly paths: readonly string[];

  /** How far privileges could go on this site — what makes the advice in the message actionable. */
  readonly elevation: ElevationSupport;

  constructor(paths: readonly string[], elevation: ElevationSupport) {
    super(
      `Left-over plugin data could not be removed from the site; ${String(paths.length)} ` +
        `path(s) survived:\n${paths.map((path) => `  ${path}`).join("\n")}\n` +
        `  ${residueAdvice(elevation)}`,
    );
    this.name = "SiteResidueRemovalFailedError";
    this.paths = paths;
    this.elevation = elevation;
  }
}

/**
 * A plugin's database footprint is still there after the sweep tried to remove it.
 *
 * Unlike its filesystem counterpart this has no permissions dimension to excuse it — the same
 * WP-CLI connection that read the rows is the one that deleted them — so reaching here means
 * something is actively putting them back, which is what a still-installed copy of the plugin does
 * on every request. Naming every survivor at once, because the *shape* of what stayed is the clue:
 * options alone point at a filter, the table alone at a second process re-creating it, roles
 * at a roles option something else rewrites.
 */
export class SiteDbResidueRemovalFailedError extends Error {
  /** The option names still present after removal. */
  readonly options: readonly string[];

  /** The tables still present after removal, at their full prefixed names. */
  readonly tables: readonly string[];

  /** The declared roles still present after removal. */
  readonly roles: readonly string[];

  /** The declared capabilities still held after removal. */
  readonly capabilities: readonly CapabilityGrant[];

  constructor(survivors: FoundDbResidue) {
    const lines = [
      ...survivors.options.map((option) => `  option     ${option}`),
      ...survivors.tables.map((table) => `  table      ${table}`),
      ...survivors.roles.map((role) => `  role       ${role}`),
      ...survivors.capabilities.map(
        ({ role, capability }) => `  capability ${capability} (on ${role})`,
      ),
    ];
    super(
      `A plugin's leftover database footprint could not be removed from the site; ` +
        `${String(lines.length)} item(s) survived:\n${lines.join("\n")}\n` +
        "  Check that the plugin is really uninstalled — an installed copy re-creates its own " +
        "options, tables and roles on every request, so nothing can be swept while it is there.",
    );
    this.name = "SiteDbResidueRemovalFailedError";
    this.options = survivors.options;
    this.tables = survivors.tables;
    this.roles = survivors.roles;
    this.capabilities = survivors.capabilities;
  }
}

/** How many fatal lines a {@link DebugLogFatalError} quotes before it truncates. */
const QUOTED_FATALS = 5;

/**
 * PHP wrote one or more fatals to `debug.log` during a scenario — a defect a UI assertion can
 * easily pass straight over, so the scenario fails on it regardless of what the browser saw.
 *
 * The message quotes the first few fatals so the failure is diagnosable from the reporter alone;
 * the full log is attached separately by the caller.
 */
export class DebugLogFatalError extends Error {
  /** Every fatal line the scan matched, in log order. */
  readonly fatals: readonly string[];

  constructor(fatals: readonly string[]) {
    const shown = fatals.slice(0, QUOTED_FATALS);
    const more = fatals.length - shown.length;
    super(
      `PHP wrote ${String(fatals.length)} fatal error(s) to debug.log during this scenario:\n` +
        shown.map((line) => `  ${line.trim()}`).join("\n") +
        (more > 0
          ? `\n  …and ${String(more)} more (see the attached debug.log).`
          : ""),
    );
    this.name = "DebugLogFatalError";
    this.fatals = fatals;
  }
}

/**
 * A command a transport ran was ended by a signal before it exited (`local`/`docker`: execa saw the
 * signal; `ssh`: the channel reported one) — how it would have ended is unknown, so it is not an
 * `ExecResult`. Typed so the few callers with an answer that needs no exit code can tell it
 * from a transport that failed: `readDebugLog` falls back to a direct read when a crashed `wp eval`
 * (a segfault, the kernel's OOM kill) could not read the log, and the pre-flight names a crashed
 * WordPress rather than a missing `wp`.
 *
 * The message names the program and the signal only, never the arguments.
 */
export class CommandKilledError extends Error {
  /** The signal's name, e.g. `SIGSEGV`. */
  readonly signal: string;

  /**
   * @param message - the whole message, built by the transport in its own words.
   * @param signal - the signal's name.
   */
  constructor(message: string, signal: string) {
    super(message);
    this.name = "CommandKilledError";
    this.signal = signal;
  }
}

/**
 * A command meant to run as the site's identity never ran: `sudo` refused it (exit 1, nothing on
 * stderr but `sudo:` lines) although the identity was verified earlier in this process — a sudoers or
 * PAM change mid-run. Not an `ExecResult`: an exit 1 is an answer to many callers (`wp plugin
 * is-installed`: "absent"), and this one is not the program's. The state is forgotten, so the next
 * command resolves it again.
 *
 * The message names the program and the site only: sudo's own refusal quotes the whole command line.
 */
export class SiteIdentityRefusedError extends Error {
  /** The program asked for. */
  readonly program: string;

  /**
   * @param program - the program asked for (never `sudo`).
   * @param target - the site, as `describeTarget` names it.
   */
  constructor(program: string, target: string) {
    super(
      `[wp/exec] "${program}" on ${target} did not run: the site's identity, verified earlier in this ` +
        "run, was refused by the host (its rule changed since). It is resolved again on the next command.",
    );
    this.name = "SiteIdentityRefusedError";
    this.program = program;
  }
}
