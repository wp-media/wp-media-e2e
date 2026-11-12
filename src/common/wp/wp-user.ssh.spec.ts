import { test, expect } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  disposeConnections,
  installKey,
  sshCommandLine,
  sshWrappedLine,
  wpCli,
} from "./exec";
import { runAsArgv } from "./run-as-argv";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
} from "./site-identity";
import { resetWpUserCaches, wpUserCheckArgs } from "./wp-user";
import { resetOwnershipCaches } from "./ownership";
import {
  PRINT_ARGV_PROGRAM,
  decodeArgv,
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { SshTransport } from "../config/types";

/**
 * `wpCli`'s `--user=<login>` over a server that runs what it is sent, with a fake `wp`: the check
 * (once per install, itself without `--user`, always in the root), each verdict's command line with
 * the caller's `cwd` kept, a not-booting site waiting before it is checked again, the retry once on
 * WP-CLI's exact refusal (plain or coloured), the `site` state's check and command through `sudo`,
 * and the login absent from every warning.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

/** A login that needs quoting in a shell, in PHP and in a message check. */
const LOGIN = `o'b"$(id) x`;

const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";
const WWW_ID = "uid=33(www-data) gid=33(www-data) groups=33(www-data)";

/** WP-CLI's refusal of `login` (measured on WP-CLI 2.12). */
const refusalOf = (login: string): string =>
  `Error: Invalid user ID, email or login: '${login}'\n`;

/** The same refusal with `color: true` in WP-CLI's config (measured on 2.12 with `--color`). */
const colouredRefusalOf = (login: string): string =>
  `\u001b[31;1mError:\u001b[0m Invalid user ID, email or login: '${login}'\n`;

/**
 * The fake `wp`'s files, under the server's base: the check's answer (`check.out`, `check.err`,
 * `check.exit`); `gone` (a `--user` call is refused as WP-CLI refuses an unknown login); `refuse-all`
 * (every call is).
 *
 * @param name - the file.
 */
const file = (name: string): string => join(server.base, name);

/** The fake `wp`. The check is told by WP-CLI's fetcher in its snippet. */
const FAKE_WP = (): string => `case "$*" in
  *'WP_CLI\\Fetchers\\User'*)
    cat '${file("check.out")}'; cat '${file("check.err")}' >&2; exit "$(cat '${file("check.exit")}')";;
esac
if [ -e '${file("refuse-all")}' ]; then cat '${file("refusal")}' >&2; exit 1; fi
case "$1" in
  --user=*) if [ -e '${file("gone")}' ]; then cat '${file("refusal")}' >&2; exit 1; fi;;
esac
if [ "$2 $3 $4" = "user get bob" ]; then echo "Error: Invalid user ID, email or login: 'bob'" >&2; exit 1; fi
exec ${PRINT_ARGV_PROGRAM} "$@"`;

/**
 * Sets the check's answer.
 *
 * @param exitCode - its exit.
 * @param stdout - its output.
 * @param stderr - its errors.
 */
function answerCheck(exitCode: number, stdout = "", stderr = ""): void {
  writeFileSync(file("check.out"), stdout);
  writeFileSync(file("check.err"), stderr);
  writeFileSync(file("check.exit"), String(exitCode));
}

/**
 * The check answering with a user.
 *
 * @param user - whether PHP read the login as numeric and whether the user is an administrator.
 */
function checkFinds(user: { numeric: boolean; admin: boolean }): void {
  answerCheck(0, `\ne2e-wp-user:${JSON.stringify(user)}\n`);
}

const ADMIN = { numeric: false, admin: true };

/** Warnings printed while `work` runs. */
async function warningsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    console.warn = original;
  }
  return warnings;
}

/** The line the transport's user is sent. */
const line = (args: readonly string[]): string =>
  sshCommandLine(server.root, "wp", args);

/** The line the transport's user is sent with the caller's `cwd` ({@link CWD}). */
const lineIn = (args: readonly string[]): string =>
  sshCommandLine(CWD(), "wp", args);

/** A working directory other than the root: the server's base folder. */
const CWD = (): string => server.base;

/** The check's line as the transport's user. */
const checkLine = (login: string): string => line(wpUserCheckArgs(login));

/**
 * A site transport with a WordPress login, as the loader makes every site.
 *
 * @param overrides - other fields.
 */
const withLogin = (overrides: Partial<SshTransport> = {}): SshTransport =>
  server.transport({ wpUser: LOGIN, ...overrides });

/** How many checks the server has run, as any user. */
const checkCount = (): number =>
  server.commands.filter((sent) => sent.includes("Fetchers")).length;

/** A site transport with a login whose state is `site` (`www-data`): `auto`, verified. */
function siteTransport(): SshTransport {
  const transport = withLogin({ runAs: "auto" });
  registerSiteIdentityVerdicts(
    new Map([
      [
        installKey(transport),
        {
          verdict: "owner-is-web",
          owner: { user: "www-data", group: "www-data", uid: 33, gid: 33 },
          web: {
            euid: 33,
            egid: 33,
            user: "www-data",
            group: "www-data",
            umask: "0022",
            sapi: "fpm-fcgi",
          },
        },
      ],
    ]),
  );
  return transport;
}

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  started.addProgram("wp", FAKE_WP());
  started.addProgram("stat", "echo 'www-data:www-data:33:33'");
  started.addProgram(
    "id",
    `if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`,
  );
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetWpUserCaches();
  server.denySudo(false);
  for (const name of ["gone", "refuse-all"])
    rmSync(file(name), { force: true });
  writeFileSync(file("refusal"), refusalOf(LOGIN));
  checkFinds(ADMIN);
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

test("no login on the transport: today's line, no check", async () => {
  const transport = server.transport();
  const before = server.commands.length;

  const result = await wpCli(transport, ["option", "get", "x"]);

  expect(decodeArgv(result.stdout)).toEqual(["option", "get", "x"]);
  expect(server.commands.slice(before)).toEqual([line(["option", "get", "x"])]);
});

test("an administrator: one check without --user, then --user=<login> on every call", async () => {
  const transport = withLogin();
  const before = server.commands.length;

  const first = await wpCli(transport, ["option", "get", "x"]);
  const second = await wpCli(transport, ["eval", "echo 1;"]);

  expect(decodeArgv(first.stdout)).toEqual([
    `--user=${LOGIN}`,
    "option",
    "get",
    "x",
  ]);
  expect(decodeArgv(second.stdout)).toEqual([
    `--user=${LOGIN}`,
    "eval",
    "echo 1;",
  ]);
  expect(server.commands.slice(before)).toEqual([
    checkLine(LOGIN),
    line([`--user=${LOGIN}`, "option", "get", "x"]),
    line([`--user=${LOGIN}`, "eval", "echo 1;"]),
  ]);
});

test("an email login naming that administrator: --user=<email>", async () => {
  const email = "QA@Example.Test";
  const transport = server.transport({ wpUser: email });

  const result = await wpCli(transport, ["option", "get", "x"]);

  expect(decodeArgv(result.stdout)).toEqual([
    `--user=${email}`,
    "option",
    "get",
    "x",
  ]);
});

for (const [label, arrange, words] of [
  [
    "a login naming nobody",
    () => {
      answerCheck(1, "", `Deprecated: noise\n${refusalOf(LOGIN)}`);
    },
    "names no user",
  ],
  [
    "a non-administrator",
    () => {
      checkFinds({ ...ADMIN, admin: false });
    },
    "not an administrator",
  ],
  [
    "a numeric login read as another user's ID",
    () => {
      checkFinds({ numeric: true, admin: true });
    },
    "is numeric",
  ],
] as const) {
  test(`${label}: no --user for the install, one check, warned once without the login`, async () => {
    arrange();
    const transport = withLogin();
    const before = server.commands.length;

    const warnings = await warningsDuring(async () => {
      await wpCli(transport, ["option", "get", "x"]);
      await wpCli(transport, ["option", "get", "y"]);
    });

    expect(server.commands.slice(before)).toEqual([
      checkLine(LOGIN),
      line(["option", "get", "x"]),
      line(["option", "get", "y"]),
    ]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(words);
    expect(warnings[0]).not.toContain(LOGIN);
  });
}

test("WordPress not booting: no --user and no warning, and calls in the wait run without a check", async () => {
  answerCheck(255, "", "Error: Error establishing a database connection.\n");
  const transport = withLogin();
  const before = server.commands.length;

  const warnings = await warningsDuring(async () => {
    await wpCli(transport, ["core", "is-installed"]);
    checkFinds(ADMIN);
    await wpCli(transport, ["option", "get", "x"]);
  });

  expect(server.commands.slice(before)).toEqual([
    checkLine(LOGIN),
    line(["core", "is-installed"]),
    line(["option", "get", "x"]),
  ]);
  expect(warnings).toEqual([]);
});

test("the login removed mid-process: the call runs again once without --user, and later calls in the wait run without a check", async () => {
  const transport = withLogin();
  await wpCli(transport, ["option", "get", "x"]);
  writeFileSync(file("gone"), "");
  const before = server.commands.length;

  let retried = { stdout: "", stderr: "", exitCode: -1 };
  const warnings = await warningsDuring(async () => {
    retried = await wpCli(transport, ["option", "get", "y"]);
    await wpCli(transport, ["option", "get", "z"]);
  });

  expect(retried.exitCode).toBe(0);
  expect(decodeArgv(retried.stdout)).toEqual(["option", "get", "y"]);
  expect(retried.stderr).not.toContain(LOGIN);
  expect(server.commands.slice(before)).toEqual([
    line([`--user=${LOGIN}`, "option", "get", "y"]),
    line(["option", "get", "y"]),
    line(["option", "get", "z"]),
  ]);
  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("no longer names a user");
  expect(warnings[0]).not.toContain(LOGIN);
});

test("a coloured refusal (WP-CLI's `color: true`) is retried just as a plain one", async () => {
  const transport = withLogin();
  await wpCli(transport, ["option", "get", "x"]);
  writeFileSync(file("refusal"), colouredRefusalOf(LOGIN));
  writeFileSync(file("gone"), "");
  const before = server.commands.length;

  let retried = { stdout: "", stderr: "", exitCode: -1 };
  await warningsDuring(async () => {
    retried = await wpCli(transport, ["option", "get", "y"]);
  });

  expect(retried.exitCode).toBe(0);
  expect(retried.stderr).not.toContain(LOGIN);
  expect(server.commands.slice(before)).toEqual([
    line([`--user=${LOGIN}`, "option", "get", "y"]),
    line(["option", "get", "y"]),
  ]);
});

test("a coloured refusal from the check: drop/missing", async () => {
  answerCheck(1, "", colouredRefusalOf(LOGIN));
  const transport = withLogin();

  const warnings = await warningsDuring(() =>
    wpCli(transport, ["option", "get", "x"]),
  );

  expect(warnings).toHaveLength(1);
  expect(warnings[0]).toContain("names no user");
});

test.describe("the caller's cwd: kept on every path, never given to the check", () => {
  test("no login", async () => {
    const before = server.commands.length;
    await wpCli(server.transport(), ["option", "get", "x"], { cwd: CWD() });
    expect(server.commands.slice(before)).toEqual([
      lineIn(["option", "get", "x"]),
    ]);
  });

  test("an administrator: the check in the root, the command in cwd", async () => {
    const before = server.commands.length;
    await wpCli(withLogin(), ["option", "get", "x"], { cwd: CWD() });
    expect(server.commands.slice(before)).toEqual([
      checkLine(LOGIN),
      lineIn([`--user=${LOGIN}`, "option", "get", "x"]),
    ]);
  });

  test("a dropped login", async () => {
    checkFinds({ ...ADMIN, admin: false });
    const before = server.commands.length;
    await warningsDuring(() =>
      wpCli(withLogin(), ["option", "get", "x"], { cwd: CWD() }),
    );
    expect(server.commands.slice(before)).toEqual([
      checkLine(LOGIN),
      lineIn(["option", "get", "x"]),
    ]);
  });

  test("the retry after a mid-process refusal", async () => {
    const transport = withLogin();
    await wpCli(transport, ["option", "get", "x"]);
    writeFileSync(file("gone"), "");
    const before = server.commands.length;
    await warningsDuring(() =>
      wpCli(transport, ["option", "get", "y"], { cwd: CWD() }),
    );
    expect(server.commands.slice(before)).toEqual([
      lineIn([`--user=${LOGIN}`, "option", "get", "y"]),
      lineIn(["option", "get", "y"]),
    ]);
  });
});

test("the retry runs once: a second refusal is returned as it is", async () => {
  const transport = withLogin();
  await wpCli(transport, ["option", "get", "x"]);
  writeFileSync(file("refuse-all"), "");
  const before = server.commands.length;

  let exitCode = -1;
  const warnings = await warningsDuring(async () => {
    ({ exitCode } = await wpCli(transport, ["option", "get", "y"]));
  });

  expect(exitCode).toBe(1);
  expect(warnings).toHaveLength(1);
  expect(server.commands.slice(before)).toEqual([
    line([`--user=${LOGIN}`, "option", "get", "y"]),
    line(["option", "get", "y"]),
  ]);
});

test("a command's own refusal of another login is its answer: no retry, --user kept", async () => {
  const transport = withLogin();
  await wpCli(transport, ["option", "get", "x"]);
  const before = server.commands.length;

  const result = await wpCli(transport, ["user", "get", "bob"]);
  await wpCli(transport, ["option", "get", "y"]);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("Error: Invalid user ID, email or login: 'bob'");
  expect(server.commands.slice(before)).toEqual([
    line([`--user=${LOGIN}`, "user", "get", "bob"]),
    line([`--user=${LOGIN}`, "option", "get", "y"]),
  ]);
});

test("an as-today copy: no check, no --user", async () => {
  const transport = asTransportUser(withLogin());
  const before = server.commands.length;

  const result = await wpCli(transport, ["option", "get", "x"]);

  expect(decodeArgv(result.stdout)).toEqual(["option", "get", "x"]);
  expect(server.commands.slice(before)).toEqual([line(["option", "get", "x"])]);
});

test("site state: the check and the command run through sudo; only the command carries --user", async () => {
  const transport = siteTransport();
  const www = { user: "www-data", group: "www-data" };
  const sudoBefore = server.sudoCalls().length;
  const before = server.commands.length;

  const result = await wpCli(transport, ["option", "get", "x"]);

  expect(decodeArgv(result.stdout)).toEqual([
    `--user=${LOGIN}`,
    "option",
    "get",
    "x",
  ]);
  const check = runAsArgv(
    www,
    "0022",
    server.root,
    "wp",
    wpUserCheckArgs(LOGIN),
  );
  const command = runAsArgv(www, "0022", server.root, "wp", [
    `--user=${LOGIN}`,
    "option",
    "get",
    "x",
  ]);
  expect(server.commands.slice(before).slice(-2)).toEqual([
    sshWrappedLine(check),
    sshWrappedLine(command),
  ]);
  // The run probe, then the check and the command, as www-data.
  expect(server.sudoCalls().slice(sudoBefore).slice(-2)).toEqual([
    check.slice(1),
    command.slice(1),
  ]);
});

test("one answer per runner: the same install run as the site checks for itself", async () => {
  await wpCli(withLogin(), ["option", "get", "x"]);
  const checksBefore = checkCount();

  await wpCli(siteTransport(), ["option", "get", "y"]);
  await wpCli(siteTransport(), ["option", "get", "z"]);
  await wpCli(withLogin(), ["option", "get", "w"]);

  expect(checkCount() - checksBefore).toBe(1);
});
