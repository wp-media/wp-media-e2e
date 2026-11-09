import type { RunFactsRead } from "../runs/facts";
import type { RunOutcome, RunStatus } from "../runs/outcome";
import {
  scenarioCounts,
  type RunResults,
  type ScenarioResult,
  type TestStatus,
} from "../runs/results";
import { safeBlock, safeLine, safeSiteUrl } from "../text";

/**
 * `run.finished`, version 1: the one event this orchestrator publishes, once per run, whatever its
 * status — what Slack and Datator are told. Built by a pure function from what the run left, so
 * every field is testable. Later event types add to the bus; this one keeps its shape, and a change
 * that would mislead a subscriber bumps {@link RUN_FINISHED_VERSION}.
 *
 * It goes to Slack and Datator, so all its text is safe to send: what came from the run's files —
 * names, versions, errors — is masked of credentials (by shape, and by every secret value the
 * orchestrator holds) and freed of terminal codes, control and invisible characters; a one-line
 * field stays one line. Each subscriber still escapes for its own format.
 */

/** The event's schema version. */
export const RUN_FINISHED_VERSION = 1;

/** The longest error message a scenario carries, in code points. */
export const MAX_SCENARIO_ERROR = 2_000;

/** The longest name — a feature's, a scenario's, a Rule's — the event carries, in code points. */
export const MAX_NAME = 1_000;

/** The longest short fact — an edition, a version, a ref, a URL — the event carries, in code points. */
export const MAX_FACT = 300;

/** One scenario, as it finally ended. */
export interface FinishedScenario {
  readonly feature: string;
  readonly name: string;
  /** The Rule and Scenario Outline titles between the feature and the scenario. */
  readonly path: readonly string[];
  readonly status: TestStatus;
  readonly attempts: number;
  readonly durationMs: number;
  /** The first error's message: no terminal codes, at most {@link MAX_SCENARIO_ERROR}. */
  readonly error?: string;
}

/**
 * The run's download bundle, as the orchestrator prepared it after the run: what Slack's `Report:`
 * command fetches. Added within version 1 — a new field misleads no subscriber that ignores it.
 */
export interface RunBundle {
  /** `archive`: `report.tar.gz`, one top-level folder `name`; `folder`: the unpacked `report/`. */
  readonly kind: "archive" | "folder";
  /** The archive or folder, absolute. */
  readonly path: string;
  /** `<product>-<cell>-<RUN_ID>`: the folder the archive unpacks to. */
  readonly name: string;
}

/** A run has ended. */
export interface RunFinishedEvent {
  readonly v: typeof RUN_FINISHED_VERSION;
  readonly type: "run.finished";
  /** When the event was built, ISO 8601. */
  readonly at: string;
  readonly run: {
    /** `bpng-12`. */
    readonly id: string;
    /** `RUN_ID`, the report folder's name. */
    readonly runId: string;
    /** The task's name, else the run's id. */
    readonly name: string;
    readonly trigger: "loop";
    readonly task: {
      readonly id: string;
      readonly name: string | null;
      /** The task's `--grep` filter; `null` when it runs every scenario. */
      readonly grep: string | null;
    };
  };
  readonly unit: {
    readonly product: string;
    readonly cell: string;
    readonly edition: string | null;
  };
  /** The plugin under test; `null` where the run never found out. */
  readonly plugin: {
    /** The ref the task asked for; `null` for the product's default. */
    readonly requestedRef: string | null;
    /** The ref built. */
    readonly ref: string | null;
    /** The full commit built; `null` for a release's zip. */
    readonly commit: string | null;
    readonly version: string | null;
    /** The `Plugin Name:` header. */
    readonly name: string | null;
  };
  /** The pool's sites, in pool order; versions `null` where the auth setup could not read them. */
  readonly sites: readonly {
    readonly baseURL: string;
    readonly wordpress: string | null;
    readonly php: string | null;
  }[];
  readonly status: RunStatus;
  /** Why, for `error`, `stopped` and `killed`; else `null`. */
  readonly reason: string | null;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  /**
   * The scenarios: `total` planned; `didNotRun` those that never finished, an interrupted one
   * included; `skipped` those skipped, drained ones included.
   */
  readonly counts: {
    readonly total: number;
    readonly passed: number;
    readonly failed: number;
    readonly flaky: number;
    readonly skipped: number;
    readonly didNotRun: number;
  };
  /** Each scenario that finished, in the order they first ended. */
  readonly scenarios: readonly FinishedScenario[];
  /**
   * Where the run's report and log are; both `null` for a run that never had a folder of its own —
   * refused before its launch made one — where neither was ever written.
   */
  readonly report: {
    /** The run's report folder, absolute. */
    readonly dir: string | null;
    /** The run's log, absolute. */
    readonly log: string | null;
    /**
     * Its download bundle (the archive when there is one); `null` when none was built — the mode is
     * `none`, the run never ran or was stopped past a drain, or building failed or ran out of time.
     */
    readonly bundle: RunBundle | null;
  };
}

/** What a `run.finished` is built from. */
export interface RunFinishedInput {
  /** When it is built. */
  readonly at: Date;
  readonly run: { readonly id: string; readonly runId: string };
  readonly task: {
    readonly id: string;
    readonly name?: string;
    readonly product: string;
    readonly cell: string;
    /** The ref the task asks for, when it names one. */
    readonly ref?: string;
    /** The task's `--grep` filter, when it has one. */
    readonly grep?: string;
  };
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly outcome: RunOutcome;
  /** The results stream; absent when there is none. */
  readonly results?: RunResults;
  /** The run's facts; absent when there are none. */
  readonly facts?: RunFactsRead;
  readonly reportDir: string;
  readonly log: string;
  /** `false` for a run that never had a folder: its report, log and bundle are then `null`. */
  readonly hadFolder?: boolean;
  /** The run's download bundle, when one was built. */
  readonly bundle?: RunBundle | null;
  /** The secret values the orchestrator holds, masked in every text the run's files gave. */
  readonly secrets: readonly string[];
}

/**
 * Builds a run's `run.finished`.
 *
 * @param input - the run, its task, its times, its outcome and what it left.
 * @returns the event.
 */
export function buildRunFinished(input: RunFinishedInput): RunFinishedEvent {
  const { task, facts, results, secrets } = input;
  const counts = results === undefined ? undefined : scenarioCounts(results);
  const plugin = facts?.plugin;
  /** A fact from the run's files, safe to send; `null` when unknown. */
  const fact = (value: string | undefined): string | null =>
    value === undefined ? null : safeLine(value, MAX_FACT, secrets);
  return {
    v: RUN_FINISHED_VERSION,
    type: "run.finished",
    at: input.at.toISOString(),
    run: {
      id: input.run.id,
      runId: input.run.runId,
      name: task.name ?? input.run.id,
      trigger: "loop",
      task: { id: task.id, name: task.name ?? null, grep: task.grep ?? null },
    },
    unit: {
      product: task.product,
      cell: task.cell,
      edition: fact(facts?.edition ?? results?.begin?.edition),
    },
    plugin: {
      requestedRef: task.ref ?? null,
      ref: fact(plugin?.ref),
      commit: fact(plugin?.commit),
      version: fact(plugin?.version),
      name: fact(plugin?.name),
    },
    sites: (facts?.sites ?? []).map((site) => ({
      baseURL: safeSiteUrl(site.baseURL, MAX_FACT, secrets),
      wordpress: fact(site.wordpress),
      php: fact(site.php),
    })),
    status: input.outcome.status,
    reason: input.outcome.reason ?? null,
    startedAt: input.startedAt.toISOString(),
    endedAt: input.endedAt.toISOString(),
    durationMs: Math.max(
      0,
      input.endedAt.getTime() - input.startedAt.getTime(),
    ),
    counts: {
      total: counts?.total ?? 0,
      passed: counts?.passed ?? 0,
      failed: counts?.failed ?? 0,
      flaky: counts?.flaky ?? 0,
      skipped: counts?.skipped ?? 0,
      didNotRun: (counts?.didNotRun ?? 0) + (counts?.interrupted ?? 0),
    },
    scenarios: (results?.scenarios ?? []).map((scenario) =>
      finishedScenario(scenario, secrets),
    ),
    report:
      input.hadFolder === false
        ? { dir: null, log: null, bundle: null }
        : {
            dir: input.reportDir,
            log: input.log,
            bundle: input.bundle ?? null,
          },
  };
}

/**
 * One scenario as the event carries it: its names one safe line each, its error a safe block of at
 * most {@link MAX_SCENARIO_ERROR} code points — its lines kept, as an assertion's diff reads by line.
 *
 * @param end - its last `scenario.end`.
 * @param secrets - the secret values to mask.
 * @returns the scenario, masked and bounded; `error` only when it had one.
 */
function finishedScenario(
  end: ScenarioResult,
  secrets: readonly string[],
): FinishedScenario {
  /** A name as kept: masked, one line, within {@link MAX_NAME}. */
  const name = (text: string): string => safeLine(text, MAX_NAME, secrets);
  const message = end.error?.message;
  return {
    feature: name(end.feature),
    name: name(end.scenario),
    path: end.path.map(name),
    status: end.status,
    attempts: end.attempts,
    durationMs: end.durationMs,
    ...(message === undefined
      ? {}
      : { error: safeBlock(message, MAX_SCENARIO_ERROR, secrets) }),
  };
}
