import type { LiveRow, LiveSegment } from "../../src/common/terminal/live";
import type { Palette } from "../../src/common/terminal/palette";
import type { TableLine } from "./table";

/**
 * The status table's lines as a live region's rows: the text stays the table's, plain; only colour is
 * added, segment by segment, which the region applies after its own cut. The header and the
 * `and N more` line are dim; a task's id takes its task's colour (as its log lines' scope does); a
 * status mark takes its status's colour. Pure.
 */

/** How the rows are coloured. */
export interface RowStyle {
  /** The terminal's palette, colour as its capabilities say. */
  readonly palette: Pick<Palette, "paint" | "series">;
  /** A task's colour: its place in the config's order. */
  readonly taskIndex: (taskId: string) => number | undefined;
}

/**
 * Every line as a row.
 *
 * @param lines - the table's lines (`renderTableLines`).
 * @param style - the palette and the tasks' colours.
 * @returns one row per line.
 */
export function tableRows(
  lines: readonly TableLine[],
  style: RowStyle,
): LiveRow[] {
  return lines.map((line) => tableRow(line, style));
}

/**
 * One line as a row: segments whose texts, joined, are the line's text.
 *
 * @param line - the line.
 * @param style - the palette and the tasks' colours.
 * @returns the row.
 */
export function tableRow(line: TableLine, style: RowStyle): LiveRow {
  const { palette } = style;
  if (line.kind !== "task")
    return [{ text: line.text, style: (text) => palette.paint("dim", text) }];
  const segments: LiveSegment[] = [];
  let rest = line.text;
  const index =
    line.taskId === undefined ? undefined : style.taskIndex(line.taskId);
  if (
    line.taskId !== undefined &&
    line.taskId !== "" &&
    index !== undefined &&
    rest.startsWith(line.taskId)
  ) {
    segments.push({
      text: line.taskId,
      style: (text) => palette.series(index, text),
    });
    rest = rest.slice(line.taskId.length);
  }
  const { mark } = line;
  const at = mark === undefined ? -1 : rest.indexOf(mark.label);
  if (mark !== undefined && at >= 0 && mark.label.startsWith(mark.symbol)) {
    segments.push({ text: rest.slice(0, at) });
    segments.push({
      text: mark.symbol,
      style: (text) => palette.paint(mark.token, text),
    });
    rest = rest.slice(at + mark.symbol.length);
  }
  segments.push({ text: rest });
  return segments.filter((segment) => segment.text !== "");
}
