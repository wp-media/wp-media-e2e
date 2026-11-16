import { escapeRegExp } from "../../../common/text";
import type { ScanDebugLogOptions } from "../../../common/wp/log";
import { WP_ROCKET_TABLES } from "./db-residue";

/**
 * Matches debug.log lines originating from WP Rocket's plugin directory. WordPress writes the
 * originating file path on PHP error lines, so this attributes an entry to the plugin.
 */
export const WP_ROCKET_PLUGIN_PATH = /wp-content\/plugins\/wp-rocket\//;

/**
 * WP Rocket's own race creating its tables: each first request after activation runs BerlinDB's
 * `AbstractTable::maybe_upgrade` on `init`, whose `CREATE TABLE` has no `IF NOT EXISTS`, so when two
 * overlap (activation's preload spawns WP-Cron beside the first admin request) the second fails with
 * MySQL's "already exists". Harmless: WordPress logs it and goes on, and the table is there. Matched
 * narrowly — the whole message, the same name twice, any table prefix (WordPress allows only
 * `[A-Za-z0-9_]`), one of WP Rocket's declared tables — so any other database error, or this one on
 * another table, stays a fatal.
 */
export const WP_ROCKET_TABLE_CREATE_RACE = new RegExp(
  "^\\[[^\\]]*\\] WordPress database error Table " +
    `'([A-Za-z0-9_]*)(${WP_ROCKET_TABLES.map(escapeRegExp).join("|")})' ` +
    "already exists for query CREATE TABLE \\1\\2 \\(",
);

/**
 * Default `scanDebugLog` options for WP Rocket runs. Scans EVERY source (core + all plugins),
 * so a fatal triggered anywhere still surfaces. Add patterns to `ignore` for lines confirmed
 * benign from real test runs — discovered from output, not guessed.
 *
 * @example
 * ```ts
 * const scan = await scanDebugLog(transport, WP_ROCKET_LOG_OPTIONS);
 * if (scan.fatals.length > 0) throw new Error(scan.fatals.join("\n"));
 * ```
 */
export const WP_ROCKET_LOG_OPTIONS: ScanDebugLogOptions = {
  ignore: [WP_ROCKET_TABLE_CREATE_RACE],
};

/**
 * Like {@link WP_ROCKET_LOG_OPTIONS} but restricted to WP Rocket's own entries (by plugin
 * path). Use when a step must assert specifically about WP Rocket and disregard unrelated
 * core/plugin noise.
 */
export const WP_ROCKET_OWN_LOG_OPTIONS: ScanDebugLogOptions = {
  ...WP_ROCKET_LOG_OPTIONS,
  source: [WP_ROCKET_PLUGIN_PATH],
};
