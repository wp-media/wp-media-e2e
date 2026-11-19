import { test, expect } from "@playwright/test";
import { PNG } from "pngjs";

import { ImageDimensionsMismatchError, comparePng } from "./compare";

// A solid-color PNG of the given size, encoded as a buffer (the form `page.screenshot()` returns) —
// so these tests exercise the real pngjs-decode + pixelmatch path with no browser.
function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    png.data[o] = r;
    png.data[o + 1] = g;
    png.data[o + 2] = b;
    png.data[o + 3] = 255;
  }
  return PNG.sync.write(png);
}

test.describe("comparePng", () => {
  test("identical images → zero diff, no diff image", () => {
    const image = solidPng(20, 20, [255, 255, 255]);
    const result = comparePng(image, image);
    expect(result.diffPixels).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.totalPixels).toBe(400);
    expect(result.diffImage).toBeUndefined(); // not encoded when nothing differs
  });

  test("fully different images → ratio 1, diff image produced", () => {
    const white = solidPng(20, 20, [255, 255, 255]);
    const black = solidPng(20, 20, [0, 0, 0]);
    const result = comparePng(white, black);
    expect(result.diffPixels).toBe(400);
    expect(result.ratio).toBe(1);
    expect(result.diffImage).toBeInstanceOf(Buffer);
  });

  test("a small localized change → small non-zero ratio", () => {
    const base = solidPng(20, 20, [255, 255, 255]);
    const png = PNG.sync.read(base);
    png.data[0] = 0; // flip one pixel to black (R channel; threshold leaves the rest equal)
    png.data[1] = 0;
    png.data[2] = 0;
    const result = comparePng(base, PNG.sync.write(png));
    expect(result.diffPixels).toBe(1);
    expect(result.ratio).toBeCloseTo(1 / 400, 5);
  });

  // Pins the per-pixel colour metric at the default threshold (OKLab lightness + HyAB distance,
  // black vs white = 1): a shift people can't see passes, one they plainly see is counted.
  test("a near-identical colour (white vs #f5f5f5) → zero diff at the default threshold", () => {
    const white = solidPng(4, 4, [255, 255, 255]);
    const offWhite = solidPng(4, 4, [245, 245, 245]); // HyAB ≈ 0.035
    expect(comparePng(white, offWhite).diffPixels).toBe(0);
    // Not a no-op comparison: the strictest threshold sees the same pair as different.
    expect(comparePng(white, offWhite, { threshold: 0 }).diffPixels).toBe(16);
  });

  test("a clearly different colour (red vs blue) → every pixel counted at the default threshold", () => {
    const red = solidPng(4, 4, [200, 30, 30]);
    const blue = solidPng(4, 4, [30, 30, 200]); // HyAB ≈ 0.53
    expect(comparePng(red, blue).diffPixels).toBe(16);
  });

  test("pure blue darkened to navy → counted at the default threshold (YIQ would pass it)", () => {
    // YIQ, the earlier metric, puts this pair at ≈ 0.16 and passed it at 0.2; HyAB puts it at
    // ≈ 0.32, so a swap back to a YIQ-based engine fails here.
    const blue = solidPng(4, 4, [0, 0, 255]);
    const navy = solidPng(4, 4, [0, 0, 128]);
    expect(comparePng(blue, navy).diffPixels).toBe(16);
  });

  test("dimension mismatch → ImageDimensionsMismatchError", () => {
    const a = solidPng(20, 20, [255, 255, 255]);
    const b = solidPng(20, 21, [255, 255, 255]);
    expect(() => comparePng(a, b)).toThrow(ImageDimensionsMismatchError);
  });
});
