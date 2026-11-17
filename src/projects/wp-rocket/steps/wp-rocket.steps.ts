import { expect } from "@playwright/test";

import { Then } from "../fixtures";

// Project-specific step, available only to the WP Rocket project.
Then("the WP Rocket project marker is present", async ({ page }) => {
  await expect(page.locator("h1")).toContainText("WP Rocket");
});
