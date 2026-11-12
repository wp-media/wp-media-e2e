import { randomBytes } from "node:crypto";

import { normalizeOwnership } from "../../../common/wp/ownership";
import { pathInsideRoot } from "../../../common/wp/paths";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import type { Transport } from "../../../common/config/types";

/**
 * Known-unique data planted in a site so a backup can be asked whether it really captured it.
 *
 * A backup that exists, is the right size and downloads intact still says nothing about its
 * *contents*. These markers close that gap: one value in a file and one in the database, both random
 * per scenario, so finding them inside an archive proves the run captured the site **as it was when
 * it ran**. A value fixed in advance could not — a stale archive from an earlier run would satisfy
 * it just as well.
 *
 * Having one of each is what lets a scenario assert the *shape* of a backup rather than only its
 * existence: a database-only job must carry the database marker and **not** the file one, and a
 * files-only job the reverse. That is the difference between "a backup happened" and "the backup
 * covered what it was configured to cover".
 *
 * The file marker serves one more question: whether a command handed a path out of its own folder
 * reaches a file it must not. It is the one file outside BackWPup's folders that this suite owns and
 * knows the content of, so a command that read it or removed it shows as such.
 */

/**
 * The file marker's filename. It is written into the site's own `WP_CONTENT_DIR`.
 *
 * At the root of the content directory deliberately. A files job includes that area by default
 * (`backupcontent`), and every one of the area's default exclusions is a *directory*, so a file
 * sitting directly here cannot be skipped by one of them.
 *
 * A bare name rather than a path: where it lands is the *site's* answer (`WP_CONTENT_DIR`), not this
 * suite's assumption, so a directory component here would be decoration no code could honour.
 */
export const FILE_MARKER_NAME = "e2e-backup-marker.txt";

/**
 * The option the database marker is stored under.
 *
 * An option, rather than a table of our own, because `wp_options` carries the site's prefix and so
 * is in the set of tables a database job dumps by default — no job configuration has to be bent to
 * make the marker reachable.
 */
export const DATABASE_MARKER_OPTION = "e2e_backup_marker";

/** The two values planted in a site for one scenario. */
export interface SiteMarkers {
  /** The random value written into {@link FILE_MARKER_NAME}. */
  readonly file: string;
  /** The random value stored in {@link DATABASE_MARKER_OPTION}. */
  readonly database: string;
}

/**
 * A fresh marker value: 32 hex characters on a single line.
 *
 * Single-line and alphanumeric so it survives every layer it has to cross unchanged — a SQL dump's
 * quoting, a tar member, a shell pipeline — and can be searched for literally. Random so it belongs
 * to exactly one scenario run.
 */
export function newMarkerValue(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Plants both markers and **verifies** they landed.
 *
 * Written through the site's own PHP so the file lands wherever that install keeps `wp-content`,
 * rather than where this suite assumes it does; the path is read back and required to sit under the
 * WordPress root, so a relocated content directory fails here with an explanation instead of
 * silently producing a marker no backup would ever include.
 *
 * Ownership is handed back afterwards because the file was written as the identity site commands run
 * as — the transport's user outside the `site` state — and the **web server** is what has to read it
 * while the backup runs (in `site` the handover is unnecessary).
 *
 * @param transport - the site to plant them in.
 * @returns the values planted, for the assertions to look for.
 * @throws {@link Error} if either marker could not be written, or did not read back as written.
 */
export async function seedMarkers(transport: Transport): Promise<SiteMarkers> {
  const markers: SiteMarkers = {
    file: newMarkerValue(),
    database: newMarkerValue(),
  };
  const php =
    `$value = ${phpLiteral(markers.file)};\n` +
    `$path = WP_CONTENT_DIR . '/' . ${phpLiteral(FILE_MARKER_NAME)};\n` +
    "if ( false === file_put_contents( $path, $value ) ) {\n" +
    "\tWP_CLI::error( 'could not write the file marker to ' . $path );\n" +
    "}\n" +
    // `update_option`, not `add_option`: a marker left behind by a crashed run must be replaced
    // rather than quietly kept, or the scenario would look for a value the site no longer holds.
    `update_option( ${phpLiteral(DATABASE_MARKER_OPTION)}, ${phpLiteral(markers.database)}, false );\n` +
    "echo wp_json_encode( [\n" +
    "\t'path' => $path,\n" +
    "\t'root' => ABSPATH,\n" +
    "\t'file' => (string) file_get_contents( $path ),\n" +
    `\t'database' => (string) get_option( ${phpLiteral(DATABASE_MARKER_OPTION)} ),\n` +
    "] );";

  const reply = await evalPhp(
    transport,
    php,
    "planting the backup markers",
    "backwpup/markers",
  );
  const seeded = parseSeedReply(reply);

  if (seeded.file !== markers.file || seeded.database !== markers.database) {
    throw new Error(
      "[backwpup/markers] the markers did not read back as written — the site holds " +
        `file=${JSON.stringify(seeded.file)}, database=${JSON.stringify(seeded.database)}.`,
    );
  }
  await normalizeOwnership(transport, relativeToRoot(seeded.path, seeded.root));
  return markers;
}

/** The fields {@link seedMarkers} reads back out of the site. */
interface SeedReply extends SiteMarkers {
  /** Absolute path the file marker was actually written to. */
  readonly path: string;
  /** The install's `ABSPATH`, for turning that into a root-relative path. */
  readonly root: string;
}

/**
 * Narrows the seeding snippet's JSON reply.
 *
 * Every field is required: a partial reply means the snippet did not do what it was asked, and
 * defaulting any of them would turn that into a passing "the markers are in place".
 */
function parseSeedReply(reply: string): SeedReply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/markers] planting the markers did not return JSON. Output was: ${reply.slice(0, 300)}`,
    );
  }
  if (
    !isObject(parsed) ||
    typeof parsed.path !== "string" ||
    typeof parsed.root !== "string" ||
    typeof parsed.file !== "string" ||
    typeof parsed.database !== "string"
  ) {
    throw new Error(
      `[backwpup/markers] planting the markers returned an unexpected shape: ${reply.slice(0, 300)}`,
    );
  }
  return {
    path: parsed.path,
    root: parsed.root,
    file: parsed.file,
    database: parsed.database,
  };
}

/**
 * Turns the marker's absolute path into one relative to the WordPress root.
 *
 * `normalizeOwnership` takes a root-relative path precisely so a privileged command can never be
 * aimed outside the docroot, so anything that does not sit under the root is refused here rather
 * than handed on.
 */
function relativeToRoot(path: string, root: string): string {
  const relative = pathInsideRoot(path, root);
  if (relative === undefined) {
    throw new Error(
      `[backwpup/markers] the file marker landed at "${path}", outside the WordPress root ` +
        `("${root}") — this site keeps its content directory somewhere a backup of the root ` +
        "would not cover, so the marker could not prove anything.",
    );
  }
  return relative;
}

/**
 * What the file marker holds right now, or `undefined` once it is gone — for a scenario asserting
 * that a command which should never have reached the file left it exactly as planted.
 *
 * @param transport - the site holding it.
 * @throws {@link Error} if the file is there but could not be read, or the reply is neither — a
 * marker that cannot be read must not pass for one that was left alone.
 */
export async function readFileMarker(
  transport: Transport,
): Promise<string | undefined> {
  const php =
    `$path = WP_CONTENT_DIR . '/' . ${phpLiteral(FILE_MARKER_NAME)};\n` +
    "echo wp_json_encode( is_file( $path ) ? file_get_contents( $path ) : null );";
  return parseMarkerReply(
    await evalPhp(
      transport,
      php,
      "reading the file marker",
      "backwpup/markers",
    ),
    "file",
  );
}

/**
 * What the database marker holds right now, or `undefined` once the option is gone — the other half
 * of asking which side of the site a restore brought back.
 *
 * @param transport - the site holding it.
 * @throws {@link Error} if the site answered with anything but a string or nothing.
 */
export async function readDatabaseMarker(
  transport: Transport,
): Promise<string | undefined> {
  const php = `echo wp_json_encode( get_option( ${phpLiteral(DATABASE_MARKER_OPTION)}, null ) );`;
  return parseMarkerReply(
    await evalPhp(
      transport,
      php,
      "reading the database marker",
      "backwpup/markers",
    ),
    "database",
  );
}

/**
 * Reads a marker reader's JSON reply: the value, or `undefined` for `null` (the marker is gone).
 * Anything else throws — a marker that cannot be read must not pass for one that was left alone.
 *
 * Exported for its unit test.
 *
 * @param reply - the snippet's output.
 * @param which - which marker, for the message.
 */
export function parseMarkerReply(
  reply: string,
  which: "file" | "database",
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (parsed === null) return undefined;
  if (typeof parsed !== "string") {
    throw new Error(
      `[backwpup/markers] the ${which} marker could not be read — the site answered ${reply.slice(0, 300) || "(nothing)"}.`,
    );
  }
  return parsed;
}

/**
 * Removes both markers, best-effort.
 *
 * Teardown, so it **never throws**: a scenario that already failed must report its own reason, not
 * a tidy-up problem on top of it. A marker left behind cannot make a later scenario pass wrongly
 * either — each one plants fresh random values and looks only for those — so warning is the honest
 * response to a failure here.
 *
 * @param transport - the site to clean.
 */
export async function removeMarkers(transport: Transport): Promise<void> {
  const php =
    `$path = WP_CONTENT_DIR . '/' . ${phpLiteral(FILE_MARKER_NAME)};\n` +
    "if ( file_exists( $path ) ) {\n" +
    "\twp_delete_file( $path );\n" +
    "}\n" +
    `delete_option( ${phpLiteral(DATABASE_MARKER_OPTION)} );\n` +
    "echo file_exists( $path ) ? 'file-remains' : 'clean';";
  try {
    const outcome = await evalPhp(
      transport,
      php,
      "removing the backup markers",
      "backwpup/markers",
    );
    if (outcome !== "clean") {
      console.warn(
        `[backwpup/markers] the file marker could not be removed from this site (${outcome}). ` +
          "It is harmless — every scenario plants fresh values — but it will sit in later backups.",
      );
    }
  } catch (error) {
    console.warn(
      `[backwpup/markers] removing the markers failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * The values a scenario wrote over its markers after the backup it is about to restore — what each
 * marker should still hold when a restore leaves its side of the site alone.
 *
 * Kept apart from the planted values on purpose: those are what a backup captured, these are what
 * only the live site holds, and a restore is judged by which of the two each marker holds afterwards.
 */
export class ChangedMarkers {
  /** The values written over the planted ones, once a step has changed them. */
  private changed: SiteMarkers | undefined;

  /**
   * Remembers the values the markers were changed to.
   *
   * @param values - what `seedMarkers` planted the second time.
   */
  record(values: SiteMarkers): void {
    this.changed = values;
  }

  /**
   * The values the markers were changed to.
   *
   * @throws {@link Error} if no step changed them — a feature asserting "still changed" without
   * having changed anything, which is worth saying plainly rather than failing as a mismatch.
   */
  get values(): SiteMarkers {
    if (this.changed === undefined) {
      throw new Error(
        "[backwpup/markers] the markers were not changed after the backup in this scenario, so " +
          "there is nothing to compare against. Change them before asserting what a restore kept.",
      );
    }
    return this.changed;
  }
}
