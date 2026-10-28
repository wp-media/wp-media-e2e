import { test, expect } from "@playwright/test";

import {
  createPalette,
  STATUSES,
  SYMBOLS,
  type Status,
  type SymbolName,
  type Token,
} from "./palette";

/**
 * Every spec here runs with Node's own colour checks saying "no colour": Playwright starts workers
 * with `FORCE_COLOR=1`, under which `styleText` colours even with its checks on, so a palette that
 * lost `validateStream: false` would pass unnoticed. The worker's stdout is a pipe; with
 * `FORCE_COLOR` removed and `NO_COLOR`/`CI` set, only the bypass can emit SGR.
 */
const NODE_SAYS_NO_COLOR: Readonly<Record<string, string | undefined>> = {
  FORCE_COLOR: undefined,
  NO_COLOR: "1",
  CI: "true",
  TERM: "dumb",
};

/** The variables {@link NODE_SAYS_NO_COLOR} replaced, put back after each spec. */
let savedEnv: Record<string, string | undefined> = {};

test.beforeEach(() => {
  savedEnv = {};
  for (const [name, value] of Object.entries(NODE_SAYS_NO_COLOR)) {
    savedEnv[name] = process.env[name];
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

test.afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

/** Every token, and the SGR it opens and closes with colour on. */
const TOKEN_SGR: readonly (readonly [Token, string, string])[] = [
  ["ok", "\x1b[32m", "\x1b[39m"],
  ["fail", "\x1b[31m", "\x1b[39m"],
  ["warn", "\x1b[33m", "\x1b[39m"],
  ["stop", "\x1b[33m", "\x1b[39m"],
  ["id", "\x1b[36m", "\x1b[39m"],
  ["dim", "\x1b[2m", "\x1b[22m"],
  ["command", "\x1b[1m", "\x1b[22m"],
];

/** Every symbol's `[Unicode, ASCII]` spelling, typed out: a changed spelling is a deliberate edit here. */
const SPELLINGS: Readonly<Record<SymbolName, readonly [string, string]>> = {
  passed: ["✔", "OK"],
  failed: ["✘", "x"],
  warning: ["⚠", "!"],
  stopped: ["■", "#"],
  current: ["▸", ">"],
  retry: ["↻", "~"],
  barDone: ["█", "#"],
  barLeft: ["░", "-"],
  check: ["✓", "ok"],
  cross: ["✗", "x"],
  separator: ["·", "."],
  dash: ["—", "-"],
  arrow: ["→", "->"],
  vertical: ["│", "|"],
  branch: ["├", "+"],
  lastBranch: ["└", "+"],
  rule: ["─", "-"],
  heavyRule: ["━", "="],
  breadcrumb: ["›", ">"],
  ellipsis: ["…", "..."],
};

/**
 * Each status exactly as shown, typed out: on a coloured terminal (Unicode, ASCII), on a coloured
 * non-terminal (a `FORCE_COLOR` pipe), and colourless (Unicode, ASCII; terminal or not).
 */
const SHOWN: Readonly<
  Record<
    Status,
    {
      readonly ttyColour: readonly [string, string];
      readonly pipeColour: string;
      readonly colourless: readonly [string, string];
    }
  >
> = {
  passed: {
    ttyColour: ["\x1b[32m✔\x1b[39m", "\x1b[32mOK\x1b[39m"],
    pipeColour: "\x1b[32m✔\x1b[39m passed",
    colourless: ["✔ passed", "OK passed"],
  },
  failed: {
    ttyColour: ["\x1b[31m✘\x1b[39m", "\x1b[31mx\x1b[39m"],
    pipeColour: "\x1b[31m✘\x1b[39m failed",
    colourless: ["✘ failed", "x failed"],
  },
  flaky: {
    ttyColour: ["\x1b[33m⚠\x1b[39m flaky", "\x1b[33m!\x1b[39m flaky"],
    pipeColour: "\x1b[33m⚠\x1b[39m flaky",
    colourless: ["⚠ flaky", "! flaky"],
  },
  stopped: {
    ttyColour: ["\x1b[33m■\x1b[39m", "\x1b[33m#\x1b[39m"],
    pipeColour: "\x1b[33m■\x1b[39m stopped",
    colourless: ["■ stopped", "# stopped"],
  },
  warning: {
    ttyColour: ["\x1b[33m⚠\x1b[39m", "\x1b[33m!\x1b[39m"],
    pipeColour: "\x1b[33m⚠\x1b[39m warning",
    colourless: ["⚠ warning", "! warning"],
  },
  error: {
    ttyColour: ["\x1b[31m✘\x1b[39m error", "\x1b[31mx\x1b[39m error"],
    pipeColour: "\x1b[31m✘\x1b[39m error",
    colourless: ["✘ error", "x error"],
  },
  killed: {
    ttyColour: ["\x1b[33m■\x1b[39m killed", "\x1b[33m#\x1b[39m killed"],
    pipeColour: "\x1b[33m■\x1b[39m killed",
    colourless: ["■ killed", "# killed"],
  },
};

/** Every status. */
const ALL_STATUSES = Object.keys(STATUSES) as Status[];

/** Every symbol role. */
const ALL_SYMBOLS = Object.keys(SYMBOLS) as SymbolName[];

test.describe("paint", () => {
  test("Node's own checks would refuse colour here, so only the bypass styles", async () => {
    const { styleText } = await import("node:util");
    expect(styleText("green", "x")).toBe("x");
  });

  for (const [token, open, close] of TOKEN_SGR) {
    test(`${token}: named ANSI SGR with colour on, the text alone with colour off`, () => {
      for (const tty of [true, false]) {
        expect(
          createPalette({ tty, color: true, unicode: true }).paint(token, "x"),
        ).toBe(`${open}x${close}`);
        expect(
          createPalette({ tty, color: false, unicode: true }).paint(token, "x"),
        ).toBe("x");
      }
    });
  }

  test("the text itself is never changed: spaces and inner text kept, colour on or off", () => {
    const text = "  a  b\t";
    for (const tty of [true, false]) {
      expect(
        createPalette({ tty, color: false, unicode: true }).paint("ok", text),
      ).toBe(text);
      expect(
        createPalette({ tty, color: true, unicode: true }).paint("ok", text),
      ).toBe(`\x1b[32m${text}\x1b[39m`);
    }
  });

  test("only an empty text goes unstyled: blank text is still wrapped", () => {
    expect(
      createPalette({ tty: true, color: true, unicode: true }).paint("ok", " "),
    ).toBe("\x1b[32m \x1b[39m");
  });

  test("an empty text stays empty, with no stray escape", () => {
    expect(
      createPalette({ tty: true, color: true, unicode: true }).paint(
        "fail",
        "",
      ),
    ).toBe("");
  });

  test("only named colours and bold/dim: no 256-colour, truecolor or background", () => {
    const palette = createPalette({ tty: true, color: true, unicode: true });
    for (const [token] of TOKEN_SGR) {
      // Each SGR's parameters: what follows `ESC [` up to its `m`.
      const codes = palette
        .paint(token, "x")
        .split("\x1b[")
        .slice(1)
        .map((sequence) => sequence.slice(0, sequence.indexOf("m")));
      expect(codes).toHaveLength(2);
      for (const code of codes) expect(code).toMatch(/^(1|2|22|3[0-7]|39)$/);
    }
  });
});

test.describe("symbol", () => {
  test("the spelling table names every role, and no other", () => {
    expect(ALL_SYMBOLS.toSorted()).toEqual(Object.keys(SPELLINGS).toSorted());
  });

  for (const [name, [unicode, ascii]] of Object.entries(SPELLINGS)) {
    test(`${name}: ${unicode} in Unicode, ${ascii} in ASCII, never styled`, () => {
      const role = name as SymbolName;
      for (const color of [true, false]) {
        expect(
          createPalette({ tty: true, color, unicode: true }).symbol(role),
        ).toBe(unicode);
        expect(
          createPalette({ tty: true, color, unicode: false }).symbol(role),
        ).toBe(ascii);
      }
      expect(ascii).toMatch(/^[\x21-\x7e]+$/);
    });
  }
});

test.describe("status", () => {
  for (const name of Object.keys(SHOWN) as Status[]) {
    const shown = SHOWN[name];
    test(`${name}: exactly as shown, colour on and off, terminal or not`, () => {
      const shownBy = (tty: boolean, color: boolean, unicode: boolean) =>
        createPalette({ tty, color, unicode }).status(name);
      expect(shownBy(true, true, true)).toBe(shown.ttyColour[0]);
      expect(shownBy(true, true, false)).toBe(shown.ttyColour[1]);
      expect(shownBy(false, true, true)).toBe(shown.pipeColour);
      for (const tty of [true, false]) {
        expect(shownBy(tty, false, true)).toBe(shown.colourless[0]);
        expect(shownBy(tty, false, false)).toBe(shown.colourless[1]);
      }
    });
  }

  test("the table covers every status", () => {
    expect(ALL_STATUSES.toSorted()).toEqual(Object.keys(SHOWN).toSorted());
  });

  test("a coloured terminal tells flaky from warning by its word", () => {
    const palette = createPalette({ tty: true, color: true, unicode: true });
    expect(palette.status("flaky")).not.toBe(palette.status("warning"));
  });

  test("a coloured terminal tells error from failed, and killed from stopped, by their word", () => {
    const palette = createPalette({ tty: true, color: true, unicode: true });
    expect(palette.status("error")).not.toBe(palette.status("failed"));
    expect(palette.status("killed")).not.toBe(palette.status("stopped"));
  });

  test("colour off emits no escape anywhere", () => {
    for (const unicode of [true, false]) {
      const palette = createPalette({ tty: true, color: false, unicode });
      const everything = [
        ...TOKEN_SGR.map(([token]) => palette.paint(token, "text")),
        ...ALL_SYMBOLS.map((name) => palette.symbol(name)),
        ...ALL_STATUSES.map((name) => palette.status(name)),
      ].join("");
      expect(everything).not.toContain("\x1b");
    }
  });
});
