import { test, expect } from "@playwright/test";

import { createPalette, TEXT_PALETTE } from "../terminal/palette";
import type { Palette } from "../terminal/palette";
import type { WarmedBuild, WarmSummary, WarmUnit } from "./warm";
import {
  nothingToWarmLine,
  RULE_WIDTH,
  usageErrorLine,
  warmFooter,
  warmHeaderLines,
  warmResultLines,
  warmWarningLines,
} from "./warm-lines";

/**
 * The artifact warm's output with fake summaries: the lines `warm-artifacts.ts` prints, exactly, as
 * plain text, and what a coloured or ASCII palette changes.
 */

/** The escape character, built rather than written into a pattern. */
const ESC = String.fromCharCode(27);
const COLOUR = createPalette({ tty: true, color: true, unicode: true });
const ASCII = createPalette({ tty: false, color: false, unicode: false });

const UNIT = { label: "backwpup/pro@nginx" } as WarmUnit;

/** A build APVM warmed, pinned to a commit. */
const BUILD = {
  fromCache: true,
  pin: { ref: "commit:abc", version: "5.0.0" },
} as WarmedBuild;

/** A summary with one of everything: a warning, a skip, a warm, a failed warm, a failed plan. */
const MIXED: WarmSummary = {
  warnings: ["E2E_PREVIOUS_REF ignored"],
  skipped: [{ label: "wp-rocket/nginx", role: "plugin", rawPath: "/z.zip" }],
  results: [
    {
      params: { project: "backwpup", gitRef: "develop", variants: ["pro-en"] },
      wantedBy: ["backwpup/pro@nginx"],
      ok: true,
      build: BUILD,
    },
    {
      params: { project: "wp-rocket", gitRef: "main" },
      wantedBy: ["wp-rocket/apache"],
      ok: false,
      error: "no such ref",
    },
  ],
  planFailures: [{ label: "imagify/nginx", error: "bad manifest" }],
  ok: false,
};

test("the header names the cells and the skipped ones", () => {
  const rule = "─".repeat(RULE_WIDTH);
  expect(
    warmHeaderLines(
      [UNIT],
      [{ product: "wp-rocket", cell: "nginx" }],
      TEXT_PALETTE,
    ),
  ).toEqual([
    rule,
    "  wp-media-e2e — Warm plugin artifacts",
    rule,
    "  Priming APVM's cache for 1 cell(s): backwpup/pro@nginx.",
    "  ⚠ wp-rocket/nginx — skipped (placeholder-only, will not run)",
    "",
  ]);
  expect(warmHeaderLines([], [], TEXT_PALETTE)[3]).toBe(
    "  Priming APVM's cache for 0 cell(s): (none).",
  );
});

test("warnings, results, skips and plan failures, exactly", () => {
  expect(warmWarningLines(MIXED, TEXT_PALETTE)).toEqual([
    "  ⚠ E2E_PREVIOUS_REF ignored",
  ]);
  expect(warmResultLines(MIXED, TEXT_PALETTE)).toEqual([
    "  • wp-rocket/nginx plugin: provided zip (/z.zip) — nothing to warm.",
    "  ✓ backwpup develop [pro-en] — already cached (backwpup/pro@nginx)",
    "      pin: ref commit:abc, version 5.0.0",
    "  ✗ wp-rocket main (wp-rocket/apache)",
    "      no such ref",
    "  ✗ imagify/nginx — could not plan",
    "      bad manifest",
  ]);
});

test("what APVM, git, the planner or an operator wrote is printed safe, line by line", () => {
  const BEL = String.fromCharCode(7);
  const TOKEN = "ghp_16CharsOrMoreAAAA";
  const split = `${TOKEN.slice(0, 6)}\u200b${TOKEN.slice(6)}`;
  const hostile: WarmSummary = {
    warnings: [`E2E_PLUGIN_REF ${ESC}[2Jignored\n  see ${split}`],
    skipped: [
      { label: "wp-rocket/nginx", role: "plugin", rawPath: `/z${ESC}[2J.zip` },
    ],
    results: [
      {
        params: { project: "backwpup", gitRef: `dev${ESC}[2J` },
        wantedBy: ["backwpup/pro@nginx"],
        ok: false,
        error: `fatal: https://x-access-token:${TOKEN}@github.com ${ESC}]52;c;eA==${BEL}\n  at clone`,
      },
    ],
    planFailures: [{ label: "imagify/nginx", error: `bad ${split}` }],
    ok: false,
  };
  expect(warmWarningLines(hostile, TEXT_PALETTE)).toEqual([
    "  ⚠ E2E_PLUGIN_REF ignored",
    "      see ***",
  ]);
  expect(warmResultLines(hostile, TEXT_PALETTE)).toEqual([
    "  • wp-rocket/nginx plugin: provided zip (/z.zip) — nothing to warm.",
    "  ✗ backwpup dev (backwpup/pro@nginx)",
    "      fatal: https://***@github.com",
    "        at clone",
    "  ✗ imagify/nginx — could not plan",
    "      bad ***",
  ]);
});

test("a fresh warm and a release pin say so", () => {
  const summary: WarmSummary = {
    ...MIXED,
    skipped: [],
    planFailures: [],
    results: [
      {
        params: { project: "backwpup", gitRef: "v5" },
        wantedBy: ["a"],
        ok: true,
        build: { ...BUILD, fromCache: false, pin: { ref: "release:v5" } },
      },
    ],
  };
  expect(warmResultLines(summary, TEXT_PALETTE)).toEqual([
    "  ✓ backwpup v5 — warmed (a)",
    "      pin: ref release:v5 (no version: a release's is its tag)",
  ]);
});

test("the footer: a failed warm exits 1, a primed cache 0", () => {
  const rule = "─".repeat(RULE_WIDTH);
  expect(warmFooter(MIXED, TEXT_PALETTE)).toEqual({
    lines: [
      "",
      rule,
      "  2 warm request(s) failed; 1 succeeded. See details above.",
    ],
    exitCode: 1,
  });
  expect(
    warmFooter(
      {
        ...MIXED,
        planFailures: [],
        results: MIXED.results.slice(0, 1),
        ok: true,
      },
      TEXT_PALETTE,
    ),
  ).toEqual({
    lines: ["", rule, "  1 request(s) warmed. Cache is primed."],
    exitCode: 0,
  });
});

test("the nothing-to-warm and usage-error lines", () => {
  expect(nothingToWarmLine(TEXT_PALETTE)).toBe(
    "  Nothing to warm — every matched cell is placeholder/example data only, so no run will use it.",
  );
  expect(
    usageErrorLine('unknown --cell "x".', " Known cells: a.", TEXT_PALETTE),
  ).toBe('[artifacts:warm] unknown --cell "x". Known cells: a.');
  expect(usageErrorLine("bad.", " detail", COLOUR)).toBe(
    `${ESC}[1m${ESC}[31m[artifacts:warm] bad.${ESC}[39m${ESC}[22m detail`,
  );
});

test.describe("palettes", () => {
  /** Every line the warm prints for these summaries. */
  function everything(palette: Palette): string[] {
    return [
      ...warmHeaderLines([UNIT], [{ product: "p", cell: "c" }], palette),
      ...warmWarningLines(MIXED, palette),
      ...warmResultLines(MIXED, palette),
      ...warmFooter(MIXED, palette).lines,
      ...warmFooter({ ...MIXED, ok: true }, palette).lines,
      nothingToWarmLine(palette),
      usageErrorLine("m", " d", palette),
    ];
  }

  test("plain text holds no escape", () => {
    for (const line of everything(TEXT_PALETTE))
      expect(line).not.toContain(ESC);
  });

  test("ASCII holds nothing but printable ASCII", () => {
    for (const line of everything(ASCII))
      expect(line).toMatch(/^[\x20-\x7e]*$/);
  });

  test("colour styles only around the plain text", () => {
    const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const coloured = everything(COLOUR);
    expect(coloured.some((line) => line.includes(ESC))).toBe(true);
    expect(coloured.map((line) => line.replace(sgr, ""))).toEqual(
      everything(TEXT_PALETTE),
    );
  });
});
