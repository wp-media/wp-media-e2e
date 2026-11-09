import { test, expect } from "@playwright/test";
import {
  lutimesSync,
  mkdirSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import { treeBytesWithin, untouchedFor } from "./report-tree";

/**
 * The asynchronous, stoppable walks of a report tree: a bundle's size, and whether a work folder has
 * been left alone long enough to be another host's no longer.
 */

let root = "";

test.beforeEach(() => {
  root = tempRoot("e2e report tree 'q ");
});

test.afterEach(() => {
  removeTempRoot(root);
});

/** A tree: `a` (3 bytes), `sub/deep/b` (5 bytes), a link to a 7-byte file outside it. */
function writeTree(): string {
  const tree = join(root, "tree");
  mkdirSync(join(tree, "sub", "deep"), { recursive: true });
  writeFileSync(join(tree, "a"), "aaa");
  writeFileSync(join(tree, "sub", "deep", "b"), "bbbbb");
  writeFileSync(join(root, "outside"), "ooooooo");
  symlinkSync(join(root, "outside"), join(tree, "link"));
  return tree;
}

/** Sets every modification time in a tree (the root's and the link's own included) to `at`. */
function touchAll(tree: string, at: Date): void {
  lutimesSync(join(tree, "link"), at, at);
  for (const path of [
    join(tree, "sub", "deep", "b"),
    join(tree, "sub", "deep"),
    join(tree, "sub"),
    join(tree, "a"),
    tree,
  ])
    utimesSync(path, at, at);
}

test.describe("treeBytesWithin", () => {
  test("sums every regular file at any depth, never what a link points at", async () => {
    expect(await treeBytesWithin(writeTree())).toBe(8);
  });

  test("an absent folder is 0", async () => {
    expect(await treeBytesWithin(join(root, "absent"))).toBe(0);
  });

  test("a stop ends the walk before its next folder: the sum is partial", async () => {
    expect(await treeBytesWithin(writeTree(), AbortSignal.abort())).toBe(0);
  });
});

test.describe("untouchedFor", () => {
  const HOUR = 3_600_000;

  test("untouched when nothing in it was modified for longer than the idle time", async () => {
    const tree = writeTree();
    touchAll(tree, new Date(Date.now() - HOUR));
    expect(await untouchedFor(tree, HOUR / 2)).toBe(true);
    expect(await untouchedFor(tree, 2 * HOUR)).toBe(false);
  });

  test("a file modified deep inside counts, though every folder above it is old", async () => {
    const tree = writeTree();
    touchAll(tree, new Date(Date.now() - HOUR));
    const recent = new Date(Date.now() - 1_000);
    utimesSync(join(tree, "sub", "deep", "b"), recent, recent);
    utimesSync(
      join(tree, "sub", "deep"),
      new Date(Date.now() - HOUR),
      new Date(Date.now() - HOUR),
    );
    expect(await untouchedFor(tree, HOUR / 2)).toBe(false);
  });

  test("reads its clock from `now`", async () => {
    const tree = writeTree();
    expect(await untouchedFor(tree, HOUR)).toBe(false);
    expect(
      await untouchedFor(tree, HOUR, undefined, () => Date.now() + 2 * HOUR),
    ).toBe(true);
  });

  test("a stopped walk, or an absent folder, is never untouched", async () => {
    const tree = writeTree();
    touchAll(tree, new Date(Date.now() - HOUR));
    expect(await untouchedFor(tree, 0, AbortSignal.abort())).toBe(false);
    expect(await untouchedFor(join(root, "absent"), 0)).toBe(false);
  });
});
