import { test, expect } from "@playwright/test";

import {
  normaliseOptionFragment,
  normaliseResidueCapability,
  normaliseResidueCronHook,
  normaliseResidueRole,
} from "../../../common/wp/db-residue";
import {
  BACKWPUP_ADMIN_CAPABILITIES,
  BACKWPUP_CRON_HOOKS,
  BACKWPUP_ROLES,
  BACKWPUP_SITE_DB_RESIDUE,
} from "./db-residue";

/**
 * BackWPup's database-footprint declaration, held to the sweep's own rules: a declaration the sweep
 * refuses would fail every `@plugin` scenario's Before hook, so it is caught here instead.
 */

test.describe("BACKWPUP_SITE_DB_RESIDUE", () => {
  const fragments = (BACKWPUP_SITE_DB_RESIDUE.optionsContaining ?? []).map(
    normaliseOptionFragment,
  );

  test("declares roles, capabilities and WP-Cron hooks the sweep accepts as the plugin's own", () => {
    for (const role of BACKWPUP_SITE_DB_RESIDUE.roles ?? []) {
      expect(normaliseResidueRole(role, fragments)).toBe(role);
    }
    for (const capability of BACKWPUP_SITE_DB_RESIDUE.capabilities ?? []) {
      expect(normaliseResidueCapability(capability, fragments)).toBe(
        capability,
      );
    }
    for (const hook of BACKWPUP_SITE_DB_RESIDUE.cronHooks ?? []) {
      expect(normaliseResidueCronHook(hook, fragments)).toBe(hook);
    }
  });

  // A job's event (`backwpup_cron {arg: <jobid>}`) survives deactivation and uninstall, and the next
  // install's job of that id inherits it.
  test("declares the plugin's three WP-Cron hooks", () => {
    expect(BACKWPUP_SITE_DB_RESIDUE.cronHooks).toEqual(BACKWPUP_CRON_HOOKS);
    expect(BACKWPUP_CRON_HOOKS).toEqual([
      "backwpup_cron",
      "backwpup_check_cleanup",
      "backwpup_rsc_delete_segment_files",
    ]);
  });

  // The names `inc/class-install.php` registers and `uninstall.php` removes: three roles, and eleven
  // capabilities granted to the administrator.
  test("declares the plugin's three roles and its eleven administrator capabilities", () => {
    expect(BACKWPUP_SITE_DB_RESIDUE.roles).toEqual(BACKWPUP_ROLES);
    expect(BACKWPUP_ROLES).toEqual([
      "backwpup_admin",
      "backwpup_check",
      "backwpup_helper",
    ]);
    expect(BACKWPUP_SITE_DB_RESIDUE.capabilities).toEqual(
      BACKWPUP_ADMIN_CAPABILITIES,
    );
    expect(new Set(BACKWPUP_ADMIN_CAPABILITIES).size).toBe(11);
  });
});
