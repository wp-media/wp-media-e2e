import { devices } from "@playwright/test";

import { isObject } from "../guards";

/**
 * The device profiles scenarios run under, and the tag that selects a non-default one.
 *
 * Device is a **per-scenario client** concern, orthogonal to cells and editions: it never
 * multiplies the project matrix and never touches the worker→site binding. So there is one
 * default — desktop, applied by the config factory to every project — and a tag that swaps in
 * a mobile profile for the scenarios that need it, applied through `use` overrides at context
 * creation (see `../fixtures.ts`).
 *
 * Both profiles are a Playwright `devices[…]` preset with the viewport pinned to the size the
 * suite standardises on. Taking the preset rather than a bare viewport is what makes a mobile
 * scenario genuinely mobile — `isMobile`, `hasTouch`, a mobile `userAgent`, the right
 * `deviceScaleFactor` and the device's `screen` (what `window.screen` reports) all come with it, so
 * responsive CSS, touch handlers and any server-side `wp_is_mobile()` branch behave as they do for a
 * real visitor. Pinning the viewport keeps viewport-sensitive expectations (above-the-fold image
 * sets, LCP candidates) stable even if a Playwright upgrade changes a preset's default size. The
 * screen stays the preset's: the physical device's, as a real visitor's browser reports it.
 */

/** Desktop viewport: the suite's baseline size for every untagged scenario. */
export const DESKTOP_VIEWPORT = { width: 1600, height: 700 } as const;

/** Mobile viewport applied to {@link MOBILE_TAG} scenarios. */
export const MOBILE_VIEWPORT = { width: 389, height: 829 } as const;

/**
 * Tag that switches a scenario onto {@link MOBILE}. Untagged scenarios stay on {@link DESKTOP},
 * so mobile coverage is opt-in per scenario rather than a second project.
 */
export const MOBILE_TAG = "@mobile";

/** A width and a height in CSS pixels: a viewport's, or a screen's. */
export interface Size {
  readonly width: number;
  readonly height: number;
}

/**
 * A device profile: a `devices[…]` preset with a pinned viewport. Only the six context options
 * below are read — Playwright exposes each as its own overridable option fixture, which is what
 * lets a scenario's tags select a profile.
 */
export interface DeviceProfile {
  readonly viewport: Size;
  /** What `window.screen` reports; Playwright applies it only beside a viewport, which both pin. */
  readonly screen: Size;
  readonly userAgent: string;
  readonly deviceScaleFactor: number;
  readonly isMobile: boolean;
  readonly hasTouch: boolean;
}

/**
 * A device preset's `screen`. Playwright's presets carry one (Desktop Chrome's and Pixel 5's do), but
 * its `DeviceDescriptor` type does not declare it, so it is read and checked here rather than trusted
 * from a spread: a profile without it would report another device's screen.
 *
 * @param preset - a `devices[…]` entry.
 * @param name - the preset's name, for the error.
 * @returns the preset's screen, as a fresh object.
 * @throws {@link Error} naming the preset when it has no numeric `width` and `height` screen.
 */
export function presetScreen(preset: object, name: string): Size {
  const screen: unknown = Reflect.get(preset, "screen");
  if (
    isObject(screen) &&
    typeof screen.width === "number" &&
    typeof screen.height === "number"
  ) {
    return { width: screen.width, height: screen.height };
  }
  throw new Error(
    `Playwright's "${name}" device preset has no screen size, which the device profiles apply ` +
      "as what window.screen reports: pick a preset that has one, or set the profile's screen.",
  );
}

/** The default profile every project runs under: Desktop Chrome at {@link DESKTOP_VIEWPORT}. */
export const DESKTOP = {
  ...devices["Desktop Chrome"],
  viewport: DESKTOP_VIEWPORT,
  screen: presetScreen(devices["Desktop Chrome"], "Desktop Chrome"),
} satisfies DeviceProfile;

/**
 * The {@link MOBILE_TAG} profile: Pixel 5 at {@link MOBILE_VIEWPORT}. Pixel 5 is chosen because
 * it is a **Chromium** preset — the only browser this suite runs — so its emulation matches the
 * browser actually under test rather than asking Chromium to impersonate Safari.
 */
export const MOBILE: DeviceProfile = {
  ...devices["Pixel 5"],
  viewport: MOBILE_VIEWPORT,
  screen: presetScreen(devices["Pixel 5"], "Pixel 5"),
};

/**
 * The device profile a scenario's tags select, or `undefined` to keep the project default
 * (desktop). Pure, so the tag→profile decision is unit-tested once instead of re-derived in each
 * of the six `use` overrides that consume it.
 *
 * @param tags - the scenario's Gherkin tags, as playwright-bdd's `$tags` supplies them
 * (`["@smoke", "@mobile"]`).
 *
 * @example
 * ```ts
 * viewport: async ({ $tags, viewport }, use) => {
 *   await use(deviceForTags($tags)?.viewport ?? viewport);
 * },
 * ```
 */
export function deviceForTags(
  tags: readonly string[],
): DeviceProfile | undefined {
  return tags.includes(MOBILE_TAG) ? MOBILE : undefined;
}
