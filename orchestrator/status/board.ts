import type { RunStatus } from "../runs/outcome";
import type { StopLevel } from "../runs/stop";
import type { RunNotStarted, TaskActivity } from "../tasks/activity";
import type { TaskEnd } from "../tasks/loop";
import { NO_PROGRESS, type RunProgress } from "./progress";

/**
 * Each task's state for the status table, from the orchestrator's own record of its loop — what the
 * loop and its runs tell (`tasks/activity.ts`) — and the progress its run's results stream gives
 * (`progress.ts`). Pure: a reducer over immutable values.
 *
 * A task's phase, as the loop tells it — every edge:
 *
 * ```text
 * waiting ──begun──▶ run ──ended──▶ ended ──cooling──▶ cooling ──begun──▶ run …
 * waiting ──cooling──▶ cooling          an attempt that began no run, then its cooldown
 * cooling ──cooling──▶ cooling          the same, again
 * any but over ──loopEnded──▶ over      final: nothing changes it
 * ```
 *
 * `notStarted` (an attempt that began no run) changes no phase: it marks the task until its next
 * `begun`, so the table says the last attempt did not start instead of showing the last run alone.
 * `stopping` changes only its run.
 *
 * A run's state, inside `run`: `starting` (no `run.begin` read yet), `setup n/m` (setups still
 * ending, no scenario begun, `run.end` not read), `running` (also once `run.end` is read: the run is
 * being recorded), and `stopping` once a stop reached it, whatever its stream says. No `building`: the
 * plugin's build runs inside the run's setups.
 */

/** A run in flight. */
export interface LiveRun {
  readonly id: string;
  readonly reportDir: string;
  readonly startedAt: Date;
  /** A stop reached it. */
  readonly stopping: boolean;
  /** The level of the stop in force, once one reached it. */
  readonly stopLevel?: StopLevel;
  readonly progress: RunProgress;
}

/** A run that ended. */
export interface EndedRun {
  readonly id: string;
  readonly status: RunStatus;
  /** How long it took; absent when its start is unknown (it never began). */
  readonly durationMs?: number;
  /** How many scenarios its `run.finished` counted. */
  readonly scenarios?: number;
}

/** One task's phase. */
export type TaskPhase =
  /** Its loop started, no run has begun yet (the cell's locks being taken, the number). */
  | { readonly kind: "waiting" }
  | { readonly kind: "run"; readonly run: LiveRun }
  /** Its run ended — recorded, announced, its folders pruned; the cooldown is not armed yet. */
  | { readonly kind: "ended" }
  | { readonly kind: "cooling"; readonly nextRunAt: Date }
  /** Its loop ended: no run starts again. */
  | { readonly kind: "over"; readonly ended: TaskEnd["ended"] };

/** One task as the table shows it. */
export interface TaskState {
  readonly taskId: string;
  readonly cell: string;
  readonly phase: TaskPhase;
  /** Its latest run that ended, if any. */
  readonly last?: EndedRun;
  /** Its latest attempt began no run, and why; cleared by the next run's begin. */
  readonly notStarted?: RunNotStarted["why"];
}

/** Every selected task, in the config's order. */
export type Board = readonly TaskState[];

/** A task as the board is made from. */
export interface BoardTask {
  readonly id: string;
  readonly cell: string;
}

/**
 * The board as the loops start: every task waiting.
 *
 * @param tasks - the selected tasks, in the config's order.
 * @returns the board.
 */
export function createBoard(tasks: readonly BoardTask[]): Board {
  return tasks.map((task) => ({
    taskId: task.id,
    cell: task.cell,
    phase: { kind: "waiting" },
  }));
}

/**
 * The board after an activity. An activity for a task the board does not hold, or for a run that is
 * not the task's run in flight (a late stop, a repeated end), leaves it as it is.
 *
 * @param board - the board.
 * @param activity - what a task's loop told.
 * @returns the new board; the same one when nothing changed.
 */
export function applyActivity(board: Board, activity: TaskActivity): Board {
  return updateTask(board, activity.taskId, (task) => nextTask(task, activity));
}

/**
 * The board after a run's progress was read.
 *
 * @param board - the board.
 * @param taskId - the run's task.
 * @param runId - the run.
 * @param progress - its progress now.
 * @returns the new board; the same one when the run is no longer in flight.
 */
export function applyProgress(
  board: Board,
  taskId: string,
  runId: string,
  progress: RunProgress,
): Board {
  return updateTask(board, taskId, (task) =>
    task.phase.kind === "run" && task.phase.run.id === runId
      ? {
          ...task,
          phase: { kind: "run", run: { ...task.phase.run, progress } },
        }
      : task,
  );
}

/**
 * The runs in flight, for the tail to follow.
 *
 * @param board - the board.
 * @returns each task's run in flight, with its task's id.
 */
export function liveRuns(
  board: Board,
): readonly (LiveRun & { readonly taskId: string })[] {
  return board.flatMap((task) =>
    task.phase.kind === "run"
      ? [{ ...task.phase.run, taskId: task.taskId }]
      : [],
  );
}

/** What a run in flight shows as its state. */
export type RunState =
  | { readonly kind: "starting" }
  | { readonly kind: "setup"; readonly ended: number; readonly total: number }
  | { readonly kind: "running" }
  | { readonly kind: "stopping" };

/**
 * A run in flight's state.
 *
 * @param run - the run.
 * @returns `stopping` once a stop reached it; else `running` when its stream is past the cap;
 *   `starting` before `run.begin`; `setup n/m` while setups are still ending, no scenario has begun
 *   or ended and `run.end` is not read; `running` otherwise.
 */
export function runState(run: LiveRun): RunState {
  if (run.stopping) return { kind: "stopping" };
  const { progress } = run;
  if (progress.tooLarge) return { kind: "running" };
  if (!progress.begun) return { kind: "starting" };
  const scenariosStarted = progress.running > 0 || progress.done > 0;
  // Once `run.end` is read, setups that never ended (a dependency failed) never will.
  if (
    !progress.finished &&
    progress.setupsEnded < progress.setups &&
    !scenariosStarted
  )
    return {
      kind: "setup",
      ended: progress.setupsEnded,
      total: progress.setups,
    };
  return { kind: "running" };
}

/**
 * A task after an activity of its own.
 *
 * @param task - the task.
 * @param activity - the activity.
 * @returns the task, changed or not.
 */
function nextTask(task: TaskState, activity: TaskActivity): TaskState {
  const { phase } = task;
  switch (activity.kind) {
    case "begun": {
      if (phase.kind === "over") return task;
      const { notStarted: _cleared, ...rest } = task;
      return {
        ...rest,
        phase: {
          kind: "run",
          run: {
            id: activity.id,
            reportDir: activity.reportDir,
            startedAt: activity.startedAt,
            stopping: false,
            progress: NO_PROGRESS,
          },
        },
      };
    }
    case "stopping":
      if (phase.kind !== "run" || phase.run.id !== activity.id) return task;
      if (phase.run.stopping && phase.run.stopLevel === activity.level)
        return task;
      return {
        ...task,
        phase: {
          kind: "run",
          run: { ...phase.run, stopping: true, stopLevel: activity.level },
        },
      };
    case "notStarted":
      if (phase.kind === "over" || task.notStarted === activity.why)
        return task;
      return { ...task, notStarted: activity.why };
    case "ended": {
      if (phase.kind !== "run" || phase.run.id !== activity.id) return task;
      return {
        ...task,
        phase: { kind: "ended" },
        last: endedRun(phase.run, activity),
      };
    }
    case "cooling":
      if (phase.kind === "over") return task;
      return {
        ...task,
        phase: { kind: "cooling", nextRunAt: activity.nextRunAt },
      };
    case "loopEnded":
      return { ...task, phase: { kind: "over", ended: activity.ended } };
    default:
      return task;
  }
}

/**
 * A run's end, as the table keeps it.
 *
 * @param run - the run, as it was in flight.
 * @param activity - its end.
 * @returns the ended run.
 */
function endedRun(
  run: LiveRun,
  activity: Extract<TaskActivity, { kind: "ended" }>,
): EndedRun {
  const durationMs = activity.endedAt.getTime() - run.startedAt.getTime();
  return {
    id: run.id,
    status: activity.status,
    ...(Number.isFinite(durationMs)
      ? { durationMs: Math.max(0, durationMs) }
      : {}),
    ...(activity.scenarios === undefined
      ? {}
      : { scenarios: activity.scenarios }),
  };
}

/**
 * The board with one task replaced.
 *
 * @param board - the board.
 * @param taskId - the task.
 * @param change - its new value from its old.
 * @returns the new board; the same one when the task is unknown or unchanged.
 */
function updateTask(
  board: Board,
  taskId: string,
  change: (task: TaskState) => TaskState,
): Board {
  const index = board.findIndex((task) => task.taskId === taskId);
  const task = board[index];
  if (task === undefined) return board;
  const next = change(task);
  if (next === task) return board;
  return board.map((each, i) => (i === index ? next : each));
}
