import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FENCE_EXIT,
  FENCE_MARK,
  fenceArgs,
  fenceTripped,
  parseDirIdentity,
} from "./content-copy-fence";

/**
 * The fence on a files restore: its PHP run for real (as WP-CLI's `--exec` runs it, before WordPress
 * loads), where `php` is installed, against real directories — the copy's, a claimed one, a link.
 */

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("parseDirIdentity", () => {
  test("reads `dev:ino`", () => {
    expect(parseDirIdentity("64768:1234\n")).toBe("64768:1234");
  });

  test("knows nothing from anything else", () => {
    for (const text of [
      undefined,
      "",
      "1234",
      "a:1",
      "1:2:3",
      "1: 2",
      "-1:2",
    ]) {
      expect(parseDirIdentity(text), String(text)).toBeUndefined();
    }
  });
});

test.describe("fenceTripped", () => {
  test("only the fence's own exit and words count", () => {
    expect(
      fenceTripped({ exitCode: FENCE_EXIT, stderr: `Error: ${FENCE_MARK}: …` }),
    ).toBe(true);
    expect(fenceTripped({ exitCode: FENCE_EXIT, stderr: "Error: other" })).toBe(
      false,
    );
    expect(fenceTripped({ exitCode: 1, stderr: FENCE_MARK })).toBe(false);
  });
});

test.describe("fenceArgs", () => {
  test.skip(!HAS_PHP, "php is not installed here");
  let base: string;

  /** The directory's identity as `stat -c %d:%i` prints it. */
  const identity = (path: string): string => {
    const stat = statSync(path, { bigint: true });
    return `${String(stat.dev)}:${String(stat.ino)}`;
  };

  /** Runs the fence's PHP; its exit code and stderr. */
  const run = (dir: string, id: string): { code: number; stderr: string } => {
    const [arg = ""] = fenceArgs(dir, id);
    const result = spawnSync("php", ["-r", arg.slice("--exec=".length)], {
      encoding: "utf8",
    });
    return { code: result.status ?? -1, stderr: result.stderr };
  };

  test.beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bwp-fence-"));
  });
  test.afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("is one WP-CLI global argument", () => {
    const args = fenceArgs("/s/.e2e_content_copy", "1:2");
    expect(args).toHaveLength(1);
    expect(args[0]).toMatch(/^--exec=\(static function \(\) \{/);
  });

  test("lets the restore run while the copy's directory is the one its run made", () => {
    const dir = join(base, ".e2e_content_copy");
    mkdirSync(dir);
    expect(run(dir, identity(dir))).toEqual({ code: 0, stderr: "" });
  });

  // A recovery claims by renaming: the path then holds nothing, or a later run's directory.
  test("refuses it once the copy was claimed, or replaced by another directory or a link", () => {
    const dir = join(base, ".e2e_content_copy");
    mkdirSync(dir);
    const id = identity(dir);
    renameSync(dir, join(base, ".e2e_content_copy.recovering-ab"));
    const gone = run(dir, id);
    expect(gone.code).toBe(FENCE_EXIT);
    expect(gone.stderr).toContain(
      `Error: ${FENCE_MARK}: the copy of wp-content this restore depends on is no longer this run's`,
    );
    mkdirSync(dir);
    expect(run(dir, id).code).toBe(FENCE_EXIT);
    rmSync(dir, { recursive: true });
    // A link to the very directory still fails: lstat, never followed.
    symlinkSync(join(base, ".e2e_content_copy.recovering-ab"), dir);
    expect(run(dir, id).code).toBe(FENCE_EXIT);
  });

  // Values enter through phpLiteral only: a path with quotes and `$` cannot end or alter the code.
  test("carries any path as data", () => {
    const dir = join(base, `it's "$x" {}`);
    mkdirSync(dir);
    expect(run(dir, identity(dir)).code).toBe(0);
    expect(run(dir, "1:1").code).toBe(FENCE_EXIT);
  });
});
