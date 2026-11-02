import type { CellNoticeOptions } from "./cell-notice";

/**
 * What the config factory knows about a run, handed to the suite's own reporters as their options.
 * Reporters live in the runner process alone and receive their options as plain data, so this is
 * all they may assume — nothing is read back from the config modules, which load `.env` and stamp
 * a `RUN_ID` as they are imported.
 */
export interface RunDescription extends CellNoticeOptions {
  /** The run's token, which names its report folder. */
  readonly runId: string;
  /** The cell's edition, for an edition-ful product. */
  readonly edition?: string;
  /** The folder under the product the run reports in: its cell, or the bucket of a run of every cell. */
  readonly reportCell: string;
  /** The run's report folder, absolute: where the reporters write. */
  readonly reportPath: string;
  /** What the run is called, for display only (`E2E_RUN_NAME`, which an orchestrator sets). */
  readonly runName?: string;
  /**
   * The plugin ref the run was asked to test, for display only (`E2E_REQUESTED_REF`): an orchestrator
   * pins the run to the commit it built, and this keeps the ref a person asked for (`develop`).
   */
  readonly requestedRef?: string;
  /**
   * `E2E_REPORTS_KEEP`: how many reports the run's own report folder keeps as the run ends, `0` for
   * no cap (`run-pruning.ts`). Absent, the run prunes nothing.
   */
  readonly reportsKeep?: number;
  /**
   * The plugin ref the operator set (`E2E_PLUGIN_REF`, trimmed), for the rerun command a failure
   * prints when the artifacts setup recorded no build.
   */
  readonly pluginRef?: string;
  /** The plugin zip the operator set (`E2E_PLUGIN_ZIP`, trimmed, as given), for the rerun command. */
  readonly pluginZip?: string;
  /** The plugin version the operator set (`E2E_PLUGIN_VERSION`, trimmed), for the rerun command. */
  readonly pluginVersion?: string;
}

/**
 * Narrows a reporter's options to a {@link RunDescription}: Playwright adds options of its own
 * (`configDir`, `_mode`) to every reporter's, and the type cannot say so.
 *
 * @param options - what the reporter's constructor received.
 * @returns the description, or the name of the first field missing from it or of the wrong type —
 *   the config factory's own mistake, which a reporter reports rather than throws (a throwing reporter
 *   fails the run).
 */
export function readRunDescription(
  options: unknown,
): RunDescription | { readonly missing: string } {
  const value = (options ?? {}) as Partial<
    Record<keyof RunDescription, unknown>
  >;
  for (const key of [
    "product",
    "reportDir",
    "runId",
    "reportCell",
    "reportPath",
  ] as const) {
    if (typeof value[key] !== "string") return { missing: key };
  }
  for (const key of [
    "cell",
    "edition",
    "runName",
    "requestedRef",
    "pluginRef",
    "pluginZip",
    "pluginVersion",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      return { missing: key };
    }
  }
  if (typeof value.pinned !== "boolean") return { missing: "pinned" };
  if (
    value.reportsKeep !== undefined &&
    !(Number.isInteger(value.reportsKeep) && (value.reportsKeep as number) >= 0)
  ) {
    return { missing: "reportsKeep" };
  }
  return value as RunDescription;
}

/**
 * The mode Playwright runs its reporters in: `list` for `--list`, which runs nothing. Read from the
 * `_mode` option Playwright adds to every reporter's options (undocumented; `results-stream.run.spec.ts`
 * fails if it changes) — nothing else tells `--list` from a run interrupted before its first test.
 *
 * @param options - what the reporter's constructor received.
 */
export function reporterMode(options: unknown): "test" | "list" {
  const mode =
    typeof options === "object" && options !== null && "_mode" in options
      ? options._mode
      : undefined;
  return mode === "list" ? "list" : "test";
}
