import { defineConfig } from "allure";

/**
 * Allure 3 report configuration (read by the `allure` CLI — see `scripts/allure.mjs`).
 *
 * The `allure-playwright` reporter only writes RAW results; this file controls how they are
 * turned into a report. Per-run values are supplied by `generateAllureReport`
 * (`src/common/reporting/allure-report.ts`): the output dir on the CLI (`-o`), `ALLURE_HISTORY`
 * pointing at the cell-level history file that accumulates across runs — what makes the trend chart
 * span multiple runs — and `ALLURE_SINGLE_FILE=false` for a folder report (one that keeps
 * Playwright traces, which a single file would inline as base64).
 */
const historyPath = process.env.ALLURE_HISTORY || "allure-history.jsonl";

/** One self-contained HTML file per plugin (opens from disk), unless `ALLURE_SINGLE_FILE=false`. */
const singleFile = process.env.ALLURE_SINGLE_FILE !== "false";

export default defineConfig({
  name: "WP Media E2E",
  historyPath,
  // Triage buckets: surface tests that only passed on retry as flaky (not hidden among passes),
  // and separate assertion failures from unexpected errors.
  categories: [
    { name: "Flaky tests", matchers: { flaky: true } },
    { name: "Product defects", matchers: { statuses: ["failed"] } },
    { name: "Test defects", matchers: { statuses: ["broken"] } },
  ],
  plugins: {
    // The main interactive report; `singleFile` → one portable, self-contained HTML.
    awesome: {
      options: { singleFile, reportLanguage: "en" },
    },
    // A configurable overview: this run's results + their trend across runs. Chart types are Allure
    // 3's (`currentStatus`, `statusDynamics`, …); an unknown one draws nothing, and a layout with no
    // chart leaves the dashboard failing to load its data.
    dashboard: {
      options: {
        singleFile,
        reportLanguage: "en",
        layout: [
          { type: "currentStatus", title: "Test results" },
          { type: "statusDynamics", title: "Status trend" },
        ],
      },
    },
  },
});
