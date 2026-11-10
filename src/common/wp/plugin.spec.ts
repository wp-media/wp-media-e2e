import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensurePluginAbsent,
  ensurePluginDeactivated,
  existingDestination,
  firstError,
  uncreatedDestination,
  installPlugin,
  isPluginActive,
  pluginBreaksBoot,
  isPluginInstalled,
  uninstallPlugin,
} from "./plugin";
import {
  PluginDeactivationFailedError,
  PluginDestinationBlockedError,
  PluginDestinationExistsError,
  PluginNotInstalledError,
  PluginUninstallFailedError,
} from "./errors";
import { INSPECT_PLUGIN_DIR_BASH } from "../__fixtures__/plugin-dir-stub";
import type { LocalTransport } from "../config/types";

/**
 * The plugin lifecycle over a stub `wp` on PATH and a **real plugin folder**: the plugin is
 * `wp-content/plugins/x/`, "installed" while its `main.php` is there, and the stub's commands change
 * that folder as WordPress would — so "absent" is judged by the path, exactly as on a site. Active
 * state is a marker beside it.
 *
 * Switches, via the environment: `WP_STUB_UNINSTALL` — what `plugin uninstall` does: `removes` (the
 * default), `fatal` (dies, as an `uninstall.php` whose `vendor` is half gone does, keeping it all),
 * `partial` (removes the main file and nothing else); `WP_STUB_STUCK_ACTIVE` — deactivate never
 * takes; `WP_STUB_BROKEN` — the copy cannot boot: without `--skip-plugins`, `is-active` dies on its
 * fatal at exit 1, `deactivate` at exit 255 and `eval` at exit 1, as measured on a cell (any
 * `--skip-plugins…` form skips it); `WP_STUB_DOWN` — every `eval` fails, as with no database;
 * `WP_STUB_KILLED` — PHP is killed by a signal (a segfault, an OOM kill) in `eval`: `loaded` only with
 * plugins loaded, `always` with the plugin skipped too;
 * `WP_STUB_IS_ACTIVE_EXIT` — what
 * `--skip-plugins plugin is-active` exits with instead; `WP_STUB_CACHE_FAIL` — `cache flush` refuses;
 * `WP_STUB_REINSTALLED` — a copy lands at the path right after the first inspection; `WP_STUB_EVAL_BROKEN`
 * — the inspection answers with a warning, not JSON. For an install in the way: `WP_STUB_DEST` — the
 * folder WP-CLI names; `WP_STUB_DEST_STDOUT` — named on standard output; `WP_STUB_DEST_VANISHES` — gone
 * right after.
 */
const STUB_WP = `#!/usr/bin/env bash
${INSPECT_PLUGIN_DIR_BASH}
[ -n "$WP_STUB_LOG" ] && printf '%s\\n' "$*" >> "$WP_STUB_LOG"
SKIP=""
while [[ "$1" == --skip-* ]]; do [[ "$1" == --skip-plugins* ]] && SKIP=1; shift; done
P="$WP_STUB_PLUGINS"
A="$WP_STUB_ACTIVE"
FATAL="Fatal error: Uncaught Error: Class BerlinDB not found"
if [ "$1" = "eval" ]; then
  if [ "$WP_STUB_KILLED" = always ] || { [ "$WP_STUB_KILLED" = loaded ] && [ -z "$SKIP" ]; }; then kill -KILL $$; fi
  if [ -n "$WP_STUB_DOWN" ]; then echo "Error: Error establishing a database connection." >&2; exit 1; fi
  if [ -n "$WP_STUB_BROKEN" ] && [ -z "$SKIP" ]; then echo "$FATAL" >&2; exit 1; fi
  if [ -n "$WP_STUB_EVAL_BROKEN" ]; then echo "PHP Warning:  x"; exit 0; fi
  inspect_plugin_dir "$P" x
  # WP_STUB_REINSTALLED: a copy lands at the path right after the first inspection, as a concurrent install would.
  if [ -n "$WP_STUB_REINSTALLED" ] && [ ! -e "$P/x/main.php" ]; then echo "<?php" > "$P/x/main.php"; fi
  exit 0
fi
case "$1 $2" in
  "cache flush")
    if [ -n "$WP_STUB_CACHE_FAIL" ]; then
      echo "Error: The object cache could not be flushed." >&2
      exit 1
    fi
    exit 0 ;;
  "plugin is-installed") [ -e "$P/$3/main.php" ] && exit 0 || exit 1 ;;
  "plugin is-active")
    if [ -n "$WP_STUB_BROKEN" ] && [ -z "$SKIP" ]; then echo "$FATAL" >&2; exit 1; fi
    if [ -n "$SKIP" ] && [ -n "$WP_STUB_IS_ACTIVE_EXIT" ]; then exit "$WP_STUB_IS_ACTIVE_EXIT"; fi
    [ -e "$A" ] && exit 0 || exit 1 ;;
  "plugin deactivate")
    if [ -n "$WP_STUB_BROKEN" ] && [ -z "$SKIP" ]; then echo "$FATAL" >&2; exit 255; fi
    [ -z "$WP_STUB_STUCK_ACTIVE" ] && rm -f "$A"; exit 0 ;;
  "plugin uninstall")
    case "\${WP_STUB_UNINSTALL:-removes}" in
      removes) rm -rf "\${P:?}/$3"; exit 0 ;;
      partial) rm -f "$P/$3/main.php"; exit 0 ;;
      fatal)
        echo "PHP Warning:  require_once(vendor/berlindb/Base.php): Failed to open stream" >&2
        echo "PHP Fatal error:  Uncaught Error: Failed opening required 'vendor/berlindb/Base.php'" >&2
        echo "Stack trace:" >&2
        exit 255 ;;
    esac ;;
  "plugin install")
    # WordPress takes only a folder for one in the way (is_dir): a file or a dangling link at the path
    # fails its mkdir instead — WP-CLI's words as measured on a cell, WP_STUB_UNCREATED naming another folder.
    if { { [ -e "$P/x" ] || [ -L "$P/x" ]; } && [ ! -d "$P/x" ]; } || [ -n "$WP_STUB_UNCREATED" ]; then
      echo "Unpacking the package..."
      echo "Installing the plugin..."
      echo "Plugin installation failed."
      echo "Warning: Could not create directory. \\"\${WP_STUB_UNCREATED:-$P/x/}\\"" >&2
      echo "Warning: The '/stage/x.zip' plugin could not be found." >&2
      echo "Error: No plugins installed." >&2
      exit 1
    fi
    if [ -e "$P/x" ] || [ -n "$WP_STUB_DEST" ]; then
      msg="Warning: Destination folder already exists. \\"\${WP_STUB_DEST:-$P/x/}\\""
      if [ -n "$WP_STUB_DEST_STDOUT" ]; then echo "$msg"; else echo "$msg" >&2; fi
      [ -n "$WP_STUB_DEST_VANISHES" ] && rm -rf "\${P:?}/x"
      echo "Error: No plugins installed." >&2
      exit 1
    fi
    echo "Error: other" >&2
    exit 1 ;;
esac
exit 0
`;

let stubDir: string;
let root: string;
let plugins: string;
let local: LocalTransport;
let originalPath: string;

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp-plugin-root-"));
  plugins = join(root, "wp-content", "plugins");
  mkdirSync(plugins, { recursive: true });
  // `elevate: false`: a unit run must never reach for the machine's real `sudo`.
  local = { mode: "local", rootDir: root, elevate: false };
  process.env.WP_STUB_PLUGINS = plugins;
  process.env.WP_STUB_ACTIVE = join(root, "active");
  process.env.WP_STUB_LOG = join(root, "calls.log");
});

test.afterEach(() => {
  for (const key of [
    "WP_STUB_PLUGINS",
    "WP_STUB_ACTIVE",
    "WP_STUB_LOG",
    "WP_STUB_UNINSTALL",
    "WP_STUB_STUCK_ACTIVE",
    "WP_STUB_BROKEN",
    "WP_STUB_IS_ACTIVE_EXIT",
    "WP_STUB_CACHE_FAIL",
    "WP_STUB_REINSTALLED",
    "WP_STUB_EVAL_BROKEN",
    "WP_STUB_DEST",
    "WP_STUB_DEST_STDOUT",
    "WP_STUB_DEST_VANISHES",
    "WP_STUB_UNCREATED",
    "WP_STUB_DOWN",
    "WP_STUB_KILLED",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
  rmSync(root, { recursive: true, force: true });
});

/** Installs the plugin: its folder with a main file and a `vendor`, active unless told otherwise. */
function seedInstalled(active = true): void {
  mkdirSync(join(plugins, "x", "vendor"), { recursive: true });
  writeFileSync(join(plugins, "x", "main.php"), "<?php");
  writeFileSync(join(plugins, "x", "vendor", "autoload.php"), "<?php");
  if (active) writeFileSync(join(root, "active"), "");
}

/** What a removal stopped part-way leaves: the folder without its main file. */
function seedOrphaned(): void {
  mkdirSync(join(plugins, "x", "vendor"), { recursive: true });
  writeFileSync(join(plugins, "x", "vendor", "autoload.php"), "<?php");
}

/** Every `wp` call so far, as its argv. */
function calls(): string[] {
  const log = join(root, "calls.log");
  return existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
}

/** Whether anything is at the plugin's path. */
function folderThere(): boolean {
  return existsSync(join(plugins, "x"));
}

/** The calls that change the plugin, in order. */
function pluginCalls(): string[] {
  return calls().filter((call) => /^plugin (deactivate|uninstall)/.test(call));
}

test.describe("isPluginInstalled / isPluginActive", () => {
  test("reflect the exit code", async () => {
    expect(await isPluginInstalled(local, "x")).toBe(false);
    expect(await isPluginActive(local, "x")).toBe(false);
    seedInstalled();
    expect(await isPluginInstalled(local, "x")).toBe(true);
    expect(await isPluginActive(local, "x")).toBe(true);
  });
});

test.describe("ensurePluginDeactivated", () => {
  test("is a no-op when already inactive", async () => {
    seedInstalled(false);
    await ensurePluginDeactivated(local, "x");
    expect(pluginCalls()).toEqual([]);
  });

  test("deactivates an active plugin, then verifies it inactive", async () => {
    seedInstalled();
    await ensurePluginDeactivated(local, "x");
    expect(await isPluginActive(local, "x")).toBe(false);
  });

  test("throws PluginDeactivationFailedError when deactivate has no effect", async () => {
    seedInstalled();
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    await expect(ensurePluginDeactivated(local, "x")).rejects.toBeInstanceOf(
      PluginDeactivationFailedError,
    );
  });
});

test.describe("ensurePluginAbsent", () => {
  test("is a no-op when nothing is at the plugin's path", async () => {
    expect(await ensurePluginAbsent(local, "x")).toBeUndefined();
    expect(pluginCalls()).toEqual([]);
  });

  test("uninstalls a listed plugin through WordPress, deactivating it first as its own call", async () => {
    seedInstalled();
    expect(await ensurePluginAbsent(local, "x")).toBeUndefined();
    expect(folderThere()).toBe(false);
    // `--deactivate` must never reach `plugin uninstall` — see plugin.ts's module doc.
    expect(pluginCalls()).toEqual([
      "plugin deactivate x",
      "plugin uninstall x",
    ]);
  });

  test("removes a folder WordPress does not list by path, without asking WordPress to uninstall it", async () => {
    seedOrphaned();
    const cleared = await ensurePluginAbsent(local, "x");
    expect(folderThere()).toBe(false);
    expect(pluginCalls()).toEqual([]);
    expect(cleared).toEqual({
      dir: expect.objectContaining({
        kind: "orphaned",
        sample: ["vendor"],
      }) as unknown,
      cause: "unlisted",
    });
  });

  test("removes a listed plugin by path only once its uninstall was tried and failed", async () => {
    seedInstalled(false);
    process.env.WP_STUB_UNINSTALL = "fatal";
    const cleared = await ensurePluginAbsent(local, "x");
    expect(folderThere()).toBe(false);
    expect(pluginCalls()).toEqual(["plugin uninstall x"]);
    expect(cleared?.dir.kind).toBe("recognised");
    // The uninstall's own words, its fatal rather than the warning before it.
    expect(cleared).toMatchObject({
      cause: "uninstall-failed",
      uninstallError:
        "PHP Fatal error:  Uncaught Error: Failed opening required 'vendor/berlindb/Base.php'",
    });
  });

  /**
   * A copy that cannot boot reads "inactive" to `is-active` (its fatal, at exit 1 — measured), so the
   * ordinary deactivation skips it; left in `active_plugins`, the next `install --activate` finds it
   * "already active" and never runs its activation (measured on a cell).
   */
  test("takes a broken copy whose uninstall failed off active_plugins, without loading it, before removing it", async () => {
    seedInstalled();
    process.env.WP_STUB_UNINSTALL = "fatal";
    process.env.WP_STUB_BROKEN = "1";
    const cleared = await ensurePluginAbsent(local, "x");
    expect(cleared?.cause).toBe("uninstall-failed");
    expect(existsSync(join(root, "active"))).toBe(false);
    expect(folderThere()).toBe(false);
    const all = calls();
    const deactivate = all.indexOf("--skip-plugins plugin deactivate x");
    expect(deactivate).toBeGreaterThan(all.indexOf("plugin uninstall x"));
    expect(all[deactivate + 1]).toBe("--skip-plugins plugin is-active x");
    // Then the removal by path, which inspects first.
    expect(all[deactivate + 2]).toMatch(/^--skip-plugins --skip-themes eval /);
  });

  test("removes nothing when a broken copy whose uninstall failed stays active", async () => {
    seedInstalled();
    process.env.WP_STUB_UNINSTALL = "fatal";
    process.env.WP_STUB_BROKEN = "1";
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    const failure = await ensurePluginAbsent(local, "x").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginDeactivationFailedError);
    expect((failure as Error).message).toBe(
      'Plugin "x" could not be deactivated: still active after `wp --skip-plugins plugin deactivate`, ' +
        "with its uninstall failed",
    );
    expect(existsSync(join(plugins, "x", "main.php"))).toBe(true);
  });

  test("removes nothing when whether a broken copy is active cannot be read", async () => {
    seedInstalled();
    process.env.WP_STUB_UNINSTALL = "fatal";
    process.env.WP_STUB_IS_ACTIVE_EXIT = "255";
    await expect(ensurePluginAbsent(local, "x")).rejects.toThrow(
      "whether it is still active could not be read (`wp --skip-plugins plugin is-active` exit 255)",
    );
    expect(existsSync(join(plugins, "x", "main.php"))).toBe(true);
  });

  // The ordinary path keeps the ordinary deactivation, which runs the plugin's own deactivation hook.
  test("never deactivates without loading the plugin when its uninstall did not fail", async () => {
    seedInstalled();
    await ensurePluginAbsent(local, "x");
    process.env.WP_STUB_UNINSTALL = "partial";
    seedInstalled();
    await ensurePluginAbsent(local, "x");
    expect(calls().some((call) => call.includes("--skip-plugins plugin"))).toBe(
      false,
    );
  });

  test("removes what an uninstall left behind, reporting it without an uninstall failure", async () => {
    seedInstalled(false);
    process.env.WP_STUB_UNINSTALL = "partial";
    const cleared = await ensurePluginAbsent(local, "x");
    expect(folderThere()).toBe(false);
    expect(cleared?.dir.kind).toBe("orphaned");
    // What this uninstall left, not what an earlier removal did.
    expect(cleared?.cause).toBe("uninstall-left");
    expect(cleared).not.toHaveProperty("uninstallError");
  });

  // Removal by path is told a listed plugin may go only once its uninstall failed — so a copy that
  // lands between the two inspections is refused, never removed without its uninstall being tried.
  test("refuses to remove by path a listed plugin whose uninstall it never tried", async () => {
    seedOrphaned();
    process.env.WP_STUB_REINSTALLED = "1";
    await expect(ensurePluginAbsent(local, "x")).rejects.toThrow(
      /WordPress lists a plugin there/,
    );
    expect(existsSync(join(plugins, "x", "main.php"))).toBe(true);
  });

  test("still throws when a listed plugin will not deactivate, removing nothing", async () => {
    seedInstalled();
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    await expect(ensurePluginAbsent(local, "x")).rejects.toBeInstanceOf(
      PluginDeactivationFailedError,
    );
    expect(existsSync(join(plugins, "x", "main.php"))).toBe(true);
  });

  test("flushes the object cache after removing the plugin", async () => {
    // "Absent" has to mean absent to WordPress too: a plugin that clears its options with raw SQL
    // leaves a persistent cache serving rows that no longer exist. See wp/cache.ts.
    seedInstalled();
    await ensurePluginAbsent(local, "x");
    const all = calls();
    expect(all.indexOf("cache flush")).toBeGreaterThan(
      all.indexOf("plugin uninstall x"),
    );
  });

  test("flushes even when the plugin was already gone", async () => {
    // The cheap path must not skip it: state that outlives a removal was not necessarily written by
    // *this* call's removal — a run killed before teardown leaves exactly that.
    await ensurePluginAbsent(local, "x");
    expect(calls()).toContain("cache flush");
  });

  test("still succeeds when the object cache refuses to flush", async () => {
    // The whole point of the flush being best-effort: housekeeping must never turn a removal red.
    seedInstalled();
    process.env.WP_STUB_CACHE_FAIL = "1";
    const originalWarn = console.warn;
    const warnings: string[] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
    try {
      await expect(ensurePluginAbsent(local, "x")).resolves.toBeUndefined();
    } finally {
      console.warn = originalWarn;
    }
    // Stepped over, but never silently: an operator has to be able to see which cell did this.
    expect(warnings.some((line) => line.includes("[wp/cache]"))).toBe(true);
  });
});

test.describe("uninstallPlugin", () => {
  test("throws PluginNotInstalledError on an absent plugin", async () => {
    const failure = await uninstallPlugin(local, "x").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginNotInstalledError);
    expect((failure as Error).message).toBe(
      'Plugin "x" was expected to be installed, but is absent.',
    );
  });

  test("names what is at the path when WordPress lists no plugin there", async () => {
    seedOrphaned();
    const failure = await uninstallPlugin(local, "x").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginNotInstalledError);
    expect((failure as Error).message).toContain(
      `WordPress lists no plugin there; at its path: ${join(plugins, "x")}: a folder WordPress ` +
        "lists no plugin in, 2 entries (vendor)",
    );
    expect(pluginCalls()).toEqual([]);
  });

  test("says so when what is at the path cannot be inspected", async () => {
    seedOrphaned();
    process.env.WP_STUB_EVAL_BROKEN = "1";
    await expect(uninstallPlugin(local, "x")).rejects.toThrow(
      /at its path: its path could not be inspected \(\[wp\/plugin-dir\] the inspection did not come back as JSON/,
    );
  });

  test("succeeds when nothing is left at the plugin's path", async () => {
    seedInstalled();
    await uninstallPlugin(local, "x");
    expect(folderThere()).toBe(false);
    expect(pluginCalls()).toEqual([
      "plugin deactivate x",
      "plugin uninstall x",
    ]);
  });

  test("fails on a folder WordPress no longer lists, naming it, and never sweeps it", async () => {
    seedInstalled();
    process.env.WP_STUB_UNINSTALL = "partial";
    const failure = await uninstallPlugin(local, "x").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginUninstallFailedError);
    expect((failure as Error).message).toContain(
      `${join(plugins, "x")}: a folder WordPress lists no plugin in`,
    );
    // Removal under test judges; the cleanup after it heals.
    expect(existsSync(join(plugins, "x", "vendor"))).toBe(true);
  });

  test("fails when the plugin is still listed after its uninstall", async () => {
    seedInstalled(false);
    process.env.WP_STUB_UNINSTALL = "fatal";
    await expect(uninstallPlugin(local, "x")).rejects.toThrow(
      /WordPress lists a plugin in/,
    );
    expect(existsSync(join(plugins, "x", "main.php"))).toBe(true);
  });
});

test.describe("installPlugin", () => {
  test("says a folder in the way is one WordPress does not list", async () => {
    seedOrphaned();
    const failure = await installPlugin(local, "/stage/x.zip").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginDestinationExistsError);
    expect(failure).toMatchObject({
      path: `${join(plugins, "x")}/`,
      verdict: "orphaned",
    });
  });

  test("says a folder in the way holds a plugin WordPress lists", async () => {
    seedInstalled();
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toMatchObject({
      verdict: "recognised",
    });
  });

  for (const [verdict, seen] of [
    [
      "orphaned",
      "WordPress lists no plugin there: part of a plugin is left, as a removal stopped part-way (a " +
        "PHP-FPM restart, a reboot) leaves it.",
    ],
    [
      "recognised",
      "WordPress lists a plugin there: an earlier copy was never removed.",
    ],
  ] as const) {
    test(`words a ${verdict} folder in the way`, async () => {
      if (verdict === "orphaned") seedOrphaned();
      else seedInstalled();
      await expect(installPlugin(local, "/stage/x.zip")).rejects.toThrow(
        `Plugin install refused: the destination folder "${join(plugins, "x")}/" already exists; ${seen}`,
      );
    });
  }

  test("reads the folder WP-CLI names on standard output too", async () => {
    seedOrphaned();
    process.env.WP_STUB_DEST_STDOUT = "1";
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toMatchObject({
      verdict: "orphaned",
    });
  });

  test("says the folder is gone when it went right after the install refused", async () => {
    seedOrphaned();
    process.env.WP_STUB_DEST_VANISHES = "1";
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toMatchObject({
      verdict: "absent",
      message: expect.stringContaining(
        "nothing is there any more, so something removed it right after the install refused.",
      ),
    });
  });

  test("says the folder could not be inspected when the inspection fails", async () => {
    seedOrphaned();
    process.env.WP_STUB_EVAL_BROKEN = "1";
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toMatchObject({
      verdict: "unknown",
      message: expect.stringContaining(
        "already exists; the folder could not be inspected.",
      ),
    });
  });

  test("asks the site nothing about a folder whose name is no plugin slug", async () => {
    process.env.WP_STUB_DEST = "/";
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toMatchObject({
      path: "/",
      verdict: "unknown",
    });
    expect(calls().some((call) => call.includes(" eval "))).toBe(false);
  });

  test("names a dangling link at the plugin's path, which WordPress could not create its folder over", async () => {
    symlinkSync("/nonexistent-e2e-target", join(plugins, "x"));
    const failure = await installPlugin(local, "/stage/x.zip").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(PluginDestinationBlockedError);
    expect(failure).toMatchObject({ path: `${join(plugins, "x")}/` });
    expect((failure as Error).message).toBe(
      `Plugin install failed: WordPress could not create the plugin's folder "${join(plugins, "x")}/", ` +
        `because something that is no folder is there — ${join(plugins, "x")}: a link to ` +
        '"/nonexistent-e2e-target" (WordPress lists no plugin in it); owner tester; last changed 60 s ' +
        "ago. Remove it (or point a link at a real folder), then install again.",
    );
  });

  test("names a file at the plugin's path", async () => {
    writeFileSync(join(plugins, "x"), "not a folder");
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toThrow(
      `${join(plugins, "x")}: a file, not a folder; owner tester`,
    );
  });

  test("keeps the plain failure when nothing is at the folder WordPress could not create", async () => {
    // A plugins folder WordPress may not write in fails the same way, with nothing in the way.
    process.env.WP_STUB_UNCREATED = `${join(plugins, "x")}/`;
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toThrow(
      /install "\/stage\/x\.zip" failed \(exit 1\): Warning: Could not create directory\./,
    );
  });

  test("keeps the plain failure when the folder WordPress could not create lies deeper than the plugin's path", async () => {
    // A file named like a folder deeper in the copy must never pass for the plugin's own path.
    symlinkSync("/nonexistent-e2e-target", join(plugins, "x"));
    process.env.WP_STUB_UNCREATED = `${join(plugins, "x", "vendor", "x")}/`;
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toThrow(
      /install "\/stage\/x\.zip" failed \(exit 1\)/,
    );
  });

  test("keeps the plain failure for any other refusal", async () => {
    await expect(installPlugin(local, "/stage/x.zip")).rejects.toThrow(
      /install "\/stage\/x\.zip" failed \(exit 1\): Error: other/,
    );
  });
});

test.describe("uncreatedDestination", () => {
  test("reads the folder from WP-CLI's warning, as measured on a cell", () => {
    expect(
      uncreatedDestination(
        'Warning: Could not create directory. "/var/www/site/public/wp-content/plugins/backwpup-pro/"\n' +
          "Warning: The '/var/www/site/public/.e2e_temp/plugins/x.zip' plugin could not be found.\n" +
          "Error: No plugins installed.",
      ),
    ).toBe("/var/www/site/public/wp-content/plugins/backwpup-pro/");
  });

  test("finds nothing in any other failure", () => {
    expect(
      uncreatedDestination('Destination folder already exists. "/p/x/"'),
    ).toBeUndefined();
  });
});

test.describe("existingDestination", () => {
  test("reads the folder from WP-CLI's warning", () => {
    expect(
      existingDestination(
        'Warning: Destination folder already exists. "/srv/site/wp-content/plugins/backwpup-pro/"\nError: No plugins installed.',
      ),
    ).toBe("/srv/site/wp-content/plugins/backwpup-pro/");
  });

  test("reads it with no space before the quote, and only the first quoted path", () => {
    expect(
      existingDestination('Destination folder already exists."/p/x/"'),
    ).toBe("/p/x/");
    expect(
      existingDestination(
        'Warning: Destination folder already exists. "/p/x/" (see "/p/y/")',
      ),
    ).toBe("/p/x/");
  });

  test("finds nothing in any other failure", () => {
    expect(existingDestination("Error: No plugins installed.")).toBeUndefined();
  });
});

test.describe("firstError", () => {
  test("prefers a PHP fatal over the warnings before it", () => {
    expect(
      firstError({
        exitCode: 255,
        stdout: "",
        stderr: "PHP Warning:  a\nPHP Fatal error:  b\nStack trace:",
      }),
    ).toBe("PHP Fatal error:  b");
  });

  test("takes WP-CLI's own Error line", () => {
    expect(
      firstError({
        exitCode: 1,
        stdout: "",
        stderr: "Warning: x\nError: No plugins uninstalled.",
      }),
    ).toBe("Error: No plugins uninstalled.");
  });

  test("takes only a line that starts with Error:, not one that merely mentions it", () => {
    expect(
      firstError({
        exitCode: 1,
        stdout: "",
        stderr: "Warning: saw Error: earlier\nError: the real one",
      }),
    ).toBe("Error: the real one");
  });

  test("reads standard error before standard output", () => {
    expect(
      firstError({ exitCode: 1, stdout: "Error: out", stderr: "Error: err" }),
    ).toBe("Error: err");
  });

  test("finds an indented Error line, trimmed", () => {
    expect(
      firstError({
        exitCode: 1,
        stdout: "first\n   Error: indented  ",
        stderr: "",
      }),
    ).toBe("Error: indented");
  });

  test("falls back to the first line, then to the exit code", () => {
    expect(firstError({ exitCode: 1, stdout: "odd\n", stderr: "" })).toBe(
      "odd",
    );
    expect(firstError({ exitCode: 7, stdout: "", stderr: "" })).toBe(
      "exit 7, no output",
    );
  });

  test("bounds a long line", () => {
    const line = firstError({
      exitCode: 1,
      stdout: "",
      stderr: `Error: ${"x".repeat(1000)}`,
    });
    expect(line).toHaveLength(301);
    expect(line.endsWith("…")).toBe(true);
  });

  test("keeps a line of exactly 300 characters whole", () => {
    const exact = `Error: ${"x".repeat(293)}`;
    expect(firstError({ exitCode: 1, stdout: "", stderr: exact })).toBe(exact);
  });
});

test.describe("pluginBreaksBoot", () => {
  test("names the fatal when WordPress boots only with the plugin skipped", async () => {
    process.env.WP_STUB_BROKEN = "1";
    expect(await pluginBreaksBoot(local, "x")).toBe(
      "Fatal error: Uncaught Error: Class BerlinDB not found",
    );
    expect(calls()).toEqual(["--skip-plugins=x eval echo 1;", "eval echo 1;"]);
  });

  test("blames nothing when WordPress boots with the plugin loaded", async () => {
    expect(await pluginBreaksBoot(local, "x")).toBeUndefined();
  });

  test("blames nothing, and loads no plugin, when WordPress does not boot even without it", async () => {
    process.env.WP_STUB_DOWN = "1";
    expect(await pluginBreaksBoot(local, "x")).toBeUndefined();
    expect(calls()).toEqual(["--skip-plugins=x eval echo 1;"]);
  });

  // A crash (no exit code, so a CommandKilledError) is a boot failure like a fatal, never a throw.
  test("names the signal when WordPress crashes only with the plugin loaded", async () => {
    process.env.WP_STUB_KILLED = "loaded";
    const boot = await pluginBreaksBoot(local, "x");
    expect(boot).toMatch(/^\[wp\/exec\] "wp" was killed by SIGKILL\b/);
    expect(boot).not.toContain("echo 1");
    expect(calls()).toEqual(["--skip-plugins=x eval echo 1;", "eval echo 1;"]);
  });

  test("blames nothing, and loads no plugin, when WordPress crashes even without it", async () => {
    process.env.WP_STUB_KILLED = "always";
    expect(await pluginBreaksBoot(local, "x")).toBeUndefined();
    expect(calls()).toEqual(["--skip-plugins=x eval echo 1;"]);
  });

  test("asks nothing for a slug --skip-plugins would read as more than one plugin", async () => {
    expect(await pluginBreaksBoot(local, "x,y")).toBeUndefined();
    expect(calls()).toEqual([]);
  });
});
