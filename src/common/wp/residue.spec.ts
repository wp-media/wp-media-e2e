import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SiteResidueRemovalFailedError } from "./errors";
import { GRANT_SCRIPT, resetOwnershipCaches } from "./ownership";
import {
  deniedPreparationAdvice,
  isDeclaredResidue,
  normaliseResiduePath,
  parseResidueDeclaration,
  prepareResolvedDataDirs,
  prepareSiteDataDirs,
  removeSiteResidue,
  resolveSiteResidue,
} from "./residue";
import type { DockerTransport, LocalTransport } from "../config/types";
import { SKIP_SUDO_OPTIONS } from "../__fixtures__/fake-sudo";

/**
 * Residue removal against a **real** WordPress-root-like directory over the `local` transport —
 * real `rm`, real `test`, real permissions. Nothing is stubbed, because the property that matters
 * ("the files are gone, and we know it") is a filesystem fact, not a command-invocation one.
 */

let wpRoot: string;
let local: LocalTransport;
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** Creates a directory under the WordPress root with a file in it, and returns its path. */
function seed(relative: string): string {
  const dir = join(wpRoot, relative);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "archive.tar"), "x");
  return dir;
}

test.beforeEach(() => {
  wpRoot = mkdtempSync(join(tmpdir(), "wp-residue-root-"));
  local = { mode: "local", rootDir: wpRoot };
});

test.afterEach(() => {
  rmSync(wpRoot, { recursive: true, force: true });
});

/**
 * The same site with escalation switched off.
 *
 * Used by every test that pins what removal does when it *cannot* escalate: with elevation allowed,
 * the answer would depend on whether the machine running the suite happens to have passwordless
 * sudo, which is not a property of this code.
 */
function unprivileged(): LocalTransport {
  return { ...local, elevate: false };
}

/**
 * The rules themselves live in `./paths.spec.ts`, which pins them exhaustively. What matters *here*
 * is that residue still delegates to them and still reports a rejection in its own vocabulary — a
 * product author who mistypes a declaration must be told what to declare instead, not merely which
 * abstract rule was broken.
 */
test.describe("normaliseResiduePath", () => {
  test("accepts a path inside the WordPress root and normalises it", () => {
    expect(normaliseResiduePath("  wp-content/./uploads/x/../backwpup/ ")).toBe(
      "wp-content/uploads/backwpup",
    );
  });

  test("rejects a directory WordPress itself owns, in residue's own words", () => {
    expect(() => normaliseResiduePath("wp-content/uploads")).toThrow(
      /\[wp\/residue\].*cannot be removed as leftover data.*WordPress itself owns/s,
    );
  });

  test("names the remedy a product author can act on", () => {
    expect(() => normaliseResiduePath("/etc")).toThrow(
      /Declare a path relative to the WordPress root that the product itself created/,
    );
  });
});

test.describe("removeSiteResidue", () => {
  test("removes each declared path, whole", async () => {
    const backups = seed("wp-content/uploads/backwpup/abc123/backups");
    const restore = seed("wp-content/uploads/backwpup-restore/uploads");

    await removeSiteResidue(local, [
      "wp-content/uploads/backwpup",
      "wp-content/uploads/backwpup-restore",
    ]);

    expect(existsSync(backups)).toBe(false);
    expect(existsSync(restore)).toBe(false);
    expect(existsSync(join(wpRoot, "wp-content/uploads/backwpup"))).toBe(false);
  });

  test("removes a remove-only path, a file as well as a directory", async () => {
    const cache = seed("wp-content/cache/wp-rocket");
    mkdirSync(join(wpRoot, "wp-content/mu-plugins"), { recursive: true });
    const licence = join(wpRoot, "wp-content/mu-plugins/e2e-licence.php");
    writeFileSync(licence, "<?php\n");
    const other = join(wpRoot, "wp-content/mu-plugins/keep.php");
    writeFileSync(other, "<?php\n");

    await removeSiteResidue(local, [
      { path: "wp-content/cache/wp-rocket", prepare: false },
      { path: "wp-content/mu-plugins/e2e-licence.php", prepare: false },
    ]);

    expect(existsSync(cache)).toBe(false);
    expect(existsSync(licence)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  // The site's own content must survive: the point is to remove one plugin's leftovers, not to
  // reset the install.
  test("leaves everything else alone", async () => {
    seed("wp-content/uploads/backwpup/abc123/backups");
    const media = seed("wp-content/uploads/2026/08");
    const plugins = seed("wp-content/plugins/some-plugin");

    await removeSiteResidue(local, ["wp-content/uploads/backwpup"]);

    expect(existsSync(join(media, "archive.tar"))).toBe(true);
    expect(existsSync(join(plugins, "archive.tar"))).toBe(true);
  });

  // Cleanup runs after every scenario, including ones that never created anything.
  test("is idempotent — a path that is already gone is fine", async () => {
    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).resolves.toBeUndefined();
    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).resolves.toBeUndefined();
  });

  /**
   * "Nothing at all" includes **not resolving the root**, and that is the half a `local` transport
   * cannot prove: its root is the declared string, read without running anything. `docker` resolves
   * its root with `pwd`, so a stubbed `docker` on `PATH` makes the absence of that lookup
   * observable — without it, this passes with the early return deleted.
   */
  test("does nothing at all when the product declares no residue", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "wp-residue-nores-"));
    const log = join(binDir, "calls.log");
    writeFileSync(
      join(binDir, "docker"),
      `#!/bin/sh\necho "$*" >> ${log}\nprintf "%s" /var/www/html\n`,
    );
    chmodSync(join(binDir, "docker"), 0o755);
    const pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;

    try {
      const container: DockerTransport = { mode: "docker", container: "wpcli" };
      await expect(removeSiteResidue(container, [])).resolves.toBeUndefined();
      await expect(prepareSiteDataDirs(container, [])).resolves.toBeUndefined();
      expect(existsSync(log), "no command should have been run").toBe(false);
    } finally {
      process.env.PATH = pathBefore;
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // A typo must not leave the site half-cleaned, so validation happens before the first `rm`.
  test("validates every path before removing any of them", async () => {
    const good = seed("wp-content/uploads/backwpup/abc123");

    await expect(
      removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads",
      ]),
    ).rejects.toThrow(/WordPress itself owns/);

    expect(existsSync(good)).toBe(true);
  });

  test("reports what survived, rather than trusting rm's exit code", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    const stuck = seed("wp-content/uploads/backwpup/abc123");
    const parent = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(parent, 0o500);
    try {
      // Unprivileged on purpose: this pins what removal reports when it cannot escalate. Whether
      // the machine running the suite happens to have passwordless sudo must not decide it.
      const failure = await removeSiteResidue(unprivileged(), [
        "wp-content/uploads/backwpup",
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
      expect((failure as SiteResidueRemovalFailedError).paths).toEqual([
        parent,
      ]);
      expect((failure as SiteResidueRemovalFailedError).elevation).toBe(
        "disabled",
      );
      expect(existsSync(stuck)).toBe(true);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  // `test -e` follows a link, so a dangling one nobody could unlink would read as removed.
  test("reports a dangling link it could not unlink as a survivor", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    const parent = join(wpRoot, "wp-content/uploads");
    mkdirSync(parent, { recursive: true });
    const link = join(parent, "backwpup");
    symlinkSync(join(parent, "gone"), link);
    chmodSync(parent, 0o500);
    try {
      const failure = await removeSiteResidue(unprivileged(), [
        "wp-content/uploads/backwpup",
      ]).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
      expect((failure as SiteResidueRemovalFailedError).paths).toEqual([link]);
    } finally {
      chmodSync(parent, 0o700);
    }
  });

  // One stubborn path must not shield the rest: the disk fills up either way.
  test("still removes the other paths when one cannot be removed", async () => {
    test.skip(isRoot, "root ignores directory permissions, so rm -rf succeeds");
    seed("wp-content/uploads/backwpup/abc123");
    const restore = seed("wp-content/uploads/backwpup-restore/uploads");
    const parent = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(parent, 0o500);
    try {
      await expect(
        removeSiteResidue(unprivileged(), [
          "wp-content/uploads/backwpup",
          "wp-content/uploads/backwpup-restore",
        ]),
      ).rejects.toThrow(SiteResidueRemovalFailedError);

      expect(existsSync(restore)).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
    }
  });
});

/**
 * The escalation policy — unprivileged first, privileged only for what survived.
 *
 * Exercised against a fake `sudo` on `PATH` that hands back the one privilege these tests take away
 * (write access to a target's parent) and records every argv it was given. It is not a stand-in for
 * real root; it exists so the *policy* can be proved on a machine without passwordless root, and the
 * argv log is what makes "escalated for exactly this path, and no other" checkable.
 */

const FAKE_SUDO = `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$FAKE_SUDO_LOG"
if [ "$FAKE_SUDO_DENY" = "1" ]; then exit 1; fi
${SKIP_SUDO_OPTIONS}
if [ "$1" = "true" ]; then exit 0; fi
[ "$1" = "rm" ] || exec "$@"
for target in "$@"; do
  case "$target" in /*) ;; *) continue ;; esac
  chmod u+rwx "$(dirname "$target")" 2>/dev/null
  [ -e "$target" ] && chmod -R u+rwX "$target" 2>/dev/null
done
exec "$@"
`;

test.describe("removeSiteResidue — escalation", () => {
  let sudoDir: string;
  let originalPath: string | undefined;
  let sudoLog: string;

  test.beforeEach(() => {
    sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
    writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
    chmodSync(join(sudoDir, "sudo"), 0o755);
    sudoLog = join(sudoDir, "argv.log");
    originalPath = process.env.PATH;
    process.env.PATH = `${sudoDir}:${originalPath ?? ""}`;
    process.env.FAKE_SUDO_LOG = sudoLog;
  });

  test.afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    delete process.env.FAKE_SUDO_LOG;
    delete process.env.FAKE_SUDO_DENY;
    rmSync(sudoDir, { recursive: true, force: true });
  });

  /** Every argv the fake sudo was handed, or `[]` when it was never called. */
  const sudoCalls = (): string[] =>
    existsSync(sudoLog)
      ? readFileSync(sudoLog, "utf8")
          .split("\n")
          .filter((line) => line !== "")
      : [];

  // The whole point: the directory a plugin created as the web-server user is removed anyway.
  test("removes what the transport's user could not, and only that", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    seed("wp-content/uploads/backwpup/abc123");
    seed("wp-content/uploads/backwpup-restore/uploads");
    const stuck = join(wpRoot, "wp-content/uploads/backwpup");
    const easy = join(wpRoot, "wp-content/uploads/backwpup-restore");
    chmodSync(stuck, 0o500);
    try {
      await removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads/backwpup-restore",
      ]);

      expect(existsSync(stuck), "the stubborn path").toBe(false);
      expect(existsSync(easy), "the removable path").toBe(false);
      // Escalated for the one that needed it, never for the one that did not.
      const elevated = sudoCalls().filter((argv) => argv.includes("rm"));
      expect(elevated.some((argv) => argv.includes(stuck))).toBe(true);
      expect(elevated.some((argv) => argv.includes(easy))).toBe(false);
    } finally {
      if (existsSync(stuck)) chmodSync(stuck, 0o700);
    }
  });

  // A pile of directories the web server left is escalated in one privileged command, not one each.
  test("removes every stuck family directory with one privileged rm", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    const stuck = [1, 2, 3, 4, 5].map((index) =>
      seed(
        `wp-content/uploads/backwpup-restore-${index.toString(16).padStart(20, "0")}`,
      ),
    );
    for (const dir of stuck) chmodSync(dir, 0o500);
    try {
      await removeSiteResidue(local, [FAMILY]);

      for (const dir of stuck) expect(existsSync(dir), dir).toBe(false);
      const elevatedRm = sudoCalls().filter((argv) =>
        argv.startsWith("-n -- rm "),
      );
      expect(elevatedRm).toHaveLength(1);
      for (const dir of stuck) expect(elevatedRm[0]).toContain(dir);
    } finally {
      for (const dir of stuck) if (existsSync(dir)) chmodSync(dir, 0o700);
    }
  });

  // The plugin writes as the web server, which can leave a family's parent unlistable by anyone else;
  // the listing is retried with privileges as removal is. (This fake sudo cannot really read it, so
  // the retry is observed and the failure still reported.)
  test("retries a family listing it was refused, with privileges", async () => {
    test.skip(isRoot, "root lists any directory");
    const uploads = join(wpRoot, "wp-content/uploads");
    seed(`wp-content/uploads/backwpup-restore-${TOKEN}`);
    chmodSync(uploads, 0o311);
    try {
      await expect(removeSiteResidue(local, [FAMILY])).rejects.toThrow(
        /could not list .*elevation: available/s,
      );
      expect(
        sudoCalls().some((argv) =>
          argv.startsWith(`-n -- find -H ${uploads} `),
        ),
      ).toBe(true);
    } finally {
      chmodSync(uploads, 0o755);
    }
  });

  // A family whose parent is not there is the common case, and costs no privileged command.
  test("does not escalate, or even probe, to find a parent that is not there", async () => {
    await removeSiteResidue(local, [FAMILY]);
    expect(sudoCalls()).toEqual([]);
  });

  // A correctly-permissioned host must never run anything as root — not even the probe.
  test("does not escalate, or even probe, when the first pass succeeded", async () => {
    seed("wp-content/uploads/backwpup/abc123");
    await removeSiteResidue(local, ["wp-content/uploads/backwpup"]);

    expect(existsSync(join(wpRoot, "wp-content/uploads/backwpup"))).toBe(false);
    expect(sudoCalls()).toEqual([]);
  });

  test("reports that the host has no sudo to fall back on", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    seed("wp-content/uploads/backwpup/abc123");
    const stuck = join(wpRoot, "wp-content/uploads/backwpup");
    chmodSync(stuck, 0o500);
    process.env.FAKE_SUDO_DENY = "1";
    try {
      const failure = await removeSiteResidue(local, [
        "wp-content/uploads/backwpup",
      ]).catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
      expect((failure as SiteResidueRemovalFailedError).elevation).toBe(
        "unavailable",
      );
      expect((failure as Error).message).toMatch(/no passwordless `sudo`/);
    } finally {
      chmodSync(stuck, 0o700);
    }
  });

  /**
   * The guard on the half {@link normaliseResiduePath} cannot see. A privileged `rm -rf` is only as
   * well-aimed as the root it is joined to, so an implausible `rootDir` is refused rather than
   * handed to sudo — checked with `/tmp`, a real one-segment directory.
   */
  test("refuses to escalate against a top-level WordPress root", async () => {
    test.skip(
      isRoot,
      "root ignores directory permissions, so nothing is stuck",
    );
    const name = `e2e-elevation-guard-${String(process.pid)}`;
    const parent = join("/tmp", name);
    mkdirSync(join(parent, "inner"), { recursive: true });
    writeFileSync(join(parent, "inner", "file"), "x");
    chmodSync(parent, 0o500);
    try {
      await expect(
        removeSiteResidue({ mode: "local", rootDir: "/tmp" }, [name]),
      ).rejects.toThrow(/top-level system directory/);
      // Refused before sudo was ever handed the path.
      expect(sudoCalls().some((argv) => argv.includes("rm"))).toBe(false);
    } finally {
      chmodSync(parent, 0o700);
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

/**
 * Removal is guarded before **both** passes, not only the privileged one.
 *
 * A symlinked ancestor makes every lexical check agree while `rm -rf` deletes the referent —
 * measured directly: `rm -rf <root>/wp-content/uploads/backwpup` with `uploads` linked outside
 * removed the target from the other location. "Unprivileged" is only a bound while the transport's
 * user is not root, which a container or a root SSH login does not guarantee, and removing another
 * part of the filesystem is wrong at any privilege.
 */
test.describe("removeSiteResidue — a path that resolves out of the root", () => {
  test("is refused before anything is removed", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    mkdirSync(join(outside, "backwpup"), { recursive: true });
    writeFileSync(join(outside, "backwpup", "keep.txt"), "x");
    mkdirSync(join(wpRoot, "wp-content"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content", "uploads"));

    await expect(
      removeSiteResidue(local, ["wp-content/uploads/backwpup"]),
    ).rejects.toThrow(/outside it/);
    // The measurement that matters: it is still there.
    expect(existsSync(join(outside, "backwpup", "keep.txt"))).toBe(true);
    rmSync(outside, { recursive: true, force: true });
  });
});

/**
 * Preparing the product's data directories.
 *
 * The property under test is the one the cell taught us: after this runs, a directory the plugin
 * writes must be writable by **every** user sharing the docroot — not merely by whoever created it.
 * Checked as a mode rather than by simulating two users, because the mode is the whole mechanism.
 */
test.describe("prepareSiteDataDirs", () => {
  /** The permission bits of `path`, as an octal string. */
  const mode = (path: string): string =>
    (statSync(path).mode & 0o777).toString(8).padStart(4, "0");

  test("creates a missing directory open to both users", async () => {
    await prepareSiteDataDirs(local, ["wp-content/uploads/backwpup-restore"]);
    const dir = join(wpRoot, "wp-content/uploads/backwpup-restore");
    expect(existsSync(dir)).toBe(true);
    expect(mode(dir)).toBe("0777");
  });

  // The real shape of the bug: the directory already exists, created by one user under its own
  // umask, and the *other* user cannot write it. Re-opening it is the fix.
  test("re-opens a directory an earlier run left too tight", async () => {
    const dir = seed("wp-content/uploads/backwpup-restore/uploads");
    const target = join(wpRoot, "wp-content/uploads/backwpup-restore");
    chmodSync(target, 0o775);
    expect(mode(target)).toBe("0775");

    await prepareSiteDataDirs(local, ["wp-content/uploads/backwpup-restore"]);

    expect(mode(target)).toBe("0777");
    // Idempotent, not destructive: what an earlier run left is still there.
    expect(existsSync(dir)).toBe(true);
  });

  // A cache or config folder keeps the modes the plugin under test chose: only removed, never opened.
  test("skips a remove-only path, creating and opening nothing", async () => {
    const kept = seed("wp-content/cache/min");
    chmodSync(kept, 0o755);
    await prepareSiteDataDirs(local, [
      { path: "wp-content/cache/min", prepare: false },
      { path: "wp-content/wp-rocket-config", prepare: false },
    ]);
    expect(mode(kept)).toBe("0755");
    expect(existsSync(join(wpRoot, "wp-content/wp-rocket-config"))).toBe(false);
  });

  test("prepares every declared path", async () => {
    await prepareSiteDataDirs(local, [
      "wp-content/uploads/backwpup",
      "wp-content/uploads/backwpup-restore",
    ]);
    for (const path of ["backwpup", "backwpup-restore"]) {
      const dir = join(wpRoot, "wp-content/uploads", path);
      expect(existsSync(dir), path).toBe(true);
      expect(mode(dir), path).toBe("0777");
    }
  });

  // Same guard as removal: a declaration that is not a path below the root never reaches the site.
  /**
   * Preparation escalates too, so it needs the same root guard removal has. Without it a site whose
   * `rootDir` is a top-level directory would get world-writable directories created **as root** at
   * the filesystem root — and teardown would then refuse to remove what setup had created.
   */
  test("refuses to prepare against a top-level WordPress root", async () => {
    try {
      await expect(
        prepareSiteDataDirs({ mode: "local", rootDir: "/tmp" }, [
          "wp-content/uploads/backwpup",
        ]),
      ).rejects.toThrow(/top-level system directory/);
      expect(existsSync("/tmp/wp-content")).toBe(false);
    } finally {
      // Cleaned unconditionally: `/tmp` is shared with the rest of the machine, so a run where the
      // guard *did* fail would otherwise leave a directory that makes every later run fail here —
      // pointing at the guard instead of at the stale state. Observed exactly that during a
      // mutation test.
      rmSync("/tmp/wp-content", { recursive: true, force: true });
    }
  });

  test("rejects a path WordPress itself owns, before touching the site", async () => {
    await expect(
      prepareSiteDataDirs(local, ["wp-content/uploads"]),
    ).rejects.toThrow(/WordPress itself owns/);
  });

  // The "not even a root lookup" half is proven against `docker` in the removal suite above, where
  // resolving the root is an observable command.
  test("does nothing at all for a product that declares nothing", async () => {
    await expect(prepareSiteDataDirs(local, [])).resolves.toBeUndefined();
  });

  /**
   * The root guard is lexical, so it cannot see that a declared path is a **link out of the tree**.
   * `chmod` here may run as root and follows a symlink given as its operand — measured on GNU
   * coreutils 9.4 — so a link left where a data directory belongs would redirect a privileged `0777`
   * at whatever it resolves to. Proven by the mode of the directory it points at, not by the
   * message: unguarded, this test's own `chmod` reaches it even unprivileged.
   */
  test("refuses a path that is a symbolic link, and leaves its target alone", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-residue-outside-"));
    chmodSync(outside, 0o700);
    mkdirSync(join(wpRoot, "wp-content/uploads"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content/uploads/backwpup"));
    try {
      await expect(
        prepareSiteDataDirs(local, ["wp-content/uploads/backwpup"]),
      ).rejects.toThrow(/symbolic link/);
      expect(mode(outside)).toBe("0700");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /**
   * The mode is a floor; **handing the directory over is the other half**, and it is the half that
   * reaches a subtree — one the plugin's activation just created as WP-CLI, or one an earlier
   * scenario wrote as the web server. Nothing else in this file can observe it: on a developer's
   * machine the transport user already owns the tree, so the correction takes its fast path and runs
   * no command at all. Stubbing `stat`/`id` forces the mismatch a real cell has, and stubbing `sudo`
   * makes the privileged half observable without root.
   */
  test.describe("hands each prepared directory to the site's ownership", () => {
    let binDir: string;
    let logFile: string;
    let realPath: string;

    /** A stub on `PATH` that records its argv and succeeds. */
    function stub(name: string, body: string): void {
      writeFileSync(
        join(binDir, name),
        `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$RESIDUE_LOG"\n${body}\n`,
      );
      chmodSync(join(binDir, name), 0o755);
    }

    /** Every stubbed command run so far, one per line. */
    const ran = (): string[] =>
      existsSync(logFile)
        ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
        : [];

    test.beforeEach(() => {
      binDir = mkdtempSync(join(tmpdir(), "wp-residue-bin-"));
      logFile = join(binDir, "commands.log");
      process.env.RESIDUE_LOG = logFile;
      // Ownership the transport user does not already have, so the fast path cannot fire. Only
      // `stat`, `id` and `sudo` are stubbed — `mkdir` and `chmod` stay real, so the directories this
      // test asserts on are genuinely created.
      stub("stat", 'printf "%s" "www-data:www-data:33:33"');
      stub(
        "id",
        'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
      );
      stub("sudo", "exit 0");
      resetOwnershipCaches();
      realPath = process.env.PATH ?? "";
      process.env.PATH = `${binDir}:${realPath}`;
    });

    test.afterEach(() => {
      process.env.PATH = realPath;
      Reflect.deleteProperty(process.env, "RESIDUE_LOG");
      rmSync(binDir, { recursive: true, force: true });
      resetOwnershipCaches();
    });

    test("recursively, for every declared path", async () => {
      await prepareSiteDataDirs(local, [
        "wp-content/uploads/backwpup",
        "wp-content/uploads/backwpup-restore",
      ]);

      const elevated = ran().filter((line) => line.startsWith("sudo "));
      for (const path of ["backwpup", "backwpup-restore"]) {
        const dir = join(wpRoot, "wp-content/uploads", path);
        // Recursive, and the grant precedes the chown — the ordering `ownership.ts` depends on.
        expect(elevated, path).toContain(
          `sudo -n -- sh -c ${GRANT_SCRIPT} e2e-ownership-grant ug+rwX ${dir}`,
        );
        expect(elevated, path).toContain(
          `sudo -n -- chown -Rh -- www-data:www-data ${dir}`,
        );
        // The unprivileged floor is still applied, independently of the correction succeeding.
        expect(mode(dir), path).toBe("0777");
      }
    });

    /**
     * A host that cannot correct ownership must still get prepared directories: the correction is
     * best-effort by contract, and preparation is not.
     */
    test("without letting a refused correction fail preparation", async () => {
      stub("sudo", 'case "$*" in *chown*) exit 1 ;; esac; exit 0');

      await expect(
        prepareSiteDataDirs(local, ["wp-content/uploads/backwpup"]),
      ).resolves.toBeUndefined();
      expect(mode(join(wpRoot, "wp-content/uploads/backwpup"))).toBe("0777");
    });
  });

  // Nothing to escalate for on a writable tree: preparation must not reach for privileges it does
  // not need, any more than removal does.
  test("names the command, the path and the elevation state when it cannot be done", async () => {
    test.skip(isRoot, "root ignores directory permissions, so mkdir succeeds");
    const uploads = join(wpRoot, "wp-content/uploads");
    mkdirSync(uploads, { recursive: true });
    chmodSync(uploads, 0o500);
    try {
      await expect(
        prepareSiteDataDirs({ ...local, elevate: false }, [
          "wp-content/uploads/backwpup-restore",
        ]),
      ).rejects.toThrow(
        /could not `mkdir -p .*backwpup-restore`.*elevation: disabled\)\. Site commands run as the transport's user here.*remove `transport\.elevate: false`/s,
      );
    } finally {
      chmodSync(uploads, 0o700);
    }
  });
});

/**
 * The refusal's advice must name who really ran the refused command (in `site` the identity, never
 * the transport's user), never claim a declared `runAs` is the web server's (it is never checked
 * against it), and give a fix that can work for that step and that elevation.
 */
test.describe("deniedPreparationAdvice", () => {
  const SUDO = "grant the transport's user passwordless `sudo`";
  const SITE = (target: string) =>
    ({
      kind: "site",
      target: { user: target, group: target },
      identity: {
        user: "www-data",
        group: "web",
        uid: 33,
        gid: 82,
        groupIds: [82],
        groupNames: ["web"],
      },
      umask: "0022",
    }) as const;

  // `site` is reached by `auto` (verified) and by a declared `runAs` (never verified): same words.
  for (const [label, state] of [
    ["auto", SITE("www-data")],
    ["declared runAs", SITE("ubuntu")],
  ] as const) {
    test(`site (${label}): the identity ran it and is never called the web server's`, () => {
      const advice = deniedPreparationAdvice("mkdir", state, "unavailable");
      expect(advice).toContain(
        "Site commands run as the site's identity, www-data:web: make the parent directory writable by www-data",
      );
      expect(advice).not.toContain("web server");
      expect(advice).toContain(SUDO);
      // The transport's user appears only as the one granted `sudo`.
      expect(advice.replace(SUDO, "")).not.toContain("transport's user");
    });
  }

  // Reached by `auto` and by a declared `runAs` naming the transport's user (repro: declared
  // ubuntu:ubuntu, docroot www-data's, transport ubuntu): the web server is never checked then.
  test("same-user/transport-user: the transport's user is the site's identity, not said to be the web server's", () => {
    const advice = deniedPreparationAdvice(
      "mkdir",
      { kind: "same-user", reason: "transport-user" },
      "unavailable",
    );
    expect(advice).toContain(
      "Site commands run as the transport's user, which already is the site's identity: make the parent directory writable by it",
    );
    expect(advice).not.toContain("web server");
    expect(advice).toContain(SUDO);
  });

  for (const state of [
    { kind: "same-user", reason: "mode" },
    { kind: "fallback", reason: "no-sudo", detail: "sudo refused" },
    { kind: "disabled", reason: "config" },
    { kind: "disabled", reason: "as-transport-user" },
  ] as const) {
    test(`${state.kind}/${state.reason}: the transport's user and the web server both need it`, () => {
      const advice = deniedPreparationAdvice("mkdir", state, "unavailable");
      expect(advice).toContain(
        "Site commands run as the transport's user here",
      );
      expect(advice).toContain(
        "writable by both it and the web server, which share this site's docroot",
      );
      expect(advice).toContain(SUDO);
    });
  }

  // A writable parent cannot help a refused chmod: only the directory's owner may change its mode.
  test("a refused chmod asks for ownership of the directory, never a writable parent", () => {
    for (const state of [
      SITE("www-data"),
      { kind: "disabled", reason: "config" } as const,
    ]) {
      const advice = deniedPreparationAdvice("chmod", state, "unavailable");
      expect(advice).toContain("the directory's owner");
      expect(advice).not.toContain("parent directory");
    }
    expect(
      deniedPreparationAdvice("chmod", SITE("www-data"), "unavailable"),
    ).toContain("make www-data the directory's owner");
  });

  // `transport.elevate: false` never tries `sudo`: granting it alone would change nothing.
  test("with elevation disabled it says to turn elevation back on, not only to grant sudo", () => {
    const advice = deniedPreparationAdvice(
      "mkdir",
      { kind: "disabled", reason: "config" },
      "disabled",
    );
    expect(advice).toContain("remove `transport.elevate: false`");
  });

  // Root already tried and failed: offering `sudo` again would send the operator in a circle.
  test("when root's retry was refused too it offers no sudo", () => {
    const advice = deniedPreparationAdvice(
      "mkdir",
      SITE("www-data"),
      "available",
    );
    expect(advice).not.toContain("sudo");
    expect(advice).toContain("Root's retry was refused too.");
  });
});

/**
 * Families — a parent and an anchored name pattern — for the directories a plugin names at runtime.
 * Expanded against the real filesystem, so "what matched" is a property of `find` and the pattern,
 * not of a stub.
 */
const FAMILY = {
  parent: "wp-content/uploads",
  name: /^backwpup-restore-[0-9a-f]{20}$/,
};
const TOKEN = "0123456789abcdef0123";

test.describe("parseResidueDeclaration", () => {
  test("reads a string as a path, normalised", () => {
    expect(parseResidueDeclaration(" wp-content/uploads/./backwpup/ ")).toEqual(
      {
        kind: "path",
        path: "wp-content/uploads/backwpup",
        prepare: true,
      },
    );
  });

  test("reads a remove-only path, normalised, never prepared", () => {
    expect(
      parseResidueDeclaration({
        path: " wp-content/./cache/min/ ",
        prepare: false,
      }),
    ).toEqual({ kind: "path", path: "wp-content/cache/min", prepare: false });
  });

  test("holds a remove-only path to the same rules as a plain one", () => {
    expect(() =>
      parseResidueDeclaration({
        path: "wp-content/mu-plugins",
        prepare: false,
      }),
    ).toThrow(/cannot be removed as leftover data.*WordPress itself owns/s);
    expect(() =>
      parseResidueDeclaration({ path: "../x", prepare: false }),
    ).toThrow(/cannot be removed as leftover data/);
  });

  test("reads a family, its parent normalised", () => {
    expect(
      parseResidueDeclaration({ ...FAMILY, parent: "wp-content/./uploads/" }),
    ).toEqual({
      kind: "family",
      parent: "wp-content/uploads",
      name: FAMILY.name,
    });
  });

  // An escaped `\$` is a literal dollar sign: `/^backwpup-restore\$/` matched "backwpup-restore$tail".
  test("refuses a pattern not anchored at both ends", () => {
    for (const name of [
      /backwpup-restore-/,
      /^backwpup-restore-/,
      /backwpup-restore-x$/,
      /^backwpup-restore\$/,
    ]) {
      expect(() => parseResidueDeclaration({ ...FAMILY, name })).toThrow(
        /not anchored at both ends/,
      );
    }
    expect(
      parseResidueDeclaration({ ...FAMILY, name: /^backwpup-restore\\$/ }).kind,
    ).toBe("family");
  });

  // Each passes the anchoring check and, unrefused, removed what it was never meant to (measured):
  // another plugin's `other-plugin-<hex>`, and a media year folder.
  test("refuses an alternation, which can leave a branch unanchored", () => {
    for (const name of [
      /^backwpup-restore$|-[0-9a-f]{20}$/,
      /^20\d\d|^backwpup-restore-[0-9a-f]{20}$/,
      /^backwpup-restore-(?:[0-9a-f]{20}|x)$/,
    ]) {
      expect(() => parseResidueDeclaration({ ...FAMILY, name })).toThrow(
        /has an alternation/,
      );
    }
  });

  test("refuses a stateful pattern", () => {
    expect(() =>
      parseResidueDeclaration({ ...FAMILY, name: /^backwpup-restore-x$/g }),
    ).toThrow(/global or sticky/);
    expect(() =>
      parseResidueDeclaration({ ...FAMILY, name: /^backwpup-restore-x$/y }),
    ).toThrow(/global or sticky/);
  });

  // `/m` matched "2026\nbackwpup-restore-<hex>" — a name only partly the plugin's.
  test("refuses a multiline pattern", () => {
    expect(() =>
      parseResidueDeclaration({ ...FAMILY, name: /^backwpup-restore-x$/m }),
    ).toThrow(/multiline/);
  });

  // `/^[^.].*$/` is anchored and matches no WordPress directory by name — and every year folder and
  // every other plugin's folder in `uploads`. A family is a fixed prefix and a tail.
  test("refuses a pattern that does not open with a fixed prefix", () => {
    for (const name of [
      /^[^.].*$/,
      /^[a-z0-9]+$/,
      /^\.+$/,
      /^ab$/,
      /^abc?-x$/,
      /^ab*c-x$/,
    ]) {
      expect(
        () => parseResidueDeclaration({ ...FAMILY, name }),
        String(name),
      ).toThrow(/fixed prefix/);
    }
    expect(
      parseResidueDeclaration({ ...FAMILY, name: /^abc-[0-9]+$/ }).kind,
    ).toBe("family");
  });

  // `wp-content` + /^upload.*$/ would match `wp-content/uploads` itself.
  test("refuses a pattern that would match a directory WordPress owns", () => {
    expect(() =>
      parseResidueDeclaration({ parent: "wp-content", name: /^upload.*$/ }),
    ).toThrow(
      /would match "wp-content\/uploads", a directory WordPress itself owns/,
    );
  });

  test("holds the parent to the root rules, short of the root itself", () => {
    expect(() =>
      parseResidueDeclaration({ ...FAMILY, parent: "../elsewhere" }),
    ).toThrow(/escapes the WordPress root/);
    expect(() =>
      parseResidueDeclaration({ ...FAMILY, parent: "/tmp" }),
    ).toThrow(/absolute/);
    expect(() => parseResidueDeclaration({ ...FAMILY, parent: "." })).toThrow(
      /its parent is the WordPress root/,
    );
    expect(() =>
      parseResidueDeclaration({ parent: "wp-admin", name: /^css-x$/ }),
    ).toThrow(/its parent is unusable — it lies inside "wp-admin"/);
  });

  // "wp-content/uploads " names a directory nobody has, so the family would be silently empty.
  test("refuses a parent with a segment edged by whitespace", () => {
    for (const parent of [
      "wp-content/uploads ",
      " wp-content/uploads",
      "wp-content /uploads",
    ]) {
      expect(
        () => parseResidueDeclaration({ ...FAMILY, parent }),
        JSON.stringify(parent),
      ).toThrow(/whitespace/);
    }
  });
});

test.describe("isDeclaredResidue", () => {
  const declarations = ["wp-content/uploads/backwpup", FAMILY].map(
    parseResidueDeclaration,
  );

  test("covers a declared path and a directory of a declared family", () => {
    expect(isDeclaredResidue("wp-content/uploads/backwpup", declarations)).toBe(
      true,
    );
    expect(
      isDeclaredResidue(
        `wp-content/uploads/backwpup-restore-${TOKEN}`,
        declarations,
      ),
    ).toBe(true);
  });

  // The shared path rules trim, so such a name could not be addressed exactly.
  test("never counts a name edged with whitespace as a member", () => {
    const [loose] = [
      { parent: "wp-content/uploads", name: /^plugin-tmp\s?$/ },
    ].map(parseResidueDeclaration);
    if (loose === undefined) throw new Error("unreachable");
    expect(isDeclaredResidue("wp-content/uploads/plugin-tmp", [loose])).toBe(
      true,
    );
    expect(isDeclaredResidue("wp-content/uploads/plugin-tmp ", [loose])).toBe(
      false,
    );
  });

  test("covers nothing deeper, beside, above, or merely similar", () => {
    for (const path of [
      `wp-content/uploads/backwpup-restore-${TOKEN}/uploads`,
      "wp-content/uploads/backwpup-restore",
      "wp-content/uploads/backwpup-restore-0123",
      `wp-content/uploads/backwpup-restore-${TOKEN.toUpperCase()}`,
      `wp-content/backwpup-restore-${TOKEN}`,
      "wp-content/uploads",
    ]) {
      expect(isDeclaredResidue(path, declarations), path).toBe(false);
    }
  });
});

test.describe("removeSiteResidue — families", () => {
  test("removes every directory of the family, whatever its tail", async () => {
    const first = seed(`wp-content/uploads/backwpup-restore-${TOKEN}/extract`);
    const second = seed(
      "wp-content/uploads/backwpup-restore-ffffffffffffffffffff",
    );

    await removeSiteResidue(local, [FAMILY]);

    expect(existsSync(join(first, ".."))).toBe(false);
    expect(existsSync(second)).toBe(false);
  });

  test("leaves its parent, the fixed sibling and every near miss alone", async () => {
    seed(`wp-content/uploads/backwpup-restore-${TOKEN}`);
    const kept = [
      seed("wp-content/uploads/backwpup-restore"),
      seed("wp-content/uploads/backwpup-restore-0123"),
      seed(`wp-content/uploads/backwpup-restore-${TOKEN}-old`),
      seed("wp-content/uploads/2026/10"),
      seed(`wp-content/backwpup-restore-${TOKEN}`),
    ];

    await removeSiteResidue(local, [FAMILY]);

    for (const dir of kept) {
      expect(existsSync(join(dir, "archive.tar")), dir).toBe(true);
    }
  });

  // A family names directories: a file of that name is not one, and a link is never followed.
  test("leaves a matching file, and a matching link and what it points at", async () => {
    const uploads = join(wpRoot, "wp-content/uploads");
    mkdirSync(uploads, { recursive: true });
    const file = join(uploads, `backwpup-restore-${TOKEN}`);
    writeFileSync(file, "keep");
    const outside = mkdtempSync(join(tmpdir(), "wp-residue-family-outside-"));
    writeFileSync(join(outside, "keep.txt"), "keep");
    const link = join(uploads, "backwpup-restore-ffffffffffffffffffff");
    symlinkSync(outside, link);

    try {
      await removeSiteResidue(local, [FAMILY]);
      expect(readFileSync(file, "utf8")).toBe("keep");
      expect(existsSync(link)).toBe(true);
      expect(existsSync(join(outside, "keep.txt"))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("is fine when the parent directory is not there at all", async () => {
    await expect(removeSiteResidue(local, [FAMILY])).resolves.toBeUndefined();
  });

  test("still removes the paths declared beside a family", async () => {
    const backups = seed("wp-content/uploads/backwpup/abc123");
    const restore = seed(`wp-content/uploads/backwpup-restore-${TOKEN}`);

    await removeSiteResidue(local, ["wp-content/uploads/backwpup", FAMILY]);

    expect(existsSync(backups)).toBe(false);
    expect(existsSync(restore)).toBe(false);
  });

  // Measured before the rule: removal trimmed the member's name, deleted the *non-member* `plugin-tmp`
  // and left the member — reporting success.
  test("leaves a name edged with whitespace, and the trimmed name beside it", async () => {
    const member = seed("wp-content/uploads/plugin-tmp ");
    const other = seed("wp-content/uploads/plugin-tmp");

    await removeSiteResidue(unprivileged(), [
      { parent: "wp-content/uploads", name: /^plugin-tmp\s$/ },
    ]);

    expect(existsSync(member)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  // A relocated `uploads` is still where the plugin writes, so its directories are found through the
  // link — measured before `find -H`: prepared, then never removed.
  test("follows a parent that is a link inside the site", async () => {
    mkdirSync(join(wpRoot, "wp-content/real-uploads"), { recursive: true });
    symlinkSync(
      join(wpRoot, "wp-content/real-uploads"),
      join(wpRoot, "wp-content/uploads"),
    );
    const restore = seed(`wp-content/uploads/backwpup-restore-${TOKEN}`);

    expect(await resolveSiteResidue(local, [FAMILY])).toEqual([
      `wp-content/uploads/backwpup-restore-${TOKEN}`,
    ]);
    await removeSiteResidue(local, [FAMILY]);

    expect(existsSync(restore)).toBe(false);
    expect(existsSync(join(wpRoot, "wp-content/real-uploads"))).toBe(true);
  });

  // Listed through the link, a match then lies outside the site — refused before anything is removed.
  test("refuses a parent that is a link out of the site, removing nothing", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-residue-parent-outside-"));
    mkdirSync(join(outside, `backwpup-restore-${TOKEN}`));
    mkdirSync(join(wpRoot, "wp-content"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content/uploads"));
    try {
      await expect(removeSiteResidue(local, [FAMILY])).rejects.toThrow(
        /outside it/,
      );
      expect(existsSync(join(outside, `backwpup-restore-${TOKEN}`))).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // "Nothing matched" must never stand in for "could not look" — and one family that cannot be
  // looked at must not keep the declared paths beside it on the site.
  test("removes the other paths, then fails, when a parent cannot be listed", async () => {
    test.skip(isRoot, "root lists any directory");
    const backups = seed("wp-content/uploads/backwpup/abc123");
    const uploads = join(wpRoot, "wp-content/uploads");
    chmodSync(uploads, 0o311);
    try {
      await expect(
        removeSiteResidue(unprivileged(), [
          "wp-content/uploads/backwpup",
          FAMILY,
        ]),
      ).rejects.toThrow(/could not list .*elevation: disabled/s);
      expect(existsSync(backups)).toBe(false);
    } finally {
      chmodSync(uploads, 0o755);
    }
  });
});

/**
 * What a sweep costs. Every command is a round-trip to the site (~0.8 s over SSH, measured), and a
 * sweep that paid several per leftover once took the teardown past its 120 s budget on a site holding
 * 28 of them. Counted with shims on `PATH` that log each command's name, then run the real one.
 */
test.describe("removeSiteResidue — what it costs", () => {
  /** The commands removal runs, each shimmed to log its name before running the real one. */
  const COMMANDS = ["find", "rm", "test", "readlink"] as const;
  let shimDir: string;
  let log: string;
  let originalPath: string | undefined;
  /** Each command's real binary, found before the shims shadow it. */
  const real = new Map<string, string>();

  test.beforeEach(() => {
    shimDir = mkdtempSync(join(tmpdir(), "wp-residue-shims-"));
    log = join(shimDir, "commands.log");
    for (const command of COMMANDS) {
      const binary = execFileSync("/usr/bin/which", [command], {
        encoding: "utf8",
      }).trim();
      real.set(command, binary);
      writeFileSync(
        join(shimDir, command),
        `#!/bin/sh\nprintf '%s\\n' ${command} >> "${log}"\nexec "${binary}" "$@"\n`,
      );
      chmodSync(join(shimDir, command), 0o755);
    }
    originalPath = process.env.PATH;
    process.env.PATH = `${shimDir}:${originalPath ?? ""}`;
  });

  test.afterEach(() => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
  });

  /** The commands logged so far, then the log emptied. */
  function takeCommands(): string[] {
    const lines = existsSync(log)
      ? readFileSync(log, "utf8").split("\n").filter(Boolean)
      : [];
    rmSync(log, { force: true });
    return lines;
  }

  /** A family member's name for `index`, 20 hex digits like the plugin's own. */
  const member = (index: number): string =>
    `wp-content/uploads/backwpup-restore-${index.toString(16).padStart(20, "0")}`;

  test("runs as many commands for 30 leftovers as for one", async () => {
    const declared = ["wp-content/uploads/backwpup", FAMILY];
    seed(member(1));
    await removeSiteResidue(local, declared);
    const one = takeCommands();

    for (let index = 1; index <= 30; index += 1) seed(member(index));
    await removeSiteResidue(local, declared);
    const thirty = takeCommands();

    expect(thirty).toEqual(one);
    expect(thirty.filter((command) => command === "rm")).toHaveLength(1);
    for (let index = 1; index <= 30; index += 1) {
      expect(existsSync(join(wpRoot, member(index))), member(index)).toBe(
        false,
      );
    }
  });

  // "Could not look" must never read as "gone": the re-read that verifies the removal fails here, so
  // every member counts as a survivor — although `rm` really removed them.
  test("counts every member as a survivor when its parent cannot be listed again", async () => {
    const counter = join(shimDir, "find.count");
    const realFind = real.get("find") ?? "find";
    writeFileSync(
      join(shimDir, "find"),
      `#!/bin/sh\nn=$(cat "${counter}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${counter}"\n` +
        `[ "$n" -ge 2 ] && exit 1\nexec "${realFind}" "$@"\n`,
    );
    seed(member(1));
    seed(member(2));

    const failure = await removeSiteResidue(unprivileged(), [FAMILY]).catch(
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(SiteResidueRemovalFailedError);
    expect(
      [...(failure as SiteResidueRemovalFailedError).paths].sort(),
    ).toEqual([join(wpRoot, member(1)), join(wpRoot, member(2))].sort());
  });
});

test.describe("resolveSiteResidue", () => {
  test("names the declared paths and the family's directories found now", async () => {
    seed(`wp-content/uploads/backwpup-restore-${TOKEN}`);
    expect(
      await resolveSiteResidue(local, ["wp-content/uploads/backwpup", FAMILY]),
    ).toEqual([
      "wp-content/uploads/backwpup",
      `wp-content/uploads/backwpup-restore-${TOKEN}`,
    ]);
  });
});

test.describe("prepareSiteDataDirs — families", () => {
  test("creates nothing for a family, which names no directory yet", async () => {
    await prepareSiteDataDirs(local, [FAMILY]);
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });
});

test.describe("prepareResolvedDataDirs", () => {
  const DECLARED = ["wp-content/uploads/backwpup", FAMILY];
  const mode = (path: string): string =>
    (statSync(path).mode & 0o777).toString(8).padStart(4, "0");

  test("prepares a resolved directory its family covers", async () => {
    const resolved = `wp-content/uploads/backwpup-restore-${TOKEN}`;
    await prepareResolvedDataDirs(local, [resolved], DECLARED);
    expect(mode(join(wpRoot, resolved))).toBe("0777");
  });

  // Prepared and then never removed would be worse than not prepared.
  test("refuses an undeclared directory before creating anything", async () => {
    await expect(
      prepareResolvedDataDirs(
        local,
        [
          `wp-content/uploads/backwpup-restore-${TOKEN}`,
          "wp-content/uploads/somewhere-else",
        ],
        DECLARED,
      ),
    ).rejects.toThrow(/"wp-content\/uploads\/somewhere-else".*never removed/s);
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });

  // Its writer's modes are what is under test: a resolver naming it must not open it `0777`.
  test("refuses a remove-only directory, leaving it and its siblings untouched", async () => {
    const kept = seed("wp-content/cache/min");
    chmodSync(kept, 0o755);
    await expect(
      prepareResolvedDataDirs(
        local,
        [
          `wp-content/uploads/backwpup-restore-${TOKEN}`,
          "wp-content/cache/min",
        ],
        [...DECLARED, { path: "wp-content/cache/min", prepare: false }],
      ),
    ).rejects.toThrow(/"wp-content\/cache\/min".*declared remove-only/s);
    expect(mode(kept)).toBe("0755");
    expect(existsSync(join(wpRoot, "wp-content/uploads"))).toBe(false);
  });

  test("refuses an answer that is no path inside the root, in a resolver's own words", async () => {
    for (const [answer, rule] of [
      ["/var/www/x", /absolute/],
      ["../x", /escapes/],
      ["wp-content/uploads", /WordPress itself owns/],
    ] as const) {
      await expect(
        prepareResolvedDataDirs(local, [answer], DECLARED),
        answer,
      ).rejects.toThrow(
        new RegExp(
          `the product resolved "${answer.replace(/[./]/g, "\\$&")}" as a data directory.*${rule.source}`,
          "s",
        ),
      );
    }
    expect(existsSync(join(wpRoot, "wp-content"))).toBe(false);
  });

  test("does nothing for a build that resolves no directory", async () => {
    await expect(
      prepareResolvedDataDirs(local, [], DECLARED),
    ).resolves.toBeUndefined();
    expect(existsSync(join(wpRoot, "wp-content"))).toBe(false);
  });

  // `chmod` follows the link it is given: measured before the refusal, a resolved directory linked at
  // the WordPress root opened the root itself `0777`.
  test("refuses a resolved directory that is a link, even one inside the site", async () => {
    chmodSync(wpRoot, 0o755);
    mkdirSync(join(wpRoot, "wp-content/uploads"), { recursive: true });
    const resolved = `wp-content/uploads/backwpup-restore-${TOKEN}`;
    symlinkSync(wpRoot, join(wpRoot, resolved));

    await expect(
      prepareResolvedDataDirs(local, [resolved], DECLARED),
    ).rejects.toThrow(/is a symbolic link where the plugin's data directory/);
    expect(mode(wpRoot)).toBe("0755");
  });
});
