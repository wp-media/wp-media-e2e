import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";

import {
  WP_CACHE_STATE_PHP,
  pageCacheVerdict,
  parseWpCacheState,
  webMayWriteConfig,
  webServerIdentity,
} from "./wp-cache";
import type { WebServerIdentity, WpCacheState } from "./wp-cache";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import type { IdentityState } from "../../../common/wp/site-identity";
import type { SiteIdentityVerdict } from "../../../common/wp/web-identity";

/** Whether a `php` binary can run here (the snippet's own tests are skipped without one). */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/**
 * Runs {@link WP_CACHE_STATE_PHP} with `ABSPATH` at `root` and `wp_json_encode` stubbed.
 *
 * @param root - the WordPress root, with a trailing slash added.
 * @param wpCache - the PHP expression `WP_CACHE` is defined as, or `undefined` to leave it undefined.
 */
function runSnippet(root: string, wpCache?: string): string {
  const define =
    wpCache === undefined ? "" : `define( 'WP_CACHE', ${wpCache} );`;
  const result = spawnSync(
    "php",
    [
      "-r",
      `define( 'ABSPATH', ${JSON.stringify(`${root}/`)} ); ${define} ` +
        "function wp_json_encode( $v ) { return json_encode( $v ); } " +
        WP_CACHE_STATE_PHP,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

/** The `wpconfig-root` twin's file: root:www-data, 0644. */
const ROOT_OWNED = { uid: 0, gid: 33, mode: 0o644 };

/** A state, `WP_CACHE` off and the file unwritable by the commands (ubuntu) unless overridden. */
function state(overrides: Partial<WpCacheState> = {}): WpCacheState {
  return {
    wpCache: false,
    configWritable: false,
    config: ROOT_OWNED,
    commandsUser: "ubuntu",
    ...overrides,
  };
}

/** PHP as www-data (33:33), as the pre-flight read it. */
const WWW: WebServerIdentity = {
  kind: "known",
  euid: 33,
  egid: 33,
  name: "www-data",
};

test.describe("parseWpCacheState", () => {
  test("reads the state, the file's stat and the commands' user", () => {
    expect(
      parseWpCacheState(
        '{"wpCache":true,"configWritable":false,"config":{"uid":0,"gid":33,"mode":420},"commandsUser":"ubuntu"}',
      ),
    ).toEqual({
      wpCache: true,
      configWritable: false,
      config: ROOT_OWNED,
      commandsUser: "ubuntu",
    });
  });

  test("a missing file reads as no stat", () => {
    expect(
      parseWpCacheState(
        '{"wpCache":false,"configWritable":false,"config":null,"commandsUser":""}',
      ).config,
    ).toBeUndefined();
  });

  test("refuses anything else, quoting it", () => {
    for (const reply of [
      "",
      "nope",
      "[]",
      '{"wpCache":1,"configWritable":true,"config":null,"commandsUser":""}',
      '{"wpCache":true}',
      '{"wpCache":true,"configWritable":true,"config":null}',
      '{"wpCache":true,"configWritable":true,"commandsUser":""}',
      '{"wpCache":true,"configWritable":true,"config":{"uid":0,"gid":33},"commandsUser":""}',
      '{"wpCache":true,"configWritable":true,"config":{"uid":-1,"gid":33,"mode":420},"commandsUser":""}',
      '{"wpCache":true,"configWritable":true,"config":{"uid":0.5,"gid":33,"mode":420},"commandsUser":""}',
    ]) {
      expect(() => parseWpCacheState(reply), reply).toThrow(
        /reading WP_CACHE came back as/,
      );
    }
  });
});

test.describe("webServerIdentity", () => {
  const VERIFIED: SiteIdentityVerdict = {
    verdict: "owner-not-web",
    owner: { user: "sftp_twin", group: "www-data", uid: 1001, gid: 33 },
    web: {
      euid: 33,
      egid: 33,
      user: "www-data",
      group: "www-data",
      umask: "0022",
      sapi: "fpm-fcgi",
    },
  };
  const FALLBACK: IdentityState = {
    kind: "fallback",
    reason: "owner-not-web",
    detail: "x",
  };

  test("the commands are PHP in site, and on docker/local", () => {
    const site: IdentityState = {
      kind: "site",
      target: { user: "www-data", group: "www-data" },
      identity: {
        user: "www-data",
        group: "www-data",
        uid: 33,
        gid: 33,
        groupIds: [33],
        groupNames: ["www-data"],
      },
      umask: "0022",
    };
    expect(webServerIdentity(site, undefined)).toEqual({ kind: "commands" });
    expect(
      webServerIdentity({ kind: "same-user", reason: "mode" }, undefined),
    ).toEqual({ kind: "commands" });
  });

  test("otherwise the pre-flight's verdict names PHP, by uid when it had no name", () => {
    expect(webServerIdentity(FALLBACK, VERIFIED)).toEqual(WWW);
    const nameless: SiteIdentityVerdict = {
      verdict: "owner-not-web",
      owner: { user: "sftp_twin", group: "www-data", uid: 1001, gid: 33 },
      web: { euid: 48, egid: 48, umask: "0022", sapi: "fpm-fcgi" },
    };
    expect(webServerIdentity(FALLBACK, nameless)).toEqual({
      kind: "known",
      euid: 48,
      egid: 48,
      name: "uid 48",
    });
    expect(
      webServerIdentity(
        { kind: "same-user", reason: "transport-user" },
        { ...VERIFIED, verdict: "owner-is-web" },
      ),
    ).toEqual(WWW);
  });

  test("unknown without a verdict or with an unverified one, saying why", () => {
    expect(webServerIdentity(FALLBACK, undefined)).toEqual({
      kind: "unknown",
      why: "no pre-flight verdict names it",
    });
    expect(
      webServerIdentity(
        { kind: "disabled", reason: "config" },
        {
          verdict: "unverified",
          reason: "no-owner",
          detail: "owner unreadable",
        },
      ),
    ).toEqual({
      kind: "unknown",
      why: "the pre-flight could not tell: owner unreadable",
    });
  });
});

test.describe("webMayWriteConfig", () => {
  test("by the file's mode, owner class first, never a wrong no", () => {
    const cases: [
      string,
      { uid: number; gid: number; mode: number },
      WebServerIdentity,
      boolean,
    ][] = [
      ["root-owned 0644, PHP www-data", ROOT_OWNED, WWW, false],
      [
        "root-owned 0664, PHP in its group",
        { ...ROOT_OWNED, mode: 0o664 },
        WWW,
        true,
      ],
      [
        "group-writable, another group (supplementary groups unknown)",
        { uid: 0, gid: 4, mode: 0o664 },
        WWW,
        true,
      ],
      ["PHP owns it, 0644", { uid: 33, gid: 33, mode: 0o644 }, WWW, true],
      ["PHP owns it, 0444", { uid: 33, gid: 33, mode: 0o444 }, WWW, false],
      [
        "PHP owns it, 0466: the owner class decides",
        { uid: 33, gid: 33, mode: 0o466 },
        WWW,
        false,
      ],
      [
        "others may write, PHP not in its group",
        { uid: 0, gid: 4, mode: 0o646 },
        WWW,
        true,
      ],
      [
        "others may write, PHP's group may not",
        { uid: 0, gid: 33, mode: 0o646 },
        WWW,
        false,
      ],
      ["PHP as root", ROOT_OWNED, { ...WWW, euid: 0, egid: 0 }, true],
    ];
    for (const [label, config, web, expected] of cases) {
      expect(webMayWriteConfig(state({ config }), web), label).toBe(expected);
    }
  });

  test("no file: nobody writes it; unknown PHP: may; PHP as the commands: their answer", () => {
    expect(webMayWriteConfig(state({ config: undefined }), WWW)).toBe(false);
    expect(webMayWriteConfig(state(), { kind: "unknown", why: "x" })).toBe(
      true,
    );
    expect(webMayWriteConfig(state(), { kind: "commands" })).toBe(false);
    expect(
      webMayWriteConfig(state({ configWritable: true }), { kind: "commands" }),
    ).toBe(true);
  });
});

test.describe("pageCacheVerdict", () => {
  test("on whenever WP_CACHE is, whoever may write", () => {
    for (const configWritable of [true, false]) {
      expect(
        pageCacheVerdict(state({ wpCache: true, configWritable }), WWW),
      ).toEqual({ kind: "on" });
    }
  });

  test("off with the file writable by the commands is WP Rocket's activation failing", () => {
    const verdict = pageCacheVerdict(state({ configWritable: true }), WWW);
    expect(verdict.kind).toBe("off");
    expect(verdict.kind === "off" && verdict.reason).toMatch(
      /the site's commands \(ubuntu\) can write it: WP Rocket's activation/,
    );
  });

  test("off with the file writable by PHP only is WP Rocket's admin request failing, both named", () => {
    const verdict = pageCacheVerdict(
      state({ config: { uid: 33, gid: 33, mode: 0o644 } }),
      WWW,
    );
    expect(verdict.kind).toBe("off");
    expect(verdict.kind === "off" && verdict.reason).toMatch(
      /the site's commands \(ubuntu\) cannot write but the web server's PHP \(www-data\) can: WP Rocket's admin request/,
    );
  });

  test("off when who PHP runs as is unknown: never a skip", () => {
    const verdict = pageCacheVerdict(state(), {
      kind: "unknown",
      why: "no pre-flight verdict names it",
    });
    expect(verdict.kind).toBe("off");
    expect(verdict.kind === "off" && verdict.reason).toMatch(
      /PHP \(unknown: no pre-flight verdict names it\) may:/,
    );
  });

  test("skipped only when neither can write, naming both users and the fix", () => {
    const verdict = pageCacheVerdict(state(), WWW);
    expect(verdict.kind).toBe("unwritable-config");
    expect(verdict.kind === "unwritable-config" && verdict.reason).toMatch(
      /writable by neither the site's commands \(ubuntu\) nor the web server's PHP \(www-data\).*define\( 'WP_CACHE', true \)/,
    );
    // In `site` the commands are PHP: one user, judged once.
    const site = pageCacheVerdict(state({ commandsUser: "www-data" }), {
      kind: "commands",
    });
    expect(site.kind).toBe("unwritable-config");
  });
});

test.describe("WP_CACHE_STATE_PHP", () => {
  test.skip(!HAS_PHP, "php is not installed");
  let dir = "";
  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-wp-cache-"));
  });
  test.afterEach(() => {
    chmodSync(dir, 0o700);
    removeTempDir(dir);
  });

  test("reads WP_CACHE as wp-settings.php does: defined and truthy", () => {
    writeFileSync(join(dir, "wp-config.php"), "<?php\n");
    expect(parseWpCacheState(runSnippet(dir, "true"))).toMatchObject({
      wpCache: true,
      configWritable: true,
    });
    expect(parseWpCacheState(runSnippet(dir, "1")).wpCache).toBe(true);
    expect(parseWpCacheState(runSnippet(dir, "false")).wpCache).toBe(false);
    expect(parseWpCacheState(runSnippet(dir)).wpCache).toBe(false);
  });

  test("the file's owner and mode, and the commands' user, are read", () => {
    const file = join(dir, "wp-config.php");
    writeFileSync(file, "<?php\n");
    chmodSync(file, 0o640);
    const read = parseWpCacheState(runSnippet(dir));
    expect(read.config).toEqual({
      uid: statSync(file).uid,
      gid: statSync(file).gid,
      mode: 0o640,
    });
    expect(read.commandsUser).toBe(userInfo().username);
  });

  test("no wp-config.php reads as no stat, unwritable", () => {
    const read = parseWpCacheState(runSnippet(dir));
    expect(read.config).toBeUndefined();
    expect(read.configWritable).toBe(false);
  });

  test("an unwritable wp-config.php in the root reads as such", () => {
    writeFileSync(join(dir, "wp-config.php"), "<?php\n");
    chmodSync(join(dir, "wp-config.php"), 0o444);
    expect(parseWpCacheState(runSnippet(dir, "false")).configWritable).toBe(
      false,
    );
  });

  test("a wp-config.php in the folder above is the one judged, unless that folder is another install", () => {
    const root = join(dir, "public");
    mkdirSync(root);
    writeFileSync(join(dir, "wp-config.php"), "<?php\n");
    expect(parseWpCacheState(runSnippet(root)).configWritable).toBe(true);
    chmodSync(join(dir, "wp-config.php"), 0o444);
    expect(parseWpCacheState(runSnippet(root)).configWritable).toBe(false);
    chmodSync(join(dir, "wp-config.php"), 0o644);
    // Another install above: WordPress would not read its config, so the (missing) root one is judged.
    writeFileSync(join(dir, "wp-settings.php"), "<?php\n");
    expect(parseWpCacheState(runSnippet(root)).configWritable).toBe(false);
  });
});
