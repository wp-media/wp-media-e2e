import { cutToWidth, displayWidth } from "../terminal/layout";
import type { LiveRow, LiveSegment } from "../terminal/live";
import type { Palette, Token } from "../terminal/palette";
import type { Counts } from "./results";

/**
 * The live block the terminal reporter keeps at the bottom of a terminal while scenarios run. Pure:
 * every fact — counts, the attempts running, the clock, the width — is a parameter, and the rows are
 * plain text in segments a live region cuts and styles (`terminal/live.ts`).
 *
 * ```text
 * ███████░░░ 23/52 · 44% · 20 passed · 1 flaky · 2 failed · 3 running · 4m 12s
 *   ▸ Backups › Download a backup · bwu4 · 1m 03s
 * ```
 *
 * The first row is the run's progress: a bar (left out when the row would not fit), `done/total`, the
 * percentage (floored: 100 % only once every scenario finished), then the scenarios' counts as the
 * run's summary counts them — `passed` always, `flaky`, `failed`, `interrupted`, `skipped`, `stopped`
 * when not zero — the attempts running now and the time since the run began. A row too wide drops the
 * running count first, then cuts the counts: the time always shows. Then one row per busy worker, in
 * worker order: the scenario, the site it runs on, and the time since its attempt began — the time
 * always whole, then the scenario's own name, then the site, then its feature path: a narrow row drops
 * the feature path before it cuts the site, and cuts the site before the name's first
 * {@link MIN_TITLE_WIDTH} columns. A block taller than the terminal allows keeps the progress row and
 * says how many workers it does not show.
 */

/** A bar's cells. */
export const BAR_CELLS = 10;

/** An attempt running now. */
export interface RunningAttempt {
  /** The worker running it (`parallelIndex`): the rows' order. */
  readonly slot: number;
  /** The scenario's title, plain and masked (`testTitle`): its feature path, then its name. */
  readonly title: string;
  /**
   * The scenario's own name, as {@link RunningAttempt.title} ends with it: what a narrow row keeps
   * when the whole title does not fit. Absent: the title is the name.
   */
  readonly scenario?: string;
  /** The site the worker is bound to, shown as `siteLabel` gives it; absent when unknown. */
  readonly site?: string;
  /** When the attempt began, on the block's clock (ms). */
  readonly startedAt: number;
}

/** What one draw of the block shows. */
export interface LiveBlockInput {
  /** The scenarios' counts so far, as the summary's tally keeps them. */
  readonly counts: Counts;
  /** The attempts running now, any order. */
  readonly running: readonly RunningAttempt[];
  /** When the run began, on the same clock as {@link LiveBlockInput.now}. */
  readonly startedAt: number;
  readonly now: number;
  /** The columns a row may take: the live region's width. */
  readonly width: number;
  /** The most rows the block may take: the terminal's rows less one. */
  readonly maxRows: number;
  readonly palette: Palette;
}

/**
 * The block's rows: the progress row, then one row per running attempt — or, when they do not all
 * fit, as many as fit with a last row saying how many more run.
 *
 * @param input - the facts of this draw.
 * @returns the rows; none when `maxRows` is below 1.
 */
export function liveBlockRows(input: LiveBlockInput): LiveRow[] {
  if (input.maxRows < 1) return [];
  const rows: LiveRow[] = [progressRow(input)];
  const running = [...input.running].sort((a, b) => a.slot - b.slot);
  const room = input.maxRows - 1;
  if (room === 0) return rows;
  // Not all fit: the last row of the room says how many more run.
  const shown = running.length <= room ? running : running.slice(0, room - 1);
  for (const attempt of shown) rows.push(attemptRow(attempt, input));
  const hidden = running.length - shown.length;
  if (hidden > 0) rows.push(moreRow(hidden, input.palette));
  return rows;
}

/**
 * The progress row: the bar, the counts, the running attempts and the time, fitted to the width — the
 * bar left out first (it only repeats the percentage), then the running count; then the counts are
 * cut, so the time always shows.
 *
 * @param input - the facts of this draw.
 */
export function progressRow(input: LiveBlockInput): LiveSegment[] {
  const { counts, palette, width } = input;
  const done = finished(counts);
  const sep = { text: ` ${palette.symbol("separator")} ` };
  const facts: LiveSegment[][] = [
    [{ text: `${String(done)}/${String(counts.total)}` }],
    [{ text: `${String(percent(done, counts.total))}%` }],
    ...countSegments(counts, palette),
  ];
  const running = [
    paint(palette, "id", `${String(input.running.length)} running`),
  ];
  const time = [
    sep,
    paint(
      palette,
      "dim",
      clockDuration(Math.max(0, input.now - input.startedAt)),
    ),
  ];
  const join = (parts: readonly LiveSegment[][]): LiveSegment[] =>
    parts.flatMap((fact, index) => (index === 0 ? fact : [sep, ...fact]));
  const all = [...join([...facts, running]), ...time];
  if (BAR_CELLS + 1 + widthOf(all) <= width)
    return [...progressBar(done, counts.total, palette), { text: " " }, ...all];
  if (widthOf(all) <= width) return all;
  const counted = join(facts);
  return [
    ...cutSegments(counted, width - widthOf(time), palette.symbol("ellipsis")),
    ...time,
  ];
}

/**
 * Segments cut to `width` columns as their joined text would be cut (`cutToWidth`): each keeps its
 * style for the part of it that stays; the ellipsis follows, unstyled.
 *
 * @param segments - plain text in pieces.
 * @param width - the columns they may take.
 * @param ellipsis - what marks the cut.
 */
export function cutSegments(
  segments: readonly LiveSegment[],
  width: number,
  ellipsis: string,
): LiveSegment[] {
  const joined = segments.map((segment) => segment.text).join("");
  const cut = cutToWidth(joined, width, ellipsis);
  if (cut === joined) return [...segments];
  const body = cut.endsWith(ellipsis) ? cut.slice(0, -ellipsis.length) : cut;
  // Plain text is never rewritten by the cut, only shortened; anything else is shown unstyled.
  if (!joined.startsWith(body)) return [{ text: cut }];
  const kept: LiveSegment[] = [];
  let at = 0;
  for (const segment of segments) {
    const piece = body.slice(at, at + segment.text.length);
    at += segment.text.length;
    if (piece === "") break;
    kept.push({ ...segment, text: piece });
  }
  return body === cut ? kept : [...kept, { text: ellipsis }];
}

/**
 * The columns segments take.
 *
 * @param segments - plain text in pieces.
 */
function widthOf(segments: readonly LiveSegment[]): number {
  return displayWidth(segments.map((segment) => segment.text).join(""));
}

/**
 * The scenarios' counts the progress row names: `passed` always, the others when not zero, worst
 * after `passed` — the summary's words (`stopped` for a drained skip).
 *
 * @param counts - the scenarios' counts.
 * @param palette - the stream's palette.
 */
function countSegments(counts: Counts, palette: Palette): LiveSegment[][] {
  const parts: readonly [number, string, Token | undefined, boolean][] = [
    [counts.passed, "passed", "ok", true],
    [counts.flaky, "flaky", "warn", false],
    [counts.failed, "failed", "fail", false],
    [counts.interrupted, "interrupted", "stop", false],
    [counts.skipped - counts.drained, "skipped", "dim", false],
    [counts.drained, "stopped", "stop", false],
  ];
  return parts
    .filter(([count, , , always]) => always || count > 0)
    .map(([count, word, token]) => [
      paint(palette, token, `${String(count)} ${word}`),
    ]);
}

/**
 * How many scenarios finished, whatever their status: those the plan holds less those that never
 * got a final result.
 *
 * @param counts - the scenarios' counts.
 */
export function finished(counts: Counts): number {
  return Math.max(0, counts.total - counts.didNotRun);
}

/**
 * `done` of `total` in whole percent, floored, so 100 % means every scenario finished; 0 when the
 * run plans none.
 *
 * @param done - how many finished.
 * @param total - how many the run plans.
 */
export function percent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((Math.min(done, total) / total) * 100);
}

/**
 * A bar of {@link BAR_CELLS} cells, done cells first (floored, so a full bar means every scenario
 * finished).
 *
 * @param done - how many finished.
 * @param total - how many the run plans.
 * @param palette - the stream's palette: its glyphs (`█░` or `#-`) and colours.
 */
export function progressBar(
  done: number,
  total: number,
  palette: Palette,
): LiveSegment[] {
  const filled =
    total <= 0 ? 0 : Math.floor((Math.min(done, total) / total) * BAR_CELLS);
  const segments: LiveSegment[] = [];
  if (filled > 0)
    segments.push(
      paint(palette, "ok", palette.symbol("barDone").repeat(filled)),
    );
  if (filled < BAR_CELLS)
    segments.push(
      paint(
        palette,
        "dim",
        palette.symbol("barLeft").repeat(BAR_CELLS - filled),
      ),
    );
  return segments;
}

/** The columns a running attempt's title keeps before its site is cut to make room. */
export const MIN_TITLE_WIDTH = 16;

/**
 * One running attempt's row: `  ▸ title · site · 1m 03s`, fitted to `width` — the time always whole;
 * the whole title with the whole site when they fit, else the scenario's own name (no feature path)
 * with the whole site, else the name cut, and once it is down to {@link MIN_TITLE_WIDTH} columns the
 * site cut too, left out when not one column of it fits.
 *
 * @param attempt - the attempt.
 * @param input - the facts of this draw: the clock, the width, the palette.
 */
export function attemptRow(
  attempt: RunningAttempt,
  input: Pick<LiveBlockInput, "now" | "width" | "palette">,
): LiveSegment[] {
  const { palette } = input;
  const ellipsis = palette.symbol("ellipsis");
  const head = `  ${palette.symbol("current")} `;
  const sep = ` ${palette.symbol("separator")} `;
  const elapsed = `${sep}${clockDuration(Math.max(0, input.now - attempt.startedAt))}`;
  const room = Math.max(
    0,
    input.width - displayWidth(head) - displayWidth(elapsed),
  );
  const whole =
    attempt.site === undefined || attempt.site === ""
      ? ""
      : `${sep}${attempt.site}`;
  // The row of a title and a site (with its separator), then the time.
  const row = (title: string, site: string): LiveSegment[] => [
    { text: "  " },
    paint(palette, "id", palette.symbol("current")),
    { text: ` ${title}` },
    paint(palette, "dim", `${site}${elapsed}`),
  ];
  if (displayWidth(attempt.title) + displayWidth(whole) > room) {
    // The feature path goes first; the name and the site are then fitted (both whole when they fit).
    const name = attempt.scenario ?? attempt.title;
    const site = fitSite(attempt.site ?? "", name, room, sep, ellipsis);
    return row(cutToWidth(name, room - displayWidth(site), ellipsis), site);
  }
  return row(attempt.title, whole);
}

/**
 * The site's part of a row (`" · site"`), cut so the title keeps {@link MIN_TITLE_WIDTH} columns (or
 * its whole width, if less) of `room`; `""` when there is no site or not one column of it fits.
 *
 * @param site - the site's label.
 * @param title - the title it shares the room with.
 * @param room - the columns the title and the site share.
 * @param sep - the separator before the site.
 * @param ellipsis - what marks a cut.
 */
function fitSite(
  site: string,
  title: string,
  room: number,
  sep: string,
  ellipsis: string,
): string {
  if (site === "") return "";
  const titleKeeps = Math.min(displayWidth(title), MIN_TITLE_WIDTH);
  const left = room - titleKeeps - displayWidth(sep);
  if (left >= displayWidth(site)) return `${sep}${site}`;
  const cut = cutToWidth(site, left, ellipsis);
  // Nothing but the mark says nothing: the site is left out.
  return cut === "" || cut === ellipsis ? "" : `${sep}${cut}`;
}

/**
 * The row that stands for the running attempts the block has no room for.
 *
 * @param hidden - how many.
 * @param palette - the stream's palette.
 */
function moreRow(hidden: number, palette: Palette): LiveSegment[] {
  return [
    paint(
      palette,
      "dim",
      `  ${palette.symbol("ellipsis")} ${String(hidden)} more running`,
    ),
  ];
}

/**
 * A running time as a clock reads it: `12s`, `4m 12s`, `1h 02m`; seconds floored.
 *
 * @param ms - the time, in milliseconds; anything not finite and positive is `0s`.
 * @example
 * ```ts
 * clockDuration(63_900); // "1m 03s"
 * ```
 */
export function clockDuration(ms: number): string {
  const seconds = Number.isFinite(ms) && ms > 0 ? Math.floor(ms / 1000) : 0;
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60)
    return `${String(minutes)}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(minutes / 60))}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * A segment in a token's style.
 *
 * @param palette - the stream's palette.
 * @param token - the style; none for plain text.
 * @param text - plain text.
 */
function paint(
  palette: Palette,
  token: Token | undefined,
  text: string,
): LiveSegment {
  return token === undefined
    ? { text }
    : { text, style: (cut) => palette.paint(token, cut) };
}
