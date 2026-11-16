import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { WP_ROCKET_CONFIG_EDITS } from "./config-edits";
import { normaliseConfigEdits } from "../../../common/wp/config-edits-declaration";
import {
  engineSandbox,
  HAS_PHP,
  runEngine,
} from "../../../common/__fixtures__/config-edits-engine";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import type { EngineSandbox } from "../../../common/__fixtures__/config-edits-engine";

/**
 * WP Rocket's declared edits pinned against its own code: each file is recorded by the shared
 * engine, edited by WP Rocket's verbatim functions (`__fixtures__/wp-rocket-edits-harness.php`) in
 * every order a lifecycle produces, then restored — it must come back byte for byte, in place. A
 * third party's edit on top must be left alone. Skipped where PHP is not installed (CI runners have
 * it); the twin spec runs the same on real WordPress.
 */

const WP_ROCKET_HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "wp-rocket-edits-harness.php",
);

/** As the registry holds it. */
const EDITS = normaliseConfigEdits(WP_ROCKET_CONFIG_EDITS, "wp-rocket");

/** `wp-config.php` as sites have it, and as earlier runs left it. */
const CONFIGS: Readonly<Record<string, string>> = {
  lf: "<?php\n$table_prefix = 'wp_';\nrequire_once ABSPATH . 'wp-settings.php';\n",
  crlf: "<?php\r\n$table_prefix = 'wp_';\r\nrequire_once ABSPATH . 'wp-settings.php';\r\n",
  "no trailing newline": "<?php\n$table_prefix = 'wp_';",
  "<?PHP": "<?PHP\n$table_prefix = 'wp_';\n",
  "blank lines before an earlier run's WP_CACHE":
    "<?php\n\n\n  define( 'WP_CACHE', false ); // Added by WP Rocket\r\n$x = 1;\n",
  "a third party's WP_CACHE true":
    "<?php\ndefine('WP_CACHE', true);\n$x = 1;\n",
  "two WP_CACHE lines":
    "<?php\ndefine( 'WP_CACHE', false ); // one\r\n$x = 1;\ndefine('WP_CACHE',false);  // two\n",
  "WP_CACHE set to 0": "<?php\ndefine( 'WP_CACHE', 0 );\n",
  "an earlier run's WP_ROCKET_DEBUG":
    "<?php\ndefine( 'WP_ROCKET_DEBUG', true ); // Added by WP Rocket.\r\n$x = 1;\n",
  "a third party's WP_ROCKET_DEBUG, indented":
    '<?php\n$x = 1;\n\t define("WP_ROCKET_DEBUG", true);\n',
};

/**
 * What a lifecycle does to `wp-config.php`: activation, deactivation, a part-way reinstall, and debug
 * mode switched by a settings save.
 */
const CONFIG_SEQUENCES: readonly (readonly string[])[] = [
  ["wp-cache:true"],
  ["wp-cache:true", "wp-cache:false"],
  ["wp-cache:false"],
  ["wp-cache:true", "wp-cache:false", "wp-cache:true", "wp-cache:false"],
  ["debug:true"],
  ["debug:false"],
  ["debug:true", "debug:false"],
  ["wp-cache:true", "debug:true", "debug:false", "wp-cache:false"],
];

/** `.htaccess` as sites have it; `undefined`: none. */
const HTACCESS: Readonly<Record<string, string | undefined>> = {
  lf: "# BEGIN WordPress\nRewriteEngine On\n# END WordPress\n",
  crlf: "# BEGIN WordPress\r\nRewriteEngine On\r\n# END WordPress\r\n",
  "no trailing newline": "Options -Indexes\nRewriteEngine On",
  empty: "",
  absent: undefined,
  "an earlier block in the middle":
    "# BEGIN WordPress\n# END WordPress\n# BEGIN WP Rocket\nold rules\n# END WP Rocket\r\nlast\n",
  "an earlier block last": "first\n\n# BEGIN WP Rocket\nold\n# END WP Rocket",
};

/**
 * What requests do to `.htaccess`: the settling request adds the rules (never removed under WP-CLI),
 * a wp-admin deactivation removes them, a later request adds them again.
 */
const HTACCESS_SEQUENCES: readonly (readonly string[])[] = [
  ["htaccess:add"],
  ["htaccess:add", "htaccess:remove"],
  ["htaccess:remove"],
  ["htaccess:add", "htaccess:add"],
  ["htaccess:add", "htaccess:remove", "htaccess:add"],
];

let sandbox: EngineSandbox;

test.beforeEach(() => {
  sandbox = engineSandbox();
});

test.afterEach(() => {
  removeTempDir(sandbox.base);
});

/** Applies WP Rocket's own edits to the sandbox's files. */
function wpRocket(operations: readonly string[]): void {
  const run = spawnSync(
    "php",
    [WP_ROCKET_HARNESS, sandbox.root, ...operations],
    {
      encoding: "utf8",
    },
  );
  expect(run.stderr).toBe("");
  expect(run.status).toBe(0);
}

/** Records, runs `operations`, restores; returns the restore's outcome for file `index`. */
function lifecycle(operations: readonly string[], index: number): string {
  const recorded = runEngine(sandbox, "record", EDITS);
  expect(recorded.stdout).toMatch(/"reconciled":null/);
  expect(recorded.status).toBe(0);
  wpRocket(operations);
  const restored = runEngine(sandbox, "restore", EDITS);
  expect(restored.status, restored.stdout).toBe(0);
  expect(existsSync(sandbox.recordDir)).toBe(false);
  const outcomes = (
    JSON.parse(restored.stdout) as {
      outcomes: { kind: string; index: number; result: string }[];
    }
  ).outcomes;
  return (
    outcomes.find((o) => o.kind === "file" && o.index === index)?.result ?? ""
  );
}

/** Writes a sandbox file, or makes sure it is absent. */
function put(name: string, content: string | undefined): string {
  const path = join(sandbox.root, name);
  if (content !== undefined) writeFileSync(path, content);
  return path;
}

test.describe("WP Rocket's edits undone by the engine", () => {
  test.skip(!HAS_PHP, "PHP is not installed here");

  for (const [name, original] of Object.entries(CONFIGS)) {
    test(`wp-config.php (${name}) comes back byte for byte, same inode, after every lifecycle`, () => {
      for (const operations of CONFIG_SEQUENCES) {
        const path = put("wp-config.php", original);
        const inode = statSync(path).ino;
        const result = lifecycle(operations, 0);
        expect(["restored", "unchanged"], operations.join(" ")).toContain(
          result,
        );
        expect(readFileSync(path, "utf8"), operations.join(" ")).toBe(original);
        expect(statSync(path).ino).toBe(inode);
      }
    });
  }

  for (const [name, original] of Object.entries(HTACCESS)) {
    test(`.htaccess (${name}) comes back byte for byte after every lifecycle`, () => {
      for (const operations of HTACCESS_SEQUENCES) {
        const path = put(".htaccess", original);
        const result = lifecycle(operations, 1);
        const label = operations.join(" ");
        if (original === undefined) {
          expect(["removed", "unchanged"], label).toContain(result);
          expect(existsSync(path), label).toBe(false);
        } else {
          expect(["restored", "unchanged"], label).toContain(result);
          expect(readFileSync(path, "utf8"), label).toBe(original);
        }
      }
    });
  }

  test("the edits do change the files: activation and the rules leave neither as it was", () => {
    const config = put("wp-config.php", CONFIGS.crlf);
    const htaccess = put(".htaccess", HTACCESS.crlf);
    wpRocket(["wp-cache:true", "wp-cache:false", "htaccess:add", "debug:true"]);
    expect(readFileSync(config, "utf8")).toContain(
      "define( 'WP_CACHE', false ); // Added by WP Rocket\n",
    );
    expect(readFileSync(config, "utf8")).toContain(
      "<?php\ndefine( 'WP_ROCKET_DEBUG', true ); // Added by WP Rocket.\r\n",
    );
    expect(readFileSync(htaccess, "utf8")).not.toContain("\r");
  });

  test("a third party's edit on top of WP Rocket's leaves both files untouched, and is named", () => {
    const config = put("wp-config.php", CONFIGS.lf);
    const htaccess = put(".htaccess", HTACCESS.lf);
    expect(runEngine(sandbox, "record", EDITS).status).toBe(0);
    wpRocket(["wp-cache:true", "wp-cache:false", "htaccess:add"]);
    appendFileSync(config, "define( 'WP_DEBUG', true );\n");
    appendFileSync(htaccess, "Header set X-Other 1\n");
    const configAfter = readFileSync(config, "utf8");
    const htaccessAfter = readFileSync(htaccess, "utf8");
    const restored = runEngine(sandbox, "restore", EDITS);
    expect(restored.status).toBe(0);
    expect(restored.stdout).toContain(
      '{"kind":"file","index":0,"result":"unrecognized"}',
    );
    expect(restored.stdout).toContain(
      '{"kind":"file","index":1,"result":"unrecognized"}',
    );
    expect(readFileSync(config, "utf8")).toBe(configAfter);
    expect(readFileSync(htaccess, "utf8")).toBe(htaccessAfter);
  });

  test("a mode WP Rocket's write changed is set back with the bytes", () => {
    const config = put("wp-config.php", CONFIGS.lf);
    chmodSync(config, 0o640);
    expect(runEngine(sandbox, "record", EDITS).status).toBe(0);
    wpRocket(["wp-cache:true", "wp-cache:false"]);
    chmodSync(config, 0o644);
    const restored = runEngine(sandbox, "restore", EDITS);
    expect(restored.stdout).toContain(
      '{"kind":"file","index":0,"result":"restored","mode":{"found":420,"recorded":416,"restored":true}}',
    );
    expect(statSync(config).mode & 0o7777).toBe(0o640);
  });

  test("advanced-cache.php and wp-content/cache, absent before, go once emptied", () => {
    expect(runEngine(sandbox, "record", EDITS).status).toBe(0);
    writeFileSync(join(sandbox.root, "wp-content/advanced-cache.php"), "");
    const cache = join(sandbox.root, "wp-content/cache");
    spawnSync("mkdir", [cache]);
    const restored = runEngine(sandbox, "restore", EDITS);
    expect(restored.stdout).toContain(
      '{"kind":"created-file","index":0,"result":"removed"}',
    );
    expect(restored.stdout).toContain(
      '{"kind":"dir","index":0,"result":"removed"}',
    );
    expect(existsSync(cache)).toBe(false);
  });
});
