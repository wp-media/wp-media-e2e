import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import { sha256File } from "../artifacts/digest";
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
import { fileChecksum } from "./files";
import type { ExecResult } from "./exec";
import type { SshTransport } from "../config/types";

/**
 * Staging a runner file on a site whose commands run as the site's identity (the `site` state): the
 * transport's user uploads it, the identity copies it into place.
 *
 * SFTP always writes as the SSH login, which in that state can no longer write the staging area: it
 * belongs to the web server's user, and the login is often outside its group. So the upload lands in
 * an **inbox** of the login's own — `<inbox root>/e2e-inbox-<runner pid>-<16 hex>`, made `0711` with
 * no `-p`, so a path that already exists (a planted symlink included) fails instead of being written
 * through, and nobody but the login can list or write it — and the file is made `0644` so the
 * identity can read it by name. The identity then ensures the staging directory, copies the file in,
 * and its SHA-256 on the site is compared with the runner's. The inbox is removed as the login in
 * `finally`, whichever step failed; one a killed run left behind is swept by
 * {@link sweepStaleInboxes} once it is an hour old.
 *
 * A staging directory that exists but the identity cannot write (made by the transport's user in a
 * run that fell back, or by an older run) is removed and made again when it is the site's own area,
 * and refused under an absolute root, which other sites may share ({@link ensureSiteStagingDir}).
 * Every remote step goes through {@link SiteStagingOps}, so the order and the cleanup are testable
 * without a site.
 */

/** Where inboxes are made unless told otherwise: world-writable and sticky on every POSIX host. */
export const DEFAULT_INBOX_ROOT = "/tmp";

/** Every inbox's name starts with this; the sweep matches nothing else. */
export const INBOX_PREFIX = "e2e-inbox-";

/** How old, in minutes, an inbox must be before {@link sweepStaleInboxes} removes it. */
export const INBOX_MAX_AGE_MINUTES = 60;

/** The uploaded file's name inside its inbox: constant, so no caller-chosen name reaches a path. */
const INBOX_FILE = "upload";

/** The two settings that move the staging area, as an error names them. */
const OVERRIDE_HINT =
  "E2E_SITE_STAGING_DIR or the site's `transport.stagingDir`";

/**
 * As the identity, one round trip: exit {@link NOT_WRITABLE} when the area `$2` or the category `$1`
 * exists as a directory the identity cannot write and enter (another user made it); otherwise create
 * `$1` (and parents) and succeed only if the identity can write and enter it, any other failure (a
 * full disk, a parent it cannot write) exiting non-zero but never {@link NOT_WRITABLE}. Paths are
 * arguments, never part of the script.
 */
const ENSURE_WRITABLE_SCRIPT =
  'for d in "$2" "$1"; do ' +
  'if [ -d "$d" ] && ! { [ -w "$d" ] && [ -x "$d" ]; }; then exit 3; fi; ' +
  'done; mkdir -p -- "$1" && test -w "$1" -a -x "$1"';

/** {@link ENSURE_WRITABLE_SCRIPT}'s exit for "it exists, and another user's": the only one healed. */
const NOT_WRITABLE = 3;

/**
 * As the transport's user: remove its own inboxes in `$1` older than `$2` minutes. Only directories
 * (a symlink below `$1` is not followed: `find` without `-L`), only the login's (`id -u`: in a sticky folder no
 * other user's could be removed anyway), only the inbox prefix, never below the first level.
 */
const SWEEP_SCRIPT =
  // `-H` follows `$1` itself when it is a link (macOS's `/tmp`), and nothing below it.
  `find -H "$1" -mindepth 1 -maxdepth 1 -type d -name '${INBOX_PREFIX}*' ` +
  `-user "$(id -u)" -mmin +"$2" -exec rm -rf -- {} +`;

/** `$0` of the two `sh -c` scripts: what `ps` shows, never a path. */
const SCRIPT_NAME = "e2e-staging";

/** The remote and local operations staging through an inbox is made of. */
export interface SiteStagingOps {
  /** Runs a program as the transport's own user. */
  asTransport(file: string, args: string[]): Promise<ExecResult>;
  /** Runs a program as the site's identity. */
  asSite(file: string, args: string[]): Promise<ExecResult>;
  /** Runs a program as root, or answers `undefined` when this site cannot elevate. */
  asRoot(file: string, args: string[]): Promise<ExecResult | undefined>;
  /**
   * Throws unless `path`, every symbolic link on it resolved, stays inside the site's WordPress root:
   * asked before a removal, which would otherwise follow a linked parent out of the site.
   */
  confineToSite(path: string): Promise<void>;
  /** Uploads a runner file to an absolute path on the site, as the transport's user (SFTP). */
  upload(localPath: string, remotePath: string): Promise<void>;
  /** A site file's SHA-256, read as the identity. */
  siteChecksum(path: string): Promise<string>;
  /** A runner file's SHA-256. */
  runnerChecksum(path: string): Promise<string>;
  /** 16 random hex characters, for an inbox's name. */
  randomHex(): string;
  /** Reports something worth knowing that does not fail the staging. */
  warn(message: string): void;
}

/** What {@link stageThroughInbox} copies, and where. */
export interface InboxStagingRequest {
  /** The file on the runner (absolute). */
  readonly localPath: string;
  /** Its absolute destination on the site, inside {@link categoryDir}. */
  readonly target: string;
  /** The staging category directory the target sits in. */
  readonly categoryDir: string;
  /**
   * The site's own staging area (a root relative to its WordPress root), removed and made again when
   * it or {@link categoryDir} exists but the identity cannot write it. `undefined` under an absolute
   * root: other sites on the host may share it (`E2E_SITE_STAGING_DIR` applies to every site), so a
   * directory there the identity cannot write is refused, never removed.
   */
  readonly healDir: string | undefined;
  /** The folder inboxes are made in ({@link DEFAULT_INBOX_ROOT} on a real site). */
  readonly inboxRoot: string;
  /** The runner's pid, part of the inbox's name so a sweep's victim can be told apart by eye. */
  readonly pid: number;
  /** How the site is named in messages (no secret). */
  readonly site: string;
}

/**
 * An inbox's absolute path.
 *
 * @param root - the folder it is made in.
 * @param pid - the runner's pid.
 * @param hex - its random part.
 * @returns `<root>/e2e-inbox-<pid>-<hex>`.
 * @throws Error if `root` is not absolute.
 */
export function inboxPath(root: string, pid: number, hex: string): string {
  if (!posix.isAbsolute(root)) {
    // Every command naming the inbox relies on it: a relative one would land in the working directory.
    throw new Error(
      `[wp/staging] the inbox root "${root}" is not an absolute path.`,
    );
  }
  return posix.join(root, `${INBOX_PREFIX}${String(pid)}-${hex}`);
}

/**
 * Copies a runner file to `request.target` through an inbox (see this module's header), in order:
 * the runner's SHA-256; `mkdir -m 0711` of the inbox; the upload; `chmod 0644`; the staging
 * directory ensured as the identity; `cp -f` as the identity; the site's SHA-256 compared. The inbox
 * is removed in `finally` once it was made (never when its `mkdir` failed: the path is then someone
 * else's, or nothing).
 *
 * @param ops - the operations, see {@link SiteStagingOps}.
 * @param request - see {@link InboxStagingRequest}.
 * @throws Error naming the failed step and the site; a failed inbox removal is only warned about.
 */
export async function stageThroughInbox(
  ops: SiteStagingOps,
  request: InboxStagingRequest,
): Promise<void> {
  const expected = await ops.runnerChecksum(request.localPath);
  const inbox = inboxPath(request.inboxRoot, request.pid, ops.randomHex());
  const made = await ops.asTransport("mkdir", ["-m", "0711", "--", inbox]);
  if (made.exitCode !== 0) {
    throw stepError(
      request,
      `could not create the upload inbox "${inbox}"`,
      made,
    );
  }
  try {
    const uploaded = posix.join(inbox, INBOX_FILE);
    await ops.upload(request.localPath, uploaded);
    // No `--`: BSD `chmod` takes it after the mode as a file name; the path is absolute anyway.
    const readable = await ops.asTransport("chmod", ["0644", uploaded]);
    if (readable.exitCode !== 0) {
      throw stepError(
        request,
        `could not make "${uploaded}" readable`,
        readable,
      );
    }
    await ensureSiteStagingDir(ops, request);
    const copied = await ops.asSite("cp", [
      "-f",
      "--",
      uploaded,
      request.target,
    ]);
    if (copied.exitCode !== 0) {
      throw stepError(
        request,
        `could not copy the upload to "${request.target}" as the site's identity`,
        copied,
      );
    }
    const actual = await ops.siteChecksum(request.target);
    if (actual !== expected) {
      throw new Error(
        `[wp/staging] "${request.target}" on ${request.site} does not match "${request.localPath}" ` +
          `(SHA-256 ${actual} on the site, ${expected} on the runner).`,
      );
    }
  } finally {
    await removeInbox(ops, inbox, request.site);
  }
}

/**
 * Makes sure the identity can write `request.categoryDir`, creating it when missing. When it, or the
 * area above it, exists but another user made it: the site's own area (`request.healDir`) is checked
 * to resolve inside the site, removed as the identity, else as root where the site can elevate, and
 * made again (warned once it is); under an absolute root (no `healDir`) nothing is removed and the
 * staging fails. Any other failure to make it (a full disk, a parent the identity cannot write) is
 * never healed.
 *
 * @param ops - the operations.
 * @param request - the category and heal directories, and the site's name.
 * @throws Error naming the directory and the override when it cannot be made or is refused, or when
 * the stale area cannot be removed (or resolves outside the site).
 */
export async function ensureSiteStagingDir(
  ops: SiteStagingOps,
  request: Pick<InboxStagingRequest, "categoryDir" | "healDir" | "site">,
): Promise<void> {
  const { categoryDir, healDir } = request;
  const ensure = (): Promise<ExecResult> =>
    ops.asSite("sh", [
      "-c",
      ENSURE_WRITABLE_SCRIPT,
      SCRIPT_NAME,
      categoryDir,
      healDir ?? categoryDir,
    ]);
  const first = await ensure();
  if (first.exitCode === 0) return;
  if (first.exitCode !== NOT_WRITABLE) {
    throw stepError(
      request,
      `could not create the staging directory "${categoryDir}" as the site's identity. ` +
        `If it cannot write there, set ${OVERRIDE_HINT} to a directory it can`,
      first,
    );
  }
  if (healDir === undefined) {
    throw stepError(
      request,
      `the staging directory "${categoryDir}" exists but the site's identity cannot write it: ` +
        "another user made it under an absolute staging root, which other sites may share, so it " +
        `is never removed. Remove it, or give each site its own root (${OVERRIDE_HINT})`,
      first,
    );
  }

  await ops.confineToSite(healDir);
  const removed = await removeAsSiteOrRoot(ops, healDir);
  if (removed.exitCode !== 0) {
    throw stepError(
      request,
      `the staging directory "${categoryDir}" is not writable by the site's identity, and ` +
        `"${healDir}" could not be removed to make it again`,
      removed,
    );
  }
  const remade = await ensure();
  if (remade.exitCode !== 0) {
    throw stepError(
      request,
      `"${healDir}" (made by another user) was removed, but the staging directory ` +
        `"${categoryDir}" could not be made again as the site's identity. If it cannot write there, ` +
        `set ${OVERRIDE_HINT} to a directory it can`,
      remade,
    );
  }
  ops.warn(
    `[wp/staging] ${request.site}: "${healDir}" was not writable by the site's identity ` +
      "(made by another user); removed it and made it again.",
  );
}

/**
 * `rm -rf` as the identity, then as root when that failed and the site can elevate.
 *
 * @param ops - the operations.
 * @param path - what to remove.
 * @returns the last attempt's outcome.
 */
async function removeAsSiteOrRoot(
  ops: SiteStagingOps,
  path: string,
): Promise<ExecResult> {
  const first = await ops.asSite("rm", ["-rf", "--", path]);
  if (first.exitCode === 0) return first;
  return (await ops.asRoot("rm", ["-rf", "--", path])) ?? first;
}

/**
 * Removes an inbox as the transport's user. Never throws: it runs in `finally`, where a throw would
 * replace the step's own error, and a leftover is swept later; a failure is warned about.
 *
 * @param ops - the operations.
 * @param inbox - the inbox's path.
 * @param site - the site's name, for the warning.
 */
async function removeInbox(
  ops: SiteStagingOps,
  inbox: string,
  site: string,
): Promise<void> {
  let reason: string | undefined;
  try {
    const removed = await ops.asTransport("rm", ["-rf", "--", inbox]);
    if (removed.exitCode !== 0) reason = outputOf(removed);
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  if (reason !== undefined) {
    ops.warn(
      `[wp/staging] ${site}: could not remove the upload inbox "${inbox}" (${reason}); ` +
        `it is removed once ${String(INBOX_MAX_AGE_MINUTES)} minutes old by the next teardown.`,
    );
  }
}

/**
 * Removes the transport user's inboxes older than {@link INBOX_MAX_AGE_MINUTES} — what a killed run
 * left — as that user. A younger one may belong to a run still staging on the same host.
 *
 * @param transport - the site's ssh transport.
 * @param inboxRoot - where inboxes are made ({@link DEFAULT_INBOX_ROOT} on a real site).
 * @throws Error naming the site when the sweep fails.
 */
export async function sweepStaleInboxes(
  transport: SshTransport,
  inboxRoot: string = DEFAULT_INBOX_ROOT,
): Promise<void> {
  const swept = await execAsTransport(transport, "sh", [
    "-c",
    SWEEP_SCRIPT,
    SCRIPT_NAME,
    inboxRoot,
    String(INBOX_MAX_AGE_MINUTES),
  ]);
  if (swept.exitCode !== 0) {
    throw new Error(
      `[wp/staging] could not remove stale upload inboxes in "${inboxRoot}" on ` +
        `${describeTarget(transport)} (exit ${String(swept.exitCode)}): ${outputOf(swept)}`,
    );
  }
}

/**
 * The real operations for an ssh site in the `site` state: probes and the inbox as the transport's
 * user, everything in the staging area through `exec` (as the identity, which also handles a `sudo`
 * refusal mid-run). The site's checksum boots WordPress without plugins or theme, so neither can print
 * into the digest (nor costs a full boot).
 *
 * @param transport - the site's ssh transport.
 * @returns the operations.
 */
export function siteStagingOps(transport: SshTransport): SiteStagingOps {
  return {
    asTransport: (file, args) => execAsTransport(transport, file, args),
    asSite: (file, args) => exec(transport, file, args),
    asRoot: async (file, args) =>
      (await elevationSupport(transport)) === "available"
        ? execElevated(transport, file, args)
        : undefined,
    confineToSite: async (path) => {
      const root = await wpRootDir(transport);
      await assertResolvedInsideRoot(
        transport,
        path,
        root,
        (reason) =>
          `[wp/staging] refusing to remove "${path}" on ${describeTarget(transport)}: it must ` +
          `stay inside the WordPress root ("${root}"), and ${reason}. Remove the link, or set ` +
          `${OVERRIDE_HINT} to a directory of the site's own.`,
      );
    },
    upload: (localPath, remotePath) =>
      copyIntoTarget(transport, localPath, remotePath),
    siteChecksum: (path) =>
      fileChecksum(transport, path, { skipPlugins: true, skipThemes: true }),
    runnerChecksum: sha256File,
    randomHex: () => randomBytes(8).toString("hex"),
    warn: (message) => {
      console.warn(message);
    },
  };
}

/**
 * An Error for a step that ran and failed.
 *
 * @param request - names the site.
 * @param what - what could not be done.
 * @param result - the step's outcome.
 */
function stepError(
  request: Pick<InboxStagingRequest, "site">,
  what: string,
  result: ExecResult,
): Error {
  return new Error(
    `[wp/staging] ${what} on ${request.site} (exit ${String(result.exitCode)}): ${outputOf(result)}`,
  );
}

/** A result's stderr, else stdout, trimmed; `no output` when both are empty. */
function outputOf(result: ExecResult): string {
  return (result.stderr || result.stdout).trim() || "no output";
}
