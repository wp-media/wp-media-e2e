/**
 * For the compatibility matrix: the suite's terminal output, as a run prints it, on this process's
 * own standard output — a pty or a pipe — in this process's environment. The terminal reporter and
 * the summary are built as the config factory builds them (`output` from `E2E_OUTPUT`, the process's
 * own streams), then told a two-scenario run: its header, a scenario's begin (the live block, where
 * the terminal holds one), its pass, the other's skip, the run's end and the summary (whose counts
 * then need a separator).
 *
 * Usage: `node --import tsx suite-probe.ts <folder>`; the summary prunes `<folder>/reports/…`, which
 * holds nothing.
 */

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { FullConfig, Suite } from "@playwright/test/reporter";

import { outputModeEnv } from "../../config/env";
import type { RunDescription } from "../../reporting/run-description";
import RunSummaryReporter from "../../reporting/run-summary";
import TerminalReporter from "../../reporting/terminal.reporter";
import {
  addAttempt,
  beginningAttempt,
  fakeSuite,
  fakeTest,
} from "../reporter-fakes";

/** How long the scenario runs: the live block's first draw and a tick or two of its clock. */
const SCENARIO_MS = 700;

/**
 * Prints the run.
 *
 * @param folder - a scratch folder for the summary's report pruning.
 */
async function main(folder: string): Promise<void> {
  const run: RunDescription = {
    product: "demo",
    cell: "x",
    edition: "pro",
    pinned: true,
    runId: "run-1",
    reportCell: "x",
    reportDir: "reports/demo/x/run-1",
    reportPath: join(folder, "reports", "demo", "x", "run-1"),
  };
  const options = { ...run, output: outputModeEnv() };
  const terminal = new TerminalReporter(options);
  const summary = new RunSummaryReporter(options);
  const scenario = fakeTest({
    titles: ["demo.feature.spec.js", "Demo feature", "A scenario"],
  });
  const skipped = fakeTest({
    id: "test-2",
    titles: ["demo.feature.spec.js", "Demo feature", "A skipped scenario"],
  });
  const suite = fakeSuite([scenario, skipped]) as unknown as Suite;
  const config = { quiet: false } as FullConfig;

  terminal.onBegin(config, suite);
  summary.onBegin(config, suite);
  terminal.onTestBegin(scenario.test, beginningAttempt(scenario));
  await delay(SCENARIO_MS);
  const result = addAttempt(scenario, { status: "passed", duration: 1_200 });
  const skip = addAttempt(skipped, { status: "skipped", duration: 0 });
  for (const [test, attempt] of [
    [scenario.test, result],
    [skipped.test, skip],
  ] as const) {
    terminal.onTestEnd(test, attempt);
    summary.onTestEnd(test, attempt);
  }
  const ended = {
    status: "passed",
    startTime: new Date(),
    duration: 1_500,
  } as const;
  terminal.onEnd(ended);
  summary.onEnd(ended);
  await terminal.onExit();
  await summary.onExit();
}

await main(process.argv[2] ?? ".");
