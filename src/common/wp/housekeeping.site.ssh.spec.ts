import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { disposeConnections, installKey } from "./exec";
import { clearDebugLog, readDebugLog } from "./log";
import {
  GRANT_SCRIPT,
  normalizeOwnership,
  planOwnership,
  resetOwnershipCaches,
} from "./ownership";
import { prepareSiteDataDirs, removeSiteResidue } from "./residue";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { SshTransport, Transport } from "../config/types";
import type { SiteIdentityVerdict } from "./web-identity";

/**
 * Ownership, residue and `debug.log` housekeeping by identity state, over a server that runs what it
 * is sent. In `site` nothing is handed over and nothing runs as root unless the site itself was
 * refused (then root acts on what survived, after the site's attempt); every other state keeps
 * today's handover, as root. The fake `sudo` records every call: a root call is one without `-u`.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

// The identity's ids and names all differ, so a swapped uid/gid or user/group shows.
const WWW_ID = "uid=33(www-data) gid=82(web) groups=82(web)";
const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";
const WWW_OWNER = { user: "www-data", group: "web", uid: 33, gid: 82 };
const UBUNTU_OWNER = { user: "ubuntu", group: "ubuntu", uid: 1000, gid: 1000 };

/** The fake `id`: the identity `sudo -u` asked for, else the transport's user. */
const FAKE_ID = `if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`;

/** The programs a spec can make the site (never root) be refused: each wraps the system's own. */
const REFUSABLE = ["rm", "cat", "mkdir", "chmod"] as const;

/** A data directory a product declares. */
const DATA_DIR = "wp-content/uploads/e2e-data";

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  started.addProgram("id", FAKE_ID);
  for (const name of REFUSABLE) {
    // As a permission denial would: as the site (`sudo -u` exported the user), each operand holding
    // the text in `refuse.<name>` is refused and the rest go through (`rm` only: the others' operands
    // are never mixed), exit 1. Root and the transport's user always get the real program, except
    // that `refuse-once.<name>` refuses the next call whoever makes it (and is then removed).
    const flag = join(started.base, `refuse.${name}`);
    const once = join(started.base, `refuse-once.${name}`);
    started.addProgram(
      name,
      `if [ -e '${once}' ]; then /bin/rm -f '${once}'; echo "${name}: Permission denied" >&2; exit 1; fi
refused=0
if [ -n "$E2E_FAKE_SUDO_USER" ] && [ -s '${flag}' ]; then
  pattern=$(/bin/cat '${flag}')
  for arg in "$@"; do
    shift
    case $arg in
      *"$pattern"*) echo "${name}: $arg: Permission denied" >&2; refused=1 ;;
      *) set -- "$@" "$arg" ;;
    esac
  done
fi
if [ "$refused" = 1 ]; then
  if [ ${name} = rm ]; then /bin/rm "$@"; fi
  exit 1
fi
exec /bin/${name} "$@"`,
    );
  }
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  server.denySudo(false);
  setOwner(WWW_OWNER);
  for (const name of REFUSABLE) {
    refuse(name, "");
    rmSync(join(server.base, `refuse-once.${name}`), { force: true });
  }
  setWp("fails");
  rmSync(join(server.root, "wp-content"), { recursive: true, force: true });
  mkdirSync(join(server.root, "wp-content", "uploads"), { recursive: true });
  mkdirSync(join(server.root, "wp-content", "plugins", "probe"), {
    recursive: true,
  });
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * What the fake `stat` answers for the docroot: an owner, or a failure.
 *
 * @param owner - the owner, or `undefined` for a `stat` that fails.
 */
function setOwner(owner: typeof WWW_OWNER | undefined): void {
  server.addProgram(
    "stat",
    owner === undefined
      ? "echo 'stat: cannot stat' >&2; exit 1"
      : `echo '${owner.user}:${owner.group}:${String(owner.uid)}:${String(owner.gid)}'`,
  );
}

/**
 * Makes the site be refused `name` on any argument holding `pattern` (`""`: never).
 *
 * @param name - one of {@link REFUSABLE}.
 * @param pattern - the text an argument must hold.
 */
function refuse(name: (typeof REFUSABLE)[number], pattern: string): void {
  writeFileSync(join(server.base, `refuse.${name}`), pattern);
}

/**
 * The fake `wp`: `--info` answering; `eval` clearing the log as the snippet would (`clears`: emptied in
 * place; `creates`: made anew, the identity's), or a WordPress that cannot boot (exit 255), so the
 * log's direct fallbacks run. `probe-killed`: `--info` kills the run probe
 * (its parent shell, the command the transport ran) with SIGKILL, so resolving the state throws.
 *
 * @param how - which.
 */
function setWp(how: "clears" | "creates" | "fails" | "probe-killed"): void {
  const verdict = (state: string): string =>
    `echo 'e2e-debug-log-clear {"state":"${state}","ours":true,"path":"wp-content/debug.log"}'`;
  const evals = {
    clears: `: > wp-content/debug.log; ${verdict("emptied")}`,
    creates: `rm -f wp-content/debug.log; : > wp-content/debug.log; ${verdict("created")}`,
    fails: "echo 'PHP Fatal error: simulated' >&2; exit 255",
    "probe-killed": "echo 'PHP Fatal error: simulated' >&2; exit 255",
  };
  // `--info` answers unless the probe is to die: the run probe needs it.
  server.addProgram(
    "wp",
    `if [ "$1" = --info ]; then ${how === "probe-killed" ? "kill -9 $PPID; exit 1" : "echo 'WP-CLI 2.12.0'; exit 0"}; fi\n${evals[how]}`,
  );
}

/**
 * An `auto` site the pre-flight verified: its state is `site`, as `www-data:www-data`.
 *
 * @param overrides - transport fields to replace.
 */
function siteTransport(overrides: Partial<SshTransport> = {}): SshTransport {
  const transport = server.transport({ runAs: "auto", ...overrides });
  const verdict: SiteIdentityVerdict = {
    verdict: "owner-is-web",
    owner: WWW_OWNER,
    web: {
      euid: 33,
      egid: 82,
      user: "www-data",
      group: "web",
      umask: "0022",
      sapi: "fpm-fcgi",
    },
  };
  registerSiteIdentityVerdicts(new Map([[installKey(transport), verdict]]));
  return transport;
}

/** The fake `sudo`'s calls from index `from` on that ran as root (no `-u`): `sudo -n true` included. */
const rootCallsSince = (from: number): string[][] =>
  server
    .sudoCalls()
    .slice(from)
    .filter((argv) => !argv.includes("-u"));

/** The program each call from index `from` on ran as the site (`sudo -u`, the wrapper's command). */
const siteProgramsSince = (from: number): string[] =>
  server
    .sudoCalls()
    .slice(from)
    .filter((argv) => argv.includes("-u"))
    .map((argv) => argv[argv.indexOf("e2e-run-as") + 3] ?? "");

/**
 * Resolves `transport`'s state, checks its kind, and returns the sudo-call count from then on.
 *
 * @param transport - the site.
 * @param kind - the state it must be in.
 */
async function settled(
  transport: Transport,
  kind: "site" | "disabled" | "fallback",
): Promise<number> {
  expect((await resolveSiteIdentity(transport)).kind).toBe(kind);
  return server.sudoCalls().length;
}

test.describe("ownership in the site state", () => {
  test("an install owned by another user is not handed over: unnecessary, nothing as root", async () => {
    setOwner(UBUNTU_OWNER);
    const transport = server.transport({ runAs: "www-data:web" });
    const from = await settled(transport, "site");
    const sent = server.commands.length;

    // The writer is the identity; the install's other owner is kept for the pre-flight to name.
    await expect(planOwnership(transport)).resolves.toEqual({
      kind: "unnecessary",
      target: WWW_OWNER,
      site: { installOwner: UBUNTU_OWNER },
    });
    await expect(
      normalizeOwnership(transport, "wp-content/plugins/probe"),
    ).resolves.toBe("unnecessary");

    expect(rootCallsSince(from)).toEqual([]);
    expect(
      server.commands
        .slice(sent)
        .filter((line) => /chmod|chown|readlink/.test(line)),
    ).toEqual([]);
  });

  test("an owner that cannot be read is no obstacle: unnecessary, the identity as the target", async () => {
    setOwner(undefined);
    const transport = server.transport({ runAs: "www-data:web" });
    const from = await settled(transport, "site");

    await expect(planOwnership(transport)).resolves.toEqual({
      kind: "unnecessary",
      target: WWW_OWNER,
      site: {},
    });
    await expect(
      normalizeOwnership(transport, "wp-content/plugins/probe"),
    ).resolves.toBe("unnecessary");
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("a declared fileOwner is neither resolved nor enforced: unnecessary, no id or getent", async () => {
    const transport = siteTransport({ fileOwner: "deploy:deploy" });
    await settled(transport, "site");
    const sent = server.commands.length;

    await expect(planOwnership(transport)).resolves.toEqual({
      kind: "unnecessary",
      target: WWW_OWNER,
      site: {
        installOwner: WWW_OWNER,
        declared: { user: "deploy", group: "deploy" },
      },
    });
    expect(
      server.commands
        .slice(sent)
        .filter((line) => /getent|'-u'|chown|chmod/.test(line)),
    ).toEqual([]);
  });

  test("a state that cannot be resolved is not the transport's user: unknown identity, nothing as root", async () => {
    setWp("probe-killed");
    const transport = siteTransport();
    await expect(resolveSiteIdentity(transport)).rejects.toThrow();
    const from = server.sudoCalls().length;

    // Falling back to the transport's user here would plan a root handover of the identity's files.
    await expect(planOwnership(transport)).resolves.toEqual({
      kind: "unknown-identity",
      target: WWW_OWNER,
    });
    await expect(
      normalizeOwnership(transport, "wp-content/plugins/probe"),
    ).resolves.toBe("skipped");
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("fileOwner false stays disabled and a malformed one stays reported", async () => {
    await expect(
      planOwnership(siteTransport({ fileOwner: false })),
    ).resolves.toEqual({ kind: "disabled" });
    await expect(
      planOwnership(siteTransport({ fileOwner: "-x:y" })),
    ).resolves.toMatchObject({ kind: "bad-owner" });
  });
});

test.describe("ownership in every other state: today's handover, as root, grant before chown", () => {
  const cases: readonly [string, () => Transport, "disabled" | "fallback"][] = [
    ["runAs: false", () => server.transport({ runAs: false }), "disabled"],
    ["runAs absent", () => server.transport(), "disabled"],
    [
      "an as-today copy of a site transport",
      () => asTransportUser(siteTransport()),
      "disabled",
    ],
    [
      "fallback/no-sudo",
      () => {
        server.denySudo({ user: "www-data" });
        return siteTransport();
      },
      "fallback",
    ],
  ];
  for (const [label, make, kind] of cases) {
    test(label, async () => {
      const transport = make();
      const from = await settled(transport, kind);
      const target = join(server.root, "wp-content", "plugins", "probe");

      await expect(planOwnership(transport)).resolves.toMatchObject({
        kind: "grant",
        identity: { uid: 1000 },
      });
      // The fake `chown` is the system's, refused for another user: the verification decides `failed`
      // or `normalized`; either way both commands ran as root, in order.
      await normalizeOwnership(transport, "wp-content/plugins/probe");

      expect(rootCallsSince(from)).toEqual([
        ["-n", "true"],
        [
          "-n",
          "--",
          "sh",
          "-c",
          GRANT_SCRIPT,
          "e2e-ownership-grant",
          "ug+rwX,o+rwX",
          target,
        ],
        ["-n", "--", "chown", "-Rh", "--", "www-data:web", target],
      ]);
    });
  }
});

test.describe("ownership of a symbolic link: refused inside root's own grant", () => {
  test("a link inside the root passes the guards; the grant's script refuses it and nothing follows", async () => {
    const transport = server.transport({ runAs: false });
    const from = await settled(transport, "disabled");
    const uploads = join(server.root, "wp-content", "uploads");
    chmodSync(uploads, 0o700);
    const target = join(server.root, "wp-content", "plugins", "probe");
    rmSync(target, { recursive: true });
    symlinkSync(uploads, target);
    const warned: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      warned.push(args.map(String).join(" "));
    };
    try {
      await expect(
        normalizeOwnership(transport, "wp-content/plugins/probe"),
      ).resolves.toBe("failed");
    } finally {
      console.warn = realWarn;
      chmodSync(uploads, 0o755);
    }

    // The one root command acting on the path is the grant's guarded script: no bare chmod, no chown.
    expect(rootCallsSince(from)).toEqual([
      ["-n", "true"],
      [
        "-n",
        "--",
        "sh",
        "-c",
        GRANT_SCRIPT,
        "e2e-ownership-grant",
        "ug+rwX,o+rwX",
        target,
      ],
    ]);
    expect(warned.join("\n")).toMatch(
      /"wp-content\/plugins\/probe" is a symbolic link, so its ownership was left alone/,
    );
  });
});

test.describe("residue in the site state: as the site first, root only for what it was refused", () => {
  test("data directories are made and opened as the site, with no root call", async () => {
    const transport = siteTransport();
    const from = await settled(transport, "site");

    await prepareSiteDataDirs(transport, [DATA_DIR]);

    expect(statSync(join(server.root, DATA_DIR)).mode & 0o777).toBe(0o777);
    expect(siteProgramsSince(from)).toEqual(["test", "mkdir", "chmod"]);
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("a step the site is refused runs again as root, that step only, after the site's attempt", async () => {
    const transport = siteTransport();
    const from = await settled(transport, "site");
    refuse("mkdir", "e2e-data");
    const target = join(server.root, DATA_DIR);

    await prepareSiteDataDirs(transport, [DATA_DIR]);

    expect(existsSync(target)).toBe(true);
    expect(siteProgramsSince(from)).toEqual(["test", "mkdir", "chmod"]);
    // What root made goes back to the identity, by id: the site then opens it itself.
    expect(rootCallsSince(from)).toEqual([
      ["-n", "true"],
      ["-n", "--", "test", "-e", target],
      ["-n", "--", "test", "-e", join(server.root, "wp-content", "uploads")],
      ["-n", "--", "mkdir", "-p", "--", target],
      ["-n", "--", "chown", "-h", "--", "33:82", target],
    ]);
    // The root call came after the site's refused one.
    const calls = server.sudoCalls().slice(from);
    const sitesMkdir = calls.findIndex(
      (argv) => argv.includes("-u") && argv.includes("mkdir"),
    );
    const rootsMkdir = calls.findIndex(
      (argv) => !argv.includes("-u") && argv.includes("mkdir"),
    );
    expect(sitesMkdir).toBeGreaterThanOrEqual(0);
    expect(rootsMkdir).toBeGreaterThan(sitesMkdir);
  });

  test("root hands back every parent it made and none that existed", async () => {
    const transport = siteTransport();
    const from = await settled(transport, "site");
    const nested = "wp-content/uploads/made/by/root";
    refuse("mkdir", "made");
    const at = (path: string): string => join(server.root, path);

    await prepareSiteDataDirs(transport, [nested]);

    expect(existsSync(at(nested))).toBe(true);
    expect(rootCallsSince(from)).toEqual([
      ["-n", "true"],
      ["-n", "--", "test", "-e", at(nested)],
      ["-n", "--", "test", "-e", at("wp-content/uploads/made/by")],
      ["-n", "--", "test", "-e", at("wp-content/uploads/made")],
      ["-n", "--", "test", "-e", at("wp-content/uploads")],
      ["-n", "--", "mkdir", "-p", "--", at(nested)],
      [
        "-n",
        "--",
        "chown",
        "-h",
        "--",
        "33:82",
        at(nested),
        at("wp-content/uploads/made/by"),
        at("wp-content/uploads/made"),
      ],
    ]);
  });

  test("a root mkdir that fails hands nothing over and throws", async () => {
    const transport = siteTransport();
    const from = await settled(transport, "site");
    refuse("mkdir", "e2e-data");
    // A file where the data directory's parent belongs: root's `mkdir -p` fails too.
    rmSync(join(server.root, "wp-content", "uploads"), { recursive: true });
    writeFileSync(join(server.root, "wp-content", "uploads"), "");

    await expect(prepareSiteDataDirs(transport, [DATA_DIR])).rejects.toThrow(
      /could not `mkdir -p -- /,
    );
    expect(
      rootCallsSince(from).filter((argv) => argv.includes("chown")),
    ).toEqual([]);
  });

  test("outside the site state a root mkdir hands nothing back itself", async () => {
    server.denySudo({ user: "www-data" });
    const transport = siteTransport();
    const from = await settled(transport, "fallback");
    // Commands run as the transport's user here: refuse its one `mkdir`, never root's after it.
    writeFileSync(join(server.base, "refuse-once.mkdir"), "");

    await prepareSiteDataDirs(transport, [DATA_DIR]);

    const roots = rootCallsSince(from);
    expect(roots).toContainEqual([
      "-n",
      "--",
      "mkdir",
      "-p",
      "--",
      join(server.root, DATA_DIR),
    ]);
    expect(roots.filter((argv) => argv.includes("test"))).toEqual([]);
    expect(roots.filter((argv) => argv.includes("-h"))).toEqual([]);
  });

  test("residue the site can remove is removed with no root call", async () => {
    const transport = siteTransport();
    mkdirSync(join(server.root, DATA_DIR, "nested"), { recursive: true });
    writeFileSync(join(server.root, DATA_DIR, "nested", "a.log"), "x");
    const from = await settled(transport, "site");

    await removeSiteResidue(transport, [DATA_DIR]);

    expect(existsSync(join(server.root, DATA_DIR))).toBe(false);
    expect(siteProgramsSince(from)).toContain("rm");
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("root removes only the survivor the site was refused, after the site tried both", async () => {
    const transport = siteTransport();
    const kept = "wp-content/uploads/stubborn";
    for (const dir of [DATA_DIR, kept]) {
      mkdirSync(join(server.root, dir), { recursive: true });
    }
    refuse("rm", "stubborn");
    const from = await settled(transport, "site");

    await removeSiteResidue(transport, [DATA_DIR, kept]);

    expect(existsSync(join(server.root, DATA_DIR))).toBe(false);
    expect(existsSync(join(server.root, kept))).toBe(false);
    const siteRm = server
      .sudoCalls()
      .slice(from)
      .filter((argv) => argv.includes("-u") && argv.includes("rm"));
    expect(siteRm).toHaveLength(1);
    expect(siteRm[0]?.slice(-2)).toEqual([
      join(server.root, DATA_DIR),
      join(server.root, kept),
    ]);
    const rootRm = rootCallsSince(from).filter((argv) => argv.includes("rm"));
    expect(rootRm).toEqual([
      ["-n", "--", "rm", "-rf", "--", join(server.root, kept)],
    ]);
  });
});

/**
 * Outside `site`, a log WP-CLI's user made would be one the web server cannot append to: it is handed
 * to the install's owner like anything else this suite writes, or removed where it cannot be.
 */
test.describe("debug.log outside the site state: the transport user's log is handed over or removed", () => {
  const log = (): string => join(server.root, "wp-content", "debug.log");

  test("a log it made is handed to the install's owner by root", async () => {
    setWp("creates");
    const transport = server.transport({ runAs: false });
    const from = await settled(transport, "disabled");
    const realWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await clearDebugLog(transport);
    } finally {
      console.warn = realWarn;
    }

    // The fake `chown` is the system's, refused for another user, so the verification reads `failed`
    // and the log is removed after the attempt; on a host where root's chown works it is kept.
    expect(existsSync(log())).toBe(false);
    expect(rootCallsSince(from)).toEqual([
      ["-n", "true"],
      [
        "-n",
        "--",
        "sh",
        "-c",
        GRANT_SCRIPT,
        "e2e-ownership-grant",
        "ug+rwX,o+rwX",
        log(),
      ],
      ["-n", "--", "chown", "-Rh", "--", "www-data:web", log()],
    ]);
  });

  test("a log it made that cannot be handed over (no sudo) is removed, as before", async () => {
    setWp("creates");
    server.denySudo(true);
    const transport = server.transport({ runAs: false });
    await settled(transport, "disabled");
    const realWarn = console.warn;
    console.warn = (): void => undefined;
    try {
      await clearDebugLog(transport);
    } finally {
      console.warn = realWarn;
    }

    expect(existsSync(log())).toBe(false);
  });
});

test.describe("debug.log in the site state: root fallbacks only once the site was refused", () => {
  const log = (): string => join(server.root, "wp-content", "debug.log");

  // The identity is the web server: its own log needs no handing over.
  test("wp eval empties it as the site, with no root call", async () => {
    setWp("clears");
    writeFileSync(log(), "old");
    const transport = siteTransport();
    const from = await settled(transport, "site");

    await clearDebugLog(transport);

    expect(readFileSync(log(), "utf8")).toBe("");
    expect(siteProgramsSince(from)).toEqual(["wp"]);
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("WordPress not booting: the direct read and removal run as the site, with no root call", async () => {
    writeFileSync(log(), "PHP Fatal error: here\n");
    const transport = siteTransport();
    const from = await settled(transport, "site");

    await expect(readDebugLog(transport)).resolves.toBe(
      "PHP Fatal error: here",
    );
    await clearDebugLog(transport);

    expect(existsSync(log())).toBe(false);
    expect(siteProgramsSince(from)).toEqual(["wp", "cat", "wp", "rm", "test"]);
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("the site refused the direct read and removal: root reads and removes it", async () => {
    writeFileSync(log(), "PHP Fatal error: kept\n");
    refuse("cat", "debug.log");
    refuse("rm", "debug.log");
    const transport = siteTransport();
    const from = await settled(transport, "site");

    await expect(readDebugLog(transport)).resolves.toBe(
      "PHP Fatal error: kept",
    );
    await clearDebugLog(transport);

    expect(existsSync(log())).toBe(false);
    expect(rootCallsSince(from).filter((argv) => argv[1] === "--")).toEqual([
      ["-n", "--", "cat", "wp-content/debug.log"],
      ["-n", "--", "rm", "-f", "wp-content/debug.log"],
      ["-n", "--", "test", "-e", "wp-content/debug.log"],
    ]);
  });
});
