import { test, expect } from "@playwright/test";
import { join } from "node:path";

import { verifySite } from "./preflight";
import type { CheckResult } from "./preflight";
import type { HealCellPlugin } from "./cell-plugin";
import { disposeConnections, shellQuote } from "../wp/exec";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { SiteInput } from "../config/types";

/**
 * The ssh pre-flight against a server that runs what it is sent: each check is reported by the check
 * that owns it, now that a command whose working directory cannot be entered runs nothing, and the
 * third (`wp core is-installed`) runs only once both others passed.
 */

let server: SshTestServer;
/**
 * What `afterAll` undoes, newest first; each step is pushed only once what it undoes exists, so a
 * failed `beforeAll` (which still runs `afterAll`) is not hidden behind a second error.
 */
const teardown: (() => void | Promise<void>)[] = [];

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
});

test.afterEach(() => {
  disposeConnections();
  server.removeProgram("ls");
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** What the fake `wp` does with `--info`, and with `core is-installed`. */
interface FakeWp {
  /** `--info`: print a version (the default), exit 1, or kill itself with SIGSEGV. */
  readonly info?: "ok" | "fail" | "crash";
  /** `core is-installed`: exit 0 (the default), or kill itself with SIGSEGV. */
  readonly installed?: "ok" | "crash";
  /**
   * `eval`: print `en_US` (the default); kill itself with SIGSEGV with every plugin loaded, but boot
   * with one skipped (`--skip-plugins=<slug>`: `crash-loaded`); or crash either way (`crash`).
   */
  readonly evaluate?: "ok" | "crash-loaded" | "crash";
}

/**
 * Installs a fake `wp`; anything it is not told about exits 0.
 *
 * @param fake - how `--info`, `core is-installed` and `eval` answer.
 */
function installWp({
  info = "ok",
  installed = "ok",
  evaluate = "ok",
}: FakeWp = {}): void {
  const onInfo = {
    ok: 'echo "WP-CLI version: 2.12.0"; exit 0',
    fail: "echo 'wp: broken' >&2; exit 1",
    crash: "kill -SEGV $$",
  }[info];
  const onInstalled = installed === "ok" ? "exit 0" : "kill -SEGV $$";
  const onSkipped =
    evaluate === "crash" ? "kill -SEGV $$" : "echo en_US; exit 0";
  server.addProgram(
    "wp",
    [
      `case "$1" in --skip-plugins=*) ${onSkipped} ;; esac`,
      `[ "$1" = --info ] && { ${onInfo}; }`,
      `[ "$1 $2" = "core is-installed" ] && { ${onInstalled}; }`,
      `[ "$1" = eval ] && { ${evaluate === "ok" ? "echo en_US" : "kill -SEGV $$"}; }`,
      "exit 0",
      "",
    ].join("\n"),
  );
}

/**
 * A site on the test server whose root is `rootDir`; `elevate: false`, so nothing asks `sudo`.
 *
 * @param rootDir - the WordPress root it declares.
 */
function site(rootDir: string): SiteInput {
  return {
    baseURL: "https://site.test",
    username: "admin",
    password: "admin-password",
    transport: server.transport({ rootDir, elevate: false }),
  };
}

/** The commands the server received from `before` on. */
const sentSince = (before: number): readonly string[] =>
  server.commands.slice(before);

/** The `core is-installed` line, run in `root`. */
const isInstalledLine = (root: string): string =>
  `cd -- ${shellQuote(root)} && exec 'wp' 'core' 'is-installed'`;

test("a missing root is reported by the root check alone, with WP-CLI found", async () => {
  installWp();
  const missing = join(server.root, "no such root");

  const { checks } = await verifySite(site(missing), 0);

  expect(checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: true },
    { name: "rootDir accessible", ok: false },
  ]);
  expect(checks[0]?.detail).toBe("Connected. wp-cli 2.12.0.");
  // `ls`'s own reason, not a failed `cd` into the root.
  expect(checks[1]?.detail).toMatch(/^"[^"]+" is not a usable directory/);
  expect(checks[1]?.detail).toContain("ls:");
});

test("WP-CLI's own failure and a missing root are each reported once, by their own check", async () => {
  installWp({ info: "fail" });

  const { checks } = await verifySite(site(join(server.root, "gone")), 0);

  expect(checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: false },
    { name: "rootDir accessible", ok: false },
  ]);
  expect(checks[0]?.detail).toBe("WP-CLI exited 1: wp: broken");
});

// `exec` finds programs on the PATH: a `wp` the login defines as a shell function is never run.
test("a failing WP-CLI's hint asks for an executable on the PATH, not a shell function", async () => {
  installWp({ info: "fail" });

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks[0]?.hint).toBe(
    "Ensure 'wp' is in PATH on site.test for user 'tester', as an executable file: a shell " +
      "function or alias named `wp` is never run.",
  );
});

test("WP-CLI and the root checks run from /, so neither depends on the root existing", async () => {
  installWp();
  const before = server.commands.length;

  await verifySite(site(join(server.root, "absent")), 0);

  const sent = sentSince(before);
  expect(sent).toHaveLength(2);
  expect(sent[0]).toBe("cd -- '/' && exec 'wp' '--info'");
  expect(sent[1]).toMatch(/^cd -- '\/' && exec 'ls' '-d' /);
});

test("a working WP-CLI and an existing root go on to ask WordPress, from the root", async () => {
  installWp();
  const before = server.commands.length;

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks.slice(0, 3).map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: true },
    { name: "rootDir accessible", ok: true },
    { name: "WordPress installed", ok: true },
  ]);
  expect(sentSince(before).slice(0, 3)).toEqual([
    "cd -- '/' && exec 'wp' '--info'",
    `cd -- '/' && exec 'ls' '-d' ${shellQuote(`${server.root}/.`)}`,
    isInstalledLine(server.root),
  ]);
});

test("a broken WP-CLI with an existing root never asks WordPress", async () => {
  installWp({ info: "fail" });
  const before = server.commands.length;

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: false },
    { name: "rootDir accessible", ok: true },
  ]);
  expect(sentSince(before)).not.toContain(isInstalledLine(server.root));
});

// The root check's own command failing to give an answer (here: killed) is not a passed check.
test("a root check that cannot answer fails, and WordPress is never asked", async () => {
  installWp();
  server.addProgram("ls", "kill -KILL $$\n");
  const before = server.commands.length;

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: true },
    { name: "rootDir accessible", ok: false },
  ]);
  expect(checks[1]?.detail).toContain("terminated by signal SIGKILL");
  expect(sentSince(before)).not.toContain(isInstalledLine(server.root));
});

// `exec` leaves no shell to turn a crash into exit 139: it throws, and is still WP-CLI's failure.
test("a WP-CLI that crashes is reported as WP-CLI's failure, and the root is still checked", async () => {
  installWp({ info: "crash" });

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
    { name: "SSH + WP-CLI", ok: false },
    { name: "rootDir accessible", ok: true },
  ]);
  expect(checks[0]?.detail).toBe(
    '[wp/exec] "wp" on site.test was terminated by signal SIGSEGV before exiting.',
  );
  expect(checks[0]?.hint).toMatch(
    /^PHP was killed running WP-CLI itself \(`wp --info` loads no WordPress\)/,
  );
});

test("a WordPress that crashes while booting is reported as one that could not be evaluated", async () => {
  installWp({ installed: "crash" });

  const { checks } = await verifySite(site(server.root), 0);

  expect(checks[2]).toEqual({
    name: "WordPress installed",
    ok: false,
    detail:
      'WordPress could not be evaluated: [wp/exec] "wp" on site.test was terminated by signal ' +
      "SIGSEGV before exiting.",
    hint:
      "PHP was killed while WordPress booted — a segfault, or the kernel's out-of-memory kill. Run " +
      "the\ncommand there directly, and look in PHP's and the kernel's logs (`dmesg`) for the cause.",
  });
});

test("a WordPress that crashes reading the admin locale is reported as a crash, not a transport fault", async () => {
  installWp({ evaluate: "crash" });

  const { checks } = await verifySite(site(server.root), 0);

  const locale = checks.find(({ name }) => name === "Admin locale is English");
  expect(locale?.ok).toBe(false);
  expect(locale?.detail).toContain("terminated by signal SIGSEGV");
  expect(locale?.hint).toMatch(/^PHP was killed while WordPress booted/);
});

/**
 * A crash reading the locale is a boot failure like a fatal: the cell's own plugin is blamed for it
 * only when WordPress boots with that slug skipped.
 */
test.describe("a WordPress that crashes booting, and the cell's plugin", () => {
  const SLUG = "backwpup-pro";
  const KILLED =
    '[wp/exec] "wp" on site.test was terminated by signal SIGSEGV before exiting.';
  let healed: string[];

  /** A heal that removes the copy: WordPress boots again afterwards. */
  const heal: HealCellPlugin = (_transport, slug) => {
    healed.push(slug);
    installWp();
    return Promise.resolve(undefined);
  };
  const names = (checks: readonly CheckResult[]): string[] =>
    checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}`);

  test.beforeEach(() => {
    healed = [];
  });

  test("a crash only with the plugin loaded removes the plugin, and the site passes", async () => {
    installWp({ evaluate: "crash-loaded" });

    const result = await verifySite(site(server.root), 0, [SLUG], heal);

    expect(healed).toEqual([SLUG]);
    const plugin = result.checks.find(
      ({ name }) => name === "Plugin under test",
    );
    expect(plugin?.ok).toBe(true);
    expect(plugin?.detail).toContain(
      `WordPress cannot boot with the cell's plugin "${SLUG}" loaded (${KILLED}), and boots without it`,
    );
    const locale = result.checks.find(
      ({ name }) => name === "Admin locale is English",
    );
    expect(locale?.ok).toBe(true);
  });

  // The healthcheck passes no heal: it reports, in place of the locale check.
  test("without heal, a crash only with the plugin loaded is reported as the plugin's", async () => {
    installWp({ evaluate: "crash-loaded" });

    const { checks } = await verifySite(site(server.root), 0, [SLUG]);

    expect(names(checks)).toContain("✗ Plugin under test");
    expect(names(checks).join("\n")).not.toContain("Admin locale");
  });

  test("a crash with the slug skipped too is not blamed on the plugin, and removes nothing", async () => {
    installWp({ evaluate: "crash" });

    const { checks } = await verifySite(site(server.root), 0, [SLUG], heal);

    expect(healed).toEqual([]);
    expect(names(checks).join("\n")).not.toContain("Plugin under test");
    const locale = checks.find(
      ({ name }) => name === "Admin locale is English",
    );
    expect(locale?.ok).toBe(false);
    expect(locale?.detail).toBe(`Could not read the admin locale: ${KILLED}`);
    expect(locale?.hint).toMatch(/^PHP was killed while WordPress booted/);
  });
});
