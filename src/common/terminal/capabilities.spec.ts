import { test, expect } from "@playwright/test";

import {
  detectCapabilities,
  effectiveLocale,
  isCi,
  localeIsUtf8,
  type CapabilityInputs,
  type Environment,
  type OutputStream,
  type TerminalCapabilities,
} from "./capabilities";

/** A sized terminal. */
const TTY: OutputStream = { isTTY: true, columns: 80, rows: 24 };

/** A pipe or a file: no terminal, no size. */
const PIPE: OutputStream = {};

/** A terminal's usual `TERM`: every case sets it unless it is about `TERM`. */
const XTERM = { TERM: "xterm-256color" } as const;

/** What a case expects, `tty` aside (it only mirrors the stream). */
type Decided = Omit<TerminalCapabilities, "tty">;

/**
 * `detectCapabilities` on a sized terminal with `TERM=xterm-256color`, overridden by the case.
 *
 * @param env - variables added to (or, as `undefined`, removed from) the base environment.
 * @param overrides - any other input.
 */
function detect(
  env: Environment,
  overrides: Partial<CapabilityInputs> = {},
): TerminalCapabilities {
  return detectCapabilities({
    env: { ...XTERM, ...env },
    stream: TTY,
    ...overrides,
  });
}

test.describe("detectCapabilities — colour precedence", () => {
  /** `[case, env, stream, colour]`, in the precedence's order. */
  const cases: readonly (readonly [
    string,
    Environment,
    OutputStream,
    boolean,
  ])[] = [
    ["a terminal, nothing set", {}, TTY, true],
    ["a pipe, nothing set", {}, PIPE, false],
    ["isTTY false", {}, { isTTY: false, columns: 80, rows: 24 }, false],
    ["NO_COLOR=1", { NO_COLOR: "1" }, TTY, false],
    ["NO_COLOR empty does not disable", { NO_COLOR: "" }, TTY, true],
    ["NODE_DISABLE_COLORS=1", { NODE_DISABLE_COLORS: "1" }, TTY, false],
    ["NODE_DISABLE_COLORS empty", { NODE_DISABLE_COLORS: "" }, TTY, false],
    ["TERM=dumb", { TERM: "dumb" }, TTY, false],
    ["TERM=dumb-x is not dumb", { TERM: "dumb-x" }, TTY, true],
    ["TERM=DUMB is not dumb", { TERM: "DUMB" }, TTY, true],
    ["TERM unset", { TERM: undefined }, TTY, false],
    ["TERM empty", { TERM: "" }, TTY, false],
    ["TERM=xterm-256color", {}, TTY, true],
    ["CI=true keeps colour", { CI: "true" }, TTY, true],
    ["CI empty keeps colour", { CI: "" }, TTY, true],
    ["FORCE_COLOR=0", { FORCE_COLOR: "0" }, TTY, false],
    ["FORCE_COLOR=false", { FORCE_COLOR: "false" }, TTY, false],
    ["FORCE_COLOR=FALSE", { FORCE_COLOR: "FALSE" }, TTY, false],
    ["FORCE_COLOR=1 on a pipe", { FORCE_COLOR: "1" }, PIPE, true],
    ["FORCE_COLOR=true on a pipe", { FORCE_COLOR: "true" }, PIPE, true],
    ["FORCE_COLOR empty on a pipe", { FORCE_COLOR: "" }, PIPE, true],
    ["FORCE_COLOR=yes on a pipe", { FORCE_COLOR: "yes" }, PIPE, true],
    ["FORCE_COLOR=0 on a pipe", { FORCE_COLOR: "0" }, PIPE, false],
    [
      "FORCE_COLOR=1 beats NO_COLOR, NODE_DISABLE_COLORS and TERM=dumb",
      {
        FORCE_COLOR: "1",
        NO_COLOR: "1",
        NODE_DISABLE_COLORS: "1",
        TERM: "dumb",
      },
      TTY,
      true,
    ],
    [
      "FORCE_COLOR=1 beats an unset TERM",
      { FORCE_COLOR: "1", TERM: undefined },
      TTY,
      true,
    ],
    ["FORCE_COLOR=0 beats a terminal", { FORCE_COLOR: "0" }, TTY, false],
  ];
  for (const [name, env, stream, color] of cases) {
    test(`${name}: colour ${color ? "on" : "off"}`, () => {
      expect(detect(env, { stream }).color).toBe(color);
    });
  }

  test("mode plain wins over FORCE_COLOR", () => {
    expect(detect({ FORCE_COLOR: "1" }, { mode: "plain" })).toEqual({
      tty: true,
      color: false,
      live: false,
      unicode: false,
    });
  });

  test("mode plain keeps tty: it turns styling off, not the terminal", () => {
    expect(detect({}, { mode: "plain" }).tty).toBe(true);
    expect(detect({}, { mode: "plain", stream: PIPE }).tty).toBe(false);
  });

  test("mode fancy never adds colour the precedence refuses", () => {
    expect(detect({ NO_COLOR: "1" }, { mode: "fancy" }).color).toBe(false);
    expect(detect({}, { mode: "fancy", stream: PIPE }).color).toBe(false);
  });
});

test.describe("detectCapabilities — FORCE_COLOR off a terminal, per caller", () => {
  test("by default (the suite) FORCE_COLOR colours a pipe", () => {
    expect(detect({ FORCE_COLOR: "1" }, { stream: PIPE }).color).toBe(true);
    expect(
      detect({ FORCE_COLOR: "1" }, { stream: PIPE, forceColorWithoutTty: true })
        .color,
    ).toBe(true);
  });

  test("forceColorWithoutTty false (the orchestrator) never colours a pipe", () => {
    for (const mode of ["auto", "fancy"] as const) {
      expect(
        detect(
          { FORCE_COLOR: "1" },
          { stream: PIPE, mode, forceColorWithoutTty: false },
        ).color,
      ).toBe(false);
    }
  });

  test("forceColorWithoutTty changes nothing on a terminal", () => {
    for (const env of [{}, { FORCE_COLOR: "1", NO_COLOR: "1" }]) {
      expect(detect(env, { forceColorWithoutTty: false }).color).toBe(true);
    }
    expect(
      detect({ FORCE_COLOR: "0" }, { forceColorWithoutTty: false }).color,
    ).toBe(false);
  });
});

test.describe("detectCapabilities — the live region", () => {
  /** `[case, env, inputs beyond a terminal and auto, live]`. */
  const cases: readonly (readonly [
    string,
    Environment,
    Partial<CapabilityInputs>,
    boolean,
  ])[] = [
    ["a sized terminal", {}, {}, true],
    ["a pipe", {}, { stream: PIPE }, false],
    ["fancy on a pipe", {}, { stream: PIPE, mode: "fancy" }, false],
    [
      "a sized stream that says isTTY false",
      {},
      { stream: { isTTY: false, columns: 80, rows: 24 } },
      false,
    ],
    ["CI=true", { CI: "true" }, {}, false],
    ["CI=1", { CI: "1" }, {}, false],
    ["CI empty is off", { CI: "" }, {}, true],
    ["CI=false is off", { CI: "false" }, {}, true],
    ["CI=0 is off", { CI: "0" }, {}, true],
    ["CI=true under fancy", { CI: "true" }, { mode: "fancy" }, true],
    ["NO_COLOR keeps live", { NO_COLOR: "1" }, {}, true],
    ["FORCE_COLOR=0 keeps live", { FORCE_COLOR: "0" }, {}, true],
    ["TERM=dumb", { TERM: "dumb" }, {}, false],
    ["TERM=dumb under fancy", { TERM: "dumb" }, { mode: "fancy" }, false],
    ["TERM=dumb-x is not dumb", { TERM: "dumb-x" }, {}, true],
    ["TERM unset", { TERM: undefined }, {}, false],
    ["TERM empty", { TERM: "" }, {}, false],
    ["TERM unset under fancy", { TERM: undefined }, { mode: "fancy" }, false],
    [
      "TERM unset with FORCE_COLOR",
      { TERM: undefined, FORCE_COLOR: "1" },
      {},
      false,
    ],
    ["mode plain", {}, { mode: "plain" }, false],
    ["--ui", {}, { context: "ui" }, false],
    ["--watch", {}, { context: "watch" }, false],
    ["--list", {}, { context: "list" }, false],
    ["--ui under fancy", {}, { context: "ui", mode: "fancy" }, false],
    [
      "script's 0×0",
      {},
      { stream: { isTTY: true, columns: 0, rows: 0 } },
      false,
    ],
    ["0 columns", {}, { stream: { isTTY: true, columns: 0, rows: 24 } }, false],
    ["0 rows", {}, { stream: { isTTY: true, columns: 80, rows: 0 } }, false],
    [
      "1×1 is a size",
      {},
      { stream: { isTTY: true, columns: 1, rows: 1 } },
      true,
    ],
    [
      "NaN columns",
      {},
      { stream: { isTTY: true, columns: NaN, rows: 24 } },
      false,
    ],
    [
      "Infinity rows",
      {},
      { stream: { isTTY: true, columns: 80, rows: Infinity } },
      false,
    ],
    [
      "fractional columns",
      {},
      { stream: { isTTY: true, columns: 80.5, rows: 24 } },
      false,
    ],
    [
      "negative rows",
      {},
      { stream: { isTTY: true, columns: 80, rows: -1 } },
      false,
    ],
    ["no size", {}, { stream: { isTTY: true } }, false],
  ];
  for (const [name, env, overrides, live] of cases) {
    test(`${name}: live ${live ? "on" : "off"}`, () => {
      expect(detect(env, overrides).live).toBe(live);
    });
  }

  test("CI turns only the live region off, never colour", () => {
    expect(detect({ CI: "true" })).toEqual({
      tty: true,
      color: true,
      live: false,
      unicode: true,
    });
  });
});

test.describe("detectCapabilities — symbols", () => {
  /** `[case, env, extra inputs, Unicode]`. */
  const cases: readonly (readonly [
    string,
    Environment,
    Partial<CapabilityInputs>,
    boolean,
  ])[] = [
    ["no locale set", {}, {}, true],
    ["LANG=en_US.UTF-8", { LANG: "en_US.UTF-8" }, {}, true],
    ["LANG=C.UTF-8", { LANG: "C.UTF-8" }, {}, true],
    ["LC_CTYPE=UTF-8 (macOS)", { LC_CTYPE: "UTF-8" }, {}, true],
    ["LANG=C", { LANG: "C" }, {}, false],
    ["LANG=POSIX", { LANG: "POSIX" }, {}, false],
    ["LANG=en_US (no codeset)", { LANG: "en_US" }, {}, false],
    ["LANG=en_US.ISO8859-1", { LANG: "en_US.ISO8859-1" }, {}, false],
    [
      "LC_ALL=C beats a UTF-8 LANG",
      { LC_ALL: "C", LANG: "en_US.UTF-8" },
      {},
      false,
    ],
    [
      "LC_CTYPE=C beats a UTF-8 LANG",
      { LC_CTYPE: "C", LANG: "en_US.UTF-8" },
      {},
      false,
    ],
    [
      "LC_ALL UTF-8 beats LC_CTYPE=C",
      { LC_ALL: "en_US.UTF-8", LC_CTYPE: "C" },
      {},
      true,
    ],
    ["an empty LC_ALL is unset", { LC_ALL: "", LANG: "C" }, {}, false],
    ["TERM=dumb", { TERM: "dumb" }, {}, false],
    ["TERM=dumb-x is not dumb", { TERM: "dumb-x" }, {}, true],
    ["TERM unset keeps Unicode", { TERM: undefined }, {}, true],
    ["TERM unset with LANG=C", { TERM: undefined, LANG: "C" }, {}, false],
    [
      "FORCE_COLOR=1 keeps TERM=dumb's ASCII",
      { FORCE_COLOR: "1", TERM: "dumb" },
      {},
      false,
    ],
    ["mode plain", {}, { mode: "plain" }, false],
    ["a pipe keeps Unicode", {}, { stream: PIPE }, true],
    ["a pipe with LANG=C", { LANG: "C" }, { stream: PIPE }, false],
    [
      "fancy on a pipe keeps Unicode",
      {},
      { stream: PIPE, mode: "fancy" },
      true,
    ],
  ];
  for (const [name, env, overrides, unicode] of cases) {
    test(`${name}: ${unicode ? "Unicode" : "ASCII"}`, () => {
      expect(detect(env, overrides).unicode).toBe(unicode);
    });
  }
});

test.describe("the compatibility contract, row by row", () => {
  /** Each row of the contract: the sink, its inputs, and what it gets. */
  const rows: readonly (readonly [string, CapabilityInputs, Decided])[] = [
    [
      "TTY, UTF-8, no CI",
      { env: { ...XTERM, LANG: "en_US.UTF-8" }, stream: TTY },
      { color: true, live: true, unicode: true },
    ],
    [
      "TTY, NODE_DISABLE_COLORS",
      { env: { ...XTERM, NODE_DISABLE_COLORS: "1" }, stream: TTY },
      { color: false, live: true, unicode: true },
    ],
    [
      "TTY, CI",
      { env: { ...XTERM, CI: "true" }, stream: TTY },
      { color: true, live: false, unicode: true },
    ],
    [
      "TTY, CI, NO_COLOR",
      { env: { ...XTERM, CI: "true", NO_COLOR: "1" }, stream: TTY },
      { color: false, live: false, unicode: true },
    ],
    [
      "TTY, NO_COLOR",
      { env: { ...XTERM, NO_COLOR: "1" }, stream: TTY },
      { color: false, live: true, unicode: true },
    ],
    [
      "TTY, TERM=dumb",
      { env: { TERM: "dumb" }, stream: TTY },
      { color: false, live: false, unicode: false },
    ],
    [
      "TTY, TERM=dumb, FORCE_COLOR",
      { env: { TERM: "dumb", FORCE_COLOR: "1" }, stream: TTY },
      { color: true, live: false, unicode: false },
    ],
    [
      "TTY, TERM unset",
      { env: {}, stream: TTY },
      { color: false, live: false, unicode: true },
    ],
    [
      "TTY, TERM empty, C locale",
      { env: { TERM: "", LC_ALL: "C" }, stream: TTY },
      { color: false, live: false, unicode: false },
    ],
    [
      "TTY, TERM unset, FORCE_COLOR",
      { env: { FORCE_COLOR: "1" }, stream: TTY },
      { color: true, live: false, unicode: true },
    ],
    [
      "TTY, C locale",
      { env: { ...XTERM, LC_ALL: "C" }, stream: TTY },
      { color: true, live: true, unicode: false },
    ],
    [
      "TTY, POSIX locale, CI",
      { env: { ...XTERM, LANG: "POSIX", CI: "true" }, stream: TTY },
      { color: true, live: false, unicode: false },
    ],
    [
      "TTY, plain",
      { env: { ...XTERM, FORCE_COLOR: "1" }, stream: TTY, mode: "plain" },
      { color: false, live: false, unicode: false },
    ],
    [
      "TTY, fancy, CI",
      { env: { ...XTERM, CI: "true" }, stream: TTY, mode: "fancy" },
      { color: true, live: true, unicode: true },
    ],
    [
      "pipe, CI",
      { env: { ...XTERM, CI: "true" }, stream: PIPE },
      { color: false, live: false, unicode: true },
    ],
    [
      "pipe, C locale",
      { env: { ...XTERM, LC_ALL: "C" }, stream: PIPE },
      { color: false, live: false, unicode: false },
    ],
    [
      "pipe, FORCE_COLOR, the suite",
      { env: { ...XTERM, FORCE_COLOR: "1" }, stream: PIPE },
      { color: true, live: false, unicode: true },
    ],
    [
      "pipe, FORCE_COLOR, the orchestrator",
      {
        env: { ...XTERM, FORCE_COLOR: "1" },
        stream: PIPE,
        forceColorWithoutTty: false,
      },
      { color: false, live: false, unicode: true },
    ],
    [
      "pipe, fancy",
      { env: XTERM, stream: PIPE, mode: "fancy" },
      { color: false, live: false, unicode: true },
    ],
    [
      "pipe, fancy, FORCE_COLOR, the suite",
      { env: { ...XTERM, FORCE_COLOR: "1" }, stream: PIPE, mode: "fancy" },
      { color: true, live: false, unicode: true },
    ],
    [
      "pipe, plain",
      { env: { ...XTERM, FORCE_COLOR: "1" }, stream: PIPE, mode: "plain" },
      { color: false, live: false, unicode: false },
    ],
  ];
  for (const [name, inputs, expected] of rows) {
    test(name, () => {
      const { tty, ...decided } = detectCapabilities(inputs);
      expect(decided).toEqual(expected);
      expect(tty).toBe(inputs.stream === TTY);
    });
  }
});

test.describe("effectiveLocale and localeIsUtf8", () => {
  test("the first non-empty of LC_ALL, LC_CTYPE, LANG", () => {
    expect(effectiveLocale({})).toBeUndefined();
    expect(effectiveLocale({ LANG: "a" })).toBe("a");
    expect(effectiveLocale({ LC_CTYPE: "b", LANG: "a" })).toBe("b");
    expect(effectiveLocale({ LC_ALL: "c", LC_CTYPE: "b", LANG: "a" })).toBe(
      "c",
    );
    expect(effectiveLocale({ LC_ALL: "", LC_CTYPE: "b", LANG: "a" })).toBe("b");
    expect(
      effectiveLocale({ LC_ALL: "", LC_CTYPE: "", LANG: "" }),
    ).toBeUndefined();
  });

  /** `[locale, UTF-8]`: a codeset decides; a name without one is not UTF-8 unless it is `UTF-8`. */
  const locales: readonly (readonly [string | undefined, boolean])[] = [
    [undefined, true],
    ["C", false],
    ["c", false],
    ["POSIX", false],
    ["C.UTF-8", true],
    ["C.utf8", true],
    ["en_US.UTF-8", true],
    ["en_US.utf8", true],
    ["en_US.UTF8", true],
    ["en_US.utf-8", true],
    ["de_DE.UTF-8@euro", true],
    ["UTF-8", true],
    ["utf8", true],
    ["en_US", false],
    ["de_DE@euro", false],
    ["en_US.ISO8859-1", false],
    ["en_US.UTF-16", false],
    ["en_US.", false],
    ["C@modifier", false],
  ];
  for (const [locale, utf8] of locales) {
    test(`${String(locale)}: ${utf8 ? "UTF-8" : "not UTF-8"}`, () => {
      expect(localeIsUtf8(locale)).toBe(utf8);
    });
  }
});

test.describe("isCi", () => {
  /** `[CI, on]`; `undefined` is unset. */
  const values: readonly (readonly [string | undefined, boolean])[] = [
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["False", false],
    ["FALSE", false],
    ["1", true],
    ["true", true],
    ["woodpecker", true],
  ];
  for (const [value, on] of values) {
    test(`CI=${JSON.stringify(value)}: ${on ? "on" : "off"}`, () => {
      expect(isCi(value === undefined ? {} : { CI: value })).toBe(on);
    });
  }
});
