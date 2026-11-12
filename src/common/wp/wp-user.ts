import { stripVTControlCharacters } from "node:util";

import { isObject } from "../guards";
import { phpLiteral } from "./php-literal";
import { describeTarget, installKey } from "./transport-exec";
import type { ExecResult } from "./transport-exec";
import type { IdentityState } from "./site-identity";
import type { Transport } from "../config/types";

/**
 * WP-CLI's `--user=<login>`: `wpCli` (`./exec.ts`) runs WordPress as the site's administrator, the
 * login the browser uses (`transport.wpUser`, the site's `username`), so capability checks and
 * "current user" code see what an admin request sees.
 *
 * Before the first use per install, one **check** (no `--user` on it, plugins and theme skipped) runs
 * WP-CLI's own lookup — `WP_CLI\Fetchers\User::get_check`, exactly what `--user` runs — so whoever it
 * finds is the user `--user` will act as (ID if numeric, email if email-shaped then login, else
 * login; the database's collation decides equality: `ADMIN` and `Admín` both name `admin`).
 * `--user` is dropped for that install, warned once, when:
 * - the login names nobody (WP-CLI's exact error, below);
 * - the login is numeric (PHP's `is_numeric`): WP-CLI reads it as a user ID, which names another
 *   user, or the same one with a warning quoting the login on every call;
 * - the user found cannot `manage_options`.
 *
 * Any other answer (WordPress not booting yet, a non-zero exit, output without the check's line) is
 * **unknown**: that call and every call for {@link RECHECK_AFTER_MS} run without `--user`, then the
 * next one checks again. A transport failure is thrown, nothing kept.
 *
 * A login removed mid-process (a database reset or restore) makes a `--user` call fail with that
 * exact error before the command runs: `wpCli` retries the call once without `--user`, and
 * {@link forgetWpUser} makes the verdict unknown, so the login is checked again once the wait is over
 * (a restore may put it back). WP-CLI's lines are matched with terminal escapes removed: `color: true`
 * in its config colours `Error:`.
 *
 * The login is never printed: WP-CLI's error quotes it, so that output is discarded, and every
 * message says "the site's WordPress login". Verdicts are memoised per install, login and **who runs
 * commands** (the identity state's uid/gid, or the transport's user), so a copy running as another
 * identity never reads this one's. No import of `./exec.ts`: the caller hands the check's runner in.
 */

/** Why `--user` is dropped for an install. */
export type WpUserDropReason = "missing" | "numeric" | "not-admin" | "removed";

/** What one check concluded; only `use` and `drop` are kept. */
export type WpUserCheck =
  | { readonly kind: "use" }
  | {
      readonly kind: "drop";
      readonly reason: Exclude<WpUserDropReason, "removed">;
    }
  | { readonly kind: "unknown" };

/** A clock in milliseconds (`Date.now` outside specs). */
export type Clock = () => number;

/**
 * How long an unknown answer, or a mid-process refusal, stands before the login is checked again: a
 * site that does not boot then costs one extra boot per half minute, not one per call.
 */
export const RECHECK_AFTER_MS = 30_000;

/** Starts the check's one line of output, so it is told from anything WordPress printed before it. */
const CHECK_MARK = "e2e-wp-user:";

/**
 * WP-CLI's answers when the login names nobody (`Fetchers\User`'s two messages; the second only under
 * `WP_CLI_FORCE_USER_LOGIN`), each followed by the login in single quotes.
 */
const UNKNOWN_USER_MESSAGES = [
  "Error: Invalid user ID, email or login: ",
  "Error: Invalid user login: ",
] as const;

/** Each drop reason in words, and its fix. Never the login. */
const DROP_MESSAGES: Readonly<Record<WpUserDropReason, string>> = {
  missing:
    "the site's WordPress login names no user here; WP-CLI runs without --user (no logged-in user). " +
    "Fix: set the site's `username` to an administrator's login.",
  numeric:
    "the site's WordPress login is numeric, which WP-CLI reads as a user ID; WP-CLI runs without " +
    "--user. Fix: use that administrator's email as the site's `username`.",
  "not-admin":
    "the site's WordPress login is not an administrator (cannot manage_options); WP-CLI runs " +
    "without --user. Fix: set the site's `username` to an administrator's login.",
  removed:
    "the site's WordPress login no longer names a user (a database reset or restore?); the call " +
    "ran again without --user, and calls run without it until the login is checked again, " +
    `${String(RECHECK_AFTER_MS / 1000)} s later.`,
};

/**
 * Why `--user` is dropped, in words with its fix, for a report. Never the login.
 *
 * @param reason - the reason.
 */
export function describeWpUserDrop(reason: WpUserDropReason): string {
  return DROP_MESSAGES[reason];
}

/**
 * `args` with `--user=<login>` in front (WP-CLI reads global parameters anywhere before a snippet).
 *
 * @param login - the site's WordPress login.
 * @param args - WP-CLI's arguments.
 */
export function withWpUser(login: string, args: readonly string[]): string[] {
  return [`--user=${login}`, ...args];
}

/**
 * The check's WP-CLI arguments: a `wp eval` with plugins and theme skipped (their output or a broken
 * one would hide the answer), the login embedded through {@link phpLiteral}. The marked line starts
 * with a newline, so output WordPress left unterminated never shares it.
 *
 * @param login - the site's WordPress login.
 */
export function wpUserCheckArgs(login: string): string[] {
  const php =
    `$e2e_login = ${phpLiteral(login)};\n` +
    `$e2e_user = ( new \\WP_CLI\\Fetchers\\User() )->get_check( $e2e_login );\n` +
    `echo "\\n${CHECK_MARK}", wp_json_encode( array( ` +
    `'numeric' => is_numeric( $e2e_login ), ` +
    `'admin' => user_can( $e2e_user, 'manage_options' ) ) ), "\\n";`;
  return ["--skip-plugins", "--skip-themes", "eval", php];
}

/**
 * Whether WP-CLI refused `login` as naming nobody: exit 1 and, on a line of its own, its exact error
 * quoting that login (a command's own error about another user quotes another). Terminal escapes
 * are removed from both first, so a coloured `Error:` is the same refusal.
 *
 * @param result - the command's outcome.
 * @param login - the login `--user` (or the check) gave.
 */
export function isUnknownUserError(result: ExecResult, login: string): boolean {
  if (result.exitCode !== 1) return false;
  // Whole lines, compared as text: a login may hold anything a regex or a line split would misread.
  const text = `\n${stripVTControlCharacters(result.stderr).replace(/\r\n/g, "\n")}\n`;
  const quoted = `'${stripVTControlCharacters(login)}'\n`;
  return UNKNOWN_USER_MESSAGES.some((message) =>
    text.includes(`\n${message}${quoted}`),
  );
}

/**
 * The check's verdict.
 *
 * @param result - the check's outcome ({@link wpUserCheckArgs}).
 * @param login - the login it checked.
 */
export function classifyWpUserCheck(
  result: ExecResult,
  login: string,
): WpUserCheck {
  if (result.exitCode !== 0) {
    return isUnknownUserError(result, login)
      ? { kind: "drop", reason: "missing" }
      : { kind: "unknown" };
  }
  const found = checkedUser(result.stdout);
  if (found === undefined) return { kind: "unknown" };
  if (found.numeric) return { kind: "drop", reason: "numeric" };
  return found.admin ? { kind: "use" } : { kind: "drop", reason: "not-admin" };
}

/**
 * What the check's last marked line reports, terminal escapes removed.
 *
 * @param stdout - the check's standard output.
 * @returns whether PHP read the login as numeric and whether the user found is an administrator, or
 * `undefined` without a well-formed line.
 */
function checkedUser(
  stdout: string,
): { readonly numeric: boolean; readonly admin: boolean } | undefined {
  const line = stripVTControlCharacters(stdout)
    .split(/\r?\n/)
    .reverse()
    .find((candidate) => candidate.startsWith(CHECK_MARK));
  if (line === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line.slice(CHECK_MARK.length));
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.numeric !== "boolean" ||
    typeof parsed.admin !== "boolean"
  ) {
    return undefined;
  }
  return { numeric: parsed.numeric, admin: parsed.admin };
}

// ── Memoised per install, login and runner ───────────────────────────────────────────────────────

/** Settled or in-flight checks per {@link wpUserKey}: `true` adds `--user`. Unknown ones are removed. */
const checks = new Map<string, Promise<boolean>>();

/**
 * Per key whose last answer was unknown (or refused mid-process): when the login may be checked
 * again. Read only while no verdict is kept, so a stale entry is harmless.
 */
const recheckAt = new Map<string, number>();

/** Warnings already printed, per key and reason. */
const warned = new Set<string>();

/**
 * The cache key: the install, who runs commands there, and the login.
 *
 * @param transport - the site's transport.
 * @param state - its resolved identity state.
 * @param login - the site's WordPress login.
 */
export function wpUserKey(
  transport: Transport,
  state: IdentityState,
  login: string,
): string {
  const runner =
    state.kind === "site"
      ? `site:${String(state.identity.uid)}:${String(state.identity.gid)}`
      : "transport";
  return `${installKey(transport)}\u0000${runner}\u0000${login}`;
}

/**
 * Whether `wpCli` adds `--user` on this install: the memoised verdict; else `false` while an unknown
 * answer stands; else one check (concurrent callers share it).
 *
 * @param transport - the site's transport, for the warning.
 * @param key - {@link wpUserKey}'s.
 * @param login - the site's WordPress login.
 * @param runCheck - runs `wp` with {@link wpUserCheckArgs}, never with `--user`.
 * @param now - the clock.
 * @returns `true` to add `--user`.
 * @throws Error from `runCheck` (the transport failed); nothing is kept.
 */
export function shouldUseWpUser(
  transport: Transport,
  key: string,
  login: string,
  runCheck: () => Promise<ExecResult>,
  now: Clock = Date.now,
): Promise<boolean> {
  const cached = checks.get(key);
  if (cached !== undefined) return cached;
  const waitUntil = recheckAt.get(key);
  if (waitUntil !== undefined && now() < waitUntil) {
    return Promise.resolve(false);
  }
  const check = runCheck().then((result) => {
    const verdict = classifyWpUserCheck(result, login);
    if (verdict.kind === "unknown") {
      forget(key, check);
      recheckAt.set(key, now() + RECHECK_AFTER_MS);
      return false;
    }
    if (verdict.kind === "drop") warnOnce(transport, key, verdict.reason);
    return verdict.kind === "use";
  });
  checks.set(key, check);
  check.catch(() => {
    forget(key, check);
  });
  return check;
}

/**
 * Makes the install's verdict unknown once WP-CLI refused the login mid-process: calls run without
 * `--user` for {@link RECHECK_AFTER_MS}, then the login is checked again. Warned once.
 *
 * @param transport - the site's transport, for the warning.
 * @param key - {@link wpUserKey}'s.
 * @param now - the clock.
 */
export function forgetWpUser(
  transport: Transport,
  key: string,
  now: Clock = Date.now,
): void {
  checks.delete(key);
  recheckAt.set(key, now() + RECHECK_AFTER_MS);
  warnOnce(transport, key, "removed");
}

/** Forgets every verdict, wait and warning. For specs. */
export function resetWpUserCaches(): void {
  checks.clear();
  recheckAt.clear();
  warned.clear();
}

/**
 * Removes `check` from the cache, unless a newer check or verdict replaced it.
 *
 * @param key - its key.
 * @param check - the check to forget.
 */
function forget(key: string, check: Promise<boolean>): void {
  if (checks.get(key) === check) checks.delete(key);
}

/**
 * Prints a drop's warning once per key and reason.
 *
 * @param transport - the site's transport.
 * @param key - {@link wpUserKey}'s.
 * @param reason - why `--user` is dropped.
 */
function warnOnce(
  transport: Transport,
  key: string,
  reason: WpUserDropReason,
): void {
  const seen = `${key}\u0000${reason}`;
  if (warned.has(seen)) return;
  warned.add(seen);
  console.warn(
    `[wp/wp-user] ${describeTarget(transport)}: ${DROP_MESSAGES[reason]}`,
  );
}
