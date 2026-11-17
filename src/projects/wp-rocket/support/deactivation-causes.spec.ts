import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  DEACTIVATION_CAUSES_PHP,
  judgeForcedDeactivation,
  parseDeactivationCauses,
} from "./deactivation-causes";
import type { StopDeactivation } from "./background-work";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";

/** Whether a `php` binary can run here (the snippet's own tests are skipped without one). */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

const FORCED: Extract<StopDeactivation, { kind: "forced" }> = {
  kind: "forced",
  plainSaid: "`wp plugin deactivate` exited 0 but left it active",
};

test.describe("parseDeactivationCauses", () => {
  test("reads the two causes and the commands' user", () => {
    expect(
      parseDeactivationCauses(
        '{"wpconfig":true,"htaccess":false,"commandsUser":"ubuntu"}',
      ),
    ).toEqual({ wpconfig: true, htaccess: false, commandsUser: "ubuntu" });
  });

  test("refuses anything else, quoting it", () => {
    for (const reply of [
      "",
      "[]",
      '{"wpconfig":1,"htaccess":false,"commandsUser":""}',
      '{"wpconfig":true,"commandsUser":""}',
      '{"wpconfig":true,"htaccess":false}',
    ]) {
      expect(() => parseDeactivationCauses(reply), reply).toThrow(
        /reading what keeps WP Rocket active came back as/,
      );
    }
  });
});

test.describe("judgeForcedDeactivation", () => {
  test("no cause holding is WP Rocket's regression, saying what the plain one did", () => {
    const verdict = judgeForcedDeactivation(FORCED, {
      wpconfig: false,
      htaccess: false,
      commandsUser: "www-data",
    });
    expect(verdict.kind).toBe("regression");
    expect(verdict.message).toMatch(
      /refused to be deactivated although the site's commands \(www-data\) can write wp-config\.php/,
    );
    expect(verdict.message).toContain(FORCED.plainSaid);
  });

  test("an unwritable wp-config.php or .htaccess is the site's setup, each named", () => {
    const config = judgeForcedDeactivation(FORCED, {
      wpconfig: true,
      htaccess: false,
      commandsUser: "ubuntu",
    });
    expect(config).toEqual({
      kind: "expected",
      message:
        "WP Rocket refused to be deactivated, as it does when the site's commands (ubuntu) cannot " +
        "write wp-config.php (the site's setup): a plain deactivation left it active " +
        "(`wp plugin deactivate` exited 0 but left it active), so it was forced.",
    });
    expect(
      judgeForcedDeactivation(
        { ...FORCED, forceError: "boom" },
        { wpconfig: true, htaccess: true, commandsUser: "" },
      ).message,
    ).toMatch(
      /when the site's commands cannot write wp-config\.php or \.htaccess \(Apache\).*; the force reported: boom\.$/,
    );
    expect(
      judgeForcedDeactivation(FORCED, {
        wpconfig: false,
        htaccess: true,
        commandsUser: "u",
      }).kind,
    ).toBe("expected");
  });
});

test.describe("DEACTIVATION_CAUSES_PHP", () => {
  test.skip(!HAS_PHP, "php is not installed");
  let dir = "";
  let root = "";
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-wpr-causes-"));
    root = join(dir, "public");
    mkdirSync(join(root, "wp-admin", "includes"), { recursive: true });
    // WordPress's file.php, as far as the snippet uses it.
    writeFileSync(
      join(root, "wp-admin", "includes", "file.php"),
      "<?php function get_home_path() { return ABSPATH; }\n",
    );
  });
  test.afterEach(() => {
    removeTempDir(dir);
  });

  /**
   * Runs the snippet with `ABSPATH` at the root and `$is_apache` as given.
   *
   * @param apache - what `$is_apache` holds.
   */
  function causes(apache: boolean) {
    const result = spawnSync(
      "php",
      [
        "-r",
        `define( 'ABSPATH', ${JSON.stringify(`${root}/`)} ); $GLOBALS['is_apache'] = ${String(apache)}; ` +
          "function wp_json_encode( $v ) { return json_encode( $v ); } " +
          DEACTIVATION_CAUSES_PHP,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    return parseDeactivationCauses(result.stdout);
  }

  test("a writable wp-config.php and .htaccess: no cause, the commands' user named", () => {
    writeFileSync(join(root, "wp-config.php"), "<?php\n");
    writeFileSync(join(root, ".htaccess"), "");
    expect(causes(true)).toEqual({
      wpconfig: false,
      htaccess: false,
      commandsUser: userInfo().username,
    });
  });

  test("wp-config.php unwritable in the root and absent above: wpconfig", () => {
    writeFileSync(join(root, "wp-config.php"), "<?php\n");
    chmodSync(join(root, "wp-config.php"), 0o444);
    expect(causes(false).wpconfig).toBe(true);
  });

  test("a writable one above counts, unless that folder is another install", () => {
    writeFileSync(join(dir, "wp-config.php"), "<?php\n");
    expect(causes(false).wpconfig).toBe(false);
    writeFileSync(join(dir, "wp-settings.php"), "<?php\n");
    expect(causes(false).wpconfig).toBe(true);
  });

  test(".htaccess counts only on Apache, missing or unwritable", () => {
    writeFileSync(join(root, "wp-config.php"), "<?php\n");
    expect(causes(false).htaccess).toBe(false);
    expect(causes(true).htaccess).toBe(true);
    writeFileSync(join(root, ".htaccess"), "");
    chmodSync(join(root, ".htaccess"), 0o444);
    expect(causes(true).htaccess).toBe(true);
  });
});
