<?php
/**
 * Runs WP Rocket's forced-deactivation snippet outside WordPress, for `deactivation.spec.ts`, over a
 * stubbed site: an options table (names only), an optional persistent object cache holding the
 * transients instead, `active_plugins`, the current user, the users who can activate plugins, and WP
 * Rocket's own refusal as its deactivation hook does it (3.24: `Deactivation::deactivate_plugin` asks
 * `rocket_prevent_deactivation`, where `WPCache` appends `'wpconfig'`; with any cause it stores the
 * `<user id>_donotdeactivaterocket` transient and `die()`s inside core's `deactivate_plugins()`,
 * before `active_plugins` is saved).
 *
 * Usage: php deactivation-harness.php <snippet file> <site json> <state out file>
 *   site: {"root": <dir holding wp-admin/includes/plugin.php>, "userId": n, "active": [...],
 *          "options": [...option names], "causes": [...what WP Rocket's filter adds],
 *          "admins": [...ids get_users answers for `activate_plugins`],
 *          "cache": [...transient names] — present: a persistent object cache, transients live there}
 *   On exit — normal, `die()` or `WP_CLI::error()` — the site is written to <state out file> as
 *   {"active": [...], "options": [...], "cache": [...]}; the snippet's output goes to stdout.
 */

$e2e_site = json_decode( file_get_contents( $argv[2] ), true );
$e2e_out  = $argv[3];
$e2e_hook = array();

define( 'ABSPATH', rtrim( $e2e_site['root'], '/' ) . '/' );

register_shutdown_function(
	static function () use ( $e2e_out ) {
		global $e2e_site;
		file_put_contents(
			$e2e_out,
			json_encode(
				array(
					'active'  => array_values( $e2e_site['active'] ),
					'options' => array_values( $e2e_site['options'] ),
					'cache'   => array_values( $e2e_site['cache'] ?? array() ),
				)
			)
		);
	}
);

/** WordPress's add_filter: by priority, then in order added. */
function add_filter( $hook, $callback, $priority = 10 ) {
	global $e2e_hook;
	$e2e_hook[ $hook ][ $priority ][] = $callback;
	return true;
}

/** WordPress's apply_filters. */
function apply_filters( $hook, $value ) {
	global $e2e_hook;
	$by_priority = $e2e_hook[ $hook ] ?? array();
	ksort( $by_priority );
	foreach ( $by_priority as $callbacks ) {
		foreach ( $callbacks as $callback ) {
			$value = $callback( $value );
		}
	}
	return $value;
}

/** WordPress's wp_json_encode, reduced. */
function wp_json_encode( $value ) {
	return json_encode( $value );
}

/** WordPress's get_current_user_id. */
function get_current_user_id() {
	global $e2e_site;
	return (int) $e2e_site['userId'];
}

/** Whether the site has a persistent object cache: transients then live there, never in options. */
function e2e_object_cache() {
	global $e2e_site;
	return isset( $e2e_site['cache'] );
}

/** WordPress's set_transient, reduced to the name it writes (no expiry: no timeout row). */
function set_transient( $name, $value ) {
	global $e2e_site;
	if ( e2e_object_cache() ) {
		$e2e_site['cache'][] = $name;
	} else {
		$e2e_site['options'][] = '_transient_' . $name;
	}
	return true;
}

/** WordPress's delete_transient: the cache key, else the value and timeout rows; true when it was there. */
function delete_transient( $name ) {
	global $e2e_site;
	if ( e2e_object_cache() ) {
		$before            = $e2e_site['cache'];
		$e2e_site['cache'] = array_values( array_diff( $before, array( $name ) ) );
		return in_array( $name, $before, true );
	}
	$before              = $e2e_site['options'];
	$e2e_site['options'] = array_values(
		array_diff( $before, array( '_transient_' . $name, '_transient_timeout_' . $name ) )
	);
	return in_array( '_transient_' . $name, $before, true );
}

/** WordPress's get_users, for the one query the snippet makes: ids of who can activate plugins. */
function get_users( $args ) {
	global $e2e_site;
	if ( array( 'capability' => 'activate_plugins', 'fields' => 'ID' ) !== $args ) {
		fwrite( STDERR, 'unexpected get_users query: ' . json_encode( $args ) );
		exit( 3 );
	}
	// As WordPress answers `fields => ID`: strings.
	return array_map( 'strval', $e2e_site['admins'] ?? array() );
}

/** WordPress's is_plugin_active. */
function is_plugin_active( $plugin ) {
	global $e2e_site;
	return in_array( $plugin, $e2e_site['active'], true );
}

/** Core's deactivate_plugins for WP Rocket alone, its deactivation hook's refusal included. */
function deactivate_plugins( $plugin ) {
	global $e2e_site;
	if ( ! is_plugin_active( $plugin ) ) {
		return;
	}
	$causes = (array) apply_filters( 'rocket_prevent_deactivation', array() );
	if ( count( $causes ) ) {
		set_transient( get_current_user_id() . '_donotdeactivaterocket', $causes );
		die();
	}
	$e2e_site['active'] = array_values( array_diff( $e2e_site['active'], array( $plugin ) ) );
}

/** WP-CLI's error: print and exit 1. */
class WP_CLI {
	public static function error( $message ) {
		fwrite( STDOUT, 'Error: ' . $message );
		exit( 1 );
	}
}

/** $wpdb, reduced to the options table's names and a LIKE over them. */
class E2E_Wpdb {
	public $options    = 'wp_options';
	public $last_error = '';

	public function esc_like( $text ) {
		return addcslashes( $text, '_%\\' );
	}

	public function prepare( $query, $value ) {
		return str_replace( '%s', "'" . addslashes( $value ) . "'", $query );
	}

	public function get_col( $query ) {
		global $e2e_site;
		if ( ! preg_match( "/LIKE '(.*)'$/", $query, $match ) ) {
			$this->last_error = 'unexpected query';
			return array();
		}
		// LIKE to a regex: `\x` literal, `%` any run, `_` one character.
		$regex = '';
		$like  = stripslashes( $match[1] );
		for ( $i = 0; $i < strlen( $like ); $i++ ) {
			$c = $like[ $i ];
			if ( '\\' === $c ) {
				$regex .= preg_quote( $like[ ++$i ], '/' );
			} elseif ( '%' === $c ) {
				$regex .= '.*';
			} elseif ( '_' === $c ) {
				$regex .= '.';
			} else {
				$regex .= preg_quote( $c, '/' );
			}
		}
		return array_values( preg_grep( '/^' . $regex . '$/s', $e2e_site['options'] ) );
	}
}

$wpdb = new E2E_Wpdb();

// WP Rocket's own filter, as `WPCache::maybe_prevent_deactivation` (default priority) adds its cause.
add_filter(
	'rocket_prevent_deactivation',
	static function ( $causes ) {
		global $e2e_site;
		return array_merge( (array) $causes, $e2e_site['causes'] );
	}
);

eval( file_get_contents( $argv[1] ) );
