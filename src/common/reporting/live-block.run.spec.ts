import { execFile, spawn } from "node:child_process";
import {
  accessSync,
  constants,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";

import { test, expect } from "@playwright/test";

import {
  FOREIGN_LINES,
  FOREIGN_WARNING,
} from "../__fixtures__/live-block/foreign";
import { LIVE_PROBE_ENV } from "../__fixtures__/live-block/probe-env";
import {
  makeLiveProject,
  type LiveProject,
} from "../__fixtures__/live-block/project";
import { isCi } from "../terminal/capabilities";
import { formatDuration } from "./run-summary";

/**
 * The live block through the real `bddgen`, runner and reporter stack, on a synthetic product
 * (`__fixtures__/live-block/`: 19 scenarios, a flaky and a failing one among them, on two placeholder
 * sites, so two workers), in a real terminal: tmux. Each step waits a second, so the block is shown
 * for over ten seconds; one scenario's worker prints a warning, one has a 120-character title, one
 * makes the runner process write to its own standard output and error (`console.*`,
 * `process.emitWarning`, a line in two writes).
 *
 * Captured with wrapped lines joined (`capture-pane -J`, history included): every permanent line is
 * there once, whole; no line of the block is left — after a resize, only a few parts of the old block
 * (what tmux's reflow moves out of reach, `terminal/live.ts`); the final screen ends with the summary.
 * The bytes the pane got (`pipe-pane`) count the draws; a lone five-second scenario proves the tick:
 * its block redrawn about twice a second with nothing else happening. Piped, the same run writes no
 * byte of the block.
 *
 * Needs tmux and Playwright's Chromium (the suite's fixtures open a browser context; CI's
 * `setup-chromium` installs it). Every tmux server is the spec's own — a socket in a fresh folder under
 * `/tmp` (a socket's path is limited to 104 bytes, which a long `TMPDIR` passes), no user config —
 * killed with the run's process group after each test, whatever happened, its folder removed once
 * the group is gone. A spec runner killed outright (`SIGKILL`) leaves its server until the pane's
 * `sleep` ends, and the folder. tmux is not on GitHub's `ubuntu-24.04` image: CI installs it. Locally a
 * missing tmux skips; under `CI` it fails, so the check is never silently absent. Under `CI` the run
 * gets `E2E_OUTPUT=fancy`, without which `CI` turns the block off.
 */

/**
 * How long one run may take: 15–20 s alone, its specs generated. Starved — four of these runs at once
 * beside twelve busy CPU loops on twelve cores, load average 50–70 — runs took 117–237 s, so this
 * bound is that harness's tail; a CI shard (two workers on four vCPUs) is far from it.
 */
const RUN_TIMEOUT_MS = 240_000;

/** How long each step waits: 19 scenarios on 2 workers keep the block up for over ten seconds. */
const STEP_MS = "1000";

/** What the pane's shell prints once the run ends, with its exit code. */
const EXITED = "LIVE EXITED";

/** The prefix of each tmux server's socket folder: short, so the socket's path stays far below 104 bytes. */
const SOCKET_DIR_PREFIX = "/tmp/e2e-lb-";

/** How long a killed run's process group may take to be gone before its folders are removed anyway. */
const GROUP_GONE_MS = 10_000;

/** The fixture's scenario with a 120-character title. */
const LONG_TITLE =
  "A scenario whose title runs long enough to need cutting in any live row, past one hundred and twenty columns of text, passes";

/** A line of the block: the progress row (bar or not) or a worker's row (its site). */
const BLOCK_ROW =
  /(?:^[█░#-]{10} )?\d+\/19 · \d+% · \d+ passed|^ {2}▸ .*· (?:live-[ab]|\d+s$)|^ {2}… \d+ more running/;

/**
 * Whether a joined capture line is a permanent line the run prints: the suite's own, the workers'
 * gutter, the foreign writes, the summary, the shell's last word.
 */
const PERMANENT =
  /^(?:\[cell\] |━━ |— skipped |✔ |↻ |⚠ flaky |✘ |▸ | {2}│ | {2}Error: |\[foreign\] |\(node:\d+\) Warning: |\(Use `node |To open last HTML report| {2}npx playwright show-report| {2}(?:Result|Playwright|Cucumber|Allure) |LIVE EXITED )/;

const run = promisify(execFile);

/** The `tmux` executable on `PATH`, or `undefined`. */
function findTmux(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "tmux");
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
 * `value` as one single-quoted POSIX shell word.
 *
 * @param value - any text.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The run's variables: the project's, a second per step, and — under CI — `E2E_OUTPUT=fancy`.
 *
 * @param project - the project.
 * @param runId - the run's token.
 * @param extra - more variables.
 */
function runEnv(
  project: LiveProject,
  runId: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return project.env(runId, {
    [LIVE_PROBE_ENV.stepMs]: STEP_MS,
    ...(isCi(process.env) ? { CI: "true", E2E_OUTPUT: "fancy" } : {}),
    ...extra,
  });
}

/**
 * A run's time as the summary prints it (`formatDuration`: `12s`, `1.2m`, `1.1h`), in seconds.
 *
 * @param text - the summary's `Result` line.
 * @returns the seconds, or `NaN` when the line names none.
 */
function summarySeconds(text: string): number {
  const match = /, in (\d+(?:\.\d+)?)([smh])$/.exec(text);
  if (match === null) return Number.NaN;
  const unit = { s: 1, m: 60, h: 3_600 }[match[2] as "s" | "m" | "h"];
  return Number(match[1]) * unit;
}

/**
 * Whether a process group still has a member.
 *
 * @param group - the group's id: its leader's pid.
 */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    // EPERM: a member we may not signal still exists.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Kills a process group and waits for it to be gone (at most {@link GROUP_GONE_MS}): a run still
 * writing its reports would otherwise refill a folder being removed. Never throws.
 *
 * @param group - the group's id: its leader's pid.
 */
async function killGroup(group: number): Promise<void> {
  try {
    process.kill(-group, "SIGKILL");
  } catch {
    // Gone already.
  }
  const deadline = performance.now() + GROUP_GONE_MS;
  while (groupAlive(group) && performance.now() < deadline) await delay(50);
}

/** One tmux server of the spec's own, running one run of the project in a pane. */
class Pane {
  readonly #tmux: string;
  readonly #folder = mkdtempSync(SOCKET_DIR_PREFIX);
  #panePid: number | undefined;

  /**
   * @param tmux - the executable.
   */
  constructor(tmux: string) {
    this.#tmux = tmux;
  }

  /**
   * Runs a tmux command against this server.
   *
   * @param args - the command and its arguments.
   * @returns its standard output.
   */
  async tmux(...args: readonly string[]): Promise<string> {
    const env = { ...process.env };
    delete env.TMUX;
    const { stdout } = await run(
      this.#tmux,
      ["-S", join(this.#folder, "s"), "-f", "/dev/null", "-u", ...args],
      { env },
    );
    return stdout;
  }

  /**
   * Starts the run in a pane of `columns`×`rows`: a script that replaces the shell with the runner,
   * its environment built (only the pane's `TERM` kept); the pane's shell then says how it ended.
   *
   * Everything the pane gets is also appended to {@link Pane.bytes}' file (`pipe-pane`).
   *
   * @param project - the project, its specs generated.
   * @param env - the run's environment.
   * @param columns - the pane's width.
   * @param rows - the pane's height.
   * @param args - more arguments for the runner (`--grep`).
   */
  async start(
    project: LiveProject,
    env: NodeJS.ProcessEnv,
    columns: number,
    rows: number,
    args: readonly string[] = [],
  ): Promise<void> {
    const vars = Object.entries(env)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => `${name}=${shellQuote(String(value))}`)
      .join(" ");
    const script = join(project.dir, "run.sh");
    writeFileSync(
      script,
      `cd ${shellQuote(project.dir)} || exit 2\nexec env -i ${vars} TERM="$TERM" ${[...project.command, ...args].map(shellQuote).join(" ")}\n`,
    );
    // The pane waits for the pipe: its first bytes are never written before it is there.
    const go = join(this.#folder, "go");
    await this.tmux(
      "new-session",
      "-d",
      "-s",
      "s",
      "-x",
      String(columns),
      "-y",
      String(rows),
      `while [ ! -e ${shellQuote(go)} ]; do sleep 0.05; done; sh ${shellQuote(script)}; echo "${EXITED} $?"; sleep 30`,
    );
    this.#panePid = Number(
      (
        await this.tmux("display-message", "-p", "-t", "s", "#{pane_pid}")
      ).trim(),
    );
    await this.tmux(
      "pipe-pane",
      "-o",
      "-t",
      "s",
      `cat >> ${shellQuote(this.#bytesFile)}`,
    );
    writeFileSync(go, "");
  }

  /** Where `pipe-pane` appends the pane's bytes. */
  get #bytesFile(): string {
    return join(this.#folder, "bytes");
  }

  /** Every byte the pane got so far, as text. */
  bytes(): string {
    try {
      return readFileSync(this.#bytesFile, "utf8");
    } catch {
      return "";
    }
  }

  /**
   * The pane's lines, trailing blanks dropped.
   *
   * @param options - `history`: all of it, wrapped lines joined; `escapes`: with SGR (`-e`).
   */
  async capture(
    options: { readonly history?: boolean; readonly escapes?: boolean } = {},
  ): Promise<string[]> {
    const args = [
      "capture-pane",
      "-p",
      ...(options.history === true ? ["-J", "-S", "-", "-E", "-"] : []),
      ...(options.escapes === true ? ["-e"] : []),
      "-t",
      "s",
    ];
    const lines = (await this.tmux(...args))
      .split("\n")
      .map((line) => line.trimEnd());
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * Resizes the pane.
   *
   * @param columns - its width.
   * @param rows - its height.
   */
  async resize(columns: number, rows: number): Promise<void> {
    await this.tmux(
      "resize-window",
      "-t",
      "s",
      "-x",
      String(columns),
      "-y",
      String(rows),
    );
  }

  /**
   * Kills the run's process group and waits for it to be gone (at most {@link GROUP_GONE_MS}), then
   * the server; removes the socket folder. Never throws.
   */
  async stop(): Promise<void> {
    // The pane's process leads its own group: the runner (the shell exec'd it) and its workers.
    if (this.#panePid !== undefined) await killGroup(this.#panePid);
    await this.tmux("kill-server").catch(() => undefined);
    // Only the folder this pane made: a socket folder under `/tmp`, outside `removeTempDir`'s reach.
    if (this.#folder.startsWith(SOCKET_DIR_PREFIX))
      rmSync(this.#folder, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  }
}

/** What a run in a pane showed. */
interface Watched {
  /** Every byte the pane got, as text. */
  readonly bytes: string;
  /** Each distinct progress row the visible pane showed, in order. */
  readonly progress: string[];
  /** Every visible line seen while the run went on. */
  readonly seen: Set<string>;
  /** The joined capture, history included, once the run ended. */
  readonly history: string[];
  /** The visible pane once the run ended. */
  readonly final: string[];
}

/**
 * Watches the pane until the run ends: samples the visible pane, and calls `during` once, as soon
 * as the block is up.
 *
 * @param pane - the pane.
 * @param during - what to do while the block is shown (a resize).
 * @param escapes - capture with SGR.
 */
async function watch(
  pane: Pane,
  during?: () => Promise<void>,
  escapes = false,
): Promise<Watched> {
  const progress: string[] = [];
  const seen = new Set<string>();
  const deadline = performance.now() + RUN_TIMEOUT_MS;
  let acted = during === undefined;
  for (;;) {
    const lines = await pane.capture({ escapes });
    for (const line of lines) seen.add(line);
    const row = lines.find((line) => /\d+\/19 · \d+% · /.test(line));
    if (row !== undefined && row !== progress.at(-1)) progress.push(row);
    if (!acted && row !== undefined && progress.length >= 3) {
      acted = true;
      await during?.();
    }
    if (lines.some((line) => line.startsWith(EXITED))) break;
    if (performance.now() > deadline)
      throw new Error(`The run never ended:\n${lines.join("\n")}`);
    await delay(150);
  }
  return {
    bytes: pane.bytes(),
    progress,
    seen,
    history: await pane.capture({ history: true }),
    final: await pane.capture(),
  };
}

/**
 * What is wrong with a joined capture: a permanent line missing, doubled or cut; residue — a line
 * neither permanent nor blank — beyond `residueBound`.
 *
 * @param history - the joined capture.
 * @param residueBound - how many residue lines a resize may leave.
 */
function problems(history: readonly string[], residueBound = 0): string[] {
  const found: string[] = [];
  const once = (line: string): void => {
    const count = history.filter((shown) => shown === line).length;
    if (count !== 1) found.push(`${String(count)}× ${line}`);
  };
  const scenarios = history.filter((line) =>
    /^(?:✔(?: passed)?|⚠ flaky|✘(?: failed)?) \d+\.\ds {2}The live block, end to end › /.test(
      line,
    ),
  );
  if (scenarios.length !== 19)
    found.push(`${String(scenarios.length)} final scenario lines, not 19`);
  if (!scenarios.some((line) => line.endsWith(`› ${LONG_TITLE}`)))
    found.push("the long title's line is not whole");
  for (const line of FOREIGN_LINES) once(line);
  if (
    history.filter((line) =>
      new RegExp(
        `^\\(node:\\d+\\) Warning: ${FOREIGN_WARNING.replace(/[[\]]/g, "\\$&")}$`,
      ).test(line),
    ).length !== 1
  )
    found.push("the runner's warning is not there once");
  once("  │ [probe] a warning from the worker");
  if (
    !history.some((line) =>
      /^ {2}Result {6}1 failed · 1 flaky · 17 passed, in /.test(line),
    )
  )
    found.push("no summary");
  const residue = history.filter(
    (line) => line !== "" && (!PERMANENT.test(line) || BLOCK_ROW.test(line)),
  );
  if (residue.length > residueBound)
    found.push(
      `residue (${String(residue.length)} > ${String(residueBound)}):\n${residue.join("\n")}`,
    );
  return found;
}

/** The project of this worker's tests, made once. */
let project: LiveProject | undefined;
/** The panes started and not stopped yet. */
const panes = new Set<Pane>();
/**
 * The piped runs' process groups not yet killed: a test that times out never reaches its own
 * `finally`, so its run is killed here, before the project folder is removed.
 */
const groups = new Set<number>();

test.afterEach(async () => {
  for (const pane of panes) await pane.stop();
  panes.clear();
  for (const group of groups) await killGroup(group);
  groups.clear();
});

test.afterAll(() => {
  project?.remove();
  project = undefined;
});

/**
 * The project, its specs generated once for this worker.
 *
 * @returns the project.
 */
function liveProject(): LiveProject {
  if (project === undefined) {
    project = makeLiveProject();
    project.bddgen(runEnv(project, "bddgen"));
  }
  return project;
}

/**
 * Runs the project in a pane, watching it.
 *
 * @param runId - the run's token.
 * @param size - the pane's columns and rows.
 * @param options - more variables; what to do once the block is up; capture with SGR.
 */
async function runInPane(
  runId: string,
  size: { readonly columns: number; readonly rows: number },
  options: {
    readonly env?: NodeJS.ProcessEnv;
    readonly during?: (pane: Pane) => Promise<void>;
    readonly escapes?: boolean;
    readonly args?: readonly string[];
  } = {},
): Promise<Watched> {
  const tmux = findTmux();
  // Locally a missing tmux skips; under CI it fails, so the check is never silently absent.
  test.skip(tmux === undefined && !isCi(process.env), "tmux is not installed");
  expect(tmux, "tmux must be installed under CI").toBeDefined();
  const pane = new Pane(tmux ?? "tmux");
  panes.add(pane);
  try {
    const p = liveProject();
    await pane.start(
      p,
      runEnv(p, runId, options.env),
      size.columns,
      size.rows,
      options.args,
    );
    const during = options.during;
    return await watch(
      pane,
      during === undefined ? undefined : () => during(pane),
      options.escapes,
    );
  } finally {
    await pane.stop();
    panes.delete(pane);
  }
}

test.describe("summarySeconds", () => {
  test("reads every unit the summary's formatDuration prints", () => {
    for (const [ms, seconds] of [
      [12_000, 12],
      [72_000, 72],
      [3_960_000, 3_960],
    ] as const)
      expect(
        summarySeconds(`  Result      17 passed, in ${formatDuration(ms)}`),
      ).toBeCloseTo(seconds, 5);
    expect(summarySeconds("  Result      17 passed")).toBeNaN();
  });
});

test.describe("the live block in a real terminal (tmux)", () => {
  test.describe.configure({ mode: "serial" });

  test("a 40×10 pane: drawn throughout, every permanent line once and whole, no residue, the summary last", async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const watched = await runInPane("live-40", { columns: 40, rows: 10 });
    // Sampled: at least ten distinct progress rows. Written: at least 20 draws reached the pane.
    expect(
      watched.progress.length,
      watched.progress.join("\n"),
    ).toBeGreaterThanOrEqual(10);
    expect(
      watched.bytes.match(/\d+\/19 · \d+% · /g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(20);
    // The block was up for the whole run, which lasted ten seconds or more.
    expect(
      summarySeconds(
        watched.history.find((line) => line.startsWith("  Result ")) ?? "",
      ),
    ).toBeGreaterThanOrEqual(10);
    // The long title's row was cut to the pane, never wrapped.
    expect([...watched.seen].some((line) => /^ {2}▸ .*…/.test(line))).toBe(
      true,
    );
    expect(problems(watched.history)).toEqual([]);
    // The run's last lines are the summary's, then the shell's: no block below them, on screen or off.
    expect(watched.history.slice(-2)[0]).toMatch(/^ {2}Allure /);
    expect(watched.history.at(-1)).toBe(`${EXITED} 1`);
    expect(watched.final.at(-1)).toBe(`${EXITED} 1`);
  });

  test("narrowed mid-run, 60×14 to 40×10: every permanent line still once and whole, at most one block's residue", async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const watched = await runInPane(
      "live-resize",
      { columns: 60, rows: 14 },
      {
        during: async (pane) => {
          await pane.resize(40, 10);
        },
      },
    );
    // The narrowed block's split rows may stay above the erase (tmux's reflow): at most a block's
    // worth, its 3 rows. Without the resize handling, dozens.
    expect(problems(watched.history, 3)).toEqual([]);
    expect(watched.final.at(-1)).toBe(`${EXITED} 1`);
  });

  test("the tick: a lone five-second scenario's block is redrawn about twice a second, its time moving", async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const watched = await runInPane(
      "live-tick",
      { columns: 80, rows: 10 },
      {
        env: { [LIVE_PROBE_ENV.stepMs]: "5000" },
        args: ["--grep", "Live block scenario one passes"],
      },
    );
    const bytes = stripVTControlCharacters(watched.bytes);
    // Nothing else happens for five seconds: every draw is the tick's. At 500 ms, about 10; at
    // 1,000 ms, about 5; with no tick, 1.
    const draws =
      bytes.match(/0\/1 · 0% · 0 passed · 1 running · /g)?.length ?? 0;
    expect(draws, bytes).toBeGreaterThanOrEqual(8);
    const shown = new Set(
      [
        ...bytes.matchAll(
          /▸ .*Live block scenario one passes · live-[ab]\S* · (\d+)s/g,
        ),
      ].map(([, seconds]) => seconds),
    );
    expect([...shown].sort()).toEqual(
      expect.arrayContaining(["1", "2", "3", "4"]),
    );
  });

  test("NO_COLOR keeps the block, with no colour anywhere", async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const watched = await runInPane(
      "live-nocolor",
      { columns: 80, rows: 24 },
      { env: { NO_COLOR: "1" }, escapes: true },
    );
    expect(watched.progress.length).toBeGreaterThanOrEqual(5);
    // Ours — the block and the suite's lines — carry no colour. Other writers decide for themselves:
    // the fixture's coloured write keeps its colour as written, and Playwright's HTML report hint is
    // coloured whatever NO_COLOR says (its own writer, after the block is gone).
    const ours =
      /^(?:✔ |↻ |⚠ flaky |✘ |▸ |━━ | {2}│| {2}Error: |— skipped |\[cell\] | {2}(?:Result|Playwright|Cucumber|Allure) )/;
    let checked = 0;
    for (const line of watched.seen) {
      const bare = stripVTControlCharacters(line);
      if (!ours.test(bare) && !BLOCK_ROW.test(bare)) continue;
      checked += 1;
      expect(line, JSON.stringify(line)).toBe(bare);
    }
    expect(checked).toBeGreaterThan(10);
    expect(problems(watched.history)).toEqual([]);
  });
});

test.describe("the live block in a pipe", () => {
  test("writes no byte of it, even with E2E_OUTPUT=fancy; the runner's own lines go where they were written", async () => {
    test.setTimeout(RUN_TIMEOUT_MS * 2);
    const p = liveProject();
    const env = runEnv(p, "live-pipe", {
      [LIVE_PROBE_ENV.stepMs]: "300",
      TERM: "xterm-256color",
      E2E_OUTPUT: "fancy",
    });
    const [command = "", ...args] = p.command;
    const child = spawn(command, args, {
      cwd: p.dir,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const group = child.pid;
    if (group !== undefined) groups.add(group);
    // Ends a run that never ends before the test's own timeout, so the failure says so.
    const timer = setTimeout(() => {
      if (group !== undefined) void killGroup(group);
    }, RUN_TIMEOUT_MS);
    try {
      const code = await new Promise<number | null>((resolve) => {
        child.on("exit", resolve);
      });
      expect(code).toBe(1);
    } finally {
      clearTimeout(timer);
      if (group !== undefined) {
        await killGroup(group);
        groups.delete(group);
      }
    }
    expect(stdout).not.toContain("\r");
    // The fixture's own coloured line is the runner's write, passed through as written.
    const ours = stdout.replace(
      `\u001b[33m${FOREIGN_LINES[1]}\u001b[39m\n`,
      "",
    );
    expect(ours).not.toBe(stdout);
    expect(ours).not.toContain("\u001b");
    expect(stdout).not.toMatch(/[█░]|\d+\/19 · \d+%|▸ .* · live-[ab]/);
    // A line in two writes, unheld in a pipe: other lines may come between its halves.
    expect(stdout).toContain("[foreign] a line in ");
    expect(stdout).toContain("two writes\n");
    expect(stderr).toContain(`${FOREIGN_LINES[0]}\n`);
    expect(stderr).toContain(FOREIGN_WARNING);
    expect(stdout).toMatch(/Result {6}1 failed · 1 flaky · 17 passed/);
  });
});
