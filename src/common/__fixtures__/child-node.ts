import { execFile } from "node:child_process";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { isObject } from "../guards";

/**
 * For specs: run ES-module code in a fresh Node. It is how a spec measures what importing a
 * module, or building a config, does to a process; the spec's own worker has imported plenty
 * already. tsx's loader lets the child import the suite's TypeScript as the runners do.
 */

const execFileAsync = promisify(execFile);

/** tsx's loader, resolved from here so any working directory will do. */
const TSX_LOADER = import.meta.resolve("tsx");

/**
 * How long a child may run. One takes under 2 s here; this leaves room for a slow CI runner and
 * stays under the 30 s test timeout, so a hung child fails its test with {@link execInChildNode}'s
 * message rather than the runner's.
 */
export const CHILD_TIMEOUT_MS = 15_000;

/** What a child is given. */
export interface ChildNodeOptions {
  /** Its working directory. */
  readonly cwd: string;
  /** Variables beyond `PATH` and `HOME`, the only ones it inherits. */
  readonly env?: Readonly<Record<string, string>>;
  /** Kills the child (SIGTERM) when aborted, e.g. from a test's `afterEach`. */
  readonly signal?: AbortSignal;
  /**
   * Make the child end itself (see {@link LIFELINE_EXIT}) when this process dies — a SIGKILLed or
   * timed-out worker runs no cleanup, and the time limit's timer dies with it — or when
   * {@link CHILD_TIMEOUT_MS} has passed. For a child that waits on something only this process makes
   * happen. Off by default: it adds a timer to the child, which a probe of process state would see.
   */
  readonly diesWithParent?: boolean;
}

/** The exit codes of a child that ended itself: its parent died, or its time ran out. */
export const LIFELINE_EXIT = { parentGone: 97, timedOut: 98 } as const;

/** How often a {@link ChildNodeOptions.diesWithParent} child looks for its parent. */
const LIFELINE_POLL_MS = 100;

/**
 * The code {@link ChildNodeOptions.diesWithParent} puts before a child's body: an unref'd interval
 * (it never keeps the child alive) that exits once its parent is no longer this process — it was
 * reparented, this process is gone — or past the deadline. This process's pid is written in, never
 * read from the child's `process.ppid` at start: a parent killed while the child still loads would
 * leave it reading its new parent's. It runs between the body's awaits, so a body that blocks
 * synchronously is bounded by neither; an awaited wait (a polling loop) is.
 */
const LIFELINE = `{
  const parent = ${String(process.pid)};
  const deadline = Date.now() + ${String(CHILD_TIMEOUT_MS)};
  setInterval(() => {
    if (process.ppid !== parent) {
      process.stderr.write("child Node: its parent (pid " + parent + ") is gone; exiting\\n");
      process.exit(${String(LIFELINE_EXIT.parentGone)});
    }
    if (Date.now() > deadline) {
      process.stderr.write("child Node: still running after ${String(CHILD_TIMEOUT_MS)} ms; exiting\\n");
      process.exit(${String(LIFELINE_EXIT.timedOut)});
    }
  }, ${String(LIFELINE_POLL_MS)}).unref();
}
`;

/** Why a child failed: killed at the time limit, its exit code, or why it never started. */
function describeChildFailure(error: unknown): string {
  if (!isObject(error)) return String(error);
  const stderr = typeof error.stderr === "string" ? error.stderr : "";
  const how =
    error.killed === true
      ? `killed after ${String(CHILD_TIMEOUT_MS)} ms`
      : typeof error.code === "number"
        ? `exit ${String(error.code)}`
        : String(error.code ?? error.message);
  return `${how}: ${stderr}`;
}

/** What a child that exited with status 0 wrote. */
export interface ChildNodeOutput {
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Runs `body` — ES module code, top-level `await` allowed — and returns what it wrote, for a caller
 * that reads its result some other way than stdout. Asynchronous, so the calling test's own timeout
 * can still interrupt it.
 *
 * @throws {@link Error} naming the exit code, or the time limit, and the child's stderr.
 */
export async function execInChildNode(
  body: string,
  options: ChildNodeOptions,
): Promise<ChildNodeOutput> {
  try {
    return await execFileAsync(
      process.execPath,
      [
        "--import",
        TSX_LOADER,
        "--input-type=module",
        "--eval",
        // ESM hoists the body's imports above it, so the lifeline may come first.
        options.diesWithParent === true ? LIFELINE + body : body,
      ],
      {
        cwd: options.cwd,
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        signal: options.signal,
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          ...options.env,
        },
      },
    );
  } catch (error) {
    // The argv is the caller's own probe code, and the env holds nothing secret.
    throw new Error(`child Node failed (${describeChildFailure(error)})`, {
      cause: error,
    });
  }
}

/**
 * Runs `body` like {@link execInChildNode} and returns the JSON it printed on its last stdout line.
 *
 * @throws {@link Error} naming the exit code, or the time limit, and the child's stderr; a
 * `SyntaxError` when that line is not JSON.
 */
export async function runInChildNode(
  body: string,
  options: ChildNodeOptions,
): Promise<unknown> {
  const { stdout } = await execInChildNode(body, options);
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}

/**
 * `path` — absolute — as a JS string literal of its `file:` URL, to embed in a child's
 * `import()`.
 *
 * @example
 * ```ts
 * await runInChildNode(`await import(${importable(file)});`, { cwd });
 * ```
 */
export function importable(path: string): string {
  return JSON.stringify(pathToFileURL(path).href);
}
