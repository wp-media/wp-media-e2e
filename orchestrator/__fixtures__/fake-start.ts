import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import type { ProductList } from "../config/product-list";
import type { RunCommands } from "../runs/commands";
import { launchRun } from "../runs/launch";

import {
  prepareStart as realPrepareStart,
  start as realStart,
  type StartOptions,
} from "../start";
import type { ExitCode } from "../start-lines";
import { fakeCommand, type FakeBehaviour } from "./fake-suite";
import { runBegin, runEnd, scenarioEnd, setupEnd, streamOf } from "./results";

/**
 * For specs: `orchestrator/start.ts` as the real `cli.ts` sees it once `swap-start.ts` is preloaded —
 * everything of the real module, but `start` runs every run as the fake runner (one that waits for a
 * stop) on a stand-in product, so the real command, its real process and its real signals are tested
 * with no site touched. The checkout the runs start in is `FAKE_CLI_CHECKOUT`; with
 * `FAKE_LATE_SIGNAL=SIGINT`, the process sends itself that signal once `start` has returned — after
 * `start` removed its handlers, before `process.exit`; with `FAKE_SLOW_PREPARE=1`, the dry run's
 * preparation says `preparing` on standard error, then waits 10 s — a dry run still in progress;
 * `FAKE_PARENT_WATCH_MS` reads the parent's PID that often instead of every second; `FAKE_RUN_MS`
 * makes each run's fake runner last that long instead of a minute (`0`: a run that ends at once, its
 * loop then cooling down); `FAKE_RESULTS_MS` makes it write its results stream as a run goes — its
 * begin, two setups, {@link FAKE_SCENARIOS} scenarios (one flaky), its end, one piece that
 * often — and exit once it is written, so the status table has a run to show; with
 * `FAKE_IGNORE_STOPS=1` too, that runner ignores the drain and SIGINT, so only a kill ends it early.
 */

/** The scenarios a run writes under `FAKE_RESULTS_MS`. */
export const FAKE_SCENARIOS = 12;

export * from "../start";

/** A real-shaped SSH site no run ever reaches: the fake runner does not read it. */
const SITE = {
  baseURL: "https://a.qa.test",
  username: "admin",
  password: "pw",
  transport: {
    mode: "ssh",
    host: "qa-lnmp",
    username: "ubuntu",
    privateKeyPath: "/k",
    rootDir: "/var/www",
  },
} as const;

/** The stand-in product list: BackWPup with two cells, `fake@cell` and `fake2@cell` — names no real sites file has, so that should the swap ever fail, the real `start` refuses the config instead of running the real suite. */
const PRODUCT_LIST = {
  PRODUCTS: [
    {
      name: "backwpup",
      sites: {
        "fake@cell": { edition: "pro", sites: [SITE] },
        // A second cell, its own site: two tasks running side by side.
        "fake2@cell": {
          edition: "pro",
          sites: [{ ...SITE, baseURL: "https://b.qa.test" }],
        },
      },
    },
  ],
  productByName: () => {
    throw new Error("the fake suite's commands need no product");
  },
  playwrightConfigFor: () => "playwright.backwpup.config.ts",
} as unknown as ProductList;

/**
 * The real `start` over the fake suite.
 *
 * @param options - the command line's options.
 * @returns `start`'s exit code.
 */
export async function start(options: StartOptions): Promise<ExitCode> {
  const checkout = process.env.FAKE_CLI_CHECKOUT;
  if (checkout === undefined) throw new Error("FAKE_CLI_CHECKOUT is not set");
  const stepMs = process.env.FAKE_RESULTS_MS;
  /**
   * The fake's commands for a run writing its stream into `reportDir`, or none.
   *
   * @param reportDir - the run's report folder; empty before its launch.
   * @returns `bddgen`'s and the runner's.
   */
  const commands = (reportDir: string): RunCommands => ({
    bddgen: fakeCommand({ exitCode: 0 }),
    playwright: fakeCommand(
      stepMs === undefined || reportDir === ""
        ? { runMs: Number(process.env.FAKE_RUN_MS ?? 60_000) }
        : {
            ...writingResults(join(reportDir, RESULTS_FILE), Number(stepMs)),
            ...(process.env.FAKE_IGNORE_STOPS === "1"
              ? { ignoreDrain: true, ignoreSigint: true }
              : {}),
          },
    ),
  });
  const code = await realStart(options, {
    checkout,
    loadProductList: () => Promise.resolve(PRODUCT_LIST),
    loop: {
      commandsFor: () => commands(""),
      ...(stepMs === undefined
        ? {}
        : {
            launch: (launch) =>
              launchRun({
                ...launch,
                commands: commands(launch.identity.reportDir),
              }),
          }),
      launchOptions: { pollMs: 20 },
    },
    ...(process.env.FAKE_PARENT_WATCH_MS === undefined
      ? {}
      : {
          parentWatch: {
            parentPid: () => process.ppid,
            intervalMs: Number(process.env.FAKE_PARENT_WATCH_MS),
          },
        }),
  });
  const late = process.env.FAKE_LATE_SIGNAL;
  if (late !== undefined) process.kill(process.pid, late);
  return code;
}

/**
 * A runner writing its results stream piece by piece, `stepMs` apart, then exiting: a run's begin,
 * both setups, {@link FAKE_SCENARIOS} scenarios — the third flaky —, its end: a flaky run.
 *
 * @param results - the stream's path.
 * @param stepMs - the time between two pieces.
 * @returns the behaviour.
 */
function writingResults(results: string, stepMs: number): FakeBehaviour {
  const runId = basename(join(results, ".."));
  const statusOf = (i: number): "passed" | "flaky" =>
    i === 2 ? "flaky" : "passed";
  const pieces = [
    streamOf([runBegin(FAKE_SCENARIOS, { runId })]),
    streamOf([setupEnd("auth", "passed")]),
    streamOf([setupEnd("artifacts", "passed")]),
    ...Array.from({ length: FAKE_SCENARIOS }, (_, i) =>
      streamOf([scenarioEnd(`s${String(i)}`, statusOf(i))]),
    ),
    streamOf([
      runEnd("passed", {
        total: FAKE_SCENARIOS,
        passed: FAKE_SCENARIOS - 1,
        flaky: 1,
      }),
    ]),
  ];
  return {
    exitAfterAppends: true,
    appends: pieces.map((text, i) => ({
      afterMs: (i + 1) * stepMs,
      path: results,
      text,
    })),
  };
}

/**
 * The real `prepareStart`, slowed down on request.
 *
 * @param args - its arguments.
 * @returns what it returns.
 */
export async function prepareStart(
  ...args: Parameters<typeof realPrepareStart>
): ReturnType<typeof realPrepareStart> {
  if (process.env.FAKE_SLOW_PREPARE === "1") {
    process.stderr.write("preparing\n");
    await delay(10_000);
  }
  return realPrepareStart(...args);
}
