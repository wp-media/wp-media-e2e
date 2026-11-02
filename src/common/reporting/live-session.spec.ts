import { setTimeout as delay } from "node:timers/promises";

import { test, expect } from "@playwright/test";

import {
  FakeExit,
  FakeScheduler,
  FakeTerminal,
} from "../__fixtures__/terminal-fakes";
import { DEFAULT_MIN_INTERVAL_MS } from "../terminal/live";
import {
  LiveSession,
  maxRows,
  SIGNAL_DRAIN_MS,
  TICK_MS,
  type LiveSessionOptions,
} from "./live-session";

/**
 * The live session on fake streams and a fake clock: the block drawn, redrawn on its tick and on a
 * resize; foreign writes printed above it once, never looping; and each way it ends — close, the
 * process exiting, a failed write — clearing the block and putting back the streams, the listeners
 * and the tick.
 */

/** Clearing one row: the cursor contract's spelling. */
const CLEAR_1 = "\r\x1b[2K";

/** A session on fake streams, and what it was given. */
function harness(
  options: {
    readonly stderrTTY?: boolean;
    readonly rows?: (n: number) => string[];
  } = {},
) {
  const errors: unknown[] = [];
  const stdout = new FakeTerminal(true);
  const stderr = new FakeTerminal(options.stderrTTY ?? true);
  const exit = new FakeExit();
  const scheduler = new FakeScheduler();
  const geometries: { width: number; maxRows: number }[] = [];
  let draws = 0;
  let failures = 0;
  const rowsOf = options.rows ?? ((n: number) => [`B${String(n)}`]);
  const config: LiveSessionOptions = {
    deps: {
      stdout: stdout as never,
      stderr: stderr,
      exit,
      signals: exit,
      scheduler,
    },
    capabilities: { live: true },
    ellipsis: "…",
    onError: (error) => errors.push(error),
    rows: (geometry) => {
      geometries.push(geometry);
      draws += 1;
      return rowsOf(draws);
    },
    onFailure: () => {
      failures += 1;
    },
  };
  const session = new LiveSession(config);
  return {
    session,
    stdout,
    stderr,
    exit,
    scheduler,
    geometries,
    draws: () => draws,
    failures: () => failures,
    errors,
  };
}

/** Calls a stream's current `write`, as a foreign writer would. */
function write(stream: FakeTerminal, text: string): void {
  stream.write(text);
}

test.describe("LiveSession — drawing", () => {
  test("draws the block at once, cut to the terminal: width, and rows less one", () => {
    const h = harness();
    expect(h.stdout.all).toBe("B1\r");
    expect(h.geometries).toEqual([{ width: 80, maxRows: 23 }]);
    expect(h.session.state).toBe("live");
  });

  test("redraws on its tick, which the region throttles to two a second", () => {
    const h = harness();
    h.scheduler.advance(TICK_MS);
    expect(h.draws()).toBe(2);
    expect(h.stdout.all).toBe(`B1\r${CLEAR_1}B2\r`);
    h.scheduler.advance(TICK_MS * 3);
    expect(h.draws()).toBe(5);
    expect(TICK_MS).toBeGreaterThanOrEqual(DEFAULT_MIN_INTERVAL_MS);
  });

  test("a resize erases the old block and draws it again at the new size", () => {
    const h = harness();
    h.stdout.columns = 60;
    h.stdout.rows = 10;
    h.stdout.emit("resize");
    expect(h.geometries.at(-1)).toEqual({ width: 60, maxRows: 9 });
    h.scheduler.advance(DEFAULT_MIN_INTERVAL_MS);
    expect(h.stdout.all).toContain("\x1b7\x1b[1B\x1b[J\x1b8");
    // Drawn again after the erase: the newest rows (the tick may have asked for them too).
    const erase = h.stdout.all.lastIndexOf("\x1b8");
    expect(h.stdout.all.slice(erase)).toBe(`\x1b8B${String(h.draws())}\r`);
  });
});

test.describe("LiveSession — foreign writes", () => {
  test("a line written to stdout or a terminal stderr prints above the block, once; its region bytes never loop", () => {
    const h = harness();
    write(h.stdout, "[warn] from a library\n");
    write(h.stderr, "(node:1) Warning: x\n");
    expect(h.stdout.all).toBe(
      `B1\r${CLEAR_1}[warn] from a library\r\n(node:1) Warning: x\r\n`,
    );
    expect(h.stderr.chunks).toEqual([]);
    h.scheduler.advance(DEFAULT_MIN_INTERVAL_MS);
    expect(h.stdout.all.endsWith("\r\nB1\r")).toBe(true);
    expect(h.stdout.all.split("[warn] from a library")).toHaveLength(2);
  });

  test("a foreign line is masked before it prints: a URL's password, a token", () => {
    const h = harness();
    write(h.stderr, "GET https://admin:hunter2pw@site.test/x\n");
    write(h.stdout, "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n");
    expect(h.stdout.all).not.toContain("hunter2pw");
    expect(h.stdout.all).not.toContain(
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    );
    expect(h.stdout.all).toContain("GET https://***@site.test/x\r\n");
  });

  test("a redirected stderr (no terminal) is not captured: it keeps its bytes", () => {
    const h = harness({ stderrTTY: false });
    expect(Object.hasOwn(h.stderr, "write")).toBe(false);
    write(h.stderr, "to the file\n");
    expect(h.stderr.all).toBe("to the file\n");
  });

  test("print puts the reporter's own lines above the block; after close they are plain lines", () => {
    const h = harness();
    expect(h.session.print(["✔ a"])).toBe(true);
    expect(h.stdout.all).toBe(`B1\r${CLEAR_1}✔ a\r\n`);
    h.session.close();
    expect(h.session.print(["✔ b"])).toBe(true);
    expect(h.stdout.all.endsWith("✔ b\n")).toBe(true);
  });
});

test.describe("LiveSession — every way it ends", () => {
  /** The session's traces are all gone: streams, listeners, tick. */
  function expectUndone(h: ReturnType<typeof harness>): void {
    expect(Object.hasOwn(h.stdout, "write")).toBe(false);
    expect(Object.hasOwn(h.stderr, "write")).toBe(false);
    expect(h.stdout.listenerCount("resize")).toBe(0);
    expect(h.exit.count).toBe(0);
    expect(h.exit.total).toBe(0);
    expect(h.scheduler.timers.size).toBe(0);
  }

  test("close clears the block, puts back the streams and listeners, stops the tick; idempotent", () => {
    const h = harness();
    expect(Object.hasOwn(h.stdout, "write")).toBe(true);
    expect(h.stdout.listenerCount("resize")).toBe(1);
    expect(h.exit.count).toBe(1);
    expect(h.exit.listenerCount("SIGTERM")).toBe(1);
    expect(h.exit.listenerCount("SIGHUP")).toBe(1);
    write(h.stdout, "open line");
    h.session.close();
    h.session.close();
    expect(h.session.state).toBe("closed");
    expect(h.stdout.all).toBe(`B1\r${CLEAR_1}open line`);
    expectUndone(h);
    h.scheduler.advance(10_000);
    h.session.refresh();
    expect(h.draws()).toBe(1);
  });

  test("the process exiting closes it", () => {
    const h = harness();
    h.exit.emit();
    expect(h.session.state).toBe("closed");
    expectUndone(h);
  });

  for (const signal of ["SIGTERM", "SIGHUP"] as const)
    test(`${signal} clears it and puts everything back, then sends ${signal} again once the terminal took that`, async () => {
      const h = harness();
      h.exit.emit(signal);
      expect(h.session.state).toBe("closed");
      expect(h.stdout.all).toBe(`B1\r${CLEAR_1}`);
      expectUndone(h);
      // Sent again only after the drain, so the clear is not lost to the signal.
      expect(h.exit.kills).toEqual([]);
      await expect
        .poll(() => h.exit.kills, { timeout: SIGNAL_DRAIN_MS * 4 })
        .toEqual([[h.exit.pid, signal]]);
    });

  test("a signal waits for the terminal to take the cleared block before it is sent again", async () => {
    const h = harness();
    h.stdout.writableLength = 10;
    h.exit.emit("SIGTERM");
    await delay(100);
    expect(h.exit.kills).toEqual([]);
    h.stdout.writableLength = 0;
    await expect
      .poll(() => h.exit.kills, { timeout: SIGNAL_DRAIN_MS * 4 })
      .toEqual([[h.exit.pid, "SIGTERM"]]);
  });

  test("a signal someone else handles too is not sent again: their listener decides", async () => {
    const h = harness();
    const theirs = (): void => undefined;
    h.exit.on("SIGTERM", theirs);
    h.exit.emit("SIGTERM");
    expect(h.session.state).toBe("closed");
    await delay(SIGNAL_DRAIN_MS + 100);
    expect(h.exit.kills).toEqual([]);
    expect(h.exit.listenerCount("SIGTERM")).toBe(1);
  });

  test("a signal after close is not the session's: nothing is sent", async () => {
    const h = harness();
    h.session.close();
    h.exit.emit("SIGTERM");
    await delay(50);
    expect(h.exit.kills).toEqual([]);
  });

  test("a resize after close draws nothing", () => {
    const h = harness();
    h.session.close();
    const before = h.stdout.all;
    h.stdout.emit("resize");
    expect(h.stdout.all).toBe(before);
  });

  test("a failed write kills it: the owner told once, everything undone, nothing more written", () => {
    const h = harness();
    h.stdout.mode = "throw";
    expect(h.session.print(["✔ a"])).toBe(false);
    expect(h.session.state).toBe("dead");
    expect(h.failures()).toBe(1);
    expectUndone(h);
    h.stdout.mode = "ok";
    expect(h.session.print(["✔ b"])).toBe(false);
    h.session.close();
    expect(h.session.state).toBe("dead");
    expect(h.failures()).toBe(1);
  });

  test("a write failing in its callback kills it too, from a foreign line", () => {
    const h = harness();
    h.stdout.mode = "callback-error";
    write(h.stdout, "late\n");
    expect(h.session.state).toBe("dead");
    expect(h.failures()).toBe(1);
    expectUndone(h);
  });

  test("an owner's hook that throws is swallowed", () => {
    const stdout = new FakeTerminal(true);
    const session = new LiveSession({
      deps: {
        stdout: stdout as never,
        stderr: new FakeTerminal(false),
        exit: new FakeExit(),
        signals: new FakeExit(),
        scheduler: new FakeScheduler(),
      },
      capabilities: { live: true },
      ellipsis: "…",
      rows: () => ["x"],
      onFailure: () => {
        throw new Error("hook");
      },
    });
    stdout.mode = "throw";
    expect(() => session.print(["a"])).not.toThrow();
    expect(session.state).toBe("dead");
  });
});

test.describe("LiveSession — a rows source that throws", () => {
  /** A source that draws `good` times, then throws. */
  function failingAfter(good: number): (n: number) => string[] {
    return (n) => {
      if (n > good) throw new Error(`rows ${String(n)}`);
      return [`B${String(n)}`];
    };
  }

  test("on the first draw: the constructor does not throw and leaves nothing in place; onError told", () => {
    const h = harness({ rows: failingAfter(0) });
    expect(h.session.state).toBe("closed");
    expect(Object.hasOwn(h.stdout, "write")).toBe(false);
    expect(Object.hasOwn(h.stderr, "write")).toBe(false);
    expect(h.stdout.listenerCount("resize")).toBe(0);
    expect(h.exit.total).toBe(0);
    expect(h.scheduler.timers.size).toBe(0);
    expect(h.errors.map(String)).toEqual(["Error: rows 1"]);
  });

  test("on a tick: nothing escapes the timer; the session closes, the block cleared", () => {
    const h = harness({ rows: failingAfter(1) });
    expect(() => {
      h.scheduler.advance(TICK_MS);
    }).not.toThrow();
    expect(h.session.state).toBe("closed");
    expect(h.stdout.all).toBe(`B1\r${CLEAR_1}`);
    expect(Object.hasOwn(h.stdout, "write")).toBe(false);
    expect(h.exit.total).toBe(0);
    expect(h.scheduler.timers.size).toBe(0);
    expect(h.errors).toHaveLength(1);
  });

  test("on a resize or a refresh: nothing escapes; the session closes once", () => {
    const h = harness({ rows: failingAfter(1) });
    expect(() => {
      h.stdout.emit("resize");
    }).not.toThrow();
    expect(h.session.state).toBe("closed");
    expect(h.stdout.listenerCount("resize")).toBe(0);
    const r = harness({ rows: failingAfter(1) });
    expect(() => {
      r.session.refresh();
    }).not.toThrow();
    expect(r.session.state).toBe("closed");
    expect(r.errors).toHaveLength(1);
  });

  test("an onError hook that throws is swallowed", () => {
    const stdout = new FakeTerminal(true);
    const session = new LiveSession({
      deps: {
        stdout: stdout as never,
        stderr: new FakeTerminal(false),
        exit: new FakeExit(),
        signals: new FakeExit(),
        scheduler: new FakeScheduler(),
      },
      capabilities: { live: true },
      ellipsis: "…",
      rows: () => {
        throw new Error("rows");
      },
      onFailure: () => undefined,
      onError: () => {
        throw new Error("hook");
      },
    });
    expect(session.state).toBe("closed");
    expect(Object.hasOwn(stdout, "write")).toBe(false);
  });
});

test.describe("LiveSession — drain", () => {
  test("waits for the queue, then makes the terminal blocking again (it had made it non-blocking)", async () => {
    const h = harness();
    expect(h.stdout.blocking).toEqual([false]);
    h.session.close();
    expect(await h.session.drain(50)).toBe(true);
    expect(h.stdout.blocking).toEqual([false, true]);
  });

  test("a terminal the session could not make non-blocking is left as it is after the drain", async () => {
    const stdout = new FakeTerminal(true);
    const calls: boolean[] = [];
    Object.defineProperty(stdout, "_handle", {
      value: {
        setBlocking: (blocking: boolean): number => {
          calls.push(blocking);
          return -1;
        },
      },
    });
    const session = new LiveSession({
      deps: {
        stdout: stdout as never,
        stderr: new FakeTerminal(false),
        exit: new FakeExit(),
        signals: new FakeExit(),
        scheduler: new FakeScheduler(),
      },
      capabilities: { live: true },
      ellipsis: "…",
      rows: () => ["x"],
      onFailure: () => undefined,
    });
    session.close();
    expect(await session.drain(50)).toBe(true);
    expect(calls).toEqual([false]);
  });

  test("a terminal still holding bytes stays non-blocking: a blocking write would freeze the process", async () => {
    const h = harness();
    h.session.close();
    h.stdout.writableLength = 10;
    expect(await h.session.drain(30)).toBe(false);
    expect(h.stdout.blocking).toEqual([false]);
  });
});

test.describe("maxRows", () => {
  test("the terminal's rows less one; 0 for an unknown, zero or one-row terminal", () => {
    expect(maxRows(24)).toBe(23);
    expect(maxRows(2)).toBe(1);
    for (const rows of [undefined, 0, 1, -3, 2.5, Number.NaN])
      expect(maxRows(rows)).toBe(0);
  });
});
