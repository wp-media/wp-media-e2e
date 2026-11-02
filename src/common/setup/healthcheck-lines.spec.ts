import { test, expect } from "@playwright/test";

import { createPalette, TEXT_PALETTE } from "../terminal/palette";
import {
  headerLines,
  productHeaderLines,
  productTallyLine,
  RULE_WIDTH,
  siteResultLines,
  skipLine,
  summaryLines,
} from "./healthcheck-lines";
import type { PlanView, SiteResult } from "./healthcheck-lines";

/**
 * The fleet healthcheck's output with fake results: the lines `healthcheck.ts` prints, exactly, in
 * each palette — plain (a file or pipe: `healthcheck > fleet.log`), coloured (a terminal) and ASCII
 * (`E2E_OUTPUT=plain`, a dumb terminal, a C locale).
 */

/** The escape character, built rather than written into a pattern. */
const ESC = String.fromCharCode(27);
const COLOUR = createPalette({ tty: true, color: true, unicode: true });
const ASCII = createPalette({ tty: false, color: false, unicode: false });

/** One site's result; passing unless a case says otherwise. */
function result(overrides: Partial<SiteResult> = {}): SiteResult {
  return {
    product: "backwpup",
    cell: "pro@nginx",
    index: 0,
    baseURL: "https://admin:pw-0001@bwu.test",
    transport: { mode: "local", rootDir: "/var/www/bwu" },
    checks: [{ name: "WordPress login", ok: true, detail: "Logged in." }],
    durationMs: 1234,
    ok: true,
    ...overrides,
  };
}

const FAILED = result({
  index: 1,
  ok: false,
  checks: [
    { name: "rootDir", ok: true, detail: "exists" },
    { name: "WP-CLI", ok: false, detail: "missing", hint: "Install it" },
  ],
});

const PLANS: readonly PlanView[] = [
  {
    product: "wp-rocket",
    tasks: [],
    skips: [{ product: "wp-rocket", cell: "nginx", reason: "placeholder" }],
  },
  {
    product: "backwpup",
    tasks: [
      { product: "backwpup", cell: "pro@nginx" },
      { product: "backwpup", cell: "pro@nginx" },
    ],
    skips: [],
  },
];

test.describe("plain text (a file or a pipe)", () => {
  test("the header", () => {
    const rule = "─".repeat(RULE_WIDTH);
    expect(headerLines(PLANS, TEXT_PALETTE)).toEqual([
      rule,
      "  wp-media-e2e — Health Check",
      rule,
      "  Preflight (transport + WordPress) and login checks across 2 site(s) in 1 cell(s), 2 product(s).",
      "",
    ]);
  });

  test("a product's divider fills to the rule's width", () => {
    const [divider, blank] = productHeaderLines("backwpup", 1, TEXT_PALETTE);
    expect(divider).toBe(`── backwpup ${"─".repeat(RULE_WIDTH - 12)}`);
    expect(divider).toHaveLength(RULE_WIDTH);
    expect(blank).toBe("");
  });

  test("a skipped cell", () => {
    expect(skipLine(PLANS[0]?.skips[0] ?? fail(), TEXT_PALETTE)).toBe(
      "  ⚠ wp-rocket/nginx — skipped: placeholder",
    );
  });

  test("a passing and a failing site, credentials masked", () => {
    expect(siteResultLines(result(), TEXT_PALETTE)).toEqual([
      "  ✔ backwpup/pro@nginx · site[0] https://***@bwu.test [local: /var/www/bwu] · 1/1 checks (1.2s)",
      "      ✓ WordPress login: Logged in.",
      "",
    ]);
    expect(siteResultLines(FAILED, TEXT_PALETTE)).toEqual([
      "  ✘ backwpup/pro@nginx · site[1] https://***@bwu.test [local: /var/www/bwu] · 1/2 checks (1.2s)",
      "      ✓ rootDir: exists",
      "      ✗ WP-CLI: missing",
      "        → Install it",
      "",
    ]);
  });

  test("a product's tally: nothing checked, all passed, some failed", () => {
    const [skipped, checked] = PLANS as [PlanView, PlanView];
    expect(productTallyLine(skipped, [], TEXT_PALETTE)).toBe(
      "  wp-rocket: no real sites to check (1 cell(s) skipped)",
    );
    expect(productTallyLine(checked, [result()], TEXT_PALETTE)).toBe(
      "  backwpup: 1/1 site(s) passed",
    );
    expect(productTallyLine(checked, [result(), FAILED], TEXT_PALETTE)).toBe(
      "  backwpup: 1 failed, 1/2 passed",
    );
  });

  test("the summary: per product, the totals, the verdict", () => {
    const rule = "─".repeat(RULE_WIDTH);
    expect(
      summaryLines(PLANS, [result(), FAILED], 5_000, TEXT_PALETTE),
    ).toEqual([
      rule,
      "  Summary",
      rule,
      "  ⚠ wp-rocket  0/0 site(s) passed · 1 cell(s) skipped",
      "  ✘ backwpup   1/2 site(s) passed",
      "",
      "  1 passed, 1 failed, 1 skipped — 5.0s total",
      "",
      "  1 of 2 site(s) failed. See details above.",
      "",
    ]);
  });

  test("the verdict when all passed, and when nothing real was configured", () => {
    expect(summaryLines(PLANS, [result()], 0, TEXT_PALETTE)).toContain(
      "  All 1 checked site(s) are healthy.",
    );
    const none = summaryLines(PLANS, [], 0, TEXT_PALETTE);
    expect(none).toContain(
      "  No real sites were configured to check (placeholder/example data only).",
    );
    expect(none).toContain("  ⚠ backwpup   0/0 site(s) passed");
  });
});

test.describe("palettes", () => {
  /** Every line the healthcheck can print for these results. */
  function everything(palette: typeof COLOUR): string[] {
    const [skipped, checked] = PLANS as [PlanView, PlanView];
    return [
      ...headerLines(PLANS, palette),
      ...productHeaderLines("backwpup", 0, palette),
      skipLine(skipped.skips[0] ?? fail(), palette),
      ...siteResultLines(result(), palette),
      ...siteResultLines(FAILED, palette),
      productTallyLine(checked, [result(), FAILED], palette),
      productTallyLine(checked, [result()], palette),
      productTallyLine(skipped, [], palette),
      ...summaryLines(PLANS, [result(), FAILED], 1, palette),
      ...summaryLines(PLANS, [result()], 1, palette),
      ...summaryLines(PLANS, [], 1, palette),
    ];
  }

  test("plain text holds no escape (healthcheck > fleet.log)", () => {
    for (const line of everything(TEXT_PALETTE)) {
      expect(line).not.toContain(ESC);
    }
  });

  test("ASCII holds nothing but printable ASCII", () => {
    for (const line of everything(ASCII)) {
      expect(line).toMatch(/^[\x20-\x7e]*$/);
    }
  });

  test("colour styles only around the plain text: removing SGR gives the plain lines back", () => {
    const sgr = new RegExp(`${ESC}\\[[0-9;]*m`, "g");
    const coloured = everything(COLOUR);
    expect(coloured.some((line) => line.includes(ESC))).toBe(true);
    expect(coloured.map((line) => line.replace(sgr, ""))).toEqual(
      everything(TEXT_PALETTE),
    );
  });

  test("colour: a failed site's mark bold red, its label bold; the header bold cyan", () => {
    expect(siteResultLines(FAILED, COLOUR)[0]).toMatch(
      new RegExp(
        `^ {2}${ESC}\\[1m${ESC}\\[31m✘${ESC}\\[39m${ESC}\\[22m ${ESC}\\[1mbackwpup/`,
      ),
    );
    expect(headerLines(PLANS, COLOUR)[1]).toBe(
      `${ESC}[1m${ESC}[36m  wp-media-e2e — Health Check${ESC}[39m${ESC}[22m`,
    );
  });
});

test.describe("what a site or a tool wrote is printed safe", () => {
  const BEL = String.fromCharCode(7);
  const TOKEN = "ghp_16CharsOrMoreAAAA";

  test("a check's detail and hint, the address and the transport: no escape, no control, credentials masked", () => {
    const hostile = result({
      ok: false,
      baseURL: `https://bwu.test/${ESC}[2J`,
      transport: {
        mode: "local",
        rootDir: `/var/www/${ESC}]52;c;eA==${BEL}bwu`,
      },
      checks: [
        {
          name: "WordPress",
          ok: false,
          detail: `could not boot (exit 255): ${ESC}[2J${TOKEN.slice(0, 6)}\u200b${TOKEN.slice(6)}\n  in /x.php`,
          hint: `Fix it\n${ESC}]52;c;cHduZWQ=${BEL}then rerun`,
        },
      ],
    });
    expect(siteResultLines(hostile, TEXT_PALETTE)).toEqual([
      "  ✘ backwpup/pro@nginx · site[0] https://bwu.test/ [local: /var/www/bwu] · 0/1 checks (1.2s)",
      "      ✗ WordPress: could not boot (exit 255): ***",
      "          in /x.php",
      "        → Fix it",
      "        → then rerun",
      "",
    ]);
  });
});

test.describe("each colour and count", () => {
  const [skipped, checked] = PLANS as [PlanView, PlanView];

  test("a product's tally names its skipped cells beside its results", () => {
    const withSkip: PlanView = { ...checked, skips: skipped.skips };
    expect(productTallyLine(withSkip, [result()], TEXT_PALETTE)).toBe(
      "  backwpup: 1/1 site(s) passed, 1 cell(s) skipped",
    );
    expect(productTallyLine(withSkip, [result(), FAILED], TEXT_PALETTE)).toBe(
      "  backwpup: 1 failed, 1/2 passed, 1 cell(s) skipped",
    );
  });

  test("the first product's divider takes the series' second colour (the header has its first)", () => {
    expect(productHeaderLines("backwpup", 0, COLOUR)[0]).toBe(
      `${ESC}[1m${ESC}[35m── backwpup ${"─".repeat(RULE_WIDTH - 12)}${ESC}[39m${ESC}[22m`,
    );
  });

  test("the summary: a nothing-checked mark bold yellow, a failed one bold red, the failed total bold red", () => {
    const lines = summaryLines(PLANS, [result(), FAILED], 0, COLOUR);
    expect(lines[3]).toBe(
      `  ${ESC}[1m${ESC}[33m⚠${ESC}[39m${ESC}[22m ${ESC}[1mwp-rocket${ESC}[22m  0/0 site(s) passed · 1 cell(s) skipped`,
    );
    expect(lines[4]).toBe(
      `  ${ESC}[1m${ESC}[31m✘${ESC}[39m${ESC}[22m ${ESC}[1mbackwpup ${ESC}[22m  1/2 site(s) passed`,
    );
    expect(lines[6]).toBe(
      `  ${ESC}[1m${ESC}[32m1${ESC}[39m${ESC}[22m passed, ${ESC}[1m${ESC}[31m1${ESC}[39m${ESC}[22m failed, ` +
        `${ESC}[1m${ESC}[33m1${ESC}[39m${ESC}[22m skipped ${ESC}[2m— 0.0s total${ESC}[22m`,
    );
  });
});

/** Fails a test whose fixture is missing what it needs. */
function fail(): never {
  throw new Error("fixture incomplete");
}
