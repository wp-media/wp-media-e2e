import { posix } from "node:path";

import { withoutSudoNoise } from "./sudo-noise";

/**
 * The command line that runs one program as a site's identity: `sudo` to the user and group, then a
 * constant `/bin/sh` wrapper that sets the umask and enters the working directory before `exec`ing the
 * program. Pure and dependency-free, so the exec layer and the identity probe build the same argv.
 *
 * Why a wrapper: `sudo -u` hands the command a umask of its own (`pam_umask` gives `0002` whatever the
 * caller's), keeps the caller's working directory, which the SSH user may not be allowed to enter, and
 * takes no `cd`. The script is a constant: the umask, the directory and the command travel only as
 * positional arguments, so no value is ever read by a shell.
 */

/**
 * The wrapper `sudo` runs: `$0` is {@link RUN_AS_NAME}, `$1` the umask, `$2` the working directory,
 * the rest the command. `&&` throughout, so a umask or directory that fails runs nothing; `exec`, so
 * the exit status and a killing signal are the program's own.
 */
export const RUN_AS_SCRIPT = 'umask "$1" && cd -- "$2" && shift 2 && exec "$@"';

/**
 * The wrapper's `$0`: the shell prefixes its own errors with it (dash: `e2e-run-as: 1: cd: can't cd
 * to …`), so a failure names the wrapper, never a value.
 */
export const RUN_AS_NAME = "e2e-run-as";

/** Who `sudo` is asked to run as: each half a name, or a numeric id given as digits. */
export interface SudoTarget {
  readonly user: string;
  readonly group: string;
}

/** Four octal digits, as `effectiveUmask` stores a umask. */
const UMASK = /^[0-7]{4}$/;

/**
 * One half of a {@link SudoTarget} as `sudo -u`/`-g` reads it: a numeric id prefixed `#`, since a bare
 * number names an account called that, not the id.
 *
 * @param name - a user or group name, or an id as digits.
 * @returns the name unchanged, or `#<id>`.
 * @throws Error for an empty name, one starting with `-` or `#` (sudo would read an option or an
 * id), or one holding a `:` or a control character, which no account name holds. A space is kept:
 * a directory-joined host has groups like `domain users`.
 */
export function sudoName(name: string): string {
  if (!isSudoName(name)) {
    throw new Error(
      `[wp/run-as] refusing to ask sudo for an account named by a text of ` +
        `${String(Array.from(name).length)} characters: not a user or group name, nor a numeric id.`,
    );
  }
  return /^\d+$/.test(name) ? `#${name}` : name;
}

/**
 * Whether `sudo -u`/`-g` can be given this name (see {@link sudoName}).
 *
 * @param name - a user or group name, or an id as digits.
 */
export function isSudoName(name: string): boolean {
  // `\p{Cc}` instead of a control-character range, which the lint forbids in a pattern.
  return name !== "" && !/^[-#]/.test(name) && !/[:\p{Cc}]/u.test(name);
}

/**
 * The full argv (from `sudo` on) that runs `file args…` as `target`, with `umask`, in `cwd`.
 *
 * @param target - who to run as.
 * @param umask - four octal digits (`"0022"`).
 * @param cwd - the absolute directory to run in, entered by the identity (the caller's own directory
 * is never used, so the caller needs no access to it).
 * @param file - the program, found on sudo's `secure_path`.
 * @param args - its arguments.
 * @returns `["sudo", "-n", "-u", …, "--", "/bin/sh", "-c", RUN_AS_SCRIPT, RUN_AS_NAME, umask, cwd, file,
 * ...args]`.
 * @throws Error naming what is wrong, never an argument: a bad target ({@link sudoName}), a umask not
 * of four octal digits, a `cwd` that is not absolute (`cd` would resolve it from the identity's home),
 * or a program starting with `-` (dash's `exec` would read an option).
 * @example
 * ```ts
 * runAsArgv({ user: "www-data", group: "www-data" }, "0022", "/var/www/html", "wp", ["--info"]);
 * // ["sudo", "-n", "-u", "www-data", "-g", "www-data", "--", "/bin/sh", "-c", RUN_AS_SCRIPT,
 * //  "e2e-run-as", "0022", "/var/www/html", "wp", "--info"]
 * ```
 */
export function runAsArgv(
  target: SudoTarget,
  umask: string,
  cwd: string,
  file: string,
  args: readonly string[],
): string[] {
  const user = sudoName(target.user);
  const group = sudoName(target.group);
  if (!UMASK.test(umask)) {
    throw new Error(
      `[wp/run-as] refusing to run "${file}" as the site: the umask is not four octal digits.`,
    );
  }
  if (!posix.isAbsolute(cwd)) {
    throw new Error(
      `[wp/run-as] refusing to run "${file}" as the site: its working directory is not an absolute path.`,
    );
  }
  if (file.startsWith("-")) {
    throw new Error(
      `[wp/run-as] refusing to run "${file}" as the site: a program name beginning with "-" would be ` +
        "read as an option to the shell's `exec`.",
    );
  }
  return [
    "sudo",
    "-n",
    "-u",
    user,
    "-g",
    group,
    "--",
    "/bin/sh",
    "-c",
    RUN_AS_SCRIPT,
    RUN_AS_NAME,
    umask,
    cwd,
    file,
    ...args,
  ];
}

/**
 * sudo's explicit-deny message (a rule like `ALL, !/bin/sh`): `Sorry, user <u> is not allowed to
 * execute '<command and its arguments>' as <user>:<group> on <host>.`, with no `sudo:` prefix (some
 * versions add one and lower-case it). It quotes the whole command, a `--key=` value included, and
 * runs on over as many lines as the arguments hold newlines — so it is matched over the rest of
 * stderr, never line by line, and never quoted to anyone.
 */
const NOT_ALLOWED =
  /^(?:sudo: )?[Ss]orry, user [^\n]*? is not allowed to execute '[\s\S]*' as [^\n]* on [^\n]*\.$/;

/** The opening of a {@link NOT_ALLOWED} message, on any line: whether some text quotes one. */
const NOT_ALLOWED_START =
  /^(?:sudo: )?[Ss]orry, user .*? is not allowed to execute /m;

/**
 * Whether `stderr` carries sudo's explicit-deny message (`Sorry, user … is not allowed to execute
 * '<command>' …`), which quotes the command's arguments: a caller must name it, never print it.
 *
 * @param stderr - a command's stderr, run through `sudo`.
 */
export function quotesSudoDenial(stderr: string): boolean {
  return NOT_ALLOWED_START.test(stderr);
}

/**
 * Whether `stderr`, sudo's noise removed, is wholly sudo's own refusal: one or more `sudo:` lines,
 * and/or sudo's explicit-deny message running to the end ({@link NOT_ALLOWED}).
 *
 * @param stderr - a command's stderr, run through `sudo`.
 */
export function isSudoRefusalText(stderr: string): boolean {
  const lines = withoutSudoNoise(stderr)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim() !== "");
  for (const [i, line] of lines.entries()) {
    // The deny message quotes the arguments, newlines included: it runs to the end of stderr.
    if (
      NOT_ALLOWED_START.test(line) &&
      NOT_ALLOWED.test(lines.slice(i).join("\n"))
    ) {
      return true;
    }
    if (!line.startsWith("sudo: ")) return false;
  }
  return lines.length > 0;
}

/**
 * Whether a command run through {@link runAsArgv} was refused by `sudo` itself, never reaching the
 * program: exit 1 and stderr wholly sudo's ({@link isSudoRefusalText}: `a password is required`,
 * `unknown user …`, `Sorry, user … is not allowed to execute …`). The wrapper's own failures name
 * `e2e-run-as`, and a program's exit 1 with its own words is the program's.
 *
 * @param result - the command's exit code and stderr.
 */
export function isSudoRefusal(result: {
  readonly exitCode: number;
  readonly stderr: string;
}): boolean {
  return result.exitCode === 1 && isSudoRefusalText(result.stderr);
}
