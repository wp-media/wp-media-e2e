import { createHash } from "node:crypto";

import { evalPhp, phpLiteral } from "./php";
import { installKey } from "./transport-exec";
import {
  parseRecordAnswer,
  parseRestoreAnswer,
} from "./config-edits-declaration";
import type { RecordAnswer, RestoreAnswer } from "./config-edits-declaration";
import type { ConfigEdits, Transport } from "../config/types";

/**
 * In-place cleanup: what a plugin edits in files it does not own (`wp-config.php`, `.htaccess`) put
 * back as it was, byte for byte, when — and only when — the plugin's own edits explain the difference.
 *
 * - **Record**, before each `@plugin` scenario (after the old copy's removal): each tracked file's
 *   bytes, SHA-256, mode, owner and inode, and whether each created file or directory exists, in
 *   `/tmp/e2e-record-<16 hex>-<euid>/` — **outside the docroot**, so the web server never serves the
 *   copy of `wp-config.php` (database credentials). The folder is `0700` and its files `0600`, the run
 *   identity's (the web server's in `site`, who can read `wp-config.php` anyway); the effective uid in
 *   its name keeps each identity to its own. Anything else at that name (another user's, a link, open
 *   to others) is **never used**: no reconcile, no record — warned, the run goes on, and that
 *   scenario's edits stay, as after a reboot. Committed by renaming its `meta.json` into place last,
 *   so a run killed while recording leaves a record without it, discarded next time; removed
 *   `meta.json` first, for the same reason.
 * - **Restore**, after the teardown's removal and residue sweep: the candidates are the recorded text
 *   with every sequence of the declared operations applied (up to {@link MAX_OPERATIONS}), run by the
 *   site's own PHP with the plugin's own patterns; a file equal to one is written back in place
 *   (same inode, owner; the mode set back unless that fails) — refused, untouched, if the path no longer
 *   leads to the file checked. So is a strict prefix of the recorded bytes, empty included: a put-back
 *   cut short (it truncates, then writes; the failure keeps the record), finished by the next run —
 *   writing back adds only recorded bytes. Anything else is warned about and never touched; an owner
 *   that changed is reported, never changed (the bytes still go back in place).
 *   The record is removed last, once every path has a verdict; a run killed before leaves it, and the
 *   next record step **reconciles** it — restores from it — before recording anew.
 * - Both run as `wp eval --skip-wordpress` through the site's identity: WordPress is never booted, so
 *   a `wp-config.php` that stops it booting is still put back. No byte of a tracked file leaves the
 *   host, and no message carries one.
 * - Stale records (this identity's private ones, untouched for {@link STALE_RECORD_DAYS} days) are
 *   swept by the record step, best-effort (one that will not go is counted, never a failure): a record
 *   must outlive a killed run until its site's next scenario, so no shorter age is safe. A reboot
 *   clears `/tmp` anyway; the site then keeps the plugin's edits, as before this. So does a record
 *   another identity left (one run in `site`, the next in `fallback`): only that identity reconciles it.
 */

/** Where records live: the host's shared temporary folder, never under the docroot. */
export const RECORD_PARENT = "/tmp";

/** Every record's folder name starts with this; the stale sweep matches nothing else. */
export const RECORD_PREFIX = "e2e-record-";

/** How many operations a candidate may chain: activation, deactivation, a reinstall's pair. */
export const MAX_OPERATIONS = 4;

/** How old, in days, another record of this identity must be before the record step removes it. */
export const STALE_RECORD_DAYS = 30;

/**
 * The record folder's name without its identity: `/tmp/e2e-record-<first 16 hex of
 * sha256(installKey NUL slug)>`; the engine appends `-<effective uid>` (only the site knows it). The
 * slug is part of the key so two products' records on one site never meet.
 *
 * @param transport - the site.
 * @param slug - the plugin's slug.
 */
export function recordStemFor(transport: Transport, slug: string): string {
  const key = createHash("sha256")
    .update(`${installKey(transport)}\u0000${slug}`)
    .digest("hex")
    .slice(0, 16);
  return `${RECORD_PARENT}/${RECORD_PREFIX}${key}`;
}

/**
 * The engine, without its inputs ({@link configEditsPhp} prepends them): `$e2e_mode` (`record` or
 * `restore`), `$e2e_stem` (the record folder, {@link recordStemFor}), `$e2e_spec` (the declaration), `$e2e_max` and
 * `$e2e_stale` (seconds). Runs in the WordPress root (the working directory). PHP 7.0+.
 */
export const CONFIG_EDITS_PHP = String.raw`
// What a failure adds to its message: what this run already did that the answer would have said.
$e2e_context = '';
$e2e_fail = function ( $message ) use ( &$e2e_context ) {
	WP_CLI::error( $message . $e2e_context );
};
$e2e_root = getcwd();
if ( false === $e2e_root || ! is_file( $e2e_root . '/wp-settings.php' ) ) {
	$e2e_fail( 'the working directory is not a WordPress root' );
}
$e2e_root = rtrim( $e2e_root, '/' ) . '/';
umask( 0077 );
if ( function_exists( 'posix_geteuid' ) ) {
	$e2e_uid = posix_geteuid();
} else {
	// Without posix: a file made now is this process's own.
	$e2e_probe = tempnam( sys_get_temp_dir(), 'e2e-uid-' );
	if ( false === $e2e_probe ) {
		$e2e_fail( 'could not tell which user this is' );
	}
	$e2e_uid = fileowner( $e2e_probe );
	unlink( $e2e_probe );
}
// Each identity has a folder of its own: one left by another (a killed run's in another identity
// state, or made by any local user) never stands in this one's way.
$e2e_dir = $e2e_stem . '-' . $e2e_uid;
$e2e_stat = function ( $path ) {
	clearstatcache( true, $path );
	$s = @lstat( $path );
	if ( false === $s ) {
		return array( 'type' => 'absent' );
	}
	$types = array( 0120000 => 'link', 0100000 => 'file', 0040000 => 'dir' );
	$type  = $s['mode'] & 0170000;
	return array(
		'type' => isset( $types[ $type ] ) ? $types[ $type ] : 'other',
		'mode' => $s['mode'] & 07777,
		'dev'  => $s['dev'],
		'uid'  => $s['uid'],
		'gid'  => $s['gid'],
		'ino'  => $s['ino'],
		'size'  => $s['size'],
		'mtime' => $s['mtime'],
	);
};
// The record folder: absent, this identity's private folder (ours), or anything else (blocked: never
// read, written or removed — a link, another user's, or open to others).
$e2e_check_dir = function () use ( $e2e_dir, $e2e_stat, $e2e_uid ) {
	$s = $e2e_stat( $e2e_dir );
	if ( 'absent' === $s['type'] ) {
		return 'absent';
	}
	return 'dir' === $s['type'] && $s['uid'] === $e2e_uid && 0 === ( $s['mode'] & 0077 ) ? 'ours' : 'blocked';
};
$e2e_read = function ( $path ) use ( $e2e_fail ) {
	$bytes = @file_get_contents( $path );
	if ( false === $bytes ) {
		$e2e_fail( 'reading ' . $path . ' failed' );
	}
	return $bytes;
};
// A new file of the record's: created exclusively (never through a link), 0600 by the umask.
$e2e_write_new = function ( $path, $bytes ) use ( $e2e_fail ) {
	$h = @fopen( $path, 'xb' );
	if ( false === $h || strlen( $bytes ) !== fwrite( $h, $bytes ) || ! fclose( $h ) ) {
		$e2e_fail( 'writing ' . $path . ' failed' );
	}
};
// Removes a record folder; false when anything stayed. meta.json goes first, so a drop cut short
// leaves an unfinished record (discarded quietly next time), never an index whose copies are gone.
$e2e_drop_record = function ( $dir ) use ( $e2e_stat ) {
	$names = @scandir( $dir );
	if ( false === $names ) {
		return false;
	}
	$names = array_merge( array( 'meta.json' ), array_diff( $names, array( '.', '..', 'meta.json' ) ) );
	$ok    = true;
	foreach ( $names as $name ) {
		$s = $e2e_stat( $dir . '/' . $name );
		if ( 'absent' !== $s['type'] && ( 'dir' === $s['type'] || ! @unlink( $dir . '/' . $name ) ) ) {
			$ok = false;
		}
	}
	return @rmdir( $dir ) && $ok;
};
// The same, for a record this run must see gone before it goes on.
$e2e_drop_or_fail = function ( $dir ) use ( $e2e_drop_record, $e2e_fail ) {
	if ( ! $e2e_drop_record( $dir ) ) {
		$e2e_fail( 'removing the record folder ' . $dir . ' failed' );
	}
};
$e2e_preg = function ( $result, $what ) use ( $e2e_fail ) {
	if ( null === $result || false === $result ) {
		$e2e_fail( $what . ': PCRE error ' . preg_last_error() );
	}
	return $result;
};
// One operation on a text; null when it needs a capture the file does not hold.
$e2e_apply = function ( $text, $operation, $captures, $what ) use ( $e2e_preg ) {
	// Conditions read the operation's input, as the plugin reads the file once and then branches.
	$input = $text;
	foreach ( $operation['steps'] as $i => $step ) {
		$where = $what . ' ' . $operation['name'] . ' step ' . ( $i + 1 );
		if ( isset( $step['when'] ) ) {
			$when    = $step['when'];
			$matched = $e2e_preg( preg_match( $when['pattern'], $input, $m ), $where );
			if ( 'matches' === $when['kind'] ) {
				$holds = 1 === $matched;
			} elseif ( 'lacks' === $when['kind'] ) {
				$holds = 0 === $matched;
			} else {
				$holds = 1 === $matched && ! empty( $m[ $when['group'] ] ) && $m[ $when['group'] ] !== $when['value'];
			}
			if ( ! $holds ) {
				continue;
			}
		}
		$replacement = $step['replacement'];
		if ( preg_match_all( '/\{\{([^{}]*)\}\}/', $replacement, $names ) ) {
			$fill = array();
			foreach ( $names[1] as $name ) {
				if ( ! isset( $captures[ $name ] ) ) {
					return null;
				}
				$fill[ '{{' . $name . '}}' ] = $captures[ $name ];
			}
			$replacement = strtr( $replacement, $fill );
		}
		$text = $e2e_preg(
			preg_replace_callback(
				$step['pattern'],
				function () use ( $replacement ) {
					return $replacement;
				},
				$text,
				$step['limit']
			),
			$where
		);
	}
	return $text;
};
// Every text the declared operations make from $start, chained up to $e2e_max deep: a set (keys).
$e2e_candidates = function ( $start, $file, $current ) use ( $e2e_apply, $e2e_preg, $e2e_max ) {
	$captures = array();
	foreach ( isset( $file['captures'] ) ? $file['captures'] : array() as $capture ) {
		if ( 1 === $e2e_preg( preg_match( $capture['pattern'], $current, $m ), $file['path'] . ' capture ' . $capture['name'] ) && isset( $m[ $capture['group'] ] ) ) {
			$captures[ $capture['name'] ] = $m[ $capture['group'] ];
		}
	}
	$seen     = array( $start => true );
	$frontier = array( $start );
	for ( $depth = 0; $depth < $e2e_max && array() !== $frontier; $depth++ ) {
		$next = array();
		foreach ( $frontier as $text ) {
			foreach ( $file['operations'] as $operation ) {
				$out = $e2e_apply( (string) $text, $operation, $captures, $file['path'] );
				if ( null !== $out && ! isset( $seen[ $out ] ) ) {
					$seen[ $out ] = true;
					$next[]       = $out;
				}
			}
		}
		$frontier = $next;
	}
	return $seen;
};
$e2e_record = function () use ( $e2e_spec, $e2e_root, $e2e_dir, $e2e_stat, $e2e_read, $e2e_write_new, $e2e_fail ) {
	if ( ! @mkdir( $e2e_dir, 0700 ) ) {
		$e2e_fail( 'creating the record folder ' . $e2e_dir . ' failed' );
	}
	$meta = array( 'version' => 1, 'root' => $e2e_root, 'files' => array(), 'created_files' => array(), 'dirs' => array() );
	foreach ( $e2e_spec['files'] as $i => $file ) {
		$path  = $e2e_root . $file['path'];
		$s     = $e2e_stat( $path );
		$entry = array( 'path' => $file['path'], 'type' => $s['type'] );
		if ( 'file' === $s['type'] ) {
			$bytes = $e2e_read( $path );
			$e2e_write_new( $e2e_dir . '/file-' . $i, $bytes );
			$entry += array(
				'copy'   => 'file-' . $i,
				'sha256' => hash( 'sha256', $bytes ),
				'mode'   => $s['mode'],
				'uid'    => $s['uid'],
				'gid'    => $s['gid'],
				'ino'    => $s['ino'],
			);
		}
		$meta['files'][] = $entry;
	}
	foreach ( $e2e_spec['createdFiles'] as $file ) {
		$s     = $e2e_stat( $e2e_root . $file['path'] );
		$entry = array( 'path' => $file['path'], 'type' => $s['type'] );
		if ( 'file' === $s['type'] ) {
			$entry['sha256'] = hash( 'sha256', $e2e_read( $e2e_root . $file['path'] ) );
		}
		$meta['created_files'][] = $entry;
	}
	foreach ( $e2e_spec['createdDirs'] as $dir ) {
		$s                = $e2e_stat( $e2e_root . $dir );
		$meta['dirs'][] = array( 'path' => $dir, 'type' => $s['type'] );
	}
	// Committed last: a record without meta.json is one a killed run never finished.
	$e2e_write_new( $e2e_dir . '/meta.json.tmp', json_encode( $meta ) );
	if ( ! @rename( $e2e_dir . '/meta.json.tmp', $e2e_dir . '/meta.json' ) ) {
		$e2e_fail( 'committing the record failed' );
	}
};
// Writes the recorded bytes into the existing file — the one $before (its lstat) saw: same inode,
// owner and mode. False, nothing written, when the path no longer leads to it (a link or another file
// swapped in since; fopen follows links). A write cut short keeps the record for the next run.
$e2e_write_back = function ( $path, $before, $bytes, $sha256 ) use ( $e2e_dir, $e2e_fail ) {
	$h = @fopen( $path, 'r+b' );
	if ( false === $h ) {
		$e2e_fail( 'opening ' . $path . ' to put it back failed' );
	}
	$s = fstat( $h );
	if ( false === $s || 0100000 !== ( $s['mode'] & 0170000 ) || $s['dev'] !== $before['dev'] || $s['ino'] !== $before['ino'] ) {
		fclose( $h );
		return false;
	}
	flock( $h, LOCK_EX );
	$ok = ftruncate( $h, 0 ) && rewind( $h ) && strlen( $bytes ) === fwrite( $h, $bytes ) && fflush( $h );
	flock( $h, LOCK_UN );
	fclose( $h );
	clearstatcache( true, $path );
	if ( ! $ok || hash_file( 'sha256', $path ) !== $sha256 ) {
		$e2e_fail( 'putting ' . $path . ' back failed: it does not hold its recorded bytes, which are kept in ' . $e2e_dir . ' (the site\'s next scenario puts them back)' );
	}
	return true;
};
$e2e_restore_file = function ( $i, $file, $recorded ) use ( $e2e_root, $e2e_dir, $e2e_stat, $e2e_read, $e2e_candidates, $e2e_write_back, $e2e_fail ) {
	$outcome = array( 'kind' => 'file', 'index' => $i );
	if ( null === $recorded ) {
		return $outcome + array( 'result' => 'not-recorded' );
	}
	$path = $e2e_root . $file['path'];
	$s    = $e2e_stat( $path );
	if ( 'link' === $s['type'] || 'link' === $recorded['type'] ) {
		return $outcome + array( 'result' => 'link' );
	}
	if ( ! in_array( $s['type'], array( 'file', 'absent' ), true ) || ! in_array( $recorded['type'], array( 'file', 'absent' ), true ) ) {
		return $outcome + array( 'result' => 'not-a-file' );
	}
	$was = 'file' === $recorded['type'];
	if ( 'absent' === $s['type'] ) {
		return $outcome + array( 'result' => $was ? 'missing' : 'unchanged' );
	}
	$bytes = '';
	if ( $was ) {
		$bytes = $e2e_read( $e2e_dir . '/' . $recorded['copy'] );
		if ( hash( 'sha256', $bytes ) !== $recorded['sha256'] ) {
			$e2e_fail( 'the record of ' . $file['path'] . ' is damaged' );
		}
	}
	$current = $e2e_read( $path );
	$same      = $was && $current === $bytes;
	$explained = $same || array_key_exists( $current, $e2e_candidates( $bytes, $file, $current ) );
	// Unexplained, but a strict prefix of the recorded bytes (empty included): a write cut short —
	// this engine's put-back truncates, then writes —, finished. Writing it back loses no byte the
	// record lacks.
	$cut = ! $explained && $was && strlen( $current ) < strlen( $bytes ) && 0 === strncmp( $current, $bytes, strlen( $current ) );
	if ( $same ) {
		$result = 'unchanged';
	} elseif ( ! $explained && ! $cut ) {
		// Never touched, its mode included.
		return $outcome + array( 'result' => $was ? 'unrecognized' : 'appeared' );
	} elseif ( ! is_writable( $was ? $path : dirname( $path ) ) ) {
		return $outcome + array( 'result' => 'unwritable' );
	} elseif ( $was ) {
		if ( ! $e2e_write_back( $path, $s, $bytes, $recorded['sha256'] ) ) {
			return $outcome + array( 'result' => 'replaced' );
		}
		$result = $cut ? 'resumed' : 'restored';
	} else {
		if ( ! @unlink( $path ) ) {
			$e2e_fail( 'removing ' . $path . ' failed' );
		}
		return $outcome + array( 'result' => 'removed' );
	}
	$outcome['result'] = $result;
	if ( $was ) {
		// Only a file found as recorded, or put back as recorded, has its mode set back — and only while
		// the path is still that file (chmod follows a link).
		$now = $e2e_stat( $path );
		if ( 'file' !== $now['type'] || $now['dev'] !== $s['dev'] || $now['ino'] !== $s['ino'] ) {
			return $outcome;
		}
		if ( $now['mode'] !== $recorded['mode'] ) {
			$outcome['mode'] = array(
				'found'    => $now['mode'],
				'recorded' => $recorded['mode'],
				'restored' => @chmod( $path, $recorded['mode'] ),
			);
		}
		if ( $now['uid'] !== $recorded['uid'] || $now['gid'] !== $recorded['gid'] ) {
			$outcome['owner'] = array(
				'found'    => $now['uid'] . ':' . $now['gid'],
				'recorded' => $recorded['uid'] . ':' . $recorded['gid'],
			);
		}
	}
	return $outcome;
};
$e2e_restore_created = function ( $i, $file, $recorded ) use ( $e2e_root, $e2e_stat, $e2e_read, $e2e_fail ) {
	$outcome = array( 'kind' => 'created-file', 'index' => $i );
	$path    = $e2e_root . $file['path'];
	$s       = $e2e_stat( $path );
	$was     = null !== $recorded && 'absent' !== $recorded['type'];
	if ( 'absent' === $s['type'] ) {
		return $outcome + array( 'result' => $was ? 'missing' : 'absent' );
	}
	if ( 'link' === $s['type'] ) {
		return $outcome + array( 'result' => 'link' );
	}
	if ( 'file' !== $s['type'] ) {
		return $outcome + array( 'result' => 'not-a-file' );
	}
	$current = $e2e_read( $path );
	if ( $was ) {
		$same = isset( $recorded['sha256'] ) && hash( 'sha256', $current ) === $recorded['sha256'];
		return $outcome + array( 'result' => $same ? 'kept' : 'changed' );
	}
	$ours = '' === $current;
	foreach ( $file['marks'] as $mark ) {
		$ours = $ours || false !== strpos( $current, $mark );
	}
	if ( ! $ours ) {
		return $outcome + array( 'result' => 'foreign' );
	}
	if ( ! is_writable( dirname( $path ) ) ) {
		return $outcome + array( 'result' => 'unwritable' );
	}
	if ( ! @unlink( $path ) ) {
		$e2e_fail( 'removing ' . $path . ' failed' );
	}
	return $outcome + array( 'result' => 'removed' );
};
$e2e_restore_dir = function ( $i, $dir, $recorded ) use ( $e2e_root, $e2e_stat ) {
	$outcome = array( 'kind' => 'dir', 'index' => $i );
	$path    = $e2e_root . $dir;
	$s       = $e2e_stat( $path );
	if ( 'absent' === $s['type'] ) {
		return $outcome + array( 'result' => 'absent' );
	}
	if ( 'link' === $s['type'] ) {
		return $outcome + array( 'result' => 'link' );
	}
	if ( 'dir' !== $s['type'] ) {
		return $outcome + array( 'result' => 'not-a-dir' );
	}
	if ( null === $recorded || 'absent' !== $recorded['type'] ) {
		return $outcome + array( 'result' => 'kept' );
	}
	if ( count( (array) @scandir( $path ) ) > 2 ) {
		return $outcome + array( 'result' => 'not-empty' );
	}
	return $outcome + array( 'result' => @rmdir( $path ) ? 'removed' : 'unwritable' );
};
// Why a record cannot be trusted, or null: it is then discarded, never restored from.
$e2e_unusable = function ( $meta ) use ( $e2e_root, $e2e_dir ) {
	if ( ! is_array( $meta ) || 1 !== ( isset( $meta['version'] ) ? $meta['version'] : null ) || ! isset( $meta['root'], $meta['files'], $meta['created_files'], $meta['dirs'] ) ) {
		return 'unreadable';
	}
	if ( $e2e_root !== $meta['root'] ) {
		return 'other-root';
	}
	foreach ( $meta['files'] as $entry ) {
		if ( 'file' === $entry['type'] && hash_file( 'sha256', $e2e_dir . '/' . $entry['copy'] ) !== $entry['sha256'] ) {
			return 'damaged';
		}
	}
	return null;
};
// Restores from the record and removes it: array( 'outcomes' => … ), or array( 'unusable' => why ).
$e2e_restore = function () use ( $e2e_spec, $e2e_dir, $e2e_read, $e2e_drop_or_fail, $e2e_unusable, $e2e_restore_file, $e2e_restore_created, $e2e_restore_dir ) {
	$meta   = json_decode( $e2e_read( $e2e_dir . '/meta.json' ), true );
	$reason = $e2e_unusable( $meta );
	if ( null !== $reason ) {
		$e2e_drop_or_fail( $e2e_dir );
		return array( 'unusable' => $reason );
	}
	$by_path = function ( $list ) {
		$out = array();
		foreach ( $list as $entry ) {
			$out[ $entry['path'] ] = $entry;
		}
		return $out;
	};
	$files    = $by_path( $meta['files'] );
	$created  = $by_path( $meta['created_files'] );
	$dirs     = $by_path( $meta['dirs'] );
	$outcomes = array();
	foreach ( $e2e_spec['files'] as $i => $file ) {
		$outcomes[] = $e2e_restore_file( $i, $file, isset( $files[ $file['path'] ] ) ? $files[ $file['path'] ] : null );
	}
	foreach ( $e2e_spec['createdFiles'] as $i => $file ) {
		$outcomes[] = $e2e_restore_created( $i, $file, isset( $created[ $file['path'] ] ) ? $created[ $file['path'] ] : null );
	}
	foreach ( $e2e_spec['createdDirs'] as $i => $dir ) {
		$outcomes[] = $e2e_restore_dir( $i, $dir, isset( $dirs[ $dir ] ) ? $dirs[ $dir ] : null );
	}
	// Last: every path has its verdict.
	$e2e_drop_or_fail( $e2e_dir );
	return array( 'outcomes' => $outcomes );
};
$e2e_dir_state = $e2e_check_dir();
if ( 'blocked' === $e2e_dir_state ) {
	// Never used: no reconcile, no record. This scenario's edits then stay, as after a reboot.
	echo json_encode( array( 'blocked' => $e2e_dir ) ), "\n";
	return;
}
$e2e_has_record = 'ours' === $e2e_dir_state && is_file( $e2e_dir . '/meta.json' );
if ( 'restore' === $e2e_mode ) {
	echo json_encode( $e2e_has_record ? $e2e_restore() : array( 'none' => true ) ), "\n";
	return;
}
$e2e_restored   = $e2e_has_record ? $e2e_restore() : array();
$e2e_reconciled = isset( $e2e_restored['outcomes'] ) ? $e2e_restored['outcomes'] : null;
$e2e_discarded  = false;
if ( null !== $e2e_reconciled ) {
	// The answer is lost if recording fails: its error says what was already done.
	$e2e_context = ' (after a killed run\'s record was put back first: ' . count( $e2e_reconciled ) . ' path(s) judged)';
}
if ( ! $e2e_has_record && 'ours' === $e2e_dir_state ) {
	$e2e_drop_or_fail( $e2e_dir );
	$e2e_discarded = true;
}
$e2e_record();
// Best-effort: a stale record that will not go is counted, never a failure of this record step.
$e2e_swept   = 0;
$e2e_unswept = 0;
foreach ( (array) glob( dirname( $e2e_dir ) . '/' . $e2e_prefix . '*' ) as $e2e_other ) {
	$s = $e2e_stat( (string) $e2e_other );
	if ( $e2e_other !== $e2e_dir && 'dir' === $s['type'] && $s['uid'] === $e2e_uid && 0 === ( $s['mode'] & 0077 ) && $s['mtime'] < time() - $e2e_stale ) {
		if ( $e2e_drop_record( (string) $e2e_other ) ) {
			++$e2e_swept;
		} else {
			++$e2e_unswept;
		}
	}
}
echo json_encode(
	array(
		'reconciled' => $e2e_reconciled,
		'unusable'   => isset( $e2e_restored['unusable'] ) ? $e2e_restored['unusable'] : null,
		'discarded'  => $e2e_discarded,
		'swept'      => $e2e_swept,
		'unswept'    => $e2e_unswept,
	)
), "\n";
`;

/**
 * The engine with its inputs, every one embedded with `phpLiteral`.
 *
 * @param mode - record (reconciling first) or restore.
 * @param stem - the record folder without its identity ({@link recordStemFor}).
 * @param edits - the product's validated declaration.
 */
export function configEditsPhp(
  mode: "record" | "restore",
  stem: string,
  edits: ConfigEdits,
): string {
  const spec = {
    files: edits.files,
    createdFiles: edits.createdFiles ?? [],
    createdDirs: edits.createdDirs ?? [],
  };
  return [
    `$e2e_mode = ${phpLiteral(mode)};`,
    `$e2e_stem = ${phpLiteral(stem)};`,
    `$e2e_prefix = ${phpLiteral(RECORD_PREFIX)};`,
    `$e2e_spec = ${phpLiteral(spec)};`,
    `$e2e_max = ${phpLiteral(MAX_OPERATIONS)};`,
    `$e2e_stale = ${phpLiteral(STALE_RECORD_DAYS * 86_400)};`,
    CONFIG_EDITS_PHP,
  ].join("\n");
}

/**
 * Before a scenario: reconciles a record a killed run left (restores from it), then records the
 * tracked paths anew — see the module doc.
 *
 * @param transport - the site.
 * @param slug - the plugin under test.
 * @param edits - the product's validated declaration.
 * @returns what was reconciled, discarded and swept, or that the record folder is blocked.
 * @throws Error when the command fails or answers unreadably.
 */
export async function recordConfigEdits(
  transport: Transport,
  slug: string,
  edits: ConfigEdits,
): Promise<RecordAnswer> {
  return parseRecordAnswer(
    await evalPhp(
      transport,
      configEditsPhp("record", recordStemFor(transport, slug), edits),
      "recording the files the plugin edits",
      "wp/config-edits",
      { skipWordPress: true },
    ),
    edits,
  );
}

/**
 * After a scenario: puts back what only the plugin's own edits changed, then removes the record — see
 * the module doc.
 *
 * @param transport - the site.
 * @param slug - the plugin under test.
 * @param edits - the product's validated declaration.
 * @returns every tracked path's outcome, or that there was no record, an unusable one, or a blocked
 * record folder.
 * @throws Error when the command fails (the record is then kept) or answers unreadably.
 */
export async function restoreConfigEdits(
  transport: Transport,
  slug: string,
  edits: ConfigEdits,
): Promise<RestoreAnswer> {
  return parseRestoreAnswer(
    await evalPhp(
      transport,
      configEditsPhp("restore", recordStemFor(transport, slug), edits),
      "putting back the files the plugin edits",
      "wp/config-edits",
      { skipWordPress: true },
    ),
    edits,
  );
}
