import { test, expect } from "@playwright/test";

import { reply, startSink } from "../__fixtures__/http-sink";
import { finishedEvent, scenario } from "../__fixtures__/run-finished";
import type { RunStatus } from "../runs/outcome";
import {
  escapeCut,
  escapeSlack,
  FENCE_BREAK,
  formatDuration,
  MAX_LISTED_SCENARIOS,
  MAX_SHOWN,
  sendSlack,
  slackMessage,
} from "./slack";

test.describe("slackMessage", () => {
  test("tells a failed run in full: headline, counts, plugin, site, lists, scp", () => {
    expect(
      slackMessage(finishedEvent(), {
        instance: "AutoE2E nginx",
        sshHost: "auto-e2e",
      }),
    ).toBe(
      [
        "*[AutoE2E nginx]* ❌ FAILED — BackWPup Pro · pro@nginx",
        "52 scenarios: 49 passed · 1 flaky · 2 failed, in 54m 10s",
        "Plugin: BackWPup Pro 9.99.99 · develop @ f1ebfd0",
        "Site: https://simple.e2e.rocketlabsqa.ovh · WordPress 7.1.2 · PHP 8.5.10",
        "Failed:",
        '• Backups › A backup runs on demand — Expected "Done", received "Error"',
        "• CLI › Logs are listed — Timeout 30000ms exceeded",
        "Flaky:",
        "• Onboarding › The first backup is offered — first attempt failed",
        "Report: `scp -r auto-e2e:/home/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12 .`",
      ].join("\n"),
    );
  });

  test("gives every status its headline", () => {
    const headlines: Record<RunStatus, string> = {
      passed: "✅ PASSED",
      flaky: "⚠️ FLAKY",
      failed: "❌ FAILED",
      error: "🚫 COULD NOT TEST",
      stopped: "■ STOPPED",
      killed: "■ KILLED",
    };
    for (const [status, headline] of Object.entries(headlines))
      expect(
        slackMessage(finishedEvent({ status: status as RunStatus })).split(
          "\n",
        )[0],
      ).toBe(`${headline} — BackWPup Pro · pro@nginx`);
  });

  test("says why a run could not test, with its log, instead of counts and scenario lists", () => {
    const text = slackMessage(
      finishedEvent({
        status: "error",
        reason: "setup:pro@nginx failed: SSH connection refused",
        durationMs: 75_000,
      }),
      { sshHost: "auto-e2e" },
    );
    expect(text).toBe(
      [
        "🚫 COULD NOT TEST — BackWPup Pro · pro@nginx",
        "Reason: setup:pro@nginx failed: SSH connection refused",
        "Plugin: BackWPup Pro 9.99.99 · develop @ f1ebfd0",
        "Site: https://simple.e2e.rocketlabsqa.ovh · WordPress 7.1.2 · PHP 8.5.10",
        "Took: 1m 15s",
        "Log: `scp auto-e2e:/home/e2e/.orchestrator/runs/bpng-12/run.log .`",
        "Report: `scp -r auto-e2e:/home/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12 .`",
      ].join("\n"),
    );
  });

  test("points at no log or report for a run that never had a folder of its own", () => {
    const text = slackMessage(
      finishedEvent({
        status: "error",
        reason:
          "the run could not start: its cell's site locks are no longer this orchestrator's",
        durationMs: 0,
        report: { dir: null, log: null, bundle: null },
      }),
      { sshHost: "auto-e2e" },
    );
    expect(text).not.toMatch(/^(Log|Report):/m);
    expect(text.split("\n").at(-1)).toBe("Took: 0s");
  });

  test("says why a run was stopped, beside what it tested", () => {
    const lines = slackMessage(
      finishedEvent({
        status: "stopped",
        reason: "drained: 3 scenarios skipped",
      }),
    ).split("\n");
    expect(lines[1]).toMatch(/^52 scenarios: /);
    expect(lines[2]).toBe("Reason: drained: 3 scenarios skipped");
    expect(lines).toContain("Failed:");
  });

  test("names what it does not know by leaving it out: product for plugin, no version, no commit", () => {
    const text = slackMessage(
      finishedEvent({
        status: "error",
        reason: "bddgen exited 1",
        plugin: {
          requestedRef: "develop",
          ref: null,
          commit: null,
          version: null,
          name: null,
        },
        sites: [{ baseURL: "https://a.test", wordpress: null, php: null }],
      }),
    );
    expect(text).toContain("🚫 COULD NOT TEST — backwpup · pro@nginx");
    expect(text).toContain("Plugin: backwpup · develop\n");
    expect(text).toContain("Site: https://a.test\n");
  });

  test("shows a release's build without a commit, and the product's default ref when none was asked", () => {
    const text = slackMessage(
      finishedEvent({
        plugin: {
          requestedRef: null,
          ref: "release:v5.6.1",
          commit: null,
          version: "5.6.1",
          name: "BackWPup",
        },
      }),
    );
    expect(text).toContain("Plugin: BackWPup 5.6.1 · release:v5.6.1\n");
  });

  test("gives each site of the pool its own line", () => {
    const text = slackMessage(
      finishedEvent({
        sites: [
          { baseURL: "https://a.test", wordpress: "7.1", php: "8.4" },
          { baseURL: "https://b.test", wordpress: "7.1", php: null },
        ],
      }),
    );
    expect(text).toContain(
      "Site: https://a.test · WordPress 7.1 · PHP 8.4\nSite: https://b.test · WordPress 7.1\n",
    );
  });

  test("shows the report's path when no ssh host is configured, and quotes one a shell would split", () => {
    expect(slackMessage(finishedEvent())).toMatch(
      /\nReport: `\/home\/e2e\/reports\/backwpup\/pro@nginx\/2026-10-13T10-15-31-042Z-bpng-12`$/,
    );
    const text = slackMessage(
      finishedEvent({
        report: { dir: "/srv/my e2e/r", log: "/srv/x.log", bundle: null },
      }),
      { sshHost: "runner" },
    );
    expect(text).toMatch(/\nReport: `scp -r runner:'\/srv\/my e2e\/r' \.`$/);
  });

  test("escapes &, < and > in everything the run gave, so no name can ping a channel", () => {
    const text = slackMessage(
      finishedEvent({
        plugin: {
          ...finishedEvent().plugin,
          name: "A & B <!channel>",
        },
        scenarios: [
          scenario({
            feature: "<@U123>",
            name: "x > y",
            status: "failed",
            error: "<!here> & co",
          }),
        ],
      }),
      { instance: "<i>" },
    );
    expect(text).not.toMatch(/<|>/);
    expect(text).toContain(
      "*[&lt;i&gt;]* ❌ FAILED — A &amp; B &lt;!channel&gt;",
    );
    expect(text).toContain(
      "• &lt;@U123&gt; › x &gt; y — &lt;!here&gt; &amp; co",
    );
  });

  test("lists a scenario's Rule and Outline path, and its error's first non-blank line", () => {
    const text = slackMessage(
      finishedEvent({
        scenarios: [
          scenario({
            path: ["Rule: on demand", "Outline: by size"],
            status: "failed",
            error: "\n  \nfirst line\nsecond line",
          }),
        ],
      }),
    );
    expect(text).toContain(
      "• Backups › Rule: on demand › Outline: by size › A backup runs — first line\n",
    );
  });

  test("lists at most 20 scenarios, failed first, then says how many more", () => {
    const failed = Array.from({ length: 18 }, (_, i) =>
      scenario({ name: `F${String(i)}`, status: "failed" }),
    );
    const flaky = Array.from({ length: 5 }, (_, i) =>
      scenario({ name: `K${String(i)}`, status: "flaky" }),
    );
    const lines = slackMessage(
      finishedEvent({ scenarios: [...flaky, ...failed] }),
    ).split("\n");
    expect(lines.filter((line) => line.startsWith("• "))).toHaveLength(
      MAX_LISTED_SCENARIOS,
    );
    const flakyAt = lines.indexOf("Flaky:");
    expect(lines.slice(flakyAt, flakyAt + 4)).toEqual([
      "Flaky:",
      "• Backups › K0",
      "• Backups › K1",
      "…and 3 more",
    ]);
  });

  test("says how many more when the failed list alone is over the cap, and lists no flaky one", () => {
    const failed = Array.from({ length: 25 }, (_, i) =>
      scenario({ name: `F${String(i)}`, status: "failed" }),
    );
    const lines = slackMessage(
      finishedEvent({ scenarios: [...failed, scenario({ status: "flaky" })] }),
    ).split("\n");
    expect(lines).toContain("…and 5 more");
    expect(lines).toContain("Flaky:");
    expect(lines[lines.indexOf("Flaky:") + 1]).toBe("…and 1 more");
  });

  test("stays far under Slack's 40,000 characters whatever the run gave", () => {
    const huge = "&".repeat(5_000);
    const text = slackMessage(
      finishedEvent({
        plugin: { ...finishedEvent().plugin, name: huge, ref: huge },
        sites: Array.from({ length: 100 }, () => ({
          baseURL: huge,
          wordpress: huge,
          php: huge,
        })),
        scenarios: Array.from({ length: 500 }, () =>
          scenario({
            feature: huge,
            path: [huge, huge],
            name: huge,
            status: "failed",
            error: huge,
          }),
        ),
        report: { dir: huge, log: huge, bundle: null },
      }),
      { instance: huge, sshHost: "h" },
    );
    expect(text.length).toBeLessThan(20_000);
  });

  test("counts only what is not 0, and says a run with no scenario plainly", () => {
    const zero = {
      total: 0,
      passed: 0,
      failed: 0,
      flaky: 0,
      skipped: 0,
      didNotRun: 0,
    };
    expect(
      slackMessage(
        finishedEvent({ status: "passed", counts: zero, scenarios: [] }),
      ).split("\n")[1],
    ).toBe("0 scenarios, in 54m 10s");
    expect(
      slackMessage(
        finishedEvent({
          status: "stopped",
          counts: { ...zero, total: 1, skipped: 1 },
        }),
      ).split("\n")[1],
    ).toBe("1 scenario: 1 skipped, in 54m 10s");
    expect(
      slackMessage(
        finishedEvent({
          counts: { ...zero, total: 3, passed: 1, didNotRun: 2 },
        }),
      ).split("\n")[1],
    ).toBe("3 scenarios: 1 passed · 2 did not run, in 54m 10s");
  });
  test("lists at most 10 sites, then how many more, so a big pool stays bounded", () => {
    const sites = Array.from({ length: 100 }, (_, i) => ({
      baseURL: `https://s${String(i)}.test`,
      wordpress: "7.1",
      php: "8.4",
    }));
    const lines = slackMessage(finishedEvent({ sites })).split("\n");
    expect(lines.filter((line) => line.startsWith("Site: "))).toHaveLength(10);
    expect(lines).toContain("…and 90 more sites");
  });

  test("names a commit plainly when the ref is unknown", () => {
    const text = slackMessage(
      finishedEvent({
        plugin: { ...finishedEvent().plugin, ref: null, requestedRef: null },
      }),
    );
    expect(text).toContain("Plugin: BackWPup Pro 9.99.99 · commit f1ebfd0\n");
  });

  test("lists a scenario with no name at all as unnamed", () => {
    const text = slackMessage(
      finishedEvent({
        scenarios: [scenario({ feature: "", name: "", status: "failed" })],
      }),
    );
    expect(text).toContain("Failed:\n• (unnamed)\n");
  });

  test("never sends a lone surrogate: it becomes U+FFFD", () => {
    const text = slackMessage(
      finishedEvent({
        plugin: { ...finishedEvent().plugin, name: "a\ud800" },
        scenarios: [scenario({ name: "x\udc00", status: "failed" })],
      }),
    );
    expect(text.isWellFormed()).toBe(true);
    expect(text).toContain("a�");
    expect(text).toContain("x�");
  });

  test("never lets two names holding three backticks make the lines between them one code block", () => {
    const text = slackMessage(
      finishedEvent({
        scenarios: [
          scenario({ name: "opens ```", status: "failed", error: "a ``` b" }),
          scenario({ name: "x".repeat(400) + "````", status: "failed" }),
          scenario({ name: "closes ```", status: "flaky" }),
        ],
      }),
    );
    expect(text).not.toContain("```");
    expect(text).toContain(
      `• Backups › opens ${FENCE_BREAK.repeat(3)} — a ${FENCE_BREAK.repeat(3)} b`,
    );
    expect(text).toContain(`• Backups › closes ${FENCE_BREAK.repeat(3)}`);
  });

  test("shows a path holding a backtick as plain text, since code would end early", () => {
    const text = slackMessage(
      finishedEvent({
        report: { dir: "/srv/a`b", log: "/srv/x.log", bundle: null },
      }),
    );
    expect(text).toMatch(/\nReport: \/srv\/a`b$/);
  });
});

test.describe("escapeSlack and escapeCut", () => {
  test("escapes exactly the three characters Slack requires", () => {
    expect(escapeSlack(`a & b < c > d "e" 'f' *g*`)).toBe(
      `a &amp; b &lt; c &gt; d "e" 'f' *g*`,
    );
  });

  test("breaks every run of three backticks or more, keeping one or two and the length", () => {
    const b = FENCE_BREAK;
    expect(escapeSlack("`a` ``b`` ```c``` ````d")).toBe(
      `\`a\` \`\`b\`\` ${b}${b}${b}c${b}${b}${b} ${b}${b}${b}${b}d`,
    );
    expect(escapeSlack("&```<")).toBe(`&amp;${b}${b}${b}&lt;`);
    // Cut or not, no three backticks survive, whatever the bound.
    for (let max = 1; max < 30; max++)
      expect(escapeCut("a````b&````".repeat(3), max)).not.toContain("```");
    expect(escapeCut("``````", 4)).toBe(`${b}${b}${b}…`);
  });

  test("refuses a bound under 1", () => {
    expect(() => escapeCut("ab", 0)).toThrow(RangeError);
    expect(() => escapeCut("ab", 1.5)).toThrow(RangeError);
  });

  test("cuts within the bound once escaped, never inside an escape or a surrogate pair", () => {
    expect(escapeCut("abc", 3)).toBe("abc");
    expect(escapeCut("&&&", 10)).toBe("&amp;…");
    expect(escapeCut("&&&", 11)).toBe("&amp;&amp;…");
    expect(escapeCut("😀😀😀", 5)).toBe("😀😀…");
    for (let max = 1; max < 30; max++)
      expect(escapeCut("a&<>😀b".repeat(5), max).length).toBeLessThanOrEqual(
        max,
      );
  });
});

test.describe("formatDuration", () => {
  test("reads as a person says it", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45_400)).toBe("45s");
    expect(formatDuration(3_250_000)).toBe("54m 10s");
    expect(formatDuration(3_723_000)).toBe("1h 2m 3s");
    expect(formatDuration(-5)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
  });
});

test.describe("sendSlack", () => {
  test("posts { text } with link previews off, and succeeds on 200 ok", async () => {
    const sink = await startSink(reply(200, "ok"));
    try {
      const sent = await sendSlack("hello", {
        webhookUrl: `${sink.url}/services/T0/B0/x`,
      });
      expect(sent).toEqual({ ok: true, status: 200 });
      expect(JSON.parse(sink.requests[0]?.body ?? "")).toEqual({
        text: "hello",
        unfurl_links: false,
        unfurl_media: false,
      });
    } finally {
      await sink.close();
    }
  });

  test("fails with Slack's answer on anything else, the webhook masked", async () => {
    const sink = await startSink(
      reply(404, "no_service for /services/T0/B0/secretpath"),
    );
    try {
      const sent = await sendSlack("hello", {
        webhookUrl: `${sink.url}/services/T0/B0/secretpath`,
      });
      expect(sent).toEqual({
        ok: false,
        status: 404,
        detail: "no_service for ***",
      });
    } finally {
      await sink.close();
    }
  });

  test("masks the whole webhook when Slack quotes it, host and all", async () => {
    const sink = await startSink((request, response) => {
      response.writeHead(404);
      response.end(
        `no_service for http://${String(request.headers.host)}${request.path}`,
      );
    });
    try {
      expect(
        await sendSlack("x", {
          webhookUrl: `${sink.url}/services/T0/B0/secretpath`,
        }),
      ).toEqual({ ok: false, status: 404, detail: "no_service for ***" });
    } finally {
      await sink.close();
    }
  });

  test("masks the webhook's token when Slack quotes it alone", async () => {
    const sink = await startSink(
      reply(403, "invalid_token XXXXXXXXXXXXXXXXXXXXXXXX"),
    );
    try {
      expect(
        await sendSlack("x", {
          webhookUrl: `${sink.url}/services/T0001/B0002/XXXXXXXXXXXXXXXXXXXXXXXX`,
        }),
      ).toEqual({ ok: false, status: 403, detail: "invalid_token ***" });
    } finally {
      await sink.close();
    }
  });

  test("treats a 200 whose body is not ok as a failure", async () => {
    const sink = await startSink(reply(200, "invalid_payload"));
    try {
      expect(
        await sendSlack("x", { webhookUrl: `${sink.url}/services/T0/B0/x` }),
      ).toEqual({ ok: false, status: 200, detail: "invalid_payload" });
    } finally {
      await sink.close();
    }
  });
});

test.describe("slackMessage — the Report line with a bundle", () => {
  const DIR =
    "/home/e2e/reports/backwpup/pro@nginx/2026-10-13T10-15-31-042Z-bpng-12";
  const NAME = "backwpup-pro@nginx-2026-10-13T10-15-31-042Z-bpng-12";
  const ARCHIVE = {
    kind: "archive",
    path: `${DIR}/report.tar.gz`,
    name: NAME,
  } as const;

  /** The message's `Report:` line for a run with this report. */
  function reportLine(
    report: Partial<ReturnType<typeof finishedEvent>["report"]>,
    sshHost?: string,
  ): string | undefined {
    const event = finishedEvent({
      report: { dir: DIR, log: "/home/e2e/run.log", bundle: null, ...report },
    });
    return slackMessage(event, sshHost === undefined ? {} : { sshHost })
      .split("\n")
      .find((line) => line.startsWith("Report: "));
  }

  test("an archive is one command: download, unpack, then remove — its && escaped as Slack requires", () => {
    expect(reportLine({ bundle: ARCHIVE }, "auto-e2e")).toBe(
      `Report: \`scp auto-e2e:${DIR}/report.tar.gz ${NAME}.tar.gz &amp;&amp; tar -xzf ${NAME}.tar.gz &amp;&amp; rm ${NAME}.tar.gz\``,
    );
  });

  test("a folder is one scp -r into a folder named after the run", () => {
    expect(
      reportLine(
        { bundle: { kind: "folder", path: `${DIR}/report`, name: NAME } },
        "auto-e2e",
      ),
    ).toBe(`Report: \`scp -r auto-e2e:${DIR}/report ${NAME}\``);
  });

  test("without sshHost: the bundle's path", () => {
    expect(reportLine({ bundle: ARCHIVE })).toBe(
      `Report: \`${DIR}/report.tar.gz\``,
    );
  });

  test("no bundle — none built, or it failed — gives the raw report folder, as before", () => {
    expect(reportLine({}, "auto-e2e")).toBe(
      `Report: \`scp -r auto-e2e:${DIR} .\``,
    );
    expect(reportLine({})).toBe(`Report: \`${DIR}\``);
  });

  test("a path with a space or a quote is quoted for the shell, every word", () => {
    const dir = "/srv/my e2e/it's/R";
    expect(
      reportLine(
        {
          dir,
          bundle: { kind: "archive", path: `${dir}/report.tar.gz`, name: NAME },
        },
        "auto-e2e",
      ),
    ).toBe(
      `Report: \`scp auto-e2e:'/srv/my e2e/it'\\''s/R/report.tar.gz' ${NAME}.tar.gz &amp;&amp; tar -xzf ${NAME}.tar.gz &amp;&amp; rm ${NAME}.tar.gz\``,
    );
  });

  test("a command longer than Slack shows once escaped is never cut: the archive's path instead", () => {
    // Fits raw, not escaped: the four `&` grow by 16 characters.
    const fixed =
      `scp h: ${NAME}.tar.gz && tar -xzf ${NAME}.tar.gz && rm ${NAME}.tar.gz`
        .length;
    const path = `/${"p".repeat(MAX_SHOWN - fixed - 5 - 15)}/report.tar.gz`;
    const bundle = { kind: "archive", path, name: NAME } as const;
    const raw = `scp h:${path} ${NAME}.tar.gz && tar -xzf ${NAME}.tar.gz && rm ${NAME}.tar.gz`;
    expect(raw.length).toBe(MAX_SHOWN - 5);
    expect(escapeSlack(raw).length).toBe(MAX_SHOWN + 11);
    expect(reportLine({ bundle }, "h")).toBe(`Report: \`${path}\``);
    // One that fits escaped is given whole.
    const short = { ...bundle, path: "/r/report.tar.gz" };
    expect(reportLine({ bundle: short }, "h")).toContain("&amp;&amp; rm");
  });

  test("Slack receives &amp;&amp; in the payload, which it shows as &&", async () => {
    const sink = await startSink(reply(200, "ok"));
    try {
      const text = slackMessage(
        finishedEvent({
          report: { dir: DIR, log: "/home/e2e/run.log", bundle: ARCHIVE },
        }),
        { sshHost: "auto-e2e" },
      );
      await sendSlack(text, { webhookUrl: `${sink.url}/services/T0/B0/x` });
      const body = JSON.parse(sink.requests[0]?.body ?? "") as {
        text: string;
      };
      expect(body.text).toContain(
        `tar -xzf ${NAME}.tar.gz &amp;&amp; rm ${NAME}.tar.gz\``,
      );
      expect(body.text).not.toMatch(/[^;]&&/);
    } finally {
      await sink.close();
    }
  });
});
