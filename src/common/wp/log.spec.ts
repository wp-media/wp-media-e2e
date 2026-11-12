import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  clearDebugLog,
  keepLogWritable,
  parseClearVerdict,
  readDebugLog,
  scanDebugLog,
} from "./log";
import type { ClearVerdict, KeepWritableOps } from "./log";
import type { OwnershipOutcome } from "./ownership";
import type { LocalTransport } from "../config/types";
import { SKIP_SUDO_OPTIONS } from "../__fixtures__/fake-sudo";

// Stub `wp`: `eval` echoes $WP_STUB_EVAL_OUT (exit 0), or simulates a broken WordPress bootstrap
// (exit 255) when $WP_STUB_EVAL=fail, or a PHP crash (killed by SIGSEGV) when $WP_STUB_EVAL=crash. `cat`/`rm` are NOT stubbed — the fallback uses the real
// ones — so a failing `eval` forces log.ts down its direct-file path. Leading `--skip-*` flags are
// read off first, as WP-CLI reads global flags; with $WP_STUB_BROKEN_PLUGIN, a boot that loads
// plugins dies on that plugin's fatal and — as WP_DEBUG_LOG does on a real site (measured) — writes it
// into the very log being read. $WP_STUB_CALLS records each call's argv.
const STUB_WP = `#!/usr/bin/env bash
[ -n "$WP_STUB_CALLS" ] && printf '%s\\n' "$*" >> "$WP_STUB_CALLS"
SKIPPED=""
while [[ "$1" == --skip-* ]]; do SKIPPED="$SKIPPED $1"; shift; done
if [ "$1" = "eval" ] && [ -n "$WP_STUB_BROKEN_PLUGIN" ] && [[ "$SKIPPED" != *--skip-plugins* ]]; then
  echo "PHP Fatal error:  Uncaught Error: Class BerlinDB not found in broken-plugin.php:12" >> wp-content/debug.log
  echo "Fatal error: Uncaught Error: Class BerlinDB not found" >&2
  exit 1
fi
if [ "$1" = "eval" ]; then
  if [ "$WP_STUB_EVAL" = "crash" ]; then
    kill -SEGV $$
  fi
  if [ "$WP_STUB_EVAL" = "fail" ]; then
    echo "PHP Fatal error: simulated bootstrap failure" >&2
    exit 255
  fi
  printf '%s' "$WP_STUB_EVAL_OUT"
  exit 0
fi
exit 0
`;

/**
 * What the clearing snippet prints as its last line, for the stub to answer with.
 *
 * @param state - what it did.
 * @param ours - whether the identity owns the log left.
 */
const verdictLine = (
  state: ClearVerdict["state"],
  ours: boolean | null = false,
): string =>
  `e2e-debug-log-clear ${JSON.stringify({ state, ours, path: "wp-content/debug.log" })}`;

let stubDir: string;
let wpRoot: string;
let originalPath: string;
let local: LocalTransport;

/**
 * True when the suite runs as root, which bypasses the permission bits the "cannot clear / cannot
 * read" tests rely on. Skipped there rather than failing for an environment reason.
 */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const debugLogPath = (): string => join(wpRoot, "wp-content", "debug.log");

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  // A WP-root-like dir whose wp-content/ holds the debug.log the fallback reads/removes.
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  mkdirSync(join(wpRoot, "wp-content"));
  local = { mode: "local", rootDir: wpRoot };
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(wpRoot, { recursive: true, force: true });
});

test.describe("debug.log — primary `wp eval` path", () => {
  test("readDebugLog returns what wp eval emits", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = "first line\nPHP Warning: something";
    expect(await readDebugLog(local)).toBe(
      "first line\nPHP Warning: something",
    );
  });

  test("scanDebugLog categorises lines by severity tier", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Fatal error: boom\nPHP Warning: slow\nPHP Notice: fyi\nall good";
    const scan = await scanDebugLog(local);
    expect(scan.fatals).toEqual(["PHP Fatal error: boom"]);
    expect(scan.warnings).toEqual(["PHP Warning: slow"]);
    expect(scan.notices).toEqual(["PHP Notice: fyi"]);
  });

  test("scanDebugLog `ignore` excludes matching lines from all categories", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Notice: a\nPHP Warning: b\nPHP Fatal error: boom";
    const scan = await scanDebugLog(local, { ignore: [/Notice/, /Warning/] });
    expect(scan.notices).toEqual([]);
    expect(scan.warnings).toEqual([]);
    expect(scan.fatals).toEqual(["PHP Fatal error: boom"]);
  });

  test("scanDebugLog `source` attributes entries by path, excluding other plugins", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT =
      "PHP Fatal error: boom in /var/www/html/wp-content/plugins/wp-rocket/inc/a.php on line 1\n" +
      "PHP Fatal error: other in /var/www/html/wp-content/plugins/backwpup/b.php on line 2\n" +
      "PHP Warning: w in /var/www/html/wp-content/plugins/wp-rocket/inc/c.php on line 3";
    const scan = await scanDebugLog(local, {
      source: [/wp-content\/plugins\/wp-rocket\//],
    });
    expect(scan.fatals).toEqual([
      "PHP Fatal error: boom in /var/www/html/wp-content/plugins/wp-rocket/inc/a.php on line 1",
    ]);
    expect(scan.warnings).toEqual([
      "PHP Warning: w in /var/www/html/wp-content/plugins/wp-rocket/inc/c.php on line 3",
    ]);
    // The BackWPup fatal is excluded by the source filter; `raw` still holds the full log.
    expect(scan.notices).toEqual([]);
    expect(scan.raw).toContain("backwpup");
  });
});

test.describe("debug.log — direct-file fallback when `wp eval` fails", () => {
  test("readDebugLog falls back to a direct read (and logs the fallback)", async () => {
    process.env.WP_STUB_EVAL = "fail"; // simulate a fatal that breaks WP bootstrap
    writeFileSync(debugLogPath(), "PHP Fatal error: captured via fallback");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      expect(await readDebugLog(local)).toBe(
        "PHP Fatal error: captured via fallback",
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings.some((w) => w.includes("falling back"))).toBe(true);
  });

  test("readDebugLog returns '' when the file is also absent", async () => {
    process.env.WP_STUB_EVAL = "fail";
    rmSync(debugLogPath(), { force: true });
    expect(await readDebugLog(local)).toBe("");
  });

  test("clearDebugLog removes the file directly", async () => {
    process.env.WP_STUB_EVAL = "fail";
    writeFileSync(debugLogPath(), "stale contents");
    await clearDebugLog(local);
    expect(existsSync(debugLogPath())).toBe(false);
  });

  // A crash has no exit code, so the exec layer throws; the log is then the one thing worth reading.
  test("readDebugLog falls back to a direct read when `wp eval` is killed by a signal", async () => {
    process.env.WP_STUB_EVAL = "crash";
    writeFileSync(debugLogPath(), "PHP Fatal error: logged before the crash");

    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      expect(await readDebugLog(local)).toBe(
        "PHP Fatal error: logged before the crash",
      );
    } finally {
      console.warn = originalWarn;
    }
    expect(warnings).toEqual([
      "[wp/log] `wp eval` could not read debug.log (killed by SIGSEGV); falling back to a direct " +
        "file read.",
    ]);
  });

  test("clearDebugLog removes the file directly when `wp eval` is killed by a signal", async () => {
    process.env.WP_STUB_EVAL = "crash";
    writeFileSync(debugLogPath(), "stale contents");
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await clearDebugLog(local);
    } finally {
      console.warn = originalWarn;
    }
    expect(existsSync(debugLogPath())).toBe(false);
  });

  // Only a crash is survived: a `wp` that cannot be started at all is a broken environment.
  test("readDebugLog still throws when `wp` cannot be started at all", async () => {
    const site: LocalTransport = {
      mode: "local",
      rootDir: join(wpRoot, "no such root"),
    };
    await expect(readDebugLog(site)).rejects.toThrow(/could not be started/);
  });
});

/**
 * The trap this module is built around: `wp eval` exits 0 whatever the PHP inside it did. A denied
 * write is a warning and nothing more, so an exit-code check reports a log that was never cleared
 * as cleared — and one scenario's fatal then fails every scenario after it.
 */
test.describe("debug.log — `wp eval` exits 0 even when its PHP failed", () => {
  test("a snippet reporting success is believed, and nothing else runs", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = `PHP Deprecated: noise\n${verdictLine("emptied")}`;
    writeFileSync(debugLogPath(), "left alone by the stub");
    await clearDebugLog(local);
    // The stub removes nothing, so the file surviving proves the fallback was skipped.
    expect(existsSync(debugLogPath())).toBe(true);
    rmSync(debugLogPath(), { force: true });
  });

  // Only the snippet's own marked verdict counts: anything else at exit 0 is not believed.
  test("a reply without the snippet's verdict falls back, despite the zero exit", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = "cleared";
    writeFileSync(debugLogPath(), "stale contents");
    const originalWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await clearDebugLog(local);
    } finally {
      console.warn = originalWarn;
    }
    expect(existsSync(debugLogPath())).toBe(false);
  });

  test("a snippet reporting failure falls back, despite the zero exit", async () => {
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = verdictLine("kept", null);
    writeFileSync(debugLogPath(), "stale contents");
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warnings.push(args.map((a) => String(a)).join(" "));
    };
    try {
      await clearDebugLog(local);
    } finally {
      console.warn = originalWarn;
    }
    expect(existsSync(debugLogPath())).toBe(false);
    expect(warnings.some((w) => w.includes("falling back"))).toBe(true);
  });

  // The end of the line: neither route could clear it. Failing here is deliberate — carrying on
  // would silently disable the fatal gate for every later scenario.
  test("a log that survives both routes throws", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so the removal succeeds",
    );
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = verdictLine("kept", null);
    const contentDir = join(wpRoot, "wp-content");
    writeFileSync(debugLogPath(), "stubborn");
    chmodSync(contentDir, 0o500);
    try {
      // Unprivileged on purpose: with elevation allowed this host might well clear it, and whether
      // the machine running the suite has passwordless sudo must not decide the outcome.
      await expect(clearDebugLog({ ...local, elevate: false })).rejects.toThrow(
        /could not be cleared/,
      );
    } finally {
      chmodSync(contentDir, 0o700);
      rmSync(debugLogPath(), { force: true });
    }
  });
});

/**
 * Fake `sudo` for the escalation tests: answers the `sudo -n true` capability probe, records every
 * argv, and otherwise hands back the one privilege these tests remove — write access to the target
 * (or its parent). Not a stand-in for real root; it exists so the escalation *policy* is provable on
 * a machine that has no passwordless root, which is most of them.
 */
const FAKE_SUDO = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_SUDO_LOG"
if [ "$FAKE_SUDO_DENY" = "1" ]; then exit 1; fi
${SKIP_SUDO_OPTIONS}
if [ "$1" = "true" ]; then exit 0; fi
for arg in "$@"; do target="$arg"; done
chmod u+rwx "$(dirname "$target")" 2>/dev/null
[ -e "$target" ] && chmod -R u+rwX "$target" 2>/dev/null
exec "$@"
`;

test.describe("debug.log — escalating when the web-server user's permissions deny us", () => {
  let sudoDir: string;
  let elevatedRoot: string;
  let site: LocalTransport;
  let pathBefore: string | undefined;

  const logPath = (): string => join(elevatedRoot, "wp-content", "debug.log");

  test.beforeEach(() => {
    sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
    writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
    chmodSync(join(sudoDir, "sudo"), 0o755);
    // A root per test: elevation support is probed once per target and cached.
    elevatedRoot = mkdtempSync(join(tmpdir(), "wp-elevated-root-"));
    mkdirSync(join(elevatedRoot, "wp-content"));
    site = { mode: "local", rootDir: elevatedRoot };
    pathBefore = process.env.PATH;
    process.env.PATH = `${sudoDir}:${pathBefore ?? ""}`;
    process.env.FAKE_SUDO_LOG = join(sudoDir, "argv.log");
    // Force the direct-file fallback: `wp eval` reports it kept the log.
    process.env.WP_STUB_EVAL = "ok";
    process.env.WP_STUB_EVAL_OUT = verdictLine("kept", null);
  });

  test.afterEach(() => {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    delete process.env.FAKE_SUDO_LOG;
    delete process.env.FAKE_SUDO_DENY;
    chmodSync(join(elevatedRoot, "wp-content"), 0o700);
    rmSync(elevatedRoot, { recursive: true, force: true });
    rmSync(sudoDir, { recursive: true, force: true });
  });

  // Unlinking the log needs write access to wp-content, which on a real host belongs to the web
  // server. Failing here would blame one scenario's fatals on every scenario after it.
  test("clearDebugLog removes a log the containing directory refuses to give up", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so the removal succeeds",
    );
    writeFileSync(logPath(), "stubborn");
    chmodSync(join(elevatedRoot, "wp-content"), 0o500);

    await expect(clearDebugLog(site)).resolves.toBeUndefined();
    chmodSync(join(elevatedRoot, "wp-content"), 0o700);
    expect(existsSync(logPath())).toBe(false);
  });

  // The dangerous case: an unreadable log read as "" turns the fatal gate off silently.
  test("readDebugLog escalates a denied read instead of reporting an empty log", async () => {
    test.skip(isRoot, "root ignores file permissions, so the read succeeds");
    writeFileSync(logPath(), "PHP Fatal error: boom");
    chmodSync(logPath(), 0o000);
    process.env.WP_STUB_EVAL = "fail";

    expect(await readDebugLog(site)).toBe("PHP Fatal error: boom");
  });

  test("a log that no route can read is reported, never passed off as empty", async () => {
    test.skip(isRoot, "root ignores file permissions, so the read succeeds");
    writeFileSync(logPath(), "PHP Fatal error: boom");
    chmodSync(logPath(), 0o000);
    process.env.WP_STUB_EVAL = "fail";
    process.env.FAKE_SUDO_DENY = "1";

    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: unknown): void => {
      warnings.push(String(message));
    };
    try {
      expect(await readDebugLog(site)).toBe("");
    } finally {
      console.warn = original;
      chmodSync(logPath(), 0o600);
    }
    expect(warnings.some((w) => w.includes("CANNOT fail a scenario"))).toBe(
      true,
    );
  });
});

/**
 * A plugin that cannot boot — a half-removed copy of the one under test — must not decide what the
 * log says: reading or clearing a file needs no plugin, and a boot that loads it writes its fatal into
 * the log being judged, which would then blame the scenario for the read itself.
 */
test.describe("debug.log — never through a WordPress that loads plugins or themes", () => {
  let callLog: string;

  test.beforeEach(() => {
    callLog = join(wpRoot, "calls.log");
    process.env.WP_STUB_CALLS = callLog;
    process.env.WP_STUB_BROKEN_PLUGIN = "1";
    process.env.WP_STUB_EVAL = "ok";
    rmSync(debugLogPath(), { force: true });
  });

  test.afterEach(() => {
    delete process.env.WP_STUB_CALLS;
    delete process.env.WP_STUB_BROKEN_PLUGIN;
    rmSync(callLog, { force: true });
    rmSync(debugLogPath(), { force: true });
  });

  const evalCalls = (): string[] =>
    existsSync(callLog)
      ? readFileSync(callLog, "utf8")
          .split("\n")
          .filter((line) => / eval |^eval /.test(` ${line}`))
      : [];

  test("a scan of a clean log finds no fatal, and writes none into it", async () => {
    process.env.WP_STUB_EVAL_OUT = "";
    const scan = await scanDebugLog(local);

    expect(scan.fatals).toEqual([]);
    expect(existsSync(debugLogPath())).toBe(false);
    expect(evalCalls()).toHaveLength(1);
    expect(evalCalls()[0]).toMatch(/^--skip-plugins --skip-themes eval /);
  });

  test("clearing it boots with plugins and themes skipped", async () => {
    process.env.WP_STUB_EVAL_OUT = verdictLine("removed", null);
    await clearDebugLog(local);

    expect(evalCalls()).toHaveLength(1);
    expect(evalCalls()[0]).toMatch(/^--skip-plugins --skip-themes eval /);
  });
});

test.describe("parseClearVerdict", () => {
  test("reads the last marked line, whatever PHP printed before it", () => {
    expect(
      parseClearVerdict(
        `${verdictLine("kept", null)}\nPHP Deprecated: x\n${verdictLine("created", true)}`,
      ),
    ).toEqual({ state: "created", ours: true, path: "wp-content/debug.log" });
    expect(
      parseClearVerdict(
        'e2e-debug-log-clear {"state":"removed","ours":null,"path":null}',
      ),
    ).toEqual({ state: "removed", ours: null, path: null });
  });

  for (const [why, stdout] of [
    ["no verdict", "cleared"],
    ["not JSON", "e2e-debug-log-clear {"],
    ["not an object", "e2e-debug-log-clear []"],
    [
      "an unknown state",
      'e2e-debug-log-clear {"state":"gone","ours":null,"path":null}',
    ],
    [
      "ours not a boolean",
      'e2e-debug-log-clear {"state":"emptied","ours":1,"path":null}',
    ],
    [
      "an empty path",
      'e2e-debug-log-clear {"state":"emptied","ours":true,"path":""}',
    ],
    [
      "a path not a string",
      'e2e-debug-log-clear {"state":"emptied","ours":true,"path":7}',
    ],
    ["fields missing", 'e2e-debug-log-clear {"state":"emptied"}'],
  ] as const) {
    test(`is undefined for ${why}`, () => {
      expect(parseClearVerdict(stdout)).toBeUndefined();
    });
  }
});

/**
 * After a clear, the log WP-CLI's identity owns is handed to the site's ownership or removed; another
 * user's is never touched.
 */
test.describe("keepLogWritable", () => {
  /**
   * Fake operations recording each call: `handOver` answers `outcome`, `remove` exits `removeExit`,
   * `writesAsWebServer` answers `site` (whether commands run as the web server).
   */
  function fakeOps(
    outcome: OwnershipOutcome,
    removeExit = 0,
    site = false,
  ): KeepWritableOps & { calls: string[]; warnings: string[] } {
    const calls: string[] = [];
    const warnings: string[] = [];
    return {
      calls,
      warnings,
      writesAsWebServer: () => {
        calls.push("writesAsWebServer");
        return Promise.resolve(site);
      },
      handOver: (path) => {
        calls.push(`handOver ${path}`);
        return Promise.resolve(outcome);
      },
      remove: (path) => {
        calls.push(`remove ${path}`);
        return Promise.resolve({
          exitCode: removeExit,
          stdout: "",
          stderr: "",
        });
      },
      warn: (message) => warnings.push(message),
    };
  }
  const verdict = (
    ours: boolean | null,
    path: string | null = "wp-content/debug.log",
  ): ClearVerdict => ({ state: "emptied", ours, path });

  test("another user's log, or one whose owner is unknown, is left untouched", async () => {
    for (const ours of [false, null]) {
      const ops = fakeOps("normalized");
      await keepLogWritable(verdict(ours), ops);
      expect(ops.calls).toEqual([]);
    }
  });

  test("no log, nothing to do", async () => {
    const ops = fakeOps("normalized");
    await keepLogWritable({ state: "removed", ours: null, path: null }, ops);
    expect(ops.calls).toEqual([]);
  });

  test("in the `site` state the identity's log is the web server's own: kept, nothing handed over", async () => {
    for (const path of ["wp-content/debug.log", "/srv/logs/debug.log"]) {
      const ops = fakeOps("failed", 0, true);
      await keepLogWritable(verdict(true, path), ops);
      expect(ops.calls).toEqual(["writesAsWebServer"]);
    }
  });

  test("outside the `site` state the identity's log is kept once handed over", async () => {
    const ops = fakeOps("normalized");
    await keepLogWritable(verdict(true), ops);
    expect(ops.calls).toEqual([
      "writesAsWebServer",
      "handOver wp-content/debug.log",
    ]);
  });

  // Kept, it would be a log the web server cannot append to: removed, as before, is no worse.
  // `unnecessary` outside `site` means WP-CLI's user owns the install, not that the web server is that
  // user; `disabled` means nothing was handed over at all.
  for (const outcome of [
    "unnecessary",
    "disabled",
    "skipped",
    "failed",
  ] as const) {
    test(`outside the \`site\` state the identity's log is removed when handing it over was ${outcome}`, async () => {
      const ops = fakeOps(outcome);
      await keepLogWritable(verdict(true), ops);
      expect(ops.calls).toEqual([
        "writesAsWebServer",
        "handOver wp-content/debug.log",
        "remove wp-content/debug.log",
      ]);
      expect(ops.warnings).toEqual([]);
    });
  }

  test("outside the `site` state a log outside the WordPress root cannot be handed over: it is removed", async () => {
    const ops = fakeOps("normalized");
    await keepLogWritable(verdict(true, "/srv/logs/debug.log"), ops);
    expect(ops.calls).toEqual([
      "writesAsWebServer",
      "remove /srv/logs/debug.log",
    ]);
  });

  test("a removal that fails is warned about, never thrown", async () => {
    const ops = fakeOps("skipped", 1);
    await keepLogWritable(verdict(true), ops);
    expect(ops.warnings).toEqual([
      "[wp/log] debug.log could not be handed to the site's ownership, nor removed (exit 1); the " +
        "web server may be unable to write it until the next clear.",
    ]);
  });
});
