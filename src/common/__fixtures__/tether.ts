import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

/**
 * For specs: a shell command that cannot outlive the process that started it. A spec's teardown
 * stops what it started, but a killed worker (SIGKILL, a crashed runner) runs no teardown, and a
 * plain child — a `php -S`, an ssh-server's command — is then left running under `init`.
 *
 * The command runs detached, in a process group of its own, beside a watchdog in that group that
 * blocks reading a pipe only this process writes to. When this process dies, the kernel closes the
 * pipe: the watchdog reads EOF, finds this process gone and SIGKILLs the whole group. Portable (no
 * `prctl`). Node also closes that pipe when the command exits; the watchdog then checks once a second
 * that this process lives, so what the command left in the background runs on — as behind a real
 * `sshd` — until {@link killTethered}, or until this process dies.
 */

/**
 * The wrapper: note this process's pid (`$PPID`), move the pipe to fd 3 (stdin becomes `/dev/null`),
 * start the watchdog on it with no stdout/stderr (a caller waiting for the command's output to close
 * never waits on it), close fd 3, then `exec` the command in place, so its pid stays the group's. `$1`
 * is the command, the rest its positional parameters (`$0` first). The watchdog also keeps the group's
 * id taken until the group is killed, so {@link killTethered} never signals a reused one. It calls
 * `/bin/sleep` (macOS, Ubuntu, BusyBox all have it), never `PATH`'s: a caller's `env` without one
 * would spin it at full CPU.
 */
const WRAPPER = [
  "script=$1; shift",
  "parent=$PPID",
  "exec 3<&0 </dev/null",
  '{ read -r _ <&3; while kill -0 "$parent"; do /bin/sleep 1; done; kill -9 0; } >/dev/null 2>&1 &',
  "exec 3<&-",
  'exec /bin/sh -c "$script" "$@"',
].join("\n");

/** {@link spawnTethered}'s options: `spawn`'s, less what it decides itself. */
export type TetheredOptions = Omit<SpawnOptions, "detached" | "stdio"> & {
  /** stdout and stderr: `"pipe"` or `"ignore"` (the default). */
  readonly output?: "pipe" | "ignore";
};

/**
 * Starts `/bin/sh -c <script> <args…>` tethered to this process: SIGKILLed with its whole group as
 * soon as this process ends, however it ends. Its stdin is `/dev/null`. Stop it early with
 * {@link killTethered}.
 *
 * @param script - the shell command.
 * @param args - its positional parameters, `$0` first (as `sh -c` takes them).
 * @param options - `cwd`, `env`, and whether to pipe its output.
 * @returns the child: its pid is its process group's.
 *
 * @example
 * ```ts
 * const php = spawnTethered('exec php -S "$0" -t "$1"', [address, root]);
 * try { … } finally { killTethered(php); }
 * ```
 */
export function spawnTethered(
  script: string,
  args: readonly string[] = [],
  options: TetheredOptions = {},
): ChildProcess {
  const { output = "ignore", ...rest } = options;
  const child = spawn("/bin/sh", ["-c", WRAPPER, "tether", script, ...args], {
    ...rest,
    detached: true,
    stdio: ["pipe", output, output],
  });
  // Nothing is ever written: the pipe only signals this process's end. An EPIPE once the group is
  // gone must not surface as an unhandled error.
  child.stdin?.on("error", () => undefined);
  return child;
}

/**
 * SIGKILLs a tethered command's whole group — the command, anything it left in the background, its
 * watchdog — ignoring a group already gone.
 *
 * @param child - what {@link spawnTethered} returned.
 */
export function killTethered(child: ChildProcess): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Already gone: nothing to kill.
  }
}
