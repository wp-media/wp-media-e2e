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
import {
  detectCapabilities,
  type Environment,
  type OutputStream,
} from "../terminal/capabilities";
import { terminalWidth } from "../terminal/layout";
import { writeSafely, type ByteSink } from "../terminal/stream";
import {
  RunTally,
  firstError,
  isNoTestsFound,
  scenarioPlace,
  wasDrainedTest,
  type TestStatus,
} from "./results";
import { readRunDescription, type RunDescription } from "./run-description";
import {
  OUTSIDE_TESTS_TITLE,
  beginLine,
  droppedOutputLine,
  errorLine,
  outputLine,
  runErrorLines,
  runHeaderLine,
  suiteLine,
  terminalStyle,
  testLine,
  testTitle,
  verdictOf,
  type TerminalStyle,
} from "./terminal-lines";
import {
  outputModeOption,
  screenOwner,
  writeIntercepted,
  type ScreenOwner,
} from "./terminal-mode";
import { registerTerminalSink } from "./terminal-sink";
import { WorkerOutput } from "./worker-output";

/**
 * The run's terminal output, in place of Playwright's `list`: a header, one line per test at its
 * final attempt, a line per attempt due a retry, the workers' output, errors raised outside any test.
 * Plain, stable lines — the same words on a terminal, in a pipe and in the orchestrator's `run.log`;
 * colour only where the capabilities allow it (`E2E_OUTPUT`, `NO_COLOR`, `FORCE_COLOR`, a terminal).
 *
 * It is the run's one writer ({@link registerTerminalSink}): the cell notice and the other reporters'
 * warnings print through it, plain and masked but never cut (they name paths and commands).
 *
 * Worker output is printed **as it comes**, line by line, everywhere: a run killed mid-scenario
 * (the orchestrator's SIGKILL) leaves its last lines in `run.log`. Parallel workers interleave, so
 * whenever the next output line comes from another source than the last line printed — a test's
 * attempt, or output outside any test — a begin line names it first (`▸ Feature › Scenario`,
 * `· attempt 2/3` past the first, `▸ outside any test`); the attempt's own line still comes at its
 * end. Workers print with `FORCE_COLOR=1` (Playwright sets it), so their output carries escapes
 * whatever the runner's environment says: each line is made plain, masked whole, then capped.
 * Standard output and error are cut into lines apart. Each shows 200 lines per source (a test's
 * attempt; output outside any test, until a test ends), then says how many it did not show.
 * `--quiet` drops worker output, as `list` did.
 *
 * Quiet — and then `printsToStdio()` is `false`, so Playwright adds its own terminal reporter (`line`,
 * `dot` under CI; its listing for `--list`) — for `--list`, under `--ui` (Playwright owns the screen)
 * and when `PW_TEST_REPORTER` adds a reporter (`terminal-mode.ts`). Watch mode (`PWTEST_WATCH`) does
 * not intercept stdio: it prints there. `--reporter` replaces the whole configured stack, this
 * included. `--add-reporter` is not detected: an added printing reporter prints every line a second
 * time, and an added `list` prints errors unmasked — the caller's choice.
 *
 * Never fails a run: every callback is caught, and a callback's failure warns once on stderr — missing
 * options warn apart, so they never hide it. While it owns standard output it listens for its `error` event, so a closed pipe
 * (`EPIPE`, `… | head -1`) never crashes the runner; a write that fails stops its output for good, and
 * the listener stays so the writers after it (the summary) fail silently too.
 */

/** A stream's `error` event, which an unheard emit turns into a crash: `process.stdout` has it. */
export interface ErrorEvents {
  /**
   * Listens for the stream's failures.
   *
   * @param event - always `error`.
   * @param listener - called with the error.
   */
  on(event: "error", listener: (error: Error) => void): unknown;
  /**
   * Stops listening.
   *
   * @param event - always `error`.
   * @param listener - the listener given to {@link ErrorEvents.on}.
   */
  off(event: "error", listener: (error: Error) => void): unknown;
}

/** What the reporter writes to and reads: `process.stdout` and the process, by default. */
export interface TerminalDeps {
  /** Standard output: written, listened to, and read for its size and whether it is a terminal. */
  readonly stdout: ByteSink & OutputStream & ErrorEvents;
  readonly env: Environment;
  /** The runner's arguments, for `--ui`. */
  readonly argv: readonly string[];
  /** Whether Playwright intercepts standard output (UI mode, an editor's test server). */
  readonly stdoutIntercepted: boolean;
  /** Where the reporter's own failure is told, once. */
  readonly warn: (message: string) => void;
}

/**
 * The process's own streams and state.
 *
 * @returns the dependencies of a reporter in the runner.
 */
function processDeps(): TerminalDeps {
  return {
    stdout: process.stdout,
    env: process.env,
    argv: process.argv,
    stdoutIntercepted: writeIntercepted(process.stdout),
    warn: (message) => process.stderr.write(`${message}\n`),
  };
}

/** Whose output a line is: a test's attempt, or none (output outside any test). */
interface OutputSource {
  readonly test?: TestCase;
  /** The attempt's retry index (`TestResult.retry`): 0 for the first. */
  readonly retry: number;
}

/** The key of output written outside any test: between tests, at worker start or teardown. */
const OUTSIDE_TESTS = "";

/** The source of output written outside any test. */
const OUTSIDE: OutputSource = { retry: 0 };

/** A worker's two streams, each cut into lines apart: a partial line on one never joins the other's. */
type Stream = "stdout" | "stderr";

/** Both streams, in the order an ended source prints what it still holds. */
const STREAMS: readonly Stream[] = ["stdout", "stderr"];

/**
 * The key {@link WorkerOutput} holds a source's stream under.
 *
 * @param stream - the stream.
 * @param id - the source: a test's id, or {@link OUTSIDE_TESTS}.
 */
function outputKey(stream: Stream, id: string): string {
  return `${stream} ${id}`;
}

/** What the reporter warns about: its options, or a callback that threw — each told once. */
type Warning = "options" | "failure";

/** Prints the run as plain, permanent lines; see the module's description. */
export default class TerminalReporter implements Reporter {
  /** What the config factory said about the run, or the field it forgot. */
  private readonly run: RunDescription | { readonly missing: string };
  /** Who owns the screen. */
  private readonly owner: ScreenOwner;
  /** How lines are styled. */
  private readonly style: TerminalStyle;
  /** The screen's width, for the header's rule. */
  private readonly width: number;
  /** The run's tally: final attempt or retry, and the statuses. */
  private readonly tally = new RunTally();
  /** The workers' output, cut into lines per source. */
  private readonly output = new WorkerOutput();
  /** The tests with output whose attempt has not ended: their open lines are printed at the end. */
  private readonly openTests = new Map<string, OutputSource>();
  /** The source of the last line printed, when it was output; `undefined` after any other line. */
  private lastSource: string | undefined;
  /** Whether worker output is dropped: `--quiet` (`config.quiet`), as `list` dropped it. */
  private quietOutput = false;
  /** Unregisters this reporter's sink; `undefined` when it never registered. */
  private unregister: (() => void) | undefined;
  /** Whether it listens for standard output's `error` event. */
  private listening = false;
  /** Whether a write failed: nothing more is written. */
  private dead = false;
  /** The warnings already told. */
  private readonly warned = new Set<Warning>();

  /**
   * @param options - a {@link RunDescription} and `output` (`E2E_OUTPUT`), plus what Playwright adds.
   * @param deps - the streams and state read; the process's own by default.
   */
  constructor(
    options: unknown,
    private readonly deps: TerminalDeps = processDeps(),
  ) {
    this.run = readRunDescription(options);
    this.owner = screenOwner({
      options,
      env: deps.env,
      argv: deps.argv,
      stdoutIntercepted: deps.stdoutIntercepted,
    });
    this.style = terminalStyle(
      detectCapabilities({
        env: deps.env,
        stream: deps.stdout,
        mode: outputModeOption(options),
        context: this.owner.context,
      }),
    );
    this.width = terminalWidth({ stream: deps.stdout, env: deps.env });
    if (this.quiet()) return;
    // Registered as it is built, before any reporter's `onBegin`: the cell notice, listed first,
    // prints in its own.
    this.unregister = registerTerminalSink({
      print: (text) => {
        this.forward(text);
      },
    });
    try {
      deps.stdout.on("error", this.streamFailed);
      this.listening = true;
    } catch {
      // A stream without events cannot crash the runner with one.
    }
  }

  /**
   * Prints the run's header.
   *
   * @param config - the run's resolved config: `quiet` drops worker output.
   * @param suite - every test the run plans.
   */
  onBegin(config: FullConfig, suite: Suite): void {
    this.guard(() => {
      if (this.quiet()) return;
      this.quietOutput = config.quiet;
      this.tally.begin(suite.allTests());
      if ("missing" in this.run) {
        this.warnOnce(
          "options",
          `the reporter's options lack "${this.run.missing}"`,
        );
        return;
      }
      const { run } = this;
      this.print([
        runHeaderLine(
          this.style,
          {
            product: run.product,
            ...(run.cell !== undefined ? { cell: run.cell } : {}),
            ...(run.edition !== undefined ? { edition: run.edition } : {}),
            runId: run.runId,
            ...(run.requestedRef !== undefined
              ? { requestedRef: run.requestedRef }
              : {}),
            scenarios: this.tally.scenarios.total,
          },
          this.width,
        ),
      ]);
    });
  }

  /**
   * Prints a worker's standard output as its lines complete.
   *
   * @param chunk - what it wrote.
   * @param test - the test it ran, if any.
   * @param result - that test's attempt.
   */
  onStdOut(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
    this.workerOutput("stdout", chunk, test, result);
  }

  /**
   * Prints a worker's standard error, as {@link TerminalReporter.onStdOut} prints its output.
   *
   * @param chunk - what it wrote.
   * @param test - the test it ran, if any.
   * @param result - that test's attempt.
   */
  onStdErr(chunk: string | Buffer, test?: TestCase, result?: TestResult): void {
    this.workerOutput("stderr", chunk, test, result);
  }

  /**
   * Prints the rest of the attempt's output, then its line: the test's, when it is final; a retry's
   * otherwise. A test's end also ends the stretch of output outside any test.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard(() => {
      if (this.quiet()) return;
      const verdict = this.tally.attemptEnded(test, result);
      this.endOutput(OUTSIDE_TESTS, OUTSIDE);
      this.endOutput(test.id, { test, retry: result.retry });
      this.print(
        verdict.final
          ? this.finalLines(test, result, verdict.status)
          : this.retryLines(test, result),
      );
    });
  }

  /**
   * Prints an error raised outside any test: a spec file that will not load, a global timeout.
   * "No tests found" is a warning: the summary says what it means.
   *
   * @param error - the error.
   */
  onError(error: TestError): void {
    this.guard(() => {
      if (this.quiet()) return;
      const message = error.message ?? error.value ?? "";
      this.print(
        runErrorLines(
          this.style,
          message,
          isNoTestsFound({ message }) ? "warning" : "error",
        ),
      );
    });
  }

  /**
   * Ends the tests whose retry never ran, and the output outside any test. A test still running (a
   * global timeout ends the run first) prints its output with its own late end. Returns nothing: a
   * returned status would replace the run's own.
   *
   * @param _result - the run's status, which the summary reports.
   */
  onEnd(_result: FullResult): void {
    this.guard(() => {
      if (this.quiet()) return;
      for (const { test, result, status } of this.tally.settle()) {
        this.print(this.finalLines(test, result, status, "retry not run"));
      }
      this.endOutput(OUTSIDE_TESTS, OUTSIDE);
    });
  }

  /**
   * Prints the open output of tests that never ended, then hands the terminal back: later writers
   * (the summary) print as they would alone.
   */
  onExit(): Promise<void> {
    this.guard(() => {
      if (this.quiet()) return;
      for (const [id, source] of [...this.openTests]) {
        this.endOutput(id, source);
      }
    });
    this.guard(() => {
      this.release();
    });
    return Promise.resolve();
  }

  /**
   * Whether this reporter prints the run: whenever it is not quiet. Quiet, Playwright adds its own
   * terminal reporter — its listing for `--list` — so a run is never silent.
   */
  printsToStdio(): boolean {
    return !this.quiet();
  }

  /** Called on standard output's `error` event: the stream is gone, nothing more is written. */
  private readonly streamFailed = (): void => {
    this.dead = true;
  };

  /**
   * Unregisters the sink and, unless the stream failed, the `error` listener: a failed stream keeps
   * it, so the writers after this reporter's last (the summary) fail silently as the terminal is gone.
   */
  private release(): void {
    this.unregister?.();
    this.unregister = undefined;
    if (this.listening && !this.dead) {
      this.listening = false;
      this.deps.stdout.off("error", this.streamFailed);
    }
  }

  /**
   * Prints lines another reporter hands the sink: the suite's own, made plain and masked, never cut.
   *
   * @param text - one or more lines.
   */
  private forward(text: string): void {
    this.guard(() => {
      this.print(text.split("\n").map((line) => suiteLine(line)));
    });
  }

  /**
   * Adds a worker's chunk to its source and prints the lines it completed. Outside any test each chunk
   * is a line of its own: Playwright names no worker there, so two workers' halves must not join.
   *
   * @param stream - the stream it wrote to.
   * @param chunk - what it wrote.
   * @param test - the test it ran, if any.
   * @param result - that test's attempt.
   */
  private workerOutput(
    stream: Stream,
    chunk: string | Buffer,
    test: TestCase | undefined,
    result: TestResult | undefined,
  ): void {
    this.guard(() => {
      if (this.quiet() || this.quietOutput) return;
      const id = test?.id ?? OUTSIDE_TESTS;
      const source =
        test === undefined ? OUTSIDE : { test, retry: result?.retry ?? 0 };
      if (test !== undefined) this.openTests.set(id, source);
      const key = outputKey(stream, id);
      this.printOutput(
        id,
        source,
        this.output.append(key, chunk, test === undefined),
      );
    });
  }

  /**
   * Ends a source: prints each stream's open line and how many lines it did not show.
   *
   * @param id - the source: a test's id, or {@link OUTSIDE_TESTS}.
   * @param source - whose output it is.
   */
  private endOutput(id: string, source: OutputSource): void {
    this.openTests.delete(id);
    for (const stream of STREAMS) {
      const { lines, dropped } = this.output.end(outputKey(stream, id));
      this.printOutput(id, source, lines, dropped);
    }
  }

  /**
   * Prints worker output in its gutter — under a begin line naming its source when the last line
   * printed was not its own — and, when it dropped lines, how many.
   *
   * @param key - the source: a test's id, or {@link OUTSIDE_TESTS}.
   * @param source - whose output it is.
   * @param lines - the lines, as the worker wrote them.
   * @param dropped - how many lines it did not show.
   */
  private printOutput(
    key: string,
    source: OutputSource,
    lines: readonly string[],
    dropped = 0,
  ): void {
    const printed = lines.map((line) => outputLine(this.style, line));
    if (dropped > 0) {
      printed.push(
        droppedOutputLine(this.style, dropped, key !== OUTSIDE_TESTS),
      );
    }
    if (printed.length === 0) return;
    if (this.lastSource !== key) printed.unshift(this.beginLineOf(source));
    this.write(printed);
    this.lastSource = key;
  }

  /**
   * The line naming a source: its test and attempt, or output outside any test.
   *
   * @param source - whose output follows.
   */
  private beginLineOf(source: OutputSource): string {
    const { test } = source;
    if (test === undefined) return beginLine(this.style, OUTSIDE_TESTS_TITLE);
    return beginLine(this.style, this.titleOf(test), {
      number: source.retry + 1,
      of: test.retries + 1,
    });
  }

  /**
   * A finished test's line and, when it failed or was interrupted, its first error's.
   *
   * @param test - the test.
   * @param result - its last attempt.
   * @param status - its final status.
   * @param after - words after the attempt (`retry not run`).
   */
  private finalLines(
    test: TestCase,
    result: TestResult,
    status: TestStatus,
    after?: string,
  ): string[] {
    const failed = status === "failed" || status === "interrupted";
    // `test.fail()` that passed: failed, with no error to say why.
    const unexpected =
      failed && result.status === "passed" ? "passed unexpectedly" : undefined;
    const note = this.notes(unexpected, after);
    const line = testLine(this.style, {
      verdict: verdictOf(status, wasDrainedTest(test)),
      durationMs: result.duration,
      title: this.titleOf(test),
      attempt: { number: result.retry + 1, of: test.retries + 1 },
      ...(note !== undefined ? { note } : {}),
    });
    return [line, ...(failed ? this.errorLines(result) : [])];
  }

  /**
   * An attempt due a retry: its line, how it ended, and its first error's line.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  private retryLines(test: TestCase, result: TestResult): string[] {
    return [
      testLine(this.style, {
        verdict: "retry",
        durationMs: result.duration,
        title: this.titleOf(test),
        attempt: { number: result.retry + 1, of: test.retries + 1 },
        note: attemptNote(test, result),
      }),
      ...this.errorLines(result),
    ];
  }

  /**
   * Words after a line's attempt, joined by the separator.
   *
   * @param words - each phrase, or `undefined` for none.
   * @returns the note, or `undefined` when there is none.
   */
  private notes(...words: readonly (string | undefined)[]): string | undefined {
    const given = words.filter((word) => word !== undefined);
    return given.length === 0
      ? undefined
      : given.join(` ${this.style.palette.symbol("separator")} `);
  }

  /**
   * The line of an attempt's first error, if it has one.
   *
   * @param result - the attempt.
   */
  private errorLines(result: TestResult): string[] {
    const error = firstError(result);
    const line =
      error === undefined ? undefined : errorLine(this.style, error.message);
    return line === undefined ? [] : [line];
  }

  /**
   * A test's title: its feature, Rules and Outlines, and its own.
   *
   * @param test - the test.
   */
  private titleOf(test: TestCase): string {
    const place = scenarioPlace(test, test.parent.project()?.testDir);
    return testTitle(
      [place.feature, ...place.path, place.scenario],
      this.style,
    );
  }

  /** Whether this reporter prints nothing: another owns the screen. */
  private quiet(): boolean {
    return this.owner.inert !== undefined;
  }

  /**
   * Prints lines that are no worker output: the next output line names its source again.
   *
   * @param lines - permanent lines, without line ends.
   */
  private print(lines: readonly string[]): void {
    if (lines.length === 0) return;
    this.write(lines);
    this.lastSource = undefined;
  }

  /**
   * Writes lines to standard output, once each, as bytes; a failed write stops all later ones.
   *
   * @param lines - permanent lines, without line ends.
   */
  private write(lines: readonly string[]): void {
    if (lines.length === 0 || this.dead) return;
    const bytes = Buffer.from(`${lines.join("\n")}\n`, "utf8");
    writeSafely(this.deps.stdout, bytes, () => {
      this.dead = true;
    });
  }

  /**
   * Runs a callback's work, turning a throw into the one warning: a reporter that throws fails a
   * run that passed.
   *
   * @param work - the work.
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.warnOnce("failure", errorMessage(error));
    }
  }

  /**
   * Tells the reporter's own trouble on stderr, once per kind — missing options do not hide a later
   * throw: the run goes on with less on the terminal.
   *
   * @param kind - what went wrong: the options, or a callback.
   * @param reason - the words.
   */
  private warnOnce(kind: Warning, reason: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    try {
      this.deps.warn(
        `[terminal] ${reason}. The run goes on; its reports have every result.`,
      );
    } catch {
      // Nothing is left to tell.
    }
  }
}

/**
 * How an attempt due a retry ended, in words: `timed out`; `passed unexpectedly` under `test.fail()`;
 * `not run: its group failed` for one skipped because a `beforeAll` hook or a serial test before it
 * failed; else its status.
 *
 * @param test - the test.
 * @param result - the attempt.
 */
export function attemptNote(test: TestCase, result: TestResult): string {
  switch (result.status) {
    case "timedOut":
      return "timed out";
    case "passed":
      return test.expectedStatus === "failed"
        ? "passed unexpectedly"
        : "passed";
    case "skipped":
      return "not run: its group failed";
    default:
      return result.status;
  }
}
