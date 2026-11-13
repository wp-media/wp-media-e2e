import { performance } from "node:perf_hooks";

import { hasSudoNoise } from "../wp/sudo-noise";
import { execAsTransport } from "../wp/transport-exec";
import type { Transport } from "../config/types";
import type { SudoTarget } from "../wp/run-as-argv";
import type { IdentityState } from "../wp/site-identity";
import type {
  ElevationSupport,
  ExecOptions,
  ExecResult,
} from "../wp/transport-exec";

/**
 * What a host's unresolvable name costs each `sudo` call. sudo looks the host's own name up on every
 * call; when it does not resolve, sudo says so on stderr (removed by the exec layer, `wp/sudo-noise.ts`)
 * and waits for the resolver first. Measured on Ubuntu 24.04 (sudo 1.9.15): ~4 ms when the resolver
 * answers or refuses at once, ~20 s per call when it does not answer (glibc's 5 s timeout, 2
 * attempts, A and AAAA) — every site command and root step then pays it. The suite cannot change the
 * host, so the pre-flight only measures and reports it.
 */

/** A wait past this, per sudo call, is reported: below it the noise is absorbed at no visible cost. */
export const SLOW_SUDO_LOOKUP_MS = 1000;

/** What one `sudo -n true` showed. */
export type SudoLookup =
  /** sudo printed no unresolvable-host line (or there is no sudo): nothing to absorb. */
  | { readonly kind: "resolves" }
  /** It did; `waitMs` is how much longer than a plain command one sudo call took. */
  | { readonly kind: "unresolved"; readonly waitMs: number };

/** How a command is run: `execAsTransport`'s shape, injectable for tests. */
export type RunCommand = (
  transport: Transport,
  file: string,
  args: string[],
  options?: ExecOptions,
) => Promise<ExecResult>;

/**
 * Reads the measurement. Pure.
 *
 * @param sudoStderr - `sudo -n true`'s stderr, as printed.
 * @param sudoMs - how long that call took.
 * @param plainMs - how long `true` alone took over the same transport (its round trip); omitted
 * when sudo printed no host line, which then needs no comparison.
 * @returns the verdict; a negative difference (jitter) counts as no wait.
 */
export function sudoLookupFrom(
  sudoStderr: string,
  sudoMs: number,
  plainMs?: number,
): SudoLookup {
  if (!hasSudoNoise(sudoStderr)) return { kind: "resolves" };
  return {
    kind: "unresolved",
    waitMs: Math.max(0, Math.round(sudoMs - (plainMs ?? 0))),
  };
}

/**
 * Who the lookup's `sudo` call asks to run `true` as: the site's identity (what every site command
 * does in `site`), or root (what root steps do).
 */
export type SudoLookupAs =
  | { readonly kind: "identity"; readonly target: SudoTarget }
  | { readonly kind: "root" };

/**
 * Whether, and as whom, the pre-flight times sudo's host lookup: only where the run really sends
 * commands through `sudo`, so the measurement never runs anything the run itself would not. Pure.
 *
 * - `docker`: never (it elevates with `-u 0:0`, no sudo).
 * - `site`: as the identity — every site command goes through sudo, and asking for root would run
 *   `true` as root on a host whose root steps are refused or opted out of.
 * - otherwise, elevation `available`: as root — root steps go through sudo, and the elevation probe
 *   has already run the same `sudo -n true`.
 * - otherwise (`fallback`, `disabled`, `same-user` or an unresolved state without root): never — the
 *   run sends nothing through sudo, so a wait would be reported that it never pays.
 *
 * @param mode - the site's transport mode.
 * @param state - the resolved identity state, or its resolution's error.
 * @param elevation - the site's elevation support.
 * @returns as whom to time it, or `undefined` for no lookup.
 */
export function sudoLookupAs(
  mode: Transport["mode"],
  state: IdentityState | { readonly kind: "error" },
  elevation: ElevationSupport,
): SudoLookupAs | undefined {
  if (mode === "docker") return undefined;
  if (state.kind === "site") return { kind: "identity", target: state.target };
  return elevation === "available" ? { kind: "root" } : undefined;
}

/**
 * The `env` arguments of the timed `sudo` call: `LC_ALL=C`, so sudo prints its host line in English
 * whatever the session's locale (a translated line is not recognised), then `true` as `as` says.
 *
 * @param as - who to run `true` as.
 */
function sudoTrueArgs(as: SudoLookupAs): string[] {
  const who =
    as.kind === "identity" ? ["-u", as.target.user, "-g", as.target.group] : [];
  return ["LC_ALL=C", "sudo", "-n", ...who, "true"];
}

/**
 * Times `env LC_ALL=C sudo -n [-u <user> -g <group>] true` as the transport's user, from `/`; only
 * when it printed the host line, also `env LC_ALL=C true`, so the transport's own round trip (and
 * `env`'s start) is not counted. A refused sudo still looks the name up (measured), so this answers
 * on a host that refuses the call too.
 *
 * @param transport - the site's transport (`ssh` or `local`; `docker` has no sudo).
 * @param as - who to run `true` as ({@link sudoLookupAs}).
 * @param run - runs a command; {@link execAsTransport} unless a test passes another.
 * @param now - a monotonic clock in milliseconds.
 * @returns the verdict, or `undefined` when the transport failed (nothing is known).
 */
export async function probeSudoLookup(
  transport: Transport,
  as: SudoLookupAs,
  run: RunCommand = execAsTransport,
  now: () => number = () => performance.now(),
): Promise<SudoLookup | undefined> {
  try {
    const start = now();
    const sudo = await run(transport, "env", sudoTrueArgs(as), { cwd: "/" });
    const sudoMs = now() - start;
    if (!hasSudoNoise(sudo.stderr)) return sudoLookupFrom(sudo.stderr, sudoMs);
    const plainStart = now();
    await run(transport, "env", ["LC_ALL=C", "true"], { cwd: "/" });
    return sudoLookupFrom(sudo.stderr, sudoMs, now() - plainStart);
  } catch {
    return undefined;
  }
}

/**
 * The wait in words, when it is worth reporting.
 *
 * @param lookup - the measurement, if one was taken.
 * @returns `about <n> s` (one decimal), or `undefined` below {@link SLOW_SUDO_LOOKUP_MS}.
 */
export function slowSudoLookup(
  lookup: SudoLookup | undefined,
): string | undefined {
  if (lookup?.kind !== "unresolved" || lookup.waitMs < SLOW_SUDO_LOOKUP_MS) {
    return undefined;
  }
  return `about ${(lookup.waitMs / 1000).toFixed(1)} s`;
}
