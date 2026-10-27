import { evalPhp } from "../../../common/wp/php";
import { errorMessage, isObject } from "../../../common/guards";
import { FILE_MARKER_NAME } from "./markers";
import {
  readDatabaseDefaults,
  restoreDatabaseDefaults,
} from "./database-defaults";
import {
  isSnapshotPath,
  listRestoreSnapshots,
  removeSnapshot,
  snapshotHolds,
} from "./restore-snapshots";
import type { CliSession } from "./cli-session";
import type { ContentCopy } from "./content-copy";
import type { DatabaseDefaults } from "./database-defaults";
import type { ChangedMarkers, SiteMarkers } from "./markers";
import type { SnapshotContents, SnapshotListing } from "./restore-snapshots";
import type { Transport } from "../../../common/config/types";

/**
 * `wp backwpup restore`, run so that a shared site is left as it was found.
 *
 * The command is the system under test, and three things it does reach past what a scenario may
 * leave behind (all measured on `pro@nginx`):
 *
 *  - **`--type=file|full` replaces `wp-content` wholesale**, deleting what its archive does not hold
 *    (other plugins' empty directories, `.donotbackup` folders, files the job's exclusions skip) and
 *    writing the rest back as the transport's user. So `wp-content` is copied before and put back
 *    after, exactly (`./content-copy.ts`).
 *  - **`--type=db|full` runs `wp db reset`**, which drops and recreates the whole database: its default
 *    collation changes (set back, `./database-defaults.ts`), and whatever it holds that the backup
 *    does not — tables outside the site's prefix, views, routines, events, triggers — would be gone
 *    for good, so the command is refused on a database holding any.
 *  - **`--pre-backup` leaves its snapshot in the temp directory**, a database export readable by every
 *    local account; the scenario's own is removed (`./restore-snapshots.ts`). Any run may make one —
 *    WP-CLI reads `--no-pre-backup` as set — so every run is watched.
 *
 * The database itself ends as the scenario's backup left it, minutes earlier; the `@plugin` teardown
 * then sweeps the plugin's footprint.
 */

/** The subcommand and its alias, which only the guarded step may run. */
const RESTORE_SUBCOMMANDS: readonly string[] = ["restore", "backup-restore"];

/**
 * Whether an argv runs the restore — the one command that must go through {@link CliRestore}.
 *
 * @param argv - the command's argv, without `wp backwpup`.
 */
export function isRestoreCommand(argv: readonly string[]): boolean {
  return RESTORE_SUBCOMMANDS.includes(argv[0] ?? "");
}

/** What a restore command touches, by its `--type`. */
export interface RestoreReach {
  readonly files: boolean;
  readonly database: boolean;
}

/**
 * What a `wp backwpup restore` argv will touch. `--type` defaults to `full`, and the last one given
 * counts, as WP-CLI reads it; a value the command does not know counts as both, so an unexpected one
 * is never run unguarded.
 *
 * @param argv - the command's argv, without `wp backwpup`.
 */
export function restoreReach(argv: readonly string[]): RestoreReach {
  const type = argv
    .filter((arg) => arg.startsWith("--type="))
    .map((arg) => arg.slice("--type=".length))
    .at(-1);
  return {
    files: type !== "db",
    database: type !== "file",
  };
}

/**
 * What the copy of `wp-content` leaves out, relative to it: the plugin under test (which the restore
 * leaves alone and the teardown removes), BackWPup's own data directories as they are on the site when
 * the copy is taken (the residue the teardown removes) and the file marker (whose fixture removes it).
 * Putting any of them back would undo that cleanup.
 *
 * @param slug - the plugin under test.
 * @param residue - the residue paths on the site now, relative to the WordPress root, as
 * `resolveSiteResidue` finds them.
 */
export function contentKeptOut(
  slug: string,
  residue: readonly string[],
): readonly string[] {
  const inContent = residue
    .filter((path) => path.startsWith("wp-content/"))
    .map((path) => path.slice("wp-content/".length));
  return [`plugins/${slug}`, ...inContent, FILE_MARKER_NAME];
}

// ── What must hold before the command may run ────────────────────────────────

/** What the site says about the two premises a restore's guards rest on. */
export interface RestorePreconditions {
  /** `realpath( ABSPATH )`. */
  readonly root: string;
  /** `realpath( WP_CONTENT_DIR )` — the directory a files restore replaces. */
  readonly content: string;
  /** Whether `WP_CONTENT_DIR` is itself a link. */
  readonly linked: boolean;
  /** Tables and views in the database outside the site's prefix, and every view. */
  readonly foreign: readonly string[];
  readonly routines: number;
  readonly events: number;
  readonly triggers: number;
}

/**
 * Asks the site where its content directory really is, and what its database holds that the
 * backup's dump does not — BackWPup dumps only the site's own prefixed tables, and `wp db reset`
 * drops everything. Booted without plugins: core is all it needs.
 */
export const RESTORE_PRECONDITIONS_PHP = `global $wpdb;
$count = static function ( $sql ) use ( $wpdb ) {
	return (int) $wpdb->get_var( $sql );
};
echo wp_json_encode( [
	'root'     => realpath( ABSPATH ),
	'content'  => realpath( WP_CONTENT_DIR ),
	'linked'   => is_link( untrailingslashit( WP_CONTENT_DIR ) ),
	'foreign'  => $wpdb->get_col( $wpdb->prepare(
		"SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND ( TABLE_NAME NOT LIKE %s OR TABLE_TYPE <> 'BASE TABLE' )",
		$wpdb->esc_like( $wpdb->prefix ) . '%'
	) ),
	'routines' => $count( 'SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()' ),
	'events'   => $count( 'SELECT COUNT(*) FROM information_schema.EVENTS WHERE EVENT_SCHEMA = DATABASE()' ),
	'triggers' => $count( 'SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()' ),
] );`;

/**
 * Reads {@link RESTORE_PRECONDITIONS_PHP}'s answer.
 *
 * @param reply - the snippet's output.
 * @throws {@link Error} if it is not the shape the snippet gives — `realpath()` answering `false`
 * included.
 */
export function parseRestorePreconditions(reply: string): RestorePreconditions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  const counts = ["routines", "events", "triggers"] as const;
  if (
    !isObject(parsed) ||
    typeof parsed.root !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.linked !== "boolean" ||
    !Array.isArray(parsed.foreign) ||
    !parsed.foreign.every((name) => typeof name === "string") ||
    !counts.every((key) => Number.isInteger(parsed[key]))
  ) {
    throw new Error(
      "[backwpup/cli-restore] asking what the restore would reach returned an unexpected answer: " +
        (reply.slice(0, 300) || "(nothing)"),
    );
  }
  return {
    root: parsed.root,
    content: parsed.content,
    linked: parsed.linked,
    foreign: parsed.foreign,
    routines: Number(parsed.routines),
    events: Number(parsed.events),
    triggers: Number(parsed.triggers),
  };
}

/**
 * Why a restore reaching `reach` must not run on a site in this state, or `undefined` when it may.
 *
 * Files: the copy is of `<root>/wp-content`, so the content directory must be exactly that — not a
 * link, not relocated — or the copy would guard the wrong tree while the real one is replaced.
 * Database: nothing may be there that `wp db reset` drops and the backup cannot bring back.
 *
 * @param site - what the site said.
 * @param reach - what the command touches.
 */
export function restoreRefusal(
  site: RestorePreconditions,
  reach: RestoreReach,
): string | undefined {
  const reasons: string[] = [];
  const expected = `${site.root}/wp-content`;
  if (reach.files && (site.linked || site.content !== expected)) {
    reasons.push(
      `its content directory is ${site.linked ? "a link to " : ""}"${site.content}", not ` +
        `"${expected}", so the copy taken first would guard the wrong directory`,
    );
  }
  const foreign = [
    ...(site.foreign.length > 0
      ? [
          `${String(site.foreign.length)} table(s) or view(s) outside the site's own (` +
            `${site.foreign.slice(0, 5).join(", ")}${site.foreign.length > 5 ? ", …" : ""})`,
        ]
      : []),
    ...(site.routines > 0 ? [`${String(site.routines)} routine(s)`] : []),
    ...(site.events > 0 ? [`${String(site.events)} event(s)`] : []),
    ...(site.triggers > 0 ? [`${String(site.triggers)} trigger(s)`] : []),
  ];
  if (reach.database && foreign.length > 0) {
    reasons.push(
      `its database holds ${foreign.join(", ")}, which \`wp db reset\` would drop and the backup ` +
        "cannot bring back",
    );
  }
  return reasons.length === 0 ? undefined : reasons.join("; ");
}

// ── The site, as a restore run needs it ──────────────────────────────────────

/**
 * What a restore run asks of the site besides the command itself — one object, so the order the guards
 * run in can be pinned without a site.
 */
export interface RestoreSite {
  preconditions(): Promise<RestorePreconditions>;
  readDatabaseDefaults(): Promise<DatabaseDefaults>;
  restoreDatabaseDefaults(defaults: DatabaseDefaults): Promise<void>;
  listSnapshots(): Promise<SnapshotListing>;
  snapshotHolds(
    snapshot: string,
    markers: SiteMarkers,
  ): Promise<SnapshotContents>;
  removeSnapshot(snapshot: string, dir: string): Promise<void>;
}

/**
 * {@link RestoreSite} for a real site.
 *
 * @param transport - the scenario's site.
 */
export function restoreSite(transport: Transport): RestoreSite {
  return {
    preconditions: async () =>
      parseRestorePreconditions(
        await evalPhp(
          transport,
          RESTORE_PRECONDITIONS_PHP,
          "asking what the restore would reach",
          "backwpup/cli-restore",
          { skipPlugins: true },
        ),
      ),
    readDatabaseDefaults: () => readDatabaseDefaults(transport),
    restoreDatabaseDefaults: (defaults) =>
      restoreDatabaseDefaults(transport, defaults),
    listSnapshots: () => listRestoreSnapshots(transport),
    snapshotHolds: (snapshot, markers) =>
      snapshotHolds(transport, snapshot, markers),
    removeSnapshot: (snapshot, dir) => removeSnapshot(transport, snapshot, dir),
  };
}

// ── The command, run under all three ──────────────────────────────────────────

/**
 * How long the teardown waits for a restore a timed-out step left running before it gives up on
 * putting `wp-content` back. The command takes seconds (7–13 s measured); this only bounds a hang.
 */
export const RUN_SETTLE_MS = 10 * 60 * 1000;

/** An `unknown` thrown value as an `Error`, a real one passed through untouched. */
function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(errorMessage(value));
}

/**
 * The scenario's `wp backwpup restore` runs: each refused or guarded as its `--type` requires, and
 * undone as far as the site needs when the scenario ends ({@link CliRestore.release}).
 */
export class CliRestore {
  /** Snapshot directories that appeared while one of the scenario's runs was in flight. */
  private readonly appeared: string[] = [];

  /** The temp directory those are in, once a run has listed it. */
  private snapshotDir: string | undefined;

  /** Settles when the latest run — command and after-duties — has, however it ended. */
  private settled: Promise<void> | undefined;

  /**
   * @param site - what the run asks of the site ({@link restoreSite}).
   * @param cli - the scenario's command session, which remembers the result for the steps after.
   * @param content - the copy of the content directory to take before a files restore.
   * @param changed - the values the scenario changed its markers to, which is how a snapshot of this
   * site at this moment is told from one another run on the same server made.
   * @param settleMs - how long {@link CliRestore.release} waits for a run still in flight.
   */
  constructor(
    private readonly site: RestoreSite,
    private readonly cli: Pick<CliSession, "run">,
    private readonly content: Pick<
      ContentCopy,
      "keep" | "keepDatabaseDefaults" | "stamp" | "putBack" | "kept"
    >,
    private readonly changed: Pick<ChangedMarkers, "values">,
    private readonly settleMs = RUN_SETTLE_MS,
  ) {}

  /**
   * Runs one `wp backwpup restore …`: refused when the site holds what it would destroy beyond
   * repair, the content directory copied first when it will be replaced, the database's defaults
   * read first when it will be reset — then, however the command ended, the defaults set back and
   * the snapshots that appeared noted, each regardless of the other. The result is the session's, so
   * the generic steps judge it.
   *
   * @param argv - the command's argv, without `wp backwpup`; its first word must be the restore.
   * @throws {@link Error} if the argv is not a restore, a guard refused it or could not be put in
   * place (the command is then not run), the command itself could not be run, or an after-duty
   * failed — the command's own failure wins, the others then being logged.
   */
  async run(argv: readonly string[]): Promise<void> {
    const running = this.guarded(argv);
    this.settled = running.then(
      () => undefined,
      () => undefined,
    );
    await running;
  }

  /** {@link CliRestore.run}'s body, tracked by {@link CliRestore.settled}. */
  private async guarded(argv: readonly string[]): Promise<void> {
    if (!isRestoreCommand(argv)) {
      throw new Error(
        `[backwpup/cli-restore] expected a \`restore\` command, got \`${argv[0] ?? "(nothing)"}\`.`,
      );
    }
    const reach = restoreReach(argv);
    const refusal = restoreRefusal(await this.site.preconditions(), reach);
    if (refusal !== undefined) {
      throw new Error(
        `[backwpup/cli-restore] refusing to run \`wp backwpup ${argv[0] ?? ""}\` on this site: ${refusal}.`,
      );
    }
    if (reach.files) await this.content.keep();
    const defaults = reach.database
      ? await this.site.readDatabaseDefaults()
      : undefined;
    // Beside the copy, for a run settling it after a reboot cut this one off: no-op without a copy.
    if (defaults !== undefined) {
      await this.content.keepDatabaseDefaults(defaults);
    }
    const before = await this.site.listSnapshots();

    // Last before the command: a reboot during it then provably orphans the copy — and one since the
    // copy was taken refuses the command.
    await this.content.stamp();
    let failure: Error | undefined;
    try {
      await this.cli.run(argv);
    } catch (error) {
      failure = toError(error);
    }
    const problems = await this.afterRun(before, defaults);
    if (failure !== undefined) {
      for (const problem of problems) {
        console.warn(
          `[backwpup/cli-restore] after the failed restore: ${problem.message}`,
        );
      }
      throw failure;
    }
    const [first, ...rest] = problems;
    for (const problem of rest)
      console.warn(`[backwpup/cli-restore] ${problem.message}`);
    if (first !== undefined) throw first;
  }

  /**
   * The duties after the command, each attempted whatever the others did: the snapshots that appeared
   * noted (first — the one whose omission leaves a world-readable export behind), the database's
   * defaults set back.
   *
   * @returns what failed, in that order.
   */
  private async afterRun(
    before: SnapshotListing,
    defaults: DatabaseDefaults | undefined,
  ): Promise<Error[]> {
    const problems: Error[] = [];
    try {
      const after = await this.site.listSnapshots();
      this.snapshotDir = after.dir;
      for (const path of after.snapshots) {
        if (
          !before.snapshots.includes(path) &&
          !this.appeared.includes(path) &&
          isSnapshotPath(path, after.dir)
        ) {
          this.appeared.push(path);
        }
      }
    } catch (error) {
      problems.push(toError(error));
    }
    if (defaults !== undefined) {
      try {
        await this.site.restoreDatabaseDefaults(defaults);
      } catch (error) {
        problems.push(toError(error));
      }
    }
    return problems;
  }

  /**
   * The snapshots this scenario's runs made: of those that appeared meanwhile, the ones holding either
   * value the scenario changed its markers to — unique to the scenario, so another run's is never
   * counted, while one the command cut short after its database export still is.
   */
  async snapshots(): Promise<readonly string[]> {
    return (await this.attributeSnapshots()).ours;
  }

  /** The snapshots that appeared, split into this scenario's and the rest. */
  private async attributeSnapshots(): Promise<{
    readonly ours: readonly string[];
    readonly others: readonly string[];
  }> {
    const ours: string[] = [];
    const others: string[] = [];
    for (const snapshot of this.appeared) {
      const holds = await this.site.snapshotHolds(
        snapshot,
        this.changed.values,
      );
      (holds.file || holds.database ? ours : others).push(snapshot);
    }
    return { ours, others };
  }

  /**
   * Undoes what the scenario's runs left that it may not: once no run is in flight, the content
   * directory put back first — the one that matters — then the scenario's own snapshots removed.
   *
   * @throws {@link Error} if a run is still in flight after {@link RUN_SETTLE_MS} (nothing is then
   * put back, since doing it under the command would leave neither), or the content directory could
   * not be put back; snapshot removal only reports.
   */
  async release(): Promise<void> {
    await this.settle();
    try {
      await this.content.putBack();
    } finally {
      await this.removeSnapshots();
    }
  }

  /**
   * Waits for a run a timed-out step left in flight — its command still rewriting the site.
   *
   * @throws {@link Error} if it is still running after the bound.
   */
  private async settle(): Promise<void> {
    if (this.settled === undefined) return;
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<false>((resolve) => {
      timer = setTimeout(() => {
        resolve(false);
      }, this.settleMs);
    });
    let finished: boolean;
    try {
      finished = await Promise.race([
        this.settled.then(() => true as const),
        expired,
      ]);
    } finally {
      clearTimeout(timer);
    }
    if (!finished) {
      throw new Error(
        `[backwpup/cli-restore] \`wp backwpup restore\` was still running ` +
          `${String(this.settleMs / 60_000)} min after its step ended, so nothing was put back — doing ` +
          "it under a command still rewriting the site would leave neither as found. " +
          (this.content.kept
            ? "The copy of wp-content stays, so the next BackWPup run on this site says how to settle it."
            : ""),
      );
    }
  }

  /** Removes the scenario's own snapshots; one it cannot attribute is named, never removed. */
  private async removeSnapshots(): Promise<void> {
    const dir = this.snapshotDir;
    if (dir === undefined || this.appeared.length === 0) return;
    let found: Awaited<ReturnType<CliRestore["attributeSnapshots"]>>;
    try {
      found = await this.attributeSnapshots();
    } catch (error) {
      console.warn(
        `[backwpup/cli-restore] could not tell which restore snapshots this scenario made, so none ` +
          `was removed (${this.appeared.join(", ")}): ${errorMessage(error)}`,
      );
      return;
    }
    for (const snapshot of found.ours) {
      await this.site.removeSnapshot(snapshot, dir);
    }
    if (found.others.length > 0) {
      console.warn(
        "[backwpup/cli-restore] restore snapshots appeared while this scenario's restore ran but hold " +
          "neither of its changed markers, so they were left — another run's, or one cut short before " +
          `it wrote anything: ${found.others.join(", ")}`,
      );
    }
  }
}
