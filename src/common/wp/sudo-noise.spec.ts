import { test, expect } from "@playwright/test";

import { hasSudoNoise, withoutSudoNoise } from "./sudo-noise";

/**
 * sudo's unresolvable-host line: removed only from sudo's own leading `sudo:` lines, in every form
 * sudo 1.9.15 prints it (measured on Ubuntu 24.04), and nothing else ever touched.
 */

/** The line with an unknown name (no entry, the resolver says so). */
const UNKNOWN = "sudo: unable to resolve host web1: Name or service not known";

/** The line when no resolver answered (none reachable, or none configured). */
const NO_ANSWER =
  "sudo: unable to resolve host web1: Temporary failure in name resolution";

/** The line as older sudo versions print it, without the resolver's reason. */
const BARE = "sudo: unable to resolve host web1";

test("each form of the line, alone, leaves nothing", () => {
  for (const noise of [UNKNOWN, NO_ANSWER, BARE, `${UNKNOWN}\r`]) {
    expect(withoutSudoNoise(noise)).toBe("");
    expect(withoutSudoNoise(`${noise}\n`)).toBe("");
    expect(hasSudoNoise(noise)).toBe(true);
  }
});

test("what follows the line is kept byte for byte: the program's errors, sudo's refusal, CRLF, blanks", () => {
  const rest = "ls: cannot access '/x': No such file\r\n\n  indented\n";
  expect(withoutSudoNoise(`${UNKNOWN}\n${rest}`)).toBe(rest);
  expect(withoutSudoNoise(`${UNKNOWN}\nsudo: a password is required`)).toBe(
    "sudo: a password is required",
  );
  expect(
    withoutSudoNoise(
      `${NO_ANSWER}\nSorry, user u is not allowed to execute 'x' as root on web1.`,
    ),
  ).toBe("Sorry, user u is not allowed to execute 'x' as root on web1.");
});

test("among sudo's leading lines every host line goes, its other warnings stay in order", () => {
  // Measured: a world-writable sudo.conf is warned about (twice) before the host line.
  const stderr = [
    "sudo: /etc/sudo.conf is world writable",
    "sudo: /etc/sudo.conf is world writable",
    UNKNOWN,
    `${UNKNOWN}\r`,
    "sudo: a password is required",
  ].join("\n");
  expect(withoutSudoNoise(stderr)).toBe(
    [
      "sudo: /etc/sudo.conf is world writable",
      "sudo: /etc/sudo.conf is world writable",
      "sudo: a password is required",
    ].join("\n"),
  );
  expect(hasSudoNoise(stderr)).toBe(true);
});

test("the same text after the program's first line is the program's own: kept, and not noise", () => {
  for (const stderr of [
    `Warning: real\n${UNKNOWN}`,
    `\n${UNKNOWN}`,
    `${UNKNOWN}\nWarning: real\n${NO_ANSWER}`,
  ]) {
    const kept = stderr.startsWith(UNKNOWN)
      ? stderr.slice(UNKNOWN.length + 1)
      : stderr;
    expect(withoutSudoNoise(stderr)).toBe(kept);
  }
  expect(hasSudoNoise(`Warning: real\n${UNKNOWN}`)).toBe(false);
});

test("nothing else is touched: other text, a quoted or partial line, an empty stderr", () => {
  for (const stderr of [
    "",
    "\n",
    "sudo: a password is required",
    "Warning: sudo: unable to resolve host web1",
    " sudo: unable to resolve host web1",
    "sudo: unable to resolve host ",
    "sudo: unable to resolve hostname web1",
    "SUDO: unable to resolve host web1",
    "Error: not installed\n",
  ]) {
    expect(withoutSudoNoise(stderr)).toBe(stderr);
    expect(hasSudoNoise(stderr)).toBe(false);
  }
});
