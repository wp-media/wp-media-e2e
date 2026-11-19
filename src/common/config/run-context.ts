import "./load-env";

import { fileURLToPath } from "node:url";

import { isNonEmptyString, isObject } from "../guards";
import { DEFAULT_REPORT_ROOT } from "../reporting/retention";
import { pinnedCell } from "./cell-pin";
import { env } from "./env";
import { formatRunId, isUsableRunId, runReportDir } from "./run-id";
import { resolveInvocationId } from "./invocation-id";

/**
 * Absolute repo root, derived from this module's own location
 * (`…/src/common/config/run-context.ts` → three levels up), so callers can absolutize the
 * repo-root-relative paths {@link dirs} returns **without depending on `process.cwd()`** —
 * which the artifacts resolver needs (APVM requires an absolute `outputDir`, and a
 * relative `E2E_*_ZIP` must resolve against the repo, not the process cwd).
 */
export const REPO_ROOT: string = fileURLToPath(
  new URL("../../../", import.meta.url),
);

// Read the `process` global directly (as env.ts / project.ts do) rather than destructuring
// `node:process`: `process.argv` is reassigned by our own tests and by tooling, and a
// destructured `argv` binding can snapshot a stale array under some loaders. Reading it live
// keeps cell selection loader-independent.

/**
 * Run context: resolves the namespaced artifact directories for a (product, cell) and
 * the per-run report token. Artifacts split into two lifecycles:
 *
 *  - report  → ACCUMULATES under `<REPORT_ROOT>/<product>/<cell>/<RUN_ID>` (one per
 *              run). Each run prunes its cell's folder as it ends — at most `E2E_REPORTS_KEEP`
 *              (20), none older than 30 days but the newest complete one, kept up to 182 days
 *              (`reporting/retention.ts`); `npm run report:prune` prunes every cell.
 *  - output / auth / bdd → EPHEMERAL, stable per (product, cell); overwritten in place
 *              each run, so they never accumulate.
 *
 * The `*_ROOT` env vars and `RUN_ID` are the only knobs (an orchestrator may pin RUN_ID
 * so every cell of a batch shares one token). The `<product>/<cell>` namespace is always
 * appended, so two cells never share a directory, and a run that targets no single cell
 * writes its output under {@link NO_CELL} instead ({@link outputDirFor}). A run is held to one
 * cell by `E2E_CELL` (see `cell-pin.ts`), or selects it with `--project`.
 */

/** Filesystem-safe, lexically-sortable run token. Used ONLY to namespace the report directory. */
function stamp(): string {
  // e.g. 2026-06-19T14-03-22-123Z-48217
  return formatRunId(new Date(), String(process.pid));
}

/**
 * `value` quoted for an error message, every control character escaped: `JSON.stringify` leaves
 * DEL, C1 (`U+009B` opens a terminal escape sequence) and the line separators `U+2028`/`U+2029` raw.
 */
function quoted(value: string): string {
  return JSON.stringify(value).replace(
    /[\u007f-\u009f\u2028\u2029]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/**
 * Resolves the run token: a non-blank inherited `RUN_ID`, else a fresh stamp pinned into env.
 *
 * @throws {@link Error} naming `RUN_ID` when the inherited one cannot name a report folder
 *   ({@link isUsableRunId}): a `/` would write the report outside its cell's folder.
 */
function resolveRunId(): string {
  const provided = process.env.RUN_ID;
  if (isNonEmptyString(provided)) {
    if (!isUsableRunId(provided)) {
      throw new Error(
        `RUN_ID=${quoted(provided)} cannot name a report folder: it must be one folder name — no "/" or ` +
          '"\\", not starting with ".", no control character, at most 255 bytes. Unset it for a ' +
          "fresh one.",
      );
    }
    return provided;
  }
  const stamped = stamp();
  // Pin it so every worker process (which re-imports this module) inherits one token.
  process.env.RUN_ID = stamped;
  return stamped;
}

/** One RUN_ID for the whole invocation. Only the report directory is namespaced by it. */
export const RUN_ID: string = resolveRunId();

/**
 * One random token per runner invocation, shared with the workers it forks and never pinned — what
 * tells two invocations apart where a shared `RUN_ID` cannot (`./invocation-id.ts`).
 */
export const INVOCATION_ID: string = resolveInvocationId({
  env: process.env,
  pid: process.pid,
  ppid: process.ppid,
});

/**
 * Internal channel carrying this invocation's `--project` selection to forked worker
 * processes. Playwright forks a worker **without** the CLI argv but **with** the parent's
 * environment, and each worker re-imports the config from scratch — so `process.argv` in a
 * worker holds only `[node, workerProcessEntry.js]` and project `metadata` a worker reads is
 * the one *it* just rebuilt, not the runner's. Any argv-derived decision must therefore ride
 * the environment, exactly as {@link RUN_ID} does. Seeded by {@link seedSelectedCells} while
 * the runner builds the config; never set by hand.
 *
 * The value names the process that wrote it — `{"pid": <runner>, "cells": [...]}` — and is believed
 * only by that process's **direct children** (`process.ppid`): Playwright forks its workers and its
 * out-of-process test loader straight from the runner. Anything else that inherited it — a run
 * started from inside another run — reads it as absent, so a stale selection never stands in for
 * what its own command line said.
 */
const SELECTED_CELLS_ENV = "E2E_INTERNAL_SELECTED_CELLS";

/** The seed's shape: who wrote it, and the selection it carries. */
interface SelectionSeed {
  /** The process that built the config with this selection on its command line. */
  readonly pid: number;
  /** That command line's `--project` values, verbatim. */
  readonly cells: readonly string[];
}

/**
 * Parses the `--project` forms out of the live `process.argv` (`--project=x`, `--project x`,
 * the variadic `--project x y`, and repeats) — the exact signal Playwright itself filters on.
 * Stops at `--`, after which Playwright reads every argument as a test-file filter. Empty in a
 * worker process, which never receives the CLI argv.
 */
function cellsFromArgv(): string[] {
  const cells = new Set<string>();
  const args = process.argv;
  const eq = "--project=";
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg === "--") break;
    if (arg.startsWith(eq)) {
      cells.add(arg.slice(eq.length));
    } else if (arg === "--project") {
      // Variadic: consume consecutive non-flag tokens (`--project a b`).
      for (let j = i + 1; j < args.length; j += 1) {
        const next = args[j];
        if (next === undefined || next.startsWith("-")) break;
        cells.add(next);
        i = j;
      }
    }
  }
  return [...cells];
}

/** The seed in the environment, or `undefined` when absent or not one {@link seedSelectedCells} writes. */
function readSeed(): SelectionSeed | undefined {
  const raw = process.env[SELECTED_CELLS_ENV];
  if (!isNonEmptyString(raw)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (
    !isObject(parsed) ||
    !Number.isInteger(parsed.pid) ||
    !Array.isArray(parsed.cells)
  ) {
    return undefined;
  }
  return {
    pid: parsed.pid as number,
    cells: parsed.cells.filter(
      (value): value is string => typeof value === "string",
    ),
  };
}

/** Whether the seed was written by this process's parent — this process is one of its workers. */
function seededByParent(seed: SelectionSeed | undefined): boolean {
  return seed?.pid === process.ppid;
}

/** The selection this process's runner seeded for it; `[]` when there is none for it. */
function cellsFromEnv(): string[] {
  const seed = readSeed();
  return seed !== undefined && seededByParent(seed) ? [...seed.cells] : [];
}

/**
 * The `--project` values this run was started with: from the command line, or — in a forked worker,
 * which has no argv — the selection {@link seedSelectedCells} published for it. Verbatim, so a
 * project name (`setup:<cell>`) or a wildcard comes back as typed. {@link selectedCells} answers
 * which cells the run targets; this answers what was typed, which the cell pin's checks and
 * {@link cellOwningOutput} need.
 */
export function projectSelection(): string[] {
  const fromArgv = cellsFromArgv();
  return fromArgv.length > 0 ? fromArgv : cellsFromEnv();
}

/**
 * The cells a run targets: the cell `E2E_CELL` pins it to, else its {@link projectSelection}. This
 * is the single source of truth for cell selection, so the config can never size workers for a cell
 * Playwright is not running, and a worker can tell an explicitly selected cell from a broad serial
 * run. The pin comes first because a pinned config holds no other cell: every process of the run
 * inherits it, `bddgen` included. A correct invocation selects exactly one cell; this returns ALL
 * requested values so the config factory can reject an unsafe multi-cell selection fail-fast.
 *
 * Unpinned, values come back **verbatim**, and callers compare them to cell names exactly.
 * Playwright's own project filter is looser — case-insensitive, and `*` wildcards expand — so a
 * selection like `--project='pro*'` runs a cell that no exact comparison here matches. That is
 * deliberate: such a selection is treated as broad, which for the artifacts setup means overrides
 * warn-and-drop rather than silently applying to cells the operator never named (and it keeps
 * `--project='*'` ⇒ serial). Beside a cell named exactly, though, a value that reaches another cell
 * that way is refused (`createProductConfig`). A pinned run has one cell whatever `--project` adds, so
 * it is always targeted. Name the cell exactly, or pin it, to target it.
 */
export function selectedCells(): string[] {
  const pin = pinnedCell();
  return pin === undefined ? projectSelection() : [pin];
}

/**
 * Publishes the command line's cell selection into the environment so forked worker
 * processes can read it back through {@link selectedCells}. Called while the config is built, in
 * every process of a run. In a worker — its parent wrote the seed — it changes nothing. Anywhere
 * else it writes this process's own selection, an empty one included, so a seed inherited from an
 * enclosing run never reaches this run's workers.
 */
export function seedSelectedCells(): void {
  if (seededByParent(readSeed())) return;
  const seed: SelectionSeed = { pid: process.pid, cells: cellsFromArgv() };
  process.env[SELECTED_CELLS_ENV] = JSON.stringify(seed);
}

/**
 * Whether this invocation explicitly **targeted** one cell, as opposed to sweeping every cell.
 * The inverse of a "serial" run, and the gate on whether per-run overrides may apply: an
 * override the operator set for one cell must not leak into a broad sweep of all of them.
 *
 * True when the run is pinned to the cell (`E2E_CELL`), when the selection names the cell itself
 * (`--project=<cell>`, whose dependency graph pulls the per-cell setup projects in), or when it
 * names the caller's own project (`--project=artifacts:<cell>` — how you resolve a cell's zips
 * without running its scenarios).
 * `projectName` is a parameter because only the caller knows which project it is running as.
 *
 * @param cell - the cell this project belongs to (from its routing metadata).
 * @param projectName - the running project's own name (`testInfo.project.name`).
 */
export function isCellTargeted(cell: string, projectName: string): boolean {
  const selected = selectedCells();
  return selected.includes(cell) || selected.includes(projectName);
}

export interface RunDirs {
  /** Accumulating per-run report directory. */
  readonly report: string;
  /** Ephemeral Playwright artifacts (traces/video/screenshots). */
  readonly output: string;
  /** Ephemeral per-site `storageState` directory. */
  readonly auth: string;
  /** Ephemeral generated BDD specs directory. */
  readonly bdd: string;
  /**
   * Ephemeral resolved-plugin-artifacts directory (the zips under test). Relative or absolute
   * like the rest; `cellArtifactsDir` resolves it against {@link REPO_ROOT} for the absolute
   * path APVM needs, and the resolver wipes it whole on every resolution.
   */
  readonly artifacts: string;
}

/**
 * Resolve the artifact directories for a (product, cell): relative to the repository root, or
 * absolute when their `*_ROOT` is — so a caller resolves them against {@link REPO_ROOT}, never
 * joins them onto it. A `*_ROOT` override replaces only the root prefix; the `<product>/<cell>`
 * namespace is always appended, so two cells never share a directory. Two runs of one cell do,
 * but for a report, which `RUN_ID` keeps apart.
 */
export function dirs(product: string, cell: string): RunDirs {
  const cellNs = `${product}/${cell}`;
  return {
    report: runReportDir(
      env("REPORT_ROOT", DEFAULT_REPORT_ROOT),
      product,
      cell,
      RUN_ID,
    ),
    output: `${env("OUTPUT_ROOT", "test-results")}/${cellNs}`,
    auth: `${env("AUTH_ROOT", ".auth")}/${cellNs}`,
    bdd: `.features-gen/${cellNs}`,
    artifacts: `${env("ARTIFACTS_ROOT", ".artifacts")}/${cellNs}`,
  };
}

/**
 * The folder, in place of a cell's, for what a run that targets no single cell writes — its
 * report, and its projects' output. `sites.ts` refuses a cell named so.
 */
export const NO_CELL = "_all";

/**
 * Where a project of `cell` writes its Playwright output (traces, videos, screenshots).
 *
 * Playwright empties the output folder of every project a run selects before it starts. A cell's
 * own folder therefore belongs only to runs that target that cell as a whole
 * ({@link cellOwningOutput}). Every other run's projects write under `<product>/_all/<cell>`: no
 * `--project` and no pin, a setup project alone, a wildcard, or another cell's project. So none of
 * those runs can empty the folder of a run in progress.
 *
 * @param targetedCell - the one cell this run targets as a whole, if any; `undefined` for any
 *   other run.
 */
export function outputDirFor(
  product: string,
  cell: string,
  targetedCell: string | undefined,
): string {
  return cell === targetedCell
    ? dirs(product, cell).output
    : `${dirs(product, NO_CELL).output}/${cell}`;
}

/**
 * The cell this run targets as a whole, which alone may write in its own output folder
 * ({@link outputDirFor}): the selected cell, when the run was started with no `--project` (only a
 * pin selects a cell then) or with the cell's own name. A selection of one of its setup projects
 * alone, or a wildcard, leaves the cell's folder to the run that owns it.
 *
 * @param selected - the one cell the run targets, from {@link selectedCells}; `undefined` if none.
 * @param selection - the run's `--project` values, from {@link projectSelection}.
 */
export function cellOwningOutput(
  selected: string | undefined,
  selection: readonly string[],
): string | undefined {
  if (selected === undefined) return undefined;
  return selection.length === 0 || selection.includes(selected)
    ? selected
    : undefined;
}
