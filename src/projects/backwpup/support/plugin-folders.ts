import { posix } from "node:path";

import { FILE_MARKER_NAME } from "./markers";
import {
  listLocatedFiles,
  locateFromWorkingDir,
} from "../../../common/wp/files";
import { isPathSegment } from "../../../common/wp/paths";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import type { SiteDirectory } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * BackWPup's two folders on a site — where a job's archives land, and where every run's log goes —
 * read straight off the filesystem.
 *
 * **Why read the folders when the commands list them too.** `wp backwpup backup`, `log` and the
 * commands that delete from them all walk these folders through the plugin's own listing code, so a
 * scenario asking one of them whether another removed a file would be asking the code under test to
 * mark its own work. These readers take only the folders' *locations* from the plugin — the settings
 * a user configures — and list what is really there with PHP's own `scandir`.
 */

/**
 * PHP that refuses to go on without the plugin's classes, which is what the folders' locations are
 * read through. A site without BackWPup loaded would otherwise fatal with a message naming neither.
 */
const PLUGIN_LOADED_PHP = `
if ( ! class_exists( 'BackWPup_File' ) || ! class_exists( 'BackWPup_Option' ) ) {
	WP_CLI::error( 'BackWPup is not loaded, so where it keeps its files cannot be read' );
}
`;

/** PHP setting `$dir` to the log folder — `backwpup_cfg_logfolder`, made absolute the plugin's way. */
const LOG_FOLDER_PHP = `${PLUGIN_LOADED_PHP}$dir = BackWPup_File::get_absolute_path( get_site_option( 'backwpup_cfg_logfolder' ) );
`;

/**
 * A job run's log, by the plugin's own naming: `backwpup_log_<hash>_<date>_<time>.html`, or `.html.gz`
 * once compressed.
 *
 * The folder also holds the guard files the plugin writes beside the logs — `index.php`, and
 * `.htaccess` when it takes the server for Apache, as it does inside WP-CLI — and neither is a log.
 */
const LOG_FILE = /^backwpup_log_.+\.html(?:\.gz)?$/;

/** Whether a file in the log folder is one of the plugin's run logs. */
export function isLogFile(name: string): boolean {
  return LOG_FILE.test(name);
}

/**
 * PHP setting `$dir` to a job's backup folder — the job's own `backupdir`, made absolute the plugin's
 * way — which is where the Website Server destination writes its archives.
 */
function backupFolderPhp(jobId: number): string {
  return `${PLUGIN_LOADED_PHP}$dir = BackWPup_File::get_absolute_path( BackWPup_Option::get( ${phpLiteral(jobId)}, 'backupdir' ) );\n`;
}

/**
 * What a job's backup folder holds.
 *
 * @param transport - the site to ask.
 * @param jobId - the job whose folder to read.
 * @param options - `digests` hashes every file too, on the site.
 * @throws {@link Error} if BackWPup is not loaded, or the folder is not there or cannot be read.
 */
export async function readBackupFolder(
  transport: Transport,
  jobId: number,
  options: { readonly digests?: boolean } = {},
): Promise<SiteDirectory> {
  return listLocatedFiles(
    transport,
    backupFolderPhp(jobId),
    `job ${String(jobId)}'s backup folder`,
    { digests: options.digests === true },
  );
}

/**
 * PHP setting `$path` to one archive in a job's backup folder, and stopping when the folder holds no
 * such file — for a snippet asking something of that archive.
 *
 * @param jobId - the job whose folder holds the archive.
 * @param name - the archive's filename, as its run recorded it.
 * @throws {@link Error} if the name is not a single path segment, which no archive's name is.
 */
export function backupArchivePhp(jobId: number, name: string): string {
  if (!isPathSegment(name)) {
    throw new Error(
      `[backwpup/plugin-folders] "${name}" is not an archive's name: it must be a single path segment.`,
    );
  }
  return (
    `${backupFolderPhp(jobId)}$path = rtrim( $dir, '/' ) . '/' . ${phpLiteral(name)};\n` +
    "if ( ! is_file( $path ) ) {\n" +
    "\tWP_CLI::error( 'no archive ' . basename( $path ) . ' in ' . $dir );\n" +
    "}\n"
  );
}

/**
 * An archive in a job's backup folder as a command run in WP-CLI's working directory reaches it —
 * which is how `backup-encrypt` and `backup-decrypt` take an archive, where the other commands take
 * its name.
 *
 * @param transport - the site holding the archive.
 * @param jobId - the job whose folder holds it.
 * @param name - the archive's filename.
 * @throws {@link Error} if the name is not a single segment, BackWPup is not loaded, the folder holds
 * no such file, or the site could not say where it or WP-CLI is.
 */
export function backupPathFromWorkingDir(
  transport: Transport,
  jobId: number,
  name: string,
): Promise<string> {
  return locateFromWorkingDir(
    transport,
    backupArchivePhp(jobId, name),
    `the archive ${name}`,
  );
}

/**
 * The run logs in the plugin's log folder — its protective files left out.
 *
 * @param transport - the site to ask.
 * @throws {@link Error} if BackWPup is not loaded, or the folder is not there or cannot be read — a
 * folder that was never created has no logs to report, and "none" would pass every assertion that
 * a log was deleted.
 */
export async function readLogFolder(
  transport: Transport,
): Promise<SiteDirectory> {
  const folder = await listLocatedFiles(
    transport,
    LOG_FOLDER_PHP,
    "the log folder",
  );
  return {
    dir: folder.dir,
    files: folder.files.filter((file) => isLogFile(file.name)),
  };
}

/**
 * Takes the write permission away from one log, so the identity site commands run as may no longer
 * write it.
 *
 * The state a log is in on a host where the web server writes it under a stricter file mode than
 * this suite's cells use: BackWPup gives its logs WordPress's `FS_CHMOD_FILE`, which these cells
 * derive as `0777` from their docroot's `index.php`, so there no log is ever beyond WP-CLI's reach
 * on its own.
 * Arranged on a log that identity wrote, because only a file's owner may change its mode —
 * and it is a scenario's own arrangement on a file its own run made, not ownership housekeeping:
 * nothing is handed to anyone, nothing runs elevated, and the plugin's data folders go with the rest
 * of its residue at the end of the scenario.
 *
 * @param transport - the site holding the log.
 * @param name - the log's filename.
 * @throws {@link Error} if there is no such log, if its mode could not be changed, or if the
 * identity may still write it afterwards — a user running with privileges that ignore file
 * modes, for whom the premise cannot be arranged at all.
 */
export async function makeLogReadOnly(
  transport: Transport,
  name: string,
): Promise<void> {
  const php =
    `${LOG_FOLDER_PHP}$name = ${phpLiteral(name)};\n` +
    "$path = rtrim( $dir, '/' ) . '/' . basename( $name );\n" +
    "if ( ! is_file( $path ) ) {\n" +
    "\tWP_CLI::error( 'no log named ' . $name . ' in ' . $dir );\n" +
    "}\n" +
    "if ( ! @chmod( $path, fileperms( $path ) & 0555 ) ) {\n" +
    "\t$reason = error_get_last();\n" +
    "\tWP_CLI::error( 'could not make ' . $path . ' read-only (only its owner may): ' . ( $reason['message'] ?? 'no reason given' ) );\n" +
    "}\n" +
    "clearstatcache( true, $path );\n" +
    "if ( is_writable( $path ) ) {\n" +
    "\tWP_CLI::error( $path . ' is still writable by this user, which file modes do not restrict' );\n" +
    "}\n" +
    "echo 'read-only';";
  const reply = await evalPhp(
    transport,
    php,
    `making the log ${name} read-only`,
    "backwpup/plugin-folders",
  );
  if (reply !== "read-only") {
    throw new Error(
      `[backwpup/plugin-folders] making the log ${name} read-only answered ${JSON.stringify(reply)}.`,
    );
  }
}

/**
 * A path that starts in the log folder, leads out of it, and ends at the marker file the `markers`
 * fixture plants under `wp-content` — the argument a log command must refuse to follow.
 *
 * It climbs to the filesystem root and back down, so it reaches the file wherever the two folders
 * sit relative to each other, and it is **proved on the site before it is used**: it must resolve to
 * the marker, the marker must be writable by the identity site commands run as, and the log folder must not hold
 * a file of the marker's own name. Without those, a command refusing it would prove nothing — it
 * might have been handed a path to nowhere, a delete that got through could have been stopped by
 * permissions instead, and a command that kept only the last part of the path would have found a
 * real file in its own folder.
 *
 * @param transport - the site, with the marker already planted.
 * @returns the path, relative to the log folder.
 * @throws {@link Error} if the log folder or the marker is missing, or the path fails any of the
 * checks above.
 */
export async function markerPathFromLogFolder(
  transport: Transport,
): Promise<string> {
  const php =
    `${LOG_FOLDER_PHP}$dir = realpath( $dir );\n` +
    `$target = realpath( WP_CONTENT_DIR . '/' . ${phpLiteral(FILE_MARKER_NAME)} );\n` +
    "if ( false === $dir ) {\n" +
    "\tWP_CLI::error( 'the log folder does not exist' );\n" +
    "}\n" +
    "if ( false === $target ) {\n" +
    "\tWP_CLI::error( 'the marker file is not on the site, so there is nothing to lead to — plant it first' );\n" +
    "}\n" +
    "$depth = count( array_filter( explode( '/', $dir ), 'strlen' ) );\n" +
    "$path  = str_repeat( '../', $depth ) . ltrim( $target, '/' );\n" +
    "if ( realpath( $dir . '/' . $path ) !== $target ) {\n" +
    "\tWP_CLI::error( $path . ' does not lead from ' . $dir . ' to ' . $target );\n" +
    "}\n" +
    "if ( ! is_writable( $target ) ) {\n" +
    "\tWP_CLI::error( $target . ' is not writable by this user, so a delete reaching it would be refused anyway' );\n" +
    "}\n" +
    "if ( file_exists( $dir . '/' . basename( $target ) ) ) {\n" +
    "\tWP_CLI::error( 'the log folder holds a file named ' . basename( $target ) . ' itself' );\n" +
    "}\n" +
    "echo $path;";
  const path = await evalPhp(
    transport,
    php,
    "finding a path from the log folder to the marker file",
    "backwpup/plugin-folders",
  );
  if (!path.startsWith("../") || posix.basename(path) !== FILE_MARKER_NAME) {
    throw new Error(
      `[backwpup/plugin-folders] expected a path leading out of the log folder to ${FILE_MARKER_NAME}, got ${JSON.stringify(path)}.`,
    );
  }
  return path;
}
