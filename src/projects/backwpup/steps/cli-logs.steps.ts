import { expect } from "@playwright/test";

import { Given, Then } from "../fixtures";
import { backwpupCli, describeCli, outputLines } from "../support/cli";
import { logName, loggedRun, readHistory, runOrder } from "../support/history";
import { readFileMarker } from "../support/markers";
import { makeLogReadOnly, readLogFolder } from "../support/plugin-folders";
import { backdateFile } from "../../../common/wp/files";
import type { HistoryRecord } from "../support/history";
import type { Transport } from "../../../common/config/types";

/**
 * Steps for what `wp backwpup log-show` prints and what `log-delete` removes.
 *
 * **A run is named by the history, a log is judged by its folder.** Every run the backup history
 * records names the log it wrote, so "the oldest run's log" is one file whatever a listing command
 * reports; and whether a log is still there is read off the log folder with PHP's own `scandir`,
 * never through the plugin's listing code, which the commands under test share.
 */

/** The run `which` names, read from the history the runs wrote. */
async function theRun(
  transport: Transport,
  which: string,
): Promise<HistoryRecord> {
  return loggedRun(await readHistory(transport), runOrder(which));
}

// ── What log-show printed ────────────────────────────────────────────────────

/** An HTML tag, which a log shown as plain text must not contain. */
const TAG = /<[a-z!/][^>]*>/i;

/** An HTML entity left undecoded, which plain text must not contain either. */
const ENTITY = /&(?:[a-z]+|#\d+);/i;

/**
 * That the command printed a run's log, and printed it as text.
 *
 * Three independent witnesses tie the output to one run: the log names its own file near the top
 * (`[INFO] Logfile is: …`), it names the archive the run wrote, and it names **no other** run's
 * archive — which is what makes asking for one log out of several a real question. The archive's
 * name comes from the history, not from the log, so the log is checked against the run's own record.
 */
Then(
  "it printed the {word} run's log as plain text",
  async ({ cli, site }, which: string) => {
    const history = await readHistory(site.transport);
    const run = loggedRun(history, runOrder(which));
    const printed = cli.last.stdout;
    expect(printed, describeCli(cli.last)).toContain(
      `[INFO] Logfile is: ${logName(run)}`,
    );
    expect(printed, describeCli(cli.last)).toContain(run.filename);
    for (const other of history) {
      if (other.filename === "" || other.filename === run.filename) continue;
      expect(
        printed,
        `the ${which} run's log should not name another run's archive — ${describeCli(cli.last)}`,
      ).not.toContain(other.filename);
    }
    expect(
      printed,
      `no markup should be left — ${describeCli(cli.last)}`,
    ).not.toMatch(TAG);
    expect(
      printed,
      `no entity should be left — ${describeCli(cli.last)}`,
    ).not.toMatch(ENTITY);
  },
);

/**
 * That the command printed exactly the last lines of a run's log, and nothing else.
 *
 * Measured against the whole log as the same command shows it, since "the last N" only means
 * something relative to the whole — and the whole must be longer, or cutting it proves nothing.
 */
Then(
  "it printed only the last {int} lines of the {word} run's log",
  async ({ cli, site }, count: number, which: string) => {
    const name = logName(await theRun(site.transport, which));
    const whole = await backwpupCli(site.transport, ["log-show", name]);
    expect(whole.exitCode, describeCli(whole)).toBe(0);
    const lines = outputLines(whole);
    expect(
      lines.length,
      `the whole log should be longer than ${String(count)} lines, or cutting it proves nothing`,
    ).toBeGreaterThan(count);
    expect(outputLines(cli.last), describeCli(cli.last)).toEqual(
      lines.slice(-count),
    );
  },
);

// ── The log folder ───────────────────────────────────────────────────────────

/** The run logs the folder holds, by name. */
async function logsInFolder(
  transport: Transport,
): Promise<{ readonly names: readonly string[]; readonly dir: string }> {
  const folder = await readLogFolder(transport);
  return { names: folder.files.map((file) => file.name), dir: folder.dir };
}

/** That the log folder holds exactly this many run logs. */
Then("the log folder holds {int} log(s)", async ({ site }, count: number) => {
  const { names, dir } = await logsInFolder(site.transport);
  expect(names, `the run logs in ${dir}`).toHaveLength(count);
});

/** That the log folder holds no run log at all — its own guard files aside. */
Then("the log folder holds no logs", async ({ site }) => {
  const { names, dir } = await logsInFolder(site.transport);
  expect(names, `the run logs in ${dir}`).toEqual([]);
});

/** That a run's log is no longer in the log folder. */
Then(
  "the {word} run's log is gone from the log folder",
  async ({ site }, which: string) => {
    const name = logName(await theRun(site.transport, which));
    const { names, dir } = await logsInFolder(site.transport);
    expect(names, `${dir} should no longer hold ${name}`).not.toContain(name);
  },
);

/** That a run's log is still in the log folder. */
Then(
  "the {word} run's log is still in the log folder",
  async ({ site }, which: string) => {
    const name = logName(await theRun(site.transport, which));
    const { names, dir } = await logsInFolder(site.transport);
    expect(names, `${dir} should still hold ${name}`).toContain(name);
  },
);

/**
 * Sets a run's log's modification time back. Only a log the identity site commands run as wrote can
 * be backdated, since only a file's owner may set its time.
 *
 * @param transport - the site.
 * @param which - the run, as a step names it (`oldest`, `newest`).
 * @param seconds - how far back.
 */
async function backdateRunLog(
  transport: Transport,
  which: string,
  seconds: number,
): Promise<void> {
  const name = logName(await theRun(transport, which));
  const { dir } = await logsInFolder(transport);
  await backdateFile(transport, `${dir}/${name}`, seconds);
}

/** A log made to look old: its modification time is what `log-delete --older-than` judges it by. */
Given(
  "the {word} run's log was last written {int} days ago",
  async ({ site }, which: string, days: number) => {
    await backdateRunLog(site.transport, which, days * 24 * 60 * 60);
  },
);

/**
 * A log written minutes before the next run's. Two runs made back to back can finish their logs in
 * the same second, and the plugin orders logs by their modification time in whole seconds (`log-show
 * --job_id` keys them by it, so a tie leaves "the newest" to chance).
 */
Given(
  "the {word} run's log was last written {int} minute(s) ago",
  async ({ site }, which: string, minutes: number) => {
    await backdateRunLog(site.transport, which, minutes * 60);
  },
);

/**
 * A log the identity site commands run as may no longer write. BackWPup gives its logs WordPress's file mode, so
 * on a host where that mode leaves them writable by their owner alone, every log the web server
 * writes is in this state as far as WP-CLI is concerned; the cells this suite runs on leave logs
 * writable by all, so the scenario arranges it.
 */
Given(
  "the {word} run's log has been made read-only",
  async ({ site }, which: string) => {
    await makeLogReadOnly(
      site.transport,
      logName(await theRun(site.transport, which)),
    );
  },
);

// ── Keeping to the log folder ────────────────────────────────────────────────

/**
 * That the command printed nothing of the marker file — the random value planted in it appears in
 * neither of its streams.
 */
Then("it printed nothing of the marker file", ({ cli, markers }) => {
  const output = `${cli.last.stdout}\n${cli.last.stderr}`;
  expect(
    output.includes(markers.file),
    `the command's output should hold nothing of the marker file — ${describeCli(cli.last)}`,
  ).toBe(false);
});

/** That the marker file is still on the site, holding exactly the value planted in it. */
Then(
  "the marker file is still on the site, as planted",
  async ({ site, markers }) => {
    expect(
      await readFileMarker(site.transport),
      "the marker file's content",
    ).toBe(markers.file);
  },
);
