import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  constants,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { endsWithin, stopAtCheck } from "../__fixtures__/allure";
import { openFifoWriter } from "../__fixtures__/fifo";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  AllureGenerationAbortedError,
  AllureReportError,
} from "./allure-errors";
import {
  HISTORY_BOUNDS,
  HISTORY_LIMIT,
  HISTORY_RUN_KEY,
  HISTORY_TAG_BYTES,
  MAX_HISTORY_BYTES,
  MAX_HISTORY_LINE_BYTES,
  historyAfterAllure,
  historyFileLines,
  historyText,
  latin1,
  objectMembers,
  prepareHistory,
  readHistoryText,
  readableLine,
  scanHistory,
  scanHistoryFile,
  settleHistory,
  taggedLine,
  timestampText,
  type HistoryBounds,
  type HistoryScan,
} from "./allure-history";

/**
 * One trend point per run, the newest runs only: the line Allure appends is tagged with the run and
 * replaces that run's earlier line in its place and time; Allure is given only the lines before the
 * run's own; lines Allure cannot read are dropped; every other line is kept byte for byte.
 */

const RUN = "2026-10-22T10-04-03-625Z-26885";

/** A history line as JSON text, without its line end. */
function json(entry: Record<string, unknown>): string {
  return JSON.stringify(entry);
}

/** A history line, as JSON text with its line end. */
function line(entry: Record<string, unknown>): string {
  return `${json(entry)}\n`;
}

/** A line tagged with `run`. */
function tagged(run: string, entry: Record<string, unknown> = {}): string {
  return json({ ...entry, [HISTORY_RUN_KEY]: run });
}

/** The texts of a scan's given lines. */
function givenTexts(scan: HistoryScan): string[] {
  return scan.given.map((entry) => entry.text);
}

/** The texts of a scan's kept lines. */
function keptTexts(scan: HistoryScan): string[] {
  return scan.lines.map((entry) => entry.text);
}

/**
 * A history line one byte too long to read with this line bound: `{"n":"x…"}` of
 * `maxLineBytes + HISTORY_TAG_BYTES + 1` bytes.
 */
function tooLong(maxLineBytes: number): string {
  return `{"n":"${"x".repeat(maxLineBytes + HISTORY_TAG_BYTES + 1 - 8)}"}`;
}

/** Collects a file's lines from their chunks. */
async function collect<T>(chunks: AsyncIterable<readonly T[]>): Promise<T[]> {
  const all: T[] = [];
  for await (const lines of chunks) all.push(...lines);
  return all;
}

test.describe("readableLine", () => {
  test("a JSON object is read with its tag; a CRLF line keeps its CR", () => {
    expect(readableLine(`${tagged("r1", { timestamp: 4 })}\r`)).toEqual({
      text: `${tagged("r1", { timestamp: 4 })}\r`,
      run: "r1",
    });
    expect(
      readableLine(json({ [HISTORY_RUN_KEY]: 7, timestamp: "4" })),
    ).toEqual({
      text: json({ [HISTORY_RUN_KEY]: 7, timestamp: "4" }),
      run: undefined,
    });
    // JSON whitespace before the object is JSON; a no-break space (0xA0) is not.
    expect(readableLine(' \t{"a":1}')?.text).toBe(' \t{"a":1}');
    expect(readableLine('\u00a0{"a":1}')).toBeUndefined();
  });

  test("what Allure cannot read is not a line: not JSON, not an object, blank, or a lone CR inside", () => {
    for (const text of [
      "{ broken",
      "[1,2]",
      "null",
      "5",
      '"s"',
      "",
      "  ",
      '{"a":\r1}',
      '{"a":1}\r\r',
    ]) {
      expect(readableLine(text), JSON.stringify(text)).toBeUndefined();
    }
  });
});

test.describe("scanHistory", () => {
  test("Allure is given the lines before the run's own first line; later lines are kept, not given", () => {
    const before = [json({ n: "a" }), tagged("r0")];
    const own = tagged(RUN, { timestamp: 5 });
    const later = tagged("r2");

    const scan = scanHistory([...before, own, later], RUN);

    expect(givenTexts(scan)).toEqual(before);
    expect(keptTexts(scan)).toEqual([...before, own, later]);
    expect(scan.own).toBe(2);
    expect(scan.dropped).toBe(0);
  });

  test("a run without a line is given every kept line", () => {
    const lines = [json({ n: "a" }), tagged("r2")];

    const scan = scanHistory(lines, RUN);

    expect(scan.own).toBe("absent");
    expect(givenTexts(scan)).toEqual(lines);
    expect(keptTexts(scan)).toEqual(lines);
  });

  test("a line naming the run outside its tag, or tagged with a longer name, is not the run's", () => {
    const decoys = [
      json({ name: RUN, note: `${HISTORY_RUN_KEY}:${RUN}` }),
      tagged(`${RUN}-2`),
    ];

    const scan = scanHistory(decoys, RUN);

    expect(scan.own).toBe("absent");
    expect(givenTexts(scan)).toEqual(decoys);
  });

  test("an older build's duplicate of the run's line is folded into its first", () => {
    const first = tagged(RUN, { timestamp: 3 });
    const other = tagged("r2");

    const scan = scanHistory(
      [first, other, tagged(RUN, { timestamp: 4 })],
      RUN,
    );

    expect(keptTexts(scan)).toEqual([first, other]);
    expect(scan.own).toBe(0);
    expect(givenTexts(scan)).toEqual([]);
  });

  test("unreadable lines are dropped and counted, blank ones silently, too-long ones (null) counted", () => {
    const crlf = `${json({ n: "crlf" })}\r`;

    const scan = scanHistory(
      ["{ broken", "", " \t", "[1]", null, crlf, '{"a":\r1}'],
      RUN,
    );

    expect(keptTexts(scan)).toEqual([crlf]);
    expect(scan.dropped).toBe(4);
  });

  test("keeps the newest lines only; Allure is given at most as many", () => {
    const lines = ["a", "b", "c", "d", "e"].map((n) => json({ n }));

    const absent = scanHistory(lines, RUN, { limit: 3 });
    expect(keptTexts(absent)).toEqual(lines.slice(2));
    expect(givenTexts(absent)).toEqual(lines.slice(2));

    const own = tagged(RUN);
    const late = scanHistory([...lines, own, json({ n: "f" })], RUN, {
      limit: 3,
    });
    expect(keptTexts(late)).toEqual([lines[4], own, json({ n: "f" })]);
    expect(late.own).toBe(1);
    expect(givenTexts(late)).toEqual(lines.slice(2));
  });

  test("a run whose line is older than every kept line is 'older', given the lines before it", () => {
    const lines = ["a", "b"].map((n) => json({ n }));
    const after = ["c", "d", "e"].map((n) => json({ n }));

    const scan = scanHistory([...lines, tagged(RUN), ...after], RUN, {
      limit: 3,
    });

    expect(scan.own).toBe("older");
    expect(keptTexts(scan)).toEqual(after);
    expect(givenTexts(scan)).toEqual(lines);
  });

  test("its default limit is HISTORY_LIMIT", () => {
    const lines = Array.from({ length: HISTORY_LIMIT + 5 }, (_, n) =>
      json({ n }),
    );

    const scan = scanHistory(lines, RUN);

    expect(keptTexts(scan)).toEqual(lines.slice(5));
  });
});

test.describe("scanHistory's byte bound", () => {
  // `{"n":"a"}` and its line end: 10 bytes. 30 written at most, 10 of them kept for Allure's line.
  const bounds: HistoryBounds = { limit: 100, maxBytes: 30, maxLineBytes: 10 };
  const lines = ["a", "b", "c", "d"].map((n) => json({ n }));

  test("the newest lines past the bytes kept go, oldest first, counted", () => {
    const scan = scanHistory(lines, RUN, bounds);

    expect(keptTexts(scan)).toEqual(lines.slice(2));
    expect(givenTexts(scan)).toEqual(lines.slice(2));
    expect(scan.dropped).toBe(2);
    expect(scan.own).toBe("absent");
  });

  test("each line's end counts: a room one byte short of two lines keeps one", () => {
    const scan = scanHistory(lines, RUN, {
      limit: 100,
      maxBytes: 29,
      maxLineBytes: 10,
    });

    expect(keptTexts(scan)).toEqual([lines[3]]);
  });

  test("lines past the line limit go first, uncounted; the bytes then drop no more", () => {
    const scan = scanHistory(lines, RUN, { ...bounds, limit: 2 });

    expect(keptTexts(scan)).toEqual(lines.slice(2));
    expect(scan.dropped).toBe(0);
  });

  test("Allure is given the lines before the run's own within the bytes; the run's line keeps its place among the newest", () => {
    const own = tagged(RUN);
    // Room for the run's line and one short line; the four short ones before it fit on their own.
    const room = own.length + 1 + 10;
    const scan = scanHistory([...lines, own, json({ n: "e" })], RUN, {
      limit: 100,
      maxBytes: room + own.length + 1,
      maxLineBytes: own.length + 1,
    });

    expect(givenTexts(scan)).toEqual(lines);
    expect(keptTexts(scan)).toEqual([own, json({ n: "e" })]);
    expect(scan.own).toBe(0);
    expect(scan.dropped).toBe(4);
  });

  test("the newest line is kept even when the room holds none", () => {
    const scan = scanHistory(lines, RUN, {
      limit: 100,
      maxBytes: 5,
      maxLineBytes: 10,
    });

    expect(keptTexts(scan)).toEqual([lines[3]]);
    expect(scan.dropped).toBe(3);
  });

  test("a run's line the bytes pushed out is 'older'", () => {
    const scan = scanHistory([tagged(RUN), ...lines], RUN, bounds);

    expect(scan.own).toBe("older");
    expect(givenTexts(scan)).toEqual([]);
  });

  test("the defaults: a line far above a run's (~180 KB), the newest line always fits", () => {
    expect(HISTORY_BOUNDS).toEqual({
      limit: HISTORY_LIMIT,
      maxBytes: MAX_HISTORY_BYTES,
      maxLineBytes: MAX_HISTORY_LINE_BYTES,
    });
    expect(MAX_HISTORY_LINE_BYTES).toBeGreaterThanOrEqual(8 * 1024 * 1024);
    // Room for the lines read and for Allure's: at least one longest line each.
    expect(MAX_HISTORY_BYTES).toBeGreaterThanOrEqual(
      2 * MAX_HISTORY_LINE_BYTES,
    );
    // Far under V8's string limit (2^29 - 24 one-byte characters), so joining them never fails.
    expect(MAX_HISTORY_BYTES).toBeLessThan(2 ** 29 / 4);
  });
});

test.describe("historyAfterAllure", () => {
  test("a run's first line is tagged and goes last", () => {
    const before = json({ name: "a", timestamp: 1 });
    const scan = scanHistory([before], RUN);

    expect(
      historyAfterAllure(scan, RUN, line({ name: "b", timestamp: 2 })),
    ).toEqual([before, tagged(RUN, { name: "b", timestamp: 2 })]);
  });

  test("a cell's first history is the one tagged line", () => {
    const scan = scanHistory([], RUN);

    expect(historyAfterAllure(scan, RUN, line({ name: "b" }))).toEqual([
      tagged(RUN, { name: "b" }),
    ]);
  });

  test("a run reported again replaces its own line, in its place and with its time", () => {
    const first = tagged("r0", { name: "x", timestamp: 1 });
    const later = tagged("r2", { name: "y", timestamp: 9 });
    const scan = scanHistory(
      [first, tagged(RUN, { name: "old", timestamp: 5 }), later],
      RUN,
    );

    expect(
      historyAfterAllure(scan, RUN, line({ name: "new", timestamp: 20 })),
    ).toEqual([
      first,
      json({ name: "new", timestamp: 5, [HISTORY_RUN_KEY]: RUN }),
      later,
    ]);
  });

  test("a line whose timestamp is not a number keeps the new one's", () => {
    const scan = scanHistory([tagged(RUN, { name: "a", timestamp: "5" })], RUN);

    expect(
      historyAfterAllure(scan, RUN, line({ name: "b", timestamp: 7 })),
    ).toEqual([tagged(RUN, { name: "b", timestamp: 7 })]);
  });

  test("the earlier time is kept as written: no number round trip turns it into null or rounds it", () => {
    for (const time of ["1e400", "12345678901234567890", "-0.50", "1E+3"]) {
      const scan = scanHistory(
        [`{"timestamp":${time},"e2eRun":"${RUN}"}`],
        RUN,
      );

      expect(
        historyAfterAllure(scan, RUN, line({ name: "b", timestamp: 7 })),
        time,
      ).toEqual([`{"name":"b","timestamp":${time},"e2eRun":"${RUN}"}`]);
    }
  });

  test("an unterminated appended line is still the run's line", () => {
    const scan = scanHistory([], RUN);

    expect(historyAfterAllure(scan, RUN, json({ name: "b" }))).toEqual([
      tagged(RUN, { name: "b" }),
    ]);
  });

  test("the run's earlier line is never lost when Allure appended nothing usable or kept nothing of what it was given", () => {
    const own = tagged(RUN, { name: "first", timestamp: 5 });
    const other = tagged("r2");
    const scan = scanHistory([own, other], RUN);

    for (const appended of [
      undefined,
      "",
      "[1]\n",
      "{ broken\n",
      // Valid JSON, but Allure's line reader splits it at the CR.
      '{"a":\r1}\n',
    ]) {
      expect(historyAfterAllure(scan, RUN, appended), appended).toEqual([
        own,
        other,
      ]);
    }
  });

  test("lines Allure appended beyond one are kept as they are, readable ones only, after the cell's", () => {
    const own = tagged(RUN, { name: "first", timestamp: 5 });
    const scan = scanHistory([own], RUN);

    expect(
      historyAfterAllure(
        scan,
        RUN,
        line({ name: "b" }) + "{ broken\n" + line({ name: "c" }),
      ),
    ).toEqual([own, json({ name: "b" }), json({ name: "c" })]);
  });

  test("a run whose line is older than every kept one stays out", () => {
    const after = ["c", "d"].map((n) => json({ n }));
    const scan = scanHistory([tagged(RUN), ...after], RUN, { limit: 2 });

    expect(historyAfterAllure(scan, RUN, line({ name: "b" }), 2)).toEqual(
      after,
    );
  });

  test("keeps the newest lines: the oldest go once the run's line is added", () => {
    const lines = ["a", "b", "c"].map((n) => json({ n }));
    const scan = scanHistory(lines, RUN, { limit: 3 });

    expect(historyAfterAllure(scan, RUN, line({ name: "d" }), 3)).toEqual([
      lines[1],
      lines[2],
      tagged(RUN, { name: "d" }),
    ]);
  });
});

test.describe("taggedLine and objectMembers", () => {
  test("Allure's bytes are kept: an escape stays an escape, numbers and spacing as written", () => {
    const allure = '{ "n" : "\\u2603 ☃", "v": 1.50, "timestamp" : 9 }';

    expect(taggedLine(allure, RUN, "5")).toBe(
      `{ "n" : "\\u2603 ☃", "v": 1.50, "timestamp" : 5 ,"e2eRun":"${RUN}"}`,
    );
    expect(taggedLine(allure, RUN, undefined)).toBe(
      `{ "n" : "\\u2603 ☃", "v": 1.50, "timestamp" : 9 ,"e2eRun":"${RUN}"}`,
    );
  });

  test("a tag or time already there is replaced, never repeated, wherever it is", () => {
    expect(taggedLine('{"e2eRun":"old","timestamp":1,"n":2}', "r", "7")).toBe(
      '{"e2eRun":"r","timestamp":7,"n":2}',
    );
    // An escaped key is the same key.
    expect(taggedLine('{"e2e\\u0052un":"old"}', "r", undefined)).toBe(
      '{"e2e\\u0052un":"r"}',
    );
    // Allure's own duplicates: JSON.parse reads the last, so every one is set.
    expect(taggedLine('{"timestamp":1,"timestamp":2}', "r", "7")).toBe(
      '{"timestamp":7,"timestamp":7,"e2eRun":"r"}',
    );
  });

  test("an empty object gets the members alone; a closing CR is dropped; the result is valid JSON", () => {
    expect(taggedLine("{}", "r", "3")).toBe('{"e2eRun":"r","timestamp":3}');
    expect(taggedLine(" { } \r", "r", undefined)).toBe(' { "e2eRun":"r"} ');
    for (const text of [
      '{"a":{"timestamp":1},"b":[1,{"e2eRun":"x"}]}',
      '{"s":"}\\",{"}',
    ]) {
      const tagged = taggedLine(text, "r", "4");
      expect(JSON.parse(tagged), text).toEqual({
        ...(JSON.parse(text) as object),
        e2eRun: "r",
        timestamp: 4,
      });
    }
  });

  test("a run's non-ASCII name goes in as its UTF-8 bytes", () => {
    const run = "run·é";
    const line = taggedLine('{"n":1}', latin1(run), undefined);

    expect(Buffer.from(line, "latin1").toString("utf8")).toBe(
      `{"n":1,"e2eRun":"${run}"}`,
    );
  });

  test("timestampText: the last top-level timestamp's text when it is a number, as written", () => {
    expect(timestampText('{"timestamp":1e400}')).toBe("1e400");
    expect(timestampText('{"timestamp" : 12345678901234567890 }\r')).toBe(
      "12345678901234567890",
    );
    expect(timestampText('{"timestamp":-5}')).toBe("-5");
    // JSON.parse keeps the last of duplicates.
    expect(timestampText('{"timestamp":1,"timestamp":2}')).toBe("2");
    expect(timestampText('{"timestamp":1,"timestamp":"2"}')).toBeUndefined();
    for (const text of [
      "{}",
      '{"timestamp":"5"}',
      '{"timestamp":null}',
      '{"timestamp":[1]}',
      '{"a":{"timestamp":1}}',
    ]) {
      expect(timestampText(text), text).toBeUndefined();
    }
  });

  test("objectMembers: only top-level members, values without their spacing, nested ones and strings skipped", () => {
    const text = '{ "a" : [1,"]",{"b":2}]\t, "c":{"d":"}"},"e\\"":\t"x" }';
    const { members, close } = objectMembers(text);

    expect(
      members.map(({ key, start, end }) => [key, text.slice(start, end)]),
    ).toEqual([
      ["a", '[1,"]",{"b":2}]'],
      ["c", '{"d":"}"}'],
      ['e"', '"x"'],
    ]);
    expect(close).toBe(text.length - 1);
    expect(objectMembers("{}")).toEqual({ members: [], close: 1 });
    expect(() => objectMembers('{"a":1')).toThrow(RangeError);
  });
});

test.describe("historyFileLines", () => {
  let root = "";

  test.beforeEach(() => {
    root = tempRoot("allure-history-");
  });

  test.afterEach(() => {
    removeTempRoot(root);
  });

  test("streams every non-empty line as latin1, CRs and invalid UTF-8 kept, an unterminated last line included", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(
      path,
      Buffer.concat([
        Buffer.from("a\r\n\n"),
        Buffer.from([0xff, 0xfe, 0x0a]),
        Buffer.from("é\nlast"),
      ]),
    );

    expect(await collect(historyFileLines(path))).toEqual([
      "a\r",
      "ÿþ",
      "Ã©",
      "last",
    ]);
  });

  test("a line ending exactly at a chunk's end is one line, its line end in the next chunk", async () => {
    const path = join(root, "h.jsonl");
    // The stream's chunks are 64 KiB: this line's `\n` is the second chunk's first byte.
    const long = "x".repeat(64 * 1024);
    writeFileSync(path, `${long}\nb\n`);

    expect(await collect(historyFileLines(path))).toEqual([long, "b"]);
  });

  test("a line across the stream's chunks is one line", async () => {
    const path = join(root, "h.jsonl");
    // Non-ASCII and invalid UTF-8 bytes on both sides of a chunk's end: still one byte a character.
    const bytes = Buffer.concat([
      Buffer.alloc(200_000, "x"),
      Buffer.from([0xff, 0xc3, 0xa9]),
    ]);
    bytes[65_535] = 0xc3;
    bytes[65_536] = 0xa9;
    writeFileSync(path, Buffer.concat([bytes, Buffer.from("\nb\n")]));

    expect(await collect(historyFileLines(path))).toEqual([
      bytes.toString("latin1"),
      "b",
    ]);
  });

  test("a line longer than the limit is null, unread; the lines after it are read", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(
      path,
      `${"x".repeat(9)}\n${"y".repeat(8)}\nz\n${"w".repeat(9)}`,
    );

    expect(await collect(historyFileLines(path, 8))).toEqual([
      null,
      "y".repeat(8),
      "z",
      null,
    ]);
  });

  test("a line across chunks is kept at exactly the limit, null one byte past it", async () => {
    const path = join(root, "h.jsonl");
    // 70,000 bytes: past the stream's 64 KiB chunk, so the line is gathered across two.
    const at = "x".repeat(70_000);
    writeFileSync(path, `${at}\n${at}y\nz\n`);

    expect(await collect(historyFileLines(path, 70_000))).toEqual([
      at,
      null,
      "z",
    ]);
  });

  test("a file past V8's string limit is read line by line: a huge line costs nothing to drop", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(path, line({ n: "a" }));
    // Sparse: 600 MiB of zero bytes after the first line, no newline — more than one string holds.
    truncateSync(path, 600 * 1024 * 1024);

    expect(await collect(historyFileLines(path, 1024))).toEqual([
      json({ n: "a" }),
      null,
    ]);
    const scan = await prepareHistory(path, join(root, "work.jsonl"), RUN);
    expect(scan.dropped).toBe(1);
    expect(keptTexts(scan)).toEqual([json({ n: "a" })]);
  });

  test("a file it may not open is an error, not an empty history", async () => {
    test.skip(process.getuid?.() === 0, "root opens any file");
    const path = join(root, "h.jsonl");
    writeFileSync(path, line({ n: "a" }));
    chmodSync(path, 0o000);

    await expect(collect(historyFileLines(path))).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  test("a missing file has no lines; any other error is thrown", async () => {
    expect(await collect(historyFileLines(join(root, "none")))).toEqual([]);
    await expect(collect(historyFileLines(root))).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  test("lines come a chunk at a time, split as one array each, never one by one", async () => {
    const path = join(root, "h.jsonl");
    // 64 KiB chunks: two of them, of 2-byte lines.
    writeFileSync(path, "x\n".repeat(64 * 1024));

    let batches = 0;
    let lines = 0;
    for await (const batch of historyFileLines(path)) {
      batches += 1;
      lines += batch.length;
    }
    expect(lines).toBe(64 * 1024);
    expect(batches).toBeLessThanOrEqual(3);
  });

  test("20 MiB of short lines scan in seconds (one async step per line took ~35 s)", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(path, "\n \n".repeat(5 * 1024 * 1024) + line({ n: "a" }));
    const started = Date.now();

    const scan = await scanHistoryFile(path, RUN);

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(keptTexts(scan)).toEqual([json({ n: "a" })]);
    expect(scan.dropped).toBe(0);
  });
});

test.describe("scanHistoryFile's stop, and what it does not read", () => {
  let root = "";

  test.beforeEach(() => {
    root = tempRoot("allure-history-");
  });

  test.afterEach(() => {
    removeTempRoot(root);
  });

  /** A FIFO: a blocking open of it waits for a writer, a blocking read for the writer's bytes. */
  function fifo(): string {
    const path = join(root, "history.fifo");
    expect(spawnSync("mkfifo", [path]).status).toBe(0);
    return path;
  }

  test("a stop before the read never opens the file", async () => {
    // A folder: opened and read, it would fail with EISDIR instead.
    await expect(
      scanHistoryFile(root, RUN, { signal: AbortSignal.abort() }),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("a stop ends the read as the next chunk arrives: the rest of the file is not read", async () => {
    const path = join(root, "h.jsonl");
    // Four 64 KiB chunks of lines.
    writeFileSync(path, line({ n: "x".repeat(100) }).repeat(2_200));
    // Checked before the open (1), as the first chunk arrives (2), as the second does (3).
    const stop = stopAtCheck(3);

    await expect(
      scanHistoryFile(path, RUN, { signal: stop.signal }),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);
    expect(stop.checks()).toBe(3);
  });

  test("a stop while the last chunk is read is noticed once the file ends", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(path, line({ n: "a" }));
    // Before the open (1), its one chunk (2), then the end of the file (3).
    const stop = stopAtCheck(3);

    await expect(
      scanHistoryFile(path, RUN, { signal: stop.signal }),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("a FIFO is not read, so nothing can hold the scan: with no writer it is one dropped line", async () => {
    const path = fifo();

    const scan = await endsWithin(scanHistoryFile(path, RUN), "the scan");

    expect(scan).toEqual({ lines: [], own: "absent", given: [], dropped: 1 });
    expect(await collect(historyFileLines(path))).toEqual([null]);
    // Closed, not left to the garbage collector: no reader holds the FIFO for a writer to open.
    await expect(openFifoWriter(path, 100)).rejects.toThrow(
      "Nothing opened the FIFO",
    );
  });

  test("a FIFO with a writer is not read either: its bytes are left unread", async () => {
    const path = fifo();
    // A reader of the spec's own lets the writer open; the scan's must not consume what it writes.
    const reader = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const writer = await openFifoWriter(path);
    try {
      await writer.write(line({ n: "a" }));

      const scan = await endsWithin(scanHistoryFile(path, RUN), "the scan");

      expect(scan.dropped).toBe(1);
      expect(scan.lines).toEqual([]);
      expect((await reader.read(Buffer.alloc(64), 0, 64)).bytesRead).toBe(
        line({ n: "a" }).length,
      );
    } finally {
      await writer.close();
      await reader.close();
    }
  });
});

test.describe("prepareHistory and settleHistory", () => {
  let root = "";

  test.beforeEach(() => {
    root = tempRoot("allure-history-");
  });

  test.afterEach(() => {
    removeTempRoot(root);
  });

  let calls = 0;

  /** Runs prepare, then `allure` (a function writing the work copy), then settle. */
  async function generate(
    cell: Buffer | string | undefined,
    allure: (given: string | undefined) => Buffer | string | undefined,
    run: string = RUN,
    bounds: Partial<HistoryBounds> = {},
  ): Promise<{
    given: string | undefined;
    after: Buffer;
    scan: HistoryScan;
    settled: number;
  }> {
    // Each call its own files: a test may generate twice.
    calls += 1;
    const history = join(root, `cell-${String(calls)}.jsonl`);
    const work = join(root, `work-${String(calls)}.jsonl`);
    if (cell !== undefined) writeFileSync(history, cell);
    const scan = await prepareHistory(history, work, run, bounds);
    const given = existsSync(work) ? readFileSync(work, "latin1") : undefined;
    const wrote = allure(given);
    if (wrote !== undefined) writeFileSync(work, wrote);
    const settled = await settleHistory(work, scan, run, bounds);
    return { given, after: readFileSync(work), scan, settled };
  }

  test("Allure is given the lines before the run's own; its line goes back in the run's place and time", async () => {
    const before = line({ n: "a" });
    const later = line({ n: "b", [HISTORY_RUN_KEY]: "r2" });
    const cell =
      before + line({ n: "old", timestamp: 5, [HISTORY_RUN_KEY]: RUN }) + later;

    const { given, after } = await generate(
      cell,
      (text) => `${text ?? ""}${line({ n: "new", timestamp: 9 })}`,
    );

    expect(given).toBe(before);
    expect(after.toString("utf8")).toBe(
      before + line({ n: "new", timestamp: 5, [HISTORY_RUN_KEY]: RUN }) + later,
    );
  });

  test("a cell with no history, or only the run's line, gives Allure no file", async () => {
    expect(
      (await generate(undefined, () => line({ n: "b" }))).given,
    ).toBeUndefined();
    const { given, after } = await generate(
      line({ n: "a", timestamp: 1, [HISTORY_RUN_KEY]: RUN }),
      () => line({ n: "b" }),
    );
    expect(given).toBeUndefined();
    expect(after.toString("utf8")).toBe(
      line({ n: "b", [HISTORY_RUN_KEY]: RUN, timestamp: 1 }),
    );
  });

  test("other runs' lines come back byte for byte: non-ASCII and invalid UTF-8 included", async () => {
    const odd = Buffer.from([
      0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d, 0x0a,
    ]);
    const named = Buffer.from(
      line({ name: "BackWPup · pro@nginx", [HISTORY_RUN_KEY]: "r9" }),
    );
    const cell = Buffer.concat([odd, named]);

    const { given, after } = await generate(cell, (text) =>
      Buffer.concat([
        Buffer.from(text ?? "", "latin1"),
        Buffer.from(line({ name: "é" })),
      ]),
    );

    expect(given).toBe(cell.toString("latin1"));
    expect(after).toEqual(
      Buffer.concat([
        cell,
        Buffer.from(line({ name: "é", [HISTORY_RUN_KEY]: RUN })),
      ]),
    );
  });

  test("Allure's line keeps its bytes: an escape such as \\u2603 is not turned into a character", async () => {
    const appended = '{"n":"\\u2603 \\u00e9","timestamp":9}\n';

    const { after } = await generate(undefined, () => appended);

    expect(after.toString("latin1")).toBe(
      `{"n":"\\u2603 \\u00e9","timestamp":9,"e2eRun":"${RUN}"}\n`,
    );
    expect(JSON.parse(after.toString("utf8"))).toMatchObject({ n: "☃ é" });
  });

  test("a run with a non-ASCII name is recognised and tagged by its UTF-8 bytes", async () => {
    const run = "run·é";
    const other = line({ n: "o" });
    const cell = Buffer.from(
      other + line({ n: "a", timestamp: 2, [HISTORY_RUN_KEY]: run }),
    );

    const { given, after } = await generate(
      cell,
      (text) =>
        Buffer.concat([
          Buffer.from(text ?? "", "latin1"),
          Buffer.from(line({ n: "b" })),
        ]),
      run,
    );

    expect(latin1(run)).not.toBe(run);
    expect(given).toBe(other);
    expect(after.toString("utf8")).toBe(
      other + line({ n: "b", [HISTORY_RUN_KEY]: run, timestamp: 2 }),
    );
  });

  test("Allure appending nothing keeps the cell's history, the run's earlier line in its place", async () => {
    const cell =
      line({ n: "first", timestamp: 5, [HISTORY_RUN_KEY]: RUN }) +
      line({ n: "o" });

    const { after } = await generate(cell, () => undefined);

    expect(after.toString("utf8")).toBe(cell);
  });

  test("Allure rewriting what it was given keeps the cell's history", async () => {
    const cell =
      line({ n: "o" }) + line({ n: "first", [HISTORY_RUN_KEY]: RUN });

    const { after } = await generate(
      cell,
      () => line({ n: "O" }) + line({ n: "b" }),
    );

    expect(after.toString("utf8")).toBe(cell);
  });

  test("unreadable lines are dropped and counted; an unterminated last line is given terminated", async () => {
    const kept = line({ n: "a" });
    const cell = `{ broken\n${kept}\n[1]\n${json({ n: "last" })}`;

    const { given, after, scan } = await generate(
      cell,
      (text) => `${text ?? ""}${line({ n: "b" })}`,
    );

    expect(scan.dropped).toBe(2);
    expect(given).toBe(kept + line({ n: "last" }));
    expect(after.toString("utf8")).toBe(
      kept + line({ n: "last" }) + line({ n: "b", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("a history past the limit is cut to the newest lines, the run's last", async () => {
    const lines = Array.from({ length: HISTORY_LIMIT + 4 }, (_, n) =>
      line({ n }),
    );

    const { given, after } = await generate(
      lines.join(""),
      (text) => `${text ?? ""}${line({ n: "run" })}`,
    );

    expect(given).toBe(lines.slice(4).join(""));
    expect(after.toString("utf8")).toBe(
      lines.slice(5).join("") + line({ n: "run", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("a history no generation could read is replaced by a bounded one: long lines dropped, the oldest past the bytes", async () => {
    const bounds = { limit: 100, maxBytes: 48, maxLineBytes: 16 };
    const kept = ["c", "d"].map((n) => line({ n }));
    const cell =
      line({ n: "a" }) +
      `${tooLong(bounds.maxLineBytes)}\n` +
      line({ n: "b" }) +
      kept.join("");

    const history = join(root, "cell.jsonl");
    const work = join(root, "work.jsonl");
    writeFileSync(history, cell);
    const scan = await prepareHistory(history, work, RUN, bounds);
    // Room for 32 bytes: the newest three short lines; the long one and "a" dropped.
    expect(readFileSync(work, "latin1")).toBe(line({ n: "b" }) + kept.join(""));
    expect(scan.dropped).toBe(2);

    writeFileSync(work, `${readFileSync(work, "latin1")}${line({ n: "run" })}`);
    await settleHistory(work, scan, RUN, bounds);
    const after = readFileSync(work, "latin1");
    expect(after).toBe(
      line({ n: "b" }) +
        kept.join("") +
        line({ n: "run", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("the file's lines past the line bound are dropped though the bytes have room; the line limit holds after Allure's", async () => {
    const bounds = { limit: 2, maxBytes: 200, maxLineBytes: 16 };
    const long = tooLong(bounds.maxLineBytes);
    const cell = line({ n: "a" }) + `${long}\n` + line({ n: "b" });

    const { given, after, scan } = await generate(
      cell,
      (text) => `${text ?? ""}${line({ n: "c" })}`,
      RUN,
      bounds,
    );

    expect(long.length).toBe(16 + HISTORY_TAG_BYTES + 1);
    expect(scan.dropped).toBe(1);
    expect(given).toBe(line({ n: "a" }) + line({ n: "b" }));
    expect(after.toString("latin1")).toBe(
      line({ n: "b" }) + line({ n: "c", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("Allure's line is read up to the line bound and its line end; one byte more is not read, counted, the history kept", async () => {
    const bounds = { limit: 100, maxBytes: 64, maxLineBytes: 16 };
    const cell = line({ n: "a" });
    /** Generates with Allure appending `{"n":"x…"}` of `length` bytes and its line end. */
    const appending = (length: number): ReturnType<typeof generate> =>
      generate(
        cell,
        (text) => `${text ?? ""}{"n":"${"x".repeat(length - 8)}"}\n`,
        RUN,
        bounds,
      );

    const fits = await appending(16);
    expect(fits.after.toString("latin1")).toBe(
      cell + line({ n: "x".repeat(8), [HISTORY_RUN_KEY]: RUN }),
    );
    expect(fits.settled).toBe(0);

    for (const length of [17, 24]) {
      const over = await appending(length);
      expect(over.after.toString("latin1"), String(length)).toBe(cell);
      expect(over.settled, String(length)).toBe(1);
    }
  });

  test("Allure's longest line, once tagged, is read again by the next generation: one point, nothing dropped", async () => {
    const bounds = { limit: 100, maxBytes: 4096, maxLineBytes: 16 };
    const allure = `{"n":"${"x".repeat(8)}"}`;
    const first = await generate(
      line({ n: "a" }),
      (text) => `${text ?? ""}${allure}\n`,
      RUN,
      bounds,
    );
    expect(allure.length).toBe(16);

    const again = await generate(
      first.after,
      (text) => `${text ?? ""}${line({ n: "b" })}`,
      RUN,
      bounds,
    );

    expect(again.scan.dropped).toBe(0);
    expect(again.scan.own).toBe(1);
    expect(again.settled).toBe(0);
    expect(again.after.toString("latin1")).toBe(
      line({ n: "a" }) + line({ n: "b", [HISTORY_RUN_KEY]: RUN }),
    );
  });

  test("by default a line read is far past the tag's room: the bounds default for the line too", async () => {
    const history = join(root, "cell.jsonl");
    const long = json({ n: "x".repeat(4 * HISTORY_TAG_BYTES) });
    writeFileSync(history, `${long}\n`);

    const scan = await scanHistoryFile(history, RUN, { limit: 5 });

    expect(keptTexts(scan)).toEqual([long]);
    expect(scan.dropped).toBe(0);
  });

  test("a line read may be the tag's room longer than the line bound, not a byte more", async () => {
    const bounds = { limit: 100, maxBytes: 4096, maxLineBytes: 16 };
    const longest = `{"n":"${"x".repeat(16 + HISTORY_TAG_BYTES - 8)}"}`;
    const history = join(root, "cell.jsonl");
    writeFileSync(history, `${longest}\n${tooLong(bounds.maxLineBytes)}\n`);

    const scan = await scanHistoryFile(history, RUN, bounds);

    expect(longest.length).toBe(16 + HISTORY_TAG_BYTES);
    expect(keptTexts(scan)).toEqual([longest]);
    expect(scan.dropped).toBe(1);
  });

  test("a tagged line too long for the next read is not written: dropped and counted; one at the bound is kept", async () => {
    const cell = line({ n: "a" });
    /** Generates with Allure appending `{"n":"b"}`, tagged `{"n":"b","e2eRun":"<run>"}`: 21 + its bytes. */
    const tagging = (run: string): ReturnType<typeof generate> =>
      generate(cell, (text) => `${text ?? ""}${line({ n: "b" })}`, run, {
        maxLineBytes: 16,
      });

    const over = await tagging("r".repeat(16 + HISTORY_TAG_BYTES - 21 + 1));
    expect(over.after.toString("latin1")).toBe(cell);
    expect(over.settled).toBe(1);

    const run = "r".repeat(16 + HISTORY_TAG_BYTES - 21);
    const at = await tagging(run);
    expect(at.after.toString("latin1")).toBe(
      cell + line({ n: "b", [HISTORY_RUN_KEY]: run }),
    );
    expect(json({ n: "b", [HISTORY_RUN_KEY]: run }).length).toBe(
      16 + HISTORY_TAG_BYTES,
    );
    expect(at.settled).toBe(0);
  });

  test("a history of lines past the line bound, larger than V8's string limit, is read and replaced", async () => {
    const history = join(root, "cell.jsonl");
    const lineBytes = 60 * 1024 * 1024;
    // Sparse: nine 60 MiB lines of zero bytes between two real ones, ~540 MiB not on disk.
    writeFileSync(history, line({ n: "a" }));
    const fd = openSync(history, "r+");
    try {
      for (let n = 1; n <= 9; n += 1) {
        writeSync(fd, "\n", line({ n: "a" }).length + n * lineBytes);
      }
      writeSync(
        fd,
        line({ n: "z" }),
        line({ n: "a" }).length + 9 * lineBytes + 1,
      );
    } finally {
      closeSync(fd);
    }

    const scan = await prepareHistory(history, join(root, "work.jsonl"), RUN);

    expect(scan.dropped).toBe(9);
    expect(keptTexts(scan)).toEqual([json({ n: "a" }), json({ n: "z" })]);
  });

  test("a history it cannot read, or a copy it cannot write or update, is a typed error naming the file", async () => {
    const dir = join(root, "dir");
    mkdirSync(dir);
    const read = await prepareHistory(dir, join(root, "w.jsonl"), RUN).catch(
      (caught: unknown) => caught,
    );
    expect(read).toBeInstanceOf(AllureReportError);
    expect((read as Error).message).toBe(
      `Cannot read the Allure history ${dir} (EISDIR).`,
    );
    expect((read as Error).cause).toMatchObject({ code: "EISDIR" });

    const history = join(root, "h.jsonl");
    writeFileSync(history, line({ n: "a" }));
    await expect(prepareHistory(history, dir, RUN)).rejects.toMatchObject({
      constructor: AllureReportError,
      message: `Cannot write Allure's history ${dir} (EISDIR).`,
    });
    const scan = scanHistory([], RUN);
    await expect(settleHistory(dir, scan, RUN)).rejects.toMatchObject({
      constructor: AllureReportError,
      message: `Cannot update Allure's history ${dir} (EISDIR).`,
    });
  });

  test("a stop is passed on as it is", async () => {
    await expect(
      prepareHistory(join(root, "none"), join(root, "w"), RUN, {
        signal: AbortSignal.abort(),
      }),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("readHistoryText: a missing file is an empty history, a longer one unread; any other error is thrown", async () => {
    const path = join(root, "h.jsonl");
    writeFileSync(path, "abcd");
    expect(await readHistoryText(path, 4)).toBe("abcd");
    expect(await readHistoryText(path, 3)).toBeUndefined();
    expect(await readHistoryText(join(root, "none.jsonl"), 0)).toBe("");
    await expect(readHistoryText(root, 1024)).rejects.toMatchObject({
      code: "EISDIR",
    });
  });

  test("historyText terminates every line", () => {
    expect(historyText([])).toBe("");
    expect(historyText(["a", "b\r"])).toBe("a\nb\r\n");
  });
});
