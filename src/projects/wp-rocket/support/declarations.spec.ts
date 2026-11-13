import { test, expect } from "@playwright/test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  WP_ROCKET_ADMIN_CAPABILITIES,
  WP_ROCKET_OPTION_FRAGMENTS,
  WP_ROCKET_SITE_DB_RESIDUE,
  WP_ROCKET_TABLES,
} from "./db-residue";
import {
  DUMMY_LICENCE,
  LICENCE_PLUGIN_PATH,
  LICENCE_RESIDUE,
  licencePluginSource,
  writeLicencePhp,
} from "./licence";
import { WP_ROCKET_INSTALL_OUTPUTS, WP_ROCKET_SITE_RESIDUE } from "./residue";
import { wpRocket } from "../config/wp-rocket.config";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import {
  normaliseOptionFragment,
  normaliseResidueCapability,
  normaliseResidueTable,
} from "../../../common/wp/db-residue";
import { normaliseInstallOutputs } from "../../../common/wp/paths";
import {
  parseResidueDeclaration,
  prepareSiteDataDirs,
  removeSiteResidue,
} from "../../../common/wp/residue";
import type { LocalTransport } from "../../../common/config/types";

/**
 * WP Rocket's declarations: valid for the shared machinery that consumes them, wired into its
 * config, and covering what its uninstall removes. The option and transient names below are copied
 * from `inc/Engine/WPRocketUninstall.php` (develop, 3.24.1-beta2) so a fragment dropped by mistake
 * fails here; a new name in a later WP Rocket is caught on the twins, where the sweep runs on rows the
 * plugin really wrote.
 */

/** `WPRocketUninstall::$options`. */
const UNINSTALL_OPTIONS = [
  "wp_rocket_settings",
  "rocket_analytics_notice_displayed",
  "rocketcdn_user_token",
  "rocketcdn_process",
  "rocket_rocketcdn_forced_pause_state",
  "wp_rocket_hide_deactivation_form",
  "wp_rocket_last_base_url",
  "wp_rocket_no_licence",
  "wp_rocket_last_option_hash",
  "wp_rocket_debug",
  "wp_rocket_rocketcdn_old_url",
  "plugin_family_dismiss_promote_imagify",
  "rocket_mixpanel_optin",
  "rocketcdn_status_fetch_lock",
  "rocket_cdn_website_search_fetch_lock",
  "rocket_cdn_retry_pro_detection_attempts",
];

/** `WPRocketUninstall::$transients` and `$transient_prefixes`, as stored (`_transient_<name>`). */
const UNINSTALL_TRANSIENTS = [
  "wp_rocket_customer_data",
  "rocket_notice_missing_tags",
  "rocket_clear_cache",
  "rocket_check_key_errors",
  "rocket_send_analytics_data",
  "rocket_critical_css_generation_process_running",
  "rocket_critical_css_generation_process_complete",
  "rocket_critical_css_generation_triggered",
  "rocketcdn_status",
  "rocketcdn_pricing",
  "rocketcdn_purge_cache_response",
  "rocketcdn_purchase_tracked",
  "rocket_cloudflare_ips",
  "rocket_cloudflare_is_api_keys_valid",
  "rocket_preload_triggered",
  "rocket_preload_complete",
  "rocket_preload_complete_time",
  "rocket_preload_errors",
  "rocket_database_optimization_process",
  "rocket_database_optimization_process_complete",
  "rocket_hide_deactivation_form",
  "wpr_preload_running",
  "rocket_preload_as_tables_count",
  "wpr_dynamic_lists",
  "wpr_dynamic_lists_delayjs",
  "rocket_domain_changed",
  "wp_rocket_rucss_errors_count",
  "wpr_dynamic_lists_incompatible_plugins",
  "rocket_divi_notice",
  "rocket_saas_processing",
  "rocket_mod_pagespeed_enabled",
  "wp_rocket_pricing",
  "wp_rocket_pricing_timeout",
  "wp_rocket_pricing_timeout_active",
  "rocket_get_refreshed_fragments_cache",
  "rocket_preload_previous_requests_durations",
  "rocket_preload_check_duration",
  "wpr_user_information_timeout_active",
  "wpr_user_information_timeout",
  "rocket_fonts_data_collection",
  "wpr_global_score_data",
  "wp_rocket_log_file_size_check",
  "wpr_ri_recommendations",
  "rocket_cdn_website_search",
  "rocket_mixpanel_reseller_synced",
  "rocket_cdn_pro_detection_failed",
  "rocket_cdn_check_status_request_timeout",
  "rocket_cdn_check_status_request_timeout_active",
  "rocket_cname_valid_0123456789abcdef0123456789abcdef",
].map((name) => `_transient_${name}`);

/** Whether a fragment matches `name` anywhere, as the sweep's `LIKE '%…%'` does. */
const swept = (name: string): boolean =>
  WP_ROCKET_OPTION_FRAGMENTS.some((fragment) => name.includes(fragment));

test.describe("WP Rocket's database footprint", () => {
  test("every fragment, table and capability is one the sweep accepts", () => {
    for (const fragment of WP_ROCKET_OPTION_FRAGMENTS) {
      expect(normaliseOptionFragment(fragment)).toBe(fragment);
    }
    for (const table of WP_ROCKET_TABLES) {
      expect(normaliseResidueTable(table)).toBe(table);
    }
    for (const capability of WP_ROCKET_ADMIN_CAPABILITIES) {
      expect(
        normaliseResidueCapability(capability, WP_ROCKET_OPTION_FRAGMENTS),
      ).toBe(capability);
    }
  });

  test("reaches every option and transient its uninstall deletes, but the one Imagify shares", () => {
    expect(UNINSTALL_OPTIONS.filter((name) => !swept(name))).toEqual([
      "plugin_family_dismiss_promote_imagify",
    ]);
    expect(UNINSTALL_TRANSIENTS.filter((name) => !swept(name))).toEqual([]);
  });

  // Names read from its source (develop, 3.24.1-beta2) beyond the uninstall's lists: its BerlinDB
  // tables' version and `_exists` rows, its background processes' rows, per-user transients.
  test("reaches its tables' rows, its background processes' and its per-user transients", () => {
    for (const name of [
      "wpr_rucss_used_css_version",
      "wpr_rocket_cache_version",
      "wpr_rocket_cdn_version",
      "wpr_above_the_fold_version",
      "wpr_lazy_render_content_version",
      "wpr_preload_fonts_version",
      "wpr_preconnect_external_domains_version",
      "wpr_performance_monitoring_version",
      "wpr_rucss_resources_version",
      "_transient_wpr_rocket_cache_exists",
      "_transient_wpr_user_information",
      "_transient_wpr_dashboard_seen_1",
      "rocket_database_optimization_batch_0123abcd",
      "rocket_critical_css_generation_process_lock",
      "_transient_rocket_promo_seen_1",
      "_transient_rocket_renewal_banner_1",
      "_transient_rocket_rucss_as_tables_count",
      "rocket_analytics_optin",
      "_transient_rocket_check_licence_30",
      "_transient_rocket_get_refreshed_fragments_cache_en",
    ]) {
      expect(swept(name), name).toBe(true);
    }
  });

  // The sweep runs on every `@plugin` scenario, WP Rocket installed or not: another plugin's
  // settings sharing a prefix must survive it.
  test("leaves other plugins' options alone, sibling WP Media plugins included", () => {
    for (const name of [
      // Royal Elementor Addons.
      "wpr_google_map_api_key",
      "wpr_override_woo_templates",
      "wpr_hide_banners",
      // Lazy Load by WP Rocket.
      "rocket_lazyload_options",
      // Imagify's plugin family writes it as well.
      "plugin_family_dismiss_promote_imagify",
      "imagify_settings",
    ]) {
      expect(swept(name), name).toBe(false);
    }
  });

  test("reaches the refusal transient no uninstall removes, for any user id", () => {
    for (const id of ["0", "1", "42"]) {
      expect(swept(`_transient_${id}_donotdeactivaterocket`)).toBe(true);
      expect(swept(`_transient_timeout_${id}_donotdeactivaterocket`)).toBe(
        true,
      );
    }
  });

  test("leaves WordPress's own options and the Action Scheduler it shares alone", () => {
    for (const name of [
      "siteurl",
      "active_plugins",
      "cron",
      "theme_mods_twentytwentyfive",
      "action_scheduler_lock_async-request-runner",
      "schema-ActionScheduler_StoreSchema",
      "_transient_as-post-store-dependencies-met",
    ]) {
      expect(swept(name), name).toBe(false);
    }
  });
});

test.describe("WP Rocket's files", () => {
  test("every residue entry is remove-only, never a data directory to open up", () => {
    for (const entry of WP_ROCKET_SITE_RESIDUE) {
      const parsed = parseResidueDeclaration(entry);
      expect(parsed).toMatchObject({ kind: "path", prepare: false });
    }
  });

  test("its uninstall's folders and the licence are residue; cache and advanced-cache.php are not", () => {
    const paths = WP_ROCKET_SITE_RESIDUE.map((entry) =>
      typeof entry === "object" && "path" in entry ? entry.path : entry,
    );
    expect(paths).toEqual([
      "wp-content/cache/wp-rocket",
      "wp-content/cache/min",
      "wp-content/cache/busting",
      "wp-content/cache/critical-css",
      "wp-content/cache/used-css",
      "wp-content/cache/fonts",
      "wp-content/cache/background-css",
      "wp-content/wp-rocket-config",
      LICENCE_PLUGIN_PATH,
    ]);
  });

  test("install outputs are valid and cover every residue folder but the licence", () => {
    expect(normaliseInstallOutputs(WP_ROCKET_INSTALL_OUTPUTS)).toEqual(
      WP_ROCKET_INSTALL_OUTPUTS,
    );
    for (const entry of WP_ROCKET_SITE_RESIDUE) {
      if (entry === LICENCE_RESIDUE) continue;
      const path =
        typeof entry === "object" && "path" in entry ? entry.path : "";
      expect(WP_ROCKET_INSTALL_OUTPUTS, path).toContain(path);
    }
    expect(WP_ROCKET_INSTALL_OUTPUTS).toContain(
      "wp-content/advanced-cache.php",
    );
    expect(WP_ROCKET_INSTALL_OUTPUTS).toContain("wp-content/cache");
  });

  test.describe("on a local site", () => {
    let root: string;
    let local: LocalTransport;

    test.beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), "e2e-wpr-residue-"));
      local = { mode: "local", rootDir: root, elevate: false };
    });

    test.afterEach(() => {
      removeTempDir(root);
    });

    test("preparation creates and opens none of them", async () => {
      mkdirSync(join(root, "wp-content/cache/min"), { recursive: true });
      await prepareSiteDataDirs(local, WP_ROCKET_SITE_RESIDUE);
      expect(
        (statSync(join(root, "wp-content/cache/min")).mode & 0o777).toString(8),
      ).not.toBe("777");
      expect(existsSync(join(root, "wp-content/wp-rocket-config"))).toBe(false);
      expect(existsSync(join(root, "wp-content/cache/wp-rocket"))).toBe(false);
    });

    test("the teardown's removal takes the licence and the folders, and leaves the rest", async () => {
      for (const dir of [
        "wp-content/cache/wp-rocket/localhost",
        "wp-content/wp-rocket-config",
      ]) {
        mkdirSync(join(root, dir), { recursive: true });
      }
      mkdirSync(join(root, "wp-content/mu-plugins"), { recursive: true });
      writeFileSync(
        join(root, LICENCE_PLUGIN_PATH),
        licencePluginSource(DUMMY_LICENCE),
      );
      writeFileSync(
        join(root, "wp-content/mu-plugins/site-own.php"),
        "<?php\n",
      );
      writeFileSync(join(root, "wp-content/advanced-cache.php"), "");

      await removeSiteResidue(local, WP_ROCKET_SITE_RESIDUE);

      expect(existsSync(join(root, LICENCE_PLUGIN_PATH))).toBe(false);
      expect(existsSync(join(root, "wp-content/cache/wp-rocket"))).toBe(false);
      expect(existsSync(join(root, "wp-content/wp-rocket-config"))).toBe(false);
      expect(existsSync(join(root, "wp-content/mu-plugins/site-own.php"))).toBe(
        true,
      );
      expect(existsSync(join(root, "wp-content/cache"))).toBe(true);
      expect(existsSync(join(root, "wp-content/advanced-cache.php"))).toBe(
        true,
      );
    });
  });
});

test.describe("WP Rocket's licence", () => {
  test("refuses a key WP Rocket's check would reject, and an empty email", () => {
    for (const key of ["", "SEVEN77", "NINE99999"]) {
      expect(() => licencePluginSource({ key, email: "a@b.invalid" })).toThrow(
        /must be exactly 8 characters/,
      );
    }
    expect(() => licencePluginSource({ key: "ABCDEFGH", email: " " })).toThrow(
      /email is empty/,
    );
  });

  test("the dummy licence is shaped for the check: 8 characters and a reserved domain", () => {
    expect(DUMMY_LICENCE.key).toHaveLength(8);
    expect(DUMMY_LICENCE.email).toMatch(/@example\.invalid$/);
  });

  test("embeds values only as literals: none appears raw in the plugin or the write snippet", () => {
    const email = "x'); system('id'); //@example.invalid";
    const source = licencePluginSource({ key: "ABCDEFGH", email });
    expect(source).not.toContain(email);
    expect(source).not.toContain("ABCDEFGH");
    expect(writeLicencePhp(source)).not.toContain("Plugin Name");
  });

  test("never loads outside WordPress and never edits wp-config.php", () => {
    const source = licencePluginSource(DUMMY_LICENCE);
    expect(source).toMatch(/^<\?php\n[\s\S]*defined\( 'ABSPATH' \) \|\| exit;/);
    expect(source + writeLicencePhp(source)).not.toMatch(/wp-config/);
  });
});

test.describe("WP Rocket's config", () => {
  test("wires the declarations and the licence into the product", () => {
    expect(wpRocket.siteResidue).toBe(WP_ROCKET_SITE_RESIDUE);
    expect(wpRocket.siteDbResidue).toBe(WP_ROCKET_SITE_DB_RESIDUE);
    expect(wpRocket.installOutputs).toBe(WP_ROCKET_INSTALL_OUTPUTS);
    expect(typeof wpRocket.prepareActivation).toBe("function");
  });
});
