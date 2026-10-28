import { redactSecrets, plain, withoutControls } from "../text";
import type { TerminalCapabilities } from "../terminal/capabilities";
import { capLine, rule } from "../terminal/layout";
import {
  createPalette,
  type Palette,
  type Status,
  type SymbolName,
  type Token,
} from "../terminal/palette";
import { cleanMessage, type TestStatus } from "./results";
import { displayText, formatDuration } from "./run-summary";

/**
 * The terminal reporter's permanent lines, built as plain text and styled last (style is a sink):
 * the run's header, one line per finished test, one per attempt due a retry, worker output, errors
 * raised outside any test. Pure: the capabilities and the facts are parameters.
 *
 * Every external string — a title, an error, a worker's line, a run name — goes through `plain`
 * (escapes stripped, controls a space), then {@link redactSecrets} on the whole line, then the
 * 500-code-point {@link capLine}: masked before any cut, so no cut splits a credential from what
 * marks it. The suite's own lines handed to the sink ({@link suiteLine}) are masked but never cut:
 * they carry paths and commands. A permanent line is never cut to the screen's width.
 */

/** How a line's mark is shown: its glyph, its colour, and whether a coloured terminal drops the word. */
interface MarkStyle {
  readonly symbol: SymbolName;
  readonly token: Token;
  /** `false` when another mark shares the glyph and colour: the word is then always shown. */
  readonly markAlone: boolean;
}

/**
 * What a line says happened: the palette's {@link Status}es (its `error` is an error outside any
 * test here), and beyond them a skip the run itself chose (`skipped`), an attempt the run was
 * interrupted in, an attempt due a retry.
 */
export type Verdict = Status | "skipped" | "interrupted" | "retry";

/** The marks the palette has no {@link Status} for; each word is the verdict's name. */
const EXTRA_MARKS: Readonly<Record<Exclude<Verdict, Status>, MarkStyle>> = {
  // The stop glyph and colour are `stopped`'s (a drained scenario): only the word tells them apart.
  interrupted: { symbol: "stopped", token: "stop", markAlone: false },
  skipped: { symbol: "dash", token: "dim", markAlone: false },
  retry: { symbol: "retry", token: "warn", markAlone: true },
};

/** The indent of a line that belongs to the line it follows or precedes. */
const INDENT = "  ";

/** The most leading spaces a line keeps: an indented block stays readable, a runaway indent does not fill the line. */
export const MAX_INDENT = 12;

/** What a begin line names for output written outside any test. */
export const OUTSIDE_TESTS_TITLE = "outside any test";

/** The most lines of an error raised outside any test that are printed: its head says what it is. */
export const ERROR_LINES = 12;

/** The palette and the one decision it does not expose: whether a mark may stand without its word. */
export interface TerminalStyle {
  readonly palette: Palette;
  /** Whether colour reaches a terminal: only then may a mark stand alone. */
  readonly marksAlone: boolean;
  /** Whether the stream is a terminal with Unicode: the header is then a rule. */
  readonly ruled: boolean;
}

/**
 * The style for a stream with `capabilities`.
 *
 * @param capabilities - what the stream may show.
 */
export function terminalStyle(
  capabilities: Pick<TerminalCapabilities, "tty" | "color" | "unicode">,
): TerminalStyle {
  return {
    palette: createPalette(capabilities),
    marksAlone: capabilities.color && capabilities.tty,
    ruled: capabilities.tty && capabilities.unicode,
  };
}

/**
 * A verdict's mark: the palette's own for a {@link Status}, the same rule for the others — the
 * painted glyph, then the word unless a coloured terminal shows a glyph no other verdict shares.
 *
 * @param style - the stream's style.
 * @param verdict - what happened.
 */
export function mark(style: TerminalStyle, verdict: Verdict): string {
  if (!(verdict in EXTRA_MARKS)) return style.palette.status(verdict as Status);
  const { symbol, token, markAlone } =
    EXTRA_MARKS[verdict as Exclude<Verdict, Status>];
  const glyph = style.palette.paint(token, style.palette.symbol(symbol));
  return style.marksAlone && markAlone ? glyph : `${glyph} ${verdict}`;
}

/**
 * How a finished test is shown, from its final status: a skip the drain made is `stopped`.
 *
 * @param status - its final status.
 * @param drained - whether the drain skipped it.
 */
export function verdictOf(status: TestStatus, drained: boolean): Verdict {
  if (status === "skipped") return drained ? "stopped" : "skipped";
  return status;
}

/**
 * An attempt's duration: tenths of a second under a minute (`18.4s`), else the summary's own
 * format (`14.2m`, `2.3h`). Anything but a finite, positive number is `0.0s`.
 *
 * @param ms - the duration in milliseconds.
 * @example
 * ```ts
 * attemptDuration(18_412); // "18.4s"
 * attemptDuration(852_000); // "14.2m"
 * ```
 */
export function attemptDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0;
  const tenths = (safe / 1000).toFixed(1);
  // 59.96 s rounds to "60.0": the minutes' format says it better.
  return Number(tenths) < 60
    ? `${tenths}s`
    : formatDuration(Math.max(safe, 60_000));
}

/**
 * External text as one permanent line: {@link plain}, masked, capped at 500 code points — its leading
 * spaces kept (at most {@link MAX_INDENT}), so an indented block (a report a setup prints) stays
 * readable; a line with no words is empty.
 *
 * @param text - one line someone else wrote.
 * @param ellipsis - the palette's ellipsis, which marks a capped line.
 */
export function cleanLine(text: string, ellipsis: string): string {
  const line = suiteLine(text);
  return line === "" ? "" : capLine(line, ellipsis);
}

/**
 * One of the suite's own lines (the `[cell]` notice, a reporter's warning) as a permanent line: plain
 * and masked as {@link cleanLine} makes it, never cut — it names paths and commands, which a cut
 * would make wrong. Only for text the suite writes, a line or a few per run.
 *
 * @param text - one line a suite reporter wrote.
 */
export function suiteLine(text: string): string {
  const spaced = withoutControls(text);
  const words = redactSecrets(plain(spaced));
  // A line of nothing but spaces is empty: an indent alone shows nothing.
  if (words === "") return "";
  const indent = /^ */.exec(spaced)?.[0] ?? "";
  return `${indent.slice(0, MAX_INDENT)}${words}`;
}

/**
 * A test's place as one title: the feature, any Rule or Outline between, the scenario — each part
 * plain and masked, empty parts left out, joined by the breadcrumb.
 *
 * @param parts - the place's titles, outermost first.
 * @param style - the stream's style.
 * @example
 * ```ts
 * testTitle(["Backups", "Create a backup"], style); // "Backups › Create a backup"
 * ```
 */
export function testTitle(
  parts: readonly string[],
  style: TerminalStyle,
): string {
  const { palette } = style;
  const title = parts
    .map(displayText)
    .filter((part) => part !== "")
    .join(` ${palette.symbol("breadcrumb")} `);
  return capLine(title, palette.symbol("ellipsis"));
}

/** What a test's line says. */
export interface TestLine {
  readonly verdict: Verdict;
  /** The duration of the attempt the line is about. */
  readonly durationMs: number;
  /** The title, from {@link testTitle}. */
  readonly title: string;
  /** The attempt and how many the test may get; shown when it says something ({@link attemptShown}). */
  readonly attempt?: { readonly number: number; readonly of: number };
  /** Words after the attempt (`failed`, `retry not run`): ours, never external. */
  readonly note?: string;
}

/** Verdicts whose first attempt says all: no retry was needed or will come. */
const SETTLED_FIRST_TIME: ReadonlySet<Verdict> = new Set([
  "passed",
  "skipped",
  "stopped",
]);

/**
 * Whether a line names its attempt: always past the first; on the first, only when more were allowed
 * and the line is about a failure — a retry due, a test that failed or was interrupted before its
 * retries ran.
 *
 * @param verdict - what the line says happened.
 * @param attempt - the attempt and how many the test may get.
 */
export function attemptShown(
  verdict: Verdict,
  attempt: { readonly number: number; readonly of: number },
): boolean {
  if (attempt.number > 1) return true;
  return attempt.of > 1 && !SETTLED_FIRST_TIME.has(verdict);
}

/**
 * One test's line: `✔ 18.4s  Backups › Create a backup`, or with its word and attempt —
 * `✘ failed 8.1s  Backups › Create a backup · attempt 2/2`.
 *
 * @param style - the stream's style.
 * @param line - what the line says.
 */
export function testLine(style: TerminalStyle, line: TestLine): string {
  const { palette } = style;
  const facts: string[] = [];
  const { attempt } = line;
  if (attempt !== undefined && attemptShown(line.verdict, attempt)) {
    facts.push(`attempt ${String(attempt.number)}/${String(attempt.of)}`);
  }
  if (line.note !== undefined) facts.push(line.note);
  const separator = ` ${palette.symbol("separator")} `;
  const suffix =
    facts.length === 0
      ? ""
      : palette.paint("dim", `${separator}${facts.join(separator)}`);
  const duration = palette.paint("dim", attemptDuration(line.durationMs));
  return `${mark(style, line.verdict)} ${duration}  ${line.title}${suffix}`;
}

/**
 * The line that names whose output follows: `▸ artifacts.setup.ts › resolve`, `▸ … · attempt 2/3`
 * past the first attempt, `▸ outside any test` ({@link OUTSIDE_TESTS_TITLE}).
 *
 * @param style - the stream's style.
 * @param title - the test's title, from {@link testTitle}.
 * @param attempt - the attempt and how many the test may get; named past the first.
 */
export function beginLine(
  style: TerminalStyle,
  title: string,
  attempt?: { readonly number: number; readonly of: number },
): string {
  const { palette } = style;
  const suffix =
    attempt === undefined || attempt.number <= 1
      ? ""
      : palette.paint(
          "dim",
          ` ${palette.symbol("separator")} attempt ${String(attempt.number)}/${String(attempt.of)}`,
        );
  return `${palette.paint("id", palette.symbol("current"))} ${title}${suffix}`;
}

/**
 * The first line of an error, indented under the line it explains.
 *
 * @param style - the stream's style.
 * @param message - the error's message, as {@link cleanMessage} gives it.
 * @returns the line, or `undefined` when the message says nothing.
 */
export function errorLine(
  style: TerminalStyle,
  message: string,
): string | undefined {
  const first = firstLine(message);
  if (first === undefined) return undefined;
  return `${INDENT}${cleanLine(first, style.palette.symbol("ellipsis"))}`;
}

/** A line that only labels what follows — `Error:`, `TypeError`, `Call log:` — and says nothing itself. */
const BARE_LABEL = /^(?:[\w$.]*:|[\w$.]*(?:Error|Exception))$/;

/**
 * The first line of `text` that says something, plain: past a bare label (`Error:` alone, its words
 * on the next line), or the first non-empty line when every line is one.
 *
 * @param text - the text.
 */
function firstLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => plain(line))
    .filter((line) => line !== "");
  return lines.find((line) => !BARE_LABEL.test(line)) ?? lines[0];
}

/**
 * A line a worker printed, in the gutter that marks worker output: `  │ [site] …`.
 *
 * @param style - the stream's style.
 * @param text - the line, as the worker wrote it (escapes included).
 */
export function outputLine(style: TerminalStyle, text: string): string {
  const { palette } = style;
  const gutter = `${INDENT}${palette.paint("dim", palette.symbol("vertical"))}`;
  const line = cleanLine(text, palette.symbol("ellipsis"));
  return line === "" ? gutter : `${gutter} ${line}`;
}

/**
 * Says how many lines of a worker's output were not printed, and — for a test's, which the HTML
 * report keeps with the test — where they are; output outside any test is kept nowhere else.
 *
 * @param style - the stream's style.
 * @param dropped - how many.
 * @param keptInReport - whether the report keeps them: a test's output.
 */
export function droppedOutputLine(
  style: TerminalStyle,
  dropped: number,
  keptInReport: boolean,
): string {
  const { palette } = style;
  const lines = `${String(dropped)} more line${dropped === 1 ? "" : "s"}`;
  const where = keptInReport ? ": the HTML report keeps them" : "";
  return outputLine(
    style,
    `${palette.symbol("ellipsis")} ${lines} of output not shown${where}`,
  );
}

/**
 * An error raised outside any test — a spec file that will not load, a global timeout, a worker that
 * crashed: its first line after the mark, then up to {@link ERROR_LINES} more, indented, and how many
 * were left out. No call log (it quotes page markup), credentials masked.
 *
 * @param style - the stream's style.
 * @param message - the raw message.
 * @param verdict - `error`, or `warning` for one that fails nothing ("No tests found").
 */
export function runErrorLines(
  style: TerminalStyle,
  message: string,
  verdict: "error" | "warning" = "error",
): string[] {
  const ellipsis = style.palette.symbol("ellipsis");
  const lines = cleanMessage(message)
    .split("\n")
    .map((line) => cleanLine(line, ellipsis))
    .filter((line) => line.trim() !== "");
  const [first = "an error with no message", ...rest] = lines;
  // A warning is no error: "Error: No tests found" reads as "No tests found".
  const head =
    verdict === "warning" ? first.trim().replace(/^Error: /, "") : first;
  const shown = rest.slice(0, ERROR_LINES);
  const more = rest.length - shown.length;
  return [
    `${mark(style, verdict)} ${head.trim()}`,
    ...shown.map((line) => `${INDENT}${line}`),
    ...(more > 0
      ? [
          `${INDENT}${ellipsis} ${String(more)} more line${more === 1 ? "" : "s"}`,
        ]
      : []),
  ];
}

/** What the run's header says: only what is known as it begins. */
export interface RunHeader {
  readonly product: string;
  /** Absent for a run of every cell. */
  readonly cell?: string;
  readonly edition?: string;
  readonly runId: string;
  /** The ref a person asked for (`E2E_REQUESTED_REF`), when one was given. */
  readonly requestedRef?: string;
  /** The scenarios the run plans; setups are not counted. */
  readonly scenarios: number;
}

/**
 * The run's header: `[run] backwpup · pro@nginx (pro) · <run id> · ref develop · 12 scenarios`, or,
 * on a terminal with Unicode, the same words in a heavy rule as wide as the screen. Never cut.
 *
 * @param style - the stream's style.
 * @param header - what the run is.
 * @param width - the screen's width ({@link terminalWidth}).
 */
export function runHeaderLine(
  style: TerminalStyle,
  header: RunHeader,
  width: number,
): string {
  const { palette } = style;
  const ellipsis = palette.symbol("ellipsis");
  const edition =
    header.edition === undefined ? "" : ` (${displayText(header.edition)})`;
  const subject =
    header.cell === undefined
      ? `${displayText(header.product)} ${palette.symbol("separator")} every cell`
      : `${displayText(header.product)} ${palette.symbol("separator")} ${displayText(header.cell)}${edition}`;
  const ref =
    header.requestedRef === undefined || displayText(header.requestedRef) === ""
      ? []
      : [`ref ${displayText(header.requestedRef)}`];
  const count = `${String(header.scenarios)} scenario${header.scenarios === 1 ? "" : "s"}`;
  const words = capLine(
    [subject, displayText(header.runId), ...ref, count].join(
      ` ${palette.symbol("separator")} `,
    ),
    ellipsis,
  );
  if (!style.ruled) return `[run] ${words}`;
  const ruled = rule({
    width,
    line: palette.symbol("heavyRule"),
    title: words,
  });
  // The words in bold, the glyphs as they are; a function, so a `$` in the words is no pattern.
  return ruled.replace(words, () => palette.paint("command", words));
}
