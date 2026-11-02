import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FullConfig, Suite } from "@playwright/test/reporter";

import {
  addAttempt,
  afterHooks,
  beforeHooks,
  beginningAttempt,
  captureWrites,
  fakeSuite,
  fakeTest,
  step,
} from "../__fixtures__/reporter-fakes";
import { STOPPED_ANNOTATION } from "../config/drain";
import { RunTally } from "./results";
import { parseResults } from "./results-reader";
import { RESULTS_FILE, type ResultsEvent } from "./results-schema";
import ResultsStreamReporter, {
  JsonLinesFile,
  endEvent,
  retryEvent,
  runBeginEvent,
  runEndEvent,
  scenarioBeginEvent,
} from "./results-stream";
import type { RunDescription } from "./run-description";
import { registerTerminalSink } from "./terminal-sink";

/**
 * The results stream: the events each reporter call makes, the file they go to, and the reporter as
 * a whole, driven with fake tests into a temporary folder — order, counts, `didNotRun`, and a write
 * that fails without failing the run.
 */

let work = "";

test.beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "e2e-results-"));
});

test.afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** A run description writing into `reportPath`. */
function runIn(reportPath: string): RunDescription {
  return {
    product: "demo",
    cell: "x",
    edition: "pro",
    pinned: true,
    runId: "run-1",
    reportCell: "x",
    reportDir: "reports/demo/x/run-1",
    reportPath,
  };
}

/** A resolved config with a cell's three projects. */
const CONFIG = {
  workers: 2,
  metadata: { actualWorkers: 1 },
  projects: [
    { name: "setup:x", retries: 0 },
    { name: "artifacts:x", retries: 0 },
    { name: "x", retries: 2 },
  ],
} as unknown as FullConfig;

/**
 * The event the reporter writes for an ended attempt: a retry when one is due, else the test's end —
 * as its `onTestEnd` decides, through a ledger.
 */
function eventFor(
  test: Parameters<typeof endEvent>[0],
  result: Parameters<typeof endEvent>[1],
): ReturnType<typeof retryEvent> {
  const verdict = new RunTally().attemptEnded(test, result);
  return verdict.final
    ? endEvent(test, result, verdict.status)
    : retryEvent(test, result);
}

/** The events a stream file holds, every line checked complete. */
function eventsIn(path: string): ResultsEvent[] {
  const text = readFileSync(path, "utf8");
  const { events, skipped, rest } = parseResults(text);
  expect(skipped).toBe(0);
  expect(rest).toBe("");
  return [...events];
}

test.describe("JsonLinesFile", () => {
  test("creates its folder and a fresh file with the first line, then appends, each line stamped", () => {
    const path = join(work, "deep", "run", RESULTS_FILE);
    mkdirSync(join(work, "deep", "run"), { recursive: true });
    writeFileSync(path, "an earlier run's line\n");
    const file = new JsonLinesFile(
      path,
      () => undefined,
      () => new Date("2026-10-12T00:00:00.000Z"),
    );

    file.write({ type: "run.error", message: "one" });
    file.write({ type: "run.error", message: "two" });

    const lines = readFileSync(path, "utf8").split("\n");
    expect(lines).toEqual([
      '{"v":1,"type":"run.error","at":"2026-10-12T00:00:00.000Z","message":"one"}',
      '{"v":1,"type":"run.error","at":"2026-10-12T00:00:00.000Z","message":"two"}',
      "",
    ]);
  });

  test("a path it cannot write warns once, never throws, and keeps trying", () => {
    // A folder where the file should be: every write fails with EISDIR.
    const path = join(work, RESULTS_FILE);
    mkdirSync(path);
    const warnings: string[] = [];
    const file = new JsonLinesFile(path, (message) => warnings.push(message));

    expect(() => {
      file.write({ type: "run.error", message: "one" });
      file.write({ type: "run.error", message: "two" });
    }).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /^\[results\] could not write .*results\.jsonl: .*EISDIR/,
    );
    expect(warnings[0]).toContain(
      "The run goes on without its results stream.",
    );

    // Once the path is writable, the stream resumes.
    rmSync(path, { recursive: true });
    file.write({ type: "run.error", message: "three" });
    expect(readFileSync(path, "utf8")).toContain('"message":"three"');
  });

  test("after a failed write, the next line starts on a fresh one", () => {
    const path = join(work, RESULTS_FILE);
    const file = new JsonLinesFile(path, () => undefined);
    file.write({ type: "run.error", message: "one" });
    // The file vanishes and a folder takes its place: the append fails…
    rmSync(path);
    mkdirSync(path);
    file.write({ type: "run.error", message: "lost" });
    // …and, had it written part of its line, the next one must not be glued to it.
    rmSync(path, { recursive: true });
    writeFileSync(path, '{"v":1,"type":"run.er');
    file.write({ type: "run.error", message: "three" });
    file.write({ type: "run.error", message: "four" });

    const { events, skipped } = parseResults(readFileSync(path, "utf8"));
    expect(
      events.map((e) => (e.type === "run.error" ? e.message : "")),
    ).toEqual(["three", "four"]);
    expect(skipped).toBe(1);
  });

  test("its default warning goes through the run's terminal sink when there is one, never stderr", () => {
    const path = join(work, RESULTS_FILE);
    mkdirSync(path);
    const printed: string[] = [];
    const unregister = registerTerminalSink({
      print: (text) => printed.push(text),
    });
    try {
      const file = new JsonLinesFile(path);
      const stderr = captureWrites(process.stderr, () => {
        file.write({ type: "run.error", message: "one" });
      });
      expect(stderr).toEqual([]);
      expect(printed).toHaveLength(1);
      expect(printed[0]).toMatch(/^\[results\] could not write .*EISDIR/);
    } finally {
      unregister();
    }
    // With no sink, stderr, as before.
    const alone = new JsonLinesFile(path);
    expect(
      captureWrites(process.stderr, () => {
        alone.write({ type: "run.error", message: "two" });
      }),
    ).toEqual([expect.stringMatching(/^\[results\] could not write .*\n$/)]);
  });

  test("a warning that itself throws is swallowed", () => {
    const path = join(work, RESULTS_FILE);
    mkdirSync(path);
    const file = new JsonLinesFile(path, () => {
      throw new Error("stderr closed");
    });
    expect(() => {
      file.write({ type: "run.error", message: "one" });
    }).not.toThrow();
  });
});

test.describe("the events", () => {
  test("run.begin: the run's facts, scenarios and setups apart, the scenarios' retries", () => {
    const tally = new RunTally();
    tally.begin([
      fakeTest({ project: "setup:x" }).test,
      fakeTest({ project: "artifacts:x" }).test,
      fakeTest({ id: "1" }).test,
    ]);
    expect(runBeginEvent(runIn(work), "test", CONFIG, tally)).toEqual({
      type: "run.begin",
      runId: "run-1",
      product: "demo",
      cell: "x",
      edition: "pro",
      mode: "test",
      scenarios: 1,
      setups: 2,
      retries: 2,
      workers: 1,
    });
  });

  test("run.begin of a run of every cell names no cell and no edition", () => {
    const { cell: _cell, edition: _edition, ...rest } = runIn(work);
    const event = runBeginEvent(
      { ...rest, reportCell: "_all" },
      "list",
      CONFIG,
      new RunTally(),
    );
    expect(event).not.toHaveProperty("cell");
    expect(event).not.toHaveProperty("edition");
    expect(event.mode).toBe("list");
  });

  test("scenario.begin: the attempt, numbered from 1, and its worker slot; none for a setup", () => {
    const fake = fakeTest({ retries: 1 });
    addAttempt(fake, { status: "failed" });
    expect(scenarioBeginEvent(fake.test, beginningAttempt(fake, 1))).toEqual({
      type: "scenario.begin",
      id: "test-1",
      project: "x",
      feature: "Demo feature",
      scenario: "A scenario",
      attempt: 2,
      parallelIndex: 1,
    });
    const setup = fakeTest({ project: "setup:x" });
    expect(
      scenarioBeginEvent(setup.test, beginningAttempt(setup)),
    ).toBeUndefined();
  });

  test("a failed attempt with a retry left is scenario.retry, with its error", () => {
    const fake = fakeTest({ retries: 1 });
    const result = addAttempt(fake, {
      status: "failed",
      errors: ["Error: first"],
      steps: [
        beforeHooks(),
        step("Given it fails once", "test.step", { error: "Error: first" }),
      ],
      duration: 250,
    });
    expect(eventFor(fake.test, result)).toEqual({
      type: "scenario.retry",
      id: "test-1",
      attempt: 1,
      attemptStatus: "failed",
      durationMs: 250,
      error: {
        message: "Error: first",
        where: "step",
        step: "Given it fails once",
      },
    });
  });

  test("a failed last attempt is scenario.end: where it sits, its tags, attempts, summed time, error", () => {
    const fake = fakeTest({ retries: 1, tags: ["@plugin"] });
    addAttempt(fake, {
      status: "failed",
      errors: ["Error: one"],
      duration: 100,
    });
    const last = addAttempt(fake, {
      status: "failed",
      errors: ["Error: two"],
      steps: [
        beforeHooks(),
        step("When it fails", "test.step", { error: "Error: two" }),
        afterHooks(),
      ],
      duration: 300,
    });
    expect(eventFor(fake.test, last)).toEqual({
      type: "scenario.end",
      id: "test-1",
      project: "x",
      status: "failed",
      attempts: 2,
      durationMs: 400,
      error: { message: "Error: two", where: "step", step: "When it fails" },
      feature: "Demo feature",
      scenario: "A scenario",
      path: [],
      file: "src/projects/demo/features/demo.feature",
      tags: ["@plugin"],
      outcome: "unexpected",
    });
  });

  test("names each tag once: Playwright repeats one the title also names", () => {
    // "A @mobile scenario…" tagged @mobile: Playwright lists the title's @mobile, then the tag's.
    const fake = fakeTest({ tags: ["@mobile", "@smoke", "@mobile"] });
    expect(
      eventFor(fake.test, addAttempt(fake, { status: "passed" })),
    ).toMatchObject({ tags: ["@mobile", "@smoke"] });
  });

  test("a flaky scenario ends with no error: its last attempt passed", () => {
    const fake = fakeTest({ retries: 1 });
    addAttempt(fake, { status: "failed", errors: ["Error: first"] });
    const event = eventFor(fake.test, addAttempt(fake, { status: "passed" }));
    expect(event).toMatchObject({
      type: "scenario.end",
      status: "flaky",
      outcome: "flaky",
    });
    expect(event).not.toHaveProperty("error");
  });

  test("a drained scenario ends skipped and drained, with no error, though a step carries the skip", () => {
    const fake = fakeTest({
      annotations: [{ type: STOPPED_ANNOTATION, description: "stop" }],
    });
    const event = eventFor(
      fake.test,
      addAttempt(fake, {
        status: "skipped",
        steps: [
          beforeHooks({
            error: "Error: Test is skipped: the run is being stopped",
          }),
          afterHooks(),
        ],
      }),
    );
    expect(event).toMatchObject({
      type: "scenario.end",
      status: "skipped",
      drained: true,
    });
    expect(event).not.toHaveProperty("error");
  });

  test("an interrupted scenario ends interrupted, with what it shows", () => {
    const fake = fakeTest({ retries: 2 });
    const event = eventFor(
      fake.test,
      addAttempt(fake, {
        status: "interrupted",
        steps: [beforeHooks(), step("When the backup runs", "test.step")],
      }),
    );
    expect(event).toMatchObject({
      type: "scenario.end",
      status: "interrupted",
      attempts: 1,
    });
    expect(event).not.toHaveProperty("drained");
  });

  test("a setup's last attempt is setup.end; a setup's retry makes no event", () => {
    const fake = fakeTest({
      project: "artifacts:x",
      titles: ["artifacts.setup.ts", "resolve artifacts"],
      retries: 1,
    });
    expect(
      eventFor(fake.test, addAttempt(fake, { status: "failed" })),
    ).toBeUndefined();
    const event = eventFor(
      fake.test,
      addAttempt(fake, {
        status: "failed",
        errors: ["Error: resolution failed"],
      }),
    );
    expect(event).toEqual({
      type: "setup.end",
      setup: "artifacts",
      id: "test-1",
      project: "artifacts:x",
      status: "failed",
      attempts: 2,
      durationMs: 200,
      error: { message: "Error: resolution failed", where: "test" },
    });
  });

  test("run.end: the run's status, its rounded duration, both counts", () => {
    const tally = new RunTally();
    tally.begin([fakeTest().test]);
    expect(
      runEndEvent({ status: "interrupted", duration: 1234.6 }, tally),
    ).toEqual({
      type: "run.end",
      status: "interrupted",
      durationMs: 1235,
      scenarios: {
        total: 1,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        interrupted: 0,
        didNotRun: 1,
        drained: 0,
      },
      setups: {
        total: 0,
        passed: 0,
        failed: 0,
        flaky: 0,
        skipped: 0,
        interrupted: 0,
        didNotRun: 0,
        drained: 0,
      },
    });
  });
});

test.describe("ResultsStreamReporter, driven as the runner drives it", () => {
  test("streams a run in order, counts it, and leaves the unfinished as did-not-run", async () => {
    const setup = fakeTest({
      id: "s",
      project: "setup:x",
      titles: ["auth.setup.ts", "authenticate"],
    });
    const flaky = fakeTest({ id: "f", retries: 1 });
    const passes = fakeTest({ id: "p" });
    const never = fakeTest({ id: "n" });
    const reporter = new ResultsStreamReporter({
      ...runIn(work),
      _mode: "test",
    });

    reporter.onBegin(
      CONFIG,
      fakeSuite([setup, flaky, passes, never]) as unknown as Suite,
    );
    reporter.onTestBegin(setup.test, beginningAttempt(setup));
    reporter.onTestEnd(setup.test, addAttempt(setup, { status: "passed" }));
    reporter.onTestBegin(flaky.test, beginningAttempt(flaky));
    reporter.onTestEnd(
      flaky.test,
      addAttempt(flaky, { status: "failed", errors: ["Error: once"] }),
    );
    reporter.onTestBegin(flaky.test, beginningAttempt(flaky));
    reporter.onTestEnd(flaky.test, addAttempt(flaky, { status: "passed" }));
    reporter.onTestBegin(passes.test, beginningAttempt(passes));
    reporter.onTestEnd(passes.test, addAttempt(passes, { status: "passed" }));
    reporter.onError({
      message: "\u001b[31mError: outside any test\u001b[39m",
    });
    reporter.onEnd({ status: "failed", startTime: new Date(), duration: 5000 });
    expect(reporter.printsToStdio()).toBe(false);
    await Promise.resolve();

    const events = eventsIn(join(work, RESULTS_FILE));
    expect(events.map((e) => e.type)).toEqual([
      "run.begin",
      "setup.end",
      "scenario.begin",
      "scenario.retry",
      "scenario.begin",
      "scenario.end",
      "scenario.begin",
      "scenario.end",
      "run.error",
      "run.end",
    ]);
    expect(events[0]).toMatchObject({ mode: "test", scenarios: 3, setups: 1 });
    expect(events[8]).toMatchObject({ message: "Error: outside any test" });
    expect(events.at(-1)).toMatchObject({
      status: "failed",
      durationMs: 5000,
      scenarios: { total: 3, passed: 1, flaky: 1, didNotRun: 1 },
      setups: { total: 1, passed: 1, didNotRun: 0 },
    });
  });

  test("a retry that never runs: its scenario ends as the run ends, failed, before run.end", () => {
    const stopped = fakeTest({ id: "s", retries: 1 });
    const reporter = new ResultsStreamReporter(runIn(work));
    reporter.onBegin(CONFIG, fakeSuite([stopped]) as unknown as Suite);
    reporter.onTestBegin(stopped.test, beginningAttempt(stopped));
    reporter.onTestEnd(
      stopped.test,
      addAttempt(stopped, { status: "failed", errors: ["Error: no baseline"] }),
    );
    reporter.onEnd({ status: "failed", startTime: new Date(), duration: 1 });

    const events = eventsIn(join(work, RESULTS_FILE));
    expect(events.map((e) => e.type)).toEqual([
      "run.begin",
      "scenario.begin",
      "scenario.retry",
      "scenario.end",
      "run.end",
    ]);
    expect(events[3]).toMatchObject({
      status: "failed",
      attempts: 1,
      retryNotRun: true,
      error: { message: "Error: no baseline" },
    });
    expect(events[4]).toMatchObject({ scenarios: { failed: 1, didNotRun: 0 } });
  });

  test("a skip Playwright imposed, then the retry it runs: one retry line, one end", () => {
    const fake = fakeTest({ id: "b", retries: 1 });
    const reporter = new ResultsStreamReporter(runIn(work));
    reporter.onBegin(CONFIG, fakeSuite([fake]) as unknown as Suite);
    reporter.onTestBegin(fake.test, beginningAttempt(fake, -1));
    reporter.onTestEnd(
      fake.test,
      addAttempt(fake, {
        status: "skipped",
        expectedStatus: "passed",
        parallelIndex: -1,
      }),
    );
    reporter.onTestBegin(fake.test, beginningAttempt(fake));
    reporter.onTestEnd(fake.test, addAttempt(fake, { status: "passed" }));
    reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });

    const events = eventsIn(join(work, RESULTS_FILE));
    expect(events.map((e) => e.type)).toEqual([
      "run.begin",
      "scenario.begin",
      "scenario.retry",
      "scenario.begin",
      "scenario.end",
      "run.end",
    ]);
    expect(events[2]).toMatchObject({ attemptStatus: "skipped" });
    expect(events[4]).toMatchObject({ status: "passed", attempts: 2 });
    expect(events[4]).not.toHaveProperty("retryNotRun");
  });

  test("marks a --list run, which runs nothing", () => {
    const reporter = new ResultsStreamReporter({
      ...runIn(work),
      _mode: "list",
    });
    reporter.onBegin(CONFIG, fakeSuite([fakeTest()]) as unknown as Suite);
    reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
    const events = eventsIn(join(work, RESULTS_FILE));
    expect(events[0]).toMatchObject({ type: "run.begin", mode: "list" });
    expect(events[1]).toMatchObject({
      type: "run.end",
      scenarios: { didNotRun: 1 },
    });
  });

  test("an unwritable report folder warns once on stderr and fails nothing", () => {
    // A file where the report folder should be: the folder cannot be made.
    const blocked = join(work, "blocked");
    writeFileSync(blocked, "");
    const reporter = new ResultsStreamReporter(runIn(blocked));
    const fake = fakeTest();
    const writes = captureWrites(process.stderr, () => {
      reporter.onBegin(CONFIG, fakeSuite([fake]) as unknown as Suite);
      reporter.onTestBegin(fake.test, beginningAttempt(fake));
      reporter.onTestEnd(fake.test, addAttempt(fake, { status: "passed" }));
      reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
    });
    expect(writes.filter((w) => w.startsWith("[results]"))).toHaveLength(1);
  });

  test("options without a report folder: one warning, no file, no throw", () => {
    const writes = captureWrites(process.stderr, () => {
      const reporter = new ResultsStreamReporter({ product: "demo" });
      reporter.onBegin(CONFIG, fakeSuite([]) as unknown as Suite);
      reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
    });
    expect(writes).toEqual([
      '[results] the reporter\'s options lack "reportDir"; no results stream.\n',
    ]);
  });
});
