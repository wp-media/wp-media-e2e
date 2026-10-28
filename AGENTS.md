# AGENTS.md

Operating guide for AI agents (and humans) in this repository. Read it first, then follow the links into
[`docs/`](docs/). Keep it accurate — see [When to update these docs](#when-to-update-these-docs).

## Project Overview

End-to-end (E2E) tests for WP Media plugins: WP Rocket (performance), BackWPup (backups) and Imagify
(image optimization), on **Playwright** (browser) and **Cucumber** (BDD).

> **Current state:** WP Rocket and BackWPup run. Imagify is planned, not wired up — add it under
> `src/projects/` when work begins
> ([authoring-tests.md → Adding a product](docs/guides/authoring-tests.md#adding-a-product)).

## Key technologies

| Area               | Tech                                                                                                                                                            |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime            | **Node ≥ 24.16** (`engines`; `.nvmrc` pins 24), **ESM** (`"type": "module"`)                                                                                    |
| Language           | **TypeScript 6**, strict (`tsc` type-checks only — Playwright transpiles via esbuild)                                                                           |
| Browser automation | **Playwright ≥ 1.62** (`@playwright/test`), Chromium only — the floor is load-bearing, see [wordpress-automation.md](docs/architecture/wordpress-automation.md) |
| BDD                | **Cucumber/Gherkin** via **`playwright-bdd`** (`bddgen` generates specs)                                                                                        |
| WP-CLI transport   | **execa** (local/docker), **node-ssh** (ssh)                                                                                                                    |
| Visual diff        | **pixelmatch** + **pngjs**                                                                                                                                      |
| Terminal layout    | **string-width** (display width per grapheme, never below what a terminal draws; ambiguous width narrow)                                                        |
| Orchestrator       | **zod 4** (its config), **commander 15** (its `start`)                                                                                                          |
| Reporting          | Playwright HTML, Cucumber HTML, **Allure** (`allure`, `allure-playwright`)                                                                                      |
| Quality            | **ESLint** (typescript-eslint, strict + type-checked), **Prettier**, **husky** + **lint-staged**                                                                |

## Repository structure

```text
src/
├── common/                 # product-agnostic, shared by every product
│   ├── config/             # env, sites loading, run-context, run-id.ts (RUN_ID, a run's report folder), run-env.ts (run-setting variable names), cell pin, drain, metadata, devices, file-owner rule, config factory
│   ├── reporting/          # the suite's reporters (cell notice, results stream, terminal + its sink/lines/worker-output/mode, run facts, summary), their pure parts, report retention (retention, report-tree, run-pruning, prune-command), page-loads.ts (a failed scenario's lost requests)
│   ├── auth/               # auth.setup.ts → authenticate.ts (login → storageState, site versions); login, session (ends a saved login)
│   ├── setup/              # the auth setup's preflight (+ cell-plugin.ts: a broken copy of the cell's plugin), elevation/ownership banner, site info
│   ├── fixtures.ts         # the extended test instance + Given/When/Then
│   ├── guards.ts           # type guards for narrowing `unknown`
│   ├── text.ts             # string helpers: escapeRegExp, escapeHtml, redactSecrets/maskValues (credentials), maskSiteUrl (a baseURL shown safely), withoutControls (well-formed, no escape or control), plain (one line: + no Cf, combining marks capped at 8)
│   ├── deadline.ts         # withinBudget: a time limit for a best-effort step
│   ├── terminal/           # side-effect-free terminal output: capabilities.ts (colour/live/Unicode, one precedence; every input a parameter), palette.ts (semantic colours via styleText, symbols + ASCII fallback, a status's word unless a coloured terminal), layout.ts (plain text in: width 20–120, display width, grapheme-safe cutToWidth, padding, rules, 500-code-point capLine), stream.ts (unblockTerminal/stdoutTerminal: non-blocking TTY stdout; openLiveTerminal: that plus a no-op `error` listener, the only way to a live region; drainTerminal before exit; writeSafely, backlogBytes, TERMINAL_BACKLOG_BYTES), live.ts (the live region: byte-exact `\r\n` cursor contract, throttle, one repaint per print burst, SGR-only style, backlog bound, resize, close; dead after a failed write)
│   ├── steps/              # generic step definitions
│   ├── hooks/              # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── pages/              # cross-product page objects (plugins, site-health) + secret-field.ts (typing a secret no report records)
│   ├── visual/             # visual-regression helpers (A/B, compare, stabilize)
│   ├── artifacts/          # the plugin zips under test (resolve, digest, verify, consume, pre-warm, pin)
│   ├── __fixtures__/       # spec helpers: temp dirs, a fresh Node, import probe/scan, fake report trees, drain and page-loads scenarios, the no-credential canary, mock WordPress, a stub `wp`'s plugin-folder inspection, a slowly-read child (slow-reader), a child on a pty nobody reads (paused-pty), the live region's tmux driver (live-tmux*)
│   └── wp/                 # WordPress over WP-CLI (exec, php, staging, plugin, plugin-dir, log, options, cron, files, archive, residue, db-residue, ownership, paths, cache, db, teardown, errors)
└── projects/
    ├── products.ts         # the one product list (PRODUCTS, productByName, productFromEnv, playwrightConfigFor); products.spec.ts guards it
    └── <product>/
        ├── config/         # <product>.config.ts + sites.json / sites.*.json / sites.example.json
        ├── fixtures.ts     # this product's test instance: common's + its page objects
        ├── features/       # *.feature (Gherkin)
        ├── pages/          # page objects (+ locator-contract specs)
        ├── steps/          # product-specific steps
        └── support/        # debug-log presets, leftover declarations (files + database), REST barriers, WP-CLI readers, the CLI-under-test runner, running-job probes and stop, site setup

orchestrator/               # runs cells in loops. Layout and design: docs/plans/orchestrator-phase-0.5-plan.md §5, §4
│                           # suite-imports.json (suite modules it may import) + import-boundary.spec.ts; config.example.json
│                           # cli.ts (entry: `exec node --import tsx`, never the `tsx` CLI; `process.exit(await runCommand(…))`)
│                           # command.ts (commander `start [--config] [--task <id…>] [--once] [--dry-run]`; refuses options npm took)
│                           # start.ts (config, lock, orphan check, site locks, every task's loop; signals or the parent ending stop it; prepareStart = --dry-run's seam)
│                           # parent.ts (the parent's PID at boot: command.ts's first import); start-lines.ts, dry-run.ts (pure); text.ts (masking, safeSiteUrl); log.ts (its terminal via src/common/terminal/stream.ts), files.ts, folders.ts, error-code.ts
│                           # config/ (zod schema, parse, check, site-key, load, product-list, secrets) · runs/ (identity, environment, commands, launch, stop, shutdown, end, outcome, run.json record)
│                           # state/ (atomic writes, orchestrator.lock, site locks, inspect, orphans, counter, run folders + retention) · events/ (bus, run.finished v1)
│                           # tasks/ (cycle: one run; loop: cycle + cooldown, --once) · notify/ (bounded POST, Slack, Datator) · __fixtures__/ (fake suite, fake start, HTTP sink)
│                           # soak.spec.ts (hundreds of runs over the fake suite; ORCHESTRATOR_SOAK=1, npm run orchestrator:soak)
docker/                     # local WordPress for the `docker` transport
docs/                       # architecture & guides (linked below)
playwright*.config.ts       # entry configs (default, per-product, unit)
```

### Core concepts: products, cells, pools, runs

Full detail: **[execution-model.md](docs/architecture/execution-model.md)**.

- **Product** — a plugin under test (`wp-rocket`, `backwpup`): its features, steps, sites, optional
  service credentials.
- **Cell** — a named environment (`apache`, `nginx`, `pro@nginx`): the merged top-level keys of a
  product's sites files. Lowercase `a-z0-9@._-`, never `_`-prefixed (it names folders and projects).
- **Pool** — a cell's interchangeable sites; each worker binds to one by `parallelIndex`.
- **Run unit** — one `(product × cell)`. **One cell per invocation**, pinned with **`E2E_CELL=<cell>`**:
  `bddgen` then regenerates only that cell's specs, so cells of one product run side by side.
  `--project=<cell>` works but regenerates every cell's specs, breaking a run beside it. Two cells
  fail fast — counting what `--project` reaches by Playwright's own matching (any case, `*`, `setup:`).
  Each run prints a `[cell]` line.
- **Output folders** — only a run targeting a cell writes `test-results/<product>/<cell>`; others
  `<product>/_all/<cell>`, unit runs `_unit` (`outputDirFor`). Reports and logins are absolute paths
  in the checkout.
- **Stopping a run** — the **drain**: creating the file `E2E_INTERNAL_STOP_FILE` names skips each
  scenario's first attempt as `stopped` (`drainGate`). Escalate with **one** SIGINT to the runner,
  then SIGKILL its process group — never SIGTERM, never a second SIGINT.
- **Watching a run** — `<report dir>/results.jsonl` streams every event (schema v1,
  `reporting/results-schema.ts`); no `run.end` means the runner died. On the terminal,
  `terminal.reporter.ts` replaces `list`: `[cell]`, a `[run]` header (a `━━` rule on a Unicode TTY),
  one line per test at its final attempt plus a `↻` line per retry, worker output printed live, masked
  whole then capped, in a `│` gutter under a `▸` line naming its source whenever it changes (a killed
  run's log keeps the hung scenario's last lines); then the summary and verdict. It is the one writer:
  other reporters print through its sink (`printLine`, `terminal-sink.ts`), never cut. `E2E_OUTPUT=
auto|plain|fancy`; quiet for `--list`, `--ui` and `PW_TEST_REPORTER` (Playwright then adds its own);
  watch mode prints; `--reporter` replaces the whole stack; `--add-reporter` doubles the lines (not
  detected). A closed pipe (`| head`) never crashes the run. Every credential a message quotes is masked by its shape (`redactSecrets`);
  APVM's output also by value (`maskValues`, against `GITHUB_TOKEN`/`GH_TOKEN`).
- **What a run tested** — one facts line as the reports' title/banner/name, every fact in
  `<report dir>/run-facts.json`. `captureGitInfo` is **off**: Playwright would turn it on under CI and
  put authors' emails and a diff in the report.
- **Report retention** — each run prunes its own cell's reports as it ends (`E2E_REPORTS_KEEP`, 20;
  30 days; the newest complete one up to 182); `npm run report:prune` does every cell.
- **One cell, one orchestrator run** — a lock per site, keyed by `baseURL`, shared by every
  orchestrator of this user on the machine; held for a task's whole loop and kept while a run's
  processes may live. Not covered: other users, other machines, runs started by hand, one site under
  two addresses ([orchestrator.md](docs/guides/orchestrator.md#one-run-per-site)).

## NPM commands

```bash
# Testing
npm run test                                        # default product, bddgen + run
E2E_CELL=<cell> npm run test:wp-rocket              # one product, one cell (safe beside other cells)
E2E_CELL=<cell> npm run test:backwpup
E2E_CELL=apache npm run test:wp-rocket -- --grep @smoke   # filter by tag
npm run test:backwpup -- --project=<cell>           # one cell, but regenerates every cell's specs:
                                                    # never beside another run of the same product
npm run test:ui                                     # Playwright UI mode
npm run test:headed                                 # headed browser
npm run test:unit                                   # unit/integration specs (src/**, orchestrator/** *.spec.ts)
npm run test:unit:ui

# Fleet health check
npm run healthcheck                                 # preflight + login on every product/cell/site
npm run healthcheck:ui                              # same, browser visible

# Plugin artifacts
npm run artifacts:warm                              # pre-warm APVM's cache for every real cell
npm run artifacts:warm -- --product=backwpup --cell=pro@nginx

# Quality gates (see "Required workflow after every edit")
npm run typecheck                                   # tsc
npm run lint                                        # eslint .
npm run lint:fix
npm run format                                      # prettier --write .
npm run format:check

# Orchestrator (config in .orchestrator/config.json, from orchestrator/config.example.json)
npm run orchestrator -- start --dry-run             # check the config, print what would run; writes nothing
npm run orchestrator -- start --task <id> --once    # one run, then exit 0 (passed/flaky), 1, or 130 if stopped
npm run orchestrator -- start                       # every task in its own loop until stopped
                                                    # Ctrl-C drains (130); again interrupts; a third kills
npm run orchestrator -- start --help                # options always after "--": npm takes --dry-run itself
npm run orchestrator:soak                           # minutes; ORCHESTRATOR_SOAK_RUNS (default 200)

# Reporting
npm run report                                      # open the newest Playwright HTML report
npm run report -- wp-rocket apache                  # a product/cell's newest
npm run report:allure                               # Allure for the newest run
npm run report:allure -- wp-rocket apache --open
npm run report:prune                                # dry run of retention over every cell
npm run report:prune -- --apply                     # remove (--keep, --older-than, --keep-newest-for, --product, --cell)

# Local WordPress (Docker transport)
npm run env:up                                      # Apache(:8100) & Nginx(:8101) sites
npm run env:down                                    # stop & remove, volumes included
npm run env:logs

# Browsers
npm run setup                                       # playwright install chromium (also on postinstall)
```

## Configuration

Schema: **[configuration.md](docs/guides/configuration.md)**.

- **Sites files** (per product, **git-ignored**, hold credentials) define cells and pools: `sites.json`
  plus `sites.<name>.json` overlays, merged alphabetically, each owning disjoint cells. With none, the
  committed `sites.example.json` (placeholders) is used, so a fresh checkout passes the `@noauth`
  smoke. Credentials live only there and never enter reports.
- **`.env`** (from `.env.example`, loaded by [`load-env.ts`](src/common/config/load-env.ts)):
  runtime flags and BackWPup storage credentials. Real env vars win; `E2E_LOAD_DOTENV=false` in the
  environment skips the file. Read env only through the typed accessors in
  [`env.ts`](src/common/config/env.ts).

## Fixtures

Import step builders and fixtures from a `fixtures.ts`, **never** from `playwright-bdd`. Product steps
use **their product's** `fixtures.ts`; shared steps and hooks use
[`src/common/fixtures.ts`](src/common/fixtures.ts). playwright-bdd picks the most-extended instance a
scenario's steps use, so they mix — but the product's `fixtures.ts` must be in its `steps` config, or
generation fails. Shared fixtures:

| Fixture                   | Scope  | Purpose                                                                                                                   |
| ------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------- |
| `site`                    | test   | The `SiteConfig` bound to this worker; throws if no pool (tag `@noauth` instead).                                         |
| `edition`                 | test   | The cell's `free`/`pro` edition; throws in editionless cells.                                                             |
| `boundSite`               | worker | The worker's pinned site (by `parallelIndex`); underpins `site`.                                                          |
| `pluginArtifact`          | test   | `pluginArtifact(role)` → the resolved zip; `.slug` addresses the plugin, `.zipPath` feeds `stageAndInstallPlugin`.        |
| `releaseBoundSite`        | worker | Automatic teardown: removes the site's staging area, closes SSH connections. Best-effort — never fails a passing run.     |
| `drainGate`               | test   | Automatic: once the stop file exists, skips each scenario's first attempt as `stopped`.                                   |
| `context` (override)      | —      | Watches the site's own requests; a failed scenario that lost some warns `[page-loads]` and attaches `page-load-failures`. |
| `baseURL` (override)      | —      | Points navigation at the bound site.                                                                                      |
| `storageState` (override) | —      | The bound site's saved login, or an empty session for `@noauth`.                                                          |
| device options (override) | —      | `viewport` / `userAgent` / `isMobile` / `hasTouch` / `deviceScaleFactor`: the `@mobile` profile, else desktop.            |

BackWPup's [`fixtures.ts`](src/projects/backwpup/fixtures.ts) adds page objects and scenario state —
what each does: [authoring-tests.md → BackWPup's
fixtures](docs/guides/authoring-tests.md#backwpups-fixtures). Rules to know before using them:

- `cli` runs `wp backwpup …` where the **command is the system under test** and returns a refusal
  instead of throwing; when WP-CLI only arranges or checks a site, use `support/backups.ts`
  (throws). A `--key=` value never appears in a message naming the command: name it through
  `commandLine` (`support/cli.ts`).
- Request `markers` **before** the backup under inspection runs: requesting it plants them.
- `restore` (the six-step wizard: `strategiesOffered`, `restoreWith`) fails each wait at once on the
  wizard's error line, the decryption prompt, the login screen, or what `WizardWatch` saw (a stream
  reconnecting or answered with something else, a failed `controller=job` call, an uncaught plugin
  script error). `changedMarkers` holds the values the markers were changed to after a backup, which
  a restore's untouched half must still hold.
- `cliRestore` is the only way to run `wp backwpup restore` (the generic step refuses it). It
  refuses a database holding what `wp db reset` destroys for good (tables outside the prefix, views,
  routines, events, triggers) or a relocated `wp-content`. Before a files restore it copies
  `wp-content` as root into root-only `<root>/.e2e_content_copy/` and puts it back with `tar
--recursive-unlink` once no run is in flight; a copy that cannot go back is kept with its way back
  spelled out, and every BackWPup worker refuses a site still holding one (`contentCopyLeftover`;
  the auth setup tries first, before its gates) — unless no process uses it (argv or working
  directory in it, or a restore in the root) and it holds none to put back, or its whole copy is
  stamped by another boot (every use is stamped with the host's boot id just before it): it is then
  claimed (`mv -T` to `.e2e_content_copy.recovering-<hex>`), put back or removed, and the run goes
  on; a restore that reached the database too also has the database's defaults it saved beside the
  copy set back (`support/content-copy-leftover.ts`). The restore is refused if the host rebooted
  since the copy was taken; a put-back first waits for a restore a dropped connection left running,
  acts only on a copy holding its run's token, and marks it back durably in the same root command.
  It also restores the default collation and removes the scenario's own snapshots, told from other
  runs' by either changed marker.

Page-object pattern, locator policy and the locator-contract spec:
[authoring-tests.md](docs/guides/authoring-tests.md#page-object-model).

## Shared scenario hooks

[`src/common/hooks/`](src/common/hooks/): each `*.hooks.ts` only binds to the BDD runtime; its policy
lives in a sibling module, unit-testable without it.

**`@plugin`** ([`plugin.hooks.ts`](src/common/hooks/plugin.hooks.ts)):

- **Before**, in order: clear `debug.log`; stop work the plugin still runs (a killed run's job —
  `ProductConfig.stopRunningWork`; reported, a failure only if it won't stop — a stop that fails on a
  copy WordPress boots only without, `pluginBreaksBoot`, is reported: such a copy runs nothing); uninstall any
  existing copy (so the install is fresh, DB footprint included) and remove by path what is left
  there — a folder WordPress no longer lists, or a listed copy whose uninstall fails (taken off
  `active_plugins` with no plugin loaded first, or `install --activate` skips its activation); a
  removal cut short leaves these (`wp/plugin-dir.ts`; a warning plus a `leftover-plugin-files`
  attachment; after a failed uninstall `debug.log` is cleared again, that fatal is an earlier run's); sweep its leftover **database
  footprint** (`ProductConfig.siteDbResidue`: options, tables, roles, capabilities — keyed off what is
  on the site, never off whether the plugin is installed; activation's `add_role()` keeps a leftover
  role as it is); stage and install the cell's artifact with `--activate`, its files handed to
  the **site's** ownership; **re-assert the active state**, never inferred from the exit code;
  create the declared data directories (`ProductConfig.siteResidue`, and `resolveSiteDataDirs` for
  names the plugin picks at runtime, e.g. BackWPup's `uploads/backwpup-restore-<20 hex>`), open to
  **both** WP-CLI's and the web server's user and handed to the site's ownership. The edition is
  never named: the slug is `pluginArtifact("plugin").slug`. To reinstall part-way, a step calls
  `replacePluginUnderTest` (no log reset, so the teardown judges the whole log) with
  `declaredResidue`.
- **After**: scan `debug.log` with the product's preset — a **PHP fatal fails the scenario**
  (`DebugLogFatalError`, log attached), warnings/notices are logged; stop running work (a BackWPup
  job runs in a web request and would outlive the uninstall); remove the plugin, healing what is left at its path as above — a
  failed uninstall still **fails the scenario** (`PluginUninstallBrokenError`); sweep its database
  footprint; clear the **files it left** (an uninstall keeps its data, and per-scenario reinstalls
  would fill the disk). All five always run, independently; the log verdict wins and other failures
  are logged. Having to stop work is reported; work that _won't_ stop is a failure. Leftovers the
  transport's user may not remove are reported, not failed
  ([wordpress-automation.md](docs/architecture/wordpress-automation.md#left-over-plugin-data-wpresiduets)).
  A drained scenario gets neither hook.
- The scenario timeout is extended **additively** for both hooks (remote WP-CLI + SFTP is slow),
  plus `LEFT_WORK_ALLOWANCE_MS` for stopping left work (every `stopRunningWork` must fit it).

**MUST — `src/common/hooks/**/*.hooks.ts` belongs in every product's `steps` globs.** That glob is
the only importer: omit it and the lifecycle is _silently absent_.

A product declares its `debug.log` preset (`ProductConfig.debugLog`), `stopRunningWork` and
`settleLeftovers` (the auth setup's); the config factory registers them per process, so shared code
never imports product code (RegExps and functions
cannot ride project metadata anyway).

## Device profiles (desktop & `@mobile`)

Tag-driven, per scenario, never a project dimension
([`config/devices.ts`](src/common/config/devices.ts)):

- **Default** — Desktop Chrome at `1600×700`.
- **`@mobile`** — Pixel 5 (a Chromium preset, our only browser) at `389×829`: the full preset (user
  agent, touch, scale), not just a narrow viewport, so responsive CSS, touch handlers and
  user-agent checks see a phone.

Both viewports are pinned, so a Playwright upgrade cannot shift them.

## Improvement gate (lint)

`eslint.config.js` bans `waitForTimeout`, `waitForLoadState("networkidle")`, `waitForSelector` and
`.type()` in `src/projects/**` and `src/common/{pages,steps,hooks,auth}/**`; each message names the
replacement. It matches the **called** member only, so `describe(job.type)` passes — a gate that fires
on innocent code gets disabled. The one exception, outside that scope on purpose:
[`visual/stabilize.ts`](src/common/visual/stabilize.ts)'s single timeboxed, caught `networkidle` before
a screenshot.

**`src/common/**` never imports `src/projects/`**; products hand it their policy through
`ProductConfig` and the config factory's registries. ESLint flags static imports;
[`import-boundary.spec.ts`](src/common/import-boundary.spec.ts) catches `import()` and
`typeof import()`. Only cross-product entry points (`playwright.config.ts`, healthcheck, artifact warm,
orchestrator) read [`products.ts`](src/projects/products.ts), which never loads `.env` or stamps
`RUN_ID`; its spec fails when it disagrees with `src/projects/`, the `playwright.<product>.config.ts`
files or the `test:<product>` scripts.

**The orchestrator imports from the suite only what
[`orchestrator/suite-imports.json`](orchestrator/suite-imports.json) lists**: it is long-lived and must
keep its process state, while `run-context.ts` and everything importing it load `.env` and stamp
`RUN_ID` on import. Never test code, a computed `import()`, a URL (`data:`, `file:`, `https:`), or a
builtin or name that runs code no guard reads (`module`, `worker_threads`, `vm`, `inspector`, `repl`,
`process.getBuiltinModule`, `eval`, `Function`); ES modules only (no `.cts`, `.cjs`, `package.json`).
The product list only through `loadProductList`, so a broken sites file is a config error, not a
crash. [`orchestrator/import-boundary.spec.ts`](orchestrator/import-boundary.spec.ts) resolves every
import, walks all an admitted module can load (never `load-env.ts`/`run-context.ts`), and imports it
all but `cli.ts` in a fresh Node to prove env, listeners, cwd, exit code, umask, listener limits and
`Error.stackTraceLimit` unchanged and `fetch`, `process.exit`, `process.cwd`, `process.chdir`,
`fs.close`, `fs.closeSync` not replaced — except graceful-fs's patch (Playwright's bundle), accepted
only with all four of its marks (`GRACEFUL_FS_PATCH`). Admit a module only once that spec passes.

**Auth fixture / setup:** [`auth.setup.ts`](src/common/auth/auth.setup.ts) is a dependency project run
before the scenarios, in three steps:

1. **Pre-flight** (gating), per real site — after settling what the product's killed runs left
   (`ProductConfig.settleLeftovers`; best-effort, a refusal is a warning; never in the healthcheck),
   since that damage can stop WordPress booting: the transport works (ssh: connection, WP-CLI, `rootDir`;
   docker: container up, WP-CLI inside; local: `rootDir`, WP-CLI on `PATH`) and `wp core
is-installed` passes — a WordPress that cannot boot (old PHP, DB down, a fatal) is reported as
   that, never as "not installed". Then the **admin UI is English** (`determine_locale()` for the
   configured user, so per-user setting, site option, `WPLANG` and filters all count): page objects
   match English names, and a translated site would otherwise fail as many locator timeouts. When
   WordPress cannot boot for that check but boots with the cell's own slug skipped
   (`--skip-plugins=<slug>`), the cell's plugin is a broken copy every login would die on: the setup
   removes it (`ensurePluginAbsent`, as the `@plugin` hooks would) and says so, a **Plugin under test**
   line; the healthcheck only reports it ([`setup/cell-plugin.ts`](src/common/setup/cell-plugin.ts)). A
   gate failure throws a formatted report and skips the scenarios. Three **reports, never gates**: **File
   ownership** (the same `planOwnership` decision `normalizeOwnership` acts on, so report and action
   agree), **Elevation** (passwordless `sudo`?) and **Plugin folders** (a folder WordPress lists no
   plugin in at the slug the cell installs, which its next `@plugin` scenario removes). No report fails a site for a property of
   the host; the one exception is an unparsable `transport.fileOwner` (our config, unreadable).
   Reports fold into one banner per run
   ([`setup/elevation-report.ts`](src/common/setup/elevation-report.ts)), silent when every site can
   elevate or opted out, naming the ownership cost only where a handover was needed; a second names
   each leftover plugin folder.
2. **Authentication** ([`authenticate.ts`](src/common/auth/authenticate.ts)), per real site: end the
   session the cell's previous run saved (`auth/session.ts`: that token only, that host only, via
   `WP_Session_Tokens`), log in once through the UI, save `storageState`. A failing or timed-out
   setup ends the sessions it saved (from `afterEach`, `endSessionsWhenSetupFails` — a timeout
   abandons the body). Not at run end: the `--no-deps` loop reuses the login and an interrupted run
   skips teardown. Best-effort, bounded by `BEST_EFFORT_ALLOWANCE_PER_SITE_MS` (added to the setup's
   timeout): a session left open is a warning and expires in two days.
3. **Site versions** — Site Health's "Copy site info", cut **in the page** to a whitelist (a traced
   call records what it returns): WordPress, the web server's PHP and SAPI, web server, database and
   its extension ([`setup/site-info.ts`](src/common/setup/site-info.ts)); a `[site]` line and
   `site-info.json`. A failure is a warning and an `error` entry.

The setup is skipped when a cell has only placeholder sites.

[`auth/login.ts`](src/common/auth/login.ts) checks each field kept its value before submitting:
WordPress re-focuses the username field, and a re-focus mid-`fill()` diverts text, failing much later as
"login never settled". The password goes in with [`enterSecret`](src/common/pages/secret-field.ts) and
is checked with `holdsSecret`, both in the page.

> **No site password in a report; traces still need care.** Playwright titles `fill()`/`type()`/
> `pressSequentially()` steps with their text, unmasked, so **every secret is typed with
> `enterSecret`** (`StorageSidebar.fillSecret` for a storage key). The auth setup traces **without DOM
> snapshots** (which also stops network recording) and turns off its tests' `error-context.md` page
> snapshot (`keepSecretsOutOfFailureSnapshots`, via the undocumented `PLAYWRIGHT_NO_COPY_PROMPT`; back on
> only after a passing test, since a setup worker hands its variables on);
> [`secrets.run.spec.ts`](src/common/auth/secrets.run.spec.ts) proves it through the real runner.
> Still exposed: a **scenario's** trace holds the WordPress **session cookies** (live until the next
> run ends that session, or two days), and its trace and `error-context.md` any value typed or shown in
> a field;
> BackWPup's restore wizard renders the **database** password into its markup; Pro's restore deep link
> and messages naming the restore folder carry its 20-hex name — on nginx the only thing keeping the folder,
> and the DB credentials its `restore.dat` holds mid-restore, from being served (the teardown removes
> it). Treat `test-results/` and reports as sensitive as the sites file.

**Fleet health check:** [`healthcheck.ts`](healthcheck.ts) runs the pre-flight and login standalone
(no test run, no `storageState` written) on **every** product × cell × site. Products run one
section at a time, their sites concurrently; each site prints as soon as it is done, with every
check it ran (ownership and elevation reports included) and hints on failure; a summary per product
ends it. The banner is the auth setup's renderer, printed to **stdout** so `healthcheck > fleet.log`
keeps it. Placeholder cells are skipped. Exit `0` only if every real site passed. Tune with
`HEALTHCHECK_CONCURRENCY`, `HEALTHCHECK_LOGIN_TIMEOUT_MS`; `healthcheck:ui` is the same, headed
(`--headed`, or `HEALTHCHECK_HEADED=true`).

## Plugin artifacts (the zips under test)

Every run resolves **and verifies** its zips before any scenario, in the `artifacts:<cell>` setup
project: roles `plugin` (under test) and `previous` (older, for comparisons). Full design:
**[plugin-artifacts.md](docs/architecture/plugin-artifacts.md)**; overrides (six `E2E_*` vars, ref XOR
zip): [configuration.md](docs/guides/configuration.md#plugin-artifacts-build--verify).

- **APVM** ([`apvm-napi`](https://github.com/wp-media/automation-plugin-version-manager), pinned to
  `…#cli/v3.0.0`, prebuilt binaries) builds a git ref. BackWPup's source is **private**: set
  `GITHUB_TOKEN` or run `gh auth login`; for public WP Rocket/Imagify a token only raises rate limits.
  **MUST — APVM only through this Node library, never its `apvm` CLI**, anywhere in the repo (suite,
  scripts, orchestrator); a CLI-only capability waits for a library release. Agents may still run the
  CLI in a shell.
- **Consumption:** `stageAndInstallPlugin(site.transport, a.zipPath, { activate: true, slug: a.slug })`
  with `a = pluginArtifact("plugin")` — the `slug` restores file ownership. `zipPath` is on the
  **runner**, so a bare `installPlugin` works only on `local`.
- **What was tested:** each zip's SHA-256, a build's full commit and its `pinRef` are recorded in
  `resolution.json` and the setup's attachment.
- **Pre-warm** (`npm run artifacts:warm`) plans through the resolver's own request builder (parity),
  so a warmed entry is the one a run looks up; each warm returns a pin that rebuilds what it cached.

**MUST — BackWPup has no `previous` role yet**: `pluginArtifact("previous")` throws and
`E2E_PREVIOUS_*` is warned and ignored. When comparison tests arrive, add a `previous` default ref
(`release:latest-stable`) **and** default version to
[`backwpup.config.ts`](src/projects/backwpup/config/backwpup.config.ts); the preflight then verifies it
automatically, and that verification **must not** be skipped. Mirrored as a comment on that manifest.

## WordPress automation layer

`src/common/wp/` drives a site over WP-CLI on any transport (local / docker / ssh). Reference:
**[wordpress-automation.md](docs/architecture/wordpress-automation.md)**. The rules:

- Commands are file + args arrays, never shell strings. **An exec error names the program and the
  reason, never the arguments** (they carry `--key=` values and snippet values): never pass on execa's
  `message`/`shortMessage`/`command` or attach its error as a `cause`.
- `exec`/`wpCli` return an `ExecResult`: branch on `exitCode`. Commands run in the WordPress root with
  no input, so a `[y/n]` prompt declines at once, exit 0, having done nothing.
- **Files must reach the site before `wp` reads them**: stage with `stageArtifact` /
  `stageAndInstallPlugin` (`wp/staging.ts`, `.e2e_temp/<category>/`; `transport.stagingDir`,
  `E2E_SITE_STAGING_DIR`).
- Idempotent cleanup (`ensurePluginAbsent`) and asserted removal under test (`uninstallPlugin`) both
  deactivate as their own call, then plain `wp plugin uninstall` — **never `uninstall --deactivate`**,
  which makes the plugin's cleanup skip itself. Typed errors in `wp/errors.ts`. **"Absent" means
  nothing at the plugin's path** (`wp/plugin-dir.ts`), not "WordPress lists none": cleanup removes
  what is left by path and returns it to report; removal under test fails naming it, never sweeps.
  Only the cell's own slug is inspected.
- **Every `wp eval` goes through [`wp/php.ts`](src/common/wp/php.ts)**; **any value from outside this
  codebase (site, scenario, fixture) is embedded with `phpLiteral`** — the injection boundary, no
  exceptions.
- **Never `wp cron event run <hook>`** (it runs every event on the hook, in WP-CLI's PHP): use
  `triggerScheduledEvent` (`wp/cron.ts`).
- Read options with `getOption`/`getOptionJson` (missing → `undefined`, unbootable → throws); never
  hard-code `wp_` — use `tablePrefix`.
- `listFiles` refuses a missing directory (it would pass "it was deleted"); `missingAsEmpty` only for
  one a scenario may never have made. Prove a transfer with `fileChecksum`, not size.
- `wp/archive.ts`: tar's "absent" and "unreadable" share exit 2, so readability is proved by listing
  the whole archive. `.zip` is out of scope.
- **MUST — code that writes into a docroot as the transport's user calls `normalizeOwnership` on what
  it wrote; never `chown`/`chmod` directly, never elevate `wp`** (WP-CLI as root leaves files the web
  server cannot write). `stageAndInstallPlugin` does it when given the `slug` — pass it. Override per
  site with `transport.fileOwner` (`"user:group"`, or `false`).
- An elevated target built from `rootDir` passes the lexical guards in `wp/paths.ts` and
  `assertResolvedInsideRoot` (`wp/exec.ts`), which refuses a path a symlink in any parent leads out of
  the docroot, or one it cannot resolve.
- Leftovers: `ProductConfig.siteResidue` (files, `wp/residue.ts`; unprivileged first, then only what
  survived elevated; `transport.elevate: false` refuses elevation) and `ProductConfig.siteDbResidue`
  (options, tables, roles, capabilities, `wp/db-residue.ts`; never elevated, multisite refused). Both
  verified by re-reading.
- **Debug log** ([`wp/log.ts`](src/common/wp/log.ts)): `clearDebugLog` in a `Before`, `scanDebugLog`
  (`{ raw, fatals, warnings, notices }`; WordPress booted with no plugin or theme, so a broken one
  cannot write into the log it reads; a direct read when even that fails) in an
  `After`. Presets in `support/debug-log.ts`: `*_LOG_OPTIONS` scans everything, `*_OWN_LOG_OPTIONS` that
  plugin only.

## Visual testing (A/B only, for now)

The only active model is the A/B check ([`visual/ab.ts`](src/common/visual/ab.ts)): a page renders
the **same optimized as bypassed** (`?nowprocket`), both captured live and pixel-diffed, no
baseline; a size difference fails too: `expectOptimizedToMatchUnoptimized(page, path, options)`. Tag
`@visual`, run in the Playwright container; tolerances in
[`config/visual.ts`](src/common/config/visual.ts). `screenshot.ts` (committed baselines) is wiring
only. Walkthrough: README's "Visual regression".

## Coding conventions

Requirements, not suggestions:

- **Handle errors explicitly.** Validate at boundaries (env, `sites.json`) and fail fast with
  actionable messages naming the offending input. Use the typed errors in `wp/errors.ts`, not bare
  `throw`s, where a failure mode matters. Branch on `exitCode` for a command's outcome; throw when
  it couldn't run. Best-effort side work (attachments, page stabilisation) must never mask the real
  assertion.
- **Strict, explicit types.** No implicit `any`; typed parameters and returns; `tsconfig` is strict
  (`noUncheckedIndexedAccess`, `noUnusedLocals/Parameters`, …). Prefer `readonly` and discriminated
  unions; narrow `unknown` at boundaries with [`guards.ts`](src/common/guards.ts).
- **TSDoc — always, and only TSDoc.** Every function and method (private, public or isolated) and
  every non-obvious property/constant. Write for understanding: say _why_; don't restate the
  signature, repeat yourself or over-explain. Use `@param name - …`, `@returns`, `@throws {@link
ErrorType}`, `{@link …}`, `@example` with ` ```ts `. **Never** JSDoc type annotations (`@param
{type}`, `@type {…}`) in `.ts` files — the only exception is the load-bearing `@type` in
  `prettier.config.js`.
- **Code never references plans.** No `docs/plans/*` paths, `§` numbers or phase names in comments,
  TSDoc or messages: plans move, and an operator's error must not point at a design doc — explain
  inline. Markdown docs and `.env.example` may cite plans. Exceptions only with the user's explicit
  approval, listed here — _current exceptions: none._
- **Every scenario name stands alone** — it is what `--grep`, a report row and a CI headline show.
  It is read in isolation, never in file order: state the behaviour _and_ its outcome, no
  back-reference (`…just the same`, `…too`, a dangling `it`); shared setup, and why scenarios
  resemble each other, go in `Feature`/`Background` ([authoring-tests.md → Naming
  scenarios](docs/guides/authoring-tests.md#naming-scenarios)).
- **Never write to a docroot without restoring its ownership** — the
  [MUST in the WordPress layer](#wordpress-automation-layer)
  ([details](docs/architecture/wordpress-automation.md#file-ownership-wpownershipts)).
- **Layering:** UI in page objects, WP-CLI in `wp/`, shared code in `common/`, product specifics in
  `src/projects/<product>/`. Match the surrounding style.
- **Separate by concern** without overengineering; keep functions short.
- **Reuse:** extract a small utility when other code can use it; keep it local when it can't —
  decide case by case.
- **Unit-testable:** small, pure, dependency-injected functions; cover as much logic as possible
  with `*.spec.ts` (every non-trivial `common/` module). Untestable glue (thin UI, Playwright
  wiring) is the exception.
- **Production-ready:** stable, robust, reliable, edge cases handled, no half-finished paths;
  neither over- nor under-engineered — assess case by case. Docs, comments, this file and plans:
  dense and clear, never verbose.

## Required workflow after every edit

After any code change, run **all** of these and make them pass before calling the work done:

```bash
npm run typecheck     # tsc
npm run lint          # eslint .
npm run format        # prettier --write . (format:check in review)
npm run test:unit     # unit/integration specs
```

For behavioural changes, also run a real cell: `E2E_CELL=<cell> npm run test:<product>`, keeping the
runner awake (`caffeinate -i` on macOS) — a sleeping runner drops its SSH connections and the run fails
as if the network had (hooks far past their timeouts, `ECONNRESET` after each wake).

`husky` + `lint-staged` run `eslint --fix` + `prettier --write` on commit, and CI
([`ci.yml`](.github/workflows/ci.yml)) runs typecheck, lint, `format:check`, the unit tests (two
shards) and the `@noauth` smoke on both products. Don't rely on the hook — run the gates yourself.

## Documentation map

| Read when…                                                                       | Document                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| You need the operational quick-start (install, run, report, Docker).             | [`README.md`](README.md)                                                                 |
| You're touching the run/config machinery or wondering about cells/pools/workers. | [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md)           |
| You're working with WP-CLI, transports, plugin lifecycle, or debug-log.          | [`docs/architecture/wordpress-automation.md`](docs/architecture/wordpress-automation.md) |
| You're touching how the plugin zips under test are resolved, built, or verified. | [`docs/architecture/plugin-artifacts.md`](docs/architecture/plugin-artifacts.md)         |
| You're adding features, steps, fixtures, or page objects.                        | [`docs/guides/authoring-tests.md`](docs/guides/authoring-tests.md)                       |
| You're editing sites files, transports, editions, or env vars.                   | [`docs/guides/configuration.md`](docs/guides/configuration.md)                           |
| You're running or configuring the orchestrator.                                  | [`docs/guides/orchestrator.md`](docs/guides/orchestrator.md)                             |

## In-progress plans

Living design docs in `docs/plans/` — check them before related work; they hold the current plan, not
history:

- [`e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md) — full design rationale and
  decisions; also the finished plugin-artifact and site-file-ownership designs (facts, open
  obligations).
- [`phase-6-feature-porting-plan.md`](docs/plans/phase-6-feature-porting-plan.md) — feature porting
  (BackWPup first); supersedes the parent plan's Phase 6.
- [`orchestrator-plan.md`](docs/plans/orchestrator-plan.md) — the orchestrator, a long-running service
  running cells on a server (supersedes the parent plan's Phase 9); includes Phase 0 (done): the run
  contract and each suite change's decision.
- [`orchestrator-phase-0.5-plan.md`](docs/plans/orchestrator-phase-0.5-plan.md) — the minimal
  orchestrator (cycling cells, Slack, Datator) replacing AutoE2E's BackWPup instances; its design and
  decisions.

## When to update these docs

`docs/`, `AGENTS.md` and `README.md` must stay in sync with the code; whoever changes the code updates
the docs. Edit the existing `docs/architecture/*` or `docs/guides/*` file whose topic fits; create one
only for a genuinely new subsystem (and add it to the [Documentation map](#documentation-map) and
below). Start a `docs/plans/*` doc only for a new initiative; record progress in the existing plan.

### This file (AGENTS.md)

When you change the structure (a product added or renamed, directories moved, where
features/steps/pages/configs live), a key technology or the Node/TypeScript baseline, an NPM script
(added, renamed or changed), a fixture, a shared hook, the configuration mechanism (`.env` vars,
`sites.json` schema, transports, editions, `ProductConfig` fields), a testing capability (a new
visual model, device profile, tag or `wp/` module), or a convention stated here. Detail too fine for
this file goes in the right `docs/` file, linked from the [Documentation map](#documentation-map).

### docs/architecture/execution-model.md

- Products, cells, pools, run units and their selection: `products.ts` and its drift guard, the cell pin
  (`E2E_CELL`, `cell-pin.ts`), the `[cell]` notice.
- The `parallelIndex` invariant or worker-to-site binding.
- The config factory (`createProductConfig`) or its project pairs.
- The metadata/credential registry (`registerPool`, `routingMetadata`) and the per-process policy
  registries (`registerDebugLogOptions`, `registerSiteResidue`, `registerSiteDbResidue`,
  `registerSiteDataDirResolver`, `registerStopRunningWork`, `registerSettleLeftovers`).
- Artifact directories, `RUN_ID`, the `*_ROOT` env vars.
- The drain (`config/drain.ts`, `E2E_INTERNAL_STOP_FILE`, `drainGate`) and its escalation signals.
- The run's reporters: `[cell]` notice, results stream (`results.jsonl`, schema, reader,
  `reporting/results.ts`), run facts (`run-facts.json`, report titles, banner, metadata), summary; the
  setup-vs-scenario project names (`config/project-names.ts`).
- Report retention (`retention.ts`, `report-tree.ts`, `run-pruning.ts`, `E2E_REPORTS_KEEP`,
  `prune-command.ts`) and the RUN_ID format (`config/run-id.ts`).

### docs/architecture/wordpress-automation.md

- Transports (`local`, `docker`, `ssh`), the `exec`/`wpCli` API, the transfer primitives (`wpRootDir`,
  `copyIntoTarget`), staging (`staging.ts`, `E2E_SITE_STAGING_DIR`, `transport.stagingDir`).
- Plugin lifecycle functions and their error types; plugin-folder inspection/removal (`plugin-dir.ts`).
- The debug-log API (`readDebugLog`, `clearDebugLog`, `scanDebugLog`, `ScanDebugLogOptions`).
- Ownership (`ownership.ts`: `planOwnership`, `normalizeOwnership`, the grant rule,
  `transport.fileOwner`) and path guards (`paths.ts`, `pathInsideRoot`).
- Residue (`residue.ts`: `parseResidueDeclaration`, `SiteResidueFamily`, `resolveSiteResidue`,
  `prepareResolvedDataDirs`, `isDeclaredResidue`) and the footprint sweep (`db-residue.ts`:
  `SiteDbResidue`, `findSiteDbResidue`, `removeSiteDbResidue`, `PROTECTED_OPTIONS`, `PROTECTED_TABLES`,
  `PROTECTED_ROLES`, `PROTECTED_CAPABILITIES`).
- Cron (`nextScheduled`, `triggerScheduledEvent`), the PHP bridge (`phpLiteral`, `evalPhp`,
  `EvalPhpOptions`), file readers (`fileChecksum`, `listFiles`, `listLocatedFiles`, `FILE_LIST_PHP`,
  `backdateFile`, `pathFromWorkingDir`, `locateFromWorkingDir`), archives (`findArchiveEntries`,
  `readArchiveEntry`), and any other `wp/` module (`cache.ts`, `db.ts`, `errors.ts`, `teardown.ts`).

### docs/architecture/plugin-artifacts.md

- The `ProductArtifacts` manifest (default refs, version policy, edition → variant, identity) or a
  product's copy.
- The request/plan model, override precedence, what throws vs. warns.
- Resolution (artifacts dir lifecycle, `resolution.json`), the identity preflight, what an artifact
  records (full commit, `digest.ts`: `sha256File`, `isSha256`, `ResolvedArtifact.sha256`).
- `pluginArtifact` consumption, pre-warming (`warmArtifacts`, `artifacts:warm`), pinning (`pin.ts`:
  `fullCommit`, `pinOf`, `requirePin`; `WarmedBuild`, `toWarmedBuild`, `assertCached`,
  `ResolvedArtifact.pinRef`).
- The APVM pin, or which products/editions exist.

### docs/guides/authoring-tests.md

The BDD pipeline (bddgen, generated specs, step wiring); Gherkin conventions (scenario naming, what
goes in `Feature`/`Background`); fixtures (added, renamed, scope or semantics); tags and their
effects (`@noauth`, `@smoke`, `@visual`, `@free`/`@pro`, new ones); page-object conventions and
`common/pages/`; the unit-test setup (`playwright.unit.config.ts`, `*.spec.ts`).

### The orchestrator (`orchestrator/`)

Update [`docs/guides/orchestrator.md`](docs/guides/orchestrator.md), the
[Phase 0.5 plan](docs/plans/orchestrator-phase-0.5-plan.md) (§4 design, §5 layout, §6 running it) and
the `orchestrator/` entry above when you change: `start`'s options, help, exit codes or the npm options
it refuses; the config file (`config/schema.ts`: fields, bounds, checks, `config.example.json`); what a
run is given or keeps (environment, commands, `run.json` states, files beside it, state-directory
layout, site locks); stopping (signals, `runs/shutdown.ts` budgets, the orphan check and its refusals);
`run.finished`, the Slack message, the Datator record, the terminal's and `orchestrator.log`'s lines;
`suite-imports.json` (update its boundary spec too, which must pass first).

### docs/guides/configuration.md

The `sites.json` schema (cell, site and transport fields, overrides); editions (all-or-none, the tag
filter); env vars (and their defaults in `.env.example`); the Docker environment and its
`sites.example.json`.

### README.md

Quick-start (install, first run, browsers); commands users run (test scripts, `--project`, `--grep`);
reporting (report types, paths, Allure, `REPORT_MODE`); the Docker environment (`env:*`, ports,
credentials); the visual-regression walkthrough; quality gates and CI.

### All docs and code files

A `NOTE FROM DEV:` in a doc or code comment is addressed to the next AI reading the file: read it
carefully — it may ask you to fix something there.
