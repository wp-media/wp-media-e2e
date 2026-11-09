import { test, expect } from "@playwright/test";
import { execFile, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync, renameSync } from "node:fs";
import { rename } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { writeAllureResults, writeAllureStub } from "../__fixtures__/allure";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import { listTarGz } from "../__fixtures__/tar-listing";
import {
  AllureGenerationFailedError,
  AllureReportError,
} from "./allure-errors";
import type { AllureReport, AllureReportOptions, Move } from "./allure-report";
import {
  BundleArchiveError,
  ReportBundleAbortedError,
  ReportBundleError,
} from "./bundle-errors";
import {
  BUNDLE_ARCHIVE,
  BUNDLE_DIR,
  allureFailureReason,
  buildReportBundle,
  bundleLog,
  inspectReportFolder,
  placeFolder,
  tarArgs,
  tarEnv,
  type ReportBundle,
  type ReportBundleOptions,
} from "./report-bundle";
import { errnoCode } from "./report-tree";
import { formatBytes, listGroupRuns } from "./retention";

const RUN_ID = "2026-10-22T10-04-03-625Z-26885";
const NAME = `backwpup-pro@nginx-${RUN_ID}`;

/** The run's facts, with markup in its title: the landing page must escape it. */
const FACTS = {
  v: 1,
  title: `backwpup · pro@nginx <script>alert("x")</script> & 'q'`,
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  runId: RUN_ID,
  status: "failed",
  startedAt: "2026-10-22T10:04:07.747Z",
  endedAt: "2026-10-22T10:29:28.531Z",
  durationMs: 1522042,
};

let root = "";
let cellDir = "";
let runDir = "";
let stubDir = "";

test.beforeEach(() => {
  // A space and quotes in every path: a checkout under "Sandy's Projects", say.
  root = tempRoot(`e2e bundle 'q" `);
  cellDir = join(root, "backwpup", "pro@nginx");
  runDir = join(cellDir, RUN_ID);
  stubDir = join(root, "stub bin");
  writeRun(runDir);
});

test.afterEach(() => {
  removeTempRoot(root);
});

/**
 * Writes a run folder as the suite leaves it: a Playwright report with attachments and traces, a
 * one-file Cucumber report, raw Allure results, the results stream and the facts.
 *
 * @param dir - the run folder.
 */
function writeRun(dir: string): void {
  mkdirSync(join(dir, "playwright", "data"), { recursive: true });
  mkdirSync(join(dir, "playwright", "trace"), { recursive: true });
  writeFileSync(
    join(dir, "playwright", "index.html"),
    "<html>playwright</html>",
  );
  writeFileSync(
    join(dir, "playwright", "data", "aa11.png"),
    Buffer.alloc(32, 1),
  );
  writeFileSync(
    join(dir, "playwright", "data", "bb22.zip"),
    Buffer.alloc(64, 2),
  );
  writeFileSync(
    join(dir, "playwright", "trace", "index.html"),
    "<html>trace</html>",
  );
  mkdirSync(join(dir, "cucumber"));
  writeFileSync(join(dir, "cucumber", "index.html"), "<html>cucumber</html>");
  writeAllureResults(join(dir, "allure-results"));
  writeFileSync(join(dir, "results.jsonl"), '{"v":1,"type":"run.begin"}\n');
  writeFileSync(join(dir, "run-facts.json"), JSON.stringify(FACTS, null, 2));
}

/** The options for this test's run, with a stub Allure that succeeds. */
function options(
  extra: Partial<ReportBundleOptions> = {},
): ReportBundleOptions {
  return {
    runDir,
    name: NAME,
    mode: "archive",
    traces: "strip",
    allureBin: writeAllureStub(stubDir, "ok"),
    ...extra,
  };
}

/** The run folder's entries, sorted. */
function runEntries(): string[] {
  return readdirSync(runDir).sort();
}

/** The run folder's entries before a bundle: its raw parts. */
const RAW = [
  "allure-results",
  "cucumber",
  "playwright",
  "results.jsonl",
  "run-facts.json",
];

/** Every file under a folder, relative and sorted, with its bytes. */
function tree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (at: string): void => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) walk(path);
      else
        files.set(relative(dir, path), readFileSync(path).toString("base64"));
    }
  };
  walk(dir);
  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
}

/** Unpacks an archive with the system tar into a new folder, as the Slack command does. */
async function unpack(archive: string): Promise<string> {
  const into = join(root, `unpacked-${String(Math.random()).slice(2)}`);
  mkdirSync(into);
  const { stderr } = await promisify(execFile)("tar", ["-xzf", archive], {
    cwd: into,
  });
  // GNU tar warns about headers it does not know (macOS's extended attributes): none may come.
  expect(stderr).toBe("");
  return into;
}

/**
 * Writes a stub `tar` that records its pid, then fails; or hangs until a signal ends it; or hangs and,
 * on SIGTERM, writes into its working folder (the build's work folder) 300 ms later, then exits.
 */
function tarStub(behaviour: "fail" | "hang" | "slow-stop"): {
  bin: string;
  pidFile: string;
} {
  mkdirSync(stubDir, { recursive: true });
  const bin = join(stubDir, `tar-${behaviour}`);
  // `$0.pid`: the path is never spelled in the script, so no quote in it can break it.
  const pidFile = `${bin}.pid`;
  const scripts = {
    fail: `echo "tar: cannot write" >&2\nexit 2\n`,
    hang: `exec sleep 600\n`,
    // `wait` returns on a trapped signal; `sleep` in the foreground would hold the trap back.
    "slow-stop": `trap 'kill $!; sleep 0.3; mkdir -p "$PWD/late"; exit 143' TERM\nsleep 600 &\nwait\n`,
  };
  writeFileSync(bin, `#!/bin/sh\necho $$ > "$0.pid"\n${scripts[behaviour]}`);
  chmodSync(bin, 0o755);
  return { bin, pidFile };
}

/** The pid a stub recorded, once it has. */
async function stubPid(pidFile: string): Promise<number> {
  await expect
    .poll(
      () => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim() !== "",
    )
    .toBe(true);
  return Number(readFileSync(pidFile, "utf8").trim());
}

/** Whether a process runs. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/**
 * Leaves a Unix socket at `path`: bound in a short temporary folder (a socket's path is limited to
 * about 100 bytes) and renamed into place; the server is closed, the socket file stays.
 */
async function socketAt(path: string): Promise<void> {
  const short = mkdtempSync(join(tmpdir(), "s-"));
  const server = createServer();
  await new Promise<void>((listening, failed) => {
    server.once("error", failed);
    server.listen(join(short, "s"), listening);
  });
  renameSync(join(short, "s"), path);
  await new Promise((closed) => server.close(closed));
  removeTempRoot(short);
  expect(lstatSync(path).isSocket()).toBe(true);
}

/** A pid no process has: a child that already ended. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** The run folder's hidden work folders. */
function workDirs(): string[] {
  return readdirSync(runDir).filter((name) => name.startsWith(".bundle-work-"));
}

test.describe("buildReportBundle: what goes in", () => {
  test("archive: one top-level entry, the bundle's name, holding only the viewable reports", async () => {
    const lines: string[] = [];
    const bundle = await buildReportBundle(
      options({ log: (line) => lines.push(line) }),
    );

    const archive = join(runDir, BUNDLE_ARCHIVE);
    expect(bundle.archive).toEqual({
      path: archive,
      bytes: statSync(archive).size,
    });
    expect(bundle.folder).toBeNull();
    expect(runEntries()).toEqual([...RAW, BUNDLE_ARCHIVE].sort());
    const entries = listTarGz(archive);
    expect(
      entries.every(
        (entry) =>
          entry.path === `${NAME}/` || entry.path.startsWith(`${NAME}/`),
      ),
    ).toBe(true);
    expect(
      entries
        .map((entry) => entry.path)
        .filter((path) => !path.endsWith("/"))
        .sort(),
    ).toEqual(
      [
        "allure/awesome/index.html",
        "cucumber/index.html",
        "index.html",
        "playwright/data/aa11.png",
        "playwright/data/bb22.zip",
        "playwright/index.html",
        "playwright/trace/index.html",
        "run-facts.json",
      ].map((path) => `${NAME}/${path}`),
    );
    // No raw result, no macOS metadata (AppleDouble entries, extended attributes). Only bsdtar on
    // macOS writes either, so on Linux (CI) these guards cannot fail; that a bundle built on one tar
    // unpacks cleanly with the other is a manual measurement, recorded in the plan.
    for (const entry of entries) {
      expect(entry.path).not.toMatch(
        /allure-results|results\.jsonl|\.bundle-work|(^|\/)\._/,
      );
      expect(
        entry.paxKeys.filter(
          (key) => key.includes("xattr") || key.includes("acl"),
        ),
      ).toEqual([]);
    }
    expect(bundle.bytes).toBeGreaterThan(0);
    // One line: where, how big packed and unpacked; nothing missing.
    expect(lines).toEqual([
      `Report bundle ${NAME}: ${archive} (${formatBytes(statSync(archive).size)}); ` +
        `${formatBytes(bundle.bytes)} unpacked.`,
    ]);
    expect(workDirs()).toEqual([]);
  });

  test("the archive unpacks with the system tar to <name>/, the landing page linking every report", async () => {
    await buildReportBundle(options());

    const into = await unpack(join(runDir, BUNDLE_ARCHIVE));

    expect(readdirSync(into)).toEqual([NAME]);
    const bundle = join(into, NAME);
    expect(readdirSync(bundle).sort()).toEqual([
      "allure",
      "cucumber",
      "index.html",
      "playwright",
      "run-facts.json",
    ]);
    const landing = readFileSync(join(bundle, "index.html"), "utf8");
    for (const href of [
      "playwright/index.html",
      "cucumber/index.html",
      "allure/awesome/index.html",
      "run-facts.json",
    ]) {
      expect(landing).toContain(`href="${href}"`);
      expect(existsSync(join(bundle, href))).toBe(true);
    }
    // The copied reports are byte for byte the run's.
    expect(tree(join(bundle, "playwright"))).toEqual(
      tree(join(runDir, "playwright")),
    );
    expect(readFileSync(join(bundle, "run-facts.json"), "utf8")).toBe(
      readFileSync(join(runDir, "run-facts.json"), "utf8"),
    );
    // The trace viewer needs HTTP: the page says how to serve it.
    expect(landing).toContain(
      "<code>npx playwright show-report playwright</code>",
    );
  });

  test("escapes every value on the landing page", async () => {
    await buildReportBundle(options({ mode: "folder" }));

    const landing = readFileSync(
      join(runDir, BUNDLE_DIR, "index.html"),
      "utf8",
    );
    expect(landing).not.toContain("<script");
    expect(landing).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;",
    );
  });

  test("a name with spaces and quotes is the unpacked folder's name, whole", async () => {
    const name = `run "a" & 'b' <c>`;
    await buildReportBundle(options({ name }));

    const into = await unpack(join(runDir, BUNDLE_ARCHIVE));
    expect(readdirSync(into)).toEqual([name]);
    expect(readFileSync(join(into, name, "index.html"), "utf8")).toContain(
      "run &quot;a&quot; &amp; &#39;b&#39; &lt;c&gt;",
    );
  });

  test("rich Cucumber is copied with its folders, and the page says it must be served", async () => {
    mkdirSync(join(runDir, "cucumber", "data"));
    writeFileSync(
      join(runDir, "cucumber", "data", "shot.png"),
      Buffer.alloc(8, 3),
    );
    mkdirSync(join(runDir, "cucumber", "trace"));
    writeFileSync(join(runDir, "cucumber", "trace", "index.html"), "trace");

    const bundle = await buildReportBundle(options({ mode: "folder" }));

    const folder = join(runDir, BUNDLE_DIR);
    expect(tree(join(folder, "cucumber"))).toEqual(
      tree(join(runDir, "cucumber")),
    );
    expect(
      bundle.reports.find((report) => report.kind === "cucumber"),
    ).toMatchObject({
      present: true,
      serve: { command: "npx playwright show-report cucumber" },
    });
    expect(readFileSync(join(folder, "index.html"), "utf8")).toContain(
      "<code>npx playwright show-report cucumber</code>",
    );
  });

  test("a Playwright report without data/ or trace/ is one file, and needs no server", async () => {
    removeTempRoot(join(runDir, "playwright", "data"));
    removeTempRoot(join(runDir, "playwright", "trace"));

    const bundle = await buildReportBundle(options({ mode: "folder" }));

    expect(readdirSync(join(runDir, BUNDLE_DIR, "playwright"))).toEqual([
      "index.html",
    ]);
    const playwright = bundle.reports.find(
      (report) => report.kind === "playwright",
    );
    expect(playwright).toEqual({
      kind: "playwright",
      present: true,
      href: "playwright/index.html",
      pages: [],
    });
    expect(
      readFileSync(join(runDir, BUNDLE_DIR, "index.html"), "utf8"),
    ).not.toContain("show-report");
  });

  test("missing and unfinished reports are said plainly, and the bundle is still built", async () => {
    removeTempRoot(join(runDir, "playwright"));
    // A killed run's Cucumber file is empty.
    writeFileSync(join(runDir, "cucumber", "index.html"), "");
    removeTempRoot(join(runDir, "allure-results"));
    removeTempRoot(join(runDir, "run-facts.json"));
    const lines: string[] = [];

    const bundle = await buildReportBundle(
      options({ mode: "folder", log: (line) => lines.push(line) }),
    );

    const folder = join(runDir, BUNDLE_DIR);
    expect(readdirSync(folder)).toEqual(["index.html"]);
    const landing = readFileSync(join(folder, "index.html"), "utf8");
    expect(landing).toContain(
      "Playwright</span> — not in this bundle: the run did not write it.",
    );
    expect(landing).toContain(
      "Cucumber</span> — not in this bundle: its index.html is empty",
    );
    expect(landing).toContain(
      "Allure</span> — not in this bundle: the run left no Allure results.",
    );
    expect(landing).toContain("No run facts");
    expect(landing).not.toContain('href="run-facts.json"');
    expect(bundle.reports.map((report) => report.present)).toEqual([
      false,
      false,
      false,
    ]);
    expect(lines.slice(1)).toEqual([
      "Report bundle: no playwright report — the run did not write it.",
      expect.stringMatching(
        /^Report bundle: no cucumber report — its index\.html is empty/,
      ),
      expect.stringMatching(
        /^Report bundle: no allure report — No Allure results at .*: the folder does not exist\.$/,
      ),
    ]);
  });

  test("traces kept: Allure is a folder report, and the page gives the command that serves it", async () => {
    const bundle = await buildReportBundle(
      options({ mode: "folder", traces: "keep" }),
    );

    expect(
      bundle.reports.find((report) => report.kind === "allure"),
    ).toMatchObject({
      present: true,
      serve: { command: "npx allure open allure" },
    });
    expect(
      readFileSync(join(runDir, BUNDLE_DIR, "index.html"), "utf8"),
    ).toContain("<code>npx allure open allure</code>");
  });

  test("generates Allure named by the facts line, with the cell's history beside the run", async () => {
    const calls: AllureReportOptions[] = [];
    const stop = new AbortController();

    await buildReportBundle(
      options({
        signal: stop.signal,
        generateAllure: (allure) => {
          calls.push(allure);
          mkdirSync(join(allure.outputDir, "awesome"), { recursive: true });
          writeFileSync(join(allure.outputDir, "index.html"), "summary");
          writeFileSync(
            join(allure.outputDir, "awesome", "index.html"),
            "awesome",
          );
          return Promise.resolve(fakeReport(allure));
        },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      runDir,
      resultsDir: join(runDir, "allure-results"),
      name: FACTS.title,
      historyPath: join(cellDir, "allure-history.jsonl"),
      traces: "strip",
      signal: stop.signal,
    });
    // Built inside the bundle's work folder, never the run's own `allure/`.
    expect(calls[0]?.outputDir).toMatch(
      /\/\.bundle-work-\d+-[0-9a-f]{8}\/[^/]+\/allure$/,
    );
    const entries = listTarGz(join(runDir, BUNDLE_ARCHIVE)).map(
      (entry) => entry.path,
    );
    expect(entries).toContain(`${NAME}/allure/index.html`);
  });

  test("an Allure that fails is said on the page and in the log; the rest of the bundle stands", async () => {
    const lines: string[] = [];
    const bundle = await buildReportBundle(
      options({
        mode: "folder",
        log: (line) => lines.push(line),
        generateAllure: (allure) => {
          // Whatever a failed generation left must not pass for a report.
          mkdirSync(allure.outputDir, { recursive: true });
          writeFileSync(join(allure.outputDir, "partial.json"), "{}");
          return Promise.reject(
            new AllureGenerationFailedError(3, null, "boom"),
          );
        },
      }),
    );

    expect(readdirSync(join(runDir, BUNDLE_DIR)).sort()).toEqual([
      "cucumber",
      "index.html",
      "playwright",
      "run-facts.json",
    ]);
    expect(bundle.allureError).toContain(
      "allure generate failed (exit code 3)",
    );
    expect(
      readFileSync(join(runDir, BUNDLE_DIR, "index.html"), "utf8"),
    ).toContain(
      "Allure</span> — not in this bundle: allure generate failed (exit code 3).",
    );
    expect(lines).toContainEqual(
      expect.stringContaining(
        "Report bundle: no allure report — allure generate failed",
      ),
    );
  });

  /**
   * A generator that puts its report in place, then fails on the history: `awesome` a clean page,
   * `dashboard` one still loading the analytics.
   */
  const placedThenHistoryFails = (allure: AllureReportOptions) => {
    for (const plugin of ["awesome", "dashboard"]) {
      mkdirSync(join(allure.outputDir, plugin), { recursive: true });
    }
    writeFileSync(join(allure.outputDir, "awesome", "index.html"), "awesome");
    writeFileSync(
      join(allure.outputDir, "dashboard", "index.html"),
      '<script async src="https://www.googletagmanager.com/gtag/js"></script>',
    );
    return Promise.reject(
      new AllureReportError("history could not be updated"),
    );
  };

  test("a report in place whose history failed is kept, the failure and its analytics logged", async () => {
    const lines: string[] = [];
    const bundle = await buildReportBundle(
      options({
        mode: "folder",
        log: (line) => lines.push(line),
        generateAllure: placedThenHistoryFails,
      }),
    );

    const allure = bundle.reports.find((report) => report.kind === "allure");
    expect(allure?.present).toBe(true);
    // Stripped traces: a single-file report, which needs no server.
    expect(allure).not.toHaveProperty("serve");
    expect(
      existsSync(join(runDir, BUNDLE_DIR, "allure", "awesome", "index.html")),
    ).toBe(true);
    expect(bundle.analyticsLeft).toEqual(["dashboard/index.html"]);
    expect(lines).toContain(
      "Report bundle: Allure — history could not be updated",
    );
    expect(lines).toContain(
      "Report bundle: Allure's analytics loader was not recognised, so left in: dashboard/index.html.",
    );
  });

  test("traces kept: a report in place whose history failed is a folder report, with its serve command", async () => {
    const bundle = await buildReportBundle(
      options({
        mode: "folder",
        traces: "keep",
        generateAllure: placedThenHistoryFails,
      }),
    );

    expect(
      bundle.reports.find((report) => report.kind === "allure"),
    ).toMatchObject({
      present: true,
      serve: { command: "npx allure open allure" },
    });
  });

  test("names the Allure pages still loading analytics, in the result and the log", async () => {
    const lines: string[] = [];
    const bundle = await buildReportBundle(
      options({
        log: (line) => lines.push(line),
        generateAllure: (allure) => {
          mkdirSync(join(allure.outputDir, "awesome"), { recursive: true });
          writeFileSync(
            join(allure.outputDir, "awesome", "index.html"),
            "awesome",
          );
          return Promise.resolve({
            ...fakeReport(allure),
            analytics: { cleaned: [], left: ["awesome/index.html"] },
          });
        },
      }),
    );

    expect(bundle.analyticsLeft).toEqual(["awesome/index.html"]);
    expect(lines).toContain(
      "Report bundle: Allure's analytics loader was not recognised, so left in: awesome/index.html.",
    );
  });
});

/** What a fake generator returns for the options it was given. */
function fakeReport(allure: AllureReportOptions): AllureReport {
  return {
    results: 1,
    strippedTraces: 0,
    skipped: [],
    outputDir: allure.outputDir,
    historyPath: allure.historyPath,
    layout: "single-file",
    analytics: { cleaned: [], left: [] },
  };
}

test.describe("buildReportBundle: modes and permissions", () => {
  test("folder: report/ only, owner-only, its size the files' bytes", async () => {
    const bundle = await buildReportBundle(options({ mode: "folder" }));

    const folder = join(runDir, BUNDLE_DIR);
    const fileBytes = [...tree(folder).values()].reduce(
      (sum, base64) => sum + Buffer.from(base64, "base64").length,
      0,
    );
    expect(bundle.bytes).toBe(fileBytes);
    expect(bundle.folder).toEqual({ path: folder, bytes: fileBytes });
    expect(bundle.archive).toBeNull();
    expect(runEntries()).toEqual([...RAW, BUNDLE_DIR].sort());
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  test("both: the folder and the archive hold the same files; 0700 and 0600", async () => {
    await buildReportBundle(options({ mode: "both" }));

    const folder = join(runDir, BUNDLE_DIR);
    const archive = join(runDir, BUNDLE_ARCHIVE);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    expect(tree(join(await unpack(archive), NAME))).toEqual(tree(folder));
    expect(listTarGz(archive)[0]).toMatchObject({
      path: `${NAME}/`,
      type: "5",
      mode: 0o700,
    });
  });

  test("archive: the archive is owner-only", async () => {
    await buildReportBundle(options());

    expect(statSync(join(runDir, BUNDLE_ARCHIVE)).mode & 0o777).toBe(0o600);
  });

  test("none: nothing is built, Allure never runs, the run folder is left as it is", async () => {
    const generated: unknown[] = [];

    const bundle = await buildReportBundle(
      options({
        mode: "none",
        generateAllure: (allure) => (
          generated.push(allure),
          Promise.resolve(fakeReport(allure))
        ),
      }),
    );

    expect(bundle).toEqual({
      name: NAME,
      mode: "none",
      archive: null,
      folder: null,
      bytes: 0,
      reports: [],
      skipped: [],
      analyticsLeft: [],
      allureError: null,
    });
    expect(generated).toEqual([]);
    expect(runEntries()).toEqual(RAW);
  });

  test("replaces an earlier bundle whole: nothing of the old one is left", async () => {
    mkdirSync(join(runDir, BUNDLE_DIR));
    writeFileSync(join(runDir, BUNDLE_DIR, "stale.html"), "old");
    writeFileSync(join(runDir, BUNDLE_ARCHIVE), "old archive");

    await buildReportBundle(options({ mode: "both" }));

    expect(readdirSync(join(runDir, BUNDLE_DIR))).not.toContain("stale.html");
    expect(listTarGz(join(runDir, BUNDLE_ARCHIVE))[0]?.path).toBe(`${NAME}/`);
    expect(workDirs()).toEqual([]);
  });

  test("refuses a name tar or a folder cannot take, and an unknown mode, before touching anything", async () => {
    for (const name of [
      "",
      "-rf",
      "a/b",
      ".hidden",
      "..",
      "bad\nname",
      "@archive",
      "host:path",
    ]) {
      await expect(buildReportBundle(options({ name }))).rejects.toBeInstanceOf(
        RangeError,
      );
    }
    await expect(
      buildReportBundle(options({ mode: "zip" as never })),
    ).rejects.toThrow(/Unknown bundle mode "zip"/);
    expect(runEntries()).toEqual(RAW);
  });

  test("a missing run folder is a clear error", async () => {
    await expect(
      buildReportBundle(options({ runDir: join(root, "nope") })),
    ).rejects.toThrow(ReportBundleError);
    await expect(
      buildReportBundle(options({ runDir: join(root, "nope") })),
    ).rejects.toThrow(/No run folder at/);
  });

  test("a run folder that is a file is a clear error", async () => {
    const file = join(root, "a-file");
    writeFileSync(file, "");

    await expect(buildReportBundle(options({ runDir: file }))).rejects.toThrow(
      `The run folder ${file} is not a folder.`,
    );
  });
});

test.describe("buildReportBundle: failures leave nothing partial", () => {
  /** Writes an earlier bundle, to prove a failure leaves it as it was. */
  function writeEarlier(): void {
    mkdirSync(join(runDir, BUNDLE_DIR));
    writeFileSync(join(runDir, BUNDLE_DIR, "old.html"), "old folder");
    writeFileSync(join(runDir, BUNDLE_ARCHIVE), "old archive");
  }

  /** Asserts the earlier bundle is exactly as {@link writeEarlier} left it, and no work folder stays. */
  function expectEarlierUntouched(): void {
    expect(readdirSync(join(runDir, BUNDLE_DIR))).toEqual(["old.html"]);
    expect(readFileSync(join(runDir, BUNDLE_DIR, "old.html"), "utf8")).toBe(
      "old folder",
    );
    expect(readFileSync(join(runDir, BUNDLE_ARCHIVE), "utf8")).toBe(
      "old archive",
    );
    expect(workDirs()).toEqual([]);
  }

  test("a failing tar puts nothing in place, and says why without its output", async () => {
    writeEarlier();
    const { bin } = tarStub("fail");

    const error = await buildReportBundle(
      options({ mode: "both", tarBin: bin }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BundleArchiveError);
    expect((error as BundleArchiveError).message).toContain("exit code 2");
    expect((error as BundleArchiveError).output).toBe("tar: cannot write\n");
    expectEarlierUntouched();
  });

  test("a tar that cannot start is the same error", async () => {
    const error = await buildReportBundle(
      options({ tarBin: join(root, "no-tar") }),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(BundleArchiveError);
    expect((error as Error).message).toContain("ENOENT");
    expect(runEntries()).toEqual(RAW);
  });

  test("an archive that cannot go in undoes the folder: the earlier one is back", async () => {
    // A folder where the archive goes: a rename cannot replace it.
    mkdirSync(join(runDir, BUNDLE_ARCHIVE));
    writeFileSync(join(runDir, BUNDLE_ARCHIVE, "keep"), "x");
    mkdirSync(join(runDir, BUNDLE_DIR));
    writeFileSync(join(runDir, BUNDLE_DIR, "old.html"), "old folder");

    await expect(buildReportBundle(options({ mode: "both" }))).rejects.toThrow(
      /Cannot put the report bundle in place at .*report\.tar\.gz/,
    );

    expect(readdirSync(join(runDir, BUNDLE_DIR))).toEqual(["old.html"]);
    expect(readdirSync(join(runDir, BUNDLE_ARCHIVE))).toEqual(["keep"]);
    expect(workDirs()).toEqual([]);
  });

  test("placeFolder: a new folder that cannot go in puts the earlier one back", async () => {
    const target = join(runDir, BUNDLE_DIR);
    mkdirSync(target);
    writeFileSync(join(target, "old.html"), "old folder");
    const built = join(root, "built");
    mkdirSync(built);
    /** Refuses only the new folder's move into place. */
    const move: Move = (from, to) =>
      from === built
        ? Promise.reject(
            Object.assign(new Error("refused"), { code: "EACCES" }),
          )
        : rename(from, to);

    await expect(
      placeFolder(built, target, join(root, "aside"), move),
    ).rejects.toThrow(
      `Cannot put the report bundle in place at ${target} (EACCES).`,
    );

    expect(readdirSync(target)).toEqual(["old.html"]);
    expect(existsSync(join(root, "aside"))).toBe(false);
    expect(existsSync(built)).toBe(true);
  });

  test("placeFolder: an earlier folder that cannot go back waits aside", async () => {
    const target = join(runDir, BUNDLE_DIR);
    mkdirSync(target);
    writeFileSync(join(target, "old.html"), "old folder");
    const aside = join(root, "aside");
    /** Moves the earlier folder aside, then refuses every other move. */
    const move: Move = (from, to) =>
      to === aside
        ? rename(from, to)
        : Promise.reject(Object.assign(new Error("refused"), { code: "EIO" }));

    await expect(
      placeFolder(join(root, "built"), target, aside, move),
    ).rejects.toThrow(/\(EIO\)/);

    expect(existsSync(target)).toBe(false);
    expect(readdirSync(aside)).toEqual(["old.html"]);
  });

  test("an earlier report/ a killed build left aside goes back, even when this build fails", async () => {
    // Killed between moving the earlier report/ aside and moving the new one in.
    const work = join(runDir, `.bundle-work-${String(deadPid())}-deadbeef`);
    mkdirSync(join(work, "previous"), { recursive: true });
    writeFileSync(join(work, "previous", "old.html"), "old folder");
    writeFileSync(join(work, "target"), join(runDir, BUNDLE_DIR));
    const { bin } = tarStub("fail");

    await expect(
      buildReportBundle(options({ mode: "both", tarBin: bin })),
    ).rejects.toBeInstanceOf(BundleArchiveError);

    expect(readdirSync(join(runDir, BUNDLE_DIR))).toEqual(["old.html"]);
    expect(workDirs()).toEqual([]);
  });

  test("a copy that fails puts nothing in place", async () => {
    test.skip(process.getuid?.() === 0, "root reads any file");
    writeEarlier();
    const unreadable = join(runDir, "playwright", "data", "aa11.png");
    chmodSync(unreadable, 0o000);

    await expect(
      buildReportBundle(options({ mode: "both" })),
    ).rejects.toMatchObject({ code: "EACCES" });

    chmodSync(unreadable, 0o644);
    expectEarlierUntouched();
  });
});

test.describe("buildReportBundle: stopping and killing", () => {
  test("a stop before it starts does nothing", async () => {
    const stop = new AbortController();
    stop.abort();

    await expect(
      buildReportBundle(options({ signal: stop.signal })),
    ).rejects.toBeInstanceOf(ReportBundleAbortedError);
    expect(runEntries()).toEqual(RAW);
  });

  test("a stop while tar packs ends it, waits for it, and puts nothing in place", async () => {
    const { bin, pidFile } = tarStub("hang");
    const stop = new AbortController();
    const building = buildReportBundle(
      options({ mode: "both", tarBin: bin, signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const pid = await stubPid(pidFile);

    stop.abort();

    expect(await building).toBeInstanceOf(ReportBundleAbortedError);
    expect(alive(pid)).toBe(false);
    expect(runEntries()).toEqual(RAW);
  });

  test("a stop waits for tar to end, so nothing writes into the work folder once it is gone", async () => {
    const { bin, pidFile } = tarStub("slow-stop");
    const stop = new AbortController();
    const building = buildReportBundle(
      options({ tarBin: bin, signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    const pid = await stubPid(pidFile);

    stop.abort();

    expect(await building).toBeInstanceOf(ReportBundleAbortedError);
    // A build that did not wait returns while tar still runs; once tar ends it has written.
    await expect.poll(() => alive(pid)).toBe(false);
    expect(runEntries()).toEqual(RAW);
  });

  test("a stop while Allure generates ends the build, and puts nothing in place", async () => {
    const stop = new AbortController();
    const building = buildReportBundle(
      options({
        allureBin: writeAllureStub(stubDir, "hang"),
        signal: stop.signal,
      }),
    ).catch((caught: unknown) => caught);
    await expect
      .poll(() => existsSync(join(stubDir, "calls.jsonl")))
      .toBe(true);

    stop.abort();

    expect(await building).toBeInstanceOf(ReportBundleAbortedError);
    expect(runEntries()).toEqual(RAW);
  });

  test("a build killed outright leaves no output; the next one removes its work folder", async () => {
    const { bin, pidFile } = tarStub("hang");
    const module = pathToFileURL(join(import.meta.dirname, "report-bundle.ts"));
    // A process of its own, so it can be killed as a crash or `kill -9` would end it.
    const child = spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        "--input-type=module",
        "--eval",
        `const { buildReportBundle } = await import(${JSON.stringify(module.href)});
         await buildReportBundle(${JSON.stringify(options({ mode: "both", tarBin: bin }))});`,
      ],
      { stdio: "ignore" },
    );
    const ended = new Promise((settle) => child.once("close", settle));
    const tarPid = await stubPid(pidFile);
    child.kill("SIGKILL");
    process.kill(tarPid, "SIGKILL");
    await ended;

    expect(runEntries().filter((name) => !name.startsWith("."))).toEqual(RAW);
    expect(workDirs()).toHaveLength(1);

    await buildReportBundle(options({ mode: "both" }));

    expect(workDirs()).toEqual([]);
    expect(runEntries()).toEqual([...RAW, BUNDLE_ARCHIVE, BUNDLE_DIR].sort());
  });

  test("removes dead builds' work folders, never a live one's", async () => {
    const deadOwner = String(deadPid());
    const dead = `.bundle-work-${deadOwner}-deadbeef`;
    mkdirSync(join(runDir, dead, "x"), { recursive: true });
    // pid 1 runs everywhere, and is never this process.
    const live = ".bundle-work-1-0123abcd";
    mkdirSync(join(runDir, live));
    // The Allure generator's, of a dead process too: its own to release, never the bundle's (the
    // generator is faked here, so only the bundle's sweep could touch it).
    const allureWork = `.allure-work-${deadOwner}-0123abcd`;
    mkdirSync(join(runDir, allureWork));

    await buildReportBundle(
      options({
        generateAllure: (allure) => Promise.resolve(fakeReport(allure)),
      }),
    );

    expect(workDirs()).toEqual([live]);
    expect(existsSync(join(runDir, allureWork))).toBe(true);
  });

  test("two builds of one run in one process leave each other's work folder alone", async () => {
    const { bin, pidFile } = tarStub("hang");
    const stop = new AbortController();
    const first = buildReportBundle(
      options({ tarBin: bin, signal: stop.signal }),
    ).catch((caught: unknown) => caught);
    await stubPid(pidFile);
    const [working] = workDirs();

    await buildReportBundle(options({ mode: "folder" }));

    expect(workDirs()).toEqual([working]);
    stop.abort();
    expect(await first).toBeInstanceOf(ReportBundleAbortedError);
  });
});

test.describe("buildReportBundle: nothing is followed out of the run", () => {
  test("a report folder that is a link is not copied, and the page says why", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "index.html"), "SECRET outside the run");
    removeTempRoot(join(runDir, "playwright"));
    symlinkSync(outside, join(runDir, "playwright"));

    const bundle = await buildReportBundle(options({ mode: "folder" }));

    expect(existsSync(join(runDir, BUNDLE_DIR, "playwright"))).toBe(false);
    expect(bundle.reports[0]).toEqual({
      kind: "playwright",
      present: false,
      reason: "it is a link, which is never followed: not copied",
    });
  });

  test("links, FIFOs and sockets inside a report are left out and named", async () => {
    const outside = join(root, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "SECRET");
    symlinkSync(
      join(outside, "secret.txt"),
      join(runDir, "cucumber", "linked.txt"),
    );
    symlinkSync(outside, join(runDir, "cucumber", "linked-dir"));
    // `fs.cp` never opens a FIFO or socket: unfiltered, it throws on either, failing the bundle.
    const fifo = join(runDir, "playwright", "data", "pipe.zip");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    await socketAt(join(runDir, "playwright", "socket"));

    const bundle = await buildReportBundle(options({ mode: "both" }));

    expect(bundle.skipped).toEqual([
      "cucumber/linked-dir",
      "cucumber/linked.txt",
      "playwright/data/pipe.zip",
      "playwright/socket",
    ]);
    const folder = join(runDir, BUNDLE_DIR);
    expect(readdirSync(join(folder, "cucumber"))).toEqual(["index.html"]);
    const entries = listTarGz(join(runDir, BUNDLE_ARCHIVE));
    expect(entries.some((entry) => /linked|pipe|socket/.test(entry.path))).toBe(
      false,
    );
    // Only files and folders: no link entry of any kind.
    expect(new Set(entries.map((entry) => entry.type))).toEqual(
      new Set(["0", "5"]),
    );
  });

  test("a run-facts.json that is not JSON, or too large, is neither shown nor copied", async () => {
    for (const content of [
      "{ not json",
      // Over the limit even though its first 256 KiB parse: whitespace after the object.
      JSON.stringify(FACTS) + " ".repeat(300 * 1024),
    ]) {
      writeFileSync(join(runDir, "run-facts.json"), content);

      await buildReportBundle(options({ mode: "folder" }));

      const landing = readFileSync(
        join(runDir, BUNDLE_DIR, "index.html"),
        "utf8",
      );
      expect(landing).toContain("No run facts");
      expect(landing).not.toContain("pro@nginx &lt;script");
      expect(existsSync(join(runDir, BUNDLE_DIR, "run-facts.json"))).toBe(
        false,
      );
    }
  });

  test("inspectReportFolder: an index.html that is a link is no index", async () => {
    const folder = join(runDir, "playwright");
    removeTempRoot(join(folder, "index.html"));
    symlinkSync(join(root, "elsewhere.html"), join(folder, "index.html"));

    expect(await inspectReportFolder(folder)).toEqual({
      kind: "folder",
      folders: ["data", "trace"],
    });
  });

  test("inspectReportFolder: a path that cannot be looked at, or a folder that cannot be listed, is unreadable", async () => {
    // A path through a file: lstat fails, but not with ENOENT.
    expect(
      await inspectReportFolder(join(runDir, "results.jsonl", "playwright")),
    ).toEqual({ kind: "unreadable", folders: [] });
    test.skip(process.getuid?.() === 0, "root lists any folder");
    const folder = join(runDir, "cucumber");
    chmodSync(folder, 0o000);
    try {
      expect(await inspectReportFolder(folder)).toEqual({
        kind: "unreadable",
        folders: [],
      });
    } finally {
      chmodSync(folder, 0o755);
    }
  });

  test("a run-facts.json that is a link is not read", async () => {
    const outside = join(root, "facts.json");
    writeFileSync(outside, JSON.stringify({ ...FACTS, title: "FROM OUTSIDE" }));
    removeTempRoot(join(runDir, "run-facts.json"));
    symlinkSync(outside, join(runDir, "run-facts.json"));

    await buildReportBundle(options({ mode: "folder" }));

    const landing = readFileSync(
      join(runDir, BUNDLE_DIR, "index.html"),
      "utf8",
    );
    expect(landing).not.toContain("FROM OUTSIDE");
    expect(existsSync(join(runDir, BUNDLE_DIR, "run-facts.json"))).toBe(false);
  });
});

test.describe("the bundle and report retention", () => {
  test("a bundled run is still one complete run, pruned whole with its bundle", async () => {
    await buildReportBundle(options({ mode: "both" }));

    const listing = listGroupRuns(cellDir, "backwpup/pro@nginx");

    expect(listing.runs.map((run) => [run.name, run.complete])).toEqual([
      [RUN_ID, true],
    ]);
    expect(listing.skipped.map((entry) => entry.path)).not.toContainEqual(
      expect.stringContaining(BUNDLE_DIR),
    );
  });
});

test.describe("pure parts", () => {
  test("tarArgs: gzip the name from its folder, with no extended attributes or ACLs", () => {
    expect(tarArgs("/w/report.tar.gz", "/w", "n")).toEqual([
      "--no-xattrs",
      "--no-acls",
      "-czf",
      "/w/report.tar.gz",
      "-C",
      "/w",
      "n",
    ]);
  });

  test("tarEnv: the caller's environment with macOS's AppleDouble entries off", () => {
    expect(tarEnv({ PATH: "/bin" })).toEqual({
      PATH: "/bin",
      COPYFILE_DISABLE: "1",
    });
  });

  test("allureFailureReason: short, without paths", async () => {
    const {
      AllureResultsMissingError,
      MalformedAllureResultError,
      AllureCliMissingError,
    } = await import("./allure-errors");
    expect(
      allureFailureReason(
        new AllureResultsMissingError("/r/allure-results", "missing"),
      ),
    ).toBe("the run left no Allure results");
    expect(
      allureFailureReason(
        new AllureResultsMissingError("/r/allure-results", "empty"),
      ),
    ).toBe("the run's Allure results hold no test result");
    expect(
      allureFailureReason(
        new MalformedAllureResultError(
          "/r/allure-results/x-result.json",
          "bad",
        ),
      ),
    ).toBe("an Allure result is malformed (x-result.json)");
    expect(
      allureFailureReason(new AllureCliMissingError("/bin/allure", "ENOENT")),
    ).toBe("the Allure CLI could not be started (ENOENT)");
    expect(
      allureFailureReason(new AllureGenerationFailedError(null, "SIGKILL", "")),
    ).toBe("allure generate was ended by SIGKILL");
    expect(
      allureFailureReason(Object.assign(new Error("x"), { code: "ENOSPC" })),
    ).toBe("the Allure report could not be generated (ENOSPC)");
    expect(allureFailureReason(new Error("x"))).toBe(
      "the Allure report could not be generated",
    );
  });

  test("bundleLog: where and how big, then what is missing or left out", () => {
    const bundle: ReportBundle = {
      name: "n",
      mode: "both",
      archive: { path: "/r/report.tar.gz", bytes: 4_500_000 },
      folder: { path: "/r/report", bytes: 11_300_000 },
      bytes: 11_300_000,
      reports: [
        {
          kind: "playwright",
          present: true,
          href: "playwright/index.html",
          pages: [],
        },
        {
          kind: "cucumber",
          present: false,
          reason: "the run did not write it",
        },
        {
          kind: "allure",
          present: false,
          reason: "the run left no Allure results",
        },
      ],
      skipped: ["a", "b", "c", "d", "e", "f"],
      analyticsLeft: [],
      allureError: null,
    };

    expect(bundleLog(bundle)).toEqual([
      "Report bundle n: /r/report.tar.gz (4.5 MB) and /r/report/; 11.3 MB unpacked.",
      "Report bundle: no cucumber report — the run did not write it.",
      "Report bundle: no allure report — the run left no Allure results.",
      "Report bundle: left out 6 link(s) or special file(s): a, b, c, d, e, ….",
    ]);
  });
});

test.describe("buildReportBundle, with the real Allure CLI", () => {
  // The real CLI takes about a second per report.
  test.slow();

  test("strip: the bundle's Allure is one file per plugin, with no analytics loader anywhere", async () => {
    const bundle = await buildReportBundle(
      options({ allureBin: undefined, mode: "both" }),
    );

    const allure = join(runDir, BUNDLE_DIR, "allure");
    expect(readdirSync(join(allure, "awesome")).sort()).toEqual([
      "index.html",
      "summary.json",
    ]);
    expect(bundle.analyticsLeft).toEqual([]);
    const unpacked = join(await unpack(join(runDir, BUNDLE_ARCHIVE)), NAME);
    for (const [path, base64] of tree(unpacked)) {
      if (path.endsWith(".html")) {
        expect(
          Buffer.from(base64, "base64").toString("utf8"),
          path,
        ).not.toContain("googletagmanager");
      }
    }
    expect(
      readFileSync(join(allure, "awesome", "index.html"), "utf8"),
    ).toContain(FACTS.title.slice(0, 20));
  });
});
