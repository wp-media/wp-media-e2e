import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FIXTURE_RUN_ID,
  runBegin,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import { removeTempDir } from "../../src/common/__fixtures__/temp-dir";
import type { TaskActivity } from "../tasks/activity";
import type { CooldownTimers } from "../tasks/loop";
import type { Board } from "./board";
import { NO_PROGRESS } from "./progress";
import { TAIL_START, type TailRead, type TailState } from "./tail";
import {
  createStatusWatch,
  STATUS_POLL_MS,
  UNREF_TIMERS,
  type StatusWatch,
} from "./watch";

/** The status watch: the loops' activity and each run's tail, on fake timers, then on real ones. */

const T0 = new Date(2026, 9, 13, 10, 0, 0);
const TASKS = [
  { id: "bpng", cell: "pro@nginx" },
  { id: "bfap", cell: "free@apache" },
];

/** Timers fired by hand; every one armed is kept. */
class FakeTimers implements CooldownTimers {
  readonly armed: { ms: number; fire: () => void; live: boolean }[] = [];
  /**
   * Arms one.
   *
   * @param callback - what it calls.
   * @param ms - its wait.
   */
  setTimeout(callback: () => void, ms: number): unknown {
    const timer = {
      ms,
      live: true,
      fire: () => {
        timer.live = false;
        callback();
      },
    };
    this.armed.push(timer);
    return timer;
  }
  /**
   * Disarms one.
   *
   * @param handle - its handle.
   */
  clearTimeout(handle: unknown): void {
    (handle as { live: boolean }).live = false;
  }
  /** The timers still armed. */
  get live(): FakeTimers["armed"] {
    return this.armed.filter((t) => t.live);
  }
}

/** A watch over fake timers and a fake reader, and what it showed and read. */
interface Rig {
  readonly watch: StatusWatch;
  readonly shown: Board[];
  readonly reads: { path: string; state: TailState }[];
  readonly timers: FakeTimers;
  /** What the next reads answer, in turn; then no data. */
  readonly answers: (TailRead | Error)[];
}

/**
 * A watch over fakes.
 *
 * @param show - the sink; records by default.
 */
function rig(show?: (board: Board) => undefined): Rig {
  const shown: Board[] = [];
  const reads: Rig["reads"] = [];
  const timers = new FakeTimers();
  const answers: Rig["answers"] = [];
  const watch = createStatusWatch({
    tasks: TASKS,
    show:
      show ??
      ((board) => {
        shown.push(board);
      }),
    timers,
    read: (path, state) => {
      reads.push({ path, state });
      const answer = answers.shift() ?? {
        state,
        events: [],
        skipped: 0,
        reset: false,
      };
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
  });
  return { watch, shown, reads, timers, answers };
}

/**
 * A run's begin.
 *
 * @param id - the run.
 */
function begun(id = "bpng-1", taskId = "bpng"): TaskActivity {
  return {
    kind: "begun",
    taskId,
    id,
    runId: FIXTURE_RUN_ID,
    reportDir: `/r/${id}`,
    startedAt: T0,
  };
}

/** Lets the poll's awaits run. */
async function turns(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * A read that found these events.
 *
 * @param offset - where it ends.
 * @param events - what it found.
 * @param reset - whether it started over.
 */
function found(
  offset: number,
  events: TailRead["events"],
  reset = false,
): TailRead {
  return { state: { offset, skipping: false }, events, skipped: 0, reset };
}

test.describe("createStatusWatch", () => {
  test("shows every task waiting at once, and polls nothing while no run is in flight", () => {
    const r = rig();
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]?.map((t) => t.phase.kind)).toEqual([
      "waiting",
      "waiting",
    ]);
    expect(r.timers.armed).toHaveLength(0);
  });

  test("a run's begin is shown, and its stream polled every interval from its start", async () => {
    const r = rig();
    r.watch.tell(begun());
    expect(r.shown.at(-1)?.[0]?.phase.kind).toBe("run");
    expect(r.timers.live.map((t) => t.ms)).toEqual([STATUS_POLL_MS]);
    r.answers.push(found(100, [runBegin(3), setupEnd("auth", "passed")]));
    r.timers.live[0]?.fire();
    await turns();
    expect(r.reads).toEqual([
      { path: join("/r/bpng-1", "results.jsonl"), state: TAIL_START },
    ]);
    const phase = r.shown.at(-1)?.[0]?.phase;
    expect(phase?.kind === "run" && phase.run.progress).toMatchObject({
      begun: true,
      planned: 3,
      setupsEnded: 1,
    });
    // Re-armed; the next poll goes on from where this one stopped.
    expect(r.timers.live).toHaveLength(1);
    r.timers.live[0]?.fire();
    await turns();
    expect(r.reads[1]?.state).toEqual({ offset: 100, skipping: false });
  });

  test("a truncated stream starts its count over", async () => {
    const r = rig();
    r.watch.tell(begun());
    r.answers.push(found(100, [runBegin(3), setupEnd("auth", "passed")]));
    r.answers.push(found(50, [runBegin(7)], true));
    for (const _ of [1, 2]) {
      r.timers.live[0]?.fire();
      await turns();
    }
    expect(r.watch.board[0]?.phase).toMatchObject({
      run: { progress: { ...NO_PROGRESS, begun: true, planned: 7, setups: 2 } },
    });
  });

  test("a run's end drops its tail: no poll is armed, and a read in flight leaves the ended row as it is", async () => {
    const r = rig();
    r.watch.tell(begun());
    let release!: (read: TailRead) => void;
    r.answers.length = 0;
    const watch = createStatusWatch({
      tasks: TASKS,
      show: () => undefined,
      timers: r.timers,
      read: () =>
        new Promise<TailRead>((resolve) => {
          release = resolve;
        }),
    });
    watch.tell(begun());
    r.timers.live.at(-1)?.fire();
    watch.tell({
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "passed",
      endedAt: T0,
    });
    release(found(10, [runBegin(3)]));
    await turns();
    expect(watch.board[0]?.phase.kind).toBe("ended");
    expect(watch.board[0]?.last?.status).toBe("passed");
    watch.stop();
    r.watch.stop();
    expect(r.timers.live).toHaveLength(0);
  });

  test("once its run ended, a tail is never read again, and no poll is armed for nothing", async () => {
    const r = rig();
    r.watch.tell(begun());
    r.watch.tell({
      kind: "ended",
      taskId: "bpng",
      id: "bpng-1",
      status: "passed",
      endedAt: T0,
    });
    // The timer armed at the begin still fires once: it reads nothing, and arms nothing.
    r.timers.live[0]?.fire();
    await turns();
    expect(r.reads).toEqual([]);
    expect(r.timers.live).toHaveLength(0);
  });

  test("a read that settles after the stop changes nothing", async () => {
    let release!: (read: TailRead) => void;
    const timers = new FakeTimers();
    const watch = createStatusWatch({
      tasks: TASKS,
      show: () => undefined,
      timers,
      read: () =>
        new Promise<TailRead>((resolve) => {
          release = resolve;
        }),
    });
    watch.tell(begun());
    timers.live[0]?.fire();
    watch.stop();
    const board = watch.board;
    release(found(10, [runBegin(3)]));
    await turns();
    expect(watch.board).toBe(board);
    expect(timers.live).toHaveLength(0);
  });

  test("stop never waits for a read that never settles, and the poll reads no further tail", async () => {
    const reads: string[] = [];
    const timers = new FakeTimers();
    const shown: Board[] = [];
    const watch = createStatusWatch({
      tasks: TASKS,
      show: (board) => {
        shown.push(board);
      },
      timers,
      read: (path) => {
        reads.push(path);
        // Never settles: a FIFO opened blocking, a hung mount.
        return new Promise<TailRead>(() => undefined);
      },
    });
    watch.tell(begun());
    watch.tell(begun("bfap-1", "bfap"));
    timers.live[0]?.fire();
    await turns();
    expect(reads).toEqual([join("/r/bpng-1", "results.jsonl")]);
    const count = shown.length;
    // Synchronous: returns with the read still pending.
    watch.stop();
    await turns();
    expect(reads).toHaveLength(1);
    expect(shown).toHaveLength(count);
    expect(timers.live).toHaveLength(0);
  });

  test("once stopped mid-poll, the runs left in that poll are not read", async () => {
    let release!: (read: TailRead) => void;
    const reads: string[] = [];
    const timers = new FakeTimers();
    const watch = createStatusWatch({
      tasks: TASKS,
      show: () => undefined,
      timers,
      read: (path, state) => {
        reads.push(path);
        return new Promise<TailRead>((resolve) => {
          release = () => {
            resolve({ state, events: [], skipped: 0, reset: false });
          };
        });
      },
    });
    watch.tell(begun());
    watch.tell(begun("bfap-1", "bfap"));
    timers.live[0]?.fire();
    await turns();
    watch.stop();
    release(found(0, []));
    await turns();
    expect(reads).toHaveLength(1);
  });

  test("two runs in flight share one timer and one poll at a time: never two reads at once", async () => {
    let inFlight = 0;
    let most = 0;
    const reads: string[] = [];
    const timers = new FakeTimers();
    const watch = createStatusWatch({
      tasks: TASKS,
      show: () => undefined,
      timers,
      read: async (path, state) => {
        reads.push(path);
        inFlight += 1;
        most = Math.max(most, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { state, events: [], skipped: 0, reset: false };
      },
    });
    watch.tell(begun());
    expect(timers.live).toHaveLength(1);
    timers.live[0]?.fire();
    // A begin told while the poll runs arms nothing more: one poll at a time.
    watch.tell(begun("bfap-1", "bfap"));
    expect(timers.live).toHaveLength(0);
    await turns();
    expect(timers.live).toHaveLength(1);
    // Both runs, one after the other, from one timer.
    timers.live[0]?.fire();
    await turns();
    expect(reads).toEqual([
      join("/r/bpng-1", "results.jsonl"),
      join("/r/bpng-1", "results.jsonl"),
      join("/r/bfap-1", "results.jsonl"),
    ]);
    expect(most).toBe(1);
    expect(timers.live).toHaveLength(1);
    watch.stop();
  });

  test("two runs begun before a poll arm one timer, never two", () => {
    const r = rig();
    r.watch.tell(begun());
    r.watch.tell(begun("bfap-1", "bfap"));
    expect(r.timers.armed).toHaveLength(1);
    r.watch.stop();
  });

  test("a stream past the cap shows its progress unknown and is read no more", async () => {
    const r = rig();
    r.watch.tell(begun());
    r.answers.push(found(100, [runBegin(3)]));
    r.answers.push({ ...found(100, []), tooLarge: true });
    for (const _ of [1, 2]) {
      r.timers.live[0]?.fire();
      await turns();
    }
    expect(r.watch.board[0]?.phase).toMatchObject({
      run: { progress: { ...NO_PROGRESS, tooLarge: true } },
    });
    // Its only run is no longer read: no poll is armed.
    expect(r.reads).toHaveLength(2);
    expect(r.timers.live).toHaveLength(0);
    r.watch.stop();
  });

  test("a stream past the cap is read no more while another run's still is", async () => {
    const r = rig();
    r.watch.tell(begun());
    r.watch.tell(begun("bfap-1", "bfap"));
    r.answers.push({ ...found(0, []), tooLarge: true });
    for (const _ of [1, 2]) {
      r.timers.live[0]?.fire();
      await turns();
    }
    expect(r.reads.map((read) => read.path)).toEqual([
      join("/r/bpng-1", "results.jsonl"),
      join("/r/bfap-1", "results.jsonl"),
      join("/r/bfap-1", "results.jsonl"),
    ]);
    r.watch.stop();
  });

  test("a stream whose run.begin names another run counts nothing", async () => {
    const r = rig();
    r.watch.tell(begun());
    r.answers.push(found(100, [runBegin(3, { runId: "someone-else" })]));
    r.timers.live[0]?.fire();
    await turns();
    expect(r.watch.board[0]?.phase).toMatchObject({
      run: { progress: NO_PROGRESS },
    });
    r.watch.stop();
  });

  test("a sink whose promise rejects costs nothing: no unhandled rejection, the board still shown", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      let calls = 0;
      const timers = new FakeTimers();
      const watch = createStatusWatch({
        tasks: TASKS,
        // Against its type, as an async sink would be where its type is lost.
        show: (() => {
          calls += 1;
          return Promise.reject(new Error("async sink broke"));
        }) as unknown as (board: Board) => undefined,
        timers,
        read: (_path, state) =>
          Promise.resolve({ state, events: [], skipped: 0, reset: false }),
      });
      watch.tell(begun());
      timers.live[0]?.fire();
      await delay(20);
      expect(calls).toBe(3);
      expect(unhandled).toEqual([]);
      watch.stop();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("its default timers never keep the process alive", () => {
    const handle = UNREF_TIMERS.setTimeout(() => undefined, 60_000);
    try {
      expect((handle as NodeJS.Timeout).hasRef()).toBe(false);
    } finally {
      UNREF_TIMERS.clearTimeout(handle);
    }
  });

  test("a read that rejects and a sink that throws cost nothing: polling goes on", async () => {
    const r = rig(() => {
      throw new Error("sink broke");
    });
    r.watch.tell(begun());
    r.answers.push(new Error("read broke"));
    r.timers.live[0]?.fire();
    await turns();
    expect(r.timers.live).toHaveLength(1);
    r.watch.stop();
  });

  test("stop clears the armed timer and shows nothing after; a second stop does nothing", () => {
    const r = rig();
    r.watch.tell(begun());
    expect(r.timers.live).toHaveLength(1);
    const count = r.shown.length;
    r.watch.stop();
    expect(r.timers.live).toHaveLength(0);
    r.watch.tell(begun("bpng-2"));
    expect(r.shown).toHaveLength(count);
    expect(r.timers.live).toHaveLength(0);
    r.watch.stop();
    expect(r.timers.live).toHaveLength(0);
  });

  test("timers that cannot arm leave the table to the loops' activity", () => {
    const shown: Board[] = [];
    const watch = createStatusWatch({
      tasks: TASKS,
      show: (board) => {
        shown.push(board);
      },
      timers: {
        setTimeout: () => {
          throw new Error("no timers");
        },
        clearTimeout: () => undefined,
      },
    });
    watch.tell(begun());
    expect(shown.at(-1)?.[0]?.phase.kind).toBe("run");
  });
});

test.describe("createStatusWatch — a real stream, real timers", () => {
  let dir = "";
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-watch-"));
  });
  test.afterEach(() => {
    removeTempDir(dir);
  });

  test("follows a stream that appears after the run began, then leaves no timer", async () => {
    const timeouts = (): number =>
      process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
    const baseline = timeouts();
    const shown: Board[] = [];
    const watch = createStatusWatch({
      tasks: TASKS,
      show: (board) => {
        shown.push(board);
      },
      pollMs: 10,
    });
    watch.tell({
      kind: "begun",
      taskId: "bpng",
      id: "bpng-1",
      runId: FIXTURE_RUN_ID,
      reportDir: dir,
      startedAt: T0,
    });
    await delay(40);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "results.jsonl"),
      streamOf([runBegin(4), setupEnd("auth", "passed")]),
    );
    await expect
      .poll(() => {
        const phase = watch.board[0]?.phase;
        return phase?.kind === "run" ? phase.run.progress.setupsEnded : -1;
      })
      .toBe(1);
    watch.stop();
    const shownAtStop = shown.length;
    await delay(40);
    expect(shown).toHaveLength(shownAtStop);
    expect(timeouts()).toBeLessThanOrEqual(baseline);
  });
});
