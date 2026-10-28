import { test, expect } from "@playwright/test";
import { isAbsolute, join } from "node:path";

import { isObject } from "../guards";
import type { RunDescription } from "../reporting/run-description";
import {
  ALLURE_RESULTS_DIR,
  CUCUMBER_REPORT_FILE,
} from "../reporting/run-facts";
import { OUTPUT_ENV } from "./env";
import { reporters } from "./reporting";

/**
 * Where a run's three reports land. They must share one folder, whatever the working directory:
 * Playwright resolves its reporters' paths against the config's folder, while allure-playwright
 * resolves `resultsDir` against the working directory, so only an absolute folder keeps them
 * together. The cell notice must come first, so it prints before the terminal reporter's header; the
 * results stream before the reports, so its last line is not held up by their `onEnd`; the terminal
 * reporter in `list`'s old place, right after the stream; the summary last, so it is the run's final
 * block.
 */

const REPORT_DIR =
  "/srv/checkout/reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1";

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "2026-10-06T00-00-00-000Z-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1",
  reportPath: REPORT_DIR,
};

/** The run with another report path. */
function withPath(reportPath: string): RunDescription {
  return { ...RUN, reportPath };
}

/** The index of one of the suite's own reporters, by its file. */
function ownIndex(names: readonly string[], file: string): number {
  return names.findIndex((name) =>
    name.endsWith(`/src/common/reporting/${file}`),
  );
}

/** The options object of the reporter registered as `name`. */
function optionsOf(name: string): Record<string, unknown> {
  const entry = reporters(RUN).find(([reporter]) => reporter === name);
  const options: unknown = entry?.[1];
  if (!isObject(options)) throw new Error(`no options for reporter ${name}`);
  return options;
}

test.describe("reporters — one folder per run, wherever the run starts", () => {
  test("puts each report under the absolute folder it is given", () => {
    expect(optionsOf("html").outputFolder).toBe(`${REPORT_DIR}/playwright`);
    expect(optionsOf("playwright-bdd/reporter/cucumber").outputFile).toBe(
      `${REPORT_DIR}/cucumber/index.html`,
    );
    expect(optionsOf("allure-playwright").resultsDir).toBe(
      `${REPORT_DIR}/allure-results`,
    );
  });

  test("refuses a relative folder, which would send Allure's results to the working directory", () => {
    for (const relative of [
      "reports/backwpup/pro@nginx/run",
      "./reports",
      "",
    ]) {
      expect(() => reporters(withPath(relative)), relative).toThrow(
        "[reporting] The report folder must be absolute",
      );
    }
  });
});

test.describe("reporters — the cell notice", () => {
  test("comes first, before the terminal reporter, from an absolute path, with the facts it is given", () => {
    const list = reporters(RUN);
    const [first] = list;
    expect(first?.[0]).toMatch(/\/src\/common\/reporting\/cell-notice\.ts$/);
    expect(isAbsolute(first?.[0] ?? "")).toBe(true);
    expect(first?.[1]).toEqual(RUN);
    expect(
      ownIndex(
        list.map(([name]) => name),
        "terminal.reporter.ts",
      ),
    ).toBeGreaterThan(0);
  });
});

test.describe("reporters — the results stream and the summary", () => {
  test("the stream comes before the reports, the summary last, each from an absolute path with the run's facts", () => {
    const list = reporters(RUN);
    const names = list.map(([name]) => name);
    const own = (file: string): number =>
      names.findIndex((name) => name.endsWith(`/src/common/reporting/${file}`));
    const stream = own("results-stream.ts");
    const summary = own("run-summary.ts");

    // Before the terminal reporter and every report, so `run.end` is written before their slow
    // `onEnd`.
    expect(stream).toBe(1);
    expect(own("terminal.reporter.ts")).toBe(stream + 1);
    // Last, so its `onExit` prints below everything else.
    expect(summary).toBe(list.length - 1);
    for (const index of [stream, summary]) {
      expect(isAbsolute(names[index] ?? "")).toBe(true);
    }
    expect(list[stream]?.[1]).toEqual(RUN);
    // The summary also gets the output mode: `plain` drops its colour.
    expect(list[summary]?.[1]).toEqual({
      ...RUN,
      output: expect.stringMatching(/^(?:auto|plain|fancy)$/),
    });
  });
});

test.describe("reporters — the run facts", () => {
  test("come before every report, whose onEnd reads the title and metadata theirs sets, with the run's facts", () => {
    const list = reporters(RUN);
    const names = list.map(([name]) => name);
    const facts = names.findIndex((name) =>
      name.endsWith("/src/common/reporting/run-facts.reporter.ts"),
    );
    expect(facts).toBeGreaterThan(ownIndex(names, "terminal.reporter.ts"));
    for (const report of [
      "html",
      "playwright-bdd/reporter/cucumber",
      "allure-playwright",
    ]) {
      expect(facts, report).toBeLessThan(names.indexOf(report));
    }
    expect(isAbsolute(names[facts] ?? "")).toBe(true);
    expect(list[facts]?.[1]).toEqual(RUN);
  });

  test("write where the reports are: Allure's results and the Cucumber file the facts reporter names", () => {
    expect(optionsOf("allure-playwright").resultsDir).toBe(
      join(REPORT_DIR, ALLURE_RESULTS_DIR),
    );
    expect(optionsOf("playwright-bdd/reporter/cucumber").outputFile).toBe(
      join(REPORT_DIR, CUCUMBER_REPORT_FILE),
    );
  });
});

test.describe("reporters — the terminal reporter", () => {
  /** Runs `body` with `E2E_OUTPUT` set to `value` (unset for `undefined`), then restores it. */
  function withOutput<T>(value: string | undefined, body: () => T): T {
    const saved = process.env[OUTPUT_ENV];
    if (value === undefined) Reflect.deleteProperty(process.env, OUTPUT_ENV);
    else process.env[OUTPUT_ENV] = value;
    try {
      return body();
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, OUTPUT_ENV);
      else process.env[OUTPUT_ENV] = saved;
    }
  }

  test("takes list's place — no list left — from an absolute path, with the run's facts and E2E_OUTPUT", () => {
    const list = withOutput("plain", () => reporters(RUN));
    const names = list.map(([name]) => name);
    expect(names).not.toContain("list");
    const terminal = ownIndex(names, "terminal.reporter.ts");
    expect(names[terminal - 1]).toMatch(/\/results-stream\.ts$/);
    expect(names[terminal + 1]).toMatch(/\/run-facts\.reporter\.ts$/);
    expect(isAbsolute(names[terminal] ?? "")).toBe(true);
    expect(list[terminal]?.[1]).toEqual({ ...RUN, output: "plain" });
    // The summary is told too, so plain is plain to the run's last line.
    expect(list[ownIndex(names, "run-summary.ts")]?.[1]).toEqual({
      ...RUN,
      output: "plain",
    });
    // Unset, it is auto.
    expect(
      withOutput(undefined, () => reporters(RUN))[terminal]?.[1],
    ).toMatchObject({ output: "auto" });
  });

  test("a bad E2E_OUTPUT fails the config as it is built, naming the variable", () => {
    expect(() => withOutput("pretty", () => reporters(RUN))).toThrow(
      'Environment variable "E2E_OUTPUT" must be one of auto/plain/fancy, got "pretty".',
    );
  });
});
