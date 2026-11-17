import { test, expect } from "@playwright/test";

import { reply, startSink } from "../__fixtures__/http-sink";
import { finishedEvent, scenario } from "../__fixtures__/run-finished";
import type { RunStatus } from "../runs/outcome";
import { safeSiteUrl } from "../text";
import {
  acceptedUrl,
  datatorPayload,
  MAX_CASE_ERROR,
  MAX_CASE_NAME,
  sendDatator,
  UNNAMED,
} from "./datator";

/** The payload of an event, failing the test when there is none. */
function payloadOf(...args: Parameters<typeof finishedEvent>) {
  const payload = datatorPayload(finishedEvent(...args));
  if (payload === undefined) throw new Error("expected a payload");
  return payload;
}

test.describe("datatorPayload", () => {
  test("maps a run to Datator's record, field by field", () => {
    const payload = payloadOf();
    expect({ ...payload, test_cases: payload.test_cases.slice(0, 4) }).toEqual({
      product: "backwpup",
      test_suite: "pro@nginx",
      timestamp: "2026-10-13T10:15:31.042Z",
      total_tests: 52,
      successful_tests: 50,
      failed_tests: 2,
      git_commit: "f1ebfd0".padEnd(40, "a"),
      test_duration_seconds: 3250,
      website_url: "https://simple.e2e.rocketlabsqa.ovh",
      test_cases: [
        {
          feature_name: "Backups",
          test_name: "A backup runs on demand",
          status: "failed",
          error_message: 'Expected "Done", received "Error"\n  at step 3',
        },
        {
          feature_name: "CLI",
          test_name: "Logs are listed",
          status: "failed",
          error_message: "Timeout 30000ms exceeded",
        },
        {
          feature_name: "Onboarding",
          test_name: "The first backup is offered",
          status: "passed",
          error_message: "first attempt failed",
        },
        {
          feature_name: "Backups",
          test_name: "Scenario 1",
          status: "passed",
          error_message: null,
        },
      ],
    });
    expect(payload.test_cases).toHaveLength(52);
  });

  test("carries no suite version: the record is the same, byte for byte, whatever the event's", () => {
    const sent = JSON.stringify(payloadOf());
    for (const version of ["2.0.0", null])
      expect(JSON.stringify(payloadOf({ suite: { version } }))).toBe(sent);
    expect(sent).not.toMatch(/"suite"|"version"|1\.1\.0/);
  });

  test("posts only runs that tested: passed, flaky and failed", () => {
    const posted: Record<RunStatus, boolean> = {
      passed: true,
      flaky: true,
      failed: true,
      error: false,
      stopped: false,
      killed: false,
    };
    for (const [status, expected] of Object.entries(posted))
      expect(
        datatorPayload(finishedEvent({ status: status as RunStatus })) !==
          undefined,
      ).toBe(expected);
  });

  test("uses AutoE2E's product codes, and any other product's name", () => {
    expect(
      payloadOf({
        unit: { product: "wp-rocket", cell: "apache", edition: null },
      }).product,
    ).toBe("wp_rocket");
    expect(
      payloadOf({ unit: { product: "imagify", cell: "apache", edition: null } })
        .product,
    ).toBe("imagify");
  });

  test("names the suite by its cell, and its filter when the task has one, within 255", () => {
    const event = finishedEvent();
    expect(
      payloadOf({
        run: { ...event.run, task: { ...event.run.task, grep: "@smoke" } },
      }).test_suite,
    ).toBe("pro@nginx @smoke");
    const long = payloadOf({
      run: { ...event.run, task: { ...event.run.task, grep: "x".repeat(500) } },
    }).test_suite;
    expect(Array.from(long)).toHaveLength(255);
  });

  test("counts flaky as successful and skipped as neither", () => {
    const payload = payloadOf({
      counts: {
        total: 10,
        passed: 5,
        flaky: 2,
        failed: 1,
        skipped: 2,
        didNotRun: 0,
      },
      scenarios: [
        scenario({ status: "skipped" }),
        scenario({ status: "interrupted" }),
      ],
    });
    expect(payload).toMatchObject({
      total_tests: 10,
      successful_tests: 7,
      failed_tests: 1,
    });
    expect(payload.test_cases.map((c) => c.status)).toEqual([
      "skipped",
      "skipped",
    ]);
  });

  test("posts the duration in whole seconds", () => {
    expect(payloadOf({ durationMs: 845_700 }).test_duration_seconds).toBe(846);
    expect(payloadOf({ durationMs: 499 }).test_duration_seconds).toBe(0);
    expect(payloadOf({ durationMs: -10 }).test_duration_seconds).toBe(0);
  });

  test("posts a commit only when it is a full one: null for a release, and for anything else", () => {
    const plugin = finishedEvent().plugin;
    expect(
      payloadOf({ plugin: { ...plugin, commit: null } }).git_commit,
    ).toBeNull();
    expect(
      payloadOf({ plugin: { ...plugin, commit: "f1ebfd0" } }).git_commit,
    ).toBeNull();
    const sha256 = "c".repeat(64);
    expect(
      payloadOf({ plugin: { ...plugin, commit: sha256 } }).git_commit,
    ).toBe(sha256);
  });

  test("posts the pool's first site, and null with no site", () => {
    expect(
      payloadOf({
        sites: [
          { baseURL: "https://a.example.com", wordpress: null, php: null },
          { baseURL: "https://b.example.com", wordpress: null, php: null },
        ],
      }).website_url,
    ).toBe("https://a.example.com");
    expect(payloadOf({ sites: [] }).website_url).toBeNull();
  });

  test("posts null for a first site whose address Datator would refuse: a Docker host", () => {
    expect(
      payloadOf({
        sites: [{ baseURL: "http://wp-apache", wordpress: null, php: null }],
      }).website_url,
    ).toBeNull();
  });

  test("prefixes a scenario's name with its Rule and Outline path", () => {
    const [testCase] = payloadOf({
      scenarios: [
        scenario({ path: ["Rule: on demand", "Outline: by size"], name: "x" }),
      ],
    }).test_cases;
    expect(testCase?.test_name).toBe("Rule: on demand › Outline: by size › x");
  });

  test("keeps every name within 500 code points and every error within 4,000", () => {
    const [testCase] = payloadOf({
      scenarios: [
        scenario({
          feature: "😀".repeat(600),
          path: ["p".repeat(300)],
          name: "n".repeat(300),
          error: "e".repeat(10_000),
        }),
      ],
    }).test_cases;
    expect(Array.from(testCase?.feature_name ?? "")).toHaveLength(
      MAX_CASE_NAME,
    );
    expect(Array.from(testCase?.test_name ?? "")).toHaveLength(MAX_CASE_NAME);
    expect(Array.from(testCase?.error_message ?? "")).toHaveLength(
      MAX_CASE_ERROR,
    );
  });

  test("never posts what Datator refuses: a blank name, a lone surrogate, a blank error", () => {
    const [testCase] = payloadOf({
      scenarios: [
        scenario({
          feature: "  ",
          name: "a\ud800b",
          path: [""],
          error: " \n ",
        }),
      ],
    }).test_cases;
    expect(testCase).toEqual({
      feature_name: UNNAMED,
      test_name: "a�b",
      status: "passed",
      error_message: null,
    });
    const [failed] = payloadOf({
      scenarios: [scenario({ status: "failed", error: "x\udc00y" })],
    }).test_cases;
    expect(failed?.error_message).toBe("x�y");
  });
});

test.describe("acceptedUrl", () => {
  test("keeps what Django's URL check accepts, and drops what it might refuse", () => {
    for (const url of [
      "https://simple.e2e.rocketlabsqa.ovh",
      "https://a.test/",
      "http://localhost:8100",
      "http://127.0.0.1:8101/wp",
      "https://xn--bcher-kva.example/",
    ])
      expect(acceptedUrl(url)).toBe(url);
    for (const url of [
      undefined,
      "http://wp-apache",
      "http://wp_apache.test",
      "ftp://a.test",
      "not a url",
      `https://a.test/${"x".repeat(255)}`,
      "https://a.123",
      // Rewritten by a URL parser, so not what Django reads: each refused by it (measured).
      "http://010.1.1.1/",
      "http://127.1/",
      "http://0x7f.0.0.1/",
      "http://2130706433/",
      "http://1.2.3.04/",
      "http://ex%61mple.com/",
      "https://a.com/my site",
      "https://a.com/\u00a0",
      "https://a.com/\tx",
      "https://a.com\\path",
      "http:/a.com",
      "http:a.com",
      "HTTPS://A.COM/",
    ])
      expect(acceptedUrl(url)).toBeNull();
  });

  test("drops a user and password, as the event shows them or not: one series per site, never a credential", () => {
    for (const [url, bare] of [
      ["https://***@a.example.com/wp", "https://a.example.com/wp"],
      ["https://user:pa55word@a.example.com/wp/", "https://a.example.com/wp/"],
      ["http://***@127.0.0.1:8101", "http://127.0.0.1:8101"],
      ["https://u@localhost/", "https://localhost/"],
      [`https://${"u".repeat(300)}@a.example.com`, "https://a.example.com"],
    ])
      expect(acceptedUrl(url)).toBe(bare);
    // Still refused when what is left is not a URL Datator accepts.
    expect(acceptedUrl("http://***@wp-apache/")).toBeNull();
    expect(
      acceptedUrl(`https://***@a.example.com/${"x".repeat(240)}`),
    ).toBeNull();
  });

  test("posts the address of a site whose baseURL holds credentials without them", () => {
    const baseURL = safeSiteUrl(
      "https://user:Sup3rSecretPw@site.example.com/wp",
      300,
      ["Sup3rSecretPw"],
    );
    expect(baseURL).toBe("https://***@site.example.com/wp");
    expect(
      payloadOf({ sites: [{ baseURL, wordpress: null, php: null }] })
        .website_url,
    ).toBe("https://site.example.com/wp");
  });
});

test.describe("sendDatator", () => {
  test("posts the record with its key and succeeds on 201", async () => {
    const sink = await startSink(reply(201, '{"detail":"saved"}'));
    try {
      const payload = payloadOf();
      const sent = await sendDatator(payload, {
        url: `${sink.url}/e2e_tests/results/`,
        apiKey: "api-key-123456",
      });
      expect(sent).toEqual({ ok: true, status: 201 });
      const [request] = sink.requests;
      expect(request?.headers["x-api-key"]).toBe("api-key-123456");
      expect(JSON.parse(request?.body ?? "")).toEqual(payload);
    } finally {
      await sink.close();
    }
  });

  test("fails with Datator's answer on anything else, the key masked", async () => {
    const sink = await startSink(reply(403, "Invalid key api-key-123456"));
    try {
      expect(
        await sendDatator(payloadOf(), {
          url: `${sink.url}/e2e_tests/results/`,
          apiKey: "api-key-123456",
        }),
      ).toEqual({ ok: false, status: 403, detail: "Invalid key ***" });
    } finally {
      await sink.close();
    }
  });

  test("treats 200 as a failure: Datator creates with 201", async () => {
    const sink = await startSink(reply(200, "ok"));
    try {
      expect(
        await sendDatator(payloadOf(), {
          url: `${sink.url}/`,
          apiKey: "k".repeat(10),
        }),
      ).toEqual({ ok: false, status: 200, detail: "ok" });
    } finally {
      await sink.close();
    }
  });
});
