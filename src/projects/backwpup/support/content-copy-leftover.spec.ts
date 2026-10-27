import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_COPY_DIR,
  CONTENT_COPY_EXTRACTED,
  CONTENT_COPY_FILE,
  CONTENT_COPY_PARTIAL,
  CONTENT_COPY_RESTORED,
  CONTENT_COPY_STAMP,
  CONTENT_COPY_DB_DEFAULTS,
  CONTENT_COPY_TOKEN,
  IN_USE_SCRIPT,
  LEGACY_COPY_FILE,
  RECOVERING_PREFIX,
  copyArgv,
  parseBootId,
  parseInUse,
  putBackArgv,
} from "./content-copy";
import {
  LEFTOVER_FIXTURE_OPTIONS,
  assertNoContentCopyLeft,
  judgeLeftover,
} from "./content-copy-leftover";
import { SETTLE_LEFTOVERS_ALLOWANCE_MS } from "../../../common/setup/preflight";
import { BOOT, OLD_BOOT, copyHost } from "./__fixtures__/copy-host";
import type { CopyHost } from "./__fixtures__/copy-host";

/**
 * A copy of `wp-content` an earlier run left, found before a run uses the site: refused, or settled
 * once provably orphaned — stamped by another boot, used by no process.
 *
 * The decisions are pure and pinned first, and the in-use probe runs under the real `sh` against a
 * fake proc tree. The flow then runs on a stubbed host (`./__fixtures__/copy-host.ts`).
 */

/** A claimed copy's directory name, as the settling makes it. */
const CLAIMED = new RegExp(
  `^${RECOVERING_PREFIX.replace(/[.]/g, "\\.")}[0-9a-f]{12}$`,
);

test.describe("parseBootId", () => {
  test("reads a UUID, its newline and case aside", () => {
    expect(parseBootId(`${BOOT.toUpperCase()}\n`)).toBe(BOOT);
  });

  test("knows nothing from anything else", () => {
    for (const text of [
      undefined,
      "",
      "1111",
      `${BOOT} ${OLD_BOOT}`,
      `x${BOOT}`,
      BOOT.replace(/-/g, ""),
      // Each group one digit short.
      "1111111-1111-4111-8111-111111111111",
      "11111111-111-4111-8111-111111111111",
      "11111111-1111-411-8111-111111111111",
      "11111111-1111-4111-811-111111111111",
      "11111111-1111-4111-8111-11111111111",
      "11111111-1111-4111-8111-1111111111111",
    ]) {
      expect(parseBootId(text), String(text)).toBeUndefined();
    }
  });
});

test.describe("judgeLeftover", () => {
  const whole = [CONTENT_COPY_STAMP, CONTENT_COPY_FILE];
  const facts = {
    entries: whole,
    stamp: `${OLD_BOOT}\n`,
    bootId: `${BOOT}\n`,
  };

  test("a whole copy another boot stamped is put back", () => {
    expect(judgeLeftover(facts)).toEqual({ action: "put-back" });
  });

  // It protects nothing; a removal cut short (stamp gone first) must not leave the site refused.
  test("a copy holding none to put back is removed, whatever its stamp or the boot", () => {
    for (const held of [[], [CONTENT_COPY_PARTIAL], [CONTENT_COPY_RESTORED]]) {
      for (const stamped of [
        { entries: [CONTENT_COPY_STAMP, ...held] },
        { entries: [CONTENT_COPY_STAMP, ...held], stamp: BOOT },
        { entries: [...held], stamp: undefined },
        { entries: [CONTENT_COPY_STAMP, ...held], bootId: undefined },
      ]) {
        expect(
          judgeLeftover({ ...facts, ...stamped }),
          JSON.stringify(stamped),
        ).toEqual({ action: "discard" });
      }
    }
  });

  for (const [what, changed, why] of [
    ["contents unreadable", { entries: undefined }, /could not be read/],
    [
      "unknown contents",
      { entries: [CONTENT_COPY_STAMP, LEGACY_COPY_FILE] },
      /holds what no copy does/,
    ],
    [
      "no stamp",
      { entries: [CONTENT_COPY_FILE], stamp: undefined },
      /no boot stamp/,
    ],
    ["an unreadable stamp", { stamp: undefined }, /stamp is unreadable/],
    ["a garbled stamp", { stamp: "x" }, /stamp is unreadable/],
    ["no boot id", { bootId: undefined }, /boot id could not be read/],
    [
      "this boot's stamp",
      { stamp: BOOT.toUpperCase() },
      /used since the host last booted/,
    ],
  ] as const) {
    test(`refuses ${what}`, () => {
      const verdict = judgeLeftover({ ...facts, ...changed });
      expect(verdict.action).toBe("refuse");
      expect(verdict.action === "refuse" ? verdict.why : "").toMatch(why);
    });
  }
});

test.describe("parseInUse", () => {
  test("one line per process; none when it printed nothing", () => {
    expect(parseInUse({ exitCode: 0, stdout: "1 a\n2 b\n" })).toEqual([
      "1 a",
      "2 b",
    ]);
    expect(parseInUse({ exitCode: 0, stdout: "" })).toEqual([]);
  });

  test("unknown when the probe did not run", () => {
    expect(parseInUse({ exitCode: 2, stdout: "" })).toBeUndefined();
  });
});

test.describe("IN_USE_SCRIPT", () => {
  let base: string;
  let root: string;
  let other: string;
  let proc: string;

  /** A fake process: its argv, and where it works. */
  function process_(pid: string, argv: readonly string[], cwd?: string): void {
    mkdirSync(join(proc, pid));
    if (argv.length > 0) {
      writeFileSync(join(proc, pid, "cmdline"), `${argv.join("\0")}\0`);
    }
    if (cwd !== undefined) symlinkSync(cwd, join(proc, pid, "cwd"));
  }

  /** Runs the probe for `root`, as root would. */
  const probe = (forRoot = root): string =>
    execFileSync(
      "sh",
      [
        "-c",
        IN_USE_SCRIPT,
        "sh",
        join(forRoot, CONTENT_COPY_DIR),
        forRoot,
        proc,
      ],
      { encoding: "utf8" },
    );

  test.beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "bwp-inuse-")));
    root = join(base, "site");
    other = join(base, "site2");
    proc = join(base, "proc");
    for (const dir of [root, join(root, "wp-content"), other, proc]) {
      mkdirSync(dir);
    }
  });
  test.afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("finds nothing on an idle host", () => {
    process_("1", ["/sbin/init"], "/");
    process_("self", ["sh"]);
    expect(probe()).toBe("");
  });

  // A recovery's root script names the copy; so does an older suite's tar.
  test("finds a process whose argv names this site's copy, or a claimed one", () => {
    process_("10", [
      "tar",
      "-xpf",
      join(root, `${CONTENT_COPY_DIR}.recovering-ab`, CONTENT_COPY_FILE),
    ]);
    process_("11", [
      "sh",
      "-c",
      "…",
      "sh",
      "use",
      join(root, CONTENT_COPY_DIR),
    ]);
    // The pid and the program only: an argv may carry what no message should.
    expect(probe()).toBe("10 tar\n11 sh\n");
  });

  // What the code runs: `tar` exec'd inside the copy's directory by the in-copy script, its archive
  // relative — and under `docker exec`, with no `sudo` parent naming the directory.
  test("finds a process working in this site's copy or a claimed one, its argv relative", () => {
    for (const dir of [CONTENT_COPY_DIR, `${CONTENT_COPY_DIR}.recovering-ab`]) {
      mkdirSync(join(root, dir));
    }
    process_(
      "12",
      ["tar", ...putBackArgv(CONTENT_COPY_FILE, root)],
      join(root, CONTENT_COPY_DIR),
    );
    process_(
      "13",
      ["tar", ...copyArgv(CONTENT_COPY_PARTIAL, root, [])],
      join(root, `${CONTENT_COPY_DIR}.recovering-ab`),
    );
    mkdirSync(join(root, CONTENT_COPY_DIR, "sub"));
    process_("15", ["sh"], join(root, CONTENT_COPY_DIR, "sub"));
    process_("14", ["sleep", "9"], join(root, `${CONTENT_COPY_DIR}x`));
    expect(probe()).toBe("12 tar\n13 tar\n15 sh\n");
  });

  test("finds a restore working in this site's root or below", () => {
    process_(
      "20",
      ["php", "/usr/local/bin/wp", "backwpup", "restore", "/a.tar"],
      root,
    );
    process_(
      "21",
      ["wp", "backwpup", "backup-restore"],
      join(root, "wp-content"),
    );
    expect(probe()).toBe("20 php\n21 wp\n");
  });

  // AutoE2E runs free and pro sites side by side on one server.
  test("never finds another site's copy or restore", () => {
    process_("30", [
      "tar",
      "-xpf",
      join(other, CONTENT_COPY_DIR, CONTENT_COPY_FILE),
    ]);
    process_("31", ["wp", "backwpup", "restore"], other);
    process_("32", ["wp", "backwpup", "restore"], `${root}2`);
    process_("33", ["wp", "backwpup", "restore"]);
    process_("34", []);
    mkdirSync(join(other, CONTENT_COPY_DIR));
    process_(
      "35",
      ["tar", "-tf", CONTENT_COPY_FILE],
      join(other, CONTENT_COPY_DIR),
    );
    expect(probe()).toBe("");
  });

  test("skips its own processes, which carry its marker", () => {
    process_("40", [
      "sh",
      "-c",
      IN_USE_SCRIPT,
      "sh",
      join(root, CONTENT_COPY_DIR),
    ]);
    expect(probe()).toBe("");
  });

  test("fails, rather than finding nothing, when the root cannot be resolved", () => {
    expect(() => probe(join(base, "missing"))).toThrow();
  });
});

test.describe("the contentCopyLeftover fixture", () => {
  // A put-back rewrites the whole content directory, far past a scenario's default 30 s.
  test("runs automatically, once per worker, bounded by the settling allowance", () => {
    expect(LEFTOVER_FIXTURE_OPTIONS).toEqual({
      scope: "worker",
      auto: true,
      box: true,
      timeout: SETTLE_LEFTOVERS_ALLOWANCE_MS,
    });
    expect(SETTLE_LEFTOVERS_ALLOWANCE_MS).toBeGreaterThanOrEqual(10 * 60_000);
  });
});

test.describe("assertNoContentCopyLeft", () => {
  let host: CopyHost;
  let warnings: string[];
  let warn: typeof console.warn;
  const site = (
    transport: Partial<CopyHost["transport"]> = {},
  ): { baseURL: string; transport: CopyHost["transport"] } => ({
    baseURL: "https://bwp.test",
    transport: { ...host.transport, ...transport },
  });
  const leftovers = (): string[] =>
    readdirSync(host.root).filter((name) => name.startsWith(CONTENT_COPY_DIR));
  const ran = (pattern: RegExp): string[] =>
    host.log().filter((line) => pattern.test(line));
  const claims = (): string[] => ran(/^sudo -n -- mv -T/);

  /**
   * Leaves a copy's directory holding `files`, stamped by `stamp` (none when `null`).
   *
   * @returns its path.
   */
  function leave(
    files: readonly string[],
    stamp: string | null = OLD_BOOT,
    name = CONTENT_COPY_DIR,
  ): string {
    const path = join(host.root, name);
    mkdirSync(path);
    for (const file of files) writeFileSync(join(path, file), "tar");
    if (stamp !== null) {
      writeFileSync(join(path, CONTENT_COPY_STAMP), `${stamp}\n`);
    }
    return path;
  }

  test.beforeEach(() => {
    host = copyHost();
    warnings = [];
    warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
  });
  test.afterEach(() => {
    console.warn = warn;
    host.dispose();
  });

  test("passes a site holding no copy, without a root command", async () => {
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(ran(/^(sudo|cat)/)).toEqual([]);
  });

  test("skips a placeholder site and a project without one", async () => {
    leave([CONTENT_COPY_FILE]);
    await expect(
      assertNoContentCopyLeft({ ...site(), baseURL: "https://x.example.test" }),
    ).resolves.toBeUndefined();
    await expect(assertNoContentCopyLeft(undefined)).resolves.toBeUndefined();
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  // Its scenarios then fail in their own words. A sites file's address may carry credentials.
  test("warns, without refusing, about a site it cannot ask, its address masked", async () => {
    await expect(
      assertNoContentCopyLeft({
        baseURL: "https://admin:pw@bwp.test",
        transport: { ...host.transport, rootDir: join(host.root, "missing") },
      }),
    ).resolves.toBeUndefined();
    expect(warnings.join("\n")).toMatch(
      /could not check https:\/\/\*\*\*@bwp\.test for/,
    );
    expect(warnings.join("\n")).not.toContain("pw");
  });

  // A run may still be using it: in its restore, or in its teardown before the put-back.
  test("refuses a copy this boot stamped, naming its archive, touching nothing", async () => {
    leave([CONTENT_COPY_FILE], BOOT);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      new RegExp(
        `still in .*sudo tar -xpf \\S+/${CONTENT_COPY_FILE.replace(/[.]/g, "\\.")} .*refuse this site until it is gone\\. Left: it was used since the host last booted`,
        "s",
      ),
    );
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
    expect(claims()).toEqual([]);
  });

  // Read-only inspection: the operator's way back still names the copy where it is.
  test("refuses a copy an older suite took, naming its own archive where it is", async () => {
    leave([LEGACY_COPY_FILE], null);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      new RegExp(
        `sudo tar -xpf ${join(host.root, CONTENT_COPY_DIR, LEGACY_COPY_FILE).replace(/[.]/g, "\\.")} .*Left: it holds what no copy does`,
        "s",
      ),
    );
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
    expect(claims()).toEqual([]);
  });

  for (const [what, files, stamp, env, why] of [
    ["no stamp", [CONTENT_COPY_FILE], null, {}, /no boot stamp/],
    [
      "an unreadable stamp",
      [CONTENT_COPY_FILE],
      OLD_BOOT,
      { H_STAMP_EXIT: "1" },
      /stamp is unreadable/,
    ],
    [
      "an unreadable boot id",
      [CONTENT_COPY_FILE],
      OLD_BOOT,
      { H_BOOT_EXIT: "1" },
      /boot id could not be read/,
    ],
    [
      "unreadable contents",
      [CONTENT_COPY_FILE],
      OLD_BOOT,
      { H_LS_EXIT: "2" },
      /what it holds could not be read/,
    ],
    [
      "both a whole and a partial copy",
      [CONTENT_COPY_FILE, CONTENT_COPY_PARTIAL],
      OLD_BOOT,
      {},
      /holds what no copy does/,
    ],
    [
      "a process using it",
      [CONTENT_COPY_FILE],
      OLD_BOOT,
      { H_INUSE: "4242 tar\n" },
      /a process still uses it \(1; first: 4242 tar\)/,
    ],
    [
      "no way to tell whether a process uses it",
      [CONTENT_COPY_FILE],
      OLD_BOOT,
      { H_INUSE: "", H_INUSE_EXIT: "2" },
      /could not be checked/,
    ],
  ] as const) {
    test(`refuses a copy with ${what}, unclaimed and whole`, async () => {
      Object.assign(process.env, env);
      leave(files, stamp);
      await expect(assertNoContentCopyLeft(site())).rejects.toThrow(why);
      expect(claims()).toEqual([]);
      expect(ran(/^(rm |tar -xpf)/)).toEqual([]);
      expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
    });
  }

  test("refuses an orphaned copy on a host that cannot elevate", async () => {
    leave([CONTENT_COPY_FILE]);
    await expect(
      assertNoContentCopyLeft(site({ elevate: false })),
    ).rejects.toThrow(/cannot elevate/);
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  test("puts an orphaned whole copy back from its claimed, stamped name, then removes it", async () => {
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    const [claim] = claims();
    const claimed = /-T -- \S+ (\S+)$/.exec(claim ?? "")?.[1] ?? "";
    expect(claim).toBe(
      `sudo -n -- mv -T -- ${join(host.root, CONTENT_COPY_DIR)} ${claimed}`,
    );
    expect(claimed.split("/").at(-1)).toMatch(CLAIMED);
    // Probed before and after the claim; stamped after it, and again by the put-back itself.
    expect(ran(/e2e-content-copy-in-use-probe/)).toHaveLength(2);
    expect(ran(/^(cp |tar -tf|tar -xpf)/)).toEqual([
      `cp -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
      `tar -tf ${CONTENT_COPY_FILE}`,
      `cp -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
      `tar -xpf ${CONTENT_COPY_FILE} --recursive-unlink -C ${host.root}`,
    ]);
    expect(leftovers()).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /put back a copy of wp-content an earlier boot of the host orphaned, then removed it/,
    );
  });

  // A removal cut short, stamp gone first, would otherwise leave the site refused for good.
  for (const [what, files, stamp] of [
    ["only a partial copy", [CONTENT_COPY_PARTIAL], OLD_BOOT],
    ["a copy already put back", [CONTENT_COPY_RESTORED], OLD_BOOT],
    [
      "a whole copy marked back beside it, stamped this boot",
      [CONTENT_COPY_FILE, CONTENT_COPY_EXTRACTED],
      BOOT,
    ],
    ["nothing", [], OLD_BOOT],
    ["nothing, stamped this boot", [CONTENT_COPY_TOKEN], BOOT],
    ["nothing, not even a stamp", [], null],
    ["a partial copy, stamped this boot", [CONTENT_COPY_PARTIAL], BOOT],
  ] as const) {
    test(`removes a copy no process uses holding ${what}, putting nothing back`, async () => {
      leave(files, stamp);
      await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
      expect(ran(/^tar -xpf/)).toEqual([]);
      expect(leftovers()).toEqual([]);
      expect(warnings.join("\n")).toMatch(
        /held none to put back .*left as it is and the copy removed/,
      );
    });
  }

  // A live run's copy being taken: it is the process that keeps it.
  test("refuses a copy holding none to put back while a process uses it", async () => {
    process.env.H_INUSE = "77 tar\n";
    leave([CONTENT_COPY_PARTIAL], BOOT);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /holds no copy to put back .*Left: a process still uses it \(1; first: 77 tar\)/s,
    );
    expect(claims()).toEqual([]);
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  /** The database's defaults a restore reaching the database saved beside its copy. */
  const DEFAULTS = { charset: "utf8mb4", collation: "utf8mb4_general_ci" };

  /** A stand-in for setting the database's defaults back, recording what it was asked. */
  const recorder = (
    fail?: string,
  ): {
    readonly asked: unknown[];
    readonly set: (_t: unknown, d: unknown) => Promise<void>;
  } => {
    const asked: unknown[] = [];
    return {
      asked,
      set: (_transport, defaults) => {
        asked.push(defaults);
        return fail === undefined
          ? Promise.resolve()
          : Promise.reject(new Error(fail));
      },
    };
  };

  // A killed restore that reached the database left its collation changed, and maybe half a dump.
  test("sets the database's defaults back after putting back a copy whose restore reached it", async () => {
    const path = leave([CONTENT_COPY_FILE]);
    writeFileSync(
      join(path, CONTENT_COPY_DB_DEFAULTS),
      JSON.stringify(DEFAULTS),
    );
    const db = recorder();
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(db.asked).toEqual([DEFAULTS]);
    expect(ran(/^tar -xpf/)).toHaveLength(1);
    expect(warnings.join("\n")).toMatch(
      /put back a copy .*Its restore reached the database too, which may be partly restored — check it; its default character set and collation were set back to utf8mb4 \/ utf8mb4_general_ci\./s,
    );
  });

  test("says so when the database's defaults could not be set back", async () => {
    const path = leave([CONTENT_COPY_FILE]);
    writeFileSync(
      join(path, CONTENT_COPY_DB_DEFAULTS),
      JSON.stringify(DEFAULTS),
    );
    const db = recorder("WordPress did not boot");
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(warnings.join("\n")).toMatch(
      /may be partly restored .*could not be set back to utf8mb4 \/ utf8mb4_general_ci: WordPress did not boot/s,
    );
    expect(leftovers()).toEqual([]);
  });

  test("says so when the saved defaults cannot be read, setting nothing", async () => {
    const path = leave([CONTENT_COPY_FILE]);
    writeFileSync(join(path, CONTENT_COPY_DB_DEFAULTS), '{"charset":"x;DROP"}');
    const db = recorder();
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(db.asked).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /may be partly restored .*could not be read back from the copy \(.*unexpected answer/s,
    );
  });

  test("trusts no saved defaults it could not read whole, setting nothing", async () => {
    process.env.H_DEFAULTS_EXIT = "1";
    const path = leave([CONTENT_COPY_FILE]);
    writeFileSync(
      join(path, CONTENT_COPY_DB_DEFAULTS),
      JSON.stringify(DEFAULTS),
    );
    const db = recorder();
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(db.asked).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /could not be read back from the copy \(exit 1/,
    );
  });

  test("leaves the database alone after putting back a files-only copy", async () => {
    leave([CONTENT_COPY_FILE]);
    const db = recorder();
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(db.asked).toEqual([]);
    expect(warnings.join("\n")).not.toMatch(/database/);
  });

  // No restore ran from it, or it was put back after the defaults were.
  test("leaves the database alone when removing a copy holding none to put back", async () => {
    const path = leave([CONTENT_COPY_PARTIAL]);
    writeFileSync(
      join(path, CONTENT_COPY_DB_DEFAULTS),
      JSON.stringify(DEFAULTS),
    );
    const db = recorder();
    await expect(
      assertNoContentCopyLeft(site(), db.set),
    ).resolves.toBeUndefined();
    expect(db.asked).toEqual([]);
    expect(leftovers()).toEqual([]);
  });

  test("says so when an orphaned copy went back but its directory would not go", async () => {
    process.env.H_RMDIR_EXIT = "1";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    const said = warnings.join("\n");
    expect(said).toMatch(/could not remove .*remove it by hand/);
    expect(said).toMatch(/orphaned \(/);
    expect(said).not.toMatch(/then removed it/);
  });

  test("says so when an orphaned copy holding none would not go", async () => {
    process.env.H_RMDIR_EXIT = "1";
    leave([CONTENT_COPY_PARTIAL]);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(warnings.join("\n")).toMatch(/left as it is\.$/m);
    expect(warnings.join("\n")).not.toMatch(/the copy removed/);
  });

  test("keeps, under its claimed name, an orphaned whole copy that does not read back", async () => {
    process.env.H_LIST_EXIT = "2";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in .*recovering-.*Left: it does not read back \(exit 2: tar: Unexpected EOF.*not put back/s,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
    expect(leftovers()).toEqual([expect.stringMatching(CLAIMED)]);
  });

  // The copy is then the only way back, so it stays — with the way back spelled out.
  test("keeps an orphaned copy that will not go back, and says how to put it back", async () => {
    process.env.H_PUT_EXIT = "2";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /could not put wp-content back \(exit 2.*sudo tar -xpf \S+recovering-[0-9a-f]+\/wp-content\.verified\.tar --recursive-unlink/s,
    );
    const [kept = ""] = leftovers();
    expect(kept).toMatch(CLAIMED);
    expect(readdirSync(join(host.root, kept)).sort()).toEqual([
      CONTENT_COPY_STAMP,
      CONTENT_COPY_FILE,
    ]);
  });

  // A recovery a second reboot cut off.
  test("settles an orphaned claimed copy the same way", async () => {
    leave([CONTENT_COPY_FILE], OLD_BOOT, `${RECOVERING_PREFIX}0123456789ab`);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(ran(/^tar -xpf/)).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  // Claimed in this boot: a recovery in flight, or one stopped without a reboot.
  test("refuses a claimed copy this boot stamped", async () => {
    leave([CONTENT_COPY_FILE], BOOT, `${RECOVERING_PREFIX}0123456789ab`);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in .*recovering-0123456789ab/,
    );
    expect(claims()).toEqual([]);
  });

  test("refuses two copies: which holds the site as it was is unknown", async () => {
    leave([CONTENT_COPY_FILE]);
    leave([CONTENT_COPY_FILE], OLD_BOOT, `${RECOVERING_PREFIX}0123456789ab`);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /2 copies of wp-content are in .*which one holds the site as it was is unknown/s,
    );
    expect(claims()).toEqual([]);
  });

  test("refuses a copy directory that is a link, before root acts in it", async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), "bwp-left-out-"));
    try {
      symlinkSync(elsewhere, join(host.root, CONTENT_COPY_DIR));
      await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
        /refusing to settle .* as root — .*(is a symbolic link|outside it)/s,
      );
      // Only the elevation probe ran as root.
      expect(ran(/^(sudo|ls )/)).toEqual(["sudo -n true"]);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  // Root would otherwise extract the copy through the link, wherever it leads.
  test("refuses an orphaned copy while wp-content is a link", async () => {
    leave([CONTENT_COPY_FILE]);
    rmSync(join(host.root, "wp-content"), { recursive: true });
    mkdirSync(join(host.root, "real-content"));
    symlinkSync(join(host.root, "real-content"), join(host.root, "wp-content"));
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /refusing to settle .*wp-content" is a symbolic link/s,
    );
    expect(claims()).toEqual([]);
  });

  test("refuses a claimed copy swapped for a link before root acts in it", async () => {
    process.env.H_MV = "swap";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in .*recovering-.*Left: what it holds could not be read/s,
    );
    expect(ran(/^(tar |rm |cp )/)).toEqual([]);
  });

  test("refuses a claimed copy that changed between the look and the claim", async () => {
    process.env.H_MV = "shrink";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /Left: it changed while it was claimed/,
    );
    expect(ran(/^(tar -xpf|rm )/)).toEqual([]);
  });

  // A use that began between the look and the claim — a reconnecting runner's put-back.
  test("refuses a claimed copy a process began to use meanwhile", async () => {
    process.env.H_INUSE = "77 tar -xpf x\n";
    process.env.H_INUSE_FROM = "2";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /recovering-.*Left: a process still uses it/s,
    );
    expect(ran(/^(cp |tar |rm )/)).toEqual([]);
    expect(leftovers()).toEqual([expect.stringMatching(CLAIMED)]);
  });

  test("refuses a claimed copy it cannot stamp, putting nothing back", async () => {
    process.env.H_CP_EXIT = "1";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /Left: it could not be stamped \(exit 1/,
    );
    expect(ran(/^tar -xpf/)).toEqual([]);
  });

  // The winner's claim stamped the copy, so the loser's second look finds it in use.
  test("losing the claim to another run looks again, and refuses the copy that run holds", async () => {
    process.env.H_MV = "race";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in .*recovering-w.*used since the host last booted/s,
    );
    expect(claims()).toHaveLength(1);
    expect(ran(/^tar /)).toEqual([]);
  });

  test("losing the claim to a run that already settled it passes", async () => {
    process.env.H_MV = "gone";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(ran(/^tar /)).toEqual([]);
  });

  test("refuses after losing the claim on every look", async () => {
    process.env.H_MV = "race-old";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /another run claimed the copy .* each time this one tried to settle it \(2 times\)/s,
    );
    expect(claims()).toHaveLength(2);
  });

  test("refuses a copy it could not claim, leaving it where it is", async () => {
    process.env.H_MV = "fail";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /refusing to settle .* it could not be claimed \(mv exited 1: mv: cannot move.*still in/s,
    );
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
    expect(
      existsSync(join(host.root, CONTENT_COPY_DIR, CONTENT_COPY_FILE)),
    ).toBe(true);
  });
});
