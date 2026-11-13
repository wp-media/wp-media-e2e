import { test, expect } from "@playwright/test";

import { parseSudoListing } from "./sudo-listing";

/**
 * `sudo -n -l` read for `log_allowed`, on outputs measured on the twins (Ubuntu 24.04, sudo 1.9.15p5,
 * `LC_ALL=C`): the `site` variant's rule with `Defaults:ubuntu !log_allowed`, `owner-mismatch`'s without
 * it, a `Defaults>` runas entry printed beside a `Defaults!` one on the same line, and the refusals.
 */

/** The rules block every successful listing ends with. */
const RULES = [
  "",
  "User ubuntu may run the following commands on a28d835f3c5c:",
  "    (ALL : ALL) ALL",
  "    (ALL) NOPASSWD: ALL",
].join("\n");

/**
 * A listing whose `Matching Defaults` line is `defaults`.
 *
 * @param defaults - the entries, as sudo prints them.
 * @param extra - blocks printed between the defaults and the rules.
 */
const listing = (defaults: string, extra = ""): string =>
  [
    "Matching Defaults entries for ubuntu on a28d835f3c5c:",
    `    ${defaults}`,
    extra,
  ]
    .filter((line) => line !== "")
    .join("\n") + `\n${RULES}`;

/** Ubuntu's own defaults, with the twins' `logfile`. */
const BASE =
  "env_reset, mail_badpass, secure_path=/usr/local/sbin\\:/usr/local/bin\\:/usr/sbin\\:/usr/bin\\:/sbin\\:/bin\\:/snap/bin, use_pty, logfile=/var/log/sudo-twin.log";

/**
 * A successful run's result.
 *
 * @param stdout - its output.
 */
const ok = (
  stdout: string,
): { exitCode: number; stdout: string; stderr: string } => ({
  exitCode: 0,
  stdout,
  stderr: "",
});

test.describe("parseSudoListing", () => {
  test("!log_allowed among the matching defaults: sudo does not log command lines", () => {
    expect(
      parseSudoListing(ok(listing(`${BASE}, !log_allowed`)), ["www-data"]),
    ).toEqual({ kind: "listed", logAllowed: false });
  });

  test("no log_allowed entry: sudo's default, it logs", () => {
    expect(parseSudoListing(ok(listing(BASE)), ["www-data"])).toEqual({
      kind: "listed",
      logAllowed: true,
    });
  });

  test("no matching defaults block at all: sudo's default, it logs", () => {
    expect(parseSudoListing(ok(RULES.trimStart()), [])).toEqual({
      kind: "listed",
      logAllowed: true,
    });
  });

  test("the later of two entries wins, as in sudoers", () => {
    expect(
      parseSudoListing(ok(listing(`!log_allowed, ${BASE}, log_allowed`)), []),
    ).toEqual({ kind: "listed", logAllowed: true });
    expect(
      parseSudoListing(ok(listing(`log_allowed, ${BASE}, !log_allowed`)), []),
    ).toEqual({ kind: "listed", logAllowed: false });
  });

  test("defaults over several indented lines are all read", () => {
    const stdout =
      "Matching Defaults entries for ubuntu on h:\n" +
      `    ${BASE},\n` +
      "    !log_allowed\n" +
      RULES;
    expect(parseSudoListing(ok(stdout), [])).toEqual({
      kind: "listed",
      logAllowed: false,
    });
  });

  test("an entry whose value only contains the words is not the flag", () => {
    expect(
      parseSudoListing(
        ok(
          listing(
            `${BASE}, lecture_file=/etc/!log_allowed, logfile=x\\,!log_allowed`,
          ),
        ),
        [],
      ),
    ).toEqual({ kind: "listed", logAllowed: true });
  });

  test("a runas entry naming the identity applies on top, read from a line sudo shares with another entry", () => {
    const runas =
      "\nRunas and Command-specific defaults for ubuntu:\n" +
      "    Defaults>www-data log_allowed    Defaults!/usr/bin/id !log_allowed";
    const stdout = listing(`${BASE}, !log_allowed`, runas);
    expect(parseSudoListing(ok(stdout), ["www-data"])).toEqual({
      kind: "listed",
      logAllowed: true,
    });
    // Another identity: the entry is not its, and the command-specific one never applies.
    expect(parseSudoListing(ok(stdout), ["nginx"])).toEqual({
      kind: "listed",
      logAllowed: false,
    });
  });

  test("a runas entry for ALL, or listing the identity among others, applies; by #uid too", () => {
    const runas = (users: string): string =>
      `\nRunas and Command-specific defaults for ubuntu:\n    Defaults>${users} !log_allowed`;
    for (const users of ["ALL", "root,www-data", "#33"]) {
      expect(
        parseSudoListing(ok(listing(BASE, runas(users))), ["www-data", "#33"]),
      ).toEqual({ kind: "listed", logAllowed: false });
    }
    expect(
      parseSudoListing(ok(listing(BASE, runas("root"))), ["www-data"]),
    ).toEqual({
      kind: "listed",
      logAllowed: true,
    });
  });

  test("a listing never carries what sudo lists: only the flag", () => {
    const parsed = parseSudoListing(ok(listing(`${BASE}, !log_allowed`)), []);
    expect(Object.keys(parsed).sort()).toEqual(["kind", "logAllowed"]);
  });

  test("sudo refusing (no rule, or not a sudoer) is a refusal", () => {
    for (const stderr of [
      "sudo: a password is required\n",
      "Sorry, user nobody may not run sudo on a28d835f3c5c.\n",
      "sudo: unable to resolve host x: Name or service not known\nsudo: a password is required",
    ]) {
      expect(parseSudoListing({ exitCode: 1, stdout: "", stderr }, [])).toEqual(
        {
          kind: "refused",
        },
      );
    }
  });

  test("anything else is unreadable: no sudo, another exit, other words, a translated listing", () => {
    const cases = [
      {
        exitCode: 127,
        stdout: "",
        stderr: "env: 'sudo': No such file or directory",
      },
      { exitCode: 1, stdout: "", stderr: "" },
      // A refusal's words under another exit code: not sudo's refusal (a wrapper, a crash).
      { exitCode: 127, stdout: "", stderr: "sudo: a password is required\n" },
      { exitCode: 1, stdout: "", stderr: "env: something else\n" },
      ok(""),
      ok("Einträge für ubuntu auf h:\n    env_reset, !log_allowed\n"),
    ];
    for (const result of cases) {
      expect(parseSudoListing(result, [])).toEqual({ kind: "unreadable" });
    }
  });

  test("sudo's unresolvable-host line decides nothing: alone it is no refusal, beside a listing it changes none", () => {
    const noise =
      "sudo: unable to resolve host web1: Temporary failure in name resolution";
    expect(
      parseSudoListing({ exitCode: 1, stdout: "", stderr: noise }, []),
    ).toEqual({ kind: "unreadable" });
    expect(
      parseSudoListing(
        { exitCode: 1, stdout: "", stderr: `${noise}\nenv: something else` },
        [],
      ),
    ).toEqual({ kind: "unreadable" });
    expect(
      parseSudoListing(
        {
          ...ok(listing(`${BASE}, !log_allowed`)),
          stderr: `${noise}\n`,
        },
        [],
      ),
    ).toEqual({ kind: "listed", logAllowed: false });
  });

  test("CRLF line ends read as LF", () => {
    expect(
      parseSudoListing(
        ok(listing(`${BASE}, !log_allowed`).replace(/\n/g, "\r\n")),
        [],
      ),
    ).toEqual({ kind: "listed", logAllowed: false });
  });
});
