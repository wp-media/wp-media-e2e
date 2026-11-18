import type { FullResult } from "@playwright/test/reporter";

import {
  cellOfProject,
  setupKindOf,
  type SetupKind,
} from "../config/project-names";
import { suiteVersionText } from "../config/suite-version";
import { escapeHtml, maskSiteUrl } from "../text";
import type { Counts, TestStatus } from "./results";
import type { RunDescription } from "./run-description";
import {
  cut,
  describePlugin,
  describeSite,
  displayText,
  plain,
  verdictOf,
  type SetupFailure,
  type Verdict,
} from "./run-summary";
import {
  parsePluginFacts,
  parseSiteFacts,
  type PluginFact,
  type SiteFact,
} from "./setup-facts";

/**
 * What a run tested, said up front in every report: the product and cell, the plugin zip (its ref,
 * commit and SHA-256), the site's versions, the run's name and how it ended. Pure — the facts, how
 * they change as the run goes, and how each report shows them: the Playwright HTML report's title,
 * Allure's `environment.properties`, a banner on the Cucumber report, and `run-facts.json`, which
 * the orchestrator reads. `run-facts.reporter.ts` is the thin reporter that writes them.
 *
 * A fact not known is said, with why — "unknown: artifacts setup failed" — never left blank. Only
 * whitelisted values are kept: of the sites file, a site's `baseURL`; of the setups' attachments,
 * what `setup-facts.ts` parses. Every value is one line of plain text, and is escaped for the format
 * it lands in.
 */

/** The facts' file, in the run's report folder. */
export const RUN_FACTS_FILE = "run-facts.json";

/** The version of `run-facts.json`'s shape; bumped for a change a reader must know about. */
export const RUN_FACTS_SCHEMA_VERSION = 1;

/** Allure's raw results, in the run's report folder (`reporters()` points allure-playwright there). */
export const ALLURE_RESULTS_DIR = "allure-results";

/** The file Allure shows as the front page's Metadata, in file order. */
export const ALLURE_ENVIRONMENT_FILE = "environment.properties";

/** The Cucumber report, in the run's report folder (`reporters()` writes it there). */
export const CUCUMBER_REPORT_FILE = "cucumber/index.html";

/** The longest setup error, or display-only value, a fact keeps. */
const MESSAGE_LIMIT = 300;

/** Where one setup of a cell stands. */
export type SetupState =
  /** Planned, and not finished yet. */
  | "pending"
  | "passed"
  | "failed"
  | "skipped"
  | "interrupted"
  /** Planned, but the run ended before it finished. */
  | "did-not-run"
  /** Not part of this run: `--no-deps`, or a `--project` that left it out. */
  | "not-in-run";

/** What one cell's setups found out, and where they stand. */
export interface CellRecord {
  readonly cell: string;
  readonly setups: Readonly<Record<SetupKind, SetupState>>;
  /** The plugin zips the artifacts setup recorded, in its order; empty until it records any. */
  readonly plugins: readonly PluginFact[];
  /** Each site's versions, as the auth setup recorded them; empty until it records any. */
  readonly sites: readonly SiteFact[];
}

/** How the run stands: `running` until it ends, then its verdict (`run-summary.ts`'s words). */
export type RunState = "running" | Verdict;

/** Everything the reports say about the run; what `run-facts.json` holds, but its `title`. */
export interface RunFacts {
  readonly product: string;
  /** The one cell the run targets; absent for a run of every cell. */
  readonly cell?: string;
  readonly edition?: string;
  readonly runId: string;
  /** Display only (`E2E_RUN_NAME`). */
  readonly runName?: string;
  /** Display only (`E2E_REQUESTED_REF`): the ref asked for, where the run may be pinned to a commit. */
  readonly requestedRef?: string;
  /** Display only: the suite's own version (`package.json`); absent when it could not be read. */
  readonly suiteVersion?: string;
  readonly status: RunState;
  /** When the run began, ISO-8601. */
  readonly startedAt: string;
  /** When it ended, ISO-8601; absent while it runs — and forever, for a run that was killed. */
  readonly endedAt?: string;
  readonly durationMs?: number;
  /** Each setup that failed, with its first error's first line. */
  readonly setupFailures: readonly SetupFailure[];
  /** Each cell the run touches, in the order its tests are planned. */
  readonly cells: readonly CellRecord[];
}

/** How a run ended, as `onEnd` and the tally know it. */
export interface RunEnd {
  /** Playwright's status for the run. */
  readonly status: FullResult["status"];
  readonly durationMs: number;
  /** The scenarios' counts, setups apart. */
  readonly scenarios: Counts;
  /** The errors raised outside any test, "No tests found" aside (`RunTally.runErrors`); absent: none. */
  readonly runErrors?: readonly string[];
}

/** Each setup kind's name in a phrase. */
const SETUP_NAMES: Readonly<Record<SetupKind, string>> = {
  artifacts: "artifacts setup",
  auth: "auth setup",
};

/** What a setup's state leaves its facts as, when it recorded none. */
const MISSING: Readonly<Record<SetupState, string>> = {
  pending: "pending: {setup} not finished",
  passed: "unknown: {setup} left no record",
  failed: "unknown: {setup} failed",
  skipped: "unknown: {setup} skipped",
  interrupted: "unknown: {setup} interrupted",
  "did-not-run": "unknown: {setup} did not run",
  "not-in-run": "unknown: {setup} not in this run",
};

/**
 * A value as a fact holds it: one plain line, every credential masked ({@link displayText} — a
 * navigation error quotes a basic-auth URL whole), then at most {@link MESSAGE_LIMIT} characters.
 *
 * @param text - what a setup, a site or the environment said.
 */
export function factText(text: string): string {
  return cut(displayText(text), MESSAGE_LIMIT);
}

/**
 * Why a cell's plugin or site is not known, from where its setup stands.
 *
 * @param kind - the setup that would have recorded it.
 * @param state - where that setup stands.
 * @example
 * ```ts
 * missingFact("auth", "failed"); // "unknown: auth setup failed"
 * ```
 */
export function missingFact(kind: SetupKind, state: SetupState): string {
  return MISSING[state].replace("{setup}", SETUP_NAMES[kind]);
}

/** A cell's record before any of its setups ends: those planned pending, the rest not in the run. */
function emptyRecord(cell: string): CellRecord {
  return {
    cell,
    setups: { artifacts: "not-in-run", auth: "not-in-run" },
    plugins: [],
    sites: [],
  };
}

/**
 * The facts as a run begins: what the config factory said, and each cell its tests touch, with the
 * setups it plans pending.
 *
 * @param run - what the config factory knows about the run.
 * @param projects - the project of every planned test, in plan order.
 * @param startedAt - when the run began.
 */
export function beginFacts(
  run: RunDescription,
  projects: readonly string[],
  startedAt: Date,
): RunFacts {
  const cells = new Map<string, CellRecord>();
  if (run.cell !== undefined) cells.set(run.cell, emptyRecord(run.cell));
  for (const project of projects) {
    const cell = cellOfProject(project);
    const record = cells.get(cell) ?? emptyRecord(cell);
    const kind = setupKindOf(project);
    cells.set(
      cell,
      kind === undefined
        ? record
        : { ...record, setups: { ...record.setups, [kind]: "pending" } },
    );
  }
  const runName = displayOnly(run.runName);
  const requestedRef = displayOnly(run.requestedRef);
  const suiteVersion = displayOnly(run.suiteVersion);
  return {
    product: run.product,
    ...(run.cell !== undefined ? { cell: run.cell } : {}),
    ...(run.edition !== undefined ? { edition: run.edition } : {}),
    runId: run.runId,
    ...(runName !== undefined ? { runName } : {}),
    ...(requestedRef !== undefined ? { requestedRef } : {}),
    ...(suiteVersion !== undefined ? { suiteVersion } : {}),
    status: "running",
    startedAt: startedAt.toISOString(),
    setupFailures: [],
    cells: [...cells.values()],
  };
}

/** A display-only value as a fact, or `undefined` when it says nothing. */
function displayOnly(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const text = factText(value);
  return text === "" ? undefined : text;
}

/** The facts with one cell's record changed — added, when the run did not plan it. */
function withCell(
  facts: RunFacts,
  cell: string,
  change: (record: CellRecord) => CellRecord,
): RunFacts {
  const known = facts.cells.some((record) => record.cell === cell);
  const cells = known
    ? facts.cells.map((record) =>
        record.cell === cell ? change(record) : record,
      )
    : [...facts.cells, change(emptyRecord(cell))];
  return { ...facts, cells };
}

/** An object with every string value made a fact's text ({@link factText}); others kept. */
function cleanStrings<T extends object>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).map(([key, field]) => [
      key,
      typeof field === "string" ? factText(field) : field,
    ]),
  ) as T;
}

/**
 * A site fact as the facts keep it: its URL, versions and error made a fact's text — Site Health's
 * text is what the site says, and may hold anything.
 */
function cleanSite(fact: SiteFact): SiteFact {
  return "error" in fact
    ? cleanStrings({ ...fact, baseURL: maskSiteUrl(fact.baseURL) })
    : {
        baseURL: factText(maskSiteUrl(fact.baseURL)),
        versions: cleanStrings(fact.versions),
      };
}

/**
 * Folds in what a setup's attempt attached: the plugin zips (artifacts) or the sites' versions
 * (auth). An attachment that holds no fact changes nothing, so a later attempt without one never
 * erases an earlier record.
 *
 * @param facts - the facts so far.
 * @param project - the setup's project (`artifacts:<cell>`, `setup:<cell>`).
 * @param attachment - the attachment's parsed JSON (`readJsonAttachment`); `undefined` if none.
 * @returns the facts, unchanged for a project that is not a setup's.
 */
export function withSetupAttachment(
  facts: RunFacts,
  project: string,
  attachment: unknown,
): RunFacts {
  const kind = setupKindOf(project);
  if (kind === undefined) return facts;
  if (kind === "artifacts") {
    const plugins = parsePluginFacts(attachment).map(cleanStrings);
    if (plugins.length === 0) return facts;
    return withCell(facts, cellOfProject(project), (r) => ({ ...r, plugins }));
  }
  const sites = parseSiteFacts(attachment).map(cleanSite);
  if (sites.length === 0) return facts;
  return withCell(facts, cellOfProject(project), (r) => ({ ...r, sites }));
}

/** A setup's final status as its state: a flaky setup passed in the end. */
function stateOf(status: TestStatus): SetupState {
  return status === "flaky" ? "passed" : status;
}

/**
 * Records a setup's end: its state and, when it failed, its first error's first line.
 *
 * @param facts - the facts so far.
 * @param project - the setup's project.
 * @param status - its final status.
 * @param error - its first error's message, for a failed setup.
 * @returns the facts, unchanged for a project that is not a setup's.
 */
export function withSetupEnded(
  facts: RunFacts,
  project: string,
  status: TestStatus,
  error?: string,
): RunFacts {
  const kind = setupKindOf(project);
  if (kind === undefined) return facts;
  const ended = withCell(facts, cellOfProject(project), (record) => ({
    ...record,
    setups: { ...record.setups, [kind]: stateOf(status) },
  }));
  if (status !== "failed") return ended;
  const message = factText((error ?? "no error recorded").split("\n")[0] ?? "");
  return {
    ...ended,
    setupFailures: [
      ...ended.setupFailures.filter((failure) => failure.project !== project),
      { project, setup: kind, message },
    ],
  };
}

/**
 * The facts once the run has ended: its verdict, when, and every setup still pending marked as one
 * that never ran.
 *
 * @param facts - the facts so far.
 * @param end - how the run ended.
 * @param endedAt - when.
 */
export function endFacts(
  facts: RunFacts,
  end: RunEnd,
  endedAt: Date,
): RunFacts {
  const cells = facts.cells.map((record) => ({
    ...record,
    setups: {
      artifacts: settled(record.setups.artifacts),
      auth: settled(record.setups.auth),
    },
  }));
  return {
    ...facts,
    cells,
    status: verdictOf({
      status: end.status,
      scenarios: end.scenarios,
      setupFailures: facts.setupFailures,
      runErrors: end.runErrors,
    }),
    endedAt: endedAt.toISOString(),
    durationMs: Math.round(end.durationMs),
  };
}

/** A setup still pending when the run ends never ran. */
function settled(state: SetupState): SetupState {
  return state === "pending" ? "did-not-run" : state;
}

/** Each run state's word in the title, when the reports cannot say it themselves. */
const TITLE_STATES: Readonly<Partial<Record<RunState, string>>> = {
  running: "RUNNING",
  interrupted: "INTERRUPTED",
  stopped: "STOPPED",
  "could-not-test": "COULD NOT TEST",
  "no-tests": "NO TESTS",
};

/** The run's subject: its product and cell (and edition), or every cell. */
function subjectOf(facts: RunFacts): string {
  if (facts.cell === undefined) return `${facts.product} · every cell`;
  const edition = facts.edition === undefined ? "" : ` (${facts.edition})`;
  return `${facts.product} · ${facts.cell}${edition}`;
}

/**
 * The plugin under test as the title says it: the requested ref, when one was given, in place of
 * the ref the run was pinned to — `develop @ af1ab5c4d2`, not `commit:<40 hex> @ af1ab5c4d2`.
 */
function titlePlugin(facts: RunFacts, record: CellRecord): string {
  const fact =
    record.plugins.find((plugin) => plugin.role === "plugin") ??
    record.plugins[0];
  if (fact === undefined) {
    return `plugin ${missingFact("artifacts", record.setups.artifacts)}`;
  }
  if (!fact.ok || facts.requestedRef === undefined || fact.role !== "plugin") {
    return describePlugin(fact);
  }
  return describePlugin({ ...fact, ref: facts.requestedRef });
}

/** The sites' versions as the title says them: each distinct set once. */
function titleSites(record: CellRecord): string {
  if (record.sites.length === 0) {
    return `site ${missingFact("auth", record.setups.auth)}`;
  }
  const phrases = record.sites.map((site) =>
    "error" in site
      ? `site versions unknown: ${site.error}`
      : `WordPress ${site.versions.wordpress ?? "unknown"} · PHP ${site.versions.php ?? "unknown"}`,
  );
  return [...new Set(phrases)].join(" / ");
}

/**
 * The run in one line: what the HTML report's title, the Cucumber banner and Allure's name say.
 *
 * @param facts - the facts.
 * @example
 * ```ts
 * titleLine(facts);
 * // "backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ af1ab5c4d2 · WordPress 7.1.3 ·
 * //  PHP 8.5.11 64bit · nightly"
 * ```
 */
export function titleLine(facts: RunFacts): string {
  const many = facts.cells.length > 1;
  const cells = facts.cells.map((record) => {
    const prefix = many ? `${record.cell}: ` : "";
    return `${prefix}${titlePlugin(facts, record)} · ${titleSites(record)}`;
  });
  const state = TITLE_STATES[facts.status];
  return [
    subjectOf(facts),
    ...cells,
    facts.runName ?? facts.runId,
    ...(state === undefined ? [] : [state]),
  ].join(" · ");
}

/**
 * The run's status as a fact.
 *
 * @param facts - the facts.
 */
export function statusFact(facts: RunFacts): string {
  switch (facts.status) {
    case "running":
      return "running — no end recorded yet; a run that is over and still says so was killed";
    case "could-not-test":
      return `could not test — ${facts.setupFailures
        .map((failure) => `${failure.project} failed: ${failure.message}`)
        .join("; ")}`;
    case "interrupted":
      return "interrupted — stopped before it finished";
    case "stopped":
      return "stopped — the scenarios not begun before the stop were skipped";
    case "no-tests":
      return "no tests ran";
    default:
      return facts.status;
  }
}

/** A role's label: `Plugin` for the zip under test, its role's name capitalised for another. */
function roleLabel(role: string): string {
  return role === "plugin"
    ? "Plugin"
    : `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
}

/** The server a site runs, in one phrase: SAPI, web server, database. */
function serverFact(site: SiteFact): string | undefined {
  if ("error" in site) return undefined;
  const { phpSapi, webServer, database, databaseExtension } = site.versions;
  const db = `database ${database ?? "unknown"}${
    databaseExtension === undefined ? "" : ` (${databaseExtension})`
  }`;
  return plain(
    [
      `PHP SAPI ${phpSapi ?? "unknown"}`,
      webServer ?? "web server unknown",
      db,
    ].join(" · "),
  );
}

/** Label/value pairs, as {@link factEntries} builds them. */
type Entries = [string, string][];

/** One cell's plugin entries: each role, its SHA-256 among the first. */
function pluginEntries(record: CellRecord, suffix: string): Entries {
  if (record.plugins.length === 0) {
    return [
      [`Plugin${suffix}`, missingFact("artifacts", record.setups.artifacts)],
    ];
  }
  return record.plugins.flatMap((fact): Entries => {
    const label = `${roleLabel(fact.role)}${suffix}`;
    const head: Entries = [[label, describePlugin(fact)]];
    if (!fact.ok) return head;
    return [...head, [`${label} SHA-256`, fact.sha256 ?? "unknown"]];
  });
}

/** One cell's plugin details, below the headline facts: commit, refs, zip, source. */
function pluginDetailEntries(record: CellRecord, suffix: string): Entries {
  return record.plugins.flatMap((fact): Entries => {
    if (!fact.ok) return [];
    const label = `${roleLabel(fact.role)}${suffix}`;
    const details: [string, string | undefined][] = [
      ["commit", fact.commit],
      ["ref", fact.ref],
      ["pin", fact.pin],
      ["zip", fact.zip],
      ["source", fact.source],
    ];
    return details
      .filter((detail): detail is [string, string] => detail[1] !== undefined)
      .map(([name, value]) => [`${label} ${name}`, plain(value)]);
  });
}

/** One cell's site entries: each site's URL and versions, then its server. */
function siteEntries(record: CellRecord, suffix: string): Entries {
  if (record.sites.length === 0) {
    return [[`Site${suffix}`, missingFact("auth", record.setups.auth)]];
  }
  return record.sites.flatMap((site, index): Entries => {
    const number = index === 0 ? "" : ` ${String(index + 1)}`;
    const server = serverFact(site);
    return [
      [`Site${number}${suffix}`, describeSite(site)],
      ...(server === undefined
        ? []
        : ([[`Server${number}${suffix}`, server]] as Entries)),
    ];
  });
}

/**
 * Every fact as a label and a value, the most important first — Allure shows its first eight on the
 * front page: the status, the plugin and its SHA-256, the site and its server, the cell, the run and
 * the requested ref; then the plugin's details, the run's id and times. The suite's version (`unknown`
 * when not read) comes last, so it never pushes a fact off that front page, however few precede it.
 * Labels are unique: a run of every cell suffixes each cell's with its name, and a pool's later sites
 * are numbered.
 *
 * @param facts - the facts.
 */
export function factEntries(facts: RunFacts): Entries {
  const many = facts.cells.length > 1;
  const suffixOf = (record: CellRecord): string =>
    many ? ` (${record.cell})` : "";
  const runLabel = facts.runName ?? facts.runId;
  return [
    ["Status", statusFact(facts)],
    ...facts.cells.flatMap((record) => [
      ...pluginEntries(record, suffixOf(record)),
      ...siteEntries(record, suffixOf(record)),
    ]),
    ["Cell", subjectOf(facts)],
    ["Run", runLabel],
    ...(facts.requestedRef === undefined
      ? []
      : ([["Requested ref", facts.requestedRef]] as Entries)),
    ...facts.cells.flatMap((record) =>
      pluginDetailEntries(record, suffixOf(record)),
    ),
    ["Run ID", facts.runId],
    ["Started", facts.startedAt],
    ...(facts.endedAt === undefined
      ? []
      : ([["Ended", facts.endedAt]] as Entries)),
    ["Suite", suiteVersionText(facts.suiteVersion)],
  ];
}

/**
 * `run-facts.json`'s text: the facts, their {@link titleLine} and the schema's version.
 *
 * @param facts - the facts.
 */
export function runFactsJson(facts: RunFacts): string {
  return `${JSON.stringify(
    { v: RUN_FACTS_SCHEMA_VERSION, title: titleLine(facts), ...facts },
    null,
    2,
  )}\n`;
}

/**
 * One character as a `.properties` file must write it, so that Allure's reader — and Java's —
 * read it back unchanged: `\` doubled, a separator or comment character escaped, a control character
 * by its escape, and anything outside printable ASCII as `\uXXXX` (per UTF-16 unit, so an emoji is
 * its surrogate pair).
 *
 * @param char - one UTF-16 unit of the text.
 * @param inKey - whether it is in a key, where a space and a comment mark are escaped too.
 */
function escapePropertyChar(char: string, inKey: boolean): string {
  switch (char) {
    case "\\":
      return "\\\\";
    case "\t":
      return "\\t";
    case "\n":
      return "\\n";
    case "\r":
      return "\\r";
    case "\f":
      return "\\f";
    case "=":
    case ":":
      return `\\${char}`;
    case "#":
    case "!":
    case " ":
      // A key's space would end it, and a comment mark matters only where a key starts.
      return inKey ? `\\${char}` : char;
  }
  const code = char.charCodeAt(0);
  if (code < 0x20 || code > 0x7e) {
    return `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return char;
}

/**
 * A key for a `.properties` file: every space, separator and comment mark escaped.
 *
 * @param key - the key.
 */
export function escapePropertyKey(key: string): string {
  let escaped = "";
  for (let i = 0; i < key.length; i += 1) {
    escaped += escapePropertyChar(key.charAt(i), true);
  }
  return escaped;
}

/**
 * A value for a `.properties` file: as {@link escapePropertyKey}, but a space is escaped only at the
 * start, where a reader would skip it.
 *
 * @param value - the value.
 */
export function escapePropertyValue(value: string): string {
  let escaped = "";
  for (let i = 0; i < value.length; i += 1) {
    const char = value.charAt(i);
    escaped +=
      char === " " && i === 0 ? "\\ " : escapePropertyChar(char, false);
  }
  return escaped;
}

/**
 * The facts as Allure's `environment.properties`: one `key=value` line per entry, in order — Allure
 * shows them in file order.
 *
 * @param entries - the facts' entries ({@link factEntries}).
 */
export function toProperties(
  entries: readonly (readonly [string, string])[],
): string {
  return entries
    .map(
      ([key, value]) =>
        `${escapePropertyKey(key)}=${escapePropertyValue(value)}\n`,
    )
    .join("");
}

/** The banner's element id: what marks a Cucumber report as already bannered. */
export const BANNER_ID = "e2e-run-facts";

/** Each run state's accent colour on the banner. */
const BANNER_ACCENTS: Readonly<Record<RunState, string>> = {
  running: "#6e7781",
  passed: "#1a7f37",
  failed: "#cf222e",
  "could-not-test": "#cf222e",
  interrupted: "#9a6700",
  stopped: "#9a6700",
  "no-tests": "#9a6700",
};

/**
 * The Cucumber report's banner: the {@link titleLine} up front, every entry under a disclosure. All
 * text is HTML-escaped; the inline script only moves the banner above the report's own header (it is
 * inserted before `</body>`, below the report's app) and carries no value.
 *
 * @param facts - the facts, as the run ended.
 */
export function bannerHtml(facts: RunFacts): string {
  const rows = factEntries(facts)
    .map(
      ([label, value]) =>
        `<tr><th scope="row">${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`,
    )
    .join("");
  const accent = BANNER_ACCENTS[facts.status];
  return [
    `<style>#${BANNER_ID}{font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;` +
      `background:#f6f8fa;color:#1f2328;border-left:6px solid ${accent};padding:10px 16px;` +
      `overflow-wrap:anywhere}#${BANNER_ID} strong{font-size:15px}` +
      `#${BANNER_ID} summary{cursor:pointer;margin-top:4px}` +
      `#${BANNER_ID} table{border-collapse:collapse;margin-top:6px}` +
      `#${BANNER_ID} th,#${BANNER_ID} td{text-align:left;vertical-align:top;padding:2px 12px 2px 0}` +
      // The report's own dark theme uses these panel colours.
      `@media (prefers-color-scheme:dark){#${BANNER_ID}{background:#282a36;color:#f8f8f2}}</style>`,
    `<div id="${BANNER_ID}" role="region" aria-label="Run facts">` +
      `<strong>${escapeHtml(titleLine(facts))}</strong>` +
      `<details><summary>Run facts</summary><table>${rows}</table></details></div>`,
    `<script>(function(){var b=document.getElementById("${BANNER_ID}");` +
      `if(b&&document.body)document.body.insertBefore(b,document.body.firstChild);})();</script>`,
  ].join("\n");
}

/** The tag a banner is inserted before. */
const BODY_CLOSE = Buffer.from("</body>", "latin1");

/**
 * Where a banner goes in the end of an HTML file: before its **last** `</body>` — the report's own
 * scripts come before it, so an earlier one could only sit inside a script.
 *
 * @param tail - the file's last bytes.
 * @param banner - the banner's HTML ({@link bannerHtml}).
 * @returns the tail with the banner inserted, from the byte where it starts; or `undefined` when the
 *   tail holds no `</body>` (a report cut short) or a banner already (`BANNER_ID`).
 */
export function bannerSplice(
  tail: Buffer,
  banner: string,
): { readonly offset: number; readonly bytes: Buffer } | undefined {
  const offset = tail.lastIndexOf(BODY_CLOSE);
  if (offset < 0) return undefined;
  if (tail.includes(`id="${BANNER_ID}"`)) return undefined;
  return {
    offset,
    bytes: Buffer.concat([
      Buffer.from(`${banner}\n`, "utf8"),
      tail.subarray(offset),
    ]),
  };
}

/**
 * The facts as flat `config.metadata` keys — what the Playwright HTML report's metadata panel lists.
 *
 * @param entries - the facts' entries ({@link factEntries}).
 */
export function metadataOf(
  entries: readonly (readonly [string, string])[],
): Record<string, string> {
  return Object.fromEntries(entries);
}
