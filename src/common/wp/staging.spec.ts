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

import { resetOwnershipCaches } from "./ownership";
import {
  DEFAULT_STAGING_DIR,
  PLUGINS_CATEGORY,
  cleanSiteStaging,
  configuredStagingDir,
  siteStagingDir,
  stageAndInstallPlugin,
  stageArtifact,
  stagingPath,
} from "./staging";
import type { LocalTransport, SshTransport } from "../config/types";
import { removeTempDir } from "../__fixtures__/temp-dir";
import { SKIP_SUDO_OPTIONS } from "../__fixtures__/fake-sudo";

// The pure path/category logic needs no transport at all; the transfer + lifecycle behaviour is
// exercised end to end on the `local` transport (a real WP-root-like directory, real
// `mkdir`/`rm`, and a stub `wp` on PATH that records its argv). `docker`/`ssh` share every line
// above the copy primitive, and are verified against real sites.

const STAGING_ENV = "E2E_SITE_STAGING_DIR";

let stubDir: string;
let wpRoot: string;
let sourceDir: string;
let originalPath: string;
let local: LocalTransport;

/** Stub `wp` that appends its arguments to $WP_STUB_ARGV_FILE and succeeds. */
const STUB_WP = `#!/usr/bin/env bash
if [ -n "$WP_STUB_ARGV_FILE" ]; then
  echo "$@" >> "$WP_STUB_ARGV_FILE"
fi
exit 0
`;

const ssh: SshTransport = {
  mode: "ssh",
  host: "203.0.113.10",
  username: "ubuntu",
  privateKeyPath: "/home/ci/.ssh/id_ed25519",
  // Trailing slash on purpose: real sites files carry them, and every joined path must stay clean.
  rootDir: "/var/www/html/site/",
};

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  sourceDir = mkdtempSync(join(tmpdir(), "wp-src-"));
  local = { mode: "local", rootDir: wpRoot };
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  for (const dir of [stubDir, wpRoot, sourceDir]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.beforeEach(() => {
  // Deleted by literal key (a computed one trips no-dynamic-delete); STAGING_ENV is the
  // single source for the name everywhere it is *set*.
  delete process.env.E2E_SITE_STAGING_DIR;
  delete process.env.WP_STUB_ARGV_FILE;
  removeTempDir(join(wpRoot, DEFAULT_STAGING_DIR));
});

/**
 * True when the suite runs as root, which bypasses the permission bits the two
 * "cannot write / cannot remove" tests rely on. They are skipped there rather than failing for
 * an environment reason (CI runs as a normal user; a root container would not).
 */
const isRoot = process.getuid?.() === 0;

/** Writes a source file on the "runner" and returns its absolute path. */
function makeSource(name: string, contents = "zip-bytes"): string {
  const path = join(sourceDir, name);
  writeFileSync(path, contents);
  return path;
}

test.describe("stagingPath (pure)", () => {
  test("joins root, category and filename POSIX-style", () => {
    expect(stagingPath("/var/www/html/.e2e_temp", "plugins", "a.zip")).toBe(
      "/var/www/html/.e2e_temp/plugins/a.zip",
    );
  });

  test("normalises a trailing slash and a relative root", () => {
    expect(stagingPath("/srv/site/.e2e_temp/", "plugins")).toBe(
      "/srv/site/.e2e_temp/plugins",
    );
    expect(stagingPath(".e2e_temp", "db", "dump.sql")).toBe(
      ".e2e_temp/db/dump.sql",
    );
  });

  test("rejects any segment that could escape the staging area", () => {
    for (const bad of ["", ".", "..", "a/b", "a\\b", "../../etc"]) {
      expect(() => stagingPath("/root", bad)).toThrow(
        /not a valid staging path segment/,
      );
    }
    expect(() => stagingPath("/root", "plugins", "../../evil.zip")).toThrow(
      /not a valid staging path segment/,
    );
  });
});

test.describe("staging root resolution", () => {
  test("defaults to .e2e_temp under the WordPress root", async () => {
    expect(configuredStagingDir(local)).toBe(DEFAULT_STAGING_DIR);
    expect(await siteStagingDir(local)).toBe(join(wpRoot, DEFAULT_STAGING_DIR));
  });

  test("resolves a relative root against the site's WP root, slash-safe", async () => {
    expect(await siteStagingDir(ssh)).toBe("/var/www/html/site/.e2e_temp");
  });

  test("E2E_SITE_STAGING_DIR overrides the default, absolute or relative", async () => {
    process.env[STAGING_ENV] = "/var/tmp/e2e-staging";
    expect(await siteStagingDir(ssh)).toBe("/var/tmp/e2e-staging");

    process.env[STAGING_ENV] = "wp-content/e2e";
    expect(await siteStagingDir(ssh)).toBe("/var/www/html/site/wp-content/e2e");
  });

  test("a site's own transport.stagingDir wins over the env default", async () => {
    process.env[STAGING_ENV] = "/global/staging";
    const pinned: SshTransport = { ...ssh, stagingDir: "/site/specific" };
    expect(configuredStagingDir(pinned)).toBe("/site/specific");
    expect(await siteStagingDir(pinned)).toBe("/site/specific");
  });

  test("refuses a relative root that resolves to the WordPress root or escapes it", async () => {
    // The area is removed whole in teardown, so any of these would delete the WordPress
    // install (or a sibling site) instead of a staging directory.
    for (const unsafe of [
      "/",
      ".",
      "./",
      "..",
      "../outside",
      "wp-content/..",
    ]) {
      process.env[STAGING_ENV] = unsafe;
      await expect(siteStagingDir(ssh)).rejects.toThrow(
        /not a usable staging directory/,
      );
    }
  });

  test("refuses an ABSOLUTE root that is the WordPress root or an ancestor of it", async () => {
    // The dangerous case a relative-only check misses: spelled absolutely, `rm -rf` would take
    // the whole install (or /var/www, or /var) with it.
    for (const unsafe of [
      "/var/www/html/site",
      "/var/www/html/site/",
      "/var/www/html",
      "/var/www",
      "/var",
      "/",
    ]) {
      process.env[STAGING_ENV] = unsafe;
      await expect(siteStagingDir(ssh)).rejects.toThrow(
        /not a usable staging directory/,
      );
    }
  });

  test("allows a sibling directory that merely shares a prefix with the WP root", async () => {
    // "/var/www/html/siteother" starts with the root's text but is NOT an ancestor or the root.
    process.env[STAGING_ENV] = "/var/www/html/siteother-staging";
    expect(await siteStagingDir(ssh)).toBe("/var/www/html/siteother-staging");
  });

  test("refuses a site whose WordPress root is not absolute", async () => {
    // A relative rootDir works as an exec cwd but not as a copy target: SFTP would resolve it
    // against the login user's home directory, silently staging off-site.
    const relativeRoot: SshTransport = { ...ssh, rootDir: "html/site" };
    await expect(siteStagingDir(relativeRoot)).rejects.toThrow(
      /WordPress root .* is not an absolute path/,
    );
  });
});

test.describe("stageArtifact", () => {
  test("creates the category dir, copies the file, and returns the target path", async () => {
    const source = makeSource("plugin-1.zip", "payload-1");

    const target = await stageArtifact(local, source, {
      category: PLUGINS_CATEGORY,
    });

    expect(target).toBe(
      join(wpRoot, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY, "plugin-1.zip"),
    );
    expect(readFileSync(target, "utf8")).toBe("payload-1");
  });

  test("`as` renames the file on the target", async () => {
    const target = await stageArtifact(local, makeSource("build-abc123.zip"), {
      category: PLUGINS_CATEGORY,
      as: "under-test.zip",
    });
    expect(target.endsWith("/plugins/under-test.zip")).toBe(true);
    expect(existsSync(target)).toBe(true);
  });

  test("is idempotent: re-staging overwrites stale residue", async () => {
    const target = await stageArtifact(local, makeSource("p.zip", "first"), {
      category: PLUGINS_CATEGORY,
    });
    expect(readFileSync(target, "utf8")).toBe("first");

    await stageArtifact(local, makeSource("p.zip", "second"), {
      category: PLUGINS_CATEGORY,
    });
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  test("honours an absolute staging root outside the WordPress root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    try {
      process.env[STAGING_ENV] = outside;
      const target = await stageArtifact(local, makeSource("out.zip"), {
        category: "imports",
      });
      expect(target).toBe(join(outside, "imports", "out.zip"));
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("re-staging an already-staged path does not destroy it (same file, local)", async () => {
    // On a `local` site the runner and the target share a filesystem, so this call has the same
    // path for source and destination — a plain copy would truncate the file it is reading.
    const staged = await stageArtifact(
      local,
      makeSource("self.zip", "keepme"),
      {
        category: PLUGINS_CATEGORY,
      },
    );
    const again = await stageArtifact(local, staged, {
      category: PLUGINS_CATEGORY,
    });
    expect(again).toBe(staged);
    expect(readFileSync(staged, "utf8")).toBe("keepme");
  });

  test("rejects a relative local path", async () => {
    await expect(
      stageArtifact(local, "relative/p.zip", { category: PLUGINS_CATEGORY }),
    ).rejects.toThrow(/must be an absolute path on the runner/);
  });

  test("rejects a local path that does not exist or is not a file", async () => {
    await expect(
      stageArtifact(local, join(sourceDir, "nope.zip"), {
        category: PLUGINS_CATEGORY,
      }),
    ).rejects.toThrow(/cannot stage .*nope\.zip/);

    const dir = join(sourceDir, "a-directory");
    mkdirSync(dir, { recursive: true });
    await expect(
      stageArtifact(local, dir, { category: PLUGINS_CATEGORY }),
    ).rejects.toThrow(/is not a file/);
  });

  test("names the override when the staging root cannot be created", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so mkdir would succeed",
    );
    const readOnly = mkdtempSync(join(tmpdir(), "wp-ro-"));
    chmodSync(readOnly, 0o500);
    try {
      process.env[STAGING_ENV] = join(readOnly, "denied");
      await expect(
        stageArtifact(local, makeSource("denied.zip"), {
          category: PLUGINS_CATEGORY,
        }),
      ).rejects.toThrow(/E2E_SITE_STAGING_DIR/);
    } finally {
      chmodSync(readOnly, 0o700);
      rmSync(readOnly, { recursive: true, force: true });
    }
  });
});

test.describe("cleanSiteStaging", () => {
  test("removes the whole area", async () => {
    await stageArtifact(local, makeSource("c.zip"), {
      category: PLUGINS_CATEGORY,
    });
    const root = await siteStagingDir(local);
    expect(existsSync(root)).toBe(true);

    await cleanSiteStaging(local);
    expect(existsSync(root)).toBe(false);
  });

  test("removes a single category, leaving the rest", async () => {
    await stageArtifact(local, makeSource("keep.zip"), {
      category: PLUGINS_CATEGORY,
    });
    await stageArtifact(local, makeSource("drop.xml"), { category: "imports" });
    const root = await siteStagingDir(local);

    await cleanSiteStaging(local, "imports");
    expect(existsSync(join(root, "imports"))).toBe(false);
    expect(existsSync(join(root, PLUGINS_CATEGORY, "keep.zip"))).toBe(true);
  });

  // A category can be shared: a staging root declared as an absolute path serves every site on the
  // host that declares it, so one run removing its own entry must leave another run's alone.
  test("removes one entry of a category, leaving its siblings", async () => {
    await stageArtifact(local, makeSource("mine.tar"), {
      category: "downloads",
    });
    await stageArtifact(local, makeSource("theirs.tar"), {
      category: "downloads",
    });
    const root = await siteStagingDir(local);

    await cleanSiteStaging(local, "downloads", "mine.tar");
    expect(existsSync(join(root, "downloads", "mine.tar"))).toBe(false);
    expect(existsSync(join(root, "downloads", "theirs.tar"))).toBe(true);
  });

  test("refuses a path that would leave the area, before removing anything", async () => {
    await stageArtifact(local, makeSource("kept.zip"), {
      category: PLUGINS_CATEGORY,
    });
    const root = await siteStagingDir(local);

    await expect(
      cleanSiteStaging(local, PLUGINS_CATEGORY, ".."),
    ).rejects.toThrow(/not a valid staging path segment/);
    expect(existsSync(join(root, PLUGINS_CATEGORY, "kept.zip"))).toBe(true);
  });

  test("is a no-op when the area was never created", async () => {
    await expect(cleanSiteStaging(local)).resolves.toBeUndefined();
  });

  test("throws naming the path when the removal genuinely fails", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so rm -rf would succeed",
    );
    // A file cannot be unlinked from a read-only parent directory, so `rm -rf` exits non-zero:
    // a site left dirty must be visible, not swallowed.
    await stageArtifact(local, makeSource("stuck.zip"), {
      category: PLUGINS_CATEGORY,
    });
    const root = await siteStagingDir(local);
    chmodSync(root, 0o500);
    try {
      // Unprivileged on purpose: cleanup escalates when it can, so allowing it here would make the
      // result depend on whether this machine has passwordless sudo.
      await expect(
        cleanSiteStaging({ ...local, elevate: false }, PLUGINS_CATEGORY),
      ).rejects.toThrow(/could not remove .*plugins/);
    } finally {
      chmodSync(root, 0o700);
    }
  });
});

/** Captures `console.warn` for the duration of one call, and hands back what it saw. */
function captureWarnings(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const real = console.warn;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.map(String).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.warn = real;
    },
  };
}

test.describe("stageAndInstallPlugin", () => {
  // Ownership probes are memoised per target, and each test gets a fresh WordPress root.
  test.beforeEach(() => {
    resetOwnershipCaches();
  });

  test("installs from the staged path, not the runner path", async () => {
    const argvFile = join(sourceDir, "wp-argv.log");
    rmSync(argvFile, { force: true });
    process.env.WP_STUB_ARGV_FILE = argvFile;
    const source = makeSource("bwp.zip");

    const staged = await stageAndInstallPlugin(local, source, {
      activate: true,
    });

    expect(staged).toBe(
      join(wpRoot, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY, "bwp.zip"),
    );
    const argv = readFileSync(argvFile, "utf8").trim();
    expect(argv).toBe(`plugin install ${staged} --activate`);
    expect(argv).not.toContain(sourceDir);
  });

  /**
   * Ownership normalisation is what stops a plugin installed as the transport's user from being
   * unwritable by the web server. It is opt-in via `slug` because nothing here inspects the zip, so
   * without one there is no way to know which directory was unpacked.
   *
   * Observed through a deliberately unusable `fileOwner`, because that is the one outcome an
   * unprivileged runner can provoke on any platform: the step reports and returns rather than
   * throwing, which is the property that matters — an install must never fail over housekeeping.
   */
  test("normalises the installed plugin's ownership when given its slug", async () => {
    const argvFile = join(sourceDir, "wp-argv.log");
    rmSync(argvFile, { force: true });
    process.env.WP_STUB_ARGV_FILE = argvFile;
    const warnings = captureWarnings();

    try {
      await stageAndInstallPlugin(
        { ...local, fileOwner: "not a valid spec" },
        makeSource("bwp.zip"),
        { activate: true, slug: "backwpup-pro" },
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.lines.join("\n")).toMatch(/\[wp\/ownership\]/);
    // The install itself still happened, and happened first.
    expect(readFileSync(argvFile, "utf8")).toContain("plugin install ");
  });

  /**
   * The property the other ownership tests only approach indirectly: the chown is aimed at
   * **this slug's** directory. Driven with stub `sudo`/`stat`/`id`/`chmod`/`chown` on `PATH`, so the
   * absolute target is observable without root — a call aimed at the wrong directory would pass
   * every other assertion in this file.
   */
  test("aims the chown at this slug's directory under wp-content/plugins", async () => {
    process.env.WP_STUB_ARGV_FILE = join(sourceDir, "wp-argv.log");
    const binDir = mkdtempSync(join(tmpdir(), "wp-own-bin-"));
    const log = join(binDir, "commands.log");
    const shim = (name: string, body: string): void => {
      writeFileSync(
        join(binDir, name),
        `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "${log}"\n${body}\n`,
      );
      chmodSync(join(binDir, name), 0o755);
    };
    // Ownership the runner does not already have, so normalisation cannot take the no-op fast path.
    shim("stat", 'printf "%s" "www-data:www-data:33:33"');
    shim(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    shim("sudo", "exit 0");
    const pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
    resetOwnershipCaches();

    let commands: string;
    try {
      await stageAndInstallPlugin(local, makeSource("bwp.zip"), {
        activate: true,
        slug: "backwpup-pro",
      });
      // Read before the cleanup below removes the directory the log lives in.
      commands = existsSync(log) ? readFileSync(log, "utf8") : "";
    } finally {
      process.env.PATH = pathBefore;
      rmSync(binDir, { recursive: true, force: true });
      resetOwnershipCaches();
    }

    const plugin = join(wpRoot, "wp-content", "plugins", "backwpup-pro");
    expect(commands).toContain(`chown -Rh -- www-data:www-data ${plugin}`);
    // Never the staging area, never the plugins directory itself. The second is checked against the
    // whole line rather than as a substring: every command line *ends* with its target, so a
    // substring test that appends a trailing space can never match and would pass even if the
    // plugins directory were the one being chowned.
    expect(commands).not.toContain(DEFAULT_STAGING_DIR);
    const plugins = join(wpRoot, "wp-content", "plugins");
    expect(
      commands
        .split("\n")
        .filter((line) => line.trimEnd().endsWith(` ${plugins}`)),
    ).toEqual([]);
  });

  test("leaves ownership alone when no slug is given", async () => {
    process.env.WP_STUB_ARGV_FILE = join(sourceDir, "wp-argv.log");
    const warnings = captureWarnings();

    try {
      await stageAndInstallPlugin(
        { ...local, fileOwner: "not a valid spec" },
        makeSource("bwp.zip"),
        { activate: true },
      );
    } finally {
      warnings.restore();
    }

    expect(warnings.lines).toEqual([]);
  });

  // A bad slug is a mistake in our own code. Failing before anything is copied beats aborting with
  // the plugin half in place.
  test("refuses an unusable slug before staging or installing anything", async () => {
    const argvFile = join(sourceDir, "wp-argv.log");
    rmSync(argvFile, { force: true });
    process.env.WP_STUB_ARGV_FILE = argvFile;

    await expect(
      stageAndInstallPlugin(local, makeSource("bwp.zip"), {
        activate: true,
        slug: "../evil",
      }),
    ).rejects.toThrow(/not a usable plugin slug/);

    expect(existsSync(argvFile)).toBe(false);
    expect(
      existsSync(
        join(wpRoot, DEFAULT_STAGING_DIR, PLUGINS_CATEGORY, "bwp.zip"),
      ),
    ).toBe(false);
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

test.describe("cleanSiteStaging — escalation", () => {
  let sudoDir: string;
  let stagingRoot: string;
  let site: LocalTransport;
  let pathBefore: string | undefined;

  test.beforeEach(() => {
    sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
    writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
    chmodSync(join(sudoDir, "sudo"), 0o755);
    // A root per test: elevation support is probed once per target and cached.
    stagingRoot = mkdtempSync(join(tmpdir(), "wp-elevated-root-"));
    site = { mode: "local", rootDir: stagingRoot };
    pathBefore = process.env.PATH;
    process.env.PATH = `${sudoDir}:${pathBefore ?? ""}`;
    process.env.FAKE_SUDO_LOG = join(sudoDir, "argv.log");
  });

  test.afterEach(() => {
    if (pathBefore === undefined) delete process.env.PATH;
    else process.env.PATH = pathBefore;
    delete process.env.FAKE_SUDO_LOG;
    rmSync(stagingRoot, { recursive: true, force: true });
    rmSync(sudoDir, { recursive: true, force: true });
  });

  // The area normally holds only what this suite put there — but a plugin that unpacks into it as
  // the web-server user would otherwise strand the whole directory on every later run.
  test("removes an area the transport's user cannot empty", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    await stageArtifact(site, makeSource("stuck-elevated.zip"), {
      category: PLUGINS_CATEGORY,
    });
    const root = await siteStagingDir(site);
    const category = join(root, PLUGINS_CATEGORY);
    chmodSync(category, 0o500);
    try {
      await expect(cleanSiteStaging(site)).resolves.toBeUndefined();
      expect(existsSync(root)).toBe(false);
    } finally {
      if (existsSync(category)) chmodSync(category, 0o700);
    }
  });
});
