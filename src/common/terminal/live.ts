import { withoutControls } from "../text";

import { MIN_WIDTH, type TerminalCapabilities } from "./capabilities";
import { cutToWidth, terminalWidth } from "./layout";
import {
  backlogBytes,
  LiveTerminal,
  TERMINAL_BACKLOG_BYTES,
  writeSafely,
} from "./stream";

/**
 * A live region: a block of rows kept at the bottom of a terminal and redrawn in place, with
 * permanent lines printed above it. One writer owns the stream: everything printed while the region
 * is open goes through {@link LiveRegion.print}, or the block and the line overwrite each other.
 *
 * Cursor contract (byte-exact; the region's only state about the screen is the block's height). In a
 * live region every line ends `\r\n`, never a bare `\n`: a terminal left without `onlcr` (`stty
 * -onlcr`, a crashed full-screen program) moves down without returning to column 0 (measured in tmux;
 * Node's own raw mode keeps `onlcr`).
 * - After a draw the cursor is on the block's last row, column 0, with no trailing line end.
 * - Clearing N rows writes `\r\x1b[2K` then `\x1b[1A\r\x1b[2K` × (N-1), ending on the block's first
 *   row, column 0 — a clean line.
 * - A print clears the block, writes its line(s) there, each ending `\r\n`, and leaves the block
 *   cleared (height 0); one repaint follows a burst of prints, on the next turn of the event loop and
 *   at least {@link REPAINT_GAP_MS} after the last draw.
 * - A resize erases the old block as far as can be done without touching a permanent line, then
 *   redraws it at the throttle's next slot. The terminal may have reflowed it — tmux and xterm.js
 *   split rows too wide for a narrower pane, moving the cursor to the split's last part; a widened
 *   pane moves the cursor off column 0; a shorter one pushes the top rows into history — and the
 *   region cannot know how (a terminal that only truncates moves nothing), so it moves up the old
 *   height less one row, never past the block, clears that row and everything below it, and comes
 *   back to that row ({@link resetBytes}). It never erases to the end of the screen from the top-left
 *   corner: tmux (`scroll-on-clear`, 3.4 and 3.8) then scrolls the whole screen into history instead,
 *   the old block with it. What stays (measured in tmux 3.4 and 3.8, xterm.js 5.5): a narrowed
 *   block's split parts above the erased rows, rows a shorter pane pushed into history, and, in tmux
 *   3.8 only, up to half of a widened block holding wide (CJK) rows, which its reflow moves above the
 *   cursor. Never a permanent line.
 * - The cursor is never hidden, so a region a SIGKILL ends leaves a usable terminal.
 * - The region starts on a clean line: whoever wrote before it ended with a line end.
 *
 * Rows are plain text, cut to the width here ({@link fitRow}); style comes after the cut, through
 * each segment's `style`, kept only if it adds nothing but SGR (colour) — anything else draws the
 * text unstyled — and a styled row ends with a reset. A printed line keeps its SGR and loses every
 * other escape and control ({@link sgrOnly}).
 *
 * Content redraws ({@link LiveRegion.update}) are throttled to one per `minIntervalMs`; updates in
 * between coalesce to the newest. While the stream holds more than `maxBacklogBytes` not yet taken (a
 * paused terminal), draws are skipped and retried (every {@link BACKLOG_RETRY_MS} at least); a
 * permanent line is always written, before any such check: bounding them is the caller's (the
 * orchestrator's logger skips and counts its own lines over the same bound).
 *
 * The stream comes from `openLiveTerminal`, which makes a terminal non-blocking and hears its `error`
 * event: a region needs both and cannot be made without them. A failed write — a destroyed stream, a
 * throwing `write`, a callback error (`EPIPE`, `EIO`) — turns the region dead for good: no further
 * writes, nothing thrown. SIGWINCH is its owner's to listen for (call {@link LiveRegion.resize}), and
 * so is every stop path (call {@link LiveRegion.close}, then `drainTerminal`). Nothing here runs at
 * import or installs a listener; the timer is `unref`ed.
 */

/** A piece of a row: plain text, and how to style it once cut. */
export interface LiveSegment {
  /** Plain text; control characters become spaces and escape sequences vanish before measuring. */
  readonly text: string;
  /** Adds SGR (colour) to the cut text; e.g. a palette's `paint` bound to a token. */
  readonly style?: (text: string) => string;
}

/** One row of the block: plain text, or segments styled each on its own. */
export type LiveRow = string | readonly LiveSegment[];

/** The terminal's size, as `process.stdout` holds it. */
export interface TerminalSize {
  readonly columns?: number;
  readonly rows?: number;
}

/** Time and timers, injected so specs run on a fake clock. */
export interface Scheduler {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  /** Calls `callback` once after `ms`; the timer must not keep the process alive. */
  setTimeout(callback: () => void, ms: number): unknown;
  /** Cancels a timer {@link Scheduler.setTimeout} returned. */
  clearTimeout(handle: unknown): void;
}

/** What {@link createLiveRegion} needs. */
export interface LiveRegionOptions {
  /** The stream, from `openLiveTerminal`; written in Buffers, so its backlog counts bytes. */
  readonly terminal: LiveTerminal;
  /** Whether a region may be drawn at all; without, the region only prints lines. */
  readonly capabilities: Pick<TerminalCapabilities, "live">;
  /** Reads the terminal's size: at creation and on each {@link LiveRegion.resize}. */
  readonly size: () => TerminalSize;
  /** What marks a cut row, measured: a palette's `symbol("ellipsis")`. */
  readonly ellipsis: string;
  /** The shortest time between content redraws. Default {@link DEFAULT_MIN_INTERVAL_MS}. */
  readonly minIntervalMs?: number;
  /** Draws are skipped while the stream holds more bytes than this. Default `TERMINAL_BACKLOG_BYTES`. */
  readonly maxBacklogBytes?: number;
  /** Default: the real clock and `unref`ed timers ({@link realScheduler}). */
  readonly scheduler?: Scheduler;
  /** Told once, with the error, when a write fails and the region dies. A throw is swallowed. */
  readonly onFailure?: (error: Error) => void;
}

/**
 * Where a region is. `live`: drawing. `passthrough`: never live, prints lines only. `closed`: block
 * cleared; prints lines only. `dead`: a write failed; writes nothing more.
 */
export type LiveState = "live" | "passthrough" | "closed" | "dead";

/** A live region bound to one stream. No method throws, whatever it is given. */
export interface LiveRegion {
  /** Sets the block's rows; drawn now, or at the throttle's next slot. Text that is no string draws as nothing. */
  update(rows: readonly LiveRow[]): void;
  /**
   * Prints permanent lines above the block: `text`, or each of `lines`, split at `\n`; SGR kept,
   * every other escape and control dropped ({@link sgrOnly}); anything not a string is skipped. In a
   * live region the block is cleared and repainted once after the burst: on the next turn of the
   * event loop, at least {@link REPAINT_GAP_MS} after the last draw.
   *
   * @returns whether the stream took them: `false` when the region was dead, or this write's failure
   *   (destroyed, thrown, or called back at once) made it so. A failure called back later still
   *   returns `true` here, and kills the region then.
   */
  print(text: string | readonly string[]): boolean;
  /** Re-reads the size after a SIGWINCH: erases the old block and draws it again later. */
  resize(): void;
  /** Clears the block for good; idempotent. Lines printed afterwards go straight through. */
  close(): void;
  readonly state: LiveState;
  /** The width rows are cut to now; 0 while too narrow or not live. */
  readonly width: number;
  /** The rows the block holds on screen now; 0 unless live. */
  readonly height: number;
}

/** At most 2 redraws a second: the suite's rate (the orchestrator passes 1,000). */
export const DEFAULT_MIN_INTERVAL_MS = 500;

/**
 * The shortest time between a draw and the repaint after a print. The repaint comes on the next turn
 * of the event loop, so a burst of prints written in one turn costs one repaint; and no sooner than
 * this after the last draw, so prints spread over many turns cost at most 20 repaints a second (the
 * block hidden meanwhile, never longer than this). Content changes keep their own, slower throttle.
 */
export const REPAINT_GAP_MS = 50;

/** The least wait before a draw the backlog skipped is tried again, whatever `minIntervalMs`. */
export const BACKLOG_RETRY_MS = 50;

/** A line end inside a live region: see the cursor contract. */
const LIVE_EOL = "\r\n";

/** One SGR sequence (`CSI` parameters `m`): colour and emphasis, nothing that moves the cursor. */
// eslint-disable-next-line no-control-regex -- matching an escape sequence is the point.
const SGR = /\u001b\[[0-9;:]*m/g;

/** Resets every SGR attribute. */
const SGR_RESET = "\u001b[0m";

/** Where the block may be drawn: rows' width, and the most rows (the terminal's height less one). */
export interface Geometry {
  readonly width: number;
  readonly maxHeight: number;
}

/** The real clock; each timer `unref`ed, so a pending redraw never keeps the process alive. */
export const realScheduler: Scheduler = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms).unref(),
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
};

/**
 * The bytes that clear a block of `height` rows from its last row, ending on its first row, column 0.
 *
 * @param height - the block's rows.
 * @example
 * ```ts
 * clearBytes(2); // "\r\x1b[2K\x1b[1A\r\x1b[2K"
 * ```
 */
export function clearBytes(height: number): string {
  if (height <= 0) return "";
  return `\r\x1b[2K${"\x1b[1A\r\x1b[2K".repeat(height - 1)}`;
}

/**
 * The bytes that erase a block of `height` rows after a resize, whatever the terminal's reflow did
 * to it: up `height - 1` rows (inside the block wherever the cursor landed on its last row's parts),
 * clear that row, save the cursor, go down one row and clear to the end of the screen, come back.
 * Clearing to the end from the row itself would, on the screen's top row, be tmux's
 * `scroll-on-clear` case, which scrolls the screen into history instead (measured).
 *
 * @param height - the block's rows before the resize.
 * @example
 * ```ts
 * resetBytes(3); // "\x1b[2A\r\x1b[2K\x1b7\x1b[1B\x1b[J\x1b8"
 * ```
 */
export function resetBytes(height: number): string {
  if (height <= 0) return "";
  const up = height > 1 ? `\x1b[${String(height - 1)}A` : "";
  return `${up}\r\x1b[2K\x1b7\x1b[1B\x1b[J\x1b8`;
}

/**
 * Where a terminal of `size` lets a block be drawn: `undefined` when its size is unknown, zero, or
 * narrower than {@link MIN_WIDTH} (a row would wrap) — the block then waits for a resize.
 *
 * @param size - the terminal's columns and rows.
 */
export function geometryOf(size: TerminalSize): Geometry | undefined {
  const { columns, rows } = size;
  if (!isPositiveInteger(columns) || !isPositiveInteger(rows)) return undefined;
  if (columns < MIN_WIDTH) return undefined;
  return {
    width: terminalWidth({ stream: { columns }, env: {} }),
    maxHeight: rows - 1,
  };
}

/**
 * One line with its SGR kept and every other escape sequence and control character dropped (a
 * control becomes a space, a `\n` too, as `withoutControls` does), so it cannot move the cursor;
 * when it holds SGR and does not end with a reset, one is added, so no colour bleeds past it.
 *
 * @param text - one line, maybe styled.
 * @returns the line, safe to print.
 * @example
 * ```ts
 * sgrOnly("\x1b[31mred\x1b[2A\r"); // "\x1b[31mred \x1b[0m"
 * ```
 */
export function sgrOnly(text: string): string {
  let out = "";
  let from = 0;
  for (const match of text.matchAll(SGR)) {
    out += withoutControls(text.slice(from, match.index)) + match[0];
    from = match.index + match[0].length;
  }
  if (from === 0) return withoutControls(text);
  return closeSgr(out + withoutControls(text.slice(from)));
}

/**
 * One row cut to `width` columns (whole graphemes, `ellipsis` marking a cut), then styled segment by
 * segment. The ellipsis takes the style of the segment it cuts. A `style` that throws, or returns
 * anything but its text with SGR added, leaves its text unstyled; a styled row ends with a reset.
 *
 * @param row - plain text, or segments.
 * @param width - the columns it may take.
 * @param ellipsis - the cut mark.
 * @returns the row, never wider than `width` (style aside).
 */
export function fitRow(row: LiveRow, width: number, ellipsis: string): string {
  const segments = segmentsOf(row);
  const full = segments.map((segment) => segment.text).join("");
  const cut = cutToWidth(full, width, ellipsis);
  // A cut is the kept prefix, then maybe the mark: anything not a prefix of the row ends in it.
  const whole = full.startsWith(cut);
  const kept = whole
    ? cut.length
    : cut.length - withoutControls(ellipsis).length;
  let out = "";
  let offset = 0;
  let cutSegment: LiveSegment | undefined;
  for (const segment of segments) {
    const take = Math.min(segment.text.length, Math.max(0, kept - offset));
    if (take > 0) out += styled(segment, segment.text.slice(0, take));
    if (take < segment.text.length) cutSegment ??= segment;
    offset += segment.text.length;
  }
  return closeSgr(whole ? out : out + styled(cutSegment, cut.slice(kept)));
}

/**
 * A block's bytes, drawn from a clean line: rows joined by `\r\n`, then `\r` so the cursor ends on
 * the last row's column 0.
 *
 * @param rows - the rows, cut to the geometry's height (first rows kept) and width.
 * @param geometry - where they are drawn.
 * @param ellipsis - the cut mark.
 * @returns the bytes and the block's height.
 */
export function frame(
  rows: readonly LiveRow[],
  geometry: Geometry,
  ellipsis: string,
): { readonly text: string; readonly height: number } {
  const shown = rows
    .slice(0, geometry.maxHeight)
    .map((row) => fitRow(row, geometry.width, ellipsis));
  if (shown.length === 0) return { text: "", height: 0 };
  return { text: `${shown.join(LIVE_EOL)}\r`, height: shown.length };
}

/**
 * A live region on `options.terminal`; a passthrough one (prints only) when the capabilities say no
 * live region.
 *
 * @param options - the terminal, capabilities, size, ellipsis, rate, backlog bound and clock.
 * @returns the region.
 * @throws {@link TypeError} when `terminal` did not come from `openLiveTerminal`.
 * @throws {@link RangeError} when `minIntervalMs` or `maxBacklogBytes` is not a whole number ≥ 0.
 * @example
 * ```ts
 * const terminal = openLiveTerminal(); // standard output: non-blocking, its `error` event heard
 * const region = createLiveRegion({
 *   terminal,
 *   capabilities,
 *   size: () => process.stdout,
 *   ellipsis: palette.symbol("ellipsis"),
 * });
 * process.stdout.on("resize", () => region.resize());
 * region.update(["3/10 · 2 passed · 1 running"]);
 * region.print("✔ Create a backup");
 * region.close();
 * await drainTerminal(terminal.sink, 2_000);
 * ```
 */
export function createLiveRegion(options: LiveRegionOptions): LiveRegion {
  if (!LiveTerminal.isOpened(options.terminal))
    throw new TypeError(
      "A live region needs a terminal from openLiveTerminal: non-blocking, its error event heard.",
    );
  return new Region(options);
}

/** {@link LiveRegion}'s one implementation; its whole model of the screen is `height`. */
class Region implements LiveRegion {
  #state: LiveState;
  #geometry: Geometry | undefined;
  #height = 0;
  /** The rows last drawn: what a print or a resize repaints. */
  #shown: readonly LiveRow[] = [];
  /** Rows waiting for a draw (the throttle, a repaint, the backlog), newest only. */
  #pending: readonly LiveRow[] | undefined;
  #lastDrawAt = -Infinity;
  #timer: unknown;
  /** When the armed timer fires, on the scheduler's clock. */
  #timerAt = Infinity;
  readonly #options: LiveRegionOptions;
  readonly #scheduler: Scheduler;
  readonly #minIntervalMs: number;
  readonly #maxBacklogBytes: number;

  /**
   * @param options - see {@link createLiveRegion}.
   */
  constructor(options: LiveRegionOptions) {
    this.#options = options;
    this.#scheduler = options.scheduler ?? realScheduler;
    this.#minIntervalMs = wholeNumber(
      options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS,
      "minIntervalMs",
    );
    this.#maxBacklogBytes = wholeNumber(
      options.maxBacklogBytes ?? TERMINAL_BACKLOG_BYTES,
      "maxBacklogBytes",
    );
    this.#state = options.capabilities.live ? "live" : "passthrough";
    this.#geometry = this.#state === "live" ? this.#readGeometry() : undefined;
  }

  get state(): LiveState {
    return this.#state;
  }

  get width(): number {
    return this.#state === "live" ? (this.#geometry?.width ?? 0) : 0;
  }

  get height(): number {
    return this.#height;
  }

  update(rows: readonly LiveRow[]): void {
    if (this.#state !== "live") return;
    const given: unknown = rows;
    this.#pending = Array.isArray(given) ? (given.slice() as LiveRow[]) : [];
    this.#schedule();
  }

  print(text: string | readonly string[]): boolean {
    if (this.#state === "dead") return false;
    const lines = printable(text);
    if (lines.length === 0) return true;
    if (this.#state !== "live") return this.#write(`${lines.join("\n")}\n`);
    const cleared = this.#height;
    this.#height = 0;
    // The lines first, whatever the backlog: a permanent line is never dropped here.
    const taken = this.#write(
      `${clearBytes(cleared)}${lines.join(LIVE_EOL)}${LIVE_EOL}`,
    );
    // A failed write left the region dead, where arming does nothing.
    if (cleared > 0) {
      this.#pending ??= this.#shown;
      const sinceDraw = this.#scheduler.now() - this.#lastDrawAt;
      this.#armTimer(Math.max(0, REPAINT_GAP_MS - sinceDraw));
    }
    return taken;
  }

  resize(): void {
    if (this.#state !== "live") return;
    const erase = resetBytes(this.#height);
    this.#height = 0;
    this.#geometry = this.#readGeometry();
    this.#pending ??= this.#shown;
    if (erase !== "" && !this.#write(erase)) return;
    this.#schedule();
  }

  close(): void {
    if (this.#state === "dead" || this.#state === "closed") return;
    this.#cancelTimer();
    const live = this.#state === "live";
    this.#state = "closed";
    if (live && this.#height > 0) this.#write(clearBytes(this.#height));
    this.#height = 0;
    this.#pending = undefined;
  }

  /** Draws now if the throttle allows, else arms the timer for its next slot; one timer at most. */
  #schedule(): void {
    const wait = this.#lastDrawAt + this.#minIntervalMs - this.#scheduler.now();
    if (wait <= 0) this.#flush();
    else this.#armTimer(wait);
  }

  /**
   * Arms the timer to fire in `ms`, unless one already fires as soon; one firing later is moved up.
   *
   * @param ms - when it fires.
   */
  #armTimer(ms: number): void {
    if (this.#state !== "live") return;
    const at = this.#scheduler.now() + ms;
    if (this.#timer !== undefined && this.#timerAt <= at) return;
    this.#cancelTimer();
    this.#timerAt = at;
    this.#timer = this.#scheduler.setTimeout(() => {
      this.#timer = undefined;
      this.#timerAt = Infinity;
      this.#flush();
    }, ms);
  }

  /** Cancels the armed timer, if any. */
  #cancelTimer(): void {
    if (this.#timer === undefined) return;
    this.#scheduler.clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#timerAt = Infinity;
  }

  /** Draws the pending rows over the block, unless the backlog or the size forbids it now. */
  #flush(): void {
    if (this.#state !== "live" || this.#pending === undefined) return;
    if (this.#geometry === undefined) return; // A resize brings it back.
    if (!this.#canDraw()) {
      this.#armTimer(Math.max(this.#minIntervalMs, BACKLOG_RETRY_MS));
      return;
    }
    const rows = this.#pending;
    const drawn = frame(rows, this.#geometry, this.#options.ellipsis);
    const bytes = `${clearBytes(this.#height)}${drawn.text}`;
    this.#pending = undefined;
    this.#shown = rows;
    this.#lastDrawAt = this.#scheduler.now();
    this.#height = drawn.height;
    if (bytes !== "") this.#write(bytes);
  }

  /** Whether a draw may be written now: a backlog within bound (an unreadable one kills). */
  #canDraw(): boolean {
    const backlog = backlogBytes(this.#options.terminal.sink);
    if (backlog === undefined) {
      this.#fail(new Error("The stream's backlog cannot be read."));
      return false;
    }
    return backlog <= this.#maxBacklogBytes;
  }

  /** The size's geometry; a size source that throws reads as no size. */
  #readGeometry(): Geometry | undefined {
    try {
      return geometryOf(this.#options.size());
    } catch {
      return undefined;
    }
  }

  /**
   * Writes `text`, UTF-8 encoded; a failure kills the region.
   *
   * @param text - the bytes, as text.
   * @returns whether the stream took them and the region is still alive.
   */
  #write(text: string): boolean {
    if (this.#state === "dead") return false;
    let failed = false;
    const taken = writeSafely(
      this.#options.terminal.sink,
      Buffer.from(text, "utf8"),
      (error) => {
        failed = true;
        this.#fail(error);
      },
    );
    // A failure called back during `write` counts; one called back later only kills the region.
    return taken && !failed;
  }

  /**
   * Turns the region dead for good and tells the caller, once.
   *
   * @param error - what failed.
   */
  #fail(error: Error): void {
    if (this.#state === "dead") return;
    this.#state = "dead";
    this.#cancelTimer();
    this.#height = 0;
    this.#pending = undefined;
    try {
      this.#options.onFailure?.(error);
    } catch {
      // The caller's hook must not make a write throw.
    }
  }
}

/**
 * A print's lines: each string split at `\n`, made safe by {@link sgrOnly}; anything not a string is
 * no line.
 *
 * @param text - what `print` was given.
 */
function printable(text: unknown): string[] {
  const texts: readonly unknown[] = Array.isArray(text) ? text : [text];
  return texts
    .filter((item): item is string => typeof item === "string")
    .flatMap((item) => item.split("\n"))
    .map(sgrOnly);
}

/**
 * A row's segments with their text made plain. A row or text that is no string, or a segment whose
 * fields cannot be read, draws as nothing; a style that is no function is none.
 *
 * @param row - what `update` was given for one row.
 */
function segmentsOf(row: unknown): LiveSegment[] {
  if (typeof row === "string") return [{ text: withoutControls(row) }];
  if (!Array.isArray(row)) return [];
  return row.map((segment: unknown): LiveSegment => {
    try {
      const text: unknown = Reflect.get(Object(segment), "text");
      const style: unknown = Reflect.get(Object(segment), "style");
      return {
        text: typeof text === "string" ? withoutControls(text) : "",
        style:
          typeof style === "function"
            ? (style as (text: string) => string)
            : undefined,
      };
    } catch {
      return { text: "" };
    }
  });
}

/**
 * `text` in `segment`'s style; unstyled when it has none, its style throws, or what it returns is
 * not `text` with only SGR added.
 *
 * @param segment - the segment the text comes from.
 * @param text - plain, cut text.
 */
function styled(segment: LiveSegment | undefined, text: string): string {
  if (segment?.style === undefined || text === "") return text;
  try {
    const out: unknown = segment.style(text);
    return typeof out === "string" && out.replace(SGR, "") === text
      ? out
      : text;
  } catch {
    return text;
  }
}

/**
 * `text`, ending with an SGR reset when it holds an escape and does not end with a reset already.
 *
 * @param text - a line whose only escapes are SGR.
 */
function closeSgr(text: string): string {
  if (!text.includes("\u001b")) return text;
  return text.endsWith(SGR_RESET) || text.endsWith("\u001b[m")
    ? text
    : text + SGR_RESET;
}

/**
 * Whether `value` is a whole number above 0.
 *
 * @param value - anything.
 */
function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/**
 * Checks an option that is a whole number ≥ 0.
 *
 * @param value - the option's value.
 * @param name - its name, for the message.
 * @returns the value.
 * @throws {@link RangeError} when it is not.
 */
function wholeNumber(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(
      `${name} is a whole number from 0, got ${String(value)}.`,
    );
  return value;
}
