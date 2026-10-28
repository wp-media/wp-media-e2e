import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { STOP_FILE_ENV } from "../config/drain";
import { parseResults } from "./results-reader";
import {
  RESULTS_FILE,
  type ResultsEvent,
  type ScenarioEndEvent,
} from "./results-schema";

/**
 * The results stream, the terminal reporter's lines and the end-of-run summary through the real
 * `bddgen`, runner and reporter stack — what the unit specs cannot reach: that the config lists the
 * reporters, that Playwright hands them what the specs assume (step trees, `_mode`, attachments,
 * worker output forced into colour), and what each way a run ends leaves behind.
 *
 * A synthetic product runs `__fixtures__/results/results.feature`. Cell `x` holds a placeholder site,
 * so its setups skip and nothing leaves the machine; cell `y` holds one that is not a placeholder, on
 * a closed local port, with a zip that does not exist — both its setups fail at once, offline. The
 * config is written to a temporary folder, so every path the factory derives lands there.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/results");
const PRODUCT = "resultsprobe";

/** How long one child may take: `bddgen`, or a run of a few short scenarios with retries. */
const CHILD_TIMEOUT_MS = 90_000;

/** How long to wait for the hanging scenario to start before giving up. */
const BEGIN_TIMEOUT_MS = 60_000;

/** What one run left. */
interface RunOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  /** The runner's stdout, colours stripped. */
  readonly stdout: string;
  /** The runner's stdout as written: a pipe, so it must hold no escape. */
  readonly rawStdout: string;
  /** The runner's stderr. */
  readonly stderr: string;
  /** The stream's text, or `undefined` when there is no file. */
  readonly stream: string | undefined;
}

let work = "";

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder, and
  // macOS's temporary folder sits behind a symlink.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-results-run-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  // The config names its reporters as bare modules, resolved from the config's own folder.
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  // The setup projects' folders are relative to the config's folder: through this link, the real
  // auth and artifacts setups run, as they do in a product. `src/common` only: `src/projects/…` is
  // where a missing screenshot baseline gets written, which must stay in this folder.
  mkdirSync(join(work, "src"));
  symlinkSync(join(REPO_ROOT, "src", "common"), join(work, "src", "common"));
  // playwright-bdd takes features only from under the config's folder.
  copyFileSync(
    join(FIXTURE_DIR, "results.feature"),
    join(work, "results.feature"),
  );
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
  mkdirSync(join(work, "stop"));
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The synthetic product's config: cell `x` on a placeholder site, cell `y` on one that fails. */
function configSource(dir: string): string {
  const product = {
    name: PRODUCT,
    features: join(dir, "results.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(FIXTURE_DIR, "*.steps.ts"),
    ],
    sites: {
      x: {
        sites: [
          {
            baseURL: "https://x.example.test",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: dir },
          },
        ],
      },
      y: {
        sites: [
          {
            baseURL: "http://127.0.0.1:9",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: dir },
          },
        ],
      },
    },
    artifacts: {
      project: PRODUCT,
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: PRODUCT,
          mainFile: `${PRODUCT}.php`,
          pluginName: "Results probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  return (
    `import { createProductConfig } from ${factory};\n` +
    `export default createProductConfig(${JSON.stringify(product)});\n`
  );
}

/** A run's environment, built — nothing inherited from this worker's own Playwright variables. */
function runEnv(cell: string, runId: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: cell,
    E2E_RETRIES: "1",
    RUN_ID: runId,
    [STOP_FILE_ENV]: join(work, "stop", runId),
    // Cell `y` only: a zip that is not there fails its artifacts setup offline.
    E2E_PLUGIN_ZIP: join(work, "missing.zip"),
    REPORT_ROOT: join(work, "reports"),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
  };
}

/** The node entry of a CLI in the repository's `node_modules`. */
function cli(path: string): string {
  return join(REPO_ROOT, "node_modules", path);
}

/** Generates the cell's specs; throws when `bddgen` fails. */
function bddgen(env: NodeJS.ProcessEnv): void {
  const child = spawnSync(
    process.execPath,
    [cli("playwright-bdd/dist/cli/index.js"), "-c", "playwright.config.ts"],
    { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  if (child.error !== undefined) throw child.error;
  if (child.status !== 0) {
    throw new Error(
      `bddgen failed (${String(child.status)}):\n${child.stderr}`,
    );
  }
}

/** The stream file of a run. */
function streamPath(cell: string, runId: string): string {
  return join(work, "reports", PRODUCT, cell, runId, RESULTS_FILE);
}

/** The stream's text, or `undefined` when there is no file yet. */
function readStream(cell: string, runId: string): string | undefined {
  const path = streamPath(cell, runId);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** How a run is driven, beyond its arguments. */
interface RunOptions {
  /** The signal that stops the run, sent once {@link RunOptions.stopWhen} holds. */
  readonly stop?: NodeJS.Signals;
  /** Sends {@link RunOptions.stop} to the runner's whole process group, as the orchestrator's escalation does. */
  readonly group?: boolean;
  /** When to stop: once the hanging scenario has begun, by default. */
  readonly stopWhen?: (stdout: string) => boolean;
  /** What to do between `bddgen` and the runner. */
  readonly beforeRun?: () => void;
  /** Variables the runner gets on top of the run's own. */
  readonly env?: NodeJS.ProcessEnv;
  /** Closes the read end of the runner's stdout after its first chunk, as `… | head -1` does. */
  readonly closeStdoutEarly?: boolean;
}

/**
 * Runs the cell as the orchestrator does — `bddgen`, then the runner in a process group of its own —
 * and, when `options.stop` is given, sends that signal once the run reached the point it names. The
 * group is killed afterwards, whatever happened, so no worker outlives the spec.
 *
 * @param cell - the cell.
 * @param runId - the run's token, which names its report folder.
 * @param args - the runner's extra arguments.
 * @param options - how the run is driven.
 */
async function runCell(
  cell: string,
  runId: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunOutcome> {
  const env = runEnv(cell, runId);
  bddgen(env);
  options.beforeRun?.();
  const child = spawn(
    process.execPath,
    [
      cli("@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
      ...args,
    ],
    {
      cwd: work,
      env: { ...env, ...options.env },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    if (options.closeStdoutEarly === true) child.stdout.destroy();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exited = new Promise<[number | null, NodeJS.Signals | null]>(
    (resolve) => {
      child.on("exit", (code, signal) => {
        resolve([code, signal]);
      });
    },
  );
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone already.
    }
  };
  const timer = setTimeout(killGroup, CHILD_TIMEOUT_MS);
  try {
    if (options.stop !== undefined) {
      await (options.stopWhen === undefined
        ? waitForHangingScenario(cell, runId)
        : waitFor(() => options.stopWhen?.(stdout) === true));
      if (options.group === true && child.pid !== undefined) {
        process.kill(-child.pid, options.stop);
      } else {
        child.kill(options.stop);
      }
    }
    const [exitCode, signal] = await exited;
    return {
      exitCode,
      signal,
      stdout: stripVTControlCharacters(stdout),
      rawStdout: stdout,
      stderr,
      stream: readStream(cell, runId),
    };
  } finally {
    clearTimeout(timer);
    killGroup();
  }
}

/**
 * Polls until `done` holds.
 *
 * @param done - the condition.
 * @throws {@link Error} when it does not hold within {@link BEGIN_TIMEOUT_MS}.
 */
async function waitFor(done: () => boolean): Promise<void> {
  const deadline = Date.now() + BEGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the run never reached the point to stop it at");
}

/** Polls the stream until the hanging scenario's attempt has begun. */
async function waitForHangingScenario(
  cell: string,
  runId: string,
): Promise<void> {
  const deadline = Date.now() + BEGIN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const { events } = parseResults(readStream(cell, runId) ?? "");
    if (
      events.some(
        (e) => e.type === "scenario.begin" && e.scenario.includes("hangs"),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the hanging scenario never began");
}

/** A stream's events, every line checked complete and readable. */
function eventsOf(outcome: RunOutcome): ResultsEvent[] {
  if (outcome.stream === undefined)
    throw new Error("the run left no results stream");
  const { events, skipped, rest } = parseResults(outcome.stream);
  expect(skipped, "unreadable lines").toBe(0);
  expect(rest, "a partial last line").toBe("");
  expectConsistent(events);
  return [...events];
}

/**
 * What every stream must hold, however its run ended: each test ends at most once, and after its
 * last attempt began; a test with a `scenario.retry` but no later attempt ends with `retryNotRun`;
 * when there is a `run.end`, it is the last line, every test that began has ended before it, and its
 * counts are exactly the ends written.
 */
function expectConsistent(events: readonly ResultsEvent[]): void {
  const ends = new Map<string, ResultsEvent>();
  const begun = new Set<string>();
  const awaitingRetry = new Set<string>();
  for (const event of events) {
    if (event.type === "scenario.begin") {
      expect(ends.has(event.id), `${event.scenario} began after its end`).toBe(
        false,
      );
      begun.add(event.id);
      awaitingRetry.delete(event.id);
    } else if (event.type === "scenario.retry") {
      awaitingRetry.add(event.id);
    } else if (event.type === "scenario.end" || event.type === "setup.end") {
      expect(ends.has(event.id), `${event.id} ended twice`).toBe(false);
      ends.set(event.id, event);
      expect(event.retryNotRun === true, `${event.id}: retryNotRun`).toBe(
        awaitingRetry.has(event.id),
      );
      awaitingRetry.delete(event.id);
    }
  }
  const runEnd = events.at(-1);
  if (runEnd?.type !== "run.end") {
    expect(events.some((e) => e.type === "run.end")).toBe(false);
    return;
  }
  expect(
    [...begun].filter((id) => !ends.has(id)),
    "began, never ended",
  ).toEqual([]);
  expect(awaitingRetry.size, "a retry left pending").toBe(0);
  const tally = (
    type: "scenario.end" | "setup.end",
  ): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const event of ends.values()) {
      if (event.type === type)
        counts[event.status] = (counts[event.status] ?? 0) + 1;
    }
    return counts;
  };
  for (const [type, counts] of [
    ["scenario.end", runEnd.scenarios],
    ["setup.end", runEnd.setups],
  ] as const) {
    const written = tally(type);
    const finished = Object.values(written).reduce((sum, n) => sum + n, 0);
    for (const status of [
      "passed",
      "failed",
      "flaky",
      "skipped",
      "interrupted",
    ] as const) {
      expect(counts[status], `${type} ${status}`).toBe(written[status] ?? 0);
    }
    expect(counts.didNotRun, `${type} didNotRun`).toBe(counts.total - finished);
  }
}

/** The `scenario.end` whose scenario starts with `prefix`. */
function ended(
  events: readonly ResultsEvent[],
  prefix: string,
): ScenarioEndEvent {
  const found = events.find(
    (e): e is ScenarioEndEvent =>
      e.type === "scenario.end" && e.scenario.startsWith(prefix),
  );
  if (found === undefined) throw new Error(`no scenario.end for "${prefix}…"`);
  return found;
}

/** How many of a run's stdout lines are exactly `line`. */
function count(stdout: string, line: string): number {
  return stdout.split("\n").filter((l) => l === line).length;
}

/** The lines of a run's stdout before its summary: the terminal reporter's, the cell notice's. */
function runLines(stdout: string): string[] {
  const lines = stdout.split("\n");
  const summary = lines.findIndex((line) =>
    line.startsWith(`━━ ${PRODUCT} · `),
  );
  return summary === -1 ? lines : lines.slice(0, summary);
}

/** The summary's header line in a run's stdout, and everything after it. */
function summaryOf(stdout: string): string[] {
  const lines = stdout.trimEnd().split("\n");
  const start = lines.findIndex((line) => line.startsWith(`━━ ${PRODUCT} · `));
  return start === -1 ? [] : lines.slice(start);
}

test.describe("the results stream and the summary, through the real runner", () => {
  test.describe.configure({ timeout: 2 * CHILD_TIMEOUT_MS + 30_000 });

  test("a run with every outcome: each scenario attributed, the counts, the summary last", async () => {
    const outcome = await runCell("x", "full", [
      "--grep-invert",
      "@hang|@nobaseline",
    ]);
    expect(outcome.exitCode).toBe(1);
    const events = eventsOf(outcome);

    expect(events[0]).toMatchObject({
      type: "run.begin",
      runId: "full",
      product: PRODUCT,
      cell: "x",
      mode: "test",
      scenarios: 6,
      setups: 2,
      retries: 1,
      workers: 1,
    });
    // The placeholder cell's setups skip.
    expect(
      events.filter((e) => e.type === "setup.end").map((e) => e.status),
    ).toEqual(["skipped", "skipped"]);

    expect(ended(events, "A scenario that passes")).toMatchObject({
      status: "passed",
      feature: "The results stream, end to end",
      file: "results.feature",
      tags: ["@noauth"],
      attempts: 1,
    });
    expect(ended(events, "A scenario that passes")).not.toHaveProperty("error");

    const flaky = ended(events, "A scenario that fails on its first attempt");
    expect(flaky).toMatchObject({ status: "flaky", attempts: 2 });
    expect(flaky).not.toHaveProperty("error");
    expect(
      events.find((e) => e.type === "scenario.retry" && e.id === flaky.id),
    ).toMatchObject({
      attempt: 1,
      attemptStatus: "failed",
      error: { where: "step", step: "Given the first attempt fails" },
    });

    expect(ended(events, "A scenario whose step fails")).toMatchObject({
      status: "failed",
      attempts: 2,
      error: {
        message: "Error: boom (attempt 2)",
        where: "step",
        step: 'When a step fails with "boom"',
      },
    });
    expect(ended(events, "A scenario whose After hook fails")).toMatchObject({
      status: "failed",
      tags: ["@noauth", "@failafter"],
      error: {
        message: "Error: the After hook fails on purpose",
        where: "hook",
        step: "After Hooks › AfterEach Hooks › failing After hook",
      },
    });

    expect(ended(events, "A scenario that asks the run to stop")).toMatchObject(
      { status: "passed" },
    );
    const drained = ended(events, "A scenario that begins after");
    expect(drained).toMatchObject({ status: "skipped", drained: true });
    expect(drained).not.toHaveProperty("error");

    // Each scenario began once per attempt: 6 scenarios, and a retry for each of the 3 that failed
    // their first.
    expect(events.filter((e) => e.type === "scenario.begin")).toHaveLength(9);
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      status: "failed",
      scenarios: {
        total: 6,
        passed: 2,
        failed: 2,
        flaky: 1,
        skipped: 1,
        interrupted: 0,
        didNotRun: 0,
        drained: 1,
      },
      setups: { total: 2, skipped: 2, didNotRun: 0, drained: 0 },
    });

    // The summary is the run's last block. The drain skipped a scenario: the run was stopped, and
    // says so first; its counts still say what failed before the stop.
    const summary = summaryOf(outcome.stdout);
    expect(summary[0]).toMatch(/^━━ resultsprobe · x ━━ ■ STOPPED ━+$/);
    const facts = JSON.parse(
      readFileSync(
        join(work, "reports", PRODUCT, "x", "full", "run-facts.json"),
        "utf8",
      ),
    ) as { status: string; title: string };
    expect(facts.status).toBe("stopped");
    expect(facts.title).toMatch(/ · STOPPED$/);
    expect(summary[1]).toMatch(
      /^ {2}Result {6}2 failed · 1 flaky · 2 passed · 1 stopped, in \d/,
    );
    expect(summary.at(-1)).toBe(
      `  Allure      npm run report:allure -- ${PRODUCT} x --open`,
    );
    expect(
      summary.some((line) =>
        line.includes("reports/resultsprobe/x/full/playwright"),
      ),
    ).toBe(true);

    // The terminal reporter, in a pipe: the cell notice through it, then its header, then a line per
    // final attempt and per retry — each once, in order, plain. (Begin lines name worker output.)
    expect(outcome.rawStdout).not.toContain("\u001b");
    expect(outcome.stream).not.toContain("\u001b");
    const scenarios = "The results stream, end to end ›";
    expect(runLines(outcome.stdout).filter((l) => /^[^\s▸]/.test(l))).toEqual([
      expect.stringMatching(/^\[cell\] resultsprobe\/x, pinned by E2E_CELL/),
      "[run] resultsprobe · x · full · 6 scenarios",
      "— skipped 0.0s  src/common/auth/auth.setup.ts › authenticate site pool",
      "— skipped 0.0s  src/common/artifacts/artifacts.setup.ts › resolve & verify plugin artifacts",
      expect.stringMatching(
        /^✔ passed \d+\.\ds {2}The results stream, end to end › A scenario that passes$/,
      ),
      expect.stringMatching(
        new RegExp(
          `^↻ retry \\d+\\.\\ds {2}${scenarios} A scenario that fails on its first attempt passes on its retry · attempt 1/2 · failed$`,
        ),
      ),
      expect.stringMatching(/^⚠ flaky .* · attempt 2\/2$/),
      expect.stringMatching(
        /^↻ retry .* A scenario whose step fails on every attempt fails · attempt 1\/2 · failed$/,
      ),
      expect.stringMatching(
        /^✘ failed .* A scenario whose step fails on every attempt fails · attempt 2\/2$/,
      ),
      expect.stringMatching(
        /^↻ retry .* A scenario whose After hook fails fails in that hook · attempt 1\/2 · failed$/,
      ),
      expect.stringMatching(
        /^✘ failed .* A scenario whose After hook fails fails in that hook · attempt 2\/2$/,
      ),
      expect.stringMatching(
        /^✔ passed .* A scenario that asks the run to stop passes$/,
      ),
      expect.stringMatching(
        /^■ stopped .* A scenario that begins after the run is asked to stop is drained$/,
      ),
    ]);
    expect(count(outcome.stdout, "  Error: boom (attempt 2)")).toBe(1);
    // The worker's coloured output — forced into colour by Playwright — lands plain and masked, once
    // per attempt, as it comes: under a begin line naming the attempt, before the attempt's own
    // line; the chunk with no line end too.
    const lines = runLines(outcome.stdout);
    const flakyTitle = `${scenarios} A scenario that fails on its first attempt passes on its retry`;
    for (const attempt of [1, 2]) {
      const probe = `  │ [probe] attempt ${String(attempt)} via https://***@x.example.test/`;
      expect(count(outcome.stdout, probe)).toBe(1);
      const named = lines.indexOf(
        attempt === 1 ? `▸ ${flakyTitle}` : `▸ ${flakyTitle} · attempt 2/2`,
      );
      const own = lines.findIndex((l) =>
        l.startsWith(attempt === 1 ? "↻ retry " : "⚠ flaky "),
      );
      expect(named).toBeGreaterThan(-1);
      expect(lines.indexOf(probe)).toBe(named + 1);
      expect(own).toBeGreaterThan(named);
    }
    expect(
      count(outcome.stdout, "  │ [probe] a warning with no line end"),
    ).toBe(2);
    expect(outcome.rawStdout + outcome.stderr).not.toContain("hunter2");
    // Credentials behind hundreds of escapes are masked whole: no fragment of either is printed.
    expect(
      count(
        outcome.stdout,
        `  │ ${".".repeat(369)} GET https://***@x.example.test/wp-admin/`,
      ),
    ).toBe(2);
    expect(count(outcome.stdout, "  │ token ***")).toBe(2);
    for (const fragment of ["S3cret", "admin:", "ghp_", "ABCDEFGH"]) {
      expect(outcome.rawStdout + outcome.stderr).not.toContain(fragment);
    }
    // Nothing printed on stderr: every reporter writes through the terminal reporter.
    expect(outcome.stderr).toBe("");
  });

  test("an interrupt (one SIGINT): the attempt in flight ends interrupted, run.end, INTERRUPTED", async () => {
    const outcome = await runCell("x", "sigint", ["--grep", "@hang"], {
      stop: "SIGINT",
    });
    const events = eventsOf(outcome);
    expect(ended(events, "A scenario that hangs")).toMatchObject({
      status: "interrupted",
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      status: "interrupted",
      scenarios: { total: 1, interrupted: 1, didNotRun: 0 },
    });
    expect(summaryOf(outcome.stdout)[0]).toMatch(/■ INTERRUPTED/);
  });

  test("a SIGTERM: only complete lines, no run.end, no summary", async () => {
    const outcome = await runCell("x", "sigterm", ["--grep", "@hang"], {
      stop: "SIGTERM",
    });
    const events = eventsOf(outcome);
    expect(events.map((e) => e.type)).toContain("scenario.begin");
    expect(events.some((e) => e.type === "run.end")).toBe(false);
    expect(summaryOf(outcome.stdout)).toEqual([]);
  });

  test("a SIGKILL of the run's group (the orchestrator's escalation): the hung scenario's whole lines are already out, named", async () => {
    const outcome = await runCell("x", "sigkill", ["--grep", "@hang"], {
      stop: "SIGKILL",
      group: true,
      stopWhen: (stdout) => stdout.includes("[probe] the scenario hangs\n"),
    });
    expect(outcome.signal).toBe("SIGKILL");
    const lines = runLines(outcome.stdout);
    const named = lines.indexOf(
      "▸ The results stream, end to end › A scenario that hangs runs until the run is stopped",
    );
    expect(named).toBeGreaterThan(-1);
    expect(lines[named + 1]).toBe("  │ [probe] the scenario hangs");
    // Its open line never ended: lost with the runner, as Playwright never handed it over whole.
    expect(outcome.stdout).not.toContain("still waiting");
  });

  test("a global timeout ends the run first: the running scenario's whole line before the error, its open line with its own late end", async () => {
    const outcome = await runCell("x", "globaltimeout", [
      "--grep",
      "@hang",
      "--global-timeout=10000",
    ]);
    expect(outcome.exitCode).toBe(1);
    const lines = runLines(outcome.stdout);
    const named =
      "▸ The results stream, end to end › A scenario that hangs runs until the run is stopped";
    const whole = lines.indexOf("  │ [probe] the scenario hangs");
    const error = lines.findIndex((l) =>
      l.startsWith("✘ error Timed out waiting 10s for the test suite to run"),
    );
    const open = lines.indexOf("  │ [probe] still waiting");
    expect(lines[whole - 1]).toBe(named);
    expect(whole).toBeLessThan(error);
    expect(error).toBeLessThan(open);
    expect(lines[open - 1]).toBe(named);
    expect(lines[open + 1]).toMatch(/^■ interrupted .* A scenario that hangs/);
  });

  test("failed setups: each setup.end with its error, every scenario did not run, COULD NOT TEST", async () => {
    const outcome = await runCell("y", "setup", [
      "--grep-invert",
      "@hang|@nobaseline",
    ]);
    expect(outcome.exitCode).toBe(1);
    const events = eventsOf(outcome);
    const setups = events.filter((e) => e.type === "setup.end");
    expect(setups.map((e) => [e.setup, e.status]).sort()).toEqual([
      ["artifacts", "failed"],
      ["auth", "failed"],
    ]);
    for (const setup of setups) expect(setup.error?.message).toBeTruthy();
    expect(events.some((e) => e.type === "scenario.begin")).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      scenarios: { total: 6, didNotRun: 6 },
      setups: { total: 2, failed: 2 },
    });
    // The artifacts setup made the cell's folder at the absolute ARTIFACTS_ROOT before failing,
    // and nothing under the checkout, where joining the root onto it would have put it.
    expect(existsSync(join(work, "artifacts", PRODUCT, "y"))).toBe(true);
    expect(existsSync(join(REPO_ROOT, work))).toBe(false);

    // The artifacts setup's own line, under a begin line, once; each setup's line and error once.
    const zip = join(work, "missing.zip");
    expect(
      count(outcome.stdout, `  │ [artifacts] resolving "plugin" — zip ${zip}`),
    ).toBe(1);
    const lines = runLines(outcome.stdout);
    const begun = lines.indexOf(
      "▸ src/common/artifacts/artifacts.setup.ts › resolve & verify plugin artifacts",
    );
    expect(begun).toBeGreaterThan(-1);
    expect(lines[begun + 1]).toContain("[artifacts] resolving");
    for (const setup of [
      "src/common/auth/auth.setup.ts › authenticate site pool",
      "src/common/artifacts/artifacts.setup.ts › resolve & verify plugin artifacts",
    ]) {
      expect(
        lines.filter((l) => l.startsWith("✘ failed ") && l.endsWith(setup)),
      ).toHaveLength(1);
    }
    expect(outcome.rawStdout).not.toContain("\u001b");

    const summary = summaryOf(outcome.stdout);
    expect(summary[0]).toMatch(/✘ COULD NOT TEST/);
    expect(
      summary.filter((line) => /^ {2}Setup|^ {14}\S/.test(line)).join("\n"),
    ).toMatch(/artifacts:y failed — /);
    expect(summary).toContain(
      "  Result      6 did not run, in " +
        (summary[1]?.split(", in ")[1] ?? ""),
    );
    expect(
      summary.some((line) =>
        line.startsWith("  Plugin      resolution failed — "),
      ),
    ).toBe(true);
  });

  test("a retry Playwright never runs (no screenshot baseline): the scenario still ends, retryNotRun", async () => {
    // A missing baseline is an error Playwright does not retry, though the scenario has a retry
    // left — the same as a retry still queued when a run stops.
    const outcome = await runCell("x", "nobaseline", ["--grep", "@nobaseline"]);
    expect(outcome.exitCode).toBe(1);
    const events = eventsOf(outcome);
    expect(events.map((e) => e.type)).toEqual([
      "run.begin",
      "setup.end",
      "setup.end",
      "scenario.begin",
      "scenario.retry",
      "scenario.end",
      "run.end",
    ]);
    expect(ended(events, "A scenario whose screenshot")).toMatchObject({
      status: "failed",
      attempts: 1,
      retryNotRun: true,
      // Playwright records a missing baseline on the result alone, no step carrying it: the step
      // that was running is named instead.
      error: {
        where: "last-step",
        step: "Then the page matches a screenshot that has no baseline",
      },
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      scenarios: { total: 1, failed: 1, didNotRun: 0 },
    });
    expect(summaryOf(outcome.stdout)[1]).toMatch(
      /^ {2}Result {6}1 failed, in /,
    );
  });

  test("a spec file that will not load: run.error, and FAILED with its error — never NO TESTS", async () => {
    // A generated spec that throws as it is imported — a fixtures module that does not load — stops
    // Playwright planning any test at all.
    const broken = join(
      work,
      ".features-gen",
      PRODUCT,
      "x",
      "broken.feature.spec.js",
    );
    const outcome = await runCell("x", "loaderror", [], {
      beforeRun: () => {
        writeFileSync(
          broken,
          'throw new Error("a spec file does not load");\n',
        );
      },
    });
    rmSync(broken, { force: true });
    expect(outcome.exitCode).toBe(1);
    const events = eventsOf(outcome);
    expect(events.find((e) => e.type === "run.error")).toMatchObject({
      message: expect.stringContaining("a spec file does not load"),
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      status: "failed",
      scenarios: { total: 0 },
    });
    const summary = summaryOf(outcome.stdout);
    expect(summary[0]).toMatch(/^━━ resultsprobe · x ━━ ✘ FAILED ━+$/);
    expect(summary.find((line) => line.startsWith("  Error"))).toMatch(
      /a spec file does not load/,
    );
    const facts = JSON.parse(
      readFileSync(
        join(work, "reports", PRODUCT, "x", "loaderror", "run-facts.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(facts.status).toBe("failed");
  });

  test("a selection that matches nothing: NO TESTS, in the summary and the facts", async () => {
    const outcome = await runCell("x", "nomatch", [
      "--grep",
      "@nothing-has-this",
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(summaryOf(outcome.stdout)[0]).toMatch(/NO TESTS/);
    const facts = JSON.parse(
      readFileSync(
        join(work, "reports", PRODUCT, "x", "nomatch", "run-facts.json"),
        "utf8",
      ),
    ) as { status: string };
    expect(facts.status).toBe("no-tests");
  });

  test("--list: the stream marks a run that runs nothing; no summary", async () => {
    const outcome = await runCell("x", "list", ["--list"]);
    expect(outcome.exitCode).toBe(0);
    const events = eventsOf(outcome);
    expect(events[0]).toMatchObject({
      type: "run.begin",
      mode: "list",
      scenarios: 8,
      setups: 2,
    });
    expect(events.at(-1)).toMatchObject({
      type: "run.end",
      scenarios: { didNotRun: 8 },
    });
    expect(summaryOf(outcome.stdout)).toEqual([]);
    // Playwright's own listing, the cell notice once, and none of the terminal reporter's lines.
    expect(outcome.stdout).toContain("Listing tests:");
    expect(outcome.stdout).toMatch(/^Total: 10 tests in 3 files$/m);
    expect(outcome.stdout.match(/^\[cell\] /gm)).toHaveLength(1);
    expect(outcome.stdout).not.toMatch(/^\[run\] /m);
  });

  test("PW_TEST_REPORTER: the terminal reporter stays quiet; the reporter it names prints, the stream is written", async () => {
    const outcome = await runCell(
      "x",
      "envreporter",
      ["--grep", "A scenario that passes"],
      { env: { PW_TEST_REPORTER: "dot" } },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).not.toMatch(/^\[run\] /m);
    expect(outcome.stdout).not.toMatch(/^✔ passed /m);
    // The cell notice prints as it would alone, and dot's progress follows.
    expect(outcome.stdout.match(/^\[cell\] /gm)).toHaveLength(1);
    expect(outcome.stdout).toMatch(/^ +1 passed/m);
    expect(eventsOf(outcome).at(-1)).toMatchObject({ type: "run.end" });
  });

  test("PW_TEST_REPORTER naming a reporter that prints nothing (junit to a file, null): Playwright adds its own, so the run is never silent", async () => {
    const junit = join(work, "junit.xml");
    for (const [name, env] of [
      ["junit", { PLAYWRIGHT_JUNIT_OUTPUT_NAME: junit }],
      ["null", {}],
    ] as const) {
      const outcome = await runCell(
        "x",
        `env-${name}`,
        ["--grep", "A scenario that passes"],
        { env: { PW_TEST_REPORTER: name, ...env } },
      );
      expect(outcome.exitCode, name).toBe(0);
      expect(outcome.stdout, name).not.toMatch(/^\[run\] /m);
      // Playwright's fallback (`line`, outside CI): its count line.
      expect(outcome.stdout, name).toMatch(/^ +1 passed/m);
      expect(eventsOf(outcome).at(-1)).toMatchObject({ type: "run.end" });
    }
    expect(existsSync(junit)).toBe(true);
  });

  test("a reader that closes early (… | head -1): no crash — the run ends as it would, run.end written", async () => {
    const outcome = await runCell(
      "x",
      "epipe",
      ["--grep", "A scenario that passes"],
      { closeStdoutEarly: true },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stderr).not.toMatch(/EPIPE|Unhandled 'error'/);
    expect(eventsOf(outcome).at(-1)).toMatchObject({
      type: "run.end",
      status: "passed",
    });
    // The pipe was closed before the summary: its writes failed, silently.
    expect(summaryOf(outcome.stdout)).toEqual([]);
  });

  test("--reporter replaces the whole stack: no cell notice, header, stream or summary", async () => {
    const outcome = await runCell("x", "replaced", [
      "--grep",
      "A scenario that passes",
      "--reporter=line",
    ]);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.stdout).not.toMatch(/^\[(?:cell|run)\] /m);
    expect(outcome.stream).toBeUndefined();
    expect(summaryOf(outcome.stdout)).toEqual([]);
  });

  test("FORCE_COLOR into a pipe: the suite honours it — styled marks, every word kept, the stream plain", async () => {
    const outcome = await runCell(
      "x",
      "forced",
      ["--grep", "A scenario that passes"],
      { env: { FORCE_COLOR: "1" } },
    );
    expect(outcome.exitCode).toBe(0);
    expect(outcome.rawStdout).toContain("\u001b[32m✔\u001b[39m passed ");
    expect(outcome.stream).not.toContain("\u001b");
  });

  test("E2E_OUTPUT=plain: ASCII marks; a bad value fails the run as its config loads, naming it", async () => {
    const plainRun = await runCell(
      "x",
      "plainmode",
      ["--grep", "A scenario that passes"],
      { env: { E2E_OUTPUT: "plain", FORCE_COLOR: "1" } },
    );
    expect(plainRun.exitCode).toBe(0);
    expect(plainRun.rawStdout).toMatch(
      /^OK passed \d+\.\ds {2}The results stream, end to end > A scenario that passes$/m,
    );
    // Up to the summary, which 7.2a leaves as it is (it still honours FORCE_COLOR on its own).
    const beforeSummary = plainRun.rawStdout.slice(
      0,
      plainRun.rawStdout.lastIndexOf("\n", plainRun.rawStdout.indexOf("━━ ")),
    );
    expect(beforeSummary).toContain("[run] resultsprobe . x . plainmode");
    expect(beforeSummary).not.toContain("\u001b");

    const bad = spawnSync(
      process.execPath,
      [
        cli("@playwright/test/cli.js"),
        "test",
        "-c",
        "playwright.config.ts",
        "--list",
      ],
      {
        cwd: work,
        env: { ...runEnv("x", "badmode"), E2E_OUTPUT: "pretty" },
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    expect(bad.status).toBe(1);
    expect(bad.stdout + bad.stderr).toContain(
      'Environment variable "E2E_OUTPUT" must be one of auto/plain/fancy, got "pretty".',
    );
  });
});
