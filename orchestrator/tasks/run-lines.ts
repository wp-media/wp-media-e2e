import { isAbsolute, relative } from "node:path";

import type { TaskConfig } from "../config/schema";
import type {
  RunFinishedEvent,
  RunFinishedInput,
} from "../events/run-finished";
import { MAX_TEXT_LENGTH } from "../log";
import { fitsSlack, formatDuration } from "../notify/slack";
import { downloadCommand } from "../runs/bundle";
import type { RunOutcome, RunStatus, StopTaken } from "../runs/outcome";
import { STOP_RANK, type StopLevel } from "../runs/stop";
import { failureLine, safeLine } from "../text";

/**
 * The pure parts of one run (`cycle.ts`): what its terminal lines say, what its `run.finished` is
 * told of its task, how far a stop asked for goes, and the outcome of a run whose end could not be
 * read. Each line is one line of the orchestrator's log; the logger masks it again.
 */

/** A task, as one run of it needs it. */
export type CycleTask = Pick<
  TaskConfig,
  "id" | "name" | "product" | "cell" | "plugin" | "grep"
>;

/**
 * The longest failure a run's line or reason quotes, in code points: with its lead-in
 * (`the run could not start: `) it stays inside a reason's own cap (`MAX_REASON_LENGTH`, 500), so a
 * record never cuts it a second time.
 */
export const MAX_RUN_FAILURE_LENGTH = 300;

/** Each status's mark in the outcome line. */
const MARKS: Readonly<Record<RunStatus, string>> = {
  passed: "✔",
  flaky: "⚠",
  failed: "✘",
  error: "✘",
  stopped: "■",
  killed: "■",
};

/** The statuses of a run that tested the plugin: its report says how, so the line points there. */
const TESTED: ReadonlySet<RunStatus> = new Set(["passed", "flaky", "failed"]);

/**
 * A path as a line shows it: relative to `base` when it is inside it (`.orchestrator/runs/bpng-12/run.log`
 * from the checkout), else as it is.
 *
 * @param path - an absolute path.
 * @param base - the folder it is shown from: the checkout.
 * @returns the path to show.
 */
export function showPath(path: string, base: string): string {
  const shown = relative(base, path);
  return shown === "" || shown.startsWith("..") || isAbsolute(shown)
    ? path
    : shown;
}

/**
 * The task as a `run.finished` names it: its ref only when it asks for one, its filter only when it
 * has one.
 *
 * @param task - the task.
 * @returns the event's task.
 */
export function eventTask(task: CycleTask): RunFinishedInput["task"] {
  return {
    id: task.id,
    product: task.product,
    cell: task.cell,
    ...(task.name === undefined ? {} : { name: task.name }),
    ...(task.plugin?.ref === undefined ? {} : { ref: task.plugin.ref }),
    ...(task.grep === undefined ? {} : { grep: task.grep }),
  };
}

/**
 * The line a run starts with:
 * `bpng-12 started · backwpup pro@nginx · develop (default) · .orchestrator/runs/bpng-12/run.log` —
 * the ref built, as the dry run shows it, and the task's filter when it has one.
 *
 * @param id - the run's id.
 * @param task - its task.
 * @param log - its log, as shown.
 * @param ref - the ref its runs build, as shown (`builtRef`); without it, the task's own ref, else
 *   `default ref`.
 * @returns the line.
 */
export function startedLine(
  id: string,
  task: CycleTask,
  log: string,
  ref?: string,
): string {
  return [
    `${id} started`,
    `${task.product} ${task.cell}`,
    ref ?? task.plugin?.ref ?? "default ref",
    ...(task.grep === undefined ? [] : [task.grep]),
    log,
  ].join(" · ");
}

/**
 * The line a run ends with: `bpng-12 ✔ passed · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/…`.
 * A run that tested points at its report; one that did not says why and points at its log.
 *
 * @param event - the run's `run.finished`.
 * @param show - how a path is shown ({@link showPath}).
 * @returns the line.
 */
export function outcomeLine(
  event: RunFinishedEvent,
  show: (path: string) => string,
): string {
  const tested = TESTED.has(event.status);
  return [
    `${event.run.id} ${MARKS[event.status]} ${event.status}`,
    ...(event.counts.total === 0 ? [] : [countsText(event.counts)]),
    ...(event.reason === null ? [] : [event.reason]),
    formatDuration(event.durationMs),
    ...pathShown(tested ? event.report.dir : event.report.log, show),
  ].join(" · ");
}

/** A line under a run's end, and whether it must never be wrapped (a command to copy). */
export interface BundleLine {
  readonly text: string;
  readonly verbatim: boolean;
}

/**
 * The lines under a run's end when it has a bundle: where the bundle and the raw folder are, then —
 * with an `scp` host — the command that fetches it, Slack's own, verbatim (never wrapped). The
 * command is left out when Slack would leave it out ({@link fitsSlack}: a cut command is a broken
 * one), and when the log would change it — masking, or a run of spaces made one ({@link safeLine}) —
 * since a changed command fetches nothing; the `report:` line still names the bundle.
 *
 * ```text
 * bpng-12 report: reports/backwpup/pro@nginx/<RUN_ID>/report.tar.gz · raw: reports/backwpup/pro@nginx/<RUN_ID>
 * bpng-12 fetch: scp auto-e2e:/srv/e2e/reports/…/report.tar.gz backwpup-pro@nginx-<RUN_ID>.tar.gz && tar -xzf … && rm …
 * ```
 *
 * @param event - the run's `run.finished`.
 * @param show - how a path is shown ({@link showPath}).
 * @param sshHost - the config's `reports.sshHost`.
 * @param secrets - every secret value, as the log masks them.
 * @returns the lines; none without a bundle.
 */
export function bundleLines(
  event: RunFinishedEvent,
  show: (path: string) => string,
  sshHost: string | undefined,
  secrets: readonly string[],
): BundleLine[] {
  const { bundle, dir } = event.report;
  if (bundle === null || dir === null) return [];
  const id = event.run.id;
  const lines: BundleLine[] = [
    {
      text: `${id} report: ${show(bundle.path)} · raw: ${show(dir)}`,
      verbatim: false,
    },
  ];
  if (sshHost === undefined) return lines;
  const command = downloadCommand(bundle, sshHost);
  const fetch = `${id} fetch: ${command}`;
  if (fitsSlack(command) && safeLine(fetch, MAX_TEXT_LENGTH, secrets) === fetch)
    lines.push({ text: fetch, verbatim: true });
  return lines;
}

/**
 * The path a run's line ends with, shown; none for a run that never had a folder.
 *
 * @param path - its report folder or log, or `null`.
 * @param show - how a path is shown.
 * @returns the path shown, alone, or nothing.
 */
function pathShown(
  path: string | null,
  show: (path: string) => string,
): string[] {
  return path === null ? [] : [show(path)];
}

/**
 * `52 scenarios: 51 passed, 1 flaky` — each count only when not 0.
 *
 * @param counts - the run's counts.
 * @returns the text.
 */
function countsText(counts: RunFinishedEvent["counts"]): string {
  const parts = (
    [
      [counts.passed, "passed"],
      [counts.flaky, "flaky"],
      [counts.failed, "failed"],
      [counts.skipped, "skipped"],
      [counts.didNotRun, "did not run"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${String(count)} ${label}`);
  const total = `${String(counts.total)} scenario${counts.total === 1 ? "" : "s"}`;
  return parts.length === 0 ? total : `${total}: ${parts.join(", ")}`;
}

/** A stop asked for: how far, and why. */
export interface StopAsked {
  readonly level: StopLevel;
  readonly why: string;
}

/**
 * The stop that goes further of two: the one already asked for, or a new one.
 *
 * @param asked - the stop asked for so far, if any.
 * @param next - the new one.
 * @returns the further; the earlier on a tie, so its reason stays.
 */
export function furtherStop<S extends { readonly level: StopLevel }>(
  asked: S | undefined,
  next: S,
): S {
  return asked !== undefined && STOP_RANK[asked.level] >= STOP_RANK[next.level]
    ? asked
    : next;
}

/**
 * The outcome of a run whose end could not be read: what its stop says when it was stopped — a kill
 * is `killed`, any other stop `stopped` —, else `error` with why.
 *
 * @param stop - how far it was stopped.
 * @param failure - what reading its end threw.
 * @param secrets - the secret values to mask in the reason.
 * @returns the outcome.
 */
export function unreadOutcome(
  stop: StopTaken,
  failure: unknown,
  secrets: readonly string[],
): RunOutcome {
  if (stop.level === "killed") return { status: "killed", reason: stop.why };
  if (stop.level !== "none") return { status: "stopped", reason: stop.why };
  return {
    status: "error",
    reason: `its end could not be read: ${failureLine(failure, MAX_RUN_FAILURE_LENGTH, secrets)}`,
  };
}

/**
 * The outcome of a run that could not start: nothing ran, so it could not test.
 *
 * @param failure - what kept it from starting.
 * @param secrets - the secret values to mask in the reason.
 * @returns the outcome.
 */
export function notStartedOutcome(
  failure: unknown,
  secrets: readonly string[],
): RunOutcome {
  return {
    status: "error",
    reason: `the run could not start: ${failureLine(failure, MAX_RUN_FAILURE_LENGTH, secrets)}`,
  };
}
