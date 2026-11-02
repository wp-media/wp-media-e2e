/**
 * For the compatibility matrix: a standalone script's output (the healthcheck's), as it prints it —
 * `consolePrinters()` on this process's own streams and environment, then the healthcheck's own line
 * builders for a fleet of one passing site: the banner, the site's checks, the summary; then one
 * warning on standard error, through its own printer, so each stream's palette is seen apart.
 *
 * Usage: `node --import tsx script-probe.ts`.
 */

import { consolePrinters } from "../../config/output";
import {
  headerLines,
  siteResultLines,
  summaryLines,
  type PlanView,
  type SiteResult,
} from "../../setup/healthcheck-lines";

const plan: PlanView = {
  product: "demo",
  tasks: [{ product: "demo", cell: "x" }],
  skips: [],
};

const site: SiteResult = {
  product: "demo",
  cell: "x",
  index: 0,
  baseURL: "http://localhost:8100",
  transport: { mode: "local", rootDir: "/var/www/html" },
  checks: [{ name: "WP-CLI", ok: true, detail: "WP-CLI 2.12.0" }],
  durationMs: 1_200,
  ok: true,
};

const { out, err } = consolePrinters();
for (const line of [
  ...headerLines([plan], out.palette),
  ...siteResultLines(site, out.palette),
  ...summaryLines([plan], [site], 1_500, out.palette),
])
  out.print(line);
err.print(
  `${err.palette.symbol("warning")} ${err.palette.paint("warn", "a warning")}`,
);
