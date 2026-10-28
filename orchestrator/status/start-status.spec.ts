import { test, expect } from "@playwright/test";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { fakeCommand, type FakeBehaviour } from "../__fixtures__/fake-suite";
import {
  runBegin,
  runEnd,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import { removeTempDir } from "../../src/common/__fixtures__/temp-dir";
import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import { createPalette } from "../../src/common/terminal/palette";
import type { ProductList } from "../config/product-list";
import type { RunCommands } from "../runs/commands";
import { launchRun } from "../runs/launch";
import type { ShutdownSignal } from "../runs/shutdown";
import { start, type StartProcess } from "../start";
import type { Board } from "./board";
import { renderTable } from "./table";
import { readTail } from "./tail";

/**
 * The status table through the real `start` over the fake suite: real processes writing a results
 * stream as a run goes, the real loop, the real tail on real files. Each table the start hands its
 * sink is rendered plain, as a terminal 80 columns wide would show it.
 *
 * Deterministic under any load: the fake appends each piece of its stream only once a poll has read
 * the one before it (its `gateDir` handshake, opened by the `read` seam), and polls never overlap, so
 * every piece's table is shown before the next piece lands.
 */

const TASK_ID = "bsta";
const CELL = "status@cell";

/** The stand-in product list: BackWPup, with the one cell no sites file has. */
const PRODUCT_LIST = {
  PRODUCTS: [
    {
      name: "backwpup",
      sites: {
        [CELL]: {
          edition: "pro",
          sites: [
            {
              baseURL: "https://status.qa.test",
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

/** A stand-in for `process.stdout`: a pipe that keeps what it is given. */
class PipeStdout {
  readonly writableLength = 0;
  readonly isTTY = false;
  readonly chunks: Buffer[] = [];
  /**
   * Keeps a chunk.
   *
   * @param chunk - the bytes.
   * @param callback - told at once.
   */
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(Buffer.from(chunk));
    callback();
    return true;
  }
  /** Never fails. */
  on(): this {
    return this;
  }
}

/** A stand-in process: its signals emitted by the test. */
class TestProcess extends EventEmitter implements StartProcess {
  readonly pid = 4242;
  readonly env = { PATH: process.env.PATH };
  readonly execPath = process.execPath;
  readonly stdout = new PipeStdout();
  readonly stderr = { write: (): boolean => true };
  /**
   * Sends a signal.
   *
   * @param signal - the signal.
   */
  signal(signal: ShutdownSignal): void {
    this.emit(signal);
  }
}

let root = "";
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-status-"));
});
test.afterEach(() => {
  removeTempDir(root);
});

/** What a start showed. */
interface Shown {
  readonly code: number;
  /** Every table, rendered. */
  readonly tables: string[][];
  /** Each task's STATE, in the order they changed. */
  readonly states: string[];
  /** What the start wrote to its standard output. */
  readonly stdout: string;
}

/** A fake runner, given its results stream's path and its handshake's folder. */
type Runner = (results: string, gateDir: string) => FakeBehaviour;

/**
 * Runs `start` for one task whose runner behaves as `runner` says, against its report folder. Each
 * poll opens the next append's gate once the one before was made before the poll began.
 *
 * @param runner - the fake runner.
 * @param options - `--once`, or a stop with SIGINT once the first cooldown is armed.
 * @returns what it showed.
 */
async function startWith(
  runner: Runner,
  options: { once: boolean },
): Promise<Shown> {
  const gateDir = join(root, "gates");
  await mkdir(gateDir, { recursive: true });
  const pieces = runner("", gateDir).appends?.length ?? 0;
  let next = 0;
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
    }),
    { mode: 0o600 },
  );
  const proc = new TestProcess();
  const tables: string[][] = [];
  const palette = createPalette({ tty: false, color: false, unicode: true });
  const commands = (reportDir: string): RunCommands => ({
    bddgen: fakeCommand({ exitCode: 0 }),
    playwright: fakeCommand(runner(join(reportDir, RESULTS_FILE), gateDir)),
  });
  const code = await start(
    { config, once: options.once },
    {
      process: proc,
      checkout,
      loadProductList: () => Promise.resolve(PRODUCT_LIST),
      cellLocks: join(root, "site-locks"),
      exitWaitMs: 1_000,
      status: {
        pollMs: 20,
        read: async (path, state) => {
          // Checked before the read: a piece made before it began is in what it reads.
          const made =
            next === 0 || existsSync(join(gateDir, `done-${String(next - 1)}`));
          const read = await readTail(path, state);
          if (made && next < pieces) {
            await writeFile(join(gateDir, `go-${String(next)}`), "");
            next += 1;
          }
          return read;
        },
        show: (board: Board) => {
          tables.push(
            renderTable(board, { width: 80, palette, now: new Date() }),
          );
        },
      },
      loop: {
        commandsFor: () => commands(""),
        launch: (launch) =>
          launchRun({
            ...launch,
            commands: commands(launch.identity.reportDir),
          }),
        launchOptions: { pollMs: 20 },
        // The cooldown is never waited: once armed, the orchestrator is stopped.
        timers: {
          setTimeout: () => {
            setImmediate(() => {
              proc.signal("SIGINT");
            });
            return undefined;
          },
          clearTimeout: () => undefined,
        },
      },
    },
  );
  const states: string[] = [];
  for (const table of tables) {
    const row = table.find((line) => line.startsWith(TASK_ID));
    const state = row?.split(/ {2,}/).at(-1) ?? "";
    if (states.at(-1) !== state) states.push(state);
  }
  return {
    code,
    tables,
    states,
    stdout: Buffer.concat(proc.stdout.chunks).toString("utf8"),
  };
}

/**
 * The `RUN_ID` a run's stream names: its report folder's name.
 *
 * @param results - the stream's path.
 * @returns the run's `RUN_ID`.
 */
function runIdOf(results: string): string {
  return basename(dirname(results));
}

/**
 * A runner that writes its stream as a run goes, piece by piece through the handshake: the begin,
 * each setup, two scenarios — one line in two pieces split inside a character —, the end.
 *
 * @param results - the stream's path.
 * @param gateDir - the handshake's folder.
 * @returns the behaviour; exits 0 after the end.
 */
function staged(results: string, gateDir: string): FakeBehaviour {
  const wide = streamOf([scenarioEnd("b", "flaky", { scenario: "復元 👍" })]);
  const cut = wide.indexOf("👍") + 1;
  const pieces = [
    streamOf([runBegin(2, { runId: runIdOf(results) })]),
    streamOf([setupEnd("auth", "passed")]),
    streamOf([setupEnd("artifacts", "passed")]),
    streamOf([scenarioEnd("a", "passed")]),
    wide.slice(0, cut),
    wide.slice(cut),
    streamOf([runEnd("passed", { total: 2, passed: 1, flaky: 1 })]),
  ];
  return {
    gateDir,
    exitAfterAppends: true,
    appends: pieces.map((text) => ({ afterMs: 0, path: results, text })),
  };
}

test.describe("the status table over the fake suite", () => {
  test("shows starting, setup n/m, running, then the cooldown with the last outcome", async () => {
    const shown = await startWith(staged, { once: false });
    expect(shown.code).toBe(130);
    expect(shown.states).toEqual([
      "starting",
      "setup 0/2",
      "setup 1/2",
      "running",
      "ended",
      expect.stringMatching(/^next \d\d:\d\d:\d\d$/) as unknown as string,
      "stopped",
    ]);
    const running = shown.tables.find((table) =>
      table.some((line) => line.includes("2/2 · 1 flaky")),
    );
    expect(running?.[1]).toMatch(
      /^bsta {2}bsta-1 {2}status@cell {2}██████████ 2\/2 · 1 flaky +\d+s {2}running$/,
    );
    const cooling = shown.tables.find((table) =>
      table.some((line) => / next \d/.test(line)),
    );
    expect(cooling?.[1]).toMatch(
      /^bsta {2}— {4}status@cell {2}⚠ flaky · 2 scenarios +\d+s {2}next \d\d:\d\d:\d\d$/,
    );
  });

  test("--once ends `done`; a runner that crashes without run.end ends as the run's outcome says", async () => {
    const crashed = await startWith(
      (results, gateDir) => ({
        gateDir,
        exitAfterAppends: true,
        appends: [
          {
            afterMs: 0,
            path: results,
            text: streamOf([
              runBegin(3, { runId: runIdOf(results) }),
              scenarioEnd("a", "passed"),
            ]),
          },
          { afterMs: 0, path: results, text: '{"v":1,"type":"scen' },
        ],
      }),
      { once: true },
    );
    expect(crashed.code).toBe(1);
    expect(crashed.states).toContain("running");
    expect(crashed.states.at(-1)).toBe("done");
    // A run with no run.end could not tell: an error, its planned scenarios counted.
    expect(crashed.tables.at(-1)?.[1]).toMatch(/✘ error · 3 scenarios/);
  });

  test("a stream that never appears leaves the run starting until it ends", async () => {
    const shown = await startWith(() => ({ runMs: 300 }), { once: true });
    expect(shown.states).toEqual(["starting", "ended", "done"]);
    // `starting` both before the run (no RUN) and with it launched: the run's own row is there.
    expect(
      shown.tables.some((table) =>
        /^bsta {2}bsta-1 {2}status@cell .* starting$/.test(table[1] ?? ""),
      ),
    ).toBe(true);
    expect(shown.tables[0]?.[1]).toMatch(/^bsta {2}— .* starting$/);
  });

  test("the start's standard output is today's lines only: the table is never printed", async () => {
    const shown = await startWith(staged, { once: true });
    expect(shown.stdout).not.toContain("TASK");
    expect(shown.stdout).not.toContain("█");
    for (const line of shown.stdout.trimEnd().split("\n"))
      expect(line).toMatch(/^\d\d:\d\d:\d\d (orchestrator|bsta|log) {2}/);
  });
});
