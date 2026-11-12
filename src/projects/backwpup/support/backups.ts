import { expect } from "@playwright/test";

import { theScheduledJob } from "./job-options";
import { evalPhp } from "../../../common/wp/php";
import { parseJsonList } from "./cli";
import { readHistory } from "./history";
import { PROBE_INTERVALS, forgiving } from "./polling";
import { wpCli } from "../../../common/wp/exec";
import type { TestInfo } from "@playwright/test";
import type { Transport } from "../../../common/config/types";

/**
 * WP-CLI readers for BackWPup's backups and jobs — the **ground truth** behind every count,
 * status and storage assertion.
 *
 * The baseline scraped the history table with `td:nth-child(n)` and counted `<td>`s to guess the
 * plugin's table layout. That asserts the DOM against itself: it cannot tell a genuinely missing
 * backup from a renamed column. These readers come from a different source entirely — WP-CLI's
 * own structured output — so a scenario can assert the UI *and* the underlying state and only pass
 * when the two agree.
 *
 * Fields are typed to exactly what the commands document (`src/Cli/Commands/Backup.php` and
 * `src/Cli/Commands/Job.php`, verified at the ref under test). Prefer `sizeBytes`/`timeUnix` over the humanised `size`/`time`:
 * the latter are locale- and timezone-formatted for display and make brittle assertions.
 *
 * Both commands exist in **Free and Pro**, so nothing here is edition-gated.
 */

/** WP-CLI's raw `wp backwpup backup --format=json` record, before camel-casing. */
interface RawBackupRecord {
  readonly name: string;
  readonly time: string;
  readonly size: string;
  readonly storage: string;
  readonly type: string;
  readonly file?: string;
  readonly job_id?: string | number;
  readonly size_bytes?: string | number;
  readonly time_unix?: string | number;
}

/** WP-CLI's raw `wp backwpup job --format=json` record, before camel-casing. */
interface RawJobRecord {
  readonly job_id: string | number;
  readonly name: string;
  readonly active_type: string;
  readonly type: string;
  readonly storages: string;
  readonly cron: string;
  readonly last_run: string;
  readonly last_runtime: string;
}

/** One archive in BackWPup's backup history, as WP-CLI reports it. */
export interface BackupRecord {
  /** Archive filename, e.g. `2026-07-30_09-12-44_ABCDEF_DBDUMP.tar.gz`. */
  readonly name: string;
  /** Human-formatted creation time (display-formatted — assert on {@link timeUnix} instead). */
  readonly time: string;
  /** Human-formatted size (display-formatted — assert on {@link sizeBytes} instead). */
  readonly size: string;
  /** Destination slug the archive lives on, lower-cased by the plugin (e.g. `folder`, `ftp`). */
  readonly storage: string;
  /** Comma-separated backup contents, e.g. `file, dbdump, wpplugin`. */
  readonly type: string;
  /** Id of the job that produced it, when requested. */
  readonly jobId?: number;
  /** Exact byte size, when requested. The assertion-grade counterpart of {@link size}. */
  readonly sizeBytes?: number;
  /** Unix creation timestamp, when requested. The assertion-grade counterpart of {@link time}. */
  readonly timeUnix?: number;
  /**
   * Absolute path to the archive **on the site**, when requested.
   *
   * What makes an archive inspectable without downloading it. The plugin only lists an archive it
   * can read, so a path that appears here is one WP-CLI can open.
   */
  readonly path?: string;
}

/** One configured backup job, as WP-CLI reports it. */
export interface JobRecord {
  readonly jobId: number;
  readonly name: string;
  /** Which schedule drives it (e.g. `wpcron`, `easycron`, `link`), or empty when inactive. */
  readonly activeType: string;
  /** Comma-separated job contents (e.g. `DBDUMP, FILE`). */
  readonly type: string;
  /** Comma-separated destination slugs. */
  readonly storages: string;
  /** The cron expression, when scheduled. */
  readonly cron: string;
  readonly lastRun: string;
  readonly lastRuntime: string;
}

/**
 * Coerces WP-CLI's numeric-ish field to a number, or `undefined` when there is no number in it.
 *
 * WP-CLI emits numbers as strings in some formats and as numbers in others, so both are accepted.
 * Everything else — a missing field, a JSON `null`, an empty string, unparseable text — reads as
 * absent, deliberately: `Number(null)` and `Number("")` are both `0`, and a zero invented that way
 * is indistinguishable from a measured one. Takes `unknown` because the values arrive from parsed
 * JSON, where the declared field types are a hope rather than a guarantee.
 */
function optionalNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Runs a `wp backwpup …` command and returns its parsed JSON list. */
async function readList<T>(
  transport: Transport,
  args: readonly string[],
): Promise<readonly T[]> {
  const argv = ["backwpup", ...args, "--format=json"];
  const result = await wpCli(transport, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp ${argv.join(" ")}\` exited ${String(result.exitCode)}: ` +
        (result.stderr.trim() || "(no stderr)"),
    );
  }
  return parseJsonList(result.stdout, argv) as readonly T[];
}

/**
 * Every archive in the backup history, newest first (the plugin's own ordering).
 *
 * Requests the optional `job_id`, `size_bytes` and `time_unix` fields alongside the defaults, so
 * callers always have assertion-grade values without a second round-trip.
 */
export async function listBackups(
  transport: Transport,
): Promise<readonly BackupRecord[]> {
  const raw = await readList<RawBackupRecord>(transport, [
    "backup",
    "--fields=name,time,size,storage,type,job_id,size_bytes,time_unix,file",
  ]);
  return raw.map((r) => ({
    name: r.name,
    time: r.time,
    size: r.size,
    storage: r.storage,
    type: r.type,
    ...(optionalNumber(r.job_id) === undefined
      ? {}
      : { jobId: optionalNumber(r.job_id) }),
    ...(optionalNumber(r.size_bytes) === undefined
      ? {}
      : { sizeBytes: optionalNumber(r.size_bytes) }),
    ...(optionalNumber(r.time_unix) === undefined
      ? {}
      : { timeUnix: optionalNumber(r.time_unix) }),
    ...(typeof r.file === "string" && r.file !== "" ? { path: r.file } : {}),
  }));
}

/** Every configured backup job. */
export async function listJobs(
  transport: Transport,
): Promise<readonly JobRecord[]> {
  const raw = await readList<RawJobRecord>(transport, ["job"]);
  return raw.map((r) => ({
    jobId: optionalNumber(r.job_id) ?? 0,
    name: r.name,
    activeType: r.active_type,
    type: r.type,
    storages: r.storages,
    cron: r.cron,
    lastRun: r.last_run,
    lastRuntime: r.last_runtime,
  }));
}

/**
 * How many archives the history holds.
 *
 * Uses `--format=count`, which the plugin computes itself — so it stays correct even if a future
 * version changes the record shape, and it is the cheapest possible "did a backup land?" probe.
 */
export async function countBackups(transport: Transport): Promise<number> {
  const result = await wpCli(transport, [
    "backwpup",
    "backup",
    "--format=count",
  ]);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp backwpup backup --format=count\` exited ` +
        `${String(result.exitCode)}: ${result.stderr.trim() || "(no stderr)"}`,
    );
  }
  const count = Number(result.stdout.trim());
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(
      `[backwpup/backups] expected an integer count, got "${result.stdout.trim()}".`,
    );
  }
  return count;
}

/**
 * How a backup job ended, read from the log it left behind.
 *
 * Deliberately has no "nothing was running" member: a verdict is a statement about a run that
 * happened, and "I asked too late" is not one — see {@link readLastRunOutcome}.
 */
export type RunOutcome = "finished" | "warnings" | "errors";

/**
 * `wp backwpup log`'s wording when the log folder holds nothing. It exits **zero** and prints this
 * instead of JSON, so it is an answer rather than a fault — matched loosely, so a rewording degrades
 * to a parse error with the output attached rather than to a wrong verdict.
 */
const NO_LOGS = /no logs found/i;

/**
 * Whether a backup job is running right now.
 *
 * The plugin's own liveness marker is a file it writes while a job is in flight and removes when it
 * ends (`BackWPup::get_plugin_data('running_file')`), which is exactly what its own
 * `wp backwpup status` loops on. Reading it directly gives a **cheap, non-blocking** probe, where
 * that command is a blocking wait that cannot be polled and cannot be bounded.
 *
 * Guarded on the class existing so a site whose plugin is not loaded answers "nothing is running"
 * instead of fataling — which is the truth, and keeps this usable in teardown.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if WordPress could not be asked at all.
 */
export async function isJobRunning(transport: Transport): Promise<boolean> {
  const php =
    "echo ( class_exists( 'BackWPup' ) && " +
    "file_exists( BackWPup::get_plugin_data( 'running_file' ) ) ) ? '1' : '0';";
  const answer = await evalPhp(
    transport,
    php,
    "asking whether a backup job is running",
    "backwpup/backups",
  );
  if (answer !== "0" && answer !== "1") {
    throw new Error(
      `[backwpup/backups] could not tell whether a job is running — expected "0" or "1", got ${JSON.stringify(answer)}.`,
    );
  }
  return answer === "1";
}

/** The newest job log's header, as `wp backwpup log` reads it. */
export interface RunLog {
  /** The log's filename, e.g. `backwpup_log_a51e01_2026-09-22_16-53-13.html`. */
  readonly name: string;
  /**
   * The job the header names, when the reply carried one. The command reads a header it cannot
   * parse as job `0`, which is no job's id, so matching this against a real job is what proves the
   * header — and the counts beside it — were read at all.
   */
  readonly jobId?: number;
  readonly errors: number;
  readonly warnings: number;
}

/**
 * The header of the most recent job run's log.
 *
 * **The log is the only verdict that survives the run.** `wp backwpup status` reports one too, but
 * only when it is called *while the job is still running*: asked afterwards it prints
 * "No job running." and returns without ever reading a log (`src/Cli/Commands/Status.php` — the
 * verdict lives past its `while` loop). A short backup can therefore finish between two probes and
 * leave that command with nothing to say, which is precisely when a caller most needs an answer.
 *
 * The counts are integers the plugin reads out of the log's own header
 * (`src/Cli/Helpers/CommandsLogHelpersTrait::read_log_header`); the `status` column beside them is
 * assembled from translated strings ("O.K.", "%d ERRORS") and is never read.
 *
 * `--limit=1` is the newest run and not the oldest: the command defaults to `--orderby=time`
 * `--order=desc` and sorts before it slices. The newest entry is the run in question because a
 * scenario runs one job at a time — the plugin itself refuses to start a second
 * (`src/Cli/Commands/Run.php`, "A job is already running.").
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if no run has been logged, if the entry has no name or its error/warning
 * counts are absent, or if the log could not be read — each means the question cannot be answered,
 * and answering it wrongly would pass a failed backup.
 */
export async function readLastRunLog(transport: Transport): Promise<RunLog> {
  const argv = [
    "backwpup",
    "log",
    "--limit=1",
    "--fields=name,job_id,errors,warnings",
    "--format=json",
  ];
  const result = await wpCli(transport, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp ${argv.join(" ")}\` exited ${String(result.exitCode)}: ` +
        ((result.stderr || result.stdout).trim() || "(no output)"),
    );
  }
  // The command prints its own sentence and exits **zero** when the log folder is empty, so that
  // case has to be recognised before parsing — otherwise it surfaces as "did not return JSON",
  // which describes the symptom rather than the cause.
  const out = result.stdout.trim();
  const [newest] = NO_LOGS.test(out)
    ? []
    : (parseJsonList(out, argv) as readonly {
        readonly name?: unknown;
        readonly job_id?: unknown;
        readonly errors?: unknown;
        readonly warnings?: unknown;
      }[]);
  if (newest === undefined) {
    throw new Error(
      "[backwpup/backups] no job log exists, so how the run ended cannot be established.",
    );
  }
  const errors = optionalNumber(newest.errors);
  const warnings = optionalNumber(newest.warnings);
  // Absent counts are refused rather than read as zero. The plugin always emits both as integers,
  // so a reply without them means the question was not answered — and calling that "finished" is
  // precisely how a failed backup would slip through.
  if (errors === undefined || warnings === undefined) {
    throw new Error(
      "[backwpup/backups] the newest job log carries no error/warning counts " +
        `(errors=${JSON.stringify(newest.errors)}, warnings=${JSON.stringify(newest.warnings)}), ` +
        "so how the run ended cannot be established.",
    );
  }
  if (typeof newest.name !== "string" || newest.name === "") {
    throw new Error(
      `[backwpup/backups] the newest job log entry names no log file: ${JSON.stringify(newest)}`,
    );
  }
  const jobId = optionalNumber(newest.job_id);
  return {
    name: newest.name,
    ...(jobId === undefined ? {} : { jobId }),
    errors,
    warnings,
  };
}

/** Judges a run by its log's counts, an error outranking a warning. */
export function outcomeOf(
  log: Pick<RunLog, "errors" | "warnings">,
): RunOutcome {
  if (log.errors > 0) return "errors";
  if (log.warnings > 0) return "warnings";
  return "finished";
}

/**
 * How the most recent job run ended, from the log entry it wrote — see {@link readLastRunLog} for
 * why the log, and why the counts.
 *
 * @throws {@link Error} whenever {@link readLastRunLog} does.
 */
export async function readLastRunOutcome(
  transport: Transport,
): Promise<RunOutcome> {
  return outcomeOf(await readLastRunLog(transport));
}

/**
 * How long a real backup of a real site may take before a scenario gives up.
 *
 * Files, database and archive creation on a live cell, so this is minutes rather than seconds. It
 * is deliberately generous: the wait below ends as soon as the archive exists, so a fast site pays
 * none of it, and the only thing a tight budget would buy is a flaky failure on a slow one.
 */
export const BACKUP_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Makes room in a scenario's budget for a step about to wait on `backups` backups.
 *
 * Playwright times a scenario as a whole, so a step that may wait as long as a backup takes has to
 * add that time itself. A budget of `0` means the scenario has no timeout at all, and is left alone.
 *
 * @param testInfo - the scenario's own test info.
 * @param backups - how many backups the step may wait on.
 */
export function allowForBackup(
  testInfo: Pick<TestInfo, "timeout" | "setTimeout">,
  backups = 1,
): void {
  if (testInfo.timeout === 0) return;
  testInfo.setTimeout(testInfo.timeout + backups * BACKUP_TIMEOUT_MS);
}

/**
 * How long a restore may take, end to end: unpacking the archive — Free uploads it through the
 * browser first (~3 min for 411 MB measured) — and restoring it (under a minute measured), or a
 * command-line restore with the content directory copied and put back around it.
 */
export const RESTORE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * Makes room in a scenario's budget for a step about to restore a backup — {@link allowForBackup}'s
 * counterpart, on the same terms.
 *
 * @param testInfo - the scenario's own test info.
 */
export function allowForRestore(
  testInfo: Pick<TestInfo, "timeout" | "setTimeout">,
): void {
  if (testInfo.timeout === 0) return;
  testInfo.setTimeout(testInfo.timeout + RESTORE_TIMEOUT_MS);
}

/**
 * Starts a configured job and returns immediately.
 *
 * `--background` hands the job to the web server, which is how every scheduled or on-demand run of
 * it happens — so the backup is made the way a real one is, under the web server's PHP and as its
 * user. Without it the job runs **inside the WP-CLI process** instead, under the CLI's PHP settings,
 * which are nothing like the web server's: the plugin grows its memory limit from what it measures,
 * and a job triggered through WP-CLI's cron runner on a host whose CLI has no limit at all computed
 * a finite one below its needs and died against it (measured). {@link runJobInForeground} runs one
 * there on purpose, for the scenarios where who wrote a file matters.
 *
 * Use it to *arrange* a scenario that needs backups to exist. A scenario about starting a backup
 * should drive the product's own controls instead.
 *
 * **It confirms dispatch, not success**, and the difference is worth knowing: the command fires the
 * request non-blockingly (`src/Cli/Commands/Run.php` → `get_jobrun_url`, `'blocking' => false`), so a
 * site that answered with a 500 still reports success — and so does a job id the site does not have
 * (measured: `Job "" runs now in background.`, exit 0, and nothing ran). What it does refuse is a
 * second job while one runs, a missing id and more than one id. Whether the backup actually happened
 * is {@link waitForBackup}'s question.
 *
 * @param transport - the site to run on.
 * @param jobId - the job to start.
 * @throws {@link Error} if the command refused — in practice, because another job is already
 * running.
 */
export async function startJobInBackground(
  transport: Transport,
  jobId: number,
): Promise<void> {
  const argv = ["backwpup", "run", String(jobId), "--background"];
  const result = await wpCli(transport, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp ${argv.join(" ")}\` exited ${String(result.exitCode)}: ` +
        ((result.stderr || result.stdout).trim() || "(no output)"),
    );
  }
}

/**
 * Runs a configured job **inside WP-CLI**, and checks the plugin recorded the run as a clean one.
 *
 * The counterpart of {@link startJobInBackground}. Here the backup is made by the WP-CLI process, as
 * the identity site commands run as, so the archive and the log it writes belong to that user — which
 * is what a scenario needs when the question is what WP-CLI may do to those files. The small database jobs
 * the scenarios configure finish there in a couple of seconds on every cell measured.
 *
 * The command never reports how the run went: the job ends the WP-CLI process itself, at exit 0,
 * whatever it logged. So the verdict is read from the plugin's own record — the history must have
 * gained exactly one row, this job's, `completed` and started by `wp-cli`, and the newest log must
 * hold no errors.
 *
 * @param transport - the site to run on.
 * @param jobId - the job to run.
 * @throws {@link Error} if the command refused — another job running, an unknown id — or the run
 * was not recorded as a clean completion.
 */
export async function runJobInForeground(
  transport: Transport,
  jobId: number,
): Promise<void> {
  const before = (await readHistory(transport)).length;
  const argv = ["backwpup", "run", String(jobId)];
  const result = await wpCli(transport, argv);
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/backups] \`wp ${argv.join(" ")}\` exited ${String(result.exitCode)}: ` +
        ((result.stderr || result.stdout).trim() || "(no output)"),
    );
  }
  const added = (await readHistory(transport)).slice(before);
  expect(
    added.map((run) => ({
      jobId: run.jobId,
      status: run.status,
      trigger: run.trigger,
    })),
    `\`wp ${argv.join(" ")}\` should have recorded one completed run of its own`,
  ).toEqual([{ jobId, status: "completed", trigger: "wp-cli" }]);
  expect(
    await readLastRunOutcome(transport),
    "a backup arranged inside WP-CLI should not have ended in errors",
  ).not.toBe("errors");
}

/**
 * Waits for a backup to land and finish, then reports how it ended.
 *
 * **Three phases, in this order, for different reasons.** The archive appearing is what "a backup
 * happened" means, and it is the only signal that is true whichever way the run was started. The job
 * then has a little finalising left to do, so nothing-still-running is waited for next — that is
 * what guarantees no job outlives the scenario, which matters because the plugin lifecycle
 * uninstalls the plugin at the end of it. Only then is the verdict read, from the log, which is the
 * one source that still holds it once the run is over ({@link readLastRunOutcome}).
 *
 * Both waits share **one** budget, so a caller that made room for `BACKUP_TIMEOUT_MS` has made room
 * for the whole call rather than for its first half. Each probe is a WP-CLI round-trip, so the
 * interval backs off quickly instead of hammering the site the way Playwright's DOM-facing default
 * would — and a probe that fails is absorbed rather than fatal, up to the run of failures
 * {@link forgiving} tolerates.
 *
 * @param transport - the site to watch.
 * @param before - how many archives the history held before the run started.
 * @returns how the job ended, for the caller to judge — this reports, it does not decide, so a
 * scenario expecting success and one provoking a failure can share it.
 * @throws {@link Error} if no new archive appears, if a job is still running when the budget is
 * spent, or if no verdict could be read.
 */
export async function waitForBackup(
  transport: Transport,
  before: number,
): Promise<RunOutcome> {
  const deadline = Date.now() + BACKUP_TIMEOUT_MS;
  /** What is left of the shared budget, floored so a spent budget still makes one last probe. */
  const remaining = (): number => Math.max(1_000, deadline - Date.now());

  await expect
    .poll(
      forgiving(() => countBackups(transport)),
      {
        message: `a backup should have landed in the history by now (there were ${String(before)} before it started)`,
        timeout: remaining(),
        intervals: [...PROBE_INTERVALS],
      },
    )
    .toBeGreaterThan(before);

  await expect
    .poll(
      forgiving(() => isJobRunning(transport)),
      {
        message:
          "the backup job should have finished by now — leaving one running would outlive the scenario",
        timeout: remaining(),
        intervals: [...PROBE_INTERVALS],
      },
    )
    .toBe(false);

  return readLastRunOutcome(transport);
}

/**
 * Runs the site's one scheduled job and waits for its archive to land.
 *
 * The arrangement primitive behind every scenario that needs a backup to exist without driving the
 * controls that make one. It goes through the job the product itself scheduled, so what it produces
 * is a real backup of a real site rather than something this suite assembled.
 *
 * @param transport - the site to back up.
 * @throws {@link Error} if the run ended in errors, or if no archive appeared in time — a
 * precondition that quietly failed would surface later as a confusing assertion about a history
 * that is emptier than the scenario expected.
 */
export async function runScheduledBackup(transport: Transport): Promise<void> {
  const before = await countBackups(transport);
  const job = await theScheduledJob(transport);
  await startJobInBackground(transport, job.jobId);
  expect(
    await waitForBackup(transport, before),
    "a backup arranged as a precondition should not have ended in errors",
  ).not.toBe("errors");
}
