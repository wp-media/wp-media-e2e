import { posix } from "node:path";

import { describeTarget, exec } from "../../../common/wp/exec";
import { evalPhp } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import { FILE_MARKER_NAME } from "./markers";
import type { SiteMarkers } from "./markers";
import type { Transport } from "../../../common/config/types";

/**
 * The snapshots `wp backwpup restore --pre-backup` leaves in the server's temp directory.
 *
 * The command exports the database there (`db.sql`, readable by every local account) and copies
 * `wp-content` beside it — 752 MB on `pro@nginx` with the archives — and never removes either
 * (measured). Other runs on the same server share that directory, so a snapshot is attributed by the
 * marker values only one scenario wrote, never by timing alone.
 */

/** Where the command's snapshots go, and the ones there now. */
export interface SnapshotListing {
  /** `get_temp_dir()`, with its trailing slash. */
  readonly dir: string;
  /** Every `backwpup-snapshot-*` directory in it that is not a link. */
  readonly snapshots: readonly string[];
}

/** Lists the snapshot directories in the temp directory WP-CLI uses, as the command computes it. */
export const SNAPSHOTS_PHP = `$dir = trailingslashit( get_temp_dir() );
$found = [];
foreach ( glob( $dir . 'backwpup-snapshot-*', GLOB_ONLYDIR | GLOB_NOSORT ) ?: [] as $path ) {
	if ( ! is_link( $path ) ) {
		$found[] = $path;
	}
}
echo wp_json_encode( [ 'dir' => $dir, 'snapshots' => $found ] );`;

/**
 * Reads {@link SNAPSHOTS_PHP}'s answer.
 *
 * @param reply - the snippet's output.
 * @throws {@link Error} if it is not the shape the snippet gives.
 */
export function parseSnapshots(reply: string): SnapshotListing {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.dir !== "string" ||
    !Array.isArray(parsed.snapshots) ||
    !parsed.snapshots.every((path) => typeof path === "string")
  ) {
    throw new Error(
      `[backwpup/restore-snapshots] listing the restore's snapshots returned an unexpected answer: ` +
        (reply.slice(0, 300) || "(nothing)"),
    );
  }
  return { dir: parsed.dir, snapshots: parsed.snapshots };
}

/**
 * Whether `path` is a snapshot directory the command names: `backwpup-snapshot-` and PHP's
 * `uniqid( '', true )` (hex, a dot, digits) directly inside the temp directory. The last check before
 * an `rm -rf`, so nothing else can be removed through it.
 *
 * @param path - the directory.
 * @param dir - the temp directory it must lie directly inside.
 */
export function isSnapshotPath(path: string, dir: string): boolean {
  const base = dir.endsWith("/") ? dir : `${dir}/`;
  return (
    path.startsWith(base) &&
    /^backwpup-snapshot-[0-9a-f]+\.[0-9]+$/.test(path.slice(base.length))
  );
}

/**
 * The snapshot directories in the temp directory now.
 *
 * @param transport - the scenario's site.
 * @throws {@link Error} if the site could not be asked, or answered in another shape.
 */
export async function listRestoreSnapshots(
  transport: Transport,
): Promise<SnapshotListing> {
  return parseSnapshots(
    await evalPhp(
      transport,
      SNAPSHOTS_PHP,
      "listing the restore's snapshots",
      "backwpup/restore-snapshots",
      { skipPlugins: true },
    ),
  );
}

/** Which of a scenario's marker values a snapshot holds. */
export interface SnapshotContents {
  /** The file marker, in its copy of `wp-content`. */
  readonly file: boolean;
  /** The database marker, in its export. */
  readonly database: boolean;
}

/**
 * Which of the given marker values a snapshot holds: the file marker in its copy of `wp-content`, the
 * database marker in its export. Either alone is enough to attribute it — the command writes the
 * export first, so one cut short holds only that.
 *
 * @param transport - the scenario's site.
 * @param snapshot - the snapshot directory.
 * @param markers - the values to look for.
 */
export async function snapshotHolds(
  transport: Transport,
  snapshot: string,
  markers: SiteMarkers,
): Promise<SnapshotContents> {
  const [file, database] = await Promise.all([
    exec(transport, "cat", [
      "--",
      posix.join(snapshot, "wp-content", FILE_MARKER_NAME),
    ]),
    exec(transport, "grep", [
      "-c",
      "-F",
      "--",
      markers.database,
      posix.join(snapshot, "db.sql"),
    ]),
  ]);
  return {
    file: file.exitCode === 0 && file.stdout === markers.file,
    database: database.exitCode === 0 && Number(database.stdout.trim()) > 0,
  };
}

/**
 * Removes one snapshot the scenario's command made, and confirms it is gone. As the identity site
 * commands run as: the command wrote it as that identity, so nothing else can be reached this way. Teardown, so it never
 * throws; a snapshot left behind is reported with its path.
 *
 * @param transport - the scenario's site.
 * @param snapshot - the snapshot directory.
 * @param dir - the temp directory it must lie directly inside.
 */
export async function removeSnapshot(
  transport: Transport,
  snapshot: string,
  dir: string,
): Promise<void> {
  if (!isSnapshotPath(snapshot, dir)) {
    console.warn(
      `[backwpup/restore-snapshots] not removing "${snapshot}": it is not a snapshot directory in "${dir}".`,
    );
    return;
  }
  await exec(transport, "rm", ["-rf", "--", snapshot]);
  const left = await exec(transport, "test", ["-e", snapshot]);
  if (left.exitCode === 0) {
    console.warn(
      `[backwpup/restore-snapshots] ${describeTarget(transport)}: the restore's snapshot "${snapshot}" ` +
        "could not be removed; it holds a database export — remove it by hand.",
    );
  }
}
