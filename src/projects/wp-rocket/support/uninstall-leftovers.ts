import { WP_ROCKET_UNINSTALL_REMOVES } from "./residue";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import type { Transport } from "../../../common/config/types";

/**
 * PHP that prints, as a JSON list, which of `$paths` (relative to the WordPress root) are on the site
 * — a link counted even when it dangles. Expects `$paths` set.
 */
export const LEFTOVERS_PHP = `
clearstatcache();
$left = [];
foreach ( $paths as $path ) {
	$full = ABSPATH . $path;
	if ( file_exists( $full ) || is_link( $full ) ) {
		$left[] = $path;
	}
}
echo wp_json_encode( $left );`;

/**
 * Reads {@link LEFTOVERS_PHP}'s reply, keeping only the paths asked about.
 *
 * @param reply - the snippet's output.
 * @param asked - the paths it was asked about.
 * @returns the paths found, in the order asked.
 * @throws Error when the reply is not a JSON list of strings, or names a path never asked about.
 */
export function parseLeftovers(
  reply: string,
  asked: readonly string[],
): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((path): path is string => typeof path === "string")
  ) {
    throw new Error(
      `[wp-rocket] looking for what its uninstall left came back as ${reply.slice(0, 300) || "(empty)"}, not a list of paths.`,
    );
  }
  const unknown = parsed.filter((path) => !asked.includes(path));
  if (unknown.length > 0) {
    throw new Error(
      `[wp-rocket] looking for what its uninstall left named paths never asked about: ${unknown.join(", ")}.`,
    );
  }
  return asked.filter((path) => parsed.includes(path));
}

/**
 * What WP Rocket's uninstall should have deleted and is still on the site: its cache folders and its
 * config folder ({@link WP_ROCKET_UNINSTALL_REMOVES}). Asked with no plugin or theme loaded, so the
 * answer is the filesystem's, not something a running plugin recreated while being asked.
 *
 * @param transport - the site's transport.
 * @returns the paths left, relative to the WordPress root; empty when the uninstall deleted them all.
 * @throws Error when the site could not be asked, or answered something else.
 */
export async function findUninstallLeftovers(
  transport: Transport,
): Promise<readonly string[]> {
  const reply = await evalPhp(
    transport,
    `$paths = ${phpLiteral(WP_ROCKET_UNINSTALL_REMOVES)};\n${LEFTOVERS_PHP}`,
    "looking for what WP Rocket's uninstall left",
    "wp-rocket",
    { skipPlugins: true, skipThemes: true },
  );
  return parseLeftovers(reply, WP_ROCKET_UNINSTALL_REMOVES);
}
