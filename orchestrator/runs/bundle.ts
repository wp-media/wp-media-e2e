import { lstat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  KILL_GRACE_MS,
  releaseLeftoverWorkDirs,
  type AllureTraces,
  type BundleMode,
  type ReportBundle,
  type ReportBundleOptions,
} from "../../src/common/reporting/report-bundle";
import type { OrchestratorConfig } from "../config/schema";
import type { RunBundle } from "../events/run-finished";
import { describeBudget } from "./shutdown";
import { shellWord, textOf } from "../text";

/**
 * A run's download bundle, prepared once its processes have ended and before its `run.finished` is
 * built: the report bundle (`report-bundle.ts`) built in its report folder, within
 * {@link BUNDLE_BUDGET_MS} and the run's stop, and the one paste-ready command Slack and the terminal
 * give to fetch it. Best-effort: a bundle that fails, runs out of time or is stopped is one line and
 * no bundle — the run keeps its status, and Slack points at the raw report folder.
 */

/** The bundle settings in force: `reports.bundle`, defaults filled. */
export interface BundleSettings {
  readonly mode: BundleMode;
  readonly traces: AllureTraces;
}

/** The settings with no `reports.bundle`: an archive, Allure without traces (they stay in Playwright's). */
export const DEFAULT_BUNDLE: BundleSettings = {
  mode: "archive",
  traces: "strip",
};

/**
 * How long a bundle may take — Allure, the copies and `tar` together. The trace-heavy run measured
 * took 2.7 s; this bounds a hang, never a normal run. A drain lets it finish; an interrupt or a kill
 * stops it at once, so it never lengthens a shutdown past its budgets.
 */
export const BUNDLE_BUDGET_MS = 240_000;

/**
 * The settings in force.
 *
 * @param reports - the config's `reports`.
 * @returns `reports.bundle`, each choice not made the default's.
 */
export function bundleSettings(
  reports: OrchestratorConfig["reports"],
): BundleSettings {
  return {
    mode: reports?.bundle?.mode ?? DEFAULT_BUNDLE.mode,
    traces: reports?.bundle?.traces ?? DEFAULT_BUNDLE.traces,
  };
}

/**
 * A run's bundle name: unique per run, so bundles unpacked side by side never mix.
 *
 * @param product - the product.
 * @param cell - the cell.
 * @param runId - the run's `RUN_ID`.
 * @returns `backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442`.
 */
export function runBundleName(
  product: string,
  cell: string,
  runId: string,
): string {
  return `${product}-${cell}-${runId}`;
}

/**
 * What the event says of a built bundle: its archive when it has one (the download), else its folder.
 *
 * @param built - what the build made.
 * @returns the event's bundle; `null` when nothing was made (`none`).
 */
export function eventBundle(
  built: Pick<ReportBundle, "name" | "archive" | "folder">,
): RunBundle | null {
  if (built.archive !== null)
    return { kind: "archive", path: built.archive.path, name: built.name };
  if (built.folder !== null)
    return { kind: "folder", path: built.folder.path, name: built.name };
  return null;
}

/**
 * The command that fetches a run's archive and leaves `./<name>/`, pasted in a POSIX shell: the
 * download, the unpack, then the archive's removal — chained by `&&`, so a failed download or unpack
 * stops there and keeps the archive. Plain `rm`, never `-f`/`-r`. Every word is quoted for the shell
 * ({@link shellWord}); re-running it rewrites the same folder with the same content.
 *
 * @param sshHost - the host `scp` reaches the orchestrator's machine by.
 * @param archivePath - the archive, absolute.
 * @param name - the bundle's name: the folder it unpacks to.
 * @returns the command, unbounded: the caller decides whether it fits.
 * @example
 * ```ts
 * bundleCommand("auto-e2e", "/srv/e2e/reports/b/c/R/report.tar.gz", "b-c-R");
 * // "scp auto-e2e:/srv/e2e/reports/b/c/R/report.tar.gz b-c-R.tar.gz && tar -xzf b-c-R.tar.gz && rm b-c-R.tar.gz"
 * ```
 */
export function bundleCommand(
  sshHost: string,
  archivePath: string,
  name: string,
): string {
  const local = shellWord(`${name}.tar.gz`);
  return `scp ${sshHost}:${shellWord(archivePath)} ${local} && tar -xzf ${local} && rm ${local}`;
}

/**
 * The command that fetches a run's unpacked bundle folder as `./<name>/`.
 *
 * @param sshHost - the host `scp` reaches the orchestrator's machine by.
 * @param folderPath - the run's `report/`, absolute.
 * @param name - the bundle's name: the local folder.
 * @returns the command, unbounded.
 */
export function folderCommand(
  sshHost: string,
  folderPath: string,
  name: string,
): string {
  return `scp -r ${sshHost}:${shellWord(folderPath)} ${shellWord(name)}`;
}

/**
 * The command fetching a bundle, for its kind.
 *
 * @param bundle - the event's bundle.
 * @param sshHost - the `scp` host.
 * @returns {@link bundleCommand} or {@link folderCommand}.
 */
export function downloadCommand(bundle: RunBundle, sshHost: string): string {
  return bundle.kind === "archive"
    ? bundleCommand(sshHost, bundle.path, bundle.name)
    : folderCommand(sshHost, bundle.path, bundle.name);
}

/** How a cell is swept ({@link sweepCellLeftovers}). */
export interface CellSweep {
  /** Ends the sweep before its next run folder (and its next work folder). */
  readonly signal?: AbortSignal;
  /**
   * Releases only a work folder nothing in has been modified for longer than this: a folder another
   * host's live build is writing (a `reports/` shared across hosts) is never taken for a dead one.
   */
  readonly idleMs: number;
  /** The clock, in epoch milliseconds; `Date.now` by default. */
  readonly now?: () => number;
}

/**
 * Releases what SIGKILLed bundle builds and Allure generations left in every run folder of a cell
 * (`.bundle-work-*`, `.allure-work-*`, each a full copy): the next build of that same run, which
 * would otherwise do it, may never come. A folder goes only when its pid is not running (or is this
 * process's, idle) **and** nothing in it was modified for `idleMs`: a pid is per host, so a live
 * build on another host sharing `reports/` would otherwise look dead. Best-effort; a stop ends it
 * between folders.
 *
 * @param cellDir - `reports/<product>/<cell>/`.
 * @param sweep - its stop and idle time.
 * @param release - what releases one run's leftovers; `releaseLeftoverWorkDirs` by default.
 */
export async function sweepCellLeftovers(
  cellDir: string,
  sweep: CellSweep,
  release: (
    runDir: string,
    sweep: CellSweep,
  ) => Promise<void> = releaseLeftoverWorkDirs,
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cellDir);
  } catch {
    return;
  }
  for (const name of names.sort()) {
    if (sweep.signal?.aborted === true) return;
    // Hidden entries are no run's (the suite's retention sets folders aside under such names).
    if (name.startsWith(".")) continue;
    const runDir = join(cellDir, name);
    const stats = await lstat(runDir).catch(() => undefined);
    if (stats?.isDirectory() !== true) continue;
    await release(runDir, sweep).catch(() => undefined);
  }
}

/** Builds a report bundle: `buildReportBundle`, or a spec's stand-in. */
export type ReportBundler = (
  options: ReportBundleOptions,
) => Promise<ReportBundle>;

/** What {@link prepareBundle} is given. */
export interface PrepareBundleInput {
  /** The run's report folder, absolute. */
  readonly reportDir: string;
  /** {@link runBundleName}. */
  readonly name: string;
  readonly settings: BundleSettings;
  /** Aborted when the run is stopped past a drain: the build stops, nothing is put in place. */
  readonly stop: AbortSignal;
  /** The build's time limit; {@link BUNDLE_BUDGET_MS} by default. */
  readonly budgetMs?: number;
  readonly build: ReportBundler;
  /** Sweeps the cell's leftovers first, within the budget; {@link sweepCellLeftovers} by default. */
  readonly sweep?: (cellDir: string, sweep: CellSweep) => Promise<void>;
  /** Gets each line: the bundle's sizes and missing reports, or why there is none. */
  readonly say: (line: string) => void;
}

/**
 * Prepares a run's bundle. Never rejects: whatever fails is a line and `null`. The budget is armed
 * first, so it bounds everything after — the cell's sweep, the build —, and the stop and the budget
 * are checked between steps. A filesystem call that stalls (a hung mount) is not interruptible: the
 * build then returns once it does, past its budget; a shutdown stays bounded (it gives up waiting
 * `KILL_SETTLE_MS` after the kill).
 *
 * @param input - the run's folder, the bundle's name and settings, the stop, the builder.
 * @returns the event's bundle; `null` for `none`, a stopped run, no report folder, or a failure.
 */
export async function prepareBundle(
  input: PrepareBundleInput,
): Promise<RunBundle | null> {
  const { settings, stop, say } = input;
  if (settings.mode === "none") return null;
  if (stop.aborted) {
    say(`no report bundle: ${stopReason(stop)}`);
    return null;
  }
  const budgetMs = input.budgetMs ?? BUNDLE_BUDGET_MS;
  const budget = new AbortController();
  const timer = setTimeout(() => {
    budget.abort();
  }, budgetMs);
  const signal = AbortSignal.any([stop, budget.signal]);
  try {
    const folder = await lstat(input.reportDir).catch(() => undefined);
    if (folder?.isDirectory() !== true) {
      say("no report bundle: the run left no report folder");
      return null;
    }
    await (input.sweep ?? sweepCellLeftovers)(dirname(input.reportDir), {
      signal,
      // A build of this cell elsewhere ends within its budget and the kill's grace: older is left.
      idleMs: budgetMs + KILL_GRACE_MS,
    }).catch(() => undefined);
    if (signal.aborted) {
      say(
        `no report bundle: ${failedWhy(undefined, budget.signal, budgetMs, stop)}`,
      );
      return null;
    }
    const built = await input.build({
      runDir: input.reportDir,
      name: input.name,
      mode: settings.mode,
      traces: settings.traces,
      signal,
      log: say,
    });
    return eventBundle(built);
  } catch (error) {
    say(`no report bundle: ${failedWhy(error, budget.signal, budgetMs, stop)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a build failed: its budget ran out, the run was stopped, or what it threw.
 *
 * @param error - what the build threw.
 * @param budget - the budget's signal.
 * @param budgetMs - the budget.
 * @param stop - the run's stop.
 * @returns the reason, for the log.
 */
function failedWhy(
  error: unknown,
  budget: AbortSignal,
  budgetMs: number,
  stop: AbortSignal,
): string {
  if (budget.aborted)
    return `it took over ${describeBudget(budgetMs)}, so it was stopped`;
  return stop.aborted ? stopReason(stop) : textOf(error);
}

/**
 * Why the run's stop aborted the bundle.
 *
 * @param stop - the aborted signal; its reason is the stop's `why` when the cycle gave one.
 * @returns `the run was stopped: <why>`.
 */
function stopReason(stop: AbortSignal): string {
  const why: unknown = stop.reason;
  return typeof why === "string"
    ? `the run was stopped: ${why}`
    : "the run was stopped";
}
