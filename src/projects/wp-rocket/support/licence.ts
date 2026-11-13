import { posix } from "node:path";

import { normalizeOwnership } from "../../../common/wp/ownership";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { removeSiteResidue } from "../../../common/wp/residue";
import type {
  SiteResidueRemoveOnly,
  Transport,
} from "../../../common/config/types";

/**
 * WP Rocket's licence for a scenario, through a **must-use plugin** the `@plugin` install writes
 * before activation and the teardown removes (declared as residue): `wp-config.php` is never edited.
 *
 * Why a licence at all: activation writes `WP_CACHE` (and so caches anything) only when
 * `rocket_valid_key()` holds — `consumer_key` of 8 characters and `secret_key === hash('crc32',
 * consumer_email)` (`inc/functions/options.php`). That check is **offline**, so a dummy key passes it.
 *
 * Why filters: `Options_Data::get` answers the `pre_get_rocket_option_<key>` filter first, then the
 * `WP_ROCKET_KEY`/`WP_ROCKET_EMAIL` constants, then the option — and `licence-data.php`, always
 * loaded, defines both constants as `''` unless set earlier, so writing the option alone never
 * licenses. A must-use plugin loads before every regular plugin, so the filters are in place before
 * WP Rocket reads anything, on every request and every WP-CLI call alike. Measured on the twins:
 * without it `WP_CACHE` is never written; with it, it is, and pages are served from cache.
 */

/** The must-use plugin, relative to the WordPress root. */
export const LICENCE_PLUGIN_PATH =
  "wp-content/mu-plugins/e2e-wp-rocket-licence.php";

/** The must-use plugin as residue: removed after every scenario, never prepared as a directory. */
export const LICENCE_RESIDUE: SiteResidueRemoveOnly = {
  path: LICENCE_PLUGIN_PATH,
  prepare: false,
};

/** What licenses WP Rocket: the two values its check reads; the secret is derived from the email. */
export interface RocketLicence {
  /** `consumer_key`: exactly 8 characters, or the check fails. */
  readonly key: string;
  /** `consumer_email`: `secret_key` is its `hash('crc32', …)`, computed in PHP. */
  readonly email: string;
}

/**
 * A licence that passes the offline check and nothing else: no account has it, so any remote
 * feature (RocketCDN, Remove Unused CSS, updates) is refused by WP Rocket's servers.
 */
export const DUMMY_LICENCE: RocketLicence = {
  key: "E2EDUMMY",
  email: "e2e-licence@example.invalid",
};

/**
 * The must-use plugin's source. Values enter only through {@link phpLiteral}; the secret is
 * computed with the same `hash('crc32', …)` WP Rocket checks against, so it cannot drift from it.
 *
 * @param licence - the values to answer with.
 * @returns the file's content.
 * @throws Error if the key is not 8 characters (WP Rocket would reject it) or the email is empty.
 */
export function licencePluginSource(licence: RocketLicence): string {
  if (licence.key.length !== 8) {
    throw new Error(
      `[wp-rocket/licence] the licence key must be exactly 8 characters (WP Rocket's own check), got ${String(licence.key.length)}.`,
    );
  }
  if (licence.email.trim() === "") {
    throw new Error("[wp-rocket/licence] the licence email is empty.");
  }
  return `<?php
/**
 * Plugin Name: E2E WP Rocket licence
 * Description: Written by the E2E suite before WP Rocket is activated and removed after the scenario. Licenses WP Rocket offline through its option pre-filters.
 */

defined( 'ABSPATH' ) || exit;

$e2e_rocket_email = ${phpLiteral(licence.email)};
foreach (
	array(
		'consumer_key'   => ${phpLiteral(licence.key)},
		'consumer_email' => $e2e_rocket_email,
		'secret_key'     => hash( 'crc32', $e2e_rocket_email ),
	) as $e2e_rocket_option => $e2e_rocket_value
) {
	add_filter(
		'pre_get_rocket_option_' . $e2e_rocket_option,
		static function () use ( $e2e_rocket_value ) {
			return $e2e_rocket_value;
		}
	);
}
unset( $e2e_rocket_email, $e2e_rocket_option, $e2e_rocket_value );
`;
}

/**
 * The `wp eval` snippet that writes `source` at {@link LICENCE_PLUGIN_PATH}: refuses a site whose
 * must-use plugins load from elsewhere (`WPMU_PLUGIN_DIR` moved: the file would never load, and the
 * teardown only removes it here) and creates the folder when missing.
 *
 * @param source - the file's content, from {@link licencePluginSource}.
 */
export function writeLicencePhp(source: string): string {
  return `
$dir = untrailingslashit( wp_normalize_path( WPMU_PLUGIN_DIR ) );
$expected = untrailingslashit( wp_normalize_path( ABSPATH . ${phpLiteral(posix.dirname(LICENCE_PLUGIN_PATH))} ) );
if ( $dir !== $expected ) {
	WP_CLI::error( 'must-use plugins load from ' . $dir . ', not ' . $expected . ', so the licence plugin would never load.' );
}
if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
	WP_CLI::error( 'could not create ' . $dir . '.' );
}
$file = $dir . '/' . ${phpLiteral(posix.basename(LICENCE_PLUGIN_PATH))};
if ( false === file_put_contents( $file, ${phpLiteral(source)} ) ) {
	WP_CLI::error( 'could not write ' . $file . '.' );
}
`;
}

/**
 * WP Rocket's `ProductConfig.prepareActivation`: writes the licence must-use plugin as the site's
 * commands run (the identity in `site`), then hands it to the site's ownership.
 *
 * A copy an earlier run left is removed first, escalating as residue removal does: in `site` the
 * identity may be unable to overwrite one the transport's user wrote. A `mu-plugins` folder this
 * creates is left in place afterwards (it is WordPress's own location, and the teardown only removes
 * the file); outside `site` it stays the transport's user's, readable by the web server, since
 * `normalizeOwnership` refuses a folder WordPress owns.
 *
 * @param transport - the site's transport.
 * @param licence - the values; the dummy one unless a scenario needs a real account.
 * @throws Error if the site refuses the file (see {@link writeLicencePhp}) or a leftover copy
 * cannot be removed.
 */
export async function writeLicencePlugin(
  transport: Transport,
  licence: RocketLicence = DUMMY_LICENCE,
): Promise<void> {
  const source = licencePluginSource(licence);
  await removeSiteResidue(transport, [LICENCE_RESIDUE]);
  // Plugins and themes stay out: the old WP Rocket is gone, and nothing else should decide whether
  // a file can be written.
  await evalPhp(
    transport,
    writeLicencePhp(source),
    "writing WP Rocket's licence must-use plugin",
    "wp-rocket/licence",
    { skipPlugins: true, skipThemes: true },
  );
  await normalizeOwnership(transport, LICENCE_PLUGIN_PATH);
}
