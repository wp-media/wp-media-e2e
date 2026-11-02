import { test, expect } from "@playwright/test";

import {
  BACKLOG_RETRY_MS,
  clearBytes,
  createLiveRegion,
  DEFAULT_MIN_INTERVAL_MS,
  fitRow,
  frame,
  geometryOf,
  realScheduler,
  REPAINT_GAP_MS,
  resetBytes,
  sgrOnly,
  type LiveRegionOptions,
  type LiveRow,
  type Scheduler,
  type TerminalSize,
} from "./live";
import { openLiveTerminal, type LiveTerminal } from "./stream";

/** How a fake sink's `write` behaves. */
type WriteMode = "ok" | "throw" | "callback-error" | "late-error";

/** A stream stand-in recording every chunk as text; its backlog and failure mode are set by hand. */
class FakeSink {
  readonly chunks: string[] = [];
  writableLength = 0;
  destroyed = false;
  mode: WriteMode = "ok";
  /** Callbacks a `late-error` write holds until {@link FakeSink.failLater}. */
  readonly #late: ((error: Error) => void)[] = [];

  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    expect(chunk).toBeInstanceOf(Uint8Array);
    if (this.mode === "throw")
      throw Object.assign(new Error("write EIO"), { code: "EIO" });
    this.chunks.push(Buffer.from(chunk).toString("utf8"));
    if (this.mode === "callback-error")
      callback(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    else if (this.mode === "late-error") this.#late.push(callback);
    else callback();
    return true;
  }

  /** `openLiveTerminal` listens for errors here; this fake never emits one. */
  on(): this {
    return this;
  }

  /** How many `late-error` writes are held. */
  get held(): number {
    return this.#late.length;
  }

  /** Fails every held `late-error` write, as a terminal gone with its session does. */
  failLater(): void {
    for (const callback of this.#late.splice(0))
      callback(Object.assign(new Error("write EIO"), { code: "EIO" }));
  }

  /** Everything written, as one string. */
  get all(): string {
    return this.chunks.join("");
  }
}

/** A clock that moves only when told; timers fire as it passes them. */
class FakeScheduler implements Scheduler {
  time = 0;
  #next = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.#next++;
    this.timers.set(id, { at: this.time + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** When each armed timer fires. */
  get due(): number[] {
    return [...this.timers.values()].map((timer) => timer.at);
  }

  /**
   * Moves the clock by `ms`, firing each due timer in order.
   *
   * @param ms - how far.
   */
  advance(ms: number): void {
    const end = this.time + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.time = Math.max(this.time, due[1].at);
      due[1].callback();
    }
    this.time = end;
  }
}

/** Clear bytes, typed out: the contract's own spelling. */
const CLEAR_1 = "\r\x1b[2K";
const UP_CLEAR = "\x1b[1A\r\x1b[2K";
/** A resize's erase after the up move: clear the row, save, down one, clear below, restore. */
const RESET_TAIL = "\r\x1b[2K\x1b7\x1b[1B\x1b[J\x1b8";
/** Red and dim as a palette paints them, and the reset a styled row ends with. */
const red = (text: string): string => `\x1b[31m${text}\x1b[39m`;
const dim = (text: string): string => `\x1b[2m${text}\x1b[22m`;
const RESET = "\x1b[0m";
/** Any C0 or C1 control character, DEL included. */
// eslint-disable-next-line no-control-regex -- finding a control character is the point.
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A region over a fake sink and clock: live, 40×10, a 500 ms interval unless overridden.
 *
 * @param overrides - options to replace.
 * @param size - the terminal's size, changeable by the test.
 */
function setup(
  overrides: Partial<LiveRegionOptions> = {},
  size: { current: TerminalSize } = { current: { columns: 40, rows: 10 } },
) {
  const sink = new FakeSink();
  const scheduler = new FakeScheduler();
  const failures: Error[] = [];
  const region = createLiveRegion({
    terminal: openLiveTerminal(sink),
    capabilities: { live: true },
    size: () => size.current,
    ellipsis: "…",
    scheduler,
    onFailure: (error) => failures.push(error),
    ...overrides,
  });
  return { sink, scheduler, region, failures, size };
}

test.describe("clearBytes and resetBytes", () => {
  test("clear N rows as the contract spells it, nothing for none", () => {
    expect(clearBytes(0)).toBe("");
    expect(clearBytes(1)).toBe(CLEAR_1);
    expect(clearBytes(3)).toBe(CLEAR_1 + UP_CLEAR + UP_CLEAR);
  });

  test("erase a block after a resize: up height-1 rows, then that row and those below it, cursor back", () => {
    expect(resetBytes(0)).toBe("");
    expect(resetBytes(1)).toBe(RESET_TAIL);
    expect(resetBytes(4)).toBe(`\x1b[3A${RESET_TAIL}`);
  });
});

test.describe("geometryOf", () => {
  test("is the width clamped to 120 and the height less one", () => {
    expect(geometryOf({ columns: 40, rows: 10 })).toEqual({
      width: 40,
      maxHeight: 9,
    });
    expect(geometryOf({ columns: 200, rows: 1 })).toEqual({
      width: 120,
      maxHeight: 0,
    });
    expect(geometryOf({ columns: 20, rows: 5 })).toEqual({
      width: 20,
      maxHeight: 4,
    });
  });

  test("is none for an unknown, zero or too narrow size", () => {
    for (const size of [
      {},
      { columns: 0, rows: 10 },
      { columns: 40, rows: 0 },
      { columns: 19, rows: 10 },
      { columns: 40.5, rows: 10 },
      { columns: Number.NaN, rows: 10 },
    ])
      expect(geometryOf(size), JSON.stringify(size)).toBeUndefined();
  });
});

test.describe("sgrOnly", () => {
  test("leaves plain text as withoutControls does: controls become a space, escapes vanish", () => {
    expect(sgrOnly("plain")).toBe("plain");
    expect(sgrOnly("a\tb\rc")).toBe("a b c");
    expect(sgrOnly("x\x1b[2Ay\x1b]0;title\x07z")).toBe("xyz");
  });

  test("keeps SGR (colon parameters too) and closes what it leaves open", () => {
    expect(sgrOnly("\x1b[31mred")).toBe(`\x1b[31mred${RESET}`);
    expect(sgrOnly(red("ok"))).toBe(`${red("ok")}${RESET}`);
    expect(sgrOnly("\x1b[38:5:1mx")).toBe(`\x1b[38:5:1mx${RESET}`);
    expect(sgrOnly("\x1b[1mbold\x1b[0m")).toBe("\x1b[1mbold\x1b[0m");
    expect(sgrOnly("\x1b[1mbold\x1b[m")).toBe("\x1b[1mbold\x1b[m");
  });

  test("drops cursor movement, erases, C1 controls and carriage returns around SGR", () => {
    expect(sgrOnly("\x1b[31mred\x1b[2A\r")).toBe(`\x1b[31mred ${RESET}`);
    expect(sgrOnly("\x1b[32mok\x1b[2J\u009b1A\x1b[39m")).toBe(
      `\x1b[32mok\x1b[39m${RESET}`,
    );
    expect(sgrOnly("a\x1b[0m\x1b[Kb")).toBe(`a\x1b[0mb${RESET}`);
  });

  test("never lets anything but SGR through, whatever it is given", () => {
    const nasty = [
      "\x1b]8;;https://x\x07link\x1b]8;;\x07",
      "\x1b]0;\x1b[31m\x07after",
      "\x1b[31\x1b[2Am",
      "\x1bP1$r\x1b[0m\x1b\\",
      "\x1b[?25l\x1b[31mhidden",
      "\ud83d\x1b[0m\ude00",
      "\x1b",
      "\x1b[",
    ];
    for (const text of nasty) {
      const out = sgrOnly(text);
      // eslint-disable-next-line no-control-regex -- removing SGR is the point.
      const rest = out.replace(/\u001b\[[0-9;:]*m/g, "");
      expect(rest, JSON.stringify(text)).not.toMatch(CONTROL_CHARACTER);
      if (out !== rest)
        expect(out.endsWith(RESET), JSON.stringify(text)).toBe(true);
    }
  });
});

test.describe("fitRow", () => {
  test("keeps a row that fits and cuts one that does not, with the ellipsis inside the width", () => {
    expect(fitRow("short", 20, "…")).toBe("short");
    expect(fitRow("x".repeat(25), 20, "…")).toBe(`${"x".repeat(19)}…`);
  });

  test("measures an ASCII ellipsis: three columns for `...`", () => {
    expect(fitRow("x".repeat(25), 20, "...")).toBe(`${"x".repeat(17)}...`);
    expect(
      fitRow(
        [
          { text: "a".repeat(15), style: red },
          { text: "b".repeat(10), style: dim },
        ],
        20,
        "...",
      ),
    ).toBe(`${red("a".repeat(15))}${dim("bb")}${dim("...")}${RESET}`);
  });

  test("never splits a wide character at the cut", () => {
    // 18 + a 2-column character + 1 = 21 columns into 20: the wide one goes, the ellipsis fits.
    expect(fitRow(`${"a".repeat(18)}中x`, 20, "…")).toBe(`${"a".repeat(18)}…`);
    expect(fitRow("中".repeat(15), 20, "…")).toBe(`${"中".repeat(9)}…`);
    expect(fitRow("中".repeat(10), 20, "…")).toBe("中".repeat(10));
  });

  test("turns control characters into spaces and drops escape sequences", () => {
    expect(fitRow("a\x1b[2Jb\tc\nd", 20, "…")).toBe("ab c d");
  });

  test("styles each segment after the cut and ends a styled row with a reset; the ellipsis takes the cut segment's style", () => {
    expect(fitRow([{ text: "ab", style: red }, { text: "cd" }], 20, "…")).toBe(
      `${red("ab")}cd${RESET}`,
    );
    expect(
      fitRow(
        [
          { text: "a".repeat(15), style: red },
          { text: "b".repeat(10), style: dim },
        ],
        20,
        "…",
      ),
    ).toBe(`${red("a".repeat(15))}${dim("bbbb")}${dim("…")}${RESET}`);
    // The cut falls at a segment's end: the next segment holds only the ellipsis.
    expect(
      fitRow(
        [
          { text: "a".repeat(19), style: red },
          { text: "bb", style: dim },
        ],
        20,
        "…",
      ),
    ).toBe(`${red("a".repeat(19))}${dim("…")}${RESET}`);
    expect(fitRow([], 20, "…")).toBe("");
  });

  test("adds no reset to a row whose style already ends with one", () => {
    const bold = (text: string): string => `\x1b[1m${text}\x1b[0m`;
    expect(fitRow([{ text: "ab", style: bold }], 20, "…")).toBe(
      "\x1b[1mab\x1b[0m",
    );
  });

  test("gives the ellipsis the style of the segment cut, not of a later one", () => {
    const tag =
      (code: number) =>
      (text: string): string =>
        `\x1b[${String(code)}m${text}\x1b[0m`;
    expect(
      fitRow(
        [
          { text: "a".repeat(15), style: tag(31) },
          { text: "b".repeat(10), style: tag(32) },
          { text: "c".repeat(5), style: tag(33) },
        ],
        20,
        "…",
      ),
    ).toBe(`${tag(31)("a".repeat(15))}${tag(32)("bbbb")}${tag(32)("…")}`);
  });

  test("draws text unstyled when its style throws, adds anything but SGR, or changes the text", () => {
    const styles: ((text: string) => string)[] = [
      () => {
        throw new Error("bad style");
      },
      (text) => `\x1b[2A${text}`,
      (text) => `\x1b]8;;https://x\x07${text}\x1b]8;;\x07`,
      (text) => `\x1b[31m${text}\r`,
      (text) => text.toUpperCase(),
      (text) => `\x1b[31m${text}!`,
      () => 42 as unknown as string,
    ];
    for (const style of styles)
      expect(fitRow([{ text: "ok", style }], 20, "…"), String(style)).toBe(
        "ok",
      );
  });

  test("draws text that is no string, or a segment that cannot be read, as nothing", () => {
    const throwing = {
      get text(): string {
        throw new Error("getter");
      },
    };
    const rows = [
      42,
      null,
      [{ text: 42 }, null, throwing, { text: "ok", style: "red" }],
    ] as unknown as LiveRow[];
    expect(rows.map((row) => fitRow(row, 20, "…"))).toEqual(["", "", "ok"]);
  });
});

test.describe("frame", () => {
  test("joins the rows by \\r\\n, ends on the last row's column 0, keeps the first rows that fit", () => {
    const geometry = { width: 20, maxHeight: 2 };
    expect(frame(["a", "b", "c"], geometry, "…")).toEqual({
      text: "a\r\nb\r",
      height: 2,
    });
    expect(frame([], geometry, "…")).toEqual({ text: "", height: 0 });
    expect(frame(["a"], { width: 20, maxHeight: 0 }, "…")).toEqual({
      text: "",
      height: 0,
    });
  });
});

test.describe("createLiveRegion — the cursor contract", () => {
  test("closes a one-row block with one clear", () => {
    const { sink, region } = setup();
    region.update(["a"]);
    region.close();
    expect(sink.chunks).toEqual(["a\r", "\r\x1b[2K"]);
  });

  test("draws the first update at once, ending on the last row's column 0 with no line end", () => {
    const { sink, region } = setup();
    region.update(["one", "two"]);
    expect(sink.chunks).toEqual(["one\r\ntwo\r"]);
    expect(region.height).toBe(2);
    expect(region.width).toBe(40);
    expect(region.state).toBe("live");
  });

  test("redraws taller and shorter blocks over a cleared one", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a", "b"]);
    scheduler.advance(500);
    region.update(["a", "b", "c"]);
    expect(sink.chunks[1]).toBe(`${CLEAR_1}${UP_CLEAR}a\r\nb\r\nc\r`);
    scheduler.advance(500);
    region.update(["z"]);
    expect(sink.chunks[2]).toBe(`${CLEAR_1}${UP_CLEAR}${UP_CLEAR}z\r`);
    expect(region.height).toBe(1);
    scheduler.advance(500);
    region.update([]);
    expect(sink.chunks[3]).toBe(CLEAR_1);
    expect(region.height).toBe(0);
  });

  test("prints a permanent line where the block was, then \\r\\n, and repaints the block on the next turn", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a", "b"]);
    expect(region.print(red("passed"))).toBe(true);
    expect(sink.chunks[1]).toBe(
      `${CLEAR_1}${UP_CLEAR}${red("passed")}${RESET}\r\n`,
    );
    expect(region.height).toBe(0);
    // Drawn at 0, so the repaint waits for the gap.
    expect(scheduler.due).toEqual([REPAINT_GAP_MS]);
    scheduler.advance(REPAINT_GAP_MS - 1);
    expect(sink.chunks).toHaveLength(2);
    scheduler.advance(1);
    expect(sink.chunks[2]).toBe("a\r\nb\r");
    expect(region.height).toBe(2);
    expect(scheduler.timers.size).toBe(0);
  });

  test("a burst of prints costs one repaint", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a", "b", "c"]);
    for (let i = 0; i < 1_000; i++) region.print(`line ${String(i)}`);
    expect(sink.chunks).toHaveLength(1_001);
    expect(sink.chunks[1]).toBe(`${CLEAR_1}${UP_CLEAR}${UP_CLEAR}line 0\r\n`);
    expect(sink.chunks[1_000]).toBe("line 999\r\n");
    expect(scheduler.timers.size).toBe(1);
    scheduler.advance(REPAINT_GAP_MS);
    expect(sink.chunks).toHaveLength(1_002);
    expect(sink.chunks.at(-1)).toBe("a\r\nb\r\nc\r");
  });

  test("prints spread over time cost at most one repaint per REPAINT_GAP_MS; a lone print repaints on the next turn", () => {
    expect(REPAINT_GAP_MS).toBe(50);
    const { sink, scheduler, region } = setup();
    region.update(["a"]);
    scheduler.advance(1_000);
    region.print("lone");
    expect(scheduler.due).toEqual([1_000]);
    scheduler.advance(0);
    expect(sink.chunks.at(-1)).toBe("a\r");
    const before = sink.chunks.length;
    for (let i = 0; i < 100; i++) {
      region.print(`line ${String(i)}`);
      scheduler.advance(2);
    }
    const repaints = sink.chunks
      .slice(before)
      .filter((chunk) => chunk === "a\r").length;
    // 200 ms of prints: a repaint at 50, 100, 150 and 200 ms after the lone one's.
    expect(repaints).toBe(4);
  });

  test("prints several lines at once, each split at \\n, and skips what is no string", () => {
    const { sink, region } = setup();
    expect(
      region.print(["a", "b\nc", 42 as unknown as string, "d\x1b[2Ae"]),
    ).toBe(true);
    expect(sink.chunks).toEqual(["a\r\nb\r\nc\r\nde\r\n"]);
    expect(region.print([])).toBe(true);
    expect(region.print(undefined as unknown as string)).toBe(true);
    expect(sink.chunks).toHaveLength(1);
  });

  test("prints a bare line when no block is drawn, arming no repaint", () => {
    const { sink, scheduler, region } = setup();
    region.print("first");
    expect(sink.chunks).toEqual(["first\r\n"]);
    expect(scheduler.timers.size).toBe(0);
  });

  test("the repaint after a print draws the newest rows, not the stale ones, and takes the throttle's slot", () => {
    const { sink, scheduler, region } = setup();
    region.update(["old"]);
    scheduler.advance(100);
    region.update(["new"]);
    expect(scheduler.due).toEqual([500]);
    region.print("line");
    expect(sink.chunks[1]).toBe(`${CLEAR_1}line\r\n`);
    expect(scheduler.due).toEqual([100]);
    scheduler.advance(0);
    expect(sink.chunks[2]).toBe("new\r");
    expect(scheduler.timers.size).toBe(0);
    region.update(["newer"]);
    expect(scheduler.due).toEqual([600]);
  });

  test("a close before the repaint leaves the block cleared and writes nothing more", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a"]);
    region.print("line");
    region.close();
    scheduler.advance(1_000);
    expect(sink.chunks).toEqual(["a\r", `${CLEAR_1}line\r\n`]);
    expect(scheduler.timers.size).toBe(0);
  });

  test("caps the block at the terminal's height less one, keeping the first rows", () => {
    const { sink, region } = setup({}, { current: { columns: 40, rows: 4 } });
    region.update(["1", "2", "3", "4", "5"]);
    expect(sink.chunks).toEqual(["1\r\n2\r\n3\r"]);
    expect(region.height).toBe(3);
  });

  test("draws nothing on a one-row terminal, and still prints", () => {
    const { sink, region } = setup({}, { current: { columns: 40, rows: 1 } });
    region.update(["1"]);
    region.print("line");
    expect(sink.chunks).toEqual(["line\r\n"]);
    expect(region.height).toBe(0);
  });

  test("cuts rows to the width, the widest 120", () => {
    const { sink, region } = setup({}, { current: { columns: 200, rows: 5 } });
    region.update(["x".repeat(130), `${"y".repeat(118)}中z`]);
    expect(sink.chunks).toEqual([
      `${"x".repeat(119)}…\r\n${"y".repeat(118)}…\r`,
    ]);
  });

  test("draws rows whose text is no string as empty rows, never throwing from its timer", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a"]);
    region.update([42, [{ text: null }], "ok"] as unknown as LiveRow[]);
    expect(() => {
      scheduler.advance(500);
    }).not.toThrow();
    expect(sink.chunks[1]).toBe(`${CLEAR_1}\r\n\r\nok\r`);
    region.update(undefined as unknown as LiveRow[]);
    scheduler.advance(500);
    expect(sink.chunks[2]).toBe(`${CLEAR_1}${UP_CLEAR}${UP_CLEAR}`);
    expect(region.state).toBe("live");
  });

  test("closes by clearing the block, once, leaving the cursor on its first, clean row", () => {
    const { sink, scheduler, region } = setup();
    region.update(["a", "b", "c"]);
    region.update(["d"]); // Armed for later.
    region.close();
    region.close();
    expect(sink.chunks).toEqual([
      "a\r\nb\r\nc\r",
      `${CLEAR_1}${UP_CLEAR}${UP_CLEAR}`,
    ]);
    expect(scheduler.timers.size).toBe(0);
    expect(region.state).toBe("closed");
    expect(region.height).toBe(0);
    expect(region.width).toBe(0);
    region.update(["e"]);
    region.resize();
    expect(region.print("after")).toBe(true);
    expect(sink.chunks.at(-1)).toBe("after\n");
    expect(sink.chunks).toHaveLength(3);
  });

  test("closes a region that drew nothing without writing", () => {
    const { sink, region } = setup();
    region.close();
    expect(sink.chunks).toEqual([]);
  });
});

test.describe("createLiveRegion — throttle", () => {
  test("draws at most once per interval, coalescing to the newest rows", () => {
    const { sink, scheduler, region } = setup();
    region.update(["0"]);
    scheduler.advance(100);
    region.update(["1"]);
    scheduler.advance(100);
    region.update(["2"]);
    expect(sink.chunks).toEqual(["0\r"]);
    expect(scheduler.timers.size).toBe(1);
    scheduler.advance(299);
    expect(sink.chunks).toHaveLength(1);
    scheduler.advance(1);
    expect(sink.chunks).toEqual(["0\r", `${CLEAR_1}2\r`]);
    expect(scheduler.timers.size).toBe(0);
  });

  for (const [minIntervalMs, interval] of [
    [undefined, DEFAULT_MIN_INTERVAL_MS],
    [1_000, 1_000],
  ] as const) {
    test(`waits ${String(interval)} ms between draws (minIntervalMs ${String(minIntervalMs)})`, () => {
      expect(DEFAULT_MIN_INTERVAL_MS).toBe(500);
      const { sink, scheduler, region } = setup({ minIntervalMs });
      region.update(["0"]);
      region.update(["1"]);
      scheduler.advance(interval - 1);
      expect(sink.chunks).toHaveLength(1);
      scheduler.advance(1);
      expect(sink.chunks).toHaveLength(2);
    });
  }

  test("copies the rows it is given: a caller mutating its array changes nothing drawn", () => {
    const { sink, scheduler, region } = setup();
    region.update(["0"]);
    const rows = ["1"];
    region.update(rows);
    rows[0] = "mutated";
    scheduler.advance(500);
    expect(sink.chunks[1]).toBe(`${CLEAR_1}1\r`);
  });
});

test.describe("createLiveRegion — resize", () => {
  test("erases the old block, re-reads the size and redraws at the next slot", () => {
    const { sink, scheduler, region, size } = setup();
    region.update(["a".repeat(30), "b", "c"]);
    size.current = { columns: 25, rows: 3 };
    region.resize();
    expect(sink.chunks[1]).toBe(`\x1b[2A${RESET_TAIL}`);
    expect(region.height).toBe(0);
    scheduler.advance(500);
    expect(sink.chunks[2]).toBe(`${"a".repeat(24)}…\r\nb\r`);
    expect(region.width).toBe(25);
    expect(region.height).toBe(2);
  });

  test("a resize while a newer update waits for its slot draws that update, once, at the slot", () => {
    const { sink, scheduler, region, size } = setup();
    region.update(["a", "b"]);
    scheduler.advance(100);
    region.update(["c"]);
    size.current = { columns: 30, rows: 10 };
    region.resize();
    expect(sink.chunks[1]).toBe(`\x1b[1A${RESET_TAIL}`);
    expect(scheduler.due).toEqual([500]);
    scheduler.advance(400);
    expect(sink.chunks).toEqual(["a\r\nb\r", `\x1b[1A${RESET_TAIL}`, "c\r"]);
    expect(scheduler.timers.size).toBe(0);
  });

  test("a height-only shrink erases the old block and redraws it capped to the new height", () => {
    const { sink, scheduler, region, size } = setup();
    region.update(["1", "2", "3", "4", "5"]);
    size.current = { columns: 40, rows: 4 };
    region.resize();
    expect(sink.chunks[1]).toBe(`\x1b[4A${RESET_TAIL}`);
    scheduler.advance(500);
    expect(sink.chunks[2]).toBe("1\r\n2\r\n3\r");
    expect(region.height).toBe(3);
  });

  test("waits, printing bare lines, while the terminal is too narrow, and draws once it widens", () => {
    const { sink, scheduler, region, size } = setup();
    region.update(["a"]);
    size.current = { columns: 19, rows: 10 };
    region.resize();
    expect(region.width).toBe(0);
    scheduler.advance(1_000);
    region.update(["b"]);
    region.print("line");
    scheduler.advance(1_000);
    expect(sink.chunks).toEqual(["a\r", RESET_TAIL, "line\r\n"]);
    size.current = { columns: 0, rows: 0 };
    region.resize();
    expect(sink.chunks).toHaveLength(3);
    size.current = { columns: 30, rows: 10 };
    region.resize();
    expect(sink.chunks.at(-1)).toBe("b\r");
  });

  test("reads a size source that throws as no size", () => {
    const { sink, region } = setup({
      size: () => {
        throw new Error("EBADF");
      },
    });
    region.update(["a"]);
    region.print("line");
    expect(sink.chunks).toEqual(["line\r\n"]);
  });
});

test.describe("createLiveRegion — a stalled stream", () => {
  test("skips draws while the backlog is over the bound, and draws once it falls", () => {
    const { sink, scheduler, region } = setup({ maxBacklogBytes: 100 });
    sink.writableLength = 101;
    region.update(["a"]);
    expect(sink.chunks).toEqual([]);
    scheduler.advance(5_000);
    expect(sink.chunks).toEqual([]);
    expect(scheduler.timers.size).toBe(1);
    sink.writableLength = 100;
    scheduler.advance(500);
    expect(sink.chunks).toEqual(["a\r"]);
  });

  test("retries a skipped draw no sooner than BACKLOG_RETRY_MS, even with no interval", () => {
    expect(BACKLOG_RETRY_MS).toBe(50);
    const { sink, scheduler, region } = setup({
      minIntervalMs: 0,
      maxBacklogBytes: 100,
    });
    sink.writableLength = 101;
    region.update(["a"]);
    expect(scheduler.due).toEqual([50]);
    scheduler.advance(49);
    expect(scheduler.due).toEqual([50]);
    sink.writableLength = 0;
    scheduler.advance(1);
    expect(sink.chunks).toEqual(["a\r"]);
  });

  test("never drops a permanent line: it is written without the block, which comes back later", () => {
    const { sink, scheduler, region } = setup({ maxBacklogBytes: 100 });
    region.update(["a", "b"]);
    sink.writableLength = 1_000;
    expect(region.print("kept")).toBe(true);
    expect(sink.chunks[1]).toBe(`${CLEAR_1}${UP_CLEAR}kept\r\n`);
    expect(region.height).toBe(0);
    scheduler.advance(0);
    expect(sink.chunks).toHaveLength(2);
    region.print("kept too");
    expect(sink.chunks[2]).toBe("kept too\r\n");
    sink.writableLength = 0;
    scheduler.advance(500);
    expect(sink.chunks[3]).toBe("a\r\nb\r");
  });

  test("dies when the backlog cannot be read", () => {
    const { sink, region, failures } = setup();
    Object.defineProperty(sink, "writableLength", {
      get: () => {
        throw new Error("EBADF");
      },
    });
    region.update(["a"]);
    expect(region.state).toBe("dead");
    expect(failures).toHaveLength(1);
    expect(sink.chunks).toEqual([]);
  });

  test("an unreadable backlog never drops a printed line: it is written, then the repaint finds the stream broken", () => {
    const { sink, scheduler, region, failures } = setup();
    region.update(["a"]);
    Object.defineProperty(sink, "writableLength", {
      get: () => {
        throw new Error("EBADF");
      },
    });
    expect(region.print("kept")).toBe(true);
    expect(sink.chunks).toEqual(["a\r", `${CLEAR_1}kept\r\n`]);
    scheduler.advance(REPAINT_GAP_MS);
    expect(region.state).toBe("dead");
    expect(failures).toHaveLength(1);
    expect(sink.chunks).toHaveLength(2);
  });
});

test.describe("createLiveRegion — a failed write turns it off for good", () => {
  for (const [name, fail] of [
    ["a destroyed stream", (sink: FakeSink) => (sink.destroyed = true)],
    ["a write that throws (EIO)", (sink: FakeSink) => (sink.mode = "throw")],
    [
      "a write whose callback fails at once (EPIPE)",
      (sink: FakeSink) => (sink.mode = "callback-error"),
    ],
  ] as const) {
    test(name, () => {
      const { sink, scheduler, region, failures } = setup();
      region.update(["a"]);
      fail(sink);
      let printed: boolean | undefined;
      expect(() => (printed = region.print("line"))).not.toThrow();
      expect(printed).toBe(false);
      expect(region.state).toBe("dead");
      expect(failures).toHaveLength(1);
      const written = sink.chunks.length;
      sink.destroyed = false;
      sink.mode = "ok";
      expect(region.print("more")).toBe(false);
      region.update(["b"]);
      region.resize();
      region.close();
      scheduler.advance(5_000);
      expect(sink.chunks).toHaveLength(written);
      expect(scheduler.timers.size).toBe(0);
      expect(region.height).toBe(0);
      expect(region.width).toBe(0);
      expect(region.state).toBe("dead");
    });
  }

  test("a write that fails after it was taken (a terminal gone), and a pending draw with it", () => {
    const { sink, scheduler, region, failures } = setup();
    sink.mode = "late-error";
    region.update(["a"]);
    region.update(["b"]);
    expect(scheduler.timers.size).toBe(1);
    sink.failLater();
    expect(region.state).toBe("dead");
    expect(
      failures.map((error) => (error as NodeJS.ErrnoException).code),
    ).toEqual(["EIO"]);
    expect(scheduler.timers.size).toBe(0);
    sink.failLater();
    expect(failures).toHaveLength(1);
  });

  test("several writes in flight failing late are told once", () => {
    const { sink, scheduler, region, failures } = setup();
    sink.mode = "late-error";
    region.update(["a"]);
    expect(region.print("p1")).toBe(true);
    expect(region.print("p2")).toBe(true);
    scheduler.advance(REPAINT_GAP_MS);
    expect(sink.held).toBe(4);
    sink.failLater();
    expect(failures).toHaveLength(1);
    expect(region.state).toBe("dead");
    expect(region.width).toBe(0);
  });

  test("a caller's failure hook that throws does not escape", () => {
    const { sink, region } = setup({
      onFailure: () => {
        throw new Error("hook");
      },
    });
    sink.mode = "throw";
    expect(() => {
      region.update(["a"]);
    }).not.toThrow();
    expect(region.state).toBe("dead");
  });
});

test.describe("createLiveRegion — no live region", () => {
  test("only prints lines, with bare \\n: no drawing, no cursor movement, no timer", () => {
    const { sink, scheduler, region } = setup({
      capabilities: { live: false },
    });
    expect(region.state).toBe("passthrough");
    region.update(["a"]);
    region.resize();
    expect(region.print("line")).toBe(true);
    expect(region.print(["two", "three"])).toBe(true);
    region.close();
    expect(region.print("after\x1b[2A")).toBe(true);
    expect(sink.all).toBe("line\ntwo\nthree\nafter\n");
    expect(region.width).toBe(0);
    expect(scheduler.timers.size).toBe(0);
    expect(region.state).toBe("closed");
  });

  test("a passthrough region dies on a failed write too", () => {
    const { sink, region, failures } = setup({ capabilities: { live: false } });
    sink.mode = "callback-error";
    expect(region.print("line")).toBe(false);
    expect(region.state).toBe("dead");
    expect(region.print("more")).toBe(false);
    expect(failures).toHaveLength(1);
  });
});

test.describe("createLiveRegion — options", () => {
  test("refuses an interval or bound that is not a whole number from 0", () => {
    for (const bad of [-1, 1.5, Number.NaN, Infinity]) {
      expect(() => setup({ minIntervalMs: bad }), String(bad)).toThrow(
        RangeError,
      );
      expect(() => setup({ maxBacklogBytes: bad }), String(bad)).toThrow(
        RangeError,
      );
    }
  });

  test("refuses a terminal openLiveTerminal did not open", () => {
    const sink = new FakeSink();
    for (const terminal of [
      { sink, unblocked: true },
      sink,
      undefined,
    ] as unknown as LiveTerminal[])
      expect(() => setup({ terminal })).toThrow(TypeError);
  });

  test("bounds the backlog at 1 MiB by default", () => {
    const over = setup();
    over.sink.writableLength = 1024 * 1024 + 1;
    over.region.update(["a"]);
    expect(over.sink.chunks).toEqual([]);
    const at = setup();
    at.sink.writableLength = 1024 * 1024;
    at.region.update(["a"]);
    expect(at.sink.chunks).toEqual(["a\r"]);
  });

  test("the real scheduler's timers keep no process alive", () => {
    const handle = realScheduler.setTimeout(
      () => undefined,
      60_000,
    ) as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    realScheduler.clearTimeout(handle);
    expect(realScheduler.now()).toBeGreaterThan(0);
  });
});
