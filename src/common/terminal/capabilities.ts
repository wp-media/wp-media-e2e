/**
 * What a terminal output stream can show: colour, a live (redrawn) region, Unicode symbols. Shared by
 * the suite's reporter and the orchestrator's logger, so both decide the same way.
 *
 * Pure: every input — the environment, the stream, the output mode — is a parameter. Nothing here
 * reads `process`, installs a listener or starts a timer, at import or at call.
 *
 * Node's `styleText` is never the decision-maker: it drops colour under any `CI` (even empty or
 * `false`), and reads `FORCE_COLOR=yes` as "no colour" (measured, Node 24). {@link detectCapabilities}
 * decides once; the palette then styles without Node's checks.
 *
 * Width is not decided here: the layout computes it from the same stream and environment.
 */

/**
 * How much styling the caller allows. `auto`: what the stream and environment support. `plain`: no
 * colour, no live region, ASCII — whatever else says. `fancy`: as `auto`, but `CI` no longer turns
 * the live region off; it never adds colour the precedence refuses, nor a live region without a
 * terminal.
 */
export type OutputMode = "auto" | "plain" | "fancy";

/**
 * Who owns the screen. `run`: this process. `ui` and `watch`: Playwright's UI or watch mode, which
 * intercept stdio. `list`: `--list`, which prints its listing. Only `run` may redraw.
 */
export type ScreenContext = "run" | "ui" | "watch" | "list";

/** The environment, as `process.env` holds it: a variable is absent or a string (maybe empty). */
export type Environment = Readonly<Record<string, string | undefined>>;

/** As much of an output stream as the decision reads: `process.stdout` is one. */
export interface OutputStream {
  /** `true` only for a terminal (a `tty.WriteStream`). */
  readonly isTTY?: boolean;
  /** The terminal's width in columns; `0` under `script` until `stty` sets it. */
  readonly columns?: number;
  /** The terminal's height in rows; `0` under `script` until `stty` sets it. */
  readonly rows?: number;
}

/** What {@link detectCapabilities} decides from. */
export interface CapabilityInputs {
  /** The variables that decide: `FORCE_COLOR`, `NO_COLOR`, `NODE_DISABLE_COLORS`, `TERM`, `CI`, the locale. */
  readonly env: Environment;
  /** The stream written to: whether it is a terminal, and its size. */
  readonly stream: OutputStream;
  /** Default `auto`. */
  readonly mode?: OutputMode;
  /** Default `run`. */
  readonly context?: ScreenContext;
  /**
   * Whether `FORCE_COLOR` may colour a stream that is no terminal. Default `true`: the suite colours
   * a piped run when asked. The orchestrator passes `false`: its piped stdout keeps its plain bytes
   * whatever the environment says. On a terminal it changes nothing.
   */
  readonly forceColorWithoutTty?: boolean;
}

/** What the stream may show. Every field is a final decision: a consumer never re-checks the env. */
export interface TerminalCapabilities {
  /** The stream is a terminal — even under `plain`, which only turns the styling off. */
  readonly tty: boolean;
  /** Emit SGR colour and bold/dim. */
  readonly color: boolean;
  /** Redraw a region in place (cursor movement). */
  readonly live: boolean;
  /** Use the Unicode symbols; ASCII otherwise. */
  readonly unicode: boolean;
}

/** {@link CapabilityInputs} with every default applied, `plain` ruled out, and `tty` read once. */
interface Decision {
  readonly env: Environment;
  readonly stream: OutputStream;
  readonly tty: boolean;
  readonly mode: "auto" | "fancy";
  readonly context: ScreenContext;
  readonly forceColorWithoutTty: boolean;
}

/** Values that switch a boolean-ish variable (`CI`, `FORCE_COLOR`) off, compared lower-case. */
const OFF_VALUES: ReadonlySet<string> = new Set(["0", "false"]);

/**
 * Decides what `stream` may show, in one precedence. Mode `plain` wins: no colour, no live region,
 * ASCII. Else colour is decided, in order, by: a non-terminal the caller keeps plain
 * (`forceColorWithoutTty: false`); a present `FORCE_COLOR` (`0`/`false` off, any other value — empty
 * included — on); a non-empty `NO_COLOR`, any `NODE_DISABLE_COLORS`, or a `TERM` that is `dumb`,
 * unset or empty (all off); last, whether the stream is a terminal. `CI` never turns colour off: it
 * only turns the live region off, unless `fancy`. The live region also needs a sized terminal with a
 * usable `TERM` that this process owns (`context` `run`). Symbols are ASCII on `TERM=dumb` or a
 * non-UTF-8 locale ({@link localeIsUtf8}).
 *
 * @param inputs - the environment, the stream (its `isTTY`, `columns` and `rows`), and the caller's
 *   mode, screen context and pipe policy.
 * @returns the final decisions.
 * @example
 * ```ts
 * detectCapabilities({
 *   env: { CI: "true", TERM: "xterm-256color" },
 *   stream: { isTTY: true, columns: 80, rows: 24 },
 * });
 * // { tty: true, color: true, live: false, unicode: true }
 * ```
 */
export function detectCapabilities(
  inputs: CapabilityInputs,
): TerminalCapabilities {
  const {
    env,
    stream,
    mode = "auto",
    context = "run",
    forceColorWithoutTty = true,
  } = inputs;
  const tty = stream.isTTY === true;
  if (mode === "plain") {
    return { tty, color: false, live: false, unicode: false };
  }
  const decision = { env, stream, tty, mode, context, forceColorWithoutTty };
  return {
    tty,
    color: colorEnabled(decision),
    live: liveEnabled(decision),
    unicode: unicodeEnabled(env),
  };
}

/**
 * Whether colour is on: a non-terminal the caller keeps plain first, then `FORCE_COLOR`, then the
 * variables that turn it off, then the stream.
 *
 * @param decision - the inputs, defaults applied.
 */
function colorEnabled(decision: Decision): boolean {
  const { env, tty, forceColorWithoutTty } = decision;
  if (!tty && !forceColorWithoutTty) return false;
  const force = env.FORCE_COLOR;
  if (force !== undefined) return !isOffValue(force);
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.NODE_DISABLE_COLORS !== undefined) return false;
  if (!termCanStyle(env)) return false;
  return tty;
}

/**
 * Whether a live region may be drawn: this process owns a real terminal with a known size whose
 * `TERM` can move the cursor, and `CI` is off unless the mode is `fancy`. Colour plays no part:
 * `NO_COLOR` keeps the live region.
 *
 * @param decision - the inputs, defaults applied.
 */
function liveEnabled(decision: Decision): boolean {
  const { env, stream, tty, mode, context } = decision;
  if (!tty || context !== "run") return false;
  if (!termCanStyle(env)) return false;
  if (!isPositiveInteger(stream.columns) || !isPositiveInteger(stream.rows)) {
    return false;
  }
  return mode === "fancy" || !isCi(env);
}

/**
 * Whether the Unicode symbols are safe: not on a `dumb` terminal nor under a non-UTF-8 locale. An
 * unset `TERM` keeps them: it says nothing about the character set.
 *
 * @param env - the environment.
 */
function unicodeEnabled(env: Environment): boolean {
  return env.TERM !== "dumb" && localeIsUtf8(effectiveLocale(env));
}

/**
 * The locale that decides the character set, as POSIX picks it: the first non-empty of `LC_ALL`,
 * `LC_CTYPE`, `LANG`.
 *
 * @param env - the environment.
 * @returns the locale name, or `undefined` when none is set.
 */
export function effectiveLocale(env: Environment): string | undefined {
  for (const name of ["LC_ALL", "LC_CTYPE", "LANG"] as const) {
    const value = env[name];
    if (value !== undefined && value !== "") return value;
  }
  return undefined;
}

/**
 * Whether `locale` encodes UTF-8, judged by its name, never by whether the system has it installed.
 * Unset is UTF-8 (the default on macOS and the supported Linux). A name with a codeset is UTF-8 only
 * when that codeset is (`en_US.UTF-8`, `C.utf8`; not `en_US.ISO8859-1`). A name without one is not:
 * Ubuntu 24.04 gives `en_US`, `c` and `de_DE` the charmap `ANSI_X3.4-1968`, and macOS reports none —
 * except a bare `UTF-8`, macOS's `LC_CTYPE` spelling, which it maps to UTF-8 (measured). A
 * `@modifier` is ignored.
 *
 * @param locale - a locale name such as `en_US.UTF-8`, `C.UTF-8`, `UTF-8` or `C`.
 */
export function localeIsUtf8(locale: string | undefined): boolean {
  if (locale === undefined) return true;
  const name = locale.split("@", 1)[0] ?? "";
  // The codeset after the first dot; with no dot (`indexOf` gives -1) the whole name.
  return isUtf8Spelling(name.slice(name.indexOf(".") + 1));
}

/**
 * Whether `CI` is on: present and neither empty, `0` nor `false` (any case).
 *
 * @param env - the environment.
 */
export function isCi(env: Environment): boolean {
  const value = env.CI;
  return value !== undefined && value !== "" && !isOffValue(value);
}

/**
 * Whether `TERM` names a terminal that understands escape sequences: set, not empty, not `dumb`
 * (exactly: `TERM` is case-sensitive). Node, too, gives an unset `TERM` no colour.
 *
 * @param env - the environment.
 */
function termCanStyle(env: Environment): boolean {
  return env.TERM !== undefined && env.TERM !== "" && env.TERM !== "dumb";
}

/**
 * Whether `codeset` spells UTF-8: `UTF-8`, `utf8`, `UTF8` — every spelling glibc and macOS accept.
 *
 * @param codeset - a locale's codeset, or a whole codeset-less locale name.
 */
function isUtf8Spelling(codeset: string): boolean {
  return codeset.toLowerCase().replace("-", "") === "utf8";
}

/**
 * Whether `value` is `0` or `false`, in any case.
 *
 * @param value - a boolean-ish variable's value.
 */
function isOffValue(value: string): boolean {
  return OFF_VALUES.has(value.toLowerCase());
}

/**
 * Whether `value` is a finite integer above 0: a terminal size worth drawing in.
 *
 * @param value - a stream's `columns` or `rows`.
 */
function isPositiveInteger(value: number | undefined): boolean {
  return value !== undefined && Number.isInteger(value) && value > 0;
}
