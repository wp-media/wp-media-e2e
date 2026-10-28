import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fakeCommand } from "./__fixtures__/fake-suite";
import { startSink, type HttpSink } from "./__fixtures__/http-sink";
import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "./__fixtures__/results";
import {
  judgeFlat,
  pruneMsPerFolder,
  takeSample,
  type PruneTiming,
  type Sample,
  type Tolerance,
} from "./__fixtures__/soak";
import { removeTempDir } from "../src/common/__fixtures__/temp-dir";
import { RESULTS_FILE } from "../src/common/reporting/results-schema";
import type { ProductList } from "./config/product-list";
import type { RunCommands } from "./runs/commands";
import { launchRun } from "./runs/launch";
import type { ShutdownSignal } from "./runs/shutdown";
import { start, type StartProcess } from "./start";
import { pruneTaskRuns } from "./state/run-retention";

/**
 * The soak: the real `start`, in this process, over the fake suite — real processes, records, the bus,
 * Slack and Datator over real sockets to a local sink, and run-folder pruning — for hundreds of runs,
 * only the cooldown cut to {@link COOLDOWN_MS}. It proves what the unit specs cannot: that many cycles
 * leave the process's listeners, handles, timers and file descriptors flat, that pruning holds a
 * task's run folders at the cap, and what pruning costs as folders accumulate without one.
 *
 * Off by default (minutes long): `npm run orchestrator:soak`, which sets `ORCHESTRATOR_SOAK=1`;
 * `ORCHESTRATOR_SOAK_RUNS` sets the runs of each test (default 200).
 */

/** Runs per test. */
const RUNS = Number(process.env.ORCHESTRATOR_SOAK_RUNS ?? 200);

/** A sample is taken every this many runs, between two. */
const SAMPLE_EVERY = 10;

/** The samples that set the baseline: the first fifth, so module loading and pools have settled. */
const WARMUP_SAMPLES = Math.max(1, Math.floor(RUNS / SAMPLE_EVERY / 5));

/**
 * Each measure's allowance over its warm-up's highest: a sample lands at a run's end while the last
 * notifications' sockets and the runs' pipes may still be closing, so a few in flight are noise —
 * a leak of one per run exceeds it within a few dozen runs.
 */
const TOLERANCE: Tolerance = {
  listeners: 0,
  resources: 4,
  timeouts: 2,
  fds: 4,
};

/** The cooldown in place of the config's minutes. */
const COOLDOWN_MS = 50;

/** Pruning's cost bound: 8,000 folders took 2.3 s (≈ 0.3 ms each) when measured on a laptop. */
const MAX_PRUNE_MS_PER_FOLDER = 1;

/** The suite's default `reportsKeep`, the cap of the first test. */
const DEFAULT_KEEP = 20;

/** The task: one, so a sample never lands in another task's run. */
const TASK_ID = "bsak";

/** A cell no sites file has: the product list is a stand-in, so nothing can reach a real site. */
const CELL = "soak@cell";

/**
 * A results stream of one passed scenario: each run passes, so Datator is posted to every time.
 *
 * @param runId - the run's `RUN_ID`, which its `run.begin` names: the status table counts only its own.
 * @returns the stream.
 */
function passedStream(runId: string): string {
  return streamOf([
    runBegin(1, { runId }),
    scenarioEnd("a", "passed"),
    runEnd("passed", { total: 1, passed: 1 }),
  ]);
}

/** How long each fake run lasts: a few of the status table's 20 ms polls, so its tail is read. */
const RUN_MS = 60;

/** The stand-in product list: BackWPup, with the one cell. */
const PRODUCT_LIST = {
  PRODUCTS: [
    {
      name: "backwpup",
      sites: {
        [CELL]: {
          edition: "pro",
          sites: [
            {
              baseURL: "https://soak.qa.test",
              username: "admin",
              password: "pw",
              transport: {
                mode: "ssh",
                host: "qa-lnmp",
                username: "ubuntu",
                privateKeyPath: "/k",
                rootDir: "/var/www",
              },
            },
          ],
        },
      },
    },
  ],
  productByName: (name: string) => ({ name }),
  playwrightConfigFor: () => "playwright.backwpup.config.ts",
} as unknown as ProductList;

/** A stand-in for `process.stdout` that takes every write at once. */
class SinkStdout {
  readonly writableLength = 0;
  readonly isTTY = false;
  /** Takes a chunk at once. */
  write(_chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    callback();
    return true;
  }
  /** Never fails. */
  on(): this {
    return this;
  }
}

/** A stand-in process: its signals emitted by the soak, its outputs dropped. */
class SoakProcess extends EventEmitter implements StartProcess {
  readonly pid = 4242;
  readonly env = { PATH: process.env.PATH };
  readonly execPath = process.execPath;
  readonly stdout = new SinkStdout();
  readonly stderr = { write: (): boolean => true };
  /** Sends a signal the way the terminal would. */
  signal(signal: ShutdownSignal): void {
    this.emit(signal);
  }
}

/** What one soak measured. */
interface SoakResult {
  readonly code: number;
  readonly samples: Sample[];
  readonly timings: PruneTiming[];
  /** The task's run folders after each pruning. */
  readonly kept: number[];
  readonly log: string;
  readonly requests: number;
  /** How many tables the status sink was handed. */
  readonly shows: number;
  /** The task's phase in the last one. */
  readonly lastPhase: string;
  /** The most scenarios a run in flight was shown done: above 0 only if its stream was read. */
  readonly mostDone: number;
}

let root = "";
let sink: HttpSink | undefined;

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-soak-"));
  // Slack answers 200 ok, Datator 201: every run's notifications succeed.
  sink = await startSink((request, response) => {
    const slack = request.path.startsWith("/services/");
    response.writeHead(slack ? 200 : 201, { "Content-Type": "text/plain" });
    response.end(slack ? "ok" : "{}");
  });
});

test.afterEach(async () => {
  await sink?.close();
  sink = undefined;
  removeTempDir(root);
  root = "";
});

/**
 * The task's run folders.
 *
 * @param stateDir - the state directory.
 * @returns how many there are.
 */
function runFolders(stateDir: string): number {
  return readdirSync(join(stateDir, "runs")).filter((name) =>
    name.startsWith(`${TASK_ID}-`),
  ).length;
}

/**
 * Runs `start` for `runs` runs, then stops it with one Ctrl-C during a cooldown.
 *
 * @param runs - how many runs.
 * @param reportsKeep - the config's `runs.reportsKeep`; the suite's default when absent.
 * @returns what it measured.
 */
async function soak(runs: number, reportsKeep?: number): Promise<SoakResult> {
  const checkout = join(root, "checkout");
  const stateDir = join(checkout, ".orchestrator");
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const config = join(stateDir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      tasks: [
        {
          id: TASK_ID,
          type: "loop",
          product: "backwpup",
          cell: CELL,
          cooldownMinutes: 1,
        },
      ],
      ...(reportsKeep === undefined ? {} : { runs: { reportsKeep } }),
      notifications: {
        slack: { webhookUrl: "https://hooks.slack.com/services/T0/B0/soak" },
        datator: {
          url: "https://datator.example.org/e2e_tests/results/",
          apiKey: "soak-datator-key-0123",
        },
      },
    }),
    { mode: 0o600 },
  );
  const proc = new SoakProcess();
  let shows = 0;
  let lastPhase = "";
  let mostDone = 0;
  const samples: Sample[] = [];
  const timings: PruneTiming[] = [];
  const kept: number[] = [];
  const target = sink;
  if (target === undefined) throw new Error("no sink");
  const commands = (reportDir: string): RunCommands => ({
    bddgen: fakeCommand({ exitCode: 0 }),
    playwright: fakeCommand({
      runMs: RUN_MS,
      writes: [
        {
          path: join(reportDir, RESULTS_FILE),
          text: passedStream(basename(reportDir)),
        },
      ],
    }),
  });
  const code = await start(
    { config },
    {
      process: proc,
      checkout,
      loadProductList: () => Promise.resolve(PRODUCT_LIST),
      cellLocks: join(root, "site-locks"),
      exitWaitMs: 1_000,
      // The status table, followed the whole time: its tails and its poll timer must leak nothing.
      status: {
        pollMs: 20,
        show: (board) => {
          shows += 1;
          const phase = board[0]?.phase;
          lastPhase = phase?.kind ?? "";
          if (phase?.kind === "run")
            mostDone = Math.max(mostDone, phase.run.progress.done);
        },
      },
      notifications: {
        // Every request to the sink, over a real socket, by the real `fetch`.
        fetch: (input, init) =>
          fetch(
            `${target.url}${new URL(input instanceof Request ? input.url : String(input)).pathname}`,
            init,
          ),
      },
      loop: {
        commandsFor: () => commands(""),
        // The real launch, given commands that write the results where this run's report goes.
        launch: (options) =>
          launchRun({
            ...options,
            commands: commands(options.identity.reportDir),
          }),
        launchOptions: { pollMs: 20 },
        prune: async (input) => {
          const folders = runFolders(stateDir);
          const t0 = performance.now();
          const report = await pruneTaskRuns(input);
          timings.push({ folders, ms: performance.now() - t0 });
          kept.push(runFolders(stateDir));
          return report;
        },
        timers: {
          setTimeout: (callback) =>
            setTimeout(() => {
              const done = timings.length;
              if (done % SAMPLE_EVERY === 0) samples.push(takeSample(done));
              if (done >= runs) proc.signal("SIGINT");
              else callback();
            }, COOLDOWN_MS),
          clearTimeout: (handle) => {
            clearTimeout(handle as NodeJS.Timeout);
          },
        },
      },
    },
  );
  const log = await readFile(join(stateDir, "orchestrator.log"), "utf8");
  return {
    code,
    samples,
    timings,
    kept,
    log,
    requests: target.requests.length,
    shows,
    lastPhase,
    mostDone,
  };
}

/**
 * Waits until the process is back to what it held before a soak, within the tolerance — the
 * notifications' kept-alive sockets close a few seconds after their last request.
 *
 * @param before - the sample taken before the soak.
 * @returns the last sample taken.
 */
async function settled(before: Sample): Promise<Sample> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const now = takeSample(before.cycle);
    const back =
      now.listeners <= before.listeners &&
      now.resources <= before.resources + TOLERANCE.resources &&
      now.timeouts <= before.timeouts + TOLERANCE.timeouts &&
      now.fds <= before.fds + TOLERANCE.fds;
    if (back || Date.now() > deadline) return now;
    await delay(200);
  }
}

/**
 * Asserts every run passed and was announced: one outcome line and one notification line each, both
 * senders' requests answered.
 *
 * @param result - the soak's.
 * @param runs - how many runs it made.
 */
function expectEveryRunAnnounced(result: SoakResult, runs: number): void {
  const count = (text: string): number => result.log.split(text).length - 1;
  expect(count(" ✔ passed ")).toBe(runs);
  expect(count("slack ✓ · datator ✓ 201")).toBe(runs);
  expect(result.log).not.toContain("✗");
  expect(result.requests).toBe(2 * runs);
  // Each run is shown at least begun, ended and cooling; the loop's end last.
  expect(result.shows).toBeGreaterThanOrEqual(3 * runs);
  expect(result.lastPhase).toBe("over");
  // The poller worked: a run's stream was read, not only the loops' activity shown.
  expect(result.mostDone).toBeGreaterThanOrEqual(1);
}

/**
 * Prints what a soak measured, for the record.
 *
 * @param title - which soak.
 * @param result - what it measured.
 */
function report(title: string, result: SoakResult): void {
  const first = result.samples[0];
  const last = result.samples.at(-1);
  const ms = (timing?: PruneTiming): string =>
    timing === undefined
      ? "-"
      : `${timing.ms.toFixed(1)} ms at ${String(timing.folders)} folders`;
  console.log(
    [
      `${title}: ${String(result.timings.length)} runs, exit ${String(result.code)}`,
      ...result.samples.map(
        (s) =>
          `  after ${String(s.cycle).padStart(4)} runs: listeners ${String(s.listeners)} · resources ${String(s.resources)} · timers ${String(s.timeouts)} · fds ${String(s.fds)} · heap ${s.heapMiB.toFixed(1)} MiB`,
      ),
      `  heap ${first?.heapMiB.toFixed(1) ?? "-"} → ${last?.heapMiB.toFixed(1) ?? "-"} MiB (reported, not judged)`,
      `  pruning: first ${ms(result.timings[0])}, last ${ms(result.timings.at(-1))}`,
    ].join("\n"),
  );
}

test.describe("the soak", () => {
  test.skip(
    process.env.ORCHESTRATOR_SOAK !== "1",
    "minutes long: run it with npm run orchestrator:soak",
  );
  // Each run spawns two Node processes: well under a second, allowed two.
  test.setTimeout(RUNS * 2_000 + 60_000);

  test("hundreds of runs leave listeners, handles, timers and descriptors flat, the run folders at the cap", async () => {
    const before = takeSample(0);
    const result = await soak(RUNS);
    report("capped (reportsKeep 20)", result);
    expect(result.code).toBe(130);
    expect(result.timings).toHaveLength(RUNS);
    expectEveryRunAnnounced(result, RUNS);
    expect(judgeFlat(result.samples, WARMUP_SAMPLES, TOLERANCE)).toEqual([]);
    // Each pruning leaves the cap: the run just ended is one of the 20.
    expect(Math.max(...result.kept)).toBeLessThanOrEqual(DEFAULT_KEEP);
    expect(result.kept.at(-1)).toBe(DEFAULT_KEEP);
    // With the folders held at the cap, pruning costs the same at the end as once warmed up.
    expect(
      pruneMsPerFolder(result.timings, 20) /
        pruneMsPerFolder(result.timings.slice(20, 40), 20),
    ).toBeLessThan(3);
    // And once it has stopped, the process holds what it held before it started.
    const after = await settled(before);
    expect(after.listeners).toBeLessThanOrEqual(before.listeners);
    expect(after.resources).toBeLessThanOrEqual(
      before.resources + TOLERANCE.resources,
    );
    expect(after.timeouts).toBeLessThanOrEqual(
      before.timeouts + TOLERANCE.timeouts,
    );
    expect(after.fds).toBeLessThanOrEqual(before.fds + TOLERANCE.fds);
  });

  test("without a cap the run folders accumulate, and pruning stays under 1 ms a folder", async () => {
    const result = await soak(RUNS, 0);
    report("uncapped (reportsKeep 0)", result);
    expect(result.code).toBe(130);
    expectEveryRunAnnounced(result, RUNS);
    // Nothing is pruned: every run is under 30 days old.
    expect(result.kept.at(-1)).toBe(RUNS);
    const rate = pruneMsPerFolder(result.timings, 20);
    console.log(`  pruning: ${rate.toFixed(3)} ms a folder over the last 20`);
    expect(rate).toBeLessThan(MAX_PRUNE_MS_PER_FOLDER);
  });
});
