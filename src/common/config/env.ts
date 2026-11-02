/**
 * Typed environment-variable accessors.
 *
 * Validation happens only at this boundary, so the rest of the code can treat
 * configuration as total. `.env` is loaded once per process by `./load-env.ts`, which every
 * product config and script entry point imports first (never the unit config).
 */

import { isNonEmptyString } from "../guards";
import type { OutputMode } from "../terminal/capabilities";

/** Returns an environment variable's value, or `fallback` when it is unset or blank. */
export function env(name: string, fallback = ""): string {
  const value = process.env[name];
  return isNonEmptyString(value) ? value : fallback;
}

/** Returns a REQUIRED environment variable; throws an actionable error when missing or blank. */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!isNonEmptyString(value)) {
    throw new Error(
      `Missing required environment variable "${name}". ` +
        "Set it in the environment (a CI secret store), or in .env unless E2E_LOAD_DOTENV=false.",
    );
  }
  return value;
}

/** An integer as an operator writes one: decimal digits, an optional leading `-`. */
const DECIMAL_INTEGER = /^-?\d+$/;

/**
 * Returns an integer environment variable within `[min, max]`. Falls back when unset or
 * blank; throws an actionable error on anything but plain decimal digits (an optional `-`,
 * surrounding whitespace ignored) or an out-of-range value, so a typo surfaces here, not as a
 * silent `NaN` deep in a later layer. `Number()` alone would take `1e3`, `0x14` or `20.0`.
 */
export function intEnv(
  name: string,
  fallback: number,
  min = 1,
  max = 65535,
): number {
  const raw = process.env[name];
  if (!isNonEmptyString(raw)) return fallback;
  const digits = raw.trim();
  // `+ 0` turns `-0` into `0`.
  const parsed = DECIMAL_INTEGER.test(digits) ? Number(digits) + 0 : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(
      `Environment variable "${name}" must be an integer in [${String(min)}, ${String(max)}], got "${raw}".`,
    );
  }
  return parsed;
}

/**
 * Parses a boolean variable's value: `true`/`false`/`1`/`0`, case-insensitive, surrounding
 * whitespace ignored.
 *
 * @returns the boolean, or `undefined` for anything else (a blank included).
 */
export function parseBoolean(raw: string): boolean | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  return undefined;
}

/**
 * Returns a boolean environment variable, by {@link parseBoolean}'s rule. Falls back when unset
 * or blank; throws on anything else rather than silently treating an unrecognized value as
 * `false`.
 *
 * @param source - Where to read it; `process.env` unless a caller (or a spec) holds another.
 */
export function boolEnv(
  name: string,
  fallback: boolean,
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = source[name];
  if (!isNonEmptyString(raw)) return fallback;
  const value = parseBoolean(raw);
  if (value !== undefined) return value;
  throw new Error(
    `Environment variable "${name}" must be a boolean (true/false/1/0), got "${raw}".`,
  );
}

/** How much styling a run's terminal output may use: `auto`, `plain` or `fancy`. */
export const OUTPUT_ENV = "E2E_OUTPUT";

/** The values {@link outputModeEnv} accepts, as an operator writes them. */
const OUTPUT_MODES: readonly OutputMode[] = ["auto", "plain", "fancy"];

/**
 * The suite's terminal output mode, `E2E_OUTPUT`: `auto` (styled on a terminal, plain otherwise),
 * `plain` (no colour, no cursor movement, ASCII) or `fancy` (as `auto`, and live even under `CI`).
 * Case-insensitive, surrounding whitespace ignored; `auto` when unset or blank. Throws on anything
 * else, so a typo fails the run as its config loads rather than silently styling it.
 *
 * @param source - Where to read it; `process.env` unless a caller (or a spec) holds another.
 * @throws {@link Error} naming the variable and the values it takes.
 */
export function outputModeEnv(
  source: NodeJS.ProcessEnv = process.env,
): OutputMode {
  const raw = source[OUTPUT_ENV];
  if (!isNonEmptyString(raw)) return "auto";
  const value = raw.trim().toLowerCase();
  const mode = OUTPUT_MODES.find((candidate) => candidate === value);
  if (mode !== undefined) return mode;
  throw new Error(
    `Environment variable "${OUTPUT_ENV}" must be one of ${OUTPUT_MODES.join("/")}, got "${raw}".`,
  );
}
