import stringWidth from "string-width";

import { withoutControls } from "../text";
import { MIN_WIDTH } from "./capabilities";
import type { Environment, OutputStream } from "./capabilities";

/**
 * Terminal layout: how wide the screen is, how many columns a text takes, and cutting, padding and
 * rules by those columns. Shared by the suite's reporter and the orchestrator's logger.
 *
 * Pure: the stream and the environment are parameters; nothing here reads `process`, installs a
 * listener or starts a timer, at import or at call.
 *
 * Plain text in, plain text out — style is a sink: build a line from `plain` (and masked) values,
 * lay it out here, then style it. Every function first runs its text through `withoutControls`:
 * escape sequences are removed and every other control character (a tab, a newline) becomes one
 * space, so a styled or hostile input never reaches the screen as an escape or half of one, and no
 * input throws (a throwing reporter would fail a passing run).
 *
 * Who cuts what: live rows are cut to the width ({@link cutToWidth}); permanent lines never are,
 * except the {@link capLine} safety cap. Commands and paths are never cut, so whoever builds a line
 * decides what to pass here: a rerun command or a report path must stay whole, or it cannot be
 * pasted.
 */

export { MIN_WIDTH };

/** The widest: longer rows are hard to scan, and a resize to a huge window must not stretch them. */
export const MAX_WIDTH = 120;

/** The width when neither the stream nor `COLUMNS` gives one (a pipe or a file). */
export const DEFAULT_WIDTH = 80;

/**
 * The most code points {@link capLine} keeps in a permanent line, and the most columns any width
 * here is read as, so no call builds a huge string.
 */
export const LINE_CAP = 500;

/**
 * `string-width`'s options: ambiguous-width characters (Unicode East Asian Width `A`: `…`, `·`, `—`,
 * `━`, `█`, `é`, `±`) count 1 column, as terminals outside CJK locales draw them. It is the
 * library's default, set here so it reads as the decision it is.
 */
const MEASURE = { ambiguousIsNarrow: true };

/** Splits text into user-perceived characters (grapheme clusters), as terminals group them. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** One indivisible piece of a line: a grapheme cluster and its columns. */
interface Grapheme {
  /** The cluster, as written. */
  readonly text: string;
  /** Its columns, by {@link graphemeWidth}. */
  readonly width: number;
}

/** What {@link terminalWidth} decides from. */
export interface WidthInputs {
  /** The stream written to: its `columns`, when it is a sized terminal. */
  readonly stream: Pick<OutputStream, "columns">;
  /** The environment: its `COLUMNS`. */
  readonly env: Environment;
}

/**
 * The width to lay a stream's lines out in: the terminal's `columns` when it is a finite integer
 * above 0, else `COLUMNS` when it is a positive decimal integer, else {@link DEFAULT_WIDTH};
 * clamped to {@link MIN_WIDTH}–{@link MAX_WIDTH}. A terminal keeps its size under `TERM=dumb`, a C
 * locale or plain mode: those change the styling, not the screen. `columns` of 0 (a pty `script`
 * opened without a size) is no size, never width 0. A terminal narrower than {@link MIN_WIDTH} gets
 * no live region (the capabilities decide so); only its permanent lines are laid out wider, and wrap.
 *
 * @param inputs - the stream and the environment.
 * @returns the width in columns.
 * @example
 * ```ts
 * terminalWidth({ stream: { columns: 200 }, env: {} }); // 120
 * terminalWidth({ stream: {}, env: { COLUMNS: "100" } }); // 100
 * terminalWidth({ stream: { columns: 0 }, env: { COLUMNS: "abc" } }); // 80
 * ```
 */
export function terminalWidth(inputs: WidthInputs): number {
  const { stream, env } = inputs;
  const width =
    positiveInteger(stream.columns) ??
    parseColumns(env.COLUMNS) ??
    DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

/**
 * The columns `text` takes on a terminal, never fewer than it draws: the sum of its graphemes'
 * {@link graphemeWidth}, after `withoutControls` (a tab or a newline is the 1-column space it
 * becomes, an escape sequence nothing).
 *
 * @param text - one line.
 * @returns its width in columns.
 * @example
 * ```ts
 * displayWidth("a中👍"); // 5
 * displayWidth("café…"); // 5
 * ```
 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const grapheme of graphemes(withoutControls(text))) {
    width += grapheme.width;
  }
  return width;
}

/**
 * `text` cut to at most `width` columns: a prefix of whole graphemes — never half an emoji, a
 * surrogate pair or a base without its marks. Text that fits is returned whole (after
 * `withoutControls`). A cut line ends with `ellipsis` when at least one grapheme fits before it;
 * when none does, it shows what fits without one (in 2 columns `中` says more than `…`); when nothing
 * fits at all, it is the ellipsis if that fits, else `""`. Measuring stops at the first grapheme
 * past the width: a megabyte line costs one linear `withoutControls` pass, not a full measure.
 *
 * @param text - one line of plain text.
 * @param width - the most columns: a fraction rounded down; negative, `NaN` or infinite 0; at most
 *   {@link LINE_CAP}.
 * @param ellipsis - what marks a cut: the palette's `symbol("ellipsis")` (`…` or `...`), measured
 *   here, never assumed one column; `""` for none.
 * @returns the line, `displayWidth(result) <= width`.
 * @example
 * ```ts
 * cutToWidth("Backups › Create a backup", 12, "…"); // "Backups › C…"
 * cutToWidth("中文字", 2, "…"); // "中"
 * ```
 */
export function cutToWidth(
  text: string,
  width: number,
  ellipsis: string,
): string {
  const line = withoutControls(text);
  const limit = columns(width);
  const mark = withoutControls(ellipsis);
  const budget = limit - displayWidth(mark);
  let used = 0;
  let kept = "";
  // The longest prefix that fits beside the ellipsis.
  let marked = "";
  for (const grapheme of graphemes(line)) {
    used += grapheme.width;
    if (used > limit) {
      if (marked !== "") return `${marked}${mark}`;
      if (kept !== "") return kept;
      return budget >= 0 ? mark : "";
    }
    kept += grapheme.text;
    if (used <= budget) marked = kept;
  }
  return line;
}

/**
 * `text` with spaces after it up to `width` columns, for a left-aligned column. Text already as wide
 * or wider is returned as is (after `withoutControls`): cut it first if the column must hold.
 *
 * @param text - one line.
 * @param width - the column's width, read as {@link cutToWidth} reads it.
 * @example
 * ```ts
 * padEnd("中", 4); // "中  "
 * ```
 */
export function padEnd(text: string, width: number): string {
  const line = withoutControls(text);
  return `${line}${spaces(width, line)}`;
}

/**
 * `text` with spaces before it up to `width` columns, for a right-aligned column (durations,
 * counts). Text already as wide or wider is returned as is (after `withoutControls`).
 *
 * @param text - one line.
 * @param width - the column's width, read as {@link cutToWidth} reads it.
 * @example
 * ```ts
 * padStart("8.1s", 6); // "  8.1s"
 * ```
 */
export function padStart(text: string, width: number): string {
  const line = withoutControls(text);
  return `${spaces(width, line)}${line}`;
}

/** What {@link rule} draws. */
export interface RuleOptions {
  /** The most columns, read as {@link cutToWidth} reads a width. */
  readonly width: number;
  /** The rule's glyph: the palette's `symbol("heavyRule")` or `symbol("rule")`; measured here. */
  readonly line: string;
  /** Words inside the rule, after two glyphs; never cut. `""` is no title. */
  readonly title?: string;
}

/**
 * A horizontal rule: `line` repeated to at most `width` columns (short by less than one glyph when
 * the glyph's width does not divide it; no trailing spaces). With a title, `━━ title ━━━…`: two
 * glyphs, the title, then glyphs to fill. The title is never cut — a rule can be a permanent header
 * line, which keeps every word — so a title too wide gets no fill and the line runs past `width`.
 *
 * @param options - the width, the glyph and the title.
 * @returns the rule; just the title (or `""`) for an empty or zero-width glyph.
 * @example
 * ```ts
 * rule({ width: 10, line: "=" }); // "=========="
 * rule({ width: 16, line: "=", title: "BackWPup" }); // "== BackWPup ===="
 * ```
 */
export function rule(options: RuleOptions): string {
  const line = withoutControls(options.line);
  const title = withoutControls(options.title ?? "");
  const glyph = displayWidth(line);
  if (glyph === 0) return title;
  const limit = columns(options.width);
  const repeat = (room: number): string =>
    line.repeat(Math.floor(Math.max(0, room) / glyph));
  if (title === "") return repeat(limit);
  const head = `${line}${line} ${title}`;
  const fill = repeat(limit - displayWidth(head) - 1);
  return fill === "" ? head : `${head} ${fill}`;
}

/**
 * The safety cap of a permanent line: at most {@link LINE_CAP} code points, ending with `ellipsis`
 * when anything was dropped. Permanent lines are otherwise never cut; this only stops a runaway
 * value (a megabyte error message, a log chunk with no newline) from flooding the terminal. Whole
 * graphemes, counted by their code points; a grapheme too long for any line (a base with hundreds of
 * emoji modifiers) is cut by code point rather than dropped, never inside a surrogate pair. An
 * ellipsis longer than the cap is cut to it, so the result never exceeds it.
 *
 * @param text - one permanent line.
 * @param ellipsis - what marks a cap: the palette's `symbol("ellipsis")`.
 * @returns the line, at most {@link LINE_CAP} code points.
 */
export function capLine(text: string, ellipsis: string): string {
  const line = withoutControls(text);
  if (withinCap(line)) return line;
  const mark = codePoints(withoutControls(ellipsis)).slice(0, LINE_CAP);
  const budget = LINE_CAP - mark.length;
  let kept = "";
  let used = 0;
  for (const { segment } of GRAPHEMES.segment(line)) {
    const points = codePoints(segment);
    if (used + points.length > budget) {
      // A grapheme that fits an empty line ends this one; a longer one fills the room left.
      if (points.length > budget) {
        kept += points.slice(0, budget - used).join("");
      }
      break;
    }
    kept += segment;
    used += points.length;
  }
  return `${kept}${mark.join("")}`;
}

/**
 * The columns a grapheme takes, never fewer than a terminal draws: the larger of `string-width`'s
 * measure of the cluster and the sum of its code points' own. Terminals draw some clusters per code
 * point (Thai KO KAI + SARA AM and Devanagari KSSA take 2; a base then 2 more per emoji modifier)
 * where `string-width` counts the first; others draw a whole emoji sequence in 2.
 * The larger never lets a live row wrap; a sequence counted wider than drawn only pads a column
 * short.
 *
 * @param cluster - one grapheme cluster, with no control character.
 */
function graphemeWidth(cluster: string): number {
  // Printable ASCII, most of any line: one column, no lookup.
  if (cluster.length === 1 && cluster >= " " && cluster <= "~") return 1;
  const whole = stringWidth(cluster, MEASURE);
  const points = codePoints(cluster);
  if (points.length === 1) return whole;
  let sum = 0;
  for (const point of points) sum += stringWidth(point, MEASURE);
  return Math.max(whole, sum);
}

/**
 * The grapheme clusters of `line`, each with its width, read lazily so a cut can stop early.
 *
 * @param line - text with no control character.
 */
function* graphemes(line: string): Generator<Grapheme> {
  for (const { segment } of GRAPHEMES.segment(line)) {
    yield { text: segment, width: graphemeWidth(segment) };
  }
}

/**
 * A requested width as whole columns, so no caller can make a padding or a rule build a huge string
 * or throw: a fraction rounded down; negative, `NaN` or infinite 0; at most {@link LINE_CAP}.
 *
 * @param width - a requested width.
 */
function columns(width: number): number {
  if (!Number.isFinite(width) || width < 0) return 0;
  return Math.min(LINE_CAP, Math.floor(width));
}

/**
 * The spaces that pad `line` to `width` columns; none when it is as wide or wider.
 *
 * @param width - the requested width, read by {@link columns}.
 * @param line - text with no control character.
 */
function spaces(width: number, line: string): string {
  return " ".repeat(Math.max(0, columns(width) - displayWidth(line)));
}

/**
 * Whether `line` holds at most {@link LINE_CAP} code points, without listing a huge line's: a code
 * point takes at most two code units, so twice the cap in units is already over it.
 *
 * @param line - well-formed text.
 */
function withinCap(line: string): boolean {
  return line.length <= 2 * LINE_CAP && codePoints(line).length <= LINE_CAP;
}

/**
 * `text`'s code points, a surrogate pair as one.
 *
 * @param text - well-formed text.
 */
function codePoints(text: string): string[] {
  return Array.from(text);
}

/**
 * `value` when it is a finite integer above 0.
 *
 * @param value - a stream's `columns`.
 */
function positiveInteger(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

/**
 * `COLUMNS` as a width: digits only (no sign, space or fraction), above 0.
 *
 * @param value - the variable's value.
 */
function parseColumns(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  return positiveInteger(Number(value));
}
