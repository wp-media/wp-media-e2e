import { styleText } from "node:util";

import type { TerminalCapabilities } from "./capabilities";

/**
 * The terminal's semantic colours and symbols. A palette styles text that is already final — plain,
 * masked, cut — and decides nothing: {@link TerminalCapabilities} already said whether the stream is
 * a terminal and whether colour and Unicode are on. Side-effect free.
 *
 * With colour on, `styleText` runs with `validateStream: false`, which skips Node's own stream and
 * environment checks (measured on a pty: it emits SGR even under `NO_COLOR` or `CI`), so a terminal
 * under `CI` keeps the colour the capabilities granted. With colour off, `paint` returns its text unchanged and nothing emits an escape.
 */

/** What a piece of text means, which picks its style. */
export type Token = "ok" | "fail" | "warn" | "stop" | "id" | "dim" | "command";

/** Named ANSI colours and bold/dim only: no 256-colour, truecolor or background. */
const TOKEN_FORMATS: Readonly<Record<Token, Parameters<typeof styleText>[0]>> =
  {
    ok: "green",
    fail: "red",
    warn: "yellow",
    stop: "yellow",
    id: "cyan",
    // Metadata and paths.
    dim: "dim",
    command: "bold",
  };

/**
 * A symbol's two spellings: Unicode, and the ASCII shown on a dumb terminal, under a non-UTF-8 locale
 * or in plain mode. The ASCII one can be wider (`OK`, `->`, `...`): layout measures the glyph it is
 * given, never assumes one column.
 */
interface Glyph {
  readonly unicode: string;
  readonly ascii: string;
}

/** Every symbol the terminal output draws, by role: a new one is added here, never spelt inline. */
export const SYMBOLS = {
  passed: { unicode: "✔", ascii: "OK" },
  failed: { unicode: "✘", ascii: "x" },
  warning: { unicode: "⚠", ascii: "!" },
  stopped: { unicode: "■", ascii: "#" },
  /** A scenario running now. */
  current: { unicode: "▸", ascii: ">" },
  /** A failed attempt due a retry. */
  retry: { unicode: "↻", ascii: "~" },
  /** A progress bar's done and remaining cells. */
  barDone: { unicode: "█", ascii: "#" },
  barLeft: { unicode: "░", ascii: "-" },
  check: { unicode: "✓", ascii: "ok" },
  cross: { unicode: "✗", ascii: "x" },
  /** Between facts on one line. */
  separator: { unicode: "·", ascii: "." },
  /** Between a list item and its detail, and an empty table cell. */
  dash: { unicode: "—", ascii: "-" },
  /** From one state or value to the next. */
  arrow: { unicode: "→", ascii: "->" },
  /** Tree drawing: a vertical line, a branch, the last branch. */
  vertical: { unicode: "│", ascii: "|" },
  branch: { unicode: "├", ascii: "+" },
  lastBranch: { unicode: "└", ascii: "+" },
  /** Rules: light and heavy. */
  rule: { unicode: "─", ascii: "-" },
  heavyRule: { unicode: "━", ascii: "=" },
  /** Between a feature and its scenario. */
  breadcrumb: { unicode: "›", ascii: ">" },
  ellipsis: { unicode: "…", ascii: "..." },
} as const satisfies Readonly<Record<string, Glyph>>;

/** A symbol's role. */
export type SymbolName = keyof typeof SYMBOLS;

/** A status, which always has a symbol, a word and a colour. */
export type Status = "passed" | "failed" | "flaky" | "stopped" | "warning";

/** How a status is shown. */
interface StatusStyle {
  readonly symbol: SymbolName;
  readonly token: Token;
  /**
   * Whether a coloured terminal may show the mark without the word. `false` for a status whose mark
   * and colour another status shares (flaky looks like a warning), so only the word tells them apart.
   */
  readonly markAlone: boolean;
}

/** How each status is shown. */
export const STATUSES: Readonly<Record<Status, StatusStyle>> = {
  passed: { symbol: "passed", token: "ok", markAlone: true },
  failed: { symbol: "failed", token: "fail", markAlone: true },
  flaky: { symbol: "warning", token: "warn", markAlone: false },
  stopped: { symbol: "stopped", token: "stop", markAlone: true },
  warning: { symbol: "warning", token: "warn", markAlone: true },
};

/** Styles and symbols for one stream, from its capabilities. */
export interface Palette {
  /** `text` in `token`'s style; `text` itself when colour is off or it is empty. */
  readonly paint: (token: Token, text: string) => string;
  /** The symbol for `name`, in Unicode or ASCII, never styled: colour is the caller's `paint`. */
  readonly symbol: (name: SymbolName) => string;
  /**
   * A status as shown on its own: the painted symbol, then the status word. The word is dropped only
   * on a terminal with colour on, and never for flaky; so a log (even a coloured pipe, whose escapes
   * get stripped) or a screen reader never meets a colour-only status.
   */
  readonly status: (status: Status) => string;
}

/**
 * The palette for a stream with `capabilities`.
 *
 * @param capabilities - whether the stream is a terminal, and whether colour and Unicode are on.
 * @returns the palette; it keeps no state.
 * @example
 * ```ts
 * createPalette({ tty: false, color: false, unicode: false }).status("failed"); // "x failed"
 * createPalette({ tty: true, color: true, unicode: true }).status("passed"); // "\x1b[32m✔\x1b[39m"
 * ```
 */
export function createPalette(
  capabilities: Pick<TerminalCapabilities, "tty" | "color" | "unicode">,
): Palette {
  const paint = capabilities.color ? stylePaint : plainPaint;
  const symbol = (name: SymbolName): string =>
    capabilities.unicode ? SYMBOLS[name].unicode : SYMBOLS[name].ascii;
  // Only a coloured terminal shows a mark alone: elsewhere the colour may never be seen.
  const marksAlone = capabilities.color && capabilities.tty;
  const status = (name: Status): string => {
    const { symbol: glyph, token, markAlone } = STATUSES[name];
    const mark = paint(token, symbol(glyph));
    return marksAlone && markAlone ? mark : `${mark} ${name}`;
  };
  return { paint, symbol, status };
}

/**
 * {@link Palette.paint} with colour on: SGR through `styleText`, Node's checks skipped.
 *
 * @param token - the meaning, which picks the style.
 * @param text - final, plain text.
 */
function stylePaint(token: Token, text: string): string {
  if (text === "") return text;
  return styleText(TOKEN_FORMATS[token], text, { validateStream: false });
}

/**
 * {@link Palette.paint} with colour off: the text unchanged.
 *
 * @param _token - ignored.
 * @param text - final, plain text.
 */
function plainPaint(_token: Token, text: string): string {
  return text;
}
