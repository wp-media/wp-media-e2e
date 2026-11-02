import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Given } from "../../fixtures";
import { LIVE_PROBE_ENV } from "./probe-env";

/**
 * Steps for the live block's end-to-end spec (`reporting/live-block.run.spec.ts`). They touch no site:
 * each takes its time (`LIVE_PROBE_STEP_MS`), so the block is drawn many times, and some print from
 * the worker or ask the runner process to print (`foreign.ts`, which the config starts, watches for
 * the file this writes).
 */

/** How long a step waits: the run's setting, else 600 ms. */
function stepMs(): number {
  const value = Number(process.env[LIVE_PROBE_ENV.stepMs]);
  return Number.isSafeInteger(value) && value >= 0 ? value : 600;
}

Given("the scenario takes its time", async () => {
  await delay(stepMs());
});

Given("the worker prints a warning", async () => {
  console.warn("[probe] a warning from the worker");
  await delay(stepMs());
});

Given("the runner writes to its own output", async () => {
  const folder = process.env[LIVE_PROBE_ENV.requests];
  if (folder === undefined)
    throw new Error(`${LIVE_PROBE_ENV.requests} is not set`);
  writeFileSync(join(folder, "write"), "");
  // Long enough for the runner to see the request while this scenario still runs.
  await delay(Math.max(stepMs(), 1_500));
});

Given("the first attempt fails", async ({ $testInfo }) => {
  await delay(stepMs());
  if ($testInfo.retry === 0)
    throw new Error("the first attempt fails on purpose");
});

Given("every attempt fails", async () => {
  await delay(stepMs());
  throw new Error("every attempt fails on purpose");
});
