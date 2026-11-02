import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";

/**
 * For specs: run ES-module code in a fresh Node whose standard output nobody reads for a while — what
 * a terminal slower than a burst of output does to a process that then calls `process.exit`. Node
 * writes a pipe without blocking, as it writes a terminal once `unblockTerminal` unblocks it, so what
 * the child still had queued at its exit is lost here as it is on a terminal.
 */

/** tsx's loader, resolved from here so the child imports the repository's TypeScript. */
const TSX_LOADER = import.meta.resolve("tsx");

/** How long a child may run before it is killed and the spec fails. */
const CHILD_TIMEOUT_MS = 20_000;

/** How a child ended, and what it wrote. */
export interface SlowlyReadResult {
  /** Its exit code; `null` when a signal ended it. */
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** Milliseconds from its spawn to its exit. */
  readonly ranMs: number;
}

/**
 * Runs `body` with its standard output a pipe read only `readAfterMs` after the child starts — or,
 * with `readAfterMs` `undefined`, only once it has exited.
 *
 * @param body - ES module code; top-level `await` allowed.
 * @param readAfterMs - when to start reading its standard output.
 * @returns how it ended, and what reached its standard output and error.
 * @throws {@link Error} when it runs past {@link CHILD_TIMEOUT_MS}.
 */
export async function runSlowlyRead(
  body: string,
  readAfterMs: number | undefined,
): Promise<SlowlyReadResult> {
  const started = performance.now();
  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--input-type=module", "--eval", body],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  // Read through `readable`, not `data`: a stream with neither listener Node resumes as the child
  // exits, dropping what it had; with this one it reads no more than its buffer until `read()` is
  // called, so the child's pipe fills.
  const chunks: Buffer[] = [];
  let reading = false;
  /** Takes everything buffered, once reading is turned on. */
  const readAll = (): void => {
    if (!reading) return;
    for (let chunk: unknown; (chunk = child.stdout.read()) !== null;)
      if (Buffer.isBuffer(chunk)) chunks.push(chunk);
  };
  child.stdout.on("readable", readAll);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const exited = once(child, "exit").then(() => performance.now() - started);
  const closed = once(child, "close");
  const killer = setTimeout(() => child.kill("SIGKILL"), CHILD_TIMEOUT_MS);
  try {
    let ranMs: number | undefined;
    if (readAfterMs === undefined) ranMs = await exited;
    else await delay(readAfterMs);
    reading = true;
    readAll();
    ranMs ??= await exited;
    await closed;
    if (child.exitCode === null && child.signalCode === "SIGKILL")
      throw new Error(
        `the child ran past ${String(CHILD_TIMEOUT_MS)} ms: ${stderr}`,
      );
    return {
      code: child.exitCode,
      stdout: Buffer.concat(chunks).toString("utf8"),
      stderr,
      ranMs,
    };
  } finally {
    clearTimeout(killer);
  }
}
