import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

import {
  DUMMY_LICENCE,
  LICENCE_PLUGIN_PATH,
  licencePluginSource,
  writeLicencePhp,
} from "./licence";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";

/**
 * The licence's PHP run for real, outside WordPress, through a harness stubbing the WordPress and
 * WP-CLI functions it calls (`__fixtures__/licence-harness.php`): the must-use plugin answers WP
 * Rocket's option pre-filters with values its own offline check accepts, and the write snippet puts
 * that file where must-use plugins load. Skipped where PHP is not installed; the twin
 * spec runs both on real WordPress.
 */

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "licence-harness.php",
);

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** A temporary folder per test, removed after it. */
let dir: string;

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-wpr-licence-"));
});

test.afterEach(() => {
  removeTempDir(dir);
});

/** Runs the harness; returns its exit status and output. */
function harness(args: readonly string[]): {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const result = spawnSync("php", [HARNESS, ...args], { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Writes the must-use plugin for `licence` and returns what its filters answer. */
function filtersOf(source: string): Record<string, string> {
  const file = join(dir, "plugin.php");
  writeFileSync(file, source);
  const run = harness(["plugin", file]);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return (JSON.parse(run.stdout) as { filters: Record<string, string> })
    .filters;
}

/** PHP's `hash('crc32', …)` (the bzip2 CRC, not `crc32()`), computed by PHP itself. */
function phpCrc32(value: string): string {
  const run = spawnSync(
    "php",
    ["-r", "echo hash('crc32', $argv[1]);", "--", value],
    { encoding: "utf8" },
  );
  return run.stdout;
}

test.describe("the licence must-use plugin, in PHP", () => {
  test.skip(!HAS_PHP, "php is not installed here");

  test("is valid PHP", () => {
    const file = join(dir, "plugin.php");
    writeFileSync(file, licencePluginSource(DUMMY_LICENCE));
    const lint = spawnSync("php", ["-l", file], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });

  test("answers the three pre-filters with values WP Rocket's offline check accepts", () => {
    const filters = filtersOf(licencePluginSource(DUMMY_LICENCE));
    expect(filters).toEqual({
      consumer_key: DUMMY_LICENCE.key,
      consumer_email: DUMMY_LICENCE.email,
      secret_key: phpCrc32(DUMMY_LICENCE.email),
    });
    // `rocket_valid_key()`'s own condition: an 8-character key and the email's crc32 as secret.
    expect(filters.consumer_key).toHaveLength(8);
    expect(filters.secret_key).toMatch(/^[0-9a-f]{8}$/);
    // PHP's `crc32` hash (bzip2's), not the common CRC-32 (`crc32b`, zlib's): mixing them up would
    // license nothing.
    expect(filters.secret_key).not.toBe(
      crc32(DUMMY_LICENCE.email).toString(16).padStart(8, "0"),
    );
  });

  test("carries a hostile email byte for byte, never as PHP", () => {
    const email = "a'b\"c\\$x{`id`}?><?php echo 1;\n@example.invalid";
    const filters = filtersOf(licencePluginSource({ key: "ABCDEFGH", email }));
    expect(filters.consumer_email).toBe(email);
    expect(filters.secret_key).toBe(phpCrc32(email));
  });

  test("does nothing when loaded outside WordPress", () => {
    const file = join(dir, "plugin.php");
    writeFileSync(file, licencePluginSource(DUMMY_LICENCE));
    const run = harness(["plugin", file, "0"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("");
  });
});

test.describe("writeLicencePhp, in PHP", () => {
  test.skip(!HAS_PHP, "php is not installed here");

  /** Runs the write snippet against a fake root whose must-use plugins load from `muDir`. */
  function write(root: string, muDir: string, source: string) {
    const snippet = join(dir, "snippet.php");
    writeFileSync(snippet, writeLicencePhp(source));
    return harness(["write", snippet, root, muDir]);
  }

  test("creates the must-use plugins folder when missing and writes the plugin, exactly", () => {
    const root = join(dir, "site");
    mkdirSync(join(root, "wp-content"), { recursive: true });
    const source = licencePluginSource(DUMMY_LICENCE);

    const run = write(root, join(root, "wp-content/mu-plugins"), source);

    expect(run.stdout + run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(readFileSync(join(root, LICENCE_PLUGIN_PATH), "utf8")).toBe(source);
  });

  test("replaces a copy already there", () => {
    const root = join(dir, "site");
    mkdirSync(join(root, "wp-content/mu-plugins"), { recursive: true });
    writeFileSync(join(root, LICENCE_PLUGIN_PATH), "<?php // stale\n");
    const source = licencePluginSource(DUMMY_LICENCE);

    expect(
      write(root, join(root, "wp-content/mu-plugins/"), source).status,
    ).toBe(0);
    expect(readFileSync(join(root, LICENCE_PLUGIN_PATH), "utf8")).toBe(source);
  });

  test("refuses a site whose must-use plugins load from elsewhere, writing nothing", () => {
    const root = join(dir, "site");
    const elsewhere = join(dir, "shared-mu");
    mkdirSync(elsewhere, { recursive: true });

    const run = write(root, elsewhere, licencePluginSource(DUMMY_LICENCE));

    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(
      /^Error: must-use plugins load from .*shared-mu, not .*site\/wp-content\/mu-plugins, so the licence plugin would never load\.$/,
    );
    expect(existsSync(join(root, LICENCE_PLUGIN_PATH))).toBe(false);
    expect(existsSync(join(elsewhere, "e2e-wp-rocket-licence.php"))).toBe(
      false,
    );
  });
});
