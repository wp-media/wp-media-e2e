import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { isObject } from "../../../common/guards";
import { plain } from "../../../common/text";
import type { Transport } from "../../../common/config/types";

/**
 * WP Rocket's `ProductConfig.forceDeactivate`: deactivating it when a plain `wp plugin deactivate`
 * leaves it active.
 *
 * Why it stays active (WP Rocket 3.24's source): its deactivation hook
 * (`Engine/Deactivation/Deactivation::deactivate_plugin`) collects "causes" — `'htaccess'` (Apache
 * with an unwritable `.htaccess`; never under WP-CLI, which is not Apache) and whatever the
 * `rocket_prevent_deactivation` filter adds, where `WPCache::maybe_prevent_deactivation` adds
 * `'wpconfig'` when no writable `wp-config.php` is found (it could not set `WP_CACHE` back to false).
 * With any cause it stores them in the transient `<current user id>_donotdeactivaterocket` (for the
 * admin notice), redirects and `die()`s — inside core's `deactivate_plugins()`, before that saves
 * `active_plugins`. So WP-CLI exits 0 and the plugin is still active (measured: `wp-config.php`
 * `root:www-data 644`).
 *
 * The force lifts only WP Rocket's own two causes, in one `wp eval` with WP Rocket loaded:
 *
 *  1. a `rocket_prevent_deactivation` filter, last (`PHP_INT_MAX`), returning the causes minus
 *     `wpconfig` and `htaccess` (`array_diff`, never emptied: a cause some other code adds still
 *     refuses, and is named);
 *  2. core's `deactivate_plugins()` for WP Rocket, so its deactivation hook runs whole — config file
 *     deleted, capabilities, `advanced-cache.php` emptied —, `WP_CACHE` and `.htaccess` excepted
 *     (unwritable: that is the refusal);
 *  3. the `<user id>_donotdeactivaterocket` transients deleted: the refusals of plain attempts, which
 *     would otherwise show a stale notice on the next plugins screen. Every one the options table
 *     holds, found by name; with a persistent object cache transients live there instead, where no
 *     name can be listed, so those of user 0 (WP-CLI with no `--user`) and of every user who can
 *     `activate_plugins` (the only ones who can reach a deactivation; `get_users`' `capability`,
 *     WordPress ≥ 5.9) are deleted by key too. Left there: one stored by a user who has since lost
 *     that capability — its notice shows only to that user, and only once they manage WP Rocket again.
 */

/** WP Rocket's basename in `active_plugins`. */
export const WP_ROCKET_BASENAME = "wp-rocket/wp-rocket.php";

/** WP Rocket's slug, for `wp plugin deactivate`. */
export const WP_ROCKET_SLUG = "wp-rocket";

/**
 * The causes WP Rocket's own code refuses its deactivation for: an unwritable `wp-config.php` and,
 * on Apache, `.htaccess`. Only these are lifted.
 */
export const WP_ROCKET_OWN_CAUSES = ["wpconfig", "htaccess"] as const;

/** Bound on a refusal's causes, as printed: they come from the site. */
const CAUSES_SHOWN_CHARS = 200;

/**
 * The force's snippet. Prints `{"refused": [...]}` just before WP Rocket dies on causes not its own,
 * else `{"active": bool, "transients": n}` once done.
 */
export const FORCE_DEACTIVATE_PHP = `
$e2e_basename = ${phpLiteral(WP_ROCKET_BASENAME)};
$e2e_own      = ${phpLiteral([...WP_ROCKET_OWN_CAUSES])};
add_filter(
	'rocket_prevent_deactivation',
	static function ( $causes ) use ( $e2e_own ) {
		$left = array_values( array_diff( (array) $causes, $e2e_own ) );
		if ( array() !== $left ) {
			// WP Rocket dies right after this filter: what kept it active is said first.
			echo wp_json_encode( array( 'refused' => $left ) );
		}
		return $left;
	},
	PHP_INT_MAX
);
require_once ABSPATH . 'wp-admin/includes/plugin.php';
deactivate_plugins( $e2e_basename );
global $wpdb;
// Keyed by transient name, so one both lists hold is deleted once.
$e2e_keys = array( '0_donotdeactivaterocket' => true );
foreach ( get_users( array( 'capability' => 'activate_plugins', 'fields' => 'ID' ) ) as $e2e_id ) {
	$e2e_keys[ (int) $e2e_id . '_donotdeactivaterocket' ] = true;
}
$e2e_names = $wpdb->get_col(
	$wpdb->prepare(
		"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s",
		$wpdb->esc_like( '_transient_' ) . '%' . $wpdb->esc_like( '_donotdeactivaterocket' )
	)
);
if ( '' !== $wpdb->last_error ) {
	WP_CLI::error( 'reading its refusal transients failed: ' . $wpdb->last_error );
}
foreach ( $e2e_names as $e2e_name ) {
	// The user id only: '_transient_timeout_…' and anything else that merely ends alike are left.
	if ( preg_match( '/^_transient_(\\d+_donotdeactivaterocket)$/', $e2e_name, $e2e_match ) ) {
		$e2e_keys[ $e2e_match[1] ] = true;
	}
}
$e2e_deleted = 0;
foreach ( array_keys( $e2e_keys ) as $e2e_key ) {
	if ( delete_transient( $e2e_key ) ) {
		++$e2e_deleted;
	}
}
echo wp_json_encode( array( 'active' => is_plugin_active( $e2e_basename ), 'transients' => $e2e_deleted ) );
`;

/** What the snippet answered. */
export type ForceAnswer =
  | { readonly kind: "refused"; readonly causes: readonly string[] }
  | {
      readonly kind: "done";
      readonly active: boolean;
      readonly transients: number;
    }
  | { readonly kind: "silent" };

/**
 * Reads the snippet's answer: its last line (PHP may print notices before it).
 *
 * @param stdout - the snippet's trimmed output.
 * @throws {@link Error} on output that is none of its answers.
 */
export function parseForceAnswer(stdout: string): ForceAnswer {
  const line = stdout.split("\n").at(-1)?.trim() ?? "";
  if (line === "") return { kind: "silent" };
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw unreadable(line);
  }
  if (!isObject(value)) throw unreadable(line);
  const refused = value.refused;
  if (Array.isArray(refused)) {
    return { kind: "refused", causes: refused.map((cause) => String(cause)) };
  }
  const { active, transients } = value;
  if (typeof active === "boolean" && Number.isInteger(transients)) {
    return { kind: "done", active, transients: transients as number };
  }
  throw unreadable(line);
}

/** The error for an answer {@link parseForceAnswer} cannot read; the line is shown plain and cut. */
function unreadable(line: string): Error {
  return new Error(
    `[wp-rocket/deactivation] the forced deactivation answered something unreadable: ${plain(line).slice(0, CAUSES_SHOWN_CHARS)}`,
  );
}

/**
 * What a forced deactivation's answer means: nothing when it deactivated, else why not.
 *
 * @param answer - the snippet's answer.
 * @returns `undefined` when WP Rocket is inactive, else the reason it is not.
 */
export function forceFailure(answer: ForceAnswer): string | undefined {
  switch (answer.kind) {
    case "done":
      return answer.active
        ? "WP Rocket is still active after `deactivate_plugins()`"
        : undefined;
    case "refused":
      return (
        "WP Rocket still refused its deactivation for causes other than its own unwritable " +
        `wp-config.php and .htaccess: ${plain(answer.causes.join(", ")).slice(0, CAUSES_SHOWN_CHARS)}`
      );
    case "silent":
      return "WP Rocket's deactivation stopped the command before it finished, saying nothing";
    default: {
      const exhaustive: never = answer;
      throw new Error(`unsupported answer: ${String(exhaustive)}`);
    }
  }
}

/**
 * WP Rocket's `ProductConfig.forceDeactivate` — see the module doc.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug: WP Rocket's, the only one this knows how to force.
 * @throws {@link Error} for another slug (nothing run), a failed command, or a deactivation that did
 * not take ({@link forceFailure}).
 */
export async function forceDeactivateWpRocket(
  transport: Transport,
  slug: string,
): Promise<void> {
  if (slug !== WP_ROCKET_SLUG) {
    throw new Error(
      `[wp-rocket/deactivation] can only force WP Rocket's deactivation ("${WP_ROCKET_SLUG}"), not "${plain(slug)}".`,
    );
  }
  const answer = parseForceAnswer(
    await evalPhp(
      transport,
      FORCE_DEACTIVATE_PHP,
      "forcing WP Rocket's deactivation",
      "wp-rocket/deactivation",
    ),
  );
  const failure = forceFailure(answer);
  if (failure !== undefined) {
    throw new Error(`[wp-rocket/deactivation] ${failure}.`);
  }
}
