/**
 * The ways generating one run's Allure report fails (`allure-report.ts`), each its own type so a
 * caller — the `report:allure` command, the orchestrator's run end — can say what went wrong and
 * tell a run that has nothing to report from a broken one. Every one extends
 * {@link AllureReportError}; none quotes the Allure command line, only paths and reasons.
 */

/** Any failure to generate an Allure report; the subclasses say which. */
export class AllureReportError extends Error {
  /**
   * @param message - what went wrong, for a person.
   * @param options - the underlying error, when one explains it (a filesystem error, never a
   *   child process's).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AllureReportError";
  }
}

/** The Allure CLI could not be started: not installed, or not executable. */
export class AllureCliMissingError extends AllureReportError {
  /**
   * @param bin - the CLI's path.
   * @param code - the spawn error's code (`ENOENT`, `EACCES`, …).
   */
  constructor(
    readonly bin: string,
    readonly code: string,
  ) {
    super(
      `The Allure CLI at ${bin} could not be started (${code}). Install the dependencies: npm ci.`,
    );
    this.name = "AllureCliMissingError";
  }
}

/** Why a results folder holds nothing to report. */
export type AllureResultsProblem = "missing" | "not-a-folder" | "empty";

/**
 * A results folder with nothing to report: absent, not a folder, or without one `*-result.json`
 * (a run that ran nothing). Allure itself would exit 0 on an empty folder, writing an empty report
 * and a history entry for it.
 */
export class AllureResultsMissingError extends AllureReportError {
  /**
   * @param resultsDir - the folder.
   * @param problem - what is wrong with it.
   */
  constructor(
    readonly resultsDir: string,
    readonly problem: AllureResultsProblem,
  ) {
    super(
      problem === "missing"
        ? `No Allure results at ${resultsDir}: the folder does not exist.`
        : problem === "not-a-folder"
          ? `No Allure results at ${resultsDir}: it is not a folder.`
          : `No Allure results at ${resultsDir}: it holds no test result (*-result.json).`,
    );
    this.name = "AllureResultsMissingError";
  }
}

/**
 * A result or container file that is not a JSON object. Allure itself skips such a file with a
 * stack trace and exits 0, so a report would silently miss that test.
 */
export class MalformedAllureResultError extends AllureReportError {
  /**
   * @param file - the file's path.
   * @param reason - why it was refused (the parser's message, or what it held instead).
   */
  constructor(
    readonly file: string,
    readonly reason: string,
  ) {
    super(`Malformed Allure result ${file}: ${reason}.`);
    this.name = "MalformedAllureResultError";
  }
}

/** `allure generate` ran and failed: a non-zero exit or a signal. */
export class AllureGenerationFailedError extends AllureReportError {
  /**
   * @param exitCode - its exit code; `null` when a signal ended it.
   * @param signal - the signal that ended it, if one did.
   * @param output - the end of what it printed, when it was captured (`""` otherwise); never in the
   *   message, which a log line may carry.
   */
  constructor(
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    readonly output: string,
  ) {
    super(
      `allure generate failed (${exitCode === null ? `signal ${String(signal)}` : `exit code ${String(exitCode)}`}); ` +
        "the previous report and history are untouched.",
    );
    this.name = "AllureGenerationFailedError";
  }
}

/** Generation was stopped by the caller's abort signal; nothing was put in place. */
export class AllureGenerationAbortedError extends AllureReportError {
  /** Takes nothing: a stop has no detail, and the message says what is left as it was. */
  constructor() {
    super(
      "Allure generation was stopped; the previous report and history are untouched.",
    );
    this.name = "AllureGenerationAbortedError";
  }
}
