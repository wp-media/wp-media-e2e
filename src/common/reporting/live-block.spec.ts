import { test, expect } from "@playwright/test";
import { stripVTControlCharacters } from "node:util";

import { displayWidth } from "../terminal/layout";
import { fitRow, type LiveRow } from "../terminal/live";
import { createPalette } from "../terminal/palette";
import {
  attemptRow,
  BAR_CELLS,
  clockDuration,
  cutSegments,
  finished,
  liveBlockRows,
  MIN_TITLE_WIDTH,
  percent,
  progressBar,
  progressRow,
  type LiveBlockInput,
  type RunningAttempt,
} from "./live-block";
import type { Counts } from "./results";

/**
 * The live block's rows from its facts: the progress row (bar, counts as the summary counts them,
 * running, elapsed), one row per busy worker fitted to the width, the height cap, and styling only
 * through segment styles.
 */

const plainPalette = createPalette({ tty: true, color: false, unicode: true });
const asciiPalette = createPalette({
  tty: false,
  color: false,
  unicode: false,
});
const colourPalette = createPalette({ tty: true, color: true, unicode: true });

/** Counts with every field 0 but those given. */
function counts(partial: Partial<Counts> & { total: number }): Counts {
  const base = {
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    drained: 0,
    ...partial,
  };
  const done =
    base.passed + base.failed + base.flaky + base.skipped + base.interrupted;
  return { ...base, didNotRun: Math.max(0, base.total - done) };
}

/** A row as text, unstyled. */
function text(row: LiveRow): string {
  return typeof row === "string"
    ? row
    : row.map((segment) => segment.text).join("");
}

/** A draw's input: 52 planned, 3 running, 4m 12s in, 100 columns, 20 rows. */
function input(partial: Partial<LiveBlockInput> = {}): LiveBlockInput {
  return {
    counts: counts({ total: 52, passed: 20, flaky: 1, failed: 2 }),
    running: [
      { slot: 2, title: "Backups › Restore", startedAt: 1_000 },
      {
        slot: 0,
        title: "Backups › Download a backup",
        site: "bwu4.example",
        startedAt: 252_000 - 63_000,
      },
      {
        slot: 1,
        title: "Jobs › Run now",
        site: "bwu5.example",
        startedAt: 251_500,
      },
    ],
    startedAt: 0,
    now: 252_000,
    width: 100,
    maxRows: 20,
    palette: plainPalette,
    ...partial,
  };
}

test.describe("clockDuration, percent, finished", () => {
  test("clockDuration reads as a clock: seconds floored, minutes and hours padded", () => {
    expect(clockDuration(0)).toBe("0s");
    expect(clockDuration(999)).toBe("0s");
    expect(clockDuration(59_999)).toBe("59s");
    expect(clockDuration(60_000)).toBe("1m 00s");
    expect(clockDuration(63_900)).toBe("1m 03s");
    expect(clockDuration(3_599_999)).toBe("59m 59s");
    expect(clockDuration(3_600_000)).toBe("1h 00m");
    expect(clockDuration(7_380_000)).toBe("2h 03m");
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY])
      expect(clockDuration(bad)).toBe("0s");
  });

  test("percent floors, so 100 only when every scenario finished; a run of none is 0", () => {
    expect(percent(0, 52)).toBe(0);
    expect(percent(23, 52)).toBe(44);
    expect(percent(51, 52)).toBe(98);
    expect(percent(199, 200)).toBe(99);
    expect(percent(52, 52)).toBe(100);
    expect(percent(60, 52)).toBe(100);
    expect(percent(0, 0)).toBe(0);
  });

  test("finished counts every final status, never what did not run", () => {
    const all = counts({
      total: 10,
      passed: 2,
      failed: 1,
      flaky: 1,
      skipped: 2,
      drained: 1,
      interrupted: 1,
    });
    expect(finished(all)).toBe(7);
    expect(finished(counts({ total: 3 }))).toBe(0);
  });
});

test.describe("progressBar", () => {
  test("ten cells, done first, floored: full only once every scenario finished", () => {
    const bar = (done: number, total: number): string =>
      progressBar(done, total, plainPalette)
        .map((s) => s.text)
        .join("");
    expect(bar(0, 52)).toBe("░".repeat(BAR_CELLS));
    expect(bar(23, 52)).toBe("████░░░░░░");
    expect(bar(51, 52)).toBe("█████████░");
    expect(bar(52, 52)).toBe("█".repeat(BAR_CELLS));
    expect(bar(0, 0)).toBe("░".repeat(BAR_CELLS));
  });

  test("ASCII glyphs where Unicode is off; done cells ok-coloured, the rest dim", () => {
    expect(
      progressBar(5, 10, asciiPalette)
        .map((s) => s.text)
        .join(""),
    ).toBe("#####-----");
    const [done, left] = progressBar(5, 10, colourPalette);
    expect(done?.style?.("x")).toBe("\u001b[32mx\u001b[39m");
    expect(left?.style?.("x")).toBe("\u001b[2mx\u001b[22m");
  });
});

test.describe("progressRow", () => {
  test("the bar, done/total, percent, passed always, other counts when not zero, running, elapsed", () => {
    expect(text(progressRow(input()))).toBe(
      "████░░░░░░ 23/52 · 44% · 20 passed · 1 flaky · 2 failed · 3 running · 4m 12s",
    );
    expect(
      text(progressRow(input({ counts: counts({ total: 4 }), running: [] }))),
    ).toBe("░░░░░░░░░░ 0/4 · 0% · 0 passed · 0 running · 4m 12s");
  });

  test("every final status with the summary's words: skipped and stopped (a drained skip) apart", () => {
    const row = text(
      progressRow(
        input({
          counts: counts({
            total: 9,
            passed: 1,
            flaky: 1,
            failed: 1,
            interrupted: 1,
            skipped: 3,
            drained: 2,
          }),
          width: 120,
        }),
      ),
    );
    expect(row).toContain(
      "7/9 · 77% · 1 passed · 1 flaky · 1 failed · 1 interrupted · 1 skipped · 2 stopped · 3 running",
    );
  });

  test("a narrow width drops the bar, then the running count, then cuts the counts: the time always shows", () => {
    // 76 columns with the bar: 75 drops it, keeping the rest whole down to its 65.
    expect(text(progressRow(input({ width: 75 })))).toBe(
      "23/52 · 44% · 20 passed · 1 flaky · 2 failed · 3 running · 4m 12s",
    );
    expect(text(progressRow(input({ width: 65 })))).toBe(
      "23/52 · 44% · 20 passed · 1 flaky · 2 failed · 3 running · 4m 12s",
    );
    expect(text(progressRow(input({ width: 64 })))).toBe(
      "23/52 · 44% · 20 passed · 1 flaky · 2 failed · 4m 12s",
    );
    expect(text(progressRow(input({ width: 40 })))).toBe(
      "23/52 · 44% · 20 passed · 1 fl… · 4m 12s",
    );
    for (let width = 20; width <= 120; width += 1) {
      const row = text(progressRow(input({ width })));
      expect(displayWidth(row), row).toBeLessThanOrEqual(width);
      expect(row.endsWith(" · 4m 12s"), row).toBe(true);
    }
  });

  test("the bar shows when the row with it is exactly the width", () => {
    const row = text(progressRow(input()));
    expect(displayWidth(row)).toBe(76);
    expect(text(progressRow(input({ width: 76 })))).toBe(row);
  });

  test("cutSegments keeps each segment's style for what stays of it; the ellipsis follows", () => {
    const style = (cut: string): string => `<${cut}>`;
    const cut = cutSegments(
      [{ text: "ab" }, { text: "cdef", style }, { text: "gh" }],
      4,
      "…",
    );
    expect(cut.map((segment) => segment.text)).toEqual(["ab", "c", "…"]);
    expect(cut[1]?.style?.("c")).toBe("<c>");
    expect(cutSegments([{ text: "ab" }], 4, "…")).toEqual([{ text: "ab" }]);
    expect(cutSegments([{ text: "ab" }, { text: "cd" }], 4, "…")).toEqual([
      { text: "ab" },
      { text: "cd" },
    ]);
  });

  test("ASCII separators where Unicode is off", () => {
    expect(text(progressRow(input({ palette: asciiPalette })))).toBe(
      "####------ 23/52 . 44% . 20 passed . 1 flaky . 2 failed . 3 running . 4m 12s",
    );
  });

  test("colour only through segment styles, each status in its token", () => {
    const row = fitRow(
      progressRow(input({ palette: colourPalette })),
      100,
      "…",
    );
    expect(row).toContain("\u001b[32m20 passed\u001b[39m");
    expect(row).toContain("\u001b[33m1 flaky\u001b[39m");
    expect(row).toContain("\u001b[31m2 failed\u001b[39m");
    expect(row).toContain("\u001b[36m3 running\u001b[39m");
    expect(stripVTControlCharacters(row)).toBe(text(progressRow(input())));
  });
});

test.describe("attemptRow", () => {
  const attempt: RunningAttempt = {
    slot: 0,
    title: `Backups › ${"A very long scenario title ".repeat(5)}`,
    site: "bwu4.example.test",
    startedAt: 0,
  };

  test("title, site and elapsed when they fit", () => {
    expect(
      text(
        attemptRow(
          { slot: 0, title: "Backups › Download", site: "bwu4", startedAt: 0 },
          { now: 63_000, width: 80, palette: plainPalette },
        ),
      ),
    ).toBe("  ▸ Backups › Download · bwu4 · 1m 03s");
  });

  test("never wider than the width; the time always whole; the title cut first", () => {
    for (let width = 20; width <= 120; width += 1) {
      const row = text(
        attemptRow(attempt, { now: 63_000, width, palette: plainPalette }),
      );
      expect(displayWidth(row), `width ${String(width)}`).toBeLessThanOrEqual(
        width,
      );
      expect(row.endsWith(" · 1m 03s"), row).toBe(true);
    }
    expect(
      text(attemptRow(attempt, { now: 0, width: 80, palette: plainPalette })),
    ).toBe(
      // 80 columns less the head (4), the site (20) and the time (5): 51 for the title.
      "  ▸ Backups › A very long scenario title A very long s… · bwu4.example.test · 0s",
    );
  });

  test("the site is cut so the title keeps its minimum, and left out when nothing of it fits", () => {
    const at40 = text(
      attemptRow(attempt, { now: 0, width: 40, palette: plainPalette }),
    );
    // 31 columns between head and time: the title keeps 16, the separator 3, the site the other 12.
    expect(at40).toBe("  ▸ Backups › A ver… · bwu4.exampl… · 0s");
    expect(displayWidth("Backups › A ver…")).toBe(MIN_TITLE_WIDTH);
    const at26 = text(
      attemptRow(attempt, { now: 0, width: 26, palette: plainPalette }),
    );
    // 17 columns: one past the title's 16 cannot hold a separator and a site, so the title takes them.
    expect(at26).toBe("  ▸ Backups › A very… · 0s");
    expect(
      text(
        attemptRow(
          {
            slot: 0,
            title: "Short",
            site: "a-very-long-site.example.test",
            startedAt: 0,
          },
          { now: 0, width: 30, palette: plainPalette },
        ),
      ),
    ).toBe("  ▸ Short · a-very-long-… · 0s"); // A short title keeps only its own 5 columns.
  });

  test("a narrow row drops the feature path before it cuts the site or the scenario's name", () => {
    const named: RunningAttempt = {
      slot: 0,
      title: "The live block, end to end › Scenario 07 passes",
      scenario: "Scenario 07 passes",
      site: "site-0.example",
      startedAt: 0,
    };
    const at = (width: number): string =>
      text(attemptRow(named, { now: 1_000, width, palette: plainPalette }));
    expect(at(80)).toBe(
      "  ▸ The live block, end to end › Scenario 07 passes · site-0.example · 1s",
    );
    expect(at(44)).toBe("  ▸ Scenario 07 passes · site-0.example · 1s");
    // Narrower still: the name keeps its first 16 columns before the site is cut.
    expect(at(40)).toBe("  ▸ Scenario 07 pas… · site-0.exam… · 1s");
    // No name given: the title is the name, cut as before.
    expect(
      text(
        attemptRow(
          { ...named, scenario: undefined },
          { now: 1_000, width: 44, palette: plainPalette },
        ),
      ),
    ).toBe("  ▸ The live block, e… · site-0.example · 1s");
  });

  test("eight workers at 40 and 44 columns: every row names its scenario and shows its time", () => {
    const running = Array.from({ length: 8 }, (_, slot) => ({
      slot,
      title: `The live block, end to end › Scenario ${String(slot)} passes`,
      scenario: `Scenario ${String(slot)} passes`,
      site: `site-${String(slot)}-日本.example`,
      startedAt: 0,
    }));
    for (const width of [40, 44]) {
      const rows = liveBlockRows(
        input({ running, width, maxRows: 9, now: 61_000, startedAt: 0 }),
      ).map(text);
      expect(rows).toHaveLength(9);
      expect(rows[0]).toMatch(/ · 1m 01s$/);
      rows.slice(1).forEach((row, slot) => {
        expect(row, row).toMatch(
          new RegExp(
            `▸ Scenario ${String(slot)} pass.* · site-${String(slot)}`,
          ),
        );
        expect(row.endsWith(" · 1m 01s"), row).toBe(true);
        expect(displayWidth(row)).toBeLessThanOrEqual(width);
      });
    }
  });

  test("a site with room for nothing but the cut's mark is left out", () => {
    // 29 columns: 20 between head and time; the title keeps 16, the separator 3, the site 1 — where
    // a wide first character leaves only the mark.
    const row = text(
      attemptRow(
        { ...attempt, site: "日本.example" },
        { now: 0, width: 29, palette: plainPalette },
      ),
    );
    expect(row).toBe("  ▸ Backups › A very lo… · 0s");
  });

  test("no site, or an empty one, shows title and time only", () => {
    for (const site of [undefined, ""]) {
      const shown = text(
        attemptRow(
          {
            slot: 0,
            title: "T",
            ...(site === undefined ? {} : { site }),
            startedAt: 0,
          },
          { now: 1_000, width: 40, palette: plainPalette },
        ),
      );
      expect(shown).toBe("  ▸ T · 1s");
    }
  });
});

test.describe("liveBlockRows", () => {
  test("the progress row, then one row per running attempt in worker order", () => {
    const rows = liveBlockRows(input()).map(text);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatch(/^████░░░░░░ 23\/52/);
    expect(rows.slice(1)).toEqual([
      "  ▸ Backups › Download a backup · bwu4.example · 1m 03s",
      "  ▸ Jobs › Run now · bwu5.example · 0s",
      "  ▸ Backups › Restore · 4m 11s",
    ]);
  });

  test("taller than allowed: the progress row, what fits, then how many more run", () => {
    expect(
      liveBlockRows(input({ maxRows: 3 }))
        .map(text)
        .slice(1),
    ).toEqual([
      "  ▸ Backups › Download a backup · bwu4.example · 1m 03s",
      "  … 2 more running",
    ]);
    expect(
      liveBlockRows(input({ maxRows: 2 }))
        .map(text)
        .slice(1),
    ).toEqual(["  … 3 more running"]);
    expect(liveBlockRows(input({ maxRows: 1 })).map(text)).toHaveLength(1);
    expect(liveBlockRows(input({ maxRows: 0 }))).toEqual([]);
    // Exactly enough room: every row, no "more" row.
    expect(liveBlockRows(input({ maxRows: 4 })).map(text)).toHaveLength(4);
  });

  test("nothing running: the progress row alone", () => {
    expect(liveBlockRows(input({ running: [] })).map(text)).toEqual([
      "████░░░░░░ 23/52 · 44% · 20 passed · 1 flaky · 2 failed · 0 running · 4m 12s",
    ]);
  });

  test("elapsed counts from the run's start, not from the clock's zero", () => {
    const rows = liveBlockRows(input({ startedAt: 200_000, running: [] })).map(
      text,
    );
    expect(rows[0]).toMatch(/ · 52s$/);
  });

  test("a clock that went back shows 0s, never a negative time", () => {
    const rows = liveBlockRows(input({ now: 0 })).map(text);
    expect(rows[0]).toMatch(/ · 0s$/);
    expect(rows[1]).toMatch(/ · 0s$/);
  });
});
