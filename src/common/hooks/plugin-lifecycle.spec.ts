import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DebugLogFatalError,
  PluginActivationFailedError,
  PluginDirRemovalFailedError,
  PluginUninstallBrokenError,
} from "../wp/errors";
import { resetOwnershipCaches } from "../wp/ownership";
import { DEFAULT_STAGING_DIR, PLUGINS_CATEGORY } from "../wp/staging";
import {
  registerInstallOutputs,
  registerSiteDataDirResolver,
  registerSiteDbResidue,
  registerSiteResidue,
  registerStopRunningWork,
} from "../config/metadata";
import {
  BEFORE_HOOK_TIMEOUT_MS,
  HOOK_TIMEOUT_MS,
  LEFT_WORK_ALLOWANCE_MS,
  MAX_ATTACHED_LOG_CHARS,
  boundLogForAttachment,
  clearedPluginDirMessage,
  dbResidueMessage,
  declaredResidue,
  leftWorkOf,
  extendedTimeout,
  installPluginUnderTest,
  replacePluginUnderTest,
  teardownPluginUnderTest,
} from "./plugin-lifecycle";
import { INSPECT_PLUGIN_DIR_BASH } from "../__fixtures__/plugin-dir-stub";
import type { DeclaredResidue, ScenarioReport } from "./plugin-lifecycle";
import type { ResolvedArtifact } from "../artifacts/types";
import type { LocalTransport, StopRunningWork } from "../config/types";

/**
 * The `@plugin` lifecycle policy, driven end to end on the `local` transport: a real WP-root-like
 * directory, a real staged zip, and a **stateful** stub `wp` on PATH whose install/deactivate/
 * uninstall calls actually change what `is-installed` and `is-active` report. Modelling that state
 * is what makes the interesting properties provable rather than asserted by inspection — the
 * WP-CLI call order, that the install reads the *staged* path, that a fatal fails the scenario, and
 * that the debug-log verdict outranks a cleanup failure without hiding it.
 */

let stubDir: string;
let wpRoot: string;
let sourceDir: string;
let stateDir: string;
let originalPath: string;
let local: LocalTransport;
let argvFile: string;
let warnings: string[];
let errors: string[];
let realWarn: typeof console.warn;
let realError: typeof console.error;

/** Root ignores directory permissions, so the "cannot be removed" cases cannot be provoked. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/**
 * Stub `wp` that records every invocation and keeps plugin state where a site keeps it, so the
 * lifecycle's re-assertions see the effect of the call before them — exactly as they would on a real
 * site. The plugin is a real folder, `wp-content/plugins/<WP_STUB_SLUG>/`, installed while its
 * `main.php` is there; the plugin-folder inspection reads it as the site's snippet would.
 *
 * Switches, all via the environment:
 *  - `WP_STUB_STATE_DIR` — holds the `active` marker.
 *  - `WP_STUB_PLUGINS` / `WP_STUB_SLUG` — the plugins folder, and the slug installs land at.
 *  - `WP_STUB_LOG` — what an `eval` debug.log read prints.
 *  - `WP_STUB_FAIL` — an argv prefix to fail (e.g. `"plugin uninstall"`), leaving state untouched.
 *  - `WP_STUB_STUCK_ACTIVE` — deactivate exits 0 but never takes: a cleanup that cannot heal.
 *  - `WP_STUB_UNBOOTABLE` — the plugin cannot boot: an `eval` that loads plugins dies on its fatal,
 *    one with `--skip-plugins…` runs.
 *  - `WP_STUB_SILENT_ACTIVATE_FAIL` — install succeeds and exits 0, but the plugin never becomes
 *    active: the failure mode an exit code alone would miss.
 *  - `WP_STUB_ACTIVATION_OUTPUT` — an absolute folder activation creates outside the plugin's own.
 *  - a `db-residue` marker in the state dir — a leftover database footprint, which the sweep's own
 *    snippet reports until the snippet that deletes runs, exactly as a real site would.
 */
const STUB_WP = `#!/usr/bin/env bash
${INSPECT_PLUGIN_DIR_BASH}
printf '%s' "$*" | tr '\n' ' ' >> "$WP_STUB_ARGV_FILE"
printf '\n' >> "$WP_STUB_ARGV_FILE"
if [ -n "$WP_STUB_FAIL" ] && [[ "$*" == "$WP_STUB_FAIL"* ]]; then
  echo "stub: refusing $*" >&2
  exit 1
fi
SKIPPED=""
while [[ "$1" == --skip-* ]]; do SKIPPED="$SKIPPED $1"; shift; done
if [ "$1" = "eval" ] && [ -n "$WP_STUB_UNBOOTABLE" ] && [[ "$SKIPPED" != *--skip-plugins* ]]; then
  echo "Fatal error: Uncaught Error: Class BerlinDB not found" >&2
  exit 1
fi
S="$WP_STUB_STATE_DIR"
P="$WP_STUB_PLUGINS"
SLUG="$WP_STUB_SLUG"
case "$1 $2" in
  "plugin is-installed") [ -e "$P/$3/main.php" ] && exit 0 || exit 1 ;;
  "plugin is-active")    [ -e "$S/active" ]    && exit 0 || exit 1 ;;
  "plugin deactivate")   [ -z "$WP_STUB_STUCK_ACTIVE" ] && rm -f "$S/active"; exit 0 ;;
  "plugin uninstall")    rm -rf "\${P:?}/$3"; rm -f "$S/active"; exit 0 ;;
  "plugin install")
    if [ -e "$P/$SLUG" ]; then
      echo "Warning: Destination folder already exists. \\"$P/$SLUG/\\"" >&2
      echo "Error: No plugins installed." >&2
      exit 1
    fi
    mkdir -p "$P/$SLUG"
    echo "<?php" > "$P/$SLUG/main.php"
    if [[ "$*" == *--activate* ]] && [ -z "$WP_STUB_SILENT_ACTIVATE_FAIL" ]; then
      touch "$S/active"
      if [ -n "$WP_STUB_ACTIVATION_OUTPUT" ]; then mkdir -p "$WP_STUB_ACTIVATION_OUTPUT"; fi
    fi
    exit 0 ;;
esac
if [ "$1" = "eval" ]; then
  case "$2" in
    *get_plugins*) inspect_plugin_dir "$P" "$SLUG" ;;
    *file_get_contents*) printf '%s' "$WP_STUB_LOG" ;;
    *leftover-footprint*)
      if [[ "$2" == *delete_option* ]]; then rm -f "$S/db-residue"; fi
      if [ -e "$S/db-residue" ]; then
        printf '{"prefix":"wp_","options":["backwpup_version"],"tables":["wp_bwpup_backups"],"roles":[],"capabilities":[]}'
      else
        printf '{"prefix":"wp_","options":[],"tables":[],"roles":[],"capabilities":[]}'
      fi ;;
  esac
fi
exit 0
`;

/** Marks the site as carrying a leftover database footprint with no plugin files behind it. */
function seedDbResidue(): void {
  writeFileSync(join(stateDir, "db-residue"), "");
}

/** True while the stub site still carries that footprint. */
function hasDbResidue(): boolean {
  return existsSync(join(stateDir, "db-residue"));
}

/** A declaration covering both halves, for the cases that exercise the database sweep. */
function bothResidue(...paths: string[]): DeclaredResidue {
  return {
    files: paths,
    db: { optionsContaining: ["backwpup"], tables: ["bwpup_backups"] },
  };
}

/** The plugin's folder on the stub site. */
function pluginDir(): string {
  return join(wpRoot, "wp-content", "plugins", "backwpup-pro");
}

/** Marks the plugin as already installed and active, as a crashed earlier run would leave it. */
function seedInstalled(): void {
  mkdirSync(pluginDir(), { recursive: true });
  writeFileSync(join(pluginDir(), "main.php"), "<?php");
  writeFileSync(join(stateDir, "active"), "");
}

/** Leaves what a removal stopped part-way leaves: part of the plugin, without its main file. */
function seedOrphaned(): void {
  mkdirSync(join(pluginDir(), "vendor", "berlindb"), { recursive: true });
  mkdirSync(join(pluginDir(), "src"), { recursive: true });
  writeFileSync(join(pluginDir(), "vendor", "berlindb", "Base.php"), "<?php");
}

/** True when the stub site currently has the plugin installed. */
function isInstalled(): boolean {
  return existsSync(join(pluginDir(), "main.php"));
}

/** True when the stub site currently has the plugin active. */
function isActive(): boolean {
  return existsSync(join(stateDir, "active"));
}

/** The resolved artifact under test: a real file on the "runner", named like an APVM build. */
function artifact(slug = "backwpup-pro"): ResolvedArtifact {
  const zipPath = join(sourceDir, "backwpup-pro-en-9.99.99-abc1234.zip");
  writeFileSync(zipPath, "zip bytes");
  return {
    role: "plugin",
    slug,
    zipPath,
    zipFilename: "backwpup-pro-en-9.99.99-abc1234.zip",
    source: "default-ref",
    origin: "built",
    resolvedAt: "2026-07-28T00:00:00.000Z",
  };
}

/**
 * The filesystem half of a {@link DeclaredResidue}, which is what these cases exercise.
 * The database half has its own suite in `wp/db-residue.spec.ts`.
 */
function files(...paths: string[]): DeclaredResidue {
  return { files: paths, db: {} };
}

/** Every `wp` invocation so far, one per line. */
function wpCalls(): string[] {
  return existsSync(argvFile)
    ? readFileSync(argvFile, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

/** Stand-in scenario title, asserted on so a console line is traceable to its scenario. */
const SCENARIO_TITLE = "A backup lands in the history";

/** A report sink that records attachments; `failed` mirrors a scenario's own outcome. */
function reportSink(failed = false): ScenarioReport & {
  readonly attached: Map<string, string>;
} {
  const attached = new Map<string, string>();
  return {
    title: SCENARIO_TITLE,
    failed,
    attached,
    attach: (name, body) => {
      attached.set(name, body);
      return Promise.resolve();
    },
  };
}

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
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  sourceDir = mkdtempSync(join(tmpdir(), "wp-src-"));
  stateDir = join(sourceDir, "state");
  mkdirSync(stateDir, { recursive: true });
  // `elevate: false`, like the pre-flight spec pins: a unit run must never shell out to the real
  // `sudo` on whatever machine happens to be running it, and no case here needs privileges.
  local = { mode: "local", rootDir: wpRoot, elevate: false };
  argvFile = join(sourceDir, "wp-argv.log");
  process.env.WP_STUB_ARGV_FILE = argvFile;
  process.env.WP_STUB_STATE_DIR = stateDir;
  process.env.WP_STUB_PLUGINS = join(wpRoot, "wp-content", "plugins");
  process.env.WP_STUB_SLUG = "backwpup-pro";
  mkdirSync(process.env.WP_STUB_PLUGINS, { recursive: true });
  delete process.env.WP_STUB_LOG;
  delete process.env.WP_STUB_FAIL;
  delete process.env.WP_STUB_SILENT_ACTIVATE_FAIL;
  // Ownership probes are memoised per target, and each test gets a fresh WordPress root.
  resetOwnershipCaches();
  warnings = [];
  errors = [];
  realWarn = console.warn;
  realError = console.error;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]): void => {
    errors.push(args.map(String).join(" "));
  };
});

test.afterEach(() => {
  console.warn = realWarn;
  console.error = realError;
  // Clear every switch this file may have set: a worker runs several spec files in turn, and
  // `WP_STUB_LOG` / `WP_STUB_FAIL` are names other stubs read too.
  for (const key of [
    "WP_STUB_ARGV_FILE",
    "WP_STUB_STATE_DIR",
    "WP_STUB_PLUGINS",
    "WP_STUB_SLUG",
    "WP_STUB_LOG",
    "WP_STUB_FAIL",
    "WP_STUB_UNBOOTABLE",
    "WP_STUB_STUCK_ACTIVE",
    "WP_STUB_SILENT_ACTIVATE_FAIL",
    "WP_STUB_ACTIVATION_OUTPUT",
  ] as const) {
    Reflect.deleteProperty(process.env, key);
  }
  for (const dir of [wpRoot, sourceDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.describe("extendedTimeout", () => {
  test("adds room for both hooks on top of the scenario's own budget", () => {
    const hooks = BEFORE_HOOK_TIMEOUT_MS + HOOK_TIMEOUT_MS;
    expect(extendedTimeout(30_000)).toBe(30_000 + hooks);
    // A scenario that asked for more keeps all of it.
    expect(extendedTimeout(600_000)).toBe(600_000 + hooks);
  });

  // The Before hook may have to stop a killed run's work before it installs, which the install's own
  // budget has no room for.
  test("gives the Before hook the leftover-work allowance on top of a hook's budget", () => {
    expect(BEFORE_HOOK_TIMEOUT_MS).toBe(
      HOOK_TIMEOUT_MS + LEFT_WORK_ALLOWANCE_MS,
    );
  });

  test("leaves 0 alone, because 0 means no timeout", () => {
    expect(extendedTimeout(0)).toBe(0);
  });
});

test.describe("boundLogForAttachment", () => {
  test("passes a normal log through untouched", () => {
    const log = "PHP Warning: something\n".repeat(10);
    expect(boundLogForAttachment(log)).toBe(log);
  });

  test("caps a runaway log, keeping the start and saying what it dropped", () => {
    // A fatal inside a loop is the realistic case: megabytes of the same line.
    const log = `PHP Fatal error:  first and only interesting line\n${"x".repeat(MAX_ATTACHED_LOG_CHARS * 2)}`;

    const bounded = boundLogForAttachment(log);

    expect(bounded.length).toBeLessThan(log.length);
    // The root cause is at the start, which is why the head is what survives.
    expect(bounded).toContain("first and only interesting line");
    expect(bounded).toContain(`of ${String(log.length)} characters`);
  });
});

// The reinstall a scenario performs part-way: everything the install does except scoping the log, so
// what PHP logged before it — a fatal included — is still there for the teardown to judge.
test.describe("replacePluginUnderTest", () => {
  test("removes any existing copy and installs the staged zip, never touching debug.log", async () => {
    seedInstalled();
    await replacePluginUnderTest(local, artifact());
    const calls = wpCalls();
    expect(calls.filter((c) => c.includes("debug.log"))).toEqual([]);
    const removed = calls.findIndex((c) => c.startsWith("plugin uninstall "));
    const installed = calls.findIndex((c) => c.startsWith("plugin install "));
    expect(removed).toBeGreaterThan(-1);
    expect(installed).toBeGreaterThan(removed);
    expect(isInstalled()).toBe(true);
  });

  test("refuses an unusable slug before running anything", async () => {
    await expect(
      replacePluginUnderTest(local, artifact("../evil")),
    ).rejects.toThrow(/not a usable plugin slug/);
    expect(wpCalls()).toEqual([]);
  });
});

test.describe("declaredResidue", () => {
  test("reads what the config registered for the product, and nothing for one it did not", () => {
    registerSiteResidue("residue-spec-product", ["wp-content/uploads/x"]);
    registerSiteDbResidue("residue-spec-product", { tables: ["x_log"] });
    expect(declaredResidue("residue-spec-product")).toEqual({
      files: ["wp-content/uploads/x"],
      db: { tables: ["x_log"] },
    });
    expect(declaredResidue("residue-spec-unregistered")).toEqual({
      files: [],
      db: {},
    });
  });

  test("carries the product's validated install outputs, and none for a product without", () => {
    registerInstallOutputs("outputs-spec-product", ["wp-content/cache/"]);
    expect(declaredResidue("outputs-spec-product").installOutputs).toEqual([
      "wp-content/cache",
    ]);
    expect(
      declaredResidue("residue-spec-unregistered").installOutputs,
    ).toBeUndefined();
  });

  test("carries the product's resolver for its runtime-named directories", () => {
    const resolve = (): Promise<readonly string[]> => Promise.resolve([]);
    registerSiteDataDirResolver("resolver-spec-product", resolve);
    expect(declaredResidue("resolver-spec-product").resolveDataDirs).toBe(
      resolve,
    );
    expect(
      declaredResidue("residue-spec-unregistered").resolveDataDirs,
    ).toBeUndefined();
  });
});

test.describe("leftWorkOf", () => {
  test("hands the install the product's registered stop with the scenario, and nothing for a product with none", () => {
    const stop: StopRunningWork = () => Promise.resolve(undefined);
    const report: ScenarioReport = {
      title: "s",
      failed: false,
      attach: () => Promise.resolve(),
    };
    registerStopRunningWork("left-work-spec-product", stop);
    expect(leftWorkOf("left-work-spec-product", report)).toEqual({
      stop,
      report,
    });
    expect(leftWorkOf("left-work-spec-unregistered", report)).toBeUndefined();
  });
});

/** BackWPup's restore working directories, as a family. */
const RESTORE_FAMILY = {
  parent: "wp-content/uploads",
  name: /^backwpup-restore-[0-9a-f]{20}$/,
};

test.describe("installPluginUnderTest", () => {
  test("clears the log, removes any existing copy, then installs the staged zip", async () => {
    seedInstalled();
    const resolved = artifact();

    await installPluginUnderTest(local, resolved);

    // Asserted as an ordering contract rather than an exact call list: the removal's own WP-CLI
    // sequence (deactivate as its own call, then a plain uninstall) belongs to `wp/plugin.ts` and
    // is pinned by its spec — re-pinning it here would only make this test brittle.
    const calls = wpCalls();
    // Clearing first scopes the log to this scenario yet still records the removal's own output.
    // Matched on what the call is *for*, not on the PHP it happens to run — that snippet belongs to
    // `wp/log.ts` and is pinned by its own spec.
    expect(calls[0]).toMatch(/^--skip-plugins --skip-themes eval .*debug\.log/);
    const removed = calls.findIndex((c) => c.startsWith("plugin uninstall "));
    const installed = calls.findIndex((c) => c.startsWith("plugin install "));
    expect(removed).toBeGreaterThan(0);
    expect(installed).toBeGreaterThan(removed);

    const staged = join(
      wpRoot,
      DEFAULT_STAGING_DIR,
      PLUGINS_CATEGORY,
      resolved.zipFilename,
    );
    // Installed from the SITE's staged copy — a runner path means nothing to a remote `wp`.
    expect(calls[installed]).toBe(`plugin install ${staged} --activate`);
    expect(calls[installed]).not.toContain(sourceDir);
    expect(readFileSync(staged, "utf8")).toBe("zip bytes");
    // …and the hook signs off by re-asserting the state, never trusting the install's exit code.
    expect(calls.slice(installed + 1)).toEqual([
      "plugin is-active backwpup-pro",
    ]);
  });

  // The hook is what makes the product's data directories usable by *both* users sharing the
  // docroot; leaving it out let whichever user wrote first lock the other out, which surfaced as a
  // PHP fatal from the plugin rather than as anything a scenario could explain.
  test("opens the product's declared data directories after installing", async () => {
    await installPluginUnderTest(
      local,
      artifact(),
      files("wp-content/uploads/backwpup-restore"),
    );
    const dir = join(wpRoot, "wp-content/uploads/backwpup-restore");
    expect(existsSync(dir)).toBe(true);
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("777");
  });

  /**
   * The install unpacks the zip as the *transport's* user, so on a real cell the plugin's files
   * arrive owned by someone the web server is not, and the hook must hand that directory back.
   *
   * Observed through a deliberately unusable `fileOwner`, the one ownership outcome an unprivileged
   * runner can provoke on any platform. It proves the step runs during the install; that it runs
   * against *this artifact's* directory is pinned by the next test, which is the only place the slug
   * itself appears in an observable message.
   */
  test("normalises ownership as part of installing the plugin", async () => {
    await installPluginUnderTest(
      { ...local, fileOwner: "not a valid spec" },
      artifact(),
    );

    expect(warnings.join("\n")).toMatch(/\[wp\/ownership\]/);
    expect(isActive()).toBe(true);
  });

  // The artifact's slug is the only thing that knows where the zip unpacked to, so it must be what
  // the ownership step is aimed at. An unusable one is refused by name, and refused *before*
  // anything is staged or installed.
  test("aims ownership at the artifact's own slug", async () => {
    await expect(
      installPluginUnderTest(local, artifact("../evil")),
    ).rejects.toThrow(/"\.\.\/evil" is not a usable plugin slug/);

    expect(isInstalled()).toBe(false);
    expect(wpCalls().some((c) => c.startsWith("plugin install"))).toBe(false);
  });

  // Housekeeping must never decide whether a scenario runs: a site that cannot be normalised still
  // gets its plugin installed and activated.
  test("installs and activates even when ownership cannot be normalised", async () => {
    await installPluginUnderTest(
      { ...local, fileOwner: "not a valid spec" },
      artifact(),
      files("wp-content/uploads/backwpup-restore"),
    );

    // First that ownership was genuinely *attempted* and refused: without this the rest of the test
    // passes with the whole handover removed, since install and preparation produce it on their own.
    expect(warnings.join("\n")).toMatch(
      /\[wp\/ownership\].*must be "user:group"/,
    );
    expect(isActive()).toBe(true);
    // The step after it still ran, so the failure was reported and stepped over, not propagated.
    expect(
      existsSync(join(wpRoot, "wp-content/uploads/backwpup-restore")),
    ).toBe(true);
  });

  /**
   * A directory the plugin names at runtime has no declaration to create it from, so the install asks
   * the product — after the plugin is in place, since only the installed plugin can name it — and
   * prepares what it answers like a declared one.
   */
  test("prepares the data directories the installed plugin names, once it is installed", async () => {
    let installedWhenAsked: boolean | undefined;
    await installPluginUnderTest(local, artifact(), {
      files: [RESTORE_FAMILY],
      db: {},
      resolveDataDirs: () => {
        installedWhenAsked = isActive();
        return Promise.resolve([
          "wp-content/uploads/backwpup-restore-0123456789abcdef0123",
        ]);
      },
    });
    expect(installedWhenAsked).toBe(true);
    const dir = join(
      wpRoot,
      "wp-content/uploads/backwpup-restore-0123456789abcdef0123",
    );
    expect((statSync(dir).mode & 0o777).toString(8)).toBe("777");
  });

  // Prepared and never removed would be worse than not prepared: the teardown removes only what the
  // declarations name.
  test("refuses a resolved directory no declaration covers, before creating it", async () => {
    await expect(
      installPluginUnderTest(local, artifact(), {
        files: [RESTORE_FAMILY],
        db: {},
        resolveDataDirs: () =>
          Promise.resolve(["wp-content/uploads/somewhere-else"]),
      }),
    ).rejects.toThrow(/somewhere-else.*never removed/s);
    expect(existsSync(join(wpRoot, "wp-content/uploads/somewhere-else"))).toBe(
      false,
    );
  });

  // Asking boots WordPress over WP-CLI as the transport's user, so it must come before any directory
  // is handed to the site — not after, where whatever that boot writes would keep the wrong owner.
  test("asks before preparing any data directory", async () => {
    let declaredExistedWhenAsked: boolean | undefined;
    await installPluginUnderTest(local, artifact(), {
      files: ["wp-content/uploads/backwpup", RESTORE_FAMILY],
      db: {},
      resolveDataDirs: () => {
        declaredExistedWhenAsked = existsSync(
          join(wpRoot, "wp-content/uploads/backwpup"),
        );
        return Promise.resolve([]);
      },
    });
    expect(declaredExistedWhenAsked).toBe(false);
    expect(existsSync(join(wpRoot, "wp-content/uploads/backwpup"))).toBe(true);
  });

  // An install whose directories cannot be prepared is not ready, so a resolver that cannot answer
  // fails it — with nothing opened up yet.
  test("fails the install when the plugin cannot be asked, preparing nothing", async () => {
    await expect(
      installPluginUnderTest(local, artifact(), {
        files: ["wp-content/uploads/backwpup", RESTORE_FAMILY],
        db: {},
        resolveDataDirs: () =>
          Promise.reject(new Error("the site could not be asked")),
      }),
    ).rejects.toThrow("the site could not be asked");
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });

  // Each install draws the name afresh (the plugin keeps it in an option the install's sweep
  // removes), so a reinstall must ask again rather than reuse the first answer.
  test("asks again on every install", async () => {
    let asked = 0;
    const residue: DeclaredResidue = {
      files: [RESTORE_FAMILY],
      db: {},
      resolveDataDirs: () => {
        asked++;
        return Promise.resolve([]);
      },
    };
    await installPluginUnderTest(local, artifact(), residue);
    await replacePluginUnderTest(local, artifact(), residue);
    expect(asked).toBe(2);
  });

  test("prepares nothing when the product declares no data paths", async () => {
    await installPluginUnderTest(local, artifact());
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });

  test("skips the removal entirely when the plugin is absent", async () => {
    await installPluginUnderTest(local, artifact());
    expect(
      wpCalls().filter((call) => call.startsWith("plugin uninstall")),
    ).toEqual([]);
    expect(
      wpCalls().some((c) => /^plugin install .* --activate$/.test(c)),
    ).toBe(true);
    expect(isActive()).toBe(true);
  });

  /**
   * The defect the sweep exists for. A run interrupted between a plugin's uninstall and its teardown —
   * or one ended with the `uninstall --deactivate` this suite forbids — leaves the plugin's rows
   * behind with no files to explain them. `is-installed` is a *file* test, so the removal above is
   * skipped and, before this sweep, the install landed straight on top of the previous run's state.
   */
  test("clears a leftover footprint even though there is no plugin to uninstall", async () => {
    seedDbResidue();

    await installPluginUnderTest(local, artifact(), bothResidue());

    expect(hasDbResidue()).toBe(false);
    expect(
      wpCalls().filter((call) => call.startsWith("plugin uninstall")),
    ).toEqual([]);
    expect(isActive()).toBe(true);
  });

  // Ordering is the whole guarantee: measured on a cell, a plugin that is still installed re-creates
  // every row of its own footprint on the next request, so a sweep before the removal achieves
  // nothing and a sweep after the install undoes the install's own work.
  test("sweeps the footprint after the removal and before the install", async () => {
    seedInstalled();
    seedDbResidue();

    await installPluginUnderTest(local, artifact(), bothResidue());

    const calls = wpCalls();
    const uninstalled = calls.findIndex((c) =>
      c.startsWith("plugin uninstall"),
    );
    const swept = calls.findIndex((c) => c.includes("leftover-footprint"));
    const installed = calls.findIndex((c) => c.startsWith("plugin install"));
    expect(uninstalled).toBeGreaterThanOrEqual(0);
    expect(swept).toBeGreaterThan(uninstalled);
    expect(installed).toBeGreaterThan(swept);
  });

  // A clean site is the common case and must not pay for the recovery path: one read, no writes.
  test("costs a single read on a site with no leftover footprint", async () => {
    await installPluginUnderTest(local, artifact(), bothResidue());

    const footprint = wpCalls().filter((c) => c.includes("leftover-footprint"));
    expect(footprint).toHaveLength(1);
    expect(footprint[0]).not.toContain("delete_option");
  });

  test("fails loudly when the install fails, rather than leaving a plugin-less scenario", async () => {
    process.env.WP_STUB_FAIL = "plugin install";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      /install .* failed/,
    );
  });

  // A product that declares no footprint must not pay a round-trip discovering that.
  test("asks the site nothing when the product declares no footprint", async () => {
    await installPluginUnderTest(local, artifact(), files());
    expect(wpCalls().some((c) => c.includes("leftover-footprint"))).toBe(false);
  });

  test("fails when a stale copy cannot be removed, so no scenario runs on a dirty baseline", async () => {
    seedInstalled();
    // A plugin that will not deactivate: a removal cleanup cannot heal, unlike a failed uninstall.
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      /could not be deactivated/,
    );
  });

  test("fails when the plugin installs but never becomes active", async () => {
    // The failure an exit code alone would miss. It is also how a zip whose top-level directory
    // is not the promised slug shows up: `is-active <slug>` simply never becomes true.
    process.env.WP_STUB_SILENT_ACTIVATE_FAIL = "1";
    await expect(installPluginUnderTest(local, artifact())).rejects.toThrow(
      PluginActivationFailedError,
    );
  });
});

// The order of the two checks around the install is what makes "new" mean "this install's": read
// through a recording `sh` ahead of the system's, whose lines land in the stub `wp`'s log, interleaved.
test.describe("installPluginUnderTest — install outputs", () => {
  let shDir: string;
  let pathBefore: string;

  test.beforeEach(() => {
    shDir = mkdtempSync(join(tmpdir(), "sh-stub-"));
    writeFileSync(
      join(shDir, "sh"),
      `#!/bin/bash\nprintf 'sh %s\\n' "$3" >> "$WP_STUB_ARGV_FILE"\nexec /bin/sh "$@"\n`,
    );
    chmodSync(join(shDir, "sh"), 0o755);
    pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${shDir}:${pathBefore}`;
  });

  test.afterEach(() => {
    process.env.PATH = pathBefore;
    rmSync(shDir, { recursive: true, force: true });
  });

  test("checks once right before the install and once after the active-state re-assert", async () => {
    process.env.WP_STUB_ACTIVATION_OUTPUT = join(
      wpRoot,
      "wp-content/e2e-cache",
    );
    await installPluginUnderTest(local, artifact(), {
      ...files(),
      installOutputs: ["wp-content/e2e-cache"],
    });

    const calls = wpCalls();
    const checks = calls.flatMap((c, i) =>
      c === "sh e2e-install-outputs" ? [i] : [],
    );
    const installed = calls.findIndex((c) => c.startsWith("plugin install "));
    const active = calls.indexOf("plugin is-active backwpup-pro");
    expect(checks).toEqual([installed - 1, active + 1]);
    expect(existsSync(join(wpRoot, "wp-content/e2e-cache"))).toBe(true);
  });

  test("a product that declares none runs no check, with or without an empty list", async () => {
    await installPluginUnderTest(local, artifact());
    await replacePluginUnderTest(local, artifact(), {
      ...files(),
      installOutputs: [],
    });
    expect(wpCalls().filter((c) => c.startsWith("sh "))).toEqual([]);
  });

  test("a reinstall part-way checks too", async () => {
    await replacePluginUnderTest(local, artifact(), {
      ...files(),
      installOutputs: ["wp-content/e2e-cache"],
    });
    expect(wpCalls().filter((c) => c.startsWith("sh "))).toEqual([
      "sh e2e-install-outputs",
      "sh e2e-install-outputs",
    ]);
  });

  test("no check runs when the plugin never becomes active: the install fails first", async () => {
    process.env.WP_STUB_SILENT_ACTIVATE_FAIL = "1";
    await expect(
      installPluginUnderTest(local, artifact(), {
        ...files(),
        installOutputs: ["wp-content/e2e-cache"],
      }),
    ).rejects.toThrow(PluginActivationFailedError);
    expect(wpCalls().filter((c) => c.startsWith("sh "))).toEqual([
      "sh e2e-install-outputs",
    ]);
  });
});

test.describe("teardownPluginUnderTest", () => {
  test("removes the plugin and attaches nothing when the log is clean", async () => {
    seedInstalled();
    const report = reportSink();

    await teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report);

    expect(isInstalled()).toBe(false);
    expect(report.attached.size).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("fails the scenario on a PHP fatal and attaches the log", async () => {
    process.env.WP_STUB_LOG =
      "[28-Jul-2026 10:00:00 UTC] PHP Fatal error:  Uncaught Error: boom in /wp-content/plugins/backwpup-pro/x.php:12\n";

    const report = reportSink();
    const failure = await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      files(),
      report,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DebugLogFatalError);
    expect((failure as DebugLogFatalError).message).toContain(
      "Uncaught Error: boom",
    );
    expect(report.attached.get("debug.log")).toContain("PHP Fatal error");
  });

  test("still removes the plugin when the log gate fails", async () => {
    seedInstalled();
    process.env.WP_STUB_LOG = "PHP Parse error: syntax error\n";

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), reportSink()),
    ).rejects.toThrow(DebugLogFatalError);

    // The fatal must not cost the next scenario its clean site.
    expect(isInstalled()).toBe(false);
  });

  test("reports warnings and notices without failing the scenario", async () => {
    process.env.WP_STUB_LOG =
      "PHP Warning:  something odd\nPHP Deprecated:  old call\n";
    const report = reportSink();

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report),
    ).resolves.toBeUndefined();
    // Named, so the line is traceable to its scenario when workers share a terminal.
    expect(warnings.join("\n")).toMatch(
      new RegExp(
        `debug\\.log for "${SCENARIO_TITLE}": 1 warning\\(s\\), 1 notice\\(s\\)`,
      ),
    );
    // Noise alone does not bloat the report with a log attachment.
    expect(report.attached.size).toBe(0);
  });

  test("honours the product's ignore preset", async () => {
    process.env.WP_STUB_LOG = "PHP Fatal error:  known-benign teardown race\n";
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        { ignore: [/known-benign/] },
        files(),
        reportSink(),
      ),
    ).resolves.toBeUndefined();
  });

  test("attaches the log when the scenario failed for an unrelated reason", async () => {
    process.env.WP_STUB_LOG = "PHP Notice:  undefined index\n";
    const report = reportSink(true);

    await teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report);

    // The log is usually where a failing scenario's real cause is.
    expect(report.attached.get("debug.log")).toContain("PHP Notice");
  });

  test("throws a cleanup failure when it is the only failure", async () => {
    seedInstalled();
    // A plugin that will not deactivate: a removal cleanup cannot heal, unlike a failed uninstall.
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), reportSink()),
    ).rejects.toThrow(/could not be deactivated/);
  });

  test("prefers the fatal over a cleanup failure, but logs the cleanup failure too", async () => {
    seedInstalled();
    // A plugin that will not deactivate: a removal cleanup cannot heal, unlike a failed uninstall.
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), reportSink()),
    ).rejects.toThrow(DebugLogFatalError);
    // Secondary, but never silent.
    expect(errors.join("\n")).toMatch(/a cleanup step also failed/);
  });

  // The third duty. It exists because uninstalling a plugin does not delete what it wrote, so the
  // site would otherwise collect one copy of the product's output per scenario.
  test("clears the leftovers the product declared", async () => {
    seedInstalled();
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(join(leftovers, "abc123/backups"), { recursive: true });
    writeFileSync(join(leftovers, "abc123/backups/site.tar"), "x");

    await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      files("wp-content/uploads/backwpup"),
      reportSink(),
    );

    expect(existsSync(leftovers)).toBe(false);
  });

  /**
   * Teardown's own half of that duty: the uninstall is what normally clears a plugin's rows, so anything
   * still there afterwards outlived it — a table re-created by a request that finished after the
   * uninstall, or the rows a run killed mid-teardown never reached. Swept here so the cell is left
   * clean rather than left for the next run's install to trip over.
   */
  test("clears a leftover footprint the plugin's own uninstall did not take with it", async () => {
    seedInstalled();
    seedDbResidue();

    await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      bothResidue(),
      reportSink(),
    );

    expect(hasDbResidue()).toBe(false);
    expect(isInstalled()).toBe(false);
  });

  // Same independence the filesystem sweep has, for the same reason: the runs that fail to uninstall
  // are the ones most likely to have left rows behind.
  test("clears the footprint even when the plugin removal fails", async () => {
    seedInstalled();
    seedDbResidue();
    // A plugin that will not deactivate: a removal cleanup cannot heal, unlike a failed uninstall.
    process.env.WP_STUB_STUCK_ACTIVE = "1";

    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        bothResidue(),
        reportSink(),
      ),
    ).rejects.toThrow(/could not be deactivated/);

    expect(hasDbResidue()).toBe(false);
  });

  // The property this duty is built around: the runs that fail to uninstall are exactly the ones
  // most likely to have left a mess, so the sweep must not be conditional on the removal.
  test("clears them even when the plugin removal fails", async () => {
    seedInstalled();
    // A plugin that will not deactivate: a removal cleanup cannot heal, unlike a failed uninstall.
    process.env.WP_STUB_STUCK_ACTIVE = "1";
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(leftovers, { recursive: true });

    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        files("wp-content/uploads/backwpup"),
        reportSink(),
      ),
    ).rejects.toThrow(/could not be deactivated/);

    expect(existsSync(leftovers)).toBe(false);
  });

  // Leftovers the transport's user is not *permitted* to remove are an ownership fact about the
  // cell, not something the scenario did — and they break no later scenario, unlike a half-removed
  // plugin. Failing every run over them would be a poor trade, so they are reported instead.
  test("reports a leftover it is not allowed to remove, without failing the scenario", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    seedInstalled();
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(join(leftovers, "abc123"), { recursive: true });
    chmodSync(leftovers, 0o500);
    const report = reportSink();
    try {
      await expect(
        // Unprivileged on purpose: the sweep escalates when it can, so allowing it here would make
        // the outcome depend on whether this machine has passwordless sudo (CI does).
        teardownPluginUnderTest(
          { ...local, elevate: false },
          "backwpup-pro",
          {},
          files("wp-content/uploads/backwpup"),
          report,
        ),
      ).resolves.toBeUndefined();

      // Loud enough to act on, in the run output and in the report.
      expect(warnings.join("\n")).toContain(leftovers);
      expect(report.attached.get("uncleared-site-data")).toContain(leftovers);
    } finally {
      if (existsSync(leftovers)) chmodSync(leftovers, 0o700);
    }
  });

  // The other half of that split: a path we should never have declared is our own defect, and is
  // thrown rather than warned about.
  test("throws when a declared residue path is not a usable one", async () => {
    seedInstalled();
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        files("wp-content/uploads"),
        reportSink(),
      ),
    ).rejects.toThrow(/WordPress itself owns/);
  });

  test("a fatal still outranks an unusable residue declaration", async () => {
    seedInstalled();
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";
    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        files("../escape"),
        reportSink(),
      ),
    ).rejects.toThrow(DebugLogFatalError);
    expect(errors.join("\n")).toMatch(/a cleanup step also failed/);
  });

  test("an attachment fault never replaces the verdict", async () => {
    process.env.WP_STUB_LOG = "PHP Fatal error:  boom\n";
    const failing: ScenarioReport = {
      title: SCENARIO_TITLE,
      failed: false,
      attach: () => Promise.reject(new Error("reporter is gone")),
    };

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), failing),
    ).rejects.toThrow(DebugLogFatalError);
    expect(warnings.join("\n")).toMatch(/could not attach debug\.log/);
  });
});

/** What a product's stop function saw of the site when it was called. */
interface StopCall {
  readonly installed: boolean;
  readonly callsBefore: readonly string[];
}

/** A stop function that records the moment it ran, then answers `answer`. */
function recordingStop(
  calls: StopCall[],
  answer: () => Promise<string | undefined>,
): StopRunningWork {
  return () => {
    calls.push({ installed: isInstalled(), callsBefore: wpCalls() });
    return answer();
  };
}

test.describe("teardownPluginUnderTest — work the plugin left running", () => {
  // A product's stop asks the plugin itself; a copy every boot dies on can run nothing, so its stop
  // failing must not claim the verdict from the uninstall the copy is really failing.
  test("reports a stop that fails on a copy WordPress cannot boot, then heals and fails on its uninstall", async () => {
    seedInstalled();
    process.env.WP_STUB_UNBOOTABLE = "1";
    process.env.WP_STUB_FAIL = "plugin uninstall";
    const report = reportSink();

    const failure = await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      files(),
      report,
      () =>
        Promise.reject(new Error("reading what BackWPup is running failed")),
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PluginUninstallBrokenError);
    expect(report.attached.get("stopped-running-work")).toBe(
      `[hooks] after "${SCENARIO_TITLE}": its running work could not be asked about, and none can ` +
        'run: WordPress cannot boot with "backwpup-pro" loaded (Fatal error: Uncaught Error: Class ' +
        "BerlinDB not found), and boots without it. The plugin is removed next.",
    );
    expect(existsSync(pluginDir())).toBe(false);
  });

  test("keeps a stop that fails on a WordPress that boots as the teardown's failure", async () => {
    seedInstalled();
    const report = reportSink();

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report, () =>
        Promise.reject(new Error("reading what BackWPup is running failed")),
      ),
    ).rejects.toThrow("reading what BackWPup is running failed");
    expect(report.attached.has("stopped-running-work")).toBe(false);
    // The removal still ran: every duty does.
    expect(existsSync(pluginDir())).toBe(false);
  });

  // The whole point of the duty: the work has to be stopped while the plugin that runs it is still
  // there, and after the log has been judged as the scenario left it.
  test("asks the product to stop its work after the log is judged and before the plugin is removed", async () => {
    seedInstalled();
    const calls: StopCall[] = [];
    const report = reportSink();

    await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      files(),
      report,
      recordingStop(calls, () => Promise.resolve(undefined)),
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.installed).toBe(true);
    expect(
      call?.callsBefore.some((line) =>
        /^--skip-plugins --skip-themes eval .*debug\.log/.test(line),
      ),
    ).toBe(true);
    expect(
      call?.callsBefore.some((line) => line.startsWith("plugin uninstall")),
    ).toBe(false);
    // An idle site is the common case, and it says nothing.
    expect(report.attached.size).toBe(0);
    expect(warnings).toEqual([]);
    expect(isInstalled()).toBe(false);
  });

  test("reports what it had to stop, without failing the scenario", async () => {
    seedInstalled();
    const report = reportSink();

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report, () =>
        Promise.resolve("a backup of job 3 was still running"),
      ),
    ).resolves.toBeUndefined();

    expect(warnings.join("\n")).toContain(
      `after "${SCENARIO_TITLE}": a backup of job 3 was still running`,
    );
    expect(report.attached.get("stopped-running-work")).toContain(
      "a backup of job 3 was still running",
    );
    expect(isInstalled()).toBe(false);
  });

  // Independence, as for every other duty: a site whose work would not stop still gets its plugin
  // and its leftovers removed, and the failure is the one reported.
  test("work that would not stop is a cleanup failure, and every later duty still runs", async () => {
    seedInstalled();
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(leftovers, { recursive: true });

    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        files("wp-content/uploads/backwpup"),
        reportSink(),
        () => Promise.reject(new Error("the job would not stop")),
      ),
    ).rejects.toThrow("the job would not stop");

    expect(isInstalled()).toBe(false);
    expect(existsSync(leftovers)).toBe(false);
  });

  test("a fatal still outranks work that would not stop", async () => {
    seedInstalled();
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";

    await expect(
      teardownPluginUnderTest(
        local,
        "backwpup-pro",
        {},
        files(),
        reportSink(),
        () => Promise.reject(new Error("the job would not stop")),
      ),
    ).rejects.toThrow(DebugLogFatalError);
    expect(errors.join("\n")).toMatch(
      /a cleanup step also failed.*the job would not stop/,
    );
  });

  test("a reporter fault while reporting stopped work is only a warning", async () => {
    seedInstalled();
    const failing: ScenarioReport = {
      title: SCENARIO_TITLE,
      failed: false,
      attach: () => Promise.reject(new Error("reporter is gone")),
    };

    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), failing, () =>
        Promise.resolve("a backup of job 3 was still running"),
      ),
    ).resolves.toBeUndefined();
    expect(warnings.join("\n")).toMatch(
      /could not attach the stopped-work report: reporter is gone/,
    );
  });
});

/**
 * A run that was killed never reached its teardown, and the work it started (a backup job, in a web
 * request of its own) can outlive it. The next scenario's install is then the first chance to stop
 * that work, and the install's removal of the plugin would otherwise race it.
 */
test.describe("installPluginUnderTest — work an earlier run left running", () => {
  test("stops it after the log is cleared and before the stale copy is removed", async () => {
    seedInstalled();
    const calls: StopCall[] = [];
    const report = reportSink();

    await installPluginUnderTest(local, artifact(), files(), {
      stop: recordingStop(calls, () => Promise.resolve(undefined)),
      report,
    });

    expect(calls).toHaveLength(1);
    const [call] = calls;
    // Asked while the plugin that runs the work is still there…
    expect(call?.installed).toBe(true);
    // …after the log was cleared, so anything the stop makes PHP write is this scenario's to judge…
    expect(call?.callsBefore).toHaveLength(1);
    expect(call?.callsBefore[0]).toMatch(
      /^--skip-plugins --skip-themes eval .*debug\.log/,
    );
    // …and the install still went ahead on an idle site, which says nothing.
    expect(wpCalls().some((c) => c.startsWith("plugin uninstall"))).toBe(true);
    expect(isActive()).toBe(true);
    expect(report.attached.size).toBe(0);
    // The stub site's own housekeeping warns (no ownership to read); only the hooks' lines matter.
    expect(warnings.filter((line) => line.startsWith("[hooks]"))).toEqual([]);
  });

  // The product's probe copes with a site without the plugin (it answers "idle"), so a fresh site
  // pays that one probe and nothing else.
  test("asks even when the plugin is absent, and installs as usual", async () => {
    const calls: StopCall[] = [];

    await installPluginUnderTest(local, artifact(), files(), {
      stop: recordingStop(calls, () => Promise.resolve(undefined)),
      report: reportSink(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.installed).toBe(false);
    expect(isActive()).toBe(true);
  });

  // An earlier run's work is not this scenario's fault: seen, attached, never failed.
  test("reports what it had to stop, naming the scenario about to begin, and installs", async () => {
    seedInstalled();
    const report = reportSink();

    await installPluginUnderTest(local, artifact(), files(), {
      stop: () => Promise.resolve("a backup of job 3 was still running"),
      report,
    });

    expect(warnings.join("\n")).toContain(
      `before "${SCENARIO_TITLE}": a backup of job 3 was still running`,
    );
    expect(report.attached.get("stopped-running-work")).toContain(
      `before "${SCENARIO_TITLE}"`,
    );
    expect(isActive()).toBe(true);
  });

  // Installing over work that is still writing to the site would hand the scenario a site nobody can
  // vouch for, so this fails the Before hook — and touches nothing, so the teardown (which still
  // runs) gets the site exactly as the stop left it.
  test("fails when the work would not stop, removing and installing nothing", async () => {
    seedInstalled();

    await expect(
      installPluginUnderTest(local, artifact(), files(), {
        stop: () => Promise.reject(new Error("the job would not stop")),
        report: reportSink(),
      }),
    ).rejects.toThrow("the job would not stop");

    expect(
      wpCalls().some(
        (c) =>
          c.startsWith("plugin uninstall") || c.startsWith("plugin install"),
      ),
    ).toBe(false);
    expect(isInstalled()).toBe(true);
  });

  // A stop whose WP-CLI call hangs must not run the hook out of time: a timed-out hook is abandoned,
  // and its removal would go on beside the teardown.
  test("fails a stop that does not settle within its allowance, removing and installing nothing", async () => {
    seedInstalled();

    await expect(
      installPluginUnderTest(local, artifact(), files(), {
        stop: () => new Promise<never>(() => undefined),
        report: reportSink(),
        budgetMs: 50,
      }),
    ).rejects.toThrow(
      "stopping the plugin's running work had not finished after 0.05 s",
    );

    expect(
      wpCalls().some(
        (c) =>
          c.startsWith("plugin uninstall") || c.startsWith("plugin install"),
      ),
    ).toBe(false);
    expect(isInstalled()).toBe(true);
  });
});

/**
 * What a removal stopped part-way leaves — part of the plugin at its path — costs at most the
 * scenario that left it: cleanup removes it by path, before the install and after the scenario, and
 * says so every time.
 */
test.describe("a plugin folder WordPress cannot see", () => {
  test("is removed before the install, reported, and the install goes ahead", async () => {
    seedOrphaned();
    const report = reportSink();

    await installPluginUnderTest(
      local,
      artifact(),
      bothResidue(),
      undefined,
      report,
    );

    expect(isInstalled()).toBe(true);
    const attached = report.attached.get("leftover-plugin-files") ?? "";
    expect(attached).toContain(`before "${SCENARIO_TITLE}"`);
    expect(attached).toContain(
      `${pluginDir()}: a folder WordPress lists no plugin in, 4 entries (src, vendor)`,
    );
    expect(attached).toMatch(/PHP-FPM restart or a reboot/);
    expect(warnings).toContain(attached);
  });

  // The folder goes before the database sweep, and both before the install: a plugin removed by path
  // after its uninstall failed leaves exactly the rows that sweep takes.
  test("is inspected and removed before the database sweep and the install", async () => {
    seedOrphaned();
    await installPluginUnderTest(local, artifact(), bothResidue());
    const order = wpCalls().map((call) =>
      call.includes("get_plugins")
        ? "inspect"
        : call.includes("leftover-footprint")
          ? "sweep"
          : call.startsWith("plugin install")
            ? "install"
            : "other",
    );
    const first = (step: (typeof order)[number]): number => order.indexOf(step);
    expect(first("inspect")).toBeGreaterThanOrEqual(0);
    expect(first("inspect")).toBeLessThan(first("sweep"));
    expect(first("sweep")).toBeLessThan(first("install"));
  });

  test("is reported by a reinstall part-way too, which has no scenario to attach to", async () => {
    seedOrphaned();
    await replacePluginUnderTest(local, artifact(), files());
    expect(isInstalled()).toBe(true);
    expect(warnings.join("\n")).toContain(
      "[hooks] before installing, removed a plugin folder WordPress no longer lists",
    );
  });

  /**
   * The copy's uninstall fatal lands in the `debug.log` the Before hook has just cleared; left there, the
   * teardown would fail the scenario about to run for what an earlier run left behind (seen live).
   */
  test("clears debug.log again once a copy whose uninstall failed is healed, before the install", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    await installPluginUnderTest(
      local,
      artifact(),
      files(),
      undefined,
      reportSink(),
    );
    const calls = wpCalls();
    const clears = calls.flatMap((call, i) =>
      call.includes("@unlink") ? [i] : [],
    );
    expect(clears).toHaveLength(2);
    expect(clears[1]).toBeGreaterThan(
      calls.findIndex((call) => call.startsWith("plugin uninstall")),
    );
    expect(clears[1]).toBeLessThan(
      calls.findIndex((call) => call.startsWith("plugin install")),
    );
  });

  // Only that fatal is the earlier run's: anything else the removal logs stays for the verdict.
  test("clears debug.log once when the old copy came off cleanly", async () => {
    seedInstalled();
    await installPluginUnderTest(local, artifact(), files());
    expect(wpCalls().filter((call) => call.includes("@unlink"))).toHaveLength(
      1,
    );
  });

  test("is removed after the scenario and reported, without failing it", async () => {
    seedOrphaned();
    const report = reportSink();

    await teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report);

    expect(existsSync(pluginDir())).toBe(false);
    expect(report.attached.get("leftover-plugin-files")).toContain(
      `after "${SCENARIO_TITLE}"`,
    );
  });

  // After the scenario the copy is the artifact under test: healed, so later scenarios run, but its
  // uninstall failing is the product's failure, and the log was judged before it could show there.
  test("heals a plugin whose uninstall fails, and fails the scenario naming that uninstall's error", async () => {
    seedInstalled();
    seedDbResidue();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(leftovers, { recursive: true });
    const report = reportSink();
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map(String).join(" "));
    };

    const failure = await teardownPluginUnderTest(
      local,
      "backwpup-pro",
      {},
      bothResidue("wp-content/uploads/backwpup"),
      report,
    )
      .catch((error: unknown) => error)
      .finally(() => {
        console.warn = realWarn;
      });

    expect(failure).toBeInstanceOf(PluginUninstallBrokenError);
    expect((failure as Error).message).toContain(
      'Plugin "backwpup-pro" could not be uninstalled by WordPress: stub: refusing plugin uninstall backwpup-pro',
    );
    expect(existsSync(pluginDir())).toBe(false);
    expect(isActive()).toBe(false);
    // What happened is said as it happened: this teardown's uninstall failed, no earlier removal.
    expect(report.attached.get("leftover-plugin-files")).toContain(
      `after "${SCENARIO_TITLE}", the plugin's own uninstall failed in this scenario's teardown ` +
        "(stub: refusing plugin uninstall backwpup-pro), so it was removed by path:",
    );
    expect(warned.join("\n")).toMatch(
      /\[hooks\] after the scenario, cleared a leftover plugin footprint from the site: \d+ option\(s\), \d+ table\(s\)\. The plugin's own uninstall failed in this scenario's teardown, so it could not remove them\./,
    );
    expect(warned.join("\n")).not.toContain("earlier run");
    expect(warned.join("\n")).not.toContain("stopped part-way");
    // A cleanup failure like any other: the duties after it still run.
    expect(hasDbResidue()).toBe(false);
    expect(existsSync(leftovers)).toBe(false);
  });

  test("a fatal still outranks a failed uninstall, which is logged", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";
    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), reportSink()),
    ).rejects.toThrow(DebugLogFatalError);
    expect(errors.join("\n")).toContain(
      'Plugin "backwpup-pro" could not be uninstalled by WordPress',
    );
  });

  // The copy before a scenario is an earlier run's, whose teardown already failed on it.
  test("only reports a failed uninstall before the scenario, and installs", async () => {
    seedInstalled();
    process.env.WP_STUB_FAIL = "plugin uninstall";
    const report = reportSink();
    await installPluginUnderTest(local, artifact(), files(), undefined, report);
    expect(isInstalled()).toBe(true);
    expect(report.attached.get("leftover-plugin-files")).toContain(
      "that copy is an earlier run's",
    );
  });

  test("clears debug.log only once before installing over an orphaned folder", async () => {
    seedOrphaned();
    await installPluginUnderTest(local, artifact(), files());
    expect(wpCalls().filter((call) => call.includes("@unlink"))).toHaveLength(
      1,
    );
  });

  test("a reporter fault while reporting a cleared folder is only a warning, before and after", async () => {
    const failing: ScenarioReport = {
      title: SCENARIO_TITLE,
      failed: false,
      attach: () => Promise.reject(new Error("reporter down")),
    };
    seedOrphaned();
    await installPluginUnderTest(
      local,
      artifact(),
      files(),
      undefined,
      failing,
    );
    expect(isInstalled()).toBe(true);
    process.env.WP_STUB_FAIL = "plugin uninstall";
    await expect(
      teardownPluginUnderTest(local, "backwpup-pro", {}, files(), failing),
    ).rejects.toBeInstanceOf(PluginUninstallBrokenError);
    seedOrphaned();
    await teardownPluginUnderTest(local, "backwpup-pro", {}, files(), failing);
    expect(
      warnings.filter((line) =>
        line.includes(
          "could not attach the leftover-plugin-files report: reporter down",
        ),
      ),
    ).toHaveLength(3);
  });

  test("a folder that cannot be removed fails the install before anything is installed", async () => {
    test.skip(isRoot, "root ignores directory permissions");
    seedOrphaned();
    chmodSync(join(pluginDir(), "vendor", "berlindb"), 0o555);
    try {
      await expect(
        installPluginUnderTest(local, artifact(), files()),
      ).rejects.toBeInstanceOf(PluginDirRemovalFailedError);
      expect(wpCalls().some((call) => call.startsWith("plugin install"))).toBe(
        false,
      );
    } finally {
      chmodSync(join(pluginDir(), "vendor", "berlindb"), 0o755);
    }
  });

  test("a folder that cannot be removed fails the teardown, every later duty still runs, and a fatal outranks it", async () => {
    test.skip(isRoot, "root ignores directory permissions");
    seedOrphaned();
    seedDbResidue();
    chmodSync(join(pluginDir(), "vendor", "berlindb"), 0o555);
    const leftovers = join(wpRoot, "wp-content/uploads/backwpup");
    mkdirSync(leftovers, { recursive: true });
    const residue = bothResidue("wp-content/uploads/backwpup");
    try {
      await expect(
        teardownPluginUnderTest(
          local,
          "backwpup-pro",
          {},
          residue,
          reportSink(),
        ),
      ).rejects.toBeInstanceOf(PluginDirRemovalFailedError);
      expect(hasDbResidue()).toBe(false);
      expect(existsSync(leftovers)).toBe(false);

      process.env.WP_STUB_LOG = "PHP Fatal error:  the real defect\n";
      await expect(
        teardownPluginUnderTest(
          local,
          "backwpup-pro",
          {},
          residue,
          reportSink(),
        ),
      ).rejects.toThrow(DebugLogFatalError);
      expect(errors.join("\n")).toContain(
        "a cleanup step also failed, after the failure reported above: The plugin folder",
      );
    } finally {
      chmodSync(join(pluginDir(), "vendor", "berlindb"), 0o755);
    }
  });

  test("reports nothing on a site that was left clean", async () => {
    const report = reportSink();
    await installPluginUnderTest(local, artifact(), files(), undefined, report);
    await teardownPluginUnderTest(local, "backwpup-pro", {}, files(), report);
    expect(report.attached.has("leftover-plugin-files")).toBe(false);
    expect(warnings.join("\n")).not.toContain("plugin folder");
  });
});

test.describe("clearedPluginDirMessage", () => {
  const dir = {
    kind: "orphaned",
    path: "/srv/site/wp-content/plugins/backwpup-pro",
    type: "directory",
    entries: 3830,
    topLevel: 6,
    sample: ["assets", "config", "inc", "pro", "src", "vendor"],
    owner: "www-data",
    ageSeconds: 7200,
  } as const;

  test("names the moment, what was there and the likely cause", () => {
    expect(
      clearedPluginDirMessage(
        { dir, cause: "unlisted" },
        "before",
        "A backup runs",
      ),
    ).toBe(
      '[hooks] before "A backup runs", removed a plugin folder WordPress no longer lists: ' +
        "/srv/site/wp-content/plugins/backwpup-pro: a folder WordPress lists no plugin in, 3830 " +
        "entries (assets, config, inc, pro, src, vendor); owner www-data; last changed 2 h ago. " +
        "Likely cause: a removal stopped part-way — e.g. by a PHP-FPM restart or a reboot — leaves " +
        "part of a plugin; left there, it would have blocked every later install.",
    );
  });

  test("says why WordPress's own uninstall could not do it, and whose failure it is", () => {
    const cleared = {
      dir: { ...dir, kind: "recognised" },
      cause: "uninstall-failed",
      uninstallError: "PHP Fatal error:  x",
    } as const;
    // After the scenario the copy is the one this scenario installed: its own uninstall failed now.
    expect(clearedPluginDirMessage(cleared, "after")).toBe(
      "[hooks] after the scenario, the plugin's own uninstall failed in this scenario's teardown " +
        "(PHP Fatal error:  x), so it was removed by path: /srv/site/wp-content/plugins/backwpup-pro: " +
        "a folder WordPress lists a plugin in, 3830 entries (assets, config, inc, pro, src, vendor); " +
        "owner www-data; last changed 2 h ago. The scenario fails on it; its database footprint is " +
        "swept next.",
    );
    expect(clearedPluginDirMessage(cleared, "before")).toContain(
      "cannot load what is gone — that copy is an earlier run's, whose teardown answers for it. Its " +
        "database footprint is swept next.",
    );
  });

  // Not a removal stopped part-way: the uninstall just run is what left it.
  test("says the plugin's own uninstall left what it removed, when it did", () => {
    const message = clearedPluginDirMessage(
      { dir, cause: "uninstall-left" },
      "after",
      "A backup runs",
    );
    expect(message).toMatch(
      /^\[hooks\] after "A backup runs", removed what the plugin's own uninstall left at its path, which WordPress no longer lists: \/srv/,
    );
    expect(message).toContain(
      "Likely cause: files the uninstall could not delete, or a removal stopped part-way",
    );
  });
});

test.describe("dbResidueMessage", () => {
  const removed = {
    options: ["a", "b"],
    tables: ["wp_t"],
    roles: [],
    capabilities: [],
  };

  test("before a scenario, blames an earlier run", () => {
    expect(dbResidueMessage(removed, "before", false)).toBe(
      "[hooks] before installing, cleared a leftover plugin footprint from the site: 2 option(s), " +
        "1 table(s). An earlier run's plugin files were removed without its uninstall ever running.",
    );
  });

  test("after one whose teardown's uninstall failed, says that uninstall could not remove them", () => {
    expect(dbResidueMessage(removed, "after", true)).toBe(
      "[hooks] after the scenario, cleared a leftover plugin footprint from the site: 2 option(s), " +
        "1 table(s). The plugin's own uninstall failed in this scenario's teardown, so it could not " +
        "remove them.",
    );
  });

  test("after one whose uninstall ran, says it left them or something re-created them", () => {
    expect(dbResidueMessage(removed, "after", false)).toBe(
      "[hooks] after the scenario, cleared a leftover plugin footprint from the site: 2 option(s), " +
        "1 table(s). The plugin's own uninstall did not remove them, or a request that outlived it " +
        "re-created them.",
    );
  });

  // A stale role is what makes a fresh install test capabilities the product no longer defines, so
  // the line names the roles, and says which roles held the capabilities it took back.
  test("names the roles it removed and the roles whose capabilities it took back", () => {
    const withRoles = {
      ...removed,
      roles: ["myplugin_admin", "myplugin_check"],
      capabilities: [
        { role: "administrator", capability: "myplugin" },
        { role: "administrator", capability: "myplugin_jobs" },
        { role: "shop_manager", capability: "myplugin" },
      ],
    };
    expect(dbResidueMessage(withRoles, "before", false)).toBe(
      "[hooks] before installing, cleared a leftover plugin footprint from the site: 2 option(s), " +
        "1 table(s), 2 role(s) (myplugin_admin, myplugin_check), 3 capability grant(s) on " +
        "administrator, shop_manager. An earlier run's plugin files were removed without its " +
        "uninstall ever running.",
    );
  });
});
