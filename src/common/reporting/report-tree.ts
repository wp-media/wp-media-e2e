import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readdirSync,
  type Stats,
} from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Reading a report tree without ever following a symlink — the low-level half of the report pruning
 * (`retention.ts`). A report folder can hold anything a run wrote, links included; a walk that
 * followed one could measure or read a file far outside the tree.
 */

/**
 * An error's `code` (`ENOENT`, `EACCES`, …), if it has one.
 *
 * @param error - what was thrown.
 */
export function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * A path's own status — of a link itself, never its target — or `undefined` when it cannot be
 * read (absent, or unreadable).
 *
 * @param path - the path.
 */
export function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Whether a path is a real folder: a directory, not a link to one.
 *
 * @param path - the path.
 */
export function isRealDirectory(path: string): boolean {
  return lstatOrUndefined(path)?.isDirectory() === true;
}

/**
 * Whether a folder's entries can be listed.
 *
 * @param path - the folder.
 */
export function isListable(path: string): boolean {
  try {
    readdirSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The bytes of every regular file in a folder, walked without following a link (one is counted as
 * nothing, never entered). An entry that cannot be read is passed over: the walk measures what it can.
 *
 * @param root - the folder.
 * @returns the sum; 0 when it holds nothing readable.
 */
export function treeBytes(root: string): number {
  let bytes = 0;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const path = join(dir, name);
      const stats = lstatOrUndefined(path);
      if (stats?.isDirectory() === true) pending.push(path);
      else if (stats?.isFile() === true) bytes += stats.size;
    }
  }
  return bytes;
}

/**
 * Visits the status of a folder and of everything in it, without following a link, one folder at a
 * time, asynchronously — so a long walk never blocks the event loop, and a stop ends it. An entry that
 * cannot be read is passed over.
 *
 * @param root - the folder.
 * @param visit - gets each entry's own status, the folder's first.
 * @param signal - ends the walk early, before its next folder; what was visited stays visited.
 */
async function walkTree(
  root: string,
  visit: (stats: Stats) => void,
  signal: AbortSignal | undefined,
): Promise<void> {
  const top = await lstat(root).catch(() => undefined);
  if (top === undefined) return;
  visit(top);
  if (!top.isDirectory()) return;
  const pending = [root];
  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (signal?.aborted === true) return;
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const name of names) {
      const path = join(dir, name);
      const stats = await lstat(path).catch(() => undefined);
      if (stats === undefined) continue;
      visit(stats);
      if (stats.isDirectory()) pending.push(path);
    }
  }
}

/**
 * {@link treeBytes}, walked asynchronously and stopped by `signal`: a bundle's size is measured
 * within its budget, never past a stop.
 *
 * @param root - the folder.
 * @param signal - ends the walk early; the sum is then partial, so the caller checks it.
 * @returns the sum; 0 when it holds nothing readable.
 */
export async function treeBytesWithin(
  root: string,
  signal?: AbortSignal,
): Promise<number> {
  let bytes = 0;
  await walkTree(
    root,
    (stats) => {
      if (stats.isFile()) bytes += stats.size;
    },
    signal,
  );
  return bytes;
}

/**
 * Whether nothing in a folder — the folder, any entry at any depth, a link itself — was modified
 * (`mtime`) for longer than `idleMs`: how a folder another host may still be writing is told from one
 * left behind, when its owner's pid says nothing (a pid is per host). Writing a file, or adding,
 * removing or renaming an entry, modifies it or its folder.
 *
 * @param root - the folder.
 * @param idleMs - how long it must have been untouched.
 * @param signal - ends the walk early: then it is not known untouched (`false`).
 * @param now - the clock, in epoch milliseconds; `Date.now` by default.
 * @returns `true` when untouched that long; `false` when touched since, absent, or stopped.
 */
export async function untouchedFor(
  root: string,
  idleMs: number,
  signal?: AbortSignal,
  now: () => number = Date.now,
): Promise<boolean> {
  let newest = Number.NEGATIVE_INFINITY;
  await walkTree(
    root,
    (stats) => {
      newest = Math.max(newest, stats.mtimeMs);
    },
    signal,
  );
  if (signal?.aborted === true || newest === Number.NEGATIVE_INFINITY)
    return false;
  return now() - newest > idleMs;
}

/**
 * The first `limit` bytes of a regular file, as UTF-8. Opened without following a final link and
 * without blocking, then checked to be a regular file — a FIFO named like a report part would
 * otherwise hang the runner that reads it.
 *
 * @param path - the file.
 * @param limit - how many bytes to read at most.
 * @returns the text, or `undefined` when the path is absent, a link, not a regular file, or unreadable.
 */
export function readHead(path: string, limit: number): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = Buffer.alloc(limit);
    const read = readSync(fd, buffer, 0, limit, 0);
    return buffer.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Nothing was written through it; a failed close loses nothing.
    }
  }
}
