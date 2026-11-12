import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

import {
  LOGIN_SHELL_CHECK,
  LOGIN_SHELL_PROBE,
  isKnownNonPosix,
  judgeRoundTrip,
  loginShellCheck,
  shellFromPasswd,
} from "./login-shell";
import { shellQuote } from "../wp/exec";

/** The login-shell gate's pure parts: the verdict on a round-trip, the shell's name. */

test.describe("LOGIN_SHELL_PROBE", () => {
  test("holds every character a non-POSIX shell reads differently, and no trailing newline", () => {
    for (const char of ["!", "\n", "\\\\", "$", "`", "'", '"']) {
      expect(LOGIN_SHELL_PROBE).toContain(char);
    }
    expect(LOGIN_SHELL_PROBE.endsWith("\n")).toBe(false);
  });

  // The exec layer's quoting through a real POSIX sh gives it back byte for byte.
  test("comes back unchanged through the exec layer's quoting and a POSIX sh", () => {
    const line = `printf '%s' ${shellQuote(LOGIN_SHELL_PROBE)}`;
    expect(execFileSync("/bin/sh", ["-c", line], { encoding: "utf8" })).toBe(
      LOGIN_SHELL_PROBE,
    );
  });
});

test.describe("loginShellCheck", () => {
  test("passes the probe back unchanged", () => {
    expect(
      loginShellCheck({ exitCode: 0, stdout: LOGIN_SHELL_PROBE, stderr: "" }),
    ).toEqual({
      name: LOGIN_SHELL_CHECK,
      ok: true,
      detail: "Command lines reach programs unchanged (a POSIX login shell).",
    });
  });

  test("fails a changed string, naming a known non-POSIX shell", () => {
    const check = loginShellCheck(
      {
        exitCode: 0,
        stdout: LOGIN_SHELL_PROBE.replace("\\\\", "\\"),
        stderr: "",
      },
      "/usr/bin/fish",
    );
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(
      "The SSH user's login shell does not pass command lines through unchanged: a quoted test " +
        "string came back changed. The login shell is /usr/bin/fish, which is not POSIX.",
    );
    expect(check.hint).toContain("chsh -s /bin/bash");
  });

  test("fails a refused string (csh's `Event not found`), with or without the shell's name", () => {
    const refused = { exitCode: 1, stdout: "", stderr: "a: Event not found." };
    expect(loginShellCheck(refused, "/bin/tcsh").detail).toMatch(
      /refused \(exit 1\)\. The login shell is \/bin\/tcsh, which is not POSIX\.$/,
    );
    expect(loginShellCheck(refused).detail).toMatch(/refused \(exit 1\)\.$/);
    // A shell not on the list is named, never judged.
    expect(loginShellCheck(refused, "/bin/ksh").detail).toMatch(
      /The login shell is \/bin\/ksh\.$/,
    );
  });

  test("a round-trip that threw fails as unchecked, quoting the error, never blaming the shell", () => {
    const check = loginShellCheck({ error: "connection reset" }, "/bin/tcsh");
    expect(check.ok).toBe(false);
    expect(check.detail).toBe(
      "The SSH user's login shell could not be checked: connection reset.",
    );
    expect(check.hint).toBe(
      "The connection failed during this check; run again once the site answers.",
    );
  });

  test("the probe whole with text around it: a startup file printing, a gate that never blames the shell", () => {
    for (const [stdout, where] of [
      [`Welcome!\n${LOGIN_SHELL_PROBE}`, "before"],
      [`${LOGIN_SHELL_PROBE}bye`, "after"],
      [`hi${LOGIN_SHELL_PROBE}bye`, "around"],
    ] as const) {
      expect(judgeRoundTrip({ exitCode: 0, stdout, stderr: "" })).toEqual({
        kind: "stray-output",
        where,
      });
      const check = loginShellCheck(
        { exitCode: 0, stdout, stderr: "" },
        "/bin/bash",
      );
      expect(check.ok).toBe(false);
      expect(check.detail).toBe(
        `The SSH user's shell prints text ${where} each command's output (a shell startup file): ` +
          "commands reach programs unchanged, but their output is read with that text in it.",
      );
      expect(check.detail).not.toContain("POSIX");
      expect(check.hint).toContain("~/.bashrc");
    }
  });

  test("judgeRoundTrip: a refusal is a change even when the probe came back; a changed probe is a change", () => {
    expect(
      judgeRoundTrip({ exitCode: 1, stdout: LOGIN_SHELL_PROBE, stderr: "" }),
    ).toEqual({
      kind: "changed",
      said: "a quoted test string was refused (exit 1)",
    });
    expect(
      judgeRoundTrip({ exitCode: 0, stdout: "e2e!a\\b", stderr: "" }),
    ).toEqual({
      kind: "changed",
      said: "a quoted test string came back changed",
    });
    expect(
      judgeRoundTrip({ exitCode: 0, stdout: LOGIN_SHELL_PROBE, stderr: "x" }),
    ).toEqual({ kind: "unchanged" });
  });

  test("an exit 0 with the right output only passes: stderr does not matter, stdout does", () => {
    expect(
      loginShellCheck({
        exitCode: 0,
        stdout: LOGIN_SHELL_PROBE,
        stderr: "motd",
      }).ok,
    ).toBe(true);
    expect(
      loginShellCheck({
        exitCode: 0,
        stdout: `${LOGIN_SHELL_PROBE}x`,
        stderr: "",
      }).ok,
    ).toBe(false);
    expect(
      loginShellCheck({ exitCode: 2, stdout: LOGIN_SHELL_PROBE, stderr: "" })
        .ok,
    ).toBe(false);
  });
});

test.describe("shellFromPasswd / isKnownNonPosix", () => {
  test("reads the seventh field of the first line", () => {
    expect(
      shellFromPasswd("ubuntu:x:1000:1000:Ubuntu:/home/ubuntu:/bin/bash\n"),
    ).toBe("/bin/bash");
    expect(shellFromPasswd("u:x:1:1::/h:/usr/bin/tcsh\r\nother")).toBe(
      "/usr/bin/tcsh",
    );
  });

  test("no seventh field, or an empty one, names no shell", () => {
    expect(shellFromPasswd("")).toBeUndefined();
    expect(shellFromPasswd("u:x:1:1::/h")).toBeUndefined();
    expect(shellFromPasswd("u:x:1:1::/h:")).toBeUndefined();
  });

  test("csh, tcsh and fish by their base name; POSIX shells are not flagged", () => {
    for (const shell of [
      "/bin/csh",
      "/usr/bin/tcsh",
      "/usr/local/bin/fish",
      "fish",
    ]) {
      expect(isKnownNonPosix(shell)).toBe(true);
    }
    for (const shell of [
      "/bin/bash",
      "/bin/sh",
      "/usr/bin/dash",
      "/bin/zsh",
      "/bin/fishy",
    ]) {
      expect(isKnownNonPosix(shell)).toBe(false);
    }
  });
});
