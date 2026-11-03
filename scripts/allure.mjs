// Generate (and optionally serve) the Allure report of a product/cell's most recent run, or of a
// given run.
//
//   npx tsx scripts/allure.mjs [product [cell [run]]] [--open]
//
// The command lives in `src/common/reporting/allure-command.ts` (its help: `--help`); this file only
// wires it to the process. Respects REPORT_ROOT (same as the test config) so it finds custom report
// roots, `.env`'s included: it loads `.env` as a run does, which is why it runs under tsx.
import "../src/common/config/load-env";
import { constants } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ALLURE_USAGE,
  EXIT,
  parseAllureArgs,
  runAllureCommand,
} from "../src/common/reporting/allure-command";

/** The checkout's root: a run resolves REPORT_ROOT against it, wherever it starts — so does this. */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

const parsed = parseAllureArgs(process.argv.slice(2));
if (parsed.kind === "help") {
  console.log(ALLURE_USAGE);
  process.exit(EXIT.ok);
}
if (parsed.kind === "error") {
  console.error(`report:allure: ${parsed.message}.\n\n${ALLURE_USAGE}`);
  process.exit(EXIT.usage);
}

// Ctrl-C or SIGTERM stops generation cleanly — Allure ended, its work folder (a full copy of the
// results) removed — or the server, and the script then exits as the signal would have (130, 143).
// Repeats are ignored: a terminal's Ctrl-C reaches the whole process group, tsx relays it too.
const stop = new AbortController();
/** @type {NodeJS.Signals | undefined} */
let stoppedBy;
/**
 * Records the first stop signal and stops the command.
 *
 * @param {NodeJS.Signals} signal - the signal received.
 */
function onStop(signal) {
  stoppedBy ??= signal;
  stop.abort();
}
process.on("SIGINT", onStop);
process.on("SIGTERM", onStop);

const status = await runAllureCommand(parsed.options, {
  reportRoot: resolve(repoRoot, process.env.REPORT_ROOT || "reports"),
  print: (line) => console.log(line),
  printError: (line) => console.error(line),
  signal: stop.signal,
});
process.exitCode =
  stoppedBy === undefined ? status : 128 + constants.signals[stoppedBy];
