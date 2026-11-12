import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import {
  disposeConnections,
  installKey,
  resetElevationCaches,
  sshCommandLine,
  sshWrappedLine,
} from "./exec";
import { resetOwnershipCaches } from "./ownership";
import { runAsArgv } from "./run-as-argv";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import {
  INBOX_PREFIX,
  siteStagingOps,
  sweepStaleInboxes,
} from "./site-staging";
import {
  DEFAULT_STAGING_DIR,
  PLUGINS_CATEGORY,
  cleanSiteStaging,
  stageArtifact,
} from "./staging";
import { startSshServer, steerNodeSsh } from "../__fixtures__/ssh-server";
import type { SshTestServer } from "../__fixtures__/ssh-server";
import type { SshTransport, Transport } from "../config/types";
import type { SiteIdentityVerdict } from "./web-identity";

/**
 * Staging over a server that runs what it is sent. In the `site` state the file goes through an
 * inbox the transport's user makes (here in the server's own folder, never the runner's `/tmp`) and
 * the identity copies it in, checks it and the inbox goes; in every other state the line sent and the
 * upload are today's, byte for byte. Everything runs as this process's user: who a command runs as is
 * read from whether it went through the fake `sudo` (wrapped) or not.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];
/** What `afterEach` undoes, newest first. */
const teardownAfterEach: (() => void)[] = [];
/** The inbox root the specs pass: inside the server's folder, so `close()` removes it. */
let inboxRoot: string;
/** The runner's file staged by every test. */
let source: string;
/** Where the fake `wp eval` reads which file to hash. */
let hashTarget: string;

const SOURCE_TEXT = "PK\u0003\u0004 not really a zip, but bytes ✓\n";
const WWW = { user: "www-data", group: "www-data" };
const WWW_ID = "uid=33(www-data) gid=33(www-data) groups=33(www-data)";
const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";

/**
 * The fake `wp`: `eval` (after any global flags) prints the SHA-256 of the file named in `$hashTarget`
 * (what `fileChecksum` asks for), or a wrong one when `<base>/wrong-sum` exists; anything else (the
 * run probe's `--info`) succeeds silently.
 */
const fakeWp = (base: string, target: string): string =>
  `while [ "$1" != "\${1#--}" ]; do shift; done\n` +
  `if [ "$1" = eval ]; then\n` +
  `  if [ -e '${base}/wrong-sum' ]; then printf '%064d' 0; exit 0; fi\n` +
  `  shasum -a 256 "$(cat '${target}')" | cut -c1-64 | tr -d '\\n'\n` +
  `fi\n` +
  `exit 0\n`;

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  inboxRoot = join(started.base, "inbox root");
  mkdirSync(inboxRoot);
  source = join(started.base, "plugin.zip");
  writeFileSync(source, SOURCE_TEXT);
  hashTarget = join(started.base, "hash-target");
  started.addProgram("stat", "echo 'www-data:www-data:33:33'");
  started.addProgram(
    "id",
    // `-u` (the sweep's) is the real one, so the sweep matches this process's own folders.
    `if [ "$1" = -u ]; then exec /usr/bin/id -u; fi\n` +
      `if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`,
  );
  started.addProgram("wp", fakeWp(started.base, hashTarget));
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  server.denySudo(false);
  rmSync(join(server.root, DEFAULT_STAGING_DIR), {
    recursive: true,
    force: true,
  });
  rmSync(join(server.base, "wrong-sum"), { force: true });
});

test.afterEach(() => {
  disposeConnections();
  for (const undo of teardownAfterEach.splice(0).reverse()) undo();
  delete process.env.E2E_SITE_STAGING_DIR;
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** The pre-flight's verdict for a site whose files and web server are `www-data:www-data`. */
const SITE_VERDICT: SiteIdentityVerdict = {
  verdict: "owner-is-web",
  owner: { ...WWW, uid: 33, gid: 33 },
  web: { euid: 33, egid: 33, ...WWW, umask: "0022", sapi: "fpm-fcgi" },
};

/** An `auto` site the pre-flight verified: its state is `site`, as `www-data:www-data`. */
function siteTransport(): SshTransport {
  const transport = server.transport({ runAs: "auto" });
  registerSiteIdentityVerdicts(
    new Map([[installKey(transport), SITE_VERDICT]]),
  );
  return transport;
}

/** The staged plugin zip's path on the "site". */
const stagedPath = (): string =>
  join(server.root, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY, "plugin.zip");

/** A line the transport's user is sent: `cd -- <root> && exec <file> <args…>`. */
const asTransport = (file: string, args: readonly string[]): string =>
  sshCommandLine(server.root, file, args);

/** A line run as the identity, through sudo and the wrapper, in the root. */
const asSite = (file: string, args: readonly string[]): string =>
  sshWrappedLine(runAsArgv(WWW, "0022", server.root, file, args));

/** The identity's ensure script (see `site-staging.ts`). */
const ENSURE_SCRIPT =
  'for d in "$2" "$1"; do if [ -d "$d" ] && ! { [ -w "$d" ] && [ -x "$d" ]; }; then exit 3; fi; ' +
  'done; mkdir -p -- "$1" && test -w "$1" -a -x "$1"';

/**
 * Runs `work` with `console.warn` recorded.
 *
 * @param work - what may warn.
 * @returns the warnings, in order.
 */
async function recordingWarnings(
  work: () => Promise<unknown>,
): Promise<string[]> {
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    await work();
  } finally {
    console.warn = warn;
  }
  return warnings;
}

/**
 * Makes a folder outside the site holding `stage/plugins` (mode 0555 with a `.keep` inside, so a
 * removal of it fails and a heal triggers) and a `stage/sentinel` file; removed after the test.
 *
 * @param name - the folder's name in the server's base.
 * @returns the folder and the sentinel's path.
 */
function victim(name: string): { dir: string; sentinel: string } {
  const dir = join(server.base, name);
  const category = join(dir, "stage", PLUGINS_CATEGORY);
  mkdirSync(category, { recursive: true });
  writeFileSync(join(category, ".keep"), "");
  const sentinel = join(dir, "stage", "sentinel");
  writeFileSync(sentinel, "another site's");
  chmodSync(category, 0o555);
  teardownAfterEach.push(() => {
    if (existsSync(category)) chmodSync(category, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, sentinel };
}

/** The `rm -rf` lines sent, but the inbox's own removal. */
const removalsSince = (before: number): string[] =>
  server.commands
    .slice(before)
    .filter((line) => line.includes("'rm' '-rf'") && !line.includes(inboxRoot));

/** Stages the source as the plugin category's `plugin.zip`, its inbox in {@link inboxRoot}. */
function stage(transport: Transport): Promise<string> {
  writeFileSync(hashTarget, stagedPath());
  return stageArtifact(transport, source, {
    category: PLUGINS_CATEGORY,
    inboxRoot,
  });
}

test.describe("site state: through an inbox", () => {
  test("inbox as the transport's user, staging and copy and checksum as the identity, inbox removed", async () => {
    const transport = siteTransport();
    await resolveSiteIdentity(transport);
    const before = server.commands.length;

    const staged = await stage(transport);

    expect(staged).toBe(stagedPath());
    expect(readFileSync(staged, "utf8")).toBe(SOURCE_TEXT);
    expect(readdirSync(inboxRoot)).toEqual([]);

    const sent = server.commands.slice(before);
    const inbox = /'-m' '0711' '--' '([^']+)'$/.exec(sent[0] ?? "")?.[1] ?? "";
    expect(inbox).toMatch(
      new RegExp(
        `^${inboxRoot}/${INBOX_PREFIX}${String(process.pid)}-[0-9a-f]{16}$`,
      ),
    );
    const upload = `${inbox}/upload`;
    const category = join(server.root, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY);
    expect(sent).toEqual([
      asTransport("mkdir", ["-m", "0711", "--", inbox]),
      asTransport("chmod", ["0644", upload]),
      asSite("sh", [
        "-c",
        ENSURE_SCRIPT,
        "e2e-staging",
        category,
        join(server.root, DEFAULT_STAGING_DIR),
      ]),
      asSite("cp", ["-f", "--", upload, staged]),
      // Without plugins or theme: neither can print into the digest.
      expect.stringMatching(
        /^exec 'sudo' .* 'wp' '--skip-plugins' '--skip-themes' 'eval' /,
      ),
      asTransport("rm", ["-rf", "--", inbox]),
    ]);
  });

  test("an inbox root that does not exist fails (never mkdir -p) and leaves nothing behind", async () => {
    const transport = siteTransport();
    const missing = join(inboxRoot, "missing");

    await expect(
      stageArtifact(transport, source, {
        category: PLUGINS_CATEGORY,
        inboxRoot: missing,
      }),
    ).rejects.toThrow(
      /could not create the upload inbox ".*missing\/e2e-inbox-/,
    );

    expect(existsSync(missing)).toBe(false);
    expect(existsSync(join(server.root, DEFAULT_STAGING_DIR))).toBe(false);
  });

  test("a site copy whose SHA-256 differs fails, and the inbox is still removed", async () => {
    const transport = siteTransport();
    writeFileSync(join(server.base, "wrong-sum"), "");

    await expect(stage(transport)).rejects.toThrow(/does not match/);
    expect(readdirSync(inboxRoot)).toEqual([]);
  });

  test("a failed copy as the identity still removes the inbox", async () => {
    const transport = siteTransport();
    server.addProgram("cp", "echo 'cp: Permission denied' >&2; exit 1");
    try {
      await expect(stage(transport)).rejects.toThrow(
        /could not copy the upload to .* as the site's identity .*: cp: Permission denied/,
      );
    } finally {
      server.removeProgram("cp");
    }
    expect(readdirSync(inboxRoot)).toEqual([]);
  });

  test("a folder where the file should go: cp puts the upload inside it, and the checksum refuses", async () => {
    const transport = siteTransport();
    mkdirSync(stagedPath(), { recursive: true });

    await expect(stage(transport)).rejects.toThrow(/expected a SHA-256/);
    expect(readdirSync(inboxRoot)).toEqual([]);
  });

  test("a staging category the identity cannot write: the site's own area is checked, removed and made again, then warned", async () => {
    test.skip(process.getuid?.() === 0, "root ignores directory permissions");
    const transport = siteTransport();
    const area = join(server.root, DEFAULT_STAGING_DIR);
    const category = join(area, PLUGINS_CATEGORY);
    mkdirSync(category, { recursive: true });
    chmodSync(category, 0o555);
    teardownAfterEach.push(() => {
      if (existsSync(category)) chmodSync(category, 0o755);
    });
    const before = server.commands.length;

    const warnings = await recordingWarnings(() => stage(transport));

    const sent = server.commands.slice(before);
    const removal = sent.indexOf(asSite("rm", ["-rf", "--", area]));
    expect(removal).toBeGreaterThan(-1);
    // Where the area really leads is asked first, as the transport's user.
    expect(sent.slice(0, removal)).toContain(
      asTransport("readlink", ["-f", "--", area]),
    );
    expect(readFileSync(stagedPath(), "utf8")).toBe(SOURCE_TEXT);
    expect(warnings).toEqual([
      expect.stringMatching(
        new RegExp(
          `^\\[wp/staging\\] .*: "${area}" was not writable by the site's identity \\(made by another user\\); removed it and made it again\\.$`,
        ),
      ),
    ]);
  });

  test("an area whose parent links out of the site is refused, and what it leads to is kept", async () => {
    test.skip(process.getuid?.() === 0, "root ignores directory permissions");
    const { dir, sentinel } = victim("linked parent");
    symlinkSync(dir, join(server.root, "sub"));
    teardownAfterEach.push(() => {
      rmSync(join(server.root, "sub"));
    });
    const transport = server.transport({
      runAs: "auto",
      stagingDir: "sub/stage",
    });
    registerSiteIdentityVerdicts(
      new Map([[installKey(transport), SITE_VERDICT]]),
    );
    const before = server.commands.length;

    await expect(
      stageArtifact(transport, source, {
        category: PLUGINS_CATEGORY,
        inboxRoot,
      }),
    ).rejects.toThrow(
      /refusing to remove ".*\/sub\/stage" .*: it must stay inside the WordPress root .* really resolves to ".*linked parent\/stage", which is outside it/,
    );

    expect(readFileSync(sentinel, "utf8")).toBe("another site's");
    expect(removalsSince(before)).toEqual([]);
    expect(readdirSync(inboxRoot)).toEqual([]);
  });

  test("a category that cannot be made for another reason (a file in its place) is never healed", async () => {
    const transport = siteTransport();
    const area = join(server.root, DEFAULT_STAGING_DIR);
    mkdirSync(area);
    writeFileSync(join(area, PLUGINS_CATEGORY), "a file, not a folder");
    const before = server.commands.length;

    await expect(stage(transport)).rejects.toThrow(
      /could not create the staging directory ".*plugins" as the site's identity\. If it cannot write there, set E2E_SITE_STAGING_DIR/,
    );

    expect(readFileSync(join(area, PLUGINS_CATEGORY), "utf8")).toBe(
      "a file, not a folder",
    );
    expect(removalsSince(before)).toEqual([]);
  });
});

test.describe("site state: an absolute, shared staging root", () => {
  test("a category another user made is refused, never removed; the error names the override", async () => {
    test.skip(process.getuid?.() === 0, "root ignores directory permissions");
    const shared = join(server.base, "shared staging");
    const category = join(shared, PLUGINS_CATEGORY);
    const theirs = join(category, "theirs.zip");
    mkdirSync(category, { recursive: true });
    writeFileSync(theirs, "another site's, in flight");
    chmodSync(category, 0o555);
    teardownAfterEach.push(() => {
      chmodSync(category, 0o755);
      rmSync(shared, { recursive: true, force: true });
    });
    process.env.E2E_SITE_STAGING_DIR = shared;
    const transport = siteTransport();
    const before = server.commands.length;

    const warnings = await recordingWarnings(() =>
      expect(
        stageArtifact(transport, source, {
          category: PLUGINS_CATEGORY,
          inboxRoot,
        }),
      ).rejects.toThrow(
        /exists but the site's identity cannot write it: another user made it under an absolute staging root, .* never removed\. Remove it, or give each site its own root \(E2E_SITE_STAGING_DIR or the site's `transport.stagingDir`\)/,
      ),
    );

    expect(readFileSync(theirs, "utf8")).toBe("another site's, in flight");
    expect(removalsSince(before)).toEqual([]);
    expect(warnings).toEqual([]);
    expect(readdirSync(inboxRoot)).toEqual([]);
  });

  test("a fallback site's upload into a category another identity made fails naming the shared root", async () => {
    test.skip(process.getuid?.() === 0, "root ignores directory permissions");
    const shared = join(server.base, "shared staging");
    const category = join(shared, PLUGINS_CATEGORY);
    mkdirSync(category, { recursive: true });
    chmodSync(category, 0o555);
    teardownAfterEach.push(() => {
      chmodSync(category, 0o755);
      rmSync(shared, { recursive: true, force: true });
    });
    process.env.E2E_SITE_STAGING_DIR = shared;

    await expect(stage(server.transport())).rejects.toThrow(
      /could not upload .* The staging root ".*shared staging" is absolute, so other sites may share it and own what is in it; give each site its own/,
    );
  });
});

test.describe("every other state: today's line and upload", () => {
  for (const [label, transport] of [
    ["runAs absent", (): Transport => server.transport()],
    ["runAs false", (): Transport => server.transport({ runAs: false })],
    ["an as-today copy", (): Transport => asTransportUser(siteTransport())],
  ] as const) {
    test(`${label}: mkdir -p as the transport's user, then the upload straight into place`, async () => {
      const before = server.commands.length;

      const staged = await stage(transport());

      expect(readFileSync(staged, "utf8")).toBe(SOURCE_TEXT);
      expect(server.commands.slice(before)).toEqual([
        asTransport("mkdir", [
          "-p",
          join(server.root, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY),
        ]),
      ]);
      expect(readdirSync(inboxRoot)).toEqual([]);
    });
  }

  test("fallback/no-sudo: the probes, then today's line", async () => {
    const transport = siteTransport();
    server.denySudo(true);
    await resolveSiteIdentity(transport);
    const before = server.commands.length;

    await stage(transport);

    expect(server.commands.slice(before)).toEqual([
      asTransport("mkdir", [
        "-p",
        join(server.root, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY),
      ]),
    ]);
  });
});

test.describe("stale inboxes", () => {
  test("the sweep removes only the transport user's inbox folders over an hour old", async () => {
    const twoHoursAgo = Date.now() / 1000 - 7200;
    const make = (name: string, old: boolean): string => {
      const path = join(inboxRoot, name);
      mkdirSync(path);
      writeFileSync(join(path, "upload"), "x");
      if (old) utimesSync(path, twoHoursAgo, twoHoursAgo);
      return path;
    };
    make(`${INBOX_PREFIX}1-old`, true);
    make(`${INBOX_PREFIX}2-young`, false);
    make("not-an-inbox", true);
    // A link named like an inbox, to a folder outside: never followed, never removed.
    const outside = make("outside", true);
    symlinkSync(outside, join(inboxRoot, `${INBOX_PREFIX}3-link`));
    try {
      await sweepStaleInboxes(server.transport(), inboxRoot);

      expect(readdirSync(inboxRoot).sort()).toEqual(
        [
          `${INBOX_PREFIX}2-young`,
          `${INBOX_PREFIX}3-link`,
          "not-an-inbox",
          "outside",
        ].sort(),
      );
      expect(existsSync(join(outside, "upload"))).toBe(true);
    } finally {
      for (const entry of readdirSync(inboxRoot)) {
        rmSync(join(inboxRoot, entry), { recursive: true, force: true });
      }
    }
  });

  test("an inbox root that is itself a link (macOS's /tmp) is followed, and its stale inbox removed", async () => {
    const real = join(server.base, "real inbox root");
    const linked = join(server.base, "linked inbox root");
    const old = join(real, `${INBOX_PREFIX}1-old`);
    mkdirSync(old, { recursive: true });
    const twoHoursAgo = Date.now() / 1000 - 7200;
    utimesSync(old, twoHoursAgo, twoHoursAgo);
    symlinkSync(real, linked);
    teardownAfterEach.push(() => {
      rmSync(linked);
      rmSync(real, { recursive: true, force: true });
    });

    await sweepStaleInboxes(server.transport(), linked);

    expect(readdirSync(real)).toEqual([]);
  });

  test("cleaning the whole area in the site state sweeps /tmp as the transport's user; a category does not", async () => {
    const transport = siteTransport();
    // The real sweep would touch the runner's /tmp: a recording `find` stands in.
    const record = join(server.base, "find.log");
    server.addProgram("find", `printf '%s\\n' "$@" >> '${record}'`);
    try {
      await cleanSiteStaging(transport, PLUGINS_CATEGORY);
      expect(existsSync(record)).toBe(false);

      await cleanSiteStaging(transport);
      // Only the login's own inbox folders: `-user` is its uid (the fake `id` runs the real `-u`).
      expect(readFileSync(record, "utf8").split("\n")).toEqual([
        "-H",
        "/tmp",
        "-mindepth",
        "1",
        "-maxdepth",
        "1",
        "-type",
        "d",
        "-name",
        `${INBOX_PREFIX}*`,
        "-user",
        String(process.getuid?.()),
        "-mmin",
        "+60",
        "-exec",
        "rm",
        "-rf",
        "--",
        "{}",
        "+",
        "",
      ]);
    } finally {
      server.removeProgram("find");
      rmSync(record, { force: true });
    }
  });

  for (const [label, transport, noSudo] of [
    ["runAs absent", (): Transport => server.transport(), false],
    ["runAs false", (): Transport => server.transport({ runAs: false }), false],
    [
      "an as-today copy",
      (): Transport => asTransportUser(siteTransport()),
      false,
    ],
    ["fallback/no-sudo", (): Transport => siteTransport(), true],
  ] as const) {
    test(`${label}: cleaning the whole area runs the one rm and no sweep`, async () => {
      const site = transport();
      if (noSudo) {
        server.denySudo(true);
        await resolveSiteIdentity(site);
      }
      const before = server.commands.length;
      await cleanSiteStaging(site);
      expect(server.commands.slice(before)).toEqual([
        asTransport("rm", ["-rf", join(server.root, DEFAULT_STAGING_DIR)]),
      ]);
    });
  }
});

test.describe("cleanSiteStaging: a removal needing root", () => {
  test.skip(process.getuid?.() === 0, "root ignores directory permissions");

  /** `rm` calls the fake `sudo` received. */
  const rootRemovals = (): string[][] =>
    server.sudoCalls().filter((argv) => argv.includes("rm"));

  test("a relative area whose parent links out of the site is refused before root runs", async () => {
    const { dir, sentinel } = victim("clean linked parent");
    symlinkSync(dir, join(server.root, "sub"));
    teardownAfterEach.push(() => {
      rmSync(join(server.root, "sub"));
    });
    const before = rootRemovals().length;

    await expect(
      cleanSiteStaging(
        server.transport({ stagingDir: "sub/stage" }),
        PLUGINS_CATEGORY,
      ),
    ).rejects.toThrow(
      /refusing to remove ".*sub\/stage\/plugins" as root .* really resolves to ".*clean linked parent\/stage\/plugins", which is outside it/,
    );
    expect(rootRemovals()).toHaveLength(before);
    expect(readFileSync(sentinel, "utf8")).toBe("another site's");
  });

  test("an absolute root that is itself a link is refused before root runs", async () => {
    const { dir } = victim("clean linked root");
    const linked = join(server.base, "linked staging");
    symlinkSync(join(dir, "stage"), linked);
    teardownAfterEach.push(() => {
      rmSync(linked);
    });
    process.env.E2E_SITE_STAGING_DIR = linked;
    const before = rootRemovals().length;

    await expect(
      cleanSiteStaging(server.transport(), PLUGINS_CATEGORY),
    ).rejects.toThrow(
      /the staging root ".*linked staging" is itself a symbolic link/,
    );
    expect(rootRemovals()).toHaveLength(before);
  });

  test("an absolute root that is no link: root is asked to remove the category", async () => {
    const { dir } = victim("clean plain root");
    process.env.E2E_SITE_STAGING_DIR = join(dir, "stage");
    const before = rootRemovals().length;

    // The fake `sudo` runs as this user, so root's removal fails the same way: what matters is it ran.
    await expect(
      cleanSiteStaging(server.transport(), PLUGINS_CATEGORY),
    ).rejects.toThrow(/could not remove ".*stage\/plugins"/);
    expect(rootRemovals()).toHaveLength(before + 1);
  });
});

test.describe("siteStagingOps: asRoot", () => {
  test("a site that may not elevate answers undefined and runs nothing", async () => {
    const transport = server.transport({ runAs: "auto", elevate: false });
    const before = server.sudoCalls().length;
    await expect(
      siteStagingOps(transport).asRoot("true", []),
    ).resolves.toBeUndefined();
    expect(server.sudoCalls()).toHaveLength(before);
  });

  test("a site that can elevate runs it through sudo", async () => {
    const before = server.sudoCalls().length;
    const result = await siteStagingOps(server.transport()).asRoot("true", []);
    expect(result?.exitCode).toBe(0);
    expect(server.sudoCalls().slice(before)).toContainEqual(
      expect.arrayContaining(["true"]),
    );
  });
});
