import { suiteVersionText } from "../src/common/config/suite-version";
import { ConfigError } from "./config/errors";
import { describeBudget, type ShutdownBudgets } from "./runs/shutdown";
import type { StopLevel } from "./runs/stop";
import type { LeftoverSweep } from "./state/leftovers";
import type { Classification, StaleRun } from "./state/orphans";
import { onceExitCode, type TaskEnd } from "./tasks/loop";
import { MAX_QUOTED_PATH, safeLine, shellWord } from "./text";

/**
 * The orchestrator's start, its pure parts: which tasks run, the lines it says about itself, and the
 * exit code it ends with.
 */

/** What the orchestrator exits with: `0` passed, `1` failed or refused, `130` stopped by a signal. */
export type ExitCode = 0 | 1 | 130;

/** The longest `--task` value a refusal quotes, in code points: a task's id is four. */
const MAX_QUOTED_ID = 40;

/**
 * The tasks `--task` selects, in the config's order, each once; every task when it names none.
 *
 * @param tasks - the config's tasks.
 * @param ids - the ids `--task` named; empty or absent for every task.
 * @param file - the config's path, for the refusal.
 * @returns the selected tasks.
 * @throws {@link ConfigError} naming every id that is no task of the config, and the config's ids.
 */
export function selectTasks<
  T extends { readonly task: { readonly id: string } },
>(tasks: readonly T[], ids: readonly string[] | undefined, file: string): T[] {
  if (ids === undefined || ids.length === 0) return [...tasks];
  const known = new Set(tasks.map(({ task }) => task.id));
  const unknown = [...new Set(ids)].filter((id) => !known.has(id));
  if (unknown.length > 0)
    throw new ConfigError(
      `--task names no task of ${file}: ${unknown.map((id) => safeLine(JSON.stringify(id), MAX_QUOTED_ID)).join(", ")}; its tasks: ${[...known].join(", ")}`,
    );
  const wanted = new Set(ids);
  return tasks.filter(({ task }) => wanted.has(task.id));
}

/**
 * The tasks a line names: `2 tasks (bpng, bfap)`.
 *
 * @param ids - their ids.
 * @returns the text.
 */
export function tasksText(ids: readonly string[]): string {
  return `${String(ids.length)} task${ids.length === 1 ? "" : "s"} (${ids.join(", ")})`;
}

/**
 * The line the orchestrator starts its loops with: `started · suite 1.1.0 · 2 tasks (bpng, bpap) ·
 * .orchestrator/ · pid 4242`, `once` after the tasks with `--once`. The suite's version is the one read
 * at boot: a `git pull` while it runs changes what its runs test, not this line.
 *
 * @param suiteVersion - the suite's version; `undefined` shows as `unknown`.
 * @param ids - the selected tasks' ids.
 * @param once - whether it runs each once.
 * @param stateDir - the state directory, as shown.
 * @param pid - this process's.
 * @returns the line.
 */
export function startedLine(
  suiteVersion: string | undefined,
  ids: readonly string[],
  once: boolean,
  stateDir: string,
  pid: number,
): string {
  return [
    "started",
    `suite ${suiteVersionText(suiteVersion)}`,
    tasksText(ids),
    ...(once ? ["once"] : []),
    `${stateDir}/`,
    `pid ${String(pid)}`,
  ].join(" · ");
}

/**
 * The line a stop says, as far as it goes: what happens now, and what comes next, by signal or budget.
 *
 * @param level - how far every run is stopped now.
 * @param why - why (the shutdown's).
 * @param budgets - the shutdown's budgets.
 * @returns the line.
 */
export function escalationLine(
  level: StopLevel,
  why: string,
  budgets: Pick<ShutdownBudgets, "drainMs" | "interruptMs">,
): string {
  switch (level) {
    case "drained":
      return `stopping: ${why} — no new run; every run finishes its scenario in progress. Ctrl-C again to interrupt them; interrupted anyway after ${describeBudget(budgets.drainMs)}`;
    case "interrupted":
      return `interrupting every run: ${why}. Ctrl-C again to kill them; killed anyway after ${describeBudget(budgets.interruptMs)}`;
    case "killed":
      return `killing every run: ${why}`;
  }
}

/**
 * The line saying the orchestrator stops waiting for loops that did not end after the kill.
 *
 * @param taskIds - their tasks.
 * @param waitedMs - how long it waited after the kill.
 * @returns the line.
 */
export function gaveUpLine(
  taskIds: readonly string[],
  waitedMs: number,
): string {
  const waited =
    waitedMs < 1_000 ? `${String(waitedMs)} ms` : describeBudget(waitedMs);
  return `stopped waiting: ${taskIds.join(", ")} did not end within ${waited} of the kill`;
}

/**
 * The line naming a run this start launched and leaves behind, as the orphan check judges its group
 * now: only a group shown to be the run's — alive, its leader the process the record names — gets the
 * command that ends it; one that cannot be shown so says how to look at it first; one that has ended,
 * or is another process's now, says the run's processes are gone and the loop is stuck after them.
 *
 * @param id - the run's id.
 * @param verdict - its record's group, judged now (`classifyRunning`).
 * @param log - its `run.log`, which each of its processes writes.
 * @returns the line.
 */
export function leftBehindLine(
  id: string,
  verdict: Classification,
  log: string,
): string {
  if (verdict.kind === "stale")
    return `${id} left nothing to kill (${verdict.reason}): its loop is stuck after its processes, reading, recording or announcing its end`;
  if (verdict.confirmed) {
    const pgid = String(verdict.pgid);
    return `${id} left behind, still running in process group ${pgid}: end it with kill -KILL -${pgid}`;
  }
  if (verdict.pgid === undefined)
    return `${id} may be left behind — unconfirmed: ${verdict.why}. lsof -- ${safeLine(shellWord(log), MAX_QUOTED_PATH)} lists its processes`;
  const pgid = String(verdict.pgid);
  return `${id} may be left behind in process group ${pgid} — unconfirmed: ${verdict.why}. Check it first: ps -o pid,user,lstart,command -g ${pgid}`;
}

/**
 * The line a crash leftover sweep says, if anything was found.
 *
 * @param sweep - what the lock's sweep did.
 * @returns the lines: what was removed, and each that could not be.
 */
export function leftoverLines(sweep: LeftoverSweep): string[] {
  return [
    ...(sweep.removed.length === 0
      ? []
      : [
          `removed ${String(sweep.removed.length)} file${sweep.removed.length === 1 ? "" : "s"} an earlier crash left`,
        ]),
    ...sweep.failed.map(
      ({ path, code }) =>
        `could not remove ${safeLine(path, MAX_QUOTED_PATH)}, an earlier crash's (${code})`,
    ),
  ];
}

/**
 * The line saying a run an earlier orchestrator left `running` was found over.
 *
 * @param stale - the run.
 * @returns the line.
 */
export function staleLine(stale: StaleRun): string {
  return `run ${stale.id} was left running and found over (${stale.reason}): ${stale.rewritten ? "marked lost" : "not marked lost, read again at the next start"}`;
}

/** How the loops ended, for the exit code. */
export interface LoopsOutcome {
  /** Whether a signal stopped the orchestrator, at any time. */
  readonly signalled: boolean;
  /** `--once`. */
  readonly once: boolean;
  /** Every loop's end; absent when not all of them ended. */
  readonly ends?: readonly TaskEnd[];
}

/**
 * The exit code once the loops are over: `130` whenever a signal stopped the orchestrator, even after
 * every loop had ended — the operator stopped it; with `--once`, `onceExitCode` of the loops'
 * verdicts; otherwise `1` — without `--once`, a loop ends only on a stop or when it breaks.
 *
 * @param outcome - the signal, `--once` and the loops' ends.
 * @returns the exit code.
 */
export function loopsExitCode(outcome: LoopsOutcome): ExitCode {
  if (outcome.signalled) return 130;
  if (!outcome.once || outcome.ends === undefined) return 1;
  return onceExitCode(outcome.ends.map(({ verdict }) => verdict));
}
