import { StringDecoder } from "node:string_decoder";

/**
 * What workers print, cut into whole lines per source — the terminal reporter keys one per stream of a
 * test's attempt, or of output outside any test — as the chunks arrive, so each line is printed at
 * once. Pure: no I/O, no timer. It holds only each source's open line and its counts.
 *
 * Bounds: at most {@link OutputLimits.maxLines} lines per source until it is ended (a test's attempt;
 * for output outside any test, the stretch until a test ends), the rest counted; a line is kept whole
 * up to {@link OutputLimits.maxLineLength} UTF-16 units, a memory bound only — the printer masks the
 * whole line, then caps it. A line past it is cut **and loses the word the cut fell in**, then ends in
 * {@link CUT_MARK}: a credential has no whitespace in it, so the half a cut leaves — a URL's password
 * without its `@`, a token's head — is never shown, unmasked, as a word of its own.
 *
 * Chunks arrive as Playwright's `onStdOut`/`onStdErr` hand them: strings, or bytes that may split a
 * UTF-8 character (decoded per source, so a split character is joined, never mangled). A test's chunks
 * all come from its own worker, so its open line waits for the next chunk. Output outside any test
 * names no worker (Playwright gives none), so chunks of two workers may follow each other: appended
 * with `wholeChunks`, each chunk ends its own line and is decoded on its own, never joined to another's.
 * A worker writes a line per call there (`console.*`), so this splits nothing in practice; a credential
 * one write splits outside any test would be masked only where each half keeps its shape.
 */

/** The bounds of one source. */
export interface OutputLimits {
  /** The most lines a source shows until it is ended; later ones are only counted. */
  readonly maxLines: number;
  /** The most UTF-16 units of a line kept in memory: a bound against a line that never ends. */
  readonly maxLineLength: number;
}

/** The bounds the reporter uses: a scenario's worth of warnings, never a flood. */
export const OUTPUT_LIMITS: OutputLimits = {
  maxLines: 200,
  maxLineLength: 64 * 1024,
};

/** What ends a line cut at {@link OutputLimits.maxLineLength}, after the word the cut fell in is dropped. */
export const CUT_MARK = "[cut: the line was too long]";

/** How a source ended: its open line, if it had one, and how many lines it dropped past its bound. */
export interface OutputEnd {
  readonly lines: readonly string[];
  readonly dropped: number;
}

/** One source's state. */
interface Source {
  readonly decoder: StringDecoder;
  /** The line still open: text after the last line end. */
  partial: string;
  /** Whether the open line was cut (its text then ends in {@link CUT_MARK}): the rest of it, up to its end, is dropped. */
  cut: boolean;
  /** Lines accepted since the source began: what the bound counts. */
  accepted: number;
  /** Lines dropped past the bound since the source began. */
  dropped: number;
}

/** Cuts worker output into lines by source; see the module's description. */
export class WorkerOutput {
  /** The sources with something open or counted, by key. */
  private readonly sources = new Map<string, Source>();

  /** @param limits - the bounds of each source. */
  constructor(private readonly limits: OutputLimits = OUTPUT_LIMITS) {}

  /**
   * Adds a chunk to a source.
   *
   * @param key - the source.
   * @param chunk - what the worker wrote.
   * @param wholeChunks - whether the chunk ends its own line: for a source that may mix several
   *   writers' chunks (output outside any test).
   * @returns the lines the chunk completed, within the source's bound: to print now — with
   *   `wholeChunks`, its open line too.
   */
  append(
    key: string,
    chunk: string | Uint8Array,
    wholeChunks = false,
  ): string[] {
    const source = this.source(key);
    let text: string;
    if (typeof chunk === "string") {
      // After bytes: the bytes a character still waits for come first (as U+FFFD), so order is kept.
      text = `${source.decoder.end()}${chunk}`;
    } else if (wholeChunks) {
      // Nothing waits for a later chunk: it may be another writer's.
      text = source.decoder.end(Buffer.from(chunk));
    } else {
      text = source.decoder.write(Buffer.from(chunk));
    }
    const lines = this.add(source, text);
    if (wholeChunks && source.partial !== "") {
      this.accept(source, this.close(source), lines);
    }
    return lines;
  }

  /**
   * Ends a source — a test's attempt, or a stretch of output outside any test — and forgets it: its
   * next output starts a new count.
   *
   * @param key - the source.
   * @returns its open line as a last one, and how many lines it dropped.
   */
  end(key: string): OutputEnd {
    const source = this.sources.get(key);
    if (source === undefined) return { lines: [], dropped: 0 };
    this.sources.delete(key);
    const lines = this.add(source, source.decoder.end());
    if (source.partial !== "") {
      this.accept(source, this.close(source), lines);
    }
    return { lines, dropped: source.dropped };
  }

  /** The sources holding an open line or a count, in the order they first wrote. */
  keys(): string[] {
    return [...this.sources.keys()];
  }

  /**
   * A source's state, created on first use.
   *
   * @param key - the source.
   */
  private source(key: string): Source {
    let source = this.sources.get(key);
    if (source === undefined) {
      source = {
        decoder: new StringDecoder("utf8"),
        partial: "",
        cut: false,
        accepted: 0,
        dropped: 0,
      };
      this.sources.set(key, source);
    }
    return source;
  }

  /**
   * Splits decoded text into lines: each `\n` (a `\r\n` too) ends one; the rest stays open.
   *
   * @param source - the source.
   * @param text - decoded text.
   * @returns the lines it completed, within the bound.
   */
  private add(source: Source, text: string): string[] {
    const lines: string[] = [];
    if (text === "") return lines;
    const pieces = text.split("\n");
    const open = pieces.pop() ?? "";
    for (const piece of pieces) {
      this.extend(source, piece);
      const line = this.close(source);
      this.accept(
        source,
        line.endsWith("\r") ? line.slice(0, -1) : line,
        lines,
      );
    }
    this.extend(source, open);
    return lines;
  }

  /**
   * Adds text to the open line, cutting it once it passes the line bound; a cut line takes nothing
   * more.
   *
   * @param source - the source.
   * @param text - text with no line end.
   */
  private extend(source: Source, text: string): void {
    if (source.cut || text === "") return;
    const joined = `${source.partial}${text}`;
    if (joined.length <= this.limits.maxLineLength) {
      source.partial = joined;
      return;
    }
    source.partial = cutLine(joined, this.limits.maxLineLength);
    source.cut = true;
  }

  /**
   * Takes the open line, leaving the source with none.
   *
   * @param source - the source.
   */
  private close(source: Source): string {
    const line = source.partial;
    source.partial = "";
    source.cut = false;
    return line;
  }

  /**
   * Adds a complete line to `lines`, or counts it once the source's bound is reached.
   *
   * @param source - the source.
   * @param line - the line, without its line end.
   * @param lines - where it goes.
   */
  private accept(source: Source, line: string, lines: string[]): void {
    if (source.accepted >= this.limits.maxLines) {
      source.dropped += 1;
      return;
    }
    source.accepted += 1;
    lines.push(line);
  }
}

/**
 * A line cut to `max` UTF-16 units, without the word the cut fell in (a split surrogate goes with it),
 * then {@link CUT_MARK}.
 *
 * @param line - a line longer than `max`.
 * @param max - the most units kept.
 */
export function cutLine(line: string, max: number): string {
  let end = Math.min(max, line.length);
  // Back to the last whitespace: a loop, not `/\S*$/`, which backtracks quadratically on long runs.
  while (end > 0 && !/\s/.test(line.charAt(end - 1))) end -= 1;
  return `${line.slice(0, end)}${CUT_MARK}`;
}
