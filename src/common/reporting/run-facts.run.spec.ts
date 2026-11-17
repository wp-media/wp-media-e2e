import { test, expect, type Page } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseResults } from "./results-reader";
import { RESULTS_FILE } from "./results-schema";
import {
  ALLURE_ENVIRONMENT_FILE,
  ALLURE_RESULTS_DIR,
  BANNER_ID,
  CUCUMBER_REPORT_FILE,
  RUN_FACTS_FILE,
} from "./run-facts";

/**
 * The run facts through the real `bddgen`, runner and reporter stack, and the three reports rendered
 * in a browser: that the HTML report's title, the Cucumber banner (above the report's own header, in
 * the default and the rich mode, with scenarios or none) and Allure's name and metadata say what the
 * run tested, for a normal run, a failed setup, a SIGINT and a SIGKILL — and that `--list` writes none.
 *
 * The synthetic product of `results-stream.run.spec.ts`, offline: cell `x` holds a placeholder site,
 * so its setups skip; cell `y` a site on a closed local port and a zip that does not exist, so both
 * its setups fail at once.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/results");
const PRODUCT = "factsprobe";
/** The checkout's own version: the facts name it, read from the repository, not the run's folder. */
const SUITE_VERSION = (
  JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    version: string;
  }
).version;

/** How long one child may take: `bddgen`, a short run, or Allure's generation. */
const CHILD_TIMEOUT_MS = 90_000;

let work = "";

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-facts-run-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  mkdirSync(join(work, "src"));
  symlinkSync(join(REPO_ROOT, "src", "common"), join(work, "src", "common"));
  copyFileSync(
    join(FIXTURE_DIR, "results.feature"),
    join(work, "results.feature"),
  );
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The synthetic product's config: cell `x` on a placeholder site, cell `y` on one that fails. */
function configSource(dir: string): string {
  const site = (baseURL: string): Record<string, unknown> => ({
    baseURL,
    username: "u",
    password: "p",
    transport: { mode: "local", rootDir: dir },
  });
  const product = {
    name: PRODUCT,
    features: join(dir, "results.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(FIXTURE_DIR, "*.steps.ts"),
    ],
    sites: {
      x: { sites: [site("https://x.example.test")] },
      y: { sites: [site("http://127.0.0.1:9")] },
    },
    artifacts: {
      project: PRODUCT,
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: PRODUCT,
          mainFile: `${PRODUCT}.php`,
          pluginName: "Facts probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  return (
    `import { createProductConfig } from ${factory};\n` +
    `export default createProductConfig(${JSON.stringify(product)});\n`
  );
}

/** A run's environment, built — nothing inherited from this worker's own Playwright variables. */
function runEnv(
  cell: string,
  runId: string,
  extra: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: cell,
    E2E_RETRIES: "0",
    RUN_ID: runId,
    E2E_RUN_NAME: "facts <probe> & co",
    E2E_REQUESTED_REF: "develop",
    // Cell `y` only: a zip that is not there fails its artifacts setup offline.
    E2E_PLUGIN_ZIP: join(work, "missing.zip"),
    REPORT_ROOT: join(work, "reports"),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
    ...extra,
  };
}

/** The node entry of a CLI in the repository's `node_modules`. */
function cli(path: string): string {
  return join(REPO_ROOT, "node_modules", path);
}

/** A run's report folder. */
function reportDir(cell: string, runId: string): string {
  return join(work, "reports", PRODUCT, cell, runId);
}

/**
 * Runs the cell — `bddgen`, then the runner in a process group of its own — and, when `stop` is given,
 * signals once the hanging scenario has begun: SIGINT to the runner, or SIGKILL to its group. The
 * group is killed afterwards, whatever happened.
 */
async function runCell(
  cell: string,
  runId: string,
  args: readonly string[],
  options: { stop?: "SIGINT" | "SIGKILL"; env?: NodeJS.ProcessEnv } = {},
): Promise<number | null> {
  const env = runEnv(cell, runId, options.env ?? {});
  const gen = spawnSync(
    process.execPath,
    [cli("playwright-bdd/dist/cli/index.js"), "-c", "playwright.config.ts"],
    { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  if (gen.status !== 0) throw new Error(`bddgen failed: ${gen.stderr}`);
  const child = spawn(
    process.execPath,
    [
      cli("@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
      ...args,
    ],
    { cwd: work, env, detached: true, stdio: "ignore" },
  );
  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => {
      resolve(code);
    });
  });
  const killGroup = (): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
    } catch {
      // The group is gone already.
    }
  };
  const timer = setTimeout(killGroup, CHILD_TIMEOUT_MS);
  try {
    if (options.stop !== undefined) {
      await waitForHangingScenario(cell, runId);
      if (options.stop === "SIGINT") child.kill("SIGINT");
      else killGroup();
    }
    return await exited;
  } finally {
    clearTimeout(timer);
    killGroup();
  }
}

/** Polls the results stream until the hanging scenario's attempt has begun. */
async function waitForHangingScenario(
  cell: string,
  runId: string,
): Promise<void> {
  const path = join(reportDir(cell, runId), RESULTS_FILE);
  const deadline = Date.now() + CHILD_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";
    if (
      parseResults(text).events.some(
        (e) => e.type === "scenario.begin" && e.scenario.includes("hangs"),
      )
    ) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("the hanging scenario never began");
}

/** What a run's report folder says about the run. */
interface Said {
  readonly facts: Record<string, unknown> | undefined;
  readonly properties: string | undefined;
}

/** Reads `run-facts.json` and `environment.properties`, each `undefined` when absent. */
function said(cell: string, runId: string): Said {
  const folder = reportDir(cell, runId);
  const read = (path: string): string | undefined =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const facts = read(join(folder, RUN_FACTS_FILE));
  return {
    facts:
      facts === undefined
        ? undefined
        : (JSON.parse(facts) as Record<string, unknown>),
    properties: read(join(folder, ALLURE_RESULTS_DIR, ALLURE_ENVIRONMENT_FILE)),
  };
}

/** The Cucumber report rendered: the body's first element, the banner's title, whether it is on top. */
async function renderCucumber(
  page: Page,
  folder: string,
): Promise<{ first: string; title: string; aboveContent: boolean }> {
  await page.goto(pathToFileURL(join(folder, CUCUMBER_REPORT_FILE)).href);
  const banner = page.locator(`#${BANNER_ID}`);
  await expect(banner).toBeVisible();
  const [bannerBox, contentBox] = await Promise.all([
    banner.boundingBox(),
    page.locator("#content").boundingBox(),
  ]);
  return {
    first: await page.evaluate(() => document.body.firstElementChild?.id ?? ""),
    title: await banner.locator("strong").innerText(),
    aboveContent:
      bannerBox !== null &&
      contentBox !== null &&
      bannerBox.y + bannerBox.height <= contentBox.y + 1,
  };
}

/** The Playwright HTML report's title, as its page shows it. */
async function renderHtmlTitle(page: Page, folder: string): Promise<string> {
  await page.goto(pathToFileURL(join(folder, "playwright/index.html")).href);
  // The report's app sets the document's title once its data is read.
  await expect(page).not.toHaveTitle("Playwright Test Report");
  return page.title();
}

const TITLE_X =
  `${PRODUCT} · x · plugin unknown: artifacts setup skipped · ` +
  "site unknown: auth setup skipped · facts <probe> & co";

test.describe("the run facts, through the real runner, in the rendered reports", () => {
  test.describe.configure({ timeout: 3 * CHILD_TIMEOUT_MS });

  test("a normal run: every report leads with the run's line; Allure is named by it", async ({
    page,
  }) => {
    const code = await runCell("x", "normal", [
      "--grep",
      "A scenario that passes",
    ]);
    expect(code).toBe(0);
    const { facts, properties } = said("x", "normal");
    expect(facts).toMatchObject({
      v: 1,
      status: "passed",
      title: TITLE_X,
      runName: "facts <probe> & co",
      requestedRef: "develop",
      suiteVersion: SUITE_VERSION,
    });
    const lines = properties?.split("\n") ?? [];
    expect(lines.slice(0, 4)).toEqual([
      "Status=passed",
      "Plugin=unknown\\: artifacts setup skipped",
      "Site=unknown\\: auth setup skipped",
      `Cell=${PRODUCT} \\u00B7 x`,
    ]);
    // The suite's version is the last fact, in Allure's metadata and in the Cucumber banner.
    expect(lines.filter((line) => line !== "").at(-1)).toBe(
      `Suite=${SUITE_VERSION}`,
    );

    const folder = reportDir("x", "normal");
    expect(readFileSync(join(folder, CUCUMBER_REPORT_FILE), "utf8")).toContain(
      `<th scope="row">Suite</th><td>${SUITE_VERSION}</td></tr></table>`,
    );
    expect(await renderHtmlTitle(page, folder)).toBe(TITLE_X);
    expect(await renderCucumber(page, folder)).toEqual({
      first: BANNER_ID,
      title: TITLE_X,
      aboveContent: true,
    });

    const allure = spawnSync(
      process.execPath,
      [cli("tsx/dist/cli.mjs"), "scripts/allure.mjs", PRODUCT, "x"],
      {
        cwd: REPO_ROOT,
        env: {
          ...runEnv("x", "normal", {}),
          REPORT_ROOT: join(work, "reports"),
        },
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
      },
    );
    expect(allure.status, allure.stderr).toBe(0);
    await page.goto(
      pathToFileURL(join(folder, "allure/awesome/index.html")).href,
    );
    await expect(page.getByText(TITLE_X).first()).toBeVisible();
    await expect(page.getByText("Requested ref")).toBeVisible();
  });

  test("the rich mode's Cucumber report carries the banner the same way", async ({
    page,
  }) => {
    await runCell("x", "rich", ["--grep", "A scenario that passes"], {
      env: { REPORT_MODE: "rich" },
    });
    expect(await renderCucumber(page, reportDir("x", "rich"))).toEqual({
      first: BANNER_ID,
      title: TITLE_X,
      aboveContent: true,
    });
  });

  test("failed setups: COULD NOT TEST, the resolution's failure and the unknown site said; a banner with no scenario", async ({
    page,
  }) => {
    const code = await runCell("y", "setup", [
      "--grep",
      "A scenario that passes",
    ]);
    expect(code).toBe(1);
    const { facts, properties } = said("y", "setup");
    const title = String(facts?.title);
    expect(facts?.status).toBe("could-not-test");
    expect(title).toMatch(
      new RegExp(
        `^${PRODUCT} · y · resolution failed — .+ · site unknown: auth setup failed · facts <probe> & co · COULD NOT TEST$`,
      ),
    );
    // The dash is not ASCII, so it is written escaped; both failed setups are named.
    const status = properties?.split("\n")[0] ?? "";
    expect(status).toMatch(/^Status=could not test \\u2014 /);
    expect(status).toContain("artifacts\\:y failed\\: ");
    expect(status).toContain("setup\\:y failed\\: ");
    const folder = reportDir("y", "setup");
    expect(await renderHtmlTitle(page, folder)).toBe(title);
    expect(await renderCucumber(page, folder)).toEqual({
      first: BANNER_ID,
      title,
      aboveContent: true,
    });
  });

  test("one SIGINT: the reports say INTERRUPTED", async ({ page }) => {
    await runCell("x", "sigint", ["--grep", "@hang"], { stop: "SIGINT" });
    const { facts, properties } = said("x", "sigint");
    expect(facts).toMatchObject({ status: "interrupted" });
    expect(String(facts?.title)).toMatch(/ · INTERRUPTED$/);
    expect(properties).toMatch(/^Status=interrupted /);
    const folder = reportDir("x", "sigint");
    expect(await renderHtmlTitle(page, folder)).toMatch(/ · INTERRUPTED$/);
    expect((await renderCucumber(page, folder)).title).toMatch(
      / · INTERRUPTED$/,
    );
  });

  test("a SIGKILL: the facts written so far stand, saying the run was running", async () => {
    await runCell("x", "sigkill", ["--grep", "@hang"], { stop: "SIGKILL" });
    const { facts, properties } = said("x", "sigkill");
    expect(facts).toMatchObject({ status: "running" });
    expect(facts).not.toHaveProperty("endedAt");
    // Both setups ended before the scenario began, and were recorded.
    expect(facts?.cells).toEqual([
      expect.objectContaining({
        setups: { auth: "skipped", artifacts: "skipped" },
      }),
    ]);
    expect(properties).toMatch(/^Status=running .*killed\n/);
  });

  test("facts that cannot be written never fail a green run; the HTML report still gets its title", async ({
    page,
  }) => {
    // A folder where each facts file should be: every write of them fails, inside the reporter.
    const folder = reportDir("x", "blocked");
    mkdirSync(join(folder, RUN_FACTS_FILE), { recursive: true });
    mkdirSync(join(folder, ALLURE_RESULTS_DIR, ALLURE_ENVIRONMENT_FILE), {
      recursive: true,
    });
    expect(
      await runCell("x", "blocked", ["--grep", "A scenario that passes"]),
    ).toBe(0);
    expect(await renderHtmlTitle(page, folder)).toBe(TITLE_X);
  });

  test("--list writes no facts", async () => {
    expect(await runCell("x", "list", ["--list"])).toBe(0);
    expect(said("x", "list")).toEqual({
      facts: undefined,
      properties: undefined,
    });
  });
});
