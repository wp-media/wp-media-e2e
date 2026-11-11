import { test, expect } from "@playwright/test";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

import { processGone } from "./ssh-server";
import { killTethered, spawnTethered } from "./tether";

/**
 * A tethered command: it runs as `sh -c` would run it, stops with its group on demand, and — the point
 * of it — dies with the process that started it even when that process is SIGKILLed, where a plain
 * child is left running.
 */

/** tsx's loader, so a fresh Node can import this TypeScript. */
const TSX_LOADER = import.meta.resolve("tsx");

/** `tether.ts`, for the fresh Node to import. */
const TETHER = fileURLToPath(new URL("./tether.ts", import.meta.url));

/**
 * Collects a child's stdout and waits for it to exit.
 *
 * @param child - started with its stdout piped.
 * @returns its exit code and what it printed.
 */
async function finish(
  child: ChildProcess,
): Promise<{ code: number | null; stdout: string }> {
  let stdout = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  const [code] = (await once(child, "close")) as [number | null];
  return { code, stdout };
}

/**
 * The pid a tethered command printed first (its `$!`).
 *
 * @param child - started with its stdout piped.
 * @returns the number it printed.
 */
async function printedPid(child: ChildProcess): Promise<number> {
  if (child.stdout === null) throw new Error("stdout is not piped");
  const [chunk] = (await once(child.stdout, "data")) as [Buffer];
  return Number(chunk.toString("utf8").trim());
}

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

test("runs the script with its positional parameters and exit status, stdin empty", async () => {
  const child = spawnTethered(
    'printf "%s|%s|" "$0" "$1"; cat; exit 7',
    ["zero", "one two"],
    { output: "pipe" },
  );

  // `cat` reading the pipe would block forever: it must read `/dev/null` and end at once.
  await expect(finish(child)).resolves.toEqual({
    code: 7,
    stdout: "zero|one two|",
  });
  killTethered(child);
});

test("what the command left in the background outlives it, until killTethered", async () => {
  const child = spawnTethered("sleep 300 & echo $!", [], { output: "pipe" });
  // Listened for first: the command may exit before its output is read.
  const exited = once(child, "exit");
  const background = await printedPid(child);
  try {
    await exited;
    // Past the watchdog's first check: the command's exit alone kills nothing (as behind sshd).
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(processGone(background)).toBe(false);

    killTethered(child);
    await expect.poll(() => processGone(background)).toBe(true);
  } finally {
    killQuietly(background);
  }
});

test("the watchdog waits with /bin/sleep, so a caller's PATH without sleep never spins it", async () => {
  const child = spawnTethered("exit 0", [], {
    env: { PATH: "/nonexistent" },
  });
  const { pid } = child;
  try {
    if (pid === undefined) throw new Error("the command did not start");
    await once(child, "exit");
    /** The commands running in the tethered group, from `ps`. */
    const inGroup = (): string[] =>
      execFileSync("/bin/ps", ["-A", "-o", "pgid=,args="], {
        encoding: "utf8",
      })
        .split("\n")
        .map((line) => line.trim().split(/\s+/))
        .filter(([pgid]) => pgid === String(pid))
        .map((words) => words.slice(1).join(" "));
    // Its pipe closed with the command: the once-a-second check is running. Without a sleep it
    // would spin, never showing one.
    await expect.poll(inGroup, { timeout: 5_000 }).toContain("/bin/sleep 1");
  } finally {
    killTethered(child);
  }
});

test("killTethered stops the command and what it left in the background", async () => {
  const child = spawnTethered("sleep 300 & echo $!; exec sleep 300", [], {
    output: "pipe",
  });
  const background = await printedPid(child);
  const { pid } = child;
  try {
    if (pid === undefined) throw new Error("the command did not start");
    killTethered(child);

    await expect.poll(() => processGone(background)).toBe(true);
    await expect.poll(() => processGone(pid)).toBe(true);
    // A second call, on a group already gone, is harmless.
    expect(() => {
      killTethered(child);
    }).not.toThrow();
  } finally {
    killQuietly(background);
  }
});

test("a SIGKILLed parent takes its tethered commands with it, running or exited, while a plain child survives", async () => {
  // The fresh Node prints the pids — a running tethered command, the background job of one that
  // already exited, a plain child — then waits to be killed.
  const body = `
    import { spawn } from "node:child_process";
    import { once } from "node:events";
    const { spawnTethered } = await import(${JSON.stringify(TETHER)});
    const running = spawnTethered("exec sleep 300");
    const exited = spawnTethered("sleep 300 & echo $!", [], { output: "pipe" });
    const exit = once(exited, "exit");
    const [line] = await once(exited.stdout, "data");
    await exit;
    const plain = spawn("sleep", ["300"], { detached: true, stdio: "ignore" });
    console.log(JSON.stringify({
      running: running.pid,
      background: Number(String(line).trim()),
      plain: plain.pid,
    }));
    setInterval(() => undefined, 60_000);
  `;
  const parent = spawn(
    process.execPath,
    ["--import", TSX_LOADER, "--input-type=module", "--eval", body],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  let pids: Partial<Record<"running" | "background" | "plain", number>> = {};
  try {
    const [line] = (await once(parent.stdout, "data")) as [Buffer];
    pids = JSON.parse(line.toString("utf8")) as typeof pids;
    const { running, background, plain } = pids;
    if (
      running === undefined ||
      background === undefined ||
      plain === undefined
    )
      throw new Error(`missing pids: ${line.toString("utf8")}`);

    parent.kill("SIGKILL");
    await once(parent, "exit");

    await expect.poll(() => processGone(running)).toBe(true);
    // Found by the once-a-second check, since its pipe closed when its command exited.
    await expect.poll(() => processGone(background)).toBe(true);
    // The control: nothing else killed it, so the plain one is still running.
    expect(processGone(plain)).toBe(false);
  } finally {
    parent.kill("SIGKILL");
    for (const pid of Object.values(pids)) killQuietly(pid);
  }
});
