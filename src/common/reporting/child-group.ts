import { spawn } from "node:child_process";

import { errnoCode } from "./report-tree";

/**
 * Running a report tool (Allure, `tar`) in a process group of its own, stopped only by its caller.
 * In the caller's group it would get every signal the group gets: a terminal's Ctrl-C — which the
 * orchestrator answers with a drain that lets a run's bundle finish — or a closing terminal's SIGHUP
 * would kill it mid-build. Detached, nothing but the caller's abort reaches it: SIGTERM to its whole
 * group, then SIGKILL {@link KILL_GRACE_MS} later if it is still running. The caller must therefore
 * abort on every stop it handles (`scripts/allure.mjs` does on SIGINT, SIGTERM and SIGHUP): a caller
 * that dies without aborting leaves the tool running until it ends on its own.
 */

/**
 * How long a stopped child (Allure, `tar`) has to end after SIGTERM before it is sent SIGKILL: a
 * child that ignores SIGTERM must never hold its caller — a run's end, a shutdown — past its budget.
 */
export const KILL_GRACE_MS = 5_000;

/** Signals a process group; `process.kill(-pgid, signal)` by default. */
export type GroupKill = (pgid: number, signal: NodeJS.Signals) => void;

/**
 * Signals a whole process group. Never throws: a group already gone (`ESRCH`) has nothing to stop.
 *
 * @param pgid - the group: its leader's pid.
 * @param signal - the signal.
 */
export function killGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // Gone already: every member has ended.
  }
}

/**
 * Stops a child's process group when `signal` aborts: SIGTERM at once, SIGKILL `graceMs` later. A
 * signal already aborted stops it at once.
 *
 * @param pgid - the child's pid, which leads its group (spawned `detached`).
 * @param signal - the caller's abort signal; nothing is armed without one.
 * @param graceMs - how long it has after SIGTERM.
 * @param kill - signals the group; {@link killGroup} by default.
 * @returns what disarms it: call once the child has ended, so no signal reaches a later group.
 */
export function stopGroupOnAbort(
  pgid: number,
  signal: AbortSignal | undefined,
  graceMs: number,
  kill: GroupKill = killGroup,
): () => void {
  if (signal === undefined) return () => undefined;
  let timer: NodeJS.Timeout | undefined;
  /** Sends SIGTERM and arms the SIGKILL. */
  const stop = (): void => {
    kill(pgid, "SIGTERM");
    timer = setTimeout(() => {
      kill(pgid, "SIGKILL");
    }, graceMs);
  };
  if (signal.aborted) stop();
  else signal.addEventListener("abort", stop, { once: true });
  return () => {
    signal.removeEventListener("abort", stop);
    if (timer !== undefined) clearTimeout(timer);
  };
}

/** A command to run in its own group. */
export interface GroupCommand {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Its stdout: `pipe` hands each chunk to {@link GroupCommand.onOutput}. */
  readonly stdout: "inherit" | "pipe" | "ignore";
  /** Its stderr: `pipe` hands each chunk to {@link GroupCommand.onOutput}. */
  readonly stderr: "inherit" | "pipe";
  /** Gets what a piped stream prints. */
  readonly onOutput?: (chunk: Buffer) => void;
  /** Stops it ({@link stopGroupOnAbort}); it is still waited for. */
  readonly signal?: AbortSignal;
  /** How long it has after a stop's SIGTERM. */
  readonly killGraceMs: number;
}

/** How a command ended: it never started (with why), or it closed. */
export type GroupEnd =
  | { readonly kind: "spawn-error"; readonly code: string }
  | {
      readonly kind: "closed";
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
    };

/**
 * Runs a command as the leader of a new process group and waits for it to close — after a stop too,
 * so nothing it runs writes into a folder its caller removes next. Its input is closed.
 *
 * @param command - what to run.
 * @returns how it ended; never rejects.
 */
export async function runInOwnGroup(command: GroupCommand): Promise<GroupEnd> {
  const child = spawn(command.bin, command.args, {
    cwd: command.cwd,
    env: command.env,
    stdio: ["ignore", command.stdout, command.stderr],
    // Its own group: no signal sent to the caller's group reaches it, and a stop ends all it runs.
    detached: true,
  });
  if (command.onOutput !== undefined) {
    child.stdout?.on("data", command.onOutput);
    child.stderr?.on("data", command.onOutput);
  }
  const disarm =
    child.pid === undefined
      ? () => undefined
      : stopGroupOnAbort(child.pid, command.signal, command.killGraceMs);
  const ended = await new Promise<GroupEnd>((settle) => {
    child.once("error", (error) => {
      // Only a child that never started (no pid) ends here; a running one's `close` follows.
      if (child.pid === undefined) {
        settle({ kind: "spawn-error", code: errnoCode(error) ?? error.name });
      }
    });
    child.once("close", (code, signal) => {
      settle({ kind: "closed", code, signal });
    });
  });
  disarm();
  return ended;
}
