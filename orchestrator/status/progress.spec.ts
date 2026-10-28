import { test, expect } from "@playwright/test";

import {
  FIXTURE_RUN_ID,
  runBegin,
  runEnd,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import type {
  ResultsEvent,
  ScenarioBeginEvent,
} from "../../src/common/reporting/results-schema";
import { readRunResults, scenarioCounts } from "../runs/results";
import { NO_PROGRESS, ProgressFold } from "./progress";

/** The progress fold: counts by the stream's own rules, every field checked. */

/**
 * A scenario's attempt began.
 *
 * @param id - its test id.
 * @param attempt - which attempt.
 */
function scenarioBegin(id: string, attempt = 1): ScenarioBeginEvent {
  return {
    v: 1,
    type: "scenario.begin",
    at: "2026-10-13T10:15:31.000Z",
    id,
    project: "pro@nginx",
    feature: "Backups",
    scenario: `Scenario ${id}`,
    attempt,
    parallelIndex: 0,
  };
}

/**
 * The progress after these events.
 *
 * @param events - in order.
 */
function fold(events: readonly ResultsEvent[]) {
  const progress = new ProgressFold();
  progress.apply(events);
  return progress.progress();
}

test.describe("ProgressFold", () => {
  test("before any event, nothing has begun", () => {
    expect(fold([])).toEqual(NO_PROGRESS);
  });

  test("run.begin plans the scenarios and setups; setup.end counts each setup once", () => {
    expect(
      fold([
        runBegin(52),
        setupEnd("auth", "passed"),
        setupEnd("auth", "passed"),
      ]),
    ).toEqual({
      ...NO_PROGRESS,
      begun: true,
      planned: 52,
      setups: 2,
      setupsEnded: 1,
    });
  });

  test("counts each scenario's last end, by status; begun and not ended is running", () => {
    const p = fold([
      runBegin(5),
      scenarioBegin("a"),
      scenarioBegin("b"),
      scenarioBegin("c"),
      scenarioEnd("a", "passed"),
      scenarioEnd("b", "failed"),
      // A later end replaces the earlier: b is counted once, flaky.
      scenarioEnd("b", "flaky"),
      scenarioEnd("d", "skipped", { drained: true }),
      scenarioEnd("e", "interrupted"),
    ]);
    expect(p).toEqual({
      ...NO_PROGRESS,
      begun: true,
      setups: 2,
      planned: 5,
      done: 4,
      passed: 1,
      flaky: 1,
      skipped: 1,
      interrupted: 1,
      stopped: 1,
      running: 1,
    });
  });

  test("every setup that ended counts", () => {
    expect(
      fold([
        runBegin(1),
        setupEnd("auth", "passed"),
        setupEnd("artifacts", "failed"),
      ]).setupsEnded,
    ).toBe(2);
  });

  test("a retry's begin keeps one scenario running, not two", () => {
    const p = fold([runBegin(1), scenarioBegin("a"), scenarioBegin("a", 2)]);
    expect(p.running).toBe(1);
  });

  test("run.end finishes it: nothing runs any more", () => {
    const p = fold([
      runBegin(2),
      scenarioBegin("a"),
      runEnd("interrupted", { total: 2, interrupted: 1 }),
    ]);
    expect(p.finished).toBe(true);
    expect(p.running).toBe(0);
  });

  test("planned is never below what ended", () => {
    expect(
      fold([
        runBegin(1),
        scenarioEnd("a", "passed"),
        scenarioEnd("b", "passed"),
      ]).planned,
    ).toBe(2);
  });

  test("the first run.begin plans; a line of the wrong shape counts nothing", () => {
    const wrong = [
      { ...runBegin(9), scenarios: "nine", setups: -1 },
      { ...scenarioEnd("x", "passed"), status: "great" },
      { ...scenarioEnd("y", "passed"), id: 7 },
      { ...setupEnd("auth", "passed"), id: null },
      { ...scenarioBegin("z"), id: {} },
    ] as unknown as ResultsEvent[];
    const p = fold([...wrong, runBegin(3)]);
    // The first begin counts: its bad fields read as 0.
    expect(p).toEqual({ ...NO_PROGRESS, begun: true });
  });

  test("events applied in pieces count as when applied at once", () => {
    const events = [
      runBegin(3),
      setupEnd("auth", "passed"),
      scenarioBegin("a"),
      scenarioEnd("a", "failed"),
      scenarioBegin("b"),
    ];
    const pieces = new ProgressFold();
    for (const event of events) pieces.apply([event]);
    expect(pieces.progress()).toEqual(fold(events));
  });

  test("counts as run.finished counts: a line the end-of-run reader drops is dropped here too", () => {
    // A scenario's end without its feature and title: the end-of-run reader's schema refuses it.
    const { feature: _f, scenario: _s, ...bare } = scenarioEnd("b", "failed");
    const events = [
      runBegin(2),
      scenarioBegin("a"),
      scenarioEnd("a", "passed"),
      scenarioBegin("b"),
      bare as unknown as ResultsEvent,
    ];
    const counts = scenarioCounts(readRunResults(streamOf(events)));
    const p = fold(events);
    expect(counts).toMatchObject({
      total: 2,
      passed: 1,
      failed: 0,
      didNotRun: 1,
    });
    expect(p).toMatchObject({
      planned: counts.total,
      done: counts.total - counts.didNotRun,
      passed: 1,
      failed: 0,
      // Its end was dropped: as far as the reader knows, it still runs.
      running: 1,
    });
  });

  test("once run.end is read, its counts are the ones shown, as run.finished takes them", () => {
    const p = fold([
      runBegin(5),
      scenarioEnd("a", "passed"),
      runEnd("failed", {
        total: 5,
        passed: 3,
        failed: 1,
        didNotRun: 1,
        drained: 1,
      }),
    ]);
    expect(p).toMatchObject({
      finished: true,
      planned: 5,
      done: 4,
      passed: 3,
      failed: 1,
      stopped: 1,
    });
  });

  test("a stream whose run.begin names another run counts nothing; its own run's counts", () => {
    const other = new ProgressFold(FIXTURE_RUN_ID);
    other.apply([
      runBegin(2, { runId: "another" }),
      setupEnd("auth", "passed"),
      scenarioEnd("a", "failed"),
    ]);
    expect(other.progress()).toEqual(NO_PROGRESS);
    const own = new ProgressFold(FIXTURE_RUN_ID);
    own.apply([runBegin(2), scenarioEnd("a", "failed")]);
    expect(own.progress()).toMatchObject({ begun: true, done: 1, failed: 1 });
    // Unchecked without a run id.
    const unchecked = new ProgressFold();
    unchecked.apply([runBegin(2, { runId: "another" })]);
    expect(unchecked.progress().begun).toBe(true);
  });

  test("past the cap, the progress is unknown: every count 0, and later events count nothing", () => {
    const p = new ProgressFold();
    p.apply([runBegin(3), scenarioEnd("a", "passed")]);
    p.markTooLarge();
    p.apply([scenarioEnd("b", "passed")]);
    expect(p.progress()).toEqual({ ...NO_PROGRESS, tooLarge: true });
  });
});
