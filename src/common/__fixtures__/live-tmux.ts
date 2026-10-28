import { cutToWidth, displayWidth, MAX_WIDTH } from "../terminal/layout";

/**
 * For the live region's tmux spec: what its driver draws and prints, and what the spec allows a
 * resize to leave behind — shared so the spec knows every permanent line to expect. Pure; the driver
 * is `live-tmux-driver.ts`.
 */

/** Every live row starts with this; no permanent line contains it. */
export const LIVE_MARK = "L|";

/** The line the driver prints after each phase, numbered from 1; the spec resizes on seeing it. */
export const phaseDoneLine = (phase: number): string =>
  `PHASE ${String(phase)} DONE`;

/** The driver's last line, printed after the region is closed. */
export const DONE_LINE = "DRIVER DONE";

/** The line the driver prints, and exits on, when the capabilities refuse a live region. */
export const NOT_LIVE_LINE = "DRIVER NOT LIVE";

/** What the pane's shell prints once the driver ends by itself (a crash): the spec fails at once. */
export const EXITED_PREFIX = "DRIVER EXITED";

/** The prefix of the folder each tmux server's socket lives in; the driver removes only such. */
export const SOCKET_DIR_PREFIX = "e2e-live-tmux-";

/**
 * The permanent line numbered `n` (from 1): every fifth a 150-character line that wraps in any pane
 * up to 120 columns, the others short. Unique, so a lost or doubled line shows.
 *
 * @param n - the line's number.
 */
export function permanentLine(n: number): string {
  const id = `P${String(n).padStart(4, "0")}`;
  return n % 5 === 0 ? `${id} ${"w".repeat(144)}` : `${id} printed line`;
}

/** The rows blocks are made of: 120 columns, wide CJK cut mid-way, a wide one straddling a cut. */
const ROW_KINDS = [
  `${LIVE_MARK}${"x".repeat(118)}`,
  `${LIVE_MARK}${"中文".repeat(40)}`,
  `${LIVE_MARK}${"y".repeat(37)}中z`,
] as const;

/**
 * A block of `height` rows: `first`, then the {@link ROW_KINDS} in turn.
 *
 * @param first - the first row.
 * @param height - how many rows.
 */
function block(first: string, height: number): readonly string[] {
  return Array.from({ length: height }, (_, row) =>
    row === 0 ? first : (ROW_KINDS[(row - 1) % ROW_KINDS.length] ?? first),
  );
}

/**
 * The block for cycle `i`: 1 to 12 rows (12 is past a 10-row pane's cap).
 *
 * @param i - the cycle.
 */
export function liveRows(i: number): readonly string[] {
  return block(
    `${LIVE_MARK}cycle ${String(i)}`,
    i % 6 === 5 ? 12 : 1 + (i % 4),
  );
}

/** How many rows the block holds while the driver waits for a resize. */
export const WAIT_HEIGHT = 8;

/**
 * The tall block the driver keeps redrawing while it waits for a resize, so every resize meets one.
 * Its first row alternates between two texts, so each update is a real redraw.
 *
 * @param tick - the redraw's number.
 */
export function waitRows(tick: number): readonly string[] {
  return block(`${LIVE_MARK}wait ${tick % 2 === 0 ? "a" : "b"}`, WAIT_HEIGHT);
}

/** What a phase of the driver does: its cycles, each an update, every third also a print. */
export const CYCLES_PER_PHASE = 21;

/**
 * Whether cycle `i` of a phase prints a permanent line.
 *
 * @param i - the cycle, from 0.
 */
export const printsAt = (i: number): boolean => i % 3 === 0;

/**
 * Every line the driver prints, in order, for `phases` phases.
 *
 * @param phases - how many phases it runs.
 */
export function expectedPermanentLines(phases: number): readonly string[] {
  const lines: string[] = [];
  let n = 0;
  for (let phase = 1; phase <= phases; phase++) {
    for (let i = 0; i < CYCLES_PER_PHASE; i++)
      if (printsAt(i)) lines.push(permanentLine(++n));
    lines.push(phaseDoneLine(phase));
  }
  lines.push(DONE_LINE);
  return lines;
}

/** A pane's size. */
export interface PaneSize {
  readonly columns: number;
  readonly rows: number;
}

/**
 * The wait block's rows (both first rows) as the region draws them in a pane of `size`: capped at
 * `rows - 1`, each cut to the width (at most {@link MAX_WIDTH}). What a resize may leave is a part of
 * one of these.
 *
 * @param size - the pane the block was drawn in.
 */
export function drawnWaitRows(size: PaneSize): readonly string[] {
  const width = Math.min(size.columns, MAX_WIDTH);
  const rows = [
    ...waitRows(0).slice(0, size.rows - 1),
    ...waitRows(1).slice(0, 1),
  ];
  return [...new Set(rows.map((row) => cutToWidth(row, width, "…")))];
}

/**
 * How many lines `row` takes once a terminal wraps it at `columns`: whole characters, a wide one
 * that does not fit moving to the next line.
 *
 * @param row - a drawn row.
 * @param columns - the pane's width.
 */
export function wrappedLines(row: string, columns: number): number {
  let lines = 1;
  let column = 0;
  for (const character of row) {
    const width = displayWidth(character);
    if (column + width > columns) {
      lines++;
      column = 0;
    }
    column += width;
  }
  return lines;
}

/**
 * The most lines of the wait block a resize from `before` to `after` may leave, as measured (tmux 3.4
 * and 3.8, xterm.js 5.5): the parts a narrowing splits off beyond the block's height, the rows a
 * shorter pane pushes into history, and — tmux 3.8 only, its reflow of wide characters on widening —
 * up to half the block. "Writes nothing", "erases one row" and "erases to the end from the top-left"
 * (tmux then scrolls the screen into history) each leave more.
 *
 * @param before - the pane the block was drawn in.
 * @param after - the pane after the resize.
 */
export function residueBound(before: PaneSize, after: PaneSize): number {
  const width = Math.min(before.columns, MAX_WIDTH);
  const drawn = waitRows(0)
    .slice(0, before.rows - 1)
    .map((row) => cutToWidth(row, width, "…"));
  const parts = drawn.reduce(
    (sum, row) => sum + wrappedLines(row, after.columns),
    0,
  );
  const reached = Math.min(drawn.length, after.rows - 1);
  const widened =
    after.columns > before.columns ? Math.ceil(drawn.length / 2) : 0;
  return Math.max(0, parts - reached) + widened;
}
