import { spawn } from "node:child_process";
import { accessSync, constants, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";

import { test, expect, type TestInfo } from "@playwright/test";

import {
  isCi,
  type OutputMode,
  type TerminalCapabilities,
} from "./capabilities";

/**
 * The capabilities and the palette on a **real** pseudo-terminal. A hand-built `{ isTTY: true }`
 * stream is no terminal to Node: `styleText` refuses it or takes another branch (each case measures
 * that contrast), so what Node does on a terminal is only measured through `script`, which runs the
 * probe on a pty. Both BSD `script` (macOS) and util-linux's (CI's Ubuntu, which takes `-qec`) give a
 * pty 0 columns and 0 rows when their own input is no terminal, until `stty` sizes it (measured).
 *
 * Each case is its own test, so the runner's worker count bounds how many probes start at once and
 * each probe's time limit comes from its test's.
 */

/** tsx's loader, so the probe imports the TypeScript under test. */
const TSX_LOADER = import.meta.resolve("tsx");

/** What a probe leaves its test for reporting a time-out: room to kill it and fail with its output. */
const PROBE_MARGIN_MS = 5_000;

/** A probe's limit when its test has none (`timeout: 0`). */
const UNBOUNDED_TEST_PROBE_MS = 60_000;

/** How long a timed-out probe gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/** The size `stty` gives the pty in a sized case. */
const SIZE = { columns: 100, rows: 30 } as const;

/** Frames the probe's JSON, so `script`'s own bytes (`^D`, backspaces, `\r`) never confuse a parse. */
const FRAME = /@@(\{.*\})@@/;

/** What the probe reports from inside the pty. */
interface ProbeResult {
  readonly isTTY: boolean;
  readonly columns: number | undefined;
  readonly rows: number | undefined;
  /** `styleText("green", "x")` with Node's own checks. */
  readonly nodeDefault: string;
  /** `styleText("green", "x", { validateStream: false })`. */
  readonly bypass: string;
  /** `styleText("green", "x", { stream })` for a hand-built writable that says `isTTY: true`. */
  readonly fakeStream: string;
  readonly capabilities: TerminalCapabilities;
  /** {@link SAMPLE}'s parts from the palette of those capabilities, joined by `|`. */
  readonly sample: string;
}

/** A probe's report, and everything the pty showed (its standard error included). */
interface ProbeRun {
  readonly result: ProbeResult;
  readonly screen: string;
}

/**
 * The probe: runs in the pty, decides from its real `process.stdout` in the mode its first argument
 * names, prints one framed line.
 */
function probeSource(): string {
  const module = (name: string): string =>
    JSON.stringify(pathToFileURL(join(import.meta.dirname, name)).href);
  return `
import { Writable } from "node:stream";
import { styleText } from "node:util";
import { detectCapabilities } from ${module("capabilities.ts")};
import { createPalette } from ${module("palette.ts")};
const capabilities = detectCapabilities({ env: process.env, stream: process.stdout, mode: process.argv[2] });
const palette = createPalette(capabilities);
const sample = [palette.paint("ok", "t"), palette.symbol("passed"), palette.status("failed"), palette.status("flaky")].join("|");
const fake = new Writable({ write: (_chunk, _encoding, done) => done() });
fake.isTTY = true;
const nodeDefault = styleText("green", "x");
const fakeStream = styleText("green", "x", { stream: fake });
const result = {
  isTTY: process.stdout.isTTY === true,
  columns: process.stdout.columns,
  rows: process.stdout.rows,
  nodeDefault,
  bypass: styleText("green", "x", { validateStream: false }),
  fakeStream,
  capabilities,
  sample,
};
process.stdout.write("\\n@@" + JSON.stringify(result) + "@@\\n");
`;
}

/** {@link ProbeResult.sample} for each colour × Unicode decision, typed out. */
const SAMPLE = {
  colourUnicode:
    "\x1b[32mt\x1b[39m|✔|\x1b[31m✘\x1b[39m|\x1b[33m⚠\x1b[39m flaky",
  colourAscii: "\x1b[32mt\x1b[39m|OK|\x1b[31mx\x1b[39m|\x1b[33m!\x1b[39m flaky",
  plainUnicode: "t|✔|✘ failed|⚠ flaky",
  plainAscii: "t|OK|x failed|! flaky",
} as const;

/**
 * The sample a terminal shows under `capabilities`.
 *
 * @param capabilities - the decided colour and Unicode.
 */
function expectedSample(
  capabilities: Pick<TerminalCapabilities, "color" | "unicode">,
): string {
  if (capabilities.color)
    return capabilities.unicode ? SAMPLE.colourUnicode : SAMPLE.colourAscii;
  return capabilities.unicode ? SAMPLE.plainUnicode : SAMPLE.plainAscii;
}

/**
 * `value` as one single-quoted POSIX shell word.
 *
 * @param value - any text.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The `script` executable on `PATH`, or `undefined`. */
function findScript(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "script");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/**
 * The argv running `command` (a shell line) on a pty: BSD `script` on macOS, util-linux's on Linux;
 * `undefined` elsewhere.
 *
 * @param script - the `script` executable.
 * @param command - the shell line to run on the pty.
 */
function scriptArgv(
  script: string,
  command: string,
): readonly string[] | undefined {
  if (process.platform === "darwin")
    return [script, "-q", "/dev/null", "/bin/sh", "-c", command];
  if (process.platform === "linux")
    return [script, "-qec", command, "/dev/null"];
  return undefined;
}

/** What a finished child wrote. */
interface ChildOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `file` to its end within `limitMs`. Standard input is `/dev/null`: `script` refuses a socket
 * there (`execFile` gives it one), and a terminal would make the run interactive. The time limit is
 * our own timer, never `spawn`'s `timeout`: util-linux `script` exits 0 on SIGTERM, which would pass
 * a killed probe off as a finished one. Past the limit the child gets SIGTERM, then SIGKILL.
 *
 * @param file - the executable.
 * @param args - its arguments.
 * @param env - its whole environment.
 * @param limitMs - how long it may run.
 * @throws {@link Error} naming the time limit or the exit status, with the child's standard error.
 */
function runToEnd(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limitMs: number,
): Promise<ChildOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, limitMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut)
        reject(
          new Error(
            `${file} timed out after ${String(limitMs / 1000)}s; stderr: ${stderr}; stdout: ${stdout}`,
          ),
        );
      else if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${file} ended with ${signal ?? `exit ${String(code)}`}; stderr: ${stderr}; stdout: ${stdout}`,
          ),
        );
    });
  });
}

/** One measured environment. */
interface PtyCase {
  readonly name: string;
  /** Added to the base environment; `undefined` removes a variable (`TERM`). */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Run `stty` to size the pty first. */
  readonly sized: boolean;
  /** Default `auto`. */
  readonly mode?: OutputMode;
}

/**
 * The probe's environment: only what the case names over a fixed base, so the runner's own `CI`,
 * `NO_COLOR`, `FORCE_COLOR` or locale never leak in.
 *
 * @param ptyCase - the case.
 */
function probeEnv(ptyCase: PtyCase): Record<string, string> {
  const merged: Record<string, string | undefined> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    SHELL: "/bin/sh",
    TERM: "xterm-256color",
    ...ptyCase.env,
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged))
    if (value !== undefined) env[name] = value;
  return env;
}

/**
 * How long a probe may run: its test's time limit, less a margin to fail with the probe's output.
 *
 * @param testInfo - the running test.
 */
function probeLimitMs(testInfo: TestInfo): number {
  if (testInfo.timeout === 0) return UNBOUNDED_TEST_PROBE_MS;
  return Math.max(1_000, testInfo.timeout - PROBE_MARGIN_MS);
}

/**
 * Runs the probe on a pty in the case's environment and returns what it reported.
 *
 * @param script - the `script` executable.
 * @param ptyCase - the case.
 * @param testInfo - the running test: where the probe is written, and its time limit.
 * @throws {@link Error} when the probe fails, times out, or prints no result (with its stderr).
 */
async function runProbe(
  script: string,
  ptyCase: PtyCase,
  testInfo: TestInfo,
): Promise<ProbeRun> {
  const probe = testInfo.outputPath("probe.mts");
  writeFileSync(probe, probeSource());
  const node = [
    process.execPath,
    "--import",
    TSX_LOADER,
    probe,
    ptyCase.mode ?? "auto",
  ]
    .map(shellQuote)
    .join(" ");
  const size = ptyCase.sized
    ? `stty cols ${String(SIZE.columns)} rows ${String(SIZE.rows)} && `
    : "";
  const argv = scriptArgv(script, `${size}exec ${node}`);
  if (argv === undefined)
    throw new Error(`no pty runner on ${process.platform}`);
  const [file = "", ...args] = argv;
  const { stdout, stderr } = await runToEnd(
    file,
    args,
    probeEnv(ptyCase),
    probeLimitMs(testInfo),
  );
  const framed = FRAME.exec(stdout)?.[1];
  if (framed === undefined)
    throw new Error(
      `${ptyCase.name}: no probe result; stderr: ${JSON.stringify(stderr)}; stdout: ${JSON.stringify(stdout)}`,
    );
  return { result: JSON.parse(framed) as ProbeResult, screen: stdout };
}

/** SGR green around `x`, as `styleText` writes it. */
const GREEN_X = "\x1b[32mx\x1b[39m";

/**
 * Node's warning when `FORCE_COLOR` overrides `NO_COLOR`: printed once, as soon as anything loads
 * Node's colour helpers (tsx's loader, Node's own ESM loader, a default `styleText`), so the palette's
 * bypass cannot keep it off a screen; it goes to standard error only.
 */
const NO_COLOR_IGNORED =
  "The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.";

/** A case and what is measured on a sized pty. */
interface MeasuredCase extends PtyCase {
  /** Node's own `styleText` colours. */
  readonly nodeColours: boolean;
  /** Node warns that `NO_COLOR` is ignored. Default `false`. */
  readonly nodeWarns?: boolean;
  /**
   * A hand-built `isTTY` stream gets colour from Node. Default `true`: Node reads only `FORCE_COLOR`
   * for it, so it colours under `NO_COLOR`, `CI` or `TERM=dumb`, where a real terminal does not.
   */
  readonly fakeColours?: boolean;
  readonly expected: Omit<TerminalCapabilities, "tty">;
}

/**
 * Each case, and what Node's default `styleText` and the capabilities decide on a sized pty. Node's
 * column pins why the palette never lets it decide: it drops colour under any `CI` and under
 * `FORCE_COLOR=yes`, which the precedence keeps, and keeps it under an empty `NODE_DISABLE_COLORS`,
 * which the precedence drops.
 */
const CASES: readonly MeasuredCase[] = [
  {
    name: "nothing set",
    env: {},
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "NO_COLOR=1",
    env: { NO_COLOR: "1" },
    sized: true,
    nodeColours: false,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "NO_COLOR empty",
    env: { NO_COLOR: "" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "CI=true",
    env: { CI: "true" },
    sized: true,
    nodeColours: false,
    expected: { color: true, live: false, unicode: true },
  },
  {
    name: "CI empty",
    env: { CI: "" },
    sized: true,
    nodeColours: false,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "CI=false",
    env: { CI: "false" },
    sized: true,
    nodeColours: false,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=0",
    env: { FORCE_COLOR: "0" },
    sized: true,
    nodeColours: false,
    fakeColours: false,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=false",
    env: { FORCE_COLOR: "false" },
    sized: true,
    nodeColours: false,
    fakeColours: false,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=FALSE",
    env: { FORCE_COLOR: "FALSE" },
    sized: true,
    nodeColours: false,
    fakeColours: false,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=1 over NO_COLOR=1",
    env: { FORCE_COLOR: "1", NO_COLOR: "1" },
    sized: true,
    nodeColours: true,
    nodeWarns: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=true",
    env: { FORCE_COLOR: "true" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR empty",
    env: { FORCE_COLOR: "" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "FORCE_COLOR=yes",
    env: { FORCE_COLOR: "yes" },
    sized: true,
    nodeColours: false,
    fakeColours: false,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "NODE_DISABLE_COLORS=1",
    env: { NODE_DISABLE_COLORS: "1" },
    sized: true,
    nodeColours: false,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "NODE_DISABLE_COLORS empty",
    env: { NODE_DISABLE_COLORS: "" },
    sized: true,
    nodeColours: true,
    expected: { color: false, live: true, unicode: true },
  },
  {
    name: "TERM=dumb",
    env: { TERM: "dumb" },
    sized: true,
    nodeColours: false,
    expected: { color: false, live: false, unicode: false },
  },
  {
    name: "TERM=dumb with FORCE_COLOR=1",
    env: { TERM: "dumb", FORCE_COLOR: "1" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: false, unicode: false },
  },
  {
    name: "TERM unset",
    env: { TERM: undefined },
    sized: true,
    nodeColours: false,
    expected: { color: false, live: false, unicode: true },
  },
  {
    name: "TERM empty",
    env: { TERM: "" },
    sized: true,
    nodeColours: false,
    expected: { color: false, live: false, unicode: true },
  },
  {
    name: "TERM unset with FORCE_COLOR=1",
    env: { TERM: undefined, FORCE_COLOR: "1" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: false, unicode: true },
  },
  {
    name: "LC_ALL=C",
    env: { LC_ALL: "C" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: false },
  },
  {
    name: "LANG=en_US (no codeset)",
    env: { LANG: "en_US" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: false },
  },
  {
    name: "LC_CTYPE=UTF-8",
    env: { LC_CTYPE: "UTF-8" },
    sized: true,
    nodeColours: true,
    expected: { color: true, live: true, unicode: true },
  },
  {
    name: "mode plain",
    env: { FORCE_COLOR: "1" },
    sized: true,
    mode: "plain",
    nodeColours: true,
    expected: { color: false, live: false, unicode: false },
  },
  {
    name: "mode fancy under CI",
    env: { CI: "true" },
    sized: true,
    mode: "fancy",
    nodeColours: false,
    expected: { color: true, live: true, unicode: true },
  },
];

test.describe("on a real pty", () => {
  const script = findScript();
  // `script` only where this spec knows its arguments.
  const runner =
    script !== undefined && scriptArgv(script, "true") !== undefined
      ? script
      : undefined;
  const missing = `needs util-linux or BSD \`script\` on PATH (macOS or Linux); found ${script ?? "none"} on ${process.platform}`;
  // Locally a missing `script` skips; under CI it fails, so the matrix is never silently absent.
  test.skip(runner === undefined && !isCi(process.env), missing);

  /** The `script` to run, or a failure naming what is missing. */
  function requireScript(): string {
    if (runner === undefined) throw new Error(missing);
    return runner;
  }

  for (const ptyCase of CASES) {
    test(`${ptyCase.name}: Node's own styleText, the capabilities, the palette's bytes`, async () => {
      const { result, screen } = await runProbe(
        requireScript(),
        ptyCase,
        test.info(),
      );
      expect(result.isTTY, "a real terminal").toBe(true);
      expect([result.columns, result.rows], "stty's size").toEqual([
        SIZE.columns,
        SIZE.rows,
      ]);
      expect(result.nodeDefault, "Node's own styleText").toBe(
        ptyCase.nodeColours ? GREEN_X : "x",
      );
      // The bypass the palette relies on: SGR whatever the environment says.
      expect(result.bypass, "validateStream false").toBe(GREEN_X);
      // A hand-built "terminal" ignores what a real one honours: never a stand-in for a pty.
      expect(result.fakeStream, "a fake isTTY stream").toBe(
        ptyCase.fakeColours === false ? "x" : GREEN_X,
      );
      expect(result.capabilities).toEqual({ tty: true, ...ptyCase.expected });
      expect(result.sample, "the palette's bytes").toBe(
        expectedSample(ptyCase.expected),
      );
      expect(screen.includes(NO_COLOR_IGNORED), "Node's NO_COLOR warning").toBe(
        ptyCase.nodeWarns === true,
      );
    });
  }

  test("an unsized pty (0×0, as script leaves it without stty) is a terminal with no live region", async () => {
    const { result } = await runProbe(
      requireScript(),
      { name: "unsized", env: {}, sized: false },
      test.info(),
    );
    expect([result.isTTY, result.columns, result.rows]).toEqual([true, 0, 0]);
    expect(result.capabilities).toEqual({
      tty: true,
      color: true,
      live: false,
      unicode: true,
    });
  });
});
