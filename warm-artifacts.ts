import "./src/common/config/load-env";

import { readArtifactEnv } from "./src/common/artifacts/request";
import { createApvmWarmer, warmArtifacts } from "./src/common/artifacts/warm";
import type { WarmUnit } from "./src/common/artifacts/warm";
import {
  nothingToWarmLine,
  usageErrorLine,
  warmFooter,
  warmHeaderLines,
  warmResultLines,
  warmWarningLines,
} from "./src/common/artifacts/warm-lines";
import type { SkippedCell } from "./src/common/artifacts/warm-lines";
import { consolePrinters } from "./src/common/config/output";
import type { Printers } from "./src/common/config/output";
import { isNonEmptyString } from "./src/common/guards";
import { isPlaceholderSite } from "./src/common/config/sites";
import type { ProductConfig } from "./src/common/config/types";
import { PRODUCTS } from "./src/projects/products";

/**
 * Pre-warm the APVM cache for the plugin zips a run will need, standalone — a CI
 * pre-step or local prep long before an orchestrator exists,
 * which later imports the same `warmArtifacts` before spawning cells.
 *
 * For every `(product × cell)` with real sites it plans the build requests exactly as a real run of
 * that one cell would (the parity invariant), deduplicates them, and warms each once so
 * the subsequent per-cell `build()` is a cache copy. `--product`/`--cell` narrow the set; global
 * `E2E_*` overrides apply (they warm what a same-env run would then build). Placeholder-only
 * cells are skipped, so a fresh checkout warms nothing and needs no GitHub token.
 *
 * Usage: `npm run artifacts:warm [-- --product=<p>] [--cell=<c>]`. Exits `0` when every warm
 * succeeded, `1` if any plan or warm failed **or** a filter named something that does not exist —
 * a typo must never look like a primed cache.
 */

// stdout and stderr, each styled as its stream and `E2E_OUTPUT` allow. Read once, after `.env` loads.
const PRINTERS: Printers = consolePrinters();

/** Reads a `--name=value` / `--name value` flag from argv, normalizing blank to `undefined`. */
function readFlag(name: string): string | undefined {
  const args = process.argv;
  const eq = `--${name}=`;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === undefined) continue;
    if (arg.startsWith(eq)) return normalize(arg.slice(eq.length));
    if (arg === `--${name}`) {
      // Space form (`--name value`): treat a following flag (or end of args) as "no value",
      // mirroring run-context's `--project` parsing, so `--product --cell=x` never misreads the flag.
      const next = args[i + 1];
      return next !== undefined && !next.startsWith("-")
        ? normalize(next)
        : undefined;
    }
  }
  return undefined;
}

/** Blank/absent → `undefined`; otherwise the trimmed value. */
function normalize(value: string | undefined): string | undefined {
  return isNonEmptyString(value) ? value.trim() : undefined;
}

/** The result of turning the product configs (filtered) into warmable units. */
interface Discovery {
  readonly units: WarmUnit[];
  readonly skippedCells: SkippedCell[];
}

/**
 * Builds a {@link WarmUnit} for each `(product, cell)` that has at least one real site, honoring
 * the `--product` / `--cell` filters. Placeholder-only cells are recorded as skipped, never
 * warmed — priming a cache for a cell that will not run is wasted work (and, for BackWPup, would
 * demand a token a fresh checkout does not have).
 */
function discover(
  products: readonly ProductConfig[],
  productFilter: string | undefined,
  cellFilter: string | undefined,
): Discovery {
  const units: WarmUnit[] = [];
  const skippedCells: SkippedCell[] = [];

  for (const product of products) {
    if (productFilter !== undefined && product.name !== productFilter) continue;
    for (const cell of Object.keys(product.sites)) {
      if (cellFilter !== undefined && cell !== cellFilter) continue;
      const config = product.sites[cell];
      const real = (config?.sites ?? []).filter((s) => !isPlaceholderSite(s));
      if (real.length === 0) {
        skippedCells.push({ product: product.name, cell });
        continue;
      }
      units.push({
        label: `${product.name}/${cell}`,
        manifest: product.artifacts,
        edition: config?.edition,
      });
    }
  }
  return { units, skippedCells };
}

/**
 * Prints lines to one of the script's streams.
 *
 * @param printer - `PRINTERS.out` or `PRINTERS.err`.
 * @param lines - the lines, each printed with its line end.
 */
function printLines(printer: Printers["out"], lines: readonly string[]): void {
  for (const line of lines) printer.print(line);
}

/**
 * Prints a fatal usage error to stderr and returns the exit code, so a typo never looks like success.
 *
 * @param message - what was wrong.
 * @param detail - what is known instead.
 */
function usageError(message: string, detail: string): number {
  PRINTERS.err.print(usageErrorLine(message, detail, PRINTERS.err.palette));
  return 1;
}

/**
 * Validates the `--product` / `--cell` filters against the configured products and cells. A
 * typo must fail loudly: silently warming nothing would leave CI believing the cache is primed,
 * and the run it was meant to speed up then builds cold.
 */
function validateFilters(
  productFilter: string | undefined,
  cellFilter: string | undefined,
): number | undefined {
  const products = PRODUCTS.filter(
    (p) => productFilter === undefined || p.name === productFilter,
  );
  if (productFilter !== undefined && products.length === 0) {
    return usageError(
      `unknown --product "${productFilter}".`,
      ` Known products: ${PRODUCTS.map((p) => p.name).join(", ")}.`,
    );
  }
  const cells = [...new Set(products.flatMap((p) => Object.keys(p.sites)))];
  if (cellFilter !== undefined && !cells.includes(cellFilter)) {
    return usageError(
      `unknown --cell "${cellFilter}".`,
      ` Known cells${productFilter !== undefined ? ` for "${productFilter}"` : ""}: ` +
        `${cells.join(", ") || "(none)"}.`,
    );
  }
  return undefined;
}

/**
 * Validate the filters, discover the warmable cells, warm, report.
 *
 * Every exit path sets `process.exitCode` and **returns**, letting Node exit on its own once
 * the event loop drains — deliberately not `process.exit()`, which discards a pipe's pending
 * async writes, and CI's stdout is a pipe rather than a TTY, so it can drop the very summary a
 * failed warm needs. Confirmed that nothing keeps the loop alive after a warm on any path — a
 * cache hit, a cold build (which shells out to composer/npm), or a failed ref resolve — so the
 * natural exit is both prompt and lossless. Keep it that way: anything that leaves a live
 * handle behind would turn this into a hang instead of an exit.
 */
async function main(): Promise<void> {
  const productFilter = readFlag("product");
  const cellFilter = readFlag("cell");

  const invalid = validateFilters(productFilter, cellFilter);
  if (invalid !== undefined) {
    process.exitCode = invalid;
    return;
  }

  const { units, skippedCells } = discover(PRODUCTS, productFilter, cellFilter);
  const { out, err } = PRINTERS;
  printLines(out, warmHeaderLines(units, skippedCells, out.palette));

  if (units.length === 0) {
    out.print(nothingToWarmLine(out.palette));
    return;
  }

  const summary = await warmArtifacts(
    units,
    readArtifactEnv(),
    createApvmWarmer(undefined, PRINTERS),
  );
  printLines(err, warmWarningLines(summary, err.palette));
  printLines(out, warmResultLines(summary, out.palette));
  const footer = warmFooter(summary, out.palette);
  printLines(out, footer.lines);
  process.exitCode = footer.exitCode;
}

await main();
