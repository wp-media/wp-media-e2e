import { errorMessage } from "../guards";
import { execAsTransport } from "../wp/exec";
import type { ExecResult } from "../wp/exec";
import type { SshTransport } from "../config/types";
import type { CheckResult } from "./preflight";

/**
 * The SSH user's login shell must be POSIX: sshd hands it every command line the suite builds, quoted
 * for a POSIX shell. csh and tcsh expand `!` inside single quotes and refuse a quoted newline; fish
 * reads `\\` inside single quotes as one backslash. Either changes what a command receives, so a site
 * whose login shell does is failed by the pre-flight, before any command that writes.
 *
 * Proved by a round-trip, not by the shell's name: `printf '%s' <PROBE>` must print the probe byte
 * for byte. When the shell changed or refused it, `getent passwd` names the shell for the report.
 * Text a startup file prints around it fails too (it would be read as every command's output), but
 * is not blamed on the shell.
 */

/** The check's name in reports. */
export const LOGIN_SHELL_CHECK = "Login shell";

/**
 * What the round-trip sends: every character a non-POSIX shell reads differently inside single
 * quotes (`!`, a newline, `\\`), plus the ones POSIX quoting must keep literal (`$`, a backtick, both
 * quotes). Never ends in a newline (the exec layer strips one).
 */
export const LOGIN_SHELL_PROBE = "e2e!a\\\\b$HOME`id`'c\"d\ne~";

/** Login shells known to read a POSIX-quoted command line differently. */
const NON_POSIX_SHELLS: ReadonlySet<string> = new Set(["csh", "tcsh", "fish"]);

/**
 * The login shell in a `getent passwd` line (its seventh field).
 *
 * @param stdout - `getent passwd <user>`'s output.
 * @returns the shell's path, or `undefined` when the line has no seventh field.
 */
export function shellFromPasswd(stdout: string): string | undefined {
  const fields = (stdout.split("\n")[0] ?? "").replace(/\r$/, "").split(":");
  const shell = fields[6];
  return shell === undefined || shell === "" ? undefined : shell;
}

/**
 * Whether a shell path names a shell known not to be POSIX.
 *
 * @param shell - a path, e.g. `/usr/bin/tcsh`.
 */
export function isKnownNonPosix(shell: string): boolean {
  return NON_POSIX_SHELLS.has(shell.slice(shell.lastIndexOf("/") + 1));
}

/** A round-trip's outcome: its result, or the message of the error it threw. */
export type RoundTrip = ExecResult | { readonly error: string };

/**
 * What a round-trip says about the shell. Pure.
 *
 * - `unchanged`: the probe came back byte for byte.
 * - `stray-output`: the probe came back whole, with text `where` around it — a shell startup file
 *   prints on a non-interactive command, and every command's output would carry it.
 * - `changed`: the probe came back changed, or was refused — the shell reads POSIX quoting otherwise.
 * - `unchecked`: the round-trip threw (a dropped connection): nothing is known about the shell.
 */
export type RoundTripVerdict =
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "stray-output";
      readonly where: "before" | "after" | "around";
    }
  | { readonly kind: "changed"; readonly said: string }
  | { readonly kind: "unchecked"; readonly error: string };

/**
 * Judges a round-trip.
 *
 * @param outcome - the round-trip.
 */
export function judgeRoundTrip(outcome: RoundTrip): RoundTripVerdict {
  if ("error" in outcome) return { kind: "unchecked", error: outcome.error };
  if (outcome.exitCode !== 0) {
    return {
      kind: "changed",
      said: `a quoted test string was refused (exit ${String(outcome.exitCode)})`,
    };
  }
  const { stdout } = outcome;
  if (stdout === LOGIN_SHELL_PROBE) return { kind: "unchanged" };
  const at = stdout.indexOf(LOGIN_SHELL_PROBE);
  if (at === -1) {
    return { kind: "changed", said: "a quoted test string came back changed" };
  }
  const before = at > 0;
  const after = at + LOGIN_SHELL_PROBE.length < stdout.length;
  return {
    kind: "stray-output",
    where: before && after ? "around" : before ? "before" : "after",
  };
}

/**
 * The check for a round-trip. Pure. Every outcome but `unchanged` fails the site (a gate); only
 * `changed` blames the shell, naming it when `getent` did.
 *
 * @param outcome - the round-trip.
 * @param shell - the login shell `getent` named, when asked.
 * @returns the check.
 */
export function loginShellCheck(
  outcome: RoundTrip,
  shell?: string,
): CheckResult {
  const verdict = judgeRoundTrip(outcome);
  switch (verdict.kind) {
    case "unchanged":
      return {
        name: LOGIN_SHELL_CHECK,
        ok: true,
        detail: "Command lines reach programs unchanged (a POSIX login shell).",
      };
    case "unchecked":
      return {
        name: LOGIN_SHELL_CHECK,
        ok: false,
        detail: `The SSH user's login shell could not be checked: ${verdict.error}.`,
        hint: "The connection failed during this check; run again once the site answers.",
      };
    case "stray-output":
      return {
        name: LOGIN_SHELL_CHECK,
        ok: false,
        detail:
          `The SSH user's shell prints text ${verdict.where} each command's output (a shell ` +
          "startup file): commands reach programs unchanged, but their output is read with that text in it.",
        hint:
          "Make the SSH user's shell startup files (~/.bashrc, ~/.profile, …) print nothing when the\n" +
          'shell is not interactive, e.g. `[ -z "$PS1" ] && return` before any output in ~/.bashrc.',
      };
    case "changed": {
      const which =
        shell === undefined
          ? ""
          : ` The login shell is ${shell}${isKnownNonPosix(shell) ? ", which is not POSIX" : ""}.`;
      return {
        name: LOGIN_SHELL_CHECK,
        ok: false,
        detail: `The SSH user's login shell does not pass command lines through unchanged: ${verdict.said}.${which}`,
        hint:
          "sshd hands every command to the login shell, and the suite quotes them for a POSIX shell\n" +
          "(csh/tcsh expand `!` inside quotes, fish reads `\\\\` as `\\`). Make the SSH user's login shell\n" +
          "POSIX, e.g. `sudo chsh -s /bin/bash <ssh user>`.",
      };
    }
  }
}

/**
 * Runs the round-trip as the SSH user, from `/`, and when the shell changed or refused it asks
 * `getent` for the shell's name (best-effort: its own failure leaves the name out). A round-trip that
 * throws (the transport failed) is reported as unchecked, never blamed on the shell.
 *
 * @param transport - the site's ssh transport.
 * @returns the check; a gate.
 */
export async function checkLoginShell(
  transport: SshTransport,
): Promise<CheckResult> {
  let outcome: RoundTrip;
  try {
    outcome = await execAsTransport(
      transport,
      "printf",
      ["%s", LOGIN_SHELL_PROBE],
      { cwd: "/" },
    );
  } catch (error) {
    outcome = { error: errorMessage(error) };
  }
  // Only a shell that changed or refused the probe is worth naming.
  if (judgeRoundTrip(outcome).kind !== "changed") {
    return loginShellCheck(outcome);
  }
  let shell: string | undefined;
  try {
    const passwd = await execAsTransport(
      transport,
      "getent",
      ["passwd", transport.username],
      { cwd: "/" },
    );
    if (passwd.exitCode === 0) shell = shellFromPasswd(passwd.stdout);
  } catch {
    // Best-effort: the check already failed; the name only explains it.
  }
  return loginShellCheck(outcome, shell);
}
