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
  DEFAULT_LEASE,
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
import {
  CONTENT_COPY_LEASE,
  LEASE_TTL_S,
  parseLease,
} from "./content-copy-lease";
import { SETTLE_LEFTOVERS_ALLOWANCE_MS } from "../../../common/setup/preflight";
import { BOOT, OLD_BOOT, copyHost } from "./__fixtures__/copy-host";
import type { CopyHost } from "./__fixtures__/copy-host";

/**
 * A copy of `wp-content` an earlier run left, found before a run uses the site: refused, or settled
 * once provably orphaned — stamped by another boot, or this boot's with its lease lapsed or held by
 * the asking worker's own slot — and used by no process.
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
    expect(judgeLeftover(facts)).toEqual({
      action: "put-back",
      why: "an earlier boot of the host stamped its last use",
    });
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

test.describe("judgeLeftover — a whole copy this boot stamped", () => {
  const facts = {
    entries: [CONTENT_COPY_STAMP, CONTENT_COPY_LEASE, CONTENT_COPY_FILE],
    stamp: `${BOOT}\n`,
    bootId: `${BOOT}\n`,
    uptime: "1000.25 3999.50\n",
  };
  /** A lease renewed at `renewed`, expiring at `expires`, held by `holder`. */
  const lease = (renewed: number, expires: number, holder = "r#1"): string =>
    `v1 ${BOOT} ${String(renewed)} ${String(expires)} ${holder}\n`;
  const why = (verdict: ReturnType<typeof judgeLeftover>): string =>
    verdict.action === "discard" ? "" : verdict.why;

  // The incident: a put-back that failed left a whole copy stamped this boot; once its lease is
  // over, a later run settles it instead of refusing the site until the host reboots.
  test("is put back once its lease expired, saying how long ago", () => {
    const verdict = judgeLeftover({ ...facts, lease: lease(100, 1000) });
    expect(verdict.action).toBe("put-back");
    expect(why(verdict)).toBe("its lease expired 0 s ago");
    expect(why(judgeLeftover({ ...facts, lease: lease(100, 400) }))).toBe(
      "its lease expired 600 s ago",
    );
  });

  test("is refused while its lease runs, one second before it lapses included", () => {
    const verdict = judgeLeftover({ ...facts, lease: lease(990, 1001) });
    expect(verdict.action).toBe("refuse");
    expect(why(verdict)).toMatch(
      /run may still be using it: a run renewed its lease 10 s ago \(r#1\); it lapses in 1 s/,
    );
  });

  // Playwright never runs two workers in one slot at once: the one that held it is gone.
  test("is put back at once when the asking worker's own slot held it", () => {
    const verdict = judgeLeftover({ ...facts, lease: lease(990, 1900) }, "r#1");
    expect(verdict).toEqual({
      action: "put-back",
      why: "this run's worker that held it is gone",
    });
    expect(
      judgeLeftover({ ...facts, lease: lease(990, 1900) }, "r#2").action,
    ).toBe("refuse");
  });

  // The boot-time clock never goes back within a boot: the host restarted without a new boot id.
  test("is put back when the host's clock reads before the lease's renewal", () => {
    const verdict = judgeLeftover({ ...facts, lease: lease(5000, 5900) });
    expect(verdict.action).toBe("put-back");
    expect(why(verdict)).toMatch(/clock reads before the lease's last renewal/);
  });

  for (const [what, changed, said] of [
    [
      "no lease: an older suite's copy",
      { lease: undefined },
      /carries no lease \(an older version of the suite took it\)/,
    ],
    ["an unreadable lease", { lease: "v1 garbage" }, /lease is unreadable/],
    [
      "a lease from another boot",
      { lease: `v1 ${OLD_BOOT} 1 2 r#1\n` },
      /its lease is another boot's/,
    ],
    [
      "an unreadable clock",
      { lease: lease(1, 2), uptime: undefined },
      /clock \(\/proc\/uptime\) could not be read/,
    ],
  ] as const) {
    test(`is refused with ${what}`, () => {
      const verdict = judgeLeftover({ ...facts, ...changed });
      expect(verdict.action).toBe("refuse");
      expect(why(verdict)).toMatch(said);
    });
  }

  test("is put back on another boot's stamp whatever its lease says", () => {
    expect(
      judgeLeftover({ ...facts, stamp: OLD_BOOT, lease: lease(990, 999_999) })
        .action,
    ).toBe("put-back");
  });
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
      putBackArgv(root, DEFAULT_LEASE),
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
    expect(probe()).toBe("12 sh\n13 tar\n15 sh\n");
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
  const claims = (): string[] => ran(/^sudo -n -- mv -T -- /);

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
    // Probed before and after the claim; stamped after it, and again by the put-back itself, which
    // counts the copy's members for room, extracts beside the site and expires the lease once back.
    expect(ran(/e2e-content-copy-in-use-probe/)).toHaveLength(2);
    expect(ran(/^(cp |tar -tf|tar -xpf)/)).toEqual([
      `cp -f -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
      `tar -tf ${CONTENT_COPY_FILE}`,
      `cp -f -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
      `tar -tf ${CONTENT_COPY_FILE}`,
      `tar -xpf ${CONTENT_COPY_FILE} -C swap/new`,
      `cp -f -- /proc/sys/kernel/random/boot_id ${CONTENT_COPY_STAMP}`,
    ]);
    expect(readdirSync(join(host.root, "wp-content"))).toEqual(["from-copy"]);
    expect(leftovers()).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /put back a copy of wp-content an earlier run left orphaned \(an earlier boot of the host stamped its last use; no process used it\), then removed it/,
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
    expect(said).toMatch(/orphaned \(.*; no process used it\): /);
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
      /could not put wp-content back \(exit 83.*nothing was put back.*sudo tar -xpf \S+recovering-[0-9a-f]+\/wp-content\.verified\.tar -C \S+recovering-[0-9a-f]+\/manual /s,
    );
    const [kept = ""] = leftovers();
    expect(kept).toMatch(CLAIMED);
    expect(readdirSync(join(host.root, kept)).sort()).toEqual([
      CONTENT_COPY_STAMP,
      CONTENT_COPY_LEASE,
      CONTENT_COPY_FILE,
    ]);
    // Given up: expired, so the next look may try again at once.
    expect(
      parseLease(
        readFileSync(join(host.root, kept, CONTENT_COPY_LEASE), "utf8"),
      ),
    ).toMatchObject({ renewedS: 1000, expiresS: 1000 });
  });

  /** Writes a lease on the copy at `name`: this boot's, renewed at 100 s, expiring at `expires`. */
  const leaseOn = (
    expires: number,
    holder = "r#1",
    name = CONTENT_COPY_DIR,
  ): void => {
    writeFileSync(
      join(host.root, name, CONTENT_COPY_LEASE),
      `v1 ${BOOT} 100 ${String(expires)} ${holder}\n`,
    );
  };

  // Each read on its own: a clock that cannot be read is no boot id that could not be.
  test("refuses a copy this boot stamped when the host's clock cannot be read, naming the clock", async () => {
    process.env.H_UPTIME_EXIT = "1";
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(500);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /Left: it was used since the host last booted, so a run may still be using it: the host's clock \(\/proc\/uptime\) could not be read/,
    );
    expect(claims()).toEqual([]);
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  // The incident: a put-back that failed leaves its copy, stamped this boot, its lease given up.
  test("puts back a copy this boot stamped once its lease lapsed, then removes it", async () => {
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(1000);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(readdirSync(join(host.root, "wp-content"))).toEqual(["from-copy"]);
    expect(leftovers()).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /orphaned \(its lease expired 0 s ago; no process used it\), then removed it/,
    );
  });

  test("refuses a copy this boot stamped while a run's lease on it runs, touching nothing", async () => {
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(1001);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /Left: it was used since the host last booted, so a run may still be using it: a run renewed its lease 900 s ago \(r#1\); it lapses in 1 s/,
    );
    expect(claims()).toEqual([]);
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  // The next worker in the slot of one whose put-back failed: no wait for the lease.
  test("settles at once a copy its own worker slot leased, and leases what it claims as its own", async () => {
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(1900, "r#1");
    process.env.H_PUT_EXIT = "2";
    await expect(
      assertNoContentCopyLeft(site(), undefined, "r#1"),
    ).rejects.toThrow(/could not put wp-content back \(exit 83/);
    const [kept = ""] = leftovers();
    expect(kept).toMatch(CLAIMED);
    expect(
      parseLease(
        readFileSync(join(host.root, kept, CONTENT_COPY_LEASE), "utf8"),
      ),
    ).toEqual({ bootId: BOOT, renewedS: 1000, expiresS: 1000, holder: "r#1" });
    Reflect.deleteProperty(process.env, "H_PUT_EXIT");
    await expect(
      assertNoContentCopyLeft(site(), undefined, "r#2"),
    ).resolves.toBeUndefined();
    expect(leftovers()).toEqual([]);
  });

  test("stamps a copy it claims with a lease that keeps other runs off while it settles", async () => {
    leave([CONTENT_COPY_FILE]);
    // Seen from inside the put-back's read-back: the claimed copy's lease, as another run would read
    // it then.
    const seen = join(host.root, "lease-seen");
    process.env.H_LEASE_SNAPSHOT = seen;
    process.env.H_LIST_EXIT = "2";
    await expect(
      assertNoContentCopyLeft(site(), undefined, "r#4"),
    ).rejects.toThrow(/does not read back/);
    expect(parseLease(readFileSync(seen, "utf8"))).toEqual({
      bootId: BOOT,
      renewedS: 1000,
      expiresS: 1000 + LEASE_TTL_S,
      holder: "r#4",
    });
  });

  // Given up, so the next run settles it once nothing uses it rather than waiting out the lease.
  test("expires its lease on a claimed copy that does not read back", async () => {
    leave([CONTENT_COPY_FILE]);
    process.env.H_LIST_EXIT = "2";
    await expect(
      assertNoContentCopyLeft(site(), undefined, "r#4"),
    ).rejects.toThrow(/does not read back/);
    const [kept = ""] = leftovers();
    expect(
      parseLease(
        readFileSync(join(host.root, kept, CONTENT_COPY_LEASE), "utf8"),
      ),
    ).toEqual({ bootId: BOOT, renewedS: 1000, expiresS: 1000, holder: "r#4" });
  });

  // A recovery a second reboot cut off.
  test("settles an orphaned claimed copy the same way", async () => {
    leave([CONTENT_COPY_FILE], OLD_BOOT, `${RECOVERING_PREFIX}0123456789ab`);
    await expect(assertNoContentCopyLeft(site())).resolves.toBeUndefined();
    expect(ran(/^tar -xpf/)).toHaveLength(1);
    expect(leftovers()).toEqual([]);
  });

  // Claimed in this boot: a recovery in flight, or one stopped without a reboot.
  test("refuses a claimed copy this boot stamped, while the claiming run's lease runs", async () => {
    leave([CONTENT_COPY_FILE], BOOT, `${RECOVERING_PREFIX}0123456789ab`);
    leaseOn(1500, "r#9", `${RECOVERING_PREFIX}0123456789ab`);
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
      /still in \S+\.e2e_content_copy\. .*Left: a process still uses it/s,
    );
    expect(ran(/^(cp |tar |rm )/)).toEqual([]);
    // Handed back, so the run using it finds it at its path.
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
  });

  // Its run's renewal, in flight inside the directory as it was claimed, lands in the claimed one:
  // the run is alive, so the copy goes back to where it looks for it.
  test("hands a claimed copy back to its path when its run renewed it meanwhile", async () => {
    process.env.H_MV = "renewed";
    // Stamped this boot, its lease lapsed: orphaned, until its run renews it.
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(500);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in \S+\.e2e_content_copy\. .*Left: it was used since the host last booted, so a run may still be using it: a run renewed its lease 0 s ago \(owner#0\)/s,
    );
    expect(leftovers()).toEqual([CONTENT_COPY_DIR]);
    expect(ran(/^(cp |tar )/)).toEqual([]);
  });

  test("leaves a claimed copy where it is when something took its path meanwhile", async () => {
    process.env.H_MV = "renewed-taken";
    // Stamped this boot, its lease lapsed: orphaned, until its run renews it.
    leave([CONTENT_COPY_FILE], BOOT);
    leaseOn(500);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /still in \S+recovering-[0-9a-f]+\. .*Left: it was used since the host last booted/s,
    );
    expect(leftovers().sort()).toEqual([
      CONTENT_COPY_DIR,
      expect.stringMatching(CLAIMED),
    ]);
    // Never moved over what is there: the directory at the path is still the empty one made there.
    expect(readdirSync(join(host.root, CONTENT_COPY_DIR))).toEqual([]);
  });

  // Neither at its path nor at the claimed name: naming either would send the operator to nothing.
  test("says a claimed copy moved on when another run claimed it before it could be handed back", async () => {
    process.env.H_INUSE = "77 tar -xpf x\n";
    process.env.H_INUSE_FROM = "2";
    process.env.H_HANDBACK_TAKEN = "1";
    leave([CONTENT_COPY_FILE]);
    const refused = await assertNoContentCopyLeft(site()).then(
      () => "settled",
      (error: unknown) => (error instanceof Error ? error.message : "?"),
    );
    expect(refused).toMatch(
      /refused \(a process still uses it.*\) and has since moved on: another run claimed it/s,
    );
    expect(refused).not.toMatch(/still in /);
    expect(leftovers()).toEqual([`${RECOVERING_PREFIX}other`]);
    expect(ran(/^(cp |tar )/)).toEqual([]);
  });

  test("refuses a claimed copy it cannot stamp, putting nothing back", async () => {
    process.env.H_CP_EXIT = "1";
    leave([CONTENT_COPY_FILE]);
    await expect(assertNoContentCopyLeft(site())).rejects.toThrow(
      /Left: it could not be stamped \(exit 94/,
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
