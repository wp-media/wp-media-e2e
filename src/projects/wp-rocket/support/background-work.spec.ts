import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

import {
  BACKGROUND_WORK_BUDGETS,
  BACKGROUND_WORK_PHP,
  READ_FAILURE_TOLERANCE,
  WP_ROCKET_BASENAME,
  parseBackgroundWork,
  staleWork,
  stopWpRocketWork,
  workInFlight,
  type BackgroundWork,
  type BackgroundWorkDeps,
  type QueueItem,
} from "./background-work";
import { LEFT_WORK_ALLOWANCE_MS } from "../../../common/hooks/plugin-lifecycle";
import { phpLiteral } from "../../../common/wp/php";
import type { Transport } from "../../../common/config/types";

/**
 * WP Rocket's stop as policy over fake I/O: what counts as work in flight, when WP Rocket is
 * deactivated, how long it waits and what it says. The PHP probe is linted here and run for real on
 * the SSH twins (`lifecycle.ssh-twins.spec.ts`).
 */

const TRANSPORT: Transport = { mode: "local", rootDir: "/srv/site" };

const BUDGETS = BACKGROUND_WORK_BUDGETS;
const QUIET_MS = BUDGETS.quietMs;
/** The wait's budget in the site's seconds: a claim or action this old is stale. */
const STALE_S = BUDGETS.drainMs / 1000;

/** A claim of WP Rocket's, created at site time `since`. */
function claim(id: number, since: number): QueueItem {
  return { name: `claim ${String(id)}`, since };
}

/** A running action of WP Rocket's, attempted at site time `since`. */
function action(id: number, since: number): QueueItem {
  return { name: `action ${String(id)} (rocket_preload_job)`, since };
}

/** A quiet site with WP Rocket active, at site time 1000 s; `over` changes what differs. */
function work(over: Partial<BackgroundWork> = {}): BackgroundWork {
  return {
    now: 1000,
    listed: true,
    present: true,
    claims: [],
    inProgress: [],
    processes: [],
    ...over,
  };
}

/** Fake I/O over a script of looks: each read takes the next, the last repeats. Logs every call. */
function fakeSite(
  looks: readonly (BackgroundWork | Error)[],
  onDeactivate: () => void = () => undefined,
): { deps: BackgroundWorkDeps; log: string[]; clock: () => number } {
  let t = 0;
  let next = 0;
  const log: string[] = [];
  const deps: BackgroundWorkDeps = {
    read: () => {
      const look = looks[Math.min(next, looks.length - 1)];
      next += 1;
      log.push("read");
      if (look === undefined) throw new Error("no look scripted");
      return look instanceof Error
        ? Promise.reject(look)
        : Promise.resolve(look);
    },
    deactivate: () => {
      log.push("deactivate");
      onDeactivate();
      return Promise.resolve();
    },
    sleep: (ms) => {
      log.push(`sleep ${String(ms)}`);
      t += ms;
      return Promise.resolve();
    },
    now: () => t,
  };
  return { deps, log, clock: () => t };
}

test.describe("parseBackgroundWork", () => {
  test("reads a full reply, times included", () => {
    expect(
      parseBackgroundWork(
        JSON.stringify({
          now: 1000.5,
          listed: true,
          present: false,
          claims: [{ id: 7, since: 995 }],
          inProgress: [
            { id: 31, hook: "rocket_preload_job", since: 996 },
            { id: 32, hook: "rocket\u001b[31m_x\nmore", since: 997 },
          ],
          lastRunAt: 990,
          runnerLockAt: 985,
          cronStartedAt: 999.25,
          processes: ["rocket_database_optimization"],
        }),
      ),
    ).toEqual({
      now: 1000.5,
      listed: true,
      present: false,
      claims: [{ name: "claim 7", since: 995 }],
      // The hook is the site's text: made plain before it reaches a message.
      inProgress: [
        { name: "action 31 (rocket_preload_job)", since: 996 },
        { name: "action 32 (rocket_x more)", since: 997 },
      ],
      lastRunAt: 990,
      runnerLockAt: 985,
      cronStartedAt: 999.25,
      processes: ["rocket_database_optimization"],
    });
  });

  test("leaves out the times a site without them answers null", () => {
    expect(
      parseBackgroundWork(
        JSON.stringify({
          now: 1,
          listed: false,
          present: false,
          claims: [],
          inProgress: [],
          lastRunAt: null,
          runnerLockAt: null,
          cronStartedAt: null,
          processes: [],
        }),
      ),
    ).toEqual({
      now: 1,
      listed: false,
      present: false,
      claims: [],
      inProgress: [],
      processes: [],
    });
  });

  // A reply that cannot be read must never pass as a quiet site.
  for (const [name, reply] of [
    ["not JSON (a PHP warning)", "Warning: something"],
    ["empty", ""],
    ["missing now", JSON.stringify({ listed: true, present: true })],
    ["claims as a count", JSON.stringify({ ...work(), claims: 1 })],
    [
      "a claim id that is not positive",
      JSON.stringify({ ...work(), claims: [{ id: 0, since: 1 }] }),
    ],
    [
      "a fractional claim id",
      JSON.stringify({ ...work(), claims: [{ id: 1.5, since: 1 }] }),
    ],
    [
      "a claim with no time",
      JSON.stringify({ ...work(), claims: [{ id: 1, since: null }] }),
    ],
    [
      "a running action with no hook",
      JSON.stringify({ ...work(), inProgress: [{ id: 1, since: 1 }] }),
    ],
    [
      "a time as text",
      JSON.stringify({ ...work(), lastRunAt: "990", processes: [] }),
    ],
    [
      "a process that is not a name",
      JSON.stringify({ ...work(), processes: [1] }),
    ],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(() => parseBackgroundWork(reply)).toThrow(
        /\[wp-rocket\/background-work\]/,
      );
    });
  }
});

test.describe("workInFlight", () => {
  test("a quiet site has nothing in flight", () => {
    expect(workInFlight(work(), BUDGETS)).toEqual([]);
  });

  test("names each kind of work still running", () => {
    const running = workInFlight(
      work({
        claims: [claim(1, 990), claim(2, 995)],
        inProgress: [action(3, 999)],
        cronStartedAt: 997,
        processes: ["rocket_critical_css_generation"],
      }),
      BUDGETS,
    );
    expect(running).toEqual([
      "2 Action Scheduler batches running",
      "1 action(s) in progress",
      "a WP-Cron run started 3.0 s ago",
      `WP Rocket's "rocket_critical_css_generation" background process`,
    ]);
  });

  // The async runner sleeps 5 s after its last batch and may chain another: invisible in the
  // database, so the time since Action Scheduler last did anything is what tells it is over.
  test("an action finished within the quiet window is work in flight; at the window's end it is not", () => {
    expect(
      workInFlight(work({ lastRunAt: 1000 - QUIET_MS / 1000 + 0.1 }), BUDGETS),
    ).toEqual([
      expect.stringMatching(/^Action Scheduler last ran .* 11\.9 s ago/),
    ]);
    expect(
      workInFlight(work({ lastRunAt: 1000 - QUIET_MS / 1000 }), BUDGETS),
    ).toEqual([]);
  });

  test("a runner dispatched within the quiet window counts, even with no action run since", () => {
    expect(workInFlight(work({ runnerLockAt: 995 }), BUDGETS)).toHaveLength(1);
    expect(
      workInFlight(work({ lastRunAt: 900, runnerLockAt: 995 }), BUDGETS),
    ).toHaveLength(1);
    expect(
      workInFlight(work({ lastRunAt: 900, runnerLockAt: 900 }), BUDGETS),
    ).toEqual([]);
  });

  // `spawn_cron()` marks a run before its loopback, which can be lost (60 s of a mark with no run,
  // measured): a run that began once no request could load WP Rocket is none of its work.
  test("a WP-Cron run counts only if it began before the cutoff", () => {
    expect(workInFlight(work({ cronStartedAt: 990 }), BUDGETS, 995)).toEqual([
      "a WP-Cron run started 10.0 s ago",
    ]);
    expect(workInFlight(work({ cronStartedAt: 995 }), BUDGETS, 995)).toEqual(
      [],
    );
    expect(
      workInFlight(
        work({ cronStartedAt: 990 }),
        BUDGETS,
        Number.NEGATIVE_INFINITY,
      ),
    ).toEqual([]);
  });

  // The runner's lock is shared by every plugin bundling Action Scheduler (WooCommerce's, say).
  test("a runner dispatched on a site WP Rocket is not on at all is not its work", () => {
    expect(
      workInFlight(
        work({ listed: false, present: false, runnerLockAt: 999 }),
        BUDGETS,
      ),
    ).toEqual([]);
    // Deactivated (a moment ago, perhaps) but still there, or listed with its folder gone: it may be.
    expect(
      workInFlight(work({ listed: false, runnerLockAt: 999 }), BUDGETS),
    ).toHaveLength(1);
    expect(
      workInFlight(work({ present: false, runnerLockAt: 999 }), BUDGETS),
    ).toHaveLength(1);
  });

  // No batch lives that long (Action Scheduler gives one 30 s): a request killed outright left it.
  test("a claim or running action as old as the wait's budget is not work in flight; younger, it is", () => {
    expect(
      workInFlight(
        work({
          claims: [claim(1, 1000 - STALE_S)],
          inProgress: [action(2, 1000 - STALE_S)],
        }),
        BUDGETS,
      ),
    ).toEqual([]);
    expect(
      workInFlight(
        work({
          claims: [claim(1, 1000 - STALE_S), claim(3, 1000 - STALE_S + 0.1)],
          inProgress: [action(2, 1000 - STALE_S + 0.1)],
        }),
        BUDGETS,
      ),
    ).toEqual(["1 Action Scheduler batch running", "1 action(s) in progress"]);
  });

  test("a site clock read a moment apart never says a negative age", () => {
    expect(workInFlight(work({ lastRunAt: 1000.4 }), BUDGETS)[0]).toContain(
      "0.0 s ago",
    );
  });
});

test.describe("staleWork", () => {
  test("names each claim and running action as old as the wait's budget, with its age", () => {
    expect(
      staleWork(
        work({
          claims: [claim(1, 1000 - STALE_S), claim(2, 999)],
          inProgress: [action(3, 700), action(4, 999)],
        }),
        BUDGETS.drainMs,
      ),
    ).toEqual([
      "claim 1, created 65.0 s ago",
      "action 3 (rocket_preload_job), started 300.0 s ago",
    ]);
  });

  test("nothing stale on a quiet site", () => {
    expect(staleWork(work(), BUDGETS.drainMs)).toEqual([]);
  });
});

test.describe("BACKGROUND_WORK_PHP", () => {
  test("embeds WP Rocket's basename as a literal, keeps to its groups and reads both lock kinds", () => {
    expect(BACKGROUND_WORK_PHP).toContain(phpLiteral(WP_ROCKET_BASENAME));
    expect(BACKGROUND_WORK_PHP).toContain("$wpdb->esc_like( 'rocket' ) . '%'");
    expect(BACKGROUND_WORK_PHP).toContain(
      "action_scheduler_lock_async-request-runner",
    );
    expect(BACKGROUND_WORK_PHP).toContain("get_transient( 'doing_cron' )");
    expect(BACKGROUND_WORK_PHP).toContain("_process_lock");
  });

  test("is valid PHP", () => {
    const php = spawnSync("php", ["-v"]);
    test.skip(php.status !== 0, "PHP is not installed here");
    const lint = spawnSync("php", ["-l"], {
      input: `<?php\n${BACKGROUND_WORK_PHP}`,
      encoding: "utf8",
    });
    expect(lint.stdout + lint.stderr).toContain("No syntax errors");
  });
});

test.describe("stopWpRocketWork", () => {
  // The common case after a long scenario, and a site WP Rocket was never on: one look.
  test("WP Rocket neither active nor running anything costs one look and says nothing", async () => {
    const site = fakeSite([work({ listed: false, present: false })]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBeUndefined();
    expect(site.log).toEqual(["read"]);
  });

  // Another plugin's runner (WooCommerce's, say) on a site WP Rocket was never on.
  test("a runner dispatched on a site WP Rocket is not on costs one look and says nothing", async () => {
    const site = fakeSite([
      work({ listed: false, present: false, runnerLockAt: 999 }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBeUndefined();
    expect(site.log).toEqual(["read"]);
  });

  // A request killed outright (the host's scheduled reboot) leaves its claim for Action Scheduler's
  // 300 s: failing every removal until then would fail every scenario in that window.
  test("only stale work on a site WP Rocket is not on: one look, named as a warning", async () => {
    const site = fakeSite([
      work({
        listed: false,
        present: false,
        claims: [claim(4, 880)],
        inProgress: [action(5, 880)],
      }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBe(
      "WP Rocket's Action Scheduler holds work no request is running any more (claim 4, created " +
        "120.0 s ago; action 5 (rocket_preload_job), started 120.0 s ago): left by a request killed " +
        "outright (a reboot, a timeout); not waited for — Action Scheduler releases it once 300 s old.",
    );
    expect(site.log).toEqual(["read"]);
  });

  test("stale work beside work that ends is waited past, and named after what ran", async () => {
    const site = fakeSite([
      work({ claims: [claim(4, 880), claim(6, 999)] }),
      work({ listed: false, claims: [claim(4, 880), claim(6, 999)] }),
      work({ listed: false, now: 1001, claims: [claim(4, 880)] }),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(said).toMatch(
      /^WP Rocket's background work was still running \(1 Action Scheduler batch running\);.*before the plugin was removed\. WP Rocket's Action Scheduler holds work no request is running any more \(claim 4, created 121\.0 s ago\)/,
    );
  });

  // Ageing past the budget mid-wait: no live batch lasts that long, so it is stale, not "would not stop".
  test("a claim that grows stale during the wait ends it with a warning, not a failure", async () => {
    const site = fakeSite([
      work({ listed: false, present: true, claims: [claim(7, 990)] }),
      work({ listed: false, now: 1054.9, claims: [claim(7, 990)] }),
      work({ listed: false, now: 1055, claims: [claim(7, 990)] }),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(said).toContain("(1 Action Scheduler batch running)");
    expect(said).toContain("(claim 7, created 65.0 s ago)");
  });

  // Measured on the Apache twin: a lost spawn's mark made the Before wait 58 s on a fresh site.
  test("a WP-Cron mark on a site WP Rocket is not on costs one look and says nothing", async () => {
    const site = fakeSite([
      work({ listed: false, present: false, cronStartedAt: 997 }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBeUndefined();
    expect(site.log).toEqual(["read"]);
  });

  test("after deactivating, a WP-Cron run that began later is not waited for", async () => {
    const site = fakeSite([
      work({ lastRunAt: 999 }),
      work({ listed: false, now: 1003, lastRunAt: 999 }),
      work({ listed: false, now: 1012, lastRunAt: 999, cronStartedAt: 1011 }),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(said).not.toContain("WP-Cron");
    expect(site.log.filter((call) => call === "read")).toHaveLength(3);
  });

  test("with the folder gone, a WP-Cron run that began before the first look is waited for, a later one is not", async () => {
    const site = fakeSite([
      work({ present: false, cronStartedAt: 999 }),
      work({ present: false, now: 1001, cronStartedAt: 999 }),
      work({ present: false, now: 1002, cronStartedAt: 1001.5 }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toContain("a WP-Cron run started 1.0 s ago");
    expect(site.log.filter((call) => call === "read")).toHaveLength(3);
  });

  // Deactivating closes the window in which a WP-Cron run could start, load WP Rocket and still run
  // when the folder goes; the grace lets one that booted just before mark itself running.
  test("deactivates an active WP Rocket even on a quiet site, then looks again after the grace", async () => {
    const site = fakeSite([work(), work({ listed: false })]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBeUndefined();
    expect(site.log).toEqual([
      "read",
      "deactivate",
      `sleep ${String(BACKGROUND_WORK_BUDGETS.graceMs)}`,
      "read",
    ]);
  });

  test("waits for what runs, then says what it found and that WP Rocket was deactivated first", async () => {
    const site = fakeSite([
      work({ claims: [claim(1, 998)], lastRunAt: 999 }),
      work({ listed: false, claims: [claim(1, 998)], lastRunAt: 999 }),
      work({ listed: false, now: 1003, lastRunAt: 1002 }),
      work({ listed: false, now: 1014, lastRunAt: 1002 }),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(said).toMatch(
      /^WP Rocket's background work was still running \(1 Action Scheduler batch running; Action Scheduler last ran or dispatched a runner 1\.0 s ago/,
    );
    expect(said).toContain(
      "WP Rocket was deactivated first, so no new request loads it",
    );
    expect(said).toMatch(
      /left to finish \(2\.0 s\) before the plugin was removed\.$/,
    );
    expect(site.log.filter((call) => call === "deactivate")).toHaveLength(1);
  });

  // A work found only after the deactivation (a cron run that had just started) is reported too.
  test("reports work first seen after the deactivation", async () => {
    const site = fakeSite([
      work(),
      work({ listed: false, cronStartedAt: 999.5 }),
      work({ listed: false }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toContain("a WP-Cron run started 0.5 s ago");
  });

  // A run that lost the plugin folder while its work ran: nothing to deactivate (a missing file loads
  // nothing), but the requests already running still have to end before anything is swept.
  test("never deactivates a WP Rocket whose folder is gone, and still waits for what it left running", async () => {
    const site = fakeSite([
      work({ present: false, runnerLockAt: 998 }),
      work({ present: false, now: 1011, runnerLockAt: 998 }),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(site.log).not.toContain("deactivate");
    expect(said).toContain(
      "its plugin folder was already gone, so no new request loads it",
    );
  });

  test("says WP Rocket was not active when it was not listed", async () => {
    const site = fakeSite([
      work({ listed: false, inProgress: [action(1, 999)] }),
      work({ listed: false }),
    ]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toContain("WP Rocket was not active, so no new request loads it");
  });

  // Refusing deactivation is the removal's to report; the wait still protects it.
  test("a deactivation WP Rocket refuses is said, and the wait goes on", async () => {
    const site = fakeSite([
      work({ claims: [claim(1, 999)] }),
      work({ claims: [claim(1, 999)] }),
      work(),
    ]);
    const said = await stopWpRocketWork(
      TRANSPORT,
      BACKGROUND_WORK_BUDGETS,
      site.deps,
    );
    expect(said).toContain(
      "WP Rocket could not be deactivated first (it is still active), so new work could still start",
    );
  });

  test("work still running once the drain budget is spent fails, naming it", async () => {
    const site = fakeSite([work({ listed: false, claims: [claim(1, 999)] })]);
    await expect(
      stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).rejects.toThrow(
      /still running 65 s later \(1 Action Scheduler batch running\) — removing the plugin now would race it/,
    );
    // Polled once a second until the budget, never past it.
    expect(site.clock()).toBe(BACKGROUND_WORK_BUDGETS.drainMs);
  });

  test("forgives a look that fails now and then", async () => {
    const lost = new Error("connection reset");
    const site = fakeSite([lost, lost, work({ listed: false })]);
    expect(
      await stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).toBeUndefined();
    expect(site.log.filter((call) => call === "read")).toHaveLength(
      READ_FAILURE_TOLERANCE + 1,
    );
  });

  test("a site that cannot be asked, look after look, fails the stop after three tries", async () => {
    const site = fakeSite([new Error("connection refused")]);
    await expect(
      stopWpRocketWork(TRANSPORT, BACKGROUND_WORK_BUDGETS, site.deps),
    ).rejects.toThrow("connection refused");
    // Pinned whole: each try costs a probe of a few seconds, and the allowance counts on two pauses.
    expect(site.log).toEqual([
      "read",
      "sleep 1000",
      "read",
      "sleep 1000",
      "read",
    ]);
  });

  // The hooks give a stop LEFT_WORK_ALLOWANCE_MS, probes included, and abandon a hook that overruns.
  test("fits the hooks' allowance for it, and outlasts WordPress's cron lock", () => {
    const { drainMs, graceMs, pollMs } = BACKGROUND_WORK_BUDGETS;
    // The first look, the deactivation and the last look, ~5 s each on a slow link, plus a failed
    // look's pauses.
    const calls = 3 * 5_000 + READ_FAILURE_TOLERANCE * pollMs;
    expect(drainMs + graceMs + calls).toBeLessThanOrEqual(
      LEFT_WORK_ALLOWANCE_MS,
    );
    expect(drainMs).toBeGreaterThan(60_000);
  });
});
