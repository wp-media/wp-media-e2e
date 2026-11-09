import { test, expect } from "@playwright/test";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  endsWithin,
  writeAllureResults,
  writeServeStub,
} from "../__fixtures__/allure";
import { releaseFifoReader } from "../__fixtures__/fifo";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  AllureGenerationAbortedError,
  AllureGenerationFailedError,
} from "./allure-errors";
import {
  EXIT,
  findAllureRuns,
  newestRun,
  parseAllureArgs,
  reportName,
  runAllureCommand,
  serveAllureReport,
  type AllureCommandIo,
  type AllureCommandOptions,
} from "./allure-command";
import type { AllureReport, AllureReportOptions } from "./allure-report";

/**
 * `npm run report:allure`: its arguments, which run it reports, what it asks the generator for, and
 * — through the real script, tsx and Allure — that it still does what it always did.
 */

const execFileAsync = promisify(execFile);

let root = "";

test.beforeEach(() => {
  root = tempRoot("e2e allure command ");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/**
 * Writes a run with Allure results, its results folder dated `minutes` past an epoch.
 *
 * @returns the run's folder.
 */
function makeRun(
  product: string,
  cell: string,
  run: string,
  minutes: number,
  title?: string,
): string {
  const runDir = join(root, product, cell, run);
  const results = writeAllureResults(join(runDir, "allure-results"));
  if (title !== undefined) {
    writeFileSync(join(runDir, "run-facts.json"), JSON.stringify({ title }));
  }
  const at = new Date(Date.UTC(2026, 9, 1, 0, minutes));
  utimesSync(results, at, at);
  return runDir;
}

test.describe("parseAllureArgs", () => {
  const run = (options: Partial<AllureCommandOptions>) => ({
    kind: "run",
    options: {
      product: undefined,
      cell: undefined,
      run: undefined,
      open: false,
      ...options,
    },
  });

  test("reads up to a product, a cell and a run, and --open anywhere", () => {
    expect(parseAllureArgs([])).toEqual(run({}));
    expect(parseAllureArgs(["wp-rocket"])).toEqual(
      run({ product: "wp-rocket" }),
    );
    expect(parseAllureArgs(["--open", "wp-rocket", "apache"])).toEqual(
      run({ product: "wp-rocket", cell: "apache", open: true }),
    );
    expect(
      parseAllureArgs(["backwpup", "pro@nginx", "2026-x", "--open"]),
    ).toEqual(
      run({
        product: "backwpup",
        cell: "pro@nginx",
        run: "2026-x",
        open: true,
      }),
    );
  });

  test("help wins over everything", () => {
    expect(parseAllureArgs(["a", "--bogus", "-h"])).toEqual({ kind: "help" });
    expect(parseAllureArgs(["--help"])).toEqual({ kind: "help" });
  });

  test("refuses an unknown option, a fourth name and anything that is not one folder name", () => {
    for (const argv of [
      ["--opne"],
      ["a", "b", "c", "d"],
      ["../etc"],
      ["a", "b/c"],
      ["a", "b", ".."],
      ["a", "b", ".pruning-1-2-0123abcd"],
      ["a\\b"],
      ["a", "b\0c"],
      [""],
    ]) {
      expect(parseAllureArgs(argv).kind).toBe("error");
    }
  });
});

test.describe("findAllureRuns and newestRun", () => {
  test("finds runs with a test result, filtered, skipping hidden folders and empty runs", () => {
    makeRun("wp-rocket", "apache", "r1", 1);
    makeRun("wp-rocket", "nginx", "r2", 2);
    makeRun("backwpup", "apache", "r3", 3);
    makeRun("backwpup", "apache", ".pruning-1-2-0123abcd", 9);
    mkdirSync(join(root, "backwpup", "apache", "r4", "allure-results"), {
      recursive: true,
    });
    writeFileSync(
      join(
        root,
        "backwpup",
        "apache",
        "r4",
        "allure-results",
        "environment.properties",
      ),
      "",
    );

    const names = (runs: { runDir: string }[]) =>
      runs.map((run) => run.runDir.slice(root.length + 1)).sort();
    expect(names(findAllureRuns(root))).toEqual([
      "backwpup/apache/r3",
      "wp-rocket/apache/r1",
      "wp-rocket/nginx/r2",
    ]);
    expect(names(findAllureRuns(root, { product: "wp-rocket" }))).toEqual([
      "wp-rocket/apache/r1",
      "wp-rocket/nginx/r2",
    ]);
    expect(names(findAllureRuns(root, { cell: "apache" }))).toEqual([
      "backwpup/apache/r3",
      "wp-rocket/apache/r1",
    ]);
    expect(findAllureRuns(join(root, "absent"))).toEqual([]);
    expect(newestRun(findAllureRuns(root))?.runDir).toBe(
      join(root, "backwpup", "apache", "r3"),
    );
    expect(newestRun([])).toBeUndefined();
  });
});

test.describe("reportName", () => {
  test("is the run facts' title, else the fallback", () => {
    const runDir = join(root, "run");
    mkdirSync(runDir);
    expect(reportName(runDir, "fallback")).toBe("fallback");
    for (const [facts, name] of [
      [
        JSON.stringify({ title: "  BackWPup 5.6 · pro@nginx  " }),
        "BackWPup 5.6 · pro@nginx",
      ],
      [JSON.stringify({ title: "   " }), "fallback"],
      [JSON.stringify({ title: 42 }), "fallback"],
      ["null", "fallback"],
      ["{", "fallback"],
    ] as const) {
      writeFileSync(join(runDir, "run-facts.json"), facts);
      expect(reportName(runDir, "fallback")).toBe(name);
    }
  });
});

test.describe("runAllureCommand", () => {
  /** An io that records what it is asked, with a generator that succeeds unless told otherwise. */
  function recordingIo(
    generate?: (options: AllureReportOptions) => Promise<AllureReport>,
  ) {
    const lines: string[] = [];
    const errors: string[] = [];
    const generated: AllureReportOptions[] = [];
    const served: string[] = [];
    const io: AllureCommandIo = {
      reportRoot: root,
      print: (line) => lines.push(line),
      printError: (line) => errors.push(line),
      generate: async (options) => {
        generated.push(options);
        if (generate !== undefined) return generate(options);
        return {
          results: 1,
          strippedTraces: 0,
          skipped: [],
          outputDir: options.outputDir,
          historyPath: options.historyPath,
          layout: "single-file",
          analytics: { cleaned: ["awesome/index.html"], left: [] },
        };
      },
      serve: (outputDir) => {
        served.push(outputDir);
        return Promise.resolve(7);
      },
    };
    return { io, lines, errors, generated, served };
  }

  test("reports the newest run as it always has: traces kept, one file, the cell's history", async () => {
    makeRun("backwpup", "pro@nginx", "old", 1);
    const newest = makeRun("backwpup", "pro@nginx", "new", 2, "BackWPup · new");
    const { io, lines, generated, served } = recordingIo();

    expect(await runAllureCommand(parseRun([]), io)).toBe(EXIT.ok);

    expect(generated).toEqual([
      {
        runDir: newest,
        resultsDir: join(newest, "allure-results"),
        outputDir: join(newest, "allure"),
        name: "BackWPup · new",
        historyPath: join(
          root,
          "backwpup",
          "pro@nginx",
          "allure-history.jsonl",
        ),
        traces: "keep",
        layout: "single-file",
        stdio: "inherit",
      },
    ]);
    expect(lines).toEqual([
      "→ Allure report for backwpup/pro@nginx",
      `  results: ${join(newest, "allure-results")}`,
      `  output:  ${join(newest, "allure")}`,
      `  history: ${join(root, "backwpup", "pro@nginx", "allure-history.jsonl")}`,
    ]);
    expect(served).toEqual([]);
  });

  test("a given run is reported even when it is not the newest; without facts it is named by cell", async () => {
    const old = makeRun("backwpup", "pro@nginx", "old", 1);
    makeRun("backwpup", "pro@nginx", "new", 2);
    const { io, generated } = recordingIo();

    expect(
      await runAllureCommand(parseRun(["backwpup", "pro@nginx", "old"]), io),
    ).toBe(EXIT.ok);

    expect(generated[0]?.runDir).toBe(old);
    expect(generated[0]?.name).toBe("backwpup · pro@nginx");
  });

  test("--open serves the generated report and exits with the server's status", async () => {
    const run = makeRun("wp-rocket", "apache", "r", 1);
    const { io, served } = recordingIo();

    expect(await runAllureCommand(parseRun(["--open"]), io)).toBe(7);
    expect(served).toEqual([join(run, "allure")]);
  });

  test("hands its stop signal to the generation", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, generated } = recordingIo();
    const stop = new AbortController();

    await runAllureCommand(parseRun([]), { ...io, signal: stop.signal });

    expect(generated[0]?.signal).toBe(stop.signal);
  });

  test("a page whose analytics loader was left is warned about, and the report still counts", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors } = recordingIo((options) =>
      Promise.resolve({
        results: 1,
        strippedTraces: 0,
        skipped: [],
        outputDir: options.outputDir,
        historyPath: options.historyPath,
        layout: "single-file",
        analytics: {
          cleaned: [],
          left: ["awesome/index.html", "dashboard/index.html"],
        },
      }),
    );

    expect(await runAllureCommand(parseRun([]), io)).toBe(EXIT.ok);
    expect(errors).toEqual([
      "Warning: Allure's analytics loader (Google Tag Manager) was not recognised in " +
        "awesome/index.html, dashboard/index.html: left as Allure wrote it, so those pages load it " +
        "when opened online.",
    ]);
  });

  test("a single page whose analytics loader was left is warned about too", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors } = recordingIo((options) =>
      Promise.resolve({
        results: 1,
        strippedTraces: 0,
        skipped: [],
        outputDir: options.outputDir,
        historyPath: options.historyPath,
        layout: "single-file",
        analytics: { cleaned: [], left: ["awesome/index.html"] },
      }),
    );

    expect(await runAllureCommand(parseRun([]), io)).toBe(EXIT.ok);
    expect(errors).toEqual([
      "Warning: Allure's analytics loader (Google Tag Manager) was not recognised in " +
        "awesome/index.html: left as Allure wrote it, so those pages load it when opened online.",
    ]);
  });

  test("a clean report prints no warning", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors } = recordingIo();

    expect(await runAllureCommand(parseRun([]), io)).toBe(EXIT.ok);
    expect(errors).toEqual([]);
  });

  test("a stopped generation is reported as stopped, and exits 1", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors, served } = recordingIo(() =>
      Promise.reject(new AllureGenerationAbortedError()),
    );

    expect(await runAllureCommand(parseRun(["--open"]), io)).toBe(EXIT.failed);
    expect(errors).toEqual([expect.stringContaining("was stopped")]);
    expect(served).toEqual([]);
  });

  test("no run with results: says where it looked, and exits 1 without generating", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors, generated } = recordingIo();

    expect(await runAllureCommand(parseRun(["backwpup", "apache"]), io)).toBe(
      EXIT.failed,
    );
    expect(errors).toEqual([
      `No Allure results found under "${root}/" for backwpup/apache. ` +
        "Run a suite first, e.g. `E2E_CELL=apache npm run test:wp-rocket`.",
    ]);
    expect(generated).toEqual([]);
  });

  test("a failed generation prints its reason, exits 1 and serves nothing", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io, errors, served } = recordingIo(() =>
      Promise.reject(new AllureGenerationFailedError(1, null, "")),
    );

    expect(await runAllureCommand(parseRun(["--open"]), io)).toBe(EXIT.failed);
    expect(errors).toEqual([expect.stringContaining("allure generate failed")]);
    expect(served).toEqual([]);
  });

  test("an unexpected error is not swallowed", async () => {
    makeRun("wp-rocket", "apache", "r", 1);
    const { io } = recordingIo(() => Promise.reject(new TypeError("a bug")));

    await expect(runAllureCommand(parseRun([]), io)).rejects.toThrow("a bug");
  });
});

test.describe("serveAllureReport", () => {
  test("runs `allure open` with the suite's config on the report, and returns its status", async () => {
    const bin = writeServeStub(join(root, "bin"), 7);
    const errors: string[] = [];

    const status = await serveAllureReport("/the report", {
      printError: (line) => errors.push(line),
      allureBin: bin,
      configPath: "/allurerc.mjs",
    });

    expect(status).toBe(7);
    expect(
      JSON.parse(readFileSync(join(root, "bin", "serve.json"), "utf8")),
    ).toEqual(["open", "-c", "/allurerc.mjs", "/the report"]);
    expect(errors).toEqual([]);
  });

  test("a CLI that cannot start is said through printError, and is status 1", async () => {
    const missing = join(root, "no-allure");
    const errors: string[] = [];

    const status = await serveAllureReport("/the report", {
      printError: (line) => errors.push(line),
      allureBin: missing,
    });

    expect(status).toBe(EXIT.failed);
    expect(errors).toEqual([
      `Could not run the Allure CLI at ${missing}: ENOENT.`,
    ]);
  });

  test("a stop ends the server", async () => {
    const hang = join(root, "hang");
    writeFileSync(hang, "#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n", {
      mode: 0o755,
    });

    const errors: string[] = [];

    const status = await serveAllureReport("/the report", {
      printError: (line) => errors.push(line),
      allureBin: hang,
      signal: AbortSignal.timeout(200),
    });

    // Ended by SIGTERM: no exit code of its own; it did start, so nothing to say.
    expect(status).toBe(EXIT.failed);
    expect(errors).toEqual([]);
  });
});

/** The command's options for a command line that parses. */
function parseRun(argv: string[]): AllureCommandOptions {
  const parsed = parseAllureArgs(argv);
  if (parsed.kind !== "run")
    throw new Error(`does not parse: ${argv.join(" ")}`);
  return parsed.options;
}

test.describe("npm run report:allure, through the real script and Allure", () => {
  // tsx, then Allure: a few seconds.
  test.slow();

  const checkout = join(import.meta.dirname, "..", "..", "..");

  /** The script's environment: this test's report root, no `.env`. */
  const scriptEnv = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    REPORT_ROOT: root,
    E2E_LOAD_DOTENV: "false",
  });

  /** Runs the script as `npm run report:allure` does, against this test's report root. */
  async function script(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execFileAsync(
        join(checkout, "node_modules", ".bin", "tsx"),
        [join(checkout, "scripts", "allure.mjs"), ...args],
        {
          cwd: root,
          encoding: "utf8",
          env: scriptEnv(),
        },
      );
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return {
        code: failed.code,
        stdout: failed.stdout,
        stderr: failed.stderr,
      };
    }
  }

  test("reports the newest run in one file per plugin, named by its facts, the history appended", async () => {
    makeRun("backwpup", "pro@nginx", "old", 1);
    const newest = makeRun(
      "backwpup",
      "pro@nginx",
      "new",
      2,
      "BackWPup · newest",
    );

    const { code, stdout } = await script([]);

    expect(code).toBe(0);
    expect(stdout).toContain("→ Allure report for backwpup/pro@nginx");
    const awesome = join(newest, "allure", "awesome");
    // One file: no data folder beside it, traces and all inlined.
    expect(readdirSync(awesome).sort()).toEqual(["index.html", "summary.json"]);
    expect(readFileSync(join(awesome, "index.html"), "utf8")).toContain(
      "BackWPup · newest",
    );
    expect(readFileSync(join(awesome, "index.html"), "utf8")).not.toContain(
      "googletagmanager",
    );
    const history = readFileSync(
      join(root, "backwpup", "pro@nginx", "allure-history.jsonl"),
      "utf8",
    );
    expect(history.trim().split("\n")).toHaveLength(1);
    expect(
      existsSync(join(root, "backwpup", "pro@nginx", "old", "allure")),
    ).toBe(false);
  });

  test("reports a given run, and exits 1 and 2 when there is nothing to report or the arguments are wrong", async () => {
    const old = makeRun("backwpup", "pro@nginx", "old", 1, "BackWPup · old");
    makeRun("backwpup", "pro@nginx", "new", 2);

    expect((await script(["backwpup", "pro@nginx", "old"])).code).toBe(0);
    expect(
      readFileSync(join(old, "allure", "awesome", "index.html"), "utf8"),
    ).toContain("BackWPup · old");

    const absent = await script(["backwpup", "pro@nginx", "absent"]);
    expect(absent.code).toBe(1);
    expect(absent.stderr).toContain("No run folder");

    mkdirSync(join(root, "backwpup", "pro@nginx", "empty"));
    const empty = await script(["backwpup", "pro@nginx", "empty"]);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("No Allure results at");

    const none = await script(["wp-rocket"]);
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("No Allure results found under");

    const usage = await script(["--opne"]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("Usage: npm run report:allure");
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    test(`${signal} to its process group stops generation cleanly and exits as the signal would`, async () => {
      const run = makeRun("backwpup", "pro@nginx", "r", 1);
      // A history that holds the generation until it is opened for writing.
      const fifo = join(root, "backwpup", "pro@nginx", "allure-history.jsonl");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const child = spawn(
        join(checkout, "node_modules", ".bin", "tsx"),
        [join(checkout, "scripts", "allure.mjs"), "backwpup", "pro@nginx", "r"],
        // Its own group: what a terminal's Ctrl-C signals.
        {
          cwd: root,
          env: scriptEnv(),
          detached: true,
          stdio: ["ignore", "ignore", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const ended = new Promise<number | null>((settle) => {
        child.once("close", settle);
      });
      const pid = child.pid;
      if (pid === undefined) throw new Error("the script did not start");
      const workDirs = (): string[] =>
        readdirSync(run).filter((name) => name.startsWith(".allure-work-"));
      await expect.poll(workDirs).toHaveLength(1);

      process.kill(-pid, signal);
      await releaseFifoReader(fifo);

      // tsx relays SIGINT and SIGTERM and exits as its script did; SIGHUP ends tsx itself, while
      // the script under it, in the same group, gets it too and stops Allure (the checks below).
      expect(await endsWithin(ended, "the stopped script")).toBe(
        { SIGINT: 130, SIGTERM: 143, SIGHUP: null }[signal],
      );
      expect(stderr).toContain("Allure generation was stopped");
      expect(workDirs()).toEqual([]);
      expect(existsSync(join(run, "allure"))).toBe(false);
      // Allure, in a group of its own, was ended by the script: no process names the run any more.
      expect(spawnSync("pgrep", ["-f", run]).status).toBe(1);
    });
  }
});
