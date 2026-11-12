import { expect } from "@playwright/test";

import { Given, Then, When } from "../fixtures";
import { backwpup } from "../config/backwpup.config";
import {
  backwpupCli,
  describeCli,
  noticesAt,
  outputLines,
  readJsonList,
} from "../support/cli";
import {
  BACKWPUP_COMMANDS,
  commandNamesFor,
  compareCommands,
  readRegisteredCommands,
} from "../support/cli-commands";
import { archivedRuns, readHistory } from "../support/history";
import {
  addBackupJob,
  readStoredJobs,
  scheduledJobs,
  theScheduledJob,
} from "../support/job-options";
import { commandArgv } from "../support/placeholders";
import { sshUserBoot } from "../support/cli-session";
import { wpCli } from "../../../common/wp/exec";
import { asTransportUser } from "../../../common/wp/site-identity";
import { isRestoreCommand } from "../support/cli-restore";
import { isObject } from "../../../common/guards";
import { resolveIdentity } from "../../../common/artifacts/manifest";
import type { CliLevel, CliResult } from "../support/cli";

/**
 * Steps for BackWPup's own `wp backwpup …` command surface.
 *
 * **The command is the system under test here**, which is what separates these steps from the ones
 * that run WP-CLI to arrange or to check a site: a non-zero exit is an observation to assert, not a
 * broken precondition. The runner behind them (`support/cli.ts`) therefore never throws for an
 * outcome, and every scenario in this surface can say what a refusal looked like.
 *
 * Most of the vocabulary is deliberately generic — run a command, judge its exit code, its output,
 * or one of the status lines WP-CLI tags with a severity. The command line *is* the product
 * language for this feature, so a step naming a flag is stating an intent rather than leaking a
 * mechanism, and the phases that follow this one can be mostly feature text.
 *
 * The assertions that are not generic are the ones that need a second, independent source: what the
 * site itself stores, what its backup history records, or which edition it installed. Those are what
 * stop a scenario passing by comparing the command's output with itself.
 */

// ── Who runs it ─────────────────────────────────────────────────────────────

/**
 * Runs the scenario's BackWPup commands as the SSH user, with no `--user`, instead of as the site's
 * identity: for a scenario whose premise is that WP-CLI and the web server are two users, which the
 * `site` state (every command as the web server) would erase. Steps judging what the command may do
 * read the site through `cli.transport`. Must come before the scenario's first BackWPup command.
 *
 * Skipped, naming the reason, when the SSH user may not read the site: nothing it would run could set
 * up the premise. Any other failure to boot WordPress as it fails the scenario.
 */
Given(
  "WP-CLI runs as the SSH user, not the web server",
  async ({ cli, site, $testInfo }) => {
    const boot = sshUserBoot(
      await wpCli(asTransportUser(site.transport), ["core", "is-installed"]),
    );
    if (boot.kind === "failed") throw new Error(boot.message);
    if (boot.kind === "refused") $testInfo.skip(true, boot.reason);
    cli.runAsSshUser();
  },
);

// ── Running a command ────────────────────────────────────────────────────────

/**
 * Runs one `wp backwpup …` subcommand and remembers its result for the assertions below.
 *
 * The `wp backwpup` prefix is left out of the feature text because the runner supplies it — an
 * unrelated WP-CLI command cannot be reached down the path reserved for the plugin under test.
 *
 * What a feature cannot spell out it names in braces — `run {job}`, `backup-delete {oldest backup}
 * --yes` — and each is filled as the command runs, from the site or from what the scenario recorded
 * there, never from the command under test (`support/placeholders.ts` lists them). So a failure
 * message, which quotes the argv, shows the value actually sent.
 */
When(
  "I run the BackWPup command {string}",
  async ({ cli, site, privateFolder, archives, keys }, command: string) => {
    const argv = await commandArgv(command, {
      transport: site.transport,
      privateFolder,
      archives,
      keys,
    });
    // Unguarded, a restore rewrites a shared site past what any teardown undoes.
    if (isRestoreCommand(argv)) {
      throw new Error(
        `[backwpup/cli] \`${argv[0] ?? ""}\` must run through "I run the BackWPup restore command …", ` +
          "which copies wp-content first and puts the site back afterwards.",
      );
    }
    await cli.run(argv);
  },
);

// ── What the command reported ────────────────────────────────────────────────

/**
 * Asserts one of WP-CLI's own status lines, matched by **severity and substance**.
 *
 * The level is exact — a `Warning:` can never satisfy an expectation of `Success:` — while the text
 * is a substring, because some of these messages carry a tail their command does not own: WP-CLI
 * appends its own `See 'wp help …'` to an unknown subcommand, and the plugin embeds paths and names
 * in others. Matching the structure and then the part that is actually being claimed keeps a
 * reworded message a visible mismatch without pinning wording nobody here controls.
 */
function expectNotice(
  result: CliResult,
  level: CliLevel,
  message: string,
): void {
  const found = noticesAt(result, level);
  expect(
    found.some((notice) => notice.includes(message)),
    `expected a ${level} notice mentioning "${message}", but the ${level} notices were ` +
      `${JSON.stringify(found)} — ${describeCli(result)}`,
  ).toBe(true);
}

/**
 * A copy sorted for comparing as a set, digits by value so a failure lists ids in reading order.
 *
 * For claims about *which* values came back and not in what order: WP-CLI's order is the plugin's
 * array order, and a second source rarely keeps the same one.
 */
function sortedForComparison(values: readonly string[]): string[] {
  return [...values].sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
}

/**
 * That the command exited 0 — which, on this surface, rules out a refusal and no more.
 *
 * Several commands exit 0 after failing: a foreground `run` never reaches a verdict of its own (the
 * job ends the process at exit 0, whatever it logged), `run --background` reports even a job id the
 * site does not have as started, a failed `restore` and a `log-delete` refused a log it may not write
 * only warn, a command that stops to ask for confirmation ends there at exit 0 having done nothing,
 * and plugin code that stops with `exit( 'message' )` prints no status line at all. Pair it with a
 * claim checked against a source the command has no hand in.
 */
Then("the command succeeds", ({ cli }) => {
  expect(cli.last.exitCode, describeCli(cli.last)).toBe(0);
});

/**
 * That the command refused.
 *
 * Any non-zero exit, not a particular code: what these scenarios are about is *that* the command
 * declined and what it said, and WP-CLI's choice of status number is its own business.
 *
 * Nor does a non-zero exit prove nothing happened: after one refused `backup-delete`, the next one
 * deletes its archive and still exits 1, repeating the earlier refusal. So a refusal, too, is
 * confirmed against the site.
 */
Then("the command fails", ({ cli }) => {
  expect(cli.last.exitCode, describeCli(cli.last)).not.toBe(0);
});

/** That the command printed exactly this, ignoring surrounding whitespace. */
Then("it prints {string}", ({ cli }, expected: string) => {
  expect(cli.last.stdout.trim(), describeCli(cli.last)).toBe(expected);
});

/** That the command reported success in WP-CLI's own words. */
Then("it reports the success {string}", ({ cli }, message: string) => {
  expectNotice(cli.last, "success", message);
});

/** That the command reported an error in WP-CLI's own words. */
Then("it reports the error {string}", ({ cli }, message: string) => {
  expectNotice(cli.last, "error", message);
});

/** That the command warned in WP-CLI's own words — which a command may do and still exit 0. */
Then("it reports the warning {string}", ({ cli }, message: string) => {
  expectNotice(cli.last, "warning", message);
});

/**
 * That the command stopped to ask for confirmation, and so did nothing it was asking about.
 *
 * WP-CLI's `confirm()` prints the question and `[y/n]` and reads the answer from stdin; this suite
 * never types one, so the prompt meets end-of-input, and anything but `y` makes WP-CLI end the
 * command there — at exit 0, having done nothing. The prompt is therefore the last thing printed.
 * Whether nothing was done is for a second source to confirm.
 */
Then("it asks {string}", ({ cli }, question: string) => {
  const printed = cli.last.stdout.trimEnd();
  expect(printed.endsWith("[y/n]"), describeCli(cli.last)).toBe(true);
  expect(outputLines(cli.last).at(-1), describeCli(cli.last)).toContain(
    question,
  );
});

// ── Which commands exist ─────────────────────────────────────────────────────

/**
 * That the site registers its edition's commands and nothing else.
 *
 * **This is the gate the rest of the surface rests on.** Every other scenario addresses a command
 * by name, and a name that stopped being registered answers with an empty list and a non-zero exit
 * — which an assertion about a site with nothing in it would pass. Comparing the registered set
 * against a declared one turns that into a single failure naming the command.
 *
 * Drift is reported **both ways** on purpose: a command that disappeared, and a command that turned
 * up uncovered — including a Pro-only one appearing on Free, which is this scenario's proof that
 * the edition split is real and not merely undocumented.
 */
Then(
  "the site registers exactly the BackWPup commands its edition ships",
  async ({ site, edition }) => {
    const registered = await readRegisteredCommands(site.transport);
    expect(
      compareCommands(registered, edition),
      `the ${edition} edition ships ${String(commandNamesFor(edition).length)} commands; the site ` +
        `registered ${String(registered.length)}: ${registered.join(", ")}`,
    ).toEqual({ missing: [], unexpected: [] });
  },
);

/**
 * That each Pro-only command is reachable on Pro and unknown on Free.
 *
 * Asked with `--help`, which dispatches the command **without running it** — the only probe that is
 * safe to point at `restore` on a site the suite is using. On Pro it proves the command is
 * genuinely dispatchable rather than merely printed in a list: the exit code alone would also be
 * satisfied by some other page, so the help that came back must name the command. On Free it gets
 * the answer a user actually meets, which is the same refusal any misspelling earns.
 */
Then(
  "the commands only BackWPup Pro ships are available on Pro and unknown on Free",
  async ({ site, edition }) => {
    const proOnly = BACKWPUP_COMMANDS.filter(
      (command) => command.availability === "pro",
    );
    expect(
      proOnly,
      "the declared set should name some Pro-only commands",
    ).not.toHaveLength(0);

    for (const { name } of proOnly) {
      const result = await backwpupCli(site.transport, [name, "--help"]);
      if (edition === "pro") {
        expect(result.exitCode, describeCli(result)).toBe(0);
        // The help page's NAME line is the command alone; its SYNOPSIS repeats it with arguments.
        expect(outputLines(result), describeCli(result)).toContain(
          `wp backwpup ${name}`,
        );
      } else {
        expect(result.exitCode, describeCli(result)).not.toBe(0);
        expectNotice(
          result,
          "error",
          `'${name}' is not a registered subcommand`,
        );
      }
    }
  },
);

/**
 * That the command named the plugin the cell resolved, edition and version both.
 *
 * Both halves come from the zip the run installed, never from the site: the name is the manifest's
 * identity for this edition, which the install-time preflight proves the zip's header carries, and
 * the version is the one that header declares. So this asserts the site is running what the run
 * intended rather than re-stating a string typed twice.
 */
Then(
  "it prints the name and version of the plugin under test",
  ({ cli, edition, pluginArtifact }) => {
    const { pluginName } = resolveIdentity(backwpup.artifacts, edition);
    const { version } = pluginArtifact("plugin");
    expect(
      version,
      "the resolved zip should declare the version it carries, or what the command ought to " +
        "print cannot be established",
    ).toBeDefined();
    expect(cli.last.stdout.trim(), describeCli(cli.last)).toBe(
      `${pluginName} ${String(version)}`,
    );
  },
);

// ── The jobs a site has ──────────────────────────────────────────────────────

/**
 * That the ids just printed are the site's own jobs — no more, and no fewer.
 *
 * Compared against the jobs the site **stores**, which is a source the command has no hand in. The
 * check runs in two halves, and the first is what makes the second mean anything: the site must
 * really be holding a hidden job (BackWPup keeps a placeholder of its own from installation, and one
 * more for "Backup now" once that has run), or "none of the hidden ones were listed" would be true of
 * a site that had none. Only then are the printed ids compared with the jobs a user would call their
 * own — printed by a command that answered at exit 0, since on a site with none of its own a refusal
 * prints no ids either.
 *
 * Reads whitespace-separated, so it judges `--format=ids` (one line) and `--field=job_id` (one per
 * line) alike — they are the same claim in two shapes. Compared **as a set**, because the order is
 * no part of the claim and the two sources need not share one: the command walks the stored option
 * in PHP's insertion order, while JSON hands a sparse option to JavaScript as an object whose integer
 * keys come back sorted.
 */
Then(
  "the ids it printed are the site's own jobs, with BackWPup's hidden ones left out",
  async ({ cli, site }) => {
    const stored = await readStoredJobs(site.transport);
    const own = scheduledJobs(stored);
    expect(
      stored.length,
      "the site should be holding at least one hidden job, or leaving them out proves nothing " +
        `(it stores ${JSON.stringify(stored.map((job) => job.jobId))})`,
    ).toBeGreaterThan(own.length);

    expect(cli.last.exitCode, describeCli(cli.last)).toBe(0);
    const printed = cli.last.stdout
      .trim()
      .split(/\s+/)
      .filter((token) => token !== "");
    expect(sortedForComparison(printed), describeCli(cli.last)).toEqual(
      sortedForComparison(own.map((job) => String(job.jobId))),
    );
  },
);

/**
 * More jobs, added the way the dashboard's "add new backup" card adds them.
 *
 * That card is what the suite this ports clicked to reach its three-job count, and it creates a
 * files-and-database job — so this arranges the same jobs without opening the screen that makes
 * them, which is not what the scenario is about.
 */
When("{int} more backup job(s) are added", async ({ site }, count: number) => {
  for (let added = 0; added < count; added++) {
    await addBackupJob(site.transport, "files and database");
  }
});

/**
 * That each record carries exactly the requested fields — no fewer, and nothing else.
 *
 * The "nothing else" half is the point: a `--fields` that was ignored would still answer with
 * records holding the requested fields, and only an exact key set notices. A field that does not
 * exist cannot sneak through as a key with no value: WP-CLI refuses it before printing anything.
 */
Then(
  "every record it lists carries exactly the fields {string}",
  ({ cli }, fields: string) => {
    const expected = fields.split(",").map((field) => field.trim());
    const records = readJsonList(cli.last);
    expect(
      records,
      `there should be a record to inspect — ${describeCli(cli.last)}`,
    ).not.toHaveLength(0);
    for (const record of records) {
      if (!isObject(record)) {
        throw new Error(
          `[backwpup/cli] expected each record to be an object, got ${JSON.stringify(record)} — ` +
            describeCli(cli.last),
        );
      }
      expect(Object.keys(record), describeCli(cli.last)).toEqual(expected);
    }
  },
);

// ── Backups and logs a run left behind ───────────────────────────────────────

/**
 * That the archives the command named are the ones BackWPup's own history records.
 *
 * Checked against the history table rather than against the command in another format: the command
 * lists the files it finds on each destination, while the table is written by the run that made
 * them, so the two agree only when the command reported what really happened. Only the runs that
 * left an archive count — a failed or aborted run is recorded too, and leaves none behind.
 *
 * Compared as a set: the command lists newest first, the table holds oldest first.
 */
Then(
  "it names the archives the backup history records",
  async ({ cli, site }) => {
    const recorded = archivedRuns(await readHistory(site.transport)).map(
      (run) => run.filename,
    );
    expect(
      recorded,
      "the backup history should record an archive to compare against",
    ).not.toHaveLength(0);
    expect(
      sortedForComparison(outputLines(cli.last)),
      describeCli(cli.last),
    ).toEqual(sortedForComparison(recorded));
  },
);

/**
 * That the one log listed is the scheduled job's, and reports a clean run.
 *
 * The job id is what makes the counts worth reading. The command takes all three out of the log's
 * own header, and a value it cannot find there it reports as `0` — so a header it could no longer
 * parse would read as "no errors, no warnings", and every verdict the suite takes from this command
 * would be a success. An id of `0` belongs to no job, which makes the stored job's id the witness
 * that the header really was read.
 *
 * The counts are asserted rather than the `status` column, which is assembled from translated
 * display strings. They are how the rest of the suite decides whether a backup succeeded, so this is
 * the one place their shape is pinned.
 */
Then(
  "the log it lists is the scheduled job's, with no errors and no warnings",
  async ({ cli, site }) => {
    const records = readJsonList(cli.last);
    expect(records, describeCli(cli.last)).toHaveLength(1);
    const [entry] = records;
    if (!isObject(entry)) {
      throw new Error(
        `[backwpup/cli] expected a log record, got ${JSON.stringify(entry)} — ${describeCli(cli.last)}`,
      );
    }
    const job = await theScheduledJob(site.transport);
    expect(
      { job_id: entry.job_id, errors: entry.errors, warnings: entry.warnings },
      describeCli(cli.last),
    ).toEqual({ job_id: job.jobId, errors: 0, warnings: 0 });
  },
);

/**
 * That `log --job_id` keeps exactly one job's runs — asked in both directions.
 *
 * `log` filters by hand rather than through the shared field filter `job` and `backup` use, so it
 * needs a check of its own. The second half is what makes the first mean anything: a filter that
 * ignored the id would pass "the scheduled job has its run" on its own. The other id asked about is
 * a job the site really stores — its hidden placeholder, which has never run — so "none" is the right
 * answer whatever the command makes of an id it does not know.
 */
Then(
  "the log list filtered by job holds the scheduled job's run and no other job's",
  async ({ site }) => {
    const job = await theScheduledJob(site.transport);
    const other = (await readStoredJobs(site.transport)).find(
      (stored) => stored.jobId !== job.jobId,
    );
    expect(
      other,
      "the site should hold a second job — its hidden placeholder — to filter by",
    ).toBeDefined();
    if (other === undefined) throw new Error("unreachable: asserted above");

    for (const [jobId, expected] of [
      [job.jobId, "1"],
      [other.jobId, "0"],
    ] as const) {
      const result = await backwpupCli(site.transport, [
        "log",
        `--job_id=${String(jobId)}`,
        "--format=count",
      ]);
      expect(result.stdout.trim(), describeCli(result)).toBe(expected);
    }
  },
);
