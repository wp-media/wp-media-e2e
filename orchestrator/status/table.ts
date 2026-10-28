import {
  cutToWidth,
  DEFAULT_WIDTH,
  displayWidth,
  MAX_WIDTH,
  MIN_WIDTH,
  padEnd,
  padStart,
} from "../../src/common/terminal/layout";
import type { Palette } from "../../src/common/terminal/palette";
import { plain } from "../../src/common/text";
import { clockTime } from "../log";
import {
  runState,
  type Board,
  type EndedRun,
  type LiveRun,
  type TaskState,
} from "./board";

/**
 * The status table: one row per task, `TASK RUN CELL PROGRESS ELAPSED STATE`, laid out for a width
 * and a height. Pure, and plain: every value goes through `plain`, every cell and line is cut to fit
 * (`layout.ts`), and the palette given decides the symbols — styling is the caller's, after the cut.
 *
 * ```text
 * TASK  RUN      CELL        PROGRESS                    ELAPSED  STATE
 * bpng  bpng-12  pro@nginx   ███████░░░ 38/52 · 1 failed  18m 04s  running
 * bfap  —        free@nginx  ✔ passed · 52 scenarios      54m 10s  next 11:14:42
 * ```
 *
 * Narrower, the columns go in order — the bar, ELAPSED, CELL, then the counts — and below
 * {@link COMPACT_WIDTH} columns each task is one short line with no header (`bpng  running  38/52`).
 * Shorter than its tasks, the header goes first; then it shows the runs in flight first, then the
 * others in the config's order, each in its config place, and `and N more`.
 */

/** Below this width, each task is one short line: a table's columns would not fit. */
export const COMPACT_WIDTH = 50;

/** The bar's cells. */
export const BAR_CELLS = 10;

/** Between two columns. */
const GAP = "  ";

/** How the table is laid out. */
export interface TableOptions {
  /** The columns it may take: read as `terminalWidth` gives it, clamped to 20–120. */
  readonly width: number;
  /** The lines it may take, its header included; no bound when absent. */
  readonly height?: number;
  /** The symbols, and the status words; never styled here. */
  readonly palette: Pick<Palette, "symbol" | "status">;
  /** Now: a run's elapsed time is counted to it. */
  readonly now: Date;
}

/** A row's cells, before they are laid out; `detail` and `bar` are dropped first. */
interface RowCells {
  readonly task: string;
  readonly run: string;
  readonly cell: string;
  readonly bar: string;
  /** `38/52`, `✔ passed` or `—`. */
  readonly main: string;
  /** `· 1 failed`, `· 52 scenarios`, or nothing. */
  readonly detail: string;
  readonly elapsed: string;
  readonly state: string;
}

/** Which optional parts a layout keeps. */
interface Level {
  readonly bar: boolean;
  readonly elapsed: boolean;
  readonly cell: boolean;
  readonly detail: boolean;
}

/** The layouts from widest to narrowest: the bar goes first, then ELAPSED, CELL, the counts. */
const LEVELS: readonly Level[] = [
  { bar: true, elapsed: true, cell: true, detail: true },
  { bar: false, elapsed: true, cell: true, detail: true },
  { bar: false, elapsed: false, cell: true, detail: true },
  { bar: false, elapsed: false, cell: false, detail: true },
  { bar: false, elapsed: false, cell: false, detail: false },
];

/** A column: its header, its widest cell, how it is aligned and which layouts keep it. */
interface Column {
  readonly header: string;
  readonly max: number;
  readonly right?: boolean;
  readonly kept: (level: Level) => boolean;
  readonly value: (cells: RowCells, level: Level) => string;
}

/** The columns, in order. */
const COLUMNS: readonly Column[] = [
  { header: "TASK", max: 8, kept: () => true, value: (c) => c.task },
  { header: "RUN", max: 16, kept: () => true, value: (c) => c.run },
  {
    header: "CELL",
    max: 24,
    kept: (level) => level.cell,
    value: (c) => c.cell,
  },
  {
    header: "PROGRESS",
    max: 60,
    kept: () => true,
    value: (c, level) =>
      [level.bar ? c.bar : "", c.main, level.detail ? c.detail : ""]
        .filter((part) => part !== "")
        .join(" "),
  },
  {
    header: "ELAPSED",
    max: 8,
    right: true,
    kept: (level) => level.elapsed,
    value: (c) => c.elapsed,
  },
  { header: "STATE", max: 16, kept: () => true, value: (c) => c.state },
];

/**
 * The table's lines.
 *
 * @param board - every task, in the config's order.
 * @param options - the width, the height, the palette, now.
 * @returns the lines, none wider than the width, at most `height` of them; none for no task.
 * @example
 * ```ts
 * renderTable(board, { width: 80, height: 22, palette, now: new Date() });
 * // ["TASK  RUN      CELL       PROGRESS …", "bpng  bpng-12  pro@nginx  ███████░░░ 38/52 …"]
 * ```
 */
export function renderTable(board: Board, options: TableOptions): string[] {
  const width = tableWidth(options.width);
  const ellipsis = options.palette.symbol("ellipsis");
  const compact = width < COMPACT_WIDTH;
  const shown = pickRows(board, options.height, !compact);
  if (shown === undefined) return [];
  const cells = shown.rows.map((task) => rowCells(task, options));
  const lines =
    compact || cells.length === 0
      ? cells.map(compactLine)
      : tableLines(cells, width, ellipsis).slice(shown.header ? 0 : 1);
  if (shown.more > 0)
    lines.push(
      cells.length === 0
        ? `${String(shown.more)} tasks`
        : `and ${String(shown.more)} more`,
    );
  return lines.map((line) => cutToWidth(line, width, ellipsis));
}

/**
 * A width as the table reads it: a whole number of columns within 20–120; anything else the
 * default.
 *
 * @param width - the width asked for.
 * @returns the width used.
 */
export function tableWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.floor(width)));
}

/** The rows a height leaves room for. */
export interface PickedRows {
  /** The rows shown, in the config's order. */
  readonly rows: Board;
  /** How many were left out. */
  readonly more: number;
  /** Whether the header is shown. */
  readonly header: boolean;
}

/**
 * Which rows fit a height: all, with the header, when they do; else the header is dropped before any
 * row is — every row without it, when they fit; else the runs in flight first, then the others in
 * the config's order — shown in their config places — and a line saying how many were left out. With
 * one line, only the count is.
 *
 * @param board - every task.
 * @param height - the lines the table may take; no bound when absent.
 * @param header - whether the layout has a header.
 * @returns the rows, how many more there are, and whether the header shows; `undefined` when no
 *   line fits, or there is no task.
 */
export function pickRows(
  board: Board,
  height: number | undefined,
  header: boolean,
): PickedRows | undefined {
  if (board.length === 0) return undefined;
  const lines =
    height === undefined || Number.isNaN(height)
      ? Infinity
      : Math.floor(height);
  if (lines < 1) return undefined;
  const headerLines = header ? 1 : 0;
  if (board.length + headerLines <= lines)
    return { rows: board, more: 0, header };
  // The header is dropped before any row: every row without it beats some rows with it.
  if (board.length <= lines) return { rows: board, more: 0, header: false };
  // One line for "and N more".
  const room = lines - 1;
  const inFlight = board.filter((task) => task.phase.kind === "run");
  const others = board.filter((task) => task.phase.kind !== "run");
  const chosen = new Set([...inFlight, ...others].slice(0, room));
  return {
    rows: board.filter((task) => chosen.has(task)),
    more: board.length - chosen.size,
    header: false,
  };
}

/**
 * The table's lines at the widest layout that fits: a header, then a row per task.
 *
 * @param cells - each row's cells.
 * @param width - the width.
 * @param ellipsis - what marks a cut cell.
 * @returns the lines, the narrowest layout's when none fits (cut by the caller).
 */
function tableLines(
  cells: readonly RowCells[],
  width: number,
  ellipsis: string,
): string[] {
  let lines: string[] = [];
  for (const level of LEVELS) {
    lines = layOut(cells, level, ellipsis);
    if (lines.every((line) => displayWidth(line) <= width)) return lines;
  }
  return lines;
}

/**
 * The lines of one layout: each kept column as wide as its widest cell (each cell cut to the
 * column's bound first), two spaces apart, the last never padded.
 *
 * @param cells - each row's cells.
 * @param level - which parts are kept.
 * @param ellipsis - what marks a cut cell.
 * @returns the header and the rows.
 */
function layOut(
  cells: readonly RowCells[],
  level: Level,
  ellipsis: string,
): string[] {
  const columns = COLUMNS.filter((column) => column.kept(level));
  const grid = [
    columns.map((column) => column.header),
    ...cells.map((row) =>
      columns.map((column) =>
        cutToWidth(column.value(row, level), column.max, ellipsis),
      ),
    ),
  ];
  const widths = columns.map((_, i) =>
    Math.max(...grid.map((row) => displayWidth(row[i] ?? ""))),
  );
  return grid.map((row) =>
    row
      .map((text, i) => {
        if (i === row.length - 1) return text;
        const columnWidth = widths[i] ?? 0;
        return columns[i]?.right === true
          ? padStart(text, columnWidth)
          : padEnd(text, columnWidth);
      })
      .join(GAP),
  );
}

/**
 * A task's one short line, for a narrow terminal: its id, its state and its progress.
 *
 * @param cells - the task's cells.
 * @returns `bpng  running  38/52`.
 */
function compactLine(cells: RowCells): string {
  return [cells.task, cells.state, cells.main].join(GAP);
}

/**
 * A task's cells.
 *
 * @param task - the task.
 * @param options - the palette and now.
 * @returns its cells, every value plain; a task whose last attempt began no run shows `not started`
 *   and its reason's class (`failed`, `stopped`).
 */
function rowCells(task: TaskState, options: TableOptions): RowCells {
  const { palette, now } = options;
  const dash = palette.symbol("dash");
  const { phase } = task;
  const base = { task: plain(task.taskId), cell: plain(task.cell) };
  if (phase.kind === "run") {
    const { run } = phase;
    return {
      ...base,
      run: plain(run.id),
      ...liveProgress(run, palette, dash),
      elapsed: formatElapsed(now.getTime() - run.startedAt.getTime()),
      state: liveState(run),
    };
  }
  if (task.notStarted !== undefined)
    return {
      ...base,
      run: dash,
      bar: "",
      // The attempt began no run: its reason's class, never the run before it alone.
      main: `${palette.symbol(task.notStarted === "stopped" ? "stopped" : "failed")} not started`,
      detail: `${palette.symbol("separator")} ${task.notStarted}`,
      elapsed: dash,
      state: idleState(task),
    };
  return {
    ...base,
    run: dash,
    ...lastProgress(task.last, palette, dash),
    elapsed:
      task.last?.durationMs === undefined
        ? dash
        : formatElapsed(task.last.durationMs),
    state: idleState(task),
  };
}

/**
 * A run in flight's progress: the bar, `done/planned`, and what did not pass — once `run.begin` was
 * read; a dash before; `unknown` once its stream passed the end-of-run reader's cap.
 *
 * @param run - the run.
 * @param palette - the symbols.
 * @param dash - the empty cell.
 * @returns its bar, main and detail.
 */
function liveProgress(
  run: LiveRun,
  palette: TableOptions["palette"],
  dash: string,
): Pick<RowCells, "bar" | "main" | "detail"> {
  const { progress } = run;
  const separator = palette.symbol("separator");
  if (progress.tooLarge)
    return {
      bar: "",
      main: "unknown",
      detail: `${separator} results too large`,
    };
  if (!progress.begun) return { bar: "", main: dash, detail: "" };
  const notPassed = [
    countWord(progress.failed, "failed"),
    countWord(progress.flaky, "flaky"),
    countWord(progress.stopped, "stopped"),
  ].filter((part) => part !== "");
  return {
    bar: progressBar(progress.done, progress.planned, palette),
    main: `${String(progress.done)}/${String(progress.planned)}`,
    detail: notPassed.map((part) => `${separator} ${part}`).join(" "),
  };
}

/**
 * The last run's outcome, for a task with none in flight: its status, and its scenarios.
 *
 * @param last - the last run, if any.
 * @param palette - the symbols and status words.
 * @param dash - the empty cell.
 * @returns its main and detail; no bar.
 */
function lastProgress(
  last: EndedRun | undefined,
  palette: TableOptions["palette"],
  dash: string,
): Pick<RowCells, "bar" | "main" | "detail"> {
  if (last === undefined) return { bar: "", main: dash, detail: "" };
  const scenarios = last.scenarios ?? 0;
  return {
    bar: "",
    main: palette.status(last.status),
    detail:
      scenarios > 0
        ? `${palette.symbol("separator")} ${String(scenarios)} ${scenarios === 1 ? "scenario" : "scenarios"}`
        : "",
  };
}

/**
 * `N word`, or nothing for none.
 *
 * @param n - how many.
 * @param word - what.
 * @returns e.g. `1 failed`.
 */
function countWord(n: number, word: string): string {
  return n > 0 ? `${String(n)} ${word}` : "";
}

/**
 * A run in flight's state word.
 *
 * @param run - the run.
 * @returns `starting`, `setup n/m`, `running` or `stopping`.
 */
function liveState(run: LiveRun): string {
  const state = runState(run);
  return state.kind === "setup"
    ? `setup ${String(state.ended)}/${String(state.total)}`
    : state.kind;
}

/**
 * A task with no run in flight's state word.
 *
 * @param task - the task.
 * @returns `starting` (no run yet), `ended`, `next HH:MM:SS`, or how its loop ended: `stopped`,
 *   `done` (`--once`), `loop failed`.
 */
function idleState(task: TaskState): string {
  const { phase } = task;
  switch (phase.kind) {
    case "cooling":
      return `next ${clockTime(phase.nextRunAt)}`;
    case "ended":
      return "ended";
    case "over":
      return phase.ended === "once"
        ? "done"
        : phase.ended === "failed"
          ? "loop failed"
          : "stopped";
    default:
      return "starting";
  }
}

/**
 * A progress bar of {@link BAR_CELLS} cells.
 *
 * @param done - how many ended.
 * @param total - how many planned; none draws an empty bar.
 * @param palette - its two symbols.
 * @returns the bar.
 */
export function progressBar(
  done: number,
  total: number,
  palette: Pick<Palette, "symbol">,
): string {
  const filled =
    total > 0
      ? Math.min(BAR_CELLS, Math.max(0, Math.floor((done / total) * BAR_CELLS)))
      : 0;
  return (
    palette.symbol("barDone").repeat(filled) +
    palette.symbol("barLeft").repeat(BAR_CELLS - filled)
  );
}

/**
 * An elapsed time, as the table shows it: `9s`, `18m 04s`, `2h 05m`.
 *
 * @param ms - milliseconds; a negative or non-finite one reads as 0.
 * @returns the time.
 */
export function formatElapsed(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const two = (n: number): string => String(n).padStart(2, "0");
  if (hours > 0) return `${String(hours)}h ${two(minutes)}m`;
  if (minutes > 0) return `${String(minutes)}m ${two(seconds)}s`;
  return `${String(seconds)}s`;
}
