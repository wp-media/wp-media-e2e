<?php
/**
 * Runs the in-place cleanup engine (`../wp/config-edits.ts`) outside WordPress and WP-CLI, for
 * `config-edits.php.spec.ts`: WP-CLI's error stubbed, the working directory set as WP-CLI's would be.
 *
 * Usage: php config-edits-harness.php <snippet file> <WordPress root>
 *   evaluates the snippet in the root; a `WP_CLI::error()` prints its message and exits 1.
 *   With E2E_INTERRUPT_AFTER (+ E2E_SWAP_PATH, E2E_SWAP_TARGET): killed, or a path swapped for a link, mid-run.
 */

/** WP-CLI's error: print and exit 1. */
class WP_CLI {
	public static function error( $message ) {
		fwrite( STDOUT, 'Error: ' . $message );
		exit( 1 );
	}
}

if ( ! chdir( $argv[2] ) ) {
	fwrite( STDOUT, 'Error: no such root' );
	exit( 2 );
}
$e2e_snippet = file_get_contents( $argv[1] );
$e2e_after   = getenv( 'E2E_INTERRUPT_AFTER' );
if ( false !== $e2e_after && '' !== $e2e_after ) {
	/*
	 * A race made exact: once a statement on a snippet line holding E2E_INTERRUPT_AFTER has run (its
	 * E2E_INTERRUPT_NTH time, default 1), E2E_SWAP_PATH becomes a symbolic link to E2E_SWAP_TARGET — what another process could do
	 * between two of the engine's statements —, or, without E2E_SWAP_PATH, the run is killed there
	 * (exit 137). Ticks fire after each statement of code compiled with them; the declaration shares
	 * the snippet's first line, so line numbers stay the snippet's.
	 */
	$e2e_lines = explode( "\n", $e2e_snippet );
	register_tick_function(
		function () use ( $e2e_lines, $e2e_after ) {
			static $seen = 0;
			$frame = debug_backtrace( DEBUG_BACKTRACE_IGNORE_ARGS, 1 );
			$line  = isset( $frame[0]['line'] ) ? $frame[0]['line'] : 0;
			if ( ! isset( $e2e_lines[ $line - 1 ] ) || false === strpos( $e2e_lines[ $line - 1 ], $e2e_after ) ) {
				return;
			}
			++$seen;
			if ( $seen !== max( 1, (int) getenv( 'E2E_INTERRUPT_NTH' ) ) ) {
				return;
			}
			if ( false === getenv( 'E2E_SWAP_PATH' ) ) {
				exit( 137 );
			}
			@unlink( getenv( 'E2E_SWAP_PATH' ) );
			symlink( getenv( 'E2E_SWAP_TARGET' ), getenv( 'E2E_SWAP_PATH' ) );
		}
	);
	$e2e_snippet = 'declare(ticks=1); ' . $e2e_snippet;
}
eval( $e2e_snippet );
