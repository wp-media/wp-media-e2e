import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { LIVE_PROBE_ENV } from "./probe-env";

/**
 * The live block spec's foreign writer: started by the fixture's config in the runner process, it
 * watches for the request a step writes and then writes to the runner's **own** standard output and
 * error, as a library, a warning or another reporter would — the writes the live block must print
 * above itself. Workers and `bddgen` load the config too: only the runner (no `TEST_WORKER_INDEX`)
 * with the requests folder set watches.
 */

/** The lines the runner writes, as a capture shows them: every one must be printed once, whole. */
export const FOREIGN_LINES = [
  "[foreign] console.error from the runner",
  "[foreign] a coloured console.log",
  "[foreign] a line in two writes",
] as const;

/** The text of the warning the runner emits; Node prints it as `(node:PID) Warning: …`. */
export const FOREIGN_WARNING = "[foreign] a warning the runner emits";

/** How often the runner looks for a request. */
const POLL_MS = 100;

/**
 * Watches for the request, if this is the runner and the spec set the folder; the timer never keeps
 * the process alive.
 */
export function watchForWrites(): void {
  const folder = process.env[LIVE_PROBE_ENV.requests];
  if (folder === undefined || process.env.TEST_WORKER_INDEX !== undefined)
    return;
  const request = join(folder, "write");
  const timer = setInterval(() => {
    if (!existsSync(request)) return;
    rmSync(request, { force: true });
    writeForeignLines();
  }, POLL_MS);
  timer.unref();
}

/** Writes every foreign line and the warning, one line in two writes. */
function writeForeignLines(): void {
  console.error(FOREIGN_LINES[0]);
  console.log(`\u001b[33m${FOREIGN_LINES[1]}\u001b[39m`);
  process.emitWarning(FOREIGN_WARNING);
  process.stdout.write("[foreign] a line in ");
  setTimeout(() => {
    process.stdout.write("two writes\n");
  }, 50).unref();
}
