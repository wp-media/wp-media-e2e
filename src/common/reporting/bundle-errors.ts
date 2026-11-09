/**
 * The ways building a run's report bundle fails (`report-bundle.ts`), each its own type so the
 * caller — the orchestrator's run end — can log why and fall back to the raw folder. Every one
 * extends {@link ReportBundleError}; none quotes a command line, only paths and reasons. A missing
 * report or a failed Allure is not an error: the bundle is built without it and says so.
 */

/** Any failure to build a report bundle; the subclasses say which. */
export class ReportBundleError extends Error {
  /**
   * @param message - what went wrong, for a person.
   * @param options - the underlying error, when one explains it (a filesystem error).
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReportBundleError";
  }
}

/** `tar` could not be started, or ran and failed: no archive was put in place. */
export class BundleArchiveError extends ReportBundleError {
  /**
   * @param reason - why: the spawn error's code (`ENOENT`), the exit code or the signal.
   * @param output - the end of what `tar` printed (`""` when nothing); never in the message.
   */
  constructor(
    readonly reason: string,
    readonly output: string,
  ) {
    super(
      `Could not pack the report bundle with tar (${reason}); no bundle was put in place.`,
    );
    this.name = "BundleArchiveError";
  }
}

/** Building was stopped by the caller's abort signal; nothing was put in place. */
export class ReportBundleAbortedError extends ReportBundleError {
  /** Takes nothing: a stop has no detail, and the message says what is left as it was. */
  constructor() {
    super("Building the report bundle was stopped; nothing was put in place.");
    this.name = "ReportBundleAbortedError";
  }
}
