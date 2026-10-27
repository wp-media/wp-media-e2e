# Authoring tests

Tests are **BDD**: Gherkin `.feature` files describe behaviour, step definitions implement it, and
`playwright-bdd` generates Playwright specs from the pair.

## The BDD pipeline

```
.feature  +  step definitions   ──bddgen──▶  generated specs  ──playwright──▶  run
(Gherkin)    (TypeScript)                     (.features-gen/, git-ignored)
```

The `test:*` scripts run `bddgen`. `.features-gen/` is ephemeral: never edit or commit it.

## Where things live

```
src/
├── common/                       # product-agnostic, shared by every product
│   ├── fixtures.ts               # the base test instance + Given/When/Then exports
│   ├── steps/                    # generic steps (e.g. world.steps.ts)
│   ├── hooks/                    # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── pages/                    # cross-product page objects (plugins.page.ts, site-health.page.ts) + secret-field.ts
│   ├── visual/                   # visual helpers (ab.ts, screenshot.ts, …)
│   ├── config/devices.ts         # desktop & @mobile device profiles
│   ├── artifacts/                # the plugin zips under test (see ../architecture/plugin-artifacts.md)
│   └── wp/                       # WordPress automation (see ../architecture/wordpress-automation.md)
├── projects/products.ts          # the one product list (see "Adding a product" below)
└── projects/<product>/
    ├── config/<product>.config.ts   # ProductConfig + sites.json/sites.*.json/sites.example.json
    ├── fixtures.ts                  # this product's test instance: common's + its page objects
    ├── features/**/*.feature        # this product's scenarios
    ├── pages/**/*.ts                # this product's page objects (+ their locator specs)
    ├── steps/**/*.ts                # this product's steps
    └── support/                     # debug-log presets, REST barriers, WP-CLI readers (arranging)
                                     #   and the CLI runner for when the command is under test
```

A product's `steps` array (in its config) is exactly what loads at runtime: `common/fixtures.ts` +
the product's `fixtures.ts` + `common/hooks/**/*.hooks.ts` + `common/steps/**` + the product's
`steps/**`. So a product step is available to that product only, and **a hook file missing from the
array never registers** — its lifecycle is silently absent. Add shared hooks as
`src/common/hooks/<name>.hooks.ts` so the glob picks them up.

### Adding a product

1. `src/projects/<name>/config/<name>.config.ts` exports its `ProductConfig`: `name: "<name>"`,
   features and steps under `src/projects/<name>/`, its artifact manifest
   ([plugin-artifacts.md](../architecture/plugin-artifacts.md)), and a committed `sites.example.json`
   beside it.
2. List it in `PRODUCTS` ([`src/projects/products.ts`](../../src/projects/products.ts)).
3. Create root `playwright.<name>.config.ts`: `import "./src/common/config/load-env"`, then
   `export default createProductConfig(<its config>)`, importing only that product.
4. Add the `test:<name>` script (`bddgen` then `playwright test`, each with
   `--config playwright.<name>.config.ts`) and its `:ui` / `:headed` variants.
5. Add its `@noauth` smoke step to `.github/workflows/ci.yml` once it has a `@noauth` scenario (before
   that, the step fails "No tests found"; without the step, CI never runs the product).

`products.spec.ts` fails until folder, list, entry config and script agree; it does not check the CI
step or the example sites file.

## Fixtures ([`src/common/fixtures.ts`](../../src/common/fixtures.ts))

Import `Given`, `When`, `Then`, `Before`, `After`, … from a `fixtures.ts`, **never** from
`playwright-bdd`, so they bind to the extended test instance: your product's `fixtures.ts` if it has one
(BackWPup does), giving steps its page objects; `common/fixtures.ts` only for product-agnostic steps and
hooks.

| Fixture            | Scope      | What it gives you                                                                                                                                                                                                                                                       |
| ------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site`             | test       | The [`SiteConfig`](../../src/common/config/types.ts) bound to this worker. Throws if no pool.                                                                                                                                                                           |
| `edition`          | test       | The cell's `Edition` (`free`/`pro`). **Throws** in an editionless cell.                                                                                                                                                                                                 |
| `boundSite`        | worker     | The site pinned to this worker (by `parallelIndex`), or `undefined` with no pool. Underpins `site`.                                                                                                                                                                     |
| `pluginArtifact`   | test       | `pluginArtifact(role)` → the cell's resolved zip (`"plugin"` under test, `"previous"` to compare against). `.slug` is its plugin directory (no edition branching); `.zipPath` feeds `stageAndInstallPlugin`. **Throws** for an unsupported role or when the artifacts setup did not run ([plugin-artifacts.md](../architecture/plugin-artifacts.md)). |
| `releaseBoundSite` | worker     | Automatic: after the worker's last scenario, removes the site's staging area and closes SSH connections, best-effort ([teardown](../architecture/wordpress-automation.md#worker-teardown-wpteardownts)).                                                              |
| `drainGate`        | test       | Automatic: once the run's stop file (`E2E_INTERNAL_STOP_FILE`) exists, skips each scenario's first attempt as `stopped` ([the drain](../architecture/execution-model.md#stopping-a-run-the-drain)).                                                                                               |
| `context`          | (override) | The browser context, watched for the **site's own** requests that never arrived (`requestfailed` but `net::ERR_ABORTED`; a 5xx document, script or stylesheet). A failed scenario that lost any prints one `[page-loads]` warning and attaches `page-load-failures`, grouped by page, at most 50 listed, URLs as paths (query cut to `page`/`step`/`tab`/`action`, hex runs of 16+ masked). Never fails a run ([`reporting/page-loads.ts`](../../src/common/reporting/page-loads.ts)). |
| `baseURL`          | (override) | The bound site, so relative navigations target it.                                                                                                                                                                                                                      |
| `storageState`     | (override) | The bound site's saved login, **or** an empty session for `@noauth`.                                                                                                                                                                                                    |
| device options     | (override) | `viewport` / `userAgent` / `isMobile` / `hasTouch` / `deviceScaleFactor`: the `@mobile` profile, else the desktop default.                                                                                                                                              |

Use `site.transport` for the WordPress automation layer and `page` for the browser. Install the zip
under test (already built and verified by the artifacts setup) with
[`stageAndInstallPlugin`](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts):

```ts
const artifact = pluginArtifact("plugin");
await stageAndInstallPlugin(site.transport, artifact.zipPath, {
  activate: true,
  // Always pass the slug: it lets the install hand the plugin's files back to the site's ownership,
  // so the web server can write them.
  slug: artifact.slug,
});
```

> **`zipPath` is a path on the _runner_.** `installPlugin` alone works only on `local`, which shares the site's
> filesystem; on
> `ssh`/`docker` the remote `wp` cannot see it, so it must be copied over first — what
> `stageAndInstallPlugin` does (`stageArtifact` for other files).

### BackWPup's fixtures

[`src/projects/backwpup/fixtures.ts`](../../src/projects/backwpup/fixtures.ts) adds page objects:
`onboarding`, `firstBackup` (where onboarding hands over and the first backup runs), `dashboard`,
`dataSelection`, `frequency`, `storages`, `jobRun`, `backupHistory`, `restore` (edition-aware: Pro's
in-place restore, Free's forced upload) and the shared `plugins`. They are built lazily: a scenario
pays only for what it destructures.

**`cli`** runs one `wp backwpup …` subcommand and remembers the result for the next step to judge
([`support/cli-session.ts`](../../src/projects/backwpup/support/cli-session.ts)). It is for the feature
where the **command is the system under test**: a non-zero exit is an observation, so nothing throws
for an outcome and a scenario can assert how a command refused. When WP-CLI only _arranges_ or
_checks_ a site use `support/backups.ts`, which throws (a failing command there means the setup broke).

The CLI steps ([`steps/cli.steps.ts`](../../src/projects/backwpup/steps/cli.steps.ts)) are generic,
because there the command line _is_ the product language:

```gherkin
When I run the BackWPup command "job --format=count"
Then the command succeeds
And it prints "1"
```

Also `Then the command fails`, and `Then it reports the error "…"` / `the warning "…"` /
`the success "…"`; these last three match WP-CLI's `Error:` / `Warning:` / `Success:` lines by **level** and the
text as a substring (a refusal spread over several stderr lines — `Parameter errors:`, then the
parameter — is one message). Step text rules, each refused rather than run:

- the `wp backwpup` prefix is supplied, not repeated;
- arguments split on whitespace, so a value needing quoting or escaping needs its own step;
- WP-CLI globals deciding _where_ the command runs (`--path`, `--url`, `--ssh`, `--user`,
  `--skip-plugins`, `--exec`, …) are refused: WP-CLI honours them anywhere on the line, and the runner
  already targets the scenario's site. Output-only `--debug`, `--quiet`, `--[no-]color` are allowed.

**Placeholders** ([`support/placeholders.ts`](../../src/projects/backwpup/support/placeholders.ts)): what
the plugin allocates or names is written in braces and read when the command runs:

| Placeholder                                                    | Value                                                                                           |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `{job}`                                                        | the scheduled job's id                                                                          |
| `{oldest backup}` / `{newest backup}`                          | the archive of the scenario's first / latest backup, fixed as made                              |
| `{oldest log}` / `{newest log}`                                | the log of the first / latest run in the backup history                                         |
| `{path to the oldest backup}` / `{path to the newest backup}`  | that archive as a path from WP-CLI's working directory (the WP root) — how `backup-encrypt` / `backup-decrypt` take one |
| `{private folder}`                                             | the scenario's own folder on the site, relative to WP-CLI's working directory                               |
| `{encryption key}` / `{another encryption key}`                | two hex keys drawn for the scenario                                                             |
| `{public key file}` / `{private key file}`                     | an RSA pair drawn for it, placed in the private folder                                          |
| `{path from the log folder to the marker file}`                | a path out of BackWPup's log folder to the `markers` file, proved on the site to lead there      |

So `When I run the BackWPup command "backup-delete {oldest backup} --yes"` sends one real file name.
Each value is read only when used and must fit one argument. Anything in braces is read as a placeholder name, so an unknown one
(`{job_id}` for `{job}`) is refused, listing the known ones, and so is a stray brace. The text as written may not name a path off the site
(absolute, or climbing out with `..`): it could reach another site's files, so a path reaching further
comes from a placeholder the suite proves. A `--key=` value never appears in a message about the
command (a failed assertion via `describeCli`, a time limit, a JSON parse error): each names it through
`commandLine`, and the output hides it too. A command that **blocks** on a running job (`status`)
uses `When I watch the running backup with the BackWPup command "…"`, given a backup's length as a budget of its
own and failing with the command's name if it never answers.

A second opinion comes from a source the command has no hand in — the stored jobs
(`support/job-options.ts`), the backup history table (`support/history.ts`), the resolved zip — never
the same command in another format.

**`Then the command succeeds` only proves exit 0, which is not success for a command that changes
the site.** WP-CLI's own refusals and `WP_CLI::error()` exit 1, but some BackWPup commands exit 0 after
failing: a foreground `run` never reaches its verdict (the job ends the WP-CLI process, whatever it
logged); `run <id> --background` succeeds for a job id the site lacks; a `restore` failing midway only
warns; a `log-delete` refused a log it may not write still reports success; plugin code ending in PHP's
`exit( 'message' )` prints no status line. A destructive command **without `--yes`** stops at a `[y/n]`
prompt nobody answers and exits 0 having done nothing (`Then it asks "…"` asserts the prompt). The
reverse too: after one refused `backup-delete`, the next deletes its archive and still exits 1 with the
earlier error. So always pair either step with a second source (history row, log, marker, file on disk), and
assert a refusal as the command makes it (`Then it reports the warning "…"` where it only warns). The
cases, and which are measured live: §2.16–§2.19 of the
[feature-porting plan](../plans/phase-6-feature-porting-plan.md).

**A job still running when the next command arrives needs arranging.** A database backup of the cells
takes about a second, under one WP-CLI round trip, so
[`cli-running-job.feature`](../../src/projects/backwpup/features/cli-running-job.feature) sets two
BackWPup settings (`Given BackWPup's "…" setting is "…"`, refusing values the Settings screen does not
offer): **Reduce server load** `maximum` stretches the run to several seconds, and **Maximum number script execution time
(in seconds)** (the screen's own words) `0` keeps it in one request (otherwise the plugin hands a long run to a fresh request
midway, and a command landing in the handover is answered about a job briefly not
there). The pause is per **table**, so the paced run's length is the table count: 3.5 s
on a site with 18 tables, barely longer than a command takes. `Given the site's database holds at least 100
tables` pads with empty tables of the scenario's own (`<prefix>e2e_pace_NNN`), ~11 s on every cell; the
**`tablePadding`** fixture drops them after the `@plugin` teardown, so no backup is still dumping them
([`support/table-padding.ts`](../../src/projects/backwpup/support/table-padding.ts)). A run killed before
then leaves them, so every BackWPup worker drops leftover padding before its first scenario
(`leftoverPaddingSweep`, automatic) and says how many; with fixed names and each padding dropping the
last first, a site never holds more than one padding. The snippets run against a fake `$wpdb` in
[`table-padding.php.spec.ts`](../../src/projects/backwpup/support/table-padding.php.spec.ts) (skipped
without PHP).

Fixtures for commands acting on files:

- **`archives`** records each archive's digest as the scenario's backups make it, so "still on the
  site, byte for byte" compares against the run's own output and "the oldest backup" means one file for
  the whole scenario. Backup-making steps (`Given the scheduled job has made 2 backups inside WP-CLI`,
  or `… through the web server`, which decides file ownership) record into it
  ([`support/archive-snapshot.ts`](../../src/projects/backwpup/support/archive-snapshot.ts)).
- **`privateFolder`** is the scenario's own folder in the site's staging area, for files a command
  writes or reads (a download, an export, a key). Private to the transport's user, because the web
  server serves what it can read there and a file may be a whole database; handed over by a path worked
  out on the site from where the folder and WP-CLI really are, so a symlink cannot redirect it. Free
  until used; removed afterwards only if used
  ([`support/private-folder.ts`](../../src/projects/backwpup/support/private-folder.ts)).
- **`keys`** draws the scenario's encryption keys when a placeholder first names one
  ([`support/encryption-keys.ts`](../../src/projects/backwpup/support/encryption-keys.ts)).
- **`jobExports`** records a digest of the site's jobs as each export is arranged — what "the site's
  backup jobs are as they were" compares against
  ([`support/job-transfer.ts`](../../src/projects/backwpup/support/job-transfer.ts)).

**`markers`** ([`support/markers.ts`](../../src/projects/backwpup/support/markers.ts)) plants a random
value in a file under the content directory and another in a `wp_options` row, so a scenario can ask an
archive whether a backup really captured the site — or, the file being outside every BackWPup folder,
ask a log command given a path out of its folder whether it reached that file. Because it touches the
site:

- **Requesting it is the side effect**: the values are planted when it resolves (before the test body,
  so before any step) and removed best-effort in teardown. Destructuring it _changes the site_.
- **Resolve it before the backup under inspection**: a marker planted later cannot be in that archive,
  and the assertion would fail for the wrong reason.

**Restoring** ([`restore.feature`](../../src/projects/backwpup/features/restore.feature),
[`cli-restore.feature`](../../src/projects/backwpup/features/cli-restore.feature)) is judged by the same
markers: back up, then `Given the site's marker data has changed since that backup` plants fresh values
(kept by **`changedMarkers`**); after the restore each marker must hold the backed-up value where the
restore was meant to reach and the changed one elsewhere. The wizard is the edition's **`restore`** page
object (Pro's deep link, Free's upload); the command is
`When I run the BackWPup restore command "restore {path to the newest backup} --yes --type=…"`, through
**`cliRestore`**. What the steps handle on a shared cell, and a new restore step must too:

- A files restore puts back the archive's `debug.log`, so the log so far is judged first by the
  `@plugin` gate's rule (`checkDebugLog`): before the command, and in the wizard again just before
  "Start" (`restoreWith`'s `beforeStart`).
- The restore working directory must be writable by the web server: `handRestoreWorkingDirToSite`
  before driving the wizard (WP-CLI may have written there while arranging the backup).
- `wp backwpup restore --type=file|full` replaces `wp-content` wholesale and `--type=db|full` drops and recreates the
  database, so the command runs only through `cliRestore` (the generic step refuses it). It refuses a
  database holding anything the backup cannot bring back and a relocated `wp-content`; copies
  `wp-content` first (as root, into a root-only `<root>/.e2e_content_copy/`; without passwordless
  `sudo` it refuses and the command does not run), puts it back exactly after the scenario, resets the
  database's default collation, and removes the scenario's own `--pre-backup` snapshot. A copy that
  could not go back stays, and BackWPup runs refuse that site until someone settles it (the message
  says how) — or, once provably orphaned (used by no process, and holding none to put back or stamped
  by another boot of the host), the auth setup or a worker settles it itself
  (`support/content-copy-leftover.ts`).

## Tags

| Tag              | Effect                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@noauth`        | Starts unauthenticated with an empty session (login/logout flows). The only tag that runs on placeholder sites, so CI's smoke job greps it.                                                                                                                                                                                                                                                         |
| `@plugin` | Before: clears `debug.log`, stops work a killed run left the plugin doing, removes any existing copy, sweeps leftover database rows, then freshly installs + activates the plugin under test. After: **a PHP fatal anywhere in `debug.log` fails it**; leftover work is stopped (`ProductConfig.stopRunningWork`), then the plugin and the files and rows it left are removed. Needs a real site. A scenario the drain skipped gets neither hook. |
| `@mobile`        | The mobile device profile (viewport + `isMobile` + `hasTouch` + mobile UA + DPR). Untagged stays desktop.                                                                                                                                                                                                                                                                                           |
| `@smoke`         | Scaffolding/smoke scenarios; `--grep @smoke`.                                                                                                                                                                                                                                                                                                                                                       |
| `@free` / `@pro` | Edition scoping, automatic in an edition-ful cell: a `pro` cell skips `@free` and vice versa.                                                                                                                                                                                                                                                                                                                                         |
| `@visual`        | Visual-regression scenarios; `--grep @visual`, run in the Playwright container.                                                                                                                                                                                                                                                                                                                     |
| `@slow`          | Takes minutes by nature (a real restore), so CI can split fast from slow; playwright-bdd triples its timeout (`test.slow()`).                                                                                                                                                                                                                                                                       |

`@plugin` and `@mobile` live in shared code: see
[AGENTS.md → Shared scenario hooks](../../AGENTS.md#shared-scenario-hooks) and
[Device profiles](../../AGENTS.md#device-profiles-desktop--mobile).

```gherkin
@plugin
Scenario: A backup lands in the history
  # the plugin is already installed, active and logging into a clean debug.log here
```

## Page Object Model

UI interactions live in page objects, not steps: cross-product under `src/common/pages/`, a product's
under `src/projects/<product>/pages/`. [`PluginsPage`](../../src/common/pages/plugins.page.ts) is the
reference: it owns wp-admin's Plugins screen (`goto`, `isInstalled`, `isActive`, `activate`,
`deactivate`, `delete` — the asserted flow — and `ensureAbsent`, idempotent cleanup), throwing the typed
errors of [`wp/errors.ts`](../../src/common/wp/errors.ts).
[`SiteHealthPage`](../../src/common/pages/site-health.page.ts) reads Site Health's "Copy site info"
text for the auth setup's site versions; only the requested fields leave the page (`siteInfoFields`),
since a trace records what a call returns and a locator's wait logs the element with its attributes.

### Typing a secret

Playwright titles a `fill()`, `type()` or `pressSequentially()` step with its text, so the value lands
in the HTML report, Allure results and every retained trace (a boxed step hides nothing). Type a
password, key or token with [`enterSecret`](../../src/common/pages/secret-field.ts) and check it with
`holdsSecret`: set and compared in the page, never a step's title, parameter or result; the field must
be visible and editable, as for `fill()`. A page object wraps them for its fields
(`StorageSidebar.fillSecret` for a storage key). A **scenario's** trace still records the value in its
DOM snapshots, and a failed scenario's `error-context.md` in its page snapshot: treat both as
credentials. Non-secrets keep `fill()`, whose report entry helps.

### Registering a product's page objects as fixtures

A product extends the shared instance in its own `fixtures.ts`, so steps destructure page objects and
`common/` never imports product code:

```ts
// src/projects/<product>/fixtures.ts
import { createBdd } from "playwright-bdd";
import { test as base } from "../../common/fixtures";
import { DashboardPage } from "./pages/dashboard.page";

export const test = base.extend<{ dashboard: DashboardPage }>({
  dashboard: async ({ page }, use) => { await use(new DashboardPage(page)); },
});
export const { Given, When, Then, Before, After } = createBdd(test);
```

List that file in the product's `steps` array and import `Given`/`When`/`Then` from it:

```ts
When("I start a backup", async ({ dashboard }) => { await dashboard.openBackupNow(); });
```

playwright-bdd picks per scenario the **most-extended** instance among its steps', so product and
common steps mix freely. If the product's `fixtures.ts` is missing from `steps`, generation fails
("Can't guess test instance") rather than silently dropping the page objects.

### Locator policy

1. `getByRole` / `getByLabel` with the visible name — the default.
2. The application's own **JS contract hooks** (BackWPup: `js-backwpup-<trigger>`, `data-content`,
   `data-backup-id`, `data-job-id`, `data-storage`) when there is no accessible name (an icon-only
   button, a visually-hidden `aria-hidden` checkbox). Stable because the app's own JavaScript binds to
   them.
3. **Never** structural CSS (`td:nth-child`, `header:has(h1) button.…`) or text matching on a whole
   subtree; enforced by lint and review.

Rule 1 assumes an English admin, which the auth pre-flight asserts per site (`determine_locale()`), so
a translated site fails once, clearly, instead of as many locator timeouts.

Every non-trivial page object has a **locator-contract spec**: capture the real rendered markup,
replay it, assert each locator resolves
([`locator-contract.spec.ts`](../../src/projects/backwpup/pages/locator-contract.spec.ts)). Capture
the fixture, never hand-write it, or fixture and page object drift together while the real page fails.

**Render captured markup with [`renderFixture`](../../src/projects/backwpup/pages/__fixtures__/render.ts),
not `page.setContent()`.** A capture still references what the real page did (WordPress's `s.w.org`
emoji images, provider links), and `setContent` waits for `load` — all of them — so the spec depended
on the public internet and timed out when it was slow. `renderFixture` aborts every request and waits
for `domcontentloaded`, the honest barrier for parsed-DOM assertions. Hand-written markup without
external references may use `page.setContent()`.

## Naming scenarios

A `Scenario:` name is read alone — what `--grep` runs, what a report lists, a CI failure's headline —
so it must state its own behaviour and outcome, assuming nothing of its neighbours.

- **No back-references**: no `…just the same`, `…too`, `…but with X`, `…same for Y`, no pronoun
  (`them`, `it`, `that`) resolved in a neighbouring title. A pronoun resolved inside the same sentence
  is fine.
- **Name what varies**: when scenarios cover one rule by different routes, each states its route _and_
  outcome, so the set reads as a list, not a thread.
- **State the outcome, not the clicks**: the rule proven (`… splits them into two jobs`), not the steps.
- **Shared context goes elsewhere**: why scenarios resemble each other, and shared setup, belong in the
  `Feature` description or `Background`, never implied in a title.

```gherkin
# ✗ meaningless on its own: "them" and "just the same" only resolve against the previous scenario
Scenario: The advanced schedule settings split them just the same

# ✓ names its own route and its own outcome
Scenario: Scheduling files and the database differently in the advanced settings splits them into two jobs
```

A long name that stands alone beats a short one that needs a neighbour.

## Adding a scenario — checklist

1. Write the `.feature` under `src/projects/<product>/features/`. Tag `@plugin` if it needs the plugin
   under test (almost all do); `@noauth` only if it needs no WordPress at all (what CI can run).
2. Name each scenario to stand alone ([Naming scenarios](#naming-scenarios)).
3. New steps go in `src/projects/<product>/steps/` (or `common/steps/` if truly generic), importing
   `Given`/`When`/`Then` from `fixtures.ts`. A `@plugin` scenario's `Background` already runs with the
   plugin installed and active (hooks run first).
4. UI logic in a page object; WP-CLI work through `wp/` modules via `site.transport`.
5. TSDoc every new function/method; type everything explicitly.
6. Run the quality gates (typecheck, lint, format, unit tests) —
   [AGENTS.md](../../AGENTS.md#required-workflow-after-every-edit).
7. Verify on a real cell: `E2E_CELL=<cell> npm run test:<product>`.

## Banned waits (enforced by lint)

`waitForTimeout`, `waitForLoadState("networkidle")`, `waitForSelector` and `.type()` are lint errors
in `src/projects/**` and `src/common/{pages,steps,hooks,auth}/**`. Each message names the replacement (a
web-first `expect()`, a specific `page.waitForResponse(…)`, `fill()`). Only the _called_ member matches,
so a property sharing a name (`describe(job.type)`) is fine
([AGENTS.md → Improvement gate](../../AGENTS.md#improvement-gate-lint)).

## Asserting rendered state after an action

A `toHaveCount`/`toBeVisible` assertion carries its own timeout, so aimed at a screen not yet caught
up it **waits**, then passes or flakes by the day — a banned wait the lint gate cannot see.

After an action changes the site, assert on DOM the **server** produced, not what the action left:
re-read it (a reload, or the page object's `reload()`) and wait on a signal that can only mean the new
data arrived (a placeholder the server always renders and only fetched rows replace). Awaiting the
fetch is usually weaker than it looks: armed before a navigation it can settle on the previous page's
request, armed after it can miss the response. The tell: an assertion justified by a measured margin
("the row lands about a second before the budget runs out") — a race, not a check.

## Unit / integration tests

`*.spec.ts` files under `src/` or `orchestrator/` are unit tests: `npm run test:unit`
([`playwright.unit.config.ts`](../../playwright.unit.config.ts), one project per folder: `src`,
`orchestrator`), covering `common/`, each product's specs (locator contracts included) and the
orchestrator. Select a folder with `--project=orchestrator` (the `=` matters: `--project` takes several
values and would swallow a following file filter); a file filter is a regex on the absolute path. UI
mode ticks only the first project until a choice is saved. They need **no external environment**: the
WP-CLI layer runs against a stub `wp` on `PATH`, page objects against `page.setContent()` fixtures. They
are separate from the BDD configs, whose specs live in `.features-gen/` (outside `src/`). Add a
`*.spec.ts` beside any non-trivial module you add. PHP that must run to be trusted (dropping tables, say) can
be driven against a fake `$wpdb` with the local `php`
([`table-padding.php.spec.ts`](../../src/projects/backwpup/support/table-padding.php.spec.ts)); such a
spec skips without PHP, as in CI.

Some things need a process nothing else touched (what importing a module does, how a config builds
under a given `--project`):

- [`runInChildNode`](../../src/common/__fixtures__/child-node.ts) runs code in a fresh Node under tsx,
  with only `PATH` and `HOME` and a 15 s limit, and returns the JSON it prints (`project.spec.ts`,
  `products.spec.ts`).
- [`probeImports`](../../src/common/__fixtures__/import-probe.ts) uses that child to import files one
  after another, from a folder whose `.env` sets a sentinel, and reports what each import changed
  (variables, process listeners, working directory, exit code, and more — see AGENTS.md), then what changed once idle — read from
  a file, not stdout, so nothing a module prints can forge or garble it. It proves a module leaves the process as
  it was (`products.spec.ts`, `orchestrator/import-boundary.spec.ts`).
- [`import-scan.ts`](../../src/common/__fixtures__/import-scan.ts) checks import boundaries: `importsIn`
  reads every module a file loads from TypeScript's syntax tree (dynamic `import()` and
  `typeof import()` included, which ESLint misses; a computed path reported as such), `createResolver`
  resolves as the repository's TypeScript does, `localClosure` walks all a module can load.

Unit runs write to `<OUTPUT_ROOT>/_unit`, so they never empty a cell run's output.
