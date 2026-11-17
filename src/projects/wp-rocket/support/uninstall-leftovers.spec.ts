import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LEFTOVERS_PHP, parseLeftovers } from "./uninstall-leftovers";
import { WP_ROCKET_SITE_RESIDUE, WP_ROCKET_UNINSTALL_REMOVES } from "./residue";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";

/** Whether a `php` binary can run here (the snippet's own test is skipped without one). */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("WP_ROCKET_UNINSTALL_REMOVES", () => {
  test("is the residue minus the licence, the uninstall's own folders", () => {
    expect(WP_ROCKET_UNINSTALL_REMOVES).toContain("wp-content/cache/wp-rocket");
    expect(WP_ROCKET_UNINSTALL_REMOVES).toContain(
      "wp-content/wp-rocket-config",
    );
    expect(WP_ROCKET_UNINSTALL_REMOVES).not.toContain("wp-content/cache");
    const residue = WP_ROCKET_SITE_RESIDUE.map((entry) =>
      typeof entry === "string"
        ? entry
        : "path" in entry
          ? entry.path
          : entry.parent,
    );
    for (const path of WP_ROCKET_UNINSTALL_REMOVES)
      expect(residue).toContain(path);
  });
});

test.describe("parseLeftovers", () => {
  const asked = ["a", "b", "c"];

  test("keeps the order asked", () => {
    expect(parseLeftovers('["c","a"]', asked)).toEqual(["a", "c"]);
    expect(parseLeftovers("[]", asked)).toEqual([]);
  });

  test("refuses a reply that is not a list of paths", () => {
    for (const reply of ["", "{}", "[1]", "null", "oops"]) {
      expect(() => parseLeftovers(reply, asked), reply).toThrow(
        /not a list of paths/,
      );
    }
  });

  test("refuses a path never asked about", () => {
    expect(() => parseLeftovers('["a","z"]', asked)).toThrow(
      /never asked about: z/,
    );
  });
});

test.describe("LEFTOVERS_PHP", () => {
  test.skip(!HAS_PHP, "php is not installed");

  test("names what exists under ABSPATH, a dangling link included", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-leftovers-"));
    try {
      mkdirSync(join(dir, "kept"));
      symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
      const result = spawnSync(
        "php",
        [
          "-r",
          `define( 'ABSPATH', ${JSON.stringify(`${dir}/`)} ); ` +
            "function wp_json_encode( $v ) { return json_encode( $v ); } " +
            `$paths = ["kept", "gone", "dangling"]; ${LEFTOVERS_PHP}`,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      expect(
        parseLeftovers(result.stdout, ["kept", "gone", "dangling"]),
      ).toEqual(["kept", "dangling"]);
    } finally {
      removeTempDir(dir);
    }
  });
});
