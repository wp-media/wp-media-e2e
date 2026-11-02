import { test, expect } from "@playwright/test";

import type { LiveSegment } from "../../src/common/terminal/live";
import { tableRow, tableRows, type RowStyle } from "./table-rows";
import type { TableLine } from "./table";

/** A palette that marks what it paints, so a spec reads which part got which style. */
const STYLE: RowStyle = {
  palette: {
    paint: (token, text) => `<${token}>${text}</>`,
    series: (index, text) => `<${String(index)}>${text}</>`,
  },
  taskIndex: (taskId) =>
    taskId === "bpng" ? 0 : taskId === "bfap" ? 1 : undefined,
};

/**
 * A row as its segments, each styled: what the region would draw, uncut.
 *
 * @param line - the table line.
 */
function drawn(line: TableLine): string {
  const row = tableRow(line, STYLE);
  if (typeof row === "string") return row;
  return row
    .map((segment: LiveSegment) =>
      segment.style === undefined ? segment.text : segment.style(segment.text),
    )
    .join("");
}

/**
 * A row's plain text: its segments joined.
 *
 * @param line - the table line.
 */
function plainOf(line: TableLine): string {
  const row = tableRow(line, STYLE);
  return typeof row === "string"
    ? row
    : row.map((segment) => segment.text).join("");
}

const PASSED: TableLine = {
  text: "bpng  —       pro@nginx  ✔ passed · 52 scenarios  54m 10s  next 11:14:42",
  kind: "task",
  taskId: "bpng",
  mark: { label: "✔ passed", symbol: "✔", token: "ok" },
};

test.describe("tableRow", () => {
  test("dims the header and the `and N more` line whole", () => {
    expect(drawn({ text: "TASK  RUN", kind: "header" })).toBe(
      "<dim>TASK  RUN</>",
    );
    expect(drawn({ text: "and 3 more", kind: "more" })).toBe(
      "<dim>and 3 more</>",
    );
  });

  test("colours a task's id by its place, and its status mark by its status; the rest stays plain", () => {
    expect(drawn(PASSED)).toBe(
      "<0>bpng</>  —       pro@nginx  <ok>✔</> passed · 52 scenarios  54m 10s  next 11:14:42",
    );
    expect(
      drawn({
        text: "bfap  —  free@nginx  x not started · failed  —  next 11:14:42",
        kind: "task",
        taskId: "bfap",
        mark: { label: "x not started", symbol: "x", token: "fail" },
      }),
    ).toBe(
      "<1>bfap</>  —  free@nginx  <fail>x</> not started · failed  —  next 11:14:42",
    );
  });

  test("finds the mark by its whole label, never a lone symbol in another cell", () => {
    // `x` ends the cell `nginx`: only `x failed` is the mark.
    expect(
      drawn({
        text: "bpng  —  nginx  x failed · 2 scenarios  9s  ended",
        kind: "task",
        taskId: "bpng",
        mark: { label: "x failed", symbol: "x", token: "fail" },
      }),
    ).toBe("<0>bpng</>  —  nginx  <fail>x</> failed · 2 scenarios  9s  ended");
  });

  test("keeps the text exactly: segments joined are the line, whatever is styled", () => {
    const lines: TableLine[] = [
      PASSED,
      { ...PASSED, taskId: "zzzz" },
      { ...PASSED, mark: { label: "■ stopped", symbol: "■", token: "stop" } },
      {
        ...PASSED,
        text: "bpng  bpng-12  pro@nginx  ███░░░░░░░ 3/52  4s  running",
      },
      { ...PASSED, text: "bpn…" },
      { text: "", kind: "task", taskId: "bpng" },
    ];
    for (const line of lines) expect(plainOf(line)).toBe(line.text);
  });

  test("leaves unstyled what it cannot place: an unknown task, a cut id, a mark the cut removed", () => {
    expect(drawn({ ...PASSED, taskId: "zzzz", mark: undefined })).toBe(
      PASSED.text,
    );
    expect(drawn({ ...PASSED, text: "bp…", mark: undefined })).toBe("bp…");
    expect(drawn({ ...PASSED, text: "bpng  —  pro@nginx  ✔ pa…" })).toBe(
      "<0>bpng</>  —  pro@nginx  ✔ pa…",
    );
  });
});

test.describe("tableRows", () => {
  test("gives one row per line, in order", () => {
    const rows = tableRows(
      [
        { text: "TASK", kind: "header" },
        PASSED,
        { text: "and 1 more", kind: "more" },
      ],
      STYLE,
    );
    expect(rows).toHaveLength(3);
  });
});
