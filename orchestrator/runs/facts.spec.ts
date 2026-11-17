import { test, expect } from "@playwright/test";

import { RUN_FACTS_FILE as SUITE_FILE } from "../../src/common/reporting/run-facts";
import { readRunFacts, RUN_FACTS_FILE } from "./facts";

/** `run-facts.json` as the suite wrote it on `pro@nginx` (trimmed of what is not read). */
const FACTS = {
  v: 1,
  title: "backwpup · pro@nginx (pro) · …",
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  runId: "2026-10-13T10-15-31-042Z-bpng-12",
  requestedRef: "develop",
  status: "passed",
  setupFailures: [],
  cells: [
    {
      cell: "pro@nginx",
      setups: { artifacts: "passed", auth: "passed" },
      plugins: [
        {
          role: "plugin",
          ok: true,
          name: "BackWPup Pro",
          version: "9.99.99",
          ref: "develop",
          commit: "1dceea896639a7665a04edb7f90cf7dbc60b4ba6",
          sha256: "bb".repeat(32),
        },
      ],
      sites: [
        {
          baseURL: "https://bwu3.example.test",
          versions: {
            wordpress: "7.1.3",
            php: "8.5.11 64bit",
            webServer: "nginx",
          },
        },
        {
          baseURL: "https://bwu4.example.test",
          error: "Site Health timed out",
        },
      ],
    },
  ],
};

/** The facts as text, with `change` applied. */
function text(
  change: (facts: typeof FACTS) => unknown = (facts) => facts,
): string {
  return JSON.stringify(change(structuredClone(FACTS)));
}

test.describe("readRunFacts", () => {
  test("reads the edition, the plugin under test, each site in pool order and the requested ref", () => {
    expect(readRunFacts(text(), "pro@nginx")).toEqual({
      edition: "pro",
      plugin: {
        name: "BackWPup Pro",
        version: "9.99.99",
        ref: "develop",
        commit: "1dceea896639a7665a04edb7f90cf7dbc60b4ba6",
      },
      sites: [
        {
          baseURL: "https://bwu3.example.test",
          wordpress: "7.1.3",
          php: "8.5.11 64bit",
        },
        { baseURL: "https://bwu4.example.test" },
      ],
      setupFailures: [],
    });
  });

  test("reads the failed setups' first lines", () => {
    const failures = [
      {
        project: "artifacts:pro@nginx",
        setup: "artifacts",
        message: "build failed",
      },
    ];
    expect(
      readRunFacts(
        text((facts) => ({ ...facts, setupFailures: failures })),
        "pro@nginx",
      )?.setupFailures,
    ).toEqual([{ setup: "artifacts", message: "build failed" }]);
  });

  test("knows no plugin when the artifacts setup failed to resolve it, or resolved only another role", () => {
    const [cell] = FACTS.cells;
    const withPlugins = (plugins: unknown) =>
      text((facts) => ({ ...facts, cells: [{ ...cell, plugins }] }));
    const failed = withPlugins([{ role: "plugin", ok: false, error: "x" }]);
    expect(readRunFacts(failed, "pro@nginx")?.plugin).toBeUndefined();
    const previous = withPlugins(
      cell?.plugins.map((plugin) => ({ ...plugin, role: "previous" })),
    );
    expect(readRunFacts(previous, "pro@nginx")?.plugin).toBeUndefined();
  });

  test("reads another cell's facts as none for this one", () => {
    expect(readRunFacts(text(), "free@nginx")).toEqual({
      edition: "pro",
      sites: [],
      setupFailures: [],
    });
  });

  test("drops a malformed item and reads a field of another type as unknown, never failing", () => {
    const odd = text((facts) => ({
      ...facts,
      edition: 42,
      setupFailures: "none",
      cells: [
        "junk",
        {
          ...facts.cells[0],
          plugins: [{ role: "plugin", ok: true, version: 9 }],
          sites: [{ baseURL: 1 }, { baseURL: "https://a.test", versions: "x" }],
        },
      ],
    }));
    expect(readRunFacts(odd, "pro@nginx")).toEqual({
      plugin: {},
      sites: [{ baseURL: "https://a.test" }],
      setupFailures: [],
    });
  });

  test("reads the suite's version the run recorded", () => {
    for (const version of ["1.1.0", "2.0.0-rc.1+b5"]) {
      const read = readRunFacts(
        text((facts) => ({ ...facts, suiteVersion: version })),
        "pro@nginx",
      );
      expect(read?.suiteVersion, version).toBe(version);
      // The rest of the facts are read as without it.
      expect({ ...read, suiteVersion: undefined }).toEqual(
        readRunFacts(text(), "pro@nginx"),
      );
    }
  });

  test("knows no suite version when the run recorded none, keeping the key absent", () => {
    const read = readRunFacts(text(), "pro@nginx");
    expect(read).toBeDefined();
    expect(read).not.toHaveProperty("suiteVersion");
  });

  test("reads a suite version of another type or not valid SemVer as unknown, never refusing the facts", () => {
    for (const version of [
      110,
      null,
      ["1.1.0"],
      { v: "1.1.0" },
      "",
      "v1.1.0",
      "1.1",
      "1.1.0\n",
      "1.1.0\u001b[31m",
      `1.1.0-${"a".repeat(59)}`,
      "<!channel>",
    ]) {
      const read = readRunFacts(
        text((facts) => ({ ...facts, suiteVersion: version })),
        "pro@nginx",
      );
      expect(read, JSON.stringify(version)).toEqual(
        readRunFacts(text(), "pro@nginx"),
      );
      expect(read, JSON.stringify(version)).not.toHaveProperty("suiteVersion");
    }
  });

  test("reads text that is not facts of version 1 as no facts", () => {
    for (const bad of [
      "",
      "{",
      "null",
      "[]",
      text((facts) => ({ ...facts, v: 2 })),
    ])
      expect(readRunFacts(bad, "pro@nginx"), bad).toBeUndefined();
  });

  test("names the file as the suite does", () => {
    expect(RUN_FACTS_FILE).toBe(SUITE_FILE);
  });
});
