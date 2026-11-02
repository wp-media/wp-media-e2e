import { test, expect } from "@playwright/test";

import {
  consolePrinters,
  streamPalette,
  workerPalette,
  workerPrinters,
} from "./output";

/**
 * The palettes for code printing outside the run's reporter, decided from an injected environment
 * and stream: every case is the shared precedence (`terminal/capabilities.ts`) plus `E2E_OUTPUT`.
 */

/** The escape character, built rather than written into a pattern. */
const ESC = String.fromCharCode(27);

const TTY = { isTTY: true, columns: 80, rows: 24 };
const PIPE = { isTTY: false };
/** A UTF-8 terminal's environment, nothing else set. */
const BASE: NodeJS.ProcessEnv = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

test.describe("streamPalette", () => {
  test("a terminal: colour and Unicode", () => {
    const palette = streamPalette(TTY, BASE);
    expect(palette.paint("ok", "x")).toBe(`${ESC}[32mx${ESC}[39m`);
    expect(palette.symbol("arrow")).toBe("→");
  });

  test("a pipe or file: no escape, Unicode kept", () => {
    const palette = streamPalette(PIPE, BASE);
    expect(palette.paint("fail", "x")).toBe("x");
    expect(palette.symbol("check")).toBe("✓");
  });

  test("NO_COLOR: no colour on a terminal, Unicode kept", () => {
    const palette = streamPalette(TTY, { ...BASE, NO_COLOR: "1" });
    expect(palette.paint("emphasis", "x")).toBe("x");
    expect(palette.symbol("arrow")).toBe("→");
  });

  test("E2E_OUTPUT=plain: no colour and ASCII, even on a terminal under FORCE_COLOR", () => {
    const palette = streamPalette(TTY, {
      ...BASE,
      E2E_OUTPUT: "plain",
      FORCE_COLOR: "1",
    });
    expect(palette.paint("ok", "x")).toBe("x");
    expect(palette.symbol("arrow")).toBe("->");
  });

  test("a C locale: ASCII symbols, colour unchanged", () => {
    const palette = streamPalette(TTY, { ...BASE, LANG: "C" });
    expect(palette.symbol("cross")).toBe("x");
    expect(palette.paint("warn", "x")).toBe(`${ESC}[33mx${ESC}[39m`);
  });

  test("FORCE_COLOR colours a pipe, as a suite run does", () => {
    expect(
      streamPalette(PIPE, { ...BASE, FORCE_COLOR: "1" }).paint("ok", "x"),
    ).toBe(`${ESC}[32mx${ESC}[39m`);
  });

  test("an E2E_OUTPUT that is no mode fails, naming the variable", () => {
    expect(() => streamPalette(TTY, { ...BASE, E2E_OUTPUT: "fancyy" })).toThrow(
      /E2E_OUTPUT/,
    );
  });
});

test.describe("workerPalette", () => {
  test("never colours, even under the FORCE_COLOR=1 workers run with", () => {
    const palette = workerPalette({ ...BASE, FORCE_COLOR: "1" });
    expect(palette.paint("fail", "x")).toBe("x");
    expect(palette.symbol("check")).toBe("✓");
  });

  test("ASCII under E2E_OUTPUT=plain, TERM=dumb or a C locale", () => {
    for (const extra of [
      { E2E_OUTPUT: "plain" },
      { TERM: "dumb" },
      { LC_ALL: "POSIX" },
    ]) {
      expect(workerPalette({ ...BASE, ...extra }).symbol("arrow")).toBe("->");
    }
  });
});

test.describe("consolePrinters", () => {
  test("stdout through console.log, stderr through console.error, each with its palette", () => {
    const printed: string[] = [];
    const { log, error } = console;
    console.log = (line: string) => printed.push(`out:${line}`);
    console.error = (line: string) => printed.push(`err:${line}`);
    try {
      const { out, err } = consolePrinters({ ...BASE, E2E_OUTPUT: "plain" });
      out.print("a");
      err.print("b");
      expect(out.palette.symbol("arrow")).toBe("->");
      expect(err.palette.paint("fail", "x")).toBe("x");
    } finally {
      console.log = log;
      console.error = error;
    }
    expect(printed).toEqual(["out:a", "err:b"]);
  });
});

test.describe("consolePrinters — each stream's own palette", () => {
  // `script` on a terminal, `2> err.txt`: the errors file must hold no escape.
  test("a terminal's stdout is coloured, a redirected stderr is not", () => {
    const { out, err } = consolePrinters(BASE, { stdout: TTY, stderr: PIPE });
    expect(out.palette.paint("fail", "x")).toBe(`${ESC}[31mx${ESC}[39m`);
    expect(err.palette.paint("fail", "x")).toBe("x");
  });

  test("and the other way round", () => {
    const { out, err } = consolePrinters(BASE, { stdout: PIPE, stderr: TTY });
    expect(out.palette.paint("fail", "x")).toBe("x");
    expect(err.palette.paint("fail", "x")).toBe(`${ESC}[31mx${ESC}[39m`);
  });
});

test.describe("workerPrinters", () => {
  test("console.log and console.warn, both with the worker's colourless palette", () => {
    const printed: string[] = [];
    const { log, warn } = console;
    console.log = (line: string) => printed.push(`log:${line}`);
    console.warn = (line: string) => printed.push(`warn:${line}`);
    try {
      const { out, err } = workerPrinters({
        ...BASE,
        FORCE_COLOR: "1",
        LANG: "C",
      });
      out.print(out.palette.paint("ok", out.palette.symbol("check")));
      err.print(err.palette.paint("warn", err.palette.symbol("warning")));
    } finally {
      console.log = log;
      console.warn = warn;
    }
    expect(printed).toEqual(["log:ok", "warn:!"]);
  });
});
