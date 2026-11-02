import { execFile } from "node:child_process";
import {
  accessSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify, stripVTControlCharacters } from "node:util";

import { test, expect } from "@playwright/test";

import { removeTempDir } from "../../src/common/__fixtures__/temp-dir";
import { isCi } from "../../src/common/terminal/capabilities";
import { FAKE_SCENARIOS } from "../__fixtures__/fake-start";

/**
 * The status table through the real command (`cli.ts`, `command.ts`, `start`) over the fake suite
 * (`__fixtures__/swap-start.mjs`: each run's runner writes a results stream as it goes), in a real
 * terminal: tmux. Two tasks run at once; the table is drawn below the log's lines, at most once a
 * second, redrawn after a resize, and cleared on every way the command ends — `--once`, one Ctrl-C (a
 * drain), three (a kill), SIGTERM — leaving no table row on the screen or in its history: every line
 * of `orchestrator.log` is there once, whole, after its own `HH:MM:SS`; the exit line is last.
 *
 * Captured with wrapped lines joined (`capture-pane -J`, history included); the terminal's own wrap
 * of a line the orchestrator wrapped is joined back by its continuation lines' indent. The bytes the
 * pane got (`pipe-pane`) count the draws.
 *
 * Every tmux server is the spec's own — a socket in a fresh folder under `/tmp` (a socket's path is
 * limited to 104 bytes, which a long `TMPDIR` passes), no user config — killed with the command's
 * process group after each test, its folder removed. The command's environment is built whole: no
 * `CI`, which would turn the table off. tmux is not on GitHub's `ubuntu-24.04` image: CI installs it.
 * Locally a missing tmux skips; under `CI` it fails, so the check is never silently absent.
 */

test.describe.configure({ mode: "parallel", timeout: 180_000 });

/** tsx's loader, by its file URL. */
const TSX = import.meta.resolve("tsx");

/** The command's entry, as the `orchestrator` script runs it. */
const CLI = join(import.meta.dirname, "..", "cli.ts");

/** The preload that swaps the real `start.ts` for the fake suite's. */
const SWAP_START = join(
  import.meta.dirname,
  "..",
  "__fixtures__",
  "swap-start.mjs",
);

/** The prefix of each tmux server's socket folder: short, so the socket's path stays far below 104 bytes. */
const SOCKET_DIR_PREFIX = "/tmp/e2e-ot-";

/** What the pane's shell prints once the command ends, with its exit code. */
const EXITED = "ORCH EXITED";

/**
 * How long the command may take to print its started line: a cold `tsx` start on a loaded machine
 * took 40 s (12 busy cores), so later waits are timed from that line, not from the pane's start.
 */
const START_WAIT_MS = 90_000;

/** How long a command may take to end, once asked. */
const END_WAIT_MS = 60_000;

/** How long a killed process group may take to be gone. */
const GROUP_GONE_MS = 10_000;

/**
 * A line of the table: its header, a task's row (wide or compact) or the count. A permanent line
 * starts with its time; a continuation line with spaces.
 */
const TABLE_LINE =
  /^(?:TASK {2}RUN|and \d+ more|\d+ tasks|b(?:png|fap) {2}(?:—|b(?:png|fap)-\d+|starting|setup|running|stopping|ended|next|done|stopped))/;

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
 * Whether a process group still has a member.
 *
 * @param group - the group's id.
 */
function groupAlive(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Sends `signal` to a process group; nothing when it is gone.
 *
 * @param group - the group's id.
 * @param signal - the signal.
 */
function signalGroup(group: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-group, signal);
  } catch {
    // Gone already.
  }
}

/**
 * The process groups of the children of `group`'s members, other than `group` itself: the runs a
 * stopped command started, recorded or not.
 *
 * @param group - the pane's group.
 * @returns the groups; none when `ps` cannot be read.
 */
async function childGroups(group: number): Promise<number[]> {
  let table: string;
  try {
    ({ stdout: table } = await run("ps", ["-A", "-o", "pid=,ppid=,pgid="]));
  } catch {
    return [];
  }
  const rows = table
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter((row) => row.length === 3 && row.every(Number.isSafeInteger));
  const members = new Set(
    rows.filter(([, , pgid]) => pgid === group).map(([pid]) => pid),
  );
  return [
    ...new Set(
      rows
        .filter(([, ppid, pgid]) => members.has(ppid) && pgid !== group)
        .map(([, , pgid]) => pgid ?? 0)
        .filter((pgid) => pgid > 1),
    ),
  ];
}

/** One command in a tmux pane of the spec's own: its folders, its server, its bytes. */
class Pane {
  readonly #tmux: string;
  readonly #socketDir = mkdtempSync(SOCKET_DIR_PREFIX);
  /** The test's folder: the fake checkout, the state directory, the site locks. */
  readonly root = mkdtempSync(join(tmpdir(), "e2e-ot-"));
  #panePid: number | undefined;

  /**
   * @param tmux - the executable.
   */
  constructor(tmux: string) {
    this.#tmux = tmux;
  }

  /** The state directory: the config's folder, `orchestrator.log`'s. */
  get stateDir(): string {
    return join(this.root, "state");
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
      ["-S", join(this.#socketDir, "s"), "-f", "/dev/null", "-u", ...args],
      { env },
    );
    return stdout;
  }

  /**
   * Starts the command in a pane of `columns`×`rows`, over two tasks whose runs write a results
   * piece every `stepMs`; the pane's shell then says how it ended. Everything the pane gets is also
   * appended to a file (`pipe-pane`), attached before the command's first byte.
   *
   * @param columns - the pane's width.
   * @param rows - the pane's height.
   * @param stepMs - the time between two pieces of a run's stream.
   * @param args - more arguments for `start` (`--once`).
   * @param extra - more variables for the command (`FAKE_IGNORE_STOPS`).
   */
  async start(
    columns: number,
    rows: number,
    stepMs: number,
    args: readonly string[] = [],
    extra: Readonly<Record<string, string>> = {},
  ): Promise<void> {
    mkdirSync(this.stateDir, { mode: 0o700 });
    const config = join(this.stateDir, "config.json");
    writeFileSync(
      config,
      JSON.stringify({
        tasks: [
          { id: "bpng", type: "loop", product: "backwpup", cell: "fake@cell" },
          { id: "bfap", type: "loop", product: "backwpup", cell: "fake2@cell" },
        ].map((task) => ({ ...task, cooldownMinutes: 1 })),
      }),
      { mode: 0o600 },
    );
    const vars = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      XDG_STATE_HOME: join(this.root, "state-home"),
      NODE_OPTIONS: `--import=${TSX} --import=${SWAP_START}`,
      FAKE_CLI_CHECKOUT: this.root,
      FAKE_RESULTS_MS: String(stepMs),
      ...extra,
    };
    const script = join(this.root, "run.sh");
    writeFileSync(
      script,
      `cd ${shellQuote(this.root)} || exit 2\nexec env -i ${Object.entries(vars)
        .map(([name, value]) => `${name}=${shellQuote(value)}`)
        .join(" ")} TERM="$TERM" ${[
        process.execPath,
        CLI,
        "start",
        "--config",
        config,
        ...args,
      ]
        .map(shellQuote)
        .join(" ")}\n`,
    );
    const go = join(this.#socketDir, "go");
    await this.tmux(
      "new-session",
      "-d",
      "-s",
      "s",
      "-x",
      String(columns),
      "-y",
      String(rows),
      // A Ctrl-C reaches the pane's whole foreground group: the shell traps it (a handler, not an
      // ignore, which the command would inherit) so that it lives on to say how the command ended.
      `trap : INT; while [ ! -e ${shellQuote(go)} ]; do sleep 0.05; done; sh ${shellQuote(script)}; echo "${EXITED} $?"; sleep 30`,
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
      `cat >> ${shellQuote(join(this.#socketDir, "bytes"))}`,
    );
    writeFileSync(go, "");
    await this.waitForBytes(/orchestrator {2}started/, START_WAIT_MS);
  }

  /** Every byte the pane got so far, its escapes removed. */
  bytes(): string {
    return stripVTControlCharacters(this.raw());
  }

  /**
   * Every byte the pane got so far, as the terminal got it: the pane's `onlcr` made each `\n` a
   * `\r\n`, so a line the live region wrote (`\r\n`-ended) arrives `\r\r\n`.
   */
  raw(): string {
    try {
      return readFileSync(join(this.#socketDir, "bytes"), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * The pane's lines, trailing blanks dropped.
   *
   * @param history - all of it, wrapped lines joined.
   */
  async capture(history = false): Promise<string[]> {
    const lines = (
      await this.tmux(
        "capture-pane",
        "-p",
        ...(history ? ["-J", "-S", "-", "-E", "-"] : []),
        "-t",
        "s",
      )
    )
      .split("\n")
      .map((line) => line.trimEnd());
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * Waits until the pane's bytes match `pattern`.
   *
   * @param pattern - what to wait for.
   * @param timeoutMs - how long at most.
   */
  async waitForBytes(pattern: RegExp, timeoutMs = 30_000): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (!pattern.test(this.bytes())) {
      if (performance.now() > deadline)
        throw new Error(
          `The pane never showed ${String(pattern)}:\n${(await this.capture()).join("\n")}`,
        );
      await delay(100);
    }
  }

  /**
   * Waits until the command ended.
   *
   * @returns its exit code.
   */
  async exitCode(): Promise<number> {
    const deadline = performance.now() + END_WAIT_MS;
    for (;;) {
      const line = (await this.capture()).find((shown) =>
        shown.startsWith(EXITED),
      );
      if (line !== undefined) return Number(line.slice(EXITED.length + 1));
      if (performance.now() > deadline)
        throw new Error(
          `The command never ended:\n${(await this.capture()).join("\n")}`,
        );
      await delay(150);
    }
  }

  /** The orchestrator's PID, from its started line. */
  pid(): number {
    const log = readFileSync(join(this.stateDir, "orchestrator.log"), "utf8");
    return Number(/ · pid (\d+)/.exec(log)?.[1]);
  }

  /** `orchestrator.log`'s lines, without their time: `<scope>  <text>`. */
  logLines(): string[] {
    return readFileSync(join(this.stateDir, "orchestrator.log"), "utf8")
      .trimEnd()
      .split("\n")
      .map((line) => line.slice(line.indexOf(" ") + 1));
  }

  /**
   * Ends everything the test started, then removes the folders (retried; a folder that cannot be
   * removed throws, so a leak is seen). The pane's group is
   * stopped first (SIGSTOP), so the command can start no run while its runs are found: those its
   * records name and its children not yet recorded (each run leads its own group, outside the
   * pane's). Then every group is killed and waited for, the server killed, the folders removed.
   */
  async stop(): Promise<void> {
    const pane = this.#panePid;
    if (pane !== undefined) signalGroup(pane, "SIGSTOP");
    const groups = [
      ...new Set([
        ...(pane === undefined ? [] : [pane]),
        ...this.#runGroups(),
        ...(pane === undefined ? [] : await childGroups(pane)),
      ]),
    ];
    for (const group of groups) signalGroup(group, "SIGKILL");
    const deadline = performance.now() + GROUP_GONE_MS;
    while (
      groups.some((group) => groupAlive(group)) &&
      performance.now() < deadline
    )
      await delay(50);
    await this.tmux("kill-server").catch(() => undefined);
    if (this.#socketDir.startsWith(SOCKET_DIR_PREFIX))
      rmSync(this.#socketDir, { recursive: true, force: true });
    removeTempDir(this.root);
  }

  /** The process groups the runs' records name (`process.pgid`): each run leads its own. */
  #runGroups(): number[] {
    const groups: number[] = [];
    for (const id of ["bpng-1", "bfap-1", "bpng-2", "bfap-2"])
      try {
        const record = JSON.parse(
          readFileSync(join(this.stateDir, "runs", id, "run.json"), "utf8"),
        ) as { process?: { pgid?: unknown } };
        const pgid = record.process?.pgid;
        if (typeof pgid === "number") groups.push(pgid);
      } catch {
        // No such run.
      }
    return groups;
  }
}

/**
 * The capture's logical lines: each permanent line with the lines the orchestrator wrapped it into
 * joined back by their indent, its time dropped; blank lines dropped; any other line kept as it is.
 *
 * @param history - the joined capture.
 * @returns the lines.
 */
function logicalLines(history: readonly string[]): string[] {
  const lines: string[] = [];
  for (const line of history) {
    if (line.trim() === "") continue;
    const last = lines.length - 1;
    if (/^ {2,}\S/.test(line) && last >= 0)
      lines[last] = `${lines[last] ?? ""} ${line.trim()}`;
    else lines.push(line.replace(/^\d\d:\d\d:\d\d /, ""));
  }
  return lines;
}

/**
 * What is wrong with a finished pane: a log line missing, doubled or cut; more table lines left than
 * allowed; the exit line not last.
 *
 * @param pane - the pane, its command ended.
 * @param code - the exit code expected.
 * @param allowed - what may be there besides the log's lines: `tableLines`, the table lines a
 *   narrowing may leave (the live region's accepted residue; none by default), and `notLogged`, the
 *   lines the process wrote itself (a Node warning). Neither counts as a log line.
 */
async function problems(
  pane: Pane,
  code: number,
  allowed: { readonly tableLines?: number; readonly notLogged?: RegExp } = {},
): Promise<string[]> {
  const { tableLines: tableLinesAllowed = 0, notLogged } = allowed;
  const found: string[] = [];
  const history = await pane.capture(true);
  // A table line starts with neither a time nor a continuation's indent.
  const tableLines = history.filter((line) => TABLE_LINE.test(line));
  if (tableLines.length > tableLinesAllowed)
    found.push(
      ...tableLines.map((line) => `table line left: ${line}`),
      `${String(tableLines.length)} table lines left, ${String(tableLinesAllowed)} allowed`,
    );
  const lines = logicalLines(
    history.filter(
      (line) => !TABLE_LINE.test(line) && notLogged?.test(line) !== true,
    ),
  ).filter((line) => !line.startsWith(EXITED) && line !== "^C");
  const expected = pane.logLines();
  for (const line of expected) {
    const count = lines.filter((shown) => shown === line).length;
    if (count !== 1) found.push(`${String(count)}× ${line}`);
  }
  if (lines.length !== expected.length)
    found.push(
      `${String(lines.length)} lines shown, ${String(expected.length)} logged:\n${history.join("\n")}`,
    );
  if (lines.at(-1) !== `orchestrator  exiting ${String(code)}`)
    found.push(`last line: ${lines.at(-1) ?? ""}`);
  // The region was closed before the exit's line: it went straight through, not above a table.
  // eslint-disable-next-line no-control-regex -- an SGR reset may close the line.
  const exiting = /exiting \d+(?:\u001b\[0m)?(\r*)\n/.exec(pane.raw());
  if (exiting?.[1] !== "\r")
    found.push(
      `the exit line ended ${JSON.stringify(exiting?.[0] ?? "nowhere")}`,
    );
  return found;
}

/**
 * How many tables the pane was drawn.
 *
 * @param pane - the pane.
 */
function draws(pane: Pane): number {
  return pane.bytes().split("TASK  RUN").length - 1;
}

const panes = new Set<Pane>();

test.afterEach(async () => {
  for (const pane of panes) await pane.stop();
  panes.clear();
});

/**
 * A pane for the test, skipping locally without tmux.
 *
 * @returns the pane.
 */
function newPane(): Pane {
  const tmux = findTmux();
  test.skip(tmux === undefined && !isCi(process.env), "tmux is not installed");
  expect(tmux, "tmux must be installed under CI").toBeDefined();
  const pane = new Pane(tmux ?? "tmux");
  panes.add(pane);
  return pane;
}

test("--once: the table follows both runs at most once a second, is redrawn after a narrowing that keeps its rows whole, and is gone at the end", async () => {
  const pane = newPane();
  const stepMs = 400;
  await pane.start(100, 16, stepMs, ["--once"]);
  // A run under way, a scenario or more ended: then the pane narrows.
  await pane.waitForBytes(/b(?:png|fap) {2}b(?:png|fap)-1 .* [1-9]\d*\/12 /);
  await pane.tmux("resize-window", "-t", "s", "-x", "70", "-y", "12");
  const startedAt = performance.now();
  expect(await pane.exitCode()).toBe(0);
  const seconds = (performance.now() - startedAt) / 1000;
  const bytes = pane.bytes();
  // Progress was followed: several counts of each run seen, the flaky one counted.
  const seen = new Set(
    [...bytes.matchAll(/bpng {2}bpng-1 .*? (\d+)\/12/g)].map((m) => m[1]),
  );
  expect(seen.size).toBeGreaterThanOrEqual(3);
  expect(bytes).toMatch(/\d+\/12 · 1 flaky/);
  // At most one draw a second, beside the repaints after each printed line (a few per run).
  const lines = pane.logLines().length;
  expect(draws(pane)).toBeLessThanOrEqual(
    Math.ceil(seconds + (FAKE_SCENARIOS * stepMs) / 1000) + 2 * lines + 4,
  );
  expect(draws(pane)).toBeGreaterThanOrEqual(3);
  expect(await problems(pane, 0)).toEqual([]);
});

test("a narrowing that splits the table's rows loses and doubles no log line, and leaves at most the old table's top rows", async () => {
  const pane = newPane();
  await pane.start(100, 16, 400, ["--once"]);
  // Header and both rows shown, about 65 columns each: at 16 columns each splits into 5 lines.
  await pane.waitForBytes(
    /bpng {2}bpng-1 .* [1-9]\d*\/12 [^\n]*\n[^\n]*bfap {2}bfap-1/,
  );
  await pane.tmux("resize-window", "-t", "s", "-x", "16", "-y", "12");
  expect(await pane.exitCode()).toBe(0);
  // The erase clears from the old table's last row down; the reflowed parts of the rows above it
  // stay (the live region's accepted residue): two lines. Without the erase, the region would keep
  // its old width and draw on below its minimum width, each draw leaving more.
  expect(await problems(pane, 0, { tableLines: 2 })).toEqual([]);
});

/**
 * A preload for the command that, once `trigger` exists, runs `act` once: a fault of the process's
 * own, made while the table shows.
 *
 * @param pane - the pane: the preload goes in its folder.
 * @param act - JavaScript run once triggered.
 * @returns the variables that load it, and the trigger's path.
 */
function preload(
  pane: Pane,
  act: string,
): { vars: Record<string, string>; trigger: string } {
  const trigger = join(pane.root, "trigger");
  const file = join(pane.root, "fault.mjs");
  writeFileSync(
    file,
    `import { existsSync } from "node:fs";\nconst poll = setInterval(() => {\n  if (!existsSync(${JSON.stringify(trigger)})) return;\n  clearInterval(poll);\n  ${act}\n}, 50);\npoll.unref();\n`,
  );
  return {
    vars: {
      NODE_OPTIONS: `--import=${TSX} --import=${SWAP_START} --import=${file}`,
    },
    trigger,
  };
}

test("a Node warning written while the table shows prints above it: no table line is left", async () => {
  const pane = newPane();
  const fault = preload(
    pane,
    'process.emitWarning("simulated warning from a dependency");',
  );
  await pane.start(100, 16, 400, ["--once"], fault.vars);
  await pane.waitForBytes(/bpng {2}bpng-1 .* [1-9]\d*\/12 /);
  writeFileSync(fault.trigger, "");
  await pane.waitForBytes(/simulated warning from a dependency/);
  expect(await pane.exitCode()).toBe(0);
  const notLogged = /^\(node:\d+\) Warning: simulated|--trace-warnings/;
  expect(await problems(pane, 0, { notLogged })).toEqual([]);
  const history = await pane.capture(true);
  expect(history.filter((line) => notLogged.test(line))).toHaveLength(2);
});

test("a crash while the table shows clears it before Node prints the error, and keeps exit code 1", async () => {
  const pane = newPane();
  const fault = preload(pane, 'throw new Error("simulated bug");');
  await pane.start(100, 16, 400, ["--once"], fault.vars);
  await pane.waitForBytes(/bpng {2}bpng-1 .* [1-9]\d*\/12 /);
  writeFileSync(fault.trigger, "");
  expect(await pane.exitCode()).toBe(1);
  const history = await pane.capture(true);
  expect(history.filter((line) => TABLE_LINE.test(line))).toEqual([]);
  expect(history).toContain("Error: simulated bug");
});

for (const [name, presses] of [
  ["one Ctrl-C drains the runs", 1],
  ["three Ctrl-Cs kill the runs", 3],
] as const)
  test(`${name}, and the table is gone at the exit`, async () => {
    const pane = newPane();
    // Killed only by the third: the runs ignore the drain and the interrupt.
    await pane.start(
      90,
      14,
      1_000,
      [],
      presses === 3 ? { FAKE_IGNORE_STOPS: "1" } : {},
    );
    await pane.waitForBytes(/bpng {2}bpng-1 .* running/);
    for (let press = 0; press < presses; press++) {
      // Two SIGINTs within a second count as one.
      if (press > 0) await delay(1_200);
      await pane.tmux("send-keys", "-t", "s", "C-c");
    }
    expect(await pane.exitCode()).toBe(130);
    expect(pane.bytes()).toMatch(/stopping/);
    if (presses === 3) expect(pane.bytes()).toMatch(/killing every run/);
    expect(await problems(pane, 130)).toEqual([]);
  });

test("SIGTERM drains, and the table is gone at the exit", async () => {
  const pane = newPane();
  await pane.start(90, 14, 1_000);
  await pane.waitForBytes(/bpng {2}bpng-1 .* running/);
  process.kill(pane.pid(), "SIGTERM");
  expect(await pane.exitCode()).toBe(130);
  expect(await problems(pane, 130)).toEqual([]);
});
