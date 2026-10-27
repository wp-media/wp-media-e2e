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
import type { DatabaseDefaults } from "./database-defaults";

/**
 * A copy of a site's `wp-content`, taken before a command that rewrites it wholesale and put back
 * exactly afterwards — for `wp backwpup restore`, which deletes what its archive does not hold and
 * writes the rest back as the transport's user (measured on `pro@nginx`).
 *
 * **Root does both halves, from the start** — the one place elevation is not a fallback: only root
 * reads every file the web server owns and puts every owner back. Without passwordless `sudo` the
 * copy is refused, and with it the command: a rewrite that could not be undone must not run on a
 * shared cell.
 *
 * **The copy outlives a failure on purpose.** It is kept in a root-only directory at the WordPress
 * root ({@link CONTENT_COPY_DIR}) — not the scenario's staging area, which every worker's teardown
 * wipes — and removed only once it is back. A put-back that failed, or a run killed between the
 * command and the put-back, leaves it there with `wp-content` possibly as the command left it, and
 * BackWPup runs then refuse that site until someone settles it, or until a later boot of the host
 * proves no run still uses it (`./content-copy-leftover.ts`).
 *
 * **What a leftover holds says how far its run got**: tar writes {@link CONTENT_COPY_PARTIAL}, named
 * {@link CONTENT_COPY_FILE} only once it reads back and is on disk — the command runs only after;
 * {@link CONTENT_COPY_RESTORED} once put back. And **every use is stamped** with the host's boot id
 * ({@link CONTENT_COPY_STAMP}) just before it — the directory made, the command run, the put-back —
 * so a stamp from another boot proves no run still uses it. A restore reaching the database too
 * leaves the database's defaults beside the copy ({@link CONTENT_COPY_DB_DEFAULTS}), for a recovery
 * to set back.
 *
 * **Root acts only inside the directory it proved is the copy's** ({@link IN_COPY_SCRIPT}): whoever
 * may write the WordPress root could otherwise swap the directory for a link between a check and
 * root's command. The WordPress root itself and `wp-content` are guarded as before, by path. And the
 * run that made a copy acts on it only while it holds the run's random token
 * ({@link CONTENT_COPY_TOKEN}): a run outliving a reboot whose copy another run settled must not stamp,
 * put back or remove the next run's copy at the same path.
 *
 * Modes, owners and hard links are kept; ACLs and extended attributes are not (none on the cells,
 * measured with `getfacl`).
 */

/** Where a copy is kept, relative to the WordPress root: root-only (`0700`), so never served. */
export const CONTENT_COPY_DIR = ".e2e_content_copy";

/**
 * The copy's file name in {@link CONTENT_COPY_DIR}, given only once it read back whole and is on disk.
 * A `tar -cf` cut short at a record boundary leaves an archive `tar -tf` lists without complaint (exit
 * 0, measured with GNU tar 1.35), so only this name tells a finished copy from one a reboot cut short.
 */
export const CONTENT_COPY_FILE = "wp-content.verified.tar";

/** The name tar writes the copy under, until it reads back whole. */
export const CONTENT_COPY_PARTIAL = "wp-content.partial.tar";

/** The whole copy's name once it is back — in the same root command — so it never goes back twice. */
export const CONTENT_COPY_RESTORED = "wp-content.restored.tar";

/**
 * Written beside a whole copy that went back when it could not be renamed {@link CONTENT_COPY_RESTORED}:
 * it then counts as back just the same.
 */
export const CONTENT_COPY_EXTRACTED = "put-back.done";

/**
 * The name copies were once kept under, before the names above: such a leftover is never taken for a
 * whole copy, only named in the way back it is refused with.
 */
export const LEGACY_COPY_FILE = "wp-content.tar";

/** The file holding the boot id of the host's last boot that used the copy. */
export const CONTENT_COPY_STAMP = "boot-id";

/** The file holding the random token of the run that made the copy. */
export const CONTENT_COPY_TOKEN = "token";

/** The file holding the database's defaults, as JSON, when the restore reaches the database too. */
export const CONTENT_COPY_DB_DEFAULTS = "database-defaults.json";

/** The files beside a copy that say about it, never part of it. */
const COPY_NOTES: readonly string[] = [
  CONTENT_COPY_STAMP,
  CONTENT_COPY_TOKEN,
  CONTENT_COPY_DB_DEFAULTS,
];

/** Where Linux keeps the current boot's id: a random UUID, new at every boot. */
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * What a copy's directory is renamed to, plus a unique suffix, when a later run claims it to settle it
 * (`./content-copy-leftover.ts`). Such a directory is a leftover too.
 */
export const RECOVERING_PREFIX = `${CONTENT_COPY_DIR}.recovering-`;

/**
 * {@link IN_COPY_SCRIPT}'s token when none is asked. Never empty: node-ssh drops an empty argument
 * (measured), which would shift every one after it.
 */
export const NO_TOKEN = "-";

/**
 * `sh` program run as root around every command on a copy's contents: positional `make|use`, the
 * directory, the run's token ({@link NO_TOKEN}: none asked), then the command's argv, run there by `exec` —
 * values only ever as arguments. `make` creates the directory first (`0700`, so never a moment open)
 * and writes the token into it. It then refuses unless the directory is there
 * ({@link COPY_DIR_GONE}), is the one named, not a link to another one, and root's alone
 * ({@link NOT_THE_COPY_DIR}) — so once it is the working directory nothing renamed under the
 * WordPress root can redirect the command — and, a token given, holds it ({@link NOT_THIS_RUNS_COPY}).
 */
export const IN_COPY_SCRIPT = [
  "m=$1 d=$2 t=$3; shift 3",
  'if [ "$m" = make ]; then mkdir -m 0700 -- "$d" || exit 93; fi',
  '[ -e "$d" ] || [ -L "$d" ] || exit 97',
  'p=$(cd -P -- "$(dirname -- "$d")" && pwd -P) || exit 90',
  'cd -P -- "$d" 2>/dev/null || exit 90',
  '[ "$(pwd -P)" = "${p%/}/$(basename -- "$d")" ] || exit 90',
  '[ "$(stat -c %u:%a .)" = 0:700 ] || exit 90',
  `if [ "$m" = make ]; then printf '%s\\n' "$t" > ${CONTENT_COPY_TOKEN} || exit 98; fi`,
  `if [ "$t" != ${NO_TOKEN} ] && [ "$(cat ${CONTENT_COPY_TOKEN} 2>/dev/null)" != "$t" ]; then exit 96; fi`,
  'exec "$@"',
].join("\n");

/** {@link IN_COPY_SCRIPT}'s exit when the directory is a link, or not root's alone. */
export const NOT_THE_COPY_DIR = 90;

/** {@link IN_COPY_SCRIPT}'s exit when `make` could not create the directory — not this run's then. */
export const COPY_DIR_NOT_MADE = 93;

/** {@link IN_COPY_SCRIPT}'s exit when the directory holds another run's token. */
export const NOT_THIS_RUNS_COPY = 96;

/** {@link IN_COPY_SCRIPT}'s exit when nothing is at the directory's path. */
export const COPY_DIR_GONE = 97;

/**
 * `sh` program run as root listing the processes that may still use a site's copies — the pid and
 * program name of each: those whose argv names one (`$1`, the copies' path prefix), those working in
 * one (a command run through {@link IN_COPY_SCRIPT}, whose paths are relative, or under
 * `docker exec`, where no `sudo` parent names it), and `backwpup … restore` ones working in the
 * WordPress root (`$2`) — never another site's. `$3` is the proc filesystem's root. Skips itself and
 * its callers by the marker below, which their argv carry; exits non-zero only when it cannot run.
 */
export const IN_USE_SCRIPT = [
  "# e2e-content-copy-in-use-probe",
  "prefix=$1 proc=$3",
  'root=$(cd -P -- "$2" && pwd -P) || exit 2',
  `real=$root/${CONTENT_COPY_DIR}`,
  'for p in "$proc"/[0-9]*; do',
  '  [ -d "$p" ] || continue',
  `  cmd=$( { tr '\\000' ' ' < "$p/cmdline"; } 2>/dev/null ) || continue`,
  '  case $cmd in ""|*e2e-content-copy-in-use-probe*) continue ;; esac',
  '  cwd=$(readlink -- "$p/cwd" 2>/dev/null) || cwd=',
  "  case $cwd in",
  '    "$real"|"$real"/*|"$real".recovering-*) ;;',
  "    *)",
  "      case $cmd in",
  '        *"$prefix"*) ;;',
  '        *backwpup*restore*) case $cwd in "$root"|"$root"/*) ;; *) continue ;; esac ;;',
  "        *) continue ;;",
  "      esac ;;",
  "  esac",
  `  printf '%s %s\\n' "\${p##*/}" "\${cmd%% *}"`,
  "done",
  "exit 0",
].join("\n");

/**
 * `sh` program putting a copy back, run inside its directory: stamps the boot (exit
 * {@link STAMP_FAILED}), runs tar with the positional arguments ({@link putBackArgv}), then — only
 * when tar succeeded — marks it back: renames the copy {@link CONTENT_COPY_RESTORED}, or, should that
 * fail, writes {@link CONTENT_COPY_EXTRACTED} beside it (exit {@link MARK_FAILED} only when both
 * fail; `printf`, not `:` — a special built-in, whose failed redirection ends dash at once, exit
 * 2), and syncs the directory so the mark outlives a crash. One root command, so no reboot falls
 * between the stamp and the extraction, nor between the extraction and its mark.
 */
export const PUT_BACK_SCRIPT = [
  `cp -- ${BOOT_ID_PATH} ${CONTENT_COPY_STAMP} || exit 94`,
  'tar "$@" || exit $?',
  `mv -T -- ${CONTENT_COPY_FILE} ${CONTENT_COPY_RESTORED} || printf '' > ${CONTENT_COPY_EXTRACTED} || exit 95`,
  "sync -- . || true",
].join("\n");

/** {@link PUT_BACK_SCRIPT}'s exit when the boot stamp could not be written: nothing was put back. */
export const STAMP_FAILED = 94;

/** {@link PUT_BACK_SCRIPT}'s exit when the copy went back but could be marked so neither way. */
export const MARK_FAILED = 95;

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
 * {@link STAMP_ARGV} for `make`: a failed stamp exits {@link STAMP_FAILED}, told apart from a `sudo`
 * that refused before anything was made (exit 1).
 */
const MAKE_STAMP_ARGV: readonly string[] = [
  "sh",
  "-c",
  `cp -- ${BOOT_ID_PATH} ${CONTENT_COPY_STAMP} || exit 94`,
];

/**
 * The `make` exits after which its `mkdir` provably succeeded, so the directory is this run's even
 * with no token in it: refused by a check after it, gone since, no token written, stamp failed.
 */
const MADE_BUT_FAILED: readonly number[] = [90, 94, 97, 98];

/** Writes the current boot's id into the copy's stamp; run inside its directory. */
const STAMP_ARGV: readonly string[] = [
  "cp",
  "--",
  BOOT_ID_PATH,
  CONTENT_COPY_STAMP,
];

/**
 * How long a put-back waits for a restore still running on the site — one a dropped connection left
 * behind — and how often it looks.
 */
export const RESTORE_GONE_WAIT_MS = 5 * 60 * 1000;

/** See {@link RESTORE_GONE_WAIT_MS}. */
export const RESTORE_GONE_POLL_MS = 10_000;

/**
 * Space the copy needs beyond the content directory's own size before it is taken, so the shared disk
 * is never the thing that fills up.
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
 * GNU tar's arguments for putting the copy back, as root, into the WordPress root: each entry with its
 * owner and mode, and `--recursive-unlink`, which empties every directory before extracting into it —
 * `wp-content` first. So it ends as the copy holds it, exactly: what the command added goes, and a
 * directory where the copy has a file is replaced — which a plain extraction refuses, exiting 2
 * half-done. What the copy left out goes too; by then the teardowns have removed it already. A link
 * the command left is removed, never followed. All measured with GNU tar 1.34 and 1.35 (Debian,
 * Ubuntu, Alpine). The archive is opened before `-C` applies, so a name inside the copy's directory
 * works from there (measured).
 *
 * @param archive - the copy's path, or its name inside the copy's directory when run there.
 * @param root - the WordPress root's absolute path.
 */
export function putBackArgv(archive: string, root: string): string[] {
  return ["-xpf", archive, "--recursive-unlink", "-C", root];
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
 * The copies' directories in the WordPress root itself, sorted. Asked as the transport's user: a
 * copy's directory is root-only, but the root lists it to anyone.
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
 * `sh`'s arguments for {@link inCopy}: never an empty one, which node-ssh drops.
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
 * Stamps a copy with the current boot's id: done just before every use.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @param token - the making run's token; none for a run settling another's copy.
 */
export function stampCopy(
  transport: Transport,
  dir: string,
  token?: string,
): Promise<ExecResult> {
  return inCopy(
    transport,
    dir,
    STAMP_ARGV,
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
 * Puts a whole copy back as root ({@link PUT_BACK_SCRIPT}): stamped, extracted, marked back.
 *
 * @param transport - the site.
 * @param place - where the copy is.
 * @param token - the making run's token; none for a run settling another's copy.
 * @throws {@link Error} if it is no longer the run's (gone, or another's: nothing put back), could not
 * be stamped (nothing put back), extracted (`wp-content` may then be half put back), or marked back —
 * each message says what to do.
 */
export async function putBackCopy(
  transport: Transport,
  place: CopyPlace,
  token?: string,
): Promise<void> {
  const result = await inCopy(
    transport,
    place.dir,
    [
      "sh",
      "-c",
      PUT_BACK_SCRIPT,
      "sh",
      ...putBackArgv(CONTENT_COPY_FILE, place.root),
    ],
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
      : `could not put wp-content back (${inCopyProblem(result)}); it may be partly as the restore left it. `;
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
      "rm",
      "-f",
      "--",
      CONTENT_COPY_PARTIAL,
      CONTENT_COPY_FILE,
      CONTENT_COPY_RESTORED,
      CONTENT_COPY_EXTRACTED,
      ...COPY_NOTES,
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
  console.warn(
    `[backwpup/content-copy] ${describeTarget(transport)}: could not remove ${place.dir}; ` +
      `remove it by hand (\`sudo rm -r ${place.dir}\`) — BackWPup runs refuse this site until it ` +
      "is gone.",
  );
  return false;
}

/** A copy that is no longer the run's: gone, or another run's — settled by a run after a reboot. */
export class CopyNotThisRunsError extends Error {}

/**
 * What to tell a run whose copy is no longer its own: another run settled it, after a reboot.
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
    `run's (${inCopyProblem(result)}) — another run settled it, so nothing was put back.`
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
  return (
    `${head} That run's \`wp backwpup restore\` may have left wp-content damaged (files ` +
    "deleted, others owned by the transport's user) and never put it back. If it is damaged, put " +
    `the copy back: \`sudo tar -xpf ${path} --recursive-unlink -C ${place.root}\`; either way ` +
    `remove it then: \`sudo rm -r ${place.dir}\`. ${tail}`
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

/**
 * A copy of the site's content directory, taken before a command that rewrites it wholesale and put
 * back afterwards — see the module header.
 */
export class ContentCopy {
  /** Where the copy is, once taken. */
  private place: CopyPlace | undefined;

  /** Whether the copy has been put back, or is no longer this run's. */
  private restored = false;

  /** The host's boot id when the copy was taken. */
  private bootId: string | undefined;

  /** This run's token, written into the copy it makes. */
  private readonly token = randomBytes(16).toString("hex");

  /**
   * @param transport - the scenario's site.
   * @param leaveOut - works out, when the copy is taken, what it leaves out — paths relative to the
   * content directory that the scenario's own teardowns remove.
   * @param wait - how long {@link ContentCopy.putBack} waits for a restore still running on the site,
   * and how often it looks.
   */
  constructor(
    private readonly transport: Transport,
    private readonly leaveOut: () => Promise<readonly string[]>,
    private readonly wait: {
      readonly boundMs: number;
      readonly pollMs: number;
    } = {
      boundMs: RESTORE_GONE_WAIT_MS,
      pollMs: RESTORE_GONE_POLL_MS,
    },
  ) {}

  /** Whether a copy is waiting to be put back. */
  get kept(): boolean {
    return this.place !== undefined && !this.restored;
  }

  /**
   * Takes the copy, once per scenario: the first is the state to return to.
   *
   * @throws {@link Error} — and the command must then not run — if the host cannot elevate, a path is
   * unsafe for root, an earlier run's copy is still there, the disk has no room, or the copy could not
   * be taken whole.
   */
  async keep(): Promise<void> {
    if (this.place !== undefined) return;
    const place = await copyPlace(this.transport);
    await this.assertUsable(place);
    await this.assertRoom(place);
    const keptOut = await this.leaveOut();
    this.bootId = await currentBootId(this.transport);
    // Made, tokened and stamped in one root command: a reboot cut it short leaves the directory
    // empty, or holding a token alone — none to put back, which a later run removes.
    const made = await inCopy(this.transport, place.dir, MAKE_STAMP_ARGV, {
      mode: "make",
      token: this.token,
    });
    if (made.exitCode !== 0) {
      // Removed without its token only where that very command's `mkdir` provably succeeded; any
      // other failure (`sudo` refusing, a missing shell, `mkdir` itself) may be another run's.
      if (MADE_BUT_FAILED.includes(made.exitCode)) await this.discard(place);
      throw new Error(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not prepare ${place.dir} ` +
          `for the copy (${inCopyProblem(made)}). The restore was not run.`,
      );
    }
    try {
      await this.copy(place, keptOut);
    } catch (error) {
      // Nothing has been rewritten yet, so a copy that failed is no leftover to settle.
      await this.discard(place, this.token);
      throw error;
    }
    this.place = place;
  }

  /**
   * Stamps the copy just before the command runs, so a reboot during it orphans the copy provably —
   * then checks the host has not rebooted since the copy was taken: a reboot after the stamp would let
   * the command, run on reconnecting, rewrite the site while another run settles the copy. This
   * narrows that window to the moment between this check and the command; it cannot close it. Does
   * nothing when no copy is kept.
   *
   * @throws {@link Error} if it could not stamp, or the host rebooted — the command must then not run,
   * and the copy stays for the put-back, or a run settling it.
   */
  async stamp(): Promise<void> {
    if (!this.kept || this.place === undefined) return;
    const target = describeTarget(this.transport);
    const stamped = await stampCopy(this.transport, this.place.dir, this.token);
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
   * Saves the database's defaults beside the copy, for a run settling it after a reboot to set back:
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
   * connection left running would go on rewriting under the put-back. Does nothing when no copy was
   * taken, or it is back already.
   *
   * @throws {@link Error} if a restore still runs past the bound, or it could not be told, or the copy
   * could not be put back — the copy is then **kept**, and the message says how to put it back by
   * hand; or if the copy is no longer this run's (another run settled it after a reboot).
   */
  async putBack(): Promise<void> {
    const place = this.place;
    if (place === undefined || this.restored) return;
    await this.awaitNoUsers(place);
    try {
      await putBackCopy(this.transport, place, this.token);
    } catch (error) {
      // Not this run's any more: nothing of it to keep.
      if (error instanceof CopyNotThisRunsError) {
        this.restored = true;
      }
      throw error;
    }
    this.restored = true;
    await discardCopy(this.transport, place, this.token);
  }

  /**
   * Waits, polling, while any process may use the site's copies or a restore runs in its root.
   *
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
   * content or copy directory that is a link, and a copy an earlier run left.
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
    const [leftover] = await findLeftovers(this.transport, place.root);
    if (leftover !== undefined) {
      throw new Error(
        `${leftoverMessage(target, copyPlaceIn(place.root, leftover))} The restore was not run.`,
      );
    }
  }

  /**
   * Refuses a copy the disk has no room for: what the content directory holds, plus headroom.
   *
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
    if (room.freeKb < room.usedKb + COPY_HEADROOM_KB) {
      throw new Error(
        `[backwpup/content-copy] ${target}: a copy of wp-content needs about ` +
          `${String(Math.ceil(room.usedKb / 1024))} MB and 1 GB to spare, but only ` +
          `${String(Math.floor(room.freeKb / 1024))} MB are free. The restore was not run.`,
      );
    }
  }

  /**
   * Takes the copy, proves it reads back whole — a `tar` that exited 1 for a reason it should not
   * have, `sudo` refusing it included, leaves no archive or a short one — then seals it.
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
  }

  /**
   * Names the copy whole ({@link CONTENT_COPY_FILE}) once it is on disk — its data, then the rename —
   * so a crash cannot leave that name on a copy whose data never reached the disk.
   *
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
   * @param token - this run's token, once written; none before.
   */
  private async discard(place: CopyPlace, token?: string): Promise<void> {
    try {
      await discardCopy(this.transport, place, token);
    } catch (error) {
      console.warn(
        `[backwpup/content-copy] ${describeTarget(this.transport)}: could not remove the failed copy ` +
          `in ${place.dir} (${errorMessage(error)}); remove it by hand: \`sudo rm -r ${place.dir}\`.`,
      );
    }
  }
}
