import type { SiteDbResidue } from "../../../common/wp/db-residue";

/**
 * What BackWPup leaves in a site's **database** when its files go without its uninstall running.
 *
 * Its `uninstall.php` is thorough — verified live: after a proper deactivate-then-uninstall the
 * site's options, table, roles, capabilities and user meta are byte-for-byte back to their
 * pre-install state. Not its WP-Cron events: a job not set to run on WP-Cron keeps its event
 * ({@link BACKWPUP_CRON_HOOKS}). But that file is part of the plugin, so it only runs while the plugin is still there. Two
 * ways it does not: `wp plugin uninstall --deactivate` deletes the files while the plugin's own
 * guard skips the cleanup (measured: **26 options and the table** left behind), and a run killed
 * between the uninstall and the teardown leaves the same shape. Either way the next install reads
 * `backwpup_version`, concludes it is an upgrade rather than a first install, never sets the
 * onboarding flag, and the scenario fails blaming the product. A third, an uninstall that fails
 * (its folder then removed by path), also leaves the roles and administrator capabilities.
 *
 * The fragments below were taken from a site, not from the source: a full install plus onboarding
 * plus a UI scenario, sampled throughout, with every matching row collected.
 */

/**
 * Two fragments, because the plugin uses two names for itself.
 *
 * Almost everything is `backwpup*` — 25 rows spanning `backwpup_cfg_*`, the job list, the version
 * markers and the onboarding flag. The table's own schema-version row is `bwpup_backups_version`,
 * which shares no substring with the first fragment, so it needs its own. Notably the plugin's
 * **own** uninstall (`LIKE '%backwpup_%'`) does not match that row either — it is dropped by the
 * table's BerlinDB `uninstall()` instead, which is exactly the path that cannot run here.
 *
 * Matched anywhere in the name rather than as a prefix, which is load-bearing: the plugin's
 * destination caches are site transients, stored under `_site_transient_backwpup_<jobid>_gdrive`
 * and a `_site_transient_timeout_…` row beside it. Both were observed on a cell during an ordinary
 * scenario with no cloud credentials configured, so they are not an edge case of cloud storage.
 */
export const BACKWPUP_OPTION_FRAGMENTS = ["backwpup", "bwpup"];

/**
 * The plugin's backup history table, named without the site's prefix
 * (`src/Backup/Database/Tables/Backup.php`) — one row per archive a run delivered, per destination.
 */
export const BACKUP_HISTORY_TABLE = "bwpup_backups";

/**
 * The plugin's tables, named without the site's prefix — it creates exactly one,
 * {@link BACKUP_HISTORY_TABLE}.
 *
 * That table is also the row that blocks hardest: an install landing on top of it fails with
 * `Table 'wp_bwpup_backups' already exists`, which WordPress reports as a database error the
 * scenario then trips over somewhere unrelated. The `CREATE TABLE` statements elsewhere in the
 * source belong to the mysqldump job type and describe the *site's* tables, not the plugin's.
 */
export const BACKWPUP_TABLES = [BACKUP_HISTORY_TABLE];

/**
 * The roles the plugin registers on activation (`inc/class-install.php`), removed by its uninstall.
 *
 * Declared because activation cannot replace them: it calls `add_role()`, which leaves an existing
 * role untouched. Measured on `pro@apache`: a `backwpup_check` left with other capabilities kept them
 * through a fresh install, so a version that changes a role would be tested with the old one. A
 * failed uninstall is what leaves them.
 */
export const BACKWPUP_ROLES = [
  "backwpup_admin",
  "backwpup_check",
  "backwpup_helper",
];

/**
 * The capabilities activation grants the `administrator` role on a single site, and its uninstall
 * takes back. Activation re-grants each with `add_cap()`, which does overwrite; declared so one a
 * later version stops granting cannot outlive it, and so the sweep leaves the role as WordPress made
 * it.
 */
export const BACKWPUP_ADMIN_CAPABILITIES = [
  "backwpup",
  "backwpup_jobs",
  "backwpup_jobs_edit",
  "backwpup_jobs_start",
  "backwpup_backups",
  "backwpup_backups_download",
  "backwpup_backups_delete",
  "backwpup_logs",
  "backwpup_logs_delete",
  "backwpup_settings",
  "backwpup_restore",
];

/**
 * Every WP-Cron hook the plugin schedules (`wp_schedule_event`/`wp_schedule_single_event` in its
 * source, outside `vendor/`): a job's run, `backwpup_cron {arg: <jobid>}` or `{arg: "restart"}`; the
 * twice-daily `backwpup_check_cleanup`; Rackspace's `backwpup_rsc_delete_segment_files`.
 *
 * Declared because neither exit clears them all: deactivation (`inc/class-install.php`) clears only
 * the argument-less `backwpup_cron`, `backwpup_check_cleanup` and the events of jobs set to run on
 * WP-Cron, and the uninstall clears none. Verified live: `backwpup_cron {arg: 4}` for a job not on
 * WP-Cron survived deactivate plus uninstall, and the next install's job 4 "had" that schedule.
 */
export const BACKWPUP_CRON_HOOKS = [
  "backwpup_cron",
  "backwpup_check_cleanup",
  "backwpup_rsc_delete_segment_files",
];

/**
 * The footprint the shared `@plugin` hooks sweep whenever they find it: options, the table, roles,
 * the administrator's capabilities and WP-Cron events. Not user meta: the admin notices that write it
 * re-create it, no install reads it, and the next real uninstall removes it.
 */
export const BACKWPUP_SITE_DB_RESIDUE: SiteDbResidue = {
  optionsContaining: BACKWPUP_OPTION_FRAGMENTS,
  tables: BACKWPUP_TABLES,
  roles: BACKWPUP_ROLES,
  capabilities: BACKWPUP_ADMIN_CAPABILITIES,
  cronHooks: BACKWPUP_CRON_HOOKS,
};
