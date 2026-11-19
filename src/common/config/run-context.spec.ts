import { test, expect } from "@playwright/test";
import { isAbsolute } from "node:path";

import unitConfig from "../../../playwright.unit.config";
import { runInChildNode } from "../__fixtures__/child-node";
import { CELL_PIN_ENV } from "./cell-pin";
import {
  cellOwningOutput,
  dirs,
  isCellTargeted,
  NO_CELL,
  outputDirFor,
  projectSelection,
  REPO_ROOT,
  seedSelectedCells,
  selectedCells,
} from "./run-context";

/**
 * `selectedCells()` is the single source of truth for cell selection: it parses the
 * `--project` forms from `process.argv` (exactly what Playwright itself filters on) and, in a
 * forked worker — which receives the parent's environment but NOT its argv — falls back to the
 * selection `seedSelectedCells()` published — unless `E2E_CELL` pins the run, which wins. These
 * tests drive every channel by swapping `process.argv` and the variables, restoring them afterwards.
 * Importing run-context loads `.env`, so the pin is cleared before each test: a developer's own pin
 * must not decide these results.
 */

const ORIGINAL_ARGV = process.argv;

/** The internal env channel `seedSelectedCells` writes; mirrored here so the test can drive it. */
const SELECTED_CELLS_ENV = "E2E_INTERNAL_SELECTED_CELLS";
const ORIGINAL_SEED = process.env[SELECTED_CELLS_ENV];
const ORIGINAL_PIN = process.env[CELL_PIN_ENV];

/** Run `body` with `process.argv` set to a synthetic CLI, always restoring it after. */
function withArgv(tail: string[], body: () => void): void {
  process.argv = ["node", "playwright", ...tail];
  try {
    body();
  } finally {
    process.argv = ORIGINAL_ARGV;
  }
}

/** Sets `name` to `value`, or deletes it when `value` is `undefined`. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

/**
 * Seeds `cells` as if this process's **parent** had built the config with them on its command line —
 * which makes this process one of that run's workers.
 */
function seedAsParent(cells: string[]): void {
  process.env[SELECTED_CELLS_ENV] = JSON.stringify({
    pid: process.ppid,
    cells,
  });
}

/** The seed currently in the environment, parsed. */
function currentSeed(): unknown {
  return JSON.parse(process.env[SELECTED_CELLS_ENV] ?? "null");
}

// Cleared, not restored: a seed inherited by the test process (or loaded from a `.env`) must not
// decide these results.
test.beforeEach(() => {
  setEnv(SELECTED_CELLS_ENV, undefined);
  setEnv(CELL_PIN_ENV, undefined);
});

test.afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  setEnv(SELECTED_CELLS_ENV, ORIGINAL_SEED);
  setEnv(CELL_PIN_ENV, ORIGINAL_PIN);
});

test.describe("selectedCells (parses --project)", () => {
  test("parses the equals form --project=<cell>", () => {
    withArgv(["--project=nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("parses the space form --project <cell>", () => {
    withArgv(["--project", "nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("parses the variadic form --project a b", () => {
    withArgv(["--project", "apache", "nginx"], () => {
      expect(selectedCells()).toEqual(["apache", "nginx"]);
    });
  });

  test("stops the variadic scan at the next flag, long or short", () => {
    withArgv(["--project", "nginx", "--workers", "3"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
    withArgv(["--project", "nginx", "-g", "smoke"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  // Playwright reads everything after `--` as a test-file filter, never as an option.
  test("ignores a --project after --", () => {
    withArgv(["--project=nginx", "--", "--project=apache"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
    withArgv(["--", "--project", "apache"], () => {
      expect(selectedCells()).toEqual([]);
    });
  });

  test("de-duplicates repeated selections of the same cell", () => {
    withArgv(["--project=nginx", "--project", "nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("returns empty when no --project is given (serial fallback)", () => {
    withArgv([], () => {
      expect(selectedCells()).toEqual([]);
    });
  });
});

test.describe("selection propagation to worker processes", () => {
  test("seedSelectedCells publishes the argv selection under this process's own pid", () => {
    withArgv(["--project=pro@nginx"], () => {
      seedSelectedCells();
    });
    expect(currentSeed()).toEqual({ pid: process.pid, cells: ["pro@nginx"] });
  });

  test("a worker — no argv — reads back the selection its parent seeded", () => {
    seedAsParent(["pro@nginx"]);
    withArgv([], () => {
      expect(selectedCells()).toEqual(["pro@nginx"]);
    });
  });

  test("a worker re-building the config leaves its parent's seed alone", () => {
    seedAsParent(["apache", "nginx"]);
    withArgv([], () => {
      seedSelectedCells();
      expect(selectedCells()).toEqual(["apache", "nginx"]);
    });
    expect(currentSeed()).toEqual({
      pid: process.ppid,
      cells: ["apache", "nginx"],
    });
  });

  // A run started from inside another inherits that run's seed; it must not read it as its own.
  test("a seed written by any other process is ignored, and replaced by this run's own", () => {
    process.env[SELECTED_CELLS_ENV] = JSON.stringify({
      pid: process.ppid + 1,
      cells: ["stale"],
    });
    withArgv([], () => {
      expect(selectedCells()).toEqual([]);
      seedSelectedCells();
    });
    expect(currentSeed()).toEqual({ pid: process.pid, cells: [] });
  });

  test("argv wins over a parent's seed", () => {
    seedAsParent(["stale"]);
    withArgv(["--project=fresh"], () => {
      expect(selectedCells()).toEqual(["fresh"]);
    });
  });

  test("an unparseable or old-style seed degrades to a serial run rather than throwing", () => {
    for (const raw of ["{not json", '["nginx"]', '{"pid":"x","cells":[]}']) {
      process.env[SELECTED_CELLS_ENV] = raw;
      withArgv([], () => {
        expect(selectedCells(), raw).toEqual([]);
      });
    }
  });
});

test.describe("the cell pin (E2E_CELL) in the selection", () => {
  test("selectedCells returns the pin, whatever --project names", () => {
    process.env[CELL_PIN_ENV] = "pro@nginx";
    for (const tail of [[], ["--project=setup:pro@nginx"], ["--project=*"]]) {
      withArgv(tail, () => {
        expect(selectedCells(), JSON.stringify(tail)).toEqual(["pro@nginx"]);
      });
    }
  });

  test("a blank pin is no pin: the command line decides", () => {
    process.env[CELL_PIN_ENV] = "  ";
    withArgv(["--project=nginx"], () => {
      expect(selectedCells()).toEqual(["nginx"]);
    });
  });

  test("projectSelection still returns what was typed, pinned or not", () => {
    process.env[CELL_PIN_ENV] = "pro@nginx";
    withArgv(["--project", "setup:pro@nginx", "*"], () => {
      expect(projectSelection()).toEqual(["setup:pro@nginx", "*"]);
    });
    withArgv([], () => {
      expect(projectSelection()).toEqual([]);
    });
  });

  test("a worker, with no argv and no seed, still reads the pin it inherited", () => {
    process.env[CELL_PIN_ENV] = "pro@nginx";
    Reflect.deleteProperty(process.env, SELECTED_CELLS_ENV);
    withArgv([], () => {
      expect(selectedCells()).toEqual(["pro@nginx"]);
      expect(isCellTargeted("pro@nginx", "artifacts:pro@nginx")).toBe(true);
    });
  });
});

test.describe("isCellTargeted (gates whether per-run overrides apply)", () => {
  const CELL = "pro@nginx";
  const PROJECT = `artifacts:${CELL}`;

  test("true when the cell itself is selected — the usual invocation", () => {
    withArgv([`--project=${CELL}`], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
    });
  });

  test("true when the caller's own setup project is selected by name", () => {
    // How an operator resolves one cell's zips without running its scenarios.
    withArgv([`--project=${PROJECT}`], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
    });
  });

  test("false with no selection — a broad sweep must not inherit one cell's overrides", () => {
    withArgv([], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("false for another cell's selection", () => {
    withArgv(["--project=apache"], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("false for a wildcard: broad by design, so overrides warn instead of applying", () => {
    withArgv(["--project=*"], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(false);
    });
  });

  test("true for the pinned cell with no --project; false for another cell then", () => {
    process.env[CELL_PIN_ENV] = CELL;
    withArgv([], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
      expect(isCellTargeted("free@nginx", "artifacts:free@nginx")).toBe(false);
    });
  });

  test("reads the seeded selection, so it holds inside a worker (no argv there)", () => {
    seedAsParent([CELL]);
    withArgv([], () => {
      expect(isCellTargeted(CELL, PROJECT)).toBe(true);
    });
  });
});

test.describe("dirs — artifacts directory", () => {
  const ARTIFACTS_ROOT = "ARTIFACTS_ROOT";
  const saved = process.env[ARTIFACTS_ROOT];

  test.afterEach(() => {
    if (saved === undefined)
      Reflect.deleteProperty(process.env, ARTIFACTS_ROOT);
    else process.env[ARTIFACTS_ROOT] = saved;
  });

  test("defaults to .artifacts, always namespaced by product/cell", () => {
    Reflect.deleteProperty(process.env, ARTIFACTS_ROOT);
    expect(dirs("wp-rocket", "nginx").artifacts).toBe(
      ".artifacts/wp-rocket/nginx",
    );
  });

  test("ARTIFACTS_ROOT overrides only the root prefix", () => {
    process.env[ARTIFACTS_ROOT] = "/tmp/artifacts";
    expect(dirs("backwpup", "pro@nginx").artifacts).toBe(
      "/tmp/artifacts/backwpup/pro@nginx",
    );
  });

  test("REPO_ROOT is absolute (so paths never depend on process.cwd())", () => {
    expect(isAbsolute(REPO_ROOT)).toBe(true);
  });
});

test.describe("outputDirFor — only a run targeting a cell may own (and so empty) its folder", () => {
  const OUTPUT_ROOT = "OUTPUT_ROOT";
  const saved = process.env[OUTPUT_ROOT];

  test.beforeEach(() => {
    Reflect.deleteProperty(process.env, OUTPUT_ROOT);
  });

  test.afterEach(() => {
    if (saved === undefined) Reflect.deleteProperty(process.env, OUTPUT_ROOT);
    else process.env[OUTPUT_ROOT] = saved;
  });

  test("the targeted cell writes in its own folder", () => {
    expect(outputDirFor("backwpup", "pro@nginx", "pro@nginx")).toBe(
      "test-results/backwpup/pro@nginx",
    );
  });

  test("a run targeting no cell writes under _all/<cell>", () => {
    expect(NO_CELL).toBe("_all");
    expect(outputDirFor("backwpup", "pro@nginx", undefined)).toBe(
      "test-results/backwpup/_all/pro@nginx",
    );
  });

  test("another cell's project in a targeted run writes under _all/<cell> too", () => {
    expect(outputDirFor("backwpup", "free@nginx", "pro@nginx")).toBe(
      "test-results/backwpup/_all/free@nginx",
    );
  });

  test("OUTPUT_ROOT replaces only the root, for both kinds of run", () => {
    process.env[OUTPUT_ROOT] = "/srv/e2e-output";
    expect(outputDirFor("wp-rocket", "nginx", "nginx")).toBe(
      "/srv/e2e-output/wp-rocket/nginx",
    );
    expect(outputDirFor("wp-rocket", "nginx", undefined)).toBe(
      "/srv/e2e-output/wp-rocket/_all/nginx",
    );
  });

  test("unit runs write in a _unit folder of their own, which no product can be named", () => {
    expect(unitConfig.outputDir).toMatch(/\/_unit$/);
  });
});

test.describe("cellOwningOutput — the cell a run targets as a whole", () => {
  test("the selected cell, when no --project was typed (only a pin selects a cell then)", () => {
    expect(cellOwningOutput("pro@nginx", [])).toBe("pro@nginx");
  });

  test("the selected cell, when --project names it exactly", () => {
    expect(cellOwningOutput("pro@nginx", ["pro@nginx"])).toBe("pro@nginx");
    expect(
      cellOwningOutput("pro@nginx", ["setup:pro@nginx", "pro@nginx"]),
    ).toBe("pro@nginx");
  });

  test("none for a setup project alone, a wildcard, or a different case", () => {
    for (const selection of [
      ["setup:pro@nginx"],
      ["artifacts:pro@nginx"],
      ["*"],
      ["PRO@nginx"],
    ]) {
      expect(
        cellOwningOutput("pro@nginx", selection),
        JSON.stringify(selection),
      ).toBeUndefined();
    }
  });

  test("none when no cell is selected", () => {
    expect(cellOwningOutput(undefined, [])).toBeUndefined();
    expect(cellOwningOutput(undefined, ["setup:a"])).toBeUndefined();
  });
});

test.describe("RUN_ID — the run's token", () => {
  /** What importing run-context does with `RUN_ID` set (or not), in a fresh process. */
  async function importWith(
    runId: string | undefined,
  ): Promise<{ runId?: string; error?: string }> {
    const result = await runInChildNode(
      `try {
         const { RUN_ID } = await import(${JSON.stringify(`${REPO_ROOT}src/common/config/run-context.ts`)});
         console.log(JSON.stringify({ runId: RUN_ID }));
       } catch (error) {
         console.log(JSON.stringify({ error: error.message }));
       }`,
      {
        cwd: REPO_ROOT,
        env: {
          E2E_LOAD_DOTENV: "false",
          ...(runId === undefined ? {} : { RUN_ID: runId }),
        },
      },
    );
    return result as { runId?: string; error?: string };
  }

  test("a fresh one is a stamp the report pruning can date", async () => {
    const { runId } = await importWith(undefined);
    expect(runId).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+$/);
  });

  test("a pinned one is kept as given, even one no parser reads", async () => {
    expect(await importWith("nightly-42")).toEqual({ runId: "nightly-42" });
  });

  test("a pinned one that cannot name a report folder fails at once, naming RUN_ID", async () => {
    for (const bad of ["../escape", "a/b", ".hidden"]) {
      const { error } = await importWith(bad);
      expect(error, bad).toContain(`RUN_ID=${JSON.stringify(bad)}`);
    }
  });

  test("the message escapes every control character: a C1 escape never reaches the terminal raw", async () => {
    const { error } = await importWith("run\u009b31m\u007f\u2028x");
    expect(error).toContain(String.raw`RUN_ID="run\u009b31m\u007f\u2028x"`);
    expect(error).not.toMatch(/[\u007f-\u009f\u2028\u2029]/);
  });
});

test.describe("INVOCATION_ID — the invocation's token", () => {
  /**
   * What importing run-context gives, in a fresh process with `RUN_ID` pinned: its INVOCATION_ID, the
   * one a direct child given a worker index (as Playwright gives its workers) reads, and the one a
   * direct child without one — a run the runner started itself — reads.
   */
  async function importTwice(): Promise<{
    own: string;
    worker: string;
    child: string;
  }> {
    const module = JSON.stringify(
      `${REPO_ROOT}src/common/config/run-context.ts`,
    );
    const result = await runInChildNode(
      `const { execFileSync } = await import("node:child_process");
       const { INVOCATION_ID } = await import(${module});
       const read = (env) => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
         'const { INVOCATION_ID } = await import(' + JSON.stringify(${module}) + '); process.stdout.write(INVOCATION_ID);'],
         { encoding: "utf8", env });
       const worker = read({ ...process.env, TEST_WORKER_INDEX: "0" });
       const child = read(process.env);
       console.log(JSON.stringify({ own: INVOCATION_ID, worker, child }));`,
      {
        cwd: REPO_ROOT,
        env: { E2E_LOAD_DOTENV: "false", RUN_ID: "nightly run" },
      },
    );
    return result as { own: string; worker: string; child: string };
  }

  // A pinned RUN_ID is shared by every invocation that pins it; the token never is.
  test("two invocations pinning one RUN_ID get two tokens; each one's workers share its own, nothing else", async () => {
    const [a, b] = await Promise.all([importTwice(), importTwice()]);
    expect(a.own).toMatch(/^[0-9a-f]{32}$/);
    expect(a.worker).toBe(a.own);
    expect(b.worker).toBe(b.own);
    expect(a.own).not.toBe(b.own);
    expect(a.child).toMatch(/^[0-9a-f]{32}$/);
    expect(a.child).not.toBe(a.own);
    expect(b.child).not.toBe(b.own);
  });
});
