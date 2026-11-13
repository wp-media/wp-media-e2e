import { test, expect, request } from "@playwright/test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { verifyPool, verifySite } from "./preflight";
import type { CheckResult, SitePreflightResult } from "./preflight";
import { LOGIN_SHELL_PROBE, checkLoginShell } from "./login-shell";
import { SITE_IDENTITY_CHECK } from "./site-identity-report";
import {
  disposeConnections,
  installKey,
  resetElevationCaches,
  sshCommandLine,
} from "../wp/exec";
import { resetOwnershipCaches } from "../wp/ownership";
import {
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "../wp/site-identity";
import { SITE_IDENTITY_FILE, readSiteIdentityFile } from "../wp/web-identity";
import { resetWpUserCaches, wpUserCheckArgs } from "../wp/wp-user";
import {
  startProbeWebServer,
  type ProbeWebServer,
} from "../__fixtures__/probe-web-server";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import { removeTempDir } from "../__fixtures__/temp-dir";
import type { SiteConfig, SshTransport } from "../config/types";

/**
 * The pre-flight's site identity over a server that runs what it is sent, with a web server serving
 * the identity probe from the same root:
 * - a site opted out with `runAs` false gets no probe file, no `sudo -n -l`, no WP-CLI
 *   config read: only the login-shell round-trip, the WordPress login's check and the timed
 *   `sudo -n true` are new, all read-only, and the exact command list is pinned;
 * - sudo's unresolvable-host line on every call reaches no check, decision or banner;
 * - an `auto` site is probed, its verdict registered here and written for workers, and reported;
 * - the login shell is the one gate: a shell that changes a quoted string fails the site before any
 *   probe or heal;
 * - the `wp --info` gate's hint names the identity it ran as.
 */

let server: SshTestServer;
let web: ProbeWebServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];
/** Exists: the fake `wp --info` fails when run from `/` as the identity. */
let wpInfoFailsAsSite = "";
/** Exists: the fake `wp eval` answers a German locale unless run as the identity. */
let germanAsSshUser = "";

const LOGIN = "admin";

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  const served = await startProbeWebServer(started.root);
  web = served;
  teardown.push(() => served.close());
  wpInfoFailsAsSite = join(started.base, "wp-info.fails");
  germanAsSshUser = join(started.base, "german-as-ssh-user");
  started.addProgram("stat", "echo 'www-data:www-data:33:33'");
  started.addProgram(
    "id",
    'if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo "uid=33(www-data) gid=33(www-data) groups=33(www-data)"; ' +
      'else echo "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)"; fi',
  );
  started.addProgram(
    "wp",
    [
      `if [ "$1" = --info ]; then`,
      `  if [ -n "$E2E_FAKE_SUDO_USER" ] && [ "$PWD" = / ] && [ -e '${wpInfoFailsAsSite}' ]; then echo 'wp: missing' >&2; exit 1; fi`,
      "  echo 'WP-CLI version: 2.12.0'; exit 0",
      "fi",
      'case "$*" in',
      `  *get_check*) printf '\\ne2e-wp-user:{"numeric":false,"admin":true}\\n'; exit 0 ;;`,
      "esac",
      `if [ "$1" = eval ] && [ -z "$E2E_FAKE_SUDO_USER" ] && [ -e '${germanAsSshUser}' ]; then echo de_DE; exit 0; fi`,
      '[ "$1" = eval ] && { echo en_US; exit 0; }',
      "exit 0",
      "",
    ].join("\n"),
  );
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  resetWpUserCaches();
  rmSync(wpInfoFailsAsSite, { force: true });
  rmSync(germanAsSshUser, { force: true });
  rmSync(join(server.home, ".wp-cli"), { recursive: true, force: true });
  server.removeProgram("printf");
  server.removeProgram("getent");
  server.removeProgram("env");
  server.sudoNoise(false);
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * A site on the test server, its address the probe web server's.
 *
 * @param overrides - transport fields.
 */
function siteWith(overrides: Partial<SshTransport>): SiteConfig {
  return {
    baseURL: web.baseURL,
    username: LOGIN,
    password: "admin-password",
    storageState: "/dev/null",
    transport: { ...server.transport(overrides), wpUser: LOGIN },
  };
}

/** The commands the server received from `before` on. */
const sentSince = (before: number): string[] => server.commands.slice(before);

/** The named check. */
const named = (
  result: SitePreflightResult,
  name: string,
): CheckResult | undefined =>
  result.checks.find((check) => check.name === name);

/** No probe file is left in the root. */
const probeFilesLeft = (): string[] =>
  readdirSync(server.root).filter((name) => name.startsWith("e2e-identity-"));

test("runAs false (opted out): no probe, no sudo listing, no config read — three new read-only commands, exactly", async () => {
  const site = siteWith({ runAs: false });
  const before = server.commands.length;
  const requestsBefore = web.requests.length;
  const sudoBefore = server.sudoCalls().length;

  const result = await verifySite(site, 0, [], undefined, { request });

  expect(result.checks.every((check) => check.ok)).toBe(true);
  expect(web.requests.length).toBe(requestsBefore);
  expect(result.identityVerdict).toBeUndefined();
  const root = server.root;
  expect(sentSince(before)).toEqual([
    sshCommandLine("/", "wp", ["--info"]),
    sshCommandLine("/", "ls", ["-d", `${root}/.`]),
    sshCommandLine(root, "wp", ["core", "is-installed"]),
    // New: the login shell's round-trip (as the SSH user, from /).
    sshCommandLine("/", "printf", ["%s", LOGIN_SHELL_PROBE]),
    sshCommandLine(root, "wp", [
      "eval",
      "echo determine_locale();",
      `--user=${LOGIN}`,
    ]),
    sshCommandLine(root, "sudo", ["-n", "true"]),
    sshCommandLine(root, "stat", ["-c", "%U:%G:%u:%g", `${root}/wp-content`]),
    sshCommandLine(root, "id", []),
    // New: the WordPress login's check (`wp eval`, plugins and theme skipped), read-only.
    sshCommandLine(root, "wp", wpUserCheckArgs(LOGIN)),
    // New: sudo's host lookup, timed in English (root steps go through sudo); quiet, so no second
    // call. The same `sudo -n true` the elevation probe above runs.
    sshCommandLine("/", "env", ["LC_ALL=C", "sudo", "-n", "true"]),
  ]);
  const joined = sentSince(before).join("\n");
  for (const absent of [
    "e2e-identity",
    "dd",
    "find",
    "getent",
    ".wp-cli",
    "'-l'",
  ]) {
    expect(joined).not.toContain(absent);
  }
  // sudo only for the elevation probe the pre-flight always ran, and the host lookup's.
  expect(server.sudoCalls().slice(sudoBefore)).toEqual([
    ["-n", "true"],
    ["-n", "true"],
  ]);
  // An opt-out: noted on its check line, never in the banner.
  expect(result.identityIssues).toEqual([]);
});

test("auto: the web server is asked, the verdict registered here, the site runs as www-data, and the probe is gone", async () => {
  const site = siteWith({ runAs: "auto" });
  const before = server.commands.length;

  const result = await verifySite(site, 0, [], undefined, { request });

  expect(result.identityVerdict).toMatchObject({ verdict: "owner-is-web" });
  expect((await resolveSiteIdentity(site.transport)).kind).toBe("site");
  expect(probeFilesLeft()).toEqual([]);
  const identity = named(result, SITE_IDENTITY_CHECK);
  expect(identity?.detail.split("\n")[0]).toBe(
    "Runs as www-data(33):www-data(33), umask 0022.",
  );
  const sent = sentSince(before);
  expect(sent).toContain(
    sshCommandLine("/", "env", ["LC_ALL=C", "sudo", "-n", "-l"]),
  );
  expect(sent).toContain(
    sshCommandLine("/", "sh", ["-c", 'test -e "$HOME/.wp-cli/config.yml"']),
  );
  // The fake sudo knows no `-l`: unknown, so warned and listed — never a failure.
  expect(identity?.warning).toBe(true);
  expect(result.checks.every((check) => check.ok)).toBe(true);
  expect(result.identityIssues?.map((issue) => issue.what)).toEqual([
    "whether sudo logs command lines is unknown (`sudo -n -l` gave no listing)",
  ]);
});

test("sudo's host line on every call: the same checks and decisions, none quoting it, no lookup warning when it costs nothing", async () => {
  const quiet = await verifySite(
    siteWith({ runAs: "auto" }),
    0,
    [],
    undefined,
    {
      request,
    },
  );
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  resetWpUserCaches();
  server.sudoNoise(true);
  const before = server.commands.length;

  const noisy = await verifySite(
    siteWith({ runAs: "auto" }),
    0,
    [],
    undefined,
    {
      request,
    },
  );

  expect(noisy.checks).toEqual(quiet.checks);
  expect(noisy.identityIssues).toEqual(quiet.identityIssues);
  expect(noisy.elevation).toBe("available");
  expect((await resolveSiteIdentity(noisy.transport)).kind).toBe("site");
  expect(JSON.stringify(noisy)).not.toContain("resolve host");
  // The noisy lookup was compared with a plain call: the only extra command.
  expect(sentSince(before)).toContain(
    sshCommandLine("/", "env", ["LC_ALL=C", "true"]),
  );
});

test.describe("the host lookup is timed only where the run sends commands through sudo", () => {
  /** The sudo calls a pre-flight of `site` made that ran plain `true` (the lookup's, the probe's). */
  async function trueCalls(site: SiteConfig): Promise<string[][]> {
    const before = server.sudoCalls().length;
    await verifySite(site, 0, [], undefined, { request });
    return server
      .sudoCalls()
      .slice(before)
      .filter((call) => call.at(-1) === "true");
  }

  test("site with root opted out: timed as the identity, nothing run as root", async () => {
    const site = siteWith({ runAs: "auto", elevate: false });
    expect(await trueCalls(site)).toEqual([
      ["-n", "-u", "www-data", "-g", "www-data", "true"],
    ]);
    expect((await resolveSiteIdentity(site.transport)).kind).toBe("site");
  });

  test("fallback with root opted out: the run sends nothing through sudo, so no lookup", async () => {
    server.denySudo({ user: "www-data" });
    try {
      const site = siteWith({ runAs: "auto", elevate: false });
      expect(await trueCalls(site)).toEqual([]);
      expect((await resolveSiteIdentity(site.transport)).kind).toBe("fallback");
    } finally {
      server.denySudo(false);
    }
  });

  test("fallback with sudo refused: only the elevation probe's call, no lookup", async () => {
    server.denySudo(true);
    try {
      expect(await trueCalls(siteWith({ runAs: "auto" }))).toEqual([
        ["-n", "true"],
      ]);
    } finally {
      server.denySudo(false);
    }
  });

  test("runAs false with root opted out: no sudo at all", async () => {
    const before = server.sudoCalls().length;
    await verifySite(
      siteWith({ runAs: false, elevate: false }),
      0,
      [],
      undefined,
      { request },
    );
    expect(server.sudoCalls().slice(before)).toEqual([]);
  });
});

test("auto: the locale is checked as the identity the probe decided, after it", async () => {
  // As the SSH user WordPress would answer German; as www-data, English.
  writeFileSync(germanAsSshUser, "");
  const result = await verifySite(
    siteWith({ runAs: "auto" }),
    0,
    [],
    undefined,
    { request },
  );
  expect(named(result, "Admin locale is English")?.ok).toBe(true);
});

test("auto in site: sudo's runas defaults are read for the identity's names", async () => {
  // Logs by default; `Defaults>www-data !log_allowed` turns it off for the identity only.
  const listing = [
    "Matching Defaults entries for tester on host:",
    "    env_reset",
    "",
    "Runas and Command-specific defaults for tester:",
    "    Defaults>www-data !log_allowed",
    "",
    "User tester may run the following commands on host:",
    "    (ALL) NOPASSWD: ALL",
  ].join("\n");
  const listed = join(server.base, "sudo-listing.txt");
  writeFileSync(listed, `${listing}\n`);
  // `env` is how the listing is asked for (`env LC_ALL=C sudo -n -l`); anything else is the real one.
  server.addProgram(
    "env",
    `if [ "$*" = "LC_ALL=C sudo -n -l" ]; then cat '${listed}'; exit 0; fi\nexec /usr/bin/env "$@"`,
  );
  const result = await verifySite(
    siteWith({ runAs: "auto" }),
    0,
    [],
    undefined,
    { request },
  );
  expect(named(result, SITE_IDENTITY_CHECK)?.detail).toContain(
    "sudo keeps command lines out of its log (`!log_allowed`).",
  );
  expect(result.identityIssues).toEqual([]);
});

test("auto in site: WP-CLI's config is reported only when the SSH user has one", async () => {
  const detail = async (): Promise<string | undefined> =>
    named(
      await verifySite(siteWith({ runAs: "auto" }), 0, [], undefined, {
        request,
      }),
      SITE_IDENTITY_CHECK,
    )?.detail;
  expect(await detail()).not.toContain("config.yml");
  mkdirSync(join(server.home, ".wp-cli"));
  writeFileSync(join(server.home, ".wp-cli", "config.yml"), "");
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  resetWpUserCaches();
  expect(await detail()).toContain("~/.wp-cli/config.yml no longer applies");
});

test("without a request, an auto site is not probed and stays unverified", async () => {
  const site = siteWith({ runAs: "auto" });
  const requestsBefore = web.requests.length;

  const result = await verifySite(site, 0);

  expect(web.requests.length).toBe(requestsBefore);
  expect(named(result, SITE_IDENTITY_CHECK)?.detail).toMatch(
    /^Runs as the transport's user: the web server's identity was not verified/,
  );
});

test.describe("verifyPool writes this run's verdicts for workers", () => {
  let dir: string;
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-preflight-verdicts-"));
  });
  test.afterEach(() => {
    removeTempDir(dir);
  });

  test("an auto site's verdict, keyed by its install, for this run", async () => {
    const site = siteWith({ runAs: "auto" });
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await verifyPool([site], "p", "c", [], undefined, undefined, {
        request,
        dir,
        runId: "run-7",
      });
    } finally {
      console.warn = warn;
    }
    const read = await readSiteIdentityFile(dir, "run-7");
    expect(read.kind).toBe("read");
    expect(
      read.kind === "read"
        ? read.verdicts.get(installKey(site.transport))
        : undefined,
    ).toMatchObject({ verdict: "owner-is-web" });
  });

  test("every probe threw: the file is still written for this run, with no verdict, replacing the last run's", async () => {
    // A `baseURL` that is no URL makes the probe throw before anything is written.
    const site: SiteConfig = {
      ...siteWith({ runAs: "auto" }),
      baseURL: "no-url",
    };
    writeFileSync(
      join(dir, SITE_IDENTITY_FILE),
      JSON.stringify({ version: 1, runId: "run-6", sites: {} }),
    );
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await verifyPool([site], "p", "c", [], undefined, undefined, {
        request,
        dir,
        runId: "run-7",
      });
    } finally {
      console.warn = warn;
    }
    const read = await readSiteIdentityFile(dir, "run-7");
    expect(read.kind).toBe("read");
    expect(read.kind === "read" ? read.verdicts.size : -1).toBe(0);
  });

  test("no site asking for an identity: no file at all", async () => {
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await verifyPool(
        [siteWith({ runAs: false })],
        "p",
        "c",
        [],
        undefined,
        undefined,
        {
          request,
          dir,
          runId: "run-7",
        },
      );
    } finally {
      console.warn = warn;
    }
    expect(readdirSync(dir)).not.toContain(SITE_IDENTITY_FILE);
  });
});

test.describe("the login shell is the one gate", () => {
  test("a shell that changes a quoted string fails the site, names the shell, and nothing is written or healed", async () => {
    server.addProgram("printf", "echo changed");
    server.addProgram(
      "getent",
      "echo 'tester:x:1:1::/home/tester:/usr/bin/tcsh'",
    );
    const site = siteWith({ runAs: "auto" });
    const requestsBefore = web.requests.length;
    const healed: string[] = [];

    const result = await verifySite(
      site,
      0,
      ["some-plugin"],
      (_transport, slug) => {
        healed.push(slug);
        return Promise.resolve(undefined);
      },
      { request },
    );

    expect(result.checks.map(({ name, ok }) => ({ name, ok }))).toEqual([
      { name: "SSH + WP-CLI", ok: true },
      { name: "rootDir accessible", ok: true },
      { name: "WordPress installed", ok: true },
      { name: "Login shell", ok: false },
    ]);
    expect(result.checks[3]?.detail).toContain(
      "The login shell is /usr/bin/tcsh, which is not POSIX.",
    );
    expect(web.requests.length).toBe(requestsBefore);
    expect(healed).toEqual([]);
    expect(result.identityIssues).toBeUndefined();
  });

  test("the site identity check never fails a site, whatever it finds", async () => {
    server.denySudo(true);
    try {
      const result = await verifySite(
        siteWith({ runAs: "auto" }),
        0,
        [],
        undefined,
        {
          request,
        },
      );
      const identity = named(result, SITE_IDENTITY_CHECK);
      expect(identity?.ok).toBe(true);
      expect(identity?.warning).toBe(true);
      expect(identity?.detail).toMatch(
        /^Runs as the transport's user: sudo refused/,
      );
    } finally {
      server.denySudo(false);
    }
  });
});

test.describe("verifyPool checks the login shell before settling leftovers", () => {
  /**
   * Runs `verifyPool` over `site` with a recording settle, quietly.
   *
   * @param site - the site.
   * @returns the settled sites' URLs, and the error thrown (a failed pool), if any.
   */
  async function pool(
    site: SiteConfig,
  ): Promise<{ settled: string[]; thrown?: string }> {
    const settled: string[] = [];
    const warn = console.warn;
    console.warn = () => undefined;
    try {
      await verifyPool([site], "p", "c", [], undefined, (s) => {
        settled.push(s.baseURL);
        return Promise.resolve();
      });
      return { settled };
    } catch (error) {
      return { settled, thrown: String(error) };
    } finally {
      console.warn = warn;
    }
  }

  test("a POSIX shell: checked once, first, then settled", async () => {
    const before = server.commands.length;
    const { settled, thrown } = await pool(siteWith({ runAs: false }));
    expect(thrown).toBeUndefined();
    expect(settled).toEqual([web.baseURL]);
    const sent = sentSince(before);
    const probe = sshCommandLine("/", "printf", ["%s", LOGIN_SHELL_PROBE]);
    expect(sent[0]).toBe(probe);
    expect(sent.filter((line) => line === probe)).toHaveLength(1);
  });

  test("a shell that fails it: never settled, and the pool fails naming it", async () => {
    server.addProgram("printf", "echo changed");
    const { settled, thrown } = await pool(siteWith({ runAs: false }));
    expect(settled).toEqual([]);
    expect(thrown).toContain("Login shell");
  });
});

test.describe("checkLoginShell over the server", () => {
  test("a round-trip that throws is unchecked: no shell blamed, no getent", async () => {
    // Killed by a signal: the exec layer throws, as it does for a dropped connection.
    server.addProgram("printf", "kill -KILL $$");
    server.addProgram(
      "getent",
      "echo 'tester:x:1:1::/home/tester:/usr/bin/tcsh'",
    );
    const before = server.commands.length;
    const site = siteWith({ runAs: false });
    const check = await checkLoginShell(site.transport as SshTransport);
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(
      /^The SSH user's login shell could not be checked: /,
    );
    expect(check.detail).not.toContain("does not pass");
    expect(sentSince(before).join("\n")).not.toContain("getent");
  });

  test("getent's shell is named only when getent exits 0", async () => {
    server.addProgram("printf", "echo changed");
    server.addProgram(
      "getent",
      "echo 'tester:x:1:1::/home/tester:/usr/bin/tcsh'; exit 2",
    );
    const site = siteWith({ runAs: false });
    const check = await checkLoginShell(site.transport as SshTransport);
    expect(check.ok).toBe(false);
    expect(check.detail).not.toContain("The login shell is");
  });

  test("a startup file printing before the output: a gate, getent never asked", async () => {
    server.addProgram("printf", `echo welcome; exec /usr/bin/printf "$@"`);
    const before = server.commands.length;
    const site = siteWith({ runAs: false });
    const check = await checkLoginShell(site.transport as SshTransport);
    expect(check.ok).toBe(false);
    expect(check.detail).toContain("prints text before each command's output");
    expect(sentSince(before).join("\n")).not.toContain("getent");
  });
});

test("the wp --info gate's hint names the identity it ran as", async () => {
  writeFileSync(wpInfoFailsAsSite, "");
  const site = siteWith({ runAs: "www-data:www-data" });

  const result = await verifySite(site, 0);

  expect(result.checks[0]?.ok).toBe(false);
  expect(result.checks[0]?.hint).toBe(
    "Ensure 'wp' is on sudo's secure_path (e.g. /usr/local/bin/wp) for www-data:www-data, the " +
      "identity this site's commands run as, as an executable file.",
  );
});
