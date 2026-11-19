import { test, expect } from "@playwright/test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_COPY_DIR,
  MOUNT_CHECK_PERL,
  MOUNT_INSIDE,
  MOUNTINFO_PATH,
  MOUNTS_UNKNOWN,
  RENAME_PROBE,
  CONTENT_COPY_FILE,
  CONTENT_COPY_RESTORED,
  NO_ROOM,
  PUT_BACK_SCRIPT,
  SWAP_PERL,
  SWAP_TRIES,
} from "./content-copy";
import { CONTENT_COPY_LEASE, parseLease } from "./content-copy-lease";
import {
  sshTwinsEnabled,
  withTwin,
} from "../../../common/__fixtures__/ssh-twins";
import type { ChildProcess } from "node:child_process";

/**
 * Putting a copy of `wp-content` back while the site writes into it — the incident this replaced: an
 * extraction over `wp-content` (`tar --recursive-unlink`) failed `Cannot unlink: Directory not empty`
 * because the web server wrote into a directory tar was emptying, and the copy then blocked the site.
 *
 * The swap ({@link SWAP_PERL}) runs wherever `perl` does, a recreated `wp-content` and every failure
 * forced by overriding `rename`. The whole put-back ({@link PUT_BACK_SCRIPT}) runs where GNU tar and
 * `/proc` are: Linux (CI, as the runner's user), or inside the nginx twin (`E2E_SSH_TWINS=1`, as root,
 * the writer as `www-data`) — with a writer hammering `wp-content`, under which the old extraction is
 * first shown to fail.
 */

test.describe("SWAP_PERL", () => {
  let base: string;
  let hook: string;
  const content = (): string => join(base, "root", "wp-content");
  const scratch = (): string => join(base, "copy", "swap");

  /**
   * Runs the swap with `rename` overridden by the environment:
   * `RECREATE=n` — after each of the first n moves aside, a writer makes `wp-content` again, holding
   * a file; `FAIL_ASIDE` — moving aside fails; `FAIL_PLACE` — moving the copy into place fails (a
   * cross-device rename); `REPLACE_AFTER` — something replaces `wp-content` right after the swap.
   */
  const swap = (
    env: Record<string, string> = {},
  ): { code: number; stderr: string } => {
    const result = spawnSync(
      "perl",
      [
        `-I${hook}`,
        "-MHook",
        "-e",
        SWAP_PERL,
        "--",
        content(),
        scratch(),
        String(SWAP_TRIES),
      ],
      { encoding: "utf8", env: { ...process.env, ...env } },
    );
    return { code: result.status ?? -1, stderr: result.stderr };
  };

  test.beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bwp-swap-"));
    hook = join(base, "hook");
    mkdirSync(hook);
    writeFileSync(
      join(hook, "Hook.pm"),
      `package Hook;
my $made = 0;
BEGIN {
  *CORE::GLOBAL::rename = sub {
    my ($from, $to) = @_;
    my $aside = $to =~ m{/old\\.\\d+$};
    if ($aside && $ENV{FAIL_ASIDE}) { $! = 13; return 0; }
    if (!$aside && $from =~ m{/new/wp-content$} && $ENV{FAIL_PLACE}) { $! = 18; return 0; }
    my $ok = CORE::rename($from, $to);
    if ($ok && $aside && $made < ($ENV{RECREATE} // 0)) {
      $made++; mkdir $from; open(my $f, ">", "$from/debug.log"); close $f;
    }
    if ($ok && !$aside && $ENV{REPLACE_AFTER}) { CORE::rename($to, "$to.moved"); mkdir $to; }
    return $ok;
  };
}
1;
`,
    );
    mkdirSync(join(content(), "plugins"), { recursive: true });
    writeFileSync(join(content(), "left-by-restore"), "x");
    mkdirSync(join(scratch(), "new", "wp-content"), { recursive: true });
    writeFileSync(join(scratch(), "new", "wp-content", "from-copy"), "y");
  });
  test.afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("moves wp-content aside and the copy into its place", () => {
    expect(swap()).toEqual({ code: 0, stderr: "" });
    expect(readdirSync(content())).toEqual(["from-copy"]);
    expect(readdirSync(join(scratch(), "old.1")).sort()).toEqual([
      "left-by-restore",
      "plugins",
    ]);
  });

  // A put-back cut off between its two renames left no wp-content; the next one completes it.
  test("puts the copy in place when wp-content is missing", () => {
    rmSync(content(), { recursive: true });
    expect(swap().code).toBe(0);
    expect(readdirSync(content())).toEqual(["from-copy"]);
    expect(existsSync(join(scratch(), "old.1"))).toBe(false);
  });

  // The incident's writer: a request recreating wp-content (`wp_mkdir_p`, the debug log) in the
  // moment it is missing.
  test("moves aside a wp-content recreated under it, and tries again", () => {
    expect(swap({ RECREATE: "2" }).code).toBe(0);
    expect(readdirSync(content())).toEqual(["from-copy"]);
    expect(readdirSync(join(scratch(), "old.2"))).toEqual(["debug.log"]);
    expect(readdirSync(join(scratch(), "old.3"))).toEqual(["debug.log"]);
  });

  test("gives up, saying so, when wp-content is made again on every try", () => {
    const result = swap({ RECREATE: "99" });
    expect(result.code).toBe(12);
    expect(result.stderr).toContain(
      `wp-content was made again ${String(SWAP_TRIES)} times`,
    );
  });

  // A writer that gives up in time: what it made is moved aside once more and the original put back.
  test("past its last try, moves the original wp-content back in place", () => {
    const result = swap({ RECREATE: String(SWAP_TRIES) });
    expect(result.code).toBe(11);
    expect(readdirSync(content()).sort()).toEqual([
      "left-by-restore",
      "plugins",
    ]);
    expect(
      readdirSync(join(scratch(), `old.${String(SWAP_TRIES + 1)}`)),
    ).toEqual(["debug.log"]);
    expect(readdirSync(join(scratch(), "new"))).toEqual(["wp-content"]);
  });

  test("changes nothing when wp-content cannot be moved aside", () => {
    const result = swap({ FAIL_ASIDE: "1" });
    expect(result.code).toBe(11);
    expect(result.stderr).toMatch(/could not move wp-content aside: /);
    expect(readdirSync(content()).sort()).toEqual([
      "left-by-restore",
      "plugins",
    ]);
  });

  // Never left without a wp-content: the one moved aside goes back.
  test("moves wp-content back when the copy cannot be moved into place", () => {
    const result = swap({ FAIL_PLACE: "1" });
    expect(result.code).toBe(11);
    expect(result.stderr).toMatch(/could not move the copy into place: /);
    expect(readdirSync(content()).sort()).toEqual([
      "left-by-restore",
      "plugins",
    ]);
  });

  test("says what is at wp-content is not the copy when it was replaced right after", () => {
    expect(swap({ REPLACE_AFTER: "1" }).code).toBe(13);
  });

  test("says the copy is missing, changing nothing, when there is none to put in place", () => {
    rmSync(join(scratch(), "new"), { recursive: true });
    expect(swap().code).toBe(11);
    expect(readdirSync(content()).sort()).toEqual([
      "left-by-restore",
      "plugins",
    ]);
  });

  // The restore may leave a link at wp-content: moved aside as the link, its target never touched.
  test("moves a link at wp-content aside without following it", () => {
    const elsewhere = join(base, "elsewhere");
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, "keep"), "z");
    rmSync(content(), { recursive: true });
    symlinkSync(elsewhere, content());
    expect(swap().code).toBe(0);
    expect(lstatSync(join(scratch(), "old.1")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(scratch(), "old.1"))).toBe(elsewhere);
    expect(readdirSync(elsewhere)).toEqual(["keep"]);
    expect(readdirSync(content())).toEqual(["from-copy"]);
  });
});

test.describe("MOUNT_CHECK_PERL", () => {
  let base: string;
  const root = (): string => join(base, "root");
  /**
   * Runs the check on `root()` against a mount table holding `/` and `lines`.
   *
   * @param lines - mountinfo lines after the root's.
   * @param mode - `scan`, or `probe`.
   */
  const check = (
    lines: string[],
    mode = "scan",
  ): { code: number; stderr: string } => {
    const table = join(base, "mountinfo");
    writeFileSync(
      table,
      ["25 1 8:1 / / rw shared:1 - ext4 /dev/sda1 rw", ...lines, ""].join("\n"),
    );
    const result = spawnSync(
      "perl",
      ["-e", MOUNT_CHECK_PERL, "--", root(), table, mode, RENAME_PROBE],
      { encoding: "utf8", cwd: join(base, "copy") },
    );
    return { code: result.status ?? -1, stderr: result.stderr };
  };
  /** A mount line at `path` (already escaped), of type `fs`. */
  const at = (path: string, fs = "tmpfs"): string =>
    `90 25 0:50 / ${path} rw,relatime shared:9 - ${fs} ${fs} rw`;

  test.beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "bwp-mounts-")));
    mkdirSync(join(root(), "wp-content", "uploads"), { recursive: true });
    mkdirSync(join(base, "copy"));
  });
  test.afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("passes when no mount is at or under wp-content", () => {
    expect(check([at("/mnt/backups"), at(`${root()}/wp-content-old`)])).toEqual(
      {
        code: 0,
        stderr: "",
      },
    );
  });

  test("refuses a mount under wp-content, its escapes decoded", () => {
    const result = check([at(`${root()}/wp-content/up\\040loads\\011x\\134y`)]);
    expect(result.code).toBe(MOUNT_INSIDE);
    expect(result.stderr).toBe(
      `a mount is at ${root()}/wp-content/up loads\tx\\y\n`,
    );
  });

  test("refuses a mount at wp-content itself", () => {
    expect(check([at(`${root()}/wp-content`)]).code).toBe(MOUNT_INSIDE);
  });

  // The root as given may lead through a link; the table names the resolved path.
  test("compares the resolved root, not the path given", () => {
    symlinkSync(root(), join(base, "link"));
    const table = join(base, "mountinfo");
    writeFileSync(
      table,
      `25 1 8:1 / / rw - ext4 /dev/sda1 rw\n${at(`${root()}/wp-content/uploads`)}\n`,
    );
    const result = spawnSync(
      "perl",
      ["-e", MOUNT_CHECK_PERL, "--", join(base, "link"), table, "scan", "-"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(MOUNT_INSIDE);
  });

  test("cannot tell from a table it cannot read, or one with no mount holding the root", () => {
    const result = spawnSync(
      "perl",
      ["-e", MOUNT_CHECK_PERL, "--", root(), join(base, "none"), "scan", "-"],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(MOUNTS_UNKNOWN);
    const empty = join(base, "empty");
    writeFileSync(empty, "");
    expect(
      spawnSync(
        "perl",
        ["-e", MOUNT_CHECK_PERL, "--", root(), empty, "scan", "-"],
        { encoding: "utf8" },
      ).status,
    ).toBe(MOUNTS_UNKNOWN);
  });

  test("probes nothing on a filesystem other than overlay", () => {
    expect(check([], "probe")).toEqual({ code: 0, stderr: "" });
    expect(existsSync(join(base, "copy", RENAME_PROBE))).toBe(false);
  });

  // The exchange is atomic and goes both ways: wp-content is the same directory after it. Where
  // `renameat2`'s number is unknown it cannot probe, and says so.
  test("on overlay, exchanges wp-content away and back, leaving it as it was", () => {
    writeFileSync(join(root(), "wp-content", "uploads", "keep"), "k");
    const before = lstatSync(join(root(), "wp-content")).ino;
    const result = check([at(root(), "overlay")], "probe");
    if (
      ["x64", "arm64"].includes(process.arch) &&
      process.platform === "linux"
    ) {
      expect(result).toEqual({ code: 0, stderr: "" });
    } else {
      expect(result.code).toBe(MOUNTS_UNKNOWN);
      expect(result.stderr).toMatch(/cannot be checked on this machine/);
    }
    expect(lstatSync(join(root(), "wp-content")).ino).toBe(before);
    expect(readdirSync(join(root(), "wp-content", "uploads"))).toEqual([
      "keep",
    ]);
    expect(existsSync(join(base, "copy", RENAME_PROBE))).toBe(false);
  });
});

/** Where GNU tar, coreutils and `/proc` are: here on Linux, or inside the nginx twin. */
const GNU_HOST: "local" | "twin" | undefined =
  process.platform === "linux"
    ? "local"
    : sshTwinsEnabled()
      ? "twin"
      : undefined;

/** The twin the GNU half runs in. */
const TWIN = "wpme-ssh-nginx";

/**
 * Runs `argv` on the GNU host: as root in the twin (in `cwd` there), else here.
 *
 * @returns its exit code and output.
 */
function onGnu(
  argv: readonly string[],
  cwd?: string,
): { code: number; stdout: string; stderr: string } {
  const [file = "", ...args] =
    GNU_HOST === "twin"
      ? [
          "docker",
          "exec",
          ...(cwd === undefined ? [] : ["-w", cwd]),
          TWIN,
          ...argv,
        ]
      : argv;
  const result = spawnSync(file, args, {
    encoding: "utf8",
    cwd: GNU_HOST === "twin" ? undefined : cwd,
    timeout: 120_000,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Runs a shell line on the GNU host; its stdout, trimmed; fails the test on a non-zero exit. */
function shell(line: string, ...args: string[]): string {
  const run = onGnu(["sh", "-c", line, "sh", ...args]);
  expect(run.code, run.stderr).toBe(0);
  return run.stdout.trim();
}

/**
 * Starts a writer like the site's: in a tight loop, recreates `wp-content` and a folder in it when
 * missing (`wp_mkdir_p`) and writes files into both (the debug log, caches) — as `www-data` in the
 * twin. Stop it with {@link stopWriter}.
 *
 * @param root - the WordPress root.
 */
function startWriter(root: string): ChildProcess {
  const loop =
    'n=0; while :; do n=$((n+1)); mkdir -p "$1/wp-content/e2e-writer" 2>/dev/null; ' +
    ': > "$1/wp-content/e2e-writer/w$n" 2>/dev/null; : > "$1/wp-content/e2e-writer-$n" 2>/dev/null; done';
  const argv = ["sh", "-c", loop, "e2e-writer", root];
  const [file = "", ...args] =
    GNU_HOST === "twin"
      ? ["docker", "exec", "-u", "www-data", TWIN, ...argv]
      : argv;
  return spawn(file, args, { stdio: "ignore" });
}

/** Stops the writer started by {@link startWriter}, in the twin too. */
async function stopWriter(writer: ChildProcess): Promise<void> {
  if (GNU_HOST === "twin") onGnu(["pkill", "-f", "e2e-writer"]);
  writer.kill("SIGKILL");
  await new Promise((resolve) => setTimeout(resolve, 200));
}

/**
 * `wp-content` as a listing to compare: every entry's path, owner and mode, and each file's size,
 * mtime and checksum — what the site's own writer added left out.
 */
function listing(root: string): string {
  return shell(
    'cd "$1" && find wp-content \\( -name "e2e-writer*" -prune \\) -o \\( -type f -printf "%p %U:%G %m %s %T@ " -exec sh -c "md5sum < \\"\\$1\\" | cut -c1-32" sh {} \\; \\) -o -printf "%p %U:%G %m %y\\n" | sort',
    root,
  );
}

test.describe("PUT_BACK_SCRIPT under a live writer", () => {
  test.skip(
    GNU_HOST === undefined,
    "needs GNU tar and /proc: Linux, or E2E_SSH_TWINS=1 with the twins up",
  );
  test.setTimeout(300_000);

  /**
   * Makes a site with a `wp-content` of a few thousand entries — some the web server's, some root's,
   * modes mixed —, its copy in a root-only copy directory as a run takes it, then damages
   * `wp-content` as a restore would. Runs `work`, holding the twin, then removes it all.
   */
  async function withSite(
    work: (site: {
      root: string;
      copy: string;
      before: string;
    }) => Promise<void> | void,
  ): Promise<void> {
    const run = async (): Promise<void> => {
      const parent = GNU_HOST === "twin" ? "/tmp" : tmpdir();
      const base = shell('mktemp -d -p "$1" e2e-put-back.XXXXXX', parent);
      try {
        const root = `${base}/root`;
        const copy = `${root}/${CONTENT_COPY_DIR}`;
        shell(
          'chmod 0755 "$1" && mkdir -p "$2/wp-content" && cd "$2/wp-content" && ' +
            "for i in $(seq 1 1500); do mkdir -p uploads/d$i && echo $i > uploads/d$i/f; done && " +
            "mkdir -p plugins/a && echo '<?php' > plugins/a/a.php && chmod 0640 plugins/a/a.php && " +
            "ln -s a.php plugins/a/link && ln plugins/a/a.php plugins/hard && chmod 0777 . && " +
            'if [ "$(id -u)" = 0 ]; then chown -R www-data:www-data uploads; fi && ' +
            'chmod 0755 "$2" && mkdir -m 0700 "$3" && ' +
            `tar -cf "$3/${CONTENT_COPY_FILE}" --format=posix -C "$2" wp-content`,
          base,
          root,
          copy,
        );
        const before = listing(root);
        // What a restore leaves: files gone, others added, a mode changed.
        shell(
          'cd "$1/wp-content" && rm -rf uploads/d1 uploads/d2 && echo new > added && chmod 0600 plugins/a/a.php',
          root,
        );
        expect(listing(root)).not.toBe(before);
        await work({ root, copy, before });
      } finally {
        onGnu(["rm", "-rf", "--", base]);
      }
    };
    await (GNU_HOST === "twin" ? withTwin("nginx", run) : run());
  }

  // Proves the writer reproduces the incident, so the test below is no stronger than the old way.
  test("the old put-back — extracting over wp-content — fails while the site writes into it", async () => {
    await withSite(async ({ root, copy }) => {
      const writer = startWriter(root);
      const tries: string[] = [];
      try {
        for (
          let i = 0;
          i < 3 && tries.every((t) => !t.includes("Directory not empty"));
          i += 1
        ) {
          const old = onGnu(
            [
              "tar",
              "-xpf",
              CONTENT_COPY_FILE,
              "--recursive-unlink",
              "-C",
              root,
            ],
            copy,
          );
          tries.push(`exit ${String(old.code)}: ${old.stderr}`);
        }
      } finally {
        await stopWriter(writer);
      }
      expect(tries.join("\n")).toMatch(
        /exit 2: tar: wp-content: Cannot unlink: Directory not empty/,
      );
    });
  });

  test("puts wp-content back exactly while the site writes into it, then marks the copy back and expires its lease", async () => {
    await withSite(async ({ root, copy, before }) => {
      const writer = startWriter(root);
      let result: ReturnType<typeof onGnu>;
      try {
        result = onGnu(
          ["sh", "-c", PUT_BACK_SCRIPT, "sh", root, "900", "r#0", "1024"],
          copy,
        );
      } finally {
        await stopWriter(writer);
      }
      expect(result.code, result.stderr).toBe(0);
      expect(listing(root)).toBe(before);
      expect(shell('ls -A "$1"', copy).split("\n").sort()).toEqual(
        expect.arrayContaining([
          CONTENT_COPY_RESTORED,
          CONTENT_COPY_LEASE,
          "swap",
        ]),
      );
      const lease = parseLease(
        shell('cat "$1"', `${copy}/${CONTENT_COPY_LEASE}`),
      );
      expect(lease?.expiresS).toBe(lease?.renewedS);
      // What the restore left went aside, root-only, with the copy.
      expect(shell('ls "$1/swap/old.1"', copy)).toContain("added");
    });
  });

  // The twins' sites live in a container's upper layer: renamed fine, so the probe passes.
  test("the rename probe leaves wp-content exactly as it was, while the site writes into it", async () => {
    await withSite(async ({ root, copy }) => {
      const damaged = listing(root);
      const writer = startWriter(root);
      let result: ReturnType<typeof onGnu>;
      try {
        result = onGnu(
          [
            "perl",
            "-e",
            MOUNT_CHECK_PERL,
            "--",
            root,
            MOUNTINFO_PATH,
            "probe",
            RENAME_PROBE,
          ],
          copy,
        );
      } finally {
        await stopWriter(writer);
      }
      expect(result.code, result.stderr).toBe(0);
      expect(listing(root)).toBe(damaged);
      expect(shell('ls -A "$1"', copy)).not.toContain(RENAME_PROBE);
    });
  });

  test("changes nothing, and removes what it extracted, when the disk has no room for a second tree", async () => {
    await withSite(({ root, copy }) => {
      const damaged = listing(root);
      const result = onGnu(
        [
          "sh",
          "-c",
          PUT_BACK_SCRIPT,
          "sh",
          root,
          "900",
          "r#0",
          String(2 ** 50),
        ],
        copy,
      );
      expect(result.code).toBe(NO_ROOM);
      expect(result.stderr).toMatch(/a second tree needs \d+ KB/);
      expect(listing(root)).toBe(damaged);
      expect(shell('ls -A "$1"', copy)).not.toMatch(/swap/);
    });
  });
});
