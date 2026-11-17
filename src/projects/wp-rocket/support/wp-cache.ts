import { isObject } from "../../../common/guards";
import { evalPhp } from "../../../common/wp/php";
import type { Transport } from "../../../common/config/types";
import type { IdentityState } from "../../../common/wp/site-identity";
import type { SiteIdentityVerdict } from "../../../common/wp/web-identity";

/**
 * Whether WordPress loads a page cache: `WP_CACHE` true in `wp-config.php`. WP Rocket writes it from
 * two places (3.24.1, `Engine/Cache/WPCache.php`): its activation (`update_wp_cache`), run by whoever
 * activates it — the site's commands here —, and every admin request while it is off
 * (`maybe_set_wp_cache` on `admin_init`), run by the web server's PHP — the `@plugin` hook's settling
 * request. Each can write only a file its own user may write. Without `WP_CACHE`, `advanced-cache.php`
 * never loads, so no page is cached, whatever WP Rocket's settings say.
 */

/** `wp-config.php`'s owner and permission bits, as `stat()` reports them. */
export interface ConfigFileStat {
  readonly uid: number;
  readonly gid: number;
  /** The permission bits (`mode & 07777`). */
  readonly mode: number;
}

/** What the site says about `WP_CACHE` and the file defining it. */
export interface WpCacheState {
  /** `WP_CACHE` is defined and truthy — what `wp-settings.php` checks before loading `advanced-cache.php`. */
  readonly wpCache: boolean;
  /** `wp-config.php` (in the root, or the folder above as WordPress allows) is writable by the site's commands. */
  readonly configWritable: boolean;
  /** That file's owner and mode; `undefined` when there is none. */
  readonly config: ConfigFileStat | undefined;
  /** Who the site's commands ran as: the user's name, else its uid; empty when PHP has no `posix`. */
  readonly commandsUser: string;
}

/**
 * PHP that prints {@link WpCacheState} as JSON. `wp-config.php` is found where WordPress looks for it:
 * the root, else the folder above (when that one holds no `wp-settings.php`).
 */
export const WP_CACHE_STATE_PHP = `
clearstatcache();
$config = ABSPATH . 'wp-config.php';
if ( ! file_exists( $config ) && file_exists( dirname( ABSPATH ) . '/wp-config.php' ) && ! file_exists( dirname( ABSPATH ) . '/wp-settings.php' ) ) {
	$config = dirname( ABSPATH ) . '/wp-config.php';
}
$stat = file_exists( $config ) ? stat( $config ) : false;
$user = '';
if ( function_exists( 'posix_geteuid' ) ) {
	$pw   = function_exists( 'posix_getpwuid' ) ? posix_getpwuid( posix_geteuid() ) : false;
	$user = is_array( $pw ) ? $pw['name'] : (string) posix_geteuid();
}
echo wp_json_encode( [
	'wpCache'        => defined( 'WP_CACHE' ) && (bool) WP_CACHE,
	'configWritable' => is_writable( $config ),
	'config'         => $stat ? [ 'uid' => $stat['uid'], 'gid' => $stat['gid'], 'mode' => $stat['mode'] & 07777 ] : null,
	'commandsUser'   => $user,
] );`;

/**
 * Reads a {@link ConfigFileStat} from JSON, or `undefined` when it is not one.
 *
 * @param value - the parsed `config` field.
 */
function configStatFrom(value: unknown): ConfigFileStat | undefined {
  if (!isObject(value)) return undefined;
  const { uid, gid, mode } = value;
  return typeof uid === "number" &&
    typeof gid === "number" &&
    typeof mode === "number" &&
    [uid, gid, mode].every((n) => Number.isInteger(n) && n >= 0)
    ? { uid, gid, mode }
    : undefined;
}

/**
 * Reads {@link WP_CACHE_STATE_PHP}'s reply.
 *
 * @param reply - the snippet's output.
 * @throws Error when the reply is not the state.
 */
export function parseWpCacheState(reply: string): WpCacheState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    parsed = undefined;
  }
  const config = isObject(parsed) ? configStatFrom(parsed.config) : undefined;
  if (
    !isObject(parsed) ||
    typeof parsed.wpCache !== "boolean" ||
    typeof parsed.configWritable !== "boolean" ||
    typeof parsed.commandsUser !== "string" ||
    (parsed.config !== null && config === undefined)
  ) {
    throw new Error(
      `[wp-rocket] reading WP_CACHE came back as ${reply.slice(0, 300) || "(empty)"}, not its state.`,
    );
  }
  return {
    wpCache: parsed.wpCache,
    configWritable: parsed.configWritable,
    config,
    commandsUser: parsed.commandsUser,
  };
}

/** Who the web server's PHP runs as, as far as the run knows. */
export type WebServerIdentity =
  /** The site's commands run as it (`site`; or `docker`/`local`, which have no other identity). */
  | { readonly kind: "commands" }
  /** The pre-flight asked the web server (`site-identity.json`). */
  | {
      readonly kind: "known";
      readonly euid: number;
      readonly egid: number;
      /** The user's name, else `uid <n>`. */
      readonly name: string;
    }
  /** Nobody asked it, or the question went unanswered (`why`). */
  | { readonly kind: "unknown"; readonly why: string };

/**
 * Who the web server's PHP runs as, from the site's identity state and the pre-flight's verdict. Pure.
 *
 * @param state - the site's identity state (`resolveSiteIdentity`).
 * @param verdict - the pre-flight's verdict this process holds (`siteIdentityVerdict`).
 */
export function webServerIdentity(
  state: IdentityState,
  verdict: SiteIdentityVerdict | undefined,
): WebServerIdentity {
  if (
    state.kind === "site" ||
    (state.kind === "same-user" && state.reason === "mode")
  ) {
    return { kind: "commands" };
  }
  if (verdict !== undefined && verdict.verdict !== "unverified") {
    const { web } = verdict;
    return {
      kind: "known",
      euid: web.euid,
      egid: web.egid,
      name: web.user ?? `uid ${String(web.euid)}`,
    };
  }
  return {
    kind: "unknown",
    why:
      verdict === undefined
        ? "no pre-flight verdict names it"
        : `the pre-flight could not tell: ${verdict.detail}`,
  };
}

/**
 * Whether the web server's PHP may write `wp-config.php`, judged from the file's mode and never
 * wrongly "no": root writes anything; the owner class by uid; a group-writable file counts as writable
 * whatever its group (PHP's supplementary groups are unknown); else the others' bit, unless PHP's
 * primary group is the file's (the group class then decides). Unknown identity: writable. Pure.
 *
 * @param state - the site's answer.
 * @param web - who the web server's PHP runs as.
 */
export function webMayWriteConfig(
  state: WpCacheState,
  web: WebServerIdentity,
): boolean {
  switch (web.kind) {
    case "commands":
      return state.configWritable;
    case "unknown":
      return true;
    case "known": {
      const config = state.config;
      if (config === undefined) return false;
      if (web.euid === 0) return true;
      if (web.euid === config.uid) return (config.mode & 0o200) !== 0;
      if ((config.mode & 0o020) !== 0) return true;
      return web.egid !== config.gid && (config.mode & 0o002) !== 0;
    }
  }
}

/** Whether a page cache can be expected of WP Rocket on this site, and why not. */
export type PageCacheVerdict =
  /** `WP_CACHE` is on: pages are cached. */
  | { readonly kind: "on" }
  /** Neither the site's commands nor the web server can write `wp-config.php`: the site's setup, not WP Rocket. */
  | { readonly kind: "unwritable-config"; readonly reason: string }
  /** One of them could write it, yet `WP_CACHE` is not on: WP Rocket failed to turn it on. */
  | { readonly kind: "off"; readonly reason: string };

/**
 * The site's commands, named for a message.
 *
 * @param state - the site's answer.
 */
function commandsName(state: WpCacheState): string {
  return state.commandsUser === ""
    ? "the site's commands"
    : `the site's commands (${state.commandsUser})`;
}

/**
 * The web server's PHP, named for a message.
 *
 * @param state - the site's answer.
 * @param web - who it runs as.
 */
function webName(state: WpCacheState, web: WebServerIdentity): string {
  switch (web.kind) {
    case "commands":
      return `the web server's PHP (${state.commandsUser || "the same user"})`;
    case "known":
      return `the web server's PHP (${web.name})`;
    case "unknown":
      return `the web server's PHP (unknown: ${web.why})`;
  }
}

/**
 * What {@link WpCacheState} means for a scenario expecting cached pages: skipped only when **neither**
 * writer could have defined `WP_CACHE`; with either able to, its absence is WP Rocket's failure (or
 * the settling request's, which the `@plugin` hook warns about). Pure.
 *
 * @param state - the site's answer, read with WP Rocket active.
 * @param web - who the web server's PHP runs as ({@link webServerIdentity}).
 */
export function pageCacheVerdict(
  state: WpCacheState,
  web: WebServerIdentity,
): PageCacheVerdict {
  if (state.wpCache) return { kind: "on" };
  const commands = commandsName(state);
  const server = webName(state, web);
  if (state.configWritable) {
    return {
      kind: "off",
      reason: `WP_CACHE is not true in wp-config.php although ${commands} can write it: WP Rocket's activation did not turn on WordPress's page cache.`,
    };
  }
  if (webMayWriteConfig(state, web)) {
    return {
      kind: "off",
      reason:
        `WP_CACHE is not true in wp-config.php, which ${commands} cannot write but ${server} ` +
        `${web.kind === "unknown" ? "may" : "can"}: WP Rocket's admin request (the @plugin hook's ` +
        "settling request, warned about if it failed) did not turn on WordPress's page cache.",
    };
  }
  return {
    kind: "unwritable-config",
    reason:
      `wp-config.php is writable by neither ${commands} nor ${server}, so WP Rocket could not ` +
      "define WP_CACHE and caches no page; a site set up this way needs " +
      "`define( 'WP_CACHE', true );` added by hand.",
  };
}

/**
 * Asks the site, with WP Rocket active, whether WordPress loads a page cache.
 *
 * @param transport - the site's transport.
 * @throws Error when the site could not be asked, or answered something else.
 */
export async function readWpCacheState(
  transport: Transport,
): Promise<WpCacheState> {
  return parseWpCacheState(
    await evalPhp(
      transport,
      WP_CACHE_STATE_PHP,
      "reading WP_CACHE",
      "wp-rocket",
    ),
  );
}
