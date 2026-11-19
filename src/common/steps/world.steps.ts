import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { Given, Then } from "../fixtures";
import {
  DESKTOP,
  DESKTOP_VIEWPORT,
  MOBILE,
  MOBILE_VIEWPORT,
} from "../config/devices";
import type { Size } from "../config/devices";

/**
 * Generic, product-agnostic step definitions shared by every project. Each step's
 * Gherkin pattern is its contract; the feature files are the usage documentation.
 */

Given("a page titled {string}", async ({ page }, title: string) => {
  await page.setContent(
    `<!doctype html><title>${title}</title><h1>${title}</h1>`,
  );
});

Then("the page title is {string}", async ({ page }, title: string) => {
  await expect(page).toHaveTitle(title);
});

Then("the heading mentions {string}", async ({ page }, text: string) => {
  await expect(page.getByRole("heading")).toContainText(text);
});

/**
 * The emulated client as the **page itself** sees it. Asserting from inside the page is the point:
 * it proves the tag-driven device profile actually reached the browser context, which is the only
 * thing responsive CSS, touch handlers and a server's user-agent sniffing ever react to.
 */
async function observedDevice(page: Page): Promise<{
  readonly width: number;
  readonly touch: boolean;
  readonly mobileUserAgent: boolean;
  readonly pixelRatio: number;
  /** What `window.screen` reports, in CSS pixels. */
  readonly screen: Size;
}> {
  const viewport = page.viewportSize();
  const inPage = await page.evaluate(() => ({
    touch: "ontouchstart" in window || navigator.maxTouchPoints > 0,
    mobileUserAgent: navigator.userAgent.includes("Mobile"),
    pixelRatio: window.devicePixelRatio,
    screen: { width: window.screen.width, height: window.screen.height },
  }));
  return { width: viewport?.width ?? 0, ...inPage };
}

Then("the browser emulates a mobile device", async ({ page }) => {
  const device = await observedDevice(page);
  expect(device).toMatchObject({ touch: true, mobileUserAgent: true });
  expect(device.width).toBe(MOBILE_VIEWPORT.width);
  expect(device.pixelRatio).toBeGreaterThan(1);
  // The phone's own screen, not the desktop one the project's default profile carries.
  expect(device.screen).toEqual(MOBILE.screen);
});

Then("the browser emulates a desktop browser", async ({ page }) => {
  const device = await observedDevice(page);
  expect(device).toMatchObject({ touch: false, mobileUserAgent: false });
  expect(device.width).toBe(DESKTOP_VIEWPORT.width);
  expect(device.screen).toEqual(DESKTOP.screen);
});
