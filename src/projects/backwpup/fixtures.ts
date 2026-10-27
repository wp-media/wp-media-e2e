import { createBdd } from "playwright-bdd";

import { test as base } from "../../common/fixtures";
import { PluginsPage } from "../../common/pages/plugins.page";
import { BackupHistoryTable } from "./pages/backup-history.table";
import { DashboardPage } from "./pages/dashboard.page";
import { DataSelectionSidebar } from "./pages/data-selection.sidebar";
import { FirstBackupPage } from "./pages/first-backup.page";
import { FrequencySidebar } from "./pages/frequency.sidebar";
import { JobRunPanel } from "./pages/job-run.panel";
import { OnboardingPage } from "./pages/onboarding.page";
import { StorageSidebar } from "./pages/storage.sidebar";
import { restorePage } from "./pages/restore.page";
import { ArchiveSnapshot } from "./support/archive-snapshot";
import { CliSession } from "./support/cli-session";
import { ScenarioKeys } from "./support/encryption-keys";
import { JobExports } from "./support/job-transfer";
import { ChangedMarkers, removeMarkers, seedMarkers } from "./support/markers";
import { CliRestore, contentKeptOut, restoreSite } from "./support/cli-restore";
import { ContentCopy } from "./support/content-copy";
import {
  LEFTOVER_FIXTURE_OPTIONS,
  assertNoContentCopyLeft,
} from "./support/content-copy-leftover";
import { BACKWPUP_SITE_RESIDUE } from "./support/residue";
import { resolveSiteResidue } from "../../common/wp/residue";
import { PrivateFolder, privateFolderKey } from "./support/private-folder";
import { TablePadding, sweepPaddingLeftovers } from "./support/table-padding";
import type { RestorePage } from "./pages/restore.page";
import type { SiteMarkers } from "./support/markers";

/**
 * BackWPup's test instance — the shared one from `common/fixtures.ts` plus this product's page
 * objects, registered as fixtures — POM-as-fixture, never decorators.
 *
 * **Why this lives here and not in `common/fixtures.ts`.** The shared layer is where POMs would
 * normally be registered, but doing that for a *product's* POMs would make it import product code
 * — the same inversion the shared debug-log registry exists to avoid — and would load
 * BackWPup's page objects into every WP Rocket run. Extending the shared instance here keeps the
 * dependency pointing the right way (product → common) and each product's surface to itself.
 *
 * **This is supported, not a workaround.** playwright-bdd resolves which `test` a generated spec
 * imports by collecting the instances the scenario's steps were registered against and picking the
 * most-extended one (`ImportTestGuesser.findTopmostTest`); it only fails when two instances are
 * *unrelated*. Because this instance extends the shared one, a scenario mixing common steps (bound to
 * the base) with BackWPup steps (bound to this) resolves to this instance and gets both sets of
 * fixtures. The one hard requirement is that this file is listed in the product's `steps` config —
 * omit it and generation fails with "Can't guess test instance", which is at least loud.
 *
 * All POM fixtures are **lazy**: Playwright only constructs the ones a step actually destructures, so
 * a scenario touching one page pays for one object.
 */

interface BackWPupFixtures {
  /** The onboarding page at `page=backwpuponboarding` (only while `backwpup_onboarding` is set). */
  onboarding: OnboardingPage;
  /** The screen onboarding hands over to, where its first backup runs. */
  firstBackup: FirstBackupPage;
  /** The post-onboarding dashboard at `page=backwpup`. */
  dashboard: DashboardPage;
  /** The Select Files / Select Tables sidebars. */
  dataSelection: DataSelectionSidebar;
  /** The Job Scheduled Settings sidebar. */
  frequency: FrequencySidebar;
  /** The storage picker and each provider's settings panel. */
  storages: StorageSidebar;
  /** A running backup's in-page progress region (`#runningjob`). */
  jobRun: JobRunPanel;
  /** The Backups History table, as rendered on either screen that shows it. */
  backupHistory: BackupHistoryTable;
  /**
   * The restore screen for **this cell's edition** — Pro's in-place deep link or Free's forced
   * upload. Depends on the `edition` fixture, so requesting it in an editionless cell throws
   * there, with that fixture's message.
   */
  restore: RestorePage;
  /** The wp-admin Plugins screen (shared POM), for install/activate/delete flows. */
  plugins: PluginsPage;
  /**
   * The scenario's `wp backwpup …` conversation, for the scenarios where the **command** is what is
   * under test: it runs one and remembers the result so the assertion after it has something to
   * judge. A refusal is a result here, never a thrown error.
   */
  cli: CliSession;
  /**
   * Known-unique values planted in this site's files and database, removed again afterwards.
   *
   * Requesting it **plants them**, so a scenario that asks for it must do so before the backup it
   * intends to inspect — a marker added after a run cannot be in that run's archive. Only scenarios
   * that destructure it pay for it, and its teardown always runs, so a failed scenario still leaves
   * the site as it found it.
   */
  markers: SiteMarkers;
  /**
   * The scenario's own folder on the site, private to the transport's user, for the files a command
   * writes or reads there — a download, an export, a key — which a command names as
   * `{private folder}`. Free to request: nothing is created until a step uses it, and only then is it
   * removed afterwards, best-effort.
   */
  privateFolder: PrivateFolder;
  /**
   * The keys the scenario encrypts and decrypts with — drawn for it, named in a command only by a
   * placeholder, the key pair's files placed in {@link BackWPupFixtures.privateFolder}. Free to
   * request: nothing is drawn until a placeholder asks.
   */
  keys: ScenarioKeys;
  /**
   * Empty tables of the scenario's own in this site's database, so a paced database backup lasts as
   * long on every site. Free to request: nothing is created until a step pads, and only then are they
   * removed afterwards — after the `@plugin` teardown, so no backup is still dumping them.
   */
  tablePadding: TablePadding;
  /**
   * The job exports the scenario arranged, each with a digest of the site's jobs when it was made —
   * what "the site's jobs are as they were" is measured against.
   */
  jobExports: JobExports;
  /**
   * The archives the scenario's backups left, as they were when made — what "still on the site,
   * byte for byte" is measured against. The steps that make backups record into it.
   */
  archives: ArchiveSnapshot;
  /**
   * The values the scenario wrote over its {@link BackWPupFixtures.markers} after the backup it is
   * about to restore — what a restore that leaves one side of the site alone leaves there.
   */
  changedMarkers: ChangedMarkers;
  /**
   * The scenario's `wp backwpup restore` runs, guarded so the site ends as found: refused on a
   * database holding what `wp db reset` would destroy for good, `wp-content` copied before a files
   * restore and put back exactly after the scenario, the database's default collation set back, the
   * scenario's `--pre-backup` snapshot removed. Free to request: nothing happens until a run needs it.
   */
  cliRestore: CliRestore;
}

interface BackWPupWorkerFixtures {
  /**
   * Automatic, once per worker before its first scenario: drops any padding tables an earlier run
   * left on the bound site — one killed before its teardown, or whose removal failed. Best-effort,
   * like the shared `releaseBoundSite`.
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Playwright's type for a fixture that produces no value.
  leftoverPaddingSweep: void;
  /**
   * Refuses, before the worker's first scenario, a site still holding a copy of `wp-content` an
   * earlier run's restore guard could not put back — that site's `wp-content` may be damaged, so every
   * result on it would be suspect, and the copy may be the only way back — unless it is provably
   * orphaned (stamped by another boot, used by no process): then it is put back (or, holding none to
   * put back, removed) and the worker goes on. The auth setup's preflight runs the same first, before
   * its gates. Automatic.
   */
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Playwright's type for a fixture that produces no value.
  contentCopyLeftover: void;
}

export const test = base.extend<BackWPupFixtures, BackWPupWorkerFixtures>({
  leftoverPaddingSweep: [
    async ({ boundSite }, use) => {
      await sweepPaddingLeftovers(boundSite);
      await use();
    },
    { scope: "worker", auto: true, box: true },
  ],
  contentCopyLeftover: [
    async ({ boundSite }, use) => {
      await assertNoContentCopyLeft(boundSite);
      await use();
    },
    LEFTOVER_FIXTURE_OPTIONS,
  ],
  onboarding: async ({ page }, use) => {
    await use(new OnboardingPage(page));
  },
  firstBackup: async ({ page }, use) => {
    await use(new FirstBackupPage(page));
  },
  dashboard: async ({ page }, use) => {
    await use(new DashboardPage(page));
  },
  dataSelection: async ({ page }, use) => {
    await use(new DataSelectionSidebar(page));
  },
  frequency: async ({ page }, use) => {
    await use(new FrequencySidebar(page));
  },
  storages: async ({ page }, use) => {
    await use(new StorageSidebar(page));
  },
  jobRun: async ({ page }, use) => {
    await use(new JobRunPanel(page));
  },
  backupHistory: async ({ page }, use) => {
    await use(new BackupHistoryTable(page));
  },
  restore: async ({ page, edition }, use) => {
    await use(restorePage(page, edition));
  },
  plugins: async ({ page }, use) => {
    await use(new PluginsPage(page));
  },
  cli: async ({ site }, use) => {
    await use(new CliSession(site.transport));
  },
  markers: async ({ site }, use) => {
    const planted = await seedMarkers(site.transport);
    await use(planted);
    await removeMarkers(site.transport);
  },
  privateFolder: async ({ site }, use, testInfo) => {
    const folder = new PrivateFolder(
      site.transport,
      privateFolderKey(testInfo),
    );
    await use(folder);
    await folder.release();
  },
  keys: async ({ privateFolder }, use) => {
    await use(new ScenarioKeys(privateFolder));
  },
  tablePadding: async ({ site }, use) => {
    const padding = new TablePadding(site.transport);
    await use(padding);
    await padding.release();
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
  jobExports: async ({}, use) => {
    await use(new JobExports());
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
  archives: async ({}, use) => {
    await use(new ArchiveSnapshot());
  },
  // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
  changedMarkers: async ({}, use) => {
    await use(new ChangedMarkers());
  },
  // Torn down after the `@plugin` teardown (fixtures outlive `After` hooks), so the content directory
  // is put back once the plugin and its data are gone, and the debug.log it holds after the teardown
  // has read the scenario's.
  cliRestore: async ({ site, cli, changedMarkers, pluginArtifact }, use) => {
    const restore = new CliRestore(
      restoreSite(site.transport),
      cli,
      new ContentCopy(site.transport, async () =>
        contentKeptOut(
          pluginArtifact("plugin").slug,
          await resolveSiteResidue(site.transport, BACKWPUP_SITE_RESIDUE),
        ),
      ),
      changedMarkers,
    );
    await use(restore);
    await restore.release();
  },
});

export const { Given, When, Then, Step, Before, After, BeforeAll, AfterAll } =
  createBdd(test);
