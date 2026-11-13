<?php
/**
 * Runs WP Rocket's licence PHP outside WordPress, for `licence.php.spec.ts`, with the few WordPress
 * and WP-CLI functions it calls stubbed.
 *
 * Usage: php licence-harness.php plugin <mu-plugin file> [define-abspath: 1|0]
 *          includes the must-use plugin and prints {"filters": {<option>: <value>}} as JSON;
 *        php licence-harness.php write <snippet file> <root> <mu-plugin dir>
 *          runs the write snippet with ABSPATH = <root>/ and WPMU_PLUGIN_DIR = <mu-plugin dir>;
 *          a `WP_CLI::error()` prints its message and exits 1.
 */

$e2e_filters = array();

/** Records a filter's callback by hook name (WordPress's add_filter, reduced). */
function add_filter( $hook, $callback ) {
	global $e2e_filters;
	$e2e_filters[ $hook ] = $callback;
	return true;
}

/** WordPress's wp_normalize_path, reduced to the separator. */
function wp_normalize_path( $path ) {
	return str_replace( '\\', '/', $path );
}

/** WordPress's untrailingslashit. */
function untrailingslashit( $value ) {
	return rtrim( $value, '/\\' );
}

/** WordPress's wp_mkdir_p, reduced. */
function wp_mkdir_p( $target ) {
	return is_dir( $target ) || mkdir( $target, 0755, true );
}

/** WP-CLI's error: print and exit 1. */
class WP_CLI {
	public static function error( $message ) {
		fwrite( STDOUT, 'Error: ' . $message );
		exit( 1 );
	}
}

$mode = $argv[1];
if ( 'plugin' === $mode ) {
	if ( '0' !== ( $argv[3] ?? '1' ) ) {
		define( 'ABSPATH', '/' );
	}
	include $argv[2];
	$answers = array();
	foreach ( $e2e_filters as $hook => $callback ) {
		$answers[ substr( $hook, strlen( 'pre_get_rocket_option_' ) ) ] = $callback( null, '' );
	}
	echo json_encode( array( 'filters' => (object) $answers ) );
	exit( 0 );
}

define( 'ABSPATH', rtrim( $argv[3], '/' ) . '/' );
define( 'WPMU_PLUGIN_DIR', $argv[4] );
eval( file_get_contents( $argv[2] ) );
