import { phpLiteral } from "../../../common/wp/php-literal";
import type { ExecResult } from "../../../common/wp/exec";

/**
 * The fence on a files restore: `wp backwpup restore` starts only while the copy of `wp-content` taken
 * for it (`./content-copy.ts`) is still at its path, the very directory its run made.
 *
 * The run's root commands are fenced by the copy's token, but the restore runs as the site's identity,
 * which cannot read inside the root-only copy. So the run records the directory's device and inode
 * once it made it, and WP-CLI checks them (`--exec`, PHP run before WordPress loads, in the restore's
 * own process) before the command runs: a recovery claims a copy by renaming it, so a run that slept
 * past its lease and woke after a recovery settled its copy finds nothing there — or another run's
 * directory — and its restore never starts. A restore that passed the check is a `backwpup … restore`
 * process working in the WordPress root since before that check, which the in-use probe a recovery
 * runs after its claim sees (`IN_USE_SCRIPT`). Residual: a directory made at the same path after the
 * recovery that reuses the inode — a second run restoring on the same site meanwhile.
 */

/** The fenced restore's exit when the copy is no longer its run's: WP-CLI's own errors exit 1. */
export const FENCE_EXIT = 75;

/** What the fence prints, so its refusal is told from the command's. */
export const FENCE_MARK = "e2e-content-copy-fence";

/**
 * A directory's identity as `stat -c %d:%i` prints it: device and inode, both decimal.
 *
 * @param text - the output.
 * @returns `undefined` unless it is exactly that.
 */
export function parseDirIdentity(text: string | undefined): string | undefined {
  const trimmed = text?.trim() ?? "";
  return /^\d{1,20}:\d{1,20}$/.test(trimmed) ? trimmed : undefined;
}

/**
 * WP-CLI's global arguments fencing a restore on the copy's directory: PHP that exits
 * {@link FENCE_EXIT} unless `dir` is, unfollowed, the directory `identity` names. Values enter only
 * through `phpLiteral`.
 *
 * @param dir - the copy's directory, absolute.
 * @param identity - its `dev:ino` ({@link parseDirIdentity}).
 */
export function fenceArgs(dir: string, identity: string): string[] {
  const php =
    "(static function () { " +
    `$s = @lstat(${phpLiteral(dir)}); ` +
    `if ( ! is_array( $s ) || $s['dev'] . ':' . $s['ino'] !== ${phpLiteral(identity)} ) { ` +
    `fwrite( STDERR, "Error: ${FENCE_MARK}: the copy of wp-content this restore depends on is no longer this run's, so the restore was not run.\\n" ); ` +
    `exit( ${String(FENCE_EXIT)} ); } })();`;
  return [`--exec=${php}`];
}

/**
 * Whether a fenced command was refused by its fence, not by itself.
 *
 * @param result - the command's result.
 */
export function fenceTripped(
  result: Pick<ExecResult, "exitCode" | "stderr">,
): boolean {
  return result.exitCode === FENCE_EXIT && result.stderr.includes(FENCE_MARK);
}
