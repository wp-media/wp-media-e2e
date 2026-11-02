import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCached,
  createApvmWarmer,
  isCachedFile,
  toWarmedBuild,
  warmArtifacts,
} from "./warm";
import type { WarmOne, WarmUnit, WarmedBuild, WarmerDeps } from "./warm";
import type {
  JsBuildEvent,
  JsBuildOutput,
  JsBuildPhase,
  WarmOptions,
} from "apvm-napi";
import { createPalette } from "../terminal/palette";
import type { ApvmBuildParams, ArtifactEnv, ProductArtifacts } from "./types";

/**
 * Unit tests for the pure warm orchestration: deduping build requests, skipping provided zips,
 * surfacing planner warnings once, and collecting per-unit plan failures and per-request warm
 * failures without aborting the batch. The real APVM call (`createApvmWarmer`) is thin glue and
 * exercised end-to-end; here `warmOne` is a recording double.
 */

/** WP Rocket-like: editionless, embedded version, both roles — yields two build requests. */
const WPR: ProductArtifacts = {
  project: "wp-rocket",
  defaultRef: { plugin: "develop", previous: "tag:latest-stable" },
  version: { kind: "embedded" },
  edition: {
    kind: "editionless",
    identity: {
      slug: "wp-rocket",
      mainFile: "wp-rocket.php",
      pluginName: "WP Rocket",
    },
  },
};

/** BackWPup-like: editionful, required version, `plugin` only — yields one build request per cell. */
const BWU: ProductArtifacts = {
  project: "backwpup",
  defaultRef: { plugin: "develop" },
  version: { kind: "required", defaultVersion: { plugin: "9.99.99" } },
  edition: {
    kind: "editionful",
    byEdition: {
      free: {
        variant: "free",
        identity: {
          slug: "backwpup",
          mainFile: "backwpup.php",
          pluginName: "BackWPup",
        },
      },
      pro: {
        variant: "pro-en",
        identity: {
          slug: "backwpup-pro",
          mainFile: "backwpup.php",
          pluginName: "BackWPup Pro",
        },
      },
    },
  },
};

/** Empty overrides — the common case where warming plans pure defaults. */
const NO_ENV: ArtifactEnv = {};

/** A full SHA, as APVM reports a git build's `commit`. */
const SHA = "af1ab5c0ffee00112233445566778899aabbccdd";

/** What a double reports for `params`: a cached git build of {@link SHA}, pinned to it. */
function warmedFor(params: ApvmBuildParams, fromCache = true): WarmedBuild {
  return {
    fromCache,
    commit: SHA,
    version: params.version ?? "1.0.0",
    pin: { ref: `commit:${SHA}`, version: params.version ?? "1.0.0" },
    artifacts: [],
    resolvedRef: {
      input: params.gitRef,
      sourceType: "branch",
      sourceValue: params.gitRef,
      gitRef: params.gitRef,
    },
  };
}

/** A `warmOne` double that records every request it is handed and reports a cache hit. */
function recorder(): { warmOne: WarmOne; calls: ApvmBuildParams[] } {
  const calls: ApvmBuildParams[] = [];
  const warmOne: WarmOne = (params) => {
    calls.push(params);
    return Promise.resolve(warmedFor(params));
  };
  return { warmOne, calls };
}

test("warms each distinct request once, recording every unit that wanted it", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
    { label: "wp-rocket/apache", manifest: WPR, edition: undefined },
  ];
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  // Two cells, identical defaults ⇒ two distinct requests (develop, tag:latest-stable), each once.
  expect(calls.map((c) => c.gitRef).sort()).toEqual([
    "develop",
    "tag:latest-stable",
  ]);
  expect(summary.ok).toBe(true);
  for (const result of summary.results) {
    expect(result.wantedBy).toEqual(["wp-rocket/nginx", "wp-rocket/apache"]);
  }
});

test("produces APVM params identical to the resolver's plan (parity invariant)", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const { warmOne, calls } = recorder();
  await warmArtifacts(units, NO_ENV, warmOne);

  expect(calls).toEqual([
    {
      project: "backwpup",
      gitRef: "develop",
      version: "9.99.99",
      variants: ["pro-en"],
    },
  ]);
});

test("skips operator-provided zips (nothing to warm)", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
  ];
  const env: ArtifactEnv = { pluginZip: "/local/wp-rocket.zip" };
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, env, warmOne);

  // `plugin` is a provided zip ⇒ skipped; only `previous` (a ref) is warmed.
  expect(calls.map((c) => c.gitRef)).toEqual(["tag:latest-stable"]);
  expect(summary.skipped).toEqual([
    {
      label: "wp-rocket/nginx",
      role: "plugin",
      rawPath: "/local/wp-rocket.zip",
    },
  ]);
});

test("collects planner warnings once, even across units sharing the env", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/free@nginx", manifest: BWU, edition: "free" },
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  // `previous` vars on a product without that role ⇒ one warning, not one per unit.
  const env: ArtifactEnv = { previousRef: "tag:latest-stable" };
  const { warmOne } = recorder();
  const summary = await warmArtifacts(units, env, warmOne);

  const previousWarnings = summary.warnings.filter((w) =>
    w.includes("E2E_PREVIOUS_REF"),
  );
  expect(previousWarnings).toHaveLength(1);
});

test("collects a per-unit plan failure without aborting the batch", async () => {
  const units: WarmUnit[] = [
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
    // Editionful product with no edition ⇒ its plan throws; the other unit must still warm.
    { label: "backwpup/broken", manifest: BWU, edition: undefined },
  ];
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  expect(summary.planFailures.map((f) => f.label)).toEqual(["backwpup/broken"]);
  expect(calls.map((c) => c.gitRef).sort()).toEqual([
    "develop",
    "tag:latest-stable",
  ]);
  expect(summary.ok).toBe(false);
});

test("collects a per-request warm failure and marks the summary not ok", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
    { label: "wp-rocket/nginx", manifest: WPR, edition: undefined },
  ];
  const warmOne: WarmOne = (params) =>
    params.project === "backwpup"
      ? Promise.reject(new Error("boom"))
      : Promise.resolve(warmedFor(params, false));
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  const backwpup = summary.results.find((r) => r.params.project === "backwpup");
  expect(backwpup?.ok).toBe(false);
  expect(backwpup?.error).toContain("boom");
  expect(summary.results.filter((r) => r.ok).length).toBe(2); // both wp-rocket refs
  expect(summary.ok).toBe(false);
});

test("a warm failure is scrubbed before it reaches the summary", async () => {
  // The summary is printed and, via an orchestrator, can be reported. A warmer that rejects
  // with builder text carrying an authenticated remote URL must not leak it.
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const warmOne: WarmOne = () =>
    Promise.reject(
      new Error(
        "fatal: unable to access 'https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/wp-media/backwpup-pro.git/'",
      ),
    );
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  const error = summary.results[0]?.error ?? "";
  expect(error).not.toContain("ghp_16CharsOrMoreAAAA");
  expect(error).not.toContain("x-access-token");
  expect(error).toContain("github.com/wp-media/backwpup-pro.git");
});

test("an empty unit list is a clean no-op", async () => {
  const { warmOne, calls } = recorder();
  const summary = await warmArtifacts([], NO_ENV, warmOne);
  expect(calls).toHaveLength(0);
  expect(summary).toEqual({
    results: [],
    skipped: [],
    planFailures: [],
    warnings: [],
    ok: true,
  });
});

test("a successful warm carries what it cached, pin included, into its result", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const { warmOne } = recorder();
  const summary = await warmArtifacts(units, NO_ENV, warmOne);

  expect(summary.results[0]?.build).toEqual(
    warmedFor({ project: "backwpup", gitRef: "develop", version: "9.99.99" }),
  );
  expect(summary.results[0]?.build?.pin).toEqual({
    ref: `commit:${SHA}`,
    version: "9.99.99",
  });
});

test("a failed warm carries no build", async () => {
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const summary = await warmArtifacts(units, NO_ENV, () =>
    Promise.reject(new Error("boom")),
  );
  expect(summary.results[0]).not.toHaveProperty("build");
});

/**
 * APVM's warm output as `apvm.warmCache` resolves it, for a BackWPup Pro pull-request warm that had
 * to build; `over` replaces any top-level field. The ref's input, value and checked-out ref all
 * differ, as they do for a PR, so a test can tell which one a mapping took.
 */
function apvmOutput(over: Partial<JsBuildOutput> = {}): JsBuildOutput {
  return {
    result: {
      artifacts: [
        {
          variantId: "pro-en",
          path: "/home/u/.apvm/cache/backwpup/commits/9.99.99/x/backwpup-pro.zip",
          filename: "backwpup-pro.zip",
          size: 9_800_000,
          origin: "built",
        },
      ],
      buildDir: "/tmp/build",
      version: "9.99.99",
      variantsBuilt: ["pro-en"],
      totalSize: 9_800_000,
      artifactCount: 1,
    },
    resolvedRef: {
      input: "pr:123",
      source: { type: "pull_request", value: "123", description: "PR #123" },
      gitRef: "refs/pull/123/head",
      commitSha: SHA,
    },
    commit: SHA,
    commitShort: SHA.slice(0, 7),
    branch: "feature/x",
    description: `PR #123 @ ${SHA.slice(0, 7)}`,
    fromCache: false,
    ...over,
  };
}

test.describe("toWarmedBuild", () => {
  test("pins a git build to its full commit and keeps what was cached", () => {
    expect(toWarmedBuild(apvmOutput())).toEqual({
      fromCache: false,
      commit: SHA,
      version: "9.99.99",
      pin: { ref: `commit:${SHA}`, version: "9.99.99" },
      artifacts: [
        {
          variant: "pro-en",
          path: "/home/u/.apvm/cache/backwpup/commits/9.99.99/x/backwpup-pro.zip",
          origin: "built",
        },
      ],
      resolvedRef: {
        input: "pr:123",
        sourceType: "pull_request",
        sourceValue: "123",
        gitRef: "refs/pull/123/head",
      },
    });
  });

  test("reports a warm served from the cache as such", () => {
    expect(toWarmedBuild(apvmOutput({ fromCache: true })).fromCache).toBe(true);
  });

  test("pins a release download to its tag and records no commit", () => {
    const base = apvmOutput();
    const warmed = toWarmedBuild(
      apvmOutput({
        commit: "release-5.7.6",
        commitShort: "5.7.6",
        resolvedRef: {
          input: "release:latest-stable",
          source: {
            type: "release",
            value: "5.7.6",
            description: "release 5.7.6",
          },
          gitRef: "5.7.6",
        },
        result: { ...base.result, version: "5.7.6" },
      }),
    );
    expect(warmed.pin).toEqual({ ref: "release:5.7.6" });
    expect(warmed.version).toBe("5.7.6");
    expect(warmed).not.toHaveProperty("commit");
    expect(warmed.resolvedRef).toEqual({
      input: "release:latest-stable",
      sourceType: "release",
      sourceValue: "5.7.6",
      gitRef: "5.7.6",
    });
  });

  test("omits the variant of a single-variant project, which the binding reports as null", () => {
    const base = apvmOutput();
    const [artifact] = base.result.artifacts;
    if (artifact === undefined) throw new Error("fixture has an artifact");
    const warmed = toWarmedBuild(
      apvmOutput({
        result: {
          ...base.result,
          // The binding's runtime value; its typings say only "optional".
          artifacts: [{ ...artifact, variantId: null as unknown as undefined }],
        },
      }),
    );
    expect(warmed.artifacts[0]).not.toHaveProperty("variant");
  });

  test("narrows an unknown artifact origin to built", () => {
    const base = apvmOutput();
    const [artifact] = base.result.artifacts;
    if (artifact === undefined) throw new Error("fixture has an artifact");
    const warmed = toWarmedBuild(
      apvmOutput({
        result: {
          ...base.result,
          artifacts: [{ ...artifact, origin: "mirror" }],
        },
      }),
    );
    expect(warmed.artifacts[0]?.origin).toBe("built");
  });

  test("refuses a build it cannot pin", () => {
    expect(() =>
      toWarmedBuild(apvmOutput({ commit: SHA.slice(0, 7) })),
    ).toThrow(/cannot pin this build/);
  });
});

test("a warm that cannot be pinned is a failed warm", async () => {
  // The real warmer pins through `toWarmedBuild`; its throw must fail the request, not the batch.
  const units: WarmUnit[] = [
    { label: "backwpup/pro@nginx", manifest: BWU, edition: "pro" },
  ];
  const summary = await warmArtifacts(units, NO_ENV, () =>
    Promise.resolve().then(() =>
      toWarmedBuild(apvmOutput({ commit: "not-a-sha" })),
    ),
  );
  expect(summary.ok).toBe(false);
  expect(summary.results[0]?.error).toMatch(/cannot pin this build/);
});

test.describe("assertCached", () => {
  /** A warmed build holding a zip at each of `paths`. */
  function holding(...paths: string[]): WarmedBuild {
    return {
      ...warmedFor({ project: "backwpup", gitRef: "develop" }),
      artifacts: paths.map((path) => ({ path, origin: "built" as const })),
    };
  }

  test("accepts a warm whose every zip is on disk", () => {
    expect(() => {
      assertCached(holding("/cache/a.zip", "/cache/b.zip"), () => true);
    }).not.toThrow();
  });

  test("fails a warm whose zip is not in the cache, naming it", () => {
    // APVM stores a build best-effort: a cache it could not write leaves only gone temp paths.
    expect(() => {
      assertCached(
        holding("/cache/a.zip", "/tmp/ws/b.zip"),
        (path) => path === "/cache/a.zip",
      );
    }).toThrow(/does not hold "\/tmp\/ws\/b\.zip"/);
  });

  test("by default, holds only a non-empty regular file for a cached zip", () => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-cached-"));
    try {
      writeFileSync(join(dir, "full.zip"), "PK");
      writeFileSync(join(dir, "empty.zip"), "");
      mkdirSync(join(dir, "folder.zip"));
      expect(isCachedFile(join(dir, "full.zip"))).toBe(true);
      for (const name of ["empty.zip", "folder.zip", "absent.zip"]) {
        expect(isCachedFile(join(dir, name)), name).toBe(false);
      }
      expect(() => {
        assertCached(holding(join(dir, "empty.zip")));
      }).toThrow(/does not hold/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("fails a warm that reported no zip at all", () => {
    expect(() => {
      assertCached(holding(), () => true);
    }).toThrow(/no artifact/);
  });
});

test.describe("createApvmWarmer", () => {
  /** A fake APVM: records what it was asked to warm, and resolves (or rejects) as told. */
  function fakeApvm(
    outcome: JsBuildOutput | Error,
    hasToken = true,
  ): { deps: Pick<WarmerDeps, "apvm">; asked: WarmOptions[] } {
    const asked: WarmOptions[] = [];
    const apvm = {
      hasToken: (): boolean => hasToken,
      warmCache: (options: WarmOptions): Promise<JsBuildOutput> => {
        asked.push(options);
        return outcome instanceof Error
          ? Promise.reject(outcome)
          : Promise.resolve(outcome);
      },
    };
    return { deps: { apvm: () => Promise.resolve(apvm) }, asked };
  }

  const PARAMS: ApvmBuildParams = {
    project: "backwpup",
    gitRef: "pr:123",
    version: "9.99.99",
    variants: ["pro-en"],
  };

  test("warms exactly the planned request and returns the pinned build", async () => {
    const { deps, asked } = fakeApvm(apvmOutput());
    const build = await createApvmWarmer({ ...deps, exists: () => true })(
      PARAMS,
    );
    expect(asked).toEqual([
      {
        project: "backwpup",
        gitRef: "pr:123",
        version: "9.99.99",
        variants: ["pro-en"],
      },
    ]);
    expect(build.pin).toEqual({ ref: `commit:${SHA}`, version: "9.99.99" });
  });

  test("pins the version it built, not the one it asked for", async () => {
    const built = apvmOutput();
    const { deps } = fakeApvm({
      ...built,
      result: { ...built.result, version: "9.99.99-built" },
    });
    const build = await createApvmWarmer({ ...deps, exists: () => true })(
      PARAMS,
    );
    expect(build.pin).toEqual({
      ref: `commit:${SHA}`,
      version: "9.99.99-built",
    });
  });

  test("sends no version or variants the plan did not have", async () => {
    const { deps, asked } = fakeApvm(apvmOutput());
    await createApvmWarmer({ ...deps, exists: () => true })({
      project: "wp-rocket",
      gitRef: "develop",
    });
    expect(asked).toEqual([{ project: "wp-rocket", gitRef: "develop" }]);
  });

  test("fails a warm whose zips are not in the cache", async () => {
    const { deps } = fakeApvm(apvmOutput());
    await expect(
      createApvmWarmer({ ...deps, exists: () => false })(PARAMS),
    ).rejects.toThrow(/does not hold/);
  });

  test("refuses a private project without a token before warming anything", async () => {
    const { deps, asked } = fakeApvm(apvmOutput(), false);
    await expect(
      createApvmWarmer({ ...deps, exists: () => true })(PARAMS),
    ).rejects.toThrow(/needs a GitHub token/);
    expect(asked).toEqual([]);
  });

  // The script's printers, not a worker's: on a terminal the progress is coloured, warnings to stderr.
  test("prints the build's progress through the printers it is given", async () => {
    const apvm = {
      hasToken: (): boolean => true,
      warmCache: (
        _options: WarmOptions,
        onProgress: (err: Error | null, event: JsBuildEvent) => void,
      ): Promise<JsBuildOutput> => {
        onProgress(null, {
          type: "phase_started",
          phase: "Clone" as JsBuildPhase,
        });
        onProgress(null, { type: "warning", message: "slow" });
        return Promise.resolve(apvmOutput());
      },
    };
    const lines: string[] = [];
    const colour = createPalette({ tty: true, color: true, unicode: true });
    const none = createPalette({ tty: false, color: false, unicode: true });
    await createApvmWarmer(
      { apvm: () => Promise.resolve(apvm), exists: () => true },
      {
        out: { palette: colour, print: (line) => lines.push(`out:${line}`) },
        err: { palette: none, print: (line) => lines.push(`err:${line}`) },
      },
    )(PARAMS);
    expect(lines).toEqual([
      "out:  \x1b[2m[warm backwpup pr:123]\x1b[22m Clone",
      "err:  [warm backwpup pr:123] warning: slow",
    ]);
  });

  test("names the warm that failed and scrubs credentials from APVM's error", async () => {
    const { deps } = fakeApvm(
      new Error(
        "fatal: unable to access 'https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/x.git/'",
      ),
    );
    const failure = createApvmWarmer({ ...deps, exists: () => true })(PARAMS);
    await expect(failure).rejects.toThrow(
      /APVM warm of backwpup pr:123 failed/,
    );
    await expect(failure).rejects.not.toThrow(/ghp_16CharsOrMoreAAAA/);
  });
});
