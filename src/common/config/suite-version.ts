import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The suite's own version: `package.json`'s `version`, shown beside what a run tested so a report
 * says which suite produced it. Read as text and parsed — never imported as JSON, nor taken from
 * `npm_package_version`, which a run started without npm lacks. Display only: every reader returns
 * `undefined` rather than throw, so a broken `package.json` never stops a run.
 *
 * Free of side effects (no `.env`, no environment read), so a long-lived process can import it.
 *
 * @example
 * ```ts
 * suiteVersionText(readSuiteVersion(process.cwd())); // "1.1.0", or "unknown"
 * ```
 */

/**
 * SemVer 2.0's official pattern (semver.org, "Is there a suggested regular expression"), its capture
 * groups made non-capturing: core numbers without leading zeros, optional prerelease and build.
 * JavaScript's `$` (no `m` flag) matches only at the very end, so a trailing newline fails.
 */
const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+(?:[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The longest version shown: keeps a header or message line short whatever `package.json` holds. */
const MAX_VERSION_LENGTH = 64;

/** A UTF-8 byte order mark, as some editors write at a file's start. */
const BOM = "\uFEFF";

/** What a version shows as when it could not be read. */
const UNKNOWN = "unknown";

/** Reads a file as UTF-8 text; `readFileSync` in production, a fake in specs. */
export type ReadText = (path: string, encoding: "utf8") => string;

/**
 * The `version` a `package.json`'s text declares, when it is valid SemVer 2.0 of at most 64
 * characters. Pure. One leading byte order mark is ignored, as npm and Node do.
 *
 * @param text - the file's content.
 * @returns the version; `undefined` for invalid JSON, a non-object, or a missing, non-string or
 *   invalid version.
 * @example
 * ```ts
 * parseSuiteVersion('{"version":"1.1.0"}'); // "1.1.0"
 * parseSuiteVersion('{"version":"v1.1.0"}'); // undefined
 * ```
 */
export function parseSuiteVersion(text: string): string | undefined {
  let parsed: unknown;
  try {
    // npm and Node read a package.json that starts with a byte order mark; so does this.
    parsed = JSON.parse(text.startsWith(BOM) ? text.slice(1) : text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return undefined;
  const version: unknown = (parsed as { version?: unknown }).version;
  return isSuiteVersion(version) ? version : undefined;
}

/**
 * Whether a value is a version this module would show: SemVer 2.0, at most 64 characters. The one
 * validity rule, for readers of a version written elsewhere (a run's facts) as well as for
 * `package.json`'s. Pure.
 *
 * @param value - any value.
 * @returns `true` for a valid version string.
 * @example
 * ```ts
 * isSuiteVersion("1.1.0-rc.1"); // true
 * isSuiteVersion("v1.1.0"); // false
 * ```
 */
export function isSuiteVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_VERSION_LENGTH &&
    SEMVER.test(value)
  );
}

/**
 * The suite's version, read from `<root>/package.json`.
 *
 * @param root - the checkout's root folder.
 * @param read - reads the file; injected so specs can make it fail.
 * @returns the version per {@link parseSuiteVersion}; `undefined` when the file cannot be read.
 * @example
 * ```ts
 * readSuiteVersion("/srv/wp-media-e2e"); // "1.1.0"
 * ```
 */
export function readSuiteVersion(
  root: string,
  read: ReadText = readFileSync,
): string | undefined {
  let text: string;
  try {
    text = read(join(root, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  return parseSuiteVersion(text);
}

/**
 * A version as shown to people: the version, or `unknown` when it could not be read.
 *
 * @param version - from {@link readSuiteVersion}.
 * @returns the text to print.
 * @example
 * ```ts
 * suiteVersionText(undefined); // "unknown"
 * ```
 */
export function suiteVersionText(version: string | undefined): string {
  return version ?? UNKNOWN;
}
