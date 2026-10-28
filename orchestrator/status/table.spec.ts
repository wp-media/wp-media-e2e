import { test, expect } from "@playwright/test";

import { displayWidth } from "../../src/common/terminal/layout";
import { createPalette } from "../../src/common/terminal/palette";
import type { Board, TaskState } from "./board";
import { NO_PROGRESS, type RunProgress } from "./progress";
import {
  formatElapsed,
  pickRows,
  progressBar,
  renderTable,
  tableWidth,
  type TableOptions,
} from "./table";

/** Any C0 control or DEL. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The status table: exact lines where they matter, width and height bounds everywhere. */

const UNICODE = createPalette({ tty: false, color: false, unicode: true });
const ASCII = createPalette({ tty: false, color: false, unicode: false });
const T0 = new Date(2026, 9, 13, 10, 0, 0);
/** 18 min 4 s after T0. */
const NOW = new Date(T0.getTime() + 18 * 60_000 + 4_000);

/**
 * A task with a run in flight.
 *
 * @param taskId - the task.
 * @param given - the run's progress.
 * @param extra - the run's id, cell, whether it is stopping.
 */
function running(
  taskId: string,
  given: Partial<RunProgress>,
  extra: { id?: string; cell?: string; stopping?: boolean } = {},
): TaskState {
  return {
    taskId,
    cell: extra.cell ?? "pro@nginx",
    phase: {
      kind: "run",
      run: {
        id: extra.id ?? `${taskId}-12`,
        reportDir: "/r",
        startedAt: T0,
        stopping: extra.stopping ?? false,
        progress: { ...NO_PROGRESS, ...given },
      },
    },
  };
}

/** The plan's example: one task running, one cooling. */
const EXAMPLE: Board = [
  running("bpng", {
    begun: true,
    setups: 2,
    setupsEnded: 2,
    planned: 52,
    done: 38,
    passed: 37,
    failed: 1,
    running: 1,
  }),
  {
    taskId: "bfap",
    cell: "free@nginx",
    phase: { kind: "cooling", nextRunAt: new Date(2026, 9, 13, 11, 14, 42) },
    last: {
      id: "bfap-3",
      status: "passed",
      durationMs: 54 * 60_000 + 10_000,
      scenarios: 52,
    },
  },
];

/**
 * Renders a board.
 *
 * @param board - the board.
 * @param more - options other than the defaults (width 80, no height, Unicode).
 */
function render(board: Board, more: Partial<TableOptions> = {}): string[] {
  return renderTable(board, {
    width: 80,
    palette: UNICODE,
    now: NOW,
    ...more,
  });
}

test.describe("renderTable — the layout", () => {
  test("at 80 columns, the plan's shape exactly", () => {
    expect(render(EXAMPLE)).toEqual([
      "TASK  RUN      CELL        PROGRESS                     ELAPSED  STATE",
      "bpng  bpng-12  pro@nginx   ███████░░░ 38/52 · 1 failed  18m 04s  running",
      "bfap  —        free@nginx  ✔ passed · 52 scenarios      54m 10s  next 11:14:42",
    ]);
  });

  test("narrower, the bar goes first, then ELAPSED, CELL and the counts", () => {
    expect(render(EXAMPLE, { width: 74 })).toEqual([
      "TASK  RUN      CELL        PROGRESS                 ELAPSED  STATE",
      "bpng  bpng-12  pro@nginx   38/52 · 1 failed         18m 04s  running",
      "bfap  —        free@nginx  ✔ passed · 52 scenarios  54m 10s  next 11:14:42",
    ]);
    expect(render(EXAMPLE, { width: 70 })[0]).toBe(
      "TASK  RUN      CELL        PROGRESS                 STATE",
    );
    expect(render(EXAMPLE, { width: 60 })[0]).toBe(
      "TASK  RUN      PROGRESS                 STATE",
    );
    expect(render(EXAMPLE, { width: 50 })).toEqual([
      "TASK  RUN      PROGRESS  STATE",
      "bpng  bpng-12  38/52     running",
      "bfap  —        ✔ passed  next 11:14:42",
    ]);
  });

  test("below 50 columns, one short line per task and no header", () => {
    expect(render(EXAMPLE, { width: 49 })).toEqual([
      "bpng  running  38/52",
      "bfap  next 11:14:42  ✔ passed",
    ]);
    expect(render(EXAMPLE, { width: 20 })).toEqual([
      "bpng  running  38/52",
      "bfap  next 11:14:42…",
    ]);
  });

  for (const width of [20, 40, 49, 50, 80, 120]) {
    test(`at ${String(width)} columns no line is wider, and every task shows`, () => {
      for (const palette of [UNICODE, ASCII]) {
        const lines = render(EXAMPLE, { width, palette });
        expect(lines.length).toBeGreaterThanOrEqual(EXAMPLE.length);
        for (const line of lines)
          expect(displayWidth(line)).toBeLessThanOrEqual(width);
        expect(lines.some((line) => line.startsWith("bpng"))).toBe(true);
        expect(lines.some((line) => line.startsWith("bfap"))).toBe(true);
      }
    });
  }

  test("ASCII spellings when the stream has no Unicode", () => {
    expect(render(EXAMPLE, { palette: ASCII })).toEqual([
      "TASK  RUN      CELL        PROGRESS                     ELAPSED  STATE",
      "bpng  bpng-12  pro@nginx   #######--- 38/52 . 1 failed  18m 04s  running",
      "bfap  -        free@nginx  OK passed . 52 scenarios     54m 10s  next 11:14:42",
    ]);
  });

  test("CJK, emoji and control characters are plain and fit their width", () => {
    const board: Board = [
      running(
        "bpng",
        { begun: true, planned: 3 },
        {
          cell: "バックアップ👍🏽\u001b[31m赤\u0007",
          id: "bpng-1",
        },
      ),
      running(
        "bwide",
        { begun: true, planned: 1 },
        {
          cell: "👨‍👩‍👧‍👦".repeat(20),
        },
      ),
    ];
    for (const width of [20, 40, 49, 50, 80, 120]) {
      const lines = render(board, { width });
      for (const line of lines) {
        expect(displayWidth(line)).toBeLessThanOrEqual(width);
        expect(line).not.toMatch(CONTROL);
      }
    }
    // Plained, not merely stripped of C0: no remnant of the escape is left.
    const plainCell = render(board, { width: 120 })[1] ?? "";
    expect(plainCell).toContain("バックアップ👍🏽赤");
    expect(plainCell).not.toContain("[31m");
    // The cell column is bounded: a long cell is cut with an ellipsis, never pushing STATE off.
    const wide = render(board, { width: 120 });
    expect(wide[2]).toMatch(/…\s+░{10} 0\/1\s+18m 04s\s+running$/);
  });

  test("every state's word", () => {
    const states: [TaskState, string][] = [
      [{ taskId: "aaaa", cell: "c", phase: { kind: "waiting" } }, "starting"],
      [running("aaab", {}), "starting"],
      [
        running("aaac", { begun: true, setups: 2, setupsEnded: 1 }),
        "setup 1/2",
      ],
      [running("aaad", { begun: true, running: 1 }), "running"],
      [running("aaae", { begun: true }, { stopping: true }), "stopping"],
      [{ taskId: "aaaf", cell: "c", phase: { kind: "ended" } }, "ended"],
      [
        { taskId: "aaag", cell: "c", phase: { kind: "over", ended: "once" } },
        "done",
      ],
      [
        {
          taskId: "aaah",
          cell: "c",
          phase: { kind: "over", ended: "stopped" },
        },
        "stopped",
      ],
      [
        { taskId: "aaai", cell: "c", phase: { kind: "over", ended: "failed" } },
        "loop failed",
      ],
    ];
    const lines = render(
      states.map(([task]) => task),
      { width: 120 },
    );
    states.forEach(([, word], i) => {
      expect(lines[i + 1]).toMatch(new RegExp(`  ${word}$`));
    });
  });

  test("a last run's every status is a mark and a word; counts of what did not pass", () => {
    const board: Board = (
      ["error", "killed", "stopped", "failed", "flaky"] as const
    ).map((status, i) => ({
      taskId: `aab${String(i + 2)}`,
      cell: "c",
      phase: { kind: "ended" },
      last: { id: "x", status, scenarios: 1 },
    }));
    const lines = render(board, { width: 120 });
    expect(
      lines.slice(1).map((l) => l.split("  ").filter(Boolean)[3]?.trim()),
    ).toEqual([
      "✘ error · 1 scenario",
      "■ killed · 1 scenario",
      "■ stopped · 1 scenario",
      "✘ failed · 1 scenario",
      "⚠ flaky · 1 scenario",
    ]);
    const counts = render(
      [
        running("bpng", {
          begun: true,
          planned: 9,
          done: 6,
          failed: 2,
          flaky: 1,
          stopped: 3,
        }),
      ],
      { width: 120 },
    );
    expect(counts[1]).toContain("6/9 · 2 failed · 1 flaky · 3 stopped");
  });

  test("before run.begin a run shows a dash, and so does a task with no run yet", () => {
    const lines = render([
      running("bpng", {}),
      { taskId: "bfap", cell: "c", phase: { kind: "waiting" } },
    ]);
    expect(lines[1]).toBe(
      "bpng  bpng-12  pro@nginx  —         18m 04s  starting",
    );
    expect(lines[2]).toBe(
      "bfap  —        c          —               —  starting",
    );
  });

  test("no task, or no line, renders nothing", () => {
    expect(render([])).toEqual([]);
    expect(render(EXAMPLE, { height: 0 })).toEqual([]);
  });
});

test.describe("renderTable — the height", () => {
  /** Twelve tasks: the 5th and 9th running, the others cooling. */
  const MANY: Board = Array.from({ length: 12 }, (_, i) =>
    i === 4 || i === 8
      ? running(`ta${String.fromCharCode(97 + i)}a`, {
          begun: true,
          planned: 2,
        })
      : {
          taskId: `ta${String.fromCharCode(97 + i)}a`,
          cell: "c",
          phase: { kind: "cooling", nextRunAt: T0 },
        },
  );

  test("all fit: every task, in the config's order", () => {
    expect(render(MANY, { height: 13 })).toHaveLength(13);
  });

  test("too short: no header, runs in flight first, then config order, in their places, and `and N more`", () => {
    const lines = render(MANY, { height: 5 });
    expect(lines).toHaveLength(5);
    expect(lines.slice(0, 4).map((l) => l.slice(0, 4))).toEqual([
      "taaa",
      "taba",
      "taea",
      "taia",
    ]);
    expect(lines[4]).toBe("and 8 more");
  });

  test("the header goes before any row: at three lines, two rows and the count", () => {
    expect(render(MANY, { height: 3 })).toEqual([
      expect.stringMatching(/^taea /) as unknown as string,
      expect.stringMatching(/^taia /) as unknown as string,
      "and 10 more",
    ]);
    const four = [...EXAMPLE, ...MANY.slice(0, 2)];
    expect(pickRows(four, 3, true)).toMatchObject({ more: 2, header: false });
    expect(pickRows(four, 3, true)?.rows).toHaveLength(2);
  });

  test("each height from 1 to 14 is kept, at a table's and the compact width", () => {
    for (const width of [40, 80])
      for (let height = 1; height <= 14; height += 1) {
        const lines = render(MANY, { width, height });
        expect(lines.length).toBeLessThanOrEqual(height);
        expect(lines.length).toBeGreaterThan(0);
      }
  });

  test("two lines drop the header; one line is only the count", () => {
    expect(render(MANY, { height: 2 })).toEqual([
      expect.stringMatching(/^taea /) as unknown as string,
      "and 11 more",
    ]);
    expect(render(MANY, { height: 1 })).toEqual(["12 tasks"]);
  });

  test("every row without the header beats some with it", () => {
    expect(render(EXAMPLE, { height: 2 }).map((l) => l.slice(0, 4))).toEqual([
      "bpng",
      "bfap",
    ]);
  });
});

test.describe("renderTable — what it cannot know", () => {
  test("a cell is plain: its invisible characters and its padding dropped, not just its controls", () => {
    const lines = render([
      running(
        "bpng",
        { begun: true, planned: 1 },
        { cell: "  pro\u200b@nginx\t" },
      ),
    ]);
    expect(lines[1]).toMatch(/^bpng {2}bpng-12 {2}pro@nginx {2}/);
  });

  test("an attempt that began no run says so, with its reason's class, never the last run alone", () => {
    const board: Board = [
      {
        taskId: "bpng",
        cell: "pro@nginx",
        phase: {
          kind: "cooling",
          nextRunAt: new Date(2026, 9, 13, 11, 14, 42),
        },
        last: {
          id: "bpng-3",
          status: "passed",
          durationMs: 60_000,
          scenarios: 52,
        },
        notStarted: "failed",
      },
      {
        taskId: "bfap",
        cell: "free@nginx",
        phase: { kind: "over", ended: "stopped" },
        notStarted: "stopped",
      },
    ];
    expect(render(board)).toEqual([
      "TASK  RUN  CELL        PROGRESS                 ELAPSED  STATE",
      "bpng  —    pro@nginx   ✘ not started · failed         —  next 11:14:42",
      "bfap  —    free@nginx  ■ not started · stopped        —  stopped",
    ]);
  });

  test("a stream past the end-of-run reader's cap shows its progress unknown", () => {
    expect(render([running("bpng", { tooLarge: true })])[1]).toBe(
      "bpng  bpng-12  pro@nginx  unknown · results too large  18m 04s  running",
    );
  });
});

test.describe("pickRows", () => {
  test("a height that is not a number bounds nothing; below one line, nothing", () => {
    expect(pickRows(EXAMPLE, NaN, true)?.rows).toHaveLength(2);
    expect(pickRows(EXAMPLE, Infinity, true)?.header).toBe(true);
    expect(pickRows(EXAMPLE, 0.9, true)).toBeUndefined();
    expect(pickRows(EXAMPLE, -Infinity, true)).toBeUndefined();
    expect(pickRows([], 10, true)).toBeUndefined();
  });
});

test.describe("the parts", () => {
  test("tableWidth clamps to 20–120 and floors; not a number is 80", () => {
    expect([NaN, Infinity, 0, 19.9, 49.7, 500].map(tableWidth)).toEqual([
      80, 80, 20, 20, 49, 120,
    ]);
  });

  test("progressBar: ten cells, floored, never more than full; nothing planned is empty", () => {
    expect(progressBar(38, 52, UNICODE)).toBe("███████░░░");
    expect(progressBar(52, 52, UNICODE)).toBe("██████████");
    expect(progressBar(60, 52, UNICODE)).toBe("██████████");
    expect(progressBar(0, 0, UNICODE)).toBe("░░░░░░░░░░");
    expect(progressBar(1, 3, ASCII)).toBe("###-------");
    // Floored: 9.5 cells is 9, never rounded up to a full bar before the end.
    expect(progressBar(19, 20, UNICODE)).toBe("█████████░");
  });

  test("formatElapsed: seconds, minutes and padded seconds, hours and padded minutes", () => {
    expect(
      [
        0,
        -5,
        NaN,
        9_999,
        60_000,
        18 * 60_000 + 4_000,
        3_600_000,
        7_500_000,
      ].map(formatElapsed),
    ).toEqual([
      "0s",
      "0s",
      "0s",
      "9s",
      "1m 00s",
      "18m 04s",
      "1h 00m",
      "2h 05m",
    ]);
  });
});
