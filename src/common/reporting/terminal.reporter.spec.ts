import { test, expect } from "@playwright/test";
import { stripVTControlCharacters } from "node:util";

import type {
  FullConfig,
  FullResult,
  Suite,
  TestCase,
} from "@playwright/test/reporter";

import {
  FakeExit,
  FakeScheduler,
  FakeTerminal,
} from "../__fixtures__/terminal-fakes";
import {
  addAttempt,
  beginningAttempt,
  captureWrites,
  fakeSuite,
  fakeTest,
  jsonAttachment,
  step,
  type FakeTest,
} from "../__fixtures__/reporter-fakes";
import { STOPPED_ANNOTATION } from "../config/drain";
import { ARTIFACTS_ATTACHMENT } from "../setup/attachments";
import { REPAINT_GAP_MS } from "../terminal/live";
import type { RunDescription } from "./run-description";
import { describeCounts } from "./run-summary";
import { RunTally } from "./results";
import TerminalReporter, {
  siteLabelsOption,
  type TerminalDeps,
} from "./terminal.reporter";
import { currentTerminalSink, printLine } from "./terminal-sink";

/**
 * The terminal reporter driven with fake Playwright events: the header, a line per final attempt and
 * per retry, worker output (printed as it comes, named by its source, cleaned, bounded), errors
 * outside any test, the inert modes, the sink other reporters print through, styling per stream, and
 * a reporter that never throws — a closed pipe included.
 */

const RUN: RunDescription = {
  product: "demo",
  cell: "x",
  edition: "pro",
  pinned: true,
  runId: "run-1",
  reportCell: "x",
  reportDir: "reports/demo/x/run-1",
  reportPath: "/repo/reports/demo/x/run-1",
};

const CONFIG = {} as FullConfig;

/** A fake standard output and what reached it. */
interface FakeStdout {
  readonly stream: TerminalDeps["stdout"];
  /** Everything written, decoded. */
  readonly text: () => string;
  readonly writes: () => number;
  /** The `error` listeners on it now. */
  readonly listeners: () => number;
  /** Emits `error`, as a stream does when a queued write fails. */
  readonly emitError: () => void;
}

/**
 * A standard output that records its writes.
 *
 * @param tty - whether it is a terminal (sized 100×30).
 * @param fail - how its writes fail, if they do.
 */
function fakeStdout(tty = false, fail?: "throw" | "callback"): FakeStdout {
  const chunks: Buffer[] = [];
  const listeners = new Set<(error: Error) => void>();
  const stream = {
    isTTY: tty,
    ...(tty ? { columns: 100, rows: 30 } : {}),
    writableLength: 0,
    write(chunk: Uint8Array, callback: (error?: Error | null) => void) {
      if (fail === "throw") throw new Error("EPIPE");
      chunks.push(Buffer.from(chunk));
      callback(fail === "callback" ? new Error("EIO") : null);
      return true;
    },
    on(_event: "error", listener: (error: Error) => void) {
      listeners.add(listener);
    },
    off(_event: "error", listener: (error: Error) => void) {
      listeners.delete(listener);
    },
  };
  return {
    stream,
    text: () => Buffer.concat(chunks).toString("utf8"),
    writes: () => chunks.length,
    listeners: () => listeners.size,
    emitError: () => {
      for (const listener of listeners) listener(new Error("EPIPE"));
    },
  };
}

/** A reporter under test, its output and its warnings. */
interface Harness {
  readonly reporter: TerminalReporter;
  readonly stdout: FakeStdout;
  readonly warnings: string[];
  /** The printed lines. */
  readonly lines: () => string[];
}

/** The reporters built by a spec, ended after it so no sink stays registered. */
const built: TerminalReporter[] = [];

test.afterEach(async () => {
  for (const reporter of built.splice(0)) await reporter.onExit();
  expect(currentTerminalSink()).toBeUndefined();
});

/**
 * A reporter on a fake stream.
 *
 * @param options - its options; the run's facts by default.
 * @param deps - what to change of a plain pipe's dependencies.
 */
function harness(
  options: unknown = RUN,
  deps: Partial<Omit<TerminalDeps, "stdout">> & {
    readonly tty?: boolean;
    readonly fail?: "throw" | "callback";
  } = {},
): Harness {
  const stdout = fakeStdout(deps.tty, deps.fail);
  const warnings: string[] = [];
  const reporter = new TerminalReporter(options, {
    stdout: stdout.stream,
    env: deps.env ?? {},
    argv: deps.argv ?? ["node", "cli.js", "test"],
    stdoutIntercepted: deps.stdoutIntercepted ?? false,
    warn: deps.warn ?? ((message) => warnings.push(message)),
    cwd: deps.cwd ?? "/repo",
  });
  built.push(reporter);
  return {
    reporter,
    stdout,
    warnings,
    lines: () => stdout.text().split("\n").slice(0, -1),
  };
}

/** A scenario of the cell, with retries. */
function scenario(id: string, title: string, retries = 1): FakeTest {
  return fakeTest({
    id,
    titles: ["demo.feature.spec.js", "Backups", title],
    retries,
  });
}

/**
 * The `--grep` word a rerun prints, written out: each part (regex-escaped by the caller) followed by
 * its tags, from the file to the title, after a space and up to the end — single-quoted.
 */
function grepWord(...parts: string[]): string {
  return `--grep='/ ${parts.map((part) => `${part}(?: @\\S+)*`).join(" ")}$/'`;
}

/** {@link grepWord} for a {@link scenario}. */
function demoGrep(title: string): string {
  return grepWord("demo\\.feature\\.spec\\.js", "Backups", title);
}

/** The auth setup of the cell. */
function authSetup(): FakeTest {
  return fakeTest({
    id: "setup",
    project: "setup:x",
    titles: ["auth.setup.ts", "authenticate site pool"],
  });
}

/** Begins the run with these tests. */
function begin(h: Harness, tests: readonly FakeTest[]): void {
  h.reporter.onBegin(CONFIG, fakeSuite(tests) as unknown as Suite);
}

/** Ends an attempt of `fake` as the runner does. */
function end(
  h: Harness,
  fake: FakeTest,
  attempt: Parameters<typeof addAttempt>[1],
): void {
  h.reporter.onTestEnd(fake.test, addAttempt(fake, attempt));
}

/** A failed attempt whose Gherkin step carries `message`. */
function failing(
  message: string,
  duration = 8_100,
): Parameters<typeof addAttempt>[1] {
  return {
    status: "failed",
    duration,
    errors: [message],
    steps: [step("When it breaks", "test.step", { error: message })],
  };
}

const RESULT = { status: "passed", duration: 1 } as FullResult;

test.describe("TerminalReporter — the run's lines in a pipe", () => {
  test("the cell notice through the sink, the header, then one line per final attempt and per retry", () => {
    const h = harness();
    const passes = scenario("a", "Create a backup");
    const flaky = scenario("b", "Restore a backup");
    const fails = scenario("c", "Delete a backup");
    printLine("[cell] demo/x, pinned by E2E_CELL", "stdout");
    begin(h, [authSetup(), passes, flaky, fails]);

    end(h, passes, { status: "passed", duration: 18_412 });
    end(h, flaky, failing("Error: first try", 2_000));
    end(h, flaky, { status: "passed", duration: 3_000 });
    end(h, fails, failing("Error: boom (attempt 1)"));
    end(h, fails, failing("Error: boom (attempt 2)"));
    h.reporter.onEnd(RESULT);

    expect(h.lines()).toEqual([
      "[cell] demo/x, pinned by E2E_CELL",
      "[run] demo · x (pro) · run-1 · 3 scenarios",
      "✔ passed 18.4s  Backups › Create a backup",
      "↻ retry 2.0s  Backups › Restore a backup · attempt 1/2 · failed",
      "  Error: first try",
      "⚠ flaky 3.0s  Backups › Restore a backup · attempt 2/2",
      "↻ retry 8.1s  Backups › Delete a backup · attempt 1/2 · failed",
      "  Error: boom (attempt 1)",
      "✘ failed 8.1s  Backups › Delete a backup · attempt 2/2",
      "  Step        When it breaks",
      "  Feature     src/projects/demo/features/demo.feature",
      "  Error       Error: boom (attempt 2)",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Delete a backup")}`,
    ]);
    expect(h.warnings).toEqual([]);
  });

  test("a timed-out retry, a drained scenario, a skip, an interrupted attempt, a crash with no error", () => {
    const h = harness();
    const timeout = scenario("t", "Times out");
    const drained = fakeTest({
      id: "d",
      titles: ["f.spec.js", "Backups", "Begins after the stop"],
      annotations: [{ type: STOPPED_ANNOTATION }],
    });
    const skipped = scenario("s", "Is skipped", 0);
    const interrupted = scenario("i", "Is interrupted");
    const crashed = scenario("k", "Crashes", 0);
    begin(h, [timeout, drained, skipped, interrupted, crashed]);

    end(h, timeout, { status: "timedOut", duration: 60_000 });
    end(h, timeout, { status: "passed", duration: 100 });
    end(h, drained, { status: "skipped", duration: 0 });
    end(h, skipped, { status: "skipped", duration: 0 });
    end(h, interrupted, {
      status: "interrupted",
      duration: 1_500,
      errors: ["Error: the run was interrupted"],
    });
    end(h, crashed, { status: "failed", duration: 200 });

    expect(h.lines().slice(1)).toEqual([
      "↻ retry 1.0m  Backups › Times out · attempt 1/2 · timed out",
      "⚠ flaky 0.1s  Backups › Times out · attempt 2/2",
      "■ stopped 0.0s  Backups › Begins after the stop",
      "— skipped 0.0s  Backups › Is skipped",
      "■ interrupted 1.5s  Backups › Is interrupted · attempt 1/2",
      "  Feature     src/projects/demo/features/demo.feature",
      "  Error       Error: the run was interrupted",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Is interrupted")}`,
      "✘ failed 0.2s  Backups › Crashes",
      "  Feature     src/projects/demo/features/demo.feature",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Crashes")}`,
    ]);
  });

  test("a retry the run never reached ends at onEnd; output after its attempt is printed, named", () => {
    const h = harness();
    const pending = scenario("p", "Never retried");
    begin(h, [pending]);
    end(h, pending, failing("Error: no baseline", 300));
    h.reporter.onStdErr("late\n", pending.test);
    h.reporter.onEnd(RESULT);
    expect(h.lines().slice(1)).toEqual([
      "↻ retry 0.3s  Backups › Never retried · attempt 1/2 · failed",
      "  Error: no baseline",
      "▸ Backups › Never retried",
      "  │ late",
      "✘ failed 0.3s  Backups › Never retried · attempt 1/2 · retry not run",
      "  Step        When it breaks",
      "  Feature     src/projects/demo/features/demo.feature",
      "  Error       Error: no baseline",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Never retried")}`,
    ]);
  });

  test("test.fail() that passed says so on its retry and final lines", () => {
    const h = harness();
    const fails = fakeTest({
      id: "u",
      titles: ["f.spec.js", "Backups", "Is expected to fail"],
      retries: 1,
    });
    begin(h, [fails]);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      (fails.test as { expectedStatus: string }).expectedStatus = "failed";
      h.reporter.onTestEnd(
        fails.test,
        addAttempt(fails, {
          status: "passed",
          duration: 100,
          expectedStatus: "failed",
        }),
      );
    }
    expect(h.lines().slice(1)).toEqual([
      "↻ retry 0.1s  Backups › Is expected to fail · attempt 1/2 · passed unexpectedly",
      "✘ failed 0.1s  Backups › Is expected to fail · attempt 2/2 · passed unexpectedly",
      "  Feature     src/projects/demo/features/demo.feature",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${grepWord("f\\.spec\\.js", "Backups", "Is expected to fail")}`,
    ]);
  });

  test("an attempt a failed beforeAll kept from running says so on its retry line", () => {
    const h = harness();
    const kept = scenario("k", "Never ran", 1);
    begin(h, [kept]);
    end(h, kept, { status: "skipped", duration: 0, expectedStatus: "passed" });
    end(h, kept, { status: "passed", duration: 100 });
    expect(h.lines().slice(1)).toEqual([
      "↻ retry 0.0s  Backups › Never ran · attempt 1/2 · not run: its group failed",
      "✔ passed 0.1s  Backups › Never ran · attempt 2/2",
    ]);
  });

  test("errors outside any test: the error and its lines; No tests found as a warning", () => {
    const h = harness();
    begin(h, []);
    h.reporter.onError({
      message:
        'Error: a spec file does not load\n    at x.js:1:1\n\nCall log:\n  - <input value="pw"/>',
    });
    h.reporter.onError({ message: "Error: No tests found" });
    h.reporter.onError({ value: "thrown 42" });
    h.reporter.onError({});
    expect(h.lines()).toEqual([
      "[run] demo · x (pro) · run-1 · 0 scenarios",
      "✘ error Error: a spec file does not load",
      "      at x.js:1:1",
      "⚠ warning No tests found",
      "✘ error thrown 42",
      "✘ error an error with no message",
    ]);
  });

  test("a run of every cell, with a requested ref", () => {
    const { cell: _cell, edition: _edition, ...rest } = RUN;
    const h = harness({ ...rest, requestedRef: "develop" });
    begin(h, [scenario("a", "One")]);
    expect(h.lines()).toEqual([
      "[run] demo · every cell · run-1 · ref develop · 1 scenario",
    ]);
  });
});

test.describe("TerminalReporter — failure blocks", () => {
  const COMMIT = "af1ab5c4d2e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3";

  /** The artifacts setup of a cell (`x` by default). */
  function artifactsSetup(project = "artifacts:x"): FakeTest {
    return fakeTest({
      id: `artifacts-${project}`,
      project,
      titles: ["artifacts.setup.ts", "resolve and verify"],
    });
  }

  /** Ends the artifacts setup, passing, with its record of the plugin. */
  function resolved(
    h: Harness,
    setup: FakeTest,
    artifact: Record<string, unknown>,
  ): void {
    end(h, setup, {
      status: "passed",
      attachments: [
        jsonAttachment(ARTIFACTS_ATTACHMENT, {
          ok: true,
          roles: [{ role: "plugin", ok: true, checks: [], info: {}, artifact }],
        }),
      ],
    });
  }

  test("a scenario's final failure: its step, feature, error, screenshots, trace, and a rerun of the commit tested", () => {
    const h = harness();
    const artifacts = artifactsSetup();
    const fails = scenario("c", "Delete a backup", 0);
    begin(h, [artifacts, fails]);
    resolved(h, artifacts, {
      ref: "develop",
      commit: COMMIT,
      source: "default-ref",
    });
    end(h, fails, {
      ...failing("Error: boom"),
      attachments: [
        {
          name: "screenshot",
          path: "/repo/test-results/demo/x/c/test-failed-1.png",
          contentType: "image/png",
        },
        {
          name: "trace",
          path: "/repo/test-results/demo/x/c/trace.zip",
          contentType: "application/zip",
        },
        {
          name: "video",
          path: "/repo/test-results/demo/x/c/video.webm",
          contentType: "video/webm",
        },
      ],
    });
    expect(h.lines().slice(2)).toEqual([
      "✘ failed 8.1s  Backups › Delete a backup",
      "  Step        When it breaks",
      "  Feature     src/projects/demo/features/demo.feature",
      "  Error       Error: boom",
      "  Screenshot  test-results/demo/x/c/test-failed-1.png",
      "  Trace       test-results/demo/x/c/trace.zip",
      `  Rerun       E2E_CELL=x E2E_PLUGIN_REF=commit:${COMMIT} npm run test:demo -- ${demoGrep("Delete a backup")}`,
    ]);
  });

  test("the operator's zip, when the artifacts setup used it", () => {
    const h = harness({ ...RUN, pluginZip: "/my zips/demo.zip" });
    const artifacts = artifactsSetup();
    const fails = scenario("c", "Delete", 0);
    begin(h, [artifacts, fails]);
    resolved(h, artifacts, { zipFilename: "demo.zip", source: "env-zip" });
    end(h, fails, failing("Error: boom"));
    expect(h.lines().at(-1)).toBe(
      `  Rerun       E2E_CELL=x E2E_PLUGIN_ZIP='/my zips/demo.zip' npm run test:demo -- ${demoGrep("Delete")}`,
    );
  });

  test("no record of the build: the operator's ref and version", () => {
    const h = harness({
      ...RUN,
      pluginRef: "feature/x",
      pluginVersion: "9.99.99",
    });
    const fails = scenario("c", "Delete", 0);
    begin(h, [fails]);
    end(h, fails, failing("Error: boom"));
    expect(h.lines().at(-1)).toBe(
      `  Rerun       E2E_CELL=x E2E_PLUGIN_REF=feature/x E2E_PLUGIN_VERSION=9.99.99 npm run test:demo -- ${demoGrep("Delete")}`,
    );
  });

  test("a release download reruns its tag, never the selector the operator gave", () => {
    const h = harness({ ...RUN, pluginRef: "release:latest-stable" });
    const artifacts = artifactsSetup();
    const fails = scenario("c", "Delete", 0);
    begin(h, [artifacts, fails]);
    end(h, artifacts, {
      status: "passed",
      attachments: [
        jsonAttachment(ARTIFACTS_ATTACHMENT, {
          ok: true,
          roles: [
            {
              role: "plugin",
              ok: true,
              checks: [],
              info: { pin: "release:3.17.4" },
              artifact: {
                ref: "release:latest-stable",
                commit: "release-3.17.4",
                version: "3.17.4",
                source: "env-ref",
              },
            },
          ],
        }),
      ],
    });
    end(h, fails, failing("Error: boom"));
    expect(h.lines().at(-1)).toBe(
      `  Rerun       E2E_CELL=x E2E_PLUGIN_REF=release:3.17.4 npm run test:demo -- ${demoGrep("Delete")}`,
    );
  });

  test("a run of every cell names the test's cell, and drops what the operator set: that run ignored it", () => {
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    const h = harness({
      ...everyCell,
      reportCell: "_all",
      pluginRef: "feature/x",
      pluginZip: "/z.zip",
      pluginVersion: "1.0",
    });
    const fails = scenario("c", "Delete", 0);
    begin(h, [fails]);
    end(h, fails, failing("Error: boom"));
    expect(h.lines().at(-1)).toBe(
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Delete")}`,
    );
  });

  test("each cell's own cell and build in a run of every cell", () => {
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    const h = harness({ ...everyCell, reportCell: "_all" });
    const artifactsY = artifactsSetup("artifacts:y");
    const inY = fakeTest({
      id: "y1",
      project: "y",
      titles: ["f.feature.spec.js", "F", "In y"],
    });
    const inX = fakeTest({
      id: "x1",
      project: "x",
      titles: ["f.feature.spec.js", "F", "In x"],
    });
    begin(h, [artifactsY, inY, inX]);
    resolved(h, artifactsY, { commit: COMMIT, source: "default-ref" });
    end(h, inY, failing("Error: y"));
    end(h, inX, failing("Error: x"));
    const reruns = h.lines().filter((line) => line.startsWith("  Rerun"));
    expect(reruns).toEqual([
      `  Rerun       E2E_CELL=y E2E_PLUGIN_REF=commit:${COMMIT} npm run test:demo -- ${grepWord("f\\.feature\\.spec\\.js", "F", "In y")}`,
      `  Rerun       E2E_CELL=x npm run test:demo -- ${grepWord("f\\.feature\\.spec\\.js", "F", "In x")}`,
    ]);
  });

  test("a failed setup gets its own block: what it holds up, its step, its error, a rerun of its project", () => {
    const h = harness();
    const artifacts = artifactsSetup();
    const auth = authSetup();
    begin(h, [artifacts, auth, scenario("a", "Never runs")]);
    resolved(h, artifacts, { commit: COMMIT, source: "default-ref" });
    end(h, auth, {
      status: "failed",
      duration: 3_000,
      errors: ["Error: [preflight] transport unreachable\n  details"],
      steps: [
        step("preflight", "test.step", {
          error: "Error: [preflight] transport unreachable",
        }),
      ],
    });
    expect(h.lines().slice(2)).toEqual([
      "✘ failed 3.0s  auth.setup.ts › authenticate site pool",
      "  Setup       setup:x — no scenario of its cell runs without it",
      "  Step        preflight",
      "  Error       Error: [preflight] transport unreachable",
      `  Rerun       E2E_CELL=x E2E_PLUGIN_REF=commit:${COMMIT} npm run test:demo -- --project=setup:x`,
    ]);
  });

  test("a failed artifacts setup: the operator's ref, since it built nothing", () => {
    const h = harness({ ...RUN, pluginRef: "develop" });
    const artifacts = artifactsSetup();
    begin(h, [artifacts]);
    end(h, artifacts, {
      status: "failed",
      errors: ["Error: [artifacts] build failed"],
      attachments: [
        jsonAttachment(ARTIFACTS_ATTACHMENT, {
          ok: false,
          roles: [
            {
              role: "plugin",
              ok: false,
              checks: [{ name: "resolved", ok: false, detail: "no" }],
            },
          ],
        }),
      ],
    });
    expect(h.lines().at(-1)).toBe(
      "  Rerun       E2E_CELL=x E2E_PLUGIN_REF=develop npm run test:demo -- --project=artifacts:x",
    );
  });

  test("a final timeout says so; its block names the step that was running", () => {
    const h = harness();
    const slow = scenario("t", "Times out", 0);
    begin(h, [slow]);
    end(h, slow, {
      status: "timedOut",
      duration: 30_000,
      errors: ["Test timeout of 30000ms exceeded."],
      steps: [
        step("Before Hooks", "hook"),
        step("When the job runs", "test.step", {
          steps: [step('Fill "x"', "pw:api")],
        }),
        step("After Hooks", "hook"),
      ],
    });
    expect(h.lines().slice(1, 3)).toEqual([
      "✘ failed 30.0s  Backups › Times out · timed out",
      "  Step        When the job runs · running when the attempt ended",
    ]);
    expect(h.lines()).toContain(
      "  Error       Test timeout of 30000ms exceeded.",
    );
  });

  test("a value typed into a field never reaches the block: no API step title, no params", () => {
    const h = harness();
    const fails = scenario("s", "Log in", 0);
    begin(h, [fails]);
    end(h, fails, {
      status: "failed",
      errors: ["Error: expect(locator).toHaveText(expected) failed"],
      steps: [
        step("When I log in", "test.step", {
          error: "Error: expect(locator).toHaveText(expected) failed",
          steps: [
            step('Fill "canary-1f2e3d"', "pw:api"),
            step('Expect "toHaveText"', "expect", {
              error: "Error: expect(locator).toHaveText(expected) failed",
            }),
          ],
        }),
      ],
    });
    expect(h.stdout.text()).not.toContain("canary");
    expect(h.lines()).toContain("  Step        When I log in");
  });

  test("a flaky scenario and a passing one print no block; a retry keeps its one error line", () => {
    const h = harness();
    const flaky = scenario("f", "Flaky");
    begin(h, [flaky]);
    end(h, flaky, failing("Error: once"));
    end(h, flaky, { status: "passed" });
    expect(h.lines().slice(1)).toEqual([
      "↻ retry 8.1s  Backups › Flaky · attempt 1/2 · failed",
      "  Error: once",
      "⚠ flaky 0.1s  Backups › Flaky · attempt 2/2",
    ]);
  });

  test("one title in two features: each command selects its own; a duplicate in one feature prints the same", () => {
    const h = harness();
    const one = fakeTest({
      id: "1",
      titles: ["a.feature.spec.js", "A", "Same"],
    });
    const two = fakeTest({
      id: "2",
      titles: ["b.feature.spec.js", "B", "Same"],
    });
    const twin = fakeTest({
      id: "3",
      titles: ["b.feature.spec.js", "B", "Same"],
    });
    begin(h, [one, two, twin]);
    end(h, one, failing("Error: 1"));
    end(h, two, failing("Error: 2"));
    end(h, twin, failing("Error: 3"));
    const reruns = h.lines().filter((line) => line.startsWith("  Rerun"));
    const inB = `  Rerun       E2E_CELL=x npm run test:demo -- ${grepWord("b\\.feature\\.spec\\.js", "B", "Same")}`;
    expect(reruns).toEqual([
      `  Rerun       E2E_CELL=x npm run test:demo -- ${grepWord("a\\.feature\\.spec\\.js", "A", "Same")}`,
      inB,
      inB,
    ]);
  });

  test("a title with control characters: the head line plain, the command escaped, no control printed", () => {
    const h = harness();
    const nasty = scenario(
      "n",
      "Red \u001b[31malert\u001b[0m\u202e and 'quote' $x",
      0,
    );
    begin(h, [nasty]);
    end(h, nasty, failing("Error: boom"));
    for (const line of h.lines()) {
      expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
    expect(h.lines()[1]).toBe(
      "✘ failed 8.1s  Backups › Red alert and 'quote' $x",
    );
    expect(h.lines().at(-1)).toBe(
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Red \\u001b\\[31malert\\u001b\\[0m\\u202e and '\\''quote'\\'' \\$x")}`,
    );
  });

  test("a narrow terminal (20 columns) changes nothing: permanent lines are never cut to it", () => {
    const wide = harness();
    const narrow = harness(RUN, { env: { COLUMNS: "20" } });
    for (const h of [wide, narrow]) {
      const fails = scenario(
        "c",
        "A scenario with a long title that runs past twenty",
        0,
      );
      begin(h, [fails]);
      end(h, fails, failing("Error: boom"));
    }
    expect(narrow.lines().slice(1)).toEqual(wide.lines().slice(1));
  });

  test("options missing a field: the failure prints its error line, no block", () => {
    const h = harness({});
    const fails = scenario("c", "Delete", 0);
    begin(h, [fails]);
    end(h, fails, failing("Error: boom"));
    expect(h.lines()).toEqual([
      "✘ failed 8.1s  Backups › Delete",
      "  Error: boom",
    ]);
  });
});

test.describe("TerminalReporter — worker output", () => {
  test("prints each line as it comes, plain and masked, under a begin line naming its source", () => {
    const h = harness();
    const a = scenario("a", "Create a backup", 0);
    const b = scenario("b", "Restore a backup", 0);
    begin(h, [a, b]);
    // Workers run with FORCE_COLOR=1: their output carries escapes.
    h.reporter.onStdOut(
      "\u001b[33m[site]\u001b[39m via https://u:hunter2@site.test/\n",
      a.test,
      beginningAttempt(a),
    );
    expect(h.lines().slice(1)).toEqual([
      "▸ Backups › Create a backup",
      "  │ [site] via https://***@site.test/",
    ]);
    // Another worker's line: named before it; then back to the first, named again.
    h.reporter.onStdOut(Buffer.from("[b] parallel\n"), b.test);
    h.reporter.onStdErr("a partial line with no end", a.test);
    h.reporter.onStdErr(" — and its end\n", a.test);
    h.reporter.onStdErr("a's second\n", a.test);
    end(h, a, { status: "passed", duration: 1_000 });
    end(h, b, { status: "passed", duration: 1_000 });
    expect(h.lines().slice(1)).toEqual([
      "▸ Backups › Create a backup",
      "  │ [site] via https://***@site.test/",
      "▸ Backups › Restore a backup",
      "  │ [b] parallel",
      "▸ Backups › Create a backup",
      "  │ a partial line with no end — and its end",
      "  │ a's second",
      "✔ passed 1.0s  Backups › Create a backup",
      "✔ passed 1.0s  Backups › Restore a backup",
    ]);
    expect(h.stdout.text()).not.toContain("\u001b");
    expect(h.stdout.text()).not.toContain("hunter2");
  });

  test("an attempt's open line prints at its end, before its line; any other line names the source again", () => {
    const h = harness();
    const setup = authSetup();
    begin(h, [setup]);
    h.reporter.onStdOut("[auth] logging ", setup.test);
    expect(h.lines()).toHaveLength(1);
    h.reporter.onStdOut("in\n[site] WordPress 7.1\n", setup.test);
    printLine("[results] a warning in between", "stderr");
    h.reporter.onStdOut("[auth] done\n[auth] tail", setup.test);
    end(h, setup, { status: "passed", duration: 4_000 });
    expect(h.lines().slice(1)).toEqual([
      "▸ auth.setup.ts › authenticate site pool",
      "  │ [auth] logging in",
      "  │ [site] WordPress 7.1",
      "[results] a warning in between",
      "▸ auth.setup.ts › authenticate site pool",
      "  │ [auth] done",
      "  │ [auth] tail",
      "✔ passed 4.0s  auth.setup.ts › authenticate site pool",
    ]);
  });

  test("stdout and stderr are cut apart: an open line on one never joins the other's", () => {
    const h = harness();
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    h.reporter.onStdErr("[probe] a warning with no line end", a.test);
    h.reporter.onStdOut("[out] whole\n", a.test);
    end(h, a, { status: "passed", duration: 1 });
    expect(h.lines().slice(1)).toEqual([
      "▸ Backups › Create",
      "  │ [out] whole",
      "  │ [probe] a warning with no line end",
      "✔ passed 0.0s  Backups › Create",
    ]);
  });

  test("a retry's output is named with its attempt", () => {
    const h = harness();
    const setup = fakeTest({
      id: "art",
      project: "artifacts:x",
      titles: ["artifacts.setup.ts", "resolve"],
      retries: 1,
    });
    begin(h, [setup]);
    h.reporter.onStdOut(
      "[artifacts] one\n",
      setup.test,
      beginningAttempt(setup),
    );
    end(h, setup, failing("Error: build failed", 1_000));
    h.reporter.onStdOut(
      "[artifacts] two\nno line end",
      setup.test,
      beginningAttempt(setup),
    );
    // Named as it prints, before the attempt ends.
    expect(h.lines().at(-2)).toBe(
      "▸ artifacts.setup.ts › resolve · attempt 2/2",
    );
    end(h, setup, { status: "passed", duration: 1_000 });
    expect(h.lines().slice(1)).toEqual([
      "▸ artifacts.setup.ts › resolve",
      "  │ [artifacts] one",
      "↻ retry 1.0s  artifacts.setup.ts › resolve · attempt 1/2 · failed",
      "  Error: build failed",
      "▸ artifacts.setup.ts › resolve · attempt 2/2",
      "  │ [artifacts] two",
      "  │ no line end",
      "⚠ flaky 1.0s  artifacts.setup.ts › resolve · attempt 2/2",
    ]);
  });

  test("output outside any test prints at once, each chunk its own line, named as such", () => {
    const h = harness();
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    h.reporter.onStdErr("\u001b[31mworker warning\u001b[39m\nhalf");
    h.reporter.onStdOut("[a] mine\n", a.test);
    h.reporter.onStdErr("another worker's\n");
    expect(h.lines().slice(1)).toEqual([
      "▸ outside any test",
      "  │ worker warning",
      "  │ half",
      "▸ Backups › Create",
      "  │ [a] mine",
      "▸ outside any test",
      "  │ another worker's",
    ]);
  });

  test("a test's flood is bounded: 200 lines per attempt, then how many were not shown, at its end", () => {
    const h = harness();
    const a = scenario("a", "Floods", 1);
    begin(h, [a]);
    const flood = `${Array.from({ length: 250 }, (_, i) => `l${String(i)}`).join("\n")}\n`;
    h.reporter.onStdOut(flood, a.test);
    expect(h.lines()).toHaveLength(1 + 1 + 200);
    end(h, a, { status: "failed", duration: 1 });
    const lines = h.lines();
    expect(lines.slice(-3)).toEqual([
      "  │ l199",
      "  │ … 50 more lines of output not shown: the HTML report keeps them",
      "↻ retry 0.0s  Backups › Floods · attempt 1/2 · failed",
    ]);
    // The next attempt starts a new count.
    h.reporter.onStdOut("again\n", a.test, beginningAttempt(a));
    expect(h.lines().at(-1)).toBe("  │ again");
  });

  test("output outside any test: 200 lines until a test ends, an honest count, then a new stretch", () => {
    const h = harness();
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    for (let i = 0; i < 230; i += 1) h.reporter.onStdOut(`o${String(i)}\n`);
    expect(h.lines()).toHaveLength(1 + 1 + 200);
    end(h, a, { status: "passed", duration: 1 });
    expect(h.lines().slice(-2)).toEqual([
      "  │ … 30 more lines of output not shown",
      "✔ passed 0.0s  Backups › Create",
    ]);
    h.reporter.onStdOut("after\n");
    expect(h.lines().slice(-2)).toEqual(["▸ outside any test", "  │ after"]);
    // A new stretch, 200 lines again: one more is told as the run ends.
    for (let i = 0; i < 200; i += 1) h.reporter.onStdOut(`p${String(i)}\n`);
    h.reporter.onEnd(RESULT);
    expect(h.lines().slice(-2)).toEqual([
      "  │ p198",
      "  │ … 1 more line of output not shown",
    ]);
    expect(h.stdout.text()).not.toContain("HTML report");
  });

  test("a line too long is capped at 500 code points; one past the memory bound says it was cut", () => {
    const h = harness();
    begin(h, []);
    h.reporter.onStdOut(`${"x".repeat(10_000)}\n`);
    const [, , line = ""] = h.lines();
    expect(Array.from(line.slice("  │ ".length))).toHaveLength(500);
    expect(line.endsWith("…")).toBe(true);
    // 100,000 units with no space: past the 64 KiB bound, the word the cut fell in goes whole.
    h.reporter.onStdOut(`${"y".repeat(100_000)}\n`);
    expect(h.lines().at(-1)).toBe("  │ [cut: the line was too long]");
  });

  test("a credential is masked before any cut: escape-inflated lines show no fragment of it", () => {
    const h = harness();
    begin(h, []);
    // Hundreds of escapes before the credential: a raw cut near 4 KiB once fell inside it.
    const bar = "\u001b[90m.\u001b[39m".repeat(369);
    h.reporter.onStdOut(
      `${bar}xxxx GET https://admin:S3cretPassw0rd@site.example/wp-admin/\n`,
    );
    h.reporter.onStdOut(
      `${"\u001b[0m".repeat(1020)}token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\n`,
    );
    const text = h.stdout.text();
    expect(text).toContain("https://***@site.example/wp-admin/");
    expect(text).toContain("  │ token ***");
    for (const fragment of ["S3cret", "admin:", "ghp_", "ABCDEF"]) {
      expect(text).not.toContain(fragment);
    }
  });

  test("--quiet (config.quiet) drops worker output, as list did; the test lines stay", () => {
    const h = harness();
    const a = scenario("a", "Create", 0);
    h.reporter.onBegin(
      { quiet: true } as FullConfig,
      fakeSuite([a]) as unknown as Suite,
    );
    h.reporter.onStdOut("[a] noise\n", a.test);
    h.reporter.onStdErr("outside\n");
    end(h, a, { status: "passed", duration: 1 });
    expect(h.lines().slice(1)).toEqual(["✔ passed 0.0s  Backups › Create"]);
  });

  test("a global timeout ends the run first: onEnd leaves a running test's open line to its late end", () => {
    const h = harness();
    const a = scenario("a", "Runs long", 0);
    begin(h, [a]);
    h.reporter.onStdOut("start\npartial", a.test);
    h.reporter.onError({
      message: "Timed out waiting 1s for the test suite to run",
    });
    h.reporter.onEnd(RESULT);
    end(h, a, { status: "interrupted", duration: 800 });
    expect(h.lines().slice(1)).toEqual([
      "▸ Backups › Runs long",
      "  │ start",
      "✘ error Timed out waiting 1s for the test suite to run",
      "▸ Backups › Runs long",
      "  │ partial",
      "■ interrupted 0.8s  Backups › Runs long",
      "  Feature     src/projects/demo/features/demo.feature",
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Runs long")}`,
    ]);
  });

  test("a test that never ends has its open line printed as the reporter exits", async () => {
    const h = harness();
    const a = scenario("a", "Never ends", 0);
    begin(h, [a]);
    h.reporter.onStdOut("last words", a.test);
    h.reporter.onEnd(RESULT);
    expect(h.lines()).toHaveLength(1);
    await h.reporter.onExit();
    expect(h.lines().slice(1)).toEqual([
      "▸ Backups › Never ends",
      "  │ last words",
    ]);
  });
});

test.describe("TerminalReporter — styling per stream", () => {
  test("a coloured terminal: the header a rule, marks alone, escapes only where styled", () => {
    const h = harness(RUN, { tty: true, env: { TERM: "xterm-256color" } });
    const a = scenario("a", "Create a backup", 0);
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1_000 });
    const [header = "", line = ""] = h.lines();
    const bare = (text: string): string => stripVTControlCharacters(text);
    expect(bare(header)).toMatch(
      /^━━ demo · x \(pro\) · run-1 · 1 scenario ━+$/,
    );
    expect(Array.from(bare(header))).toHaveLength(100);
    expect(bare(line)).toBe("✔ 1.0s  Backups › Create a backup");
    expect(line).toContain("\u001b[32m✔\u001b[39m");
  });

  test("NO_COLOR on a terminal: the rule stays, no escape, every word", () => {
    const h = harness(RUN, {
      tty: true,
      env: { TERM: "xterm", NO_COLOR: "1" },
    });
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1_000 });
    expect(h.stdout.text()).not.toContain("\u001b");
    expect(h.lines()[0]).toMatch(/^━━ demo/);
    expect(h.lines()[1]).toBe("✔ passed 1.0s  Backups › Create");
  });

  test("E2E_OUTPUT=plain on a terminal: ASCII, the [run] line, no escape — whatever FORCE_COLOR says", () => {
    const h = harness(
      { ...RUN, output: "plain" },
      { tty: true, env: { TERM: "xterm", FORCE_COLOR: "1" } },
    );
    const a = scenario("a", "Create", 0);
    printLine("[cell] x › y", "stdout");
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1_000 });
    expect(h.lines()).toEqual([
      "[cell] x › y",
      "[run] demo . x (pro) . run-1 . 1 scenario",
      "OK passed 1.0s  Backups > Create",
    ]);
  });

  test("FORCE_COLOR into a pipe: escapes, and every word, since nobody may see the colour", () => {
    const h = harness(RUN, { env: { FORCE_COLOR: "1" } });
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1_000 });
    expect(h.lines()[1]).toBe(
      "\u001b[32m✔\u001b[39m passed \u001b[2m1.0s\u001b[22m  Backups › Create",
    );
    expect(h.lines()[0]).toMatch(/^\[run\] /);
  });
});

test.describe("TerminalReporter — the run's one writer", () => {
  test("lines other reporters hand it are made plain and masked, never cut: paths stay whole", () => {
    const h = harness();
    printLine(
      "[results] could not write\u001b[2J https://a:b@c.test/\n  second",
      "stderr",
    );
    const path = `/reports/${"deep/".repeat(200)}run-1`;
    printLine(`[cell] demo/x; report in ${path}`, "stdout");
    expect(h.lines()).toEqual([
      "[results] could not write https://***@c.test/",
      "  second",
      `[cell] demo/x; report in ${path}`,
    ]);
  });

  test("onExit hands the terminal back: later lines go to the stream they name", async () => {
    const h = harness();
    await h.reporter.onExit();
    const writes = captureWrites(process.stdout, () => {
      printLine("after", "stdout");
    });
    expect(writes).toEqual(["after\n"]);
    expect(h.stdout.writes()).toBe(0);
  });
});

test.describe("TerminalReporter — inert where another owns the screen", () => {
  /** What an inert reporter must do: nothing on its stream, no sink, its runs still tallied off. */
  function expectInert(h: Harness): void {
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    h.reporter.onStdOut("worker line\n", a.test);
    h.reporter.onStdOut("outside\n");
    end(h, a, { status: "failed", duration: 1 });
    h.reporter.onError({ message: "Error: x" });
    h.reporter.onEnd(RESULT);
    expect(h.stdout.writes()).toBe(0);
    expect(currentTerminalSink()).toBeUndefined();
    // The others print as they would alone.
    expect(
      captureWrites(process.stdout, () => {
        printLine("[cell] alone", "stdout");
      }),
    ).toEqual(["[cell] alone\n"]);
  }

  test("--list: quiet, and printsToStdio false so Playwright's listing prints", () => {
    const h = harness({ ...RUN, _mode: "list" });
    expect(h.reporter.printsToStdio()).toBe(false);
    expectInert(h);
  });

  test("--ui, intercepted stdio and PW_TEST_REPORTER: quiet, and printsToStdio false so Playwright adds its own", () => {
    for (const deps of [
      { argv: ["node", "cli.js", "test", "--ui"] },
      { stdoutIntercepted: true },
      { env: { PW_TEST_REPORTER: "dot" } },
      { env: { PW_TEST_REPORTER: "junit", PWTEST_WATCH: "1" } },
    ]) {
      const h = harness(RUN, deps);
      expect(h.reporter.printsToStdio(), JSON.stringify(deps)).toBe(false);
      expectInert(h);
      expect(h.stdout.listeners()).toBe(0);
    }
  });

  test("a plain run and watch mode (stdio not intercepted) print, and say so", () => {
    for (const env of [{}, { PWTEST_WATCH: "1" }]) {
      const h = harness(RUN, { env });
      expect(h.reporter.printsToStdio()).toBe(true);
      const a = scenario("a", "Create", 0);
      begin(h, [a]);
      end(h, a, { status: "passed", duration: 1 });
      expect(h.lines()).toHaveLength(2);
    }
  });
});

test.describe("TerminalReporter — never fails a run", () => {
  test("a write that throws stops the output for good, without throwing", () => {
    const h = harness(RUN, { fail: "throw" });
    const a = scenario("a", "Create", 0);
    expect(() => {
      begin(h, [a]);
      end(h, a, { status: "passed", duration: 1 });
      printLine("forwarded", "stdout");
      h.reporter.onEnd(RESULT);
    }).not.toThrow();
    expect(h.stdout.writes()).toBe(0);
  });

  test("a write that fails later (EIO) stops every later write", () => {
    const h = harness(RUN, { fail: "callback" });
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1 });
    expect(h.stdout.writes()).toBe(1);
  });

  test("an error event (a closed pipe) is heard while it owns stdout: no crash, nothing more written", async () => {
    const h = harness();
    const a = scenario("a", "Create", 0);
    expect(h.stdout.listeners()).toBe(1);
    begin(h, [a]);
    h.stdout.emitError();
    end(h, a, { status: "passed", duration: 1 });
    expect(h.stdout.writes()).toBe(1);
    // The stream failed: the listener stays, so the summary's writes after it fail silently too.
    await h.reporter.onExit();
    expect(h.stdout.listeners()).toBe(1);
  });

  test("a healthy stream's listener is removed as the reporter hands the terminal back", async () => {
    const h = harness();
    expect(h.stdout.listeners()).toBe(1);
    await h.reporter.onExit();
    expect(h.stdout.listeners()).toBe(0);
  });

  test("a stream that refuses the listener still prints", () => {
    const stdout = fakeStdout();
    const refusing = {
      ...stdout.stream,
      on: () => {
        throw new Error("no events");
      },
    };
    const reporter = new TerminalReporter(RUN, {
      stdout: refusing,
      env: {},
      argv: [],
      stdoutIntercepted: false,
      warn: () => undefined,
    });
    built.push(reporter);
    reporter.onError({ message: "Error: x" });
    expect(stdout.text()).toBe("✘ error Error: x\n");
  });

  test("options missing a field: warned once, the lines still printed; a later throw is still told", () => {
    const h = harness({ product: "demo" });
    const a = scenario("a", "Create", 0);
    begin(h, [a]);
    end(h, a, { status: "passed", duration: 1 });
    h.reporter.onError({ message: "Error: x" });
    const broken = {
      id: "z",
      titlePath: () => {
        throw new Error("no title");
      },
    } as unknown as TestCase;
    h.reporter.onTestEnd(broken, addAttempt(fakeTest(), { status: "passed" }));
    expect(h.warnings).toEqual([
      '[terminal] the reporter\'s options lack "reportDir". The run goes on; its reports have every result.',
      expect.stringMatching(/^\[terminal\] .*\. The run goes on;/),
    ]);
    expect(h.lines()).toEqual([
      "✔ passed 0.0s  Backups › Create",
      "✘ error Error: x",
    ]);
  });

  test("a callback that throws is caught and warned once; a warner that throws too is swallowed", () => {
    const broken = {
      id: "z",
      titlePath: () => {
        throw new Error("no title");
      },
    } as unknown as TestCase;
    const h = harness();
    begin(h, []);
    expect(() => {
      h.reporter.onStdOut("x\n", broken);
      h.reporter.onTestEnd(
        broken,
        addAttempt(fakeTest(), { status: "passed" }),
      );
    }).not.toThrow();
    expect(h.warnings).toHaveLength(1);
    expect(h.warnings[0]).toMatch(/^\[terminal\] /);

    const silent = harness(RUN, {
      warn: () => {
        throw new Error("stderr closed");
      },
    });
    expect(() => {
      silent.reporter.onTestEnd(
        broken,
        addAttempt(fakeTest(), { status: "passed" }),
      );
    }).not.toThrow();
  });
});

/** A reporter on a fake terminal that can hold a live block, its streams and its clock. */
interface LiveHarness {
  readonly reporter: TerminalReporter;
  readonly stdout: FakeTerminal;
  readonly stderr: FakeTerminal;
  readonly exit: FakeExit;
  readonly scheduler: FakeScheduler;
  readonly warnings: string[];
}

/**
 * A reporter on a fake 80×24 terminal (`TERM=xterm-256color`), two sites by worker.
 *
 * @param env - the environment; a terminal that moves the cursor by default.
 * @param options - the reporter's options.
 * @param size - the terminal's columns and rows.
 */
function liveHarness(
  env: Record<string, string> = { TERM: "xterm-256color" },
  options: unknown = { ...RUN, sites: ["bwu4.example", "bwu5.example"] },
  size: { columns?: number; rows?: number; tty?: boolean } = {},
): LiveHarness {
  const stdout = new FakeTerminal(size.tty ?? true);
  stdout.columns = size.columns ?? 80;
  stdout.rows = size.rows ?? 24;
  const stderr = new FakeTerminal(true);
  const exit = new FakeExit();
  const scheduler = new FakeScheduler();
  const warnings: string[] = [];
  const reporter = new TerminalReporter(options, {
    stdout: stdout as unknown as TerminalDeps["stdout"],
    env,
    argv: ["node", "cli.js", "test"],
    stdoutIntercepted: false,
    warn: (message) => warnings.push(message),
    stderr: stderr as unknown as NonNullable<TerminalDeps["stderr"]>,
    exit,
    signals: exit,
    scheduler,
  });
  built.push(reporter);
  return { reporter, stdout, stderr, exit, scheduler, warnings };
}

/** Begins an attempt of `fake` on worker `slot`, as the runner does. */
function beginOn(h: LiveHarness, fake: FakeTest, slot = 0): void {
  h.reporter.onTestBegin(fake.test, beginningAttempt(fake, slot));
}

/** Ends an attempt of `fake` on worker `slot`. */
function endOn(
  h: LiveHarness,
  fake: FakeTest,
  attempt: Parameters<typeof addAttempt>[1],
): void {
  h.reporter.onTestEnd(fake.test, addAttempt(fake, attempt));
}

/** The progress rows drawn so far, newest last. */
function progressRows(h: LiveHarness): string[] {
  return [
    ...stripVTControlCharacters(h.stdout.all).matchAll(
      /\d+\/\d+ · \d+% · [^\r\n]*/g,
    ),
  ].map(([row]) => row);
}

/** The rows of the last draw: what follows the last row cleared, cut at the cursor contract's `\r\n`. */
function lastFrame(h: LiveHarness): string[] {
  const draw = h.stdout.all.split("\r\x1b[2K").at(-1) ?? "";
  return stripVTControlCharacters(draw).replace(/\r$/, "").split("\r\n");
}

/** Whether the reporter holds standard output's `write`: a capture is in force. */
function captured(stream: FakeTerminal): boolean {
  return Object.hasOwn(stream, "write");
}

test.describe("TerminalReporter — the live block", () => {
  test("setup lines print plain before it; the first scenario's begin starts it and the capture", () => {
    const h = liveHarness();
    const setup = authSetup();
    const a = scenario("a", "Create a backup", 0);
    begin(h as unknown as Harness, [setup, a]);
    beginOn(h, setup);
    endOn(h, setup, { status: "passed", duration: 2_000 });
    expect(h.stdout.all).not.toContain("\r");
    expect(captured(h.stdout)).toBe(false);
    expect(progressRows(h)).toEqual([]);
    beginOn(h, a);
    expect(captured(h.stdout)).toBe(true);
    expect(captured(h.stderr)).toBe(true);
    expect(stripVTControlCharacters(h.stdout.all)).toContain(
      "0/1 · 0% · 0 passed · 1 running · 0s\r\n  ▸ Backups › Create a backup · bwu4.example · 0s\r",
    );
  });

  test("one row per busy worker, named by its site; an attempt's end removes its row", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    const b = scenario("b", "Restore", 0);
    begin(h as unknown as Harness, [a, b]);
    h.scheduler.advance(65_000);
    beginOn(h, b, 1);
    h.scheduler.advance(1_000);
    beginOn(h, a, 0);
    h.scheduler.advance(500);
    expect(lastFrame(h)).toEqual([
      "░░░░░░░░░░ 0/2 · 0% · 0 passed · 2 running · 1m 06s",
      "  ▸ Backups › Create · bwu4.example · 0s",
      "  ▸ Backups › Restore · bwu5.example · 1s",
    ]);
    endOn(h, a, { status: "passed", duration: 1_500, parallelIndex: 0 });
    h.scheduler.advance(50);
    // The test's line, then the block repainted below it without the ended attempt's row.
    expect(lastFrame(h)).toEqual([
      "✔ 1.5s  Backups › Create",
      "█████░░░░░ 1/2 · 50% · 1 passed · 1 running · 1m 06s",
      "  ▸ Backups › Restore · bwu5.example · 1s",
    ]);
  });

  test("its counts are the summary's for every final status: retries, flaky, failed, skipped, stopped, interrupted", () => {
    const h = liveHarness(undefined, undefined, { columns: 120 });
    const passed = scenario("p", "Passes");
    const flaky = scenario("f", "Is flaky");
    const failed = scenario("x", "Fails");
    const skipped = scenario("s", "Is skipped", 0);
    const drained = fakeTest({
      id: "d",
      titles: ["f.spec.js", "Backups", "Begins after the stop"],
      annotations: [{ type: STOPPED_ANNOTATION }],
    });
    const interrupted = scenario("i", "Is interrupted");
    const all = [passed, flaky, failed, skipped, drained, interrupted];
    begin(h as unknown as Harness, all);
    const summary = new RunTally();
    summary.begin(all.map((t) => t.test));
    /** Runs an attempt through both: the block's reporter and the summary's tally. */
    const attempt = (
      fake: FakeTest,
      result: Parameters<typeof addAttempt>[1],
    ): void => {
      beginOn(h, fake);
      const ended = addAttempt(fake, result);
      h.reporter.onTestEnd(fake.test, ended);
      summary.attemptEnded(fake.test, ended);
    };
    attempt(passed, { status: "passed" });
    attempt(flaky, failing("Error: once"));
    h.scheduler.advance(500);
    // A retry is due: not done, not counted yet.
    expect(progressRows(h).at(-1)).toMatch(
      /^1\/6 · 16% · 1 passed · 0 running/,
    );
    attempt(flaky, { status: "passed" });
    attempt(failed, failing("Error: once"));
    attempt(failed, failing("Error: twice"));
    attempt(skipped, { status: "skipped" });
    attempt(drained, { status: "skipped" });
    attempt(interrupted, { status: "interrupted" });
    h.scheduler.advance(500);
    expect(progressRows(h).at(-1)).toBe(
      "6/6 · 100% · 1 passed · 1 flaky · 1 failed · 1 interrupted · 1 skipped · 1 stopped · 0 running · 1s",
    );
    expect(describeCounts(summary.scenarios)).toBe(
      "1 failed · 1 interrupted · 1 flaky · 1 passed · 1 skipped · 1 stopped",
    );
  });

  test("the reporter's lines, the sink's and foreign writes print above it once each", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    printLine("[results] a warning through the sink", "stderr");
    h.stdout.write("[lib] stdout line\n");
    h.stderr.write("(node:1) Warning: x\n");
    h.reporter.onStdErr("[probe] worker line\n", a.test, beginningAttempt(a));
    endOn(h, a, { status: "passed", duration: 1_000 });
    const text = stripVTControlCharacters(h.stdout.all);
    for (const line of [
      "[results] a warning through the sink\r\n",
      "[lib] stdout line\r\n",
      "(node:1) Warning: x\r\n",
      "  │ [probe] worker line\r\n",
      "✔ 1.0s  Backups › Create\r\n",
    ])
      expect(text.split(line), line).toHaveLength(2);
    expect(h.stderr.chunks).toEqual([]);
  });

  test("onEnd clears it before the settled lines, and puts every stream back; onExit drains and re-blocks", async () => {
    const h = liveHarness();
    const a = scenario("a", "Never retried");
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    endOn(h, a, failing("Error: no baseline"));
    h.reporter.onEnd(RESULT);
    expect(captured(h.stdout)).toBe(false);
    expect(captured(h.stderr)).toBe(false);
    expect(h.stdout.listenerCount("resize")).toBe(0);
    expect(h.exit.count).toBe(0);
    expect(h.scheduler.timers.size).toBe(0);
    // The settled test's lines come after the block is gone, as plain lines.
    expect(stripVTControlCharacters(h.stdout.all)).toMatch(
      /\n✘ 8\.1s {2}Backups › Never retried · attempt 1\/2 · retry not run\n {2}Step {8}When it breaks\n {2}Feature {5}src\/projects\/demo\/features\/demo\.feature\n {2}Error {7}Error: no baseline\n {2}Rerun {7}E2E_CELL=x npm run test:demo -- (.+)\n$/,
    );
    expect(stripVTControlCharacters(h.stdout.all).split("\n").at(-2)).toBe(
      `  Rerun       E2E_CELL=x npm run test:demo -- ${demoGrep("Never retried")}`,
    );
    await h.reporter.onExit();
    expect(h.stdout.blocking).toEqual([false, true]);
  });

  test("a callback that throws closes it first, then warns", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    h.reporter.onTestEnd({} as TestCase, beginningAttempt(a));
    expect(captured(h.stdout)).toBe(false);
    expect(h.warnings).toHaveLength(1);
    expect(h.scheduler.timers.size).toBe(0);
  });

  test("SIGTERM clears it and puts the streams back; the block's rows throwing closes it and warns once, never retried", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    h.exit.emit("SIGTERM");
    expect(captured(h.stdout)).toBe(false);
    expect(h.exit.total).toBe(0);

    const t = liveHarness();
    const b = scenario("b", "Restore", 0);
    begin(t as unknown as Harness, [b]);
    beginOn(t, b);
    // A terminal whose size throws when read breaks the next draw (the tick's).
    Object.defineProperty(t.stdout, "rows", {
      get: () => {
        throw new Error("rows unreadable");
      },
    });
    expect(() => {
      t.scheduler.advance(500);
    }).not.toThrow();
    expect(captured(t.stdout)).toBe(false);
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("rows unreadable");
    beginOn(t, scenario("c", "Again", 0), 1);
    expect(captured(t.stdout)).toBe(false);
  });

  test("a write that fails ends it for good: streams back, nothing more written", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    h.stdout.mode = "throw";
    endOn(h, a, { status: "passed", duration: 1 });
    expect(captured(h.stdout)).toBe(false);
    h.stdout.mode = "ok";
    const before = h.stdout.chunks.length;
    printLine("after", "stdout");
    h.reporter.onEnd(RESULT);
    expect(h.stdout.chunks.length).toBe(before);
  });

  test("a later attempt's begin hands the block its row at once: the next repaint shows it", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    const b = scenario("b", "Restore", 0);
    begin(h as unknown as Harness, [a, b]);
    beginOn(h, a, 0);
    h.scheduler.advance(600);
    beginOn(h, b, 1);
    // A worker line repaints the block soon after, with the rows it was last given.
    h.reporter.onStdErr("[probe] line\n", b.test, beginningAttempt(b, 1));
    h.scheduler.advance(REPAINT_GAP_MS);
    expect(lastFrame(h)).toContain("  ▸ Backups › Restore · bwu5.example · 0s");
  });

  test("an attempt's end removes only its own row: a newer attempt on the same worker stays", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    const b = scenario("b", "Restore", 0);
    begin(h as unknown as Harness, [a, b]);
    beginOn(h, a, 0);
    // The worker was replaced: its next attempt began before the old one's end came.
    beginOn(h, b, 0);
    endOn(h, a, { status: "passed", duration: 1, parallelIndex: 0 });
    h.scheduler.advance(500);
    expect(progressRows(h).at(-1)).toMatch(/ · 1 running · /);
    expect(lastFrame(h)).toContain("  ▸ Backups › Restore · bwu4.example · 0s");
  });

  test("a second reporter on the same terminal (--add-reporter) shows no second block: its lines print above the first", () => {
    const h = liveHarness();
    const second = new TerminalReporter(
      { ...RUN, sites: ["bwu4.example"] },
      {
        stdout: h.stdout as unknown as TerminalDeps["stdout"],
        env: { TERM: "xterm-256color" },
        argv: ["node", "cli.js", "test"],
        stdoutIntercepted: false,
        warn: () => undefined,
        stderr: h.stderr as unknown as NonNullable<TerminalDeps["stderr"]>,
        exit: h.exit,
        signals: h.exit,
        scheduler: h.scheduler,
      },
    );
    built.push(second);
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    second.onBegin(CONFIG, fakeSuite([a]) as unknown as Suite);
    beginOn(h, a);
    second.onTestBegin(a.test, beginningAttempt(a));
    h.scheduler.advance(1_000);
    // One session: one capture, one set of listeners; the second's progress row never drawn.
    expect(h.exit.listenerCount("SIGTERM")).toBe(1);
    expect(h.exit.count).toBe(1);
    expect(h.stdout.listenerCount("resize")).toBe(1);
    const rows = stripVTControlCharacters(h.stdout.all).match(/0\/1 · 0% · /g);
    expect(rows?.length).toBe(3);
  });

  test("a narrow worker row keeps the scenario's own name and drops its feature", () => {
    const h = liveHarness(undefined, undefined, { columns: 44 });
    const a = scenario("a", "Create a backup now", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    expect(lastFrame(h)).toContain(
      "  ▸ Create a backup now · bwu4.example · 0s",
    );
  });

  test("never starts once a write failed, nor again after a start that threw", () => {
    const dead = liveHarness();
    const a = scenario("a", "Create", 0);
    dead.stdout.mode = "throw";
    begin(dead as unknown as Harness, [a]);
    dead.stdout.mode = "ok";
    beginOn(dead, a);
    expect(captured(dead.stdout)).toBe(false);
    expect(dead.exit.total).toBe(0);

    const h = liveHarness();
    // A standard error that refuses a new `write`: the session cannot capture it, and throws.
    Object.freeze(h.stderr);
    const b = scenario("b", "Restore", 0);
    begin(h as unknown as Harness, [a, b]);
    beginOn(h, a);
    expect(captured(h.stdout)).toBe(false);
    expect(h.warnings).toHaveLength(1);
    beginOn(h, b, 1);
    // Not tried again: the terminal was made non-blocking once.
    expect(h.stdout.blocking).toEqual([false]);
  });

  test("a closed block frees the terminal: a later reporter on it shows its own", () => {
    const first = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(first as unknown as Harness, [a]);
    beginOn(first, a);
    first.reporter.onEnd(RESULT);
    const second = new TerminalReporter(
      { ...RUN, sites: ["bwu4.example"] },
      {
        stdout: first.stdout as unknown as TerminalDeps["stdout"],
        env: { TERM: "xterm-256color" },
        argv: ["node", "cli.js", "test"],
        stdoutIntercepted: false,
        warn: () => undefined,
        stderr: first.stderr as unknown as NonNullable<TerminalDeps["stderr"]>,
        exit: first.exit,
        signals: first.exit,
        scheduler: first.scheduler,
      },
    );
    built.push(second);
    second.onBegin(CONFIG, fakeSuite([a]) as unknown as Suite);
    second.onTestBegin(a.test, beginningAttempt(a));
    expect(captured(first.stdout)).toBe(true);
    second.onEnd(RESULT);
  });

  test("its elapsed time counts from the run's begin", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    h.scheduler.advance(90_000);
    begin(h as unknown as Harness, [a]);
    h.scheduler.advance(3_000);
    beginOn(h, a);
    expect(progressRows(h).at(-1)).toMatch(/ · 1 running · 3s$/);
  });

  test("the process exiting clears it; a resize redraws it at the new width", () => {
    const h = liveHarness();
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    h.stdout.columns = 40;
    h.stdout.emit("resize");
    h.scheduler.advance(500);
    expect(progressRows(h).at(-1)).toBe("0/1 · 0% · 0 passed · 1 running · 0s");
    h.exit.emit();
    expect(captured(h.stdout)).toBe(false);
  });

  test("NO_COLOR keeps it, with no colour", () => {
    const h = liveHarness({ TERM: "xterm", NO_COLOR: "1" });
    const a = scenario("a", "Create", 0);
    begin(h as unknown as Harness, [a]);
    beginOn(h, a);
    expect(progressRows(h)).toHaveLength(1);
    // eslint-disable-next-line no-control-regex -- an SGR sequence is what must be absent.
    expect(h.stdout.all).not.toMatch(/\x1b\[[0-9;]*m/);
  });

  test("never where the terminal cannot hold it: CI (unless fancy), TERM dumb or unset, narrow, plain, a pipe, quiet", () => {
    const cases: [
      string,
      Record<string, string>,
      unknown,
      Parameters<typeof liveHarness>[2],
      boolean,
    ][] = [
      ["CI", { TERM: "xterm", CI: "true" }, RUN, {}, false],
      [
        "CI + fancy",
        { TERM: "xterm", CI: "true" },
        { ...RUN, output: "fancy" },
        {},
        true,
      ],
      ["TERM dumb", { TERM: "dumb" }, RUN, {}, false],
      ["TERM unset", {}, RUN, {}, false],
      ["19 columns", { TERM: "xterm" }, RUN, { columns: 19 }, false],
      ["20 columns", { TERM: "xterm" }, RUN, { columns: 20 }, true],
      ["plain", { TERM: "xterm" }, { ...RUN, output: "plain" }, {}, false],
      [
        "a pipe",
        { TERM: "xterm" },
        { ...RUN, output: "fancy" },
        { tty: false },
        false,
      ],
      ["--list", { TERM: "xterm" }, { ...RUN, _mode: "list" }, {}, false],
      ["watch", { TERM: "xterm", PWTEST_WATCH: "1" }, RUN, {}, false],
    ];
    for (const [name, env, options, size, live] of cases) {
      const h = liveHarness(env, options, size);
      const a = scenario("a", "Create", 0);
      begin(h as unknown as Harness, [a]);
      beginOn(h, a);
      expect(captured(h.stdout), name).toBe(live);
      expect(progressRows(h).length > 0, name).toBe(live);
      expect(h.stdout.all.includes("\r"), name).toBe(live);
    }
  });
});

test.describe("siteLabelsOption", () => {
  test("the labels when a list of strings, else none", () => {
    expect(siteLabelsOption({ sites: ["a", "b"] })).toEqual(["a", "b"]);
    for (const options of [
      undefined,
      null,
      {},
      { sites: "a" },
      { sites: ["a", 1] },
    ])
      expect(siteLabelsOption(options)).toEqual([]);
  });
});
