import { isNonEmptyString, isObject } from "../guards";
import type { ScanDebugLogOptions } from "../wp/log";
import type { SiteDbResidue } from "../wp/db-residue";
import type {
  Edition,
  ResolveSiteDataDirs,
  SiteConfig,
  SettleLeftovers,
  SiteResidue,
  StopRunningWork,
} from "./types";

/**
 * Owns the project-metadata contract and the per-process registries that back it.
 *
 * Playwright serializes a project's `metadata` verbatim into its reports, so it must
 * never carry secrets — and it can only carry JSON. We put only non-secret routing
 * (`product`, `cell`, `edition`) in metadata and hand everything else to workers through
 * in-memory registries: the credential-bearing site pool (secrets), the product's debug-log
 * preset and residue declarations (RegExps, which JSON cannot express), its database footprint,
 * and the functions that resolve its runtime-named data directories and stop its background work.
 * The registry is also how **product policy reaches the shared hooks without those hooks importing
 * product code**, so even what JSON could carry goes this way: one channel is easier to follow than
 * two. All are populated as a side effect of building the config (`createProductConfig`), which
 * Playwright re-executes in every worker process, so each worker resolves them locally — never from
 * a report-bound channel.
 */

/** Non-secret routing carried in a project's `metadata`. */
export interface ProjectRouting {
  readonly product: string;
  readonly cell: string;
  /** The cell's edition, for edition-ful products; absent for editionless ones. */
  readonly edition?: Edition;
}

/** Builds the non-secret `metadata` object for a (product, cell[, edition]) project. */
export function routingMetadata(
  product: string,
  cell: string,
  edition?: Edition,
): ProjectRouting {
  return edition === undefined ? { product, cell } : { product, cell, edition };
}

/** Validates an optional `edition` value, returning it narrowed; throws on an unknown value. */
function parseEdition(value: unknown): Edition | undefined {
  if (value === undefined || value === "free" || value === "pro") return value;
  throw new Error(
    '[metadata] project metadata `edition` must be "free" | "pro" when present.',
  );
}

/** Reads and validates the routing carried in a Playwright project's `metadata`. */
export function readRouting(metadata: unknown): ProjectRouting {
  if (!isObject(metadata)) {
    throw new Error(
      "[metadata] project metadata is missing or not an object; expected { product, cell }.",
    );
  }
  if (!isNonEmptyString(metadata.product) || !isNonEmptyString(metadata.cell)) {
    throw new Error(
      "[metadata] project metadata must carry non-empty string `product` and `cell`.",
    );
  }
  const edition = parseEdition(metadata.edition);
  return edition === undefined
    ? { product: metadata.product, cell: metadata.cell }
    : { product: metadata.product, cell: metadata.cell, edition };
}

// Per-process registry: (product, cell) -> resolved site pool (with credentials).
const pools = new Map<string, readonly SiteConfig[]>();

/** Composite key for the pool registry. */
function poolKey(product: string, cell: string): string {
  return `${product}::${cell}`;
}

/** Registers a cell's resolved pool. Called while building the config, in each process. */
export function registerPool(
  product: string,
  cell: string,
  sites: readonly SiteConfig[],
): void {
  pools.set(poolKey(product, cell), sites);
}

/**
 * Returns the resolved pool for a (product, cell). Throws if it was never registered,
 * which means the config was not built in this process — a programming error, not bad input.
 */
export function getPool(product: string, cell: string): readonly SiteConfig[] {
  const pool = pools.get(poolKey(product, cell));
  if (pool === undefined) {
    throw new Error(
      `[metadata] no site pool registered for "${product}/${cell}". ` +
        "The Playwright config must be built in this process before the pool is read.",
    );
  }
  return pool;
}

// Per-process registry: product -> its debug-log scan preset (RegExp-bearing, so not JSON).
const debugLogOptions = new Map<string, ScanDebugLogOptions>();

/**
 * Registers a product's debug-log scan preset (its verified-benign `ignore` patterns and any
 * `source` restriction). Called while building the config, in each process. A product that
 * declares none is simply not registered — see {@link getDebugLogOptions} for what that means.
 */
export function registerDebugLogOptions(
  product: string,
  options: ScanDebugLogOptions | undefined,
): void {
  if (options === undefined) return;
  debugLogOptions.set(product, options);
}

/**
 * The debug-log preset for a product, or `{}` when it declares none.
 *
 * Unlike {@link getPool} this never throws: `{}` means "categorise every line, ignore nothing",
 * which is the **strictest** reading of the log. A product that forgot to declare a preset
 * therefore gets a gate that is too strict rather than one that silently passes.
 */
export function getDebugLogOptions(product: string): ScanDebugLogOptions {
  return debugLogOptions.get(product) ?? {};
}

// Per-process registry: product -> the paths it leaves on the site after being uninstalled.
const siteResidue = new Map<string, readonly SiteResidue[]>();

/**
 * Registers the paths a product leaves on the site's filesystem, for the shared teardown to clear.
 * Called while building the config, in each process. A product that declares none is not
 * registered.
 */
export function registerSiteResidue(
  product: string,
  paths: readonly SiteResidue[] | undefined,
): void {
  if (paths === undefined) return;
  siteResidue.set(product, paths);
}

/**
 * The residue paths for a product, or an empty list when it declares none.
 *
 * Never throws: unlike a missing site pool, "this product leaves nothing behind" is a legitimate
 * state — WP Rocket declares none today — and the teardown then does nothing at all.
 */
export function getSiteResidue(product: string): readonly SiteResidue[] {
  return siteResidue.get(product) ?? [];
}

// Per-process registry: product -> the database footprint it leaves when its files go without its
// own uninstall running.
const siteDbResidue = new Map<string, SiteDbResidue>();

/**
 * Registers the database footprint a product leaves on a site, for the shared hooks to sweep.
 * Called while building the config, in each process. A product that declares none is not
 * registered.
 */
export function registerSiteDbResidue(
  product: string,
  residue: SiteDbResidue | undefined,
): void {
  if (residue === undefined) return;
  siteDbResidue.set(product, residue);
}

/**
 * The database footprint for a product, or an empty declaration when it declares none.
 *
 * Never throws, for the same reason as {@link getSiteResidue}: a product whose uninstall is the
 * only cleanup its database needs is a legitimate state, and the sweep then costs no round-trip.
 */
export function getSiteDbResidue(product: string): SiteDbResidue {
  return siteDbResidue.get(product) ?? {};
}

// Per-process registry: product -> how to ask its installed plugin for the data directories it names
// at runtime. A function, so it could never ride project metadata either.
const siteDataDirResolvers = new Map<string, ResolveSiteDataDirs>();

/**
 * Registers how a product resolves the data directories its plugin names at runtime, for the shared
 * install to prepare. Called while building the config, in each process. A product whose data
 * directories all have fixed names is not registered.
 */
export function registerSiteDataDirResolver(
  product: string,
  resolve: ResolveSiteDataDirs | undefined,
): void {
  if (resolve === undefined) return;
  siteDataDirResolvers.set(product, resolve);
}

/**
 * How a product resolves its runtime-named data directories, or `undefined` when it declares none —
 * the install then has nothing to ask. Never throws, for the same reason as {@link getSiteResidue}.
 */
export function getSiteDataDirResolver(
  product: string,
): ResolveSiteDataDirs | undefined {
  return siteDataDirResolvers.get(product);
}

// Per-process registry: product -> how to stop the work it may still be doing on a site. A function,
// so it could never ride project metadata at all.
const runningWorkStops = new Map<string, StopRunningWork>();

/**
 * Registers how a product stops its own background work, for the shared `@plugin` hooks to call
 * before each removal of the plugin. Called while building the config, in each process. A product
 * that runs nothing in the background is not registered.
 */
export function registerStopRunningWork(
  product: string,
  stop: StopRunningWork | undefined,
): void {
  if (stop === undefined) return;
  runningWorkStops.set(product, stop);
}

/**
 * How a product stops its background work, or `undefined` when it declares none — the hooks then
 * have nothing to ask, and cost no round trip. Never throws, for the same reason as
 * {@link getSiteResidue}.
 */
export function getStopRunningWork(
  product: string,
): StopRunningWork | undefined {
  return runningWorkStops.get(product);
}

// Per-process registry: product -> how to settle what its killed runs left on a site. A function, so
// it could never ride project metadata at all.
const leftoverSettlers = new Map<string, SettleLeftovers>();

/**
 * Registers how a product settles what its earlier runs left on a site, for the auth setup's
 * preflight to call before its gates. Called while building the config, in each process. A product
 * that leaves nothing such is not registered.
 */
export function registerSettleLeftovers(
  product: string,
  settle: SettleLeftovers | undefined,
): void {
  if (settle === undefined) return;
  leftoverSettlers.set(product, settle);
}

/**
 * How a product settles its leftovers, or `undefined` when it declares none — the preflight then
 * asks nothing. Never throws, for the same reason as {@link getSiteResidue}.
 */
export function getSettleLeftovers(
  product: string,
): SettleLeftovers | undefined {
  return leftoverSettlers.get(product);
}
