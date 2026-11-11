import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EXCL_DD_SHIM, hostDdHasExcl } from "./excl-dd";
import { tapFifo } from "./fifo";
import { removeTempDir } from "./temp-dir";

/**
 * The `conv=excl` stand-in holds the identity probe's write to GNU `dd`'s contract: a new file
 * `0666 & ~umask`, and any existing path — a symlink to a FIFO, a dangling one, a file, a directory —
 * refused with `File exists`, never followed. Where the system's `dd` has `conv=excl`, it is held to
 * the same contract.
 */

let dir = "";

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "excl-dd-spec-"));
  writeFileSync(join(dir, "dd"), EXCL_DD_SHIM, { mode: 0o755 });
});

test.afterEach(() => {
  removeTempDir(dir);
});

/** The `dd`s to hold to the contract: the stand-in, and the system's when it takes `conv=excl`. */
const DDS = (): readonly string[] => [
  "stand-in",
  ...(hostDdHasExcl() ? ["system"] : []),
];

/**
 * Writes `payload` to `path` as the probe does, with `which` `dd`.
 *
 * @param which - `stand-in` or `system`.
 * @param path - the target.
 * @param payload - what to write.
 */
function write(which: string, path: string, payload = "PAYLOAD") {
  const dd = which === "stand-in" ? join(dir, "dd") : "dd";
  return spawnSync(
    "/bin/sh",
    [
      "-c",
      `umask 022 && printf '%s' "$1" | '${dd}' of="$2" conv=excl status=none`,
      "sh",
      payload,
      path,
    ],
    { encoding: "utf8" },
  );
}

test("writes a new file 0644 under umask 022, byte for byte", () => {
  for (const which of DDS()) {
    const path = join(dir, `new-${which}`);
    const result = write(which, path, "<?php\n'\"$x\n");
    expect(result.status).toBe(0);
    expect(readFileSync(path, "utf8")).toBe("<?php\n'\"$x\n");
    expect(statSync(path).mode & 0o777).toBe(0o644);
  }
});

test("refuses every existing path, following none", () => {
  const fifo = tapFifo(join(dir, "fifo"));
  try {
    symlinkSync(join(dir, "fifo"), join(dir, "to-fifo"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    writeFileSync(join(dir, "file"), "old");
    mkdirSync(join(dir, "folder"));
    for (const which of DDS()) {
      for (const name of ["to-fifo", "dangling", "file", "folder"]) {
        const result = write(which, join(dir, name));
        expect(result.status).toBe(1);
        expect(result.stderr).toMatch(/File exists/);
      }
    }
    expect(fifo.drain()).toBe("");
    expect(readFileSync(join(dir, "file"), "utf8")).toBe("old");
    expect(lstatSync(join(dir, "dangling")).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(join(dir, "nowhere"))).toThrow();
  } finally {
    fifo.close();
  }
});

test("the stand-in refuses operands the probe never gives", () => {
  const result = spawnSync(join(dir, "dd"), ["of=/x", "bs=1"], {
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  const missing = spawnSync(join(dir, "dd"), [`of=${join(dir, "y")}`], {
    encoding: "utf8",
  });
  expect(missing.status).toBe(1);
  expect(() => lstatSync(join(dir, "y"))).toThrow();
});

test("on Linux the system's dd has conv=excl, so the stand-in never replaces GNU dd", () => {
  // The sites and CI run GNU coreutils: a `false` here would put the stand-in ahead of the real `dd`
  // silently, and the probe's specs would no longer prove what a site runs.
  test.skip(process.platform !== "linux", "only Linux runners use GNU dd");
  expect(hostDdHasExcl()).toBe(true);
});
