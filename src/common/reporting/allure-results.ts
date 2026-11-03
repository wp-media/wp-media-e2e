import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

import { isObject } from "../guards";
import {
  AllureResultsMissingError,
  MalformedAllureResultError,
} from "./allure-errors";
import { errnoCode } from "./report-tree";

/**
 * A run's raw Allure results, copied for generation: validated (Allure skips a malformed result and
 * exits 0 on an empty folder, both silently), and with Playwright traces optionally left out. The
 * original folder is only ever read.
 */

/** What to do with Playwright traces: leave them out of the report, or keep them. */
export type AllureTraces = "strip" | "keep";

/** The attachment type allure-playwright gives a Playwright trace zip. */
export const PLAYWRIGHT_TRACE_TYPE = "application/vnd.allure.playwright-trace";

/** A test result's file-name suffix; a folder without one has nothing to report. */
const RESULT_SUFFIX = "-result.json";

/** A container's (fixtures') file-name suffix; its `befores`/`afters` carry steps and attachments. */
const CONTAINER_SUFFIX = "-container.json";

/** What stripping found in one result: the trace entries removed, their sources, the sources kept. */
interface StripTally {
  traces: number;
  readonly removed: string[];
  readonly kept: string[];
}

/** One result or container with its traces stripped. */
export interface StrippedResult {
  /** The result without trace attachments; the input itself when it had none. */
  readonly result: Record<string, unknown>;
  /** The trace entries removed (one without a `source` included). */
  readonly removedTraces: number;
  /** The attachment files (`source`) only trace entries referenced. */
  readonly removedSources: readonly string[];
  /** The attachment files entries still reference. */
  readonly keptSources: readonly string[];
}

/**
 * Removes every Playwright trace attachment from a result (or container), at any depth: its own
 * attachments, its steps' and its fixtures' (`befores`/`afters`). allure-playwright wraps each test
 * attachment in a step of its own, named after it: such a wrapper of a trace is dropped whole; any
 * other step only loses its traces. Never mutates its input; anything it does not recognise is kept
 * as it is.
 *
 * @param result - a parsed `*-result.json` or `*-container.json`.
 * @returns the stripped copy and which attachment files it no longer needs.
 */
export function stripTraces(result: Record<string, unknown>): StrippedResult {
  const tally: StripTally = { traces: 0, removed: [], kept: [] };
  const stripped = stripNode(result, tally);
  return {
    result: tally.traces === 0 ? result : stripped,
    removedTraces: tally.traces,
    removedSources: tally.removed,
    keptSources: tally.kept,
  };
}

/**
 * Whether an attachment entry is a Playwright trace.
 *
 * @param attachment - one entry of an `attachments` array.
 */
function isTrace(attachment: unknown): boolean {
  return isObject(attachment) && attachment.type === PLAYWRIGHT_TRACE_TYPE;
}

/**
 * A node (result, step or fixture) without its trace attachments, recursively.
 *
 * @param node - the node.
 * @param tally - collects the sources removed and kept.
 */
function stripNode(
  node: Record<string, unknown>,
  tally: StripTally,
): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...node };
  if (Array.isArray(node.attachments)) {
    copy.attachments = node.attachments.filter((attachment: unknown) => {
      const source = isObject(attachment) ? attachment.source : undefined;
      const trace = isTrace(attachment);
      if (trace) tally.traces += 1;
      if (typeof source === "string")
        (trace ? tally.removed : tally.kept).push(source);
      return !trace;
    });
  }
  if (Array.isArray(node.steps)) {
    const steps: unknown[] = [];
    for (const step of node.steps as unknown[]) {
      if (!isObject(step)) {
        steps.push(step);
        continue;
      }
      // Stripped either way, so a dropped wrapper's sources are tallied as removed.
      const stripped = stripNode(step, tally);
      if (!isTraceWrapper(step)) steps.push(stripped);
    }
    copy.steps = steps;
  }
  for (const key of ["befores", "afters"]) {
    const fixtures = node[key];
    if (Array.isArray(fixtures)) {
      copy[key] = fixtures.map((fixture: unknown) =>
        isObject(fixture) ? stripNode(fixture, tally) : fixture,
      );
    }
  }
  return copy;
}

/**
 * The keys allure-playwright's attachment step has: started with only a `name`, stopped with no
 * status, so its defaults (`parameters: []`, `statusDetails: {}`, `steps: []`, `stage`, times) and
 * the one attachment.
 */
const WRAPPER_KEYS: ReadonlySet<string> = new Set([
  "name",
  "status",
  "statusDetails",
  "stage",
  "steps",
  "attachments",
  "parameters",
  "start",
  "stop",
]);

/**
 * Whether a step is exactly allure-playwright's wrapper of one trace: named after its only
 * attachment, a trace; no steps, parameters or status details; unstatused or passed; no other key.
 * Any other step holding a trace — a failed one, one with parameters — stays, minus the trace:
 * dropping it would lose what it says.
 *
 * @param step - one entry of a `steps` array.
 */
function isTraceWrapper(step: Record<string, unknown>): boolean {
  const attachments = Array.isArray(step.attachments)
    ? (step.attachments as unknown[])
    : [];
  const [attachment] = attachments;
  return (
    attachments.length === 1 &&
    isObject(attachment) &&
    isTrace(attachment) &&
    attachment.name === step.name &&
    isEmptyList(step.steps) &&
    isEmptyList(step.parameters) &&
    (step.statusDetails === undefined ||
      (isObject(step.statusDetails) &&
        Object.keys(step.statusDetails).length === 0)) &&
    (step.status === undefined || step.status === "passed") &&
    Object.keys(step).every((key) => WRAPPER_KEYS.has(key))
  );
}

/**
 * Whether a field is absent or an empty array.
 *
 * @param value - the field's value.
 */
function isEmptyList(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}

/** What {@link copyAllureResults} copied. */
export interface CopiedResults {
  /** The test results (`*-result.json`) copied. */
  readonly results: number;
  /** The trace attachment entries removed (0 when keeping them). */
  readonly strippedTraces: number;
  /** Entries left out because they are not regular files — links, folders — never followed. */
  readonly skipped: readonly string[];
}

/**
 * Copies a results folder for generation. Every result and container must be a JSON object; with
 * `strip`, trace attachments are removed from the copy and their zips not copied. Only regular files
 * are copied: a link (which could lead anywhere) or a folder is left out and named. A file is cloned
 * where the filesystem can (APFS, btrfs), else copied.
 *
 * @param resultsDir - the run's `allure-results/`, only read.
 * @param targetDir - where the copy goes; created, and must not exist yet.
 * @param traces - strip or keep Playwright traces.
 * @returns what was copied.
 * @throws {@link AllureResultsMissingError} when the folder is absent, not a folder or holds no test
 *   result; {@link MalformedAllureResultError} for a result or container that is not a JSON object;
 *   the filesystem's error when a file cannot be read or written.
 */
export async function copyAllureResults(
  resultsDir: string,
  targetDir: string,
  traces: AllureTraces,
): Promise<CopiedResults> {
  const files = await listRegularFiles(resultsDir);
  const results = files.regular.filter((name) => name.endsWith(RESULT_SUFFIX));
  if (results.length === 0) {
    throw new AllureResultsMissingError(resultsDir, "empty");
  }
  const rewritten = new Map<string, Record<string, unknown>>();
  const removed = new Set<string>();
  const kept = new Set<string>();
  let strippedTraces = 0;
  for (const name of files.regular) {
    if (!name.endsWith(RESULT_SUFFIX) && !name.endsWith(CONTAINER_SUFFIX))
      continue;
    const parsed = await readResult(join(resultsDir, name));
    if (traces === "keep") continue;
    const stripped = stripTraces(parsed);
    stripped.removedSources.forEach((source) => removed.add(source));
    stripped.keptSources.forEach((source) => kept.add(source));
    strippedTraces += stripped.removedTraces;
    if (stripped.result !== parsed) rewritten.set(name, stripped.result);
  }
  await mkdir(targetDir, { recursive: false });
  for (const name of files.regular) {
    // A trace zip nothing else references stays behind; one another entry shares is copied.
    if (removed.has(name) && !kept.has(name)) continue;
    const result = rewritten.get(name);
    if (result === undefined) {
      await copyFile(
        join(resultsDir, name),
        join(targetDir, name),
        constants.COPYFILE_FICLONE,
      );
    } else {
      await writeFile(join(targetDir, name), JSON.stringify(result));
    }
  }
  return { results: results.length, strippedTraces, skipped: files.skipped };
}

/**
 * A results folder's regular files, and the other entries' names.
 *
 * @param resultsDir - the folder; itself may be a link (a caller's path), its entries are never
 *   followed.
 * @throws {@link AllureResultsMissingError} when it is absent or not a folder.
 */
async function listRegularFiles(
  resultsDir: string,
): Promise<{ regular: string[]; skipped: string[] }> {
  try {
    if (!(await stat(resultsDir)).isDirectory()) {
      throw new AllureResultsMissingError(resultsDir, "not-a-folder");
    }
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new AllureResultsMissingError(resultsDir, "missing");
    }
    throw error;
  }
  const regular: string[] = [];
  const skipped: string[] = [];
  for (const entry of await readdir(resultsDir, { withFileTypes: true })) {
    (entry.isFile() ? regular : skipped).push(entry.name);
  }
  return { regular: regular.sort(), skipped: skipped.sort() };
}

/**
 * Reads and parses one result or container.
 *
 * @param file - its path.
 * @returns the parsed object.
 * @throws {@link MalformedAllureResultError} when it is not JSON, or not an object.
 */
async function readResult(file: string): Promise<Record<string, unknown>> {
  const text = await readFile(file, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MalformedAllureResultError(
      file,
      error instanceof SyntaxError ? error.message : "not JSON",
    );
  }
  if (!isObject(parsed)) {
    throw new MalformedAllureResultError(
      file,
      `a JSON ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}, not an object`,
    );
  }
  return parsed;
}
