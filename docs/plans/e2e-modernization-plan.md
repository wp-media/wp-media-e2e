# E2E Modernization Plan — `wp-rocket-e2e` → `wp-media-e2e`

- Status: done — Phases 0–5, 7 (terminal output, 2026-11-01), 12 (run as the site, 2026-11-17,
  [phase-12 plan](phase-12-site-identity-plan.md)), plugin artifacts (§7) and site file ownership
  (§8), both formerly plans of their own. **Next: Phase 11 — shared SSH server profiles** (open).
  Phase 6 in progress in the [phase-6 plan](phase-6-feature-porting-plan.md) (resumes at 6H after
  Phase 11). Phase 10 open. WP Rocket's port after Phase 10. Phase 8 dropped; Phase 9 moved to the
  [orchestrator plan](orchestrator-plan.md).
- Baseline (reference only): `wp-rocket-e2e`, the legacy suite being superseded. Target: this repo.
- Scope: decisions and why, verified external facts, limits, open work. As built:
  `docs/architecture/` (execution-model, plugin-artifacts, wordpress-automation), `docs/guides/`
  (configuration, authoring-tests, orchestrator), README, AGENTS.md.

## TL;DR

- Gherkin through the Playwright runner (`playwright-bdd`, not the Cucumber CLI) on ESM, Node 26 and
  strict TypeScript. Goal: match or beat the baseline in capabilities, reporting, maintainability and
  security, and add multi-product, multi-environment parallel runs.
- Porting modernises, never copies 1:1 (web-first assertions, auto-waiting locators, fixtures,
  `storageState`, strict types, explicit errors). Coverage never regresses.
- Run model: a (product × cell) matrix, one Playwright invocation per run unit with `workers` = the
  cell's pool size, because `parallelIndex` is global per invocation (§2.1). One report per run unit,
  never merged; credentials never enter report-bound metadata (§2.2).
- The plugin zips under test are resolved, built through APVM and identity-verified per run (§7);
  what the suite installs belongs to the site's owner (§8), and since Phase 12 site commands run as
  the site's identity.
- Open: Phase 11 (a site may take `host`, `username`, `privateKeyPath` and `port` from a shared
  profile or the environment; `rootDir` stays per site), then Phase 6's 6H–6K, Phase 10 (dependency
  check, cleanup, deferred flakes) and WP Rocket's port (parity matrix, §4).

## 1. Core decisions

- D1 — Execution is a (product × cell) matrix with a site pool per cell: one Playwright invocation
  per run unit, `workers` = pool size (§2.1). Parallelism shipped in v1.
- D2 — Products are fully separated: own BDD config, directories, sites file and reports; only
  `src/common/` is shared. BackWPup's storage config is invisible to WP Rocket.
- D3 — Cells are data (the top-level keys of a product's sites files), not an enum. `ssh`/`local`
  take any number; `docker` ships Apache + Nginx with a fixed PHP.
- D4 — Each run unit produces its own report; no merging (`blob` + `merge-reports` deliberately
  unused).
- D5 — Server modes: `ssh` (default, the baseline's `external`), `docker` (Apache and Nginx),
  `local` (whatever the user runs). Why a custom compose: §2.9.
- D6 — Full reporting stack: Playwright HTML, Cucumber HTML (dual-mode, `REPORT_MODE`), Allure 3
  (§2.8).
- D7 — The plugin lifecycle covers WP-CLI and the admin UI. Cleanup is idempotent (absent ⇒ no-op);
  deletion as the action under test asserts presence first (§2.10).
- D8 — Orchestrator-ready from day one: all isolation lives in the suite, so the orchestrator only
  automates running cells. The two gaps found later (`bddgen` rewriting every cell's specs, the
  shared root `test-results/`) were closed by the orchestrator plan's 0A.1 and 0A.2.
- D9 — BackWPup Free and Pro are one product; edition is a per-cell property. ~90 % shared: a second
  product would duplicate the shared part or fake-share it (§2.6).
- D10 — Site credentials never enter Playwright `metadata`, which Playwright serialises verbatim into
  its reports; pools reach workers through an in-process registry (§2.2).

## 2. Design rationale

What only this plan holds; each section links the as-built description.

### 2.1 One invocation per run unit

Verified against Playwright's docs (test-projects, test-parallel, class-testinfo, class-workerinfo,
class-testproject):

- Projects multiply (several projects matching the same tests run each test once per project);
  workers distribute (each test once, the next pending file to a free worker).
- `testInfo.parallelIndex` (stable, restart-safe, `0…workers-1`) is bounded by the global `workers`
  and not reset per project (microsoft/playwright#38953 shows indices beyond per-project worker
  counts). So `pool[parallelIndex]` is safe only with one project per invocation and `workers` = pool
  size; two cells in one invocation overflow the smaller pool.
- Per-project `workers` (since 1.52) caps how many workers a project uses, not which `parallelIndex`
  values it sees, so it does not make a multi-cell invocation safe.

Hence one cell per invocation; selecting more fails fast; a cell-less run is serial (`workers = 1`)
into an `_all` bucket; the matrix comes from running cells side by side. As built:
[execution-model.md](../architecture/execution-model.md) ("Worker → site binding", with the
`E2E_CELL` pin that made two cells of one product safe side by side).

### 2.2 Worker → site binding and credentials

- A worker-scoped fixture binds the worker to `pool[parallelIndex]`; `baseURL` and `storageState`
  derive from it. Steps never hard-code a URL or credential, so adding sites or cells never touches
  step code.
- The config factory registers each cell's pool in an in-process registry while building the
  config; Playwright re-runs the config in every worker, so each resolves its pool locally.
  `metadata` carries only `{ product, cell, edition? }`.
- Playwright titles a `fill()` step with its value: the login put the site password into every
  real run's reports until secrets were typed through `enterSecret`. A scenario's retained trace
  still holds session cookies (AGENTS.md).

As built: execution-model.md, "Credential handling".

### 2.3 Artifact lifecycles

- Two lifecycles, decided by whether a history has value. History accumulates: reports (pruned as
  each run ends and by `report:prune`) and each cell's `allure-history.jsonl` (outside run pruning,
  bounded to its newest 100 runs: [report delivery plan](orchestrator-report-delivery-plan.md)).
  Build output and transient state (generated specs, `storageState`, `test-results`) is overwritten
  in place.
- Every path is keyed by `<product>/<cell>`; `*_ROOT` overrides replace only the root, the namespace
  is always appended, so an override cannot merge two cells.
- A cell runs with zero env vars; `RUN_ID` only names the report folder.
- Reports are self-contained (each copies in its attachments), so emptying `test-results` never
  harms an older report. Cross-run trends come from Allure.
- The same cell never runs twice at once: its pool is shared WordPress state, and two runs would
  corrupt each other's database.

As built: execution-model.md, "Artifact directories & lifecycle" and "Report retention".

### 2.4 Scope and scaling

A pool may be size 1 (serial within the cell, same machinery). Scaling a cell is data only: add
sites to a pool, or a cell key. A product is a folder, its `products.ts` entry, a root
`playwright.<name>.config.ts` and a `test:<name>` script (authoring-tests.md, "Adding a product").

### 2.5 Products, sites files and service secrets

- Per-product Playwright entries sit at the repo root so every glob resolves repo-root-relative.
- Per-product structured sites files, not one flat `.env`: `process.env` is global to a process, so
  a different `.env` per product is impossible.
- Global service credentials (one external service per product) come from the environment; the
  committed config holds only their shape.
- A site may override a service credential in its own `overrides` block (validated at load with a
  path-named error) — mostly to dodge per-host rate limits (FTP connection caps) when a cell runs
  many sites, or to point at another bucket or server. Likely candidates: FTP (high rate-limit
  risk), Dropbox and Rackspace (medium); S3 and Azure rarely.
- **Not built:** the override is meant to be deep-merged over the product's `services`
  (`merge(product.services, site.overrides)`), but nothing reads `services` or `overrides` yet (only
  `sites.ts` validates them; `types.ts`' `ServiceOverrides` TSDoc already says "merged"). Build the
  merge, or correct this text, `types.ts` and configuration.md, before the storage scenarios
  (phase-6 plan's 6H.2; the orchestrator plan's 0B.1).
- On the site, not in `SITE_<n>_<KEY>` env keys: it fits the data shape (an env key would encode
  product, cell and index, `WPROCKET_NGINX_SITE_2_FTP_HOST`), and index-based keys bind to an array
  position, so reordering a pool silently remaps them. Secret exposure does not separate the two:
  the sites file is already git-ignored and holds each site's secrets.

As built: configuration.md (but the merge above).

### 2.6 Editions (Free / Pro)

- Free and Pro are separate packages sharing most behaviour: Pro has Free's features (minus a few
  Free-only items such as beta subscriptions) plus more storages, quality-of-life flows and enhanced
  variants of shared flows.
- Edition belongs to the cell because it decides three cell-wide things: the package installed, the
  scenarios generated, the page-object branch. None is per site, so it is declared once per cell
  (`pro@nginx`) — one value per cell, so no per-site field and no pool-uniformity check; it rides
  cells-as-data (per-edition pools, reports, orchestration, no new matrix
  axis) and, being non-secret, travels in routing metadata.
- Tags: none = both editions; `@pro` / `@free` = that edition's cells, filtered at generation
  (`not @free` on Pro, `not @pro` on Free; playwright-bdd `tags`), composing with `--grep`.
- **Open, no phase owns it:** a scenario tagged both would run nowhere; the design rejects it but
  nothing enforces it (no check in `project.ts` or `types.ts`).
- Different user journeys become separate `@free`/`@pro` scenarios sharing a Background (restore:
  Pro restores from the backup list, Free uploads a downloaded backup). Same steps with incidental UI
  differences: one untagged scenario and an edition-aware page object (an interface, one class per
  edition, a factory selected by the `edition` fixture). Pro-only storages need no config split;
  their scenarios are `@pro`. Restore parity is the phase-6 plan's 6I.1 (CLI restore stays Pro-only
  by product design).
- An edition-ful product declares an edition on every cell — all-or-none, failing at load — rather
  than install an undefined package or run both editions' scenarios.
- Package selection is the artifacts capability (§7). Rejected: a static `plugin: { free, pro }` zip
  map in the product config — a committed path cannot say which build it holds, and nothing verified
  that a `pro` cell got the Pro package.

As built: configuration.md, "Editions"; authoring-tests.md, "Tags".

### 2.7 Authentication

Authenticate once per site and reuse its `storageState`, instead of the baseline's per-scenario UI
login. Placeholder sites are skipped, so a fresh checkout stays green; `@noauth` scenarios start
unauthenticated.

Not built: multi-user, which the baseline supports (`admin` vs `admin2`) — a second per-site state
file plus a step `Given I am logged in as {string}` → `context.setStorageState(path)`.

As built: [execution-model.md → The auth
setup](../architecture/execution-model.md#the-auth-setup-and-the-health-check).

### 2.8 Reporting

- Three tiers together, since playwright-bdd emits standard Playwright tests: Playwright HTML (the
  trace viewer, the baseline's real gap), Cucumber HTML (the baseline report's successor), Allure 3
  (history, trends, flaky categories, dashboards, `singleFile`). Capture: trace and video
  `retain-on-failure`, screenshot `only-on-failure`.
- The Cucumber report trades a portable single file against an in-report trace viewer, so both exist
  (`REPORT_MODE`): default, one self-contained file (screenshots and video embedded, only the trace
  zip skipped) that opens from `file://`; `rich`, HTML plus `data/` with the trace viewer, served
  over `http(s)://`.
- The reporter embeds whatever exists and has no "embed only on failure" switch, so never add
  `video/webm` to `skipAttachments` in the default mode.

As built: README, "Reporting"; `src/common/config/reporting.ts`.

### 2.9 Server modes

- The mode (`ssh`, `docker`, `local`) decides only how WP-CLI is dispatched, orthogonal to which
  sites run. Sharing SSH connection fields across sites: Phase 11.
- `@wordpress/env` is Apache-only (verified in its installed source: `FROM wordpress${phpVersion}`,
  `APACHE_RUN_*`, no Nginx path), so a custom compose provides both over one MariaDB: Apache from
  `wordpress:php8.x-apache`; Nginx = `wordpress:php8.x-fpm` with no published host port (Docker
  Hub's FastCGI security note) plus `nginx` with a WordPress vhost (php-fpm alone serves nothing); a
  `wordpress:cli` container per install. `@wordpress/env` stays an optional Apache-only convenience.

As built: README, "Local WordPress (Docker)"; `docker/`.

### 2.10 Exec layer and plugin lifecycle

- Commands are array args (never a shell string) with an `exitCode` on every mode — the baseline
  omitted it on its docker/local branch, which made guards impossible.
- Two intents are never conflated. Cleanup (every scenario's Before/After) makes the plugin absent
  and treats already-absent as success (a Before runs before the first install; an After may follow
  a scenario that removed the plugin itself). Deletion under test treats absent-when-expected and a
  failed deletion as failures, with distinct error types.
- `wp plugin delete` exits non-zero both for "not found" and for a real failure, so state is never
  read from its exit code (today: `uninstall`, absence proved by path — wordpress-automation.md).
- The UI path exists because some product flows exist only there. WP Rocket's post-delete "delete
  data" confirmation is not exercised yet — verify when porting WP Rocket.
- Baseline equivalents: DB ops → `dbQuery`; settings export/import diff → `expect` deep-equality,
  `microdiff` only if a structured diff object is needed (WP Rocket, pending); `debug.log` scan →
  tag-scoped hooks, with a direct file read when a fatal stops WordPress booting.

As built: wordpress-automation.md; the UI delete flow in `src/common/pages/plugins.page.ts`.

### 2.11 Page objects and step wiring

- Plain page objects only — no playwright-bdd decorators or `@Fixture` style, no hybrid. Interaction
  logic lives once in the POM, Gherkin wiring in thin step functions. Product POMs register as
  fixtures in the product's own `fixtures.ts`. Edition-divergent pages: §2.6.
- Trap: a step file outside the product's `steps` glob, or not exported, registers zero steps
  silently ("undefined step").
- Port the baseline's `sections.ts` / `selectors.ts` to role- and label-based locators and web-first
  assertions: no brittle CSS chains, no manual `isVisible()` polling.

As built: authoring-tests.md, "Page Object Model".

### 2.12 Visual regression

The baseline's BackstopJS was fully disabled (`return; // Skip VR tests` in every step, zero
committed references) and used only an A/B model: the page with optimisations bypassed
(`?nowprocket`) against the optimised page, same run, no stored baseline. So the active model is
that A/B check, diffed with pixelmatch + pngjs (browser-free, unit-testable; pixelmatch 8 uses an
OKLab/HyAB metric, Playwright bundles a YIQ one). The committed-baseline helper (`screenshot.ts`) is
wiring only; if ever activated, generate baselines in the CI image or container, commit them per
project and mask dynamic regions. The `@visual` scenarios land with WP Rocket's port.

As built: README, "Visual regression"; AGENTS.md, "Visual testing".

### 2.13 Device profiles

Device is a per-scenario client concern, orthogonal to cells and editions (it never multiplies the
matrix or touches the binding), so it is tag-driven and desktop by default. Sizes come from the
baseline (desktop 1600×700, mobile 389×829). `@mobile` applies a full `devices[…]` preset as a `use`
override at context creation — declarative, where standalone Cucumber forced imperative
`setViewportSize` calls. As built: `src/common/config/devices.ts`; AGENTS.md, "Device profiles".

Open, for WP Rocket's port:

- Server-side mobile: WP Rocket serves different cached and beacon output by `wp_is_mobile()`.
  Whether the mobile user agent alone makes it serve mobile content is to verify. If it does not
  (caching edge cases), force it server-side with a `@mobile` Before/After hook (a
  `force-wp-mobile`-style helper); prefer the user-agent path if it holds.
- Form-factor data: steps comparing device-specific data (LCP/ATF expectations, the `is_mobile` DB
  column) read `$tags` to pick the desktop or mobile dataset.
- A rare mid-scenario resize stays available as an imperative `setViewportSize` step.

## 3. Phases

| Phase | Status | As built, or where it is planned |
| --- | --- | --- |
| 0 Guardrails | done | §1; `.env.example`, `sites.example.json`, README |
| 1 Config foundation | done | typed env, transport union, `.env` loader — configuration.md |
| 2 Execution model & isolation | done | execution-model.md |
| 3 WordPress automation layer | done | wordpress-automation.md; `docker/` |
| 4 Reporting | done | README, "Reporting"; `allurerc.mjs`, `scripts/allure.mjs` |
| 5 Visual regression | done | §2.12 |
| 6 Feature porting | in progress | phase-6 plan (supersedes this phase; BackWPup only) |
| 7 Terminal output | done | below; configuration.md (Terminal output), execution-model.md |
| 8 CI on real cells | dropped | below |
| 9 Orchestrator | moved | orchestrator plan |
| 10 Cleanup & validation | open | below |
| 11 Shared SSH server profiles | next (open) | below |
| 12 Run as the site | done 2026-11-17 | [phase-12 plan](phase-12-site-identity-plan.md) |
| WP Rocket port | after Phase 10 | phase-6 plan, "After Phase 10 — WP Rocket" |

Phase 10 states no dependencies, effort or parallelism; Phase 11 states its own below.

Phase 6: the install-hook obligations this plan set (consume `pluginArtifact`, stage the zip for
`ssh`/`docker`, clean the staging area in worker teardown) are done (6A; `releaseBoundSite`).
Retries: 2 everywhere, local runs included, `E2E_RETRIES` overriding
(`src/common/config/project.ts`); whether that is final stays the phase-6 plan's to judge. Still
open: a review checklist confirming no 1:1 carry-over from the baseline (WP Rocket's port included).

### Phase 7 — Terminal output (done 2026-11-01)

The suite and the orchestrator: a header, a live block or table, one line per scenario, a failure
block, a summary on a terminal; the same information as plain, stable lines when piped, under `CI`,
`NO_COLOR`, `TERM=dumb`, narrow or non-UTF-8; nothing styled in a log, a report or `results.jsonl`.
As built: [execution-model.md](../architecture/execution-model.md) ("Watching a run"),
[configuration.md → Terminal output](../guides/configuration.md#terminal-output) (modes, precedence,
the per-program compatibility table), the [orchestrator guide](../guides/orchestrator.md). Slices:
7.1a capabilities and palette, 7.1b layout, 7.1c live region and stream helpers, 7.2a the suite's
terminal reporter, 7.2b its live block, 7.2c failure blocks and summary, 7.3a the orchestrator's
status model, 7.3b its screen and table, 7.4a every other printer, 7.4b the compatibility matrix.
The full plan (7V1–7V91 table, per-slice specs) is at b88ed9a; the ids below are kept from it.

Decisions:

- One renderer (`src/common/terminal/`), side-effect-free at import, every capability a parameter;
  the orchestrator admits its modules one at a time (`suite-imports.json`).
- Style is a sink, never data: strings are built plain, cut, then styled. External text goes `plain`
  → masking → cut, format characters dropped before masking (one inside a token defeated the mask).
  Raw worker lines are masked whole before any cut: `FORCE_COLOR` escapes inflate a line, and a cut
  before masking printed a token's head.
- `styleText` emits, never decides: `detectCapabilities` owns the precedence and the palette calls
  `styleText(…, { validateStream: false })` (7V1–7V3), so a TTY under `CI` keeps colour. Every
  status has a symbol and a word; the word drops only on a coloured TTY, never for flaky, so no
  status is colour-only. Named ANSI colours, bold and dim only.
- Width per grapheme = max(`string-width` of the cluster, Σ of its code points), a regional
  indicator 1, ambiguous narrow (user decision 2026-10-27): never below what tmux draws (7V19–7V21).
  Live rows are cut; permanent lines never, but for a 500-code-point cap; commands, paths and a
  rule's title never.
- A C/POSIX locale changes only the symbols, never colour or live (user decision).
- Live region: `\r\n` inside it (7V27); one repaint per print burst (7V26); resize erases from the
  old block's top row, never `\x1b[J` from the top-left (7V22, 7V24); the TTY made non-blocking with
  a no-op `error` listener (7V28); a failed write turns it off for good, never thrown. One writer per
  stream; while a block or table shows, the process's own stdout/stderr writes are captured and
  printed above it (a foreign write had moved the cursor and left table rows for good), restored on
  close and on every stop path but SIGKILL (user decision). SIGTERM/SIGHUP clear the block and are
  re-sent only when no other listener is left (7V51). A crash clears the table first, from
  `uncaughtExceptionMonitor` (runs before Node prints the error, changes neither handling nor exit
  code) and `exit`.
- The failure block never prints a `result.steps` title or `params` (7V6); its `--grep` follows
  Playwright's grep title shape, anchored (7V57), hostile characters as `\uXXXX` (7V58); its pin is
  the documented form (7V65).
- `--list`, `--ui`, `PW_TEST_REPORTER`: the reporter is quiet and `printsToStdio()` false, so
  Playwright adds its own (7V30, 7V31, 7V35); watch mode prints.
- Thrown reports are plain Unicode (`TEXT_PALETTE`): a report is UTF-8 whatever the terminal. A
  test worker's printed lines are never coloured (`workerPalette`: workers run under
  `FORCE_COLOR=1`). Scripts print stdout and stderr through their own palettes; their rules stay 72
  columns (a log reads the same from any terminal). Structural glyphs go through `symbol()`; check
  details, hints and error text are data and keep their characters (`Settings → General` is
  WordPress's breadcrumb).
- Under `plain` the summary's own glyphs are ASCII; the plugin and site phrases it shares with the
  run facts keep their `·`/`—`.
- The orchestrator reads no `E2E_*`, never colours a pipe (`forceColorWithoutTty: false`) and keeps
  its piped bytes, Unicode glyphs included (verified byte-identical against the pre-7.3 CLI in 5
  modes). On a TTY: a line wider than the terminal wraps at its spaces under the message, a word
  never broken (paths and commands stay copyable); an empty line before a run's outcome and each
  escalation line; task colours `Palette.series`. `--dry-run`, `--help` and refusals stay unstyled
  (exact text pinned, printed before the start's work). The screen exists only for a TTY.
- Left unmigrated on purpose (7V85): `orchestrator/tasks/run-lines.ts` and `notify/subscribe.ts`
  glyphs (the orchestrator keeps its bytes); Slack and Datator text; `results.ts`' ` › ` path (data);
  `__fixtures__` emitting SGR (they test stripping); `run-summary.ts`' `describePlugin`/
  `describeSite` (also the report titles). `capture-backwpup-fixtures.ts` is migrated but only
  type-checked (needs a real Pro site).
- Not fixed, by decision: an invalid `E2E_OUTPUT` in healthcheck/warm exits 1 with a stack trace, as
  every bad env value does there; the message names the variable and allowed values (7V89). Keys
  typed mid-run (tty echo) leave a header line: documented (`clear`/`reset`), echo not disabled —
  changing the tty's mode is riskier, and a SIGKILL would leave it off (7V76).

Measured facts (2026-10-23 to 11-19; Node 24.21–26.13, Playwright 1.63, macOS unless said):

- Node `styleText`:
  - 7V1 — on a pty: plain under non-empty `NO_COLOR`, any `CI` (even empty/`false`/`0`), non-empty
    `NODE_DISABLE_COLORS`, `TERM=dumb`, unset `TERM`, `FORCE_COLOR=0`; a `FORCE_COLOR` Node reads as
    on beats them all (warning if `NO_COLOR` is set); `NO_COLOR=""` does not disable.
  - 7V2 — a plain `{isTTY:true}` object is rejected (`ERR_INVALID_ARG_TYPE`); a `Writable` with
    `isTTY: true` reads only `FORCE_COLOR`, so it colours where a pty does not: test with `script`.
  - 7V3 — `validateStream: false` bypasses every env check and emits SGR.
  - 7V15 — `FORCE_COLOR` `yes`, `FALSE`, `False` → no colour; `2`, `3`, empty → colour. Our
    precedence reads `yes` as on, `FALSE` as off.
  - 7V17 — the "NO_COLOR is ignored due to FORCE_COLOR" warning fires once whenever anything loads
    Node's colour helpers (the ESM or tsx loader already does): unavoidable.
- Locales (7V16): Ubuntu 24.04 gives `en_US`, `c`, `UTF-8`, `c.utf8` (and every uninstalled locale)
  charmap `ANSI_X3.4-1968`; macOS reports none for `en_US`/`de_DE` and `UTF-8` for
  `LC_CTYPE=UTF-8`. Hence by name: codeset-less is ASCII except bare `UTF-8`.
- Playwright runner (`playwright/lib/runner/index.js`, `cli/testActions.js`, `lib/util.js`):
  - 7V4 — workers start with `FORCE_COLOR=1`; `list` strips ANSI only because it owns the screen.
  - 7V5 — `BaseReporter.onStdOut/onStdErr` only store worker output; `ListReporter` prints it, so a
    replacement must print both or lose `[artifacts]`, `[site]`, `[auth]` and warnings.
  - 7V6 — raw `TestStep` titles and `params` can hold typed values (`Fill "…"`); a BDD step's
    `location` is the generated spec, not the `.feature` line.
  - 7V7 — a run's stdout and stderr are its `run.log` fd (`orchestrator/runs/launch.ts`), so only the
    reporter can strip or mask them.
  - 7V13, 7V30 — `--ui` runs the config reporters in the CLI process with `process.stdout.write`/
    `stderr.write` replaced by an own property (`_setInterceptStdio`): a live region stays inert.
  - 7V31 — no `--watch` flag: watch mode is `PWTEST_WATCH`, config reporters on, stdio not
    intercepted. `PW_TEST_REPORTER` and `--add-reporter` both append to the stack; only the first is
    detectable. `ListReporter.onError` was the only printer of errors outside tests.
  - 7V35 — `line` (`dot` under `CI`) is added only when no reporter `printsToStdio()`; `--quiet`
    made `list` drop worker output only.
  - 7V33 — a global timeout calls `onEnd` before the running tests' `onTestEnd`.
  - 7V51 — the runner has no SIGTERM/SIGHUP listener (its worker's are no-ops); signal-exit (execa)
    re-raises only when it is the last listener. Without the re-send, the block stayed and the exit
    status was written over its last row.
  - 7V57, 7V62 — `--grep` (`forceRegExp`): `/…/flags` is that pattern, anything else `gi`; `.`
    crosses no line terminator. It is matched against `_grepTitleWithTags()`: `""`, the project, the
    file and each describe each followed by its tags, the title, its tags, space-joined. Anchoring the
    end alone still selects `Untagged <title>`; anchoring the file and each title selects one
    scenario. The generated path is per cell (`.features-gen/<product>/<cell>/`). Dependency projects
    are built from unfiltered suites, so a `--grep` rerun still runs the setups. Failure attachments
    are named `screenshot`, `trace`, `video`.
  - 7V63 — a step a crashed worker never ended stays at `duration: -1`.
  - 7V60 — a test's output folder is named from a cut title: a ZWJ emoji cut mid-pair, written by
    Node as U+FFFD on disk.
- Shells:
  - 7V58 (decision) — a title's controls, format characters, line separators, lone surrogates and
    combining marks past the eighth go into the `--grep` as `\uXXXX` regex escapes (per UTF-16 unit,
    no `u` flag). Rejected: ANSI-C `$'…'` (not POSIX `sh`), refusing (a ZWJ emoji, common, would lose
    its command). A zip path or ref with such a character cannot be escaped: refused. `sh`, `bash`,
    `zsh`, `dash` read every word back byte-identical for 14 hostile titles.
  - 7V65 — zsh reads `X=/builds/v1:=ls.zip` as `ls.zip not found` and `X==ls` as `/bin/ls` (sh, bash,
    dash literal): `=` is not shell-safe. APVM gets `E2E_PLUGIN_REF` unparsed (`request.ts` tests
    only `release:`), so a bare SHA relies on APVM's guess: the rerun pins `release:<tag>`, else
    `commit:<sha>` + `E2E_PLUGIN_VERSION`.
- pty tooling:
  - 7V9 — BSD and util-linux `script` (2.39.3) give a pty 0×0 when their stdin is not a terminal;
    `stty cols/rows` inside fixes it; `script -qec` is util-linux only.
  - 7V14 — util-linux `script` exits 0 when SIGTERMed (BSD: 143), so a spawn `timeout` passes a
    killed probe as finished: the pty spec times probes itself, then SIGKILL.
  - 7V29 — macOS: a process's first use of `process.stderr` reopens its tty by name (`uv_tty_init`),
    which blocks once the pty's master is gone: the tmux driver's give-up path uses `writeSync` on
    fd 2.
  - 7V23 — GitHub's `ubuntu-24.04` image (20261023.334.3) has no tmux; Ubuntu 24.04's apt gives 3.4,
    on which the terminal specs pass under `CI=true`. CI installs it in both unit shards
    (`DPkg::Lock::Timeout=60`, one retry, `--no-install-recommends`); `script` is on the image.
- Width:
  - 7V19 — `string-width` 9.0.0: `ambiguousIsNarrow` default `true`; a cluster counts its first
    visible code point (plus spacing marks); RGI emoji, ZWJ sequences, keycap+VS16 2; keycap without
    VS16 1; a lone regional indicator 2 (we count 1); tab 0; lone surrogate 1 (read as U+FFFD).
    Node's `stripVTControlCharacters` leaves DCS/APC/PM/SOS and C1 OSC bodies (their `ESC`/C1 become
    spaces): payload text may show, no control passes.
  - 7V20 — tmux 3.8 draws every palette symbol 1 column; Thai KO KAI+SARA AM ×4 8, Devanagari KSSA ×3
    6, `a` + 5 / 30 skin-tone modifiers 11 / 61, 3 regional indicators 3, keycap+VS16 2, CJK 2.
    `string-width` alone gives 4, 3, 1 for the first three: a live row would wrap, hence the sum.
  - 7V21 — tmux draws less than the measure (pads short, never wraps): ZWJ family 2 vs 6, rainbow
    flag 2 vs 3, emoji+modifier 2 vs 4, Hangul L+V 2 vs 3, Devanagari consonant+spacing mark 1 vs 2,
    a Burmese syllable 1 vs 4.
- Live region:
  - 7V22 — tmux on resize: wider, rows stay whole and the cursor leaves column 0; narrower, rows
    split and the cursor goes to the last part; shorter, blank rows go first, then the top into
    history, out of cursor-up's reach. `\x1b[J` with the cursor top-left is tmux's `scroll-on-clear`
    (default on, 3.4 and 3.8): the screen, old block included, scrolls into history. `\n` + redraw
    left the whole old block. xterm.js 5.5 has neither case.
  - 7V24 — erase `up N-1, \r\x1b[2K, save, down 1, \x1b[J, restore` leaves bounded residue (12-row
    block: narrow 80→60 6 lines; 80×24→60×10 7; height-only 24→10 2; 40×12→40×4 7; widening with
    CJK rows 6 of 12 on tmux 3.8, which reflows them above the cursor),
    no permanent line lost in 180 cases per terminal. Erasing more would erase permanent lines on a
    terminal that truncates instead of reflowing: the rest is accepted.
  - 7V26 — 1,000 lines under a 10×120 block: a repaint per print writes 28.7× the bytes; one per
    burst 1.03×; a print every 2 ms 2.44× (repaints capped at 20/s).
  - 7V27 — `\n` returns to column 0 on a cooked pty and under `setRawMode(true)` (libuv keeps
    `ONLCR`), not after `stty -onlcr`: hence `\r\n` in the region; passthrough keeps `\n`.
  - 7V28 — a closed pipe without an `error` listener kills the process (`EPIPE`); a pty nobody reads
    behind 4 MB blocks the event loop (a 100 ms timer never fired in 8 s; non-blocking: ~0.3 s).
  - 7V92 — a draw written at the old width between the pane's resize and Node's `SIGWINCH` handler
    is reflowed too, leaving a second block's parts: inherent (Node's sizes update only in that
    handler). Specs resize only while the block is quiet; never raise a residue bound.

Limits, accepted and documented: SIGKILL leaves a block or table (`clear`/`reset`); keys typed
mid-run echo below the table; a narrowed block leaves bounded parts of the old one (7V24, 7V76), a
draw racing the resize signal its own too (7V92); a partial line held at close is written raw,
permanent lines queue unbounded while a terminal is paused (Ctrl-S) and the run lingers until resumed
(Playwright awaits its final writes; 7V54 at b88ed9a); Node's `NO_COLOR`-ignored warning (7V17);
`--add-reporter` with a printing reporter doubles every line, an added `list` prints errors unmasked;
a foreign coloured write keeps its SGR (Playwright's HTML-report hint is cyan under `NO_COLOR`, 7V46
at b88ed9a); `maskSiteUrl`/`siteLabel` mask userinfo and `;` parameters, but a credential written
plainly into a URL's path shows unless its shape is known (7V52 at b88ed9a).

Tests: pty specs (`terminal.pty.spec.ts`, `compat.pty.spec.ts`, `stream.spec.ts` through
`__fixtures__/paused-pty.ts`) run through `script` (`__fixtures__/pty.ts`: `script -q /dev/null` on
macOS, `script -qec` on Linux, `stty` sizes it); tmux specs (`live.tmux.spec.ts`,
`live-block.run.spec.ts`, `table.tmux.spec.ts`) under `/tmp/e2e-*` sockets. Each skips locally
without its tool and fails under `CI`.

Out: the dashboard's UI, a web progress view, log colouring, CI annotations, interactive prompts,
animations in CI, changing `results.jsonl` or events. Deferred: Phase 10.

### Phases 8 and 9

Phase 8 — CI on real cells (dropped): real-cell runs, PRs included, belong to the orchestrator; CI
keeps its quality, unit and `@noauth` smoke jobs (`.github/workflows/ci.yml`).

Phase 9 — Orchestrator (moved to the orchestrator plan, with report pruning, the pre-warm call and
the Free/Pro single build).

### Phase 10 — Cleanup & validation (open)

- A `deps:check` script (e.g. `depcheck`) catching unused dependencies.
- No dependency on §5's drop list reappears.
- `lint`, `typecheck` and `format:check` green; the reports generate.
- No mention of plan phases in code comments (AGENTS.md forbids citing plans in code; none found
  2026-11-19 — re-check).
- Deferred: `orchestrator/cli.spec.ts`'s child-process tests are flaky under load: "npm run
  orchestrator -- start --dry-run is the dry run…" timed out once at 30 s on CI run 40700750051
  (2026-10-28, shard 2/2), passing in 1.3 s on rerun; "an unknown --task… is refused before anything
  is taken" timed out once under the full local suite (2026-11-01, 7V50 at b88ed9a), passing alone.
  Investigate them all (npm/Node start-up under load, a missing timeout on the child, or a hang) and
  fix.
- Deferred (7.2c audit): `Step … running when the attempt ended` names the body's last step begun
  when no step carries the error; a body that throws outside any step *after* one ended (no setup
  does today: the auth setup has no step, the artifacts setup's only one is `test.attach`) would
  name that ended step. Tell it by the attempt's status (`timedOut`) or the step's `duration`, then
  drop the claim. Also unconfirmed: a terminal's copy may turn U+00A0, Hangul fillers, unassigned or
  private-use characters into others, so a pasted `--grep` would select nothing; measure on macOS
  Terminal, iTerm2 and tmux, and escape them like format characters if so.
  `failure-block.run.spec.ts` and `results-stream.run.spec.ts` time out under heavy load (12 `yes`
  on 12 cores: 90 s child timeouts), and so do ≥ 5 `compat.pty.spec.ts` cases (`script timed out
  after 25s`; one worker passes) — the same family as the `cli.spec.ts` flakes above.
- Deferred (7.2c): a failure's rerun command pins only the plugin under test (`E2E_PLUGIN_REF`/
  `E2E_PLUGIN_ZIP`); a product with a `previous` role (WP Rocket) reruns against that role's default,
  which a moving `release:latest-stable` may change. Pin `E2E_PREVIOUS_REF` (`release:<tag>`, or
  `commit:<sha>` with `E2E_PREVIOUS_VERSION`) or the zip from the artifacts setup's `previous` record
  the same way (`pluginPin`), once comparison tests exist.
- Deferred (7.3b): the table is cleared before `bus.settle()` by the loops' own `stopStatus` and again
  before `exiting`; no spec tells the first from the second — add one with a bus whose settle waits,
  if that order ever matters. `table.tmux.spec.ts` covers one and three Ctrl-Cs, not two alone: a
  runner that ignores SIGINT waits for the 4-minute interrupt budget; add it once the fake start
  takes a shorter budget.
- Deferred (7.4a): `capture-backwpup-fixtures.ts`' migrated output is unverified live (needs a Pro
  site): check it on the next fixture capture.
- Deferred (7V92): `live-block.run.spec.ts`'s "narrowed mid-run, 60×14 to 40×10" can meet the same
  race as `live.tmux.spec.ts` did — a redraw (~2/s) written at the old size after the pane changed,
  before `SIGWINCH` is handled, leaving a second block's parts past its bound of 3. Not reproduced
  (0/10 on macOS under 12 busy loops). If it appears, resize only while the block is quiet (the whole
  block on the pane, nothing pending), as `live.tmux.spec.ts` does; never raise the bound.
- Deferred (manual, not automatable): resize has been measured only in tmux 3.8/3.4 and xterm.js
  (7V24, 7V92). Resize iTerm2 and macOS Terminal.app windows (narrower, wider, height only) while a
  suite run shows its live block and while the orchestrator shows its table: every permanent line
  must stay intact, leaving only the bounded residue in Phase 7's Limits. Record it as a 7V row; a
  terminal that reflows differently is measured and decided there.

### Phase 11 — Shared SSH server profiles (open)

After Phase 12; configuration and transport; depends on nothing (independent of Phase 6 and Phase
10); before 6H. Stack: existing TypeScript on Node 26, `node-ssh` as already used, the repo's
Playwright unit runner, `node:fs`/`node:path`; no new dependency.

- Goal: stop repeating what belongs to the server. A site's `transport` still says `"mode": "ssh"`,
  and `rootDir` stays required on every site, but `host`, `username`, `privateKeyPath` and `port`
  may come from a named profile, the `default` profile, or environment variables. A field the site
  declares wins. Existing sites files that declare everything keep loading unchanged.
- Today: every SSH site repeats `host`, `username` and `privateKeyPath`, and
  [`sites.ts`](../../src/common/config/sites.ts) requires all three. `port` is already per site
  (`transport.port`, ssh only, 1–65535; a declared 22 is dropped at load, so absent and 22 key one
  connection; in the connection and install keys only when declared; messages and pre-flight hints
  name `user@host:port`). `rootDir` is the only transport path a site must give. `loadSites` is
  shared by manual runs, the healthcheck and the orchestrator, so a file-based default reaches all
  three; the orchestrator sets `E2E_LOAD_DOTENV=false`, so `.env` alone cannot reach its runs.
- Shared file: `src/projects/<product>/config/ssh.servers.json`, a sibling of the sites files,
  git-ignored; `ssh.servers.example.json` is committed. It is optional. One file per product keeps
  D2's isolation and needs no new path resolution; `findSitesFiles` never reads it (it is not a
  `sites.*.json` name). A repo-wide file can later layer over it without changing the site schema.
- Shape:

  ```jsonc
  // src/projects/<product>/config/ssh.servers.json
  {
    "default": {
      "host": "203.0.113.10",
      "username": "ubuntu",
      "privateKeyPath": "/home/runner/.ssh/id_ed25519"
    },
    "apache": { "host": "203.0.113.20" }
  }
  ```

  ```jsonc
  // a site in sites.json — profile omitted means "default"
  { "mode": "ssh", "profile": "apache", "rootDir": "/var/www/html/site" }
  ```

  `default` is reserved and optional. Every profile resolves field by field over `default`, so
  `apache` above supplies only its host; a profile may also be complete. Unknown keys, wrong types,
  empty strings, ports outside 1–65535, arrays/null and bad profile names are load errors naming
  the file and path, never quoting a value. A profile cannot carry `rootDir`, `stagingDir`,
  `elevate`, `fileOwner`, `runAs` or `umask` (the last two: a site's identity, Phase 12), nor
  `wpUser` (resolved from the site's `username`).
- Site selector: `transport.profile` is an optional safe single token
  (`[a-z][a-z0-9_-]{0,31}`, 1–32 characters); omitted selects `default` when present. A named
  profile that is not defined is a hard error, never a silent fallback to `default`. Site fields
  win over the profile, so a one-off host or key stays possible. Add `profile` to `sites.ts`'s
  per-mode transport allow-list (unknown keys are refused).
- Precedence, field by field: site value → selected profile, merged over `default` → `default` →
  env → error (`port` falls back to 22). Blank env is unset; a malformed env value is an error only
  when that field is needed. A blank site field is refused, never treated as absent.
- Env fallback: `E2E_SSH_HOST`, `E2E_SSH_USERNAME`, `E2E_SSH_PRIVATE_KEY_PATH`, `E2E_SSH_PORT`.
  Add all four to the orchestrator's `INHERITED_VARIABLES`, so a run gets them when the operator
  uses env instead of the file; nothing else about the run contract changes.
- Required per site: `mode` (`"ssh"`; never inferred) and `rootDir`; `baseURL` and the WordPress
  login stay per site too. `stagingDir`, `elevate` and `fileOwner` stay per-site (staging keeps its
  existing `E2E_SITE_STAGING_DIR` fallback): they are policy/ownership, not connection details.
- Port: a profile's or `E2E_SSH_PORT`'s port resolves to the same `SshTransport.port` the site field
  sets today, normalised the same way (22 → absent), so existing connection keys never change.
  Out: passphrases and encrypted keys, `ssh-agent`, `ProxyJump`/`ProxyCommand`, `~/.ssh/config`
  discovery, key contents, and any non-SSH transport change.
- Security: the file holds endpoint metadata and a key *path*, never key material; it is
  git-ignored and documented `chmod 600`. No error, warning or log quotes a sites value, a profile
  value or an env value — messages name the file, the site path, the field and the env var. The
  existing secret masking is untouched.
- Orchestrator: no config schema change. It already loads cells through `loadSites`, so resolved
  hosts feed the crowded-server warning and the site locks unchanged; every process of a run
  resolves the same file. Only the environment allowlist changes.
- Implementation:
  - `src/common/config/ssh-servers.ts`: types, `loadSshServers` (missing = empty, malformed = hard
    error), `resolveSshEndpoint` (pure: site transport, profiles, env → resolved fields), and
    validation.
  - `sites.ts`: reads `join(configDir, "ssh.servers.json")` once per load and passes it plus the env
    source into the ssh branch; keep the `[sites]` error style and the no-values rule. Move the
    shared `describeValue`/string/number/port helpers to a small module if needed to avoid a
    `sites.ts` ↔ `ssh-servers.ts` cycle; re-export `describeValue` from `sites.ts` for its specs.
  - `types.ts`: `profile` is config-only and dropped after resolution.
  - `orchestrator/runs/environment.ts`: the four env names in `INHERITED_VARIABLES`.
- Tests:
  - `ssh-servers.spec.ts`: missing/empty/malformed file; default; inheritance; complete profile;
    unknown profile; unknown key; wrong types; blank strings; port bounds; profile-name bounds; no
    quoted values; precedence for every field; env fallback, blank and malformed env; site
    override; `rootDir`/`stagingDir`/`elevate`/`fileOwner`/`runAs`/`umask`/`wpUser` refused in a
    profile.
  - `sites.spec.ts`: `{ mode, rootDir }` resolves; full transports unchanged; `profile` dropped; a
    missing field names the site and env var; a sibling `ssh.servers.json` in the temp config dir is
    read; overlays and the example fallback unaffected.
  - `exec.ssh.spec.ts`: a profile's port reaches node-ssh and keys its own connection (a site's port
    already does).
  - `orchestrator/runs/environment.spec.ts`: the four vars pass when set; other vars still do not.
  - Live: a cell configured with only `mode` + `rootDir` (profile `default`) passes
    `npm run healthcheck` and one `@noauth`/`@smoke` run; the orchestrator's once path passes the
    same resolved transport.
- Docs: [configuration.md](../guides/configuration.md) (new "SSH server profiles" section,
  precedence table, env fallback, `rootDir` stays per site),
  [wordpress-automation.md](../architecture/wordpress-automation.md) (connection cache),
  `.env.example`, `ssh.servers.example.json`, README's sites-files paragraph, AGENTS.md's
  configuration mechanism, the [orchestrator guide](../guides/orchestrator.md) (profiles on the
  runner; `.env` still not reaching runs). Keep `sites.example.json` self-contained (full
  transports) so a fresh checkout loads without a global file; document profile-only sites in
  configuration.md. Code never cites a plan phase.
- Definition of done: a site with only `mode` + `rootDir` passes the healthcheck and a real run; an
  existing full transport behaves identically (same endpoint and port); a missing field fails at
  load naming the fix; an orchestrator run gets env-only profiles; all gates and docs are green.
- Sub-phases:

  | #    | Delivers                                                                                                         | Depends     | Parallel | Effort     | Done when                                                                                                                                                                  |
  | ---- | ---------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 11.1 | `ssh-servers.ts`, sibling file, optional `host`/`username`/`privateKeyPath`, `profile` selector; no port yet.   | —           | —        | S/M, 1–2 d | A `{ mode, rootDir }` site resolves from `default`; every precedence and error case is a unit test; existing full transports load identically.                              |
  | 11.2 | `port` in profiles (the per-site field exists): resolved through the precedence, 22 normalised to absent.       | 11.1        | —        | S, 0.5 d   | Profile `port: 2222` reaches node-ssh and keys its own connection; a profile's 22 keys as a site without a port.                                                            |
  | 11.3 | Env fallback (`E2E_SSH_*`) and orchestrator allowlist.                                                          | 11.1, 11.2  | —        | S, 0.5 d   | Without a file, env-only resolves; a run started by the orchestrator receives the four vars when set; blank/malformed cases covered.                                        |
  | 11.4 | Docs, examples, live check, full gates.                                                                         | 11.1–11.3   | —        | S, 0.5–1 d | The live cell passes; docs and examples describe the shipped behaviour; typecheck, lint, format and unit tests green.                                                       |

- Out: a repo-wide profile file, profiles for `local`/`docker`, global
  `rootDir`/`stagingDir`/`elevate`/`fileOwner`, passphrases/agents/jump hosts, auto-importing
  `~/.ssh/config`, and changing the orchestrator config schema.
- Effort: 2–4 engineer-days, low/medium difficulty.

## 4. Feature-parity matrix

Baseline capability → target design → status. WP Rocket's port starts from the pending rows.

1. WP-CLI exec (local/Docker/SSH) → `wp/exec.ts`, `exitCode` on every mode. Built.
2. Server/env config → typed env accessors, the transport union, per-product config and sites files
   (§2.5). Built, except the `services` ← `overrides` merge (open, §2.5).
3. Plugin/theme lifecycle → WP-CLI wrappers and UI page objects; idempotent cleanup, asserted
   removal under test, distinct errors (§2.10). Plugins built; themes not.
4. DB ops → `wp db query` through exec. `dbQuery` built; the baseline's `seedData`/`checkData` come
   with WP Rocket.
5. Visual regression → the A/B check (§2.12). Built; scenarios come with WP Rocket.
6. Settings export/import diff → `expect` deep-equality; `microdiff` if a diff object is needed.
   Pending (WP Rocket).
7. Auth (login/logout) → per-site `storageState`, per-cell setup project, `@noauth` (§2.7). Built;
   multi-user pending.
8. POM (sections/selectors) → plain POM fixtures, thin steps, edition-divergent pages (§2.11). Built.
9. Lifecycle hooks → playwright-bdd `Before`/`After`/`BeforeAll`/`AfterAll` with `{ tags }`. Built.
10. Health check / open report / archiving → `npm run healthcheck`, `npm run report`; archiving → a
    CI artifact upload or a small `fs` script. Health check and opener built; archiving not assessed
    against the baseline (the orchestrator packs each run's reports: [report delivery
    plan](orchestrator-report-delivery-plan.md)).
11. `debug.log` scan → tag-scoped hooks, the log attached on failure. Built (`@plugin`).
12. Local WP env → `docker` = Apache + Nginx; `local` = any server; `@wordpress/env` optional
    (§2.9). Built.
13. Execution / parallelism (new) → (product × cell) run units, site pools, per-cell reports (§2.1).
    Built; the orchestrator runs cells in loops (its plan).
14. Plugin editions (new) → one product, per-cell edition (§2.6). Built.
15. Credential safety (new) → pools through an in-process registry (§2.2). Built.
16. Plugin zip selection (new; the baseline's `new_release` / `previous_stable` zips in
    `utils/plugin-builder.ts`) → per-run `plugin`/`previous` roles built from any git ref through
    APVM or provided, identity-verified, staged onto `ssh`/`docker` sites (§7). Built.

## 5. Dependency disposition

The baseline declares `axios`, `boxen`, `node-zip`, direct `ssh2` and
`multiple-cucumber-html-reporter` but never imports them. Its "beautiful report" is the stock
Cucumber HTML formatter: media-rich on failure but static (no trace viewer, no trends).

- Drop, never carry over (Phase 10 checks it): `axios`, `@types/axios` (deprecated stub), `boxen`,
  `node-zip`, direct `ssh2` (it stays node-ssh's transitive dependency; `@types/ssh2` came back as
  node-ssh 14's optional peer, for its types), `multiple-cucumber-html-reporter`, `@types/cucumber`
  (deprecated stub), `eslint-plugin-es5`, and the duplicate `playwright` (redundant with
  `@playwright/test`). Proven unused by repo-wide inspection.
- Replace:
  - `backstopjs` (+ types, `backstop.json`) → the A/B check over pixelmatch + pngjs (§2.12).
  - `shelljs` (+ types) → execa: promise-based, array args (no injection), structured errors, ESM.
  - `chalk` → `node:util` `styleText`: no dependency; no escapes off a TTY, honours `NO_COLOR`.
  - `ts-node` → `tsx` for the root scripts, the runner's own transpile for tests.
  - `json-diff` (+ types) → `expect` deep-equality; `microdiff` if a diff object is needed.
  - `dotenv` → `node:util` `parseEnv`, the parser of `process.loadEnvFile()` (`config/dotenv.ts`).
- Added: `string-width` (9.0.0; ESM, Node ≥ 22), a dev dependency like every package here (`npm ci`
  installs them for runs): width cuts need real display columns for emoji, CJK and combining marks.
  No `slice-ansi`/`wrap-ansi`: layout runs on plain text, permanent lines let the terminal wrap,
  `Intl.Segmenter` gives grapheme boundaries.
- Not needed: the standalone Cucumber runner (playwright-bdd bundles the reporter);
  `@playwright/browser-chromium` (below); a pattern-matching library (transport dispatch is a native
  discriminated `switch` with a fail-fast `default`); a validation library for the suite's own
  config (hand-rolled; zod serves only the orchestrator).
- Optional, not added: `ts-pattern`, `microdiff`, `http-server` (serving a `rich` report),
  `@wordpress/env`.
- `adm-zip` 0.6.x bundles its own types (no `@types/adm-zip`) and patches CVE-2026-39244; its
  breaking changes (`extractEntryTo`, Node 12) do not touch the read-only use. `apvm-napi`: §7.1.
- Browsers: `postinstall` runs `playwright install chromium`; the committed `.npmrc` sets
  `ignore-scripts=false` so the hook runs where scripts are disabled globally (`npm run setup`
  reruns it). Not `@playwright/browser-chromium`: the postinstall always matches the installed
  Playwright, one version fewer to keep in step. The runner uses the bundled Chromium (no
  `channel`).

## 6. Live risks

- Shared WordPress state under parallelism: each worker owns one site (§2.1) and a cell takes one
  run at a time (the orchestrator's site locks; manual runs are not covered — AGENTS.md). The
  remaining gate is provisioning isolated sites, not code.
- Lost SSH/Docker/UI nuance in WP Rocket's port: characterise each mode with a smoke test first,
  then re-implement idiomatically.
- Pixel differences across platforms: the A/B check needs no stored baseline; run `@visual` in the
  Playwright container; tune `maxDiffPixelRatio`; mask dynamic content.
- WP Rocket's "delete data" confirmation page: handle when porting (§2.10).
- Credentials in shared artifacts: reports carry none (§2.2). Retained traces, `error-context.md`
  and `test-results/` still hold session cookies and typed values — treat them as sensitive
  (AGENTS.md).

## 7. Plugin artifacts (done)

Done 2026-07-28. As built: [plugin-artifacts.md](../architecture/plugin-artifacts.md),
[configuration.md](../guides/configuration.md#plugin-artifacts-build--verify) (the six `E2E_*`
variables) and [wordpress-automation.md](../architecture/wordpress-automation.md) (staging and file
transfer). Kept here: the facts the design rests on, decisions and rejected alternatives, limits,
open obligations.

### 7.1 Verified foundations

APVM, measured at `develop` (npm `3.0.0`); pinned as
`github:wp-media/automation-plugin-version-manager#v3.3.0` (tags `vX.Y.Z` from 3.3.0, `cli/vX.Y.Z`
before; 3.3.0 re-checked in the dependency-update plan's P4):

- Install: a plain git dependency with prebuilt `.node` binaries committed for darwin-arm64/x64,
  linux-x64/arm64-gnu and win32-x64-msvc — no musl, no Rust, no postinstall; engines
  `node >=22.22.1`. Its `prepare: husky` is blocked by the repo's `allowScripts`; `.npmrc`'s
  `allow-git=root` admits the declared git dependency on npm ≥ 12.
- Token: `Apvm.createWithTokenResolution()` tries its config → `GITHUB_TOKEN` → `GH_TOKEN` → the
  `gh` CLI → gh's config. Required for `backwpup`, whose source is the private
  `wp-media/backwpup-pro` (APVM `registry.rs`); otherwise optional (rate limits).
- `build({ project, gitRef, version?, variants?, outputDir, noCache? }, onProgress?)`: `outputDir`
  absolute, created if missing. `warmCache()` runs the same pipeline without delivering; a later
  identical `build()` is a cache copy (`fromCache: true`).
- Refs: bare (`develop`, a sha, `123` = a PR) or prefixed `pr:`, `branch:`, `tag:`, `commit:`,
  `release:`; keywords `latest-stable`, `previous-stable`, `latest`, `previous-latest` for `tag:`
  and `release:`. A `release:` ref is a GitHub Releases download through plain `build()`.
- `version`: required by `backwpup` on build refs; optional for `wp-rocket` and `imagify`
  (auto-detected; when given, rewritten into the source and reported as `versionOverride`); a
  `release:*` ref takes it from the tag.
- Output: `result` (`artifacts[{ variantId?, path, filename, size, origin }]`, `version`,
  `variantsBuilt`), `resolvedRef`, `commit`, `commitShort`, `description`, `fromCache`,
  `versionOverride?`; `origin` is `cache`, `built` or `downloaded`.
- Cache: `~/.apvm/cache` by default; `APVM_CACHE_DIR`, read at each `create()`, overrides it —
  never set here. Keyed by resolved commit and version, so keyword refs re-resolve, then hit the
  cache. Its concurrency and per-variant layout: the orchestrator plan (0A.5).
- Errors are typed promise rejections (`ProjectNotFound`, `PrivateRepoNoToken`, `ReleaseNotFound`,
  `NoMatchingReleaseAssets`, …), never crashes. Progress events are a discriminated union
  (`reference_resolved`, `phase_*`, `step_*`, `command_output`, `warning`, `build_succeeded`,
  `build_failed`).
- `wp-rocket` has no downloadable GitHub Releases, so `release:*` fails for it; its `previous`
  default `tag:latest-stable` builds instead. BackWPup has release assets (`release:latest-stable`
  was v5.7.4 on 2026-07-16, with `free`, `pro-en` and `pro-de`); a release download delivers every
  variant and the variant filter selects ours.
- A cold build runs composer and npm for minutes, so the artifacts setup allows ~20 min (measured
  build times: the orchestrator plan).
- Sources: the napi README and `index.d.ts` (the API's source of truth); the builders
  `crates/core/src/build/plugins/{wpr,bwu}.rs`.

Identity (the slug, main file and `Plugin Name:` expectations are in plugin-artifacts.md) — what
produces them:

| Product / edition | APVM `project` + `variants` | Zip filename |
| --- | --- | --- |
| WP Rocket | `wp-rocket` | `wp-rocket-{version}.zip` |
| BackWPup Free | `backwpup` + `["free"]` | `backwpup-{version}-{commit8}.zip` |
| BackWPup Pro | `backwpup` + `["pro-en"]` | `backwpup-pro-en-{version}-{commit8}.zip` |
| Imagify | `imagify` | to verify when wired, with its slug, main file and header |

Our cells are English, so Pro builds `pro-en` (`pro-de` exists, untested).

Transports' file access (2026-07-16):

- Every command runs with the WordPress root as its working directory: `rootDir` (local, ssh), the
  container `WORKDIR` (docker: `/var/www/html` in `wordpress:cli-php8.3` and `wordpress:php8.3-*`;
  `dockerArgv` passes no `-w`).
- Copy primitives: an `fs` copy (local); `docker cp`, a top-level docker sub-command, not
  `docker exec` (docker); node-ssh `putFile`, which does not create parent directories (ssh). All
  ignore the exec working directory and need an absolute target; docker's root is read with `pwd`.
- Write access at the WordPress root is a host property: on the ssh cell the docroot was
  `drwxrwxrwx www-data` and `ubuntu` could create `.e2e_temp`; staged files landed `0664`, readable
  by a differently-owned `wp`. Hence an overridable staging root.

### 7.2 Decisions and rejected alternatives

- Variable names `E2E_PLUGIN_*` / `E2E_PREVIOUS_*` (`_REF`, `_ZIP`, `_VERSION`): `E2E_` scopes them
  without colliding with generic or CI-reserved names. Rejected: `E2E_CANDIDATE_*` /
  `E2E_BASELINE_*` ("baseline" already names the legacy repo); `E2E_TARGET_*` / `E2E_REFERENCE_*`
  ("target" is overloaded, `E2E_REFERENCE_REF` stutters); the baseline's `new_release` /
  `previous_stable` (the tested artifact is usually `develop`, and the comparison ref need be
  neither previous nor stable).
- Overrides on a serial (cell-less) run warn and fall back to defaults, so a stray or shared variable
  cannot abort a broad run. `E2E_PREVIOUS_*` on a product without the role warns too: cells of
  several products may share one shell or CI env.
- BackWPup's version defaults differ per role — `plugin` `9.99.99`, `previous` one patch lower,
  `9.99.98` — so an update or rollback test sees `previous` as older with nobody picking versions;
  one patch is the smallest guaranteed-older delta under semver. Pass `E2E_PREVIOUS_VERSION` to test
  a real upgrade. Only `plugin`'s default exists until the role lands (§7.4).
- Edition and APVM variant stay two words: edition is the language-blind behavioural tier that
  `@free`/`@pro` need; a variant is an exact buildable package; APVM has no edition concept.
- Static identity preflight (`adm-zip`; `yauzl` the fallback) rather than an install-based probe: no
  WordPress needed, milliseconds, cannot mutate a site, identical for built and provided zips; the
  first install proves installability minutes later anyway. Rejected: "exactly one `.zip` in the
  role dir" — one artifact per role is enforced at resolution (`pickArtifact`), and a `release:*`
  ref legitimately delivers every variant's zip into the dir.
- APVM's cache is the only reuse layer: every execution wipes and re-resolves (a cache hit is a ~15
  MB copy), and provided zips are copied in (uniform layout, immune to the source moving). Roles
  resolve sequentially. Workers never resolve: APVM per worker would race on the wipe.
- The transfer primitive lives in `exec.ts`, which owns the cached SSH connection and the per-mode
  dispatch; a standalone `transfer.ts` importing an exported connection was rejected as leakier.
- The site's `stagingDir` beats `E2E_SITE_STAGING_DIR`: the site's declaration is the specific
  statement ("this host's docroot is not writable"). Paths are absolute throughout, since the copy
  primitives ignore the exec working directory.
- The staging-root guard sits at the point of use, not in `sites.ts`: docker's root is unknown at
  load, and one authoritative check cannot drift from a second. A relative `rootDir` is refused only
  by the staging layer (`exec` accepts one as a working directory).
- `cleanSiteStaging` throws on a real failure (a dirty site should be visible); the teardown caller
  makes it best-effort. `mkdir` and `rm` are shelled out even on `local`: uniform behaviour beats a
  special case.
- A bare numeric ref (`5.6.8`) is treated as a build ref although APVM may resolve it to a release;
  the version default is then sent needlessly and ignored. Narrowing it would reimplement APVM's ref
  detection.
- `--project` is matched exactly against cell names, while Playwright's own filter ignores case and
  expands `*` (its `filterProjects`). Mirroring it would duplicate a third-party internal or let
  `--project='*'` apply one operator's override to every cell; exact matching degrades visibly
  (overrides warn and drop).
- Trap (execution-model.md, "Reading the selection from a worker"): a worker has no CLI argv. An
  argv-derived selection once silently dropped every `E2E_*` override while the warmer honoured
  them.

### 7.3 Limits

- Sites sharing one absolute staging root (the same `stagingDir` or `E2E_SITE_STAGING_DIR` on one
  host) can collide when run concurrently; within one invocation it cannot happen (one worker per
  site). Rejected: namespacing staging by `RUN_ID` — a killed run's folder would be cleaned by
  nobody, leaving zips in a web-reachable docroot. The scheduler must know which roots are shared:
  the orchestrator plan's 0A.3.
- Two processes that both miss APVM's cache both build in full (its writes stay safe); pre-warming
  exists to avoid that (the orchestrator plan's 0A.5).
- A relative `E2E_*_ZIP` resolves against the repo root, never the process working directory.
- A keyword ref (`tag:latest-stable`) re-resolves at warm and at run time, so a release cut in
  between makes the run build fresh — correct, only slower. Pinning (plugin-artifacts.md) closes it
  for the orchestrator.

### 7.4 Open obligations

- BackWPup `previous` role (MUST, when its comparison tests arrive): add
  `previous: "release:latest-stable"` and a `previous` default version (e.g. `9.99.98`, needed if
  `E2E_PREVIOUS_REF` is ever pointed at a build ref) to `backwpup.config.ts`. Declaring the role
  enables resolution and the identity preflight for the second artifact, which must not be skipped;
  the only exemption is a test that builds inside its own scenario and owns its verification. Until
  then the fixture hard-errors. Mirrored on the manifest and in AGENTS.md.
- Imagify: a manifest, and its identity row verified from its build definition, when it is wired.
  Planned defaults: `plugin` `develop`, `previous` `tag:latest-stable`, version embedded.
- Deeper zip validation (a CRC pass, a trial install) only if a real failure class appears, behind
  the same aggregated report.
- Free/Pro single build (one APVM call for both variants of one ref and version): the orchestrator
  plan.
- `.e2e_temp` is served by the web server on these cells (wordpress-automation.md); the guard is the
  phase-6 plan's 6J.

## 8. Site file ownership (done)

Done 2026-08-26; the full BackWPup suite passed on both cells with it (2026-08-28). As built:
wordpress-automation.md ("File ownership", "Path guards", "Left-over plugin data"), configuration.md
(`fileOwner`, `elevate`), AGENTS.md (the MUST),
[execution-model.md](../architecture/execution-model.md#the-auth-setup-and-the-health-check) (the
pre-flight reports), `src/common/wp/ownership.ts` (BusyBox and `id` parsing in its TSDoc). Since
Phase 12 it is the fallback for every identity state but `site` (§8.2).

The problem: on an `ssh` cell WP-CLI ran as the transport's user (`ubuntu`, umask `0002`) and PHP as
the web server (`www-data`), so what the suite installed landed `ubuntu:ubuntu 775/664` and the web
server's next write into it failed — a raw `EACCES` inside `WP_Filesystem_Direct`, not an FTP
prompt. `normalizeOwnership` hands it to the owner detected from the install.

### 8.1 The cells (measured 2026-08-26 unless dated)

`pro@nginx` is `simple.e2e.rocketlabsqa.ovh` on `qa-lnmp`; `pro@apache` is
`auto-e2e-backwpup-apache.rocketlabsqa.ovh` on `qa-auto-e2e-apache`.

| | `pro@nginx` | `pro@apache` |
| --- | --- | --- |
| Transport user | `ubuntu` (1000:1000) | `ubuntu` (1000:1000) |
| Web/PHP user | `www-data` (nginx + php-fpm) | `www-data` (apache2 + php-fpm) |
| Docroot owner | `www-data:www-data` | `sftp_backwpup:www-data` (uid 1001) |
| Docroot mode | `777` throughout | `777` throughout |
| sudo | `(ALL) NOPASSWD: ALL` | `(ALL) NOPASSWD: ALL` |
| Userland | GNU coreutils 9.4, kernel 6.8 (Ubuntu), WP 7.1 | GNU coreutils 9.4, WP 7.1 |

- `pro@apache`'s WordPress root is `<vhost dir>/public/`; the vhost directory itself holds no
  WordPress. The same host serves WP Rocket's site to the same `ubuntu@host`, owned
  `sftp_wprocket:www-data` (uid 1002) — why ownership caches are per install, not per host.
- Group membership is host state: `ubuntu` was added to `www-data` on both hosts (`usermod -aG`,
  2026-08-26; `qa-auto-e2e-apache`: `www-data:x:33:sftp_backwpup,sftp_wprocket,ubuntu`; `qa-lnmp`:
  `www-data:x:33:ubuntu`); `qa-lnmp`'s membership had to be reapplied the same day, so membership is
  measured on every run, never configured. A fresh SSH session sees a new membership at once
  (node-ssh opens new sessions).
- sudo probes (a sudoer and a non-sudoer): `sudo -n true` works (exit 0, else exit 1 with `sudo: a
  password is required`); `sudo -n -l` works but adds nothing to that; `sudo -n -v` is a false
  negative — exit 1 even for a passwordless sudoer (it validates the credential cache, tests no
  command): never use it. "Not a sudoer" and "sudoer needing a password" print the same message by
  design, so pre-flight reports one state and names both causes.
- Known probe limit: a `NOPASSWD` grant for a command list excluding `true` fails `sudo -n true`
  while permitting `chown`. The fleet grants `ALL` (`/etc/sudoers.d/`).
- MariaDB 10.11.14 on `pro@apache` (2026-08-28): an `.ibd` file with no data-dictionary entry
  (`wp_bwpup_backups.ibd`) made every `CREATE TABLE` of that name fail with errno 184 "Tablespace
  already exists", and `DROP TABLE IF EXISTS` does not remove it. `mariadbd`'s own message prescribes
  removing the file; it was moved aside (reversible), after which create and drop behaved again. An
  orphan is absent from `SHOW TABLES` and from `information_schema.INNODB_SYS_TABLES` (as root);
  moving it is safe while the server runs (no open handle) — re-check the dictionary just before
  acting.

### 8.2 Decisions and rejected alternatives

- The owner is detected with `stat` on `wp-content` (else the WordPress root), never from the
  web-server process: `ps` says `www-data` on both cells, wrong on `pro@apache`, where
  `chown www-data:www-data` would strip `sftp_backwpup`, the host's SFTP deployment account, off the
  tree.
- **Reversed by Phase 12** ([phase-12 plan](phase-12-site-identity-plan.md)): WP-CLI and every site
  command now run as the site's identity (the web server's user and group through `sudo -n -u -g`,
  never root) wherever the host allows it; `transport.runAs` `"auto"` by default, `false` opts a site
  out. Rejected at first because (a) there is no single correct user (`sftp_backwpup`'s primary gid
  and umask `0022` would create files the web server cannot write), (b) `sudo -u` sets the target's
  `HOME`, where WP-CLI keeps its cache, (c) it changes every WP-CLI call to fix file creation.
  Answered: (a) the operator chowns docroots to PHP's identity, and `"auto"` takes the owner only
  once the web probe shows PHP runs as it, else falls back, warned; (b) zip installs, `eval` and
  option calls write nothing to `HOME` (only download installs warn, and succeed); (c) accepted. Every
  state but `site` keeps this section's handover (`same-user`, `fallback`, `disabled`).
- Rejected: a `www-data:www-data` fallback when detection fails. It is wrong on `pro@apache`, a
  wrong owner applied as root is worse than none, detection cannot fail alone (pre-flight already
  asserts root access and a booting WordPress), and the real failure, missing elevation, leaves
  nothing able to apply any value. So an undetectable owner is warned about and skipped.
- The grant's scope is measured from the transport user's groups (`ug+rwX`; `o+rwX` only when it is
  neither the owner nor in the group): a membership that can silently vanish does not belong in the
  sites file. The `o+rwX` branch matches these cells' existing `777` and `DATA_DIR_MODE = "0777"`;
  it is avoidable, so it announces the fix.
- The detected owner is memoised per worker process, not persisted: pre-flight runs in the setup
  process and scenarios in workers, and a file (as `resolution.json`)
  would buy a lifecycle and a staleness window to save one `stat` per worker per site. Pre-flight
  reports the decision (`planOwnership`) without being its source of truth.
- Data-directory preparation sets the mode first, then hands the directory over — the reverse of the
  plugin's grant-then-chown — because the mode is changed while the directory is still the transport
  user's (normalising first would need privileges for a `chmod` that needs none). The hand-over is
  recursive, so it also reaches what the plugin's activation created as WP-CLI.
- `fileOwner` is absent from the `sites.example.json` files: JSON has no comments, and neither other
  optional knob (`elevate`, `stagingDir`) appears there, so showing only the rarest would read as
  something a checkout needs.
- Pre-flight reports elevation up front: a host without it degrades quietly (residue left behind,
  `debug.log` perhaps not cleared, ownership not corrected), better learnt at a run's start than
  from a full disk weeks later. One pure renderer serves pre-flight and the healthcheck, so the two
  cannot drift.

### 8.3 Known limits

- The fast path (the transport user's uid and gid equal the target's) skips the grant. A host where
  the transport user owns the docroot while the web server is another account relying on group bits
  could be judged `unnecessary` under umask `022` and stay unwritable by the web server. No cell has
  that shape, and detecting a third user is what owner detection rejects as unreliable.
- `docker` is not literally untouched: each worker runs `stat` and `id` (and `pwd` without a
  declared `rootDir`) before the fast path — reads only.

### 8.4 Open obligations

- Non-Linux targets: revisit only if a BSD/macOS `local` cell appears; `stat -c` and `id` are read
  in one function each.
- Dropping `prepareSiteDataDirs`'s `0777` floor: safe only where ownership correction is guaranteed,
  and it is best-effort by contract. Where the transport user is in the docroot's group, the grant
  alone (`ug+rwX` ⇒ `0775`) would suffice. Revisit if a cell is ever required to have working
  elevation.
- Batching the per-path commands. Measured on `pro@nginx`: preparation costs ~15 s for BackWPup's
  two original paths (about seven round-trips each) and the plugin's handover 1.8 s. With a third
  declared path and the directory the installed plugin names at runtime, the `@plugin` Before hook
  takes 44–50 s (73 s beside another run on the same server) of its 120 s `HOOK_TIMEOUT_MS`, plus
  its stop and settle allowances (`src/common/hooks/plugin-lifecycle.ts`). It is latency, not work:
  `mkdir`, `chmod`, `chmod -R` and `chown -R` take several operands, so one command per step instead
  of per path would cut it about threefold. Deferred: it changes `normalizeOwnership`'s one-path
  contract and needs its own tests. Revisit when a product declares more than a handful of data
  paths, or the Before hook nears its budget. (Residue removal is already batched.)

## 9. References

- Playwright: <https://playwright.dev/docs/test-projects> ·
  <https://playwright.dev/docs/test-parallel> · <https://playwright.dev/docs/test-reporters> ·
  <https://playwright.dev/docs/api/class-testinfo> ·
  <https://playwright.dev/docs/api/class-testproject> · <https://playwright.dev/docs/test-snapshots>
  · <https://playwright.dev/docs/auth>; microsoft/playwright#38953 (`parallelIndex` is global).
- playwright-bdd (Cucumber reporter `externalAttachments` / `skipAttachments`, `defineBddConfig`
  with `tags` and a per-cell `outputDir`, POM as fixture, hooks):
  <https://vitalets.github.io/playwright-bdd/>
- Allure 3 (`allurerc.mjs`: `singleFile`, categories, dashboard):
  <https://allurereport.org/docs/playwright/> · <https://github.com/allure-framework/allure3>
- WP-CLI plugin commands and their exit codes:
  <https://developer.wordpress.org/cli/commands/plugin/>
- Docker's `wordpress` image (Apache vs `fpm`, the FastCGI note):
  <https://hub.docker.com/_/wordpress>
- execa (array args, errors): <https://github.com/sindresorhus/execa> · node-ssh:
  <https://github.com/steelbrain/node-ssh>
- Node: <https://nodejs.org/api/typescript.html> · <https://nodejs.org/api/util.html> ·
  <https://nodejs.org/api/process.html#processloadenvfilepath>
- APVM: <https://github.com/wp-media/automation-plugin-version-manager> — its napi README and
  `index.d.ts` (the API's source of truth); builders in `crates/core/src/build/plugins/`.
- Identity ground truth: `wp-media/backwpup-pro` `gulpfile.ts` (`compressPackage`, the `free`/`pro`
  tasks); `wp-media/wp-rocket` `wp-rocket.php`.
