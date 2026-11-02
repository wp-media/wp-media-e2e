import { test, expect } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import type { FullConfig, Suite } from "@playwright/test/reporter";

import {
  addAttempt,
  captureWrites,
  fakeSuite,
  fakeTest,
  jsonAttachment,
  step,
} from "../__fixtures__/reporter-fakes";
import { makeRun, removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  ARTIFACTS_ATTACHMENT,
  SITE_INFO_ATTACHMENT,
} from "../setup/attachments";
import { SYMBOLS } from "../terminal/palette";
import type { Counts } from "./results";
import type { RunDescription } from "./run-description";
import RunSummaryReporter, {
  DEFAULT_LAYOUT,
  describeCounts,
  describePlugin,
  describeSite,
  displayPath,
  formatDuration,
  plain,
  shellWord,
  renderSummary,
  verdictOf,
  type CellFacts,
  type SummaryInput,
  type SummaryLayout,
} from "./run-summary";

/**
 * The end-of-run summary: its verdict, its phrases, its lines, and the reporter that gathers them —
 * printing last, and nothing for `--list`.
 */

const RUN: RunDescription = {
  product: "backwpup",
  cell: "pro@nginx",
  edition: "pro",
  pinned: true,
  runId: "run-1",
  reportCell: "pro@nginx",
  reportDir: "reports/backwpup/pro@nginx/run-1",
  reportPath: "/repo/reports/backwpup/pro@nginx/run-1",
};

/** Counts with these values, the rest zero. */
function counts(values: Partial<Counts>): Counts {
  return {
    total: 0,
    passed: 0,
    failed: 0,
    flaky: 0,
    skipped: 0,
    interrupted: 0,
    didNotRun: 0,
    drained: 0,
    ...values,
  };
}

/** A summary input, passing by default. */
function input(overrides: Partial<SummaryInput> = {}): SummaryInput {
  return {
    run: RUN,
    reportDir: RUN.reportDir,
    status: "passed",
    durationMs: 852_000,
    scenarios: counts({ total: 3, passed: 3 }),
    setupFailures: [],
    cells: new Map(),
    ...overrides,
  };
}

/**
 * Captures what `write` sends to stdout while `body` runs, without colours: whether there are any
 * depends on the terminal the specs run in.
 */
function captureStdout(body: () => void): string {
  return stripVTControlCharacters(captureWrites(process.stdout, body).join(""));
}

test.describe("verdictOf", () => {
  const failure = [
    { project: "setup:x", setup: "auth" as const, message: "no" },
  ];
  const cases: [string, Partial<SummaryInput>, string][] = [
    ["every scenario passed", {}, "passed"],
    [
      "a flaky one still passes",
      { scenarios: counts({ total: 2, passed: 1, flaky: 1 }) },
      "passed",
    ],
    [
      "a scenario failed",
      {
        status: "failed",
        scenarios: counts({ total: 2, failed: 1, passed: 1 }),
      },
      "failed",
    ],
    ["the run timed out", { status: "timedout" }, "failed"],
    ["an error outside any test", { status: "failed" }, "failed"],
    [
      "a setup failed",
      { status: "failed", setupFailures: failure },
      "could-not-test",
    ],
    [
      "interrupted, even with a failed setup",
      { status: "interrupted", setupFailures: failure },
      "interrupted",
    ],
    ["no scenario planned", { scenarios: counts({ total: 0 }) }, "no-tests"],
    [
      "no tests found at all",
      { status: "failed", scenarios: counts({ total: 0 }) },
      "no-tests",
    ],
    [
      "a test file that would not load leaves none planned, and failed",
      {
        status: "failed",
        scenarios: counts({ total: 0 }),
        runErrors: ["Error: a step file does not load"],
      },
      "failed",
    ],
    [
      "the drain skipped what had not begun",
      { scenarios: counts({ total: 3, passed: 1, skipped: 2, drained: 2 }) },
      "stopped",
    ],
    [
      "stopped, a failure before the stop still in the counts",
      {
        status: "failed",
        scenarios: counts({ total: 3, failed: 1, skipped: 2, drained: 2 }),
      },
      "stopped",
    ],
    [
      "interrupted after a drain",
      {
        status: "interrupted",
        scenarios: counts({ total: 3, skipped: 2, drained: 2 }),
      },
      "interrupted",
    ],
    [
      "a test's own skip is no stop",
      { scenarios: counts({ total: 2, passed: 1, skipped: 1 }) },
      "passed",
    ],
  ];
  for (const [name, overrides, expected] of cases) {
    test(`${name} → ${expected}`, () => {
      expect(verdictOf(input(overrides))).toBe(expected);
    });
  }
});

test.describe("the phrases", () => {
  test("formatDuration: seconds, then minutes, then hours", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(42_400)).toBe("42s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(60_000)).toBe("1.0m");
    expect(formatDuration(852_000)).toBe("14.2m");
    expect(formatDuration(3_600_000)).toBe("1.0h");
    expect(formatDuration(8_280_000)).toBe("2.3h");
  });

  test("describeCounts: the drain's skips are said as stopped, apart from a test's own", () => {
    expect(
      describeCounts(counts({ total: 5, passed: 1, skipped: 4, drained: 3 })),
    ).toBe("1 passed · 1 skipped · 3 stopped");
  });

  test("describeCounts: the worst first, zeros left out", () => {
    expect(
      describeCounts(
        counts({
          total: 18,
          failed: 2,
          flaky: 1,
          passed: 11,
          skipped: 1,
          interrupted: 1,
          didNotRun: 2,
        }),
      ),
    ).toBe(
      "2 failed · 1 interrupted · 1 flaky · 11 passed · 1 skipped · 2 did not run",
    );
    expect(describeCounts(counts({}))).toBe("no scenarios ran");
  });

  test("describeCounts: joins with the separator it is given, `·` by default", () => {
    const some = counts({ total: 3, failed: 1, passed: 2 });
    expect(describeCounts(some)).toBe("1 failed · 2 passed");
    expect(describeCounts(some, ".")).toBe("1 failed . 2 passed");
    expect(describeCounts(counts({}), ".")).toBe("no scenarios ran");
  });

  test("describePlugin: a build, a release, a provided zip, a failure", () => {
    expect(
      describePlugin({
        role: "plugin",
        ok: true,
        name: "BackWPup Pro",
        version: "9.99.99",
        ref: "develop",
        commit: "af1ab5c4d2e6f8a0b1c3",
        source: "default-ref",
      }),
    ).toBe("BackWPup Pro 9.99.99 · develop @ af1ab5c4d2");
    expect(
      describePlugin({
        role: "plugin",
        ok: true,
        name: "WP Rocket",
        version: "3.17.4",
        ref: "release:latest-stable",
        pin: "release:3.17.4",
        source: "default-ref",
      }),
    ).toBe("WP Rocket 3.17.4 · release:latest-stable (release:3.17.4)");
    expect(
      describePlugin({
        role: "plugin",
        ok: true,
        name: "BackWPup",
        source: "env-zip",
        zip: "bwu.zip",
      }),
    ).toBe("BackWPup · zip bwu.zip");
    expect(
      describePlugin({ role: "plugin", ok: true, source: "env-zip" }),
    ).toBe("plugin · a provided zip");
    expect(describePlugin({ role: "plugin", ok: true })).toBe("plugin");
    expect(
      describePlugin({
        role: "plugin",
        ok: false,
        error: "resolved: no such ref",
      }),
    ).toBe("resolution failed — resolved: no such ref");
  });

  test("describeSite: URL, WordPress and PHP, or why they are unknown", () => {
    expect(
      describeSite({
        baseURL: "https://bwu3.example",
        versions: { wordpress: "7.1.2", php: "8.5.10", webServer: "nginx" },
      }),
    ).toBe("https://bwu3.example · WordPress 7.1.2 · PHP 8.5.10");
    expect(describeSite({ baseURL: "https://x", versions: {} })).toBe(
      "https://x · WordPress unknown · PHP unknown",
    );
    expect(describeSite({ baseURL: "https://x", error: "timeout" })).toBe(
      "https://x · versions unknown — timeout",
    );
  });

  test("describeSite: the URL by maskSiteUrl — credentials ***@, a baseURL that is no URL never shown", () => {
    expect(
      describeSite({ baseURL: "https://u:pw-0001@x.test/?k=v", versions: {} }),
    ).toBe("https://***@x.test/ · WordPress unknown · PHP unknown");
    expect(
      describeSite({ baseURL: "https://u:pa ss-word9@bad host/", error: "t" }),
    ).toBe("(not a valid http(s) URL) · versions unknown — t");
  });
});

test.describe("plain text, paths and shell words", () => {
  test("plain: escape sequences gone, every other control character a space, one line", () => {
    expect(plain("\u001b[31mred\u001b[0m")).toBe("red");
    // A hyperlink (OSC 8), a bell, a carriage return, a newline, a tab, DEL and a C1 control.
    expect(
      plain(
        "8.5\u001b]8;;https://x.example\u0007link\u001b]8;;\u0007\r\nnext\tline\u007f\u009bend",
      ),
    ).toBe("8.5link next line end");
    expect(plain("  padded  ")).toBe("padded");
  });

  test("displayPath: relative below the working directory, absolute elsewhere", () => {
    expect(displayPath("/repo/reports/a/b", "/repo")).toBe("reports/a/b");
    expect(displayPath("/repo", "/repo")).toBe(".");
    expect(displayPath("/srv/reports/a", "/repo")).toBe("/srv/reports/a");
    expect(displayPath("/repo/reports", "/repo/reports/a")).toBe(
      "/repo/reports",
    );
    expect(displayPath("/repo/..cache/r", "/repo")).toBe("..cache/r");
  });

  test("shellWord: bare when safe, single-quoted otherwise, a quote inside escaped", () => {
    expect(
      shellWord(
        "reports/backwpup/pro@nginx/2026-10-12T00-00-00-000Z-1/playwright",
      ),
    ).toBe("reports/backwpup/pro@nginx/2026-10-12T00-00-00-000Z-1/playwright");
    expect(shellWord("/my reports/x")).toBe("'/my reports/x'");
    expect(shellWord("it's")).toBe("'it'\\''s'");
    expect(shellWord("$(rm -rf ~)")).toBe("'$(rm -rf ~)'");
  });
});

test.describe("renderSummary", () => {
  test("a failed run of one cell: verdict, counts, what was tested, where the reports are", () => {
    const cells = new Map<string, CellFacts>([
      [
        "pro@nginx",
        {
          failed: [],
          plugins: [
            {
              role: "plugin",
              ok: true,
              name: "BackWPup Pro",
              version: "9.99.99",
              ref: "develop",
              commit: "af1ab5c4d2e6f8a0b1c3",
            },
          ],
          sites: [
            {
              baseURL: "https://bwu3.example",
              versions: { wordpress: "7.1.2", php: "8.5.10" },
            },
            { baseURL: "https://bwu4.example", error: "timeout" },
          ],
        },
      ],
    ]);
    const lines = renderSummary(
      input({
        status: "failed",
        scenarios: counts({ total: 3, failed: 2, passed: 1 }),
        cells,
      }),
    );
    expect(lines[0]).toMatch(
      /^━━ backwpup · pro@nginx \(pro\) ━━ ✘ FAILED ━+$/,
    );
    expect(lines[0]).toHaveLength(88);
    expect(lines.slice(1)).toEqual([
      "  Result      2 failed · 1 passed, in 14.2m",
      "  Plugin      BackWPup Pro 9.99.99 · develop @ af1ab5c4d2",
      "  Site        https://bwu3.example · WordPress 7.1.2 · PHP 8.5.10",
      "              https://bwu4.example · versions unknown — timeout",
      "  Playwright  npx playwright show-report reports/backwpup/pro@nginx/run-1/playwright",
      "  Cucumber    reports/backwpup/pro@nginx/run-1/cucumber/index.html",
      "  Allure      npm run report:allure -- backwpup pro@nginx --open",
    ]);
  });

  test("a failed setup: COULD NOT TEST, the setup's error, and the facts it could not give", () => {
    const lines = renderSummary(
      input({
        status: "failed",
        scenarios: counts({ total: 4, didNotRun: 4 }),
        setupFailures: [
          {
            project: "artifacts:pro@nginx",
            setup: "artifacts",
            message: "x".repeat(300),
          },
          {
            project: "setup:pro@nginx",
            setup: "auth",
            message: "Error: [preflight] failed",
          },
        ],
        cells: new Map([["pro@nginx", { failed: ["artifacts", "auth"] }]]),
      }),
    );
    expect(lines[0]).toContain("✘ COULD NOT TEST");
    expect(lines).toContain("  Result      4 did not run, in 14.2m");
    const setup = lines.find((line) => line.startsWith("  Setup"));
    expect(setup).toMatch(/^ {2}Setup {7}artifacts:pro@nginx failed — x+…$/);
    expect(setup?.length).toBeLessThan(260);
    // Each further failed setup sits under the same label.
    expect(lines).toContain(
      "              setup:pro@nginx failed — Error: [preflight] failed",
    );
    expect(lines).toContain(
      "  Plugin      unknown — the artifacts setup failed",
    );
    expect(lines).toContain("  Site        unknown — the auth setup failed");
  });

  test("a placeholder cell, whose setups skipped, says nothing of plugin or site", () => {
    const lines = renderSummary(
      input({ cells: new Map([["pro@nginx", { failed: [] }]]) }),
    );
    expect(lines[0]).toContain("✔ PASSED");
    expect(lines.some((line) => /^ {2}(Plugin|Site)/.test(line))).toBe(false);
  });

  test("an interrupted run, and a run with nothing to test", () => {
    expect(renderSummary(input({ status: "interrupted" }))[0]).toContain(
      "■ INTERRUPTED",
    );
    expect(renderSummary(input({ scenarios: counts({}) }))[0]).toContain(
      "NO TESTS",
    );
  });

  test("a run of every cell names each cell's facts, and the shared report bucket", () => {
    const { cell: _cell, edition: _edition, ...rest } = RUN;
    const lines = renderSummary(
      input({
        run: {
          ...rest,
          reportCell: "_all",
          reportDir: "reports/backwpup/_all/run-1",
        },
        cells: new Map<string, CellFacts>([
          [
            "a",
            {
              failed: [],
              plugins: [{ role: "plugin", ok: true, name: "P", version: "1" }],
            },
          ],
          [
            "b",
            {
              failed: [],
              plugins: [
                { role: "plugin", ok: true, name: "P", version: "2" },
                { role: "previous", ok: true, name: "P", version: "1" },
              ],
            },
          ],
        ]),
      }),
    );
    expect(lines[0]).toMatch(/^━━ backwpup · every cell ━━ ✔ PASSED/);
    expect(lines).toEqual(
      expect.arrayContaining([
        "  Plugin      a: P 1",
        "              b: P 2",
        "  Previous    b: P 1",
        "  Allure      npm run report:allure -- backwpup _all --open",
      ]),
    );
  });

  test("what a site or a setup reported can neither style the terminal nor break a line", () => {
    const lines = renderSummary(
      input({
        status: "failed",
        setupFailures: [
          {
            project: "setup:pro@nginx",
            setup: "auth",
            message: "Error: \u001b[2Jcleared\rover",
          },
        ],
        cells: new Map<string, CellFacts>([
          [
            "pro@nginx",
            {
              failed: ["auth"],
              sites: [
                {
                  baseURL: "https://bwu3.example",
                  versions: {
                    wordpress: "7.1\u001b[31m",
                    php: "8.5\nPlugin  forged",
                  },
                },
              ],
            },
          ],
        ]),
      }),
    );
    // No control character survives in any line (the lines are joined by the reporter, not here).
    const controls = Array.from(lines.join(""), (c) => c.charCodeAt(0)).filter(
      (code) => code < 0x20 || (code >= 0x7f && code <= 0x9f),
    );
    expect(controls).toEqual([]);
    expect(lines).toContain(
      "  Setup       setup:pro@nginx failed — Error: cleared over",
    );
    expect(lines).toContain(
      "  Site        https://bwu3.example · WordPress 7.1 · PHP 8.5 Plugin  forged",
    );
    expect(lines.filter((line) => line.startsWith("  Plugin"))).toEqual([]);
  });

  test("every credential a setup, a build or a site's URL carried is masked, before any cut", () => {
    const lines = renderSummary(
      input({
        status: "failed",
        setupFailures: [
          {
            project: "artifacts:pro@nginx",
            setup: "artifacts",
            // Long enough to be cut inside the password, were the cut first.
            message: `Error: ${"x".repeat(150)} clone of https://x-access-token:SECRET1PASSWORD@github.com/o/r failed`,
          },
          {
            project: "setup:pro@nginx",
            setup: "auth",
            message:
              "page.goto: net::ERR_FAILED at http://admin:SECRET2@bwu3.example/wp-login.php",
          },
        ],
        cells: new Map<string, CellFacts>([
          [
            "pro@nginx",
            {
              failed: ["artifacts", "auth"],
              plugins: [
                {
                  role: "plugin",
                  ok: false,
                  error: "build: token ghp_SECRET3SECRET3SECRET3 refused",
                },
              ],
              sites: [
                {
                  baseURL: "http://admin:SECRET4@bwu3.example",
                  error: "fetch of https://h/x?access_token=SECRET5 failed",
                },
              ],
            },
          ],
        ]),
      }),
    );
    expect(lines.join("\n")).not.toMatch(/SECRET/);
    expect(lines).toContain(
      "              setup:pro@nginx failed — page.goto: net::ERR_FAILED at http://***@bwu3.example/wp-login.php",
    );
    expect(lines).toContain(
      "  Plugin      resolution failed — build: token *** refused",
    );
    expect(lines).toContain(
      "  Site        http://***@bwu3.example · versions unknown — fetch of https://h/x?access_token=*** failed",
    );
  });

  test("a report folder a shell would split is quoted", () => {
    const lines = renderSummary(input({ reportDir: "/my reports/run-1" }));
    expect(lines).toContain(
      "  Playwright  npx playwright show-report '/my reports/run-1/playwright'",
    );
    expect(lines).toContain(
      "  Cucumber    '/my reports/run-1/cucumber/index.html'",
    );
  });

  test("colours go through the styler it is given, by token: the header bold in its verdict's colour", () => {
    const styled = renderSummary(input(), (token, text) => `<${token}>${text}`);
    expect(styled[0]).toMatch(/^<emphasis><ok>━━ backwpup/);
    expect(styled[1]).toMatch(/^ {2}<emphasis>Result/);
    const failed = renderSummary(
      input({ status: "failed", scenarios: counts({ total: 1, failed: 1 }) }),
      (token, text) => `<${token}>${text}`,
    );
    expect(failed[0]).toMatch(/^<emphasis><fail>━━ backwpup/);
  });
});

test.describe("RunSummaryReporter", () => {
  /** A run with a passing auth setup that recorded a site, and an artifacts setup that failed. */
  function drive(mode: "test" | "list"): string {
    const reporter = new RunSummaryReporter({ ...RUN, _mode: mode });
    const auth = fakeTest({
      id: "s",
      project: "setup:pro@nginx",
      titles: ["auth.setup.ts", "authenticate"],
    });
    const artifacts = fakeTest({
      id: "a",
      project: "artifacts:pro@nginx",
      titles: ["artifacts.setup.ts", "resolve"],
    });
    const scenario = fakeTest({ id: "1", project: "pro@nginx" });
    return captureStdout(() => {
      reporter.onBegin(
        {} as FullConfig,
        fakeSuite([auth, artifacts, scenario]) as unknown as Suite,
      );
      reporter.onTestEnd(
        auth.test,
        addAttempt(auth, {
          status: "passed",
          attachments: [
            jsonAttachment(SITE_INFO_ATTACHMENT, [
              {
                baseURL: "https://bwu3.example",
                versions: { wordpress: "7.1.2", php: "8.5.10" },
              },
            ]),
          ],
        }),
      );
      reporter.onTestEnd(
        artifacts.test,
        addAttempt(artifacts, {
          status: "failed",
          errors: ["Error: [artifacts] resolution failed\nmore detail"],
          attachments: [
            jsonAttachment(ARTIFACTS_ATTACHMENT, {
              ok: false,
              roles: [
                {
                  role: "plugin",
                  ok: false,
                  checks: [
                    { name: "resolved", ok: false, detail: "no such ref" },
                  ],
                },
              ],
            }),
          ],
        }),
      );
      reporter.onEnd({
        status: "failed",
        startTime: new Date(),
        duration: 61_000,
      });
      // `onExit` prints synchronously; its promise only satisfies the interface.
      void reporter.onExit();
    });
  }

  test("prints last, after a blank line: COULD NOT TEST, the setup's first line, the facts read back", () => {
    const out = drive("test");
    expect(
      out.startsWith("\n━━ backwpup · pro@nginx (pro) ━━ ✘ COULD NOT TEST"),
    ).toBe(true);
    expect(out).toContain("1 did not run, in 1.0m");
    expect(out).toContain(
      "artifacts:pro@nginx failed — Error: [artifacts] resolution failed\n",
    );
    expect(out).not.toContain("more detail");
    expect(out).toContain("resolution failed — resolved: no such ref");
    expect(out).toContain(
      "https://bwu3.example · WordPress 7.1.2 · PHP 8.5.10",
    );
  });

  test("an interrupted setup did not fail: INTERRUPTED, no setup line, no 'setup failed' fact", () => {
    const reporter = new RunSummaryReporter(RUN);
    const artifacts = fakeTest({ id: "a", project: "artifacts:pro@nginx" });
    const out = captureStdout(() => {
      reporter.onBegin(
        {} as FullConfig,
        fakeSuite([artifacts]) as unknown as Suite,
      );
      reporter.onTestEnd(
        artifacts.test,
        addAttempt(artifacts, { status: "interrupted" }),
      );
      reporter.onEnd({
        status: "interrupted",
        startTime: new Date(),
        duration: 1,
      });
      void reporter.onExit();
    });
    expect(out).toContain("■ INTERRUPTED");
    expect(out).not.toContain("Setup");
    expect(out).not.toContain("setup failed");
  });

  test("a setup whose due retry never ran is settled as the run ends: COULD NOT TEST", () => {
    const reporter = new RunSummaryReporter(RUN);
    const auth = fakeTest({ id: "s", project: "setup:pro@nginx", retries: 1 });
    const out = captureStdout(() => {
      reporter.onBegin({} as FullConfig, fakeSuite([auth]) as unknown as Suite);
      reporter.onTestEnd(
        auth.test,
        addAttempt(auth, {
          status: "failed",
          errors: ["Error: preflight failed"],
        }),
      );
      reporter.onEnd({ status: "failed", startTime: new Date(), duration: 1 });
      void reporter.onExit();
    });
    expect(out).toContain("✘ COULD NOT TEST");
    expect(out).toContain("setup:pro@nginx failed — Error: preflight failed");
  });

  test("shows the report folder relative to the working directory", () => {
    const reporter = new RunSummaryReporter({
      ...RUN,
      reportPath: join(process.cwd(), "reports", "x", "run-1"),
    });
    const out = captureStdout(() => {
      reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
      void reporter.onExit();
    });
    expect(out).toContain(
      `npx playwright show-report ${join("reports", "x", "run-1", "playwright")}`,
    );
  });

  test("prints nothing for --list, nor before the run ended", () => {
    expect(drive("list")).toBe("");
    const reporter = new RunSummaryReporter(RUN);
    expect(
      captureStdout(() => {
        void reporter.onExit();
      }),
    ).toBe("");
  });

  test("prints nothing when its options lack the run's facts", () => {
    const reporter = new RunSummaryReporter({});
    reporter.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
    expect(
      captureStdout(() => {
        void reporter.onExit();
      }),
    ).toBe("");
    expect(reporter.printsToStdio()).toBe(false);
  });

  test("E2E_OUTPUT=plain: no colour whatever FORCE_COLOR says; auto keeps the stream's colours", () => {
    const saved = process.env.FORCE_COLOR;
    process.env.FORCE_COLOR = "1";
    try {
      /** The raw text a reporter with `output` prints for a passed run. */
      const printed = (output: string): string => {
        const reporter = new RunSummaryReporter({ ...RUN, output });
        reporter.onEnd({
          status: "passed",
          startTime: new Date(),
          duration: 1,
        });
        return captureWrites(process.stdout, () => {
          void reporter.onExit();
        }).join("");
      };
      const plainText = printed("plain");
      expect(plainText).toMatch(
        /^\n== backwpup \. pro@nginx \(pro\) == NO TESTS =+\n/,
      );
      expect(plainText).not.toContain("\u001b");
      // Plain is ASCII: the frame's glyphs too, not only the colour.
      expect(plainText).toMatch(/^[\n -~]*$/);
      const auto = printed("auto");
      expect(auto).toContain("\u001b[");
      // The words are the same: the colour and the glyphs go.
      expect(stripVTControlCharacters(auto)).toMatch(
        /^\n━━ backwpup · pro@nginx \(pro\) ━━ NO TESTS ━+\n/,
      );
      // After the blank line and the header, every line is the same.
      expect(stripVTControlCharacters(auto).split("\n").slice(2)).toEqual(
        plainText.split("\n").slice(2),
      );
    } finally {
      if (saved === undefined)
        Reflect.deleteProperty(process.env, "FORCE_COLOR");
      else process.env.FORCE_COLOR = saved;
    }
  });

  test("the reporter's rule follows the terminal's width: COLUMNS in a pipe", () => {
    const saved = process.env.COLUMNS;
    try {
      for (const columns of [100, 61]) {
        process.env.COLUMNS = String(columns);
        const reporter = new RunSummaryReporter({ ...RUN, output: "plain" });
        reporter.onEnd({
          status: "passed",
          startTime: new Date(),
          duration: 1,
        });
        const header = captureWrites(process.stdout, () => {
          void reporter.onExit();
        })
          .join("")
          .split("\n")[1];
        expect(header, String(columns)).toHaveLength(columns);
      }
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, "COLUMNS");
      else process.env.COLUMNS = saved;
    }
  });
});

test.describe("the run's pruning, in the summary", () => {
  test("renderSummary: a Pruned line last, a failure styled as a warning, none when nothing went", () => {
    const style = (token: string, text: string): string =>
      token === "warn" ? `<y>${text}</y>` : text;
    const lines = renderSummary(
      input({
        pruned: [
          { text: "1 old report, 4.3 MB — beyond the newest 20", warn: false },
          { text: "could not remove x — EACCES\nsecond line", warn: true },
        ],
      }),
      style,
    );
    expect(lines.slice(-2)).toEqual([
      "  Pruned      1 old report, 4.3 MB — beyond the newest 20",
      "              <y>could not remove x — EACCES second line</y>",
    ]);
    expect(renderSummary(input({ pruned: [] })).join("\n")).not.toContain(
      "Pruned",
    );
  });

  test("renderSummary: a Pruned line masks a credential, as every other line does", () => {
    const [line] = renderSummary(
      input({
        pruned: [
          {
            text: "could not prune https://u:hunter22@h/x — EACCES",
            warn: true,
          },
        ],
      }),
    ).slice(-1);
    expect(line).toContain("could not prune");
    expect(line).not.toContain("hunter22");
  });

  test("the reporter prunes its own cell's folder as the run ends, and says so; never for --list", () => {
    const root = tempRoot("e2e-summary-prune-");
    try {
      const cell = join(root, "backwpup", "pro@nginx");
      // Three, four and five days old: well inside the 30-day age rule, so only the count prunes.
      // (Fixed dates once aged past it and changed the reason.)
      const daysAgo = (days: number): string =>
        `${new Date(Date.now() - days * 86_400_000).toISOString().replace(/[:.]/g, "-")}-1`;
      const old = [daysAgo(5), daysAgo(4), daysAgo(3)].map((name) =>
        makeRun(cell, name),
      );
      const current = makeRun(
        cell,
        new Date().toISOString().replace(/[:.]/g, "-") + "-2",
      );
      const run = { ...RUN, reportPath: current, reportsKeep: 2 };

      const listing = new RunSummaryReporter({ ...run, _mode: "list" });
      listing.onEnd({ status: "passed", startTime: new Date(), duration: 1 });
      void listing.onExit();
      expect(old.every((path) => existsSync(path))).toBe(true);

      const reporter = new RunSummaryReporter(run);
      const out = captureStdout(() => {
        reporter.onEnd({
          status: "passed",
          startTime: new Date(),
          duration: 1,
        });
        void reporter.onExit();
      });
      expect(out).toMatch(
        /\n {2}Pruned {6}2 old reports, \d+ B — beyond the newest 2 \(E2E_REPORTS_KEEP\)\n$/,
      );
      expect(old.map((path) => existsSync(path))).toEqual([false, false, true]);
      expect(existsSync(current)).toBe(true);
    } finally {
      removeTempRoot(root);
    }
  });
});

test.describe("the Failed list, the rule and the glyphs", () => {
  /** The `Failed` lines of a summary: its label's line and the aligned ones after it. */
  function failedOf(lines: readonly string[]): string[] {
    const start = lines.findIndex((line) => line.startsWith("  Failed"));
    if (start === -1) return [];
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => !line.startsWith(" ".repeat(14)));
    return [lines[start] ?? "", ...(end === -1 ? rest : rest.slice(0, end))];
  }

  /** A failed run's input, its failed count matching the failures listed. */
  const failedRun = (failures: SummaryInput["failures"]): SummaryInput =>
    input({
      status: "failed",
      scenarios: counts({ total: 30, failed: failures?.length ?? 0 }),
      ...(failures !== undefined ? { failures } : {}),
    });

  test("each failed scenario with the step it failed in, right after the result; none when none failed", () => {
    const lines = renderSummary(
      failedRun([
        {
          title: ["Backups", "Create a backup"],
          step: ["When the backup runs"],
        },
        { title: ["Backups", "Rule A", "Outline — row 1"] },
        {
          title: ["Restore", "Restore a backup"],
          step: ["Before Hooks", "BeforeEach Hooks", "reset"],
        },
      ]),
    );
    expect(lines[2]).toBe(
      "  Failed      Backups › Create a backup — When the backup runs",
    );
    expect(failedOf(lines)).toEqual([
      "  Failed      Backups › Create a backup — When the backup runs",
      "              Backups › Rule A › Outline — row 1",
      "              Restore › Restore a backup — Before Hooks › BeforeEach Hooks › reset",
    ]);
    expect(failedOf(renderSummary(input()))).toEqual([]);
    expect(failedOf(renderSummary(input({ failures: [] })))).toEqual([]);
  });

  test("ten are listed, then how many more; eleven says one more", () => {
    const many = (n: number): SummaryInput["failures"] =>
      Array.from({ length: n }, (_, i) => ({
        title: ["F", `Scenario ${String(i + 1)}`],
        step: ["When it breaks"],
      }));
    const ten = failedOf(renderSummary(failedRun(many(10))));
    expect(ten).toHaveLength(10);
    expect(ten.at(-1)).toBe("              F › Scenario 10 — When it breaks");
    const eleven = failedOf(renderSummary(failedRun(many(11))));
    expect(eleven).toHaveLength(11);
    expect(eleven.at(-1)).toBe("              and 1 more");
    const many25 = failedOf(renderSummary(failedRun(many(25))));
    expect(many25.at(-2)).toBe(
      "              F › Scenario 10 — When it breaks",
    );
    expect(many25.at(-1)).toBe("              and 15 more");
  });

  test("a duplicate title is listed once per failure", () => {
    const twice = { title: ["F", "Same"], step: ["When x"] };
    expect(failedOf(renderSummary(failedRun([twice, twice])))).toEqual([
      "  Failed      F › Same — When x",
      "              F › Same — When x",
    ]);
  });

  test("a failed item is plain, masked and cut: no escape, no line break, no credential", () => {
    const [line, ...rest] = failedOf(
      renderSummary(
        failedRun([
          {
            title: ["F\u001b[2J", "S\nnext https://u:hunter22@h.example/"],
            step: [`When ${"x".repeat(400)}`],
          },
        ]),
      ),
    );
    expect(rest).toEqual([]);
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("hunter22");
    expect(line).toContain("F › S next https://***@h.example/ — When x");
    expect(line?.endsWith("…")).toBe(true);
    expect(line?.length).toBeLessThan(220);
  });

  test("an empty step says nothing after the scenario; an emoji or CJK title stays whole", () => {
    expect(
      failedOf(
        renderSummary(
          failedRun([{ title: ["機能", "シナリオ 👩‍💻"], step: ["\u001b[0m"] }]),
        ),
      ),
    ).toEqual(["  Failed      機能 › シナリオ 👩💻"]);
  });

  test("the rule runs to the width it is given; a header wider than it gets no fill but is never cut", () => {
    const at = (width: number): string =>
      renderSummary(input(), undefined, { ...DEFAULT_LAYOUT, width })[0] ?? "";
    expect(at(120)).toHaveLength(120);
    expect(at(60)).toMatch(/^━━ backwpup · pro@nginx \(pro\) ━━ ✔ PASSED ━+$/);
    expect(at(60)).toHaveLength(60);
    // Too narrow for any fill: the words stay whole.
    expect(at(40)).toBe("━━ backwpup · pro@nginx (pro) ━━ ✔ PASSED");
    expect(at(20)).toBe("━━ backwpup · pro@nginx (pro) ━━ ✔ PASSED");
  });

  test("an ASCII layout draws every frame glyph in ASCII", () => {
    const ascii: SummaryLayout = {
      width: 80,
      symbol: (name) => SYMBOLS[name].ascii,
    };
    const lines = renderSummary(
      input({
        status: "failed",
        scenarios: counts({ total: 2, failed: 1, didNotRun: 1 }),
        failures: [{ title: ["F", "S"], step: ["When x"] }],
        setupFailures: [
          { project: "setup:pro@nginx", setup: "auth", message: "no" },
        ],
        cells: new Map([["pro@nginx", { failed: ["artifacts", "auth"] }]]),
      }),
      undefined,
      ascii,
    );
    expect(lines[0]).toMatch(
      /^== backwpup \. pro@nginx \(pro\) == x COULD NOT TEST =+$/,
    );
    expect(lines[0]).toHaveLength(80);
    expect(lines).toEqual(
      expect.arrayContaining([
        // The counts' separators are the layout's too: no `·` in an ASCII summary.
        "  Result      1 failed . 1 did not run, in 14.2m",
        "  Failed      F > S - When x",
        "  Setup       setup:pro@nginx failed - no",
        "  Plugin      unknown - the artifacts setup failed",
        "  Site        unknown - the auth setup failed",
      ]),
    );
    for (const [status, mark] of [
      ["interrupted", "# INTERRUPTED"],
      ["passed", "OK PASSED"],
    ] as const) {
      expect(renderSummary(input({ status }), undefined, ascii)[0]).toContain(
        mark,
      );
    }
  });

  test("an ASCII layout cuts with `...` and joins a hook's path with `>`", () => {
    const ascii: SummaryLayout = {
      width: 80,
      symbol: (name) => SYMBOLS[name].ascii,
    };
    const [hook, long] = failedOf(
      renderSummary(
        failedRun([
          { title: ["F", "S"], step: ["After Hooks", "AfterEach Hooks", "x"] },
          { title: ["F", "S".repeat(300)], step: ["When x"] },
        ]),
        undefined,
        ascii,
      ),
    );
    expect(hook).toBe(
      "  Failed      F > S - After Hooks > AfterEach Hooks > x",
    );
    expect(long).toMatch(/^ {14}F > S+\.\.\.$/);
    expect(long).toHaveLength(14 + 200);
    // A setup's message and an outside error are cut the same way.
    const lines = renderSummary(
      input({
        status: "failed",
        scenarios: counts({ total: 1, didNotRun: 1 }),
        setupFailures: [
          { project: "setup:x", setup: "auth", message: "m".repeat(300) },
        ],
        runErrors: ["e".repeat(300)],
      }),
      undefined,
      ascii,
    );
    for (const line of lines) expect(line).toMatch(/^[ -~]*$/);
    expect(lines.filter((line) => line.endsWith("..."))).toHaveLength(2);
  });

  test("a failed step is plain and masked; an empty title part is left out", () => {
    const [line] = failedOf(
      renderSummary(
        failedRun([
          {
            title: ["F", "", "\u001b[0m", "S"],
            step: ["When \u001b[2J https://u:hunter22@h.example/"],
          },
        ]),
      ),
    );
    // The escape goes and the spaces around it stay, as everywhere `plain` shows a value.
    expect(line).toBe("  Failed      F › S — When  https://***@h.example/");
  });

  test("the header's product and cell are plain and masked", () => {
    const [header] = renderSummary(
      input({
        run: {
          ...input().run,
          product: "p\u001b[2J",
          cell: "https://u:hunter22@h.example/",
        },
      }),
    );
    expect(header).not.toContain("\u001b");
    expect(header).not.toContain("hunter22");
    expect(header).toContain("p · https://***@h.example/");
  });

  test("the reporter lists a scenario that failed for good — a settled retry too — never a flaky one or a setup", () => {
    const reporter = new RunSummaryReporter(RUN);
    const failing = fakeTest({
      id: "1",
      project: "pro@nginx",
      titles: ["b.feature.spec.js", "Backups", "Create"],
    });
    const flaky = fakeTest({
      id: "2",
      project: "pro@nginx",
      titles: ["b.feature.spec.js", "Backups", "Flaky"],
      retries: 1,
    });
    const pending = fakeTest({
      id: "3",
      project: "pro@nginx",
      titles: ["b.feature.spec.js", "Backups", "Pending"],
      retries: 1,
    });
    const setup = fakeTest({ id: "s", project: "setup:pro@nginx" });
    const typed = [
      step("When the form is filled", "test.step", {
        error: "Error: no",
        steps: [step('Fill "canary-typed"', "pw:api", { error: "Error: no" })],
      }),
    ];
    const out = captureStdout(() => {
      reporter.onBegin(
        {} as FullConfig,
        fakeSuite([failing, flaky, pending, setup]) as unknown as Suite,
      );
      reporter.onTestEnd(
        failing.test,
        addAttempt(failing, {
          status: "failed",
          errors: ["Error: no"],
          steps: typed,
        }),
      );
      reporter.onTestEnd(
        flaky.test,
        addAttempt(flaky, { status: "failed", errors: ["Error: no"] }),
      );
      reporter.onTestEnd(flaky.test, addAttempt(flaky, { status: "passed" }));
      reporter.onTestEnd(
        pending.test,
        addAttempt(pending, { status: "timedOut", errors: ["Timeout"] }),
      );
      reporter.onTestEnd(
        setup.test,
        addAttempt(setup, { status: "failed", errors: ["Error: setup"] }),
      );
      reporter.onEnd({ status: "failed", startTime: new Date(), duration: 1 });
      void reporter.onExit();
    });
    const lines = out.split("\n");
    expect(failedOf(lines)).toEqual([
      "  Failed      Backups › Create — When the form is filled",
      "              Backups › Pending",
    ]);
    expect(out).not.toContain("canary-typed");
    // The leading blank line stays; no trailing one: the prompt follows the last line.
    expect(out.startsWith("\n")).toBe(true);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.endsWith("\n\n")).toBe(false);
  });
});

test("a report folder holding an escape is shown plain: no escape reaches the terminal", () => {
  const lines = renderSummary(
    input({ reportDir: "reports\u001b[31mred\u001b[0m/run-1" }),
  );
  expect(lines).toContain(
    "  Playwright  npx playwright show-report reportsred/run-1/playwright",
  );
  expect(lines).toContain("  Cucumber    reportsred/run-1/cucumber/index.html");
  expect(lines.join("\n")).not.toContain("\u001b");
});
