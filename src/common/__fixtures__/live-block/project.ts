import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../temp-dir";
import { LIVE_PROBE_ENV } from "./probe-env";

/**
 * The live block spec's project: a synthetic product in a temporary folder (so every path the config
 * factory derives lands there) running `live-block.feature` on two placeholder sites — two workers,
 * no setup touching anything, nothing leaving the machine — through the real config factory,
 * `bddgen`, runner and reporter stack. Its config also starts `foreign.ts` in the runner.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));
const FIXTURE_DIR = join(REPO_ROOT, "src/common/__fixtures__/live-block");

/** The synthetic product's name. */
export const LIVE_PRODUCT = "liveprobe";

/** The cell it runs. */
export const LIVE_CELL = "x";

/** The two sites' labels, as the block shows them. */
export const LIVE_SITES = ["live-a.example.test", "live-b.example.test"];

/** How long `bddgen` may take. */
const BDDGEN_TIMEOUT_MS = 90_000;

/** One project folder, made by {@link makeLiveProject}. */
export interface LiveProject {
  /** The folder: the run's working directory. */
  readonly dir: string;
  /**
   * A run's whole environment: nothing inherited but `PATH` and `HOME`, plus `extra`.
   *
   * @param runId - the run's token.
   * @param extra - variables on top (`TERM`, `NO_COLOR`, `E2E_OUTPUT`, …).
   */
  env(runId: string, extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /**
   * Generates the specs; throws when `bddgen` fails.
   *
   * @param env - the run's environment.
   */
  bddgen(env: NodeJS.ProcessEnv): void;
  /** The runner's command: Node, Playwright's CLI and its arguments. */
  readonly command: readonly string[];
  /** Removes the folder; idempotent. */
  remove(): void;
}

/**
 * Makes a project folder.
 *
 * @returns the project.
 */
export function makeLiveProject(): LiveProject {
  // Its real path: playwright-bdd compares the feature's path to the config's resolved folder, and
  // macOS's temporary folder sits behind a symlink.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "e2e-live-block-")));
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  symlinkSync(join(REPO_ROOT, "node_modules"), join(dir, "node_modules"));
  // The setup projects' folders are relative to the config's: the real (skipping) setups run.
  mkdirSync(join(dir, "src"));
  symlinkSync(join(REPO_ROOT, "src", "common"), join(dir, "src", "common"));
  copyFileSync(
    join(FIXTURE_DIR, "live-block.feature"),
    join(dir, "live-block.feature"),
  );
  mkdirSync(join(dir, "requests"));
  writeFileSync(join(dir, "playwright.config.ts"), configSource(dir));
  return {
    dir,
    env: (runId, extra = {}) => ({
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      E2E_LOAD_DOTENV: "false",
      E2E_CELL: LIVE_CELL,
      E2E_RETRIES: "1",
      RUN_ID: runId,
      REPORT_ROOT: join(dir, "reports"),
      OUTPUT_ROOT: join(dir, "test-results"),
      AUTH_ROOT: join(dir, "auth"),
      ARTIFACTS_ROOT: join(dir, "artifacts"),
      [LIVE_PROBE_ENV.requests]: join(dir, "requests"),
      ...extra,
    }),
    bddgen: (env) => {
      const child = spawnSync(
        process.execPath,
        [cli("playwright-bdd/dist/cli/index.js"), "-c", "playwright.config.ts"],
        { cwd: dir, env, encoding: "utf8", timeout: BDDGEN_TIMEOUT_MS },
      );
      if (child.error !== undefined) throw child.error;
      if (child.status !== 0)
        throw new Error(
          `bddgen failed (${String(child.status)}):\n${child.stderr}`,
        );
    },
    command: [
      process.execPath,
      cli("@playwright/test/cli.js"),
      "test",
      "-c",
      "playwright.config.ts",
    ],
    remove: () => {
      removeTempDir(dir);
    },
  };
}

/**
 * The node entry of a CLI in the repository's `node_modules`.
 *
 * @param path - its path there.
 */
function cli(path: string): string {
  return join(REPO_ROOT, "node_modules", path);
}

/**
 * The synthetic product's config: one cell of two placeholder sites, the fixture's steps, and the
 * foreign writer started in the runner.
 *
 * @param dir - the project's folder.
 */
function configSource(dir: string): string {
  const site = (label: string): object => ({
    baseURL: `https://${label}`,
    username: "u",
    password: "p",
    transport: { mode: "local", rootDir: dir },
  });
  const product = {
    name: LIVE_PRODUCT,
    features: join(dir, "live-block.feature"),
    steps: [
      join(REPO_ROOT, "src/common/fixtures.ts"),
      join(FIXTURE_DIR, "live-block.steps.ts"),
    ],
    sites: { [LIVE_CELL]: { sites: LIVE_SITES.map(site) } },
    artifacts: {
      project: LIVE_PRODUCT,
      defaultRef: { plugin: "develop" },
      version: { kind: "embedded" },
      edition: {
        kind: "editionless",
        identity: {
          slug: LIVE_PRODUCT,
          mainFile: `${LIVE_PRODUCT}.php`,
          pluginName: "Live probe",
        },
      },
    },
  };
  const factory = JSON.stringify(
    join(REPO_ROOT, "src/common/config/project.ts"),
  );
  const foreign = JSON.stringify(join(FIXTURE_DIR, "foreign.ts"));
  return (
    `import { createProductConfig } from ${factory};\n` +
    `import { watchForWrites } from ${foreign};\n` +
    `watchForWrites();\n` +
    `export default createProductConfig(${JSON.stringify(product)});\n`
  );
}
