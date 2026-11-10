import { CommandKilledError } from "./errors";
import { elevationSupport, exec, execElevated, wpCli } from "./exec";
import type { ExecResult } from "./exec";
import type { Transport } from "../config/types";

/**
 * `wp-content/debug.log` access + scanning, transport-agnostic.
 *
 * Reads/clears via WP-CLI `wp eval` (PHP run inside WordPress), which resolves `WP_CONTENT_DIR`
 * itself — even when customised. But `wp eval` needs WordPress to BOOT, and the log matters most
 * precisely when a fatal has broken that boot. So when `wp eval` exits non-zero — or PHP crashed
 * under it, killed by a signal ({@link CommandKilledError}) — we log and fall
 * back to a direct file read/removal that does NOT load WordPress, targeting the conventional
 * `wp-content/debug.log` relative to the WP root — the same working directory the exec layer
 * already runs `wp` in (the container WORKDIR for `docker`, `rootDir` for `ssh`/`local`). A
 * genuinely unreachable transport still throws (the direct call can't run either), so a broken
 * environment is never mistaken for a clean log.
 *
 * **`wp eval` exits 0 even when the PHP inside it failed**, which makes its exit code useless on
 * its own: a denied `file_get_contents` returns `false` and a denied write returns `false`, both
 * with nothing worse than a warning, and the command still reports success. That is not
 * hypothetical — the log is written by the web-server user, and whoever WP-CLI runs as often
 * cannot write to it. So each snippet below reports its **own** outcome, and this module trusts
 * that rather than the exit status. Getting it wrong is silent in the worst way: a log that never
 * clears makes one scenario's fatal fail every later scenario, and a read that quietly yields ""
 * turns the fatal gate into a no-op.
 *
 * Typical use: `clearDebugLog` in a Before hook to scope a scenario, then `scanDebugLog` in a
 * tag-scoped After hook — attaching `raw`, failing on `fatals`, and logging `warnings`/`notices`.
 */

// Run inside WP via `wp eval`; WP_CONTENT_DIR is resolved by WordPress itself.

/**
 * How every snippet here boots WordPress: **no plugin, no theme**. Reading or removing a file needs
 * neither, and `WP_CONTENT_DIR` comes from `wp-config.php`, which loads either way. A plugin that
 * cannot boot — a half-removed copy of the one under test — would otherwise kill the read on its
 * fatal and, through `WP_DEBUG_LOG`, write that fatal into the very log being judged (measured on a
 * cell), blaming the scenario for the read itself.
 */
const BOOT_BARE = ["--skip-plugins", "--skip-themes", "eval"] as const;

/** What {@link CLEAR_DEBUG_LOG} prints when the log is genuinely gone. */
const CLEARED = "cleared";

// An absent log is legitimately empty; an unreadable one exits non-zero so the caller falls back
// instead of mistaking "cannot read" for "no errors were logged".
const READ_DEBUG_LOG =
  '$f = WP_CONTENT_DIR . "/debug.log";' +
  "if (file_exists($f)) {" +
  "$c = @file_get_contents($f);" +
  'if ($c === false) { fwrite(STDERR, "debug.log exists but could not be read"); exit(1); }' +
  "echo $c; }";

/**
 * Cleared by **removing** the file, not by truncating it: emptying it needs write permission on
 * the file, which belongs to the web-server user, whereas unlinking needs it on the containing
 * directory — which the transport's user usually does have. WordPress recreates the log on its
 * next write either way.
 */
const CLEAR_DEBUG_LOG =
  '$f = WP_CONTENT_DIR . "/debug.log";' +
  "if (file_exists($f)) { @unlink($f); }" +
  `echo file_exists($f) ? "kept" : "${CLEARED}";`;

// Fallback target when `wp eval` can't run: the default location, relative to the WP root.
const DEBUG_LOG_PATH = "wp-content/debug.log";

// PHP error severity tiers, matched against individual lines of debug.log.
// A line may match only one tier in practice (the prefixes are mutually exclusive), but each
// tier is checked independently so no line is silently dropped or double-counted.

/** Stop-or-throw level: fatal, parse, recoverable fatal, DB errors, uncaught exceptions. */
const FATAL_PATTERNS: readonly RegExp[] = [
  /PHP Fatal error/i,
  /PHP Parse error/i,
  /PHP Recoverable fatal error/i,
  /WordPress database error/i,
  /Uncaught (Error|Exception|TypeError)/i,
];

/** Non-fatal but suspicious: execution continues, something is likely wrong. */
const WARNING_PATTERNS: readonly RegExp[] = [/PHP Warning/i];

/** Informational: deprecated usage, strict-standards violations, notices. */
const NOTICE_PATTERNS: readonly RegExp[] = [
  /PHP Notice/i,
  /PHP Deprecated/i,
  /PHP Strict Standards/i,
];

/**
 * How a `wp eval` that could not do the job ended: its run, or the signal that killed it.
 */
type EvalOutcome = ExecResult | CommandKilledError;

/**
 * Runs one of this module's snippets through a bare WordPress ({@link BOOT_BARE}).
 *
 * A `wp` killed by a signal — PHP segfaulting, the kernel's OOM kill — is returned rather than
 * thrown: a crashed WordPress is a reason to reach the log directly, exactly as a fatal is. Any other
 * throw means the transport itself failed, which the direct route could not survive either, so it
 * stays a throw.
 *
 * @param transport - the site.
 * @param snippet - the PHP to evaluate.
 * @returns the run, or the {@link CommandKilledError} that ended it.
 */
async function evalBare(
  transport: Transport,
  snippet: string,
): Promise<EvalOutcome> {
  try {
    return await wpCli(transport, [...BOOT_BARE, snippet]);
  } catch (error) {
    if (error instanceof CommandKilledError) return error;
    throw error;
  }
}

/**
 * Notes that the WP-CLI path failed and the direct file fallback is being used.
 *
 * @param action - what `wp eval` could not do.
 * @param outcome - how it ended: its exit code and what it said, or the signal that killed it.
 * @param said - the stream to quote from a run that exited.
 */
function warnFallback(
  action: "read" | "clear",
  outcome: EvalOutcome,
  said: string,
): void {
  const why =
    outcome instanceof CommandKilledError
      ? `killed by ${outcome.signal}`
      : `exit ${String(outcome.exitCode)}: ${said.trim() || "no stderr"}`;
  console.warn(
    `[wp/log] \`wp eval\` could not ${action} debug.log (${why}); ` +
      `falling back to a direct file ${action === "read" ? "read" : "removal"}.`,
  );
}

/**
 * Runs `file args…` as the transport's user, retrying with privileges if that failed.
 *
 * For commands where a non-zero exit means "denied" rather than a legitimate answer — reading the
 * log, not testing for it. The log belongs to the web-server user, so being refused is the expected
 * case on a real host, not an exceptional one.
 */
async function execEscalating(
  transport: Transport,
  file: string,
  args: string[],
): Promise<ExecResult> {
  const first = await exec(transport, file, args);
  if (first.exitCode === 0) return first;
  if ((await elevationSupport(transport)) !== "available") return first;
  return execElevated(transport, file, args);
}

/**
 * Whether the log is still on disk, asked at the **same privilege** as the removal it follows: a
 * `test -e` the transport's user is not allowed to answer would report a log it cannot see as gone,
 * which is the one wrong answer that matters here.
 */
async function debugLogExists(
  transport: Transport,
  elevated: boolean,
): Promise<boolean> {
  const run = elevated ? execElevated : exec;
  const { exitCode } = await run(transport, "test", ["-e", DEBUG_LOG_PATH]);
  return exitCode === 0;
}

/**
 * Reads `wp-content/debug.log`. Returns `""` when the log does not exist — which is a real answer,
 * distinct from a log that exists and could not be read: that exits non-zero and falls back to
 * `cat`, because reporting it as empty would quietly turn the fatal gate off.
 *
 * The `cat` escalates if the log's own permissions refuse it, since a log nobody can read is exactly
 * the case where "" is the dangerous answer. If every route is refused, that is said out loud rather
 * than returned as silence.
 */
export async function readDebugLog(transport: Transport): Promise<string> {
  const viaCli = await evalBare(transport, READ_DEBUG_LOG);
  if (!(viaCli instanceof CommandKilledError) && viaCli.exitCode === 0) {
    return viaCli.stdout;
  }
  warnFallback(
    "read",
    viaCli,
    viaCli instanceof CommandKilledError ? "" : viaCli.stderr,
  );
  // Direct read — no WordPress bootstrap.
  const direct = await execEscalating(transport, "cat", [DEBUG_LOG_PATH]);
  if (direct.exitCode === 0) return direct.stdout;

  // Absent ⇒ nothing has been logged, so "" is the truth. Present-but-unreadable is not: it would
  // turn the fatal gate into a no-op, so it is reported instead of passing silently.
  if (await debugLogExists(transport, false)) {
    console.warn(
      "[wp/log] debug.log exists but could not be read by any route — through WordPress, directly, " +
        "or with elevated privileges. It is being treated as empty, which means PHP fatals recorded " +
        "in it CANNOT fail a scenario until the site's permissions are fixed.",
    );
  }
  return "";
}

/**
 * Clears `wp-content/debug.log` (use in a Before hook to scope errors to one scenario).
 *
 * Success is the snippet's own verdict, not WP-CLI's exit code — see this module's header. A log
 * that silently refuses to clear would attribute one scenario's fatal to every scenario after it,
 * so this fails loudly instead.
 *
 * @param transport - the site to clear.
 * @throws {@link Error} if the log is still there after both attempts.
 */
export async function clearDebugLog(transport: Transport): Promise<void> {
  const viaCli = await evalBare(transport, CLEAR_DEBUG_LOG);
  if (
    !(viaCli instanceof CommandKilledError) &&
    viaCli.exitCode === 0 &&
    viaCli.stdout.trim().endsWith(CLEARED)
  ) {
    return;
  }
  warnFallback(
    "clear",
    viaCli,
    viaCli instanceof CommandKilledError ? "" : viaCli.stderr || viaCli.stdout,
  );
  // Direct removal — no WordPress bootstrap; WordPress recreates the log on its next write.
  // `rm -f` is a no-op when the file is already absent and is portable (Linux, macOS, BusyBox).
  await exec(transport, "rm", ["-f", DEBUG_LOG_PATH]);
  // Confirmed rather than inferred, for the same reason the exit code above is not trusted.
  if (!(await debugLogExists(transport, false))) return;

  // Unlinking it needs write access to the *directory*, which the transport's user may not have on
  // a real host. Escalate rather than let one scenario's fatals be blamed on every scenario after it.
  const elevation = await elevationSupport(transport);
  if (elevation === "available") {
    await execElevated(transport, "rm", ["-f", DEBUG_LOG_PATH]);
    if (!(await debugLogExists(transport, true))) return;
  }

  throw new Error(
    "[wp/log] debug.log could not be cleared, via `wp eval`, a direct `rm`" +
      `${elevation === "available" ? ", or an elevated one" : ` (elevation: ${elevation})`}. It is ` +
      "usually owned by the web-server user; removing it needs write access to the directory " +
      "holding it. Leaving it would make one scenario's fatals fail every later scenario.",
  );
}

/** Options for {@link scanDebugLog}. */
export interface ScanDebugLogOptions {
  /** Lines matching any of these are excluded from all categories (known-benign noise). */
  readonly ignore?: readonly RegExp[];
  /**
   * Restrict categorisation to lines matching at least one of these patterns — typically a
   * plugin's path (e.g. `/wp-content\/plugins\/wp-rocket\//`), so a scan attributes entries to
   * that plugin. WordPress writes the originating file path on the same line as the PHP
   * severity prefix, so a path pattern keeps only that plugin's fatals/warnings/notices.
   * Omit to categorise every line (the default — catches errors from any source).
   */
  readonly source?: readonly RegExp[];
}

/** The outcome of scanning `debug.log`, broken down by PHP severity tier. */
export interface DebugLogScan {
  /** The full log contents (may be empty). */
  readonly raw: string;
  /** Fatal errors, parse errors, recoverable fatals, DB errors, uncaught exceptions. */
  readonly fatals: string[];
  /** PHP Warnings — non-fatal but suspicious. */
  readonly warnings: string[];
  /** PHP Notices, Deprecations, Strict Standards — informational. */
  readonly notices: string[];
}

/**
 * Reads `debug.log` and categorises each line by PHP severity tier. Lines matching an `ignore`
 * pattern are dropped; if `source` is set, only lines matching it are categorised. `raw` always
 * holds the complete log (for report attachment), regardless of `source`.
 */
export async function scanDebugLog(
  transport: Transport,
  options: ScanDebugLogOptions = {},
): Promise<DebugLogScan> {
  const raw = await readDebugLog(transport);
  const ignore = options.ignore ?? [];
  const source = options.source ?? [];

  const lines = raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .filter((line) => !ignore.some((p) => p.test(line)))
    .filter((line) => source.length === 0 || source.some((p) => p.test(line)));

  const match = (patterns: readonly RegExp[]): string[] =>
    lines.filter((line) => patterns.some((p) => p.test(line)));

  return {
    raw,
    fatals: match(FATAL_PATTERNS),
    warnings: match(WARNING_PATTERNS),
    notices: match(NOTICE_PATTERNS),
  };
}
