/**
 * Writing a terminal without letting it freeze the process: standard output made non-blocking, a
 * write that never throws, the queue measured, and waited for before `process.exit`. Shared by the
 * orchestrator's logger and the live region (`live.ts`). Nothing here runs at import.
 *
 * Node writes `process.stdout` **synchronously** when it is a terminal (`tty.WriteStream` sets its
 * handle blocking, on macOS and Linux), so a paused terminal — Ctrl-S, a frozen SSH client — stops the
 * whole event loop, timers and signal handlers included: a Ctrl-C is never handled.
 * {@link unblockTerminal} turns that handle back to non-blocking through Node's internal
 * `_handle.setBlocking(false)` — there is no public way — guarded, so a Node without it changes
 * nothing. Writes then queue in the stream ({@link ByteSink.writableLength}) until the terminal takes
 * them, and the writer bounds that queue ({@link backlogBytes}).
 *
 * Measured (Node 24, macOS and Linux, a pty nobody reads): blocking, the process never handles
 * SIGTERM; non-blocking, it does, and `process.exit` ends it at once. A shell sharing the terminal is
 * not affected, even after a SIGKILL: libuv reopens a terminal by its name before using it, so the
 * flag lands on the process's own open file description, not the shell's. When it cannot reopen it —
 * a terminal of another user's, as `sudo -u` in a plain SSH session — libuv keeps writing it
 * blocking whatever the flag, and the freeze remains (measured); `tmux` started by the process's
 * user gives it a terminal of its own. (Writing it through the thread pool instead, `fs.write`, was
 * measured too: the event loop then runs, but a write stuck in a pool thread holds even
 * `process.exit` until the terminal resumes.) Only standard output is changed: standard error, where
 * Node prints a crash, stays synchronous so a crash's last words are never lost.
 *
 * Two costs, accepted. A write still queued keeps Node's event loop alive, so a process that must end
 * while its terminal is paused ends through `process.exit`. And **whatever is still queued when the
 * process exits is lost from the terminal — a terminal that reads included**: the queue empties only
 * as fast as the terminal takes it, slower than a burst is written (measured on a pty read at once:
 * 200 KB then `process.exit` showed about 1 KB on macOS and 1.3 of 5 MB on Linux; 2,000 of the
 * orchestrator logger's lines then its `close`, 78). So {@link stdoutTerminal} and
 * {@link openLiveTerminal} are called only once the process starts its work — after the command line
 * is parsed, so `--help`, a usage error and the orchestrator's `--dry-run` print through Node's
 * blocking default — and before `process.exit` the queue is waited for, within a bound:
 * {@link drainTerminal}. A paused terminal then costs that bound, never more.
 *
 * A pipe needs nothing: Node writes it asynchronously on both systems (measured), and a pipe nobody
 * reads only grows the queue.
 */

/**
 * As much of a `Writable` as a writer of bytes uses — `process.stdout` is one. A write may fail by
 * throwing, through its callback, or by an `error` event; all three mean the same. The `error` event
 * is its owner's to listen for: an unheard one crashes the process.
 */
export interface ByteSink {
  /**
   * Queues bytes for the terminal — bytes, not a string, so {@link ByteSink.writableLength} counts
   * bytes: a string-mode stream (a terminal, a socket) counts a string by its UTF-16 units.
   *
   * @param chunk - the text, UTF-8 encoded.
   * @param callback - called once written, or with the error it failed with.
   * @returns whether the caller may go on writing without waiting (a `Writable`'s backpressure).
   */
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  /**
   * What is written but not yet taken by the terminal: what a stalled terminal piles up. In bytes for
   * bytes written; a string another writer wrote counts by its UTF-16 units.
   */
  readonly writableLength: number;
  /** `true` once the stream is destroyed: nothing still queued will be taken. */
  readonly destroyed?: boolean;
}

/** A {@link ByteSink} whose writer also hears its `error` event: the orchestrator logger's. */
export interface Terminal extends ByteSink {
  /**
   * Listens for a failure not tied to one write's callback.
   *
   * @param event - always `error`.
   * @param listener - called with the error.
   */
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * What {@link unblockTerminal} reads of a stream: whether it is a terminal, and — not typed, as it is
 * Node's internal — its `_handle`.
 */
export interface TerminalStream {
  /** `true` for a terminal (`tty.WriteStream`). */
  readonly isTTY?: boolean;
}

/**
 * Makes a terminal stream's writes non-blocking, if it is a terminal and Node's internal handle offers
 * it: a `_handle` whose `setBlocking` is a function. Anything else is left as it is.
 *
 * @param stream - the stream, e.g. `process.stdout`.
 * @returns whether its handle was made non-blocking (`setBlocking` answered `0`).
 */
export function unblockTerminal(stream: TerminalStream): boolean {
  if (stream.isTTY !== true) return false;
  const handle: unknown = Reflect.get(stream, "_handle");
  if (typeof handle !== "object" || handle === null) return false;
  const setBlocking: unknown = Reflect.get(handle, "setBlocking");
  if (typeof setBlocking !== "function") return false;
  try {
    return Reflect.apply(setBlocking, handle, [false]) === 0;
  } catch {
    return false;
  }
}

/**
 * The most a writer leaves queued for a terminal (1 MiB): past it, the orchestrator's logger skips and
 * counts its lines and a live region skips its draws.
 */
export const TERMINAL_BACKLOG_BYTES = 1024 * 1024;

/** The streams {@link stdoutTerminal} already handled, so each is handled once. */
const handled = new WeakSet<object>();

/**
 * Standard output as a {@link Terminal}, made non-blocking on first use when it is a terminal
 * ({@link unblockTerminal}). Call it only once the process starts its work, and wait for the terminal
 * ({@link drainTerminal}) before `process.exit`: see this module's description.
 *
 * @param stream - the stream; `process.stdout` by default.
 * @returns the stream.
 */
export function stdoutTerminal(
  stream: Terminal & TerminalStream = process.stdout,
): Terminal {
  if (!handled.has(stream)) {
    handled.add(stream);
    unblockTerminal(stream);
  }
  return stream;
}

/**
 * A stream made ready for a live region by {@link openLiveTerminal}, the only way to get one: its
 * `#opened` brand makes a hand-built object a type error, so no region runs on a terminal still
 * blocking or with its `error` event unheard.
 */
export class LiveTerminal {
  /** The brand: only this module constructs one. */
  readonly #opened = true;
  /** The stream: what the region writes and {@link drainTerminal} waits for. */
  readonly sink: ByteSink & DrainableTerminal;
  /** Whether its handle was made non-blocking (a terminal on a Node offering it). */
  readonly unblocked: boolean;

  /**
   * @param sink - the stream.
   * @param unblocked - whether {@link unblockTerminal} succeeded.
   */
  constructor(sink: ByteSink & DrainableTerminal, unblocked: boolean) {
    this.sink = sink;
    this.unblocked = unblocked;
  }

  /**
   * Whether `value` came from {@link openLiveTerminal}: the runtime half of the brand, for callers
   * the types do not reach.
   *
   * @param value - anything.
   */
  static isOpened(value: unknown): value is LiveTerminal {
    return typeof value === "object" && value !== null && #opened in value;
  }
}

/** The streams {@link openLiveTerminal} opened, so each is opened (and listened to) once. */
const opened = new WeakMap<object, LiveTerminal>();

/**
 * Makes `stream` safe for a live region, once per stream: non-blocking when it is a terminal
 * ({@link unblockTerminal}), and its `error` event heard by a listener that does nothing — a write to
 * a closed pipe (`EPIPE`) or a terminal gone (`EIO`) emits one per queued write, and an unheard one
 * crashes the process; the region learns of the failure from the write's callback instead. Every
 * other writer of the stream then fails silently too: what it writes is lost, as the terminal is.
 * Call it only once the process starts its work, and drain before `process.exit`: see this module's
 * description. Never throws: a stream that refuses the listener is still returned.
 *
 * @param stream - the stream; `process.stdout` by default.
 * @returns the opened stream, the same object for the same stream.
 * @example
 * ```ts
 * const terminal = openLiveTerminal();
 * const region = createLiveRegion({ terminal, capabilities, size: () => process.stdout, ellipsis });
 * // …
 * region.close();
 * await drainTerminal(terminal.sink, 2_000);
 * ```
 */
export function openLiveTerminal(
  stream: Terminal & TerminalStream = process.stdout,
): LiveTerminal {
  const known = opened.get(stream);
  if (known !== undefined) return known;
  const terminal = new LiveTerminal(stream, unblockTerminal(stream));
  try {
    stream.on("error", ignoreError);
  } catch {
    // A stream without events cannot crash the process with one.
  }
  opened.set(stream, terminal);
  return terminal;
}

/** The `error` listener {@link openLiveTerminal} installs: the write's callback reports the failure. */
function ignoreError(): void {
  // Nothing: see openLiveTerminal.
}

/** How often {@link drainTerminal} looks at the terminal's queue, in milliseconds. */
export const DRAIN_POLL_MS = 10;

/** The longest wait a Node timer takes; a longer one would fire at once. */
export const MAX_WAIT_MS = 2 ** 31 - 1;

/**
 * Checks a wait's length.
 *
 * @param ms - the wait, in milliseconds.
 * @throws {@link RangeError} when it is not a whole number from 0 to {@link MAX_WAIT_MS}.
 */
export function assertWaitMs(ms: number): void {
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_WAIT_MS)
    throw new RangeError(
      `A wait is a whole number of milliseconds from 0 to ${String(MAX_WAIT_MS)}, got ${String(ms)}.`,
    );
}

/** What {@link drainTerminal} reads of a terminal. */
export type DrainableTerminal = Pick<Terminal, "writableLength" | "destroyed">;

/**
 * Waits until the terminal has taken everything written to it — its queue empty, or the stream
 * destroyed, so nothing left will be taken — or `maxWaitMs` passed. Call it before `process.exit`,
 * which drops what is still queued. Its timers keep the process alive while it waits, so the process
 * cannot end before it settles; and it is bounded, so a paused terminal costs `maxWaitMs` at most.
 *
 * @param terminal - the terminal; `process.stdout` is one.
 * @param maxWaitMs - the longest wait, in milliseconds.
 * @returns whether everything was taken. Never rejects.
 * @throws {@link RangeError} when `maxWaitMs` is not a whole number of milliseconds a timer takes.
 * @example
 * ```ts
 * await drainTerminal(process.stdout, 2_000);
 * process.exit(code);
 * ```
 */
export function drainTerminal(
  terminal: DrainableTerminal,
  maxWaitMs: number,
): Promise<boolean> {
  assertWaitMs(maxWaitMs);
  const deadline = performance.now() + maxWaitMs;
  return new Promise((resolve) => {
    /** Settles once the terminal holds nothing or the time is up; else looks again later. */
    const look = (): void => {
      if (holdsNothing(terminal)) {
        resolve(true);
        return;
      }
      const left = deadline - performance.now();
      if (left <= 0) {
        resolve(false);
        return;
      }
      setTimeout(look, Math.min(DRAIN_POLL_MS, Math.ceil(left)));
    };
    look();
  });
}

/**
 * Whether a terminal holds nothing it will still take. A getter that throws reads as nothing left, so
 * the wait never rejects.
 *
 * @param terminal - the terminal.
 * @returns `true` once its queue is empty or it is destroyed.
 */
function holdsNothing(terminal: DrainableTerminal): boolean {
  try {
    return terminal.writableLength === 0 || terminal.destroyed === true;
  } catch {
    return true;
  }
}

/**
 * Hands `chunk` to `sink` and never throws: a destroyed sink, a `write` that throws and a write whose
 * callback reports an error each call `onFailure` — at once for the first two, later for the last —
 * so the writer can stop writing for good (`EPIPE`: a closed pipe; `EIO`: a terminal gone with its
 * session). At most once per call, even when `write` both calls back with an error and throws, or
 * `onFailure` itself throws (swallowed).
 *
 * @param sink - the stream.
 * @param chunk - the bytes.
 * @param onFailure - called with what went wrong, at most once per call.
 * @returns whether the sink took the chunk: `false` when it was destroyed or `write` threw.
 * @example
 * ```ts
 * writeSafely(process.stdout, Buffer.from("line\n"), () => (dead = true));
 * ```
 */
export function writeSafely(
  sink: ByteSink,
  chunk: Uint8Array,
  onFailure: (error: Error) => void,
): boolean {
  let told = false;
  /** Tells `onFailure` the first failure only; its throw goes nowhere. */
  const fail = (error: unknown): void => {
    if (told) return;
    told = true;
    try {
      onFailure(error instanceof Error ? error : new Error(String(error)));
    } catch {
      // The caller's hook must not make a write throw.
    }
  };
  try {
    if (sink.destroyed === true) {
      fail(new Error("The stream is destroyed."));
      return false;
    }
    sink.write(chunk, (error) => {
      if (error !== undefined && error !== null) fail(error);
    });
    return true;
  } catch (error) {
    fail(error);
    return false;
  }
}

/**
 * How much `sink` holds that its reader has not taken yet: what a writer compares to its bound.
 *
 * @param sink - the stream.
 * @returns the queue's length ({@link ByteSink.writableLength}), or `undefined` when it cannot be
 *   read (a getter that throws, a value that is no length): the stream is broken.
 */
export function backlogBytes(
  sink: Pick<ByteSink, "writableLength">,
): number | undefined {
  try {
    const length = sink.writableLength;
    return Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  } catch {
    return undefined;
  }
}
