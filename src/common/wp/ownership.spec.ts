import { test, expect } from "@playwright/test";
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectSiteOwnership,
  fromRunIdentity,
  grantModeFor,
  matches,
  normalizeOwnership,
  parseIdentity,
  planOwnership,
  parseStatOwnership,
  resetOwnershipCaches,
  resolveTarget,
} from "./ownership";
import type { SiteOwnership, TransportIdentity } from "./ownership";
import { resolveOnTarget } from "./exec";
import type { DockerTransport, LocalTransport } from "../config/types";

/**
 * Ownership normalisation, in two halves.
 *
 * The **decisions** — parsing what a host told us, and choosing the mode grant — are pure functions
 * over strings and numbers, and they are pinned exhaustively here, on any platform. They carry the
 * parts that would be expensive to get wrong: a misparsed `id` decides whether a tree is made
 * world-writable.
 *
 * The **commands** are exercised against a real `local` transport over a temp directory, but only as
 * far as an unprivileged process can go. `chown`-ing to another user needs root, so that path is
 * verified against a live cell rather than pretended at here; what is provable locally is that the
 * fast path runs nothing, that every failure mode returns rather than throws, and that the guards
 * refuse before any privileged command is composed.
 *
 * Everything touching a real transport reads ownership through GNU `stat -c`, this module's only
 * platform assumption. Those cases are gated on the platform itself rather than on whether the probe
 * happened to answer: gating on the probe would let a regression that broke detection on Linux turn
 * these tests from failures into silent skips, and would let several of them pass vacuously on macOS
 * — where *every* root reads as unreadable — instead of admitting they proved nothing.
 */

/** Whether this runner can answer the `stat -c` the real-transport cases depend on. */
const GNU_STAT = process.platform === "linux";

/** The reason those cases give when they skip, so a skipped run is self-explaining. */
const NEEDS_GNU_STAT =
  "needs GNU `stat -c`, which only Linux provides; this module is Linux-only by design";

let wpRoot: string;
let local: LocalTransport;

/** Ownership shaped for the pure helpers, with ids that need not exist anywhere. */
const owner = (
  user: string,
  group: string,
  uid: number,
  gid: number,
): SiteOwnership => ({ user, group, uid, gid });

/** Identity shaped for the pure helpers. */
const identity = (
  uid: number,
  gid: number,
  groupIds: number[] = [gid],
  names: { user?: string; groupNames?: string[] } = {},
): TransportIdentity => ({
  uid,
  gid,
  groupIds,
  groupNames: names.groupNames ?? [],
  ...(names.user !== undefined ? { user: names.user } : {}),
});

/** Runs `body` with `console.warn`/`console.info` captured, and returns everything they were given. */
async function captureConsole(body: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const realWarn = console.warn;
  const realInfo = console.info;
  console.warn = (...args: unknown[]): void => {
    lines.push(args.join(" "));
  };
  console.info = (...args: unknown[]): void => {
    lines.push(args.join(" "));
  };
  try {
    await body();
  } finally {
    console.warn = realWarn;
    console.info = realInfo;
  }
  return lines;
}

test.beforeEach(() => {
  wpRoot = mkdtempSync(join(tmpdir(), "wp-ownership-root-"));
  mkdirSync(join(wpRoot, "wp-content"), { recursive: true });
  local = { mode: "local", rootDir: wpRoot };
  resetOwnershipCaches();
});

test.afterEach(() => {
  rmSync(wpRoot, { recursive: true, force: true });
  resetOwnershipCaches();
});

// ── Pure decisions ────────────────────────────────────────────────────────────

test.describe("parseStatOwnership", () => {
  // Both cells, verbatim.
  test("parses what the cells actually return", () => {
    expect(parseStatOwnership("www-data:www-data:33:33\n")).toEqual({
      user: "www-data",
      group: "www-data",
      uid: 33,
      gid: 33,
    });
    expect(parseStatOwnership("sftp_backwpup:www-data:1001:33")).toEqual({
      user: "sftp_backwpup",
      group: "www-data",
      uid: 1001,
      gid: 33,
    });
  });

  // GNU prints the raw id when the passwd database cannot map it. That is still a usable answer,
  // because the name is only ever handed straight back to `chown`.
  test("accepts an id the passwd database cannot map to a name", () => {
    expect(parseStatOwnership("1001:33:1001:33")).toEqual({
      user: "1001",
      group: "33",
      uid: 1001,
      gid: 33,
    });
  });

  /**
   * BusyBox disagrees with GNU here, and this is its output verbatim: `wp-content` in the
   * `wordpress:cli-php8.3` image (BusyBox 1.37.0) reads `UNKNOWN:UNKNOWN:33:33`. Passed through, it
   * would compose `chown UNKNOWN:UNKNOWN`, which can never succeed — so the id from the same call
   * stands in for it.
   */
  test("substitutes the id when BusyBox reports no name at all", () => {
    expect(parseStatOwnership("UNKNOWN:UNKNOWN:33:33")).toEqual({
      user: "33",
      group: "33",
      uid: 33,
      gid: 33,
    });
    // One half only, and a real account named UNKNOWN would resolve to the same owner either way.
    expect(parseStatOwnership("deploy:UNKNOWN:1001:33")).toEqual({
      user: "deploy",
      group: "33",
      uid: 1001,
      gid: 33,
    });
  });

  test("returns undefined for anything else", () => {
    for (const bad of [
      "",
      "www-data",
      "www-data:www-data",
      "www-data:www-data:33",
      "www-data:www-data:33:33:extra",
      "www-data:www-data:x:33",
      ":www-data:33:33",
      "stat: cannot statx 'x': No such file or directory",
    ]) {
      expect(parseStatOwnership(bad), bad).toBeUndefined();
    }
  });
});

test.describe("parseIdentity", () => {
  // Captured from the two cells on 2026-08-26 — one where `ubuntu` carries www-data, one where the
  // membership had not been applied yet.
  test("parses real `id` output and reads every group", () => {
    const withWwwData = parseIdentity(
      "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),4(adm),27(sudo),33(www-data),44(video)",
    );
    expect(withWwwData?.uid).toBe(1000);
    expect(withWwwData?.gid).toBe(1000);
    expect(withWwwData?.groupIds).toContain(33);

    const without = parseIdentity(
      "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),4(adm),27(sudo),44(video)",
    );
    expect(without?.groupIds).not.toContain(33);
  });

  test("parses a docker container's numeric-only identity", () => {
    expect(
      parseIdentity("uid=33(www-data) gid=33(www-data) groups=33(www-data)"),
    ).toEqual({
      uid: 33,
      gid: 33,
      groupIds: [33],
      groupNames: ["www-data"],
      user: "www-data",
    });
    expect(parseIdentity("uid=33 gid=33 groups=33")).toEqual({
      uid: 33,
      gid: 33,
      groupIds: [33],
      groupNames: [],
    });
  });

  // The primary group is not always repeated in `groups=`; treating it as absent would push a
  // correctly-configured host onto the world-writable branch.
  test("always includes the primary gid, even when `groups=` omits it", () => {
    expect(
      parseIdentity("uid=1000(a) gid=50(b) groups=10(c)")?.groupIds,
    ).toEqual([10, 50]);
    expect(parseIdentity("uid=1000(a) gid=50(b)")?.groupIds).toEqual([50]);
  });

  // A group name may contain a space on a directory-joined host. Reading only up to the first one
  // would drop every group after it — including, potentially, the one that keeps a tree from being
  // made world-writable.
  test("reads a group list containing a name with a space", () => {
    const parsed = parseIdentity(
      "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),513(domain users),33(www-data)",
    );
    expect(parsed?.groupIds).toEqual([1000, 513, 33]);
    expect(parsed?.groupNames).toEqual(["ubuntu", "domain users", "www-data"]);
  });

  test("reads names alongside ids, and omits the ones that are not mapped", () => {
    expect(
      parseIdentity("uid=1000(ubuntu) gid=33(www-data) groups=33(www-data)"),
    ).toMatchObject({ user: "ubuntu", groupNames: ["www-data"] });
    const unmapped = parseIdentity("uid=1001 gid=33 groups=33");
    expect(unmapped?.user).toBeUndefined();
    expect(unmapped?.groupNames).toEqual([]);
    expect(unmapped?.groupIds).toEqual([33]);
  });

  test("returns undefined when uid or gid is missing", () => {
    expect(parseIdentity("")).toBeUndefined();
    expect(parseIdentity("gid=1000(ubuntu)")).toBeUndefined();
    expect(parseIdentity("uid=1000(ubuntu)")).toBeUndefined();
  });
});

/**
 * The two ways a group set arrives, and the world-writable grant that both can wrongly trigger.
 *
 * `grantModeFor` decides by **name** whenever the target's ids are unknown — which is every site
 * that declares `transport.fileOwner`. So a membership lost while parsing `id` is not cosmetic: it
 * is the difference between `ug+rwX` and a world-writable tree, reported with a reason that is not
 * true.
 */
test.describe("parseIdentity — memberships that must not be lost", () => {
  // GNU repeats the primary group in `groups=` on the cells here, but it is not required to, and
  // the id was already backfilled for that reason. The name needs the same treatment.
  test("backfills the primary group's NAME, not only its id", () => {
    const identity = parseIdentity(
      "uid=1000(ubuntu) gid=33(www-data) groups=1000(ubuntu)",
    );
    expect(identity).toBeDefined();
    if (identity === undefined) return;
    expect(identity.groupIds).toContain(33);
    expect(identity.groupNames).toContain("www-data");
    // The consequence, stated as the thing that actually matters.
    expect(
      grantModeFor(identity, {
        user: "www-data",
        group: "www-data",
        uid: Number.NaN,
        gid: Number.NaN,
      }),
    ).toEqual({ mode: "ug+rwX", worldWritable: false });
  });

  // BusyBox prints bare ids when it cannot map them; `wordpress:cli-php8.3` happens to report a
  // single group, which is why this went unnoticed. A second group must not vanish.
  test("keeps every id when the host names none of them", () => {
    expect(parseIdentity("uid=33 gid=33 groups=33,1000")).toEqual({
      uid: 33,
      gid: 33,
      groupIds: [33, 1000],
      groupNames: [],
    });
  });

  // A directory-joined host: the space must not end the entry, and the groups after it must survive.
  test("keeps a group whose name contains a space, and everything after it", () => {
    const identity = parseIdentity(
      "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),513(domain users),33(www-data)",
    );
    expect(identity?.groupIds).toEqual([1000, 513, 33]);
    expect(identity?.groupNames).toEqual([
      "ubuntu",
      "domain users",
      "www-data",
    ]);
  });

  // Mixed spellings in one list — nothing forbids it, and each half must be read on its own terms.
  test("reads a list that names some entries and not others", () => {
    const identity = parseIdentity(
      "uid=0 gid=0 groups=0(root),27,33(www-data)",
    );
    expect(identity?.groupIds).toEqual([0, 27, 33]);
    expect(identity?.groupNames).toEqual(["root", "www-data"]);
  });
});

/**
 * `id` is read from the **one line** it printed, never the whole stream.
 *
 * A shell that greets on a non-interactive channel — an MOTD, an `echo` in `.bashrc` — would
 * otherwise let a banner supply half the identity and the real line the other half. A `uid=0(root)`
 * in a banner is not far-fetched, and this value decides whether a tree is made world-writable.
 */
test.describe("parseIdentity — a banner cannot supply half the identity", () => {
  test("reads the uid, gid and groups from the same line", () => {
    const identity = parseIdentity(
      "Welcome! uid=0(root) is not you\nuid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)",
    );
    expect(identity?.uid).toBe(1000);
    expect(identity?.user).toBe("ubuntu");
    expect(identity?.groupIds).toEqual([1000, 33]);
  });

  test("still reads the line when other output precedes it", () => {
    expect(parseIdentity("motd line\nuid=33 gid=33 groups=33")).toEqual({
      uid: 33,
      gid: 33,
      groupIds: [33],
      groupNames: [],
    });
  });
});

test.describe("fromRunIdentity", () => {
  test("keeps ids and every group, so the grant tests membership as the identity", () => {
    const identity = fromRunIdentity({
      user: "www-data",
      group: "www-data",
      uid: 33,
      gid: 33,
      groupIds: [33, 1001],
      groupNames: ["www-data", "deploy"],
    });

    expect(identity).toEqual({
      user: "www-data",
      uid: 33,
      gid: 33,
      groupIds: [33, 1001],
      groupNames: ["www-data", "deploy"],
    });
    // A member of the target's group by a supplementary group: no world-write.
    expect(
      grantModeFor(identity, {
        user: "sftp_x",
        group: "deploy",
        uid: 1002,
        gid: 1001,
      }).worldWritable,
    ).toBe(false);
  });

  test("an unmapped user (its uid as digits) carries no name, as parseIdentity reads one", () => {
    expect(
      fromRunIdentity({
        user: "33",
        group: "33",
        uid: 33,
        gid: 33,
        groupIds: [33],
        groupNames: [],
      }),
    ).toEqual({ uid: 33, gid: 33, groupIds: [33], groupNames: [] });
  });
});

test.describe("grantModeFor", () => {
  const target = owner("www-data", "www-data", 33, 33);

  test("grants only the owner and group when we already own the tree", () => {
    expect(grantModeFor(identity(33, 33), target)).toEqual({
      mode: "ug+rwX",
      worldWritable: false,
    });
  });

  // `pro@apache`, and `pro@nginx` since the membership was applied.
  test("grants only the owner and group when we are a member of its group", () => {
    expect(grantModeFor(identity(1000, 1000, [1000, 27, 33]), target)).toEqual({
      mode: "ug+rwX",
      worldWritable: false,
    });
  });

  // The branch that keeps `wp plugin uninstall` working: without it the transport user could no
  // longer delete what it installed.
  test("adds world-write only when we are neither the owner nor in its group", () => {
    expect(grantModeFor(identity(1000, 1000, [1000, 27]), target)).toEqual({
      mode: "ug+rwX,o+rwX",
      worldWritable: true,
    });
  });

  // A deployment-account owner: we are not the owner, but the shared group still covers us.
  test("treats the group as sufficient even when the owner is a third account", () => {
    expect(
      grantModeFor(
        identity(1000, 1000, [1000, 33]),
        owner("sftp_backwpup", "www-data", 1001, 33),
      ),
    ).toEqual({ mode: "ug+rwX", worldWritable: false });
  });

  // A target that came from `transport.fileOwner` carries no ids. Comparing only numbers answered
  // "neither owner nor member" for every declared override, so every override world-wrote its tree
  // and said so for a reason that was not true.
  test("recognises membership by name when the target has no ids", () => {
    const declared = owner("www-data", "www-data", Number.NaN, Number.NaN);
    expect(
      grantModeFor(
        identity(1000, 1000, [1000, 33], {
          user: "ubuntu",
          groupNames: ["ubuntu", "www-data"],
        }),
        declared,
      ),
    ).toEqual({ mode: "ug+rwX", worldWritable: false });

    expect(
      grantModeFor(
        identity(1000, 1000, [1000], {
          user: "ubuntu",
          groupNames: ["ubuntu"],
        }),
        declared,
      ),
    ).toEqual({ mode: "ug+rwX,o+rwX", worldWritable: true });
  });

  test("never uses `=` or lowercase `x`, so it can only ever add, and never to a file", () => {
    for (const id of [identity(33, 33), identity(1000, 1000, [1000])]) {
      const { mode } = grantModeFor(id, target);
      expect(mode).not.toContain("=");
      expect(mode).not.toMatch(/[+,]r?w?x/);
    }
  });
});

test.describe("resolveTarget", () => {
  const detected = owner("sftp_backwpup", "www-data", 1001, 33);

  test("uses what was detected when nothing was declared", () => {
    expect(resolveTarget(undefined, detected)).toEqual(detected);
    expect(resolveTarget(undefined, undefined)).toBeUndefined();
  });

  // The ids are what verification prefers, so a declaration that merely restates what was detected
  // must not throw them away.
  test("keeps the detected ids when a declaration restates them", () => {
    expect(
      resolveTarget({ user: "sftp_backwpup", group: "www-data" }, detected),
    ).toEqual(detected);
  });

  test("falls back to names when a declaration overrides what was detected", () => {
    const resolved = resolveTarget(
      { user: "www-data", group: "www-data" },
      detected,
    );
    expect(resolved?.user).toBe("www-data");
    expect(Number.isNaN(resolved?.uid)).toBe(true);
  });

  test("works with no detection at all", () => {
    expect(
      resolveTarget({ user: "www-data", group: "www-data" }, undefined),
    ).toMatchObject({ user: "www-data", group: "www-data" });
  });

  /**
   * A bare numeric id is an accepted declaration, for a host whose passwd database cannot map the
   * name. Left as `NaN` it would be compared by name everywhere it is used, and `stat` answers with
   * the *name* — so every successful chown would read back as a failure, and the grant would find
   * the transport user outside a group it is in and open the tree to the world.
   */
  test("reads a bare numeric declaration as the id it already is", () => {
    const resolved = resolveTarget({ user: "33", group: "33" }, detected);
    expect(resolved).toEqual({ user: "33", group: "33", uid: 33, gid: 33 });
  });

  test("takes each half on its own, so one name and one id both survive", () => {
    const resolved = resolveTarget(
      { user: "www-data", group: "33" },
      undefined,
    );
    expect(Number.isNaN(resolved?.uid)).toBe(true);
    expect(resolved?.gid).toBe(33);
  });
});

test.describe("matches", () => {
  test("compares by id when the target has them", () => {
    const target = owner("www-data", "www-data", 33, 33);
    // A rename behind the same ids is still the ownership that was asked for.
    expect(matches(owner("http", "http", 33, 33), target)).toBe(true);
    expect(matches(owner("www-data", "www-data", 34, 33), target)).toBe(false);
  });

  test("falls back to names when the target has no ids", () => {
    const target = owner("www-data", "www-data", Number.NaN, Number.NaN);
    expect(matches(owner("www-data", "www-data", 33, 33), target)).toBe(true);
    expect(matches(owner("nginx", "www-data", 33, 33), target)).toBe(false);
  });

  /**
   * A declaration may name one half and number the other (`"www-data:33"`), which is exactly what
   * {@link resolveTarget} hands over: a known id for the numeric half, `NaN` for the named one.
   * Judging the *pair* by the weaker spelling compares the group by name — and `stat` answers with
   * the name `www-data`, never `33` — so a chown that worked reads back as a failure.
   */
  test("decides each half on whichever spelling that half has", () => {
    const target = owner("www-data", "33", Number.NaN, 33);
    expect(matches(owner("www-data", "www-data", 33, 33), target)).toBe(true);
    expect(matches(owner("www-data", "www-data", 33, 34), target)).toBe(false);
    expect(matches(owner("nginx", "www-data", 33, 33), target)).toBe(false);
  });
});

// ── Against a real transport ──────────────────────────────────────────────────

test.describe("detectSiteOwnership", () => {
  test.skip(!GNU_STAT, NEEDS_GNU_STAT);

  test("reads the ownership of wp-content", async () => {
    const detected = await detectSiteOwnership(local);
    const expected = statSync(join(wpRoot, "wp-content"));
    expect(detected?.uid).toBe(expected.uid);
    expect(detected?.gid).toBe(expected.gid);
  });

  test("answers undefined for a root that is not there, instead of throwing", async () => {
    const missing: LocalTransport = {
      mode: "local",
      rootDir: join(wpRoot, "nope"),
    };
    expect(await detectSiteOwnership(missing)).toBeUndefined();
  });

  /**
   * Two docroots under one SSH host, with different owners — the live layout on the apache cell
   * (`sftp_backwpup:www-data` and `sftp_wprocket:www-data` under the same `ubuntu@host`). Keyed by
   * host alone, whichever was probed first would answer for both: a wrong ownership line in a fleet
   * check, and a privileged `chown -R` aimed at the other site's owner in anything that normalised
   * two sites in one process.
   */
  test("does not let one site's ownership answer for another on the same host", async () => {
    test.skip(!GNU_STAT, NEEDS_GNU_STAT);
    const other = mkdtempSync(join(tmpdir(), "wp-ownership-other-"));
    mkdirSync(join(other, "wp-content"), { recursive: true });
    const secondary = (process.getgroups?.() ?? []).find(
      (gid) => gid !== process.getgid?.(),
    );
    if (secondary === undefined) {
      test.skip(true, "needs a second group to make the two roots differ");
      return;
    }
    chownSync(join(other, "wp-content"), -1, secondary);

    try {
      const first = await detectSiteOwnership(local);
      const second = await detectSiteOwnership({
        mode: "local",
        rootDir: other,
      });
      expect(second?.gid).toBe(secondary);
      expect(second?.gid).not.toBe(first?.gid);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  // The probe is a property of the install, so it is asked once per install and not once per
  // scenario.
  test("memoises per install, and forgets on reset", async () => {
    const first = await detectSiteOwnership(local);
    rmSync(wpRoot, { recursive: true, force: true });
    expect(await detectSiteOwnership(local)).toEqual(first);

    resetOwnershipCaches();
    expect(await detectSiteOwnership(local)).toBeUndefined();
    mkdirSync(join(wpRoot, "wp-content"), { recursive: true });
  });
});

/**
 * The privileged half, driven end to end over a `local` transport with stub `sudo`, `stat`, `id`,
 * `chmod` and `chown` on `PATH` — the same technique the pre-flight spec uses for `wp`.
 *
 * This is the only place the **command shape** is pinned, and it carries the three properties an
 * earlier review found broken by inspection alone: that `--` ends option parsing in both commands
 * (without it, a dashed owner value is read as a *flag* — measured on a cell, taking ownership from
 * an arbitrary file), that `chown` gets `-Rh`, and above all that the **grant is applied before the
 * chown**. Reversed, a failure between the two leaves the tree owned by the site's user with no
 * grant yet — locked away from the very user that must later uninstall it.
 */
/**
 * Two sites on one host must be detected independently.
 *
 * This is the property that decides whether a privileged `chown` can be aimed at another site's
 * owner, and it cannot be shown with `local` transports: for those, the two cache keys are the same
 * string by construction. So this drives `docker`, where one container serves two roots, through a
 * stub `docker` on `PATH` that answers differently per root.
 *
 * Without it, swapping the per-install cache key back to the per-host one goes unnoticed.
 */
test.describe("detectSiteOwnership — two installs on one host", () => {
  let binDir: string;
  let realPath: string;

  const container = (rootDir: string): DockerTransport => ({
    mode: "docker",
    container: "wpcli",
    rootDir,
  });

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-docker-stub-"));
    // `docker exec <container> stat -c <fmt> <path>` → ownership chosen by which root the path is
    // under, so the two sites are distinguishable only if they are probed separately.
    writeFileSync(
      join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        'for a in "$@"; do',
        '  case "$a" in',
        '    */site-a/*) printf "%s" "alpha:www-data:1001:33"; exit 0 ;;',
        '    */site-b/*) printf "%s" "beta:www-data:1002:33"; exit 0 ;;',
        "  esac",
        "done",
        "exit 1",
      ].join("\n"),
    );
    chmodSync(join(binDir, "docker"), 0o755);
    realPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${realPath}`;
    resetOwnershipCaches();
  });

  test.afterEach(() => {
    process.env.PATH = realPath;
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("each site answers with its own owner, not the first one probed", async () => {
    const a = await detectSiteOwnership(container("/var/www/site-a"));
    const b = await detectSiteOwnership(container("/var/www/site-b"));

    expect(a?.user).toBe("alpha");
    expect(b?.user).toBe("beta");
    expect(b?.uid).not.toBe(a?.uid);
  });

  test("the same site is still probed only once", async () => {
    const first = await detectSiteOwnership(container("/var/www/site-a"));
    // Break the stub: a second probe would now fail, so an identical answer proves it was cached.
    rmSync(join(binDir, "docker"));
    expect(await detectSiteOwnership(container("/var/www/site-a"))).toEqual(
      first,
    );
  });
});

test.describe("normalizeOwnership — the privileged commands", () => {
  let binDir: string;
  let logFile: string;
  let realPath: string;

  /** Stubs that record their argv and succeed, so the sequence is observable without root. */
  function stub(name: string, body: string): void {
    writeFileSync(
      join(binDir, name),
      `#!/usr/bin/env bash\nprintf '%s\\n' "${name} $*" >> "$OWNERSHIP_LOG"\n${body}\n`,
    );
    chmodSync(join(binDir, name), 0o755);
  }

  /** Every stubbed command run so far, one per line. */
  const ran = (): string[] =>
    existsSync(logFile)
      ? readFileSync(logFile, "utf8").trim().split("\n").filter(Boolean)
      : [];

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-ownership-bin-"));
    logFile = join(binDir, "commands.log");
    process.env.OWNERSHIP_LOG = logFile;
    // Ownership the transport user does not already have, so the fast path cannot fire.
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
    Reflect.deleteProperty(process.env, "OWNERSHIP_LOG");
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("grants the mode BEFORE chowning, and ends option parsing in both", async () => {
    const outcome = await normalizeOwnership(
      local,
      "wp-content/plugins/backwpup-pro",
    );
    const plugin = join(wpRoot, "wp-content/plugins/backwpup-pro");
    const elevated = ran().filter((line) => line.startsWith("sudo "));

    expect(outcome).toBe("normalized");
    expect(elevated).toEqual([
      "sudo -n true",
      `sudo -n -- chmod -R -- ug+rwX ${plugin}`,
      `sudo -n -- chown -Rh -- www-data:www-data ${plugin}`,
    ]);
  });

  // The guard runs before anything is composed, so an implausible root costs no privileged command
  // at all — not even a refused one.
  test("composes no privileged command at all when the root is implausible", async () => {
    const outcome = await normalizeOwnership(
      { mode: "local", rootDir: "/tmp" },
      "wp-content/plugins/backwpup-pro",
    );

    expect(outcome).toBe("failed");
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
  });

  // Verification is a real re-read: a chown that "succeeded" but left the wrong owner is a failure.
  /**
   * Two *different* failures on one site must both be reported.
   *
   * Nothing consumes `normalizeOwnership`'s return value yet, so a swallowed warning is an invisible
   * failure: the first thing to go wrong would permanently silence every later, unrelated thing.
   * Neither reason here carries a distinguishing detail, so only the reason itself separates them —
   * exactly what a dedupe key of install-alone would lose.
   *
   * Both commands run *through* `sudo`, so the stub has to fail them selectively; stubbing `chmod`
   * or `chown` directly would never be reached.
   */
  test("a second, different failure is not silenced by the first", async () => {
    stub(
      "sudo",
      'case "$*" in *chmod*) exit "${FAIL_CHMOD:-0}" ;; *chown*) exit "${FAIL_CHOWN:-0}" ;; esac; exit 0',
    );

    process.env.FAIL_CHMOD = "1";
    const first = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });
    expect(first.join("\n")).toMatch(/could not grant/);

    // Same site, same run — now the grant succeeds and the chown is what fails.
    process.env.FAIL_CHMOD = "0";
    process.env.FAIL_CHOWN = "1";
    const second = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });
    expect(second.join("\n")).toMatch(/could not set ownership/);

    Reflect.deleteProperty(process.env, "FAIL_CHMOD");
    Reflect.deleteProperty(process.env, "FAIL_CHOWN");
  });

  /**
   * A **real** link out of the tree, not a stubbed probe: the point is that the lexical guards agree
   * the path is inside the root while the filesystem sends it elsewhere, and only resolving it can
   * tell the difference. `chmod` follows a symlink operand and has no flag that stops it.
   */
  test("refuses a target that resolves out of the root, running nothing privileged", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    mkdirSync(join(wpRoot, "wp-content", "plugins"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content", "plugins", "backwpup-pro"));

    const outcome = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });

    expect(outcome.join("\n")).toMatch(/outside it|could not be resolved/);
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  /**
   * The ancestor case, which is the one the leaf-only check missed: `wp-content/plugins` itself is
   * the link, and the target below it looks entirely ordinary. Measured on a container before this
   * guard existed: a privileged `rm -rf` removed content outside the root this way.
   */
  test("refuses a target reached through a symlinked ancestor", async () => {
    const outside = mkdtempSync(join(tmpdir(), "wp-outside-"));
    mkdirSync(join(outside, "backwpup-pro"), { recursive: true });
    symlinkSync(outside, join(wpRoot, "wp-content", "plugins"));

    const outcome = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });

    expect(outcome.join("\n")).toMatch(/outside it/);
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
    rmSync(outside, { recursive: true, force: true });
  });

  /**
   * The world-write branch, end to end — the module's most consequential escape hatch, and until now
   * never executed: every other stub here puts the transport user in the target's group, so
   * `grantModeFor` always took the narrow branch and {@link noteWorldWrite} never ran.
   */
  /**
   * The `unknown-identity` plan: the site's own ownership reads fine, but `id` does not. Untested
   * until now in either this file or the pre-flight spec, and it is the branch that decides to leave
   * a tree alone rather than guess at the grant.
   */
  test("leaves ownership alone when it cannot tell who it is", async () => {
    stub("id", "exit 1");
    resetOwnershipCaches();

    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("skipped");
    });

    expect(lines.join("\n")).toMatch(/could not read which user/);
    // Nothing privileged was composed — not even a refused command.
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
  });

  /**
   * The resolver on its own terms. Its contract carries the whole guard: a path about to be created
   * must still resolve, a link must be followed to where it really goes, and anything it cannot
   * answer must come back `undefined` so a caller reads it as a refusal rather than permission.
   */
  test("resolves a target by following links, and answers undefined when it cannot", async () => {
    // Compared against the resolved *root*, never the declared one: a temp directory is reached
    // through a symlink on macOS (`/var` → `/private/var`), which is precisely why the guard
    // resolves both sides rather than one.
    const realRoot = await resolveOnTarget(local, wpRoot);
    expect(realRoot).toBeDefined();
    expect(await resolveOnTarget(local, join(wpRoot, "wp-content"))).toBe(
      `${realRoot ?? ""}/wp-content`,
    );
    // Followed to where it really goes. The link points back at the root, so the path *through* it
    // must resolve to the same place as the path around it — which is the property the guard rests
    // on, stated without hard-coding any platform's spelling.
    symlinkSync(wpRoot, join(wpRoot, "wp-content", "link"));
    expect(
      await resolveOnTarget(local, join(wpRoot, "wp-content/link/wp-content")),
    ).toBe(`${realRoot ?? ""}/wp-content`);
    // Unresolvable, which callers must read as a refusal rather than as permission. (Whether a
    // *single* absent component resolves is implementation-specific — GNU and BusyBox tolerate it,
    // others do not — which is why the guard walks up to the deepest existing ancestor instead of
    // depending on it.)
    expect(
      await resolveOnTarget(local, join(wpRoot, "wp-content/a/b/c")),
    ).toBeUndefined();
  });

  /**
   * A declaration made by **name** on a host whose `id` prints none — BusyBox, which is what the
   * `wordpress:cli` image ships. Without the id lookup all four insider tests fail against a `NaN`
   * target, and the tree is made world-writable for a reason that is not true; `matches` then reads
   * the numeric `stat` answer and calls the successful chown a failure.
   */
  test("a by-name fileOwner on a nameless host is still decided by id", async () => {
    stub(
      "id",
      'case "$*" in *-u*) printf "%s" "33" ;; *) printf "%s" "uid=33 gid=33 groups=33" ;; esac',
    );
    stub("getent", 'printf "%s" "www-data:x:33:"');
    stub("stat", 'printf "%s" "33:33:33:33"');
    resetOwnershipCaches();
    const site = { ...local, fileOwner: "www-data:www-data" } as LocalTransport;

    // The transport user *is* uid 33 and the target resolves to 33:33 — nothing to do, and
    // certainly nothing to make world-writable.
    expect((await planOwnership(site)).kind).toBe("unnecessary");
    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(site, "wp-content/plugins/backwpup-pro"),
      ).toBe("unnecessary");
    });
    expect(lines.join("\n")).not.toMatch(/world-write/);
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
  });

  test("grants world-write, says so once, and names the fix", async () => {
    // The same user, no longer a member of the target's group.
    stub(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)"',
    );
    resetOwnershipCaches();

    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("normalized");
      // Same site again: the notice is worth saying once, not once per scenario.
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("normalized");
    });

    const plugin = join(wpRoot, "wp-content/plugins/backwpup-pro");
    expect(ran()).toContain(`sudo -n -- chmod -R -- ug+rwX,o+rwX ${plugin}`);
    const notices = lines.filter((line) =>
      line.includes("granted world-write"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/adding that user to the "www-data" group/i);
  });

  /**
   * One scenario normalises the plugin directory *and* every declared data directory. Keyed per
   * install, the first grant would announce itself and silence the rest — a world-writable directory
   * nobody is told about.
   */
  test("and says so again for a different path on the same site", async () => {
    stub(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)"',
    );
    resetOwnershipCaches();

    const lines = await captureConsole(async () => {
      await normalizeOwnership(local, "wp-content/plugins/backwpup-pro");
      await normalizeOwnership(local, "wp-content/uploads/backwpup");
    });

    expect(
      lines.filter((line) => line.includes("granted world-write")),
    ).toHaveLength(2);
  });

  /**
   * "Could not resolve" must read as a refusal. It is the one answer where nothing is known about
   * where a root command would land, and treating it as permission makes the guard decoration.
   */
  test("refuses a target it cannot resolve at all", async () => {
    stub("readlink", "exit 1");

    const outcome = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });

    expect(outcome.join("\n")).toMatch(/could not be resolved/);
    expect(ran().some((line) => /chmod|chown/.test(line))).toBe(false);
  });

  test("fails when the tree does not read back as the ownership it asked for", async () => {
    // Answers the *detection* probe with the target ownership and every later probe with the
    // transport user's — exactly the shape of a `chown` that exits 0 and changes nothing. Every
    // command "succeeds"; only looking again catches it.
    stub(
      "stat",
      'N=$(cat "$OWNERSHIP_LOG.n" 2>/dev/null || echo 0); echo $((N+1)) > "$OWNERSHIP_LOG.n"; ' +
        'if [ "$N" -eq 0 ]; then printf "%s" "www-data:www-data:33:33"; ' +
        'else printf "%s" "ubuntu:ubuntu:1000:1000"; fi',
    );
    resetOwnershipCaches();

    const outcome = await normalizeOwnership(
      local,
      "wp-content/plugins/backwpup-pro",
    );

    expect(outcome).toBe("failed");
    // It got as far as running both commands — the failure is the re-read disagreeing, not a refusal.
    expect(ran().filter((line) => /chmod|chown/.test(line))).toHaveLength(2);
  });
});

/**
 * A probe that **could not be run** is not an answer, and must not be remembered as one.
 *
 * Caching it would let one dropped connection disable ownership normalisation for every later
 * scenario in that worker — on a site perfectly able to answer — and the only symptom would be a
 * plugin the web server cannot write. The two cases are told apart the way this repository tells
 * them apart everywhere else: a non-zero exit is an answer, a rejection is not.
 *
 * Driven over `docker` with **no `rootDir`**, so resolving the root costs a real `pwd` in the
 * container: that is the step that rejects when the transport is down, and `local` cannot reach it
 * (execa runs with `reject: false`, so a local spawn failure arrives as an exit code instead).
 */
test.describe("detectSiteOwnership — a transport failure is not remembered", () => {
  let binDir: string;
  let realPath: string;
  let up: string;

  // No `rootDir`: the root is read with `pwd`, which is what fails when the container is not there.
  const container: DockerTransport = { mode: "docker", container: "wpcli" };

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-docker-down-"));
    up = join(binDir, "up");
    process.env.DOCKER_UP = up;
    writeFileSync(
      join(binDir, "docker"),
      [
        "#!/usr/bin/env bash",
        // Absent marker ⇒ the whole transport is unavailable, exactly as a stopped container or a
        // dropped SSH connection is.
        '[ -f "$DOCKER_UP" ] || exit 1',
        'case "$*" in',
        '  *pwd*) printf "%s" "/var/www/html" ;;',
        '  *) printf "%s" "www-data:www-data:33:33" ;;',
        "esac",
        "exit 0",
      ].join("\n"),
    );
    chmodSync(join(binDir, "docker"), 0o755);
    realPath = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${realPath}`;
    resetOwnershipCaches();
  });

  test.afterEach(() => {
    process.env.PATH = realPath;
    Reflect.deleteProperty(process.env, "DOCKER_UP");
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("so the next call asks again, and gets the answer", async () => {
    expect(await detectSiteOwnership(container)).toBeUndefined();

    writeFileSync(up, ""); // the transport recovers
    expect(await detectSiteOwnership(container)).toEqual({
      user: "www-data",
      group: "www-data",
      uid: 33,
      gid: 33,
    });
  });
});

/**
 * Two failures that are **not** the same failure must both be heard.
 *
 * The catch-all around the privileged half sees the root guard, the symlink probe and any transport
 * error — none of which is a chown refusing. Filing them under `chown-failed` would mean whichever
 * happened first permanently silenced the other on that site, and nothing consumes the return value,
 * so the loser would be invisible.
 *
 * `PATH` is the stub directory *alone* here, with no `test` binary in it: that makes the symlink
 * probe fail to start, which is the one way to reach the catch-all without changing the transport —
 * and changing the transport would change the dedupe key, proving nothing.
 */
test.describe("normalizeOwnership — the catch-all is its own reason", () => {
  let binDir: string;
  let realPath: string;

  // An absolute shebang, unlike the `env bash` the other stubs use: `PATH` is the stub directory
  // alone here, so `env` would have nothing to find `bash` in and the stub would not start.
  function stub(name: string, body: string): void {
    writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  }

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-ownership-catch-"));
    stub("stat", 'printf "%s" "www-data:www-data:33:33"');
    stub(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    stub(
      "sudo",
      'case "$*" in *chown*) exit "${FAIL_CHOWN:-0}" ;; esac; exit 0',
    );
    realPath = process.env.PATH ?? "";
    process.env.PATH = binDir;
    resetOwnershipCaches();
  });

  test.afterEach(() => {
    process.env.PATH = realPath;
    Reflect.deleteProperty(process.env, "FAIL_CHOWN");
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("so a real chown failure is still reported after one", async () => {
    // No `readlink` on PATH ⇒ the resolution probe cannot start ⇒ the catch-all.
    const first = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });
    expect(first.join("\n")).toMatch(/could not be corrected/);

    // Same site, same run: the probe can now answer, and the chown is what fails.
    stub("readlink", 'printf "%s" "$3"');
    process.env.FAIL_CHOWN = "1";
    const second = await captureConsole(async () => {
      expect(
        await normalizeOwnership(local, "wp-content/plugins/backwpup-pro"),
      ).toBe("failed");
    });
    expect(second.join("\n")).toMatch(/could not set ownership/);
  });
});

test.describe("normalizeOwnership", () => {
  test("does nothing when the site opts out", async () => {
    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(
          { ...local, fileOwner: false },
          "wp-content/x",
        ),
      ).toBe("disabled");
    });
    expect(lines).toEqual([]);
  });

  // Our own mistake, not the host's: loud, but it must not take a scenario down.
  test("reports a path that is not a usable target, without throwing", async () => {
    for (const bad of ["/etc", "../../etc", "wp-content", ""]) {
      const lines = await captureConsole(async () => {
        expect(await normalizeOwnership(local, bad), bad).toBe("failed");
      });
      expect(lines.join("\n"), bad).toMatch(
        /cannot be used as an ownership target/,
      );
    }
  });

  test("reports a malformed `transport.fileOwner`, without throwing", async () => {
    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(
          { ...local, fileOwner: "www-data" },
          "wp-content/plugins/x",
        ),
      ).toBe("failed");
    });
    expect(lines.join("\n")).toMatch(/must be "user:group"/);
  });

  // The `docker` shape: WP-CLI already runs as the account that owns the install. Nothing should be
  // run at all — least of all anything privileged.
  test("does nothing when the transport's user already owns the install", async () => {
    test.skip(!GNU_STAT, NEEDS_GNU_STAT);
    const lines = await captureConsole(async () => {
      expect(await normalizeOwnership(local, "wp-content/plugins/x")).toBe(
        "unnecessary",
      );
    });
    expect(lines).toEqual([]);
  });

  test("warns and skips when the site's ownership cannot be read", async () => {
    test.skip(!GNU_STAT, NEEDS_GNU_STAT);
    const missing: LocalTransport = {
      mode: "local",
      rootDir: join(wpRoot, "nope"),
    };
    const lines = await captureConsole(async () => {
      expect(await normalizeOwnership(missing, "wp-content/plugins/x")).toBe(
        "skipped",
      );
    });
    expect(lines.join("\n")).toMatch(
      /could not read this site's file ownership/,
    );
    expect(lines.join("\n")).toMatch(/transport\.fileOwner/);
  });

  // A site that refuses privileges keeps the behaviour it had before this module existed: it is
  // told what it is giving up, and nothing is attempted.
  test("warns and skips when it may not elevate", async () => {
    test.skip(!GNU_STAT, NEEDS_GNU_STAT);
    const primary = process.getgid?.();
    const secondary = (process.getgroups?.() ?? []).find(
      (gid) => gid !== primary,
    );
    if (secondary === undefined) {
      test.skip(
        true,
        "needs a second group to make the runner differ from the tree's owner",
      );
      return;
    }
    // Now the detected ownership differs from this process's identity, so the fast path cannot fire.
    chownSync(join(wpRoot, "wp-content"), -1, secondary);
    resetOwnershipCaches();

    const lines = await captureConsole(async () => {
      expect(
        await normalizeOwnership(
          { ...local, elevate: false },
          "wp-content/plugins/x",
        ),
      ).toBe("skipped");
    });
    expect(lines.join("\n")).toMatch(/elevation: disabled/);
    expect(lines.join("\n")).toMatch(/passwordless/);
  });

  // Warnings are per target, not per call: the plugin hook runs this every scenario.
  // Two *different* mistakes must both be reported; the same one repeated every scenario must not.
  test("reports each distinct bad input once, not each repeat", async () => {
    const lines = await captureConsole(async () => {
      for (let i = 0; i < 3; i++) {
        await normalizeOwnership(local, "/etc");
        await normalizeOwnership(local, "../../etc");
      }
    });
    expect(lines).toHaveLength(2);
  });

  test("warns once per target, however often it is called", async () => {
    test.skip(!GNU_STAT, NEEDS_GNU_STAT);
    const missing: LocalTransport = {
      mode: "local",
      rootDir: join(wpRoot, "nope"),
    };
    const lines = await captureConsole(async () => {
      for (let i = 0; i < 3; i++) {
        await normalizeOwnership(missing, "wp-content/plugins/x");
      }
    });
    expect(lines).toHaveLength(1);
  });
});
