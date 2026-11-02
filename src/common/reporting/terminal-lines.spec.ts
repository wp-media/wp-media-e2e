import { test, expect } from "@playwright/test";
import { stripVTControlCharacters } from "node:util";

import { LINE_CAP } from "../terminal/layout";
import {
  ERROR_LINES,
  attemptDuration,
  attemptShown,
  MAX_INDENT,
  OUTSIDE_TESTS_TITLE,
  beginLine,
  cleanLine,
  droppedOutputLine,
  errorLine,
  mark,
  outputLine,
  runErrorLines,
  runHeaderLine,
  suiteLine,
  terminalStyle,
  testLine,
  testTitle,
  verdictOf,
  type Verdict,
} from "./terminal-lines";

/**
 * The terminal reporter's lines, per stream: a coloured terminal (marks alone), a pipe (words, no
 * escape), ASCII (a dumb terminal or plain mode), a coloured pipe (`FORCE_COLOR`: escapes, words
 * kept). Every external value arrives hostile — escapes, controls, credentials, runaway length — and
 * must leave plain, masked and capped.
 */

/** A coloured terminal with Unicode. */
const TTY = terminalStyle({ tty: true, color: true, unicode: true });
/** A pipe or file: no colour, Unicode. */
const PIPE = terminalStyle({ tty: false, color: false, unicode: true });
/** `TERM=dumb`, a C locale or `E2E_OUTPUT=plain`: ASCII, no colour. */
const ASCII = terminalStyle({ tty: false, color: false, unicode: false });
/** `FORCE_COLOR` into a pipe: colour, but nobody may see it, so the words stay. */
const FORCED = terminalStyle({ tty: false, color: true, unicode: true });
/** A terminal under `NO_COLOR`. */
const TTY_NO_COLOR = terminalStyle({ tty: true, color: false, unicode: true });

/** Without its SGR. */
const bare = (text: string): string => stripVTControlCharacters(text);

/** Any control character but the SGR escape a styled line may carry. */
// eslint-disable-next-line no-control-regex -- the point is to find control characters.
const CONTROL = /[\u0000-\u0008\u000a-\u001a\u001c-\u001f\u007f-\u009f]/;

test.describe("mark — a status shown, never by colour alone", () => {
  const verdicts: Verdict[] = [
    "passed",
    "failed",
    "flaky",
    "stopped",
    "warning",
    "skipped",
    "interrupted",
    "retry",
    "error",
  ];

  test("a pipe shows each glyph with its word", () => {
    expect(verdicts.map((v) => mark(PIPE, v))).toEqual([
      "✔ passed",
      "✘ failed",
      "⚠ flaky",
      "■ stopped",
      "⚠ warning",
      "— skipped",
      "■ interrupted",
      "↻ retry",
      "✘ error",
    ]);
  });

  test("ASCII spells each glyph", () => {
    expect(verdicts.map((v) => mark(ASCII, v))).toEqual([
      "OK passed",
      "x failed",
      "! flaky",
      "# stopped",
      "! warning",
      "- skipped",
      "# interrupted",
      "~ retry",
      "x error",
    ]);
  });

  test("a coloured terminal drops the word only where no other verdict shares glyph and colour", () => {
    expect(verdicts.map((v) => bare(mark(TTY, v)))).toEqual([
      "✔",
      "✘",
      "⚠ flaky",
      "■",
      "⚠",
      "— skipped",
      "■ interrupted",
      "↻",
      "✘ error",
    ]);
    expect(mark(TTY, "passed")).toBe("\u001b[32m✔\u001b[39m");
    expect(mark(TTY, "retry")).toBe("\u001b[33m↻\u001b[39m");
  });

  test("colour a nobody may see (a coloured pipe), or a terminal without colour, keeps every word", () => {
    for (const style of [FORCED, TTY_NO_COLOR]) {
      expect(verdicts.map((v) => bare(mark(style, v)))).toEqual(
        verdicts.map((v) => bare(mark(PIPE, v))),
      );
    }
    expect(mark(FORCED, "failed")).toBe("\u001b[31m✘\u001b[39m failed");
    expect(mark(TTY_NO_COLOR, "failed")).toBe("✘ failed");
  });
});

test.describe("verdictOf", () => {
  test("a skip the drain made is stopped; every other status is itself", () => {
    expect(verdictOf("skipped", true)).toBe("stopped");
    expect(verdictOf("skipped", false)).toBe("skipped");
    for (const status of [
      "passed",
      "failed",
      "flaky",
      "interrupted",
    ] as const) {
      expect(verdictOf(status, false)).toBe(status);
      expect(verdictOf(status, true)).toBe(status);
    }
  });
});

test.describe("attemptDuration", () => {
  test("tenths of a second under a minute, the summary's format from one", () => {
    expect(attemptDuration(18_412)).toBe("18.4s");
    expect(attemptDuration(8_050)).toBe("8.1s");
    expect(attemptDuration(49)).toBe("0.0s");
    expect(attemptDuration(59_940)).toBe("59.9s");
    // Rounds to "60.0s": said in minutes instead.
    expect(attemptDuration(59_960)).toBe("1.0m");
    expect(attemptDuration(852_000)).toBe("14.2m");
    expect(attemptDuration(2.3 * 3_600_000)).toBe("2.3h");
  });

  test("anything but a finite, positive number is 0.0s", () => {
    for (const ms of [0, -1, -0, Number.NaN, Infinity, -Infinity]) {
      expect(attemptDuration(ms), String(ms)).toBe("0.0s");
    }
  });
});

test.describe("attemptShown", () => {
  test("past the first attempt, always", () => {
    for (const verdict of ["passed", "flaky", "failed", "stopped"] as const) {
      expect(attemptShown(verdict, { number: 2, of: 3 })).toBe(true);
    }
  });

  test("on the first, only for a failure when more were allowed", () => {
    expect(attemptShown("retry", { number: 1, of: 3 })).toBe(true);
    expect(attemptShown("failed", { number: 1, of: 3 })).toBe(true);
    expect(attemptShown("interrupted", { number: 1, of: 2 })).toBe(true);
    for (const verdict of ["passed", "skipped", "stopped"] as const) {
      expect(attemptShown(verdict, { number: 1, of: 3 })).toBe(false);
    }
    expect(attemptShown("failed", { number: 1, of: 1 })).toBe(false);
  });
});

test.describe("testTitle", () => {
  test("joins the place's parts with the breadcrumb, dropping empty ones", () => {
    expect(testTitle(["Backups", "Rule", "Create a backup"], PIPE)).toBe(
      "Backups › Rule › Create a backup",
    );
    expect(testTitle(["Backups", "", "  ", "Create"], ASCII)).toBe(
      "Backups > Create",
    );
  });

  test("makes each part plain and masks credentials before the cap", () => {
    const title = testTitle(
      [
        "Feat\u001b[31mure\u001b[0m\nline",
        "Login at https://u:secret@host.test/",
      ],
      PIPE,
    );
    expect(title).toBe("Feature line › Login at https://***@host.test/");
    expect(title).not.toContain("secret");
  });

  test("caps a runaway title at the line cap, with the ellipsis", () => {
    const title = testTitle(["F", "x".repeat(10_000)], PIPE);
    expect(Array.from(title)).toHaveLength(LINE_CAP);
    expect(title.endsWith("…")).toBe(true);
  });
});

test.describe("testLine", () => {
  const title = "Backups › Create a backup";

  test("a passed scenario on a coloured terminal: the mark alone, the duration dim", () => {
    const line = testLine(TTY, {
      verdict: "passed",
      durationMs: 18_412,
      title,
    });
    expect(bare(line)).toBe("✔ 18.4s  Backups › Create a backup");
    expect(line).toBe(
      "\u001b[32m✔\u001b[39m \u001b[2m18.4s\u001b[22m  Backups › Create a backup",
    );
  });

  test("a failed final attempt in a pipe: the word and the attempt", () => {
    expect(
      testLine(PIPE, {
        verdict: "failed",
        durationMs: 8_100,
        title,
        attempt: { number: 2, of: 2 },
      }),
    ).toBe("✘ failed 8.1s  Backups › Create a backup · attempt 2/2");
  });

  test("a retry names how the attempt ended; a first passing attempt names none", () => {
    expect(
      testLine(ASCII, {
        verdict: "retry",
        durationMs: 500,
        title: "F > S",
        attempt: { number: 1, of: 3 },
        note: "timed out",
      }),
    ).toBe("~ retry 0.5s  F > S . attempt 1/3 . timed out");
    expect(
      testLine(PIPE, {
        verdict: "passed",
        durationMs: 500,
        title,
        attempt: { number: 1, of: 3 },
      }),
    ).toBe("✔ passed 0.5s  Backups › Create a backup");
  });

  test("a note shows without an attempt", () => {
    expect(
      testLine(PIPE, {
        verdict: "failed",
        durationMs: 0,
        title,
        note: "retry not run",
      }),
    ).toBe("✘ failed 0.0s  Backups › Create a backup · retry not run");
  });

  test("flaky keeps its word even on a coloured terminal", () => {
    expect(
      bare(
        testLine(TTY, {
          verdict: "flaky",
          durationMs: 3_000,
          title,
          attempt: { number: 2, of: 3 },
        }),
      ),
    ).toBe("⚠ flaky 3.0s  Backups › Create a backup · attempt 2/3");
  });
});

test.describe("cleanLine — another's text as one permanent line", () => {
  test("strips escapes and controls, masks, and keeps the leading indent", () => {
    expect(
      cleanLine(
        "    \u001b[33mwarn:\u001b[39m token ghp_0123456789abcdefghijABCDEFGHIJ0123456789\tend  ",
        "…",
      ),
    ).toBe("    warn: token *** end");
  });

  test("a blank or control-only line is empty", () => {
    expect(cleanLine("", "…")).toBe("");
    expect(cleanLine("\u001b[0m\r", "…")).toBe("");
    expect(cleanLine("   ", "…")).toBe("");
    expect(cleanLine("\t\u200b", "…")).toBe("");
  });

  test("a runaway indent is collapsed to MAX_INDENT before the cap, so the words still show", () => {
    expect(cleanLine(`${" ".repeat(5_000)}words`, "…")).toBe(
      `${" ".repeat(MAX_INDENT)}words`,
    );
    // Tabs are controls: a run of them is one space.
    expect(cleanLine("\t\t\tdeep", "…")).toBe(" deep");
  });

  test("caps at the line cap, counting the indent", () => {
    const line = cleanLine(`  ${"y".repeat(2_000)}`, "...");
    expect(Array.from(line)).toHaveLength(LINE_CAP);
    expect(line.startsWith("  y")).toBe(true);
    expect(line.endsWith("...")).toBe(true);
  });
});

test.describe("suiteLine — the suite's own lines through the sink", () => {
  test("plain and masked like cleanLine, but never cut: paths and commands stay whole", () => {
    const path = `/reports/${"deep/".repeat(200)}run-1`;
    expect(suiteLine(`[cell] demo/x; report in ${path}\u001b[2J`)).toBe(
      `[cell] demo/x; report in ${path}`,
    );
    expect(suiteLine("  [results] via https://a:b@c.test/")).toBe(
      "  [results] via https://***@c.test/",
    );
    expect(suiteLine("   ")).toBe("");
  });
});

test.describe("outputLine and droppedOutputLine — worker output in its gutter", () => {
  test("a worker's coloured line lands plain, in the gutter", () => {
    expect(outputLine(PIPE, "\u001b[2m[site]\u001b[22m WordPress 7.1")).toBe(
      "  │ [site] WordPress 7.1",
    );
    expect(outputLine(ASCII, "x")).toBe("  | x");
    expect(outputLine(PIPE, "")).toBe("  │");
    expect(bare(outputLine(TTY, "x"))).toBe("  │ x");
  });

  test("never lets an escape through, whatever the worker wrote", () => {
    const hostile =
      "\u001b]0;title\u0007\u001b[2J\u009b31mred\u0000\u001bP+q\u001b\\";
    for (const style of [PIPE, ASCII]) {
      expect(outputLine(style, hostile)).not.toMatch(CONTROL);
      expect(outputLine(style, hostile)).not.toContain("\u001b");
    }
  });

  test("says how many lines were left out, singular and plural, and where a test's are kept", () => {
    expect(droppedOutputLine(PIPE, 1, true)).toBe(
      "  │ … 1 more line of output not shown: the HTML report keeps them",
    );
    expect(droppedOutputLine(ASCII, 7, true)).toBe(
      "  | ... 7 more lines of output not shown: the HTML report keeps them",
    );
    // Output outside any test belongs to no test: no report keeps it.
    expect(droppedOutputLine(PIPE, 3, false)).toBe(
      "  │ … 3 more lines of output not shown",
    );
  });
});

test.describe("beginLine and errorLine", () => {
  test("a begin line carries the current mark, and the attempt past the first", () => {
    expect(beginLine(PIPE, "auth.setup.ts › authenticate")).toBe(
      "▸ auth.setup.ts › authenticate",
    );
    expect(bare(beginLine(TTY, "t"))).toBe("▸ t");
    expect(beginLine(ASCII, "t")).toBe("> t");
    expect(beginLine(PIPE, "t", { number: 1, of: 3 })).toBe("▸ t");
    expect(beginLine(PIPE, "t", { number: 2, of: 3 })).toBe(
      "▸ t · attempt 2/3",
    );
    expect(beginLine(ASCII, "t", { number: 3, of: 3 })).toBe(
      "> t . attempt 3/3",
    );
    expect(beginLine(PIPE, OUTSIDE_TESTS_TITLE)).toBe("▸ outside any test");
  });

  test("an error's first line that says anything, indented, plain and masked", () => {
    expect(
      errorLine(
        PIPE,
        "\n  \nError: \u001b[31mboom\u001b[39m at https://a:b@c.test/\nsecond",
      ),
    ).toBe("  Error: boom at https://***@c.test/");
    expect(errorLine(PIPE, "")).toBeUndefined();
    expect(errorLine(PIPE, "\n\u001b[0m\n")).toBeUndefined();
  });

  test("past a bare label to the line that says something; the label when nothing else does", () => {
    expect(errorLine(PIPE, "Error:\n  the site answered 500")).toBe(
      "  the site answered 500",
    );
    expect(errorLine(PIPE, "TypeError\nx is not a function")).toBe(
      "  x is not a function",
    );
    expect(errorLine(PIPE, "\u001b[31mError:\u001b[39m\n")).toBe("  Error:");
    // A message whose first line has words is kept, label and all.
    expect(errorLine(PIPE, "Error: boom\nmore")).toBe("  Error: boom");
    expect(errorLine(PIPE, "Timeout\nmore")).toBe("  Timeout");
  });
});

test.describe("runErrorLines — an error outside any test", () => {
  test("its first line after the mark, the rest indented, no call log", () => {
    expect(
      runErrorLines(
        PIPE,
        'Error: a spec file does not load\n    at file.js:1\n\nCall log:\n  - <input value="secret"/>',
      ),
    ).toEqual([
      "✘ error Error: a spec file does not load",
      "      at file.js:1",
    ]);
  });

  test("caps the lines it prints and says how many it left", () => {
    const message = [
      "head",
      ...Array.from({ length: 30 }, (_, i) => `l${String(i)}`),
    ].join("\n");
    const lines = runErrorLines(PIPE, message);
    expect(lines).toHaveLength(1 + ERROR_LINES + 1);
    expect(lines.at(-1)).toBe(`  … ${String(30 - ERROR_LINES)} more lines`);
    expect(
      runErrorLines(
        PIPE,
        `head\n${Array(ERROR_LINES + 1)
          .fill("x")
          .join("\n")}`,
      ).at(-1),
    ).toBe("  … 1 more line");
  });

  test("an empty message still says something; a warning drops `Error: `", () => {
    expect(runErrorLines(PIPE, "")).toEqual([
      "✘ error an error with no message",
    ]);
    expect(runErrorLines(ASCII, "Error: No tests found", "warning")).toEqual([
      "! warning No tests found",
    ]);
  });

  test("masks credentials and strips escapes", () => {
    const [line] = runErrorLines(
      PIPE,
      "\u001b[31mError: https://x:pw@h.test/\u001b[0m",
    );
    expect(line).toBe("✘ error Error: https://***@h.test/");
  });
});

test.describe("runHeaderLine", () => {
  const header = {
    product: "backwpup",
    cell: "pro@nginx",
    edition: "pro",
    runId: "2026-10-28T10-00-00-000Z-1",
    requestedRef: "develop",
    scenarios: 12,
  };

  test("a pipe gets the [run] line, every fact in order", () => {
    expect(runHeaderLine(PIPE, header, 80)).toBe(
      "[run] backwpup · pro@nginx (pro) · 2026-10-28T10-00-00-000Z-1 · ref develop · 12 scenarios",
    );
    expect(
      runHeaderLine(ASCII, { product: "p", runId: "r", scenarios: 1 }, 80),
    ).toBe("[run] p . every cell . r . 1 scenario");
  });

  test("a terminal with Unicode gets the same words in a heavy rule as wide as the screen", () => {
    const line = runHeaderLine(
      TTY_NO_COLOR,
      { ...header, requestedRef: undefined },
      80,
    );
    expect(line).toMatch(
      /^━━ backwpup · pro@nginx \(pro\) · 2026-10-28T10-00-00-000Z-1 · 12 scenarios ━+$/,
    );
    expect(Array.from(line)).toHaveLength(80);
    // Bold words, plain glyphs.
    expect(bare(runHeaderLine(TTY, header, 100))).toMatch(
      /^━━ backwpup .* ━+$/,
    );
    expect(runHeaderLine(TTY, header, 100)).toContain("\u001b[1mbackwpup");
  });

  test("a terminal without Unicode keeps the [run] line", () => {
    const style = terminalStyle({ tty: true, color: false, unicode: false });
    expect(runHeaderLine(style, header, 80)).toMatch(
      /^\[run\] backwpup \. pro@nginx/,
    );
  });

  test("the run's words are plain and masked; a blank ref says nothing; a $ in them stays", () => {
    expect(
      runHeaderLine(
        PIPE,
        {
          product: "p",
          cell: "c\u001b[31m",
          runId: "r$&",
          requestedRef: "https://u:pw@git.test/x",
          scenarios: 0,
        },
        80,
      ),
    ).toBe("[run] p · c · r$& · ref https://***@git.test/x · 0 scenarios");
    expect(
      runHeaderLine(PIPE, { ...header, requestedRef: " \u001b[0m " }, 80),
    ).not.toContain("ref");
    expect(bare(runHeaderLine(TTY, { ...header, runId: "a$&b" }, 80))).toMatch(
      /^━━ backwpup · pro@nginx \(pro\) · a\$&b · ref develop · 12 scenarios ━+$/,
    );
  });
});
