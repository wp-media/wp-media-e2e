import { test, expect } from "@playwright/test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exec } from "./exec";
import {
  RUN_AS_NAME,
  RUN_AS_SCRIPT,
  hasSudoNoise,
  isSudoName,
  runAsArgv,
  sudoName,
  withoutSudoNoise,
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

test("sudo's unresolvable-host lines are removed from stderr, every other line kept", () => {
  const stderr = [
    "sudo: unable to resolve host twin: Name or service not known",
    "Warning: something real",
    "sudo: unable to resolve host twin: Name or service not known\r",
    "sudo: a password is required",
  ].join("\n");

  expect(withoutSudoNoise(stderr)).toBe(
    "Warning: something real\nsudo: a password is required",
  );
  expect(hasSudoNoise(stderr)).toBe(true);
  expect(hasSudoNoise("sudo: a password is required")).toBe(false);
  expect(withoutSudoNoise("")).toBe("");
});

test("only a whole line of sudo's noise counts: CRLF ends one, text before it is not noise", () => {
  const crlf = "sudo: unable to resolve host twin: Name or service not known\r";
  expect(hasSudoNoise(crlf)).toBe(true);
  expect(withoutSudoNoise(`${crlf}\nreal`)).toBe("real");
  const quoted = "Warning: sudo: unable to resolve host twin";
  expect(hasSudoNoise(quoted)).toBe(false);
  expect(withoutSudoNoise(quoted)).toBe(quoted);
});
