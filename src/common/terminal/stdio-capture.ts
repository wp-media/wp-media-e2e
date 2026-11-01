import { StringDecoder } from "node:string_decoder";

import {
  UNDERLYING_STREAM,
  type Terminal,
  type TerminalStream,
} from "./stream";

/**
 * While a live block is on screen, every other writer of the process's own terminal — a library's
 * warning, `process.emitWarning`, another reporter's `console.*` — would write over the block or be
 * erased by its next clear. {@link captureStdio} replaces the `write` of the streams it is given
 * (`process.stdout`, `process.stderr`) with one that cuts what they are handed into lines and prints
 * each whole line through the block's owner, above the block; {@link StdioCapture.restore} puts the
 * streams back as they were. Nothing here runs at import.
 *
 * - Lines: what is printed is what a UTF-8 terminal would show of the bytes the stream would have
 *   written — text turned into bytes in its given encoding (`latin1` `é` is the byte `E9`, shown as
 *   `\uFFFD`; `hex` and `base64` text are the bytes they spell), any byte view as its bytes — then
 *   decoded as UTF-8 (a character split over two writes is joined), cut at `\n`, a
 *   `\r` before it dropped. A partial line is held until its line end; past
 *   {@link MAX_PENDING_CHARS} it is printed as a line of its own, so a writer that never ends a line
 *   cannot grow memory. What a stream still holds when the capture ends is written to that stream
 *   as it was, unprinted.
 * - Calls keep their meaning: `write(chunk[, encoding][, callback])` returns `true` (nothing queued
 *   for the caller to wait on) and calls `callback` on a later turn with no error, as a stream that
 *   took the chunk does. Anything a stream's own `write` would refuse (a chunk that is neither text
 *   nor bytes, an unknown encoding) goes to it unchanged, so it refuses it as it would.
 * - No loop: the block's owner writes through a {@link bypassWriter} made before the capture, never
 *   through the replaced `write`; a write made while a line is being printed — the owner's own
 *   warning — goes straight to the stream. When the owner cannot print (its terminal died), the
 *   lines go to the stream they were written to, so a working standard error keeps them.
 * - Restoring puts back exactly what was there: an own `write` property is set back, a `write` that
 *   came from the prototype is deleted again. A stream whose `write` someone replaced after the
 *   capture is left to them; the capture's `write` in their chain then passes everything through.
 */

/** The longest partial line held before it is printed as a line of its own: 64 KiB of text. */
export const MAX_PENDING_CHARS = 64 * 1024;

/** A stream whose `write` a capture replaces: `process.stdout` and `process.stderr` are. */
export interface CapturableStream {
  /** Node's `Writable.write`: `(chunk, encoding?, callback?) => boolean`. */
  write: (...args: never[]) => boolean;
}

/** What {@link captureStdio} needs. */
export interface StdioCaptureOptions {
  /** The streams to capture, each once. */
  readonly streams: readonly CapturableStream[];
  /**
   * Prints whole lines above the block.
   *
   * @returns `false` when it could not: the lines then go to the stream they were written to.
   */
  readonly print: (lines: readonly string[]) => boolean;
  /** Runs a write's callback later; `process.nextTick` by default. */
  readonly defer?: (callback: () => void) => void;
}

/** A capture in force; see this module's description. */
export interface StdioCapture {
  /** Puts every stream back and writes what each still held; idempotent, never throws. */
  restore(): void;
  /** Whether the capture is still in force. */
  readonly active: boolean;
}

/** Node's write callback. */
type WriteCallback = (error?: Error | null) => void;

/**
 * Replaces each stream's `write` until {@link StdioCapture.restore}; all or none.
 *
 * @param options - the streams, where their lines go, and how callbacks are deferred.
 * @returns the capture.
 * @throws whatever a stream threw when its `write` was replaced (a frozen stream), every stream
 *   then put back.
 * @example
 * ```ts
 * const writer = bypassWriter(process.stdout); // before the capture: the region writes through it
 * const capture = captureStdio({
 *   streams: [process.stdout, process.stderr],
 *   print: (lines) => region.print(lines),
 * });
 * console.warn("above the block");
 * capture.restore();
 * ```
 */
export function captureStdio(options: StdioCaptureOptions): StdioCapture {
  const defer =
    options.defer ??
    ((callback: () => void) => {
      process.nextTick(callback);
    });
  const state = { active: true, printing: false };
  const captured: { restore: () => void }[] = [];
  try {
    for (const stream of new Set(options.streams))
      captured.push(capture(stream, options.print, defer, state));
  } catch (error) {
    // All or nothing: a stream that refuses a new `write` puts back the ones already captured.
    state.active = false;
    for (const one of captured) one.restore();
    throw error;
  }
  return {
    restore: () => {
      if (!state.active) return;
      state.active = false;
      for (const one of captured) one.restore();
    },
    get active() {
      return state.active;
    },
  };
}

/** What every stream of one capture shares. */
interface SharedState {
  /** Whether the capture is in force; once `false`, every replaced `write` passes through. */
  active: boolean;
  /** Whether a line is being printed now: a write made meanwhile goes straight to its stream. */
  printing: boolean;
}

/**
 * Captures one stream.
 *
 * @param stream - the stream.
 * @param print - where whole lines go.
 * @param defer - runs a write's callback later.
 * @param state - the capture's shared state.
 * @returns how to put the stream back.
 */
function capture(
  stream: CapturableStream,
  print: StdioCaptureOptions["print"],
  defer: (callback: () => void) => void,
  state: SharedState,
): { restore: () => void } {
  const hadOwn = Object.hasOwn(stream, "write");
  const own: unknown = hadOwn ? stream.write : undefined;
  const original = stream.write as (...args: unknown[]) => boolean;
  const decoder = new StringDecoder("utf8");
  let pending = "";

  /** Writes text to the stream as it was before the capture; a throw is swallowed. */
  const direct = (text: string): void => {
    try {
      Reflect.apply(original, stream, [text]);
    } catch {
      // The stream is gone: there is nowhere left to write.
    }
  };

  /** Prints `lines` through the owner, or to the stream when the owner cannot. */
  const emit = (lines: readonly string[]): void => {
    if (lines.length === 0) return;
    let printed: boolean;
    state.printing = true;
    try {
      printed = print(lines);
    } catch {
      printed = false;
    } finally {
      state.printing = false;
    }
    if (!printed) direct(`${lines.join("\n")}\n`);
  };

  /** The replacement `write`. */
  function write(this: unknown, ...args: unknown[]): boolean {
    if (!state.active || state.printing)
      return Reflect.apply(original, stream, args);
    const [chunk, second, third] = args;
    const encoding = typeof second === "string" ? second : undefined;
    const callback = [second, third].find(
      (arg): arg is WriteCallback => typeof arg === "function",
    );
    const bytes = toBytes(chunk, encoding);
    if (bytes === undefined) return Reflect.apply(original, stream, args);
    const cut = cutLines(pending + decoder.write(bytes));
    pending = cut.rest;
    emit(cut.lines);
    if (callback !== undefined)
      defer(() => {
        callback(null);
      });
    return true;
  }

  stream.write = write;
  return {
    restore: () => {
      if (stream.write === (write as CapturableStream["write"])) {
        if (hadOwn) stream.write = own as CapturableStream["write"];
        else Reflect.deleteProperty(stream, "write");
      }
      const tail = pending + decoder.end();
      pending = "";
      if (tail !== "") direct(tail);
    },
  };
}

/**
 * A chunk as bytes, the way a stream's `write` reads it: text in its encoding (UTF-8 by default) or
 * any byte view (`Buffer`, any typed array, `DataView`), its own bytes only.
 *
 * @param chunk - what `write` was given.
 * @param encoding - the encoding given with text.
 * @returns the bytes, or `undefined` when the stream itself would refuse them.
 */
export function toBytes(chunk: unknown, encoding?: string): Buffer | undefined {
  if (typeof chunk === "string") {
    const name = encoding ?? "utf8";
    return Buffer.isEncoding(name) ? Buffer.from(chunk, name) : undefined;
  }
  if (ArrayBuffer.isView(chunk))
    return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return undefined;
}

/**
 * Text cut into whole lines and what is left of an open one: lines end at `\n`, a `\r` before it
 * dropped; an open line longer than {@link MAX_PENDING_CHARS} is taken whole as a line.
 *
 * @param text - what is held, then what came.
 * @returns the whole lines, and the open line's text.
 * @example
 * ```ts
 * cutLines("a\r\nb\nc"); // { lines: ["a", "b"], rest: "c" }
 * ```
 */
export function cutLines(text: string): {
  readonly lines: string[];
  readonly rest: string;
} {
  const parts = text.split("\n");
  let rest = parts.pop() ?? "";
  const lines = parts.map((line) =>
    line.endsWith("\r") ? line.slice(0, -1) : line,
  );
  if (rest.length > MAX_PENDING_CHARS) {
    lines.push(rest);
    rest = "";
  }
  return { lines, rest };
}

/**
 * A stand-in for `stream` that writes through the `write` it has **now**, before a capture replaces
 * it: what a live region writes the block with, so its own bytes never come back through the capture.
 * Everything else — the queue's length, whether it is destroyed or a terminal, its `error` event, its
 * internal handle — is read from the stream itself, so `openLiveTerminal` and `drainTerminal` treat it
 * as the stream; it names the stream under {@link UNDERLYING_STREAM}, so `openLiveTerminal` listens to
 * the stream once however many stand-ins it opens.
 *
 * @param stream - the stream, e.g. `process.stdout`.
 * @returns the stand-in.
 */
export function bypassWriter(
  stream: Terminal & TerminalStream,
): Terminal & TerminalStream {
  // Read off the stream, not called on it: the method is applied to the stream below.
  const write: unknown = Reflect.get(stream, "write");
  return {
    write: (chunk, callback) =>
      Reflect.apply(write as Terminal["write"], stream, [chunk, callback]),
    get writableLength() {
      return stream.writableLength;
    },
    get destroyed() {
      return stream.destroyed;
    },
    get isTTY() {
      return stream.isTTY;
    },
    get _handle(): unknown {
      const handle: unknown = Reflect.get(stream, "_handle");
      return handle;
    },
    on: (event, listener): unknown => stream.on(event, listener),
    [UNDERLYING_STREAM]: stream,
  } as Terminal &
    TerminalStream & {
      readonly _handle: unknown;
      readonly [UNDERLYING_STREAM]: unknown;
    };
}
