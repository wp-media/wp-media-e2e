import type { FullConfig, Reporter } from "@playwright/test/reporter";

import { printLine } from "./terminal-sink";

/**
 * A one-line notice, `[cell] …`, of the cell a run is for and how it was chosen, printed first —
 * before the terminal reporter's `[run]` header. Nothing else on the terminal names it, and whether a
 * run was pinned decides whether another cell of its product may run beside it.
 *
 * A reporter, because reporters live in the runner process alone: the config itself is evaluated
 * in every process of a run (`bddgen`, the runner, each worker) and would print once per process.
 * It prints through the run's terminal sink (`terminal-sink.ts`), so the terminal reporter stays the
 * one writer; alone (its spec, a `--list` run) it writes standard output itself, as it always did.
 */

/** What the config factory knows about a run, handed over as this reporter's options. */
export interface CellNoticeOptions {
  /** The product under test. */
  readonly product: string;
  /** The one cell the run targets; absent when it targets none. */
  readonly cell?: string;
  /** Whether `E2E_CELL` chose the cell, rather than `--project`. */
  readonly pinned: boolean;
  /** The run's report folder, as the operator will look for it. */
  readonly reportDir: string;
}

/**
 * The notice for a run.
 *
 * @param options - what the config factory knows about the run.
 * @param workers - the workers it starts ({@link actualWorkers}).
 * @example
 * ```ts
 * cellNotice({ product: "backwpup", cell: "pro@nginx", pinned: true, reportDir: "reports/…" }, 1);
 * // "[cell] backwpup/pro@nginx, pinned by E2E_CELL: bddgen generates only its specs. 1 worker;
 * //  report in reports/…"
 * ```
 */
export function cellNotice(
  options: CellNoticeOptions,
  workers: number,
): string {
  const { product, cell } = options;
  const how =
    cell === undefined
      ? `${product}: no single cell selected, so the run is serial and bddgen generates every ` +
        "cell's specs"
      : options.pinned
        ? `${product}/${cell}, pinned by E2E_CELL: bddgen generates only its specs`
        : `${product}/${cell}, selected by --project: bddgen generates every cell's specs, which ` +
          `breaks another ${product} run started beside this one; E2E_CELL=${cell} instead ` +
          "lets cells run side by side";
  const count = `${String(workers)} worker${workers === 1 ? "" : "s"}`;
  return `[cell] ${how}. ${count}; report in ${options.reportDir}`;
}

/**
 * The workers a run really starts, as Playwright's own "Running … using N workers" line counts
 * them: `metadata.actualWorkers` (the configured count capped by the test groups to run, set
 * before reporters begin), else `workers` — which already includes `--workers`.
 *
 * @param config - the run's resolved config.
 */
export function actualWorkers(
  config: Pick<FullConfig, "workers" | "metadata">,
): number {
  const actual: unknown = config.metadata.actualWorkers;
  return typeof actual === "number" && Number.isInteger(actual) && actual > 0
    ? actual
    : config.workers;
}

/** Prints {@link cellNotice} as the run begins; listed first, so it comes before the `[run]` header. */
export default class CellNoticeReporter implements Reporter {
  /** @param options - the facts, as the config factory passed them. */
  constructor(private readonly options: CellNoticeOptions) {}

  /**
   * Prints the notice, through the run's terminal sink when there is one. Never throws.
   *
   * @param config - the run's resolved config; its worker count is {@link actualWorkers}.
   */
  onBegin(config: FullConfig): void {
    printLine(cellNotice(this.options, actualWorkers(config)), "stdout");
  }

  /**
   * One line is no progress report: answering `false` keeps Playwright adding its own terminal
   * reporter whenever no other reporter prints.
   */
  printsToStdio(): boolean {
    return false;
  }
}
