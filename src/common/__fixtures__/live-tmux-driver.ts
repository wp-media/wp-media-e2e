/**
 * For the live region's tmux spec: runs in a tmux pane, drives a live region on the pane's real
 * standard output — draws, prints (some wrapping), taller and shorter blocks — in phases; between
 * them it keeps redrawing a tall block, a throttle timer pending most of the time, until the spec
 * resizes the pane. `argv[2]`: the number of phases; `argv[3]`: the spec's PID.
 *
 * It never outlives its spec: when the spec's process is gone, or a phase passes its deadline, it
 * kills its own tmux server (its PID is in `$TMUX`) and removes the server's socket folder. After its
 * last line it stays until the spec kills the server, or that deadline.
 */
import { rmSync, writeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { detectCapabilities } from "../terminal/capabilities";
import { createLiveRegion } from "../terminal/live";
import { drainTerminal, openLiveTerminal } from "../terminal/stream";

import {
  CYCLES_PER_PHASE,
  DONE_LINE,
  liveRows,
  NOT_LIVE_LINE,
  permanentLine,
  phaseDoneLine,
  printsAt,
  SOCKET_DIR_PREFIX,
  waitRows,
} from "./live-tmux";

/** The longest a phase (or the wait after the last line) may take before the driver gives up. */
const PHASE_DEADLINE_MS = 60_000;

/** How often the driver checks that its spec is alive. */
const PARENT_POLL_MS = 500;

/** The shortest time between the region's content redraws: short, so the timer is often pending. */
const MIN_INTERVAL_MS = 50;

/**
 * Ends this tmux server and its socket folder, then the driver: the spec is gone or stuck.
 *
 * @param reason - why, on standard error (the pane, if anyone still looks).
 */
function abandon(reason: string): never {
  try {
    // Never `process.stderr`: its first use reopens the pty by name, which blocks once tmux is gone
    // (measured on macOS: the driver then outlived its server).
    writeSync(2, `driver: ${reason}\n`);
  } catch {
    // The pane is gone.
  }
  // $TMUX is "<socket>,<server pid>,<session>"; the socket's path may hold commas, the rest not.
  const fields = (process.env.TMUX ?? "").split(",");
  const serverPid = Number(fields.at(-2));
  const socket = fields.slice(0, -2).join(",");
  const folder = dirname(socket);
  if (socket !== "" && basename(folder).startsWith(SOCKET_DIR_PREFIX))
    rmSync(folder, { recursive: true, force: true });
  if (Number.isSafeInteger(serverPid) && serverPid > 1)
    try {
      process.kill(serverPid, "SIGTERM");
    } catch {
      // Already gone.
    }
  process.exit(3);
}

let deadline: NodeJS.Timeout | undefined;
/** Restarts the deadline: one per phase. */
function armDeadline(): void {
  clearTimeout(deadline);
  deadline = setTimeout(() => {
    abandon(`no progress within ${String(PHASE_DEADLINE_MS)} ms`);
  }, PHASE_DEADLINE_MS);
}

const phases = Number(process.argv[2] ?? "1");
const parentPid = Number(process.argv[3]);
setInterval(() => {
  try {
    process.kill(parentPid, 0);
  } catch {
    abandon(`the spec (PID ${String(parentPid)}) is gone`);
  }
}, PARENT_POLL_MS).unref();
armDeadline();

const capabilities = detectCapabilities({
  env: process.env,
  stream: process.stdout,
  mode: "fancy",
});
if (!capabilities.live) {
  process.stdout.write(`${NOT_LIVE_LINE}\n`);
  process.exit(1);
}
const terminal = openLiveTerminal(process.stdout);
const region = createLiveRegion({
  terminal,
  capabilities,
  size: () => process.stdout,
  ellipsis: "…",
  minIntervalMs: MIN_INTERVAL_MS,
});
/** How many resizes the pane has had. */
const resizes = { count: 0 };
process.stdout.on("resize", () => {
  region.resize();
  resizes.count++;
});

let printed = 0;
let cycle = 0;
for (let phase = 1; phase <= phases; phase++) {
  armDeadline();
  for (let i = 0; i < CYCLES_PER_PHASE; i++) {
    region.update(liveRows(cycle++));
    await delay(10);
    if (printsAt(i)) region.print(permanentLine(++printed));
    await delay(10);
  }
  region.print(phaseDoneLine(phase));
  if (phase === phases) break;
  const seen = resizes.count;
  // A tall block at every resize, redrawn faster than the throttle allows.
  for (let tick = 0; resizes.count === seen; tick++) {
    region.update(waitRows(tick));
    await delay(10);
  }
}
region.close();
process.stdout.write(`${DONE_LINE}\n`);
await drainTerminal(terminal.sink, 5_000);
armDeadline();
// The deadline's timer keeps the driver alive until the spec kills the server.
