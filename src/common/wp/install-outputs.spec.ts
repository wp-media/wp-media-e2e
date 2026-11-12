import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  OUTPUTS_CHECK_SCRIPT,
  coveringPath,
  newOutputs,
  outermostCovering,
  parseOutputsCheck,
} from "./install-outputs";
import { normaliseInstallOutputs } from "./paths";

/** The pure halves of install outputs, and the check script run by this machine's `sh`. */

test.describe("normaliseInstallOutputs", () => {
  test("normalises each path and drops duplicates, keeping declared order", () => {
    expect(
      normaliseInstallOutputs([
        " wp-content/cache/ ",
        "wp-content/./advanced-cache.php",
        "wp-content/cache",
      ]),
    ).toEqual(["wp-content/cache", "wp-content/advanced-cache.php"]);
  });

  test("accepts no declaration at all", () => {
    expect(normaliseInstallOutputs([])).toEqual([]);
  });

  for (const [path, rule] of [
    ["", /it is empty/],
    ["/var/www/html/wp-content/cache", /it is absolute/],
    ["../wp-content/cache", /escapes the WordPress root/],
    ["wp-content/cache/../..", /the WordPress root itself/],
    ["wp-content", /a directory WordPress itself owns/],
    ["wp-content/plugins", /a directory WordPress itself owns/],
    ["wp-includes/cache.php", /inside "wp-includes"/],
    ["wp-content\\cache", /backslash/],
  ] as const) {
    test(`refuses ${JSON.stringify(path)}, naming it and the rule`, () => {
      expect(() => normaliseInstallOutputs(["wp-content/ok", path])).toThrow(
        rule,
      );
      expect(() => normaliseInstallOutputs([path])).toThrow(
        `[wp/install-outputs] "${path}" cannot be declared as an install output`,
      );
    });
  }
});

test.describe("parseOutputsCheck", () => {
  const outputs = ["a", "b", "c", "d"];

  test("reads an entry with its owner, an unreadable one, and a link", () => {
    const found = parseOutputsCheck("1 www-data:web:33:82\n2 \n4 L\n", outputs);
    expect([...found]).toEqual([
      [
        "a",
        {
          kind: "entry",
          owner: { user: "www-data", group: "web", uid: 33, gid: 82 },
        },
      ],
      ["b", { kind: "entry", owner: undefined }],
      ["d", { kind: "symlink" }],
    ]);
  });

  test("ignores indexes it was not given and lines it does not know", () => {
    const found = parseOutputsCheck("0 L\n5 L\nnoise\n 1 L\n3 L", outputs);
    expect([...found.keys()]).toEqual(["c"]);
  });
});

test.describe("newOutputs", () => {
  const entry = { kind: "entry", owner: undefined } as const;

  test("keeps what appeared, in declared order, never what was already there", () => {
    const after = new Map([
      ["c", entry],
      ["a", entry],
      ["b", entry],
    ]);
    expect(newOutputs(["a", "b", "c", "d"], new Set(["b"]), after)).toEqual([
      "a",
      "c",
    ]);
  });

  test("ignores what was there and is gone", () => {
    expect(newOutputs(["a"], new Set(["a"]), new Map())).toEqual([]);
  });
});

test.describe("coveringPath", () => {
  test("the nearest listed path strictly above, never a sibling sharing a prefix", () => {
    const paths = ["w/cache", "w/cache/rocket", "w/cache-other"];
    expect(coveringPath("w/cache/rocket/x", paths)).toBe("w/cache/rocket");
    expect(coveringPath("w/cache/rocket", paths)).toBe("w/cache");
    expect(coveringPath("w/cache", paths)).toBeUndefined();
    expect(coveringPath("w/cache-other/x", ["w/cache"])).toBeUndefined();
  });
});

test.describe("outermostCovering", () => {
  test("the outermost listed path above, the one actually handed over", () => {
    const paths = ["w/cache", "w/cache/a", "w/cache/a/b", "w/cache-other"];
    expect(outermostCovering("w/cache/a/b", paths)).toBe("w/cache");
    expect(outermostCovering("w/cache/a", paths)).toBe("w/cache");
    expect(outermostCovering("w/cache", paths)).toBeUndefined();
    expect(outermostCovering("w/cache-other/x", ["w/cache"])).toBeUndefined();
    // Only what is listed counts: a gap in the chain does not stop it.
    expect(outermostCovering("w/cache/a/b", ["w/cache/a/b", "w"])).toBe("w");
  });
});

test.describe("OUTPUTS_CHECK_SCRIPT", () => {
  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "install-outputs-"));
  });

  test.afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("reports what exists by index, links unfollowed, whatever the names hold", () => {
    const names = [
      "file.php",
      "missing",
      "dir",
      "dangling",
      "link-to-dir",
      "-n",
      "a b$(touch pwned)'\n`id`",
    ];
    writeFileSync(join(dir, "file.php"), "<?php");
    mkdirSync(join(dir, "dir"));
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    symlinkSync(join(dir, "dir"), join(dir, "link-to-dir"));
    writeFileSync(join(dir, "-n"), "");
    writeFileSync(join(dir, names[6] ?? ""), "");

    const stdout = execFileSync(
      "sh",
      ["-c", OUTPUTS_CHECK_SCRIPT, "check", ...names.map((n) => join(dir, n))],
      { encoding: "utf8", cwd: dir },
    );
    const found = parseOutputsCheck(stdout, names);

    expect([...found.keys()]).toEqual([
      "file.php",
      "dir",
      "dangling",
      "link-to-dir",
      "-n",
      names[6],
    ]);
    expect(found.get("dangling")).toEqual({ kind: "symlink" });
    expect(found.get("link-to-dir")).toEqual({ kind: "symlink" });
    expect(found.get("dir")?.kind).toBe("entry");
    // Nothing in a name ran.
    expect(() => execFileSync("test", ["-e", join(dir, "pwned")])).toThrow();
  });
});
