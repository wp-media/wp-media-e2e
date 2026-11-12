import { test, expect } from "@playwright/test";

import { createPalette, TEXT_PALETTE } from "../terminal/palette";
import { checkLines } from "./check-lines";
import type { CheckResult } from "./preflight";

/** The escape character, built rather than written into a pattern. */
const ESC = String.fromCharCode(27);

const PASS: CheckResult = { name: "SSH", ok: true, detail: "connected" };
const FAIL: CheckResult = {
  name: "WP-CLI",
  ok: false,
  detail: "not found",
  hint: "Install WP-CLI\nor put it on PATH",
};

test("a pass, a failure and its hint lines, exactly, as plain text", () => {
  expect(checkLines([PASS, FAIL], "    ", TEXT_PALETTE)).toEqual([
    "    ✓ SSH: connected",
    "    ✗ WP-CLI: not found",
    "      → Install WP-CLI",
    "      → or put it on PATH",
  ]);
});

test("a failure without a hint is one line, and no checks are no lines", () => {
  expect(
    checkLines([{ name: "x", ok: false, detail: "y" }], "", TEXT_PALETTE),
  ).toEqual(["✗ x: y"]);
  expect(checkLines([], "  ", TEXT_PALETTE)).toEqual([]);
});

test("a hint is never shown under a pass", () => {
  expect(
    checkLines([{ ...PASS, hint: "never shown" }], "", TEXT_PALETTE),
  ).toEqual(["✓ SSH: connected"]);
});

test("colour on: the marks in their status colours, a failed check's name bold, the arrow yellow", () => {
  const palette = createPalette({ tty: true, color: true, unicode: true });
  expect(checkLines([PASS, FAIL], "", palette)).toEqual([
    `${ESC}[32m✓${ESC}[39m SSH: connected`,
    `${ESC}[31m✗${ESC}[39m ${ESC}[1mWP-CLI${ESC}[22m: not found`,
    `  ${ESC}[33m→${ESC}[39m Install WP-CLI`,
    `  ${ESC}[33m→${ESC}[39m or put it on PATH`,
  ]);
});

test("ASCII symbols: plain mode, a dumb terminal or a C locale", () => {
  const palette = createPalette({ tty: false, color: false, unicode: false });
  expect(checkLines([PASS, FAIL], "", palette)).toEqual([
    "ok SSH: connected",
    "x WP-CLI: not found",
    "  -> Install WP-CLI",
    "  -> or put it on PATH",
  ]);
});

/** What a site or a tool may print into a check: an OSC 52 clipboard write, a screen clear, a token. */
const BEL = String.fromCharCode(7);
const TOKEN = "ghp_16CharsOrMoreAAAA";
const HOSTILE: CheckResult = {
  name: "WordPress",
  ok: false,
  detail: `PHP Fatal ${ESC}]52;c;cHduZWQ=${BEL}${ESC}[2J${TOKEN}\n  in /x.php`,
  hint: `Check it\n\t${TOKEN.slice(0, 8)}\u200b${TOKEN.slice(8)} leaked`,
};

test("printed: each detail and hint line is plain and masked, a detail's further lines indented under it", () => {
  expect(checkLines([HOSTILE], "  ", TEXT_PALETTE, "printed")).toEqual([
    "  ✗ WordPress: PHP Fatal ***",
    "      in /x.php",
    "    → Check it",
    "    →  *** leaked",
  ]);
});

test("printed: a pass's detail is made safe too", () => {
  expect(
    checkLines(
      [{ name: "WP-CLI", ok: true, detail: `${ESC}[2J2.11 ${TOKEN}` }],
      "",
      TEXT_PALETTE,
      "printed",
    ),
  ).toEqual(["✓ WP-CLI: 2.11 ***"]);
});

test("a report keeps a detail and hint as written: its reader cleans them", () => {
  expect(checkLines([HOSTILE], "", TEXT_PALETTE)).toEqual([
    `✗ WordPress: ${HOSTILE.detail}`,
    "  → Check it",
    `  → \t${TOKEN.slice(0, 8)}\u200b${TOKEN.slice(8)} leaked`,
  ]);
});

test("a passing check carrying a warning is marked as one, never as a failure; a failed one stays failed", () => {
  const warned: CheckResult = {
    name: "Site identity",
    ok: true,
    detail: "fallback",
    warning: true,
  };
  expect(checkLines([warned], "  ", TEXT_PALETTE)).toEqual([
    "  ⚠ Site identity: fallback",
  ]);
  expect(checkLines([{ ...FAIL, warning: true }], "  ", TEXT_PALETTE)[0]).toBe(
    "  ✗ WP-CLI: not found",
  );
  const ascii = createPalette({ tty: false, color: false, unicode: false });
  expect(checkLines([warned], "", ascii)).toEqual([
    "! Site identity: fallback",
  ]);
});
