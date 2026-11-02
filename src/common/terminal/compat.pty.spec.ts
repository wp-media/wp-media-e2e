import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { test, expect, type TestInfo } from "@playwright/test";

import {
  ptyRunner,
  runToEnd,
  scriptArgv,
  shellQuote,
  type ChildOutput,
} from "../__fixtures__/pty";
import { isCi } from "./capabilities";
import { displayWidth } from "./layout";

/**
 * The compatibility matrix, end to end: each row of the terminal-output contract (a sink — a sized
 * pty, an unsized one, a pipe — and an environment) run through each front end's real entry, in a
 * fresh Node whose standard output is that sink: the suite's terminal reporter and summary
 * (`__fixtures__/compat/suite-probe.ts`), the orchestrator's screen and logger
 * (`orchestrator/__fixtures__/compat-probe.ts`) and a standalone script's printers
 * (`__fixtures__/compat/script-probe.ts`, the healthcheck's lines). What reaches the sink is read for
 * the four columns: colour (an SGR that sets a style), live (an erase: `\x1b[2K`), symbols (Unicode
 * marks, or nothing but ASCII) and width (the summary's rule, the orchestrator's wrapped lines; a
 * script's rules are 72 columns whatever the terminal). A script's standard error is read apart — on a
 * pty it goes to a file, never the terminal — so its two palettes are seen to follow their own streams.
 *
 * The front ends differ on purpose, and each case says how: the orchestrator reads no `E2E_*`, never
 * colours a pipe (`forceColorWithoutTty: false`), shows its table only where the terminal redraws in
 * place, wraps only on a terminal, and keeps its lines' own glyphs (`✔`, `·`) in any locale — only its
 * table's marks follow the palette; a script is never live. Locally a missing `script` skips; under
 * `CI` it fails, so the matrix is never silently absent.
 */

/** tsx's loader, so a probe imports the TypeScript under test. */
const TSX_LOADER = import.meta.resolve("tsx");

/** The three probes. */
const PROBES = {
  suite: fileURLToPath(
    new URL("../__fixtures__/compat/suite-probe.ts", import.meta.url),
  ),
  orchestrator: fileURLToPath(
    new URL(
      "../../../orchestrator/__fixtures__/compat-probe.ts",
      import.meta.url,
    ),
  ),
  script: fileURLToPath(
    new URL("../__fixtures__/compat/script-probe.ts", import.meta.url),
  ),
} as const;

/** The size `stty` gives a sized pty. */
const SIZE = { columns: 100, rows: 30 } as const;

/** A script's rules: a fixed width, so a log reads the same from any terminal. */
const SCRIPT_RULE_WIDTH = 72;

/** What a probe leaves its test for reporting a time-out. */
const PROBE_MARGIN_MS = 5_000;

/** A probe's limit when its test has none (`timeout: 0`). */
const UNBOUNDED_TEST_PROBE_MS = 60_000;

/** An SGR that sets a style (bold, dim, a colour); a reset alone is no colour. */
// eslint-disable-next-line no-control-regex -- finding an escape is the point.
const STYLE_SGR = /\x1b\[(?:1|2|3[0-7]|9[0-7])m/;

/** The erase every live redraw writes. */
const ERASE = "\x1b[2K";

/** The orchestrator's outcome line, as its probe logs it (`OUTCOME_TEXT`). */
const OUTCOME_HEAD = "bpng-12 ✔ passed · 52 scenarios";
const OUTCOME_TAIL = "the widest terminal the layout allows";

/** Where the output goes. */
type Sink = "pty" | "unsized pty" | "pipe";

/** What the suite shows: the contract's four columns. */
interface SuiteExpected {
  readonly color: boolean;
  readonly live: boolean;
  readonly unicode: boolean;
  /** The summary's rule, in columns. */
  readonly width: number;
}

/** What the orchestrator shows. */
interface OrchestratorExpected {
  readonly color: boolean;
  /** Whether the status table is drawn (and erased). */
  readonly table: boolean;
  /** The table's marks in Unicode; only read when it is drawn. */
  readonly unicode: boolean;
  /** The width its lines wrap at; `undefined` when they are never wrapped (a pipe). */
  readonly wrapAt: number | undefined;
}

/** What a script shows: never live, its rules always {@link SCRIPT_RULE_WIDTH}. */
interface ScriptExpected {
  readonly color: boolean;
  readonly unicode: boolean;
  /**
   * Whether its warning on standard error is coloured. That stream is never a terminal here (a pipe,
   * or a file on a pty), so only an on `FORCE_COLOR` outside `plain` colours it.
   */
  readonly stderrColor: boolean;
}

/** One row of the matrix. */
interface MatrixCase {
  /** The contract's row, then what this case sets. */
  readonly name: string;
  readonly sink: Sink;
  /** Over the base environment; `undefined` removes a variable (`TERM`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly suite: SuiteExpected;
  readonly orchestrator: OrchestratorExpected;
  readonly script: ScriptExpected;
}

/**
 * The common case on a sized pty — colour, live, Unicode, its 100 columns — with what a row changes.
 *
 * @param name - the row and its variables.
 * @param env - the variables.
 * @param changes - each front end's differences from the common case.
 */
function onPty(
  name: string,
  env: MatrixCase["env"],
  changes: {
    readonly suite?: Partial<SuiteExpected>;
    readonly orchestrator?: Partial<OrchestratorExpected>;
    readonly script?: Partial<ScriptExpected>;
  } = {},
): MatrixCase {
  return {
    name,
    sink: "pty",
    env,
    suite: {
      color: true,
      live: true,
      unicode: true,
      width: SIZE.columns,
      ...changes.suite,
    },
    orchestrator: {
      color: true,
      table: true,
      unicode: true,
      wrapAt: SIZE.columns,
      ...changes.orchestrator,
    },
    script: {
      color: true,
      unicode: true,
      stderrColor: false,
      ...changes.script,
    },
  };
}

/**
 * The common case in a pipe — no colour, no live, Unicode, 80 columns — with what a row changes.
 *
 * @param name - the row and its variables.
 * @param env - the variables.
 * @param changes - each front end's differences from the common case.
 */
function inPipe(
  name: string,
  env: MatrixCase["env"],
  changes: {
    readonly suite?: Partial<SuiteExpected>;
    readonly script?: Partial<ScriptExpected>;
    readonly orchestrator?: Partial<OrchestratorExpected>;
  } = {},
): MatrixCase {
  return {
    name,
    sink: "pipe",
    env,
    suite: {
      color: false,
      live: false,
      unicode: true,
      width: 80,
      ...changes.suite,
    },
    orchestrator: {
      color: false,
      table: false,
      unicode: true,
      wrapAt: undefined,
      ...changes.orchestrator,
    },
    script: {
      color: false,
      unicode: true,
      stderrColor: false,
      ...changes.script,
    },
  };
}

const noColour = { color: false } as const;
const notLive = { live: false } as const;
const noTable = { table: false } as const;
const ascii = { unicode: false } as const;
/** A script whose standard error, too, is coloured: an on `FORCE_COLOR` outside `plain`. */
const forcedStderr = { stderrColor: true } as const;

/**
 * Every row of the contract, per sink, with the variables that decide it set where they change the
 * outcome: `NO_COLOR` (empty or not), `CI` (empty, `false`, `true`), `NODE_DISABLE_COLORS` (`1`,
 * empty), `FORCE_COLOR` (`0`, `false`, `FALSE`, `1`, `true`, empty — each on value over `NO_COLOR=1`,
 * `TERM` unset or `dumb`, or a pipe), `TERM` (`dumb`, unset, empty), the locale (`LANG`, `LC_ALL`,
 * an empty `LC_ALL`), `COLUMNS` (valid, garbage, 0, negative, past the cap) and `E2E_OUTPUT`.
 */
const CASES: readonly MatrixCase[] = [
  // TTY, UTF-8, no CI.
  onPty("TTY, UTF-8, no CI", {}),
  onPty("TTY: NO_COLOR empty is no NO_COLOR", { NO_COLOR: "" }),
  onPty("TTY: CI empty is no CI", { CI: "" }),
  onPty("TTY: CI=false is no CI", { CI: "false" }),
  onPty(
    "TTY: NODE_DISABLE_COLORS=1",
    { NODE_DISABLE_COLORS: "1" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  onPty(
    "TTY: NODE_DISABLE_COLORS empty still turns colour off",
    { NODE_DISABLE_COLORS: "" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  onPty(
    "TTY: FORCE_COLOR=0",
    { FORCE_COLOR: "0" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  onPty(
    "TTY: FORCE_COLOR=false",
    { FORCE_COLOR: "false" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  onPty(
    "TTY: FORCE_COLOR=FALSE is off in any case",
    { FORCE_COLOR: "FALSE" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  onPty(
    "TTY: FORCE_COLOR=1 wins over NO_COLOR=1",
    { FORCE_COLOR: "1", NO_COLOR: "1" },
    { script: forcedStderr },
  ),
  onPty(
    "TTY: FORCE_COLOR=true wins over NO_COLOR=1",
    { FORCE_COLOR: "true", NO_COLOR: "1" },
    { script: forcedStderr },
  ),
  onPty(
    "TTY: FORCE_COLOR empty is on, over NO_COLOR=1",
    { FORCE_COLOR: "", NO_COLOR: "1" },
    { script: forcedStderr },
  ),
  onPty("TTY: COLUMNS=90, the terminal's 100 columns win", {
    COLUMNS: "90",
  }),
  // TTY, CI.
  onPty(
    "TTY, CI=true",
    { CI: "true" },
    { suite: notLive, orchestrator: noTable },
  ),
  onPty(
    "TTY, CI=true with E2E_OUTPUT=fancy: the suite is live, the orchestrator reads no E2E_*",
    { CI: "true", E2E_OUTPUT: "fancy" },
    { orchestrator: noTable },
  ),
  // TTY, NO_COLOR.
  onPty(
    "TTY, NO_COLOR=1",
    { NO_COLOR: "1" },
    { suite: noColour, orchestrator: noColour, script: noColour },
  ),
  // TTY, TERM=dumb.
  onPty(
    "TTY, TERM=dumb",
    { TERM: "dumb" },
    {
      suite: { ...noColour, ...notLive, ...ascii },
      orchestrator: { ...noColour, ...noTable },
      script: { ...noColour, ...ascii },
    },
  ),
  onPty(
    "TTY, TERM=dumb with FORCE_COLOR=1",
    { TERM: "dumb", FORCE_COLOR: "1" },
    {
      suite: { ...notLive, ...ascii },
      orchestrator: noTable,
      script: { ...ascii, ...forcedStderr },
    },
  ),
  // TTY, TERM unset or empty.
  onPty(
    "TTY, TERM unset",
    { TERM: undefined },
    {
      suite: { ...noColour, ...notLive },
      orchestrator: { ...noColour, ...noTable },
      script: noColour,
    },
  ),
  onPty(
    "TTY, TERM empty",
    { TERM: "" },
    {
      suite: { ...noColour, ...notLive },
      orchestrator: { ...noColour, ...noTable },
      script: noColour,
    },
  ),
  onPty(
    "TTY, TERM unset with FORCE_COLOR=1",
    { TERM: undefined, FORCE_COLOR: "1" },
    { suite: notLive, orchestrator: noTable, script: forcedStderr },
  ),
  // TTY, a locale: UTF-8 keeps the symbols; C/POSIX/non-UTF-8 changes them only.
  onPty("TTY, LANG=en_US.UTF-8", { LANG: "en_US.UTF-8" }),
  onPty(
    "TTY, LC_ALL=C",
    { LC_ALL: "C" },
    { suite: ascii, orchestrator: ascii, script: ascii },
  ),
  onPty(
    "TTY, LC_ALL empty with LANG=C: LANG decides",
    { LC_ALL: "", LANG: "C" },
    { suite: ascii, orchestrator: ascii, script: ascii },
  ),
  onPty(
    "TTY, LANG=en_US.ISO-8859-1",
    { LANG: "en_US.ISO-8859-1" },
    { suite: ascii, orchestrator: ascii, script: ascii },
  ),
  onPty(
    "TTY, LC_ALL=POSIX with NO_COLOR=1",
    { LC_ALL: "POSIX", NO_COLOR: "1" },
    {
      suite: { ...noColour, ...ascii },
      orchestrator: { ...noColour, ...ascii },
      script: { ...noColour, ...ascii },
    },
  ),
  // plain.
  onPty(
    "plain on a TTY, FORCE_COLOR=1 too: the orchestrator reads no E2E_*",
    { E2E_OUTPUT: "plain", FORCE_COLOR: "1" },
    {
      suite: { ...noColour, ...notLive, ...ascii },
      script: { ...noColour, ...ascii },
    },
  ),
  // A pty no one sized (0×0): a terminal, never live; the width falls back.
  {
    ...onPty(
      "TTY of 0×0: COLUMNS=90",
      { COLUMNS: "90" },
      {
        suite: { ...notLive, width: 90 },
        orchestrator: { ...noTable, wrapAt: 90 },
      },
    ),
    sink: "unsized pty",
  },
  {
    ...onPty(
      "TTY of 0×0: COLUMNS garbage is 80",
      { COLUMNS: "90x" },
      {
        suite: { ...notLive, width: 80 },
        orchestrator: { ...noTable, wrapAt: 80 },
      },
    ),
    sink: "unsized pty",
  },
  // Pipe/file (fancy too).
  inPipe("pipe", {}),
  inPipe("pipe: COLUMNS=90", { COLUMNS: "90" }, { suite: { width: 90 } }),
  inPipe(
    "pipe: COLUMNS=500 is capped at 120",
    { COLUMNS: "500" },
    {
      suite: { width: 120 },
    },
  ),
  inPipe("pipe: COLUMNS=0 is 80", { COLUMNS: "0" }),
  inPipe("pipe: COLUMNS=-5 is 80", { COLUMNS: "-5" }),
  inPipe(
    "pipe: FORCE_COLOR=1 colours the suite and a script, never the orchestrator",
    { FORCE_COLOR: "1" },
    { suite: { color: true }, script: { color: true, ...forcedStderr } },
  ),
  inPipe(
    "pipe: FORCE_COLOR empty colours the suite and a script, never the orchestrator",
    { FORCE_COLOR: "" },
    { suite: { color: true }, script: { color: true, ...forcedStderr } },
  ),
  inPipe("pipe: E2E_OUTPUT=fancy is never live there", {
    E2E_OUTPUT: "fancy",
    TERM: "xterm-256color",
  }),
  inPipe("pipe: CI=true", { CI: "true" }),
  inPipe("pipe: LC_ALL=C", { LC_ALL: "C" }, { suite: ascii, script: ascii }),
  inPipe(
    "pipe: E2E_OUTPUT=plain wins over FORCE_COLOR=1",
    { E2E_OUTPUT: "plain", FORCE_COLOR: "1" },
    { suite: ascii, script: ascii },
  ),
];

/**
 * A probe's environment: only what the case names over a fixed base, so the runner's own `CI`,
 * `NO_COLOR`, `FORCE_COLOR`, `COLUMNS` or locale never leak in, and no `.env` is read.
 *
 * @param matrixCase - the case.
 */
function probeEnv(matrixCase: MatrixCase): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    E2E_LOAD_DOTENV: "false",
    ...matrixCase.env,
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged))
    if (value !== undefined) env[name] = value;
  return env;
}

/**
 * How long a probe may run: its test's limit, less a margin to fail with its output.
 *
 * @param testInfo - the running test.
 */
function probeLimitMs(testInfo: TestInfo): number {
  if (testInfo.timeout === 0) return UNBOUNDED_TEST_PROBE_MS;
  return Math.max(1_000, testInfo.timeout - PROBE_MARGIN_MS);
}

/**
 * Runs a probe on the case's sink and returns what reached it: in a pipe, standard output and
 * standard error apart; on a pty, the terminal's bytes — the probe's standard error included, unless
 * `stderrFile` takes it (it is then that file's content, and no terminal).
 *
 * @param script - the `script` executable, for a pty.
 * @param probe - the probe's file.
 * @param args - its arguments.
 * @param matrixCase - the case.
 * @param testInfo - the running test: its time limit.
 * @param stderrFile - on a pty, where the probe's standard error goes instead of the terminal.
 */
async function runProbe(
  script: string | undefined,
  probe: string,
  args: readonly string[],
  matrixCase: MatrixCase,
  testInfo: TestInfo,
  stderrFile?: string,
): Promise<ChildOutput> {
  const argv = [process.execPath, "--import", TSX_LOADER, probe, ...args];
  const env = probeEnv(matrixCase);
  const limit = probeLimitMs(testInfo);
  if (matrixCase.sink === "pipe")
    return runToEnd(argv[0] ?? "", argv.slice(1), env, limit);
  if (script === undefined) throw new Error("no pty runner");
  const size =
    matrixCase.sink === "pty"
      ? `stty cols ${String(SIZE.columns)} rows ${String(SIZE.rows)} && `
      : "";
  const redirect =
    stderrFile === undefined ? "" : ` 2>${shellQuote(stderrFile)}`;
  const command = `${size}exec ${argv.map(shellQuote).join(" ")}${redirect}`;
  const [file = "", ...rest] = scriptArgv(script, command) ?? [];
  const output = await runToEnd(file, rest, env, limit);
  if (stderrFile === undefined) return output;
  return { stdout: output.stdout, stderr: readFileSync(stderrFile, "utf8") };
}

/**
 * What a sink showed, as lines: escapes removed, a pty's `\r\n` (and the region's `\r\r\n`) made `\n`,
 * any other carriage return dropped.
 *
 * @param bytes - what reached the sink.
 */
function shownLines(bytes: string): string[] {
  return stripVTControlCharacters(bytes)
    .replace(/\r+\n/g, "\n")
    .replaceAll("\r", "")
    .split("\n");
}

/**
 * Whether every character shown is ASCII (escapes and line ends aside).
 *
 * @param bytes - what reached the sink.
 */
function allAscii(bytes: string): boolean {
  // eslint-disable-next-line no-control-regex -- every code point up to U+007F, controls included.
  return /^[\x00-\x7f]*$/.test(shownLines(bytes).join("\n"));
}

/**
 * The checks of what the suite printed.
 *
 * @param bytes - what reached the sink.
 * @param expected - the case's columns.
 */
function checkSuite(bytes: string, expected: SuiteExpected): void {
  const lines = shownLines(bytes);
  expect(STYLE_SGR.test(bytes), "suite: colour").toBe(expected.color);
  expect(bytes.includes(ERASE), "suite: live").toBe(expected.live);
  // Every scenario printed once, whole, whatever the sink.
  expect(
    lines.filter((line) => line.endsWith("A scenario")),
    "suite: the scenario's line",
  ).toHaveLength(1);
  if (expected.unicode) {
    expect(bytes, "suite: Unicode marks").toContain("✔");
    expect(bytes, "suite: Unicode breadcrumb").toContain("Demo feature › ");
  } else expect(allAscii(bytes), "suite: nothing but ASCII").toBe(true);
  // The summary's rule spans the terminal's width; its counts take the palette's separator.
  const header = lines.find((line) => /^(?:━━|==) demo /.test(line));
  expect(displayWidth(header ?? ""), "suite: the summary's rule").toBe(
    expected.width,
  );
  expect(lines, "suite: the counts").toContainEqual(
    `  Result      1 passed ${expected.unicode ? "·" : "."} 1 skipped, in 2s`,
  );
}

/**
 * The checks of what the orchestrator printed and logged.
 *
 * @param bytes - what reached the sink.
 * @param log - `orchestrator.log`.
 * @param expected - the case's columns.
 */
function checkOrchestrator(
  bytes: string,
  log: string,
  expected: OrchestratorExpected,
): void {
  const lines = shownLines(bytes);
  expect(STYLE_SGR.test(bytes), "orchestrator: colour").toBe(expected.color);
  expect(bytes.includes(ERASE), "orchestrator: live").toBe(expected.table);
  const rows = lines.filter((line) => line.startsWith("bpng  "));
  expect(
    lines.some((line) => line.startsWith("TASK  RUN")),
    "orchestrator: the table",
  ).toBe(expected.table);
  if (expected.table)
    expect(rows[0], "orchestrator: the table's mark").toContain(
      expected.unicode ? "✔ passed · 52" : "OK passed . 52",
    );
  // Its lines keep their own glyphs, in every locale.
  const outcome = lines.findIndex((line) => line.includes(OUTCOME_HEAD));
  expect(outcome, "orchestrator: the outcome line").toBeGreaterThanOrEqual(0);
  if (expected.wrapAt === undefined) {
    expect(lines[outcome], "orchestrator: a whole line").toContain(
      OUTCOME_TAIL,
    );
  } else {
    // Wrapped at the terminal's width, at spaces, the rest under the message, down to its tail.
    const tail = lines.findIndex(
      (line, index) => index > outcome && line.endsWith(" allows"),
    );
    expect(tail, "orchestrator: the wrapped rest").toBeGreaterThan(outcome);
    // No word lost or broken: the parts, joined at their spaces, give the text back.
    expect(
      lines
        .slice(outcome, tail + 1)
        .map((line) => line.trim())
        .join(" "),
    ).toContain(OUTCOME_TAIL);
    const parts = lines.slice(outcome, tail + 1);
    for (const [index, line] of parts.entries()) {
      if (index > 0)
        expect(line, "orchestrator: under the message").toMatch(/^ {2,}\S/);
      expect(displayWidth(line), line).toBeLessThanOrEqual(expected.wrapAt);
      // Wrapped at that width, no narrower: the next part's first word would not have fit here.
      const next = parts[index + 1];
      if (next === undefined) continue;
      const nextWord = next.trim().split(" ", 1)[0] ?? "";
      expect(
        displayWidth(line) + 1 + displayWidth(nextWord),
        `"${line}" could have taken "${nextWord}"`,
      ).toBeGreaterThan(expected.wrapAt);
    }
  }
  // The log stays byte-plain, its lines whole.
  expect(log).not.toContain("\x1b");
  expect(log).toContain(OUTCOME_TAIL);
}

/**
 * The checks of what a script printed.
 *
 * @param bytes - what reached the sink.
 * @param stderr - what it wrote to standard error: its warning.
 * @param expected - the case's columns.
 */
function checkScript(
  bytes: string,
  stderr: string,
  expected: ScriptExpected,
): void {
  const lines = shownLines(bytes);
  expect(STYLE_SGR.test(bytes), "script: colour").toBe(expected.color);
  expect(bytes.includes(ERASE), "script: never live").toBe(false);
  if (expected.unicode) expect(bytes, "script: Unicode marks").toContain("✔");
  else expect(allAscii(bytes), "script: nothing but ASCII").toBe(true);
  const rules = lines.filter((line) => /^(?:─+|-+)$/.test(line));
  expect(rules.length, "script: its rules").toBeGreaterThan(0);
  for (const rule of rules)
    expect(displayWidth(rule), "script: a fixed rule").toBe(SCRIPT_RULE_WIDTH);
  // Its warning, styled by standard error's own palette.
  expect(STYLE_SGR.test(stderr), "script: standard error's colour").toBe(
    expected.stderrColor,
  );
  expect(stripVTControlCharacters(stderr), "script: its warning").toContain(
    `${expected.unicode ? "⚠" : "!"} a warning`,
  );
}

test.describe("the compatibility matrix, per sink and front end", () => {
  const runner = ptyRunner();
  const needsPty = CASES.some((matrixCase) => matrixCase.sink !== "pipe");
  /** The `script` to run, or a failure naming what is missing. */
  function requireScript(): string {
    if ("missing" in runner) throw new Error(runner.missing);
    return runner.script;
  }

  for (const matrixCase of CASES) {
    test(`${matrixCase.name} (${matrixCase.sink})`, async () => {
      const pty = matrixCase.sink !== "pipe";
      // Locally a missing `script` skips a pty case; under CI it fails.
      test.skip(
        needsPty && pty && "missing" in runner && !isCi(process.env),
        "missing" in runner ? runner.missing : "",
      );
      const script = pty ? requireScript() : undefined;
      const info = test.info();
      const folder = info.outputPath("state");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const [suite, orchestrator, scriptRun] = await Promise.all([
        runProbe(script, PROBES.suite, [folder], matrixCase, info),
        runProbe(script, PROBES.orchestrator, [folder], matrixCase, info),
        runProbe(
          script,
          PROBES.script,
          [],
          matrixCase,
          info,
          join(folder, "script.stderr"),
        ),
      ]);
      // In a pipe the suite's and the orchestrator's standard error carry nothing styled (on a pty it
      // is the terminal, read with standard output).
      if (!pty)
        for (const run of [suite, orchestrator])
          expect(STYLE_SGR.test(run.stderr), run.stderr).toBe(false);
      checkSuite(suite.stdout, matrixCase.suite);
      checkOrchestrator(
        orchestrator.stdout,
        readFileSync(join(folder, "orchestrator.log"), "utf8"),
        matrixCase.orchestrator,
      );
      checkScript(scriptRun.stdout, scriptRun.stderr, matrixCase.script);
    });
  }
});
