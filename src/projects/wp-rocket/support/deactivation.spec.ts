import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FORCE_DEACTIVATE_PHP,
  WP_ROCKET_BASENAME,
  forceDeactivateWpRocket,
  forceFailure,
  parseForceAnswer,
} from "./deactivation";
import { wpRocket } from "../config/wp-rocket.config";
import { removeTempDir } from "../../../common/__fixtures__/temp-dir";
import type { Transport } from "../../../common/config/types";

/**
 * WP Rocket's forced deactivation: its answers read (pure), and its snippet run for real outside
 * WordPress through a harness stubbing what it calls, WP Rocket's refusal included
 * (`__fixtures__/deactivation-harness.php`; skipped where PHP is not installed). The twin spec runs it
 * on real WordPress with an unwritable `wp-config.php`.
 */

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "deactivation-harness.php",
);

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** Never reached: a refused slug runs nothing. */
const TRANSPORT: Transport = { mode: "local", rootDir: "/nowhere" };

test.describe("parseForceAnswer / forceFailure", () => {
  test("a deactivation that took is no failure", () => {
    const answer = parseForceAnswer('{"active":false,"transients":2}');
    expect(answer).toEqual({ kind: "done", active: false, transients: 2 });
    expect(forceFailure(answer)).toBeUndefined();
  });

  test("reads the last line, after anything PHP printed before it", () => {
    expect(
      parseForceAnswer('Notice: x\n{"active":false,"transients":0}'),
    ).toEqual({ kind: "done", active: false, transients: 0 });
  });

  test("still active is a failure", () => {
    expect(
      forceFailure(parseForceAnswer('{"active":true,"transients":0}')),
    ).toBe("WP Rocket is still active after `deactivate_plugins()`");
  });

  test("a refusal names the causes, plain and bounded", () => {
    const failure = forceFailure(
      parseForceAnswer(
        JSON.stringify({ refused: ["other\u001b[31m", "x".repeat(400)] }),
      ),
    );
    expect(failure).toMatch(
      /^WP Rocket still refused its deactivation for causes other than its own unwritable wp-config\.php and \.htaccess: other, x+$/,
    );
    expect(failure?.length).toBeLessThan(400);
  });

  test("no output is a deactivation that died saying nothing", () => {
    expect(forceFailure(parseForceAnswer(""))).toMatch(/saying nothing$/);
  });

  for (const [name, line] of [
    ["not JSON", "PHP Warning: x"],
    ["not an object", "[1]"],
    [
      "a transient count that is no integer",
      '{"active":false,"transients":"2"}',
    ],
    ["no active flag", '{"transients":0}'],
  ] as const) {
    test(`refuses ${name}`, () => {
      expect(() => parseForceAnswer(line)).toThrow(
        /answered something unreadable/,
      );
    });
  }

  test("refuses to force any plugin but WP Rocket, running nothing", async () => {
    await expect(
      forceDeactivateWpRocket(TRANSPORT, "backwpup"),
    ).rejects.toThrow(
      'can only force WP Rocket\'s deactivation ("wp-rocket"), not "backwpup".',
    );
  });

  test("is the product's registered force", () => {
    expect(wpRocket.forceDeactivate).toBe(forceDeactivateWpRocket);
  });
});

test.describe("the forced deactivation, in PHP", () => {
  test.skip(!HAS_PHP, "php is not installed here");

  let dir: string;

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-wpr-deactivation-"));
    mkdirSync(join(dir, "wp-admin", "includes"), { recursive: true });
    writeFileSync(join(dir, "wp-admin", "includes", "plugin.php"), "<?php\n");
  });

  test.afterEach(() => {
    removeTempDir(dir);
  });

  /** Runs the snippet over a stub site; returns its output and the site after it. */
  function run(site: {
    readonly causes: readonly string[];
    readonly options?: readonly string[];
    readonly userId?: number;
    readonly admins?: readonly number[];
    readonly cache?: readonly string[];
  }): {
    readonly status: number | null;
    readonly stdout: string;
    readonly after: { active: string[]; options: string[]; cache: string[] };
  } {
    const snippet = join(dir, "snippet.php");
    const input = join(dir, "site.json");
    const out = join(dir, "after.json");
    writeFileSync(snippet, FORCE_DEACTIVATE_PHP);
    writeFileSync(
      input,
      JSON.stringify({
        root: dir,
        userId: site.userId ?? 1,
        active: ["other/other.php", WP_ROCKET_BASENAME],
        options: site.options ?? [],
        causes: site.causes,
        admins: site.admins ?? [],
        ...(site.cache === undefined ? {} : { cache: site.cache }),
      }),
    );
    const result = spawnSync("php", [HARNESS, snippet, input, out], {
      encoding: "utf8",
    });
    expect(result.stderr).toBe("");
    return {
      status: result.status,
      stdout: result.stdout,
      after: JSON.parse(readFileSync(out, "utf8")) as {
        active: string[];
        options: string[];
        cache: string[];
      },
    };
  }

  test("is valid PHP", () => {
    const file = join(dir, "snippet.php");
    writeFileSync(file, `<?php\n${FORCE_DEACTIVATE_PHP}`);
    const lint = spawnSync("php", ["-l", file], { encoding: "utf8" });
    expect(lint.status, lint.stdout + lint.stderr).toBe(0);
  });

  test("lifts WP Rocket's own causes, deactivates it alone, and deletes every user's refusal transient", () => {
    const result = run({
      causes: ["wpconfig", "htaccess"],
      options: [
        "_transient_0_donotdeactivaterocket",
        "_transient_1_donotdeactivaterocket",
        "_transient_timeout_1_donotdeactivaterocket",
        "_transient_x_donotdeactivaterocket",
        "rocket_other",
      ],
    });
    expect(result.status).toBe(0);
    expect(parseForceAnswer(result.stdout.trim())).toEqual({
      kind: "done",
      active: false,
      transients: 2,
    });
    expect(result.after.active).toEqual(["other/other.php"]);
    // A user id only: what merely ends alike is left (the sweep's, if it is WP Rocket's).
    expect(result.after.options).toEqual([
      "_transient_x_donotdeactivaterocket",
      "rocket_other",
    ]);
  });

  // Found by name in options, and by key too, the two never counted twice.
  test("deletes an administrator's refusal transient once, whether listed in options or not", () => {
    const result = run({
      causes: ["wpconfig"],
      admins: [1, 7],
      options: ["_transient_1_donotdeactivaterocket", "rocket_other"],
    });
    expect(parseForceAnswer(result.stdout.trim())).toEqual({
      kind: "done",
      active: false,
      transients: 1,
    });
    expect(result.after.options).toEqual(["rocket_other"]);
  });

  // A persistent object cache keeps transients out of options: no name to find, only keys to try.
  test("with a persistent object cache, deletes the refusal transients of user 0 and of whoever can activate plugins", () => {
    const result = run({
      causes: ["wpconfig", "htaccess"],
      userId: 7,
      admins: [1, 7],
      cache: [
        "0_donotdeactivaterocket",
        "1_donotdeactivaterocket",
        "9_donotdeactivaterocket",
        "other",
      ],
    });
    expect(result.status).toBe(0);
    expect(parseForceAnswer(result.stdout.trim())).toEqual({
      kind: "done",
      active: false,
      transients: 2,
    });
    expect(result.after.active).toEqual(["other/other.php"]);
    // User 9 can no longer activate plugins: its refusal is the documented limit.
    expect(result.after.cache).toEqual(["9_donotdeactivaterocket", "other"]);
  });

  test("a cause not WP Rocket's own still refuses, named before it dies, and the transients stay", () => {
    const result = run({
      causes: ["wpconfig", "third-party"],
      options: ["_transient_1_donotdeactivaterocket"],
    });
    expect(result.status).toBe(0);
    expect(parseForceAnswer(result.stdout.trim())).toEqual({
      kind: "refused",
      causes: ["third-party"],
    });
    expect(result.after.active).toContain(WP_ROCKET_BASENAME);
    // Its own transient, written again by the refusal; the sweep after the uninstall takes it.
    expect(result.after.options).toContain(
      "_transient_1_donotdeactivaterocket",
    );
  });

  test("with nothing refusing, deactivates and deletes nothing else", () => {
    const result = run({ causes: [] });
    expect(parseForceAnswer(result.stdout.trim())).toEqual({
      kind: "done",
      active: false,
      transients: 0,
    });
    expect(result.after.active).toEqual(["other/other.php"]);
  });
});
