import { execFile } from "node:child_process";
import { accessSync, constants, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";

import { test, expect } from "@playwright/test";

import {
  DONE_LINE,
  drawnWaitRows,
  EXITED_PREFIX,
  expectedPermanentLines,
  LIVE_MARK,
  NOT_LIVE_LINE,
  phaseDoneLine,
  residueBound,
  SOCKET_DIR_PREFIX,
  type PaneSize,
} from "../__fixtures__/live-tmux";
import { removeTempDir } from "../__fixtures__/temp-dir";

import { isCi } from "./capabilities";

/**
 * The live region on a **real** terminal: tmux runs the driver (`live-tmux-driver.ts`) in a pane,
 * which draws, prints (some lines wrapping) and redraws taller and shorter blocks over 4 phases of
 * 21 cycles, a 50 ms throttle often pending. Between phases the driver keeps redrawing an 8-row block
 * while the spec resizes the pane: wider and taller, back, then shorter only. Captured with wrapped
 * lines joined (`capture-pane -J`, history included), every permanent line must be there, once, whole
 * and in order; no live row may be left, except right after a resize, where only parts of the old
 * block may stay, no more than {@link residueBound} allows (what tmux's reflow moves out of the
 * region's reach; measured, and documented in `live.ts`).
 *
 * Every tmux server is the spec's own (a socket in a fresh folder, no user config) and never outlives
 * it: killed after each test and in its `finally`; the driver kills it too when the spec's process is
 * gone or a phase stalls; a crashed driver's pane stays readable for 20 s, then ends the server.
 *
 * tmux is not on GitHub's `ubuntu-24.04` image: CI installs it. Locally a missing tmux skips; under
 * `CI` it fails, so the check is never silently absent.
 */

/** tsx's loader, so the driver runs the TypeScript under test. */
const TSX_LOADER = import.meta.resolve("tsx");

/** The driver. */
const DRIVER = resolve(
  import.meta.dirname,
  "../__fixtures__/live-tmux-driver.ts",
);

/** The phases the driver runs: one resize between each two. */
const PHASES = 4;

/** How long the driver may take to reach each marker. */
const MARKER_WAIT_MS = 30_000;

/** How long a crashed driver's pane stays readable before its shell ends the server. */
const CRASH_LINGER_S = 20;

const run = promisify(execFile);

/** The `tmux` executable on `PATH`, or `undefined`. */
function findTmux(): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(dir, "tmux");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this folder.
    }
  }
  return undefined;
}

/**
 * `value` as one single-quoted POSIX shell word.
 *
 * @param value - any text.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One tmux server of the spec's own (a socket in its own folder, no user config), one session `s`. */
class Pane {
  readonly #tmux: string;
  readonly #folder = mkdtempSync(join(tmpdir(), SOCKET_DIR_PREFIX));

  /**
   * @param tmux - the executable.
   */
  constructor(tmux: string) {
    this.#tmux = tmux;
  }

  /**
   * Runs a tmux command against this server.
   *
   * @param args - the command and its arguments.
   * @returns its standard output.
   */
  async tmux(...args: readonly string[]): Promise<string> {
    const env = { ...process.env };
    delete env.TMUX;
    const { stdout } = await run(
      this.#tmux,
      ["-S", join(this.#folder, "sock"), "-f", "/dev/null", "-u", ...args],
      { env },
    );
    return stdout;
  }

  /**
   * Starts the driver in a `size` pane. A driver that ends by itself (a crash) leaves its pane, and
   * {@link EXITED_PREFIX}, for {@link CRASH_LINGER_S} seconds, then the server ends.
   *
   * @param size - the pane's columns and rows.
   */
  async start(size: PaneSize): Promise<void> {
    const driver = [
      process.execPath,
      "--import",
      TSX_LOADER,
      DRIVER,
      String(PHASES),
      String(process.pid),
    ]
      .map(shellQuote)
      .join(" ");
    await this.tmux(
      "new-session",
      "-d",
      "-s",
      "s",
      "-x",
      String(size.columns),
      "-y",
      String(size.rows),
      `${driver}; echo "${EXITED_PREFIX} $?"; sleep ${String(CRASH_LINGER_S)}`,
    );
  }

  /**
   * The pane's lines, history included, wrapped lines joined, trailing blanks dropped.
   *
   * @param visibleOnly - only what the pane shows now.
   */
  async capture(visibleOnly = false): Promise<string[]> {
    const range = visibleOnly ? [] : ["-J", "-S", "-", "-E", "-"];
    const text = await this.tmux("capture-pane", "-p", ...range, "-t", "s");
    const lines = text.split("\n").map((line) => line.trimEnd());
    while (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * Waits until the pane shows `line`.
   *
   * @param line - a whole line.
   * @throws {@link Error} at once when the driver ended or refused, else after
   *   {@link MARKER_WAIT_MS}; with the pane.
   */
  async waitFor(line: string): Promise<void> {
    const deadline = performance.now() + MARKER_WAIT_MS;
    for (;;) {
      const lines = await this.capture();
      if (lines.includes(line)) return;
      const ended = lines.some(
        (shown) => shown === NOT_LIVE_LINE || shown.startsWith(EXITED_PREFIX),
      );
      if (ended || performance.now() > deadline)
        throw new Error(`The pane never showed ${line}:\n${lines.join("\n")}`);
      await delay(50);
    }
  }

  /**
   * Resizes the pane.
   *
   * @param size - its new columns and rows.
   */
  async resize(size: PaneSize): Promise<void> {
    await this.tmux(
      "resize-window",
      "-t",
      "s",
      "-x",
      String(size.columns),
      "-y",
      String(size.rows),
    );
  }

  /** Ends the server and removes its socket folder; never throws, idempotent. */
  async stop(): Promise<void> {
    await this.tmux("kill-server").catch(() => undefined);
    removeTempDir(this.#folder);
  }
}

/** The panes this worker started and has not stopped yet: the `afterEach` stops them. */
const panes = new Set<Pane>();

test.afterEach(async () => {
  for (const pane of panes) await pane.stop();
  panes.clear();
});

/** Whether `line` is one the driver prints: a permanent line, a phase's end or the last line. */
const isPrinted = (line: string): boolean =>
  /^P\d{4} /.test(line) || /^PHASE \d+ DONE$/.test(line) || line === DONE_LINE;

/** What a resize after a printed line may leave before the next one. */
interface ResidueWindow {
  /** The most lines. */
  readonly bound: number;
  /** The rows those lines must be parts of: the block as drawn before the resize. */
  readonly rows: readonly string[];
}

/**
 * What is wrong with a capture: printed lines lost, doubled, cut or out of order; any other line
 * outside a resize's window; in a window, a line that is no part of the old block or more lines than
 * its bound (blank lines aside).
 *
 * @param lines - the joined capture.
 * @param windows - each resize's window, by the printed line it follows.
 */
function captureProblems(
  lines: readonly string[],
  windows: ReadonlyMap<string, ResidueWindow>,
): string[] {
  const problems: string[] = [];
  const printed = lines.filter(isPrinted);
  const expected = expectedPermanentLines(PHASES);
  if (JSON.stringify(printed) !== JSON.stringify(expected))
    problems.push(`printed lines differ:\n${printed.join("\n")}`);
  let window: ResidueWindow | undefined;
  let after = "";
  let count = 0;
  lines.forEach((line, index) => {
    if (isPrinted(line)) {
      window = windows.get(line);
      after = line;
      count = 0;
      return;
    }
    // A blank line in a window is a cleared row tmux moved; outside one, it is residue too.
    if (line === "" && window !== undefined) return;
    const part =
      window !== undefined &&
      line !== "" &&
      window.rows.some((row) => row.includes(line));
    if (!part) {
      problems.push(`line ${String(index + 1)} is residue: ${line}`);
      return;
    }
    if (++count > (window?.bound ?? 0))
      problems.push(
        `line ${String(index + 1)}: more than ${String(window?.bound)} lines left after ${after}: ${line}`,
      );
  });
  return problems;
}

/**
 * The resizes of one test: wider and taller, back, then shorter only; each after a phase.
 *
 * @param start - the pane's first size.
 * @param larger - the wider and taller size.
 */
function resizesOf(start: PaneSize, larger: PaneSize): readonly PaneSize[] {
  return [larger, start, { columns: start.columns, rows: start.rows - 4 }];
}

/**
 * Each resize's window: after phase `n`'s line, the wait block drawn in the size before it.
 *
 * @param start - the pane's first size.
 * @param resizes - the sizes, in order.
 */
function windowsOf(
  start: PaneSize,
  resizes: readonly PaneSize[],
): Map<string, ResidueWindow> {
  const windows = new Map<string, ResidueWindow>();
  let before = start;
  resizes.forEach((after, index) => {
    windows.set(phaseDoneLine(index + 1), {
      bound: residueBound(before, after),
      rows: drawnWaitRows(before),
    });
    before = after;
  });
  return windows;
}

for (const [start, larger] of [
  [
    { columns: 40, rows: 10 },
    { columns: 60, rows: 14 },
  ],
  [
    { columns: 80, rows: 24 },
    { columns: 100, rows: 30 },
  ],
] as const) {
  test(`a ${String(start.columns)}×${String(start.rows)} tmux pane keeps every printed line through resizes, leaving only bounded parts of the old block`, async () => {
    test.setTimeout((PHASES + 1) * MARKER_WAIT_MS);
    const tmux = findTmux();
    // Locally a missing tmux skips; under CI it fails, so the check is never silently absent.
    test.skip(
      tmux === undefined && !isCi(process.env),
      "tmux is not installed",
    );
    expect(tmux, "tmux must be installed under CI").toBeDefined();
    const pane = new Pane(tmux ?? "tmux");
    panes.add(pane);
    const resizes = resizesOf(start, larger);
    try {
      await pane.start(start);
      for (const [index, size] of resizes.entries()) {
        await pane.waitFor(phaseDoneLine(index + 1));
        await pane.resize(size);
      }
      await pane.waitFor(DONE_LINE);
      const lines = await pane.capture();
      expect(captureProblems(lines, windowsOf(start, resizes))).toEqual([]);
      // Closed: the block is gone from the screen, the last line is the one printed after it.
      expect((await pane.capture(true)).at(-1)).toBe(DONE_LINE);
    } finally {
      await pane.stop();
      panes.delete(pane);
    }
  });
}

test.describe("the capture's oracle", () => {
  const start = { columns: 40, rows: 10 };
  const windows = windowsOf(start, resizesOf(start, { columns: 60, rows: 14 }));
  const good = [...expectedPermanentLines(PHASES)];
  /**
   * `good` with `extra` after the printed line `after`.
   *
   * @param after - a printed line.
   * @param extra - the lines to add.
   */
  const withAfter = (after: string, extra: readonly string[]): string[] => {
    const at = good.indexOf(after) + 1;
    return [...good.slice(0, at), ...extra, ...good.slice(at)];
  };

  test("passes a clean capture, and bounded parts of the old block after a resize", () => {
    expect(captureProblems(good, windows)).toEqual([]);
    const narrowed = windows.get(phaseDoneLine(2));
    expect(narrowed?.bound).toBeGreaterThan(0);
    const parts = (narrowed?.rows ?? [])
      .slice(1, 1 + (narrowed?.bound ?? 0))
      .map((row) => row.slice(0, 10));
    expect(
      captureProblems(withAfter(phaseDoneLine(2), parts), windows),
    ).toEqual([]);
  });

  test("finds a lost line, a doubled line, and residue outside a window", () => {
    expect(captureProblems(good.slice(1), windows)).toHaveLength(1);
    expect(captureProblems([good[0] ?? "", ...good], windows)).toHaveLength(1);
    const early = good.indexOf(phaseDoneLine(1)) - 1;
    const outside = [...good];
    outside.splice(early, 0, `${LIVE_MARK}wait a`);
    expect(captureProblems(outside, windows)).toEqual([
      `line ${String(early + 1)} is residue: ${LIVE_MARK}wait a`,
    ]);
    expect(
      captureProblems([...good, `${LIVE_MARK}wait a`], windows),
    ).toHaveLength(1);
  });

  test("finds more lines than the bound, and a line that is no part of the old block", () => {
    const window = windows.get(phaseDoneLine(1));
    const bound = window?.bound ?? 0;
    const tooMany = Array.from(
      { length: bound + 1 },
      () => `${LIVE_MARK}wait a`,
    );
    expect(
      captureProblems(withAfter(phaseDoneLine(1), tooMany), windows),
    ).toHaveLength(1);
    expect(
      captureProblems(
        withAfter(phaseDoneLine(1), [
          `${LIVE_MARK}wait a   ${LIVE_MARK}cycle 3`,
        ]),
        windows,
      ),
    ).toHaveLength(1);
  });

  test("bounds what a resize may leave: none on an unchanged pane, less than the whole block otherwise", () => {
    const same = { columns: 80, rows: 24 };
    expect(residueBound(same, same)).toBe(0);
    // Widened: tmux 3.8's reflow may leave half the 8 rows; writing nothing would leave all 8.
    expect(residueBound(same, { columns: 100, rows: 30 })).toBe(4);
    // Shorter only: 8 rows in a 6-row pane, 5 reachable; 3 pushed into history.
    expect(residueBound(same, { columns: 80, rows: 6 })).toBe(3);
  });
});
