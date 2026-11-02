import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
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

import { findSecret } from "../__fixtures__/secret-scan";

/**
 * No credential in a report, through the real runner. A synthetic product's setup project — built by
 * the config factory, so with the auth setup's real trace setting and the suite's real reporters —
 * runs `__fixtures__/secrets/canary.setup.ts`, which calls the auth setup's own `authenticatePool`
 * against a local mock WordPress: a two-site pool whose first login succeeds, with a canary password
 * and a canary session token, and whose second is rejected, failing the setup. Two more tests fail
 * with the password left in a field, and after typing a control canary with `fill()`. Then every byte
 * the run wrote is searched: the HTML report (its embedded data and `data/` zips), the Allure
 * results, the Cucumber report, `error-context.md` and the retained traces.
 *
 * The control must be found in each of those channels — proof the search reaches them, so "found
 * nowhere" means something.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/secrets");

/** A canary: random, alphanumeric, so every encoding a report could use is one the search covers. */
function canary(): string {
  return `canary${randomBytes(12).toString("hex")}`;
}

const PASSWORD = canary();
const TOKEN = canary();
const TIMEOUT_TOKEN = canary();
const CONTROL = canary();

/**
 * A stub `wp`: it records the PHP each call is handed and answers as WordPress does when it ends a
 * live session.
 */
const STUB_WP = `#!/usr/bin/env bash
printf '%s\n' "$3" >> "$WP_STUB_LOG"
printf '{"live":true,"gone":true}'
`;

let work = "";

/** Where the run reports, relative to {@link work}: the pinned cell's folder. */
const REPORT = "reports/secretprobe/x/run";

test.beforeAll(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "e2e-secrets-")));
  writeFileSync(join(work, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(work, "node_modules"));
  writeFileSync(join(work, "playwright.config.ts"), configSource());
  mkdirSync(join(work, "bin"));
  writeFileSync(join(work, "bin/wp"), STUB_WP);
  chmodSync(join(work, "bin/wp"), 0o755);
});

test.afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * The synthetic product's config: one placeholder cell, `x`, its setup project pointed at the canary
 * file and otherwise as the factory built it.
 */
function configSource(): string {
  const product = {
    name: "secretprobe",
    features: join(work, "none.feature"),
    steps: [join(REPO_ROOT, "src/common/fixtures.ts")],
    sites: {
      x: {
        sites: [
          {
            baseURL: "https://x.example.test",
            username: "u",
            password: "p",
            transport: { mode: "local", rootDir: work },
          },
        ],
      },
    },
    artifacts: {
      project: "secretprobe",
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: "secretprobe",
          mainFile: "secretprobe.php",
          pluginName: "Secret probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  return (
    `import { createProductConfig } from ${factory};\n` +
    `const config = createProductConfig(${JSON.stringify(product)});\n` +
    `export default { ...config, projects: config.projects.map((project) =>\n` +
    `  project.name === "setup:x"\n` +
    `    ? { ...project, testDir: ${JSON.stringify(FIXTURE_DIR)}, testMatch: /canary\\.setup\\.ts$/ }\n` +
    `    : project) };\n`
  );
}

/** Runs the setup project alone, as the runner would, in a built environment. */
function runSetup(): { exitCode: number | null; output: string } {
  const child = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
      "--project=setup:x",
    ],
    {
      cwd: work,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        PATH: `${join(work, "bin")}:${process.env.PATH ?? ""}`,
        HOME: process.env.HOME,
        E2E_LOAD_DOTENV: "false",
        E2E_CELL: "x",
        RUN_ID: "run",
        REPORT_ROOT: join(work, "reports"),
        OUTPUT_ROOT: join(work, "test-results"),
        AUTH_ROOT: join(work, "auth"),
        ARTIFACTS_ROOT: join(work, "artifacts"),
        CANARY_PASSWORD: PASSWORD,
        CANARY_TOKEN: TOKEN,
        CANARY_TIMEOUT_TOKEN: TIMEOUT_TOKEN,
        CANARY_CONTROL: CONTROL,
        CANARY_WORK: work,
        WP_STUB_LOG: join(work, "wp-calls.log"),
      },
    },
  );
  if (child.error !== undefined) throw child.error;
  return { exitCode: child.status, output: child.stdout + child.stderr };
}

/** The values each `wp eval` the stub received embedded, decoded from their base64 literals. */
function embeddedInWpCalls(): unknown[] {
  const log = readFileSync(join(work, "wp-calls.log"), "utf8");
  return [...log.matchAll(/base64_decode\( '([^']*)' \)/g)].map(
    (match): unknown =>
      JSON.parse(Buffer.from(match[1] ?? "", "base64").toString("utf8")),
  );
}

/** The `site-info.json` attachments Allure received, parsed. */
function siteInfoAttachments(): unknown[] {
  const dir = join(work, REPORT, "allure-results");
  return readdirSync(dir)
    .filter((name) => name.endsWith("-attachment.json"))
    .map((name): unknown => JSON.parse(readFileSync(join(dir, name), "utf8")))
    .filter((body) => JSON.stringify(body).includes("versions"));
}

test.describe.configure({ timeout: 150_000 });

let run: { exitCode: number | null; output: string };

test.beforeAll(() => {
  run = runSetup();
});

/** Every `error-context.md` the run wrote, by its test's output folder. */
function errorContexts(): Map<string, string> {
  const root = join(work, "test-results/secretprobe/_all/x");
  return new Map(
    readdirSync(root)
      .filter((dir) => existsSync(join(root, dir, "error-context.md")))
      .map((dir) => [
        dir,
        readFileSync(join(root, dir, "error-context.md"), "utf8"),
      ]),
  );
}

test("the probe ran as designed: four forced failures, the first site of each pool saved", () => {
  // One `✘ failed` line per forced failure, from the terminal reporter (`list`'s "4 failed" before).
  expect(run.output.match(/^✘ failed /gm)).toHaveLength(4);
  expect(run.output).toContain("Test timeout of 3000ms exceeded");
  expect(run.output).toContain("Test timeout of 5000ms exceeded");
  // The terminal prints errors and worker output, never a step's title: no canary reaches it.
  for (const canary of [PASSWORD, TOKEN, TIMEOUT_TOKEN, CONTROL]) {
    expect(run.output).not.toContain(canary);
  }
  expect(run.exitCode).toBe(1);
  // The session cookies were really set, so their absence from the reports is not for want of one.
  expect(readFileSync(join(work, "auth/site-0.json"), "utf8")).toContain(TOKEN);
  expect(readFileSync(join(work, "auth/site-2.json"), "utf8")).toContain(
    TIMEOUT_TOKEN,
  );
  // Each failure wrote its error context — the file a page snapshot would have gone into.
  expect(errorContexts().size).toBe(4);
});

test("no failure snapshot is written in the setup, the timed-out test's included", () => {
  for (const [dir, text] of errorContexts()) {
    expect(text, dir).not.toContain("# Page snapshot");
  }
});

test("the control typed with fill() is found in every channel searched", () => {
  const control = findSecret(work, CONTROL);
  expect(
    control.some((at) =>
      at.startsWith(`${REPORT}/playwright/index.html!embedded`),
    ),
  ).toBe(true);
  expect(
    control.some((at) => at.startsWith(`${REPORT}/playwright/data/`)),
  ).toBe(true);
  expect(control.some((at) => at.startsWith(`${REPORT}/allure-results/`))).toBe(
    true,
  );
  expect(
    control.some(
      (at) => at.startsWith("test-results/") && at.includes("trace.zip!"),
    ),
  ).toBe(true);
});

test("the password appears nowhere: no step, no Allure result, no trace, no failure snapshot", () => {
  expect(findSecret(work, PASSWORD)).toEqual([]);
});

test("the session token is only in the failed setup's trace calls, and that session was ended", () => {
  // `storageState()`'s result is a traced call, whatever the snapshot setting; network recording,
  // which would add the Set-Cookie header, is off. So the token may sit in a trace's call log alone.
  // Searched in the run's output: the saved login and the stub's call log hold it by design.
  const places = findSecret(work, TOKEN).filter(
    (at) => at.startsWith("reports/") || at.startsWith("test-results/"),
  );
  expect(places.length).toBeGreaterThan(0);
  for (const at of places) expect(at).toMatch(/\.zip!(?:\d+-)?trace\.trace$/);
  // The setup failed after saving the first site, so it ended that session: the cookie is dead.
  expect(embeddedInWpCalls()).toContainEqual({ login: "admin", token: TOKEN });
});

test("a setup that times out after saving a session still ends it", () => {
  // The timeout abandons the setup's body, its own clean-up included: the afterEach ends the session.
  const places = findSecret(work, TIMEOUT_TOKEN).filter(
    (at) => at.startsWith("reports/") || at.startsWith("test-results/"),
  );
  expect(places.length).toBeGreaterThan(0);
  for (const at of places) expect(at).toMatch(/\.zip!(?:\d+-)?trace\.trace$/);
  expect(embeddedInWpCalls()).toContainEqual({
    login: "admin",
    token: TIMEOUT_TOKEN,
  });
});

test("the versions read before the failure are attached to the reports", () => {
  expect(siteInfoAttachments()).toContainEqual([
    {
      baseURL: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/),
      versions: { wordpress: "7.1.3", php: "8.5.11 64bit" },
    },
  ]);
});

/**
 * A passing setup with the same hooks, and a scenario depending on it, in a plain config: the
 * scenario's worker must not inherit the switched-off snapshot (Playwright hands a setup worker's
 * changed variables to its dependents), so its failure keeps its page snapshot.
 */
test("a passing setup leaves its scenarios their failure snapshots", () => {
  const dir = join(work, "snapshots");
  mkdirSync(dir);
  writeFileSync(
    join(dir, "playwright.config.ts"),
    `export default {
      workers: 1,
      reporter: [["list"]],
      outputDir: ${JSON.stringify(join(dir, "test-results"))},
      projects: [
        { name: "setup", testDir: ${JSON.stringify(FIXTURE_DIR)}, testMatch: /snapshot\\.setup\\.ts$/ },
        { name: "scenarios", testDir: ${JSON.stringify(FIXTURE_DIR)}, testMatch: /snapshot\\.check\\.ts$/, dependencies: ["setup"] },
      ],
    };\n`,
  );
  const child = spawnSync(
    process.execPath,
    [
      join(REPO_ROOT, "node_modules/@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
    ],
    {
      cwd: dir,
      encoding: "utf8",
      timeout: 60_000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    },
  );
  if (child.error !== undefined) throw child.error;
  const output = child.stdout + child.stderr;
  expect(output, output).toContain("1 failed");
  expect(output).toContain("1 passed");

  const results = join(dir, "test-results");
  const [failed] = readdirSync(results).filter((name) =>
    existsSync(join(results, name, "error-context.md")),
  );
  const context = readFileSync(
    join(results, failed ?? "", "error-context.md"),
    "utf8",
  );
  expect(context).toContain("snapshot switch: unset");
  expect(context).toContain("# Page snapshot");
  expect(context).toContain("scenariofieldvalue");
});
