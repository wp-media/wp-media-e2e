import type {
  Environment,
  OutputStream,
} from "../src/common/terminal/capabilities";
import { terminalWidth } from "../src/common/terminal/layout";
import {
  createLiveRegion,
  type LiveRegion,
  type Scheduler,
} from "../src/common/terminal/live";
import { createPalette, type Palette } from "../src/common/terminal/palette";
import {
  bypassWriter,
  captureStdio,
  type CapturableStream,
  type StdioCapture,
} from "../src/common/terminal/stdio-capture";
import {
  openLiveTerminal,
  writeSafely,
  type Terminal,
  type TerminalStream,
} from "../src/common/terminal/stream";
import { styleLine, type LoggedLine } from "./line-style";
import { MAX_TEXT_LENGTH, type TerminalScreen } from "./log";
import type { Board } from "./status/board";
import { renderTableLines } from "./status/table";
import { tableRows } from "./status/table-rows";
import { tableView, type TableView } from "./status/view";
import { safeBlock } from "./text";

/**
 * The orchestrator's terminal, when standard output is one: the logger's lines styled
 * (`line-style.ts`), and — where the terminal can redraw in place (`capabilities.live`) — the status
 * table kept at the bottom through a live region (`src/common/terminal/live.ts`), every permanent
 * line printed above it. A pipe or a file gets no screen: the logger writes its plain lines there,
 * byte for byte as before.
 *
 * The table is drawn at most once a second — the region's throttle: the watch shows the board on
 * every activity and poll, and the region keeps only the newest — redrawn on a resize (SIGWINCH,
 * Node's `resize` event), skipped while the terminal's backlog is over its bound (the next draw
 * coalesces them), and cleared for good by {@link Screen.close}, which the start calls before its
 * `exiting` line on every path; lines printed after it go straight through. The region opens with
 * the first table, so lines before it are written as they are. A write that fails — the region's or
 * a line's — makes the terminal gone for both, told to the logger. Nothing here listens to a signal:
 * the start's shutdown ends the loops, then closes the screen.
 *
 * While the table shows, every other writer of the process's own terminal — a Node warning, a
 * dependency's `console.*` — goes through it: standard output's `write`, and standard error's when it
 * is a terminal, are captured (`stdio-capture.ts`) and each whole line, masked ({@link safeBlock}),
 * printed above the table; anything else would leave table rows on the screen for good, its cursor
 * no longer where the region's next clear starts. The streams are put back when the screen closes or
 * the terminal is gone. A crash (an uncaught exception or rejection) or any other exit clears the
 * table too: `uncaughtExceptionMonitor` runs before Node prints the error, `exit` at the very end —
 * neither changes the exit code nor what is printed. Only a SIGKILL leaves the table.
 */

/** The table's throttle: one redraw a second at most. */
export const TABLE_INTERVAL_MS = 1_000;

/** Standard output as the screen uses it. */
export type ScreenStream = Terminal & TerminalStream & OutputStream;

/** How a screen is opened. */
export interface ScreenOptions {
  /** Standard output. */
  readonly stdout: ScreenStream;
  /** The process's environment: the standard variables only (`NO_COLOR`, `TERM`, `CI`, …). */
  readonly env: Environment;
  /** The selected tasks' ids, in the config's order: their colours. */
  readonly taskIds: readonly string[];
  /** The region's clock and timers; the real ones, `unref`ed, by default. */
  readonly scheduler?: Scheduler;
  /** Now, for the table's elapsed times; the system clock by default. */
  readonly now?: () => Date;
  /**
   * Standard error: captured while the table shows when it is a terminal (`isTTY`), so what is
   * written there prints above the table. Left alone when absent or not a terminal.
   */
  readonly stderr?: {
    /**
     * Writes text: `process.stderr`'s `write`, which the capture replaces.
     *
     * @param text - what to write.
     */
    write(text: string): unknown;
    readonly isTTY?: boolean;
  };
  /** Secret values masked in every captured line. */
  readonly secrets?: readonly string[];
  /** Where the process's end is heard, to clear the table on a crash or an exit; `process` by default. */
  readonly process?: ProcessEnd;
}

/** The events that end a process: `process` has them. */
export type ProcessEndEvent = "exit" | "uncaughtExceptionMonitor";

/** Where the process's end is heard. */
export interface ProcessEnd {
  /**
   * Adds `listener` for `event`.
   *
   * @param event - the event.
   * @param listener - what to call.
   */
  on(event: ProcessEndEvent, listener: () => void): unknown;
  /**
   * Removes `listener` for `event`.
   *
   * @param event - the event.
   * @param listener - what was added.
   */
  off(event: ProcessEndEvent, listener: () => void): unknown;
}

/** The events {@link ProcessEnd} hears, in the order a crash emits them. */
const END_EVENTS: readonly ProcessEndEvent[] = [
  "uncaughtExceptionMonitor",
  "exit",
];

/** A terminal's screen: the logger's lines and the status table. */
export interface Screen extends TerminalScreen {
  /** Whether the table can be shown: the terminal redraws in place. */
  readonly live: boolean;
  /**
   * Shows the table of `board`, at the throttle's next slot; nothing once closed, gone, or not live.
   * Never throws.
   *
   * @param board - every task.
   */
  show(board: Board): undefined;
  /** Clears the table for good; idempotent, never throws. Lines still print. */
  close(): void;
}

/**
 * The screen of standard output, when it is a terminal.
 *
 * @param options - the stream, the environment, the tasks, the seams.
 * @returns the screen; `undefined` for anything but a terminal — a pipe's lines stay plain.
 */
export function openScreen(options: ScreenOptions): Screen | undefined {
  const view = tableView(options.env, options.stdout);
  if (!view.capabilities.tty) return undefined;
  return new TerminalSession(options, view);
}

/**
 * Has `listener` called on each `resize` of `stream` — a `tty.WriteStream` emits one on SIGWINCH —
 * until the returned function is called. A stream with no events is never resized.
 *
 * @param stream - the stream.
 * @param listener - what to call.
 * @returns the function that stops it; never throws.
 */
export function onResize(stream: object, listener: () => void): () => void {
  const on: unknown = Reflect.get(stream, "on");
  const off: unknown = Reflect.get(stream, "off");
  if (typeof on !== "function" || typeof off !== "function")
    return () => undefined;
  try {
    Reflect.apply(on, stream, ["resize", listener]);
  } catch {
    return () => undefined;
  }
  return () => {
    try {
      Reflect.apply(off, stream, ["resize", listener]);
    } catch {
      // A stream that refuses: nothing more is drawn anyway.
    }
  };
}

/** The screen {@link openScreen} hands out. */
class TerminalSession implements Screen {
  readonly live: boolean;
  /** The region, from the first table on. */
  #region: LiveRegion | undefined;
  /** The board last shown: what a resize redraws. */
  #board: Board | undefined;
  /** Set by {@link Screen.close}. */
  #closed = false;
  /** Set once a write failed: the terminal is gone. */
  #failed = false;
  /** Told of a failure: the logger's, from its latest print. */
  #onFailure: ((error: Error) => void) | undefined;
  /** Stops hearing resizes. */
  #unlisten: () => void = () => undefined;
  /** The capture of the process's own writers, while the table shows. */
  #capture: StdioCapture | undefined;
  /** Clears the table when the process ends; the listener {@link ProcessEnd} is given. */
  readonly #ending = (): void => {
    this.close();
  };
  /** Whether {@link TerminalSession.#ending} is listening. */
  #endHeard = false;
  /** The colours of the lines and the table, as the terminal's capabilities say. */
  readonly #palette: Palette;
  /** Each task's colour, by id. */
  readonly #taskIndex: ReadonlyMap<string, number>;
  readonly #options: ScreenOptions;

  /**
   * @param options - see {@link ScreenOptions}.
   * @param view - the terminal's capabilities.
   */
  constructor(options: ScreenOptions, view: TableView) {
    this.#options = options;
    this.live = view.capabilities.live;
    this.#palette = createPalette(view.capabilities);
    this.#taskIndex = new Map(options.taskIds.map((id, i) => [id, i]));
  }

  /**
   * {@inheritDoc TerminalScreen.format}
   *
   * @param line - its parts, already safe.
   * @returns its lines.
   */
  format(line: LoggedLine): readonly string[] {
    return styleLine(line, {
      palette: this.#palette,
      width: terminalWidth({
        stream: this.#options.stdout,
        env: this.#options.env,
      }),
      scopeIndex: (scope) => this.#taskIndex.get(scope),
    });
  }

  /**
   * {@inheritDoc TerminalScreen.print}
   *
   * @param lines - the lines, without line ends.
   * @param onFailure - told what failed.
   */
  print(lines: readonly string[], onFailure: (error: Error) => void): void {
    this.#onFailure = onFailure;
    if (this.#failed) {
      onFailure(new Error("The terminal is gone."));
      return;
    }
    // Above the table while it is shown; straight through before it and once it is closed.
    if (this.#region !== undefined) {
      this.#region.print(lines);
      return;
    }
    writeSafely(
      this.#options.stdout,
      Buffer.from(`${lines.join("\n")}\n`, "utf8"),
      (error) => {
        this.#fail(error);
      },
    );
  }

  /**
   * {@inheritDoc Screen.show}
   *
   * @param board - every task.
   * @returns nothing.
   */
  show(board: Board): undefined {
    if (!this.live || this.#closed || this.#failed) return;
    this.#board = board;
    try {
      this.#draw(board);
    } catch {
      // The table is best-effort: it never stops what it shows.
    }
    return undefined;
  }

  /** {@inheritDoc Screen.close} */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#unlisten();
    this.#unlisten = () => undefined;
    this.#board = undefined;
    this.#region?.close();
    this.#release();
  }

  /**
   * Hands the board's table to the region, opening it first.
   *
   * @param board - every task.
   */
  #draw(board: Board): void {
    const region = this.#openRegion();
    const view = tableView(this.#options.env, this.#options.stdout);
    const lines = renderTableLines(board, {
      width: view.width,
      ...(view.height === undefined ? {} : { height: view.height }),
      palette: view.palette,
      now: (this.#options.now ?? (() => new Date()))(),
    });
    region.update(
      tableRows(lines, {
        palette: this.#palette,
        taskIndex: (taskId) => this.#taskIndex.get(taskId),
      }),
    );
  }

  /**
   * The region, opened on first use: the stream made ready for it, resizes heard.
   *
   * @returns the region.
   */
  #openRegion(): LiveRegion {
    if (this.#region !== undefined) return this.#region;
    const { stdout } = this.#options;
    // Through the `write` standard output has now: the region's bytes never come back through the capture.
    const region = createLiveRegion({
      terminal: openLiveTerminal(bypassWriter(stdout)),
      capabilities: { live: true },
      size: () => stdout,
      ellipsis: this.#palette.symbol("ellipsis"),
      minIntervalMs: TABLE_INTERVAL_MS,
      ...(this.#options.scheduler === undefined
        ? {}
        : { scheduler: this.#options.scheduler }),
      onFailure: (error) => {
        this.#fail(error);
      },
    });
    this.#region = region;
    this.#unlisten = onResize(stdout, () => {
      this.#resize();
    });
    this.#capture = this.#captureWriters(region);
    this.#hearEnd();
    return region;
  }

  /**
   * Captures standard output's `write`, and standard error's when it is a terminal: their lines,
   * masked, print above the table.
   *
   * @param region - the table's region.
   * @returns the capture; `undefined` when a stream refused it (its writes then go as they did).
   */
  #captureWriters(region: LiveRegion): StdioCapture | undefined {
    const { stdout, stderr, secrets = [] } = this.#options;
    try {
      return captureStdio({
        // A stream's `write` takes `(chunk, encoding?, callback?)`; the capture keeps that contract.
        streams:
          stderr?.isTTY === true && (stderr as unknown) !== stdout
            ? [stdout, stderr as CapturableStream]
            : [stdout],
        print: (lines) =>
          region.print(
            lines.map((line) => safeBlock(line, MAX_TEXT_LENGTH, secrets)),
          ),
      });
    } catch {
      return undefined;
    }
  }

  /** Has the process's end clear the table. */
  #hearEnd(): void {
    const events = this.#options.process ?? process;
    // Heard before the first `on`: one that throws midway may have added a listener to remove.
    this.#endHeard = true;
    try {
      for (const event of END_EVENTS) events.on(event, this.#ending);
    } catch {
      // Without them a crash leaves the table, as a SIGKILL does.
    }
  }

  /** Puts the captured streams back and stops hearing the process's end; idempotent, never throws. */
  #release(): void {
    this.#capture?.restore();
    this.#capture = undefined;
    if (!this.#endHeard) return;
    this.#endHeard = false;
    const events = this.#options.process ?? process;
    for (const event of END_EVENTS) {
      try {
        events.off(event, this.#ending);
      } catch {
        // A listener that stays only closes a closed screen again.
      }
    }
  }

  /** After a resize: the old table erased, the last board drawn again for the new size. */
  #resize(): void {
    if (this.#closed || this.#failed || this.#region === undefined) return;
    this.#region.resize();
    if (this.#board !== undefined) this.show(this.#board);
  }

  /**
   * The terminal is gone: nothing is drawn again, and the logger is told.
   *
   * @param error - what failed.
   */
  #fail(error: Error): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#release();
    try {
      this.#onFailure?.(error);
    } catch {
      // The logger's hook must not make a write throw.
    }
  }
}
