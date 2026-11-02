import type {
  ResultsEvent,
  RunBeginEvent,
  RunEndEvent,
  ScenarioEndEvent,
  SetupEndEvent,
} from "../../src/common/reporting/results-schema";

/**
 * Results-stream lines for the orchestrator's specs, shaped as the suite's reporter writes them
 * (a real `pro@nginx` stream was the model): each builder takes only what a test varies.
 */

/** When every line was written: the time is not what these specs judge. */
const AT = "2026-10-13T10:15:31.000Z";

/**
 * Counts with every field 0 but those given.
 *
 * @param given - the counts that are not 0.
 * @returns a full count, as `run.end` carries for scenarios and setups.
 */
export function counts(
  given: Partial<RunEndEvent["scenarios"]> = {},
): RunEndEvent["scenarios"] {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
    drained: 0,
    ...given,
  };
}

/** The `RUN_ID` {@link runBegin} names by default. */
export const FIXTURE_RUN_ID = "2026-10-13T10-15-31-042Z-bpng-12";

/**
 * `run.begin` for `scenarios` planned scenarios.
 *
 * @param scenarios - how many scenarios the run planned.
 * @param extra - fields replacing the defaults: another `runId`, say.
 * @returns a `pro@nginx` run's begin, two setups, two retries.
 */
export function runBegin(
  scenarios: number,
  extra: Partial<RunBeginEvent> = {},
): RunBeginEvent {
  return {
    v: 1,
    type: "run.begin",
    at: AT,
    runId: FIXTURE_RUN_ID,
    product: "backwpup",
    cell: "pro@nginx",
    edition: "pro",
    mode: "test",
    scenarios,
    setups: 2,
    retries: 2,
    workers: 1,
    ...extra,
  };
}

/**
 * A setup's end.
 *
 * @param setup - which setup.
 * @param status - how it ended.
 * @param message - its error's message, when it has one.
 * @returns the event, with an `error` only when `message` is given.
 */
export function setupEnd(
  setup: "auth" | "artifacts",
  status: SetupEndEvent["status"],
  message?: string,
): SetupEndEvent {
  return {
    v: 1,
    type: "setup.end",
    at: AT,
    id: `setup-${setup}`,
    project: `${setup === "auth" ? "setup" : "artifacts"}:pro@nginx`,
    setup,
    status,
    attempts: 1,
    durationMs: 1000,
    ...(message === undefined
      ? {}
      : { error: { message, where: "step" as const } }),
  };
}

/**
 * A scenario's end, `id` naming it.
 *
 * @param id - its id; its name is `Scenario <id>`.
 * @param status - its final status; `expected` only when `passed`.
 * @param extra - fields that replace the defaults.
 * @returns the event.
 */
export function scenarioEnd(
  id: string,
  status: ScenarioEndEvent["status"],
  extra: Partial<ScenarioEndEvent> = {},
): ScenarioEndEvent {
  return {
    v: 1,
    type: "scenario.end",
    at: AT,
    id,
    project: "pro@nginx",
    feature: "Backups",
    scenario: `Scenario ${id}`,
    path: [],
    tags: [],
    status,
    outcome: status === "passed" ? "expected" : "unexpected",
    attempts: 1,
    durationMs: 100,
    ...extra,
  };
}

/**
 * `run.end` with the scenarios' counts given.
 *
 * @param status - the run's status.
 * @param scenarios - the scenarios' counts that are not 0.
 * @param setups - the setups' counts; both passed by default.
 * @returns the event, 60 s long.
 */
export function runEnd(
  status: RunEndEvent["status"],
  scenarios: Partial<RunEndEvent["scenarios"]> = {},
  setups: Partial<RunEndEvent["setups"]> = { total: 2, passed: 2 },
): RunEndEvent {
  return {
    v: 1,
    type: "run.end",
    at: AT,
    status,
    durationMs: 60_000,
    scenarios: counts(scenarios),
    setups: counts(setups),
  };
}

/**
 * `run.error`.
 *
 * @param message - the error's message.
 * @returns the event.
 */
export function runError(message: string): ResultsEvent {
  return { v: 1, type: "run.error", at: AT, message };
}

/**
 * A stream's text: one JSON line per event.
 *
 * @param events - the events, in order.
 * @returns `results.jsonl`'s content, each line ended by `\n`.
 */
export function streamOf(events: readonly ResultsEvent[]): string {
  return events.map((event) => `${JSON.stringify(event)}\n`).join("");
}
