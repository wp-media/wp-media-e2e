import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { configEditsPhp, RECORD_PREFIX } from "../wp/config-edits";
import type { ConfigEdits } from "../config/types";

/**
 * Runs the in-place cleanup engine for real on this machine's PHP, outside WordPress, through
 * `config-edits-harness.php`: a temporary WordPress root (only `wp-settings.php`, plus what a test
 * writes) and a record folder beside it, never under `/tmp/e2e-record-*`.
 */

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "config-edits-harness.php",
);

/** Whether a `php` binary can run here; specs using this skip without one. */
export const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** One engine sandbox: a root, a record folder path, and the folder holding both. */
export interface EngineSandbox {
  /** The temporary folder; remove it after the test. */
  readonly base: string;
  /** The WordPress root (holds `wp-settings.php` and `wp-content/`). */
  readonly root: string;
  /** The record folder's name without its identity, as the engine is given it. */
  readonly recordStem: string;
  /** Where the engine keeps its record (not created): the stem and this process's effective uid. */
  readonly recordDir: string;
}

/** Makes a sandbox; the record folder's parent stands in for `/tmp`. */
export function engineSandbox(): EngineSandbox {
  const base = mkdtempSync(join(tmpdir(), "e2e-config-edits-"));
  const root = join(base, "root");
  mkdirSync(join(root, "wp-content"), { recursive: true });
  writeFileSync(join(root, "wp-settings.php"), "<?php\n");
  mkdirSync(join(base, "tmp"));
  const recordStem = join(base, "tmp", `${RECORD_PREFIX}0123456789abcdef`);
  // The engine's PHP runs as this process's user, so its effective uid is ours.
  return {
    base,
    root,
    recordStem,
    recordDir: `${recordStem}-${String(process.geteuid?.() ?? 0)}`,
  };
}

/** What a run of the engine printed, and its exit status. */
export interface EngineRun {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * A race made exact: once a statement on a snippet line containing `after` has run (its `nth` time,
 * default the first), `swap`'s
 * path is replaced by a symbolic link to its target — or, without `swap`, the run is killed there
 * (exit 137). See the harness.
 */
export interface EngineInterrupt {
  readonly after: string;
  readonly nth?: number;
  readonly swap?: { readonly path: string; readonly target: string };
}

/**
 * Runs the engine in `mode` with `edits` on a sandbox.
 *
 * @param sandbox - the root and record folder.
 * @param mode - record (reconciling first) or restore.
 * @param edits - the declaration, as the registry would hold it.
 * @param interrupt - a kill, or a path swapped for a link, mid-run.
 */
export function runEngine(
  sandbox: EngineSandbox,
  mode: "record" | "restore",
  edits: ConfigEdits,
  interrupt?: EngineInterrupt,
): EngineRun {
  const snippet = join(sandbox.base, `${mode}.php`);
  writeFileSync(snippet, configEditsPhp(mode, sandbox.recordStem, edits));
  const result = spawnSync("php", [HARNESS, snippet, sandbox.root], {
    encoding: "utf8",
    env:
      interrupt === undefined
        ? process.env
        : {
            ...process.env,
            E2E_INTERRUPT_AFTER: interrupt.after,
            E2E_INTERRUPT_NTH: String(interrupt.nth ?? 1),
            ...(interrupt.swap === undefined
              ? {}
              : {
                  E2E_SWAP_PATH: interrupt.swap.path,
                  E2E_SWAP_TARGET: interrupt.swap.target,
                }),
          },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
