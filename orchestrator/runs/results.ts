import { z } from "zod";

import { parseResults } from "../../src/common/reporting/results-reader";
import type {
  ResultsEvent,
  RunEndEvent,
  ScenarioEndEvent,
} from "../../src/common/reporting/results-schema";

/**
 * A finished run's results stream (`results.jsonl`), read once the run has ended: what began, what
 * ended and how, kept as the stream's schema promises — the last `scenario.end` and `setup.end` per
 * test id, lines this reader does not know skipped.
 *
 * The suite's reader trusts a known line's fields as written; this one checks every field it uses,
 * because the outcome and the event are built from them: a line of the wrong shape is dropped, and a
 * count of the wrong type reads as 0 — never a crash, never a value of another type in the event.
 */

/** A test's final status, as the stream writes it. */
export const TEST_STATUSES = [
  "passed",
  "failed",
  "flaky",
  "skipped",
  "interrupted",
] as const satisfies readonly ScenarioEndEvent["status"][];

/** A final status. */
export type TestStatus = (typeof TEST_STATUSES)[number];

/** Playwright's status for a whole run, as `run.end` writes it. */
const RUN_STATUSES = [
  "passed",
  "failed",
  "timedout",
  "interrupted",
] as const satisfies readonly RunEndEvent["status"][];

/** The longest Rule/Outline path kept: Gherkin nests a Rule and an Outline at most. */
const MAX_PATH = 8;

/** A count: a whole number from 0; anything else reads as 0. */
const count = z.number().int().nonnegative().catch(0);

/** A duration in milliseconds: a number from 0 (zod refuses infinities); anything else reads as 0. */
const duration = z.number().nonnegative().catch(0);

/** How a run's tests ended, by status; `drained` 0 in a stream written before it existed. */
const countsSchema = z.object({
  total: count,
  passed: count,
  failed: count,
  flaky: count,
  skipped: count,
  interrupted: count,
  didNotRun: count,
  drained: count,
});

/** The scenarios' counts. */
export type ScenarioCounts = z.output<typeof countsSchema>;

/** A test's first error: its message, when it is text. */
const errorSchema = z
  .object({ message: z.string() })
  .optional()
  .catch(undefined);

/** `run.begin`: the edition and how many scenarios the run planned. */
const beginSchema = z.object({
  edition: z.string().optional().catch(undefined),
  scenarios: count,
});

/** `run.end`: Playwright's status and the counts. A missing counts object reads as all 0. */
const endSchema = z.object({
  status: z.enum(RUN_STATUSES),
  scenarios: countsSchema.catch(() => countsSchema.parse({})),
  setups: countsSchema.catch(() => countsSchema.parse({})),
});

/** `setup.end`. */
const setupSchema = z.object({
  id: z.string(),
  setup: z.string(),
  status: z.enum(TEST_STATUSES),
  error: errorSchema,
});

/** `scenario.end`. */
const scenarioSchema = z.object({
  id: z.string(),
  feature: z.string(),
  scenario: z.string(),
  path: z
    .array(z.string())
    .catch([])
    .transform((path) => path.slice(0, MAX_PATH)),
  status: z.enum(TEST_STATUSES),
  attempts: count,
  durationMs: duration,
  drained: z.literal(true).optional().catch(undefined),
  error: errorSchema,
});

/** `run.error`. */
const runErrorSchema = z.object({ message: z.string() });

/** How a run began. */
export type RunBegin = z.output<typeof beginSchema>;

/** How a run ended, as Playwright saw it. */
export type RunEnd = z.output<typeof endSchema>;

/** A setup, as it finally ended. */
export type SetupResult = z.output<typeof setupSchema>;

/** A scenario, as it finally ended. */
export type ScenarioResult = z.output<typeof scenarioSchema>;

/** What a run's results stream held. */
export interface RunResults {
  /** `run.begin`; absent when the runner never got that far. */
  readonly begin?: RunBegin;
  /** `run.end`; absent when the runner died — or was killed — before it. */
  readonly end?: RunEnd;
  /** Each setup's last `setup.end`, in the order they first ended. */
  readonly setups: readonly SetupResult[];
  /** Each scenario's last `scenario.end`, in the order they first ended. */
  readonly scenarios: readonly ScenarioResult[];
  /** Every `run.error`'s message: an error outside any test. */
  readonly runErrors: readonly string[];
}

/**
 * The longest line read, in UTF-16 units. The suite caps every error it writes at 2,000 characters, so
 * a real event is a few KiB; a longer line is skipped unparsed — parsing deeply nested JSON costs about
 * 100 bytes of memory per byte of text.
 */
export const MAX_LINE_LENGTH = 256 * 1024;

/**
 * Reads a finished run's stream. A last line without its newline is read too: the runner may have
 * died writing it, and an unfinished line is skipped like any other that is not an event; so is a
 * line over {@link MAX_LINE_LENGTH}.
 *
 * @param text - the stream's whole text.
 * @returns what it held.
 */
export function readRunResults(text: string): RunResults {
  const fold = new RunResultsFold();
  for (const event of resultLines(text).events) fold.apply(event);
  return fold.results();
}

/** What {@link resultLines} found. */
export interface ResultLines {
  /** The events, in order. */
  readonly events: readonly ResultsEvent[];
  /** Lines that are not events (`parseResults`'s count), and lines over {@link MAX_LINE_LENGTH}. */
  readonly skipped: number;
}

/**
 * A stream's lines as events: each line over {@link MAX_LINE_LENGTH} UTF-16 units dropped unparsed,
 * the rest through the suite's reader (`parseResults`). The one line rule of this reader and of the
 * status table's tail, so both drop the same lines. A last line without its newline is read as whole.
 *
 * @param text - whole lines of the stream.
 * @returns the events, and how many lines were skipped.
 */
export function resultLines(text: string): ResultLines {
  const lines = text.split("\n");
  const kept = lines.filter((line) => line.length <= MAX_LINE_LENGTH);
  const joined = kept.join("\n");
  const { events, skipped } = parseResults(
    joined.endsWith("\n") ? joined : `${joined}\n`,
  );
  return { events, skipped: skipped + lines.length - kept.length };
}

/**
 * Folds a stream's events, one at a time, into what {@link readRunResults} returns — the end-of-run
 * reader's rules, also followed by the status table as a run goes (`status/progress.ts`), so a line
 * one drops the other drops too. Holds one entry per test id.
 */
export class RunResultsFold {
  /** The first `run.begin` of the right shape. */
  private begin: RunBegin | undefined;
  /** The last `run.end` of the right shape. */
  private end: RunEnd | undefined;
  /** Each setup's last end, by test id. */
  private readonly setups = new Map<string, SetupResult>();
  /** Each scenario's last end, by test id. */
  private readonly scenarios = new Map<string, ScenarioResult>();
  /** Every `run.error`'s message. */
  private readonly runErrors: string[] = [];

  /**
   * Applies one event; a type this reader does not keep, or a line of the wrong shape, is ignored.
   *
   * @param event - the event, as the suite's reader parsed it.
   * @returns `true` when it was kept.
   */
  apply(event: ResultsEvent): boolean {
    switch (event.type) {
      case "run.begin": {
        if (this.begin !== undefined) return false;
        this.begin = parsed(beginSchema, event);
        return this.begin !== undefined;
      }
      case "run.end": {
        const end = parsed(endSchema, event);
        if (end === undefined) return false;
        this.end = end;
        return true;
      }
      case "setup.end":
        return keep(this.setups, parsed(setupSchema, event));
      case "scenario.end":
        return keep(this.scenarios, parsed(scenarioSchema, event));
      case "run.error": {
        const error = parsed(runErrorSchema, event);
        if (error === undefined) return false;
        this.runErrors.push(error.message);
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * What the events so far held.
   *
   * @returns them, fresh arrays.
   */
  results(): RunResults {
    return {
      ...(this.begin === undefined ? {} : { begin: this.begin }),
      ...(this.end === undefined ? {} : { end: this.end }),
      setups: [...this.setups.values()],
      scenarios: [...this.scenarios.values()],
      runErrors: [...this.runErrors],
    };
  }
}

/**
 * A line as `schema` reads it, or `undefined` when it is not of that shape.
 *
 * @param schema - the line's schema.
 * @param line - the line, as the suite's reader parsed it.
 * @returns the parsed line, or `undefined` when the schema refuses it.
 */
function parsed<T extends z.ZodType>(
  schema: T,
  line: unknown,
): z.output<T> | undefined {
  const result = schema.safeParse(line);
  return result.success ? result.data : undefined;
}

/**
 * Keeps a test's last end, in the place it first ended: a Map keeps a key's place when its value is
 * replaced.
 *
 * @param ends - the ends so far, by test id.
 * @param end - this line's, when it was of the right shape.
 * @returns whether it was kept.
 */
function keep<T extends { readonly id: string }>(
  ends: Map<string, T>,
  end: T | undefined,
): boolean {
  if (end === undefined) return false;
  ends.set(end.id, end);
  return true;
}

/**
 * The scenarios' counts: `run.end`'s when the run reached it, else counted from the scenarios that
 * ended, every planned one that did not counted as not run.
 *
 * @param results - the run's results.
 * @returns the counts.
 */
export function scenarioCounts(results: RunResults): ScenarioCounts {
  if (results.end !== undefined) return results.end.scenarios;
  const counts = countsSchema.parse({});
  for (const scenario of results.scenarios) {
    counts[scenario.status] += 1;
    if (scenario.drained === true) counts.drained += 1;
  }
  const ended = results.scenarios.length;
  counts.total = Math.max(results.begin?.scenarios ?? 0, ended);
  counts.didNotRun = counts.total - ended;
  return counts;
}
