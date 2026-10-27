import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_COPY_DB_DEFAULTS,
  CONTENT_COPY_DIR,
  CONTENT_COPY_EXTRACTED,
  CONTENT_COPY_FILE,
  CONTENT_COPY_PARTIAL,
  CONTENT_COPY_RESTORED,
  CONTENT_COPY_STAMP,
  CONTENT_COPY_TOKEN,
  COPY_DIR_GONE,
  ContentCopy,
  IN_COPY_SCRIPT,
  LEGACY_COPY_FILE,
  NOT_THE_COPY_DIR,
  NOT_THIS_RUNS_COPY,
  NO_TOKEN,
  RECOVERING_PREFIX,
  benignCopyWarnings,
  copyArgv,
  copyPlaceIn,
  discardCopy,
  findLeftovers,
  heldCopy,
  inCopyArgv,
  isLeftoverName,
  leftoverMessage,
  parseCopyRoom,
  putBackArgv,
  readsBackWhole,
} from "./content-copy";
import { BOOT, copyHost } from "./__fixtures__/copy-host";
import type { CopyHost } from "./__fixtures__/copy-host";

/**
 * The copy of `wp-content` taken around a restore that rewrites it.
 *
 * GNU tar is not on every runner (macOS ships bsdtar), so tar's own behaviour — `--recursive-unlink`
 * leaving the directory exactly as the copy holds it, links never followed, exit codes — was measured
 * against GNU tar 1.34 and 1.35 and is pinned here as argv. The copy's decisions run on a stubbed host
 * (`./__fixtures__/copy-host.ts`): the directory work and the root scripts for real, the rest answered
 * from the environment, every argv recorded.
 */

test.describe("tar arguments", () => {
  // Never `.` from inside: Ubuntu's GNU tar 1.35 then refuses to unlink `.` on the way back (exit 2,
  // measured live and in `ubuntu:24.04`).
  test("copy: wp-content itself, from the root; exclusions literal and anchored there", () => {
    expect(
      copyArgv(CONTENT_COPY_PARTIAL, "/s", [
        "plugins/backwpup-pro",
        "uploads/backwpup",
      ]),
    ).toEqual([
      "-cf",
      CONTENT_COPY_PARTIAL,
      "--format=posix",
      "--no-wildcards",
      "--anchored",
      "--exclude=wp-content/plugins/backwpup-pro",
      "--exclude=wp-content/uploads/backwpup",
      "-C",
      "/s",
      "wp-content",
    ]);
  });

  test("put back: into the root, owners and modes kept, each directory emptied before it is filled", () => {
    expect(putBackArgv("/s/c.tar", "/s")).toEqual([
      "-xpf",
      "/s/c.tar",
      "--recursive-unlink",
      "-C",
      "/s",
    ]);
  });
});

test.describe("benignCopyWarnings", () => {
  test("accepts files that changed, or went, while they were read", () => {
    expect(
      benignCopyWarnings(
        "tar: ./debug.log: file changed as we read it\ntar: ./cache/x: File removed before we read it\n",
      ),
    ).toBe(true);
  });

  // `File shrank` pads with zeros; `sudo` exits 1 when it refuses; nothing at all is no warning.
  test("refuses anything else at exit 1", () => {
    for (const stderr of [
      "tar: ./cache/big.bin: File shrank by 49929856 bytes; padding with zeros",
      "sudo: a password is required",
      "tar: ./debug.log: file changed as we read it\nsudo: a password is required",
      "",
    ]) {
      expect(benignCopyWarnings(stderr), stderr).toBe(false);
    }
  });
});

test.describe("readsBackWhole", () => {
  test("a listing tar finished, starting with the content directory, reads back whole", () => {
    expect(
      readsBackWhole({ exitCode: 0, stdout: "wp-content/\nwp-content/a" }),
    ).toBe(true);
  });

  // A refused `sudo` exits 1 with nothing; an archive cut mid-member exits 2 having listed some.
  test("a failed listing, an empty one, or one of something else does not", () => {
    expect(readsBackWhole({ exitCode: 2, stdout: "wp-content/" })).toBe(false);
    expect(readsBackWhole({ exitCode: 0, stdout: "" })).toBe(false);
    expect(readsBackWhole({ exitCode: 0, stdout: "etc/passwd" })).toBe(false);
  });
});

test.describe("leftover names and places", () => {
  test("the copy's directory and claimed ones are leftovers; nothing else is", () => {
    expect(isLeftoverName(CONTENT_COPY_DIR)).toBe(true);
    expect(isLeftoverName(`${RECOVERING_PREFIX}a1b2`)).toBe(true);
    for (const name of [
      RECOVERING_PREFIX,
      `${CONTENT_COPY_DIR}.old`,
      `${CONTENT_COPY_DIR}x`,
      "wp-content",
    ]) {
      expect(isLeftoverName(name), name).toBe(false);
    }
  });

  test("a place names the whole copy in its directory", () => {
    expect(copyPlaceIn("/s", "/s/d")).toEqual({
      root: "/s",
      content: "/s/wp-content",
      dir: "/s/d",
      archive: `/s/d/${CONTENT_COPY_FILE}`,
    });
  });

  // Never the name copies were once kept under, so such a leftover is never taken for a whole one.
  test("each stage of a copy has its own name, none the old one", () => {
    const names = [
      CONTENT_COPY_FILE,
      CONTENT_COPY_PARTIAL,
      CONTENT_COPY_RESTORED,
      CONTENT_COPY_STAMP,
    ];
    expect(new Set(names).size).toBe(4);
    expect(names).not.toContain(LEGACY_COPY_FILE);
  });
});

test.describe("heldCopy", () => {
  test("the whole copy alone, its stamp aside, is a copy to put back", () => {
    expect(heldCopy([CONTENT_COPY_FILE])).toBe("whole");
    expect(
      heldCopy([CONTENT_COPY_STAMP, CONTENT_COPY_TOKEN, CONTENT_COPY_FILE]),
    ).toBe("whole");
  });

  // The command runs only once the copy is whole; a copy already back is marked so in the same command.
  test("nothing, the partial copy or the one already back is none to put back", () => {
    for (const entries of [
      [],
      [CONTENT_COPY_STAMP],
      [CONTENT_COPY_PARTIAL, CONTENT_COPY_STAMP],
      [CONTENT_COPY_RESTORED, CONTENT_COPY_STAMP],
      [CONTENT_COPY_FILE, CONTENT_COPY_EXTRACTED, CONTENT_COPY_STAMP],
      [CONTENT_COPY_EXTRACTED],
    ]) {
      expect(heldCopy(entries), String(entries)).toBe("none");
    }
  });

  test("anything else is unknown", () => {
    for (const entries of [
      [LEGACY_COPY_FILE],
      [CONTENT_COPY_FILE, CONTENT_COPY_PARTIAL],
      [CONTENT_COPY_FILE, CONTENT_COPY_RESTORED],
      [CONTENT_COPY_PARTIAL, CONTENT_COPY_EXTRACTED],
      ["x"],
    ]) {
      expect(heldCopy(entries), String(entries)).toBe("unknown");
    }
  });
});

test.describe("leftoverMessage", () => {
  const place = copyPlaceIn("/s", "/s/.e2e_content_copy");

  test("names the whole copy it holds as the way back", () => {
    expect(
      leftoverMessage("t", place, [
        CONTENT_COPY_STAMP,
        CONTENT_COPY_TOKEN,
        CONTENT_COPY_FILE,
      ]),
    ).toContain(
      `\`sudo tar -xpf /s/.e2e_content_copy/${CONTENT_COPY_FILE} --recursive-unlink -C /s\``,
    );
  });

  test("names a copy kept under the old name as the way back", () => {
    expect(leftoverMessage("t", place, [LEGACY_COPY_FILE])).toContain(
      `sudo tar -xpf /s/.e2e_content_copy/${LEGACY_COPY_FILE} --recursive-unlink`,
    );
  });

  test("says a whole copy marked back beside it can simply go", () => {
    const message = leftoverMessage("t", place, [
      CONTENT_COPY_FILE,
      CONTENT_COPY_EXTRACTED,
    ]);
    expect(message).toMatch(/holds no copy to put back/);
    expect(message).not.toContain("tar -xpf");
  });

  test("says a directory holding none to put back can simply go", () => {
    const message = leftoverMessage("t", place, [CONTENT_COPY_PARTIAL]);
    expect(message).toMatch(
      /holds no copy to put back \(wp-content\.partial\.tar\)/,
    );
    expect(message).not.toContain("tar -xpf");
    expect(leftoverMessage("t", place, [])).toContain("(nothing)");
  });

  test("names unknown contents, and points at them when they could not be read", () => {
    expect(leftoverMessage("t", place, ["x", "y"])).toMatch(
      /It holds x, y; settle it by hand/,
    );
    expect(leftoverMessage("t", place)).toContain(
      "<the .tar it holds — `sudo ls -A /s/.e2e_content_copy`>",
    );
  });
});

// Measured: node-ssh drops an empty argument, which shifted the script's positionals live.
test("in-copy arguments are never empty, with or without a token", () => {
  for (const options of [
    {},
    { token: "t1" },
    { mode: "make" as const, token: "t1" },
  ]) {
    const argv = inCopyArgv("/s/.e2e_content_copy", ["ls", "-A"], options);
    expect(argv).not.toContain("");
    expect(argv.slice(3)).toEqual([
      options.mode ?? "use",
      "/s/.e2e_content_copy",
      options.token ?? NO_TOKEN,
      "ls",
      "-A",
    ]);
  }
});

test.describe("IN_COPY_SCRIPT", () => {
  let base: string;
  let fakeBin: string;
  /**
   * Runs the script with a `stat` reporting `owner`, printing the working directory.
   *
   * @returns its exit code and what it printed.
   */
  const run = (
    dir: string,
    { owner = "0:700", mode = "use", token = NO_TOKEN } = {},
  ): { code: number; out: string } => {
    try {
      const out = execFileSync(
        "sh",
        ["-c", IN_COPY_SCRIPT, "sh", mode, dir, token, "pwd", "-P"],
        {
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            OWNER: owner,
          },
          stdio: "pipe",
          encoding: "utf8",
        },
      );
      return { code: 0, out: out.trim() };
    } catch (error) {
      return { code: (error as { status: number }).status, out: "" };
    }
  };

  test.beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "bwp-incopy-")));
    fakeBin = join(base, "bin");
    mkdirSync(fakeBin);
    writeFileSync(join(fakeBin, "stat"), '#!/bin/sh\necho "$OWNER"\n', {
      mode: 0o755,
    });
  });
  test.afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("runs the command in the directory named, when it is root's alone", () => {
    mkdirSync(join(base, "d"));
    expect(run(join(base, "d"))).toEqual({ code: 0, out: join(base, "d") });
  });

  // A link at the name — to another site's copy, or anywhere — would redirect root.
  test("refuses a directory that is a link, or not root's alone", () => {
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "d"));
    expect(run(join(base, "d")).code).toBe(NOT_THE_COPY_DIR);
    expect(run(join(base, "real"), { owner: "501:700" }).code).toBe(
      NOT_THE_COPY_DIR,
    );
    expect(run(join(base, "real"), { owner: "0:755" }).code).toBe(
      NOT_THE_COPY_DIR,
    );
  });

  // Settled by another run meanwhile: told apart, so the run says so instead of "a link".
  test("says apart when nothing is at the path any more", () => {
    expect(run(join(base, "missing")).code).toBe(COPY_DIR_GONE);
    symlinkSync(join(base, "nowhere"), join(base, "dangling"));
    expect(run(join(base, "dangling")).code).toBe(NOT_THE_COPY_DIR);
  });

  test("makes the directory root-only with the run's token, and fails apart when it exists", () => {
    expect(run(join(base, "new"), { mode: "make", token: "t1" }).code).toBe(0);
    expect((statSync(join(base, "new")).mode & 0o777).toString(8)).toBe("700");
    expect(readFileSync(join(base, "new", CONTENT_COPY_TOKEN), "utf8")).toBe(
      "t1\n",
    );
    expect(run(join(base, "new"), { mode: "make", token: "t1" }).code).toBe(93);
  });

  // A run outliving a reboot must not act on the next run's copy at the same path.
  test("runs the command only for the run whose token the copy holds, when one is asked", () => {
    run(join(base, "new"), { mode: "make", token: "t1" });
    expect(run(join(base, "new"), { token: "t1" }).code).toBe(0);
    expect(run(join(base, "new"), { token: "t2" }).code).toBe(
      NOT_THIS_RUNS_COPY,
    );
    expect(run(join(base, "new")).code).toBe(0);
    mkdirSync(join(base, "tokenless"));
    expect(run(join(base, "tokenless"), { token: "t1" }).code).toBe(
      NOT_THIS_RUNS_COPY,
    );
  });
});

test.describe("findLeftovers", () => {
  let host: CopyHost;
  test.beforeEach(() => {
    host = copyHost();
  });
  test.afterEach(() => {
    host.dispose();
  });

  test("lists the root's copies, sorted, and nothing deeper or else", async () => {
    const names = ["f", "c", "a", "e", "b", "d"].map(
      (suffix) => `${RECOVERING_PREFIX}${suffix}`,
    );
    for (const name of [
      CONTENT_COPY_DIR,
      ...names,
      `${CONTENT_COPY_DIR}.old`,
    ]) {
      mkdirSync(join(host.root, name));
    }
    mkdirSync(join(host.root, "wp-content", CONTENT_COPY_DIR));
    expect(await findLeftovers(host.transport, host.root)).toEqual(
      [CONTENT_COPY_DIR, ...names.sort()].map((name) => join(host.root, name)),
    );
  });

  test("throws when the root cannot be listed", async () => {
    await expect(
      findLeftovers(host.transport, join(host.root, "missing")),
    ).rejects.toThrow(/could not list .*find exited/);
  });
});

test.describe("parseCopyRoom", () => {
  const DF =
    "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 101478960 72925244 28537332 72% /\n";

  test("reads the content's size and the free space", () => {
    expect(
      parseCopyRoom({ stdout: "281234\t/s/wp-content\n" }, { stdout: DF }),
    ).toEqual({ usedKb: 281234, freeKb: 28537332 });
  });

  // A refused `sudo du` answers nothing, which must not read as an empty directory.
  test("knows nothing from an empty or unexpected answer", () => {
    expect(parseCopyRoom({ stdout: "" }, { stdout: DF })).toBeUndefined();
    expect(
      parseCopyRoom({ stdout: "du: cannot read" }, { stdout: DF }),
    ).toBeUndefined();
    expect(parseCopyRoom({ stdout: "12\t/x" }, { stdout: "" })).toBeUndefined();
  });
});

test.describe("ContentCopy", () => {
  let host: CopyHost;
  const none = (): Promise<readonly string[]> => Promise.resolve([]);
  const dir = (): string => join(host.root, CONTENT_COPY_DIR);
  const copy = (): ContentCopy => new ContentCopy(host.transport, none);
  /** The stubbed commands run, but `sudo`'s own lines. */
  const ran = (pattern: RegExp): string[] =>
    host.log().filter((line) => pattern.test(line));

  test.beforeEach(() => {
    host = copyHost();
  });
  test.afterEach(() => {
    host.dispose();
  });

  test("copies once, as root, into a root-only stamped directory, leaving out what it was told to", async () => {
    const kept = new ContentCopy(host.transport, () =>
      Promise.resolve(["plugins/backwpup-pro"]),
    );
    await kept.keep();
    await kept.keep();
    expect(ran(/^tar -cf/)).toEqual([
      `tar -cf ${CONTENT_COPY_PARTIAL} --format=posix --no-wildcards --anchored ` +
        `--exclude=wp-content/plugins/backwpup-pro -C ${host.root} wp-content`,
    ]);
    expect((statSync(dir()).mode & 0o777).toString(8)).toBe("700");
    expect(readFileSync(join(dir(), CONTENT_COPY_STAMP), "utf8").trim()).toBe(
      BOOT,
    );
    expect(readdirSync(dir()).sort()).toEqual([
      CONTENT_COPY_STAMP,
      CONTENT_COPY_TOKEN,
      CONTENT_COPY_FILE,
    ]);
    expect(kept.kept).toBe(true);
  });

  // A tar cut short can read back clean, so only the whole name, given after the read-back and once
  // on disk, says a copy is finished.
  test("reads the partial copy back, puts it on disk, then names it whole", async () => {
    await copy().keep();
    expect(ran(/^(tar -tf|sync|mv )/)).toEqual([
      `tar -tf ${CONTENT_COPY_PARTIAL}`,
      `sync -- ${CONTENT_COPY_PARTIAL}`,
      `mv -T -- ${CONTENT_COPY_PARTIAL} ${CONTENT_COPY_FILE}`,
      "sync -- .",
    ]);
  });

  test("refuses a copy it could not put on disk, and leaves nothing behind", async () => {
    process.env.H_SEAL_EXIT = "1";
    await expect(copy().keep()).rejects.toThrow(
      /could not finish the copy of wp-content \(sync: exit 1.*not run/s,
    );
    expect(existsSync(dir())).toBe(false);
  });

  // Its own failure is what the scenario must see, not the cleanup's.
  test("reports the copy's failure, not a removal that failed after it", async () => {
    process.env.H_SEAL_EXIT = "1";
    process.env.H_LOSE_ROOT = "1";
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await expect(copy().keep()).rejects.toThrow(/could not finish the copy/);
    } finally {
      console.warn = warn;
    }
    expect(warnings.join("\n")).toMatch(/could not remove the failed copy/);
  });

  test("refuses a copy directory that is not root's alone, and leaves nothing behind", async () => {
    process.env.H_OWNER = "501:700";
    await expect(copy().keep()).rejects.toThrow(
      /could not prepare .* for the copy \(it is a link, or not root's alone\)/,
    );
    expect(existsSync(dir())).toBe(false);
  });

  // Made by that very command, so this run's — even with no token to show for it.
  test("removes, without asking for its token, a directory it made but could not give one", async () => {
    process.env.H_MKDIR_TOKENDIR = "1";
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await expect(copy().keep()).rejects.toThrow(
        /could not prepare .*exit 98/s,
      );
    } finally {
      console.warn = warn;
    }
    // Its `token` directory is no file `rm -f` removes: the removal is tried, and said to fail.
    expect(ran(/rmdir/)).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(/could not remove .*remove it by hand/);
  });

  // Made by another run between the look and the `mkdir`: never this run's to remove.
  test("leaves a copy directory another run made first", async () => {
    process.env.H_MKDIR_RACE = "1";
    await expect(copy().keep()).rejects.toThrow(/could not prepare .*exit 93/s);
    expect(readdirSync(dir())).toEqual(["theirs"]);
    expect(ran(/rmdir|rm -f/)).toEqual([]);
  });

  test("refuses without elevation, before anything", async () => {
    const kept = new ContentCopy({ ...host.transport, elevate: false }, none);
    await expect(kept.keep()).rejects.toThrow(/passwordless sudo.*not run/s);
    expect(ran(/^(tar|mkdir|du)/)).toEqual([]);
    expect(existsSync(dir())).toBe(false);
  });

  test("refuses when the disk has no room for the copy", async () => {
    process.env.COPY_DU_KB = "5000000";
    process.env.COPY_FREE_KB = "5100000";
    await expect(copy().keep()).rejects.toThrow(
      /only 4980 MB are free.*not run/s,
    );
    expect(ran(/^tar -cf/)).toEqual([]);
  });

  // Measured: a `sudo` limited to other commands exits 1 with no output, which once read as 0 KB.
  test("refuses when the room cannot be told, rather than reading nothing as empty", async () => {
    process.env.COPY_DU_EMPTY = "1";
    await expect(copy().keep()).rejects.toThrow(
      /could not tell whether the disk has room.*not run/s,
    );
  });

  for (const [what, exit, stderr] of [
    ["tar failed", "2", "tar: ./x: Cannot open: Permission denied"],
    [
      "a file shrank while it was read",
      "1",
      "tar: ./big: File shrank by 9 bytes; padding with zeros",
    ],
    ["sudo refused the copy", "1", "sudo: a password is required"],
  ] as const) {
    test(`refuses a copy when ${what}, and leaves nothing behind`, async () => {
      process.env.COPY_TAR_EXIT = exit;
      process.env.COPY_TAR_ERR = stderr;
      await expect(copy().keep()).rejects.toThrow(
        new RegExp(`could not copy wp-content.*exit ${exit}.*not run`, "s"),
      );
      expect(existsSync(dir())).toBe(false);
    });
  }

  test("accepts a copy where a file changed while it was read", async () => {
    process.env.COPY_TAR_EXIT = "1";
    process.env.COPY_TAR_ERR = "tar: ./debug.log: file changed as we read it";
    const kept = copy();
    await kept.keep();
    expect(kept.kept).toBe(true);
  });

  test("refuses a copy that does not read back, and leaves nothing behind", async () => {
    process.env.H_LIST_EXIT = "2";
    await expect(copy().keep()).rejects.toThrow(/does not read back.*not run/s);
    expect(existsSync(dir())).toBe(false);
  });

  // The earlier copy may be the only way back to that run's site; it is never overwritten.
  test("refuses when an earlier run's copy is still there, before anything", async () => {
    mkdirSync(dir());
    await expect(copy().keep()).rejects.toThrow(
      /an earlier run took is still in .*sudo tar -xpf .*--recursive-unlink.*not run/s,
    );
    expect(ran(/^(tar -cf|du )/)).toEqual([]);
    expect(existsSync(dir())).toBe(true);
  });

  // Being settled by another run: a restore now would race its put-back.
  test("refuses when a claimed copy is there, before anything", async () => {
    mkdirSync(join(host.root, `${RECOVERING_PREFIX}abc`));
    await expect(copy().keep()).rejects.toThrow(
      new RegExp(
        `still in .*${RECOVERING_PREFIX.replace(/[.]/g, "\\.")}abc.*not run`,
        "s",
      ),
    );
    expect(ran(/^(tar -cf|du )/)).toEqual([]);
  });

  test("refuses a content directory that is a link", async () => {
    rmSync(join(host.root, "wp-content"), { recursive: true });
    mkdirSync(join(host.root, "real-content"));
    symlinkSync(join(host.root, "real-content"), join(host.root, "wp-content"));
    await expect(copy().keep()).rejects.toThrow(/is a symbolic link.*not run/s);
  });

  test("stamps the copy with the current boot before the command, and refuses the command if it cannot", async () => {
    const kept = copy();
    await kept.stamp();
    expect(ran(/^cp /)).toEqual([]);
    await kept.keep();
    rmSync(join(dir(), CONTENT_COPY_STAMP));
    await kept.stamp();
    expect(readFileSync(join(dir(), CONTENT_COPY_STAMP), "utf8").trim()).toBe(
      BOOT,
    );
    process.env.H_CP_EXIT = "1";
    await expect(kept.stamp()).rejects.toThrow(
      /could not stamp the copy of wp-content in .*exit 1.*restore was not run/s,
    );
  });

  // Rebooted after the stamp: run on reconnecting, the command would rewrite the site while another
  // run may be settling the copy.
  test("refuses the command when the host rebooted since the copy was taken, keeping the copy", async () => {
    const kept = copy();
    await kept.keep();
    process.env.H_BOOT = "33333333-3333-4333-8333-333333333333";
    await expect(kept.stamp()).rejects.toThrow(
      new RegExp(
        `the host rebooted since the copy of wp-content in .* was taken \\(boot ${BOOT}, now 33333333-3333-4333-8333-333333333333\\), so the restore was not run; the copy stays`,
        "s",
      ),
    );
    expect(kept.kept).toBe(true);
    expect(existsSync(join(dir(), CONTENT_COPY_FILE))).toBe(true);
  });

  test("takes no copy when the host's boot id cannot be read", async () => {
    process.env.H_BOOT_EXIT = "1";
    await expect(copy().keep()).rejects.toThrow(
      /could not read the host's boot id .*restore was not run/s,
    );
    expect(existsSync(dir())).toBe(false);
    expect(ran(/^(tar|mkdir)/)).toEqual([]);
  });

  test("stamps nothing once the copy is back", async () => {
    const kept = copy();
    await kept.keep();
    await kept.putBack();
    const before = ran(/^cp /).length;
    await expect(kept.stamp()).resolves.toBeUndefined();
    expect(ran(/^cp /)).toHaveLength(before);
  });

  test("puts nothing back when no copy was taken", async () => {
    await copy().putBack();
    expect(ran(/^tar -xpf/)).toEqual([]);
  });

  test("puts the copy back once — stamped, then extracted, then marked back — then removes it", async () => {
    const kept = copy();
    await kept.keep();
    await kept.putBack();
    await kept.putBack();
    expect(
      ran(/^(cp |tar -xpf|mv -T -- wp-content\.verified)/).slice(1),
    ).toEqual([
      `cp -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
      `tar -xpf ${CONTENT_COPY_FILE} --recursive-unlink -C ${host.root}`,
      `mv -T -- ${CONTENT_COPY_FILE} ${CONTENT_COPY_RESTORED}`,
    ]);
    expect(existsSync(dir())).toBe(false);
    expect(kept.kept).toBe(false);
  });

  // The copy is then the only way back, so it stays — with the way back spelled out.
  test("keeps the copy, and says how to put it back, when it will not go back", async () => {
    process.env.H_PUT_EXIT = "2";
    const kept = copy();
    await kept.keep();
    await expect(kept.putBack()).rejects.toThrow(
      new RegExp(
        `could not put wp-content back \\(exit 2.*sudo tar -xpf ${join(dir(), CONTENT_COPY_FILE).replace(/[.]/g, "\\.")} --recursive-unlink -C ${host.root.replace(/[.]/g, "\\.")}\``,
        "s",
      ),
    );
    expect(readdirSync(dir()).sort()).toEqual([
      CONTENT_COPY_STAMP,
      CONTENT_COPY_TOKEN,
      CONTENT_COPY_FILE,
    ]);
    expect(kept.kept).toBe(true);
  });

  test("puts nothing back when the copy cannot be stamped first", async () => {
    const kept = copy();
    await kept.keep();
    process.env.H_CP_EXIT = "1";
    await expect(kept.putBack()).rejects.toThrow(
      /could not stamp the copy before putting it back .*nothing was put back/s,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
    expect(kept.kept).toBe(true);
  });

  // Back, but still named whole, a later run could put it back over what changed since.
  // Renamed or not, it must never count as a copy to put back again.
  test("marks a copy back beside it when it cannot be renamed so, then removes it", async () => {
    process.env.H_MARK_EXIT = "1";
    const kept = copy();
    await kept.keep();
    await kept.putBack();
    expect(
      ran(/^(mv -T -- wp-content\.verified|tar -xpf|sync -- \.)/).slice(-3),
    ).toEqual([
      `tar -xpf ${CONTENT_COPY_FILE} --recursive-unlink -C ${host.root}`,
      `mv -T -- ${CONTENT_COPY_FILE} ${CONTENT_COPY_RESTORED}`,
      "sync -- .",
    ]);
    expect(existsSync(dir())).toBe(false);
  });

  test("says to remove by hand a copy that went back but could be marked so neither way", async () => {
    process.env.H_MARK_EXIT = "1";
    const kept = copy();
    await kept.keep();
    mkdirSync(join(dir(), CONTENT_COPY_EXTRACTED));
    await expect(kept.putBack()).rejects.toThrow(
      /put wp-content back, but could not mark the copy so .*sudo rm -r .*over what changed since/s,
    );
    expect(existsSync(dir())).toBe(true);
  });

  /** A copy kept by a run that waits `boundMs` for a restore still running, looking often. */
  const waiting = (boundMs: number): ContentCopy =>
    new ContentCopy(host.transport, none, { boundMs, pollMs: 10 });

  // Another run settled this one's copy after a reboot and made its own at the same path.
  test("leaves alone, and says so, a copy at its path that holds another run's token", async () => {
    const kept = copy();
    await kept.keep();
    writeFileSync(join(dir(), CONTENT_COPY_TOKEN), "another-run\n");
    await expect(kept.putBack()).rejects.toThrow(
      /the copy of wp-content at .* is no longer this run's \(it holds another run's token\) — another run settled it, so nothing was put back\.$/,
    );
    expect(ran(/^(cp |tar -xpf|rm )/).slice(1)).toEqual([]);
    expect(existsSync(join(dir(), CONTENT_COPY_FILE))).toBe(true);
    expect(kept.kept).toBe(false);
    await expect(kept.stamp()).resolves.toBeUndefined();
  });

  test("removes nothing of a copy that holds another run's token", async () => {
    const kept = copy();
    await kept.keep();
    writeFileSync(join(dir(), CONTENT_COPY_TOKEN), "another-run\n");
    await expect(
      discardCopy(host.transport, copyPlaceIn(host.root, dir()), "mine"),
    ).resolves.toBe(false);
    expect(readdirSync(dir()).sort()).toEqual([
      CONTENT_COPY_STAMP,
      CONTENT_COPY_TOKEN,
      CONTENT_COPY_FILE,
    ]);
    expect(ran(/rmdir/)).toEqual([]);
  });

  test("says the copy is gone, putting nothing back, when another run removed it", async () => {
    const kept = copy();
    await kept.keep();
    rmSync(dir(), { recursive: true });
    await expect(kept.putBack()).rejects.toThrow(
      /is no longer this run's \(it is gone\) — another run settled it/,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
  });

  // Another run's copy at the path between this run's steps: never written into, never removed.
  for (const [step, env, said] of [
    [
      "copied",
      "H_SWAP_TOKEN",
      /could not copy wp-content before the restore \(it holds another run's token\)/,
    ],
    [
      "sealed",
      "H_SWAP_TOKEN_ON_TF",
      /could not finish the copy of wp-content \(sync: it holds another run's token\)/,
    ],
  ] as const) {
    test(`leaves alone a copy that became another run's before it was ${step}`, async () => {
      process.env[env] = "1";
      await expect(copy().keep()).rejects.toThrow(said);
      // What it runs no further: the copy's tar, or the seal's sync and rename.
      expect(ran(step === "copied" ? /^tar -cf/ : /^(sync|mv )/)).toEqual([]);
      expect(readFileSync(join(dir(), CONTENT_COPY_TOKEN), "utf8")).toBe(
        "another-run\n",
      );
      expect(ran(/rmdir/)).toEqual([]);
    });
  }

  // `sudo` refused before anything was made: what is at the path is not this run's.
  test("removes nothing when it could not make the copy's directory at all", async () => {
    process.env.H_SUDO_REFUSE_MAKE = "1";
    await expect(copy().keep()).rejects.toThrow(
      /could not prepare .*exit 1: sudo: a password is required/s,
    );
    expect(readdirSync(dir())).toEqual(["theirs"]);
    expect(ran(/rmdir|rm -f/)).toEqual([]);
  });

  test("removes a directory it made when it could not stamp it", async () => {
    process.env.H_CP_EXIT = "1";
    await expect(copy().keep()).rejects.toThrow(/could not prepare .*exit 94/s);
    expect(existsSync(dir())).toBe(false);
  });

  test("refuses to stamp, save beside or seal a copy that is no longer this run's", async () => {
    const kept = copy();
    await kept.keep();
    writeFileSync(join(dir(), CONTENT_COPY_TOKEN), "another-run\n");
    await expect(kept.stamp()).rejects.toThrow(
      /could not stamp .*another run's token.*restore was not run/s,
    );
    await expect(
      kept.keepDatabaseDefaults({ charset: "utf8mb4", collation: "c" }),
    ).rejects.toThrow(
      /could not save the database's defaults .*another run's token/s,
    );
  });

  test("saves the database's defaults beside the copy, and nothing without one", async () => {
    const kept = copy();
    await kept.keepDatabaseDefaults({ charset: "utf8mb4", collation: "x" });
    expect(existsSync(dir())).toBe(false);
    await kept.keep();
    await kept.keepDatabaseDefaults({
      charset: "utf8mb4",
      collation: "utf8mb4_general_ci",
    });
    expect(
      JSON.parse(readFileSync(join(dir(), CONTENT_COPY_DB_DEFAULTS), "utf8")),
    ).toEqual({ charset: "utf8mb4", collation: "utf8mb4_general_ci" });
  });

  // A connection dropped mid-restore leaves the command running on the site; extracting under it
  // would leave neither as found.
  test("waits for a restore still running on the site before putting the copy back", async () => {
    process.env.H_INUSE = "4242 php\n";
    process.env.H_INUSE_UNTIL = "2";
    const kept = waiting(60_000);
    await kept.keep();
    await kept.putBack();
    expect(ran(/e2e-content-copy-in-use-probe/)).toHaveLength(3);
    expect(ran(/^tar -xpf/)).toHaveLength(1);
    expect(existsSync(dir())).toBe(false);
  });

  test("keeps the copy, putting nothing back, while a restore outlasts the wait", async () => {
    process.env.H_INUSE = "4242 php\n";
    const kept = waiting(300);
    await kept.keep();
    await expect(kept.putBack()).rejects.toThrow(
      /a restore, or another use of the copy, still runs on the site after 0.3 s \(4242 php\), so nothing was put back.*sudo tar -xpf/s,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
    expect(kept.kept).toBe(true);
  });

  test("keeps the copy, putting nothing back, when whether a restore runs cannot be told", async () => {
    process.env.H_INUSE = "";
    process.env.H_INUSE_EXIT = "2";
    const kept = waiting(60_000);
    await kept.keep();
    await expect(kept.putBack()).rejects.toThrow(
      /whether a restore still runs on the site could not be told, so nothing was put back/,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
  });
});
