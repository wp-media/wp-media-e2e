import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CheckedTask } from "./config/check";
import {
  DEFAULT_CONFIG_PATH,
  loadConfig,
  type LoadedConfig,
} from "./config/load";
import { loadProductList, type ProductList } from "./config/product-list";
import { allSecretValues, proxySecretValues } from "./config/secrets";
import { builtRef } from "./dry-run";
import { createEventBus, DEFAULT_DELIVERY_TIMEOUT_MS } from "./events/bus";
import type { RunFinishedEvent } from "./events/run-finished";
import { openLogger, type Logger } from "./log";
import {
  subscribeNotifications,
  type NotificationOptions,
} from "./notify/subscribe";
import { runByNpm, watchParent, type ParentWatch } from "./parent";
import { suiteCommands } from "./runs/commands";
import { RUN_FILES } from "./runs/identity";
import { readLeaderStart } from "./runs/leader";
import {
  createShutdown,
  DEFAULT_SHUTDOWN_BUDGETS,
  SHUTDOWN_SIGNALS,
  type Shutdown,
  type ShutdownBudgets,
  type ShutdownSignal,
  type ShutdownTimers,
} from "./runs/shutdown";
import type { StopLevel } from "./runs/stop";
import {
  cellLocks,
  cellLocksFolder,
  unitOf,
  type CellLocks,
} from "./state/cell-lock";
import { acquireLock, type HeldLock, type LockDeps } from "./state/lock";
import {
  checkOrphans,
  classifyRunning,
  orphanRefusal,
  type OrphanCheckDeps,
} from "./state/orphans";
import { readRunningFolders, type RunningFolders } from "./state/run-folders";
import {
  escalationLine,
  gaveUpLine,
  leftBehindLine,
  leftoverLines,
  loopsExitCode,
  selectTasks,
  staleLine,
  startedLine,
  type ExitCode,
} from "./start-lines";
import { showPath } from "./tasks/run-lines";
import {
  NODE_COOLDOWN_TIMERS,
  runTask,
  type CooldownTimers,
  type LoopDeps,
  type TaskEnd,
  type TaskLoop,
} from "./tasks/loop";
import {
  drainTerminal,
  stdoutTerminal,
  type DrainableTerminal,
  type Terminal,
  type TerminalStream,
} from "../src/common/terminal/stream";
import { failureLine, safeBlock, safeLine, textOf } from "./text";

/**
 * The orchestrator's process: `start` loads the product list and the config, takes the state
 * directory's lock, refuses on a run an earlier orchestrator left running and on a selected cell
 * another orchestrator holds (`state/cell-lock.ts`), subscribes Slack and Datator, and starts every
 * selected task's loop at once. SIGINT, SIGTERM and SIGHUP drive the
 * shutdown machine (`runs/shutdown.ts`), and each escalation stops every loop — a stop ends a
 * cooldown and starts nothing, so loops, not only runs, are stopped. A parent that ends — npm killed
 * by a SIGHUP it does not relay — counts as SIGHUP (`parent.ts`). It waits for every loop; once
 * the runs were killed, only for {@link KILL_SETTLE_MS} more, then names what it leaves behind. Then
 * it settles the bus, closes the log, releases the lock — the log is only ever written under it — and
 * waits for the terminal and standard error.
 *
 * It **returns** the exit code rather than exiting: every step of the exit sequence but
 * `process.exit` itself is done here, so the command's only remaining act is `process.exit(code)` —
 * which it must do, as a paused terminal or a run's pending wait would otherwise keep the process
 * alive. Returning keeps `start` callable in a spec's own process, where an injected `exit` that
 * returns would let code run that never runs in production. It never rejects.
 *
 * Importing this module changes nothing in the process: the signal handlers are installed by `start`
 * and removed before it returns, whatever happened, and standard output is made non-blocking only
 * once `start` runs (after the command line is parsed, so `--help` and usage errors print blocking).
 */

/** The checkout the runs start in: this module's folder's parent. */
export const CHECKOUT = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** How long the loops may still take once every run was killed: a SIGKILLed group empties at once. */
export const KILL_SETTLE_MS = 60_000;

/**
 * How long closing the log, then emptying the terminal's and standard error's queues, may each take at
 * the exit.
 */
export const EXIT_WAIT_MS = 5_000;

/** The scope of the orchestrator's own lines. */
const SCOPE = "orchestrator";

/** The longest refusal said in the log — a site held elsewhere names its holder, run and way out. */
const MAX_REFUSAL_LINE = 1_500;

/**
 * The longest failure the start's own lines quote, in code points — an unexpected error or a record
 * that could not be read: the error's message whole, with the path it names, never a stack.
 */
const MAX_FAILURE_LINE = 1_000;

/** The longest refusal or failure printed before the log is open, in code points. */
const MAX_REPORT_LENGTH = 8_000;

export { PARENT_WATCH_MS, type ParentWatch } from "./parent";

/** What the command line asks of `start`: `start [--config <file>] [--task <id>…] [--once]`. */
export interface StartOptions {
  /** The config file; `.orchestrator/config.json` in the checkout by default. */
  readonly config?: string;
  /** The tasks to run, by id; every task when absent or empty. */
  readonly tasks?: readonly string[];
  /** Runs each selected task once, then exits: `0` all passed or flaky, `1` otherwise. */
  readonly once?: boolean;
}

/** The process, as `start` uses it — `process` in production, a stand-in in a spec. */
export interface StartProcess {
  /** Shown in the started line. */
  readonly pid: number;
  /** Only what a run's environment inherits is read. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The Node binary the runs' commands run with. */
  readonly execPath: string;
  /** The terminal: made non-blocking when it is one, and waited for before returning. */
  readonly stdout: Terminal & TerminalStream;
  /**
   * Where what fails before the log is open is printed; waited for before returning, as the terminal
   * is, when it says what it still holds (`writableLength`): a pipe is written asynchronously on
   * macOS, and `process.exit` drops what it still holds.
   */
  readonly stderr: {
    /**
     * Writes text; may be asynchronous (a pipe on macOS).
     *
     * @param text - what to write.
     */
    write(text: string): unknown;
    readonly writableLength?: number;
    readonly destroyed?: boolean;
  };
  /**
   * Installs a signal's handler.
   *
   * @param signal - the signal.
   * @param listener - its handler.
   */
  on(signal: ShutdownSignal, listener: () => void): unknown;
  /**
   * Removes a signal's handler.
   *
   * @param signal - the signal.
   * @param listener - the handler installed.
   */
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

/** What the loops are given beyond what `start` builds: the specs' seams. */
export type LoopSeams = Partial<
  Pick<
    LoopDeps,
    | "commandsFor"
    | "launch"
    | "launchOptions"
    | "readLeaderStart"
    | "runOnce"
    | "timers"
    | "nextNumber"
    | "end"
    | "prune"
  >
>;

/** Every seam of `start`; production uses none. */
export interface StartDeps {
  /** `process` by default. */
  readonly process?: StartProcess;
  /** {@link CHECKOUT} by default. */
  readonly checkout?: string;
  /** `loadProductList()` by default. */
  readonly loadProductList?: () => Promise<ProductList>;
  /** The lock's stand-ins — the state directory's, and the cells'. */
  readonly lock?: LockDeps;
  /** Takes the state directory's lock; `acquireLock` by default. */
  readonly acquireLock?: (
    stateDir: string,
    deps?: LockDeps,
  ) => Promise<HeldLock>;
  /**
   * The site locks' folder; `cellLocksFolder(process.env)` by default —
   * `$XDG_STATE_HOME/wp-media-e2e/site-locks`, else under `$HOME/.local/state`.
   */
  readonly cellLocks?: string;
  /** The orphan check's `kill` and start reader; the process's by default. */
  readonly orphans?: Partial<Pick<OrphanCheckDeps, "kill" | "readLeaderStart">>;
  /** The clock of the log, the runs and the orphan check; the system's by default. */
  readonly now?: () => Date;
  /** The shutdown's budgets; {@link DEFAULT_SHUTDOWN_BUDGETS} (15 min drain, 4 min interrupt) by default. */
  readonly budgets?: ShutdownBudgets;
  /** The shutdown's timers; Node's by default. */
  readonly shutdownTimers?: ShutdownTimers;
  /** The timer of the wait after a kill; Node's, kept referenced, by default. */
  readonly timers?: CooldownTimers;
  /** {@link KILL_SETTLE_MS} by default. */
  readonly killSettleMs?: number;
  /** {@link EXIT_WAIT_MS} by default. */
  readonly exitWaitMs?: number;
  /** One delivery's limit on the bus; `DEFAULT_DELIVERY_TIMEOUT_MS` by default. */
  readonly busTimeoutMs?: number;
  /** The senders' time limit and `fetch`. */
  readonly notifications?: NotificationOptions;
  /** The loops' seams. */
  readonly loop?: LoopSeams;
  /**
   * How the parent's end is noticed: `process.ppid` against its value at boot, at once and every
   * second (`parent.ts`), by default.
   */
  readonly parentWatch?: ParentWatch;
}

/** What `start` begins with: the product list, the config, and the tasks selected. */
export interface PreparedStart {
  /** The suite's product list: each run's Playwright config is found through it. */
  readonly list: ProductList;
  /** The config, loaded and checked; its warnings count only the selected tasks on a server. */
  readonly loaded: LoadedConfig;
  /** The tasks `--task` selects, in the config's order; every task by default. */
  readonly selected: readonly CheckedTask[];
}

/**
 * Loads the product list and the config, and selects the tasks — everything `start` does before it
 * takes the lock, and all `--dry-run` needs.
 *
 * @param options - the config file and `--task`.
 * @param deps - the product list's loader.
 * @returns the list, the config loaded and checked, and the tasks selected.
 * @throws `ConfigError` (`./config/errors`) when the product list or the config cannot be loaded, or
 *   `--task` names no task of the config.
 */
export async function prepareStart(
  options: Pick<StartOptions, "config" | "tasks">,
  deps: Pick<StartDeps, "loadProductList"> = {},
): Promise<PreparedStart> {
  const list = await (deps.loadProductList ?? (() => loadProductList()))();
  const loaded = await loadConfig(
    options.config ?? DEFAULT_CONFIG_PATH,
    list.PRODUCTS,
    options.tasks,
  );
  return {
    list,
    loaded,
    selected: selectTasks(loaded.tasks, options.tasks, loaded.file),
  };
}

/**
 * Runs the orchestrator until its loops end — `--once` — or a signal stops it.
 *
 * @param options - the command line's options.
 * @param deps - the seams; none in production.
 * @returns the exit code: `0`/`1` with `--once`, `130` once a signal stopped it, `1` on a config
 *   error, a refused lock or a refused orphan. Never rejects. Call `process.exit` with it at once.
 * @throws {@link RangeError} only for an injected `exitWaitMs` a timer cannot take.
 *
 * @example
 * ```ts
 * process.exit(await start({ config: ".orchestrator/config.json", once: true }));
 * ```
 */
export async function start(
  options: StartOptions,
  deps: StartDeps = {},
): Promise<ExitCode> {
  const orchestrator = new Orchestrator(options, deps);
  orchestrator.listen();
  try {
    return await orchestrator.run();
  } finally {
    orchestrator.unlisten();
  }
}

/** A promise and the function that resolves it. */
interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

/**
 * A promise to resolve from outside.
 *
 * @returns it, and its resolver.
 */
function deferred(): Deferred {
  /** Replaced by the promise's own resolver at once. */
  let resolve = (): void => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** One start: its process, its shutdown, its log once open, and its loops once started. */
class Orchestrator {
  /** The process: its signals, outputs and environment. */
  private readonly process: StartProcess;
  /** The shutdown's budgets, which its lines name. */
  private readonly budgets: ShutdownBudgets;
  /** The shutdown machine the signals drive. */
  private readonly shutdown: Shutdown;
  /** The installed handlers, by signal: removed by {@link Orchestrator.unlisten}. */
  private readonly handlers = new Map<ShutdownSignal, () => void>();
  /** Resolved once the loops had {@link KILL_SETTLE_MS} after the kill. */
  private readonly giveUp = deferred();
  /** The timer that resolves {@link Orchestrator.giveUp}, once armed. */
  private giveUpTimer: unknown;
  /** Stops the parent watch; set while it runs. */
  private stopParentWatch: (() => void) | undefined;
  /** The log, once open: until then, lines go to standard error. */
  private logger: Logger | undefined;
  /** Every secret of the config and of its tasks' sites, once loaded: masked wherever a line goes. */
  private secrets: readonly string[] = [];
  /** Every loop started: what a stop reaches. */
  private loops: readonly TaskLoop[] = [];
  /**
   * Each task's latest run this start's loops began, by task id: the only runs it may name as left
   * behind — a loop that does not end is stuck on its latest run. One entry per task, however long it
   * runs.
   */
  private readonly launched = new Map<string, string>();
  /** The state directory's lock, once taken: released once the log is closed. */
  private lock: HeldLock | undefined;

  /**
   * @param options - the command line's options.
   * @param deps - the seams.
   */
  constructor(
    private readonly options: StartOptions,
    private readonly deps: StartDeps,
  ) {
    this.process = deps.process ?? process;
    this.budgets = deps.budgets ?? DEFAULT_SHUTDOWN_BUDGETS;
    this.shutdown = createShutdown({
      onEscalate: (level, why) => {
        this.escalate(level, why);
      },
      budgets: this.budgets,
      ...(deps.shutdownTimers === undefined
        ? {}
        : { timers: deps.shutdownTimers }),
    });
  }

  /** Installs a handler for each shutdown signal: from now on, they stop the orchestrator. */
  listen(): void {
    for (const signal of SHUTDOWN_SIGNALS) {
      /** Counts this signal. */
      const handler = (): void => {
        this.shutdown.signal(signal);
      };
      this.handlers.set(signal, handler);
      this.process.on(signal, handler);
    }
    this.watchParent();
  }

  /**
   * Watches the parent against its PID at boot, at once and every interval (`parent.ts`): once it is
   * gone, says so and stops as on SIGHUP.
   */
  private watchParent(): void {
    this.stopParentWatch = watchParent(
      this.deps.parentWatch ?? {},
      runByNpm(this.process.env),
      (why) => {
        this.stopParentWatch = undefined;
        this.say(`${why}: stopping as on a hangup`);
        this.shutdown.signal("SIGHUP");
      },
    );
  }

  /** Stops the parent watch, if it runs. */
  private stopWatchingParent(): void {
    this.stopParentWatch?.();
    this.stopParentWatch = undefined;
  }

  /**
   * Ends what reacts to a stop: the parent watch, and the shutdown, so that a signal from now on says
   * nothing — every loop has ended or was given up on, and the exit is under way. The handlers stay
   * until {@link Orchestrator.unlisten}, so no signal takes Node's default action meanwhile.
   */
  private quiet(): void {
    this.stopWatchingParent();
    this.shutdown.dispose();
  }

  /** Removes the handlers and the parent watch, disarms the shutdown's budget and the wait after a kill. */
  unlisten(): void {
    this.stopWatchingParent();
    for (const [signal, handler] of this.handlers)
      this.process.off(signal, handler);
    this.handlers.clear();
    this.shutdown.dispose();
    if (this.giveUpTimer !== undefined)
      this.timers().clearTimeout(this.giveUpTimer);
    this.giveUpTimer = undefined;
  }

  /**
   * The start, from loading the config to the terminal emptied. Never rejects.
   *
   * @returns the exit code.
   */
  async run(): Promise<ExitCode> {
    const terminal = stdoutTerminal(this.process.stdout);
    let code: ExitCode = 1;
    try {
      code = await this.prepared();
    } catch (error) {
      // Against every contract below: said, and the exit is a failure.
      this.say(
        `stopped on an unexpected failure: ${failureLine(error, MAX_FAILURE_LINE, this.secrets)}`,
      );
    }
    this.quiet();
    if (this.logger !== undefined) this.say(`exiting ${String(code)}`);
    const waitMs = this.deps.exitWaitMs ?? EXIT_WAIT_MS;
    await this.logger?.close(waitMs);
    // From here on, lines go to standard error: the log is written only while the lock is held.
    this.logger = undefined;
    await this.releaseLock();
    await Promise.all([
      drainTerminal(terminal, waitMs),
      drainStderr(this.process.stderr, waitMs),
    ]);
    return code;
  }

  /**
   * Releases the state directory's lock, if taken — once the log is closed, so the next orchestrator
   * on this state directory never shares the log with this one's last lines.
   */
  private async releaseLock(): Promise<void> {
    const { lock } = this;
    if (lock === undefined) return;
    this.lock = undefined;
    if (!(await lock.release()))
      this.say(
        `${lock.path} was not removed: it was gone, another's, or could not be`,
      );
  }

  /**
   * Loads the config, takes the lock, and runs under it; {@link Orchestrator.run} releases the lock whatever
   * happens.
   *
   * @returns the exit code.
   */
  private async prepared(): Promise<ExitCode> {
    let prepared: PreparedStart;
    try {
      prepared = await prepareStart(this.options, this.deps);
    } catch (error) {
      this.report(error);
      return 1;
    }
    const { loaded } = prepared;
    this.secrets = [
      ...new Set([
        ...allSecretValues(loaded.config, loaded.tasks),
        ...proxySecretValues(this.process.env),
      ]),
    ];
    try {
      this.lock = await (this.deps.acquireLock ?? acquireLock)(
        loaded.stateDir,
        this.deps.lock,
      );
    } catch (error) {
      this.report(error);
      return 1;
    }
    return this.locked(prepared, this.lock);
  }

  /**
   * Opens the log, checks for orphans, then runs the loops.
   *
   * @param prepared - the config and the tasks selected.
   * @param lock - the lock held.
   * @returns the exit code.
   */
  private async locked(
    prepared: PreparedStart,
    lock: HeldLock,
  ): Promise<ExitCode> {
    const { loaded } = prepared;
    try {
      this.logger = await openLogger(
        join(loaded.stateDir, "orchestrator.log"),
        {
          terminal: this.process.stdout,
          secrets: this.secrets,
          ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
        },
      );
    } catch (error) {
      this.report(error);
      return 1;
    }
    for (const line of [...leftoverLines(lock.leftovers), ...loaded.warnings])
      this.say(line);
    if (!(await this.noOrphans(loaded.stateDir))) return 1;
    const cells = this.cellLocks();
    if (cells === undefined || !(await this.cellsFree(cells, prepared)))
      return 1;
    if (this.signalled()) {
      this.say("stopped before any run started");
      return 130;
    }
    const ends = await this.runLoops(prepared, this.logger, cells);
    return loopsExitCode({
      signalled: this.signalled(),
      once: this.options.once === true,
      ...(ends === undefined ? {} : { ends }),
    });
  }

  /**
   * The orphan check: says what it found, and whether the start may go on.
   *
   * @param stateDir - the state directory.
   * @returns `true` when no run of an earlier orchestrator still runs.
   */
  private async noOrphans(stateDir: string): Promise<boolean> {
    let check: Awaited<ReturnType<typeof checkOrphans>>;
    try {
      check = await checkOrphans(stateDir, {
        ...this.groupJudge(),
        now: this.deps.now ?? (() => new Date()),
      });
    } catch (error) {
      this.say(
        `not started: the runs' records could not be checked for a run still running: ${failureLine(error, MAX_FAILURE_LINE, this.secrets)}`,
      );
      return false;
    }
    for (const line of [...check.warnings, ...check.stale.map(staleLine)])
      this.say(line);
    for (const orphan of check.orphans) this.say(orphanRefusal(orphan));
    return check.orphans.length === 0;
  }

  /**
   * The cells' locks, in the configured folder or the environment's.
   *
   * @returns them; `undefined` when they have no folder — said.
   */
  private cellLocks(): CellLocks | undefined {
    try {
      return cellLocks(
        this.deps.cellLocks ?? cellLocksFolder(this.process.env),
        this.deps.lock,
      );
    } catch (error) {
      this.say(
        `not started: ${failureLine(error, MAX_REFUSAL_LINE, this.secrets)}`,
      );
      return undefined;
    }
  }

  /**
   * Whether every selected task's cell's sites are free of another orchestrator — of this user, on this
   * machine, whatever its state directory: their locks judged as its loop would take them
   * (`cell-lock.ts`), so a site held by a live orchestrator, or by a dead one's run still running,
   * refuses the start. Each refusal is said; the loop still takes the locks as it starts, so an
   * orchestrator started since is refused there.
   *
   * @param cells - the cells' locks.
   * @param prepared - the tasks selected.
   * @returns `true` when every cell is free, or held by a dead orchestrator whose run is over.
   */
  private async cellsFree(
    cells: CellLocks,
    prepared: PreparedStart,
  ): Promise<boolean> {
    let free = true;
    for (const checked of prepared.selected) {
      const { task } = checked;
      let refusal: string | undefined;
      try {
        const found = await cells.inspect(unitOf(checked));
        if (found.kind === "refused") refusal = found.message;
      } catch (error) {
        refusal = `its cell's site locks could not be checked: ${textOf(error)}`;
      }
      if (refusal === undefined) continue;
      free = false;
      this.say(
        `not started: ${safeLine(refusal, MAX_REFUSAL_LINE, this.secrets)}`,
        task.id,
      );
    }
    return free;
  }

  /**
   * Starts every selected task's loop, waits for them, then settles the bus.
   *
   * @param prepared - the config and the tasks.
   * @param logger - the log.
   * @param cells - the cells' locks each run takes.
   * @returns every loop's end; absent when they did not all end within {@link KILL_SETTLE_MS} of
   *   the kill.
   */
  private async runLoops(
    prepared: PreparedStart,
    logger: Logger,
    cells: CellLocks,
  ): Promise<readonly TaskEnd[] | undefined> {
    const { loaded, selected } = prepared;
    const bus = createEventBus<RunFinishedEvent>({
      timeoutMs: this.deps.busTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
      log: (line) => {
        this.say(line);
      },
      secrets: this.secrets,
    });
    const notifications = subscribeNotifications(bus, loaded.config, logger, {
      ...this.deps.notifications,
      secrets: this.secrets,
    });
    const checkout = this.deps.checkout ?? CHECKOUT;
    const once = this.options.once === true;
    const ids = selected.map(({ task }) => task.id);
    this.say(
      startedLine(
        ids,
        once,
        showPath(loaded.stateDir, checkout),
        this.process.pid,
      ),
    );
    const deps = this.loopDeps(prepared, checkout, logger, bus, (event) =>
      notifications.datatorPayload(event),
    );
    // Started and made reachable in one turn: a signal is handled between turns only. Each loop holds
    // its cell's site locks from its start to its end.
    this.loops = selected.map((checked) =>
      runTask(checked.task, {
        ...deps,
        takeCell: () => cells.acquire(unitOf(checked)),
      }),
    );
    const ends = await this.waitForLoops(loaded.stateDir, ids);
    await bus.settle();
    return ends;
  }

  /**
   * What every loop is given: the checkout, the config, each task's commands and ref, the log and the
   * bus, with the seams a spec injects; `onRunBegun` last, so this start always knows its own runs.
   *
   * @param prepared - the config and the product list.
   * @param checkout - the checkout the runs start in.
   * @param logger - the log.
   * @param bus - the event bus.
   * @param datatorPayload - the Datator record a run keeps.
   * @returns the loops' deps.
   */
  private loopDeps(
    prepared: PreparedStart,
    checkout: string,
    logger: Logger,
    bus: LoopDeps["bus"],
    datatorPayload: NonNullable<LoopDeps["datatorPayload"]>,
  ): LoopDeps {
    const { loaded, list } = prepared;
    // Planned once per task, at its first run, as the dry run plans it: its started line names the
    // same ref.
    const refs = new Map<string, string | undefined>();
    return {
      stateDir: loaded.stateDir,
      checkout,
      config: loaded.config,
      secrets: this.secrets,
      inherited: this.process.env,
      commandsFor: (task) =>
        suiteCommands({
          node: this.process.execPath,
          checkout,
          playwrightConfig: list.playwrightConfigFor(
            list.productByName(task.product),
          ),
          ...(task.grep === undefined ? {} : { grep: task.grep }),
        }),
      refFor: (task) => {
        if (!refs.has(task.id))
          refs.set(task.id, plannedRef(prepared.selected, list, task.id));
        return refs.get(task.id);
      },
      logger,
      bus,
      datatorPayload,
      once: this.options.once === true,
      ...(this.deps.now === undefined ? {} : { now: this.deps.now }),
      ...this.deps.loop,
      onRunBegun: (id, taskId) => {
        this.launched.set(taskId, id);
      },
    };
  }

  /**
   * Waits for every loop; once the runs were killed, for {@link KILL_SETTLE_MS} more at most, then
   * names each run left behind.
   *
   * @param stateDir - the state directory, where the runs left behind are recorded.
   * @param ids - the loops' task ids, in their order.
   * @returns every loop's end, or `undefined` when the wait gave up.
   */
  private async waitForLoops(
    stateDir: string,
    ids: readonly string[],
  ): Promise<readonly TaskEnd[] | undefined> {
    const pending = new Set(ids);
    const all = Promise.all(
      this.loops.map(async (loop, index) => {
        const end = await loop.done;
        pending.delete(ids[index] ?? "");
        return end;
      }),
    );
    const ends = await Promise.race([
      all,
      this.giveUp.promise.then(() => undefined),
    ]);
    if (ends === undefined) await this.sayLeftBehind(stateDir, [...pending]);
    return ends;
  }

  /**
   * Names what the loops that did not end leave behind: each run of theirs this start began whose
   * record still says it runs, its group judged now as the orphan check judges one — so a kill
   * command is printed only for a group shown to be the run's.
   *
   * @param stateDir - the state directory.
   * @param taskIds - the tasks whose loops did not end.
   */
  private async sayLeftBehind(
    stateDir: string,
    taskIds: readonly string[],
  ): Promise<void> {
    this.say(gaveUpLine(taskIds, this.deps.killSettleMs ?? KILL_SETTLE_MS));
    const folders = await this.runningFolders(stateDir);
    const named = new Set<string>();
    for (const { record, path } of folders.running) {
      if (
        this.launched.get(record.taskId) !== record.id ||
        !taskIds.includes(record.taskId)
      )
        continue;
      named.add(record.taskId);
      const verdict = await classifyRunning(record, this.groupJudge());
      const log = join(dirname(path), RUN_FILES.log);
      this.say(leftBehindLine(record.id, verdict, log), record.taskId);
    }
    // Only the stuck tasks' own runs: the orphan check said the others' at the start.
    for (const warning of folders.warnings)
      if (taskIds.some((taskId) => this.launched.get(taskId) === warning.name))
        this.say(warning.text);
    for (const taskId of taskIds)
      if (!named.has(taskId))
        this.say(
          "its loop did not end, and no run of it is recorded running",
          taskId,
        );
  }

  /**
   * The running records, or none when the runs' folder cannot be read — said.
   *
   * @param stateDir - the state directory.
   * @returns the records and the warnings.
   */
  private async runningFolders(stateDir: string): Promise<RunningFolders> {
    try {
      return await readRunningFolders(stateDir);
    } catch (error) {
      this.say(
        `the runs' records could not be read: ${failureLine(error, MAX_FAILURE_LINE, this.secrets)}`,
      );
      return { running: [], warnings: [] };
    }
  }

  /**
   * How a run's group is judged: `kill` and the start reader, the process's own by default.
   *
   * @returns them.
   */
  private groupJudge(): Pick<OrphanCheckDeps, "kill" | "readLeaderStart"> {
    const orphans = this.deps.orphans ?? {};
    return {
      kill: orphans.kill ?? ((pid, signal) => process.kill(pid, signal)),
      readLeaderStart: orphans.readLeaderStart ?? readLeaderStart,
    };
  }

  /**
   * One escalation of the shutdown: said, then handed to every loop; a kill arms the wait's bound.
   *
   * @param level - how far every run is stopped now.
   * @param why - why.
   */
  private escalate(level: StopLevel, why: string): void {
    this.say(escalationLine(level, why, this.budgets));
    for (const loop of this.loops) loop.stop(level, why);
    if (level === "killed" && this.giveUpTimer === undefined)
      this.giveUpTimer = this.timers().setTimeout(() => {
        this.giveUpTimer = undefined;
        this.giveUp.resolve();
      }, this.deps.killSettleMs ?? KILL_SETTLE_MS);
  }

  /**
   * Whether a signal stopped the orchestrator, at any time so far.
   *
   * @returns `true` once one did.
   */
  private signalled(): boolean {
    return this.shutdown.state.level !== "running";
  }

  /**
   * The timer of the wait after a kill.
   *
   * @returns the injected one, else Node's, kept referenced: the wait must keep the process alive.
   */
  private timers(): CooldownTimers {
    return this.deps.timers ?? NODE_COOLDOWN_TIMERS;
  }

  /**
   * Says a line: to the log once it is open, else to standard error. Never throws.
   *
   * @param text - the line.
   * @param scope - who speaks; the orchestrator by default.
   */
  private say(text: string, scope: string = SCOPE): void {
    if (this.logger !== undefined) {
      this.logger.line(scope, text);
      return;
    }
    this.printError(`${scope}: ${text}`);
  }

  /**
   * Says why the start cannot go on — a config, lock or log refusal, whose message names the file and
   * the way out — on standard error, the log not being open: a refusal of several lines keeps them.
   *
   * @param error - what was thrown.
   */
  private report(error: unknown): void {
    this.printError(`${SCOPE}: not started: ${textOf(error) || "failed"}`);
  }

  /**
   * Writes to standard error, masked; a write that fails is dropped.
   *
   * @param text - the text, one or more lines.
   */
  private printError(text: string): void {
    try {
      this.process.stderr.write(
        `${safeBlock(text, MAX_REPORT_LENGTH, this.secrets)}\n`,
      );
    } catch {
      // Nowhere left to say it.
    }
  }
}

/**
 * Waits, within `maxWaitMs`, for standard error to take what was written to it — when it says what it
 * holds: a stand-in that does not is taken as holding nothing.
 *
 * @param stderr - standard error.
 * @param maxWaitMs - the longest wait, in milliseconds.
 * @returns whether everything was taken. Never rejects.
 */
async function drainStderr(
  stderr: StartProcess["stderr"],
  maxWaitMs: number,
): Promise<boolean> {
  return saysWhatItHolds(stderr) ? drainTerminal(stderr, maxWaitMs) : true;
}

/**
 * Whether a stream says what it still holds.
 *
 * @param stream - standard error, or a stand-in.
 * @returns `true` when its `writableLength` is a number.
 */
function saysWhatItHolds(
  stream: StartProcess["stderr"],
): stream is StartProcess["stderr"] & DrainableTerminal {
  return typeof stream.writableLength === "number";
}

/**
 * The ref a selected task's runs build, as the dry run names it (`builtRef`): `develop (default)`.
 *
 * @param selected - the tasks selected, joined to their cells.
 * @param list - the product list, for the task's artifact manifest.
 * @param taskId - the task.
 * @returns the ref; `undefined` when the task is not selected, its product is unknown to the list, or
 *   the planner refuses it — the started line then names the task's own ref. Never throws.
 */
export function plannedRef(
  selected: readonly CheckedTask[],
  list: Pick<ProductList, "productByName">,
  taskId: string,
): string | undefined {
  const checked = selected.find(({ task }) => task.id === taskId);
  if (checked === undefined) return undefined;
  try {
    return builtRef({
      artifacts: list.productByName(checked.task.product).artifacts,
      edition: checked.cell.edition,
      plugin: checked.task.plugin,
    });
  } catch {
    return undefined;
  }
}
