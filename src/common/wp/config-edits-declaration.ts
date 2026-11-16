import { normaliseSitePath } from "./paths";
import { isObject } from "../guards";
import { plain } from "../text";
import type {
  ConfigEditCapture,
  ConfigEditCondition,
  ConfigEditOperation,
  ConfigEditStep,
  ConfigEdits,
  CreatedFile,
  EditedFile,
} from "../config/types";

/**
 * The pure half of `./config-edits.ts`: a product's `ProductConfig.configEdits` validated, and the
 * engine's answers read and put into words. No command runs here, so the config build that validates
 * a declaration loads nothing that does.
 */

/** A PCRE pattern as declared: `/` delimiters, then only flags PHP knows. */
const PATTERN_SHAPE = /^\/[\s\S]+\/[imsxuADSUXJn]*$/;

/** A capture's name, as a replacement's `{{name}}` refers to it. */
const CAPTURE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Every `{{name}}` in a replacement. */
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** A back-reference a literal replacement would print as it is: `$1`, `${1}`, `\1`. */
const BACK_REFERENCE = /\$\d|\$\{|\\\d/;

/**
 * Validates a product's declaration and returns it with every path normalised.
 *
 * @param declared - `ProductConfig.configEdits`.
 * @param product - the product's name, for messages.
 * @returns the declaration, paths normalised.
 * @throws Error naming the product, the entry and the rule it broke.
 */
export function normaliseConfigEdits(
  declared: ConfigEdits,
  product: string,
): ConfigEdits {
  const fail = (what: string): never => {
    throw new Error(`[wp/config-edits] ${product}'s configEdits: ${what}.`);
  };
  const seen = new Set<string>();
  const sitePath = (path: string): string => {
    const normalised = normaliseSitePath(path, (reason) =>
      fail(`"${path}" cannot be tracked: ${reason}`),
    );
    if (seen.has(normalised)) fail(`"${normalised}" is declared twice`);
    seen.add(normalised);
    return normalised;
  };
  const files = declared.files.map((file): EditedFile =>
    normaliseFile(file, sitePath(file.path), fail),
  );
  const createdFiles = (declared.createdFiles ?? []).map(
    (file): CreatedFile => {
      const path = sitePath(file.path);
      if (file.marks.length === 0 || file.marks.some((mark) => mark === "")) {
        fail(`"${path}" needs at least one mark, none of them empty`);
      }
      return { path, marks: [...file.marks] };
    },
  );
  const createdDirs = (declared.createdDirs ?? []).map(sitePath);
  if (files.length + createdFiles.length + createdDirs.length === 0) {
    fail("it tracks nothing; omit it instead");
  }
  return { files, createdFiles, createdDirs };
}

/**
 * Validates one edited file's operations and captures.
 *
 * @param file - the declared file.
 * @param path - its path, already normalised.
 * @param fail - throws the declaration's error.
 */
function normaliseFile(
  file: EditedFile,
  path: string,
  fail: (what: string) => never,
): EditedFile {
  const captures = file.captures ?? [];
  const names = new Set<string>();
  for (const capture of captures) {
    if (!CAPTURE_NAME.test(capture.name) || names.has(capture.name)) {
      fail(
        `"${path}": capture "${capture.name}" is unusable or declared twice`,
      );
    }
    names.add(capture.name);
    checkPattern(capture.pattern, `"${path}" capture "${capture.name}"`, fail);
    if (capture.group === "")
      fail(`"${path}" capture "${capture.name}" names no group`);
  }
  if (file.operations.length === 0) fail(`"${path}" declares no operation`);
  const operations = new Set<string>();
  for (const operation of file.operations) {
    if (operation.name === "" || operations.has(operation.name)) {
      fail(
        `"${path}": operation "${operation.name}" is unnamed or declared twice`,
      );
    }
    operations.add(operation.name);
    if (operation.steps.length === 0) {
      fail(`"${path}" operation "${operation.name}" has no step`);
    }
    operation.steps.forEach((step, index) => {
      checkStep(
        step,
        `"${path}" ${operation.name} step ${String(index + 1)}`,
        names,
        fail,
      );
    });
  }
  return {
    path,
    operations: file.operations.map((operation): ConfigEditOperation => ({
      name: operation.name,
      steps: [...operation.steps],
    })),
    captures: captures.map((capture): ConfigEditCapture => ({ ...capture })),
  };
}

/**
 * Validates one step: its pattern, limit, literal replacement and condition.
 *
 * @param step - the step.
 * @param where - names it in a message.
 * @param captures - the file's capture names.
 * @param fail - throws the declaration's error.
 */
function checkStep(
  step: ConfigEditStep,
  where: string,
  captures: ReadonlySet<string>,
  fail: (what: string) => never,
): void {
  checkPattern(step.pattern, where, fail);
  if (!Number.isInteger(step.limit) || step.limit === 0 || step.limit < -1) {
    fail(
      `${where}: limit ${String(step.limit)} is neither -1 nor a positive count`,
    );
  }
  if (BACK_REFERENCE.test(step.replacement)) {
    fail(
      `${where}: replacements are literal, so a back-reference would be written as it is`,
    );
  }
  for (const [, name] of step.replacement.matchAll(PLACEHOLDER)) {
    if (name === undefined || !captures.has(name)) {
      fail(`${where}: "{{${name ?? ""}}}" names no capture of the file`);
    }
  }
  if (step.when !== undefined) checkCondition(step.when, where, fail);
}

/**
 * Validates a step's condition.
 *
 * @param when - the condition.
 * @param where - names its step in a message.
 * @param fail - throws the declaration's error.
 */
function checkCondition(
  when: ConfigEditCondition,
  where: string,
  fail: (what: string) => never,
): void {
  checkPattern(when.pattern, `${where} condition`, fail);
  if (when.kind === "differs" && when.group === "") {
    fail(`${where} condition names no group`);
  }
}

/**
 * Refuses a pattern PHP would not read as one: it must have `/` delimiters and known flags only.
 * Whether it compiles is the site's PHP's question; a pattern it rejects fails the engine loudly.
 *
 * @param pattern - the declared pattern.
 * @param where - names it in a message.
 * @param fail - throws the declaration's error.
 */
function checkPattern(
  pattern: string,
  where: string,
  fail: (what: string) => never,
): void {
  if (!PATTERN_SHAPE.test(pattern)) {
    fail(`${where}: "${pattern}" is not a /…/flags PCRE pattern`);
  }
}

/** What happened to an edited file — see {@link outcomeMessage}. */
export const FILE_RESULTS = [
  "unchanged",
  "restored",
  "resumed",
  "removed",
  "unrecognized",
  "unwritable",
  "replaced",
  "missing",
  "link",
  "not-a-file",
  "appeared",
  "not-recorded",
] as const;

/** What happened to a created file. */
export const CREATED_FILE_RESULTS = [
  "absent",
  "kept",
  "removed",
  "changed",
  "foreign",
  "missing",
  "link",
  "not-a-file",
  "unwritable",
] as const;

/** What happened to a created directory. */
export const DIR_RESULTS = [
  "absent",
  "kept",
  "removed",
  "not-empty",
  "link",
  "not-a-dir",
  "unwritable",
] as const;

/** Which list of the declaration an outcome is about. */
export type OutcomeKind = "file" | "created-file" | "dir";

/** One tracked path's verdict, as the engine answered it. */
export interface ConfigEditOutcome {
  readonly kind: OutcomeKind;
  /** Its index in the declaration's list of that kind: the path is taken from there, never the site. */
  readonly index: number;
  readonly result: string;
  /** A mode that differed from the record: what was found, what was recorded, whether it was set back. */
  readonly mode?: {
    readonly found: number;
    readonly recorded: number;
    readonly restored: boolean;
  };
  /** An owner that differs from the record (`uid:gid`), which is never changed here. */
  readonly owner?: { readonly found: string; readonly recorded: string };
}

/** What the record step answered. */
export interface RecordAnswer {
  /**
   * The record folder, when something not this identity's private folder holds its name: then nothing
   * was reconciled or recorded, and every other field is empty.
   */
  readonly blocked: string | undefined;
  /** A record a killed run left, put back first; `undefined` when there was none. */
  readonly reconciled: readonly ConfigEditOutcome[] | undefined;
  /** A killed run's record that could not be trusted, discarded unused — see {@link UNUSABLE_REASONS}. */
  readonly unusable: UnusableReason | undefined;
  /** An incomplete record (killed while it was being taken) was discarded. */
  readonly discarded: boolean;
  /** Stale records of this identity's swept from the same folder. */
  readonly swept: number;
  /** Stale records of this identity's that would not go (left for a later sweep). */
  readonly unswept: number;
}

/**
 * Why the engine discarded a record unused: its `meta.json` unreadable, taken for another root, or a
 * copy whose SHA-256 no longer matches. Restoring from it could write what the site never held.
 */
export const UNUSABLE_REASONS = [
  "unreadable",
  "other-root",
  "damaged",
] as const;

/** One of {@link UNUSABLE_REASONS}. */
export type UnusableReason = (typeof UNUSABLE_REASONS)[number];

/** What the restore step answered. */
export type RestoreAnswer =
  | { readonly kind: "none" }
  | { readonly kind: "blocked"; readonly dir: string }
  | { readonly kind: "unusable"; readonly reason: UnusableReason }
  | {
      readonly kind: "restored";
      readonly outcomes: readonly ConfigEditOutcome[];
    };

/**
 * Words for a record discarded unused.
 *
 * @param reason - why.
 * @param whose - whose record it was: `the` after a scenario, `a killed run's` before one.
 */
export function unusableMessage(reason: UnusableReason, whose = "the"): string {
  const why = {
    unreadable: "its index could not be read",
    "other-root": "it was taken for another WordPress root",
    damaged: "a copy in it no longer matches its checksum",
  }[reason];
  return `${whose} record of them was discarded unused (${why}): they are left as they were found.`;
}

/**
 * Words for a record folder the engine would not use — see {@link RecordAnswer.blocked}.
 *
 * @param dir - the folder.
 * @param when - in the record step (nothing recorded) or the restore (nothing put back).
 */
export function blockedMessage(dir: string, when: "before" | "after"): string {
  const cost =
    when === "before"
      ? "nothing was recorded, so the plugin's edits will stay after this scenario"
      : "nothing was put back";
  return (
    `the record folder ${dir} is not a private folder of this run's user (another user's, a link, or ` +
    `open to others), so it is never used: ${cost}. Remove it to resume.`
  );
}

/** A record folder as the engine names it: an absolute path ending in `e2e-record-<16 hex>-<uid>`. */
const RECORD_DIR = /^\/[^\0\n]*\/e2e-record-[0-9a-f]{16}-\d+$/;

/** Reads a blocked record folder, or `undefined` when absent. */
function parseBlocked(value: unknown, stdout: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !RECORD_DIR.test(value)) {
    throw unreadable(stdout);
  }
  return value;
}

/** Reads an unusable reason, or `undefined` for `null`. */
function parseUnusable(
  value: unknown,
  stdout: string,
): UnusableReason | undefined {
  if (value === null || value === undefined) return undefined;
  const reason = UNUSABLE_REASONS.find((known) => known === value);
  if (reason === undefined) throw unreadable(stdout);
  return reason;
}

/**
 * Reads the engine's answer: its last line, JSON (PHP may print notices before it).
 *
 * @param stdout - the engine's output.
 * @param edits - the declaration it ran with: every index must name an entry.
 * @throws Error on an answer that is not one the engine gives.
 */
export function parseRecordAnswer(
  stdout: string,
  edits: ConfigEdits,
): RecordAnswer {
  const value = lastJsonLine(stdout);
  const blocked = parseBlocked(value.blocked, stdout);
  if (blocked !== undefined) {
    return {
      blocked,
      reconciled: undefined,
      unusable: undefined,
      discarded: false,
      swept: 0,
      unswept: 0,
    };
  }
  // `unswept` absent reads as none: only a sweep that left something says so.
  const { reconciled, unusable, discarded, swept, unswept = 0 } = value;
  if (
    typeof discarded !== "boolean" ||
    !Number.isInteger(swept) ||
    !Number.isInteger(unswept)
  )
    throw unreadable(stdout);
  return {
    blocked: undefined,
    reconciled:
      reconciled === null
        ? undefined
        : parseOutcomes(reconciled, edits, stdout),
    unusable: parseUnusable(unusable, stdout),
    discarded,
    swept: swept as number,
    unswept: unswept as number,
  };
}

/**
 * Reads the restore step's answer — see {@link parseRecordAnswer}.
 *
 * @param stdout - the engine's output.
 * @param edits - the declaration it ran with.
 * @throws Error on an answer that is not one the engine gives.
 */
export function parseRestoreAnswer(
  stdout: string,
  edits: ConfigEdits,
): RestoreAnswer {
  const value = lastJsonLine(stdout);
  if (value.none === true) return { kind: "none" };
  const blocked = parseBlocked(value.blocked, stdout);
  if (blocked !== undefined) return { kind: "blocked", dir: blocked };
  const reason = parseUnusable(value.unusable, stdout);
  if (reason !== undefined) return { kind: "unusable", reason };
  return {
    kind: "restored",
    outcomes: parseOutcomes(value.outcomes, edits, stdout),
  };
}

/**
 * The last line of `stdout` as a JSON object.
 *
 * @param stdout - the engine's output.
 * @throws Error when it is not one.
 */
function lastJsonLine(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").at(-1) ?? "";
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw unreadable(stdout);
  }
  if (!isObject(value)) throw unreadable(stdout);
  return value;
}

/**
 * Reads a list of outcomes, each checked against the declaration.
 *
 * @param value - the list as parsed.
 * @param edits - the declaration.
 * @param stdout - the whole answer, for the error.
 */
function parseOutcomes(
  value: unknown,
  edits: ConfigEdits,
  stdout: string,
): readonly ConfigEditOutcome[] {
  if (!Array.isArray(value)) throw unreadable(stdout);
  return value.map((entry: unknown): ConfigEditOutcome => {
    if (!isObject(entry)) throw unreadable(stdout);
    const { kind, index, result, mode, owner } = entry;
    if (
      (kind !== "file" && kind !== "created-file" && kind !== "dir") ||
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= listOf(edits, kind).length ||
      typeof result !== "string" ||
      !resultsOf(kind).includes(result)
    ) {
      throw unreadable(stdout);
    }
    return {
      kind,
      index,
      result,
      ...(mode === undefined ? {} : { mode: parseMode(mode, stdout) }),
      ...(owner === undefined ? {} : { owner: parseOwner(owner, stdout) }),
    };
  });
}

/** Reads an outcome's `mode`. */
function parseMode(
  value: unknown,
  stdout: string,
): NonNullable<ConfigEditOutcome["mode"]> {
  if (!isObject(value)) throw unreadable(stdout);
  const { found, recorded, restored } = value;
  if (!isMode(found) || !isMode(recorded) || typeof restored !== "boolean") {
    throw unreadable(stdout);
  }
  return { found, recorded, restored };
}

/** Reads an outcome's `owner`. */
function parseOwner(
  value: unknown,
  stdout: string,
): NonNullable<ConfigEditOutcome["owner"]> {
  if (!isObject(value)) throw unreadable(stdout);
  const { found, recorded } = value;
  const owner = /^\d+:\d+$/;
  if (
    typeof found !== "string" ||
    typeof recorded !== "string" ||
    !owner.test(found) ||
    !owner.test(recorded)
  ) {
    throw unreadable(stdout);
  }
  return { found, recorded };
}

/** Whether a value is a permission mode (`0`–`07777`). */
function isMode(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0o7777
  );
}

/** The declaration's list an outcome kind indexes. */
function listOf(edits: ConfigEdits, kind: OutcomeKind): readonly unknown[] {
  if (kind === "file") return edits.files;
  if (kind === "created-file") return edits.createdFiles ?? [];
  return edits.createdDirs ?? [];
}

/** The results an outcome kind may carry. */
function resultsOf(kind: OutcomeKind): readonly string[] {
  if (kind === "file") return FILE_RESULTS;
  if (kind === "created-file") return CREATED_FILE_RESULTS;
  return DIR_RESULTS;
}

/** The error for an answer this module cannot read; shown plain and cut, never in full. */
function unreadable(stdout: string): Error {
  return new Error(
    `[wp/config-edits] the engine answered something unreadable: ${plain(stdout.trim()).slice(0, 200)}`,
  );
}

/** What a set of outcomes calls for: warnings (something left as it is), notes (something set back). */
export interface ConfigEditsReport {
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Words for every outcome that deserves any: a path left untouched (a warning) or a mode set back (a
 * note). A file put back, removed, or found unchanged says nothing — that is the normal case.
 *
 * @param outcomes - the engine's outcomes.
 * @param edits - the declaration they index.
 */
export function configEditsReport(
  outcomes: readonly ConfigEditOutcome[],
  edits: ConfigEdits,
): ConfigEditsReport {
  const warnings: string[] = [];
  const notes: string[] = [];
  for (const outcome of outcomes) {
    const path = pathOf(outcome, edits);
    const said = outcomeMessage(outcome.result, path);
    if (said !== undefined) warnings.push(said);
    if (outcome.mode !== undefined) {
      const { found, recorded, restored } = outcome.mode;
      if (restored) {
        notes.push(
          `"${path}"'s mode set back to ${octal(recorded)} (the scenario left ${octal(found)}).`,
        );
      } else {
        warnings.push(
          `"${path}"'s mode is ${octal(found)}, ${octal(recorded)} before the scenario: it could not be set back.`,
        );
      }
    }
    if (outcome.owner !== undefined) {
      warnings.push(
        `"${path}" is owned by ${outcome.owner.found} (uid:gid), ${outcome.owner.recorded} before the scenario: ` +
          "ownership is never changed here.",
      );
    }
  }
  return { warnings, notes };
}

/** The declared path an outcome is about. */
function pathOf(outcome: ConfigEditOutcome, edits: ConfigEdits): string {
  const entry = listOf(edits, outcome.kind)[outcome.index];
  if (typeof entry === "string") return entry;
  return (entry as { readonly path: string }).path;
}

/**
 * The warning for a result that left a path as it is, or `undefined` for one that needs none.
 *
 * @param result - the outcome's result.
 * @param path - the declared path.
 */
export function outcomeMessage(
  result: string,
  path: string,
): string | undefined {
  switch (result) {
    case "unrecognized":
      return `"${path}" changed in a way the plugin's own edits do not explain: left untouched.`;
    case "unwritable":
      return `"${path}" holds only the plugin's edits, but this run's commands cannot write it: left as it is.`;
    case "resumed":
      return `"${path}" was found cut short (a write interrupted part-way): put back in full from the record.`;
    case "replaced":
      return `"${path}" was replaced while it was being put back (a link or another file): left untouched.`;
    case "missing":
      return `"${path}" was there before the scenario and is gone: not recreated.`;
    case "link":
      return `"${path}" is a symbolic link: never followed, left untouched.`;
    case "not-a-file":
    case "not-a-dir":
      return `"${path}" is not what was recorded (a file or a directory): left untouched.`;
    case "appeared":
      return `"${path}" did not exist before the scenario and holds more than the plugin's edits: left.`;
    case "not-recorded":
      return `"${path}" is not in the record (taken by an older suite?): left untouched.`;
    case "changed":
      return `"${path}" changed during the scenario (its bytes are not recorded): left as it is.`;
    case "foreign":
      return `"${path}" did not exist before the scenario and is not the plugin's (neither empty nor marked): left.`;
    case "not-empty":
      return `"${path}" did not exist before the scenario and is not empty: left.`;
    default:
      return undefined;
  }
}

/** A mode as `0644`. */
function octal(mode: number): string {
  return `0${mode.toString(8).padStart(3, "0")}`;
}
