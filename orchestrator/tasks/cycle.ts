import type { OrchestratorConfig } from "../config/schema";
import type { EventBus } from "../events/bus";
import { join } from "node:path";

import {
  buildRunFinished,
  type RunFinishedEvent,
  type RunFinishedInput,
} from "../events/run-finished";
import type { Logger } from "../log";
import {
  tellActivity,
  type ActivityListener,
  type TaskActivity,
} from "./activity";
import type { DatatorPayload } from "../notify/datator";
import type { RunCommands } from "../runs/commands";
import { endRun, type RunEnd, type RunEndInput } from "../runs/end";
import { runEnvironment } from "../runs/environment";
import { RUN_FILES, runIdentity, type RunIdentity } from "../runs/identity";
import {
  launchRun,
  type LaunchedRun,
  type LaunchOptions,
  type LaunchResult,
} from "../runs/launch";
import { readLeaderStart, type LeaderStartReader } from "../runs/leader";
import {
  MAX_REASON_LENGTH,
  type RunOutcome,
  type RunStatus,
} from "../runs/outcome";
import {
  createRecordWriter,
  endedRecord,
  leaderProcess,
  recordWords,
  runningRecord,
  startingRecord,
  type RecordWriter,
  type RunningProcess,
  type RunProcessName,
} from "../runs/record";
import { INITIAL_RUN_STOP, stepRunStop, type StopLevel } from "../runs/stop";
import { writeJsonAtomic } from "../state/atomic";
import { nextRunNumber } from "../state/counter";
import {
  describeRunRetention,
  pruneTaskRuns,
  type RunRetentionInput,
  type RunRetentionReport,
} from "../state/run-retention";
import { failureLine, safeLine, textOf } from "../text";
import {
  eventTask,
  furtherStop,
  MAX_RUN_FAILURE_LENGTH,
  notStartedOutcome,
  outcomeLine,
  showPath,
  startedLine,
  type StopAsked,
  unreadOutcome,
  type CycleTask,
} from "./run-lines";

/** A task as one run needs it, for the loop and the orchestrator. */
export type { CycleTask } from "./run-lines";

/**
 * One run of a task, from its number to its `run.finished`: the counter hands out the number, the
 * run is launched with its record written before each process is spawned and once it runs, then its
 * end is read and kept — its `run.finished` and the Datator record it is sent beside its record, then
 * the `ended` record —, told in the log, published, and the task's old run folders pruned.
 *
 * Nothing a dependency does — a throw, a rejection, a logger that fails — escapes: each failure is a
 * masked line of the log, and the run is still recorded and announced wherever it can be. The only
 * runs never recorded are those with no folder of their own: no number could be taken, or the launch
 * refused the folder before anything ran there.
 */

/** How one run ended, for the loop: its status and when, or why there was no run. */
export type RunResult =
  /** It ran — or was given a number and failed to start, which is `error`. */
  | {
      readonly kind: "ended";
      /** `bpng-12`. */
      readonly id: string;
      readonly status: RunStatus;
      /** When its processes had ended: a cooldown counts from here. */
      readonly endedAt: Date;
      /** Its `run.finished`; absent only when not even that could be built. */
      readonly event?: RunFinishedEvent;
      /**
       * Its processes could not be watched to their end, so they may still run: its record is left
       * `running` for the next start's orphan check — and its loop must neither start the cell again
       * nor give back its site locks.
       */
      readonly unwatched?: true;
    }
  /** No run: stopped before its launch, or no number or identity could be had. */
  | { readonly kind: "notStarted"; readonly why: "stopped" | "failed" };

/** A run under way. */
export interface RunHandle {
  /**
   * Stops it at least this far — `launch.ts`'s machine: a drain, one SIGINT, then SIGKILL of the
   * group. Asked before the run's number is taken, nothing starts; asked before `bddgen` is spawned —
   * up to the moment its record says it is starting — nothing is spawned, and the run is recorded and
   * announced `stopped`; asked later, it applies to the run's processes as soon as they exist. A stop
   * that goes no further than one asked before, or comes once the run has ended, does nothing. Never
   * throws.
   *
   * @param level - how far.
   * @param why - why, for the run's reason: `the orchestrator was stopped (SIGINT)`.
   */
  stop(level: StopLevel, why: string): void;
  /** Settles once the run is over, recorded, announced and pruned. Never rejects. */
  readonly done: Promise<RunResult>;
}

/** What one run needs: the orchestrator's state, and every seam a spec replaces. */
export interface CycleDeps {
  /** The state directory: absolute. */
  readonly stateDir: string;
  /** The checkout the runs start in: absolute. */
  readonly checkout: string;
  /** The config's runs settings and secrets, for the run's environment and pruning. */
  readonly config: Pick<OrchestratorConfig, "runs" | "secrets">;
  /** Every secret value the orchestrator holds (`allSecretValues(config, tasks)`), masked in every line. */
  readonly secrets: readonly string[];
  /** The orchestrator's environment: only what `runEnvironment` inherits is read. */
  readonly inherited: Readonly<Record<string, string | undefined>>;
  /** The task's two commands (`suiteCommands` with its product's config). */
  readonly commandsFor: (task: CycleTask) => RunCommands;
  /**
   * The ref the task's runs build, as its started line shows it (`develop (default)`, by the product's
   * manifest, as the dry run says it); without it, or when it gives none, the task's own ref.
   */
  readonly refFor?: (task: CycleTask) => string | undefined;
  readonly logger: Pick<Logger, "line">;
  readonly bus: Pick<EventBus<RunFinishedEvent>, "publish">;
  /** The Datator record of a run, kept in its `datator.json` (`Notifications.datatorPayload`). */
  readonly datatorPayload?: (
    event: RunFinishedEvent,
  ) => DatatorPayload | undefined;
  /** The clock; the system's by default. */
  readonly now?: () => Date;
  /** Hands out the task's next run number; `nextRunNumber` by default. */
  readonly nextNumber?: (stateDir: string, taskId: string) => Promise<number>;
  /** Launches the run; `launchRun` by default. */
  readonly launch?: (options: LaunchOptions) => Promise<LaunchedRun>;
  /** What the launch is given besides the run: `kill`, `sleep`, the poll, the linger and its repeat. */
  readonly launchOptions?: Pick<
    LaunchOptions,
    "kill" | "sleep" | "pollMs" | "lingerMs" | "stuckRepeatMs"
  >;
  /** Reads a process's start; `readLeaderStart` by default. */
  readonly readLeaderStart?: LeaderStartReader;
  /** Reads the run's end; `endRun` by default. */
  readonly end?: (input: RunEndInput) => Promise<RunEnd>;
  /** Makes the run's record writer; `createRecordWriter` by default. */
  readonly recordWriter?: (path: string) => RecordWriter;
  /** Prunes the task's run folders; `pruneTaskRuns` by default. */
  readonly prune?: (input: RunRetentionInput) => Promise<RunRetentionReport>;
  /** Builds a `run.finished` for a run whose end was not read; `buildRunFinished` by default. */
  readonly buildEvent?: (input: RunFinishedInput) => RunFinishedEvent;
  /** Writes a file kept beside the record, atomically and `0600`; `writeJsonAtomic` by default. */
  readonly writeJson?: (path: string, value: unknown) => Promise<void>;
  /**
   * Told what the task's runs do ({@link TaskActivity}): each run as it begins — numbered, not stopped,
   * about to launch, with its report folder and start, so the process knows which runs are its own —,
   * each stop that reaches it, and its end; the loop adds its cooldowns and its own end. A throw is a
   * line, never the run's.
   */
  readonly onActivity?: ActivityListener;
  /**
   * Names the run in its cell's site locks (`HeldCell.setRun`), which its loop holds, just before its
   * launch: `undefined` once named; otherwise why not, in words — or a throw — which ends the run
   * `error`, nothing launched. Without it no lock is named: for specs of the cycle alone.
   */
  readonly claimCell?: (record: string) => Promise<string | undefined>;
}

/** What a run that ended may record: its writer, and how its processes ended. */
interface EndToRecord {
  readonly writer: RecordWriter;
  readonly launch: LaunchResult;
}

/**
 * Starts one run of a task.
 *
 * @param task - the task.
 * @param deps - the orchestrator's state and seams.
 * @returns the run's handle, at once: the number is taken and the run launched behind it.
 *
 * @example
 * ```ts
 * const run = runOnce(task, deps);
 * process.once("SIGINT", () => { run.stop("drained", "the orchestrator was stopped (SIGINT)"); });
 * const result = await run.done; // { kind: "ended", id: "bpng-12", status: "passed", … }
 * ```
 */
export function runOnce(task: CycleTask, deps: CycleDeps): RunHandle {
  const cycle = new Cycle(task, deps);
  return {
    stop: (level, why) => {
      cycle.stop(level, why);
    },
    // Begun on a later turn, so a stop asked right after this returns keeps even the number untaken.
    done: Promise.resolve().then(() => cycle.run()),
  };
}

/** The longest cell lock refusal or stuck group's line said, in code points: each names the way out. */
const MAX_CELL_REFUSAL_LENGTH = 1_500;

/** How `bddgen` ended when it was never spawned. */
const NOTHING_RAN: LaunchResult["bddgen"] = { code: null, signal: null };

/** One run's state: the stop asked for, the launched run once there is one. */
class Cycle {
  /** The furthest stop asked for so far, its reason already masked. */
  private asked: StopAsked | undefined;
  /** The launched run, once `launchRun` has handed it out: what a stop is forwarded to. */
  private launched: LaunchedRun | undefined;
  /** The clock: `deps.now`, else the system's. */
  private readonly now: () => Date;
  /** The run's id once it has begun and until its end is told: only then is a stop told. */
  private begunId: string | undefined;

  /**
   * @param task - the task.
   * @param deps - the orchestrator's state and seams.
   */
  constructor(
    private readonly task: CycleTask,
    private readonly deps: CycleDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * Remembers the stop, and hands it to the launched run when there is one. Its `why` is made one
   * safe line here, masked and within {@link MAX_REASON_LENGTH}: from here it reaches the run's log,
   * its records, its event and every line, as its stop and as its reason.
   *
   * @param level - how far.
   * @param why - why.
   */
  stop(level: StopLevel, why: string): void {
    const safe = safeLine(why, MAX_REASON_LENGTH, this.deps.secrets);
    this.asked = furtherStop(this.asked, { level, why: safe });
    this.forward();
    const id = this.begunId;
    if (id !== undefined)
      this.tell(
        // The level in force: a lesser stop after a greater one does not lower it.
        { kind: "stopping", taskId: this.task.id, id, level: this.asked.level },
        "is stopping",
      );
  }

  /**
   * Runs it; whatever escapes is a line, and no run.
   *
   * @returns how it ended.
   */
  async run(): Promise<RunResult> {
    let result: RunResult;
    try {
      result = await this.cycle();
    } catch (error) {
      this.say(`the run failed: ${this.failure(error)}`);
      result = { kind: "notStarted", why: "failed" };
    }
    this.tellEnded(result);
    return result;
  }

  /**
   * Tells the end of a run that had begun — every way it can end, an unexpected failure (`error`)
   * included —, once; a run that never began has none to tell.
   *
   * @param result - how it ended.
   */
  private tellEnded(result: RunResult): void {
    const id = this.begunId;
    if (id === undefined) return;
    this.begunId = undefined;
    const scenarios =
      result.kind === "ended" ? result.event?.counts.total : undefined;
    this.tell(
      {
        kind: "ended",
        taskId: this.task.id,
        id,
        status: result.kind === "ended" ? result.status : "error",
        endedAt: result.kind === "ended" ? result.endedAt : this.now(),
        ...(scenarios === undefined ? {} : { scenarios }),
      },
      "ended",
    );
  }

  /**
   * The run, from its number to its pruning.
   *
   * @returns how it ended.
   */
  private async cycle(): Promise<RunResult> {
    if (this.stopAsked() !== undefined)
      return { kind: "notStarted", why: "stopped" };
    const identity = await this.identity();
    if (identity === undefined) return { kind: "notStarted", why: "failed" };
    // Asked while the number was taken: the number is spent, but nothing starts.
    const asked = this.stopAsked();
    if (asked !== undefined) {
      this.say(`${identity.id} not started: ${asked.why}`);
      return { kind: "notStarted", why: "stopped" };
    }
    this.begun(identity);
    const refusal = await this.claimCell(identity);
    if (refusal !== undefined) return this.cellRefused(identity, refusal);
    return this.launchAndEnd(identity);
  }

  /**
   * Names the run in its cell's site locks, which its loop holds, before anything is launched.
   *
   * @param identity - the run.
   * @returns `undefined` once named (or with no locks to name it in); else why not.
   */
  private async claimCell(identity: RunIdentity): Promise<unknown> {
    const { claimCell } = this.deps;
    if (claimCell === undefined) return undefined;
    try {
      const refusal = await claimCell(identity.record);
      return refusal === undefined ? undefined : new Error(refusal);
    } catch (error) {
      return error;
    }
  }

  /**
   * Launches the run and waits for its end.
   *
   * @param identity - the run.
   * @returns how it ended.
   */
  private async launchAndEnd(identity: RunIdentity): Promise<RunResult> {
    const writer = (this.deps.recordWriter ?? createRecordWriter)(
      identity.record,
    );
    // `ours` once the launch has made the run's folder its own: only then is a record written there.
    // `stopped` when a stop kept `bddgen` from being spawned.
    const folder = { ours: false, stopped: false };
    try {
      this.launched = await (this.deps.launch ?? launchRun)({
        identity,
        commands: this.deps.commandsFor(this.task),
        cwd: this.deps.checkout,
        env: runEnvironment({
          inherited: this.deps.inherited,
          task: this.task,
          config: this.deps.config,
          runId: identity.runId,
          stopFile: identity.stopFile,
        }),
        onSpawning: async (name) => {
          folder.ours = true;
          await this.recordStarting(identity, writer, name);
          // Once the launch has handed out the run, a stop reaches it; before, only this keeps it.
          if (name === "bddgen" && this.stopAsked() !== undefined) {
            folder.stopped = true;
            throw new Error("stopped before bddgen was spawned");
          }
        },
        onProcess: (name, pgid) =>
          this.recordProcess(identity, writer, name, pgid),
        // A group that will not empty holds the run and its cell: said where the operator looks.
        onStuck: (text) => {
          this.say(
            `${identity.id}: ${safeLine(text, MAX_CELL_REFUSAL_LENGTH, this.deps.secrets)}`,
          );
        },
        now: this.now,
        ...this.deps.launchOptions,
      });
    } catch (error) {
      const asked = this.stopAsked();
      if (folder.stopped && asked !== undefined)
        return this.stoppedBeforeSpawn(identity, writer, asked);
      return this.notLaunched(
        identity,
        folder.ours ? writer : undefined,
        error,
      );
    }
    this.forward();
    this.say(
      startedLine(
        identity.id,
        this.task,
        this.show(identity.log),
        this.deps.refFor?.(this.task),
      ),
    );
    return this.ended(identity, writer, this.launched);
  }

  /**
   * A run its cell's site locks could not be made to name — they are no longer this orchestrator's:
   * nothing was launched and the run has no folder; the refusal is said whole, and the run ends `error`
   * with it as its reason, its event pointing at no report or log.
   *
   * @param identity - the run.
   * @param error - the refusal.
   * @returns how it ended: `error`.
   */
  private cellRefused(
    identity: RunIdentity,
    error: unknown,
  ): Promise<RunResult> {
    this.say(
      `${identity.id} not started: ${failureLine(error, MAX_CELL_REFUSAL_LENGTH, this.deps.secrets)}`,
    );
    return this.conclude(
      identity,
      undefined,
      this.now(),
      {
        status: "error",
        reason: safeLine(
          `the run could not start: ${textOf(error)}`,
          MAX_REASON_LENGTH,
          this.deps.secrets,
        ),
      },
      false,
    );
  }

  /**
   * The run's number and identity — said in the log when either cannot be had.
   *
   * @returns the identity, or `undefined` when there is none.
   */
  private async identity(): Promise<RunIdentity | undefined> {
    const { stateDir, checkout } = this.deps;
    try {
      const number = await (this.deps.nextNumber ?? nextRunNumber)(
        stateDir,
        this.task.id,
      );
      return runIdentity({
        taskId: this.task.id,
        product: this.task.product,
        cell: this.task.cell,
        number,
        startedAt: this.now(),
        stateDir,
        checkout,
      });
    } catch (error) {
      this.say(
        `no run started: its number could not be taken: ${this.failure(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Waits for the launched run's end, then concludes it.
   *
   * @param identity - the run.
   * @param writer - its record writer.
   * @param launched - the launched run.
   * @returns how it ended.
   */
  private async ended(
    identity: RunIdentity,
    writer: RecordWriter,
    launched: LaunchedRun,
  ): Promise<RunResult> {
    let launch: LaunchResult;
    try {
      launch = await launched.done;
    } catch (error) {
      // Its processes may still run: no `ended` record, so the next start's orphan check judges them.
      const failure = this.failure(error);
      this.say(`${identity.id} could not be watched to its end: ${failure}`);
      const endedAt = this.now();
      const result = await this.conclude(identity, undefined, endedAt, {
        status: "error",
        reason: `the run could not be watched to its end: ${failure}`,
      });
      return result.kind === "ended" ? { ...result, unwatched: true } : result;
    }
    const endedAt = this.now();
    let end: RunEnd | undefined;
    try {
      end = await (this.deps.end ?? endRun)({
        identity,
        task: eventTask(this.task),
        launch,
        secrets: this.deps.secrets,
        endedAt,
      });
    } catch (error) {
      this.say(
        `${identity.id}'s end could not be read: ${this.failure(error)}`,
      );
      return this.conclude(
        identity,
        { writer, launch },
        endedAt,
        unreadOutcome(launch.stop, error, this.deps.secrets),
      );
    }
    return this.conclude(identity, { writer, launch }, endedAt, end.event);
  }

  /**
   * A run whose launch failed: nothing ran. Recorded only when its folder is its own.
   *
   * @param identity - the run.
   * @param writer - its record writer, when its folder is its own.
   * @param error - what the launch threw.
   * @returns how it ended: `error`.
   */
  private notLaunched(
    identity: RunIdentity,
    writer: RecordWriter | undefined,
    error: unknown,
  ): Promise<RunResult> {
    const outcome = notStartedOutcome(error, this.deps.secrets);
    this.say(`${identity.id} could not start: ${this.failure(error)}`);
    const launch: LaunchResult = {
      bddgen: NOTHING_RAN,
      stop: { level: "none" },
    };
    return this.conclude(
      identity,
      writer === undefined ? undefined : { writer, launch },
      this.now(),
      outcome,
      // A launch refused before the folder was the run's leaves none (it removes what it made).
      writer !== undefined,
    );
  }

  /**
   * A run a stop kept from spawning `bddgen`: nothing ran. Its folder is its own, so it is recorded,
   * the stop taken as the stop machine takes any stop before a process runs — a drain.
   *
   * @param identity - the run.
   * @param writer - its record writer.
   * @param asked - the stop asked for.
   * @returns how it ended: `stopped`.
   */
  private stoppedBeforeSpawn(
    identity: RunIdentity,
    writer: RecordWriter,
    asked: StopAsked,
  ): Promise<RunResult> {
    const { taken } = stepRunStop(INITIAL_RUN_STOP, {
      type: "stop",
      level: asked.level,
      why: asked.why,
    }).state;
    const launch: LaunchResult = { bddgen: NOTHING_RAN, stop: taken };
    return this.conclude(identity, { writer, launch }, this.now(), {
      status: "stopped",
      reason: asked.why,
    });
  }

  /**
   * Records, tells, announces and prunes a run that is over. Each step on its own: one failing never
   * skips the next.
   *
   * @param identity - the run.
   * @param record - its writer and how its processes ended; `undefined` when nothing may be written
   *   in its folder — not its own, or its processes not known to be over.
   * @param endedAt - when it ended.
   * @param ending - its `run.finished`, or the outcome to build one from.
   * @param hadFolder - `false` for a run refused before its launch made its folder: its event then
   *   points at no report or log.
   * @returns how it ended.
   */
  private async conclude(
    identity: RunIdentity,
    record: EndToRecord | undefined,
    endedAt: Date,
    ending: RunFinishedEvent | RunOutcome,
    hadFolder = true,
  ): Promise<RunResult> {
    const event =
      "type" in ending
        ? ending
        : this.event(identity, endedAt, ending, hadFolder);
    if (event === undefined) {
      await this.prune(identity);
      return { kind: "ended", id: identity.id, status: "error", endedAt };
    }
    if (record !== undefined) await this.recordEnd(identity, record, event);
    this.say(outcomeLine(event, (path) => this.show(path)));
    try {
      this.deps.bus.publish(event);
    } catch (error) {
      this.say(
        `${identity.id}'s run.finished could not be published: ${this.failure(error)}`,
      );
    }
    await this.prune(identity);
    return {
      kind: "ended",
      id: identity.id,
      status: event.status,
      endedAt,
      event,
    };
  }

  /**
   * A `run.finished` from an outcome, for a run whose end was not read; `undefined` when even that
   * cannot be built — said in the log.
   *
   * @param identity - the run.
   * @param endedAt - when it ended.
   * @param outcome - its outcome.
   * @param hadFolder - whether the run had a folder of its own.
   * @returns the event, or `undefined`.
   */
  private event(
    identity: RunIdentity,
    endedAt: Date,
    outcome: RunOutcome,
    hadFolder: boolean,
  ): RunFinishedEvent | undefined {
    try {
      return (this.deps.buildEvent ?? buildRunFinished)({
        at: endedAt,
        run: { id: identity.id, runId: identity.runId },
        task: eventTask(this.task),
        startedAt: identity.startedAt,
        endedAt,
        outcome,
        reportDir: identity.reportDir,
        log: identity.log,
        hadFolder,
        secrets: this.deps.secrets,
      });
    } catch (error) {
      this.say(
        `${identity.id}'s run.finished could not be built: ${this.failure(error)}`,
      );
      return undefined;
    }
  }

  /**
   * Keeps the run's end: its `run.finished` and, when it is sent one, its Datator record, each in a
   * file of its own beside the record; then the `ended` record. The files come first, so an `ended`
   * record means they were written, or their failure logged — a payload that cannot be built, or a
   * file that cannot be written, is a line, never a missing record.
   *
   * @param identity - the run.
   * @param record - its writer and how its processes ended.
   * @param event - its `run.finished`.
   */
  private async recordEnd(
    identity: RunIdentity,
    { writer, launch }: EndToRecord,
    event: RunFinishedEvent,
  ): Promise<void> {
    await this.keep(identity, RUN_FILES.finished, event);
    let datator: DatatorPayload | undefined;
    try {
      datator = this.deps.datatorPayload?.(event);
    } catch (error) {
      this.say(
        `${identity.id}'s Datator record could not be built: ${this.failure(error)}`,
      );
    }
    if (datator !== undefined)
      await this.keep(identity, RUN_FILES.datator, datator);
    try {
      await writer.write(endedRecord(identity, this.task.id, launch, event));
    } catch (error) {
      this.say(
        `${identity.id}'s end could not be recorded: ${this.failure(error)}`,
      );
    }
  }

  /**
   * Writes one file beside the run's record, for whoever looks into the run; a failure is a line.
   *
   * @param identity - the run.
   * @param name - the file's name in the run's folder.
   * @param value - what it holds.
   */
  private async keep(
    identity: RunIdentity,
    name: string,
    value: unknown,
  ): Promise<void> {
    try {
      await (this.deps.writeJson ?? writeJsonAtomic)(
        join(identity.dir, name),
        value,
      );
    } catch (error) {
      this.say(
        `${identity.id}'s ${name} could not be written: ${this.failure(error)}`,
      );
    }
  }

  /**
   * Records that a process is about to be spawned. A failure is said, then thrown: the launch then
   * spawns nothing, since a process must never run unrecorded.
   *
   * @param identity - the run.
   * @param writer - its record writer.
   * @param name - the process.
   */
  private async recordStarting(
    identity: RunIdentity,
    writer: RecordWriter,
    name: RunProcessName,
  ): Promise<void> {
    try {
      await writer.write(startingRecord(identity, this.task.id, name));
    } catch (error) {
      this.say(
        `${identity.id}: recording that ${name} starts failed: ${this.failure(error)}`,
      );
      throw error;
    }
  }

  /**
   * Records a running process and its leader's start. A start that cannot be read is recorded as
   * unread, with why; a write that fails is said. Never rejects.
   *
   * @param identity - the run.
   * @param writer - its record writer.
   * @param name - the process.
   * @param pgid - its group.
   */
  private async recordProcess(
    identity: RunIdentity,
    writer: RecordWriter,
    name: RunProcessName,
    pgid: number,
  ): Promise<void> {
    try {
      await writer.write(
        this.leader(identity, name, pgid).then((process) =>
          runningRecord(identity, this.task.id, process),
        ),
      );
    } catch (error) {
      this.say(
        `${identity.id}: recording ${name}'s process failed: ${this.failure(error)}`,
      );
    }
  }

  /**
   * The process with its leader's start; a reader that throws gives a start recorded as unread.
   *
   * @param identity - the run.
   * @param name - the process.
   * @param pgid - its group.
   * @returns the process, with its start or why it is unread.
   */
  private async leader(
    identity: RunIdentity,
    name: RunProcessName,
    pgid: number,
  ): Promise<RunningProcess> {
    try {
      return await leaderProcess(
        name,
        pgid,
        this.deps.readLeaderStart ?? readLeaderStart,
      );
    } catch (error) {
      const failure = this.failure(error);
      this.say(`${identity.id}: ${name}'s start could not be read: ${failure}`);
      return { name, pgid, leaderStartUnread: recordWords(failure) };
    }
  }

  /**
   * Prunes the task's run folders, the run's own kept, and says what went. Never rejects.
   *
   * @param identity - the run.
   */
  private async prune(identity: RunIdentity): Promise<void> {
    try {
      const keep = this.deps.config.runs?.reportsKeep;
      const report = await (this.deps.prune ?? pruneTaskRuns)({
        stateDir: this.deps.stateDir,
        taskId: this.task.id,
        ...(keep === undefined ? {} : { keep }),
        current: identity.dir,
        now: this.now().getTime(),
      });
      for (const line of describeRunRetention(report, (path) =>
        this.show(path),
      ))
        this.say(line.text);
    } catch (error) {
      this.say(
        `${identity.id}: pruning the task's run folders failed: ${this.failure(error)}`,
      );
    }
  }

  /**
   * The stop asked for so far: read through a call, since it changes while the run awaits.
   *
   * @returns the stop, or `undefined` when none was asked.
   */
  private stopAsked(): StopAsked | undefined {
    return this.asked;
  }

  /** Hands the stop asked for to the launched run, when both exist. */
  private forward(): void {
    if (this.asked === undefined || this.launched === undefined) return;
    try {
      this.launched.stop(this.asked.level, this.asked.why);
    } catch (error) {
      this.say(`stopping the run failed: ${this.failure(error)}`);
    }
  }

  /**
   * Tells that the run began: its id, report folder and start.
   *
   * @param identity - the run.
   */
  private begun(identity: RunIdentity): void {
    this.begunId = identity.id;
    this.tell(
      {
        kind: "begun",
        taskId: this.task.id,
        id: identity.id,
        runId: identity.runId,
        reportDir: identity.reportDir,
        startedAt: identity.startedAt,
      },
      "began",
    );
  }

  /**
   * Tells `onActivity` what the run did; a listener that throws, or rejects, is a line.
   *
   * @param activity - what it did.
   * @param verb - how the line words it: `began`, `is stopping`, `ended`.
   */
  private tell(
    activity: TaskActivity & { readonly id: string },
    verb: string,
  ): void {
    tellActivity(this.deps.onActivity, activity, (error) => {
      this.say(
        `${activity.id}: telling that it ${verb} failed: ${this.failure(error)}`,
      );
    });
  }

  /**
   * Logs a line under the task's id. A logger that throws loses the line, never the run.
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

  /**
   * A path as the lines show it: from the checkout.
   *
   * @param path - an absolute path.
   * @returns the path to show.
   */
  private show(path: string): string {
    return showPath(path, this.deps.checkout);
  }
}
