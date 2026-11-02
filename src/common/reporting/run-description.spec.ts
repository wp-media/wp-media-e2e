import { test, expect } from "@playwright/test";

import {
  readRunDescription,
  reporterMode,
  type RunDescription,
} from "./run-description";

/**
 * The facts every own reporter receives, and the mode Playwright runs reporters in: a malformed
 * description is named, never thrown — a throwing reporter would fail the run.
 */

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "run-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/run-1",
  reportPath: "/repo/reports/backwpup/pro@nginx/run-1",
};

test.describe("readRunDescription", () => {
  test("takes a complete description, with the options Playwright adds", () => {
    const options = { ...RUN, configDir: "/repo", _mode: "test" };
    expect(readRunDescription(options)).toBe(options);
    const { cell: _cell, edition: _edition, ...everyCell } = RUN;
    expect(readRunDescription(everyCell)).toEqual(everyCell);
    const named = { ...RUN, runName: "nightly", requestedRef: "develop" };
    expect(readRunDescription(named)).toEqual(named);
    const plugin = {
      ...RUN,
      pluginRef: "develop",
      pluginZip: "/z.zip",
      pluginVersion: "9.99.99",
    };
    expect(readRunDescription(plugin)).toEqual(plugin);
    for (const reportsKeep of [0, 20]) {
      expect(readRunDescription({ ...RUN, reportsKeep })).toEqual({
        ...RUN,
        reportsKeep,
      });
    }
  });

  test("names the first field missing or of the wrong type", () => {
    const cases: [unknown, string][] = [
      [undefined, "product"],
      [{}, "product"],
      [{ ...RUN, reportPath: undefined }, "reportPath"],
      [{ ...RUN, runId: 42 }, "runId"],
      [{ ...RUN, cell: 1 }, "cell"],
      [{ ...RUN, edition: null }, "edition"],
      [{ ...RUN, runName: 7 }, "runName"],
      [{ ...RUN, requestedRef: ["develop"] }, "requestedRef"],
      [{ ...RUN, pluginRef: 1 }, "pluginRef"],
      [{ ...RUN, pluginZip: false }, "pluginZip"],
      [{ ...RUN, pluginVersion: { v: 1 } }, "pluginVersion"],
      [{ ...RUN, pinned: "yes" }, "pinned"],
      [{ ...RUN, reportsKeep: -1 }, "reportsKeep"],
      [{ ...RUN, reportsKeep: 1.5 }, "reportsKeep"],
      [{ ...RUN, reportsKeep: "20" }, "reportsKeep"],
      [{ ...RUN, reportsKeep: null }, "reportsKeep"],
    ];
    for (const [options, field] of cases) {
      expect(readRunDescription(options), JSON.stringify(options)).toEqual({
        missing: field,
      });
    }
  });
});

test.describe("reporterMode", () => {
  test("list only for Playwright's list mode; test otherwise", () => {
    expect(reporterMode({ _mode: "list" })).toBe("list");
    for (const options of [
      { _mode: "test" },
      { _mode: "merge" },
      {},
      undefined,
      null,
      "x",
    ]) {
      expect(reporterMode(options), JSON.stringify(options)).toBe("test");
    }
  });
});
