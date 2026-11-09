import { constants } from "node:fs";
import { open, writeFile, type FileHandle } from "node:fs/promises";

import { isObject } from "../guards";
import {
  AllureGenerationAbortedError,
  AllureReportError,
} from "./allure-errors";
import { errnoCode } from "./report-tree";

/**
 * A cell's Allure history: one trend point per run, the newest {@link HISTORY_LIMIT} runs.
 * `allure generate` appends one JSON line per generation to `allure-history.jsonl`, stamped with its
 * time, so generating a run's report again (a rebuilt bundle, a later `report:allure`, a retry after
 * a stop) would add a second point for that run. Here the line Allure appended is tagged with the
 * run's folder name and, when the history already holds that run's line, put in its place with its
 * time: one point per run, in the order the runs were first reported. Allure is given only the lines
 * before the run's own, so a report generated again draws the trend it drew the first time. The tag
 * is the key, never the report's name: the orchestrator's runs are named by their task, so two runs
 * can share one.
 *
 * Allure (3.18) reads each line with `JSON.parse` and fails the whole generation on one it cannot
 * parse, so a line it cannot read (not a JSON object, or holding a lone CR, where its line reader
 * splits) is dropped and counted; a blank one is dropped silently; an unterminated last line is
 * terminated. Every kept line is written back byte for byte (read and written as `latin1`), Allure's
 * own with the tag spliced into its text. The file is streamed a chunk at a time, never read whole,
 * and cut to {@link HISTORY_BOUNDS}: any file is read, so one an outside edit broke is replaced by
 * the next generation instead of failing every later one. Something else at its path (a FIFO, a
 * device) is not read, which could block past a stop: it is one dropped line, replaced the same way.
 */

/** The key a history line carries its run's folder name in. */
export const HISTORY_RUN_KEY = "e2eRun";

/** The runs a cell's history keeps, the newest: ≈ 110–180 KB a line, so under ~20 MB. */
export const HISTORY_LIMIT = 100;

/**
 * The longest line Allure may append; a longer one is dropped (counted): a run's line is ~50×
 * smaller, and bounding it bounds every string the history makes.
 */
export const MAX_HISTORY_LINE_BYTES = 8 * 1024 * 1024;

/**
 * What a line read may hold past {@link HistoryBounds.maxLineBytes}: the tag and earlier time spliced
 * into Allure's line, so a line kept is read again by the next generation. A tagged line longer still
 * (only an outside edit's run name or time could make one) is dropped when written, counted.
 */
export const HISTORY_TAG_BYTES = 1024;

/**
 * The most the history holds, in bytes: when the newest lines exceed it the oldest of them are
 * dropped (counted), so memory stays bounded and no text built from it nears V8's string limit
 * (~512 Mi characters).
 */
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

/** What a history is cut to; tests pass small ones. */
export interface HistoryBounds {
  /** The lines kept, the newest. */
  readonly limit: number;
  /**
   * The bytes the lines read and Allure's may hold, line ends included: the lines read keep
   * {@link HistoryBounds.maxLineBytes} free for Allure's (its tag may add
   * {@link HISTORY_TAG_BYTES}). Must exceed that.
   */
  readonly maxBytes: number;
  /**
   * The longest line Allure may append, its line end excluded; a line read may be
   * {@link HISTORY_TAG_BYTES} longer (its tag). Longer ones are dropped unread, counted.
   */
  readonly maxLineBytes: number;
}

/** The bounds a cell's history is kept within. */
export const HISTORY_BOUNDS: HistoryBounds = {
  limit: HISTORY_LIMIT,
  maxBytes: MAX_HISTORY_BYTES,
  maxLineBytes: MAX_HISTORY_LINE_BYTES,
};

/** A history line Allure can read. */
export interface HistoryLine {
  /** The line as `latin1` text (every byte one character), without its `\n`. */
  readonly text: string;
  /** The run its {@link HISTORY_RUN_KEY} names, as the same `latin1` text; `undefined` untagged. */
  readonly run: string | undefined;
}

/** A cell's history, read for one run's generation ({@link scanHistory}). */
export interface HistoryScan {
  /** The newest readable lines, within the bounds, in file order; the run's own counted once. */
  readonly lines: readonly HistoryLine[];
  /**
   * Where the run's own line is: its index in {@link HistoryScan.lines}; `"absent"` when the
   * history has none; `"older"` when it has one older than every kept line.
   */
  readonly own: number | "absent" | "older";
  /**
   * What Allure is given: the readable lines before the run's own first line (every kept line when
   * it has none), the newest of them within the bounds.
   */
  readonly given: readonly HistoryLine[];
  /**
   * Non-blank lines dropped: Allure could not read them, they were too long, or the newest lines
   * held more than the history's bytes (the oldest of them go). Older lines past the line limit are
   * not counted: keeping only the newest runs is the design.
   */
  readonly dropped: number;
}

/** How a history file is read: its bounds (default {@link HISTORY_BOUNDS}) and a stop. */
export interface HistoryReadOptions extends Partial<HistoryBounds> {
  /**
   * Checked before the file is opened, as each chunk arrives and once it is read: once aborted, the
   * read stops. Only a regular file is read, so a chunk always comes promptly.
   */
  readonly signal?: AbortSignal | undefined;
}

/** JSON whitespace, then the `{` an object starts with. */
const OBJECT_START = /^[ \t\n\r]*\{/;

/**
 * A line as Allure reads it, or `undefined` when it cannot: Allure splits lines at a lone CR too
 * (one ending a CRLF line is fine) and fails on anything but JSON (it then reads an object).
 *
 * @param text - the line, `latin1`, without its `\n`.
 * @returns the line; `undefined` when it is blank or Allure could not read it.
 */
export function readableLine(text: string): HistoryLine | undefined {
  const body = withoutClosingCr(text);
  // Cheap refusals first: a file of short junk lines would otherwise cost a thrown parse each.
  if (!OBJECT_START.test(body) || body.includes("\r")) return undefined;
  const entry = parseObject(body);
  if (entry === undefined) return undefined;
  const run = entry[HISTORY_RUN_KEY];
  return { text, run: typeof run === "string" ? run : undefined };
}

/**
 * A JSON object, from text.
 *
 * @param text - the text.
 * @returns the object; `undefined` when the text is not one.
 */
function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Bounds with every one set.
 *
 * @param bounds - the bounds given; a missing one is {@link HISTORY_BOUNDS}'.
 */
function boundsOf(bounds: Partial<HistoryBounds>): HistoryBounds {
  return {
    limit: bounds.limit ?? HISTORY_BOUNDS.limit,
    maxBytes: bounds.maxBytes ?? HISTORY_BOUNDS.maxBytes,
    maxLineBytes: bounds.maxLineBytes ?? HISTORY_BOUNDS.maxLineBytes,
  };
}

/**
 * Reads a history for one run's generation a line at a time, keeping only what is needed: the
 * newest readable lines within the bounds (any later line of the run itself folded into its first)
 * and the lines Allure is given. The lines kept leave {@link HistoryBounds.maxLineBytes} of
 * {@link HistoryBounds.maxBytes} free, for the line Allure appends.
 */
export class HistoryScanner {
  private readonly bounds: HistoryBounds;
  private readonly kept: HistoryLine[] = [];
  private keptBytes = 0;
  private given: HistoryLine[] | undefined;
  private seen = 0;
  private ownAt: number | undefined;
  private dropped = 0;

  /**
   * @param run - the run's folder name, as `latin1` text ({@link latin1}).
   * @param bounds - what the history is cut to; default {@link HISTORY_BOUNDS}.
   */
  constructor(
    private readonly run: string,
    bounds: Partial<HistoryBounds> = {},
  ) {
    this.bounds = boundsOf(bounds);
  }

  /**
   * Reads the next line.
   *
   * @param text - the line, `latin1`, without its `\n`; `null` for one too long to read.
   */
  add(text: string | null): void {
    const line = text === null ? undefined : readableLine(text);
    if (line === undefined) {
      // A blank line loses nothing; one too long to read (`null`) does.
      if (text?.trim() !== "") this.dropped += 1;
      return;
    }
    if (line.run === this.run) {
      // An older build's duplicate of the run's line: the first one is the run's place.
      if (this.ownAt !== undefined) return;
      this.ownAt = this.seen;
      this.given = this.kept.slice();
    }
    this.kept.push(line);
    this.keptBytes += lineBytes(line);
    this.seen += 1;
    if (this.kept.length > this.bounds.limit) this.removeOldest();
    const room = this.bounds.maxBytes - this.bounds.maxLineBytes;
    // Never past the newest line: bounds whose room holds none still end.
    while (this.keptBytes > room && this.kept.length > 1) {
      this.removeOldest();
      this.dropped += 1;
    }
  }

  /** What was read: the lines so far. */
  result(): HistoryScan {
    return {
      lines: this.kept.slice(),
      own: ownPlace(this.ownAt, this.seen - this.kept.length),
      given: this.given ?? this.kept.slice(),
      dropped: this.dropped,
    };
  }

  /** Lets the oldest kept line go. */
  private removeOldest(): void {
    const oldest = this.kept.shift();
    if (oldest !== undefined) this.keptBytes -= lineBytes(oldest);
  }
}

/**
 * The bytes a line takes in the file.
 *
 * @param line - the line.
 * @returns its bytes and its `\n`.
 */
function lineBytes(line: HistoryLine): number {
  return line.text.length + 1;
}

/**
 * Reads a history's lines for `run`'s generation ({@link HistoryScanner}).
 *
 * @param lines - the lines, `latin1`, without their `\n`; `null` for one too long to read.
 * @param run - the run's folder name, as `latin1` text ({@link latin1}).
 * @param bounds - what the history is cut to; default {@link HISTORY_BOUNDS}.
 * @returns what was read.
 */
export function scanHistory(
  lines: Iterable<string | null>,
  run: string,
  bounds: Partial<HistoryBounds> = {},
): HistoryScan {
  const scanner = new HistoryScanner(run, bounds);
  for (const text of lines) scanner.add(text);
  return scanner.result();
}

/**
 * Reads a history file for `run`'s generation, a chunk at a time ({@link historyFileLines}); a line
 * may be {@link HISTORY_TAG_BYTES} longer than {@link HistoryBounds.maxLineBytes}.
 *
 * @param path - the file; a missing one is empty.
 * @param run - the run's folder name, as `latin1` text ({@link latin1}).
 * @param options - the bounds and a stop.
 * @returns what was read.
 * @throws {@link AllureGenerationAbortedError} once `options.signal` is aborted; the filesystem's
 *   error when the file cannot be read.
 */
export async function scanHistoryFile(
  path: string,
  run: string,
  options: HistoryReadOptions = {},
): Promise<HistoryScan> {
  const scanner = new HistoryScanner(run, options);
  const { maxLineBytes } = boundsOf(options);
  throwIfAborted(options.signal);
  for await (const lines of historyFileLines(
    path,
    maxLineBytes + HISTORY_TAG_BYTES,
  )) {
    // Leaving the loop closes the file.
    throwIfAborted(options.signal);
    for (const text of lines) scanner.add(text);
  }
  // A stop during the last chunk's read: no chunk follows to notice it.
  throwIfAborted(options.signal);
  return scanner.result();
}

/**
 * Throws once the caller stopped.
 *
 * @param signal - the caller's abort signal.
 * @throws {@link AllureGenerationAbortedError} when it is aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AllureGenerationAbortedError();
}

/**
 * Where the run's own line ended up among the kept lines.
 *
 * @param ownAt - its position among every readable line kept at some point; `undefined` when
 *   there was none.
 * @param firstKept - the position of the first line kept.
 */
function ownPlace(
  ownAt: number | undefined,
  firstKept: number,
): HistoryScan["own"] {
  if (ownAt === undefined) return "absent";
  return ownAt < firstKept ? "older" : ownAt - firstKept;
}

/**
 * The history once Allure appended the run's line to {@link HistoryScan.given}: that line, tagged
 * with the run, replaces the run's earlier one in its place and keeps its time, or is appended when
 * the run had none (left out when the run's line is older than every kept one). When Allure did
 * something else, nothing of the cell's history is lost: lines it appended to what it was given are
 * appended as they are, readable ones only; otherwise the history is what was read.
 *
 * @param scan - the history read ({@link scanHistory}).
 * @param run - the run's folder name, as `latin1` text.
 * @param appended - what Allure added after what it was given; `undefined` when it did not keep
 *   what it was given.
 * @param limit - the lines kept; default {@link HISTORY_LIMIT}.
 * @returns the history's lines, `latin1`, without their `\n`, the newest at most `limit`.
 * @example
 * ```ts
 * const scan = scanHistory(['{"n":"a","timestamp":1,"e2eRun":"r1"}'], "r1");
 * historyAfterAllure(scan, "r1", '{"n":"b","timestamp":9}\n');
 * // ['{"n":"b","timestamp":1,"e2eRun":"r1"}']
 * ```
 */
export function historyAfterAllure(
  scan: HistoryScan,
  run: string,
  appended: string | undefined,
  limit: number = HISTORY_LIMIT,
): readonly string[] {
  const lines = scan.lines.map((line) => line.text);
  const added = appendedLines(appended);
  const own =
    added.length === 1 &&
    added[0] !== undefined &&
    readableLine(added[0]) !== undefined
      ? added[0]
      : undefined;
  if (own === undefined) {
    // Not the one line expected: whatever Allure could read of it goes after the cell's history.
    lines.push(...added.filter((text) => readableLine(text) !== undefined));
  } else if (typeof scan.own === "number") {
    const earlier = scan.lines[scan.own];
    lines[scan.own] = taggedLine(
      own,
      run,
      earlier === undefined ? undefined : timestampText(earlier.text),
    );
  } else if (scan.own === "absent") {
    lines.push(taggedLine(own, run, undefined));
  }
  return lines.slice(-limit);
}

/**
 * The lines Allure appended.
 *
 * @param appended - what it appended; `undefined` for nothing usable.
 * @returns its lines, without their `\n` (an unterminated last one included).
 */
function appendedLines(appended: string | undefined): string[] {
  if (appended === undefined || appended === "") return [];
  const lines = appended.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

/**
 * Allure's line tagged with the run, carrying the run's first time when it had one. The tag and
 * time are spliced into Allure's text, each replacing its member's value or added before the closing
 * brace: every other byte stays as Allure wrote it (re-serialising would turn an escape such as
 * `☃` into a character the `latin1` write cannot hold), and no key is repeated.
 *
 * @param text - the line Allure appended, one {@link readableLine} accepts; a closing CR is dropped.
 * @param run - the run's folder name, as `latin1` text.
 * @param timestamp - the run's earlier line's time as its JSON text ({@link timestampText}), spliced
 *   as it is (a number round trip would turn `1e400` into `null`); `undefined` to keep Allure's.
 * @returns the line, as `latin1` text.
 * @example
 * ```ts
 * taggedLine('{"n":"b","timestamp":9}', "r1", "1"); // '{"n":"b","timestamp":1,"e2eRun":"r1"}'
 * ```
 */
export function taggedLine(
  text: string,
  run: string,
  timestamp: string | undefined,
): string {
  const body = withoutClosingCr(text);
  const values = new Map([[HISTORY_RUN_KEY, JSON.stringify(run)]]);
  if (timestamp !== undefined) values.set("timestamp", timestamp);
  const { members, close } = objectMembers(body);
  const added = [...values]
    .filter(([key]) => !members.some((member) => member.key === key))
    .map(([key, value]) => `${JSON.stringify(key)}:${value}`);
  let out =
    added.length === 0
      ? body
      : body.slice(0, close) +
        (members.length === 0 ? "" : ",") +
        added.join(",") +
        body.slice(close);
  // From the last: an earlier member's place is unchanged by a later one's new value.
  for (const member of members.toReversed()) {
    const value = values.get(member.key);
    if (value !== undefined) {
      out = out.slice(0, member.start) + value + out.slice(member.end);
    }
  }
  return out;
}

/**
 * A history line's `timestamp` as its JSON text, the member `JSON.parse` keeps (the last).
 *
 * @param text - a line {@link readableLine} accepts, a closing CR included.
 * @returns the value's text when it is a number; `undefined` when there is none or it is not one.
 * @example
 * ```ts
 * timestampText('{"timestamp":1e400}'); // "1e400"
 * ```
 */
export function timestampText(text: string): string | undefined {
  // A closing CR is JSON whitespace after the object: objectMembers stops at its `}`.
  const last = objectMembers(text).members.findLast(
    (member) => member.key === "timestamp",
  );
  const value = last === undefined ? "" : text.slice(last.start, last.end);
  // Valid JSON: a value starting with `-` or a digit is a number.
  return /^-?\d/.test(value) ? value : undefined;
}

/**
 * A line without the CR that ends a CRLF line.
 *
 * @param text - the line, without its `\n`.
 */
function withoutClosingCr(text: string): string {
  return text.endsWith("\r") ? text.slice(0, -1) : text;
}

/** A top-level member of a JSON object's text: its key, and where its value's text is. */
export interface ObjectMember {
  /** The key, unescaped. */
  readonly key: string;
  /** Where its value starts. */
  readonly start: number;
  /** Where its value ends (exclusive). */
  readonly end: number;
}

/**
 * The top-level members of a JSON object's text, and where the object closes.
 *
 * @param text - JSON text holding an object (`JSON.parse` accepts it); anything else is unspecified.
 * @returns its members in order, and the index of its closing `}`.
 * @throws {@link RangeError} when no object closes in the text.
 */
export function objectMembers(text: string): {
  readonly members: readonly ObjectMember[];
  readonly close: number;
} {
  const members: ObjectMember[] = [];
  let depth = 0;
  let key: string | undefined;
  let valueAt = -1;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === '"') {
      const end = stringEnd(text, at);
      // A string at the top level before its `:` is a key.
      if (depth === 1 && valueAt === -1) {
        key = JSON.parse(text.slice(at, end + 1)) as string;
      }
      at = end;
    } else if (depth === 1 && char === ":") {
      valueAt = at + 1;
    } else if (depth === 1 && (char === "," || char === "}")) {
      // Only `{}` has no key here: in valid JSON every member names a new one.
      if (key !== undefined) members.push(member(text, key, valueAt, at));
      valueAt = -1;
      if (char === "}") return { members, close: at };
    } else if (char === "{" || char === "[") {
      depth += 1;
    } else if (char === "}" || char === "]") {
      depth -= 1;
    }
  }
  throw new RangeError("Not a JSON object.");
}

/**
 * Where a JSON string ends.
 *
 * @param text - JSON text.
 * @param start - the index of the string's opening quote.
 * @returns the index of its closing quote.
 */
function stringEnd(text: string, start: number): number {
  let at = start + 1;
  while (at < text.length && text[at] !== '"') at += text[at] === "\\" ? 2 : 1;
  return at;
}

/**
 * A member, its value's text without the whitespace around it.
 *
 * @param text - the object's text.
 * @param key - the member's key.
 * @param from - where the text after its `:` starts.
 * @param to - where the `,` or `}` after its value is.
 */
function member(
  text: string,
  key: string,
  from: number,
  to: number,
): ObjectMember {
  let start = from;
  let end = to;
  while (isJsonSpace(text[start])) start += 1;
  while (isJsonSpace(text[end - 1])) end -= 1;
  return { key, start, end };
}

/**
 * Whether a character is JSON whitespace.
 *
 * @param char - the character; `undefined` past the text.
 */
function isJsonSpace(char: string | undefined): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/**
 * Lines as the history file's text.
 *
 * @param lines - the lines, `latin1`, without their `\n`.
 * @returns each line terminated by `\n`.
 */
export function historyText(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * Streams a history file's lines, one chunk's complete lines at a time (split synchronously: a file
 * of millions of short lines reads at memory speed), never holding more than one chunk and one line.
 * Empty lines are skipped. A chunk completing no line yields an empty array: a reader still gets a
 * turn per chunk. Only a regular file is read: anything else but a folder (a FIFO, a device, whose
 * reads may wait for a writer forever) is one line too long, `null`, and is opened without waiting.
 *
 * @param path - the file; a missing one has no lines.
 * @param maxLineBytes - a longer line is yielded as `null`, unread; default
 *   {@link MAX_HISTORY_LINE_BYTES}.
 * @returns each chunk's non-empty lines, `latin1`, without their `\n` (an unterminated last one
 *   included).
 * @throws the filesystem's error for anything but a missing file.
 */
export async function* historyFileLines(
  path: string,
  maxLineBytes: number = MAX_HISTORY_LINE_BYTES,
): AsyncGenerator<(string | null)[]> {
  let handle: FileHandle;
  try {
    // Non-blocking: a FIFO's open would otherwise wait for a writer. A regular file's reads ignore it.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  if (!(await readable(handle))) {
    yield [null];
    return;
  }
  const line = new LineBuffer(maxLineBytes);
  // The stream closes the handle when it ends, fails or is left early.
  for await (const chunk of handle.createReadStream() as AsyncIterable<Buffer>) {
    yield chunkLines(chunk, line);
  }
  if (!line.empty) yield [line.take()];
}

/**
 * Whether an open history is read: a regular file, or a folder (its read fails at once, as an error).
 * The handle is closed when it is not.
 *
 * @param handle - the history, just opened.
 * @returns `false` for anything else, whose reads could block.
 * @throws the filesystem's error when it cannot be inspected (the handle then closed).
 */
async function readable(handle: FileHandle): Promise<boolean> {
  try {
    const stats = await handle.stat();
    if (stats.isFile() || stats.isDirectory()) return true;
  } catch (error) {
    await handle.close();
    throw error;
  }
  await handle.close();
  return false;
}

/**
 * Splits a chunk at its line ends.
 *
 * @param chunk - the next bytes of the file.
 * @param line - the line in progress: completed by the chunk's first line, holding its last part.
 * @returns the lines the chunk completes.
 */
function chunkLines(chunk: Buffer, line: LineBuffer): (string | null)[] {
  const lines: (string | null)[] = [];
  let start = 0;
  let end = chunk.indexOf(0x0a);
  while (end !== -1) {
    // An empty line is blank: skipped, as the scan would, it costs nothing (half a run of them).
    if (end > start || !line.empty) lines.push(line.end(chunk, start, end));
    start = end + 1;
    end = chunk.indexOf(0x0a, start);
  }
  line.add(chunk.subarray(start));
  return lines;
}

/** One line's bytes as they arrive, given up once too long. */
class LineBuffer {
  private parts: Buffer[] = [];
  private size = 0;
  private tooLong = false;

  /** @param maxBytes - the longest line kept. */
  constructor(private readonly maxBytes: number) {}

  /** Whether nothing of a line has arrived. */
  get empty(): boolean {
    return this.size === 0 && !this.tooLong;
  }

  /**
   * Adds bytes of the line; once past the limit, the line's bytes are dropped.
   *
   * @param bytes - the next bytes.
   */
  add(bytes: Buffer): void {
    if (this.tooLong || bytes.length === 0) return;
    if (this.size + bytes.length > this.maxBytes) {
      this.tooLong = true;
      this.parts = [];
      return;
    }
    // Copied: nothing assumes the stream leaves a chunk's memory alone once it is passed on.
    this.parts.push(Buffer.from(bytes));
    this.size += bytes.length;
  }

  /**
   * Ends the line with its last bytes, `chunk[start, end)`.
   *
   * @param chunk - the chunk holding them.
   * @param start - where they start.
   * @param end - where the line end is.
   * @returns the line as `latin1` text; `null` when it was too long.
   */
  end(chunk: Buffer, start: number, end: number): string | null {
    if (this.empty) {
      // The whole line is in this chunk: no copy first.
      return end - start > this.maxBytes
        ? null
        : chunk.toString("latin1", start, end);
    }
    this.add(chunk.subarray(start, end));
    return this.take();
  }

  /**
   * Ends the line and starts the next.
   *
   * @returns the line as `latin1` text; `null` when it was too long.
   */
  take(): string | null {
    const text = this.tooLong
      ? null
      : Buffer.concat(this.parts, this.size).toString("latin1");
    this.parts = [];
    this.size = 0;
    this.tooLong = false;
    return text;
  }
}

/**
 * Reads the cell's history for `run`'s generation and writes what Allure is given to its work copy
 * (nothing when that is no line: Allure creates the file).
 *
 * @param historyPath - the cell's history; a missing one is empty.
 * @param workHistory - the copy Allure reads and appends to.
 * @param run - the run's folder name.
 * @param options - the bounds and a stop.
 * @returns the history read: pass it to {@link settleHistory}.
 * @throws {@link AllureGenerationAbortedError} once `options.signal` is aborted;
 *   {@link AllureReportError} when the history cannot be read or the copy written.
 */
export async function prepareHistory(
  historyPath: string,
  workHistory: string,
  run: string,
  options: HistoryReadOptions = {},
): Promise<HistoryScan> {
  const scan = await scanHistoryFile(historyPath, latin1(run), options).catch(
    (error: unknown) => {
      throw historyError(
        `Cannot read the Allure history ${historyPath}`,
        error,
      );
    },
  );
  if (scan.given.length > 0) {
    await writeFile(workHistory, givenText(scan), "latin1").catch(
      (error: unknown) => {
        throw historyError(
          `Cannot write Allure's history ${workHistory}`,
          error,
        );
      },
    );
  }
  return scan;
}

/**
 * Rewrites the work copy Allure appended to as the cell's next history ({@link historyAfterAllure}).
 * Always written, so there is one to put in place. More than one line's worth appended
 * ({@link HistoryBounds.maxLineBytes} and its `\n`) is not Allure's line: not read, counted as one
 * dropped line. A line that would be too long for the next read ({@link HISTORY_TAG_BYTES}) is
 * dropped, counted: nothing written is lost unseen.
 *
 * @param workHistory - the copy Allure read and appended to.
 * @param scan - what {@link prepareHistory} read.
 * @param run - the run's folder name.
 * @param bounds - those {@link prepareHistory} read with; default {@link HISTORY_BOUNDS}.
 * @returns the lines dropped here, to add to {@link HistoryScan.dropped}.
 * @throws {@link AllureReportError} when the copy cannot be read or written.
 */
export async function settleHistory(
  workHistory: string,
  scan: HistoryScan,
  run: string,
  bounds: Partial<HistoryBounds> = {},
): Promise<number> {
  const { limit, maxLineBytes } = boundsOf(bounds);
  try {
    const given = givenText(scan);
    const after = await readHistoryText(
      workHistory,
      given.length + maxLineBytes + 1,
    );
    const appended =
      after?.startsWith(given) === true ? after.slice(given.length) : undefined;
    const lines = historyAfterAllure(scan, latin1(run), appended, limit);
    const kept = lines.filter(
      (line) => line.length <= maxLineBytes + HISTORY_TAG_BYTES,
    );
    await writeFile(workHistory, historyText(kept), "latin1");
    return (after === undefined ? 1 : 0) + lines.length - kept.length;
  } catch (error) {
    throw historyError(`Cannot update Allure's history ${workHistory}`, error);
  }
}

/**
 * A history failure as the report's error, saying what failed and why.
 *
 * @param what - what failed, naming the file.
 * @param error - why; an {@link AllureReportError} is passed on as it is.
 */
function historyError(what: string, error: unknown): AllureReportError {
  if (error instanceof AllureReportError) return error;
  return new AllureReportError(
    `${what} (${errnoCode(error) ?? "unknown error"}).`,
    { cause: error },
  );
}

/**
 * What Allure is given, as the file's text.
 *
 * @param scan - the history read.
 */
function givenText(scan: HistoryScan): string {
  return historyText(scan.given.map((line) => line.text));
}

/**
 * Reads the history Allure left as `latin1` text, unless it is longer than `maxBytes`.
 *
 * @param path - the file.
 * @param maxBytes - the most read.
 * @returns its text; `""` when there is none; `undefined` when it is longer.
 * @throws the filesystem's error for anything but a missing file.
 */
export async function readHistoryText(
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "";
    throw error;
  }
  try {
    // Allure has exited and the work folder is the owner's alone: the size cannot change.
    if ((await handle.stat()).size > maxBytes) return undefined;
    return await handle.readFile("latin1");
  } finally {
    await handle.close();
  }
}

/**
 * A run's name as the `latin1` text the history is read as, so it compares with the file's bytes.
 *
 * @param run - the run's folder name.
 * @returns its UTF-8 bytes, one character each.
 */
export function latin1(run: string): string {
  return Buffer.from(run, "utf8").toString("latin1");
}
