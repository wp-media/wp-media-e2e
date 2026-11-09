import { test, expect } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  HISTORY_RUN_KEY,
  historyWithRun,
  keepOneLinePerRun,
  readHistoryText,
} from "./allure-history";

/**
 * One trend point per run: the line Allure appends is tagged with the run, and replaces that run's
 * earlier line in its place and time; every other line is kept as it was.
 */

const RUN = "2026-10-22T10-04-03-625Z-26885";

/** A history line, as JSON text with its line end. */
function line(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

test.describe("historyWithRun", () => {
  test("a run's first line is tagged and stays last", () => {
    const before = line({ name: "a", timestamp: 1 });
    const added = line({ name: "b", timestamp: 2 });

    expect(historyWithRun(before, before + added, RUN)).toBe(
      before + line({ name: "b", timestamp: 2, [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("a cell's first history is the one tagged line", () => {
    expect(historyWithRun("", line({ name: "b" }), RUN)).toBe(
      line({ name: "b", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("a run reported again replaces its own line, in its place and with its time", () => {
    const first = line({ name: "x", timestamp: 1, [HISTORY_RUN_KEY]: "r0" });
    const own = line({ name: "old", timestamp: 5, [HISTORY_RUN_KEY]: RUN });
    const later = line({ name: "y", timestamp: 9, [HISTORY_RUN_KEY]: "r2" });
    const before = first + own + later;

    expect(
      historyWithRun(
        before,
        before + line({ name: "new", timestamp: 20 }),
        RUN,
      ),
    ).toBe(
      first +
        line({ name: "new", timestamp: 5, [HISTORY_RUN_KEY]: RUN }) +
        later,
    );
  });

  test("duplicates an older build left are folded into one", () => {
    const own = (name: string, timestamp: number): string =>
      line({ name, timestamp, [HISTORY_RUN_KEY]: RUN });
    const other = line({ name: "o", [HISTORY_RUN_KEY]: "r2" });
    const before = own("a", 3) + other + own("b", 4);

    expect(historyWithRun(before, before + line({ name: "c" }), RUN)).toBe(
      line({ name: "c", [HISTORY_RUN_KEY]: RUN, timestamp: 3 }) + other,
    );
  });

  test("a line without the tag, with another run's, or that does not parse, is kept byte for byte", () => {
    // Same name as the new line, untagged: a line from before tagging, or another run's.
    const untagged = line({ name: "same", timestamp: 1 });
    const garbage = "{ not json\n";
    const array = "[1,2]\n";
    const blank = "\n";
    const latin = `{"name":"Ã©","${HISTORY_RUN_KEY}":"r9"}\n`;
    const before = untagged + garbage + array + blank + latin;

    expect(historyWithRun(before, before + line({ name: "same" }), RUN)).toBe(
      before + line({ name: "same", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("a line whose timestamp is not a number keeps the new one's", () => {
    const own = line({ name: "a", timestamp: "5", [HISTORY_RUN_KEY]: RUN });

    expect(
      historyWithRun(own, own + line({ name: "b", timestamp: 7 }), RUN),
    ).toBe(line({ name: "b", timestamp: 7, [HISTORY_RUN_KEY]: RUN }));
  });

  test("anything but the history plus one JSON object line is left to Allure", () => {
    const before = line({ name: "a" });
    for (const after of [
      // Allure dropped what it was given, or rewrote a line of it before appending its own.
      line({ name: "b" }),
      line({ name: "A" }) + line({ name: "b" }),
      // Nothing, or two lines, or a line without its end, or not an object.
      before,
      before + line({ name: "b" }) + line({ name: "c" }),
      `${before}{"name":"b"}`,
      `${before}[1]\n`,
      `${before}{ broken\n`,
    ]) {
      expect(historyWithRun(before, after, RUN), after).toBeUndefined();
    }
    // A history whose last line has no end: Allure's line would be glued to it.
    expect(
      historyWithRun('{"name":"a"}', '{"name":"a"}{"name":"b"}\n', RUN),
    ).toBeUndefined();
  });
});

test.describe("keepOneLinePerRun", () => {
  let root = "";

  test.beforeEach(() => {
    root = tempRoot("allure-history-");
  });

  test.afterEach(() => {
    removeTempRoot(root);
  });

  test("rewrites the file, every other byte kept, invalid UTF-8 included", async () => {
    const path = join(root, "history.jsonl");
    const odd = Buffer.from([
      0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d, 0x0a,
    ]);
    const own = Buffer.from(
      line({ name: "é", timestamp: 1, [HISTORY_RUN_KEY]: RUN }),
    );
    const before = Buffer.concat([odd, own]);
    writeFileSync(
      path,
      Buffer.concat([before, Buffer.from(line({ name: "é", timestamp: 2 }))]),
    );

    await keepOneLinePerRun(path, before.toString("latin1"), RUN);

    expect(readFileSync(path)).toEqual(
      Buffer.concat([
        odd,
        Buffer.from(line({ name: "é", timestamp: 1, [HISTORY_RUN_KEY]: RUN })),
      ]),
    );
  });

  test("a history it does not recognise is left as Allure wrote it", async () => {
    const path = join(root, "history.jsonl");
    writeFileSync(path, "rewritten by someone else\n");

    await keepOneLinePerRun(path, line({ name: "a" }), RUN);

    expect(readFileSync(path, "utf8")).toBe("rewritten by someone else\n");
  });

  test("readHistoryText: a missing file is an empty history; any other error is thrown", async () => {
    expect(await readHistoryText(join(root, "none.jsonl"))).toBe("");
    await expect(readHistoryText(root)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });
});
