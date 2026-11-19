import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import {
  assertResolvedInsideRoot,
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  wpRootDir,
} from "../../../common/wp/exec";
import { assertSafeElevatedTarget } from "../../../common/wp/paths";
import { errorMessage } from "../../../common/guards";
import type { ExecResult } from "../../../common/wp/exec";
import type { Transport } from "../../../common/config/types";
import {
  LEASE_TTL_S,
  LeaseHeartbeat,
  NO_HOLDER,
  RENEW_SCRIPT,
  renewArgs,
} from "./content-copy-lease";
import { fenceArgs, parseDirIdentity } from "./content-copy-fence";
import {
  BOOT_ID_PATH,
  CONTENT_COPY_DB_DEFAULTS,
  CONTENT_COPY_DIR,
  CONTENT_COPY_EXTRACTED,
  CONTENT_COPY_FILE,
  CONTENT_COPY_PARTIAL,
  CONTENT_COPY_RESTORED,
  CONTENT_COPY_SCRATCH,
  COPY_DIR_GONE,
  COPY_NOTES,
  DISCARD_SCRIPT,
  HOST_CHECK_SCRIPT,
  IN_COPY_SCRIPT,
  IN_USE_SCRIPT,
  LEGACY_COPY_FILE,
  MARK_FAILED,
  MOUNT_CHECK_PERL,
  MOUNT_INSIDE,
  MOUNTINFO_PATH,
  NO_TOKEN,
  NOT_RENAMEABLE,
  NOT_THE_COPY_DIR,
  NOT_THIS_RUNS_COPY,
  PROBE_STRANDED,
  PUT_BACK_SCRIPT,
  RECOVERING_PREFIX,
  RENAME_PROBE,
  ROOM_CHECK_SCRIPT,
  STAMP_FAILED,
  TOKEN_NOT_WRITTEN,
  putBackDamage,
} from "./content-copy-scripts";
import type { DatabaseDefaults } from "./database-defaults";
import type { Every, RenewOutcome } from "./content-copy-lease";

/**
 * A copy of a site's `wp-content`, taken before a command that rewrites it wholesale and put back
 * exactly afterwards — for `wp backwpup restore`, which deletes what its archive does not hold and
 * writes the rest back as the identity site commands run as (measured on `pro@nginx`, as the SSH user).
 *
 * **Root does both halves, from the start** — the one place elevation is not a fallback: only root
 * reads every file the web server owns and puts every owner back. Without passwordless `sudo` the
 * copy is refused, and with it the command: a rewrite that could not be undone must not run on a
 * shared cell.
 *
 * **Put back beside the live site, then swapped in** ({@link PUT_BACK_SCRIPT}): the site keeps serving
 * (wp-cron, the debug log, caches) while it goes back, and an extraction over `wp-content` fails when
 * a request writes into a directory tar is emptying (`Cannot unlink: Directory not empty`, measured
 * live). So the copy is extracted into a root-only scratch directory on the same filesystem, compared
 * with the archive (`tar -d`), and renamed into place — a writer holding the old tree writes into the
 * discarded one — and what is then at `wp-content` is proved to be the tree extracted. Pausing the
 * site (`.maintenance`) was rejected: it stops new requests only, not those in flight, and a pause a
 * crash left would take the site down.
 *
 * **The copy outlives a failure on purpose.** It is kept in a root-only directory at the WordPress
 * root ({@link CONTENT_COPY_DIR}) — not the scenario's staging area, which every worker's teardown
 * wipes — and removed only once it is back. A put-back that failed, or a run killed between the
 * command and the put-back, leaves it there with `wp-content` possibly as the command left it, and
 * BackWPup runs then refuse that site until it is provably orphaned (`./content-copy-leftover.ts`):
 * its lease lapsed (`./content-copy-lease.ts`), or a later boot of the host stamped none of its uses.
 *
 * **What a leftover holds says how far its run got**: tar writes {@link CONTENT_COPY_PARTIAL}, named
 * {@link CONTENT_COPY_FILE} only once it reads back and is on disk — the command runs only after;
 * {@link CONTENT_COPY_RESTORED} once put back. And **every use is stamped** with the host's boot id
 * ({@link CONTENT_COPY_STAMP}) and renews the lease just before it — the directory made, the command
 * run, the put-back — so a stamp from another boot proves no run still uses it. A restore reaching
 * the database too leaves the database's defaults beside the copy ({@link CONTENT_COPY_DB_DEFAULTS}),
 * for a recovery to set back.
 *
 * **Root acts only inside the directory it proved is the copy's** ({@link IN_COPY_SCRIPT}): whoever
 * may write the WordPress root could otherwise swap the directory for a link between a check and
 * root's command. The WordPress root itself and `wp-content` are guarded as before, by path. And the
 * run that made a copy acts on it only while it holds the run's random token
 * ({@link CONTENT_COPY_TOKEN}), its restore only while the directory is the one it made
 * (`./content-copy-fence.ts`): a run that slept, or outlived a reboot, whose copy another run settled
 * must not stamp, put back, remove or restore over the next run's copy at the same path.
 *
 * Modes, owners and hard links are kept; ACLs, extended attributes and SELinux labels are not (none
 * on the cells, measured with `getfacl`; Ubuntu runs AppArmor). The names and root scripts are in
 * `./content-copy-scripts.ts`, re-exported here.
 */

export * from "./content-copy-scripts";

/**
 * A boot id as Linux prints it: a lowercase UUID.
 *
 * @param text - the file's contents.
 * @returns `undefined` unless it is exactly one UUID.
 */
export function parseBootId(text: string | undefined): string | undefined {
  const trimmed = text?.trim().toLowerCase();
  return trimmed !== undefined &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      trimmed,
    )
    ? trimmed
    : undefined;
}

/**
 * The host's current boot id.
 *
 * @param transport - the site.
 * @throws {@link Error} if it cannot be read — then no reboot could be told, so no copy is taken.
 */
export async function currentBootId(transport: Transport): Promise<string> {
  const read = await exec(transport, "cat", [BOOT_ID_PATH]);
  const id = read.exitCode === 0 ? parseBootId(read.stdout) : undefined;
  if (id === undefined) {
    throw new Error(
      `[backwpup/content-copy] ${describeTarget(transport)}: could not read the host's boot id ` +
        `(${BOOT_ID_PATH}), so a reboot during the restore could not be told. The restore was not run.`,
    );
  }
  return id;
}

/**
 * The processes {@link IN_USE_SCRIPT} printed.
 *
 * @param result - its result.
 * @returns one `pid program` line per process, or `undefined` when it did not run.
 */
export function parseInUse(
  result: Pick<ExecResult, "exitCode" | "stdout">,
): string[] | undefined {
  if (result.exitCode !== 0) return undefined;
  return result.stdout.split("\n").filter((line) => line.trim() !== "");
}

/**
 * The processes that may still use the site's copies, or a restore in its root ({@link IN_USE_SCRIPT}).
 *
 * @param transport - the site.
 * @param root - the WordPress root's absolute path.
 * @returns their `pid program` lines, or `undefined` when that could not be told.
 */
export async function copyUsers(
  transport: Transport,
  root: string,
): Promise<string[] | undefined> {
  return parseInUse(
    await execElevated(transport, "sh", [
      "-c",
      IN_USE_SCRIPT,
      "sh",
      posix.join(root, CONTENT_COPY_DIR),
      root,
      "/proc",
    ]),
  );
}

/**
 * The `make` exits after which its `mkdir` provably succeeded, so the directory is this run's even
 * with no token in it: refused by a check after it, gone since, no token written, stamp failed.
 */
const MADE_BUT_FAILED: readonly number[] = [
  NOT_THE_COPY_DIR,
  COPY_DIR_GONE,
  TOKEN_NOT_WRITTEN,
  STAMP_FAILED,
];

/** Who renews a lease, and for how long. */
export interface LeaseTerms {
  /** Seconds each renewal grants; `0` expires it. */
  readonly ttlS: number;
  /** `./content-copy-lease.ts`'s `holderFor`, or `NO_HOLDER`. */
  readonly holder: string;
}

/** The terms a run without a worker slot renews on. */
export const DEFAULT_LEASE: LeaseTerms = {
  ttlS: LEASE_TTL_S,
  holder: NO_HOLDER,
};

/**
 * The argv stamping a copy with the current boot and renewing its lease, run inside its directory:
 * exit {@link STAMP_FAILED} when it could not, told apart from a `sudo` that refused (exit 1).
 *
 * @param terms - the lease's ttl and holder.
 */
export function renewArgv(terms: LeaseTerms): string[] {
  return [
    "sh",
    "-c",
    RENEW_SCRIPT,
    "sh",
    ...renewArgs(terms.ttlS, terms.holder),
  ];
}

/**
 * How long a put-back waits for a restore still running on the site — one a dropped connection left
 * behind — and how often it looks.
 */
export const RESTORE_GONE_WAIT_MS = 5 * 60 * 1000;

/** See {@link RESTORE_GONE_WAIT_MS}. */
export const RESTORE_GONE_POLL_MS = 10_000;

/**
 * Space the copy needs beyond the content directory's own size before it is taken, so the shared disk
 * is never the thing that fills up — and the put-back keeps beyond the second tree it extracts.
 */
const COPY_HEADROOM_KB = 1024 * 1024;

/** The content directory's name, and so the copy's one top-level member, under the WordPress root. */
const CONTENT_DIR = "wp-content";

/**
 * GNU tar's arguments for taking the copy: `wp-content` itself, from the WordPress root — never `.`
 * from inside it, since Ubuntu's GNU tar 1.35 refuses to unlink `.` when putting such a copy back
 * (exit 2, measured on `pro@nginx` and in `ubuntu:24.04`). Root records every owner and mode, and
 * the POSIX format keeps modification times to the nanosecond, which tar's default rounds down to
 * the second (measured). The left-out paths are matched literally (`--no-wildcards`) and anchored at
 * the root, so a same-named path deeper down is still copied.
 *
 * @param archive - the copy's path, or its name inside the copy's directory when run there.
 * @param root - the WordPress root's absolute path.
 * @param keptOut - paths relative to the content directory.
 */
export function copyArgv(
  archive: string,
  root: string,
  keptOut: readonly string[],
): string[] {
  return [
    "-cf",
    archive,
    "--format=posix",
    "--no-wildcards",
    "--anchored",
    ...keptOut.map((path) => `--exclude=${CONTENT_DIR}/${path}`),
    "-C",
    root,
    CONTENT_DIR,
  ];
}

/**
 * The put-back's argv, run inside the copy's directory ({@link PUT_BACK_SCRIPT}).
 *
 * @param root - the WordPress root's absolute path.
 * @param terms - the lease the put-back renews, then expires once back.
 */
export function putBackArgv(root: string, terms: LeaseTerms): string[] {
  return [
    "sh",
    "-c",
    PUT_BACK_SCRIPT,
    "sh",
    root,
    ...renewArgs(terms.ttlS, terms.holder),
    String(COPY_HEADROOM_KB),
  ];
}

/** How GNU tar's complaint ends, at exit 1, about a file that changed while it was copied. */
const CHANGED_WHILE_READ = ": file changed as we read it";

/** How GNU tar's complaint ends, at exit 1, about a file that went before it could be copied. */
const REMOVED_BEFORE_READ = ": File removed before we read it";

/**
 * Whether a copy tar finished at exit 1 is still a faithful one: only when every complaint is a file
 * that changed, or went, while it was read — the copy then holds it as it was a moment earlier, or not
 * at all, as the site did. Anything else at exit 1 is refused: `File shrank` pads the file with zeros
 * (the put-back would write that over a good one), and `sudo` itself exits 1 when it refuses.
 *
 * @param stderr - what tar printed.
 */
export function benignCopyWarnings(stderr: string): boolean {
  const lines = stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        line.endsWith(CHANGED_WHILE_READ) || line.endsWith(REMOVED_BEFORE_READ),
    )
  );
}

/** How much a copy needs and how much there is, in kilobytes. */
export interface CopyRoom {
  /** What the content directory holds. */
  readonly usedKb: number;
  /** What is free on the filesystem the copy goes to. */
  readonly freeKb: number;
}

/**
 * Reads `du -sk` and `df -Pk`: the content directory's size and the free space where the copy goes —
 * or `undefined` when either is not a whole number, which an empty answer (a refused `sudo du`) or an
 * unexpected format would otherwise turn into `0` and wave through.
 *
 * @param du - `du -sk <content>`.
 * @param df - `df -Pk <destination>`.
 */
export function parseCopyRoom(
  du: Pick<ExecResult, "stdout">,
  df: Pick<ExecResult, "stdout">,
): CopyRoom | undefined {
  const used = du.stdout.trim().split(/\s+/)[0] ?? "";
  const free =
    df.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[3] ?? "";
  if (!/^\d+$/.test(used) || !/^\d+$/.test(free)) return undefined;
  return { usedKb: Number(used), freeKb: Number(free) };
}

/** Where a copy lives and what it copies, all absolute. */
export interface CopyPlace {
  /** The WordPress root. */
  readonly root: string;
  /** The content directory the copy is of. */
  readonly content: string;
  /** The copy's root-only directory. */
  readonly dir: string;
  /** The whole copy ({@link CONTENT_COPY_FILE}). */
  readonly archive: string;
}

/**
 * A copy kept in `dir`, for the WordPress install at `root`. Not checked here.
 *
 * @param root - the WordPress root's absolute path.
 * @param dir - the copy's directory, absolute.
 */
export function copyPlaceIn(root: string, dir: string): CopyPlace {
  return {
    root,
    content: posix.join(root, CONTENT_DIR),
    dir,
    archive: posix.join(dir, CONTENT_COPY_FILE),
  };
}

/**
 * Where this site's copy goes. Not checked here — see {@link ContentCopy.keep} for the guards.
 *
 * @param transport - the site.
 */
export async function copyPlace(transport: Transport): Promise<CopyPlace> {
  const root = await wpRootDir(transport);
  return copyPlaceIn(root, posix.join(root, CONTENT_COPY_DIR));
}

/**
 * Whether a name in the WordPress root is a copy's directory: the one {@link ContentCopy} makes, or
 * one claimed to be settled ({@link RECOVERING_PREFIX}).
 *
 * @param name - a directory entry's name.
 */
export function isLeftoverName(name: string): boolean {
  return (
    name === CONTENT_COPY_DIR ||
    (name.startsWith(RECOVERING_PREFIX) &&
      name.length > RECOVERING_PREFIX.length)
  );
}

/**
 * The copies' directories in the WordPress root itself, sorted. Asked as the identity site commands
 * run as: a copy's directory is root-only, but the root lists it to anyone.
 *
 * @param transport - the site.
 * @param root - the WordPress root's absolute path.
 * @throws {@link Error} if the root could not be listed.
 */
export async function findLeftovers(
  transport: Transport,
  root: string,
): Promise<string[]> {
  const listed = await exec(transport, "find", [
    root,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-name",
    `${CONTENT_COPY_DIR}*`,
    "-print",
  ]);
  if (listed.exitCode !== 0) {
    throw new Error(
      `[backwpup/content-copy] could not list ${root} (find exited ${String(listed.exitCode)}: ` +
        `${listed.stderr.trim().slice(0, 300) || "no output"})`,
    );
  }
  return listed.stdout
    .split("\n")
    .map((path) => posix.basename(path))
    .filter(isLeftoverName)
    .sort()
    .map((name) => posix.join(root, name));
}

/**
 * Refuses what root must not act on by path: one that leaves the site, lexically or once links
 * resolve, or one that is a link itself.
 *
 * @param transport - the site.
 * @param root - the WordPress root's absolute path.
 * @param paths - what root is about to act on.
 * @param describe - builds the message from the rule that was broken.
 * @throws {@link Error} built by `describe`.
 */
export async function assertRootMayActOn(
  transport: Transport,
  root: string,
  paths: readonly string[],
  describe: (reason: string) => string,
): Promise<void> {
  for (const path of paths) {
    assertSafeElevatedTarget(path, root, describe);
    await assertResolvedInsideRoot(transport, path, root, describe);
    if ((await exec(transport, "test", ["-L", path])).exitCode === 0) {
      throw new Error(describe(`"${path}" is a symbolic link`));
    }
  }
}

/**
 * Runs a command as root inside a copy's directory, once {@link IN_COPY_SCRIPT} proved it is that
 * directory, root's alone and — a token given — this run's.
 *
 * @param transport - the site.
 * @param dir - the copy's directory, absolute.
 * @param argv - the command, its paths relative to the directory.
 * @param options - `mode: "make"` creates the directory first, writing `token` into it; `token` (the
 * making run's) is checked otherwise, none for a run settling another's copy.
 * @returns the command's result, or one of {@link IN_COPY_SCRIPT}'s exits.
 */
export function inCopy(
  transport: Transport,
  dir: string,
  argv: readonly string[],
  options: InCopyOptions = {},
): Promise<ExecResult> {
  return execElevated(transport, "sh", inCopyArgv(dir, argv, options));
}

/** How {@link inCopy} runs: `make` the directory, and the token to write or check. */
export interface InCopyOptions {
  readonly mode?: "make" | "use";
  readonly token?: string;
}

/**
 * `sh`'s arguments for {@link inCopy}: never an empty one, which a transport could drop (node-ssh's
 * own escaping did).
 *
 * @param dir - the copy's directory, absolute.
 * @param argv - the command.
 * @param options - see {@link inCopy}.
 */
export function inCopyArgv(
  dir: string,
  argv: readonly string[],
  options: InCopyOptions = {},
): string[] {
  return [
    "-c",
    IN_COPY_SCRIPT,
    "sh",
    options.mode ?? "use",
    dir,
    options.token ?? NO_TOKEN,
    ...argv,
  ];
}

/**
 * Whether a command on a copy failed because the copy is no longer the run's: gone, or another's.
 *
 * @param result - the command's result.
 */
export function copyIsGone(result: Pick<ExecResult, "exitCode">): boolean {
  return (
    result.exitCode === COPY_DIR_GONE || result.exitCode === NOT_THIS_RUNS_COPY
  );
}

/**
 * A failed command on a copy, for a message: what refused it and what it printed.
 *
 * @param result - the command's result.
 */
export function inCopyProblem(result: ExecResult): string {
  if (result.exitCode === NOT_THE_COPY_DIR) {
    return "it is a link, or not root's alone";
  }
  if (result.exitCode === COPY_DIR_GONE) return "it is gone";
  if (result.exitCode === NOT_THIS_RUNS_COPY) {
    return "it holds another run's token";
  }
  return `exit ${String(result.exitCode)}: ${result.stderr.trim().slice(0, 300) || "no output"}`;
}

/**
 * Stamps a copy with the current boot's id and renews its lease: done just before every use, and by
 * the making run's heartbeat.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @param terms - the lease's ttl and holder.
 * @param token - the making run's token; none for a run settling another's copy.
 */
export function stampCopy(
  transport: Transport,
  dir: string,
  terms: LeaseTerms,
  token?: string,
): Promise<ExecResult> {
  return inCopy(
    transport,
    dir,
    renewArgv(terms),
    token === undefined ? {} : { token },
  );
}

/**
 * Reads a copy directory's `dev:ino` as root inside it ({@link IN_COPY_SCRIPT}'s checks first); judge
 * it with `parseDirIdentity` (`./content-copy-fence.ts`).
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @param token - the making run's token; none for a run settling another's copy.
 */
export function readDirIdentity(
  transport: Transport,
  dir: string,
  token?: string,
): Promise<ExecResult> {
  return inCopy(
    transport,
    dir,
    ["stat", "-c", "%d:%i", "."],
    token === undefined ? {} : { token },
  );
}

/**
 * Lists a copy's archive as root — the proof it reads back; judge it with {@link readsBackWhole}.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @param name - the archive's name in it.
 */
export function readBack(
  transport: Transport,
  dir: string,
  name: string,
): Promise<ExecResult> {
  return inCopy(transport, dir, ["tar", "-tf", name]);
}

/**
 * Whether a listing ({@link readBack}) shows a copy of the content directory: tar read it to the end,
 * and its first member is that directory's. A `sudo` that refused, or an archive cut mid-member, fails.
 *
 * @param listed - `tar -tf`'s result.
 */
export function readsBackWhole(
  listed: Pick<ExecResult, "exitCode" | "stdout">,
): boolean {
  return listed.exitCode === 0 && listed.stdout.startsWith(`${CONTENT_DIR}/`);
}

/**
 * Puts a whole copy back as root ({@link PUT_BACK_SCRIPT}): stamped, extracted beside, swapped in,
 * marked back.
 *
 * @param transport - the site.
 * @param place - where the copy is.
 * @param terms - the lease it renews first, then expires once back.
 * @param token - the making run's token; none for a run settling another's copy.
 * @throws {@link CopyNotThisRunsError} if it is no longer the run's (gone, or another's: nothing put
 * back); {@link Error} if it could not be put back — saying what that left of `wp-content` — or was put
 * back but not marked so. Each message says what to do.
 */
export async function putBackCopy(
  transport: Transport,
  place: CopyPlace,
  terms: LeaseTerms,
  token?: string,
): Promise<void> {
  const result = await inCopy(
    transport,
    place.dir,
    putBackArgv(place.root, terms),
    token === undefined ? {} : { token },
  );
  if (result.exitCode === 0) return;
  const target = describeTarget(transport);
  if (copyIsGone(result))
    throw new CopyNotThisRunsError(notThisRunsMessage(target, place, result));
  if (result.exitCode === MARK_FAILED) {
    throw new Error(
      `[backwpup/content-copy] ${target}: put wp-content back, but could not mark the copy so ` +
        `(${inCopyProblem(result)}). Remove it by hand — \`sudo rm -r ${place.dir}\` — or a later ` +
        "run may put it back again over what changed since. BackWPup runs refuse this site until " +
        "it is gone.",
    );
  }
  const what =
    result.exitCode === STAMP_FAILED
      ? `could not stamp the copy before putting it back (${inCopyProblem(result)}); nothing was put back. `
      : `could not put wp-content back (${inCopyProblem(result)}); ${putBackDamage(result.exitCode)}. `;
  throw new Error(
    `[backwpup/content-copy] ${target}: ${what}` +
      leftoverMessage(target, place, [CONTENT_COPY_FILE]),
  );
}

/**
 * Removes a copy — whatever of it there is — and its directory. Best-effort: one that stays is
 * reported, since every later BackWPup run on the site refuses it until it is gone.
 *
 * @param transport - the site.
 * @param place - where the copy is.
 * @param token - the making run's token: another run's copy is then left alone (and `false` returned);
 * none for a run settling another's copy.
 * @returns whether the directory is gone.
 */
export async function discardCopy(
  transport: Transport,
  place: CopyPlace,
  token?: string,
): Promise<boolean> {
  const removed = await inCopy(
    transport,
    place.dir,
    [
      "sh",
      "-c",
      DISCARD_SCRIPT,
      "sh",
      CONTENT_COPY_PARTIAL,
      CONTENT_COPY_FILE,
      CONTENT_COPY_RESTORED,
      CONTENT_COPY_EXTRACTED,
      ...COPY_NOTES.filter((name) => name !== CONTENT_COPY_SCRATCH),
    ],
    token === undefined ? {} : { token },
  );
  if (removed.exitCode === COPY_DIR_GONE) return true;
  // Another run's copy now: left alone, and still there.
  if (removed.exitCode === NOT_THIS_RUNS_COPY) return false;
  // By path, and safe so: `rmdir` removes only an empty directory, never a link's target.
  await execElevated(transport, "rmdir", ["--", place.dir]);
  if ((await exec(transport, "test", ["-e", place.dir])).exitCode !== 0) {
    return true;
  }
  const left = await copyEntries(transport, place.dir, token);
  console.warn(
    `[backwpup/content-copy] ${describeTarget(transport)}: could not remove ${place.dir}; ` +
      `${removeByHand(place, left)} BackWPup runs refuse this site until it is gone.`,
  );
  return false;
}

/**
 * A copy directory's entries, read as root inside it. Never throws: a site that cannot be asked reads
 * as `undefined`, like a refused listing.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @param token - the making run's token, checked; none for a run settling another's copy.
 * @returns the entry names, or `undefined` when they could not be read.
 */
export async function copyEntries(
  transport: Transport,
  dir: string,
  token?: string,
): Promise<string[] | undefined> {
  try {
    const listed = await inCopy(
      transport,
      dir,
      ["ls", "-A"],
      token === undefined ? {} : { token },
    );
    return listed.exitCode === 0
      ? listed.stdout.split("\n").filter((name) => name !== "")
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * How to settle a copy directory holding the rename probe's ({@link RENAME_PROBE}): it may hold the
 * site's own `wp-content`, exchanged out by a probe that never exchanged it back (failed, or killed
 * between its two exchanges), so the directory must never simply be removed. Its contents tell: the
 * site's files, or nothing once the exchange went back.
 *
 * @param place - where the copy is.
 */
export function probeRecipe(place: CopyPlace): string {
  const probe = posix.join(place.dir, RENAME_PROBE);
  return (
    `${place.dir} holds ${probe}, left by the check that wp-content can be renamed, which exchanges it with ` +
    `an empty directory and back. If \`sudo ls -A ${probe}\` lists the site's files, that is the ` +
    `site's wp-content (wp-content is then a root-only directory holding none of them): exchange it ` +
    `back — \`sudo mv -T ${place.content} ${probe}.empty && sudo mv -T ${probe} ${place.content}\`; ` +
    `if it lists nothing, wp-content was exchanged back already: \`sudo rmdir ${probe}\`. Never ` +
    `remove ${place.dir} while ${probe} is in it; once it is gone, the next BackWPup run on this ` +
    "site says what to do with the rest."
  );
}

/**
 * What to tell an operator about a copy directory that could not be removed: the probe's recipe when
 * it holds the probe's directory ({@link probeRecipe}), a look first when what it holds is unknown,
 * else the removal.
 *
 * @param place - where the copy is.
 * @param entries - what it holds, or `undefined` when that could not be read.
 */
export function removeByHand(
  place: CopyPlace,
  entries: readonly string[] | undefined,
): string {
  if (entries?.includes(RENAME_PROBE) === true) return probeRecipe(place);
  const remove = `\`sudo rm -r ${place.dir}\``;
  if (entries === undefined) {
    return (
      `look first (\`sudo ls -A ${place.dir}\`): if it holds ${RENAME_PROBE}, that may be the ` +
      "site's own wp-content — a BackWPup run on this site refuses it, saying how to exchange it " +
      `back; otherwise remove it by hand: ${remove}.`
    );
  }
  return `remove it by hand: ${remove}.`;
}

/**
 * A copy that is no longer the run's: gone, or another run's — claimed by a later run that judged this
 * one gone (the host rebooted since its last use, or its lease lapsed).
 */
export class CopyNotThisRunsError extends Error {}

/**
 * What to tell a run whose copy is no longer its own: a later run claimed it, judging this one gone.
 *
 * @param target - the site, as messages name it.
 * @param place - where the copy was.
 * @param result - the refused command's result.
 */
function notThisRunsMessage(
  target: string,
  place: CopyPlace,
  result: ExecResult,
): string {
  return (
    `[backwpup/content-copy] ${target}: the copy of wp-content at ${place.dir} is no longer this ` +
    `run's (${inCopyProblem(result)}) — another run claimed it, after a reboot or past this ` +
    "run's lease, so nothing was put back; that run, or a later one, settles it."
  );
}

/**
 * What to tell an operator about a copy an earlier run left, from what it holds: the way back when it
 * holds a whole copy (it may be the only way back to the site as that run found it), or that it can
 * simply go when it holds none.
 *
 * @param target - the site, as messages name it.
 * @param place - where the copy is.
 * @param entries - what its directory holds, or `undefined` when that could not be read.
 */
export function leftoverMessage(
  target: string,
  place: CopyPlace,
  entries?: readonly string[],
): string {
  const head = `[backwpup/content-copy] ${target}: a copy of wp-content an earlier run took is still in ${place.dir}.`;
  const tail = "BackWPup runs refuse this site until it is gone.";
  const archive = [CONTENT_COPY_FILE, LEGACY_COPY_FILE].find(
    (name) => entries?.includes(name) === true,
  );
  const listed =
    entries === undefined || entries.length === 0
      ? "nothing"
      : entries.join(", ");
  if (entries?.includes(RENAME_PROBE) === true) {
    return `${head} ${probeRecipe(place)} ${tail}`;
  }
  if (entries !== undefined && heldCopy(entries) === "none") {
    return (
      `${head} It holds no copy to put back (${listed}): no restore ran from it, or it is back ` +
      `already. Remove it: \`sudo rm -r ${place.dir}\`. ${tail}`
    );
  }
  if (entries !== undefined && archive === undefined) {
    return `${head} It holds ${listed}; settle it by hand, then remove it: \`sudo rm -r ${place.dir}\`. ${tail}`;
  }
  const path =
    archive === undefined
      ? `${place.dir}/<the .tar it holds — \`sudo ls -A ${place.dir}\`>`
      : posix.join(place.dir, archive);
  // Unread, it may hold the rename probe's directory: never to be removed with the rest.
  const look =
    entries === undefined
      ? ` If \`sudo ls -A ${place.dir}\` lists ${RENAME_PROBE}, settle that first: it may hold the ` +
        "site's own wp-content, and a BackWPup run's refusal then says how to exchange it back."
      : "";
  const manual = posix.join(place.dir, "manual");
  const content = posix.join(place.root, CONTENT_DIR);
  return (
    `${head} That run's \`wp backwpup restore\` may have left wp-content damaged (files ` +
    "deleted, others owned by the transport's user) and never put it back. If it is damaged and " +
    "`findmnt` shows no mount at or under wp-content, extract the copy beside the site and swap it " +
    `in: \`sudo mkdir -m 0700 ${manual} && sudo tar -xpf ${path} -C ${manual} && sudo mv -T ` +
    `${content} ${manual}/damaged && sudo mv -T ${manual}/wp-content ${content}\` — never extract ` +
    "it over wp-content, which fails while the site writes into it; either way " +
    `remove it then: \`sudo rm -r ${place.dir}\`. A run settles it itself once it is provably ` +
    `orphaned — its lease lapsed, or an earlier boot of the host stamped it, and no process uses it.${look} ${tail}`
  );
}

/**
 * A copy directory's entries but the notes about the copy (stamp, token, database defaults).
 *
 * @param entries - the directory's entry names.
 */
export function heldEntries(entries: readonly string[]): string[] {
  return entries.filter((name) => !COPY_NOTES.includes(name));
}

/** What a copy's directory holds, the notes about it aside. */
export type HeldCopy = "whole" | "none" | "unknown";

/**
 * What a copy's directory holds: the whole copy alone; none to put back — nothing, the partial copy
 * (the command never ran from it) or the one already back (renamed, or marked beside it); or anything else (both, a copy named as
 * copies once were, an unknown file).
 *
 * @param entries - the directory's entry names.
 */
export function heldCopy(entries: readonly string[]): HeldCopy {
  const held = heldEntries(entries);
  // A whole copy marked back when it could not be renamed so.
  if (
    held.includes(CONTENT_COPY_EXTRACTED) &&
    held.every(
      (name) => name === CONTENT_COPY_EXTRACTED || name === CONTENT_COPY_FILE,
    )
  ) {
    return "none";
  }
  if (held.length > 1) return "unknown";
  const [entry] = held;
  if (
    entry === undefined ||
    entry === CONTENT_COPY_PARTIAL ||
    entry === CONTENT_COPY_RESTORED
  ) {
    return "none";
  }
  return entry === CONTENT_COPY_FILE ? "whole" : "unknown";
}

/** How a {@link ContentCopy} waits, renews and names itself; every field has a default. */
export interface ContentCopyOptions {
  /** How long {@link ContentCopy.putBack} waits for a restore still running on the site. */
  readonly boundMs?: number;
  /** How often it looks meanwhile. */
  readonly pollMs?: number;
  /** The lease's holder: the worker's run and slot (`holderFor`); none outside a worker. */
  readonly holder?: string;
  /** How often the lease is renewed while the copy is kept. */
  readonly renewEveryMs?: number;
  /** The renewal timer; a spec's stand-in replaces Node's. */
  readonly every?: Every;
}

/**
 * Why {@link HOST_CHECK_SCRIPT} refused a host.
 *
 * @param result - its result.
 */
export function hostCheckProblem(result: ExecResult): string {
  if (result.exitCode === 3) {
    return "root finds no `perl`, which puts the copy back in one swap";
  }
  if (result.exitCode === 4) {
    return "wp-content is on another filesystem than the WordPress root (a mount), which the put-back cannot rename it across";
  }
  return `whether the copy could go back could not be checked (${inCopyProblem(result)})`;
}

/**
 * Why {@link MOUNT_CHECK_PERL} refused a host: no rename could swap the copy back in.
 *
 * @param result - its result.
 */
export function swapProblem(result: ExecResult): string {
  const said = result.stderr.trim().slice(0, 300);
  if (result.exitCode === MOUNT_INSIDE) {
    return `a mount is at or under wp-content (${said}), which a put-back would move aside with the tree, or cannot rename`;
  }
  if (result.exitCode === NOT_RENAMEABLE) {
    return `wp-content cannot be renamed (${said}), so the put-back could not swap the copy in`;
  }
  if (copyIsGone(result)) {
    return `its directory is no longer this run's (${inCopyProblem(result)})`;
  }
  return `whether the put-back could swap the copy in could not be checked (${inCopyProblem(result)})`;
}

/**
 * The rename probe's directory is left in the copy's — its exchange back failed, or the check was cut
 * off between its two exchanges — so it may hold the site's own `wp-content`: the copy's directory
 * then stays, and the message says how to exchange it back ({@link probeRecipe}).
 */
export class ProbeStrandedError extends Error {}

/**
 * A copy of the site's content directory, taken before a command that rewrites it wholesale and put
 * back afterwards — see the module header. While kept, its lease is renewed on a timer
 * (`./content-copy-lease.ts`); a run giving up on it expires the lease at once.
 */
export class ContentCopy {
  /** Where the copy is, once taken. */
  private place: CopyPlace | undefined;

  /** Whether the copy has been put back, or is no longer this run's. */
  private restored = false;

  /** The host's boot id when the copy was taken. */
  private bootId: string | undefined;

  /** The copy directory's `dev:ino`, which the restore's fence checks. */
  private fenceId: string | undefined;

  /** This run's token, written into the copy it makes. */
  private readonly token = randomBytes(16).toString("hex");

  /** The lease's terms while kept. */
  private readonly terms: LeaseTerms;

  /** How long and how often a put-back waits for a restore still running. */
  private readonly wait: { readonly boundMs: number; readonly pollMs: number };

  /** Renews the lease while the copy is kept. */
  private readonly heartbeat: LeaseHeartbeat;

  /** The latest renewal: each waits for the one before, so two never race on the lease file. */
  private renewal: Promise<unknown> = Promise.resolve();

  /**
   * @param transport - the scenario's site.
   * @param leaveOut - works out, when the copy is taken, what it leaves out — paths relative to the
   * content directory that the scenario's own teardowns remove.
   * @param options - see {@link ContentCopyOptions}.
   */
  constructor(
    private readonly transport: Transport,
    private readonly leaveOut: () => Promise<readonly string[]>,
    options: ContentCopyOptions = {},
  ) {
    this.terms = { ttlS: LEASE_TTL_S, holder: options.holder ?? NO_HOLDER };
    // Refused here, not at the first renewal, so a bad holder never reaches a site.
    renewArgs(this.terms.ttlS, this.terms.holder);
    this.wait = {
      boundMs: options.boundMs ?? RESTORE_GONE_WAIT_MS,
      pollMs: options.pollMs ?? RESTORE_GONE_POLL_MS,
    };
    this.heartbeat = new LeaseHeartbeat(
      () => this.renewOutcome(),
      (problem) => {
        console.warn(
          `[backwpup/content-copy] ${describeTarget(this.transport)}: could not renew the lease ` +
            `on the copy of wp-content (${problem}); still trying. Past its lease a later run may ` +
            "settle the copy — this run's own steps on it are then refused, never run over it.",
        );
      },
      options.renewEveryMs,
      options.every,
    );
  }

  /** Whether a copy is waiting to be put back. */
  get kept(): boolean {
    return this.place !== undefined && !this.restored;
  }

  /**
   * Takes the copy, once per scenario: the first is the state to return to. Then renews its lease
   * until it is put back or given up.
   *
   * @throws {@link Error} — and the command must then not run — if the host cannot elevate or put a
   * copy back, a path is unsafe for root, an earlier run's copy is still there, the disk has no room,
   * no rename could swap `wp-content` back, or the copy could not be taken whole;
   * {@link ProbeStrandedError} if the rename probe's directory is left in the copy's, however the
   * check ended — the copy's directory then stays.
   */
  async keep(): Promise<void> {
    if (this.place !== undefined) return;
    const place = await copyPlace(this.transport);
    await this.assertUsable(place);
    await this.assertRoom(place);
    const keptOut = await this.leaveOut();
    this.bootId = await currentBootId(this.transport);
    // Made, tokened, stamped and leased in one root command: a reboot cut it short leaves the
    // directory empty, or holding a token alone — none to put back, which a later run removes.
    const made = await inCopy(
      this.transport,
      place.dir,
      renewArgv(this.terms),
      {
        mode: "make",
        token: this.token,
      },
    );
    if (made.exitCode !== 0) {
      // Removed without its token only where that very command's `mkdir` provably succeeded; any
      // other failure (`sudo` refusing, a missing shell, `mkdir` itself) may be another run's.
      if (MADE_BUT_FAILED.includes(made.exitCode)) await this.discard(place);
      throw new Error(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not prepare ${place.dir} ` +
          `for the copy (${inCopyProblem(made)}). The restore was not run.`,
      );
    }
    // Renewed from here on: taking the copy itself may outlast a lease.
    this.place = place;
    this.heartbeat.start();
    try {
      await this.assertSwappable(place);
      await this.copy(place, keptOut);
      this.fenceId = await this.identify(place);
    } catch (error) {
      await this.stopRenewing();
      this.place = undefined;
      // Nothing has been rewritten yet, so a copy that failed is no leftover to settle — unless the
      // probe left the site's own tree in its directory. Told by what is there, not by how the check
      // ended: one killed between its two exchanges (a signal, a dropped connection) leaves it too.
      const entries = await copyEntries(this.transport, place.dir, this.token);
      const probeLeft =
        entries === undefined
          ? error instanceof ProbeStrandedError
          : entries.includes(RENAME_PROBE);
      if (!probeLeft) {
        await this.discard(place, this.token);
        throw error;
      }
      const why =
        error instanceof ProbeStrandedError
          ? error.message
          : `[backwpup/content-copy] ${describeTarget(this.transport)}: the copy of wp-content was ` +
            `cut short (${errorMessage(error)}). The restore was not run.`;
      throw new ProbeStrandedError(`${why} ${probeRecipe(place)}`);
    }
  }

  /**
   * Stamps the copy and renews its lease just before the command runs, so a reboot during it orphans
   * the copy provably — then checks the host has not rebooted since the copy was taken: a reboot after
   * the stamp would let the command, run on reconnecting, rewrite the site while another run settles
   * the copy. The command's own fence ({@link ContentCopy.fence}) then refuses it should the copy be
   * settled meanwhile. Does nothing when no copy is kept.
   *
   * @throws {@link Error} if it could not stamp, or the host rebooted — the command must then not run,
   * and the copy stays for the put-back, or a run settling it.
   */
  async stamp(): Promise<void> {
    if (!this.kept || this.place === undefined) return;
    const target = describeTarget(this.transport);
    const stamped = await this.renew(this.terms);
    if (stamped.exitCode !== 0) {
      throw new Error(
        `[backwpup/content-copy] ${target}: could not stamp the copy of ` +
          `wp-content in ${this.place.dir} (${inCopyProblem(stamped)}). The restore was not run.`,
      );
    }
    const now = await currentBootId(this.transport);
    if (now !== this.bootId) {
      throw new Error(
        `[backwpup/content-copy] ${target}: the host rebooted since the copy of wp-content in ` +
          `${this.place.dir} was taken (boot ${this.bootId ?? "unknown"}, now ${now}), so the restore ` +
          "was not run; the copy stays — this run puts it back if it is still its own.",
      );
    }
  }

  /**
   * WP-CLI's global arguments fencing the restore on this copy (`./content-copy-fence.ts`): it runs
   * only while the copy is still at its path, the directory this run made. None when no copy is kept.
   */
  fence(): string[] {
    if (!this.kept || this.place === undefined || this.fenceId === undefined) {
      return [];
    }
    return fenceArgs(this.place.dir, this.fenceId);
  }

  /**
   * Saves the database's defaults beside the copy, for a run settling it — after a reboot or a lapsed
   * lease — to set back:
   * done before a restore that reaches the database too. Does nothing when no copy is kept.
   *
   * @param defaults - what they are before the command.
   * @throws {@link Error} if they could not be saved — the command must then not run.
   */
  async keepDatabaseDefaults(defaults: DatabaseDefaults): Promise<void> {
    if (!this.kept || this.place === undefined) return;
    const saved = await inCopy(
      this.transport,
      this.place.dir,
      [
        "sh",
        "-c",
        `printf '%s\\n' "$1" > ${CONTENT_COPY_DB_DEFAULTS}`,
        "sh",
        JSON.stringify(defaults),
      ],
      { token: this.token },
    );
    if (saved.exitCode !== 0) {
      throw new Error(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not save the database's ` +
          `defaults beside the copy in ${this.place.dir} (${inCopyProblem(saved)}). The restore was ` +
          "not run.",
      );
    }
  }

  /**
   * Puts the copy back, then removes it — once no restore runs on the site any more: one a dropped
   * connection left running would go on rewriting under the put-back. Stops renewing the lease first;
   * the put-back renews it once more, then expires it. Does nothing when no copy was taken, or it is
   * back already.
   *
   * @throws {@link Error} if a restore still runs past the bound, or it could not be told, or the copy
   * could not be put back — the copy is then **kept**, its lease expired so a later run may settle it
   * once no process uses it, and the message says how to put it back by hand; or if the copy is no
   * longer this run's (another run claimed it, after a reboot or past its lease).
   */
  async putBack(): Promise<void> {
    const place = this.place;
    if (place === undefined || this.restored) return;
    // First: a renewal is itself a use of the copy, which the wait below would count.
    await this.stopRenewing();
    try {
      await this.awaitNoUsers(place);
    } catch (error) {
      await this.abandon();
      throw error;
    }
    try {
      await putBackCopy(this.transport, place, this.terms, this.token);
    } catch (error) {
      // Not this run's any more: nothing of it to keep.
      if (error instanceof CopyNotThisRunsError) {
        this.restored = true;
      } else {
        await this.expireLease(place);
      }
      throw error;
    }
    this.restored = true;
    await discardCopy(this.transport, place, this.token);
  }

  /**
   * Gives the copy up without putting it back — its restore never ended, or the put-back cannot wait
   * for it: stops renewing and expires the lease, so a later run settles the copy once no process
   * uses it instead of waiting out the lease. The copy stays. Does nothing when none is kept.
   */
  async abandon(): Promise<void> {
    const place = this.place;
    if (place === undefined || this.restored) return;
    await this.stopRenewing();
    await this.expireLease(place);
  }

  /** Stops the heartbeat, then waits for any renewal in flight. */
  private async stopRenewing(): Promise<void> {
    await this.heartbeat.stop();
    await this.renewal;
  }

  /**
   * Expires the lease, best-effort: a failure is warned about — the lease then lapses by itself.
   *
   * @param place - where the copy is.
   */
  private async expireLease(place: CopyPlace): Promise<void> {
    try {
      const expired = await this.renew({ ttlS: 0, holder: this.terms.holder });
      if (expired.exitCode === 0 || copyIsGone(expired)) return;
      console.warn(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not expire the lease on ` +
          `the copy in ${place.dir} (${inCopyProblem(expired)}); it lapses by itself within ` +
          `${String(LEASE_TTL_S / 60)} min.`,
      );
    } catch (error) {
      console.warn(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not expire the lease on ` +
          `the copy in ${place.dir} (${errorMessage(error)}); it lapses by itself within ` +
          `${String(LEASE_TTL_S / 60)} min.`,
      );
    }
  }

  /**
   * Stamps the copy and writes its lease on `terms`, after any renewal still in flight.
   *
   * @param terms - the ttl and holder to write.
   * @returns the root command's result.
   */
  private renew(terms: LeaseTerms): Promise<ExecResult> {
    const place = this.place;
    if (place === undefined) {
      return Promise.reject(
        new Error("[backwpup/content-copy] no copy is kept"),
      );
    }
    const next = this.renewal.then(() =>
      stampCopy(this.transport, place.dir, terms, this.token),
    );
    this.renewal = next.catch(() => undefined);
    return next;
  }

  /**
   * One heartbeat renewal, as the heartbeat reads it: `gone` — it stops — only when the copy holds
   * another run's token. Nothing at its path is a failure, still tried: a run settling it claims it
   * by renaming it, and hands it back, still this run's, when it may not settle it.
   */
  private async renewOutcome(): Promise<RenewOutcome> {
    const renewed = await this.renew(this.terms);
    if (renewed.exitCode === 0) return "renewed";
    if (renewed.exitCode === NOT_THIS_RUNS_COPY) return "gone";
    return { failed: inCopyProblem(renewed) };
  }

  /**
   * The copy directory's `dev:ino`, read as root inside it — what the restore's fence checks.
   *
   * @param place - where the copy is.
   * @throws {@link Error} if it cannot be read; the restore is then not run.
   */
  private async identify(place: CopyPlace): Promise<string> {
    const read = await readDirIdentity(this.transport, place.dir, this.token);
    const id = read.exitCode === 0 ? parseDirIdentity(read.stdout) : undefined;
    if (id === undefined) {
      throw new Error(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not identify the copy's ` +
          `directory ${place.dir} (${inCopyProblem(read)}), so the restore could not be fenced on it. ` +
          "The restore was not run.",
      );
    }
    return id;
  }

  /**
   * Waits, polling, while any process may use the site's copies or a restore runs in its root.
   *
   * @param place - where the copy is.
   * @throws {@link Error} keeping the copy, past the bound or when it cannot be told.
   */
  private async awaitNoUsers(place: CopyPlace): Promise<void> {
    const deadline = Date.now() + this.wait.boundMs;
    for (;;) {
      const users = await copyUsers(this.transport, place.root);
      if (users?.length === 0) return;
      if (users === undefined || Date.now() >= deadline) {
        const target = describeTarget(this.transport);
        const why =
          users === undefined
            ? "whether a restore still runs on the site could not be told"
            : `a restore, or another use of the copy, still runs on the site after ${String(this.wait.boundMs / 1000)} s (${users.join("; ").slice(0, 200)})`;
        throw new Error(
          `[backwpup/content-copy] ${target}: ${why}, so nothing was put back — doing it under the ` +
            `command would leave neither as found. ${leftoverMessage(target, place, [CONTENT_COPY_FILE])}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, this.wait.pollMs));
    }
  }

  /**
   * Refuses what root must not act on: a host that cannot elevate, a path that leaves the site, a
   * content or copy directory that is a link, a host the copy could not go back on
   * ({@link HOST_CHECK_SCRIPT}), and a copy an earlier run left.
   *
   * @param place - where the copy goes.
   * @throws {@link Error} naming what was refused; the restore is then not run.
   */
  private async assertUsable(place: CopyPlace): Promise<void> {
    const target = describeTarget(this.transport);
    const describe = (reason: string): string =>
      `[backwpup/content-copy] ${target}: refusing to copy wp-content as root — ${reason}. The ` +
      "restore was not run.";
    const elevation = await elevationSupport(this.transport);
    if (elevation !== "available") {
      throw new Error(
        describe(
          `it needs passwordless sudo (elevation: ${elevation}) to read every file and put back ` +
            "every owner",
        ),
      );
    }
    await assertRootMayActOn(
      this.transport,
      place.root,
      [place.content, place.dir],
      describe,
    );
    const host = await execElevated(this.transport, "sh", [
      "-c",
      HOST_CHECK_SCRIPT,
      "sh",
      place.root,
    ]);
    if (host.exitCode !== 0) {
      throw new Error(describe(hostCheckProblem(host)));
    }
    const [leftover] = await findLeftovers(this.transport, place.root);
    if (leftover !== undefined) {
      throw new Error(
        `${leftoverMessage(target, copyPlaceIn(place.root, leftover))} The restore was not run.`,
      );
    }
  }

  /**
   * Refuses a site whose `wp-content` no rename could swap back ({@link MOUNT_CHECK_PERL}, probing
   * an overlay filesystem), run as root in the copy's directory just made.
   *
   * @param place - where the copy goes.
   * @throws {@link Error} if a mount is at or under `wp-content`, it cannot be renamed, or that cannot
   * be told; {@link ProbeStrandedError} if the probe could not exchange it back.
   */
  private async assertSwappable(place: CopyPlace): Promise<void> {
    const checked = await inCopy(
      this.transport,
      place.dir,
      [
        "perl",
        "-e",
        MOUNT_CHECK_PERL,
        "--",
        place.root,
        MOUNTINFO_PATH,
        "probe",
        RENAME_PROBE,
      ],
      { token: this.token },
    );
    if (checked.exitCode === 0) return;
    const target = describeTarget(this.transport);
    if (checked.exitCode === PROBE_STRANDED) {
      // `keep` adds the way back, once it has looked at what the directory holds.
      throw new ProbeStrandedError(
        `[backwpup/content-copy] ${target}: checking wp-content could be renamed, its tree was ` +
          `exchanged with an empty directory and could not be exchanged back ` +
          `(${inCopyProblem(checked)}). The restore was not run.`,
      );
    }
    throw new Error(
      `[backwpup/content-copy] ${target}: refusing to copy wp-content as root — ${swapProblem(checked)}. ` +
        "The restore was not run.",
    );
  }

  /**
   * Refuses a copy the disk has no room for: what the content directory holds twice — the copy, then
   * the tree its put-back extracts beside the site's — plus headroom.
   *
   * @param place - where the copy goes.
   * @throws {@link Error} naming both sizes, or saying they could not be told.
   */
  private async assertRoom(place: CopyPlace): Promise<void> {
    const [du, df] = await Promise.all([
      execElevated(this.transport, "du", ["-sk", "--", place.content]),
      exec(this.transport, "df", ["-Pk", "--", place.root]),
    ]);
    const room = parseCopyRoom(du, df);
    const target = describeTarget(this.transport);
    if (room === undefined) {
      throw new Error(
        `[backwpup/content-copy] ${target}: could not tell whether the disk has room for a copy of ` +
          `wp-content (du: ${du.stdout.trim().slice(0, 100) || du.stderr.trim().slice(0, 100) || "no output"}). ` +
          "The restore was not run.",
      );
    }
    if (room.freeKb < 2 * room.usedKb + COPY_HEADROOM_KB) {
      throw new Error(
        `[backwpup/content-copy] ${target}: a copy of wp-content, and the tree its put-back ` +
          `extracts beside the site's, need about ${String(Math.ceil((2 * room.usedKb) / 1024))} MB ` +
          `and 1 GB to spare, but only ${String(Math.floor(room.freeKb / 1024))} MB are free. The ` +
          "restore was not run.",
      );
    }
  }

  /**
   * Refuses a whole copy whose put-back would find no room for its second tree
   * ({@link ROOM_CHECK_SCRIPT}, measured as the put-back measures): a tree of small files takes up to
   * twice its archive, which the size checked before the copy cannot tell.
   *
   * @param place - where the copy is.
   * @throws {@link Error} naming what is short; the restore is then not run.
   */
  private async assertPutBackRoom(place: CopyPlace): Promise<void> {
    const checked = await inCopy(
      this.transport,
      place.dir,
      ["sh", "-c", ROOM_CHECK_SCRIPT, "sh", String(COPY_HEADROOM_KB)],
      { token: this.token },
    );
    if (checked.exitCode === 0) return;
    throw new Error(
      `[backwpup/content-copy] ${describeTarget(this.transport)}: the copy of wp-content is taken, ` +
        `but its put-back would find no room for the tree it extracts beside the site's ` +
        `(${inCopyProblem(checked)}). The restore was not run.`,
    );
  }

  /**
   * Takes the copy, proves it reads back whole — a `tar` that exited 1 for a reason it should not
   * have, `sudo` refusing it included, leaves no archive or a short one — then seals it.
   *
   * @param place - where the copy goes.
   * @param keptOut - paths relative to the content directory left out of it.
   * @throws {@link Error} naming the step that failed; the restore is then not run.
   */
  private async copy(
    place: CopyPlace,
    keptOut: readonly string[],
  ): Promise<void> {
    const target = describeTarget(this.transport);
    const made = await inCopy(
      this.transport,
      place.dir,
      ["tar", ...copyArgv(CONTENT_COPY_PARTIAL, place.root, keptOut)],
      { token: this.token },
    );
    const benign = made.exitCode === 1 && benignCopyWarnings(made.stderr);
    if (made.exitCode !== 0 && !benign) {
      throw new Error(
        `[backwpup/content-copy] ${target}: could not copy wp-content before the restore ` +
          `(${inCopyProblem(made)}). The restore was not run.`,
      );
    }
    if (benign) {
      console.warn(
        `[backwpup/content-copy] ${target}: files changed while wp-content was copied — ` +
          made.stderr.trim().slice(0, 300),
      );
    }
    const listed = await inCopy(
      this.transport,
      place.dir,
      ["tar", "-tf", CONTENT_COPY_PARTIAL],
      { token: this.token },
    );
    if (!readsBackWhole(listed)) {
      throw new Error(
        `[backwpup/content-copy] ${target}: the copy of wp-content does not read back ` +
          `(${inCopyProblem(listed)}). The restore was not run.`,
      );
    }
    await this.seal(place);
    await this.assertPutBackRoom(place);
  }

  /**
   * Names the copy whole ({@link CONTENT_COPY_FILE}) once it is on disk — its data, then the rename —
   * so a crash cannot leave that name on a copy whose data never reached the disk.
   *
   * @param place - where the copy is.
   * @throws {@link Error} naming the step that failed; the restore is then not run.
   */
  private async seal(place: CopyPlace): Promise<void> {
    for (const argv of [
      ["sync", "--", CONTENT_COPY_PARTIAL],
      ["mv", "-T", "--", CONTENT_COPY_PARTIAL, CONTENT_COPY_FILE],
      ["sync", "--", "."],
    ]) {
      const result = await inCopy(this.transport, place.dir, argv, {
        token: this.token,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `[backwpup/content-copy] ${describeTarget(this.transport)}: could not finish the copy of ` +
            `wp-content (${argv[0] ?? ""}: ${inCopyProblem(result)}). The restore was not run.`,
        );
      }
    }
  }

  /**
   * Removes a copy that failed, logging — never throwing over — a removal that failed too, so the
   * copy's own failure is the one reported.
   *
   * @param place - where the copy is.
   * @param token - this run's token, once written; none before.
   */
  private async discard(place: CopyPlace, token?: string): Promise<void> {
    try {
      await discardCopy(this.transport, place, token);
    } catch (error) {
      console.warn(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not remove the failed copy ` +
          `in ${place.dir} (${errorMessage(error)}); ${removeByHand(place, undefined)}`,
      );
    }
  }
}
