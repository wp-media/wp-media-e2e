# Phase 6 — Feature porting: BackWPup first

Status: done 6A–6F, 6G.0, 6G with 6G.1 (2026-10-05), 6H.0 (2026-10-21). Paused for modernization
Phase 11 — shared SSH server profiles (decided 2026-10-22; Phases 7 and 12, which came first, are
done); resumes at 6H. Deferred: 6H.2 (needs storage credentials).

Parent: [e2e-modernization-plan.md](e2e-modernization-plan.md), Phase 6 — this plan supersedes that
phase's summary. WP Rocket's port comes after Phase 10 (§6). Baseline (reference only):
`wp-rocket-e2e/src/backwpup/` — 12 feature files, 28 scenarios, ~1.6k LoC. As built: features in
`src/projects/backwpup/features/`; the shared rails in
[wordpress-automation.md](../architecture/wordpress-automation.md); fixtures, tags and page objects
in [authoring-tests.md](../guides/authoring-tests.md) and `AGENTS.md`.

## TL;DR

- Port the baseline BackWPup suite onto the new rails by Understand → Improve → Adapt → Port (§1):
  the baseline states intent, the plugin's source and live measurement (§2) state the contract.
  Nothing is copied.
- Done: 6A shared rails (`@plugin` lifecycle, debug-log gate, `@mobile`, lint gate); 6B page
  objects; 6C onboarding; 6D backups and history (6D.1: what an archive holds); 6E plugin deletion
  (6E.0: the leftover-footprint sweep); 6F the WP-CLI surface (6F.0–6F.4); 6G.0 errors that never
  quote an argv; 6G restore (6G.1: hashed restore directories); 6H.0 a half-removed plugin folder
  costs one scenario, never all later ones. BackWPup runs as the site since Phase 12
  ([phase-12 plan](phase-12-site-identity-plan.md)); its one two-user scenario opts back to the SSH
  user.
- Open: 6H (storage config and skip gate), 6I (Free upsell scenario, parity gate) and **6I.1 restore
  parity** (Free upload counterparts to Pro's five UI restores), 6J (shared: keep the staging area off
  the web), 6K (restore `.zip` and `.tar.gz`). 6H.2, the storage round-trips, waits for credentials and
  blocks nothing.
- Order: (modernization Phase 11) → 6H → 6I (with 6I.1) → 6J → 6K → later 6H.2. 6I.1 depends only
  on 6G. 6J depends on nothing and may be pulled forward. 6K needs only 6G, but lands after 6I.1
  because both edit the restore feature. Phase 11 touches configuration, not the port.
- Editions: Free and Pro ship byte-identical UI templates (V1), so one page-object set serves both;
  five of the six baseline storage suites are not Pro-only (V2), so they run on both editions; the
  restore entry path diverges (V13) — Pro restores from the archive already on the server, Free
  forces a re-upload of it. That is the one place needing per-edition scenarios and an edition-aware
  page object; 6I.1 gives Free the same five UI strategies through that upload journey.

## 1. Method — Understand → Improve → Adapt → Port

Per scenario and per page object, in order:

1. Understand — what the baseline scenario asserts (intent, not mechanics); then the plugin's
   real contract in source (markup, REST route, CLI command, option). The baseline is a statement of
   intent, never a specification.
2. Improve — the strongest signal available: a role/label locator over a CSS chain, a REST
   barrier over `networkidle`, WP-CLI structured output over DOM scraping, a seeded option over
   re-driving onboarding. No fixed sleeps.
3. Adapt — the target's rails: fixtures (`site`, `edition`, `pluginArtifact`), POM-as-fixture,
   the transport layer, per-cell editions, tags.
4. Port — feature + thin steps + the POM's locator spec, green on a real cell.

Rule: a step that cannot state its assertion in one sentence of product language is transliterated,
not ported. Selectors never appear in Gherkin.

### 1.1 Anti-pattern → replacement

Defects in the baseline BackWPup suite and how the port removes them. This table plus the V-facts is
the improvement budget (§7).

| Baseline pattern | Where | Replacement |
| --- | --- | --- |
| `waitForLoadState("networkidle")` after nearly every action | `steps/general.ts`, `utils/helpers.ts` | Web-first `expect()`; `waitForResponse(…/backwpup/v1/<route>…)` where the REST call is the completion signal. |
| `waitForTimeout(500 / 2000 / 180000)` | `onboarding.ts`, `utils/storage.ts`, `general.ts` | Deleted. The 3-minute schedule sleep → fire the one due event (never `wp cron event run <hook>`, V40). |
| `page.waitForSelector(sel, { state })` | throughout | `expect(locator).toBeVisible()` / `toBeHidden()`. |
| `isChecked()` → `if` → `click()` | `onboarding.ts` | Idempotent `pages/toggles.ts`: click the visible proxy only when the state differs, then assert it. Not `setChecked()`: the checkboxes are `sr-only` (V16). |
| `td:nth-child(n)` + counting `<td>`s to sniff the table layout | `general.ts` `captureBackupTableData` | `tr[data-backup-id]` rows (V6); `toHaveCount(n)`; the failed-row branch; ground truth from `wp backwpup backup --format=json`. |
| `for (i < count) { expect(nth(i)) }` | `onboarding.ts` `validateCheckboxSelection` | `toHaveCount(n)` + one filtered "none unchecked" assertion. |
| Raw CSS through Gherkin (`I click '.js-backwpup-onboarding-step-2' button`) | `onboarding.feature`, every storage feature | Intent-level steps (`When I continue to the schedule step`). |
| `page.type()` (deprecated) | `storage.ts` `setupMSAzure` | `locator.fill()`; a secret through `enterSecret`. |
| Per-scenario UI login in every Background | all features | `storageState`. |
| `catch { console.log(...) }` swallowing failures | `helpers.ts` `waitForBackupJobCompletion`, `hooks.ts` | Typed errors (`wp/errors.ts`); best-effort only in teardown, and logged. |
| Mutable `this.initialBackups` on the World | `general.ts` | Scenario-scoped fixture; absolute assertions from a known-clean state. |
| `Date.now()` in a storage folder name | `storage.ts` `setupFTP` | A `testInfo`-derived name: unique per test, reproducible, traceable (6H). |
| Cleanup by SSH `rm` glob into uploads | `support/hooks.ts` | WP-CLI + the transport layer; `cleanSiteStaging` for our staging. |
| `@bwpup @bwpupsetup @bwpupsmoke @bwpupbackup` on every feature | all features | The product is the config, not a tag (§3.3). |

### 1.2 Assertion rules learned in 6B–6G

From 6B–6G's defects and audits; new scenarios follow them.

- Prove the population first. "None of them is unchecked" over a filtered set also passes on a
  pane that rendered nothing; assert the count (an exact five file areas) before the filter.
- Give every absence a positive control on the same machinery. 6D.1 plants two markers and
  asserts one present, one absent; an archive must list at least one member before "holds no …"
  counts.
- Arrange so the claim can fail. Two archives when a step picks "the newest"; an export held to
  its job both ways (V156); a partial restore asserts the half it skips is still changed.
- Never take the command's word. Exit 0 and `Success:` are not verdicts (authoring-tests.md);
  confirm against a second source — history row, log, marker, file on disk — read without the
  plugin's own listing code where that code is under test.
- Two independent sources agree: the UI and WP-CLI or the stored option.
- Transcribe stubs from measured output. An invented tar error once let a broken readability
  check pass its own test.
- Prove each new assertion with a mutation that removes it (every sub-phase since 6E).
- A method that cannot do its job is worse than none: `StorageSidebar` has no `close()` (V20),
  `FirstBackupPage` no wait (V27).
- Measure a timing margin on every cell it runs on. `cli-running-job.feature` was measured on
  the nginx cells only and lost its race on `pro@apache` (V186).

## 2. What the baseline is, and what the plugin actually does

The plan's store of verified facts — BackWPup Free/Pro, WordPress, WP-CLI, PHP, the tools, the cells
and the suite's own traps — by topic. "Live" means measured on a cell: `pro@nginx` (`simple.e2e`)
and `free@nginx` (`bwu.e2e`) share the nginx QA host (V162); `pro@apache` is on the apache one
(V231). A row holds at the ref and cell §2.2 gives its id range unless it names another. V-ids are
permanent; a missing id was merged or dropped.

Plugin bugs to report upstream: V33, V108, V111, V113, V115, V122 (with V174), V124, V128, V131,
V146 (first; with V166), V149, V152, V153, V155 (docs), V160, V163 (security), V167 (with V41,
V298), V194, V205, V207, V226, V292 (V277).

### 2.1 Baseline inventory (28 scenarios)

| Baseline feature | Sc. | Intent | Ported in |
| --- | --- | --- | --- |
| `onboarding.feature` | 6 | Data selection, frequency (simple + advanced), storage step, per-type job cards | 6C |
| `backup.feature` | 2 | Manual "Backup now"; a scheduled job produces a backup | 6C, 6D |
| `download-restore.feature` | 1 | Download the first backup from history | 6D |
| `delete-plugin.feature` | 3 | Delete the plugin after install / after activate / after first backup | 6E |
| `wp-cli/list-jobs.feature` | 2 | Job count via WP-CLI | 6F.1 |
| `wp-cli/restore.feature` | 3 | Untracked WIP: never restores, only re-runs onboarding | 6G (written properly) |
| `storages/{ftp,s3,glacier,msazure,rsc,sugarsync}.feature` | 11 | Configure storage in onboarding and from the dashboard; back up to it | 6H.2 (deferred) |

Not in the baseline: the Free edition (every scenario installs `backwpup-pro`), backup deletion,
bulk actions, job logs, settings, encryption, job import/export. 6C added two onboarding rules it
missed: a data type before the schedule step, a destination before completion.

### 2.2 Refs measured and drift

Refs and where each id range was measured: 5.7.4 source (V1–V13, both editions from
`~/.apvm/cache/backwpup/releases/5.7.4/`) → `develop@c0dd22c` (6B–6C, V14–V33, live `pro@nginx`) →
`90f9391` (6D, V38–V53, live `pro@nginx`) → `f1ebfd0` (6E–6F.4's measuring: V54–V63 `pro@apache` +
`pro@nginx`, V64–V72 `free@nginx`, V73–V74 the three cells, V80–V141 both nginx cells (V97–V103
`pro@nginx`, V105/V107 source), V142–V145 §2.12, V146–V167 `pro@nginx`) → `af1ab5c` (6F.4–6G.0,
V168–V192; V176–V182 execa locally; V185–V188 `pro@apache` + `pro@nginx`; V189–V192 source) →
`a612005` (6G, V193–V225, live `pro@nginx`) → `ab4a2e2` (6G.1 and 6H.0's measurements, V226–V276) →
`cd26255` (6H.0's runs and follow-ups, V277–V298) → `a98abb6` (V299); latest stable 5.7.7 (V208).
Template, REST and CLI drift was measured nil through `90f9391`: `c0dd22c` against 5.7.4
(2026-07-30) had identical `components/`, `pages/`, `parts/`, REST routes, `src/Cli/Commands/` file
set, `$locked_pro_slugs` and 12 `restoreurl` call sites, and on 2026-08-05 matched 5.7.5 in those
plus `inc/Utils/` and `inc/class-page-onboarding.php`. The 6B locator-contract spec, built from
markup captured at the ref, turns any later drift into one unit-test failure.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V38 | `components/`, `pages/`, `parts/`, `pro/parts/`, `assets/js/` and all of `src/` are byte-identical between Pro 5.7.5 (the locator fixtures' source) and `9.99.99-90f93911`; only `inc/`'s three archive-engine files, the version header, readme, translation template and `vendor/` differ | `diff -rq` | The locator contract describes the ref under test. |
| V168 | `af1ab5c` (2026-09-25) changed vendored libraries only: phpseclib 3.0.52 → 3.0.57, pear/archive_tar 1.6.0 → 1.6.1, backwpup-archiver 0.6 → 0.6.1 (zip-extraction path-traversal fixes), backwpup-restore-shared 0.20.10 → 0.20.11 (no PHP change), monolog 2.11.0 → 2.11.1, inpsyde/assert to 1.0.0. Every BackWPup file 6F.4 rests on is byte-identical | GitHub compares; both builds diffed; `Composer\InstalledVersions` on the site | The facts resting on those libraries were measured again (V169). |
| V169 | At `af1ab5c` §2.8's bugs hold as measured: V146, V149/V150, V152, V153 (17 440 → 17 439 bytes under `Success`), V163, V166, V167 | Scratch drivers, a fresh install each | Still to report upstream. |
| V193 | `a612005` (2026-10-02): `214ad9d` names the restore working directory per install and sweeps ones abandoned for 6 h; `8c912a9` runs a scheduled job inside the WP-Cron request only (`wp_doing_cron()`); `59b6fd9` releases the archive before a restart. CLI restore and the wizard's views and scripts unchanged | `gh api …/compare/af1ab5c1...a6120057`; both builds diffed | 6G was measured and built here (V199, V204 re-check V189–V192). |

### 2.3 Editions

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V1 | Free and Pro ship byte-identical `components/`, `pages/`, `parts/` (also at `c0dd22c`; live at `f1ebfd0`, V64) | `diff -rq` | One POM set for both; what differs is runtime data (V2, V13). |
| V2 | Pro-only storages are exactly GDRIVE, GLACIER, HIDRIVE, ONEDRIVE; Free renders them as locked upsells (`li.js-backwpup-locked-storage`) | `components/storage-list.php` (`$locked_pro_slugs`, gated on `BackWPup::is_pro()`) | Of the baseline's six storage suites only Glacier is `@pro`; FTP, S3, MS Azure, Rackspace, SugarSync run on both editions. |
| V11 | The restore UI (`page=backwpuprestore`, `pages/restore.php`) is in both editions; Pro adds `backwpup-restore.zip` and the `restore` CLI | `inc/class-admin.php:766` in both | The page is shared, the journey to it is not (V13); CLI restore is `@pro`. |
| V13 | The restore entry diverges by edition. The history row's Restore uses a deep link (V197) only if the backup record carries `restoreurl`, else bare `page=backwpuprestore`. Shared `BackWPup_Destinations::file_get_list()` delegates to `BackWPup_Pro_Destinations::file_get_list()` when `is_pro()` and the service is not OneDrive, and only that Pro-only code stamps `restoreurl`; Pro also overrides the Website Server (`FOLDER`) destination. Exceptions: SugarSync stamps `restoreurl` itself in both editions; OneDrive never does | `inc/class-destinations.php:205` (byte-identical in both); `inc/Pro/class-destinations.php:49-73` (Free ships no `inc/Pro/`); `inc/Pro/class-destination-folder.php:184`; `inc/Utils/BackWPupHelpers.php:196-214`; `inc/class-destination-sugarsync.php:151` | Pro restores in place from the archive on the server; Free forces a re-upload of the same file (V203). A missing file, not a toggle, so the `@free` scenario must really upload. Separate `@pro`/`@free` scenarios on the Website Server destination; the one edition-aware POM branch. |
| V64 | The untagged suite runs on Free with no new scenario code; the preflight verified the Free identity (`backwpup-9.99.99-f1ebfd05.zip`, slug `backwpup/`, header `BackWPup`) from APVM's `free` variant with no manifest change | `free@nginx`: the full suite passed, every scenario on its first attempt | V1 confirmed live. |
| V65 | `uninstall.php` is byte-identical in both editions, as is `src/Backup/Database/Tables/Backup.php` (`bwpup_backups`, `bwpup_backups_version`); Free is a strict subset (266 files only in Pro, none only in Free) | Both variants of `f1ebfd05` | The footprint declaration is edition-independent by construction (V66). |
| V161 | The edition filter works by generation, not by skipping: `free@nginx`'s generated spec has no trace of a `@pro` scenario and `pro@nginx`'s none of a `@free` one; a `@pro` on the `Feature:` line generates no spec file at all for the other edition; `--list` agrees | The product's own `bddgen`, both placements | A `@pro` scenario never exists on a Free cell; check with `free@nginx`'s `--list`. |

### 2.4 The admin UI

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V6 | History rows carry `<tr data-backup-id="…">`; failed and aborted rows render their own branch (`"%s backup failed – %s"`; icons differ, V42) | `components/table-row-backups.php` | Replaces the baseline's `nth-child` and `<td>`-counting. |
| V7 | Buttons come from one component: `trigger` → class `js-backwpup-<trigger>`, `label` → a `<span>` that is the accessible name. `icon_position: "alone"` or an empty label renders no name | `components/form/button.php` | Role/label locators for labelled buttons; icon-only ones use the `js-backwpup-*` / `data-content` hook (§3.2). |
| V8 | 26 `register_rest_route()` registrations in two namespaces. `backwpup/v1` (22): `addjob`, `authenticate_cloud`, `backups`, `chatbot-context`, `cloud_is_authenticated`, `cloudsaveandtest`, `delete_auth_cloud`, `delete_job`, `getblock`, `getjobslist`, `job-abort-status`, `license_update`, `pagination`, `process_bulk_actions`, `save_excluded_tables`, `save_files_exclusions`, `save_job_settings`, `save_site_option`, `startbackup`, `storagelistcompact`, `update-job-title`, `updatejob`. `backwpup/v2` (4): `messages`, `storages`, `save_job_format`, `backups/(?P<id>\d+)/type` | Every call site in `src/**`, grouped by `Rest::ROUTE_NAMESPACE` / `ROUTE_V2_NAMESPACE` (`src/API/Rest.php:7,9`); same set at 5.7.4, `c0dd22c`, `90f9391`; re-read at `ab4a2e2` | Precise `waitForResponse` barriers replace `networkidle`; `support/rest.ts` maps each route to its namespace. |
| V12 | Admin pages: `backwpup`, `backwpupbackups`, `backwpupjobs`, `backwpupeditjob`, `backwpuplogs`, `backwpupsettings`, `backwpuprestore`, `backwpupabout`, `backwpupfirstbackup`, `backwpupdocs`, `backwpuponboarding` (V10); Free-only `backwpupbuypro`; Pro adds `backwpupsupport` | `inc/class-admin.php`, `inc/Pro/class-pro.php` | The URL surface the POMs own. `backwpuponboarding` is registered under the `page_hooks['backwpupbackups']` key (`class-admin.php:679`): hook keys are no index of slugs. |
| V14 | A storage tile is not a checkbox: clicking `js-backwpup-toggle-storage` opens that provider's settings form, and the hidden `#destination-<SLUG>` checkbox is ticked by `refresh_storage_destinations()` only once the settings save | Live; `assets/js/backwpup-admin.js:380` (`load_and_open_storage`), `:166-168` | Choosing a destination is configure, then save; the save's signal is the checkbox flipping (provider-agnostic). |
| V15 | One trigger class, two handlers: on the dashboard the tile fetches its form via `getblock`; in onboarding every panel is pre-rendered and the click makes no request | Live: a `getblock` barrier timed out in onboarding | No REST barrier in onboarding's storage step; visibility is the signal. |
| V16 | Every switch is an `sr-only`, `aria-hidden` checkbox behind a visible proxy, its `<label>` textless | `components/form/toggle.php`; `getByRole("checkbox")` and `getByLabel` resolve to nothing | Click the proxy, assert the hidden input (`pages/toggles.ts`); `setChecked()` cannot act on it (§3.2). |
| V17 | The running-job UI is `div#runningjob`, pre-rendered with `display:none`, not a modal; the only modal is the confirmation `#sidebar-backup-now`, whose "Start" launches the job. All 38 `#sidebar-*` panels are pre-rendered (27 + one per storage provider) | Captured markup | `JobRunPanel`. Presence proves nothing: assert visibility or content, never `toBeAttached`. |
| V18 | A storage panel's heading is not its picker label: ten providers title it `"<label> Settings"`, but `FOLDER`, offered as "Website Server", titles it "Folder Settings" | All eleven `<h1>`s of the captured markup | Titles come from a verified map (`STORAGE_PANEL_TITLES`), never derived. |
| V19 | The restore modal confirms with "Start Restoration", which has no "Restore" substring | The captured post-backup page | A `/Restore/` pattern matches nothing. |
| V20 | Sidebars close by sliding the shell off-screen (`translate-x-[450px]` on `#backwpup-sidebar`); the panel keeps a layout box, so Playwright still calls it visible. A provider sub-panel's close control is inert | DOM before and after a close | `close()` asserts the panel left the viewport; `StorageSidebar` has no `close()`. |
| V21 | Clear-search clears the filtering, not the search box; filtering removes rows from the DOM | Live | Assert the list size changed, never that the field emptied. |
| V42 | The history row gives `status = 'failed'` the `backwpup-failure-icon` and `aborted` `text-alert`; both get the `delete-failed-backup` control and neither Download nor Restore. A real aborted row renders `delete-failed-backup` and "Aborted by user", no failure icon | `components/table-row-backups.php:198-221`, `:109-123`; both nginx cells | Find failed rows by `[data-content="delete-failed-backup"]` (both statuses); the abort scenario asserts the aborted row in the browser (V83). |
| V43 | Bulk "Apply" sends no request: it stores the selection and opens `#sidebar-bulk-delete-backups`; `process_bulk_actions` fires on that dialog's "Delete Backups" | `assets/js/backwpup-admin.js:2178-2187`, `:2204` | Arm, then confirm, as the per-row delete does. |
| V45 | The dashboard and the Backups screen are one template: `page=backwpup`'s callback is `BackWPup_Page_Backups::page()`, rendering `pages/backups.php` | `inc/class-admin.php:473-483`, `:700-711` | One `BackupHistoryTable` serves both. The bulk controls are `max-md:hidden`, unusable under `@mobile`. |
| V73 | The history refreshes from a client-side poll a test cannot wait on: `backwpup-generate.js` polls `admin-ajax.php?action=backwpup_working` every 750 ms and fires `backup-complete` on `job_done`, and `backwpup-admin.js` then re-fetches the listing. "Backup Now" reloads the page (`startBackupProcess`: at once on 200, after 750 ms on 201), and a job that finished before the reload lands leaves no poll at all. `free@nginx`: archive on disk +3.3 s, job finished +8.5 s, row in the DOM +9.5 s | `assets/js/backwpup-generate.js:56`; `backwpup-admin.js:2376`, `:2341-2365`; `inc/class-page-jobs.php::ajax_working`; `inc/class-admin.php:1257` | No barrier tells the stale `backups` call from the fresh one, so the history assertions reload the history from the server first; a longer timeout only keeps the race. Held 21 of 21 with retries off on all three cells. |
| V74 | `tr#backwpup-backup-history-loading` is rendered unconditionally (`components/table-backups.php:29`) and removed only when `refreshBackupTable` replaces the `tbody` after a successful listing. A `waitForRest` armed around a navigation settled on the previous page's in-flight request | A spec serving the listing as 500 passed 3 of 4 with that barrier | Never arm a response barrier around a navigation. The reload waits on the navigation and the placeholder, so a failed listing fails the read. |
| V137 | The setting users see is "Maximum number script execution time (in seconds)" (Advanced Settings → Jobs); "Maximum script execution time" is the legacy settings page's label, registered under a null parent and reachable only by URL. Both save through `BackWPup_Page_Settings::save_post_form` | `parts/sidebar/settings-jobs.php:71`; `inc/class-admin.php:753`; `inc/class-page-settings.php:788` | Steps use the visible label. |

Also: the dashboard emits `id="js_backwpup_add_new_backup"` twice, once inside the hidden
`#backwpup_dynamic_response_content` template, so a bare id lookup fails strict mode: scope it to the
job-card region. The history listing is paged ten rows at a time, client and server agreeing
(`inc/class-admin.php:1279`, `src/Backups/History/Frontend/API/Rest.php:159`): `expectRowCount`
counts one page.

### 2.5 Onboarding, jobs and activation

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V9 | Scheduling uses the WP-Cron hook `backwpup_cron` with args `['arg' => <job_id>]`, one event per job, the hidden placeholder's included | `inc/class-cron.php`, `inc/class-page-onboarding.php:146` | Trigger one event by hook and args (`wp/cron.ts`), never `wp cron event run <hook>` (V40). |
| V10 | Option `backwpup_onboarding` gates onboarding by redirect: while truthy, every `page=backwpup*` request except `backwpupabout`, `backwpuponboarding`, `backwpupfirstbackup`, `backwpupsupport` is `wp_safe_redirect`ed to `admin.php?page=backwpuponboarding`, a page registered only while the option is set. Completing onboarding deletes the option | `inc/class-admin.php:272-282`, `:676`; `class-page-onboarding.php:174` (delete), `:249` | Post-onboarding scenarios seed the state over WP-CLI (V39; single-site `wp option`, multisite would need `wp site option`). `OnboardingPage` opens `page=backwpuponboarding`; asserting on `page=backwpup` would assert a redirect. |
| V22 | One job or two is decided by the cron, not the toggles: both types active with identical crons ⇒ one `type_job_both` job at the files placeholder's id; otherwise two, the inactive placeholder deleted. The inline dropdowns feed the cron only as a fallback: `get_onboarding_job_cron()` prefers a cron stored on the job, so saving the advanced sidebar (`save_job_settings`, immediate) also splits them, after which `frequency` may read `monthly` while `cron` is daily | `inc/class-page-onboarding.php:29-36`, `:91-111`, `:180-186`; `src/Jobs/API/Rest.php:597-658` | The two "split" scenarios are different paths; the advanced one asserts the schedules differ, never an exact frequency. |
| V23 | `wp backwpup job`, the `getjobslist` route and `next-scheduled-backup.php` hide the `tempjob` "First backup" job (its id in option `backwpup_first_backup_job_id`); `job` also hides a record flagged `backup_now` and the id in option `backwpup_backup_now_job_id`, written together (V139) | `src/Cli/Commands/Job.php:124`; `src/Jobs/Frontend/API/Rest.php:80`; `parts/backups/next-scheduled-backup.php:37`; `src/Abilities/Jobs/RunJob.php:408-440` | "N backup jobs" means the same in UI and CLI; `scheduledJobs()` filters `tempjob` and `backup_now`. |
| V24 | Completing onboarding starts a real backup on a page of its own: a native POST → `save_post_form()` → `wp_safe_redirect(page=backwpupfirstbackup)`, whose script posts `startbackup` and reloads into a progress view; `#first-congratulations` appears when the run ends, success or failure | `assets/js/backwpup-admin.js:1882`, `:2387-2398`; `inc/class-page-onboarding.php:192`; `assets/js/backwpup-generate.js:44-56` | A scenario that finishes onboarding waits for that run (how: V27): the dashboard re-renders job cards mid-run, and the `@plugin` teardown uninstalls at once. |
| V25 | The default table selection is prefix-scoped, and the screen and the job differ: `select-tables.php` ticks a table whose name contains `$wpdb->prefix` (`strstr`), while a new job's `dbdumpexclude` excludes one that does not start with it (`strncmp`). So `legacy_wp_posts` is ticked on screen but excluded from the job | `parts/sidebar/select-tables.php:30-45`; `inc/class-jobtype-dbdump.php:45-58` | The baseline's "all tables selected" holds only on a database holding nothing else. The screen assertion uses contains, with the prefix from `wp db prefix`, never `wp_`. |
| V26 | `backwpup_onboarding` is written lazily: activation is deferred to `init` (`BackWPup_Install::activate`), so the flag appears on the first request that loads the active plugin, not during `wp plugin install --activate`; the redirect runs on `admin_init` of that same request | `src/Plugin/Plugin.php:117-122`; `inc/class-install.php:48`; `inc/class-migrate.php:143`; `inc/class-admin.php:267-282` | Assert the flag after observing the redirect. The race this opens: V46, V122. |
| V27 | The first backup is guarded by site transient `backwpup_first_backup`: the first `startbackup` with `first_backup=1` sets it, later ones get `{status: 301, url: page=backwpup}`. The page posts, then reloads 0.5 s later: a job still running shows progress and later `#first-congratulations`; a job already finished posts `startbackup` again and is redirected to the dashboard, having shown nothing | `src/Backups/API/Rest.php:335-352`; V24's JS; reproduced live | `#first-congratulations` is no completion signal. Poll WP-CLI until the archive is in the history, then a blocking `wp backwpup status`; `FirstBackupPage` has no wait method. |
| V32 | A fresh install is not a site with no jobs: activation creates a `tempjob` placeholder, rendering onboarding two more. And `uninstall.php` wraps its whole database cleanup in `! class_exists( \BackWPup::class )`, so the footprint goes only when nothing loaded the class in that request | `inc/class-install.php:184-200`; `inc/class-page-onboarding.php:225-245`; `uninstall.php:19` | "Freshly installed" asserts the edition is installed and active and onboarding owed, never zero jobs. |
| V33 | Activation fatals when the site holds a job with a `cron` but no `type`: `Migrate::migrate()` passes the records with a `cron` key to `organize_jobs_by_type()`, whose `sort( $job['type'] )` throws `TypeError` on `null`; every later WP-CLI call booting the active plugin dies the same way. Onboarding writes both placeholders' settings, `cron` included, but `type` only on submit, so an abandoned onboarding leaves exactly that shape | `inc/class-migrate.php:24-25`, `:174`; live: `Uncaught TypeError: sort(): Argument #1 must be of type array, null given … in inc/class-migrate.php:174` | Report upstream: a user who abandons onboarding, then updates the plugin, hits it. In the suite only when rows survive an uninstall (V32), which 6E.0's sweep prevents; V174 is another path. |
| V39 | A seeded onboarding equals a real one. Onboarding sends three mutating requests, two of which leave a mark: `cloudsaveandtest` (FOLDER's `edit_form_post_save([FIRST_JOB_ID])`) and the form POST to `save_post_form()`, which reads three of the keys sent; `updatejob` with an empty `storage_destinations[]` is overwritten by the submit. Both routes from one fresh install, per job-contents variant: `wp backwpup job` byte-identical down to the id; the stored jobs identical but for the per-install `backwpup_cfg_hash` (inside `backupdir`, `dbdumpdbpassword`) and, on the placeholder, a completed run's `lastrun`, `logfile`, `backup_ids`. Only on the real side: four options any admin visit writes (rating, licence, message queue); the placeholder's cron event appears on either side by timing (activation re-schedules every active job) | The browser's requests recorded; the state diffed | `completeOnboarding()` calls the product's two entry points rather than writing job records, so the plugin keeps owning the schema, the cron registration and the placeholder cleanup; job ids follow the page's rule (`$first + 1`, `$first + 2`). The save reads no archive format: onboarding always makes `.tar` (V190). |
| V46 | `wp plugin install --activate` does not fire `init`, and BackWPup defers `BackWPup_Install::activate()` to it, so `backwpup_version`, `backwpup_onboarding` and `backwpup_jobs` stay unset until the first request reaching `init`. With the version unset the plugin thinks a migration is due: a second request arriving before the first has written it re-runs the routine, sees the job just created and takes the upgrade path, whose first statement is `delete_site_option( 'backwpup_onboarding' )` (`BackWPup_Migrate::convert_jobs()`) | Live: all three options absent right after `install --activate` (read with `--skip-plugins`), set by the next WP-CLI call, 3 of 3. Ruled out: install → uninstall clean 5 of 5, no persistent object cache, `class_exists` false after deactivation | The mechanism; where the suite meets it and the recovery: V122. |
| V92 | A fresh install already stores one job (id 1, `tempjob`) while `job --format=count` reports 0; after onboarding the option holds two and the command reports 1 | Live, `readStoredJobs` | Empty-state and count scenarios first assert the hidden job exists, so "none listed" is not vacuous. |
| V93 | The dashboard's "add new backup" card is `POST backwpup/v1/addjob` (`type=files\|database\|mixed`). In-process, `wp_set_current_user( <administrator> )` then `rest_do_request()` creates the job with its defaults and WP-Cron event, in both editions (capability `backwpup_jobs_edit`) | `assets/js/backwpup-job.js`; `src/Jobs/API/Rest.php` (`add_job`, `has_permission`); live on both | `addBackupJob` adds jobs without the suite writing job records. |
| V122 | The suite meets V46's race in its own first request: the `@plugin` hook's active-state check (`wp plugin is-active`, plugins loaded) runs BackWPup's activation, so `backwpup_version` is written before `installPluginUnderTest` returns (3 of 3). A second request 150–450 ms behind loses the race: the flag is deleted (`convert_jobs()`), an extra job is left that is no longer a placeholder, and `activate()`'s cleanup removes the job-id options the upgrade path wrote. Two requests at once each create a placeholder and keep the flag, but every job write rewrites the whole jobs option from the request's own copy (`BackWPup_Option::update()`), so the later drops the earlier's placeholder flag, leaving a real scheduled job nobody configured. A clean install leaves exactly one placeholder (both editions) | `pro@nginx`, WordPress booted twice right after `install --activate`: 300 ms apart lost the flag 4 of 4, 150 ms 1 of 4, 450 ms 2 of 4, 600 ms 0 of 4; 0 ms kept it 18 of 18 but left two jobs 7 of 18. Real runs, retries off: ~3 % of `pro@nginx` scenarios, 2 of 22 on `free@nginx` | Report upstream: activation is re-entrant and the jobs option is written without a lock. The suite cannot hold the cron off (V44 supplies the second request), so `finishActivation` detects a lost race (not onboarding owed plus one placeholder) and reinstalls, up to three installs; three lost races in a row (a few in 100 000) still fail, clearly. It can also end in a fatal (V174). |
| V139 | Backup Now is one reused job record written by three code paths, each flagging it `backup_now` where it records its id | `src/Backups/API/Rest.php:340-349`, `src/Abilities/Jobs/RunJob.php:407-418`, `src/Cli/Commands/Run.php:211-243` | `scheduledJobs` relies on the flag (V23). |
| V174 | V122's race can end in a PHP fatal before a scenario's first step: the host's per-minute `wp-cron.php` request re-entered BackWPup's activation during the `@plugin` hook's install, met a job holding `cron` but no `type` and died in `organize_jobs_by_type()` (`sort( null )`, V33). Two paths leave that shape for a while — V122's lost update, and `convert_jobs()` writing a job's `cron` (`handle_single_job()`, L301) before its `type` (L241, L255); which one it was is not established (`create_default_jobs()` writes `type` first). The link was slow then (a `wp eval` 1.9 s against 1.3 s) | The scenario's `debug.log`: `Undefined array key "type"` (L173), the fatal at a minute boundary, stack `wp-cron.php` → `BackWPup_Install::activate()` → `BackWPup_Migrate::migrate()`; the install hook was 107 s into its 120 s | The debug-log gate fails it, rightly; retries absorb it as flaky. A slow link widens the window. Part of V122's upstream report. |

Trap: PHP iterates the jobs option in insertion order, while JSON hands a sparse array to JavaScript
as an object whose integer keys `Object.values` returns sorted. They agree only while
`BackWPup_Option::update` allocates `max + 1` (the migration's `update_job_id` does not): compare
job-id lists as sets.

Seen once on `pro@apache`, never reproduced or diagnosed: `completeOnboarding` refused a site holding
a `files and database` job beside the requested `database` one; the cell healed (V56). Likely V122's
simultaneous-request outcome, though `pro@apache` has no per-minute cron (V44).

### 2.6 Running backups: cron, contexts, size and timing

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V40 | `wp cron event run <hook>` runs every event on the hook (three at −300 s, −100 s and +8 600 s: all three ran), contrary to WP-CLI 2.12's help ("the next scheduled"); `--due-now` restricts it to due events of that hook | A throwaway hook, live | Never used: the trigger ([wordpress-automation.md → WP-Cron](../architecture/wordpress-automation.md#wp-cron-wpcronts)). |
| V41 | A BackWPup job run inside WP-CLI can die of a limit it set itself: `need_free_memory()` compares against `convert_hr_to_bytes(ini_get('memory_limit'))`, which is `-1` when unlimited, so every requirement looks larger and the plugin lowers the limit to a finite one from current usage | `inc/class-job.php:1523-1531`; live: CLI `memory_limit = -1` on `pro@nginx`, a cron run through WP-CLI died "Allowed memory size of 77594624 bytes exhausted" in `class-mysqldump.php`, then finished "with errors" after 360 s; through PHP-FPM clean in 7 s | Backups run in the web context: `spawn_cron()` for schedules, `run --background` for arranged ones. A foreground `run` is fine unless archive encryption is on (V82, V167) — or the site's data is large (V298). |
| V48 | Deleting `doing_cron` never helps (`spawn_cron()` already ignores an expired lock) and truncates a run longer than the overridable `WP_CRON_LOCK_TIMEOUT`; `wp_schedule_single_event` counts past identical events within 10 min as duplicates | WordPress 7.1: `wp-includes/cron.php`, `wp-cron.php:194`, `:201-202`, `default-constants.php:398`; the lock absent on 12 probes over 65 s | [wordpress-automation.md → WP-Cron](../architecture/wordpress-automation.md#wp-cron-wpcronts). |
| V50 | Default files jobs are as big as the docroot: they cover root, content, plugins, themes and uploads, excluding only `logs`/`usage`/`restore`/`restore_temp` at the root and cache folders under `wp-content`. `pro@nginx`'s docroot was 2.6 GB (1.9 GB `wp-content/bigFiles`), `pro@apache`'s 209 MB | `du -sh` per area, `df -h`; `inc/class-jobtype-file.php::option_defaults()` | Inspect archives where they lie (`wp/archive.ts`), never download them; prove download fidelity on the database job's archive (full SHA-256); no scenario arranges two files backups on `pro@nginx`, and the per-scenario residue sweep keeps the disk peak at one. The operator emptied the `bigFiles` folders on 2026-09-30 (a full `.tar` of `simple`: ~412 MB on 2026-10-05); the disk is shared (V162). |
| V51 | `pro@nginx`'s `DB_NAME` is `e2eSimple`, BackWPup names its dump `<DB_NAME>.sql`, and that docroot already holds a 1.5 MB `e2eSimple.sql`, so a files-only backup has a member named like a dump (`pro@apache`'s `DB_NAME`: `backwpup`) | `wp eval 'echo DB_NAME;'`; `generate_db_dump_filename()` in `inc/class-job.php` | Content assertions match a planted marker's value, never a member's name or presence. |
| V52 | GNU tar (1.35 on the cells) auto-detects compression on `-t`/`-x`; member patterns cross `/` (`*marker.txt` finds `wp-content/marker.txt`); an absent member and a damaged archive both exit 2, and a truncated archive prints only `Not found in archive` | Throwaway archives on `pro@nginx` | wordpress-automation.md's [Looking inside an archive](../architecture/wordpress-automation.md#looking-inside-an-archive-archivets). |
| V82 | A foreground `wp backwpup run <id>` runs the job inside WP-CLI and streams its log (a 39.6 MB database job in 1 s, 6.4 s wall over SSH; ~2 s on `pro@nginx`, ~1.5 s on `free@nginx`, both CLI `memory_limit = -1`); its archive is the transport user's (`ubuntu:ubuntu 664`). `--background` asks the site over HTTP and its archive is `www-data:www-data 644`. The history's `backup_trigger` tells them apart: `wp-cli` (`runcli`) or `backup_now_job` (`runnow`) | Live; `get_backup_trigger()` | Two execution contexts to cover, told apart by the trigger. Its exit code says nothing (V108); V41's memory death reaches it with archive encryption on (V167) or large rows (V298). |
| V112 | An unpaced database backup takes about a second (dispatch → `completed`: 0.9 s on `pro@nginx`, 1.1 s on `free@nginx`), less than one WP-CLI round trip (~1.3 s over SSH). "Reduce server load" (screen values 0, 10 000, 30 000, 90 000 µs) pauses once per table (V185). A files-and-database job is still archiving 6 s in | An in-site sampler (running marker, working data, newest history row, log tail every 20 ms); `parts/sidebar/settings-jobs.php` | No command sent after a start finds an unpaced database job running, so `status`, `kill` and "already running" need a paced, padded job (V187). |
| V113 | The plugin hands a long run to a fresh request midway: after any step once the request has run over 3 s (measured), and by source ~27 s into a long step (default maximum execution time 30 s); the marker holds pid 0 for ~0.3–0.4 s meanwhile. A `kill` landing then either loses the abort (`update_working_data()` returns early when the last update is under a second old, so no `end()` runs and the row stays `created`) or runs `end()` inside the `kill` process, which exits without its success line (source only). A maximum execution time of 0 ("no maximum") keeps a run in one request | pid-0 windows: `pro@nginx` 9.40→9.83 s and 6.63→7.00 s, `free@nginx` 5.87→6.20 s; one pid throughout at 0; `user_abort()`, `update_working_data()`, `start_http( 'restart' )` | Report upstream: an abort can be lost. `cli-running-job.feature` sets the limit to 0 (its label: V137). |
| V136 | A paced backup outlasts one round trip, not two: seen running 2.7–2.8 s after its start on `free@nginx`, it drops its marker at 7.6–8.1 s, where two refusals cost about 5.3 s; a refusal's check lands 0.7–1.3 s into its command. Unaborted, its archive is done 6.6–7.4 s after start; a `kill` sent at "seen running" lands at about 3.5–4 s (`pro@nginx`: 7.5 s, archive at 10.3–10.6 s) | An on-site watcher: two refusals in a row lost 1 time in 3 and won the others by 0.06 s; one refusal per job, 4 of 4 | Every scenario sends its running backup a single command. The window is now set by padding (V187). |
| V185 | A paced database backup pauses once per table, so its length is the site's table count: "Reduce server load" is a `usleep` in `update_working_data()` (honoured up to 500 000 µs; the screen offers 90 000 at most), which the dump calls once per table of `SHOW FULL TABLES`, less the job's exclusions (none for the onboarding job). `pro@apache`: 18 tables, 3.5 s; `pro@nginx`: 85 tables, 10.2 s | `inc/class-job.php` `update_working_data()`; `inc/Pro/class-jobtype-dbdump.php` `db_dump()`; `inc/class-mysqldump.php`; three runs per cell (`af1ab5c`) | The setting is already at the screen's maximum: only tables lengthen the window. |
| V186 | The command under test lands 2.3–3.2 s after the marker appears (the job is seen 0.9–1.6 s in; one WP-CLI command takes ~1.5 s more). With 18 tables `pro@apache` had 0.3–0.7 s to spare, and `cli-running-job.feature` lost there: `run {job}` and `run {job} --background` started a fresh backup at exit 0 instead of `A job is already running.`, and `kill` sometimes found nothing; the same feature passed 4 of 4 on `pro@nginx` | Timed against the server's clock; `E2E_RETRIES=0` | Any site with fewer than about 30 tables loses the race some of the time. |
| V187 | Padded to 100 tables the window is the same on both cells: 11.1 s on `pro@apache` (82 empty tables added, created in 1.8 s), 11.6 s on `pro@nginx` (15 added), the command back by 2.9 s. Playwright tears a test fixture down after every `afterEach` hook (where playwright-bdd runs `After` hooks), when the test failed too | The same sampler; a scratch Playwright test for the order | `tablePadding` pads to 100 and is removed after the `@plugin` teardown. |
| V188 | A killed run's padding outlived it: SIGKILLed once its padding existed, a `pro@nginx` run left 15 tables, which a later run of another feature kept while removing the plugin, its footprint, the staging area and the data folders. They never pile up (fixed names; every padding drops the last one first), but nothing else would drop them | Live, the process group killed the moment the site held padding | Every BackWPup worker drops leftover padding before its first scenario (`leftoverPaddingSweep`). |

### 2.7 The WP-CLI surface, and where exit 0 is not success

WP-CLI itself is honest: its refusals exit 1 (V80, V103), `WP_CLI::error()` exits 1 (all 62 calls
under `src/Cli/Commands/` exit; none passes `$exit = false`), and a PHP fatal exits 255. What exits
0 after failing is plugin code reporting it some other way: `wp eval` (V31), `--field` on an empty
list (V90), a foreground `run` (V108), `run <unknown id> --background` (V111), `status` after an
abort (V115), a destructive command without `--yes` (V126), `log-delete` on a log it may not write
(V130), V105, V107; elsewhere V146, V152, V153, V166 (§2.8), V205 (§2.9), V230 (§2.10). A row not
measured live says so.

Decision: `Then the command succeeds` asserts the exit code alone, and from 6F.2 on every use is
paired with a second source. Also requiring no `Error:`/`Warning:` notice was rejected: a foreground
`run` prints no status line at all (V108), and the check would trip on PHP warnings a cell prints
with the same prefix.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V3 | WP-CLI exists in Free too. The canonical job command is `wp backwpup job` (singular); 16 of 17 commands also register an `@alias`, all working (`jobs`, `backups`, `abort` for `kill`, …; `version` has none). 17 commands in Pro, 12 in Free: `backup`, `backup-delete`, `backup-download`, `job`, `job-activate`, `kill`, `log`, `log-delete`, `log-show`, `run`, `status`, `version` | `src/Cli/Commands/` (17 commands + the `Command.php` base); `Subscriber.php:49` registers `backwpup <name>`; `@alias` tags (`Job.php:89`, `Backup.php:101`, `Kill.php:45`); live: `jobs`/`backups --format=count` exit 0; aliases re-read in both editions at `f1ebfd0` | CLI scenarios are untagged and target canonical names; never assert an alias is unregistered (the baseline's `jobs` was not broken). One scenario proves `jobs`/`backups` still resolve. |
| V4 | Pro-only CLI is exactly `restore`, `backup-encrypt`, `backup-decrypt`, `job-export`, `job-import` | `comm -13` of both editions' `src/Cli/Commands/`; re-confirmed at `f1ebfd0` | The genuine `@pro` CLI scenarios. |
| V5 | `backup --format=json` fields: `name`, `time`, `size`, `storage`, `type`; optional `folder`, `file`, `job_id`, `size_bytes`, `time_unix`. `job --format=json`: `job_id`, `name`, `active_type`, `type`, `storages`, `cron`, `last_run`, `last_runtime`; optional `backup_type`, `archive_format`, `legacy`, `archive_encryption`, `email_address_for_logs`, `email_on_errors_only` | `Backup.php:63-75`, `Job.php:89-104` (`AVAILABLE FIELDS`) | Structured ground truth instead of DOM scraping; assert on `size_bytes`/`time_unix`, not the humanised fields. |
| V31 | `wp eval` exits 0 whatever the PHP did: a denied `file_put_contents` returns `false` with a warning and WP-CLI reports success | Live, against a decoy `www-data` file: `bool(false)`, `Permission denied`, exit 0 | Snippets report their own outcome (`evalPhp`). |
| V80 | `wp backwpup --help` prints the registered set (V3) as a parseable `SUBCOMMANDS` block; an unknown name fails `'<name>' is not a registered subcommand of 'backwpup'`, exit 1 | Live; 17 command files and the `Command` interface | The registration probe parses it, so a renamed command fails as unregistered, not as an empty list. |
| V81 | `wp backwpup status` is a blocking follower. Idle: `Success: No job running.`, exit 0. While a job runs it loops until the running file goes, then reads the log header: exit 1 on errors, 0 on warnings or a clean run; a run aborted under it reads `Job finished.` (V115) | `src/Cli/Commands/Status.php` | Never polled; it needs a budget of its own. |
| V83 | `wp backwpup kill`: idle, `Success: Nothing to abort.`, exit 0. Against a running job the marker goes at once and the run notices within ~1 s, logs `Backup aborted!` and ends: history row `aborted`, log 0 errors and 2 warnings (the abort and the "finished with warnings" summary it causes), no archive. The row still reads `created` for ~0.4–1 s after `kill` | 7 aborts of paced database and files-and-database jobs, both nginx cells | The verdict is warnings, not errors. "Nothing is running" is not "it has ended": wait for the row to leave `created`, as the dashboard's `job-abort-status` poll does. An abort can be lost in a handover (V113). |
| V84 | `backup-delete`'s refusal depends on who wrote the archive: one the transport's user wrote is deleted; one the web server wrote is refused (`Could not delete backup archive "…", check permissions!`, exit 1) and kept. It is the plugin's own writability check: the directory is `0777` | Live, both directions (`ubuntu 664` deleted, `www-data 644` refused) | Both are user situations; 6F.3 covers both, and no cleanup may rely on this command. Logs differ (V123); an encrypt hands the archive to WP-CLI (V154). |
| V87 | Empty states answer, they do not fail: on a fresh install `job` and `backup` give `0` / `[]` at exit 0, and `log` prints `No logs found.` (plain text, exit 0, not JSON). The hidden jobs are excluded (V23), so a freshly onboarded site counts 0 until a real job exists | Live; `Job.php`, `inc/class-install.php` | The baseline's counts port unchanged; `NO_LOGS` is a pinned contract. |
| V88 | `job` and `backup` share one read surface: `--format=table\|json\|csv\|yaml\|count\|ids`, `--field=`, `--fields=`, and `--<field>=<value>` (case-insensitive substring). An unknown `--field` exits 1 `Invalid field: <name>` (but V90). `log` differs (V91) | Live: `--type=dbdump` → 1, `--type=file` → 0 on a database job | One step vocabulary covers both. |
| V90 | `--field=<unknown>` fails only on a non-empty list: `if ( ! $items ) { return; }` precedes the validation, so with no jobs it exits 0 in silence (the same guard in `Backup.php:188-190`) | `src/Cli/Commands/Job.php`; live, both ways | Arrange a job before asserting the refusal. |
| V91 | `log` is its own surface: `--fields=`, `--format=table\|csv\|json\|yaml\|count` and its own filters (`--search`, `--job_id`, `--type`, `--after`, `--before`, `--orderby`, `--order`, `--limit`); no `--field=`, `--format=ids` or `--<field>=<value>`, which WP-CLI rejects from the synopsis before the command runs (`unknown --field parameter`, on two lines, V103; `Invalid value specified for 'format'`) | `src/Cli/Commands/Log.php` (`## OPTIONS`); live | Covered apart from `job` and `backup`. |
| V94 | `wp backwpup <name> --help` dispatches without running: on Pro each Pro-only command answers exit 0 with its help (no pager over `ssh`); on Free all five exit 1 `'<name>' is not a registered subcommand of 'backwpup'.` | Live, both editions | Proves the edition split by behaviour; the only safe probe of `restore`, whose `<file>` is optional. |
| V95 | `backup` attributes an archive to the last job that listed it: it walks every non-`tempjob` job's folder and keys `$items` by the archive's timestamp, so jobs sharing a folder overwrite the attribution and two archives of one second collapse into one row | `src/Cli/Commands/Backup.php`; live: job 3's one archive reported as job 5 | Never assert `backup`'s `job_id` on a site with more than one job. |
| V97 | WP-CLI honours global parameters anywhere on the line, after the subcommand too (`--path=` moved the command, `--skip-plugins` unloaded BackWPup); no BackWPup option shares a global's name but `version`'s `--debug` | Live; the site's `GLOBAL PARAMETERS` | Command text from a scenario refuses the globals deciding where, as whom or with what code it runs (`--path`, `--url`, `--ssh`, `--http`, `--user`, `--skip-*`, `--require`, `--exec`, `--context`, `--prompt`) and keeps presentation ones; on a shared host (V162) a stray `--path` reaches another site. |
| V98 | WP-CLI's formatter validates `--fields` itself: `job --fields=job_id,nope --format=json` exits 1 `Invalid field: nope.` (with a period; `--field`'s refusal is the plugin's, without) | Live | Exact-keys assertions are sound; match the refusal by substring. |
| V99 | The history table `wp_bwpup_backups` is an independent record: one row per destination, written by the run (`backwpup_create_job` → `add_backup_row`, `created` → `completed`), with `filename`, `job_id`, `status`, `backup_trigger` and `logfile` (V129). `$wpdb` returns every column as a string, and a failed query (a missing table) as an empty result, the error only in `last_error` | `src/Backup/Database.php`, `src/Backup/Subscriber.php`; live, with and without the table | Archive and trigger assertions read the history, never the same command in another format. A `$wpdb` reader must check `last_error`, or a failure reads as "nothing there". |
| V100 | `log` reads any header value it cannot find as 0 (`(int) ( $hdr[…] ?? 0 )` for `errors`, `warnings`, `job_id`), so an unparseable header reports a clean run | `src/Cli/Helpers/CommandsLogHelpersTrait.php::read_log_header` | Assert the header's `job_id` (0 is no job's) as the witness it was read. |
| V103 | WP-CLI's refusals can span lines: `Error: Parameter errors:`, then one line per parameter (` unknown --nope parameter`), sometimes an unindented `Did you mean '--format'?`. BackWPup's own notices are single-line | WP-CLI 2.12.0 on the cells; `Dispatcher/Subcommand.php` (`"\n {$error}"`); no newline in any `WP_CLI::error\|warning\|success` under `src/Cli/Commands/` | On stderr a line that is not a status line continues the notice above; stdout stays line by line. |
| V105 | A `restore` that fails after its archive is resolved exits 0: everything after sits in `catch ( \Throwable )`, printing `Warning: Restore failed: …`; with a pre-backup snapshot it then offers a rollback and may end `Success: Rollback completed.` Only a bad archive argument (`:132-135`) or a failed rollback exits 1 | `src/Cli/Commands/Restore.php:210-223`, source only | Judge a CLI restore by its markers; a failure scenario asserts the warning and the still-changed marker. |
| V107 | `BackWPup_Job::start_cli()` stops with `exit( 'message' )` — printed, exit 0, no `Error:` — for an unknown job id, a log or temp folder failing `check_folder`, and a job already running. From `run`, the folder checks stay reachable, and a job the site's cron starts between `run`'s own check and `start_cli` | `inc/class-job.php:3070-3098`, source only; PHP 8.1 measured locally: `exit("…")` exits 0, an uncaught fatal 255 | No exit-code or status-line check catches it; only a second source does (a new history row, a log). |
| V108 | A foreground `run` never reaches its own verdict: the job ends in `end()`, whose last statement is `exit()`, so nothing after `start_cli` in `Run.php` runs; it exits 0 with the job's log on stdout and no status line, nor `Job runs successfully.` (last line `Job done in 0 seconds.`). The unreachable verdict also tests warnings first, so `There are N errors…` needs a run with no warnings, and prints `Warning: There are %d wearings due to job execution please chack the logs.` | Both cells; `inc/class-job.php` `end()`, `do_restart()` ("Unreachable: end() always exit()s"); `Run.php:182-192` | Report upstream. Judge a foreground run by its history row and its log. |
| V110 | `run`'s refusals, exit 1: no argument → `No job ID(s) or pram specified!`; `--background` with several ids → `Background job run not works with more than one job_id!` (decided on the count first); an unknown id in the foreground → `Job ID does not exist!`, also for the hidden first-backup placeholder; while a job runs, both forms → `A job is already running.`, checked before the arguments | Both cells; `src/Cli/Commands/Run.php` | Pinned by two scenarios; V107's `Wrong BackWPup JobID` is unreachable from `run`. |
| V111 | `run <unknown id> --background` prints `Success: Job "" runs now in background.` at exit 0 (the name is `BackWPup_Option::get( <id>, 'name' )`, `null`); `start_http()` then drops the request: no log, no history row, nothing runs | `pro@nginx`: counts unchanged, nothing running 8 s later | Report upstream. Not pinned: it would fail the day it is fixed. |
| V115 | `status` reports `Success: Job finished.` (exit 0) for a run aborted under it: its loop ends when `kill` removes the marker, and it reads the header about a second before the job logs the abort. Watched to a natural end it is right (blocked ~6.8 s on `free@nginx`, ~9.9 s on `pro@nginx`) | `pro@nginx`: blocked 8.2 s, then `Job finished.` for an `aborted` row with 2 warnings; `Status.php` | Report upstream; not pinned. The `status` scenario watches a natural end. |
| V116 | `job-activate`: `--type=disable` → `Job with ID N deactivated`, `active_type` `none`, its WP-Cron event removed; `--type=link` → `link`, no event; no `--type` → `wpcron` and an event at the next cron time (WP-CLI applies the synopsis default; the command's own fallback, misspelt `'wp-cron'`, is dead); an unknown id or the hidden placeholder → exit 1 `No jobs found!`; a bad type → `Invalid value specified for 'type'`; no `--job_id` → every visible job | `pro@nginx`; `JobActivate.php` | Re-activating with no `--type` proves the default still arrives. |
| V123 | Logs are not archives: BackWPup writes logs through WordPress's filesystem API, which applies `FS_CHMOD_FILE` — `0777` on both cells, derived from a `0777` `index.php` with no `wp-config.php` define — while archives are written with `fopen` under PHP-FPM's umask | Logs `-rwxrwxrwx` (`ubuntu` and `www-data`), archives `ubuntu 664` / `www-data 644`; `is_writable()` as WP-CLI's user: logs 1 and 1, archives 1 and 0; `inc/class-job.php` (`put_contents`) | V84's split holds for archives only: `log-delete` removes web-written logs here. A host whose `FS_CHMOD_FILE` is `0644` would make every web-written log undeletable by WP-CLI; the refusal scenario makes a log read-only. |
| V124 | A refused `backup-delete` leaves its error queued (`BackWPup_Admin::message(…, true)`; `WP_CLI::error()` exits before the line that clears it): the next `backup-delete` deletes its own archive, then exits 1 repeating the old error. Each refusal adds a copy, which also shows on the next admin screen | Live, both cells; `backwpup_messages` held one copy, then two; `BackupDelete.php` | Report upstream; not pinned. Scenarios run one delete; a non-zero exit is no proof nothing happened. |
| V125 | `backup-delete` leaves the run's history row `completed`; the dashboard's delete (REST `delete_backup`, which fires `backwpup_after_delete_backups`) removes it. The orphan is invisible: the history lists a completed run only while a destination holds its file | Live; `src/Backups/API/Rest.php`, `src/Backup/Database.php` (`backups_list`) | Not pinned (the plugin may change it). "The oldest backup" is fixed when it is made (`ArchiveSnapshot`), never re-read after a delete. |
| V126 | Without `--yes` a destructive command only asks, and ends at exit 0 having done nothing: `backup-delete` (`Delete Backup file <name> on Folder ? [y/n]`), `backup-download` onto an existing file (`File <path> already exists. Overwrite it? [y/n]`), `log-delete` (`Delete logfile <name> ? [y/n]`) | Live: the prompt last on stdout, nothing changed | Every transport gives commands no input, so a prompt declines identically everywhere ([wordpress-automation.md → Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects)). Scenarios assert the prompt, exit 0 and the untouched file. |
| V127 | `backup-download` resolves a relative destination against WP-CLI's working directory (the WordPress root; WP-CLI does not change directory), creates a missing folder, and into an existing folder writes the archive under its own name, as WP-CLI's user. A web-written archive downloads fine (WP-CLI may read what it may not delete). Its refusals, `Backup file not found.` and `Backup file not found in storage <s>.`, come before anything is created | Live, both cells: `getcwd()` is the root; SHA-256 equal; `BackupDownload.php` | Hand it a root-relative folder and read the copy back by absolute path. |
| V128 | `backup-download` to an unwritable path fatals: a silenced `fopen` returns `false`, then `fwrite( false )` throws `TypeError` (`inc/class-destination-folder-downloader.php:74`) and `__destruct` adds `fclose( false )`; exit 255, the fatal (`Uncaught TypeError: fwrite(): Argument #1 ($stream) must be of type resource, false given`) in `debug.log`; the `catch ( \RuntimeException )` meant for it cannot fire | `pro@nginx`, target `/proc/<name>.tar` | Report upstream. Never a scenario: the debug-log gate fails it, and it would pin a crash. |
| V129 | `log-show`: plain text is `wp_strip_all_tags` plus `html_entity_decode`, lines trimmed, blanks dropped. Every log names itself (`[INFO] Logfile is: …`) and its archive (`[INFO] Backup file is located at: …/<archive>`); the history records each run's log (`logfile`, absolute). The extension is optional and `--file=` equals the positional; `--job_id` picks the newest by modification time; `--lines=N` keeps the last `max( 1, (int) N )`, so `0` and `abc` print one. Refusals: `Logfile <name> not found or unreadable.`, `No logs found for the given job_id.`, `Please provide <file>, --file=<file>, or --job_id=<id>.` | `pro@nginx`, the whole matrix; `LogShow.php`, `CommandsLogHelpersTrait.php` | Name a log through the history and check what it prints against the run's own record. |
| V130 | `log-delete`: `--older-than` reads the file's modification time (`log` shows the header's time; they can differ); `strtotime( 'now - 7days' )` works, so no space is needed; `--older-than=0` reads as absent; nothing matching → `No logs match the criteria.`, exit 0. A log WP-CLI may not write → `Warning: Logfile <name> is not writable. Check permissions!`, then `Success: No logfile deleted.` (bulk: `Success: 0 logfile(s) deleted.`), exit 0. A missing name → exit 1, `Log file not found or unreadable: <name>`. Other refusals: `Provide <file>/--file, or --older-than, or --all.`, `Invalid --older-than value.` | `pro@nginx`: a log backdated ten days went with `--older-than=7days`, the fresh one stayed; a `0444` log survived a single delete and `--all`; `LogDelete.php:127`, `:177`, `delete_one` `:216-241` | Confirm deletions against the log folder itself (`log --format=count` walks it through the same helper). A refusal is the warning plus the surviving file, never the exit code. |
| V131 | `log-delete` deletes any file in the log folder: its single-file mode checks the name is readable there, not that it is a log, so `log-delete .htaccess --yes` and `log-delete index.php --yes` remove the folder's guards (`Success: 1 logfile deleted.`); `log-show .htaccess` prints the rules | `pro@nginx`; `LogDelete::resolve_filename()`, `delete_one()` | Report upstream: on Apache that `.htaccess` (`Require all denied`) keeps the logs from being served. Not pinned. |
| V132 | `--dry-run` is documented and would delete for real: the class docblock offers it and the code passes it to `delete_one( $name, $dry )`, which takes one argument. Today WP-CLI refuses it (`unknown --dry-run parameter`), the synopsis not declaring it | `LogDelete.php`; live | A latent plugin bug. The refusals scenario asserts the logs survive the attempt, so a synopsis gaining the option without the code honouring it fails it. |
| V133 | The basename hardening holds: a path from the log folder to a file outside reaches nothing (`log-show`: `Logfile <basename> not found or unreadable.`; `log-delete`: `Log file not found or unreadable: <basename>`), and the file is untouched | `pro@nginx`, a file planted under `wp-content` | Pinned: it alone stands between a user's argument and `log-delete ../../wp-config.php --yes`. The path is proved on the site first, so the refusal cannot pass for the wrong reason. |
| V135 | A relative path climbing out of a symlinked root leaves from the link's target: PHP's `getcwd()` answers the physical directory, whatever the shell's `PWD` says | A PHP 8.1 scratch tree; `DownloadFolder` end to end over a `wp eval` shim, symlinked and plain | Paths handed to WP-CLI are worked out on the site (`posix.relative(getcwd(), realpath(folder))`). |
| V138 | `log --job_id` never looks at the jobs: it keeps the log headers whose `(int) job_id` equals the one asked for | `src/Cli/Commands/Log.php:226-229` | Asking about the hidden placeholder job answers "none" whatever the command makes of the id. |

Trap: a brace placeholder no step fills reaches the plugin as text, which it reads as job `0` and
refuses exactly as a refusal scenario expects. Anything in braces is a name, refused unless filled.

### 2.8 Encryption and job transfer (Pro CLI)

Measured on `pro@nginx` at `f1ebfd0` (re-held at `af1ab5c`, V169): Pro installed and onboarded
through the suite's own modules (one database job, `.tar`), WordPress 7.1.2, PHP 8.3.33 (CLI); each
archive's SHA-256 read before anything touched it; secrets compared on the site, never printed.
V146's coercion and V149's exception class were also reproduced locally (PHP 8.1).

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V146 | `backup-encrypt` without `--key`, on a site whose encryption settings were never saved, destroys the archive and reports success. It reads `backwpup_cfg_encryption` with no default (`false`) and takes the RSA branch with `backwpup_cfg_publickey`, also `false`, which its non-strict file hands to `EncryptionStream` as `''`; the stream falls back to AES under the `Random::string( 32 )` key the command generated and never keeps. It prints `Asymmetric encryption will be used for the archive.`, then `Success: Archive has been successfully encrypted.` | Live, twice: exit 0; header `BACKWPUP`, version 2, type 1 (symmetric), +26 bytes; no option changed; `backup-decrypt` then refuses with and without a key. This call is the command's own first help example; `BackupEncrypt.php` | Report upstream first: a success that loses the backup. No scenario sends it; the settings path is covered with the settings saved (V148). Jobs share the fallback (V166). |
| V147 | The symmetric round trip. `--key=<hex>` is read before any settings lookup. A key of 32, 48 or 64 hex characters (AES-128/192/256) encrypts in place, under the same name: `Symmetric encryption will be used for the archive.`, exit 0, header `BACKWPUP`, version 2, type 1, a 16-byte IV (+26 bytes, plus up to 15 of padding when the size is not a multiple of 16); tar no longer reads it (`This does not look like a tar archive`); `backup` lists it under its name with the new size. `backup-decrypt` with the same key restores it byte for byte and leaves no temporary file. The archive is a path relative to WP-CLI's working directory (the root) or absolute; a bare name is `Archive file that should be encrypted can't be found!` (`…decrypted can't be found!`) | Live: 42 284 544 → 42 284 570 → 42 284 544 bytes, SHA-256 equal; the same through `wp-content/uploads/backwpup/<hash>/backups/<archive>`; 32- and 48-hex round trips | Assert by digest, with the header and "not a tar" as the witness. The placeholder is the archive's path from WP-CLI's working directory (V135), not its name. Odd key lengths: V172. |
| V148 | The settings path and RSA key files round-trip too. With `backwpup_cfg_encryption = symmetric` and a saved `backwpup_cfg_encryptionkey`, both commands work without `--key`. `--key=<file>` switches both to RSA: a public key (PEM, SPKI) → `Asymmetric…`, type 2, +284 bytes for RSA-2048; the private key (PKCS#8) restores byte for byte; a key file relative to WP-CLI's working directory works too. Decrypting with the public key → `Cannot decrypt: The key that was loaded was not a private key`; with a hex key → `Cannot decrypt: Unable to read key` | Live, no temporary file left, the settings removed afterwards; relative key files at `af1ab5c` | None needs storage credentials; the `backwpup_cfg_*` options fall under the footprint sweep. |
| V149 | A hex key that packs to a size other than 16, 24 or 32 bytes (4, 40 or 33 characters) crashes `backup-encrypt` at exit 1, not the 255 the source suggested: `EncryptionStream`'s check (`!$key && strlen( $key ) !== 32`) fires only on an empty key, so phpseclib's `AES::setKey()` throws `LengthException`, which the command's `catch ( \InvalidArgumentException )` misses; WordPress's handler prints `Error: There has been a critical error on this website.` The fatal lands in `debug.log`, the archive is untouched, and an empty `<archive>.encrypted` is left beside it (opened before the key is used), which the next successful encrypt appends to and removes | Live; the class reproduced locally | Report upstream. Never a scenario (it would pin a crash, as V128). |
| V150 | A wrong-length key on decrypt is caught (`Cannot decrypt: Key of size 2 not supported by this algorithm. Only keys of sizes 16, 24 or 32 supported`, exit 1, archive unchanged) but leaves an empty `<archive>.decrypted`: the exception path skips the cleanup the wrong-key path does. The next decrypt removes it | Live, `--key=abcd` | A refusal that writes; V151 is the one to cover. |
| V151 | A wrong key of the right length is refused and the encrypted archive survives byte for byte: the decrypter writes `<archive>.decrypted` and replaces the archive only if the result lists as a valid archive, deleting it otherwise. `Archive could not be decrypted. Maybe wrong key!`, exit 1, no temporary file, nothing in `debug.log`; the right key afterwards restores the original | Live; `vendor/inpsyde/backwpup-restore-shared/src/Api/Module/Decryption/Decrypter.php` (`test()`, then `unlink` and `rename`) | The refusal that guards the only copy of a backup. |
| V152 | Encrypting twice is not refused, and the plugin cannot undo it: both runs exit 0 with `Success:`; decrypting with the right key then answers `Maybe wrong key!` every time, the first layer's plaintext being itself encrypted and failing the archive check | 42 285 568 → 42 285 594 → 42 285 626 bytes; two refused decrypts | Report upstream (encrypt could ask `isEncrypted()`, as decrypt does). No scenario encrypts twice. |
| V153 | Decrypt strips padding encrypt never added: encrypt pads only a size that is not a multiple of 16, but decrypt always drops the last N bytes when the final byte N is 1–16. A valid 17 440-byte single-member `.tar.gz` ending in `0x01` came back a byte short under `Success: Archive has been successfully decrypted.` (`gzip -t`: `unexpected end of file`). The plugin's own archives all end in `0x00`: a `.tar` in its 1 024-byte end-of-archive; a `.tar.gz` too, each write being its own gzip member and the end-of-archive the last; a `.zip` in an end-of-central-directory record with an empty comment | A crafted file through both commands; a real `.tar.gz` (4 744 688 bytes) and a real `.zip`, byte for byte; `inc/class-create-archive.php` (`fwrite()` → `gzencode()`, `close()` → `pack( 'a1024', '' )`) | Report upstream, for files it did not make (`backup-encrypt` takes any path). The digest assertion would catch a format change. Large plugin-made `.tar.gz` archives are safe. |
| V154 | An archive the web server wrote (`www-data 644`, not writable by WP-CLI) encrypts and decrypts all the same in the `0777` folder, and comes back `ubuntu 664` | Live, `startJobInBackground`; `is_writable()` 0 before, 1 after | No ownership split to cover (unlike V84); after an encrypt, a previously refused `backup-delete` would succeed. |
| V155 | Encrypt and decrypt refusals, all exit 1, the archive unchanged, no temporary file: `--key=xyz`, `--key=` and the help's own example key `ABCDEFGHIJKLMNOPQRSTUVWXYZ123456` → `Key must be a string of hexadecimal characters!`; a missing file → `Archive file that should be encrypted can't be found!` / `…decrypted can't be found!`; a plain archive → `Archive not needs decryption.`; decrypt with no key on an unconfigured site → `No Key provided or stored in settings for decryption!`; no argument → WP-CLI's `usage:` line, no status line | Live | Report upstream: the help's example key is refused (a docs bug). |
| V156 | `job-export` writes all jobs as a JSON object keyed by the jobs option's own index (`"2"`, `"3"` for jobs 3 and 4), one job the same way under one key. `--file` resolves against WP-CLI's working directory, written as WP-CLI's user (`664`); a missing folder → a PHP warning (also in `debug.log`), then `Error: Could not write to file.`, exit 1. It leaves a setting out only when it is one of nine stripped keys, an empty string or an encrypted value (`dbdumpdbpassword`) — 43 of 136 keys — and every value it carries equals the stored one. An unknown id, the hidden placeholder or no jobs → `[]` at exit 0, not the `Nothing to export!` its source suggests; with `--file`, `[]` is written under `Success: Job exported successfully.` | Live, key by key against the stored record; `src/Cli/Commands/JobExport.php` L88–L109 | Judge an export against the stored job both ways, or one carrying only its job's id passes; "nothing to export" is an empty list, not an error. |
| V157 | `--passwords` writes the site's database password in clear. Every job stores `dbdumpdbpassword`, the site's own `DB_PASSWORD` encrypted — the hidden placeholder and `defaults_job()` included, even with "use WordPress's database settings" on. Without the flag the key is left out; with it the file and stdout carry the plaintext. An export always carries the database host, name and user | Live: all six jobs and the default decrypt to `DB_PASSWORD`, compared on the site; `inc/Pro/class-jobtype-dbdump.php` L29 | An export is a credentials-bearing file: written only into the scenario's private folder and removed. `--passwords` is not covered (also V163). |
| V158 | `job-import` without `--job_id` appends a faithful, unscheduled copy: the new job takes `max( ids ) + 1` (`Success: Job "Database" with ID 5 imported successfully.`) and equals the original on every key but the id, `activ` (`false`), `activetype` (`''`, so no `backwpup_cron` event), the run history (`lastrun`, `lastruntime`, `backup_ids` absent; `logfile`, `lastbackupdownloadurl` empty) and `dbdumpdbpassword` (taken from `defaults_job()`, so the site's own, V157). Keys dropped as empty come back `''`; the original and its schedule are untouched. A `--job_id` the file holds but the site does not appends too, under a new id (77 → 6) | Live, key by key; `src/Cli/Commands/JobImport.php` | Assert the copy against the original's stored record, the new id, the missing schedule and the untouched original, never the success line. |
| V159 | `job-import --job_id=<n>` merges, it does not replace: only the keys the file carries are written over job n. After renaming job 3, switching it to `.zip` and filling `fileexclude` (empty at export, so absent from the file), the import restored the name and format and kept `fileexclude`; `activetype`, the cron event, `lastrun` and `logfile` untouched; no job added | Live | The overwrite scenario must change an exported field between export and import (V164). |
| V160 | `job-import` refusals, all exit 1 with the jobs option byte for byte: no argument or a missing path (positional or `--file`) → `No file provided or file can't be found!`; non-JSON, and `[]` (the empty export) → `File is not a valid JSON file!`; `{"a":1}` or a job whose `type` is not a list → `File is not a valid BackWPup job export file!`; `{}` and `42` add PHP warnings (in `debug.log`) before `No job with ID 0 found!`; a `--job_id` the file lacks → `No job with ID <n> found!`, even when the site has that job. But each job is validated inside the loop that writes it: `[<valid job>, {"jobid":"x"}]` imports the first (`… with ID 7 imported successfully.`), then refuses at exit 1, and job 7 stays | Live, the option's digest before and after each; `--job_id=999` again at `af1ab5c` | Refusal scenarios use one-job or non-job files and assert the jobs unchanged. Report upstream: the partial import; not pinned. |
| V163 | `job-import` stores a `--passwords` export's secrets in clear: the copy's `dbdumpdbpassword` is `DB_PASSWORD` itself, not `$BackWPup$…`, verbatim in the `backwpup_jobs` row. Nothing breaks, because `BackWPup_Encryption::decrypt()` returns an unprefixed value unchanged, which hides it | Live: absent from the row before the import, present after, gone once the copy was deleted; `JobImport.php` L94, L116 write values as given; `JobExport.php` L103–L105 decrypted them | Report upstream (security). A second reason `--passwords` stays untested. |
| V164 | An edited export drives the overwrite, and the job keeps its schedule: export job 3, rename it in the file (decoded and re-encoded on the site; the index-keyed object stays an object), `job-import <file> --job_id=3` → `Success: Job "Renamed by the import" with ID 3 imported successfully.`; job 3 takes the name, no job is added, `activetype`, `activ` and its `backwpup_cron` event unchanged, every key the file carries equal to the file | Live | The overwrite scenario edits the file, as a user migrating jobs does; the kept schedule makes V159's merge observable. |
| V165 | Saving the Encryption panel stores the type (`symmetric`/`asymmetric`) and `backwpup_archiveencryption` (the panel's "encryption activated"), then the symmetric key (hex, cut to 64 characters) and the public key, each only when given. `backwpup_archiveencryption` makes every job encrypt its archive; stored off, a job's backup is plain and both commands round-trip without `--key` | `inc/Pro/Settings/EncryptionSettingUpdater.php`; `inc/class-job.php` L515; a live round trip | The settings scenario stores archive encryption off (else the Background's backup arrives encrypted and the scenario's encrypt is V152's second layer) and never turns it on (V166, V167). |
| V166 | The jobs' own archive encryption shares V146's fallback: with archive encryption on and the type saved as `asymmetric` without a public key (the handler requires none), a run completes at exit 0 logging `Encrypted 40.38 MB of data.` and `Archive has been successfully encrypted.`; the archive is version 2, type 1, +26 bytes, `backup-decrypt` refuses it with and without a key, and no option holds a key. With no type saved, the run logs `No encryption key was provided. Aborting encryption.` and keeps a plain archive | Two fresh installs; `inc/class-job.php` L2625–L2632, L2675–L2683, no `strict_types`; the panel marks no field required (its JavaScript not traced) | Report upstream with V146: every scheduled backup made in that state is unrecoverable and reported as encrypted. No scenario turns archive encryption on. |
| V167 | With archive encryption on, a foreground run can die against a memory limit the job set itself: CLI `memory_limit = -1` makes `WP_MAX_MEMORY_LIMIT` `-1`; the job sets that, then `need_free_memory( '10M' )`, called on every progress update, reads `-1` as a number and lowers the limit to usage + ~11 MB (V41). 4 of 8 such runs failed (3 × `Allowed memory size of 79691776 bytes exhausted (tried to allocate 3858872 bytes)` in `inc/class-mysqldump.php` L760, 1 at exit 255), a valid symmetric key included; 0 of 19 with it off; 3 of 6 at `af1ab5c`. Each crash left its row `created` and the running marker until `kill` | Three fresh installs; `inc/class-job.php` L1471, L1523–L1531, L1541–L1553, L2214–L2222. Why encryption raises the odds is not isolated: the fatal is in the dump, before any encryption | Report upstream. The foreground Givens are safe while nothing turns archive encryption on — and the cell's limit is finite (V298). |
| V172 | Both commands turn a hex key into bytes with `pack( 'H*' )`, which completes an odd digit count with a `0`: 31, 47 and 63 characters give 16, 24 and 32 bytes and round-trip, and the key plus a `0` decrypts too. A count packing to another size (33 characters → 17 bytes) crashes `backup-encrypt` as in V149 | Live, each length twice; the plugin's classes locally | "32, 48 or 64 hex characters" is the suite's choice (`support/encryption-keys.ts`), not the plugin's rule. |

### 2.9 Restore

V189–V192 are source at `af1ab5c`, every file byte-identical in Free and Pro. V194–V207 were measured
on `simple` at `a612005` (2026-10-05): a fresh install, the plugin's own onboarding seeding, a real
~412 MB `.tar` backup and its restore in the browser (headless) and over WP-CLI, the two markers
changed after every backup; Free from the Free build of the same commit. What the CLI rounds broke
was repaired with the user's approval (V205).

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V189 | The restore screen offers only the strategies the archive can serve, read from the backup's `manifest.json` job types: Database Only needs `DBDUMP`, Files Only any other type, Full Restore both. Onboarding's files job is `FILE` + `WPPLUGIN`, its database job `DBDUMP` | `views/restore/steps/step2_action.php:12-56`; vendored `backwpup-restore-shared` `…/Manifest/ManifestFile.php:183-198`; `inc/class-page-onboarding.php:12,19` | Files-only and database-only backups are journeys of their own, each asserting the strategies it is offered; held live (V199). |
| V190 | Three archive formats: `.tar` (the default), `.tar.gz`, `.zip`. Any other value falls back to `.tar`. `.tar.bz2` is no longer offered: a stored one reads back as `.tar.gz`, and the restore refuses bzip2 outright | `inc/class-install.php:15-22`; `inc/class-admin.php:902-907`; `inc/class-option.php:392`; `Decompressor.php:387-396`; `src/Cli/Commands/Restore.php:17` | Onboarding makes only `.tar` (V39), so a `.zip` or `.tar.gz` backup needs the job's format switched after onboarding, and the made archive's extension checked, or a fallback passes as a `.tar` restore (6K). `.tar.bz2` is out of scope. |
| V191 | Each format has its own extractor, and the UI and CLI do not share them. UI: `.tar` → `PharData`, `.tar.gz` → PEAR `Archive_Tar`, `.zip` → its own file-by-file extractor with progress events. CLI: `.zip` → `ZipArchive`, `.tar.gz` → `PharData::decompress` then extract, `.tar` → `PharData`. The extractor is chosen by extension, never by contents | `Decompressor.php:244-311,379-402`; `src/Cli/Helpers/CommandsRestoreHelpersTrait.php:50-100` | A `.tar` restore proves nothing about the other two, in either entry path. 6K restores mixed backups only, in both formats and both entries. |
| V192 | CLI `restore --type=full\|db\|file` is the UI screen's strategy choice, defaulting to `full` | `src/Cli/Commands/Restore.php:90-94` | Held live (V204). |
| V194 | The restore working directory is `uploads/backwpup-restore-<20 hex>`, its name in `backwpup_restore_dir_token`, drawn on first need, and only the user who creates it first may write it. WP-CLI first: on Pro, `wp backwpup backup` reaches `restore_registry()` through Pro's folder destination as the transport's user (`ubuntu:ubuntu 0775`, `restore.dat 0664`), and the next admin page listing backups dies on an uncaught `FileSystemException` ("Restore working directory … is not writable, protection files cannot be created"), HTTP 500. Web server first (`www-data`, `0755`): a later WP-CLI command dies on "Restore working directory … is not writable" — Pro's `wp backwpup backup`, and on Free a `cli-reads` scenario's first attempt (path not investigated), so neither edition is safe | `commons.php` `restore_dir_name()`, `ensure_uploads_folder_protected()`; `WorkingDirectoryProtector::protect()`; reproduced on the history page; the other direction live on the orchestrator's cells (the orchestrator plan's V269) | Report upstream: a regression (`af1ab5c` only failed softly). The suite prepares the directory after every install from `restore_dir_name()` (`ProductConfig.resolveSiteDataDirs`). |
| V195 | Prepared, the directory still fails the wizard once WP-CLI has written `restore.dat` in it: a listing recreates `restore.dat` (`ubuntu 0664`) whenever the last restore's cleanup removed it, and every wizard request then dies on "Could not write Registry file" after its stream has started — the stream ends, `EventSource` reconnects every ~3.5 s for ever, the page stuck on step 1 (V220) | The `download` stream failing every ~3.5 s, `restore.dat` owned by `ubuntu`; after `normalizeOwnership` on the directory the same backup restored | Hand the directory to the site before a UI restore (`handRestoreWorkingDirToSite`). |
| V196 | Each install draws a new restore-directory name, so a literal residue path (`uploads/backwpup-restore`) matches none of them. A files backup also captures the staging area (`.e2e_temp/plugins/<zip>`) and the restore directory's protection files | A listing after setup; the archive's members | Residue families (V209). |
| V197 | Pro's deep link names the archive twice and has the server fetch it: `file` is the archive in `uploads/backwpup/<hash>/backups/`, `restore_file` its slot in the restore directory's `uploads/`, `service=folder`; the click adds `step=1&trigger_download=1&_wpnonce`, the server copies (`download`) and unpacks it, and the dropzone is hidden. 412 MB: step 1 → 2 in 5 s | The runs' URLs; `controller.js` `triggerDownloadByUrlQuery` | `restore_file` is not the archive in place. The entry assertion checks both names, `trigger_download=1` and the hidden dropzone. |
| V198 | The wizard is six page loads: 2 strategies → 3 database connection → 4 URL migration (Pro only: `migrate_allowed = is_pro()`) → 5 Start → 6 report; Files Only goes 2 → 5, Free 3 → 5. Step 3 renders `DB_PASSWORD` into `#db_pw`'s `value`. Step 6 shows "Success", or "Restore Report" when the restore log holds errors (where its `count( $message )` on a string would `TypeError` — source only). Files took 21 s, the database 7–9 s | `views/restore/steps/*`, `TemplateLoader::createBindFromStep()` | `restoreWith` follows the URL step by step and asserts "Success". Traces carry the database password (AGENTS.md). |
| V199 | V189 holds live: a mixed backup offers all three strategies, a database-only one (`["DBDUMP"]`) only Database Only, a files-only one (`["FILE","WPPLUGIN"]`) only Files Only; each partial restore restores its half and leaves the other as changed | Four restores | 6G's contents and strategy scenarios. |
| V200 | A database restore keeps the admin session only if the login predates the backup (the restored `session_tokens` know it); a login made after it lands on `wp-login.php?reauth=1` at step 6 (`login_user_again()` skips the cookie once headers are sent) | A login after the backup, against four before | The suite's login precedes every scenario's backup, so no re-authentication; the page object names the cause if the session is lost. |
| V201 | A restore puts back the `debug.log` its archive holds: fatals logged between a backup and its full restore were gone after it | `grep -c Fatal` before and after | The restore steps judge the log so far before restoring (`checkDebugLog`); V222. |
| V202 | After a database restore the backup's own run is "in progress" again (the dump was taken mid-run) and the history lists no backup | The history; the teardown's stop report | Reported by the teardown, not failed; nothing to stop. |
| V203 | Free re-uploads through the browser: the row's action is the bare `page=backwpuprestore`; the history download took 27.6 s for 411 MB, the upload (plupload, 2 MB chunks) 168 s; then the same wizard, 3 → 5 | The Free run | One `@free` scenario, budgeted for the upload (6I.1 adds four). |
| V204 | `wp backwpup restore … --yes --type=db\|file\|full`: exit 0, `Success: Restore completed successfully.`, in 9.9 / 7.1 / 12.7 s; each type restored its half only; its workspace `/tmp/backwpup-restore-<uniqid>` is removed | The CLI rounds | V192 holds; the CLI scenarios assert by the markers. |
| V205 | A files restore replaces `wp-content` wholesale and deletes what its archive lacks: it empties `wp-content` but `plugins/backwpup*`, then copies the archive's tree back as the transport's user (16 273 entries `ubuntu`, files `0664`). Lost for good: empty directories, a `.donotbackup` folder and the files the job's default exclusions skip (`.git*`, `.tmp`) — 20 entries of the site and two other plugins | The trees before and after; repaired from the plugins' wordpress.org zips | Report upstream: a restore deletes data it never backed up. A CLI restore runs behind a root `tar` copy of `wp-content` (no sudo: not run), put back after (`cliRestore`, AGENTS.md). |
| V206 | `wp db reset` recreates the database with the server's default collation (`utf8mb4_0900_ai_ci`, against the sibling databases' `utf8mb4_general_ci`); the tables keep theirs from the dump | `information_schema.SCHEMATA` after the CLI rounds | Read before, set back after (`ALTER DATABASE`). |
| V207 | `--pre-backup` leaves its snapshot in the temp directory, never removed: `db.sql` (`0664`, readable by every local account) and a copy of `wp-content` (752 MB with the archives) under a `1777` directory. It prints `Success: Pre-backup created.` first | `/tmp/backwpup-snapshot-<uniqid>` | Report upstream. The scenario checks the snapshot holds the site as it was and removes it — only one holding its own marker, since other runs share the temp directory. |
| V208 | Release 5.7.7 (tag `850263d6`, 2026-10-05) names the restore directory the same way (`restore_dir_name()`, `RESTORE_DIR_TOKEN_PATTERN = 'backwpup-restore-[0-9a-f]{20}'`), and its `src/Cli/Commands/Restore.php` is byte-identical to `a612005`'s; `f1ebfd0` does not have it | `gh api …/contents/…?ref=850263d6`; the cached 5.7.7 builds | The family pattern is the plugin's own, for the latest stable and `develop` alike. |
| V219 | `wp db reset` drops the whole database while BackWPup dumps only the site's prefixed tables, so other prefixes' tables, views, routines, events and triggers would be lost for good; and the command replaces `WP_CONTENT_DIR`, not necessarily `<root>/wp-content`. `simple` holds nothing outside `wp_`, its `WP_CONTENT_DIR` is `<root>/wp-content` (no link), no ACLs | `inc/class-jobtype-dbdump.php:54-57`; `Restore.php:163, 192`; a read-only probe; `getfacl -R -s` | The CLI restore is refused on a site breaking either premise. ACLs and xattrs are not kept (none on the cells). |
| V220 | Every streamed wizard action sends `text/event-stream` and flushes before any work, so a later fatal is a stream that ends — which the browser reconnects, re-running the action every few seconds for ever; an HTML or non-200 answer closes the `EventSource` for good (one request) | `AjaxHandler.php:387`; `EventSource.php:28-40`; Chromium: 20 requests in 6 s against one | Fail at once on a stream requested twice on one page, a non-200 or non-stream answer, a failed `controller=job` call or a plugin script error (`WizardWatch`). |
| V221 | The wizard's steps 2–5 `POST` `controller=job` calls answered through `wp_send_json_*`; on an HTML answer the failure handler throws (`responseJSON` undefined) and prints nothing; step 3's connection failure only prints the error line | `AjaxHandler.php:521, 591`; `strategy.js`, `database.js` | Those calls are watched; every wait goes through `untilStep` with all its signals, the decryption prompt included. |
| V222 | A files restore writes the archive's `debug.log` back (`RestoreFiles` excludes none), overwriting unread what the wizard's requests logged from the dashboard to "Start" | V201 | The log is judged again just before "Start"; only what the restore's own files request logs before writing the log back goes unread. |
| V226 | At `ab4a2e2` both editions' `commons.php` are identical. The fixed `backwpup-restore` is no longer written (it survives as the token's prefix and a sweep target; `af1ab5c` writes only it). The token is per install: uninstall deletes every `%backwpup_%` option, `backwpup_restore_dir_token` included. The CLI restore never uses the directory: it works in `get_temp_dir()/backwpup-restore-<uniqid>` and reads only the container's `decrypter`, which needs no registry. A successful restore empties the directory but keeps it with its protection files; the plugin removes one untouched for 6 h (`maybe_cleanup_abandoned_restore`, links skipped); uninstall leaves it; `StaleRestoreFilesDetector` checks every name. No files backup excludes it: the uploads exclusions default to the log folder alone, and the content exclusion `backwpup-restore` names `wp-content/backwpup-restore`, which no build uses — so an archive takes an abandoned restore's `restore.dat` / `restore.dat.bkp`, which hold `dbuser` and `dbpassword` in plain text once the wizard's database step saved them (V196) | `src/Infrastructure/Restore/commons.php`, `uninstall.php`, `src/Cli/Helpers/CommandsRestoreHelpersTrait.php`, `inc/class-jobtype-file.php` (defaults; exclusions joined to their own folder), the vendored `Registry.php` and `JobController.php` | The family and the per-install preparation rest on these; the fixed name stays declared for `af1ab5c` and older. Report upstream: the missing exclusion. The suite's backups each precede any restore in their install, so none holds credentials. |
| V227 | A killed run's restore directory is swept by the next scenario's teardown: planted on `simple` as the web server leaves one mid-restore (a 20-hex name no install drew, `www-data` `0755`/`0644`, `restore.dat`, `restore.dat.bkp`, a 1 MB upload, an extraction tree the transport's user cannot empty), it was gone after one `@plugin` scenario, removed with elevation, and the scenario passed | 2026-10-06, as-found probes before and after | 6G.1's acceptance holds. |

The CLI restore's `wp-content` copy (`cliRestore`; design in [authoring-tests.md → BackWPup's
fixtures](../guides/authoring-tests.md#backwpups-fixtures)) rests on these:

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V217 | The worker's teardown removes the whole staging area (`releaseSite` → `cleanSiteStaging`), so nothing that must survive a failed put-back or a killed run can live there | `wp/teardown.ts` | The copy lives in root-only `<root>/.e2e_content_copy/`, removed only once back. |
| V218 | Exit 1 is ambiguous for a privileged `tar`: GNU tar exits 1 when a file changed while read — or shrank, padding the copy with zeros — and `sudo -n` exits 1 when it refuses; `sudo -n true` succeeding proves no other command is allowed; a refused `sudo du` printed nothing, which read as 0 KB | A container with a limited sudoers | Accept exit 1 only when every complaint is a file that changed or went while read; the copy must list back whole; size checks need whole numbers. |
| V223 | Putting a tree back: a plain `tar -xpf` exits 2 on a type conflict, half done (a root-owned directory where a file was); `--recursive-unlink` mirrors the copy exactly (what was added removed; owners, modes and hard links restored; a link that replaced a directory never followed). But Ubuntu 24.04's GNU tar 1.35 refuses to unlink `.` under it (`.: Cannot unlink: Invalid argument`, exit 2), where Debian's 1.34 and Alpine's 1.35 do not | `debian:bookworm-slim`; reproduced in `ubuntu:24.04`; a read-only comparison on `simple`; seen on the first live CLI restore (`wp-content` intact) | The copy is taken from the WordPress root with `wp-content` as its member and put back into the root — exact on all three builds and on `simple`. Measure tar on the cells' own userland (Ubuntu 24.04). |
| V224 | tar's default format rounds modification times down to the second; `--format=posix` keeps them to the nanosecond | `ubuntu:24.04`, GNU tar 1.35 | The copy uses the POSIX format (seconds were harmless — opcache, WordPress and `tar --diff` compare seconds — but not "as found"). |
| V225 | "As found" for `debug.log` is "as the last scenario left it": the `@plugin` Before hook clears it every scenario (`clearDebugLog`) | `wp/log.ts` | Not a leftover; as-found probes do not count it. |

### 2.10 Plugin removal and leftovers

Three shapes a removal can leave: plugin installed with its rows (a runner kill, V61); files gone,
rows left (`uninstall --deactivate`, V54); part of the folder left, rows gone (the site's PHP killed
mid-delete, V234).

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V47 | `wp_bwpup_backups` can outlive an uninstall under concurrency and then fail the next install (`Table 'wp_bwpup_backups' already exists`, no onboarding flag): uninstall drops it reliably in isolation (3 of 3), but a request that loaded the plugin before deactivation can finish after the uninstall and re-create it | The failing scenario's debug log; a 3-cycle loop | Closed by 6E.0's database sweep, which runs before every install. A lost onboarding flag with no `CREATE TABLE … already exists` in `debug.log` is V122's race instead. |
| V53 | An interrupted run leaves the plugin installed with its options and `wp_bwpup_backups`, and the next run fails in `finishActivation` with V47's wording; deactivating as its own call, then `wp plugin uninstall`, removes all of it. The files-gone shape (no plugin directory, `active_plugins` still naming it, 30 options and the table, seen on `pro@apache`), which `is-installed` (a file test) calls absent, comes from `uninstall.php`'s guard (V54), not from a runner kill (V61) | `pro@apache`: 31 options and the table left, recovered to none | Rule out an interrupted run before V47's concurrency. The plugin's uninstall is complete when it runs (V57). The files-gone shape is why 6E.0's sweep keys off the footprint, never off `is-installed`. |
| V54 | `wp plugin uninstall --deactivate` produces the poisoned state: the flag deletes the files while `uninstall.php`'s `! class_exists` guard skips the cleanup. Install, activate, `completeOnboarding()`, then that call: no plugin files, 26 options and `wp_bwpup_backups`, `backwpup_onboarding` absent, `backwpup_version` `9.99.99`; the next run fails with V53's message | `pro@apache` | The reproduction recipe, three commands and no kill; why the suite never uses `--deactivate` on uninstall. |
| V55 | The leftover footprint alone does not break a run; the missing onboarding flag does. `BackWPup_Migrate::should_migrate()` needs `version_compare( get_site_option( 'backwpup_version', '0.0.0' ), '5.0.0', '<' )`, so a leftover `9.99.99` skips `redirect_to_onboarding()` and the flag is never set; only a completed onboarding deletes it (`class-page-onboarding.php:174`) | A run passed on a site with 27 leftover options and the flag still `1` | A reproduction must include a completed onboarding. |
| V56 | A dirty landing costs exactly one scenario, then the cell heals: the Before hook installs the files, so the After hook's `ensurePluginAbsent` runs the plugin's full cleanup | A full-state snapshot of `pro@apache` after V54's failure equalled its clean baseline | The sweep removes one misattributed failure per dirty landing, no suite-wide rescue. A leftover plugin folder is worse (V230). |
| V57 | The plugin's own uninstall is complete: options, tables, user meta, roles, administrator capabilities and cron hooks are identical before install and after deactivate-then-uninstall (bar two core transients), including `bwpup_backups_version`, which `uninstall.php`'s `LIKE '%backwpup_%'` misses but BerlinDB's `Table::uninstall()` drops. Not for cron when a job is not set to run on WP-Cron: its event survives (V299) | `pro@apache` snapshots | The sweep is a recovery path, for when the files are gone — and for such a job's event (V299). |
| V58 | The footprint: 25 `backwpup*` options, `bwpup_backups_version`, `wp_bwpup_backups`, `_site_transient_backwpup_gdrive_jobid_1` and its timeout row (with no cloud credentials), 3 roles, 11 administrator capabilities, no user meta | Sampled every 6 s through a UI scenario on `pro@apache`, unioned | `optionsContaining` matches anywhere in a name and declares `backwpup` and `bwpup`; roles and capabilities: V295. |
| V59 | Sweeping while the plugin is installed is undone by the next request: the plugin re-creates its options and table on `init` | `pro@apache`: 27 options and the table deleted, all restored by one `wp` call | Sweep only after `ensurePluginAbsent`; `--skip-plugins` is defence in depth. |
| V60 | The sweep is a no-op on a clean site (one read, no write, nothing privileged) on both cells. The neighbour plugin `backwpup-helper` stores `bwh_debug_monitor` | Snapshots before and after, byte-identical | The over-match guards matter: that is the name a careless fragment would sweep. |
| V61 | A hard kill of the runner leaves the plugin installed with its 26 options and table, the shape `ensurePluginAbsent` handles: the remote `wp` runs on to its end (V234), and `wp plugin uninstall` removes rows and files in one call. Killing only the Playwright parent leaves the worker alive to finish its teardown | `pro@nginx`, the process tree killed mid-scenario | Why interrupted runs often look self-healing. |
| V62 | Deleting through wp-admin runs the plugin's uninstall; `wp plugin delete` does not: `delete_plugins()` calls `is_uninstallable_plugin()` and `uninstall_plugin()` before removing files | WordPress 7.1.1, `wp-admin/includes/plugin.php` | Only the wp-admin flow shows a user's complete removal, so 6E.1's footprint assertions sit there. |
| V63 | A `force: true` click on the Plugins screen's Delete landed on nothing: the link was visible with a sane box, but `elementFromPoint` at its centre returned the document root, and forcing skips the pointer-events check, so no request was sent, reported as a timeout blaming the plugin. Unforced, it works first time once the post-deactivate page's `load` has fired | `pro@apache`, probed in the page; the trace | Never force a click: Playwright's actionability log then says what the element was doing. |
| V66 | Free's leftover footprint has Pro's shape (V54's recipe: 26 options and the table, 3 roles, 11 capabilities); the declaration matched all of it, and every literal option, transient and user-meta name in Free outside `vendor/` contains `backwpup` | `free@nginx`; a source scan | The footprint declaration needs no Free variant. |
| V67 | The option match relies on a case-insensitive collation: Free stores a site transient under `BackWPup_` (capital B); `wp_options.option_name` is `utf8mb4_unicode_520_ci`, where `'BackWPup_probe' LIKE '%backwpup%'` is 1 | A query on the cell | A `_bin` or `_cs` collation would under-match silently, the one failure the declaration cannot detect. |
| V209 | A lexical `^…$` check on a residue family's pattern let loose patterns delete too much: an alternation removed `uploads/other-plugin-<hex>`, another a media year folder; an escaped `\$` or `/m` passed; `/^[^.].*$/` matched every directory in `uploads` | Local experiments through `removeSiteResidue` and `isDeclaredResidue` | The family rules: [wordpress-automation.md → Left-over plugin data](../architecture/wordpress-automation.md#left-over-plugin-data-wpresiduets). |
| V210 | `chmod` follows a data directory that is a link, even one inside the site: `assertResolvedInsideRoot` accepts a target resolving to the root itself, so a directory linked to the root opened the root `0755 → 0777` | A local experiment through `prepareResolvedDataDirs` | Preparation refuses a final-component link wherever it leads (removal was safe: `rm -rf` removes the link). |
| V211 | Path rules that trimmed made removing the family member `plugin-tmp ` delete the non-member `plugin-tmp`, reporting success | A local experiment | No segment edged with whitespace (as V209). |
| V212 | `find` without `-H` lists nothing through a parent that is a link (BSD; GNU documents the same `-P` default); a parent the transport's user cannot list aborted the whole removal | Local experiments | `find -H`; an unlistable parent no longer stops the other paths (as V209). |
| V228 | WordPress removes a plugin's folder entry by entry, never atomically: `delete_plugins()` runs `uninstall_plugin()`, then `WP_Filesystem_Direct::delete( $dir, true )`, which walks `dirlist()` (PHP `dir()`, readdir order), goes on past an entry it cannot delete and returns `false` at the end. WP-CLI's `delete_plugin()` shells out to `rm -rf`. A process stopped part-way leaves what it had not reached | WordPress 7.1.3: `wp-admin/includes/plugin.php`, `class-wp-filesystem-direct.php`; WP-CLI 2.12.0 `extension-command/src/Plugin_Command.php` | Any removal that can be killed can leave part of a plugin behind. |
| V229 | SIGTERM to the PHP-FPM master (`NOTICE: Terminating ...`, as `systemctl restart` and a shutdown send) during a wp-admin `delete-plugin` left `backwpup-pro/` with `changelog.txt languages readme.md src vendor` — 3 202 of 5 859 entries — and no `backwpup.php`; `wp plugin is-installed` exits 1 and `wp plugin list` omits it. Uninterrupted, the deletion took 0.37–0.56 s | A local stack (WordPress 7.1.3, PHP 8.5-FPM, nginx, WP-CLI 2.12.0 as a uid-1000 user in group `www-data`, ext4), 2026-10-07; readdir order put `backwpup.php` 4th and `vendor` 14th of 18 | Which entries survive follows the filesystem's readdir order (ext4: a per-filesystem hash): both shapes are real (V270, V271). |
| V230 | Such a folder blocks every install, and each tool names it differently: `wp plugin install <zip>` → `Warning: Destination folder already exists.` / `Error: No plugins installed.`, exit 1; `wp plugin uninstall` → "could not be found", exit 1; `wp plugin delete` → "could not be found" and `Success: Plugin already deleted.`, exit 0, the folder untouched; a wp-admin upload → "Destination folder already exists." with no "Replace current with uploaded", which the installer skin offers only when `get_plugins()` finds a plugin in that folder | Local stack; `WP_Upgrader::install_package()` (`abort_if_destination_exists` → `folder_exists`), `Plugin_Installer_Skin::do_overwrite()` | The old suite then waits for an activation link that never comes, every scenario until someone deletes the folder; this suite heals it since 6H.0. |
| V232 | Why BackWPup and never WP Rocket in AutoE2E: the old suite removes BackWPup Pro through wp-admin after every BackWPup scenario (`After` → `removeBackWpViaUi`), a PHP-FPM request a restart or reboot kills; it removes WP Rocket over WP-CLI (`cleanUp` → `wp plugin uninstall --deactivate`, `rm -rf`), a CLI process an FPM restart does not touch — wp-admin only in its two delete-plugin scenarios or with `npm_config_env=local`. Size widens the gap: the Pro zip holds 5 822 entries (4 923 in `vendor`), WP Rocket's 1 710 | `wp-rocket-e2e` `src/backwpup/support/hooks.ts`, `utils/page-utils.ts` (`cleanUp`, `removePluginViaUi`), `utils/commands.ts`; `zipinfo` of both zips | A smaller, rarer window, not immunity: a reboot inside WP Rocket's removal leaves the same folder. Hence a general guard keyed on the slug, in the shared rails. |
| V233 | Before 6H.0 this suite passed such a folder as removed, in three places: `ensurePluginAbsent` and `uninstallPlugin` verified with `is-installed`; `PluginsPage.delete` ignored the AJAX body (a `{"success":false,…"Could not fully remove the plugin…"}` or a killed request's 502 page read as delivered); the deletion step asked `is-installed` | `wp/plugin.ts`, `pages/plugins.page.ts`, `steps/plugin-deletion.steps.ts` | "Absent" now means nothing at the plugin's path. |
| V234 | A kill of the runner never cuts a removal short (the remote `wp` runs on to its end); a kill of the site's own process does, leaving files partly gone and no rows to sweep (`uninstall.php` already ran). `pro@apache` sits on the twice-daily rebooting server, and the orchestrator runs cells continuously, as AutoE2E does | V229, V231 | 6E.0's database sweep cannot see this shape; 6H.0 is its file-side counterpart. |
| V270 | The nginx server lists `backwpup.php` **1st** of 18 top-level entries. `delete_plugins()` of the Pro build takes 0.40 s (boot 0.48 s); SIGTERM at 0.7 s left `assets config inc pro src vendor`, 3 830 entries, no main file; the tools answer as V230 | `pro@nginx`, `timeout -s TERM <s> wp eval` around core's `delete_plugins()` (`ab4a2e2`) | Here every interruption leaves the main-file-gone shape. |
| V271 | The apache server lists `backwpup.php` **15th**, after `vendor` (11th). `delete_plugins()` takes 0.56 s (boot 0.62 s); SIGTERM at 0.9 s left `backwpup.php` and part of `vendor` (4 283 entries). WordPress lists it (inactive); this time `wp plugin uninstall` exit 0 removed it all — what `uninstall.php` needs had survived | `pro@apache` | The main-file-survives shape is real; whether its uninstall works depends on how far the delete got. |
| V272 | With `vendor/berlindb` gone and the main file kept: `wp plugin uninstall` exit 1, `PHP Fatal error: … Failed opening required '…/vendor/berlindb/core/src/Database/Base.php'` at `uninstall.php:20`, folder kept; `wp plugin delete` removes it | `pro@apache` | Cleanup removes such a copy by path once its uninstall failed. |
| V273 | Recovery live: on a dirty `pro@nginx` the pre-flight banner named the folder and the first scenario's Before hook removed it (`3830 entries (assets, config, inc, pro, src, vendor); owner www-data`) and installed; on `pro@apache` the Before hook tried the uninstall, quoted its fatal, removed the copy by path and installed (V274). Both cells left clean | Full runs, `E2E_RETRIES=0`, `cd26255` | Recovery costs one scenario's Before hook. |
| V274 | A healed copy's uninstall fatal lands in the `debug.log` the Before hook had just cleared, failing that first scenario (`DebugLogFatalError`) | `pro@apache` first scenario | The Before hook clears the log again after healing a failed uninstall: a leftover's fatal belongs to the run that left it. Re-proven live. |
| V275 | A wp-admin deletion WordPress cannot finish (a root-owned folder planted in the plugin): `delete-plugin` answers `success: false`, "Could not fully remove the plugin backwpup-pro/backwpup.php."; the screen no longer lists the plugin | `pro@nginx`, the real page object and step check | `PluginsPage.delete` fails with WordPress's words; removal under test judges the path; cleanup removes it with elevation. |
| V276 | On a clean site cleanup sends one `wp --skip-plugins --skip-themes eval` (the inspection) and the existing `wp cache flush` — nothing written, nothing elevated | node-ssh's `exec` counted, `pro@nginx` and `free@nginx` | A clean site pays one read. |
| V278 | An **active** copy that cannot boot (`vendor/berlindb` gone) makes `wp plugin is-active` die on its fatal at exit **1**, read as inactive, so the deactivation is skipped; the folder removed by path leaves `backwpup-pro/backwpup.php` in `active_plugins` (protected from the sweep), and the next `install --activate` never runs the activation: 0 options, no `backwpup_activation_time` | `pro@apache` live, before and after the fix | After a failed uninstall, `wp --skip-plugins plugin deactivate`, then `--skip-plugins plugin is-active` must exit 1, else `PluginDeactivationFailedError` and nothing removed. The ordinary deactivation still loads the plugin, so its own hook runs. |
| V279 | With a symlinked `rootDir` the site names `WP_PLUGIN_DIR` from WP-CLI's resolved working directory, so every folder failed "does not lie inside the WordPress root" | `plugin-dir.spec.ts` (link root, real-path reply) | The path is also accepted under `readlink -f` of the root (resolved only then), the guards applied to whichever root matched. |
| V280 | `test -e` follows links: a dangling link at the slug in a folder the transport's user cannot write read as removed, so it was never escalated | `pro@apache` user and `sudo -n`; GNU/dash/sudo and BSD checked | Survivors are `test -e p -o -L p`, in `removeSiteResidue` too. |
| V281 | A product whose `uninstall.php` fatals passed every `@plugin` scenario while the teardown only warned | `plugin-lifecycle.spec.ts` | The teardown heals, then throws `PluginUninstallBrokenError` (a cleanup failure: later duties run, the log verdict outranks it); the Before hook only reports (an earlier run's copy). |
| V282 | Inspecting every edition's slug reported another edition's orphan (`backwpup` on a pro cell) every run with "the next @plugin scenario removes it", never true | `pro@apache`, source | Only the cell's slug is inspected (`resolveIdentity(manifest, edition)`). |
| V283 | `get_plugins( '/<slug>' )` also finds a header one folder deeper, while `is-installed` says no and `uninstall` "No plugins uninstalled" | `pro@apache`: header in `backwpup-pro/sub/` | `recognised` means a `<slug>/<file>.php` key of `get_plugins()`, WordPress's own list. |
| V288 | An **active** copy that cannot boot fails the auth setup before any hook can heal it: `core is-installed` 0, the locale `wp eval` 1 (BerlinDB fatal), `wp-login.php` 500; with `--skip-plugins=<slug>` the locale boots | `pro@apache` live, before (setup failed, wrong "user exists" hint) and after | The setup retries the locale with the cell's slug skipped and, when that boots, removes the copy (`ensurePluginAbsent`); the healthcheck only reports it. |
| V289 | A dangling link or a file at the slug: `plugin install` exits 1, stderr `Warning: Could not create directory. "<…>/plugins/<slug>/"` (WordPress says "Destination folder already exists" only for a folder) | `pro@apache` live, both | `PluginDestinationBlockedError` names what is there, only for exactly `WP_PLUGIN_DIR/<slug>`. |
| V290 | With `vendor/berlindb` removed, the teardown first ended in `DebugLogFatalError` — the `debug.log` read booted the broken plugin and logged its own fatal — then in BackWPup's running-job check (asks the plugin). With only a file `uninstall.php` requires removed, it throws `PluginUninstallBrokenError` and still heals (folder removed, off `active_plugins`, 28 options + 1 table swept) | `pro@apache` live | `debug.log` read/clear boot `--skip-plugins --skip-themes` (log path identical, `wp_debug_mode()` runs before plugins load); a stop that fails on a copy `pluginBreaksBoot` blames is reported and the removal goes ahead. |
| V291 | Roles (`backwpup_admin/_check/_helper`) and 11 admin caps outlive a failed uninstall (they live in `<prefix>user_roles`) | `pro@apache` live | See V295. |
| V295 | `WP_Roles::add_role()` returns unchanged when the role exists (`class-wp-roles.php:176-179`), so BackWPup's "Add/overwrite roles" (`inc/class-install.php` ~l.123) keeps a leftover role's caps; admin caps (`add_cap`) do overwrite. A planted `backwpup_check` kept its planted caps through a fresh install | `pro@apache` live before/after; a clean sweep leaves `user_roles` byte-identical | `SiteDbResidue.roles`/`.capabilities` (exact names; core roles/caps and names without a product fragment refused); BackWPup declares 3 roles + 11 admin caps. |
| V299 | Deactivate + uninstall leaves a job's WP-Cron event: `backwpup_cron {arg: 4}` for a job not set to `wpcron` survived both, and a later fresh install inherited it (the import scenario's copy, job 4, read as scheduled). Deactivation (`inc/class-install.php`) clears only the argument-less `backwpup_cron`, `backwpup_check_cleanup` and WP-Cron jobs' events; the uninstall clears none | `pro@nginx` live, 2026-11-17, BackWPup Pro develop `a98abb6` | Qualifies V57. The sweep declares the plugin's three WP-Cron hooks (`cronHooks`) and removes every event of each, whatever its arguments. |

### 2.11 Cells and servers

`free@nginx` is `bwu.e2e.rocketlabsqa.ovh`: its own site and database on `pro@nginx`'s host. Both
editions were built from the same commit, so comparisons are of packages, not releases.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V44 | The cells arrange cron differently. `pro@nginx` and, since 2026-09-22, `free@nginx` define `DISABLE_WP_CRON` and a system cron curls `wp-cron.php` every minute; `pro@apache` does neither and spawns cron from page loads. A site with a system cron but no constant gets both (`init` → `wp_cron` is guarded only by `DOING_CRON`; `_wp_cron()` returns early only on `DISABLE_WP_CRON`) | Crontabs and `wp-config.php` of each cell; `default-filters.php:412-414` | `spawn_cron()` is gated by neither. The per-minute requests supply V122's second request. |
| V71 | Two `headers already sent` warnings from core's `wp_redirect()` (`pluggable.php:1539`, `:1542`) in the deletion scenarios are `bwu`'s, not the edition's: none on `pro@nginx`, none for an unauthenticated `/wp-admin/` redirect on either; cause not isolated (its extra plugins, V72) | Debug logs | Logged, never fatal; not the plugin. |
| V72 | The Free cell is no mirror of `pro@nginx`: its own database (`wp_bwu_e2e_rocketlabsqa_ovh`, 4.8 MB against `e2eSimple`'s 47.7 MB) and docroot (3.6 GB, 3.3 GB of it `bigFiles`, before 2026-09-30), on the same host and disk. `query-monitor` (with its `db.php` drop-in) and `imagify` are active only there, `wp-crontrol` only on `pro@nginx`; the themes differ | Read on the cell, 2026-09-18 and 2026-09-22 | One disk serves both nginx cells (V162). About four suites per server are allowed (operator, 2026-09-28), naming the sites first; disk still binds (the orchestrator plan's 0A.3). |
| V162 | Four BackWPup sites share the nginx QA host (`qa-lnmp`): `pro@nginx` (`simple.e2e`), `free@nginx` (`bwu.e2e`) and the orchestrator's `bwu2.e2e` and `bwu3.e2e` — one SSH host, one disk (97 GB; 17 GB free on 2026-09-24, 16 GB on 2026-09-27). It is the team's QA host: 28 docroots under `/var/www/html`, several changed the same day | Sites files, hosts only; read on the host 2026-09-27 | Other people's load shows as slower scenarios (V174). Watch the shared disk before files-heavy runs. |
| V231 | The QA servers kill PHP several times a week, by design. The apache server (`pro@apache`, AutoE2E's BackWPup and WP Rocket apache sites): root crontab `0 4 * * *` and `0 16 * * *` `systemctl --no-wall reboot`, every day since at least 2026-09-22. `qa-lnmp`: every PHP-FPM version restarted together 2–3 times a week at ~06:00–06:55, matching unattended-upgrades runs with `needrestart` installed, plus reboots every 1–3 weeks. A restart kills requests in flight (an nginx `recv() failed (104: Connection reset by peer)` as FPM logged `Terminating ...`; on apache an `upload-plugin` 500 at 15:59:59 and a delete ending just before the 16:00 reboot) | `crontab -l`, `last -x`, `/var/log/php*-fpm.log*`, `/var/log/unattended-upgrades/`, nginx `error.log*`, the apache site's access log, all read-only | The cause of half-removed plugins (V229): a removal in flight when the server kills PHP. No AutoE2E incident time was available to tie one occurrence to one kill. Pausing a cell across a maintenance window belongs to the orchestrator plan. |
| V277 | BackWPup `develop@cd26255`'s `ensure_uploads_folder_protected()` calls `backwpup_wpfilesystem()->mkdir()` from WP-CLI; on `simple` without `FS_METHOD`, WordPress picks `ftpext` with no connection (V292) — `ftp_mkdir(): Argument #1 … null` — then `Undefined constant "FS_CHMOD_FILE"`; 11 of 12 scenarios failed. `pro@apache` defines `FS_METHOD` `direct` and passes | `pro@nginx` run, `src/Infrastructure/Restore/commons.php:126` | A product defect at that ref; worked around on the cell (V297). |
| V292 | V277's trigger: Code Snippets 4.0.0 calls `WP_Filesystem()` at load (`Flat_Files/WP_Filesystem_Adapter.php:30`), before WP-CLI's `direct` filter exists; files `www-data` against CLI uid 1000 and no `FS_METHOD` give an unconnected `ftpext`, cached in the global that `backwpup_wpfilesystem()` (`inc/functions.php:134-147`) reuses unchecked; `--skip-plugins=code-snippets` → `WP_Filesystem_Direct`. Same code in 5.7.7 | `simple` live, a `--require` backtrace; source | A BackWPup defect, exposed by a third-party plugin; report upstream. |
| V293 | A run on the AutoE2E server's `auto-e2e-backwpup` (1 failed, 4 flaky): every failing attempt's page lost its own scripts (`ERR_CONNECTION_CLOSED`) or document (`QUIC_PUBLIC_RESET`). The vhost served HTTP/3 (`listen 443 quic`, no `reuseport`, 4 workers, keepalive 8 s); static bursts with 10 s idle gaps: 12.9 % lost, 0 with `--disable-quic` and 0 on `simple` (no h3). Not contention | The traces' network logs, access logs, probes | Fixed 2026-10-22 by `reuseport` (orchestrator-phase-0.5 plan §6, step 5). |
| V297 | `simple` defines `FS_METHOD` `direct` (user's choice, 2026-10-21; `wp-config.php` backed up as `~/e2e-backups/simple-wp-config.php.2026-10-21`, `0600`): Code Snippets gets `WP_Filesystem_Direct`, and V277/V292 are gone on `pro@nginx` | `pro@nginx` run: UI and web-context scenarios passed | V277 no longer blocks the cell. |
| V298 | V41/V167 hit **every** foreground `wp backwpup run` on `simple`, encryption off: `Allowed memory size of 79691776 bytes exhausted (tried to allocate 3858872 bytes)`, `class-mysqldump.php:760`. Not Code Snippets nor the build (same with Code Snippets skipped; `af1ab5c`→`cd26255` changes nothing memory-related). `wp-config.php` held that define commented out (changed Oct 6, after 6F.4's Sep 25 pass); whether it was active then is not provable. A finite limit fixes it: `php -d memory_limit=1G` or `WP_MAX_MEMORY_LIMIT` `512M` → done in 1 s (`WP_CLI_PHP_ARGS` has no effect: `wp` is the phar). Largest rows: posts up to 2.55 MB (≈3.86 MB escaped, the failing allocation) | `simple` live, 4 of 4 by hand and every attempt of 8 scenarios, 2026-10-22 | A BackWPup defect (report with V41/V167). Worked around on the cell (user's choice): `simple` defines `WP_MAX_MEMORY_LIMIT` `512M` (backup `~/e2e-backups/simple-wp-config.php.2026-10-22`); the three features then passed. A cell with unlimited CLI memory and large rows needs the same. |

### 2.12 Staging exposure (for 6J)

V134 and V145 on the nginx cells (anonymous read-only requests, probe files planted and removed);
V142–V144 in throwaway containers of the docker env's images (`wordpress:php8.3-apache`;
`nginx:1.27-alpine` running `docker/nginx/default.conf`), probe files in the staging root,
`plugins/`, `plugins/public/` and `public/`, testing 6J's drafts (§4). While a run has it staged, the
plugin zip sits at `.e2e_temp/plugins/<build name>.zip`, guessable from the ref (e.g.
`backwpup-pro-en-9.99.99-f1ebfd05.zip`); BackWPup Pro is commercial.

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V134 | nginx serves the staging area to anyone who can name a file in it: a file in `.e2e_temp/…` answers 200, one inside a folder only the transport's user may enter 404, and a directory is not listed (403) | Both nginx cells | The download folder is `0700` with a random name part (it holds a whole database); the staged zip stays exposed until 6J. |
| V142 | The two guards deny the same thing. Without them every staged file answers 200, and on Apache a staged `.php` runs. With them everything under the staging root answers 403 (any file, nested folders, `plugins/public/`, the directory itself), while the top-level `public/` keeps normal handling: files 200, PHP run by Apache or handed to FastCGI by nginx | Apache 2.4.68 (the image's `AllowOverride All` in `conf-enabled/docker-php.conf`, mod_rewrite), nginx 1.27.5; 9 paths on Apache, 12 on nginx, before and after | Ship them as drafted, one rule in two languages; they close anything staged, code included. |
| V143 | The `.htaccess` fails open only under `AllowOverride None` (ignored: 200). Every other broken setup fails closed: `FileInfo` alone works; `AuthConfig` alone answers 500 inside the staging area (a file outside still 200); mod_rewrite disabled leaves the fallback's 403, `public/` included; a guard the server cannot read (`0600`, another owner) answers 403 | The same container, reconfigured per case | The probe is needed on Apache too. An unparseable guard costs its own folder, never the site. |
| V144 | nginx applies the include wherever it sits in `server {}`: it picks the longest matching prefix before any regex, and `^~` on it skips the regexes. Placed after the vhost's `\.php$` and static-asset regexes, it still denied `.php` and `.css` under the root, `/%2ee2e_temp/…`, `/x/../.e2e_temp/…` and the `.htaccess`, which nginx serves as a plain file without the include | nginx `ngx_http_core_module` docs (`location`); measured | Operators may include it anywhere in the site's server block. |
| V145 | The nginx cells send `server: nginx/1.24.0 (Ubuntu)`. A missing file under `.e2e_temp/` answers WordPress's own 404 page (`text/html`, 52–59 KB, ~1 s). Several requests in a row then got no answer for 15–60 s; both cells answered again minutes later | `curl` from the runner | Show the `Server` header, never branch on it; judge by the probe's content, never a status; bound the wait and report no answer as "could not check". |

### 2.13 Toolchain: Playwright, SSH, execa, the runner

| # | Fact | Evidence | Consequence |
| --- | --- | --- | --- |
| V34–V37 | Under Playwright 1.61 an admin POST → redirect (onboarding's submit) left the tab without animation frames for good (`click()`, `toBeInViewport`, screenshots hung while `toBeVisible` answered); plain WordPress wedged too; seeded past onboarding the dashboard clicked in 45 ms. Cause: Chromium's `RenderDocument` in 1.61's `--disable-features` (microsoft/playwright#37715), removed in 1.62 | Frame timeline on `pro@nginx`; `chromiumSwitches.ts:44` at `v1.61.1`, absent at `v1.62.1` | Detail and the version floor: [wordpress-automation.md → Playwright ≥ 1.64 is a floor](../architecture/wordpress-automation.md#playwright--164-is-a-floor-not-a-preference). "Assertions still pass" never shows a defect is cosmetic: the survivors are the frame-independent ones. |
| V118 | node-ssh never notices a silent link (a command still waiting after 70–80 s), and before 14.0 missed a reset mid-command (`read ECONNRESET`), which ended the worker | A local proxy through the repo's `exec()` | Handled in the transport: [wordpress-automation.md → Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects). |
| V120 | A sleeping runner (a Mac) looks like a network outage: timers stop, so a 120 s hook outlives half an hour, then `read ECONNRESET` / `Not connected` after each wake | `pmset -g log` against the runs' times | Keep the runner awake (`caffeinate -i`, AGENTS.md). |
| V121 | A pooled SSH connection can be dead while node-ssh calls it connected: ssh2 half-closes after a protocol error or a server's disconnect and refuses every request with `Not connected` before sending a byte; node-ssh notices only on the socket's `end`/`close`, minutes later | Seen twice after wakes (V120); a proxy holding both FINs back | Handled in the transport (as V118). |
| V141 | ssh2 cannot close a socket it has stopped writing to: `end()` and `destroy()` return early once it is not writable, and node-ssh's `dispose()` calls `end()`, so a half-closed socket lingers until the server's own close | `node_modules/ssh2/lib/client.js:1179-1189`; node-ssh `dispose()` | Bounded: one socket per recovered connection. |
| V170 | Playwright empties its output folder as a run starts: a unit run with the default `test-results/` wiped every cell's results beneath it, and a live run beside it failed writing an attachment (`ENOENT … test-results/.playwright-artifacts-1/…zip`) | A marker in a cell's folder | Unit runs write to `test-results/_unit` (AGENTS.md, "Output folders"). |
| V176 | execa's errors quote the whole argv (in `message`, `shortMessage`, `command`, `escapedCommand`) for a command that cannot start, one killed by a signal and one over its output cap; the reason without it is in `code`, `signal`, `signalDescription`, `isMaxBuffer` | execa 10.0.1, a fake secret in each case | Never pass on execa's message nor attach its error as a `cause` ([wordpress-automation.md → Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects)). |
| V177 | node-ssh quotes no argument: a signal kill reads `"sh" on <host> was terminated by signal SIGTERM before exiting.`; a missing program is an exit-127 result naming only the program | `pro@nginx`, a secret in each argv | The model the other two transports follow. |
| V180 | `ENOENT` means a missing program or a missing working directory; only execa's message (which quotes the argv) tells which | `local`, `cwd: "/nonexistent"` and a missing binary | As V176. |
| V181 | Output that never stops ends killed with no exit code (`signal` `SIGPIPE`, `isMaxBuffer` true); output that stops over the cap keeps its exit code | execa, default cap | As V176. |
| V182 | execa throws on an argument holding a NUL byte, even with `reject: false`, quoting it; over `ssh` the same argv is a bare `Unable to exec` | Locally; `ssh` on `pro@nginx` | Refused before any transport sees it (as V176). |
| V213 | `@slow` triples a scenario's timeout: playwright-bdd calls `testInfo.slow()` | `node_modules/playwright-bdd/dist/runtime/bddTestFixtures.js:25` | Tag only jobs that really take minutes (§3.3). |
| V214 | After a timeout Playwright still tears down — `afterEach` hooks, then test fixtures — within one slot of the larger of the project and test timeouts, while the abandoned test function keeps running | `node_modules/playwright/lib/worker/workerProcessEntry.js:1661-1678` | Cleanup must wait for work a timed-out step left running: `CliRestore.release` waits (bounded, 10 min) and puts nothing back under a running command. |
| V215 | A full-suite `pro@nginx` failure was the runner: its renderer stopped answering for 8.5 s (polls and screencast frames stopped) while the plugin had already replaced the history's placeholder row and the server answered every call in ~0.6 s | The trace; the scenario then passed 3 of 3 | Read the next failure of that shape the same way. |
| V294 | Playwright puts no limit on a navigation, so each page broken by V293 burned the scenario's whole budget (≈53 of 104 min) | `free@nginx` full traced run | `navigationTimeout` 60 s run-wide (worst measured navigation 5.6 s; a call's own timeout wins); a failed scenario reports the site's own failed requests (`[page-loads]` line + `page-load-failures`, paths masked). |
| V296 | The page-loads report held live on `free@nginx` with server-side faults (a temporary mu-plugin): h2 truncation → `net::ERR_HTTP2_PROTOCOL_ERROR`, reported for a REST xhr and a document; a document and a script 500 once each; masking held (hex, `ghp_`, `_wpnonce`, `logfile=`); a passing scenario with harmless failures reports nothing. `waitForResponse` resolves on a truncated 200, so the scenario failed 5 s later on a hidden locator. A truncated or 120 s-hung document fails at `goto`'s 60 s | Live runs, `E2E_RETRIES=0` | Works as designed; retries and the 50-entry cap not exercised live. |

### 2.14 Open items outside the port

Recorded by the 6F audits and still open (the first two and the `dashboard.page.ts` links re-checked
2026-11-19): `metadata.spec.ts` has no case for the `siteDbResidue` registry;
`backup-contents.feature` (two full files backups) fits `@slow` and is untagged; `plugin.spec.ts`'s
cache-flush ordering check passes with the uninstall absent; `locator-contract.spec.ts` failed once
under full-suite load (5 of 5 alone); `{@link}`s that resolve to nothing (`dashboard.page.ts` to
`DataSelectionSidebar` and `BackupHistoryTable`, neither imported; also seen in `ownership.ts`,
`onboarding.page.ts`) and doc blocks cut off from their code (seen in `run-context.ts`,
`residue.ts`, `preflight.spec.ts`, `exec.spec.ts`, `ownership.spec.ts`, `residue.spec.ts`). Traps
nothing in the toolchain catches: inserting a documented helper directly above another strands both
doc blocks; a `{@link}` to a symbol the file does not import, or to a file path, does not resolve.

## 3. Coverage & tagging decisions

### 3.1 Editions

Baseline coverage is Pro-only. Default: untagged (both editions). Tag only where the product
differs:

| Tag | Scenarios |
| --- | --- |
| (none) | Onboarding, backup, history, download, delete, plugin lifecycle, WP-CLI `job`/`backup`/`run`/`status`, the backup and log files (`backup-delete`/`-download`, `log-show`/`-delete`); FTP/S3/MS Azure/Rackspace/SugarSync storages |
| `@pro` | Glacier storage; restore from the backup history (in place, V13); CLI `restore`, `backup-encrypt`/`-decrypt`, `job-export`/`-import` (V4) |
| `@free` | The locked Pro-storage upsell (`js-backwpup-locked-storage`, V2); restore by manual upload (V13) |

Filtering is automatic per cell (`editionFilter`, `src/common/config/project.ts`): an edition-ful
cell generates only its edition's scenarios (V161). The storage rows are 6H.2's content; their tags
are settled here, so the deferral is scheduling, not an open question.

### 3.2 Locator policy

As in [authoring-tests.md → Locator policy](../guides/authoring-tests.md#locator-policy): role/label
first, then the plugin's JS contract hooks (`js-backwpup-<trigger>`, `data-content`,
`data-backup-id`, `data-job-id`, `data-storage`), never structural CSS. BackWPup's two cases for the
hooks: icon-only or empty-label buttons have no accessible name (V7, V16), and every switch is an
`sr-only`, `aria-hidden` checkbox behind a visible proxy (V16, handled in `pages/toggles.ts`). Each
is pinned by a spec asserting the control really is unreachable by role, so an accessibility fix is
noticed. The English-locale pre-flight (`determine_locale()`) shipped in 6B.

### 3.3 Tags kept

As in [authoring-tests.md → Tags](../guides/authoring-tests.md#tags). Phase decisions:

- The `@bwpup*` family is dropped: the product is the config file, not a tag.
- `@plugin` on nearly every scenario; not on one asserting a site without the plugin, nor `@noauth`.
- `@slow` only for scenarios that take minutes (6G's restores). playwright-bdd triples its timeout
  (V213). 6F.2 does not use it: its jobs take seconds (V112).
- `@storage` is kept for the storage scenarios (6H.2).

## 4. Sub-phases

Each ships on its own and ends with the four gates plus a green real-cell run (`E2E_RETRIES=0`,
runner kept awake). Dependencies: 6A before everything, 6B before every feature phase, 6G.0 before
6G, 6G before 6I.1; 6I.1 before 6K (both edit the restore feature); 6H before 6H.2. Among the open
phases the order is priority, not dependency: 6H, 6I and 6J need nothing from each other; 6K needs
only 6G, but follows 6I.1. 6H.2 is outside the sequence: nothing waits on it.

### 6A — Shared rails (done, 2026-07)

The product-agnostic rails every product needs. As built: `AGENTS.md` (Shared scenario hooks,
Device profiles, Improvement gate) and wordpress-automation.md (Elevated housekeeping, Left-over
plugin data).

- Hooks load from `src/common/hooks/**/*.hooks.ts`, narrower than `**/*.ts`, so specs and policy
  modules are not imported as hooks.
- Cleanup escalates only what survived (`execElevated`), never `wp`. The baseline's hard-coded
  `sudo` was not copied: the docker image has no `sudo` (`-u 0:0` there), and a local developer
  needs none.
- The Before hook creates the declared data directories `0777` (`prepareSiteDataDirs`) against the
  two-user lockout (WP-CLI and the web server as different users). Running `wp` as the web server's
  user, rejected then as a larger change, is what Phase 12 later did.
- The zip is staged per scenario, not once per worker: the uninstall dominates the hooks' cost
  (~25 s per `@plugin` scenario, upload 4.5 s of it, plus a one-off ~4 s SSH connect per worker), and
  `stageArtifact`'s unconditional overwrite is a safety property (a crashed run's residue is
  replaced before it can be used). Re-timed in 6G on `pro@nginx`: Before 44–50 s, After ≈ 23 s.

### 6B — BackWPup page objects (done, 2026-07-30)

The whole UI surface once, so the feature phases are thin. As built: `src/projects/backwpup/pages/`
(locator-contract specs over markup captured from the ref under test, `npm run fixtures:capture`)
and authoring-tests.md (Page Object Model). `support/rest.ts` names every REST route as a barrier,
so an unknown route is a compile error, not a wait that never matches (V8).

- Page objects are registered in the product's `fixtures.ts`, not `common/fixtures.ts` as the parent
  plan first sketched ([§2.11](e2e-modernization-plan.md#211-page-objects-and-step-wiring)): shared
  code must not import product code, and WP Rocket runs must not load BackWPup's objects.
- Locators come from captured markup, then are proven by driving onboarding live (which found
  V14–V17).
- `JobRunPanel`, not a modal (V17); the restore page is an interface plus
  `ProRestorePage`/`FreeRestorePage` behind `restorePage(page, edition)` (V13).
- The capture needs a post-backup state (history rows, a live `startbackup`, a record carrying
  `restoreurl`), so it runs a real database-only backup on `pro@nginx`.

Open:

- `StorageSidebar.saveAndTestConnection()` (`cloudsaveandtest`) is written; 6H.2 first exercises it.
- Before the next capture, re-diff the fixtures' source against the latest stable: they were taken
  from 5.7.5 (V38), and 5.7.7 has shipped since (V208).

### 6C — Onboarding & job configuration (done, 2026-08-05)

`features/onboarding.feature`: the baseline's six intents plus three rules it never covered (a data
type before the schedule step, a destination before completing, stepping back keeps the choices);
its redirect scenario folded into the Background.

- The starting state is asserted, not seeded: installing the plugin puts a site into onboarding
  (V26), and writing the flag from the test side would hide the day the plugin stops setting it. The
  Background asks for the dashboard and asserts the redirect (V10). Seeding is for later phases.
- Every scenario that finishes onboarding waits for the backup it starts (V24) — on WP-CLI, not the
  page, which never reports a fast backup (V27).
- Two independent sources: the page objects, and `wp backwpup job --format=json` plus the
  `backwpup_jobs` option for settings the command does not expose (file areas, excluded tables).
  Job contents are compared as a set, in product language (`describeJobContents()`).
- The default table selection is asserted by the screen's rule — name contains the prefix, from
  `wp db prefix` (V25).
- `Given a freshly installed BackWPup` asserts the edition is installed and active, not zero jobs
  (V32); that onboarding is owed is proved by the redirect after it.

### 6D — Backup lifecycle & history (done, 2026-08-28)

`features/backups.feature` (the baseline's `backup.feature` and `download-restore.feature`, plus the
deletion and bulk coverage it only performed as cleanup); the seeder `completeOnboarding`
(`support/onboarding.ts`); the cron trigger (wordpress-automation.md → WP-Cron).

- Setup is seeded through the plugin's own entry points — the destination save and
  `save_post_form()` — then read back; proven equal to a real onboarding (V39). The seeder uses the
  onboarding page's job-id rule (`$first + 1` / `+ 2`), not `next_job_id()`: they agree only on a
  fresh install. Rejected: submitting onboarding, which starts a full backup every scenario would
  wait out.
- Jobs back up the database only: the smallest genuine backup (43 MB, seconds, on `pro@nginx`,
  against 450 MB for files and database).
- A step that starts a backup also waits for it, so no step carries state to the next.
- Counts are asserted from both sides in one step (table rows and
  `wp backwpup backup --format=count`), the number coming from the scenario.
- The schedule is fired, not waited out: `triggerScheduledEvent` (V40, V41, V44); the right job is
  asserted by the newest archive's `job_id`. Never delete `doing_cron` (V48).
- A run's verdict comes from its own log entry (`readLastRunOutcome`, integer counts), never from
  `wp backwpup status`, which reports none once the job has ended.
- Downloads are compared by name, size and full SHA-256, the site's digest computed on the site.

#### 6D.1 — What a backup actually holds (done, 2026-09-01)

`features/backup-contents.feature` and the `markers` fixture; shared `wp/php.ts`, `wp/files.ts`,
`wp/archive.ts` (wordpress-automation.md). Two random 32-character markers, one in a file at the root
of `wp-content`, one in an option, planted for every scenario; each job shape asserts what it covered
and what it left alone — the halves are each other's positive control, and random values mean a
stale archive cannot satisfy them. Archives are read in place with GNU tar (V52): the plugin reports
`path` only for archives WP-CLI can read, so no elevation is needed.

Rejected: seeding three jobs at once. It breaks `theScheduledJob`'s one-job invariant, needs a job
made outside onboarding (losing V39's equivalence), and saves nothing — the cost is running a job,
not declaring one.

### 6E — Plugin lifecycle (UI) (done, 2026-09-18)

#### 6E.0 — Recover a site from a leftover footprint (done)

A site whose plugin files went while its rows stayed must not fail the next install (V54, V55):
`ProductConfig.siteDbResidue` and `common/wp/db-residue.ts`, swept right after `ensurePluginAbsent`
in both hooks ([wordpress-automation.md → Left-over plugin
footprint](../architecture/wordpress-automation.md#left-over-plugin-footprint-wpdb-residuets)).
Limits: a dirty landing costs exactly one scenario, then the cell heals itself (V56); the option
match needs a case-insensitive collation (V67); the half-removed folder is 6H.0's (V234).

#### 6E.1 — The UI scenarios (done)

`features/plugin-deletion.feature`: deleting a deactivated plugin, an active one (deletion used to be
lost in the deactivate step, V63), and one that has made a backup (settings go, the archive stays), on
the shared `PluginsPage.delete` (the baseline's duplicate dropped).

- Both halves of deletion are asserted: gone from the site (asked of WP-CLI, independent of the
  screen) and its database footprint gone, read with plugins unloaded. Only wp-admin deletion runs
  the plugin's uninstall (V62).
- `support/footprint.ts` is broader than 6E.0's declaration: it checks what `uninstall.php`
  promises, not what our sweep declares. Both editions leave the same footprint (V64–V66).
- Archives surviving deletion are counted off the filesystem: the WP-CLI command was just deleted.

### 6F — WP-CLI surface (done)

`wp-cli/list-jobs.feature` widened to every registered command (V3, V4, V80). Split by the state a
command needs before it can answer — none, a configured job, a finished backup with its log, a job
running now — the order a site acquires it. Per command would multiply near-identical Backgrounds;
per edition would split `backup-delete`'s two outcomes (V84). Facts: §2.7, §2.8.

#### 6F.0 — CLI rails (done, 2026-09-22)

`support/cli.ts`, the asserting runner (`readJsonList` refuses a failed command before parsing:
WP-CLI leaves stdout empty on an error, which would read as an empty list), and
`support/cli-commands.ts`, the registered set compared both ways (`AGENTS.md`: `cli` vs
`support/backups.ts`).

- Asserting and arranging stay separate modules: the command under test returns a refusal, a command
  that arranges throws. One module would need a "do I throw?" flag on every caller.
- Registration is read from `wp backwpup --help`: `wp cli cmd-dump` runs before plugins register
  theirs. The parse fails loudly on a missing or empty `SUBCOMMANDS` block, since "registers
  nothing" would pass every absence assertion; the declared set is checked against both editions'
  captured help pages in the unit suite.
- No step without a feature using it: a step no feature matches is dead code no gate catches (the
  CLI vocabulary waited for 6F.1).

#### 6F.1 — Registration and the read surface (done, 2026-09-22)

`features/cli-reads.feature` (untagged); the shared CLI vocabulary (`steps/cli.steps.ts`, the `cli`
fixture).

- Registration gates all of 6F: zero drift both ways for the cell's edition; the Pro-only commands
  are probed with `--help` (V94), the one probe that never runs `restore`.
- Extra jobs are made through `POST backwpup/v1/addjob` (V93); the history table is read directly
  (`support/history.ts`, V99), so the `backup` command is checked against it.
- `version` is held to the artifact manifest's identity and the zip header's version
  ([plugin-artifacts.md](../architecture/plugin-artifacts.md)).
- Every count is taken against what the site stores, and every ids assertion first proves the site
  holds a hidden job (V92). `log` is its own read surface (V91).
- A Background finishes the install first, so a lost activation race fails at the lifecycle (V122).

#### 6F.2 — Running, watching and aborting (done, 2026-09-22)

`features/cli-runs.feature`, `features/cli-running-job.feature` (untagged); the `@plugin` teardown
duty `ProductConfig.stopRunningWork` (BackWPup's `stopRunningJobs`, `support/job-runs.ts`).

- Stopping a job a scenario left running is a shared teardown duty, after the log is judged and
  before removal: `After` hooks run in reverse registration order (playwright-bdd 9.2) and step files
  import in tinyglobby's filesystem order, so nothing else can fix its place.
- The running job is a paced database job: a lost abort costs seconds, not a multi-gigabyte backup,
  and with restarts off no command lands in a handover (V113). Its database is padded to 100 tables
  so the window is ~11 s on every cell (V185–V187); a killed run's padding is swept by the next
  BackWPup worker (V188). Each scenario sends the running backup one command (V136). No `@slow`
  (V112).
- `status`'s verdict is asserted only for a natural end (V115); a foreground `run` has no verdict to
  assert (V108).
- A failed backup is detected: a real run is aborted and its history row and the dashboard's aborted
  row asserted (V42).

Left unpinned (plugin bugs, steered clear of): `run <unknown id> --background` reports success
(V111); `status` calls an aborted run finished (V115).

#### 6F.3 — Backups and logs on disk (done, 2026-09-23)

`features/cli-backups.feature`, `features/cli-logs.feature` (untagged); a command's stdin closed on
every transport (V126).

- `log-delete`'s refusal is arranged with a read-only log: the web server's logs are writable by
  WP-CLI on these cells (V123).
- Deletions are confirmed against the folders, read with PHP's `scandir` and only their locations
  taken from the plugin (`support/plugin-folders.ts`) — never `log --format=count`, which walks the
  folder through the same helper `log-delete` uses.
- Each archive is recorded with its digest as it is made (`archives` fixture), so "byte for byte"
  and "the oldest backup" cannot move under a later delete (V125).
- Measured edges covered: the `[y/n]` prompts (V126), the documented `--dry-run` (V132), a path out
  of the log folder (V133), a refused download writing nothing (V127).
- `cleanSiteStaging` takes a path inside the area, not only a category: an absolute staging root is
  shared by a host's sites.

Left unpinned (plugin bugs, steered clear of and said so where close): the poisoned second delete
(V124), the orphaned history row (V125), the fatal on an unwritable download (V128), `log-delete`
removing the folder's guards (V131), its success line when nothing was deleted (V130).

#### 6F.4 — Pro-only round-trips (done, 2026-09-27)

`@pro @plugin` `features/cli-job-transfer.feature` and `features/cli-backup-encryption.feature`, on
the `privateFolder`, `keys` and `jobExports` fixtures
([authoring-tests.md](../guides/authoring-tests.md#backwpups-fixtures)). Facts: §2.8.

- No `--passwords` scenario: the export carries the site's database password, and importing it
  stores the password in clear (V157, V163).
- One round trip each for the key saved in the settings and the RSA key files (V148). Archive
  encryption is never turned on (V166, V167).
- An export is held to its job both ways (V156). Refusals are checked byte for byte after each, and
  nothing is left beside the backup at the end. Steps name the export file, since a scenario may hold
  more than one.
- None of the plugin bugs found here (§2's upstream list, V146 first) is pinned, and no scenario
  triggers one.

### 6G.0 — Errors that never quote a command's arguments (done, 2026-09-29)

An exec error names the program and the reason, never its arguments, on every transport (on `local`
and `docker` it quoted the whole argv, keys included, V176). `commandLine` (`support/cli.ts`) is the
one `--key=` mask every message naming a BackWPup command goes through. Rule, the NUL-byte refusal
(V182) and what stays uncovered:
[wordpress-automation.md → Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects).
Audited and kept: the other messages quoting an argv (`backups.ts`, `options.ts`, `residue.ts`,
`cron.ts`) carry job ids, option names and paths, never a secret.

### 6G — Restore (done, 2026-10-05)

The baseline's untracked `wp-cli/restore.feature` restored nothing. `features/restore.feature`
(`@plugin @slow`: five `@pro` restores from the history, the `@free` upload) and
`features/cli-restore.feature` (`@pro @plugin @slow`: `--type=full|db|file` and `--pre-backup`). As
built: authoring-tests.md (Restoring; `restore`, `changedMarkers`, `cliRestore` under [BackWPup's
fixtures](../guides/authoring-tests.md#backwpups-fixtures)). Facts: §2.9.

Design (6I.1 and 6K reuse it):

- The entry path is edition-specific (V13) — the one place for the parent plan's editions pattern
  ([§2.6](e2e-modernization-plan.md#26-editions-free--pro)): separate `@free`/`@pro` scenarios
  sharing a Background. `@pro` asserts its deep link: the archive in the backup folder and a copy
  slot in the restore directory, fetched by the server, no upload offered (V197). `@free` asserts the
  inverse — the bare restore page, no `restore_file` — so Pro silently falling back to Free's journey
  fails.
- Strategy ("Full Restore" / "Database Only" / "Files Only") is orthogonal to the entry path. 6G
  covers it on the `@pro` path: the three strategies on a mixed backup, plus a database-only and a
  files-only backup, each offered exactly one strategy (V189, V199) and failing on any other. Free
  has only the mixed full upload; **6I.1 adds the other Free strategies**.
- The markers change on both sides before every restore; the restored side must hold the backed-up
  values, the other the changed ones.
- CLI: `wp backwpup restore <file> --yes --type=full|db|file` (V192), `--pre-backup` once. A failed
  restore exits 0 (V105), so the markers are the verdict.
- `.tar` only; `.zip` and `.tar.gz` are 6K.

Decisions:

- 6G.1 shipped with 6G: on Pro a WP-CLI backup listing creates the hashed restore directory
  unwritable by the web server, after which the history page answers 500 and every wizard request
  fails (V194, V195). That directory is prepared under its real name — the installed plugin's
  `restore_dir_name()` — and handed to the web server before the wizard; the parent's mode cannot fix
  it (`uploads` is `0777` already, while WP-CLI's umask makes the directory `0775`).
- No re-authentication: the suite's login predates every scenario's backup (V200).
- The CLI guard (`cliRestore`) was unplanned: the command deletes what its archive lacks, resets the
  database's collation and leaves a world-readable snapshot (V205–V207), unsafe on a shared cell.
  The approach is the user's: copy before touching anything.
- Each restore step judges `debug.log` first: a files restore puts back the archive's log (V201,
  V222). After a run `debug.log` is not as found — the `@plugin` hook clears it every scenario (V225).

### 6G.1 — Hashed restore directories (done, with 6G)

Clears the restore working directories recent builds name `uploads/backwpup-restore-<20 hex>`, which
the literal residue paths never matched (V193, V196, V208): residue families (`SiteResidueFamily`;
BackWPup's `^backwpup-restore-[0-9a-f]{20}$`) and `ProductConfig.resolveSiteDataDirs`, which the
`@plugin` hook prepares like declared paths (wordpress-automation.md → Left-over plugin data). A
killed run's directory is swept (V227). The fixed `uploads/backwpup-restore` stays declared while
builds up to `af1ab5c`, which write only it, may be installed (V226).

### 6H.0 — Plugin folders WordPress cannot see (done, 2026-10-21)

Product-agnostic. A removal a PHP-FPM restart or a reboot cuts short (V231) leaves part of a plugin
at its path, which blocked every later install (V229, V230, V270) or uninstall (V272). Facts: §2.10.
As built: wordpress-automation.md → [Plugin
lifecycle](../architecture/wordpress-automation.md#plugin-lifecycle-wpplugints) and [Plugin folders
WordPress cannot see](../architecture/wordpress-automation.md#plugin-folders-wordpress-cannot-see-wpplugin-dirts);
the hooks in `AGENTS.md`.

Rules: "absent" means nothing at the plugin's path; cleanup heals, removal under test judges (V233,
V275); only the cell's own slug is inspected (V282); a clean site pays one read (V276); `recognised`
is WordPress's own list (V283). A healed copy's fatals belong to the run that left it (V274), but a
failed uninstall of the artifact under test fails the teardown (V281); an active broken copy is
healed by the auth setup (V288).

Not covered: the cause on the servers (V231, operator settings); the old suite (`wp-rocket-e2e`, a
separate change); other half-finished writes a kill can leave.

### 6H — Storage credential surface

The half of the storage work that needs no credentials, so it ships in sequence while 6H.2 waits and
6H.2 becomes pure content. Today `ServiceConfig.storage` holds `ftp` and `s3` only
(`src/common/config/types.ts`, `BWP_FTP_*` / `BWP_S3_*` in `.env.example`).

- Config — typed `msazure`, `sugarsync`, `rsc`, `glacier` (with its `useS3Credentials`
  fallback), each with `.env.example` entries, load-time validation and per-site `overrides`.
- The services/overrides merge — not built yet. `src/common/config/sites.ts` only validates a
  site's `overrides` block, and nothing reads the product's `services` (`backwpup.config.ts`) or
  merges a site's overrides over them (configuration.md says so: "Validated only: not merged or read
  yet"; `ServiceOverrides`' TSDoc in `types.ts` still claims the merge). Check `sites.ts` first; then
  build the merge (product globals, site overrides on top), read through the bound site, or keep
  configuration.md's note and fix that TSDoc if 6H does without it.
- Skip gate — a scenario whose provider has no credentials skips with a named reason, never
  fails. Testable because credentials are absent: with an empty `.env` every storage scenario
  reports e.g. "skipped: BWP_FTP_HOST not set", not an error.
- Isolation helper — the `testInfo`-derived path / container name (§1.1), so parallel workers
  and repeat runs never collide once credentials arrive.
- Provider forms are markup, not network: `StorageSidebar`'s per-provider locators are already
  contract-tested (6B).

Docs (§5): configuration.md and `.env.example` for the storage service config.

Acceptance — `test:unit` covers the config validation, the merge if built, and the skip gate;
configuration.md says what is really merged; with no `.env` a storage scenario skips with its
provider named, and the run is green.

### 6H.2 — External storage round-trips (deferred)

Blocked on credentials: deferred by decision on 2026-07-30 (no storage credentials exist in this
environment; nothing else in Phase 6 depends on it). Needs 6H.

The 11 baseline storage scenarios, tagged per V2: only Glacier is `@pro`; FTP, S3, MS Azure,
Rackspace and SugarSync are untagged and run on both editions.

- Per provider: "configure in onboarding" and "configure from the dashboard", each ending in a real
  backup that lands on the remote, is verified there and then removed.
- Exercises `StorageSidebar.saveAndTestConnection()` (`cloudsaveandtest`) for the first time. Every
  key is typed with `StorageSidebar.fillSecret`, so no report records it (`AGENTS.md`).
- Teardown: remote cleanup is best-effort and logged; it never fails a passing scenario.
- Out of scope: Dropbox, Google Drive, OneDrive, HiDrive — interactive OAuth, no baseline coverage,
  no non-interactive credential path.

Unblocks when these land in `.env` (see `.env.example` after 6H): FTP and S3 at minimum; MS Azure,
Rackspace, SugarSync and Glacier for the full set.

Acceptance — each provider with credentials passes both scenarios and leaves no remote residue;
each provider without them skips with a clear reason.

### 6I — Free edition + parity gate

The `free@nginx` cell exists (`bwu.e2e.rocketlabsqa.ovh`, its own site and database): the untagged
suite runs there with no new scenario code (V64), and it defines `DISABLE_WP_CRON` like `pro@nginx`
(V44). It shares a host and a disk with `pro@nginx` (V72). Up to about four parallel suites per
server are allowed (operator, 2026-09-28; the orchestrator plan's 0A.3): name the sites a live run
uses first, and watch the shared disk.

Remaining:

- The `@free` locked-storage upsell scenario (V2); `StorageSidebar.expectStorageLocked` exists.
- Parity review against §2.1: every baseline intent is covered or has a written, deliberate
  reason not to be — a checklist in the PR, not a claim.
- **6I.1, restore parity** — the concrete restoration slice of that review.

Acceptance — `pro@nginx` and `free@nginx` green; the parity checklist complete; 6I.1 green; no
scenario is a transliteration of its baseline ancestor.

#### 6I.1 — Restore parity (Free/Pro)

Goal: the Free upload journey proves the same restore strategies and archive shapes as Pro's UI
history journey, without pretending the CLI is shared. 6G left the strategy matrix on Pro and gave
Free only the mixed full upload; this sub-phase closes that specific parity gap.

Depends on 6G (steps, page object, marker fixtures); it lands with 6I. It can run in parallel with
6J; it must land before 6K because both edit `restore.feature` and its steps. **Effort: 1–2 days;
difficulty: medium** — four new slow upload scenarios on one Free worker, no new product code.

Scope:

- Measure first: a Free upload of a mixed, a database-only and a files-only backup; confirm the
  screen offers the strategies 6G/V189 saw and the uploaded archive reaches the same wizard. Record
  the result in §2.9; if the Free upload path differs, fix the page object/steps before writing tests.
- Add four `@free` scenarios to `restore.feature` (the feature-level `@plugin @slow` applies),
  sharing the existing Background:
  - database-only restore of a mixed backup by upload;
  - files-only restore of a mixed backup by upload;
  - a database-only backup offers only Database Only by upload;
  - a files-only backup offers only Files Only by upload.
  The existing mixed **Full Restore** upload stays; the five Free UI scenarios then mirror the five
  Pro UI scenarios. Each asserts its own download/upload journey and that the Pro-only deep link is
  not offered, as 6G does.
- Keep the CLI restore Pro-only. Free ships no `restore` command (V4, V11, V94); the existing Free
  CLI registration scenario proves it is unknown. Do **not** add a Free `cli-restore.feature`
  duplicate. Record this in the 6I parity checklist as a product difference, not a missing test.
- 6K: keep the four format scenarios Pro-only by the existing V191 extractor decision. During 6I.1
  verify the Free upload path reaches the same extractor; if it proves format-sensitive, add the
  matching `@free` format scenarios to 6K. Otherwise the parity checklist records the measured
  reason.
- Update `authoring-tests.md` (Restoring) and `AGENTS.md` if the Free restore steps/page object gain
  a parameter or a new upload helper; no new page object unless the measurement requires it.

Acceptance:

- `free@nginx` runs five UI restore scenarios: mixed full, mixed database-only, mixed files-only,
  database-only backup (only Database Only), files-only backup (only Files Only); each restores the
  right half and leaves the other changed.
- `pro@nginx`'s five UI + four CLI restore scenarios are unchanged and green.
- The 6I parity checklist marks CLI restore as Pro-only by product design (V4/V11/V94) and records
  the 6K Free-format decision; no Free CLI restore test is expected.
- The Free run's added time is measured and the `@slow` budget is acceptable (6G's mixed upload
  measured 27.6 s download + 168 s upload for a 411 MB archive; two new scenarios upload that mixed
  archive, the two backup-only scenarios upload smaller ones).

### 6J — Staging area web guard

Product-agnostic; depends on nothing (may be pulled forward). Facts: §2.12
(V134, V142–V145).

The gap. The staging area is in the docroot, and the web server serves whatever it can read
there (V134). From a worker's first install to its teardown — hours — the plugin zip under test can
be downloaded, BackWPup Pro's included, and on Apache a staged `.php` would run (V142). The area
stays as it is — location, modes, cleanup, the private folder's `0700`. 6J tells the web server not
to serve it, and has every run measure whether it listened.

1. The `.htaccess` guard — Apache, and any server that honours `.htaccess`.
`src/common/wp/staging-guard/staging.htaccess`, copied to the staging root as `.htaccess`:

```apache
<IfModule mod_rewrite.c>
	RewriteEngine On
	RewriteRule !^public(?:/|$) - [F]
</IfModule>
<IfModule !mod_rewrite.c>
	Require all denied
</IfModule>
```

- Everything answers 403 except the top-level `public/`, which keeps the server's normal handling
  (V142). The pattern is relative to the root, so `plugins/public/` stays denied. Nothing creates
  `public/`: it is reserved for an artifact a plugin must fetch over HTTP (the one use the staging
  docs call useful today), exported as `PUBLIC_CATEGORY`. Code staged there would run, so it never
  holds any.
- Fails closed in every setup but `AllowOverride None` (V143) — which is what the probe is for.
- One writer. `stageArtifact` is the one way files are staged; BackWPup's private folder
  (`support/private-folder.ts`, PHP's `wp_mkdir_p`) is the only other code that creates the root. A
  new `prepareStagingArea(transport, ...path)` creates the directory, writes the guard and returns
  the path; both call it, so nothing is staged into an area without its guard.
- Rewritten on every call, atomically: uploaded under a temporary name, then renamed over the
  old one. `mkdir -p` cannot say whether it created anything, a per-process memo goes stale when
  something else removes the area, and an in-place rewrite that truncated would leave an empty guard
  before files already staged. It goes through `copyIntoTarget` from the committed file: no shell
  string, nothing to escape. Its cost (two small round trips per staging call) is measured in
  verification.
- The one staged file the web server reads. It keeps the transport user's ownership like
  everything staged; the default umask makes it `0644`, and a guard the server cannot read fails
  closed (V143). The ownership rule's "only the transport user ever reads it" names it as the
  exception.

2. The pre-flight probe — a report, never a gate. Per site, once the transport checks pass,
beside "File ownership" and "Elevation":

- Stages through `stageArtifact`, the production path, so it measures what a run gets, guard
  included. The probe is a `.zip` (the extension really staged) holding a random token, in a
  category with a random name, so two sites sharing an absolute root, or a healthcheck beside a run,
  never meet.
- Fetches it at `baseURL` plus the root's path relative to the WordPress root (the suite's
  standing assumption that the WordPress root is served at `baseURL`). A root outside the WordPress
  root is not probed, and the check says so.
- Judges by content. "Served": the token came back, redirects followed (an http→https hop still
  counts). "Not served": any other answer — 403, 404 (WordPress's own page on these cells, V145),
  500, a login page. "Could not check": no answer within a bounded wait (timeout, TLS, DNS), never
  reported as safe (V145).
- Cleans up after itself. The probe's category is removed whatever happened. The root and its
  guard stay: a run's teardown removes them, and after a healthcheck they wait for the next run's,
  since removing a root the probe did not create would pull it from under a concurrent run. This is
  the first pre-flight check that writes to a site; the docs say so. A root that cannot be written
  is "could not check" with the staging error; the first install still fails on it, as today.
- Reports an always-passing `CheckResult` — `Staging exposure: not served (403) — <url>`,
  `served over HTTP`, `could not check: …`, `not probed: …` — plus a typed field the banner reads,
  as `elevation` is.
- Warns when any site is served: a run-level banner printed from the same two places as the
  elevation banner (the auth setup to stderr, the healthcheck to stdout) by one function. Per site:
  the URL that returned the probe's content; what that exposes (anything staged, the plugin under
  test included; on Apache staged code would run); the answer's `Server` header. Then the remedies:
  - nginx — include `staging.nginx.conf` (its absolute path on this runner) in the site's
    `server {}` block, then `nginx -t` and reload;
  - Apache, or another server that reads `.htaccess` — the guard is in place but ignored; on Apache,
    allow `FileInfo` overrides for the docroot;
  - any server — move the staging area out of the docroot with the site's own `transport.stagingDir`
    (absolute, one per site): no server change, gives up only `public/`.

Server detection is that `Server` header and nothing more: free with the probe's answer, shown and
never acted on — a CDN or proxy answers with its own name, and the verdict measures the effect.

3. The nginx include. `src/common/wp/staging-guard/staging.nginx.conf`:

```nginx
location ^~ /.e2e_temp/ {
    deny all;
}
location /.e2e_temp/public/ {
}
```

- The same rule as the guard (V142). `^~` makes it independent of its position in `server {}`
  (V144); `public/` is a plain prefix, so the vhost's own regex locations still apply there, as
  Apache's normal handling does.
- Written for the default layout; its header says to adjust both paths for a WordPress served from a
  subdirectory or a moved staging area, and that a duplicate `location` fails `nginx -t`.
- Baked into the docker env's nginx through a `COPY --from` of a Compose `additional_contexts` entry
  (proven on this runner's Compose v5.5.1), so the image still needs no host bind. The local nginx
  cell then runs with it, and every pre-flight there re-proves the committed file on a real nginx.

Keeping the two guards in sync — one rule in two languages:

- An `AGENTS.md` MUST, beside the ownership one: change one guard, change the other in the same
  change, keep the drift spec green, re-probe the docker Apache and nginx cells.
- Each file's header names the other and that rule. The `.htaccess` header is what an operator finds
  on a site, so it also says what wrote it and that the suite removes it.
- A drift spec reads both files: each denies `DEFAULT_STAGING_DIR` and exempts exactly
  `PUBLIC_CATEGORY`, at the top level only. It catches a renamed default or exemption; what the
  rules do is what the live checks and the docker include prove.

Docs: wordpress-automation.md (the staging Exposure bullet becomes the guard, the probe and
`public/`; the ownership rule's exception), configuration.md (the include; `transport.stagingDir` as
the remedy needing no server change),
[execution-model.md](../architecture/execution-model.md#the-auth-setup-and-the-health-check)
(pre-flight's reports, the healthcheck's checks), `AGENTS.md` (the staging bullet, the MUST; its
pre-flight summary if a gate changes), `README.md` (an operator note beside the Docker env),
`.env.example` (the staging comment).

Unit coverage — the policy is pure, the I/O thin; mutation-checked:

- Nothing is staged before its guard: call order on a recording transport, for `stageArtifact` and
  the private folder, the rename after the upload.
- URL mapping: a root inside and outside the WordPress root, relative and absolute overrides, a
  `baseURL` with a path, with and without its trailing slash (`new URL` drops a base's last segment
  without one), segments encoded.
- Verdicts: the token → served; a 200 with anything else → not served; 403/404/500 → not served; a
  throw or timeout → could not check; the probe's category removed on every path, a throwing fetch
  included.
- The banner: silent when nothing is served; per site the URL, the `Server` value, every remedy and
  the include's path; identical text from both entry points.

Verification — with Docker up (the user starts it):

1. Docker Apache cell (`:8100`): not served (403). With the guard deleted by hand: served, and the
   banner.
2. Docker nginx cell (`:8101`): with the include baked in, not served. Built without it: served, and
   the banner with `Server: nginx/…` and the include's path.
3. `public/` on both: a file there answers 200, one beside it 403, `plugins/public/` 403.
4. `pro@nginx` and `free@nginx`: served, and the banner, until the include is in their vhost — an
   operator change on the QA host, the user's to make; after it, not served. Record the probe's cost
   per site.
5. The full BackWPup suite on one nginx cell: installs undisturbed; after the teardown no staging
   area, guard included.
6. `pro@apache`, the one real Apache, only with the user's go-ahead (AutoE2E runs on that server).

Acceptance — nothing is staged into an area without its guard; "served" means the probe's own
random content came back, and no answer is never reported as safe; the banner is silent on both
docker cells and present on an unprotected one, with the URL, the server's own name and every
remedy; the two guard files cannot drift apart silently.

### 6K — Restore from every archive format

`@pro`; needs only 6G; last in the sequence because it reuses 6G's steps whole. Required to close
Phase 6, not deferred. 6G restores `.tar`, the default; BackWPup also writes `.zip` and `.tar.gz`
(V190), each unpacked by different code — three extractors in the UI, three more in the CLI (V191).

- One axis, not a matrix. The extractor is chosen by extension, never by content (V191), so
  every scenario restores a mixed backup (the only one sending files and a database dump through the
  extractor) with a full restore. Contents and strategy stay 6G's.
- The backup is made after onboarding, in its format. Onboarding can only produce `.tar`: it
  offers no format and its save reads three keys, none of them the format (V39, V190). The setup
  onboards as 6G does, switches the onboarded job's archive format, then runs the backup the
  scenario restores. Measure first which route switches it the way the plugin does — the job's
  settings screen, or 6F.4's `job-import`, which merged a format change (V159). Assert the resulting
  backup carries the asked extension: a fallback to `.tar` (`inc/class-admin.php:902-907`) would
  otherwise pass every scenario as a `.tar` restore.
- Both entry paths, both formats — the UI and the CLI share no extractor:

| Scenario | Format | Entry |
| --- | --- | --- |
| Restore a `.zip` backup in place | `.zip` | history deep link |
| Restore a `.tar.gz` backup in place | `.tar.gz` | history deep link |
| Restore a `.zip` backup over WP-CLI | `.zip` | `wp backwpup restore` |
| Restore a `.tar.gz` backup over WP-CLI | `.tar.gz` | `wp backwpup restore` |

- No `@free` format scenarios: Free's upload journey ends in the same, byte-identical extractor
  (V191). 6I.1 verifies this from the upload side; add the matching `@free` scenarios here only if
  the upload step treats a format differently.
- Out of scope: `.tar.bz2` — no longer offered, and the restore refuses it (V190). Archive
  inspection (`wp/archive.ts`) stays tar-only: these scenarios read the restored markers, never the
  archive.

Acceptance — each of the four restores the markers on both sides; each fails if its backup was
not made in its format; the restore steps are 6G's, unchanged — only the setup differs, by the
format switch.

## 5. Definition of done (phase-level)

- Every §2.1 intent is ported, superseded, explicitly declined or explicitly deferred in writing.
  One deferral may stay open: 6H.2's 11 storage round-trips, blocked on credentials — allowed only
  because 6H ships the config, the skip gate and the isolation helper, so 6H.2 adds scenarios and
  nothing structural. 6K is no deferral: Phase 6 closes only once a backup in every archive format
  the plugin writes (V190) has been restored.
- `pro@nginx` and `free@nginx` green; `@pro`/`@free` scenarios run only on their edition's cells.
- Restore parity (6I.1): Free's upload journey covers the five Pro UI strategies; CLI restore is
  Pro-only by product design (V4/V11/V94); the 6K Free-format decision is recorded.
- The lint gate green (`AGENTS.md` → Improvement gate).
- Every page object has a locator-contract spec; `npm run test:unit` green.
- Docs updated by whoever changed the code: authoring-tests.md (fixtures, page objects, tags),
  configuration.md (storage service config), `AGENTS.md` (fixtures), `.env.example`.
- The parent plan's Phase 6 entry is a pointer to this plan.
- Retries: 2 everywhere, local runs included (`E2E_RETRIES` overrides;
  `src/common/config/project.ts`), set after the user asked whether 0 retries for local runs is
  right. Confirm or change before Phase 6 closes.

## 6. After Phase 10 — WP Rocket

Deferred (decided 2026-10-06): WP Rocket's port starts once Phase 10 (cleanup & validation) is done.
Phase 6 closes on BackWPup alone (§5).

Prerequisite (met 2026-11-17): the [phase-12 plan](phase-12-site-identity-plan.md)'s Part B (12.12–12.16: install
outputs, licence, settling request, deactivation recovery, in-place `.htaccess`/`wp-config.php`
cleanup, one lifecycle scenario).

First task, before any WP Rocket scenario is ported: declare its WP-Cron hooks in its leftover
sweep (`cronHooks` in `src/projects/wp-rocket/support/db-residue.ts`; BackWPup's need was V299).
Its 3.24.1 source lists 18 (`WPRocketUninstall::$events`). Six of them carry none of its
`optionsContaining` fragments (e.g. `rocket_cache_dir_size_check`,
`action_scheduler_run_queue_rucss`), and every declared hook must carry one. So first measure on
a twin what a wider fragment set would also sweep from the options. Then add the fragments, or
change the rule if a fragment would reach options that are not WP Rocket's. Prove it live: plant
an event of each hook, then run a `@plugin` scenario.

WP Rocket reuses 6A unchanged and the same recipe: page objects first, then features. Its baseline
is much larger (`src/features/`, `src/specs/`, `src/support/steps/`, the 921-line `page-utils.ts`,
the 486-line `sections.ts`) and brings what BackWPup does not: `@mobile` (6A), settings
export/import diffing, the `@visual` A/B scenarios (`expectOptimizedToMatchUnoptimized`, shipped),
third-party plugin interactions, and the `previous` artifact role for update paths. It gets its own
sub-phase breakdown, from the same verified-source discipline, when that work starts — not guessed
here.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| Markup drift as `develop` moves | Zero drift measured at each ref used (§2.2, V38); the locator-contract specs, over markup captured at the ref, turn drift into one unit-test failure. Re-diff before each capture (6B). |
| Storage credentials missing or rate-limited | 6H.2 is deferred off the critical path; 6H's scenarios skip, never fail, without credentials; per-site `overrides` for rate-limited hosts (the merge is 6H's to build); `testInfo`-derived names isolate workers. |
| A restore rewrites the site under test | 6G's markers judge each half; `cliRestore` guards the command-line restore (V205–V207); every scenario reinstalls and ends as found. 6K reuses both. |
| Backup jobs are slow | `@slow` for CI splitting; real barriers instead of long fixed timeouts; database-only jobs where contents do not matter. |
| A fresh install that is not fresh | BackWPup's activation runs in whichever request reaches `init` first, and a racing second request deletes the onboarding flag (V46, V122): `finishActivation()` detects a lost race and redoes the install — up to three installs, each reported. A lost race can also fatal in the plugin's migration (V174): the debug-log gate fails that scenario and the retry absorbs it. A leftover table blocking the install (V47) is swept by 6E.0. Report upstream: activation should not be re-entrant; uninstall should be the last word on its own table. |
| A removal cut short blocks every later install | Seen in AutoE2E (V229–V231); this suite survives it since 6H.0 (V270–V277). The kills are the operator's to schedule. |
| Staged files served by the web server | 6J. The `.htaccess` guard fails closed wherever it cannot apply (V143); nginx needs the include in the vhost — an operator change the suite reports every run but never makes. |
| Scope creep from "improve" | The improvement budget is §1.1 plus the V-facts; anything else is a follow-up issue. |

## 8. Verification sources

- Baseline: `wp-rocket-e2e/src/backwpup/**` (12 features, 28 scenarios), `utils/page-utils.ts`,
  `utils/commands.ts`, `config/wp.config.sample.ts`, read at `develop` (2026-07-28).
- Plugin: BackWPup 5.7.4 Free and Pro from `~/.apvm/cache/backwpup/releases/5.7.4/` — `components/`,
  `pages/`, `parts/`, `inc/`, `src/Cli/`, `src/**/API/Rest.php` (V1–V13). The ref under test first
  `c0dd22c2` (APVM version `9.99.99`, `~/.apvm/cache/backwpup/commits/9.99.99/c0dd22c/`:
  `backwpup-pro-en-…zip` is what the cells install, `backwpup-…zip` is Free); every later ref in
  §2.2.
- Target: this repository's working tree.
- WP-CLI: `wp cron event run <hook>` semantics — WP-CLI handbook, `commands/cron/event/run.md` (and
  V40, which contradicts it).
