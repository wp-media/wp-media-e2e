import { test, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { execInChildNode } from "./child-node";
import { processGone } from "./ssh-server";
import { removeTempDir } from "./temp-dir";

/**
 * A child Node: an abort kills it, and one started with `diesWithParent` ends itself once the process
 * that started it is SIGKILLed, where a plain one is left running forever.
 */

/** tsx's loader, so a fresh Node can import this TypeScript. */
const TSX_LOADER = import.meta.resolve("tsx");

/** `child-node.ts`, for the fresh Node to import. */
const CHILD_NODE = fileURLToPath(new URL("./child-node.ts", import.meta.url));

/** A child body that writes its pid to `$PID_FILE`, then waits forever. */
const WAIT_FOREVER = `
  import { writeFileSync } from "node:fs";
  writeFileSync(process.env.PID_FILE, String(process.pid));
  setInterval(() => undefined, 60_000);
`;

/**
 * Kills a pid if it still runs, ignoring one already gone: a failed test's cleanup.
 *
 * @param pid - the process.
 */
function killQuietly(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Starts a fresh Node that runs {@link WAIT_FOREVER} through `execInChildNode`, SIGKILLs it once the
 * child is up, and returns the child's pid: the child is then an orphan, unless it ends itself.
 *
 * @param dir - a temp folder for the pid file.
 * @param diesWithParent - the option under test.
 * @returns the orphaned child's pid.
 */
async function orphanChild(
  dir: string,
  diesWithParent: boolean,
): Promise<number> {
  const pidFile = join(dir, `pid-${String(diesWithParent)}`);
  const body = `
    const { execInChildNode } = await import(${JSON.stringify(CHILD_NODE)});
    await execInChildNode(${JSON.stringify(WAIT_FOREVER)}, {
      cwd: ${JSON.stringify(dir)},
      env: { PID_FILE: ${JSON.stringify(pidFile)} },
      diesWithParent: ${String(diesWithParent)},
    });
  `;
  const parent = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--input-type=module", "--eval", body],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  try {
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    await expect.poll(() => readFileSync(pidFile, "utf8")).toMatch(/^\d+$/);
    return Number(readFileSync(pidFile, "utf8"));
  } finally {
    parent.kill("SIGKILL");
    if (parent.exitCode === null && parent.signalCode === null)
      await once(parent, "exit");
  }
}

test.describe("execInChildNode", () => {
  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "child-node-"));
  });

  test.afterEach(() => {
    removeTempDir(dir);
  });

  test("a child started with diesWithParent ends itself once its parent is SIGKILLed", async () => {
    const pid = await orphanChild(dir, true);
    try {
      // The lifeline looks every 100 ms; well under the 15 s deadline it would otherwise hit.
      await expect.poll(() => processGone(pid), { timeout: 3_000 }).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });

  test("a child started without diesWithParent outlives its SIGKILLed parent", async () => {
    // The control: what the lifeline prevents. Past its first looks, the plain child still runs.
    const pid = await orphanChild(dir, false);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(processGone(pid)).toBe(false);
    } finally {
      killQuietly(pid);
    }
  });

  test("aborting its signal kills the child and fails the call", async () => {
    const pidFile = join(dir, "pid");
    const stop = new AbortController();
    const run = execInChildNode(WAIT_FOREVER, {
      cwd: dir,
      env: { PID_FILE: pidFile },
      signal: stop.signal,
    });
    // Handled now: the call rejects as soon as the abort lands.
    const outcome = run.then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "?"),
    );
    await expect.poll(() => existsSync(pidFile)).toBe(true);
    await expect.poll(() => readFileSync(pidFile, "utf8")).toMatch(/^\d+$/);
    const pid = Number(readFileSync(pidFile, "utf8"));
    try {
      stop.abort();
      expect(await outcome).toMatch(/^child Node failed \(ABORT_ERR/);
      await expect.poll(() => processGone(pid)).toBe(true);
    } finally {
      killQuietly(pid);
    }
  });
});
