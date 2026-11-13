import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CommandKilledError, SiteIdentityRefusedError } from "./errors";
import {
  decodeOutput,
  disposeConnections,
  elevationSupport,
  exec,
  execAsTransport,
  execAsSite,
  execElevated,
  installKey,
  resetElevationCaches,
  sshCommandLine,
  sshWrappedLine,
  wpCli,
} from "./exec";
import { planOwnership, resetOwnershipCaches } from "./ownership";
import { isPluginInstalled } from "./plugin";
import { verifySite } from "../setup/preflight";
import { runAsArgv } from "./run-as-argv";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  SUDO_DENIED,
  resolveSiteIdentity,
  runProbeArgv,
} from "./site-identity";
import { HOSTILE_ARGUMENTS } from "../__fixtures__/hostile-arguments";
import {
  FAKE_SUDO_NOISE,
  PRINT_ARGV_PROGRAM,
  decodeArgv,
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { SshTransport } from "../config/types";
import type { SiteIdentityVerdict } from "./web-identity";

/**
 * `exec`/`wpCli` routed by the site's identity state, over a server that runs what it is sent: in
 * `site` through `sudo -u -g` and the umask wrapper (a fake `sudo` that exports who it was asked to
 * run as, so a fake `id` answers as that identity); in every other state as the transport's user,
 * byte for byte the line sent before the identity existed. Probes and root keep the transport's user.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

const WWW_ID = "uid=33(www-data) gid=33(www-data) groups=33(www-data)";
const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";
const WWW = { user: "www-data", group: "www-data" };
const WWW_OWNER = { ...WWW, uid: 33, gid: 33 };

/** What the `utf8` program prints, on stdout and stderr: 3-byte characters after one ASCII byte. */
const UTF8_TEXT = `a${"€".repeat(100_000)}`;

/** `www-data` run with `-g deploy`: a group other than its own, so user and group cannot be confused. */
const DEPLOY_ID =
  "uid=33(www-data) gid=1001(deploy) groups=1001(deploy),33(www-data)";

/** The fake `id`: the identity `sudo -u` asked for (`deploy` as the group when asked), else the transport's user. */
const FAKE_ID = `if [ "$E2E_FAKE_SUDO_GROUP" = deploy ]; then echo '${DEPLOY_ID}'; elif [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`;

/** sudo's refusal with no rule for the call. */
const PASSWORD_REQUIRED = "sudo: a password is required";

/** How many run probes the fake `sudo` has received. */
const runProbes = (): number =>
  server
    .sudoCalls()
    .filter((argv) => argv.some((arg) => arg.includes("e2e-run-probe"))).length;

/** sudo's line for a host that cannot resolve its own name, as a program prints it itself. */
const HOST_NOISE =
  "sudo: unable to resolve host twin-7: Name or service not known";

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  const utf8File = join(started.base, "utf8.txt");
  writeFileSync(utf8File, UTF8_TEXT);
  started.addProgram("stat", "echo 'www-data:www-data:33:33'");
  started.addProgram("id", FAKE_ID);
  started.addProgram("wp", `exec ${PRINT_ARGV_PROGRAM} "$@"`);
  started.addProgram(
    "noisy",
    `echo '${HOST_NOISE}' >&2; echo 'real error' >&2; echo out; exit 3`,
  );
  started.addProgram(
    "noisy-late",
    `echo 'real error' >&2; echo '${HOST_NOISE}' >&2; exit 0`,
  );
  started.addProgram("fails", "echo 'Error: not installed' >&2; exit 1");
  started.addProgram("real-error", "echo 'real error' >&2; echo out; exit 3");
  started.addProgram("utf8", `cat '${utf8File}'; cat '${utf8File}' >&2`);
  started.addProgram("kill-me", "kill -TERM $$\n");
  // What a refusal by sudo looks like to `exec`, at once or once the file `$1` exists.
  started.addProgram("refused-now", `echo '${PASSWORD_REQUIRED}' >&2; exit 1`);
  started.addProgram(
    "refused-late",
    `while [ ! -e "$1" ]; do sleep 0.05; done; echo '${PASSWORD_REQUIRED}' >&2; exit 1`,
  );
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  server.denySudo(false);
  server.sudoNoise(false);
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * A verdict for `transport`'s install: PHP runs as the docroot's owner (`www-data`), or as another.
 *
 * @param transport - the site.
 * @param verdict - what the pre-flight concluded.
 */
function giveVerdict(
  transport: SshTransport,
  verdict: "owner-is-web" | "owner-not-web" = "owner-is-web",
): void {
  const web =
    verdict === "owner-is-web"
      ? { euid: 33, egid: 33, user: "www-data", group: "www-data" }
      : { euid: 34, egid: 34, user: "backup", group: "backup" };
  const entry: SiteIdentityVerdict = {
    verdict,
    owner: WWW_OWNER,
    web: { ...web, umask: "0022", sapi: "fpm-fcgi" },
  };
  registerSiteIdentityVerdicts(new Map([[installKey(transport), entry]]));
}

/**
 * An `auto` site the pre-flight verified: its state is `site`, as `www-data:www-data`.
 *
 * @param overrides - transport fields to replace.
 */
function siteTransport(overrides: Partial<SshTransport> = {}): SshTransport {
  const transport = server.transport({ runAs: "auto", ...overrides });
  giveVerdict(transport);
  return transport;
}

/** The line the transport's user has always been sent: `cd -- <root> && exec <file> <args…>`. */
const todaysLine = (file: string, args: readonly string[]): string =>
  sshCommandLine(server.root, file, args);

test.describe("every state but site sends today's line", () => {
  for (const [label, overrides] of [
    ["runAs absent (auto, no verdict)", {}],
    ["runAs false", { runAs: false }],
  ] as const) {
    test(`${label}: exactly today's line, and no other command`, async () => {
      const transport = server.transport(overrides);
      const before = server.commands.length;

      const result = await exec(transport, PRINT_ARGV_PROGRAM, [
        ...HOSTILE_ARGUMENTS,
      ]);
      const cli = await wpCli(transport, ["option", "get", ""]);

      expect(decodeArgv(result.stdout)).toEqual(HOSTILE_ARGUMENTS);
      expect(decodeArgv(cli.stdout)).toEqual(["option", "get", ""]);
      expect(server.commands.slice(before)).toEqual([
        todaysLine(PRINT_ARGV_PROGRAM, HOSTILE_ARGUMENTS),
        todaysLine("wp", ["option", "get", ""]),
      ]);
    });
  }

  test("fallback/no-sudo: today's line; the probes, as the transport's user, only once", async () => {
    const transport = siteTransport();
    server.denySudo(true);
    const before = server.commands.length;

    await exec(transport, PRINT_ARGV_PROGRAM, ["a b"]);
    await exec(transport, PRINT_ARGV_PROGRAM, ["c"]);

    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "fallback",
      reason: "no-sudo",
    });
    const probe = runProbeArgv(WWW, "0022", server.root);
    expect(server.commands.slice(before)).toEqual([
      todaysLine("stat", ["-c", "%U:%G:%u:%g", `${server.root}/wp-content`]),
      todaysLine("id", []),
      sshCommandLine("/", "sudo", probe.slice(1)),
      todaysLine(PRINT_ARGV_PROGRAM, ["a b"]),
      todaysLine(PRINT_ARGV_PROGRAM, ["c"]),
    ]);
  });

  test("fallback/owner-not-web: today's line, after the transport's probes and no sudo", async () => {
    const transport = server.transport({ runAs: "auto" });
    giveVerdict(transport, "owner-not-web");
    const sudoBefore = server.sudoCalls().length;
    const before = server.commands.length;

    await exec(transport, PRINT_ARGV_PROGRAM, ["x"]);

    expect(server.commands.slice(before)).toEqual([
      todaysLine("stat", ["-c", "%U:%G:%u:%g", `${server.root}/wp-content`]),
      todaysLine("id", []),
      todaysLine(PRINT_ARGV_PROGRAM, ["x"]),
    ]);
    expect(server.sudoCalls().length).toBe(sudoBefore);
  });

  test("an as-today copy of a site transport sends today's line, with no probe", async () => {
    const transport = siteTransport();
    await exec(transport, "true", []);
    const before = server.commands.length;

    await exec(asTransportUser(transport), PRINT_ARGV_PROGRAM, ["x"]);

    expect(server.commands.slice(before)).toEqual([
      todaysLine(PRINT_ARGV_PROGRAM, ["x"]),
    ]);
  });
});

test.describe("the site state", () => {
  test("every argument reaches the program through sudo and the wrapper, sent with no cd", async () => {
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    const before = server.commands.length;

    const result = await exec(transport, PRINT_ARGV_PROGRAM, [
      ...HOSTILE_ARGUMENTS,
    ]);

    expect(result.exitCode).toBe(0);
    expect(decodeArgv(result.stdout)).toEqual(HOSTILE_ARGUMENTS);
    const argv = runAsArgv(
      WWW,
      "0022",
      server.root,
      PRINT_ARGV_PROGRAM,
      HOSTILE_ARGUMENTS,
    );
    expect(server.commands.slice(before)).toEqual([sshWrappedLine(argv)]);
    expect(server.commands.at(-1)).toMatch(/^exec 'sudo' '-n' '-u' 'www-data'/);
    expect(server.sudoCalls().at(-1)).toEqual(argv.slice(1));
  });

  test("wpCli runs wp as the identity, its arguments intact", async () => {
    const transport = siteTransport();

    const result = await wpCli(transport, ["option", "update", "x", ""]);

    expect(decodeArgv(result.stdout)).toEqual(["option", "update", "x", ""]);
    expect(server.sudoCalls().at(-1)).toEqual(
      runAsArgv(WWW, "0022", server.root, "wp", [
        "option",
        "update",
        "x",
        "",
      ]).slice(1),
    );
  });

  test("the wrapper sets the site's umask and enters the working directory as the identity", async () => {
    const transport = siteTransport({ umask: "0027" });

    const inRoot = await exec(transport, "sh", ["-c", "umask; pwd"]);
    const elsewhere = await exec(transport, "pwd", [], { cwd: server.base });
    const missing = await exec(transport, PRINT_ARGV_PROGRAM, ["x"], {
      cwd: join(server.base, "missing"),
    });

    expect(inRoot.stdout).toBe(`0027\n${server.root}`);
    expect(elsewhere.stdout).toBe(server.base);
    // The wrapper's `cd` failed: nothing ran, and the shell names the wrapper, never a value.
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toMatch(/e2e-run-as/);
  });

  test("a numeric identity is handed to sudo as #id", async () => {
    // Declared: no verdict needed. The fake `id` answers www-data(33), which is 33:33.
    const transport = server.transport({ runAs: "33:33" });

    await exec(transport, "true", []);

    expect(server.sudoCalls().at(-1)?.slice(0, 6)).toEqual([
      "-n",
      "-u",
      "#33",
      "-g",
      "#33",
      "--",
    ]);
  });

  test("sudo's unresolvable-host line leaves the stderr of every command sudo carries, as the site or root; the rest stays", async () => {
    const transport = siteTransport();
    // Resolved before sudo turns noisy: what is judged here is the commands, not the probes.
    await resolveSiteIdentity(transport);
    server.sudoNoise(true);

    const asSite = await exec(transport, "real-error", []);
    const asRoot = await execElevated(transport, "real-error", []);
    const siteFails = await exec(transport, "fails", []);

    for (const result of [asSite, asRoot]) {
      expect(result).toEqual({
        stdout: "out",
        stderr: "real error",
        exitCode: 3,
      });
    }
    expect(siteFails.stderr).toBe("Error: not installed");
    // Without the fix the line was the first thing a refusal check, a message or a parse read.
    expect(JSON.stringify([asSite, asRoot, siteFails])).not.toContain(
      "unable to resolve host",
    );
  });

  test("sudo's line on every call changes no decision: the run probe verifies site, a refusal still throws typed, root stays available", async () => {
    server.sudoNoise(true);
    resetElevationCaches();
    const transport = siteTransport();

    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "site",
    });
    await expect(elevationSupport(transport)).resolves.toBe("available");
    server.denySudo(true);
    const refused = exec(transport, "fails", []);
    await expect(refused).rejects.toBeInstanceOf(SiteIdentityRefusedError);
    await expect(refused).rejects.not.toThrow(/resolve host/);
  });

  test("a command run as the transport's user keeps its stderr as printed: one running sudo itself sees sudo's line", async () => {
    server.sudoNoise(true);
    const transport = server.transport();

    const own = await exec(transport, "noisy", []);
    const sudo = await execAsTransport(transport, "sudo", ["-n", "true"]);

    expect(own.stderr).toBe(`${HOST_NOISE}\nreal error`);
    expect(sudo).toEqual({ stdout: "", stderr: FAKE_SUDO_NOISE, exitCode: 0 });
  });

  test("a killed command names the program, never sudo nor its arguments", async () => {
    const failure = exec(siteTransport(), "kill-me", ["--key=SECRET-planted"]);

    await expect(failure).rejects.toBeInstanceOf(CommandKilledError);
    await expect(failure).rejects.toThrow(
      '[wp/exec] "kill-me" on tester@site.test was terminated by signal SIGTERM before exiting.',
    );
    await expect(failure).rejects.not.toThrow(/sudo|SECRET/);
  });

  test("the same line printed by the program after its own words is kept, as the site or root", async () => {
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    server.sudoNoise(true);

    const late = await exec(transport, "noisy-late", []);
    const root = await execElevated(transport, "noisy-late", []);

    for (const result of [late, root]) {
      expect(result).toEqual({
        stdout: "",
        stderr: `real error\n${HOST_NOISE}`,
        exitCode: 0,
      });
    }
  });

  test("the program's own exit 1 is an answer, returned as one", async () => {
    await expect(exec(siteTransport(), "fails", [])).resolves.toEqual({
      stdout: "",
      stderr: "Error: not installed",
      exitCode: 1,
    });
  });

  test("sudo refusing a verified identity mid-run throws, naming the program only; the next command resolves again", async () => {
    const transport = siteTransport();
    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "site",
    });
    server.denySudo(true);

    // `wp plugin is-installed`'s exit 1 reads "absent": never answered from sudo's refusal.
    const installed = isPluginInstalled(transport, "SECRET-slug");
    await expect(installed).rejects.toBeInstanceOf(SiteIdentityRefusedError);
    await expect(installed).rejects.toThrow(
      '[wp/exec] "wp" on tester@site.test did not run',
    );
    await expect(installed).rejects.not.toThrow(/sudo|SECRET/);

    // Forgotten, so resolved again: verified once more, then refused again.
    server.denySudo(false);
    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "site",
    });
    server.denySudo(true);
    await expect(
      exec(transport, PRINT_ARGV_PROGRAM, ["--key=SECRET-x"]),
    ).rejects.toBeInstanceOf(SiteIdentityRefusedError);

    const before = server.commands.length;
    const next = await exec(transport, PRINT_ARGV_PROGRAM, ["y"]);
    expect(decodeArgv(next.stdout)).toEqual(["y"]);
    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "fallback",
      reason: "no-sudo",
    });
    expect(server.commands.slice(before).at(-1)).toBe(
      todaysLine(PRINT_ARGV_PROGRAM, ["y"]),
    );
  });

  test("sudo's explicit deny mid-run, quoting the arguments, is a refusal never quoted; resolved again, no-sudo names it", async () => {
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    server.denySudo(true, "explicit");

    const refused = exec(transport, PRINT_ARGV_PROGRAM, [
      "--key=SECRET a\nb",
      "it's",
    ]);
    await expect(refused).rejects.toBeInstanceOf(SiteIdentityRefusedError);
    await expect(refused).rejects.not.toThrow(/SECRET|Sorry|not allowed/);

    const state = await resolveSiteIdentity(transport);
    expect(state).toMatchObject({ kind: "fallback", reason: "no-sudo" });
    expect(JSON.stringify(state)).not.toMatch(/SECRET|Sorry|not allowed/);
    expect(state).toMatchObject({ detail: SUDO_DENIED });
  });

  test("a refusal arriving late, from a command started on the older resolution, leaves the newer one", async () => {
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    const gate = join(server.base, `gate-${String(Date.now())}`);
    const before = runProbes();

    const slow = exec(transport, "refused-late", [gate]);
    slow.catch(() => undefined); // Awaited below; never an unhandled rejection meanwhile.
    await expect(exec(transport, "refused-now", [])).rejects.toBeInstanceOf(
      SiteIdentityRefusedError,
    );
    await exec(transport, "true", []); // Resolved again: one run probe.
    expect(runProbes()).toBe(before + 1);

    writeFileSync(gate, "");
    await expect(slow).rejects.toBeInstanceOf(SiteIdentityRefusedError);
    await exec(transport, "true", []);
    expect(runProbes()).toBe(before + 1);
  });

  test("a refusal on one install forgets only its own state: another install sends no new run probe", async () => {
    const second = join(server.base, "second root");
    mkdirSync(second, { recursive: true });
    const refused = siteTransport();
    const other = siteTransport({ rootDir: second });
    await resolveSiteIdentity(refused);
    await expect(resolveSiteIdentity(other)).resolves.toMatchObject({
      kind: "site",
    });
    const before = runProbes();

    await expect(exec(refused, "refused-now", [])).rejects.toBeInstanceOf(
      SiteIdentityRefusedError,
    );
    await exec(other, "true", []);
    expect(runProbes()).toBe(before);
  });

  test("a declared user and a different group: sudo gets each in its place, and a rule refusing that user is no-sudo", async () => {
    const transport = server.transport({ runAs: "www-data:deploy" });

    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "site",
      target: { user: "www-data", group: "deploy" },
      identity: { user: "www-data", group: "deploy", uid: 33, gid: 1001 },
    });
    await exec(transport, "true", []);
    expect(server.sudoCalls().at(-1)?.slice(0, 6)).toEqual([
      "-n",
      "-u",
      "www-data",
      "-g",
      "deploy",
      "--",
    ]);

    resetSiteIdentityCaches();
    server.denySudo({ user: "www-data" });
    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "fallback",
      reason: "no-sudo",
    });
  });

  test("execAsSite refuses a docker or local transport, before anything runs", async () => {
    const identity = { target: WWW, umask: "0022" };
    for (const transport of [
      { mode: "docker", container: "c" },
      { mode: "local", rootDir: server.root },
    ]) {
      await expect(
        // A transport the types forbid, as a caller casting past them would pass it.
        execAsSite(transport as unknown as SshTransport, identity, "true", []),
      ).rejects.toThrow(/refusing to run "true" as the site's identity on a/);
    }
  });

  test("probes and root keep the transport's user: sudo -n true unwrapped, root's sudo -n --", async () => {
    resetElevationCaches();
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    const before = server.commands.length;

    await expect(elevationSupport(transport)).resolves.toBe("available");
    const elevated = await execElevated(transport, PRINT_ARGV_PROGRAM, ["a"]);
    const plain = await execAsTransport(transport, "id", []);

    expect(server.commands.slice(before)).toEqual([
      todaysLine("sudo", ["-n", "true"]),
      todaysLine("sudo", ["-n", "--", PRINT_ARGV_PROGRAM, "a"]),
      todaysLine("id", []),
    ]);
    expect(decodeArgv(elevated.stdout)).toEqual(["a"]);
    expect(plain.stdout).toBe(UBUNTU_ID);
  });

  test("a rule refusing the identity but allowing root: fallback/no-sudo, elevation still available", async () => {
    resetElevationCaches();
    const transport = siteTransport();
    server.denySudo({ user: "www-data" });

    await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
      kind: "fallback",
      reason: "no-sudo",
    });
    await expect(elevationSupport(transport)).resolves.toBe("available");
  });
});

test("the pre-flight's root check asks the SSH user, whom its hint names; WP-CLI's check runs as the site", async () => {
  const transport = siteTransport();
  await resolveSiteIdentity(transport);
  const before = server.commands.length;

  await verifySite(
    {
      baseURL: "http://site.test",
      username: "admin",
      password: "pw",
      transport,
    },
    0,
  );

  const sent = server.commands.slice(before);
  expect(sent).toContain(sshCommandLine("/", "ls", ["-d", `${server.root}/.`]));
  expect(sent).toContain(
    sshWrappedLine(runAsArgv(WWW, "0022", "/", "wp", ["--info"])),
  );
});

test("planOwnership compares the owner with who commands run as: the identity in site, else the transport's user", async () => {
  const site = siteTransport();
  // The same install, its verdict too, but `runAs: false`: commands run as the transport's user.
  const disabled = server.transport({ runAs: false });

  const inSite = await planOwnership(site);
  const asTransport = await planOwnership(disabled);

  expect(inSite).toEqual({
    kind: "unnecessary",
    target: WWW_OWNER,
    site: { installOwner: WWW_OWNER },
  });
  expect(asTransport).toMatchObject({
    kind: "grant",
    target: WWW_OWNER,
    identity: { uid: 1000, gid: 1000 },
  });
});

test("planOwnership: a run probe whose transport fails is unknown-identity, not cached; once it runs, unnecessary", async () => {
  const transport = siteTransport();
  // The identity's `id` kills the run probe's shell: the channel reports a signal, a transport failure.
  server.addProgram(
    "id",
    `if [ -n "$E2E_FAKE_SUDO_USER" ]; then kill -KILL $PPID; fi\n${FAKE_ID}`,
  );
  try {
    await expect(planOwnership(transport)).resolves.toEqual({
      kind: "unknown-identity",
      target: WWW_OWNER,
    });
  } finally {
    server.addProgram("id", FAKE_ID);
  }

  await expect(planOwnership(transport)).resolves.toEqual({
    kind: "unnecessary",
    target: WWW_OWNER,
    site: { installOwner: WWW_OWNER },
  });
});

test.describe("output is decoded whole", () => {
  for (const [label, transport] of [
    ["as the transport's user", () => server.transport()],
    ["as the site", () => siteTransport()],
  ] as const) {
    test(`${label}: a character split between chunks survives, on stdout and stderr`, async () => {
      const result = await exec(transport(), "utf8", []);

      expect(result.stdout.includes("�")).toBe(false);
      expect(result.stdout).toBe(UTF8_TEXT);
      expect(result.stderr).toBe(UTF8_TEXT);
    });
  }

  test("decodeOutput joins the chunks before decoding", () => {
    const bytes = Buffer.from("é€😀");

    const chunks = [
      bytes.subarray(0, 1),
      bytes.subarray(1, 4),
      bytes.subarray(4),
    ];

    expect(decodeOutput(chunks)).toBe("é€😀");
    expect(decodeOutput([])).toBe("");
  });
});

test.describe("sshWrappedLine", () => {
  test("execs the argv, every word quoted, with no cd", () => {
    expect(sshWrappedLine(["sudo", "-n", "it's", ""])).toBe(
      `exec 'sudo' '-n' 'it'\\''s' ''`,
    );
  });

  for (const [label, argv] of [
    ["an empty argv", []],
    ["an empty program", ["", "x"]],
    ["a program beginning with -", ["-x"]],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => sshWrappedLine(argv)).toThrow(
        /refusing to send a wrapped command/,
      );
    });
  }
});
