import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HISTORY_ROWS_PHP } from "./history";
import { PROBE_FAILURE_TOLERANCE } from "./polling";
import {
  RUN_STATE_PHP,
  STOP_BUDGETS,
  parseRunState,
  runProgress,
  stopRunningJobs,
  waitForJobRunning,
  waitForRunToEnd,
} from "./job-runs";
import { LEFT_WORK_ALLOWANCE_MS } from "../../../common/hooks/plugin-lifecycle";
import type { RunState, StopBudgets } from "./job-runs";
import type { LocalTransport } from "../../../common/config/types";

/**
 * The running-job reader, the two waits built on it, and the teardown's stop — driven over the real
 * exec layer by a stub `wp` that plays back a script of run states.
 *
 * There is one script per number of stops the site has been sent, because being told to stop is the
 * one thing that changes what a real site reports: script 0 is what `eval` answers until the first
 * `backwpup kill`, script 1 what it answers after it, and so on — the highest script written answers
 * for every stop after it. Each answer is one line, the last line repeats (which is how a state that
 * never changes is written), and a line reading `!fail` makes that `eval` fail the way a site that
 * cannot be reached for a moment does. A stop request is dropped — never reaching the site — while
 * `kill-drops` holds a number above zero. Every call is recorded, so a case can count the questions
 * and the stop requests it cost.
 */
const STUB_WP = `#!/usr/bin/env bash
if [ "$1" = "backwpup" ] && [ "$2" = "kill" ]; then
  printf 'backwpup kill\\n' >> "$WP_STUB_DIR/calls"
  drops=$(cat "$WP_STUB_DIR/kill-drops" 2>/dev/null || echo 0)
  if [ "$drops" -gt 0 ]; then
    echo $(( drops - 1 )) > "$WP_STUB_DIR/kill-drops"
    kill -9 $$
  fi
  stops=$(cat "$WP_STUB_DIR/stops" 2>/dev/null || echo 0)
  echo $(( stops + 1 )) > "$WP_STUB_DIR/stops"
  printf 'Success: Job will be terminated.\\n'
  exit 0
fi
if [ "$1" = "eval" ]; then
  printf 'eval\\n' >> "$WP_STUB_DIR/calls"
  phase=$(cat "$WP_STUB_DIR/stops" 2>/dev/null || echo 0)
  while [ "$phase" -gt 0 ] && [ ! -e "$WP_STUB_DIR/script.$phase" ]; do phase=$(( phase - 1 )); done
  n=$(cat "$WP_STUB_DIR/script.$phase.count" 2>/dev/null || echo 0)
  total=$(grep -c '' "$WP_STUB_DIR/script.$phase")
  line=$(( n < total ? n + 1 : total ))
  answer=$(sed -n "\${line}p" "$WP_STUB_DIR/script.$phase")
  echo $(( n + 1 )) > "$WP_STUB_DIR/script.$phase.count"
  if [ "$answer" = "!fail" ]; then
    printf 'Error: Error establishing a database connection.' >&2
    exit 1
  fi
  printf '%s\\n' "$answer"
  exit 0
fi
exit 0
`;

let binDir: string;
let stubDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-runs-bin-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
});

test.beforeEach(() => {
  stubDir = mkdtempSync(join(tmpdir(), "bwp-runs-state-"));
  process.env.WP_STUB_DIR = stubDir;
});

test.afterEach(() => {
  delete process.env.WP_STUB_DIR;
  // A wait that timed out leaves its last stub call running (`expect.poll` does not await it), and a
  // file it writes into the folder mid-removal fails `rmSync` (`ENOTEMPTY`). Moved aside first, the
  // folder is out of its reach (the stub writes by `$WP_STUB_DIR`, which no longer leads anywhere);
  // the retries sweep the one write whose path was resolved before the move.
  const removed = `${stubDir}.removed`;
  renameSync(stubDir, removed);
  rmSync(removed, { recursive: true, force: true, maxRetries: 5 });
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  rmSync(binDir, { recursive: true, force: true });
});

/** The stub site, run from this case's own state directory. */
const local = (): LocalTransport => ({ mode: "local", rootDir: stubDir });

/** A history row as `$wpdb` hands it over — every column a string. */
function row(status: string, jobId = "3"): Record<string, string> {
  return {
    filename: "2026-09-22_17-47-45_FJ4QJCUN03_DBDUMP.tar",
    destination: "FOLDER",
    job_id: jobId,
    status,
    backup_trigger: "backup_now_job",
    logfile:
      "/site/wp-content/uploads/backwpup/6567c0/logs/backwpup_log_e7c378_2026-09-22_17-47-45.html",
  };
}

/** What the snippet prints: idle unless `running` names a job (`null`: marker read mid-write). */
function state(
  history: readonly Record<string, string>[] = [],
  running?: number | null,
): string {
  return JSON.stringify({
    loaded: true,
    running: running === undefined ? null : { job_id: running },
    history,
  });
}

const NOT_LOADED = JSON.stringify({ loaded: false });

/** An answer that fails, as a site that cannot be reached for a moment does. */
const FAIL = "!fail";

/** Writes the script the stub answers from after `stops` stop requests, one answer per line. */
function script(stops: number, answers: readonly string[]): void {
  writeFileSync(
    join(stubDir, `script.${String(stops)}`),
    `${answers.join("\n")}\n`,
  );
}

/** How many answers the script for `stops` stop requests has given. */
function answered(stops: number): number {
  return Number(
    readFileSync(join(stubDir, `script.${String(stops)}.count`), "utf8").trim(),
  );
}

/** The calls the stub answered, in order — `eval` or `backwpup kill`. */
function calls(): string[] {
  const file = join(stubDir, "calls");
  return existsSync(file)
    ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean)
    : [];
}

/** How many stop requests were made, whether or not they reached the site. */
const kills = (): number =>
  calls().filter((call) => call === "backwpup kill").length;

/** Budgets small enough for a unit run, with room to spare for a slow machine. */
const QUICK: StopBudgets = {
  stopMs: 5_000,
  settleMs: 5_000,
  pollMs: 10,
  resendMs: 60_000,
};

test.describe("parseRunState", () => {
  test("reads an idle site and the history it holds", () => {
    const parsed = parseRunState(state([row("completed")]));
    expect(parsed).toEqual({
      loaded: true,
      history: [
        {
          filename: "2026-09-22_17-47-45_FJ4QJCUN03_DBDUMP.tar",
          destination: "FOLDER",
          jobId: 3,
          status: "completed",
          trigger: "backup_now_job",
          logfile:
            "/site/wp-content/uploads/backwpup/6567c0/logs/backwpup_log_e7c378_2026-09-22_17-47-45.html",
        },
      ],
    });
    expect(parsed).not.toHaveProperty("running");
  });

  test("reads the job whose run holds the marker", () => {
    expect(parseRunState(state([row("created")], 3)).running).toEqual({
      jobId: 3,
    });
  });

  // The plugin rewrites the marker every second, and a read can land mid-write: still running,
  // job unknown — never "idle".
  test("reads a marker caught mid-write as a run whose job is unknown", () => {
    expect(parseRunState(state([], null)).running).toEqual({});
  });

  test("reads a site without the plugin as not loaded, with no history", () => {
    expect(parseRunState(NOT_LOADED)).toEqual({ loaded: false, history: [] });
  });

  // Each would otherwise have to be read as "nothing is running".
  test("refuses a reply that is not a run state", () => {
    expect(() => parseRunState("")).toThrow(/did not come back as JSON/);
    expect(() => parseRunState("{}")).toThrow(/expected a run state/);
    expect(() =>
      parseRunState(
        JSON.stringify({ loaded: true, running: "yes", history: [] }),
      ),
    ).toThrow(/integer job id/);
    expect(() =>
      parseRunState(
        JSON.stringify({ loaded: true, running: { job_id: "3" }, history: [] }),
      ),
    ).toThrow(/integer job id/);
    expect(() =>
      parseRunState(JSON.stringify({ loaded: true, running: null })),
    ).toThrow(/expected a list of rows/);
  });
});

test.describe("RUN_STATE_PHP", () => {
  test("answers for a site without the plugin instead of fataling", () => {
    expect(RUN_STATE_PHP).toContain("class_exists( 'BackWPup' )");
    expect(RUN_STATE_PHP).toContain("'loaded' => false");
  });

  test("names the running job from the marker's own working data", () => {
    expect(RUN_STATE_PHP).toContain("get_plugin_data( 'running_file' )");
    expect(RUN_STATE_PHP).toContain("BackWPup_Job::get_working_data()");
  });

  // The query that refuses a failed read, rather than one that would answer "no history".
  test("reads the history through the query that refuses a failed read", () => {
    expect(RUN_STATE_PHP).toContain(HISTORY_ROWS_PHP);
  });
});

test.describe("runProgress", () => {
  const at = (history: Record<string, string>[], running?: number | null) =>
    parseRunState(state(history, running));

  test("calls a run ended once nothing runs and the run recorded how", () => {
    expect(runProgress(at([row("completed")]), 3)).toBe("ended");
    expect(runProgress(at([row("aborted")]), 3)).toBe("ended");
  });

  test("does not while a run is still going", () => {
    expect(runProgress(at([row("created")], 3), 3)).toMatch(/still running/);
  });

  // The abort case: the marker is gone at once, the request finishes a second later.
  test("does not while the run is still recording its end", () => {
    expect(runProgress(at([row("created")]), 3)).toMatch(
      /still recording its end/,
    );
  });

  // A dispatched job starts a moment after the command that asked for it returns.
  test("does not mistake a run that has not started for one that has ended", () => {
    expect(runProgress(at([]), 3)).toMatch(/no run of job 3 is recorded yet/);
    expect(runProgress(at([row("completed", "5")]), 3)).toMatch(
      /no run of job 3/,
    );
  });

  test("does not when the plugin cannot be read at all", () => {
    const unloaded: RunState = { loaded: false, history: [] };
    expect(runProgress(unloaded, 3)).not.toBe("ended");
  });
});

test.describe("waitForJobRunning", () => {
  test("returns once the marker names the job", async () => {
    script(0, [state(), state([], null), state([row("created")], 3)]);
    await waitForJobRunning(local(), 3, 10_000);
    expect(calls()).toHaveLength(3);
  });

  test("does not settle for another job's run", async () => {
    script(0, [state([row("created", "5")], 5)]);
    await expect(waitForJobRunning(local(), 3, 1_000)).rejects.toThrow(
      /job 3 should be running/,
    );
  });
});

test.describe("waitForRunToEnd", () => {
  test("waits past a run that is still recording its end", async () => {
    script(0, [
      state([row("created")], 3),
      state([row("created")]),
      state([row("aborted")]),
    ]);
    await waitForRunToEnd(local(), 3, 20_000);
    expect(calls()).toHaveLength(3);
  });

  test("names where the run stood when it gives up", async () => {
    script(0, [state()]);
    await expect(waitForRunToEnd(local(), 3, 1_500)).rejects.toThrow(
      /no run of job 3 is recorded yet/,
    );
  });
});

test.describe("stopRunningJobs", () => {
  // The shared Before hook gives a product's stop this much on top of its install, and a stop that
  // overruns it abandons the install mid-way. The budgets bound the waits; the probes around them
  // (a handful at ~1.3 s each over SSH, more when some fail) need the rest.
  test("fits its worst case inside the shared hooks' allowance for leftover work", () => {
    const probes = 20_000;
    expect(
      STOP_BUDGETS.stopMs + STOP_BUDGETS.settleMs + probes,
    ).toBeLessThanOrEqual(LEFT_WORK_ALLOWANCE_MS);
  });

  // The common case, paid before every install and after every scenario.
  test("asks one question and stops nothing on an idle site", async () => {
    script(0, [state([row("completed")])]);
    await expect(stopRunningJobs(local(), QUICK)).resolves.toBeUndefined();
    expect(calls()).toEqual(["eval"]);
  });

  test("stops nothing on a site whose plugin is gone", async () => {
    script(0, [NOT_LOADED]);
    await expect(stopRunningJobs(local(), QUICK)).resolves.toBeUndefined();
    expect(kills()).toBe(0);
  });

  test("tells a running job to stop, then waits for its run to record its end", async () => {
    script(0, [state([row("created")], 3)]);
    script(1, [
      state([row("created")]),
      state([row("created")]),
      state([row("aborted")]),
    ]);

    const stopped = await stopRunningJobs(local(), QUICK);

    expect(stopped).toBe(
      "a backup of job 3 was still running; it was stopped before the " +
        "plugin was removed.",
    );
    expect(kills()).toBe(1);
    // Nothing more was asked once the run had recorded how it ended.
    expect(answered(1)).toBe(3);
  });

  // The plugin checks for its marker and rewrites it as two separate steps, so a stop that lands
  // between them is undone; asking again is what gets through. Four looks still finding the marker
  // span four 10 ms polls, past the 20 ms resend, so a second request is due whatever the machine's
  // speed; each look and request is a process, so a longer script only spends the 5 s stop budget.
  test("asks again when the job's marker comes back", async () => {
    script(0, [state([row("created")], 3)]);
    script(1, [
      ...Array.from({ length: 4 }, () => state([row("created")], 3)),
      state([row("aborted")]),
    ]);

    await stopRunningJobs(local(), { ...QUICK, resendMs: 20 });

    expect(kills()).toBeGreaterThan(1);
  });

  test("fails, naming what it found, when the job will not stop", async () => {
    script(0, [state([row("created")], 3)]);
    script(1, [state([row("created")], 3)]);

    await expect(
      stopRunningJobs(local(), { ...QUICK, stopMs: 300 }),
    ).rejects.toThrow(
      /a backup of job 3 was still running, and it was still running 0\.3 s after being told to stop — removing the plugin now would race it\. The last stop request: `wp backwpup kill` exited 0/,
    );
  });

  // Killed moments before the scenario ended: nothing left to stop, but the request is still
  // finishing, and removing the plugin under it is the race this exists to prevent.
  test("waits for a run to record its end even when nothing is running", async () => {
    script(0, [
      state([row("created")]),
      state([row("created")]),
      state([row("aborted")]),
    ]);

    const stopped = await stopRunningJobs(local(), QUICK);

    expect(stopped).toBe(
      "a run of job 3 was still recording its end; it was left to finish " +
        "before the plugin was removed.",
    );
    expect(kills()).toBe(0);
  });

  // Nothing is running to finish it, so the plugin's removal races nothing: reported, not thrown.
  test("reports a run that never records its end, without failing", async () => {
    script(0, [state([row("created")])]);

    const stopped = await stopRunningJobs(local(), {
      ...QUICK,
      settleMs: 200,
    });

    expect(stopped).toMatch(
      /still recorded as in progress, with nothing left running to finish it\.$/,
    );
    expect(kills()).toBe(0);
  });

  // A history row that names no job is not job 0, which no job ever is.
  test("names a run whose history row records no job as such", async () => {
    const unnamed = { ...row("created"), job_id: null };
    script(0, [
      JSON.stringify({ loaded: true, running: null, history: [unnamed] }),
      state([row("aborted")]),
    ]);

    expect(await stopRunningJobs(local(), QUICK)).toMatch(
      /^a run of a job the history does not name was still recording its end/,
    );
  });

  test("names a job whose marker could not be read", async () => {
    script(0, [state([], null)]);
    script(1, [state([row("aborted")])]);

    expect(await stopRunningJobs(local(), QUICK)).toMatch(
      /^a backup of a job whose marker could not be read was still running/,
    );
  });

  // The job's own request can revive its marker after the site has been seen idle, so the wait for
  // the run to record its end keeps watching for it — and stops it again.
  test("stops a job again when its marker comes back while its run records its end", async () => {
    script(0, [state([row("created")], 3)]);
    script(1, [state([row("created")]), state([row("created")], 3)]);
    script(2, [state([row("aborted")])]);

    const stopped = await stopRunningJobs(local(), { ...QUICK, resendMs: 0 });

    expect(stopped).toMatch(/it was stopped before the plugin was removed\.$/);
    expect(kills()).toBe(2);
  });

  // One lost round trip to a site busy writing an archive is noise, as in every wait here.
  test("absorbs a question the site fails to answer, and still stops the job", async () => {
    script(0, [FAIL, state([row("created")], 3)]);
    script(1, [FAIL, state([row("aborted")])]);

    expect(await stopRunningJobs(local(), QUICK)).toMatch(
      /it was stopped before the plugin was removed\.$/,
    );
    expect(kills()).toBe(1);
  });

  test("gives up, in the site's own words, once it fails to answer too often in a row", async () => {
    script(0, [FAIL]);

    await expect(stopRunningJobs(local(), QUICK)).rejects.toThrow(
      /Error establishing a database connection/,
    );
    expect(answered(0)).toBe(PROBE_FAILURE_TOLERANCE + 1);
  });

  test("sends the stop again when a request never reached the site", async () => {
    writeFileSync(join(stubDir, "kill-drops"), "1");
    script(0, [state([row("created")], 3)]);
    script(1, [state([row("aborted")])]);

    const stopped = await stopRunningJobs(local(), { ...QUICK, resendMs: 0 });

    expect(stopped).toMatch(/it was stopped before the plugin was removed\.$/);
    expect(kills()).toBe(2);
  });

  test("says the last stop request could not be sent, when none got through", async () => {
    writeFileSync(join(stubDir, "kill-drops"), "1000");
    script(0, [state([row("created")], 3)]);

    await expect(
      stopRunningJobs(local(), { ...QUICK, stopMs: 300, resendMs: 50 }),
    ).rejects.toThrow(/The last stop request: could not be sent: /);
  });
});
