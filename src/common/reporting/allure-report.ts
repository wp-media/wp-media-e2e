import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  removeAllureAnalytics,
  type AnalyticsCleanup,
} from "./allure-analytics";
import { keepOneLinePerRun, readHistoryText } from "./allure-history";
import {
  AllureCliMissingError,
  AllureGenerationAbortedError,
  AllureGenerationFailedError,
  AllureReportError,
} from "./allure-errors";
import {
  copyAllureResults,
  type AllureTraces,
  type CopiedResults,
} from "./allure-results";
import { errnoCode } from "./report-tree";

/**
 * Generating one run's Allure report: `allure generate` over a copy of the run's results (traces
 * stripped or kept), named explicitly, with the cell's history for the trend chart. Everything is
 * built in a hidden work folder inside the run and put in place by rename only once Allure
 * succeeded, so a failure — or a kill — never leaves a partial report or history. Before it goes in,
 * the plugins' analytics loader is removed from its pages (`allure-analytics.ts`), so the report does
 * not phone home; a page it is not recognised in is left as written and named in the result. A good report is
 * replaced only by a new one: the old one waits in the work folder while the new one goes in, and
 * if that is cut short (a failure, a kill) it is moved back — at once, or by the next generation in
 * that run, which the work folder's `target` file tells where. Imports only Node and its sibling
 * modules: no `.env`, no `RUN_ID`.
 */

/** How the report is laid out: one HTML file per plugin, or a folder of data files. */
export type AllureLayout = "single-file" | "folder";

/** The checkout's root, which holds `node_modules/` and `allurerc.mjs`. */
const CHECKOUT = fileURLToPath(new URL("../../../", import.meta.url));

/** The Allure CLI the checkout installs. */
export const DEFAULT_ALLURE_BIN = join(
  CHECKOUT,
  "node_modules",
  ".bin",
  "allure",
);

/** The suite's Allure configuration (categories, plugins, history from `ALLURE_HISTORY`). */
export const DEFAULT_ALLURE_CONFIG = join(CHECKOUT, "allurerc.mjs");

/** The work folder's name prefix: hidden, inside the run. */
const WORK_PREFIX = ".allure-work-";

/** A work folder's name: the prefix, the owning process's pid, eight random hex digits. */
const WORK_NAME = /^\.allure-work-(\d{1,10})-[0-9a-f]{8}$/;

/**
 * The work folder's file holding the report's place (`outputDir`), for {@link releaseWorkDir}. The
 * report bundle's work folder records its own the same way.
 */
export const WORK_TARGET_FILE = "target";

/** The work folder's entry an existing report waits in while the new one goes in (the bundle's too). */
export const WORK_ASIDE_DIR = "previous";

/** At most how many bytes of Allure's output an error keeps, when it is captured: the last ones. */
export const OUTPUT_TAIL_BYTES = 16 * 1024;

/** This process's work folders still in use: never stale, whatever the pid says. */
const activeWorkDirs = new Set<string>();

/** What {@link generateAllureReport} is asked to do. */
export interface AllureReportOptions {
  /** The run's report folder: the work folder lives in it, so the output must be on its filesystem. */
  readonly runDir: string;
  /** The run's `allure-results/`; only read. */
  readonly resultsDir: string;
  /** Where the report goes (usually `<runDir>/allure`); replaced whole, only on success. */
  readonly outputDir: string;
  /** The report's header (`--name`): the run's facts line. Must not be blank. */
  readonly name: string;
  /** The cell's `allure-history.jsonl`: read for the trend; on success it holds this run's line, once. */
  readonly historyPath: string;
  /** Strip or keep Playwright traces. */
  readonly traces: AllureTraces;
  /**
   * The layout. Default: `single-file` when stripping (portable: opens from disk), `folder` when
   * keeping — a single file inlines every trace as base64 and Allure refuses one too large; a
   * folder report needs an HTTP server (`allure open`), browsers block its data from `file://`.
   */
  readonly layout?: AllureLayout;
  /** Allure's own output: printed through (`inherit`) or captured for an error (`pipe`, default). */
  readonly stdio?: "inherit" | "pipe";
  /**
   * Stops generation: Allure is sent SIGTERM and waited for, nothing is put in place. Not checked
   * once the report is being put in place (two renames).
   */
  readonly signal?: AbortSignal;
  /** The CLI to run; default {@link DEFAULT_ALLURE_BIN}. */
  readonly allureBin?: string;
  /** The Allure config; default {@link DEFAULT_ALLURE_CONFIG}. */
  readonly configPath?: string;
}

/** What {@link generateAllureReport} made. */
export interface AllureReport extends CopiedResults {
  /** The report folder, absolute. */
  readonly outputDir: string;
  /** The history file holding this run's line, absolute. */
  readonly historyPath: string;
  readonly layout: AllureLayout;
  /** The pages the analytics loader was removed from, and those it could not be (left as written). */
  readonly analytics: AnalyticsCleanup;
}

/**
 * Generates one run's Allure report. First releases the work folders an ended generation left in
 * the run ({@link releaseWorkDir}: a report left aside goes back); copies the results (validated,
 * traces stripped or kept); runs `allure generate` on the copy into the work folder, against a copy
 * of the history; removes the analytics loader from its pages; keeps one history line per run
 * (`allure-history.ts`: a run reported again replaces its own line); then puts the report in place
 * (an existing one is replaced whole) and the history after it. On any failure the previous report and history are left as they were — or, when the old
 * report cannot be moved back, kept in the work folder for the next generation in that run (the
 * error says where) — and the work folder is otherwise removed.
 *
 * Two runs of different cells may generate at once (separate folders and histories). Two of the
 * same cell at once both succeed, but the history keeps only the last one's entry.
 *
 * @param options - what to generate; relative paths resolve against the working directory.
 * @returns the report made.
 * @throws {@link RangeError} for a blank name; {@link AllureResultsMissingError} or
 *   {@link MalformedAllureResultError} for results with nothing (valid) to report;
 *   {@link AllureCliMissingError}; {@link AllureGenerationFailedError};
 *   {@link AllureGenerationAbortedError}; {@link AllureReportError} when the report or history
 *   cannot be put in place; the filesystem's error when copying fails.
 */
export async function generateAllureReport(
  options: AllureReportOptions,
): Promise<AllureReport> {
  if (options.name.trim() === "") {
    throw new RangeError("An Allure report needs a name.");
  }
  const runDir = resolve(options.runDir);
  const outputDir = resolve(options.outputDir);
  const historyPath = resolve(options.historyPath);
  const layout =
    options.layout ?? (options.traces === "strip" ? "single-file" : "folder");
  throwIfAborted(options.signal);
  await releaseStaleWorkDirs(runDir);
  const work = await createWorkDir(runDir, outputDir);
  activeWorkDirs.add(work);
  try {
    const copied = await copyAllureResults(
      resolve(options.resultsDir),
      join(work, "results"),
      options.traces,
    );
    const workHistory = join(work, "history.jsonl");
    await copyIfPresent(historyPath, workHistory);
    const historyBefore = await readHistoryText(workHistory);
    throwIfAborted(options.signal);
    await runAllureGenerate({
      bin: options.allureBin ?? DEFAULT_ALLURE_BIN,
      args: allureGenerateArgs({
        resultsDir: join(work, "results"),
        outputDir: join(work, "report"),
        configPath: resolve(options.configPath ?? DEFAULT_ALLURE_CONFIG),
        name: options.name,
      }),
      env: allureEnv(process.env, workHistory, layout),
      cwd: work,
      stdio: options.stdio ?? "pipe",
      signal: options.signal,
    });
    const analytics = await removeAllureAnalytics(join(work, "report"));
    await keepOneLinePerRun(workHistory, historyBefore, basename(runDir));
    await placeReport(
      join(work, "report"),
      outputDir,
      join(work, WORK_ASIDE_DIR),
    );
    await placeHistory(workHistory, historyPath, outputDir);
    return { ...copied, outputDir, historyPath, layout, analytics };
  } finally {
    activeWorkDirs.delete(work);
    await releaseWorkDir(work, { putBack: false });
  }
}

/**
 * `allure generate`'s arguments: the results, the output, the config and the name.
 *
 * @param paths - the results copy, the output folder and the config, absolute; the report's name.
 */
export function allureGenerateArgs(paths: {
  readonly resultsDir: string;
  readonly outputDir: string;
  readonly configPath: string;
  readonly name: string;
}): string[] {
  return [
    "generate",
    paths.resultsDir,
    "-o",
    paths.outputDir,
    "-c",
    paths.configPath,
    "--name",
    paths.name,
  ];
}

/**
 * Allure's environment: the caller's, plus the history file `allurerc.mjs` reads (`ALLURE_HISTORY`)
 * and its layout switch (`ALLURE_SINGLE_FILE`).
 *
 * @param base - the environment to start from.
 * @param historyPath - the history file Allure reads and appends to.
 * @param layout - the report's layout.
 */
export function allureEnv(
  base: NodeJS.ProcessEnv,
  historyPath: string,
  layout: AllureLayout,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ALLURE_HISTORY: historyPath,
    ALLURE_SINGLE_FILE: layout === "single-file" ? "true" : "false",
  };
}

/** Who owns a work folder, for {@link staleWorkDirNames}. */
export interface WorkDirOwners {
  /** Whether a pid is running. */
  readonly isAlive: (pid: number) => boolean;
  /** This process's pid: its folders are judged by {@link WorkDirOwners.active}, not by the pid. */
  readonly ownPid: number;
  /** This process's folders still in use, by name. */
  readonly active: ReadonlySet<string>;
}

/**
 * The work folders no generation uses any more: named for a pid no longer running, or for this
 * process's pid but not in use (a long-lived caller's earlier generation). One whose pid is alive
 * in another process — or was reused — is left alone; it goes with the run.
 *
 * @param names - the run folder's entries.
 * @param owners - who runs.
 * @param pattern - what a work folder's name looks like, the owning pid its first group; default
 *   this module's (`.allure-work-<pid>-<hex>`). The report bundle passes its own.
 * @returns the names to release.
 */
export function staleWorkDirNames(
  names: readonly string[],
  owners: WorkDirOwners,
  pattern: RegExp = WORK_NAME,
): string[] {
  return names.filter((name) => {
    const digits = pattern.exec(name)?.[1];
    if (digits === undefined) return false;
    const pid = Number(digits);
    return pid === owners.ownPid
      ? !owners.active.has(name)
      : !owners.isAlive(pid);
  });
}

/**
 * Whether a process runs: `kill(pid, 0)` succeeds, or is refused (`EPERM`: someone else's).
 *
 * @param pid - the process id.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errnoCode(error) === "EPERM";
  }
}

/**
 * Releases the work folders no generation uses any more ({@link staleWorkDirNames}), a report left
 * aside put back. Best-effort: one that cannot be released stays, and goes with the run.
 *
 * @param runDir - the run's folder.
 */
async function releaseStaleWorkDirs(runDir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(runDir);
  } catch {
    return;
  }
  const owners: WorkDirOwners = {
    isAlive: isProcessAlive,
    ownPid: process.pid,
    active: new Set([...activeWorkDirs].map((work) => basename(work))),
  };
  for (const name of staleWorkDirNames(names, owners)) {
    await releaseWorkDir(join(runDir, name), { putBack: true }).catch(
      () => undefined,
    );
  }
}

/**
 * Removes a work folder, unless it holds the only copy of a report: one moved aside
 * (`previous/`) whose place (the `target` file) is empty. With `putBack` that report is moved back
 * first; without — or when it cannot be, or its place is unknown — the folder stays, for a later
 * generation in the run (or the run's own removal). A place that is no longer empty means a new
 * report went in, so the old one goes.
 *
 * @param work - the work folder.
 * @param how - `putBack`: move a report left aside back to its place.
 * @returns whether the folder was removed.
 */
export async function releaseWorkDir(
  work: string,
  how: { readonly putBack: boolean },
): Promise<boolean> {
  const aside = join(work, WORK_ASIDE_DIR);
  const asidePresence = await presence(aside);
  if (asidePresence === "unknown") return false;
  if (asidePresence === "present") {
    const target = await readTarget(work);
    if (target === undefined) return false;
    const targetPresence = await presence(target);
    if (targetPresence === "unknown") return false;
    if (targetPresence === "absent") {
      if (!how.putBack) return false;
      try {
        // A rename never replaces a folder with content: a target that appeared since stays.
        await rename(aside, target);
      } catch {
        return false;
      }
    }
  }
  await rm(work, { recursive: true, force: true });
  return true;
}

/**
 * Whether a path exists (a link counts, never followed).
 *
 * @param path - the path.
 * @returns `unknown` when it cannot be told (permissions, I/O).
 */
async function presence(
  path: string,
): Promise<"present" | "absent" | "unknown"> {
  try {
    await lstat(path);
    return "present";
  } catch (error) {
    return errnoCode(error) === "ENOENT" ? "absent" : "unknown";
  }
}

/**
 * The report's place a work folder recorded.
 *
 * @param work - the work folder.
 * @returns it; `undefined` when unreadable or not an absolute path.
 */
async function readTarget(work: string): Promise<string | undefined> {
  try {
    const target = await readFile(join(work, WORK_TARGET_FILE), "utf8");
    return isAbsolute(target) && !target.includes("\0") ? target : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Creates this generation's work folder in the run (owner-only: its copies hold traces, and those
 * session cookies), recording the report's place in it.
 *
 * @param runDir - the run's folder, which must exist.
 * @param outputDir - the report's place, absolute.
 * @returns its path.
 * @throws {@link AllureReportError} when the run folder is missing or not writable.
 */
async function createWorkDir(
  runDir: string,
  outputDir: string,
): Promise<string> {
  const work = join(
    runDir,
    `${WORK_PREFIX}${String(process.pid)}-${randomBytes(4).toString("hex")}`,
  );
  try {
    await mkdir(work, { mode: 0o700 });
  } catch (error) {
    throw new AllureReportError(
      `Cannot work in the run folder ${runDir} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
  try {
    await writeFile(join(work, WORK_TARGET_FILE), outputDir);
  } catch (error) {
    await rm(work, { recursive: true, force: true });
    throw new AllureReportError(
      `Cannot work in the run folder ${runDir} (${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
  return work;
}

/**
 * Copies a file, if there is one: the history the first run of a cell does not have yet.
 *
 * @param from - the file.
 * @param to - the copy.
 */
async function copyIfPresent(from: string, to: string): Promise<void> {
  try {
    await copyFile(from, to);
  } catch (error) {
    if (errnoCode(error) !== "ENOENT") throw error;
  }
}

/**
 * Throws when the caller asked to stop.
 *
 * @param signal - the caller's abort signal.
 * @throws {@link AllureGenerationAbortedError} when it is aborted.
 */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new AllureGenerationAbortedError();
}

/** One `allure generate` to run. */
interface AllureInvocation {
  readonly bin: string;
  readonly args: readonly string[];
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly stdio: "inherit" | "pipe";
  readonly signal: AbortSignal | undefined;
}

/**
 * Runs the Allure CLI and waits for it to end — after a stop too, so nothing writes into the work
 * folder once it is removed.
 *
 * @param invocation - what to run.
 * @throws {@link AllureCliMissingError} when it cannot be started;
 *   {@link AllureGenerationAbortedError} when stopped; {@link AllureGenerationFailedError} when it
 *   fails.
 */
async function runAllureGenerate(invocation: AllureInvocation): Promise<void> {
  const child = spawn(invocation.bin, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    stdio: ["ignore", invocation.stdio, invocation.stdio],
    signal: invocation.signal,
  });
  let output: Buffer = Buffer.alloc(0);
  /** Keeps the end of what Allure printed. */
  const capture = (chunk: Buffer): void => {
    output = keepTail(output, chunk);
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const ended = await new Promise<
    | { kind: "spawn-error"; code: string }
    | { kind: "closed"; code: number | null; signal: NodeJS.Signals | null }
  >((settle) => {
    child.once("error", (error) => {
      // A child that never started (no pid) ends here. Anything else — an abort's `AbortError`
      // included — comes from a running one, and its `close` follows: waited for.
      if (child.pid === undefined) {
        settle({ kind: "spawn-error", code: errnoCode(error) ?? error.name });
      }
    });
    child.once("close", (code, signal) => {
      settle({ kind: "closed", code, signal });
    });
  });
  throwIfAborted(invocation.signal);
  if (ended.kind === "spawn-error") {
    throw new AllureCliMissingError(invocation.bin, ended.code);
  }
  if (ended.code !== 0) {
    throw new AllureGenerationFailedError(
      ended.code,
      ended.signal,
      decodeTail(output),
    );
  }
}

/**
 * The last bytes of some output with a chunk added: at most `limit`, so a chatty Allure cannot fill
 * the memory. Bytes, not characters, so a character split across chunks is decoded whole.
 *
 * @param tail - the end kept so far.
 * @param chunk - what came next.
 * @param limit - the most bytes kept; default {@link OUTPUT_TAIL_BYTES}.
 */
export function keepTail(
  tail: Buffer,
  chunk: Buffer,
  limit: number = OUTPUT_TAIL_BYTES,
): Buffer {
  const joined = Buffer.concat([tail, chunk]);
  return joined.length > limit
    ? joined.subarray(joined.length - limit)
    : joined;
}

/**
 * A kept tail as text. A cut through a UTF-8 character leaves up to three of its continuation bytes
 * (`10xxxxxx`) at the start: skipped, never decoded as U+FFFD.
 *
 * @param tail - from {@link keepTail}.
 */
export function decodeTail(tail: Buffer): string {
  let start = 0;
  while (start < 3 && ((tail[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return tail.subarray(start).toString("utf8");
}

/** Renames a path: `fs.rename`, or a spec's stand-in that fails as a filesystem can. */
export type Move = (from: string, to: string) => Promise<void>;

/**
 * Puts the built report at its place: an existing one is moved aside first, and moved back if the
 * new one cannot go in.
 *
 * @param built - the report in the work folder.
 * @param outputDir - its place.
 * @param aside - where an existing report waits, in the work folder.
 * @param move - the rename; default `fs.rename`.
 * @throws {@link AllureReportError} when it cannot be put in place (another filesystem included);
 *   its message says where the old report waits when it could not be moved back.
 */
export async function placeReport(
  built: string,
  outputDir: string,
  aside: string,
  move: Move = rename,
): Promise<void> {
  let movedAside = false;
  try {
    await mkdir(dirname(outputDir), { recursive: true });
    movedAside = await move(outputDir, aside).then(
      () => true,
      (error: unknown) => {
        // No report there yet: nothing to move aside.
        if (errnoCode(error) !== "ENOENT") throw error;
        return false;
      },
    );
    await move(built, outputDir);
  } catch (error) {
    const stuck =
      movedAside &&
      !(await move(aside, outputDir).then(
        () => true,
        () => false,
      ));
    const code = errnoCode(error) ?? "unknown error";
    throw new AllureReportError(
      `Cannot put the Allure report in place at ${outputDir} (${code}` +
        `${code === "EXDEV" ? ": it must be on the run folder's filesystem" : ""}).` +
        (stuck
          ? ` The previous report could not be moved back: it waits in ${aside}, and the next ` +
            "generation in this run puts it back."
          : ""),
      { cause: error },
    );
  }
}

/**
 * Replaces the cell's history with the updated copy, once the report is in place.
 *
 * @param updated - the copy Allure appended this run to.
 * @param historyPath - the cell's history file.
 * @param outputDir - the report, named in the error.
 * @param move - the rename of `updated` onto the history; default `fs.rename`.
 * @throws {@link AllureReportError} when it cannot be replaced; the report stays.
 */
export async function placeHistory(
  updated: string,
  historyPath: string,
  outputDir: string,
  move: Move = rename,
): Promise<void> {
  try {
    await mkdir(dirname(historyPath), { recursive: true });
    await move(updated, historyPath).catch(async (error: unknown) => {
      if (errnoCode(error) !== "EXDEV") throw error;
      // Another filesystem: copied beside the history first, so the replacement is still a rename.
      const beside = `${historyPath}.${String(process.pid)}.tmp`;
      try {
        await copyFile(updated, beside);
        await rename(beside, historyPath);
      } finally {
        await rm(beside, { force: true });
      }
    });
  } catch (error) {
    throw new AllureReportError(
      `The Allure report is at ${outputDir}, but the history ${historyPath} could not be updated ` +
        `(${errnoCode(error) ?? "unknown error"}).`,
      { cause: error },
    );
  }
}
