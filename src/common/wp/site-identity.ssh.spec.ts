import { test, expect } from "@playwright/test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { CommandKilledError } from "./errors";
import { disposeConnections, installKey, sshCommandLine } from "./exec";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
  runProbeArgv,
} from "./site-identity";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { SshTransport } from "../config/types";
import type { SiteIdentityVerdict } from "./web-identity";

/**
 * `resolveSiteIdentity` over a server that runs what it is sent: the probes it sends as the transport's
 * user, the run probe through the fake `sudo` (which exports the identity it was asked for, so a fake
 * `id` answers as it), memoisation, and a probe that throws being rethrown, never cached.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

/** Files the fake programs read their answers from, in the server's folder. */
const answers = {
  /** `stat`'s output; `SEGV` makes it kill itself. */
  stat: "",
  /** `id`'s output as the transport's user. */
  idPlain: "",
  /** `id`'s output under the fake `sudo`. */
  idSudo: "",
  /** Exists: `wp --info` fails under the fake `sudo`. */
  wpFails: "",
};

const WWW_ID = "uid=33(www-data) gid=33(www-data) groups=33(www-data)";
const UBUNTU_ID =
  "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)";
const WWW_OWNER = { user: "www-data", group: "www-data", uid: 33, gid: 33 };

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  answers.stat = join(started.base, "stat.answer");
  answers.idPlain = join(started.base, "id-plain.answer");
  answers.idSudo = join(started.base, "id-sudo.answer");
  answers.wpFails = join(started.base, "wp.fails");
  started.addProgram(
    "stat",
    `a=$(cat '${answers.stat}'); [ "$a" = SEGV ] && kill -SEGV $$; printf '%s\\n' "$a"`,
  );
  started.addProgram(
    "id",
    `if [ -n "$E2E_FAKE_SUDO_USER" ]; then cat '${answers.idSudo}'; else cat '${answers.idPlain}'; fi`,
  );
  started.addProgram(
    "wp",
    `if [ -n "$E2E_FAKE_SUDO_USER" ] && [ -e '${answers.wpFails}' ]; then echo 'wp: broken' >&2; exit 1; fi; echo 'WP-CLI 2.12.0'`,
  );
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  writeFileSync(answers.stat, "www-data:www-data:33:33");
  writeFileSync(answers.idPlain, UBUNTU_ID);
  writeFileSync(answers.idSudo, WWW_ID);
  rmSync(answers.wpFails, { force: true });
  server.denySudo(false);
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** An `auto` transport on the server. */
const auto = (overrides: Partial<SshTransport> = {}): SshTransport =>
  server.transport({ runAs: "auto", ...overrides });

/** Gives the process the verdict that the owner is PHP's identity. */
function verifyOwner(transport: SshTransport): void {
  const verdict: SiteIdentityVerdict = {
    verdict: "owner-is-web",
    owner: WWW_OWNER,
    web: {
      euid: 33,
      egid: 33,
      user: "www-data",
      group: "www-data",
      umask: "0022",
      sapi: "fpm-fcgi",
    },
  };
  registerSiteIdentityVerdicts(new Map([[installKey(transport), verdict]]));
}

test("auto with a verified owner: one run probe through the exact wrapper, then site, memoised", async () => {
  const transport = auto({ umask: "0002" });
  verifyOwner(transport);
  const sudoBefore = server.sudoCalls().length;

  const state = await resolveSiteIdentity(transport);

  expect(state).toEqual({
    kind: "site",
    target: { user: "www-data", group: "www-data" },
    identity: {
      user: "www-data",
      group: "www-data",
      uid: 33,
      gid: 33,
      groupIds: [33],
      groupNames: ["www-data"],
    },
    umask: "0002",
  });
  const argv = runProbeArgv(
    { user: "www-data", group: "www-data" },
    "0002",
    server.root,
  );
  expect(server.sudoCalls().slice(sudoBefore)).toEqual([argv.slice(1)]);
  // Sent from `/`: the wrapper enters the root as the identity, the SSH user never has to.
  expect(server.commands).toContain(
    sshCommandLine("/", argv[0] ?? "", argv.slice(1)),
  );
  const sent = server.commands.length;
  await expect(resolveSiteIdentity(transport)).resolves.toEqual(state);
  expect(server.commands.length).toBe(sent);
});

test("auto without this run's verdict falls back as unverified, never asking sudo", async () => {
  const sudoBefore = server.sudoCalls().length;

  await expect(resolveSiteIdentity(auto())).resolves.toMatchObject({
    kind: "fallback",
    reason: "unverified",
  });
  expect(server.sudoCalls().length).toBe(sudoBefore);
});

test("auto without this run's verdict sends no command at all: no stat, no id", async () => {
  const sent = server.commands.length;

  await expect(resolveSiteIdentity(auto())).resolves.toMatchObject({
    kind: "fallback",
    reason: "unverified",
  });
  expect(server.commands.length).toBe(sent);
});

test("a verdict given after an unverified answer makes the next call decide again", async () => {
  const transport = auto();
  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    reason: "unverified",
  });

  verifyOwner(transport);

  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "site",
  });
});

test("sudo refusing the run probe is fallback/no-sudo", async () => {
  const transport = auto();
  verifyOwner(transport);
  server.denySudo(true);

  await expect(resolveSiteIdentity(transport)).resolves.toEqual({
    kind: "fallback",
    reason: "no-sudo",
    detail: "sudo: a password is required",
  });
});

test("wp failing under sudo is fallback/no-wp", async () => {
  const transport = auto();
  verifyOwner(transport);
  writeFileSync(answers.wpFails, "");

  await expect(resolveSiteIdentity(transport)).resolves.toEqual({
    kind: "fallback",
    reason: "no-wp",
    detail: "wp: broken",
  });
});

test("a root the identity cannot enter is fallback/no-root-access", async () => {
  const transport = server.transport({
    runAs: "www-data:www-data",
    rootDir: join(server.root, "missing"),
  });

  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "fallback",
    reason: "no-root-access",
  });
});

test("sudo running the probe as other ids is fallback/probe-mismatch", async () => {
  const transport = auto();
  verifyOwner(transport);
  writeFileSync(answers.idSudo, UBUNTU_ID);

  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "fallback",
    reason: "probe-mismatch",
  });
});

test("a transport's user that already is the verified owner is same-user, with no sudo call", async () => {
  writeFileSync(answers.idPlain, WWW_ID);
  const transport = auto();
  verifyOwner(transport);
  const sudoBefore = server.sudoCalls().length;

  await expect(resolveSiteIdentity(transport)).resolves.toEqual({
    kind: "same-user",
    reason: "transport-user",
  });
  expect(server.sudoCalls().length).toBe(sudoBefore);
});

test("a transport's user that is the owner, with no verdict, is fallback/unverified, with no sudo call", async () => {
  writeFileSync(answers.idPlain, WWW_ID);
  const sudoBefore = server.sudoCalls().length;

  await expect(resolveSiteIdentity(auto())).resolves.toMatchObject({
    kind: "fallback",
    reason: "unverified",
  });
  expect(server.sudoCalls().length).toBe(sudoBefore);
});

test("a hand-built runAs of root is fallback/no-identity, with no sudo call", async () => {
  const sudoBefore = server.sudoCalls().length;

  await expect(
    resolveSiteIdentity(server.transport({ runAs: "root:root" })),
  ).resolves.toMatchObject({ kind: "fallback", reason: "no-identity" });
  expect(server.sudoCalls().length).toBe(sudoBefore);
});

test("the memo is per runAs and umask: another umask or runAs on the same install decides again", async () => {
  const transport = auto({ umask: "0002" });
  verifyOwner(transport);
  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "site",
    umask: "0002",
  });

  await expect(
    resolveSiteIdentity(auto({ umask: "0027" })),
  ).resolves.toMatchObject({ kind: "site", umask: "0027" });
  await expect(
    resolveSiteIdentity(server.transport({ runAs: "33:33", umask: "0002" })),
  ).resolves.toMatchObject({
    kind: "site",
    target: { user: "33", group: "33" },
  });
});

test("a probe that throws is rethrown and not cached: the next call asks again", async () => {
  const transport = auto();
  verifyOwner(transport);
  writeFileSync(answers.stat, "SEGV");

  await expect(resolveSiteIdentity(transport)).rejects.toBeInstanceOf(
    CommandKilledError,
  );

  writeFileSync(answers.stat, "www-data:www-data:33:33");
  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "site",
  });
});

test("concurrent callers share one resolution", async () => {
  const transport = auto();
  verifyOwner(transport);
  const sudoBefore = server.sudoCalls().length;

  const [first, second] = await Promise.all([
    resolveSiteIdentity(transport),
    resolveSiteIdentity(transport),
  ]);

  expect(second).toBe(first);
  expect(server.sudoCalls().length).toBe(sudoBefore + 1);
});

test("an as-today copy is disabled without a command, and never reads the original's answer", async () => {
  const transport = auto();
  verifyOwner(transport);
  await expect(resolveSiteIdentity(transport)).resolves.toMatchObject({
    kind: "site",
  });
  const sent = server.commands.length;

  await expect(
    resolveSiteIdentity(asTransportUser(transport)),
  ).resolves.toEqual({
    kind: "disabled",
    reason: "as-transport-user",
  });
  await expect(
    resolveSiteIdentity(server.transport({ runAs: false })),
  ).resolves.toEqual({
    kind: "disabled",
    reason: "config",
  });
  // No runAs over ssh is `auto`, the default: the same install's resolved state, not `disabled`.
  await expect(resolveSiteIdentity(server.transport())).resolves.toMatchObject({
    kind: "site",
  });
  expect(server.commands.length).toBe(sent);
});
