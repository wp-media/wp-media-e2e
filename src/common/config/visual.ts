import type { PlaywrightTestConfig } from "@playwright/test";

/**
 * Shared visual-comparison tolerances and config. Both visual models share the pixel ratio:
 *  - the optimized-vs-unoptimized A/B check (`src/common/visual/ab.ts`) — what WP Rocket uses, and
 *  - committed-baseline `toHaveScreenshot` (via {@link VISUAL_EXPECT}) — the general capability.
 * Their per-pixel metrics differ (see {@link DEFAULT_PIXEL_THRESHOLD}).
 */

/** Share of pixels (0–1) allowed to differ before a visual check fails. Reliability-first default. */
export const DEFAULT_MAX_DIFF_PIXEL_RATIO = 0.01;

/**
 * Per-pixel color sensitivity of the A/B check (0 strict … 1 lax): the largest OKLab HyAB distance
 * (black vs white = 1) still counted equal by pixelmatch. Numerically Playwright's
 * `toHaveScreenshot` default, but not its sensitivity: Playwright bundles a YIQ pixelmatch, whose
 * 0.2 lets through some changes HyAB counts (pure blue vs navy) and counts some HyAB lets through.
 * Untuned for HyAB: re-tune it against the first real A/B scenario.
 */
export const DEFAULT_PIXEL_THRESHOLD = 0.2;

/**
 * Committed-baseline settings applied by the config factory. Playwright's `toHaveScreenshot`
 * already disables animations, hides the caret, waits for fonts, and retries until two consecutive
 * captures match — so those defaults are not repeated; only the tolerance is set here. Baselines
 * are pixel-deterministic only per-platform, so generate/compare them in the Playwright container.
 */
export const VISUAL_EXPECT: PlaywrightTestConfig["expect"] = {
  toHaveScreenshot: {
    maxDiffPixelRatio: DEFAULT_MAX_DIFF_PIXEL_RATIO,
  },
};

/**
 * Where committed baseline screenshots live: per product, then per cell (`{projectName}`), so
 * editions that render differently (e.g. BackWPup Free vs Pro, which run as distinct cells) never
 * share a baseline. Relative to the repo root. The ephemeral generated-spec directory
 * (`.features-gen`) is deliberately NOT part of the path, so baselines survive its regeneration.
 *
 * The path has no **device** dimension, because the device profile is a per-scenario tag
 * (`@mobile`) and a path template is resolved per project. Playwright's default snapshot name is
 * derived from the scenario title, so a desktop and a mobile scenario are already distinct. But an
 * **explicitly named** snapshot (`toHaveScreenshot("dashboard.png")`) reused by both would collide
 * on one baseline — name such snapshots per device, or let the default naming do it.
 */
export function snapshotPathTemplateFor(product: string): string {
  return `src/projects/${product}/__snapshots__{/projectName}/{arg}{ext}`;
}
