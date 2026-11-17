import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";

import {
  heldFiles,
  mayHoldForRoot,
  mergeRootPutBack,
  PUT_BACK_EXIT,
  PUT_BACK_SCRIPT,
  PUT_BACK_TIMEOUT_S,
  putBackArgv,
  putBackHeld,
  readPutBack,
  resolvesInPlace,
  rootMayFinish,
} from "./config-edits-root";
import { sshTwinsEnabled } from "../__fixtures__/ssh-twins";
import type { RootPutBack } from "./config-edits-root";
import type {
  ConfigEditOutcome,
  HeldPutBack,
} from "./config-edits-declaration";
import type { IdentityState } from "./site-identity";
import type {
  ConfigEdits,
  DockerTransport,
  LocalTransport,
  SshTransport,
} from "../config/types";

/**
 * The root fallback's pure parts on any platform; {@link PUT_BACK_SCRIPT} itself where GNU
 * coreutils and `/dev/fd` are: Linux (CI), or inside the nginx twin (`E2E_SSH_TWINS=1`), as root.
 */

const STEM = "/tmp/e2e-record-0123456789abcdef";

/** A held file: its bytes to write back. */
const HELD: HeldPutBack = {
  dir: `${STEM}-33`,
  copy: "file-0",
  uid: 33,
  dev: "64768",
  ino: "1234",
  sha256: "a".repeat(64),
  judged: "c".repeat(64),
  mode: 0o644,
  write: true,
  resumed: false,
};

const EDITS: ConfigEdits = {
  files: [
    {
      path: "wp-config.php",
      operations: [
        { name: "op", steps: [{ pattern: "/a/", replacement: "b", limit: 1 }] },
      ],
    },
    {
      path: ".htaccess",
      operations: [
        { name: "op", steps: [{ pattern: "/a/", replacement: "b", limit: 1 }] },
      ],
    },
  ],
};

const SSH: SshTransport = {
  mode: "ssh",
  host: "h",
  username: "u",
  privateKeyPath: "/k",
  rootDir: "/var/www/a",
};

const SITE: IdentityState = {
  kind: "site",
  target: { user: "www-data", group: "www-data" },
  identity: { user: "www-data", uid: 33, group: "www-data", gid: 33 },
  umask: "0022",
} as unknown as IdentityState;

test.describe("whether root may finish", () => {
  test("never with elevate: false, never in site; in every other state", () => {
    for (const state of [
      { kind: "same-user", reason: "mode" },
      { kind: "fallback", reason: "no-sudo", detail: "x" },
      { kind: "disabled", reason: "config" },
    ] as IdentityState[]) {
      expect(rootMayFinish(SSH, state), state.kind).toBe(true);
      expect(rootMayFinish({ ...SSH, elevate: false }, state), state.kind).toBe(
        false,
      );
    }
    expect(rootMayFinish(SSH, SITE)).toBe(false);
  });

  test("asks nothing of a site that refuses elevation; a local site runs as its user", async () => {
    const local: LocalTransport = { mode: "local", rootDir: "/var/www/a" };
    expect(await mayHoldForRoot({ ...local, elevate: false })).toBe(false);
    expect(await mayHoldForRoot(local)).toBe(true);
  });

  test("with elevate: false nothing runs as root: the engine's next answer stands", async () => {
    const local: LocalTransport = {
      mode: "local",
      rootDir: "/var/www/a",
      elevate: false,
    };
    expect(
      await putBackHeld(local, STEM, EDITS, [
        { kind: "file", index: 0, result: "unwritable", held: HELD },
      ]),
    ).toBeUndefined();
    // Nothing held: nothing asked.
    expect(await putBackHeld(local, STEM, EDITS, [])).toEqual(new Map());
  });

  test("a root no elevated command may act in is a failure answered, never thrown: nothing runs", async () => {
    // Docker elevates without a probe; the root is refused before any command.
    const docker: DockerTransport = {
      mode: "docker",
      container: "no-such-container",
      rootDir: "/a",
    };
    const answered = await putBackHeld(docker, STEM, EDITS, [
      { kind: "file", index: 0, result: "unwritable", held: HELD },
    ]);
    expect(answered?.get(0)).toMatchObject({
      kind: "failed",
      reason: expect.stringMatching(/^the WordPress root /),
    });
  });
});

test.describe("heldFiles", () => {
  test("takes each held file's path from the declaration", () => {
    expect(
      heldFiles(STEM, EDITS, [
        { kind: "file", index: 0, result: "restored" },
        { kind: "file", index: 1, result: "unwritable", held: HELD },
        { kind: "dir", index: 0, result: "removed" },
      ]),
    ).toEqual([{ index: 1, path: ".htaccess", held: HELD }]);
  });

  for (const [what, held] of [
    [
      "another stem's record",
      { ...HELD, dir: "/tmp/e2e-record-ffffffffffffffff-33" },
    ],
    ["another uid's record", { ...HELD, uid: 34 }],
  ] as const) {
    test(`refuses ${what}: nothing runs as root`, () => {
      expect(() =>
        heldFiles(STEM, EDITS, [
          { kind: "file", index: 0, result: "unwritable", held },
        ]),
      ).toThrow(
        /held "wp-config.php" for root with a record that is not this run's/,
      );
    });
  }

  test("refuses an index the declaration lacks", () => {
    expect(() =>
      heldFiles(STEM, EDITS, [
        { kind: "file", index: 5, result: "unwritable", held: HELD },
      ]),
    ).toThrow(/not this run's/);
  });
});

test.describe("resolvesInPlace", () => {
  test("only a file resolving exactly to its declared place in the resolved root", () => {
    expect(
      resolvesInPlace("/srv/a", "/srv/a/wp-config.php", "wp-config.php"),
    ).toBe(true);
    expect(resolvesInPlace("/srv/a", "/srv/a/sub/f", "sub/f")).toBe(true);
    // A link in a parent, even one staying inside the root; one leading out; nothing resolved.
    expect(resolvesInPlace("/srv/a", "/srv/a/other/f", "sub/f")).toBe(false);
    expect(resolvesInPlace("/srv/a", "/root/x/f", "sub/f")).toBe(false);
    expect(resolvesInPlace("/srv/a", "/srv/a/real.php", "wp-config.php")).toBe(
      false,
    );
    expect(resolvesInPlace(undefined, "/srv/a/f", "f")).toBe(false);
    expect(resolvesInPlace("/srv/a", undefined, "f")).toBe(false);
  });
});

test.describe("putBackArgv and readPutBack", () => {
  test("every value is an argument after the fixed script, under a time limit", () => {
    expect(putBackArgv("/var/www/a/wp-config.php", HELD)).toEqual([
      "--preserve-status",
      "-s",
      "TERM",
      String(PUT_BACK_TIMEOUT_S),
      "sh",
      "-c",
      PUT_BACK_SCRIPT,
      "e2e-config-put-back",
      "/var/www/a/wp-config.php",
      HELD.dir,
      "file-0",
      "33",
      "64768",
      "1234",
      HELD.sha256,
      "0644",
      "write",
      HELD.judged,
    ]);
    expect(
      putBackArgv("/t", { ...HELD, mode: 0o4755, write: false }).slice(-3),
    ).toEqual(["04755", "mode", HELD.judged]);
  });

  test("reads the modes before and after; a refusal or a replaced path as such", () => {
    const run = (exitCode: number, stdout = "", stderr = "") =>
      readPutBack({ exitCode, stdout, stderr }, "wp-config.php", HELD);
    expect(run(0, "664 644\n")).toEqual({
      kind: "done",
      found: 0o664,
      now: 0o644,
    });
    expect(run(0, "4755 4755")).toEqual({
      kind: "done",
      found: 0o4755,
      now: 0o4755,
    });
    // `stat %a` drops leading zeros.
    expect(run(0, "40 644")).toEqual({ kind: "done", found: 0o40, now: 0o644 });
    expect(run(0, "440 4")).toEqual({ kind: "done", found: 0o440, now: 0o4 });
    expect(run(PUT_BACK_EXIT.replaced)).toEqual({ kind: "replaced" });
    expect(run(PUT_BACK_EXIT.moved)).toEqual({ kind: "moved" });
    expect(run(PUT_BACK_EXIT.copyRefused)).toEqual({ kind: "refused" });
  });

  test("a failure before any write is an answer, so a host that always fails it never sticks the site", () => {
    const run = (exitCode: number, stdout = "", stderr = "") =>
      readPutBack({ exitCode, stdout, stderr }, "wp-config.php", HELD);
    for (const [exitCode, stderr] of [
      [1, "sudo: a password is required"],
      [1, "sudo: timeout: command not found"],
      [PUT_BACK_EXIT.noStaging, ""],
      [PUT_BACK_EXIT.noTools, ""],
      [125, "timeout: unrecognized option '--preserve-status'"],
      [126, ""],
      [127, ""],
      [143, ""],
    ] as const) {
      expect(run(exitCode, "", stderr), String(exitCode)).toEqual({
        kind: "failed",
        reason: `exit ${String(exitCode)}: ${stderr || "no output"}`,
      });
    }
    // Exit 0 follows the verified write: an answer it cannot read loses nothing.
    expect(run(0, "644")).toEqual({
      kind: "failed",
      reason: "unreadable answer: 644",
    });
  });

  test("a put-back cut short, or an exit not known to precede the write, fails naming the kept record", () => {
    const run =
      (exitCode: number, stdout = "", stderr = "") =>
      () =>
        readPutBack({ exitCode, stdout, stderr }, "wp-config.php", HELD);
    expect(run(PUT_BACK_EXIT.notPutBack)).toThrow(
      `putting "wp-config.php" back as root failed: it does not hold its recorded bytes, which are kept in ${HELD.dir}`,
    );
    expect(run(124)).toThrow(/\(exit 124: no output\); its record is kept in/);
    expect(run(255)).toThrow(/\(exit 255: no output\); its record is kept in/);
    expect(run(2, "", `\u001b[31m${"x".repeat(500)}`)).toThrow(
      /^\[wp\/config-edits\] putting "wp-config.php" back as root failed \(exit 2: x{200}\); its record/,
    );
  });
});

test.describe("mergeRootPutBack", () => {
  const unwritable: ConfigEditOutcome = {
    kind: "file",
    index: 0,
    result: "unwritable",
    held: HELD,
  };
  const modeOnly: ConfigEditOutcome = {
    kind: "file",
    index: 1,
    result: "restored",
    mode: { found: 0o664, recorded: 0o644, restored: false },
    owner: { found: "1:1", recorded: "2:2" },
    held: { ...HELD, write: false },
  };
  const others: ConfigEditOutcome[] = [
    { kind: "created-file", index: 0, result: "removed" },
  ];
  const merge = (
    root: ReadonlyMap<number, RootPutBack> | undefined,
    second: readonly ConfigEditOutcome[] = [],
    first: readonly ConfigEditOutcome[] = [unwritable, modeOnly, ...others],
  ) => mergeRootPutBack(first, root, second);
  const done = (found: number, now: number): RootPutBack => ({
    kind: "done",
    found,
    now,
  });

  test("root's work: the bytes restored or resumed, a mode set back; never a held field left", () => {
    const second: ConfigEditOutcome[] = [
      {
        kind: "file",
        index: 0,
        result: "unchanged",
        owner: { found: "3:3", recorded: "4:4" },
      },
      { kind: "file", index: 1, result: "unchanged" },
      { kind: "created-file", index: 0, result: "absent" },
    ];
    expect(
      merge(
        new Map([
          [0, done(0o664, 0o644)],
          [1, done(0o664, 0o644)],
        ]),
        second,
      ),
    ).toEqual([
      {
        kind: "file",
        index: 0,
        result: "restored",
        mode: { found: 0o664, recorded: 0o644, restored: true },
        owner: { found: "3:3", recorded: "4:4" },
        asRoot: "wrote",
      },
      {
        kind: "file",
        index: 1,
        result: "restored",
        mode: { found: 0o664, recorded: 0o644, restored: true },
        asRoot: "mode",
      },
      // The first answer stands for what was never held.
      { kind: "created-file", index: 0, result: "removed" },
    ]);
    // A mode already as recorded says nothing of it; a resumed file stays resumed; a chmod that did
    // not take is reported as not set back.
    expect(
      merge(
        new Map([
          [0, done(0o644, 0o644)],
          [1, done(0o664, 0o664)],
        ]),
        [],
        [{ ...unwritable, held: { ...HELD, resumed: true } }, modeOnly],
      ),
    ).toEqual([
      { kind: "file", index: 0, result: "resumed", asRoot: "wrote" },
      {
        kind: "file",
        index: 1,
        result: "restored",
        mode: { found: 0o664, recorded: 0o644, restored: false },
        owner: { found: "1:1", recorded: "2:2" },
        asRoot: "mode",
      },
    ]);
  });

  test("a file changed again after root: the second answer's verdict stands", () => {
    const changed: ConfigEditOutcome = {
      kind: "file",
      index: 0,
      result: "unrecognized",
    };
    expect(merge(new Map([[0, done(0o664, 0o644)]]), [changed])[0]).toEqual(
      changed,
    );
  });

  test("root not used: the second answer, else the first without its hold", () => {
    const second: ConfigEditOutcome[] = [
      { kind: "file", index: 0, result: "unwritable" },
    ];
    expect(merge(undefined, second).slice(0, 2)).toEqual([
      { kind: "file", index: 0, result: "unwritable" },
      {
        kind: "file",
        index: 1,
        result: "restored",
        mode: { found: 0o664, recorded: 0o644, restored: false },
        owner: { found: "1:1", recorded: "2:2" },
      },
    ]);
  });

  test("refused by root: the second answer, marked; replaced or leading outside: untouched", () => {
    const second: ConfigEditOutcome[] = [
      { kind: "file", index: 0, result: "unwritable" },
    ];
    expect(merge(new Map([[0, { kind: "refused" }]]), second)[0]).toEqual({
      kind: "file",
      index: 0,
      result: "unwritable",
      asRoot: "refused",
    });
    expect(
      merge(
        new Map([
          [0, { kind: "replaced" }],
          [1, { kind: "outside" }],
        ]),
      ).slice(0, 2),
    ).toEqual([
      { kind: "file", index: 0, result: "replaced" },
      {
        kind: "file",
        index: 1,
        result: "restored",
        mode: { found: 0o664, recorded: 0o644, restored: false },
        owner: { found: "1:1", recorded: "2:2" },
      },
    ]);
    expect(merge(new Map([[0, { kind: "outside" }]]))[0]).toEqual({
      kind: "file",
      index: 0,
      result: "link",
    });
  });

  test("written, then moved away from its path: moved, by root, whatever is there now", () => {
    expect(
      merge(new Map([[0, { kind: "moved" }]]), [
        { kind: "file", index: 0, result: "unrecognized" },
      ])[0],
    ).toEqual({ kind: "file", index: 0, result: "moved", asRoot: "wrote" });
  });

  test("root failed to run: the second answer's verdict, marked failed with root's reason", () => {
    const second: ConfigEditOutcome[] = [
      { kind: "file", index: 0, result: "unwritable" },
      {
        kind: "file",
        index: 1,
        result: "unchanged",
        mode: { found: 0o664, recorded: 0o644, restored: false },
      },
    ];
    const failed: RootPutBack = { kind: "failed", reason: "exit 1: no rule" };
    expect(
      merge(
        new Map([
          [0, failed],
          [1, failed],
        ]),
        second,
      ).slice(0, 2),
    ).toEqual([
      {
        kind: "file",
        index: 0,
        result: "unwritable",
        asRoot: "failed",
        rootError: "exit 1: no rule",
      },
      { ...second[1], asRoot: "failed", rootError: "exit 1: no rule" },
    ]);
  });
});

/** Where the script can run: Linux here, or inside the nginx twin as root. */
const GNU_HOST: "local" | "twin" | undefined =
  process.platform === "linux"
    ? "local"
    : sshTwinsEnabled()
      ? "twin"
      : undefined;

/** Where a shim finds the real programs (Ubuntu and the twins: coreutils in `/usr/bin`). */
const REAL_PATH =
  "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/**
 * Runs `argv` where the script can run.
 *
 * @param argv - the command.
 * @param shims - a folder of programs found before the real ones, if any.
 */
function onGnu(
  argv: readonly string[],
  shims?: string,
): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const path = shims === undefined ? undefined : `${shims}:${REAL_PATH}`;
  const [file, ...args] =
    GNU_HOST === "twin"
      ? [
          "docker",
          "exec",
          ...(path === undefined ? [] : ["-e", `PATH=${path}`]),
          "wpme-ssh-nginx",
          ...argv,
        ]
      : argv;
  const result = spawnSync(file ?? "", args, {
    encoding: "utf8",
    env: path === undefined ? process.env : { ...process.env, PATH: path },
  });
  return {
    exitCode: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/** Runs a shell line where the script can run; its stdout, trimmed; fails on a non-zero exit. */
function shell(line: string, ...args: string[]): string {
  const run = onGnu(["sh", "-c", line, "sh", ...args]);
  expect(run.exitCode, run.stderr).toBe(0);
  return run.stdout.trim();
}

/** One script case: a folder holding `rec/file-0` (the record) and `target`, and what was judged. */
interface Case {
  readonly base: string;
  readonly target: string;
  readonly held: HeldPutBack;
}

/**
 * Makes a case: the record `recorded\n` in a 0700 folder, the target `edited\n` at mode 664; then
 * `spoil` (a shell line run in the folder) changes what a test needs.
 *
 * @param spoil - run in the case's folder after the judged facts are read.
 * @param write - bytes and mode, or the mode alone (the target then already holds the record).
 */
function makeCase(spoil = ":", write = true): Case {
  // Not /tmp in the twin: resetting it empties /tmp.
  const parent = GNU_HOST === "twin" ? "/root" : tmpdir();
  const base = shell('mktemp -d -p "$1" e2e-put-back.XXXXXX', parent);
  const [uid, dev, ino, sha256, judged] = shell(
    'cd "$1" && umask 077 && mkdir rec && printf "recorded\\n" > rec/file-0 && ' +
      'if [ "$2" = write ]; then printf "edited\\n" > target; else cp rec/file-0 target; fi && ' +
      'chmod 664 target && echo "$(id -u) $(stat -c "%d %i" target) $(sha256sum < rec/file-0 | cut -c1-64)" ' +
      '"$(sha256sum < target | cut -c1-64)"',
    base,
    write ? "write" : "mode",
  ).split(" ");
  shell(`cd "$1" && ${spoil}`, base);
  return {
    base,
    target: `${base}/target`,
    held: {
      dir: `${base}/rec`,
      copy: "file-0",
      uid: Number(uid),
      dev: dev ?? "",
      ino: ino ?? "",
      sha256: sha256 ?? "",
      judged: judged ?? "",
      mode: 0o644,
      write,
      resumed: false,
    },
  };
}

/** How a test runs the script beyond {@link makeCase}'s defaults. */
interface RunOptions {
  /** Programs replacing real ones (name → shell body; `$B` is the case's folder). */
  readonly shims?: Readonly<Record<string, string>>;
  /** `timeout`'s limit, in seconds, instead of the fallback's. */
  readonly timeout?: number;
}

/** Runs the script on a case, as the fallback runs it. */
function putBack(
  c: Case,
  held: Partial<HeldPutBack> = {},
  options: RunOptions = {},
): RootPutBack {
  const argv = putBackArgv(c.target, { ...c.held, ...held });
  if (options.timeout !== undefined) argv[3] = String(options.timeout);
  let shims: string | undefined;
  if (options.shims !== undefined) {
    shims = `${c.base}/shims`;
    shell('mkdir -p -- "$1"', shims);
    for (const [name, body] of Object.entries(options.shims)) {
      shell(
        'printf "#!/bin/sh\\nB=%s\\n%s\\n" "$2" "$3" > "$1" && chmod 755 -- "$1"',
        `${shims}/${name}`,
        c.base,
        body,
      );
    }
  }
  return readPutBack(onGnu(["timeout", ...argv], shims), "target", {
    ...c.held,
    ...held,
  });
}

/** The real program `name`, for a shim to run. */
const real = (name: string): string => `PATH=${REAL_PATH} ${name}`;

/** A path's `device:inode mode type` and, a regular file, its bytes; or `absent`. */
function state(path: string): string {
  return shell(
    // Only a regular file is read: a FIFO's `cat` would block.
    'if [ -f "$1" ] && [ ! -h "$1" ]; then c=$(cat -- "$1"); else c=-; fi; ' +
      'if [ -e "$1" ] || [ -h "$1" ]; then echo "$(stat -c "%d:%i %a %F" -- "$1") $c"; else echo absent; fi',
    path,
  );
}

test.describe("PUT_BACK_SCRIPT", () => {
  test.skip(
    GNU_HOST === undefined,
    "needs GNU coreutils and /dev/fd: Linux, or E2E_SSH_TWINS=1 with the twins up",
  );

  const cases: Case[] = [];
  test.afterEach(() => {
    for (const c of cases.splice(0)) shell('rm -rf -- "$1"', c.base);
  });
  /** {@link makeCase}, removed after the test. */
  const caseOf = (spoil?: string, write?: boolean): Case => {
    const c = makeCase(spoil, write);
    cases.push(c);
    return c;
  };

  test("writes the record's bytes into the judged file in place, then its mode", () => {
    const c = caseOf();
    const inode = state(c.target).split(" ")[0];
    expect(putBack(c)).toEqual({ kind: "done", found: 0o664, now: 0o644 });
    expect(state(c.target)).toBe(`${String(inode)} 644 regular file recorded`);
  });

  test("the mode alone, on a file holding the record's bytes", () => {
    const c = caseOf(":", false);
    const inode = state(c.target).split(" ")[0];
    expect(putBack(c)).toEqual({ kind: "done", found: 0o664, now: 0o644 });
    expect(state(c.target)).toBe(`${String(inode)} 644 regular file recorded`);
  });

  test("a mode recorded with no leading digits is read back", () => {
    const c = caseOf();
    expect(putBack(c, { mode: 0o4 })).toEqual({
      kind: "done",
      found: 0o664,
      now: 0o4,
    });
  });

  test("refuses a file rewritten in place since it was judged (same inode): the new bytes kept", () => {
    const c = caseOf('printf "web server\\n" >> target');
    const before = state(c.target);
    expect(putBack(c)).toEqual({ kind: "replaced" });
    expect(state(c.target)).toBe(before);
  });

  test("reads the record copy it checked: a link swapped in after the check reaches nothing", () => {
    const c = caseOf('printf "secret\\n" > secret && chmod 600 secret');
    // Root's staging step runs once the copy is open: swap the copy for a link to a secret then.
    const swap = `rm -f "$B/rec/file-0"; ln -s "$B/secret" "$B/rec/file-0"; ${real("mktemp")} "$@"`;
    expect(putBack(c, {}, { shims: { mktemp: swap } })).toEqual({
      kind: "done",
      found: 0o664,
      now: 0o644,
    });
    expect(state(c.target)).toMatch(/ 644 regular file recorded$/);
  });

  test("written, then moved away from its path: moved, its bytes put back where it went", () => {
    const c = caseOf();
    // The write is the one `cat` given an argument; move the file right after it.
    const move = `if [ $# -gt 0 ]; then ${real("cat")} "$@"; r=$?; mv "$B/target" "$B/moved"; exit $r; fi; ${real("cat")}`;
    expect(putBack(c, {}, { shims: { cat: move } })).toEqual({ kind: "moved" });
    expect(state(c.target)).toBe("absent");
    expect(state(`${c.base}/moved`)).toMatch(/ regular file recorded$/);
  });

  test("moved away after it was opened, before the write: nothing written", () => {
    const c = caseOf();
    // The first hash of the opened target (the judged check) moves it away.
    const move =
      `if [ "$(${real("stat")} -L -c %i /dev/stdin)" = "${c.held.ino}" ] && [ ! -e "$B/done" ]; then ` +
      `touch "$B/done"; mv "$B/target" "$B/moved"; fi; ${real("sha256sum")} "$@"`;
    expect(putBack(c, {}, { shims: { sha256sum: move } })).toEqual({
      kind: "replaced",
    });
    expect(state(`${c.base}/moved`)).toMatch(/ 664 regular file edited$/);
  });

  for (const [what, shims, exitCode] of [
    ["without GNU stat", { stat: "exit 1" }, PUT_BACK_EXIT.noTools],
    ["unable to stage the copy", { mktemp: "exit 1" }, PUT_BACK_EXIT.noStaging],
  ] as const) {
    test(`${what}: a failure, nothing written`, () => {
      const c = caseOf();
      const before = state(c.target);
      expect(putBack(c, {}, { shims })).toEqual({
        kind: "failed",
        reason: `exit ${String(exitCode)}: no output`,
      });
      expect(state(c.target)).toBe(before);
    });
  }

  test("timed out before writing: a failure, nothing written", () => {
    const c = caseOf();
    const before = state(c.target);
    expect(
      putBack(c, {}, { shims: { mktemp: "exec sleep 10" }, timeout: 1 }),
    ).toEqual({ kind: "failed", reason: "exit 143: no output" });
    expect(state(c.target)).toBe(before);
  });

  test("timed out while writing: fails, the record kept to resume", () => {
    const c = caseOf();
    // A write that stalls after its first bytes.
    const stall = `if [ $# -gt 0 ]; then ${real("head")} -c 3 "$2"; sleep 10; fi; ${real("cat")}`;
    expect(() => putBack(c, {}, { shims: { cat: stall }, timeout: 1 })).toThrow(
      /does not hold its recorded bytes, which are kept in/,
    );
    expect(state(c.target)).toMatch(/ regular file rec$/);
  });

  test("the mode alone, refused on a file whose bytes changed since: untouched", () => {
    const c = caseOf('printf "changed\\n" > target', false);
    const before = state(c.target);
    expect(putBack(c)).toEqual({ kind: "replaced" });
    expect(state(c.target)).toBe(before);
  });

  for (const [what, spoil] of [
    [
      "a link at the path (to a file it may not touch)",
      'printf "keep\\n" > other && rm target && ln -s other target',
    ],
    ["another file at the path", 'printf "x\\n" > new && mv new target'],
    ["the judged file with a second link", "ln target second"],
    ["nothing at the path", "rm target"],
    ["a FIFO at the path (never opened)", "rm target && mkfifo target"],
  ] as const) {
    test(`refuses ${what}: nothing written`, () => {
      const c = caseOf(spoil);
      const before = [state(c.target), state(`${c.base}/other`)];
      expect(putBack(c)).toEqual({ kind: "replaced" });
      expect([state(c.target), state(`${c.base}/other`)]).toEqual(before);
    });
  }

  for (const [what, spoil, held] of [
    [
      "a record copy that is a link",
      "mv rec/file-0 rec/real && ln -s real rec/file-0",
      {},
    ],
    ["a record copy with a second link", "ln rec/file-0 second", {}],
    ["a record copy holding other bytes", ":", { sha256: "b".repeat(64) }],
    ["a record copy of another user", ":", { uid: 4242 }],
    ["a record folder open to others", "chmod 705 rec", {}],
    ["a record folder that is a link", "mv rec real && ln -s real rec", {}],
  ] as const) {
    test(`refuses ${what}: the file untouched`, () => {
      const c = caseOf(spoil);
      const before = state(c.target);
      expect(putBack(c, held)).toEqual({ kind: "refused" });
      expect(state(c.target)).toBe(before);
    });
  }
});
