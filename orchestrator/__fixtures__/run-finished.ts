import type {
  FinishedScenario,
  RunFinishedEvent,
} from "../events/run-finished";

/**
 * `run.finished` events for the notifiers' specs: a failed `pro@nginx` run with every fact known —
 * the Slack message's reference case — that each test changes only where it matters.
 */

/**
 * A scenario that passed.
 *
 * @param given - fields that replace its own.
 * @returns a `run.finished` scenario.
 */
export function scenario(
  given: Partial<FinishedScenario> = {},
): FinishedScenario {
  return {
    feature: "Backups",
    name: "A backup runs",
    path: [],
    status: "passed",
    attempts: 1,
    durationMs: 1_000,
    ...given,
  };
}

/**
 * A failed run of BackWPup Pro on `pro@nginx`: 52 scenarios, 49 passed, 1 flaky, 2 failed, in 54m 10s.
 *
 * @param given - fields that replace the event's own, at the top level.
 * @returns the event.
 */
export function finishedEvent(
  given: Partial<RunFinishedEvent> = {},
): RunFinishedEvent {
  return {
    v: 1,
    type: "run.finished",
    at: "2026-10-13T11:09:42.000Z",
    run: {
      id: "bpng-12",
      runId: "2026-10-13T10-15-31-042Z-bpng-12",
      name: "BackWPup Pro on nginx",
      trigger: "loop",
      task: { id: "bpng", name: "BackWPup Pro on nginx", grep: null },
    },
    unit: { product: "backwpup", cell: "pro@nginx", edition: "pro" },
    plugin: {
      requestedRef: "develop",
      ref: "develop",
      commit: "f1ebfd0".padEnd(40, "a"),
      version: "9.99.99",
      name: "BackWPup Pro",
    },
    sites: [
      {
        baseURL: "https://simple.e2e.rocketlabsqa.ovh",
        wordpress: "7.1.2",
        php: "8.5.10",
      },
    ],
    status: "failed",
    reason: null,
    startedAt: "2026-10-13T10:15:31.042Z",
    endedAt: "2026-10-13T11:09:41.042Z",
    durationMs: 3_250_000,
    counts: {
      total: 52,
      passed: 49,
      failed: 2,
      flaky: 1,
      skipped: 0,
      didNotRun: 0,
    },
    scenarios: [
      scenario({
        name: "A backup runs on demand",
        status: "failed",
        attempts: 3,
        error: 'Expected "Done", received "Error"\n  at step 3',
      }),
      scenario({
        feature: "CLI",
        name: "Logs are listed",
        status: "failed",
        error: "Timeout 30000ms exceeded",
      }),
      scenario({
        feature: "Onboarding",
        name: "The first backup is offered",
        status: "flaky",
        attempts: 2,
        error: "first attempt failed",
      }),
      ...Array.from({ length: 49 }, (_, i) =>
        scenario({ name: `Scenario ${String(i + 1)}` }),
      ),
    ],
    report: {
      dir: "/home/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12",
      log: "/home/e2e/.orchestrator/runs/bpng-12/run.log",
      bundle: null,
    },
    ...given,
  };
}
