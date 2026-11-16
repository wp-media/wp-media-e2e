<?php
/**
 * WP Rocket's own in-place edits, for `config-edits.php.spec.ts`: the bodies below are copied from
 * 3.24.1 with only WordPress's plumbing replaced (the filesystem class by plain file calls, filters by
 * their defaults, the rules by a fixed text). The spec runs them on a file, then checks the shared
 * engine puts the file back from its record.
 *
 * Usage: php wp-rocket-edits-harness.php <root> <operation>…
 *   operations: wp-cache:true | wp-cache:false | debug:true | debug:false (on <root>/wp-config.php),
 *               htaccess:add | htaccess:remove (on <root>/.htaccess; created if absent, as WP Rocket's touch).
 */

/** The rules `get_rocket_htaccess_marker()` would build: back-references and backslashes included. */
const E2E_RULES = "# Use UTF-8 encoding\nAddDefaultCharset UTF-8\n<IfModule mod_rewrite.c>\nRewriteRule ^(.*)$ /wp-content/cache/wp-rocket/%{HTTP_HOST}%{REQUEST_URI}/index.html [L]\nRewriteCond %{REQUEST_URI} \\.(css|js)$ [NC]\nRewriteRule .* - [E=WPR_ENC:$1]\n</IfModule>\n";

/**
 * `WPCache::set_wp_cache_constant()`, `inc/Engine/Cache/WPCache.php:125-166`, with
 * `get_wp_cache_content()` (`:314-318`, `WP_ROCKET_PLUGIN_NAME` = `WP Rocket`).
 */
function e2e_set_wp_cache_constant( $config_file_path, $value ) {
	$config_file_contents = file_get_contents( $config_file_path );
	$value                = $value ? 'true' : 'false';

	$wp_cache_found = preg_match( '/^\s*define\(\s*\'WP_CACHE\'\s*,\s*(?<value>[^\s\)]*)\s*\)/m', $config_file_contents, $matches );

	if (
		! empty( $matches['value'] )
		&&
		$matches['value'] === $value
	) {
		return false;
	}

	$constant = "define( 'WP_CACHE', {$value} ); // Added by WP Rocket";

	if ( ! $wp_cache_found ) {
		$config_file_contents = preg_replace( '/(<\?php)/i', "<?php\r\n{$constant}\r\n", $config_file_contents, 1 );
	} elseif ( ! empty( $matches['value'] ) && $matches['value'] !== $value ) {
		$config_file_contents = preg_replace( '/^\s*define\(\s*\'WP_CACHE\'\s*,\s*([^\s\)]*)\s*\).+/m', $constant, $config_file_contents );
	}

	return false !== file_put_contents( $config_file_path, $config_file_contents );
}

/**
 * `Logger::debug_enabled()` stand-in (`inc/Logger/Logger.php:411-441`): the runtime constant, which
 * here is what the file itself defines — `true` only.
 */
function e2e_debug_enabled( $file_path ) {
	return 1 === preg_match( '/^\s*define\(\s*[\'"]WP_ROCKET_DEBUG[\'"]\s*,\s*true\s*\)/mi', file_get_contents( $file_path ) );
}

/**
 * `Logger::define_debug()`, `inc/Logger/Logger.php:584-622` (`rocket_find_wpconfig_path()` and the
 * filesystem class replaced by the path given and plain file calls).
 */
function e2e_define_debug( $file_path, $enable ) {
	if ( $enable && e2e_debug_enabled( $file_path ) ) {
		// Debug is already enabled.
		return;
	}

	if ( ! $enable && ! e2e_debug_enabled( $file_path ) ) {
		// Debug is already disabled.
		return;
	}

	// Get the content of the file.
	$content = file_get_contents( $file_path );

	if ( false === $content ) {
		// Couldn't get the content of the file.
		return;
	}

	// Remove previous value.
	$placeholder = '## WP_ROCKET_DEBUG placeholder ##';
	$content     = preg_replace( '@^[\t ]*define\s*\(\s*["\']WP_ROCKET_DEBUG["\'].*$@miU', $placeholder, $content );
	$content     = preg_replace( "@\n$placeholder@", '', $content );

	if ( $enable ) {
		// Add the constant.
		$define  = "define( 'WP_ROCKET_DEBUG', true ); // Added by WP Rocket.\r\n";
		$content = preg_replace( '@<\?php\s*@i', "<?php\n$define", $content, 1 );
	}

	// Save the file.
	file_put_contents( $file_path, $content );
}

/**
 * `flush_rocket_htaccess()`, `inc/functions/htaccess.php:15-162`, from its file handling on (the
 * `$is_apache` and filter exits, and `get_home_path()`, replaced by the path given).
 */
function e2e_flush_rocket_htaccess( $filename, $remove_rules = false ) {
	$insertion = '';

	if ( ! $remove_rules ) {
		$insertion = E2E_RULES;
	}

	if ( ! file_exists( $filename ) ) {
		if ( ! touch( $filename ) ) {
			return false;
		}
	}

	if ( ! is_array( $insertion ) ) {
		$insertion = explode( "\n", $insertion );
	}

	$start_marker = '# BEGIN WP Rocket';
	$end_marker   = '# END WP Rocket';

	$pointer = fopen( $filename, 'r+' );

	if ( ! $pointer ) {
		return false;
	}

	flock( $pointer, LOCK_EX );

	$lines = [];

	while ( ! feof( $pointer ) ) {
		$lines[] = rtrim( fgets( $pointer ), "\r\n" );
	}

	$pre_lines        = [];
	$post_lines       = [];
	$existing_lines   = [];
	$found_marker     = false;
	$found_end_marker = false;

	foreach ( $lines as $line ) {
		if ( ! $found_marker && str_contains( $line, $start_marker ) ) {
			$found_marker = true;
			continue;
		} elseif ( ! $found_end_marker && str_contains( $line, $end_marker ) ) {
			$found_end_marker = true;
			continue;
		}

		if ( ! $found_marker ) {
			$pre_lines[] = $line;
		} elseif ( $found_marker && $found_end_marker ) {
			$post_lines[] = $line;
		} else {
			$existing_lines[] = $line;
		}
	}

	if ( $existing_lines === $insertion ) {
		flock( $pointer, LOCK_UN );
		fclose( $pointer );

		return true;
	}

	if ( ! $found_marker ) {
		$new_file_data = implode( "\n", array_merge( [ $start_marker ], $insertion, [ $end_marker ], $pre_lines, $post_lines ) );
	} elseif ( $remove_rules ) {
		$new_file_data = implode( "\n", array_merge( $pre_lines, $post_lines ) );
	} else {
		$new_file_data = implode( "\n", array_merge( $pre_lines, [ $start_marker ], $insertion, [ $end_marker ], $post_lines ) );
	}

	fseek( $pointer, 0 );
	$bytes = fwrite( $pointer, $new_file_data );

	if ( false !== $bytes ) {
		ftruncate( $pointer, ftell( $pointer ) );
	}

	fflush( $pointer );
	flock( $pointer, LOCK_UN );
	fclose( $pointer );

	return (bool) $bytes;
}

$root = rtrim( $argv[1], '/' );
foreach ( array_slice( $argv, 2 ) as $operation ) {
	switch ( $operation ) {
		case 'wp-cache:true':
		case 'wp-cache:false':
			e2e_set_wp_cache_constant( "$root/wp-config.php", 'wp-cache:true' === $operation );
			break;
		case 'debug:true':
		case 'debug:false':
			e2e_define_debug( "$root/wp-config.php", 'debug:true' === $operation );
			break;
		case 'htaccess:add':
		case 'htaccess:remove':
			e2e_flush_rocket_htaccess( "$root/.htaccess", 'htaccess:remove' === $operation );
			break;
		default:
			fwrite( STDERR, "unknown operation $operation\n" );
			exit( 2 );
	}
}
