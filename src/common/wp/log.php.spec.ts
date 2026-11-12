import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLEAR_DEBUG_LOG, parseClearVerdict } from "./log";
import type { ClearVerdict } from "./log";

/**
 * The clearing snippet, run for real against real files: WordPress is stood in for by `ABSPATH` and
 * `WP_CONTENT_DIR`. Skipped where PHP is not installed (CI has none); the snippet also runs live on
 * every cell. Ownership cannot change here (no root), so "the owner is kept" is proved by the inode
 * and mode surviving.
 */

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** Root ignores permissions, so a file or folder it may not write cannot be made. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

/** The stand-ins for the constants the snippet uses. */
const HARNESS = `<?php
define( 'ABSPATH', $argv[1] . '/' );
define( 'WP_CONTENT_DIR', $argv[2] );
eval( file_get_contents( $argv[3] ) );
`;

let work: string;
let root: string;
let content: string;
let log: string;

test.beforeEach(() => {
  test.skip(!HAS_PHP, "no php binary here");
  work = mkdtempSync(join(tmpdir(), "wp-log-php-"));
  root = join(work, "root");
  content = join(root, "wp-content");
  log = join(content, "debug.log");
  mkdirSync(content, { recursive: true });
  writeFileSync(join(work, "harness.php"), HARNESS);
  writeFileSync(join(work, "snippet.php"), CLEAR_DEBUG_LOG);
});

test.afterEach(() => {
  if (!HAS_PHP) return;
  chmodSync(content, 0o755);
  rmSync(work, { recursive: true, force: true });
});

/**
 * Runs the snippet against `root`, with `contentDir` as `WP_CONTENT_DIR`.
 *
 * @param contentDir - where the log lives.
 * @returns its verdict.
 */
function clear(contentDir = content): ClearVerdict | undefined {
  const run = spawnSync(
    "php",
    [join(work, "harness.php"), root, contentDir, join(work, "snippet.php")],
    { encoding: "utf8" },
  );
  expect(run.status, run.stderr).toBe(0);
  return parseClearVerdict(run.stdout);
}

test("a log the identity may write is emptied in place: same file, same mode", () => {
  writeFileSync(log, "PHP Fatal error: old\n");
  chmodSync(log, 0o664);
  const before = statSync(log);

  expect(clear()).toEqual({
    state: "emptied",
    ours: true,
    path: "wp-content/debug.log",
  });
  const after = statSync(log);
  expect(after.ino).toBe(before.ino);
  expect(after.mode & 0o777).toBe(0o664);
  expect(readFileSync(log, "utf8")).toBe("");
});

// Another user's 0644 log stands in as one the identity may not write: unlinked, made again empty.
test("a log the identity may not write is replaced by an empty one it made", () => {
  test.skip(isRoot, "root writes any file");
  writeFileSync(log, "PHP Fatal error: old\n");
  chmodSync(log, 0o444);
  const before = statSync(log);

  expect(clear()).toEqual({
    state: "created",
    ours: true,
    path: "wp-content/debug.log",
  });
  expect(statSync(log).ino).not.toBe(before.ino);
  expect(readFileSync(log, "utf8")).toBe("");
});

test("a link at the log's path is replaced, never written through", () => {
  const target = join(work, "elsewhere.txt");
  writeFileSync(target, "not the log\n");
  symlinkSync(target, log);

  expect(clear()?.state).toBe("created");
  expect(lstatSync(log).isSymbolicLink()).toBe(false);
  expect(readFileSync(target, "utf8")).toBe("not the log\n");
});

test("no log yet: one is made, empty", () => {
  expect(clear()).toEqual({
    state: "created",
    ours: true,
    path: "wp-content/debug.log",
  });
  expect(readFileSync(log, "utf8")).toBe("");
});

test("a folder the identity may not write: no log is made, and none is reported", () => {
  test.skip(isRoot, "root writes any folder");
  chmodSync(content, 0o555);

  expect(clear()).toEqual({ state: "removed", ours: null, path: null });
  expect(existsSync(log)).toBe(false);
});

test("a log it may neither write nor unlink is kept, for the fallbacks", () => {
  test.skip(isRoot, "root writes any file");
  writeFileSync(log, "PHP Fatal error: old\n");
  chmodSync(log, 0o444);
  chmodSync(content, 0o555);

  expect(clear()?.state).toBe("kept");
  expect(readFileSync(log, "utf8")).toBe("PHP Fatal error: old\n");
});

test("a log outside the WordPress root is named by its absolute path", () => {
  const outside = join(work, "content-elsewhere");
  mkdirSync(outside);

  const verdict = clear(outside);

  expect(verdict?.state).toBe("created");
  // `realpath`: macOS's temporary folder is reached through a link.
  expect(verdict?.path).toMatch(/\/content-elsewhere\/debug\.log$/);
  expect(verdict?.path?.startsWith("/")).toBe(true);
});

// A sibling whose name merely starts with the root's is not inside it: no "2/debug.log" path.
test("a log in a sibling folder sharing the root's name prefix is named by its absolute path", () => {
  const sibling = `${root}2`;
  mkdirSync(sibling);

  const verdict = clear(sibling);

  expect(verdict?.state).toBe("created");
  expect(verdict?.path).toMatch(/\/root2\/debug\.log$/);
  expect(verdict?.path?.startsWith("/")).toBe(true);
});
