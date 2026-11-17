import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertAllResolvedInsideRoot,
  assertResolvedInsideRoot,
  disposeConnections,
  readPathResolution,
  resolveOnTarget,
} from "./transport-exec";
import type { ResolveOptions } from "./transport-exec";
import { CommandKilledError } from "./errors";
import { removeTempDir } from "../__fixtures__/temp-dir";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { LocalTransport, Transport } from "../config/types";

/**
 * The resolved-path guard against real folders: `local` runs the runner's own `readlink`/`sh` (BSD
 * on macOS, GNU on CI's Linux), `ssh` the same through the in-process server, quoting included. A
 * folder at mode `000` stands in for one the transport's user cannot enter (`/root/…` on a host) —
 * which root ignores, so those cases skip when the spec runs as root.
 */

/** Whether `chmod 000` keeps this process out (never for root). */
const AS_ROOT = process.getuid?.() === 0;

/** The rejection's text, as is. */
const asIs = (reason: string): string => reason;

/**
 * A site layout under a fresh temporary folder: `site/` (the root, with `wp-content/`) and
 * `outside/locked/` (mode `000`), beside it.
 */
interface Layout {
  readonly base: string;
  readonly root: string;
  readonly content: string;
  readonly locked: string;
}

/**
 * Makes a {@link Layout} under `parent`.
 *
 * @param parent - an existing folder.
 */
function makeLayout(parent: string): Layout {
  const base = realpathSync(parent);
  const root = join(base, "site");
  const content = join(root, "wp-content");
  const locked = join(base, "outside", "locked");
  mkdirSync(content, { recursive: true });
  mkdirSync(join(locked, "x"), { recursive: true });
  chmodSync(locked, 0o000);
  return { base, root, content, locked };
}

/**
 * Opens every folder the cases close, so the layout can be removed.
 *
 * @param layout - the layout.
 * @param extra - other folders a case closed.
 */
function reopen(layout: Layout, ...extra: string[]): void {
  for (const dir of [layout.locked, ...extra]) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // Not made by this case.
    }
  }
}

/**
 * The guard's verdict on one target: `"pass"`, or the rejection's text.
 *
 * @param transport - the site.
 * @param target - the absolute path.
 * @param root - the WordPress root.
 * @param options - who else may resolve it.
 */
async function verdict(
  transport: Transport,
  target: string,
  root: string,
  options: ResolveOptions = {},
): Promise<string> {
  try {
    await assertResolvedInsideRoot(transport, target, root, asIs, options);
    return "pass";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

test.describe("assertResolvedInsideRoot — local transport", () => {
  let tmp = "";
  let layout: Layout;
  let local: LocalTransport;
  /** Folders a case closed beyond the layout's own. */
  let closed: string[] = [];

  test.beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "wp-resolve-"));
    layout = makeLayout(tmp);
    local = { mode: "local", rootDir: layout.root, elevate: false };
    closed = [];
  });

  test.afterEach(() => {
    reopen(layout, ...closed);
    removeTempDir(tmp);
  });

  test("passes an existing folder in the root", async () => {
    expect(await verdict(local, layout.content, layout.root)).toBe("pass");
  });

  test("passes a path not created yet, one or several folders below an existing one", async () => {
    expect(await verdict(local, join(layout.content, "new"), layout.root)).toBe(
      "pass",
    );
    expect(
      await verdict(local, join(layout.content, "a", "b", "c"), layout.root),
    ).toBe("pass");
  });

  test("passes a link that stays in the root", async () => {
    mkdirSync(join(layout.content, "real"));
    symlinkSync(join(layout.content, "real"), join(layout.content, "inside"));
    expect(
      await verdict(local, join(layout.content, "inside", "new"), layout.root),
    ).toBe("pass");
  });

  test("refuses a link out of the root to a folder that resolves", async () => {
    symlinkSync(join(layout.base, "outside"), join(layout.content, "out"));
    expect(
      await verdict(local, join(layout.content, "out", "new"), layout.root),
    ).toMatch(/really resolves to .*outside it/);
  });

  test("refuses a dangling link out of the root", async () => {
    symlinkSync(
      join(layout.base, "gone", "x"),
      join(layout.content, "dangling"),
    );
    expect(
      await verdict(local, join(layout.content, "dangling"), layout.root),
    ).not.toBe("pass");
  });

  test("passes a dangling link that stays in the root, through a chain of them", async () => {
    symlinkSync("gone", join(layout.content, "dangling"));
    symlinkSync(
      join(layout.content, "dangling"),
      join(layout.content, "chain"),
    );
    for (const name of ["dangling", "chain"]) {
      expect(
        await verdict(local, join(layout.content, name), layout.root),
      ).toBe("pass");
    }
  });

  test("refuses a dangling link into a folder the root holds through an outside link", async () => {
    symlinkSync(join(layout.base, "outside"), join(layout.content, "out"));
    symlinkSync(
      join(layout.content, "out", "gone"),
      join(layout.content, "via"),
    );
    expect(
      await verdict(local, join(layout.content, "via"), layout.root),
    ).toMatch(/really resolves to .*outside it/);
  });

  test("follows a dangling relative link from its own folder, never from the working directory", async () => {
    // `uploads/sub` leads out; `<root>/sub` is an innocent folder a cwd-relative reading would find.
    const uploads = join(layout.content, "uploads");
    mkdirSync(uploads);
    mkdirSync(join(layout.root, "sub"));
    symlinkSync(join(layout.base, "outside"), join(uploads, "sub"));
    symlinkSync("sub/gone", join(uploads, "evil"));
    expect(await verdict(local, join(uploads, "evil"), layout.root)).toMatch(
      /really resolves to .*outside it/,
    );
  });

  test("refuses a dangling link to a path above the root", async () => {
    symlinkSync("/e2e-gone-above-root/x", join(layout.content, "above"));
    expect(
      await verdict(local, join(layout.content, "above"), layout.root),
    ).toMatch(/really resolves to "\/[^"]*", which is outside it/);
  });

  test.describe("a path that exists but cannot be followed", () => {
    test.skip(AS_ROOT, "root enters a folder at mode 000");

    test("refuses a link into a folder the user cannot enter, and every path beneath it", async () => {
      symlinkSync(join(layout.locked, "x"), join(layout.content, "link"));
      for (const target of [
        join(layout.content, "link"),
        join(layout.content, "link", "sub"),
        join(layout.content, "link", "sub", "deeper"),
      ]) {
        expect(await verdict(local, target, layout.root)).toMatch(
          /cannot be searched by the transport's user,.* passwordless `sudo`/,
        );
      }
    });

    test("refuses a dangling-looking link into a folder the user cannot enter", async () => {
      symlinkSync(join(layout.locked, "gone"), join(layout.content, "hidden"));
      expect(
        await verdict(local, join(layout.content, "hidden"), layout.root),
      ).toMatch(/cannot be searched by the transport's user/);
    });

    test("refuses a path beneath a folder in the root the user cannot enter", async () => {
      const privateDir = join(layout.content, "private");
      mkdirSync(join(privateDir, "x"), { recursive: true });
      chmodSync(privateDir, 0o000);
      closed.push(privateDir);
      expect(
        await verdict(local, join(privateDir, "x", "y"), layout.root),
      ).toMatch(/cannot be searched by the transport's user/);
    });

    test("refuses the first such target of several, after passing the rest", async () => {
      symlinkSync(join(layout.locked, "x"), join(layout.content, "link"));
      await expect(
        assertAllResolvedInsideRoot(
          local,
          [join(layout.content, "new"), join(layout.content, "link", "sub")],
          layout.root,
          asIs,
        ),
      ).rejects.toThrow(/way to "[^"]*link\/sub" .*cannot be searched/);
    });
  });

  test("refuses a path through a link loop", async () => {
    symlinkSync(join(layout.content, "loop"), join(layout.content, "loop"));
    expect(
      await verdict(local, join(layout.content, "loop", "x"), layout.root),
    ).toMatch(/exists but cannot be followed/);
  });

  test("refuses a path through a file", async () => {
    writeFileSync(join(layout.content, "file.txt"), "x");
    expect(
      await verdict(local, join(layout.content, "file.txt", "x"), layout.root),
    ).toMatch(/exists but cannot be followed/);
  });

  test("refuses a root that does not resolve, saying so", async () => {
    const missing = join(layout.base, "missing", "deeper");
    expect(await verdict(local, join(missing, "x"), missing)).toMatch(
      /the site's root "[^"]*deeper" itself could not be resolved/,
    );
  });

  test("refuses a target whose folder leads out of the root, though the target leads back in", async () => {
    // `rm -rf`/`chown -h` act on `name` inside `outside/`, not on where `name` leads.
    const outside = join(layout.base, "outside");
    symlinkSync(outside, join(layout.root, "X"));
    symlinkSync(layout.content, join(outside, "name"));
    expect(
      await verdict(local, join(layout.root, "X", "name"), layout.root),
    ).toMatch(
      /the folder holding "[^"]*X\/name" really resolves to .*outside it/,
    );
  });

  test("passes the root itself as a target, whose folder is outside by definition", async () => {
    expect(await verdict(local, layout.root, layout.root)).toBe("pass");
    expect(await verdict(local, `${layout.root}/`, layout.root)).toBe("pass");
  });

  test("passes a dangling link spelling the root shorter than the configured alias of it", async () => {
    // `rootDir` a longer link to the real folder; the link names the real, shorter spelling.
    const alias = join(layout.base, "a-much-longer-alias-of-the-site-root");
    symlinkSync(layout.root, alias);
    symlinkSync(join(layout.content, "gone", "x"), join(layout.content, "d"));
    expect(await verdict(local, join(alias, "wp-content", "d"), alias)).toBe(
      "pass",
    );
  });

  test("refuses a link to a sibling of the root named as the root plus trailing blanks", async () => {
    for (const [name, suffix] of [
      ["space", " "],
      ["tab", "\t"],
      ["newline", "\n"],
    ] as const) {
      mkdirSync(`${layout.root}${suffix}`);
      symlinkSync(`${layout.root}${suffix}`, join(layout.content, name));
      // GNU and BusyBox print the name exactly: outside. macOS's `readlink -f` drops a trailing
      // newline, which `-ef` catches: refused as unfollowable.
      expect(
        await verdict(local, join(layout.content, name), layout.root),
        name,
      ).not.toBe("pass");
      expect(
        await verdict(local, join(layout.content, name, "x"), layout.root),
        name,
      ).not.toBe("pass");
    }
  });

  test("resolveOnTarget keeps a resolved name's trailing blanks", async () => {
    const sibling = `${layout.root} `;
    mkdirSync(sibling);
    expect(await resolveOnTarget(local, sibling)).toBe(sibling);
  });

  test("returns the root as it resolved", async () => {
    expect(
      await assertAllResolvedInsideRoot(
        local,
        [join(layout.content, "new")],
        layout.root,
        asIs,
      ),
    ).toBe(layout.root);
  });
});

test.describe("assertResolvedInsideRoot — ssh transport", () => {
  test.skip(AS_ROOT, "root enters a folder at mode 000");

  let server: SshTestServer;
  let restore: () => void = () => undefined;
  let layout: Layout | undefined;

  test.beforeAll(async () => {
    server = await startSshServer();
    restore = steerNodeSsh(() => ({ port: server.port }));
    layout = makeLayout(server.base);
  });

  test.afterAll(async () => {
    disposeConnections();
    restore();
    if (layout !== undefined) reopen(layout);
    await server.close();
  });

  test("refuses a link into a folder the user cannot enter, in one command per target", async () => {
    if (layout === undefined) throw new Error("no layout");
    const { root, content, locked } = layout;
    const ssh = server.transport({ rootDir: root });
    symlinkSync(join(locked, "x"), join(content, "link"));

    const before = server.commands.length;
    expect(await verdict(ssh, join(content, "new"), root)).toBe("pass");
    // The root, then the target's one command, whatever the walk.
    expect(server.commands.length - before).toBe(2);

    const mid = server.commands.length;
    expect(await verdict(ssh, join(content, "link", "sub"), root)).toMatch(
      /cannot be searched by the transport's user/,
    );
    // Plus, only on that path: root's `sudo -n true`, then the script as root (which the fake
    // `sudo` runs as this user, who still cannot search).
    expect(server.commands.length - mid).toBe(4);
  });
});

test.describe("assertResolvedInsideRoot — a readlink that fails on an existing path", () => {
  let server: SshTestServer;
  let restore: () => void = () => undefined;

  test.beforeAll(async () => {
    server = await startSshServer();
    restore = steerNodeSsh(() => ({ port: server.port }));
  });

  test.afterAll(async () => {
    disposeConnections();
    restore();
    await server.close();
  });

  test("refuses the path rather than judging the folder holding it", async () => {
    const layout = makeLayout(server.base);
    const target = join(layout.content, "exists");
    mkdirSync(target);
    try {
      server.addProgram(
        "readlink",
        `for a do :; done; [ "$a" = '${target}' ] && exit 1; exec /usr/bin/readlink "$@"`,
      );
      expect(
        await verdict(
          server.transport({ rootDir: layout.root }),
          target,
          layout.root,
        ),
      ).toMatch(/exists but cannot be followed/);
    } finally {
      server.removeProgram("readlink");
      reopen(layout);
    }
  });
});

test.describe("assertResolvedInsideRoot — a readlink that resolves a dangling relative link from the working directory", () => {
  let server: SshTestServer;
  let restore: () => void = () => undefined;

  test.beforeAll(async () => {
    server = await startSshServer();
    restore = steerNodeSsh(() => ({ port: server.port }));
  });

  test.afterAll(async () => {
    disposeConnections();
    restore();
    await server.close();
  });

  /**
   * BusyBox's `readlink -f` (the `docker` transport's `wordpress:cli`) reads `uploads/evil -> sub/gone`
   * as `<cwd>/sub/gone` — measured. Stood in for here: on `-f`, a dangling link's relative target is
   * resolved from the working directory (the root), never from the link's folder.
   */
  test("follows the link from its own folder, never asking readlink -f to", async () => {
    const layout = makeLayout(server.base);
    const { root, content } = layout;
    try {
      server.addProgram(
        "readlink",
        [
          'if [ "$1" = -f ]; then for a do :; done',
          '  if [ -L "$a" ] && [ ! -e "$a" ]; then t=$(/usr/bin/readlink -- "$a"); case $t in /*) ;; *) printf "%s\\n" "$PWD/$t"; exit 0 ;; esac; fi',
          "fi",
          'exec /usr/bin/readlink "$@"',
        ].join("\n"),
      );
      const uploads = join(content, "uploads");
      mkdirSync(uploads);
      mkdirSync(join(root, "sub"));
      symlinkSync(join(layout.base, "outside"), join(uploads, "sub"));
      symlinkSync("sub/gone", join(uploads, "evil"));

      expect(
        await verdict(
          server.transport({ rootDir: root }),
          join(uploads, "evil"),
          root,
        ),
      ).toMatch(/really resolves to .*outside it/);
    } finally {
      server.removeProgram("readlink");
      reopen(layout);
    }
  });
});

test.describe("readPathResolution", () => {
  const run = (exitCode: number, stdout: string) =>
    readPathResolution({ exitCode, stdout, stderr: "" });

  test("reads the two NUL-terminated paths of a resolved run, exactly", () => {
    expect(run(0, "/a b \n\0/a\0")).toEqual({
      kind: "resolved",
      target: "/a b \n",
      parent: "/a",
    });
  });

  test("reads the script's own refusals by their exit codes", () => {
    expect(run(3, "")).toEqual({ kind: "unsearchable" });
    expect(run(4, "")).toEqual({ kind: "unfollowable" });
  });

  test("reads anything else as unknown: another exit, or output the script never prints", () => {
    for (const [exitCode, stdout] of [
      [1, ""], // `sudo` refusing
      [127, ""], // no `sh`
      [0, ""],
      [0, "/a\0"],
      [0, "/a\0/b"],
      [0, "/a\0/b\0/c\0"],
      [0, "a\0/b\0"],
      [0, "/a\0b\0"],
      [1, "/a\0/b\0"],
    ] as const) {
      expect(run(exitCode, stdout), JSON.stringify(stdout)).toEqual({
        kind: "unknown",
        exitCode,
      });
    }
  });
});

test.describe("assertResolvedInsideRoot — a folder the transport's user cannot search", () => {
  test.skip(AS_ROOT, "root enters a folder at mode 000");

  let server: SshTestServer;
  let restore: () => void = () => undefined;
  let layout: Layout;
  let uploads = "";

  /** The identity a `site` state would hand the guard. */
  const IDENTITY = {
    target: { user: "www-data", group: "www-data" },
    umask: "0022",
  } as const;

  test.beforeAll(async () => {
    server = await startSshServer();
    restore = steerNodeSsh(() => ({ port: server.port }));
  });

  test.beforeEach(() => {
    layout = makeLayout(mkdtempSync(join(server.base, "case-")));
    uploads = join(layout.content, "uploads");
    mkdirSync(join(uploads, "data"), { recursive: true });
    symlinkSync(join(layout.base, "outside"), join(uploads, "out"));
    chmodSync(uploads, 0o000);
    server.denySudo(false);
  });

  test.afterEach(() => {
    server.sudoSees(undefined);
    reopen(layout, uploads);
    disposeConnections();
  });

  test.afterAll(async () => {
    restore();
    await server.close();
  });

  /** The fake `sudo`'s calls since `from` that ran the resolver script as root. */
  const rootScripts = (from: number): string[][] =>
    server
      .sudoCalls()
      .slice(from)
      .filter((argv) => argv[0] === "-n" && argv[1] === "--");

  test("passes a path beneath it once root, with passwordless sudo, resolves it", async () => {
    server.sudoSees({ who: "root", dir: uploads });
    const from = server.sudoCalls().length;
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(uploads, "data", "x"),
        layout.root,
      ),
    ).toBe("pass");
    expect(rootScripts(from).map((argv) => argv.slice(2, 4))).toEqual([
      ["sh", "-c"],
    ]);
  });

  test("refuses a link out beneath it, as root resolves it", async () => {
    server.sudoSees({ who: "root", dir: uploads });
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(uploads, "out", "x"),
        layout.root,
      ),
    ).toMatch(/really resolves to .*outside it/);
  });

  test("refuses it without elevation, naming what the host must allow", async () => {
    const from = server.sudoCalls().length;
    expect(
      await verdict(
        server.transport({ rootDir: layout.root, elevate: false }),
        join(uploads, "data", "x"),
        layout.root,
      ),
    ).toMatch(
      /cannot be searched by the transport's user, so .*must let the transport's user search \(`x`\) every folder down to it, or give it passwordless `sudo`/,
    );
    expect(server.sudoCalls().slice(from)).toEqual([]);
  });

  test("passes it once the site's identity resolves it, never asking root", async () => {
    server.sudoSees({ who: "www-data", dir: uploads });
    const from = server.sudoCalls().length;
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(uploads, "data", "x"),
        layout.root,
        { identity: () => Promise.resolve(IDENTITY) },
      ),
    ).toBe("pass");
    const calls = server.sudoCalls().slice(from);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 5)).toEqual([
      "-n",
      "-u",
      "www-data",
      "-g",
      "www-data",
    ]);
  });

  test("goes on to root when sudo refuses the identity", async () => {
    server.denySudo({ user: "www-data" });
    server.sudoSees({ who: "root", dir: uploads });
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(uploads, "data", "x"),
        layout.root,
        { identity: () => Promise.resolve(IDENTITY) },
      ),
    ).toBe("pass");
  });

  test("refuses it when none of them can search it, naming each", async () => {
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(uploads, "data", "x"),
        layout.root,
        { identity: () => Promise.resolve(IDENTITY) },
      ),
    ).toMatch(
      /cannot be searched by the transport's user, nor by the site's identity, nor by root, .*every folder down to it$/,
    );
  });

  test("asks for the identity only when the transport's user cannot search", async () => {
    let asked = 0;
    const identity = (): Promise<typeof IDENTITY> => {
      asked += 1;
      return Promise.resolve(IDENTITY);
    };
    expect(
      await verdict(
        server.transport({ rootDir: layout.root }),
        join(layout.content, "new"),
        layout.root,
        { identity },
      ),
    ).toBe("pass");
    expect(asked).toBe(0);
  });
});

test.describe("assertResolvedInsideRoot — a readlink killed while reading a dangling link", () => {
  let server: SshTestServer;
  let restore: () => void = () => undefined;

  test.beforeAll(async () => {
    server = await startSshServer();
    restore = steerNodeSsh(() => ({ port: server.port }));
  });

  test.afterAll(async () => {
    disposeConnections();
    restore();
    await server.close();
  });

  test("throws CommandKilledError rather than refusing", async () => {
    const layout = makeLayout(server.base);
    const link = join(layout.content, "dangling");
    symlinkSync("gone", link);
    try {
      // Only the plain `readlink` the script reads a dangling link with dies, never `readlink -f`.
      server.addProgram(
        "readlink",
        `[ "$1" != -f ] && [ "$2" = '${link}' ] && kill -SEGV $$; exec /usr/bin/readlink "$@"`,
      );
      await expect(
        assertResolvedInsideRoot(
          server.transport({ rootDir: layout.root }),
          link,
          layout.root,
          asIs,
        ),
      ).rejects.toBeInstanceOf(CommandKilledError);
    } finally {
      server.removeProgram("readlink");
      reopen(layout);
    }
  });
});
