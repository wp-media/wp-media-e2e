import { test, expect } from "@playwright/test";

import {
  RECHECK_AFTER_MS,
  classifyWpUserCheck,
  forgetWpUser,
  isUnknownUserError,
  resetWpUserCaches,
  shouldUseWpUser,
  withWpUser,
  wpUserCheckArgs,
  wpUserKey,
} from "./wp-user";
import type { ExecResult } from "./transport-exec";
import type { IdentityState } from "./site-identity";
import type { SshTransport } from "../config/types";

/**
 * The `--user` check's pure parts (its arguments, verdicts, WP-CLI's exact refusal, plain or
 * coloured) and its memo: verdicts kept per install, runner and login; an unknown answer or a
 * mid-process refusal waits {@link RECHECK_AFTER_MS} before the next check; a thrown check is never
 * kept; a warning once per key and reason that never names the login.
 */

/** A login no message may contain; shaped to need escaping anywhere it is embedded. */
const LOGIN = `o'b"$(id)\\n`;

const SITE = {
  mode: "ssh",
  host: "203.0.113.7",
  username: "ubuntu",
  privateKeyPath: "/nonexistent/key",
  rootDir: "/var/www/site",
} as const satisfies SshTransport;

const SITE_STATE: IdentityState = {
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

const DISABLED: IdentityState = { kind: "disabled", reason: "config" };

/**
 * A result.
 *
 * @param exitCode - its exit.
 * @param stdout - its output.
 * @param stderr - its errors.
 */
const result = (exitCode: number, stdout = "", stderr = ""): ExecResult => ({
  exitCode,
  stdout,
  stderr,
});

/**
 * The check's answer.
 *
 * @param user - what the marked line reports (`numeric`, `admin`).
 */
const found = (user: unknown): ExecResult =>
  result(0, `\ne2e-wp-user:${JSON.stringify(user)}\n`);

/** SGR escapes as WP-CLI colours a label (`%R…%n`, measured on 2.12 with `--color`). */
const RED = "\u001b[31;1m";
const RESET = "\u001b[0m";

/** A settable clock. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 1_000_000;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

/** WP-CLI's exact refusal of `login`, after PHP 8.5's deprecation lines (measured on the twins). */
const refusal = (login: string): ExecResult =>
  result(
    1,
    "",
    "Deprecated: Using null as an array offset is deprecated in phar:///usr/local/bin/wp/Colors.php on line 95\n" +
      `Error: Invalid user ID, email or login: '${login}'`,
  );

/** Warnings printed while `work` runs. */
async function warningsDuring(work: () => Promise<unknown>): Promise<string[]> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    console.warn = original;
  }
  return warnings;
}

test.beforeEach(() => {
  resetWpUserCaches();
});

test.describe("arguments", () => {
  test("--user=<login> leads the arguments, which are kept as given", () => {
    expect(withWpUser(LOGIN, ["eval", "echo 1;"])).toEqual([
      `--user=${LOGIN}`,
      "eval",
      "echo 1;",
    ]);
  });

  test("the check skips plugins and theme, carries no --user, and embeds the login only as a literal", () => {
    const args = wpUserCheckArgs(LOGIN);
    expect(args.slice(0, 3)).toEqual([
      "--skip-plugins",
      "--skip-themes",
      "eval",
    ]);
    expect(args).toHaveLength(4);
    expect(args.some((arg) => arg.startsWith("--user"))).toBe(false);
    const php = args[3] ?? "";
    // The login base64-embedded, never as source; WP-CLI's own lookup, the one `--user` runs.
    expect(php).toContain("$e2e_login = json_decode( base64_decode( '");
    expect(php).not.toContain(LOGIN);
    const encoded = /base64_decode\( '([^']*)' \)/.exec(php)?.[1] ?? "";
    expect(JSON.parse(Buffer.from(encoded, "base64").toString("utf8"))).toBe(
      LOGIN,
    );
    expect(php).toContain(
      "( new \\WP_CLI\\Fetchers\\User() )->get_check( $e2e_login );",
    );
    expect(php).toContain("'numeric' => is_numeric( $e2e_login )");
    expect(php).toContain("'admin' => user_can( $e2e_user, 'manage_options' )");
    // The marked line starts on a line of its own (PHP's "\n"), whatever WordPress printed before.
    expect(php).toContain('echo "\\ne2e-wp-user:", wp_json_encode(');
  });
});

test.describe("isUnknownUserError: WP-CLI's exact refusal of that login", () => {
  test("after other lines, or alone, with LF or CRLF", () => {
    expect(isUnknownUserError(refusal(LOGIN), LOGIN)).toBe(true);
    expect(
      isUnknownUserError(
        result(1, "", `Error: Invalid user ID, email or login: '${LOGIN}'\r\n`),
        LOGIN,
      ),
    ).toBe(true);
    // The fetcher's message under WP_CLI_FORCE_USER_LOGIN.
    expect(
      isUnknownUserError(
        result(1, "", `Error: Invalid user login: '${LOGIN}'`),
        LOGIN,
      ),
    ).toBe(true);
  });

  test("coloured by WP-CLI's `color: true`: the same refusal", () => {
    const coloured = (login: string): ExecResult =>
      result(
        1,
        "",
        `${RED}Deprecated:${RESET} noise\n${RED}Error:${RESET} Invalid user ID, email or login: '${login}'\n`,
      );
    expect(isUnknownUserError(coloured(LOGIN), LOGIN)).toBe(true);
    expect(isUnknownUserError(coloured("bob"), LOGIN)).toBe(false);
  });

  test("a login holding an escape sequence: compared with escapes removed on both sides", () => {
    const login = "a\u001b[0mb";
    expect(
      isUnknownUserError(
        result(
          1,
          "",
          `${RED}Error:${RESET} Invalid user ID, email or login: '${login}'`,
        ),
        login,
      ),
    ).toBe(true);
  });

  test("a login holding a newline is still matched whole", () => {
    const login = "two\nlines";
    expect(isUnknownUserError(refusal(login), login)).toBe(true);
  });

  test("not another login's refusal, not a partial line, not another exit", () => {
    expect(isUnknownUserError(refusal("bob"), LOGIN)).toBe(false);
    expect(isUnknownUserError(refusal(`${LOGIN}x`), LOGIN)).toBe(false);
    expect(
      isUnknownUserError(
        result(
          1,
          "",
          `Warning: Error: Invalid user ID, email or login: '${LOGIN}'`,
        ),
        LOGIN,
      ),
    ).toBe(false);
    expect(
      isUnknownUserError(
        result(
          1,
          "",
          `Error: Invalid user ID, email or login: '${LOGIN}' (retry)`,
        ),
        LOGIN,
      ),
    ).toBe(false);
    expect(isUnknownUserError({ ...refusal(LOGIN), exitCode: 0 }, LOGIN)).toBe(
      false,
    );
    expect(
      isUnknownUserError({ ...refusal(LOGIN), exitCode: 255 }, LOGIN),
    ).toBe(false);
    // On stdout it is the command's own output, not WP-CLI's refusal.
    expect(
      isUnknownUserError(
        result(1, `Error: Invalid user ID, email or login: '${LOGIN}'`),
        LOGIN,
      ),
    ).toBe(false);
  });
});

test.describe("classifyWpUserCheck", () => {
  const admin = { numeric: false, admin: true };

  test("an administrator: use, whatever the login's case or accents (the lookup decided)", () => {
    // `get_check` already resolved the login as `--user` will: the database's collation, not ours.
    for (const login of ["admin", "ADMİN", "José", "a  b", "QA@Example.Test"]) {
      expect(classifyWpUserCheck(found(admin), login), login).toEqual({
        kind: "use",
      });
    }
  });

  test("a numeric login: drop/numeric, even when it names an administrator", () => {
    expect(
      classifyWpUserCheck(found({ ...admin, numeric: true }), "1"),
    ).toEqual({ kind: "drop", reason: "numeric" });
    expect(
      classifyWpUserCheck(found({ numeric: true, admin: false }), "7"),
    ).toEqual({ kind: "drop", reason: "numeric" });
  });

  test("not an administrator: drop/not-admin", () => {
    expect(
      classifyWpUserCheck(found({ ...admin, admin: false }), "admin"),
    ).toEqual({ kind: "drop", reason: "not-admin" });
  });

  test("WP-CLI's exact refusal, plain or coloured: drop/missing", () => {
    expect(classifyWpUserCheck(refusal(LOGIN), LOGIN)).toEqual({
      kind: "drop",
      reason: "missing",
    });
    expect(
      classifyWpUserCheck(
        result(
          1,
          "",
          `${RED}Error:${RESET} Invalid user ID, email or login: '${LOGIN}'`,
        ),
        LOGIN,
      ),
    ).toEqual({ kind: "drop", reason: "missing" });
  });

  test("the last marked line counts, after anything WordPress printed", () => {
    const stdout = `e2e-wp-user:${JSON.stringify({ ...admin, admin: false })}\nnotice\ne2e-wp-user:${JSON.stringify(admin)}\n`;
    expect(classifyWpUserCheck(result(0, stdout), "admin")).toEqual({
      kind: "use",
    });
  });

  test("only a line starting with the mark: one carrying it after other output is not the answer", () => {
    const stdout = `\ne2e-wp-user:${JSON.stringify(admin)}\nnotice e2e-wp-user:${JSON.stringify({ ...admin, admin: false })}`;
    expect(classifyWpUserCheck(result(0, stdout), "admin")).toEqual({
      kind: "use",
    });
  });

  test("unterminated output before the check's leading newline is not its line", () => {
    // What the check's PHP prints after a plugin-less boot that echoed without a newline.
    const stdout = `noise\ne2e-wp-user:${JSON.stringify(admin)}\n`;
    expect(classifyWpUserCheck(result(0, stdout), "admin")).toEqual({
      kind: "use",
    });
  });

  test("a marked line wrapped in terminal escapes is still read", () => {
    const stdout = `${RED}x${RESET}\n${RESET}e2e-wp-user:${JSON.stringify(admin)}${RESET}\n`;
    expect(classifyWpUserCheck(result(0, stdout), "admin")).toEqual({
      kind: "use",
    });
  });

  for (const [label, outcome] of [
    [
      "WordPress not booting",
      result(255, "", "Error: Error establishing a database connection."),
    ],
    [
      "another error at exit 1",
      result(
        1,
        "",
        "Error: This does not seem to be a WordPress installation.",
      ),
    ],
    ["no marked line", result(0, "admin\n")],
    ["a malformed line", result(0, "e2e-wp-user:{nope\n")],
    ["a line of the wrong shape", found({ numeric: "no", admin: true })],
    ["a line without admin", found({ numeric: false })],
    ["a line with a non-boolean admin", found({ numeric: false, admin: 1 })],
    ["null", found(null)],
  ] as const) {
    test(`${label}: unknown`, () => {
      expect(classifyWpUserCheck(outcome, "admin")).toEqual({
        kind: "unknown",
      });
    });
  }
});

test.describe("wpUserKey", () => {
  test("differs by install, runner and login", () => {
    const key = wpUserKey(SITE, SITE_STATE, "admin");
    expect(wpUserKey(SITE, SITE_STATE, "admin")).toBe(key);
    expect(wpUserKey(SITE, DISABLED, "admin")).not.toBe(key);
    expect(
      wpUserKey(
        SITE,
        { ...SITE_STATE, identity: { ...SITE_STATE.identity, uid: 34 } },
        "admin",
      ),
    ).not.toBe(key);
    expect(
      wpUserKey(
        SITE,
        { ...SITE_STATE, identity: { ...SITE_STATE.identity, gid: 34 } },
        "admin",
      ),
    ).not.toBe(key);
    expect(wpUserKey(SITE, SITE_STATE, "editor")).not.toBe(key);
    expect(
      wpUserKey({ ...SITE, rootDir: "/var/www/b" }, SITE_STATE, "admin"),
    ).not.toBe(key);
    // Every state running as the transport's user shares one answer.
    expect(
      wpUserKey(SITE, { kind: "same-user", reason: "transport-user" }, "admin"),
    ).toBe(wpUserKey(SITE, DISABLED, "admin"));
  });
});

test.describe("shouldUseWpUser", () => {
  const KEY = wpUserKey(SITE, SITE_STATE, LOGIN);
  const ADMIN = { numeric: false, admin: true };
  const NOT_BOOTING = result(
    255,
    "",
    "Error: Error establishing a database connection.",
  );

  /**
   * A check runner answering `outcomes` in turn, counting its runs.
   *
   * @param outcomes - its answers; the last repeats.
   */
  function checker(...outcomes: ExecResult[]): {
    run: () => Promise<ExecResult>;
    runs: () => number;
  } {
    let runs = 0;
    return {
      run: () => {
        runs += 1;
        return Promise.resolve(
          outcomes[Math.min(runs, outcomes.length) - 1] ?? result(9),
        );
      },
      runs: () => runs,
    };
  }

  test("use: one check, kept, shared by concurrent callers", async () => {
    const check = checker(found(ADMIN));
    const answers = await Promise.all([
      shouldUseWpUser(SITE, KEY, LOGIN, check.run),
      shouldUseWpUser(SITE, KEY, LOGIN, check.run),
    ]);
    expect(answers).toEqual([true, true]);
    await expect(shouldUseWpUser(SITE, KEY, LOGIN, check.run)).resolves.toBe(
      true,
    );
    expect(check.runs()).toBe(1);
  });

  for (const [reason, outcome, words] of [
    ["missing", refusal(LOGIN), "names no user"],
    ["not-admin", found({ ...ADMIN, admin: false }), "not an administrator"],
    ["numeric", found({ ...ADMIN, numeric: true }), "is numeric"],
  ] as const) {
    test(`drop/${reason}: kept past any wait, warned once, never naming the login`, async () => {
      const clock = fakeClock();
      const check = checker(outcome);
      const warnings = await warningsDuring(async () => {
        await expect(
          shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
        ).resolves.toBe(false);
        clock.advance(RECHECK_AFTER_MS * 10);
        await expect(
          shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
        ).resolves.toBe(false);
      });
      expect(check.runs()).toBe(1);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("[wp/wp-user] ubuntu@203.0.113.7: ");
      expect(warnings[0]).toContain(words);
      expect(warnings[0]).toContain("the site's WordPress login");
      expect(warnings[0]).not.toContain(LOGIN);
      expect(warnings[0]).not.toContain("o'b");
    });
  }

  test("unknown (not booting): no warning; calls skip --user until the wait is over, then one check", async () => {
    const clock = fakeClock();
    const check = checker(NOT_BOOTING, found(ADMIN));
    const warnings = await warningsDuring(async () => {
      await expect(
        shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
      ).resolves.toBe(false);
      clock.advance(RECHECK_AFTER_MS - 1);
      await expect(
        shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
      ).resolves.toBe(false);
      expect(check.runs()).toBe(1);
      clock.advance(1);
      await expect(
        shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
      ).resolves.toBe(true);
    });
    expect(check.runs()).toBe(2);
    expect(warnings).toEqual([]);
  });

  test("unknown again: a new wait from the second answer, then a use clears it for good", async () => {
    const clock = fakeClock();
    const check = checker(NOT_BOOTING, NOT_BOOTING, found(ADMIN));
    const ask = (): Promise<boolean> =>
      shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now);
    await ask();
    clock.advance(RECHECK_AFTER_MS);
    await expect(ask()).resolves.toBe(false);
    clock.advance(RECHECK_AFTER_MS - 1);
    await expect(ask()).resolves.toBe(false);
    expect(check.runs()).toBe(2);
    clock.advance(1);
    await expect(ask()).resolves.toBe(true);
    await expect(ask()).resolves.toBe(true);
    expect(check.runs()).toBe(3);
  });

  test("a thrown check is rethrown and not kept: the next call checks at once", async () => {
    let runs = 0;
    const run = (): Promise<ExecResult> => {
      runs += 1;
      return runs === 1
        ? Promise.reject(new Error("connection reset"))
        : Promise.resolve(found(ADMIN));
    };
    await expect(shouldUseWpUser(SITE, KEY, LOGIN, run)).rejects.toThrow(
      "connection reset",
    );
    await expect(shouldUseWpUser(SITE, KEY, LOGIN, run)).resolves.toBe(true);
    expect(runs).toBe(2);
  });

  test("another runner on the same install checks for itself", async () => {
    const check = checker(found(ADMIN));
    await shouldUseWpUser(SITE, KEY, LOGIN, check.run);
    await shouldUseWpUser(
      SITE,
      wpUserKey(SITE, DISABLED, LOGIN),
      LOGIN,
      check.run,
    );
    expect(check.runs()).toBe(2);
  });

  test("an unknown answer's wait is per key", async () => {
    const clock = fakeClock();
    const check = checker(NOT_BOOTING, found(ADMIN));
    await shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now);
    await expect(
      shouldUseWpUser(
        SITE,
        wpUserKey(SITE, DISABLED, LOGIN),
        LOGIN,
        check.run,
        clock.now,
      ),
    ).resolves.toBe(true);
    expect(check.runs()).toBe(2);
  });

  test("forgetWpUser: calls skip --user without a check until the wait is over, then check once; warned once", async () => {
    const clock = fakeClock();
    const check = checker(found(ADMIN), refusal(LOGIN));
    const ask = (): Promise<boolean> =>
      shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now);
    await ask();
    const warnings = await warningsDuring(async () => {
      forgetWpUser(SITE, KEY, clock.now);
      await expect(ask()).resolves.toBe(false);
      clock.advance(RECHECK_AFTER_MS - 1);
      await expect(ask()).resolves.toBe(false);
      expect(check.runs()).toBe(1);
      clock.advance(1);
      // Still gone: now kept as a drop.
      await expect(ask()).resolves.toBe(false);
      forgetWpUser(SITE, KEY, clock.now);
    });
    expect(check.runs()).toBe(2);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("no longer names a user");
    expect(warnings[0]).toContain("30 s");
    expect(warnings[1]).toContain("names no user");
    for (const warning of warnings) expect(warning).not.toContain(LOGIN);
  });

  test("forgetWpUser, then the login back (a restore finished): --user again after the wait", async () => {
    const clock = fakeClock();
    const check = checker(found(ADMIN));
    const ask = (): Promise<boolean> =>
      shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now);
    await ask();
    await warningsDuring(() => {
      forgetWpUser(SITE, KEY, clock.now);
      return Promise.resolve();
    });
    clock.advance(RECHECK_AFTER_MS);
    await expect(ask()).resolves.toBe(true);
    expect(check.runs()).toBe(2);
  });

  test("a check settling after a refusal does not undo its wait", async () => {
    const clock = fakeClock();
    let settle: (value: ExecResult) => void = () => undefined;
    const pending = shouldUseWpUser(
      SITE,
      KEY,
      LOGIN,
      () => new Promise<ExecResult>((resolve) => (settle = resolve)),
      clock.now,
    );
    await warningsDuring(() => {
      forgetWpUser(SITE, KEY, clock.now);
      return Promise.resolve();
    });
    settle(found(ADMIN));
    await expect(pending).resolves.toBe(true);
    const check = checker(found(ADMIN));
    await expect(
      shouldUseWpUser(SITE, KEY, LOGIN, check.run, clock.now),
    ).resolves.toBe(false);
    expect(check.runs()).toBe(0);
  });

  test("an old check settling unknown never removes a newer one", async () => {
    const clock = fakeClock();
    const settles: ((value: ExecResult) => void)[] = [];
    let runs = 0;
    const run = (): Promise<ExecResult> => {
      runs += 1;
      return new Promise<ExecResult>((resolve) => settles.push(resolve));
    };
    const first = shouldUseWpUser(SITE, KEY, LOGIN, run, clock.now);
    await warningsDuring(() => {
      forgetWpUser(SITE, KEY, clock.now);
      return Promise.resolve();
    });
    clock.advance(RECHECK_AFTER_MS);
    const second = shouldUseWpUser(SITE, KEY, LOGIN, run, clock.now);
    settles[0]?.(NOT_BOOTING);
    await expect(first).resolves.toBe(false);
    // Still shares the second check, in flight.
    const third = shouldUseWpUser(SITE, KEY, LOGIN, run, clock.now);
    settles[1]?.(found(ADMIN));
    await expect(Promise.all([second, third])).resolves.toEqual([true, true]);
    expect(runs).toBe(2);
  });

  test("warnings: once per key and reason, so two keys or two reasons each warn", async () => {
    const other = wpUserKey(SITE, DISABLED, LOGIN);
    const warnings = await warningsDuring(async () => {
      for (const key of [KEY, other]) {
        await shouldUseWpUser(SITE, key, LOGIN, checker(refusal(LOGIN)).run);
        forgetWpUser(SITE, key);
        forgetWpUser(SITE, key);
      }
    });
    expect(warnings.map((w) => w.includes("names no user"))).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(warnings.map((w) => w.includes("no longer names"))).toEqual([
      false,
      true,
      false,
      true,
    ]);
  });
});
