import { posix } from "node:path";

import { describeTarget, exec, wpRootDir } from "./exec";
import {
  matches,
  normalizeOwnership,
  ownershipOf,
  parseStatOwnership,
} from "./ownership";
import { resolveSiteIdentity } from "./site-identity";
import { withinBudget } from "../deadline";
import { errorMessage } from "../guards";
import type { OwnershipOutcome, SiteOwnership } from "./ownership";
import type { IdentityState } from "./site-identity";
import type { Transport } from "../config/types";

/**
 * What a plugin's **activation** writes outside its own folder (`ProductConfig.installOutputs`):
 * WP Rocket's `wp-content/advanced-cache.php`, its cache and config folders.
 *
 * The plugin's folder is handed to the site's ownership by `stageAndInstallPlugin`; these are not,
 * since only the product knows them. When commands run as the transport's user (every identity state
 * but `site`), activation leaves them that user's, and the web server may be unable to write them —
 * so each one the install **created** goes through {@link normalizeOwnership}. In `site` the identity
 * wrote them; they are only verified, and a mismatch is warned about.
 *
 * Only what is new is touched: an output that existed before the install (a shared
 * `wp-content/cache`, another plugin's, an earlier run's) is the site's, and a recursive handover of
 * it would take whatever else lives there. Nothing here creates or removes an output — removal is
 * residue's — and nothing here throws: like ownership, it is housekeeping and never fails a scenario.
 * Validation of the declaration lives in `./paths.ts` (`normaliseInstallOutputs`).
 */

/**
 * How long {@link settleInstallOutputs} may take before the install moves on without it. A handover
 * costs about five round trips per new output (≈ 0.8 s each over SSH, measured: the root and its
 * resolution, the grant, the chown, the verifying re-read), so ≈ 4 s; a fresh WP Rocket install
 * creates three top-level outputs (its cache folders sit in a new `wp-content/cache`, covered), and
 * 30 s holds seven. It also bounds the Before hook: its install measured up to 73 s of a 120 s
 * budget, and 73 + 30 still leaves margin.
 */
export const SETTLE_BUDGET_MS = 30_000;

/** A name for `$0` of the check's shell, so a process listing says what it is. */
const CHECK_NAME = "e2e-install-outputs";

/**
 * The batched existence check: for each path argument that exists — a dangling symbolic link
 * included —, its 1-based index and either `L` (a symbolic link, never followed) or its
 * `user:group:uid:gid` (empty when `stat` cannot read it). Paths arrive as arguments, never in the
 * script, so no path is ever parsed by a shell. Exits 0 unless the shell itself fails.
 */
export const OUTPUTS_CHECK_SCRIPT = `i=0
for p do
  i=$((i + 1))
  if [ -h "$p" ]; then
    printf '%s L\\n' "$i"
  elif [ -e "$p" ]; then
    printf '%s %s\\n' "$i" "$(stat -c '%U:%G:%u:%g' -- "$p" 2>/dev/null)"
  fi
done`;

/** One output found on the site: a symbolic link, or an entry with its owner when readable. */
export type FoundOutput =
  | { readonly kind: "symlink" }
  | { readonly kind: "entry"; readonly owner: SiteOwnership | undefined };

/** The outputs found on the site, by declared path; absent ones are not keys. */
export type OutputsFound = ReadonlyMap<string, FoundOutput>;

/**
 * What {@link recordInstallOutputs} saw before the install: the declared outputs and which existed,
 * or `undefined` when the check could not answer (warned; nothing is then handed over).
 */
export type OutputsBefore =
  | {
      readonly outputs: readonly string[];
      readonly existing: ReadonlySet<string>;
    }
  | undefined;

/** What {@link settleInstallOutputs} did with one new output. */
export type InstallOutputResult =
  /** Fallback/disabled: given to {@link normalizeOwnership}, with its outcome. */
  | {
      readonly path: string;
      readonly kind: "handed-over";
      readonly outcome: OwnershipOutcome;
    }
  /**
   * Fallback/disabled: inside a new output handed over recursively, so nothing more to run; `outcome`
   * is that output's, so a failed or skipped handover reads as one here too.
   */
  | {
      readonly path: string;
      readonly kind: "covered";
      readonly by: string;
      readonly outcome: OwnershipOutcome;
    }
  /** `site`: owned by the identity, as it should be. */
  | { readonly path: string; readonly kind: "owned" }
  /** `site`: owned by someone else, or unreadable (`owner` undefined); warned. */
  | {
      readonly path: string;
      readonly kind: "not-owned";
      readonly owner: SiteOwnership | undefined;
    }
  /** A symbolic link: left alone in every state, warned. */
  | { readonly path: string; readonly kind: "symlink" };

/**
 * Reads {@link OUTPUTS_CHECK_SCRIPT}'s output. Lines that are not an index of `outputs` are ignored.
 *
 * @param stdout - what the check printed.
 * @param outputs - the paths it was given, in order.
 * @returns the outputs found.
 */
export function parseOutputsCheck(
  stdout: string,
  outputs: readonly string[],
): OutputsFound {
  const found = new Map<string, FoundOutput>();
  for (const line of stdout.split("\n")) {
    // The owner half may be empty (`stat` could not read it), and a trimmed line then has no space.
    const match = /^(\d+)(?: (.*))?$/.exec(line.trimEnd());
    if (match === null) continue;
    const path = outputs[Number(match[1]) - 1];
    if (path === undefined) continue;
    const rest = match[2] ?? "";
    found.set(
      path,
      rest === "L"
        ? { kind: "symlink" }
        : { kind: "entry", owner: parseStatOwnership(rest) },
    );
  }
  return found;
}

/**
 * The outputs present after the install that were not before, in declared order.
 *
 * @param outputs - the declared outputs.
 * @param existing - those present before the install.
 * @param after - those present after it.
 */
export function newOutputs(
  outputs: readonly string[],
  existing: ReadonlySet<string>,
  after: OutputsFound,
): readonly string[] {
  return outputs.filter((path) => after.has(path) && !existing.has(path));
}

/**
 * The nearest of `paths` strictly above `path`, if any — the one whose recursive handover already
 * covers it.
 *
 * @param path - a normalised relative path.
 * @param paths - normalised relative paths.
 */
export function coveringPath(
  path: string,
  paths: readonly string[],
): string | undefined {
  return paths
    .filter((other) => path.startsWith(`${other}/`))
    .sort((a, b) => b.length - a.length)[0];
}

/**
 * The outermost of `paths` strictly above `path` — the one actually handed over when several nest
 * (`cache` over `cache/a` over `cache/a/b`).
 *
 * @param path - a normalised relative path.
 * @param paths - normalised relative paths.
 * @returns it, or `undefined` when none covers `path`.
 */
export function outermostCovering(
  path: string,
  paths: readonly string[],
): string | undefined {
  let by = coveringPath(path, paths);
  for (let up = by; up !== undefined; up = coveringPath(up, paths)) by = up;
  return by;
}

/**
 * Runs {@link OUTPUTS_CHECK_SCRIPT} on the site, as whoever its commands run as (who will create the
 * outputs, so who can see them).
 *
 * @param transport - the site's transport.
 * @param outputs - the declared outputs, non-empty.
 * @returns what was found, or `undefined` when the check exited non-zero.
 * @throws Error if the command could not run (transport failure), as {@link exec}.
 */
async function checkOutputs(
  transport: Transport,
  outputs: readonly string[],
): Promise<OutputsFound | undefined> {
  // Absolute, so the answer does not depend on the transport's working directory (a docker
  // container's is its image's).
  const root = await wpRootDir(transport);
  const result = await exec(transport, "sh", [
    "-c",
    OUTPUTS_CHECK_SCRIPT,
    CHECK_NAME,
    ...outputs.map((path) => posix.join(root, path)),
  ]);
  return result.exitCode === 0
    ? parseOutputsCheck(result.stdout, outputs)
    : undefined;
}

/**
 * Before the install: which declared outputs already exist. No command when none is declared, nor
 * when nothing could be done with the answer: `transport.fileOwner: false` outside the `site` state,
 * where {@link normalizeOwnership} would hand nothing over (`site` still verifies).
 *
 * @param transport - the site's transport.
 * @param outputs - the product's validated outputs.
 * @returns what {@link settleInstallOutputs} needs (no outputs when skipped); `undefined` (warned)
 * when the check, or the identity it depends on, failed.
 */
export async function recordInstallOutputs(
  transport: Transport,
  outputs: readonly string[],
): Promise<OutputsBefore> {
  const nothing = { outputs: [], existing: new Set<string>() };
  if (outputs.length === 0) return nothing;
  try {
    if (
      transport.fileOwner === false &&
      (await resolveSiteIdentity(transport)).kind !== "site"
    ) {
      return nothing;
    }
    const found = await checkOutputs(transport, outputs);
    if (found !== undefined) {
      return { outputs, existing: new Set(found.keys()) };
    }
    unchecked(transport, "before", "its check exited non-zero");
  } catch (error) {
    unchecked(transport, "before", errorMessage(error));
  }
  return undefined;
}

/**
 * After the install and its active-state re-assert: hands each new output over (fallback, disabled,
 * same-user — {@link normalizeOwnership} decides what that takes), or verifies the identity owns it
 * (`site`). Never throws: every failure is warned and ends the step. Bounded by `budgetMs`: past it
 * the install goes on (warned) while the step, which nothing can cancel, finishes on its own.
 *
 * @param transport - the site's transport.
 * @param before - what {@link recordInstallOutputs} returned.
 * @param budgetMs - how long it may take; {@link SETTLE_BUDGET_MS} unless a spec needs it shorter.
 * @returns what was done with each new output; empty when nothing was new, nothing could be told or
 * the budget ran out.
 */
export async function settleInstallOutputs(
  transport: Transport,
  before: OutputsBefore,
  budgetMs: number = SETTLE_BUDGET_MS,
): Promise<readonly InstallOutputResult[]> {
  if (before === undefined || before.outputs.length === 0) return [];
  try {
    return await withinBudget(
      settle(transport, before),
      budgetMs,
      "handing over (or verifying) the install outputs",
    );
  } catch (error) {
    warn(
      transport,
      `${errorMessage(error)}; the install went on without it, so outputs it created may keep ` +
        "the ownership they were written with",
    );
    return [];
  }
}

/**
 * {@link settleInstallOutputs}' work, unbounded.
 *
 * @param transport - the site's transport.
 * @param before - a record with outputs.
 * @returns what was done with each new output.
 */
async function settle(
  transport: Transport,
  before: NonNullable<OutputsBefore>,
): Promise<readonly InstallOutputResult[]> {
  try {
    const after = await checkOutputs(transport, before.outputs);
    if (after === undefined) {
      unchecked(transport, "after", "its check exited non-zero");
      return [];
    }
    const created = newOutputs(before.outputs, before.existing, after);
    if (created.length === 0) return [];
    const state = await resolveSiteIdentity(transport);
    return state.kind === "site"
      ? verifyOwned(transport, created, after, state)
      : await handOver(transport, created, after);
  } catch (error) {
    unchecked(transport, "after", errorMessage(error));
    return [];
  }
}

/**
 * `site`: each new output must be the identity's, since the identity created it. A mismatch is a
 * warning — the scenario may still pass, but the web server could not write it.
 *
 * @param transport - the site's transport, for the messages.
 * @param created - the new outputs.
 * @param after - what the check after the install read.
 * @param state - the `site` state, whose identity should own them.
 */
function verifyOwned(
  transport: Transport,
  created: readonly string[],
  after: OutputsFound,
  state: Extract<IdentityState, { kind: "site" }>,
): readonly InstallOutputResult[] {
  const target = ownershipOf(state.identity);
  return created.map((path): InstallOutputResult => {
    const found = after.get(path);
    if (found?.kind === "symlink") return symlinkLeft(transport, path);
    const owner = found?.owner;
    if (owner !== undefined && matches(owner, target)) {
      return { path, kind: "owned" };
    }
    warn(
      transport,
      `"${path}", which the install created, is owned by ` +
        `${owner === undefined ? "nobody readable" : `${owner.user}:${owner.group}`}, not by ` +
        `${target.user}:${target.group}, whom this site's commands run as; the web server may be ` +
        "unable to write it",
    );
    return { path, kind: "not-owned", owner };
  });
}

/**
 * Every other state: each new output to {@link normalizeOwnership}, which is recursive — so one
 * inside a new output handed over is covered by the outermost such output, costs nothing and carries
 * its outcome. A symbolic link is never handed over, nor covers (`chmod` would follow it).
 *
 * @param transport - the site's transport.
 * @param created - the new outputs.
 * @param after - what the check after the install read.
 */
async function handOver(
  transport: Transport,
  created: readonly string[],
  after: OutputsFound,
): Promise<readonly InstallOutputResult[]> {
  const links = new Set(
    created.filter((path) => after.get(path)?.kind === "symlink"),
  );
  const entries = created.filter((path) => !links.has(path));
  // Every uncovered output first, so a covered one can carry its outcome whatever the declared order.
  const outcomes = new Map<string, OwnershipOutcome>();
  for (const path of entries) {
    if (coveringPath(path, entries) === undefined) {
      outcomes.set(path, await normalizeOwnership(transport, path));
    }
  }
  return created.map((path): InstallOutputResult => {
    if (links.has(path)) return symlinkLeft(transport, path);
    const by = outermostCovering(path, entries);
    // Set above for every uncovered entry; "failed" only to satisfy the type.
    const outcome = outcomes.get(by ?? path) ?? "failed";
    return by === undefined
      ? { path, kind: "handed-over", outcome }
      : { path, kind: "covered", by, outcome };
  });
}

/**
 * Warns that a new output is a symbolic link, left alone.
 *
 * @param transport - the site's transport.
 * @param path - the output.
 */
function symlinkLeft(transport: Transport, path: string): InstallOutputResult {
  warn(
    transport,
    `"${path}", which the install created, is a symbolic link; its ownership was left alone, ` +
      "since handing it over would act on what it points to",
  );
  return { path, kind: "symlink" };
}

/**
 * Warns that the outputs could not be read, so none is handed over or verified.
 *
 * @param transport - the site's transport.
 * @param when - which read failed.
 * @param why - its reason.
 */
function unchecked(
  transport: Transport,
  when: "before" | "after",
  why: string,
): void {
  warn(
    transport,
    `could not read which install outputs exist ${when} the install (${why}), so none was ` +
      "handed over or verified",
  );
}

/**
 * One warning line about this site's install outputs.
 *
 * @param transport - the site's transport, named in the line.
 * @param what - what happened, without a final period.
 */
function warn(transport: Transport, what: string): void {
  console.warn(`[wp/install-outputs] ${describeTarget(transport)}: ${what}.`);
}
