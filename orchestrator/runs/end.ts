import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import {
  buildRunFinished,
  type RunFinishedEvent,
  type RunFinishedInput,
} from "../events/run-finished";
import { readCapped, type CappedRead } from "../files";
import { readRunFacts, RUN_FACTS_FILE } from "./facts";
import type { RunIdentity } from "./identity";
import { LOG_PREFIX, type LaunchResult } from "./launch";
import { runOutcome, type RunOutcome } from "./outcome";
import { readRunResults } from "./results";

/**
 * A run's end: what it left read back — its results stream, its facts, its log's last lines — each
 * within a size cap, then its outcome decided and its `run.finished` built. Reading never fails the
 * run: a missing or oversized file is read as absent, and the outcome says so where it matters.
 */

/**
 * The largest results stream read, in bytes: a full run writes well under 1 MiB (the largest seen, 12
 * KB). Its lines are capped too ({@link readRunResults}), so a hostile stream costs little to parse.
 */
export const MAX_RESULTS_BYTES = 8 * 1024 * 1024;

/** The largest facts file read, in bytes: a run's is a few KiB. */
export const MAX_FACTS_BYTES = 1024 * 1024;

/** How much of the log's end is read, in bytes. */
export const LOG_TAIL_BYTES = 64 * 1024;

/** How many of the log's last lines are kept: enough to find `bddgen`'s first error line. */
export const LOG_TAIL_MAX_LINES = 40;

/**
 * Opens the log for reading without waiting: a FIFO put in its place would otherwise block the open
 * until something writes to it. A regular file reads the same either way.
 */
const READ_NONBLOCKING = constants.O_RDONLY | constants.O_NONBLOCK;

/**
 * The run log's last lines, ours left out — a reason quotes what the run said, not our header lines.
 * Read from the last {@link LOG_TAIL_BYTES}; a line cut by that start is dropped, a whole one kept.
 *
 * @param path - the log.
 * @param bytes - how much of its end to read.
 * @param maxLines - how many lines to keep.
 * @returns the lines, oldest first; none when the log cannot be read.
 */
export async function readLogTail(
  path: string,
  bytes = LOG_TAIL_BYTES,
  maxLines = LOG_TAIL_MAX_LINES,
): Promise<string[]> {
  let handle;
  try {
    handle = await open(path, READ_NONBLOCKING);
  } catch {
    return [];
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return [];
    const { size } = stats;
    // One byte before the window too: the first line is whole only when that byte ends a line.
    const cut = size > bytes;
    const start = cut ? size - bytes - 1 : 0;
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer
      .subarray(0, bytesRead)
      .toString("utf8")
      .split(/\r?\n|\r/);
    // The piece before the first line end: the extra byte's line, empty when it ended one.
    if (cut) lines.shift();
    return lines
      .map(withoutOurs)
      .filter((line) => line.trim() !== "")
      .slice(-maxLines);
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** One of our lines: the prefix, then an ISO time — at a line's start, or after output without a newline. */
const OUR_LINE = new RegExp(
  `${LOG_PREFIX.replace(/[[\]]/g, "\\$&")} \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z .*$`,
);

/**
 * A log line without the line of ours it may hold: ours begins on a line of its own, but a process
 * writing while we do can still run into it. A run printing lines like ours only hides its own.
 *
 * @param line - the line.
 * @returns the line's own text, `""` when it is one of ours.
 */
function withoutOurs(line: string): string {
  return line.startsWith(LOG_PREFIX) ? "" : line.replace(OUR_LINE, "");
}

/** What a run's end is made from. */
export interface RunEndInput {
  readonly identity: Pick<
    RunIdentity,
    "id" | "runId" | "startedAt" | "log" | "reportDir"
  >;
  readonly task: RunFinishedInput["task"];
  readonly launch: LaunchResult;
  /** The secret values the orchestrator holds (`allSecretValues(config, tasks)`). */
  readonly secrets: readonly string[];
  /** When the run ended. */
  readonly endedAt: Date;
  /** The run's download bundle, when one was built. */
  readonly bundle?: RunFinishedInput["bundle"];
}

/**
 * A run's end. The files' raw contents are not handed on: only the event, whose every text is made
 * safe to send, leaves this module.
 */
export interface RunEnd {
  readonly outcome: RunOutcome;
  readonly event: RunFinishedEvent;
}

/**
 * Reads what a run left, decides its outcome and builds its `run.finished`.
 *
 * @param input - the run, its task, how its processes ended and the secrets to mask.
 * @returns the outcome and the event.
 */
export async function endRun(input: RunEndInput): Promise<RunEnd> {
  const { identity, task, launch, secrets } = input;
  const [resultsRead, factsRead, logTail] = await Promise.all([
    readCapped(join(identity.reportDir, RESULTS_FILE), MAX_RESULTS_BYTES),
    readCapped(join(identity.reportDir, RUN_FACTS_FILE), MAX_FACTS_BYTES),
    readLogTail(identity.log),
  ]);
  const results =
    resultsRead.kind === "text" ? readRunResults(resultsRead.text) : undefined;
  const facts =
    factsRead.kind === "text"
      ? readRunFacts(factsRead.text, task.cell)
      : undefined;
  const resultsUnread = whyUnread(resultsRead);
  const outcome = runOutcome({
    stop: launch.stop,
    bddgen: launch.bddgen,
    ...(launch.playwright === undefined
      ? {}
      : { playwright: launch.playwright }),
    ...(results === undefined ? {} : { results }),
    ...(resultsUnread === undefined ? {} : { resultsUnread }),
    setupFailures: facts?.setupFailures ?? [],
    logTail,
    secrets,
  });
  const event = buildRunFinished({
    at: input.endedAt,
    run: { id: identity.id, runId: identity.runId },
    task,
    startedAt: identity.startedAt,
    endedAt: input.endedAt,
    outcome,
    ...(results === undefined ? {} : { results }),
    ...(facts === undefined ? {} : { facts }),
    reportDir: identity.reportDir,
    log: identity.log,
    ...(input.bundle === undefined ? {} : { bundle: input.bundle }),
    secrets,
  });
  return { outcome, event };
}

/**
 * Why a file that is there was not read, in words; `undefined` when it was read or is not there.
 *
 * @param read - the read.
 * @returns the cap it exceeds or the read's error code; `undefined` when read or absent.
 */
function whyUnread(read: CappedRead): string | undefined {
  if (read.kind === "tooLarge")
    return `it is ${String(read.bytes)} bytes, over the ${String(MAX_RESULTS_BYTES)}-byte cap`;
  if (read.kind === "unreadable") return read.code;
  return undefined;
}
