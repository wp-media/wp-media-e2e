import type {
  ConfigEditOperation,
  ConfigEditStep,
  ConfigEdits,
} from "../../../common/config/types";

/**
 * What WP Rocket edits in place, as its own code does it (`ProductConfig.configEdits`), read from
 * 3.24.1 (APVM) — the patterns are copied verbatim, so the site's PHP replays them byte for byte:
 *
 * - `wp-config.php` — `WPCache::set_wp_cache_constant()` (`inc/Engine/Cache/WPCache.php:125-166`):
 *   finds `WP_CACHE` with {@link FIND_WP_CACHE} (`:147`); returns at once when its value already is the
 *   one to set (`:149-155`); else, absent, inserts after the first `<?php` (case-insensitive, so
 *   `<?PHP` becomes `<?php`) with CRLF (`:160`), or, set to another value, replaces **every** match of
 *   {@link REPLACE_WP_CACHE} (`:162`: `^\s*` eats blank lines before it, `.+` a trailing `\r`). The
 *   line is `get_wp_cache_content()` (`:314-318`) with `WP_ROCKET_PLUGIN_NAME` = `WP Rocket`
 *   (`inc/main.php:54-55`): a white-labelled name makes every candidate miss, and the file is warned
 *   about, never touched. Run on activation (`true`) and deactivation (`false`), as `update_wp_cache`
 *   (`:53-68`). Its write is `put_contents(…, rocket_get_filesystem_perms('file'))`
 *   (`inc/functions/files.php:1333-1373`), so the mode may change: the engine sets it back.
 *   Also `Logger::define_debug()` (`inc/Logger/Logger.php:584-622`), run when WP Rocket's settings are
 *   saved by a POST (`inc/classes/admin/class-logs.php:49-60`): every `WP_ROCKET_DEBUG` line made a
 *   placeholder ({@link DEBUG_LINE}), each placeholder after a newline dropped, and — enabling — the
 *   line inserted after the first `<?php` and its whitespace. Its patterns' `@` delimiters are written
 *   `/` (none holds a `/`); its guard (`debug_enabled()`, the runtime constant, which a file cannot
 *   tell) is not replayed: a guarded no-op is a shorter chain, so every text it makes is a candidate.
 * - `.htaccess` (Apache, web requests only: `flush_rocket_htaccess`, `inc/functions/htaccess.php:15-162`,
 *   returns at once unless `$is_apache`, never under WP-CLI) — reads lines with `fgets`, each
 *   `rtrim`med of `"\r\n"` (`:76-78`), and re-joins with `"\n"`: a CRLF file comes back LF. Markers
 *   `# BEGIN WP Rocket` / `# END WP Rocket` (`:63-64`), matched anywhere in a line (`str_contains`).
 *   No block: `[start, rules…, end, every line]` (`:111-121`) — the block **first**, even when removing
 *   (its rules then one empty line). A block, adding: replaced in place (`:131-142`); removing: dropped
 *   (`:122-130`). The rules come from settings (`get_rocket_htaccess_marker`, `:211-251`), so they are
 *   read from the file as the scenario left it ({@link BLOCK}).
 *   Not replayed (the file is then warned about, never touched): an end marker before the start
 *   (WP Rocket drops it), a start with no end, and its "no change" exit (`:105-110`), which keeps CRLF
 *   when the rules already match.
 * - `advanced-cache.php` — written from `views/cache/advanced-cache.php` (defines
 *   `WP_ROCKET_ADVANCED_CACHE`, `:9`), emptied on deactivation (`AdvancedCache::update_advanced_cache`,
 *   `inc/Engine/Cache/AdvancedCache.php:74-101`), never deleted by the uninstall.
 * - `wp-content/cache` — the parent of its cache folders, which the uninstall empties
 *   (`WPRocketUninstall`) but keeps.
 *
 * A `wp-config.php` one level above the root (which `find_wpconfig_path()`, `:203-235`, also edits)
 * is outside what this tracks; so is an `.htaccess` WordPress's `get_home_path()` puts elsewhere.
 */

/** `WPCache.php:147`: where `WP_CACHE` is set, and to what (`value`). */
export const FIND_WP_CACHE = String.raw`/^\s*define\(\s*'WP_CACHE'\s*,\s*(?<value>[^\s\)]*)\s*\)/m`;

/** `WPCache.php:162`: the line(s) a new value replaces, no limit. */
export const REPLACE_WP_CACHE = String.raw`/^\s*define\(\s*'WP_CACHE'\s*,\s*([^\s\)]*)\s*\).+/m`;

/** `WPCache.php:160`: the opening tag the line is inserted after, once. */
const OPENING_TAG = String.raw`/(<\?php)/i`;

/** `WPCache.php:318`: the line WP Rocket writes for `value`. */
export function wpCacheLine(value: "true" | "false"): string {
  return `define( 'WP_CACHE', ${value} ); // Added by WP Rocket`;
}

/** `set_wp_cache_constant(value)`: insert when absent, replace when set to another value. */
function setWpCache(value: "true" | "false"): ConfigEditOperation {
  return {
    name: `set WP_CACHE ${value}`,
    steps: [
      {
        pattern: OPENING_TAG,
        replacement: `<?php\r\n${wpCacheLine(value)}\r\n`,
        limit: 1,
        when: { kind: "lacks", pattern: FIND_WP_CACHE },
      },
      {
        pattern: REPLACE_WP_CACHE,
        replacement: wpCacheLine(value),
        limit: -1,
        when: {
          kind: "differs",
          pattern: FIND_WP_CACHE,
          group: "value",
          value,
        },
      },
    ],
  };
}

/** `Logger.php:614`: every `WP_ROCKET_DEBUG` line, made {@link DEBUG_PLACEHOLDER}. */
export const DEBUG_LINE = String.raw`/^[\t ]*define\s*\(\s*["']WP_ROCKET_DEBUG["'].*$/miU`;

/** `Logger.php:613`. */
const DEBUG_PLACEHOLDER = "## WP_ROCKET_DEBUG placeholder ##";

/** `Logger.php:619`: the line `enable_debug()` writes. */
export const DEBUG_DEFINE =
  "define( 'WP_ROCKET_DEBUG', true ); // Added by WP Rocket.\r\n";

/** `Logger::define_debug(enable)`: earlier lines dropped, then — enabling — the line put in. */
function defineDebug(enable: boolean): ConfigEditOperation {
  return {
    name: `${enable ? "enable" : "disable"} WP_ROCKET_DEBUG`,
    steps: [
      { pattern: DEBUG_LINE, replacement: DEBUG_PLACEHOLDER, limit: -1 },
      // `:615`: PHP's `"@\n$placeholder@"`, a real newline in the pattern.
      {
        pattern: `/\n${DEBUG_PLACEHOLDER}/`,
        replacement: "",
        limit: -1,
      },
      ...(enable
        ? [
            {
              // `:620`.
              pattern: String.raw`/<\?php\s*/i`,
              replacement: `<?php\n${DEBUG_DEFINE}`,
              limit: 1,
            },
          ]
        : []),
    ],
  };
}

/** `htaccess.php:63`. */
const START = "# BEGIN WP Rocket";
/** `htaccess.php:64`. */
const END = "# END WP Rocket";

/** Whether a line holds the start marker (`str_contains` on a line). */
const HAS_START = String.raw`/^[^\n]*# BEGIN WP Rocket/m`;

/** The block from the start marker's line to the next line holding the end marker. */
const BLOCK_LINES = String.raw`^[^\n]*# BEGIN WP Rocket[^\n]*\n(?:[^\n]*\n)*?[^\n]*# END WP Rocket[^\n]*`;

/**
 * The rules between the markers as WP Rocket wrote them (exact marker lines, LF): `implode("\n",
 * rules) . "\n"`, which is what sits between `START\n` and `END`.
 */
export const BLOCK = String.raw`/^# BEGIN WP Rocket\n((?:(?![^\n]*# END WP Rocket)[^\n]*\n)*)# END WP Rocket$/m`;

/** Every line `rtrim`med of `\r` (its `\n` is the split): the `fgets` + re-join with `"\n"`. */
const REJOIN: ConfigEditStep = {
  pattern: String.raw`/\r+$/m`,
  replacement: "",
  limit: -1,
};

/** `flush_rocket_htaccess(false)`: the rules (read from the file) put in. */
const ADD_RULES: ConfigEditOperation = {
  name: "add rules",
  steps: [
    REJOIN,
    {
      pattern: String.raw`/\A/`,
      replacement: `${START}\n{{block}}${END}\n`,
      limit: 1,
      when: { kind: "lacks", pattern: HAS_START },
    },
    {
      pattern: `/${BLOCK_LINES}$/m`,
      replacement: `${START}\n{{block}}${END}`,
      limit: 1,
      when: { kind: "matches", pattern: HAS_START },
    },
  ],
};

/** `flush_rocket_htaccess(true)`: the block dropped — or, with none, an empty one put first. */
const REMOVE_RULES: ConfigEditOperation = {
  name: "remove rules",
  steps: [
    REJOIN,
    {
      pattern: String.raw`/\A/`,
      replacement: `${START}\n\n${END}\n`,
      limit: 1,
      when: { kind: "lacks", pattern: HAS_START },
    },
    {
      // Followed by a line: the block and its newline; last: the newline before it and the block.
      pattern: `/${BLOCK_LINES}\n|\n?${BLOCK_LINES}\\z/m`,
      replacement: "",
      limit: 1,
      when: { kind: "matches", pattern: HAS_START },
    },
  ],
};

/** WP Rocket's `ProductConfig.configEdits` — see the module doc. */
export const WP_ROCKET_CONFIG_EDITS: ConfigEdits = {
  files: [
    {
      path: "wp-config.php",
      operations: [
        setWpCache("true"),
        setWpCache("false"),
        defineDebug(true),
        defineDebug(false),
      ],
    },
    {
      path: ".htaccess",
      operations: [ADD_RULES, REMOVE_RULES],
      captures: [{ name: "block", pattern: BLOCK, group: "1" }],
    },
  ],
  createdFiles: [
    {
      path: "wp-content/advanced-cache.php",
      marks: ["WP_ROCKET_ADVANCED_CACHE"],
    },
  ],
  createdDirs: ["wp-content/cache"],
};
