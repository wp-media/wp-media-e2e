import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";

import { errorMessage } from "../guards";
import { setupKindOf } from "../config/project-names";
import { actualWorkers } from "./cell-notice";
import { printLine } from "./terminal-sink";
import {
  RunTally,
  cleanMessage,
  firstError,
  scenarioPlace,
  setupOf,
  wasDrainedTest,
  type TestStatus,
} from "./results";
import {
  RESULTS_FILE,
  RESULTS_SCHEMA_VERSION,
  type ResultsEvent,
  type RunBeginEvent,
  type RunEndEvent,
  type ScenarioBeginEvent,
} from "./results-schema";
import {
  readRunDescription,
  reporterMode,
  type RunDescription,
} from "./run-description";

/**
 * The results stream: every attempt and the run's totals, one JSON line each, appended to
 * `<report dir>/results.jsonl` as they happen (schema in `results-schema.ts`). It is how the
 * orchestrator watches a run — what is running now, what failed and where, how the run ended — and
 * the one record a killed run leaves complete up to its last line.
 *
 * Always on, and silent: it writes nothing to the terminal. Listed first among the reporters that
 * end a run, so `run.end` lands before the slow reports are written. It never fails a run: a write
 * that fails warns once — through the run's terminal sink, else on stderr — and the run goes on (a
 * reporter that throws turns a green run red).
 *
 * Never written: step parameters, Playwright API steps, attachments, output or an error's call log —
 * Playwright titles a `fill()` with its value, and its call log quotes element markup, so any of them
 * can hold what a page or a test held. An assertion's message is kept, so the stream is as sensitive as
 * the reports.
 */

/** One event without its stamp; distributes over the union, so each type keeps its own fields. */
type Unstamped<E> = E extends ResultsEvent ? Omit<E, "v" | "at"> : never;

/** An event before {@link JsonLinesFile} stamps it: `v` and `at` are the file's to add. */
export type UnstampedEvent = Unstamped<ResultsEvent>;

/** Appends one JSON line per event to a file, never throwing. */
export class JsonLinesFile {
  /** Whether the file was created yet: the first line creates it afresh. */
  private created = false;
  /** Whether a failure was reported already. */
  private warned = false;
  /**
   * Whether a write failed since the last good one: it may have left part of a line, so the next
   * line starts on a fresh one — a reader skips the broken fragment and loses nothing after it.
   */
  private resync = false;

  /**
   * @param path - the file, absolute. Its folder is created with the first line.
   * @param warn - where the one warning goes: the run's terminal sink, else stderr.
   * @param now - the clock that stamps each line.
   */
  constructor(
    readonly path: string,
    private readonly warn: (message: string) => void = (message) => {
      printLine(message, "stderr");
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * Writes an event as one line, stamped with the schema's version and the time: the first creates
   * the file — replacing any left by an earlier run with this report folder — and each later one is
   * appended, so a reader polling the file sees each event as it happens. A failure is warned about
   * once; later lines are still attempted, since a full disk can recover, each starting on a line of
   * its own.
   *
   * @param event - the event.
   */
  write(event: UnstampedEvent): void {
    const { type, ...fields } = event;
    const line = `${JSON.stringify({
      v: RESULTS_SCHEMA_VERSION,
      type,
      at: this.now().toISOString(),
      ...fields,
    })}\n`;
    try {
      if (this.created) {
        appendFileSync(this.path, this.resync ? `\n${line}` : line);
      } else {
        mkdirSync(dirname(this.path), { recursive: true });
        writeFileSync(this.path, line);
        this.created = true;
      }
      this.resync = false;
    } catch (error) {
      this.resync = this.created;
      this.fail(`could not write ${this.path}: ${errorMessage(error)}`);
    }
  }

  /**
   * Reports a failure of this stream, once.
   *
   * @param reason - what went wrong.
   */
  fail(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      this.warn(
        `[results] ${reason}. The run goes on without its results stream.`,
      );
    } catch {
      // Nothing is left to tell.
    }
  }
}

/**
 * The `run.begin` event.
 *
 * @param run - what the config factory knows about the run.
 * @param mode - the reporters' mode: `list` for `--list`.
 * @param config - the run's resolved config.
 * @param tally - the tally, begun with the run's tests.
 */
export function runBeginEvent(
  run: RunDescription,
  mode: RunBeginEvent["mode"],
  config: Pick<FullConfig, "projects" | "workers" | "metadata">,
  tally: RunTally,
): Omit<RunBeginEvent, "v" | "at"> {
  const retries = Math.max(
    0,
    ...config.projects
      .filter((project) => setupKindOf(project.name) === undefined)
      .map((project) => project.retries),
  );
  return {
    type: "run.begin",
    runId: run.runId,
    product: run.product,
    ...(run.cell !== undefined ? { cell: run.cell } : {}),
    ...(run.edition !== undefined ? { edition: run.edition } : {}),
    mode,
    scenarios: tally.scenarios.total,
    setups: tally.setups.total,
    retries,
    workers: actualWorkers(config),
  };
}

/**
 * The `scenario.begin` event for an attempt, or `undefined` for a setup's.
 *
 * @param test - the test.
 * @param result - the attempt that begins.
 */
export function scenarioBeginEvent(
  test: TestCase,
  result: Pick<TestResult, "retry" | "parallelIndex">,
): Omit<ScenarioBeginEvent, "v" | "at"> | undefined {
  if (setupOf(test) !== undefined) return undefined;
  const place = scenarioPlace(test, test.parent.project()?.testDir);
  return {
    type: "scenario.begin",
    id: test.id,
    project: test.parent.project()?.name ?? "",
    feature: place.feature,
    scenario: place.scenario,
    attempt: result.retry + 1,
    parallelIndex: result.parallelIndex,
  };
}

/**
 * The `scenario.retry` event for a scenario's attempt that will run again; `undefined` for a setup's,
 * whose retries the stream does not report.
 *
 * @param test - the test.
 * @param result - the attempt that ended.
 */
export function retryEvent(
  test: TestCase,
  result: TestResult,
): UnstampedEvent | undefined {
  if (setupOf(test) !== undefined) return undefined;
  const error = firstError(result);
  return {
    type: "scenario.retry",
    id: test.id,
    attempt: result.retry + 1,
    attemptStatus: result.status,
    durationMs: result.duration,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * The event a finished test makes: `setup.end` for a setup, `scenario.end` for a scenario.
 *
 * @param test - the test; its `results` hold every attempt.
 * @param result - its last attempt.
 * @param status - its final status.
 * @param retryNotRun - whether a retry was due but never ran ({@link RunTally.settle}).
 */
export function endEvent(
  test: TestCase,
  result: TestResult,
  status: TestStatus,
  retryNotRun = false,
): UnstampedEvent {
  const setup = setupOf(test);
  const project = test.parent.project();
  // Only a test that failed or was interrupted has an error to show: a skip puts its reason on a
  // step, and a flaky test's last attempt passed (its failures are on its `scenario.retry` lines).
  const error =
    status === "failed" || status === "interrupted"
      ? firstError(result)
      : undefined;
  const common = {
    id: test.id,
    project: project?.name ?? "",
    status,
    attempts: test.results.length,
    durationMs: test.results.reduce((sum, r) => sum + r.duration, 0),
    ...(retryNotRun ? { retryNotRun: true as const } : {}),
    ...(error !== undefined ? { error } : {}),
  };
  if (setup !== undefined) return { type: "setup.end", setup, ...common };

  const place = scenarioPlace(test, project?.testDir);
  return {
    type: "scenario.end",
    ...common,
    feature: place.feature,
    scenario: place.scenario,
    path: place.path,
    ...(place.file !== undefined ? { file: place.file } : {}),
    // Playwright's tags repeat one a title also names (`@mobile` in "A @mobile scenario…").
    tags: [...new Set(test.tags)],
    outcome: test.outcome(),
    ...(wasDrainedTest(test) ? { drained: true as const } : {}),
  };
}

/**
 * The `run.end` event.
 *
 * @param result - what `onEnd` received.
 * @param tally - the run's tally.
 */
export function runEndEvent(
  result: Pick<FullResult, "status" | "duration">,
  tally: RunTally,
): Omit<RunEndEvent, "v" | "at"> {
  return {
    type: "run.end",
    status: result.status,
    durationMs: Math.round(result.duration),
    scenarios: tally.scenarios,
    setups: tally.setups,
  };
}

/** Streams a run's results to `<report dir>/results.jsonl`; see the module's description. */
export default class ResultsStreamReporter implements Reporter {
  /** What the config factory said about the run, or the field it forgot. */
  private readonly run: RunDescription | { readonly missing: string };
  /** The reporters' mode. */
  private readonly mode: RunBeginEvent["mode"];
  /** The stream's file; `undefined` when the options name no report folder. */
  private readonly file: JsonLinesFile | undefined;
  /** The run's counts. */
  private readonly tally = new RunTally();

  /** @param options - a {@link RunDescription}, plus what Playwright adds. */
  constructor(options: unknown) {
    this.run = readRunDescription(options);
    this.mode = reporterMode(options);
    this.file =
      "missing" in this.run
        ? undefined
        : new JsonLinesFile(join(this.run.reportPath, RESULTS_FILE));
  }

  /**
   * Writes `run.begin`, creating the file.
   *
   * @param config - the run's resolved config.
   * @param suite - every test the run plans.
   */
  onBegin(config: FullConfig, suite: Suite): void {
    this.guard(() => {
      if ("missing" in this.run) {
        printLine(
          `[results] the reporter's options lack "${this.run.missing}"; no results stream.`,
          "stderr",
        );
        return;
      }
      this.tally.begin(suite.allTests());
      this.file?.write(runBeginEvent(this.run, this.mode, config, this.tally));
    });
  }

  /**
   * Writes `scenario.begin` for a scenario's attempt.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  onTestBegin(test: TestCase, result: TestResult): void {
    this.guard(() => {
      const event = scenarioBeginEvent(test, result);
      if (event !== undefined) this.file?.write(event);
    });
  }

  /**
   * Writes the attempt's event: a retry that is due, or the test's end.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard(() => {
      const verdict = this.tally.attemptEnded(test, result);
      const event = verdict.final
        ? endEvent(test, result, verdict.status)
        : retryEvent(test, result);
      if (event !== undefined) this.file?.write(event);
    });
  }

  /**
   * Writes `run.error` for an error outside any test.
   *
   * @param error - the error.
   */
  onError(error: TestError): void {
    this.guard(() => {
      const message = error.message ?? error.value ?? "unknown error";
      this.file?.write({ type: "run.error", message: cleanMessage(message) });
    });
  }

  /**
   * Ends the tests whose retry never ran, then writes `run.end`. Returns nothing: a returned status
   * would replace the run's own.
   *
   * @param result - the run's status and duration.
   */
  onEnd(result: FullResult): void {
    this.guard(() => {
      for (const { test, result: last, status } of this.tally.settle()) {
        this.file?.write(endEvent(test, last, status, true));
      }
      this.file?.write(runEndEvent(result, this.tally));
    });
  }

  /** Writes nothing to the terminal, so Playwright's own terminal reporter is never displaced. */
  printsToStdio(): boolean {
    return false;
  }

  /**
   * Runs a reporter step, turning any throw into the stream's one warning.
   *
   * @param step - the work.
   */
  private guard(step: () => void): void {
    try {
      step();
    } catch (error) {
      this.file?.fail(`failed: ${errorMessage(error)}`);
    }
  }
}
