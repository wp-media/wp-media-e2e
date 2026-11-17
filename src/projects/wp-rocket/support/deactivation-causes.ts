import { isObject } from "../../../common/guards";
import { evalPhp } from "../../../common/wp/php";
import type { Transport } from "../../../common/config/types";
import type { StopDeactivation } from "./background-work";

/**
 * Why WP Rocket refuses a plain deactivation, as 3.24.1 decides it (`Engine/Deactivation/Deactivation.php`
 * `deactivate_plugin`, with `WPCache::maybe_prevent_deactivation`): `wpconfig` when it finds no
 * writable `wp-config.php` (`find_wpconfig_path`: the root's, else the one above when that folder is
 * not another install), `htaccess` when WordPress runs on Apache (`$is_apache`) and the home's
 * `.htaccess` is not writable. Both are judged by whoever deactivates it — the site's commands here —,
 * so a refusal without either is WP Rocket's regression, not the site's setup.
 */

/** The causes WP Rocket would name for the site's commands, and who those run as. */
export interface DeactivationCauses {
  /** No writable `wp-config.php` where WP Rocket looks. */
  readonly wpconfig: boolean;
  /** Apache, and the home's `.htaccess` not writable. */
  readonly htaccess: boolean;
  /** Who the site's commands ran as: the user's name, else its uid; empty without `posix`. */
  readonly commandsUser: string;
}

/** PHP that prints {@link DeactivationCauses} as JSON, deciding each cause as WP Rocket does. */
export const DEACTIVATION_CAUSES_PHP = `
clearstatcache();
require_once ABSPATH . 'wp-admin/includes/file.php';
global $is_apache;
$parent   = dirname( ABSPATH ) . DIRECTORY_SEPARATOR;
$writable = is_writable( ABSPATH . 'wp-config.php' )
	|| ( file_exists( $parent . 'wp-config.php' ) && is_writable( $parent . 'wp-config.php' ) && ! file_exists( $parent . 'wp-settings.php' ) );
$user = '';
if ( function_exists( 'posix_geteuid' ) ) {
	$pw   = function_exists( 'posix_getpwuid' ) ? posix_getpwuid( posix_geteuid() ) : false;
	$user = is_array( $pw ) ? $pw['name'] : (string) posix_geteuid();
}
echo wp_json_encode( [
	'wpconfig'     => ! $writable,
	'htaccess'     => (bool) $is_apache && ! is_writable( get_home_path() . '.htaccess' ),
	'commandsUser' => $user,
] );`;

/**
 * Reads {@link DEACTIVATION_CAUSES_PHP}'s reply.
 *
 * @param reply - the snippet's output.
 * @throws Error when the reply is not the causes.
 */
export function parseDeactivationCauses(reply: string): DeactivationCauses {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  if (
    !isObject(parsed) ||
    typeof parsed.wpconfig !== "boolean" ||
    typeof parsed.htaccess !== "boolean" ||
    typeof parsed.commandsUser !== "string"
  ) {
    throw new Error(
      `[wp-rocket] reading what keeps WP Rocket active came back as ${reply.slice(0, 300) || "(empty)"}, not its causes.`,
    );
  }
  return {
    wpconfig: parsed.wpconfig,
    htaccess: parsed.htaccess,
    commandsUser: parsed.commandsUser,
  };
}

/** What a forced deactivation means: the site's setup (`expected`) or WP Rocket's fault (`regression`). */
export interface ForcedDeactivationVerdict {
  readonly kind: "expected" | "regression";
  /** One sentence for the warning or the failure. */
  readonly message: string;
}

/**
 * Judges a deactivation WP Rocket refused and the stop forced. Pure.
 *
 * @param deactivation - the stop's forced deactivation.
 * @param causes - what the site's commands find ({@link readDeactivationCauses}).
 */
export function judgeForcedDeactivation(
  deactivation: Extract<StopDeactivation, { kind: "forced" }>,
  causes: DeactivationCauses,
): ForcedDeactivationVerdict {
  const who =
    causes.commandsUser === ""
      ? "the site's commands"
      : `the site's commands (${causes.commandsUser})`;
  const forced =
    `a plain deactivation left it active (${deactivation.plainSaid}), so it was forced` +
    (deactivation.forceError === undefined
      ? ""
      : `; the force reported: ${deactivation.forceError}`);
  const named = [
    ...(causes.wpconfig ? ["wp-config.php"] : []),
    ...(causes.htaccess ? [".htaccess (Apache)"] : []),
  ];
  if (named.length === 0) {
    return {
      kind: "regression",
      message:
        `WP Rocket refused to be deactivated although ${who} can write wp-config.php (and, on ` +
        `Apache, .htaccess) — nothing it names as a cause holds —: ${forced}.`,
    };
  }
  return {
    kind: "expected",
    message:
      `WP Rocket refused to be deactivated, as it does when ${who} cannot write ` +
      `${named.join(" or ")} (the site's setup): ${forced}.`,
  };
}

/**
 * Asks the site, as its commands, which of WP Rocket's deactivation causes hold.
 *
 * @param transport - the site's transport.
 * @throws Error when the site could not be asked, or answered something else.
 */
export async function readDeactivationCauses(
  transport: Transport,
): Promise<DeactivationCauses> {
  return parseDeactivationCauses(
    await evalPhp(
      transport,
      DEACTIVATION_CAUSES_PHP,
      "reading what keeps WP Rocket active",
      "wp-rocket",
    ),
  );
}
