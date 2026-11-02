import { test, expect } from "@playwright/test";

import type { TaskActivity } from "../tasks/activity";
import {
  applyActivity,
  applyProgress,
  createBoard,
  liveRuns,
  runState,
  type Board,
  type LiveRun,
} from "./board";
import { NO_PROGRESS, type RunProgress } from "./progress";

/** The board's state machine: the loop's activity and a run's progress, per task. */

const T0 = new Date(2026, 9, 13, 10, 0, 0);
const TASKS = [
  { id: "bpng", cell: "pro@nginx" },
  { id: "bfap", cell: "free@apache" },
];

/**
 * A run's begin.
 *
 * @param id - the run.
 * @param taskId - its task.
 */
function begun(id = "bpng-1", taskId = "bpng"): TaskActivity {
  return {
    kind: "begun",
    taskId,
    id,
    runId: `RID-${id}`,
    reportDir: `/r/${id}`,
    startedAt: T0,
  };
}

/**
 * The board after these activities.
 *
 * @param activities - in order.
 */
function after(...activities: TaskActivity[]): Board {
  return activities.reduce(applyActivity, createBoard(TASKS));
}

/**
 * Progress with these fields.
 *
 * @param given - what differs from none.
 */
function progress(given: Partial<RunProgress>): RunProgress {
  return { ...NO_PROGRESS, ...given };
}

test.describe("the board's phases", () => {
  test("every task starts waiting, in the config's order", () => {
    expect(createBoard(TASKS).map((t) => [t.taskId, t.phase.kind])).toEqual([
      ["bpng", "waiting"],
      ["bfap", "waiting"],
    ]);
  });

  test("waiting → run → ended → cooling → run → over", () => {
    let board = after(begun());
    expect(board[0]?.phase.kind).toBe("run");
    board = applyActivity(board, {
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "passed",
      endedAt: new Date(T0.getTime() + 65_000),
      scenarios: 52,
    });
    expect(board[0]?.phase.kind).toBe("ended");
    expect(board[0]?.last).toEqual({
      id: "bpng-1",
      status: "passed",
      durationMs: 65_000,
      scenarios: 52,
    });
    const next = new Date(T0.getTime() + 300_000);
    board = applyActivity(board, {
      kind: "cooling",
      taskId: "bpng",
      nextRunAt: next,
    });
    expect(board[0]?.phase).toEqual({ kind: "cooling", nextRunAt: next });
    board = applyActivity(board, begun("bpng-2"));
    expect(board[0]?.phase.kind).toBe("run");
    // The last run is kept while the next one runs.
    expect(board[0]?.last?.id).toBe("bpng-1");
    board = applyActivity(board, {
      kind: "loopEnded",
      taskId: "bpng",
      ended: "stopped",
    });
    expect(board[0]?.phase).toEqual({ kind: "over", ended: "stopped" });
    // The other task never moved.
    expect(board[1]?.phase.kind).toBe("waiting");
  });

  test("a stop marks the run in flight stopping; an end without a known start keeps no duration", () => {
    let board = after(begun(), {
      kind: "stopping",
      taskId: "bpng",
      id: "bpng-1",
      level: "drained",
    });
    const phase = board[0]?.phase;
    expect(phase?.kind === "run" && phase.run.stopping).toBe(true);
    board = applyActivity(board, {
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "stopped",
      endedAt: new Date(NaN),
    });
    expect(board[0]?.last).toEqual({ id: "bpng-1", status: "stopped" });
  });

  test("a clock stepped back makes a run's duration 0, never negative", () => {
    const board = applyActivity(after(begun()), {
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "passed",
      endedAt: new Date(T0.getTime() - 5_000),
    });
    expect(board[0]?.last?.durationMs).toBe(0);
  });

  test("activities that do not fit leave the board as it is — the same object", () => {
    const board = after(begun());
    const ignored: TaskActivity[] = [
      // Another run's stop and end: late, or repeated.
      { kind: "stopping", taskId: "bpng", id: "bpng-9", level: "killed" },
      {
        kind: "ended",
        taskId: "bpng",
        id: "bpng-9",
        status: "passed",
        endedAt: T0,
      },
      // A task the board does not hold.
      begun("zzzz-1", "zzzz"),
    ];
    for (const activity of ignored)
      expect(applyActivity(board, activity)).toBe(board);
    const stopping = applyActivity(board, {
      kind: "stopping",
      taskId: "bpng",
      id: "bpng-1",
      level: "drained",
    });
    // Told again at the same level: nothing changes.
    expect(
      applyActivity(stopping, {
        kind: "stopping",
        taskId: "bpng",
        id: "bpng-1",
        level: "drained",
      }),
    ).toBe(stopping);
  });

  test("a stop's level is the one in force: an escalation is kept", () => {
    const stop = (level: "drained" | "killed"): TaskActivity => ({
      kind: "stopping",
      taskId: "bpng",
      id: "bpng-1",
      level,
    });
    const board = after(begun(), stop("drained"), stop("killed"));
    expect(liveRuns(board)[0]).toMatchObject({
      stopping: true,
      stopLevel: "killed",
    });
  });

  test("an attempt that began no run marks its task until the next begin, from any phase but over", () => {
    const notStarted: TaskActivity = {
      kind: "notStarted",
      taskId: "bpng",
      why: "failed",
    };
    const cooling: TaskActivity = {
      kind: "cooling",
      taskId: "bpng",
      nextRunAt: T0,
    };
    // waiting → cooling, the mark kept; cooling → cooling, kept.
    let board = after(notStarted, cooling);
    expect(board[0]).toMatchObject({
      phase: { kind: "cooling" },
      notStarted: "failed",
    });
    board = [notStarted, cooling].reduce(applyActivity, board);
    expect(board[0]).toMatchObject({
      phase: { kind: "cooling" },
      notStarted: "failed",
    });
    // Told again: the same object.
    expect(applyActivity(board, notStarted)).toBe(board);
    // A run that begins clears it; its end keeps it cleared.
    board = applyActivity(board, begun("bpng-2"));
    expect(board[0]?.notStarted).toBeUndefined();
    // After a run that ended, the next attempt that did not start is marked over the last run.
    board = [
      {
        kind: "ended",
        taskId: "bpng",
        id: "bpng-2",
        status: "passed",
        endedAt: T0,
      } as const,
      cooling,
      { ...notStarted, why: "stopped" } as const,
    ].reduce(applyActivity, board);
    expect(board[0]).toMatchObject({
      notStarted: "stopped",
      last: { id: "bpng-2", status: "passed" },
    });
    const over = applyActivity(board, {
      kind: "loopEnded",
      taskId: "bpng",
      ended: "stopped",
    });
    expect(applyActivity(over, notStarted)).toBe(over);
  });

  test("once its loop is over, a task neither begins nor cools down again", () => {
    const over = after({ kind: "loopEnded", taskId: "bpng", ended: "once" });
    expect(applyActivity(over, begun())).toBe(over);
    expect(
      applyActivity(over, { kind: "cooling", taskId: "bpng", nextRunAt: T0 }),
    ).toBe(over);
  });

  test("progress reaches only the run in flight it belongs to", () => {
    const board = after(begun());
    const moved = applyProgress(
      board,
      "bpng",
      "bpng-1",
      progress({ begun: true }),
    );
    expect(liveRuns(moved)[0]?.progress.begun).toBe(true);
    expect(
      applyProgress(board, "bpng", "bpng-0", progress({ begun: true })),
    ).toBe(board);
    expect(
      applyProgress(board, "bfap", "bpng-1", progress({ begun: true })),
    ).toBe(board);
  });

  test("liveRuns lists each run in flight with its task", () => {
    const board = after(begun(), begun("bfap-3", "bfap"));
    expect(liveRuns(board).map((r) => [r.taskId, r.id, r.reportDir])).toEqual([
      ["bpng", "bpng-1", "/r/bpng-1"],
      ["bfap", "bfap-3", "/r/bfap-3"],
    ]);
  });
});

test.describe("runState", () => {
  /**
   * A run with this progress.
   *
   * @param given - its progress.
   * @param stopping - whether a stop reached it.
   */
  function run(given: Partial<RunProgress>, stopping = false): LiveRun {
    return {
      id: "bpng-1",
      reportDir: "/r",
      startedAt: T0,
      stopping,
      progress: progress(given),
    };
  }

  test("starting before run.begin", () => {
    expect(runState(run({}))).toEqual({ kind: "starting" });
  });

  test("setup n/m while setups end and no scenario has begun", () => {
    expect(runState(run({ begun: true, setups: 2, setupsEnded: 1 }))).toEqual({
      kind: "setup",
      ended: 1,
      total: 2,
    });
    expect(runState(run({ begun: true, setups: 2 }))).toEqual({
      kind: "setup",
      ended: 0,
      total: 2,
    });
  });

  test("running once every setup ended, a scenario began or one ended", () => {
    expect(runState(run({ begun: true, setups: 2, setupsEnded: 2 }))).toEqual({
      kind: "running",
    });
    expect(runState(run({ begun: true, setups: 0 }))).toEqual({
      kind: "running",
    });
    expect(
      runState(run({ begun: true, setups: 2, setupsEnded: 1, running: 1 })),
    ).toEqual({ kind: "running" });
    expect(
      runState(run({ begun: true, setups: 2, setupsEnded: 1, done: 1 })),
    ).toEqual({ kind: "running" });
  });

  test("never setup once run.end was read: setups that never ended never will", () => {
    expect(
      runState(run({ begun: true, finished: true, setups: 2, setupsEnded: 1 })),
    ).toEqual({ kind: "running" });
  });

  test("running, never starting, once the stream is past the cap", () => {
    expect(runState(run({ tooLarge: true }))).toEqual({ kind: "running" });
  });

  test("stopping whatever the stream says", () => {
    expect(runState(run({}, true))).toEqual({ kind: "stopping" });
    expect(runState(run({ begun: true, setups: 2 }, true))).toEqual({
      kind: "stopping",
    });
  });
});
