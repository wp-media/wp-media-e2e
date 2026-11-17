import { test, expect } from "@playwright/test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { removeTempDir } from "../__fixtures__/temp-dir";
import {
  parseSuiteVersion,
  readSuiteVersion,
  suiteVersionText,
  type ReadText,
} from "./suite-version";

/**
 * The suite's version is display only: a valid SemVer 2.0 string of at most 64 characters, or
 * `undefined` — never a throw, whatever `package.json` holds or whether it can be read at all.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** A `package.json` text declaring `version`, any JSON value. */
function withVersion(version: unknown): string {
  return JSON.stringify({ name: "wp-media-e2e", version });
}

test.describe("parseSuiteVersion", () => {
  test("returns a valid SemVer 2.0 version, prerelease and build included", () => {
    for (const version of [
      "1.1.0",
      "0.0.0",
      "1.1.0-rc.1+b5",
      "1.0.0-alpha",
      "1.0.0+20130313144700",
      "10.20.30-0A.is.legal",
      "1.0.0+001",
      "1.0.0+21AF26D3----117B344092BD",
      "1.0.0-x-y-z.--",
      "1.2.3----RC-SNAPSHOT.12.9.1--.12+788",
    ]) {
      expect(parseSuiteVersion(withVersion(version)), version).toBe(version);
    }
  });

  test("refuses a string that is not SemVer 2.0", () => {
    for (const version of [
      "",
      "v1.1.0",
      "1.1",
      "1",
      "01.1.0",
      "1.01.0",
      "1.1.01",
      "1.0.0-alpha.01",
      "1.1.0-01",
      "1.1.0-",
      "1.1.0+",
      "1.1.0-rc..1",
      " 1.1.0",
      "1.1.0 ",
      "1.1.0\n",
      "1.1.0\u0000",
      "1.1.0-rc\u001b[31m",
      "1.1.0\r",
      "latest",
    ]) {
      expect(
        parseSuiteVersion(withVersion(version)),
        JSON.stringify(version),
      ).toBeUndefined();
    }
  });

  test("accepts 64 characters and refuses 65, both otherwise valid", () => {
    const at64 = `1.1.0-${"a".repeat(58)}`;
    expect(at64).toHaveLength(64);
    expect(parseSuiteVersion(withVersion(at64))).toBe(at64);
    const at65 = `1.1.0-${"a".repeat(59)}`;
    expect(at65).toHaveLength(65);
    expect(parseSuiteVersion(withVersion(at65))).toBeUndefined();
  });

  test("refuses a version that is not a string", () => {
    for (const version of [110, 1.1, true, null, ["1.1.0"], { v: "1.1.0" }]) {
      expect(
        parseSuiteVersion(withVersion(version)),
        JSON.stringify(version),
      ).toBeUndefined();
    }
    expect(parseSuiteVersion(JSON.stringify({ name: "x" }))).toBeUndefined();
  });

  test("ignores one leading byte order mark, as npm and Node do", () => {
    expect(parseSuiteVersion(`\uFEFF${withVersion("1.1.0")}`)).toBe("1.1.0");
    expect(
      parseSuiteVersion(`\uFEFF\uFEFF${withVersion("1.1.0")}`),
    ).toBeUndefined();
  });

  test("refuses text that is not a JSON object, without throwing", () => {
    for (const text of [
      "",
      "{",
      "not json",
      '{"version":"1.1.0",}',
      "null",
      "[]",
      '["1.1.0"]',
      '"x"',
      '"1.1.0"',
      "42",
      "true",
    ]) {
      expect(parseSuiteVersion(text), text).toBeUndefined();
    }
  });
});

test.describe("readSuiteVersion", () => {
  let dir = "";

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "e2e-suite-version-"));
  });

  test.afterEach(() => {
    removeTempDir(dir);
    dir = "";
  });

  test("reads the version from <root>/package.json", () => {
    writeFileSync(join(dir, "package.json"), withVersion("2.3.4-beta.1"));
    expect(readSuiteVersion(dir)).toBe("2.3.4-beta.1");
  });

  test("returns undefined when <root>/package.json is missing", () => {
    expect(readSuiteVersion(dir)).toBeUndefined();
  });

  test("returns undefined when <root>/package.json holds an invalid version", () => {
    writeFileSync(join(dir, "package.json"), withVersion("v2"));
    expect(readSuiteVersion(dir)).toBeUndefined();
  });

  test("returns undefined when the file cannot be read, never throwing", () => {
    const paths: string[] = [];
    const unreadable: ReadText = (path) => {
      paths.push(path);
      throw Object.assign(new Error("EACCES: permission denied"), {
        code: "EACCES",
      });
    };
    expect(readSuiteVersion("/srv/suite", unreadable)).toBeUndefined();
    expect(paths).toEqual([join("/srv/suite", "package.json")]);
  });

  test("reads this checkout's package.json: its version, valid", () => {
    const declared: unknown = JSON.parse(
      readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
    );
    const version = readSuiteVersion(REPO_ROOT);
    expect(version).toBeDefined();
    expect(version).toBe((declared as { version?: unknown }).version);
  });
});

test.describe("suiteVersionText", () => {
  test("shows the version, or unknown when there is none", () => {
    expect(suiteVersionText("1.1.0")).toBe("1.1.0");
    expect(suiteVersionText(undefined)).toBe("unknown");
  });
});
