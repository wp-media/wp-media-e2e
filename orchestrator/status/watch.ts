import { join } from "node:path";

import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import { isThenable, type TaskActivity } from "../tasks/activity";
import type { CooldownTimers } from "../tasks/loop";
import {
  applyActivity,
  applyProgress,
  createBoard,
  type Board,
  type BoardTask,
} from "./board";
import { ProgressFold } from "./progress";
import { readTail, TAIL_START, type TailRead, type TailState } from "./tail";

/**
 * The status table's source: what the loops tell (`onActivity`) and, for each run in flight, a
 * poll of its results stream (`tail.ts`), folded into the board (`board.ts`) and handed to `show`
 * after each change. Polls only while a run is in flight, one poll at a time, on a timer that never
 * keeps the process alive; a run's tail is dropped as it ends — the poll holds no file open between
 * reads, so nothing is left to close — and is no longer read once its stream passes the end-of-run
 * reader's cap. {@link StatusWatch.stop} ends it on every path, at once: it never waits for a read.
 */

/** How often a run's stream is read, by default: the table changes at most once a second. */
export const STATUS_POLL_MS = 1_000;

/** Node's timers, unref'd: the table never keeps the orchestrator alive. */
export const UNREF_TIMERS: CooldownTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** How a status watch is made. */
export interface StatusWatchOptions {
  /** The selected tasks, in the config's order. */
  readonly tasks: readonly BoardTask[];
  /**
   * Told the board after each change; synchronous. A throw, or a promise it returns against its type
   * that rejects, is dropped: the table must not stop a run.
   */
  readonly show: (board: Board) => undefined;
  /** {@link STATUS_POLL_MS} by default. */
  readonly pollMs?: number;
  /** {@link UNREF_TIMERS} by default. */
  readonly timers?: CooldownTimers;
  /** Reads a stream from a tail's state; {@link readTail} by default. */
  readonly read?: (path: string, state: TailState) => Promise<TailRead>;
}

/** A status watch under way. */
export interface StatusWatch {
  /**
   * Takes what a task's loop told. Never throws.
   *
   * @param activity - the activity.
   */
  tell(activity: TaskActivity): void;
  /** The board now. */
  readonly board: Board;
  /**
   * Stops it, at once: the timer cleared, nothing shown or read after. A read in flight is not waited
   * for — one that never settles must not hold the start's exit —, and what it gives is dropped.
   * Never throws; a second call does nothing.
   */
  stop(): void;
}

/** A run's tail: where its stream is, how far it was read, and what it gave. */
interface RunTail {
  readonly taskId: string;
  readonly path: string;
  /** The run's `RUN_ID`: a stream naming another counts nothing. */
  readonly runId: string;
  state: TailState;
  fold: ProgressFold;
  /** Its stream passed the end-of-run reader's cap: it is read no more. */
  tooLarge: boolean;
}

/**
 * Starts a status watch: shows the board at once, every task waiting.
 *
 * @param options - the tasks, the sink, and the seams.
 * @returns the watch.
 */
export function createStatusWatch(options: StatusWatchOptions): StatusWatch {
  return new Watch(options);
}

/** The watch {@link createStatusWatch} hands out. */
class Watch implements StatusWatch {
  /** The board now. */
  board: Board;
  /** Each run in flight's tail, by run id. */
  private readonly tails = new Map<string, RunTail>();
  /** The armed poll timer, if any. */
  private timer: unknown;
  /** A poll is in flight. */
  private polling = false;
  /** Set once stopped. */
  private stopped = false;
  /** The timers. */
  private readonly timers: CooldownTimers;

  /** @param options - see {@link StatusWatchOptions}. */
  constructor(private readonly options: StatusWatchOptions) {
    this.timers = options.timers ?? UNREF_TIMERS;
    this.board = createBoard(options.tasks);
    this.show();
  }

  /**
   * {@inheritDoc StatusWatch.tell}
   *
   * @param activity - the activity.
   */
  tell(activity: TaskActivity): void {
    if (this.stopped) return;
    if (activity.kind === "begun")
      this.tails.set(activity.id, {
        taskId: activity.taskId,
        path: join(activity.reportDir, RESULTS_FILE),
        runId: activity.runId,
        state: TAIL_START,
        fold: new ProgressFold(activity.runId),
        tooLarge: false,
      });
    else if (activity.kind === "ended") this.tails.delete(activity.id);
    this.board = applyActivity(this.board, activity);
    this.show();
    this.schedule();
  }

  /**
   * {@inheritDoc StatusWatch.stop}
   *
   */
  stop(): void {
    this.stopped = true;
    this.disarm();
    this.tails.clear();
  }

  /** Arms the next poll, unless one is armed or running, nothing is in flight, or it is stopped. */
  private schedule(): void {
    if (
      this.stopped ||
      this.timer !== undefined ||
      this.polling ||
      !this.hasTailToRead()
    )
      return;
    try {
      this.timer = this.timers.setTimeout(() => {
        this.timer = undefined;
        this.polling = true;
        void this.poll().finally(() => {
          this.polling = false;
          this.schedule();
        });
      }, this.options.pollMs ?? STATUS_POLL_MS);
    } catch {
      // No timer, no polling: the table keeps what the loops tell.
      this.timer = undefined;
    }
  }

  /**
   * Whether a run in flight's stream is still read.
   *
   * @returns `true` when one is.
   */
  private hasTailToRead(): boolean {
    for (const tail of this.tails.values()) if (!tail.tooLarge) return true;
    return false;
  }

  /** Clears the armed timer, if any. */
  private disarm(): void {
    if (this.timer === undefined) return;
    try {
      this.timers.clearTimeout(this.timer);
    } catch {
      // Already fired, or gone: nothing to clear.
    }
    this.timer = undefined;
  }

  /**
   * Reads every run in flight's stream once, folds what it gave, and shows the board; stops reading
   * as soon as the watch is stopped. Never rejects.
   */
  private async poll(): Promise<void> {
    const read = this.options.read ?? readTail;
    for (const [id, tail] of [...this.tails]) {
      if (this.stopped) return;
      if (tail.tooLarge) continue;
      let result: TailRead;
      try {
        result = await read(tail.path, tail.state);
      } catch {
        continue;
      }
      // Ended, or stopped (which drops every tail), while it was read: its result is no longer wanted.
      if (this.tails.get(id) !== tail) continue;
      if (result.reset) tail.fold = new ProgressFold(tail.runId);
      tail.state = result.state;
      tail.fold.apply(result.events);
      if (result.tooLarge === true) {
        tail.tooLarge = true;
        tail.fold.markTooLarge();
      }
      this.board = applyProgress(
        this.board,
        tail.taskId,
        id,
        tail.fold.progress(),
      );
    }
    this.show();
  }

  /** Hands the board to the sink, unless stopped; a throw, or a rejection, is dropped. */
  private show(): void {
    if (this.stopped) return;
    try {
      // Typed synchronous, but an async sink still compiles where its type is lost: what it returns is
      // read as `unknown`, so its rejection is never left unhandled.
      const show = this.options.show as (board: Board) => unknown;
      const shown = show(this.board);
      if (isThenable(shown)) shown.then(undefined, () => undefined);
    } catch {
      // The table is best-effort: it never stops what it shows.
    }
  }
}
