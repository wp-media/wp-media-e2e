import { test, expect } from "@playwright/test";
import { existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
  mkdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  FAKE_LINES,
  fakeCommand,
  waitForText,
  type FakeBehaviour,
} from "../__fixtures__/fake-suite";
import {
  describeCommand,
  launchRun,
  LOG_PREFIX,
  openRunLog,
  runFolderRefusal,
  stopLine,
  type LaunchedRun,
  type LaunchOptions,
} from "./launch";
import { endRun } from "./end";
import type { KillFn } from "./process-group";
import { runEnd } from "../__fixtures__/results";
import { RESULTS_FILE } from "../../src/common/reporting/results-schema";

/** A fresh run folder per test, removed after it. */
let root: string;
/** Every process group a test's runs started: SIGKILLed as the test ends, whatever it left. */
const startedGroups: number[] = [];
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-launch-"));
});
test.afterEach(async () => {
  for (const pgid of startedGroups.splice(0))
    try {
      process.kill(-pgid, "SIGKILL");
    } catch (error) {
      // Already empty: the run waited for it.
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  await rm(root, { recursive: true, force: true });
});

/** A secret value the run's environment carries, which its log must never show. */
const SECRET = "ghp_launchSpecSecretValue0123456789abcdef";

/**
 * Launch options running the fake suite.
 *
 * @param bddgen - how the fake `bddgen` behaves.
 * @param playwright - how the fake runner behaves.
 * @param more - anything else to set.
 */
function options(
  bddgen: FakeBehaviour,
  playwright: FakeBehaviour,
  more: Partial<LaunchOptions> = {},
): LaunchOptions {
  const dir = join(root, "runs", "bpng-1");
  const { onProcess, ...rest } = more;
  return {
    identity: {
      dir,
      log: join(dir, "run.log"),
      stopFile: join(dir, "stop"),
      reportDir: join(root, "reports", "RUN"),
    },
    commands: {
      bddgen: fakeCommand(bddgen),
      playwright: fakeCommand(playwright),
    },
    cwd: root,
    env: {
      PATH: process.env.PATH ?? "",
      GITHUB_TOKEN: SECRET,
      E2E_INTERNAL_STOP_FILE: join(dir, "stop"),
    },
    pollMs: 20,
    ...rest,
    // Each group noted for the clean-up first, then handed on: a throw or a rejection stays the test's.
    onProcess: (name, pgid) => {
      startedGroups.push(pgid);
      return onProcess?.(name, pgid);
    },
  };
}

/**
 * A runner that leaves a child in its group for `childMs`, prints `crashed`, then exits `code` — no
 * `run.end`: a runner that died on its own while its workers still tear down.
 *
 * @param code - its exit code.
 * @param childMs - how long the child outlives it.
 */
function crashingRunner(
  code: number,
  childMs: number,
): LaunchOptions["commands"]["playwright"] {
  const child = `setTimeout(() => {}, ${String(childMs)})`;
  return {
    file: process.execPath,
    args: [
      "-e",
      `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(child)}], { stdio: "ignore" }).unref(); console.log("cra" + "shed"); process.exit(${String(code)});`,
    ],
  };
}

test.describe("launchRun", () => {
  test("runs bddgen then the runner, each with the given environment only, and logs names, never values", async () => {
    const envFile = join(root, "env.json");
    const groups: string[] = [];
    const run = await launchRun(
      options(
        { exitCode: 0 },
        { runMs: 50, envFile },
        {
          onProcess: (name) => {
            groups.push(name);
          },
        },
      ),
    );
    const result = await run.done;
    expect(result).toEqual({
      bddgen: { code: 0, signal: null },
      playwright: { code: 0, signal: null },
      stop: { level: "none" },
    });
    expect(groups).toEqual(["bddgen", "playwright"]);
    // Exactly the variables handed in. macOS's own runtime adds `__CF_USER_TEXT_ENCODING` to every
    // process it starts, Node or not: not ours to pass on, nor to stop.
    const names = JSON.parse(await readFile(envFile, "utf8")) as string[];
    expect(names.filter((name) => !name.startsWith("__CF_"))).toEqual([
      "E2E_INTERNAL_STOP_FILE",
      "GITHUB_TOKEN",
      "PATH",
    ]);
    const log = await readFile(join(root, "runs", "bpng-1", "run.log"), "utf8");
    expect(log).toContain(`${LOG_PREFIX} `);
    expect(log).toContain(
      "variables: E2E_INTERNAL_STOP_FILE, GITHUB_TOKEN, PATH",
    );
    expect(log).toMatch(/bddgen exited with code 0/);
    expect(log).toMatch(/playwright exited with code 0/);
    expect(log).toContain(FAKE_LINES.ready);
    expect(log).not.toContain(SECRET);
  });

  test("does not start the runner when bddgen fails", async () => {
    const run = await launchRun(options({ exitCode: 3 }, {}));
    expect(await run.done).toEqual({
      bddgen: { code: 3, signal: null },
      stop: { level: "none" },
    });
  });

  test("drains the runner by creating the stop file, and sends no signal", async () => {
    const opts = options({ exitCode: 0 }, {});
    const run = await launchRun(opts);
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("drained", "the orchestrator was stopped (SIGINT)");
    // At once, never behind a log write: the step that follows must find it done.
    expect(existsSync(opts.identity.stopFile)).toBe(true);
    const result = await run.done;
    expect(result.playwright).toEqual({ code: 0, signal: null });
    expect(result.stop).toEqual({
      level: "drained",
      why: "the orchestrator was stopped (SIGINT)",
    });
    expect(existsSync(opts.identity.stopFile)).toBe(true);
    const log = await readFile(opts.identity.log, "utf8");
    expect(log).toContain(FAKE_LINES.drained);
    expect(log).not.toContain(FAKE_LINES.sigint);
  });

  test("interrupts the runner with one SIGINT, draining it first", async () => {
    const opts = options({ exitCode: 0 }, { ignoreSigint: true, runMs: 400 });
    // The fake must not see the stop file, or it would leave before the SIGINT reaches it.
    const run = await launchRun({
      ...opts,
      env: { ...opts.env, E2E_INTERNAL_STOP_FILE: join(root, "elsewhere") },
    });
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("interrupted", "stop now");
    run.stop("interrupted", "stop now, again");
    run.stop("drained", "a drain after the interrupt");
    const result = await run.done;
    expect(result.stop).toEqual({ level: "interrupted", why: "stop now" });
    expect(existsSync(opts.identity.stopFile)).toBe(true);
    const log = await readFile(opts.identity.log, "utf8");
    expect(log.match(new RegExp(FAKE_LINES.sigint, "g"))).toHaveLength(1);
  });

  test("kills the runner's group when it ignores SIGINT", async () => {
    const opts = options({ exitCode: 0 }, { ignoreSigint: true });
    const run = await launchRun({
      ...opts,
      env: { ...opts.env, E2E_INTERNAL_STOP_FILE: join(root, "elsewhere") },
    });
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("interrupted", "stop now");
    await waitForText(opts.identity.log, FAKE_LINES.sigint);
    run.stop("killed", "kill now");
    const result = await run.done;
    expect(result.playwright).toEqual({ code: null, signal: "SIGKILL" });
    expect(result.stop).toEqual({ level: "killed", why: "kill now" });
  });

  test("kills the runner's whole group, its workers included", async () => {
    const childFile = join(root, "child-done");
    const opts = options(
      { exitCode: 0 },
      { ignoreSigint: true, childMs: 1_500, childFile },
    );
    const run = await launchRun(opts);
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("killed", "kill now");
    await run.done;
    // Done only once the group is empty: the child died with it, before it could write.
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    expect(existsSync(childFile)).toBe(false);
  });

  test("kills bddgen's group outright on a stop, takes it as a drain and never starts the runner", async () => {
    const opts = options({}, { exitCode: 0 });
    const run = await launchRun(opts);
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("killed", "the orchestrator was stopped (SIGINT)");
    const result = await run.done;
    expect(result).toEqual({
      bddgen: { code: null, signal: "SIGKILL" },
      stop: { level: "drained", why: "the orchestrator was stopped (SIGINT)" },
    });
    // Generation has nothing to drain: no stop file.
    expect(existsSync(opts.identity.stopFile)).toBe(false);
  });

  test("waits for the runner's group to empty, not only for the runner", async () => {
    const childFile = join(root, "child-done");
    const run = await launchRun(
      options({ exitCode: 0 }, { runMs: 20, childMs: 400, childFile }),
    );
    await run.done;
    expect(existsSync(childFile)).toBe(true);
  });

  test("kills a group that outlives its process past the linger", async () => {
    const childFile = join(root, "child-done");
    const opts = options(
      { exitCode: 0 },
      { runMs: 20, childMs: 30_000, childFile },
      { lingerMs: 100 },
    );
    const run = await launchRun(opts);
    const result = await run.done;
    expect(result.playwright).toEqual({ code: 0, signal: null });
    expect(result.stop).toEqual({ level: "none" });
    expect(existsSync(childFile)).toBe(false);
    expect(await readFile(opts.identity.log, "utf8")).toContain(
      "playwright's process group outlived it by 100 ms: killed",
    );
  });

  test("takes no drain nor interrupt once the runner died on its own, its workers lingering: the crash stays the verdict", async () => {
    const opts = options({ exitCode: 0 }, {});
    const run = await launchRun({
      ...opts,
      commands: { ...opts.commands, playwright: crashingRunner(1, 1_500) },
    });
    await waitForText(opts.identity.log, "crashed");
    // A turn for the runner's exit to reach the launch; its child still holds the group.
    await delay(300);
    run.stop("drained", "the orchestrator was stopped (SIGINT)");
    run.stop("interrupted", "again");
    const launch = await run.done;
    expect(launch).toEqual({
      bddgen: { code: 0, signal: null },
      playwright: { code: 1, signal: null },
      stop: { level: "none" },
    });
    // Nothing left to drain: no stop file.
    expect(existsSync(opts.identity.stopFile)).toBe(false);
    expect(await readFile(opts.identity.log, "utf8")).toContain(
      "stop: drained asked once the runner had exited on its own: nothing left to stop, its own end stands — the orchestrator was stopped (SIGINT)",
    );
    const { outcome } = await endRun({
      identity: {
        id: "bpng-1",
        runId: "2026-10-19T00-00-00-000Z-bpng-1",
        startedAt: new Date("2026-10-19T00:00:00.000Z"),
        log: opts.identity.log,
        reportDir: opts.identity.reportDir,
      },
      task: { id: "bpng", product: "backwpup", cell: "pro@nginx" },
      launch,
      secrets: [],
      endedAt: new Date(),
    });
    expect(outcome).toEqual({
      status: "error",
      reason:
        "Playwright exited with code 1 without finishing its results: crashed",
    });
  });

  test("kills what is left of a runner that exited on its own, without taking the kill", async () => {
    const childFile = join(root, "child-done");
    const opts = options(
      { exitCode: 0 },
      { runMs: 20, childMs: 30_000, childFile },
    );
    const run = await launchRun(opts);
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    await delay(300);
    run.stop("killed", "kill now");
    run.stop("killed", "kill again");
    const result = await run.done;
    expect(result.playwright).toEqual({ code: 0, signal: null });
    expect(result.stop).toEqual({ level: "none" });
    expect(existsSync(childFile)).toBe(false);
    const log = await readFile(opts.identity.log, "utf8");
    expect(
      log.match(
        /what is left of its process group killed, its own end stands/g,
      ),
    ).toHaveLength(1);
  });

  test("ends a run whose command cannot start, saying why in the log", async () => {
    const opts = options({}, {});
    const run = await launchRun({
      ...opts,
      commands: {
        ...opts.commands,
        bddgen: { file: join(root, "missing"), args: [] },
      },
    });
    expect(await run.done).toEqual({
      bddgen: { code: null, signal: null, notStarted: "ENOENT" },
      stop: { level: "none" },
    });
    expect(await readFile(opts.identity.log, "utf8")).toContain(
      "bddgen could not start: ENOENT",
    );
  });

  test("ends a run Node refuses to spawn, without throwing", async () => {
    const opts = options({}, {});
    const run = await launchRun({ ...opts, env: { ...opts.env, BAD: "a\0b" } });
    expect((await run.done).bddgen).toEqual({
      code: null,
      signal: null,
      notStarted: "ERR_INVALID_ARG_VALUE",
    });
    expect(await readFile(opts.identity.log, "utf8")).toContain(
      "bddgen could not start: ERR_INVALID_ARG_VALUE",
    );
  });

  test("refuses a run whose folder is already there, even empty and private, spawning nothing", async () => {
    const opts = options({ exitCode: 0 }, { exitCode: 0 });
    await mkdir(opts.identity.dir, { recursive: true, mode: 0o700 });
    await expect(launchRun(opts)).rejects.toThrow(
      `The run's folder is already there (${opts.identity.dir}): a run of that id ran before.`,
    );
    // No log: nothing was spawned, nor written.
    expect(existsSync(opts.identity.log)).toBe(false);
  });

  test("removes the folder it made when it fails before anything could record the run", async () => {
    // A log that cannot be made (its folder is missing), then a stop file that cannot be checked.
    for (const broken of [
      { log: join(root, "runs", "bpng-1", "missing", "run.log") },
      { stopFile: join(root, "file", "stop") },
    ]) {
      await writeFile(join(root, "file"), "");
      const opts = options({ exitCode: 0 }, { exitCode: 0 });
      const spawning: string[] = [];
      await expect(
        launchRun({
          ...opts,
          identity: { ...opts.identity, ...broken },
          onSpawning: (name) => {
            spawning.push(name);
          },
        }),
      ).rejects.toMatchObject({ code: expect.any(String) });
      expect(spawning).toEqual([]);
      expect(await readdir(join(root, "runs"))).toEqual([]);
    }
  });

  test("refuses a run whose folder already holds a stop file, which would drain it", async () => {
    const opts = options({ exitCode: 0 }, { exitCode: 0 });
    await mkdir(opts.identity.dir, { recursive: true, mode: 0o700 });
    await writeFile(opts.identity.stopFile, "");
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
  });

  test("ignores a stop once nothing runs any more, even while the log is flushed", async () => {
    // The stop lands on the turn after the group read as empty: the run has ended, its log not closed.
    const late: { run?: LaunchedRun } = {};
    let fired = false;
    const kill: KillFn = (pid, signal) => {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (!fired && signal === 0) {
          fired = true;
          setImmediate(() => late.run?.stop("drained", "too late"));
        }
        throw error;
      }
    };
    late.run = await launchRun(options({ exitCode: 3 }, {}, { kill }));
    expect(await late.run.done).toEqual({
      bddgen: { code: 3, signal: null },
      stop: { level: "none" },
    });
    expect(fired).toBe(true);
  });

  test("never sends the SIGINT once the tests are over, so the runner finishes its reports", async () => {
    const opts = options({ exitCode: 0 }, { ignoreSigint: true, runMs: 300 });
    await mkdir(opts.identity.reportDir, { recursive: true });
    await writeFile(
      join(opts.identity.reportDir, RESULTS_FILE),
      `${JSON.stringify(runEnd("passed", { total: 1, passed: 1 }))}\n`,
    );
    // The fake must not see the stop file, or it would leave before any SIGINT could reach it.
    const run = await launchRun({
      ...opts,
      env: { ...opts.env, E2E_INTERNAL_STOP_FILE: join(root, "elsewhere") },
    });
    await waitForText(opts.identity.log, FAKE_LINES.ready);
    run.stop("interrupted", "stop now");
    const result = await run.done;
    expect(result.playwright).toEqual({ code: 0, signal: null });
    expect(result.stop).toEqual({ level: "interrupted", why: "stop now" });
    const log = await readFile(opts.identity.log, "utf8");
    expect(log).not.toContain(FAKE_LINES.sigint);
    expect(log).toContain("interrupt skipped: the tests are over");
  });

  test("notes a SIGINT that fails, but not one that finds the runner gone", async () => {
    for (const [index, code] of ["ESRCH", "EPERM"].entries()) {
      const kill: KillFn = (pid, signal) => {
        if (signal === "SIGINT" && pid > 0)
          throw Object.assign(new Error("refused"), { code });
        process.kill(pid, signal);
      };
      const dir = join(root, String(index));
      const opts = options({ exitCode: 0 }, {}, { kill });
      const identity = {
        ...opts.identity,
        dir,
        log: join(dir, "run.log"),
        stopFile: join(dir, "stop"),
      };
      // The fake drains on the stop file the interrupt creates first, so the run still ends.
      const run = await launchRun({
        ...opts,
        identity,
        env: { ...opts.env, E2E_INTERNAL_STOP_FILE: identity.stopFile },
      });
      await waitForText(identity.log, FAKE_LINES.ready);
      run.stop("interrupted", "stop now");
      expect((await run.done).stop.level).toBe("interrupted");
      const log = await readFile(identity.log, "utf8");
      if (code === "ESRCH") expect(log).not.toContain("interrupt failed");
      else expect(log).toContain("interrupt failed: EPERM");
    }
  });

  test("ends the run without a kill when its group cannot be watched", async () => {
    const signals: (NodeJS.Signals | 0)[] = [];
    const kill: KillFn = (pid, signal) => {
      signals.push(signal);
      if (signal === 0)
        throw Object.assign(new Error("invalid"), { code: "EINVAL" });
      process.kill(pid, signal);
    };
    const opts = options({ exitCode: 0 }, { runMs: 20 }, { kill });
    const result = await (await launchRun(opts)).done;
    expect(result.playwright).toEqual({ code: 0, signal: null });
    const log = await readFile(opts.identity.log, "utf8");
    expect(log).toContain("watching the process group failed: EINVAL");
    // Not taken for a group that outlived its process: nothing was killed.
    expect(log).not.toContain("outlived");
    expect(signals).not.toContain("SIGKILL");
  });

  test("keeps waiting for a lingering group it cannot kill: it still holds the cell", async () => {
    const childFile = join(root, "child-done");
    const release = join(root, "release-child");
    const kill: KillFn = (pid, signal) => {
      if (signal === "SIGKILL")
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      process.kill(pid, signal);
    };
    // The child ends only once the failed kill was said, however slowly the linger's polls run.
    const opts = options(
      { exitCode: 0 },
      { runMs: 20, childUntil: release, childFile },
      {
        lingerMs: 100,
        kill,
        onStuck: () => {
          writeFileSync(release, "");
        },
      },
    );
    const run = await launchRun(opts);
    await run.done;
    // Done only once the child ended on its own.
    expect(existsSync(childFile)).toBe(true);
    expect(await readFile(opts.identity.log, "utf8")).toContain(
      "outlived it by 100 ms and could not be killed (EPERM): waiting for it",
    );
  });

  test("says a group it cannot kill beyond the run's log, at once and again while it waits", async () => {
    const childFile = join(root, "child-done");
    const said: string[] = [];
    const kill: KillFn = (pid, signal) => {
      if (signal === "SIGKILL")
        throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      process.kill(pid, signal);
    };
    const release = join(root, "release-child");
    // The child ends once the line was said three times: counted in polls, not wall-clock time.
    const opts = options(
      { exitCode: 0 },
      { runMs: 20, childUntil: release, childFile },
      {
        lingerMs: 100,
        stuckRepeatMs: 200,
        kill,
        onStuck: (text) => {
          said.push(text);
          if (said.length === 3) writeFileSync(release, "");
          throw new Error("a teller that throws is dropped");
        },
      },
    );
    const run = await launchRun(opts);
    await run.done;
    expect(existsSync(childFile)).toBe(true);
    expect(said[0]).toMatch(
      /^playwright's process group \(\d+\) outlived it by 100 ms and could not be killed \(EPERM\): waiting for it$/,
    );
    // Said again while the child lives on — each time with the command that ends the group.
    expect(said.length).toBeGreaterThanOrEqual(3);
    for (const text of said.slice(1))
      expect(text).toMatch(
        /^playwright's process group \((\d+)\) is still not empty \d+ ms after its linger, never killed \(killing it again failed: EPERM\): still waiting — the run and its cell stay held; end it as this user or root: kill -KILL -\1$/,
      );
    const log = await readFile(opts.identity.log, "utf8");
    // No SIGKILL ever reached it: the line never says it outlived one.
    expect(log).toContain(
      "is still not empty 200 ms after its linger, never killed",
    );
    expect(log).not.toContain("after its SIGKILL");
  });

  test("refuses a stuck line's repeat that is not a whole number of milliseconds from 1: it would spin", async () => {
    for (const stuckRepeatMs of [0, -1, 0.5, Number.NaN])
      await expect(
        launchRun(options({ exitCode: 0 }, { runMs: 20 }, { stuckRepeatMs })),
      ).rejects.toThrow(RangeError);
    // Refused before anything was made.
    expect(existsSync(join(root, "runs"))).toBe(false);
  });

  test("says a group that a SIGKILL did not empty, without a kill failure", async () => {
    const said: string[] = [];
    const childFile = join(root, "child-done");
    // SIGKILL "sent", but nothing dies: a member stuck in the kernel looks so.
    const kill: KillFn = (pid, signal) => {
      if (signal !== "SIGKILL") process.kill(pid, signal);
    };
    const release = join(root, "release-child");
    // The child ends once the line was said: counted in polls, not wall-clock time.
    const opts = options(
      { exitCode: 0 },
      { runMs: 20, childUntil: release, childFile },
      {
        lingerMs: 100,
        stuckRepeatMs: 200,
        kill,
        onStuck: (text) => {
          said.push(text);
          writeFileSync(release, "");
        },
      },
    );
    await (
      await launchRun(opts)
    ).done;
    expect(said.length).toBeGreaterThanOrEqual(1);
    expect(said[0]).toMatch(
      /^playwright's process group \(\d+\) is still not empty 200 ms after its SIGKILL: still waiting/,
    );
  });

  test("watches a run whose onProcess throws or rejects, and notes it", async () => {
    const failures = [
      (): void => {
        throw new Error("the record could not be written");
      },
      (): Promise<void> =>
        Promise.reject(new Error("the record could not be written")),
    ];
    for (const [index, onProcess] of failures.entries()) {
      const opts = options({ exitCode: 0 }, { runMs: 50 }, { onProcess });
      const run = await launchRun({
        ...opts,
        identity: {
          ...opts.identity,
          dir: join(root, String(index)),
          log: join(root, String(index), "run.log"),
          stopFile: join(root, String(index), "stop"),
        },
      });
      expect(await run.done).toEqual({
        bddgen: { code: 0, signal: null },
        playwright: { code: 0, signal: null },
        stop: { level: "none" },
      });
      const log = await readFile(join(root, String(index), "run.log"), "utf8");
      expect(log).toContain("recording bddgen's process group failed");
      expect(log).toContain("recording playwright's process group failed");
    }
  });

  test("awaits onSpawning before each spawn, so a process is never running before its record says it is starting", async () => {
    const events: string[] = [];
    const run = await launchRun(
      options(
        { exitCode: 0 },
        { runMs: 50 },
        {
          onSpawning: async (name) => {
            events.push(`spawning ${name}`);
            await delay(80);
            events.push(`recorded ${name}`);
          },
          onProcess: (name) => {
            events.push(`started ${name}`);
          },
        },
      ),
    );
    expect(await run.done).toEqual({
      bddgen: { code: 0, signal: null },
      playwright: { code: 0, signal: null },
      stop: { level: "none" },
    });
    expect(events).toEqual([
      "spawning bddgen",
      "recorded bddgen",
      "started bddgen",
      "spawning playwright",
      "recorded playwright",
      "started playwright",
    ]);
  });

  test("spawns nothing when onSpawning fails for bddgen, and says why", async () => {
    const started: string[] = [];
    const opts = options(
      { exitCode: 0 },
      { exitCode: 0 },
      {
        onSpawning: () =>
          Promise.reject(
            Object.assign(new Error("disk full"), { code: "ENOSPC" }),
          ),
        onProcess: (name) => {
          started.push(name);
        },
      },
    );
    await expect(launchRun(opts)).rejects.toThrow(
      "Recording that the run's bddgen starts failed (ENOSPC): nothing was spawned.",
    );
    expect(started).toEqual([]);
    expect(await readFile(opts.identity.log, "utf8")).toBe("");
  });

  test("never starts the runner when onSpawning fails for it, and ends the run saying why", async () => {
    const started: string[] = [];
    const opts = options(
      { exitCode: 0 },
      { exitCode: 0 },
      {
        onSpawning: (name) => {
          if (name === "playwright")
            throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
        },
        onProcess: (name) => {
          started.push(name);
        },
      },
    );
    const run = await launchRun(opts);
    expect(await run.done).toEqual({
      bddgen: { code: 0, signal: null },
      playwright: {
        code: null,
        signal: null,
        notStarted: "recording that it starts failed (ENOSPC)",
      },
      stop: { level: "none" },
    });
    expect(started).toEqual(["bddgen"]);
    const log = await readFile(opts.identity.log, "utf8");
    expect(log).toContain(
      "playwright could not start: recording that it starts failed (ENOSPC)",
    );
    expect(log).not.toContain("playwright starts:");
  });

  test("never starts the runner when a stop comes while onSpawning is awaited", async () => {
    const started: string[] = [];
    const control: { run?: LaunchedRun } = {};
    const run = await launchRun(
      options(
        { exitCode: 0 },
        { exitCode: 0 },
        {
          onSpawning: async (name) => {
            if (name !== "playwright") return;
            control.run?.stop(
              "drained",
              "stopped while the record was written",
            );
            await delay(20);
          },
          onProcess: (name) => {
            started.push(name);
          },
        },
      ),
    );
    control.run = run;
    const result = await run.done;
    expect(result.playwright).toBeUndefined();
    expect(result.stop.level).toBe("drained");
    expect(started).toEqual(["bddgen"]);
  });

  test("starts our line on a line of its own after output without a newline", async () => {
    const opts = options({}, {});
    const run = await launchRun({
      ...opts,
      commands: {
        ...opts.commands,
        bddgen: {
          file: process.execPath,
          args: [
            "-e",
            "process.stderr.write('Error: no newline'); process.exit(1)",
          ],
        },
      },
    });
    await run.done;
    expect(await readFile(opts.identity.log, "utf8")).toMatch(
      /^Error: no newline\n\[orchestrator\] \S+ bddgen exited with code 1$/m,
    );
  });

  test("refuses a folder already holding a log — a file, a symlink or a FIFO — never following nor waiting on it", async () => {
    const opts = options({ exitCode: 0 }, { exitCode: 0 });
    await mkdir(opts.identity.dir, { recursive: true, mode: 0o700 });
    const victim = join(root, "victim");
    await writeFile(victim, "victim\n");
    await symlink(victim, opts.identity.log);
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
    expect(await readFile(victim, "utf8")).toBe("victim\n");
    await rm(opts.identity.log);
    execFileSync("mkfifo", [opts.identity.log]);
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
  });

  test("refuses a run folder that is a link — even a dangling one — or a folder open to others, writing nothing through it", async () => {
    const opts = options({ exitCode: 0 }, { exitCode: 0 });
    const elsewhere = join(root, "elsewhere");
    await mkdir(elsewhere, { mode: 0o700 });
    await mkdir(join(root, "runs"), { recursive: true });
    await symlink(elsewhere, opts.identity.dir);
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
    expect(await readdir(elsewhere)).toEqual([]);
    await rm(opts.identity.dir);
    await symlink(join(root, "nowhere"), opts.identity.dir);
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
    expect(existsSync(join(root, "nowhere"))).toBe(false);
    await rm(opts.identity.dir);
    await mkdir(opts.identity.dir, { mode: 0o700 });
    await chmod(opts.identity.dir, 0o755);
    await expect(launchRun(opts)).rejects.toThrow(/folder is already there/);
  });

  test("makes the run's folder, and runs/ when missing, private under umask 0", async () => {
    const previous = process.umask(0);
    try {
      const opts = options({ exitCode: 1 }, {});
      await (
        await launchRun(opts)
      ).done;
      expect((await stat(opts.identity.dir)).mode & 0o777).toBe(0o700);
      expect((await stat(join(root, "runs"))).mode & 0o777).toBe(0o700);
    } finally {
      process.umask(previous);
    }
  });
});

test.describe("openRunLog", () => {
  let dir: string;
  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-run-log-"));
  });
  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates a new log, 0600 under umask 0", async () => {
    const previous = process.umask(0);
    try {
      const log = await openRunLog(join(dir, "run.log"));
      await log.close();
      expect((await stat(join(dir, "run.log"))).mode & 0o777).toBe(0o600);
    } finally {
      process.umask(previous);
    }
  });

  test("refuses anything already there — a file, a link, a FIFO — never writing through nor waiting on it", async () => {
    const path = join(dir, "run.log");
    await writeFile(path, "earlier\n");
    await expect(openRunLog(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("earlier\n");
    await rm(path);
    const victim = join(dir, "victim");
    await writeFile(victim, "victim\n");
    await symlink(victim, path);
    await expect(openRunLog(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(victim, "utf8")).toBe("victim\n");
    await rm(path);
    await symlink(join(dir, "nowhere"), path);
    await expect(openRunLog(path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    await rm(path);
    execFileSync("mkfifo", [path]);
    await expect(openRunLog(path)).rejects.toMatchObject({ code: "EEXIST" });
  });
});

test.describe("stopLine", () => {
  test("says the stop taken, and once the runner exited on its own, what was done instead", () => {
    const taken = { level: "drained", why: "SIGINT" } as const;
    expect(
      stopLine(
        { phase: { name: "playwright", pid: 200 }, taken },
        "drained",
        "SIGINT",
      ),
    ).toBe("stop: drained — SIGINT");
    const lingering = {
      phase: { name: "lingering", pgid: 200, asked: "interrupted" },
      taken: { level: "none" },
    } as const;
    expect(stopLine(lingering, "interrupted", "again")).toBe(
      "stop: interrupted asked once the runner had exited on its own: nothing left to stop, its own end stands — again",
    );
    expect(
      stopLine(
        { ...lingering, phase: { ...lingering.phase, asked: "killed" } },
        "killed",
        "kill",
      ),
    ).toBe(
      "stop: killed asked once the runner had exited on its own: what is left of its process group killed, its own end stands — kill",
    );
  });
});

test.describe("describeCommand", () => {
  test("quotes only the arguments a reader would split", () => {
    expect(
      describeCommand({
        file: "/usr/bin/node",
        args: ["cli.js", "--grep=@smoke and more", "", 'a"b'],
      }),
    ).toBe('/usr/bin/node cli.js "--grep=@smoke and more" "" "a\\"b"');
  });
});

test.describe("runFolderRefusal", () => {
  test("names the owner of a folder of another user's, and the mode of one open to others, each with its repair", () => {
    expect(
      runFolderRefusal(
        "/s/runs/bpng-1",
        {
          kind: "notOwn",
          uid: 0,
          mode: 0o700,
        },
        "alice",
      ),
    ).toBe(
      "The run's folder must be this user's alone (mode 0700): /s/runs/bpng-1 is owned by uid 0, not this user (sudo chown alice /s/runs/bpng-1).",
    );
    expect(
      runFolderRefusal(
        "/s/runs/bpng-1",
        {
          kind: "notOwn",
          uid: 0,
          mode: 0o755,
        },
        "alice",
      ),
    ).toBe(
      "The run's folder must be this user's alone (mode 0700): /s/runs/bpng-1 is owned by uid 0, not this user (sudo chown alice /s/runs/bpng-1 && chmod 700 /s/runs/bpng-1).",
    );
    expect(
      runFolderRefusal("/s/runs/bpng-1", { kind: "open", mode: 0o755 }),
    ).toBe(
      "The run's folder must be this user's alone (mode 0700): /s/runs/bpng-1 is mode 755 (chmod 700 /s/runs/bpng-1).",
    );
    expect(runFolderRefusal("/s/runs/bpng-1", { kind: "notFolder" })).toBe(
      "The run's folder is not a folder: /s/runs/bpng-1.",
    );
  });
});
