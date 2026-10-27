import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importable, runInChildNode } from "../__fixtures__/child-node";

/**
 * What a built config holds, per `--project` selection and `E2E_CELL` pin: its projects, where each
 * writes its output, its reports and logins, its workers, and the BDD configs `bddgen` will
 * generate. Playwright empties the output folder of every project a run selects, so only a run
 * targeting a cell may own that cell's folder; and `bddgen` regenerates every cell a config holds,
 * so a pinned config must hold one. Building a config reads `process.argv` and writes the
 * environment, so each selection is built in a fresh Node, as Playwright builds it: from a
 * temporary working directory, to prove nothing lands relative to it.
 */

/** The repository root, three levels above this file. */
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** One placeholder site of the synthetic product. */
function site(host: string): Record<string, unknown> {
  return {
    baseURL: `https://${host}.example.test`,
    username: "u",
    password: "p",
    transport: { mode: "local", rootDir: "/tmp" },
  };
}

/**
 * A synthetic two-cell product — `a` with a pool of two, `b` with none: the factory needs no
 * product code, only this shape.
 */
const PRODUCT = {
  name: "demo",
  features: "src/projects/demo/features/**/*.feature",
  steps: ["src/common/fixtures.ts"],
  sites: {
    a: { sites: [site("a0"), site("a1")] },
    b: { sites: [] },
  },
  artifacts: {
    project: "demo",
    defaultRef: { plugin: "develop" },
    version: { kind: "embedded" },
    edition: {
      kind: "editionless",
      identity: { slug: "demo", mainFile: "demo.php", pluginName: "Demo" },
    },
  },
};

/** What one built config says. */
interface Built {
  /** Project name → its `outputDir`, in the config's order. */
  readonly outputDirs: Record<string, string>;
  /** The run's global worker count. */
  readonly workers: number;
  /** Every path a reporter writes to. */
  readonly reportPaths: string[];
  /** The cell notice reporter's options. */
  readonly notice: Record<string, unknown>;
  /** The output folders of the BDD configs registered for `bddgen`, relative. */
  readonly bddConfigs: string[];
  /** The cells whose site pool this process registered. */
  readonly pools: string[];
  /** The first site of cell `a`'s `storageState` path, if `a` was built. */
  readonly storageState?: string;
  /** `PLAYWRIGHT_BDD_CONFIGS` as the build left it — what a child of this process inherits. */
  readonly bddEnv: string;
  /** Project name → the trace option it sets itself (absent: the run's own). */
  readonly traces: Record<string, unknown>;
  /** The run's own trace option. */
  readonly runTrace: unknown;
  /** The config's `captureGitInfo`; `null` when unset. */
  readonly captureGitInfo: unknown;
  /** The run's own `navigationTimeout`. */
  readonly navigationTimeout: unknown;
  /** Project name → the `navigationTimeout` it sets itself (absent: the run's own). */
  readonly projectNavigationTimeouts: Record<string, unknown>;
}

/** A working directory that is not the repository's. */
let elsewhere = "";

test.beforeAll(() => {
  elsewhere = mkdtempSync(join(tmpdir(), "e2e-project-"));
});

test.afterAll(() => {
  rmSync(elsewhere, { recursive: true, force: true });
});

/** Builds the config with `args` on the command line and `env` added, in a fresh Node. */
async function build(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<Built> {
  const file = (path: string): string => importable(join(REPO_ROOT, path));
  return (await runInChildNode(
    `
    process.argv.push(...${JSON.stringify(args)});
    const { relative } = await import("node:path");
    const { createProductConfig } = await import(${file("src/common/config/project.ts")});
    const { getPool } = await import(${file("src/common/config/metadata.ts")});
    const config = createProductConfig(${JSON.stringify(PRODUCT)});
    const pools = ["a", "b"].filter((cell) => {
      try { getPool("demo", cell); return true; } catch { return false; }
    });
    console.log(JSON.stringify({
      outputDirs: Object.fromEntries(config.projects.map((p) => [p.name, p.outputDir])),
      workers: config.workers,
      reportPaths: config.reporter.flatMap(([, options]) =>
        [options?.outputFolder, options?.outputFile, options?.resultsDir].filter(Boolean)),
      notice: config.reporter[0][1],
      // Outside Playwright's loader, playwright-bdd resolves them against the working directory.
      bddConfigs: Object.keys(JSON.parse(process.env.PLAYWRIGHT_BDD_CONFIGS ?? "{}"))
        .map((dir) => relative(process.cwd(), dir)),
      pools,
      storageState: pools.includes("a") ? getPool("demo", "a")[0].storageState : undefined,
      bddEnv: process.env.PLAYWRIGHT_BDD_CONFIGS ?? "",
      traces: Object.fromEntries(config.projects.map((p) => [p.name, p.use?.trace ?? null])),
      runTrace: config.use.trace,
      captureGitInfo: config.captureGitInfo ?? null,
      navigationTimeout: config.use.navigationTimeout ?? null,
      projectNavigationTimeouts: Object.fromEntries(
        config.projects.map((p) => [p.name, p.use?.navigationTimeout ?? null])),
    }));
    `,
    { cwd: elsewhere, env: { RUN_ID: "run-1", ...env } },
  )) as Built;
}

/** Each of cell `cell`'s three projects, mapped to `dir`. */
function cellProjects(cell: string, dir: string): Record<string, string> {
  return { [`setup:${cell}`]: dir, [`artifacts:${cell}`]: dir, [cell]: dir };
}

/** The folder `bddgen` generates cell `cell`'s specs in, relative to the config's folder. */
function bddDir(cell: string): string {
  return `.features-gen/demo/${cell}`;
}

const OWN_A = "test-results/demo/a";
const ALL_A = "test-results/demo/_all/a";
const ALL_B = "test-results/demo/_all/b";

// Functions cannot ride project metadata: the factory's registries are their only channel.
test("registers the product's leftover settling for the preflight, in the building process", async () => {
  const file = (path: string): string => importable(join(REPO_ROOT, path));
  const registered = (await runInChildNode(
    `
    const { createProductConfig } = await import(${file("src/common/config/project.ts")});
    const { getSettleLeftovers } = await import(${file("src/common/config/metadata.ts")});
    const settle = async () => {};
    createProductConfig({ ...${JSON.stringify(PRODUCT)}, settleLeftovers: settle });
    console.log(JSON.stringify(getSettleLeftovers("demo") === settle));
    `,
    { cwd: elsewhere, env: { RUN_ID: "run-1" } },
  )) as boolean;
  expect(registered).toBe(true);
});

test.describe("createProductConfig — output folders by selection", () => {
  test("a run targeting a cell gives all three of its projects the cell's folder", async () => {
    expect((await build(["--project=a"])).outputDirs).toEqual({
      ...cellProjects("a", OWN_A),
      ...cellProjects("b", ALL_B),
    });
  });

  test("every run targeting no single cell writes, and reports, under _all", async () => {
    const selections = [
      [], // no --project
      ["--project=setup:a"], // a setup project alone
      ["--project=artifacts:a"],
      ["--project=*"], // a wildcard
      ["--project=A"], // Playwright ignores case; the run is not treated as targeting `a`
    ];
    const built = await Promise.all(selections.map((args) => build(args)));
    const allRun = resolve(REPO_ROOT, "reports/demo/_all/run-1");
    built.forEach(({ outputDirs, reportPaths, notice, workers }, index) => {
      const selection = JSON.stringify(selections[index]);
      expect(outputDirs, selection).toEqual({
        ...cellProjects("a", ALL_A),
        ...cellProjects("b", ALL_B),
      });
      expect(reportPaths, selection).toHaveLength(3);
      for (const path of reportPaths) {
        expect(path, selection).toMatch(new RegExp(`^${allRun}/`));
      }
      expect(notice, selection).not.toHaveProperty("cell");
      expect(workers, selection).toBe(1);
    });
  });

  // The load-bearing invariant: two cells in one run would overflow the smaller pool.
  test("refuses two cells in one run, naming them", async () => {
    await expect(build(["--project=a", "--project=b"])).rejects.toThrow(
      "Multiple cells selected (a, b).",
    );
  });

  // Playwright matches `--project` ignoring case and expanding `*`: a cell named exactly beside one
  // reached that way would size the run for the first while Playwright runs both.
  test("refuses a cell named exactly beside another reached by case, a wildcard or its setup", async () => {
    for (const other of [
      "--project=B",
      "--project=b*",
      "--project=*",
      "--project=setup:b",
    ]) {
      await expect(build(["--project=a", other]), other).rejects.toThrow(
        "Multiple cells selected (a, b).",
      );
    }
  });

  test("OUTPUT_ROOT replaces only the root", async () => {
    const { outputDirs } = await build(["--project=a"], {
      OUTPUT_ROOT: "/srv/e2e-output",
    });
    expect(outputDirs.a).toBe("/srv/e2e-output/demo/a");
    expect(outputDirs.b).toBe("/srv/e2e-output/demo/_all/b");
  });
});

test.describe("createProductConfig — paths that never follow the working directory", () => {
  test("every report lands in the run's folder in the repository", async () => {
    const [targeted, untargeted] = await Promise.all([
      build(["--project=a"]),
      build([]),
    ]);
    const run = (cell: string): string =>
      resolve(REPO_ROOT, "reports/demo", cell, "run-1");
    expect(targeted.reportPaths).toEqual([
      `${run("a")}/playwright`,
      `${run("a")}/cucumber/index.html`,
      `${run("a")}/allure-results`,
    ]);
    expect(untargeted.reportPaths).toEqual([
      `${run("_all")}/playwright`,
      `${run("_all")}/cucumber/index.html`,
      `${run("_all")}/allure-results`,
    ]);
  });

  test("a site's login is saved in the repository's .auth", async () => {
    expect((await build(["--project=a"])).storageState).toBe(
      resolve(REPO_ROOT, ".auth/demo/a/site-0.json"),
    );
  });
});

test.describe("createProductConfig — traces", () => {
  test("the auth setup traces without DOM snapshots; the other projects keep the run's trace", async () => {
    // A DOM snapshot records every field's value, the login's password included, and network
    // recording carries the session cookies: the setup project, which only logs in, keeps neither.
    const built = await build(["--project=a"]);
    expect(built.runTrace).toBe("retain-on-failure");
    expect(built.traces).toEqual({
      "setup:a": { mode: "retain-on-failure", snapshots: { dom: false } },
      "artifacts:a": null,
      a: null,
      "setup:b": { mode: "retain-on-failure", snapshots: { dom: false } },
      "artifacts:b": null,
      b: null,
    });
  });
});

test.describe("createProductConfig — navigations", () => {
  test("every project bounds a navigation at a minute, not Playwright's unlimited default", async () => {
    // A page that lost its document never fires `load`; unbounded, its navigation waits out the
    // scenario's whole budget. No project may lift the bound for itself.
    const built = await build(["--project=a"]);
    expect(built.navigationTimeout).toBe(60_000);
    expect(Object.values(built.projectNavigationTimeouts)).toEqual(
      Array.from({ length: 6 }, () => null),
    );
  });
});

test.describe("createProductConfig — what the reports say about the run", () => {
  test("the display-only run name and requested ref reach the reporters; a blank one is absent", async () => {
    const [named, blank] = await Promise.all([
      build([], { E2E_RUN_NAME: "nightly", E2E_REQUESTED_REF: "develop" }),
      build([], { E2E_RUN_NAME: " ", E2E_REQUESTED_REF: "" }),
    ]);
    expect(named.notice).toMatchObject({
      runName: "nightly",
      requestedRef: "develop",
    });
    expect(blank.notice).not.toHaveProperty("runName");
    expect(blank.notice).not.toHaveProperty("requestedRef");
  });

  // Unset is not off: Playwright captures both under CI (`captureGitInfo?.commit === undefined && ci`).
  test("never captures git info, which records authors' emails and, under CI, a diff", async () => {
    expect((await build([])).captureGitInfo).toEqual({
      commit: false,
      diff: false,
    });
  });
});

test.describe("createProductConfig — unpinned, the config holds every cell", () => {
  test("bddgen gets every cell's BDD config, so it regenerates every cell's specs", async () => {
    const built = await build(["--project=a"]);
    expect(built.bddConfigs).toEqual([bddDir("a"), bddDir("b")]);
    expect(built.pools).toEqual(["a", "b"]);
  });

  test("the notice names the cell --project selected, or none, and no pin", async () => {
    const [selected, none] = await Promise.all([
      build(["--project=a"]),
      build([]),
    ]);
    expect(selected.notice).toMatchObject({
      product: "demo",
      cell: "a",
      pinned: false,
      reportDir: "reports/demo/a/run-1",
    });
    expect(selected.workers).toBe(2);
    expect(none.notice).not.toHaveProperty("cell");
    expect(none.notice).toMatchObject({
      pinned: false,
      reportDir: "reports/demo/_all/run-1",
    });
    expect(none.workers).toBe(1);
  });
});

test.describe("createProductConfig — pinned by E2E_CELL", () => {
  const PIN_A = { E2E_CELL: "a" };

  test("holds only the pinned cell: its three projects, its pool, its BDD config", async () => {
    const built = await build([], PIN_A);
    expect(built.outputDirs).toEqual(cellProjects("a", OWN_A));
    expect(Object.keys(built.outputDirs)).toEqual([
      "setup:a",
      "artifacts:a",
      "a",
    ]);
    expect(built.pools).toEqual(["a"]);
    expect(built.bddConfigs).toEqual([bddDir("a")]);
  });

  test("sizes the run to the pinned pool and reports under the cell, saying it was pinned", async () => {
    const built = await build([], PIN_A);
    expect(built.workers).toBe(2);
    const run = resolve(REPO_ROOT, "reports/demo/a/run-1");
    expect(built.reportPaths).toEqual([
      `${run}/playwright`,
      `${run}/cucumber/index.html`,
      `${run}/allure-results`,
    ]);
    expect(built.notice).toMatchObject({
      product: "demo",
      cell: "a",
      pinned: true,
      reportDir: "reports/demo/a/run-1",
    });
  });

  test("a cell with no pool can be pinned: one worker, its projects alone", async () => {
    const built = await build([], { E2E_CELL: "b" });
    expect(built.outputDirs).toEqual(cellProjects("b", "test-results/demo/b"));
    expect(built.workers).toBe(1);
    expect(built.bddConfigs).toEqual([bddDir("b")]);
  });

  test("owns the cell's folder only when it runs the cell whole", async () => {
    const owning = [[], ["--project=a"]];
    const notOwning = [
      ["--project=setup:a"],
      ["--project=artifacts:a"],
      ["--project=*"],
      ["--project=A"],
    ];
    const built = await Promise.all(
      [...owning, ...notOwning].map((args) => build(args, PIN_A)),
    );
    const run = resolve(REPO_ROOT, "reports/demo/a/run-1");
    built.forEach(({ outputDirs, notice, reportPaths }, index) => {
      const selection = JSON.stringify([...owning, ...notOwning][index]);
      const dir = index < owning.length ? OWN_A : ALL_A;
      expect(outputDirs, selection).toEqual(cellProjects("a", dir));
      // The report follows the pin even when the output does not: one folder per RUN_ID.
      expect(notice, selection).toMatchObject({
        cell: "a",
        pinned: true,
        reportDir: "reports/demo/a/run-1",
      });
      expect(reportPaths[0], selection).toBe(`${run}/playwright`);
    });
  });

  // A worker inherits its runner's value, which names the pinned cell alone.
  test("accepts the BDD config its own pinned run handed down", async () => {
    const runner = await build([], PIN_A);
    const worker = await build([], {
      ...PIN_A,
      PLAYWRIGHT_BDD_CONFIGS: runner.bddEnv,
    });
    expect(worker.bddConfigs).toEqual([bddDir("a")]);
  });

  // Inherited from an unpinned run, the list names every cell: bddgen would regenerate them all.
  test("refuses BDD configs inherited from an enclosing run naming other cells", async () => {
    const enclosing = await build([]);
    await expect(
      build([], { ...PIN_A, PLAYWRIGHT_BDD_CONFIGS: enclosing.bddEnv }),
    ).rejects.toThrow(
      "PLAYWRIGHT_BDD_CONFIGS came into this run naming other cells' specs (demo/b)",
    );
  });

  // A seed some other run wrote is not this run's selection: no false "--project selects nothing".
  test("ignores a selection seed inherited from another run", async () => {
    const built = await build([], {
      ...PIN_A,
      E2E_INTERNAL_SELECTED_CELLS: JSON.stringify({ pid: 1, cells: ["b"] }),
    });
    expect(built.outputDirs).toEqual(cellProjects("a", OWN_A));
  });

  test("a blank pin is no pin", async () => {
    const built = await build([], { E2E_CELL: "  " });
    expect(built.bddConfigs).toEqual([bddDir("a"), bddDir("b")]);
    expect(built.notice).toMatchObject({ pinned: false });
  });

  test("refuses a pin naming no cell of the product, naming its cells", async () => {
    await expect(build([], { E2E_CELL: "c" })).rejects.toThrow(
      '[cell] E2E_CELL="c" is not a cell of demo; its cells: a, b.',
    );
  });

  test("refuses a --project that selects none of the pinned cell's projects", async () => {
    for (const args of [
      ["--project=b"],
      ["--project=setup:b"],
      ["--project=b*"],
    ]) {
      await expect(build(args, PIN_A), JSON.stringify(args)).rejects.toThrow(
        'E2E_CELL pins it to "a", whose projects are setup:a, artifacts:a, a.',
      );
    }
  });
});

// The drain gate reads "cannot tell" as "not stopped", so a stop file it could never see would leave
// every stop to an interrupt. The factory refuses one as the run starts, once, in every process.
test.describe("createProductConfig — the drain's stop file", () => {
  test("builds with a stop file whose folder exists, the file itself not yet made", async () => {
    const built = await build([], {
      E2E_INTERNAL_STOP_FILE: join(elsewhere, "stop"),
    });
    expect(built.bddConfigs).toEqual([bddDir("a"), bddDir("b")]);
  });

  test("refuses a relative stop file, naming the variable", async () => {
    await expect(
      build([], { E2E_INTERNAL_STOP_FILE: "runs/1/stop" }),
    ).rejects.toThrow(
      'E2E_INTERNAL_STOP_FILE must be an absolute path with no surrounding whitespace, got "runs/1/stop"',
    );
  });

  test("refuses a stop file in a folder that does not exist, naming the folder", async () => {
    const stopFile = join(elsewhere, "missing", "stop");
    await expect(
      build([], { E2E_INTERNAL_STOP_FILE: stopFile }),
    ).rejects.toThrow(
      `its folder ${join(elsewhere, "missing")} cannot be read (ENOENT)`,
    );
  });
});
