/**
 * For the compatibility matrix: the orchestrator's terminal output, as `start` makes it — a screen
 * when standard output is a terminal (`openScreen`), the logger over `orchestrator.log` and this
 * process's own standard output — in this process's environment. It logs a line, shows the status
 * table (where the terminal redraws in place), logs a run's outcome longer than any terminal is wide,
 * then closes both.
 *
 * Usage: `node --import tsx compat-probe.ts <folder>`; `<folder>` (this user's, `0700`) gets the log.
 */

import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { openLogger } from "../log";
import { openScreen } from "../screen";
import type { Board } from "../status/board";

/** The outcome line logged: wider than 120 columns, its glyphs the orchestrator's own. */
export const OUTCOME_TEXT =
  "bpng-12 ✔ passed · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/demo/x/run-12 " +
  "and the words after it carry the line well past the widest terminal the layout allows";

/** How long the table stays up before the outcome line prints above it. */
const TABLE_MS = 300;

/** One task, cooling after a passed run: the table shows its status mark. */
const BOARD: Board = [
  {
    taskId: "bpng",
    cell: "pro@nginx",
    phase: { kind: "cooling", nextRunAt: new Date(Date.now() + 600_000) },
    last: {
      id: "bpng-12",
      status: "passed",
      durationMs: 3_250_000,
      scenarios: 52,
    },
  },
];

/**
 * Prints the lines and the table.
 *
 * @param folder - where `orchestrator.log` is written.
 */
async function main(folder: string): Promise<void> {
  const screen = openScreen({
    stdout: process.stdout,
    env: process.env,
    taskIds: ["bpng"],
    stderr: process.stderr,
  });
  const logger = await openLogger(join(folder, "orchestrator.log"), {
    terminal: process.stdout,
    ...(screen === undefined ? {} : { screen }),
  });
  logger.line("orchestrator", "started · 1 task (bpng)");
  screen?.show(BOARD);
  await delay(TABLE_MS);
  logger.line("bpng", OUTCOME_TEXT, { opensBlock: true });
  await delay(TABLE_MS);
  screen?.close();
  await logger.close();
}

await main(process.argv[2] ?? ".");
