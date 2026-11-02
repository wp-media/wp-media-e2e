import { test, expect } from "@playwright/test";
import type { FullConfig, FullResult, Suite } from "@playwright/test/reporter";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  addAttempt,
  captureWrites,
  fakeSuite,
  fakeTest,
  jsonAttachment,
  type FakeTest,
} from "../__fixtures__/reporter-fakes";
import {
  ARTIFACTS_ATTACHMENT,
  SITE_INFO_ATTACHMENT,
} from "../setup/attachments";
import type { RunDescription } from "./run-description";
import {
  ALLURE_ENVIRONMENT_FILE,
  ALLURE_RESULTS_DIR,
  BANNER_ID,
  CUCUMBER_REPORT_FILE,
  RUN_FACTS_FILE,
} from "./run-facts";
import RunFactsReporter, { setHtmlTitle } from "./run-facts.reporter";
import { registerTerminalSink } from "./terminal-sink";

/**
 * The run-facts reporter driven as Playwright drives it, on fakes, into a temporary report folder:
 * what each event writes, the HTML title it hands over, the banner it puts on the Cucumber report —
 * and that nothing it meets makes it throw, since a reporter that throws fails the run.
 */

const SHA = "0123456789abcdef".repeat(4);

let dir = "";
let savedTitle: string | undefined;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-run-facts-"));
  savedTitle = process.env.PLAYWRIGHT_HTML_TITLE;
  delete process.env.PLAYWRIGHT_HTML_TITLE;
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedTitle === undefined) delete process.env.PLAYWRIGHT_HTML_TITLE;
  else process.env.PLAYWRIGHT_HTML_TITLE = savedTitle;
});

/** The run, reporting into `folder`. */
function run(
  folder: string,
  extra: Partial<RunDescription> = {},
): RunDescription {
  return {
    product: "backwpup",
    cell: "pro@nginx",
    edition: "pro",
    pinned: true,
    runId: "run-1",
    reportCell: "pro@nginx",
    reportDir: "reports/backwpup/pro@nginx/run-1",
    reportPath: folder,
    ...extra,
  };
}

/** A config as `onBegin` receives it, holding Playwright's own metadata. */
function config(): FullConfig {
  return { metadata: { actualWorkers: 1 } } as unknown as FullConfig;
}

/** A pinned run's tests: its two setups and one scenario. */
function tests(): { auth: FakeTest; artifacts: FakeTest; scenario: FakeTest } {
  return {
    auth: fakeTest({ id: "auth", project: "setup:pro@nginx" }),
    artifacts: fakeTest({ id: "artifacts", project: "artifacts:pro@nginx" }),
    scenario: fakeTest({ id: "s", project: "pro@nginx" }),
  };
}

/** The artifacts setup's attachment for a verified build. */
const RESOLVED = jsonAttachment(ARTIFACTS_ATTACHMENT, {
  pluginName: "BackWPup Pro",
  roles: [
    {
      role: "plugin",
      ok: true,
      checks: [],
      artifact: {
        version: "9.99.99",
        ref: "develop",
        commit: "1dceea8966b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9",
        sha256: SHA,
      },
    },
  ],
});

/** The auth setup's attachment for one site. */
const SITE = jsonAttachment(SITE_INFO_ATTACHMENT, [
  {
    baseURL: "https://bwu3.example",
    versions: { wordpress: "7.1.3", php: "8.5.11 64bit" },
  },
]);

/** `run-facts.json`, parsed. */
function factsFile(folder = dir): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(folder, RUN_FACTS_FILE), "utf8"),
  ) as Record<string, unknown>;
}

/** Allure's `environment.properties`. */
function propertiesFile(folder = dir): string {
  return readFileSync(
    join(folder, ALLURE_RESULTS_DIR, ALLURE_ENVIRONMENT_FILE),
    "utf8",
  );
}

/** A Cucumber report, complete, as the html-formatter's template ends one. */
function writeCucumber(
  folder = dir,
  text = '<html><body><div id="content"></div><script>x</script>\n</body>\n</html>\n',
): string {
  const path = join(folder, CUCUMBER_REPORT_FILE);
  mkdirSync(join(folder, "cucumber"), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/**
 * Drives a whole passing run: both setups record their facts, the scenario passes. Every step runs
 * before it returns — `onExit`'s work too, whose promise is already settled — so a capture around it
 * sees every warning.
 */
function passingRun(
  reporter: RunFactsReporter,
  cfg: FullConfig = config(),
): Promise<void> {
  const t = tests();
  reporter.onBegin(cfg, fakeSuite(Object.values(t)) as unknown as Suite);
  reporter.onTestEnd(
    t.artifacts.test,
    addAttempt(t.artifacts, { status: "passed", attachments: [RESOLVED] }),
  );
  reporter.onTestEnd(
    t.auth.test,
    addAttempt(t.auth, { status: "passed", attachments: [SITE] }),
  );
  reporter.onTestEnd(
    t.scenario.test,
    addAttempt(t.scenario, { status: "passed" }),
  );
  reporter.onEnd({ status: "passed", duration: 1000 } as FullResult);
  return reporter.onExit();
}

test.describe("RunFactsReporter — as the run goes", () => {
  test("onBegin publishes what is known: the facts file, Allure's environment, the metadata", () => {
    const cfg = config();
    const t = tests();
    const reporter = new RunFactsReporter({ ...run(dir), _mode: "test" });
    reporter.onBegin(cfg, fakeSuite(Object.values(t)) as unknown as Suite);
    expect(factsFile()).toMatchObject({
      v: 1,
      status: "running",
      title:
        "backwpup · pro@nginx (pro) · plugin pending: artifacts setup not finished · site pending: auth setup not finished · run-1 · RUNNING",
    });
    expect(propertiesFile()).toMatch(/^Status=running /);
    expect(cfg.metadata).toMatchObject({
      actualWorkers: 1,
      Cell: "backwpup · pro@nginx (pro)",
      Plugin: "pending: artifacts setup not finished",
    });
  });

  test("each setup's end folds in its attachment and rewrites both files, so a killed run leaves them", () => {
    const t = tests();
    const reporter = new RunFactsReporter(run(dir));
    reporter.onBegin(config(), fakeSuite(Object.values(t)) as unknown as Suite);
    reporter.onTestEnd(
      t.artifacts.test,
      addAttempt(t.artifacts, { status: "passed", attachments: [RESOLVED] }),
    );
    expect(factsFile()).toMatchObject({ status: "running" });
    expect(propertiesFile()).toContain(`Plugin\\ SHA-256=${SHA}\n`);
    reporter.onTestEnd(
      t.auth.test,
      addAttempt(t.auth, { status: "passed", attachments: [SITE] }),
    );
    expect(String(factsFile().title)).toContain(
      "WordPress 7.1.3 · PHP 8.5.11 64bit",
    );
  });

  test("onEnd records the verdict and hands the HTML report its title; onExit banners the Cucumber report", async () => {
    const cucumber = writeCucumber();
    const cfg = config();
    await passingRun(
      new RunFactsReporter(run(dir, { requestedRef: "main" })),
      cfg,
    );
    const title =
      "backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · main @ 1dceea8966 · WordPress 7.1.3 · PHP 8.5.11 64bit · run-1";
    expect(factsFile()).toMatchObject({ status: "passed", title });
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBe(title);
    expect(cfg.metadata).toMatchObject({
      Status: "passed",
      "Plugin SHA-256": SHA,
    });
    const html = readFileSync(cucumber, "utf8");
    expect(html).toContain(`<div id="${BANNER_ID}"`);
    expect(html.endsWith("</body>\n</html>\n")).toBe(true);
    expect(html.indexOf(BANNER_ID)).toBeGreaterThan(
      html.indexOf("<script>x</script>"),
    );
  });

  test("a setup whose due retry never ran is settled as the run ends", () => {
    const t = tests();
    const auth = fakeTest({
      id: "auth",
      project: "setup:pro@nginx",
      retries: 1,
    });
    const reporter = new RunFactsReporter(run(dir));
    reporter.onBegin(
      config(),
      fakeSuite([auth, t.artifacts, t.scenario]) as unknown as Suite,
    );
    reporter.onTestEnd(
      auth.test,
      addAttempt(auth, { status: "failed", errors: ["Error: preflight"] }),
    );
    expect(factsFile()).toMatchObject({ setupFailures: [] });
    reporter.onEnd({ status: "interrupted", duration: 10 } as FullResult);
    const facts = factsFile();
    expect(facts.status).toBe("interrupted");
    expect(facts.setupFailures).toEqual([
      {
        project: "setup:pro@nginx",
        setup: "auth",
        message: "Error: preflight",
      },
    ]);
    expect(facts.cells).toEqual([
      expect.objectContaining({
        setups: { auth: "failed", artifacts: "did-not-run" },
      }),
    ]);
  });

  test("a metadata key whose fact went away is removed; Playwright's own keys are kept", () => {
    const cfg = config();
    const t = tests();
    const reporter = new RunFactsReporter(run(dir));
    reporter.onBegin(cfg, fakeSuite(Object.values(t)) as unknown as Suite);
    expect(cfg.metadata).toHaveProperty("Plugin");
    reporter.onTestEnd(
      t.artifacts.test,
      addAttempt(t.artifacts, {
        status: "passed",
        attachments: [
          jsonAttachment(ARTIFACTS_ATTACHMENT, {
            roles: [
              {
                role: "previous",
                ok: true,
                checks: [],
                artifact: { version: "1" },
              },
            ],
          }),
        ],
      }),
    );
    expect(cfg.metadata).not.toHaveProperty("Plugin");
    expect(cfg.metadata).toHaveProperty("Previous");
    expect(cfg.metadata).toHaveProperty("actualWorkers", 1);
  });
});

test.describe("RunFactsReporter — sits out, never throws", () => {
  test("a run that never ended puts no banner on the Cucumber report", async () => {
    const cucumber = writeCucumber();
    const before = readFileSync(cucumber, "utf8");
    const t = tests();
    const reporter = new RunFactsReporter(run(dir));
    reporter.onBegin(config(), fakeSuite(Object.values(t)) as unknown as Suite);
    await reporter.onExit();
    expect(readFileSync(cucumber, "utf8")).toBe(before);
  });

  test("--list writes nothing", async () => {
    const reporter = new RunFactsReporter({ ...run(dir), _mode: "list" });
    const t = tests();
    reporter.onBegin(config(), fakeSuite(Object.values(t)) as unknown as Suite);
    reporter.onEnd({ status: "passed", duration: 1 } as FullResult);
    await reporter.onExit();
    expect(existsSync(join(dir, RUN_FACTS_FILE))).toBe(false);
    expect(existsSync(join(dir, ALLURE_RESULTS_DIR))).toBe(false);
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBeUndefined();
  });

  test("options missing a field: one warning, nothing written", async () => {
    const reporter = new RunFactsReporter({ product: "backwpup" });
    const writes = captureWrites(process.stderr, () => {
      const t = tests();
      reporter.onBegin(
        config(),
        fakeSuite(Object.values(t)) as unknown as Suite,
      );
      reporter.onTestEnd(t.auth.test, addAttempt(t.auth, { status: "passed" }));
      reporter.onEnd({ status: "passed", duration: 1 } as FullResult);
    });
    await reporter.onExit();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^\[run-facts\] the reporter's options lack "reportDir"/,
    );
  });

  test("a folder that cannot be written: one warning, the run's other facts still published", () => {
    // A file where the report folder should be: every write under it fails.
    const blocked = join(dir, "blocked");
    writeFileSync(blocked, "");
    const cfg = config();
    const reporter = new RunFactsReporter(run(blocked));
    const writes = captureWrites(process.stderr, () => {
      void passingRun(reporter, cfg);
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatch(
      /^\[run-facts\] .*\. The reports may not say what the run tested\.\n$/,
    );
    // The metadata and the title need no file.
    expect(cfg.metadata).toHaveProperty("Status", "passed");
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toMatch(/^backwpup · pro@nginx/);
  });

  test("its warning goes through the run's terminal sink when there is one, never stderr", () => {
    const blocked = join(dir, "blocked-sink");
    writeFileSync(blocked, "");
    const printed: string[] = [];
    const unregister = registerTerminalSink({
      print: (text) => printed.push(text),
    });
    try {
      const reporter = new RunFactsReporter(run(blocked));
      const stderr = captureWrites(process.stderr, () => {
        void passingRun(reporter, config());
      });
      expect(stderr).toEqual([]);
      expect(printed).toEqual([
        expect.stringMatching(
          /^\[run-facts\] .*\. The reports may not say what the run tested\.$/,
        ),
      ]);
    } finally {
      unregister();
    }
  });

  test("a Cucumber report cut short, or missing, gets no banner and one warning", () => {
    const cut = writeCucumber(dir, "<html><body><script>never ended");
    const writes: string[] = [];
    const reporter = new RunFactsReporter(run(dir));
    writes.push(
      ...captureWrites(process.stderr, () => {
        void passingRun(reporter);
      }),
    );
    expect(readFileSync(cut, "utf8")).toBe("<html><body><script>never ended");
    expect(writes.join("")).toMatch(/got no banner: it has no <\/body>/);

    const other = mkdtempSync(join(tmpdir(), "e2e-run-facts-none-"));
    try {
      const missing = captureWrites(process.stderr, () => {
        void passingRun(new RunFactsReporter(run(other)));
      });
      expect(missing.join("")).toMatch(/^\[run-facts\] ENOENT/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

test.describe("setHtmlTitle", () => {
  test("sets the title, replaces its own, and keeps one the environment set", () => {
    setHtmlTitle("first");
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBe("first");
    setHtmlTitle("second");
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBe("second");
    process.env.PLAYWRIGHT_HTML_TITLE = "the operator's";
    setHtmlTitle("third");
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBe("the operator's");
    process.env.PLAYWRIGHT_HTML_TITLE = "";
    setHtmlTitle("fourth");
    expect(process.env.PLAYWRIGHT_HTML_TITLE).toBe("fourth");
  });
});
