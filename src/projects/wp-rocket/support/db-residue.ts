import type { SiteDbResidue } from "../../../common/wp/db-residue";

/**
 * What WP Rocket leaves in a site's **database** when its files go without its uninstall running (a
 * run killed mid-scenario, a removal by path). Read from `inc/Engine/WPRocketUninstall.php`,
 * `uninstall.php` and the option/transient names in its source at the ref under test, and measured on
 * a twin: after a deactivate-then-uninstall nothing below is left, so the sweep matters only when that
 * path was skipped.
 *
 * Not swept, by design: user meta `rocket_boxes` and post meta `_rocket_exclude_*` (the sweep reads
 * options, tables, roles and capabilities only); the 18 cron hooks its uninstall clears (they live in
 * core's `cron` option, which the sweep never touches; a hook without its plugin runs nothing);
 * Action Scheduler's tables and options (a library other plugins share, its uninstall keeps them);
 * core rows.
 */

/**
 * Option fragments, matched anywhere in a name (`LIKE '%…%'`, on every `@plugin` scenario), so each is
 * specific to WP Rocket: a bare `rocket_` or `wpr_` would take other plugins' options (Lazy Load by WP
 * Rocket's `rocket_lazyload_options`, Royal Elementor Addons' `wpr_google_map_api_key`). Together they
 * cover every option and transient its uninstall deletes but one (below), its BerlinDB tables'
 * version and `_exists` rows, its background processes' rows, and the other names its source writes:
 *
 * - `wp_rocket_`: `wp_rocket_settings` and every `wp_rocket_*` option/transient;
 * - `rocketcdn`: `rocketcdn_*`, `rocket_rocketcdn_forced_pause_state`;
 * - `donotdeactivaterocket`: the transient a refused deactivation stores, `<user id>_donotdeactivaterocket`
 *   (`inc/Engine/Deactivation/Deactivation.php`), which no uninstall removes;
 * - `rocket_…`: one fragment per family or name its source reads or writes (`rocket_cname_valid_<md5>`,
 *   `rocket_promo_banner_<user id>`, …); the capabilities' fragments are needed by the capability rule
 *   too, which takes only a capability carrying one of them;
 * - `wpr_…`: its tables' rows (`wpr_rocket_cache_version`, `wpr_rucss_used_css_exists`, …) and
 *   transients (`wpr_dynamic_lists*`, `wpr_user_information*`, `wpr_dashboard_seen_<user id>`, …).
 *
 * `plugin_family_dismiss_promote_imagify` is in its uninstall's list but left: Imagify's bundled
 * plugin-family code writes it too, and the sweep runs whether WP Rocket is installed or not.
 */
export const WP_ROCKET_OPTION_FRAGMENTS = [
  "wp_rocket_",
  "rocketcdn",
  "donotdeactivaterocket",
  "rocket_analytics_",
  "rocket_ask_for_update",
  "rocket_cdn_",
  "rocket_check_key_errors",
  "rocket_check_licence_",
  "rocket_clear_cache",
  "rocket_cloudflare_",
  "rocket_cname_valid_",
  "rocket_cpcss_",
  "rocket_critical_css_",
  "rocket_database_optimization_",
  "rocket_divi_notice",
  "rocket_domain_changed",
  "rocket_fonts_data_collection",
  "rocket_get_refreshed_fragments_cache",
  "rocket_hide_deactivation_form",
  "rocket_manage_options",
  "rocket_mixpanel_",
  "rocket_mod_pagespeed_enabled",
  "rocket_notice_missing_tags",
  "rocket_performance_hints_",
  "rocket_preload_",
  "rocket_promo_",
  "rocket_purge_",
  "rocket_regenerate_critical_css",
  "rocket_remove_unused_css",
  "rocket_renewal_banner_",
  "rocket_rucss_",
  "rocket_saas_",
  "rocket_send_analytics_data",
  "rocket_sitemap_preload_",
  "wpr_above_the_fold",
  "wpr_dashboard_seen_",
  "wpr_dynamic_lists",
  "wpr_global_score",
  "wpr_lazy_render_content",
  "wpr_performance_monitoring",
  "wpr_preconnect_external_domains",
  "wpr_preload_fonts",
  "wpr_preload_running",
  "wpr_ri_recommendations",
  "wpr_rocket_",
  "wpr_rucss",
  "wpr_user_information",
];

/**
 * Its tables, without the site's prefix: the BerlinDB tables `uninstall.php` drops (each class's
 * `$name`; measured on a twin as `wp_wpr_*`). The Action Scheduler tables it bundles are left: other
 * plugins share them and its uninstall keeps them.
 */
export const WP_ROCKET_TABLES = [
  "wpr_rucss_used_css",
  "wpr_rocket_cache",
  "wpr_above_the_fold",
  "wpr_lazy_render_content",
  "wpr_preload_fonts",
  "wpr_preconnect_external_domains",
  "wpr_performance_monitoring",
  "wpr_rocket_cdn",
];

/**
 * The capabilities activation grants `administrator` (`inc/Engine/Capabilities/Manager.php`) and
 * deactivation takes back — a removal skipping deactivation leaves them.
 */
export const WP_ROCKET_ADMIN_CAPABILITIES = [
  "rocket_manage_options",
  "rocket_purge_cache",
  "rocket_purge_posts",
  "rocket_purge_terms",
  "rocket_purge_users",
  "rocket_purge_cloudflare_cache",
  "rocket_purge_sucuri_cache",
  "rocket_preload_cache",
  "rocket_regenerate_critical_css",
  "rocket_remove_unused_css",
];

/** WP Rocket's `ProductConfig.siteDbResidue`. It registers no role. */
export const WP_ROCKET_SITE_DB_RESIDUE: SiteDbResidue = {
  optionsContaining: WP_ROCKET_OPTION_FRAGMENTS,
  tables: WP_ROCKET_TABLES,
  capabilities: WP_ROCKET_ADMIN_CAPABILITIES,
};
