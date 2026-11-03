import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import { errorMessage } from "../guards";
import { AllureReportError } from "./allure-errors";
import {
  DEFAULT_ALLURE_BIN,
  DEFAULT_ALLURE_CONFIG,
  generateAllureReport,
  type AllureReport,
  type AllureReportOptions,
} from "./allure-report";
import { errnoCode } from "./report-tree";

/**
 * `npm run report:allure`: a cell's newest run's Allure report — or a given run's — generated next to
 * its other reports and optionally served. The parser, the run lookup and the command are here,
 * testable; `scripts/allure.mjs` only wires them to the process (and loads `.env`, for
 * `REPORT_ROOT`). The report keeps Playwright traces in one file per plugin, as it always has.
 */

/**
 * The exit codes: done, nothing generated (or the server could not start), the arguments were wrong.
 * With `--open`, once the report is generated, the status is the server's own when it stops.
 */
export const EXIT = { ok: 0, failed: 1, usage: 2 } as const;

/** The command's help. */
export const ALLURE_USAGE = `Usage: npm run report:allure -- [product [cell [run]]] [--open]

Generates the Allure report of the newest run with Allure results under REPORT_ROOT (default
reports/), or of that product's, that cell's, or that very run (its RUN_ID folder name), into
<run>/allure/, named by the run's facts line; the cell's allure-history.jsonl gives the trend.

Options:
  --open       serve the report and open it in the browser once generated
  -h, --help   this help

Exit status: 0 done, 1 nothing generated, 2 bad arguments; with --open, once generated, the
server's own status when it stops (1 when it cannot start).`;

/** What the command was asked to do. */
export interface AllureCommandOptions {
  readonly product?: string;
  readonly cell?: string;
  /** A RUN_ID folder name; given only with a product and a cell. */
  readonly run?: string;
  readonly open: boolean;
}

/** The command line, read. */
export type ParsedAllureArgs =
  | { readonly kind: "run"; readonly options: AllureCommandOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

/**
 * Reads the command line: up to three names (product, cell, run), `--open`; `--help` anywhere wins.
 *
 * @param argv - the arguments after the script.
 */
export function parseAllureArgs(argv: readonly string[]): ParsedAllureArgs {
  const names: string[] = [];
  let open = false;
  if (argv.some((arg) => arg === "-h" || arg === "--help")) {
    return { kind: "help" };
  }
  for (const arg of argv) {
    if (arg === "--open") open = true;
    else if (arg.startsWith("-")) {
      return {
        kind: "error",
        message: `unknown option ${JSON.stringify(arg)}`,
      };
    } else names.push(arg);
  }
  if (names.length > 3) {
    return { kind: "error", message: "at most a product, a cell and a run" };
  }
  const bad = names.find((name) => !isPlainName(name));
  if (bad !== undefined) {
    return {
      kind: "error",
      message: `${JSON.stringify(bad)} is not a folder name (no "/", not hidden)`,
    };
  }
  const [product, cell, run] = names;
  return { kind: "run", options: { product, cell, run, open } };
}

/**
 * Whether a name is one folder below its parent: no separator, not hidden (`.`, `..` included).
 *
 * @param name - the name.
 */
function isPlainName(name: string): boolean {
  return name !== "" && !name.startsWith(".") && !/[/\\\0]/.test(name);
}

/** A run with Allure results. */
export interface AllureRun {
  readonly product: string;
  readonly cell: string;
  readonly runDir: string;
  readonly resultsDir: string;
  /** When its results folder last changed, epoch ms: the newest wins. */
  readonly mtimeMs: number;
}

/**
 * The runs under a report root with at least one Allure test result, optionally one product's or
 * cell's. Hidden folders are left out: the report pruning renames a run it removes to one first.
 *
 * @param reportRoot - `<root>/<product>/<cell>/<RUN_ID>/allure-results/`.
 * @param filter - only this product's and/or this cell's runs.
 */
export function findAllureRuns(
  reportRoot: string,
  filter: { readonly product?: string; readonly cell?: string } = {},
): AllureRun[] {
  const runs: AllureRun[] = [];
  for (const product of subdirs(reportRoot)) {
    if (filter.product !== undefined && product !== filter.product) continue;
    for (const cell of subdirs(join(reportRoot, product))) {
      if (filter.cell !== undefined && cell !== filter.cell) continue;
      const cellDir = join(reportRoot, product, cell);
      for (const runId of subdirs(cellDir)) {
        const resultsDir = join(cellDir, runId, "allure-results");
        if (!hasResults(resultsDir)) continue;
        runs.push({
          product,
          cell,
          runDir: join(cellDir, runId),
          resultsDir,
          mtimeMs: statSync(resultsDir).mtimeMs,
        });
      }
    }
  }
  return runs;
}

/**
 * The newest of some runs, by their results' time.
 *
 * @param runs - the candidates.
 * @returns it; `undefined` for none.
 */
export function newestRun(runs: readonly AllureRun[]): AllureRun | undefined {
  return runs.reduce<AllureRun | undefined>(
    (newest, run) =>
      newest === undefined || run.mtimeMs > newest.mtimeMs ? run : newest,
    undefined,
  );
}

/**
 * A folder's visible subfolders; none when it is absent.
 *
 * @param dir - the folder.
 */
function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/**
 * Whether a folder holds a test result. A run that ran nothing (`--list`, "No tests found") may
 * still leave the run facts' `environment.properties` there.
 *
 * @param resultsDir - the folder.
 */
function hasResults(resultsDir: string): boolean {
  return (
    existsSync(resultsDir) &&
    readdirSync(resultsDir).some((name) => name.endsWith("-result.json"))
  );
}

/**
 * The report's name: the run's title line from its `run-facts.json`, or `fallback` when it left
 * none readable (an older run, or one whose facts could not be written).
 *
 * @param runDir - the run's folder.
 * @param fallback - the name otherwise.
 */
export function reportName(runDir: string, fallback: string): string {
  try {
    const facts: unknown = JSON.parse(
      readFileSync(join(runDir, "run-facts.json"), "utf8"),
    );
    const title =
      typeof facts === "object" &&
      facts !== null &&
      "title" in facts &&
      typeof facts.title === "string"
        ? facts.title.trim()
        : "";
    return title === "" ? fallback : title;
  } catch {
    return fallback;
  }
}

/** What the command needs from its process. */
export interface AllureCommandIo {
  readonly reportRoot: string;
  readonly print: (line: string) => void;
  readonly printError: (line: string) => void;
  /** Generates a report; default {@link generateAllureReport}. */
  readonly generate?: (options: AllureReportOptions) => Promise<AllureReport>;
  /** Serves a report and waits for the server to end; default {@link serveAllureReport}. */
  readonly serve?: (outputDir: string) => Promise<number>;
  /** Stops generation (nothing is put in place) and the server (Ctrl-C, SIGTERM). */
  readonly signal?: AbortSignal;
}

/**
 * The command: finds the run, generates its report (traces kept, one file per plugin, Allure's
 * output printed through), and serves it with `--open`.
 *
 * @param options - from {@link parseAllureArgs}.
 * @param io - the report root and the process's side.
 * @returns the exit status ({@link EXIT}).
 */
export async function runAllureCommand(
  options: AllureCommandOptions,
  io: AllureCommandIo,
): Promise<number> {
  const target = locateRun(options, io.reportRoot);
  if (typeof target === "string") {
    io.printError(target);
    return EXIT.failed;
  }
  const outputDir = join(target.runDir, "allure");
  const historyPath = join(dirname(target.runDir), "allure-history.jsonl");
  io.print(`→ Allure report for ${target.product}/${target.cell}`);
  io.print(`  results: ${target.resultsDir}`);
  io.print(`  output:  ${outputDir}`);
  io.print(`  history: ${historyPath}`);
  try {
    await (io.generate ?? generateAllureReport)({
      runDir: target.runDir,
      resultsDir: target.resultsDir,
      outputDir,
      // The report's header says what was tested; at least, which cell.
      name: reportName(target.runDir, `${target.product} · ${target.cell}`),
      historyPath,
      traces: "keep",
      layout: "single-file",
      stdio: "inherit",
      signal: io.signal,
    });
  } catch (error) {
    if (!(error instanceof AllureReportError)) throw error;
    io.printError(errorMessage(error));
    return EXIT.failed;
  }
  if (!options.open) return EXIT.ok;
  return io.serve !== undefined
    ? io.serve(outputDir)
    : serveAllureReport(outputDir, {
        printError: io.printError,
        signal: io.signal,
      });
}

/**
 * The run to report: the one named, or the newest matching.
 *
 * @param options - the product, cell and run asked for.
 * @param reportRoot - the report root.
 * @returns it, or the line saying why there is none.
 */
function locateRun(
  options: AllureCommandOptions,
  reportRoot: string,
): Omit<AllureRun, "mtimeMs"> | string {
  const { product, cell, run } = options;
  if (product !== undefined && cell !== undefined && run !== undefined) {
    const runDir = join(reportRoot, product, cell, run);
    if (!existsSync(runDir)) return `No run folder ${runDir}.`;
    return {
      product,
      cell,
      runDir,
      resultsDir: join(runDir, "allure-results"),
    };
  }
  const newest = newestRun(findAllureRuns(reportRoot, { product, cell }));
  if (newest !== undefined) return newest;
  const scope = [product, cell].filter((name) => name !== undefined).join("/");
  return (
    `No Allure results found under "${reportRoot}/"${scope === "" ? "" : ` for ${scope}`}. ` +
    "Run a suite first, e.g. `E2E_CELL=apache npm run test:wp-rocket`."
  );
}

/** How {@link serveAllureReport} runs the server. */
export interface ServeOptions {
  /** Where the reason goes when the server cannot start. */
  readonly printError: (line: string) => void;
  /** Stops the server (SIGTERM). */
  readonly signal?: AbortSignal;
  /** The CLI; default {@link DEFAULT_ALLURE_BIN}. */
  readonly allureBin?: string;
  /** The Allure config; default {@link DEFAULT_ALLURE_CONFIG}. */
  readonly configPath?: string;
}

/**
 * Serves a generated report (`allure open`) and opens it in the browser, until the server is
 * stopped (Ctrl-C).
 *
 * @param outputDir - the report.
 * @param options - the process's side, and the CLI to run.
 * @returns the server's exit status; 1 when it cannot be started or a signal ended it.
 */
export function serveAllureReport(
  outputDir: string,
  options: ServeOptions,
): Promise<number> {
  const bin = options.allureBin ?? DEFAULT_ALLURE_BIN;
  return new Promise((settle) => {
    const child = spawn(
      bin,
      ["open", "-c", options.configPath ?? DEFAULT_ALLURE_CONFIG, outputDir],
      { stdio: "inherit", signal: options.signal },
    );
    child.once("error", (error) => {
      // A server that never started (no pid) ends here; a stopped one's `close` follows.
      if (child.pid !== undefined) return;
      options.printError(
        `Could not run the Allure CLI at ${bin}: ${errnoCode(error) ?? error.name}.`,
      );
      settle(EXIT.failed);
    });
    child.once("close", (code) => {
      settle(code ?? EXIT.failed);
    });
  });
}
