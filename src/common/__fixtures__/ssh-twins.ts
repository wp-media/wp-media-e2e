import { test, type TestInfo } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { parseBoolean } from "../config/env";
import { loadSites } from "../config/sites";
import type { CellMap, SiteInput } from "../config/types";

/**
 * For specs run against the SSH twins (`docker/ssh-cells/`, `npm run env:cells:up`): whether they
 * run, and the twins' sites as the overlays the twins wrote declare them, loaded the way a run loads
 * them. Twin specs are opt-in, so `npm run test:unit` (and the main CI) never needs Docker.
 */

/** The variable turning twin specs on (`E2E_SSH_TWINS=1`), set by the twins' workflow. */
export const SSH_TWINS_ENV = "E2E_SSH_TWINS";

/** Why a twin spec skipped, shown in its report. */
export const SSH_TWINS_SKIP_REASON = `twin specs run only with ${SSH_TWINS_ENV}=1 and the twins up (npm run env:cells:up)`;

/**
 * Whether twin specs run. A value other than a boolean fails the spec file's load, never skips it:
 * a typo in CI would otherwise turn every twin spec into a silent skip.
 *
 * @param source - the environment to read; `process.env` unless a spec holds another.
 * @returns `true` when {@link SSH_TWINS_ENV} is `1`/`true`; `false` when `0`/`false`, blank or unset.
 * @throws Error naming the variable, the values it takes and what each does.
 */
export function sshTwinsEnabled(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = source[SSH_TWINS_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  const enabled = parseBoolean(raw);
  if (enabled !== undefined) return enabled;
  throw new Error(
    `${SSH_TWINS_ENV} takes 1 or true (run the twin specs; the twins must be up: npm run env:cells:up) ` +
      `or 0, false or unset (skip them), got ${JSON.stringify(raw)}.`,
  );
}

/** The twins' two stacks, one container each. */
export type TwinStack = "apache" | "nginx";

/** One product's cell on one twin. */
export interface TwinCell {
  /** The product folder under `src/projects/`. */
  readonly product: "backwpup" | "wp-rocket";
  /** The cell the product's `sites.twins.json` declares. */
  readonly cell: string;
  /** The twin it runs on. */
  readonly stack: TwinStack;
}

/** Every cell the twins' overlays declare (`cells.sh`): BackWPup's need an edition, WP Rocket's none. */
export const TWIN_CELLS: readonly TwinCell[] = [
  { product: "backwpup", cell: "pro@twin-apache", stack: "apache" },
  { product: "backwpup", cell: "pro@twin-nginx", stack: "nginx" },
  { product: "wp-rocket", cell: "twin-apache", stack: "apache" },
  { product: "wp-rocket", cell: "twin-nginx", stack: "nginx" },
];

/** The checkout's root, three folders up from this file. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The one site of a twin cell, from `cells` (a product's loaded sites files).
 *
 * @param cells - the product's merged cells, as {@link loadSites} returns them.
 * @param twin - which cell.
 * @returns its only site.
 * @throws Error naming the cell when it is absent or its pool is not exactly one site: the overlay
 * is missing (the twins are down) or was not written by `cells.sh`.
 */
export function twinSiteIn(cells: CellMap, twin: TwinCell): SiteInput {
  const sites = cells[twin.cell]?.sites ?? [];
  const [site] = sites;
  if (site === undefined || sites.length !== 1) {
    throw new Error(
      `${twin.product}: cell "${twin.cell}" should hold exactly one site, found ${String(sites.length)}. ` +
        "Run npm run env:cells:up first: it writes the twins' sites.twins.json.",
    );
  }
  return site;
}

/**
 * A twin cell's site, loaded from its product's sites files exactly as a run loads them: the whole
 * config folder, so a real `sites.json` beside the overlay is read too (only the twin's site is ever
 * contacted). A clash between them (a twin cell `sites.json` also declares, mixed editions) then fails
 * here, loudly, as it would fail the run.
 *
 * @param twin - which cell.
 * @returns its only site.
 * @throws Error when the sites files do not load or the cell is not there.
 */
export function twinSite(twin: TwinCell): SiteInput {
  return twinSiteIn(
    loadSites(join(REPO_ROOT, "src", "projects", twin.product, "config")),
    twin,
  );
}

// ── Variants ──────────────────────────────────────────────────────────────────────────────────────

/** Every variant `site.sh` makes (`TWIN_VARIANTS` in `docker/ssh-cells/lib.sh`). */
export const TWIN_VARIANTS = [
  "legacy-777",
  "site",
  "site-775",
  "no-sudo",
  "owner-mismatch",
  "no-wp",
  "wpconfig-root",
] as const;

/** One twin variant. */
export type TwinVariant = (typeof TWIN_VARIANTS)[number];

/**
 * The variant the twins start in and every spec leaves them in: the cells' shape today. A spec that
 * needs another resets to it under {@link withTwin} and puts this one back.
 */
export const RESTING_VARIANT: TwinVariant = "legacy-777";

/** How long one reset may take (it takes ~6 s). */
const RESET_TIMEOUT_MS = 180_000;

/**
 * Makes a twin's site the given variant (`site.sh`, which ends by proving it with `check.sh`).
 * Call only while holding the twin ({@link withTwin}).
 *
 * @param stack - which twin.
 * @param variant - what to make it.
 * @throws Error when the reset fails (its output is in the message: no secret, the twins' own).
 */
export function resetTwin(stack: TwinStack, variant: TwinVariant): void {
  execFileSync(
    "docker",
    ["exec", `wpme-ssh-${stack}`, "/opt/twin/site.sh", variant],
    { stdio: "pipe", timeout: RESET_TIMEOUT_MS },
  );
}

/**
 * Where the twins' locks live unless a spec says otherwise: one fixed folder for the machine, never
 * `$TMPDIR` (per user on macOS), since the twins' containers are the machine's, shared by every user
 * and checkout. Made world-writable and sticky (`1777`, as `/tmp`): anyone may lock, nobody may move
 * another user's lock — so another user's stale lock is waited on, never taken (the timeout names it).
 */
export const TWIN_LOCK_DIR = "/tmp/wpme-ssh-twins";

/** How often a waiting spec looks at a held lock again. */
const LOCK_POLL_MS = 200;

/** How long a lock may stay without a pid (never made by this code: by hand, or an older one) before it is taken for dead. */
const PIDLESS_LOCK_MS = 10_000;

/** Errors meaning "the lock changed under us": look again. */
const LOCK_RACE_CODES = new Set(["ENOENT", "ENOTEMPTY", "EEXIST", "EINVAL"]);

/**
 * Whether a process is running. `EPERM` (another user's process) counts as running.
 *
 * @param pid - its id.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Whether `error` is a filesystem error with one of `codes`.
 *
 * @param error - what was thrown.
 * @param codes - the codes to match.
 */
function hasCode(error: unknown, codes: ReadonlySet<string>): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined && codes.has(code);
}

/**
 * A name beside the lock no other process uses (pid plus random), for a lock being made or moved.
 *
 * @param lock - the lock folder.
 * @param kind - what the name is for (`new`, `stale`, `released`).
 */
function uniqueBeside(lock: string, kind: string): string {
  return `${lock}.${kind}-${String(process.pid)}-${randomBytes(6).toString("hex")}`;
}

/** A pid as a lock's `pid` file must hold it: `0`, `-1` or an empty file would signal a group, or all. */
const PID = /^[1-9]\d*$/;

/**
 * Who holds a lock folder: its `pid` file's number when it is a pid ({@link PID}); otherwise (no
 * file, or not a pid) `NaN` once the folder is older than {@link PIDLESS_LOCK_MS} (its maker is
 * gone), `undefined` while a younger one may still be a lock someone is making by hand. Throws
 * `ENOENT` when the folder itself is gone.
 *
 * @param dir - a lock folder.
 */
function holderOf(dir: string): number | undefined {
  try {
    const text = readFileSync(join(dir, "pid"), "utf8");
    if (PID.test(text)) return Number(text);
  } catch (error) {
    if (!hasCode(error, new Set(["ENOENT"]))) throw error;
  }
  const made = statSync(dir).mtimeMs; // ENOENT here: the lock itself is gone.
  return Date.now() - made > PIDLESS_LOCK_MS ? Number.NaN : undefined;
}

/**
 * The lock folder, ready: made `1777` when this process creates it; refused when it is not a plain
 * folder (a symlink planted in `/tmp` would send the locks elsewhere), or when another user owns it
 * without its being sticky and world-writable (they, or anyone it lets in, could move our locks).
 * Exported for its spec.
 *
 * @param base - the folder holding the locks.
 * @param uid - this process's user (a parameter so a spec can be "another user").
 * @throws Error when `base` is not a folder, or another user's folder that is not `1777`-like.
 */
export function ensureLockBase(
  base: string,
  uid: number | undefined = process.getuid?.(),
): void {
  try {
    mkdirSync(base);
    // `mkdir`'s mode passes through the umask: set the sticky, world-writable bits after.
    chmodSync(base, 0o1777);
  } catch (error) {
    if (!hasCode(error, new Set(["EEXIST"]))) throw error;
  }
  const stats = lstatSync(base);
  if (!stats.isDirectory()) {
    throw new Error(`the twins' lock folder ${base} is not a folder.`);
  }
  const shared = (stats.mode & 0o1000) !== 0 && (stats.mode & 0o002) !== 0;
  if (stats.uid !== uid && !shared) {
    throw new Error(
      `the twins' lock folder ${base} belongs to uid ${String(stats.uid)} and is not sticky and ` +
        `world-writable (mode ${(stats.mode & 0o7777).toString(8)}): its owner could move this user's ` +
        `locks. Have its owner run "chmod 1777 ${base}", or remove it once no twin spec runs.`,
    );
  }
}

/**
 * Takes a twin's lock once. Made whole beside it (a folder with the taker's pid) and renamed onto the
 * lock's path, which fails while a lock is there, so a lock is never seen without its pid.
 *
 * A lock whose holder died is taken over ({@link takeOverIfStale}). Any `ENOENT`/`ENOTEMPTY`/`EEXIST`/
 * `EINVAL` on the way means the lock changed under us: look again. Exported for its spec.
 *
 * @param lock - the lock folder.
 * @param takeOver - the takeover (a parameter so a spec can make it fail as the filesystem would).
 * @returns whether this process now holds it.
 */
export function tryLock(
  lock: string,
  takeOver: (lock: string) => void = takeOverIfStale,
): boolean {
  const fresh = uniqueBeside(lock, "new");
  mkdirSync(fresh);
  writeFileSync(join(fresh, "pid"), String(process.pid));
  try {
    renameSync(fresh, lock);
    return true;
  } catch (error) {
    rmSync(fresh, { recursive: true, force: true });
    if (!hasCode(error, LOCK_RACE_CODES)) throw error;
  }
  try {
    takeOver(lock);
  } catch (error) {
    // EPERM: another user's lock in the sticky folder, never ours to move; wait for it.
    if (!hasCode(error, new Set([...LOCK_RACE_CODES, "EPERM"]))) throw error;
  }
  return false;
}

/**
 * Whether a lock's holder is gone: a pid no process has, or a pidless lock past its age.
 *
 * @param holder - what {@link holderOf} read.
 */
function isStale(holder: number | undefined): boolean {
  return holder !== undefined && !(PID.test(String(holder)) && alive(holder));
}

/**
 * Removes the lock if its holder is dead, renamed to a unique name first so the removal never reaches
 * a lock made after it. Takers are serialised by a second folder (`<lock>.takeover`, made with
 * `mkdir`): two waiters judging the same dead lock could otherwise both move "it", the second moving a
 * live lock made in between. Under it the dead lock cannot change (its holder is gone, other takers
 * wait), so the moved lock is checked against the one judged only as a defence, put back if it differs.
 * A takeover folder older than {@link PIDLESS_LOCK_MS} (its taker killed mid-way) is removed.
 *
 * @param lock - the lock folder.
 * @throws the filesystem's error when the lock changed under it (the caller looks again).
 */
function takeOverIfStale(lock: string): void {
  if (!isStale(holderOf(lock))) return;
  const takeover = `${lock}.takeover`;
  try {
    mkdirSync(takeover);
  } catch (error) {
    if (!hasCode(error, new Set(["EEXIST"]))) throw error;
    const made = statSync(takeover, { throwIfNoEntry: false })?.mtimeMs;
    if (made !== undefined && Date.now() - made > PIDLESS_LOCK_MS) {
      rmSync(takeover, { recursive: true, force: true });
    }
    return;
  }
  try {
    removeIfStale(lock);
  } finally {
    rmSync(takeover, { recursive: true, force: true });
  }
}

/**
 * The takeover itself, run only while holding `<lock>.takeover` ({@link takeOverIfStale}); exported
 * for its spec. The lock is judged again here: between the caller's look and the takeover folder,
 * another taker may have removed the dead lock and a live one been made in its place.
 *
 * @param lock - the lock folder.
 * @param beforeMove - run between judging and moving the lock (a seam for its spec to swap the lock).
 * @returns whether a dead holder's lock was removed.
 * @throws the filesystem's error when the lock changed under it.
 */
export function removeIfStale(
  lock: string,
  beforeMove: () => void = () => undefined,
): boolean {
  const holder = holderOf(lock);
  if (!isStale(holder)) return false;
  beforeMove();
  const moved = uniqueBeside(lock, "stale");
  renameSync(lock, moved);
  if (!Object.is(holderOf(moved), holder)) {
    renameSync(moved, lock); // Not the lock judged: hand it back.
    return false;
  }
  rmSync(moved, { recursive: true, force: true });
  return true;
}

/**
 * Releases a lock this process holds: renamed away first, so the removal can never reach a lock
 * another process takes the moment the path is free.
 *
 * @param lock - the lock folder.
 * @throws Error when the lock is no longer this process's: two specs overlapped, which must be loud.
 */
function releaseLock(lock: string): void {
  const taken = new Error(
    `the twin lock ${lock} was taken from this process (pid ${String(process.pid)}) while it held it.`,
  );
  const released = uniqueBeside(lock, "released");
  try {
    renameSync(lock, released);
  } catch (error) {
    if (hasCode(error, new Set(["ENOENT"]))) throw taken;
    throw error;
  }
  if (holderOf(released) !== process.pid) {
    renameSync(released, lock); // Someone else's: theirs to release.
    throw taken;
  }
  rmSync(released, { recursive: true, force: true });
}

/**
 * Adds `ms` to the running Playwright test's timeout; nothing outside one (a child process, a
 * script), nothing for no wait, and nothing to a test with no timeout (`0`, which a sum would set).
 *
 * @param ms - the time to add.
 * @param info - the running test's info (a parameter so a spec can hand a fake); Playwright's
 * `test.info()` by default, which throws when no test runs.
 */
export function extendRunningTest(
  ms: number,
  info: () => Pick<TestInfo, "timeout" | "setTimeout"> = () => test.info(),
): void {
  if (ms <= 0) return;
  let current: Pick<TestInfo, "timeout" | "setTimeout">;
  try {
    current = info();
  } catch {
    return; // No running test: `test.info()`'s one failure.
  }
  if (current.timeout === 0) return;
  current.setTimeout(current.timeout + ms);
}

/**
 * Runs `work` holding a twin alone: specs in other workers (other processes) that touch the same
 * twin wait, so one spec's reset never lands under another's commands. Held across the whole of
 * `work`, released however it ends.
 *
 * Each stretch spent waiting for the lock is added to the running test's timeout as it passes (not
 * once at the end, by when a long wait would have timed the test out): another spec can hold a twin
 * for minutes, and that wait says nothing about this test, whose timeout budgets only its own work.
 * A stretch runs from the end of the previous one (or the first look at the lock) to the end of
 * the next poll, so looking again counts as waiting too — on a loaded host those looks (a handful of
 * file-system calls each) add up to a good part of the wait — and the stretches sum to the whole
 * wait, with no per-stretch rounding piling up.
 *
 * @param stack - which twin.
 * @param work - what to do with it.
 * @param options - `lockDir` (default {@link TWIN_LOCK_DIR}), `timeoutMs` (default 10 min), `pollMs`
 * (how often a waiter looks again; default 200 ms), `onWaited` (given each stretch of waiting in ms,
 * never called when the lock was free; default {@link extendRunningTest}).
 * @returns what `work` returned.
 * @throws Error when the lock is not free within the timeout, or what `work` threw.
 */
export async function withTwin<T>(
  stack: TwinStack,
  work: () => Promise<T>,
  options: {
    readonly lockDir?: string;
    readonly timeoutMs?: number;
    readonly pollMs?: number;
    readonly onWaited?: (ms: number) => void;
  } = {},
): Promise<T> {
  const base = options.lockDir ?? TWIN_LOCK_DIR;
  ensureLockBase(base);
  const dir = join(base, `wpme-ssh-twin-${stack}.lock`);
  const onWaited = options.onWaited ?? extendRunningTest;
  let since = Date.now();
  const deadline = since + (options.timeoutMs ?? 600_000);
  while (!tryLock(dir)) {
    if (Date.now() > deadline) {
      throw new Error(
        `the ${stack} twin stayed locked (${dir}): another spec holds it, or a dead one ` +
          "another user (or a reused pid) left; remove the folder once no twin spec runs.",
      );
    }
    await sleep(options.pollMs ?? LOCK_POLL_MS);
    const now = Date.now();
    onWaited(now - since);
    since = now;
  }
  try {
    return await work();
  } finally {
    releaseLock(dir);
  }
}
