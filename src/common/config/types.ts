/**
 * Configuration types shared across products.
 *
 * A `product` (wp-rocket, backwpup, …) declares its features/steps, its service
 * configuration, and a map of `cell` → cell config. A `cell` is a named environment
 * (e.g. "apache", "nginx", "pro@nginx"); each holds a pool of interchangeable WordPress
 * instances across which that product's scenarios are distributed, plus an optional
 * edition (Free/Pro) for edition-ful products.
 */

// Both imports are type-only, so they are erased at runtime under `verbatimModuleSyntax` and the
// config↔artifacts and config↔wp type references introduce no runtime module cycles. Each schema
// lives with its own domain: the artifacts manifest in `../artifacts/types`, the debug-log scan
// options in `../wp/log` (whose presets products author in `support/debug-log.ts`).
import type { ProductArtifacts } from "../artifacts/types";
import type { ScanDebugLogOptions } from "../wp/log";
import type { SiteDbResidue } from "../wp/db-residue";

// Re-exported so a product-config author gets the manifest schema and `ProductConfig` from one
// place.
export type { ProductArtifacts };

/** WordPress hosting mode — decides how WP-CLI is dispatched (see the exec layer, a later phase). */
export type ServerMode = "ssh" | "docker" | "local";

/**
 * Fields every transport shares, independent of how commands reach the site. Kept on a common
 * base so a site-level knob is declared once instead of three times; the union stays
 * discriminated on `mode`.
 */
interface TransportBase {
  /**
   * Where this site's staging area lives — the directory on the **target** that test artifacts
   * (plugin zips, WXR imports, DB dumps) are copied into before WP-CLI reads them. Absolute, or
   * relative to the WordPress root. Defaults to `.e2e_temp` under the WordPress root, which is
   * also the web docroot on our environments; override it when the transport's user cannot write
   * there, or to keep staged files out of the docroot. Takes precedence over
   * `E2E_SITE_STAGING_DIR` (a site's own declaration beats a global default).
   *
   * Must be a **dedicated** directory: cleanup removes it whole, so the WordPress root itself,
   * any ancestor of it, and top-level paths are rejected (see `wp/staging.ts`).
   */
  readonly stagingDir?: string;

  /**
   * Whether housekeeping commands may be re-run with elevated privileges when the transport's own
   * user is not permitted to complete them. Defaults to **allowed**.
   *
   * A plugin writes files as the *web-server* user, and some of them land in directories that user
   * alone can write (BackWPup's restore area is `0755 www-data`, so nothing else can unlink inside
   * it). Cleanup then cannot finish, and the site accumulates the site's own backups run after run.
   * Elevation is what closes that gap — see `wp/exec.ts` for the mechanism and the strict limits on
   * what is ever elevated (never WP-CLI, never anything a scenario asserts on).
   *
   * Set `false` for a host where the transport's user must stay unprivileged; cleanup then reports
   * what it could not remove instead of escalating, which is the behaviour this suite had before
   * elevation existed.
   */
  readonly elevate?: boolean;

  /**
   * Who should own the files this suite writes into the site's docroot, as `"user:group"`.
   *
   * Leave it unset. WP-CLI runs as the transport's user while PHP runs as the web server, so a
   * plugin this suite installs lands owned by the wrong user and the web server cannot write inside
   * it; `wp/ownership.ts` fixes that after each write by **detecting** the ownership the site
   * already uses (from `wp-content`) rather than assuming `www-data`. Detection is correct wherever
   * the install is consistently owned — including hosts where the owner is a deployment account
   * rather than the web-server user — so this override exists only for a site where it is not.
   *
   * Both halves are required: the group is load-bearing, because on a host whose docroot owner is
   * *not* the web-server user, the shared group is the only thing that lets the web server write.
   * Set `false` to opt out of ownership normalisation entirely, as `elevate: false` opts out of
   * privileged cleanup.
   */
  readonly fileOwner?: string | false;
}

export interface SshTransport extends TransportBase {
  readonly mode: "ssh";
  readonly host: string;
  readonly username: string;
  readonly privateKeyPath: string;
  readonly rootDir: string;
}

export interface DockerTransport extends TransportBase {
  readonly mode: "docker";
  readonly container: string;
  /**
   * WordPress root **inside** the container. Optional because the exec layer runs every command
   * at the container's `WORKDIR`, which is the WordPress root in the images we use — so a
   * relative path already resolves correctly and the absolute root can be read back with `pwd`.
   * Declare it to skip that round-trip, or when a custom image's `WORKDIR` is not the WP root.
   */
  readonly rootDir?: string;
}

export interface LocalTransport extends TransportBase {
  readonly mode: "local";
  /**
   * WordPress root on the host — the directory containing `wp-load.php`. The exec layer runs
   * `wp` with this as its working directory so WP-CLI resolves the right install. Required: an
   * absent `rootDir` would silently run `wp` from the process CWD and target the wrong (or no)
   * WordPress, so a `local` site must always declare it.
   */
  readonly rootDir: string;
}

/** How WP-CLI reaches a given site. Discriminated on `mode`. */
export type Transport = SshTransport | DockerTransport | LocalTransport;

export interface FtpServiceConfig {
  readonly host: string;
  readonly username: string;
  readonly password: string;
  readonly port: number;
  readonly secure: boolean;
}

export interface S3ServiceConfig {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly bucket: string;
  readonly region: string;
}

/** Product-level external-service credentials (e.g. BackWPup remote storage). */
export interface ServiceConfig {
  readonly storage?: {
    readonly ftp?: FtpServiceConfig;
    readonly s3?: S3ServiceConfig;
  };
}

/** Per-site overrides of {@link ServiceConfig} (deep-partial); merged over the product globals. */
export interface ServiceOverrides {
  readonly storage?: {
    readonly ftp?: Partial<FtpServiceConfig>;
    readonly s3?: Partial<S3ServiceConfig>;
  };
}

/** A WordPress site exactly as declared in a product's `sites.json` (no derived fields). */
export interface SiteInput {
  readonly baseURL: string;
  readonly username: string;
  readonly password: string;
  readonly transport: Transport;
  /** Optional per-site service overrides (e.g. a separate FTP host to dodge rate limits). */
  readonly overrides?: ServiceOverrides;
}

/** A site resolved for a run: the declared input plus its computed per-run `storageState` path. */
export interface SiteConfig extends SiteInput {
  readonly storageState: string;
}

/** A pool of interchangeable sites backing one cell. */
export type SitePool = readonly SiteInput[];

/**
 * Plugin edition under test — the **behavioral tier** (Free vs Pro), a property of a cell.
 * Free and Pro are separate plugin packages (e.g. BackWPup); edition drives scenario
 * filtering (`@free`/`@pro`) and edition-aware page objects.
 *
 * Distinct from an APVM build **variant** (`free`/`pro-de`/`pro-en`): edition is binary and
 * language-blind, whereas a variant names an exact buildable package including language. The
 * artifacts manifest maps each edition to the one variant it builds (`pro` → `pro-en`); the
 * two are deliberately different namespaces (see `artifacts/types.ts`).
 */
export type Edition = "free" | "pro";

/**
 * One cell: its site pool plus, for edition-ful products (e.g. BackWPup), the `edition`
 * the whole cell runs. Editionless products (e.g. WP Rocket) omit `edition`.
 */
export interface CellConfig {
  readonly edition?: Edition;
  readonly sites: SitePool;
}

/** Cell name → its config. The set of cells is data-driven (the keys of `sites.json`). */
export type CellMap = Readonly<Record<string, CellConfig>>;

/**
 * Brings to a stop whatever a product is still doing on a site in the background — see
 * {@link ProductConfig.stopRunningWork}.
 *
 * Resolves with one sentence saying what it had to stop, for the scenario's report, or with
 * `undefined` when the site was idle — the common case, which should cost a single round trip.
 * Rejects when the work would not stop, since removing the plugin underneath it is then unsafe.
 */
export type StopRunningWork = (
  transport: Transport,
) => Promise<string | undefined>;

/**
 * Settles what a product's earlier runs left on a site that only the product knows how to undo, and
 * only once it is provably abandoned — see {@link ProductConfig.settleLeftovers}. Resolves once
 * nothing is left or it was settled (saying so itself); rejects naming what is left and why it was
 * not settled.
 */
export type SettleLeftovers = (
  site: Pick<SiteConfig, "baseURL" | "transport">,
) => Promise<void>;

/**
 * Directories a plugin creates under one parent, each with a name it picks at runtime — see
 * {@link ProductConfig.siteResidue}.
 */
export interface SiteResidueFamily {
  /** The directory they are created in, relative to the WordPress root. Only ever listed. */
  readonly parent: string;
  /** Their names: a pattern anchored at both ends, as tight as the plugin's naming allows. */
  readonly name: RegExp;
}

/** Something a product leaves on a site's filesystem: a path, or a family of directories. */
export type SiteResidue = string | SiteResidueFamily;

/**
 * Asks the installed plugin for the data directories it names at runtime — see
 * {@link ProductConfig.resolveSiteDataDirs}.
 *
 * Resolves with paths relative to the WordPress root (empty when the build names none); rejects when
 * the site could not be asked, since an install whose directories cannot be prepared is not ready.
 */
export type ResolveSiteDataDirs = (
  transport: Transport,
) => Promise<readonly string[]>;

/** Everything that defines a product (one BDD project family). */
export interface ProductConfig {
  readonly name: string;
  // `features`/`steps` are passed to playwright-bdd's `defineBddConfig`, which expects
  // mutable `string | string[]`.
  readonly features: string | string[];
  readonly steps: string[];
  readonly sites: CellMap;
  /**
   * The plugin artifacts (zips under test) this product resolves and verifies per run —
   * default refs, version/edition policy, and per-edition identity expectations. Required,
   * so a new product can never silently ship without a build source. See
   * {@link ProductArtifacts}.
   */
  readonly artifacts: ProductArtifacts;
  /**
   * How this product's `debug.log` is scanned by the shared scenario hooks: its verified-benign
   * `ignore` patterns, and optionally a `source` restriction. Declared here (rather than
   * imported by the hooks) so the shared hooks stay product-agnostic. Omit to scan every line
   * and ignore nothing — the strictest reading, so a missing preset can only make the gate
   * stricter, never quieter.
   */
  readonly debugLog?: ScanDebugLogOptions;
  /**
   * Paths — relative to the WordPress root — that this product **writes while running and does not
   * remove when uninstalled**, which the shared scenario hooks clear after every `@plugin`
   * scenario.
   *
   * Uninstalling a plugin removes its code and its database footprint; the files it produced are
   * the user's data and it rightly leaves them. A test suite that installs the plugin once per
   * scenario therefore accumulates them until the cell runs out of disk, so each product states
   * what it leaves behind and the shared teardown deals with it. Declared here rather than
   * imported by the hooks, for the same reason as {@link debugLog}: the hooks stay
   * product-agnostic.
   *
   * Each path must be relative, must not escape the WordPress root, and must not name a directory
   * WordPress itself owns — validated at removal time, so a typo fails loudly instead of deleting
   * a site. Directories a plugin creates with names it picks at runtime are declared as a
   * {@link SiteResidueFamily} — their parent and an anchored name pattern — and found on the site
   * when it is cleaned. Omit when a product leaves nothing behind.
   */
  readonly siteResidue?: readonly SiteResidue[];
  /**
   * The data directories this product's plugin names at runtime, asked of the installed plugin after
   * every `@plugin` install and prepared like the declared ones — open to both the transport's user
   * and the web server before either writes there.
   *
   * For a directory whose name only the plugin knows, so {@link siteResidue} can declare it only as a
   * family, and a family names nothing to create. Each path resolved must be one a
   * {@link siteResidue} entry covers, so what is prepared is also removed. Omit when every data
   * directory has a fixed name.
   */
  readonly resolveSiteDataDirs?: ResolveSiteDataDirs;
  /**
   * What this product leaves in a site's **database** when its files are removed without its own
   * uninstall ever running — the option fragments and tables the shared scenario hooks sweep
   * whenever they find them.
   *
   * The filesystem counterpart above exists because a plugin's uninstall keeps the files it wrote.
   * This one exists because that uninstall lives in the plugin's own `uninstall.php`, so it only
   * runs while the plugin's files are still there: a site whose plugin directory has gone while its
   * rows remain has no uninstall left to run, and the next install then reads the leftover rows as
   * evidence that it is an upgrade. Swept off the
   * footprint, never off whether the plugin is installed — see {@link SiteDbResidue}.
   *
   * Omit when a product's uninstall is the only cleanup its database needs.
   */
  readonly siteDbResidue?: SiteDbResidue;
  /**
   * How to stop work this product may still be doing on a site — a backup job that a scenario
   * failing midway left running, or that a killed run never got to stop — before the shared `@plugin`
   * hooks remove the plugin: the teardown after a scenario, and the install before one.
   *
   * Work that runs in web requests outlives the scenario that started it, and uninstalling the
   * plugin underneath it races it: the request can re-create the rows the uninstall just deleted, or
   * go on writing files the teardown is clearing. So both hooks ask the product to stop first.
   * Declared here rather than imported by the hooks, for the same reason as {@link debugLog}. Omit
   * when the product runs nothing in the background.
   *
   * Must settle within the hooks' allowance for it (`LEFT_WORK_ALLOWANCE_MS`, 90 s), probes
   * included: the install shares the Before hook with it, and a hook that times out is abandoned
   * mid-way rather than cancelled.
   */
  readonly stopRunningWork?: StopRunningWork;
  /**
   * Run by the auth setup's preflight on every real site **before its gates**: something a killed run
   * left can stop WordPress booting, and the gates would then skip every scenario — and with them the
   * product's own fixtures that settle it. Best-effort there: a refusal is a warning, left for the
   * product's own checks to refuse. Never run by the healthcheck, which changes nothing. Must settle
   * within `SETTLE_LEFTOVERS_ALLOWANCE_MS` (`setup/preflight.ts`).
   */
  readonly settleLeftovers?: SettleLeftovers;
  readonly services?: ServiceConfig;
}
