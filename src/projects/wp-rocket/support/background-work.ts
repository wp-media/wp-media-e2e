import { setTimeout as delay } from "node:timers/promises";

import { evalPhp, phpLiteral } from "../../../common/wp/php";
import {
  deactivatePlainly,
  tryForceDeactivate,
} from "../../../common/wp/plugin";
import { isObject } from "../../../common/guards";
import { plain } from "../../../common/text";
import type { ForceDeactivate, Transport } from "../../../common/config/types";
import {
  WP_ROCKET_BASENAME,
  WP_ROCKET_SLUG,
  forceDeactivateWpRocket,
} from "./deactivation";

export { WP_ROCKET_BASENAME, WP_ROCKET_SLUG } from "./deactivation";

/**
 * WP Rocket's background work, and its `ProductConfig.stopRunningWork`: what still runs on a site
 * after a request that loaded WP Rocket, and how to wait for it before the plugin is removed.
 *
 * What runs, from WP Rocket 3.24's source (its bundled Action Scheduler 4.1.0) and measured on the
 * twins (PHP-FPM's status page):
 *
 *  - **Action Scheduler's async runner.** An admin request's `shutdown` takes the
 *    `async-request-runner` lock (an option, `uniqid|expiry`, 60 s) and POSTs a loopback to
 *    `admin-ajax.php?action=as_async_request_queue_runner` that it does not wait for
 *    (`ActionScheduler_QueueRunner::maybe_dispatch_async_request`). That request claims due actions
 *    in batches (a row in `actionscheduler_claims` while a batch runs), then **sleeps 5 s**
 *    (`ActionScheduler_AsyncRequest_QueueRunner::handle`, `action_scheduler_async_request_sleep_seconds`,
 *    which WP Rocket does not filter) and may chain another runner. Measured after the settling admin
 *    request: the runner lived 6.9 s, 5 s of it after its last claim was released — so up to ~6 s past
 *    the settle, invisible in the database. A plugin folder removed meanwhile makes its wake-up fatal
 *    (`Class "ActionScheduler_Lock" not found`: autoloaded only then).
 *  - **Preload.** Actions of the `rocket-preload` group run in those batches; `preload_url` fetches each
 *    page with `blocking => false` (`Preload/Controller/PreloadUrl.php`), so the page's render — which
 *    loads WP Rocket and writes `_transient_wpr_dynamic_lists`, among others — outlives the action.
 *  - **WP-Cron.** `wp-cron.php` runs Action Scheduler's queue and WP Rocket's events; WordPress marks a
 *    run with the `doing_cron` transient (its start time) and counts it running for
 *    `WP_CRON_LOCK_TIMEOUT` (60 s). The mark is not proof: `spawn_cron()` sets it before its loopback,
 *    which can be lost (measured on the Apache twin: a mark with no `wp-cron.php` request, 60 s). So a
 *    run counts only if it began while WP Rocket could still be loaded (the cutoff below); WP-CLI
 *    never spawns one (measured), so the stop's own commands add none.
 *  - **WP Rocket's own background processes** (critical CSS generation, database optimization) hold a
 *    `<identifier>_process_lock` site transient while they run (`wp-background-process.php`).
 *
 * Nothing here kills a request: new work is stopped at its source — WP Rocket is deactivated (forced
 * when a plain deactivation is refused, `./deactivation.ts`), so no request starting afterwards loads
 * it (a missing plugin file loads nothing either) — and what already
 * runs is waited for until every sign above has been quiet long enough ({@link BackgroundWorkBudgets}).
 */

/** WP Rocket's background processes (`prefix_action`), each locked by `<id>_process_lock` while it runs. */
export const WP_ROCKET_PROCESSES = [
  "rocket_critical_css_generation",
  "rocket_database_optimization",
] as const;

/**
 * A claim or a running action of WP Rocket's in Action Scheduler: what to call it, and since when (the
 * site's time, in seconds: a claim's creation, an action's last attempt).
 */
export interface QueueItem {
  readonly name: string;
  readonly since: number;
}

/** What the site shows of the work in flight, as of one request. Times are the site's, in seconds. */
export interface BackgroundWork {
  /** The site's clock when it was asked. */
  readonly now: number;
  /** Whether `active_plugins` lists WP Rocket. */
  readonly listed: boolean;
  /** Whether WP Rocket's main file is there; listed but absent loads nothing. */
  readonly present: boolean;
  /**
   * Action Scheduler batches of WP Rocket's: claims holding a pending or in-progress action of one of
   * its groups (`rocket…`), as Action Scheduler counts claims itself (`get_claim_count`), younger than
   * its own timeout (300 s). A request that dies mid-batch on a PHP fatal releases its claim on
   * shutdown (`FatalErrorMonitor`); only one killed outright leaves it, until that timeout — see
   * {@link staleWork}.
   */
  readonly claims: readonly QueueItem[];
  /** WP Rocket's actions running: `in-progress`, attempted within Action Scheduler's failure period (300 s). */
  readonly inProgress: readonly QueueItem[];
  /** When one of WP Rocket's actions last finished (completed or failed), within the last 10 minutes. */
  readonly lastRunAt?: number;
  /**
   * When the async runner's lock was last taken: a runner is dispatched right after. Shared by every
   * plugin bundling Action Scheduler, so it cannot be told WP Rocket's: counted only while WP Rocket is
   * on the site at all ({@link workInFlight}).
   */
  readonly runnerLockAt?: number;
  /** When the WP-Cron run still counted as running began. */
  readonly cronStartedAt?: number;
  /** WP Rocket's background processes holding their lock. */
  readonly processes: readonly string[];
}

/** How many claims, and how many running actions, one look lists at most: the newest first. */
export const QUEUE_ITEMS_LISTED = 20;

/**
 * The PHP that reports {@link BackgroundWork} as JSON. Plain database and option reads, run with no
 * plugin loaded (`--skip-plugins --skip-themes`): it answers the same whether WP Rocket is active,
 * broken, gone or never installed, and asking never starts work of its own. Only WP Rocket's own
 * Action Scheduler work counts — every group it schedules in starts with `rocket` — so another
 * plugin's queue (WooCommerce's, say) never holds the stop up. A failed query is an error, never an
 * empty answer.
 */
export const BACKGROUND_WORK_PHP = `
global $wpdb;
$now     = microtime( true );
$recent  = gmdate( 'Y-m-d H:i:s', (int) $now - 300 );
$history = gmdate( 'Y-m-d H:i:s', (int) $now - 600 );
$exists  = function ( $table ) use ( $wpdb ) {
	return $table === $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $table ) ) );
};
$rows    = function ( $sql ) use ( $wpdb ) {
	$found = $wpdb->get_results( $sql, ARRAY_A );
	if ( '' !== $wpdb->last_error ) {
		WP_CLI::error( 'reading Action Scheduler failed: ' . $wpdb->last_error );
	}
	return (array) $found;
};
$time    = function ( $gmt ) {
	return null === $gmt ? null : (float) strtotime( $gmt . ' UTC' );
};
$basename = ${phpLiteral(WP_ROCKET_BASENAME)};
$actions  = $wpdb->prefix . 'actionscheduler_actions';
$claims   = $wpdb->prefix . 'actionscheduler_claims';
$groups   = $wpdb->prefix . 'actionscheduler_groups';
$logs     = $wpdb->prefix . 'actionscheduler_logs';
$rocket   = $wpdb->esc_like( 'rocket' ) . '%';
$own      = "a.group_id IN ( SELECT g.group_id FROM {$groups} g WHERE g.slug LIKE %s )";
$limit    = ${String(QUEUE_ITEMS_LISTED)};
$work     = [
	'now'           => $now,
	'listed'        => in_array( $basename, (array) get_option( 'active_plugins', [] ), true ),
	'present'       => file_exists( WP_PLUGIN_DIR . '/' . $basename ),
	'claims'        => [],
	'inProgress'    => [],
	'lastRunAt'     => null,
	'runnerLockAt'  => null,
	'cronStartedAt' => null,
	'processes'     => [],
];
if ( $exists( $actions ) && $exists( $groups ) ) {
	if ( $exists( $claims ) ) {
		foreach ( $rows( $wpdb->prepare( "SELECT c.claim_id AS id, c.date_created_gmt AS since FROM {$claims} c WHERE c.date_created_gmt >= %s AND EXISTS ( SELECT 1 FROM {$actions} a WHERE a.claim_id = c.claim_id AND a.status IN ('pending', 'in-progress') AND {$own} ) ORDER BY c.date_created_gmt DESC LIMIT {$limit}", $recent, $rocket ) ) as $row ) {
			$work['claims'][] = [ 'id' => (int) $row['id'], 'since' => $time( $row['since'] ) ];
		}
	}
	foreach ( $rows( $wpdb->prepare( "SELECT a.action_id AS id, a.hook, a.last_attempt_gmt AS since FROM {$actions} a WHERE a.status = 'in-progress' AND a.last_attempt_gmt >= %s AND {$own} ORDER BY a.last_attempt_gmt DESC LIMIT {$limit}", $recent, $rocket ) ) as $row ) {
		$work['inProgress'][] = [ 'id' => (int) $row['id'], 'hook' => (string) $row['hook'], 'since' => $time( $row['since'] ) ];
	}
	if ( $exists( $logs ) ) {
		$last              = $rows( $wpdb->prepare( "SELECT MAX(l.log_date_gmt) AS at FROM {$logs} l JOIN {$actions} a ON a.action_id = l.action_id WHERE l.log_date_gmt >= %s AND a.status IN ('complete', 'failed') AND {$own}", $history, $rocket ) );
		$work['lastRunAt'] = $time( isset( $last[0]['at'] ) ? $last[0]['at'] : null );
	}
}
$lock = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", 'action_scheduler_lock_async-request-runner' ) );
if ( null !== $lock ) {
	$parts = explode( '|', $lock );
	$until = end( $parts );
	if ( is_numeric( $until ) ) {
		$work['runnerLockAt'] = (float) $until - 60;
	}
}
$cron = get_transient( 'doing_cron' );
if ( is_numeric( $cron ) && (float) $cron + WP_CRON_LOCK_TIMEOUT > $now ) {
	$work['cronStartedAt'] = (float) $cron;
}
foreach ( ${phpLiteral([...WP_ROCKET_PROCESSES])} as $process ) {
	if ( get_site_transient( $process . '_process_lock' ) ) {
		$work['processes'][] = $process;
	}
}
echo wp_json_encode( $work );
`;

/** An optional finite number, or `undefined` for `null`/absent; anything else is a wrong shape. */
function optionalTime(value: unknown, field: string): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  throw new Error(
    `[wp-rocket/background-work] expected "${field}" to be a number or null, got ${JSON.stringify(value)}.`,
  );
}

/** A row id: a positive integer. */
function rowId(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new Error(
    `[wp-rocket/background-work] expected an id in "${field}", got ${JSON.stringify(value)}.`,
  );
}

/**
 * The claims or running actions of one reply, named for a message: `claim <id>`, or
 * `action <id> (<hook>)` with the hook made plain (it is the site's text).
 */
function queueItems(
  value: unknown,
  field: "claims" | "inProgress",
): QueueItem[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `[wp-rocket/background-work] expected "${field}" to be a list, got ${JSON.stringify(value)}.`,
    );
  }
  return value.map((item: unknown) => {
    if (
      !isObject(item) ||
      typeof item.since !== "number" ||
      !Number.isFinite(item.since) ||
      (field === "inProgress" && typeof item.hook !== "string")
    ) {
      throw new Error(
        `[wp-rocket/background-work] expected a ${field === "claims" ? "claim" : "running action"} in "${field}", got ${JSON.stringify(item)}.`,
      );
    }
    const id = String(rowId(item.id, field));
    return {
      name:
        field === "claims"
          ? `claim ${id}`
          : `action ${id} (${plain(String(item.hook))})`,
      since: item.since,
    };
  });
}

/**
 * Parses what {@link BACKGROUND_WORK_PHP} printed.
 *
 * @param json - the snippet's output.
 * @throws {@link Error} if it is not that shape — a reply that cannot be read must never pass as a
 * quiet site.
 */
export function parseBackgroundWork(json: string): BackgroundWork {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(
      `[wp-rocket/background-work] the work in flight did not come back as JSON: ${json.slice(0, 500) || "(empty)"}`,
    );
  }
  if (
    !isObject(parsed) ||
    typeof parsed.now !== "number" ||
    typeof parsed.listed !== "boolean" ||
    typeof parsed.present !== "boolean" ||
    !Array.isArray(parsed.processes) ||
    !parsed.processes.every((p): p is string => typeof p === "string")
  ) {
    throw new Error(
      `[wp-rocket/background-work] expected the work in flight, got ${JSON.stringify(parsed)}.`,
    );
  }
  const lastRunAt = optionalTime(parsed.lastRunAt, "lastRunAt");
  const runnerLockAt = optionalTime(parsed.runnerLockAt, "runnerLockAt");
  const cronStartedAt = optionalTime(parsed.cronStartedAt, "cronStartedAt");
  return {
    now: parsed.now,
    listed: parsed.listed,
    present: parsed.present,
    claims: queueItems(parsed.claims, "claims"),
    inProgress: queueItems(parsed.inProgress, "inProgress"),
    ...(lastRunAt === undefined ? {} : { lastRunAt }),
    ...(runnerLockAt === undefined ? {} : { runnerLockAt }),
    ...(cronStartedAt === undefined ? {} : { cronStartedAt }),
    processes: parsed.processes,
  };
}

/**
 * Reads the work in flight, in one request.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if the site could not be asked, or answered in another shape.
 */
export async function readBackgroundWork(
  transport: Transport,
): Promise<BackgroundWork> {
  return parseBackgroundWork(
    await evalPhp(
      transport,
      BACKGROUND_WORK_PHP,
      "reading WP Rocket's work in flight",
      "wp-rocket/background-work",
      { skipPlugins: true, skipThemes: true },
    ),
  );
}

/** How long each part of the wait may take, in milliseconds. */
export interface BackgroundWorkBudgets {
  /** For everything in flight to finish, once the wait begins; also the age past which a claim or running action is stale ({@link staleWork}). */
  readonly drainMs: number;
  /** Between two looks at the site. */
  readonly pollMs: number;
  /**
   * How long Action Scheduler must have been quiet — no action finished, no runner dispatched — for
   * the requests it started to be over: the runner's 5 s sleep after its last batch, twice (a runner
   * may chain one more, which sleeps too), plus 2 s for a request's start and end and a preloaded
   * page's render.
   */
  readonly quietMs: number;
  /**
   * After deactivating, before looking again: a WP-Cron run that loaded WP Rocket just before marks
   * itself running only once WordPress has booted.
   */
  readonly graceMs: number;
}

/**
 * The budgets the shared `@plugin` hooks run with. The whole stop — a probe, the deactivation (up to
 * three WP-CLI calls, {@link deactivateForStop}), the grace, the drain and a probe it starts at its
 * end, at ~5 s per call on a slow link: ≈ 94 s at worst — must fit the hooks' allowance for it
 * (`LEFT_WORK_ALLOWANCE_MS`, 100 s; the spec holds these to it). `drainMs` outlasts
 * `WP_CRON_LOCK_TIMEOUT` (60 s), so a cron run alone can never fail the stop: WordPress itself stops
 * counting it by then.
 */
export const BACKGROUND_WORK_BUDGETS: BackgroundWorkBudgets = {
  drainMs: 65_000,
  pollMs: 1_000,
  quietMs: 12_000,
  graceMs: 2_000,
};

/** Whether a claim or running action is older than the wait could ever last: no request runs it. */
function isStale(item: QueueItem, now: number, staleAfterMs: number): boolean {
  return (now - item.since) * 1000 >= staleAfterMs;
}

/**
 * What is still running, in words — empty when nothing is. Pure.
 *
 * A claim or running action older than the wait's whole budget is not counted: no live batch lasts
 * that long (Action Scheduler gives one 30 s), so it is what a request killed outright left (a reboot,
 * a timeout), which Action Scheduler itself only releases at 300 s. Waiting on it would fail every
 * removal in that window; {@link staleWork} names it instead.
 *
 * @param work - one look at the site.
 * @param budgets - `quietMs`: how long Action Scheduler must have been quiet; `drainMs`: the wait's
 * budget, past which a claim or action is stale.
 * @param cronCutoff - the site time from which no request loads WP Rocket: a WP-Cron run that began
 * later cannot be WP Rocket's work. `Infinity` (the default) while WP Rocket is still loadable.
 */
export function workInFlight(
  work: BackgroundWork,
  budgets: Pick<BackgroundWorkBudgets, "quietMs" | "drainMs">,
  cronCutoff: number = Number.POSITIVE_INFINITY,
): string[] {
  const running: string[] = [];
  const live = (items: readonly QueueItem[]): number =>
    items.filter((item) => !isStale(item, work.now, budgets.drainMs)).length;
  const claims = live(work.claims);
  if (claims > 0) {
    running.push(
      `${String(claims)} Action Scheduler batch${claims === 1 ? "" : "es"} running`,
    );
  }
  const inProgress = live(work.inProgress);
  if (inProgress > 0) {
    running.push(`${String(inProgress)} action(s) in progress`);
  }
  if (work.cronStartedAt !== undefined && work.cronStartedAt < cronCutoff) {
    running.push(
      `a WP-Cron run started ${seconds(work.now - work.cronStartedAt)} ago`,
    );
  }
  for (const process of work.processes) {
    running.push(`WP Rocket's "${process}" background process`);
  }
  // The runner's lock is any plugin's: on a site WP Rocket is not on at all, it is never WP Rocket's.
  const runnerLockAt =
    work.listed || work.present ? work.runnerLockAt : undefined;
  const lastActive = Math.max(
    work.lastRunAt ?? Number.NEGATIVE_INFINITY,
    runnerLockAt ?? Number.NEGATIVE_INFINITY,
  );
  const quietFor = work.now - lastActive;
  if (quietFor * 1000 < budgets.quietMs) {
    running.push(
      `Action Scheduler last ran or dispatched a runner ${seconds(quietFor)} ago, and its requests ` +
        `outlive that by up to ${seconds(budgets.quietMs / 1000)}`,
    );
  }
  return running;
}

/**
 * WP Rocket's claims and running actions too old to be running — what {@link workInFlight} leaves
 * out — each named with its age. Pure.
 *
 * @param work - one look at the site.
 * @param staleAfterMs - the wait's budget (`BackgroundWorkBudgets.drainMs`).
 */
export function staleWork(
  work: BackgroundWork,
  staleAfterMs: number,
): string[] {
  return [
    ...work.claims
      .filter((claim) => isStale(claim, work.now, staleAfterMs))
      .map(
        (claim) =>
          `${claim.name}, created ${seconds(work.now - claim.since)} ago`,
      ),
    ...work.inProgress
      .filter((action) => isStale(action, work.now, staleAfterMs))
      .map(
        (action) =>
          `${action.name}, started ${seconds(work.now - action.since)} ago`,
      ),
  ];
}

/** The warning for stale work, or `undefined` when there is none. */
function staleNote(stale: readonly string[]): string | undefined {
  if (stale.length === 0) return undefined;
  return (
    `WP Rocket's Action Scheduler holds work no request is running any more (${stale.join("; ")}): ` +
    "left by a request killed outright (a reboot, a timeout); not waited for — Action Scheduler " +
    "releases it once 300 s old."
  );
}

/** A duration in seconds, to one decimal, never negative (the site's clock is read in two places). */
function seconds(value: number): string {
  return `${Math.max(0, value).toFixed(1)} s`;
}

/**
 * What the stop's deactivation did: `plain` — a plain `wp plugin deactivate` took; `forced` — it left
 * WP Rocket active (`plainSaid`) and the force ran (`forceError`: what it threw). Whether the force
 * took is not read here: the stop's next look reads `active_plugins` anyway.
 */
export type StopDeactivation =
  | { readonly kind: "plain" }
  | {
      readonly kind: "forced";
      readonly plainSaid: string;
      readonly forceError?: string;
    };

/** The calls {@link deactivateForStop} makes — injected by unit specs. */
export interface StopDeactivationOps {
  /** A plain deactivation, read back: `undefined` once inactive, else what it did. */
  readonly deactivatePlainly: (
    transport: Transport,
    slug: string,
  ) => Promise<string | undefined>;
  /** WP Rocket's forced deactivation. */
  readonly force: ForceDeactivate;
}

/** The real {@link StopDeactivationOps}. */
export const REAL_STOP_DEACTIVATION: StopDeactivationOps = {
  deactivatePlainly,
  force: forceDeactivateWpRocket,
};

/**
 * The stop's deactivation, at most three WP-CLI calls: the stop's first look has just found WP Rocket
 * listed and present, so no `is-active` leads — a plain `wp plugin deactivate`, its state read back,
 * and the force ({@link forceDeactivateWpRocket}) only while still active. The force's failure is
 * returned, never thrown: one that did not take leaves WP Rocket to the removal's last resort, after
 * the wait, which reports it.
 *
 * @param transport - the site.
 * @param ops - the calls; real by default.
 * @returns what was done.
 * @throws Error if the plain deactivation or its read-back could not run.
 */
export async function deactivateForStop(
  transport: Transport,
  ops: StopDeactivationOps = REAL_STOP_DEACTIVATION,
): Promise<StopDeactivation> {
  const plainSaid = await ops.deactivatePlainly(transport, WP_ROCKET_SLUG);
  if (plainSaid === undefined) return { kind: "plain" };
  const forceError = await tryForceDeactivate(
    ops.force,
    transport,
    WP_ROCKET_SLUG,
  );
  return forceError === undefined
    ? { kind: "forced", plainSaid }
    : { kind: "forced", plainSaid, forceError };
}

/** The I/O {@link stopWpRocketWork} needs — injected by unit specs. */
export interface BackgroundWorkDeps {
  /** One look at the site. */
  readonly read: (transport: Transport) => Promise<BackgroundWork>;
  /** Deactivates WP Rocket ({@link deactivateForStop}); whether it took, the next look reads. */
  readonly deactivate: (transport: Transport) => Promise<StopDeactivation>;
  /** Waits that long. */
  readonly sleep: (ms: number) => Promise<void>;
  /** The runner's clock, in milliseconds. */
  readonly now: () => number;
}

/** The real I/O: the site over WP-CLI, the runner's clock. */
export const REAL_DEPS: BackgroundWorkDeps = {
  read: readBackgroundWork,
  deactivate: deactivateForStop,
  sleep: (ms) => delay(ms),
  now: () => Date.now(),
};

/** Look-ups that may fail in a row before the failure is the answer: a busy site drops one now and then. */
export const READ_FAILURE_TOLERANCE = 2;

/** Reads the work in flight, forgiving up to {@link READ_FAILURE_TOLERANCE} failures in a row. */
async function readSteadily(
  transport: Transport,
  deps: BackgroundWorkDeps,
  pauseMs: number,
): Promise<BackgroundWork> {
  for (let failures = 0; ; failures++) {
    try {
      return await deps.read(transport);
    } catch (error) {
      if (failures >= READ_FAILURE_TOLERANCE) throw error;
      await deps.sleep(pauseMs);
    }
  }
}

/** The outcome of a wait: the last look, and what was found running at the first one. */
interface Drained {
  readonly last: BackgroundWork;
  /** What the first look found running; empty when the site was already quiet. */
  readonly found: readonly string[];
  /** How long the wait took, in milliseconds. */
  readonly waitedMs: number;
}

/**
 * Looks at the site until nothing is in flight ({@link workInFlight}).
 *
 * @param cutoffOf - the WP-Cron cutoff, decided from the wait's first look (the first after a
 * deactivation: from then on no request loads WP Rocket).
 * @throws {@link Error} if something still runs once `budgets.drainMs` is spent.
 */
async function drain(
  transport: Transport,
  budgets: BackgroundWorkBudgets,
  deps: BackgroundWorkDeps,
  cutoffOf: (firstLook: BackgroundWork) => number,
): Promise<Drained> {
  const started = deps.now();
  let work = await readSteadily(transport, deps, budgets.pollMs);
  const cutoff = cutoffOf(work);
  const found = workInFlight(work, budgets, cutoff);
  let running = found;
  while (running.length > 0) {
    const waited = deps.now() - started;
    if (waited >= budgets.drainMs) {
      throw new Error(
        `[wp-rocket/background-work] WP Rocket's background work was still running ` +
          `${String(Math.round(waited / 1000))} s later (${running.join("; ")}) — removing the plugin ` +
          "now would race it: a request still running would re-create what the teardown removes, " +
          "or die loading a class from the removed folder.",
      );
    }
    await deps.sleep(budgets.pollMs);
    work = await readSteadily(transport, deps, budgets.pollMs);
    running = workInFlight(work, budgets, cutoff);
  }
  return { last: work, found, waitedMs: deps.now() - started };
}

/**
 * WP Rocket's `ProductConfig.stopRunningWork`, which the shared `@plugin` hooks call before each
 * removal of the plugin — the teardown's, and the install's, which finds what a killed run left.
 *
 * 1. One look at the site. WP Rocket neither active nor running anything — never installed, or long
 *    quiet with its folder gone — is the cheap case: nothing else is done (stale work is still named).
 * 2. WP Rocket active and its file present: **deactivated**, so no request starting from now loads it
 *    (WordPress reads `active_plugins` per request). The removal right after would deactivate it
 *    anyway; doing it here closes the window in which a WP-Cron run could start, load WP Rocket and
 *    still run when the folder goes. A plain deactivation WP Rocket refuses (an unwritable
 *    `wp-config.php`) is forced ({@link forceDeactivateWpRocket}) and said, even on a quiet site.
 *    Then a short grace ({@link BackgroundWorkBudgets.graceMs}). One that not even the force takes is
 *    not this function's to judge — the removal's last resort takes it off, and reports it — so the
 *    wait goes on, with nothing keeping new work out.
 * 3. Waits until nothing is in flight ({@link workInFlight}).
 * 4. Names what Action Scheduler holds for WP Rocket that is too old to be running ({@link staleWork}):
 *    a warning, never a wait or a failure.
 *
 * Idempotent; never throws for having found work, only for work that would not stop.
 *
 * @param transport - the site to settle.
 * @param budgets - how long each part may take; the hooks' own by default.
 * @param deps - the I/O; real by default.
 * @returns what was found running and what was done, and any stale work; `undefined` when there was
 * neither.
 * @throws {@link Error} if work still runs past `budgets.drainMs`, or the site could not be asked
 * {@link READ_FAILURE_TOLERANCE} + 1 times in a row.
 */
export async function stopWpRocketWork(
  transport: Transport,
  budgets: BackgroundWorkBudgets = BACKGROUND_WORK_BUDGETS,
  deps: BackgroundWorkDeps = REAL_DEPS,
): Promise<string | undefined> {
  const first = await readSteadily(transport, deps, budgets.pollMs);
  const loaded = first.listed && first.present;
  // Until when a request could load WP Rocket, as far as this first look can tell: always while it is
  // loaded; until now when listed with its folder gone (it may have gone a moment ago); never when
  // not listed (a cron run on a site WP Rocket is not on — a fresh one — is none of its work).
  const firstCutoff = loaded
    ? Number.POSITIVE_INFINITY
    : first.listed
      ? first.now
      : Number.NEGATIVE_INFINITY;
  const foundFirst = workInFlight(first, budgets, firstCutoff);
  if (!loaded && foundFirst.length === 0) {
    return staleNote(staleWork(first, budgets.drainMs));
  }

  let gate: string;
  let deactivation: StopDeactivation | undefined;
  if (loaded) {
    deactivation = await deps.deactivate(transport);
    await deps.sleep(budgets.graceMs);
    gate =
      deactivation.kind === "forced"
        ? `WP Rocket was deactivated first — ${forcedClause(deactivation)} —, so no new request loads it`
        : "WP Rocket was deactivated first, so no new request loads it";
  } else {
    gate = first.listed
      ? "its plugin folder was already gone, so no new request loads it"
      : "WP Rocket was not active, so no new request loads it";
  }
  // After a deactivation, the first look's time; one refused leaves WP Rocket loadable.
  const { last, found, waitedMs } = await drain(
    transport,
    budgets,
    deps,
    (look) =>
      !loaded ? firstCutoff : look.listed ? Number.POSITIVE_INFINITY : look.now,
  );
  const stillActive = loaded && last.listed;
  if (stillActive) {
    gate =
      "WP Rocket could not be deactivated first (it is still active), so new work could still start";
  }
  const running = foundFirst.length > 0 ? foundFirst : found;
  const stale = staleNote(staleWork(last, budgets.drainMs));
  const said =
    running.length > 0
      ? `WP Rocket's background work was still running (${running.join("; ")}); ${gate}, and what ` +
        `ran was left to finish (${seconds(waitedMs / 1000)}) before the plugin was removed.`
      : deactivation?.kind === "forced"
        ? forcedNote(deactivation, !stillActive)
        : undefined;
  return (
    [said, stale].filter((part) => part !== undefined).join(" ") || undefined
  );
}

/**
 * How a forced deactivation is named inside a sentence: what the plain one did, and what the force
 * threw.
 *
 * @param deactivation - the stop's forced deactivation.
 */
function forcedClause(
  deactivation: Extract<StopDeactivation, { kind: "forced" }>,
): string {
  return (
    `forced, as a plain deactivation did not take (${deactivation.plainSaid})` +
    (deactivation.forceError === undefined
      ? ""
      : `; the force reported: ${deactivation.forceError}`)
  );
}

/**
 * What the stop says when it had to force the deactivation and found nothing running. Pure.
 *
 * @param deactivation - the stop's forced deactivation.
 * @param took - whether the look after it found WP Rocket inactive.
 */
export function forcedNote(
  deactivation: Extract<StopDeactivation, { kind: "forced" }>,
  took: boolean,
): string {
  const tail =
    deactivation.forceError === undefined
      ? ""
      : `; it reported a failure: ${deactivation.forceError}`;
  return took
    ? `WP Rocket stayed active (${deactivation.plainSaid}), so its forced deactivation ran before ` +
        `the plugin was removed${tail}.`
    : `WP Rocket stayed active (${deactivation.plainSaid}), and its forced deactivation did not take ` +
        `either${tail}; the removal deactivates it as its last resort.`;
}
