import { test, expect } from "@playwright/test";

import {
  OUTPUT_ENV,
  boolEnv,
  env,
  intEnv,
  outputModeEnv,
  parseBoolean,
  requireEnv,
} from "./env";

/** The typed environment accessors: blank means unset, and a malformed value throws by name. */

const NAME = "E2E_SPEC_ENV_PROBE";

test.afterEach(() => {
  Reflect.deleteProperty(process.env, NAME);
});

test.describe("env / requireEnv", () => {
  test("return the value, and treat blank as unset", () => {
    process.env[NAME] = "x";
    expect(env(NAME, "d")).toBe("x");
    expect(requireEnv(NAME)).toBe("x");
    process.env[NAME] = "  ";
    expect(env(NAME, "d")).toBe("d");
    expect(() => requireEnv(NAME)).toThrow(
      `Missing required environment variable "${NAME}". Set it in the environment (a CI secret ` +
        "store), or in .env unless E2E_LOAD_DOTENV=false.",
    );
  });
});

test.describe("intEnv", () => {
  test("falls back when blank, reads plain decimal digits, and refuses anything else or out-of-range by name", () => {
    expect(intEnv(NAME, 7)).toBe(7);
    process.env[NAME] = "3";
    expect(intEnv(NAME, 7, 0, 10)).toBe(3);
    process.env[NAME] = " 4\n";
    expect(intEnv(NAME, 7, 0, 10)).toBe(4);
    process.env[NAME] = "-0";
    expect(Object.is(intEnv(NAME, 7, 0, 10), 0)).toBe(true);
    // `Number()` reads each of these as an integer in range; an operator never means them.
    for (const bad of [
      "3.5",
      "abc",
      "-1",
      "11",
      "1e1",
      "0x5",
      "0b11",
      "0o7",
      "5.0",
      "+5",
      "5_0",
      "Infinity",
      "99999999999999999999",
    ]) {
      process.env[NAME] = bad;
      expect(() => intEnv(NAME, 7, 0, 10), bad).toThrow(
        `"${NAME}" must be an integer in [0, 10], got "${bad}".`,
      );
    }
  });
});

test.describe("parseBoolean", () => {
  test("reads true/false/1/0 in any case and spacing; anything else is undefined", () => {
    for (const yes of ["true", "TRUE", " 1 "])
      expect(parseBoolean(yes)).toBe(true);
    for (const no of ["false", "False", "0\n"])
      expect(parseBoolean(no)).toBe(false);
    for (const other of ["", "  ", "yes", "no", "off", "2", "fals"])
      expect(parseBoolean(other), JSON.stringify(other)).toBeUndefined();
  });
});

test.describe("boolEnv", () => {
  test("falls back when unset or blank", () => {
    expect(boolEnv(NAME, true)).toBe(true);
    process.env[NAME] = " ";
    expect(boolEnv(NAME, false)).toBe(false);
  });

  test("throws on an unrecognised value, naming the variable and the value", () => {
    process.env[NAME] = "yes";
    expect(() => boolEnv(NAME, true)).toThrow(
      `Environment variable "${NAME}" must be a boolean (true/false/1/0), got "yes".`,
    );
  });

  test("reads the given source instead of process.env", () => {
    process.env[NAME] = "true";
    expect(boolEnv(NAME, true, { [NAME]: "0" })).toBe(false);
    expect(boolEnv(NAME, false, {})).toBe(false);
  });
});

test.describe("outputModeEnv", () => {
  test("auto when unset or blank; the three modes in any case and spacing", () => {
    expect(outputModeEnv({})).toBe("auto");
    expect(outputModeEnv({ [OUTPUT_ENV]: "  " })).toBe("auto");
    expect(outputModeEnv({ [OUTPUT_ENV]: "plain" })).toBe("plain");
    expect(outputModeEnv({ [OUTPUT_ENV]: " FANCY\n" })).toBe("fancy");
    expect(outputModeEnv({ [OUTPUT_ENV]: "Auto" })).toBe("auto");
  });

  test("throws on anything else, naming the variable, the modes and the value", () => {
    for (const bad of ["pretty", "0", "plain,fancy", "no-color"]) {
      expect(() => outputModeEnv({ [OUTPUT_ENV]: bad }), bad).toThrow(
        `Environment variable "E2E_OUTPUT" must be one of auto/plain/fancy, got "${bad}".`,
      );
    }
  });

  test("reads process.env by default", () => {
    const saved = process.env[OUTPUT_ENV];
    try {
      process.env[OUTPUT_ENV] = "plain";
      expect(outputModeEnv()).toBe("plain");
    } finally {
      if (saved === undefined) Reflect.deleteProperty(process.env, OUTPUT_ENV);
      else process.env[OUTPUT_ENV] = saved;
    }
  });
});
