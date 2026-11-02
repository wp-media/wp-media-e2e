/**
 * Palettes for code that prints outside the suite's reporter: the setup projects' lines (which run in
 * a worker) and the standalone scripts (healthcheck, artifact warm, fixture capture). Each honours
 * the same switches the reporter does — `E2E_OUTPUT`, `NO_COLOR`, `FORCE_COLOR`, `TERM`, the locale —
 * through the one precedence in `terminal/capabilities.ts`.
 */

import { detectCapabilities } from "../terminal/capabilities";
import type { OutputStream } from "../terminal/capabilities";
import { createPalette, paletteFor } from "../terminal/palette";
import type { Palette } from "../terminal/palette";
import { outputModeEnv } from "./env";

/** Where a script's styled lines go: the stream's palette and how a line reaches it. */
export interface Printer {
  /** Styles and symbols for the stream {@link Printer.print} writes to. */
  readonly palette: Palette;
  /** Writes one line (or several, joined by `\n`) and its line end. */
  readonly print: (line: string) => void;
}

/** A program's two printers: its progress (stdout) and its warnings and errors (stderr). */
export interface Printers {
  /** Progress and results. */
  readonly out: Printer;
  /** Warnings and errors. */
  readonly err: Printer;
}

/**
 * The palette for lines a script writes straight to `stream`: colour as the stream and environment
 * allow (a pipe only under `FORCE_COLOR`, as a suite run), ASCII symbols under `E2E_OUTPUT=plain`, a
 * dumb terminal or a non-UTF-8 locale.
 *
 * @param stream - the stream the lines go to (`process.stdout` or `process.stderr`).
 * @param source - the environment; `process.env` unless a spec holds another.
 * @returns the stream's palette.
 * @throws {@link Error} when `E2E_OUTPUT` is not a mode (`outputModeEnv`).
 */
export function streamPalette(
  stream: OutputStream,
  source: NodeJS.ProcessEnv = process.env,
): Palette {
  return paletteFor({ env: source, stream, mode: outputModeEnv(source) });
}

/**
 * The palette for lines a test worker prints. Never coloured: the runner's reporter takes a worker's
 * output, strips its escapes and prints it itself (and workers run under `FORCE_COLOR=1`, so a
 * stream-based decision would colour them for nothing). Symbols as the run's terminal shows them:
 * ASCII under `E2E_OUTPUT=plain`, `TERM=dumb` or a non-UTF-8 locale.
 *
 * @param source - the environment; `process.env` unless a spec holds another.
 * @returns a colourless palette.
 * @throws {@link Error} when `E2E_OUTPUT` is not a mode (`outputModeEnv`).
 */
export function workerPalette(
  source: NodeJS.ProcessEnv = process.env,
): Palette {
  const { unicode } = detectCapabilities({
    env: source,
    stream: { isTTY: false },
    mode: outputModeEnv(source),
  });
  return createPalette({ tty: false, color: false, unicode });
}

/** The two streams a script prints to, as far as their palettes need them. */
export interface ConsoleStreams {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
}

/**
 * A script's two printers: stdout's (`console.log`) and stderr's (`console.error`), each with its own
 * stream's palette, so a warning sent to a redirected stderr is never coloured for stdout's terminal.
 *
 * @param source - the environment; `process.env` unless a spec holds another.
 * @param streams - what decides each palette: the process's own streams unless a spec holds others
 * (`console.log`/`console.error` still print).
 * @returns the stdout and stderr printers.
 * @throws {@link Error} when `E2E_OUTPUT` is not a mode (`outputModeEnv`).
 */
export function consolePrinters(
  source: NodeJS.ProcessEnv = process.env,
  streams: ConsoleStreams = process,
): Printers {
  return {
    out: {
      palette: streamPalette(streams.stdout, source),
      print: (line) => {
        console.log(line);
      },
    },
    err: {
      palette: streamPalette(streams.stderr, source),
      print: (line) => {
        console.error(line);
      },
    },
  };
}

/**
 * A test worker's printers: `console.log` and `console.warn`, both with {@link workerPalette}.
 *
 * @param source - the environment; `process.env` unless a spec holds another.
 * @returns the worker's printers.
 * @throws {@link Error} when `E2E_OUTPUT` is not a mode (`outputModeEnv`).
 */
export function workerPrinters(
  source: NodeJS.ProcessEnv = process.env,
): Printers {
  const palette = workerPalette(source);
  return {
    out: {
      palette,
      print: (line) => {
        console.log(line);
      },
    },
    err: {
      palette,
      print: (line) => {
        console.warn(line);
      },
    },
  };
}
