import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { TestResult } from "@playwright/test/reporter";

import { step } from "../__fixtures__/reporter-fakes";
import { MAX_COMBINING_MARKS } from "../text";
import {
  RERUN_LIMIT,
  attachmentPaths,
  failureBlockLines,
  failureFacts,
  grepPattern,
  pathsWithheld,
  pluginPin,
  rerunCommand,
  type FailureFacts,
} from "./failure-block";
import type { PluginFact } from "./setup-facts";
import { terminalStyle } from "./terminal-lines";

/**
 * The failure block's pure parts: the `--grep` pattern built from a raw title, the plugin pin, the
 * rerun command (and when it is refused), attachment paths, and the block's lines. Patterns are
 * checked the way Playwright reads a `--grep` value, and every command word through real shells.
 */

/**
 * Playwright's own reading of a `--grep` value (`forceRegExp`, `playwright/lib/util.js` 1.63): a
 * value wrapped in slashes is a pattern with the flags after it; anything else is matched with `gi`.
 */
function playwrightGrep(value: string): RegExp {
  const match = /^\/(.*)\/([gi]*)$/.exec(value);
  return match === null
    ? new RegExp(value, "gi")
    : new RegExp(match[1] ?? "", match[2]);
}

/**
 * A test as Playwright's grep sees it: its file and each describe, each title with its tags, then its
 * own title and tags.
 */
interface GrepTarget {
  readonly above?: readonly (readonly [string, ...string[]])[];
  readonly title: string;
  readonly tags?: readonly string[];
}

/** The file and Feature {@link selects} puts a test in by default. */
const ABOVE = ["f.feature.spec.js", "Feature"] as const;

/**
 * Whether `--grep=<value>` selects a test, matched against the text Playwright builds for it
 * (`_grepTitleWithTags`, 1.63): the root's empty title, the project, then the file and each describe
 * — each title followed by its tags — the test's title, its tags, joined by spaces. By default the
 * test sits in {@link ABOVE}, neither tagged, and carries `@noauth`, as playwright-bdd puts a
 * scenario's tags on the test.
 */
function selects(value: string, target: GrepTarget | string): boolean {
  const test = typeof target === "string" ? { title: target } : target;
  const above = test.above ?? ABOVE.map((title) => [title] as const);
  const text = [
    "",
    "x",
    ...above.flat(),
    test.title,
    ...(test.tags ?? ["@noauth"]),
  ].join(" ");
  const pattern = playwrightGrep(value);
  pattern.lastIndex = 0;
  return pattern.test(text);
}

/** {@link grepPattern} for a scenario where {@link selects} puts it by default ({@link ABOVE}). */
function featurePattern(title: string): string {
  return grepPattern(title, ABOVE);
}

/** The pattern {@link grepPattern} builds around escaped parts: each followed by its tags, to the end. */
function anchored(...parts: string[]): string {
  return `/ ${parts.map((part) => `${part}(?: @\\S+)*`).join(" ")}$/`;
}

/** The titles a person can write in a `.feature` file, and some nobody should. */
const NASTY_TITLES: readonly string[] = [
  "Create a backup",
  "Regex metachars .*+?^${}()|[]\\ all of them",
  "Quotes 'single' and \"double\"",
  "A $HOME and $(rm -rf ~) and `whoami`",
  "Slashes /like/ a /regex/i",
  "/starts and ends with a slash/",
  "Emoji 👩‍💻 and flags 🇺🇦 and CJK 漢字",
  "A tab\there, a newline\nthere, a CR\r",
  "An escape \u001b[31mred\u001b[0m and an OSC \u001b]0;title\u0007",
  "A bidi override ‮reversed‬ and a zero-width​space",
  `Zalgo a${"́".repeat(30)}`,
  "A lone surrogate \ud800 here",
  "!history and ~tilde and *glob? and [class]",
  "Ends with a backslash \\",
];

test.describe("grepPattern", () => {
  for (const title of NASTY_TITLES) {
    test(`selects its own title and holds no control: ${JSON.stringify(title).slice(0, 50)}`, () => {
      const pattern = featurePattern(title);
      expect(pattern.startsWith("/") && pattern.endsWith("/")).toBe(true);
      expect(selects(pattern, title)).toBe(true);
      expect(pattern).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u);
      // Playwright reads the slashes, so the pattern is case-sensitive and has no flags.
      expect(playwrightGrep(pattern).flags).toBe("");
    });
  }

  test("matches literally: metacharacters select only the title they spell", () => {
    expect(selects(featurePattern("a.c"), "abc")).toBe(false);
    expect(selects(featurePattern("a+"), "aaa")).toBe(false);
    expect(selects(featurePattern("(x)"), "x")).toBe(false);
    expect(selects(featurePattern("Create a backup"), "create a backup")).toBe(
      false,
    );
  });

  test("selects the scenario and its exact duplicates only: never a title that holds it", () => {
    const pattern = featurePattern("Create a backup");
    expect(pattern).toBe(
      anchored("f\\.feature\\.spec\\.js", "Feature", "Create a backup"),
    );
    expect(selects(pattern, "Create a backup")).toBe(true);
    expect(selects(pattern, { title: "Create a backup", tags: [] })).toBe(true);
    expect(
      selects(pattern, {
        title: "Create a backup",
        tags: ["@featuretag", "@noauth", "@slow"],
      }),
    ).toBe(true);
    for (const other of [
      "Create a backup encrypted",
      "Untagged Create a backup",
      "Create a backups",
      "create a backup",
    ]) {
      expect(selects(pattern, other), other).toBe(false);
    }
    // A tag-like word that is not a tag (no space before it) is part of another title.
    expect(selects(pattern, "Create a backup@x")).toBe(false);
  });

  test("the file and describes anchor it too: the same title in another file, feature, Rule or Outline is not selected", () => {
    const file = ".features-gen/backwpup/pro@nginx/b.feature.spec.js";
    const pattern = grepPattern("Example #1", [file, "Backups", "Outline <n>"]);
    expect(
      selects(pattern, {
        above: [[file, "@config"], ["Backups", "@featuretag"], ["Outline <n>"]],
        title: "Example #1",
      }),
    ).toBe(true);
    for (const above of [
      [[file], ["Restores"], ["Outline <n>"]],
      [[file], ["Old Backups"], ["Outline <n>"]],
      [[file], ["Backups"], ["Other outline <n>"]],
      [[file], ["Backups"]],
      [
        [".features-gen/backwpup/pro@apache/b.feature.spec.js"],
        ["Backups"],
        ["Outline <n>"],
      ],
      [[`x${file}`], ["Backups"], ["Outline <n>"]],
      [["b.feature.spec.js"], ["Backups"], ["Outline <n>"]],
    ] as const) {
      expect(
        selects(pattern, { above, title: "Example #1" }),
        JSON.stringify(above),
      ).toBe(false);
    }
  });

  test("an untitled describe is left out, as Playwright leaves it out of the text it matches", () => {
    expect(grepPattern("t", ["", "F", ""])).toBe(grepPattern("t", ["F"]));
  });

  test("controls, format characters and lone surrogates become \\u escapes", () => {
    expect(grepPattern("a\u001bb")).toBe(anchored("a\\u001bb"));
    expect(grepPattern("a\nb\tc")).toBe(anchored("a\\u000ab\\u0009c"));
    expect(grepPattern("x‮y")).toBe(anchored("x\\u202ey"));
    expect(grepPattern("x y")).toBe(anchored("x\\u2028y"));
    expect(grepPattern("\ud800")).toBe(anchored("\\ud800"));
    // An astral format character (a tag, as in a subdivision flag) as its two units.
    expect(grepPattern("\u{e0067}")).toBe(anchored("\\udb40\\udc67"));
    // In a describe as much as in the title.
    expect(grepPattern("t", ["F\u001b"])).toBe(anchored("F\\u001b", "t"));
  });

  test(`combining marks past ${String(MAX_COMBINING_MARKS)} in a run are escaped, the first kept`, () => {
    const pattern = grepPattern(`a${"́".repeat(10)}`);
    expect(pattern).toBe(
      anchored(`a${"́".repeat(MAX_COMBINING_MARKS)}\\u0301\\u0301`),
    );
  });

  test("an empty title selects only an empty-titled scenario of its feature, never everything", () => {
    const pattern = featurePattern("");
    expect(selects(pattern, "")).toBe(true);
    expect(selects(pattern, "anything")).toBe(false);
  });
});

test.describe("pluginPin", () => {
  const sha = "af1ab5c4d2e6f8a0b1c3d5e7f9a1b3c5d7e9f1a3";
  const built: PluginFact = {
    role: "plugin",
    ok: true,
    ref: "develop",
    commit: sha,
    version: "9.99.99",
    source: "default-ref",
  };

  test("a build: its commit in the pin form, `commit:<sha>`, with the version its zip declares", () => {
    const pin = { kind: "build", ref: `commit:${sha}`, version: "9.99.99" };
    expect(pluginPin(built, {}, true)).toEqual(pin);
    // Over what the operator gave: a moving ref, or a version the build already carries.
    expect(
      pluginPin(
        { ...built, source: "env-ref" },
        { ref: "develop", version: "1.0.0" },
        true,
      ),
    ).toEqual(pin);
    // A run of every cell pins it too: the record is proof of what was built.
    expect(pluginPin(built, {}, false)).toEqual(pin);
    const unversioned: PluginFact = {
      role: "plugin",
      ok: true,
      commit: sha,
      source: "default-ref",
    };
    expect(pluginPin(unversioned, {}, true)).toEqual({
      kind: "build",
      ref: `commit:${sha}`,
    });
  });

  test("a release download: the tag it resolved to, never the selector asked for, and no version", () => {
    const release: PluginFact = {
      role: "plugin",
      ok: true,
      ref: "release:latest-stable",
      pin: "release:3.17.4",
      version: "3.17.4",
      source: "env-ref",
    };
    expect(pluginPin(release, { ref: "release:latest-stable" }, true)).toEqual({
      kind: "build",
      ref: "release:3.17.4",
    });
    // Checked before the commit: pinning a release to a commit would build its source.
    expect(pluginPin({ ...release, commit: sha }, {}, true)).toEqual({
      kind: "build",
      ref: "release:3.17.4",
    });
  });

  test("a pin that is not a resolved release is not trusted", () => {
    for (const pin of ["release:", "release:a b", "release:x:y", "develop"]) {
      expect(
        pluginPin(
          { ...built, commit: "release-x", pin },
          { ref: "main" },
          true,
        ),
        pin,
      ).toEqual({ kind: "build", ref: "main" });
    }
  });

  test("the operator's zip when the setup used it", () => {
    const zipped: PluginFact = {
      role: "plugin",
      ok: true,
      zip: "p.zip",
      source: "env-zip",
    };
    for (const targeted of [true, false]) {
      expect(pluginPin(zipped, { zip: "/z/p.zip" }, targeted)).toEqual({
        kind: "zip",
        zip: "/z/p.zip",
      });
    }
    // Used, but its path unknown here: no pin rather than another build.
    expect(pluginPin(zipped, { ref: "develop" }, true)).toBeUndefined();
  });

  test("a zip set but not used (the setup built a ref) gives way to the build", () => {
    expect(pluginPin(built, { zip: "/z/p.zip" }, true)).toEqual({
      kind: "build",
      ref: `commit:${sha}`,
      version: "9.99.99",
    });
  });

  test("no record of a build: what the operator set — the zip, else the ref and version", () => {
    const failed: PluginFact = { role: "plugin", ok: false, error: "x" };
    expect(pluginPin(failed, { zip: "z.zip", ref: "r" }, true)).toEqual({
      kind: "zip",
      zip: "z.zip",
    });
    expect(pluginPin(undefined, { zip: "z.zip" }, true)).toEqual({
      kind: "zip",
      zip: "z.zip",
    });
    expect(pluginPin(failed, { ref: "pr/12", version: "2.0" }, true)).toEqual({
      kind: "build",
      ref: "pr/12",
      version: "2.0",
    });
    expect(pluginPin(undefined, { ref: "pr/12" }, true)).toEqual({
      kind: "build",
      ref: "pr/12",
    });
    expect(pluginPin(undefined, { version: "2.0" }, true)).toEqual({
      kind: "build",
      version: "2.0",
    });
    expect(pluginPin(undefined, {}, true)).toBeUndefined();
    expect(pluginPin({ role: "plugin", ok: true }, {}, true)).toBeUndefined();
  });

  test("a run of every cell ignored what the operator set: with no record, no pin", () => {
    const set = { zip: "z.zip", ref: "pr/12", version: "2.0" };
    expect(pluginPin(undefined, set, false)).toBeUndefined();
    expect(
      pluginPin({ role: "plugin", ok: false, error: "x" }, set, false),
    ).toBeUndefined();
  });

  test("a commit that is not a full one is not trusted", () => {
    for (const commit of [
      "develop",
      "abc",
      "abcdef1",
      "$(id)",
      "g".repeat(40),
      sha.toUpperCase(),
      `${sha}0`,
      "abcdef1 x",
      `${sha} && rm -rf ~`,
      "release-3.17.4",
    ]) {
      expect(
        pluginPin({ ...built, commit }, { ref: "main" }, true),
        commit,
      ).toEqual({ kind: "build", ref: "main" });
    }
  });
});

/**
 * What each shell makes of a command line's last word: run `printf '%s'` over it and read the bytes
 * back. A shell that is not installed is left out.
 */
function shellsRead(word: string): Map<string, string> {
  const read = new Map<string, string>();
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"]) {
    if (!existsSync(shell)) continue;
    const child = spawnSync(shell, ["-c", `printf '%s' ${word}`], {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
    });
    read.set(shell, child.stdout);
  }
  return read;
}

/**
 * What each shell makes of an assignment word put before a command, as the rerun command puts its
 * variables: the variable's value, read back by `printenv`.
 */
function shellsAssign(name: string, word: string): Map<string, string> {
  const read = new Map<string, string>();
  for (const shell of ["/bin/sh", "/bin/bash", "/bin/zsh", "/bin/dash"]) {
    if (!existsSync(shell)) continue;
    const child = spawnSync(
      shell,
      ["-c", `${word} /usr/bin/printenv ${name}`],
      {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin", HOME: "/nonexistent" },
      },
    );
    read.set(shell, child.stdout.replace(/\n$/, ""));
  }
  return read;
}

test.describe("rerunCommand", () => {
  const pattern = anchored("Backups", "Create a backup");

  test("the cell, the build, the product's script and the scenario's pattern, each one shell word", () => {
    expect(
      rerunCommand(
        {
          product: "backwpup",
          cell: "pro@nginx",
          pin: {
            kind: "build",
            ref: "commit:af1ab5c4d2",
            version: "9.99.99",
          },
        },
        { title: "Create a backup", above: ["Backups"] },
      ),
    ).toEqual({
      command: `E2E_CELL=pro@nginx E2E_PLUGIN_REF=commit:af1ab5c4d2 E2E_PLUGIN_VERSION=9.99.99 npm run test:backwpup -- --grep='${pattern}'`,
    });
  });

  test("a build pinned by its version alone; a zip with a space is quoted; no cell when unknown", () => {
    expect(
      rerunCommand(
        { product: "p", cell: "x", pin: { kind: "build", version: "2.0" } },
        { title: "t" },
      ),
    ).toEqual({
      command: `E2E_CELL=x E2E_PLUGIN_VERSION=2.0 npm run test:p -- --grep='${anchored("t")}'`,
    });
    expect(
      rerunCommand(
        { product: "wp-rocket", pin: { kind: "zip", zip: "/my zips/r.zip" } },
        { title: "Cache" },
      ),
    ).toEqual({
      command: `E2E_PLUGIN_ZIP='/my zips/r.zip' npm run test:wp-rocket -- --grep='${anchored("Cache")}'`,
    });
  });

  test("values a shell would expand in an assignment are quoted: every shell reads them back as written", () => {
    for (const value of [
      "/builds/v1:=ls.zip",
      "=ls",
      "a=b",
      "~/r.zip",
      "/a:~/r.zip",
      "release:3.17.4",
      "commit:af1ab5c4d2",
      "pro@nginx",
    ]) {
      const result = rerunCommand(
        { product: "p", pin: { kind: "zip", zip: value } },
        { project: "artifacts:x" },
      );
      if (!("command" in result)) throw new Error(result.refused);
      const word = result.command.slice(0, result.command.indexOf(" npm "));
      const shells = shellsAssign("E2E_PLUGIN_ZIP", word);
      expect(shells.size).toBeGreaterThan(0);
      for (const [shell, read] of shells)
        expect(read, `${shell} ${value}`).toBe(value);
    }
  });

  test("a setup is selected by its project", () => {
    expect(
      rerunCommand(
        { product: "backwpup", cell: "pro@nginx" },
        { project: "setup:pro@nginx" },
      ),
    ).toEqual({
      command:
        "E2E_CELL=pro@nginx npm run test:backwpup -- --project=setup:pro@nginx",
    });
  });

  for (const title of NASTY_TITLES) {
    test(`every shell reads the --grep word back as the pattern: ${JSON.stringify(title).slice(0, 40)}`, () => {
      const result = rerunCommand({ product: "p", cell: "x" }, { title });
      if (!("command" in result)) throw new Error(result.refused);
      const word = result.command.slice(
        result.command.indexOf(" -- ") + " -- ".length,
      );
      const shells = shellsRead(word);
      expect(shells.size).toBeGreaterThan(0);
      for (const [shell, read] of shells) {
        expect(read, shell).toBe(`--grep=${grepPattern(title)}`);
        expect(
          selects(read.slice("--grep=".length), { above: [], title }),
          shell,
        ).toBe(true);
      }
    });
  }

  test("a zip path or ref holding a control character is refused, never printed altered", () => {
    for (const pin of [
      { kind: "zip", zip: "/z/a\u001b[2Jb.zip" },
      { kind: "build", ref: "feature/‮evil" },
      { kind: "build", version: "1.0\u001b[2J" },
      { kind: "zip", zip: "a\nb.zip" },
    ] as const) {
      expect(rerunCommand({ product: "p", pin }, { title: "t" })).toEqual({
        refused: "a value in it holds characters a terminal would act on",
      });
    }
  });

  test("a credential's shape anywhere — the title, a describe, the zip, the ref, the version — refuses the command", () => {
    const refused = {
      refused: "it would quote a value shaped like a credential",
    };
    expect(
      rerunCommand(
        { product: "p" },
        { title: "Log in to https://admin:hunter22@h.example/" },
      ),
    ).toEqual(refused);
    expect(
      rerunCommand(
        {
          product: "p",
          pin: { kind: "build", ref: "ghp_ABCDEFGHIJKLMNOP1234" },
        },
        { title: "t" },
      ),
    ).toEqual(refused);
    expect(
      rerunCommand(
        {
          product: "p",
          pin: { kind: "build", version: "ghp_ABCDEFGHIJKLMNOP1234" },
        },
        { title: "t" },
      ),
    ).toEqual(refused);
    expect(
      rerunCommand(
        {
          product: "p",
          pin: { kind: "zip", zip: "/z/p.zip?token=abc" },
        },
        { title: "t" },
      ),
    ).toEqual(refused);
    expect(
      rerunCommand(
        { product: "p" },
        {
          title: "t",
          above: ["Log in to https://admin:hunter22@h.example/"],
        },
      ),
    ).toEqual(refused);
  });

  test(`a command past ${String(RERUN_LIMIT)} characters is refused, never cut`, () => {
    expect(
      rerunCommand({ product: "p" }, { title: "a".repeat(RERUN_LIMIT) }),
    ).toEqual({ refused: "the title is too long for a command line" });
    // Escapes count: 400 controls make a 2,400-character pattern.
    expect(
      rerunCommand({ product: "p" }, { title: "\u0001".repeat(400) }),
    ).toEqual({ refused: "the title is too long for a command line" });
    const fits = rerunCommand({ product: "p" }, { title: "a".repeat(1_900) });
    expect("command" in fits).toBe(true);
  });

  test(`the limit is exact: ${String(RERUN_LIMIT)} characters print, one more is refused`, () => {
    const base = rerunCommand({ product: "p" }, { title: "" });
    if (!("command" in base)) throw new Error(base.refused);
    const room = RERUN_LIMIT - base.command.length;
    const exact = rerunCommand({ product: "p" }, { title: "a".repeat(room) });
    expect("command" in exact && exact.command.length).toBe(RERUN_LIMIT);
    expect(
      rerunCommand({ product: "p" }, { title: "a".repeat(room + 1) }),
    ).toEqual({ refused: "the title is too long for a command line" });
  });
});

test.describe("attachmentPaths", () => {
  test("the named attachments' paths, relative below the working directory, absolute elsewhere", () => {
    const result = {
      attachments: [
        {
          name: "screenshot",
          path: "/repo/test-results/a/1.png",
          contentType: "image/png",
        },
        {
          name: "trace",
          path: "/repo/test-results/a/trace.zip",
          contentType: "application/zip",
        },
        {
          name: "screenshot",
          path: "/elsewhere/2.png",
          contentType: "image/png",
        },
        {
          name: "screenshot",
          body: Buffer.from("x"),
          contentType: "image/png",
        },
      ],
    } as unknown as Pick<TestResult, "attachments">;
    expect(attachmentPaths(result, "screenshot", "/repo")).toEqual([
      "test-results/a/1.png",
      "/elsewhere/2.png",
    ]);
    expect(attachmentPaths(result, "trace", "/repo")).toEqual([
      "test-results/a/trace.zip",
    ]);
    expect(attachmentPaths({ attachments: [] }, "trace", "/repo")).toEqual([]);
  });
});

test.describe("failureFacts", () => {
  test("the Gherkin step, never the API step under it whose title holds what was typed", () => {
    const facts = failureFacts(
      {
        errors: [{ message: "Error: expect(locator).toHaveValue() failed" }],
        attachments: [],
        steps: [
          step("When the form is filled", "test.step", {
            error: "Error: expect(locator).toHaveValue() failed",
            steps: [
              step('Fill "canary-typed-value"', "pw:api"),
              step("Expect toHaveValue", "expect", {
                error: "Error: expect(locator).toHaveValue() failed",
              }),
            ],
          }),
        ],
      },
      {
        feature: "src/projects/p/features/f.feature",
        target: { product: "p", cell: "x" },
        selection: { title: "Fill the form", above: ["F"] },
      },
      "/repo",
    );
    expect(facts).toEqual({
      step: {
        label: "Step",
        path: ["When the form is filled"],
        running: false,
      },
      feature: "src/projects/p/features/f.feature",
      error: "Error: expect(locator).toHaveValue() failed",
      screenshots: [],
      traces: [],
      rerun: {
        command: `E2E_CELL=x npm run test:p -- --grep='${anchored("F", "Fill the form")}'`,
      },
    });
    expect(JSON.stringify(facts)).not.toContain("canary");
  });

  test("a hook's failure names the hook; a timeout names the step that was running", () => {
    const hook = failureFacts(
      {
        errors: [{ message: "Error: reset failed" }],
        attachments: [],
        steps: [
          step("Before Hooks", "hook", {
            error: "Error: reset failed",
            steps: [
              step("BeforeEach Hooks", "hook", {
                error: "Error: reset failed",
                steps: [
                  step("reset", "hook", { error: "Error: reset failed" }),
                ],
              }),
            ],
          }),
        ],
      },
      { target: { product: "p" }, selection: { title: "t" } },
      "/",
    );
    expect(hook.step).toEqual({
      label: "Hook",
      path: ["Before Hooks", "BeforeEach Hooks", "reset"],
      running: false,
    });
    const timeout = failureFacts(
      {
        errors: [{ message: "Test timeout of 30000ms exceeded." }],
        attachments: [],
        steps: [
          step("Before Hooks", "hook"),
          step("When the backup runs", "test.step", {
            steps: [step('Fill "x"', "pw:api")],
          }),
          step("After Hooks", "hook"),
        ],
      },
      { target: { product: "p" }, selection: { title: "t" } },
      "/",
    );
    expect(timeout.step).toEqual({
      label: "Step",
      path: ["When the backup runs"],
      running: true,
    });
    expect(timeout.error).toBe("Test timeout of 30000ms exceeded.");
  });

  test("a setup whose body threw with no step: no Step line, never a hook that ran after it", () => {
    // The auth setup failing its preflight, as Playwright 1.63 reported it: only hooks began, the
    // body's error on none of them, and the browser fixture torn down in Worker Cleanup.
    const facts = failureFacts(
      {
        errors: [
          { message: "Error: [preflight] Transport verification failed" },
        ],
        attachments: [],
        steps: [
          step("Before Hooks", "hook", {
            steps: [
              step("beforeEach hook", "hook"),
              step('Fixture "browser"', "fixture", {
                steps: [step("Launch browser", "pw:api")],
              }),
            ],
          }),
          step("After Hooks", "hook", {
            steps: [
              step("afterEach hook", "hook"),
              step("afterEach hook", "hook"),
            ],
          }),
          step("Worker Cleanup", "hook", {
            steps: [step('Fixture "browser"', "fixture")],
          }),
        ],
      },
      {
        setup: "setup:x",
        target: { product: "p", cell: "x" },
        selection: { project: "setup:x" },
      },
      "/",
    );
    expect(facts.step).toBeUndefined();
    expect(facts.error).toBe(
      "Error: [preflight] Transport verification failed",
    );
  });

  test("a credential a format character splits is masked whole in the Error line", () => {
    const token = "ghp_A1b2C3d4E5f6G7h8I9\u200bj0K1l2M3n4O5p6Q7r8";
    const facts = failureFacts(
      {
        errors: [{ message: `Error: auth with ${token} failed` }],
        attachments: [],
        steps: [],
      },
      { target: { product: "p" }, selection: { title: "t" } },
      "/",
    );
    const style = terminalStyle({ tty: false, color: false, unicode: true });
    expect(failureBlockLines(style, facts)[0]).toBe(
      "  Error       Error: auth with *** failed",
    );
  });

  test("a title shaped like a credential: its attachment paths are withheld, saying why", () => {
    const result = {
      errors: [{ message: "Error: no" }],
      attachments: [
        {
          name: "trace",
          path: "/r/test-results/f-Cred-9d8c0-jklmnopqrstuvwxyz0123456789-x/trace.zip",
          contentType: "application/zip",
        },
      ],
      steps: [],
    };
    const where = (title: string, above: string[] = []) => ({
      target: { product: "p" },
      selection: { title, above },
    });
    const credential = "Log in with ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const withheld =
      "its folder is named after a title shaped like a credential";
    expect(failureFacts(result, where(credential), "/r").withheld).toBe(
      withheld,
    );
    expect(
      failureFacts(result, where("t", [`F ${credential}`]), "/r").withheld,
    ).toBe(withheld);
    expect(
      failureFacts(result, where("Log in"), "/r").withheld,
    ).toBeUndefined();
    expect(pathsWithheld({ project: "setup:x" })).toBeUndefined();
  });

  test("an attempt that began no step and shows no error: just the rerun", () => {
    expect(
      failureFacts(
        { errors: [], attachments: [], steps: [] },
        { target: { product: "p" }, selection: { title: "t" } },
        "/",
      ),
    ).toEqual({
      screenshots: [],
      traces: [],
      rerun: { command: `npm run test:p -- --grep='${anchored("t")}'` },
    });
  });
});

test.describe("failureBlockLines", () => {
  const plainStyle = terminalStyle({ tty: false, color: false, unicode: true });
  const asciiStyle = terminalStyle({
    tty: false,
    color: false,
    unicode: false,
  });
  const colourStyle = terminalStyle({ tty: true, color: true, unicode: true });

  const full: FailureFacts = {
    step: { label: "Step", path: ["When the backup runs"], running: false },
    feature: "src/projects/backwpup/features/backups.feature",
    error: "Error:\n  expect(locator).toBeVisible() failed\n\nmore",
    screenshots: ["test-results/a/test-failed-1.png", "/my shots/2.png"],
    traces: ["test-results/a/trace.zip"],
    rerun: {
      command: "E2E_CELL=x npm run test:backwpup -- --grep='/A backup/'",
    },
  };

  test("one line per fact, aligned; the error's first line that says something; paths quoted for a shell", () => {
    expect(failureBlockLines(plainStyle, full)).toEqual([
      "  Step        When the backup runs",
      "  Feature     src/projects/backwpup/features/backups.feature",
      "  Error       expect(locator).toBeVisible() failed",
      "  Screenshot  test-results/a/test-failed-1.png",
      "  Screenshot  '/my shots/2.png'",
      "  Trace       test-results/a/trace.zip",
      "  Rerun       E2E_CELL=x npm run test:backwpup -- --grep='/A backup/'",
    ]);
  });

  test("a setup's block says what it holds up; a running step says so; a refused command says why", () => {
    expect(
      failureBlockLines(asciiStyle, {
        setup: "setup:pro@nginx",
        step: { label: "Step", path: ["log in"], running: true },
        screenshots: [],
        traces: [],
        rerun: { refused: "the title is too long for a command line" },
      }),
    ).toEqual([
      "  Setup       setup:pro@nginx - no scenario of its cell runs without it",
      "  Step        log in . running when the attempt ended",
      "  Rerun       not shown: the title is too long for a command line",
    ]);
  });

  test("a hook's path joined by the palette's breadcrumb: ASCII under plain output", () => {
    const facts: FailureFacts = {
      step: {
        label: "Hook",
        path: ["After Hooks", "AfterEach Hooks", "\u001b[2Jteardown"],
        running: false,
      },
      screenshots: [],
      traces: [],
      rerun: { refused: "no" },
    };
    expect(failureBlockLines(asciiStyle, facts)[0]).toBe(
      "  Hook        After Hooks > AfterEach Hooks > teardown",
    );
    expect(failureBlockLines(plainStyle, facts)[0]).toBe(
      "  Hook        After Hooks › AfterEach Hooks › teardown",
    );
    // Capped with the palette's ellipsis too.
    const long = failureBlockLines(asciiStyle, {
      ...facts,
      step: { label: "Step", path: ["x".repeat(600)], running: false },
    })[0];
    expect(long?.endsWith("...")).toBe(true);
    expect(long).toMatch(/^[\x20-\x7e]+$/);
  });

  test("an error that says nothing, once plain, prints no Error line", () => {
    expect(
      failureBlockLines(plainStyle, {
        error: "\u001b[0m\n",
        screenshots: [],
        traces: [],
        rerun: { refused: "no" },
      }),
    ).toEqual(["  Rerun       not shown: no"]);
  });

  test("withheld paths: one line per kind, saying why, never the path", () => {
    const lines = failureBlockLines(plainStyle, {
      screenshots: ["a/1.png", "a/2.png"],
      traces: ["a/trace.zip"],
      withheld: "its folder is named after a title shaped like a credential",
      rerun: { refused: "no" },
    });
    expect(lines).toEqual([
      "  Screenshot  not shown: its folder is named after a title shaped like a credential",
      "  Trace       not shown: its folder is named after a title shaped like a credential",
      "  Rerun       not shown: no",
    ]);
    // Nothing to withhold: no line.
    expect(
      failureBlockLines(plainStyle, {
        screenshots: [],
        traces: [],
        withheld: "x",
        rerun: { refused: "no" },
      }),
    ).toEqual(["  Rerun       not shown: no"]);
  });

  test("external values are plain, masked and capped; the command is never cut", () => {
    const long = `When ${"x".repeat(600)}`;
    const command = `npm run test:p -- --grep=/${"y".repeat(1_500)}/`;
    const lines = failureBlockLines(plainStyle, {
      step: { label: "Step", path: [long], running: false },
      feature: "f\u001b[2J.feature",
      error: "Error: GET https://admin:hunter22@h.example/ failed",
      screenshots: ["shot\n.png"],
      traces: [],
      rerun: { command },
    });
    const [stepLine, feature, error, shot, rerun] = lines;
    // The 500-code-point cap, after the indent and the label.
    expect(Array.from(stepLine ?? "").length).toBeLessThanOrEqual(500 + 14);
    expect(stepLine?.endsWith("…")).toBe(true);
    expect(feature).toBe("  Feature     f.feature");
    expect(error).toBe(
      "  Error       Error: GET https://***@h.example/ failed",
    );
    expect(shot).toBe("  Screenshot  'shot .png'");
    expect(rerun).toBe(`  Rerun       ${command}`);
    for (const line of lines) expect(line).not.toMatch(/\p{Cc}/u);
  });

  test("on a coloured terminal: labels bold, the command bold, a refusal dim; every word still there", () => {
    const lines = failureBlockLines(colourStyle, full);
    expect(lines[0]).toBe(
      "  \u001b[1mStep        \u001b[22mWhen the backup runs",
    );
    expect(lines.at(-1)).toBe(
      `  \u001b[1mRerun       \u001b[22m\u001b[1m${"command" in full.rerun ? full.rerun.command : ""}\u001b[22m`,
    );
    const refused = failureBlockLines(colourStyle, {
      screenshots: [],
      traces: [],
      rerun: { refused: "no" },
    });
    expect(refused).toEqual([
      "  \u001b[1mRerun       \u001b[22m\u001b[2mnot shown: no\u001b[22m",
    ]);
  });
});
