import { test, expect } from "@playwright/test";

import { WP_ROCKET_TABLES } from "./db-residue";
import {
  WP_ROCKET_LOG_OPTIONS,
  WP_ROCKET_OWN_LOG_OPTIONS,
  WP_ROCKET_TABLE_CREATE_RACE,
} from "./debug-log";
import type { ScanDebugLogOptions } from "../../../common/wp/log";

/** The first line WordPress writes for a failed `CREATE TABLE`, as measured on a twin. */
function raceLine(table: string, queried = table): string {
  return (
    `[16-Nov-2026 15:58:01 UTC] WordPress database error Table '${table}' already exists ` +
    `for query CREATE TABLE ${queried} (`
  );
}

/** Whether a preset's `ignore` drops `line` (what `scanDebugLog` does before classifying it). */
function ignores(options: ScanDebugLogOptions, line: string): boolean {
  return (options.ignore ?? []).some((pattern) => pattern.test(line));
}

test.describe("WP Rocket's debug-log presets", () => {
  test("ignore the table-creation race on each of WP Rocket's tables, with any prefix", () => {
    expect(
      ignores(WP_ROCKET_LOG_OPTIONS, raceLine("wp_wpr_performance_monitoring")),
    ).toBe(true);
    for (const prefix of ["wp_", "site2_", "WP_7_", "x"]) {
      for (const table of WP_ROCKET_TABLES) {
        const name = `${prefix}${table}`;
        expect(ignores(WP_ROCKET_LOG_OPTIONS, raceLine(name)), name).toBe(true);
      }
    }
  });

  test("the owner-only preset carries the same ignore", () => {
    expect(
      ignores(WP_ROCKET_OWN_LOG_OPTIONS, raceLine("wp_wpr_rocket_cache")),
    ).toBe(true);
  });

  test("keep the same error on a table WP Rocket does not declare", () => {
    for (const name of [
      "wp_posts",
      "wp_wpr_google_maps", // another plugin's `wpr_` table
      "wp_wpr_rocket_cache_extra", // a declared name as a prefix only
      "wp_actionscheduler_actions",
    ]) {
      expect(ignores(WP_ROCKET_LOG_OPTIONS, raceLine(name)), name).toBe(false);
    }
  });

  test("keep any other database error on WP Rocket's tables", () => {
    for (const line of [
      "[16-Nov-2026 15:58:01 UTC] WordPress database error Table 'wp_wpr_rocket_cache' doesn't exist for query SELECT * FROM wp_wpr_rocket_cache",
      "[16-Nov-2026 15:58:01 UTC] WordPress database error Duplicate column name 'url' for query ALTER TABLE wp_wpr_rocket_cache ADD url varchar(2000)",
      "[16-Nov-2026 15:58:01 UTC] WordPress database error Table 'wp_wpr_rocket_cache' already exists for query RENAME TABLE wp_tmp TO wp_wpr_rocket_cache",
    ]) {
      expect(ignores(WP_ROCKET_LOG_OPTIONS, line), line).toBe(false);
    }
  });

  test("keep the message when the query creates another table than the one named", () => {
    expect(
      ignores(
        WP_ROCKET_LOG_OPTIONS,
        raceLine("wp_wpr_rocket_cache", "wp_wpr_rocket_cdn"),
      ),
    ).toBe(false);
    expect(
      ignores(
        WP_ROCKET_LOG_OPTIONS,
        raceLine("wp_wpr_rocket_cache", "wp_posts"),
      ),
    ).toBe(false);
  });

  test("keep the message quoted inside another entry, or a fatal naming it", () => {
    for (const line of [
      `[16-Nov-2026 15:58:01 UTC] PHP Fatal error:  Uncaught Exception: ${raceLine("wp_wpr_rocket_cache")}`,
      raceLine("wp_wpr_rocket_cache").replace(/^\[[^\]]*\] /, "x "),
    ]) {
      expect(ignores(WP_ROCKET_LOG_OPTIONS, line), line).toBe(false);
    }
  });

  test("the race pattern holds no state between tests (no global flag)", () => {
    expect(WP_ROCKET_TABLE_CREATE_RACE.flags).not.toContain("g");
  });
});
