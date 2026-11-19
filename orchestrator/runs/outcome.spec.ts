import { test, expect } from "@playwright/test";

import {
  runBegin,
  runEnd,
  runError,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import { isNoTestsFound as suiteIsNoTestsFound } from "../../src/common/reporting/results";
import {
  describeExit,
  isNoTestsFound,
  MAX_REASON_LENGTH,
  runOutcome,
  type OutcomeInput,
} from "./outcome";
import { readRunResults } from "./results";
import type { ResultsEvent } from "../../src/common/reporting/results-schema";

/** A clean exit, and Playwright's for a failed run. */
const OK = { code: 0, signal: null } as const;
const FAILED = { code: 1, signal: null } as const;

/** A run that ran `events`, nothing else going wrong, with `change` applied. */
function input(
  events: readonly ResultsEvent[],
  change: Partial<OutcomeInput> = {},
): OutcomeInput {
  return {
    stop: { level: "none" },
    bddgen: OK,
    playwright: OK,
    results: readRunResults(streamOf(events)),
    setupFailures: [],
    logTail: [],
    secrets: [],
    ...change,
  };
}

/** A run of two scenarios that both passed. */
const PASSED: readonly ResultsEvent[] = [
  runBegin(2),
  setupEnd("auth", "passed"),
  setupEnd("artifacts", "passed"),
  scenarioEnd("a", "passed"),
  scenarioEnd("b", "passed"),
  runEnd("passed", { total: 2, passed: 2 }),
];

test.describe("runOutcome — what the plugin did", () => {
  test("passed: every scenario passed", () => {
    expect(runOutcome(input(PASSED))).toEqual({ status: "passed" });
  });

  test("flaky: a scenario passed on a retry, none failed", () => {
    const events = [
      runBegin(2),
      runEnd("passed", { total: 2, passed: 1, flaky: 1 }),
    ];
    expect(runOutcome(input(events))).toEqual({ status: "flaky" });
  });

  test("failed: a scenario failed, a flaky one beside it", () => {
    const events = [
      runBegin(3),
      runEnd("failed", { total: 3, passed: 1, flaky: 1, failed: 1 }),
    ];
    expect(runOutcome(input(events, { playwright: FAILED }))).toEqual({
      status: "failed",
    });
  });

  test("failed beside skipped scenarios: what ran still counts", () => {
    const events = [runEnd("failed", { total: 3, failed: 1, skipped: 2 })];
    expect(runOutcome(input(events, { playwright: FAILED })).status).toBe(
      "failed",
    );
  });
});

test.describe("runOutcome — stopped and killed", () => {
  test("killed wins over everything, with why", () => {
    expect(
      runOutcome(
        input([], {
          stop: {
            level: "killed",
            why: "the orchestrator was stopped (SIGINT ×3)",
          },
          bddgen: { code: null, signal: "SIGKILL" },
          playwright: undefined,
          results: undefined,
        }),
      ),
    ).toEqual({
      status: "killed",
      reason: "the orchestrator was stopped (SIGINT ×3)",
    });
  });

  test("stopped when the orchestrator interrupted it while it tested", () => {
    const why = "the orchestrator was stopped (SIGTERM)";
    const stop = { level: "interrupted", why } as const;
    const events = [
      runBegin(2),
      scenarioEnd("a", "passed"),
      runEnd("interrupted", { total: 2, passed: 1, interrupted: 1 }),
    ];
    expect(
      runOutcome(
        input(events, { stop, playwright: { code: 130, signal: null } }),
      ),
    ).toEqual({ status: "stopped", reason: why });
    // Its results complete, but the SIGINT ended the runner as it wrote its reports.
    expect(
      runOutcome(
        input(PASSED, { stop, playwright: { code: null, signal: "SIGINT" } }),
      ),
    ).toEqual({ status: "stopped", reason: why });
  });

  test("judged by its results when the interrupt came once its tests were over, and it ended on its own", () => {
    const stop = { level: "interrupted", why: "too late" } as const;
    expect(runOutcome(input(PASSED, { stop }))).toEqual({ status: "passed" });
  });

  test("stopped when the orchestrator's drain skipped scenarios", () => {
    const events = [
      runBegin(3),
      runEnd("passed", { total: 3, passed: 1, skipped: 2, drained: 2 }),
    ];
    expect(
      runOutcome(
        input(events, { stop: { level: "drained", why: "stopping" } }),
      ),
    ).toEqual({ status: "stopped", reason: "stopping" });
  });

  test("stopped when drained before Playwright reached run.end or even started", () => {
    const stop = { level: "drained", why: "stopping" } as const;
    expect(runOutcome(input([runBegin(2)], { stop })).status).toBe("stopped");
    expect(
      runOutcome(input([], { stop, playwright: undefined, results: undefined }))
        .status,
    ).toBe("stopped");
  });

  test("judged by its results when the drain came as the last scenario ended and skipped nothing", () => {
    expect(
      runOutcome(
        input(PASSED, { stop: { level: "drained", why: "stopping" } }),
      ),
    ).toEqual({ status: "passed" });
  });

  test("stopped from outside the orchestrator: interrupted, or drained", () => {
    expect(
      runOutcome(
        input([runEnd("interrupted", { total: 2 })], {
          playwright: { code: 130, signal: null },
        }),
      ),
    ).toEqual({
      status: "stopped",
      reason: "interrupted from outside the orchestrator",
    });
    expect(
      runOutcome(
        input([runEnd("passed", { total: 2, skipped: 2, drained: 2 })]),
      ),
    ).toEqual({
      status: "stopped",
      reason: "drained from outside the orchestrator",
    });
  });
});

test.describe("runOutcome — error: the run could not test", () => {
  test("bddgen failed: its first error line, else its exit", () => {
    expect(
      runOutcome(
        input([], {
          bddgen: { code: 1, signal: null },
          playwright: undefined,
          results: undefined,
          logTail: [
            "$ bddgen",
            "\u001b[31mError: Missing step definition\u001b[39m",
            "at x",
          ],
        }),
      ),
    ).toEqual({
      status: "error",
      reason: "bddgen exited with code 1: Error: Missing step definition",
    });
    expect(
      runOutcome(
        input([], {
          bddgen: { code: null, signal: "SIGSEGV" },
          playwright: undefined,
          logTail: ["", "last line"],
        }),
      ).reason,
    ).toBe("bddgen was ended by SIGSEGV: last line");
  });

  test("a process that could not start: its cause, never the log, which our own line is left out of", () => {
    expect(
      runOutcome(
        input([], {
          bddgen: { code: null, signal: null, notStarted: "ENOENT" },
          playwright: undefined,
          results: undefined,
          logTail: ["Error: something the log says"],
        }),
      ),
    ).toEqual({ status: "error", reason: "bddgen could not start: ENOENT" });
    expect(
      runOutcome(
        input([], {
          playwright: {
            code: null,
            signal: null,
            notStarted: "recording that it starts failed (ENOSPC)",
          },
          results: undefined,
          logTail: ["bddgen's last line"],
        }),
      ),
    ).toEqual({
      status: "error",
      reason:
        "Playwright could not start: recording that it starts failed (ENOSPC)",
    });
  });

  test("Playwright never started though bddgen passed", () => {
    expect(
      runOutcome(input([], { playwright: undefined, results: undefined }))
        .reason,
    ).toBe("Playwright never started");
  });

  test("Playwright ended without run.end: its exit and the log's last lines", () => {
    expect(
      runOutcome(
        input([runBegin(2), scenarioEnd("a", "passed")], {
          playwright: { code: null, signal: "SIGKILL" },
          logTail: ["one", "two", "three", "four"],
        }),
      ),
    ).toEqual({
      status: "error",
      reason:
        "Playwright was ended by SIGKILL without finishing its results: two · three · four",
    });
    expect(
      runOutcome(
        input([], {
          playwright: { code: 1, signal: null },
          results: undefined,
        }),
      ).reason,
    ).toBe("Playwright exited with code 1 without finishing its results");
  });

  test("error: a stream that is there but was not read says why, not that the run never finished", () => {
    const unread = input([], {
      results: undefined,
      resultsUnread: "it is over the cap",
    });
    expect(runOutcome(unread)).toEqual({
      status: "error",
      reason:
        "Playwright exited with code 0, and its results could not be read: it is over the cap",
    });
    // A stop still wins: it explains the run before any missing result.
    expect(
      runOutcome({ ...unread, stop: { level: "interrupted", why: "Ctrl-C" } })
        .status,
    ).toBe("stopped");
  });

  test("a setup failed: the facts' line first, else the stream's error, else that one did", () => {
    const events = [
      runBegin(2),
      setupEnd("artifacts", "failed", "APVM: ref not found"),
      runEnd(
        "failed",
        { total: 2, didNotRun: 2 },
        { total: 2, passed: 1, failed: 1 },
      ),
    ];
    expect(
      runOutcome(
        input(events, {
          playwright: FAILED,
          setupFailures: [
            {
              setup: "artifacts",
              message: "build failed: ref develop2 not found",
            },
          ],
        }),
      ),
    ).toEqual({
      status: "error",
      reason:
        "the artifacts setup failed: build failed: ref develop2 not found",
    });
    expect(runOutcome(input(events, { playwright: FAILED })).reason).toBe(
      "the artifacts setup failed: APVM: ref not found",
    );
    expect(
      runOutcome(
        input([setupEnd("auth", "interrupted"), runEnd("failed")], {
          playwright: FAILED,
        }),
      ).reason,
    ).toBe("the auth setup failed");
    expect(
      runOutcome(
        input([runEnd("failed", {}, { total: 2, failed: 1 })], {
          playwright: FAILED,
        }),
      ).reason,
    ).toBe("a setup failed");
  });

  test("an error outside any test, even beside scenarios that ran", () => {
    const events = [
      runError("Error: spec would not load"),
      runEnd("failed", { total: 2, passed: 2 }),
    ];
    expect(runOutcome(input(events, { playwright: FAILED }))).toEqual({
      status: "error",
      reason: "an error outside any test: Error: spec would not load",
    });
  });

  test("the run's time limit, said rather than the error Playwright writes with it", () => {
    // What Playwright 1.65.1 writes for `globalTimeout`: the error, then `timedout`.
    const events = [
      runError("Timed out waiting 4s for the test suite to run"),
      runEnd("timedout", { total: 2, passed: 1, didNotRun: 1 }),
    ];
    expect(runOutcome(input(events, { playwright: FAILED })).reason).toBe(
      "the run reached its time limit",
    );
  });

  test("no scenario ran: none planned, or all skipped", () => {
    expect(runOutcome(input([runEnd("passed")])).reason).toBe(
      "no scenario ran: none matched",
    );
    // What a filter that matches nothing writes: "No tests found" is no error of the run's.
    for (const message of ["Error: No tests found", "No tests found."])
      expect(
        runOutcome(
          input([runError(message), runEnd("failed")], { playwright: FAILED }),
        ).reason,
        message,
      ).toBe("no scenario ran: none matched");
    expect(
      runOutcome(input([runEnd("passed", { total: 3, skipped: 3 })])).reason,
    ).toBe("no scenario ran: 3 planned, none passed or failed");
  });

  test("Playwright's failed status when no scenario failed and no error says why", () => {
    const events = [runEnd("failed", { total: 2, passed: 2 })];
    expect(runOutcome(input(events, { playwright: FAILED }))).toEqual({
      status: "error",
      reason: "Playwright says the run failed, though no scenario failed",
    });
  });

  test("an exit code the results do not explain", () => {
    expect(runOutcome(input(PASSED, { playwright: FAILED })).reason).toBe(
      "Playwright exited with code 1, though its results say it passed",
    );
    expect(
      runOutcome(
        input([runEnd("failed", { total: 1, failed: 1 })], { playwright: OK }),
      ).reason,
    ).toBe("Playwright exited with code 0, though its results say it failed");
    expect(
      runOutcome(
        input(PASSED, {
          playwright: { code: null, signal: "SIGKILL" },
          logTail: ["bye"],
        }),
      ).reason,
    ).toBe(
      "Playwright was ended by SIGKILL, though its results say it passed: bye",
    );
  });

  test("an error wins over failed scenarios", () => {
    const events = [
      setupEnd("auth", "failed", "login"),
      runEnd("failed", { total: 2, failed: 2 }),
    ];
    expect(runOutcome(input(events, { playwright: FAILED })).status).toBe(
      "error",
    );
  });
});

test.describe("runOutcome — the reason", () => {
  test("is one line, without terminal codes, at most MAX_REASON_LENGTH code points", () => {
    const why = `line one\n\u001b[2Jline two ${"😀".repeat(600)}`;
    const { reason } = runOutcome(
      input([], { stop: { level: "killed", why } }),
    );
    expect(reason).toMatch(/^line one line two (?:😀)+…$/u);
    expect(Array.from(reason ?? "")).toHaveLength(MAX_REASON_LENGTH);
  });
});

test.describe("runOutcome — credentials in a reason", () => {
  test("masks a secret the orchestrator holds by its value, wherever the reason quotes it", () => {
    const token = "0123456789abcdef0123456789abcdef01234567";
    const { reason } = runOutcome(
      input(
        [runError(`apvm: Bad credentials for ${token}`), runEnd("failed")],
        {
          playwright: FAILED,
          secrets: [token, "Tr0ub4dor&3xyz"],
          logTail: [],
        },
      ),
    );
    expect(reason).toBe(
      "an error outside any test: apvm: Bad credentials for ***",
    );
    const fromLog = runOutcome(
      input([], {
        playwright: FAILED,
        results: undefined,
        secrets: ["Tr0ub4dor&3xyz"],
        logTail: ["ftp login failed: password=Tr0ub4dor&3xyz"],
      }),
    ).reason;
    expect(fromLog).not.toContain("Tr0ub4dor");
  });

  test("masks a credential split by a terminal code or a zero-width character", () => {
    const token = `ghp_${"a".repeat(36)}`;
    for (const split of [
      `\u001b[36m${token}\u001b[39m`,
      `ghp_\u200b${"a".repeat(36)}`,
      `Authorization: Bearer \u001b[33mabcdefghijklmnop123456\u001b[0m`,
    ]) {
      const { reason } = runOutcome(
        input([runError(split), runEnd("failed")], { playwright: FAILED }),
      );
      expect(reason, split).not.toMatch(/a{36}|abcdefghijklmnop/);
    }
  });

  test("masks a URL's password that holds a control character", () => {
    const { reason } = runOutcome(
      input([], {
        playwright: FAILED,
        results: undefined,
        logTail: ["at https://user:pa\u0007ss@host.test/"],
      }),
    );
    expect(reason).not.toMatch(/pa\s?ss/);
  });

  test("masks what the log's lines quote, by shape", () => {
    const { reason } = runOutcome(
      input([], {
        playwright: { code: 1, signal: null },
        results: undefined,
        logTail: [
          "page.goto: net::ERR at https://admin:s3cret-pass@bwu3.test/wp-admin",
        ],
      }),
    );
    expect(reason).toBe(
      "Playwright exited with code 1 without finishing its results: page.goto: net::ERR at https://***@bwu3.test/wp-admin",
    );
  });
});

test.describe("isNoTestsFound", () => {
  test("agrees with the suite's own rule, terminal codes and surrounding space included", () => {
    for (const message of [
      "Error: No tests found",
      "No tests found.",
      "\u001b[31mError: No tests found\u001b[39m",
      "  No tests found  ",
      "No tests foundation",
      "Error: no tests found",
      "Worker failed: No tests found",
      "",
    ])
      expect(isNoTestsFound(message), message).toBe(
        suiteIsNoTestsFound({ message }),
      );
  });
});

test.describe("describeExit", () => {
  test("says the signal, else the code", () => {
    expect(describeExit({ code: 2, signal: null })).toBe("exited with code 2");
    expect(describeExit({ code: null, signal: "SIGINT" })).toBe(
      "was ended by SIGINT",
    );
    expect(describeExit({ code: null, signal: null })).toBe("ended");
  });
});
