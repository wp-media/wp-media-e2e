import type { TestCase, TestResult, TestStep } from "@playwright/test/reporter";

import type { StepLike } from "../reporting/results";

/**
 * For specs: just enough of Playwright's reporter objects — a test, an attempt, a step — to drive the
 * suite's reporters without a runner. Each holds only what the reporters read; the shapes were taken
 * from real runs (Playwright 1.63, playwright-bdd 9.2), see `reporting/results.ts`.
 */

/** The folder the fake scenarios' generated specs live in. */
export const FAKE_TEST_DIR = "/repo/.features-gen/demo/x";

/** A step, from its title and category, with an error and children if given. */
export function step(
  title: string,
  category: string,
  options: {
    readonly error?: string;
    readonly steps?: readonly StepLike[];
    /** Its duration; `-1` for one a crashed worker never ended. Absent: left out, read as ended. */
    readonly duration?: number;
  } = {},
): StepLike {
  return {
    title,
    category,
    ...(options.error !== undefined
      ? { error: { message: options.error } }
      : {}),
    ...(options.duration !== undefined ? { duration: options.duration } : {}),
    steps: options.steps ?? [],
  };
}

/** The hook steps every scenario's attempt opens with, a Background's steps inside, when given. */
export function beforeHooks(
  options: {
    readonly error?: string;
    readonly inside?: readonly StepLike[];
  } = {},
): StepLike {
  return step("Before Hooks", "hook", {
    ...(options.error !== undefined ? { error: options.error } : {}),
    steps: [step("BeforeEach Hooks", "hook"), ...(options.inside ?? [])],
  });
}

/** The hook steps every scenario's attempt closes with. */
export function afterHooks(
  options: {
    readonly error?: string;
    readonly inside?: readonly StepLike[];
  } = {},
): StepLike {
  return step("After Hooks", "hook", {
    ...(options.error !== undefined ? { error: options.error } : {}),
    steps: options.inside ?? [step("AfterEach Hooks", "hook")],
  });
}

/** What an attempt is built from. */
export interface FakeAttempt {
  readonly status: TestResult["status"];
  readonly errors?: readonly string[];
  readonly steps?: readonly StepLike[];
  readonly duration?: number;
  readonly attachments?: TestResult["attachments"];
  readonly parallelIndex?: number;
  /**
   * The status the test expects once this attempt ends, as the worker reports it: `skipped` when the
   * test skipped itself (`test.skip()`, the drain) — the default for a skipped attempt — and `passed`
   * otherwise, a skip Playwright imposed without running the test included (a failed `beforeAll`).
   */
  readonly expectedStatus?: TestCase["expectedStatus"];
}

/** What a test is built from. */
export interface FakeTestOptions {
  readonly id?: string;
  /** Its project's name: a cell for a scenario, `setup:<cell>` or `artifacts:<cell>` for a setup. */
  readonly project?: string;
  readonly projectRetries?: number;
  /** The titles after the project: the spec file, then the Feature, Rules, Outline, scenario. */
  readonly titles?: readonly string[];
  /** The generated spec's file. */
  readonly file?: string;
  readonly tags?: readonly string[];
  readonly annotations?: TestCase["annotations"];
  readonly retries?: number;
}

/** A fake test, its attempts added with {@link addAttempt} as a runner would. */
export interface FakeTest {
  readonly test: TestCase;
  readonly results: TestResult[];
}

/**
 * A test's outcome by Playwright's own rule (`computeTestCaseOutcome`, `runner/index.js:605`):
 * interrupted attempts set aside, and skipped ones; none of the rest → `skipped`, none failed →
 * `expected`, none passed → `unexpected`, else `flaky`. An attempt fails when its status is not the
 * one the test expects.
 */
function fakeOutcome(
  results: readonly Pick<TestResult, "status">[],
  expectedStatus: TestCase["expectedStatus"],
): ReturnType<TestCase["outcome"]> {
  const counted = results.filter(
    (r) => r.status !== "interrupted" && r.status !== "skipped",
  );
  const unexpected = counted.filter((r) => r.status !== expectedStatus).length;
  const expected = counted.length - unexpected;
  if (counted.length === 0) return "skipped";
  if (unexpected === 0) return "expected";
  if (expected === 0) return "unexpected";
  return "flaky";
}

/** A test, with no attempt yet; its `outcome()` is {@link fakeOutcome}. */
export function fakeTest(options: FakeTestOptions = {}): FakeTest {
  const project = options.project ?? "x";
  const results: TestResult[] = [];
  const titles = options.titles ?? [
    "demo.feature.spec.js",
    "Demo feature",
    "A scenario",
  ];
  const test: {
    expectedStatus: TestCase["expectedStatus"];
    [key: string]: unknown;
  } = {
    id: options.id ?? "test-1",
    title: titles.at(-1) ?? "",
    titlePath: () => ["", project, ...titles],
    location: {
      file:
        options.file ??
        `${FAKE_TEST_DIR}/src/projects/demo/features/demo.feature.spec.js`,
      line: 1,
      column: 1,
    },
    tags: options.tags ?? [],
    annotations: options.annotations ?? [],
    retries: options.retries ?? 0,
    expectedStatus: "passed",
    results,
    parent: {
      project: () => ({
        name: project,
        testDir: FAKE_TEST_DIR,
        retries: options.projectRetries ?? options.retries ?? 0,
      }),
    },
    outcome: (): ReturnType<TestCase["outcome"]> =>
      fakeOutcome(results, test.expectedStatus),
  };
  return { test: test as unknown as TestCase, results };
}

/**
 * Adds an attempt to a test, as the runner does before `onTestEnd`, and sets the status the test then
 * expects ({@link FakeAttempt.expectedStatus}).
 *
 * @returns the attempt.
 */
export function addAttempt(fake: FakeTest, attempt: FakeAttempt): TestResult {
  // The dispatcher sets the test's expected status from each ended attempt (`_onTestEnd`).
  (fake.test as { expectedStatus: TestCase["expectedStatus"] }).expectedStatus =
    attempt.expectedStatus ??
    (attempt.status === "skipped" ? "skipped" : "passed");
  const result = {
    retry: fake.results.length,
    parallelIndex: attempt.parallelIndex ?? 0,
    status: attempt.status,
    duration: attempt.duration ?? 100,
    errors: (attempt.errors ?? []).map((message) => ({ message })),
    steps: (attempt.steps ?? []) as unknown as TestStep[],
    attachments: attempt.attachments ?? [],
    annotations: [],
  };
  fake.results.push(result as unknown as TestResult);
  return result as unknown as TestResult;
}

/** A fresh attempt about to begin: what `onTestBegin` sees. */
export function beginningAttempt(
  fake: FakeTest,
  parallelIndex = 0,
): TestResult {
  return { retry: fake.results.length, parallelIndex } as unknown as TestResult;
}

/** A suite listing the given tests, as `onBegin` receives it. */
export function fakeSuite(tests: readonly FakeTest[]): {
  allTests: () => TestCase[];
} {
  return { allTests: () => tests.map((t) => t.test) };
}

/** A JSON attachment held in memory, as `testInfo.attach(name, { body })` leaves it. */
export function jsonAttachment(
  name: string,
  value: unknown,
): TestResult["attachments"][number] {
  return {
    name,
    contentType: "application/json",
    body: Buffer.from(JSON.stringify(value)),
  };
}

/**
 * What `body` writes to a stream — stdout or stderr — captured instead of printed.
 *
 * @returns each write's text, in order.
 */
export function captureWrites(
  stream: NodeJS.WriteStream,
  body: () => void,
): string[] {
  const writes: string[] = [];
  const original = stream.write.bind(stream);
  stream.write = (chunk: string | Uint8Array): boolean => {
    writes.push(String(chunk));
    return true;
  };
  try {
    body();
  } finally {
    stream.write = original;
  }
  return writes;
}
