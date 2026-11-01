import { expect } from "@playwright/test";

import { Given, When } from "../../fixtures";
import { enterSecret } from "../../pages/secret-field";

/**
 * Steps for the failure block's end-to-end spec (`reporting/failure-block.run.spec.ts`). They touch
 * no site: the page is set from a string. The canaries come from the spec's environment.
 */

When(
  "a secret and a control are typed, then a check fails",
  async ({ page }) => {
    await page.setContent('<input id="secret"><input id="control">');
    // The secret as every secret is typed; the control with `fill()`, which titles its step with the
    // text — what the failure block must never print.
    await enterSecret(page.locator("#secret"), process.env.CANARY_SECRET ?? "");
    await page.locator("#control").fill(process.env.CANARY_CONTROL ?? "");
    await expect(page.locator("#secret")).toBeHidden({ timeout: 500 });
  },
);

When("a step fails with {string}", ({ $testInfo }, message: string) => {
  throw new Error(
    `the step fails: ${message} (attempt ${String($testInfo.retry + 1)})`,
  );
});

Given("nothing happens", () => {
  // Passes.
});
