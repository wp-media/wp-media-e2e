import { test, expect } from "@playwright/test";

import { ConfigError } from "./config/errors";
import { DEFAULT_SHUTDOWN_BUDGETS } from "./runs/shutdown";
import {
  escalationLine,
  gaveUpLine,
  leftBehindLine,
  leftoverLines,
  loopsExitCode,
  selectTasks,
  staleLine,
  startedLine,
} from "./start-lines";
import type { TaskEnd } from "./tasks/loop";

/** Tasks as the config check joins them: only the id is read. */
const TASKS = ["bpng", "bfap", "k7qx"].map((id) => ({ task: { id } }));

test.describe("selectTasks", () => {
  test("every task when --task names none", () => {
    expect(selectTasks(TASKS, undefined, "/c.json")).toEqual(TASKS);
    expect(selectTasks(TASKS, [], "/c.json")).toEqual(TASKS);
  });

  test("the tasks named, in the config's order, each once", () => {
    expect(selectTasks(TASKS, ["k7qx", "bpng", "k7qx"], "/c.json")).toEqual([
      TASKS[0],
      TASKS[2],
    ]);
  });

  test("an id that is no task refuses, naming each unknown id once and the config's tasks", () => {
    const select = (): unknown =>
      selectTasks(TASKS, ["bpng", "zzzz", "-x\nq", "zzzz"], "/c.json");
    expect(select).toThrow(ConfigError);
    expect(select).toThrow(
      '--task names no task of /c.json: "zzzz", "-x\\nq"; its tasks: bpng, bfap, k7qx',
    );
  });

  test("a long unknown id is cut", () => {
    expect(() => selectTasks(TASKS, ["a".repeat(500)], "/c.json")).toThrow(
      /: "a{38}…; its tasks/,
    );
  });
});

test.describe("lines", () => {
  test("started: the suite's version, the tasks, --once, the state directory and the pid", () => {
    expect(
      startedLine("1.1.0", ["bpng", "bfap"], false, ".orchestrator", 42),
    ).toBe(
      "started · suite 1.1.0 · 2 tasks (bpng, bfap) · .orchestrator/ · pid 42",
    );
    expect(startedLine("2.0.0-rc.1+b7", ["bpng"], true, "/srv/state", 7)).toBe(
      "started · suite 2.0.0-rc.1+b7 · 1 task (bpng) · once · /srv/state/ · pid 7",
    );
  });

  test("started: a suite version that could not be read is unknown", () => {
    expect(startedLine(undefined, ["bpng"], true, ".orchestrator", 7)).toBe(
      "started · suite unknown · 1 task (bpng) · once · .orchestrator/ · pid 7",
    );
  });

  test("each escalation says what happens now and what comes next, with the budgets", () => {
    const budgets = { drainMs: 15 * 60_000, interruptMs: 90_000 };
    expect(escalationLine("drained", "why", budgets)).toBe(
      "stopping: why — no new run; every run finishes its scenario in progress. Ctrl-C again to interrupt them; interrupted anyway after 15 min",
    );
    expect(escalationLine("interrupted", "why", budgets)).toBe(
      "interrupting every run: why. Ctrl-C again to kill them; killed anyway after 90 s",
    );
    expect(escalationLine("killed", "why", DEFAULT_SHUTDOWN_BUDGETS)).toBe(
      "killing every run: why",
    );
  });

  test("giving up names the tasks and the wait, in ms under a second", () => {
    expect(gaveUpLine(["bpng", "bfap"], 60_000)).toBe(
      "stopped waiting: bpng, bfap did not end within 1 min of the kill",
    );
    expect(gaveUpLine(["bpng"], 300)).toBe(
      "stopped waiting: bpng did not end within 300 ms of the kill",
    );
  });

  test("a run left behind: the kill command only for a group shown to be the run's", () => {
    const log = "/my state/runs/bpng-12/run.log";
    expect(
      leftBehindLine(
        "bpng-12",
        { kind: "orphan", pgid: 4242, confirmed: true },
        log,
      ),
    ).toBe(
      "bpng-12 left behind, still running in process group 4242: end it with kill -KILL -4242",
    );
    expect(
      leftBehindLine(
        "bpng-12",
        {
          kind: "orphan",
          pgid: 4242,
          confirmed: false,
          why: "its leader's start cannot be read now (x)",
        },
        log,
      ),
    ).toBe(
      "bpng-12 may be left behind in process group 4242 — unconfirmed: its leader's start cannot be read now (x). Check it first: ps -o pid,user,lstart,command -g 4242",
    );
    expect(
      leftBehindLine(
        "bpng-12",
        { kind: "orphan", confirmed: false, why: "starting" },
        log,
      ),
    ).toBe(
      "bpng-12 may be left behind — unconfirmed: starting. lsof -- '/my state/runs/bpng-12/run.log' lists its processes",
    );
    for (const reason of [
      "process group ended",
      "leader differs",
      "no process recorded",
    ] as const) {
      const line = leftBehindLine("bpng-12", { kind: "stale", reason }, log);
      expect(line).toBe(
        `bpng-12 left nothing to kill (${reason}): its loop is stuck after its processes, reading, recording or announcing its end`,
      );
      expect(line).not.toContain("kill -KILL");
    }
  });

  test("leftovers: a count of those removed, one line per failure; nothing when none", () => {
    expect(leftoverLines({ removed: [], failed: [] })).toEqual([]);
    expect(leftoverLines({ removed: ["/a"], failed: [] })).toEqual([
      "removed 1 file an earlier crash left",
    ]);
    expect(
      leftoverLines({
        removed: ["/a", "/b"],
        failed: [{ path: "/c\nd", code: "EACCES" }],
      }),
    ).toEqual([
      "removed 2 files an earlier crash left",
      "could not remove /c d, an earlier crash's (EACCES)",
    ]);
  });

  test("a stale run: why, and whether it was marked lost", () => {
    expect(
      staleLine({
        id: "bpng-3",
        reason: "process group ended",
        rewritten: true,
      }),
    ).toBe(
      "run bpng-3 was left running and found over (process group ended): marked lost",
    );
    expect(
      staleLine({ id: "bpng-3", reason: "leader differs", rewritten: false }),
    ).toBe(
      "run bpng-3 was left running and found over (leader differs): not marked lost, read again at the next start",
    );
  });
});

test.describe("loopsExitCode", () => {
  const end = (verdict: TaskEnd["verdict"]): TaskEnd => ({
    ended: "once",
    verdict,
  });

  test("130 whenever signalled, whatever the loops said or whether they ended", () => {
    expect(
      loopsExitCode({ signalled: true, once: true, ends: [end("passed")] }),
    ).toBe(130);
    expect(loopsExitCode({ signalled: true, once: false })).toBe(130);
  });

  test("with --once: the loops' verdicts", () => {
    expect(
      loopsExitCode({
        signalled: false,
        once: true,
        ends: [end("passed"), end("passed")],
      }),
    ).toBe(0);
    expect(
      loopsExitCode({
        signalled: false,
        once: true,
        ends: [end("passed"), end("failed")],
      }),
    ).toBe(1);
  });

  test("without --once, loops that ended unsignalled are 1, whatever their verdicts", () => {
    expect(
      loopsExitCode({ signalled: false, once: false, ends: [end("passed")] }),
    ).toBe(1);
  });

  test("without --once, loops that ended unsignalled broke: 1; so is a wait given up unsignalled", () => {
    expect(
      loopsExitCode({
        signalled: false,
        once: false,
        ends: [{ ended: "failed", verdict: "failed" }],
      }),
    ).toBe(1);
    expect(loopsExitCode({ signalled: false, once: true })).toBe(1);
  });
});
