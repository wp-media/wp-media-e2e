import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import type { SpawnSyncReturns } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CRON_FIND_PHP, CRON_REMOVE_PHP, footprintScanPhp } from "./db-residue";
import type { CronEvent } from "./db-residue";
import { phpLiteral } from "./php-literal";

/**
 * The sweep's WP-Cron snippets run for real on this machine's PHP, against a cron option written as a
 * PHP literal. Core is stood in for with WordPress 7.1.3's semantics: `_get_cron_array()` (a
 * non-array option read as empty — or `false`, as before 6.1, when asked —, a versionless array
 * upgraded and written back, the `version` key dropped), `_set_cron_array()`, and
 * `wp_unschedule_hook()` walking every timestamp exactly as core does, so a malformed array crashes
 * it as it would a site. `WP_CLI::error` prints and exits 1, as WP-CLI does. The flow around the
 * snippets (scan, remove, re-read) is pinned in `db-residue.spec.ts`. Skipped where PHP is not
 * installed.
 */

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/**
 * The stand-ins: argv[1] the snippet, argv[2] a PHP file returning the `cron` option, argv[3] `1` to
 * answer as WordPress before 6.1. The snippet prints its own report.
 */
const HARNESS = `<?php
$e2e_cron        = include $argv[2];
$e2e_legacy      = '1' === ( $argv[3] ?? '' );
$e2e_unscheduled = [];
class WP_CLI {
  public static function error( $message ) {
    fwrite( STDERR, "Error: $message\\n" );
    exit( 1 );
  }
}
function _get_cron_array() {
  global $e2e_cron, $e2e_legacy;
  if ( ! is_array( $e2e_cron ) ) {
    return $e2e_legacy ? false : [];
  }
  $cron = isset( $e2e_cron['version'] ) ? $e2e_cron : _upgrade_cron_array( $e2e_cron );
  unset( $cron['version'] );
  return $cron;
}
function _upgrade_cron_array( $cron ) {
  global $e2e_cron;
  $new_cron = [];
  foreach ( (array) $cron as $timestamp => $hooks ) {
    foreach ( (array) $hooks as $hook => $args ) {
      $new_cron[ $timestamp ][ $hook ][ md5( serialize( $args['args'] ?? [] ) ) ] = $args;
    }
  }
  $new_cron['version'] = 2;
  $e2e_cron            = $new_cron;
  return $new_cron;
}
function _set_cron_array( $cron ) {
  global $e2e_cron;
  $cron['version'] = 2;
  $e2e_cron        = $cron;
  return true;
}
function wp_json_encode( $data ) {
  return json_encode( $data );
}
function wp_unschedule_hook( $hook ) {
  global $e2e_unscheduled;
  $e2e_unscheduled[] = $hook;
  $crons = _get_cron_array();
  if ( empty( $crons ) ) {
    return 0;
  }
  $results = [];
  foreach ( $crons as $timestamp => $args ) {
    if ( ! empty( $crons[ $timestamp ][ $hook ] ) ) {
      $results[] = count( $crons[ $timestamp ][ $hook ] );
    }
    unset( $crons[ $timestamp ][ $hook ] );
    if ( empty( $crons[ $timestamp ] ) ) {
      unset( $crons[ $timestamp ] );
    }
  }
  if ( empty( $results ) ) {
    return 0;
  }
  _set_cron_array( $crons );
  return array_sum( $results );
}
eval( file_get_contents( $argv[1] ) );
`;

/**
 * Prints what the cron snippets left: the events found, the hooks unscheduled, the option. Partial
 * output, so an option planting arguments that do not encode still gets the rest back.
 */
const CRON_REPORT = `
echo json_encode( [ 'events' => $cron_events, 'unscheduled' => $e2e_unscheduled, 'left' => $e2e_cron ], JSON_PARTIAL_OUTPUT_ON_ERROR );
`;

/**
 * A `$wpdb` and the core function the full scan calls before its cron part: a single site with no
 * matching option, table or role.
 */
const SCAN_STANDINS = `
class E2E_Wpdb {
  public $prefix  = 'wp_';
  public $options = 'wp_options';
  public function prepare( $query, ...$args ) { return $query; }
  public function esc_like( $text ) { return $text; }
  public function get_col( $query ) { return []; }
  public function get_var( $query ) { return null; }
}
$wpdb = new E2E_Wpdb();
function is_multisite() { return false; }
`;

/** What one cron run printed. */
interface CronRun {
  readonly events: CronEvent[];
  readonly unscheduled: string[];
  readonly left: unknown;
}

let work: string;

test.beforeEach(() => {
  test.skip(!HAS_PHP, "no php binary here");
  work = mkdtempSync(join(tmpdir(), "wp-dbres-cron-php-"));
  writeFileSync(join(work, "harness.php"), HARNESS);
});

test.afterEach(() => {
  if (HAS_PHP) rmSync(work, { recursive: true, force: true });
});

/**
 * Runs a snippet in the harness against a `cron` option.
 *
 * @param snippet - the PHP to evaluate.
 * @param cron - the option's value, as PHP source.
 * @param legacy - answer a missing option as WordPress before 6.1 does (`false`).
 * @returns the process's result.
 */
function runPhp(
  snippet: string,
  cron: string,
  legacy = false,
): SpawnSyncReturns<string> {
  writeFileSync(join(work, "cron.php"), `<?php return ${cron};`);
  writeFileSync(join(work, "snippet.php"), snippet);
  return spawnSync(
    "php",
    [
      join(work, "harness.php"),
      join(work, "snippet.php"),
      join(work, "cron.php"),
      legacy ? "1" : "0",
    ],
    { encoding: "utf8" },
  );
}

/**
 * The cron snippets as the sweep embeds them: the declaration, the find, the removal when asked.
 *
 * @param hooks - the declared hooks.
 * @param remove - whether to run the removal snippet after the find.
 * @returns the snippet.
 */
function cronSnippet(hooks: string[], remove: boolean): string {
  return `$declared_hooks = ${phpLiteral(hooks)};\n${CRON_FIND_PHP}${remove ? CRON_REMOVE_PHP : ""}`;
}

/**
 * Runs the find snippet, and the removal after it when asked, and expects a clean run.
 *
 * @param hooks - the declared hooks.
 * @param cron - the `cron` option, as PHP source.
 * @param remove - whether to run the removal snippet after the find.
 * @param legacy - answer a missing option as WordPress before 6.1 does.
 * @returns what the snippets left.
 */
function runCron(
  hooks: string[],
  cron: string,
  remove = false,
  legacy = false,
): CronRun {
  const run = runPhp(cronSnippet(hooks, remove) + CRON_REPORT, cron, legacy);
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
  return JSON.parse(run.stdout) as CronRun;
}

/** A site's cron option: core's, a job's two events, the plugin's cleanup, another plugin's. */
const SITE_CRON = `[
  200 => [
    'myplugin_cron' => [
      'k1' => [ 'schedule' => false, 'args' => [ 'arg' => 4 ] ],
      'k2' => [ 'schedule' => false, 'args' => [ 'arg' => 'restart' ] ],
    ],
    'wp_version_check' => [ 'k3' => [ 'schedule' => 'twicedaily', 'args' => [], 'interval' => 43200 ] ],
  ],
  100 => [
    'myplugin_cron'    => [ 'k4' => [ 'schedule' => false, 'args' => [ 'arg' => 2 ] ] ],
    'myplugin_cleanup' => [ 'k5' => [ 'schedule' => 'twicedaily', 'args' => [], 'interval' => 43200 ] ],
    'other_cron'       => [ 'k6' => [ 'schedule' => false, 'args' => [ 'x', 1 ] ] ],
  ],
  'version' => 2,
]`;

/** The message a malformed cron option is refused with, before anything is removed. */
const MALFORMED =
  /^Error: the site's WP-Cron array \(the cron option\) is malformed: .*removed nothing/;

test.describe("CRON_FIND_PHP", () => {
  test("finds every event of each declared hook, whatever its arguments, in hook, time, args order", () => {
    expect(
      runCron(["myplugin_cron", "myplugin_cleanup"], SITE_CRON).events,
    ).toEqual([
      { hook: "myplugin_cleanup", time: 100, args: "[]" },
      { hook: "myplugin_cron", time: 100, args: '{"arg":2}' },
      { hook: "myplugin_cron", time: 200, args: '{"arg":"restart"}' },
      { hook: "myplugin_cron", time: 200, args: '{"arg":4}' },
    ]);
  });

  test("reports a list, an empty and a missing argument set as JSON", () => {
    const cron = `[ 5 => [ 'myplugin_cron' => [
      'a' => [ 'schedule' => false, 'args' => [ 'x', 1 ] ],
      'b' => [ 'schedule' => false, 'args' => [] ],
      'c' => [ 'schedule' => false ],
    ] ], 'version' => 2 ]`;
    expect(
      runCron(["myplugin_cron"], cron).events.map((event) => event.args),
    ).toEqual(['["x",1]', "[]", "[]"]);
  });

  // An event must never read as clean because its arguments do not encode: it is reported anyway.
  // INF fails `json_encode` and WordPress's `wp_json_encode` alike (invalid UTF-8 would not: core
  // repairs it).
  test("reports an event whose arguments PHP cannot encode", () => {
    const cron = `[ 5 => [ 'myplugin_cron' => [ 'a' => [ 'schedule' => false, 'args' => [ INF ] ] ] ], 'version' => 2 ]`;
    expect(runCron(["myplugin_cron"], cron).events).toEqual([
      { hook: "myplugin_cron", time: 5, args: "(not encodable)" },
    ]);
  });

  // Read through `_get_cron_array()`, which upgrades a versionless (pre-2.1) array as the cron runner
  // sees it; a raw read would take `schedule` and `args` for two events.
  test("reads a versionless array as WordPress upgrades it", () => {
    const cron = `[ 5 => [ 'myplugin_cron' => [ 'schedule' => false, 'args' => [ 'arg' => 4 ] ] ] ]`;
    expect(runCron(["myplugin_cron"], cron).events).toEqual([
      { hook: "myplugin_cron", time: 5, args: '{"arg":4}' },
    ]);
  });

  test("finds nothing for a hook with no event, an empty array, or no hooks declared", () => {
    expect(runCron(["myplugin_gone"], SITE_CRON).events).toEqual([]);
    expect(runCron(["myplugin_cron"], "[ 'version' => 2 ]").events).toEqual([]);
    expect(runCron(["myplugin_cron"], "false").events).toEqual([]);
    expect(runCron([], SITE_CRON).events).toEqual([]);
  });

  // Before WordPress 6.1, `_get_cron_array()` answers false for a missing option; iterating it would
  // print a warning into the JSON reply and fail the whole sweep.
  test("finds nothing on a WordPress older than 6.1 with no cron option", () => {
    expect(runCron(["myplugin_cron"], "false", false, true).events).toEqual([]);
  });

  // `wp_unschedule_hook` walks every timestamp and crashes on one holding no list of hooks — after
  // the options, tables and roles were already removed. Refused by the find, before any removal.
  test("refuses a timestamp holding no list of hooks when there is an event to remove", () => {
    const cron = `[ 5 => 'garbage', 6 => [ 'myplugin_cron' => [ 'k' => [ 'schedule' => false, 'args' => [ 'arg' => 4 ] ] ] ], 'version' => 2 ]`;
    const run = runPhp(cronSnippet(["myplugin_cron"], true), cron);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(MALFORMED);
    expect(run.stderr).toContain("1 timestamp(s) hold no list of hooks");
    expect(run.stderr).not.toContain("garbage");
    expect(run.stdout).toBe("");
  });

  test("refuses a declared hook whose entry holds no list of events", () => {
    const cron = `[ 6 => [ 'myplugin_cron' => 'x' ], 'version' => 2 ]`;
    const run = runPhp(cronSnippet(["myplugin_cron"], true), cron);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(MALFORMED);
    expect(run.stderr).toContain(
      "the entry of myplugin_cron holds no list of events",
    );
    expect(run.stdout).toBe("");
  });

  // Nothing would be removed, so nothing can crash: a site's own malformed entry is not the sweep's.
  test("ignores a malformed timestamp when no declared hook has an event", () => {
    const cron = `[ 5 => 'garbage', 6 => [ 'other_cron' => 'x' ], 'version' => 2 ]`;
    expect(runCron(["myplugin_cron"], cron, true)).toEqual({
      events: [],
      unscheduled: [],
      left: { "5": "garbage", "6": { other_cron: "x" }, version: 2 },
    });
  });
});

test.describe("CRON_REMOVE_PHP", () => {
  test("unschedules each found hook once and leaves every other hook", () => {
    const run = runCron(["myplugin_cron", "myplugin_cleanup"], SITE_CRON, true);
    expect(run.unscheduled).toEqual(["myplugin_cleanup", "myplugin_cron"]);
    expect(run.left).toEqual({
      "100": {
        other_cron: { k6: { schedule: false, args: ["x", 1] } },
      },
      "200": {
        wp_version_check: {
          k3: { schedule: "twicedaily", args: [], interval: 43200 },
        },
      },
      version: 2,
    });
  });

  // A clean site costs no write: a declared hook with no event is never unscheduled.
  test("unschedules nothing when no declared hook has an event", () => {
    expect(runCron(["myplugin_gone"], SITE_CRON, true).unscheduled).toEqual([]);
  });
});

test.describe("footprintScanPhp", () => {
  // The reply's `cronEvents` must come from the snippet the sweep sends, not from this spec's own
  // report: run the whole scan and parse what it printed.
  test("reports the WP-Cron events it found beside the other kinds", () => {
    const run = runPhp(
      SCAN_STANDINS +
        footprintScanPhp({
          optionsContaining: ["myplugin"],
          cronHooks: ["myplugin_cleanup"],
        }),
      SITE_CRON,
    );
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      prefix: "wp_",
      options: [],
      tables: [],
      roles: [],
      capabilities: [],
      cronEvents: [{ hook: "myplugin_cleanup", time: 100, args: "[]" }],
    });
  });
});
