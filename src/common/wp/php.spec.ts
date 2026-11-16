import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { evalPhp, phpLiteral } from "./php";
import { resetWpUserCaches } from "./wp-user";

/**
 * `phpLiteral` is pure, so it is tested directly rather than through a stub `wp`: what matters is
 * that a value survives the trip into a snippet unchanged, and that nothing a caller can pass is
 * able to break out of the literal it is embedded in.
 */

/** Decodes the single `base64_decode('…')` literal in a snippet back to the value it carries. */
function roundTrip(value: unknown): unknown {
  const php = phpLiteral(value);
  const encoded = /base64_decode\( '([^']*)' \)/.exec(php)?.[1];
  if (encoded === undefined) {
    throw new Error(`no base64 literal in: ${php}`);
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

test.describe("phpLiteral", () => {
  test("round-trips values that would otherwise need escaping", () => {
    // Every character that could end a PHP single-quoted string or interpolate inside a double-quoted
    // one, in a single value. If any of them escaped the literal, the snippet would not parse.
    const hostile = `a'b"c\\d$e\nf\r\tgé中`;
    expect(roundTrip(hostile)).toBe(hostile);
  });

  test("keeps a list a list and a map a map", () => {
    // WordPress keys a cron event by the hash of its argument array, so the *shape* has to survive,
    // not only the values.
    expect(roundTrip([1, "two", true])).toEqual([1, "two", true]);
    expect(roundTrip({ arg: 7 })).toEqual({ arg: 7 });
  });

  test("emits only characters that cannot terminate the literal", () => {
    const php = phpLiteral(`'; system('rm -rf /'); //`);
    const encoded = /base64_decode\( '([^']*)' \)/.exec(php)?.[1] ?? "";
    expect(encoded).toMatch(/^[A-Za-z0-9+/=]*$/);
    // The injected payload must not appear anywhere in the snippet as source.
    expect(php).not.toContain("system(");
  });

  test("refuses a BigInt in its own terms, not as a raw TypeError", () => {
    // `JSON.stringify` throws for a BigInt rather than returning undefined, so the no-JSON-form
    // guard never sees it; unhandled, the caller gets a TypeError naming neither this function nor
    // the value.
    expect(() => phpLiteral(1n)).toThrow(/cannot be embedded in a snippet/);
  });

  test("refuses a circular structure rather than letting stringify's error escape", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => phpLiteral(circular)).toThrow(
      /cannot be embedded in a snippet/,
    );
  });

  test("refuses an unpaired surrogate, which PHP would decode to null", () => {
    // Measured against real PHP: `json_decode('"\ud800"')` fails the whole document and yields
    // NULL, so embedding one would run the snippet with an empty value instead of failing.
    expect(() => phpLiteral("\uD800")).toThrow(/unpaired UTF-16 surrogate/);
    expect(() => phpLiteral({ arg: "a\uDFFFb" })).toThrow(
      /unpaired UTF-16 surrogate/,
    );
  });

  test("sees a surrogate a toJSON() produced, which the original value never held", () => {
    // `JSON.stringify` honours `toJSON`, so the object walked and the JSON emitted can disagree.
    // Checking the decoded JSON is what closes that gap — walking the object finds nothing wrong and
    // PHP still decodes the literal to null.
    const sneaky = {
      toJSON: () => "\uD800",
    };
    expect(() => phpLiteral(sneaky)).toThrow(/unpaired UTF-16 surrogate/);
  });

  test("reframes a stack overflow on a deeply nested value in its own terms", () => {
    // `JSON.stringify` copes with depths the recursive check does not; unguarded, the caller got a
    // bare RangeError naming neither this function nor the value.
    let deep: unknown = "leaf";
    for (let i = 0; i < 6000; i += 1) deep = { deep };
    expect(() => phpLiteral(deep)).toThrow(/\[wp\/php\]/);
  });

  test("accepts a correctly paired surrogate, which is ordinary text", () => {
    // The guard must reject only broken pairs: an emoji is two surrogates that PHP decodes fine.
    expect(roundTrip("ok 😀")).toBe("ok 😀");
  });

  test("refuses a value with no JSON form instead of failing obscurely", () => {
    // `JSON.stringify` returns `undefined` here, which would otherwise blow up inside `Buffer.from`
    // with a message naming neither the caller nor the value.
    expect(() => phpLiteral(undefined)).toThrow(/no JSON form/);
    expect(() => phpLiteral(() => 1)).toThrow(/no JSON form/);
    expect(() => phpLiteral(Symbol("s"))).toThrow(/no JSON form/);
  });
});

/**
 * `evalPhp`'s argv, through a stub `wp` that records every argument it was given: WP-CLI reads global
 * flags only before the subcommand, and anything after the snippet would be handed to `eval`.
 */
test.describe("evalPhp's command", () => {
  let binDir: string;
  let pathBefore: string;

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-php-argv-"));
    // Answers the `--user` check (its marked line) as an administrator's.
    writeFileSync(
      join(binDir, "wp"),
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${join(binDir, "argv")}"\n` +
        `case "$*" in *e2e-wp-user:*) printf '\\ne2e-wp-user:{"numeric":false,"admin":true}\\n' ;; esac\n`,
    );
    resetWpUserCaches();
    chmodSync(join(binDir, "wp"), 0o755);
    pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
  });

  test.afterEach(() => {
    process.env.PATH = pathBefore;
    rmSync(binDir, { recursive: true, force: true });
    resetWpUserCaches();
  });

  /** The arguments the stub was last given. */
  const argv = (): string[] =>
    readFileSync(join(binDir, "argv"), "utf8").split("\0").slice(0, -1);

  for (const [options, flags] of [
    [{}, []],
    [{ skipPlugins: true }, ["--skip-plugins"]],
    [{ skipThemes: true }, ["--skip-themes"]],
    [
      { skipPlugins: true, skipThemes: true },
      ["--skip-plugins", "--skip-themes"],
    ],
  ] as const) {
    test(`leads with ${flags.join(" ") || "no flag"}, then eval and the snippet, nothing after`, async () => {
      const local = { mode: "local", rootDir: binDir } as const;
      await evalPhp(local, "echo 1;", "probing", "wp/php", options);
      expect(argv()).toEqual([...flags, "eval", "echo 1;"]);
    });
  }

  test("without WordPress: eval, the snippet, --skip-wordpress — never --user, even once an admin was found", async () => {
    const local = { mode: "local", rootDir: binDir, wpUser: "admin" } as const;
    await evalPhp(local, "echo 1;", "probing");
    // The check found an administrator: a booting eval carries the login.
    expect(argv()).toEqual(["--user=admin", "eval", "echo 1;"]);
    await evalPhp(local, "echo 1;", "probing", "wp/php", {
      skipWordPress: true,
    });
    expect(argv()).toEqual(["eval", "echo 1;", "--skip-wordpress"]);
  });

  for (const skip of [
    { skipPlugins: true },
    { skipThemes: true },
    { skipPlugins: true, skipThemes: true },
  ] as const) {
    test(`without WordPress, ${Object.keys(skip).join(" and ")} is refused before any command`, async () => {
      const local = { mode: "local", rootDir: binDir } as const;
      await expect(
        evalPhp(local, "echo 1;", "probing", "wp/php", {
          skipWordPress: true,
          ...skip,
        }),
      ).rejects.toThrow(
        "[wp/php] probing: --skip-wordpress loads no plugin or theme to skip.",
      );
      expect(existsSync(join(binDir, "argv"))).toBe(false);
    });
  }
});
