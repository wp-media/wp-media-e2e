import { rule } from "../terminal/layout";
import type { Palette } from "../terminal/palette";
import { printableLine, printableLines } from "../text";
import type { WarmSummary, WarmUnit } from "./warm";

/**
 * The artifact warm's output (`warm-artifacts.ts`), as lines. Pure — a summary in, lines out — so it
 * is tested without APVM; the palette decides colour and symbols for the stream they go to. What
 * others wrote (APVM's and git's errors, the planner's warnings, an operator's path) is printed safe:
 * no escape or control, credentials masked ({@link printableLines}).
 */

/** How wide the warm's rules are: fixed, so a CI log reads the same from any terminal. */
export const RULE_WIDTH = 72;

/** A cell excluded from warming because it has no real sites (placeholder-only). */
export interface SkippedCell {
  readonly product: string;
  readonly cell: string;
}

/**
 * The banner, what is about to be warmed, and the cells skipped.
 *
 * @param units - the cells to warm.
 * @param skipped - the placeholder-only cells left out.
 * @param palette - colour and symbols.
 * @returns the banner's lines, ending with a blank line.
 */
export function warmHeaderLines(
  units: readonly WarmUnit[],
  skipped: readonly SkippedCell[],
  palette: Palette,
): string[] {
  const { paint, symbol } = palette;
  const title = (text: string): string => paint("emphasis", paint("id", text));
  const line = title(rule({ width: RULE_WIDTH, line: symbol("rule") }));
  return [
    line,
    title(`  wp-media-e2e ${symbol("dash")} Warm plugin artifacts`),
    line,
    paint(
      "dim",
      `  Priming APVM's cache for ${String(units.length)} cell(s): ` +
        `${units.map((u) => u.label).join(", ") || "(none)"}.`,
    ),
    ...skipped.map(
      (s) =>
        `  ${paint("warn", symbol("warning"))} ${s.product}/${s.cell} ${symbol("dash")} ` +
        paint("warn", "skipped (placeholder-only, will not run)"),
    ),
    "",
  ];
}

/**
 * The planner's warnings, one line each (printed to stderr).
 *
 * @param summary - the warm's outcome.
 * @param palette - colour and symbols of the stream they go to.
 */
export function warmWarningLines(
  summary: Pick<WarmSummary, "warnings">,
  palette: Palette,
): string[] {
  const mark = palette.paint("warn", palette.symbol("warning"));
  return summary.warnings.flatMap((warning) =>
    printableLines(warning).map((line, index) =>
      index === 0 ? `  ${mark} ${line}` : `    ${line}`,
    ),
  );
}

/**
 * The per-request outcomes (with the pin a run repeats a warmed build with), the operator-provided
 * zips skipped, and the units that could not be planned.
 *
 * @param summary - the warm's outcome.
 * @param palette - colour and symbols.
 */
export function warmResultLines(
  summary: WarmSummary,
  palette: Palette,
): string[] {
  const { paint, symbol } = palette;
  const dash = symbol("dash");
  const failedMark = paint("emphasis", paint("fail", symbol("cross")));
  const lines = summary.skipped.map(
    (skip) =>
      `  ${paint("dim", symbol("bullet"))} ${skip.label} ${skip.role}: ` +
      paint(
        "dim",
        `provided zip (${printableLine(skip.rawPath)}) ${dash} nothing to warm.`,
      ),
  );

  for (const result of summary.results) {
    const ref = printableLine(
      `${result.params.project} ${result.params.gitRef}`,
    );
    const variant = result.params.variants?.length
      ? ` [${result.params.variants.join(", ")}]`
      : "";
    const wantedBy = paint("dim", `(${result.wantedBy.join(", ")})`);
    if (!result.ok) {
      lines.push(
        `  ${failedMark} ${paint("emphasis", `${ref}${variant}`)} ${wantedBy}`,
        ...errorLines(String(result.error), palette),
      );
      continue;
    }
    const note = result.build?.fromCache === true ? "already cached" : "warmed";
    lines.push(
      `  ${paint("ok", symbol("check"))} ${ref}${variant} ${dash} ${note} ${wantedBy}`,
    );
    // What a run is given to repeat exactly this build, even after `develop` moves: the pin's ref as
    // its `_REF`, and its version, when there is one, as its `_VERSION`.
    if (result.build !== undefined) {
      const { pin } = result.build;
      const version =
        pin.version !== undefined
          ? `, version ${pin.version}`
          : " (no version: a release's is its tag)";
      lines.push(`      ${paint("dim", `pin: ref ${pin.ref}${version}`)}`);
    }
  }

  for (const failure of summary.planFailures) {
    lines.push(
      `  ${failedMark} ${paint("emphasis", failure.label)} ${dash} could not plan`,
      ...errorLines(failure.error, palette),
    );
  }
  return lines;
}

/**
 * An error under the request it failed, one printed line per line of it, each made safe.
 *
 * @param error - the error's text, as APVM, git or the planner wrote it.
 * @param palette - colour.
 */
function errorLines(error: string, palette: Palette): string[] {
  return printableLines(error).map(
    (line) => `      ${palette.paint("fail", line)}`,
  );
}

/**
 * The closing tally and the exit code it implies.
 *
 * @param summary - the warm's outcome.
 * @param palette - colour and symbols.
 * @returns the lines, and `0` when every plan and warm succeeded, else `1`.
 */
export function warmFooter(
  summary: WarmSummary,
  palette: Palette,
): { readonly lines: string[]; readonly exitCode: 0 | 1 } {
  const { paint, symbol } = palette;
  const warmed = summary.results.filter((r) => r.ok).length;
  const failed =
    summary.results.filter((r) => !r.ok).length + summary.planFailures.length;
  const head = [
    "",
    paint("emphasis", rule({ width: RULE_WIDTH, line: symbol("rule") })),
  ];
  if (summary.ok) {
    return {
      lines: [
        ...head,
        paint(
          "emphasis",
          paint(
            "ok",
            `  ${String(warmed)} request(s) warmed. Cache is primed.`,
          ),
        ),
      ],
      exitCode: 0,
    };
  }
  return {
    lines: [
      ...head,
      paint(
        "emphasis",
        paint(
          "fail",
          `  ${String(failed)} warm request(s) failed; ${String(warmed)} succeeded. See details above.`,
        ),
      ),
    ],
    exitCode: 1,
  };
}

/**
 * The line printed when no matched cell has real sites, so nothing is warmed.
 *
 * @param palette - colour and symbols.
 */
export function nothingToWarmLine(palette: Palette): string {
  return palette.paint(
    "emphasis",
    palette.paint(
      "warn",
      `  Nothing to warm ${palette.symbol("dash")} every matched cell is placeholder/example data only, so no run will use it.`,
    ),
  );
}

/**
 * A fatal usage error (an unknown `--product` or `--cell`), printed to stderr.
 *
 * @param message - what was wrong, emphasised.
 * @param detail - what is known instead, plain.
 * @param palette - colour of the stream it goes to.
 */
export function usageErrorLine(
  message: string,
  detail: string,
  palette: Palette,
): string {
  return (
    palette.paint(
      "emphasis",
      palette.paint("fail", `[artifacts:warm] ${message}`),
    ) + detail
  );
}
