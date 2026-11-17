import { test, expect } from "@playwright/test";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { Counts } from "./results";
import type { RunDescription } from "./run-description";
import {
  BANNER_ID,
  bannerHtml,
  bannerSplice,
  beginFacts,
  endFacts,
  escapePropertyKey,
  escapePropertyValue,
  factEntries,
  factText,
  metadataOf,
  missingFact,
  runFactsJson,
  statusFact,
  titleLine,
  toProperties,
  withSetupAttachment,
  withSetupEnded,
  type RunFacts,
  type SetupState,
} from "./run-facts";

/**
 * The run's facts, pure: how they start, what each setup's attachment and end add, the verdict, and
 * each way a report shows them — the title line, Allure's properties, the Cucumber banner and where it
 * goes, the metadata, `run-facts.json`. A fact that is not known is said, never blank.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

const COMMIT = "1dceea8966b2c4d6e8f0a1b3c5d7e9f1a3b5c7d9";
const SHA = "0123456789abcdef".repeat(4);
const STARTED = new Date("2026-10-12T10:00:00.000Z");
const ENDED = new Date("2026-10-12T10:03:20.000Z");

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "2026-10-12T10-00-00-000Z-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/2026-10-12T10-00-00-000Z-1",
  reportPath: "/repo/reports/backwpup/pro@nginx/2026-10-12T10-00-00-000Z-1",
};

/** The projects a pinned run of `pro@nginx` plans: its two setups and two scenarios. */
const PLAN = [
  "setup:pro@nginx",
  "artifacts:pro@nginx",
  "pro@nginx",
  "pro@nginx",
];

/** The artifacts setup's attachment for a verified build, as `reportSummary` writes it. */
function resolved(overrides: Record<string, unknown> = {}): unknown {
  return {
    ok: true,
    pluginName: "BackWPup Pro",
    roles: [
      {
        role: "plugin",
        ok: true,
        checks: [{ name: "resolved", ok: true, detail: "ok" }],
        info: {},
        artifact: {
          zipFilename: "backwpup-pro.zip",
          source: "env-ref",
          ref: `commit:${COMMIT}`,
          commit: COMMIT,
          version: "9.99.99",
          sha256: SHA,
          ...overrides,
        },
      },
    ],
  };
}

/** The auth setup's attachment for one site. */
const SITE_INFO = [
  {
    baseURL: "https://bwu3.example",
    versions: {
      wordpress: "7.1.3",
      php: "8.5.11 64bit",
      phpSapi: "fpm-fcgi",
      webServer: "nginx/1.24.0",
      database: "8.0.46",
      databaseExtension: "mysqli",
    },
  },
];

/** Counts with `total` scenarios, the given ones set. */
function counts(total: number, set: Partial<Counts> = {}): Counts {
  return {
    total,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
    drained: 0,
    ...set,
  };
}

/** The facts of a pinned run whose two setups passed, recording the build and the site. */
function knownFacts(run: RunDescription = RUN): RunFacts {
  let facts = beginFacts(run, PLAN, STARTED);
  facts = withSetupAttachment(facts, "artifacts:pro@nginx", resolved());
  facts = withSetupEnded(facts, "artifacts:pro@nginx", "passed");
  facts = withSetupAttachment(facts, "setup:pro@nginx", SITE_INFO);
  return withSetupEnded(facts, "setup:pro@nginx", "passed");
}

/** The facts of `knownFacts` once the run passed. */
function passedFacts(run: RunDescription = RUN): RunFacts {
  return endFacts(
    knownFacts(run),
    {
      status: "passed",
      durationMs: 200_000.4,
      scenarios: counts(2, { passed: 2 }),
    },
    ENDED,
  );
}

test.describe("factText", () => {
  test("one line of plain text: escape sequences gone, controls a space", () => {
    expect(factText("a\u001b[31mred\u001b[0m\nnext\tline")).toBe(
      "ared next line",
    );
  });

  test("masks every credential — a token, a URL parameter — before the cut", () => {
    expect(factText("token ghp_16CharsOrMoreAAAA refused")).toBe(
      "token *** refused",
    );
    expect(factText("https://h/r.git?access_token=abc: refused")).toBe(
      "https://h/r.git?access_token=*** refused",
    );
    // Cut inside the password, were the cut first.
    const long = `${"x".repeat(275)} https://user:SECRETPASSWORD@host`;
    expect(factText(long)).not.toMatch(/SECRET/);
  });

  test("masks credentials in a URL, whatever the scheme", () => {
    expect(
      factText(
        "clone of https://x-access-token:ghs_SECRET@github.com/o/r failed",
      ),
    ).toBe("clone of https://***@github.com/o/r failed");
    expect(factText("ssh://git@host/x and http://u:p@h")).toBe(
      "ssh://***@host/x and http://***@h",
    );
    // An address with no credentials is left alone.
    expect(factText("https://bwu3.example/wp-admin")).toBe(
      "https://bwu3.example/wp-admin",
    );
  });

  test("cuts a runaway value at 300 characters, an ellipsis last", () => {
    const text = factText("x".repeat(1000));
    expect(text).toHaveLength(300);
    expect(text.endsWith("…")).toBe(true);
  });
});

test.describe("missingFact", () => {
  test("says why a fact is not known, for every state of its setup", () => {
    const states: Record<SetupState, string> = {
      pending: "pending: auth setup not finished",
      passed: "unknown: auth setup left no record",
      failed: "unknown: auth setup failed",
      skipped: "unknown: auth setup skipped",
      interrupted: "unknown: auth setup interrupted",
      "did-not-run": "unknown: auth setup did not run",
      "not-in-run": "unknown: auth setup not in this run",
    };
    for (const [state, phrase] of Object.entries(states)) {
      expect(missingFact("auth", state as SetupState)).toBe(phrase);
    }
    expect(missingFact("artifacts", "failed")).toBe(
      "unknown: artifacts setup failed",
    );
  });
});

test.describe("beginFacts", () => {
  test("starts running, with the planned setups pending and the rest not in the run", () => {
    const facts = beginFacts(RUN, ["setup:pro@nginx", "pro@nginx"], STARTED);
    expect(facts).toEqual({
      product: "backwpup",
      cell: "pro@nginx",
      edition: "pro",
      runId: RUN.runId,
      status: "running",
      startedAt: "2026-10-12T10:00:00.000Z",
      setupFailures: [],
      cells: [
        {
          cell: "pro@nginx",
          setups: { auth: "pending", artifacts: "not-in-run" },
          plugins: [],
          sites: [],
        },
      ],
    });
  });

  test("a run of every cell lists each cell in plan order; one planning nothing has its cell alone", () => {
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    const facts = beginFacts(
      everyCell,
      ["setup:b", "artifacts:a", "a", "setup:a"],
      STARTED,
    );
    expect(facts.cells.map((record) => [record.cell, record.setups])).toEqual([
      ["b", { auth: "pending", artifacts: "not-in-run" }],
      ["a", { auth: "pending", artifacts: "pending" }],
    ]);
    expect(beginFacts(RUN, [], STARTED).cells).toEqual([
      {
        cell: "pro@nginx",
        setups: { auth: "not-in-run", artifacts: "not-in-run" },
        plugins: [],
        sites: [],
      },
    ]);
  });

  test("keeps the display-only name and ref as plain text; a blank one is absent", () => {
    const named = beginFacts(
      { ...RUN, runName: "nightly\n\u001b[1mrun", requestedRef: " develop " },
      PLAN,
      STARTED,
    );
    expect(named).toMatchObject({
      runName: "nightly run",
      requestedRef: "develop",
    });
    const blank = beginFacts({ ...RUN, runName: " \n " }, PLAN, STARTED);
    expect(blank).not.toHaveProperty("runName");
  });

  test("keeps the suite's version as plain text; absent or blank, the facts hold none", () => {
    expect(
      beginFacts({ ...RUN, suiteVersion: "1.1.0" }, PLAN, STARTED),
    ).toMatchObject({ suiteVersion: "1.1.0" });
    expect(
      beginFacts({ ...RUN, suiteVersion: "1.1.0\n\u001b[1m" }, PLAN, STARTED),
    ).toMatchObject({ suiteVersion: "1.1.0" });
    expect(beginFacts(RUN, PLAN, STARTED)).not.toHaveProperty("suiteVersion");
    expect(
      beginFacts({ ...RUN, suiteVersion: " \n " }, PLAN, STARTED),
    ).not.toHaveProperty("suiteVersion");
  });
});

test.describe("withSetupAttachment", () => {
  test("the artifacts setup's attachment gives the plugin; the auth setup's the sites", () => {
    const facts = knownFacts();
    const [record] = facts.cells;
    expect(record?.plugins).toEqual([
      {
        role: "plugin",
        ok: true,
        name: "BackWPup Pro",
        version: "9.99.99",
        ref: `commit:${COMMIT}`,
        commit: COMMIT,
        zip: "backwpup-pro.zip",
        source: "env-ref",
        sha256: SHA,
      },
    ]);
    expect(record?.sites).toEqual(SITE_INFO);
  });

  test("an attachment with no fact — missing, malformed — never erases an earlier record", () => {
    const facts = knownFacts();
    for (const attachment of [undefined, "x", {}, { roles: "no" }, [], [{}]]) {
      expect(
        withSetupAttachment(facts, "artifacts:pro@nginx", attachment),
      ).toBe(facts);
      expect(withSetupAttachment(facts, "setup:pro@nginx", attachment)).toBe(
        facts,
      );
    }
  });

  test("a scenario's project changes nothing; a setup of an unplanned cell adds its cell", () => {
    const facts = beginFacts(RUN, PLAN, STARTED);
    expect(withSetupAttachment(facts, "pro@nginx", resolved())).toBe(facts);
    const other = withSetupAttachment(facts, "setup:free@nginx", SITE_INFO);
    expect(other.cells.map((record) => record.cell)).toEqual([
      "pro@nginx",
      "free@nginx",
    ]);
  });

  test("what a site or a build reported is kept as plain text, whatever it holds", () => {
    let facts = withSetupAttachment(
      beginFacts(RUN, PLAN, STARTED),
      "setup:pro@nginx",
      [
        {
          baseURL: "https://bwu3.example",
          versions: {
            wordpress: "7.1.3\u001b]8;;https://x\u0007",
            php: "8.5\n11",
          },
        },
      ],
    );
    facts = withSetupAttachment(
      facts,
      "artifacts:pro@nginx",
      resolved({ version: "9.99\u001b[31m.99", ref: "dev\telop" }),
    );
    expect(facts.cells[0]?.sites[0]).toEqual({
      baseURL: "https://bwu3.example",
      versions: { wordpress: "7.1.3", php: "8.5 11" },
    });
    expect(facts.cells[0]?.plugins[0]).toMatchObject({
      version: "9.99.99",
      ref: "dev elop",
    });
  });

  test("errors a setup recorded are made plain, credentials masked", () => {
    const failed = {
      roles: [
        {
          role: "plugin",
          ok: false,
          checks: [
            {
              name: "build",
              ok: false,
              detail: "clone https://tok:SECRET@github.com/x failed\nmore",
            },
          ],
        },
      ],
    };
    const facts = withSetupAttachment(
      withSetupAttachment(
        beginFacts(RUN, PLAN, STARTED),
        "artifacts:pro@nginx",
        failed,
      ),
      "setup:pro@nginx",
      [
        {
          baseURL: "https://bwu3.example",
          error: "login of http://u:p@h \u001b[2Jfailed",
        },
      ],
    );
    expect(JSON.stringify(facts)).not.toContain("SECRET");
    expect(facts.cells[0]?.plugins[0]).toEqual({
      role: "plugin",
      ok: false,
      error: "build: clone https://***@github.com/x failed",
    });
    expect(facts.cells[0]?.sites[0]).toEqual({
      baseURL: "https://bwu3.example",
      error: "login of http://***@h failed",
    });
  });
});

test.describe("withSetupEnded", () => {
  test("records each setup's state; a flaky setup passed in the end", () => {
    let facts = beginFacts(RUN, PLAN, STARTED);
    facts = withSetupEnded(facts, "artifacts:pro@nginx", "flaky");
    facts = withSetupEnded(facts, "setup:pro@nginx", "interrupted");
    expect(facts.cells[0]?.setups).toEqual({
      artifacts: "passed",
      auth: "interrupted",
    });
    expect(facts.setupFailures).toEqual([]);
    expect(withSetupEnded(facts, "pro@nginx", "failed")).toBe(facts);
  });

  test("a failed setup keeps its first error's first line, once per project", () => {
    let facts = beginFacts(RUN, PLAN, STARTED);
    facts = withSetupEnded(
      facts,
      "setup:pro@nginx",
      "failed",
      "Error: first\nstack",
    );
    facts = withSetupEnded(facts, "setup:pro@nginx", "failed", "Error: again");
    facts = withSetupEnded(facts, "artifacts:pro@nginx", "failed");
    expect(facts.setupFailures).toEqual([
      { project: "setup:pro@nginx", setup: "auth", message: "Error: again" },
      {
        project: "artifacts:pro@nginx",
        setup: "artifacts",
        message: "no error recorded",
      },
    ]);
  });
});

test.describe("endFacts", () => {
  test("a setup still pending never ran; the end's time and duration are kept", () => {
    const facts = endFacts(
      beginFacts(RUN, PLAN, STARTED),
      {
        status: "interrupted",
        durationMs: 1234.6,
        scenarios: counts(2, { didNotRun: 2 }),
      },
      ENDED,
    );
    expect(facts.cells[0]?.setups).toEqual({
      auth: "did-not-run",
      artifacts: "did-not-run",
    });
    expect(facts).toMatchObject({
      status: "interrupted",
      endedAt: "2026-10-12T10:03:20.000Z",
      durationMs: 1235,
    });
  });

  test("the verdict is the summary's: interrupted first, then a failed setup, then the counts", () => {
    const failedSetup = withSetupEnded(
      beginFacts(RUN, PLAN, STARTED),
      "setup:pro@nginx",
      "failed",
      "boom",
    );
    const verdict = (
      facts: RunFacts,
      status: "passed" | "failed" | "interrupted" | "timedout",
      scenarios: Counts,
    ): string =>
      endFacts(facts, { status, durationMs: 1, scenarios }, ENDED).status;
    const known = knownFacts();
    expect(verdict(known, "passed", counts(2, { passed: 2 }))).toBe("passed");
    expect(verdict(known, "failed", counts(2, { passed: 1, failed: 1 }))).toBe(
      "failed",
    );
    expect(verdict(known, "timedout", counts(2, { passed: 2 }))).toBe("failed");
    expect(verdict(known, "passed", counts(0))).toBe("no-tests");
    expect(verdict(failedSetup, "failed", counts(2, { didNotRun: 2 }))).toBe(
      "could-not-test",
    );
    expect(verdict(failedSetup, "interrupted", counts(2))).toBe("interrupted");
  });
});

test.describe("titleLine", () => {
  test("the plugin by the ref asked for, its commit short, the site's versions, the run's name", () => {
    expect(
      titleLine(
        passedFacts({ ...RUN, requestedRef: "develop", runName: "nightly" }),
      ),
    ).toBe(
      "backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 · " +
        "WordPress 7.1.3 · PHP 8.5.11 64bit · nightly",
    );
  });

  test("without a requested ref, the ref the run built; without a name, the RUN_ID", () => {
    expect(titleLine(passedFacts())).toBe(
      `backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · commit:${COMMIT} @ 1dceea8966 · ` +
        `WordPress 7.1.3 · PHP 8.5.11 64bit · ${RUN.runId}`,
    );
  });

  test("a provided zip is named by its file", () => {
    let facts = beginFacts(RUN, PLAN, STARTED);
    facts = withSetupAttachment(
      facts,
      "artifacts:pro@nginx",
      resolved({ source: "env-zip", ref: undefined, commit: undefined }),
    );
    expect(titleLine(facts)).toContain(
      "BackWPup Pro 9.99.99 · zip backwpup-pro.zip",
    );
  });

  test("the requested ref names only the zip under test, never another role", () => {
    // Only a `previous` zip recorded: it heads the title by its own ref.
    const facts = withSetupAttachment(
      beginFacts({ ...RUN, requestedRef: "develop" }, PLAN, STARTED),
      "artifacts:pro@nginx",
      {
        pluginName: "BackWPup Pro",
        roles: [
          {
            role: "previous",
            ok: true,
            checks: [],
            artifact: { version: "5.0.0", ref: "release:5.0.0" },
          },
        ],
      },
    );
    expect(titleLine(facts)).toContain("BackWPup Pro 5.0.0 · release:5.0.0 ·");
  });

  test("a missing fact says why, and a state the reports cannot say ends the line", () => {
    const begun = beginFacts(RUN, PLAN, STARTED);
    expect(titleLine(begun)).toBe(
      "backwpup · pro@nginx (pro) · plugin pending: artifacts setup not finished · " +
        `site pending: auth setup not finished · ${RUN.runId} · RUNNING`,
    );
    let failed = withSetupEnded(
      begun,
      "setup:pro@nginx",
      "failed",
      "preflight failed",
    );
    failed = withSetupAttachment(failed, "artifacts:pro@nginx", {
      roles: [
        {
          role: "plugin",
          ok: false,
          checks: [{ name: "zip", ok: false, detail: "missing" }],
        },
      ],
    });
    failed = withSetupEnded(
      failed,
      "artifacts:pro@nginx",
      "failed",
      "zip missing",
    );
    const ended = endFacts(
      failed,
      {
        status: "failed",
        durationMs: 1,
        scenarios: counts(2, { didNotRun: 2 }),
      },
      ENDED,
    );
    expect(titleLine(ended)).toBe(
      "backwpup · pro@nginx (pro) · resolution failed — zip: missing · " +
        `site unknown: auth setup failed · ${RUN.runId} · COULD NOT TEST`,
    );
    const interrupted = endFacts(
      begun,
      { status: "interrupted", durationMs: 1, scenarios: counts(2) },
      ENDED,
    );
    expect(titleLine(interrupted)).toBe(
      "backwpup · pro@nginx (pro) · plugin unknown: artifacts setup did not run · " +
        `site unknown: auth setup did not run · ${RUN.runId} · INTERRUPTED`,
    );
    const noTests = endFacts(
      beginFacts(RUN, [], STARTED),
      { status: "passed", durationMs: 1, scenarios: counts(0) },
      ENDED,
    );
    expect(titleLine(noTests)).toMatch(/· NO TESTS$/);
    // Passed and failed runs say so themselves, in every report.
    expect(titleLine(passedFacts())).not.toMatch(/PASSED|FAILED/);
  });

  test("a pool's distinct versions once each; a site whose versions are unknown says why", () => {
    let facts = knownFacts();
    facts = withSetupAttachment(facts, "setup:pro@nginx", [
      ...SITE_INFO,
      { ...SITE_INFO[0], baseURL: "https://other.example" },
      { baseURL: "https://third.example", error: "Site Health answered 403" },
    ]);
    expect(titleLine(facts)).toContain(
      "WordPress 7.1.3 · PHP 8.5.11 64bit / site versions unknown: Site Health answered 403",
    );
  });

  test("a run of every cell names each cell's facts", () => {
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    let facts = beginFacts(everyCell, ["setup:a", "setup:b"], STARTED);
    facts = withSetupAttachment(facts, "setup:a", SITE_INFO);
    expect(titleLine(facts)).toBe(
      "backwpup · every cell · a: plugin unknown: artifacts setup not in this run · " +
        "WordPress 7.1.3 · PHP 8.5.11 64bit · b: plugin unknown: artifacts setup not in this run · " +
        `site pending: auth setup not finished · ${RUN.runId} · RUNNING`,
    );
  });
});

test.describe("statusFact", () => {
  test("says each state, a killed run's included, and which setups failed", () => {
    const begun = beginFacts(RUN, PLAN, STARTED);
    expect(statusFact(begun)).toMatch(/^running — .*killed$/);
    expect(statusFact(passedFacts())).toBe("passed");
    const failed = endFacts(
      withSetupEnded(begun, "setup:pro@nginx", "failed", "Error: no route"),
      {
        status: "failed",
        durationMs: 1,
        scenarios: counts(2, { didNotRun: 2 }),
      },
      ENDED,
    );
    expect(statusFact(failed)).toBe(
      "could not test — setup:pro@nginx failed: Error: no route",
    );
    expect(
      statusFact(
        endFacts(
          begun,
          { status: "interrupted", durationMs: 1, scenarios: counts(2) },
          ENDED,
        ),
      ),
    ).toBe("interrupted — stopped before it finished");
  });
});

test.describe("factEntries", () => {
  test("the eight Allure shows first: status, plugin, its SHA-256, site, server, cell, run, requested ref", () => {
    const entries = factEntries(
      passedFacts({ ...RUN, requestedRef: "develop", runName: "nightly" }),
    );
    expect(entries.slice(0, 8)).toEqual([
      ["Status", "passed"],
      ["Plugin", `BackWPup Pro 9.99.99 · commit:${COMMIT} @ 1dceea8966`],
      ["Plugin SHA-256", SHA],
      ["Site", "https://bwu3.example · WordPress 7.1.3 · PHP 8.5.11 64bit"],
      ["Server", "PHP SAPI fpm-fcgi · nginx/1.24.0 · database 8.0.46 (mysqli)"],
      ["Cell", "backwpup · pro@nginx (pro)"],
      ["Run", "nightly"],
      ["Requested ref", "develop"],
    ]);
    expect(entries.slice(8)).toEqual([
      ["Plugin commit", COMMIT],
      ["Plugin ref", `commit:${COMMIT}`],
      ["Plugin zip", "backwpup-pro.zip"],
      ["Plugin source", "env-ref"],
      ["Run ID", RUN.runId],
      ["Started", "2026-10-12T10:00:00.000Z"],
      ["Ended", "2026-10-12T10:03:20.000Z"],
      ["Suite", "unknown"],
    ]);
  });

  test("the suite's version is the last entry; every other entry stays where it was", () => {
    for (const run of [
      RUN,
      { ...RUN, requestedRef: "develop", runName: "n" },
    ]) {
      const without = factEntries(passedFacts(run));
      const entries = factEntries(
        passedFacts({ ...run, suiteVersion: "1.1.0" }),
      );
      expect(entries.at(-1)).toEqual(["Suite", "1.1.0"]);
      expect(entries.slice(0, -1)).toEqual(without.slice(0, -1));
      expect(without.at(-1)).toEqual(["Suite", "unknown"]);
    }
  });

  test("with no plugin or site recorded, the version still pushes no fact off Allure's first eight", () => {
    // Setups that failed or were skipped record nothing: few entries precede the run's id and times.
    const short = (run: RunDescription, ended: boolean): RunFacts => {
      const begun = beginFacts(run, PLAN, STARTED);
      return ended
        ? endFacts(
            begun,
            { status: "passed", durationMs: 1, scenarios: counts(0) },
            ENDED,
          )
        : begun;
    };
    for (const run of [RUN, { ...RUN, requestedRef: "develop" }]) {
      for (const ended of [false, true]) {
        const without = factEntries(short(run, ended));
        const entries = factEntries(
          short({ ...run, suiteVersion: "1.1.0" }, ended),
        );
        // The shortest facts have eight entries, the version among them: it displaces nothing.
        const others = (list: [string, string][]): [string, string][] =>
          list.slice(0, 8).filter(([label]) => label !== "Suite");
        expect(others(entries)).toEqual(others(without));
        expect(entries.at(-1)).toEqual(["Suite", "1.1.0"]);
        expect(entries.slice(0, -1)).toEqual(without.slice(0, -1));
        // The times are the facts Suite would have pushed off the front page.
        expect(entries.slice(-3, -1).map(([label]) => label)).toEqual(
          ended ? ["Started", "Ended"] : ["Run ID", "Started"],
        );
      }
    }
  });

  test("a missing fact is said: no plugin, no site, a digest not recorded", () => {
    const begun = factEntries(beginFacts(RUN, PLAN, STARTED));
    expect(begun.slice(0, 3)).toEqual([
      ["Status", expect.stringMatching(/^running/) as unknown as string],
      ["Plugin", "pending: artifacts setup not finished"],
      ["Site", "pending: auth setup not finished"],
    ]);
    const noDigest = withSetupAttachment(
      beginFacts(RUN, PLAN, STARTED),
      "artifacts:pro@nginx",
      resolved({ sha256: undefined }),
    );
    expect(factEntries(noDigest)).toContainEqual(["Plugin SHA-256", "unknown"]);
    for (const [label, value] of factEntries(passedFacts())) {
      expect(value.trim(), label).not.toBe("");
    }
  });

  test("labels stay unique: a second role, a pool's later sites, each cell of a run of every cell", () => {
    let facts = knownFacts();
    facts = withSetupAttachment(facts, "artifacts:pro@nginx", {
      pluginName: "BackWPup Pro",
      roles: [
        ...(resolved() as { roles: unknown[] }).roles,
        {
          role: "previous",
          ok: false,
          checks: [{ name: "build", ok: false, detail: "no tag" }],
        },
      ],
    });
    facts = withSetupAttachment(facts, "setup:pro@nginx", [
      ...SITE_INFO,
      { baseURL: "https://two.example", error: "timeout" },
    ]);
    const labels = factEntries(facts).map(([label]) => label);
    expect(labels).toEqual(
      expect.arrayContaining(["Previous", "Site 2", "Server"]),
    );
    expect(labels).not.toContain("Previous SHA-256");
    expect(labels).not.toContain("Server 2");
    expect(new Set(labels).size).toBe(labels.length);

    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    const many = factEntries(
      beginFacts(everyCell, ["setup:a", "setup:b"], STARTED),
    );
    const manyLabels = many.map(([label]) => label);
    expect(manyLabels).toEqual(
      expect.arrayContaining([
        "Plugin (a)",
        "Site (a)",
        "Plugin (b)",
        "Site (b)",
      ]),
    );
    expect(new Set(manyLabels).size).toBe(manyLabels.length);
  });
});

test.describe("properties escaping", () => {
  test("a key escapes separators, comment marks, spaces and backslashes", () => {
    expect(escapePropertyKey("Plugin SHA-256")).toBe("Plugin\\ SHA-256");
    expect(escapePropertyKey("a=b:c\\d")).toBe("a\\=b\\:c\\\\d");
    expect(escapePropertyKey("#x!y")).toBe("\\#x\\!y");
  });

  test("a value escapes separators, controls and non-ASCII; a space only where it leads", () => {
    expect(escapePropertyValue("a b=c:d")).toBe("a b\\=c\\:d");
    expect(escapePropertyValue(" lead")).toBe("\\ lead");
    expect(escapePropertyValue("a\\b")).toBe("a\\\\b");
    expect(escapePropertyValue("1\n2\r3\t4\f5")).toBe("1\\n2\\r3\\t4\\f5");
    expect(escapePropertyValue("\u001b[0m")).toBe("\\u001B[0m");
    expect(escapePropertyValue("a · é")).toBe("a \\u00B7 \\u00E9");
    // An emoji is its UTF-16 surrogate pair.
    expect(escapePropertyValue("😀")).toBe("\\uD83D\\uDE00");
    expect(escapePropertyValue("#!")).toBe("#!");
  });

  test("Allure's own reader reads back every key and value as written", async () => {
    // The reader allure 3 uses for `environment.properties` (`@allurereport/reader`), by its file:
    // its package exports only its readers. If an upgrade moves it, this fails rather than passes.
    const reader = (await import(
      pathToFileURL(
        join(REPO_ROOT, "node_modules/@allurereport/reader/dist/properties.js"),
      ).href
    )) as { parseProperties: (input: string) => Record<string, string> };
    const nasty: [string, string][] = [
      ["Plugin SHA-256", SHA],
      ["key=with:separators", "value=with:separators and spaces"],
      ["#comment-like", "!bang"],
      ["back\\slash", "C:\\path\\to\\zip"],
      ["Lead", "  two leading spaces"],
      ["Newline", "line one\nline two\r\nthree"],
      ["Tab\tkey", "tab\tvalue"],
      ["Unicode · é", "WordPress · PHP ✓ 😀"],
      ["Control", "\u001b[31mred\u0000\u007f"],
      ["Empty-ish", "="],
    ];
    expect(Object.entries(reader.parseProperties(toProperties(nasty)))).toEqual(
      nasty,
    );
  });

  test("toProperties writes one line per entry, in order", () => {
    expect(
      toProperties([
        ["Status", "passed"],
        ["Cell", "a · b"],
      ]),
    ).toBe("Status=passed\nCell=a \\u00B7 b\n");
  });
});

test.describe("bannerHtml", () => {
  test("the title up front, every entry below, all of it HTML-escaped", () => {
    const html = bannerHtml(
      passedFacts({ ...RUN, runName: `<img src=x onerror="alert(1)">&` }),
    );
    expect(html).toContain(`<div id="${BANNER_ID}"`);
    expect(html).toContain(
      "<strong>backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99",
    );
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;",
    );
    expect(html).not.toContain("<img");
    expect(html).toContain(
      `<th scope="row">Plugin SHA-256</th><td>${SHA}</td>`,
    );
  });

  test("a label, from a role a setup recorded, is HTML-escaped too", () => {
    const facts = withSetupAttachment(
      beginFacts(RUN, PLAN, STARTED),
      "artifacts:pro@nginx",
      {
        roles: [
          {
            role: "<i>x</i>",
            ok: false,
            checks: [{ name: "build", ok: false, detail: "failed" }],
          },
        ],
      },
    );
    const html = bannerHtml(facts);
    expect(html).toContain('<th scope="row">&lt;i&gt;x&lt;/i&gt;</th>');
    expect(html).not.toContain("<i>");
  });

  test("its script carries no value, only the banner's id", () => {
    const html = bannerHtml(passedFacts({ ...RUN, runName: "nightly" }));
    const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1] ?? "";
    expect(script).toContain(BANNER_ID);
    expect(script).not.toContain("nightly");
    expect(script).not.toContain("backwpup");
  });

  test("its accent follows the verdict", () => {
    expect(bannerHtml(passedFacts())).toContain("solid #1a7f37");
    const interrupted = endFacts(
      knownFacts(),
      { status: "interrupted", durationMs: 1, scenarios: counts(2) },
      ENDED,
    );
    expect(bannerHtml(interrupted)).toContain("solid #9a6700");
  });
});

test.describe("bannerSplice", () => {
  const html = (body: string): Buffer =>
    Buffer.from(`<html><body>${body}</body>\n</html>\n`, "utf8");

  test("inserts the banner before the last </body>, by byte, multibyte text before it", () => {
    // A `</body>` inside a script comes earlier than the document's own.
    const tail = html(`é·😀<script>"</body>"</script>`);
    const splice = bannerSplice(tail, "<b>B</b>");
    expect(splice).toBeDefined();
    const { offset = -1, bytes = Buffer.alloc(0) } = splice ?? {};
    expect(tail.subarray(offset).toString("utf8")).toBe("</body>\n</html>\n");
    const result = Buffer.concat([tail.subarray(0, offset), bytes]).toString(
      "utf8",
    );
    expect(result).toBe(
      `<html><body>é·😀<script>"</body>"</script><b>B</b>\n</body>\n</html>\n`,
    );
  });

  test("leaves a report cut short, or one bannered already, alone", () => {
    expect(
      bannerSplice(Buffer.from("<html><body><div>", "utf8"), "<b>B</b>"),
    ).toBeUndefined();
    expect(bannerSplice(Buffer.alloc(0), "<b>B</b>")).toBeUndefined();
    const once = html(`<div id="${BANNER_ID}">x</div>`);
    expect(bannerSplice(once, "<b>B</b>")).toBeUndefined();
  });
});

test.describe("metadataOf and runFactsJson", () => {
  test("the metadata is the entries as flat keys", () => {
    expect(
      metadataOf([
        ["Status", "passed"],
        ["Run", "x"],
      ]),
    ).toEqual({
      Status: "passed",
      Run: "x",
    });
  });

  test("run-facts.json holds the schema version, the title line and every fact", () => {
    const facts = passedFacts();
    const json = JSON.parse(runFactsJson(facts)) as Record<string, unknown>;
    expect(json).toEqual({ v: 1, title: titleLine(facts), ...facts });
    expect(runFactsJson(facts).endsWith("}\n")).toBe(true);
  });

  test("run-facts.json holds the suite's version when known; no key when not", () => {
    const known = JSON.parse(
      runFactsJson(passedFacts({ ...RUN, suiteVersion: "1.1.0-rc.1+b.7" })),
    ) as Record<string, unknown>;
    expect(known).toMatchObject({ v: 1, suiteVersion: "1.1.0-rc.1+b.7" });
    const unknown = JSON.parse(runFactsJson(passedFacts())) as Record<
      string,
      unknown
    >;
    expect(unknown).not.toHaveProperty("suiteVersion");
  });
});

test.describe("withSetupAttachment — a site's URL", () => {
  test("is kept by maskSiteUrl: credentials ***@, no query, a baseURL that is no URL never kept", () => {
    const facts = withSetupAttachment(
      beginFacts(RUN, PLAN, STARTED),
      "setup:pro@nginx",
      [
        { baseURL: "https://u:pw-0001@a.test/wp?k=v", versions: {} },
        { baseURL: "https://u:pa ss-word9@bad host/", error: "timeout" },
      ],
    );
    const json = JSON.stringify(facts);
    for (const secret of ["pw-0001", "ss-word9", "k=v"])
      expect(json).not.toContain(secret);
    expect(json).toContain('"baseURL":"https://***@a.test/wp"');
    expect(json).toContain('"baseURL":"(not a valid http(s) URL)"');
  });
});
