import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runBegin,
  runEnd,
  scenarioEnd,
  setupEnd,
  streamOf,
} from "../__fixtures__/results";
import { RESULTS_FILE } from "../../src/common/reporting/results-schema";
import {
  endRun,
  MAX_RESULTS_BYTES,
  readLogTail,
  type RunEndInput,
} from "./end";
import { RUN_FACTS_FILE } from "./facts";
import { LOG_PREFIX } from "./launch";

/** A fresh folder per test, removed after it. */
let root: string;
test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-end-"));
});
test.afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A secret value the orchestrator holds, which no field of the end may show. */
const SECRET = "bwp-storage-password-0123456789";

/** The run's facts, as the suite writes them (trimmed of what is not read). */
function factsText(failure?: string): string {
  return JSON.stringify({
    v: 1,
    edition: "pro",
    setupFailures:
      failure === undefined ? [] : [{ setup: "auth", message: failure }],
    cells: [
      {
        cell: "pro@nginx",
        plugins: [
          {
            role: "plugin",
            ok: true,
            name: "BackWPup Pro",
            version: "9.99.99",
            ref: "develop",
            commit: "1dceea896639a7665a04edb7f90cf7dbc60b4ba6",
          },
        ],
        sites: [
          {
            baseURL: "https://bwu3.example.test",
            versions: { wordpress: "7.1.3", php: "8.5.11" },
          },
        ],
      },
    ],
  });
}

/**
 * A run's end, its files written into the test's folder.
 *
 * @param files - the stream's text, the facts' text and the log's, each only when given.
 * @param change - anything else to set.
 */
async function input(
  files: { results?: string; facts?: string; log?: string },
  change: Partial<RunEndInput> = {},
): Promise<RunEndInput> {
  const reportDir = join(root, "reports", "backwpup", "pro@nginx", "RUN");
  await mkdir(reportDir, { recursive: true });
  const log = join(root, "run.log");
  if (files.results !== undefined)
    await writeFile(join(reportDir, RESULTS_FILE), files.results);
  if (files.facts !== undefined)
    await writeFile(join(reportDir, RUN_FACTS_FILE), files.facts);
  if (files.log !== undefined) await writeFile(log, files.log);
  return {
    identity: {
      id: "bpng-12",
      runId: "2026-10-13T10-15-31-042Z-bpng-12",
      startedAt: new Date("2026-10-13T10:15:31.042Z"),
      log,
      reportDir,
    },
    task: {
      id: "bpng",
      product: "backwpup",
      cell: "pro@nginx",
      ref: "develop",
    },
    launch: {
      bddgen: { code: 0, signal: null },
      playwright: { code: 0, signal: null },
      stop: { level: "none" },
    },
    secrets: [SECRET],
    endedAt: new Date("2026-10-13T11:09:41.042Z"),
    ...change,
  };
}

const PASSED = streamOf([
  runBegin(1),
  setupEnd("auth", "passed"),
  setupEnd("artifacts", "passed"),
  scenarioEnd("a", "passed"),
  runEnd("passed", { total: 1, passed: 1 }),
]);

test.describe("endRun", () => {
  test("judges a run by its stream and builds its run.finished from the stream and the facts", async () => {
    const end = await endRun(
      await input({ results: PASSED, facts: factsText() }),
    );
    expect(end.outcome).toEqual({ status: "passed" });
    expect(end.event).toMatchObject({
      type: "run.finished",
      run: { id: "bpng-12", runId: "2026-10-13T10-15-31-042Z-bpng-12" },
      unit: { product: "backwpup", cell: "pro@nginx", edition: "pro" },
      plugin: {
        requestedRef: "develop",
        version: "9.99.99",
        name: "BackWPup Pro",
      },
      sites: [
        {
          baseURL: "https://bwu3.example.test",
          wordpress: "7.1.3",
          php: "8.5.11",
        },
      ],
      status: "passed",
      reason: null,
      durationMs: 54 * 60_000 + 10_000,
      counts: { total: 1, passed: 1 },
    });
    expect(end.event.scenarios).toHaveLength(1);
  });

  test("names the suite's version from the run's facts, else the orchestrator's, else null", async () => {
    const withVersion = (version: string): string =>
      JSON.stringify({
        ...(JSON.parse(factsText()) as object),
        suiteVersion: version,
      });
    const suiteOf = async (
      facts: string | undefined,
      suiteVersion?: string,
    ): Promise<unknown> =>
      (
        await endRun(
          await input(
            { results: PASSED, ...(facts === undefined ? {} : { facts }) },
            suiteVersion === undefined ? {} : { suiteVersion },
          ),
        )
      ).event.suite;
    expect(await suiteOf(withVersion("1.2.0"), "1.1.0")).toEqual({
      version: "1.2.0",
    });
    await rm(join(root, "reports"), { recursive: true, force: true });
    expect(await suiteOf(factsText(), "1.1.0")).toEqual({ version: "1.1.0" });
    await rm(join(root, "reports"), { recursive: true, force: true });
    expect(await suiteOf(undefined, "1.1.0")).toEqual({ version: "1.1.0" });
    expect(await suiteOf(undefined)).toEqual({ version: null });
  });

  test("takes a failed setup's reason from the facts, masked", async () => {
    const results = streamOf([
      runBegin(1),
      setupEnd("auth", "failed", "boom"),
      runEnd(
        "failed",
        { total: 1, didNotRun: 1 },
        { total: 2, failed: 1, passed: 1 },
      ),
    ]);
    const end = await endRun(
      await input(
        { results, facts: factsText(`login refused for ${SECRET}`) },
        {
          launch: {
            bddgen: { code: 0, signal: null },
            playwright: { code: 1, signal: null },
            stop: { level: "none" },
          },
        },
      ),
    );
    expect(end.outcome.status).toBe("error");
    expect(end.outcome.reason).toMatch(
      /^the auth setup failed: login refused for /,
    );
    expect(JSON.stringify(end)).not.toContain(SECRET);
  });

  test("explains a run with no stream from the log's last lines, never ours", async () => {
    const log = [
      `${LOG_PREFIX} 2026-10-13T10:15:31.042Z bddgen starts: node …`,
      "Error: Missing step definition for a step",
      `${LOG_PREFIX} 2026-10-13T10:15:33.000Z bddgen exited with code 1`,
      "",
    ].join("\n");
    const end = await endRun(
      await input(
        { log },
        {
          launch: {
            bddgen: { code: 1, signal: null },
            stop: { level: "none" },
          },
        },
      ),
    );
    expect(end.outcome).toEqual({
      status: "error",
      reason:
        "bddgen exited with code 1: Error: Missing step definition for a step",
    });
  });

  test("reads a stream over the cap as unread, and says so", async () => {
    const end = await endRun(await input({ results: PASSED }));
    const big = await input({});
    await writeFile(
      join(big.identity.reportDir, RESULTS_FILE),
      Buffer.alloc(MAX_RESULTS_BYTES + 1, "x"),
    );
    const over = await endRun(big);
    expect(end.outcome.status).toBe("passed");
    expect(over.outcome.status).toBe("error");
    expect(over.outcome.reason).toContain(
      `its results could not be read: it is ${String(MAX_RESULTS_BYTES + 1)} bytes`,
    );
    expect(over.event.scenarios).toEqual([]);
  });

  test("judges a stopped run as stopped, whatever its files say", async () => {
    const end = await endRun(
      await input(
        { results: PASSED, facts: factsText() },
        {
          launch: {
            bddgen: { code: 0, signal: null },
            playwright: { code: null, signal: "SIGKILL" },
            stop: {
              level: "killed",
              why: "the orchestrator was stopped (SIGINT)",
            },
          },
        },
      ),
    );
    expect(end.outcome).toEqual({
      status: "killed",
      reason: "the orchestrator was stopped (SIGINT)",
    });
    expect(end.event.status).toBe("killed");
  });
});

test.describe("readLogTail", () => {
  test("reads nothing from a FIFO in the log's place, without waiting for a writer", async () => {
    const fifo = join(root, "run.log");
    execFileSync("mkfifo", [fifo]);
    expect(await readLogTail(fifo)).toEqual([]);
  });

  test("keeps the last lines, drops ours, blank ones and a line cut by the read's start", async () => {
    const file = join(root, "run.log");
    await writeFile(
      file,
      [
        "first line",
        `${LOG_PREFIX} ours`,
        "",
        "second",
        "third\r",
        "fourth",
      ].join("\n"),
    );
    expect(await readLogTail(file)).toEqual([
      "first line",
      "second",
      "third",
      "fourth",
    ]);
    expect(await readLogTail(file, 1_000, 2)).toEqual(["third", "fourth"]);
    // 12 bytes from the end start inside "third": that cut line is dropped.
    expect(await readLogTail(file, 12)).toEqual(["fourth"]);
  });

  test("keeps a whole line the window starts on, and drops a character the window cuts", async () => {
    const file = join(root, "run.log");
    await writeFile(file, "older\nError: whole\nlast\n");
    // The window starts exactly on "Error: whole": that line is whole, and kept.
    expect(await readLogTail(file, "Error: whole\nlast\n".length)).toEqual([
      "Error: whole",
      "last",
    ]);
    // A window starting inside "é" (2 bytes) drops that cut line.
    await writeFile(file, "é\nend\n");
    expect(await readLogTail(file, 5)).toEqual(["end"]);
    await writeFile(file, "a\r\nb\r\n");
    expect(await readLogTail(file, 3)).toEqual(["b"]);
  });

  test("never quotes our line, even run into a process's output", async () => {
    const file = join(root, "run.log");
    await writeFile(
      file,
      `Error: cause\npartial${LOG_PREFIX} 2026-10-13T22:01:40.093Z bddgen exited with code 3\n`,
    );
    expect(await readLogTail(file)).toEqual(["Error: cause", "partial"]);
  });

  test("reads a missing log as no lines", async () => {
    expect(await readLogTail(join(root, "none"))).toEqual([]);
  });
});
