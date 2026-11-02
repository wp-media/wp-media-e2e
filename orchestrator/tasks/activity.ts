import type { RunStatus } from "../runs/outcome";
import type { StopLevel } from "../runs/stop";
import type { TaskEnd } from "./loop";

/**
 * What a task's loop and its runs tell whoever watches them (`CycleDeps.onActivity`): the start, to
 * know its own runs, and the status table, to follow each task. Told as it happens, never read back;
 * a listener that throws, or returns a promise that rejects, costs a line, never the run.
 */

/** A run was numbered, not stopped, and is about to launch: from here it has a folder and a report. */
export interface RunBegun {
  readonly kind: "begun";
  readonly taskId: string;
  /** `bpng-12`. */
  readonly id: string;
  /** Its `RUN_ID`, which its results stream's `run.begin` names. */
  readonly runId: string;
  /** Where its results stream (`results.jsonl`) will be written: absolute. */
  readonly reportDir: string;
  readonly startedAt: Date;
}

/** A stop reached a run that had begun and not ended; told again for each further stop. */
export interface RunStopping {
  readonly kind: "stopping";
  readonly taskId: string;
  readonly id: string;
  readonly level: StopLevel;
}

/**
 * A run that had begun is over, whichever way it ended: told once its end was recorded, published
 * and its folders pruned — or, when the cycle failed after its begin, at once (`error`).
 */
export interface RunEnded {
  readonly kind: "ended";
  readonly taskId: string;
  readonly id: string;
  readonly status: RunStatus;
  readonly endedAt: Date;
  /** The scenarios its `run.finished` counted; absent when it has none. */
  readonly scenarios?: number;
}

/**
 * An attempt that never began a run — no number, no identity, a stop before its launch, or a failure
 * before `begun` —, so no `begun` or `ended` is told for it; told by the loop as the attempt settles.
 */
export interface RunNotStarted {
  readonly kind: "notStarted";
  readonly taskId: string;
  /** `stopped`: a stop came first; `failed`: anything else. */
  readonly why: "stopped" | "failed";
}

/** The loop cools down until `nextRunAt`. */
export interface TaskCooling {
  readonly kind: "cooling";
  readonly taskId: string;
  readonly nextRunAt: Date;
}

/** The loop ended: no run of the task starts again. */
export interface TaskLoopEnded {
  readonly kind: "loopEnded";
  readonly taskId: string;
  readonly ended: TaskEnd["ended"];
}

/** Everything a task's loop tells. */
export type TaskActivity =
  | RunBegun
  | RunStopping
  | RunEnded
  | RunNotStarted
  | TaskCooling
  | TaskLoopEnded;

/** Told each activity of a task as it happens; synchronous — it must not hold the loop. */
export type ActivityListener = (activity: TaskActivity) => undefined;

/**
 * Whether a value is a promise, or anything `await` would treat as one.
 *
 * @param value - any value.
 * @returns `true` when it has a `then` method.
 */
export function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Calls a listener, what it returns read as `unknown`: typed `undefined`, but an async listener still
 * compiles where its type is lost, and its promise must be seen.
 *
 * @param listener - the listener, if any.
 * @param activity - what happened.
 * @returns what it returned; `undefined` without a listener.
 */
export function callListener(
  listener: ActivityListener | undefined,
  activity: TaskActivity,
): unknown {
  const call = listener as ((activity: TaskActivity) => unknown) | undefined;
  return call?.(activity);
}

/**
 * Tells a listener an activity: a throw, or a rejection of a promise it returns against its type,
 * goes to `onFailure` — never up to the loop, never unhandled.
 *
 * @param listener - the listener, if any.
 * @param activity - what happened.
 * @param onFailure - told what the listener threw or rejected with; must not throw.
 */
export function tellActivity(
  listener: ActivityListener | undefined,
  activity: TaskActivity,
  onFailure: (error: unknown) => void,
): void {
  try {
    const told = callListener(listener, activity);
    if (isThenable(told)) told.then(undefined, onFailure);
  } catch (error) {
    onFailure(error);
  }
}
