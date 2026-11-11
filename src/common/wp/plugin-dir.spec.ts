import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginDirRemovalFailedError } from "./errors";
import { resetElevationCaches } from "./exec";
import {
  describePluginDir,
  formatAge,
  inspectPluginDir,
  inspectPluginDirs,
  parsePluginDirReport,
  removePluginDir,
} from "./plugin-dir";
import { INSPECT_PLUGIN_DIR_BASH } from "../__fixtures__/plugin-dir-stub";
import type { PresentPluginDir } from "./plugin-dir";
import type { LocalTransport } from "../config/types";
import { SKIP_SUDO_OPTIONS } from "../__fixtures__/fake-sudo";

/**
 * The plugin-folder states and their removal, on the `local` transport against real folders: a stub
 * `wp` answers the inspection from the filesystem (the snippet itself runs under real PHP in
 * `plugin-dir.php.spec.ts`), while `rm`, `test` and `readlink` are the real ones.
 *
 * Switches, via the environment: `WP_STUB_PLUGINS` / `WP_STUB_SLUG` — the folder and slug inspected;
 * `WP_STUB_REPLY` — a canned reply instead; `WP_STUB_RECREATE` — the folder comes back from the
 * second inspection on, as if something were still installing it.
 */
const STUB_WP = `#!/usr/bin/env bash
${INSPECT_PLUGIN_DIR_BASH}
printf '%s\\n' "$1 $2 $3" >> "$WP_STUB_LOG"
if [ "$1 $2 $3" != "--skip-plugins --skip-themes eval" ]; then
  echo "stub: unexpected wp $1 $2 $3" >&2
  exit 3
fi
count=$(( $(cat "$WP_STUB_COUNT" 2>/dev/null || echo 0) + 1 ))
echo "$count" > "$WP_STUB_COUNT"
if [ -n "$WP_STUB_RECREATE" ] && [ "$count" -ge 2 ]; then
  mkdir -p "$WP_STUB_PLUGINS/$WP_STUB_SLUG/again"
fi
if [ -n "$WP_STUB_REPLY" ]; then printf '%s' "$WP_STUB_REPLY"; exit 0; fi
inspect_plugin_dir "$WP_STUB_PLUGINS" "$WP_STUB_SLUG"
`;

/** Root ignores directory permissions, so a folder only elevation can empty cannot be made. */
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

const SLUG = "backwpup-pro";

let binDir: string;
let originalPath: string | undefined;
let root: string;
let outside: string;
let plugins: string;
let local: LocalTransport;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-plugin-dir-bin-"));
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "wp-plugin-dir-root-"));
  outside = mkdtempSync(join(tmpdir(), "wp-plugin-dir-outside-"));
  plugins = join(root, "wp-content", "plugins");
  mkdirSync(plugins, { recursive: true });
  // `elevate: false`: a unit run must never reach for the machine's real `sudo`.
  local = { mode: "local", rootDir: root, elevate: false };
  process.env.WP_STUB_PLUGINS = plugins;
  process.env.WP_STUB_SLUG = SLUG;
  process.env.WP_STUB_LOG = join(binDir, "calls.log");
  process.env.WP_STUB_COUNT = join(binDir, "count");
});

test.afterEach(() => {
  for (const key of [
    "WP_STUB_PLUGINS",
    "WP_STUB_SLUG",
    "WP_STUB_LOG",
    "WP_STUB_COUNT",
    "WP_STUB_REPLY",
    "WP_STUB_RECREATE",
  ]) {
    Reflect.deleteProperty(process.env, key);
  }
  rmSync(join(binDir, "calls.log"), { force: true });
  rmSync(join(binDir, "count"), { force: true });
  for (const dir of [root, outside]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** The `wp` calls made so far. */
function calls(): string[] {
  const log = process.env.WP_STUB_LOG;
  return log !== undefined && existsSync(log)
    ? readFileSync(log, "utf8").split("\n").filter(Boolean)
    : [];
}

/** A plugin WordPress would list: a folder with its main file. */
function seedRecognised(): string {
  const dir = join(plugins, SLUG);
  mkdirSync(join(dir, "vendor"), { recursive: true });
  writeFileSync(join(dir, "main.php"), "<?php // Plugin Name: x");
  writeFileSync(join(dir, "vendor", "autoload.php"), "<?php");
  return dir;
}

/** What a removal stopped part-way leaves: no main file, the rest kept. */
function seedOrphaned(): string {
  const dir = join(plugins, SLUG);
  mkdirSync(join(dir, "vendor", "berlindb"), { recursive: true });
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "vendor", "berlindb", "Base.php"), "<?php");
  return dir;
}

/** A present folder, as a reply would describe it. */
function present(overrides: Partial<PresentPluginDir> = {}): PresentPluginDir {
  return {
    kind: "orphaned",
    path: "/srv/site/wp-content/plugins/backwpup-pro",
    type: "directory",
    entries: 3830,
    topLevel: 6,
    sample: ["assets", "config", "inc", "pro", "src", "vendor"],
    owner: "www-data",
    ageSeconds: 7200,
    ...overrides,
  };
}

test.describe("parsePluginDirReport", () => {
  test("reads every state the snippet reports", () => {
    const states = parsePluginDirReport(
      JSON.stringify({
        a: { kind: "absent", path: "/p/a" },
        b: {
          kind: "orphaned",
          path: "/p/b",
          type: "directory",
          owner: "www-data",
          age: 30,
          sample: ["src", "vendor"],
          entries: 12,
          top: 2,
          capped: false,
        },
        c: {
          kind: "recognised",
          path: "/p/c",
          type: "link",
          owner: "1000",
          age: 0,
          sample: [],
          target: "/elsewhere/c",
        },
      }),
      ["a", "b", "c"],
    );
    expect(states.get("a")).toEqual({ kind: "absent", path: "/p/a" });
    expect(states.get("b")).toEqual({
      kind: "orphaned",
      path: "/p/b",
      type: "directory",
      owner: "www-data",
      ageSeconds: 30,
      sample: ["src", "vendor"],
      entries: 12,
      topLevel: 2,
    });
    expect(states.get("c")).toEqual({
      kind: "recognised",
      path: "/p/c",
      type: "link",
      owner: "1000",
      ageSeconds: 0,
      sample: [],
      target: "/elsewhere/c",
    });
  });

  test("keeps a capped count's flag, so it reads as a floor", () => {
    const state = parsePluginDirReport(
      JSON.stringify({
        a: {
          kind: "orphaned",
          path: "/p/a",
          type: "directory",
          owner: "x",
          age: 1,
          sample: [],
          entries: 100000,
          capped: true,
        },
      }),
      ["a"],
    ).get("a");
    expect(state).toMatchObject({ entries: 100000, capped: true });
  });

  test("reads an age from a clock behind the file's as zero", () => {
    const state = parsePluginDirReport(
      JSON.stringify({
        a: {
          kind: "orphaned",
          path: "/p/a",
          type: "file",
          owner: "x",
          age: -40,
          sample: [],
        },
      }),
      ["a"],
    ).get("a");
    expect(state).toMatchObject({ ageSeconds: 0 });
  });

  test("refuses a reply that is not JSON, quoting it", () => {
    expect(() => parsePluginDirReport("PHP Warning: x", ["a"])).toThrow(
      /did not come back as JSON: PHP Warning: x/,
    );
  });

  test("says an empty reply is empty", () => {
    expect(() => parsePluginDirReport("", ["a"])).toThrow(
      /did not come back as JSON: \(empty\)$/,
    );
  });

  // A PHP warning loop, or a page of HTML, must not flood the message.
  test("quotes at most 300 characters of a reply it refuses", () => {
    const quoted = (reply: string): string => {
      try {
        parsePluginDirReport(reply, ["a"]);
      } catch (error) {
        const { message } = error as Error;
        return message.slice(message.indexOf(": ") + 2);
      }
      throw new Error("not refused");
    };
    expect(quoted("y".repeat(1000))).toBe("y".repeat(300));
    expect(quoted(`[${"1,".repeat(500)}1]`)).toHaveLength(300);
  });

  test("refuses a reply missing a slug it was asked about", () => {
    expect(() =>
      parsePluginDirReport(
        JSON.stringify({ a: { kind: "absent", path: "/p/a" } }),
        ["a", "b"],
      ),
    ).toThrow(/not one state per plugin/);
  });

  for (const [name, entry] of [
    ["an unknown kind", { kind: "gone", path: "/p/a" }],
    ["no path", { kind: "absent" }],
    [
      "an unknown type",
      {
        kind: "orphaned",
        path: "/p/a",
        type: "fifo",
        owner: "x",
        age: 1,
        sample: [],
      },
    ],
    [
      "an owner that is not a name",
      {
        kind: "orphaned",
        path: "/p/a",
        type: "file",
        owner: 33,
        age: 1,
        sample: [],
      },
    ],
    [
      "a fractional age",
      {
        kind: "orphaned",
        path: "/p/a",
        type: "file",
        owner: "x",
        age: 1.5,
        sample: [],
      },
    ],
    [
      "a sample that is not names",
      {
        kind: "orphaned",
        path: "/p/a",
        type: "file",
        owner: "x",
        age: 1,
        sample: [1],
      },
    ],
  ] as const) {
    test(`refuses a state with ${name}`, () => {
      expect(() =>
        parsePluginDirReport(JSON.stringify({ a: entry }), ["a"]),
      ).toThrow(/not one state per plugin/);
    });
  }
});

test.describe("describePluginDir", () => {
  test("names the path, what is there, a sample, the owner and the age", () => {
    expect(describePluginDir(present())).toBe(
      "/srv/site/wp-content/plugins/backwpup-pro: a folder WordPress lists no plugin in, 3830 " +
        "entries (assets, config, inc, pro, src, vendor); owner www-data; last changed 2 h ago",
    );
  });

  test("says how many top-level names the sample leaves out", () => {
    expect(
      describePluginDir(present({ topLevel: 9, sample: ["a", "b"] })),
    ).toContain("(a, b, … 7 more)");
  });

  test("keeps a name holding a newline or an escape sequence on one plain line", () => {
    const line = describePluginDir(
      present({
        sample: ["a\nb", "\u001b[31mred\u001b[0m"],
        owner: "www\r\ndata",
      }),
    );
    for (const control of ["\n", "\r", "\u001b"]) {
      expect(line).not.toContain(control);
    }
    expect(line).toContain("(a b, red, … 4 more)");
    expect(
      describePluginDir(
        present({ type: "link", target: "/x\n/y", sample: [] }),
      ),
    ).toContain('a link to "/x /y"');
  });

  test("reads a capped count as a floor", () => {
    expect(
      describePluginDir(present({ entries: 100000, capped: true })),
    ).toContain("over 100000 entries");
  });

  test("tells a listed plugin, a link, a file, an empty and an unreadable folder apart", () => {
    expect(describePluginDir(present({ kind: "recognised" }))).toContain(
      "a folder WordPress lists a plugin in",
    );
    expect(
      describePluginDir(
        present({ type: "link", target: "/elsewhere", sample: [] }),
      ),
    ).toContain('a link to "/elsewhere" (WordPress lists no plugin in it)');
    expect(describePluginDir(present({ type: "file", sample: [] }))).toContain(
      "a file, not a folder",
    );
    expect(
      describePluginDir(present({ entries: 0, topLevel: 0, sample: [] })),
    ).toContain("lists no plugin in, empty");
    const { entries: _ignored, ...unreadable } = present();
    expect(describePluginDir(unreadable)).toContain("its contents unreadable");
  });
});

test.describe("formatAge", () => {
  for (const [seconds, shown] of [
    [0, "0 s"],
    [89, "89 s"],
    [90, "2 min"],
    [5399, "90 min"],
    [5400, "2 h"],
    [172_799, "48 h"],
    [172_800, "2 days"],
    [259_199, "3 days"],
    [302_400, "4 days"],
  ] as const) {
    test(`${String(seconds)} s reads as ${shown}`, () => {
      expect(formatAge(seconds)).toBe(shown);
    });
  }
});

test.describe("inspectPluginDirs", () => {
  test("asks the site nothing for no slugs", async () => {
    expect((await inspectPluginDirs(local, [])).size).toBe(0);
    expect(calls()).toEqual([]);
  });

  test("refuses a slug that is not one path segment before asking the site", async () => {
    await expect(inspectPluginDirs(local, ["../wp-admin"])).rejects.toThrow(
      /single path segment/,
    );
    expect(calls()).toEqual([]);
  });

  // A broken copy of the plugin under test — or a broken theme — must not stop the question.
  test("boots WordPress without plugins or themes", async () => {
    await inspectPluginDir(local, SLUG);
    expect(calls()).toEqual(["--skip-plugins --skip-themes eval"]);
  });

  test("reads the three states off the folder", async () => {
    expect((await inspectPluginDir(local, SLUG)).kind).toBe("absent");
    seedOrphaned();
    expect(await inspectPluginDir(local, SLUG)).toMatchObject({
      kind: "orphaned",
      sample: ["src", "vendor"],
    });
    writeFileSync(join(plugins, SLUG, "main.php"), "<?php");
    expect((await inspectPluginDir(local, SLUG)).kind).toBe("recognised");
  });
});

test.describe("removePluginDir", () => {
  test("does nothing when nothing is there", async () => {
    expect(await removePluginDir(local, SLUG)).toBeUndefined();
  });

  test("removes a folder WordPress does not list, verifies it gone and returns what was there", async () => {
    const dir = seedOrphaned();
    const removed = await removePluginDir(local, SLUG);
    expect(existsSync(dir)).toBe(false);
    expect(removed).toMatchObject({
      kind: "orphaned",
      type: "directory",
      entries: 4,
      sample: ["src", "vendor"],
    });
    // Inspected before and after: removal is verified, never inferred from `rm`.
    expect(calls()).toHaveLength(2);
  });

  test("refuses a plugin WordPress lists, leaving it whole", async () => {
    const dir = seedRecognised();
    await expect(removePluginDir(local, SLUG)).rejects.toThrow(
      /WordPress lists a plugin there/,
    );
    expect(existsSync(join(dir, "main.php"))).toBe(true);
  });

  test("removes a plugin WordPress lists when told its uninstall already failed", async () => {
    const dir = seedRecognised();
    expect(
      await removePluginDir(local, SLUG, { recognised: true }),
    ).toMatchObject({ kind: "recognised" });
    expect(existsSync(dir)).toBe(false);
  });

  test("removes a link at the slug as a link, never what it points to", async () => {
    const target = join(outside, "real-plugin");
    mkdirSync(target);
    writeFileSync(join(target, "keep.txt"), "not ours");
    symlinkSync(target, join(plugins, SLUG));

    expect(await removePluginDir(local, SLUG)).toMatchObject({
      type: "link",
      target,
    });
    expect(existsSync(join(plugins, SLUG))).toBe(false);
    expect(readFileSync(join(target, "keep.txt"), "utf8")).toBe("not ours");
  });

  test("removes a dangling link at the slug", async () => {
    symlinkSync(join(outside, "gone"), join(plugins, SLUG));
    await removePluginDir(local, SLUG);
    expect(calls()).toHaveLength(2);
    expect((await inspectPluginDir(local, SLUG)).kind).toBe("absent");
  });

  test("removes a file at the slug", async () => {
    writeFileSync(join(plugins, SLUG), "x");
    expect(await removePluginDir(local, SLUG)).toMatchObject({ type: "file" });
    expect(existsSync(join(plugins, SLUG))).toBe(false);
  });

  test("throws, naming what is left, when the folder cannot be emptied", async () => {
    test.skip(isRoot, "root ignores directory permissions");
    const dir = seedOrphaned();
    const stuck = join(dir, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file.php"), "x");
    chmodSync(stuck, 0o555);
    try {
      const failure = await removePluginDir(local, SLUG).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PluginDirRemovalFailedError);
      const message = (failure as Error).message;
      expect(message).toContain(join(plugins, SLUG));
      expect(message).toContain("stuck");
      // Elevation was declined by the site, and the advice says that rather than "use sudo".
      expect(message).toContain("transport.elevate: false");
      expect(existsSync(join(stuck, "file.php"))).toBe(true);
    } finally {
      // Writable again, or the case's own clean-up could not remove it.
      chmodSync(stuck, 0o755);
    }
  });

  test("throws when the folder is back after every pass reported it gone", async () => {
    seedOrphaned();
    process.env.WP_STUB_RECREATE = "1";
    await expect(removePluginDir(local, SLUG)).rejects.toThrow(
      "Every removal pass reported it gone, so something re-created it — look for a request or " +
        "process still installing the plugin.",
    );
  });

  // `test -e` follows a link: a dangling one nobody could unlink would read as gone, and the advice
  // would blame a process re-creating it.
  test("names elevation, not a re-creation, for a dangling link it cannot unlink", async () => {
    test.skip(isRoot, "root ignores directory permissions");
    symlinkSync(join(outside, "gone"), join(plugins, SLUG));
    chmodSync(plugins, 0o555);
    try {
      const failure = await removePluginDir(local, SLUG).catch(
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PluginDirRemovalFailedError);
      expect((failure as Error).message).toContain("transport.elevate: false");
      expect((failure as Error).message).not.toContain("re-created");
    } finally {
      chmodSync(plugins, 0o755);
    }
  });

  /**
   * The site names `WP_PLUGIN_DIR` from WP-CLI's working directory with every link resolved, so a
   * symlinked `rootDir` never prefixes it.
   */
  test("removes a folder the site names under the real path of a symlinked rootDir", async () => {
    const dir = seedOrphaned();
    const linkedRoot = join(outside, "site");
    symlinkSync(root, linkedRoot);
    const realPlugins = realpathSync(plugins);
    process.env.WP_STUB_PLUGINS = realPlugins;

    const removed = await removePluginDir(
      { ...local, rootDir: linkedRoot },
      SLUG,
    );
    expect(removed?.path).toBe(join(realPlugins, SLUG));
    expect(existsSync(dir)).toBe(false);
  });

  test("refuses a plugin folder the site places outside its WordPress root", async () => {
    process.env.WP_STUB_PLUGINS = outside;
    mkdirSync(join(outside, SLUG));
    await expect(removePluginDir(local, SLUG)).rejects.toThrow(
      /does not lie inside the WordPress root/,
    );
    expect(existsSync(join(outside, SLUG))).toBe(true);
  });

  test("refuses a plugins folder that is a link leading out of the root", async () => {
    rmSync(plugins, { recursive: true });
    symlinkSync(outside, plugins);
    mkdirSync(join(outside, SLUG));
    await expect(removePluginDir(local, SLUG)).rejects.toThrow(
      /really resolves to/,
    );
    expect(existsSync(join(outside, SLUG))).toBe(true);
  });

  test("refuses a slug that is not one path segment before asking the site", async () => {
    await expect(removePluginDir(local, "..")).rejects.toThrow(
      /single path segment/,
    );
    expect(calls()).toEqual([]);
  });

  test("refuses a reply naming a path the slug does not end", async () => {
    mkdirSync(join(plugins, "other"));
    process.env.WP_STUB_REPLY = JSON.stringify({
      [SLUG]: {
        kind: "orphaned",
        path: join(plugins, "other"),
        type: "directory",
        owner: "x",
        age: 1,
        sample: [],
      },
    });
    await expect(removePluginDir(local, SLUG)).rejects.toThrow(
      /not named by the slug/,
    );
    expect(existsSync(join(plugins, "other"))).toBe(true);
  });
});

/**
 * The privileged pass, through a `sudo` shim that runs the command as the same user — so it can no more
 * empty a folder than the first pass could, as on a host where something other than permissions holds
 * it. Never the machine's real `sudo`.
 */
test.describe("removePluginDir — the privileged pass", () => {
  let sudoDir: string;
  let pathBefore: string;

  test.beforeEach(() => {
    sudoDir = mkdtempSync(join(tmpdir(), "wp-plugin-dir-sudo-"));
    writeFileSync(
      join(sudoDir, "sudo"),
      `#!/usr/bin/env bash\n${SKIP_SUDO_OPTIONS}\nexec "$@"\n`,
    );
    chmodSync(join(sudoDir, "sudo"), 0o755);
    pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${sudoDir}:${pathBefore}`;
    resetElevationCaches();
  });

  test.afterEach(() => {
    process.env.PATH = pathBefore;
    rmSync(sudoDir, { recursive: true, force: true });
    resetElevationCaches();
  });

  test("names what survived the elevated removal too, with advice for that", async () => {
    test.skip(isRoot, "root ignores directory permissions");
    const dir = seedOrphaned();
    const stuck = join(dir, "stuck");
    mkdirSync(stuck);
    writeFileSync(join(stuck, "file.php"), "x");
    chmodSync(stuck, 0o555);
    try {
      const failure = await removePluginDir(
        { ...local, elevate: undefined },
        SLUG,
      ).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(PluginDirRemovalFailedError);
      expect((failure as Error).message).toContain(
        "These survived an elevated `rm -rf`",
      );
      expect(existsSync(join(stuck, "file.php"))).toBe(true);
    } finally {
      chmodSync(stuck, 0o755);
    }
  });
});
