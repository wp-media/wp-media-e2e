import { redactSecrets } from "../text";
import type {
  OutputStream,
  TerminalCapabilities,
} from "../terminal/capabilities";
import {
  createLiveRegion,
  realScheduler,
  type LiveRegion,
  type LiveRow,
  type Scheduler,
} from "../terminal/live";
import {
  bypassWriter,
  captureStdio,
  type CapturableStream,
  type StdioCapture,
} from "../terminal/stdio-capture";
import {
  drainTerminal,
  openLiveTerminal,
  reblockTerminal,
  type LiveTerminal,
  type Terminal,
  type TerminalStream,
} from "../terminal/stream";

/**
 * The terminal reporter's live block, from its first draw to its last: one live region on standard
 * output (`terminal/live.ts`) redrawn on a tick and on every event, the process's own standard output
 * and error captured meanwhile so every line written there lands above the block
 * (`terminal/stdio-capture.ts`), the block redrawn when the terminal is resized, and every one of
 * those undone on each way it ends:
 *
 * - `live` → `closed`: {@link LiveSession.close} — the reporter's `onEnd`, a callback that threw, the
 *   process exiting (a second Ctrl-C, `process.exit`). The block is cleared, the streams put back,
 *   the listeners and the tick removed; later lines still print through the region, as plain lines.
 *   Also when drawing the block throws — from the tick, a resize, the first draw — the error then
 *   told through `onError`, never thrown from a timer or an event (it would crash the runner).
 * - `live` → `closed`, then the signal again: `SIGTERM` or `SIGHUP` (`kill`, a closed terminal) ends
 *   a process without `exit`; while live the session listens for both, clears the block, waits a
 *   moment for the terminal to take that ({@link SIGNAL_DRAIN_MS}), and — when no other listener
 *   handles the signal (the runner has none) — sends it to the process again, so it dies of it as it
 *   would have (`143`, `129`). `SIGKILL` cannot be heard: the block stays on screen, the shell's next
 *   lines over it.
 * - `live` → `dead`: a write failed (`EPIPE`, `EIO`): the same is undone, nothing more is written by
 *   the region, and the owner is told once.
 *
 * Every line the capture prints is masked first (`redactSecrets`): the runner's own writers know
 * nothing of the suite's credentials rule.
 *
 * Standard error is captured only when it is a terminal: one redirected to a file cannot reach the
 * block, and keeps its bytes. What a child process writes to an inherited descriptor never passes
 * through `write` and cannot be captured.
 */

/** Standard output, as the session uses it: written, sized, and listened to. */
export interface LiveStdout extends Terminal, TerminalStream, OutputStream {
  /**
   * Listens for the stream's failures (`error`) and the terminal's new size (`resize`).
   *
   * @param event - the event.
   * @param listener - called with the error, or nothing for `resize`.
   */
  on(event: "error" | "resize", listener: (error: Error) => void): unknown;
  /**
   * Stops listening.
   *
   * @param event - the event.
   * @param listener - the listener given to {@link LiveStdout.on}.
   */
  off(event: "error" | "resize", listener: (error: Error) => void): unknown;
}

/** The process's `exit` event: the last moment to clear the block and put the streams back. */
export interface ExitEvents {
  /**
   * Listens for the process's exit.
   *
   * @param event - always `exit`.
   * @param listener - called once, synchronously, as the process ends.
   */
  on(event: "exit", listener: () => void): unknown;
  /**
   * Stops listening.
   *
   * @param event - always `exit`.
   * @param listener - the listener given to {@link ExitEvents.on}.
   */
  off(event: "exit", listener: () => void): unknown;
}

/** The signals that end a process without its `exit` event, and that the session hears while live. */
export const STOP_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/** One of {@link STOP_SIGNALS}. */
export type StopSignal = (typeof STOP_SIGNALS)[number];

/** The process's stop signals, and how to send one to it again: `process` has them. */
export interface SignalEvents {
  /**
   * Listens for a signal; the listener replaces the signal's default, which is to end the process.
   *
   * @param event - the signal.
   * @param listener - called when it comes.
   */
  on(event: StopSignal, listener: () => void): unknown;
  /**
   * Stops listening; with no listener left, the signal's default is back.
   *
   * @param event - the signal.
   * @param listener - the listener given to {@link SignalEvents.on}.
   */
  off(event: StopSignal, listener: () => void): unknown;
  /**
   * How many listen to a signal.
   *
   * @param event - the signal.
   */
  listenerCount(event: StopSignal): number;
  /**
   * Sends a signal.
   *
   * @param pid - the process: {@link SignalEvents.pid}.
   * @param signal - the signal.
   */
  kill(pid: number, signal: StopSignal): unknown;
  /** The process's id. */
  readonly pid: number;
}

/** What a session writes to and listens to: the process's own, by default. */
export interface LiveSessionDeps {
  readonly stdout: LiveStdout;
  /** Captured with standard output while it is a terminal. */
  readonly stderr: CapturableStream & { readonly isTTY?: boolean };
  readonly exit: ExitEvents;
  /** `SIGTERM` and `SIGHUP`: heard while live, sent again once the block is cleared. */
  readonly signals: SignalEvents;
  readonly scheduler: Scheduler;
}

/** What {@link LiveSession.start} needs. */
export interface LiveSessionOptions {
  readonly deps: LiveSessionDeps;
  /** Whether the stream may hold a live region: without, the session only prints lines. */
  readonly capabilities: Pick<TerminalCapabilities, "live">;
  /** The palette's ellipsis: what marks a cut row. */
  readonly ellipsis: string;
  /** The block's rows for a region `width` columns wide and at most `maxRows` tall. */
  readonly rows: (geometry: {
    readonly width: number;
    readonly maxRows: number;
  }) => readonly LiveRow[];
  /** Told once when a write fails and the session dies. A throw is swallowed. */
  readonly onFailure: () => void;
  /**
   * Told when drawing the block threw (the rows' source, most likely) and the session closed. A
   * throw is swallowed.
   */
  readonly onError?: (error: unknown) => void;
  /** How often the block is redrawn with nothing else happening (its times move). */
  readonly tickMs?: number;
}

/** Where a session is; see this module's description. */
export type LiveSessionState = "live" | "closed" | "dead";

/** The default tick: twice a second, the live region's own most. */
export const TICK_MS = 500;

/**
 * How long a stop signal waits for the terminal to take the cleared block before the signal is sent
 * again: short, since the signal asked the process to end; a second one meanwhile ends it at once.
 */
export const SIGNAL_DRAIN_MS = 500;

/** The streams a live session holds now: one block per stream, so a second never captures the first. */
const held = new WeakSet<object>();

/**
 * Whether a live session holds `stream` now: a second reporter printing to it (`--add-reporter`) must
 * not start another, whose block the first's capture would print as lines.
 *
 * @param stream - standard output.
 */
export function liveSessionOn(stream: object): boolean {
  return held.has(stream);
}

/** One live block on standard output; see this module's description. */
export class LiveSession {
  #state: LiveSessionState = "live";
  readonly #options: LiveSessionOptions;
  readonly #terminal: LiveTerminal;
  readonly #region: LiveRegion;
  readonly #capture: StdioCapture;
  #tick: unknown;
  /** The listener per stop signal, so each is removed again. */
  readonly #onSignal = new Map<StopSignal, () => void>(
    STOP_SIGNALS.map((signal) => [
      signal,
      () => {
        this.#signalled(signal);
      },
    ]),
  );

  /**
   * Opens the region, captures the streams and draws the block. Make it once the block should show:
   * nothing is captured before. A first draw that throws leaves nothing in place: the session is
   * closed and `onError` told.
   *
   * @param options - the streams, capabilities, rows and failure hooks.
   */
  constructor(options: LiveSessionOptions) {
    this.#options = options;
    const { stdout, stderr } = options.deps;
    // The region writes through what `write` is now, so its bytes never come back through the capture.
    this.#terminal = openLiveTerminal(bypassWriter(stdout));
    this.#region = createLiveRegion({
      terminal: this.#terminal,
      capabilities: options.capabilities,
      size: () => ({ columns: stdout.columns, rows: stdout.rows }),
      ellipsis: options.ellipsis,
      scheduler: options.deps.scheduler,
      onFailure: () => {
        this.#die();
      },
    });
    this.#capture = captureStdio({
      streams: stderr.isTTY === true ? [stdout, stderr] : [stdout],
      print: (lines) => this.#region.print(lines.map(redactSecrets)),
    });
    held.add(stdout);
    this.#guarded(() => {
      stdout.on("resize", this.#resized);
      options.deps.exit.on("exit", this.#exiting);
      for (const [signal, listener] of this.#onSignal)
        options.deps.signals.on(signal, listener);
      this.#armTick();
      this.#draw();
    });
  }

  /** Where the session is. */
  get state(): LiveSessionState {
    return this.#state;
  }

  /**
   * Prints permanent lines above the block (plain lines once closed).
   *
   * @param lines - the lines, without line ends.
   * @returns `false` once a write failed: nothing more reaches the terminal.
   */
  print(lines: readonly string[]): boolean {
    if (this.#state === "dead") return false;
    return this.#region.print(lines);
  }

  /**
   * Redraws the block from the rows' source now, or at the region's next slot. Never throws: a
   * source that throws closes the session (`onError`).
   */
  refresh(): void {
    this.#guarded(() => {
      this.#draw();
    });
  }

  /**
   * Clears the block for good and undoes the capture, the listeners and the tick; idempotent. The
   * undo happens even when clearing throws.
   */
  close(): void {
    if (this.#state !== "live") return;
    this.#state = "closed";
    try {
      this.#region.close();
    } finally {
      this.#undo();
    }
  }

  /**
   * Waits until the terminal took what was written (at most `maxWaitMs`), then makes it blocking
   * again if the session had made it non-blocking — so the writers after it (the summary, just
   * before Playwright's `process.exit`) lose nothing. A terminal still holding bytes stays
   * non-blocking: a blocking write to a paused terminal would freeze the process.
   *
   * @param maxWaitMs - the longest wait.
   * @returns whether the terminal took everything. Never rejects.
   */
  async drain(maxWaitMs: number): Promise<boolean> {
    const drained = await drainTerminal(this.#terminal.sink, maxWaitMs);
    if (drained && this.#terminal.unblocked)
      reblockTerminal(this.#options.deps.stdout);
    return drained;
  }

  /** The terminal's new size: the region erases the old block, then the block is drawn again. */
  readonly #resized = (): void => {
    this.#guarded(() => {
      if (this.#state !== "live") return;
      this.#region.resize();
      this.#draw();
    });
  };

  /** The process is ending: clear the block and put the streams back while it still can. */
  readonly #exiting = (): void => {
    this.close();
  };

  /**
   * A stop signal came while live: clear the block, let the terminal take that, then send the
   * signal again when nobody else handles it — the session's own listener is gone by then, so it
   * ends the process as it would have.
   *
   * @param signal - the signal.
   */
  #signalled(signal: StopSignal): void {
    this.close();
    const { signals } = this.#options.deps;
    void this.drain(SIGNAL_DRAIN_MS).finally(() => {
      try {
        if (signals.listenerCount(signal) === 0)
          signals.kill(signals.pid, signal);
      } catch {
        // A process that cannot signal itself goes on: the block is cleared at least.
      }
    });
  }

  /** Draws the block from the rows' source, while live. */
  #draw(): void {
    if (this.#state !== "live") return;
    const rows = this.#options.rows({
      width: this.#region.width,
      maxRows: maxRows(this.#options.deps.stdout.rows),
    });
    this.#region.update(rows);
  }

  /**
   * Runs `work`; a throw closes the session and is told through `onError`, never rethrown — `work`
   * runs from a timer, an event or the constructor, where a throw would crash the runner or leave
   * the capture in place.
   *
   * @param work - what to run.
   */
  #guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      try {
        this.close();
      } catch {
        // Closing undoes what it can; the error below is the one to tell.
      }
      try {
        this.#options.onError?.(error);
      } catch {
        // The owner's hook must not throw from a timer.
      }
    }
  }

  /** Arms the next tick, which redraws the block and arms the one after. */
  #armTick(): void {
    const { scheduler } = this.#options.deps;
    const ms = this.#options.tickMs ?? TICK_MS;
    this.#tick = scheduler.setTimeout(() => {
      this.#tick = undefined;
      this.#guarded(() => {
        if (this.#state !== "live") return;
        this.#draw();
        this.#armTick();
      });
    }, ms);
  }

  /** A write failed: the region is dead; undo the rest and tell the owner, once. */
  #die(): void {
    if (this.#state === "dead") return;
    const wasLive = this.#state === "live";
    this.#state = "dead";
    if (wasLive) this.#undo();
    try {
      this.#options.onFailure();
    } catch {
      // The owner's hook must not make a write throw.
    }
  }

  /** Puts the streams back and removes the listeners and the tick. */
  #undo(): void {
    this.#capture.restore();
    const { deps } = this.#options;
    held.delete(deps.stdout);
    if (this.#tick !== undefined) deps.scheduler.clearTimeout(this.#tick);
    this.#tick = undefined;
    const removals = [
      () => deps.stdout.off("resize", this.#resized),
      () => deps.exit.off("exit", this.#exiting),
      ...[...this.#onSignal].map(
        ([signal, listener]) =>
          () =>
            deps.signals.off(signal, listener),
      ),
    ];
    for (const remove of removals) {
      try {
        remove();
      } catch {
        // A stream that refuses to stop listening calls a listener that does nothing now.
      }
    }
  }
}

/**
 * The most rows the block may take on a terminal `rows` tall: one less, so the cursor's row never
 * scrolls the block; 0 when the size is unknown.
 *
 * @param rows - the terminal's rows.
 */
export function maxRows(rows: number | undefined): number {
  return rows !== undefined && Number.isSafeInteger(rows) && rows > 1
    ? rows - 1
    : 0;
}

/** The process's own streams, events and clock. */
export function processLiveDeps(): LiveSessionDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: process,
    signals: process,
    scheduler: realScheduler,
  };
}
