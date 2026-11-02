import type {
  Environment,
  OutputMode,
  ScreenContext,
} from "../terminal/capabilities";

/**
 * Who owns the screen while the terminal reporter runs, read from what Playwright 1.63 leaves in the
 * reporter's reach (each checked in `playwright/lib`, and through the real runner where it can be):
 *
 * - `--list`: Playwright adds `_mode: "list"` to every reporter's options.
 * - `--ui` (`--ui-host`, `--ui-port`): the runner gives no option or config field; the CLI process
 *   that serves the UI is the one the reporters run in, so its `argv` holds the flag. The UI also
 *   asks the test server to intercept stdio, which replaces `process.stdout.write` with an own
 *   property of the stream — what a client of `playwright test-server` (an editor) that intercepts
 *   leaves too.
 * - watch mode: only `PWTEST_WATCH` turns it on (1.63 has no `--watch` flag). It does not intercept
 *   stdio, so the reporter prints there: only its context changes (no live region).
 * - `PW_TEST_REPORTER`: appends a second reporter to the configured stack, which then prints too.
 *   `--add-reporter` appends the same way and is not detected (only `argv` would show it): an added
 *   printing reporter prints every line a second time, an added `list` errors unmasked.
 *
 * `--reporter` needs no check: it replaces the whole configured stack, this reporter included.
 */

/** What decides the screen's owner. */
export interface ScreenInputs {
  /** The reporter's options: Playwright's `_mode` among them. */
  readonly options: unknown;
  readonly env: Environment;
  /** The runner's arguments (`process.argv`). */
  readonly argv: readonly string[];
  /** Whether standard output's `write` was replaced on the stream itself (`process.stdout`). */
  readonly stdoutIntercepted: boolean;
}

/** Who owns the screen, and why the reporter stays quiet when it does not. */
export interface ScreenOwner {
  readonly context: ScreenContext;
  /** Why the reporter prints nothing; `undefined` when it owns the terminal (watch mode too). */
  readonly inert?: "list" | "ui" | "second-reporter";
}

/** The arguments that open the UI. */
const UI_FLAG = /^--ui(?:-host|-port)?(?:=|$)/;

/**
 * Who owns the screen: Playwright's listing, its UI, a second reporter `PW_TEST_REPORTER` added —
 * first match wins, in that order — or the reporter, in a plain run (`run`) or watch mode (`watch`).
 *
 * @param inputs - the options, environment, arguments and stream state.
 * @example
 * ```ts
 * screenOwner({ options: { _mode: "test" }, env: {}, argv: ["node", "cli.js", "test", "--ui"],
 *   stdoutIntercepted: true }); // { context: "ui", inert: "ui" }
 * ```
 */
export function screenOwner(inputs: ScreenInputs): ScreenOwner {
  if (optionMode(inputs.options) === "list") {
    return { context: "list", inert: "list" };
  }
  if (
    inputs.argv.some((arg) => UI_FLAG.test(arg)) ||
    inputs.stdoutIntercepted
  ) {
    return { context: "ui", inert: "ui" };
  }
  const context = isSet(inputs.env.PWTEST_WATCH) ? "watch" : "run";
  if (isSet(inputs.env.PW_TEST_REPORTER)) {
    return { context, inert: "second-reporter" };
  }
  return { context };
}

/**
 * Whether `process.stdout.write` was replaced on the stream itself, as Playwright's stdio
 * interception does: a stream's own `write` comes from its prototype.
 *
 * @param stream - the stream (`process.stdout`).
 */
export function writeIntercepted(stream: object): boolean {
  return Object.hasOwn(stream, "write");
}

/**
 * The output mode the config factory put in the reporter's options (`output`, from `E2E_OUTPUT`,
 * validated there); `auto` when absent or not a mode — a reporter never throws over its options.
 *
 * @param options - the reporter's options.
 */
export function outputModeOption(options: unknown): OutputMode {
  const value = field(options, "output");
  return value === "plain" || value === "fancy" ? value : "auto";
}

/**
 * Playwright's `_mode` option.
 *
 * @param options - the reporter's options.
 */
function optionMode(options: unknown): unknown {
  return field(options, "_mode");
}

/**
 * One field of an options object, or `undefined`.
 *
 * @param options - the reporter's options.
 * @param name - the field.
 */
function field(options: unknown, name: string): unknown {
  return typeof options === "object" && options !== null
    ? (options as Record<string, unknown>)[name]
    : undefined;
}

/**
 * Whether a variable is on as Playwright reads it (`if (process.env.X)`): present and not empty.
 *
 * @param value - its value.
 */
function isSet(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}
