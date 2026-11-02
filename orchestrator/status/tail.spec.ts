import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runBegin,
  runEnd,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import { removeTempDir } from "../../src/common/__fixtures__/temp-dir";
import type { ResultsEvent } from "../../src/common/reporting/results-schema";
import { MAX_RESULTS_BYTES } from "../runs/end";
import { MAX_LINE_LENGTH, readRunResults } from "../runs/results";
import {
  readTail,
  TAIL_HEAD_BYTES,
  TAIL_START,
  TAIL_WINDOW_BYTES,
  takeChunk,
  type TailHandle,
  type TailState,
} from "./tail";

/**
 * The results-stream tail: its pure core on byte chunks, then its shell on real files written the
 * way a runner writes them — in pieces, a character split across two writes, cut short, truncated.
 */

let dir = "";
let path = "";

test.beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "e2e-tail-"));
  path = join(dir, "results.jsonl");
});
test.afterEach(() => {
  removeTempDir(dir);
});

/** A scenario titled in CJK and emoji: three- and four-byte UTF-8. */
const WIDE = scenarioEnd("w", "passed", { scenario: "バックアップ 👍🏽 作成" });

/**
 * Bytes of text.
 *
 * @param text - UTF-8 text.
 */
function bytes(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

/**
 * Every event, polling until the file is read to its end.
 *
 * @param state - where to start.
 * @param options - the window and budget.
 */
async function drain(
  state: TailState = TAIL_START,
  options: Parameters<typeof readTail>[2] = {},
): Promise<{ state: TailState; events: ResultsEvent[]; skipped: number }> {
  const events: ResultsEvent[] = [];
  let skipped = 0;
  for (let i = 0; i < 1_000; i += 1) {
    const read = await readTail(path, state, options);
    events.push(...read.events);
    skipped += read.skipped;
    if (read.state.offset === state.offset) break;
    state = read.state;
  }
  return { state, events, skipped };
}

test.describe("takeChunk", () => {
  test("takes whole lines, advancing by their bytes", () => {
    const text = streamOf([runBegin(2), setupEnd("auth", "passed")]);
    const taken = takeChunk(TAIL_START, bytes(text));
    expect(taken.events.map((e) => e.type)).toEqual(["run.begin", "setup.end"]);
    expect(taken.state).toEqual({
      offset: bytes(text).length,
      skipping: false,
    });
    expect(taken.skipped).toBe(0);
  });

  test("leaves a line still being written for the next read", () => {
    const whole = streamOf([runBegin(2)]);
    const half = JSON.stringify(setupEnd("auth", "passed")).slice(0, 20);
    const taken = takeChunk(TAIL_START, bytes(whole + half));
    expect(taken.events).toHaveLength(1);
    expect(taken.state.offset).toBe(bytes(whole).length);
  });

  test("a chunk with no newline, shorter than the window, waits: nothing taken", () => {
    const taken = takeChunk({ offset: 7, skipping: false }, bytes('{"v":1'));
    expect(taken).toEqual({
      state: { offset: 7, skipping: false },
      events: [],
      skipped: 0,
    });
  });

  test("a character split across two reads is decoded whole, never as U+FFFD", () => {
    const line = bytes(streamOf([WIDE]));
    // Inside the 4-byte emoji.
    const cut = line.indexOf(bytes("👍")) + 2;
    const first = takeChunk(TAIL_START, line.subarray(0, cut));
    expect(first.events).toEqual([]);
    expect(first.state.offset).toBe(0);
    const second = takeChunk(first.state, line);
    expect(second.events).toEqual([WIDE]);
  });

  test("a line that fills the window with no newline is skipped through to its newline, counted once", () => {
    const window = 512;
    const long = bytes(`${"x".repeat(2_000)}\n`);
    const next = bytes(streamOf([runBegin(1)]));
    const all = Buffer.concat([long, next]);
    let state: TailState = TAIL_START;
    const events: ResultsEvent[] = [];
    let skipped = 0;
    while (state.offset < all.length) {
      const chunk = all.subarray(state.offset, state.offset + window);
      const taken = takeChunk(state, chunk, window);
      events.push(...taken.events);
      skipped += taken.skipped;
      if (taken.state.offset === state.offset) break;
      state = taken.state;
    }
    expect(skipped).toBe(1);
    expect(events).toEqual([runBegin(1)]);
    expect(state).toEqual({ offset: all.length, skipping: false });
  });

  test("while skipping, a chunk with no newline is passed over whole", () => {
    expect(takeChunk({ offset: 10, skipping: true }, bytes("abc"), 3)).toEqual({
      state: { offset: 13, skipping: true },
      events: [],
      skipped: 0,
    });
  });

  test("garbage, other versions and blank lines are skipped, never fatal; the events around them kept", () => {
    const text = `not json\n\n${JSON.stringify({ ...runBegin(1), v: 2 })}\n${streamOf([runBegin(3)])}{"v":1,"type":"nope","at":"x"}\n`;
    const taken = takeChunk(TAIL_START, bytes(text));
    expect(taken.events).toEqual([runBegin(3)]);
    expect(taken.skipped).toBe(3);
  });

  test("the window is the end-of-run reader's longest line at 3 UTF-8 bytes a unit, and its newline", () => {
    expect(TAIL_WINDOW_BYTES).toBe(3 * MAX_LINE_LENGTH + 1);
  });

  test("a line exactly as long as the window, newline included, is read; one byte more is skipped", () => {
    const window = 512;
    const event = (pad: number): string =>
      JSON.stringify(scenarioEnd("p", "passed", { scenario: "x".repeat(pad) }));
    const base = event(0).length;
    const fits = `${event(window - 1 - base)}\n`;
    expect(bytes(fits)).toHaveLength(window);
    const taken = takeChunk(TAIL_START, bytes(fits), window);
    expect(taken.events).toHaveLength(1);
    expect(taken.state.offset).toBe(window);
    const over = bytes(`${event(window - base)}\n`);
    const first = takeChunk(TAIL_START, over.subarray(0, window), window);
    expect(first).toMatchObject({ events: [], skipped: 1 });
    expect(first.state).toEqual({ offset: window, skipping: true });
    expect(takeChunk(first.state, over.subarray(window), window)).toEqual({
      state: { offset: over.length, skipping: false },
      events: [],
      skipped: 0,
    });
  });

  test("a stream cut at every byte offset, then read whole, gives every event once, never U+FFFD", () => {
    const events = [
      runBegin(1),
      scenarioEnd("w", "passed", { scenario: "バックアップ 👍🏽 作成" }),
      runEnd("passed", { total: 1, passed: 1 }),
    ];
    const text = bytes(streamOf(events));
    for (let cut = 0; cut <= text.length; cut += 1) {
      let state: TailState = TAIL_START;
      const seen: ResultsEvent[] = [];
      for (const piece of [text.subarray(0, cut), text]) {
        const taken = takeChunk(state, piece.subarray(state.offset));
        seen.push(...taken.events);
        state = taken.state;
      }
      expect(seen, `cut at ${String(cut)}`).toEqual(events);
      expect(state.offset).toBe(text.length);
    }
  });

  test("a byte order mark is kept, as the end-of-run reader keeps it: its line is no event, at the start or later", () => {
    const bom = "\uFEFF";
    const text = `${bom}${streamOf([runBegin(1)])}${bom}${streamOf([scenarioEnd("a", "passed")])}${streamOf([runEnd("passed", { total: 1, passed: 1 })])}`;
    const whole = takeChunk(TAIL_START, bytes(text));
    expect(whole.events.map((e) => e.type)).toEqual(["run.end"]);
    expect(whole.skipped).toBe(2);
    // A later read that begins with one keeps it too.
    const first = bytes(`${bom}${streamOf([runBegin(1)])}`);
    const later = takeChunk(
      { offset: first.length, skipping: false },
      bytes(`${bom}${streamOf([scenarioEnd("a", "passed")])}`),
    );
    expect(later.events).toEqual([]);
    expect(readRunResults(text).scenarios).toEqual([]);
    expect(readRunResults(text).begin).toBeUndefined();
  });
});

test.describe("readTail", () => {
  test("no file yet is no data: the state unchanged; once it appears, its lines are read", async () => {
    const missing = await readTail(path, TAIL_START);
    expect(missing).toEqual({
      state: TAIL_START,
      events: [],
      skipped: 0,
      reset: false,
      miss: "missing",
    });
    await writeFile(path, streamOf([runBegin(2)]));
    const read = await readTail(path, missing.state);
    expect(read.events).toEqual([runBegin(2)]);
    expect(read.miss).toBeUndefined();
  });

  test("a line written in two pieces, split inside a character, is read once whole", async () => {
    const line = bytes(streamOf([WIDE]));
    const cut = line.indexOf(bytes("バ")) + 1;
    await writeFile(path, line.subarray(0, cut));
    const first = await readTail(path, TAIL_START);
    expect(first.events).toEqual([]);
    await appendFile(path, line.subarray(cut));
    const second = await readTail(path, first.state);
    expect(second.events).toEqual([WIDE]);
    expect(second.state.offset).toBe(line.length);
  });

  test("a file shorter than the offset was truncated: the tail starts over and says so", async () => {
    await writeFile(
      path,
      streamOf([
        runBegin(2),
        setupEnd("auth", "passed"),
        scenarioEnd("a", "passed"),
      ]),
    );
    const first = await readTail(path, TAIL_START);
    expect(first.events).toHaveLength(3);
    await truncate(path, 0);
    await writeFile(path, streamOf([runBegin(5)]));
    const second = await readTail(path, first.state);
    expect(second.reset).toBe(true);
    expect(second.events).toEqual([runBegin(5)]);
  });

  test("a stream cut short — a runner that crashed — gives its whole lines and never its last half", async () => {
    const whole = streamOf([runBegin(2), scenarioEnd("a", "failed")]);
    await writeFile(path, `${whole}{"v":1,"type":"run.e`);
    const { events } = await drain();
    expect(events.map((e) => e.type)).toEqual(["run.begin", "scenario.end"]);
  });

  test("a huge line is skipped within a small window, the next line still read", async () => {
    await writeFile(
      path,
      `${"y".repeat(10_000)}\n${streamOf([runEnd("passed", { total: 1, passed: 1 })])}`,
    );
    const { events, skipped } = await drain(TAIL_START, { windowBytes: 512 });
    expect(skipped).toBe(1);
    expect(events.map((e) => e.type)).toEqual(["run.end"]);
  });

  test("a poll reads at most its budget (when over a window); later polls catch up", async () => {
    const events = Array.from({ length: 50 }, (_, i) =>
      scenarioEnd(`s${String(i)}`, "passed"),
    );
    await writeFile(path, streamOf(events));
    // The budget is at least a window: a smaller window keeps 1,000 bytes the budget.
    const bounds = { pollBytes: 1_000, windowBytes: 512 };
    const first = await readTail(path, TAIL_START, bounds);
    expect(first.events.length).toBeGreaterThan(0);
    expect(first.events.length).toBeLessThan(50);
    const rest = await drain(first.state, bounds);
    expect([...first.events, ...rest.events]).toEqual(events);
  });

  test("a folder in the stream's place is no data, never thrown", async () => {
    await mkdir(path);
    const read = await readTail(path, TAIL_START);
    expect(read.miss).toBe("not a file");
    expect(read.events).toEqual([]);
  });

  test("a read or stat that fails is no data, and the handle is closed on every path", async () => {
    for (const failing of ["stat", "read"] as const) {
      let closed = 0;
      const handle: TailHandle = {
        stat: () =>
          failing === "stat"
            ? Promise.reject(Object.assign(new Error("x"), { code: "EIO" }))
            : Promise.resolve({
                size: 100,
                dev: 1,
                ino: 1,
                isFile: () => true,
              }),
        read: () =>
          Promise.reject(Object.assign(new Error("x"), { code: "EIO" })),
        close: () => {
          closed += 1;
          return Promise.reject(new Error("close fails too"));
        },
      };
      const read = await readTail(path, TAIL_START, {
        open: () => Promise.resolve(handle),
      });
      expect(read.miss).toBe("EIO");
      expect(read.state).toBe(TAIL_START);
      expect(closed).toBe(1);
    }
  });

  test("an open refused for another reason names its code", async () => {
    const read = await readTail(path, TAIL_START, {
      open: () =>
        Promise.reject(Object.assign(new Error("no"), { code: "EACCES" })),
    });
    expect(read.miss).toBe("EACCES");
  });

  test("each successful poll closes its handle", async () => {
    await writeFile(path, streamOf([runBegin(1)]));
    let opened = 0;
    let closed = 0;
    const { open } = await import("node:fs/promises");
    await readTail(path, TAIL_START, {
      open: async (p) => {
        opened += 1;
        const handle = await open(p, "r");
        return {
          stat: () => handle.stat(),
          read: (b, o, l, pos) => handle.read(b, o, l, pos),
          close: () => {
            closed += 1;
            return handle.close();
          },
        };
      },
    });
    expect([opened, closed]).toEqual([1, 1]);
  });

  test("an empty file is no data and no miss: the offset stays 0", async () => {
    await writeFile(path, "");
    const read = await readTail(path, TAIL_START);
    expect(read).toMatchObject({ events: [], skipped: 0, reset: false });
    expect(read.miss).toBeUndefined();
    expect(read.state.offset).toBe(0);
  });

  test("a file cut back inside what was read, its first bytes unchanged, starts over", async () => {
    const first = streamOf([runBegin(2)]);
    await writeFile(
      path,
      `${first}${streamOf([scenarioEnd("a", "passed"), scenarioEnd("b", "passed")])}`,
    );
    const read = await readTail(path, TAIL_START);
    await truncate(path, bytes(first).length);
    const again = await readTail(path, read.state);
    expect(again.reset).toBe(true);
    expect(again.events).toEqual([runBegin(2)]);
    expect(again.state.offset).toBe(bytes(first).length);
  });

  test("a file replaced by another whose first bytes are the same starts over: its inode differs", async () => {
    const begin = streamOf([runBegin(2, { product: "p".repeat(300) })]);
    await writeFile(path, `${begin}${streamOf([scenarioEnd("a", "failed")])}`);
    const read = await readTail(path, TAIL_START);
    const other = join(dir, "other.jsonl");
    await writeFile(
      other,
      `${begin}${streamOf([scenarioEnd("b", "passed"), scenarioEnd("c", "passed")])}`,
    );
    await rename(other, path);
    const again = await readTail(path, read.state);
    expect(again.reset).toBe(true);
    expect(
      again.events.map((e) => (e.type === "scenario.end" ? e.id : e.type)),
    ).toEqual(["run.begin", "b", "c"]);
  });

  test("by default, a stream over the end-of-run reader's 8 MiB is too large; at it, it is read", async () => {
    await writeFile(path, streamOf([runBegin(1)]));
    await truncate(path, MAX_RESULTS_BYTES + 1);
    expect((await readTail(path, TAIL_START)).tooLarge).toBe(true);
    await truncate(path, MAX_RESULTS_BYTES);
    const read = await readTail(path, TAIL_START);
    expect(read.tooLarge).toBeUndefined();
    expect(read.events).toEqual([runBegin(1)]);
  });

  test("a file replaced by a larger one (another inode) starts over", async () => {
    await writeFile(path, streamOf([runBegin(2), scenarioEnd("a", "failed")]));
    const first = await readTail(path, TAIL_START);
    const other = join(dir, "other.jsonl");
    await writeFile(
      other,
      streamOf([
        runBegin(4),
        scenarioEnd("a", "passed"),
        scenarioEnd("b", "passed"),
        scenarioEnd("c", "passed"),
      ]),
    );
    await rename(other, path);
    const second = await readTail(path, first.state);
    expect(second.reset).toBe(true);
    expect(second.events.map((e) => e.type)).toEqual([
      "run.begin",
      "scenario.end",
      "scenario.end",
      "scenario.end",
    ]);
  });

  test("a file truncated and written again past the old offset, same inode, starts over", async () => {
    await writeFile(path, streamOf([runBegin(2)]));
    const first = await readTail(path, TAIL_START);
    const inode = (await stat(path)).ino;
    await truncate(path, 0);
    await appendFile(
      path,
      streamOf([
        runBegin(9),
        scenarioEnd("a", "passed"),
        scenarioEnd("b", "failed"),
      ]),
    );
    expect((await stat(path)).ino).toBe(inode);
    const second = await readTail(path, first.state);
    expect(second.reset).toBe(true);
    expect(second.events).toEqual([
      runBegin(9),
      scenarioEnd("a", "passed"),
      scenarioEnd("b", "failed"),
    ]);
  });

  test("a file removed and made again starts over once it is back", async () => {
    await writeFile(path, streamOf([runBegin(2), scenarioEnd("a", "failed")]));
    const first = await readTail(path, TAIL_START);
    await rm(path);
    const gone = await readTail(path, first.state);
    expect(gone.miss).toBe("missing");
    expect(gone.state).toBe(first.state);
    await writeFile(
      path,
      streamOf([
        runBegin(3),
        scenarioEnd("b", "passed"),
        scenarioEnd("c", "passed"),
      ]),
    );
    const back = await readTail(path, gone.state);
    expect(back.reset).toBe(true);
    expect(back.events.map((e) => e.type)).toEqual([
      "run.begin",
      "scenario.end",
      "scenario.end",
    ]);
  });

  test("a file that only grew is never started over: its first bytes are kept as they were", async () => {
    await writeFile(path, streamOf([runBegin(2)]));
    let state = (await readTail(path, TAIL_START)).state;
    expect(state.file?.head).toHaveLength(
      Math.min(TAIL_HEAD_BYTES, state.offset),
    );
    for (const id of ["a", "b", "c"]) {
      await appendFile(path, streamOf([scenarioEnd(id, "passed")]));
      const read = await readTail(path, state);
      expect(read.reset).toBe(false);
      expect(read.events).toHaveLength(1);
      state = read.state;
    }
    expect(state.file?.head).toHaveLength(TAIL_HEAD_BYTES);
  });

  test("a budget smaller than a line still reads it: a poll takes at least one window", async () => {
    const text = streamOf([
      runBegin(1, { product: "p".repeat(300) }),
      runEnd("passed", { total: 1, passed: 1 }),
    ]);
    await writeFile(path, text);
    const read = await readTail(path, TAIL_START, { pollBytes: 100 });
    expect(read.events.map((e) => e.type)).toEqual(["run.begin", "run.end"]);
    expect(read.state.offset).toBe(bytes(text).length);
  });

  test("a stream over the end-of-run reader's cap is not read: too large, the state unchanged", async () => {
    await writeFile(path, streamOf([runBegin(1), scenarioEnd("a", "passed")]));
    const read = await readTail(path, TAIL_START, { maxBytes: 64 });
    expect(read).toEqual({
      state: TAIL_START,
      events: [],
      skipped: 0,
      reset: false,
      tooLarge: true,
    });
    // At the cap exactly, it is read.
    const size = (await stat(path)).size;
    expect(
      (await readTail(path, TAIL_START, { maxBytes: size })).events,
    ).toHaveLength(2);
    expect(MAX_RESULTS_BYTES).toBe(8 * 1024 * 1024);
  });

  test("a FIFO in the stream's place is no data at once: its open never waits for a writer", async () => {
    test.setTimeout(5_000);
    execFileSync("mkfifo", [path]);
    const started = Date.now();
    const read = await readTail(path, TAIL_START);
    expect(read.miss).toBe("not a file");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("lines between the end-of-run reader's cap in UTF-16 units and in bytes count as it counts them", async () => {
    // 100,000 three-byte characters: 300,000 bytes, but 100,000 units — kept by both.
    const kept = scenarioEnd("k", "failed", { scenario: "猫".repeat(100_000) });
    // MAX_LINE_LENGTH + 1 units of ASCII: within the window in bytes, over the cap in units — dropped by both.
    const pad =
      MAX_LINE_LENGTH + 1 - JSON.stringify(scenarioEnd("d", "passed")).length;
    const dropped = scenarioEnd("d", "passed", {
      scenario: `Scenario d${"x".repeat(pad)}`,
    });
    expect(JSON.stringify(dropped)).toHaveLength(MAX_LINE_LENGTH + 1);
    const atCap = scenarioEnd("e", "passed", {
      scenario: `Scenario e${"x".repeat(pad - 1)}`,
    });
    expect(JSON.stringify(atCap)).toHaveLength(MAX_LINE_LENGTH);
    await writeFile(
      path,
      streamOf([
        runBegin(3),
        kept,
        dropped,
        atCap,
        runEnd("failed", { total: 3, failed: 1 }),
      ]),
    );
    const { events, skipped } = await drain();
    const end = readRunResults(await readFile(path, "utf8"));
    expect(skipped).toBe(1);
    expect(
      events.filter((e) => e.type === "scenario.end").map((e) => e.id),
    ).toEqual(end.scenarios.map((s) => s.id));
    expect(end.scenarios.map((s) => s.id)).toEqual(["k", "e"]);
  });
});
