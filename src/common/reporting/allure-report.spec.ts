import { test, expect } from "@playwright/test";
import { execFile, spawn, spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
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
  endsWithin,
  stopAtCheck,
  STUB_OUTPUT_HEAD,
  stubCalls,
  writeAllureResults,
  writeAllureStub,
} from "../__fixtures__/allure";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import { HISTORY_LIMIT } from "./allure-history";
import {
  AllureCliMissingError,
  AllureGenerationAbortedError,
  AllureGenerationFailedError,
  AllureReportError,
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
      historyDropped: 0,
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

  test("a new history is owner-only; an existing one keeps its mode across generations", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const history = join(cellDir, "allure-history.jsonl");
    const mode = (): string => (statSync(history).mode & 0o777).toString(8);

    await generateAllureReport(options(bin));
    expect(mode()).toBe("600");

    for (const kept of [0o640, 0o644]) {
      chmodSync(history, kept);
      await generateAllureReport(options(bin));
      expect(mode()).toBe(kept.toString(8));
    }
    expect(readFileSync(history, "utf8").split("\n")).toHaveLength(2);
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
    // Allure is given only what came before the run's own line: never that line (it would draw it
    // as a previous run), nor a later run's.
    expect(stubCalls(stubDir).map((call) => call.historyText)).toEqual([
      `{"name":"untagged"}\n`,
      `{"name":"untagged"}\n`,
    ]);
  });

  test("another run's non-ASCII line goes to Allure and back byte for byte", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const other = Buffer.concat([
      Buffer.from(
        `{"name":"BackWPup · pro@nginx · é","e2eRun":"other-run","x":"`,
      ),
      Buffer.from([0xff, 0xfe]),
      Buffer.from('"}\n'),
    ]);
    writeFileSync(join(cellDir, "allure-history.jsonl"), other);

    await generateAllureReport(options(bin));

    expect(stubCalls(stubDir)[0]?.historyText).toBe(other.toString("latin1"));
    expect(readFileSync(join(cellDir, "allure-history.jsonl"))).toEqual(
      Buffer.concat([
        other,
        Buffer.from(
          `{"name":"BackWPup · pro@nginx · run 1","e2eRun":"${basename(runDir)}"}\n`,
        ),
      ]),
    );
  });

  test("a run with a non-ASCII folder name keeps one history line", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const run = join(cellDir, "run · é");
    writeAllureResults(join(run, "allure-results"));
    const own = options(bin, {
      runDir: run,
      resultsDir: join(run, "allure-results"),
      outputDir: join(run, "allure"),
    });

    await generateAllureReport(own);
    await generateAllureReport(own);

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      `{"name":"BackWPup · pro@nginx · run 1","e2eRun":"run · é"}\n`,
    );
    expect(stubCalls(stubDir).map((call) => call.historyText)).toEqual([
      null,
      null,
    ]);
  });

  test("Allure appending nothing (3.18 logs a failed append and exits 0) keeps the cell's history whole", async () => {
    const bin = writeAllureStub(stubDir, "no-history");
    const cell =
      `{"name":"first","timestamp":5,"e2eRun":"${basename(runDir)}"}\n` +
      `{"name":"o","e2eRun":"r2"}\n`;
    writeFileSync(join(cellDir, "allure-history.jsonl"), cell);

    await generateAllureReport(options(bin));

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      cell,
    );
  });

  test("Allure appending two lines: both kept after the cell's history, the run's earlier line kept", async () => {
    const bin = writeAllureStub(stubDir, "two-lines");
    const cell = `{"name":"first","timestamp":5,"e2eRun":"${basename(runDir)}"}\n`;
    writeFileSync(join(cellDir, "allure-history.jsonl"), cell);

    await generateAllureReport(options(bin));

    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      `${cell}{"name":"BackWPup · pro@nginx · run 1"}\n{"name":"extra"}\n`,
    );
  });

  test("Allure's line past the line bound is not kept but counted, the cell's history kept", async () => {
    const bin = writeAllureStub(stubDir, "long-line");
    const cell = `{"name":"o","e2eRun":"r2"}\n`;
    writeFileSync(join(cellDir, "allure-history.jsonl"), cell);

    const report = await generateAllureReport(options(bin));

    expect(report.historyDropped).toBe(1);
    expect(readFileSync(join(cellDir, "allure-history.jsonl"), "utf8")).toBe(
      cell,
    );
  });

  test("the history keeps the newest HISTORY_LIMIT runs", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const lines = Array.from(
      { length: HISTORY_LIMIT + 3 },
      (_, n) => `{"name":"r${String(n)}","e2eRun":"r${String(n)}"}\n`,
    );
    writeFileSync(join(cellDir, "allure-history.jsonl"), lines.join(""));

    await generateAllureReport(options(bin));

    expect(stubCalls(stubDir)[0]?.historyText).toBe(lines.slice(3).join(""));
    const after = historyLines();
    expect(after).toHaveLength(HISTORY_LIMIT);
    expect(after[0]?.e2eRun).toBe("r4");
    expect(after.at(-1)?.e2eRun).toBe(basename(runDir));
  });

  test("history lines Allure could not read are dropped and counted, never handed to it", async () => {
    const bin = writeAllureStub(stubDir, "ok");
    const kept = `{"name":"o","e2eRun":"r2"}\n`;
    writeFileSync(
      join(cellDir, "allure-history.jsonl"),
      `{ broken\n${kept}null\n`,
    );

    const report = await generateAllureReport(options(bin));

    expect(report.historyDropped).toBe(2);
    expect(stubCalls(stubDir)[0]?.historyText).toBe(kept);
    expect(historyLines().map((line) => line.e2eRun)).toEqual([
      "r2",
      basename(runDir),
    ]);
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

    expect(
      await endsWithin(generating, "the stopped generation"),
    ).toBeInstanceOf(AllureGenerationAbortedError);
    expect(isProcessAlive(pid)).toBe(false);
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("a stopped Allure that ignores SIGTERM is killed once its grace is over, nothing put in place", async () => {
    const bin = writeAllureStub(stubDir, "ignore-term");
    const previous = writePrevious();
    const stop = new AbortController();

    const generating = generateAllureReport(
      options(bin, { signal: stop.signal, killGraceMs: 100 }),
    ).catch((caught: unknown) => caught);
    const { pid } = await stubStarted();
    const stoppedAt = performance.now();
    stop.abort();

    // Without the SIGKILL it never ends: the spec's timeout fails it.
    expect(
      await endsWithin(generating, "the stopped generation"),
    ).toBeInstanceOf(AllureGenerationAbortedError);
    // Its own 100 ms grace: neither none nor the 5 s default.
    expect(performance.now() - stoppedAt).toBeGreaterThanOrEqual(90);
    expect(performance.now() - stoppedAt).toBeLessThan(3_000);
    expect(isProcessAlive(pid)).toBe(false);
    expectPreviousUntouched(previous);
    expect(workDirs()).toEqual([]);
  });

  test("leaves nothing armed on its signal once Allure has ended, stopped or not", async () => {
    const done = new AbortController();
    await generateAllureReport(
      options(writeAllureStub(stubDir, "ok"), { signal: done.signal }),
    );
    expect(getEventListeners(done.signal, "abort")).toEqual([]);

    const stop = new AbortController();
    const generating = generateAllureReport(
      options(writeAllureStub(join(root, "hang stub"), "hang"), {
        signal: stop.signal,
      }),
    ).catch((caught: unknown) => caught);
    await expect.poll(() => stubCalls(join(root, "hang stub")).length).toBe(1);
    stop.abort();
    await endsWithin(generating, "the stopped generation");
    expect(getEventListeners(stop.signal, "abort")).toEqual([]);
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
    expect(
      await endsWithin(first, "the first, stopped generation"),
    ).toBeInstanceOf(AllureGenerationAbortedError);
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
    expect(
      await endsWithin(generating, "the stopped generation"),
    ).toBeInstanceOf(AllureGenerationAbortedError);
  });

  test("a stop waits for Allure to end, so nothing writes into the work folder once it is gone", async () => {
    const stop = new AbortController();
    const generating = generateAllureReport(
      options(writeAllureStub(stubDir, "slow-stop"), { signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const { pid } = await stubStarted();
    stop.abort();

    expect(
      await endsWithin(generating, "the stopped generation"),
    ).toBeInstanceOf(AllureGenerationAbortedError);
    // Ended before the generation did: its late write landed in a folder removed after it.
    expect(isProcessAlive(pid)).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  test("a stop while the history is read runs nothing", async () => {
    const history = join(cellDir, "allure-history.jsonl");
    writeFileSync(history, `{"n":1}\n`);
    // Checked before the work folder is made (1), before the history is opened (2), as its one
    // chunk arrives (3): the stop lands mid-read.
    const stop = stopAtCheck(3);

    await expect(
      generateAllureReport(
        options(writeAllureStub(stubDir, "ok"), { signal: stop.signal }),
      ),
    ).rejects.toBeInstanceOf(AllureGenerationAbortedError);

    expect(stop.checks()).toBe(3);
    expect(stubCalls(stubDir)).toEqual([]);
    expect(readFileSync(history, "utf8")).toBe(`{"n":1}\n`);
    expect(existsSync(join(runDir, "allure"))).toBe(false);
    expect(workDirs()).toEqual([]);
  });

  test("a FIFO where the history should be never holds the generation: replaced by a history, counted", async () => {
    // Read, its open would wait for a writer and its reads for bytes: nothing would end it but a stop.
    const fifo = join(cellDir, "allure-history.jsonl");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);

    const report = await endsWithin(
      generateAllureReport(options(writeAllureStub(stubDir, "ok"))),
      "the generation",
    );

    expect(report.historyDropped).toBe(1);
    expect(stubCalls(stubDir)[0]?.historyText).toBeNull();
    expect(lstatSync(fifo).isFile()).toBe(true);
    expect(historyLines().map((line) => line.e2eRun)).toEqual([
      basename(runDir),
    ]);
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

    // A typed error naming the file and why; the filesystem's error is its cause.
    expect(error).toBeInstanceOf(AllureReportError);
    expect((error as Error).message).toMatch(
      /^Cannot read the Allure history .*allure-history\.jsonl \(E[A-Z]+\)\.$/,
    );
    expect(((error as Error).cause as NodeJS.ErrnoException).code).toMatch(
      /^E[A-Z]+$/,
    );
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
    chmodSync(history, 0o644);
    chmodSync(updated, 0o600);

    await placeHistory(
      updated,
      history,
      outputDir,
      failing("EXDEV", (from) => from === updated),
    );

    expect(readFileSync(history, "utf8")).toBe("updated\n");
    expect(statSync(history).mode & 0o777).toBe(0o644);
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

  test("a run generated again is one point in its own trend, not its earlier generation too", async () => {
    const keep = options(undefined, { traces: "keep" });

    await generateAllureReport(keep);
    await generateAllureReport(keep);

    const trend = dashboardCharts(runDir).find(
      (chart) => chart.type === "statusDynamics",
    );
    expect(trend?.data).toHaveLength(1);
    expect(historyLines().map((line) => line.e2eRun)).toEqual([
      basename(runDir),
    ]);
  });

  test("an older run generated again draws the trend it drew first: no later run's point in it", async () => {
    const r1 = options(undefined, { traces: "keep" });
    const otherRun = join(cellDir, "2026-10-22T11-00-00-000Z-26886");
    writeAllureResults(join(otherRun, "allure-results"));
    const r2 = {
      ...r1,
      runDir: otherRun,
      resultsDir: join(otherRun, "allure-results"),
      outputDir: join(otherRun, "allure"),
    };
    const trend = (run: string): unknown[] | undefined =>
      dashboardCharts(run).find((chart) => chart.type === "statusDynamics")
        ?.data;

    await generateAllureReport(r1);
    await generateAllureReport(r2);
    await generateAllureReport(r1);

    expect(trend(runDir)).toHaveLength(1);
    await generateAllureReport(r2);
    // r1's point once, and r2's own.
    expect(trend(otherRun)).toHaveLength(2);
    expect(historyLines().map((line) => line.e2eRun)).toEqual([
      basename(runDir),
      basename(otherRun),
    ]);
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
