import { test, expect } from "@playwright/test";

import { withoutControls } from "../text";
import {
  capLine,
  cutToWidth,
  DEFAULT_WIDTH,
  displayWidth,
  LINE_CAP,
  MAX_WIDTH,
  MIN_WIDTH,
  padEnd,
  padStart,
  rule,
  terminalWidth,
} from "./layout";
import { SYMBOLS } from "./palette";

/** Splits text into grapheme clusters, as the layout does: the specs' oracle for "whole graphemes". */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * `text`'s grapheme clusters.
 *
 * @param text - any text.
 */
function graphemesOf(text: string): string[] {
  return [...GRAPHEMES.segment(text)].map(({ segment }) => segment);
}

/**
 * A seeded pseudo-random generator (mulberry32): the same seed, the same cases, so a failure
 * reproduces.
 *
 * @param seed - any 32-bit integer.
 * @returns a function giving floats in [0, 1).
 */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Text the cut must keep whole: one or more code points that draw as one thing, or nothing. */
const VISIBLE_ATOMS: readonly string[] = [
  "a",
  "Z",
  " ",
  "-",
  "\u4e2d",
  "\u6587",
  "\ud55c",
  "\uff71",
  "\u{1f44d}",
  "\u{1f44d}\u{1f3fd}",
  "\u{1f3fd}",
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}",
  "\u{1f3f3}\ufe0f\u200d\u{1f308}",
  // Regional indicators one at a time: an odd count leaves one unpaired.
  "\u{1f1eb}",
  "\u{1f1f7}",
  "\u{1f1eb}\u{1f1f7}",
  "1\u20e3",
  "#\ufe0f\u20e3",
  "\u2764\ufe0f",
  "\u2764",
  "e\u0301",
  "x\u0301\u0302\u0303",
  "\u0301",
  "\u0e01\u0e33",
  "\u0915\u094d\u0937",
  "\u0915\u093e",
  "\u1100\u1161",
  "\u00e9",
  "\u2026",
  "\u00b7",
  "\u2501",
  "\u00b1",
  "\t",
  "\u200b",
  "\ud83d",
  "\ude00",
  "[31m",
];

/** Escape sequences and stray controls: none may reach the output, nor any part of one. */
const ESCAPE_ATOMS: readonly string[] = [
  "\x1b[31m",
  "\x1b[0m",
  "\x1b[2J",
  "\x1b[1;2;3;4444m",
  "\x9b33m",
  "\x1bc",
  "\x1b7",
  "\x1b8",
  "\x1b]8;;https://example.test/a?b=1\x07",
  "\x1b]52;c;SGVsbG8=\x1b\\",
  "\x9d0;title\x9c",
  "\x1b]0;unterminated",
  "\x1bPq#0;2\x1b\\",
  "\x1b_apc\x1b\\",
  "\x1b",
  "\x9b",
  "\n",
  "\r",
];

/**
 * A random line of up to `max` atoms.
 *
 * @param random - the generator.
 * @param max - the most atoms.
 * @param withEscapes - whether escape sequences and controls may appear.
 */
function randomLine(
  random: () => number,
  max: number,
  withEscapes: boolean,
): string {
  const pick = (from: readonly string[]): string =>
    from[Math.floor(random() * from.length)] ?? "";
  let text = "";
  for (let n = Math.floor(random() * (max + 1)); n > 0; n--) {
    text += pick(withEscapes && random() < 0.25 ? ESCAPE_ATOMS : VISIBLE_ATOMS);
  }
  return text;
}

/**
 * Whether `text` holds anything that drives a terminal: a C0 or C1 control (`ESC` among them) or
 * DEL.
 *
 * @param text - an output of the layout.
 */
function hasControl(text: string): boolean {
  // eslint-disable-next-line no-control-regex -- finding control characters is the point.
  return /[\u0000-\u001f\u007f-\u009f]/.test(text);
}

/**
 * The longest prefix of `parts` (whole graphemes) at most `room` columns wide.
 *
 * @param parts - a line's graphemes.
 * @param room - the columns available.
 */
function longestPrefix(parts: readonly string[], room: number): string {
  let kept = "";
  for (const part of parts) {
    if (displayWidth(kept + part) > room) break;
    kept += part;
  }
  return kept;
}

/**
 * What {@link cutToWidth} must return, by its documented rule, for a whole-column `width`.
 *
 * @param text - the input.
 * @param width - a whole number of columns.
 * @param ellipsis - the ellipsis.
 */
function expectedCut(text: string, width: number, ellipsis: string): string {
  const line = withoutControls(text);
  if (displayWidth(line) <= width) return line;
  const parts = graphemesOf(line);
  const mark = withoutControls(ellipsis);
  const budget = width - displayWidth(mark);
  const marked = budget >= 0 ? longestPrefix(parts, budget) : "";
  if (marked !== "") return marked + mark;
  const bare = longestPrefix(parts, width);
  if (bare !== "") return bare;
  return budget >= 0 ? mark : "";
}

/**
 * Collects a property's broken cases, so a loop of thousands of checks asserts once (an `expect` per
 * check makes the spec minutes long) and a failure lists the first cases that broke it.
 */
class Violations {
  readonly #found: string[] = [];

  /**
   * Records `label` when `holds` is false.
   *
   * @param holds - whether the property held.
   * @param label - the case and the property's name.
   */
  check(holds: boolean, label: string): void {
    if (!holds && this.#found.length < 10) this.#found.push(label);
  }

  /** Fails the spec with the cases found, if any. */
  assertNone(): void {
    expect(this.#found).toEqual([]);
  }
}

/** How many generated lines each property sees. */
const CASES = 1000;

/** Widths no caller should pass, each with the number of columns it is read as. */
const ODD_WIDTHS: readonly (readonly [number, number])[] = [
  [Number.NaN, 0],
  [Number.POSITIVE_INFINITY, 0],
  [Number.NEGATIVE_INFINITY, 0],
  [-3, 0],
  [2.9, 2],
  [1e10, 500],
  [501, 500],
];

test.describe("constants", () => {
  test("are the documented values", () => {
    expect(MIN_WIDTH).toBe(20);
    expect(MAX_WIDTH).toBe(120);
    expect(DEFAULT_WIDTH).toBe(80);
    expect(LINE_CAP).toBe(500);
  });
});

test.describe("terminalWidth", () => {
  /** `[stream columns, COLUMNS, expected]`. */
  const table: readonly (readonly [
    number | undefined,
    string | undefined,
    number,
  ])[] = [
    [100, undefined, 100],
    [100, "60", 100],
    [120, undefined, 120],
    [121, undefined, 120],
    [500, undefined, 120],
    [20, undefined, 20],
    [19, undefined, 20],
    [1, undefined, 20],
    // No usable size on the stream: `COLUMNS`, then 80.
    [undefined, undefined, 80],
    [undefined, "90", 90],
    [0, "90", 90],
    [0, undefined, 80],
    [-5, "90", 90],
    [80.5, "90", 90],
    [Number.NaN, "90", 90],
    [Number.POSITIVE_INFINITY, "90", 90],
    [undefined, "100000", 120],
    [undefined, "7", 20],
    [undefined, "007", 20],
    [undefined, "99999999999999999999999", 120],
    // `COLUMNS` that is not a positive decimal integer is ignored.
    [undefined, "", 80],
    [undefined, "0", 80],
    [undefined, "-1", 80],
    [undefined, "+90", 80],
    [undefined, " 90", 80],
    [undefined, "90 ", 80],
    [undefined, "90.5", 80],
    [undefined, "1e2", 80],
    [undefined, "0x50", 80],
    [undefined, "abc", 80],
    [undefined, "\u0669\u0660", 80],
  ];
  for (const [columns, envColumns, expected] of table) {
    test(`columns ${String(columns)}, COLUMNS ${JSON.stringify(envColumns)} \u2192 ${String(expected)}`, () => {
      const stream = columns === undefined ? {} : { columns };
      const env = envColumns === undefined ? {} : { COLUMNS: envColumns };
      expect(terminalWidth({ stream, env })).toBe(expected);
    });
  }

  test("a terminal's size wins whatever TERM, locale or other variables say", () => {
    expect(
      terminalWidth({
        stream: { columns: 64 },
        env: { TERM: "dumb", LC_ALL: "C", NO_COLOR: "1", COLUMNS: "100" },
      }),
    ).toBe(64);
  });
});

test.describe("displayWidth", () => {
  /**
   * `[name, text, columns, columns tmux drew]`: the measure is never below what a terminal draws (a
   * live row never wraps), and above it only where a terminal draws a cluster narrower than its code
   * points. The last column was measured in tmux (the cursor's column after printing the text).
   */
  const table: readonly (readonly [string, string, number, number])[] = [
    ["empty", "", 0, 0],
    ["ASCII", "abc", 3, 3],
    ["CJK", "\u4e2d\u6587", 4, 4],
    ["halfwidth katakana", "\uff71", 1, 1],
    ["precomposed \u00e9", "\u00e9", 1, 1],
    ["e + acute", "e\u0301", 1, 1],
    ["Vietnamese stack", "e\u0323\u0302", 1, 1],
    ["cantillated Hebrew", "\u05e9\u05c1\u05bc\u05b8\u05bd\u0591", 1, 1],
    ["Tibetan stack", "\u0f67\u0fb9\u0fa8\u0fb3\u0fba\u0fbc", 1, 1],
    ["Thai SARA AM, 4 clusters", "\u0e01\u0e33".repeat(4), 8, 8],
    ["Devanagari conjuncts, 3", "\u0915\u094d\u0937".repeat(3), 6, 6],
    ["Devanagari spacing mark", "\u0915\u093e", 2, 1],
    ["Burmese", "\u1019\u103b\u103e\u1031\u102c\u103a", 4, 1],
    ["Hangul jamo L+V", "\u1100\u1161", 3, 2],
    ["Hangul syllable", "\uac00", 2, 2],
    ["emoji", "\u{1f44d}", 2, 2],
    ["emoji + modifier", "\u{1f44d}\u{1f3fd}", 4, 2],
    ["modifier alone", "\u{1f3fd}", 2, 2],
    ["a + 5 modifiers", `a${"\u{1f3fd}".repeat(5)}`, 11, 11],
    ["a + 30 modifiers", `a${"\u{1f3fd}".repeat(30)}`, 61, 61],
    ["ZWJ family", "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", 6, 2],
    ["family without ZWJ", "\u{1f468}\u{1f469}\u{1f467}", 6, 6],
    ["rainbow flag", "\u{1f3f3}\ufe0f\u200d\u{1f308}", 3, 2],
    ["flag", "\u{1f1eb}\u{1f1f7}", 2, 2],
    ["one regional indicator", "\u{1f1eb}", 1, 1],
    ["three regional indicators", "\u{1f1eb}\u{1f1f7}\u{1f1ef}", 3, 3],
    ["keycap", "1\u20e3", 2, 1],
    ["keycap + VS16", "1\ufe0f\u20e3", 2, 2],
    ["# keycap + VS16", "#\ufe0f\u20e3", 2, 2],
    ["heart", "\u2764", 1, 1],
    ["heart + VS16", "\u2764\ufe0f", 2, 2],
    ["heart + VS15", "\u2764\ufe0e", 1, 1],
    ["zero-width space", "a\u200bb", 2, 2],
    ["U+FFFD", "\ufffd", 1, 1],
    ["ambiguous \u00b1", "\u00b1", 1, 1],
  ];
  for (const [name, text, width, drawn] of table) {
    test(`${name} is ${String(width)} columns, never below the ${String(drawn)} drawn`, () => {
      expect(displayWidth(text)).toBe(width);
      expect(width).toBeGreaterThanOrEqual(drawn);
    });
  }

  test("every palette symbol is as wide as tmux draws it: 1 column, ASCII its length", () => {
    for (const { unicode, ascii } of Object.values(SYMBOLS)) {
      expect(displayWidth(unicode), unicode).toBe(1);
      expect(displayWidth(ascii), ascii).toBe(ascii.length);
    }
  });

  test("a control is the space it becomes; an escape sequence is nothing", () => {
    expect(displayWidth("a\tb")).toBe(3);
    expect(displayWidth("a\nb\r")).toBe(4);
    expect(displayWidth("\x1b[31mred\x1b[39m")).toBe(3);
    expect(displayWidth("\x9b1mx")).toBe(1);
    expect(
      displayWidth("\x1b]8;;https://example.test\x07link\x1b]8;;\x07"),
    ).toBe(4);
    // A lone surrogate is printed as U+FFFD: 1 column.
    expect(displayWidth("\ud83d")).toBe(1);
  });
});

test.describe("every function takes hostile input without throwing or passing a control on", () => {
  /** Strings that drive a terminal, or would once split. */
  const hostile: readonly string[] = [
    ...ESCAPE_ATOMS,
    "\x1bPq#0;2;0;0;0abcdef\x1b\\tail",
    "\x1b_payload\x1b\\x",
    "\x1b^pm\x1b\\x",
    "\x1bXsos\x1b\\x",
    "\x9d52;c;SGVsbG8=\x07x",
    "a\x1bcb\x1b7c\x1b8",
    `\x1b]0;${"t".repeat(2000)}`,
    "\ud83d\x1b[31m\ude00",
  ];
  for (const text of hostile) {
    test(JSON.stringify(text), () => {
      const outputs = [
        cutToWidth(text, 6, "\u2026"),
        cutToWidth("abcdefgh", 4, text),
        padEnd(text, 30),
        padStart(text, 30),
        rule({ width: 30, line: text }),
        rule({ width: 30, line: "=", title: text }),
        capLine(text, "\u2026"),
        capLine("a".repeat(LINE_CAP + 1), text),
      ];
      for (const out of outputs) {
        expect(hasControl(out), JSON.stringify(out)).toBe(false);
        expect(out.isWellFormed()).toBe(true);
      }
    });
  }

  test("a styled input comes out plain", () => {
    expect(cutToWidth("\x1b[31mredtext\x1b[39m", 4, "\u2026")).toBe(
      "red\u2026",
    );
    expect(padEnd("\x1b[31mok\x1b[39m", 4)).toBe("ok  ");
    expect(cutToWidth("\x1b[2J\x1b[Hab\x1bccd", 9, "")).toBe("abcd");
  });

  test("a sequence Node does not strip leaves its text and no ESC", () => {
    expect(padEnd("\x1bPq#0;2\x1b\\x", 0)).toBe("q#0;2 \\x");
    expect(padEnd("\x1b_apc\x1b\\x", 0)).toBe(" _apc \\x");
  });
});

test.describe("cutToWidth", () => {
  test("a line that fits is returned as is", () => {
    expect(cutToWidth("abc", 3, "\u2026")).toBe("abc");
    expect(cutToWidth("\u4e2d\u6587", 4, "...")).toBe("\u4e2d\u6587");
    expect(cutToWidth("", 0, "\u2026")).toBe("");
  });

  test("ends with the ellipsis it is given, measured: `\u2026` 1 column, `...` 3", () => {
    expect(cutToWidth("abcdefghij", 6, SYMBOLS.ellipsis.unicode)).toBe(
      "abcde\u2026",
    );
    expect(cutToWidth("abcdefghij", 6, SYMBOLS.ellipsis.ascii)).toBe("abc...");
    expect(cutToWidth("abcdefghij", 6, "")).toBe("abcdef");
    // Measured in columns, not code units: a wide one-unit ellipsis, a narrow two-unit one.
    expect(cutToWidth("abcdef", 4, "\u4e2d")).toBe("ab\u4e2d");
    expect(cutToWidth("abcdef", 4, "e\u0301")).toBe("abce\u0301");
    expect(cutToWidth("Backups \u203a Create a backup", 12, "\u2026")).toBe(
      "Backups \u203a C\u2026",
    );
  });

  test("with no grapheme before the ellipsis, what fits shows without one", () => {
    expect(cutToWidth("\u4e2d\u6587\u5b57", 2, "\u2026")).toBe("\u4e2d");
    expect(cutToWidth("\u4e2d\u6587\u5b57", 3, "\u2026")).toBe("\u4e2d\u2026");
    expect(cutToWidth("abcdef", 2, "...")).toBe("ab");
    expect(cutToWidth("abcdef", 1, "\u2026")).toBe("a");
    expect(cutToWidth("abcdef", 2, "\u2026")).toBe("a\u2026");
  });

  test("with nothing that fits, the ellipsis alone if it fits, else nothing", () => {
    expect(cutToWidth("\u4e2d\u6587", 1, "\u2026")).toBe("\u2026");
    expect(cutToWidth("\u4e2d\u6587", 1, "...")).toBe("");
    expect(cutToWidth("abcdef", 0, "\u2026")).toBe("");
  });

  test("never splits an emoji, a ZWJ sequence, a flag, a keycap or a wide character", () => {
    expect(cutToWidth("ab\u{1f44d}c", 3, "")).toBe("ab");
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(cutToWidth(`a${family}b`, 6, "")).toBe("a");
    expect(cutToWidth(`a${family}b`, 7, "")).toBe(`a${family}`);
    expect(cutToWidth("\u{1f1eb}\u{1f1f7}\u{1f1ef}\u{1f1f5}", 3, "")).toBe(
      "\u{1f1eb}\u{1f1f7}",
    );
    // An odd regional indicator is a 1-column grapheme of its own.
    expect(cutToWidth("\u{1f1eb}\u{1f1f7}\u{1f1ef}x", 3, "")).toBe(
      "\u{1f1eb}\u{1f1f7}\u{1f1ef}",
    );
    expect(cutToWidth("a#\ufe0f\u20e3b", 2, "")).toBe("a");
    expect(cutToWidth("\u4e2d\u6587\u5b57", 5, "")).toBe("\u4e2d\u6587");
    expect(cutToWidth("e\u0301e\u0301", 1, "")).toBe("e\u0301");
  });

  test("counts a cluster at least as wide as tmux draws it, so the row never wraps", () => {
    // `a` and its 30 modifiers are one 61-column grapheme.
    expect(cutToWidth(`xa${"\u{1f3fd}".repeat(30)}`, 10, "\u2026")).toBe(
      "x\u2026",
    );
    expect(cutToWidth("\u0e01\u0e33".repeat(4), 4, "")).toBe(
      "\u0e01\u0e33".repeat(2),
    );
    expect(cutToWidth("\u0915\u094d\u0937".repeat(5), 4, "")).toBe(
      "\u0915\u094d\u0937".repeat(2),
    );
  });

  for (const [width, read] of ODD_WIDTHS) {
    test(`a width of ${String(width)} is read as ${String(read)}`, () => {
      const line = "a".repeat(510);
      expect(cutToWidth(line, width, "")).toBe("a".repeat(read));
    });
  }

  test("stops at the first grapheme past the width: a megabyte line cuts fast", () => {
    const started = performance.now();
    expect(cutToWidth("\u4e2d".repeat(1_000_000), 4, "")).toBe("\u4e2d\u4e2d");
    expect(performance.now() - started).toBeLessThan(500);
  });

  test("property: never wider than asked, no control left, and the documented cut", () => {
    const random = prng(1);
    const violations = new Violations();
    for (let i = 0; i < CASES; i++) {
      const text = randomLine(random, 16, i % 2 === 0);
      const full = displayWidth(text);
      for (let width = 0; width <= full + 3; width++) {
        for (const ellipsis of ["", "\u2026", "...", "\u{1f44d}", "\u4e2d"]) {
          const out = cutToWidth(text, width, ellipsis);
          const label = JSON.stringify([text, width, ellipsis]);
          violations.check(displayWidth(out) <= width, `${label} too wide`);
          violations.check(!hasControl(out), `${label} kept a control`);
          violations.check(out.isWellFormed(), `${label} lone surrogate`);
          violations.check(
            out === expectedCut(text, width, ellipsis),
            `${label} gave ${JSON.stringify(out)}`,
          );
        }
      }
    }
    violations.assertNone();
  });

  test("property: a cut keeps a prefix of whole graphemes, and the next one would not fit", () => {
    const random = prng(2);
    const violations = new Violations();
    for (let i = 0; i < CASES; i++) {
      const line = withoutControls(randomLine(random, 16, i % 2 === 0));
      const parts = graphemesOf(line);
      for (let width = 0; width < displayWidth(line); width++) {
        const label = JSON.stringify([line, width]);
        const kept = cutToWidth(line, width, "");
        let length = 0;
        let at = 0;
        while (length < kept.length && at < parts.length) {
          length += (parts[at++] ?? "").length;
        }
        violations.check(
          line.startsWith(kept) && length === kept.length,
          `${label} split a grapheme`,
        );
        const next = parts[at];
        violations.check(
          next === undefined || displayWidth(kept + next) > width,
          `${label} cut too early`,
        );
      }
    }
    violations.assertNone();
  });
});

test.describe("padEnd and padStart", () => {
  test("pad by display width, never by code units", () => {
    expect(padEnd("\u4e2d", 4)).toBe("\u4e2d  ");
    expect(padStart("\u4e2d", 4)).toBe("  \u4e2d");
    expect(padEnd("caf\u00e9", 6)).toBe("caf\u00e9  ");
    expect(padEnd("\u{1f44d}", 3)).toBe("\u{1f44d} ");
    expect(padStart("8.1s", 6)).toBe("  8.1s");
    expect(padEnd("a\tb", 5)).toBe("a b  ");
  });

  test("text as wide or wider is returned as is", () => {
    expect(padEnd("abc", 3)).toBe("abc");
    expect(padEnd("abcd", 3)).toBe("abcd");
    expect(padStart("abcd", 3)).toBe("abcd");
    expect(padStart("abc", -1)).toBe("abc");
  });

  for (const [width, read] of ODD_WIDTHS) {
    test(`a width of ${String(width)} is read as ${String(read)}`, () => {
      expect(padEnd("", width)).toBe(" ".repeat(read));
      expect(padStart("ab", width)).toBe(
        `${" ".repeat(Math.max(0, read - 2))}ab`,
      );
    });
  }

  test("property: padded text is exactly the width, or the text when wider", () => {
    const random = prng(3);
    const violations = new Violations();
    for (let i = 0; i < CASES; i++) {
      const text = randomLine(random, 8, true);
      const line = withoutControls(text);
      const full = displayWidth(line);
      for (let width = 0; width <= full + 4; width++) {
        const label = JSON.stringify([text, width]);
        const end = padEnd(text, width);
        const start = padStart(text, width);
        violations.check(
          displayWidth(end) === Math.max(width, full) &&
            end.startsWith(line) &&
            /^ *$/.test(end.slice(line.length)),
          `${label} padEnd`,
        );
        violations.check(
          displayWidth(start) === Math.max(width, full) &&
            start.endsWith(line) &&
            /^ *$/.test(start.slice(0, start.length - line.length)),
          `${label} padStart`,
        );
      }
    }
    violations.assertNone();
  });
});

test.describe("rule", () => {
  test("repeats the glyph to the width, short by less than a glyph", () => {
    expect(rule({ width: 10, line: "=" })).toBe("==========");
    expect(rule({ width: 10, line: SYMBOLS.heavyRule.unicode })).toBe(
      "\u2501".repeat(10),
    );
    expect(rule({ width: 11, line: "\u4e2d" })).toBe("\u4e2d".repeat(5));
    expect(rule({ width: 0, line: "=" })).toBe("");
    expect(rule({ width: 1, line: "\u4e2d" })).toBe("");
  });

  test("a title sits after two glyphs, the rest filled", () => {
    expect(rule({ width: 16, line: "=", title: "BackWPup" })).toBe(
      "== BackWPup ====",
    );
    expect(rule({ width: 14, line: "\u2501", title: "a \u00b7 b" })).toBe(
      "\u2501\u2501 a \u00b7 b \u2501\u2501\u2501\u2501\u2501",
    );
  });

  test("a title is never cut: too wide, it gets no fill", () => {
    expect(rule({ width: 13, line: "=", title: "BackWPup" })).toBe(
      "== BackWPup =",
    );
    expect(rule({ width: 12, line: "=", title: "BackWPup" })).toBe(
      "== BackWPup",
    );
    expect(rule({ width: 5, line: "=", title: "a long title" })).toBe(
      "== a long title",
    );
  });

  test("an empty title is no title", () => {
    expect(rule({ width: 9, line: "=", title: "" })).toBe(
      rule({ width: 9, line: "=" }),
    );
    expect(rule({ width: 9, line: "=", title: "\x1b[0m" })).toBe("=========");
  });

  test("an empty or zero-width glyph draws no line", () => {
    expect(rule({ width: 10, line: "" })).toBe("");
    expect(rule({ width: 10, line: "", title: "t" })).toBe("t");
    expect(rule({ width: 10, line: "\u200b" })).toBe("");
    expect(rule({ width: 10, line: "\x1b[31m" })).toBe("");
  });

  for (const [width, read] of ODD_WIDTHS) {
    test(`a width of ${String(width)} is read as ${String(read)}`, () => {
      expect(rule({ width, line: "-" })).toBe("-".repeat(read));
    });
  }

  test("property: never wider than asked while the title fits", () => {
    const random = prng(4);
    const violations = new Violations();
    for (let i = 0; i < CASES; i++) {
      const title = withoutControls(randomLine(random, 6, false));
      const line = random() < 0.5 ? "\u4e2d" : "-";
      const glyph = displayWidth(line);
      for (let width = 0; width <= 40; width++) {
        const label = JSON.stringify([title, line, width]);
        const out = rule({ width, line, title });
        const bare = rule({ width, line });
        violations.check(
          bare === line.repeat(Math.floor(width / glyph)),
          `${label} bare rule`,
        );
        if (title === "") {
          violations.check(out === bare, `${label} empty title`);
          continue;
        }
        const head = 2 * glyph + 1 + displayWidth(title);
        violations.check(
          out.startsWith(`${line}${line} ${title}`),
          `${label} lost the title`,
        );
        violations.check(
          head > width || displayWidth(out) <= width,
          `${label} too wide`,
        );
        // The fill leaves less than a glyph and its space unused.
        violations.check(
          head + 1 + glyph > width || displayWidth(out) > width - glyph,
          `${label} fill too short`,
        );
      }
    }
    violations.assertNone();
  });
});

test.describe("capLine", () => {
  test("a line within the cap is unchanged", () => {
    const line = "a".repeat(500);
    expect(capLine(line, "\u2026")).toBe(line);
    const thumbs = "\u{1f44d}".repeat(500);
    expect(capLine(thumbs, "\u2026")).toBe(thumbs);
  });

  test("a longer line keeps the cap's worth of code points, ellipsis included", () => {
    expect(capLine("a".repeat(501), "...")).toBe(`${"a".repeat(497)}...`);
    expect(capLine("a".repeat(10_000), "\u2026")).toBe(
      `${"a".repeat(499)}\u2026`,
    );
  });

  test("an astral ellipsis is one code point", () => {
    expect(capLine("a".repeat(600), "\u{1f44d}")).toBe(
      `${"a".repeat(499)}\u{1f44d}`,
    );
  });

  test("an ellipsis longer than the cap is cut to it", () => {
    expect(capLine("a".repeat(600), "b".repeat(600))).toBe("b".repeat(500));
    expect(capLine("a".repeat(600), "\u{1f44d}".repeat(600))).toBe(
      "\u{1f44d}".repeat(500),
    );
  });

  test("never splits a surrogate pair or a grapheme that fits a line whole", () => {
    // A family is 5 code points: 99 fit in 499.
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}";
    expect(capLine(family.repeat(200), "\u2026")).toBe(
      `${family.repeat(99)}\u2026`,
    );
    expect(capLine(`b${"\u{1f44d}".repeat(600)}`, "\u2026")).toBe(
      `b${"\u{1f44d}".repeat(498)}\u2026`,
    );
  });

  test("a grapheme exactly a line long waits for its own line", () => {
    // `a` + 498 marks is 499 code points: it fits a line beside the ellipsis, so it is not split.
    expect(capLine(`b${"a" + "\u0301".repeat(498)}c`, "\u2026")).toBe(
      "b\u2026",
    );
  });

  test("a grapheme too long for any line is cut by code point, not dropped", () => {
    expect(capLine(`a${"\u0301".repeat(1000)}`, "\u2026")).toBe(
      `a${"\u0301".repeat(498)}\u2026`,
    );
    expect(capLine(`xy${"\u{1f3fd}".repeat(600)}`, "\u2026")).toBe(
      `xy${"\u{1f3fd}".repeat(497)}\u2026`,
    );
  });

  test("property: never above the cap, never ill-formed, a prefix of the input", () => {
    const random = prng(5);
    const violations = new Violations();
    for (let i = 0; i < 200; i++) {
      let text = "";
      const target = LINE_CAP - 20 + random() * 60;
      while (Array.from(text).length < target) {
        text += randomLine(random, 8, false);
      }
      const line = withoutControls(text);
      for (const ellipsis of ["", "\u2026", "...", "\u{1f44d}"]) {
        const out = capLine(text, ellipsis);
        const label = JSON.stringify([text.length, ellipsis]);
        violations.check(Array.from(out).length <= LINE_CAP, `${label} cap`);
        violations.check(out.isWellFormed(), `${label} lone surrogate`);
        violations.check(
          Array.from(line).length <= LINE_CAP
            ? out === line
            : out.endsWith(ellipsis) &&
                line.startsWith(out.slice(0, out.length - ellipsis.length)),
          `${label} not a prefix`,
        );
      }
    }
    violations.assertNone();
  });
});
