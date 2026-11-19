import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

import { DEFAULT_PIXEL_THRESHOLD } from "../config/visual";

/**
 * Pure PNG pixel comparison: pngjs decode + pixelmatch, whose per-pixel metric is the HyAB
 * distance in OKLab (0 equal … 1 black vs white). Playwright's `toHaveScreenshot` bundles its own
 * older pixelmatch (YIQ metric), so the same threshold is not the same sensitivity there. No
 * browser, no Playwright, so it is unit-testable on its own and reusable for any two-image
 * comparison (the A/B check in ./ab.ts builds on it).
 */

/** Thrown when two images can't be compared because their pixel dimensions differ. */
export class ImageDimensionsMismatchError extends Error {
  constructor(
    expected: { width: number; height: number },
    actual: { width: number; height: number },
  ) {
    super(
      `image dimensions differ: expected ${String(expected.width)}×${String(expected.height)}, ` +
        `got ${String(actual.width)}×${String(actual.height)}`,
    );
    this.name = "ImageDimensionsMismatchError";
  }
}

/** Options for {@link comparePng}. */
export interface PixelDiffOptions {
  /** Per-pixel color sensitivity (0 strict … 1 lax). Defaults to the shared visual threshold. */
  readonly threshold?: number;
}

/** Outcome of comparing two PNG images. */
export interface PixelDiffResult {
  /** Pixels differing beyond the threshold. */
  readonly diffPixels: number;
  /** Total compared pixels (width × height). */
  readonly totalPixels: number;
  /** `diffPixels / totalPixels`, in 0–1. */
  readonly ratio: number;
  /**
   * PNG-encoded diff image (differences highlighted in red), for report attachment. Present only
   * when `diffPixels > 0` — there is nothing to show, and nothing to encode, when images match.
   */
  readonly diffImage?: Buffer;
}

/**
 * Pixel-compare two PNG buffers (as returned by `page.screenshot()`).
 *
 * @throws {@link ImageDimensionsMismatchError} when the images differ in size — an uncomparable state that
 *   is itself a visual regression, surfaced explicitly rather than as a misleading pixel count.
 */
export function comparePng(
  expected: Buffer,
  actual: Buffer,
  options: PixelDiffOptions = {},
): PixelDiffResult {
  const a = PNG.sync.read(expected);
  const b = PNG.sync.read(actual);
  if (a.width !== b.width || a.height !== b.height) {
    throw new ImageDimensionsMismatchError(a, b);
  }

  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, {
    threshold: options.threshold ?? DEFAULT_PIXEL_THRESHOLD,
  });
  const totalPixels = a.width * a.height;

  return {
    diffPixels,
    totalPixels,
    ratio: totalPixels === 0 ? 0 : diffPixels / totalPixels,
    // Encode the highlighted diff only when something differs — skips a full-image PNG encode on
    // the common passing path (pixelmatch otherwise renders the whole dimmed image).
    ...(diffPixels > 0 ? { diffImage: PNG.sync.write(diff) } : {}),
  };
}
