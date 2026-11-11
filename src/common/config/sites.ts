import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

import { OWNER_SPEC_RULE, parseOwnerSpec } from "./file-owner";
import { RUN_AS_RULE, UMASK_RULE, parseRunAs, parseUmask } from "./run-as";
import { isNonEmptyString, isObject } from "../guards";
import type {
  CellConfig,
  CellMap,
  Edition,
  RunAs,
  ServerMode,
  FtpServiceConfig,
  S3ServiceConfig,
  ServiceOverrides,
  SiteInput,
  Transport,
} from "./types";

/**
 * Loads and validates a product's site pools from its sites file(s).
 *
 * Reads `sites.json` (primary) plus any `sites.<name>.json` overlays present in
 * `configDir` — e.g. `sites.docker.json`, `sites.local.json`, `sites.ssh.json`.
 * Each file declares a disjoint set of cells; a cell name appearing in more than one
 * file is a hard error. Files are merged in stable order: `sites.json` first, then
 * overlays alphabetically.
 *
 * When no real sites files exist the committed `sites.example.json` is loaded with a
 * warning, so the suite still starts and lists tests on a fresh checkout.
 *
 * Every field is validated with an actionable error naming the offending cell/index,
 * so a malformed file fails fast instead of crashing later in the test run.
 */
export function loadSites(configDir: string): CellMap {
  const files = findSitesFiles(configDir);

  if (files.length === 0) {
    return loadFallback(configDir);
  }

  const loaded: { source: string; cells: CellMap }[] = [];
  for (const filePath of files) {
    loaded.push({ source: filePath, cells: loadAndValidateFile(filePath) });
  }

  return mergeCellMaps(loaded, configDir);
}

/**
 * True for a placeholder/example site — its `baseURL` is on the reserved `.example.test`
 * domain used only by the committed `sites.example.json`. The auth setup skips these so
 * the scaffold stays green before a real `sites.json` exists.
 */
export function isPlaceholderSite(site: { readonly baseURL: string }): boolean {
  try {
    return new URL(site.baseURL).hostname.endsWith(".example.test");
  } catch {
    return false;
  }
}

// ── File discovery ─────────────────────────────────────────────────────────────

/**
 * Returns the list of sites files to load from `configDir`, in merge order:
 * `sites.json` first (if present), then `sites.<name>.json` overlays alphabetically.
 * `sites.example.json` is never included — it is the fallback used only when NO real
 * files exist. Files whose names contain more than one dot between "sites" and ".json"
 * (e.g. `sites.a.b.json`) are ignored to keep the pattern unambiguous.
 */
function findSitesFiles(configDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return [];
  }

  const files: string[] = [];

  if (entries.includes("sites.json")) {
    files.push(join(configDir, "sites.json"));
  }

  // Matches sites.<single-segment>.json — one dot between "sites" and ".json",
  // with the segment containing no dots itself. Excludes sites.example.json explicitly.
  const overlayRe = /^sites\.[^.]+\.json$/;
  const overlays = entries
    .filter((name) => name !== "sites.example.json" && overlayRe.test(name))
    .sort();

  for (const name of overlays) {
    files.push(join(configDir, name));
  }

  return files;
}

// ── Single-file loading ────────────────────────────────────────────────────────

/** Loads the committed `sites.example.json` (placeholder data) with a warning; used when no real sites file exists. */
function loadFallback(configDir: string): CellMap {
  const example = join(configDir, "sites.example.json");
  console.warn(
    `[sites] No sites.json or sites.*.json found in "${configDir}"; ` +
      `using ${example} (placeholder data). Create sites.json for real runs.`,
  );
  return loadAndValidateFile(example);
}

/** Reads, JSON-parses, and validates one sites file into a {@link CellMap}, throwing an actionable error on read/parse/schema failure. */
function loadAndValidateFile(filePath: string): CellMap {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(`[sites] Cannot read "${filePath}".`, { cause });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`[sites] "${filePath}" is not valid JSON.`, { cause });
  }

  return validateCellMap(parsed, filePath);
}

// ── Merging ────────────────────────────────────────────────────────────────────

/**
 * Merges the per-file {@link CellMap}s (in load order) into one. A cell defined in two files is a
 * hard error naming both; edition consistency is re-checked across the merged set.
 */
function mergeCellMaps(
  loaded: { source: string; cells: CellMap }[],
  configDir: string,
): CellMap {
  const result: Record<string, CellConfig> = {};
  const cellSource: Record<string, string> = {};

  for (const { source, cells } of loaded) {
    for (const [cell, config] of Object.entries(cells)) {
      const prior = cellSource[cell];
      if (prior !== undefined) {
        throw new Error(
          `[sites] Cell "${cell}" is defined in both "${prior}" and "${source}". ` +
            "Each cell must appear in only one sites file.",
        );
      }
      result[cell] = config;
      cellSource[cell] = source;
    }
  }

  // Edition consistency must hold across the full merged set. The per-file
  // validateCellMap already catches within-file problems early; this catches
  // across-file problems (e.g. one file editionless, another edition-ful).
  const sourceList = loaded.map((l) => l.source).join(", ");
  checkEditionConsistency(
    result,
    `merged sites in "${configDir}" (${sourceList})`,
  );

  return result;
}

// ── Validation helpers ─────────────────────────────────────────────────────────

/**
 * A refused value as an error may describe it: its kind, and a text's length — never the text. A
 * sites file holds credentials, and a password written one field off (or a shifted line) would
 * otherwise be printed in a message that reaches terminals, CI logs and the orchestrator's log.
 *
 * @param value - the value read from the file.
 * @returns e.g. `a text of 8 characters`, `a number`, `null`.
 */
export function describeValue(value: unknown): string {
  if (typeof value === "string")
    return `a text of ${String(Array.from(value).length)} characters`;
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  if (typeof value === "object") return "an object";
  return typeof value === "boolean" ? String(value) : `a ${typeof value}`;
}

/**
 * Validates a site's WordPress login: a non-empty string without surrounding whitespace. It becomes
 * WP-CLI's `--user`, which looks the login up exactly, so `"admin "` would name nobody.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message (the value is never quoted, like every login field).
 * @returns the login.
 * @throws Error naming `path`.
 */
function requireLogin(value: unknown, path: string): string {
  const login = requireString(value, path);
  if (login !== login.trim()) {
    throw new Error(
      `[sites] ${path} must not start or end with whitespace: WP-CLI looks the login up exactly. ` +
        "Remove the spaces.",
    );
  }
  return login;
}

/** Returns `value` when it is a non-empty string; otherwise throws an error naming `path`. */
function requireString(value: unknown, path: string): string {
  if (!isNonEmptyString(value)) {
    throw new Error(`[sites] ${path} must be a non-empty string.`);
  }
  return value;
}

/** The most code points of a path a message quotes; longer ones are cut, marked `…`. */
const QUOTED_PATH_MAX = 200;

/**
 * A path as a message quotes it: JSON-quoted (so a control character shows escaped), cut to
 * {@link QUOTED_PATH_MAX} code points. A path is no secret, and the operator must be able to find it.
 *
 * @param path - the path, as read from the file.
 * @returns e.g. `"html/site"`, or `"html/…"…` when cut.
 */
export function quotePath(path: string): string {
  const points = Array.from(path);
  return points.length > QUOTED_PATH_MAX
    ? `${JSON.stringify(points.slice(0, QUOTED_PATH_MAX).join(""))}…`
    : JSON.stringify(path);
}

/**
 * Validates a WordPress root: a non-empty string, absolute on the site (`/…`). A relative one would be
 * resolved from wherever each command starts — over ssh the login's home, or a `CDPATH` entry — so
 * the pre-flight's checks and the commands they vouch for could each see a different folder.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message.
 * @returns the root.
 * @throws Error naming `path` and quoting the value ({@link quotePath}).
 */
function requireRootDir(value: unknown, path: string): string {
  const rootDir = requireString(value, path);
  if (!posix.isAbsolute(rootDir)) {
    throw new Error(
      `[sites] ${path} must be an absolute path on the site, starting with "/" ` +
        `(got ${quotePath(rootDir)}).`,
    );
  }
  return rootDir;
}

/** The fields every transport takes, whatever its mode. */
const COMMON_TRANSPORT_FIELDS = [
  "mode",
  "stagingDir",
  "elevate",
  "fileOwner",
] as const;

/**
 * The fields each mode takes: any other key is refused ({@link refuseUnknownFields}), so a misspelt
 * opt-out (`"runas": false`) fails the load instead of being dropped while the default applies.
 */
const TRANSPORT_FIELDS: Readonly<Record<ServerMode, readonly string[]>> = {
  ssh: [
    ...COMMON_TRANSPORT_FIELDS,
    "host",
    "port",
    "username",
    "privateKeyPath",
    "rootDir",
    "runAs",
    "umask",
  ],
  docker: [...COMMON_TRANSPORT_FIELDS, "container", "rootDir"],
  local: [...COMMON_TRANSPORT_FIELDS, "rootDir"],
};

/** The fields a site takes; `transport` and `overrides` are checked by their own validators. */
const SITE_FIELDS = [
  "baseURL",
  "username",
  "password",
  "transport",
  "overrides",
] as const;

/** The most unknown keys a message names; the rest are counted. */
const UNKNOWN_KEYS_SHOWN = 5;

/** The most code points of a key a message quotes; longer ones are cut, marked `…`. */
const QUOTED_KEY_MAX = 64;

/**
 * A key as a message quotes it: JSON-quoted with every character outside printable ASCII escaped
 * (`\uXXXX`, so a control or bidi character cannot rewrite the line), cut to {@link QUOTED_KEY_MAX}
 * code points. A key names a field, never a credential, and the operator must find it in the file.
 *
 * @param key - the key, as read from the file.
 * @returns e.g. `"runas"`, or `"\u202e…"`.
 */
export function quoteKey(key: string): string {
  const points = Array.from(key);
  const cut = points.slice(0, QUOTED_KEY_MAX).join("");
  const quoted = JSON.stringify(cut).replace(
    /[^\x20-\x7e]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return points.length > QUOTED_KEY_MAX ? `${quoted}…` : quoted;
}

/**
 * Refuses keys outside `allowed`, so a misspelt field fails the load instead of being dropped.
 *
 * @param value - the object read from the file.
 * @param allowed - the keys it may hold.
 * @param path - where it sits, for the message.
 * @param what - what it is, e.g. `a "ssh" transport`, for the message.
 * @throws Error naming `path`, the unknown keys ({@link quoteKey}, at most {@link UNKNOWN_KEYS_SHOWN})
 * and every allowed key.
 */
function refuseUnknownFields(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: string,
  what: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return;
  const shown = unknown.slice(0, UNKNOWN_KEYS_SHOWN).map(quoteKey).join(", ");
  const more =
    unknown.length > UNKNOWN_KEYS_SHOWN
      ? ` and ${String(unknown.length - UNKNOWN_KEYS_SHOWN)} more`
      : "";
  throw new Error(
    `[sites] ${path} has unknown field${unknown.length > 1 ? "s" : ""} ${shown}${more}: ` +
      `${what} takes only ${allowed.join(", ")}. Fix the spelling or remove ` +
      `${unknown.length > 1 ? "them" : "it"}.`,
  );
}

/**
 * Validates a site's `transport` block into a typed {@link Transport} (discriminated on `mode`). The
 * specific refusals (`wpUser`, an ssh-only field off ssh) come before the unknown-key one, which names
 * only what each mode takes.
 */
function validateTransport(value: unknown, path: string): Transport {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  refuseWpUser(value.wpUser, `${path}.wpUser`);
  const mode = value.mode;
  if (mode !== "ssh" && mode !== "docker" && mode !== "local") {
    throw new Error(
      `[sites] ${path}.mode must be "ssh" | "docker" | "local" (got ${describeValue(mode)}).`,
    );
  }
  if (mode !== "ssh") refuseSshOnly(value, path, mode);
  refuseUnknownFields(
    value,
    TRANSPORT_FIELDS[mode],
    path,
    `a "${mode}" transport`,
  );
  // Shared across all three modes; omitted from the result when absent so the optional
  // property is genuinely missing rather than present-and-undefined.
  const stagingDir = optionalString(value.stagingDir, `${path}.stagingDir`);
  const elevate = optionalBoolean(value.elevate, `${path}.elevate`);
  const fileOwner = optionalFileOwner(value.fileOwner, `${path}.fileOwner`);
  const base = {
    ...(stagingDir !== undefined ? { stagingDir } : {}),
    ...(elevate !== undefined ? { elevate } : {}),
    ...(fileOwner !== undefined ? { fileOwner } : {}),
  };
  switch (mode) {
    case "ssh": {
      const runAs = optionalRunAs(value.runAs, `${path}.runAs`);
      const umask = optionalUmask(value.umask, `${path}.umask`);
      const port = optionalPort(value.port, `${path}.port`);
      return {
        ...base,
        mode: "ssh",
        host: requireString(value.host, `${path}.host`),
        ...(port !== undefined ? { port } : {}),
        username: requireString(value.username, `${path}.username`),
        privateKeyPath: requireString(
          value.privateKeyPath,
          `${path}.privateKeyPath`,
        ),
        rootDir: requireRootDir(value.rootDir, `${path}.rootDir`),
        ...(runAs !== undefined ? { runAs } : {}),
        ...(umask !== undefined ? { umask } : {}),
      };
    }
    case "docker": {
      // Optional for docker: the container's WORKDIR is the WP root in the images we use.
      const rootDir =
        value.rootDir === undefined
          ? undefined
          : requireRootDir(value.rootDir, `${path}.rootDir`);
      return {
        ...base,
        mode: "docker",
        container: requireString(value.container, `${path}.container`),
        ...(rootDir !== undefined ? { rootDir } : {}),
      };
    }
    case "local":
      return {
        ...base,
        mode: "local",
        rootDir: requireRootDir(value.rootDir, `${path}.rootDir`),
      };
  }
}

/** Validates an optional string field; absent → `undefined`, present-but-wrong → throws. */
function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireString(value, path);
}

/** Validates an optional finite-number field. */
function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`[sites] ${path} must be a finite number.`);
  }
  return value;
}

/** Validates an optional boolean field. */
function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new Error(`[sites] ${path} must be a boolean.`);
  }
  return value;
}

/**
 * Validates an optional `fileOwner`: `"user:group"`, or `false` to opt out of ownership
 * normalisation entirely.
 *
 * **Both the type and the shape are checked here**, at the boundary, like every other site field.
 * The alternative — accepting any string and letting the WordPress layer reject the shape later —
 * fails in the worst way available: normalisation never fails a run, so a mistyped owner would be
 * warned about once and then silently ignored for the rest of the suite, on precisely the site
 * somebody was trying to fix. A config typo is not a host condition, and it is cheapest to fix
 * where it was written.
 *
 * `false` is the opt-out from a **privileged** `chown -R`, so dropping it would run as root on a
 * site whose owner explicitly forbade that. Anything else (a number, `true`, an object) is rejected
 * by name rather than coerced, exactly as `elevate` is.
 */
function optionalFileOwner(
  value: unknown,
  path: string,
): string | false | undefined {
  if (value === undefined || value === false) return value;
  if (!isNonEmptyString(value)) {
    throw new Error(
      `[sites] ${path} must be ${OWNER_SPEC_RULE}, or false to opt out — got ` +
        `${describeValue(value)}.`,
    );
  }
  // Throws with the same rule the ownership layer enforces, so the two can never disagree.
  parseOwnerSpec(value, `[sites] ${path}`);
  return value;
}

/**
 * Validates an optional `runAs` (ssh only): `"auto"`, `"user:group"` or `false`, through
 * {@link parseRunAs}.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message.
 * @returns the parsed value, or `undefined` when absent.
 * @throws Error naming `path` and the rule, describing a non-text by its kind.
 */
function optionalRunAs(value: unknown, path: string): RunAs | undefined {
  if (value === undefined || value === false) return value;
  if (typeof value !== "string") {
    throw new Error(
      `[sites] ${path} must be ${RUN_AS_RULE} — got ${describeValue(value)}.`,
    );
  }
  return parseRunAs(value, path);
}

/**
 * Validates an optional `umask` (ssh only) through {@link parseUmask}.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message.
 * @returns the umask as four digits, or `undefined` when absent.
 * @throws Error naming `path` and the rule, describing a non-text by its kind.
 */
function optionalUmask(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new Error(
      `[sites] ${path} must be ${UMASK_RULE} — got ${describeValue(value)}.`,
    );
  }
  return parseUmask(value, path);
}

/** The port an ssh site without `port` is reached on (node-ssh's default too). */
const SSH_DEFAULT_PORT = 22;

/**
 * Validates an optional `port` (ssh only): a whole number from 1 to 65535. A port in a text, a
 * fraction or one out of range is refused rather than coerced: node-ssh would otherwise connect to
 * whatever it made of it.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message.
 * @returns the port, or `undefined` when absent or 22 (the default, so both key one connection).
 * @throws Error naming `path`, describing the refused value by its kind.
 */
function optionalPort(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > 65535
  ) {
    throw new Error(
      `[sites] ${path} must be a whole number from 1 to 65535 — got ` +
        `${typeof value === "number" ? String(value) : describeValue(value)}.`,
    );
  }
  // 22 is what an absent port means: one site, one connection key, however it is written.
  return value === SSH_DEFAULT_PORT ? undefined : value;
}

/**
 * The transport fields only `ssh` takes: who commands run as (`runAs`, `umask`) and where the server
 * listens (`port`). `docker` and `local` have neither a second identity nor a server to reach.
 */
const SSH_ONLY_FIELDS = ["port", "runAs", "umask"] as const;

/**
 * Refuses an `ssh`-only field on a `docker` or `local` transport rather than dropping it, so an
 * operator never believes a site runs as an identity, or is reached on a port, it is not.
 *
 * @param transport - the transport object read from the file.
 * @param path - the transport's path, for the message.
 * @param mode - its mode, named in the message.
 * @throws Error naming the field and the mode.
 */
function refuseSshOnly(
  transport: Readonly<Record<string, unknown>>,
  path: string,
  mode: "docker" | "local",
): void {
  for (const field of SSH_ONLY_FIELDS) {
    if (transport[field] !== undefined) {
      throw new Error(
        `[sites] ${path}.${field} applies to "ssh" transports only, and this one is "${mode}", ` +
          "which would ignore it. Remove the field.",
      );
    }
  }
}

/**
 * Refuses `wpUser` in a sites file: it is filled from the site's `username` at load, so a declared one
 * could only disagree with the login the suite uses.
 *
 * @param value - the value read from the file.
 * @param path - where it sits, for the message.
 * @throws Error naming `path` when the field is present, whatever its value.
 */
function refuseWpUser(value: unknown, path: string): void {
  if (value !== undefined) {
    throw new Error(
      `[sites] ${path} is not a sites-file field: it is filled from the site's "username". ` +
        "Remove it.",
    );
  }
}

/** Validates a partial FTP override (every field optional; absent keys are omitted, not set to undefined). */
function validateFtpOverride(
  value: unknown,
  path: string,
): Partial<FtpServiceConfig> {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  const host = optionalString(value.host, `${path}.host`);
  const username = optionalString(value.username, `${path}.username`);
  const password = optionalString(value.password, `${path}.password`);
  const port = optionalNumber(value.port, `${path}.port`);
  const secure = optionalBoolean(value.secure, `${path}.secure`);
  return {
    ...(host !== undefined ? { host } : {}),
    ...(username !== undefined ? { username } : {}),
    ...(password !== undefined ? { password } : {}),
    ...(port !== undefined ? { port } : {}),
    ...(secure !== undefined ? { secure } : {}),
  };
}

/** Validates a partial S3 override (every field optional; absent keys are omitted, not set to undefined). */
function validateS3Override(
  value: unknown,
  path: string,
): Partial<S3ServiceConfig> {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  const accessKeyId = optionalString(value.accessKeyId, `${path}.accessKeyId`);
  const secretAccessKey = optionalString(
    value.secretAccessKey,
    `${path}.secretAccessKey`,
  );
  const bucket = optionalString(value.bucket, `${path}.bucket`);
  const region = optionalString(value.region, `${path}.region`);
  return {
    ...(accessKeyId !== undefined ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
    ...(bucket !== undefined ? { bucket } : {}),
    ...(region !== undefined ? { region } : {}),
  };
}

/** Validates a site's `overrides` into a typed {@link ServiceOverrides}; every part is optional. */
function validateOverrides(value: unknown, path: string): ServiceOverrides {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  if (value.storage === undefined) return {};
  if (!isObject(value.storage)) {
    throw new Error(`[sites] ${path}.storage must be an object.`);
  }
  const ftp =
    value.storage.ftp === undefined
      ? undefined
      : validateFtpOverride(value.storage.ftp, `${path}.storage.ftp`);
  const s3 =
    value.storage.s3 === undefined
      ? undefined
      : validateS3Override(value.storage.s3, `${path}.storage.s3`);
  return {
    storage: {
      ...(ftp !== undefined ? { ftp } : {}),
      ...(s3 !== undefined ? { s3 } : {}),
    },
  };
}

/**
 * Validates one entry into a {@link SiteInput}: its required fields plus an optional `overrides` block;
 * any other key is refused. The transport gets `wpUser` from `username`, the WordPress login WP-CLI
 * acts as.
 */
function validateSite(value: unknown, path: string): SiteInput {
  if (!isObject(value)) throw new Error(`[sites] ${path} must be an object.`);
  refuseUnknownFields(value, SITE_FIELDS, path, "a site");
  const baseURL = requireString(value.baseURL, `${path}.baseURL`);
  const username = requireLogin(value.username, `${path}.username`);
  const base = {
    baseURL,
    username,
    password: requireString(value.password, `${path}.password`),
    transport: {
      ...validateTransport(value.transport, `${path}.transport`),
      wpUser: username,
    },
  };
  if (value.overrides === undefined) return base;
  return {
    ...base,
    overrides: validateOverrides(value.overrides, `${path}.overrides`),
  };
}

/** Validates an optional `edition` value; absent → `undefined`, unknown value → throws. */
function validateEdition(value: unknown, path: string): Edition | undefined {
  if (value === undefined || value === "free" || value === "pro") return value;
  throw new Error(
    `[sites] ${path} must be "free" | "pro" (got ${describeValue(value)}).`,
  );
}

/** Validates a site array into a pool, naming each offending index. */
function validatePool(value: unknown[], path: string): SiteInput[] {
  return value.map((site, index) =>
    validateSite(site, `${path}[${String(index)}]`),
  );
}

/**
 * Validates one cell entry into a {@link CellConfig}. A cell may be a bare site array
 * (editionless) or an object `{ edition?, sites }` (edition-ful, e.g. BackWPup).
 */
function validateCell(value: unknown, path: string): CellConfig {
  if (Array.isArray(value)) {
    return { sites: validatePool(value, path) };
  }
  if (!isObject(value)) {
    throw new Error(
      `[sites] ${path} must be a site array or an object { edition?, sites }.`,
    );
  }
  if (!Array.isArray(value.sites)) {
    throw new Error(`[sites] ${path}.sites must be an array of sites.`);
  }
  const edition = validateEdition(value.edition, `${path}.edition`);
  const sites = validatePool(value.sites, `${path}.sites`);
  return edition === undefined ? { sites } : { edition, sites };
}

/**
 * Editions are all-or-none across a set of cells: if any cell declares one, every cell
 * must. This is checked per-file (to surface problems early) and again on the merged
 * result (to catch cross-file inconsistencies).
 */
function checkEditionConsistency(
  cells: Record<string, CellConfig>,
  label: string,
): void {
  const entries = Object.entries(cells);
  const missing = entries
    .filter(([, cellConfig]) => cellConfig.edition === undefined)
    .map(([cell]) => cell);
  if (missing.length > 0 && missing.length !== entries.length) {
    throw new Error(
      `[sites] ${label}: editions are all-or-none across cells; ` +
        `these cells declare none: ${missing.join(", ")}.`,
    );
  }
}

/**
 * What a cell may be named. A cell names folders (`<OUTPUT_ROOT>/<product>/<cell>`, its reports,
 * logins, generated specs and zips) and Playwright projects (`<cell>`, `setup:<cell>`,
 * `artifacts:<cell>`). So: one path segment; lowercase, because `--project` ignores case and
 * would select two cells differing in case alone together; and no leading `_`, kept for the
 * suite's own folders (`_all`, `_unit`).
 */
const CELL_NAME = /^[a-z0-9][a-z0-9@._-]*$/;

/** Throws, naming the file and the rule, unless `cell` is a name {@link CELL_NAME} allows. */
function validateCellName(cell: string, source: string): void {
  if (!CELL_NAME.test(cell)) {
    throw new Error(
      `[sites] ${source}: cell name ${JSON.stringify(cell)} must start with a lowercase ` +
        'letter or digit and hold only lowercase letters, digits, "@", ".", "_" and "-": it ' +
        "names folders and Playwright projects.",
    );
  }
}

/**
 * Validates the parsed JSON of one file into a {@link CellMap}. Checks edition
 * consistency within the file; cross-file consistency is checked after merging.
 */
function validateCellMap(value: unknown, source: string): CellMap {
  if (!isObject(value)) {
    throw new Error(
      `[sites] ${source} must be a JSON object mapping cell → sites.`,
    );
  }
  const result: Record<string, CellConfig> = {};
  for (const [cell, raw] of Object.entries(value)) {
    validateCellName(cell, source);
    result[cell] = validateCell(raw, `${source} → ${cell}`);
  }
  checkEditionConsistency(result, source);
  return result;
}
