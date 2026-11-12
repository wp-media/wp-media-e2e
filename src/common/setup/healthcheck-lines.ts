import type { Transport } from "../config/types";
import { rule } from "../terminal/layout";
import type { Palette } from "../terminal/palette";
import { printableLine } from "../text";
import type { ElevationSupport } from "../wp/exec";
import { checkLines } from "./check-lines";
import type { CheckResult } from "./preflight";
import type { IdentityIssue } from "./site-identity-report";
import { transportLabel } from "./preflight";

/**
 * The fleet healthcheck's output (`healthcheck.ts`), as lines: a header, one section per product (its
 * skipped cells, each site's checks, a tally) and a closing summary. Pure — results in, lines out —
 * so it is tested without a fleet; the palette decides colour and symbols for the stream the lines
 * are printed to (`healthcheck > fleet.log` gets none of either beyond Unicode text).
 */

/** How wide the healthcheck's rules are: fixed, so a log reads the same from any terminal. */
export const RULE_WIDTH = 72;

/** A cell that has no real sites to check (placeholder-only, or the product declares no cells). */
export interface CellSkip {
  readonly product: string;
  readonly cell: string;
  readonly reason: string;
}

/** What the header and the summary need of a product's plan: its sites to check and its skips. */
export interface PlanView {
  readonly product: string;
  /** One entry per site to check: the cell it belongs to. */
  readonly tasks: readonly {
    readonly product: string;
    readonly cell: string;
  }[];
  readonly skips: readonly CellSkip[];
}

/** The full outcome for one site: its identity, every check run against it, timing, and pass/fail. */
export interface SiteResult {
  readonly product: string;
  readonly cell: string;
  readonly index: number;
  readonly baseURL: string;
  readonly transport: Transport;
  readonly checks: CheckResult[];
  readonly durationMs: number;
  readonly ok: boolean;
  /**
   * What privileges this site's transport reached, when it got far enough to be asked. Carried so
   * the fleet run can close with the same elevation warning a suite run prints, from the same
   * renderer — a fleet monitor is exactly where "half the fleet cannot clean up after itself" should
   * be impossible to miss.
   */
  readonly elevation?: ElevationSupport;
  /**
   * Whether this site's files actually need handing to another owner. Carried for the same reason
   * `SitePreflightResult` carries it: the run-level banner states the ownership cost only for the
   * sites where it is true, and a fleet check that dropped it would quietly claim the cost for none
   * of them.
   */
  readonly ownershipPending?: boolean;
  /** Folders at the cell's slug that WordPress lists no plugin in, for the closing warning. */
  readonly leftoverPluginDirs?: readonly string[];
  /** What the site identity banner lists for this site, for the closing warning. */
  readonly identityIssues?: readonly IdentityIssue[];
}

/**
 * The human-readable identity of a site, e.g. `backwpup/pro@nginx · site[0] https://… [ssh: user@host]`.
 * Its address and transport come from a sites file, so each is made safe to print ({@link printableLine}).
 *
 * @param result - the site's identity.
 * @param palette - its separator symbol.
 */
function siteLabel(
  result: Pick<
    SiteResult,
    "product" | "cell" | "index" | "baseURL" | "transport"
  >,
  palette: Palette,
): string {
  return `${result.product}/${result.cell} ${palette.symbol("separator")} site[${String(result.index)}] ${printableLine(result.baseURL)} [${printableLine(transportLabel(result.transport))}]`;
}

/**
 * Seconds with one decimal, as every timing here reads.
 *
 * @param ms - milliseconds.
 */
function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * The top banner and the fleet-wide counts about to be checked.
 *
 * @param plans - every product's plan.
 * @param palette - colour and symbols.
 * @returns the banner, its count line and a blank line.
 */
export function headerLines(
  plans: readonly PlanView[],
  palette: Palette,
): string[] {
  const { paint, symbol } = palette;
  const siteCount = plans.reduce((n, p) => n + p.tasks.length, 0);
  const cellCount = new Set(
    plans.flatMap((p) => p.tasks.map((t) => `${t.product}/${t.cell}`)),
  ).size;
  const title = (text: string): string => paint("emphasis", paint("id", text));
  const line = title(rule({ width: RULE_WIDTH, line: symbol("rule") }));
  return [
    line,
    title(`  wp-media-e2e ${symbol("dash")} Health Check`),
    line,
    paint(
      "dim",
      `  Preflight (transport + WordPress) and login checks across ${String(siteCount)} ` +
        `site(s) in ${String(cellCount)} cell(s), ${String(plans.length)} product(s).`,
    ),
    "",
  ];
}

/**
 * A product's section divider, `── product ───…`, in the product's own colour so sections never blur.
 * The colours start one past the series' first, which the header's cyan already uses.
 *
 * @param product - the product's name.
 * @param index - its place among the products, from 0, which picks its colour.
 * @param palette - colour and symbols.
 * @returns the divider and a blank line.
 */
export function productHeaderLines(
  product: string,
  index: number,
  palette: Palette,
): string[] {
  const divider = rule({
    width: RULE_WIDTH,
    line: palette.symbol("rule"),
    title: product,
  });
  return [palette.paint("emphasis", palette.series(index + 1, divider)), ""];
}

/**
 * One skipped (placeholder-only) cell — informational, never a failure.
 *
 * @param skip - the cell and why it was skipped.
 * @param palette - colour and symbols.
 */
export function skipLine(skip: CellSkip, palette: Palette): string {
  const { paint, symbol } = palette;
  return (
    `  ${paint("emphasis", paint("warn", symbol("warning")))} ${skip.product}/${skip.cell} ${symbol("dash")} ` +
    `${paint("warn", "skipped")}: ${skip.reason}`
  );
}

/**
 * One site's result: a headline with an `n/m checks` tally and its time, then every check it ran —
 * passes too, so a green site still shows exactly what was verified — and a blank line. Details and
 * hints (WP-CLI's output, an error) are printed safe: no escape or control, credentials masked.
 *
 * @param result - the site's result.
 * @param palette - colour and symbols.
 */
export function siteResultLines(
  result: SiteResult,
  palette: Palette,
): string[] {
  const { paint, symbol } = palette;
  const label = siteLabel(result, palette);
  const duration = paint("dim", `(${seconds(result.durationMs)})`);
  const passedChecks = result.checks.filter((c) => c.ok).length;
  const tally = paint(
    "dim",
    `${String(passedChecks)}/${String(result.checks.length)} checks`,
  );
  const separator = symbol("separator");
  const headline = result.ok
    ? `  ${paint("emphasis", paint("ok", symbol("passed")))} ${label} ${separator} ${tally} ${duration}`
    : `  ${paint("emphasis", paint("fail", symbol("failed")))} ${paint("emphasis", label)} ${separator} ${tally} ${duration}`;
  return [
    headline,
    ...checkLines(result.checks, "      ", palette, "printed"),
    "",
  ];
}

/**
 * A product's own tally, right after its section: passed/failed sites and skipped cells.
 *
 * @param plan - the product's plan.
 * @param results - its sites' results.
 * @param palette - colour and symbols.
 */
export function productTallyLine(
  plan: PlanView,
  results: readonly SiteResult[],
  palette: Palette,
): string {
  const { paint } = palette;
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  const skips = plan.skips.length;
  const skipNote = skips > 0 ? `, ${String(skips)} cell(s) skipped` : "";

  let summary: string;
  if (results.length === 0) {
    const note = skips > 0 ? ` (${String(skips)} cell(s) skipped)` : "";
    summary = paint("warn", `no real sites to check${note}`);
  } else if (failed === 0) {
    summary = paint(
      "emphasis",
      paint(
        "ok",
        `${String(passed)}/${String(results.length)} site(s) passed${skipNote}`,
      ),
    );
  } else {
    summary =
      `${paint("emphasis", paint("fail", `${String(failed)} failed`))}, ` +
      `${String(passed)}/${String(results.length)} passed${skipNote}`;
  }
  return `  ${paint("emphasis", `${plan.product}:`)} ${summary}`;
}

/**
 * The closing summary: a per-product breakdown (never mixing products), the fleet's totals and a
 * verdict line.
 *
 * @param plans - every product's plan.
 * @param results - every site's result.
 * @param elapsedMs - how long the whole check took.
 * @param palette - colour and symbols.
 * @returns the summary's lines, ending with a blank line.
 */
export function summaryLines(
  plans: readonly PlanView[],
  results: readonly SiteResult[],
  elapsedMs: number,
  palette: Palette,
): string[] {
  const { paint, symbol } = palette;
  const failed = results.filter((r) => !r.ok).length;
  const passed = results.length - failed;
  const totalSkips = plans.reduce((n, p) => n + p.skips.length, 0);
  const nameWidth = Math.max(0, ...plans.map((p) => p.product.length));
  const strong = (text: string): string => paint("emphasis", text);
  const line = strong(rule({ width: RULE_WIDTH, line: symbol("rule") }));

  const lines = [line, strong("  Summary"), line];
  for (const plan of plans) {
    lines.push(productSummaryLine(plan, results, nameWidth, palette));
  }
  lines.push(
    "",
    `  ${strong(paint("ok", String(passed)))} passed, ` +
      `${failed > 0 ? strong(paint("fail", String(failed))) : paint("dim", String(failed))} failed, ` +
      `${strong(paint("warn", String(totalSkips)))} skipped ` +
      paint("dim", `${symbol("dash")} ${seconds(elapsedMs)} total`),
    "",
    verdictLine(failed, results.length, palette),
    "",
  );
  return lines;
}

/**
 * A product's line in the summary: its mark (failed, passed, or nothing checked), name and counts.
 *
 * @param plan - the product's plan.
 * @param all - every site's result; the product's are picked out.
 * @param nameWidth - the longest product name, so the counts align.
 * @param palette - colour and symbols.
 */
function productSummaryLine(
  plan: PlanView,
  all: readonly SiteResult[],
  nameWidth: number,
  palette: Palette,
): string {
  const { paint, symbol } = palette;
  const results = all.filter((r) => r.product === plan.product);
  const failed = results.filter((r) => !r.ok).length;
  const mark =
    failed > 0
      ? paint("fail", symbol("failed"))
      : results.length > 0
        ? paint("ok", symbol("passed"))
        : paint("warn", symbol("warning"));
  const parts = [
    `${String(results.length - failed)}/${String(results.length)} site(s) passed`,
  ];
  if (plan.skips.length > 0) {
    parts.push(`${String(plan.skips.length)} cell(s) skipped`);
  }
  return `  ${paint("emphasis", mark)} ${paint("emphasis", plan.product.padEnd(nameWidth))}  ${parts.join(` ${symbol("separator")} `)}`;
}

/**
 * The verdict: how many sites failed, that all are healthy, or that nothing real was configured.
 *
 * @param failed - the failed sites.
 * @param checked - every site checked.
 * @param palette - colour.
 */
function verdictLine(
  failed: number,
  checked: number,
  palette: Palette,
): string {
  const { paint } = palette;
  if (failed > 0) {
    return paint(
      "emphasis",
      paint(
        "fail",
        `  ${String(failed)} of ${String(checked)} site(s) failed. See details above.`,
      ),
    );
  }
  if (checked > 0) {
    return paint(
      "emphasis",
      paint("ok", `  All ${String(checked)} checked site(s) are healthy.`),
    );
  }
  return paint(
    "emphasis",
    paint(
      "warn",
      "  No real sites were configured to check (placeholder/example data only).",
    ),
  );
}
