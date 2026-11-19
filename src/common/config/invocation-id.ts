import { randomBytes } from "node:crypto";

/**
 * One random token per runner invocation, shared by the runner and the workers it forks — unlike
 * `RUN_ID`, which an orchestrator may pin and share between invocations, so it never names one.
 * What names a lease's holder on a site (`holderFor` in BackWPup's copy of `wp-content`): two
 * invocations never share it, whatever their `RUN_ID`.
 *
 * It rides the environment as `<pid>:<token>`, believed only by the process that wrote it and by its
 * **direct children that are Playwright workers**: forked straight from the runner (`ppid`), each
 * given `TEST_WORKER_INDEX` before it loads the config (measured, Playwright 1.65.1). Anything else
 * that inherited it writes its own: a run started from a worker (its parent is no writer), or one the
 * runner started directly (no worker index). Residual: a runner started directly by a runner that
 * itself inherited a worker's `TEST_WORKER_INDEX` — a run inside a run inside a worker — shares its
 * parent's token. Nothing but the runner and its workers needs it (both read it as they load
 * `run-context.ts`).
 */

/** The internal variable carrying the token to the runner's workers; never set by hand. */
export const INVOCATION_ENV = "E2E_INTERNAL_INVOCATION";

/** The variable's value: the writer's pid, then the token — 32 lowercase hex digits. */
const SEED = /^(\d{1,10}):([0-9a-f]{32})$/;

/** What Playwright sets in each worker: its index, a whole number. */
const WORKER_INDEX = /^\d{1,10}$/;

/** What a process needs to resolve its invocation's token; the real ones by default. */
export interface InvocationProcess {
  /** The environment (`TEST_WORKER_INDEX` included), read and — when a fresh token is made — written. */
  readonly env: NodeJS.ProcessEnv;
  readonly pid: number;
  readonly ppid: number;
  /** Makes a fresh token. */
  readonly fresh?: () => string;
}

/**
 * This invocation's token: the one its runner published (this process wrote it, or this is a worker
 * its parent forked), else a fresh one, published for this process's own children.
 *
 * @param proc - the process; see {@link InvocationProcess}.
 * @returns 32 hex digits.
 */
export function resolveInvocationId(proc: InvocationProcess): string {
  const seed = SEED.exec(proc.env[INVOCATION_ENV] ?? "");
  const writer = seed === null ? undefined : Number(seed[1]);
  const worker = WORKER_INDEX.test(proc.env.TEST_WORKER_INDEX ?? "");
  if (
    seed?.[2] !== undefined &&
    (writer === proc.pid || (worker && writer === proc.ppid))
  ) {
    return seed[2];
  }
  const made = (proc.fresh ?? (() => randomBytes(16).toString("hex")))();
  proc.env[INVOCATION_ENV] = `${String(proc.pid)}:${made}`;
  return made;
}
