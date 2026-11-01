import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { stripVTControlCharacters } from "node:util";

import {
  FakeScheduler,
  FakeTerminal,
} from "../src/common/__fixtures__/terminal-fakes";
import { clearBytes, resetBytes } from "../src/common/terminal/live";
import { TERMINAL_BACKLOG_BYTES } from "../src/common/terminal/stream";
import {
  onResize,
  openScreen,
  TABLE_INTERVAL_MS,
  type Screen,
  type ScreenOptions,
  type ScreenStream,
} from "./screen";
import type { Board } from "./status/board";
import { NO_PROGRESS } from "./status/progress";

/**
 * The orchestrator's screen on a faked terminal and clock: which streams get one, how lines are
 * printed before, during and after the table, the table's throttle, resize, backlog and failure. The
 * bytes on a real terminal are `table.tmux.spec.ts`'s.
 */

/**
 * A fake terminal as the screen's stream: its `on` takes any listener, which the type cannot say.
 *
 * @param terminal - the fake.
 */
function streamOf(terminal: FakeTerminal): ScreenStream {
  return terminal as unknown as ScreenStream;
}

/** A terminal's variables: colour, Unicode and a live region allowed. */
const TTY_ENV = { TERM: "xterm-256color", LANG: "en_US.UTF-8" } as const;

const T0 = new Date(2026, 9, 13, 10, 0, 0);
const AT = new Date(2026, 9, 13, 10, 15, 30);

/**
 * A board of two tasks, `bpng` running `planned` scenarios with `done` ended, `bfap` waiting.
 *
 * @param done - how many ended.
 */
function board(done: number): Board {
  return [
    {
      taskId: "bpng",
      cell: "pro@nginx",
      phase: {
        kind: "run",
        run: {
          id: "bpng-12",
          reportDir: "/r",
          startedAt: T0,
          stopping: false,
          progress: { ...NO_PROGRESS, begun: true, planned: 52, done },
        },
      },
    },
    { taskId: "bfap", cell: "free@nginx", phase: { kind: "waiting" } },
  ];
}

/** A screen under test, its terminal, its clock, and the failures it told. */
interface Harness {
  readonly screen: Screen;
  readonly terminal: FakeTerminal;
  readonly scheduler: FakeScheduler;
  readonly failures: Error[];
  /** The process's events the screen hears its end on. */
  readonly events: EventEmitter;
  /** Prints lines through the screen, recording its failures. */
  readonly print: (...lines: string[]) => void;
}

/**
 * Opens a screen on a fake terminal, its process events a fresh emitter (never the spec's process).
 *
 * @param env - the environment; a colour terminal's by default.
 * @param tty - whether the stream is a terminal.
 * @param more - other options: standard error, secrets.
 * @returns the harness; the screen must exist.
 */
function harness(
  env: Readonly<Record<string, string>> = TTY_ENV,
  tty = true,
  more: Pick<ScreenOptions, "stderr" | "secrets"> = {},
): Harness {
  const terminal = new FakeTerminal(tty);
  const scheduler = new FakeScheduler();
  const failures: Error[] = [];
  const events = new EventEmitter();
  const screen = openScreen({
    stdout: streamOf(terminal),
    env,
    taskIds: ["bpng", "bfap"],
    scheduler,
    now: () => new Date(T0.getTime() + 65_000),
    process: events,
    ...more,
  });
  if (screen === undefined) throw new Error("no screen");
  return {
    screen,
    terminal,
    scheduler,
    failures,
    events,
    print: (...lines) => {
      screen.print(lines, (error) => failures.push(error));
    },
  };
}

/**
 * How many times the table's header was drawn.
 *
 * @param terminal - the terminal.
 */
function draws(terminal: FakeTerminal): number {
  return stripVTControlCharacters(terminal.all).split("TASK  RUN").length - 1;
}

test.describe("openScreen", () => {
  test("gives a pipe or a file no screen: its lines stay the logger's plain ones", () => {
    expect(
      openScreen({
        stdout: streamOf(new FakeTerminal(false)),
        env: TTY_ENV,
        taskIds: [],
      }),
    ).toBeUndefined();
  });

  test("gives a terminal that cannot redraw in place a screen with no table: styled lines only", () => {
    for (const env of [{ TERM: "dumb" }, { ...TTY_ENV, CI: "true" }]) {
      const { screen, terminal, scheduler, print } = harness(env);
      expect(screen.live).toBe(false);
      screen.show(board(1));
      scheduler.advance(5_000);
      print("10:15:30 bpng  one");
      expect(terminal.all).toBe("10:15:30 bpng  one\n");
    }
  });

  test("styles a line: the time dim, the scope in its task's colour, by the config's order", () => {
    const { screen } = harness();
    expect(screen.format({ at: AT, scope: "bfap", text: "next run" })).toEqual([
      "\x1b[2m10:15:30\x1b[22m \x1b[35mbfap\x1b[39m  next run",
    ]);
    expect(screen.format({ at: AT, scope: "orchestrator", text: "x" })).toEqual(
      ["\x1b[2m10:15:30\x1b[22m orchestrator  x"],
    );
  });

  test("under NO_COLOR, styles nothing but still wraps and opens blocks", () => {
    const { screen, terminal } = harness({ ...TTY_ENV, NO_COLOR: "1" });
    terminal.columns = 40;
    expect(screen.live).toBe(true);
    expect(
      screen.format({
        at: AT,
        scope: "bpng",
        text: "one two three four five six seven",
        opensBlock: true,
      }),
    ).toEqual([
      "",
      "10:15:30 bpng  one two three four five",
      "               six seven",
    ]);
  });
});

test.describe("the screen's table", () => {
  test("prints lines straight through, `\\n`-ended, until the first table", () => {
    const { terminal, print } = harness();
    print("a", "b");
    expect(terminal.all).toBe("a\nb\n");
  });

  test("draws the first table at once, then at most once a second: the newest board only", () => {
    const { screen, terminal, scheduler } = harness();
    screen.show(board(1));
    expect(draws(terminal)).toBe(1);
    expect(stripVTControlCharacters(terminal.all)).toContain("1/52");
    for (let done = 2; done <= 5; done++) screen.show(board(done));
    scheduler.advance(TABLE_INTERVAL_MS - 1);
    expect(draws(terminal)).toBe(1);
    scheduler.advance(1);
    expect(draws(terminal)).toBe(2);
    const drawn = stripVTControlCharacters(terminal.all);
    expect(drawn).toContain("5/52");
    expect(drawn).not.toContain("3/52");
    // Nothing new to show: nothing drawn.
    scheduler.advance(10_000);
    expect(draws(terminal)).toBe(2);
  });

  test("styles the table after its cut: header dim, each task's id in its colour", () => {
    const { screen, terminal } = harness();
    screen.show(board(1));
    expect(terminal.all).toContain("\x1b[2mTASK  RUN");
    expect(terminal.all).toContain("\x1b[36mbpng\x1b[39m  bpng-12");
    expect(terminal.all).toContain("\x1b[35mbfap\x1b[39m  —");
  });

  test("prints a line above the table: the table cleared, the line `\\r\\n`-ended, the table repainted after", () => {
    const { screen, terminal, scheduler, print } = harness();
    screen.show(board(1));
    terminal.chunks.length = 0;
    print("10:15:30 bpng  line");
    // Header and two rows: three rows cleared from the last.
    expect(terminal.all).toBe(`${clearBytes(3)}10:15:30 bpng  line\r\n`);
    scheduler.advance(TABLE_INTERVAL_MS);
    expect(draws(terminal)).toBe(1);
  });

  test("close clears the table for good, stops hearing resizes, and prints later lines straight through", () => {
    const { screen, terminal, scheduler, print, failures } = harness();
    screen.show(board(1));
    expect(terminal.listenerCount("resize")).toBe(1);
    terminal.chunks.length = 0;
    screen.close();
    expect(terminal.all).toBe(clearBytes(3));
    expect(terminal.listenerCount("resize")).toBe(0);
    screen.show(board(2));
    scheduler.advance(10_000);
    print("exiting 0");
    screen.close();
    expect(terminal.all).toBe(`${clearBytes(3)}exiting 0\n`);
    expect(failures).toEqual([]);
  });

  test("a resize erases the old table and draws the last board for the new size", () => {
    const { screen, terminal, scheduler } = harness();
    terminal.columns = 120;
    screen.show(board(7));
    terminal.chunks.length = 0;
    terminal.columns = 44;
    terminal.emit("resize");
    // At once, before any draw: the old table's three rows erased, however the narrowing rewrapped them.
    expect(terminal.all).toBe(resetBytes(3));
    scheduler.advance(TABLE_INTERVAL_MS);
    const drawn = stripVTControlCharacters(terminal.all);
    // Below 50 columns, one short line per task and no header.
    expect(drawn).not.toContain("TASK");
    expect(drawn).toContain("bpng  running  7/52");
    for (const row of drawn.split("\r\n"))
      expect(row.replace(/\r$/, "").length).toBeLessThanOrEqual(44);
  });

  test("a short terminal drops the header before any row: its rows less two", () => {
    const { screen, terminal } = harness();
    terminal.rows = 4;
    screen.show(board(1));
    const drawn = stripVTControlCharacters(terminal.all);
    expect(drawn).not.toContain("TASK");
    expect(drawn).toContain("bpng  bpng-12");
    expect(drawn).toContain("bfap  —");
  });

  test("skips draws while the terminal's backlog is over its bound, then draws the newest once it drains", () => {
    const { screen, terminal, scheduler, print } = harness();
    terminal.writableLength = TERMINAL_BACKLOG_BYTES + 1;
    screen.show(board(1));
    screen.show(board(2));
    scheduler.advance(5_000);
    expect(draws(terminal)).toBe(0);
    // A line is never skipped by the screen: bounding them is the logger's.
    print("kept");
    expect(terminal.all).toContain("kept");
    terminal.writableLength = 0;
    scheduler.advance(TABLE_INTERVAL_MS);
    expect(draws(terminal)).toBe(1);
    expect(stripVTControlCharacters(terminal.all)).toContain("2/52");
  });

  test("a failed write makes the terminal gone: told once, nothing drawn or printed after", () => {
    const { screen, terminal, scheduler, print, failures } = harness();
    print("first");
    terminal.mode = "callback-error";
    screen.show(board(1));
    expect(failures).toHaveLength(1);
    terminal.mode = "ok";
    terminal.chunks.length = 0;
    screen.show(board(2));
    scheduler.advance(10_000);
    print("second");
    expect(terminal.all).toBe("");
    // The print after tells its own caller at once.
    expect(failures).toHaveLength(2);
    expect(() => {
      screen.close();
    }).not.toThrow();
  });

  test("a table shown once closed draws nothing and opens no region, even before any table", () => {
    const { screen, terminal, scheduler, events } = harness();
    screen.close();
    screen.show(board(1));
    scheduler.advance(10_000);
    expect(terminal.all).toBe("");
    expect(terminal.listenerCount("resize")).toBe(0);
    expect(events.listenerCount("exit")).toBe(0);
  });

  test("a line that fails before any table makes the terminal gone too: no table opens", () => {
    const { screen, terminal, print, failures } = harness();
    terminal.mode = "throw";
    print("first");
    expect(failures).toHaveLength(1);
    terminal.mode = "ok";
    screen.show(board(1));
    expect(terminal.all).toBe("");
    expect(terminal.listenerCount("resize")).toBe(0);
  });
});

/** A secret the config holds: no captured line shows it. */
const SECRET = "orchestrator-Secret-Of-No-Shape-0123";

/** Standard error as the start hands it: a terminal's, recording what reaches it. */
class FakeStderr {
  readonly isTTY: boolean;
  text = "";

  /**
   * @param tty - whether it is a terminal.
   */
  constructor(tty = true) {
    this.isTTY = tty;
  }

  /**
   * Records text.
   *
   * @param text - what is written.
   * @returns `true`: taken.
   */
  write(text: string): boolean {
    this.text += text;
    return true;
  }
}

test.describe("the screen and the process's other writers", () => {
  test("while the table shows, standard output's and a terminal standard error's lines print above it, masked", () => {
    const stderr = new FakeStderr();
    const { screen, terminal, scheduler } = harness(TTY_ENV, true, {
      stderr,
      secrets: [SECRET],
    });
    // Before the table: nothing is captured.
    stderr.write("early\n");
    expect(stderr.text).toBe("early\n");
    screen.show(board(1));
    terminal.chunks.length = 0;
    stderr.write(`(node:1) Warning: token ${SECRET} \u001b[2Jleaked\n`);
    expect(stderr.text).toBe("early\n");
    expect(terminal.all).toBe(
      `${clearBytes(3)}(node:1) Warning: token *** leaked\r\n`,
    );
    scheduler.advance(TABLE_INTERVAL_MS);
    expect(draws(terminal)).toBe(1);
    terminal.chunks.length = 0;
    // A dependency's `console.log`: standard output's own `write`, captured as well.
    terminal.write("from a dependency\n");
    expect(terminal.all).toBe(`${clearBytes(3)}from a dependency\r\n`);
  });

  test("close puts both streams back: later writes go straight to them", () => {
    const stderr = new FakeStderr();
    const { screen, terminal } = harness(TTY_ENV, true, { stderr });
    const ownWrite = Object.hasOwn(terminal, "write");
    screen.show(board(1));
    expect(Object.hasOwn(stderr, "write")).toBe(true);
    screen.close();
    expect(Object.hasOwn(stderr, "write")).toBe(false);
    expect(Object.hasOwn(terminal, "write")).toBe(ownWrite);
    terminal.chunks.length = 0;
    stderr.write("after\n");
    terminal.write("raw\n");
    expect(stderr.text).toBe("after\n");
    expect(terminal.all).toBe("raw\n");
  });

  test("leaves a standard error that is no terminal alone", () => {
    const stderr = new FakeStderr(false);
    const { screen, terminal } = harness(TTY_ENV, true, { stderr });
    screen.show(board(1));
    terminal.chunks.length = 0;
    stderr.write("to a file\n");
    expect(stderr.text).toBe("to a file\n");
    expect(terminal.all).toBe("");
  });

  test("a gone terminal puts the streams back and stops hearing the process's end", () => {
    const stderr = new FakeStderr();
    const { screen, terminal, events, failures, print } = harness(
      TTY_ENV,
      true,
      { stderr },
    );
    print("first");
    screen.show(board(1));
    expect(events.listenerCount("exit")).toBe(1);
    terminal.mode = "callback-error";
    print("lost");
    expect(failures).toHaveLength(1);
    expect(Object.hasOwn(stderr, "write")).toBe(false);
    expect(events.listenerCount("exit")).toBe(0);
    expect(events.listenerCount("uncaughtExceptionMonitor")).toBe(0);
    stderr.write("still shown\n");
    expect(stderr.text).toBe("still shown\n");
  });

  for (const event of ["uncaughtExceptionMonitor", "exit"] as const)
    test(`the process's \`${event}\` clears the table and puts the streams back; heard only while it shows`, () => {
      const stderr = new FakeStderr();
      const { screen, terminal, events } = harness(TTY_ENV, true, { stderr });
      expect(events.listenerCount(event)).toBe(0);
      screen.show(board(1));
      expect(events.listenerCount(event)).toBe(1);
      terminal.chunks.length = 0;
      events.emit(event, new Error("a bug"), "uncaughtException");
      expect(terminal.all).toBe(clearBytes(3));
      expect(Object.hasOwn(stderr, "write")).toBe(false);
      expect(events.listenerCount("exit")).toBe(0);
      expect(events.listenerCount("uncaughtExceptionMonitor")).toBe(0);
      // The end changes nothing else: a later close clears nothing again.
      screen.close();
      expect(terminal.all).toBe(clearBytes(3));
    });

  test("process events that refuse a listener never stop the table", () => {
    const terminal = new FakeTerminal();
    const screen = openScreen({
      stdout: streamOf(terminal),
      env: TTY_ENV,
      taskIds: ["bpng"],
      scheduler: new FakeScheduler(),
      process: {
        on: () => {
          throw new Error("no");
        },
        off: () => {
          throw new Error("no");
        },
      },
    });
    screen?.show(board(1));
    expect(draws(terminal)).toBe(1);
    expect(() => screen?.close()).not.toThrow();
  });
});

test.describe("onResize", () => {
  test("listens until stopped; a stream with no events, or one that refuses, is never resized", () => {
    const terminal = new FakeTerminal();
    let resized = 0;
    const stop = onResize(terminal, () => resized++);
    terminal.emit("resize");
    stop();
    terminal.emit("resize");
    expect(resized).toBe(1);
    expect(() => {
      onResize({}, () => undefined)();
    }).not.toThrow();
    const refusing = {
      on: () => {
        throw new Error("no");
      },
      off: () => {
        throw new Error("no");
      },
    };
    expect(() => {
      onResize(refusing, () => undefined)();
    }).not.toThrow();
  });
});
