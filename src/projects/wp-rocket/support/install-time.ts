import { evalPhp, phpLiteral } from "../../../common/wp/php";
import type { Transport } from "../../../common/config/types";

/**
 * When the plugin under test was installed, on the site's clock: its main file's mtime. WordPress
 * unpacks a plugin zip by writing each file's contents (`_unzip_file_ziparchive`: `getFromIndex`, then
 * `put_contents`), so the file is dated by the install, never by the zip, and nothing rewrites it
 * after — every cache file this install's activation leads to is dated at or after it.
 */

/**
 * PHP that prints the main file's mtime as JSON (`null` when it is not there). Expects `$basename`
 * (`<folder>/<file>.php`) set.
 */
export const INSTALLED_AT_PHP = `
clearstatcache();
$file = WP_PLUGIN_DIR . '/' . $basename;
echo wp_json_encode( file_exists( $file ) ? filemtime( $file ) : null );`;

/**
 * Reads {@link INSTALLED_AT_PHP}'s reply.
 *
 * @param reply - the snippet's output.
 * @param basename - the plugin asked about, for the message.
 * @throws Error when the plugin's main file is missing, or the reply is not a timestamp.
 */
export function parseInstalledAt(reply: string, basename: string): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (parsed === null) {
    throw new Error(
      `[wp-rocket] ${basename} is not on the site, so when it was installed cannot be read.`,
    );
  }
  if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `[wp-rocket] reading when ${basename} was installed came back as ${reply.slice(0, 300) || "(empty)"}, not a timestamp.`,
    );
  }
  return parsed;
}

/**
 * When the plugin was installed, as a Unix timestamp on the site's clock.
 *
 * @param transport - the site's transport.
 * @param basename - the plugin's `<folder>/<file>.php`.
 * @throws Error when the site could not be asked, the file is missing, or the answer is not a time.
 */
export async function readInstalledAt(
  transport: Transport,
  basename: string,
): Promise<number> {
  return parseInstalledAt(
    await evalPhp(
      transport,
      `$basename = ${phpLiteral(basename)};\n${INSTALLED_AT_PHP}`,
      "reading when the plugin was installed",
      "wp-rocket",
    ),
    basename,
  );
}
