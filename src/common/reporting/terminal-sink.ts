/**
 * One writer for the run's terminal. The terminal reporter (`terminal.reporter.ts`) owns standard
 * output while a run is shown; every other suite reporter that writes during the run — the cell
 * notice, the results stream's and the run facts' warnings — hands its lines here instead of writing
 * `process.stdout`/`process.stderr` itself, so they land between the reporter's own lines, cleaned
 * and masked as those are (and, once a live region is drawn, above it).
 *
 * The registry lives on `globalThis` under a registered symbol, not in this module: Playwright loads
 * each reporter file on its own, and one module loaded twice must still find the same sink. Nothing
 * registers at import. With no sink registered — a reporter used alone (its specs), a `--reporter`
 * stack without the terminal reporter, `--list`, `--ui`, `PW_TEST_REPORTER` — {@link printLine} writes
 * the text as it always did, to the stream the caller names.
 */

/** Where a printed line goes when the run has no terminal sink. */
export type FallbackStream = "stdout" | "stderr";

/** What owns the terminal: it prints text as permanent lines, and never throws. */
export interface TerminalSink {
  /**
   * Prints text as permanent lines: each line made plain and masked by the sink, never cut.
   *
   * @param text - one or more lines, `\n`-separated, no line end needed.
   */
  print(text: string): void;
}

/** The symbol the registry hangs on `globalThis`: shared by every copy of this module. */
const REGISTRY = Symbol.for("wp-media-e2e.terminal-sink");

/** The registered sinks, newest last: only the newest prints. */
type Registry = TerminalSink[];

/**
 * The registry, created on first use.
 *
 * @returns the shared list of registered sinks.
 */
function registry(): Registry {
  const holder = globalThis as { [REGISTRY]?: Registry };
  holder[REGISTRY] ??= [];
  return holder[REGISTRY];
}

/**
 * Makes `sink` the run's terminal until the returned function unregisters it. The newest
 * registration wins (a watch or UI session builds new reporters for each run); unregistering one
 * that is not the newest removes only it.
 *
 * @param sink - the terminal reporter's sink.
 * @returns unregisters `sink`; calling it again does nothing.
 */
export function registerTerminalSink(sink: TerminalSink): () => void {
  registry().push(sink);
  return () => {
    const sinks = registry();
    const index = sinks.lastIndexOf(sink);
    if (index !== -1) sinks.splice(index, 1);
  };
}

/**
 * The sink that prints now, if any.
 *
 * @returns the newest registered sink, or `undefined`.
 */
export function currentTerminalSink(): TerminalSink | undefined {
  return registry().at(-1);
}

/**
 * Prints text as permanent lines: through the registered sink, or — with none — straight to
 * `fallback`, as `text` and a line end, unchanged. Never throws: a reporter that throws fails a run
 * that passed.
 *
 * @param text - one or more lines, `\n`-separated, no line end needed.
 * @param fallback - the stream it went to before the sink existed: `stderr` for a warning.
 */
export function printLine(text: string, fallback: FallbackStream): void {
  try {
    const sink = currentTerminalSink();
    if (sink !== undefined) {
      sink.print(text);
      return;
    }
    const stream = fallback === "stdout" ? process.stdout : process.stderr;
    stream.write(`${text}\n`);
  } catch {
    // Nowhere is left to print.
  }
}
