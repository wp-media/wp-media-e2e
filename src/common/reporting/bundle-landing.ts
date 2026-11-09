import { isObject } from "../guards";
import { escapeHtml, printableLine } from "../text";
import type { BundledReport, ReportKind } from "./bundle-manifest";

/**
 * The report bundle's landing page, `index.html`: what the run tested, a link to every report the
 * bundle holds — with the one command that serves a report that needs HTTP — and, plainly, each one
 * it does not hold and why. Pure: facts in, HTML out. Static by design: no script, no external asset
 * (a Content-Security-Policy forbids both), every value escaped, light or dark as the system is.
 */

/** The most bytes of `run-facts.json` read: the suite writes about 1.5 kB. */
export const FACTS_LIMIT = 256 * 1024;

/** The longest fact the page shows, in characters. */
const FACT_LIMIT = 300;

/** The facts the landing page shows, each one plain line; any may be unknown. */
export interface LandingFacts {
  /** The facts line every report shows (product, cell, plugin, versions, run). */
  readonly title?: string;
  readonly product?: string;
  readonly cell?: string;
  readonly edition?: string;
  readonly runId?: string;
  readonly runName?: string;
  readonly status?: string;
  readonly startedAt?: string;
  readonly endedAt?: string;
  readonly durationMs?: number;
}

/** The string facts read from `run-facts.json`. */
const STRING_FACTS = [
  "title",
  "product",
  "cell",
  "edition",
  "runId",
  "runName",
  "status",
  "startedAt",
  "endedAt",
] as const;

/**
 * The landing page's facts from `run-facts.json`'s text: only the whitelisted fields, each made one
 * plain line with any credential masked ({@link printableLine}) and cut to {@link FACT_LIMIT}.
 *
 * @param text - the file's text; `undefined` when there is none.
 * @returns the facts; `undefined` when the text is absent or not a JSON object.
 */
export function parseLandingFacts(
  text: string | undefined,
): LandingFacts | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!isObject(parsed)) return undefined;
  const facts: { -readonly [K in keyof LandingFacts]: LandingFacts[K] } = {};
  for (const key of STRING_FACTS) {
    const value = parsed[key];
    if (typeof value !== "string") continue;
    const line = printableLine(value).trim().slice(0, FACT_LIMIT);
    if (line !== "") facts[key] = line;
  }
  const duration = parsed.durationMs;
  if (
    typeof duration === "number" &&
    Number.isFinite(duration) &&
    duration >= 0
  ) {
    facts.durationMs = duration;
  }
  return facts;
}

/** Each run state's words (`run-facts.ts`'s states). */
const STATUS_WORDS: Readonly<Record<string, string>> = {
  passed: "Passed",
  failed: "Failed",
  "could-not-test": "Could not test",
  interrupted: "Interrupted",
  stopped: "Stopped",
  "no-tests": "No tests",
  running: "No end recorded: the run was killed",
};

/** The states the page marks as good or bad; the rest are neutral. */
const STATUS_TONES: Readonly<Record<string, "good" | "bad">> = {
  passed: "good",
  failed: "bad",
  "could-not-test": "bad",
};

/** Each report's name and what it is for. */
const REPORTS: Readonly<
  Record<ReportKind, { readonly name: string; readonly about: string }>
> = {
  playwright: {
    name: "Playwright",
    about:
      "the runner's report: every test, its steps, errors, screenshots, video and trace",
  },
  cucumber: {
    name: "Cucumber",
    about: "the Gherkin report: features and scenarios as written",
  },
  allure: {
    name: "Allure",
    about: "the analytics report: trends across runs, flaky tests, categories",
  },
};

/** What the landing page is made of. */
export interface LandingInput {
  /** The bundle's name: its folder's name once unpacked. */
  readonly name: string;
  /** The run's facts; `undefined` when `run-facts.json` is missing or unreadable. */
  readonly facts: LandingFacts | undefined;
  /** Every report, present or not, in the order shown. */
  readonly reports: readonly BundledReport[];
}

/**
 * A duration as a person reads it: `25 min 22 s`, `1 h 3 min`, `840 ms`.
 *
 * @param ms - milliseconds, not negative.
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${String(Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${String(h)} h ${String(min)} min`;
  return min > 0 ? `${String(min)} min ${String(s)} s` : `${String(s)} s`;
}

/** The page's style: system colours with AA contrast in both schemes, no external asset. */
const STYLE = `
:root{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;
--panel:#f6f8fa;--link:#0550ae;--good:#1a7f37;--bad:#cf222e;--neutral:#9a6700;--code:#eff2f5}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;
--line:#3d444d;--panel:#151b23;--link:#79c0ff;--good:#3fb950;--bad:#ff7b72;--neutral:#d29922;
--code:#262c36}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);
font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:56rem;margin:0 auto;padding:2rem 1rem 3rem}
h1{font-size:1.6rem;line-height:1.25;margin:0 0 .5rem;overflow-wrap:anywhere}
h2{font-size:1.15rem;margin:2rem 0 .75rem}
p{margin:.25rem 0}
.title{color:var(--muted);overflow-wrap:anywhere}
.status{display:inline-block;margin-top:.75rem;padding:.15rem .6rem;border:2px solid currentColor;
border-radius:999px;font-weight:600}
.good{color:var(--good)}.bad{color:var(--bad)}.neutral{color:var(--neutral)}
ul.reports{list-style:none;margin:0;padding:0;display:grid;gap:.75rem}
ul.reports>li{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:.9rem 1rem}
.report{font-size:1.1rem;font-weight:600}
.missing .report{color:var(--muted)}
.pages{margin:.4rem 0 0;padding-left:1.2rem}
a{color:var(--link);text-decoration:underline;text-underline-offset:2px}
a:focus-visible{outline:3px solid var(--link);outline-offset:2px;border-radius:2px}
code{background:var(--code);padding:.1rem .35rem;border-radius:4px;font-size:.95em;
font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem;margin:0}
dt{color:var(--muted)}dd{margin:0;overflow-wrap:anywhere}
footer{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--line);color:var(--muted);font-size:.9rem}
@media (max-width:30rem){dl{grid-template-columns:1fr}dd{margin-bottom:.4rem}}
`
  .trim()
  .replace(/\n/g, "");

/**
 * The landing page.
 *
 * @param input - the bundle's name, the run's facts and every report.
 * @returns the whole HTML document.
 */
export function landingPage(input: LandingInput): string {
  const { facts } = input;
  const heading =
    facts?.product !== undefined && facts.cell !== undefined
      ? `${facts.product} · ${facts.cell}`
      : input.name;
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    // Nothing loads from anywhere: no script, no image, no font, no request leaves the page.
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${escapeHtml(`Run report · ${heading}`)}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    "<main>",
    "<header>",
    `<h1>${escapeHtml(heading)}</h1>`,
    facts?.title === undefined
      ? ""
      : `<p class="title">${escapeHtml(facts.title)}</p>`,
    statusBadge(facts),
    "</header>",
    '<section aria-labelledby="reports">',
    '<h2 id="reports">Reports</h2>',
    `<ul class="reports">${input.reports.map(reportItem).join("")}</ul>`,
    "</section>",
    '<section aria-labelledby="run">',
    '<h2 id="run">Run</h2>',
    factList(facts),
    "</section>",
    "<footer>",
    `<p>Bundle <code>${escapeHtml(input.name)}</code>. Commands run from this folder. ` +
      "The reports may hold session cookies and site data: share them as you would the run itself.</p>",
    "</footer>",
    "</main>",
    "</body>",
    "</html>",
    "",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

/**
 * The run's status, in words and colour (never colour alone).
 *
 * @param facts - the facts, if any.
 */
function statusBadge(facts: LandingFacts | undefined): string {
  if (facts?.status === undefined) {
    return '<p class="status neutral">Status unknown</p>';
  }
  const tone = STATUS_TONES[facts.status] ?? "neutral";
  const words = STATUS_WORDS[facts.status] ?? facts.status;
  return `<p class="status ${tone}">${escapeHtml(words)}</p>`;
}

/**
 * One report's item: its link, pages and serve note; or its name and why it is missing.
 *
 * @param report - the report.
 */
function reportItem(report: BundledReport): string {
  const { name, about } = REPORTS[report.kind];
  if (!report.present) {
    return (
      `<li class="missing"><p><span class="report">${escapeHtml(name)}</span> — not in this bundle: ` +
      `${escapeHtml(report.reason)}.</p></li>`
    );
  }
  const pages =
    report.pages.length === 0
      ? ""
      : `<ul class="pages">${report.pages
          .map(
            (page) =>
              `<li><a href="${escapeHtml(page.href)}">${escapeHtml(page.label)}</a></li>`,
          )
          .join("")}</ul>`;
  const serve =
    report.serve === undefined
      ? ""
      : `<p>${escapeHtml(report.serve.why)} Serve it with <code>${escapeHtml(report.serve.command)}</code>.</p>`;
  return (
    `<li><p><a class="report" href="${escapeHtml(report.href)}">${escapeHtml(name)}</a> — ` +
    `${escapeHtml(about)}.</p>${pages}${serve}</li>`
  );
}

/**
 * The run's facts as a description list, `run-facts.json` linked; or a line saying there are none.
 *
 * @param facts - the facts, if any.
 */
function factList(facts: LandingFacts | undefined): string {
  if (facts === undefined) {
    return "<p>No run facts: the run left no readable <code>run-facts.json</code>.</p>";
  }
  const rows: [string, string | undefined][] = [
    ["Run", facts.runName],
    ["Run ID", facts.runId],
    ["Product", facts.product],
    ["Cell", facts.cell],
    ["Edition", facts.edition],
    ["Started", facts.startedAt],
    ["Ended", facts.endedAt],
    [
      "Duration",
      facts.durationMs === undefined
        ? undefined
        : formatDuration(facts.durationMs),
    ],
  ];
  const items = rows
    .filter((row): row is [string, string] => row[1] !== undefined)
    .map(
      ([label, value]) =>
        `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`,
    )
    .join("");
  return (
    (items === "" ? "" : `<dl>${items}</dl>`) +
    '<p>Every fact (plugin zip, commit, SHA-256, site versions): <a href="run-facts.json">run-facts.json</a>.</p>'
  );
}
