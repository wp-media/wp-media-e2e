import { test, expect } from "@playwright/test";

import { displayWidth } from "../src/common/terminal/layout";
import { createPalette } from "../src/common/terminal/palette";
import {
  MIN_MESSAGE_WIDTH,
  styleLine,
  wrapWords,
  type LineStyle,
} from "./line-style";
import { formatLine } from "./log";

/** A fixed local time: 10:15:30. */
const AT = new Date(2026, 9, 13, 10, 15, 30);

/** A palette that marks what it paints, so a spec reads which part got which style. */
const MARKING: LineStyle["palette"] = {
  paint: (token, text) => `<${token}>${text}</>`,
  series: (index, text) => `<${String(index)}>${text}</>`,
};

/**
 * A style for `width` columns, tasks `bpng` then `bfap`.
 *
 * @param width - the terminal's width.
 * @param palette - the palette; {@link MARKING} by default.
 */
function styleOf(
  width: number,
  palette: LineStyle["palette"] = MARKING,
): LineStyle {
  const tasks = ["bpng", "bfap"];
  return {
    palette,
    width,
    scopeIndex: (scope) => {
      const index = tasks.indexOf(scope);
      return index < 0 ? undefined : index;
    },
  };
}

test.describe("styleLine", () => {
  test("dims the time and colours a task's scope by its place; any other scope is unstyled", () => {
    expect(
      styleLine({ at: AT, scope: "bfap", text: "next run" }, styleOf(80)),
    ).toEqual(["<dim>10:15:30</> <1>bfap</>  next run"]);
    expect(
      styleLine(
        { at: AT, scope: "orchestrator", text: "exiting 0" },
        styleOf(80),
      ),
    ).toEqual(["<dim>10:15:30</> orchestrator  exiting 0"]);
  });

  test("with colour off, a line that fits is formatLine's exact text", () => {
    const palette = createPalette({ tty: true, color: false, unicode: true });
    const text = "bpng-1 ✔ passed · 52 scenarios · 54m 10s";
    expect(
      styleLine({ at: AT, scope: "bpng", text }, styleOf(80, palette)),
    ).toEqual([formatLine(AT, "bpng", text)]);
  });

  test("puts an empty line before a line opening a block", () => {
    expect(
      styleLine(
        { at: AT, scope: "bpng", text: "done", opensBlock: true },
        styleOf(80),
      ),
    ).toEqual(["", "<dim>10:15:30</> <0>bpng</>  done"]);
  });

  test("wraps a line wider than the terminal at its spaces, each continuation aligned under the message", () => {
    const words = Array.from({ length: 12 }, (_, i) => `word${String(i)}`);
    const lines = styleLine(
      { at: AT, scope: "bpng", text: words.join(" ") },
      styleOf(40, createPalette({ tty: true, color: false, unicode: true })),
    );
    // "10:15:30 bpng  " is 15 columns: 25 are left for the message.
    expect(lines).toEqual([
      "10:15:30 bpng  word0 word1 word2 word3",
      "               word4 word5 word6 word7",
      "               word8 word9 word10 word11",
    ]);
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(40);
    // Every word once, in order.
    expect(lines.map((line) => line.slice(15)).join(" ")).toBe(words.join(" "));
  });

  test("never breaks a word: a path wider than the room takes a line of its own, whole", () => {
    const path = `.orchestrator/runs/bpng-12/${"x".repeat(60)}/run.log`;
    const lines = styleLine(
      { at: AT, scope: "bpng", text: `bpng-12 started · ${path}` },
      styleOf(50, createPalette({ tty: true, color: false, unicode: true })),
    );
    expect(lines).toEqual([
      "10:15:30 bpng  bpng-12 started ·",
      `               ${path}`,
    ]);
  });

  test("leaves a line whole when its time and scope leave fewer columns than a message needs", () => {
    const scope = "s".repeat(40);
    const text = "a ".repeat(30).trim();
    const style = styleOf(
      9 + 40 + 2 + MIN_MESSAGE_WIDTH - 1,
      createPalette({ tty: true, color: false, unicode: true }),
    );
    expect(styleLine({ at: AT, scope, text }, style)).toEqual([
      `10:15:30 ${scope}  ${text}`,
    ]);
  });

  test("wraps a line whose time and scope leave exactly the columns a message needs", () => {
    const scope = "s".repeat(40);
    const text = "a ".repeat(30).trim();
    const style = styleOf(
      9 + 40 + 2 + MIN_MESSAGE_WIDTH,
      createPalette({ tty: true, color: false, unicode: true }),
    );
    const lines = styleLine({ at: AT, scope, text }, style);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(
        9 + 40 + 2 + MIN_MESSAGE_WIDTH,
      );
  });

  test("measures wide characters by their columns", () => {
    const lines = styleLine(
      {
        at: AT,
        scope: "bpng",
        text: `${"復元".repeat(8)} ${"復元".repeat(8)}`,
      },
      styleOf(50, createPalette({ tty: true, color: false, unicode: true })),
    );
    expect(lines).toHaveLength(2);
    for (const line of lines)
      expect(displayWidth(line)).toBeLessThanOrEqual(50);
  });
});

test.describe("wrapWords", () => {
  test("keeps a text that fits as it is, its spacing included", () => {
    expect(wrapWords("  a  b ", 10)).toEqual(["  a  b "]);
    expect(wrapWords("", 10)).toEqual([""]);
  });

  test("fills each line as far as it fits", () => {
    expect(wrapWords("a bb ccc dddd", 6)).toEqual(["a bb", "ccc", "dddd"]);
    expect(wrapWords("aa bb cc", 5)).toEqual(["aa bb", "cc"]);
  });

  test("drops the empty words of a text it cuts: no line starts or ends with a space, none is empty", () => {
    expect(wrapWords("aaaaa  bbbb", 5)).toEqual(["aaaaa", "bbbb"]);
    expect(wrapWords("aaaa bbbb ", 4)).toEqual(["aaaa", "bbbb"]);
    expect(wrapWords("  aaaa   bbbb  ", 9)).toEqual(["aaaa bbbb"]);
    expect(wrapWords("      ", 3)).toEqual([""]);
  });

  test("gives a word wider than the width a line of its own, whole", () => {
    expect(wrapWords("a abcdefghij b", 4)).toEqual(["a", "abcdefghij", "b"]);
  });

  test("keeps every word, in order, whatever the width", () => {
    const text = "one two  three four five six seven eight nine ten";
    const words = text.split(" ").filter((word) => word !== "");
    for (let width = 1; width <= 60; width++) {
      const lines = wrapWords(text, width);
      expect(
        lines
          .join(" ")
          .split(" ")
          .filter((word) => word !== ""),
      ).toEqual(words);
      for (const line of lines)
        if (line.includes(" "))
          expect(displayWidth(line)).toBeLessThanOrEqual(width);
    }
  });
});
