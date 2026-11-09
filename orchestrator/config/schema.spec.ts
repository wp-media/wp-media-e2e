import { test, expect } from "@playwright/test";

import { MAX_REPORTS_KEEP } from "../../src/common/reporting/retention";
import { formatIssues } from "./parse";
import {
  configSchema,
  DEFAULT_COOLDOWN_MINUTES,
  DEFAULT_SERVER_WARNING_THRESHOLD,
  isSlackWebhook,
  isValidGrep,
  MAX_COOLDOWN_MINUTES,
  MAX_RETRIES,
  MAX_SECRET_LENGTH,
  MAX_SERVER_WARNING_THRESHOLD,
} from "./schema";

/** The smallest config the schema accepts: one loop task. */
const TASK = {
  id: "bpng",
  type: "loop",
  product: "backwpup",
  cell: "pro@nginx",
} as const;

/** What a field shown on one line refuses beyond C0 controls. */
const UNSAFE_TEXT = {
  "a line separator": "a b",
  "a paragraph separator": "a b",
  "a next line (C1)": "a\u0085b",
  "a C1 control sequence introducer": "a\u009b31mb",
  DEL: "a\u007fb",
  "a bidi override": "a‮b",
  "a zero-width space": "a​b",
  "half a surrogate pair": "a\ud800b",
  "a newline": "a\nb",
} as const;

/** The message for text that is not plain and on one line. */
const NOT_PLAIN =
  "must be plain text on one line: no control, invisible or line-separator characters";

/**
 * A config of {@link TASK} plus `extra` at the root.
 *
 * @param extra - root fields.
 * @returns the config.
 */
function withRoot(extra: Record<string, unknown>): Record<string, unknown> {
  return { tasks: [TASK], ...extra };
}

/**
 * A config of one task: {@link TASK} with `fields` over it.
 *
 * @param fields - task fields.
 * @returns the config.
 */
function withTask(fields: Record<string, unknown>): Record<string, unknown> {
  return { tasks: [{ ...TASK, ...fields }] };
}

/**
 * The schema's issues for `config`.
 *
 * @param config - anything.
 * @returns one `path: message` line each; `[]` when it is accepted.
 */
function issuesOf(config: unknown): string[] {
  const result = configSchema.safeParse(config);
  return result.success ? [] : formatIssues(result.error.issues);
}

/**
 * The issues of a config holding one secret.
 *
 * @param name - the secret's name.
 * @param value - its value.
 * @returns the issues.
 */
function secretIssues(name: string, value: unknown): string[] {
  return issuesOf(withRoot({ secrets: { [name]: value } }));
}

test.describe("configSchema", () => {
  test("accepts one loop task and fills in the defaults", () => {
    expect(configSchema.parse(withRoot({}))).toEqual({
      tasks: [{ ...TASK, cooldownMinutes: DEFAULT_COOLDOWN_MINUTES }],
      serverWarningThreshold: DEFAULT_SERVER_WARNING_THRESHOLD,
    });
    expect(DEFAULT_COOLDOWN_MINUTES).toBe(5);
    expect(DEFAULT_SERVER_WARNING_THRESHOLD).toBe(5);
  });

  test("accepts every field set, and returns each as written", () => {
    const config = {
      instance: "AutoE2E nginx 🚀",
      tasks: [
        {
          ...TASK,
          name: "BackWPup Pro on nginx",
          plugin: { ref: "develop", version: "9.99.99" },
          cooldownMinutes: 10,
          grep: "@smoke",
        },
      ],
      runs: { retries: 0, reportsKeep: 0 },
      secrets: {
        GITHUB_TOKEN: "t",
        GH_TOKEN: "u",
        BWP_FTP_PASSWORD: " pass word ",
      },
      notifications: {
        slack: { webhookUrl: "https://hooks.slack.com/services/T0/B0/x" },
        datator: { url: "https://datator.example/results/", apiKey: "k" },
      },
      reports: { sshHost: "ubuntu@auto-e2e" },
      serverWarningThreshold: 1,
    };
    expect(configSchema.parse(config)).toEqual(config);
  });

  test("refuses anything but an object with tasks", () => {
    expect(issuesOf("text")).toEqual([
      "(root): Invalid input: expected object, received string",
    ]);
    expect(issuesOf({})).toEqual([
      "tasks: Invalid input: expected array, received undefined",
    ]);
    expect(issuesOf({ tasks: [] })).toEqual([
      "tasks: must list at least one task",
    ]);
  });

  test("refuses a misspelt key at every level, naming it", () => {
    expect(issuesOf(withRoot({ task: [], runz: {} }))).toEqual([
      "(root): no such setting: task, runz",
    ]);
    expect(issuesOf(withTask({ cooldown: 5 }))).toEqual([
      "tasks[0]: no such setting: cooldown",
    ]);
    expect(issuesOf(withTask({ plugin: { zip: "a.zip" } }))).toEqual([
      "tasks[0].plugin: no such setting: zip",
    ]);
    expect(issuesOf(withRoot({ runs: { retry: 1 } }))).toEqual([
      "runs: no such setting: retry",
    ]);
    expect(issuesOf(withRoot({ notifications: { teams: {} } }))).toEqual([
      "notifications: no such setting: teams",
    ]);
    expect(
      issuesOf(withRoot({ notifications: { slack: { url: "x" } } })),
    ).toEqual([
      "notifications.slack.webhookUrl: Invalid input: expected string, received undefined",
      "notifications.slack: no such setting: url",
    ]);
    expect(issuesOf(withRoot({ reports: { host: "x" } }))).toEqual([
      "reports: no such setting: host",
    ]);
  });

  test("an unknown key is never shown raw: no forged line, no escape, no pasted token", () => {
    expect(issuesOf(withRoot({ "x\n  tasks[0].cell: forged": 1 }))).toEqual([
      "(root): no such setting: a key of 25 characters",
    ]);
    expect(issuesOf(withRoot({ "x\u001b[2J": 1 }))).toEqual([
      "(root): no such setting: a key of 5 characters",
    ]);
    expect(
      issuesOf(withTask({ ghp_0123456789abcdefghijklmnopqrstuvwxyz: 1 })),
    ).toEqual(["tasks[0]: no such setting: a key of 40 characters"]);
  });

  test.describe("a task's id", () => {
    for (const id of ["bpng", "k7qx", "z999", "a2b3"])
      test(`accepts ${id}`, () => {
        expect(issuesOf(withTask({ id }))).toEqual([]);
      });

    for (const id of [
      "abc",
      "abcde",
      "Abcd",
      "7abc",
      "boat",
      "bill",
      "bike",
      "b0at",
      "b1at",
      "ab-c",
      "",
    ])
      test(`refuses "${id}"`, () => {
        expect(issuesOf(withTask({ id }))).toEqual([
          "tasks[0].id: must be 4 characters: a lowercase letter, then lowercase letters or digits, without 0, o, 1, l or i (e.g. k7qx)",
        ]);
      });
  });

  test("a task is a loop, said explicitly", () => {
    const loopOnly = ['tasks[0].type: must be "loop", the only type for now'];
    expect(issuesOf(withTask({ type: "scheduled" }))).toEqual(loopOnly);
    expect(issuesOf(withTask({ type: undefined }))).toEqual(loopOnly);
  });

  test.describe("names, instances, products and cells are plain text on one line", () => {
    test("not empty, not padded, not too long", () => {
      expect(issuesOf(withTask({ name: "" }))).toEqual([
        "tasks[0].name: must not be empty",
      ]);
      // Padding stops the checks: one message, though the text is not plain either.
      expect(issuesOf(withTask({ name: " Pro\u0001" }))).toEqual([
        "tasks[0].name: must not start or end with whitespace",
      ]);
      expect(issuesOf(withTask({ name: "x".repeat(100) }))).toEqual([]);
      expect(issuesOf(withTask({ name: "x".repeat(101) }))).toEqual([
        "tasks[0].name: must be at most 100 characters",
      ]);
      expect(issuesOf(withTask({ product: 5, cell: "" }))).toEqual([
        "tasks[0].product: Invalid input: expected string, received number",
        "tasks[0].cell: must not be empty",
      ]);
    });

    for (const [what, text] of Object.entries(UNSAFE_TEXT))
      test(`refuses ${what}`, () => {
        expect(
          issuesOf({
            instance: text,
            tasks: [{ ...TASK, name: text, product: text, cell: text }],
          }),
        ).toEqual([
          `instance: ${NOT_PLAIN}`,
          `tasks[0].name: ${NOT_PLAIN}`,
          `tasks[0].product: ${NOT_PLAIN}`,
          `tasks[0].cell: ${NOT_PLAIN}`,
        ]);
      });
  });

  test("a plugin's ref and version are single tokens that cannot read as options", () => {
    expect(issuesOf(withTask({ plugin: {} }))).toEqual([]);
    expect(
      issuesOf(withTask({ plugin: { ref: "release:latest-stable" } })),
    ).toEqual([]);
    expect(issuesOf(withTask({ plugin: { ref: "feature/x y" } }))).toEqual([
      "tasks[0].plugin.ref: must not contain whitespace",
    ]);
    expect(issuesOf(withTask({ plugin: { ref: "dev elop" } }))).toEqual([
      "tasks[0].plugin.ref: must not contain whitespace",
    ]);
    expect(issuesOf(withTask({ plugin: { ref: "dev\u0085elop" } }))).toEqual([
      `tasks[0].plugin.ref: ${NOT_PLAIN}`,
    ]);
    expect(
      issuesOf(withTask({ plugin: { ref: "--upload-pack=x", version: "-1" } })),
    ).toEqual([
      'tasks[0].plugin.ref: must not start with "-"',
      'tasks[0].plugin.version: must not start with "-"',
    ]);
    expect(issuesOf(withTask({ plugin: { version: "" } }))).toEqual([
      "tasks[0].plugin.version: must not be empty",
    ]);
    expect(issuesOf(withTask({ plugin: { ref: "x".repeat(201) } }))).toEqual([
      "tasks[0].plugin.ref: must be at most 200 characters",
    ]);
  });

  test("a cooldown is whole minutes, from one to a day", () => {
    for (const cooldownMinutes of [1, MAX_COOLDOWN_MINUTES])
      expect(issuesOf(withTask({ cooldownMinutes }))).toEqual([]);
    expect(MAX_COOLDOWN_MINUTES).toBe(1440);
    // One message whichever way it misses: 0.5 is neither whole nor in range.
    for (const cooldownMinutes of [0, 0.5, 1441, 2.5, "5", 1e300, null])
      expect(issuesOf(withTask({ cooldownMinutes }))).toEqual([
        "tasks[0].cooldownMinutes: must be a whole number from 1 to 1440 minutes",
      ]);
  });

  test("a grep is a regular expression Playwright accepts, 500 characters at most", () => {
    expect(issuesOf(withTask({ grep: "@smoke|@cli" }))).toEqual([]);
    expect(issuesOf(withTask({ grep: "x".repeat(500) }))).toEqual([]);
    expect(issuesOf(withTask({ grep: "x".repeat(501) }))).toEqual([
      "tasks[0].grep: must be at most 500 characters",
    ]);
    expect(issuesOf(withTask({ grep: "(" }))).toEqual([
      "tasks[0].grep: must be a regular expression Playwright's --grep accepts",
    ]);
  });

  test.describe("the same id twice, or the same cell twice", () => {
    const other = { ...TASK, id: "k7qx", cell: "free@nginx" };

    test("is refused at the repeat", () => {
      expect(issuesOf({ tasks: [TASK, { ...other, id: TASK.id }] })).toEqual([
        "tasks[1].id: repeats tasks[0].id: ids are unique",
      ]);
      expect(
        issuesOf({ tasks: [TASK, other, { ...TASK, id: "w4tz" }] }),
      ).toEqual([
        "tasks[2].cell: repeats tasks[0]'s product and cell: a cell has one task, so it never runs twice at once",
      ]);
      // The same cell name under another product is another cell.
      expect(
        issuesOf({
          tasks: [TASK, { ...TASK, id: "w4tz", product: "wp-rocket" }],
        }),
      ).toEqual([]);
    });

    test("is reported beside an issue that does not abort, and only after one that does", () => {
      expect(
        issuesOf({
          tasks: [TASK, { ...TASK, grep: "(" }],
          runs: { retries: 99 },
        }),
      ).toEqual([
        "tasks[1].grep: must be a regular expression Playwright's --grep accepts",
        "runs.retries: must be a whole number from 0 to 10",
        "tasks[1].id: repeats tasks[0].id: ids are unique",
        "tasks[1].cell: repeats tasks[0]'s product and cell: a cell has one task, so it never runs twice at once",
      ]);
      expect(issuesOf({ tasks: [TASK, { ...TASK, name: " x" }] })).toEqual([
        "tasks[1].name: must not start or end with whitespace",
      ]);
    });
  });

  test("runs: retries within the suite's bounds, a report cap within retention's", () => {
    expect(MAX_RETRIES).toBe(10);
    expect(
      issuesOf(
        withRoot({
          runs: { retries: MAX_RETRIES, reportsKeep: MAX_REPORTS_KEEP },
        }),
      ),
    ).toEqual([]);
    expect(
      issuesOf(withRoot({ runs: { retries: 11, reportsKeep: -1 } })),
    ).toEqual([
      "runs.retries: must be a whole number from 0 to 10",
      `runs.reportsKeep: must be a whole number from 0 to ${String(MAX_REPORTS_KEEP)}`,
    ]);
    expect(
      issuesOf(withRoot({ runs: { reportsKeep: MAX_REPORTS_KEEP + 1 } })),
    ).toEqual([
      `runs.reportsKeep: must be a whole number from 0 to ${String(MAX_REPORTS_KEEP)}`,
    ]);
    expect(issuesOf(withRoot({ runs: { retries: 1.5 } }))).toEqual([
      "runs.retries: must be a whole number from 0 to 10",
    ]);
  });

  test.describe("secrets", () => {
    test("only GITHUB_TOKEN, GH_TOKEN and BWP_* — what a run receives", () => {
      expect(
        issuesOf(withRoot({ secrets: { BWP_S3_REGION: "eu", GH_TOKEN: "x" } })),
      ).toEqual([]);
      for (const name of [
        "NPM_TOKEN",
        "bwp_ftp_host",
        "BWP_",
        "GITHUB_TOKEN_2",
        "PATH",
      ])
        expect(secretIssues(name, "x")).toEqual([
          `secrets.${name}: is not a secret a run receives: only GITHUB_TOKEN, GH_TOKEN and BWP_*`,
        ]);
    });

    test("a name that is not a name is described, never shown", () => {
      expect(
        secretIssues(
          "ghp_0123456789abcdefghijklmnopqrstuvwxyz",
          "GITHUB_TOKEN",
        ),
      ).toEqual([
        "secrets[a key of 40 characters]: is not a secret a run receives: only GITHUB_TOKEN, GH_TOKEN and BWP_*",
      ]);
      expect(secretIssues("GITHUB_TOKEN=abc", "")).toEqual([
        "secrets[a key of 16 characters]: is not a secret a run receives: only GITHUB_TOKEN, GH_TOKEN and BWP_*",
      ]);
    });

    test("a value is a string, not empty, not too long, without controls or broken Unicode", () => {
      expect(secretIssues("BWP_FTP_PASSWORD", "")).toEqual([
        "secrets.BWP_FTP_PASSWORD: must not be empty",
      ]);
      expect(secretIssues("BWP_FTP_PASSWORD", 5)).toEqual([
        "secrets.BWP_FTP_PASSWORD: must be a string",
      ]);
      expect(MAX_SECRET_LENGTH).toBe(32_768);
      expect(
        secretIssues("BWP_FTP_PASSWORD", "x".repeat(MAX_SECRET_LENGTH)),
      ).toEqual([]);
      expect(
        secretIssues("BWP_FTP_PASSWORD", "x".repeat(MAX_SECRET_LENGTH + 1)),
      ).toEqual(["secrets.BWP_FTP_PASSWORD: must be at most 32768 characters"]);
      for (const value of [
        "a\u0000b",
        "pass\n",
        "a\u007fb",
        "a\u0085b",
        "a\ud800b",
      ])
        expect(secretIssues("BWP_FTP_PASSWORD", value)).toEqual([
          "secrets.BWP_FTP_PASSWORD: must not contain control characters or broken Unicode",
        ]);
    });

    test("a storage password keeps its spaces, as the suite reads it", () => {
      expect(secretIssues("BWP_FTP_PASSWORD", " pass word ")).toEqual([]);
      expect(secretIssues("BWP_S3_SECRET_ACCESS_KEY", "é😀")).toEqual([]);
    });

    test("a GitHub token is printable ASCII without spaces", () => {
      expect(secretIssues("GITHUB_TOKEN", "ghp_abc")).toEqual([]);
      for (const [name, value] of [
        ["GITHUB_TOKEN", "ghp_abc "],
        ["GH_TOKEN", " ghp_abc"],
        ["GH_TOKEN", "ghp é"],
      ] as const)
        expect(secretIssues(name, value)).toEqual([
          `secrets.${name}: must be printable ASCII without spaces, as a GitHub token is — a pasted newline or space included`,
        ]);
    });
  });

  test.describe("notifications", () => {
    /**
     * The issues of a config whose Slack webhook is `webhookUrl`.
     *
     * @param webhookUrl - the URL.
     * @returns the issues.
     */
    const slack = (webhookUrl: string): string[] =>
      issuesOf(withRoot({ notifications: { slack: { webhookUrl } } }));
    /**
     * The issues of a config whose Datator URL is `url` and key `apiKey`.
     *
     * @param url - the URL.
     * @param apiKey - the key.
     * @returns the issues.
     */
    const datator = (url: string, apiKey = "k"): string[] =>
      issuesOf(withRoot({ notifications: { datator: { url, apiKey } } }));
    /** Datator's URL message for anything but a plain https URL. */
    const notPlainUrl =
      "notifications.datator.url: must be a plain https:// URL, written as a browser would show it: no user, password, port, query or fragment";

    test("Slack takes an incoming webhook only", () => {
      expect(slack("https://hooks.slack.com/services/T0/B0/x")).toEqual([]);
      for (const url of [
        "http://hooks.slack.com/services/T0/B0/x",
        "https://HOOKS.slack.com/services/T0/B0/x",
        "https:hooks.slack.com/services/x",
        "https://@hooks.slack.com/services/x",
        "https://hooks.slack.com/services/%2e%2e/api/x",
        "https://hooks.slack.com/services/../api",
        "https://hooks.slack.com.evil.example/services/x",
        "https://hooks.slack.com./services/x",
        "https://hooks.slack.com/workflows/x",
        "https://hooks.slack.com/services/",
        "https://u:p@hooks.slack.com/services/x",
        "https://:p@hooks.slack.com/services/x",
        "https://u@hooks.slack.com/services/x",
        "https://hooks.slack.com:8443/services/x",
        "https://hooks.slack.com:443/services/x",
        "https://hooks.slack.com/services/x?y=1",
        "https://hooks.slack.com/services/x#y",
        "https://hooks.slack.com/services/x\n",
        " https://hooks.slack.com/services/x",
        "https:\\\\hooks.slack.com\\services\\x",
        "hooks.slack.com/services/x",
      ])
        expect(slack(url), url).toEqual([
          "notifications.slack.webhookUrl: must be a Slack incoming webhook as Slack gives it: https://hooks.slack.com/services/…, nothing added",
        ]);
    });

    test("Datator takes a plain https URL whose path ends with a slash", () => {
      expect(datator("https://datator.wp-media.me/e2e_tests/results/")).toEqual(
        [],
      );
      for (const url of [
        "https://datator.wp-media.me/e2e_tests/results",
        "https://datator.wp-media.me/a/b.json",
      ])
        expect(datator(url), url).toEqual([
          'notifications.datator.url: must end with "/": without it Datator redirects, and the redirect drops the results',
        ]);
      for (const url of [
        "http://datator.example/",
        "not a url",
        "https://u:p@d.example/",
        "https://:p@d.example/",
        "https://u@d.example/",
        "https://d.example:8443/",
        "https://d.example:443/",
        "https://d.example/r#/",
        "https://d.example/r?/",
        "https://d.example/r/?api_key=x",
        "https://d.example/res\nults/",
        "https://d.example\\r/",
        "https://@d.example/r/",
        "https:d.example/r/",
        "https://D.example/r/",
        "https://d.example/%2e%2e/r/",
        "https://d.éxample/r/",
      ])
        expect(datator(url), url).toEqual([notPlainUrl]);
    });

    test("Datator's key is what an HTTP header can carry", () => {
      expect(datator("https://d.example/", "a1-B2_c3.~")).toEqual([]);
      for (const apiKey of ["key Ā", "key with space", "é"])
        expect(datator("https://d.example/", apiKey)).toEqual([
          "notifications.datator.apiKey: must be printable ASCII without spaces, as an HTTP header is",
        ]);
    });

    test("each subscriber is optional", () => {
      expect(issuesOf(withRoot({ notifications: {} }))).toEqual([]);
    });
  });

  test("an scp host is a host or user@host, neither part an option", () => {
    /**
     * The issues of a config whose scp host is `sshHost`.
     *
     * @param sshHost - the host.
     * @returns the issues.
     */
    const host = (sshHost: string): string[] =>
      issuesOf(withRoot({ reports: { sshHost } }));
    for (const ok of [
      "auto-e2e",
      "ubuntu@10.0.0.4",
      "qa_lnmp.example.com",
      "e2e-runner.1@qa-lnmp",
    ])
      expect(host(ok)).toEqual([]);
    expect(host("a".repeat(255))).toEqual([]);
    expect(host("a".repeat(256))).toEqual([
      "reports.sshHost: must be at most 255 characters",
    ]);
    for (const bad of [
      "-oProxyCommand=x",
      "-oX@host",
      "a@-oProxyCommand",
      "user@",
      "a@b@c",
      "a b",
      "",
      "a;b",
    ])
      expect(host(bad), bad).toEqual([
        "reports.sshHost: must be a host name or alias for scp, optionally user@host, without spaces",
      ]);
  });

  test("a bundle's mode and traces are among their choices, each optional, nothing else", () => {
    /**
     * The issues of a config whose bundle is `bundle`.
     *
     * @param bundle - `reports.bundle`.
     * @returns the issues.
     */
    const bundle = (value: unknown): string[] =>
      issuesOf(withRoot({ reports: { bundle: value } }));
    for (const mode of ["archive", "folder", "both", "none"])
      expect(bundle({ mode }), mode).toEqual([]);
    for (const traces of ["strip", "keep"])
      expect(bundle({ traces }), traces).toEqual([]);
    expect(bundle({})).toEqual([]);
    expect(bundle({ mode: "zip" })).toEqual([
      'reports.bundle.mode: Invalid option: expected one of "archive"|"folder"|"both"|"none"',
    ]);
    expect(bundle({ traces: "drop" })).toEqual([
      'reports.bundle.traces: Invalid option: expected one of "strip"|"keep"',
    ]);
    expect(bundle({ mode: "archive", tar: "gz" })).toEqual([
      "reports.bundle: no such setting: tar",
    ]);
    expect(
      configSchema.parse(
        withRoot({ reports: { bundle: { mode: "both", traces: "keep" } } }),
      ).reports,
    ).toEqual({ bundle: { mode: "both", traces: "keep" } });
  });

  test("a server warning threshold is a whole number from 1", () => {
    expect(
      issuesOf(
        withRoot({ serverWarningThreshold: MAX_SERVER_WARNING_THRESHOLD }),
      ),
    ).toEqual([]);
    for (const serverWarningThreshold of [0, 1001, 2 ** 53])
      expect(issuesOf(withRoot({ serverWarningThreshold }))).toEqual([
        "serverWarningThreshold: must be a whole number from 1 to 1000",
      ]);
  });

  test("no message quotes a value, wherever the value is wrong", () => {
    const secret = "s3cret-VALUE";
    const messages = issuesOf({
      instance: [secret],
      tasks: [
        {
          id: secret,
          name: `${secret}\n`,
          type: secret,
          product: { secret },
          cell: ` ${secret}`,
          plugin: { ref: `${secret} x`, version: secret.repeat(50) },
          cooldownMinutes: secret,
          grep: `(${secret}`,
        },
      ],
      runs: { retries: secret, reportsKeep: secret },
      secrets: {
        GITHUB_TOKEN: ` ${secret}`,
        GH_TOKEN: 7,
        BWP_X: `${secret}\n`,
      },
      notifications: {
        slack: { webhookUrl: `https://hooks.slack.com/workflows/${secret}` },
        datator: { url: `https://d.example/${secret}`, apiKey: `${secret} x` },
      },
      reports: { sshHost: `-${secret}` },
      serverWarningThreshold: secret,
    }).join("\n");
    expect(messages.split("\n").length).toBeGreaterThan(15);
    expect(messages).not.toContain(secret);
  });
});

test.describe("isValidGrep", () => {
  test("reads /source/flags as Playwright does, anything else as a source", () => {
    expect(isValidGrep("@smoke")).toBe(true);
    expect(isValidGrep("/@smoke/i")).toBe(true);
    expect(isValidGrep("/(/")).toBe(false);
    expect(isValidGrep("(")).toBe(false);
    expect(isValidGrep("/a/gg")).toBe(false);
    // Read with Playwright's own flags, never stricter ones: `v` refuses an unescaped "(" in a class.
    expect(isValidGrep("[(]")).toBe(true);
    // Not /source/flags (an `m` flag), so all of it is a source — a valid one.
    expect(isValidGrep("/a/m")).toBe(true);
  });
});

test.describe("isSlackWebhook", () => {
  test("is the hook's own URL, nothing around it", () => {
    expect(isSlackWebhook("https://hooks.slack.com/services/T0/B0/x")).toBe(
      true,
    );
    expect(isSlackWebhook("https://hooks.slack.com/services//x")).toBe(false);
  });
});
