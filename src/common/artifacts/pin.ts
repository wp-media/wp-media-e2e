/**
 * What a build actually built, in a form a later run can ask for again. A ref like `develop` moves
 * between a warm and the run it was for, so the orchestrator hands the run the **pin** this module
 * derives — a ref (`commit:<sha>` or `release:<tag>`) and, for a commit, the version that was built —
 * which plans to the same APVM cache entry.
 *
 * Measured offline on apvm-napi 3.0.0 and 3.3.0: a commit pin given its built version is served from
 * the cache with no network (APVM's commit check against GitHub fails and is tolerated); without the
 * version, an embedded-version product (WP Rocket) fetches its version file first, and clones when it
 * cannot.
 * A release pin always asks GitHub's API for the release, so it needs network — but names one tag.
 *
 * Pure: it reads only the fields APVM returns, so it is unit-testable without the native binding.
 */

/** A full git commit SHA: 40 lowercase hex characters, as git and APVM print it. */
const FULL_COMMIT_RE = /^[0-9a-f]{40}$/;

/**
 * APVM's release selectors, which it matches ignoring case. A `release:` source naming one of these
 * was never resolved to a tag, so pinning to it would let the run download whatever is newest by then.
 */
const RELEASE_SELECTORS: ReadonlySet<string> = new Set([
  "latest-stable",
  "previous-stable",
  "latest",
  "previous-latest",
]);

/** A release tag usable inside a ref: one token, which git ref names already guarantee. */
const RELEASE_TAG_RE = /^[^\s:]+$/;

/** The subset of APVM's build output a pin is derived from (`JsBuildOutput`). */
export interface BuiltRef {
  /** APVM's `commit`: the full SHA for a git build, `release-<tag>` for a release download. */
  readonly commit: string;
  /** APVM's `resolvedRef.source`: the kind of ref it resolved and its resolved value. */
  readonly source: { readonly type: string; readonly value: string };
  /** APVM's `result.version`: the version it built, or the release's. */
  readonly version: string;
}

/** What a run is given to rebuild exactly one build: `E2E_<ROLE>_REF`, and `_VERSION` when set. */
export interface Pin {
  /** `release:<tag>` or `commit:<sha>`. */
  readonly ref: string;
  /**
   * The version that was built, for a commit pin: APVM's cache is keyed by commit **and** version,
   * and without it an embedded-version product must look its version up (network) before the cache.
   * Absent for a release pin, whose version comes from its tag (the planner drops one anyway).
   */
  readonly version?: string;
}

/** Why a build cannot be pinned, as {@link pinOf} reports it. */
export interface PinRefusal {
  readonly refused: string;
}

/**
 * Returns `commit` when it is a full SHA, else `undefined` — the one place that decides whether
 * APVM's `commit` names a commit at all. A release download reports `release-<tag>` there, which is
 * a label, not a SHA; such an artifact is named by its pin instead.
 *
 * @param commit - APVM's `commit` field, as returned.
 */
export function fullCommit(commit: string): string | undefined {
  return FULL_COMMIT_RE.test(commit) ? commit : undefined;
}

/**
 * Derives the pin that rebuilds exactly `built`: `release:<tag>` for a release download, else
 * `commit:<sha>` with the built version. A release is checked first: it is a download of prebuilt
 * assets, so pinning it to a commit — should APVM ever report one — would build the source instead.
 *
 * @param built - the build's commit, resolved source and version, from APVM's output.
 * @returns the pin, or why there is none — never a ref that can still move.
 *
 * @example
 * ```ts
 * pinOf({ commit: "f1ebfd05…", source: { type: "branch", value: "develop" }, version: "9.99.99" });
 * // { ref: "commit:f1ebfd05…", version: "9.99.99" }
 * pinOf({ commit: "release-5.7.6", source: { type: "release", value: "5.7.6" }, version: "5.7.6" });
 * // { ref: "release:5.7.6" }
 * ```
 */
export function pinOf(built: BuiltRef): Pin | PinRefusal {
  const { type, value } = built.source;
  if (type === "release") {
    return RELEASE_TAG_RE.test(value) &&
      !RELEASE_SELECTORS.has(value.toLowerCase())
      ? { ref: `release:${value}` }
      : {
          refused:
            `cannot pin this release download: ${JSON.stringify(value)} is not a resolved release tag, so a ` +
            "run given it could download another release.",
        };
  }
  const commit = fullCommit(built.commit);
  return commit !== undefined
    ? { ref: `commit:${commit}`, version: built.version }
    : {
        refused:
          `cannot pin this build: its commit ${JSON.stringify(built.commit)} is not a full SHA ` +
          `(source: ${type} ${JSON.stringify(value)}), so a run given it could build something else.`,
      };
}

/**
 * {@link pinOf}, for a caller that must not proceed unpinned (a warm handing a run its ref).
 *
 * @param built - the build's commit, resolved source and version.
 * @throws Error naming why the build cannot be pinned.
 */
export function requirePin(built: BuiltRef): Pin {
  const pin = pinOf(built);
  if ("refused" in pin) throw new Error(`[artifacts] ${pin.refused}`);
  return pin;
}
