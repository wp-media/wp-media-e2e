import { spawn } from "node:child_process";
import { once } from "node:events";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { isCi } from "../terminal/capabilities";

/**
 * For specs: run ES-module code in a fresh Node whose standard output is a **pty nobody reads** — a
 * paused terminal (Ctrl-S, a frozen SSH client). `script` gives it the pty and copies the pty to its
 * own standard output, a pipe this module never reads: once that pipe and the pty's buffer fill,
 * `script` stops reading, and a blocking write to the pty blocks the child's whole event loop.
 * BSD `script` on macOS, util-linux's on Linux; without one it reports `no-pty` locally and throws
 * under `CI`, so the check is never silently absent there.
 */

/** tsx's loader, so the child imports the repository's TypeScript. */
const TSX_LOADER = import.meta.resolve("tsx");

/** How long the child gets to show it is done before it counts as stuck. */
export const STUCK_AFTER_MS = 8_000;

/** How often {@link runPaused} looks for the child's sign. */
const POLL_MS = 50;

/**
 * Runs `body` on a pty nobody reads until `done()` says it got through, or {@link STUCK_AFTER_MS}
 * passed; then kills `script`, which takes the child with it (the pty's hang-up), and waits for it.
 *
 * @param body - ES module code; top-level `await` allowed.
 * @param done - whether the child left its sign (a file it wrote).
 * @returns `done`, `stuck`, or `no-pty` when no `script` is installed (never under `CI`).
 * @throws {@link Error} under `CI` without `script`.
 */
export async function runPaused(
  body: string,
  done: () => boolean,
): Promise<"done" | "stuck" | "no-pty"> {
  const script = findOnPath("script");
  if (script === undefined) {
    if (isCi(process.env)) throw new Error("script must be installed under CI");
    return "no-pty";
  }
  const command = `exec "$E2E_NODE" --import "$E2E_TSX" --input-type=module --eval "$E2E_BODY"`;
  const args =
    process.platform === "darwin"
      ? ["-q", "/dev/null", "/bin/sh", "-c", command]
      : ["-qec", command, "/dev/null"];
  const child = spawn(script, args, {
    // Standard input /dev/null: `script` refuses a socket there; standard output never read.
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      E2E_NODE: process.execPath,
      E2E_TSX: TSX_LOADER,
      E2E_BODY: body,
    },
  });
  const closed = once(child, "close");
  try {
    const deadline = performance.now() + STUCK_AFTER_MS;
    while (performance.now() < deadline) {
      if (done()) return "done";
      if (child.exitCode !== null || child.signalCode !== null) break;
      await delay(POLL_MS);
    }
    return done() ? "done" : "stuck";
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
}

/**
 * An executable named `name` on `PATH`, or `undefined`.
 *
 * @param name - the executable's name.
 */
function findOnPath(name: string): string | undefined {
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
