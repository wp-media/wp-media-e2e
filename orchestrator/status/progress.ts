import { z } from "zod";

import type { ResultsEvent } from "../../src/common/reporting/results-schema";
import { RunResultsFold, scenarioCounts } from "../runs/results";

/**
 * A run's progress, folded from its results stream's events as they arrive (`tail.ts`) by the
 * end-of-run reader's own rules (`runs/results.ts`): the plan from `run.begin`, each setup's and each
 * scenario's **last** end per test id, the counts `run.finished` will give (`run.end`'s once read),
 * and what runs now from `scenario.begin`s not yet ended. Every field read is checked, so a line of
 * the wrong shape is ignored, never a crash or a count of another type. Pure.
 */

/** What the status table shows of a run in flight. */
export interface RunProgress {
  /** `run.begin` was read: Playwright has started. */
  readonly begun: boolean;
  /** `run.end` was read: Playwright has finished. */
  readonly finished: boolean;
  /**
   * The stream grew past the end-of-run reader's cap (`MAX_RESULTS_BYTES`): it is no longer read, and
   * `run.finished` will count nothing from it — every count here is 0, unknown.
   */
  readonly tooLarge: boolean;
  /** Setups planned (`run.begin.setups`). */
  readonly setups: number;
  /** Setups ended, each counted once. */
  readonly setupsEnded: number;
  /** Scenarios planned: `run.begin.scenarios`, never fewer than ended; `run.end`'s total once read. */
  readonly planned: number;
  /** Scenarios ended, each counted once; once `run.end` is read, its total less what did not run. */
  readonly done: number;
  /** Ended scenarios by their final status. */
  readonly passed: number;
  readonly failed: number;
  readonly flaky: number;
  readonly skipped: number;
  readonly interrupted: number;
  /** Ended scenarios the drain skipped (`drained`): the run was being stopped. */
  readonly stopped: number;
  /** Scenarios begun and not yet ended: what runs now. */
  readonly running: number;
}

/** Progress before any event. */
export const NO_PROGRESS: RunProgress = {
  begun: false,
  finished: false,
  tooLarge: false,
  setups: 0,
  setupsEnded: 0,
  planned: 0,
  done: 0,
  passed: 0,
  failed: 0,
  flaky: 0,
  skipped: 0,
  interrupted: 0,
  stopped: 0,
  running: 0,
};

/** `run.begin`'s fields the end-of-run reader does not keep: the setups planned, and whose run it is. */
const beginSchema = z.object({
  setups: z.number().int().nonnegative().catch(0),
  runId: z.string().optional().catch(undefined),
});

/** `scenario.begin`: the test it begins. */
const scenarioBeginSchema = z.object({ id: z.string() });

/**
 * Folds one run's events into its progress, through the end-of-run reader's own fold
 * ({@link RunResultsFold}) and counts ({@link scenarioCounts}): a line `run.finished` drops is dropped
 * here, and the counts shown are the ones it will count. Keeps one entry per test id — bounded by the
 * run's tests, not by its events.
 */
export class ProgressFold {
  /** What the end-of-run reader would keep of the events so far. */
  private readonly results = new RunResultsFold();
  /** `run.begin`'s setups, once the reader kept a `run.begin`. */
  private setups: number | undefined;
  /** Scenarios begun and not ended since, by test id. */
  private readonly open = new Set<string>();
  /** The stream's `run.begin` named another run: nothing in it is counted. */
  private foreign = false;
  /** The stream grew past what the end-of-run reader reads: no count is known. */
  private tooLarge = false;

  /**
   * @param runId - the run's `RUN_ID`; a stream whose `run.begin` names another is someone else's,
   *   and counts nothing. Unchecked when absent.
   */
  constructor(private readonly runId?: string) {}

  /**
   * Applies events, in the order they were written.
   *
   * @param events - the events.
   */
  apply(events: readonly ResultsEvent[]): void {
    for (const event of events) this.applyOne(event);
  }

  /** Marks the stream as past the end-of-run reader's cap: from now on, its progress is unknown. */
  markTooLarge(): void {
    this.tooLarge = true;
  }

  /**
   * Applies one event; a type or a shape the end-of-run reader does not keep is ignored.
   *
   * @param event - the event.
   */
  private applyOne(event: ResultsEvent): void {
    if (this.foreign || this.tooLarge) return;
    if (event.type === "run.begin" && this.setups === undefined) {
      const begin = parsed(beginSchema, event);
      if (
        this.runId !== undefined &&
        begin?.runId !== undefined &&
        begin.runId !== this.runId
      ) {
        this.foreign = true;
        return;
      }
    }
    const kept = this.results.apply(event);
    if (event.type === "scenario.begin") {
      const begun = parsed(scenarioBeginSchema, event);
      if (begun !== undefined) this.open.add(begun.id);
    } else if (kept && event.type === "scenario.end")
      this.open.delete(event.id);
    else if (kept && event.type === "run.begin")
      this.setups = parsed(beginSchema, event)?.setups ?? 0;
  }

  /**
   * The progress so far.
   *
   * @returns it, a fresh object.
   */
  progress(): RunProgress {
    if (this.foreign) return NO_PROGRESS;
    if (this.tooLarge) return { ...NO_PROGRESS, tooLarge: true };
    const results = this.results.results();
    const counts = scenarioCounts(results);
    const finished = results.end !== undefined;
    return {
      begun: results.begin !== undefined,
      finished,
      tooLarge: false,
      setups: this.setups ?? 0,
      setupsEnded: results.setups.length,
      planned: counts.total,
      done: counts.total - counts.didNotRun,
      passed: counts.passed,
      failed: counts.failed,
      flaky: counts.flaky,
      skipped: counts.skipped,
      interrupted: counts.interrupted,
      stopped: counts.drained,
      // Once the run has ended, nothing runs.
      running: finished ? 0 : this.open.size,
    };
  }
}

/**
 * A line as `schema` reads it, or `undefined` when it is not of that shape.
 *
 * @param schema - the line's schema.
 * @param line - the event.
 * @returns the parsed line, or `undefined`.
 */
function parsed<T extends z.ZodType>(
  schema: T,
  line: unknown,
): z.output<T> | undefined {
  const result = schema.safeParse(line);
  return result.success ? result.data : undefined;
}
