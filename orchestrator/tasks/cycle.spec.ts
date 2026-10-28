import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FAKE_LINES,
  fakeCommand,
  waitForText,
  type FakeBehaviour,
} from "../__fixtures__/fake-suite";
import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "../__fixtures__/results";
import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import type { RunFinishedEvent } from "../events/run-finished";
import { datatorPayload } from "../notify/datator";
import { runIdentity } from "../runs/identity";
import type { TaskActivity } from "./activity";
import {
  launchRun,
  type LaunchedRun,
  type LaunchOptions,
  type LaunchResult,
} from "../runs/launch";
import {
  createRecordWriter,
  parseRunRecord,
  writeRunRecord,
  type EndedRecord,
  type RunRecord,
  type RunningRecord,
} from "../runs/record";
import { writeJsonAtomic } from "../state/atomic";
import { pruneTaskRuns } from "../state/run-retention";
import {
  runOnce,
  type CycleDeps,
  type CycleTask,
  type RunResult,
} from "./cycle";

/**
 * One run against the fake suite — real processes, real signals, real files — with each dependency
 * replaced where a test makes it fail.
 */

/**
 * A secret the run's environment carries and failures quote: no line, record or event shows it. It
 * has no credential's shape, so only masking by value — the secrets handed in — can hide it.
 */
const SECRET = "storage-Password-Of-No-Shape-0123";

/** When every run starts, unless a test moves the clock. */
const START = Date.parse("2026-10-13T10:15:31.042Z");

/** The task every run belongs to. */
const TASK: CycleTask = {
  id: "bpng",
  name: "BackWPup Pro on nginx",
  product: "backwpup",
  cell: "pro@nginx",
  plugin: { ref: "develop" },
};

/** The checkout and the state directory, fresh per test. */
let checkout: string;
let stateDir: string;
/** Every process group a test's runs started: killed, with whatever they left, as the test ends. */
const groups = new Set<number>();
/** Rejections nobody handled during a test: there must be none. */
let unhandled: unknown[];
/** Records them. */
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};

test.beforeEach(async () => {
  checkout = await mkdtemp(join(tmpdir(), "e2e-cycle-checkout-"));
  // Inside the checkout, as `.orchestrator/` is: the lines show paths from the checkout.
  stateDir = join(checkout, ".orchestrator");
  await mkdir(stateDir, { mode: 0o700 });
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
test.afterEach(async () => {
  // A turn for any rejection still on its way to the handler.
  await delay(50);
  process.off("unhandledRejection", onUnhandled);
  killGroups();
  await rm(checkout, { recursive: true, force: true });
  expect(unhandled).toEqual([]);
});

/**
 * SIGKILLs every group in {@link groups}, then forgets them. A group already gone (`ESRCH`), or no
 * longer ours (`EPERM`), is skipped.
 */
function killGroups(): void {
  for (const pgid of groups) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH" && code !== "EPERM") throw error;
    }
  }
  groups.clear();
}

/**
 * A launch whose process groups are kept in {@link groups}, for the test's end to kill.
 *
 * @param launch - the launch to watch: the real one by default.
 * @returns it, each group it is told of kept before the cycle hears of it.
 */
function tracking(
  launch: (options: LaunchOptions) => Promise<LaunchedRun> = launchRun,
): (options: LaunchOptions) => Promise<LaunchedRun> {
  return (options) =>
    launch({
      ...options,
      onProcess: (name, pgid) => {
        groups.add(pgid);
        return options.onProcess?.(name, pgid);
      },
    });
}

/** What a test sees of a run: its lines, what it published, every record written, in order. */
interface Seen {
  readonly lines: string[];
  readonly published: RunFinishedEvent[];
  readonly records: RunRecord[];
}

/**
 * Deps running the fake suite, with every output watched.
 *
 * @param bddgen - how the fake `bddgen` behaves.
 * @param playwright - how the fake runner behaves.
 * @param more - deps to replace.
 */
function harness(
  bddgen: FakeBehaviour,
  playwright: FakeBehaviour,
  more: Partial<CycleDeps> = {},
): { deps: CycleDeps; seen: Seen } {
  const seen: Seen = { lines: [], published: [], records: [] };
  const deps: CycleDeps = {
    stateDir,
    checkout,
    config: { secrets: { BWP_S3_SECRET: SECRET } },
    secrets: [SECRET],
    inherited: { PATH: process.env.PATH },
    commandsFor: () => ({
      bddgen: fakeCommand(bddgen),
      playwright: fakeCommand(playwright),
    }),
    logger: {
      line: (scope, text) => {
        seen.lines.push(`${scope} ${text}`);
      },
    },
    bus: {
      publish: (event) => {
        seen.published.push(event);
      },
    },
    datatorPayload,
    now: () => new Date(START),
    launchOptions: { pollMs: 20 },
    recordWriter: (path) =>
      createRecordWriter(path, {
        write: async (to, record) => {
          seen.records.push(record);
          await writeRunRecord(to, record);
        },
      }),
    ...more,
    launch: tracking(more.launch),
  };
  return { deps, seen };
}

/**
 * The identity of the task's run with this number, started at `startedAt`.
 *
 * @param number - the run's number.
 * @param startedAt - when it started.
 */
function identityOf(number = 1, startedAt = START) {
  return runIdentity({
    taskId: TASK.id,
    product: TASK.product,
    cell: TASK.cell,
    number,
    startedAt: new Date(startedAt),
    stateDir,
    checkout,
  });
}

/**
 * A runner that writes a results stream and exits as a real one would.
 *
 * @param status - how its one scenario ended.
 * @param number - the run's number, which its report folder is named by.
 * @param startedAt - when the run started.
 */
function runnerWith(
  status: "passed" | "failed",
  number = 1,
  startedAt = START,
): FakeBehaviour {
  const scenario = scenarioEnd(
    "a",
    status,
    status === "failed"
      ? { error: { message: `Expected "Done" ${SECRET}`, where: "step" } }
      : {},
  );
  return {
    exitCode: status === "passed" ? 0 : 1,
    writes: [
      {
        path: join(identityOf(number, startedAt).reportDir, RESULTS_FILE),
        text: streamOf([
          runBegin(1),
          scenario,
          runEnd(status, { total: 1, [status]: 1 }),
        ]),
      },
    ],
  };
}

/**
 * The run's `run.json`, parsed.
 *
 * @param number - the run's number.
 */
async function recordOf(number = 1): Promise<RunRecord> {
  return JSON.parse(
    await readFile(identityOf(number).record, "utf8"),
  ) as RunRecord;
}

/**
 * A file the run keeps beside its record, parsed; `undefined` when it is not there.
 *
 * @param name - the file's name in the run's folder.
 * @returns its content.
 */
async function keptOf(name: string): Promise<unknown> {
  const path = join(identityOf().dir, name);
  return existsSync(path)
    ? (JSON.parse(await readFile(path, "utf8")) as unknown)
    : undefined;
}

/**
 * Narrows a result to a run that ended.
 *
 * @param result - the result.
 */
function ended(result: RunResult): Extract<RunResult, { kind: "ended" }> {
  if (result.kind !== "ended") throw new Error(`no run: ${result.why}`);
  return result;
}

/** Everything a test saw, as one text: what must never hold the secret. */
function everything(seen: Seen): string {
  return JSON.stringify(seen);
}

/**
 * Waits until a record naming the runner's process was written, and the runner says it is ready.
 *
 * @param seen - what the test sees.
 */
async function runnerReady(seen: Seen): Promise<void> {
  const log = identityOf().log;
  for (let i = 0; i < 500; i += 1) {
    const running = seen.records.some(
      (record) =>
        record.state === "running" && record.process?.name === "playwright",
    );
    const text = await readFile(log, "utf8").catch(() => "");
    // `bddgen` exits at once, never ready: the one ready line is the runner's.
    if (running && text.includes(FAKE_LINES.ready)) return;
    await delay(20);
  }
  throw new Error("the runner never became ready");
}

test.describe("runOnce — runs to their end", () => {
  test("names the ref `refFor` plans in the started line", async () => {
    const asked: string[] = [];
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      refFor: (task) => {
        asked.push(task.id);
        return "develop (default)";
      },
    });
    ended(await runOnce(TASK, deps).done);
    expect(asked).toEqual(["bpng"]);
    expect(seen.lines[0]).toBe(
      "bpng bpng-1 started · backwpup pro@nginx · develop (default) · " +
        identityOf().log.slice(checkout.length + 1),
    );
  });

  test("records, tells, publishes and prunes a run that passed, keeping its Datator record", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"));
    const result = ended(await runOnce(TASK, deps).done);
    expect(result).toMatchObject({ id: "bpng-1", status: "passed" });
    expect(result.endedAt.getTime()).toBe(START);

    const record = (await recordOf()) as EndedRecord;
    expect(record.state).toBe("ended");
    expect(record.status).toBe("passed");
    expect(record.reason).toBeNull();
    expect(record.counts).toEqual(result.event?.counts);
    expect(record.bddgen).toEqual({ code: 0, signal: null });
    expect(record.playwright).toEqual({ code: 0, signal: null });
    expect(record).not.toHaveProperty("event");
    // What was written reads back as a run that is over.
    expect(
      parseRunRecord(await readFile(identityOf().record, "utf8"), "bpng-1")
        .kind,
    ).toBe("over");
    // Beside it, the event published and the Datator record it was sent: owner-only.
    expect(await keptOf("run-finished.json")).toEqual(result.event);
    if (result.event === undefined) throw new Error("expected the event");
    const posted = await keptOf("datator.json");
    expect(posted).toEqual(datatorPayload(result.event));
    expect(posted).toMatchObject({ total_tests: 1 });
    for (const name of ["run-finished.json", "datator.json"])
      expect((await stat(join(identityOf().dir, name))).mode & 0o777).toBe(
        0o600,
      );

    // A record before each process, one once it runs, then the end: in that order.
    expect(
      seen.records.map((r) =>
        r.state === "running"
          ? `${r.starting ?? "-"}/${r.process?.name ?? "-"}`
          : r.state,
      ),
    ).toEqual([
      "bddgen/-",
      "-/bddgen",
      "playwright/-",
      "-/playwright",
      "ended",
    ]);
    const running = seen.records[1] as RunningRecord;
    expect(running.process?.pgid).toBeGreaterThan(1);
    expect(running.process?.leaderStart).toBeDefined();

    expect(seen.published).toHaveLength(1);
    expect(seen.published[0]).toBe(result.event);
    expect(seen.published[0]?.run.task.id).toBe("bpng");
    expect(seen.published[0]?.plugin.requestedRef).toBe("develop");
    expect(seen.lines).toEqual([
      "bpng bpng-1 started · backwpup pro@nginx · develop · " +
        identityOf().log.slice(checkout.length + 1),
      `bpng bpng-1 ✔ passed · 1 scenario: 1 passed · 0s · ${identityOf().reportDir.slice(checkout.length + 1)}`,
    ]);
    // The counter saved the number.
    expect(
      JSON.parse(await readFile(join(stateDir, "tasks", "bpng.json"), "utf8")),
    ).toEqual({ v: 1, lastRun: 1 });
  });

  test("keeps a run's end before telling it: run-finished.json, datator.json, the ended record, the outcome line, the event, then pruning", async () => {
    const order: string[] = [];
    const { deps } = harness({ exitCode: 0 }, runnerWith("passed"), {
      writeJson: async (path, value) => {
        order.push(`file ${basename(path)}`);
        await writeJsonAtomic(path, value);
      },
      recordWriter: (path) =>
        createRecordWriter(path, {
          write: async (to, record) => {
            if (record.state === "ended") order.push("record ended");
            await writeRunRecord(to, record);
          },
        }),
      logger: {
        line: (_scope, text) => {
          if (text.startsWith("bpng-1 ✔ passed")) order.push("outcome line");
        },
      },
      bus: {
        publish: () => {
          order.push("publish");
        },
      },
      prune: (input) => {
        order.push("prune");
        return pruneTaskRuns(input);
      },
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect(order).toEqual([
      "file run-finished.json",
      "file datator.json",
      "record ended",
      "outcome line",
      "publish",
      "prune",
    ]);
  });

  test("records a failed run with its Datator record, its error masked everywhere", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("failed"));
    expect(ended(await runOnce(TASK, deps).done).status).toBe("failed");
    const record = (await recordOf()) as EndedRecord;
    expect(record.status).toBe("failed");
    expect(await keptOf("datator.json")).toMatchObject({
      failed_tests: 1,
      test_cases: [{ status: "failed" }],
    });
    expect(seen.lines[1]).toMatch(
      /^bpng bpng-1 ✘ failed · 1 scenario: 1 failed · /,
    );
    expect(JSON.stringify(record)).not.toContain(SECRET);
    expect(JSON.stringify(await keptOf("run-finished.json"))).not.toContain(
      SECRET,
    );
    expect(JSON.stringify(await keptOf("datator.json"))).not.toContain(SECRET);
    expect(everything(seen)).not.toContain(SECRET);
  });

  test("records a run whose bddgen failed as an error, never starting the runner nor recording Datator", async () => {
    const envFile = join(checkout, "runner-env.json");
    const { deps, seen } = harness({ exitCode: 3 }, { exitCode: 0, envFile });
    const result = ended(await runOnce(TASK, deps).done);
    expect(result.status).toBe("error");
    const record = (await recordOf()) as EndedRecord;
    expect(record.reason).toMatch(/^bddgen exited with code 3/);
    expect(record.playwright).toBeUndefined();
    expect(await keptOf("run-finished.json")).toMatchObject({
      status: "error",
    });
    expect(await keptOf("datator.json")).toBeUndefined();
    expect(existsSync(envFile)).toBe(false);
    expect(seen.lines[1]).toMatch(
      /^bpng bpng-1 ✘ error · bddgen exited with code 3.* · 0s · \.orchestrator\/runs\/bpng-1\/run\.log$/,
    );
    expect(seen.published.map((event) => event.status)).toEqual(["error"]);
  });

  test("numbers runs one after another and prunes the task's older run folders, never the run's own", async () => {
    let clock = START;
    const { deps, seen } = harness(
      { exitCode: 3 },
      {},
      {
        config: { runs: { reportsKeep: 1 }, secrets: {} },
        now: () => new Date(clock),
      },
    );
    expect(ended(await runOnce(TASK, deps).done).id).toBe("bpng-1");
    clock += 60_000;
    expect(ended(await runOnce(TASK, deps).done).id).toBe("bpng-2");
    expect(await readdir(join(stateDir, "runs"))).toEqual(["bpng-2"]);
    expect(
      seen.lines.some((line) => line.startsWith("bpng pruned 1 run folder")),
    ).toBe(true);
  });

  test("hands the prune the run's own folder, the cap and the time", async () => {
    const calls: unknown[] = [];
    const { deps } = harness(
      { exitCode: 3 },
      {},
      {
        config: { runs: { reportsKeep: 7 }, secrets: {} },
        prune: (input) => {
          calls.push(input);
          return pruneTaskRuns(input);
        },
      },
    );
    await runOnce(TASK, deps).done;
    expect(calls).toEqual([
      {
        stateDir,
        taskId: "bpng",
        keep: 7,
        current: identityOf().dir,
        now: START,
      },
    ]);
  });

  test("gives the run its environment from the allowlist, the stop file and the secrets", async () => {
    const envFile = join(checkout, "bddgen-env.json");
    const { deps } = harness(
      { exitCode: 3, envFile },
      {},
      {
        inherited: { PATH: process.env.PATH, SHELL_ONLY: "x" },
      },
    );
    await runOnce(TASK, deps).done;
    const names = JSON.parse(await readFile(envFile, "utf8")) as string[];
    expect(names).toEqual(
      expect.arrayContaining([
        "E2E_CELL",
        "E2E_INTERNAL_STOP_FILE",
        "E2E_LOAD_DOTENV",
        "E2E_PLUGIN_REF",
        "BWP_S3_SECRET",
        "RUN_ID",
      ]),
    );
    expect(names).not.toContain("SHELL_ONLY");
  });
});

test.describe("runOnce — stopped at each stage", () => {
  test("tells onActivity each run's begin — id, report folder, start — never one a stop kept from starting", async () => {
    const told: TaskActivity[] = [];
    const { deps } = harness(
      { exitCode: 1 },
      {},
      {
        onActivity: (activity) => {
          told.push(activity);
        },
      },
    );
    await runOnce(TASK, deps).done;
    const stopped = runOnce(TASK, deps);
    stopped.stop("drained", "stop");
    await stopped.done;
    const identity = identityOf(1);
    expect(told.filter((a) => a.kind === "begun")).toEqual([
      {
        kind: "begun",
        taskId: "bpng",
        id: "bpng-1",
        runId: identity.runId,
        reportDir: identity.reportDir,
        startedAt: new Date(START),
      },
    ]);
    // A run that never began tells nothing at all: no begin, no stop, no end.
    expect(told.map((a) => a.kind)).toEqual(["begun", "ended"]);
  });

  test("the begin is told before the launch", async () => {
    const begun: string[] = [];
    const seenAtLaunch: string[][] = [];
    const { deps } = harness(
      {},
      {},
      {
        onActivity: (activity) => {
          if (activity.kind === "begun") begun.push(activity.id);
        },
        launch: () => {
          seenAtLaunch.push([...begun]);
          return Promise.reject(new Error("no launch here"));
        },
      },
    );
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(seenAtLaunch).toEqual([["bpng-1"]]);
  });

  test("an onActivity that throws is a line per activity, and the run goes on", async () => {
    const { deps, seen } = harness(
      { exitCode: 1 },
      {},
      {
        onActivity: () => {
          throw new Error(`hook broke ${SECRET}`);
        },
      },
    );
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(seen.lines).toContain(
      "bpng bpng-1: telling that it began failed: hook broke ***",
    );
    expect(seen.lines).toContain(
      "bpng bpng-1: telling that it ended failed: hook broke ***",
    );
  });

  test("tells the end of a run with its status, end and scenarios — once, whichever way it ended", async () => {
    const told: TaskActivity[] = [];
    // A clock that moves at each reading: the end told is the run's, not the time it is told.
    let tick = 0;
    const { deps } = harness({ exitCode: 0 }, runnerWith("passed"), {
      now: () => new Date(START + 1_000 * tick++),
      onActivity: (activity) => {
        told.push(activity);
      },
    });
    const result = ended(await runOnce(TASK, deps).done);
    const ends = told.filter((a) => a.kind === "ended");
    expect(ends).toEqual([
      {
        kind: "ended",
        taskId: "bpng",
        id: "bpng-1",
        status: result.status,
        endedAt: result.endedAt,
        scenarios: 1,
      },
    ]);
    expect(result.status).toBe("passed");
    expect(result.endedAt.getTime()).toBeLessThan(START + 1_000 * tick - 1_000);
  });

  test("a cycle that fails after the begin tells its end at once: error, ended now, no scenarios", async () => {
    const told: TaskActivity[] = [];
    const at = { ms: START };
    const { deps, seen } = harness(
      {},
      {},
      {
        now: () => new Date(at.ms),
        onActivity: (activity) => {
          told.push(activity);
          if (activity.kind === "begun") at.ms = START + 42_000;
        },
        // Throws outside every guard of the launch: the cycle itself fails.
        recordWriter: () => {
          throw new Error("no writer");
        },
      },
    );
    expect(await runOnce(TASK, deps).done).toEqual({
      kind: "notStarted",
      why: "failed",
    });
    expect(
      seen.lines.some((l) => l.includes("the run failed: no writer")),
    ).toBe(true);
    expect(told.map((a) => a.kind)).toEqual(["begun", "ended"]);
    expect(told[1]).toEqual({
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "error",
      endedAt: new Date(START + 42_000),
    });
  });

  test("a stop's level told is the one in force: a lesser stop after a greater does not lower it", async () => {
    const told: TaskActivity[] = [];
    const { deps } = harness(
      { runMs: 30_000 },
      {},
      {
        onActivity: (activity) => {
          told.push(activity);
        },
      },
    );
    const run = runOnce(TASK, deps);
    await expect.poll(() => told.some((a) => a.kind === "begun")).toBe(true);
    run.stop("interrupted", "first");
    run.stop("drained", "lesser");
    await run.done;
    expect(
      told.flatMap((a) => (a.kind === "stopping" ? [a.level] : [])),
    ).toEqual(["interrupted", "interrupted"]);
  });

  test("an onActivity whose promise rejects is a line, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const { deps, seen } = harness(
        { exitCode: 1 },
        {},
        {
          onActivity: (() =>
            Promise.reject(
              new Error(`async hook broke ${SECRET}`),
            )) as unknown as CycleDeps["onActivity"],
        },
      );
      await runOnce(TASK, deps).done;
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen.lines).toContain(
        "bpng bpng-1: telling that it began failed: async hook broke ***",
      );
      expect(seen.lines).toContain(
        "bpng bpng-1: telling that it ended failed: async hook broke ***",
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("tells each stop that reaches a run that began, and none once it ended", async () => {
    const told: TaskActivity[] = [];
    const { deps } = harness(
      { runMs: 30_000 },
      {},
      {
        onActivity: (activity) => {
          told.push(activity);
        },
      },
    );
    const run = runOnce(TASK, deps);
    await expect.poll(() => told.some((a) => a.kind === "begun")).toBe(true);
    run.stop("drained", "first");
    run.stop("interrupted", "second");
    await run.done;
    run.stop("killed", "too late");
    expect(
      told.flatMap((a) => (a.kind === "stopping" ? [a.level] : [])),
    ).toEqual(["drained", "interrupted"]);
    expect(told.at(-1)?.kind).toBe("ended");
  });

  test("a stop asked as the handle is given starts nothing, not even a number", async () => {
    const { deps, seen } = harness({}, {});
    const run = runOnce(TASK, deps);
    run.stop("drained", "the orchestrator was stopped (SIGINT)");
    expect(await run.done).toEqual({ kind: "notStarted", why: "stopped" });
    expect(existsSync(join(stateDir, "tasks", "bpng.json"))).toBe(false);
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
    expect(seen.published).toEqual([]);
  });

  test("a stop while the number is taken spends it and starts nothing", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, seen } = harness(
      {},
      {},
      {
        nextNumber: async () => {
          await gate;
          return 4;
        },
      },
    );
    const run = runOnce(TASK, deps);
    await delay(20);
    run.stop("drained", "stopping");
    release();
    expect(await run.done).toEqual({ kind: "notStarted", why: "stopped" });
    expect(seen.lines).toEqual(["bpng bpng-4 not started: stopping"]);
    expect(existsSync(join(stateDir, "runs"))).toBe(false);
  });

  test("a stop while the first record is written spawns nothing, and the run is recorded and announced stopped", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, seen } = harness(
      { runMs: 60_000 },
      {},
      {
        recordWriter: (path) => {
          let first = true;
          return createRecordWriter(path, {
            write: async (to, record) => {
              seen.records.push(record);
              if (first) {
                first = false;
                await gate;
              }
              await writeRunRecord(to, record);
            },
          });
        },
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && seen.records.length === 0; i += 1)
      await delay(10);
    run.stop("drained", "stopped before the spawn");
    release();
    const result = ended(await run.done);
    expect(result.status).toBe("stopped");
    const record = (await recordOf()) as EndedRecord;
    expect(record.stop).toEqual({
      level: "drained",
      why: "stopped before the spawn",
    });
    expect(record.reason).toBe("stopped before the spawn");
    // Never spawned: no exit, and the log holds none of the launch's lines.
    expect(record.bddgen).toEqual({ code: null, signal: null });
    expect(record.playwright).toBeUndefined();
    expect(await readFile(identityOf().log, "utf8")).toBe("");
    expect(
      seen.records.map((r) => (r.state === "running" ? r.starting : r.state)),
    ).toEqual(["bddgen", "ended"]);
    expect(seen.published.map((event) => event.status)).toEqual(["stopped"]);
    expect(seen.lines).toEqual([
      `bpng bpng-1 ■ stopped · stopped before the spawn · 0s · ${identityOf().log.slice(checkout.length + 1)}`,
    ]);
  });

  test("of stops asked before bddgen is spawned, the furthest is taken, with its reason, and none is carried out", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, seen } = harness(
      { runMs: 60_000 },
      {},
      {
        // The first record waits: the launch cannot hand out the run before it is released.
        recordWriter: (path) => {
          let first = true;
          return createRecordWriter(path, {
            write: async (to, record) => {
              seen.records.push(record);
              if (first) {
                first = false;
                await gate;
              }
              await writeRunRecord(to, record);
            },
          });
        },
        launch: async (options) => {
          const launched = await launchRun(options);
          return {
            stop: (level, why) => {
              seen.lines.push(`forwarded ${level}: ${why}`);
              launched.stop(level, why);
            },
            done: launched.done,
          };
        },
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && seen.records.length === 0; i += 1)
      await delay(10);
    run.stop("killed", "third Ctrl-C");
    run.stop("drained", "a later, lesser stop");
    release();
    expect(ended(await run.done).status).toBe("stopped");
    // Nothing was launched, so nothing to forward a stop to.
    expect(seen.lines.filter((line) => line.startsWith("forwarded"))).toEqual(
      [],
    );
    // Taken as the stop machine takes any stop before a process runs: a drain, with its reason.
    expect(((await recordOf()) as EndedRecord).stop).toEqual({
      level: "drained",
      why: "third Ctrl-C",
    });
  });

  /** A stop's reason as no line may carry it: a secret, a line feed, a terminal code, past its cap. */
  const RAW_WHY = `first\n\u001b[31m${SECRET} ${"x".repeat(600)}`;

  /**
   * Checks the stop's reason everywhere the run keeps or says it: masked, one line, within its cap.
   *
   * @param result - the run's result.
   * @param seen - what the test saw.
   */
  async function expectSafeWhy(result: RunResult, seen: Seen): Promise<void> {
    const record = (await recordOf()) as EndedRecord;
    const finished = (await keptOf("run-finished.json")) as RunFinishedEvent;
    const whys = [
      ended(result).event?.reason,
      record.reason,
      record.stop.level === "none" ? undefined : record.stop.why,
      finished.reason,
    ];
    for (const why of whys) {
      expect(why).toMatch(/^first \*\*\* x+…$/);
      expect(Array.from(why ?? "")).toHaveLength(500);
    }
    // The outcome line quotes that reason, whole, on one line, the secret nowhere.
    expect(
      seen.lines.some((line) => line.includes(` · ${record.reason ?? ""} · `)),
    ).toBe(true);
    for (const line of seen.lines) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain("\n");
      expect(line).not.toContain("\u001b");
    }
    expect(await readFile(identityOf().log, "utf8")).not.toContain(SECRET);
  }

  test("a stop's reason is masked, one line and within its cap, when the stop keeps bddgen from spawning", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, seen } = harness(
      { runMs: 60_000 },
      {},
      {
        recordWriter: (path) => {
          let first = true;
          return createRecordWriter(path, {
            write: async (to, record) => {
              seen.records.push(record);
              if (first) {
                first = false;
                await gate;
              }
              await writeRunRecord(to, record);
            },
          });
        },
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && seen.records.length === 0; i += 1)
      await delay(10);
    run.stop("drained", RAW_WHY);
    release();
    const result = await run.done;
    expect(ended(result).status).toBe("stopped");
    await expectSafeWhy(result, seen);
  });

  test("a stop's reason is masked, one line and within its cap, when the stop kills bddgen", async () => {
    const { deps, seen } = harness({ runMs: 60_000 }, { exitCode: 0 });
    const run = runOnce(TASK, deps);
    await waitForText(identityOf().log, FAKE_LINES.ready);
    run.stop("drained", RAW_WHY);
    const result = await run.done;
    expect(ended(result).status).toBe("stopped");
    await expectSafeWhy(result, seen);
  });

  test("a stop asked while the first record is written, which then fails, is a run that could not start", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { deps, seen } = harness(
      { exitCode: 0 },
      {},
      {
        recordWriter: (path) => {
          let first = true;
          return createRecordWriter(path, {
            write: async (to, record) => {
              seen.records.push(record);
              if (first) {
                first = false;
                await gate;
                throw new Error("ENOSPC");
              }
              await writeRunRecord(to, record);
            },
          });
        },
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && seen.records.length === 0; i += 1)
      await delay(10);
    run.stop("drained", "stopped meanwhile");
    release();
    const result = ended(await run.done);
    expect(result.status).toBe("error");
    expect(result.event?.reason).toMatch(/^the run could not start: /);
  });

  test("a stop during bddgen kills it, never starts the runner, and records the run stopped", async () => {
    const { deps, seen } = harness({ runMs: 60_000 }, { exitCode: 0 });
    const run = runOnce(TASK, deps);
    await waitForText(identityOf().log, FAKE_LINES.ready);
    run.stop("drained", "the orchestrator was stopped (SIGINT)");
    const result = ended(await run.done);
    expect(result.status).toBe("stopped");
    const record = (await recordOf()) as EndedRecord;
    expect(record.playwright).toBeUndefined();
    expect(record.reason).toBe("the orchestrator was stopped (SIGINT)");
    expect(seen.lines[1]).toMatch(
      /^bpng bpng-1 ■ stopped · the orchestrator was stopped/,
    );
  });

  // An interrupt drains first: the fake may see the stop file and exit 0 before the SIGINT lands.
  for (const [level, status, exits] of [
    ["drained", "stopped", [{ code: 0, signal: null }]],
    [
      "interrupted",
      "stopped",
      [
        { code: 130, signal: null },
        { code: 0, signal: null },
      ],
    ],
    ["killed", "killed", [{ code: null, signal: "SIGKILL" }]],
  ] as const)
    test(`a stop during the runner, ${level}, is carried out and recorded ${status}`, async () => {
      const { deps, seen } = harness({ exitCode: 0 }, { runMs: 60_000 });
      const run = runOnce(TASK, deps);
      await runnerReady(seen);
      run.stop(level, `asked: ${level}`);
      const result = ended(await run.done);
      expect(result.status).toBe(status);
      const record = (await recordOf()) as EndedRecord;
      expect(exits).toContainEqual(record.playwright);
      expect(record.stop).toEqual({ level, why: `asked: ${level}` });
      expect(seen.published.map((event) => event.status)).toEqual([status]);
    });

  test("a stop asked after bddgen's spawn is allowed but before the launch hands out the run reaches the run", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // An object: a flag the launch sets in a closure would read as always false here.
    const gap = { reached: false };
    const forwarded: string[] = [];
    const { deps } = harness(
      {},
      {},
      {
        launch: async (options) => {
          await mkdir(options.identity.dir, { recursive: true });
          await options.onSpawning?.("bddgen");
          // Past the last check before the spawn, the run not yet handed out: a real async gap.
          gap.reached = true;
          await gate;
          return {
            stop: (level, why) => {
              forwarded.push(`${level}: ${why}`);
            },
            done: Promise.resolve<LaunchResult>({
              bddgen: { code: 0, signal: null },
              stop: { level: "none" },
            }),
          };
        },
        end: () => Promise.reject(new Error("unread")),
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && !gap.reached; i += 1) await delay(10);
    expect(gap.reached).toBe(true);
    run.stop("drained", "Ctrl-C");
    release();
    await run.done;
    expect(forwarded).toEqual(["drained: Ctrl-C"]);
  });

  test("a stop that goes no further than one before changes nothing", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, { runMs: 60_000 });
    const run = runOnce(TASK, deps);
    await runnerReady(seen);
    run.stop("interrupted", "first");
    run.stop("drained", "second");
    await run.done;
    expect(((await recordOf()) as EndedRecord).stop).toEqual({
      level: "interrupted",
      why: "first",
    });
  });

  test("a stop once the run has ended does nothing", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"));
    const run = runOnce(TASK, deps);
    const result = await run.done;
    const before = await readFile(identityOf().record, "utf8");
    run.stop("killed", "too late");
    await delay(100);
    expect(await run.done).toBe(result);
    expect(await readFile(identityOf().record, "utf8")).toBe(before);
    expect(seen.published).toHaveLength(1);
  });
});

test.describe("runOnce — a dependency that fails is said, and the run still recorded", () => {
  /** Lines that quote a failure: masked, every one. */
  function expectMasked(seen: Seen): void {
    expect(everything(seen)).not.toContain(SECRET);
  }

  test("a counter that fails starts no run and says why", async () => {
    const { deps, seen } = harness(
      {},
      {},
      {
        nextNumber: () => Promise.reject(new Error(`EACCES ${SECRET}`)),
      },
    );
    expect(await runOnce(TASK, deps).done).toEqual({
      kind: "notStarted",
      why: "failed",
    });
    expect(seen.lines).toEqual([
      "bpng no run started: its number could not be taken: EACCES ***",
    ]);
    expectMasked(seen);
    expect(seen.published).toEqual([]);
  });

  test("a first record that cannot be written spawns nothing, and the run is recorded and announced as an error", async () => {
    const envFile = join(checkout, "bddgen-env.json");
    let calls = 0;
    const { deps, seen } = harness(
      { exitCode: 0, envFile },
      {},
      {
        recordWriter: (path) =>
          createRecordWriter(path, {
            write: async (to, record) => {
              calls += 1;
              seen.records.push(record);
              if (calls === 1) throw new Error(`ENOSPC ${SECRET}`);
              await writeRunRecord(to, record);
            },
          }),
      },
    );
    const result = ended(await runOnce(TASK, deps).done);
    expect(result.status).toBe("error");
    expect(existsSync(envFile)).toBe(false);
    const record = (await recordOf()) as EndedRecord;
    expect(record.state).toBe("ended");
    expect(record.reason).toMatch(/^the run could not start: /);
    expect(record.bddgen).toEqual({ code: null, signal: null });
    expect(seen.lines[0]).toBe(
      "bpng bpng-1: recording that bddgen starts failed: ENOSPC ***",
    );
    expect(seen.lines[1]).toMatch(/^bpng bpng-1 could not start: /);
    expect(seen.published.map((event) => event.status)).toEqual(["error"]);
    expectMasked(seen);
  });

  test("a running record that cannot be written is said, and the run goes on to its end", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      recordWriter: (path) =>
        createRecordWriter(path, {
          write: async (to, record) => {
            if (record.state === "running" && record.process !== undefined)
              throw new Error(`EIO ${SECRET}`);
            await writeRunRecord(to, record);
          },
        }),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect((await recordOf()).state).toBe("ended");
    expect(seen.lines).toContain(
      "bpng bpng-1: recording bddgen's process failed: EIO ***",
    );
    expect(seen.lines).toContain(
      "bpng bpng-1: recording playwright's process failed: EIO ***",
    );
    expectMasked(seen);
  });

  test("an ended record that cannot be written is said, and the run is still told and announced", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      recordWriter: (path) =>
        createRecordWriter(path, {
          write: async (to, record) => {
            if (record.state === "ended") throw new Error(`EROFS ${SECRET}`);
            await writeRunRecord(to, record);
          },
        }),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect(seen.lines).toContain(
      "bpng bpng-1's end could not be recorded: EROFS ***",
    );
    expect(seen.lines.some((line) => line.includes("✔ passed"))).toBe(true);
    expect(seen.published).toHaveLength(1);
    expectMasked(seen);
  });

  test("files beside the record that cannot be written are said, and the ended record still written after them", async () => {
    const order: string[] = [];
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      writeJson: (path) => {
        order.push(basename(path));
        return Promise.reject(new Error(`EROFS ${SECRET}`));
      },
      recordWriter: (path) =>
        createRecordWriter(path, {
          write: async (to, record) => {
            order.push(record.state);
            await writeRunRecord(to, record);
          },
        }),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect(order.slice(-3)).toEqual([
      "run-finished.json",
      "datator.json",
      "ended",
    ]);
    expect((await recordOf()).state).toBe("ended");
    expect(seen.lines).toContain(
      "bpng bpng-1's run-finished.json could not be written: EROFS ***",
    );
    expect(seen.lines).toContain(
      "bpng bpng-1's datator.json could not be written: EROFS ***",
    );
    expect(seen.published).toHaveLength(1);
    expectMasked(seen);
  });

  test("a leader's start unread for a long, non-ASCII reason still leaves a record that reads back as running", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      readLeaderStart: () =>
        Promise.reject(new Error(`${"ü".repeat(400)} ${SECRET}`)),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    const running = seen.records.filter(
      (record) => record.state === "running" && record.process !== undefined,
    );
    expect(running).toHaveLength(2);
    for (const record of running)
      expect(parseRunRecord(JSON.stringify(record), "bpng-1").kind).toBe(
        "running",
      );
    expectMasked(seen);
  });

  test("a leader's start that cannot be read is recorded as unread, with why", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      readLeaderStart: () => Promise.reject(new Error(`EPERM ${SECRET}`)),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    const running = seen.records.filter(
      (record): record is RunningRecord =>
        record.state === "running" && record.process !== undefined,
    );
    expect(running.map((record) => record.process?.leaderStartUnread)).toEqual([
      "EPERM ***",
      "EPERM ***",
    ]);
    expect(running.every((record) => record.process?.pgid !== undefined)).toBe(
      true,
    );
    expect(seen.lines).toContain(
      "bpng bpng-1: bddgen's start could not be read: EPERM ***",
    );
    expect((await recordOf()).state).toBe("ended");
    expectMasked(seen);
  });

  test("a Datator record that cannot be built is said, and the run recorded without it", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      datatorPayload: () => {
        throw new Error(`bad ${SECRET}`);
      },
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect((await recordOf()).state).toBe("ended");
    expect(await keptOf("datator.json")).toBeUndefined();
    expect(await keptOf("run-finished.json")).toMatchObject({
      status: "passed",
    });
    expect(seen.lines).toContain(
      "bpng bpng-1's Datator record could not be built: bad ***",
    );
    expect(seen.published).toHaveLength(1);
    expectMasked(seen);
  });

  test("a publish that throws is said, and the run still pruned and ended", async () => {
    let pruned = 0;
    const { deps, seen } = harness(
      { exitCode: 3 },
      {},
      {
        bus: {
          publish: () => {
            throw new Error(`bus ${SECRET}`);
          },
        },
        prune: (input) => {
          pruned += 1;
          return pruneTaskRuns(input);
        },
      },
    );
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(pruned).toBe(1);
    expect(seen.lines).toContain(
      "bpng bpng-1's run.finished could not be published: bus ***",
    );
    expect((await recordOf()).state).toBe("ended");
    expectMasked(seen);
  });

  for (const how of ["rejects", "throws"] as const)
    test(`a prune that ${how} is said, and the run still ends`, async () => {
      const failure = new Error(`prune ${SECRET}`);
      const { deps, seen } = harness(
        { exitCode: 3 },
        {},
        {
          prune:
            how === "rejects"
              ? () => Promise.reject(failure)
              : () => {
                  throw failure;
                },
        },
      );
      expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
      expect(seen.lines).toContain(
        "bpng bpng-1: pruning the task's run folders failed: prune ***",
      );
      expect((await recordOf()).state).toBe("ended");
      expectMasked(seen);
    });

  test("a logger that throws on every line loses the lines, never the run", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      logger: {
        line: () => {
          throw new Error("EPIPE");
        },
      },
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect((await recordOf()).state).toBe("ended");
    expect(seen.published).toHaveLength(1);
  });

  test("an end that cannot be read is said, and the run recorded as an error from how it ended", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      end: () => Promise.reject(new Error(`EMFILE ${SECRET}`)),
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    const record = (await recordOf()) as EndedRecord;
    expect(record.reason).toBe("its end could not be read: EMFILE ***");
    expect(record.playwright).toEqual({ code: 0, signal: null });
    expect(seen.lines).toContain(
      "bpng bpng-1's end could not be read: EMFILE ***",
    );
    expect(seen.published.map((event) => event.status)).toEqual(["error"]);
    expectMasked(seen);
  });

  test("an end that cannot be read of a run that was killed is recorded killed", async () => {
    const { deps, seen } = harness(
      { exitCode: 0 },
      { runMs: 60_000 },
      {
        end: () => Promise.reject(new Error("EMFILE")),
      },
    );
    const run = runOnce(TASK, deps);
    await runnerReady(seen);
    run.stop("killed", "third Ctrl-C");
    expect(ended(await run.done).status).toBe("killed");
    expect(((await recordOf()) as EndedRecord).reason).toBe("third Ctrl-C");
  });

  test("a launch refused before the run's folder is its own records nothing there, and announces an error", async () => {
    const { deps, seen } = harness(
      {},
      {},
      {
        launch: () =>
          Promise.reject(
            new Error(`the run's folder is already there ${SECRET}`),
          ),
      },
    );
    const result = ended(await runOnce(TASK, deps).done);
    expect(result.status).toBe("error");
    expect(seen.records).toEqual([]);
    expect(existsSync(identityOf().record)).toBe(false);
    expect(seen.published[0]?.reason).toBe(
      "the run could not start: the run's folder is already there ***",
    );
    expect(seen.lines[0]).toBe(
      "bpng bpng-1 could not start: the run's folder is already there ***",
    );
    expectMasked(seen);
  });

  test("a launch that fails after making the run's folder leaves no folder behind, which retention could never date", async () => {
    const { deps, seen } = harness(
      {},
      {},
      {
        // The real launch, its log made impossible: it fails once its folder is made.
        launch: (options) =>
          launchRun({
            ...options,
            identity: {
              ...options.identity,
              log: join(options.identity.dir, "missing", "run.log"),
            },
          }),
      },
    );
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(seen.records).toEqual([]);
    expect(await readdir(join(stateDir, "runs"))).toEqual([]);
    expect(seen.published.map((event) => event.status)).toEqual(["error"]);
  });

  test("a run.finished that cannot be built is said, and the task's run folders still pruned", async () => {
    const pruned: unknown[] = [];
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      end: () => Promise.reject(new Error("unread")),
      buildEvent: () => {
        throw new Error(`build ${SECRET}`);
      },
      prune: (input) => {
        pruned.push(input.current);
        return pruneTaskRuns(input);
      },
    });
    const result = await runOnce(TASK, deps).done;
    expect(result).toEqual({
      kind: "ended",
      id: "bpng-1",
      status: "error",
      endedAt: new Date(START),
    });
    expect(pruned).toEqual([identityOf().dir]);
    expect(seen.lines).toContain(
      "bpng bpng-1's run.finished could not be built: build ***",
    );
    expect(seen.published).toEqual([]);
    expectMasked(seen);
  });

  test("commands that cannot be made start nothing, and the run is announced as an error", async () => {
    const { deps, seen } = harness(
      {},
      {},
      {
        commandsFor: () => {
          throw new Error("no such product");
        },
      },
    );
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(seen.records).toEqual([]);
    expect(seen.published[0]?.reason).toBe(
      "the run could not start: no such product",
    );
  });

  test("a run that cannot be watched to its end keeps its running record, for the orphan check", async () => {
    let clock = START;
    const { deps, seen } = harness(
      {},
      {},
      {
        now: () => new Date(clock),
        launch: async (options) => {
          await mkdir(options.identity.dir, { recursive: true });
          await options.onSpawning?.("bddgen");
          await options.onProcess?.("bddgen", 4242);
          clock += 5_000;
          return {
            stop: () => undefined,
            done: Promise.reject(new Error(`watch ${SECRET}`)),
          };
        },
        readLeaderStart: () => Promise.resolve({ kind: "gone" }),
      },
    );
    const result = ended(await runOnce(TASK, deps).done);
    expect(result.status).toBe("error");
    // When it was found unwatchable, by the clock: a loop's cooldown counts from here.
    expect(result.endedAt.getTime()).toBe(START + 5_000);
    expect(seen.records.map((record) => record.state)).toEqual([
      "running",
      "running",
    ]);
    // Nothing beside the record either: its processes may still run.
    expect(await keptOf("run-finished.json")).toBeUndefined();
    expect(seen.published[0]?.reason).toBe(
      "the run could not be watched to its end: watch ***",
    );
    expectMasked(seen);
  });

  test("a stop that the launched run throws on is said, never thrown", async () => {
    const launched: LaunchResult = {
      bddgen: { code: 0, signal: null },
      stop: { level: "none" },
    };
    let finish: (result: LaunchResult) => void = () => undefined;
    const { deps, seen } = harness(
      {},
      {},
      {
        launch: async (options) => {
          await mkdir(options.identity.dir, { recursive: true });
          await options.onSpawning?.("bddgen");
          return {
            stop: () => {
              throw new Error("ESRCH");
            },
            done: new Promise<LaunchResult>((resolve) => {
              finish = resolve;
            }),
          };
        },
        end: () => Promise.reject(new Error("unread")),
      },
    );
    const run = runOnce(TASK, deps);
    for (let i = 0; i < 200 && seen.lines.length === 0; i += 1) await delay(10);
    expect(() => {
      run.stop("killed", "now");
    }).not.toThrow();
    finish(launched);
    await run.done;
    expect(seen.lines).toContain("bpng stopping the run failed: ESRCH");
  });
});

test.describe("runOnce — the cell's site locks, which its loop holds", () => {
  /**
   * A stand-in `claimCell`: each claim said with whether the run's folder existed yet.
   *
   * @param events - where the claims go.
   * @param answer - what it resolves to — `undefined` once named, else why not — or an error to
   *   reject with.
   * @returns it.
   */
  function claimCell(
    events: string[],
    answer?: string | Error,
  ): NonNullable<CycleDeps["claimCell"]> {
    return (record) => {
      events.push(
        `claim ${basename(join(record, ".."))} folder:${String(existsSync(join(record, "..")))}`,
      );
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    };
  }

  test("names the run's record in them before anything is launched", async () => {
    const events: string[] = [];
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      claimCell: claimCell(events),
      bus: {
        publish: (event) => {
          seen.published.push(event);
          events.push(`published ${event.status}`);
        },
      },
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("passed");
    expect(events).toEqual(["claim bpng-1 folder:false", "published passed"]);
  });

  for (const [how, answer] of [
    ["resolves a reason", `the locks are gone ${SECRET}`],
    ["rejects", new Error(`the lock is gone ${SECRET}`)],
  ] as const)
    test(`a claim that ${how} launches nothing, and the run ends an error pointing at no report or log`, async () => {
      const events: string[] = [];
      const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
        claimCell: claimCell(events, answer),
      });
      const result = ended(await runOnce(TASK, deps).done);
      expect(result.status).toBe("error");
      expect(existsSync(identityOf().dir)).toBe(false);
      expect(seen.records).toEqual([]);
      expect(seen.published).toHaveLength(1);
      const event = seen.published[0];
      expect(event?.reason).toMatch(/^the run could not start: /);
      // No folder: no report, no log, and the outcome line ends at the duration.
      expect(event?.report).toEqual({ dir: null, log: null });
      expect(
        seen.lines.find((line) => line.startsWith("bpng bpng-1 ✘ error")),
      ).toMatch(/ · 0s$/);
      expect(
        seen.lines.some((line) => line.startsWith("bpng bpng-1 not started: ")),
      ).toBe(true);
      expect(everything(seen)).not.toContain(SECRET);
    });

  test("a launch refused before the run's folder was its own points at no report or log either", async () => {
    const { deps, seen } = harness({ exitCode: 0 }, runnerWith("passed"), {
      commandsFor: () => {
        throw new Error("no commands");
      },
    });
    expect(ended(await runOnce(TASK, deps).done).status).toBe("error");
    expect(seen.published[0]?.report).toEqual({ dir: null, log: null });
  });

  test("a run that could not be watched to its end says so in its result", async () => {
    const { deps } = harness(
      {},
      {},
      {
        launch: async (options) => {
          await mkdir(options.identity.dir, { recursive: true });
          await options.onSpawning?.("bddgen");
          return {
            stop: () => undefined,
            done: Promise.reject(new Error("watch failed")),
          };
        },
        readLeaderStart: () => Promise.resolve({ kind: "gone" }),
      },
    );
    expect(ended(await runOnce(TASK, deps).done).unwatched).toBe(true);
  });

  test("a run watched to its end is never unwatched", async () => {
    const { deps } = harness({ exitCode: 0 }, runnerWith("passed"));
    expect(ended(await runOnce(TASK, deps).done).unwatched).toBeUndefined();
  });

  test("a process group that will not empty is said in the orchestrator's lines, under the run's id", async () => {
    const { deps, seen } = harness(
      {},
      {},
      {
        launch: async (options) => {
          await mkdir(options.identity.dir, { recursive: true });
          await options.onSpawning?.("bddgen");
          options.onStuck?.(
            `playwright's process group (4242) is still not empty ${SECRET}`,
          );
          return {
            stop: () => undefined,
            done: Promise.resolve({
              bddgen: { code: 0, signal: null },
              stop: { level: "none" },
            }),
          };
        },
        end: () => Promise.reject(new Error("unread")),
      },
    );
    await runOnce(TASK, deps).done;
    expect(seen.lines).toContain(
      "bpng bpng-1: playwright's process group (4242) is still not empty ***",
    );
  });
});
