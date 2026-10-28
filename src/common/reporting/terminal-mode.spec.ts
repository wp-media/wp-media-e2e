import { test, expect } from "@playwright/test";
import { Writable } from "node:stream";

import {
  outputModeOption,
  screenOwner,
  writeIntercepted,
  type ScreenInputs,
} from "./terminal-mode";

/**
 * Who owns the screen while the terminal reporter runs: the reporter (in watch mode too), or
 * Playwright's listing or UI, or a second reporter — and the output mode the config factory handed it.
 */

/** A plain run's inputs. */
const RUN: ScreenInputs = {
  options: { _mode: "test" },
  env: {},
  argv: ["node", "cli.js", "test", "-c", "playwright.config.ts"],
  stdoutIntercepted: false,
};

test.describe("screenOwner", () => {
  test("a plain run is the reporter's", () => {
    expect(screenOwner(RUN)).toEqual({ context: "run" });
    // Arguments that only look like the UI's are not it.
    expect(
      screenOwner({
        ...RUN,
        argv: ["node", "cli.js", "--grep", "--uix", "ui"],
      }),
    ).toEqual({ context: "run" });
  });

  test("--list: Playwright's listing prints", () => {
    expect(screenOwner({ ...RUN, options: { _mode: "list" } })).toEqual({
      context: "list",
      inert: "list",
    });
  });

  test("--ui, --ui-host and --ui-port, in either spelling, or intercepted stdio: the UI", () => {
    for (const flag of [
      "--ui",
      "--ui-host=0.0.0.0",
      "--ui-host",
      "--ui-port=0",
      "--ui-port",
    ]) {
      expect(screenOwner({ ...RUN, argv: [...RUN.argv, flag] }), flag).toEqual({
        context: "ui",
        inert: "ui",
      });
    }
    expect(screenOwner({ ...RUN, stdoutIntercepted: true })).toEqual({
      context: "ui",
      inert: "ui",
    });
  });

  test("PWTEST_WATCH set (to anything but empty): watch mode, which leaves stdio to the reporter", () => {
    for (const value of ["1", "true", " "]) {
      expect(screenOwner({ ...RUN, env: { PWTEST_WATCH: value } })).toEqual({
        context: "watch",
      });
    }
    expect(screenOwner({ ...RUN, env: { PWTEST_WATCH: "" } })).toEqual({
      context: "run",
    });
  });

  test("PW_TEST_REPORTER set: a second reporter prints, so this one stays quiet", () => {
    expect(screenOwner({ ...RUN, env: { PW_TEST_REPORTER: "dot" } })).toEqual({
      context: "run",
      inert: "second-reporter",
    });
    expect(screenOwner({ ...RUN, env: { PW_TEST_REPORTER: "" } })).toEqual({
      context: "run",
    });
    // In watch mode too: the second reporter prints there as well.
    expect(
      screenOwner({
        ...RUN,
        env: { PW_TEST_REPORTER: "dot", PWTEST_WATCH: "1" },
      }),
    ).toEqual({ context: "watch", inert: "second-reporter" });
  });

  test("the first match wins: list, then UI, then a second reporter; watch mode alone prints", () => {
    const all: ScreenInputs = {
      options: { _mode: "list" },
      env: { PWTEST_WATCH: "1", PW_TEST_REPORTER: "dot" },
      argv: ["--ui"],
      stdoutIntercepted: true,
    };
    expect(screenOwner(all).inert).toBe("list");
    expect(screenOwner({ ...all, options: {} }).inert).toBe("ui");
    const rest = { ...all, options: {}, argv: [], stdoutIntercepted: false };
    expect(screenOwner(rest).inert).toBe("second-reporter");
    expect(screenOwner({ ...rest, env: { PWTEST_WATCH: "1" } })).toEqual({
      context: "watch",
    });
  });

  test("options that are no object read as a plain run", () => {
    for (const options of [undefined, null, "list", 3]) {
      expect(screenOwner({ ...RUN, options })).toEqual({ context: "run" });
    }
  });
});

test.describe("writeIntercepted", () => {
  test("a stream's own write is its prototype's; one assigned on it is intercepted", () => {
    const stream = new Writable({
      write: (_chunk, _encoding, done) => {
        done();
      },
    });
    expect(writeIntercepted(stream)).toBe(false);
    // (`process.stdout` is no example here: a test worker's is intercepted by Playwright itself.)
    stream.write = (): boolean => true;
    expect(writeIntercepted(stream)).toBe(true);
  });
});

test.describe("outputModeOption", () => {
  test("reads plain and fancy; anything else is auto, never a throw", () => {
    expect(outputModeOption({ output: "plain" })).toBe("plain");
    expect(outputModeOption({ output: "fancy" })).toBe("fancy");
    for (const options of [
      { output: "auto" },
      { output: "PLAIN" },
      { output: 1 },
      {},
      undefined,
      null,
      "plain",
    ]) {
      expect(outputModeOption(options)).toBe("auto");
    }
  });
});
