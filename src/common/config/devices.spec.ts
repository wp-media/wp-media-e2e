import { devices, test, expect } from "@playwright/test";

import {
  DESKTOP,
  DESKTOP_VIEWPORT,
  MOBILE,
  MOBILE_TAG,
  MOBILE_VIEWPORT,
  deviceForTags,
  presetScreen,
} from "./devices";

/**
 * The device profiles and the tag→profile decision. What matters is not the exact numbers but
 * the properties the `use` overrides depend on: a mobile profile must actually emulate a mobile
 * client (not merely be narrow, nor on a desktop screen), both profiles must keep the pinned viewport
 * a preset upgrade could otherwise change, and an untagged scenario must select nothing at all so
 * the project default survives.
 */

test.describe("profiles", () => {
  test("desktop pins the baseline viewport and stays a desktop client", () => {
    expect(DESKTOP.viewport).toEqual(DESKTOP_VIEWPORT);
    expect(DESKTOP.isMobile).toBeFalsy();
    expect(DESKTOP.hasTouch).toBeFalsy();
  });

  test("mobile pins its viewport and emulates a real mobile client", () => {
    // A bare narrow viewport would leave `wp_is_mobile()`, touch handlers and DPR-sensitive
    // markup on their desktop paths — the whole reason the profile comes from a device preset.
    expect(MOBILE.viewport).toEqual(MOBILE_VIEWPORT);
    expect(MOBILE.isMobile).toBe(true);
    expect(MOBILE.hasTouch).toBe(true);
    expect(MOBILE.deviceScaleFactor).toBeGreaterThan(1);
    expect(MOBILE.userAgent).toMatch(/Mobile/);
  });

  test("mobile is narrower than desktop", () => {
    expect(MOBILE.viewport.width).toBeLessThan(DESKTOP_VIEWPORT.width);
  });

  test("each profile reports its own preset's screen, never the other's", () => {
    // Read from the presets as Playwright ships them (their type omits `screen`), so the check
    // follows a preset that changes size instead of pinning today's 1920×1080 and 393×851.
    const desktopScreen: unknown = Reflect.get(
      devices["Desktop Chrome"],
      "screen",
    );
    const mobileScreen: unknown = Reflect.get(devices["Pixel 5"], "screen");
    expect(DESKTOP.screen).toEqual(desktopScreen);
    expect(MOBILE.screen).toEqual(mobileScreen);
    // A `@mobile` scenario that kept the project's desktop screen is the defect this guards.
    expect(MOBILE.screen).not.toEqual(DESKTOP.screen);
  });

  test("each profile's screen is at least as large as its pinned viewport", () => {
    // A viewport never exceeds the screen it is on; a page reading both would see an impossible device.
    for (const profile of [DESKTOP, MOBILE]) {
      expect(profile.screen.width).toBeGreaterThanOrEqual(
        profile.viewport.width,
      );
      expect(profile.screen.height).toBeGreaterThanOrEqual(
        profile.viewport.height,
      );
    }
  });
});

test.describe("presetScreen", () => {
  test("returns a copy of the preset's screen", () => {
    const screen = { width: 393, height: 851 };
    const read = presetScreen({ viewport: {}, screen }, "Phone");
    expect(read).toEqual(screen);
    expect(read).not.toBe(screen);
  });

  test("refuses a preset without a screen, naming it", () => {
    // Several of Playwright's presets have none (Pixel 4, iPhone 8, …): choosing one must not
    // silently fall back to the project's desktop screen.
    expect(() => presetScreen({ viewport: {} }, "Pixel 4")).toThrow(
      `Playwright's "Pixel 4" device preset has no screen size`,
    );
  });

  test("refuses a screen that is not two numbers", () => {
    for (const screen of [
      null,
      "393x851",
      [393, 851],
      { width: 393 },
      { width: "393", height: 851 },
      { width: 393, height: null },
    ]) {
      expect(
        () => presetScreen({ screen }, "Odd"),
        JSON.stringify(screen),
      ).toThrow(`"Odd" device preset has no screen size`);
    }
  });
});

test.describe("deviceForTags", () => {
  test("returns the mobile profile for a @mobile scenario", () => {
    expect(deviceForTags([MOBILE_TAG])).toBe(MOBILE);
    expect(deviceForTags(["@smoke", "@mobile", "@pro"])).toBe(MOBILE);
  });

  test("returns undefined without the tag, so the project default applies", () => {
    // `undefined` (not a desktop profile) is the contract: each `use` override falls through to
    // the value the project already resolved, whatever a future project sets it to.
    expect(deviceForTags([])).toBeUndefined();
    expect(deviceForTags(["@smoke", "@visual"])).toBeUndefined();
  });

  test("matches the tag exactly, not as a prefix or substring", () => {
    expect(deviceForTags(["@mobile-menu"])).toBeUndefined();
    expect(deviceForTags(["@notmobile"])).toBeUndefined();
  });
});
