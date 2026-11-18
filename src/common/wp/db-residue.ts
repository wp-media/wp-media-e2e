import { evalPhp, phpLiteral } from "./php";
import { SiteDbResidueRemovalFailedError } from "./errors";
import { isObject } from "../guards";
import type { Transport } from "../config/types";

/**
 * The data a plugin leaves in a site's **database** once its files are gone — and removing it so the
 * next install is genuinely fresh.
 *
 * The filesystem counterpart in `residue.ts` exists because a plugin's uninstall deliberately
 * keeps the files it wrote. This one exists for the opposite reason: a well-behaved plugin's
 * uninstall *does* clear its database footprint, but that cleanup lives in the plugin's own
 * `uninstall.php` — so it only ever runs while the plugin's **files are still there**.
 *
 * That is the whole gap. `ensurePluginAbsent` can only ask WordPress to uninstall a plugin whose files
 * are there, so a site whose plugin directory has gone while its rows remain has nothing to run.
 * Measured on a real cell: `wp plugin uninstall <slug> --deactivate` — the one call this suite
 * forbids, precisely because the plugin's own guard then skips its cleanup — deletes the files and
 * leaves **26 options and the plugin's table** behind. The next run installs on top of that, the
 * plugin reads its own leftover version, concludes it is an upgrade rather than a first install, and
 * the scenario fails somewhere that blames the product.
 *
 * So this sweep keys off the **footprint**, never off the plugin being installed. A product declares
 * what its footprint looks like and the shared scenario hooks clear it whenever they find it.
 *
 * Roles count too, for a subtler reason: WordPress's `add_role()` returns without a change when the
 * role already exists, so a plugin's "add/overwrite roles" activation keeps whatever capabilities a
 * leftover role carries. Measured on a cell: a stale `backwpup_check` survived a fresh install with
 * the capabilities planted in it, not the ones the artifact defines — the scenario would test a role
 * the product never defines.
 *
 * WP-Cron events count for the same reason: a plugin that clears only some of its events on
 * deactivation (BackWPup keeps a job's `backwpup_cron {arg: <jobid>}` unless the job runs on WP-Cron)
 * leaves one in core's `cron` option, and the next install's job of that id "has" a schedule it was
 * never given.
 *
 * **It only makes sense with the plugin absent, and the hooks guarantee that by ordering.** Measured
 * on a cell: sweeping while the plugin is active does work, and the very next WordPress request puts
 * all 26 options and the table straight back — the plugin re-creates its own footprint on `init`.
 * Both callers therefore run it immediately after `ensurePluginAbsent`, which throws rather than
 * return with anything still at the plugin's path — and which, when the plugin's own uninstall
 * fails, removes its folder without it, leaving exactly the rows this takes.
 */

/**
 * What a product leaves in a site's database, as the product declares it.
 *
 * The kinds that make an install land on old state: the options a plugin reads to decide it has been
 * installed before, the table its installer tries to create again, the roles and capabilities
 * activation does not overwrite (`add_role()` keeps an existing role as it is), and the WP-Cron events
 * a new install's objects inherit by id. User meta is left
 * out: a plugin's notices re-create it, nothing reads it to decide what to install, and the next real
 * uninstall removes it.
 */
export interface SiteDbResidue {
  /**
   * Fragments of option names, each matched **anywhere in the name** rather than as a prefix.
   *
   * Anywhere, because a plugin's transients are options whose names it does not begin: BackWPup's
   * `backwpup_<jobid>_gdrive` is stored as `_site_transient_backwpup_<jobid>_gdrive`, observed live
   * during an ordinary scenario. A prefix match would walk straight past those and the timeout rows
   * beside them.
   *
   * Matched literally: `%` and `_` are escaped before the query, so a fragment can only ever mean
   * itself. Each must be at least {@link MIN_FRAGMENT_LENGTH} characters and drawn from
   * `[A-Za-z0-9_-]`, and a fragment broad enough to hit an option WordPress itself owns is refused
   * outright — see {@link PROTECTED_OPTIONS}. They are also the product's **names**: every declared
   * role and capability must carry one.
   */
  readonly optionsContaining?: readonly string[];
  /**
   * Tables the product creates, named **without** the site's prefix (`bwpup_backups`, not
   * `wp_bwpup_backups`). The prefix is read from the site, so a cell that does not use `wp_` is
   * swept just as correctly.
   */
  readonly tables?: readonly string[];
  /**
   * Roles the product registers, by exact name, removed whole (`remove_role`). List every name a
   * version ever registered: one only an older version used is a leftover too.
   *
   * Each must carry one of {@link SiteDbResidue.optionsContaining}'s fragments and may never be one
   * of WordPress's own ({@link PROTECTED_ROLES}).
   */
  readonly roles?: readonly string[];
  /**
   * Capabilities the product grants to roles it does not own (BackWPup's to `administrator`), by
   * exact name, removed from **every** role holding one, granted or denied. A role in
   * {@link SiteDbResidue.roles} goes whole instead.
   *
   * Each must carry one of {@link SiteDbResidue.optionsContaining}'s fragments and may never be one
   * of WordPress's own ({@link PROTECTED_CAPABILITIES}).
   */
  readonly capabilities?: readonly string[];
  /**
   * WP-Cron hooks the product schedules, by exact name: **every** event of each is removed, whatever
   * its arguments (`wp_unschedule_hook`) — a per-object event (`backwpup_cron {arg: 4}`) is keyed by
   * arguments no declaration can list.
   *
   * Each must carry one of {@link SiteDbResidue.optionsContaining}'s fragments and may never be one
   * of WordPress's own ({@link PROTECTED_CRON_HOOKS}).
   */
  readonly cronHooks?: readonly string[];
}

/** One capability a role carries in the site's roles option, granted or denied. */
export interface CapabilityGrant {
  /** The role holding it. */
  readonly role: string;
  /** The capability. */
  readonly capability: string;
}

/** One scheduled WP-Cron event of a declared hook. */
export interface CronEvent {
  /** The hook it runs. */
  readonly hook: string;
  /** When it is due, as a Unix timestamp. */
  readonly time: number;
  /** Its arguments as JSON (`{"arg":4}`, `[]`), or `(not encodable)` when PHP could not encode them. */
  readonly args: string;
}

/** What a sweep found — or removed — on a site, with tables at their full prefixed names. */
export interface FoundDbResidue {
  /** Matching option names, in name order. */
  readonly options: readonly string[];
  /** Matching tables, prefixed as they exist on the site. */
  readonly tables: readonly string[];
  /** Declared roles present on the site, in name order. */
  readonly roles: readonly string[];
  /** Declared capabilities held by roles that are not declared, in role then capability order. */
  readonly capabilities: readonly CapabilityGrant[];
  /** Events of declared WP-Cron hooks, in hook, time then arguments order. */
  readonly cronEvents: readonly CronEvent[];
}

/** A sweep that found nothing — what declaring nothing, or a clean site, returns. */
const NOTHING_FOUND: FoundDbResidue = {
  options: [],
  tables: [],
  roles: [],
  capabilities: [],
  cronEvents: [],
};

/** True when a sweep found nothing at all, so callers can skip the work and the logging. */
export function isEmptyDbResidue(found: FoundDbResidue): boolean {
  return (
    found.options.length === 0 &&
    found.tables.length === 0 &&
    found.roles.length === 0 &&
    found.capabilities.length === 0 &&
    found.cronEvents.length === 0
  );
}

/**
 * Shortest usable option fragment.
 *
 * A one- or two-character fragment matched anywhere in a name sweeps rows that have nothing to do
 * with the product — `id` alone matches most of a WordPress install. No plugin's identifying
 * fragment is that short, so anything shorter is a declaration mistake rather than a broad intent,
 * and is rejected where it can still be explained.
 */
const MIN_FRAGMENT_LENGTH = 3;

/**
 * Options that must survive any sweep, whatever a product declared.
 *
 * These are WordPress's own: losing them unreachably breaks the site (`siteurl`, `home`), silently
 * disables every plugin (`active_plugins`), or throws away state no reinstall restores (`cron`,
 * `db_version`). No sensible fragment reaches them — BackWPup's do not come close — so this list
 * never fires in normal use. It exists for the declaration that is *wrong*: a stray `%`, a fragment
 * shortened during a refactor, a product copying another's block. The same bet that
 * `PROTECTED_SITE_PATHS` makes for a privileged `rm -rf`, made here for a `DELETE`.
 *
 * Checked against what the query actually **matched**, not against the declaration, because a
 * fragment is not a name and only the site can say what it reaches.
 */
export const PROTECTED_OPTIONS: readonly string[] = [
  "active_plugins",
  "admin_email",
  "blogdescription",
  "blogname",
  "cron",
  "current_theme",
  "db_version",
  "fresh_site",
  "home",
  "initial_db_version",
  "permalink_structure",
  "rewrite_rules",
  "siteurl",
  "stylesheet",
  "template",
  "upload_path",
  "users_can_register",
];

/**
 * Options that must survive a sweep but carry the site's table prefix in their name
 * (`wp_user_roles`), so they can only be recognised once the prefix is known.
 *
 * `user_roles` is the one that matters here: it holds every role and capability on the site,
 * including the administrator's, so deleting it locks everyone out of `wp-admin`.
 */
const PROTECTED_PREFIXED_OPTIONS: readonly string[] = [
  "user_roles",
  "user_settings",
];

/**
 * Tables no product may declare as its own, named without a prefix.
 *
 * WordPress's core schema. A product that named one of these would drop the site's content, its
 * users or its settings the first time the sweep ran, so the declaration is refused rather than
 * obeyed. The multisite tables are listed too: this sweep refuses to run on multisite at all, but a
 * declaration naming one is wrong regardless of where it is loaded.
 */
export const PROTECTED_TABLES: readonly string[] = [
  "blogmeta",
  "blogs",
  "commentmeta",
  "comments",
  "links",
  "options",
  "postmeta",
  "posts",
  "registration_log",
  "signups",
  "site",
  "sitemeta",
  "term_relationships",
  "term_taxonomy",
  "termmeta",
  "terms",
  "usermeta",
  "users",
];

/**
 * WordPress's own roles (`populate_roles()`), which no product may declare: removing one strands
 * every user holding it — `administrator` locks the site out of `wp-admin`.
 */
export const PROTECTED_ROLES: readonly string[] = [
  "administrator",
  "author",
  "contributor",
  "editor",
  "subscriber",
];

/**
 * The capabilities WordPress's own roles are created with (`populate_roles()`, WordPress 7.2), which
 * no product may declare: removing one from every role takes it from the administrator too —
 * `manage_options` or `activate_plugins` gone is a site nobody can administer.
 *
 * Exact names guarded here; the fragment rule ({@link normaliseResidueCapability}) is what keeps out
 * another plugin's capabilities and core names this list does not hold.
 */
export const PROTECTED_CAPABILITIES: readonly string[] = [
  "activate_plugins",
  "create_users",
  "delete_others_pages",
  "delete_others_posts",
  "delete_pages",
  "delete_plugins",
  "delete_posts",
  "delete_private_pages",
  "delete_private_posts",
  "delete_published_pages",
  "delete_published_posts",
  "delete_themes",
  "delete_users",
  "edit_dashboard",
  "edit_files",
  "edit_others_pages",
  "edit_others_posts",
  "edit_pages",
  "edit_plugins",
  "edit_posts",
  "edit_private_pages",
  "edit_private_posts",
  "edit_published_pages",
  "edit_published_posts",
  "edit_theme_options",
  "edit_themes",
  "edit_users",
  "export",
  "import",
  "install_plugins",
  "install_themes",
  "level_0",
  "level_1",
  "level_2",
  "level_3",
  "level_4",
  "level_5",
  "level_6",
  "level_7",
  "level_8",
  "level_9",
  "level_10",
  "list_users",
  "manage_categories",
  "manage_links",
  "manage_options",
  "manage_secrets",
  "moderate_comments",
  "promote_users",
  "publish_pages",
  "publish_posts",
  "read",
  "read_private_pages",
  "read_private_posts",
  "remove_users",
  "switch_themes",
  "unfiltered_html",
  "unfiltered_upload",
  "update_core",
  "update_plugins",
  "update_themes",
  "upload_files",
];

/**
 * WordPress's own WP-Cron hooks, which no product may declare: unscheduling one stops core's update
 * checks, trash and transient clean-up, scheduled posts or pings until something schedules it again.
 *
 * Every hook WordPress 7.1.3 schedules (`wp_schedule_event`/`wp_schedule_single_event` in
 * `wp-includes` and `wp-admin`), plus `wp_https_detection`, an older release's (gone by 6.7.1). Exact
 * names guarded here; the fragment rule keeps out another plugin's hooks.
 */
export const PROTECTED_CRON_HOOKS: readonly string[] = [
  "delete_expired_transients",
  "do_pings",
  "importer_scheduled_cleanup",
  "publish_future_post",
  "recovery_mode_clean_expired_keys",
  "update_network_counts",
  "upgrader_scheduled_cleanup",
  "wp_delete_temp_updater_backups",
  "wp_https_detection",
  "wp_maybe_auto_update",
  "wp_privacy_delete_old_export_files",
  "wp_privacy_personal_data_cleanup_requests",
  "wp_scheduled_auto_draft_delete",
  "wp_scheduled_delete",
  "wp_site_health_scheduled_check",
  "wp_split_shared_term_batch",
  "wp_update_comment_type_batch",
  "wp_update_plugins",
  "wp_update_themes",
  "wp_update_user_counts",
  "wp_version_check",
];

/** A kind of exact name a product declares as its own, with the words its refusals use. */
interface OwnedNameKind {
  /** The kind, singular (`"role"`). */
  readonly one: string;
  /** The kind, plural (`"roles"`). */
  readonly many: string;
  /** WordPress's own names of this kind. */
  readonly protectedNames: readonly string[];
}

/** Roles, for {@link normaliseOwnedName}. */
const ROLE: OwnedNameKind = {
  one: "role",
  many: "roles",
  protectedNames: PROTECTED_ROLES,
};

/** Capabilities, for {@link normaliseOwnedName}. */
const CAPABILITY: OwnedNameKind = {
  one: "capability",
  many: "capabilities",
  protectedNames: PROTECTED_CAPABILITIES,
};

/** WP-Cron hooks, for {@link normaliseOwnedName}. */
const CRON_HOOK: OwnedNameKind = {
  one: "WP-Cron hook",
  many: "WP-Cron hooks",
  protectedNames: PROTECTED_CRON_HOOKS,
};

/**
 * Validates one declared option fragment and returns it trimmed.
 *
 * @param declared - the fragment as the product declared it.
 * @returns the fragment, trimmed.
 * @throws {@link Error} naming the fragment and the rule it broke.
 */
export function normaliseOptionFragment(declared: string): string {
  const fragment = declared.trim();
  const refuse = (reason: string): never => {
    throw new Error(
      `[wp/db-residue] "${declared}" cannot be used to match leftover options: ${reason}. ` +
        'Declare a fragment of the option names the product writes, e.g. "myplugin".',
    );
  };
  if (fragment.length < MIN_FRAGMENT_LENGTH) {
    return refuse(
      `it is shorter than ${String(MIN_FRAGMENT_LENGTH)} characters, so it would match ` +
        "options belonging to the site rather than to the product",
    );
  }
  if (!/^[A-Za-z0-9_-]+$/.test(fragment)) {
    return refuse(
      "it contains something other than letters, digits, underscore and hyphen — a fragment is " +
        "matched literally, so a wildcard here means only itself and is never what was intended",
    );
  }
  return fragment;
}

/**
 * Validates one declared table name and returns it trimmed.
 *
 * @param declared - the table name as the product declared it, without the site's prefix.
 * @returns the name, trimmed.
 * @throws {@link Error} naming the table and the rule it broke.
 */
export function normaliseResidueTable(declared: string): string {
  const table = declared.trim();
  const refuse = (reason: string): never => {
    throw new Error(
      `[wp/db-residue] "${declared}" cannot be dropped as a leftover table: ${reason}. ` +
        'Declare the name without the site\'s prefix, e.g. "myplugin_items".',
    );
  };
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    return refuse(
      "a table name may hold only letters, digits and underscores — it is written into `DROP " +
        "TABLE` as an identifier, which no query can parameterise",
    );
  }
  if (PROTECTED_TABLES.includes(table.toLowerCase())) {
    return refuse("it is one of WordPress's own tables");
  }
  return table;
}

/**
 * Validates one declared role, capability or WP-Cron hook name and returns it trimmed — the rules
 * all three share.
 *
 * @param kind - which kind of name, for the protected list and the message.
 * @param declared - the name as the product declared it.
 * @param fragments - the declaration's validated option fragments: the product's own names.
 * @returns the name, trimmed.
 * @throws {@link Error} naming the entry and the rule it broke.
 */
function normaliseOwnedName(
  kind: OwnedNameKind,
  declared: string,
  fragments: readonly string[],
): string {
  const name = declared.trim();
  const refuse = (reason: string): never => {
    throw new Error(
      `[wp/db-residue] "${declared}" cannot be removed as a leftover ${kind.one}: ${reason}. ` +
        `Declare the exact name of a ${kind.one} the product itself creates, e.g. "myplugin_manage".`,
    );
  };
  if (!/^[a-z0-9_-]+$/.test(name)) {
    return refuse(
      "a name may hold only lowercase letters, digits, underscore and hyphen — the shape of every " +
        `${kind.one} WordPress and its plugins create, so anything else is a typo`,
    );
  }
  if (kind.protectedNames.includes(name)) {
    return refuse(`it is one of WordPress's own ${kind.many}`);
  }
  if (!fragments.some((fragment) => name.includes(fragment))) {
    return refuse(
      fragments.length === 0
        ? "the declaration names no `optionsContaining` fragment, and a role, capability or " +
            "WP-Cron hook must carry one of the product's own names"
        : `it carries none of the product's names (${fragments.join(", ")}), so it may belong to ` +
            "the site or to another plugin",
    );
  }
  return name;
}

/**
 * Validates one declared role and returns it trimmed.
 *
 * @param declared - the role as the product declared it.
 * @param fragments - the declaration's validated option fragments, one of which the role must carry.
 * @returns the role, trimmed.
 * @throws {@link Error} naming the role and the rule it broke.
 */
export function normaliseResidueRole(
  declared: string,
  fragments: readonly string[],
): string {
  return normaliseOwnedName(ROLE, declared, fragments);
}

/**
 * Validates one declared capability and returns it trimmed.
 *
 * @param declared - the capability as the product declared it.
 * @param fragments - the declaration's validated option fragments, one of which it must carry.
 * @returns the capability, trimmed.
 * @throws {@link Error} naming the capability and the rule it broke.
 */
export function normaliseResidueCapability(
  declared: string,
  fragments: readonly string[],
): string {
  return normaliseOwnedName(CAPABILITY, declared, fragments);
}

/**
 * Validates one declared WP-Cron hook and returns it trimmed.
 *
 * @param declared - the hook as the product declared it.
 * @param fragments - the declaration's validated option fragments, one of which it must carry.
 * @returns the hook, trimmed.
 * @throws {@link Error} naming the hook and the rule it broke.
 */
export function normaliseResidueCronHook(
  declared: string,
  fragments: readonly string[],
): string {
  return normaliseOwnedName(CRON_HOOK, declared, fragments);
}

/** A declaration with every entry validated, and the empty case already collapsed. */
interface CheckedDbResidue {
  readonly fragments: readonly string[];
  readonly tables: readonly string[];
  readonly roles: readonly string[];
  readonly capabilities: readonly string[];
  readonly cronHooks: readonly string[];
}

/**
 * Validates a whole declaration up front, so a typo in one entry cannot leave a site half-swept.
 *
 * @param residue - the product's declaration.
 * @returns the validated fragments, tables, roles, capabilities and WP-Cron hooks.
 * @throws {@link Error} for the first entry that is not usable.
 */
function check(residue: SiteDbResidue): CheckedDbResidue {
  const fragments = (residue.optionsContaining ?? []).map(
    normaliseOptionFragment,
  );
  return {
    fragments,
    tables: (residue.tables ?? []).map(normaliseResidueTable),
    roles: (residue.roles ?? []).map((role) =>
      normaliseResidueRole(role, fragments),
    ),
    capabilities: (residue.capabilities ?? []).map((capability) =>
      normaliseResidueCapability(capability, fragments),
    ),
    cronHooks: (residue.cronHooks ?? []).map((hook) =>
      normaliseResidueCronHook(hook, fragments),
    ),
  };
}

/**
 * True when a validated declaration names nothing, so the site need not be asked. Every kind counts,
 * though roles, capabilities and WP-Cron hooks cannot be declared without a fragment today.
 */
function declaresNothing(checked: CheckedDbResidue): boolean {
  return (
    checked.fragments.length === 0 &&
    checked.tables.length === 0 &&
    checked.roles.length === 0 &&
    checked.capabilities.length === 0 &&
    checked.cronHooks.length === 0
  );
}

/**
 * Refuses a sweep that matched an option the site cannot lose.
 *
 * @param options - the option names the query matched.
 * @param prefix - the site's table prefix, which some protected names carry.
 * @throws {@link Error} naming every protected option matched, and nothing is removed.
 */
export function assertNoProtectedOptions(
  options: readonly string[],
  prefix: string,
): void {
  const protectedNames = new Set([
    ...PROTECTED_OPTIONS,
    ...PROTECTED_PREFIXED_OPTIONS.map((name) => `${prefix}${name}`),
  ]);
  const hits = options.filter((option) => protectedNames.has(option));
  if (hits.length === 0) return;
  throw new Error(
    `[wp/db-residue] refusing to remove leftover options: the declared fragments match ` +
      `${String(hits.length)} option(s) that belong to WordPress itself — ${hits.join(", ")}. ` +
      "Narrow the product's `optionsContaining` declaration; nothing has been removed.",
  );
}

/**
 * The PHP that finds every event of the hooks in `$declared_hooks`, whatever their arguments, leaving
 * them in `$cron_events` sorted by hook, time, then arguments.
 *
 * Read through `_get_cron_array()`, the reader WordPress's own cron runner and `wp_unschedule_hook`
 * use, so the sweep sees the events the site would run — through the option API, so an object cache
 * or a filter on the `cron` option answers as it would for the runner. Before WordPress 6.1 it
 * answers `false` for a missing option, hence the cast. An event whose arguments PHP cannot encode as
 * JSON is still reported, so it cannot read as clean.
 *
 * A malformed array is refused here, before anything is removed (the removal runs this first, in the
 * same process): `wp_unschedule_hook` walks **every** timestamp and crashes part-way on one that holds
 * no list of hooks, or on a declared hook whose entry holds no list of events — after the options,
 * tables and roles were already gone. A malformed timestamp counts only when there is an event to
 * remove; a declared hook's malformed entry always does, since it is the product's own leftover. The
 * message names counts and declared hooks, never a value. Exported for the spec that runs it on PHP.
 */
export const CRON_FIND_PHP = `
$cron_events    = [];
$cron_bad_times = 0;
$cron_bad_hooks = [];
if ( $declared_hooks ) {
  foreach ( (array) _get_cron_array() as $time => $hooks ) {
    if ( ! is_array( $hooks ) ) {
      ++$cron_bad_times;
      continue;
    }
    foreach ( $hooks as $hook => $instances ) {
      $hook = (string) $hook;
      if ( ! in_array( $hook, $declared_hooks, true ) ) {
        continue;
      }
      if ( ! is_array( $instances ) ) {
        $cron_bad_hooks[ $hook ] = true;
        continue;
      }
      foreach ( $instances as $instance ) {
        $args          = ( is_array( $instance ) && isset( $instance['args'] ) ) ? $instance['args'] : [];
        $json          = wp_json_encode( $args );
        $cron_events[] = [ 'hook' => $hook, 'time' => (int) $time, 'args' => false === $json ? '(not encodable)' : $json ];
      }
    }
  }
  $cron_problems = [];
  if ( $cron_bad_times && $cron_events ) {
    $cron_problems[] = $cron_bad_times . ' timestamp(s) hold no list of hooks';
  }
  if ( $cron_bad_hooks ) {
    $cron_problems[] = 'the entry of ' . implode( ', ', array_keys( $cron_bad_hooks ) ) . ' holds no list of events';
  }
  if ( $cron_problems ) {
    WP_CLI::error( "the site's WP-Cron array (the cron option) is malformed: " . implode( '; ', $cron_problems ) . ". WordPress would crash part-way unscheduling a hook from it, so the leftover-footprint sweep removed nothing; repair the cron option, then run again" );
  }
  usort( $cron_events, function ( $a, $b ) {
    return strcmp( $a['hook'], $b['hook'] ) ?: ( $a['time'] <=> $b['time'] ) ?: strcmp( $a['args'], $b['args'] );
  } );
}
`;

/**
 * The PHP that removes every event of each hook {@link CRON_FIND_PHP} found: `wp_unschedule_hook`
 * clears a hook whatever its events' arguments. Its return value is not trusted; the caller re-reads.
 * Exported for the spec that runs it on real PHP.
 */
export const CRON_REMOVE_PHP = `
foreach ( array_unique( array_column( $cron_events, 'hook' ) ) as $hook ) {
  wp_unschedule_hook( $hook );
}
`;

/**
 * The PHP that finds the footprint, leaving it in `$options`, `$tables`, `$roles`, `$grants` and
 * `$cron_events`.
 *
 * Shared by the scan and the removal so there is exactly one definition of what "matching" means —
 * a removal that matched differently from the scan that verified it would be worse than either.
 *
 * `esc_like` is what makes a fragment literal: it escapes `%` and `_`, so `bwpup_backups` cannot
 * also match `bwpupXbackups`. `prepare` then quotes the value. The prefix is validated rather than
 * escaped, because it is spliced into a table identifier, which no placeholder can carry.
 *
 * Roles are read from the roles option's **row**, not through `wp_roles()`, so the verifying re-read
 * sees the database rather than a cache. A site whose roles live in code (`$wp_user_roles`) or whose
 * row is missing is refused: neither can be swept, and an unreadable row must not read as clean. The
 * row is only read when roles or capabilities are declared.
 */
function matchPhp(checked: CheckedDbResidue): string {
  return `
global $wpdb;
if ( is_multisite() ) {
  WP_CLI::error( 'this site is multisite, where a plugin keeps its options in sitemeta per network; the leftover-footprint sweep only understands single-site installs' );
}
if ( ! preg_match( '/^[A-Za-z0-9_]+$/', $wpdb->prefix ) ) {
  WP_CLI::error( 'this site reports a table prefix that cannot be used as an identifier: ' . $wpdb->prefix );
}
$fragments      = ${phpLiteral(checked.fragments)};
$declared       = ${phpLiteral(checked.tables)};
$declared_roles = ${phpLiteral(checked.roles)};
$declared_caps  = ${phpLiteral(checked.capabilities)};
$declared_hooks = ${phpLiteral(checked.cronHooks)};
$options   = [];
if ( $fragments ) {
  $where = [];
  foreach ( $fragments as $fragment ) {
    $where[] = $wpdb->prepare( 'option_name LIKE %s', '%' . $wpdb->esc_like( $fragment ) . '%' );
  }
  $options = $wpdb->get_col( 'SELECT option_name FROM ' . $wpdb->options . ' WHERE ' . implode( ' OR ', $where ) . ' ORDER BY option_name' );
}
$tables = [];
foreach ( $declared as $name ) {
  $full = $wpdb->prefix . $name;
  if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $wpdb->esc_like( $full ) ) ) ) {
    $tables[] = $full;
  }
}
$roles  = [];
$grants = [];
if ( $declared_roles || $declared_caps ) {
  if ( ! empty( $GLOBALS['wp_user_roles'] ) ) {
    WP_CLI::error( 'this site defines its roles in code ($wp_user_roles), which the leftover-footprint sweep cannot change' );
  }
  $role_key = $wpdb->get_blog_prefix() . 'user_roles';
  $stored   = maybe_unserialize( $wpdb->get_var( $wpdb->prepare( 'SELECT option_value FROM ' . $wpdb->options . ' WHERE option_name = %s', $role_key ) ) );
  if ( ! is_array( $stored ) || ! $stored ) {
    WP_CLI::error( 'the roles option ' . $role_key . ' is missing or unreadable, so the leftover-footprint sweep cannot tell which roles the site holds' );
  }
  foreach ( $stored as $role => $data ) {
    $role = (string) $role;
    if ( in_array( $role, $declared_roles, true ) ) {
      $roles[] = $role;
      continue;
    }
    $caps = ( is_array( $data ) && isset( $data['capabilities'] ) && is_array( $data['capabilities'] ) ) ? $data['capabilities'] : [];
    foreach ( array_keys( $caps ) as $cap ) {
      if ( in_array( (string) $cap, $declared_caps, true ) ) {
        $grants[] = [ 'role' => $role, 'capability' => (string) $cap ];
      }
    }
  }
  sort( $roles );
  usort( $grants, function ( $a, $b ) {
    return strcmp( $a['role'], $b['role'] ) ?: strcmp( $a['capability'], $b['capability'] );
  } );
}
${CRON_FIND_PHP}`;
}

/** The PHP that reports what {@link matchPhp} found, as JSON. */
const REPORT_PHP = `
echo wp_json_encode( [ 'prefix' => $wpdb->prefix, 'options' => array_values( $options ), 'tables' => $tables, 'roles' => $roles, 'capabilities' => $grants, 'cronEvents' => $cron_events ] );
`;

/**
 * The PHP that finds the footprint and reports it, changing nothing: a scan, or a removal's re-read.
 *
 * @param checked - the validated declaration.
 * @returns the snippet.
 */
function scanPhp(checked: CheckedDbResidue): string {
  return matchPhp(checked) + REPORT_PHP;
}

/**
 * The scan snippet {@link findSiteDbResidue} sends for a declaration — exported for the spec that
 * runs it on PHP, so the reply's every field is proved to come from the snippet itself.
 *
 * @param residue - the product's declaration.
 * @returns the snippet.
 * @throws {@link Error} if a declared entry is unusable.
 */
export function footprintScanPhp(residue: SiteDbResidue): string {
  return scanPhp(check(residue));
}

/**
 * The PHP that removes what {@link matchPhp} found. Roles and capabilities go through the role API
 * (`remove_role`, `WP_Role::remove_cap`), which rewrites the roles option and its cache; WP-Cron
 * events through {@link CRON_REMOVE_PHP}.
 */
const REMOVE_PHP = `
foreach ( $options as $name ) {
  delete_option( $name );
}
foreach ( $tables as $table ) {
  $wpdb->query( 'DROP TABLE IF EXISTS \`' . $table . '\`' );
}
foreach ( $roles as $role ) {
  remove_role( $role );
}
foreach ( $grants as $grant ) {
  $holder = get_role( $grant['role'] );
  if ( $holder ) {
    $holder->remove_cap( $grant['capability'] );
  }
}
${CRON_REMOVE_PHP}`;

/** A scan's parsed reply: what was found, plus the prefix the protected-option check needs. */
interface ScanResult extends FoundDbResidue {
  readonly prefix: string;
}

/** Narrows an unknown JSON value to an array of strings. */
function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === "string") ? value : undefined;
}

/** Narrows an unknown JSON value to a list of {@link CapabilityGrant}s. */
function grantArray(value: unknown): CapabilityGrant[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const grants: CapabilityGrant[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      typeof item.role !== "string" ||
      typeof item.capability !== "string"
    ) {
      return undefined;
    }
    grants.push({ role: item.role, capability: item.capability });
  }
  return grants;
}

/** Narrows an unknown JSON value to a list of {@link CronEvent}s. */
function cronEventArray(value: unknown): CronEvent[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const events: CronEvent[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      typeof item.hook !== "string" ||
      typeof item.time !== "number" ||
      !Number.isInteger(item.time) ||
      typeof item.args !== "string"
    ) {
      return undefined;
    }
    events.push({ hook: item.hook, time: item.time, args: item.args });
  }
  return events;
}

/**
 * Parses a scan's reply.
 *
 * Validated rather than cast: the reply crosses a transport as text, and a site that printed a
 * notice before the JSON would otherwise be read as "nothing found" — the one answer that makes a
 * sweep silently do nothing. Every kind is required, so a missing one cannot read as empty either.
 *
 * @param raw - the snippet's trimmed output.
 * @returns the scan result.
 * @throws {@link Error} if the reply is not the expected shape.
 */
function parseScan(raw: string): ScanResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(
      `[wp/db-residue] the site's reply was not JSON: ${raw || "(no output)"}`,
    );
  }
  const fields = isObject(value) ? value : {};
  const prefix = fields.prefix;
  const options = stringArray(fields.options);
  const tables = stringArray(fields.tables);
  const roles = stringArray(fields.roles);
  const capabilities = grantArray(fields.capabilities);
  const cronEvents = cronEventArray(fields.cronEvents);
  if (
    typeof prefix !== "string" ||
    options === undefined ||
    tables === undefined ||
    roles === undefined ||
    capabilities === undefined ||
    cronEvents === undefined
  ) {
    throw new Error(
      `[wp/db-residue] the site's reply did not describe a footprint: ${raw || "(no output)"}`,
    );
  }
  return { prefix, options, tables, roles, capabilities, cronEvents };
}

/** A scan result without the prefix, as the public functions report it. */
function foundOf(scan: ScanResult): FoundDbResidue {
  const { options, tables, roles, capabilities, cronEvents } = scan;
  return { options, tables, roles, capabilities, cronEvents };
}

/**
 * Runs one footprint snippet against a site and parses its reply.
 *
 * Plugins are **not** loaded (`--skip-plugins`). Two reasons, both measured: the product's own
 * plugin re-creates every row of its footprint on `init`, so a sweep that loaded it could undo
 * itself within the one request; and the cells this suite runs carry unrelated plugins that hook
 * option and transient writes, which a cleanup step must not depend on. WordPress core — and so
 * `delete_option`, with the cache invalidation that makes a raw `DELETE` unsafe — is unaffected.
 */
async function runFootprintPhp(
  transport: Transport,
  php: string,
  what: string,
): Promise<ScanResult> {
  const raw = await evalPhp(transport, php, what, "wp/db-residue", {
    skipPlugins: true,
  });
  return parseScan(raw);
}

/**
 * Reports the declared footprint a site is currently carrying, without changing anything.
 *
 * @param transport - the site to ask.
 * @param residue - the product's declaration. Declaring nothing costs no round-trip at all.
 * @returns what is present, with tables at their full prefixed names.
 * @throws {@link Error} if a declared entry is unusable, if the site is multisite or keeps its roles
 * where they cannot be read, or if WordPress could not answer.
 */
export async function findSiteDbResidue(
  transport: Transport,
  residue: SiteDbResidue,
): Promise<FoundDbResidue> {
  const checked = check(residue);
  if (declaresNothing(checked)) return NOTHING_FOUND;
  const scan = await runFootprintPhp(
    transport,
    scanPhp(checked),
    "looking for a leftover plugin footprint",
  );
  return foundOf(scan);
}

/**
 * Removes the declared footprint from a site, and confirms it is gone.
 *
 * Rows go through `delete_option` rather than a `DELETE`, so WordPress invalidates its own caches as
 * it would for any other deletion — which is why no cache flush follows. Tables are dropped with
 * `IF EXISTS`, so a table that vanished between the scan and the drop is not an error. Roles and
 * capabilities go through the role API, which does the same for the roles option, and WP-Cron events
 * through `wp_unschedule_hook`, which rewrites the `cron` option.
 *
 * Removal is **verified by re-reading**, in a second process — the same discipline the rest of this
 * layer applies to WP-CLI's exit codes. A `DROP` reports success for a table it never had to touch,
 * and `delete_option` returns false both for "there was nothing there" and for "a filter refused it".
 * Options, tables and roles are re-read from the database itself; WP-Cron events through the option
 * API (`_get_cron_array()`), on purpose: what an object cache or a filter answers there is what the
 * cron runner would run. When only WP-Cron events survive, removal and re-read run once more: a
 * WP-Cron run in flight reschedules a recurring event before running it, and may have read the array
 * before the removal wrote it.
 *
 * @param transport - the site to clean.
 * @param residue - the product's declaration. Declaring nothing does nothing at all.
 * @returns what was removed, so a caller can say what it found rather than that it ran.
 * @throws {@link Error} if a declared entry is unusable, if a matched option belongs to WordPress
 * itself (nothing is removed), if the site is multisite or keeps its roles where they cannot be
 * read, or if WordPress could not answer; or {@link SiteDbResidueRemovalFailedError} naming
 * whatever survived the removal.
 */
export async function removeSiteDbResidue(
  transport: Transport,
  residue: SiteDbResidue,
): Promise<FoundDbResidue> {
  const checked = check(residue);
  if (declaresNothing(checked)) return NOTHING_FOUND;

  // Scanned before anything is removed, so the protected-option guard can refuse the whole sweep
  // rather than stop it half-way — and so a clean site pays one read and no write.
  const scan = await runFootprintPhp(
    transport,
    scanPhp(checked),
    "looking for a leftover plugin footprint",
  );
  if (isEmptyDbResidue(scan)) return NOTHING_FOUND;
  assertNoProtectedOptions(scan.options, scan.prefix);

  let after = await removeAndReread(transport, checked);
  if (onlyCronEventsLeft(after))
    after = await removeAndReread(transport, checked);
  if (!isEmptyDbResidue(after)) {
    throw new SiteDbResidueRemovalFailedError(foundOf(after));
  }
  return foundOf(scan);
}

/**
 * Removes what the declaration matches, then re-reads it in a second process.
 *
 * @param transport - the site to clean.
 * @param checked - the validated declaration.
 * @returns what the re-read still found.
 */
async function removeAndReread(
  transport: Transport,
  checked: CheckedDbResidue,
): Promise<ScanResult> {
  await runFootprintPhp(
    transport,
    matchPhp(checked) + REMOVE_PHP + REPORT_PHP,
    "removing a leftover plugin footprint",
  );
  return runFootprintPhp(
    transport,
    scanPhp(checked),
    "confirming the leftover plugin footprint is gone",
  );
}

/**
 * True when a re-read found WP-Cron events and nothing else — the one survivor a concurrent WP-Cron
 * run can put back, so worth one more removal.
 */
function onlyCronEventsLeft(found: FoundDbResidue): boolean {
  return (
    found.cronEvents.length > 0 &&
    isEmptyDbResidue({ ...found, cronEvents: [] })
  );
}
