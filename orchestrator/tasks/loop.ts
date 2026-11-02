import {
  MAX_COOLDOWN_MINUTES,
  MIN_COOLDOWN_MINUTES,
  type TaskConfig,
} from "../config/schema";
import { clockTime } from "../log";
import { MAX_REASON_LENGTH } from "../runs/outcome";
import type { StopLevel } from "../runs/stop";
import { callListener, tellActivity, type TaskActivity } from "./activity";
import { failureLine, safeLine } from "../text";
import type { HeldCell } from "../state/cell-lock";
import type { RunNaming } from "../state/lock";
import {
  runOnce,
  type CycleDeps,
  type CycleTask,
  type RunHandle,
  type RunResult,
} from "./cycle";
import {
  furtherStop,
  MAX_RUN_FAILURE_LENGTH,
  type StopAsked,
} from "./run-lines";

/**
 * A task's loop: a run (`cycle.ts`), then the cooldown, counted from the run's end, then the next run
 * — until it is stopped, or after its one run with `--once`.
 *
 * Its states: **running** (a run's handle held, so a stop reaches it), **cooling** (one timer armed,
 * which a stop clears and ends at once), **ended**. A stop is remembered (the furthest wins), handed to
 * the run in flight — or to one just created, should it arrive while `runOnce` is called —, ends a
 * cooldown, and keeps every later run from starting; the loop then ends once the run in flight has.
 * Nothing it calls escapes: a failure is a masked line, and `done` never rejects. With `takeCell`, it
 * holds its cell's site locks from before its first run to its end, naming each run in them.
 */

/** The longest wait a Node timer takes as asked: past it, Node fires after 1 ms instead. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** A task, as its loop needs it: one run's fields and the cooldown. */
export type LoopTask = CycleTask & Pick<TaskConfig, "cooldownMinutes">;

/** The timers the cooldown is waited with: Node's, or a spec's. */
export interface CooldownTimers {
  /**
   * Arms a timer.
   *
   * @param callback - called once `ms` have passed.
   * @param ms - how long, in milliseconds.
   * @returns its handle, for {@link CooldownTimers.clearTimeout}.
   */
  setTimeout(callback: () => void, ms: number): unknown;
  /**
   * Disarms a timer; one already fired or cleared is left as it is.
   *
   * @param handle - what {@link CooldownTimers.setTimeout} returned.
   */
  clearTimeout(handle: unknown): void;
}

/**
 * Node's timers. Kept referenced on purpose: while every task cools down, the cooldown is all that
 * keeps the process alive — a signal handler does not.
 */
export const NODE_COOLDOWN_TIMERS: CooldownTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/** What a loop needs: one run's deps (handed to each run as they are), and its own. */
export interface LoopDeps extends CycleDeps {
  /** One run, then the loop ends (`--once`). */
  readonly once?: boolean;
  /** Starts one run; `runOnce` by default. */
  readonly runOnce?: (task: CycleTask, deps: CycleDeps) => RunHandle;
  /** The cooldown's timers; {@link NODE_COOLDOWN_TIMERS} by default. */
  readonly timers?: CooldownTimers;
  /**
   * Takes the task's cell's site locks (`CellLocks.acquire` for its cell), held from the loop's start
   * to its end: two orchestrators never take turns on a site through each other's cooldowns. A refusal
   * ends the loop `failed` before any run, said once. Without it the loop holds no lock — for specs of
   * the loop alone.
   */
  readonly takeCell?: () => Promise<HeldCell>;
}

/** The longest refusal of a cell's site locks said, in code points: it names the holder and the way out. */
const MAX_CELL_REFUSAL_LENGTH = 1_500;

/** The longest failure to name a run in its cell's site locks said, in code points: a short cause. */
const MAX_NAMING_FAILURE_LENGTH = 200;

/**
 * A task's loop, for `--once`'s exit code: `passed` when its run passed or was flaky, `stopped` when
 * the loop was stopped, `failed` otherwise — a run that failed, could not test (`error`), was stopped
 * or killed by anything but this loop, or never started.
 */
export type OnceVerdict = "passed" | "failed" | "stopped";

/** How a loop ended. */
export interface TaskEnd {
  /**
   * `stopped`: a stop ended it; `once`: its one run is over; `failed`: the loop itself broke — a
   * cooldown that is not whole minutes within the config's bounds (before any run), timers that
   * cannot arm, a clock that throws, a run whose processes could not be watched to their end (they
   * may still run, so the cell is not run again) —, never expected, said in the log.
   */
  readonly ended: "stopped" | "once" | "failed";
  /** Its last run's result; absent when it ended before any run was asked for. */
  readonly last?: RunResult;
  /** What `--once` makes of it ({@link onceVerdict}); `failed` whenever the loop broke. */
  readonly verdict: OnceVerdict;
}

/** A loop under way. */
export interface TaskLoop {
  /**
   * Stops it: no run starts from now on; the run in flight, if any, is stopped this far (`runOnce`'s
   * own rule: a drain, one SIGINT, SIGKILL of the group) and the loop ends once it has; a cooldown
   * ends at once, its timer cleared. Each call is handed to the run in flight, so the escalation
   * (one, two, three SIGINTs) reaches it; a run created later gets the furthest asked. Once the loop
   * has ended, it does nothing. Never throws.
   *
   * @param level - how far.
   * @param why - why, for the run's reason and the log: `the orchestrator was stopped (SIGINT)`.
   */
  stop(level: StopLevel, why: string): void;
  /** Settles once the loop has ended, its last run recorded and announced. Never rejects. */
  readonly done: Promise<TaskEnd>;
}

/**
 * `--once`'s verdict of one loop.
 *
 * @param result - its last run's result, if any.
 * @param stopped - whether it was stopped.
 * @returns the verdict: a stop wins, then only a run that ended `passed` or `flaky` passes.
 */
export function onceVerdict(
  result: RunResult | undefined,
  stopped: boolean,
): OnceVerdict {
  if (stopped) return "stopped";
  return result?.kind === "ended" &&
    (result.status === "passed" || result.status === "flaky")
    ? "passed"
    : "failed";
}

/**
 * The orchestrator's exit code from its loops' verdicts: `130` when any was stopped, else `1` when
 * any failed, else `0`.
 *
 * @param verdicts - every loop's verdict.
 * @returns the exit code.
 */
export function onceExitCode(verdicts: readonly OnceVerdict[]): 0 | 1 | 130 {
  if (verdicts.includes("stopped")) return 130;
  return verdicts.includes("failed") ? 1 : 0;
}

/**
 * Why a cooldown cannot be waited: whole minutes within the config's bounds, or nothing.
 *
 * @param minutes - the task's cooldown.
 * @returns the problem, or `undefined` when it is valid.
 */
export function cooldownProblem(minutes: number): string | undefined {
  return Number.isInteger(minutes) &&
    minutes >= MIN_COOLDOWN_MINUTES &&
    minutes <= MAX_COOLDOWN_MINUTES
    ? undefined
    : `must be a whole number of minutes from ${String(MIN_COOLDOWN_MINUTES)} to ${String(MAX_COOLDOWN_MINUTES)}`;
}

/**
 * How long to cool down: the cooldown, counted from `from`, never less than nothing and never more
 * than the cooldown — a clock stepped back, or a `from` that is not a time, waits the cooldown from
 * now. Total: always within `[0, min(cooldown, MAX_TIMER_MS)]`, a cooldown that is not a number
 * waiting nothing.
 *
 * @param from - when the run ended.
 * @param now - now.
 * @param cooldownMs - the cooldown.
 * @returns the wait, in milliseconds.
 */
export function cooldownDelay(
  from: Date,
  now: Date,
  cooldownMs: number,
): number {
  if (Number.isNaN(cooldownMs)) return 0;
  const cap = Math.min(Math.max(cooldownMs, 0), MAX_TIMER_MS);
  const left = from.getTime() + cooldownMs - now.getTime();
  if (!Number.isFinite(left)) return cap;
  return Math.min(Math.max(left, 0), cap);
}

/**
 * The cooldown's line: `next run 11:14:42 (cooldown 5m)`, in local time as the log's clock.
 *
 * @param at - when the next run starts.
 * @param minutes - the task's cooldown.
 * @returns the line.
 */
export function nextRunLine(at: Date, minutes: number): string {
  return `next run ${clockTime(at)} (cooldown ${String(minutes)}m)`;
}

/**
 * Starts a task's loop. Its first run starts on a later turn, so a stop asked right after this
 * returns starts none.
 *
 * @param task - the task.
 * @param deps - one run's deps, and the loop's own.
 * @returns the loop's handle, at once.
 *
 * @example
 * ```ts
 * const loop = runTask(task, deps);
 * shutdown = createShutdown({ onEscalate: (level, why) => { loop.stop(level, why); } });
 * const end = await loop.done; // { ended: "stopped", last: { kind: "ended", … }, verdict: "stopped" }
 * ```
 */
export function runTask(task: LoopTask, deps: LoopDeps): TaskLoop {
  const loop = new Loop(task, deps);
  return {
    stop: (level, why) => {
      loop.stop(level, why);
    },
    done: Promise.resolve().then(() => loop.run()),
  };
}

/** A run's result, and when the loop saw it settle. */
interface Settled {
  readonly result: RunResult;
  readonly at: Date;
}

/** One task's loop: the stop asked for, the run in flight, the cooldown's wake-up. */
class Loop {
  /** The furthest stop asked for so far, its reason already masked. */
  private asked: StopAsked | undefined;
  /** The run in flight: what a stop is handed to. */
  private current: RunHandle | undefined;
  /** Ends the cooldown in progress, if one is. */
  private wake: (() => void) | undefined;
  /** The clock: `deps.now`, else the system's. */
  private readonly now: () => Date;
  /** Set once a run's processes may outlive the loop: its site locks are then kept. */
  private keepCell = false;
  /** Why a run could not be named in the site locks, once one could not: the loop then ends. */
  private cellLost: string | undefined;

  /**
   * @param task - the task.
   * @param deps - its deps.
   */
  constructor(
    private readonly task: LoopTask,
    private readonly deps: LoopDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Remembers the stop — made one masked line within {@link MAX_REASON_LENGTH} —, hands it to the
   * run in flight, and ends a cooldown.
   *
   * @param level - how far.
   * @param why - why.
   */
  stop(level: StopLevel, why: string): void {
    const asked = {
      level,
      why: safeLine(why, MAX_REASON_LENGTH, this.deps.secrets),
    };
    this.asked = furtherStop(this.asked, asked);
    this.forward(asked);
    this.wake?.();
  }

  /**
   * Runs the loop; whatever escapes ends it, said in the log.
   *
   * @returns how it ended.
   */
  async run(): Promise<TaskEnd> {
    const problem = cooldownProblem(this.task.cooldownMinutes);
    if (problem !== undefined) {
      const value = safeLine(
        String(this.task.cooldownMinutes),
        40,
        this.deps.secrets,
      );
      this.say(`no run: the task's cooldown (${value}) ${problem}`);
      return this.end("failed", undefined);
    }
    if (this.stopAsked()) return this.end("stopped", undefined);
    const cell = await this.takeCell();
    if (cell === "refused") return this.end("failed", undefined);
    try {
      return await this.cycles(cell);
    } finally {
      await this.giveBack(cell);
    }
  }

  /**
   * The task's cell's site locks, taken; a refusal is said once.
   *
   * @returns the locks; `undefined` with none to take; `refused` when they could not be had.
   */
  private async takeCell(): Promise<HeldCell | undefined | "refused"> {
    const { takeCell } = this.deps;
    if (takeCell === undefined) return undefined;
    try {
      return await takeCell();
    } catch (error) {
      this.say(
        `not started: ${failureLine(error, MAX_CELL_REFUSAL_LENGTH, this.deps.secrets)}`,
      );
      return "refused";
    }
  }

  /**
   * Gives the cell's site locks back as the loop ends — unless a run's processes may still live; one
   * that could not be is said.
   *
   * @param cell - the locks, if any.
   */
  private async giveBack(cell: HeldCell | undefined): Promise<void> {
    if (cell === undefined || this.keepCell) return;
    try {
      if (await cell.release()) return;
    } catch {
      // Said below: release is not to throw.
    }
    this.say(
      "its cell's site locks were not all removed: gone, another's, or could not be",
    );
  }

  /**
   * Names a run in the cell's site locks before its launch. A lock lost, or one that could not be
   * rewritten — `setRun` rejecting, against its contract, included —, ends the loop after that run —
   * fail-safe: no run starts unnamed in its sites' locks — and the words say which.
   *
   * @param cell - the locks.
   * @param record - the run's `run.json`.
   * @returns `undefined` once named; else why not. Never rejects.
   */
  private async claim(
    cell: HeldCell,
    record: string,
  ): Promise<string | undefined> {
    const naming = await this.nameRun(cell, record);
    if (naming.kind === "named") return undefined;
    this.cellLost =
      naming.kind === "lost"
        ? "its cell's site locks are no longer this orchestrator's — removed, or another's"
        : `its cell's site locks could not be rewritten to name the run (${naming.why}): they are still this orchestrator's, but no run starts unnamed in them`;
    return this.cellLost;
  }

  /**
   * `cell.setRun`, a rejection made a `failed` naming: the locks may still be this orchestrator's,
   * but the run is not named in them.
   *
   * @param cell - the locks.
   * @param record - the run's `run.json`.
   * @returns what naming the run came to.
   */
  private async nameRun(cell: HeldCell, record: string): Promise<RunNaming> {
    try {
      return await cell.setRun(record);
    } catch (error) {
      return {
        kind: "failed",
        why: failureLine(error, MAX_NAMING_FAILURE_LENGTH, this.deps.secrets),
      };
    }
  }

  /**
   * The runs, one after another with the cooldown between, holding the cell's site locks.
   *
   * @param cell - the locks, if any.
   * @returns how the loop ended.
   */
  private async cycles(cell: HeldCell | undefined): Promise<TaskEnd> {
    let last: RunResult | undefined;
    const deps: CycleDeps =
      cell === undefined
        ? this.deps
        : { ...this.deps, claimCell: (record) => this.claim(cell, record) };
    try {
      for (;;) {
        if (this.stopAsked()) return this.end("stopped", last);
        const settled = await this.cycle(deps);
        last = settled.result;
        if (last.kind === "ended" && last.unwatched === true) {
          // Its processes may still run on the cell: no run of it may start beside them.
          this.keepCell = true;
          this.say(
            `no next run: ${last.id}'s processes could not be watched to their end and may still run — its cell stays locked, and the next start's orphan check judges them`,
          );
          return this.end("failed", last);
        }
        if (this.cellLost !== undefined) {
          this.say(`no next run: ${this.cellLost}`);
          return this.end("failed", last);
        }
        if (this.stopAsked()) return this.end("stopped", last);
        if (this.deps.once === true) return this.end("once", last);
        await this.cooldown(settled);
      }
    } catch (error) {
      this.say(`the loop failed, no next run: ${this.failure(error)}`);
      return this.end("failed", last);
    }
  }

  /**
   * One run: created, held where a stop reaches it, waited for. A `runOnce` that throws, or a `done`
   * that rejects — both against its contract — is a line and a run that did not start. An attempt
   * that ends with no run begun is told (`notStarted`).
   *
   * @param deps - the run's deps: the loop's, with `claimCell` naming the run in the cell's locks.
   * @returns its result, and when it settled.
   */
  private async cycle(deps: CycleDeps): Promise<Settled> {
    let result: RunResult;
    const seen = { begun: false };
    const listener = deps.onActivity;
    const watched: CycleDeps = {
      ...deps,
      onActivity: (activity) => {
        if (activity.kind === "begun") seen.begun = true;
        // Passed through as it is: the run's `tell` catches its throw and its rejection.
        return callListener(listener, activity) as undefined;
      },
    };
    try {
      const handle = (this.deps.runOnce ?? runOnce)(this.task, watched);
      this.current = handle;
      // Asked while the run was being created: it has not seen it yet.
      if (this.asked !== undefined) this.forward(this.asked);
      result = await handle.done;
    } catch (error) {
      this.say(`the run failed: ${this.failure(error)}`);
      result = { kind: "notStarted", why: "failed" };
    } finally {
      this.current = undefined;
    }
    // An attempt that began no run told nothing: say so, or the table would show the last run alone.
    if (!seen.begun && result.kind === "notStarted")
      this.tell(
        { kind: "notStarted", taskId: this.task.id, why: result.why },
        "its attempt did not start",
      );
    return { result, at: this.now() };
  }

  /**
   * Waits the cooldown, counted from the run's end — or, for a run that never started, from when the
   * attempt settled: there was no end, and counting from then still keeps a failing start from
   * hammering. Says when the next run starts. A stop ends it at once.
   *
   * @param settled - the run's result, and when it settled.
   */
  private async cooldown({ result, at }: Settled): Promise<void> {
    const minutes = this.task.cooldownMinutes;
    const from = result.kind === "ended" ? result.endedAt : at;
    const now = this.now();
    const ms = cooldownDelay(from, now, minutes * 60_000);
    const nextRunAt = new Date(now.getTime() + ms);
    this.say(nextRunLine(nextRunAt, minutes));
    this.tell(
      { kind: "cooling", taskId: this.task.id, nextRunAt },
      "its loop cools down",
    );
    await this.wait(ms);
  }

  /**
   * Waits, ended early by a stop — even one asked while the timer is armed. Leaves no timer behind.
   *
   * @param ms - how long.
   * @returns once the time is up or a stop came; rejects only when the timer cannot be armed.
   */
  private wait(ms: number): Promise<void> {
    const timers = this.deps.timers ?? NODE_COOLDOWN_TIMERS;
    return new Promise<void>((resolve, reject) => {
      // Read through an object: a stop changes it from within `setTimeout`.
      const state: { timer?: unknown; finished: boolean } = { finished: false };
      /** Ends the wait once — the timer's or a stop's — disarming the timer and dropping the wake. */
      const finish = (): void => {
        if (state.finished) return;
        state.finished = true;
        this.wake = undefined;
        if (state.timer !== undefined) timers.clearTimeout(state.timer);
        state.timer = undefined;
        resolve();
      };
      this.wake = finish;
      let armed: unknown;
      try {
        armed = timers.setTimeout(() => {
          state.timer = undefined;
          finish();
        }, ms);
      } catch (error) {
        state.finished = true;
        this.wake = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // Finished while it was armed (a stop from within): the timer is not kept.
      if (state.finished) timers.clearTimeout(armed);
      else state.timer = armed;
      if (this.stopAsked()) finish();
    });
  }

  /**
   * Ends the loop; a stop says there is no next run.
   *
   * @param ended - why it ended.
   * @param last - its last run's result.
   * @returns how it ended.
   */
  private end(ended: TaskEnd["ended"], last: RunResult | undefined): TaskEnd {
    const asked = this.asked;
    if (ended === "stopped" && asked !== undefined)
      this.say(`no next run: ${asked.why}`);
    this.tell(
      { kind: "loopEnded", taskId: this.task.id, ended },
      "its loop ended",
    );
    return {
      ended,
      ...(last === undefined ? {} : { last }),
      // A loop that broke failed, whatever its last run said.
      verdict:
        ended === "failed" ? "failed" : onceVerdict(last, asked !== undefined),
    };
  }

  /**
   * Whether a stop was asked: read through a call, since it changes while the loop awaits.
   *
   * @returns `true` once one was.
   */
  private stopAsked(): boolean {
    return this.asked !== undefined;
  }

  /**
   * Hands a stop to the run in flight, if any; a handle that throws is a line.
   *
   * @param asked - the stop.
   */
  private forward(asked: StopAsked): void {
    if (this.current === undefined) return;
    try {
      this.current.stop(asked.level, asked.why);
    } catch (error) {
      this.say(`stopping the run failed: ${this.failure(error)}`);
    }
  }

  /**
   * Tells `onActivity` what the loop did; a listener that throws is a line.
   *
   * @param activity - what it did.
   * @param what - how the line words it: `its loop cools down`, `its loop ended`, `its attempt did
   *   not start`.
   */
  private tell(activity: TaskActivity, what: string): void {
    tellActivity(this.deps.onActivity, activity, (error) => {
      this.say(`telling that ${what} failed: ${this.failure(error)}`);
    });
  }

  /**
   * Logs a line under the task's id. A logger that throws loses the line, never the loop.
   *
   * @param text - the line.
   */
  private say(text: string): void {
    try {
      this.deps.logger.line(this.task.id, text);
    } catch {
      // Dropped: there is nowhere left to say it.
    }
  }

  /**
   * A failure as one masked line.
   *
   * @param error - what was thrown.
   * @returns the line.
   */
  private failure(error: unknown): string {
    return failureLine(error, MAX_RUN_FAILURE_LENGTH, this.deps.secrets);
  }
}
