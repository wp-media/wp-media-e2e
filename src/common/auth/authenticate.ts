import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { Browser, TestInfo, test as base } from "@playwright/test";

import { workerPalette } from "../config/output";
import type { SiteConfig } from "../config/types";
import { withinBudget } from "../deadline";
import { errorMessage } from "../guards";
import { redactSecrets } from "../text";
import { SITE_INFO_ATTACHMENT } from "../setup/attachments";
import { describeSiteInfo, readSiteInfo } from "../setup/site-info";
import type { SiteInfoEntry } from "../setup/site-info";
import { loginViaUi } from "./login";
import { endSavedSessions } from "./session";

/**
 * The auth setup's work once preflight has passed: per site, end the previous run's session, log
 * in, save the session, read the site's versions; then attach the versions to the reports.
 *
 * What a failed setup leaves is kept harmless: its trace (kept on failure) records the saved
 * sessions' cookies — `storageState()`'s result is a traced call — so a failure ends every session
 * the setup saved ({@link SavedSessions}). A thrown failure ends them before it is reported; a timeout
 * abandons the setup's body, so {@link endSessionsWhenSetupFails} ends them from its `afterEach`. Nothing
 * can use them anyway: the scenarios do not run.
 */

/** How long each best-effort step around a login may take (ms). */
export interface BestEffortBudgets {
  /** Ending one site's saved sessions: a WP-CLI call per session, ~1.5 s over SSH. */
  readonly sessionEndMs: number;
  /** Reading one site's versions from Site Health, its page load included. */
  readonly siteInfoMs: number;
}

/** The budgets the auth setup runs with. */
const BUDGETS: BestEffortBudgets = { sessionEndMs: 20_000, siteInfoMs: 20_000 };

/**
 * What {@link authenticatePool} may spend per site on top of the login: ending the previous session,
 * reading the versions, and — on a failure — ending the new session. The setup adds it to its
 * timeout, so a best-effort step that hangs runs out of its own budget, never the setup's.
 */
export const BEST_EFFORT_ALLOWANCE_PER_SITE_MS =
  2 * BUDGETS.sessionEndMs + BUDGETS.siteInfoMs;

/**
 * The variable that stops Playwright writing a failed test's page snapshot into `error-context.md`.
 * Undocumented — read in Playwright 1.63's own source each time a snapshot would be taken — so
 * `secrets.run.spec.ts` proves it still works.
 */
const FAILURE_SNAPSHOT_OFF = "PLAYWRIGHT_NO_COPY_PROMPT";

/**
 * Turns the failure snapshot off in this process.
 *
 * @param env - the environment to change: the process's own, or a test's stand-in.
 * @returns what puts the variable back as it was.
 */
export function hideFailureSnapshot(
  env: NodeJS.ProcessEnv = process.env,
): () => void {
  const before = env[FAILURE_SNAPSHOT_OFF];
  env[FAILURE_SNAPSHOT_OFF] = "1";
  return () => {
    if (before === undefined) Reflect.deleteProperty(env, FAILURE_SNAPSHOT_OFF);
    else env[FAILURE_SNAPSHOT_OFF] = before;
  };
}

/**
 * Keeps a setup file's typed passwords out of the page snapshot Playwright writes into
 * `error-context.md` when a test fails: the page's accessibility tree, which prints every text
 * field's value — a password field's included — into an attachment every report copies. Taken when a
 * context is still open at the test's end: a setup that times out mid-login.
 *
 * Off for each test, then back on **only after a test that ended as expected**, for two measured
 * reasons:
 *  - A setup worker hands every variable it changed to its dependent projects' workers when it
 *    stops (Playwright's produced environment); left set, the scenarios would lose their own
 *    snapshots.
 *  - A failed test's `afterEach` and `afterAll` hooks run before its snapshot is taken, so turning it
 *    back on there would print the password. Left set, it travels only to scenarios that never run:
 *    a failed setup skips them.
 *
 * One case is left: a setup that fails and then passes on a retry — only with a command-line
 * `--retries`, since the config gives the setups none. Playwright merges each attempt's changed
 * variables, and the passing one changed nothing, so the scenarios inherit the switch off: they lose
 * their failure snapshots, never gain a password.
 *
 * @param setupTest - the setup file's test, whose hooks this registers.
 */
export function keepSecretsOutOfFailureSnapshots(setupTest: typeof base): void {
  let showFailureSnapshot: (() => void) | undefined;
  setupTest.beforeEach(() => {
    showFailureSnapshot = hideFailureSnapshot();
  });
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring; no fixtures needed.
  setupTest.afterEach(({}, testInfo) => {
    if (testInfo.status === testInfo.expectedStatus) showFailureSnapshot?.();
  });
}

/**
 * The sessions a setup has saved so far: what must be ended if the setup fails. Shared between
 * {@link authenticatePool}, which ends them when a login throws, and the setup's `afterEach`
 * ({@link endSessionsWhenSetupFails}), which ends them when the setup timed out instead.
 */
export class SavedSessions {
  /** The sites whose session file was written and not yet ended. */
  private readonly sites: SiteConfig[] = [];

  /** How many saved sessions are not ended yet. */
  get size(): number {
    return this.sites.length;
  }

  /**
   * Records a site whose session was saved.
   *
   * @param site - the site.
   */
  add(site: SiteConfig): void {
    this.sites.push(site);
  }

  /**
   * Ends every recorded session, best-effort and bounded per site, and forgets them — so a second
   * call (the `afterEach` after a throw already ended them) does nothing.
   *
   * @param budgetMs - how long ending one site's session may take.
   */
  async endAll(budgetMs: number = BUDGETS.sessionEndMs): Promise<void> {
    const sites = this.sites.splice(0);
    for (const site of sites) {
      await endSessionsOf(
        site,
        "this run's session, as the setup failed",
        budgetMs,
      );
    }
  }
}

/**
 * Registers the setup's `afterEach` that ends the sessions it saved when it did not end as expected:
 * a timeout abandons the body, so {@link authenticatePool}'s own clean-up never runs, while Playwright
 * still runs the `afterEach`.
 *
 * @param setupTest - the setup file's test, whose hook this registers.
 * @param saved - the ledger; a new one by default.
 * @returns the ledger to hand {@link authenticatePool}.
 */
export function endSessionsWhenSetupFails(
  setupTest: Pick<typeof base, "afterEach">,
  saved: SavedSessions = new SavedSessions(),
): SavedSessions {
  // eslint-disable-next-line no-empty-pattern -- Playwright requires the destructuring; no fixtures needed.
  setupTest.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== testInfo.expectedStatus) await saved.endAll();
  });
  return saved;
}

/**
 * Authenticates every site of a pool, in turn, and attaches their versions as `site-info.json` —
 * also when a login fails, so the reports keep what was read.
 *
 * @param browser - the setup's browser; each site gets a context of its own.
 * @param sites - the real sites, their transports already verified.
 * @param testInfo - the setup's, for the attachment.
 * @param budgets - how long each best-effort step may take; the setup's own by default.
 * @param saved - where each saved session is recorded: the setup's {@link endSessionsWhenSetupFails}
 *   ledger, so a timeout ends them too.
 * @throws {@link Error} the first login failure, after ending every session saved before it.
 */
export async function authenticatePool(
  browser: Browser,
  sites: readonly SiteConfig[],
  testInfo: Pick<TestInfo, "attach">,
  budgets: BestEffortBudgets = BUDGETS,
  saved: SavedSessions = new SavedSessions(),
): Promise<void> {
  const siteInfo: SiteInfoEntry[] = [];
  try {
    for (const site of sites) {
      await endSessionsOf(
        site,
        "the session the previous run left",
        budgets.sessionEndMs,
      );
      siteInfo.push(
        await authenticateSite(browser, site, budgets.siteInfoMs, () => {
          saved.add(site);
        }),
      );
    }
  } catch (error) {
    await saved.endAll(budgets.sessionEndMs);
    throw error;
  } finally {
    await attachSiteInfo(testInfo, siteInfo);
  }
}

/**
 * Logs in to one site in a context of its own, saves the session, and reads the site's versions.
 *
 * @param siteInfoMs - how long reading the versions may take.
 * @param onSaved - called once the session file is written.
 * @returns the site's versions, or why they could not be read.
 * @throws {@link Error} when the login fails.
 */
async function authenticateSite(
  browser: Browser,
  site: SiteConfig,
  siteInfoMs: number,
  onSaved: () => void,
): Promise<SiteInfoEntry> {
  const context = await browser.newContext({ baseURL: site.baseURL });
  try {
    const page = await context.newPage();
    await loginViaUi(page, site);

    await mkdir(dirname(site.storageState), { recursive: true });
    await context.storageState({ path: site.storageState });
    onSaved();

    const entry = await readSiteInfo(page, site.baseURL, siteInfoMs);
    // A worker's line: the run's symbols (ASCII under plain), never colour.
    const line = `[site] ${describeSiteInfo(entry, workerPalette())}`;
    if ("error" in entry) console.warn(line);
    else console.log(line);
    return entry;
  } finally {
    await context.close();
  }
}

/**
 * Ends the sessions a site's saved login holds. Best-effort and bounded: a session that cannot be
 * ended still expires on its own (two days, the login not being remembered), so a failure — or a
 * WP-CLI call that does not answer — is a warning.
 *
 * @param which - what the session is, for the message.
 * @param budgetMs - how long it may take.
 */
async function endSessionsOf(
  site: SiteConfig,
  which: string,
  budgetMs: number,
): Promise<void> {
  try {
    const ended = await withinBudget(
      endSavedSessions(site),
      budgetMs,
      `ending ${which}`,
    );
    // A setup's output reaches the reports: a basic-auth `baseURL` is masked, as every message is.
    const url = redactSecrets(site.baseURL);
    if (ended > 0) console.log(`[auth] ${url}: ended ${which}`);
  } catch (error) {
    console.warn(
      `[auth] ${redactSecrets(site.baseURL)}: could not end ${which} (it still expires on its own): ` +
        redactSecrets(errorMessage(error).split("\n")[0] ?? ""),
    );
  }
}

/** Best-effort JSON attachment of every site's versions, for the reports. */
async function attachSiteInfo(
  testInfo: Pick<TestInfo, "attach">,
  entries: readonly SiteInfoEntry[],
): Promise<void> {
  try {
    await testInfo.attach(SITE_INFO_ATTACHMENT, {
      body: JSON.stringify(entries, null, 2),
      contentType: "application/json",
    });
  } catch {
    // An attachment failure must never fail the login it reports on.
  }
}
