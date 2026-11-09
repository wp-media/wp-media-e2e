import { readFile, writeFile } from "node:fs/promises";

import { isObject } from "../guards";
import { errnoCode } from "./report-tree";

/**
 * One trend point per run in a cell's Allure history. `allure generate` appends one JSON line per
 * generation to `allure-history.jsonl`, stamped with the generation's time, so generating a run's
 * report again (a rebuilt bundle, a later `report:allure`, a retry after a stop) would add a second
 * point for that run. This tags the line Allure appended with the run's folder name and, when the
 * history already holds that run's line, puts the new one in its place, keeping its time: the trend
 * keeps one point per run, in the order the runs were first reported. The tag is the key, never the
 * report's name: the orchestrator's runs are named by their task, so two runs can share one. Lines of
 * other runs, untagged ones (written before this) and ones that do not parse are kept byte for byte.
 * Allure (3.18) reads each line with `JSON.parse` and ignores a key it does not know.
 */

/** The key a history line carries its run's folder name in. */
export const HISTORY_RUN_KEY = "e2eRun";

/**
 * The history after Allure appended `run`'s line to `before`, with that line tagged and any earlier
 * line of the same run replaced by it (in its place, with its `timestamp`). Works on text decoded as
 * `latin1`, so every byte of the other lines comes back as it was.
 *
 * @param before - the history Allure was given (`""` when there was none).
 * @param after - the history Allure left.
 * @param run - the run's folder name (`RUN_ID`), as the same `latin1` text.
 * @returns the new history; `undefined` when `after` is not `before` plus exactly one JSON object
 *   line (Allure then did something else, so its history is kept as it is).
 * @example
 * ```ts
 * historyWithRun('{"name":"a","timestamp":1,"e2eRun":"r1"}\n', '…\n{"name":"a","timestamp":9}\n', "r1");
 * // '{"name":"a","timestamp":1,"e2eRun":"r1"}\n'
 * ```
 */
export function historyWithRun(
  before: string,
  after: string,
  run: string,
): string | undefined {
  if (before !== "" && !before.endsWith("\n")) return undefined;
  if (!after.startsWith(before)) return undefined;
  const added = after.slice(before.length);
  if (added.indexOf("\n") !== added.length - 1) return undefined;
  const entry = parseLine(added);
  if (entry === undefined) return undefined;
  const tagged: Record<string, unknown> = { ...entry, [HISTORY_RUN_KEY]: run };
  const lines: string[] = [];
  let placed = false;
  for (const line of before.split("\n").slice(0, -1)) {
    const earlier = parseLine(line);
    if (earlier?.[HISTORY_RUN_KEY] !== run) {
      lines.push(line);
      continue;
    }
    // This run's earlier point: the first one is replaced in place, keeping its time; any other goes.
    if (placed) continue;
    placed = true;
    lines.push(
      JSON.stringify(
        typeof earlier.timestamp === "number"
          ? { ...tagged, timestamp: earlier.timestamp }
          : tagged,
      ),
    );
  }
  if (!placed) lines.push(JSON.stringify(tagged));
  return lines.map((line) => `${line}\n`).join("");
}

/**
 * A history line as a JSON object.
 *
 * @param line - the line, with or without its line end.
 * @returns the object; `undefined` when it is not one.
 */
function parseLine(line: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(line);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a history file as `latin1` text: every byte kept.
 *
 * @param path - the file.
 * @returns its text; `""` when there is none.
 * @throws the filesystem's error for anything but a missing file.
 */
export async function readHistoryText(path: string): Promise<string> {
  try {
    return await readFile(path, "latin1");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return "";
    throw error;
  }
}

/**
 * Rewrites the history Allure updated so it holds one line for `run` ({@link historyWithRun}). Left
 * as Allure wrote it when it is not what that expects.
 *
 * @param path - the updated history, in the work folder (put in place by rename afterwards).
 * @param before - what it held before Allure ran ({@link readHistoryText}).
 * @param run - the run's folder name.
 * @throws the filesystem's error when it cannot be read or written.
 */
export async function keepOneLinePerRun(
  path: string,
  before: string,
  run: string,
): Promise<void> {
  const merged = historyWithRun(
    before,
    await readHistoryText(path),
    Buffer.from(run, "utf8").toString("latin1"),
  );
  if (merged !== undefined) await writeFile(path, merged, "latin1");
}
