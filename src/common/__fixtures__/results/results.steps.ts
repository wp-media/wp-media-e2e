import { writeFileSync } from "node:fs";
import { styleText } from "node:util";

import { expect } from "@playwright/test";

import { After, Given, Then, When } from "../../fixtures";
import { STOP_FILE_ENV } from "../../config/drain";

/**
 * Steps for the results stream's end-to-end spec (`reporting/results-stream.run.spec.ts`), which the
 * report pruning's (`reporting/run-pruning.run.spec.ts`) reuses. They touch nothing but the run's own
 * stop file, so the scenarios need no real site.
 */

Given("a background step", () => {
  // Every scenario's Background: a Gherkin step inside the Before hooks.
});

Given("nothing else happens", () => {
  // The scenario's outcome is decided elsewhere, or it passes.
});

Given("the first attempt fails", ({ $testInfo }) => {
  // Worker output the terminal reporter must print plain and masked: Playwright starts workers with
  // FORCE_COLOR=1, so `styleText` colours it; a URL carries a password; the last chunk has no line end.
  console.log(
    styleText(
      "red",
      `[probe] attempt ${String($testInfo.retry + 1)} via https://probe:hunter2@x.example.test/`,
    ),
  );
  process.stderr.write("[probe] a warning with no line end");
  // Credentials behind hundreds of escapes: a raw line that long was once cut before it was masked,
  // printing the password without its `@` and a token's head. Fakes, in the shape the masking knows.
  const dots = Array.from({ length: 369 }, () => styleText("gray", ".")).join(
    "",
  );
  console.log(
    `${dots} GET https://admin:S3cretPassw0rd@x.example.test/wp-admin/`,
  );
  console.log(
    `${"\u001b[0m".repeat(1020)}token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`,
  );
  if ($testInfo.retry === 0)
    throw new Error("the first attempt fails on purpose");
});

When("a step fails with {string}", ({ $testInfo }, message: string) => {
  throw new Error(`${message} (attempt ${String($testInfo.retry + 1)})`);
});

Given("the step waits until the run is stopped", async () => {
  // A whole line the terminal prints at once, so a run killed now still shows it; then an open one,
  // printed only as the attempt ends.
  console.log("[probe] the scenario hangs");
  process.stdout.write("[probe] still waiting");
  await new Promise<never>(() => {
    // Never settles: the spec stops the run while this step is running.
  });
});

Given("the run is asked to stop", () => {
  const stopFile = process.env[STOP_FILE_ENV];
  if (stopFile === undefined) throw new Error(`${STOP_FILE_ENV} is not set`);
  writeFileSync(stopFile, "");
});

Then("the page matches a screenshot that has no baseline", async ({ page }) => {
  await page.setContent("<p>no baseline</p>");
  await expect(page).toHaveScreenshot("never-taken.png");
});

After({ name: "failing After hook", tags: "@failafter" }, () => {
  throw new Error("the After hook fails on purpose");
});
