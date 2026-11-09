import { randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { errorMessage } from "../guards";
import { allureReportPages, pagesNamingAnalytics } from "./allure-analytics";
import {
  AllureCliMissingError,
  AllureGenerationAbortedError,
  AllureGenerationFailedError,
  AllureResultsMissingError,
  MalformedAllureResultError,
} from "./allure-errors";
import {
  decodeTail,
  generateAllureReport,
  isProcessAlive,
  keepTail,
  releaseStaleWorkDirs as releaseStaleAllureWorkDirs,
  sweepMayRelease,
  type StaleWorkDirSweep,
  releaseWorkDir,
  staleWorkDirNames,
  WORK_ASIDE_DIR,
  WORK_TARGET_FILE,
  type AllureLayout,
  type AllureReport,
  type AllureReportOptions,
  type Move,
} from "./allure-report";
import type { AllureTraces } from "./allure-results";
import {
  BundleArchiveError,
  ReportBundleAbortedError,
  ReportBundleError,
} from "./bundle-errors";
import {
  FACTS_LIMIT,
  landingPage,
  parseLandingFacts,
  type LandingFacts,
} from "./bundle-landing";
import {
  allureEntry,
  bundleNameProblem,
  bundleOutputs,
  copiedReportEntry,
  COPIED_REPORTS,
  FACTS_FILE,
  isCopied,
  type AllureOutcome,
  type BundledReport,
  type BundleMode,
  type CopiedReport,
  type EntryKind,
  type ReportFolder,
} from "./bundle-manifest";
import { KILL_GRACE_MS, runInOwnGroup } from "./child-group";
import { errnoCode, readHead, treeBytesWithin } from "./report-tree";
import { formatBytes } from "./retention";

// What a caller needs to configure a bundle, from this one module.
export { BUNDLE_MODES, type BundleMode } from "./bundle-manifest";
export { type AllureTraces } from "./allure-results";
export { KILL_GRACE_MS } from "./child-group";

/**
 * A run's report bundle: what a person downloads to look at a run — a landing page, the Playwright
 * and Cucumber reports, a freshly generated Allure report and `run-facts.json` — as `<run>/report/`,
 * `<run>/report.tar.gz`, or both. The archive's one top-level entry is the bundle's name, so
 * `tar -xzf` leaves `<name>/index.html`. Nothing raw goes in (`allure-results/`, `results.jsonl`).
 *
 * Everything is built in a hidden, owner-only work folder inside the run and put in place by rename,
 * so a failure, a stop or a kill never leaves a partial bundle; the next bundle of that run removes a
 * killed one's work folder, first putting back an earlier `report/` it held aside. Nothing is ever
 * followed out of the run: a report folder that is a link is not copied, nor any link, FIFO or socket
 * inside one. Imports only Node and its sibling modules:
 * no `.env`, no `RUN_ID`.
 */

/** The bundle folder's name in the run, for `folder` and `both`. */
export const BUNDLE_DIR = "report";

/** The archive's name in the run, for `archive` and `both`. */
export const BUNDLE_ARCHIVE = "report.tar.gz";

/** A work folder's name: the owning process's pid, eight random hex digits. */
const WORK_NAME = /^\.bundle-work-(\d{1,10})-[0-9a-f]{8}$/;

/** The Allure report's place in the bundle. */
const ALLURE_DIR = "allure";

/** The archive as `tar` writes it, in the work folder. */
const WORK_ARCHIVE = "report.tar.gz";

/** This process's work folders still in use: never stale, whatever the pid says. */
const activeWorkDirs = new Set<string>();

/** What {@link buildReportBundle} is asked to do. */
export interface ReportBundleOptions {
  /** The run's report folder; must exist. */
  readonly runDir: string;
  /** The bundle's name, `<product>-<cell>-<RUN_ID>`: the unpacked folder's name. */
  readonly name: string;
  readonly mode: BundleMode;
  /** Strip Playwright traces from the Allure report (one file per plugin) or keep them (a folder). */
  readonly traces: AllureTraces;
  /**
   * Stops the build: Allure's and `tar`'s process groups (each runs in its own, `child-group.ts`, so a
   * signal to the caller's group never reaches them) are sent SIGTERM and waited for, nothing is put
   * in place. Not checked once the bundle is being put in place (at most three renames). A child still running
   * {@link ReportBundleOptions.killGraceMs} after SIGTERM is sent SIGKILL.
   */
  readonly signal?: AbortSignal;
  /** How long Allure and `tar` have to end after a stop's SIGTERM; default {@link KILL_GRACE_MS}. */
  readonly killGraceMs?: number;
  /** Gets one line per thing worth logging: the sizes, a missing report, Allure's failure. */
  readonly log?: (line: string) => void;
  /** The cell's Allure history; default `allure-history.jsonl` beside the run. */
  readonly historyPath?: string;
  /** Generates the Allure report; default {@link generateAllureReport}. */
  readonly generateAllure?: (
    options: AllureReportOptions,
  ) => Promise<AllureReport>;
  /** The Allure CLI handed to the generator; its default when absent. */
  readonly allureBin?: string;
  /** The `tar` to run; default `tar` on `PATH`. */
  readonly tarBin?: string;
}

/** One output put in place. */
export interface BundleOutput {
  /** Its path, absolute. */
  readonly path: string;
  readonly bytes: number;
}

/** What {@link buildReportBundle} made. */
export interface ReportBundle {
  readonly name: string;
  readonly mode: BundleMode;
  /** `<run>/report.tar.gz`; `null` when the mode builds none. */
  readonly archive: BundleOutput | null;
  /** `<run>/report/`; `null` when the mode builds none. */
  readonly folder: BundleOutput | null;
  /** The bytes the bundle holds unpacked; 0 for `none`. */
  readonly bytes: number;
  /** Every report, linked or said missing, as the landing page shows them. */
  readonly reports: readonly BundledReport[];
  /** Entries inside the copied reports left out: links, FIFOs, sockets — relative to the run. */
  readonly skipped: readonly string[];
  /** Allure pages whose analytics loader was not recognised, so left in (relative to `allure/`). */
  readonly analyticsLeft: readonly string[];
  /** Why Allure failed, in full (paths included), for the log; `null` when it did not. */
  readonly allureError: string | null;
}

/**
 * Builds a run's report bundle. First removes the work folders an ended build left in the run; then,
 * in a new one: copies the finished reports and `run-facts.json`, generates Allure into it (a failure
 * is said on the landing page and logged, never thrown), writes the landing page, packs the archive,
 * and puts the outputs in place — an existing `report/` replaced whole, `report.tar.gz` by rename. A
 * failure leaves the run's earlier outputs as they were.
 *
 * @param options - what to build.
 * @returns what was built; for `none`, nothing is done.
 * @throws {@link RangeError} for an unusable name or mode; {@link ReportBundleAbortedError} when
 *   stopped; {@link BundleArchiveError} when `tar` fails; {@link ReportBundleError} when the run
 *   folder is unusable or an output cannot be put in place; the filesystem's error when copying fails.
 */
export async function buildReportBundle(
  options: ReportBundleOptions,
): Promise<ReportBundle> {
  const problem = bundleNameProblem(options.name);
  if (problem !== undefined) {
    throw new RangeError(
      `The bundle name ${JSON.stringify(options.name)} ${problem}.`,
    );
  }
  const outputs = bundleOutputs(options.mode);
  if (!outputs.archive && !outputs.folder) {
    if (options.mode !== "none") {
      throw new RangeError(
        `Unknown bundle mode ${JSON.stringify(options.mode)}.`,
      );
    }
    return emptyBundle(options);
  }
  throwIfAborted(options.signal);
  const runDir = resolve(options.runDir);
  await assertRunFolder(runDir);
  await releaseStaleWorkDirs(runDir);
  const work = await createWorkDir(runDir);
  activeWorkDirs.add(work);
  try {
    const stage = join(work, options.name);
    await mkdir(stage, { mode: 0o700 });
    const built = await stageBundle(runDir, stage, options);
    const bytes = await treeBytesWithin(stage, options.signal);
    // Also what makes a size cut short by a stop never count.
    throwIfAborted(options.signal);
    let archive: string | undefined;
    if (outputs.archive) {
      archive = join(work, WORK_ARCHIVE);
      await packArchive(work, options.name, archive, options);
      await chmod(archive, 0o600);
    }
    throwIfAborted(options.signal);
    const placed = await placeOutputs(
      runDir,
      work,
      stage,
      archive,
      outputs.folder,
    );
    const bundle: ReportBundle = {
      name: options.name,
      mode: options.mode,
      archive: placed.archive,
      folder: placed.folder === null ? null : { ...placed.folder, bytes },
      bytes,
      ...built,
    };
    for (const line of bundleLog(bundle)) options.log?.(line);
    return bundle;
  } finally {
    activeWorkDirs.delete(work);
    // Kept only while it holds the one copy of an earlier `report/` that could not go back.
    await releaseWorkDir(work, { putBack: false });
  }
}

/**
 * The bundle `none` makes: nothing.
 *
 * @param options - the build's options.
 */
function emptyBundle(options: ReportBundleOptions): ReportBundle {
  return {
    name: options.name,
    mode: "none",
    archive: null,
    folder: null,
    bytes: 0,
    reports: [],
    skipped: [],
    analyticsLeft: [],
    allureError: null,
  };
}

/** What staging put in the bundle, beyond the files. */
type Staged = Pick<
  ReportBundle,
  "reports" | "skipped" | "analyticsLeft" | "allureError"
>;

/**
 * Fills the bundle's folder: the facts, the copied reports, Allure and the landing page.
 *
 * @param runDir - the run folder.
 * @param stage - the bundle's folder in the work folder, empty.
 * @param options - the build's options.
 */
async function stageBundle(
  runDir: string,
  stage: string,
  options: ReportBundleOptions,
): Promise<Staged> {
  const factsText = readFacts(join(runDir, FACTS_FILE));
  const facts = parseLandingFacts(factsText);
  if (facts !== undefined && factsText !== undefined) {
    await writeFile(join(stage, FACTS_FILE), factsText, { mode: 0o644 });
  }
  const reports: BundledReport[] = [];
  const skipped: string[] = [];
  for (const kind of COPIED_REPORTS) {
    throwIfAborted(options.signal);
    const folder = await inspectReportFolder(join(runDir, kind));
    reports.push(copiedReportEntry(kind, folder));
    if (isCopied(folder)) {
      skipped.push(...(await copyReport(runDir, kind, stage)));
    }
  }
  throwIfAborted(options.signal);
  const allure = await stageAllure(runDir, stage, facts, options);
  reports.push(allureEntry(allure.outcome));
  await writeFile(
    join(stage, "index.html"),
    landingPage({ name: options.name, facts, reports }),
    { mode: 0o644 },
  );
  return {
    reports,
    skipped: skipped.sort(),
    analyticsLeft: allure.analyticsLeft,
    allureError: allure.error ?? null,
  };
}

/**
 * The run's facts file, read without following a link or blocking on a FIFO.
 *
 * @param path - `run-facts.json`.
 * @returns its text; `undefined` when absent, not a regular file, unreadable or over
 *   {@link FACTS_LIMIT}.
 */
function readFacts(path: string): string | undefined {
  const text = readHead(path, FACTS_LIMIT + 1);
  return text === undefined || Buffer.byteLength(text) > FACTS_LIMIT
    ? undefined
    : text;
}

/**
 * A report folder of the run, as it is: what it is (a link is not followed), its `index.html`'s size
 * and the real folders in it.
 *
 * @param path - the folder.
 */
export async function inspectReportFolder(path: string): Promise<ReportFolder> {
  const kind = await entryKind(path);
  if (kind !== "folder") return { kind, folders: [] };
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch {
    return { kind: "unreadable", folders: [] };
  }
  const index = entries.find((entry) => entry.name === "index.html");
  const indexBytes =
    index?.isFile() === true
      ? await lstat(join(path, "index.html")).then(
          (stats) => stats.size,
          () => undefined,
        )
      : undefined;
  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  return indexBytes === undefined
    ? { kind, folders }
    : { kind, indexBytes, folders };
}

/**
 * What a path is, never following a link.
 *
 * @param path - the path.
 */
async function entryKind(path: string): Promise<EntryKind> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "link";
    if (stats.isDirectory()) return "folder";
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "missing" : "unreadable";
  }
}

/**
 * Copies one report folder into the bundle: folders and regular files only — a link, FIFO, socket or
 * device is left out. The filter is load-bearing: `fs.cp` would follow nothing out of the run, but it
 * throws on a FIFO or socket (`ERR_FS_CP_FIFO_PIPE`, `ERR_FS_CP_SOCKET`), failing the whole bundle;
 * the filter sees each entry before that check. Files are cloned where the filesystem can.
 *
 * @param runDir - the run folder.
 * @param kind - the report's folder name.
 * @param stage - the bundle's folder.
 * @returns the entries left out, relative to the run.
 */
async function copyReport(
  runDir: string,
  kind: CopiedReport,
  stage: string,
): Promise<string[]> {
  const skipped: string[] = [];
  await cp(join(runDir, kind), join(stage, kind), {
    recursive: true,
    errorOnExist: true,
    force: false,
    filter: async (source) => {
      const stats = await lstat(source);
      if (stats.isDirectory() || stats.isFile()) return true;
      skipped.push(relative(runDir, source));
      return false;
    },
  });
  return skipped.sort();
}

/** How the Allure step went, what its cleanup left, and its error's message when it failed. */
interface StagedAllure {
  readonly outcome: AllureOutcome;
  readonly analyticsLeft: readonly string[];
  readonly error?: string;
}

/**
 * Generates the run's Allure report into the bundle, named by the facts line, with the cell's
 * history. Best-effort: any failure but a stop becomes the reason on the landing page.
 *
 * @param runDir - the run folder.
 * @param stage - the bundle's folder.
 * @param facts - the run's facts, for the report's name.
 * @param options - the build's options.
 * @throws {@link ReportBundleAbortedError} when stopped.
 */
async function stageAllure(
  runDir: string,
  stage: string,
  facts: LandingFacts | undefined,
  options: ReportBundleOptions,
): Promise<StagedAllure> {
  const outputDir = join(stage, ALLURE_DIR);
  try {
    const report = await (options.generateAllure ?? generateAllureReport)({
      runDir,
      resultsDir: join(runDir, "allure-results"),
      outputDir,
      name: facts?.title ?? options.name,
      historyPath:
        options.historyPath ?? join(dirname(runDir), "allure-history.jsonl"),
      traces: options.traces,
      signal: options.signal,
      ...(options.killGraceMs === undefined
        ? {}
        : { killGraceMs: options.killGraceMs }),
      ...(options.allureBin === undefined
        ? {}
        : { allureBin: options.allureBin }),
    });
    return {
      outcome: {
        ok: true,
        layout: report.layout,
        pages: await allureReportPages(outputDir),
      },
      analyticsLeft: report.analytics.left,
    };
  } catch (error) {
    if (
      error instanceof AllureGenerationAbortedError ||
      options.signal?.aborted === true
    ) {
      throw new ReportBundleAbortedError();
    }
    // A report is put in place only whole, by rename: one there means only its history failed.
    const pages = await allureReportPages(outputDir).catch(() => []);
    if (pages.length > 0) {
      return {
        outcome: { ok: true, layout: defaultLayout(options.traces), pages },
        // The generator's cleanup result went with its error: what the placed pages hold says it.
        analyticsLeft: await pagesNamingAnalytics(outputDir),
        error: errorMessage(error),
      };
    }
    await rm(outputDir, { recursive: true, force: true });
    return {
      outcome: { ok: false, reason: allureFailureReason(error) },
      analyticsLeft: [],
      error: errorMessage(error),
    };
  }
}

/**
 * The layout the Allure generator picks for a trace policy when none is given.
 *
 * @param traces - the policy.
 */
function defaultLayout(traces: AllureTraces): AllureLayout {
  return traces === "strip" ? "single-file" : "folder";
}

/**
 * Why Allure is missing, for the landing page: short, with no path or command line.
 *
 * @param error - what generation threw.
 */
export function allureFailureReason(error: unknown): string {
  if (error instanceof AllureResultsMissingError) {
    return error.problem === "empty"
      ? "the run's Allure results hold no test result"
      : "the run left no Allure results";
  }
  if (error instanceof MalformedAllureResultError) {
    return `an Allure result is malformed (${basename(error.file)})`;
  }
  if (error instanceof AllureCliMissingError) {
    return `the Allure CLI could not be started (${error.code})`;
  }
  if (error instanceof AllureGenerationFailedError) {
    return error.exitCode === null
      ? `allure generate was ended by ${String(error.signal)}`
      : `allure generate failed (exit code ${String(error.exitCode)})`;
  }
  const code = errnoCode(error);
  return `the Allure report could not be generated${code === undefined ? "" : ` (${code})`}`;
}

/**
 * `tar`'s arguments: gzip the bundle's folder from the work folder, so its name is the archive's one
 * top-level entry. Never a rename option (`--transform`, `-s`): GNU and BSD tar spell it differently.
 * `--no-xattrs --no-acls` (both tars) keep macOS's extended attributes out, which GNU tar warns about
 * on every file.
 *
 * @param archive - the archive to write, absolute.
 * @param work - the folder holding the bundle's folder.
 * @param name - the bundle's folder name; never starts with `-` ({@link bundleNameProblem}).
 */
export function tarArgs(archive: string, work: string, name: string): string[] {
  return ["--no-xattrs", "--no-acls", "-czf", archive, "-C", work, name];
}

/**
 * `tar`'s environment: the caller's, with macOS's AppleDouble (`._*`) entries turned off — bsdtar
 * would otherwise add one per file, and GNU tar unpacks them as files. Ignored elsewhere.
 *
 * @param base - the environment to start from.
 */
export function tarEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...base, COPYFILE_DISABLE: "1" };
}

/**
 * Packs the bundle's folder with the system `tar`, and waits for it to end — after a stop too, so
 * nothing writes into the work folder once it is removed.
 *
 * @param work - the work folder, holding the bundle's folder.
 * @param name - the bundle's folder name.
 * @param archive - the archive to write.
 * @param options - the build's options (`tarBin`, `signal`).
 * @throws {@link ReportBundleAbortedError} when stopped; {@link BundleArchiveError} when it cannot be
 *   started or fails.
 */
async function packArchive(
  work: string,
  name: string,
  archive: string,
  options: ReportBundleOptions,
): Promise<void> {
  let output: Buffer = Buffer.alloc(0);
  const ended = await runInOwnGroup({
    bin: options.tarBin ?? "tar",
    args: tarArgs(archive, work, name),
    cwd: work,
    env: tarEnv(process.env),
    stdout: "ignore",
    stderr: "pipe",
    onOutput: (chunk) => {
      output = keepTail(output, chunk);
    },
    signal: options.signal,
    killGraceMs: options.killGraceMs ?? KILL_GRACE_MS,
  });
  throwIfAborted(options.signal);
  if (ended.kind === "spawn-error") {
    throw new BundleArchiveError(`it could not be started: ${ended.code}`, "");
  }
  if (ended.code !== 0) {
    throw new BundleArchiveError(
      ended.code === null
        ? `signal ${String(ended.signal)}`
        : `exit code ${String(ended.code)}`,
      decodeTail(output),
    );
  }
}

/** What {@link placeOutputs} put in place. */
interface Placed {
  readonly archive: BundleOutput | null;
  readonly folder: BundleOutput | null;
}

/**
 * Puts the outputs in place: the folder first (an existing `report/` moved aside), then the archive
 * by rename (an existing one replaced at once). If the archive cannot go in, the folder is undone:
 * the earlier one moved back. A failure therefore leaves the run's earlier outputs as they were.
 *
 * @param runDir - the run folder.
 * @param work - the work folder.
 * @param stage - the bundle's folder.
 * @param archive - the packed archive, when the mode builds one.
 * @param folder - whether the mode keeps the folder.
 * @throws {@link ReportBundleError} when an output cannot be put in place.
 */
async function placeOutputs(
  runDir: string,
  work: string,
  stage: string,
  archive: string | undefined,
  folder: boolean,
): Promise<Placed> {
  const folderPath = join(runDir, BUNDLE_DIR);
  const archivePath = join(runDir, BUNDLE_ARCHIVE);
  const aside = join(work, WORK_ASIDE_DIR);
  let movedAside = false;
  if (folder) {
    await chmod(stage, 0o700);
    movedAside = await placeFolder(stage, folderPath, aside);
  }
  if (archive === undefined) {
    return { archive: null, folder: { path: folderPath, bytes: 0 } };
  }
  const bytes = (await stat(archive)).size;
  try {
    await rename(archive, archivePath);
  } catch (error) {
    if (folder)
      await undoFolder(folderPath, join(work, "undone"), aside, movedAside);
    throw new ReportBundleError(
      `Cannot put the report bundle in place at ${archivePath} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
  return {
    archive: { path: archivePath, bytes },
    folder: folder ? { path: folderPath, bytes: 0 } : null,
  };
}

/**
 * Moves the bundle's folder to `report/`, an existing one (or a link, or a file, there) moved aside
 * first, and back if the new one cannot go in. One that cannot be moved back stays in `aside`, which
 * the work folder's release keeps and the next build puts back.
 *
 * @param built - the bundle's folder.
 * @param target - `<run>/report`.
 * @param aside - where an existing one waits, in the work folder.
 * @param move - the rename; default `fs.rename`.
 * @returns whether an existing one was moved aside.
 * @throws {@link ReportBundleError} when it cannot be put in place.
 */
export async function placeFolder(
  built: string,
  target: string,
  aside: string,
  move: Move = rename,
): Promise<boolean> {
  let movedAside = false;
  try {
    movedAside = await move(target, aside).then(
      () => true,
      (error: unknown) => {
        if (errnoCode(error) !== "ENOENT") throw error;
        return false;
      },
    );
    await move(built, target);
    return movedAside;
  } catch (error) {
    if (movedAside) await move(aside, target).catch(() => undefined);
    throw new ReportBundleError(
      `Cannot put the report bundle in place at ${target} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
}

/**
 * Takes a just-placed `report/` back out, and puts the earlier one back. Best-effort: it runs only
 * when the archive could not go in, which is the error reported.
 *
 * @param target - `<run>/report`.
 * @param discard - where the new one goes, in the work folder (removed with it).
 * @param aside - where the earlier one waits.
 * @param movedAside - whether there was an earlier one.
 */
async function undoFolder(
  target: string,
  discard: string,
  aside: string,
  movedAside: boolean,
): Promise<void> {
  try {
    await rename(target, discard);
    if (movedAside) await rename(aside, target);
  } catch {
    // Left as it is: the new folder, complete, stays in place.
  }
}

/**
 * The log lines a built bundle gets: where it is and how big, then each report missing, the entries
 * left out and the Allure pages still loading analytics.
 *
 * @param bundle - the bundle.
 */
export function bundleLog(bundle: ReportBundle): string[] {
  const where = [
    ...(bundle.archive === null
      ? []
      : [`${bundle.archive.path} (${formatBytes(bundle.archive.bytes)})`]),
    ...(bundle.folder === null ? [] : [`${bundle.folder.path}/`]),
  ].join(" and ");
  const lines = [
    `Report bundle ${bundle.name}: ${where}; ${formatBytes(bundle.bytes)} unpacked.`,
  ];
  for (const report of bundle.reports) {
    if (!report.present) {
      const why =
        report.kind === "allure" && bundle.allureError !== null
          ? bundle.allureError
          : `${report.reason}.`;
      lines.push(`Report bundle: no ${report.kind} report — ${why}`);
    }
  }
  const allure = bundle.reports.find((report) => report.kind === "allure");
  if (allure?.present === true && bundle.allureError !== null) {
    lines.push(`Report bundle: Allure — ${bundle.allureError}`);
  }
  if (bundle.skipped.length > 0) {
    lines.push(
      `Report bundle: left out ${String(bundle.skipped.length)} link(s) or special file(s): ` +
        `${bundle.skipped.slice(0, 5).join(", ")}${bundle.skipped.length > 5 ? ", …" : ""}.`,
    );
  }
  if (bundle.analyticsLeft.length > 0) {
    lines.push(
      "Report bundle: Allure's analytics loader was not recognised, so left in: " +
        `${bundle.analyticsLeft.join(", ")}.`,
    );
  }
  return lines;
}

/**
 * Checks the run folder is a folder.
 *
 * @param runDir - the run folder.
 * @throws {@link ReportBundleError} when it is missing or not a folder.
 */
async function assertRunFolder(runDir: string): Promise<void> {
  try {
    if ((await stat(runDir)).isDirectory()) return;
  } catch (error) {
    throw new ReportBundleError(
      `No run folder at ${runDir} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
  throw new ReportBundleError(`The run folder ${runDir} is not a folder.`);
}

/**
 * Releases what ended builds and Allure generations left in a run (both kinds of work folder,
 * {@link releaseStaleWorkDirs}): for a caller sweeping runs it will not bundle again, since a
 * SIGKILLed build's leftovers otherwise wait for the next build of that same run. Best-effort, never
 * rejects; a folder of a live process, or this process's in use, is left alone — and, under the
 * sweep's terms, one modified too recently, or any once its signal aborts.
 *
 * @param runDir - the run folder.
 * @param sweep - the sweep's terms ({@link StaleWorkDirSweep}).
 */
export async function releaseLeftoverWorkDirs(
  runDir: string,
  sweep: StaleWorkDirSweep = {},
): Promise<void> {
  await releaseStaleWorkDirs(runDir, sweep).catch(() => undefined);
  await releaseStaleAllureWorkDirs(runDir, sweep).catch(() => undefined);
}

/**
 * Releases the work folders no build uses any more: named for a pid no longer running, or for this
 * process's but not in use. An earlier `report/` a killed build left aside goes back first when its
 * place is empty, as the Allure generator's do ({@link releaseWorkDir}). Best-effort: one that cannot
 * be released goes with the run.
 *
 * @param runDir - the run folder.
 * @param sweep - a sweep's further terms; none for a build's own run.
 */
async function releaseStaleWorkDirs(
  runDir: string,
  sweep: StaleWorkDirSweep = {},
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch {
    return;
  }
  const stale = staleWorkDirNames(
    names,
    {
      isAlive: isProcessAlive,
      ownPid: process.pid,
      active: new Set([...activeWorkDirs].map((work) => basename(work))),
    },
    WORK_NAME,
  );
  for (const name of stale) {
    if (sweep.signal?.aborted === true) return;
    const work = join(runDir, name);
    if (!(await sweepMayRelease(work, sweep))) continue;
    await releaseWorkDir(work, { putBack: true }).catch(() => false);
  }
}

/**
 * Creates this build's work folder in the run, owner-only (the bundle holds traces, and those
 * session cookies), recording `report/`'s place in it: what puts an earlier one left aside back.
 *
 * @param runDir - the run folder.
 * @returns its path.
 * @throws {@link ReportBundleError} when the run folder is not writable.
 */
async function createWorkDir(runDir: string): Promise<string> {
  const work = join(
    runDir,
    `.bundle-work-${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  /** The error saying the run folder cannot be worked in. */
  const cannotWork = (error: unknown): ReportBundleError =>
    new ReportBundleError(
      `Cannot work in the run folder ${runDir} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  try {
    await mkdir(work, { mode: 0o700 });
  } catch (error) {
    throw cannotWork(error);
  }
  try {
    await writeFile(join(work, WORK_TARGET_FILE), join(runDir, BUNDLE_DIR));
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw cannotWork(error);
  }
  return work;
}

/**
 * Throws when the caller asked to stop.
 *
 * @param signal - the caller's abort signal.
 * @throws {@link ReportBundleAbortedError} when it is aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new ReportBundleAbortedError();
}
