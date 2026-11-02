import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { fakeCommand } from "../__fixtures__/fake-suite";
import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "../__fixtures__/results";
import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import type { RunFinishedEvent } from "../events/run-finished";
import { runIdentity } from "../runs/identity";
import {
  launchRun,
  type LaunchedRun,
  type LaunchOptions,
} from "../runs/launch";
import type { RunStatus } from "../runs/outcome";
import { parseRunRecord } from "../runs/record";
import type { StopLevel } from "../runs/stop";
import type { HeldCell } from "../state/cell-lock";
import type { RunNaming } from "../state/lock";
import type { TaskActivity } from "./activity";
import type { CycleDeps, RunHandle, RunResult } from "./cycle";
import {
  cooldownDelay,
  MAX_TIMER_MS,
  NODE_COOLDOWN_TIMERS,
  nextRunLine,
  onceExitCode,
  onceVerdict,
  runTask,
  type CooldownTimers,
  type LoopDeps,
  type LoopTask,
  type TaskLoop,
} from "./loop";

/**
 * The loop over a fake cycle and fake timers — every wait and every run's end decided by the test —,
 * then over the real `runOnce` and the fake suite, for two short cycles.
 */

/** A secret a stop's reason quotes: no line shows it. */
const SECRET = "storage-Password-Of-No-Shape-0123";

/** When the first run ends, in local time: the lines show local time. */
const T0 = new Date(2026, 9, 13, 11, 9, 41).getTime();

/** The task: a 5-minute cooldown. */
const TASK: LoopTask = {
  id: "bpng",
  name: "BackWPup Pro on nginx",
  product: "backwpup",
  cell: "pro@nginx",
  plugin: { ref: "develop" },
  cooldownMinutes: 5,
};

/** Five minutes. */
const COOLDOWN_MS = 5 * 60_000;

/** Rejections nobody handled during a test: there must be none. */
let unhandled: unknown[];
/** Records them. */
const onUnhandled = (reason: unknown): void => {
  unhandled.push(reason);
};
test.beforeEach(() => {
  unhandled = [];
  process.on("unhandledRejection", onUnhandled);
});
test.afterEach(async () => {
  await delay(20);
  process.off("unhandledRejection", onUnhandled);
  expect(unhandled).toEqual([]);
});

/** A fake timer: its wait, and whether it is still armed. */
interface FakeTimer {
  readonly ms: number;
  readonly fire: () => void;
  armed: boolean;
}

/** Timers a test fires by hand; every timer ever armed kept, to prove none is left. */
class FakeTimers implements CooldownTimers {
  readonly timers: FakeTimer[] = [];
  /** Called as each timer is armed, before `setTimeout` returns: a stop from within, say. */
  onArm: ((timer: FakeTimer) => void) | undefined;

  /**
   * Arms a timer.
   *
   * @param callback - what it calls.
   * @param ms - its wait.
   * @returns its handle.
   */
  setTimeout(callback: () => void, ms: number): unknown {
    const timer: FakeTimer = {
      ms,
      armed: true,
      fire: () => {
        if (!timer.armed) throw new Error("fired a timer not armed");
        timer.armed = false;
        callback();
      },
    };
    this.timers.push(timer);
    this.onArm?.(timer);
    return timer;
  }

  /**
   * Disarms a timer.
   *
   * @param handle - its handle.
   */
  clearTimeout(handle: unknown): void {
    (handle as FakeTimer).armed = false;
  }

  /** The timers still armed. */
  get live(): FakeTimer[] {
    return this.timers.filter((timer) => timer.armed);
  }

  /**
   * Fires the one timer armed.
   *
   * @returns its wait.
   */
  fireOnly(): number {
    const [timer, ...more] = this.live;
    if (timer === undefined || more.length > 0)
      throw new Error(
        `expected one armed timer, not ${String(this.live.length)}`,
      );
    timer.fire();
    return timer.ms;
  }
}

/** A fake run: its stops, and how the test ends it. */
interface FakeRun {
  /** Its `done`, as the loop is handed it. */
  readonly done: Promise<RunResult>;
  readonly stops: { level: StopLevel; why: string }[];
  readonly settle: (result: RunResult) => void;
  readonly fail: (error: unknown) => void;
}

/** What a test sees and controls of a loop. */
interface Rig {
  readonly loop: TaskLoop;
  readonly lines: string[];
  readonly runs: FakeRun[];
  readonly timers: FakeTimers;
  /** The clock; a test moves it. */
  readonly clock: { now: number };
}

/** Deps every rig shares: nothing here is called by the fake cycle. */
const BASE: Omit<CycleDeps, "logger" | "now"> = {
  stateDir: "/nowhere/.orchestrator",
  checkout: "/nowhere",
  config: {},
  secrets: [SECRET],
  inherited: {},
  commandsFor: () => {
    throw new Error("not called by the fake cycle");
  },
  bus: { publish: () => undefined },
};

/**
 * A loop over a fake cycle and fake timers.
 *
 * @param more - deps to replace; `onRun` is called as each run is created.
 */
function rig(
  more: Partial<LoopDeps> & {
    onRun?: (run: FakeRun, loop: TaskLoop) => void;
  } = {},
): Rig {
  const lines: string[] = [];
  const runs: FakeRun[] = [];
  const timers = new FakeTimers();
  const clock = { now: T0 };
  const { onRun, ...deps } = more;
  const made: { loop?: TaskLoop } = {};
  const fakeRunOnce = (): RunHandle => {
    const stops: FakeRun["stops"] = [];
    let settle!: (result: RunResult) => void;
    let fail!: (error: unknown) => void;
    const done = new Promise<RunResult>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    const run: FakeRun = { done, stops, settle, fail };
    runs.push(run);
    if (made.loop !== undefined) onRun?.(run, made.loop);
    return {
      stop: (level, why) => {
        stops.push({ level, why });
      },
      done,
    };
  };
  const loop = runTask(TASK, {
    ...BASE,
    logger: {
      line: (scope, text) => {
        lines.push(`${scope} ${text}`);
      },
    },
    now: () => new Date(clock.now),
    runOnce: fakeRunOnce,
    timers,
    ...deps,
  });
  made.loop = loop;
  return { loop, lines, runs, timers, clock };
}

/**
 * Lets every pending turn run: the loop's awaits.
 */
async function turns(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * A run that ended.
 *
 * @param status - its status.
 * @param endedAt - when, in the clock's milliseconds.
 */
function endedRun(status: RunStatus, endedAt = T0): RunResult {
  return { kind: "ended", id: "bpng-1", status, endedAt: new Date(endedAt) };
}

/**
 * The run with this index, once created.
 *
 * @param r - the rig.
 * @param index - which.
 */
async function runAt(r: Rig, index: number): Promise<FakeRun> {
  await turns();
  const run = r.runs[index];
  if (run === undefined)
    throw new Error(`run ${String(index)} was not created`);
  return run;
}

/** The process's armed Node timers. */
function activeTimeouts(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === "Timeout").length;
}

test.describe("cooldownDelay", () => {
  test("is total: never outside zero and the smaller of the cooldown and Node's longest timer", () => {
    const now = new Date(T0);
    expect(cooldownDelay(now, now, NaN)).toBe(0);
    expect(cooldownDelay(now, now, -COOLDOWN_MS)).toBe(0);
    expect(cooldownDelay(now, now, Infinity)).toBe(MAX_TIMER_MS);
    expect(cooldownDelay(now, now, -Infinity)).toBe(0);
    expect(cooldownDelay(now, now, 40_000 * 60_000)).toBe(MAX_TIMER_MS);
    expect(cooldownDelay(new Date(NaN), now, 40_000 * 60_000)).toBe(
      MAX_TIMER_MS,
    );
    expect(cooldownDelay(now, now, MAX_TIMER_MS)).toBe(MAX_TIMER_MS);
  });

  test("counts the cooldown from the run's end", () => {
    expect(cooldownDelay(new Date(T0), new Date(T0 + 2_000), COOLDOWN_MS)).toBe(
      COOLDOWN_MS - 2_000,
    );
  });

  test("waits nothing once the cooldown has passed, and never less", () => {
    expect(
      cooldownDelay(new Date(T0), new Date(T0 + COOLDOWN_MS), COOLDOWN_MS),
    ).toBe(0);
    expect(
      cooldownDelay(new Date(T0), new Date(T0 + 3 * COOLDOWN_MS), COOLDOWN_MS),
    ).toBe(0);
  });

  test("never waits more than the cooldown: a clock stepped back, or an end that is no time", () => {
    expect(
      cooldownDelay(new Date(T0 + 3_600_000), new Date(T0), COOLDOWN_MS),
    ).toBe(COOLDOWN_MS);
    expect(cooldownDelay(new Date(T0 + 1), new Date(T0), COOLDOWN_MS)).toBe(
      COOLDOWN_MS,
    );
    expect(cooldownDelay(new Date(NaN), new Date(T0), COOLDOWN_MS)).toBe(
      COOLDOWN_MS,
    );
    expect(cooldownDelay(new Date(T0), new Date(NaN), COOLDOWN_MS)).toBe(
      COOLDOWN_MS,
    );
  });
});

test.describe("nextRunLine", () => {
  test("says when, in local HH:MM:SS, and the cooldown in minutes", () => {
    expect(nextRunLine(new Date(2026, 9, 13, 11, 14, 42), 5)).toBe(
      "next run 11:14:42 (cooldown 5m)",
    );
    expect(nextRunLine(new Date(2026, 9, 13, 9, 5, 3), 1440)).toBe(
      "next run 09:05:03 (cooldown 1440m)",
    );
  });
});

test.describe("--once's verdict and exit code", () => {
  test("only a run that ended passed or flaky passes; every other result fails", () => {
    const cases: [RunResult | undefined, string][] = [
      [endedRun("passed"), "passed"],
      [endedRun("flaky"), "passed"],
      [endedRun("failed"), "failed"],
      // Could not test: setup, bddgen, no scenario, an unreadable end.
      [endedRun("error"), "failed"],
      // Stopped or killed by anything but the loop: the try did not test.
      [endedRun("stopped"), "failed"],
      [endedRun("killed"), "failed"],
      [{ kind: "notStarted", why: "failed" }, "failed"],
      [{ kind: "notStarted", why: "stopped" }, "failed"],
      [undefined, "failed"],
    ];
    for (const [result, verdict] of cases)
      expect(onceVerdict(result, false), JSON.stringify(result)).toBe(verdict);
  });

  test("a loop that was stopped is stopped, whatever its run", () => {
    for (const result of [
      endedRun("passed"),
      endedRun("failed"),
      endedRun("stopped"),
      { kind: "notStarted", why: "stopped" } as const,
      undefined,
    ])
      expect(onceVerdict(result, true)).toBe("stopped");
  });

  test("exits 130 when any loop was stopped, else 1 when any failed, else 0", () => {
    expect(onceExitCode([])).toBe(0);
    expect(onceExitCode(["passed", "passed"])).toBe(0);
    expect(onceExitCode(["passed", "failed"])).toBe(1);
    expect(onceExitCode(["failed", "stopped", "passed"])).toBe(130);
    expect(onceExitCode(["stopped"])).toBe(130);
  });
});

test.describe("runTask — the cooldown", () => {
  test("waits the cooldown from the run's end, says when the next run starts, then runs again", async () => {
    const r = rig();
    const first = await runAt(r, 0);
    // The run ended at T0, and was recorded, announced and pruned 2 s later.
    r.clock.now = T0 + 2_000;
    first.settle(endedRun("passed", T0));
    await turns();
    expect(r.lines).toEqual(["bpng next run 11:14:41 (cooldown 5m)"]);
    expect(r.timers.live.map((t) => t.ms)).toEqual([COOLDOWN_MS - 2_000]);
    expect(r.runs).toHaveLength(1);

    r.timers.fireOnly();
    const second = await runAt(r, 1);
    r.clock.now = T0 + 10 * 60_000;
    second.settle(endedRun("failed", r.clock.now));
    await turns();
    expect(r.lines[1]).toBe("bpng next run 11:24:41 (cooldown 5m)");
    expect(r.timers.live.map((t) => t.ms)).toEqual([COOLDOWN_MS]);

    r.loop.stop("drained", "the orchestrator was stopped (SIGINT)");
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: endedRun("failed", T0 + 10 * 60_000),
      verdict: "stopped",
    });
    expect(r.timers.live).toEqual([]);
    expect(r.runs).toHaveLength(2);
  });

  test("a run that never started cools down from when it settled, and the loop goes on", async () => {
    const r = rig();
    const first = await runAt(r, 0);
    r.clock.now = T0 + 7_000;
    first.settle({ kind: "notStarted", why: "failed" });
    await turns();
    expect(r.lines).toEqual(["bpng next run 11:14:48 (cooldown 5m)"]);
    expect(r.timers.fireOnly()).toBe(COOLDOWN_MS);
    await runAt(r, 1);
    r.loop.stop("drained", "stop");
    r.runs[1]?.settle(endedRun("stopped"));
    expect((await r.loop.done).ended).toBe("stopped");
  });

  test("a run whose processes could not be watched to their end ends the loop failed: no cooldown, no next run", async () => {
    for (const once of [false, true]) {
      const r = rig({ once });
      (await runAt(r, 0)).settle({
        kind: "ended",
        id: "bpng-1",
        status: "error",
        endedAt: new Date(T0),
        unwatched: true,
      });
      const end = await r.loop.done;
      expect(end).toMatchObject({ ended: "failed", verdict: "failed" });
      expect(r.lines).toEqual([
        "bpng no next run: bpng-1's processes could not be watched to their end and may still run — its cell stays locked, and the next start's orphan check judges them",
      ]);
      expect(r.timers.live).toEqual([]);
      await turns();
      expect(r.runs).toHaveLength(1);
    }
  });

  test("a real cycle whose launch cannot be watched launches the cell once, and never again", async () => {
    let launches = 0;
    const r = rig({
      runOnce: undefined,
      commandsFor: () => ({
        bddgen: fakeCommand({ exitCode: 0 }),
        playwright: fakeCommand({ exitCode: 0 }),
      }),
      nextNumber: () => Promise.resolve(launches + 1),
      prune: () => Promise.reject(new Error("no pruning here")),
      launch: () => {
        launches += 1;
        return Promise.resolve({
          stop: () => undefined,
          done: Promise.reject(new Error("the watch failed")),
        });
      },
    });
    const end = await r.loop.done;
    expect(end.ended).toBe("failed");
    expect(launches).toBe(1);
    expect(r.timers.timers).toEqual([]);
    expect(r.lines.at(-1)).toMatch(
      /^bpng no next run: bpng-1's processes could not be watched/,
    );
  });

  test("a run stopped or killed by anything but the loop, or that failed, does not end it", async () => {
    const r = rig();
    const results: RunResult[] = [
      endedRun("killed"),
      endedRun("stopped"),
      endedRun("error"),
    ];
    for (const [index, result] of results.entries()) {
      (await runAt(r, index)).settle(result);
      await turns();
      r.timers.fireOnly();
    }
    await runAt(r, 3);
    r.loop.stop("killed", "stop");
    r.runs[3]?.settle(endedRun("killed"));
    expect((await r.loop.done).ended).toBe("stopped");
  });

  test("the cooldown's timer is waited for by default, without being kept", async () => {
    // Node's own timers: the stop clears the cooldown's, so the spec does not wait it.
    const before = activeTimeouts();
    const r = rig({ timers: undefined });
    (await runAt(r, 0)).settle(endedRun("passed", T0));
    await turns();
    expect(r.lines).toEqual(["bpng next run 11:14:41 (cooldown 5m)"]);
    const started = Date.now();
    r.loop.stop("drained", "stop");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(Date.now() - started).toBeLessThan(1_000);
    // Not kept: a stopped process must not stay alive for the rest of the cooldown.
    expect(activeTimeouts()).toBe(before);
  });
});

test.describe("runTask — the cell's site locks, held for the whole loop", () => {
  /** What a stand-in `HeldCell` saw. */
  interface CellSeen {
    readonly events: string[];
  }

  /**
   * A stand-in for the cell's site locks.
   *
   * @param seen - where its calls go.
   * @param naming - what `setRun` resolves to; an `Error`, what it rejects with.
   * @param released - what `release` resolves to.
   * @returns it.
   */
  function heldCell(
    seen: CellSeen,
    naming: RunNaming | Error = { kind: "named" },
    released = true,
  ): HeldCell {
    return {
      locks: [],
      setRun: (run) => {
        seen.events.push(`setRun ${run}`);
        return naming instanceof Error
          ? Promise.reject(naming)
          : Promise.resolve(naming);
      },
      release: () => {
        seen.events.push("release");
        return Promise.resolve(released);
      },
    };
  }

  /**
   * A `runOnce` that names each run in the locks as the real cycle does — a throw ends the run as its
   * result says —, then ends it at once.
   *
   * @param seen - where it says each run.
   * @param result - how each run ends.
   * @returns it.
   */
  function claimingRunOnce(
    seen: CellSeen,
    result: (n: number) => RunResult = () => endedRun("passed"),
  ): NonNullable<LoopDeps["runOnce"]> {
    let n = 0;
    return (_task, deps) => {
      n += 1;
      const number = n;
      seen.events.push(`run ${String(number)}`);
      return {
        stop: () => undefined,
        done: (async () => {
          try {
            await deps.claimCell?.(`/s/runs/bpng-${String(number)}/run.json`);
          } catch {
            // The real cycle ends the run `error`: what `result` says.
          }
          return result(number);
        })(),
      };
    };
  }

  test("takes them once as the loop starts, names each run, and gives them back once as it ends", async () => {
    const cell: CellSeen = { events: [] };
    const r = rig({
      takeCell: () => {
        cell.events.push("take");
        return Promise.resolve(heldCell(cell));
      },
      runOnce: claimingRunOnce(cell),
    });
    await turns();
    r.timers.fireOnly();
    await turns();
    r.loop.stop("drained", "stop");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(cell.events).toEqual([
      "take",
      "run 1",
      "setRun /s/runs/bpng-1/run.json",
      "run 2",
      "setRun /s/runs/bpng-2/run.json",
      "release",
    ]);
  });

  test("held elsewhere: the loop ends failed before any run, said once — never once per cooldown", async () => {
    const cell: CellSeen = { events: [] };
    const r = rig({
      takeCell: () =>
        Promise.reject(new Error(`Another orchestrator holds it ${SECRET}`)),
      runOnce: claimingRunOnce(cell),
    });
    expect(await r.loop.done).toMatchObject({
      ended: "failed",
      verdict: "failed",
    });
    expect(r.lines).toEqual([
      "bpng not started: Another orchestrator holds it ***",
    ]);
    expect(cell.events).toEqual([]);
    expect(r.timers.timers).toEqual([]);
  });

  test("a stop before the loop starts takes nothing", async () => {
    let taken = 0;
    const r = rig({
      takeCell: () => {
        taken += 1;
        return Promise.resolve(heldCell({ events: [] }));
      },
    });
    r.loop.stop("drained", "stop");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(taken).toBe(0);
  });

  test("kept, not given back, when a run's processes may still live", async () => {
    const cell: CellSeen = { events: [] };
    const r = rig({
      takeCell: () => Promise.resolve(heldCell(cell)),
      runOnce: claimingRunOnce(cell, () => ({
        kind: "ended",
        id: "bpng-1",
        status: "error",
        endedAt: new Date(T0),
        unwatched: true,
      })),
    });
    expect((await r.loop.done).ended).toBe("failed");
    expect(cell.events).not.toContain("release");
  });

  for (const [naming, said] of [
    [
      { kind: "lost" },
      "its cell's site locks are no longer this orchestrator's — removed, or another's",
    ],
    [
      { kind: "failed", why: "ENOSPC" },
      "its cell's site locks could not be rewritten to name the run (ENOSPC): they are still this orchestrator's, but no run starts unnamed in them",
    ],
    [
      new Error(`EIO renaming ${SECRET}`),
      "its cell's site locks could not be rewritten to name the run (EIO renaming ***): they are still this orchestrator's, but no run starts unnamed in them",
    ],
  ] as const)
    test(`a run that cannot be named in them (${naming instanceof Error ? "setRun rejects" : naming.kind}) ends the loop after it: no next run, said why, and the locks given back`, async () => {
      const cell: CellSeen = { events: [] };
      const r = rig({
        takeCell: () => Promise.resolve(heldCell(cell, naming)),
        runOnce: claimingRunOnce(cell, () => endedRun("error")),
      });
      // Checked before the end is awaited: a loop that cooled down would never end.
      await delay(0);
      expect(r.timers.timers).toEqual([]);
      expect((await r.loop.done).ended).toBe("failed");
      expect(r.lines).toContain(`bpng no next run: ${said}`);
      expect(cell.events.filter((event) => event.startsWith("run "))).toEqual([
        "run 1",
      ]);
      expect(cell.events.at(-1)).toBe("release");
      expect(r.timers.timers).toEqual([]);
    });

  test("locks that cannot all be given back are said", async () => {
    const r = rig({
      once: true,
      takeCell: () =>
        Promise.resolve(heldCell({ events: [] }, { kind: "named" }, false)),
      runOnce: claimingRunOnce({ events: [] }),
    });
    expect((await r.loop.done).ended).toBe("once");
    expect(r.lines).toContain(
      "bpng its cell's site locks were not all removed: gone, another's, or could not be",
    );
  });
});

test.describe("NODE_COOLDOWN_TIMERS", () => {
  test("keeps the process alive while it waits: a cooldown may be all that is left", () => {
    const before = activeTimeouts();
    const handle = NODE_COOLDOWN_TIMERS.setTimeout(() => undefined, 60_000);
    try {
      expect((handle as NodeJS.Timeout).hasRef()).toBe(true);
      expect(activeTimeouts()).toBe(before + 1);
    } finally {
      NODE_COOLDOWN_TIMERS.clearTimeout(handle);
    }
    // Cleared, it is gone.
    expect(activeTimeouts()).toBe(before);
  });
});

test.describe("runTask — stopping", () => {
  test("a stop in the cooldown ends the loop at once, clears its timer and starts no run", async () => {
    const r = rig();
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    expect(r.timers.live).toHaveLength(1);
    r.loop.stop(
      "drained",
      `the orchestrator was stopped (SIGTERM) ${SECRET}\nnext`,
    );
    const end = await r.loop.done;
    expect(end).toEqual({
      ended: "stopped",
      last: endedRun("passed"),
      verdict: "stopped",
    });
    expect(r.timers.live).toEqual([]);
    expect(r.runs).toHaveLength(1);
    // The run over, no stop reaches it.
    expect(r.runs[0]?.stops).toEqual([]);
    // The reason masked, one line.
    expect(r.lines[1]).toBe(
      "bpng no next run: the orchestrator was stopped (SIGTERM) *** next",
    );
    expect(r.lines.join("\n")).not.toContain(SECRET);
  });

  test("a stop mid-run reaches the run, and the loop ends once it has, with no cooldown", async () => {
    const r = rig();
    const run = await runAt(r, 0);
    r.loop.stop("drained", "the orchestrator was stopped (SIGINT)");
    expect(run.stops).toEqual([
      { level: "drained", why: "the orchestrator was stopped (SIGINT)" },
    ]);
    let ended = false;
    void r.loop.done.then(() => {
      ended = true;
    });
    await turns();
    expect(ended).toBe(false);
    run.settle(endedRun("stopped"));
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: endedRun("stopped"),
      verdict: "stopped",
    });
    expect(r.timers.timers).toEqual([]);
    expect(r.runs).toHaveLength(1);
    expect(r.lines).toEqual([
      "bpng no next run: the orchestrator was stopped (SIGINT)",
    ]);
  });

  test("one, two, three stops each reach the run in flight, masked", async () => {
    const r = rig();
    const run = await runAt(r, 0);
    r.loop.stop("drained", "the orchestrator was stopped (SIGINT)");
    r.loop.stop(
      "interrupted",
      `interrupted: a SIGINT while draining ${SECRET}`,
    );
    r.loop.stop("killed", "killed: a SIGINT while interrupting");
    // A lesser one is handed on too: the run keeps its furthest.
    r.loop.stop("drained", "again");
    expect(run.stops).toEqual([
      { level: "drained", why: "the orchestrator was stopped (SIGINT)" },
      { level: "interrupted", why: "interrupted: a SIGINT while draining ***" },
      { level: "killed", why: "killed: a SIGINT while interrupting" },
      { level: "drained", why: "again" },
    ]);
    run.settle(endedRun("killed"));
    const end = await r.loop.done;
    expect(end.verdict).toBe("stopped");
    // The loop's line keeps the first reason of the furthest stop.
    expect(r.lines).toEqual([
      "bpng no next run: killed: a SIGINT while interrupting",
    ]);
  });

  test("a stop asked as runTask returns starts no run at all", async () => {
    const r = rig();
    r.loop.stop("drained", "stop");
    expect(await r.loop.done).toEqual({ ended: "stopped", verdict: "stopped" });
    expect(r.runs).toEqual([]);
    expect(r.lines).toEqual(["bpng no next run: stop"]);
  });

  test("a stop as the run settles: no cooldown, no next run", async () => {
    const r = rig({
      // Its handler is registered before the loop awaits the run: it runs first.
      onRun: (run, loop) => {
        void run.done.then(() => {
          loop.stop("drained", "between");
        });
      },
    });
    (await runAt(r, 0)).settle(endedRun("passed"));
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.timers.timers).toEqual([]);
    expect(r.runs).toHaveLength(1);
  });

  test("a stop while the next run is being created reaches that run", async () => {
    const r = rig({
      onRun: (_run, loop) => {
        loop.stop("interrupted", "while created");
      },
    });
    const run = await runAt(r, 0);
    expect(run.stops).toEqual([
      // From within runOnce: no handle yet. Then from the loop, once it holds the handle.
      { level: "interrupted", why: "while created" },
    ]);
    run.settle({ kind: "notStarted", why: "stopped" });
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: { kind: "notStarted", why: "stopped" },
      verdict: "stopped",
    });
  });

  test("a stop as the cooldown is said, before its timer is armed, still ends it", async () => {
    const box: { loop?: TaskLoop } = {};
    const r = rig({
      logger: {
        line: (_scope, text) => {
          if (text.startsWith("next run"))
            box.loop?.stop("drained", "while said");
        },
      },
    });
    box.loop = r.loop;
    (await runAt(r, 0)).settle(endedRun("passed"));
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.timers.timers).toHaveLength(1);
    expect(r.timers.live).toEqual([]);
    expect(r.runs).toHaveLength(1);
  });

  test("a stop as the cooldown's timer fires starts no run", async () => {
    const r = rig();
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    r.timers.fireOnly();
    // The loop has not yet resumed: the stop comes before it starts the next run.
    r.loop.stop("drained", "stop");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.runs).toHaveLength(1);
  });

  test("a stop while the cooldown's timer is armed ends it, and keeps no timer", async () => {
    const r = rig();
    r.timers.onArm = () => {
      r.loop.stop("drained", "while armed");
    };
    (await runAt(r, 0)).settle(endedRun("passed"));
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.timers.timers).toHaveLength(1);
    expect(r.timers.live).toEqual([]);
    expect(r.runs).toHaveLength(1);
  });

  test("repeated stops in the cooldown end it once; a stop after the end does nothing", async () => {
    const r = rig();
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    r.loop.stop("drained", "first");
    r.loop.stop("interrupted", "second");
    r.loop.stop("killed", "third");
    const end = await r.loop.done;
    expect(end.ended).toBe("stopped");
    expect(r.lines).toEqual([
      "bpng next run 11:14:41 (cooldown 5m)",
      "bpng no next run: third",
    ]);
    expect(() => {
      r.loop.stop("killed", "after");
    }).not.toThrow();
    await turns();
    expect(r.lines).toHaveLength(2);
    expect(r.runs).toHaveLength(1);
    expect(r.timers.live).toEqual([]);
  });

  test("a stop the run's handle throws on is a line; the loop still ends", async () => {
    const r = rig({
      runOnce: () => ({
        stop: () => {
          throw new Error(`no ${SECRET}`);
        },
        done: delay(30).then(() => endedRun("stopped")),
      }),
    });
    await turns();
    r.loop.stop("drained", "stop");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.lines).toEqual([
      "bpng stopping the run failed: no ***",
      "bpng no next run: stop",
    ]);
  });
});

test.describe("runTask — --once", () => {
  for (const [result, verdict] of [
    [endedRun("passed"), "passed"],
    [endedRun("flaky"), "passed"],
    [endedRun("failed"), "failed"],
    [endedRun("error"), "failed"],
    [endedRun("stopped"), "failed"],
    [endedRun("killed"), "failed"],
    [{ kind: "notStarted", why: "failed" }, "failed"],
  ] as const)
    test(`one run, no cooldown: ${result.kind} ${"status" in result ? result.status : result.why} is ${verdict}`, async () => {
      const r = rig({ once: true });
      (await runAt(r, 0)).settle(result);
      expect(await r.loop.done).toEqual({
        ended: "once",
        last: result,
        verdict,
      });
      expect(r.timers.timers).toEqual([]);
      expect(r.runs).toHaveLength(1);
      expect(r.lines).toEqual([]);
    });

  test("a stop during its run is stopped, whatever the run says", async () => {
    const r = rig({ once: true });
    const run = await runAt(r, 0);
    r.loop.stop("drained", "stop");
    run.settle(endedRun("passed"));
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: endedRun("passed"),
      verdict: "stopped",
    });
  });

  test("a stop before its run is stopped, with no run", async () => {
    const r = rig({ once: true });
    r.loop.stop("drained", "stop");
    expect(await r.loop.done).toEqual({ ended: "stopped", verdict: "stopped" });
    expect(r.runs).toEqual([]);
  });

  test("a stop after its loop ended does not change its end", async () => {
    const r = rig({ once: true });
    (await runAt(r, 0)).settle(endedRun("passed"));
    const end = await r.loop.done;
    r.loop.stop("killed", "late");
    expect(end.verdict).toBe("passed");
    expect(r.lines).toEqual([]);
  });
});

test.describe("runTask — a cooldown it cannot wait", () => {
  for (const cooldownMinutes of [NaN, -1, 0, 2.5, Infinity, 1441, 40_000])
    for (const once of [false, true])
      test(`a cooldown of ${String(cooldownMinutes)} ends the loop failed before any run${once ? " (--once)" : ""}`, async () => {
        const lines: string[] = [];
        const runs: number[] = [];
        const loop = runTask(
          { ...TASK, cooldownMinutes },
          {
            ...BASE,
            once,
            logger: {
              line: (scope, text) => {
                lines.push(`${scope} ${text}`);
              },
            },
            runOnce: () => {
              runs.push(1);
              throw new Error("no run may start");
            },
            timers: new FakeTimers(),
          },
        );
        expect(await loop.done).toEqual({ ended: "failed", verdict: "failed" });
        expect(runs).toEqual([]);
        expect(lines).toEqual([
          `bpng no run: the task's cooldown (${String(cooldownMinutes)}) must be a whole number of minutes from 1 to 1440`,
        ]);
      });

  test("the bounds themselves are waited", async () => {
    for (const cooldownMinutes of [1, 1440]) {
      const timers = new FakeTimers();
      const loop = runTask(
        { ...TASK, cooldownMinutes },
        {
          ...BASE,
          logger: { line: () => undefined },
          now: () => new Date(T0),
          runOnce: () => ({
            stop: () => undefined,
            done: Promise.resolve(endedRun("passed")),
          }),
          timers,
        },
      );
      await turns();
      expect(timers.live.map((t) => t.ms)).toEqual([cooldownMinutes * 60_000]);
      loop.stop("drained", "stop");
      expect((await loop.done).ended).toBe("stopped");
    }
  });
});

test.describe("runTask — never rejects", () => {
  test("a clock that throws ends the loop failed, said", async () => {
    const clock = { broken: false };
    const r = rig({
      now: () => {
        if (clock.broken) throw new Error("no clock");
        return new Date(T0);
      },
    });
    const run = await runAt(r, 0);
    clock.broken = true;
    run.settle(endedRun("passed"));
    expect(await r.loop.done).toEqual({ ended: "failed", verdict: "failed" });
    expect(r.lines).toEqual(["bpng the loop failed, no next run: no clock"]);
    expect(r.runs).toHaveLength(1);
  });

  test("a runOnce that throws is a line and a run that did not start; the loop cools down", async () => {
    const r = rig({
      runOnce: () => {
        throw new Error(`broken ${SECRET}`);
      },
    });
    await turns();
    expect(r.lines).toEqual([
      "bpng the run failed: broken ***",
      "bpng next run 11:14:41 (cooldown 5m)",
    ]);
    expect(r.timers.live.map((t) => t.ms)).toEqual([COOLDOWN_MS]);
    r.loop.stop("drained", "stop");
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: { kind: "notStarted", why: "failed" },
      verdict: "stopped",
    });
  });

  test("a done that rejects is a line and a failed --once", async () => {
    const r = rig({ once: true });
    (await runAt(r, 0)).fail(new Error(`rejected ${SECRET}`));
    expect(await r.loop.done).toEqual({
      ended: "once",
      last: { kind: "notStarted", why: "failed" },
      verdict: "failed",
    });
    expect(r.lines).toEqual(["bpng the run failed: rejected ***"]);
  });

  test("timers that cannot arm end the loop, said; it never spins", async () => {
    const r = rig({
      timers: {
        setTimeout: () => {
          throw new Error("no timers");
        },
        clearTimeout: () => undefined,
      },
    });
    (await runAt(r, 0)).settle(endedRun("passed"));
    expect(await r.loop.done).toEqual({
      ended: "failed",
      last: endedRun("passed"),
      verdict: "failed",
    });
    expect(r.lines).toEqual([
      "bpng next run 11:14:41 (cooldown 5m)",
      "bpng the loop failed, no next run: no timers",
    ]);
    expect(r.runs).toHaveLength(1);
  });

  test("a stop from within a cooldown's arming that then throws ends the loop as stopped", async () => {
    const box: { loop?: TaskLoop } = {};
    const r = rig({
      timers: {
        setTimeout: () => {
          box.loop?.stop("drained", "stop");
          throw new Error("no timers");
        },
        clearTimeout: () => undefined,
      },
    });
    box.loop = r.loop;
    (await runAt(r, 0)).settle(endedRun("failed"));
    expect(await r.loop.done).toEqual({
      ended: "stopped",
      last: endedRun("failed"),
      verdict: "stopped",
    });
    expect(r.lines.at(-1)).toBe("bpng no next run: stop");
  });

  test("a logger that throws loses its lines, never the loop", async () => {
    const r = rig({
      logger: {
        line: () => {
          throw new Error("closed");
        },
      },
    });
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    r.timers.fireOnly();
    await runAt(r, 1);
    r.loop.stop("drained", "stop");
    r.runs[1]?.settle(endedRun("stopped"));
    expect((await r.loop.done).ended).toBe("stopped");
  });
});

test.describe("runTask — over the real runOnce and the fake suite", () => {
  let checkout: string;
  let stateDir: string;
  /** Every process group a test's runs started: killed, with whatever they left, as the test ends. */
  const groups = new Set<number>();

  /**
   * The real launch, each process group it starts kept in {@link groups}.
   *
   * @param options - the launch's options.
   * @returns the launched run.
   */
  const launch = (options: LaunchOptions): Promise<LaunchedRun> =>
    launchRun({
      ...options,
      onProcess: (name, pgid) => {
        groups.add(pgid);
        return options.onProcess?.(name, pgid);
      },
    });

  test.beforeEach(async () => {
    checkout = await mkdtemp(join(tmpdir(), "e2e-loop-checkout-"));
    stateDir = join(checkout, ".orchestrator");
    await mkdir(stateDir, { mode: 0o700 });
  });
  test.afterEach(async () => {
    // A group already gone (ESRCH), or no longer ours (EPERM), is skipped.
    for (const pgid of groups) {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
    }
    groups.clear();
    await rm(checkout, { recursive: true, force: true });
  });

  test("a stop mid-run drains the real run, which reads stopped, and starts no cooldown", async () => {
    const lines: string[] = [];
    const waits: number[] = [];
    const box: { loop?: TaskLoop } = {};
    const loop = runTask(TASK, {
      stateDir,
      checkout,
      launch,
      config: {},
      secrets: [SECRET],
      inherited: { PATH: process.env.PATH },
      commandsFor: () => ({
        bddgen: fakeCommand({ exitCode: 0 }),
        playwright: fakeCommand({ runMs: 60_000 }),
      }),
      logger: {
        line: (scope, text) => {
          lines.push(`${scope} ${text}`);
          if (text.startsWith("bpng-1 started"))
            box.loop?.stop("drained", "the orchestrator was stopped (SIGINT)");
        },
      },
      bus: { publish: () => undefined },
      launchOptions: { pollMs: 20 },
      timers: {
        setTimeout: (callback, ms) => {
          waits.push(ms);
          return setTimeout(callback, 5);
        },
        clearTimeout: (handle) => {
          clearTimeout(handle as NodeJS.Timeout);
        },
      },
    });
    box.loop = loop;
    const end = await loop.done;
    expect(end).toMatchObject({
      ended: "stopped",
      last: { kind: "ended", id: "bpng-1", status: "stopped" },
      verdict: "stopped",
    });
    expect(waits).toEqual([]);
    expect(lines.at(-1)).toBe(
      "bpng no next run: the orchestrator was stopped (SIGINT)",
    );
    const text = await readFile(
      join(stateDir, "runs", "bpng-1", "run.json"),
      "utf8",
    );
    expect(JSON.parse(text)).toMatchObject({
      state: "ended",
      status: "stopped",
    });
  });

  test("two cycles, each recorded and announced, the cooldown between; a stop in the second ends it", async () => {
    const start = new Date(T0);
    const reportDir = (number: number): string =>
      runIdentity({
        taskId: TASK.id,
        product: TASK.product,
        cell: TASK.cell,
        number,
        startedAt: start,
        stateDir,
        checkout,
      }).reportDir;
    const runner = (number: number, status: "passed" | "failed") => ({
      exitCode: status === "passed" ? 0 : 1,
      writes: [
        {
          path: join(reportDir(number), RESULTS_FILE),
          text: streamOf([
            runBegin(1),
            scenarioEnd("a", status),
            runEnd(status, { total: 1, [status]: 1 }),
          ]),
        },
      ],
    });
    const lines: string[] = [];
    const published: RunFinishedEvent[] = [];
    const waits: number[] = [];
    let built = 0;
    const made: { loop?: TaskLoop } = {};
    const loop = runTask(TASK, {
      stateDir,
      checkout,
      launch,
      config: {},
      secrets: [SECRET],
      inherited: { PATH: process.env.PATH },
      commandsFor: () => {
        built += 1;
        return {
          bddgen: fakeCommand({ exitCode: 0 }),
          playwright: fakeCommand(
            runner(built, built === 1 ? "passed" : "failed"),
          ),
        };
      },
      logger: {
        line: (scope, text) => {
          lines.push(`${scope} ${text}`);
        },
      },
      bus: {
        publish: (event) => {
          published.push(event);
        },
      },
      now: () => start,
      launchOptions: { pollMs: 20 },
      timers: {
        // Each cooldown a turn long, its wait kept; the second is where the test stops the loop.
        setTimeout: (callback, ms) => {
          waits.push(ms);
          if (waits.length === 2)
            made.loop?.stop("drained", "the test is over");
          return setTimeout(callback, 5);
        },
        clearTimeout: (handle) => {
          clearTimeout(handle as NodeJS.Timeout);
        },
      },
    });
    made.loop = loop;
    const end = await loop.done;
    expect(end.ended).toBe("stopped");
    expect(end.last).toMatchObject({
      kind: "ended",
      id: "bpng-2",
      status: "failed",
    });
    expect(waits).toEqual([COOLDOWN_MS, COOLDOWN_MS]);
    expect(published.map((event) => [event.run.id, event.status])).toEqual([
      ["bpng-1", "passed"],
      ["bpng-2", "failed"],
    ]);
    for (const [number, status] of [
      [1, "passed"],
      [2, "failed"],
    ] as const) {
      const text = await readFile(
        join(stateDir, "runs", `bpng-${String(number)}`, "run.json"),
        "utf8",
      );
      expect(parseRunRecord(text, `bpng-${String(number)}`).kind).toBe("over");
      expect(JSON.parse(text)).toMatchObject({ state: "ended", status });
    }
    const loopLines = lines.filter((line) =>
      / (next run|bpng-\d started) /.test(line),
    );
    expect(loopLines.map((line) => line.replace(/ · .*/, ""))).toEqual([
      "bpng bpng-1 started",
      "bpng next run 11:14:41 (cooldown 5m)",
      "bpng bpng-2 started",
      "bpng next run 11:14:41 (cooldown 5m)",
    ]);
    expect(lines.at(-1)).toBe("bpng no next run: the test is over");
    expect(built).toBe(2);
  });
});

test.describe("runTask — what the loop tells onActivity", () => {
  test("tells each cooldown with its next run, and how the loop ended", async () => {
    const told: TaskActivity[] = [];
    const r = rig({
      onActivity: (activity) => {
        told.push(activity);
      },
    });
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    expect(told).toEqual([
      {
        kind: "cooling",
        taskId: "bpng",
        nextRunAt: new Date(T0 + COOLDOWN_MS),
      },
    ]);
    r.loop.stop("drained", "the test is over");
    await r.loop.done;
    expect(told.at(-1)).toEqual({
      kind: "loopEnded",
      taskId: "bpng",
      ended: "stopped",
    });
  });

  test("tells a loop that ends before any run, and a --once loop's end", async () => {
    const told: TaskActivity[] = [];
    const listener = (activity: TaskActivity): undefined => {
      told.push(activity);
    };
    const stopped = rig({ onActivity: listener });
    stopped.loop.stop("drained", "at once");
    await stopped.loop.done;
    const once = rig({ onActivity: listener, once: true });
    (await runAt(once, 0)).settle(endedRun("failed"));
    await once.loop.done;
    expect(told).toEqual([
      { kind: "loopEnded", taskId: "bpng", ended: "stopped" },
      { kind: "loopEnded", taskId: "bpng", ended: "once" },
    ]);
  });

  test("an attempt that began no run is told, before its cooldown; one that began is not", async () => {
    const told: TaskActivity[] = [];
    const r = rig({
      onActivity: (activity) => {
        told.push(activity);
      },
    });
    (await runAt(r, 0)).settle({ kind: "notStarted", why: "failed" });
    await turns();
    expect(told.map((a) => a.kind)).toEqual(["notStarted", "cooling"]);
    expect(told[0]).toEqual({
      kind: "notStarted",
      taskId: "bpng",
      why: "failed",
    });
    r.loop.stop("drained", "the test is over");
    await r.loop.done;
    // A runOnce that throws is an attempt that began no run too.
    const thrown: TaskActivity[] = [];
    const throwing = rig({
      onActivity: (activity) => {
        thrown.push(activity);
      },
      runOnce: () => {
        throw new Error("no identity");
      },
    });
    await turns();
    expect(thrown[0]).toEqual({
      kind: "notStarted",
      taskId: "bpng",
      why: "failed",
    });
    throwing.loop.stop("drained", "the test is over");
    await throwing.loop.done;
    // A run that told its begin (then failed: the cycle tells its end) is no attempt that did not start.
    const begun: TaskActivity[] = [];
    const telling = rig({
      onActivity: (activity) => {
        begun.push(activity);
      },
      runOnce: (task, deps) => {
        deps.onActivity?.({
          kind: "begun",
          taskId: task.id,
          id: "bpng-1",
          runId: "RID",
          reportDir: "/r",
          startedAt: new Date(T0),
        });
        return {
          stop: () => undefined,
          done: Promise.resolve({ kind: "notStarted", why: "failed" }),
        };
      },
    });
    await turns();
    expect(begun.map((a) => a.kind)).toEqual(["begun", "cooling"]);
    telling.loop.stop("drained", "the test is over");
    await telling.loop.done;
  });

  test("an onActivity whose promise rejects is a line, never an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const r = rig({
        // Against its type, as an async listener would be where its type is lost.
        onActivity: (() =>
          Promise.reject(
            new Error(`async listener broke ${SECRET}`),
          )) as unknown as LoopDeps["onActivity"],
      });
      (await runAt(r, 0)).settle(endedRun("passed"));
      await turns();
      r.loop.stop("drained", "the test is over");
      await r.loop.done;
      await new Promise((resolve) => setImmediate(resolve));
      expect(r.lines).toContain(
        "bpng telling that its loop cools down failed: async listener broke ***",
      );
      expect(r.lines).toContain(
        "bpng telling that its loop ended failed: async listener broke ***",
      );
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("an onActivity that throws is a line, and the loop goes on", async () => {
    const r = rig({
      onActivity: () => {
        throw new Error(`listener broke ${SECRET}`);
      },
    });
    (await runAt(r, 0)).settle(endedRun("passed"));
    await turns();
    expect(r.timers.live).toHaveLength(1);
    expect(r.lines).toContain(
      "bpng telling that its loop cools down failed: listener broke ***",
    );
    r.loop.stop("drained", "the test is over");
    expect((await r.loop.done).ended).toBe("stopped");
    expect(r.lines).toContain(
      "bpng telling that its loop ended failed: listener broke ***",
    );
  });
});
