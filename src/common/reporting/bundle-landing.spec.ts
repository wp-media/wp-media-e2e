import { test, expect } from "@playwright/test";

import {
  FACTS_LIMIT,
  formatDuration,
  landingPage,
  parseLandingFacts,
  type LandingFacts,
} from "./bundle-landing";
import type { BundledReport } from "./bundle-manifest";

/** The Cucumber report, present. */
const CUCUMBER: BundledReport = {
  kind: "cucumber",
  present: true,
  href: "cucumber/index.html",
  pages: [],
};

/** Every report present, Playwright with its serve note. */
const PRESENT: BundledReport[] = [
  {
    kind: "playwright",
    present: true,
    href: "playwright/index.html",
    pages: [],
    serve: {
      why: "Needs HTTP.",
      command: "npx playwright show-report playwright",
    },
  },
  CUCUMBER,
  {
    kind: "allure",
    present: true,
    href: "allure/index.html",
    pages: [{ label: "Awesome", href: "allure/awesome/index.html" }],
  },
];

const FACTS: LandingFacts = {
  title: "backwpup · pro@nginx · BackWPup Pro 9.99.99",
  product: "backwpup",
  cell: "pro@nginx",
  runId: "2026-10-22T10-04-03-625Z-26885",
  status: "passed",
  startedAt: "2026-10-22T10:04:07.747Z",
  durationMs: 1522042,
};

test.describe("parseLandingFacts", () => {
  test("keeps only the whitelisted fields, each one plain line", () => {
    const text = JSON.stringify({
      title: "a\nb\u001b[31m red",
      product: "backwpup",
      cell: "pro@nginx",
      status: "failed",
      durationMs: 1000,
      cells: [{ sites: [{ baseURL: "https://example.test" }] }],
      secret: "hidden",
    });

    expect(parseLandingFacts(text)).toEqual({
      title: "a b red",
      product: "backwpup",
      cell: "pro@nginx",
      status: "failed",
      durationMs: 1000,
    });
  });

  test("masks a credential a value quotes, and cuts a long one", () => {
    const facts = parseLandingFacts(
      JSON.stringify({
        title: "nav to https://admin:hunter2pass@site.test/ failed",
        runName: "x".repeat(1000),
      }),
    );

    expect(facts?.title).not.toContain("hunter2pass");
    expect(facts?.title).toContain("***");
    expect(facts?.runName).toHaveLength(300);
  });

  test("anything but a JSON object, or a wrong type, is no fact", () => {
    for (const text of [undefined, "", "{", "[]", "null", '"x"']) {
      expect(parseLandingFacts(text), String(text)).toBeUndefined();
    }
    expect(
      parseLandingFacts(
        JSON.stringify({
          title: 5,
          durationMs: -1,
          status: "   ",
          cell: ["x"],
        }),
      ),
    ).toEqual({});
    expect(parseLandingFacts(JSON.stringify({ durationMs: "5" }))).toEqual({});
  });

  test("reads at most about 256 kB", () => {
    expect(FACTS_LIMIT).toBe(262144);
  });
});

test("formatDuration: as a person reads it", () => {
  expect(formatDuration(840)).toBe("840 ms");
  expect(formatDuration(1000)).toBe("1 s");
  // Rounded, never cut: 1.5 s reads as 2 s.
  expect(formatDuration(1500)).toBe("2 s");
  expect(formatDuration(59_400)).toBe("59 s");
  expect(formatDuration(1_522_042)).toBe("25 min 22 s");
  expect(formatDuration(3_780_000)).toBe("1 h 3 min");
});

test.describe("landingPage", () => {
  test("is a static, self-contained document: no script, no external asset, a CSP forbidding both", () => {
    const html = landingPage({ name: "n", facts: FACTS, reports: PRESENT });

    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(html).not.toMatch(/<script|<img|<link|@import|url\(/i);
    expect(html).not.toMatch(/(?:src|href)="(?:https?:)?\/\//);
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">`,
    );
    expect(html).toContain('<meta name="color-scheme" content="light dark">');
    // A link followed from the page tells the next site nothing about it.
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
    expect(html).toContain("@media (prefers-color-scheme:dark)");
  });

  test("links every present report and its pages, with the serve command", () => {
    const html = landingPage({ name: "n", facts: FACTS, reports: PRESENT });

    expect(html).toContain(
      '<a class="report" href="playwright/index.html">Playwright</a>',
    );
    expect(html).toContain(
      '<a class="report" href="cucumber/index.html">Cucumber</a>',
    );
    expect(html).toContain(
      '<a class="report" href="allure/index.html">Allure</a>',
    );
    expect(html).toContain('<a href="allure/awesome/index.html">Awesome</a>');
    expect(html).toContain(
      "Needs HTTP. Serve it with <code>npx playwright show-report playwright</code>.",
    );
    expect(html).toContain('<a href="run-facts.json">run-facts.json</a>');
  });

  test("says plainly what is missing and why", () => {
    const html = landingPage({
      name: "n",
      facts: FACTS,
      reports: [
        {
          kind: "playwright",
          present: false,
          reason: "the run did not write it",
        },
        CUCUMBER,
        {
          kind: "allure",
          present: false,
          reason: "allure generate failed (exit code 1)",
        },
      ],
    });

    expect(html).toContain(
      '<li class="missing"><p><span class="report">Playwright</span> — not in this bundle: the run did not write it.</p></li>',
    );
    expect(html).toContain(
      "Allure</span> — not in this bundle: allure generate failed (exit code 1).",
    );
    expect(html).not.toContain('href="playwright/index.html"');
  });

  test("escapes every value: facts, name, reasons", () => {
    const evil = `<img src=x onerror="alert(1)"> & 'q'`;
    const html = landingPage({
      name: evil,
      facts: {
        ...FACTS,
        title: evil,
        product: evil,
        status: evil,
        runName: evil,
      },
      reports: [{ kind: "allure", present: false, reason: evil }],
    });

    expect(html).not.toContain("<img");
    expect(html).toContain(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;q&#39;",
    );
  });

  test("the status in words, toned; a killed run's 'running' said as such", () => {
    const page = (status: string | undefined) =>
      landingPage({ name: "n", facts: { ...FACTS, status }, reports: [] });

    expect(page("passed")).toContain('<p class="status good">Passed</p>');
    expect(page("failed")).toContain('<p class="status bad">Failed</p>');
    expect(page("could-not-test")).toContain(
      '<p class="status bad">Could not test</p>',
    );
    expect(page("stopped")).toContain('<p class="status neutral">Stopped</p>');
    expect(page("running")).toContain("No end recorded: the run was killed");
    expect(page("odd")).toContain('<p class="status neutral">odd</p>');
    expect(page(undefined)).toContain(
      '<p class="status neutral">Status unknown</p>',
    );
  });

  test("the run's facts as a list; without facts, the name heads the page and says so", () => {
    const html = landingPage({ name: "n", facts: FACTS, reports: [] });
    expect(html).toContain("<h1>backwpup · pro@nginx</h1>");
    expect(html).toContain(
      "<dt>Run ID</dt><dd>2026-10-22T10-04-03-625Z-26885</dd>",
    );
    expect(html).toContain("<dt>Duration</dt><dd>25 min 22 s</dd>");
    expect(html).not.toContain("<dt>Ended</dt>");

    const bare = landingPage({
      name: "bundle-name",
      facts: undefined,
      reports: [],
    });
    expect(bare).toContain("<h1>bundle-name</h1>");
    expect(bare).toContain("No run facts");
    expect(bare).not.toContain('href="run-facts.json"');
    expect(bare).toContain("<title>Run report · bundle-name</title>");
  });
});
