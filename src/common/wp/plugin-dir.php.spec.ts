import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import { SAMPLE_SIZE, parsePluginDirReport, pluginDirPhp } from "./plugin-dir";
import type { PluginDirState } from "./plugin-dir";

/**
 * The inspection's PHP, run for real against real folders. WordPress is stood in for by what the
 * snippet uses of it: `ABSPATH`, `WP_PLUGIN_DIR`, `wp_json_encode`, and a `get_plugins()` that walks
 * the plugins folder as core's does (`wp-admin/includes/plugin.php`): a top-level `.php` file, or one
 * directly inside a top-level folder (followed through a link, as `is_dir` does), that holds a
 * `Plugin Name:` header; dot-names skipped. Skipped where PHP is not installed; the
 * snippet also runs live on every cell.
 */

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** Root ignores directory permissions, so an unreadable folder cannot be made. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** The stand-ins for the WordPress functions and constants the snippet uses. */
const HARNESS = `<?php
define( 'ABSPATH', $argv[1] . '/' );
define( 'WP_PLUGIN_DIR', $argv[2] );
function get_plugins( $folder = '' ) {
	$root = WP_PLUGIN_DIR . $folder;
	$files = [];
	foreach ( @scandir( $root ) ?: [] as $file ) {
		if ( '' === $file || '.' === $file[0] ) {
			continue;
		}
		if ( is_dir( "$root/$file" ) ) {
			foreach ( @scandir( "$root/$file" ) ?: [] as $sub ) {
				if ( '' !== $sub && '.' !== $sub[0] && '.php' === substr( $sub, -4 ) ) {
					$files[] = "$file/$sub";
				}
			}
		} elseif ( '.php' === substr( $file, -4 ) ) {
			$files[] = $file;
		}
	}
	$found = [];
	foreach ( $files as $file ) {
		if ( is_readable( "$root/$file" ) && false !== strpos( (string) file_get_contents( "$root/$file" ), 'Plugin Name:' ) ) {
			$found[ $file ] = [ 'Name' => $file ];
		}
	}
	return $found;
}
function wp_json_encode( $value ) {
	return json_encode( $value );
}
eval( file_get_contents( $argv[3] ) );
`;

let work: string;
let plugins: string;

test.beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "wp-plugin-dir-php-"));
  plugins = join(work, "root", "wp-content", "plugins");
  mkdirSync(plugins, { recursive: true });
  writeFileSync(join(work, "harness.php"), HARNESS);
});

test.afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Runs the snippet for `slugs` and parses its reply as the module does. */
function inspect(...slugs: string[]): ReadonlyMap<string, PluginDirState> {
  return inspectCapped(undefined, ...slugs);
}

/** {@link inspect}, counting at most `cap` entries. */
function inspectCapped(
  cap: number | undefined,
  ...slugs: string[]
): ReadonlyMap<string, PluginDirState> {
  writeFileSync(join(work, "snippet.php"), pluginDirPhp(slugs, cap));
  const result = spawnSync(
    "php",
    [
      join(work, "harness.php"),
      join(work, "root"),
      plugins,
      join(work, "snippet.php"),
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return parsePluginDirReport(result.stdout, slugs);
}

/** Writes a file, creating its folders. */
function put(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

test.describe("the inspection's PHP, under real PHP", () => {
  test.skip(!HAS_PHP, "no php binary here");

  test("tells nothing, a listed plugin and an orphaned folder apart, in one run", () => {
    put(
      join(plugins, "listed", "main.php"),
      "<?php\n/* Plugin Name: Listed */",
    );
    put(join(plugins, "listed", "vendor", "autoload.php"));
    put(join(plugins, "orphaned", "vendor", "berlindb", "Base.php"));
    put(join(plugins, "orphaned", "src", "a.php"));

    const states = inspect("gone", "listed", "orphaned");
    expect(states.get("gone")).toEqual({
      kind: "absent",
      path: join(plugins, "gone"),
    });
    expect(states.get("listed")).toMatchObject({
      kind: "recognised",
      type: "directory",
      entries: 3,
      topLevel: 2,
      sample: ["main.php", "vendor"],
    });
    expect(states.get("orphaned")).toMatchObject({
      kind: "orphaned",
      type: "directory",
      entries: 5,
      sample: ["src", "vendor"],
    });
    // Owned by whoever runs the spec, by name, and just written.
    const orphaned = states.get("orphaned");
    expect(orphaned?.kind === "orphaned" && orphaned.owner).toBe(
      userInfo().username,
    );
    expect(orphaned?.kind === "orphaned" && orphaned.ageSeconds).toBeLessThan(
      60,
    );
  });

  // WordPress lists only a header directly inside the folder; `get_plugins( '/<slug>' )` would also
  // find one a folder deeper, which `wp plugin is-installed` does not see either.
  test("does not take a plugin header one folder down for a plugin WordPress lists", () => {
    put(
      join(plugins, "deep", "vendor", "fake.php"),
      "<?php\n/* Plugin Name: Deep */",
    );
    put(join(plugins, "flatfile.php"), "<?php\n/* Plugin Name: Flat */");
    expect(inspect("deep").get("deep")).toMatchObject({ kind: "orphaned" });
  });

  test("counts up to the cap, and flags only a folder holding more", () => {
    for (const name of ["a", "b", "c"]) put(join(plugins, "three", name));
    const exact = inspectCapped(3, "three").get("three");
    expect(exact).toMatchObject({ entries: 3 });
    expect(exact).not.toHaveProperty("capped");
    put(join(plugins, "three", "d"));
    expect(inspectCapped(3, "three").get("three")).toMatchObject({
      entries: 3,
      capped: true,
    });
  });

  test("samples the first names in order, and counts them all", () => {
    for (let i = 0; i < SAMPLE_SIZE + 3; i += 1) {
      put(join(plugins, "many", `f${String(i).padStart(2, "0")}.txt`));
    }
    expect(inspect("many").get("many")).toMatchObject({
      kind: "orphaned",
      topLevel: SAMPLE_SIZE + 3,
      sample: Array.from(
        { length: SAMPLE_SIZE },
        (_, i) => `f${String(i).padStart(2, "0")}.txt`,
      ),
    });
  });

  test("sees a link as a link, never walking where it points", () => {
    put(
      join(work, "elsewhere", "main.php"),
      "<?php /* Plugin Name: Elsewhere */",
    );
    put(join(work, "elsewhere", "deep", "file.txt"));
    symlinkSync(join(work, "elsewhere"), join(plugins, "linked"));
    symlinkSync(join(work, "nowhere"), join(plugins, "dangling"));

    const states = inspect("linked", "dangling");
    // WordPress lists the plugin it leads to; its contents are not counted.
    expect(states.get("linked")).toEqual(
      expect.objectContaining({
        kind: "recognised",
        type: "link",
        target: join(work, "elsewhere"),
        sample: [],
      }),
    );
    expect(states.get("linked")).not.toHaveProperty("entries");
    expect(states.get("dangling")).toMatchObject({
      kind: "orphaned",
      type: "link",
      target: join(work, "nowhere"),
    });
  });

  test("reports a file at the slug as a file", () => {
    put(join(plugins, "flat"));
    expect(inspect("flat").get("flat")).toMatchObject({
      kind: "orphaned",
      type: "file",
      sample: [],
    });
  });

  test("reports an empty folder with no entries", () => {
    mkdirSync(join(plugins, "empty"));
    expect(inspect("empty").get("empty")).toMatchObject({
      kind: "orphaned",
      entries: 0,
      topLevel: 0,
    });
  });

  test("reports a folder it cannot read without a count, rather than failing", () => {
    test.skip(isRoot, "root ignores directory permissions");
    put(join(plugins, "locked", "a.txt"));
    chmodSync(join(plugins, "locked"), 0o000);
    try {
      const state = inspect("locked").get("locked");
      expect(state).toMatchObject({ kind: "orphaned", type: "directory" });
      expect(state).not.toHaveProperty("entries");
    } finally {
      chmodSync(join(plugins, "locked"), 0o755);
    }
  });

  test("keeps counting past a subfolder it cannot read", () => {
    test.skip(isRoot, "root ignores directory permissions");
    put(join(plugins, "partly", "open", "a.txt"));
    put(join(plugins, "partly", "shut", "b.txt"));
    chmodSync(join(plugins, "partly", "shut"), 0o000);
    try {
      // open, open/a.txt and shut itself; not what is inside shut.
      expect(inspect("partly").get("partly")).toMatchObject({ entries: 3 });
    } finally {
      chmodSync(join(plugins, "partly", "shut"), 0o755);
    }
  });
});
