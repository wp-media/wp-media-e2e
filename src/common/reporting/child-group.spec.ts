import { test, expect } from "@playwright/test";
import { getEventListeners } from "node:events";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { endsWithin } from "../__fixtures__/allure";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  KILL_GRACE_MS,
  killGroup,
  runInOwnGroup,
  stopGroupOnAbort,
} from "./child-group";
import { errnoCode } from "./report-tree";

/**
 * A report tool in a process group of its own: only its caller's abort stops it — SIGTERM to the
 * whole group, then SIGKILL after the grace — and nothing stays armed once it has ended.
 */

let root = "";

test.beforeEach(() => {
  root = tempRoot("e2e child group 'q ");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** Whether a process runs (or is one we may not signal). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/**
 * Writes a `sh` script that records `<pid> <pgid>`, then runs `body`.
 *
 * @param body - the script's rest.
 * @param prelude - what runs before it records (a `trap`), so a spec seeing the record knows it ran.
 * @returns its path and where it records.
 */
function script(body: string, prelude = ""): { bin: string; record: string } {
  const bin = join(root, "tool");
  const record = join(root, "tool.ids");
  writeFileSync(
    bin,
    `#!/bin/sh\n${prelude}echo "$$ $(ps -o pgid= -p $$ | tr -d ' ')" > "$0.ids"\n${body}`,
  );
  chmodSync(bin, 0o755);
  return { bin, record };
}

/** The ids a {@link script} recorded, once it has. */
async function idsOf(record: string): Promise<{ pid: number; pgid: number }> {
  await expect
    .poll(
      () => existsSync(record) && readFileSync(record, "utf8").includes(" "),
    )
    .toBe(true);
  const [pid = NaN, pgid = NaN] = readFileSync(record, "utf8")
    .trim()
    .split(" ")
    .map(Number);
  return { pid, pgid };
}

/** Runs `bin` in its own group with defaults. */
function run(
  bin: string,
  more: { signal?: AbortSignal; killGraceMs?: number } = {},
): ReturnType<typeof runInOwnGroup> {
  return runInOwnGroup({
    bin,
    args: [],
    cwd: root,
    env: process.env,
    stdout: "ignore",
    stderr: "pipe",
    killGraceMs: more.killGraceMs ?? 100,
    ...(more.signal === undefined ? {} : { signal: more.signal }),
  });
}

test.describe("stopGroupOnAbort", () => {
  /** A kill that records what it was asked. */
  function recorder(): {
    kills: [number, NodeJS.Signals][];
    kill: (pgid: number, signal: NodeJS.Signals) => void;
  } {
    const kills: [number, NodeJS.Signals][] = [];
    return { kills, kill: (pgid, signal) => kills.push([pgid, signal]) };
  }

  test("sends the group SIGTERM at the abort, then SIGKILL once the grace is over, never before", async () => {
    const { kills, kill } = recorder();
    const stop = new AbortController();
    stopGroupOnAbort(42, stop.signal, 50, kill);
    await new Promise((settle) => setTimeout(settle, 80));
    expect(kills).toEqual([]);
    stop.abort();
    expect(kills).toEqual([[42, "SIGTERM"]]);
    await new Promise((settle) => setTimeout(settle, 20));
    expect(kills).toEqual([[42, "SIGTERM"]]);
    await expect
      .poll(() => kills)
      .toEqual([
        [42, "SIGTERM"],
        [42, "SIGKILL"],
      ]);
  });

  test("stops at once for a signal already aborted", async () => {
    const { kills, kill } = recorder();
    stopGroupOnAbort(7, AbortSignal.abort(), 10, kill);
    expect(kills).toEqual([[7, "SIGTERM"]]);
    await expect.poll(() => kills.length).toBe(2);
  });

  test("disarmed — the child ended — it sends nothing more, and leaves no listener", async () => {
    const before = recorder();
    const stop = new AbortController();
    stopGroupOnAbort(1, stop.signal, 10, before.kill)();
    expect(getEventListeners(stop.signal, "abort")).toEqual([]);
    stop.abort();
    const after = recorder();
    stopGroupOnAbort(2, AbortSignal.abort(), 10, after.kill)();
    await new Promise((settle) => setTimeout(settle, 60));
    expect(before.kills).toEqual([]);
    // The SIGTERM went at once; the SIGKILL never came.
    expect(after.kills).toEqual([[2, "SIGTERM"]]);
  });

  test("arms nothing without a signal; the default grace is 5 s", () => {
    const { kills, kill } = recorder();
    stopGroupOnAbort(1, undefined, 0, kill)();
    expect(kills).toEqual([]);
    expect(KILL_GRACE_MS).toBe(5_000);
  });
});

test.describe("killGroup", () => {
  test("a group already gone is nothing to stop: it never throws", async () => {
    const { bin, record } = script("exit 0\n");
    expect(await run(bin)).toEqual({ kind: "closed", code: 0, signal: null });
    const { pid, pgid } = await idsOf(record);
    // Its own group, never this runner's: signalling the runner's group would end the run itself.
    expect(pgid).toBe(pid);
    // Every member has ended: ESRCH, swallowed.
    expect(() => {
      killGroup(pgid, "SIGTERM");
    }).not.toThrow();
  });
});

test.describe("runInOwnGroup", () => {
  test("runs the command as the leader of a group of its own, never the caller's", async () => {
    const { bin, record } = script("exit 3\n");
    expect(await run(bin)).toEqual({ kind: "closed", code: 3, signal: null });
    const { pid, pgid } = await idsOf(record);
    expect(pgid).toBe(pid);
    expect(pgid).not.toBe(process.pid);
  });

  test("a stop ends the whole group — a process the command started too — and is waited for", async () => {
    const grandchild = join(root, "grandchild.pid");
    const { bin } = script(
      `sleep 60 &\necho $! > ${JSON.stringify(grandchild)}\nwait\n`,
    );
    const stop = new AbortController();
    const running = run(bin, { signal: stop.signal });
    await expect.poll(() => existsSync(grandchild)).toBe(true);
    const orphan = Number(readFileSync(grandchild, "utf8").trim());

    stop.abort();

    // Ended — by SIGTERM, or by its `wait` returning 0 once SIGTERM ended the `sleep` first: which
    // of the two the group's signal reaches first is the kernel's to say.
    expect(await endsWithin(running, "the stopped command")).toMatchObject({
      kind: "closed",
    });
    // Signalled with its group, not left behind by its parent's end.
    await expect.poll(() => alive(orphan), { timeout: 5_000 }).toBe(false);
  });

  test("a command ignoring SIGTERM is killed once its grace is over", async () => {
    const { bin, record } = script("exec sleep 60\n", "trap '' TERM\n");
    const stop = new AbortController();
    const running = run(bin, { signal: stop.signal, killGraceMs: 100 });
    const { pid } = await idsOf(record);
    const stoppedAt = performance.now();

    stop.abort();

    const ended = await endsWithin(running, "the stopped command");
    expect(ended).toMatchObject({ kind: "closed", signal: "SIGKILL" });
    expect(performance.now() - stoppedAt).toBeGreaterThanOrEqual(90);
    expect(alive(pid)).toBe(false);
  });

  test("hands what it prints to onOutput, and leaves nothing armed once it ends", async () => {
    const { bin } = script("echo out\necho err >&2\n");
    const chunks: string[] = [];
    const done = new AbortController();
    const ended = await runInOwnGroup({
      bin,
      args: [],
      cwd: root,
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      onOutput: (chunk) => chunks.push(chunk.toString()),
      signal: done.signal,
      killGraceMs: 100,
    });
    expect(ended).toEqual({ kind: "closed", code: 0, signal: null });
    expect(chunks.join("").split("\n").sort()).toEqual(["", "err", "out"]);
    expect(getEventListeners(done.signal, "abort")).toEqual([]);
  });

  test("a command that cannot start is a spawn error, with its code", async () => {
    expect(await run(join(root, "absent"))).toEqual({
      kind: "spawn-error",
      code: "ENOENT",
    });
  });
});
