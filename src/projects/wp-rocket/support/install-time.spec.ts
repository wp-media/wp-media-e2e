import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALLED_AT_PHP, parseInstalledAt } from "./install-time";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import { phpLiteral } from "../../../common/wp/php";

/** Whether a `php` binary can run here (the snippet's own tests are skipped without one). */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("parseInstalledAt", () => {
  test("reads a timestamp", () => {
    expect(parseInstalledAt("1763300000", "wp-rocket/wp-rocket.php")).toBe(
      1763300000,
    );
  });

  test("a missing main file says so", () => {
    expect(() => parseInstalledAt("null", "wp-rocket/wp-rocket.php")).toThrow(
      "wp-rocket/wp-rocket.php is not on the site",
    );
  });

  test("anything else is refused, quoted", () => {
    for (const reply of ["", "x", "0", "-5", "1.5", '"1763300000"', "{}"]) {
      expect(() => parseInstalledAt(reply, "p/p.php"), reply).toThrow(
        /when p\/p\.php was installed came back as/,
      );
    }
  });
});

test.describe("INSTALLED_AT_PHP", () => {
  test.skip(!HAS_PHP, "php is not installed");
  let dir = "";
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-wpr-installed-"));
  });
  test.afterEach(() => {
    removeTempDir(dir);
  });

  /**
   * Runs the snippet with `WP_PLUGIN_DIR` at the temp folder.
   *
   * @param basename - the plugin asked about.
   */
  function run(basename: string): string {
    const result = spawnSync(
      "php",
      [
        "-r",
        `define( 'WP_PLUGIN_DIR', ${JSON.stringify(dir)} ); $basename = ${phpLiteral(basename)}; ` +
          "function wp_json_encode( $v ) { return json_encode( $v ); } " +
          INSTALLED_AT_PHP,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return result.stdout;
  }

  test("answers the main file's mtime, or null when it is not there", () => {
    mkdirSync(join(dir, "wp-rocket"));
    const file = join(dir, "wp-rocket", "wp-rocket.php");
    writeFileSync(file, "<?php\n");
    utimesSync(file, 1763300000, 1763300000);
    expect(parseInstalledAt(run("wp-rocket/wp-rocket.php"), "x")).toBe(
      1763300000,
    );
    expect(run("other/other.php")).toBe("null");
  });
});
