import { expect } from "@playwright/test";
import type { Locator, Page } from "@playwright/test";

import { setToggle } from "./toggles";
import { waitForRest } from "../support/rest";
import { expectPanelOpen } from "./panels";

/** What a job backs up, as the dashboard's job card advertises it via its own CSS class. */
export type JobDataType = "mixed" | "files" | "database";

/**
 * Which sidebar each job-card link opens, from the `data-content` the rendered card carries.
 *
 * Only "Frequency" and "Format" name their sidebar after the link; "Data" opens `settings-data-type`
 * and "Storage" opens `storages` (plural), so the mapping cannot be derived from the label.
 *
 * "Data" is also the one link that does not open the panel a scenario actually wants: its sidebar is a
 * *chooser*, holding the Select Files and Select Tables panes hidden behind it. Reveal them with
 * {@link DataSelectionSidebar.openFilesPane} / `openTablesPane` — and note the top-level
 * `#sidebar-select-files` article on this screen is a permanently empty shell, never these panes.
 */
const SIDEBAR_OF: Readonly<
  Record<"Data" | "Frequency" | "Storage" | "Format", string>
> = {
  Data: "settings-data-type",
  Frequency: "frequency",
  Storage: "storages",
  Format: "format",
};

/** The dashboard's address, relative to the site. */
const DASHBOARD_PATH = "/wp-admin/admin.php?page=backwpup";

/** Any URL of the dashboard itself: `page=backwpup` exactly, never `page=backwpupfirstbackup`. */
const DASHBOARD_URL = /[?&]page=backwpup(?:&|#|$)/;

/** How long the page's own navigation to the dashboard may take to load once it took over ours. */
const OWN_NAVIGATION_TIMEOUT_MS = 30_000;

/**
 * How a `page.goto` failed, read from Playwright's message: cut short by another navigation of the
 * same page (`to` where, when Playwright saw it), or something else.
 */
export type GotoFailure =
  /** Another navigation committed instead: "is interrupted by another navigation to …". */
  | { readonly kind: "interrupted"; readonly to: string }
  /** The browser cancelled it before anything committed (`net::ERR_ABORTED`); where to is unknown. */
  | { readonly kind: "aborted" }
  /** Anything else: the site, the network, a timeout. */
  | { readonly kind: "other" };

/**
 * Classifies what `page.goto` threw.
 *
 * @param error - the thrown value.
 */
export function classifyGotoFailure(error: unknown): GotoFailure {
  if (!(error instanceof Error)) return { kind: "other" };
  const to = /is interrupted by another navigation to "([^"]*)"/.exec(
    error.message,
  )?.[1];
  if (to !== undefined) return { kind: "interrupted", to };
  return /\bnet::ERR_ABORTED\b/.test(error.message)
    ? { kind: "aborted" }
    : { kind: "other" };
}

/**
 * Page object for BackWPup's dashboard — `admin.php?page=backwpup` once onboarding is complete.
 *
 * The screen has three regions, each owned here or delegated:
 *  - the header: "Backup Now" and "Advanced settings";
 *  - **Next Scheduled Backups** — one job card per configured job, plus an "Add a new backup" card;
 *  - **Backups History** — delegated to {@link BackupHistoryTable}, which the Backups screen shares.
 *
 * Note this page is reachable *only* when `backwpup_onboarding` is unset; while it is set the
 * request is redirected to onboarding. {@link expectLoaded} therefore asserts on a
 * dashboard-only landmark, so a scenario that forgot to seed the state fails here with a clear
 * message instead of silently driving onboarding.
 */
export class DashboardPage {
  /**
   * @param page - the browser page.
   * @param ownNavigationTimeoutMs - how long {@link goto} waits for a navigation that took over its
   * own to land on the dashboard.
   */
  constructor(
    private readonly page: Page,
    private readonly ownNavigationTimeoutMs = OWN_NAVIGATION_TIMEOUT_MS,
  ) {}

  /**
   * Navigates to the dashboard.
   *
   * A screen may send itself there at the same moment — the first-backup screen does as its job ends
   * (see `first-backup.page.ts`) — and Playwright then fails the `goto`: "interrupted by another
   * navigation", or `net::ERR_ABORTED` when nothing had committed yet. When that other navigation
   * goes to the dashboard, the page is going exactly where asked, so its load is awaited instead. A
   * navigation elsewhere, a page that never reaches the dashboard, or any other failure throws what
   * `goto` threw; what the page shows is still for {@link expectLoaded} and the steps after it.
   *
   * @throws Error from `goto`.
   */
  async goto(): Promise<void> {
    try {
      await this.page.goto(DASHBOARD_PATH);
    } catch (error) {
      const failure = classifyGotoFailure(error);
      if (
        failure.kind === "other" ||
        (failure.kind === "interrupted" && !DASHBOARD_URL.test(failure.to))
      ) {
        throw error;
      }
      try {
        await this.page.waitForURL(DASHBOARD_URL, {
          timeout: this.ownNavigationTimeoutMs,
        });
      } catch {
        throw error;
      }
    }
  }

  /**
   * Asserts the dashboard is showing (not the onboarding page it redirects to).
   *
   * Uses the two headings only the dashboard renders. Onboarding has neither, so this doubles as
   * the "onboarding really is complete" check.
   */
  async expectLoaded(): Promise<void> {
    await expect(
      this.page.getByRole("heading", { name: "Next Scheduled Backups" }),
    ).toBeVisible();
    await expect(
      this.page.getByRole("heading", { name: "Backups History" }),
    ).toBeVisible();
  }

  // ── Header actions ───────────────────────────────────────────────────────────

  /**
   * Opens the "Backup Now" confirmation modal and returns once it is showing.
   *
   * The header button only *opens* a modal; nothing is backed up until its "Start" is pressed. The
   * two steps are deliberately separate methods so a scenario cannot accidentally launch a real
   * backup while meaning to inspect the dialog — see {@link JobRunPanel.startFromModal}.
   */
  async openBackupNow(): Promise<void> {
    await this.page
      .locator('.js-backwpup-open-modal[data-content="backup-now"]')
      .click();
    await expect(this.backupNowModal).toBeVisible();
  }

  /** The "Backup Now" confirmation modal, pre-rendered in the page and revealed on demand. */
  get backupNowModal(): Locator {
    return this.page.locator("#sidebar-backup-now");
  }

  /**
   * Opens the site-wide "Advanced settings" sidebar.
   *
   * Two buttons carry this action — a labelled one for wide viewports and an **icon-only** one for
   * narrow ones, which has no accessible name at all. Addressing them by the plugin's own
   * trigger class covers both, and `.first()` picks whichever the current viewport renders visible;
   * a `@mobile` scenario therefore needs no special case.
   */
  async openAdvancedSettings(): Promise<void> {
    await this.page
      .locator('.js-backwpup-open-sidebar[data-content="advanced-settings"]')
      .filter({ visible: true })
      .first()
      .click();
    await expectPanelOpen(this.page.locator("#sidebar-advanced-settings"));
  }

  // ── Job cards ────────────────────────────────────────────────────────────────

  /** The container the job cards render into. (The plugin's own id misspells "backwpup".) */
  private get jobCardsRegion(): Locator {
    return this.page.locator("#backwup-next-scheduled-backups");
  }

  /** Every job card currently shown. */
  get jobCards(): Locator {
    return this.jobCardsRegion.locator(".backwpup-job-card");
  }

  /**
   * The job cards that back up `dataType`.
   *
   * The card advertises its type in its own class (`backwpup-job-mixed` / `-files` / `-database`),
   * set from `BackWPup_JobTypes` — a contract of the plugin's, not a layout detail.
   */
  jobCardsOfType(dataType: JobDataType): Locator {
    return this.jobCardsRegion.locator(`.backwpup-job-${dataType}`);
  }

  /** One job's card, by job id. */
  jobCard(jobId: number): Locator {
    return this.page.locator(`#backwpup-${String(jobId)}-options`);
  }

  /** A job card's title, as the user reads it. */
  jobTitle(jobId: number): Locator {
    return this.jobCard(jobId).locator(".backwpup-job-title");
  }

  /**
   * A job card's schedule line.
   *
   * Reads "No backup scheduled" when inactive, "External link" for link-triggered jobs, or a
   * localised "<date> at <time>" otherwise — so assert the first two exactly and the third loosely.
   */
  scheduleLabel(jobId: number): Locator {
    return this.jobCard(jobId).locator(".label-scheduled");
  }

  /** Enables or disables a job's schedule. Idempotent. */
  async setJobEnabled(jobId: number, enabled: boolean): Promise<void> {
    const name = `next_backup_${String(jobId)}`;
    await setToggle(
      this.page.locator(`label[for="${name}"]`),
      this.page.locator(`#${name}`),
      enabled,
    );
  }

  /** Asserts whether a job's schedule is enabled. */
  async expectJobEnabled(jobId: number, enabled: boolean): Promise<void> {
    await expect(
      this.page.locator(`#next_backup_${String(jobId)}`),
    ).toBeChecked({ checked: enabled });
  }

  /**
   * Opens one of a job card's configuration sidebars.
   *
   * The four links are labelled "Data", "Frequency", "Storage" and "Format", and each is disabled
   * while the job is inactive — so this asserts the link is enabled first, turning "the scenario
   * forgot to enable the job" into a clear failure rather than a click that does nothing.
   *
   * The sidebar's content is fetched (`getblock`), so the load is awaited as a REST barrier: the
   * sidebar element exists in the DOM from the start and would satisfy a visibility check before
   * its contents arrived.
   */
  async openJobSidebar(
    jobId: number,
    which: "Data" | "Frequency" | "Storage" | "Format",
  ): Promise<void> {
    // The job cards themselves arrive asynchronously (the dashboard fetches `getjobslist` after load),
    // so wait for this card before reaching into it — otherwise the click can race the render.
    await expect(this.jobCard(jobId)).toBeVisible();
    const link = this.jobCard(jobId).getByRole("button", { name: which });
    await expect(link).toBeEnabled();
    await Promise.all([waitForRest(this.page, "getblock"), link.click()]);
    // The request only proves the panel was asked for; the panel being *open* is the outcome. Visibility
    // alone cannot express that — the shell pre-exists in the DOM, and a previously-opened panel stays
    // "visible" while the aside is parked off-screen — so this goes through `expectPanelOpen`.
    await expectPanelOpen(this.page.locator(`#sidebar-${SIDEBAR_OF[which]}`));
  }

  /**
   * Deletes a job from its card, via the card's trash control.
   *
   * There is **no confirmation dialog**: the plugin's delegated handler fires `delete_job` straight
   * away (`assets/js/backwpup-admin.js:1256`), so that call is the completion signal and the card
   * disappearing is the user-visible consequence. Destructive and immediate — callers should treat it
   * as such.
   */
  async deleteJob(jobId: number): Promise<void> {
    await Promise.all([
      waitForRest(this.page, "delete_job"),
      this.jobCard(jobId)
        .locator(`.js-backwpup-delete-job[data-job-id="${String(jobId)}"]`)
        .click(),
    ]);
    await expect(this.jobCard(jobId)).toHaveCount(0);
  }

  /**
   * The "Add a new backup" card, shown alongside any existing jobs.
   *
   * **Scoped to the job-card region deliberately.** The dashboard emits
   * `id="js_backwpup_add_new_backup"` **twice** — once in the visible region and once inside the
   * hidden `#backwpup_dynamic_response_content` template the plugin clones from. A bare id lookup
   * therefore matches two elements and fails Playwright's strict mode on the first click; scoping to
   * the region picks the real one. (Verified in the captured markup, where the duplicate is present.)
   */
  get addBackupCard(): Locator {
    return this.jobCardsRegion.locator("#js_backwpup_add_new_backup");
  }

  /**
   * Adds another backup job.
   *
   * Despite the card's wording this creates the job immediately rather than opening a form: the
   * handler posts `addjob` with `type: "mixed"` (`assets/js/backwpup-job.js:38`) and then refreshes the
   * card list, so `addjob` is the completion signal. The card self-disables while in flight to block
   * double submission, which is why a second call cannot race the first.
   */
  async addBackup(): Promise<void> {
    const before = await this.jobCards.count();
    await Promise.all([
      waitForRest(this.page, "addjob"),
      this.addBackupCard
        .getByRole("button", { name: "Add a new backup" })
        .click(),
    ]);
    // A new card is the user-visible outcome; the request alone would not prove the job was created.
    await expect(this.jobCards).toHaveCount(before + 1);
  }
}
