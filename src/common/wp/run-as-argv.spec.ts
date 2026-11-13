import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec } from "./exec";
import {
  RUN_AS_NAME,
  RUN_AS_SCRIPT,
  quotesSudoDenial,
  isSudoName,
  isSudoRefusal,
  runAsArgv,
  sudoName,
} from "./run-as-argv";
import { removeTempDir } from "../__fixtures__/temp-dir";

/**
 * The `sudo` + wrapper argv every site command will run through: its exact shape, what it refuses,
 * and — run by a real `/bin/sh` — that the wrapper sets the umask, enters the directory and hands the
 * command its arguments unchanged.
 */

const WWW = { user: "www-data", group: "www-data" };

test("runAsArgv builds sudo, the constant wrapper named e2e-run-as, then umask, directory and command as arguments", () => {
  expect(
    runAsArgv(WWW, "0022", "/var/www/html", "wp", ["--info", "a b"]),
  ).toEqual([
    "sudo",
    "-n",
    "-u",
    "www-data",
    "-g",
    "www-data",
    "--",
    "/bin/sh",
    "-c",
    'umask "$1" && cd -- "$2" && shift 2 && exec "$@"',
    "e2e-run-as",
    "0022",
    "/var/www/html",
    "wp",
    "--info",
    "a b",
  ]);
});

test("a numeric user or group is given to sudo as #id, a name as it is", () => {
  const argv = runAsArgv(
    { user: "33", group: "www data" },
    "0002",
    "/r",
    "id",
    [],
  );

  expect(argv.slice(0, 7)).toEqual([
    "sudo",
    "-n",
    "-u",
    "#33",
    "-g",
    "www data",
    "--",
  ]);
  expect(sudoName("0033")).toBe("#0033");
  expect(sudoName("www-data")).toBe("www-data");
});

for (const [label, name] of [
  ["empty", ""],
  ["an option", "-x"],
  ["already an id", "#33"],
  ["a colon", "a:b"],
  ["a newline", "a\nb"],
  ["a NUL", "a\u0000b"],
] as const) {
  test(`a name that is ${label} is refused, never quoted`, () => {
    expect(isSudoName(name)).toBe(false);
    expect(() => sudoName(name)).toThrow(/a text of \d+ characters/);
    expect(() =>
      runAsArgv({ user: "u", group: name }, "0022", "/r", "id", []),
    ).toThrow(/\[wp\/run-as\]/);
  });
}

for (const [label, umask, cwd, file] of [
  ["a three-digit umask", "022", "/r", "id"],
  ["a non-octal umask", "0028", "/r", "id"],
  ["a relative directory", "0022", "r", "id"],
  ["an empty directory", "0022", "", "id"],
  ["a program starting with -", "0022", "/r", "-id"],
] as const) {
  test(`runAsArgv refuses ${label}`, () => {
    expect(() => runAsArgv(WWW, umask, cwd, file, ["--key=SECRET"])).toThrow(
      /\[wp\/run-as\]/,
    );
    try {
      runAsArgv(WWW, umask, cwd, file, ["--key=SECRET"]);
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
    }
  });
}

test.describe("the wrapper, run by /bin/sh", () => {
  let dir = "";

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "run-as-"));
  });

  test.afterEach(() => {
    removeTempDir(dir);
  });

  /**
   * Runs `file args…` through the wrapper only (sudo's part dropped), locally.
   *
   * @param umask - the umask passed.
   * @param cwd - the directory passed.
   * @param file - the program.
   * @param args - its arguments.
   */
  const wrapped = (
    umask: string,
    cwd: string,
    file: string,
    args: string[],
  ) => {
    const argv = runAsArgv(WWW, umask, cwd, file, args).slice(7);
    const local = { mode: "local", rootDir: dir } as const;
    return exec(local, argv[0] ?? "", argv.slice(1), { cwd: "/" });
  };

  test("sets the umask it is given, whatever the caller's", async () => {
    for (const umask of ["0022", "0002", "0077"]) {
      const result = await wrapped(umask, dir, "sh", ["-c", "umask"]);
      expect(result.stdout).toBe(umask);
    }
  });

  test("enters the directory, and hands every argument over unchanged", async () => {
    const hostile = [
      "",
      "a b",
      "$(id)",
      "`id`",
      "'\"",
      "--key=a b",
      "-n",
      "--",
      "x\ny",
    ];
    const result = await wrapped("0022", dir, "sh", [
      "-c",
      'pwd -P; for a in "$@"; do printf "[%s]" "$a"; done',
      "sh",
      ...hostile,
    ]);

    expect(result.exitCode).toBe(0);
    const pwd = result.stdout.split("\n", 1)[0] ?? "";
    expect(pwd).toBe(realpathSync(dir));
    expect(result.stdout.slice(pwd.length + 1)).toBe(
      hostile.map((arg) => `[${arg}]`).join(""),
    );
  });

  test("runs nothing when the directory cannot be entered, the shell's error naming the wrapper", async () => {
    const marker = join(dir, "ran");
    const result = await wrapped("0022", join(dir, "missing"), "touch", [
      marker,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/missing/);
    // dash: `e2e-run-as: 1: cd: can't cd to …`; bash: `e2e-run-as: line 1: cd: …`.
    expect(result.stderr.startsWith(`${RUN_AS_NAME}: `)).toBe(true);
    await expect(
      exec({ mode: "local", rootDir: dir }, "test", ["-e", marker]),
    ).resolves.toMatchObject({
      exitCode: 1,
    });
  });

  test("the script is the constant RUN_AS_SCRIPT, its $0 the constant RUN_AS_NAME", () => {
    const argv = runAsArgv(WWW, "0022", "/r", "x", []);
    expect(argv[9]).toBe(RUN_AS_SCRIPT);
    expect(argv[10]).toBe(RUN_AS_NAME);
  });
});

test.describe("isSudoRefusal", () => {
  const noise = "sudo: unable to resolve host twin: Name or service not known";
  /** sudo 1.9.15p5's explicit deny (rule `ALL, !/bin/sh`), as captured, host replaced. */
  const denied = `Sorry, user bob is not allowed to execute '/bin/sh -c ${RUN_AS_SCRIPT} e2e-run-as 0022 / wp --key=SECRET a\nb it's' as www-data:www-data on host.example.\n`;
  for (const [label, stderr] of [
    ["an explicit deny, its quoted arguments over two lines", denied],
    ["an explicit deny after the hostname noise", `${noise}\n${denied}`],
    [
      "an explicit deny on one line, CRLF",
      "Sorry, user bob is not allowed to execute '/bin/sh -c x' as www-data:www-data on host.example.\r\n",
    ],
    ["a sudo line, then an explicit deny", `sudo: x\n${denied}`],
    ["no rule", "sudo: a password is required"],
    ["after the hostname noise", `${noise}\nsudo: a password is required`],
    [
      "a rule naming other users",
      "sudo: sorry, user ubuntu is not allowed to execute '/bin/sh -c x' as www-data:deploy on twin.",
    ],
    [
      "an unknown account, two lines, CRLF",
      "sudo: unknown user nobody2\r\nsudo: error initializing audit plugin sudoers_audit\r\n",
    ],
  ] as const) {
    test(`exit 1 and only sudo's lines: refused (${label})`, () => {
      expect(isSudoRefusal({ exitCode: 1, stderr })).toBe(true);
    });
  }

  for (const [label, exitCode, stderr] of [
    ["another exit", 2, "sudo: a password is required"],
    ["the program's own exit 1, silent", 1, ""],
    ["only the hostname noise", 1, noise],
    ["the program's words after sudo's", 1, "sudo: x\nError: not installed"],
    ["the wrapper's failure", 1, "e2e-run-as: 1: cd: can't cd to /x"],
    [
      "a sudo line not at a line start",
      1,
      "Error: sudo: a password is required",
    ],
    ["an explicit deny with another exit", 2, denied],
    ["an explicit deny, then the program's words", 1, `${denied}Error: x`],
    [
      "a deny's opening the program printed, never finished",
      1,
      "Sorry, user bob is not allowed to execute 'x'",
    ],
  ] as const) {
    test(`not a refusal: ${label}`, () => {
      expect(isSudoRefusal({ exitCode, stderr })).toBe(false);
    });
  }
});

test("quotesSudoDenial: sudo's explicit deny on any line, either spelling; nothing else", () => {
  for (const stderr of [
    "Sorry, user bob is not allowed to execute 'wp --key=S' as www-data:www-data on h.",
    "sudo: x\nsudo: sorry, user bob is not allowed to execute 'wp' as root on h.",
  ]) {
    expect(quotesSudoDenial(stderr)).toBe(true);
  }
  for (const stderr of [
    "sudo: a password is required",
    "Error: Sorry, user bob is not allowed to execute 'wp'",
    "Sorry, user bob may not run this",
  ]) {
    expect(quotesSudoDenial(stderr)).toBe(false);
  }
});
