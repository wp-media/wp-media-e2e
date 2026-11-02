import { test, expect } from "@playwright/test";

import type { JsBuildPhase } from "apvm-napi";

import { createBuildReporter, redactBuildText, requiresToken } from "./apvm";
import type { Printers } from "../config/output";
import { createPalette } from "../terminal/palette";
import type { Palette } from "../terminal/palette";

/** The APVM boundary's pure parts (masking by shape is `text.ts`'s `redactSecrets`). */

test("requiresToken flags only the private-source projects", () => {
  expect(requiresToken("backwpup")).toBe(true);
  expect(requiresToken("wp-rocket")).toBe(false);
  expect(requiresToken("imagify")).toBe(false);
});

test.describe("redactBuildText", () => {
  /** A legacy (pre-2021) GitHub token: 40 hex digits, the shape of any commit. */
  const LEGACY = "0123456789abcdef0123456789abcdef01234567";

  test("masks the process's GitHub tokens by value, keeping a commit of the same shape", () => {
    const saved = { gh: process.env.GITHUB_TOKEN, alt: process.env.GH_TOKEN };
    process.env.GITHUB_TOKEN = LEGACY;
    process.env.GH_TOKEN = "  ";
    try {
      const commit = "fedcba9876543210fedcba9876543210fedcba98";
      expect(
        redactBuildText(`token ${LEGACY} refused while fetching ${commit}`),
      ).toBe(`token *** refused while fetching ${commit}`);
      // Still masked by shape too.
      expect(redactBuildText("https://u:p@github.com/o/r.git")).toBe(
        "https://***@github.com/o/r.git",
      );
      // A format character inside a token hides it from neither mask.
      expect(
        redactBuildText(`for ${LEGACY.slice(0, 9)}\u200b${LEGACY.slice(9)}`),
      ).toBe("for ***");
      expect(redactBuildText("ghp_16Chars\u2060OrMoreAAAA")).toBe("***");
    } finally {
      for (const [name, value] of [
        ["GITHUB_TOKEN", saved.gh],
        ["GH_TOKEN", saved.alt],
      ] as const) {
        if (value === undefined) Reflect.deleteProperty(process.env, name);
        else process.env[name] = value;
      }
    }
  });
});

test.describe("createBuildReporter", () => {
  /** A GitHub-token-shaped string used across these cases; must never survive to the output. */
  const TOKEN = "ghp_16CharsOrMoreAAAA";

  test("scrubs the buffered output tail and the failure reason on the way out", () => {
    const reporter = createBuildReporter("plugin develop");
    reporter.onProgress(null, {
      type: "command_output",
      line: `Cloning https://x-access-token:${TOKEN}@github.com/wp-media/backwpup-pro.git`,
    });
    reporter.onProgress(null, {
      type: "build_failed",
      reason: `authentication failed using ${TOKEN}`,
    });

    const context = reporter.failureContext();
    expect(context).not.toContain(TOKEN);
    expect(context).not.toContain("x-access-token");
    // The diagnostically useful part survives.
    expect(context).toContain("github.com/wp-media/backwpup-pro.git");
    expect(context).toContain("authentication failed using ***");
  });

  test("retains only the trailing output window", () => {
    const reporter = createBuildReporter("plugin develop");
    for (let i = 0; i < 60; i += 1) {
      reporter.onProgress(null, {
        type: "command_output",
        line: `line-${String(i)}`,
      });
    }
    const context = reporter.failureContext();
    expect(context).toContain("line-59");
    expect(context).toContain("line-20"); // 60 - 40 = the oldest kept line
    expect(context).not.toContain("line-19");
  });

  // The phases as APVM sends them: a const enum's string values, which isolated modules cannot name.
  const CLONE = "Clone" as JsBuildPhase;
  const BUILD = "Build" as JsBuildPhase;

  /** Printers that keep what they are given, on `palette`. */
  function capture(palette: Palette): { printers: Printers; lines: string[] } {
    const lines: string[] = [];
    return {
      lines,
      printers: {
        out: { palette, print: (line) => lines.push(`out:${line}`) },
        err: { palette, print: (line) => lines.push(`err:${line}`) },
      },
    };
  }

  test("prints a phase to out and a warning to err, styled by their palettes, a token scrubbed", () => {
    const colour = capture(
      createPalette({ tty: true, color: true, unicode: true }),
    );
    const reporter = createBuildReporter("plugin develop", colour.printers);
    reporter.onProgress(null, {
      type: "phase_started",
      phase: CLONE,
      message: `from ${TOKEN}`,
    });
    reporter.onProgress(null, { type: "warning", message: "slow" });
    expect(colour.lines).toEqual([
      "out:  \x1b[2m[plugin develop]\x1b[22m Clone: from ***",
      "err:  \x1b[33m[plugin develop] warning:\x1b[39m slow",
    ]);

    const plain = capture(
      createPalette({ tty: false, color: false, unicode: false }),
    );
    const quiet = createBuildReporter("plugin develop", plain.printers);
    quiet.onProgress(null, { type: "phase_started", phase: BUILD });
    expect(plain.lines).toEqual(["out:  [plugin develop] Build"]);
  });

  test("each line on its own printer's palette, an event's escapes and line breaks dropped", () => {
    const colour = createPalette({ tty: true, color: true, unicode: true });
    const none = createPalette({ tty: false, color: false, unicode: true });
    const lines: string[] = [];
    const reporter = createBuildReporter("plugin develop", {
      out: { palette: colour, print: (line) => lines.push(`out:${line}`) },
      err: { palette: none, print: (line) => lines.push(`err:${line}`) },
    });
    reporter.onProgress(null, {
      type: "phase_started",
      phase: CLONE,
      message: "a\x1b[2J\nb",
    });
    reporter.onProgress(null, {
      type: "warning",
      message: "\x1b]52;c;eA==\x07slow",
    });
    expect(lines).toEqual([
      "out:  \x1b[2m[plugin develop]\x1b[22m Clone: a b",
      "err:  [plugin develop] warning: slow",
    ]);
  });

  test("by default prints as a test worker: console.log and console.warn, never coloured", () => {
    const printed: string[] = [];
    const { log, warn } = console;
    console.log = (line: string) => printed.push(line);
    console.warn = (line: string) => printed.push(line);
    try {
      // This worker runs under FORCE_COLOR=1, which a worker's palette ignores.
      const reporter = createBuildReporter("plugin develop");
      reporter.onProgress(null, { type: "phase_started", phase: CLONE });
      reporter.onProgress(null, { type: "warning", message: "slow" });
    } finally {
      console.log = log;
      console.warn = warn;
    }
    expect(printed).toEqual([
      "  [plugin develop] Clone",
      "  [plugin develop] warning: slow",
    ]);
  });

  test("is empty when nothing noteworthy happened, and ignores transport errors", () => {
    const reporter = createBuildReporter("plugin develop");
    reporter.onProgress(new Error("callback transport failure"), {
      type: "command_output",
      line: "must be ignored",
    });
    reporter.onProgress(null, { type: "step_started" });
    expect(reporter.failureContext()).toBe("");
  });
});
