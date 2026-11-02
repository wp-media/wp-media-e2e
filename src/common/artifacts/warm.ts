/**
 * Pre-warming: prime APVM's cache so N cells wanting the same uncached build do not build it N
 * times, and so build minutes do not count against test wall-time. `warmCache()`
 * runs the same build pipeline but delivers nothing; a later per-cell `build()` is then a cache
 * copy.
 *
 * The correctness property is the **parity invariant**: warming must produce the exact
 * `{project, gitRef, version, variants}` a real run would, or the warmed entry is never hit and
 * the warm is wasted. This module therefore plans through the **same** `buildArtifactPlan` the
 * resolver uses, with `serial: false` — the mode a real run of one cell plans in — so
 * overrides apply identically on both sides.
 *
 * Each warm hands back what it actually cached as a {@link WarmedBuild}, including the
 * {@link WarmedBuild.pin} that rebuilds exactly that: a ref like `develop` can move before the run
 * it was warmed for starts, so an orchestrator gives the run the pin, not the ref it asked for.
 *
 * {@link warmArtifacts} is pure orchestration (dedupe, skip provided zips, collect failures) with
 * the actual cache call injected as a {@link WarmOne}, so it is unit-testable without APVM;
 * {@link createApvmWarmer} supplies the real one. The standalone CLI (`warm-artifacts.ts`) and,
 * later, an orchestrator both call `warmArtifacts` with it.
 */

import { statSync } from "node:fs";

import {
  assertToken,
  createBuildReporter,
  getApvm,
  redactBuildText,
  toArtifactOrigin,
} from "./apvm";
import { errorMessage } from "../guards";
import { fullCommit, requirePin } from "./pin";
import type { Pin } from "./pin";
import { buildArtifactPlan } from "./request";
import type {
  ApvmBuildParams,
  ArtifactEnv,
  ArtifactOrigin,
  ProductArtifacts,
} from "./types";
import type { Edition } from "../config/types";
import type { Printers } from "../config/output";
import type { Apvm, JsBuildOutput, WarmOptions } from "apvm-napi";

/** One `(product × cell)` to warm: its manifest, the cell's edition, and a display label. */
export interface WarmUnit {
  /** Human-readable `"<product>/<cell>"` identity, used in logs and the summary. */
  readonly label: string;
  /** The product's artifact manifest (`ProductConfig.artifacts`). */
  readonly manifest: ProductArtifacts;
  /** The cell's edition, or `undefined` for an editionless product. */
  readonly edition: Edition | undefined;
}

/** One zip a warm left in APVM's cache. */
export interface WarmedArtifact {
  /** APVM's variant id (`"pro-en"`, `"free"`); absent for a single-variant project. */
  readonly variant?: string;
  /** Where the zip sits inside APVM's cache — read it, never move or modify it. */
  readonly path: string;
  /** Whether this zip was already cached, or had to be built or downloaded to warm it. */
  readonly origin: ArtifactOrigin;
}

/** The ref APVM resolved for a warm: what was asked for, and what it turned out to be. */
export interface WarmedRef {
  /** The ref as requested (`"develop"`, `"release:latest-stable"`). */
  readonly input: string;
  /** APVM's kind of ref: `"branch"`, `"pull_request"`, `"tag"`, `"commit"` or `"release"`. */
  readonly sourceType: string;
  /** Its resolved value — a branch name, PR number, tag, SHA, or the release's actual tag. */
  readonly sourceValue: string;
  /** The git ref APVM checked out. */
  readonly gitRef: string;
}

/** What one successful warm cached, and the pin that reproduces it. */
export interface WarmedBuild {
  /** Whether APVM served the whole warm from cache (no build or download ran). */
  readonly fromCache: boolean;
  /** The full commit SHA built; absent for a release download, which its {@link Pin} names. */
  readonly commit?: string;
  /** The plugin version APVM built (or the release's). */
  readonly version: string;
  /**
   * What a run is given to rebuild exactly this: `E2E_<ROLE>_REF=<pin.ref>`, plus
   * `E2E_<ROLE>_VERSION=<pin.version>` when set. It plans to this cache entry.
   */
  readonly pin: Pin;
  /** The zips the warm left in APVM's cache. */
  readonly artifacts: readonly WarmedArtifact[];
  /** The ref APVM resolved: what was asked for, and what it turned out to be. */
  readonly resolvedRef: WarmedRef;
}

/** The outcome of warming one deduped build request. */
export interface WarmResult {
  /** The APVM params warmed (the deduped `{project, gitRef, version, variants}`). */
  readonly params: ApvmBuildParams;
  /** Labels of the units that requested this build (deduped requests are shared). */
  readonly wantedBy: readonly string[];
  readonly ok: boolean;
  /** What was cached and how to pin a run to it; present on success. */
  readonly build?: WarmedBuild;
  /** The failure message; present on failure. */
  readonly error?: string;
}

/** A build request skipped because it is an operator-provided zip — there is nothing to warm. */
export interface WarmSkip {
  readonly label: string;
  readonly role: string;
  /** The `E2E_<ROLE>_ZIP` path that made this role a provided zip. */
  readonly rawPath: string;
}

/** A unit whose plan could not be built (e.g. a ref+zip conflict) — collected, never fatal to the batch. */
export interface WarmPlanFailure {
  readonly label: string;
  readonly error: string;
}

/** The aggregate outcome of a warm run. `ok` iff every plan built and every warm succeeded. */
export interface WarmSummary {
  readonly results: readonly WarmResult[];
  readonly skipped: readonly WarmSkip[];
  readonly planFailures: readonly WarmPlanFailure[];
  /** Deduplicated planner warnings (inapplicable/ignored env vars). */
  readonly warnings: readonly string[];
  readonly ok: boolean;
}

/**
 * Warms one build request into APVM's cache and reports what it cached. Injected into
 * {@link warmArtifacts} so the orchestration is testable without APVM; {@link createApvmWarmer}
 * provides the real one. Rejects when the warm fails — or when its result cannot be pinned.
 */
export type WarmOne = (params: ApvmBuildParams) => Promise<WarmedBuild>;

/**
 * Plans every unit (same code path as the resolver — the parity invariant), then warms each
 * **distinct** build request once, serially. Operator-provided zips are skipped (nothing to
 * build); per-unit plan failures and per-request warm failures are collected, never thrown, so
 * one bad unit never aborts the batch — the caller decides what to do with the summary.
 *
 * @param units - the `(product × cell)`s to warm.
 * @param env - the already-read `E2E_*` overrides ({@link ArtifactEnv}); applied because warm
 * plans in the same `serial: false` mode a real run of one cell does.
 * @param warmOne - the cache primer (real or a test double).
 */
export async function warmArtifacts(
  units: readonly WarmUnit[],
  env: ArtifactEnv,
  warmOne: WarmOne,
): Promise<WarmSummary> {
  const warnings: string[] = [];
  const skipped: WarmSkip[] = [];
  const planFailures: WarmPlanFailure[] = [];
  const requests = new Map<
    string,
    { params: ApvmBuildParams; wantedBy: string[] }
  >();

  for (const unit of units) {
    collectUnit(unit, env, { warnings, skipped, planFailures, requests });
  }

  const results: WarmResult[] = [];
  for (const { params, wantedBy } of requests.values()) {
    results.push(await warmRequest(params, wantedBy, warmOne));
  }

  const ok = planFailures.length === 0 && results.every((r) => r.ok);
  return { results, skipped, planFailures, warnings, ok };
}

/** Accumulators threaded through {@link collectUnit} while planning the batch. */
interface Accumulators {
  readonly warnings: string[];
  readonly skipped: WarmSkip[];
  readonly planFailures: WarmPlanFailure[];
  readonly requests: Map<
    string,
    { params: ApvmBuildParams; wantedBy: string[] }
  >;
}

/**
 * Plans one unit and folds its requests into the batch: build requests are deduped by
 * {@link requestKey} (each unit that wants a request is recorded), provided-zip requests are
 * recorded as skips, planner warnings are collected once, and a plan throw becomes a captured
 * {@link WarmPlanFailure}.
 */
function collectUnit(
  unit: WarmUnit,
  env: ArtifactEnv,
  acc: Accumulators,
): void {
  let plan;
  try {
    plan = buildArtifactPlan({
      product: unit.manifest,
      edition: unit.edition,
      // Warm as a real run of one cell plans (overrides apply) — the parity invariant.
      serial: false,
      env,
    });
  } catch (error) {
    acc.planFailures.push({ label: unit.label, error: errorMessage(error) });
    return;
  }

  for (const warning of plan.warnings) {
    if (!acc.warnings.includes(warning)) acc.warnings.push(warning);
  }

  for (const request of plan.requests) {
    if (request.kind === "zip") {
      acc.skipped.push({
        label: unit.label,
        role: request.role,
        rawPath: request.rawPath,
      });
      continue;
    }
    const key = requestKey(request.params);
    const existing = acc.requests.get(key);
    if (existing === undefined) {
      acc.requests.set(key, { params: request.params, wantedBy: [unit.label] });
    } else if (!existing.wantedBy.includes(unit.label)) {
      existing.wantedBy.push(unit.label);
    }
  }
}

/** Warms one request, converting a thrown error into a failed {@link WarmResult}. */
async function warmRequest(
  params: ApvmBuildParams,
  wantedBy: readonly string[],
  warmOne: WarmOne,
): Promise<WarmResult> {
  try {
    const build = await warmOne(params);
    return { params, wantedBy, ok: true, build };
  } catch (error) {
    // Redact at the funnel too (idempotent): `createApvmWarmer` scrubs its own rejection, but
    // an `Apvm` that failed to initialise — or any other injected warmer — surfaces here.
    return {
      params,
      wantedBy,
      ok: false,
      error: redactBuildText(errorMessage(error)),
    };
  }
}

/**
 * The dedupe key for a build request: the tuple that fixes what APVM produces. Two requests
 * with the same key resolve to the same cache entry, so warming one covers both. (Distinct keys
 * that resolve to the same commit — e.g. `develop` vs `branch:develop` — are not merged here;
 * APVM's own cache absorbs that, re-resolving then hitting the cached commit build.)
 */
function requestKey(params: ApvmBuildParams): string {
  return [
    params.project,
    params.gitRef,
    params.version ?? "",
    (params.variants ?? []).join("+"),
  ].join("::");
}

/**
 * Turns APVM's warm output into a {@link WarmedBuild}, deriving the pin.
 *
 * @param output - what `apvm.warmCache` resolved with.
 * @throws Error from {@link requirePin} when the build cannot be pinned — a warm whose result a run
 * cannot be held to is a failed warm, so no run is ever left on a ref that moves.
 */
export function toWarmedBuild(output: JsBuildOutput): WarmedBuild {
  const { resolvedRef } = output;
  const commit = fullCommit(output.commit);
  return {
    fromCache: output.fromCache,
    ...(commit !== undefined ? { commit } : {}),
    version: output.result.version,
    pin: requirePin({
      commit: output.commit,
      source: resolvedRef.source,
      version: output.result.version,
    }),
    artifacts: output.result.artifacts.map((artifact) => ({
      // Typed optional, but the binding hands back `null` for a single-variant project.
      ...(typeof artifact.variantId === "string"
        ? { variant: artifact.variantId }
        : {}),
      path: artifact.path,
      origin: toArtifactOrigin(artifact.origin),
    })),
    resolvedRef: {
      input: resolvedRef.input,
      sourceType: resolvedRef.source.type,
      sourceValue: resolvedRef.source.value,
      gitRef: resolvedRef.gitRef,
    },
  };
}

/**
 * Confirms a warm really left its zips in APVM's cache. APVM stores a fresh build in its cache on a
 * best-effort basis — an unwritable cache or a full disk is only a warning, and the warm still
 * resolves, naming the build's temporary paths, which are already gone — so a pin from such a warm
 * would send the run on a cold build it was meant to skip.
 *
 * @param build - the warm's result.
 * @param exists - whether a path holds a cached zip ({@link isCachedFile}; injected for tests).
 * @throws Error naming what is missing, when the warm cached nothing or a zip is not on disk.
 */
export function assertCached(
  build: WarmedBuild,
  exists: (path: string) => boolean = isCachedFile,
): void {
  if (build.artifacts.length === 0) {
    throw new Error(
      "[artifacts] the warm reported no artifact, so nothing is cached.",
    );
  }
  const missing = build.artifacts.filter((a) => !exists(a.path));
  if (missing.length > 0) {
    throw new Error(
      `[artifacts] the warm reported success, but APVM's cache does not hold ` +
        `${missing.map((a) => `"${a.path}"`).join(", ")} — check its cache folder is writable and ` +
        "has space, then warm again.",
    );
  }
}

/**
 * Whether `path` is a non-empty regular file: what a cached zip is. A folder of that name, or a file a
 * full disk left empty, would otherwise pass for the cache.
 *
 * @param path - where the warm says it cached a zip.
 */
export function isCachedFile(path: string): boolean {
  try {
    const stats = statSync(path);
    return stats.isFile() && stats.size > 0;
  } catch {
    return false;
  }
}

/** What {@link createApvmWarmer} talks to: APVM, and the filesystem to confirm what it cached. */
export interface WarmerDeps {
  /** The APVM instance to warm with — only its token check and `warmCache` are used. */
  readonly apvm: () => Promise<Pick<Apvm, "hasToken" | "warmCache">>;
  /** Whether a path holds a cached zip ({@link isCachedFile}). */
  readonly exists: (path: string) => boolean;
}

/** The real {@link WarmerDeps}: the process-wide APVM and the local filesystem. */
const DEFAULT_WARMER_DEPS: WarmerDeps = {
  apvm: getApvm,
  exists: isCachedFile,
};

/**
 * The real {@link WarmOne}: asserts a token for private-source products (before any clone),
 * then calls `apvm.warmCache` with a progress reporter, enriching a failure
 * with the builder's reason and last output lines. A result that cannot be pinned, or whose zips
 * are not in the cache, is a failed warm.
 *
 * @param deps - the APVM instance and the file check, injected for tests; the real ones by default.
 * @param printers - where the build's progress and warnings go, with their streams' palettes; a test
 *   worker's by default (`createBuildReporter`'s).
 */
export function createApvmWarmer(
  deps: WarmerDeps = DEFAULT_WARMER_DEPS,
  printers?: Printers,
): WarmOne {
  return async (params) => {
    const apvm = await deps.apvm();
    assertToken(apvm, params.project);

    const label = `${params.project} ${params.gitRef}`;
    const reporter = createBuildReporter(`warm ${label}`, printers);
    const options: WarmOptions = {
      project: params.project,
      gitRef: params.gitRef,
      ...(params.version !== undefined ? { version: params.version } : {}),
      ...(params.variants !== undefined
        ? { variants: [...params.variants] }
        : {}),
    };

    const output = await apvm
      .warmCache(options, reporter.onProgress)
      .catch((error: unknown) => {
        // Redact: a private-repo warm's error text can echo the authenticated remote URL.
        throw new Error(
          `APVM warm of ${label} failed: ${redactBuildText(errorMessage(error))}${reporter.failureContext()}`,
        );
      });
    const build = toWarmedBuild(output);
    assertCached(build, deps.exists);
    return build;
  };
}
