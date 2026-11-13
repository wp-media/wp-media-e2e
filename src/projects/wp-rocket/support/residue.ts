import { LICENCE_RESIDUE } from "./licence";
import type { SiteResidue } from "../../../common/config/types";

/**
 * What WP Rocket writes on a site's filesystem, read from `inc/Engine/WPRocketUninstall.php` and
 * `uninstall.php` (`WP_ROCKET_CACHE_ROOT_PATH` = `wp-content/cache/`, `WP_ROCKET_CONFIG_PATH` =
 * `wp-content/wp-rocket-config/`) at the ref under test, and measured on the twins.
 */

/** The cache folders its uninstall deletes (`$cache_dirs`), under `wp-content/cache`. */
const CACHE_DIRS = [
  "wp-rocket",
  "min",
  "busting",
  "critical-css",
  "used-css",
  "fonts",
  "background-css",
].map((dir) => `wp-content/cache/${dir}`);

/** Its config folder (one `<host>.php` per site, plus the dynamic lists), deleted by its uninstall. */
const CONFIG_DIR = "wp-content/wp-rocket-config";

/**
 * What activation may write outside the plugin's folder (`ProductConfig.installOutputs`). Measured
 * (twin, licensed): `advanced-cache.php`, `cache/{wp-rocket,min,busting,critical-css}` and
 * `wp-rocket-config`; the other cache folders appear on later requests, and are declared so an
 * install that does create one hands it over too. `wp-content/cache` comes first: on a fresh site it
 * is new and covers every folder inside it.
 */
export const WP_ROCKET_INSTALL_OUTPUTS: readonly string[] = [
  "wp-content/advanced-cache.php",
  "wp-content/cache",
  ...CACHE_DIRS,
  CONFIG_DIR,
];

/**
 * What the teardown removes after every scenario (`ProductConfig.siteResidue`): what its uninstall
 * removes — so a run that skipped the uninstall leaves nothing — and the licence must-use plugin. All
 * remove-only: their modes are the plugin's (`CHMOD_WP_ROCKET_CACHE_DIRS`, `0755`), never opened up
 * as data directories. `wp-content/cache` itself and `advanced-cache.php` are left: the uninstall
 * keeps them too, and putting them back as found needs a record of the site before the install.
 */
export const WP_ROCKET_SITE_RESIDUE: readonly SiteResidue[] = [
  ...[...CACHE_DIRS, CONFIG_DIR].map((path): SiteResidue => ({
    path,
    prepare: false,
  })),
  LICENCE_RESIDUE,
];
