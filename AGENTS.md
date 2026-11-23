# AGENTS.md

Operating guide for AI agents (and humans) in this repository. Read it first, then follow the links into
[`docs/`](docs/). Keep it accurate — see [When to update these docs](#when-to-update-these-docs).

## Project Overview

End-to-end (E2E) tests for WP Media plugins: WP Rocket (performance), BackWPup (backups) and Imagify
(image optimization), on **Playwright** (browser) and **Cucumber** (BDD).

> **Current state:** WP Rocket and BackWPup run (WP Rocket: its page cache from activation to removal,
> on the SSH twins; no real WP Rocket cell yet). Imagify is planned, not wired up — add it under
> `src/projects/` when work begins
> ([authoring-tests.md → Adding a product](docs/guides/authoring-tests.md#adding-a-product)).

## Key technologies

- **Runtime:** Node ≥ 26.13.1 (`engines`; `.nvmrc` and `.node-version` pin 26), ESM (`"type": "module"`).
- **Package manager:** npm ≥ 12.2.3 (`devEngines`; Node 26 ships 11: `npm install --global npm@12.2.3`);
  dependency install scripts only as `allowScripts` lists them, git dependencies only as
  [`.npmrc`](.npmrc) allows.
- **Language:** TypeScript 6, strict (`tsc` type-checks only — Playwright transpiles via Babel).
- **Browser automation:** Playwright ≥ 1.65.1 (`@playwright/test`), Chromium only. 1.64 is a floor
  (`screen`, [device profiles](#device-profiles-desktop--mobile)); 1.62's `RenderDocument` reason still
  applies ([why](docs/architecture/wordpress-automation.md#playwright--164-is-a-floor-not-a-preference)).
- **BDD:** Cucumber/Gherkin via `playwright-bdd` (`bddgen` generates specs).
- **WP-CLI transport:** execa 10 (local/docker), node-ssh 14 (ssh).
- **Visual diff:** pixelmatch 8 (OKLab/HyAB metric: its threshold is not Playwright's YIQ one) + pngjs.
- **Terminal layout:** string-width 9 (display width per grapheme, never below what a terminal draws;
  ambiguous width narrow).
- **Orchestrator:** zod 4 (its config), commander 15 (its `start`).
- **Reporting:** Playwright HTML, Cucumber HTML, Allure 3 (`allure` 3.33, `allure-playwright`).
- **Quality:** ESLint 10 (typescript-eslint 8, strict + type-checked), Prettier, husky + lint-staged.

## Repository structure

```text
src/
├── common/              # product-agnostic, shared by every product
│   ├── config/          # env accessors, sites loading, cell pin, drain, run id, devices, the config factory
│   ├── reporting/       # the suite's reporters (terminal, results stream, run facts, summary), retention,
│   │                    #   Allure report, download bundle
│   ├── terminal/        # side-effect-free terminal primitives (capabilities, palette, layout, live region)
│   ├── auth/            # the auth setup: login → storageState, session end, site versions
│   ├── setup/           # the auth setup's pre-flight, its reports/banners, healthcheck lines
│   ├── hooks/           # shared scenario hooks (*.hooks.ts) + their policy modules
│   ├── steps/           # generic step definitions
│   ├── pages/           # cross-product page objects + secret-field.ts (typing a secret)
│   ├── visual/          # visual-regression helpers (A/B, compare, stabilize)
│   ├── artifacts/       # the plugin zips under test (resolve, verify, consume, pre-warm, pin)
│   ├── wp/              # WordPress over WP-CLI (exec, identity, staging, plugin lifecycle, ownership, …)
│   ├── __fixtures__/    # spec helpers (stub wp, SSH server, ptys, fakes, SSH twins gate, …)
│   ├── fixtures.ts      # the extended test instance + Given/When/Then
│   ├── guards.ts        # type guards for narrowing `unknown`
│   ├── text.ts          # escaping, credential masking (redactSecrets, maskValues), printableLine(s)
│   └── deadline.ts      # withinBudget: a time limit for a best-effort step
└── projects/
    ├── products.ts      # the one product list; products.spec.ts guards it
    └── <product>/       # config/ (<product>.config.ts + sites*.json), fixtures.ts, features/, pages/
                         #   (BackWPup), steps/, support/ (product-specific WP-CLI, residue, debug-log presets, …)
orchestrator/            # runs cells in loops (layout: Phase 0.5 plan §5; design: §4)
docker/                  # local WordPress for the `docker` transport
docker/ssh-cells/        # SSH twins of the cells (Ubuntu 24.04, apache/nginx, sudo)
docs/                    # architecture & guides (linked below)
playwright*.config.ts    # entry configs (default, per-product, unit)
healthcheck.ts, warm-artifacts.ts, prune-reports.ts, capture-backwpup-fixtures.ts, scripts/  # npm scripts
```

File-level maps: [authoring-tests.md → Where things
live](docs/guides/authoring-tests.md#where-things-live) (and its spec helpers), the architecture
docs' per-module sections.

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
  fail fast. Each run prints a `[cell]` line.
- **Output folders** — `test-results/<product>/<cell>` for a run targeting a cell,
  `<product>/_all/<cell>` otherwise, `_unit` for unit runs (`outputDirFor`). Reports and logins are
  absolute paths in the checkout.
- **Stopping a run** — the [drain](docs/architecture/execution-model.md#stopping-a-run-the-drain):
  creating the file `E2E_INTERNAL_STOP_FILE` names skips each scenario's first attempt as `stopped`.
  Escalate with **one** SIGINT to the runner, then SIGKILL its process group — never SIGTERM, never a
  second SIGINT.
- **Watching a run** — `<report dir>/results.jsonl` streams every event (schema v1,
  `reporting/results-schema.ts`); no `run.end` means the runner died. The terminal reporter replaces
  `list` and is the one writer (other reporters print through its sink, `printLine`): worker output
  live and masked, a live progress block on a capable TTY, a failure block with a `Rerun` command,
  the summary. `E2E_OUTPUT=auto|plain|fancy`. A closed pipe never crashes the run. Every credential a
  message quotes is masked by its shape (`redactSecrets`), APVM's output also by value (`maskValues`,
  against `GITHUB_TOKEN`/`GH_TOKEN`). Traps: `--reporter` replaces the whole stack, `--add-reporter`
  doubles the lines (not detected) —
  [details](docs/architecture/execution-model.md#watching-a-run-the-terminal-the-results-stream-and-the-summary).
- **What a run tested** — one facts line as the reports' title/banner/name, every fact in
  `<report dir>/run-facts.json`. `captureGitInfo` is **off**: Playwright would turn it on under CI and
  put authors' emails and a diff in the report. Allure gets `GIT_DIR=NO_GIT_DIR` (`allureEnv`): its
  git lookup would embed the origin URL (credentials too), branch and commit.
- **Report retention** — each run prunes its own cell's reports as it ends (`E2E_REPORTS_KEEP`, 20;
  30 days; the newest complete one up to 182); `npm run report:prune` does every cell.
- **One cell, one orchestrator run** — a lock per site, keyed by `baseURL`, shared by every
  orchestrator of this user on the machine. Not covered: other users, other machines, runs started by
  hand, one site under two addresses ([orchestrator.md](docs/guides/orchestrator.md#one-run-per-site)).

## NPM commands

```bash
# Testing
npm run test                                        # default product, bddgen + run
E2E_CELL=<cell> npm run test:wp-rocket              # one product, one cell (safe beside other cells)
E2E_CELL=<cell> npm run test:backwpup               # also test:<product>:ui, test:<product>:headed
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
npm run fixtures:capture                            # re-capture BackWPup's locator-contract markup
                                                    # from a real site (mutates it: QA cells only)

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
npm run report:allure -- wp-rocket apache --open    # serves on 127.0.0.1 only (remote: ssh -L)
npm run report:allure -- backwpup pro@nginx <RUN_ID>  # that run
npm run report:prune                                # dry run of retention over every cell
npm run report:prune -- --apply                     # remove (--keep, --older-than, --keep-newest-for, --product, --cell)

# Local WordPress (Docker transport)
npm run env:up                                      # Apache(:8100) & Nginx(:8101) sites
npm run env:down                                    # stop & remove, volumes included
npm run env:logs
npm run env:cells:up                                # SSH twins (one set per machine): key, build, wait, overlays
npm run env:cells:reset -- nginx site               # reset one twin to a variant (apache|nginx; lists variants)
npm run env:cells:down                              # overlays + twins (-- --force: another checkout's; -- --purge-key)

# Browsers
npm run setup                                       # playwright install chromium (also on postinstall)
```

## Configuration

Schema: **[configuration.md](docs/guides/configuration.md)**.

- **Sites files** (per product, **git-ignored**, hold credentials) define cells and pools: `sites.json`
  plus `sites.<name>.json` overlays, merged alphabetically, each owning disjoint cells. With none, the
  committed `sites.example.json` (placeholders) is used, so a fresh checkout passes the `@noauth`
  smoke; an overlay alone (e.g. the SSH twins' `sites.twins.json`) replaces the example. Credentials
  live only there and never enter reports. Unknown site or transport keys fail the load.
- **Site identity fields** ([`run-as.ts`](src/common/config/run-as.ts)): `transport.runAs`
  (`"auto"`, the default; `"user:group"`, never root; or `false`: the transport's user) and
  `transport.umask` (default `0022`, must keep the owner's bits), both `ssh` only, refused on
  `docker`/`local`; `transport.wpUser` (every transport) is resolved-only, copied from the site's
  `username` (a sites file setting it is refused).
- **`.env`** (from `.env.example`, loaded by [`load-env.ts`](src/common/config/load-env.ts)): runtime
  flags and BackWPup storage credentials. Real env vars win; `E2E_LOAD_DOTENV=false` in the
  environment skips the file. Never set `E2E_CELL` there. Read env only through the typed accessors in
  [`env.ts`](src/common/config/env.ts) (`outputModeEnv` for `E2E_OUTPUT`:
  [Terminal output](docs/guides/configuration.md#terminal-output)); the orchestrator reads no `E2E_*`.

## Fixtures

Import step builders and fixtures from a `fixtures.ts`, **never** from `playwright-bdd`. Product steps
use **their product's** `fixtures.ts`; shared steps and hooks use
[`src/common/fixtures.ts`](src/common/fixtures.ts). playwright-bdd picks the most-extended instance a
scenario's steps use, so they mix — but the product's `fixtures.ts` must be in its `steps` config, or
generation fails.

Shared: `site` (throws without a pool: tag `@noauth` instead), `edition` (throws in editionless
cells), `boundSite`, `pluginArtifact(role)` (`.slug`, `.zipPath`), automatic `releaseBoundSite` and
`drainGate`, and overrides of `context` (watches the site's lost requests), `baseURL`, `storageState`
and the device options. WP Rocket adds `visitor` and `pageCache`; BackWPup page objects and scenario
state. What each does:
[authoring-tests.md → Fixtures](docs/guides/authoring-tests.md#fixtures-srccommonfixturests). Traps:

- Inside a test, `playwright.request.newContext` takes the project's `use` options, **the saved login
  included**: pass an empty `storageState` for an anonymous client.
- BackWPup's `cli` is for the command **under test** (returns a refusal instead of throwing); to
  arrange or check a site use `support/backups.ts` (throws). A `--key=` value never appears in a
  message naming the command: name it through `commandLine` (`support/cli.ts`).
- BackWPup's `markers`: request them **before** the backup under inspection runs (requesting plants
  them). `cliRestore` is the only way to run `wp backwpup restore`
  ([its guards](docs/guides/authoring-tests.md#backwpups-fixtures)).

## Shared scenario hooks

[`src/common/hooks/`](src/common/hooks/): each `*.hooks.ts` only binds to the BDD runtime; its policy
lives in a sibling module, unit-testable without it.

**`@plugin`** ([`plugin.hooks.ts`](src/common/hooks/plugin.hooks.ts)) gives each scenario a fresh
install of the cell's plugin and judges its removal: Before, stop a killed run's leftover work, remove
any old copy, record the files it edits in place, sweep its leftover database footprint, install and
activate the artifact (ownership handed to the site), settle with a web request where the product
asks; After, stop running work, **fail on a PHP fatal in `debug.log`**, uninstall (a failed uninstall
fails), clear its files and rows, put back its in-place edits. A drained scenario gets neither. Order,
verdicts, timeouts:
[wordpress-automation.md → The `@plugin` scenario hooks](docs/architecture/wordpress-automation.md#the-plugin-scenario-hooks-hookspluginhooksts).

**MUST — `src/common/hooks/**/*.hooks.ts` belongs in every product's `steps` globs.** That glob is
the only importer: omit it and the lifecycle is _silently absent_.

A product hands shared code its policy (`debugLog`, `stopRunningWork`, `forceDeactivate`,
`settleLeftovers`, …) through `ProductConfig`, registered per process by the config factory (RegExps
and functions cannot ride project metadata).

## Device profiles (desktop & `@mobile`)

Tag-driven, per scenario, never a project dimension
([`config/devices.ts`](src/common/config/devices.ts)): default Desktop Chrome at `1600×700`;
**`@mobile`** the full Pixel 5 preset (user agent, touch, scale, screen) at `389×829`, so responsive
CSS, touch handlers and user-agent checks see a phone. Both viewports are pinned, so a Playwright
upgrade cannot shift them. Each `screen` is its preset's (1920×1080, 393×851 on 1.65.1), read and
checked by `presetScreen`: the presets' type omits it, and since 1.64 a spread preset applies it, so
an `@mobile` scenario without the `screen` override would report the desktop's.

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
in a fresh Node to prove the process unchanged
([what it compares](docs/architecture/execution-model.md#the-product-list)). Admit a module only once
that spec passes.

## Auth setup and health check

[`auth.setup.ts`](src/common/auth/auth.setup.ts) runs before a cell's scenarios, per real site
(skipped when a cell has only placeholder sites): a gating **pre-flight** (transport, WP-CLI, a
bootable installed WordPress, a POSIX login shell over `ssh`, an English admin UI; it also asks the
web server who PHP runs as, never a gate: `auto` without an answer runs `fallback/unverified`, warned;
reports on ownership, elevation, site identity and plugin folders, never gates), then a UI
**login** saved as `storageState` (ending the previous run's session), then the **site versions**.
`npm run healthcheck` runs the same pre-flight and login standalone on every product × cell × site.
Walkthrough: [execution-model.md → The auth setup](docs/architecture/execution-model.md#the-auth-setup-and-the-health-check).

> **No site password in a report; traces still need care.** Playwright titles `fill()`/`type()`/
> `pressSequentially()` steps with their text, unmasked, so **every secret is typed with
> `enterSecret`** ([`pages/secret-field.ts`](src/common/pages/secret-field.ts);
> `StorageSidebar.fillSecret` for a storage key). The auth setup traces **without DOM snapshots** and
> turns off its tests' `error-context.md` page snapshot;
> [`secrets.run.spec.ts`](src/common/auth/secrets.run.spec.ts) proves it through the real runner.
> Still exposed: a **scenario's** trace holds the WordPress **session cookies** (live until the next
> run ends that session, or two days), and its trace and `error-context.md` any value typed or shown in
> a field; a failed `@plugin` scenario of a settling product (WP Rocket) traces its settling request,
> that session cookie and the dashboard's HTML included; BackWPup's restore wizard renders the
> **database** password into its markup; Pro's restore deep link and messages naming the restore
> folder carry its 20-hex name — on nginx the only thing keeping the folder, and the DB credentials its
> `restore.dat` holds mid-restore, from being served (the teardown removes it). Treat `test-results/`
> and reports as sensitive as the sites file.

## Plugin artifacts (the zips under test)

Every run resolves **and verifies** its zips before any scenario, in the `artifacts:<cell>` setup
project: roles `plugin` (under test) and `previous` (older, for comparisons). Each zip's SHA-256, a
build's full commit and its `pinRef` are recorded. Design, overrides (six `E2E_*` vars, ref XOR zip),
pre-warm: **[plugin-artifacts.md](docs/architecture/plugin-artifacts.md)**,
[configuration.md](docs/guides/configuration.md#plugin-artifacts-build--verify).

- **APVM** ([`apvm-napi`](https://github.com/wp-media/automation-plugin-version-manager), pinned to
  `…#v3.3.0`, prebuilt binaries) builds a git ref. BackWPup's source is **private**: set
  `GITHUB_TOKEN` or run `gh auth login`; for public WP Rocket/Imagify a token only raises rate limits.
  **MUST — APVM only through this Node library, never its `apvm` CLI**, anywhere in the repo (suite,
  scripts, orchestrator); a CLI-only capability waits for a library release. Agents may still run the
  CLI in a shell.
- **Consumption:** `stageAndInstallPlugin(site.transport, a.zipPath, { activate: true, slug: a.slug })`
  with `a = pluginArtifact("plugin")` — the `slug` restores file ownership. `zipPath` is on the
  **runner**, so a bare `installPlugin` works only on `local`.

**MUST — BackWPup has no `previous` role yet**: `pluginArtifact("previous")` throws and
`E2E_PREVIOUS_*` is warned and ignored. When comparison tests arrive, add a `previous` default ref
(`release:latest-stable`) **and** default version to
[`backwpup.config.ts`](src/projects/backwpup/config/backwpup.config.ts); the preflight then verifies it
automatically, and that verification **must not** be skipped. Mirrored as a comment on that manifest.

## WordPress automation layer

`src/common/wp/` drives a site over WP-CLI on any transport (local / docker / ssh). Reference, with the
why of each rule: **[wordpress-automation.md](docs/architecture/wordpress-automation.md)**. The rules:

- **MUST — `wp` never runs as root; site commands run as the site's identity** (`exec`/`wpCli`, never
  `execElevated`: WP-CLI as root leaves files the web server cannot write). Root stays
  `execElevated`. Probes and checks about the SSH user use `execAsTransport`, never `exec`.
- **Code that writes into a docroot calls `normalizeOwnership` on what it wrote; never
  `chown`/`chmod` directly** — a no-op in the `site` state, but call it anyway, never branch on the
  state. `stageAndInstallPlugin` does it when given the `slug` — pass it.
- Over `ssh` a command is `cd -- <cwd> && exec <program> <args…>`, every word quoted: `rootDir` must
  be absolute, the program an executable on the login's `PATH` (never a shell function), the login
  shell POSIX. Commands are file + args arrays, never shell strings. **An exec error names the
  program and the reason, never the arguments** (they carry `--key=` values and snippet values):
  never pass on execa's `message`/`shortMessage`/`command` or attach its error as a `cause`.
- `exec`/`wpCli` return an `ExecResult`: branch on `exitCode`. Commands run with no input, so a `[y/n]`
  prompt declines at once, exit 0, having done nothing.
- **Files must reach the site before `wp` reads them**: stage with `stageArtifact` /
  `stageAndInstallPlugin`.
- Removal: deactivate as its own call, then plain `wp plugin uninstall` — **never `uninstall
--deactivate`** (the plugin's cleanup skips itself). A deactivation is read back, never trusted from
  its exit code. **"Absent" means nothing at the plugin's path**, not "WordPress lists none". Cleanup
  (`ensurePluginAbsent`) heals; removal under test (`uninstallPlugin`) throws.
- **`wp eval` goes through [`wp/php.ts`](src/common/wp/php.ts)** where it can; **any value from
  outside this codebase (site, scenario, fixture) is embedded with `phpLiteral`** — the injection
  boundary, no exceptions.
- **Site identity** ([`wp/site-identity.ts`](src/common/wp/site-identity.ts)): a probe that throws
  is rethrown, never answered with a fallback (one call would run as another user); the web probe file
  is created with `O_EXCL` (`dd conv=excl`, never `set -C`, which writes through a symlink to a FIFO).
- `wpCli` adds `--user=<the site's username>` on every transport once a check finds an administrator
  under that non-numeric login, else drops it with a warning; the login is never printed
  ([details](docs/architecture/wordpress-automation.md#wordpress-runs-as-the-sites-administrator---user-wpwp-userts)).
- **Never `wp cron event run <hook>`** (it runs every event on the hook, in WP-CLI's PHP): use
  `triggerScheduledEvent`.
- Read options with `getOption`/`getOptionJson`; never hard-code `wp_` — use `tablePrefix`.
- `listFiles` refuses a missing directory (it would pass "it was deleted"); prove a transfer with
  `fileChecksum`, not size.
- An elevated target built from `rootDir` passes the guards in `wp/paths.ts` and
  `assertResolvedInsideRoot` (no symlink out of the docroot).
- Leftovers are declared, never swept by guess: `ProductConfig.siteResidue` (files) and
  `siteDbResidue` (options, tables, roles, capabilities, WP-Cron hooks), both verified by re-reading.

## Visual testing (A/B only, for now)

The only active model is the A/B check ([`visual/ab.ts`](src/common/visual/ab.ts)): a page renders
the **same optimized as bypassed** (`?nowprocket`), both captured live and pixel-diffed, no baseline; a
size difference fails too. Tag `@visual`, run in the Playwright container; tolerances in
[`config/visual.ts`](src/common/config/visual.ts). `screenshot.ts` (committed baselines) is wiring
only. Walkthrough: [README → Visual regression](README.md#visual-regression).

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
  State the behaviour _and_ its outcome, no back-reference (`…just the same`, `…too`, a dangling
  `it`); shared setup, and why scenarios resemble each other, go in `Feature`/`Background`
  ([authoring-tests.md → Naming scenarios](docs/guides/authoring-tests.md#naming-scenarios)).
- **Docroot ownership**: the `normalizeOwnership` rule in
  [WordPress automation layer](#wordpress-automation-layer).
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

After any code change, run **all** of these and make them pass before calling the work done, with
npm ≥ 12 first on `PATH` (`npm --version`): an npm 11 earlier on it — Homebrew's Node 26 ships one —
fails every npm command here (`EBADDEVENGINES`), and `test:unit`'s `npm run` specs use `PATH`'s npm:

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

Each doc and what it owns: read it before working on its topic, update it in the same change.

- [`README.md`](README.md) — quick-start (install, first run, browsers), the commands users run,
  reporting (report types, paths, Allure, `REPORT_MODE`), the Docker environment, the
  visual-regression walkthrough, quality gates and CI.
- [`docs/architecture/execution-model.md`](docs/architecture/execution-model.md) — products, cells,
  pools and their selection (`products.ts`, the cell pin); worker-to-site binding; the config factory
  and its projects; the pool registry and the per-process policy registries (`register*`); the auth
  setup and the healthcheck; artifact directories, `RUN_ID`, the `*_ROOT` env vars; the drain; the
  run's reporters, results stream, run facts, summary, terminal primitives; report retention.
- [`docs/architecture/wordpress-automation.md`](docs/architecture/wordpress-automation.md) — anything
  in `src/common/wp/` (transports, `exec`/`wpCli`, staging, plugin lifecycle, debug log, ownership,
  install outputs, path guards, site identity, in-place cleanup, residue, cron, PHP, files, archives,
  errors) and the `@plugin` hooks.
- [`docs/architecture/plugin-artifacts.md`](docs/architecture/plugin-artifacts.md) — the plugin zips
  under test: the `ProductArtifacts` manifest, requests and overrides, resolution and the identity
  preflight, what an artifact records, consumption, pre-warming, pinning, the APVM pin, which
  products/editions exist.
- [`docs/guides/authoring-tests.md`](docs/guides/authoring-tests.md) — the BDD pipeline, Gherkin
  conventions, fixtures, tags, page objects, the unit-test setup and spec helpers.
- [`docs/guides/configuration.md`](docs/guides/configuration.md) — the `sites.json` schema, transports,
  editions, env vars (and their defaults in `.env.example`), the Docker environment and its
  `sites.example.json`, the SSH twins.
- [`docs/guides/orchestrator.md`](docs/guides/orchestrator.md) — installing, configuring, running and
  stopping the orchestrator (with the Phase 0.5 plan: [When to update](#when-to-update-these-docs)).

## In-progress plans

Living design docs in `docs/plans/` — check them before related work; they hold the current plan, not
history:

- [`e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md) — design rationale and
  decisions; Phase 10 (cleanup & validation) and Phase 11 (shared SSH server profiles) open; the
  finished plugin-artifact and site-file-ownership designs (facts, open obligations).
- [`phase-6-feature-porting-plan.md`](docs/plans/phase-6-feature-porting-plan.md) — feature porting
  (BackWPup first; paused until Phase 11, resumes at 6H; 6H.2 deferred); supersedes the parent
  plan's Phase 6.
- [`orchestrator-plan.md`](docs/plans/orchestrator-plan.md) — the orchestrator, a long-running service
  running cells on a server (supersedes the parent plan's Phase 9); Phase 0 (done): the run contract.
- [`orchestrator-phase-0.5-plan.md`](docs/plans/orchestrator-phase-0.5-plan.md) — the minimal
  orchestrator (cycling cells, Slack, Datator) replacing AutoE2E's BackWPup instances: §4 design, §5
  layout, §6 running it; done, its first deployment pending (§9).
- Done, kept for their decisions, facts and open obligations:
  [`phase-12-site-identity-plan.md`](docs/plans/phase-12-site-identity-plan.md) (site commands as the
  web server's identity, `wp --user`, WP Rocket's lifecycle),
  [`orchestrator-report-delivery-plan.md`](docs/plans/orchestrator-report-delivery-plan.md) (each run's
  report bundle), [`dependency-update-plan.md`](docs/plans/dependency-update-plan.md) (Node 26, npm 12,
  every dependency to its latest stable).

## When to update these docs

`docs/`, `AGENTS.md` and `README.md` must stay in sync with the code; whoever changes the code updates
the docs. Edit the existing doc that owns the topic ([Documentation map](#documentation-map)); create
one only for a genuinely new subsystem (and add it to the map). Start a `docs/plans/*` doc only for a
new initiative; record progress in the existing plan. Detail too fine for this file goes in the right
`docs/` file.

- **This file** — the structure (a product added or renamed, directories moved), a key technology or
  the Node/TypeScript baseline, an NPM script, a fixture, a shared hook, the configuration mechanism
  (`.env` vars, `sites.json` schema, transports, editions, `ProductConfig` fields), a testing
  capability (a visual model, device profile, tag or `wp/` module), a MUST/never rule or a convention.
- **The orchestrator** — [orchestrator.md](docs/guides/orchestrator.md) and the
  [Phase 0.5 plan](docs/plans/orchestrator-phase-0.5-plan.md) (§4 design, §5 layout, §6 running it),
  when you change: `start`'s options, help, exit codes or the npm options it refuses; the config file
  (`config/schema.ts`, `config.example.json`); what a run is given or keeps (environment, commands,
  `run.json` states, files, state-directory layout, site locks); stopping (signals,
  `runs/shutdown.ts` budgets, the orphan check); `run.finished`, the Slack message, the Datator
  record, the terminal's and `orchestrator.log`'s lines; `suite-imports.json` (update its boundary
  spec too, which must pass first).

A `NOTE FROM DEV:` in a doc or code comment is addressed to the next AI reading the file: read it
carefully — it may ask you to fix something there.
