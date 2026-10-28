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
} from "../__fixtures__/reporter-fakes";
import { makeRun, removeTempRoot, tempRoot } from "../__fixtures__/report-tree";
import {
  ARTIFACTS_ATTACHMENT,
  SITE_INFO_ATTACHMENT,
} from "../setup/attachments";
import type { Counts } from "./results";
import type { RunDescription } from "./run-description";
import RunSummaryReporter, {
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

  test("colours go through the styler it is given", () => {
    const styled = renderSummary(
      input(),
      (format, text) => `<${String(format)}>${text}`,
    );
    expect(styled[0]).toMatch(/^<bold,green>━━ backwpup/);
    expect(styled[1]).toMatch(/^ {2}<bold>Result/);
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
      expect(plainText).toContain("NO TESTS");
      expect(plainText).not.toContain("\u001b");
      const auto = printed("auto");
      expect(auto).toContain("\u001b[");
      // The words are the same: only the colour goes.
      expect(stripVTControlCharacters(auto)).toBe(plainText);
    } finally {
      if (saved === undefined)
        Reflect.deleteProperty(process.env, "FORCE_COLOR");
      else process.env.FORCE_COLOR = saved;
    }
  });
});

test.describe("the run's pruning, in the summary", () => {
  test("renderSummary: a Pruned line last, a failure styled as a warning, none when nothing went", () => {
    const style = (format: unknown, text: string): string =>
      format === "yellow" ? `<y>${text}</y>` : text;
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
      const old = [
        "2026-10-01T00-00-00-000Z-1",
        "2026-10-02T00-00-00-000Z-1",
        "2026-10-03T00-00-00-000Z-1",
      ].map((name) => makeRun(cell, name));
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
