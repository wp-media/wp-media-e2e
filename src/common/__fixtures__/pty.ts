import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * For specs: run a command on a **real** pseudo-terminal through `script` — BSD `script` on macOS,
 * util-linux's on Linux (which takes `-qec`) — or to its end with piped output. Both give a pty 0
 * columns and 0 rows when their own input is no terminal, until `stty` sizes it (measured). A
 * hand-built `{ isTTY: true }` stream is no stand-in: Node's `styleText` refuses it or takes another
 * branch, so what a program does on a terminal is only measured this way.
 */

/** How long a timed-out child gets between SIGTERM and SIGKILL. */
const KILL_GRACE_MS = 2_000;

/**
 * `value` as one single-quoted POSIX shell word.
 *
 * @param value - any text.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * The executable `name` on `PATH`, or `undefined`.
 *
 * @param name - the program's name.
 */
export function findOnPath(name: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/**
 * The argv running `command` (a shell line) on a pty: BSD `script` on macOS, util-linux's on Linux;
 * `undefined` elsewhere.
 *
 * @param script - the `script` executable.
 * @param command - the shell line to run on the pty.
 */
export function scriptArgv(
  script: string,
  command: string,
): readonly string[] | undefined {
  if (process.platform === "darwin")
    return [script, "-q", "/dev/null", "/bin/sh", "-c", command];
  if (process.platform === "linux")
    return [script, "-qec", command, "/dev/null"];
  return undefined;
}

/** The `script` to run commands on a pty with, or why there is none. */
export type PtyRunner =
  { readonly script: string } | { readonly missing: string };

/**
 * The `script` on `PATH`, when this module knows its arguments on this platform.
 *
 * @returns the runner, or a message naming what is missing.
 */
export function ptyRunner(): PtyRunner {
  const script = findOnPath("script");
  if (script !== undefined && scriptArgv(script, "true") !== undefined)
    return { script };
  return {
    missing: `needs util-linux or BSD \`script\` on PATH (macOS or Linux); found ${script ?? "none"} on ${process.platform}`,
  };
}

/** What a finished child wrote. */
export interface ChildOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `file` to its end within `limitMs`. Standard input is `/dev/null`: `script` refuses a socket
 * there (`execFile` gives it one), and a terminal would make the run interactive. The time limit is
 * our own timer, never `spawn`'s `timeout`: util-linux `script` exits 0 on SIGTERM, which would pass
 * a killed child off as a finished one. Past the limit the child gets SIGTERM, then SIGKILL.
 *
 * @param file - the executable.
 * @param args - its arguments.
 * @param env - its whole environment.
 * @param limitMs - how long it may run.
 * @throws {@link Error} naming the time limit or the exit status, with the child's standard error.
 */
export function runToEnd(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  limitMs: number,
): Promise<ChildOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, limitMs);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killer);
      if (timedOut)
        reject(
          new Error(
            `${file} timed out after ${String(limitMs / 1000)}s; stderr: ${stderr}; stdout: ${stdout}`,
          ),
        );
      else if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${file} ended with ${signal ?? `exit ${String(code)}`}; stderr: ${stderr}; stdout: ${stdout}`,
          ),
        );
    });
  });
}
