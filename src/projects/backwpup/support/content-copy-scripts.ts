import {
  CONTENT_COPY_LEASE,
  LEASE_NEXT,
  RENEW_FUNCTION,
} from "./content-copy-lease";

/**
 * The names, root scripts and exit codes of the copy of `wp-content` (`./content-copy.ts`): what root
 * runs on a site, kept apart from the TypeScript driving it so each script reads whole. Every run-time
 * value reaches a script as an argument, never spliced into its text.
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

/**
 * The put-back's root-only scratch directory in the copy's: the tree extracted (`new/`), and the trees
 * swapped out of `wp-content` (`old.<n>`) until removed. Never part of the copy: a put-back starts by
 * emptying it, and the archive alone says what goes back.
 */
export const CONTENT_COPY_SCRATCH = "swap";

/** The files beside a copy that say about it, never part of it. */
export const COPY_NOTES: readonly string[] = [
  CONTENT_COPY_STAMP,
  CONTENT_COPY_TOKEN,
  CONTENT_COPY_DB_DEFAULTS,
  CONTENT_COPY_LEASE,
  LEASE_NEXT,
  CONTENT_COPY_SCRATCH,
];

/** Where Linux keeps the current boot's id: a random UUID, new at every boot. */
export const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

/**
 * What a copy's directory is renamed to, plus a unique suffix, when a later run claims it to settle it
 * (`./content-copy-leftover.ts`). Such a directory is a leftover too.
 */
export const RECOVERING_PREFIX = `${CONTENT_COPY_DIR}.recovering-`;

/**
 * {@link IN_COPY_SCRIPT}'s token when none is asked. Never empty: a transport dropping an empty
 * argument (node-ssh's own escaping did, measured live) would shift every one after it.
 */
export const NO_TOKEN = "-";

/** {@link IN_COPY_SCRIPT}'s exit when the directory is a link, or not root's alone. */
export const NOT_THE_COPY_DIR = 90;

/** {@link IN_COPY_SCRIPT}'s exit when `make` could not create the directory — not this run's then. */
export const COPY_DIR_NOT_MADE = 93;

/** {@link IN_COPY_SCRIPT}'s exit when the directory holds another run's token. */
export const NOT_THIS_RUNS_COPY = 96;

/** {@link IN_COPY_SCRIPT}'s exit when nothing is at the directory's path. */
export const COPY_DIR_GONE = 97;

/** {@link IN_COPY_SCRIPT}'s exit when `make` made the directory but could not write the token into it. */
export const TOKEN_NOT_WRITTEN = 98;

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
  `if [ "$m" = make ]; then mkdir -m 0700 -- "$d" || exit ${String(COPY_DIR_NOT_MADE)}; fi`,
  `[ -e "$d" ] || [ -L "$d" ] || exit ${String(COPY_DIR_GONE)}`,
  `p=$(cd -P -- "$(dirname -- "$d")" && pwd -P) || exit ${String(NOT_THE_COPY_DIR)}`,
  `cd -P -- "$d" 2>/dev/null || exit ${String(NOT_THE_COPY_DIR)}`,
  `[ "$(pwd -P)" = "\${p%/}/$(basename -- "$d")" ] || exit ${String(NOT_THE_COPY_DIR)}`,
  `[ "$(stat -c %u:%a .)" = 0:700 ] || exit ${String(NOT_THE_COPY_DIR)}`,
  `if [ "$m" = make ]; then printf '%s\\n' "$t" > ${CONTENT_COPY_TOKEN} || exit ${String(TOKEN_NOT_WRITTEN)}; fi`,
  `if [ "$t" != ${NO_TOKEN} ] && [ "$(cat ${CONTENT_COPY_TOKEN} 2>/dev/null)" != "$t" ]; then exit ${String(NOT_THIS_RUNS_COPY)}; fi`,
  'exec "$@"',
].join("\n");

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
 * `perl` program swapping the extracted copy in for `wp-content` — `perl`, not two `mv`s: a second
 * process to start widens the moment `wp-content` is missing from milliseconds to microseconds, and a
 * request recreating it then (`wp_mkdir_p`) beat five `mv` attempts in 6 runs of 20 in `ubuntu:24.04`,
 * never this one in 40. Arguments: `wp-content`'s path, the scratch directory, how many tries.
 *
 * Moves `wp-content` (whatever is there, a link included, never followed) aside into the scratch,
 * then renames the extracted tree to its path — atomic, and never across filesystems. Whatever a
 * writer recreated at the path meanwhile is moved aside too and the rename tried again; past the last
 * try, what was recreated is moved aside once more and the original moved back. Then proves what is
 * at the path is the extracted tree (device and inode). Exits 0 when it is; 11 when nothing changed
 * (or the original was moved back); 12 when `wp-content` may be missing or another's; 13 when what is
 * at the path is not the extracted tree. No single quote: it travels inside one.
 */
export const SWAP_PERL = [
  "my ($c, $s, $n) = @ARGV;",
  'my @new = lstat("$s/new/wp-content") or do { print STDERR "the extracted copy is missing\\n"; exit 11; };',
  "my $moved = 0;",
  "for my $i (1 .. $n) {",
  "  if (lstat($c)) {",
  '    rename($c, "$s/old.$i") or do { print STDERR "could not move wp-content aside: $!\\n"; exit($moved ? 12 : 11); };',
  "    $moved = 1;",
  "  }",
  '  if (rename("$s/new/wp-content", $c)) {',
  "    my @now = lstat($c);",
  "    exit((@now && $now[0] == $new[0] && $now[1] == $new[1]) ? 0 : 13);",
  "  }",
  '  my $why = "$!";',
  "  next if lstat($c);",
  '  print STDERR "could not move the copy into place: $why\\n";',
  '  exit(rename("$s/old.1", $c) ? 11 : 12);',
  "}",
  'print STDERR "wp-content was made again $n times while the copy was put in its place\\n";',
  "if ($moved) {",
  '  rename($c, "$s/old." . ($n + 1)) if lstat($c);',
  '  exit 11 if rename("$s/old.1", $c);',
  "}",
  "exit 12;",
].join("\n");

/** How many times {@link SWAP_PERL} moves aside a `wp-content` recreated under it. */
export const SWAP_TRIES = 5;

/**
 * The name, in a copy's directory, of the directory {@link MOUNT_CHECK_PERL}'s probe exchanges with
 * `wp-content`. Not a note: a copy's directory left holding it is refused, never removed, since it may
 * then hold the site's own tree.
 */
export const RENAME_PROBE = "rename-probe";

/** What {@link MOUNT_CHECK_PERL} reads the mounts from. */
export const MOUNTINFO_PATH = "/proc/self/mountinfo";

/**
 * `perl` program run as root telling whether `wp-content` can be swapped by a rename — arguments: the
 * WordPress root, the mount table ({@link MOUNTINFO_PATH}), `scan` or `probe`, the probe's directory.
 * Reads every mount point (decoding the table's `\ooo` escapes) and exits {@link MOUNT_INSIDE} when one
 * is at `wp-content` or under it: a rename of a mount point fails (`EBUSY`), and one beneath would be
 * swapped out with the tree, the removal of which then empties the volume (both measured in
 * `ubuntu:24.04`). In `probe` mode, when `wp-content` is on an overlay filesystem — where a directory
 * from a lower layer cannot be renamed (`EXDEV`) — it exchanges `wp-content` with an empty directory
 * and back (`renameat2(RENAME_EXCHANGE)`: atomic, so `wp-content` is never missing) and exits
 * {@link NOT_RENAMEABLE} when it cannot, nothing changed; {@link PROBE_STRANDED} when the exchange
 * back failed, the site's tree then at the probe's path. {@link MOUNTS_UNKNOWN} when it cannot tell.
 * No single quote: it travels inside one. The first line marks it for the specs' stubbed host.
 */
export const MOUNT_CHECK_PERL = [
  "# e2e-content-copy-mount-check",
  "use Cwd (); use POSIX ();",
  "my ($root, $table, $mode, $probe) = @ARGV;",
  'my $real = Cwd::abs_path($root); defined $real or do { print STDERR "could not resolve $root\\n"; exit 24; };',
  'my $c = ($real eq "/" ? "" : $real) . "/wp-content";',
  'open(my $m, "<", $table) or do { print STDERR "could not read $table: $!\\n"; exit 24; };',
  'my ($fs, $longest) = ("", -1);',
  "while (my $line = <$m>) {",
  "  chomp $line;",
  "  my @f = split(/ /, $line);",
  '  my ($sep) = grep { $f[$_] eq "-" } 6 .. $#f;',
  "  next unless defined $sep;",
  "  (my $at = $f[4]) =~ s/\\\\([0-7]{3})/chr(oct($1))/ge;",
  '  if ($at eq $c || index($at, "$c/") == 0) { print STDERR "a mount is at $at\\n"; exit 21; }',
  '  if (($at eq "/" || index("$c/", "$at/") == 0) && length($at) >= $longest) { ($fs, $longest) = ($f[$sep + 1], length($at)); }',
  "}",
  "exit 24 if $longest < 0;",
  'exit 0 unless $mode eq "probe" && $fs eq "overlay";',
  "my %nr = (x86_64 => 316, aarch64 => 276);",
  "my $call = $nr{(POSIX::uname())[4]};",
  'defined $call or do { print STDERR "wp-content is on an overlay filesystem, and whether it can be renamed cannot be checked on this machine\\n"; exit 24; };',
  'mkdir($probe, 0700) or do { print STDERR "could not make $probe: $!\\n"; exit 24; };',
  "if (syscall($call, -100, $c, -100, $probe, 2) != 0) {",
  '  my $why = "$!"; rmdir($probe);',
  '  print STDERR "wp-content cannot be renamed on its overlay filesystem ($why)\\n"; exit 22;',
  "}",
  "for (1 .. 3) {",
  "  if (syscall($call, -100, $c, -100, $probe, 2) == 0) {",
  '    system("rm", "-rf", "--one-file-system", "--", $probe); exit 0;',
  "  }",
  "}",
  'print STDERR "could not exchange wp-content back: $!\\n"; exit 23;',
].join("\n");

/** {@link MOUNT_CHECK_PERL}'s exit when a mount is at `wp-content` or under it. */
export const MOUNT_INSIDE = 21;

/** {@link MOUNT_CHECK_PERL}'s exit when `wp-content` cannot be renamed: nothing changed. */
export const NOT_RENAMEABLE = 22;

/** {@link MOUNT_CHECK_PERL}'s exit when its probe could not exchange `wp-content` back. */
export const PROBE_STRANDED = 23;

/** {@link MOUNT_CHECK_PERL}'s exit when the mounts could not be told. */
export const MOUNTS_UNKNOWN = 24;

/** Inodes a put-back keeps free beyond the second tree's. */
export const INODE_HEADROOM = 10_000;

/** `rm` keeping to the filesystem it starts on, so a mount moved into a tree is never emptied. */
const RM_TREE = "rm -rf --one-file-system --";

/**
 * `sh` lines checking the filesystem holding the copy has room for the tree its put-back extracts,
 * run in the copy's directory with `$room` set (KB to keep free): the archive's size plus a block per
 * member — what a tree of small files takes beyond its archive (twice it, measured) —, and an inode per
 * member plus {@link INODE_HEADROOM} where the filesystem counts inodes (one that does not reports
 * `0`). Exit {@link NO_ROOM} when short, or when the space cannot be told; only a definite shortage of
 * inodes refuses.
 *
 * @param cleanup - commands run, `;`-terminated, before such an exit.
 */
function roomCheckLines(cleanup: string): string[] {
  return [
    `size=$(du -sk -- ${CONTENT_COPY_FILE} | cut -f1) members=$(tar -tf ${CONTENT_COPY_FILE} | wc -l | tr -d " ") block=$(stat -f -c %S -- .)`,
    `free=$(df -Pk -- . | awk 'NR == 2 { print $4 }') inodes=$(df -Pi -- . | awk 'NR == 2 { print $2 ":" $4 }')`,
    `case "$size:$members:$block:$free" in *[!0-9:]*|:*|*::*|*:) echo "free space could not be told ($size:$members:$block:$free)" >&2; ${cleanup}exit 82 ;; esac`,
    "need=$((size + members * block / 1024 + 1))",
    'if [ "$free" -lt $((need + room)) ]; then',
    `  echo "a second tree needs $need KB and $room KB to spare; $free KB are free" >&2; ${cleanup}exit 82`,
    "fi",
    `case "$inodes" in [1-9]*:[0-9]*) if [ "\${inodes#*:}" -lt $((members + ${String(INODE_HEADROOM)})) ]; then`,
    `  echo "a second tree needs $members inodes and ${String(INODE_HEADROOM)} to spare; \${inodes#*:} are free" >&2; ${cleanup}exit 82`,
    "fi ;; esac",
  ];
}

/**
 * `sh` program run as root in a copy's directory once the copy is whole, `$1` the KB to keep free:
 * refuses ({@link NO_ROOM}) a copy whose put-back would find no room for its second tree — checked
 * again by the put-back, which measures the same way.
 */
export const ROOM_CHECK_SCRIPT = ["room=$1", ...roomCheckLines("")].join("\n");

/**
 * `sh` program putting a copy back, run as root inside its directory, positional: the WordPress
 * root, the lease's ttl and holder (`./content-copy-lease.ts`), the room to keep free in KB. One root
 * command, so no reboot falls between the stamp and the put-back, nor between the put-back and its
 * mark. In order, each failure before the swap leaving `wp-content` untouched:
 *
 * 1. Renews the lease and stamps the boot ({@link STAMP_FAILED}).
 * 2. Refuses without `perl` ({@link NO_PERL}), or when no rename can swap `wp-content` — the copy, the
 *    root and `wp-content` not on one filesystem, or a mount at `wp-content` or under it
 *    ({@link MOUNT_CHECK_PERL}) ({@link CROSS_DEVICE}).
 * 3. Empties the scratch ({@link CONTENT_COPY_SCRATCH}: an interrupted put-back's trees) and checks
 *    the filesystem has room for a second tree: the archive's size plus a block per member — what a
 *    tree of small files takes beyond its archive —, the room asked, and an inode per member plus
 *    {@link INODE_HEADROOM} where the filesystem counts inodes ({@link SCRATCH_FAILED},
 *    {@link NO_ROOM}).
 * 4. Extracts the copy into `swap/new` — fresh, root-only, so nothing writes into it — with every
 *    owner and mode, compares it with the archive (`tar -d`: contents, sizes, modes, owners, link
 *    targets), and syncs the filesystem so the tree is on disk before it is named the site's
 *    ({@link STAGE_FAILED}, {@link STAGE_DIFFERS}; the scratch then removed).
 * 5. Swaps it in ({@link SWAP_PERL}): {@link SWAP_UNTOUCHED}, {@link SWAP_BROKEN}, {@link SWAP_REPLACED}.
 * 6. Marks the copy back — renamed {@link CONTENT_COPY_RESTORED}, else {@link CONTENT_COPY_EXTRACTED}
 *    written beside it ({@link MARK_FAILED} when neither; `printf`, not `:`, a special built-in whose
 *    failed redirection ends dash at once) —, expires the lease, and syncs the copy's directory and the
 *    root so the mark and the swap outlive a crash. The trees swapped out stay in the scratch until the
 *    copy is removed (`discardCopy`).
 *
 * It exits only with these codes, or 0: never 1, which is `sudo` refusing it.
 */
export const PUT_BACK_SCRIPT = [
  RENEW_FUNCTION,
  "root=$1 ttl=$2 holder=$3 room=$4 c=$1/wp-content",
  'renew "$ttl" "$holder" || exit 94',
  "command -v perl >/dev/null 2>&1 || { echo 'perl is not installed' >&2; exit 79; }",
  'dev=$(stat -c %d -- .) && [ "$(stat -c %d -- "$root")" = "$dev" ] ||',
  "  { echo 'the copy is not on the WordPress root filesystem' >&2; exit 80; }",
  'if [ -e "$c" ] || [ -L "$c" ]; then',
  `  [ "$(stat -c %d -- "$c")" = "$dev" ] || { echo 'wp-content is on another filesystem (a mount)' >&2; exit 80; }`,
  "fi",
  `perl -e '${MOUNT_CHECK_PERL}' -- "$root" ${MOUNTINFO_PATH} scan - || exit 80`,
  `${RM_TREE} ${CONTENT_COPY_SCRATCH} && mkdir -m 0700 -- ${CONTENT_COPY_SCRATCH} ${CONTENT_COPY_SCRATCH}/new || exit 81`,
  ...roomCheckLines(`${RM_TREE} ${CONTENT_COPY_SCRATCH}; `),
  `tar -xpf ${CONTENT_COPY_FILE} -C ${CONTENT_COPY_SCRATCH}/new || { ${RM_TREE} ${CONTENT_COPY_SCRATCH}; exit 83; }`,
  `tar -df ${CONTENT_COPY_FILE} -C ${CONTENT_COPY_SCRATCH}/new >&2 || { ${RM_TREE} ${CONTENT_COPY_SCRATCH}; exit 84; }`,
  `sync -f -- ${CONTENT_COPY_SCRATCH}/new || { ${RM_TREE} ${CONTENT_COPY_SCRATCH}; exit 83; }`,
  `perl -e '${SWAP_PERL}' -- "$c" ${CONTENT_COPY_SCRATCH} ${String(SWAP_TRIES)}`,
  "case $? in 0) ;; 11) exit 85 ;; 13) exit 87 ;; *) exit 86 ;; esac",
  `mv -T -- ${CONTENT_COPY_FILE} ${CONTENT_COPY_RESTORED} || printf '' > ${CONTENT_COPY_EXTRACTED} || exit 95`,
  'renew 0 "$holder" || true',
  'sync -- . "$root" || true',
].join("\n");

/** {@link PUT_BACK_SCRIPT}'s exit when the stamp or lease could not be written: nothing was put back. */
export const STAMP_FAILED = 94;

/** {@link PUT_BACK_SCRIPT}'s exit when the copy went back but could be marked so neither way. */
export const MARK_FAILED = 95;

/** {@link PUT_BACK_SCRIPT}'s exit when the host has no `perl`: nothing was put back. */
export const NO_PERL = 79;

/**
 * {@link PUT_BACK_SCRIPT}'s exit when no rename can swap `wp-content` — across filesystems, or a mount
 * at or under it: nothing was put back.
 */
export const CROSS_DEVICE = 80;

/** {@link PUT_BACK_SCRIPT}'s exit when the scratch could not be emptied or made: nothing was put back. */
export const SCRATCH_FAILED = 81;

/** {@link PUT_BACK_SCRIPT}'s exit when the disk has no room for a second tree: nothing was put back. */
export const NO_ROOM = 82;

/** {@link PUT_BACK_SCRIPT}'s exit when the copy could not be extracted beside: nothing was put back. */
export const STAGE_FAILED = 83;

/** {@link PUT_BACK_SCRIPT}'s exit when the tree extracted differs from the copy: nothing was put back. */
export const STAGE_DIFFERS = 84;

/** {@link PUT_BACK_SCRIPT}'s exit when `wp-content` could not be swapped out: nothing was put back. */
export const SWAP_UNTOUCHED = 85;

/** {@link PUT_BACK_SCRIPT}'s exit when the swap broke off: `wp-content` may be missing or another's. */
export const SWAP_BROKEN = 86;

/** {@link PUT_BACK_SCRIPT}'s exit when what is at `wp-content` after the swap is not the copy's tree. */
export const SWAP_REPLACED = 87;

/** `sudo`'s exit when it refuses a command — which then never ran. */
export const SUDO_REFUSED = 1;

/**
 * The exits after which the put-back changed nothing: `wp-content` is as the restore left it. Its own
 * refusals before the swap, {@link IN_COPY_SCRIPT}'s refusal of the directory, and `sudo`'s.
 */
const PUT_BACK_UNTOUCHED: readonly number[] = [
  SUDO_REFUSED,
  NOT_THE_COPY_DIR,
  STAMP_FAILED,
  NO_PERL,
  CROSS_DEVICE,
  SCRATCH_FAILED,
  NO_ROOM,
  STAGE_FAILED,
  STAGE_DIFFERS,
  SWAP_UNTOUCHED,
];

/**
 * What a failed put-back did to `wp-content`, for its message.
 *
 * @param exitCode - {@link PUT_BACK_SCRIPT}'s exit, or {@link IN_COPY_SCRIPT}'s around it.
 */
export function putBackDamage(exitCode: number): string {
  if (PUT_BACK_UNTOUCHED.includes(exitCode)) {
    return "nothing was put back; wp-content is as the restore left it";
  }
  if (exitCode === SWAP_BROKEN) {
    return "wp-content may now be missing, or hold only what the site wrote meanwhile";
  }
  if (exitCode === SWAP_REPLACED) {
    return "something replaced wp-content just after the copy was put in its place";
  }
  return "wp-content may be partly as the restore left it";
}

/**
 * `sh` program emptying a copy's directory, run inside it: the scratch's trees first — tried three
 * times, since a process still working in a tree swapped out may add to it while it goes; never past
 * the filesystem it is on — then the files named as arguments. Its exit is not judged: whether the
 * directory then goes is.
 */
export const DISCARD_SCRIPT = [
  `for i in 1 2 3; do ${RM_TREE} ${CONTENT_COPY_SCRATCH} && break; done`,
  'rm -f -- "$@"',
].join("\n");

/**
 * `sh` program run as root before a copy is taken, `$1` the WordPress root: exit 3 when root has no
 * `perl` (the put-back swaps with it), 4 when `wp-content` is on another filesystem than the root (a
 * mount, which no rename crosses). Checked first, so a restore whose copy could not go back never runs;
 * mounts beneath `wp-content` are checked once the copy's directory is made ({@link MOUNT_CHECK_PERL}).
 */
export const HOST_CHECK_SCRIPT = [
  "command -v perl >/dev/null 2>&1 || exit 3",
  'r=$(stat -c %d -- "$1") && c=$(stat -c %d -- "$1/wp-content") || exit 5',
  '[ "$r" = "$c" ] || exit 4',
].join("\n");
