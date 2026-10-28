import { isAbsolute, relative, sep } from "node:path";
import { styleText } from "node:util";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";

import { cellOfProject, type SetupKind } from "../config/project-names";
import { errorMessage } from "../guards";
import { maskSiteUrl, plain, redactSecrets } from "../text";

// Shared with the facts, the prune command and the Site Health reader; re-exported for its importers.
export { plain };
import {
  ARTIFACTS_ATTACHMENT,
  SITE_INFO_ATTACHMENT,
} from "../setup/attachments";
import {
  RunTally,
  firstError,
  setupOf,
  type Counts,
  type TestStatus,
} from "./results";
import {
  readRunDescription,
  reporterMode,
  type RunDescription,
} from "./run-description";
import { describePruning, pruneRunGroup, type PruneLine } from "./run-pruning";
import { outputModeOption } from "./terminal-mode";
import {
  parsePluginFacts,
  parseSiteFacts,
  readJsonAttachment,
  type PluginFact,
  type SiteFact,
} from "./setup-facts";

/**
 * The end-of-run summary a person reads: the verdict, the counts, what was tested — the plugin and
 * the site — and where the reports are. Playwright's own ending names only its HTML report, and only
 * at a terminal; it never says what was tested, nor that a failed setup meant nothing could be.
 *
 * Printed in `onExit` by the **last** reporter: the only slot below everything else, Playwright's
 * counts and its report hint included, on a pass, a failure, a failed setup and an interrupt
 * (SIGTERM ends a run before any reporter's `onExit`). Silent for `--list`, which runs nothing.
 *
 * @example
 * ```text
 * ━━ backwpup · pro@nginx (pro) ━━ ✘ FAILED ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *   Result      2 failed · 1 flaky · 11 passed · 1 skipped, in 14.2m
 *   Plugin      BackWPup Pro 9.99.99 · develop @ af1ab5c4d2
 *   Site        https://bwu3.example · WordPress 7.1.2 · PHP 8.5.10
 *   Playwright  npx playwright show-report reports/backwpup/pro@nginx/<RUN_ID>/playwright
 *   Cucumber    reports/backwpup/pro@nginx/<RUN_ID>/cucumber/index.html
 *   Allure      npm run report:allure -- backwpup pro@nginx --open
 *   Pruned      1 old report, 4.3 MB — beyond the newest 20 (E2E_REPORTS_KEEP)
 * ```
 *
 * Before printing, it prunes the run's report folder's group (`run-pruning.ts`): the last reporter's
 * `onExit` comes after every report is written, and `Pruned` says what went — only when something did.
 */

/** What a run came to, in the summary's words. */
export type Verdict =
  | "passed"
  | "failed"
  | "could-not-test"
  | "interrupted"
  | "stopped"
  | "no-tests";

/** What one cell's setups found out. */
export interface CellFacts {
  /** The plugin zips under test; absent when the artifacts setup left no record. */
  readonly plugins?: readonly PluginFact[];
  /** Each site's versions; absent when the auth setup left no record. */
  readonly sites?: readonly SiteFact[];
  /** The setups of the cell that failed. */
  readonly failed: readonly SetupKind[];
}

/** A setup that failed, and why. */
export interface SetupFailure {
  readonly project: string;
  readonly setup: SetupKind;
  /** The first error's first line. */
  readonly message: string;
}

/** Everything the summary says, gathered as the run went. */
export interface SummaryInput {
  readonly run: RunDescription;
  /** The run's report folder as the summary shows it ({@link displayPath}). */
  readonly reportDir: string;
  /** Playwright's status for the run. */
  readonly status: FullResult["status"];
  readonly durationMs: number;
  readonly scenarios: Counts;
  readonly setupFailures: readonly SetupFailure[];
  /**
   * The errors raised outside any test — a test file that would not load, a global setup that threw —
   * each its first line; "No tests found" is not one ({@link RunTally.runError}). Absent: none.
   */
  readonly runErrors?: readonly string[];
  /** Each cell's facts, in the order its setups reported them. */
  readonly cells: ReadonlyMap<string, CellFacts>;
  /** What the run's pruning removed or could not; nothing when it removed nothing. */
  readonly pruned?: readonly PruneLine[];
}

/** Colours a piece of the summary; identity when colours are off (a spec, a pipe). */
export type Styler = (
  format: Parameters<typeof styleText>[0],
  text: string,
) => string;

/** How wide the header rule runs. */
const WIDTH = 88;

/** How wide the labels column is. */
const LABEL_WIDTH = 12;

/** The longest setup error a line shows. */
const SETUP_MESSAGE_LIMIT = 200;

/** How many characters of a commit the summary shows; the reports carry it whole. */
const SHORT_COMMIT = 10;

/** Each verdict's mark and colour. */
const VERDICTS: Readonly<
  Record<
    Verdict,
    { readonly text: string; readonly color: "green" | "red" | "yellow" }
  >
> = {
  passed: { text: "✔ PASSED", color: "green" },
  failed: { text: "✘ FAILED", color: "red" },
  "could-not-test": { text: "✘ COULD NOT TEST", color: "red" },
  interrupted: { text: "■ INTERRUPTED", color: "yellow" },
  stopped: { text: "■ STOPPED", color: "yellow" },
  "no-tests": { text: "NO TESTS", color: "yellow" },
};

/**
 * The run's verdict. An interrupt is said first — the person who pressed Ctrl+C knows why the rest
 * failed — then a failed setup, which means the cell could not be tested at all. A run that planned
 * no scenario says "no tests" only when nothing went wrong: a test file that would not load leaves
 * none planned too, and that run failed. Then a stop: a drained scenario never ran, so a run the drain
 * cut short never says it passed — its counts still say what failed before the stop.
 *
 * @param input - the run's status, its scenarios' counts, its failed setups and its errors outside
 *   any test.
 */
export function verdictOf(
  input: Pick<
    SummaryInput,
    "status" | "scenarios" | "setupFailures" | "runErrors"
  >,
): Verdict {
  if (input.status === "interrupted") return "interrupted";
  if (input.setupFailures.length > 0) return "could-not-test";
  if (input.scenarios.total === 0) {
    return (input.runErrors?.length ?? 0) > 0 ? "failed" : "no-tests";
  }
  if (input.scenarios.drained > 0) return "stopped";
  if (
    input.status !== "passed" ||
    input.scenarios.failed > 0 ||
    input.scenarios.interrupted > 0
  ) {
    return "failed";
  }
  return "passed";
}

/**
 * A duration as a person reads it: `42s`, `14.2m`, `2.3h`.
 *
 * @param ms - the duration in milliseconds.
 */
export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${String(Math.round(seconds))}s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toFixed(1)}m`;
  return `${(minutes / 60).toFixed(1)}h`;
}

/**
 * The scenarios' counts in one phrase, the worst first, a zero left out.
 *
 * @param counts - the scenarios' counts.
 * @example
 * ```ts
 * describeCounts(counts); // "2 failed · 1 flaky · 11 passed · 3 did not run"
 * ```
 */
export function describeCounts(counts: Counts): string {
  const parts: [number, string][] = [
    [counts.failed, "failed"],
    [counts.interrupted, "interrupted"],
    [counts.flaky, "flaky"],
    [counts.passed, "passed"],
    [counts.skipped - counts.drained, "skipped"],
    [counts.drained, "stopped"],
    [counts.didNotRun, "did not run"],
  ];
  const said = parts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${String(count)} ${word}`);
  return said.length === 0 ? "no scenarios ran" : said.join(" · ");
}

/**
 * One plugin zip in a phrase: its name and version, then where it came from; shown as
 * {@link displayText} says — a failed resolution's error can quote anything.
 *
 * @param fact - the zip, as the artifacts setup recorded it.
 * @example
 * ```ts
 * describePlugin(fact); // "BackWPup Pro 9.99.99 · develop @ af1ab5c4d2"
 * ```
 */
export function describePlugin(fact: PluginFact): string {
  return displayText(pluginPhrase(fact));
}

/** {@link describePlugin}'s phrase, before it is made {@link displayText}. */
function pluginPhrase(fact: PluginFact): string {
  if (!fact.ok) return `resolution failed — ${fact.error}`;
  const name = [fact.name ?? "plugin", fact.version].filter(Boolean).join(" ");
  const origin =
    fact.source === "env-zip"
      ? fact.zip === undefined
        ? "a provided zip"
        : `zip ${fact.zip}`
      : [
          fact.ref,
          fact.commit === undefined
            ? undefined
            : `@ ${fact.commit.slice(0, SHORT_COMMIT)}`,
          fact.pin === undefined ? undefined : `(${fact.pin})`,
        ]
          .filter(Boolean)
          .join(" ");
  return origin === "" ? name : `${name} · ${origin}`;
}

/**
 * One site in a phrase: its URL, WordPress and PHP — the full set is in the reports. Shown as
 * {@link displayText} says: the versions are what the site says, and a sites file's URL may carry
 * basic-auth credentials.
 *
 * @param fact - the site, as the auth setup recorded it.
 */
export function describeSite(fact: SiteFact): string {
  if ("error" in fact) {
    return displayText(
      `${maskSiteUrl(fact.baseURL)} · versions unknown — ${fact.error}`,
    );
  }
  const { wordpress, php } = fact.versions;
  return displayText(
    [
      maskSiteUrl(fact.baseURL),
      `WordPress ${wordpress ?? "unknown"}`,
      `PHP ${php ?? "unknown"}`,
    ].join(" · "),
  );
}

/** A label's lines: the label on the first, aligned blanks on the rest. */
function labelled(
  style: Styler,
  label: string,
  values: readonly string[],
): string[] {
  return values.map(
    (value, index) =>
      `  ${style("bold", (index === 0 ? label : "").padEnd(LABEL_WIDTH))}${value}`,
  );
}

/**
 * A phrase cut to `limit` characters, an ellipsis included, never inside a surrogate pair.
 *
 * @param text - the phrase.
 * @param limit - the most characters it may take.
 */
export function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const end = limit - 1;
  const last = text.charCodeAt(end - 1);
  return `${text.slice(0, last >= 0xd800 && last <= 0xdbff ? end - 1 : end)}…`;
}

/**
 * A value as the summary and the reports show what a site, a setup or the environment said: one
 * {@link plain} line, every credential in it masked ({@link redactSecrets}). Cut it short only after:
 * a cut can split a credential from what marks it.
 *
 * @param text - the value.
 */
export function displayText(text: string): string {
  return redactSecrets(plain(text));
}

/**
 * A folder as a person would type it from where the run was started: relative when it lies below,
 * absolute otherwise.
 *
 * @param path - the folder, absolute.
 * @param cwd - the working directory.
 */
export function displayPath(path: string, cwd: string): string {
  const inside = relative(cwd, path);
  if (inside === "") return ".";
  return isAbsolute(inside) || inside.split(sep)[0] === ".." ? path : inside;
}

/** The characters a shell reads as part of a word, unquoted. */
const SHELL_SAFE = /^[\w@%+=:,./-]+$/;

/**
 * A path as one shell word, single-quoted when it holds anything a shell would read otherwise.
 *
 * @param text - the path.
 */
export function shellWord(text: string): string {
  return SHELL_SAFE.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
}

/** The plugin lines, per role: `Plugin` for the zip under test, `Previous` for the other. */
function pluginLines(
  style: Styler,
  cells: ReadonlyMap<string, CellFacts>,
  prefix: (cell: string) => string,
): string[] {
  const byLabel = new Map<string, string[]>();
  const add = (label: string, value: string): void => {
    byLabel.set(label, [...(byLabel.get(label) ?? []), value]);
  };
  for (const [cell, facts] of cells) {
    if (facts.plugins === undefined) {
      if (facts.failed.includes("artifacts")) {
        add("Plugin", `${prefix(cell)}unknown — the artifacts setup failed`);
      }
      continue;
    }
    for (const fact of facts.plugins) {
      add(
        fact.role === "plugin" ? "Plugin" : "Previous",
        `${prefix(cell)}${describePlugin(fact)}`,
      );
    }
  }
  return [...byLabel].flatMap(([label, values]) =>
    labelled(style, label, values),
  );
}

/** The site lines: one per site of each cell. */
function siteLines(
  style: Styler,
  cells: ReadonlyMap<string, CellFacts>,
  prefix: (cell: string) => string,
): string[] {
  const values: string[] = [];
  for (const [cell, facts] of cells) {
    if (facts.sites === undefined) {
      if (facts.failed.includes("auth")) {
        values.push(`${prefix(cell)}unknown — the auth setup failed`);
      }
      continue;
    }
    values.push(
      ...facts.sites.map((site) => `${prefix(cell)}${describeSite(site)}`),
    );
  }
  return labelled(style, "Site", values);
}

/**
 * The summary's lines.
 *
 * @param input - what the run came to.
 * @param style - colours; identity for none.
 */
export function renderSummary(
  input: SummaryInput,
  style: Styler = (_format, text) => text,
): string[] {
  const { run } = input;
  const verdict = VERDICTS[verdictOf(input)];
  const subject =
    run.cell === undefined
      ? `${run.product} · every cell`
      : `${run.product} · ${run.cell}${run.edition === undefined ? "" : ` (${run.edition})`}`;
  const head = `━━ ${subject} ━━ ${verdict.text} `;
  const rule = "━".repeat(Math.max(2, WIDTH - head.length));
  // A run of every cell says whose facts each line gives.
  const prefix = (cell: string): string =>
    input.cells.size > 1 || run.cell === undefined ? `${cell}: ` : "";

  return [
    style(["bold", verdict.color], `${head}${rule}`),
    ...labelled(style, "Result", [
      `${describeCounts(input.scenarios)}, in ${formatDuration(input.durationMs)}`,
    ]),
    ...labelled(style, "Error", errorLines(style, input.runErrors ?? [])),
    ...labelled(
      style,
      "Setup",
      input.setupFailures.map((failure) =>
        style(
          "red",
          `${failure.project} failed — ${cut(displayText(failure.message), SETUP_MESSAGE_LIMIT)}`,
        ),
      ),
    ),
    ...pluginLines(style, input.cells, prefix),
    ...siteLines(style, input.cells, prefix),
    ...labelled(style, "Playwright", [
      `npx playwright show-report ${shellWord(`${input.reportDir}/playwright`)}`,
    ]),
    ...labelled(style, "Cucumber", [
      shellWord(`${input.reportDir}/cucumber/index.html`),
    ]),
    ...labelled(style, "Allure", [
      `npm run report:allure -- ${run.product} ${run.reportCell} --open`,
    ]),
    ...labelled(
      style,
      "Pruned",
      (input.pruned ?? []).map((line) =>
        line.warn
          ? style("yellow", displayText(line.text))
          : displayText(line.text),
      ),
    ),
  ];
}

/** How many errors outside any test the summary lists; the rest are counted. */
const RUN_ERRORS_SHOWN = 3;

/** The errors raised outside any test, as red lines: the first few, then how many more. */
function errorLines(style: Styler, errors: readonly string[]): string[] {
  const shown = errors
    .slice(0, RUN_ERRORS_SHOWN)
    .map((error) => style("red", cut(displayText(error), SETUP_MESSAGE_LIMIT)));
  const more = errors.length - shown.length;
  return more > 0 ? [...shown, `and ${String(more)} more`] : shown;
}

/** Colours for the terminal: Node's `styleText` drops them for a pipe, `NO_COLOR` and the like. */
const terminalStyle: Styler = (format, text) =>
  styleText(format, text, { stream: process.stdout });

/** No colour at all: `E2E_OUTPUT=plain`, whatever `FORCE_COLOR` says. */
const plainStyle: Styler = (_format, text) => text;

/** Prints {@link renderSummary} as the run's last word; see the module's description. */
export default class RunSummaryReporter implements Reporter {
  /** What the config factory said about the run, or the field it forgot. */
  private readonly run: RunDescription | { readonly missing: string };
  /** The reporters' mode: nothing is printed for `--list`. */
  private readonly mode: "test" | "list";
  /** The run's counts. */
  private readonly tally = new RunTally();
  /** The setups that failed. */
  private readonly setupFailures: SetupFailure[] = [];
  /** Each cell's facts. */
  private readonly cells = new Map<string, CellFacts>();
  /** How the run ended; set by `onEnd`. */
  private ended: Pick<FullResult, "status" | "duration"> | undefined;
  /** How the summary is coloured: never under `E2E_OUTPUT=plain`, else as the stream allows. */
  private readonly style: Styler;

  /**
   * @param options - a {@link RunDescription} and `output` (`E2E_OUTPUT`: `plain` drops colour),
   *   plus what Playwright adds.
   */
  constructor(options: unknown) {
    this.run = readRunDescription(options);
    this.mode = reporterMode(options);
    this.style =
      outputModeOption(options) === "plain" ? plainStyle : terminalStyle;
  }

  /**
   * Starts the tally.
   *
   * @param _config - unused.
   * @param suite - every test the run plans.
   */
  onBegin(_config: FullConfig, suite: Suite): void {
    this.guard(() => {
      this.tally.begin(suite.allTests());
    });
  }

  /**
   * Counts a test's last attempt and, for a setup, keeps what it found out.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard(() => {
      const verdict = this.tally.attemptEnded(test, result);
      if (verdict.final) this.recordSetup(test, result, verdict.status);
    });
  }

  /**
   * Keeps an error raised outside any test for the verdict and the `Error` lines.
   *
   * @param error - the error.
   */
  onError(error: TestError): void {
    this.guard(() => {
      this.tally.runError(error);
    });
  }

  /**
   * Ends the tests whose retry never ran, and keeps how the run ended, for `onExit`.
   *
   * @param result - the run's status and duration.
   */
  onEnd(result: FullResult): void {
    this.ended = { status: result.status, duration: result.duration };
    this.guard(() => {
      for (const { test, result: last, status } of this.tally.settle()) {
        this.recordSetup(test, last, status);
      }
    });
  }

  /**
   * Prunes the run's report group, then prints the summary below everything else the run printed.
   * Nothing to await.
   */
  onExit(): Promise<void> {
    this.guard(() => {
      if (
        this.mode === "list" ||
        this.ended === undefined ||
        "missing" in this.run
      ) {
        return;
      }
      const lines = renderSummary(
        {
          run: this.run,
          reportDir: displayPath(this.run.reportPath, process.cwd()),
          status: this.ended.status,
          durationMs: this.ended.duration,
          scenarios: this.tally.scenarios,
          setupFailures: this.setupFailures,
          runErrors: this.tally.runErrors,
          cells: this.cells,
          pruned: prune(this.run),
        },
        this.style,
      );
      process.stdout.write(`\n${lines.join("\n")}\n`);
    });
    return Promise.resolve();
  }

  /** A summary is no progress report: Playwright keeps its own terminal reporter. */
  printsToStdio(): boolean {
    return false;
  }

  /**
   * For a finished setup, keeps what it found out — from its attachments, whether it passed or not —
   * and, when it failed, its error's first line. Nothing for a scenario.
   *
   * @param test - the finished test.
   * @param result - its last attempt.
   * @param status - its final status. An interrupted setup did not fail: the run was stopped.
   */
  private recordSetup(
    test: TestCase,
    result: TestResult,
    status: TestStatus,
  ): void {
    const setup = setupOf(test);
    if (setup === undefined) return;
    const project = test.parent.project()?.name ?? "";
    const cell = cellOfProject(project);
    const before = this.cells.get(cell) ?? { failed: [] };
    const facts: CellFacts =
      setup === "artifacts"
        ? withPlugins(before, readJsonAttachment(result, ARTIFACTS_ATTACHMENT))
        : withSites(before, readJsonAttachment(result, SITE_INFO_ATTACHMENT));
    if (status !== "failed") {
      this.cells.set(cell, facts);
      return;
    }
    this.cells.set(cell, { ...facts, failed: [...facts.failed, setup] });
    const message = firstError(result)?.message ?? "no error recorded";
    this.setupFailures.push({
      project,
      setup,
      message: message.split("\n")[0] ?? "",
    });
  }

  /**
   * Runs a reporter step; a summary that cannot be made is warned about, never thrown — a throwing
   * reporter turns a green run red.
   *
   * @param step - the work.
   */
  private guard(step: () => void): void {
    try {
      step();
    } catch (error) {
      process.stderr.write(
        `[summary] could not summarise the run: ${errorMessage(error)}\n`,
      );
    }
  }
}

/**
 * Prunes the run's report group (`run-pruning.ts`) and says what went. A run whose description
 * carries no `reportsKeep` prunes nothing.
 *
 * @param run - the run.
 */
function prune(run: RunDescription): PruneLine[] {
  if (run.reportsKeep === undefined) return [];
  const outcome = pruneRunGroup(run.reportPath, run.reportsKeep, Date.now());
  return describePruning(outcome, (path) =>
    shellWord(displayPath(path, process.cwd())),
  );
}

/** A cell's facts with the plugin zips its artifacts setup recorded, when it recorded any. */
function withPlugins(facts: CellFacts, attachment: unknown): CellFacts {
  const plugins = parsePluginFacts(attachment);
  return plugins.length === 0 ? facts : { ...facts, plugins };
}

/** A cell's facts with the sites its auth setup recorded, when it recorded any. */
function withSites(facts: CellFacts, attachment: unknown): CellFacts {
  const sites = parseSiteFacts(attachment);
  return sites.length === 0 ? facts : { ...facts, sites };
}
