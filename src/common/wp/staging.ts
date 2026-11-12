import { statSync } from "node:fs";
import { basename, isAbsolute, posix } from "node:path";

import { env } from "../config/env";
import { errorMessage } from "../guards";
import {
  assertResolvedInsideRoot,
  copyIntoTarget,
  describeTarget,
  elevationSupport,
  exec,
  execAsTransport,
  execElevated,
  wpRootDir,
} from "./exec";
import { normalizeOwnership } from "./ownership";
import { isPathSegment, pluginSitePath } from "./paths";
import { installPlugin } from "./plugin";
import { resolveSiteIdentity } from "./site-identity";
import {
  DEFAULT_INBOX_ROOT,
  siteStagingOps,
  stageThroughInbox,
  sweepStaleInboxes,
} from "./site-staging";
import type { InstallPluginOptions } from "./plugin";
import type { Transport } from "../config/types";

/**
 * Per-site staging area: getting a file from the runner onto the site under test.
 *
 * WP-CLI runs **on the site**, so every command that reads a file — `wp plugin install`,
 * `wp import`, `wp db import`, an mu-plugin drop — needs that file on the site's filesystem.
 * Only a `local` transport shares one with the runner; for `ssh`/`docker` a resolved zip path
 * is meaningless to the remote `wp`. This module closes that gap with one directory per site:
 *
 * ```text
 * <WP root>/.e2e_temp/            ← lives on the SITE, not in the repo
 * ├── plugins/<name>.zip          → wp plugin install
 * ├── imports/<name>.xml          → wp import        (future)
 * └── <category>/<name>           → any artifact a test needs on the target
 * ```
 *
 * It sits at the WordPress root because that is the working directory the exec layer already
 * uses on every transport, and it is **deliberately generic**: `plugins/` is only the first
 * category, so a future artifact type reuses the same transfer and cleanup instead of growing
 * its own path. The location is overridable per site (`transport.stagingDir`) or globally
 * (`E2E_SITE_STAGING_DIR`) for hosts where the transport's user cannot write the WordPress root,
 * or to keep staged files out of the web docroot.
 *
 * Staging is **idempotent** — the copy overwrites, so residue from a crashed run is replaced
 * before it can be used. {@link cleanSiteStaging} removes the area; wire it into worker teardown
 * (beside `disposeConnections`) as best-effort cleanup, so a cleanup failure never fails a
 * passing scenario.
 *
 * **Who writes the area follows who site commands run as.** Every state but `site` runs them as the
 * transport's user, which creates the area and copies into it directly; staged files keep its
 * ownership, since only it reads them (`wp plugin install` runs as it). What the install *unpacks* is
 * a different matter, and that is what {@link stageAndInstallPlugin} normalises (see
 * `./ownership.ts`). In the `site` state (ssh, commands as the web server's identity) the area is the
 * identity's: SFTP still writes as the login, so the file goes through a private inbox in `/tmp` and
 * the identity copies it in and checks its SHA-256; the site's own area made by another user is removed
 * and made again, while under an absolute root (which other sites may share) it is refused, never
 * removed (`./site-staging.ts`). {@link cleanSiteStaging} of the whole area also sweeps the login's
 * inboxes a killed run left.
 */

/** Staging directory name under the WordPress root, when nothing overrides it. */
export const DEFAULT_STAGING_DIR = ".e2e_temp";

/** Global staging-root override; a site's own `transport.stagingDir` wins over it. */
const STAGING_DIR_ENV = "E2E_SITE_STAGING_DIR";

/** Category for plugin zips — the first and, for now, only one in use. */
export const PLUGINS_CATEGORY = "plugins";

/** Options for {@link stageArtifact}. */
export interface StageArtifactOptions {
  /**
   * Subdirectory of the staging area that groups this kind of artifact (`"plugins"`,
   * `"imports"`, …). A single path segment, so an artifact can never land outside the area.
   */
  readonly category: string;
  /** Filename to use on the target. Defaults to the source file's basename. */
  readonly as?: string;
  /**
   * In the `site` state, the folder the upload inbox is made in (`/tmp` by default); specs point it at
   * a folder of their own. Ignored in every other state.
   */
  readonly inboxRoot?: string;
}

/**
 * Joins a staging root with path segments, POSIX-style — targets are always POSIX, including
 * for `local` on macOS/Linux, so the same builder serves every transport.
 *
 * Pure, and the one place segments are validated: each must be a single, non-empty path segment,
 * which is what keeps a caller-supplied category or filename inside the staging area.
 *
 * @param root - the staging root (absolute, or relative to the WordPress root).
 * @param segments - category and/or filename, in order.
 * @throws Error naming the offending segment when it is empty, contains a separator, or is `.`/`..`.
 */
export function stagingPath(root: string, ...segments: string[]): string {
  for (const segment of segments) {
    assertSegment(segment);
  }
  return posix.join(root, ...segments);
}

/** @throws Error unless `segment` is a single, non-empty, non-traversing path segment. */
function assertSegment(segment: string): void {
  if (!isPathSegment(segment)) {
    throw new Error(
      `[wp/staging] "${segment}" is not a valid staging path segment: it must be a single ` +
        'non-empty name, without "/" or "\\", and not "." or "..".',
    );
  }
}

/**
 * The staging root as configured, which may be relative to the WordPress root. Precedence:
 * the site's own `transport.stagingDir`, then `E2E_SITE_STAGING_DIR`, then
 * {@link DEFAULT_STAGING_DIR}. A site-level declaration wins because it is the specific
 * statement — typically "this host's docroot is not writable" — and a global default must not
 * override it.
 */
export function configuredStagingDir(transport: Transport): string {
  return transport.stagingDir ?? env(STAGING_DIR_ENV, DEFAULT_STAGING_DIR);
}

/**
 * The absolute staging directory on the target: the configured root when it is already absolute,
 * otherwise resolved against the site's WordPress root. Absolute throughout, because the copy
 * primitives ignore the exec working directory — a relative target would land in the SSH user's
 * home directory instead of the site.
 *
 * The WordPress root is resolved even for an absolute override, so the safety check below can
 * compare the two (one cached `pwd` at most, per docker container).
 *
 * @throws Error if the WordPress root cannot be resolved or is not absolute, or if the resolved
 * staging directory is one cleanup must never delete (see {@link assertSafeStagingRoot}).
 */
export async function siteStagingDir(transport: Transport): Promise<string> {
  const configured = configuredStagingDir(transport);
  const wpRoot = trimTrailingSlash(await wpRootDir(transport));
  if (!posix.isAbsolute(wpRoot)) {
    throw new Error(
      `[wp/staging] this ${transport.mode} site's WordPress root ("${wpRoot}") is not an ` +
        "absolute path. Staging copies a file by absolute path (the exec working directory does " +
        "not apply), so `rootDir` must be absolute.",
    );
  }
  const dir = trimTrailingSlash(
    posix.isAbsolute(configured)
      ? posix.normalize(configured)
      : posix.join(wpRoot, configured),
  );
  assertSafeStagingRoot(dir, wpRoot, configured);
  return dir;
}

/** Drops trailing slashes, keeping a bare `"/"` intact, so paths compare and join cleanly. */
function trimTrailingSlash(path: string): string {
  return path.replace(/(?!^)\/+$/, "");
}

/**
 * Rejects a staging root that {@link cleanSiteStaging} must never be pointed at — it `rm -rf`s
 * the whole directory, so an over-broad root deletes the site (or worse) instead of scratch files.
 * Three ways that can happen, all rejected here:
 *
 *  - a **relative** value that resolves to the WordPress root (`"."`) or escapes it (`"../x"`) —
 *    including via a normalising path like `"wp-content/.."`;
 *  - a root with fewer than two path segments (`"/"`, `"/var"`) — a top-level system directory is
 *    never a staging area, and requiring one more segment costs an operator nothing;
 *  - the WordPress root itself or **any ancestor of it**, however it was spelled — the case a
 *    relative-only check misses, e.g. an absolute `E2E_SITE_STAGING_DIR` that happens to equal
 *    `rootDir`, which would delete the entire WordPress install.
 *
 * Staging outside the WordPress root stays supported; it must simply be written as an absolute
 * path, where the intent is unambiguous.
 *
 * @param dir - the resolved, absolute staging directory.
 * @param wpRoot - the site's resolved, absolute WordPress root.
 * @param configured - the raw configured value, quoted back in the error.
 * @throws Error naming the value, the reason, and the safe way to express it.
 */
function assertSafeStagingRoot(
  dir: string,
  wpRoot: string,
  configured: string,
): void {
  // `normalize` keeps a trailing slash ("./" stays "./"), so trim before comparing — otherwise
  // "./" reads as a subdirectory while resolving to the WordPress root itself.
  const relative = posix.isAbsolute(configured)
    ? undefined
    : trimTrailingSlash(posix.normalize(configured));
  const segments = dir.split("/").filter((part) => part !== "").length;

  let reason: string | undefined;
  if (
    relative === "." ||
    relative === ".." ||
    relative?.startsWith("../") === true
  ) {
    reason =
      "as a relative path it resolves to the WordPress root itself, or outside it — " +
      "use a subdirectory name, or an absolute path if you mean somewhere else";
  } else if (segments < 2) {
    reason = `it resolves to "${dir}", a filesystem or top-level system directory`;
  } else if (dir === wpRoot || wpRoot.startsWith(`${dir}/`)) {
    reason = `it resolves to "${dir}", which is the WordPress root ("${wpRoot}") or a parent of it`;
  }

  if (reason !== undefined) {
    throw new Error(
      `[wp/staging] "${configured}" is not a usable staging directory: ${reason}. The staging ` +
        "area is removed whole during cleanup, so it must be a dedicated directory. Set " +
        `${STAGING_DIR_ENV} (or the site's \`transport.stagingDir\`) accordingly.`,
    );
  }
}

/**
 * Copies a local file into the site's staging area and returns its **absolute path on the
 * target** — the value to hand to WP-CLI (e.g. `wp plugin install <that path>`).
 *
 * Creates the category directory first (`mkdir -p` through the exec layer, so it works
 * identically on every transport) and overwrites any file already staged under that name, which
 * makes repeated staging — and a crashed run's leftovers — harmless.
 *
 * **`localPath` must be readable by the user WP-CLI runs as on the target.** The copy is verbatim:
 * `docker cp` preserves the host mode *and* numeric owner (meaningless inside a container), and a
 * `local` copy preserves the mode, so an owner-only file reaches the site unreadable and `wp` fails
 * with an opaque archive error. Callers own the source's mode — the artifacts resolver normalises
 * the zips it produces for exactly this reason.
 *
 * @param transport - the target site's transport.
 * @param localPath - absolute path to the file on the runner (e.g. `pluginArtifact("plugin").zipPath`).
 * @param options - the {@link StageArtifactOptions} category and optional target filename.
 * @returns the absolute path of the staged file on the target.
 * @throws Error if `localPath` is not an absolute path to an existing file, if the staging
 * directory cannot be created (the message names the override to set), or if the copy fails.
 *
 * @example
 * ```ts
 * const zip = await stageArtifact(site.transport, pluginArtifact("plugin").zipPath, {
 *   category: PLUGINS_CATEGORY,
 * });
 * await installPlugin(site.transport, zip, { activate: true });
 * ```
 */
export async function stageArtifact(
  transport: Transport,
  localPath: string,
  options: StageArtifactOptions,
): Promise<string> {
  assertLocalFile(localPath);
  // Runner-side path ⇒ platform basename; everything below is a POSIX target path.
  const filename = options.as ?? basename(localPath);

  const root = await siteStagingDir(transport);
  const categoryDir = stagingPath(root, options.category);
  const target = stagingPath(root, options.category, filename);

  const shared = posix.isAbsolute(configuredStagingDir(transport));
  if (transport.mode === "ssh" && (await runsAsSiteIdentity(transport))) {
    await stageThroughInbox(siteStagingOps(transport), {
      localPath,
      target,
      categoryDir,
      // Only the site's own area is ever healed: an absolute root may hold other sites' files.
      healDir: shared ? undefined : root,
      inboxRoot: options.inboxRoot ?? DEFAULT_INBOX_ROOT,
      pid: process.pid,
      site: describeTarget(transport),
    });
    return target;
  }
  await mkdirOnTarget(transport, categoryDir);
  await copyIntoTarget(transport, localPath, target).catch((cause: unknown) => {
    if (!shared) throw cause;
    // The likeliest cause there: a site whose commands run as its identity made the category first.
    throw new Error(
      `${errorMessage(cause)} The staging root "${root}" is absolute, so other sites may share it ` +
        "and own what is in it; give each site its own (the site's `transport.stagingDir`).",
      { cause },
    );
  });
  return target;
}

/**
 * Whether site commands run as the site's identity: ssh in the `site` state. Docker and local are
 * never asked, so nothing they send changes.
 *
 * @param transport - the site's transport.
 * @throws Error if the state could not be resolved (a probe's transport failed).
 */
async function runsAsSiteIdentity(transport: Transport): Promise<boolean> {
  return (
    transport.mode === "ssh" &&
    (await resolveSiteIdentity(transport)).kind === "site"
  );
}

/**
 * Removes the site's staging area, or one path inside it — a category, or a single entry within
 * one. Idempotent: removing what was never created succeeds.
 *
 * A caller should remove no more than it put there: a staging root declared as an absolute path can
 * be shared by the sites on one host, so a category can hold another run's files too.
 *
 * In the `site` state, removing the whole area also removes the transport user's upload inboxes over
 * an hour old (what a killed run left; `./site-staging.ts`).
 *
 * Throws on a genuine failure so a site left dirty is visible. A caller wiring this into a
 * teardown hook should treat it as **best-effort** (catch and log), so cleanup can never turn a
 * passing scenario red.
 *
 * @param transport - the target site's transport.
 * @param path - the category, then any entries below it, one segment each; omit to remove the whole
 * area. Each is validated as {@link stagingPath} validates it, so nothing outside the area is named.
 * @throws Error naming the path when the removal fails, if a segment is not a single safe name, or
 * when a removal needing root would follow a symbolic link out of the area (see
 * {@link assertConfinedRemoval}).
 */
export async function cleanSiteStaging(
  transport: Transport,
  ...path: string[]
): Promise<void> {
  const root = await siteStagingDir(transport);
  const target = stagingPath(root, ...path);

  const first = await exec(transport, "rm", ["-rf", target]);
  // The area holds files this suite put there, so the transport's user normally owns them. A plugin
  // that unpacks into it as the web-server user is the exception, and escalating is what keeps that
  // from stranding the whole area — the same policy residue removal uses.
  const elevate =
    first.exitCode !== 0 && (await elevationSupport(transport)) === "available";
  if (elevate) await assertConfinedRemoval(transport, target, root);
  const { exitCode, stderr, stdout } = elevate
    ? await execElevated(transport, "rm", ["-rf", target])
    : first;
  if (exitCode !== 0) {
    throw new Error(
      `[wp/staging] could not remove "${target}" on this ${transport.mode} site ` +
        `(exit ${String(exitCode)}): ${(stderr || stdout).trim() || "no output"}`,
    );
  }
  // Inboxes exist only in the `site` state; a per-entry removal stays as narrow as it was asked.
  if (
    path.length === 0 &&
    transport.mode === "ssh" &&
    (await runsAsSiteIdentity(transport))
  ) {
    await sweepStaleInboxes(transport);
  }
}

/**
 * Refuses a root `rm -rf` of `target` that a symbolic link would carry out of the staging area: root
 * follows a linked parent wherever it leads, e.g. into another site's `wp-content`.
 *
 * A root relative to the WordPress root must resolve inside it (the residue removal's own check). An
 * absolute root may live anywhere, so it must not itself be a link, and `target` must resolve inside
 * it. Checked just before the removal; a link swapped in between is not seen.
 *
 * @param transport - the target site's transport.
 * @param target - the absolute path about to be removed as root.
 * @param root - the resolved staging root (see {@link siteStagingDir}).
 * @throws Error naming the path and the link's way out, or when it cannot be resolved.
 */
async function assertConfinedRemoval(
  transport: Transport,
  target: string,
  root: string,
): Promise<void> {
  const absolute = posix.isAbsolute(configuredStagingDir(transport));
  const anchor = absolute
    ? root
    : trimTrailingSlash(await wpRootDir(transport));
  const describe = (reason: string): string =>
    `[wp/staging] refusing to remove "${target}" as root on this ${transport.mode} site: it must ` +
    `stay inside "${anchor}", and ${reason}. Remove the link, or set ${STAGING_DIR_ENV} (or the ` +
    "site's `transport.stagingDir`) to a directory of the site's own.";
  if (
    absolute &&
    (await execAsTransport(transport, "test", ["-L", root])).exitCode === 0
  ) {
    throw new Error(
      describe(`the staging root "${root}" is itself a symbolic link`),
    );
  }
  await assertResolvedInsideRoot(transport, target, anchor, describe);
}

/**
 * Stages a plugin zip and installs it from the staged copy — the transport-agnostic way to
 * install a locally-resolved artifact, since only a `local` site's `wp` can read a runner path.
 *
 * **Pass `slug` whenever you know it.** WP-CLI unpacks the zip as the *transport's* user, so on a
 * real cell the plugin's files land owned by someone the web server is not, and its very next admin
 * request cannot write them. With `slug`, the unpacked directory is handed back to the ownership the
 * site itself uses ({@link normalizeOwnership}); without it, nothing can be — the zip's contents are
 * not inspected, so this has no other way to learn where the files went. Normalisation is
 * best-effort by construction and never fails the install.
 *
 * @param transport - the target site's transport.
 * @param localZip - absolute path to the zip on the runner.
 * @param options - {@link InstallPluginOptions} (`activate`, `force`), an optional target filename
 * (`as`), and the installed plugin's `slug` — the directory it unpacks to, which the resolved
 * artifact already knows.
 * @returns the absolute path of the staged zip on the target (for later assertions or cleanup).
 * @throws Error if `slug` is not a single path segment (checked before anything is copied), or if
 * staging or the install fails. Ownership normalisation never throws — it reports and returns.
 *
 * @example
 * ```ts
 * await stageAndInstallPlugin(site.transport, artifact.zipPath, {
 *   activate: true,
 *   slug: artifact.slug,
 * });
 * ```
 */
export async function stageAndInstallPlugin(
  transport: Transport,
  localZip: string,
  options: InstallPluginOptions & {
    readonly as?: string;
    readonly slug?: string;
  } = {},
): Promise<string> {
  const { as, slug, ...installOptions } = options;
  // Resolved up front: an unusable slug is a mistake in our own code, and failing on it before
  // anything is copied or installed is better than aborting a scenario with the plugin half in place.
  const pluginPath = slug === undefined ? undefined : pluginSitePath(slug);

  const staged = await stageArtifact(transport, localZip, {
    category: PLUGINS_CATEGORY,
    ...(as !== undefined ? { as } : {}),
  });
  await installPlugin(transport, staged, installOptions);
  if (pluginPath !== undefined) {
    await normalizeOwnership(transport, pluginPath);
  }
  return staged;
}

/**
 * Creates a directory (and parents) on the target, in every state but `site` (which ensures its
 * directory through `./site-staging.ts`). A non-zero exit here is almost always a permission problem
 * at the WordPress root, so the error names the override that fixes it instead of leaving the
 * operator with a bare `mkdir` failure.
 *
 * **Deliberately not elevated**, unlike the removal above. A privileged `mkdir` would leave the
 * directory owned by root, and the copy that follows runs as the transport's user over SFTP — so
 * escalating here would trade a clear "cannot create it" for an opaque "cannot write into it", and
 * only chown-ing it back would help. The staging area is this suite's own directory and its location
 * is configurable, so pointing it somewhere writable is the honest fix.
 */
async function mkdirOnTarget(transport: Transport, dir: string): Promise<void> {
  const { exitCode, stderr, stdout } = await exec(transport, "mkdir", [
    "-p",
    dir,
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `[wp/staging] could not create the staging directory "${dir}" on this ${transport.mode} ` +
        `site (exit ${String(exitCode)}): ${(stderr || stdout).trim() || "no output"}. ` +
        `If the transport's user cannot write there, set ${STAGING_DIR_ENV} (or the site's ` +
        "`transport.stagingDir`) to a writable directory.",
    );
  }
}

/**
 * @throws Error unless `path` is an absolute path to an existing file on the runner. Checked up
 * front so a missing or relative source is reported as such, rather than surfacing as an opaque
 * transfer failure — and absolute is required because a relative path would resolve against the
 * process CWD, which the artifacts layer deliberately never relies on.
 */
function assertLocalFile(path: string): void {
  if (!isAbsolute(path)) {
    throw new Error(
      `[wp/staging] "${path}" must be an absolute path on the runner. ` +
        "A resolved artifact's `zipPath` already is one.",
    );
  }
  let isFile: boolean;
  try {
    isFile = statSync(path).isFile();
  } catch (error) {
    throw new Error(
      `[wp/staging] cannot stage "${path}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
  if (!isFile) {
    throw new Error(
      `[wp/staging] "${path}" is not a file, so there is nothing to stage.`,
    );
  }
}
