import { test, expect } from "@playwright/test";

import {
  addAttempt,
  afterHooks,
  beforeHooks,
  fakeTest,
  step,
} from "../__fixtures__/reporter-fakes";
import { STOPPED_ANNOTATION } from "../config/drain";
import {
  MESSAGE_LIMIT,
  RunTally,
  cleanMessage,
  failedStep,
  finalStatus,
  firstError,
  isNoTestsFound,
  scenarioPlace,
  setupOf,
  wasDrainedTest,
  willRetry,
  type StepLike,
} from "./results";

/**
 * How a run's results are read: which attempt is a test's last, its final status, the first error a
 * failure shows and where, where a scenario sits, and the counts. Each step tree below is the shape a
 * real run produced (Playwright 1.63, playwright-bdd 9.2) for the case it is named after.
 */

/** An attempt with these steps and this error, as {@link firstError} reads it. */
function attempt(
  steps: readonly StepLike[],
  error?: string,
): Parameters<typeof firstError>[0] {
  return { errors: error === undefined ? [] : [{ message: error }], steps };
}

test.describe("willRetry — the dispatcher's own rule", () => {
  test("a failed or timed-out attempt with retries left runs again; without, it does not", () => {
    for (const status of ["failed", "timedOut"] as const) {
      const fake = fakeTest({ retries: 1 });
      expect(willRetry(fake.test, addAttempt(fake, { status })), status).toBe(
        true,
      );
      expect(willRetry(fake.test, addAttempt(fake, { status })), status).toBe(
        false,
      );
    }
  });

  test("a passed attempt, or one the test skipped itself, is never retried", () => {
    const passed = fakeTest({ retries: 2 });
    expect(
      willRetry(passed.test, addAttempt(passed, { status: "passed" })),
    ).toBe(false);
    const skipped = fakeTest({ retries: 2 });
    expect(
      willRetry(skipped.test, addAttempt(skipped, { status: "skipped" })),
    ).toBe(false);
  });

  test("an attempt Playwright skipped without running it runs again (a failed beforeAll)", () => {
    const fake = fakeTest({ retries: 1 });
    expect(
      willRetry(
        fake.test,
        addAttempt(fake, { status: "skipped", expectedStatus: "passed" }),
      ),
    ).toBe(true);
    expect(
      willRetry(
        fake.test,
        addAttempt(fake, { status: "skipped", expectedStatus: "passed" }),
      ),
    ).toBe(false);
  });

  test("an interrupted attempt never runs again, even with retries left", () => {
    const fake = fakeTest({ retries: 3 });
    addAttempt(fake, { status: "failed" });
    expect(
      willRetry(fake.test, addAttempt(fake, { status: "interrupted" })),
    ).toBe(false);
  });

  test("a test expected to fail is retried when it passes", () => {
    const fake = fakeTest({ retries: 1 });
    expect(
      willRetry(
        fake.test,
        addAttempt(fake, { status: "passed", expectedStatus: "failed" }),
      ),
    ).toBe(true);
    expect(
      willRetry(
        fake.test,
        addAttempt(fake, { status: "failed", expectedStatus: "failed" }),
      ),
    ).toBe(false);
  });
});

test.describe("finalStatus", () => {
  const cases: [string, readonly TestStatusInput[], string][] = [
    ["passed", ["passed"], "passed"],
    ["failed", ["failed"], "failed"],
    ["timed out", ["timedOut"], "failed"],
    ["failed, then passed", ["failed", "passed"], "flaky"],
    ["skipped", ["skipped"], "skipped"],
    ["interrupted", ["interrupted"], "interrupted"],
    ["failed, then interrupted", ["failed", "interrupted"], "interrupted"],
  ];
  for (const [name, statuses, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      const fake = fakeTest({ retries: statuses.length });
      let last = addAttempt(fake, { status: statuses[0] ?? "passed" });
      for (const status of statuses.slice(1))
        last = addAttempt(fake, { status });
      expect(finalStatus(fake.test, last)).toBe(expected);
    });
  }
});

/** An attempt's status. */
type TestStatusInput =
  "passed" | "failed" | "timedOut" | "skipped" | "interrupted";

test.describe("cleanMessage", () => {
  test("strips ANSI codes and trailing whitespace", () => {
    expect(cleanMessage("Error: \u001b[31mboom\u001b[39m \n\n")).toBe(
      "Error: boom",
    );
  });

  test("a format character inside a credential cannot defeat the mask: it goes first", () => {
    // Masked first, the token's head alone matched and its tail showed once `plain` joined it.
    const token = "ghp_A1b2C3d4E5f6G7h8I9\u200bj0K1l2M3n4O5p6Q7r8";
    expect(cleanMessage(`Error: auth with ${token} failed\nnext`)).toBe(
      "Error: auth with *** failed\nnext",
    );
    expect(cleanMessage("https://admin:pa\u202ess@h.example/")).toBe(
      "https://***@h.example/",
    );
  });

  test("drops Playwright's call log, whose element markup carries attribute values", () => {
    // Verbatim, as Playwright 1.63 reported a locator timeout on `<input value="…">`.
    const message =
      "TimeoutError: locator.click: Timeout 500ms exceeded.\nCall log:\n" +
      "\u001b[2m  - waiting for locator('#pw')\u001b[22m\n" +
      '\u001b[2m    - locator resolved to <input id="pw" value="s3cr3tAttr"/>\u001b[22m\n';
    expect(cleanMessage(message)).toBe(
      "TimeoutError: locator.click: Timeout 500ms exceeded.",
    );
    // An assertion keeps what it compared, and loses only the log after it.
    const assertion =
      'Error: expect(locator).toHaveValue(expected) failed\n\nExpected: "other"\n' +
      "Timeout:  300ms\n\nCall log:\n  - waiting for locator('#pw')\n";
    expect(cleanMessage(assertion)).toBe(
      'Error: expect(locator).toHaveValue(expected) failed\n\nExpected: "other"\nTimeout:  300ms',
    );
    expect(cleanMessage("Error: the words Call log: inline stay")).toBe(
      "Error: the words Call log: inline stay",
    );
  });

  test("masks credentials, before the cut could leave one without the @ that marks it", () => {
    // Verbatim, as Playwright 1.63 reported a navigation to a basic-auth URL.
    expect(
      cleanMessage(
        "page.goto: net::ERR_UNSAFE_PORT at http://u:SECRETPW@127.0.0.1:9/wp-login.php\nCall log:\n" +
          '\u001b[2m  - navigating to "http://u:SECRETPW@127.0.0.1:9/wp-login.php"\u001b[22m\n',
      ),
    ).toBe(
      "page.goto: net::ERR_UNSAFE_PORT at http://***@127.0.0.1:9/wp-login.php",
    );
    // Cut inside the password: masked first, nothing of it is left.
    const message = `${"x".repeat(5)} https://user:SECRETPASSWORD@host`;
    expect(cleanMessage(message, 40)).not.toMatch(/SECRET/);
  });

  test("cuts at the limit, saying so, and keeps a short message whole", () => {
    const long = "x".repeat(MESSAGE_LIMIT + 50);
    const cut = cleanMessage(long);
    expect(cut).toHaveLength(MESSAGE_LIMIT);
    expect(cut.endsWith("… [truncated]")).toBe(true);
    expect(cleanMessage("x".repeat(MESSAGE_LIMIT))).toBe(
      "x".repeat(MESSAGE_LIMIT),
    );
    expect(cleanMessage("abcdef", 3)).toBe("… [truncated]".slice(0, 3));
    expect(cleanMessage("abcdef", 0)).toBe("");
  });

  test("never cuts a character in half", () => {
    // "😀" is two UTF-16 units; a cut between them would leave a lone surrogate.
    const marker = "… [truncated]";
    const message = `${"x".repeat(4)}😀${"y".repeat(40)}`;
    const cut = cleanMessage(message, 5 + marker.length);
    expect(cut).toBe(`xxxx${marker}`);
    expect(cleanMessage(message, 6 + marker.length)).toBe(`xxxx😀${marker}`);
  });
});

test.describe("firstError — what a failure shows, and where", () => {
  test("a failing Gherkin step", () => {
    const steps = [
      beforeHooks(),
      step("Given a step that passes", "test.step"),
      step('When a step fails with "boom"', "test.step", {
        error: "Error: \u001b[31mboom\u001b[39m",
      }),
      afterHooks(),
      step("Worker Cleanup", "hook"),
    ];
    expect(firstError(attempt(steps, "Error: boom"))).toEqual({
      message: "Error: boom",
      where: "step",
      step: 'When a step fails with "boom"',
    });
  });

  test("a failing Background step is named alone, not by its hook", () => {
    const steps = [
      step("Before Hooks", "hook", {
        error: "Error: bg",
        steps: [
          step("BeforeEach Hooks", "hook"),
          step("Background", "hook", {
            error: "Error: bg",
            steps: [
              step("Given a background step", "test.step", {
                error: "Error: bg",
              }),
            ],
          }),
        ],
      }),
      afterHooks(),
    ];
    expect(firstError(attempt(steps, "Error: bg"))).toEqual({
      message: "Error: bg",
      where: "step",
      step: "Given a background step",
    });
  });

  test("a test.step nested in a Gherkin step is blamed on the Gherkin step", () => {
    const steps = [
      beforeHooks(),
      step("Given a step with a nested failing step", "test.step", {
        error: "Error: nested boom",
        steps: [step("inner", "test.step", { error: "Error: nested boom" })],
      }),
      afterHooks(),
    ];
    expect(firstError(attempt(steps, "Error: nested boom"))).toMatchObject({
      where: "step",
      step: "Given a step with a nested failing step",
    });
  });

  test("a failing Before hook, down to the hook itself", () => {
    const steps = [
      step("Before Hooks", "hook", {
        error: "Error: before boom",
        steps: [
          step("BeforeEach Hooks", "hook", {
            error: "Error: before boom",
            steps: [
              step("BeforeEach hook", "test.step", {
                error: "Error: before boom",
              }),
            ],
          }),
          step("Background", "hook"),
        ],
      }),
      afterHooks(),
    ];
    expect(firstError(attempt(steps, "Error: before boom"))).toEqual({
      message: "Error: before boom",
      where: "hook",
      step: "Before Hooks › BeforeEach Hooks › BeforeEach hook",
    });
  });

  test("a failing After hook, by its name — where a DebugLogFatalError lands", () => {
    const steps = [
      beforeHooks(),
      step("Given a step that passes", "test.step"),
      afterHooks({
        error: "DebugLogFatalError: PHP Fatal error",
        inside: [
          step("AfterEach Hooks", "hook", {
            error: "DebugLogFatalError: PHP Fatal error",
            steps: [
              step("@plugin teardown", "test.step", {
                error: "DebugLogFatalError: PHP Fatal error",
              }),
            ],
          }),
        ],
      }),
    ];
    expect(
      firstError(attempt(steps, "DebugLogFatalError: PHP Fatal error")),
    ).toEqual({
      message: "DebugLogFatalError: PHP Fatal error",
      where: "hook",
      step: "After Hooks › AfterEach Hooks › @plugin teardown",
    });
  });

  test("a failing fixture", () => {
    const steps = [
      step("Before Hooks", "hook", {
        error: "Error: fixture boom",
        steps: [
          step("BeforeEach Hooks", "hook"),
          step('Fixture "broken"', "fixture", { error: "Error: fixture boom" }),
        ],
      }),
      afterHooks(),
    ];
    expect(firstError(attempt(steps, "Error: fixture boom"))).toEqual({
      message: "Error: fixture boom",
      where: "hook",
      step: 'Before Hooks › Fixture "broken"',
    });
  });

  test("a hook that times out: its error sits on the hooks step, not the hook", () => {
    const timeout =
      'Test timeout of 3000ms exceeded while running "beforeEach" hook.';
    const steps = [
      step("Before Hooks", "hook", {
        error: timeout,
        steps: [
          step("BeforeEach Hooks", "hook", {
            error: timeout,
            steps: [step("BeforeEach hook", "test.step")],
          }),
        ],
      }),
      afterHooks(),
    ];
    expect(firstError(attempt(steps, timeout))).toEqual({
      message: timeout,
      where: "hook",
      step: "Before Hooks › BeforeEach Hooks",
    });
  });

  test("a timeout inside a step: no step failed, so the last step begun is named", () => {
    const steps = [
      beforeHooks(),
      step("Given a step that passes", "test.step"),
      step("Given a step that hangs", "test.step", {
        steps: [
          step("waits for the job", "test.step"),
          step("page.click", "pw:api"),
        ],
      }),
      afterHooks(),
      step("Worker Cleanup", "hook"),
    ];
    expect(
      firstError(
        attempt(steps, "\u001b[31mTest timeout of 3000ms exceeded.\u001b[39m"),
      ),
    ).toEqual({
      message: "Test timeout of 3000ms exceeded.",
      where: "last-step",
      step: "Given a step that hangs",
    });
  });

  test("a timeout inside a step, then an After hook failing in its clean-up: the timeout is the cause", () => {
    const timeout = "Test timeout of 1500ms exceeded.";
    const teardown = "Error: the job would not stop";
    const steps = [
      beforeHooks(),
      step("When the backup runs", "test.step"),
      afterHooks({
        error: teardown,
        inside: [
          step("AfterEach Hooks", "hook", {
            error: teardown,
            steps: [step("@plugin teardown", "test.step", { error: teardown })],
          }),
        ],
      }),
    ];
    expect(
      firstError({
        errors: [{ message: timeout }, { message: teardown }],
        steps,
      }),
    ).toEqual({
      message: timeout,
      where: "last-step",
      step: "When the backup runs",
    });
  });

  test("the last step begun is narrowed into its reportable children", () => {
    const steps = [
      beforeHooks(),
      step("When the backup runs", "test.step", {
        steps: [step("waits for the job", "test.step")],
      }),
    ];
    expect(firstError(attempt(steps, "Test timeout"))).toMatchObject({
      where: "last-step",
      step: "When the backup runs › waits for the job",
    });
  });

  test("a crashed worker: no After Hooks, the last step begun is named", () => {
    const steps = [
      beforeHooks(),
      step("Given a step that exits the process", "test.step"),
    ];
    expect(
      firstError(
        attempt(
          steps,
          "Error: worker process exited unexpectedly (code=3, signal=null)",
        ),
      ),
    ).toEqual({
      message:
        "Error: worker process exited unexpectedly (code=3, signal=null)",
      where: "last-step",
      step: "Given a step that exits the process",
    });
  });

  test("a crash in a Before hook names the hook that was running: it never ended", () => {
    const steps = [
      step("Before Hooks", "hook", {
        duration: -1,
        steps: [
          step("BeforeEach Hooks", "hook", {
            duration: -1,
            steps: [step("BeforeEach hook", "test.step", { duration: -1 })],
          }),
        ],
      }),
    ];
    expect(
      firstError(attempt(steps, "Error: worker process exited")),
    ).toMatchObject({
      where: "last-step",
      step: "Before Hooks › BeforeEach Hooks › BeforeEach hook",
    });
  });

  test("a body that failed with no step, after its Before hooks ended: no step, never a closing hook", () => {
    // The auth setup failing its preflight, as Playwright 1.63 reported it.
    const message = "Error: [preflight] Transport verification failed";
    const steps = [
      step("Before Hooks", "hook", {
        duration: 12,
        steps: [
          step("beforeEach hook", "hook", { duration: 1 }),
          step('Fixture "browser"', "fixture", {
            duration: 10,
            steps: [step("Launch browser", "pw:api", { duration: 9 })],
          }),
        ],
      }),
      step("After Hooks", "hook", {
        duration: 3,
        steps: [
          step("afterEach hook", "hook", { duration: 1 }),
          step("afterEach hook", "hook", { duration: 1 }),
        ],
      }),
      step("Worker Cleanup", "hook", {
        duration: 5,
        steps: [step('Fixture "browser"', "fixture", { duration: 5 })],
      }),
    ];
    expect(firstError(attempt(steps, message))).toEqual({
      message,
      where: "test",
    });
    expect(failedStep(attempt(steps, message))).toBeUndefined();
    // The same with no duration recorded (read as ended), or no Before Hooks at all.
    const bare = [
      step("Before Hooks", "hook"),
      step("After Hooks", "hook"),
      step("Worker Cleanup", "hook"),
    ];
    expect(failedStep(attempt(bare, message))).toBeUndefined();
    expect(failedStep(attempt(bare.slice(1), message))).toBeUndefined();
    // A hook that ended at once (0 ms) ended all the same.
    const instant = [step("Before Hooks", "hook", { duration: 0 })];
    expect(failedStep(attempt(instant, message))).toBeUndefined();
  });

  test("a crash in a closing hook is never named as running: it began after the body", () => {
    const steps = [
      beforeHooks(),
      step("After Hooks", "hook", {
        duration: -1,
        steps: [step("AfterEach Hooks", "hook", { duration: -1 })],
      }),
    ];
    expect(
      failedStep(attempt(steps, "Error: worker process exited")),
    ).toBeUndefined();
  });

  test("never names a Playwright API step, whose title can hold a typed value", () => {
    const steps = [
      step('Fill "s3cr3t"', "pw:api", { error: "Error: fill failed" }),
    ];
    expect(firstError(attempt(steps, "Error: fill failed"))).toEqual({
      message: "Error: fill failed",
      where: "test",
    });
    const nested = [
      step("Given I log in", "test.step", {
        steps: [step('Fill "s3cr3t"', "pw:api")],
      }),
    ];
    expect(firstError(attempt(nested, "Test timeout"))?.step).toBe(
      "Given I log in",
    );
  });

  test("a setup's own test.step is a step", () => {
    const steps = [
      step("Before Hooks", "hook"),
      step("preflight", "test.step", { error: "Error: transport unreachable" }),
      step("After Hooks", "hook"),
    ];
    expect(firstError(attempt(steps, "Error: transport unreachable"))).toEqual({
      message: "Error: transport unreachable",
      where: "step",
      step: "preflight",
    });
  });

  test("an error with no step at all is the test's", () => {
    expect(firstError(attempt([], "Error: config boom"))).toEqual({
      message: "Error: config boom",
      where: "test",
    });
  });

  test("an attempt with no error and no failing step shows none", () => {
    expect(firstError(attempt([beforeHooks(), afterHooks()]))).toBeUndefined();
  });

  test("an error given only as a value is read", () => {
    expect(
      firstError({ errors: [{ value: "thrown string" }], steps: [] }),
    ).toEqual({
      message: "thrown string",
      where: "test",
    });
  });
});

test.describe("scenarioPlace", () => {
  test("a scenario: its feature, its title and its .feature file", () => {
    const { test: t } = fakeTest();
    expect(scenarioPlace(t, "/repo/.features-gen/demo/x")).toEqual({
      feature: "Demo feature",
      scenario: "A scenario",
      path: [],
      file: "src/projects/demo/features/demo.feature",
    });
  });

  test("an Outline's example under a Rule keeps both titles in its path", () => {
    const { test: t } = fakeTest({
      titles: [
        "demo.feature.spec.js",
        "Demo feature",
        "A rule",
        "outline <n>",
        "outline 1",
      ],
    });
    expect(scenarioPlace(t, "/repo/.features-gen/demo/x")).toMatchObject({
      feature: "Demo feature",
      scenario: "outline 1",
      path: ["A rule", "outline <n>"],
    });
  });

  test("a setup: its file stands for the feature, and it has no .feature file", () => {
    const { test: t } = fakeTest({
      project: "setup:x",
      titles: ["auth.setup.ts", "authenticate"],
      file: "/repo/src/common/auth/auth.setup.ts",
    });
    expect(scenarioPlace(t, "/repo/src/common/auth")).toEqual({
      feature: "auth.setup.ts",
      scenario: "authenticate",
      path: [],
    });
  });

  test("a folder whose name merely starts with two dots is inside", () => {
    const { test: t } = fakeTest({
      file: "/repo/.features-gen/demo/x/..hidden/a.feature.spec.js",
    });
    expect(scenarioPlace(t, "/repo/.features-gen/demo/x").file).toBe(
      "..hidden/a.feature",
    );
  });

  test("a spec outside its project's folder, or no folder, names no file", () => {
    const { test: t } = fakeTest({ file: "/elsewhere/demo.feature.spec.js" });
    expect(scenarioPlace(t, "/repo/.features-gen/demo/x").file).toBeUndefined();
    expect(scenarioPlace(t, undefined).file).toBeUndefined();
  });
});

test.describe("setupOf and wasDrainedTest", () => {
  test("a setup is known by its project", () => {
    expect(setupOf(fakeTest({ project: "setup:x" }).test)).toBe("auth");
    expect(setupOf(fakeTest({ project: "artifacts:x" }).test)).toBe(
      "artifacts",
    );
    expect(setupOf(fakeTest({ project: "x" }).test)).toBeUndefined();
  });

  test("a drained scenario carries the drain's annotation", () => {
    expect(
      wasDrainedTest(
        fakeTest({ annotations: [{ type: STOPPED_ANNOTATION }] }).test,
      ),
    ).toBe(true);
    expect(
      wasDrainedTest(fakeTest({ annotations: [{ type: "skip" }] }).test),
    ).toBe(false);
  });
});

test.describe("RunTally", () => {
  /** A ledger begun with these tests. */
  function begun(...tests: ReturnType<typeof fakeTest>[]): RunTally {
    const tally = new RunTally();
    tally.begin(tests.map((t) => t.test));
    return tally;
  }

  test("splits setups from scenarios, counts final statuses, and the rest did not run", () => {
    const setup = fakeTest({ id: "s", project: "setup:x" });
    const artifacts = fakeTest({ id: "a", project: "artifacts:x" });
    const failed = fakeTest({ id: "1" });
    const flaky = fakeTest({ id: "2", retries: 1 });
    const interrupted = fakeTest({ id: "3" });
    const never = fakeTest({ id: "4" });
    const tally = begun(setup, artifacts, failed, flaky, interrupted, never);
    expect(tally.scenarios).toMatchObject({ total: 4, didNotRun: 4 });
    expect(tally.setups).toMatchObject({ total: 2, didNotRun: 2 });

    expect(
      tally.attemptEnded(setup.test, addAttempt(setup, { status: "passed" })),
    ).toEqual({
      final: true,
      status: "passed",
    });
    tally.attemptEnded(failed.test, addAttempt(failed, { status: "failed" }));
    expect(
      tally.attemptEnded(flaky.test, addAttempt(flaky, { status: "failed" })),
    ).toEqual({
      final: false,
    });
    tally.attemptEnded(flaky.test, addAttempt(flaky, { status: "passed" }));
    tally.attemptEnded(
      interrupted.test,
      addAttempt(interrupted, { status: "interrupted" }),
    );

    expect(tally.scenarios).toEqual({
      total: 4,
      passed: 0,
      failed: 1,
      flaky: 1,
      skipped: 0,
      interrupted: 1,
      didNotRun: 1,
      drained: 0,
    });
    expect(tally.setups).toMatchObject({ total: 2, passed: 1, didNotRun: 1 });
    // Nothing awaits a retry: the flaky one got it.
    expect(tally.settle()).toEqual([]);
  });

  test("settles a test whose due retry never ran with what its attempts give it", () => {
    const stopped = fakeTest({ id: "1", retries: 1 });
    const imposedSkip = fakeTest({ id: "2", retries: 1 });
    const tally = begun(stopped, imposedSkip);
    const last = addAttempt(stopped, {
      status: "failed",
      errors: ["Error: x"],
    });
    tally.attemptEnded(stopped.test, last);
    tally.attemptEnded(
      imposedSkip.test,
      addAttempt(imposedSkip, { status: "skipped", expectedStatus: "passed" }),
    );
    expect(tally.scenarios).toMatchObject({ failed: 0, didNotRun: 2 });

    const settled = tally.settle();
    expect(settled.map((s) => [s.test.id, s.status])).toEqual([
      ["1", "failed"],
      ["2", "skipped"],
    ]);
    expect(settled[0]?.result).toBe(last);
    expect(tally.scenarios).toMatchObject({
      failed: 1,
      skipped: 1,
      didNotRun: 0,
    });
    // Settling twice settles nothing more.
    expect(tally.settle()).toEqual([]);
  });

  test("a later end for the same test replaces the earlier one", () => {
    const fake = fakeTest({ id: "1", retries: 1 });
    const tally = begun(fake);
    tally.attemptEnded(fake.test, addAttempt(fake, { status: "passed" }));
    // A serial-mode suite re-runs a passed test after a sibling failed.
    tally.attemptEnded(fake.test, addAttempt(fake, { status: "failed" }));
    expect(tally.scenarios).toMatchObject({
      total: 1,
      passed: 0,
      flaky: 1,
      didNotRun: 0,
    });
  });

  test("a test the plan did not hold never drives a count below zero", () => {
    const tally = begun();
    const ghost = fakeTest({ id: "ghost" });
    tally.attemptEnded(ghost.test, addAttempt(ghost, { status: "passed" }));
    expect(tally.scenarios).toMatchObject({
      total: 0,
      passed: 1,
      didNotRun: 0,
    });
  });

  test("counts the drain's skips apart, among the skipped", () => {
    const drained = fakeTest({
      id: "1",
      annotations: [{ type: STOPPED_ANNOTATION }],
    });
    const ownSkip = fakeTest({ id: "2", annotations: [{ type: "skip" }] });
    const tally = begun(drained, ownSkip);
    for (const fake of [drained, ownSkip]) {
      tally.attemptEnded(
        fake.test,
        addAttempt(fake, { status: "skipped", expectedStatus: "skipped" }),
      );
    }
    expect(tally.scenarios).toMatchObject({ skipped: 2, drained: 1 });
  });

  test("keeps the errors raised outside any test, but not 'No tests found', each its first line, masked", () => {
    const tally = begun();
    tally.runError({ message: "Error: No tests found" });
    tally.runError({ message: "\u001b[31mNo tests found\u001b[39m" });
    tally.runError({
      message:
        "\n  Error: steps.ts: Cannot find https://u:p@h/x\n    at a.js:1",
    });
    tally.runError({});
    expect(tally.runErrors).toEqual([
      "Error: steps.ts: Cannot find https://***@h/x",
      "an error with no message",
    ]);
    tally.begin([]);
    expect(tally.runErrors).toEqual([]);
  });

  test("isNoTestsFound knows Playwright's words only", () => {
    expect(isNoTestsFound({ message: "Error: No tests found" })).toBe(true);
    expect(isNoTestsFound({ message: "No tests found." })).toBe(true);
    expect(isNoTestsFound({ message: "Error: No tests foundry" })).toBe(false);
    expect(isNoTestsFound({ message: "Error: boom. No tests found" })).toBe(
      false,
    );
  });

  test("begin starts afresh", () => {
    const fake = fakeTest({ id: "1", retries: 1 });
    const tally = begun(fake);
    tally.attemptEnded(fake.test, addAttempt(fake, { status: "failed" }));
    tally.begin([fake.test]);
    expect(tally.settle()).toEqual([]);
    expect(tally.scenarios).toMatchObject({ total: 1, didNotRun: 1 });
  });
});

test.describe("failedStep — the step a failure block and the summary name", () => {
  test("a failing Gherkin step: itself, never the API steps under it", () => {
    const steps = [
      beforeHooks(),
      step("When the form is filled", "test.step", {
        error: "Error: no",
        steps: [step('Fill "s3cr3t"', "pw:api", { error: "Error: no" })],
      }),
      afterHooks(),
    ];
    expect(failedStep(attempt(steps, "Error: no"))).toEqual({
      label: "Step",
      path: ["When the form is filled"],
      running: false,
    });
  });

  test("a Background's failing step is a step too", () => {
    const steps = [
      beforeHooks({
        error: "Error: bg",
        inside: [
          step("Background", "hook", {
            error: "Error: bg",
            steps: [
              step("Given a background step", "test.step", {
                error: "Error: bg",
              }),
            ],
          }),
        ],
      }),
    ];
    expect(failedStep(attempt(steps, "Error: bg"))?.path).toEqual([
      "Given a background step",
    ]);
  });

  test("a timeout inside a step: the Gherkin step that was running, not its children", () => {
    const steps = [
      beforeHooks(),
      step("When the backup runs", "test.step", {
        steps: [step("waits for the job", "test.step")],
      }),
      afterHooks(),
    ];
    expect(failedStep(attempt(steps, "Test timeout"))).toEqual({
      label: "Step",
      path: ["When the backup runs"],
      running: true,
    });
  });

  test("a hook or a fixture: its path, labelled Hook", () => {
    const steps = [
      step("Before Hooks", "hook", {
        error: "Error: fixture boom",
        steps: [
          step('Fixture "site"', "fixture", { error: "Error: fixture boom" }),
        ],
      }),
    ];
    expect(failedStep(attempt(steps, "Error: fixture boom"))).toEqual({
      label: "Hook",
      path: ["Before Hooks", 'Fixture "site"'],
      running: false,
    });
  });

  test("a setup's own test.step is a Step", () => {
    const steps = [
      step("preflight", "test.step", { error: "Error: unreachable" }),
    ];
    expect(failedStep(attempt(steps, "Error: unreachable"))).toEqual({
      label: "Step",
      path: ["preflight"],
      running: false,
    });
  });

  test("only an API step failed, or no step began: nothing to name", () => {
    expect(
      failedStep(
        attempt(
          [step('Fill "s3cr3t"', "pw:api", { error: "Error: no" })],
          "Error: no",
        ),
      ),
    ).toBeUndefined();
    expect(failedStep(attempt([], "Error: crash"))).toBeUndefined();
  });

  test("a timeout inside a step, then an After hook failing in its clean-up: the step, running", () => {
    const timeout = "Test timeout of 1500ms exceeded.";
    const teardown = "Error: the job would not stop";
    const closing = afterHooks({
      error: teardown,
      inside: [
        step("AfterEach Hooks", "hook", {
          error: teardown,
          steps: [step("@plugin teardown", "test.step", { error: teardown })],
        }),
      ],
    });
    const steps = [
      beforeHooks(),
      step("When the backup runs", "test.step"),
      closing,
    ];
    const result = {
      errors: [{ message: timeout }, { message: teardown }],
      steps,
    };
    expect(failedStep(result)).toEqual({
      label: "Step",
      path: ["When the backup runs"],
      running: true,
    });
    // No step of the body began: neither the hook nor any step, and the first error stands.
    const bodyless = { ...result, steps: [beforeHooks(), closing] };
    expect(failedStep(bodyless)).toBeUndefined();
    expect(firstError(bodyless)).toEqual({ message: timeout, where: "test" });
  });

  test("an After hook whose own error is the first: named, as the hook that failed", () => {
    const teardown = "Error: uninstall failed";
    const steps = [
      beforeHooks(),
      step("When the backup runs", "test.step"),
      afterHooks({
        error: teardown,
        inside: [step("AfterEach Hooks", "hook", { error: teardown })],
      }),
    ];
    expect(failedStep(attempt(steps, teardown))).toEqual({
      label: "Hook",
      path: ["After Hooks", "AfterEach Hooks"],
      running: false,
    });
  });
});
