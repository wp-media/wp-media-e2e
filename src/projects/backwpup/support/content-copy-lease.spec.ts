import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CONTENT_COPY_LEASE,
  LEASE_NEXT,
  LeaseHeartbeat,
  NO_HOLDER,
  RENEW_FUNCTION,
  RENEW_SCRIPT,
  UPTIME_PATH,
  holderFor,
  judgeLease,
  parseLease,
  parseUptime,
  renewArgs,
} from "./content-copy-lease";
import { BOOT_ID_PATH, CONTENT_COPY_STAMP } from "./content-copy";
import type { Every, RenewOutcome } from "./content-copy-lease";

/**
 * The lease on a copy of `wp-content`: its format, the judgement a later run makes of it, the root
 * script writing it (under the real `sh`, the host's files stood in for), and the heartbeat renewing it.
 */

const BOOT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

test.describe("parseLease", () => {
  test("reads a lease: boot, renewal, expiry, holder", () => {
    expect(
      parseLease(`v1 ${BOOT} 10 910 2026-11-18T20-03-24-000Z-123#0\n`),
    ).toEqual({
      bootId: BOOT,
      renewedS: 10,
      expiresS: 910,
      holder: "2026-11-18T20-03-24-000Z-123#0",
    });
    // Expired on purpose: renewal and expiry the same.
    expect(parseLease(`v1 ${BOOT} 10 10 -`)?.expiresS).toBe(10);
  });

  test("knows nothing from anything else", () => {
    for (const text of [
      undefined,
      "",
      `v2 ${BOOT} 10 910 -`,
      `v1 ${BOOT} 10 910`,
      `v1 ${BOOT} 10 910 - extra`,
      "v1 ABCDEF01-1111-4111-8111-111111111111 10 910 -",
      `v1 not-a-boot 10 910 -`,
      `v1 ${BOOT} -1 910 -`,
      `v1 ${BOOT} 10.5 910 -`,
      `v1 ${BOOT} 10 9 -`,
      `v1 ${BOOT} 10 910 a/b`,
      `v1  ${BOOT} 10 910 -`,
    ]) {
      expect(parseLease(text), String(text)).toBeUndefined();
    }
  });
});

test.describe("parseUptime", () => {
  test("reads whole seconds since boot", () => {
    expect(parseUptime("193350.35 2291971.25\n")).toBe(193350);
    expect(parseUptime("7 1")).toBe(7);
  });

  test("knows nothing from anything else", () => {
    for (const text of [undefined, "", "x 1", "-1.0 2", "1e9 1"]) {
      expect(parseUptime(text), String(text)).toBeUndefined();
    }
  });
});

test.describe("holderFor and renewArgs", () => {
  test("a worker's holder is its run and slot, one word", () => {
    expect(holderFor("2026-11-18T20-03-24-000Z-4242", 3)).toBe(
      "2026-11-18T20-03-24-000Z-4242#3",
    );
  });

  test("refuses what would not survive the script", () => {
    expect(() => holderFor("run id", 0)).toThrow(
      /cannot name a lease's holder/,
    );
    expect(() => holderFor("run", -1)).toThrow(/cannot name a lease's holder/);
    expect(() => holderFor("run", 1.5)).toThrow(/cannot name a lease's holder/);
    expect(() => renewArgs(-1, NO_HOLDER)).toThrow(/0 to 86400/);
    expect(() => renewArgs(1.5, NO_HOLDER)).toThrow(/0 to 86400/);
    expect(() => renewArgs(90_000, NO_HOLDER)).toThrow(/0 to 86400/);
    expect(() => renewArgs(10, "a b")).toThrow(/one word/);
    expect(() => renewArgs(10, "")).toThrow(/one word/);
    expect(renewArgs(0, NO_HOLDER)).toEqual(["0", "-"]);
  });
});

test.describe("judgeLease", () => {
  const lease = (renewed: number, expires: number, holder = "r#1"): string =>
    `v1 ${BOOT} ${String(renewed)} ${String(expires)} ${holder}`;

  test("held until the clock reaches its expiry, lapsed from then on", () => {
    expect(judgeLease(lease(100, 1000), BOOT, "999.99 1")).toEqual({
      state: "held",
      why: "a run renewed its lease 899 s ago (r#1); it lapses in 1 s unless renewed",
    });
    expect(judgeLease(lease(100, 1000), BOOT, "1000.00 1")).toEqual({
      state: "lapsed",
      why: "its lease expired 0 s ago",
    });
  });

  test("an expired-at-once lease (a run that gave up) lapses immediately", () => {
    expect(judgeLease(lease(500, 500), BOOT, "500.1 1").state).toBe("lapsed");
  });

  test("lapsed at once for the worker slot that held it, whatever the clock", () => {
    expect(judgeLease(lease(100, 99_999), BOOT, "200 1", "r#1").state).toBe(
      "lapsed",
    );
    expect(judgeLease(lease(100, 99_999), BOOT, undefined, "r#1").state).toBe(
      "lapsed",
    );
    expect(judgeLease(lease(100, 99_999), BOOT, "200 1", "r#2").state).toBe(
      "held",
    );
    // Nobody named is nobody's slot.
    expect(judgeLease(lease(100, 99_999, "-"), BOOT, "200 1", "-").state).toBe(
      "held",
    );
  });

  // Within one boot the boot-time clock never goes back: a container restarted under the same id.
  test("lapsed when the clock reads before the renewal", () => {
    expect(judgeLease(lease(100, 1000), BOOT, "50 1")).toMatchObject({
      state: "lapsed",
      why: expect.stringMatching(/restarted since/),
    });
  });

  test("says nothing — never lapsed — when missing, unreadable, another boot's or unmeasurable", () => {
    expect(judgeLease(undefined, BOOT, "5 1").why).toMatch(/carries no lease/);
    expect(judgeLease("garbage", BOOT, "5 1").why).toMatch(/unreadable/);
    expect(judgeLease(`v1 ${OTHER} 1 2 r#1`, BOOT, "5 1").why).toMatch(
      /another boot's/,
    );
    expect(judgeLease(lease(1, 2), BOOT, undefined).why).toMatch(
      /could not be read/,
    );
    expect(judgeLease(lease(1, 2), BOOT, "x").state).toBe("unknown");
    for (const lease_ of [undefined, "garbage", `v1 ${OTHER} 1 2 r#1`]) {
      expect(judgeLease(lease_, BOOT, "5 1").state).toBe("unknown");
    }
  });
});

test.describe("RENEW_SCRIPT", () => {
  let dir: string;
  let bin: string;

  /**
   * Runs the script in `dir` with the host's boot id and clock stood in for by `cp`/`cat` shims.
   *
   * @returns its exit code.
   */
  const renew = (
    ttl: string,
    holder: string,
    { uptime = "1000.75 5.00", boot = BOOT } = {},
  ): number =>
    spawnSync("sh", ["-c", RENEW_SCRIPT, "sh", ttl, holder], {
      cwd: dir,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        UPTIME: uptime,
        BOOT: boot,
      },
    }).status ?? -1;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bwp-lease-"));
    bin = join(dir, ".bin");
    spawnSync("mkdir", [bin]);
    writeFileSync(
      join(bin, "cp"),
      `#!/bin/sh\n[ "$1" = -f ] && shift\n[ "$2" = ${BOOT_ID_PATH} ] && { printf '%s\\n' "$BOOT" > "$3"; exit; }\nexec /bin/cp "$@"\n`,
    );
    writeFileSync(
      join(bin, "cat"),
      `#!/bin/sh\n[ "$1" = ${UPTIME_PATH} ] && { [ -n "$UPTIME" ] && printf '%s\\n' "$UPTIME"; exit; }\nexec /bin/cat "$@"\n`,
    );
    chmodSync(join(bin, "cp"), 0o755);
    chmodSync(join(bin, "cat"), 0o755);
  });
  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  // The stamp keeps the name and the path older suites read, so they still judge a new copy.
  test("stamps the boot where every version reads it", () => {
    expect(RENEW_FUNCTION).toContain(
      `cp -f -- ${BOOT_ID_PATH} ${CONTENT_COPY_STAMP}`,
    );
  });

  test("stamps the boot and writes the lease from the host's clock, replacing the last one whole", () => {
    expect(renew("900", "r#1")).toBe(0);
    expect(readFileSync(join(dir, CONTENT_COPY_STAMP), "utf8")).toBe(
      `${BOOT}\n`,
    );
    expect(readFileSync(join(dir, CONTENT_COPY_LEASE), "utf8")).toBe(
      `v1 ${BOOT} 1000 1900 r#1\n`,
    );
    expect(renew("0", "-", { uptime: "1200.1 1" })).toBe(0);
    expect(
      parseLease(readFileSync(join(dir, CONTENT_COPY_LEASE), "utf8")),
    ).toEqual({
      bootId: BOOT,
      renewedS: 1200,
      expiresS: 1200,
      holder: "-",
    });
    expect(spawnSync("ls", ["-A", dir]).stdout.toString()).not.toContain(
      LEASE_NEXT,
    );
  });

  test("renews nothing, exit 94, when the clock cannot be read", () => {
    expect(renew("900", "r#1")).toBe(0);
    for (const uptime of ["", "garbage"]) {
      expect(renew("900", "r#2", { uptime }), uptime).toBe(94);
      expect(readFileSync(join(dir, CONTENT_COPY_LEASE), "utf8")).toBe(
        `v1 ${BOOT} 1000 1900 r#1\n`,
      );
    }
  });
});

test.describe("LeaseHeartbeat", () => {
  /** A manual timer: `tick()` fires the callback; records whether it is running. */
  function manual(): {
    every: Every;
    tick: () => void;
    running: () => boolean;
  } {
    let fire: (() => void) | undefined;
    return {
      every: (_ms, tick) => {
        fire = tick;
        return () => {
          fire = undefined;
        };
      },
      tick: () => fire?.(),
      running: () => fire !== undefined,
    };
  }
  const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  test("renews on each tick until stopped, never two at once", async () => {
    const timer = manual();
    let calls = 0;
    let release: () => void = () => undefined;
    const beat = new LeaseHeartbeat(
      () => {
        calls += 1;
        return new Promise<RenewOutcome>((resolve) => {
          release = () => {
            resolve("renewed");
          };
        });
      },
      () => undefined,
      10,
      timer.every,
    );
    beat.start();
    beat.start();
    timer.tick();
    timer.tick();
    expect(calls).toBe(1);
    const stopped = beat.stop();
    let done = false;
    void stopped.then(() => {
      done = true;
    });
    await settle();
    // Stopping waits for the renewal in flight, so nothing renews after it returns.
    expect(done).toBe(false);
    release();
    await stopped;
    expect(timer.running()).toBe(false);
  });

  test("stops by itself once the copy is no longer its run's", async () => {
    const timer = manual();
    const beat = new LeaseHeartbeat(
      () => Promise.resolve<RenewOutcome>("gone"),
      () => undefined,
      10,
      timer.every,
    );
    beat.start();
    timer.tick();
    await settle();
    expect(timer.running()).toBe(false);
  });

  test("reports the first failure only, thrown or answered, and keeps trying", async () => {
    const timer = manual();
    const reported: string[] = [];
    const outcomes: (RenewOutcome | Error)[] = [
      { failed: "exit 255: connection reset" },
      new Error("socket closed"),
      "renewed",
    ];
    let calls = 0;
    const beat = new LeaseHeartbeat(
      () => {
        calls += 1;
        const next = outcomes.shift() ?? "renewed";
        return next instanceof Error
          ? Promise.reject(next)
          : Promise.resolve(next);
      },
      (problem) => reported.push(problem),
      10,
      timer.every,
    );
    beat.start();
    for (let i = 0; i < 3; i += 1) {
      timer.tick();
      await settle();
    }
    expect(calls).toBe(3);
    expect(reported).toEqual(["exit 255: connection reset"]);
    expect(timer.running()).toBe(true);
    await beat.stop();
  });
});
