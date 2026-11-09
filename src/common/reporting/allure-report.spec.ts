import { test, expect } from "@playwright/test";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rename } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  STUB_OUTPUT_HEAD,
  stubCalls,
  writeAllureResults,
  writeAllureStub,
} from "../__fixtures__/allure";
import { releaseFifoReader } from "../__fixtures__/fifo";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  AllureCliMissingError,
  AllureGenerationAbortedError,
  AllureGenerationFailedError,
  AllureResultsMissingError,
  MalformedAllureResultError,
} from "./allure-errors";
import {
  DEFAULT_ALLURE_BIN,
  DEFAULT_ALLURE_CONFIG,
  OUTPUT_TAIL_BYTES,
  allureEnv,
  allureGenerateArgs,
  decodeTail,
  generateAllureReport,
  isProcessAlive,
  keepTail,
  placeHistory,
  placeReport,
  releaseWorkDir,
  staleWorkDirNames,
  type AllureReportOptions,
  type Move,
} from "./allure-report";

/**
 * Generating one run's Allure report: against a stub CLI for what the module does around Allure
 * (copies, placement, history, failures, stops, kills), and against the real CLI for what Allure
 * makes of it (layouts, names, history, two cells at once, paths with spaces).
 */

let root = "";
let cellDir = "";
let runDir = "";
let stubDir = "";

test.beforeEach(() => {
  // A space in every path: the report root of a checkout under "My Projects", say.
  root = tempRoot("e2e allure report ");
  cellDir = join(root, "backwpup", "pro@nginx");
  runDir = join(cellDir, "2026-10-22T10-04-03-625Z-26885");
  writeAllureResults(join(runDir, "allure-results"));
  stubDir = join(root, "stub bin");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** The options for this test's run, with the given CLI (the real one when `undefined`). */
function options(
  allureBin: string | undefined,
  extra: Partial<AllureReportOptions> = {},
): AllureReportOptions {
  return {
    runDir,
    resultsDir: join(runDir, "allure-results"),
    outputDir: join(runDir, "allure"),
    name: "BackWPup · pro@nginx · run 1",
    historyPath: join(cellDir, "allure-history.jsonl"),
    traces: "strip",
    allureBin,
    ...extra,
  };
}

/** The run folder's hidden work folders. */
function workDirs(): string[] {
  return readdirSync(runDir).filter((name) => name.startsWith(".allure-work-"));
}

/** A previous report and a two-line history, to prove a failure leaves them as they were. */
function writePrevious(): { report: string; history: string } {
  mkdirSync(join(runDir, "allure"), { recursive: true });
  writeFileSync(join(runDir, "allure", "old.html"), "previous report");
  const history = '{"name":"one"}\n{"name":"two"}\n';
  writeFileSync(join(cellDir, "allure-history.jsonl"), history);
  return { report: "previous report", history };
}

/** Asserts the previous report and history are exactly as {@link writePrevious} left them. */
function expectPreviousUntouched(previous: {
  report: string;
  history: string;
}): void {
  expect(readdirSync(join(runDir, "allure"))).toEqual(["old.html"]);
  expect(readFileSync(join(runDir, "allure", "old.html"), "utf8")).toBe(
    previous.report,
  );
  expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
    previous.history,
  );
}

/** Waits until the stub has recorded its call (it then hangs), and returns it. */
async function stubStarted(): Promise<{ pid: number; cwd: string }> {
  await expect.poll(() => stubCalls(stubDir).length).toBe(1);
  const call = stubCalls(stubDir)[0];
  if (call === undefined) throw new Error("no stub call");
  return call;
}

/** A pid no process has: a child that already ended. */
function deadPid(): number {
  const ended = spawnSync(process.execPath, ["-e", ""]);
  return ended.pid;
}

/**
 * Leaves the work folder a generation killed between moving the old report aside and moving the new
 * one in leaves: the old report in `previous/`, its place recorded in `target`.
 *
 * @param pid - the pid it is named for.
 * @param target - the recorded place; none recorded when `undefined`.
 * @returns the folder's name.
 */
function leftAside(pid: number, target: string | undefined): string {
  const name = `.allure-work-${String(pid)}-deadbeef`;
  mkdirSync(join(runDir, name, "previous"), { recursive: true });
  writeFileSync(join(runDir, name, "previous", "old.html"), "previous report");
  if (target !== undefined) writeFileSync(join(runDir, name, "target"), target);
  return name;
}

/** A filesystem error with a code, as `fs.rename` rejects with. */
function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: refused`), { code });
}

/** The cell's history, one parsed line per entry. */
function historyLines(): { e2eRun?: string; timestamp?: number }[] {
  return readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { e2eRun?: string; timestamp?: number });
}

/** The charts a folder report's dashboard draws, in its layout's order. */
function dashboardCharts(run: string): { type: string; data: unknown[] }[] {
  const charts = JSON.parse(
    readFileSync(
      join(run, "allure", "dashboard", "widgets", "charts.json"),
      "utf8",
    ),
  ) as { general: Record<string, { type: string; data: unknown[] }> };
  return Object.values(charts.general);
}

/** Whether this process runs as root, which may signal any process. */
const isRoot = process.getuid?.() === 0;

test.describe("pure parts", () => {
  test("allureGenerateArgs: results, output, config and name, in that order", () => {
    expect(
      allureGenerateArgs({
        resultsDir: "/r",
        outputDir: "/o",
        configPath: "/c.mjs",
        name: "a name; with spaces",
      }),
    ).toEqual([
      "generate",
      "/r",
      "-o",
      "/o",
      "-c",
      "/c.mjs",
      "--name",
      "a name; with spaces",
    ]);
  });

  test("allureEnv: the caller's environment plus the history and the layout switch", () => {
    const base = { PATH: "/bin", ALLURE_HISTORY: "/stale" };
    expect(allureEnv(base, "/h.jsonl", "single-file")).toEqual({
      PATH: "/bin",
      ALLURE_HISTORY: "/h.jsonl",
      ALLURE_SINGLE_FILE: "true",
    });
    expect(allureEnv(base, "/h.jsonl", "folder").ALLURE_SINGLE_FILE).toBe(
      "false",
    );
    expect(base.ALLURE_HISTORY).toBe("/stale");
  });

  test("staleWorkDirNames: work folders of dead processes, and this process's unused ones", () => {
    const alive = new Set([100, 300]);
    expect(
      staleWorkDirNames(
        [
          ".allure-work-100-0123abcd",
          ".allure-work-200-0123abcd",
          ".allure-work-200-0123ABCD",
          ".allure-work-x-0123abcd",
          ".pruning-1-2-0123abcd",
          "allure",
          // This process (300): one in use, one an earlier generation left.
          ".allure-work-300-0123abcd",
          ".allure-work-300-4567abcd",
        ],
        {
          isAlive: (pid) => alive.has(pid),
          ownPid: 300,
          active: new Set([".allure-work-300-0123abcd"]),
        },
      ),
    ).toEqual([".allure-work-200-0123abcd", ".allure-work-300-4567abcd"]);
  });

  test("isProcessAlive: this process is, an ended child is not", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(deadPid())).toBe(false);
  });

  test("isProcessAlive: another user's process is (the signal is refused, EPERM)", () => {
    test.skip(isRoot, "root may signal any process");
    // pid 1 (init, launchd) is root's, everywhere.
    expect(isProcessAlive(1)).toBe(true);
  });

  test("keepTail: the last bytes, at most the limit, across chunks", () => {
    let tail: Buffer = Buffer.alloc(0);
    for (const chunk of ["abc", "defg", "hi"]) {
      tail = keepTail(tail, Buffer.from(chunk), 5);
    }
    expect(tail.toString()).toBe("efghi");
    expect(keepTail(Buffer.alloc(0), Buffer.from("ab"), 5).toString()).toBe(
      "ab",
    );
    expect(OUTPUT_TAIL_BYTES).toBe(16 * 1024);
  });

  test("decodeTail: a character cut by the limit is skipped, one split across chunks is whole", () => {
    // "é" is two bytes: a 3-byte tail of "éé" starts mid-character.
    const cut = keepTail(Buffer.alloc(0), Buffer.from("éé"), 3);
    expect(decodeTail(cut)).toBe("é");
    // "€" is three bytes, split between two chunks.
    const euro = Buffer.from("a€");
    const split = keepTail(
      keepTail(Buffer.alloc(0), euro.subarray(0, 2)),
      euro.subarray(2),
    );
    expect(decodeTail(split)).toBe("a€");
    expect(decodeTail(Buffer.alloc(0))).toBe("");
  });
});

test.describe("generateAllureReport, with a stub CLI", () => {
  test("generates from a stripped copy, puts the report in place and appends the history", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const before = readdirSync(join(runDir, "allure-results")).sort();
    writeFileSync(join(cellDir, "allure-history.jsonl"), '{"name":"one"}\n');

    const report = await generateAllureReport(options(bin));

    expect(report).toEqual({
      results: 2,
      strippedTraces: 3,
      skipped: [],
      outputDir: join(runDir, "allure"),
      historyPath: join(cellDir, "allure-history.jsonl"),
      layout: "single-file",
      // The stub's page has no analytics loader.
      analytics: { cleaned: [], left: [] },
    });
    expect(
      readFileSync(join(runDir, "allure", "awesome", "index.html"), "utf8"),
    ).toBe("<title>BackWPup · pro@nginx · run 1</title>");
    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      // Allure's line, tagged with the run it reports.
      `{"name":"one"}\n{"name":"BackWPup · pro@nginx · run 1","e2eRun":"${basename(runDir)}"}\n`,
    );
    const [call] = stubCalls(stubDir);
    // Allure saw the copy, never the run's own results, nor the cell's own history.
    expect(call?.args[1]).not.toBe(join(runDir, "allure-results"));
    expect(call?.results).not.toContain("b2-attachment.zip");
    expect(call?.history).not.toBe(join(cellDir, "allure-history.jsonl"));
    expect(call?.singleFile).toBe("true");
    expect(call?.args.slice(-2)).toEqual([
      "--name",
      "BackWPup · pro@nginx · run 1",
    ]);
    expect(readdirSync(join(runDir, "allure-results")).sort()).toEqual(before);
    expect(workDirs()).toEqual([]);
  });

  test("keep: generates from every result and attachment, as a folder report by default", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    const report = await generateAllureReport(options(bin, { traces: "keep" }));

    expect(report.layout).toBe("folder");
    expect(report.strippedTraces).toBe(0);
    const [call] = stubCalls(stubDir);
    expect(call?.singleFile).toBe("false");
    expect(call?.results).toEqual(
      readdirSync(join(runDir, "allure-results")).sort(),
    );
  });

  test("an explicit layout wins over the traces' default", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    await generateAllureReport(
      options(bin, { traces: "keep", layout: "single-file" }),
    );

    expect(stubCalls(stubDir)[0]?.singleFile).toBe("true");
  });

  test("creates the history on a cell's first report", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    await generateAllureReport(options(bin));

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      `{"name":"BackWPup · pro@nginx · run 1","e2eRun":"${basename(runDir)}"}\n`,
    );
  });

  test("a run reported again keeps one history line: its own, in its place and time", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const run = basename(runDir);
    const other = `{"name":"other","timestamp":9,"e2eRun":"other-run"}\n`;
    writeFileSync(
      join(cellDir, "allure-history.jsonl"),
      `{"name":"untagged"}\n{"name":"first","timestamp":5,"e2eRun":"${run}"}\n${other}`,
    );

    await generateAllureReport(options(bin));
    await generateAllureReport(options(bin));

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      `{"name":"untagged"}\n` +
        `{"name":"BackWPup · pro@nginx · run 1","e2eRun":"${run}","timestamp":5}\n${other}`,
    );
  });

  test("replaces an existing report whole: nothing of the old one is left", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    writePrevious();

    await generateAllureReport(options(bin));

    expect(readdirSync(join(runDir, "allure"))).toEqual(["awesome"]);
    expect(workDirs()).toEqual([]);
  });

  test("a failing Allure leaves the previous report and history untouched, and says why", async () => {
    const bin = writeAllureStub(stubDir, "fail");
    const previous = writePrevious();

    const error = await generateAllureReport(options(bin)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AllureGenerationFailedError);
    expect((error as AllureGenerationFailedError).exitCode).toBe(3);
    expect((error as AllureGenerationFailedError).output).toContain(
      "stub: generation exploded",
    );
    // The message is for a log line: no Allure output, no command line.
    expect((error as Error).message).not.toContain("exploded");
    expect((error as Error).message).not.toContain("--name");
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a missing CLI is its own error, and nothing is put in place", async () => {
    const previous = writePrevious();
    const missing = join(stubDir, "no-allure");

    const error = await generateAllureReport(options(missing)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AllureCliMissingError);
    expect((error as AllureCliMissingError).code).toBe("ENOENT");
    expect((error as Error).message).toContain(missing);
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a CLI that is not executable is the same error", async () => {
    mkdirSync(stubDir, { recursive: true });
    const notExecutable = join(stubDir, "allure");
    writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });

    const error = await generateAllureReport(options(notExecutable)).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(AllureCliMissingError);
    expect((error as AllureCliMissingError).code).toBe("EACCES");
  });

  test("results with nothing to report never reach Allure, which would report them as empty", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const previous = writePrevious();
    const emptyRun = join(cellDir, "empty-run");
    mkdirSync(join(emptyRun, "allure-results"), { recursive: true });

    await expect(
      generateAllureReport(
        options(bin, {
          runDir: emptyRun,
          resultsDir: join(emptyRun, "allure-results"),
          outputDir: join(runDir, "allure"),
        }),
      ),
    ).rejects.toBeInstanceOf(AllureResultsMissingError);
    expect(stubCalls(stubDir)).toEqual([]);
    expectPreviousUntouched(previous);
    expect(readdirSync(emptyRun)).toEqual(["allure-results"]);
  });

  test("a malformed result never reaches Allure, which would skip it and exit 0", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const previous = writePrevious();
    writeFileSync(join(runDir, "allure-results", "zzzz-result.json"), "{");

    await expect(generateAllureReport(options(bin))).rejects.toBeInstanceOf(
      MalformedAllureResultError,
    );
    expect(stubCalls(stubDir)).toEqual([]);
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a blank name is refused before anything is done", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    await expect(
      generateAllureReport(options(bin, { name: "  " })),
    ).rejects.toBeInstanceOf(RangeError);
    expect(existsSync(join(runDir, "allure"))).toBe(false);
  });

  test("a missing run folder is a clear error", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    await expect(
      generateAllureReport(options(bin, { runDir: join(cellDir, "gone") })),
    ).rejects.toThrow(/Cannot work in the run folder .*gone \(ENOENT\)/);
  });

  test("a stop mid-generation kills Allure and puts nothing in place", async () => {
    const bin = writeAllureStub(stubDir, "hang");
    const previous = writePrevious();
    const stop = new AbortController();

    const generating = generateAllureReport(
      options(bin, { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const { pid } = await stubStarted();
    stop.abort();

    expect(await generating).toBeInstanceOf(AllureGenerationAbortedError);
    expect(isProcessAlive(pid)).toBe(false);
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a stop before it starts runs nothing", async () => {
    const bin = writeAllureStub(stubDir, "ok");

    await expect(
      generateAllureReport(options(bin, { signal: AbortSignal.abort() })),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);
    expect(stubCalls(stubDir)).toEqual([]);
    expect(workDirs()).toEqual([]);
  });

  test("a generation killed outright leaves the previous report; the next one removes its work folder", async () => {
    const hang = writeAllureStub(stubDir, "hang");
    const previous = writePrevious();
    const module = pathToFileURL(join(import.meta.dirname, "allure-report.ts"));
    // A process of its own, so it can be killed as a crash or `kill -9` would end it.
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `const { generateAllureReport } = await import(${JSON.stringify(module.href)});
         await generateAllureReport(${JSON.stringify(options(hang))});`,
      ],
      { stdio: "ignore" },
    );
    const ended = new Promise((settle) => child.once("close", settle));
    const { pid } = await stubStarted();
    child.kill("SIGKILL");
    process.kill(pid, "SIGKILL");
    await ended;

    expectPreviousUntouched(previous);
    expect(workDirs()).toHaveLength(1);

    await generateAllureReport(options(writeAllureStub(stubDir, "ok")));
    expect(workDirs()).toEqual([]);
    expect(readdirSync(join(runDir, "allure"))).toEqual(["awesome"]);
  });

  test("leaves a work folder whose process still runs", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    // pid 1 runs everywhere, and is never this process.
    const live = `.allure-work-1-0123abcd`;
    mkdirSync(join(runDir, live));

    await generateAllureReport(options(bin));

    expect(workDirs()).toEqual([live]);
  });

  test("two generations of one run in one process leave each other's work folder alone", async () => {
    const stop = new AbortController();
    const first = generateAllureReport(
      options(writeAllureStub(stubDir, "hang"), { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    await stubStarted();
    const [working] = workDirs();

    await generateAllureReport(
      options(writeAllureStub(join(root, "other stub"), "ok")),
    );

    expect(workDirs()).toEqual([working]);
    stop.abort();
    expect(await first).toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("a report a killed generation left aside goes back before anything else, even when this one fails", async () => {
    leftAside(deadPid(), join(runDir, "allure"));

    await expect(
      generateAllureReport(options(writeAllureStub(stubDir, "fail"))),
    ).rejects.toBeInstanceOf(AllureGenerationFailedError);

    expect(readFileSync(join(runDir, "allure", "old.html"), "utf8")).toBe(
      "previous report",
    );
    expect(workDirs()).toEqual([]);
  });

  test("a report left aside by this process's earlier generation goes back too", async () => {
    leftAside(process.pid, join(runDir, "allure"));

    await expect(
      generateAllureReport(options(writeAllureStub(stubDir, "fail"))),
    ).rejects.toBeInstanceOf(AllureGenerationFailedError);

    expect(readdirSync(join(runDir, "allure"))).toEqual(["old.html"]);
    expect(workDirs()).toEqual([]);
  });

  test("a report left aside after the new one went in is removed, never put over it", async () => {
    leftAside(deadPid(), join(runDir, "allure"));
    mkdirSync(join(runDir, "allure"));
    writeFileSync(join(runDir, "allure", "new.html"), "new report");

    await expect(
      generateAllureReport(options(writeAllureStub(stubDir, "fail"))),
    ).rejects.toBeInstanceOf(AllureGenerationFailedError);

    expect(readdirSync(join(runDir, "allure"))).toEqual(["new.html"]);
    expect(workDirs()).toEqual([]);
  });

  test("a report left aside with no recorded place is kept where it is", async () => {
    const kept = leftAside(deadPid(), undefined);

    await generateAllureReport(options(writeAllureStub(stubDir, "ok")));

    expect(workDirs()).toEqual([kept]);
    expect(
      readFileSync(join(runDir, kept, "previous", "old.html"), "utf8"),
    ).toBe("previous report");
  });

  test("works in an owner-only folder that records the report's place, and runs Allure in it", async () => {
    const stop = new AbortController();
    const generating = generateAllureReport(
      options(writeAllureStub(stubDir, "hang"), { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const { cwd } = await stubStarted();
    const [work] = workDirs();
    if (work === undefined) throw new Error("no work folder");

    expect(statSync(join(runDir, work)).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(runDir, work, "target"), "utf8")).toBe(
      join(runDir, "allure"),
    );
    expect(cwd).toBe(realpathSync(join(runDir, work)));

    stop.abort();
    expect(await generating).toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("a stop waits for Allure to end, so nothing writes into the work folder once it is gone", async () => {
    const stop = new AbortController();
    const generating = generateAllureReport(
      options(writeAllureStub(stubDir, "slow-stop"), { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const { pid } = await stubStarted();
    stop.abort();

    expect(await generating).toBeInstanceOf(AllureGenerationAbortedError);
    // Ended before the generation did: its late write landed in a folder removed after it.
    expect(isProcessAlive(pid)).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  test("a stop while the history is read runs nothing", async () => {
    // A history that blocks its reader until something opens it for writing.
    const fifo = join(cellDir, "allure-history.jsonl");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const stop = new AbortController();

    const generating = generateAllureReport(
      options(writeAllureStub(stubDir, "ok"), { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    stop.abort();
    await releaseFifoReader(fifo);

    expect(await generating).toBeInstanceOf(AllureGenerationAbortedError);
    expect(stubCalls(stubDir)).toEqual([]);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
    expect(existsSync(join(runDir, "allure"))).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  test("a stop before it starts leaves even a dead generation's work folder alone", async () => {
    const left = leftAside(deadPid(), join(runDir, "allure"));

    await expect(
      generateAllureReport(
        options(writeAllureStub(stubDir, "ok"), {
          signal: AbortSignal.abort(),
        }),
      ),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);

    expect(workDirs()).toEqual([left]);
    expect(existsSync(join(runDir, "allure"))).toBe(false);
  });

  test("an unreadable history fails the generation before Allure runs, and is left as it is", async () => {
    // A folder where the history file should be: it cannot be read, so it is not "absent".
    mkdirSync(join(cellDir, "allure-history.jsonl", "inside"), {
      recursive: true,
    });
    const previous = { report: "previous report" };
    mkdirSync(join(runDir, "allure"));
    writeFileSync(join(runDir, "allure", "old.html"), previous.report);

    const error = await generateAllureReport(
      options(writeAllureStub(stubDir, "ok")),
    ).catch((caught: unknown) => caught);

    expect((error as NodeJS.ErrnoException).code).toMatch(/^E[A-Z]+$/);
    expect(stubCalls(stubDir)).toEqual([]);
    expect(readdirSync(join(cellDir, "allure-history.jsonl"))).toEqual([
      "inside",
    ]);
    expect(readdirSync(join(runDir, "allure"))).toEqual(["old.html"]);
    expect(workDirs()).toEqual([]);
  });

  test("the analytics cleanup runs before the report goes in: a page it cannot read leaves the previous report", async () => {
    test.skip(isRoot, "root reads any file");
    const previous = writePrevious();

    await expect(
      generateAllureReport(
        options(writeAllureStub(stubDir, "unreadable-page")),
      ),
    ).rejects.toMatchObject({ code: "EACCES" });

    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a report that cannot be put in place leaves the history as it was", async () => {
    const history = '{"name":"one"}\n';
    writeFileSync(join(cellDir, "allure-history.jsonl"), history);
    // The report's parent is a file: no folder can go there.
    writeFileSync(join(runDir, "a-file"), "");

    await expect(
      generateAllureReport(
        options(writeAllureStub(stubDir, "ok"), {
          outputDir: join(runDir, "a-file", "allure"),
        }),
      ),
    ).rejects.toThrow(/Cannot put the Allure report in place/);

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      history,
    );
    expect(workDirs()).toEqual([]);
  });

  test("a history that cannot be updated leaves the new report in place, and says so", async () => {
    test.skip(isRoot, "root writes into a read-only folder");
    // Readable, so it is copied; in a read-only folder, so it cannot be replaced.
    const history = '{"name":"one"}\n';
    const readOnly = join(root, "read-only");
    mkdirSync(readOnly);
    writeFileSync(join(readOnly, "allure-history.jsonl"), history);
    chmodSync(readOnly, 0o555);
    try {
      await expect(
        generateAllureReport(
          options(writeAllureStub(stubDir, "ok"), {
            historyPath: join(readOnly, "allure-history.jsonl"),
          }),
        ),
      ).rejects.toThrow(
        /^The Allure report is at .*allure, but the history .* could not be updated \(EACCES\)/,
      );
    } finally {
      // The temporary root's removal needs it writable.
      chmodSync(readOnly, 0o755);
    }

    expect(readFileSync(join(readOnly, "allure-history.jsonl"), "utf8")).toBe(
      history,
    );
    expect(
      readFileSync(join(runDir, "allure", "awesome", "index.html"), "utf8"),
    ).toContain("run 1");
    expect(workDirs()).toEqual([]);
  });

  test("keeps only the end of a failing Allure's output, whole characters only", async () => {
    const error = await generateAllureReport(
      options(writeAllureStub(stubDir, "fail")),
    ).catch((caught: unknown) => caught);

    const { output } = error as AllureGenerationFailedError;
    expect(output.endsWith("stub: generation exploded\n")).toBe(true);
    expect(output).not.toContain(STUB_OUTPUT_HEAD);
    expect(output).not.toContain("\uFFFD");
    expect(Buffer.byteLength(output)).toBeGreaterThan(OUTPUT_TAIL_BYTES - 4);
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(OUTPUT_TAIL_BYTES);
  });
});

test.describe("placing the report and the history", () => {
  let built = "";
  let outputDir = "";
  let aside = "";

  test.beforeEach(() => {
    built = join(root, "work", "report");
    outputDir = join(root, "run", "allure");
    aside = join(root, "work", "previous");
    mkdirSync(built, { recursive: true });
    writeFileSync(join(built, "new.html"), "new");
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(join(outputDir, "old.html"), "old");
  });

  /** A rename that fails the calls `fail` picks, with `code`, and renames for real otherwise. */
  function failing(code: string, fail: (from: string) => boolean): Move {
    return (from, to) =>
      fail(from) ? Promise.reject(errno(code)) : rename(from, to);
  }

  test("placeReport: a new report that cannot go in puts the old one back, and names another filesystem", async () => {
    const error = await placeReport(
      built,
      outputDir,
      aside,
      failing("EXDEV", (from) => from === built),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      `Cannot put the Allure report in place at ${outputDir} (EXDEV: it must be on the run ` +
        "folder's filesystem).",
    );
    expect(readdirSync(outputDir)).toEqual(["old.html"]);
    expect(existsSync(aside)).toBe(false);
  });

  test("placeReport: an old report that cannot be moved aside stops it there", async () => {
    const calls: string[] = [];
    const error = await placeReport(built, outputDir, aside, (from, to) => {
      calls.push(from);
      return from === outputDir
        ? Promise.reject(errno("EACCES"))
        : rename(from, to);
    }).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      `Cannot put the Allure report in place at ${outputDir} (EACCES).`,
    );
    expect(calls).toEqual([outputDir]);
    expect(readdirSync(outputDir)).toEqual(["old.html"]);
  });

  test("placeReport: an old report that cannot be moved back says where it waits; only a later generation puts it back", async () => {
    const work = dirname(aside);
    writeFileSync(join(work, "target"), outputDir);
    const error = await placeReport(
      built,
      outputDir,
      aside,
      failing("EIO", (from) => from === built || from === aside),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).toBe(
      `Cannot put the Allure report in place at ${outputDir} (EIO). The previous report could not ` +
        `be moved back: it waits in ${aside}, and the next generation in this run puts it back.`,
    );
    expect(existsSync(outputDir)).toBe(false);
    // This generation keeps its work folder, the report in it…
    expect(await releaseWorkDir(work, { putBack: false })).toBe(false);
    expect(readdirSync(aside)).toEqual(["old.html"]);
    // …and the next one puts it back.
    expect(await releaseWorkDir(work, { putBack: true })).toBe(true);
    expect(readdirSync(outputDir)).toEqual(["old.html"]);
    expect(existsSync(work)).toBe(false);
  });

  test("placeReport: with no report yet, a failure has nothing to move back", async () => {
    rmSync(outputDir, { recursive: true });
    const error = await placeReport(
      built,
      outputDir,
      aside,
      failing("EXDEV", (from) => from === built),
    ).catch((caught: unknown) => caught);

    expect((error as Error).message).not.toContain("waits in");
    expect(existsSync(outputDir)).toBe(false);
  });

  test("releaseWorkDir: removes a folder with no report aside, keeps one whose place cannot be read", async () => {
    const work = dirname(aside);
    expect(await releaseWorkDir(work, { putBack: true })).toBe(true);
    expect(existsSync(work)).toBe(false);

    mkdirSync(aside, { recursive: true });
    writeFileSync(join(work, "target"), "relative/allure");
    expect(await releaseWorkDir(work, { putBack: true })).toBe(false);
    expect(existsSync(aside)).toBe(true);
  });

  test("releaseWorkDir: keeps a folder it cannot look into", async () => {
    test.skip(isRoot, "root looks into any folder");
    const work = dirname(aside);
    mkdirSync(aside, { recursive: true });
    chmodSync(work, 0o000);
    try {
      expect(await releaseWorkDir(work, { putBack: true })).toBe(false);
    } finally {
      chmodSync(work, 0o700);
    }
    expect(existsSync(aside)).toBe(true);
  });

  test("placeHistory: across filesystems, copies beside the history and renames it", async () => {
    const updated = join(root, "work", "history.jsonl");
    writeFileSync(updated, "updated\n");
    const history = join(root, "cell", "allure-history.jsonl");
    mkdirSync(dirname(history));
    writeFileSync(history, "old\n");

    await placeHistory(
      updated,
      history,
      outputDir,
      failing("EXDEV", (from) => from === updated),
    );

    expect(readFileSync(history, "utf8")).toBe("updated\n");
    expect(readdirSync(dirname(history))).toEqual([basename(history)]);
  });

  test("placeHistory: any other failure says the report is in place and the history is not", async () => {
    const updated = join(root, "work", "history.jsonl");
    writeFileSync(updated, "updated\n");
    const history = join(root, "allure-history.jsonl");

    await expect(
      placeHistory(
        updated,
        history,
        outputDir,
        failing("EACCES", () => true),
      ),
    ).rejects.toThrow(
      `The Allure report is at ${outputDir}, but the history ${history} could not be updated (EACCES).`,
    );
    expect(existsSync(history)).toBe(false);
  });
});

test.describe("generateAllureReport, with the real Allure CLI", () => {
  // The real CLI takes about a second per report.
  test.slow();

  test("strip: one HTML file per plugin, named, with the history appended", async () => {
    const report = await generateAllureReport(options(undefined));

    const output = join(runDir, "allure");
    expect(report.layout).toBe("single-file");
    expect(readdirSync(join(output, "awesome")).sort()).toEqual([
      "index.html",
      "summary.json",
    ]);
    const html = readFileSync(join(output, "awesome", "index.html"), "utf8");
    expect(html).toContain("BackWPup · pro@nginx · run 1");
    // Allure's analytics loader is gone from every page, and only it.
    expect(report.analytics).toEqual({
      cleaned: ["awesome/index.html", "dashboard/index.html"],
      left: [],
    });
    for (const page of [
      "index.html",
      "awesome/index.html",
      "dashboard/index.html",
    ]) {
      expect(readFileSync(join(output, page), "utf8")).not.toContain(
        "googletagmanager",
      );
    }
    const history = readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { name: string });
    expect(history.map((entry) => entry.name)).toEqual([
      "BackWPup · pro@nginx · run 1",
    ]);
    expect(workDirs()).toEqual([]);
  });

  test("allurerc.mjs: one file per plugin when ALLURE_SINGLE_FILE is unset, as a manual `allure generate` runs", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ALLURE_HISTORY: join(root, "manual-history.jsonl"),
    };
    const output = join(root, "manual");

    await promisify(execFile)(
      DEFAULT_ALLURE_BIN,
      [
        "generate",
        join(runDir, "allure-results"),
        "-o",
        output,
        "-c",
        DEFAULT_ALLURE_CONFIG,
      ],
      { env, cwd: root },
    );

    for (const plugin of ["awesome", "dashboard"]) {
      expect(readdirSync(join(output, plugin))).not.toContain("data");
    }
  });

  test("keep: a folder report with its data files, without the analytics loader", async () => {
    const report = await generateAllureReport(
      options(undefined, { traces: "keep" }),
    );

    const awesome = readdirSync(join(runDir, "allure", "awesome"));
    expect(awesome).toContain("data");
    expect(awesome.some((name) => /^app-.*\.js$/.test(name))).toBe(true);
    expect(report.analytics).toEqual({
      cleaned: ["awesome/index.html", "dashboard/index.html"],
      left: [],
    });
    for (const plugin of ["awesome", "dashboard"]) {
      const page = readFileSync(
        join(runDir, "allure", plugin, "index.html"),
        "utf8",
      );
      expect(page).not.toContain("googletagmanager");
      expect(page).toContain('<div id="app"></div>');
    }
    // allurerc.mjs's dashboard layout draws Allure 3's charts: with Allure 2's chart types (`trend`,
    // `pie`) 3.18 writes no charts.json at all, and the dashboard fails to load.
    expect(dashboardCharts(runDir).map((chart) => chart.type)).toEqual([
      "currentStatus",
      "statusDynamics",
    ]);
  });

  test("a run generated again is one trend point: the dashboard's trend counts runs, not generations", async () => {
    const otherRun = join(cellDir, "2026-10-22T11-00-00-000Z-26886");
    writeAllureResults(join(otherRun, "allure-results"));
    const keep = options(undefined, { traces: "keep" });

    await generateAllureReport(keep);
    const [first] = historyLines();
    await generateAllureReport(keep);
    await generateAllureReport({
      ...keep,
      runDir: otherRun,
      resultsDir: join(otherRun, "allure-results"),
      outputDir: join(otherRun, "allure"),
    });

    // Allure read the tagged history, and wrote one line per run; the first keeps its time.
    const lines = historyLines();
    expect(lines.map((line) => line.e2eRun)).toEqual([
      basename(runDir),
      basename(otherRun),
    ]);
    expect(lines[0]?.timestamp).toBe(first?.timestamp);
    const trend = dashboardCharts(otherRun).find(
      (chart) => chart.type === "statusDynamics",
    );
    // The earlier run once, and this one.
    expect(trend?.data).toHaveLength(2);
  });

  test("two cells generate at once, each into its own report and history", async () => {
    const otherCell = join(root, "backwpup", "pro@apache");
    const otherRun = join(otherCell, "2026-10-22T10-04-03-625Z-26886");
    writeAllureResults(join(otherRun, "allure-results"));

    await Promise.all([
      generateAllureReport(options(undefined)),
      generateAllureReport(
        options(undefined, {
          runDir: otherRun,
          resultsDir: join(otherRun, "allure-results"),
          outputDir: join(otherRun, "allure"),
          name: "BackWPup · pro@apache",
          historyPath: join(otherCell, "allure-history.jsonl"),
        }),
      ),
    ]);

    for (const [cell, run, name] of [
      [cellDir, runDir, "BackWPup · pro@nginx · run 1"],
      [otherCell, otherRun, "BackWPup · pro@apache"],
    ] as const) {
      expect(
        readFileSync(join(run, "allure", "awesome", "index.html"), "utf8"),
      ).toContain(name);
      const lines = readFileSync(join(cell, "allure-history.jsonl"), "utf8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(name);
    }
  });
});
