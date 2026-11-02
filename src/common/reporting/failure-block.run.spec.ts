import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Failure blocks through the real `bddgen`, runner and reporter stack: a synthetic product runs
 * `__fixtures__/failures/failures.feature` on a placeholder site (its setups skip; nothing leaves the
 * machine). One scenario types a secret with `enterSecret` and a control with `fill()`, then fails a
 * check; another's title holds regex metacharacters, quotes, `$`, a backtick, a backslash, emoji, CJK,
 * an escape sequence and a bidi override; a third's title is held by two longer ones. The run's name
 * and report folder carry escapes too.
 *
 * Proven: each failure prints its block with the Gherkin step; neither canary, nor any escape or
 * control, reaches the terminal (the control does reach the reports, so its absence means something);
 * and the printed rerun command, read back by a real shell, selects exactly the scenario it names —
 * never one whose title holds it.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/failures");
const PRODUCT = "failureprobe";

/** How long one child may take: `bddgen`, a short run, or a listing. */
const CHILD_TIMEOUT_MS = 90_000;

/** A canary: random and alphanumeric, so any encoding a channel could use is one the search covers. */
function canary(): string {
  return `canary${randomBytes(12).toString("hex")}`;
}

const SECRET = canary();
const CONTROL = canary();

/** The escape-carrying folder the run reports in, under the work folder. */
const REPORTS = "reports\u001b[31mred\u001b[0m";

let work = "";

/** What the run printed and left. */
let run: { status: number | null; stdout: string; stderr: string };

test.describe.configure({ timeout: 180_000 });

test.beforeAll(() => {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder.
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-failures-run-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  copyFileSync(
    join(FIXTURE_DIR, "failures.feature"),
    join(work, "failures.feature"),
  );
  writeFileSync(join(work, "playwright.config.ts"), configSource(work));
  const env = runEnv();
  const generated = spawnSync(
    process.execPath,
    [cli("playwright-bdd/dist/cli/index.js"), "-c", "playwright.config.ts"],
    { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  if (generated.status !== 0) {
    throw new Error(`bddgen failed:\n${generated.stderr}`);
  }
  const child = spawnSync(
    process.execPath,
    [cli("@playwright/test/cli.js"), "test", "-c", "playwright.config.ts"],
    { cwd: work, env, encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  if (child.error !== undefined) throw child.error;
  run = { status: child.status, stdout: child.stdout, stderr: child.stderr };
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/** The synthetic product's config: one placeholder cell, `x`. */
function configSource(dir: string): string {
  const product = {
    name: PRODUCT,
    features: join(dir, "failures.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(FIXTURE_DIR, "*.steps.ts"),
    ],
    sites: {
      x: {
        sites: [
          {
            baseURL: "https://x.example.test",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: dir },
          },
        ],
      },
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
          pluginName: "Failure probe",
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

/** The run's environment, built — nothing inherited from this worker's Playwright variables. */
function runEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    E2E_LOAD_DOTENV: "false",
    E2E_CELL: "x",
    E2E_RETRIES: "0",
    E2E_PLUGIN_REF: "develop",
    E2E_PLUGIN_VERSION: "1.2.3",
    E2E_RUN_NAME: "\u001b]0;pwned\u0007nightly \u001b[2Jrun",
    RUN_ID: "run",
    REPORT_ROOT: join(work, REPORTS),
    OUTPUT_ROOT: join(work, "test-results"),
    AUTH_ROOT: join(work, "auth"),
    ARTIFACTS_ROOT: join(work, "artifacts"),
    CANARY_SECRET: SECRET,
    CANARY_CONTROL: CONTROL,
  };
}

/** The node entry of a CLI in the repository's `node_modules`. */
function cli(path: string): string {
  return join(REPO_ROOT, "node_modules", path);
}

/** The block lines under the test line that names `scenario`, up to the next unindented line. */
function blockOf(scenario: string): string[] {
  const lines = run.stdout.split("\n");
  const head = lines.findIndex(
    (line) => line.startsWith("✘ failed ") && line.includes(scenario),
  );
  if (head === -1) throw new Error(`no failure line for "${scenario}"`);
  const rest = lines.slice(head + 1);
  const end = rest.findIndex((line) => !line.startsWith("  "));
  return end === -1 ? rest : rest.slice(0, end);
}

/** The `--grep` word of a block's rerun command, as a real shell reads it. */
function grepOf(block: readonly string[]): string {
  const rerun = block.find((line) => line.startsWith("  Rerun"));
  const command = rerun?.replace(/^ {2}Rerun {7}/, "") ?? "";
  expect(command).toMatch(
    // The artifacts setup skips on a placeholder site, recording no build: the operator's ref and
    // version ride along.
    /^E2E_CELL=x E2E_PLUGIN_REF=develop E2E_PLUGIN_VERSION=1\.2\.3 npm run test:failureprobe -- --grep=/,
  );
  const word = command.slice(command.indexOf("--grep="));
  const read = spawnSync("/bin/sh", ["-c", `printf '%s' ${word}`], {
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin" },
  });
  expect(read.status).toBe(0);
  return read.stdout.slice("--grep=".length);
}

/** The scenarios a `--list` run with `--grep=<pattern>` selects, by title. */
function listed(pattern: string): string[] {
  const child = spawnSync(
    process.execPath,
    [
      cli("@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
      "--list",
      `--grep=${pattern}`,
    ],
    { cwd: work, env: runEnv(), encoding: "utf8", timeout: CHILD_TIMEOUT_MS },
  );
  expect(child.status, child.stderr).toBe(0);
  return child.stdout
    .split("\n")
    .filter((line) => line.includes("failures.feature.spec.js"))
    .map((line) => line.split(" › ").at(-1) ?? "");
}

test("each failure prints its block: the Gherkin step, the feature, the error, a rerun", () => {
  expect(run.status).toBe(1);
  const block = blockOf("A secret typed into a field");
  expect(block[0]).toBe(
    "  Step        When a secret and a control are typed, then a check fails",
  );
  expect(block[1]).toBe("  Feature     failures.feature");
  expect(block[2]).toMatch(
    /^ {2}Error {7}Error: expect\(locator\)\.toBeHidden/,
  );
  expect(block).toContainEqual(
    expect.stringMatching(/^ {2}Screenshot {2}test-results\/.+\.png$/),
  );
  expect(block).toContainEqual(
    expect.stringMatching(/^ {2}Trace {7}test-results\/.+trace\.zip$/),
  );
  // The summary lists both failures, each with its step.
  expect(run.stdout).toContain(
    "  Failed      Failure blocks, end to end › A secret typed into a field, then a failing check — When a secret and a control are typed, then a check fails",
  );
});

test("neither canary, nor any escape or control, reaches the terminal; the control does reach the reports", () => {
  for (const value of [SECRET, CONTROL]) {
    expect(run.stdout).not.toContain(value);
    expect(run.stderr).not.toContain(value);
  }
  // A pipe: not one escape, whatever the title, the run's name or the report folder carried.
  for (const line of run.stdout.split("\n")) {
    expect(line).not.toMatch(/[\p{Cc}\p{Cf}]/u);
  }
  expect(run.stderr).not.toContain("\u001b");
  // The control was typed with `fill()`, whose step title quotes it: the reports record it.
  const allure = join(work, REPORTS, PRODUCT, "x", "run", "allure-results");
  const recorded = readdirSync(allure)
    .filter((name) => name.endsWith("-result.json"))
    .some((name) => readFileSync(join(allure, name), "utf8").includes(CONTROL));
  expect(recorded).toBe(true);
});

test("the nasty title prints plain, and its rerun command selects exactly that scenario", () => {
  const head = run.stdout
    .split("\n")
    .find((line) => line.startsWith("✘ failed ") && line.includes("漢字"));
  expect(head).toContain(
    "Regex (a+b)* [x] {1} ^$ | 'single' \"double\" $HOME `tick` \\ 👩💻 漢字 red rtl end",
  );
  const pattern = grepOf(blockOf("漢字"));
  const selected = listed(pattern);
  expect(selected).toHaveLength(1);
  expect(selected[0]).toContain("漢字");
  expect(selected[0]).not.toContain("near miss");
});

test("a title two longer ones hold, tagged or not: its rerun selects it alone", () => {
  // Matched as a substring, the pattern would select all three.
  expect(listed("/Create a backup/")).toHaveLength(3);
  expect(listed(grepOf(blockOf("Create a backup")))).toEqual([
    "Create a backup",
  ]);
});
