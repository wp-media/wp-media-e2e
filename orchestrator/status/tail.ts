import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { ResultsEvent } from "../../src/common/reporting/results-schema";
import { errorCode } from "../error-code";
import { MAX_RESULTS_BYTES } from "../runs/end";
import { MAX_LINE_LENGTH, resultLines } from "../runs/results";

/**
 * Follows a run's results stream (`results.jsonl`) while the run writes it, for the status table: each
 * poll reads what was appended since the last, through the end-of-run reader's own line rule
 * (`resultLines`: its UTF-16 line cap, then the suite's `parseResults`) and its own decoding
 * (`Buffer`'s UTF-8, a byte order mark kept), so a line counts exactly as `run.finished` counts it.
 * Never its stdout: that is the run's `run.log`.
 *
 * Its core ({@link takeChunk}) is pure: a byte offset, advanced only past whole lines — cut at the
 * last newline before decoding, so a multi-byte character split across two writes is never decoded
 * in halves. A line with no newline within {@link TAIL_WINDOW_BYTES} bytes is skipped unread, through
 * to its newline, so memory stays bounded whatever the runner writes. Its shell ({@link readTail})
 * opens the file afresh at each poll and closes it before returning, so a run that ends, crashes or
 * is pruned never leaves a descriptor behind; it starts over when the file is another (its device,
 * inode or first bytes changed) or shorter, and stops at the end-of-run reader's cap.
 */

/**
 * The most bytes one read takes: the longest line the end-of-run reader keeps — {@link MAX_LINE_LENGTH}
 * UTF-16 units, at most 3 UTF-8 bytes each (a 4-byte character is 2 units) — and its newline. A line
 * with no newline within it is longer than that reader keeps; one within it is kept or dropped by that
 * reader's own rule, once decoded.
 */
export const TAIL_WINDOW_BYTES = 3 * MAX_LINE_LENGTH + 1;

/** The most bytes one poll reads (at least one window): a poll after a long pause catches up over a few. */
export const TAIL_POLL_BYTES = 4 * 1024 * 1024;

/**
 * How many of a stream's first bytes are compared at each poll: the `run.begin` line's start, which
 * names the run and when it began — another file in its place differs there.
 */
export const TAIL_HEAD_BYTES = 256;

/** Which file a tail has read: told apart from another put in its place. */
export interface TailFile {
  readonly dev: number;
  readonly ino: number;
  /** Its first bytes (up to {@link TAIL_HEAD_BYTES}), one character per byte. */
  readonly head: string;
}

/** Where a tail stands in its file. */
export interface TailState {
  /** The byte offset of the first byte not yet consumed. */
  readonly offset: number;
  /** Set while skipping the rest of a line too long to keep, through to its newline. */
  readonly skipping: boolean;
  /** The file read so far; absent before the first read. */
  readonly file?: TailFile;
}

/** A tail at the file's start. */
export const TAIL_START: TailState = { offset: 0, skipping: false };

/** What one chunk gave. */
export interface TakenChunk {
  /** Where the tail now stands. */
  readonly state: TailState;
  /** The events of the whole lines it held, in order. */
  readonly events: readonly ResultsEvent[];
  /** Lines skipped: not events, and lines too long to keep. */
  readonly skipped: number;
}

/** The newline byte. */
const NEWLINE = 0x0a;

/**
 * Decodes UTF-8 as the end-of-run reader does (`Buffer#toString`): an invalid sequence becomes
 * U+FFFD, a byte order mark is kept — never throwing.
 *
 * @param bytes - whole lines.
 * @returns their text.
 */
function decode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length).toString(
    "utf8",
  );
}

/**
 * Consumes a chunk read at `state.offset`: every whole line in it, up to its last newline. What
 * follows that newline is left for the next read — a line still being written. A chunk that fills
 * the window and holds no newline is a line too long to keep: skipped, as it goes on, through to its
 * newline.
 *
 * @param state - where the tail stands; the chunk was read there.
 * @param chunk - the bytes read, at most `windowBytes`.
 * @param windowBytes - the window the chunk was read with; {@link TAIL_WINDOW_BYTES} by default.
 * @returns the new state, the events, and how many lines were skipped.
 * @example
 * ```ts
 * const { state, events } = takeChunk(TAIL_START, Buffer.from('{"v":1,…}\n{"v":1,'));
 * // state.offset is the first line's length: the second waits for its newline.
 * ```
 */
export function takeChunk(
  state: TailState,
  chunk: Uint8Array,
  windowBytes: number = TAIL_WINDOW_BYTES,
): TakenChunk {
  let offset = state.offset;
  let start = 0;
  if (state.skipping) {
    const newline = chunk.indexOf(NEWLINE);
    if (newline === -1)
      return {
        state: { ...state, offset: offset + chunk.length, skipping: true },
        events: [],
        skipped: 0,
      };
    start = newline + 1;
    offset += start;
  }
  const last = chunk.lastIndexOf(NEWLINE);
  if (last < start) {
    // No whole line: a line still being written, or one too long to keep.
    if (start === 0 && chunk.length >= windowBytes)
      return {
        state: { ...state, offset: offset + chunk.length, skipping: true },
        events: [],
        skipped: 1,
      };
    return {
      state: { ...state, offset, skipping: false },
      events: [],
      skipped: 0,
    };
  }
  const { events, skipped } = resultLines(
    decode(chunk.subarray(start, last + 1)),
  );
  return {
    state: { ...state, offset: offset + (last + 1 - start), skipping: false },
    events,
    skipped,
  };
}

/** A file open for reading: `fs.promises.FileHandle`'s shape, as much as a tail uses. */
export interface TailHandle {
  /** Its size, device and inode, and whether it is a regular file. */
  stat(): Promise<{
    readonly size: number;
    readonly dev: number;
    readonly ino: number;
    isFile(): boolean;
  }>;
  /**
   * Reads into `buffer` from `position`.
   *
   * @param buffer - where to.
   * @param offset - from where in `buffer`.
   * @param length - how many bytes at most.
   * @param position - from where in the file.
   */
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesRead: number }>;
  /** Closes it. */
  close(): Promise<void>;
}

/** Opens a file for reading; rejects as `fs.promises.open` does (`ENOENT` for a missing file). */
export type OpenForTail = (path: string) => Promise<TailHandle>;

/**
 * Opens read-only without waiting, so a FIFO in the stream's place cannot hang a poll; a regular file
 * reads the same either way.
 *
 * @param path - the file.
 * @returns its handle.
 */
export const openForTail: OpenForTail = (path) =>
  open(path, constants.O_RDONLY | constants.O_NONBLOCK);

/** What one poll found. */
export interface TailRead {
  /** Where the tail now stands: pass it to the next poll. */
  readonly state: TailState;
  /** The new events, in order. */
  readonly events: readonly ResultsEvent[];
  /** Lines skipped. */
  readonly skipped: number;
  /**
   * `true` when the file is another than the one read so far — shorter than the offset, or its
   * device, inode or first bytes changed (truncated, rewritten, replaced, removed and made again): the
   * tail started over from its start, so whatever was counted from the old content must be forgotten
   * first.
   */
  readonly reset: boolean;
  /**
   * `true` when the file is over `maxBytes`, as the end-of-run reader refuses it: nothing was read,
   * and the state is unchanged.
   */
  readonly tooLarge?: boolean;
  /**
   * Why nothing was read: `missing` (no file yet — the runner has not begun —, or it was removed), or
   * the error's code (`EACCES`, `not a file`). The state is then unchanged.
   */
  readonly miss?: string;
}

/** How a poll reads. */
export interface ReadTailOptions {
  /** Opens the file; {@link openForTail} by default. */
  readonly open?: OpenForTail;
  /** The window; {@link TAIL_WINDOW_BYTES} by default. */
  readonly windowBytes?: number;
  /** The most bytes this poll reads, never under one window; {@link TAIL_POLL_BYTES} by default. */
  readonly pollBytes?: number;
  /** The largest stream read; the end-of-run reader's `MAX_RESULTS_BYTES` by default. */
  readonly maxBytes?: number;
}

/**
 * One poll: opens the stream, starts over if it is another file, reads from the tail's offset to the
 * size it has now (at most `pollBytes`, or one window), consumes it whole line by whole line, and
 * closes it — on every path. Never rejects.
 *
 * @param path - the run's `results.jsonl`.
 * @param state - where the tail stood.
 * @param options - the opener and the bounds.
 * @returns what was read, and where the tail now stands.
 */
export async function readTail(
  path: string,
  state: TailState,
  options: ReadTailOptions = {},
): Promise<TailRead> {
  let handle: TailHandle;
  try {
    handle = await (options.open ?? openForTail)(path);
  } catch (error) {
    const code = errorCode(error);
    return miss(state, code === "ENOENT" ? "missing" : (code ?? "unreadable"));
  }
  try {
    return await readOpen(handle, state, options);
  } catch (error) {
    return miss(state, errorCode(error) ?? "unreadable");
  } finally {
    // Read-only: a failed close loses nothing.
    await handle.close().catch(() => undefined);
  }
}

/**
 * Reads an open stream from the tail's offset.
 *
 * @param handle - the open stream.
 * @param from - where the tail stood.
 * @param options - the bounds.
 * @returns what was read.
 */
async function readOpen(
  handle: TailHandle,
  from: TailState,
  options: ReadTailOptions,
): Promise<TailRead> {
  const stats = await handle.stat();
  if (!stats.isFile()) return miss(from, "not a file");
  const head = await readHead(handle, Math.min(stats.size, TAIL_HEAD_BYTES));
  const file: TailFile = { dev: stats.dev, ino: stats.ino, head };
  const reset = stats.size < from.offset || isAnother(from.file, file);
  if (stats.size > (options.maxBytes ?? MAX_RESULTS_BYTES))
    return {
      state: from,
      events: [],
      skipped: 0,
      reset: false,
      tooLarge: true,
    };
  let state: TailState = { ...(reset ? TAIL_START : from), file };
  const windowBytes = options.windowBytes ?? TAIL_WINDOW_BYTES;
  // At least one window: a smaller budget would never reach a long line's newline.
  const budget =
    state.offset + Math.max(options.pollBytes ?? TAIL_POLL_BYTES, windowBytes);
  const end = Math.min(stats.size, budget);
  const events: ResultsEvent[] = [];
  let skipped = 0;
  const buffer = new Uint8Array(
    Math.min(windowBytes, Math.max(0, end - state.offset)),
  );
  while (state.offset < end) {
    const length = Math.min(windowBytes, end - state.offset);
    const { bytesRead } = await handle.read(buffer, 0, length, state.offset);
    if (bytesRead === 0) break;
    const taken = takeChunk(state, buffer.subarray(0, bytesRead), windowBytes);
    events.push(...taken.events);
    skipped += taken.skipped;
    // A line still being written: the rest waits for the next poll.
    if (taken.state.offset === state.offset) break;
    state = taken.state;
  }
  return { state, events, skipped, reset };
}

/**
 * A file's first bytes, one character per byte.
 *
 * @param handle - the open file.
 * @param length - how many.
 * @returns them; fewer when the file is shorter now.
 */
async function readHead(handle: TailHandle, length: number): Promise<string> {
  const buffer = new Uint8Array(length);
  const { bytesRead } =
    length === 0 ? { bytesRead: 0 } : await handle.read(buffer, 0, length, 0);
  return Buffer.from(buffer.buffer, 0, bytesRead).toString("latin1");
}

/**
 * Whether the file now is another than the one read: another device or inode, or first bytes that
 * do not begin as the old ones did (a file only grows, so its first bytes never change).
 *
 * @param before - the file read so far, if any.
 * @param now - the file now.
 * @returns `true` when it is another.
 */
function isAnother(before: TailFile | undefined, now: TailFile): boolean {
  if (before === undefined) return false;
  if (before.dev !== now.dev || before.ino !== now.ino) return true;
  const shared = Math.min(before.head.length, now.head.length);
  return before.head.slice(0, shared) !== now.head.slice(0, shared);
}

/**
 * A poll that read nothing.
 *
 * @param state - where the tail stands, unchanged.
 * @param why - why.
 * @returns the read.
 */
function miss(state: TailState, why: string): TailRead {
  return { state, events: [], skipped: 0, reset: false, miss: why };
}
