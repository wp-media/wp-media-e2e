import type { TestResult } from "@playwright/test/reporter";

import { fullCommit } from "../artifacts/pin";
import { escapeRegExp, MAX_COMBINING_MARKS, redactSecrets } from "../text";
import { capLine, padEnd } from "../terminal/layout";
import {
  failedStep,
  firstError,
  type FailedStep,
  type StepLike,
} from "./results";
import { displayPath, displayText, shellWord } from "./run-summary";
import type { PluginFact } from "./setup-facts";
import { errorLine, type TerminalStyle } from "./terminal-lines";

/**
 * The block printed under a test's final failure: what failed — the Gherkin step, never an API
 * step's title (Playwright titles a `fill()` with the text it typed) — where it is written, its first
 * error, the screenshots and traces it left, and a command that runs it again. Pure: the test's
 * facts and the stream's style are parameters.
 *
 * Every field but the command is external text shown as {@link displayText} makes it — plain, then
 * masked — then capped ({@link capLine}). The command is built from the **raw** title, never a
 * displayed one (`plain` drops and replaces characters, so its output may select nothing), and is
 * never cut: it is printed whole or not at all ({@link rerunCommand}).
 */

/** How wide the block's labels column is: the summary's, so both read alike. */
const LABEL_WIDTH = 12;

/** The indent of the block's lines under the test's own line. */
const INDENT = "  ";

/**
 * The longest command printed. Past it, a title is no longer something a person reruns from a
 * terminal, and printing it whole would flood the log a run's reason quotes the tail of.
 */
export const RERUN_LIMIT = 2_000;

/**
 * The characters a command must never carry onto a terminal: controls (an escape, a newline, a
 * tab), invisible format characters (a bidi override would show the command as something it is not),
 * line and paragraph separators, and lone surrogates.
 */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/gu;

/** A run of combining marks past the {@link MAX_COMBINING_MARKS} a line shows: those kept, then the rest. */
const EXCESS_MARKS = new RegExp(
  `(\\p{M}{${String(MAX_COMBINING_MARKS)}})(\\p{M}+)`,
  "gu",
);

/**
 * Each UTF-16 unit of `text` as a regular-expression escape (`\u001b`): what a pattern matches the
 * character by, without the character itself.
 *
 * @param text - the characters.
 */
function unitEscapes(text: string): string {
  let escaped = "";
  for (let index = 0; index < text.length; index += 1) {
    escaped += `\\u${text.charCodeAt(index).toString(16).padStart(4, "0")}`;
  }
  return escaped;
}

/**
 * A title as a regular expression matching it literally: every metacharacter escaped, and the
 * characters a terminal would act on or hide ({@link UNSAFE}) and combining marks past the eighth in a
 * run written as `\uXXXX` escapes — the pattern still matches the raw title, and holds nothing but
 * visible characters.
 *
 * @param title - one title, raw.
 */
function literal(title: string): string {
  return escapeRegExp(title)
    .replace(UNSAFE, unitEscapes)
    .replace(
      EXCESS_MARKS,
      (_all, kept: string, rest: string) => `${kept}${unitEscapes(rest)}`,
    );
}

/**
 * What follows a title in the text `--grep` is matched against: the tags it carries, each ` @tag`
 * (Playwright takes a tag to be `@` and what follows up to a space; a Gherkin tag holds none).
 */
const TAGS = "(?: @\\S+)*";

/**
 * The `--grep` value that selects a test by its exact place: its file, its describes (a scenario's
 * Feature, any Rule or Outline) and its own title, as Playwright reads it. Wrapped in slashes, which
 * makes Playwright build the regular expression from what is between them with no flags —
 * case-sensitive, where a bare value is matched case-insensitively.
 *
 * Playwright matches it against one line: the project, then the file and each describe — each title
 * followed by its tags — then the test's title and its tags, joined by spaces. So the pattern is each
 * title ({@link literal}), then {@link TAGS}, joined by spaces, after a space and up to the end:
 * another scenario whose title holds this one (`Create a backup encrypted`, `Untagged Create a
 * backup`), or one of the same title in another feature or file, does not match; only a test of the
 * same file, describes and title — a duplicate — does. Line terminators are escaped anyway: Playwright
 * reads the slashes only around a single line.
 *
 * @param title - the test's own title, raw.
 * @param above - the titles above it, outermost first, raw: its file (relative to the config's
 *   folder, as `titlePath()` names it), then each describe — `titlePath()` between the project and
 *   the title. An empty one is left out, as Playwright leaves an untitled describe out.
 * @example
 * ```ts
 * grepPattern("Create a backup (a+b)", ["b.feature.spec.js", "Backups"]);
 * // "/ b\\.feature\\.spec\\.js(?: @\\S+)* Backups(?: @\\S+)* Create a backup \\(a\\+b\\)(?: @\\S+)*$/"
 * grepPattern("a\u001b[31mb"); // "/ a\\u001b\\[31mb(?: @\\S+)*$/"
 * ```
 */
export function grepPattern(
  title: string,
  above: readonly string[] = [],
): string {
  const parts = [...above.filter((part) => part !== ""), title];
  return `/ ${parts.map((part) => `${literal(part)}${TAGS}`).join(" ")}$/`;
}

/**
 * The plugin build a rerun is pinned to: a zip, or what a build is asked for — a ref
 * (`E2E_PLUGIN_REF`) and the version to build (`E2E_PLUGIN_VERSION`), either one or both.
 */
export type PluginPin =
  | { readonly kind: "zip"; readonly zip: string }
  | {
      readonly kind: "build";
      readonly ref?: string;
      readonly version?: string;
    };

/**
 * What the operator set for the plugin under test, trimmed (`E2E_PLUGIN_REF`, `E2E_PLUGIN_ZIP`,
 * `E2E_PLUGIN_VERSION`).
 */
export interface PluginOverrides {
  readonly ref?: string;
  readonly zip?: string;
  readonly version?: string;
}

/** The pin the artifacts setup records for a release download: its resolved tag (`release:3.17.4`). */
const RELEASE_PIN = /^release:[^\s:]+$/;

/**
 * The plugin build a rerun should test, so it tests what the run tested — in the pin form a pinned run
 * is handed (`commit:<sha>` with its version, or `release:<tag>`), which plans to the same build:
 *
 * - the zip the operator gave, when the artifacts setup used one;
 * - else the release the setup downloaded (`release:<tag>`, never the selector it was asked for);
 * - else the commit it built, `commit:<full sha>`, with the version its zip declares — a moving branch
 *   would no longer give that commit, and a product's default version may not be the one built;
 * - else, when the setup left no proof of what it built (it failed before, or never ran) and the
 *   run targeted its cell, what the operator set: the zip, else the ref and version;
 * - else none: the product's defaults.
 *
 * A run of every cell ignores what the operator set (its artifacts setup warns so), so only a record
 * pins its rerun.
 *
 * @param fact - the plugin under test, as the cell's artifacts setup recorded it; absent when it left
 *   no record (it failed early, was skipped, or has not run).
 * @param overrides - what the operator set.
 * @param targeted - whether the run targeted the test's cell, so what the operator set applied.
 */
export function pluginPin(
  fact: PluginFact | undefined,
  overrides: PluginOverrides,
  targeted: boolean,
): PluginPin | undefined {
  if (fact?.ok === true) {
    if (fact.source === "env-zip") {
      return overrides.zip === undefined
        ? undefined
        : { kind: "zip", zip: overrides.zip };
    }
    if (fact.pin !== undefined && RELEASE_PIN.test(fact.pin)) {
      return { kind: "build", ref: fact.pin };
    }
    const commit =
      fact.commit === undefined ? undefined : fullCommit(fact.commit);
    if (commit !== undefined) {
      return {
        kind: "build",
        ref: `commit:${commit}`,
        ...(fact.version !== undefined ? { version: fact.version } : {}),
      };
    }
  }
  if (!targeted) return undefined;
  if (overrides.zip !== undefined) return { kind: "zip", zip: overrides.zip };
  if (overrides.ref === undefined && overrides.version === undefined) {
    return undefined;
  }
  return {
    kind: "build",
    ...(overrides.ref !== undefined ? { ref: overrides.ref } : {}),
    ...(overrides.version !== undefined ? { version: overrides.version } : {}),
  };
}

/**
 * A pin's variables, as `NAME=value` pairs, in the order they are printed.
 *
 * @param pin - the pin.
 */
function pinVariables(pin: PluginPin): (readonly [string, string])[] {
  if (pin.kind === "zip") return [["E2E_PLUGIN_ZIP", pin.zip]];
  return [
    ...(pin.ref !== undefined ? [["E2E_PLUGIN_REF", pin.ref] as const] : []),
    ...(pin.version !== undefined
      ? [["E2E_PLUGIN_VERSION", pin.version] as const]
      : []),
  ];
}

/** What a rerun runs: one product, in the test's cell, pinned to a build. */
export interface RerunTarget {
  readonly product: string;
  /**
   * The test's cell — in a run of every cell too, so the rerun runs that cell alone and the pin
   * applies. Absent only when unknown.
   */
  readonly cell?: string;
  readonly pin?: PluginPin;
}

/**
 * What a rerun selects: a scenario by its raw title and the titles above it (its file, its Feature,
 * any Rule or Outline: {@link grepPattern}'s `above`), or a setup by its project.
 */
export type RerunSelection =
  | { readonly title: string; readonly above?: readonly string[] }
  | { readonly project: string };

/** A rerun command, or why none is printed. */
export type RerunCommand =
  { readonly command: string } | { readonly refused: string };

/**
 * The command that runs a failed test again: `E2E_CELL=<cell> [E2E_PLUGIN_REF=<ref>
 * [E2E_PLUGIN_VERSION=<version>] | E2E_PLUGIN_ZIP=<zip>] npm run test:<product> -- --grep=<pattern>`
 * (or `--project=<setup>`), every value one shell word ({@link shellWord}). The pattern
 * ({@link grepPattern}) selects the scenario and its exact duplicates only.
 *
 * Refused, rather than printed altered, when the command would hold a character a terminal acts on
 * (only a zip path or ref can: the title's are escaped), a credential's shape — in the command or in a
 * raw value it quotes ({@link redactSecrets} would change it) — or more than {@link RERUN_LIMIT}
 * characters. A masked or cut command would run something else.
 *
 * @param target - the product, cell and build.
 * @param selection - the test.
 * @example
 * ```ts
 * rerunCommand({ product: "backwpup", cell: "pro@nginx" }, { title: "Create a backup", above: ["Backups"] });
 * // { command: "E2E_CELL=pro@nginx npm run test:backwpup -- --grep='/ Backups(?: @\\S+)* Create a backup(?: @\\S+)*$/'" }
 * ```
 */
export function rerunCommand(
  target: RerunTarget,
  selection: RerunSelection,
): RerunCommand {
  const words: string[] = [];
  if (target.cell !== undefined) {
    words.push(`E2E_CELL=${shellWord(target.cell)}`);
  }
  const variables = target.pin === undefined ? [] : pinVariables(target.pin);
  for (const [name, value] of variables) {
    words.push(`${name}=${shellWord(value)}`);
  }
  const filter =
    "title" in selection
      ? `--grep=${shellWord(grepPattern(selection.title, selection.above))}`
      : `--project=${shellWord(selection.project)}`;
  words.push("npm", "run", shellWord(`test:${target.product}`), "--", filter);
  const command = words.join(" ");
  if (command.length > RERUN_LIMIT) {
    return { refused: "the title is too long for a command line" };
  }
  if (new RegExp(UNSAFE.source, "u").test(command)) {
    return {
      refused: "a value in it holds characters a terminal would act on",
    };
  }
  // The raw values too: today's shapes survive the pattern's escapes and quoting, so the command
  // alone shows them; checking the values keeps a shape a future escape could break from slipping by.
  const values = [
    command,
    ...selectionTitles(selection),
    ...variables.map(([, value]) => value),
  ];
  if (values.some((value) => redactSecrets(value) !== value)) {
    return { refused: "it would quote a value shaped like a credential" };
  }
  return { command };
}

/**
 * The raw texts a selection names: a scenario's titles (its file's, describes', own), or a setup's
 * project.
 *
 * @param selection - the selection.
 */
function selectionTitles(selection: RerunSelection): readonly string[] {
  return "title" in selection
    ? [...(selection.above ?? []), selection.title]
    : [selection.project];
}

/**
 * Why a test's attachment paths are not shown, or `undefined` when they are: Playwright names a
 * test's output folder after its titles, cut and hashed, so a credential-shaped title would show in
 * the path partly — beyond what masking can find again.
 *
 * @param selection - the test.
 */
export function pathsWithheld(selection: RerunSelection): string | undefined {
  return selectionTitles(selection).some(
    (title) => redactSecrets(title) !== title,
  )
    ? "its folder is named after a title shaped like a credential"
    : undefined;
}

/**
 * The paths of an attempt's attachments called `name` (`screenshot`, `trace`), as a person would
 * type them from `cwd`. Attachments held in memory have no path and are left out.
 *
 * @param result - the attempt.
 * @param name - the attachment's name.
 * @param cwd - the working directory.
 */
export function attachmentPaths(
  result: Pick<TestResult, "attachments">,
  name: string,
  cwd: string,
): string[] {
  return result.attachments
    .filter((attachment) => attachment.name === name)
    .flatMap((attachment) =>
      attachment.path === undefined ? [] : [displayPath(attachment.path, cwd)],
    );
}

/** What a failure block says. */
export interface FailureFacts {
  /** For a setup: its project, which nothing in its cell runs without. */
  readonly setup?: string;
  readonly step?: FailedStep;
  /** The `.feature` file, relative to the repository; no line (the reported one is the generated spec's). */
  readonly feature?: string;
  /** The first error's message, as {@link firstError} cleaned it. */
  readonly error?: string;
  readonly screenshots: readonly string[];
  readonly traces: readonly string[];
  /** Why the screenshot and trace paths are not shown ({@link pathsWithheld}); absent: shown. */
  readonly withheld?: string;
  readonly rerun: RerunCommand;
}

/**
 * The facts of a test's final failure.
 *
 * @param result - its last attempt.
 * @param where - its `.feature` file, a setup's project, and the rerun's target and selection.
 * @param cwd - the working directory, which paths are shown from.
 */
export function failureFacts(
  result: Pick<TestResult, "errors" | "attachments"> & {
    readonly steps: readonly StepLike[];
  },
  where: {
    readonly feature?: string;
    readonly setup?: string;
    readonly target: RerunTarget;
    readonly selection: RerunSelection;
  },
  cwd: string,
): FailureFacts {
  const error = firstError(result);
  const step = failedStep(result);
  const withheld = pathsWithheld(where.selection);
  return {
    ...(where.setup !== undefined ? { setup: where.setup } : {}),
    ...(step !== undefined ? { step } : {}),
    ...(where.feature !== undefined ? { feature: where.feature } : {}),
    ...(error !== undefined ? { error: error.message } : {}),
    screenshots: attachmentPaths(result, "screenshot", cwd),
    traces: attachmentPaths(result, "trace", cwd),
    ...(withheld !== undefined ? { withheld } : {}),
    rerun: rerunCommand(where.target, where.selection),
  };
}

/**
 * The block's lines, under the test's own line — which names the scenario — each `  Label  value`:
 *
 * ```text
 *   Step        When the backup runs
 *   Feature     src/projects/backwpup/features/backups.feature
 *   Error       Error: expect(locator).toBeVisible() failed
 *   Screenshot  test-results/backwpup/pro@nginx/…/test-failed-1.png
 *   Trace       test-results/backwpup/pro@nginx/…/trace.zip
 *   Rerun       E2E_CELL=pro@nginx E2E_PLUGIN_REF=commit:af1ab5c4… E2E_PLUGIN_VERSION=9.99.99 npm run …
 * ```
 *
 * A setup's block opens with `Setup  <project> — no scenario of its cell runs without it`. Every value
 * but the command is plain, masked and capped; paths are quoted for a shell — or, for a title shaped
 * like a credential, each kind replaced by `not shown: <why>`; the command is printed whole, or the
 * reason it is not. The glyphs (`›`, `—`, `…`) are the palette's: ASCII under plain output.
 *
 * @param style - the stream's style.
 * @param facts - what the block says.
 */
export function failureBlockLines(
  style: TerminalStyle,
  facts: FailureFacts,
): string[] {
  const { palette } = style;
  const ellipsis = palette.symbol("ellipsis");
  const dash = palette.symbol("dash");
  const separator = palette.symbol("separator");
  const breadcrumb = ` ${palette.symbol("breadcrumb")} `;
  const shown = (text: string): string => capLine(displayText(text), ellipsis);
  const lines: string[] = [];
  const add = (label: string, value: string): void => {
    if (value === "") return;
    lines.push(
      `${INDENT}${palette.paint("emphasis", padEnd(label, LABEL_WIDTH))}${value}`,
    );
  };
  if (facts.setup !== undefined) {
    add(
      "Setup",
      shown(`${facts.setup} ${dash} no scenario of its cell runs without it`),
    );
  }
  if (facts.step !== undefined) {
    const running = facts.step.running
      ? palette.paint("dim", ` ${separator} running when the attempt ended`)
      : "";
    const path = facts.step.path
      .map(displayText)
      .filter((part) => part !== "")
      .join(breadcrumb);
    add(facts.step.label, `${capLine(path, ellipsis)}${running}`);
  }
  if (facts.feature !== undefined) add("Feature", shown(facts.feature));
  if (facts.error !== undefined) {
    add("Error", errorLine(style, facts.error)?.trimStart() ?? "");
  }
  for (const [label, paths] of [
    ["Screenshot", facts.screenshots],
    ["Trace", facts.traces],
  ] as const) {
    if (facts.withheld !== undefined && paths.length > 0) {
      add(label, palette.paint("dim", `not shown: ${facts.withheld}`));
      continue;
    }
    for (const path of paths) add(label, shellWord(shown(path)));
  }
  add(
    "Rerun",
    "command" in facts.rerun
      ? palette.paint("command", facts.rerun.command)
      : palette.paint("dim", `not shown: ${facts.rerun.refused}`),
  );
  return lines;
}
