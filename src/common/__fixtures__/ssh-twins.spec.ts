import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { execInChildNode } from "./child-node";
import {
  SSH_TWINS_ENV,
  TWIN_CELLS,
  TWIN_LOCK_DIR,
  TWIN_VARIANTS,
  ensureLockBase,
  extendRunningTest,
  removeIfStale,
  sshTwinsEnabled,
  tryLock,
  twinSiteIn,
  withTwin,
} from "./ssh-twins";
import { removeTempDir } from "./temp-dir";
import type { CellMap, SiteInput } from "../config/types";

/** The twin specs' gate and cell lookup: what decides whether they run and which site they use. */

const SITE: SiteInput = {
  baseURL: "http://localhost:8110",
  username: "admin",
  password: "pw",
  transport: {
    mode: "ssh",
    host: "127.0.0.1",
    port: 2210,
    username: "ubuntu",
    privateKeyPath: "/keys/id_ed25519",
    rootDir: "/var/www/site/public",
  },
};

test("twin specs run only when E2E_SSH_TWINS is 1 or true", () => {
  expect(sshTwinsEnabled({})).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "" })).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "0" })).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "1" })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "true" })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: " TRUE " })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "false" })).toBe(false);
});

// A typo must fail loudly, never turn every twin spec into a skip, and say what would work.
test("any other value is refused, naming the variable and the values it takes", () => {
  expect(() => sshTwinsEnabled({ [SSH_TWINS_ENV]: "yes" })).toThrow(
    `${SSH_TWINS_ENV} takes 1 or true (run the twin specs; the twins must be up: npm run env:cells:up) ` +
      'or 0, false or unset (skip them), got "yes".',
  );
});

test("each product has one cell per twin, matching the overlays' names", () => {
  expect(TWIN_CELLS.map((twin) => `${twin.product} ${twin.cell}`)).toEqual([
    "backwpup pro@twin-apache",
    "backwpup pro@twin-nginx",
    "wp-rocket twin-apache",
    "wp-rocket twin-nginx",
  ]);
});

test.describe("twinSiteIn", () => {
  const twin = TWIN_CELLS[0];
  if (twin === undefined) throw new Error("TWIN_CELLS is empty");

  test("returns the cell's only site", () => {
    const cells: CellMap = { [twin.cell]: { sites: [SITE] } };
    expect(twinSiteIn(cells, twin)).toBe(SITE);
  });

  test("an absent cell or a pool of two is refused, naming the cell and the way out", () => {
    for (const cells of [
      {},
      { [twin.cell]: { sites: [SITE, SITE] } },
    ] as CellMap[]) {
      expect(() => twinSiteIn(cells, twin)).toThrow(
        new RegExp(`"${twin.cell}" should hold exactly one site.+env:cells:up`),
      );
    }
  });
});

test("the variants are the ones site.sh makes", () => {
  const lib = readFileSync(
    new URL("../../../docker/ssh-cells/lib.sh", import.meta.url),
    "utf8",
  );
  const declared = /^readonly TWIN_VARIANTS="([^"]+)"$/m.exec(lib)?.[1];

  expect(declared?.split(" ")).toEqual([...TWIN_VARIANTS]);
});

test.describe("withTwin", () => {
  let lockDir: string;
  /** Kills a test's child processes in `afterEach`, which runs after a failure or a timeout too. */
  let stopChildren: AbortController;
  const lock = (): string => join(lockDir, "wpme-ssh-twin-nginx.lock");

  test.beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "twin-lock-"));
    stopChildren = new AbortController();
  });

  test.afterEach(() => {
    stopChildren.abort();
    removeTempDir(lockDir);
  });

  test("holders of one twin run one at a time, and the lock is gone once the last ends", async () => {
    const events: string[] = [];
    const hold = (name: string): Promise<void> =>
      withTwin(
        "nginx",
        async () => {
          events.push(`${name} in`);
          await new Promise((resolve) => setTimeout(resolve, 300));
          events.push(`${name} out`);
        },
        { lockDir },
      );

    await Promise.all([hold("a"), hold("b")]);

    expect(events).toEqual(["a in", "a out", "b in", "b out"]);
    expect(existsSync(lock())).toBe(false);
  });

  test("a free lock leaves the running test's timeout as it was", async () => {
    const before = test.info().timeout;
    const waits: number[] = [];
    await withTwin("nginx", () => Promise.resolve(), {
      lockDir,
      onWaited: (ms) => waits.push(ms),
    });
    await withTwin("nginx", () => Promise.resolve(), { lockDir });

    expect(waits).toEqual([]);
    expect(test.info().timeout).toBe(before);
  });

  test("the wait for a held lock is added to the running test's timeout, as it passes", async () => {
    // A live holder (the runner), let go of after a while.
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(process.ppid));
    const HELD_MS = 400;
    const release = sleep(HELD_MS).then(() => {
      rmSync(lock(), { recursive: true });
    });
    const before = test.info().timeout;
    const started = Date.now();
    const timeouts: number[] = [];

    await withTwin(
      "nginx",
      () => {
        timeouts.push(test.info().timeout);
        return Promise.resolve();
      },
      { lockDir, pollMs: 20 },
    );
    const elapsed = Date.now() - started;
    await release;

    // Raised before the work runs, by about the wait: never less than most of it, never more.
    const added = test.info().timeout - before;
    expect(timeouts).toEqual([test.info().timeout]);
    expect(added).toBeGreaterThanOrEqual(HELD_MS - 100);
    expect(added).toBeLessThanOrEqual(elapsed);
  });

  test("a failing holder releases the lock and passes its error on", async () => {
    await expect(
      withTwin("nginx", () => Promise.reject(new Error("boom")), { lockDir }),
    ).rejects.toThrow("boom");
    expect(existsSync(lock())).toBe(false);
  });

  test("a lock whose holder died is taken", async () => {
    const dead = spawnSync("true").pid;
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(dead));

    await expect(
      withTwin("nginx", () => Promise.resolve("ran"), { lockDir }),
    ).resolves.toBe("ran");
  });

  test("a lock without a pid is taken only once it is old; a live holder's never", async () => {
    // Not empty: an empty folder is no lock (next test). Never made by withTwin, whose locks carry
    // their pid from the start; by hand, say.
    mkdirSync(lock());
    writeFileSync(join(lock(), "note"), "");
    await expect(
      withTwin("nginx", () => Promise.resolve(), { lockDir, timeoutMs: 500 }),
    ).rejects.toThrow(/stayed locked/);

    const old = new Date(Date.now() - 60_000);
    utimesSync(lock(), old, old);
    await expect(
      withTwin("nginx", () => Promise.resolve("ran"), { lockDir }),
    ).resolves.toBe("ran");

    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(process.ppid));
    await expect(
      withTwin("nginx", () => Promise.resolve(), { lockDir, timeoutMs: 500 }),
    ).rejects.toThrow(/stayed locked/);
  });

  test("a takeover judges the lock again: a live holder's is left, a dead one's removed", () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(process.ppid));
    expect(removeIfStale(lock())).toBe(false);
    expect(readFileSync(join(lock(), "pid"), "utf8")).toBe(
      String(process.ppid),
    );

    writeFileSync(join(lock(), "pid"), String(spawnSync("true").pid));
    expect(removeIfStale(lock())).toBe(true);
    expect(readdirSync(lockDir)).toEqual([]);
  });

  test("a dead holder's lock behind a takeover folder its taker left: taken once that folder is old", async () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(spawnSync("true").pid));
    const takeover = `${lock()}.takeover`;
    mkdirSync(takeover);
    // A taker killed mid-way: its folder is young, so the takeover waits for it.
    await expect(
      withTwin("nginx", () => Promise.resolve(), {
        lockDir,
        timeoutMs: 300,
        pollMs: 20,
      }),
    ).rejects.toThrow(/stayed locked/);

    const old = new Date(Date.now() - 11_000);
    utimesSync(takeover, old, old);
    await expect(
      withTwin("nginx", () => Promise.resolve("ran"), {
        lockDir,
        timeoutMs: 2_000,
        pollMs: 20,
      }),
    ).resolves.toBe("ran");
    expect(readdirSync(lockDir)).toEqual([]);
  });

  test("a takeover moving a lock swapped for a live one after it judged hands that one back", () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(spawnSync("true").pid));

    const removed = removeIfStale(lock(), () => {
      // Between judging and moving: the dead lock gone, a live holder's made in its place.
      rmSync(lock(), { recursive: true });
      mkdirSync(lock());
      writeFileSync(join(lock(), "pid"), String(process.ppid));
    });

    expect(removed).toBe(false);
    expect(readFileSync(join(lock(), "pid"), "utf8")).toBe(
      String(process.ppid),
    );
    expect(readdirSync(lockDir)).toEqual(["wpme-ssh-twin-nginx.lock"]);
  });

  test("a takeover the filesystem refuses (another user's lock in the sticky folder) is waited on; other errors throw", () => {
    mkdirSync(lock());
    writeFileSync(join(lock(), "pid"), String(spawnSync("true").pid));
    const failing = (code: string) => (): never => {
      throw Object.assign(new Error(code), { code });
    };

    expect(tryLock(lock(), failing("EPERM"))).toBe(false);
    expect(tryLock(lock(), failing("ENOENT"))).toBe(false);
    expect(() => tryLock(lock(), failing("EACCES"))).toThrow("EACCES");
    // Its own attempt cleaned up each time: only the planted lock is there.
    expect(readdirSync(lockDir)).toEqual(["wpme-ssh-twin-nginx.lock"]);
  });

  for (const [label, pid] of [
    ["0", "0"],
    ["empty", ""],
    ["-1", "-1"],
  ] as const) {
    test(`a lock whose pid file holds ${label} is no pid: taken only once old`, async () => {
      mkdirSync(lock());
      writeFileSync(join(lock(), "pid"), pid);
      await expect(
        withTwin("nginx", () => Promise.resolve(), {
          lockDir,
          timeoutMs: 300,
          pollMs: 20,
        }),
      ).rejects.toThrow(/stayed locked/);

      const old = new Date(Date.now() - 60_000);
      utimesSync(lock(), old, old);
      await expect(
        withTwin("nginx", () => Promise.resolve("ran"), {
          lockDir,
          timeoutMs: 2_000,
          pollMs: 20,
        }),
      ).resolves.toBe("ran");
    });
  }

  test("another user's lock folder must be sticky and world-writable; one's own may be anything", () => {
    const base = join(lockDir, "base");
    mkdirSync(base);
    chmodSync(base, 0o777);
    const me = process.getuid?.() ?? 0;
    const other = me + 1;

    expect(() => {
      ensureLockBase(base, other);
    }).toThrow(
      /belongs to uid \d+ and is not sticky and world-writable \(mode 777\)/,
    );
    expect(() => {
      ensureLockBase(base, me);
    }).not.toThrow();
    chmodSync(base, 0o1777);
    expect(() => {
      ensureLockBase(base, other);
    }).not.toThrow();
    chmodSync(base, 0o1775);
    expect(() => {
      ensureLockBase(base, other);
    }).toThrow(/mode 1775/);
  });

  test("an empty folder at the lock's path is no lock: taken at once", async () => {
    mkdirSync(lock());

    await expect(
      withTwin("nginx", () => Promise.resolve("ran"), {
        lockDir,
        timeoutMs: 500,
      }),
    ).resolves.toBe("ran");
  });

  test("the default folder is one fixed path for the machine, never the user's $TMPDIR", () => {
    expect(TWIN_LOCK_DIR).toBe("/tmp/wpme-ssh-twins");
  });

  test("a lock folder it makes is world-writable and sticky; a symlink in its place is refused", async () => {
    const made = join(lockDir, "made");
    await withTwin("nginx", () => Promise.resolve(), { lockDir: made });
    expect(statSync(made).mode & 0o7777).toBe(0o1777);

    const planted = join(lockDir, "planted");
    symlinkSync(made, planted);
    await expect(
      withTwin("nginx", () => Promise.resolve(), { lockDir: planted }),
    ).rejects.toThrow(/is not a folder/);
  });

  test("a holder whose lock was taken from it fails loudly on release", async () => {
    await expect(
      withTwin(
        "nginx",
        () => {
          // Another process's lock in its place.
          writeFileSync(join(lock(), "pid"), String(process.ppid));
          return Promise.resolve();
        },
        { lockDir },
      ),
    ).rejects.toThrow(/was taken from this process/);
    // Handed back, not removed: it is the other process's to release.
    expect(readFileSync(join(lock(), "pid"), "utf8")).toBe(
      String(process.ppid),
    );
  });

  /**
   * Eight processes, in rounds: each round a dead holder's lock is planted, then all eight are
   * released on it at once, each holding the twin once. Every hold must happen (none lost to a racing
   * takeover's error) and none overlap: a holder makes a marker exclusively, so a second one fails to.
   */
  test("eight processes on a dead holder's lock: every hold happens, never two at once", async () => {
    const CHILDREN = 8;
    const ROUNDS = 12;
    const sync = join(lockDir, "sync");
    mkdirSync(sync);
    const deadPid = String(spawnSync("true").pid);
    const module = pathToFileURL(
      new URL("./ssh-twins.ts", import.meta.url).pathname,
    ).href;
    const child = `
      import { closeSync, existsSync, openSync, unlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { setTimeout as sleep } from "node:timers/promises";
      const { withTwin } = await import(process.env.TWIN_MODULE);
      const { LOCK_DIR, SYNC_DIR, I } = process.env;
      let holds = 0;
      let overlaps = 0;
      for (let round = 0; round < ${String(ROUNDS)}; round += 1) {
        writeFileSync(join(SYNC_DIR, "ready-" + round + "-" + I), "");
        while (!existsSync(join(SYNC_DIR, "go-" + round))) await sleep(1);
        await withTwin("nginx", async () => {
          const marker = join(LOCK_DIR, "held");
          try { closeSync(openSync(marker, "wx")); } catch { overlaps += 1; return; }
          await sleep(1);
          unlinkSync(marker);
          holds += 1;
        }, { lockDir: LOCK_DIR, timeoutMs: 10_000, pollMs: 2 });
      }
      process.stdout.write(JSON.stringify({ holds, overlaps }));
    `;
    const children = Array.from({ length: CHILDREN }, (_, i) =>
      execInChildNode(child, {
        cwd: lockDir,
        // Each waits on files only this test makes: it must end with this worker, however it ends.
        diesWithParent: true,
        signal: stopChildren.signal,
        env: {
          TWIN_MODULE: module,
          LOCK_DIR: lockDir,
          SYNC_DIR: sync,
          I: String(i),
        },
      }),
    );
    // A child that fails ends the wait below with its error, not the test's timeout.
    const failed = Promise.all(children).then(
      () => undefined,
      (error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
    );
    for (let round = 0; round < ROUNDS; round += 1) {
      while (
        readdirSync(sync).filter((name) =>
          name.startsWith(`ready-${String(round)}-`),
        ).length < CHILDREN
      ) {
        const error = await Promise.race([failed, sleep(5)]);
        if (error !== undefined) throw error;
      }
      mkdirSync(lock());
      writeFileSync(join(lock(), "pid"), deadPid);
      writeFileSync(join(sync, `go-${String(round)}`), "");
    }

    const results = (await Promise.all(children)).map(
      ({ stdout }) => JSON.parse(stdout) as { holds: number; overlaps: number },
    );

    expect(results).toEqual(
      Array.from({ length: CHILDREN }, () => ({
        holds: ROUNDS,
        overlaps: 0,
      })),
    );
    expect(existsSync(lock())).toBe(false);
    // Nothing left beside it: every made, moved or released lock was removed.
    expect(
      readdirSync(lockDir).filter((name) => name.includes(".lock")),
    ).toEqual([]);
  });
});

test.describe("extendRunningTest", () => {
  /**
   * A running test's timeout, as `test.info()` exposes it.
   *
   * @param timeout - its timeout in ms (`0`: none).
   * @returns the fake, and the timeouts set on it.
   */
  function fakeTest(timeout: number): {
    readonly info: () => { timeout: number; setTimeout: (ms: number) => void };
    readonly set: number[];
  } {
    const set: number[] = [];
    const current = {
      timeout,
      setTimeout: (ms: number): void => {
        set.push(ms);
        current.timeout = ms;
      },
    };
    return { info: () => current, set };
  }

  test("adds the time to the running test's timeout", () => {
    const fake = fakeTest(120_000);
    extendRunningTest(1_500, fake.info);
    extendRunningTest(500, fake.info);
    expect(fake.set).toEqual([121_500, 122_000]);
  });

  test("no time, or a test without a timeout, changes nothing", () => {
    const timed = fakeTest(120_000);
    extendRunningTest(0, timed.info);
    expect(timed.set).toEqual([]);

    const untimed = fakeTest(0);
    extendRunningTest(1_500, untimed.info);
    expect(untimed.set).toEqual([]);
  });

  test("outside a running test it does nothing and never throws", () => {
    expect(() => {
      extendRunningTest(1_500, () => {
        throw new Error("test.info() can only be called while test is running");
      });
    }).not.toThrow();
  });
});
