import { displayWidth } from "../src/common/terminal/layout";
import type { Palette } from "../src/common/terminal/palette";
import { clockTime } from "./log";

/**
 * How the orchestrator's log lines look on a terminal: the time dim, the scope in its task's colour,
 * and a line wider than the terminal wrapped at its spaces, each continuation line aligned under the
 * message. A line that opens a block — a run's end, a stop's escalation — is preceded by an empty
 * line. Pure, and only for a terminal: a pipe and `orchestrator.log` get the plain line, whose bytes
 * never change.
 *
 * ```text
 * 10:15:30 orchestrator  stopping: SIGINT — no new run; every run finishes its scenario in
 *                        progress. Ctrl-C again to interrupt them; interrupted anyway after 15 min
 * ```
 */

/** A logged line's parts, already masked, made one line and cut: what the terminal shows of it. */
export interface LoggedLine {
  /** When it was logged. */
  readonly at: Date;
  /** Who speaks: `orchestrator`, `log`, or a task's id. */
  readonly scope: string;
  /** What happened. */
  readonly text: string;
  /** It starts a run's end or a stop's escalation: an empty line comes first. */
  readonly opensBlock?: boolean;
  /** Never wrapped: one line, for the terminal to soft-wrap (a command meant to be copied). */
  readonly verbatim?: boolean;
}

/** How lines are styled for one terminal. */
export interface LineStyle {
  /** Its colours: `dim` for the time, the series for the tasks. */
  readonly palette: Pick<Palette, "paint" | "series">;
  /** Its width in columns, as `terminalWidth` reads it. */
  readonly width: number;
  /**
   * A scope's colour: its task's place in the config's order, or `undefined` for a scope that is no
   * task (`orchestrator`, `log`), shown unstyled.
   */
  readonly scopeIndex: (scope: string) => number | undefined;
}

/**
 * The fewest columns a wrapped message keeps beside its time and scope: narrower, the line is left
 * whole for the terminal to wrap.
 */
export const MIN_MESSAGE_WIDTH = 20;

/**
 * A logged line as the terminal shows it.
 *
 * @param line - its parts, already safe.
 * @param style - the terminal's colours, width and task colours.
 * @returns its lines, without line ends: an empty one first when it opens a block, then the message
 *   — wrapped when wider than the terminal, its continuation lines aligned under the message, unless
 *   it is verbatim.
 * @example
 * ```ts
 * styleLine({ at, scope: "bpng", text: "next run 11:14:41 (cooldown 5m)" }, style);
 * // ["\x1b[2m11:09:42\x1b[22m \x1b[36mbpng\x1b[39m  next run 11:14:41 (cooldown 5m)"]
 * ```
 */
export function styleLine(line: LoggedLine, style: LineStyle): string[] {
  const clock = clockTime(line.at);
  const index = style.scopeIndex(line.scope);
  const scope =
    index === undefined ? line.scope : style.palette.series(index, line.scope);
  const indent = displayWidth(`${clock} ${line.scope}  `);
  const room = style.width - indent;
  const parts =
    line.verbatim === true || room < MIN_MESSAGE_WIDTH
      ? [line.text]
      : wrapWords(line.text, room);
  const lines = parts.map((part, i) =>
    i === 0
      ? `${style.palette.paint("dim", clock)} ${scope}  ${part}`
      : `${" ".repeat(indent)}${part}`,
  );
  return line.opensBlock === true ? ["", ...lines] : lines;
}

/**
 * Text cut into lines at its spaces, each as full as `width` allows. A word wider than `width` is
 * never broken — a path or a command stays whole, for the terminal to wrap — and takes a line of its
 * own. A text that fits is returned as it is; one that does not is cut at its spaces (a logged line
 * has no other whitespace), runs of them and spaces at either end dropped: no line starts or ends
 * with a space, and none is empty.
 *
 * @param text - one line.
 * @param width - the columns each line may take; at least 1.
 * @returns the lines; one, `[""]`, for an empty text.
 * @example
 * ```ts
 * wrapWords("a bb ccc", 4); // ["a bb", "ccc"]
 * ```
 */
export function wrapWords(text: string, width: number): string[] {
  // A line that fits is kept as it is, its spacing included.
  if (displayWidth(text) <= width) return [text];
  const lines: string[] = [];
  const [first = "", ...rest] = text.split(" ").filter((word) => word !== "");
  let current = first;
  for (const word of rest) {
    const joined = `${current} ${word}`;
    if (displayWidth(joined) <= width) current = joined;
    else {
      lines.push(current);
      current = word;
    }
  }
  lines.push(current);
  return lines;
}
