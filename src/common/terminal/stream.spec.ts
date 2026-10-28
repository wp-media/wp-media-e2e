import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { test, expect } from "@playwright/test";

import { runPaused } from "../__fixtures__/paused-pty";
import { runSlowlyRead } from "../__fixtures__/slow-reader";
import { removeTempDir } from "../__fixtures__/temp-dir";
import {
  backlogBytes,
  DRAIN_POLL_MS,
  drainTerminal,
  LiveTerminal,
  openLiveTerminal,
  stdoutTerminal,
  TERMINAL_BACKLOG_BYTES,
  unblockTerminal,
  writeSafely,
  type ByteSink,
} from "./stream";

/** This module, as a child imports it. */
const TERMINAL_MODULE = new URL("./stream.ts", import.meta.url).href;

/**
 * A stream stand-in with Node's internal handle.
 *
 * @param isTTY - whether it is a terminal.
 * @param setBlocking - the handle's `setBlocking`, or anything in its place.
 */
function stream(isTTY: boolean | undefined, setBlocking: unknown) {
  const calls: unknown[][] = [];
  const handle = {
    setBlocking:
      typeof setBlocking === "function"
        ? (...args: unknown[]) => {
            calls.push(args);
            return (setBlocking as (...a: unknown[]) => unknown)(...args);
          }
        : setBlocking,
  };
  return { stream: { isTTY, _handle: handle }, calls };
}

test.describe("unblockTerminal", () => {
  test("makes a terminal's handle non-blocking", () => {
    const { stream: tty, calls } = stream(true, () => 0);
    expect(unblockTerminal(tty)).toBe(true);
    expect(calls).toEqual([[false]]);
  });

  test("leaves a stream that is not a terminal alone", () => {
    for (const isTTY of [false, undefined]) {
      const { stream: pipe, calls } = stream(isTTY, () => 0);
      expect(unblockTerminal(pipe)).toBe(false);
      expect(calls).toEqual([]);
    }
  });

  test("changes nothing when Node offers no such handle, and never throws", () => {
    expect(unblockTerminal({ isTTY: true })).toBe(false);
    expect(
      unblockTerminal(Object.assign({ isTTY: true }, { _handle: null })),
    ).toBe(false);
    expect(unblockTerminal(stream(true, "not a function").stream)).toBe(false);
    expect(
      unblockTerminal(
        stream(true, () => {
          throw new Error("EBADF");
        }).stream,
      ),
    ).toBe(false);
  });

  test("says so when the handle refuses", () => {
    expect(unblockTerminal(stream(true, () => -22).stream)).toBe(false);
  });
});

test.describe("stdoutTerminal", () => {
  test("is standard output by default", () => {
    expect(stdoutTerminal()).toBe(process.stdout);
  });

  test("makes a terminal non-blocking on first use, and only then", () => {
    const { stream: tty, calls } = stream(true, () => 0);
    const terminal = Object.assign(tty, {
      write: () => true,
      on: () => undefined,
      writableLength: 0,
    });
    expect(stdoutTerminal(terminal)).toBe(terminal);
    expect(stdoutTerminal(terminal)).toBe(terminal);
    expect(calls).toEqual([[false]]);
  });
});

test.describe("drainTerminal", () => {
  test("settles at once, taken, when nothing waits, or the stream is destroyed", async () => {
    expect(await drainTerminal({ writableLength: 0 }, 1_000)).toBe(true);
    expect(
      await drainTerminal({ writableLength: 10, destroyed: true }, 1_000),
    ).toBe(true);
  });

  test("waits until the terminal has taken what waits for it", async () => {
    let backlog = 4096;
    setTimeout(() => (backlog = 0), 60);
    const started = performance.now();
    expect(
      await drainTerminal(
        {
          get writableLength() {
            return backlog;
          },
        },
        5_000,
      ),
    ).toBe(true);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(55);
    expect(waited).toBeLessThan(60 + 20 * DRAIN_POLL_MS);
  });

  test("gives up on a stalled terminal after its wait, untaken", async () => {
    const started = performance.now();
    expect(await drainTerminal({ writableLength: 1 }, 50)).toBe(false);
    const waited = performance.now() - started;
    expect(waited).toBeGreaterThanOrEqual(49);
    expect(waited).toBeLessThan(1_000);
  });

  test("never rejects, even when the stream's getter throws", async () => {
    const throwing = {
      get writableLength(): number {
        throw new Error("EBADF");
      },
    };
    await expect(drainTerminal(throwing, 50)).resolves.toBe(true);
  });

  test("refuses a wait that is not a whole number of milliseconds a timer takes", () => {
    for (const wait of [-1, 1.5, Number.NaN, Infinity, 2 ** 31])
      expect(
        () => drainTerminal({ writableLength: 0 }, wait),
        String(wait),
      ).toThrow(RangeError);
  });

  /** A child writing 1 MiB in lines to its standard output, then exiting `0`; `drain` waits first. */
  function burst(drain: string): string {
    return `
      import { drainTerminal } from ${JSON.stringify(TERMINAL_MODULE)};
      let text = "";
      for (let i = 0; i < 8192; i++) text += "line " + String(i).padStart(5, "0") + " " + "y".repeat(116) + "\\n";
      process.stdout.write(text);
      ${drain}
      process.exit(0);
    `;
  }

  test("keeps what a process writes just before process.exit, when the reader is slower", async () => {
    // Without it, the exit cuts what the non-blocking stream still queued: the control shows the loss.
    const cut = await runSlowlyRead(burst(""), 300);
    expect(cut.code).toBe(0);
    expect(cut.stdout.length).toBeLessThan(1024 * 1024);
    const kept = await runSlowlyRead(
      burst("await drainTerminal(process.stdout, 15000);"),
      300,
    );
    expect(kept.code).toBe(0);
    expect(kept.stdout.length).toBe(1024 * 1024);
  });

  test("cannot hold a process past its wait when nobody reads", async () => {
    const result = await runSlowlyRead(
      burst(
        "const taken = await drainTerminal(process.stdout, 300); process.stderr.write(String(taken));",
      ),
      undefined,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("false");
    expect(result.ranMs).toBeLessThan(10_000);
  });
});

test.describe("writeSafely", () => {
  /**
   * A sink whose `write` does `behaviour`, recording what it was given.
   *
   * @param behaviour - what `write` does with its callback.
   */
  function sink(behaviour: (callback: (error?: Error | null) => void) => void) {
    const written: Uint8Array[] = [];
    const target: ByteSink & { destroyed: boolean } = {
      writableLength: 0,
      destroyed: false,
      write: (chunk, callback) => {
        written.push(chunk);
        behaviour(callback);
        return true;
      },
    };
    return { target, written };
  }

  test("hands the chunk over and reports nothing when it is written", () => {
    const { target, written } = sink((callback) => {
      callback();
    });
    const failures: Error[] = [];
    expect(writeSafely(target, Buffer.from("a"), (e) => failures.push(e))).toBe(
      true,
    );
    expect(written).toHaveLength(1);
    expect(failures).toEqual([]);
  });

  test("reports a callback error (EPIPE), even one that arrives later", () => {
    let later: ((error?: Error | null) => void) | undefined;
    const { target } = sink((callback) => (later = callback));
    const failures: Error[] = [];
    expect(writeSafely(target, Buffer.from("a"), (e) => failures.push(e))).toBe(
      true,
    );
    expect(failures).toEqual([]);
    later?.(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
    expect(failures.map((e) => e.message)).toEqual(["write EPIPE"]);
    later?.(null);
    expect(failures).toHaveLength(1);
  });

  test("never throws: a destroyed stream or a throwing write is reported at once", () => {
    const failures: Error[] = [];
    const destroyed = sink(() => undefined);
    destroyed.target.destroyed = true;
    expect(
      writeSafely(destroyed.target, Buffer.from("a"), (e) => failures.push(e)),
    ).toBe(false);
    expect(destroyed.written).toEqual([]);
    const throwing = sink(() => {
      throw new Error("write EIO");
    });
    expect(
      writeSafely(throwing.target, Buffer.from("a"), (e) => failures.push(e)),
    ).toBe(false);
    const odd = sink(() => {
      // Not an Error: still reported as one.
      throw "EIO"; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    expect(
      writeSafely(odd.target, Buffer.from("a"), (e) => failures.push(e)),
    ).toBe(false);
    expect(failures.map((e) => e.message)).toEqual([
      "The stream is destroyed.",
      "write EIO",
      "EIO",
    ]);
  });
});

test.describe("writeSafely — at most once", () => {
  test("a write that calls back with an error and then throws is reported once", () => {
    const failures: Error[] = [];
    const target: ByteSink = {
      writableLength: 0,
      write: (_chunk, callback) => {
        callback(new Error("write EPIPE"));
        throw new Error("write EIO");
      },
    };
    expect(writeSafely(target, Buffer.from("a"), (e) => failures.push(e))).toBe(
      false,
    );
    expect(failures.map((e) => e.message)).toEqual(["write EPIPE"]);
  });

  test("a failure hook that throws escapes neither the write nor a late callback, and is not called again", () => {
    let calls = 0;
    const hook = (): void => {
      calls++;
      throw new Error("hook");
    };
    const destroyed: ByteSink = {
      writableLength: 0,
      destroyed: true,
      write: () => true,
    };
    expect(writeSafely(destroyed, Buffer.from("a"), hook)).toBe(false);
    expect(calls).toBe(1);
    let later: ((error?: Error | null) => void) | undefined;
    const pending: ByteSink = {
      writableLength: 0,
      write: (_chunk, callback) => {
        later = callback;
        return true;
      },
    };
    expect(writeSafely(pending, Buffer.from("a"), hook)).toBe(true);
    expect(() => later?.(new Error("write EIO"))).not.toThrow();
    later?.(new Error("write EIO"));
    expect(calls).toBe(2);
  });
});

test.describe("openLiveTerminal", () => {
  /**
   * A terminal stand-in: Node's internal handle, and its `error` listeners.
   *
   * @param isTTY - whether it is a terminal.
   */
  function fakeTerminal(isTTY: boolean) {
    const listeners: ((error: Error) => void)[] = [];
    const blocking: unknown[] = [];
    const target = {
      isTTY,
      writableLength: 0,
      destroyed: false,
      _handle: {
        setBlocking: (value: unknown) => {
          blocking.push(value);
          return 0;
        },
      },
      write: () => true,
      on(event: "error", listener: (error: Error) => void) {
        expect(event).toBe("error");
        listeners.push(listener);
        return this;
      },
    };
    return { target, listeners, blocking };
  }

  test("makes a terminal non-blocking and hears its error event, once per stream", () => {
    const { target, listeners, blocking } = fakeTerminal(true);
    const terminal = openLiveTerminal(target);
    expect(terminal.sink).toBe(target);
    expect(terminal.unblocked).toBe(true);
    expect(blocking).toEqual([false]);
    expect(listeners).toHaveLength(1);
    expect(() => listeners[0]?.(new Error("write EPIPE"))).not.toThrow();
    expect(openLiveTerminal(target)).toBe(terminal);
    expect(listeners).toHaveLength(1);
    expect(blocking).toHaveLength(1);
  });

  test("hears a pipe's error event too, leaving it as it is", () => {
    const { target, listeners, blocking } = fakeTerminal(false);
    const terminal = openLiveTerminal(target);
    expect(terminal.unblocked).toBe(false);
    expect(blocking).toEqual([]);
    expect(listeners).toHaveLength(1);
  });

  test("still opens a stream that refuses the listener", () => {
    const { target } = fakeTerminal(false);
    target.on = () => {
      throw new Error("no events");
    };
    expect(openLiveTerminal(target).sink).toBe(target);
  });

  test("is standard output by default, and only it brands a terminal", () => {
    const terminal = openLiveTerminal();
    expect(terminal.sink).toBe(process.stdout);
    expect(LiveTerminal.isOpened(terminal)).toBe(true);
    for (const lookAlike of [
      { sink: process.stdout, unblocked: false },
      null,
      undefined,
      "terminal",
    ])
      expect(LiveTerminal.isOpened(lookAlike)).toBe(false);
  });

  test("shares the backlog bound with the orchestrator's logger: 1 MiB", () => {
    expect(TERMINAL_BACKLOG_BYTES).toBe(1024 * 1024);
  });
});

test.describe("openLiveTerminal — real streams", () => {
  let dir = "";
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-live-terminal-"));
  });
  test.afterEach(() => {
    removeTempDir(dir);
    dir = "";
  });

  /** The live region, as a child imports it. */
  const LIVE_MODULE = new URL("./live.ts", import.meta.url).href;

  /**
   * A child printing 2,000 lines through a passthrough region, one per millisecond, then saying how
   * it ended on its standard error. `open` false writes the same lines with `writeSafely` and no
   * `error` listener: the control.
   *
   * @param open - whether the stream goes through `openLiveTerminal`.
   */
  function printer(open: boolean): string {
    return `
      import { setTimeout as delay } from "node:timers/promises";
      import { openLiveTerminal, writeSafely } from ${JSON.stringify(TERMINAL_MODULE)};
      import { createLiveRegion } from ${JSON.stringify(LIVE_MODULE)};
      let failures = 0;
      const region = ${String(open)} ? createLiveRegion({ terminal: openLiveTerminal(), capabilities: { live: false }, size: () => process.stdout, ellipsis: "…", onFailure: () => failures++ }) : undefined;
      for (let i = 0; i < 2000; i++) {
        const line = "line " + String(i);
        if (region) region.print(line); else writeSafely(process.stdout, Buffer.from(line + "\\n"), () => failures++);
        await delay(1);
      }
      process.stderr.write("done state=" + (region?.state ?? "none") + " failures=" + String(failures));
    `;
  }

  /**
   * Runs {@link printer} with its standard output a pipe closed after its first chunk, as
   * `| head -c 20` does.
   *
   * @param open - see {@link printer}.
   */
  async function closedEarly(
    open: boolean,
  ): Promise<{ code: number | null; stderr: string }> {
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        printer(open),
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH, HOME: process.env.HOME },
      },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.stdout.once("data", () => child.stdout.destroy());
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const [code] = (await once(child, "close")) as [number | null];
    clearTimeout(killer);
    return { code, stderr };
  }

  test("a pipe closed early (EPIPE) kills the region, not the process", async () => {
    const result = await closedEarly(true);
    expect(result.stderr).toBe("done state=dead failures=1");
    expect(result.code).toBe(0);
  });

  test("control: without its error listener, the same closed pipe crashes the process", async () => {
    const result = await closedEarly(false);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("EPIPE");
  });

  /**
   * A child flooding its standard output, a pty nobody reads, with 4 MB through a live region, then
   * leaving `ticked` in `marker` from a timer and exiting. `open` false writes it with
   * `process.stdout.write`, blocking: the control.
   *
   * @param open - whether the stream goes through `openLiveTerminal`.
   * @param marker - the file the timer writes.
   */
  function flooder(open: boolean, marker: string): string {
    return `
      import { writeFileSync } from "node:fs";
      import { openLiveTerminal } from ${JSON.stringify(TERMINAL_MODULE)};
      import { createLiveRegion } from ${JSON.stringify(LIVE_MODULE)};
      const region = ${String(open)} ? createLiveRegion({ terminal: openLiveTerminal(), capabilities: { live: true }, size: () => ({ columns: 80, rows: 24 }), ellipsis: "…" }) : undefined;
      const line = "x".repeat(99);
      for (let i = 0; i < 40000; i++) region ? region.print(line) : process.stdout.write(line + "\\n");
      setTimeout(() => { writeFileSync(${JSON.stringify(marker)}, "ticked"); process.exit(0); }, 100);
    `;
  }

  for (const open of [true, false])
    test(
      open
        ? "a paused terminal does not freeze the event loop: a timer fires behind 4 MB nobody reads"
        : "control: a blocking terminal nobody reads freezes the event loop: the timer never fires",
      async () => {
        const marker = join(dir, "ticked");
        const ran = await runPaused(flooder(open, marker), () =>
          existsSync(marker),
        );
        test.skip(ran === "no-pty", "script is not installed");
        expect(ran).toBe(open ? "done" : "stuck");
        if (open) expect(readFileSync(marker, "utf8")).toBe("ticked");
      },
    );
});

test.describe("backlogBytes", () => {
  test("is the queue's length", () => {
    expect(backlogBytes({ writableLength: 0 })).toBe(0);
    expect(backlogBytes({ writableLength: 4096 })).toBe(4096);
  });

  test("is undefined for a broken stream: a getter that throws, or no length", () => {
    const throwing = {
      get writableLength(): number {
        throw new Error("EBADF");
      },
    };
    expect(backlogBytes(throwing)).toBeUndefined();
    for (const length of [-1, 1.5, Number.NaN, Infinity])
      expect(
        backlogBytes({ writableLength: length }),
        String(length),
      ).toBeUndefined();
  });
});
