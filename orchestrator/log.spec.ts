import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  clockTime,
  createLogger,
  DEFAULT_WAIT_MS,
  formatFileLine,
  formatLine,
  localIsoTime,
  MAX_SCOPE_LENGTH,
  openLogFile,
  openLogger,
  pathKind,
  refuseLogFile,
  systemCode,
  TERMINAL_BACKLOG_BYTES,
  type LogFile,
  type Terminal,
} from "./log";
import { runSlowlyRead } from "../src/common/__fixtures__/slow-reader";

/** A fixed local time, so a line's clock reads the same in every time zone: 10:15:30. */
const AT = new Date(2026, 9, 13, 10, 15, 30);

/** {@link AT} as a file line starts with; {@link localIsoTime} is tested on its own, by zone. */
const F = localIsoTime(AT);

/** A system error with a code, as Node raises one. */
function systemError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: failed`), { code });
}

/**
 * Runs `body` in the time zone `zone`, then restores the process's own. Node reads `TZ` again when
 * it is assigned, so local time follows at once.
 *
 * @param zone - an IANA zone.
 * @param body - the test's code.
 */
function inZone(zone: string, body: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = zone;
  try {
    body();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

/** A file stand-in: what was appended, in order; each append may be held or made to fail. */
function fakeFile(
  append: (text: string) => Promise<void> = () => Promise.resolve(),
) {
  const lines: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let closed = 0;
  const file: LogFile = {
    async append(text) {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        await append(text);
        lines.push(text);
      } finally {
        inFlight--;
      }
    },
    close() {
      closed++;
      return Promise.resolve();
    },
  };
  return {
    file,
    lines,
    maxInFlight: () => maxInFlight,
    closed: () => closed,
  };
}

/** A terminal collecting what it is written; `fail` makes its writes fail with that code. */
function fakeTerminal(fail?: string) {
  const written: string[] = [];
  const terminal = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (fail !== undefined) {
        callback(systemError(fail));
        return;
      }
      written.push(chunk.toString());
      callback();
    },
  });
  return { terminal, written };
}

/** A promise and the function that settles it. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Lets pending callbacks and `error` events run. */
function tick(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

test.describe("clockTime", () => {
  test("shows local hours, minutes and seconds, each two digits", () => {
    expect(clockTime(new Date(2026, 9, 13, 9, 5, 3))).toBe("09:05:03");
    expect(clockTime(new Date(2026, 9, 13, 23, 59, 59))).toBe("23:59:59");
  });

  test("shows midnight as 00:00:00, not 24:00:00", () => {
    expect(clockTime(new Date(2026, 9, 14, 0, 0, 0))).toBe("00:00:00");
  });

  test("shows local time, not UTC", () => {
    inZone("America/New_York", () => {
      expect(clockTime(new Date(Date.UTC(2026, 9, 13, 14, 5, 3)))).toBe(
        "10:05:03",
      );
    });
  });
});

test.describe("localIsoTime", () => {
  test("shows the local date, time and offset from UTC", () => {
    inZone("Europe/Madrid", () => {
      expect(localIsoTime(new Date(Date.UTC(2026, 9, 13, 8, 5, 3)))).toBe(
        "2026-10-13T10:05:03+02:00",
      );
    });
  });

  test("shows UTC as +00:00, and the local date when it differs from UTC's", () => {
    inZone("UTC", () => {
      expect(localIsoTime(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
        "2026-01-02T03:04:05+00:00",
      );
    });
    inZone("America/Los_Angeles", () => {
      expect(localIsoTime(new Date(Date.UTC(2026, 0, 1, 3, 0, 0)))).toBe(
        "2025-12-31T19:00:00-08:00",
      );
    });
  });

  test("shows a half-hour offset on either side of UTC", () => {
    inZone("Asia/Kolkata", () => {
      expect(localIsoTime(new Date(Date.UTC(2026, 9, 13, 0, 0, 0)))).toBe(
        "2026-10-13T05:30:00+05:30",
      );
    });
    inZone("America/St_Johns", () => {
      expect(localIsoTime(new Date(Date.UTC(2026, 9, 13, 12, 0, 0)))).toBe(
        "2026-10-13T09:30:00-02:30",
      );
    });
  });

  test("tells apart the hour a fall-back to winter time repeats", () => {
    inZone("America/New_York", () => {
      const first = localIsoTime(new Date(Date.UTC(2026, 10, 1, 5, 30, 0)));
      const second = localIsoTime(new Date(Date.UTC(2026, 10, 1, 6, 30, 0)));
      expect(first).toBe("2026-11-01T01:30:00-04:00");
      expect(second).toBe("2026-11-01T01:30:00-05:00");
    });
  });
});

test.describe("formatLine and formatFileLine", () => {
  test("read time, scope, two spaces, then the text", () => {
    expect(formatLine(AT, "bpng", "bpng-12 started")).toBe(
      "10:15:30 bpng  bpng-12 started",
    );
    expect(formatFileLine(AT, "bpng", "bpng-12 started")).toBe(
      `${F} bpng  bpng-12 started`,
    );
  });

  test("masks a secret value as written, URL-encoded and JSON-escaped, in the text and the scope", () => {
    const secret = 'pa"ss/w rd&12';
    const line = formatLine(
      AT,
      `x${secret}`,
      [
        `plain ${secret}`,
        `url ${encodeURIComponent(secret)}`,
        `json ${JSON.stringify(secret)}`,
        `php ${JSON.stringify(secret).replaceAll("/", "\\/")}`,
      ].join(" "),
      [secret],
    );
    expect(line).toBe('10:15:30 x***  plain *** url *** json "***" php "***"');
  });

  test("masks credentials by their shape, with no value given", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const line = formatLine(
      AT,
      "bpng",
      `https://user:hunter22@example.test/ and ${token}`,
    );
    expect(line).not.toContain("hunter22");
    expect(line).not.toContain(token);
    expect(line).toContain("***");
  });

  test("masks a secret split by a terminal code or a zero-width character", () => {
    const line = formatLine(
      AT,
      "bpng",
      "a secr\u001b[31metvalue1 and secret​value1",
      ["secretvalue1"],
    );
    expect(line).toBe("10:15:30 bpng  a *** and ***");
  });

  test("flattens a text of several lines into one line", () => {
    expect(formatLine(AT, "bpng", "one\ntwo\r\n  three four\tfive")).toBe(
      "10:15:30 bpng  one two three four five",
    );
  });

  test("cuts a text past 2000 code points with an ellipsis", () => {
    const text = formatLine(AT, "bpng", "x".repeat(5000)).split("  ")[1] ?? "";
    expect(Array.from(text)).toHaveLength(2000);
    expect(text.endsWith("…")).toBe(true);
  });

  test("cuts a scope past 40 code points with an ellipsis", () => {
    expect(MAX_SCOPE_LENGTH).toBe(40);
    expect(formatLine(AT, "s".repeat(40), "t")).toBe(
      `10:15:30 ${"s".repeat(40)}  t`,
    );
    expect(formatLine(AT, "s".repeat(41), "t")).toBe(
      `10:15:30 ${"s".repeat(39)}…  t`,
    );
  });
});

test.describe("createLogger", () => {
  test("writes the line to the terminal with its time and to the file with its date, time and offset", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("orchestrator", "started");
    await logger.flush();
    expect(written).toEqual(["10:15:30 orchestrator  started\n"]);
    expect(lines).toEqual([`${F} orchestrator  started\n`]);
  });

  test("masks with the given secrets on both outputs", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({
      file,
      terminal,
      now: () => AT,
      secrets: ["webhook-token-123"],
    });
    logger.line("bpng", "slack ✗ webhook-token-123");
    await logger.flush();
    expect(written).toEqual(["10:15:30 bpng  slack ✗ ***\n"]);
    expect(lines).toEqual([`${F} bpng  slack ✗ ***\n`]);
  });

  test("writes each line with exactly one line end, even for a text of several lines", async () => {
    const { file, lines } = fakeFile();
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    logger.line("bpng", "a\nb\n");
    await logger.flush();
    expect(lines).toEqual([`${F} bpng  a b\n`]);
  });

  test("reads the clock for each line, the file dating each across midnight", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const times = [
      new Date(2026, 9, 13, 23, 59, 59),
      new Date(2026, 9, 14, 0, 0, 1),
    ];
    const logger = createLogger({
      file,
      terminal,
      now: () => times.shift() ?? AT,
    });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    await logger.flush();
    expect(written).toEqual(["23:59:59 bpng  one\n", "00:00:01 bpng  two\n"]);
    expect(lines.map((line) => line.slice(0, 19))).toEqual([
      "2026-10-13T23:59:59",
      "2026-10-14T00:00:01",
    ]);
  });

  for (const code of ["EPIPE", "EIO"]) {
    test(`stops writing to a terminal whose write fails with ${code}, the file still getting every line`, async () => {
      const { file, lines } = fakeFile();
      const { terminal, written } = fakeTerminal(code);
      let writes = 0;
      const counted: Terminal = {
        write: (chunk, callback) => {
          writes++;
          return terminal.write(chunk, callback);
        },
        on: (event, listener) => terminal.on(event, listener),
        get writableLength() {
          return terminal.writableLength;
        },
      };
      const logger = createLogger({ file, terminal: counted, now: () => AT });
      logger.line("bpng", "one");
      await tick();
      logger.line("bpng", "two");
      logger.line("bpng", "three");
      await logger.flush();
      expect(writes).toBe(1);
      expect(written).toEqual([]);
      expect(lines).toEqual([
        `${F} bpng  one\n`,
        `${F} log  terminal gone (${code}): lines go to the file only\n`,
        `${F} bpng  two\n`,
        `${F} bpng  three\n`,
      ]);
    });
  }

  test("stops writing to a terminal whose write throws", async () => {
    const { file, lines } = fakeFile();
    let writes = 0;
    const terminal: Terminal = {
      write: () => {
        writes++;
        throw systemError("EIO");
      },
      on: () => undefined,
      writableLength: 0,
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    expect(() => {
      logger.line("bpng", "one");
    }).not.toThrow();
    logger.line("bpng", "two");
    await logger.flush();
    expect(writes).toBe(1);
    expect(lines).toEqual([
      `${F} bpng  one\n`,
      `${F} log  terminal gone (EIO): lines go to the file only\n`,
      `${F} bpng  two\n`,
    ]);
  });

  test("stops writing to a terminal that reports a failed write only through its callback", async () => {
    const { file, lines } = fakeFile();
    let writes = 0;
    const terminal: Terminal = {
      write: (_chunk, callback) => {
        writes++;
        callback(systemError("EPIPE"));
        return false;
      },
      on: () => undefined,
      writableLength: 0,
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    await logger.flush();
    expect(writes).toBe(1);
    expect(lines).toEqual([
      `${F} bpng  one\n`,
      `${F} log  terminal gone (EPIPE): lines go to the file only\n`,
      `${F} bpng  two\n`,
    ]);
  });

  test("stops writing to a terminal that emits an error between writes", async () => {
    const { file, lines } = fakeFile();
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    // Emitted with no write pending: without the logger's listener this would crash the process.
    terminal.emit("error", systemError("EIO"));
    logger.line("bpng", "two");
    await logger.flush();
    expect(written).toEqual(["10:15:30 bpng  one\n"]);
    expect(lines).toEqual([
      `${F} bpng  one\n`,
      `${F} log  terminal gone (EIO): lines go to the file only\n`,
      `${F} bpng  two\n`,
    ]);
  });

  test("tells every open logger of a terminal's error, through one listener however many loggers there were", async () => {
    const { terminal } = fakeTerminal();
    const warnings: Error[] = [];
    const onWarning = (warning: Error): void => {
      warnings.push(warning);
    };
    process.on("warning", onWarning);
    try {
      for (let i = 0; i < 50; i++)
        await createLogger({ file: fakeFile().file, terminal }).close();
      const open = fakeFile();
      const closed = fakeFile();
      const kept = createLogger({ file: open.file, terminal, now: () => AT });
      await createLogger({ file: closed.file, terminal }).close();
      expect(terminal.listenerCount("error")).toBe(1);
      terminal.emit("error", systemError("EIO"));
      await kept.flush();
      expect(open.lines).toEqual([
        `${F} log  terminal gone (EIO): lines go to the file only\n`,
      ]);
      expect(closed.lines).toEqual([]);
      await kept.close();
      // Every logger closed: a late error still finds the listener, and crashes nothing.
      expect(() => terminal.emit("error", systemError("EIO"))).not.toThrow();
      await tick();
      expect(warnings).toEqual([]);
    } finally {
      process.off("warning", onWarning);
    }
  });

  test("lets a closed logger go: the terminal it wrote to keeps no hold on it", async () => {
    const { terminal } = fakeTerminal();
    setFlagsFromString("--expose_gc");
    const collect = runInNewContext("gc") as () => void;
    const made = async (): Promise<WeakRef<object>> => {
      const logger = createLogger({ file: fakeFile().file, terminal });
      await logger.close();
      return new WeakRef(logger);
    };
    const kept = createLogger({ file: fakeFile().file, terminal });
    const closed = await made();
    for (let i = 0; i < 10 && closed.deref() !== undefined; i++) {
      await tick();
      collect();
    }
    expect(closed.deref()).toBeUndefined();
    await kept.close();
  });

  test("says nothing of a terminal failing once closing, a write's late callback included", async () => {
    const { file, lines } = fakeFile();
    let fail: ((error: Error) => void) | undefined;
    const terminal: Terminal = {
      write: (_chunk, callback) => {
        fail = callback;
        return true;
      },
      on: () => undefined,
      writableLength: 0,
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    const closing = logger.close();
    fail?.(systemError("EIO"));
    await closing;
    expect(lines).toEqual([`${F} bpng  one\n`]);
  });

  test("skips terminal lines while more than 1 MiB waits for the terminal, then says how many, the file getting every line", async () => {
    expect(TERMINAL_BACKLOG_BYTES).toBe(1024 * 1024);
    const { file, lines } = fakeFile();
    const written: string[] = [];
    let backlog = TERMINAL_BACKLOG_BYTES;
    const terminal: Terminal = {
      write: (chunk, callback) => {
        written.push(Buffer.from(chunk).toString("utf8"));
        callback();
        return true;
      },
      on: () => undefined,
      get writableLength() {
        return backlog;
      },
    };
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "at the cap");
    backlog++;
    logger.line("bpng", "two");
    logger.line("bpng", "three");
    backlog = 0;
    logger.line("bpng", "four");
    backlog = TERMINAL_BACKLOG_BYTES + 1;
    logger.line("bpng", "five");
    backlog = 0;
    logger.line("bpng", "six");
    await logger.flush();
    expect(written).toEqual([
      "10:15:30 bpng  at the cap\n",
      "10:15:30 log  2 lines not shown: the terminal was not keeping up (the log file has them)\n",
      "10:15:30 bpng  four\n",
      "10:15:30 log  1 line not shown: the terminal was not keeping up (the log file has them)\n",
      "10:15:30 bpng  six\n",
    ]);
    expect(lines).toEqual(
      ["at the cap", "two", "three", "four", "five", "six"].map(
        (text) => `${F} bpng  ${text}\n`,
      ),
    );
  });

  test("writes the file in call order, one write at a time, however long each takes", async () => {
    const delays = [30, 0, 15, 5, 0, 20];
    const { file, lines, maxInFlight } = fakeFile(
      () => new Promise((r) => setTimeout(r, delays.shift() ?? 0)),
    );
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    const expected = ["a", "b", "c", "d", "e", "f"];
    for (const text of expected) logger.line("bpng", text);
    await logger.flush();
    expect(lines).toEqual(expected.map((t) => `${F} bpng  ${t}\n`));
    expect(maxInFlight()).toBe(1);
  });

  test("never throws when the file fails, tells the terminal once, and keeps trying later lines", async () => {
    let failures = 2;
    const { file, lines } = fakeFile(() =>
      failures-- > 0
        ? Promise.reject(systemError("ENOSPC"))
        : Promise.resolve(),
    );
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    logger.line("bpng", "three");
    await expect(logger.flush()).resolves.toBeUndefined();
    expect(written).toEqual([
      "10:15:30 bpng  one\n",
      "10:15:30 bpng  two\n",
      "10:15:30 bpng  three\n",
      "10:15:30 log  writing the log file failed (ENOSPC): its lines may be missing\n",
    ]);
    expect(lines).toEqual([`\n${F} bpng  three\n`]);
  });

  test("starts the line after a failed append on a line of its own, so half a line never merges with it", async () => {
    let content = "";
    let full = true;
    const file: LogFile = {
      append(text) {
        if (!full) {
          content += text;
          return Promise.resolve();
        }
        // A disk filling up: part of the line is written, then the write fails.
        content += text.slice(0, 10);
        full = false;
        return Promise.reject(systemError("ENOSPC"));
      },
      close: () => Promise.resolve(),
    };
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    logger.line("bpng", "one");
    logger.line("bpng", "two");
    logger.line("bpng", "three");
    await logger.flush();
    expect(content).toBe(
      `${F.slice(0, 10)}\n${F} bpng  two\n${F} bpng  three\n`,
    );
  });

  test("flush waits for every line logged so far", async () => {
    const held = deferred();
    const { file, lines } = fakeFile(() => held.promise);
    const logger = createLogger({
      file,
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    logger.line("bpng", "one");
    let flushed = false;
    const flushing = logger.flush().then(() => {
      flushed = true;
    });
    await tick();
    expect(flushed).toBe(false);
    held.resolve();
    await flushing;
    expect(lines).toEqual([`${F} bpng  one\n`]);
  });

  test("close waits for pending lines, closes the file once, and drops later lines", async () => {
    const held = deferred();
    const { file, lines, closed } = fakeFile(() => held.promise);
    const { terminal, written } = fakeTerminal();
    const logger = createLogger({ file, terminal, now: () => AT });
    logger.line("bpng", "one");
    const closing = logger.close();
    expect(logger.close()).toBe(closing);
    await tick();
    expect(closed()).toBe(0);
    held.resolve();
    await closing;
    expect(closed()).toBe(1);
    logger.line("bpng", "late");
    await logger.flush();
    expect(lines).toEqual([`${F} bpng  one\n`]);
    expect(written).toEqual(["10:15:30 bpng  one\n"]);
  });

  test("close never rejects when the file fails to close", async () => {
    const logger = createLogger({
      file: {
        append: () => Promise.resolve(),
        close: () => Promise.reject(systemError("EIO")),
      },
      terminal: fakeTerminal().terminal,
    });
    await expect(logger.close()).resolves.toBeUndefined();
  });

  test("flush and close give up on a hung append after their wait, 5 s by default", async () => {
    expect(DEFAULT_WAIT_MS).toBe(5_000);
    let closed = 0;
    const logger = createLogger({
      file: {
        append: () => new Promise<void>(() => undefined),
        close: () => {
          closed++;
          return Promise.resolve();
        },
      },
      terminal: fakeTerminal().terminal,
    });
    logger.line("bpng", "one");
    const started = Date.now();
    await expect(logger.flush(30)).resolves.toBeUndefined();
    await expect(logger.close(30)).resolves.toBeUndefined();
    expect(Date.now() - started).toBeLessThan(2_000);
    // The file is never closed under a write still in flight.
    expect(closed).toBe(0);
  });

  test("close gives up on a hung file close after its wait", async () => {
    const logger = createLogger({
      file: {
        append: () => Promise.resolve(),
        close: () => new Promise<void>(() => undefined),
      },
      terminal: fakeTerminal().terminal,
    });
    await expect(logger.close(20)).resolves.toBeUndefined();
  });

  /**
   * A terminal whose backlog is set by the test, taking every write at once otherwise.
   *
   * @param backlog - what it holds at first.
   */
  function heldTerminal(backlog: number) {
    const state = { backlog };
    const terminal: Terminal = {
      write: (_chunk, callback) => {
        callback();
        return true;
      },
      on: () => undefined,
      get writableLength() {
        return state.backlog;
      },
    };
    return { terminal, state };
  }

  test("flush and close wait until the terminal has taken what was written: a process.exit next would cut it", async () => {
    for (const settle of [
      (logger: ReturnType<typeof createLogger>) => logger.flush(),
      (logger: ReturnType<typeof createLogger>) => logger.close(),
    ]) {
      const { terminal, state } = heldTerminal(4096);
      const logger = createLogger({ file: fakeFile().file, terminal });
      logger.line("bpng", "one");
      setTimeout(() => (state.backlog = 0), 80);
      const started = performance.now();
      await settle(logger);
      expect(performance.now() - started).toBeGreaterThanOrEqual(75);
    }
  });

  test("flush and close give up on a stalled terminal after their wait", async () => {
    const { terminal } = heldTerminal(4096);
    const logger = createLogger({ file: fakeFile().file, terminal });
    logger.line("bpng", "one");
    const started = performance.now();
    await expect(logger.flush(40)).resolves.toBeUndefined();
    await expect(logger.close(40)).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  test("never waits for a terminal that is gone", async () => {
    const terminal: Terminal = {
      write: () => {
        throw systemError("EIO");
      },
      on: () => undefined,
      // What it holds will never be taken.
      writableLength: 4096,
    };
    const logger = createLogger({ file: fakeFile().file, terminal });
    logger.line("bpng", "one");
    const started = performance.now();
    await logger.close();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  test("hands every line to a slow reader before process.exit, once closed", async () => {
    const result = await runSlowlyRead(
      `
        import { createLogger } from ${JSON.stringify(new URL("./log.ts", import.meta.url).href)};
        const logger = createLogger({ file: { append: async () => {}, close: async () => {} } });
        for (let i = 0; i < 2000; i++)
          logger.line("bpng", "MARK-" + i + " passed · 52 scenarios: 51 passed, 1 flaky · " + "z".repeat(100));
        await logger.close(15000);
        process.exit(130);
      `,
      300,
    );
    expect(result.code).toBe(130);
    expect(result.stdout.match(/MARK-\d+ /g)).toHaveLength(2000);
  });

  test("counts the terminal's backlog in bytes, not UTF-16 units: a line of ✔ weighs three bytes each", async () => {
    // A stream that keeps strings as they are counts them by UTF-16 unit, as a terminal does.
    const stalled = new Writable({
      decodeStrings: false,
      write: () => undefined,
    });
    let bytes = 0;
    let lines = 0;
    const terminal: Terminal = {
      write: (chunk, callback) => {
        bytes += Buffer.byteLength(chunk);
        lines++;
        return stalled.write(chunk, callback);
      },
      on: (event, listener) => stalled.on(event, listener),
      get writableLength() {
        return stalled.writableLength;
      },
    };
    const logger = createLogger({ file: fakeFile().file, terminal });
    // 600 checkmarks: 600 units, 1,800 bytes; 1,000 lines are 1.8 MB, 0.6 Mi units.
    for (let i = 0; i < 1000; i++) logger.line("bpng", "✔".repeat(600));
    expect(lines).toBeLessThan(1000);
    expect(bytes).toBeGreaterThan(TERMINAL_BACKLOG_BYTES);
    expect(bytes).toBeLessThan(TERMINAL_BACKLOG_BYTES + 2 * 1900);
    await logger.close(0);
  });

  test("refuses a wait that is not a whole number of milliseconds a timer takes", () => {
    const logger = createLogger({
      file: fakeFile().file,
      terminal: fakeTerminal().terminal,
    });
    for (const wait of [-1, 1.5, Number.NaN, Infinity, 2 ** 31]) {
      expect(() => logger.flush(wait), String(wait)).toThrow(RangeError);
      expect(() => logger.close(wait), String(wait)).toThrow(RangeError);
    }
  });
});

test.describe("refuseLogFile", () => {
  const regular = { uid: 501, nlink: 1, isFile: () => true };

  test("accepts this user's regular file with one link", () => {
    expect(refuseLogFile(regular, 501)).toBeUndefined();
    expect(refuseLogFile(regular, undefined)).toBeUndefined();
  });

  test("refuses another user's file, a second hard link, and anything not a regular file", () => {
    expect(refuseLogFile(regular, 0)).toBe("is another user's");
    expect(refuseLogFile({ ...regular, nlink: 2 }, 501)).toBe(
      "has another hard link",
    );
    expect(refuseLogFile({ ...regular, isFile: () => false }, 501)).toBe(
      "is not a regular file",
    );
  });
});

test.describe("systemCode and pathKind", () => {
  test("names a system error by its code, and one Node has no name for by its errno", () => {
    expect(systemCode(systemError("ELOOP"))).toBe("ELOOP");
    expect(
      systemCode(
        Object.assign(new Error("x"), {
          code: "Unknown system error -102",
          errno: -102,
        }),
      ),
    ).toBe("errno 102");
    expect(systemCode(new Error("x"))).toBe("unknown error");
  });

  test("names what is in a path's place, and nothing for a regular file or a failed read", async () => {
    const kinds = {
      isSymbolicLink: () => false,
      isFIFO: () => false,
      isSocket: () => false,
      isDirectory: () => false,
      isBlockDevice: () => false,
      isCharacterDevice: () => false,
    };
    const as = (kind?: keyof typeof kinds) => () =>
      Promise.resolve(
        kind === undefined ? kinds : { ...kinds, [kind]: () => true },
      );
    expect(await pathKind("p", as("isSymbolicLink"))).toBe("a symbolic link");
    expect(await pathKind("p", as("isFIFO"))).toBe("a FIFO");
    expect(await pathKind("p", as("isSocket"))).toBe("a socket");
    expect(await pathKind("p", as("isDirectory"))).toBe("a folder");
    expect(await pathKind("p", as("isBlockDevice"))).toBe("a device");
    expect(await pathKind("p", as("isCharacterDevice"))).toBe("a device");
    expect(await pathKind("p", as())).toBeUndefined();
    expect(
      await pathKind("p", () => Promise.reject(systemError("ENOENT"))),
    ).toBeUndefined();
  });
});

test.describe("openLogFile and openLogger", () => {
  /** A fresh folder per test, `0700` as `mkdtemp` makes it, removed after it. */
  let dir: string;
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-log-"));
  });
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates the log 0600 even under umask 0, and appends across opens", async () => {
    const path = join(dir, "orchestrator.log");
    const previous = process.umask(0);
    try {
      const first = await openLogger(path, {
        terminal: fakeTerminal().terminal,
        now: () => AT,
      });
      first.line("orchestrator", "started");
      await first.close();
    } finally {
      process.umask(previous);
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const second = await openLogger(path, {
      terminal: fakeTerminal().terminal,
      now: () => AT,
    });
    second.line("orchestrator", "started again");
    await second.close();
    expect(await readFile(path, "utf8")).toBe(
      `${F} orchestrator  started\n${F} orchestrator  started again\n`,
    );
  });

  test("tightens a wider mode to 0600, and says so in the first line", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "");
    await chmod(path, 0o644);
    const { terminal, written } = fakeTerminal();
    const logger = await openLogger(path, { terminal, now: () => AT });
    await logger.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(written).toEqual([
      `10:15:30 log  ${path} was mode 0644: now 0600\n`,
    ]);
  });

  test("clears a set-id bit when tightening", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "");
    await chmod(path, 0o4600);
    const opened = await openLogFile(path);
    await opened.file.close();
    expect(opened.tightenedFrom).toBe(0o4600);
    expect((await stat(path)).mode & 0o7777).toBe(0o600);
  });

  test("leaves a 0600 log's mode and first line alone", async () => {
    const path = join(dir, "orchestrator.log");
    await writeFile(path, "old\n", { mode: 0o600 });
    const opened = await openLogFile(path);
    await opened.file.close();
    expect(opened.tightenedFrom).toBeUndefined();
  });

  test("refuses a symbolic link, leaving its target untouched", async () => {
    const target = join(dir, "target");
    await writeFile(target, "keep\n", { mode: 0o644 });
    const path = join(dir, "orchestrator.log");
    await symlink(target, path);
    await expect(openLogFile(path)).rejects.toThrow(
      `The orchestrator's log cannot be opened (ELOOP): ${path} is a symbolic link, not a regular file.`,
    );
    expect(await readFile(target, "utf8")).toBe("keep\n");
    expect((await stat(target)).mode & 0o777).toBe(0o644);
  });

  test("refuses a dangling symbolic link without creating its target", async () => {
    const target = join(dir, "nowhere");
    const path = join(dir, "orchestrator.log");
    await symlink(target, path);
    await expect(openLogFile(path)).rejects.toThrow("(ELOOP)");
    await expect(lstat(target)).rejects.toThrow("ENOENT");
  });

  test("refuses a FIFO with no reader at once, never waiting for one, and names it a FIFO", async () => {
    const path = join(dir, "orchestrator.log");
    execFileSync("mkfifo", [path]);
    await expect(openLogFile(path)).rejects.toThrow(
      `The orchestrator's log cannot be opened (ENXIO): ${path} is a FIFO, not a regular file.`,
    );
  });

  test("refuses a FIFO that has a reader, by its type", async () => {
    const path = join(dir, "orchestrator.log");
    execFileSync("mkfifo", [path]);
    const reader = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      await expect(openLogFile(path)).rejects.toThrow(
        `The orchestrator's log is refused: ${path} is not a regular file.`,
      );
    } finally {
      await reader.close();
    }
  });

  test("refuses a Unix socket, naming it a socket — not a FIFO, nor an unknown error", async () => {
    const path = join(dir, "orchestrator.log");
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(path, resolve));
    try {
      // Linux answers ENXIO, as for a FIFO with no reader; macOS errno 102, which Node has no name for.
      await expect(openLogFile(path)).rejects.toThrow(
        new RegExp(
          `^The orchestrator's log cannot be opened \\((ENXIO|errno 102)\\): .* is a socket, not a regular file\\.$`,
        ),
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("refuses a folder", async () => {
    const path = join(dir, "orchestrator.log");
    await mkdir(path);
    await expect(openLogFile(path)).rejects.toThrow(
      `(EISDIR): ${path} is a folder, not a regular file.`,
    );
  });

  test("refuses a file with a second hard link, writing nothing into it", async () => {
    const other = join(dir, "other");
    await writeFile(other, "keep\n", { mode: 0o644 });
    const path = join(dir, "orchestrator.log");
    await link(other, path);
    await expect(openLogFile(path)).rejects.toThrow(
      `The orchestrator's log is refused: ${path} has another hard link.`,
    );
    expect(await readFile(other, "utf8")).toBe("keep\n");
    expect((await stat(other)).mode & 0o777).toBe(0o644);
  });

  test("refuses another user's file, and closes its handle", async () => {
    const path = join(dir, "orchestrator.log");
    const handle = await open(path, "w");
    const realStat = handle.stat.bind(handle);
    const realClose = handle.close.bind(handle);
    let closed = false;
    const foreign = Object.assign(handle, {
      stat: async () => {
        const stats = await realStat();
        return Object.assign(stats, { uid: stats.uid + 1 });
      },
      close: () => {
        closed = true;
        return realClose();
      },
    });
    await expect(
      openLogFile(path, () => Promise.resolve(foreign)),
    ).rejects.toThrow(
      `The orchestrator's log is refused: ${path} is another user's.`,
    );
    expect(closed).toBe(true);
  });

  test("names the open's error code, and closes a handle it refuses", async () => {
    let closed = false;
    const path = join(dir, "orchestrator.log");
    await expect(
      openLogFile(path, () => Promise.reject(systemError("EACCES"))),
    ).rejects.toThrow(
      `The orchestrator's log cannot be opened (EACCES): ${path}.`,
    );
    const handle = await open(path, "w");
    const close = handle.close.bind(handle);
    await expect(
      openLogFile(path, () =>
        Promise.resolve(
          Object.assign(handle, {
            stat: () => Promise.reject(systemError("EIO")),
            close: () => {
              closed = true;
              return close();
            },
          }),
        ),
      ),
    ).rejects.toThrow("EIO");
    expect(closed).toBe(true);
  });

  test("openLogger takes the state directory's rule: refuses a folder others may write in, opening nothing; takes one others only read", async () => {
    const open = join(dir, "open");
    await mkdir(open, { mode: 0o700 });
    await chmod(open, 0o770);
    await expect(
      openLogger(join(open, "orchestrator.log"), {
        terminal: fakeTerminal().terminal,
      }),
    ).rejects.toThrow(
      `The orchestrator's log folder ${open} is mode 770: it must be this user's, and no one else may write in it (chmod go-w ${open}).`,
    );
    await expect(lstat(join(open, "orchestrator.log"))).rejects.toThrow(
      "ENOENT",
    );
    const file = join(dir, "file");
    await writeFile(file, "");
    await expect(
      openLogger(join(file, "orchestrator.log"), {
        terminal: fakeTerminal().terminal,
      }),
    ).rejects.toThrow(`The orchestrator's log folder ${file} is not a folder`);
    await chmod(open, 0o755);
    const logger = await openLogger(join(open, "orchestrator.log"), {
      terminal: fakeTerminal().terminal,
    });
    await logger.close();
    expect((await lstat(join(open, "orchestrator.log"))).isFile()).toBe(true);
  });

  test("keeps writing the file after the terminal is gone", async () => {
    const path = join(dir, "orchestrator.log");
    const { terminal } = fakeTerminal("EIO");
    const logger = await openLogger(path, { terminal, now: () => AT });
    logger.line("bpng", "one");
    await tick();
    logger.line("bpng", "two");
    await logger.close();
    expect(await readFile(path, "utf8")).toBe(
      [
        `${F} bpng  one`,
        `${F} log  terminal gone (EIO): lines go to the file only`,
        `${F} bpng  two`,
        "",
      ].join("\n"),
    );
  });
});
