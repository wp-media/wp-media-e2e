import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  endsWithin,
  writeAllureResults,
  writeAllureStub,
} from "../../src/common/__fixtures__/allure";
import {
  removeTempRoot,
  tempRoot,
} from "../../src/common/__fixtures__/report-tree";
import { ReportBundleAbortedError } from "../../src/common/reporting/bundle-errors";
import {
  buildReportBundle,
  KILL_GRACE_MS,
  releaseLeftoverWorkDirs,
  type ReportBundle,
  type ReportBundleOptions,
} from "../../src/common/reporting/report-bundle";
import {
  BUNDLE_BUDGET_MS,
  bundleCommand,
  bundleSettings,
  DEFAULT_BUNDLE,
  downloadCommand,
  eventBundle,
  folderCommand,
  prepareBundle,
  runBundleName,
  sweepCellLeftovers,
  type CellSweep,
  type PrepareBundleInput,
} from "./bundle";

/**
 * The run's download bundle: its settings and name, the command that fetches it — run for real in
 * every shell here against a stub `scp` —, the sweep of killed builds' leftovers, and its preparation
 * within the budget and the run's stop.
 */

const RUN_ID = "2026-10-13T10-15-31-042Z-bpng-12";
const NAME = `backwpup-pro@nginx-${RUN_ID}`;

let root = "";
let cellDir = "";
let runDir = "";
let stubDir = "";

test.beforeEach(() => {
  // A space and a quote in every path: a checkout under "Sandy's Projects", say.
  root = tempRoot("e2e r3 'q ");
  cellDir = join(root, "reports", "backwpup", "pro@nginx");
  runDir = join(cellDir, RUN_ID);
  stubDir = join(root, "stub bin");
  mkdirSync(join(runDir, "playwright"), { recursive: true });
  writeFileSync(join(runDir, "playwright", "index.html"), "<html>pw</html>");
  mkdirSync(stubDir, { recursive: true });
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** A pid no process has: a child that already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** A sweep that finds every folder idle: its clock is an hour ahead. */
const IDLE: CellSweep = { idleMs: 60_000, now: () => Date.now() + 3_600_000 };

/**
 * Sets the modification time of a folder and of everything in it.
 *
 * @param dir - the folder.
 * @param at - the time.
 */
function touchTree(dir: string, at: Date): void {
  for (const name of readdirSync(dir, { recursive: true })) {
    utimesSync(join(dir, String(name)), at, at);
  }
  utimesSync(dir, at, at);
}

/** The run folder's hidden entries: work folders a build left. */
function hiddenEntries(dir = runDir): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("."));
}

test.describe("settings, name and the event's bundle", () => {
  test("defaults to an archive with Allure's traces stripped; each choice is kept", () => {
    expect(bundleSettings(undefined)).toEqual(DEFAULT_BUNDLE);
    expect(DEFAULT_BUNDLE).toEqual({ mode: "archive", traces: "strip" });
    expect(bundleSettings({ sshHost: "h" })).toEqual(DEFAULT_BUNDLE);
    expect(bundleSettings({ bundle: { mode: "folder" } })).toEqual({
      mode: "folder",
      traces: "strip",
    });
    expect(bundleSettings({ bundle: { traces: "keep" } })).toEqual({
      mode: "archive",
      traces: "keep",
    });
    expect(BUNDLE_BUDGET_MS).toBe(240_000);
  });

  test("names a bundle <product>-<cell>-<RUN_ID>", () => {
    expect(runBundleName("backwpup", "pro@nginx", RUN_ID)).toBe(NAME);
  });

  test("the event names the archive when there is one, else the folder, else nothing", () => {
    const archive = { path: "/r/report.tar.gz", bytes: 1 };
    const folder = { path: "/r/report", bytes: 2 };
    expect(eventBundle({ name: NAME, archive, folder })).toEqual({
      kind: "archive",
      path: "/r/report.tar.gz",
      name: NAME,
    });
    expect(eventBundle({ name: NAME, archive: null, folder })).toEqual({
      kind: "folder",
      path: "/r/report",
      name: NAME,
    });
    expect(eventBundle({ name: NAME, archive: null, folder: null })).toBe(null);
  });
});

test.describe("bundleCommand and folderCommand", () => {
  test("is exactly: download, unpack, then a plain rm — chained, so a failure keeps the archive", () => {
    expect(bundleCommand("auto-e2e", "/srv/e2e/R/report.tar.gz", NAME)).toBe(
      `scp auto-e2e:/srv/e2e/R/report.tar.gz ${NAME}.tar.gz && tar -xzf ${NAME}.tar.gz && rm ${NAME}.tar.gz`,
    );
  });

  test("quotes a path with a space or a quote, as one shell word", () => {
    expect(bundleCommand("u@h", "/srv/my e2e/it's/report.tar.gz", "n")).toBe(
      `scp u@h:'/srv/my e2e/it'\\''s/report.tar.gz' n.tar.gz && tar -xzf n.tar.gz && rm n.tar.gz`,
    );
    // A name the bundle accepts with a space is quoted too, in every word it appears.
    expect(bundleCommand("h", "/a", "my run")).toBe(
      `scp h:/a 'my run.tar.gz' && tar -xzf 'my run.tar.gz' && rm 'my run.tar.gz'`,
    );
  });

  test("a folder is one scp -r into ./<name>", () => {
    expect(folderCommand("h", "/srv/R/report", NAME)).toBe(
      `scp -r h:/srv/R/report ${NAME}`,
    );
    expect(folderCommand("h", "/s p/report", "a b")).toBe(
      `scp -r h:'/s p/report' 'a b'`,
    );
  });

  test("downloadCommand picks the command for the bundle's kind", () => {
    expect(
      downloadCommand({ kind: "archive", path: "/a.tar.gz", name: "n" }, "h"),
    ).toBe(bundleCommand("h", "/a.tar.gz", "n"));
    expect(
      downloadCommand({ kind: "folder", path: "/r", name: "n" }, "h"),
    ).toBe(folderCommand("h", "/r", "n"));
  });
});

/**
 * Writes a stub `scp` on its own `PATH` folder: `[-r] host:path dest`, copying `path` to `dest` — or
 * failing before (`fail`), failing after the copy (`fail-after`), or writing garbage (`corrupt`).
 *
 * @param behaviour - what it does.
 * @returns the folder to put first on `PATH`.
 */
function scpStub(behaviour: "ok" | "fail" | "fail-after" | "corrupt"): string {
  const bin = join(root, `scp-${behaviour}`);
  mkdirSync(bin);
  const copy = 'cp $rec "$src" "$2"';
  const body = {
    ok: copy,
    fail: "exit 1",
    "fail-after": `${copy}\nexit 1`,
    corrupt: 'printf "not a gzip" > "$2"',
  }[behaviour];
  writeFileSync(
    join(bin, "scp"),
    `#!/bin/sh\nrec=""\nif [ "$1" = "-r" ]; then rec="-R"; shift; fi\nsrc="\${1#*:}"\n${body}\n`,
  );
  chmodSync(join(bin, "scp"), 0o755);
  return bin;
}

/** Whether a shell is installed here. */
function hasShell(shell: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${shell}`]).status === 0;
}

/**
 * Runs a command as a person pasting it would, in a fresh folder.
 *
 * @param shell - `sh`, `bash` or `zsh`.
 * @param command - the command.
 * @param bin - the stub `scp`'s folder, first on `PATH`.
 * @returns the folder's entries after it, and the command's status.
 */
function paste(
  shell: string,
  command: string,
  bin: string,
): { entries: string[]; status: number | null; local: string } {
  const local = join(root, `local ${shell}`);
  mkdirSync(local);
  const ran = spawnSync(shell, ["-c", command], {
    cwd: local,
    env: { ...process.env, PATH: `${bin}:${String(process.env.PATH)}` },
    timeout: 30_000,
  });
  return { entries: readdirSync(local).sort(), status: ran.status, local };
}

/** Builds this run's real archive, with a stub Allure. */
async function realArchive(): Promise<string> {
  const built = await buildReportBundle({
    runDir,
    name: NAME,
    mode: "archive",
    traces: "strip",
    allureBin: writeAllureStub(stubDir, "ok"),
  });
  if (built.archive === null) throw new Error("no archive");
  return built.archive.path;
}

for (const shell of ["sh", "bash", "zsh"]) {
  test.describe(`the command, pasted in ${shell}`, () => {
    test.skip(!hasShell(shell), `${shell} is not installed`);

    test("leaves ./<name>/index.html and no archive", async () => {
      const archive = await realArchive();
      // The run folder's path holds a space and a quote: the command must quote it.
      expect(archive).toContain("'q ");
      const pasted = paste(
        shell,
        bundleCommand("auto-e2e", archive, NAME),
        scpStub("ok"),
      );
      expect(pasted.status).toBe(0);
      expect(pasted.entries).toEqual([NAME]);
      expect(existsSync(join(pasted.local, NAME, "index.html"))).toBe(true);
      expect(
        existsSync(join(pasted.local, NAME, "playwright", "index.html")),
      ).toBe(true);
    });

    test("a failed download stops there: nothing unpacked, nothing removed", async () => {
      const archive = await realArchive();
      const failed = paste(
        shell,
        bundleCommand("auto-e2e", archive, NAME),
        scpStub("fail-after"),
      );
      expect(failed.status).not.toBe(0);
      expect(failed.entries).toEqual([`${NAME}.tar.gz`]);
    });

    test("a corrupt archive is kept: no folder, no rm", async () => {
      const archive = await realArchive();
      const corrupt = paste(
        shell,
        bundleCommand("auto-e2e", archive, NAME),
        scpStub("corrupt"),
      );
      expect(corrupt.status).not.toBe(0);
      expect(corrupt.entries).toEqual([`${NAME}.tar.gz`]);
    });

    test("a download that never started leaves nothing", async () => {
      const archive = await realArchive();
      const none = paste(
        shell,
        bundleCommand("auto-e2e", archive, NAME),
        scpStub("fail"),
      );
      expect(none.status).not.toBe(0);
      expect(none.entries).toEqual([]);
    });

    test("folder mode leaves ./<name>/index.html", async () => {
      const built = await buildReportBundle({
        runDir,
        name: NAME,
        mode: "folder",
        traces: "strip",
        allureBin: writeAllureStub(stubDir, "ok"),
      });
      if (built.folder === null) throw new Error("no folder");
      const pasted = paste(
        shell,
        folderCommand("auto-e2e", built.folder.path, NAME),
        scpStub("ok"),
      );
      expect(pasted.status).toBe(0);
      expect(pasted.entries).toEqual([NAME]);
      expect(existsSync(join(pasted.local, NAME, "index.html"))).toBe(true);
    });
  });
}

test.describe("sweepCellLeftovers", () => {
  test("releases each run's ended work folders — both kinds —, leaving a live process's", async () => {
    const dead = String(deadPid());
    const other = join(cellDir, "2026-10-12T00-00-00-000Z-bpng-11");
    mkdirSync(join(other, `.bundle-work-${dead}-deadbeef`, "x"), {
      recursive: true,
    });
    mkdirSync(join(other, `.allure-work-${dead}-deadbeef`, "results"), {
      recursive: true,
    });
    // pid 1 runs everywhere, and is never this process: idle as it is, it stays.
    mkdirSync(join(runDir, ".allure-work-1-0123abcd"));

    await sweepCellLeftovers(cellDir, IDLE);

    expect(hiddenEntries(other)).toEqual([]);
    expect(hiddenEntries()).toEqual([".allure-work-1-0123abcd"]);
  });

  test("a dead pid's work folder modified within the idle time stays: another host may be writing it", async () => {
    const dead = String(deadPid());
    const hourAgo = new Date(Date.now() - 3_600_000);
    // Both kinds, each untouched an hour but for one file deep inside, written just now.
    const busyBundle = join(runDir, `.bundle-work-${dead}-0000aaaa`);
    const busyAllure = join(runDir, `.allure-work-${dead}-0000bbbb`);
    for (const busy of [busyBundle, busyAllure]) {
      mkdirSync(join(busy, "deep", "er"), { recursive: true });
      writeFileSync(join(busy, "deep", "er", "part"), "x");
      touchTree(busy, hourAgo);
      writeFileSync(join(busy, "deep", "er", "part"), "xy");
    }
    // One untouched an hour: released.
    const idle = join(runDir, `.bundle-work-${dead}-0000cccc`);
    mkdirSync(join(idle, "deep"), { recursive: true });
    touchTree(idle, hourAgo);

    await sweepCellLeftovers(cellDir, { idleMs: 600_000 });

    expect(hiddenEntries().sort()).toEqual(
      [`.allure-work-${dead}-0000bbbb`, `.bundle-work-${dead}-0000aaaa`].sort(),
    );
  });

  test("visits real run folders only, sorted: never a hidden one, a file or a link", async () => {
    mkdirSync(join(cellDir, ".e2e-removing-1"));
    writeFileSync(join(cellDir, "allure-history.jsonl"), "");
    symlinkSync(root, join(cellDir, "link"));
    mkdirSync(join(cellDir, "a-run"));
    const visited: string[] = [];

    await sweepCellLeftovers(cellDir, IDLE, (dir, sweep) => {
      visited.push(dir);
      expect(sweep).toBe(IDLE);
      // One that fails stops nothing.
      return Promise.reject(new Error("boom"));
    });

    expect(visited).toEqual([join(cellDir, RUN_ID), join(cellDir, "a-run")]);
  });

  test("a stop ends it before its next run folder", async () => {
    mkdirSync(join(cellDir, "a-run"));
    mkdirSync(join(cellDir, "b-run"));
    const stop = new AbortController();
    const visited: string[] = [];

    await sweepCellLeftovers(
      cellDir,
      { idleMs: 0, signal: stop.signal },
      (dir) => {
        visited.push(dir);
        stop.abort();
        return Promise.resolve();
      },
    );

    expect(visited).toEqual([join(cellDir, RUN_ID)]);
  });

  test("a stopped sweep releases no work folder: the release checks the stop before each", async () => {
    const dead = String(deadPid());
    mkdirSync(join(runDir, `.bundle-work-${dead}-0000aaaa`));
    mkdirSync(join(runDir, `.allure-work-${dead}-0000bbbb`));

    await releaseLeftoverWorkDirs(runDir, {
      ...IDLE,
      signal: AbortSignal.abort(),
    });
    // Without an idle time too: the stop alone keeps every folder.
    await releaseLeftoverWorkDirs(runDir, { signal: AbortSignal.abort() });

    expect(hiddenEntries().sort()).toEqual([
      `.allure-work-${dead}-0000bbbb`,
      `.bundle-work-${dead}-0000aaaa`,
    ]);
  });

  test("a cell folder that is gone is nothing to sweep", async () => {
    await expect(
      sweepCellLeftovers(join(root, "gone"), IDLE),
    ).resolves.toBeUndefined();
  });
});

/** A built bundle with an archive, as a stand-in build returns it. */
function built(options: ReportBundleOptions): ReportBundle {
  return {
    name: options.name,
    mode: options.mode,
    archive: { path: join(options.runDir, "report.tar.gz"), bytes: 10 },
    folder: null,
    bytes: 20,
    reports: [],
    skipped: [],
    analyticsLeft: [],
    allureError: null,
  };
}

/** What a preparation said and was asked. */
interface Prepared {
  readonly lines: string[];
  readonly calls: ReportBundleOptions[];
  readonly swept: string[];
  readonly sweeps: CellSweep[];
}

/**
 * Prepares this run's bundle with a stand-in build and sweep, watched.
 *
 * @param more - what to replace.
 * @param build - the build; one that succeeds by default.
 */
function preparing(
  more: Partial<PrepareBundleInput> = {},
  build: (options: ReportBundleOptions) => Promise<ReportBundle> = (options) =>
    Promise.resolve(built(options)),
): { seen: Prepared; done: ReturnType<typeof prepareBundle> } {
  const seen: Prepared = { lines: [], calls: [], swept: [], sweeps: [] };
  const done = prepareBundle({
    reportDir: runDir,
    name: NAME,
    settings: DEFAULT_BUNDLE,
    stop: new AbortController().signal,
    build: (options) => {
      seen.calls.push(options);
      return build(options);
    },
    sweep: (dir, sweep) => {
      seen.swept.push(dir);
      seen.sweeps.push(sweep);
      return Promise.resolve();
    },
    say: (line) => {
      seen.lines.push(line);
    },
    ...more,
  });
  return { seen, done };
}

test.describe("prepareBundle", () => {
  test("builds the run's bundle as configured, after sweeping its cell, and names it for the event", async () => {
    const { seen, done } = preparing({
      settings: { mode: "both", traces: "keep" },
    });
    expect(await endsWithin(done, "the bundle's preparation")).toEqual({
      kind: "archive",
      path: join(runDir, "report.tar.gz"),
      name: NAME,
    });
    expect(seen.swept).toEqual([cellDir]);
    const [call] = seen.calls;
    expect(call).toMatchObject({
      runDir,
      name: NAME,
      mode: "both",
      traces: "keep",
    });
    expect(call?.signal?.aborted).toBe(false);
    call?.log?.("Report bundle: sized");
    expect(seen.lines).toEqual(["Report bundle: sized"]);
  });

  test("none builds nothing and says nothing", async () => {
    const { seen, done } = preparing({
      settings: { mode: "none", traces: "strip" },
    });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen).toEqual({ lines: [], calls: [], swept: [], sweeps: [] });
  });

  test("a run already stopped past a drain sweeps and builds nothing, and says why", async () => {
    const stop = new AbortController();
    stop.abort("a SIGINT while draining");
    const { seen, done } = preparing({ stop: stop.signal });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.calls).toEqual([]);
    expect(seen.swept).toEqual([]);
    expect(seen.lines).toEqual([
      "no report bundle: the run was stopped: a SIGINT while draining",
    ]);
  });

  test("a run with no report folder builds nothing", async () => {
    const { seen, done } = preparing({ reportDir: join(cellDir, "gone") });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.calls).toEqual([]);
    expect(seen.lines).toEqual([
      "no report bundle: the run left no report folder",
    ]);
  });

  test("a build that fails is a line and no bundle, never a rejection", async () => {
    const { seen, done } = preparing({}, () =>
      Promise.reject(new Error("tar failed: exit code 2")),
    );
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.lines).toEqual(["no report bundle: tar failed: exit code 2"]);
  });

  test("a build over its budget is stopped, and says so", async () => {
    const { seen, done } = preparing(
      { budgetMs: 1_000 },
      (options) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new ReportBundleAbortedError());
          });
        }),
    );
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.lines).toEqual([
      "no report bundle: it took over 1 s, so it was stopped",
    ]);
  });

  test("a stop mid-build ends it, and says why", async () => {
    const stop = new AbortController();
    const { seen, done } = preparing(
      { stop: stop.signal },
      (options) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new ReportBundleAbortedError());
          });
          stop.abort("killed: a SIGINT while interrupting");
        }),
    );
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.lines).toEqual([
      "no report bundle: the run was stopped: killed: a SIGINT while interrupting",
    ]);
  });

  test("a bundle built in time leaves no budget armed on its signal", async () => {
    const { seen, done } = preparing({ budgetMs: 50 });
    await endsWithin(done, "the bundle's preparation");
    await new Promise((settle) => setTimeout(settle, 120));
    expect(seen.calls[0]?.signal?.aborted).toBe(false);
  });

  test("the budget is armed before the sweep: the sweep gets its signal, and an idle time of the budget plus the kill's grace", async () => {
    const { seen, done } = preparing({ budgetMs: 1_000 });
    await endsWithin(done, "the bundle's preparation");
    const [sweep] = seen.sweeps;
    expect(sweep?.idleMs).toBe(1_000 + KILL_GRACE_MS);
    expect(sweep?.signal).toBe(seen.calls[0]?.signal);
  });

  test("a sweep that outlasts the budget is stopped, and no build starts", async () => {
    const { seen, done } = preparing({
      budgetMs: 1_000,
      sweep: (_dir, sweep) =>
        new Promise((settle) => {
          sweep.signal?.addEventListener("abort", () => {
            settle();
          });
        }),
    });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.calls).toEqual([]);
    expect(seen.lines).toEqual([
      "no report bundle: it took over 1 s, so it was stopped",
    ]);
  });

  test("a stop during the sweep: no build starts, and it says why", async () => {
    const stop = new AbortController();
    const { seen, done } = preparing({
      stop: stop.signal,
      sweep: () => {
        stop.abort("killed: a SIGINT while interrupting");
        return Promise.resolve();
      },
    });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.calls).toEqual([]);
    expect(seen.lines).toEqual([
      "no report bundle: the run was stopped: killed: a SIGINT while interrupting",
    ]);
  });

  test("a sweep that fails stops nothing: the bundle is built", async () => {
    const { seen, done } = preparing({
      sweep: () => Promise.reject(new Error("EIO")),
    });
    expect(await endsWithin(done, "the bundle's preparation")).not.toBeNull();
    expect(seen.calls).toHaveLength(1);
    expect(seen.lines).toEqual([]);
  });

  test("a stop with no reason of its own says only that the run was stopped", async () => {
    const { seen, done } = preparing({ stop: AbortSignal.abort() });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.lines).toEqual(["no report bundle: the run was stopped"]);
  });

  test("a build both over its budget and stopped names the budget", async () => {
    const stop = new AbortController();
    const { seen, done } = preparing(
      { stop: stop.signal, budgetMs: 1_000 },
      (options) =>
        new Promise((_, reject) => {
          options.signal?.addEventListener("abort", () => {
            stop.abort("killed");
            reject(new ReportBundleAbortedError());
          });
        }),
    );
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.lines).toEqual([
      "no report bundle: it took over 1 s, so it was stopped",
    ]);
  });

  test("a report path that is a file is no report folder: nothing is swept or built", async () => {
    const file = join(cellDir, "a-file");
    writeFileSync(file, "");
    const { seen, done } = preparing({ reportDir: file });
    expect(await endsWithin(done, "the bundle's preparation")).toBeNull();
    expect(seen.swept).toEqual([]);
    expect(seen.calls).toEqual([]);
    expect(seen.lines).toEqual([
      "no report bundle: the run left no report folder",
    ]);
  });

  test("with the real build: a hung Allure over the budget leaves no bundle and no temp output", async () => {
    writeAllureResults(join(runDir, "allure-results"));
    const before = readdirSync(runDir).sort();
    const lines: string[] = [];
    const bundle = await endsWithin(
      prepareBundle({
        reportDir: runDir,
        name: NAME,
        settings: DEFAULT_BUNDLE,
        stop: new AbortController().signal,
        budgetMs: 1_000,
        build: (options) =>
          buildReportBundle({
            ...options,
            allureBin: writeAllureStub(stubDir, "hang"),
          }),
        say: (line) => {
          lines.push(line);
        },
      }),
      "the bundle's preparation",
    );
    expect(bundle).toBeNull();
    expect(lines).toEqual([
      "no report bundle: it took over 1 s, so it was stopped",
    ]);
    expect(readdirSync(runDir).sort()).toEqual(before);
  });
});
