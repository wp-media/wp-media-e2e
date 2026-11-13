import { test, expect } from "@playwright/test";

import {
  FALLBACK_REASONS,
  RUN_AS_OPT_OUT,
  asTransportUser,
  SUDO_DENIED,
  classifyRunProbe,
  decideIdentityState,
  describeIdentityState,
  runIdentityFrom,
  runProbeArgv,
} from "./site-identity";
import { RUN_AS_NAME, RUN_AS_SCRIPT } from "./run-as-argv";
import type {
  FallbackReason,
  IdentityInputs,
  IdentityState,
  RunIdentity,
  RunProbeOutcome,
} from "./site-identity";
import type { SiteOwnership } from "./ownership";
import type { SiteIdentityVerdict, WebIdentity } from "./web-identity";
import type {
  DockerTransport,
  LocalTransport,
  SshTransport,
} from "../config/types";

/**
 * The identity state machine, pure: every state and every fallback reason from its inputs, the run
 * probe's argv and how its output is read, the messages, and the "as today" copy.
 */

const WWW_OWNER: SiteOwnership = {
  user: "www-data",
  group: "www-data",
  uid: 33,
  gid: 33,
};
const SFTP_OWNER: SiteOwnership = {
  user: "sftp_x",
  group: "www-data",
  uid: 1001,
  gid: 33,
};
const UBUNTU: RunIdentity = {
  user: "ubuntu",
  group: "ubuntu",
  uid: 1000,
  gid: 1000,
  groupIds: [1000, 33],
  groupNames: ["ubuntu", "www-data"],
};
const WWW: RunIdentity = {
  user: "www-data",
  group: "www-data",
  uid: 33,
  gid: 33,
  groupIds: [33],
  groupNames: ["www-data"],
};
const WEB_WWW: WebIdentity = {
  euid: 33,
  egid: 33,
  user: "www-data",
  group: "www-data",
  umask: "0022",
  sapi: "fpm-fcgi",
};
const IS_WEB: SiteIdentityVerdict = {
  verdict: "owner-is-web",
  owner: WWW_OWNER,
  web: WEB_WWW,
};
const RAN_WWW: RunProbeOutcome = {
  kind: "ran",
  identity: WWW,
};

/** An `auto` site whose every probe says yes: `site`. */
const AUTO: IdentityInputs = {
  mode: "ssh",
  runAs: "auto",
  transportUserCopy: false,
  umask: "0022",
  verdict: IS_WEB,
  site: { owner: WWW_OWNER, transportUser: UBUNTU },
  runProbe: RAN_WWW,
};

/** The state for `inputs`, failing the test when it is still pending. */
function state(inputs: IdentityInputs): IdentityState {
  const decision = decideIdentityState(inputs);
  if (decision.kind === "pending")
    throw new Error(`still pending: ${decision.probe}`);
  return decision;
}

/** The fallback reason `inputs` lead to, or the state's kind. */
function outcome(inputs: IdentityInputs): string {
  const decided = state(inputs);
  return decided.kind === "fallback"
    ? `fallback/${decided.reason}`
    : decided.kind;
}

test("auto, every probe passing: site, running as the probe's identity with the umask", () => {
  expect(state(AUTO)).toEqual({
    kind: "site",
    target: { user: "www-data", group: "www-data" },
    identity: WWW,
    umask: "0022",
  });
});

test("a declared identity needs no verdict: site", () => {
  const { verdict: _none, ...declared } = {
    ...AUTO,
    runAs: "www-data:www-data" as const,
  };
  expect(outcome(declared)).toBe("site");
});

test("docker and local are same-user whatever else is known, never disabled", () => {
  for (const mode of ["docker", "local"] as const) {
    expect(state({ ...AUTO, mode, runAs: undefined })).toEqual({
      kind: "same-user",
      reason: "mode",
    });
    expect(
      state({ ...AUTO, mode, runAs: undefined, transportUserCopy: true }),
    ).toEqual({
      kind: "same-user",
      reason: "mode",
    });
  }
});

test("runAs false is disabled, saying whether the config or an as-today copy asked", () => {
  expect(state({ ...AUTO, runAs: false })).toEqual({
    kind: "disabled",
    reason: "config",
  });
  expect(state({ ...AUTO, runAs: false, transportUserCopy: true })).toEqual({
    kind: "disabled",
    reason: "as-transport-user",
  });
});

test("the decision asks for the site probes, then the run probe with the identity's names", () => {
  const { site: _site, runProbe: _run, ...bare } = AUTO;
  expect(decideIdentityState(bare)).toEqual({
    kind: "pending",
    probe: "site",
  });
  const { runProbe: _probe, ...probed } = AUTO;
  expect(decideIdentityState(probed)).toEqual({
    kind: "pending",
    probe: "run",
    target: { user: "www-data", group: "www-data" },
  });
  // BusyBox's unmapped names come back from `stat` as ids: sudo is then given `#33`.
  expect(
    decideIdentityState({
      ...probed,
      site: {
        owner: { user: "33", group: "33", uid: 33, gid: 33 },
        transportUser: UBUNTU,
      },
      verdict: {
        ...IS_WEB,
        owner: { user: "33", group: "33", uid: 33, gid: 33 },
      },
    }),
  ).toEqual({
    kind: "pending",
    probe: "run",
    target: { user: "33", group: "33" },
  });
});

test("auto with the transport's user being the verified owner is same-user, before any sudo", () => {
  const { runProbe: _run, ...noProbe } = AUTO;
  expect(
    state({ ...noProbe, site: { owner: WWW_OWNER, transportUser: WWW } }),
  ).toEqual({
    kind: "same-user",
    reason: "transport-user",
  });
  // Same user, another primary group: files would get the wrong group, so not the same.
  expect(
    decideIdentityState({
      ...noProbe,
      verdict: IS_WEB,
      site: {
        owner: WWW_OWNER,
        transportUser: { ...WWW, group: "staff", gid: 50 },
      },
    }),
  ).toMatchObject({ kind: "pending", probe: "run" });
  // A declared identity matched by name, with no verdict: the operator vouches for it.
  const { verdict: _verdict, ...unverified } = noProbe;
  expect(
    outcome({
      ...unverified,
      runAs: "www-data:www-data",
      site: { owner: undefined, transportUser: WWW },
    }),
  ).toBe("same-user");
});

test("auto with no verdict is unverified before any probe; a declared identity is not held to one", () => {
  const { verdict: _verdict, site: _site, runProbe: _run, ...bare } = AUTO;

  // Nothing probed yet: no `stat`/`id` needed to know it.
  expect(decideIdentityState(bare)).toEqual({
    kind: "fallback",
    reason: "unverified",
    detail: "no pre-flight verdict for this site in this run",
  });
  // A root-owned or unreadable docroot would be no-identity, but nothing is probed to learn it: the
  // pre-flight that gives the verdict reports it.
  expect(
    outcome({ ...bare, site: { owner: undefined, transportUser: UBUNTU } }),
  ).toBe("fallback/unverified");
  expect(decideIdentityState({ ...bare, runAs: "www-data:www-data" })).toEqual({
    kind: "pending",
    probe: "site",
  });
});

test("auto with the transport's user being an owner PHP is not, or not verified as, falls back", () => {
  // A deployment account owns the docroot and is the SSH user; PHP runs as www-data through the group.
  const { runProbe: _run, ...noProbe } = AUTO;
  const sftp: RunIdentity = {
    user: "sftp_x",
    group: "www-data",
    uid: 1001,
    gid: 33,
    groupIds: [33],
    groupNames: ["www-data"],
  };
  const site = { owner: SFTP_OWNER, transportUser: sftp };
  const notWeb: SiteIdentityVerdict = {
    verdict: "owner-not-web",
    owner: SFTP_OWNER,
    web: WEB_WWW,
  };

  expect(state({ ...noProbe, site, verdict: notWeb })).toEqual({
    kind: "fallback",
    reason: "owner-not-web",
    detail:
      "PHP runs as www-data(33):www-data(33), the docroot is sftp_x(1001):www-data(33)",
  });
  expect(outcome({ ...noProbe, site, verdict: undefined })).toBe(
    "fallback/unverified",
  );
  expect(
    outcome({
      ...noProbe,
      site,
      verdict: { verdict: "unverified", reason: "unreachable", detail: "x" },
    }),
  ).toBe("fallback/unverified");
  expect(
    outcome({
      ...noProbe,
      site,
      verdict: { verdict: "owner-is-web", owner: SFTP_OWNER, web: WEB_WWW },
    }),
  ).toBe("same-user");
});

test("a hand-built runAs naming root, or past the id range, is fallback/no-identity before any probe", () => {
  const { runProbe: _run, ...noProbe } = AUTO;
  for (const runAs of ["root:root", "www-data:0", "4294967295:33"] as const) {
    const decided = decideIdentityState({ ...noProbe, runAs });
    expect(decided).toMatchObject({ kind: "fallback", reason: "no-identity" });
    expect(decided.kind === "fallback" ? decided.detail : "").toMatch(
      /^\[wp\/site-identity\] transport\.runAs /,
    );
  }
  // A valid declared identity goes on to the run probe, as declared.
  expect(decideIdentityState({ ...noProbe, runAs: "www-data:33" })).toEqual({
    kind: "pending",
    probe: "run",
    target: { user: "www-data", group: "33" },
  });
});

/** One row per fallback reason: the inputs, and what the detail must say. */
const FALLBACKS: readonly (readonly [
  FallbackReason,
  string,
  IdentityInputs,
  RegExp,
])[] = [
  [
    "no-sudo",
    "sudo refused",
    {
      ...AUTO,
      runProbe: {
        kind: "failed",
        reason: "no-sudo",
        detail: "sudo: a password is required",
      },
    },
    /password is required/,
  ],
  [
    "no-wp",
    "wp failed under sudo",
    {
      ...AUTO,
      runProbe: {
        kind: "failed",
        reason: "no-wp",
        detail: "wp: not found",
      },
    },
    /wp: not found/,
  ],
  [
    "no-root-access",
    "the root cannot be entered",
    {
      ...AUTO,
      runProbe: {
        kind: "failed",
        reason: "no-root-access",
        detail: "can't cd",
      },
    },
    /can't cd/,
  ],
  [
    "no-identity",
    "the owner is unreadable",
    { ...AUTO, site: { owner: undefined, transportUser: UBUNTU } },
    /could not be read/,
  ],
  [
    "no-identity",
    "the owner is root",
    {
      ...AUTO,
      site: {
        owner: { user: "root", group: "root", uid: 0, gid: 0 },
        transportUser: UBUNTU,
      },
    },
    /owned by root/,
  ],
  [
    "no-identity",
    "the owner's group is root",
    {
      ...AUTO,
      site: {
        owner: { ...WWW_OWNER, gid: 0, group: "root" },
        transportUser: UBUNTU,
      },
    },
    /owned by root/,
  ],
  [
    "no-identity",
    "the owner's name cannot be given to sudo",
    {
      ...AUTO,
      site: { owner: { ...WWW_OWNER, user: "-oops" }, transportUser: UBUNTU },
    },
    /cannot be given to sudo/,
  ],
  [
    "no-identity",
    "sudo does not know the account",
    {
      ...AUTO,
      runProbe: {
        kind: "failed",
        reason: "no-identity",
        detail: "sudo: unknown user www",
      },
    },
    /unknown user/,
  ],
  [
    "no-identity",
    "the identity is uid 0 on the host",
    {
      ...AUTO,
      runProbe: { kind: "ran", identity: { ...WWW, uid: 0 } },
    },
    /root on this host/,
  ],
  [
    "no-identity",
    "the identity's group is gid 0 on the host",
    {
      ...AUTO,
      runProbe: { kind: "ran", identity: { ...WWW, gid: 0 } },
    },
    /root on this host/,
  ],
  [
    "no-identity",
    "the owner's group name cannot be given to sudo",
    {
      ...AUTO,
      site: { owner: { ...WWW_OWNER, group: "#33" }, transportUser: UBUNTU },
    },
    /cannot be given to sudo/,
  ],
  [
    "owner-not-web",
    "PHP runs as another user",
    {
      ...AUTO,
      site: { owner: SFTP_OWNER, transportUser: UBUNTU },
      verdict: { verdict: "owner-not-web", owner: SFTP_OWNER, web: WEB_WWW },
    },
    /PHP runs as www-data\(33\):www-data\(33\), the docroot is sftp_x\(1001\):www-data\(33\)/,
  ],
  [
    "unverified",
    "no verdict",
    { ...AUTO, verdict: undefined },
    /no pre-flight verdict/,
  ],
  [
    "unverified",
    "the pre-flight could not tell",
    {
      ...AUTO,
      verdict: {
        verdict: "unverified",
        reason: "not-served",
        detail: "HTTP 404",
      },
    },
    /not-served: HTTP 404/,
  ],
  [
    "unverified",
    "the owner changed since the verdict",
    { ...AUTO, site: { owner: SFTP_OWNER, transportUser: UBUNTU } },
    /owner changed/,
  ],
  [
    "unverified",
    "only the owner's group changed since the verdict",
    {
      ...AUTO,
      site: {
        owner: { ...WWW_OWNER, gid: 1000, group: "ubuntu" },
        transportUser: UBUNTU,
      },
    },
    /owner changed/,
  ],
  [
    "probe-mismatch",
    "sudo ran as the owner's name with another uid",
    {
      ...AUTO,
      runProbe: {
        kind: "ran",
        identity: { ...WWW, uid: 34 },
      },
    },
    /sudo ran as www-data\(34\):www-data\(33\)/,
  ],
  [
    "probe-mismatch",
    "sudo ran as someone else",
    { ...AUTO, runProbe: { kind: "ran", identity: UBUNTU } },
    /sudo ran as ubuntu\(1000\):ubuntu\(1000\), not www-data:www-data/,
  ],
  [
    "probe-mismatch",
    "the right user in another group",
    {
      ...AUTO,
      runProbe: {
        kind: "ran",
        identity: { ...WWW, gid: 50, group: "staff" },
      },
    },
    /not www-data:www-data/,
  ],
  [
    "probe-mismatch",
    "id printed nothing",
    {
      ...AUTO,
      runProbe: { kind: "ran", identity: undefined },
    },
    /printed no identity/,
  ],
];

for (const [reason, label, inputs, detail] of FALLBACKS) {
  test(`fallback/${reason} when ${label}`, () => {
    const decided = state(inputs);
    expect(decided).toMatchObject({ kind: "fallback", reason });
    expect(decided.kind === "fallback" ? decided.detail : "").toMatch(detail);
  });
}

test("every fallback reason is reachable from the table above", () => {
  const reached = new Set(FALLBACKS.map(([reason]) => reason));
  expect([...reached].sort()).toEqual(Object.keys(FALLBACK_REASONS).sort());
});

test("a declared identity is compared by name, or by id when declared as digits", () => {
  const declared = (runAs: `${string}:${string}`, identity: RunIdentity) =>
    outcome({
      ...AUTO,
      runAs,
      runProbe: { kind: "ran", identity },
    });

  expect(declared("www-data:www-data", WWW)).toBe("site");
  expect(declared("33:33", WWW)).toBe("site");
  expect(declared("33:www-data", WWW)).toBe("site");
  expect(declared("www-data:www-data", { ...WWW, user: "33" })).toBe(
    "fallback/probe-mismatch",
  );
  expect(declared("34:33", WWW)).toBe("fallback/probe-mismatch");
});

test("the umask defaults to 0022 when none is given", () => {
  expect(state({ ...AUTO, umask: undefined })).toMatchObject({
    kind: "site",
    umask: "0022",
  });
  expect(state({ ...AUTO, umask: "0002" })).toMatchObject({
    kind: "site",
    umask: "0002",
  });
});

// ── The run probe ────────────────────────────────────────────────────────────────────────────────

test("the run probe is the site wrapper running id and wp --info in the root, each failure its exit", () => {
  expect(
    runProbeArgv({ user: "www-data", group: "33" }, "0022", "/var/www/html"),
  ).toEqual([
    "sudo",
    "-n",
    "-u",
    "www-data",
    "-g",
    "#33",
    "--",
    "/bin/sh",
    "-c",
    RUN_AS_SCRIPT,
    RUN_AS_NAME,
    "0022",
    "/var/www/html",
    "/bin/sh",
    "-c",
    "echo e2e-run-probe && { id || exit 91; } && { wp --info >/dev/null || exit 92; }",
  ]);
});

const ID_LINE = "uid=33(www-data) gid=33(www-data) groups=33(www-data)";

/** One row per way the run probe can end. */
const PROBES: readonly (readonly [
  string,
  { stdout: string; stderr: string; exitCode: number },
  RunProbeOutcome,
])[] = [
  [
    "ran",
    { stdout: `e2e-run-probe\n${ID_LINE}`, stderr: "", exitCode: 0 },
    { kind: "ran", identity: WWW },
  ],
  [
    "ran, with sudo's hostname noise on stderr and a banner faking root before the mark",
    {
      stdout: `uid=0(root) gid=0(root)\ne2e-run-probe\n${ID_LINE}`,
      stderr: "sudo: unable to resolve host twin: Name or service not known",
      exitCode: 0,
    },
    { kind: "ran", identity: WWW },
  ],
  [
    "BusyBox's id without names",
    {
      stdout: "e2e-run-probe\nuid=33 gid=33 groups=33",
      stderr: "",
      exitCode: 0,
    },
    {
      kind: "ran",
      identity: {
        user: "33",
        group: "33",
        uid: 33,
        gid: 33,
        groupIds: [33],
        groupNames: [],
      },
    },
  ],
  [
    "id failed",
    { stdout: "e2e-run-probe", stderr: "id: oops", exitCode: 91 },
    { kind: "ran", identity: undefined },
  ],
  [
    "wp failed",
    {
      stdout: `e2e-run-probe\n${ID_LINE}`,
      stderr: "/bin/sh: 1: wp: not found",
      exitCode: 92,
    },
    {
      kind: "failed",
      reason: "no-wp",
      detail: "/bin/sh: 1: wp: not found",
    },
  ],
  [
    "the probe killed past the mark",
    { stdout: "e2e-run-probe", stderr: "", exitCode: 137 },
    {
      kind: "failed",
      reason: "probe-mismatch",
      detail: "exit 137",
    },
  ],
  [
    "a line merely containing the mark, never the mark itself",
    {
      stdout: "motd: e2e-run-probe\nuid=33(www-data) gid=33(www-data)",
      stderr: "",
      exitCode: 0,
    },
    {
      kind: "failed",
      reason: "no-root-access",
      detail: "exit 0",
    },
  ],
  [
    "sudo refused, behind hostname noise",
    {
      stdout: "",
      stderr:
        "sudo: unable to resolve host twin: x\nsudo: a password is required",
      exitCode: 1,
    },
    {
      kind: "failed",
      reason: "no-sudo",
      detail: "sudo: a password is required",
    },
  ],
  [
    "no sudo installed",
    { stdout: "", stderr: "sh: 1: sudo: not found", exitCode: 127 },
    {
      kind: "failed",
      reason: "no-sudo",
      detail: "sh: 1: sudo: not found",
    },
  ],
  [
    "an unknown user",
    { stdout: "", stderr: "sudo: unknown user www", exitCode: 1 },
    {
      kind: "failed",
      reason: "no-identity",
      detail: "sudo: unknown user www",
    },
  ],
  [
    "an unknown group",
    { stdout: "", stderr: "sudo: unknown group wwx", exitCode: 1 },
    {
      kind: "failed",
      reason: "no-identity",
      detail: "sudo: unknown group wwx",
    },
  ],
  [
    "the wrapper's cd failed",
    {
      stdout: "",
      stderr: "/bin/sh: 1: cd: can't cd to /var/www/html",
      exitCode: 2,
    },
    {
      kind: "failed",
      reason: "no-root-access",
      detail: "/bin/sh: 1: cd: can't cd to /var/www/html",
    },
  ],
  [
    "a silent failure",
    { stdout: "", stderr: "", exitCode: 1 },
    {
      kind: "failed",
      reason: "no-root-access",
      detail: "exit 1",
    },
  ],
];

for (const [label, result, expected] of PROBES) {
  test(`run probe: ${label}`, () => {
    expect(classifyRunProbe(result)).toEqual(expected);
  });
}

/** sudo 1.9.15p5's explicit deny of the run probe (rule `ALL, !/bin/sh`), as captured, host replaced. */
const PROBE_DENIED = `Sorry, user bob is not allowed to execute '/bin/sh -c ${RUN_AS_SCRIPT} ${RUN_AS_NAME} 0022 / /bin/sh -c x' as www-data:www-data on host.example.\n`;

for (const [label, stderr] of [
  ["sudo's explicit deny", PROBE_DENIED],
  [
    "sudo's explicit deny behind hostname noise",
    `sudo: unable to resolve host twin: x\n${PROBE_DENIED}`,
  ],
  [
    "sudo's explicit deny, lower-cased behind its prefix",
    `sudo: s${PROBE_DENIED.slice(1)}`,
  ],
] as const) {
  test(`run probe: ${label} is no-sudo, named, never quoted`, () => {
    const outcome = classifyRunProbe({ stdout: "", stderr, exitCode: 1 });
    expect(outcome).toMatchObject({ kind: "failed", reason: "no-sudo" });
    expect(outcome.kind === "failed" ? outcome.detail : "").toBe(SUDO_DENIED);
  });
}

test("a run probe detail is the first stderr line only", () => {
  expect(
    classifyRunProbe({
      stdout: "",
      stderr: "sudo: first\nsecond",
      exitCode: 1,
    }),
  ).toMatchObject({ detail: "sudo: first" });
});

test("a run probe detail is one printable line, capped", () => {
  const outcome = classifyRunProbe({
    stdout: "",
    stderr: `sudo: \u001b[31m${"x".repeat(500)}\nsecond line`,
    exitCode: 1,
  });
  expect(outcome.kind === "failed" ? outcome.detail : "").toMatch(/^sudo: x+$/);
  expect(outcome.kind === "failed" ? outcome.detail.length : 0).toBe(200);
});

test("runIdentityFrom reads the primary group's name off the id line", () => {
  expect(
    runIdentityFrom(
      "uid=1000(ubuntu) gid=33(www-data) groups=33(www-data),1000(ubuntu)",
    ),
  ).toEqual({
    user: "ubuntu",
    group: "www-data",
    uid: 1000,
    gid: 33,
    // Every group it carries, for the ownership grant's membership test.
    groupIds: [33, 1000],
    groupNames: ["www-data", "ubuntu"],
  });
  expect(runIdentityFrom("no id here")).toBeUndefined();
});

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

test("every state is described in one line, a fallback with its reason, detail and fix", () => {
  expect(describeIdentityState(state(AUTO))).toBe(
    "runs as www-data(33):www-data(33), umask 0022",
  );
  expect(describeIdentityState({ kind: "same-user", reason: "mode" })).toMatch(
    /no other identity/,
  );
  expect(
    describeIdentityState({ kind: "same-user", reason: "transport-user" }),
  ).toBe(
    "runs as the transport's user, which already is the identity asked for (`runAs`'s, or the " +
      "docroot's owner the web server runs as)",
  );
  expect(describeIdentityState({ kind: "disabled", reason: "config" })).toMatch(
    /`runAs` is false/,
  );
  expect(
    describeIdentityState({ kind: "disabled", reason: "as-transport-user" }),
  ).toMatch(/scenario asks/);
  for (const [reason, { what, fix }] of Object.entries(FALLBACK_REASONS)) {
    const line = describeIdentityState({
      kind: "fallback",
      reason: reason as FallbackReason,
      detail: "seen",
    });
    expect(line).toBe(
      `runs as the transport's user: ${what} (seen). Fix: ${fix}.`,
    );
    expect(line).not.toContain("\n");
  }
});

// `runAs` defaults to `"auto"`: a host that cannot meet the checklist must be told how to opt out,
// or it is warned on every run. `probe-mismatch` (sudo misbehaving) is looked into instead.
test("every fallback fix but probe-mismatch's ends with the runAs opt-out", () => {
  for (const [reason, { fix }] of Object.entries(FALLBACK_REASONS)) {
    if (reason === "probe-mismatch") {
      expect(fix).not.toContain(RUN_AS_OPT_OUT);
    } else {
      expect(fix.endsWith(RUN_AS_OPT_OUT)).toBe(true);
    }
  }
  expect(RUN_AS_OPT_OUT).toContain('`"runAs": false`');
});

// ── As today ─────────────────────────────────────────────────────────────────────────────────────

const SSH: SshTransport = {
  mode: "ssh",
  host: "h.test",
  username: "ubuntu",
  privateKeyPath: "/k",
  rootDir: "/var/www/html",
  runAs: "auto",
  umask: "0002",
  stagingDir: ".stage",
  elevate: false,
  fileOwner: "a:b",
  wpUser: "admin",
};

test("asTransportUser over ssh: frozen, wpUser gone, runAs false, every other field kept", () => {
  const copy = asTransportUser(SSH);
  const { wpUser: _gone, ...rest } = SSH;

  expect(copy).toEqual({ ...rest, runAs: false });
  expect("wpUser" in copy).toBe(false);
  expect(Object.isFrozen(copy)).toBe(true);
  expect(SSH.runAs).toBe("auto");
  expect(SSH.wpUser).toBe("admin");
});

test("asTransportUser on docker and local only drops wpUser: they have no runAs", () => {
  const docker: DockerTransport = {
    mode: "docker",
    container: "c",
    wpUser: "admin",
    elevate: true,
  };
  const local: LocalTransport = {
    mode: "local",
    rootDir: "/r",
    wpUser: "admin",
  };

  expect(asTransportUser(docker)).toEqual({
    mode: "docker",
    container: "c",
    elevate: true,
  });
  expect(asTransportUser(local)).toEqual({ mode: "local", rootDir: "/r" });
  expect("runAs" in asTransportUser(local)).toBe(false);
});

test("asTransportUser is idempotent: a copy comes back as it is", () => {
  const copy = asTransportUser(SSH);
  expect(asTransportUser(copy)).toBe(copy);
});
