import { test, expect } from "@playwright/test";

import {
  runBegin,
  runEnd,
  scenarioEnd,
  streamOf,
} from "../__fixtures__/results";
import { readRunResults } from "../runs/results";
import {
  buildRunFinished,
  MAX_SCENARIO_ERROR,
  type RunFinishedInput,
} from "./run-finished";

/** A run that ended with one failed and one flaky scenario, every fact known. */
const INPUT: RunFinishedInput = {
  at: new Date("2026-10-13T11:09:42.000Z"),
  run: { id: "bpng-12", runId: "2026-10-13T10-15-31-042Z-bpng-12" },
  task: {
    id: "bpng",
    name: "BackWPup Pro on nginx",
    product: "backwpup",
    cell: "pro@nginx",
    ref: "develop",
    grep: "@smoke",
  },
  startedAt: new Date("2026-10-13T10:15:31.042Z"),
  endedAt: new Date("2026-10-13T11:09:41.042Z"),
  outcome: { status: "failed" },
  results: readRunResults(
    streamOf([
      runBegin(3),
      scenarioEnd("a", "failed", {
        feature: "Backups",
        scenario: "A backup runs on demand",
        path: ["Rule: on demand"],
        attempts: 3,
        durationMs: 9000,
        error: {
          message: '\u001b[31mExpected "Done"\u001b[39m\nReceived "Error"',
          where: "step",
        },
      }),
      scenarioEnd("b", "flaky", { attempts: 2 }),
      runEnd("failed", {
        total: 3,
        failed: 1,
        flaky: 1,
        interrupted: 0,
        didNotRun: 1,
      }),
    ]),
  ),
  facts: {
    edition: "pro",
    plugin: {
      name: "BackWPup Pro",
      version: "9.99.99",
      ref: "develop",
      commit: "f1ebfd0".padEnd(40, "0"),
    },
    sites: [
      { baseURL: "https://a.test", wordpress: "7.1.2", php: "8.5.10" },
      { baseURL: "https://b.test" },
    ],
    setupFailures: [],
  },
  reportDir:
    "/srv/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12",
  log: "/srv/e2e/.orchestrator/runs/bpng-12/run.log",
  secrets: [],
};

test.describe("buildRunFinished", () => {
  test("builds every field of version 1 from the run, its outcome, its results and its facts", () => {
    expect(buildRunFinished(INPUT)).toEqual({
      v: 1,
      type: "run.finished",
      at: "2026-10-13T11:09:42.000Z",
      run: {
        id: "bpng-12",
        runId: "2026-10-13T10-15-31-042Z-bpng-12",
        name: "BackWPup Pro on nginx",
        trigger: "loop",
        task: { id: "bpng", name: "BackWPup Pro on nginx", grep: "@smoke" },
      },
      unit: { product: "backwpup", cell: "pro@nginx", edition: "pro" },
      plugin: {
        requestedRef: "develop",
        ref: "develop",
        commit: "f1ebfd0".padEnd(40, "0"),
        version: "9.99.99",
        name: "BackWPup Pro",
      },
      sites: [
        { baseURL: "https://a.test", wordpress: "7.1.2", php: "8.5.10" },
        { baseURL: "https://b.test", wordpress: null, php: null },
      ],
      status: "failed",
      reason: null,
      startedAt: "2026-10-13T10:15:31.042Z",
      endedAt: "2026-10-13T11:09:41.042Z",
      durationMs: 3_250_000,
      counts: {
        total: 3,
        passed: 0,
        failed: 1,
        flaky: 1,
        skipped: 0,
        didNotRun: 1,
      },
      scenarios: [
        {
          feature: "Backups",
          name: "A backup runs on demand",
          path: ["Rule: on demand"],
          status: "failed",
          attempts: 3,
          durationMs: 9000,
          error: 'Expected "Done"\nReceived "Error"',
        },
        {
          feature: "Backups",
          name: "Scenario b",
          path: [],
          status: "flaky",
          attempts: 2,
          durationMs: 100,
        },
      ],
      report: { dir: INPUT.reportDir, log: INPUT.log, bundle: null },
    });
  });

  test("says what is unknown as null when the run left no results and no facts", () => {
    const event = buildRunFinished({
      ...INPUT,
      task: { id: "bpng", product: "backwpup", cell: "pro@nginx" },
      outcome: { status: "error", reason: "bddgen exited with code 1" },
      results: undefined,
      facts: undefined,
    });
    expect(event.run.name).toBe("bpng-12");
    expect(event.run.task).toEqual({ id: "bpng", name: null, grep: null });
    expect(event.unit.edition).toBeNull();
    expect(event.plugin).toEqual({
      requestedRef: null,
      ref: null,
      commit: null,
      version: null,
      name: null,
    });
    expect(event.sites).toEqual([]);
    expect(event.reason).toBe("bddgen exited with code 1");
    expect(event.counts).toEqual({
      total: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      didNotRun: 0,
    });
    expect(event.scenarios).toEqual([]);
  });

  test("points at no report or log for a run that never had a folder", () => {
    expect(buildRunFinished({ ...INPUT, hadFolder: false }).report).toEqual({
      dir: null,
      log: null,
      bundle: null,
    });
    expect(buildRunFinished({ ...INPUT, hadFolder: true }).report).toEqual({
      dir: INPUT.reportDir,
      log: INPUT.log,
      bundle: null,
    });
  });

  test("names the run's bundle when one was built, within version 1, and never for a run with no folder", () => {
    const bundle = {
      kind: "archive",
      path: `${INPUT.reportDir}/report.tar.gz`,
      name: "backwpup-pro@nginx-2026-10-13T10-15-31-042Z-bpng-12",
    } as const;
    const event = buildRunFinished({ ...INPUT, bundle });
    expect(event.v).toBe(1);
    expect(event.report).toEqual({
      dir: INPUT.reportDir,
      log: INPUT.log,
      bundle,
    });
    // The event goes to subscribers as JSON: the bundle is plain data, `null` when absent.
    expect(
      (JSON.parse(JSON.stringify(event)) as typeof event).report.bundle,
    ).toEqual(bundle);
    expect(
      buildRunFinished({ ...INPUT, bundle, hadFolder: false }).report.bundle,
    ).toBeNull();
    expect(
      buildRunFinished({ ...INPUT, bundle: null }).report.bundle,
    ).toBeNull();
  });

  test("takes the edition from the stream when the facts are missing", () => {
    expect(buildRunFinished({ ...INPUT, facts: undefined }).unit.edition).toBe(
      "pro",
    );
  });

  test("counts an interrupted scenario as not run", () => {
    const results = readRunResults(
      streamOf([
        runEnd("interrupted", {
          total: 4,
          passed: 1,
          interrupted: 1,
          didNotRun: 2,
        }),
      ]),
    );
    expect(buildRunFinished({ ...INPUT, results }).counts.didNotRun).toBe(3);
  });

  test("caps a scenario's error at MAX_SCENARIO_ERROR code points", () => {
    const results = readRunResults(
      streamOf([
        scenarioEnd("a", "failed", {
          error: { message: "é".repeat(5000), where: "test" },
        }),
      ]),
    );
    const [scenario] = buildRunFinished({ ...INPUT, results }).scenarios;
    expect(Array.from(scenario?.error ?? "")).toHaveLength(MAX_SCENARIO_ERROR);
    expect(scenario?.error?.endsWith("…")).toBe(true);
  });

  test("never gives a negative duration for a clock that went back", () => {
    expect(
      buildRunFinished({ ...INPUT, endedAt: new Date("2026-10-13T10:00:00Z") })
        .durationMs,
    ).toBe(0);
  });

  test("names each site by safeSiteUrl: masked by value first, credentials ***@, no query, never a baseURL that is no URL", () => {
    const secret = "Secret-Path-0001?k=v";
    const event = buildRunFinished({
      ...INPUT,
      secrets: [secret],
      facts: {
        sites: [
          { baseURL: `https://u:pw-0001@a.test/${secret}` },
          { baseURL: "https://u:pa ss-word9@bad host/" },
        ],
        setupFailures: [],
      },
    });
    expect(event.sites.map(({ baseURL }) => baseURL)).toEqual([
      "https://***@a.test/***",
      "(not a valid http(s) URL)",
    ]);
  });

  test("makes every text from the run's files safe: one-line names and facts, an error a block, secrets masked", () => {
    const secret = "Tr0ub4dor&3xyz";
    const results = readRunResults(
      streamOf([
        runBegin(1),
        scenarioEnd("a", "failed", {
          feature: "F\u202e\r\n*@channel*",
          scenario: `S ${secret}`,
          path: ["Rule:\u0007 r"],
          error: {
            message: `line\r\u202eevil\u0085\u0007 ${secret}\nnext ghp_\u200b${"a".repeat(36)}`,
            where: "step",
          },
        }),
      ]),
    );
    const event = buildRunFinished({
      ...INPUT,
      secrets: [secret],
      results,
      facts: {
        edition: "pro\u001b[2J",
        plugin: {
          name: "BackWPup\nPro",
          version: secret,
          ref: "dev\u202eelop",
        },
        sites: [{ baseURL: "https://a.test/\r\nX", php: "8.5\u0000" }],
        setupFailures: [],
      },
    });
    expect(event.scenarios[0]).toMatchObject({
      feature: "F *@channel*",
      name: "S ***",
      path: ["Rule: r"],
      // U+0085 is a line break; BEL a space, beside the one already there.
      error: "line\nevil\n  ***\nnext ***",
    });
    expect(event.unit.edition).toBe("pro");
    expect(event.plugin).toMatchObject({
      name: "BackWPup Pro",
      version: "***",
      ref: "develop",
    });
    expect(event.sites).toEqual([
      { baseURL: "https://a.test/ X", wordpress: null, php: "8.5" },
    ]);
  });

  test("carries no field of the wrong type from a malformed stream line", () => {
    const text = `${JSON.stringify({
      v: 1,
      type: "scenario.end",
      at: "x",
      id: "a",
      feature: "F",
      scenario: "S",
      status: "failed",
      path: "notarray",
      attempts: "x",
      durationMs: "1",
      error: { message: {} },
    })}\n`;
    const [scenario] = buildRunFinished({
      ...INPUT,
      results: readRunResults(text),
    }).scenarios;
    expect(scenario).toEqual({
      feature: "F",
      name: "S",
      path: [],
      status: "failed",
      attempts: 0,
      durationMs: 0,
    });
  });

  test("survives JSON as it is: no undefined, no Date", () => {
    const event = buildRunFinished(INPUT);
    expect(JSON.parse(JSON.stringify(event))).toEqual(event);
  });
});
