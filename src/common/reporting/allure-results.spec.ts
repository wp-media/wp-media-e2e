import { test, expect } from "@playwright/test";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { FIXTURE, writeAllureResults } from "../__fixtures__/allure";
import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  AllureResultsMissingError,
  MalformedAllureResultError,
} from "./allure-errors";
import {
  PLAYWRIGHT_TRACE_TYPE,
  copyAllureResults,
  stripTraces,
} from "./allure-results";

/**
 * Copying a run's raw Allure results for generation: what stripping removes (and keeps), what the
 * copy refuses, and that the original folder is never touched.
 */

let root = "";

test.beforeEach(() => {
  root = tempRoot("e2e-allure-results-");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** Every file in a flat folder, by name, with its bytes: a snapshot to compare before and after. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((name) => [name, readFileSync(join(dir, name)).toString("base64")]),
  );
}

/** A file in a folder, parsed. */
function readJson(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
    string,
    unknown
  >;
}

const trace = (source: string) => ({
  name: "trace",
  source,
  type: PLAYWRIGHT_TRACE_TYPE,
});

test.describe("stripTraces", () => {
  test("removes a top-level trace and keeps every other attachment", () => {
    const result = {
      name: "t",
      attachments: [
        trace("t.zip"),
        { name: "log", source: "l.txt", type: "text/plain" },
      ],
    };
    const stripped = stripTraces(result);
    expect(stripped.result).toEqual({
      name: "t",
      attachments: [{ name: "log", source: "l.txt", type: "text/plain" }],
    });
    expect(stripped.removedTraces).toBe(1);
    expect(stripped.removedSources).toEqual(["t.zip"]);
    expect(stripped.keptSources).toEqual(["l.txt"]);
  });

  test("drops a step that only wrapped traces, and keeps a step that holds more", () => {
    const result = {
      steps: [
        { name: "trace", steps: [], attachments: [trace("w.zip")] },
        {
          name: "When",
          steps: [{ name: "inner", steps: [], attachments: [] }],
          attachments: [trace("n.zip")],
        },
        {
          name: "mixed",
          steps: [],
          attachments: [trace("m.zip"), { source: "s.png", type: "image/png" }],
        },
        { name: "empty", steps: [], attachments: [] },
      ],
    };
    const stripped = stripTraces(result);
    expect(stripped.result.steps).toEqual([
      {
        name: "When",
        steps: [{ name: "inner", steps: [], attachments: [] }],
        attachments: [],
      },
      {
        name: "mixed",
        steps: [],
        attachments: [{ source: "s.png", type: "image/png" }],
      },
      // Never a wrapper: it had no trace to begin with.
      { name: "empty", steps: [], attachments: [] },
    ]);
    expect([...stripped.removedSources].sort()).toEqual([
      "m.zip",
      "n.zip",
      "w.zip",
    ]);
    expect(stripped.keptSources).toEqual(["s.png"]);
  });

  test("drops allure-playwright's own wrapper shape: no status, empty details and parameters", () => {
    // As allure-playwright 3 writes it: started with a name, stopped with no status.
    const wrapper = {
      name: "trace",
      parameters: [],
      statusDetails: {},
      stage: "finished",
      steps: [],
      attachments: [trace("w.zip")],
      start: 1,
      stop: 2,
    };
    expect(stripTraces({ steps: [wrapper] }).result.steps).toEqual([]);
  });

  test("keeps, minus its trace, a step that is more than a wrapper", () => {
    const wrapper = {
      name: "trace",
      status: "passed",
      steps: [],
      attachments: [trace("w.zip")],
    };
    const steps = [
      {
        ...wrapper,
        name: "Then the backup holds the trace",
        status: "failed",
        statusDetails: { message: "expected 3 files, got 2" },
      },
      { ...wrapper, status: "broken" },
      { ...wrapper, statusDetails: { message: "why" } },
      { ...wrapper, parameters: [{ name: "file", value: "x" }] },
      { ...wrapper, name: "a step of its own" },
      { ...wrapper, attachments: [trace("one.zip"), trace("two.zip")] },
      { ...wrapper, description: "said something" },
      { ...wrapper, steps: [{ name: "inner", steps: [], attachments: [] }] },
    ];

    const stripped = stripTraces({ steps });

    expect(stripped.result.steps).toEqual(
      steps.map((step) => ({ ...step, attachments: [] })),
    );
    expect(stripped.removedTraces).toBe(9);
  });

  test("strips a container's fixtures, before and after", () => {
    const container = {
      befores: [{ name: "b", steps: [], attachments: [trace("b.zip")] }],
      afters: [{ name: "a", steps: [], attachments: [trace("a.zip")] }],
    };
    const stripped = stripTraces(container);
    expect(stripped.result).toEqual({
      befores: [{ name: "b", steps: [], attachments: [] }],
      afters: [{ name: "a", steps: [], attachments: [] }],
    });
    expect([...stripped.removedSources].sort()).toEqual(["a.zip", "b.zip"]);
  });

  test("never mutates its input, and returns it as it is when there is no trace", () => {
    const withTrace = {
      steps: [{ name: "trace", steps: [], attachments: [trace("w.zip")] }],
    };
    const before = JSON.stringify(withTrace);
    stripTraces(withTrace);
    expect(JSON.stringify(withTrace)).toBe(before);

    const without = {
      steps: [{ name: "s", steps: [], attachments: [] }],
      attachments: [{ source: "x.txt", type: "text/plain" }],
    };
    expect(stripTraces(without).result).toBe(without);
  });

  test("keeps entries it does not recognise as they are", () => {
    const odd = {
      attachments: ["not an object", { type: PLAYWRIGHT_TRACE_TYPE }],
      steps: [42, null],
      befores: "nope",
    };
    const stripped = stripTraces(odd);
    // The source-less trace still goes; nothing is counted as a file to leave out.
    expect(stripped.result).toEqual({
      attachments: ["not an object"],
      steps: [42, null],
      befores: "nope",
    });
    expect(stripped.removedTraces).toBe(1);
    expect(stripped.removedSources).toEqual([]);
  });
});

test.describe("copyAllureResults", () => {
  test("strip: leaves out every trace and its zip, keeps the rest, never touches the original", async () => {
    const source = writeAllureResults(join(root, "allure-results"));
    const before = snapshot(source);
    const target = join(root, "copy");

    const copied = await copyAllureResults(source, target, "strip");

    expect(copied).toEqual({ results: 2, strippedTraces: 3, skipped: [] });
    expect(snapshot(source)).toEqual(before);
    expect(readdirSync(target).sort()).toEqual(
      [
        FIXTURE.passed,
        FIXTURE.failed,
        FIXTURE.container,
        FIXTURE.stdout,
        FIXTURE.screenshot,
        FIXTURE.environment,
      ].sort(),
    );
    const failed = readJson(target, FIXTURE.failed);
    expect(JSON.stringify(failed)).not.toContain(PLAYWRIGHT_TRACE_TYPE);
    expect(
      (failed.steps as { name: string }[]).map((step) => step.name),
    ).toEqual(["When it breaks", "screenshot"]);
    expect(JSON.stringify(readJson(target, FIXTURE.container))).not.toContain(
      PLAYWRIGHT_TRACE_TYPE,
    );
    // A result without a trace is copied byte for byte.
    expect(readFileSync(join(target, FIXTURE.passed))).toEqual(
      readFileSync(join(source, FIXTURE.passed)),
    );
  });

  test("keep: copies every file byte for byte", async () => {
    const source = writeAllureResults(join(root, "allure-results"));
    const target = join(root, "copy");

    const copied = await copyAllureResults(source, target, "keep");

    expect(copied).toEqual({ results: 2, strippedTraces: 0, skipped: [] });
    expect(snapshot(target)).toEqual(snapshot(source));
  });

  test("strip: a zip another, non-trace entry also references is still copied", async () => {
    const source = join(root, "allure-results");
    mkdirSync(source);
    writeFileSync(
      join(source, "x-result.json"),
      JSON.stringify({
        attachments: [
          trace("shared.zip"),
          { name: "zip", source: "shared.zip", type: "application/zip" },
        ],
      }),
    );
    writeFileSync(join(source, "shared.zip"), "zip");
    const target = join(root, "copy");

    await copyAllureResults(source, target, "strip");

    expect(readdirSync(target).sort()).toEqual(["shared.zip", "x-result.json"]);
  });

  test("never follows a link, nor enters a folder: both are left out and named", async () => {
    const source = writeAllureResults(join(root, "allure-results"));
    const outside = join(root, "secret.txt");
    writeFileSync(outside, "outside the results");
    symlinkSync(outside, join(source, "link-attachment.txt"));
    symlinkSync(outside, join(source, "link-result.json"));
    mkdirSync(join(source, "nested"));
    const target = join(root, "copy");

    const copied = await copyAllureResults(source, target, "keep");

    expect(copied.skipped).toEqual([
      "link-attachment.txt",
      "link-result.json",
      "nested",
    ]);
    expect(copied.results).toBe(2);
    expect(readdirSync(target)).not.toContain("link-attachment.txt");
    expect(readdirSync(target)).not.toContain("link-result.json");
  });

  test("accepts a results folder that is itself a link", async () => {
    const real = writeAllureResults(join(root, "real-results"));
    const link = join(root, "allure-results");
    symlinkSync(real, link);

    const copied = await copyAllureResults(link, join(root, "copy"), "strip");

    expect(copied.results).toBe(2);
  });

  test("refuses a missing folder, a file, an empty folder and one with no test result", async () => {
    const problem = async (dir: string) => {
      const error = await copyAllureResults(
        dir,
        join(root, "copy"),
        "strip",
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AllureResultsMissingError);
      return (error as AllureResultsMissingError).problem;
    };
    expect(await problem(join(root, "absent"))).toBe("missing");

    writeFileSync(join(root, "file"), "");
    expect(await problem(join(root, "file"))).toBe("not-a-folder");

    mkdirSync(join(root, "empty"));
    expect(await problem(join(root, "empty"))).toBe("empty");

    // What a run that ran nothing leaves: the run facts' properties, and maybe a container.
    const listOnly = join(root, "list-only");
    mkdirSync(listOnly);
    writeFileSync(join(listOnly, FIXTURE.environment), "a = b\n");
    writeFileSync(join(listOnly, "c-container.json"), "{}");
    expect(await problem(listOnly)).toBe("empty");

    // Nothing was created for any of them.
    expect(readdirSync(root)).not.toContain("copy");
  });

  for (const [what, content, reason] of [
    ["not JSON", '{"uuid": broken', /JSON/],
    ["an array", "[1, 2]", /a JSON array, not an object/],
    ["null", "null", /a JSON null, not an object/],
    ["a string", '"text"', /a JSON string, not an object/],
  ] as const) {
    test(`refuses a result that is ${what}, naming the file, and copies nothing`, async () => {
      const source = writeAllureResults(join(root, "allure-results"));
      const bad = join(source, "zzzz-result.json");
      writeFileSync(bad, content);

      const error = await copyAllureResults(
        source,
        join(root, "copy"),
        "keep",
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MalformedAllureResultError);
      expect((error as MalformedAllureResultError).file).toBe(bad);
      expect((error as Error).message).toMatch(reason);
      expect(readdirSync(root)).not.toContain("copy");
    });
  }

  test("refuses a malformed container too", async () => {
    const source = writeAllureResults(join(root, "allure-results"));
    writeFileSync(join(source, FIXTURE.container), "{");

    await expect(
      copyAllureResults(source, join(root, "copy"), "strip"),
    ).rejects.toBeInstanceOf(MalformedAllureResultError);
  });

  test("refuses a target that already exists, leaving it as it was", async () => {
    const source = writeAllureResults(join(root, "allure-results"));
    const target = join(root, "copy");
    mkdirSync(target);
    writeFileSync(join(target, "mine"), "keep me");

    await expect(copyAllureResults(source, target, "strip")).rejects.toThrow(
      /EEXIST/,
    );
    expect(readdirSync(target)).toEqual(["mine"]);
  });
});
