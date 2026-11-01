# E2E Modernization Plan — `wp-rocket-e2e` → `wp-media-e2e`

- Status: Phases 0–5 done. **Next: Phase 7 — terminal output** (decided 2026-10-22), then **Phase 11
  — shared SSH server profiles** (open; scheduled after 7). The rest of Phase 6 (6H–6K) follows in
  the [phase-6 plan](phase-6-feature-porting-plan.md). Phase 10 open. Phase 8 dropped. Phase 9 moved
  to the [orchestrator plan](orchestrator-plan.md). WP Rocket's port starts after Phase 10.
- Merged in, both done: plugin artifacts (§7) and site file ownership (§8), formerly plans of their
  own.
- Baseline (reference only): `wp-rocket-e2e`, the legacy suite being superseded. Target: this repo.
- Scope: decisions, their reasons, verified external facts, limits and open work. The as-built
  description is in `docs/architecture/` (execution-model, plugin-artifacts, wordpress-automation),
  `docs/guides/` (configuration, authoring-tests), README and AGENTS.md.

## TL;DR

- The suite runs Gherkin through the Playwright runner (`playwright-bdd`, not the Cucumber CLI) on
  ESM, Node 24 and strict TypeScript. Goal: match or beat the baseline in capabilities, reporting,
  maintainability and security, and add multi-product, multi-environment parallel runs.
- Porting means modernise, never copy 1:1: every capability is re-implemented with current
  Playwright idioms (web-first assertions, auto-waiting locators, fixtures, `storageState`), strict
  types and explicit errors. Coverage never regresses.
- Run model: a (product × cell) matrix. One Playwright invocation per run unit with `workers` = the
  cell's pool size, because `parallelIndex` is global per invocation (§2.1). One report per run
  unit, never merged. Products are separate; cells are data; credentials never enter report-bound
  metadata.
- The plugin zips under test are resolved, built through APVM and identity-verified per run (§7);
  files the suite installs on a site are handed back to the site's own owner (§8).
- Next: Phase 7 — terminal output for the suite and the orchestrator (below), then Phase 11 — shared
  SSH server profiles: a site may omit `host`, `username`, `privateKeyPath` and `port`, while
  `rootDir` stays per site. Phase 6 resumes at 6H after both; Phase 10 (dependency check, cleanup)
  and WP Rocket's port (parity matrix, §4) follow.

## 1. Core decisions

- D1 — Execution is a (product × cell) matrix with a site pool per cell: one Playwright invocation
  per run unit, `workers` = pool size. Reason: §2.1. Parallelism shipped in v1, not deferred.
- D2 — Products are fully separated: own BDD config, directories, sites file and reports; only
  `src/common/` is shared. No config bleed: BackWPup's storage config is invisible to WP Rocket.
- D3 — Cells are data (the top-level keys of a product's sites files), not an enum. `ssh`/`local`
  take any number; `docker` ships Apache + Nginx with a fixed PHP. Code iterates the keys.
- D4 — Each run unit produces its own report; no merging (`blob` + `merge-reports` deliberately
  unused). Different cells, editions included, land in different folders with no extra machinery.
- D5 — Server modes: `ssh` (default, the baseline's `external`), `docker` (Apache and Nginx),
  `local` (whatever the user runs). Why a custom compose: §2.9.
- D6 — Full reporting stack: Playwright HTML, the Cucumber HTML report (dual-mode, `REPORT_MODE`),
  Allure 3 (§2.8).
- D7 — The plugin lifecycle covers WP-CLI and the admin UI. Cleanup is idempotent (absent ⇒ no-op);
  deletion as the action under test asserts presence first (§2.10).
- D8 — Orchestrator-ready from day one: all isolation lives in the suite, so the orchestrator only
  automates running cells and adds nothing to the run model. The two gaps found later (`bddgen`
  rewriting every cell's specs, the shared root `test-results/`) were the orchestrator plan's 0A.1
  and 0A.2, done.
- D9 — BackWPup Free and Pro are one product; edition is a per-cell property. Same plugin and
  domain, ~90 % shared: a second product would duplicate the shared part or fake-share it (§2.6).
- D10 — Site credentials never enter Playwright `metadata`, which Playwright serialises verbatim
  into its reports; pools reach workers through an in-process registry (§2.2).

## 2. Design rationale

What only this plan holds; each section names where the as-built mechanics are described.

### 2.1 One invocation per run unit

Verified against Playwright's docs (test-projects, test-parallel, class-testinfo, class-workerinfo,
class-testproject):

- Projects multiply: several projects matching the same tests run every test once per project (the
  cross-browser model). That gives "Apache and Nginx".
- Workers distribute: the pool runs each test once, handing the next pending file to a free worker.
  That spreads a cell's scenarios over its sites.
- `testInfo.parallelIndex` (a stable, restart-safe slot in `0…workers-1`) is bounded by the global
  `workers` and not reset per project; maintainers corroborate it (microsoft/playwright#38953 shows
  indices beyond per-project worker counts). So `pool[parallelIndex]` is safe only when one project
  runs in the invocation with `workers` = pool size; two cells in one invocation overflow the
  smaller pool.
- Per-project `workers` (since 1.52) caps how many workers a project uses, not which `parallelIndex`
  values it sees, so it does not make a multi-cell invocation safe.

Hence one cell per invocation; selecting more fails fast; a cell-less run is serial (`workers = 1`)
and reports to an `_all` bucket. The matrix across cells comes from running cells side by side.

Example: 50 scenarios and two cells ⇒ 50 run on Apache and 50 on Nginx, each spread over that cell's
pool; two products × two cells are four run units, four reports.

As built: [execution-model.md](../architecture/execution-model.md), "Worker → site binding", with
the `E2E_CELL` pin that later made two cells of one product safe side by side.

### 2.2 Worker → site binding and credentials

- A worker-scoped fixture binds the worker to `pool[parallelIndex]` for its lifetime; `baseURL` and
  `storageState` derive from it. Steps never hard-code a URL or credential, so adding sites or cells
  never touches step code.
- The config factory registers each cell's pool in an in-process registry as a side effect of
  building the config. Playwright re-runs the config in every worker, so each worker resolves its
  own pool locally; `metadata` carries only `{ product, cell, edition? }`.
- The pool never reached a report. The login's `fill()` put the site password into every real run's
  reports until the orchestrator plan's 0D.4 (secrets now typed through `enterSecret`); a scenario's
  retained trace still holds session cookies (AGENTS.md).

As built: execution-model.md, "Credential handling".

### 2.3 Artifact lifecycles

- Two lifecycles, decided by whether a history has value. History accumulates: reports, pruned as
  each run ends and by `report:prune` (the orchestrator plan's 0F); Allure's per-cell
  `allure-history.jsonl`, not pruned (its retention is open: the orchestrator plan, §4). Build
  output and transient state (generated specs, `storageState`, `test-results`) is overwritten in
  place, so it never piles up.
- Every path is keyed by `<product>/<cell>`, so different cells never share one. `*_ROOT` overrides
  replace only the root; the namespace is always appended, so an override cannot merge two cells.
- A cell runs with zero env vars: ephemeral paths follow from product and cell; `RUN_ID` only names
  the report folder (a sortable timestamp unless CI or an orchestrator passes a meaningful one).
- Reports are self-contained (each copies in its attachments), so emptying `test-results` never
  harms an older report. Cross-run trends come from Allure.
- The same cell never runs twice at once: its pool is shared WordPress state, and two runs would
  corrupt each other's database.

As built: execution-model.md, "Artifact directories & lifecycle" and "Report retention".

### 2.4 Scope and scaling

Everything shipped in v1: product separation, cells as data, pools, binding, per-cell reports,
isolation. A pool may be size 1 (serial within the cell, same machinery). Scaling a cell is data
only: add sites to a pool, or a cell key. A product is a folder plus its entry in `products.ts`, a
root `playwright.<name>.config.ts` and a `test:<name>` script (authoring-tests.md, "Adding a
product").

### 2.5 Products, sites files and service secrets

- Per-product Playwright entries sit at the repo root so every glob resolves repo-root-relative;
  each is a thin `createProductConfig(<product>)` call (authoring-tests.md, "Adding a product").
- Per-product structured sites files, not one flat `.env`: `process.env` is global to a process, so
  a different `.env` per product is impossible.
- Global service credentials (one external service per product, not per site) come from the
  environment; the committed config holds only their shape.
- A site may override a service credential in its own `overrides` block, validated at load with a
  path-named error — mostly to dodge per-host rate limits (FTP connection caps) when a cell runs
  many sites, or to point at another bucket or server.
- The override is to be deep-merged over the product's `services`
  (`merge(product.services, site.overrides)`, a site inheriting every value it does not declare).
  Not built: nothing reads `services` or `overrides` yet (only `sites.ts` validates them). Build the
  merge, or correct this text, `types.ts` and configuration.md, before the storage scenarios
  (phase-6 plan's 6H.2; the orchestrator plan's 0B.1).
- On the site, not in `SITE_<n>_<KEY>` env keys: it fits the data shape (an env key would have to
  encode product, cell and index, `WPROCKET_NGINX_SITE_2_FTP_HOST`), and index-based keys bind to an
  array position, so reordering a pool silently remaps them. Secret exposure does not separate the
  two: the sites file is already git-ignored and holds each site's secrets.
- Likely override candidates: FTP (high rate-limit risk), Dropbox and Rackspace (medium); S3 and
  Azure rarely (built for concurrency).

As built: configuration.md (but the merge above).

### 2.6 Editions (Free / Pro)

- Free and Pro are separate packages sharing most behaviour: Pro has Free's features (minus a few
  Free-only items such as beta subscriptions) plus more storages, quality-of-life flows and enhanced
  variants of shared flows.
- Edition belongs to the cell because it decides three cell-wide things: the package installed, the
  scenarios generated, the page-object branch. None is per site, so it is declared once per cell
  (`pro@nginx`, `free@apache`). It rides cells-as-data, so per-edition pools, reports and
  orchestration come free, with no new matrix axis; being non-secret, it travels in routing
  metadata. One value per cell, so no per-site field and no pool-uniformity check.
- Tags: none = both editions; `@pro` / `@free` = that edition's cells. Each cell's `defineBddConfig`
  gets a `tags` expression (`not @free` on Pro, `not @pro` on Free, none when editionless), which
  filters at generation (playwright-bdd `tags?: string`) and composes with `--grep`.
- A scenario tagged both would run nowhere. The design rejects it, but nothing enforces that today
  (no check in `project.ts` or `types.ts`) — open; no phase owns it yet.
- Different user journeys become separate `@free`/`@pro` scenarios sharing a Background (restore:
  Pro restores from the backup list, Free uploads a downloaded backup). Same steps with incidental
  UI differences: one untagged scenario and an edition-aware page object (an interface, one class
  per edition, a small factory selected by the `edition` fixture). Pro-only storages need no config
  split; their scenarios are `@pro`.
- Restore parity is 6I.1 in the phase-6 plan: Free's upload journey gets the same five UI strategies
  as Pro; CLI restore remains Pro-only by product design, and the shared 6K extractor remains a
  recorded Free-format decision.
- Absent edition: an editionless product declares none (no filter, one package). An edition-ful
  product must declare it on every cell — all-or-none, failing at load — rather than install an
  undefined package or run both editions' scenarios.
- Package selection is the artifacts capability (§7). The first sketch, a static
  `plugin: { free, pro }` zip map in the product config, was dropped: a committed path cannot say
  which build it holds, and nothing verified that a `pro` cell got the Pro package.

As built: configuration.md, "Editions"; authoring-tests.md, "Tags".

### 2.7 Authentication

Authenticate once per site and reuse its `storageState`, instead of the baseline's per-scenario UI
login. Each cell's BDD project depends on a setup project that logs in every real site (placeholders
skipped, so a fresh checkout stays green); `@noauth` scenarios start unauthenticated.

Not built: multi-user, which the baseline supports (`admin` vs `admin2`) — a second per-site state
file plus a step `Given I am logged in as {string}` → `context.setStorageState(path)`.

As built: AGENTS.md, "Auth fixture / setup".

### 2.8 Reporting

- Three tiers run together because playwright-bdd emits standard Playwright tests: Playwright HTML
  (the interactive trace viewer, the baseline's real gap), the Cucumber HTML report (the baseline
  report's successor), Allure 3 (history, trends, flaky categories, dashboards, `singleFile`).
  Capture: trace, video and screenshot all `retain-on-failure`.
- The Cucumber report trades a portable single file against an in-report trace viewer, so both exist
  (`REPORT_MODE`). Default (A): one self-contained file, screenshots and video embedded, only the
  trace zip skipped, opens from `file://` — for whoever downloads one file (planned for AutoE2E and
  CI). `rich` (B), for targeted debugging: HTML plus `data/` with the trace viewer, which must be
  served over `http(s)://`.
- The reporter embeds whatever exists and has no "embed only on failure" switch, so never add
  `video/webm` to `skipAttachments` in mode A.
- Versus the baseline: exceeds it (trace viewer, trends and flaky detection, per-(product × cell)
  reports); matches it by choice (video and screenshots embedded in the Gherkin report).

As built: README, "Reporting"; `src/common/config/reporting.ts`.

### 2.9 Server modes

| Mode | WP-CLI transport | Provisioning | Web server(s) |
| --- | --- | --- | --- |
| `ssh` (default) | node-ssh, remote host | existing remote sites | as the host configures |
| `docker` | `docker exec <container> wp …` | custom compose, `docker/` | Apache and Nginx |
| `local` | execa, on the host | the user's own install | whatever the user runs |

- The mode decides how WP-CLI is dispatched; it is orthogonal to which sites run.
- Planned sharing: an `ssh` site may declare only `mode` and `rootDir`; `host`, `username`,
  `privateKeyPath` and `port` resolve from a named profile in the product's `ssh.servers.json`, its
  `default` profile, or `E2E_SSH_*` (Phase 11). A field the site declares still wins.
- `@wordpress/env` is Apache-only (verified in its installed source: `FROM wordpress${phpVersion}`,
  `APACHE_RUN_*`, no Nginx path), so a custom compose provides both over one MariaDB: Apache from
  `wordpress:php8.x-apache`; Nginx = `wordpress:php8.x-fpm` with no published host port (Docker
  Hub's FastCGI security note) plus `nginx` with a WordPress vhost — the vhost is required, php-fpm
  alone serves nothing; a `wordpress:cli` container per install.
- `@wordpress/env` stays an optional, Apache-only convenience.

As built: README, "Local WordPress (Docker)"; `docker/`.

### 2.10 Exec layer and plugin lifecycle

- Commands are array args through execa or node-ssh (never a shell string), with an `exitCode` on
  every mode — the baseline omitted it on its docker/local branch, which made guards impossible.
- Two intents are never conflated. Cleanup (every scenario's Before/After) makes the plugin absent
  and treats already-absent as success: a Before runs before the first install, an After may follow
  a scenario that removed the plugin itself. Deletion as the action under test treats
  absent-when-expected and a failed deletion as failures.
- `wp plugin delete` exits non-zero both for "not found" and for a real failure, so state is probed
  with `wp plugin is-installed` (0 = installed) and removal re-verified; distinct error types tell
  the cases apart.
- The UI path exists because some product flows exist only there. WP Rocket's post-delete "delete
  data" confirmation is not exercised yet — to verify when porting WP Rocket.
- Other baseline capabilities: DB ops → `wp db query` through exec (`dbQuery`); settings
  export/import diff → Playwright `expect` deep-equality, `microdiff` only if a structured diff
  object is needed (WP Rocket, pending); `debug.log` scan → tag-scoped hooks, with a direct file
  read when a fatal stops WordPress booting; health check and report opener → `styleText`,
  `npm run report`.

As built: wordpress-automation.md (removal is `wp plugin uninstall`, never `delete` nor
`uninstall --deactivate`); the UI delete flow in `src/common/pages/plugins.page.ts`.

### 2.11 Page objects and step wiring

- Plain page objects only — no playwright-bdd decorators or `@Fixture` style, no hybrid. Interaction
  logic lives once in the POM, Gherkin wiring entirely in thin step functions, so neither leaks into
  the other. Product POMs register as fixtures in the product's own `fixtures.ts`.
- Edition-divergent pages: §2.6.
- Trap: a step file outside the product's `steps` glob, or not exported, registers zero steps
  silently ("undefined step").
- Port the baseline's `sections.ts` / `selectors.ts` to role- and label-based locators and web-first
  assertions: no brittle CSS chains, no manual `isVisible()` polling.

As built: authoring-tests.md, "Page Object Model".

### 2.12 Visual regression

The baseline's BackstopJS was fully disabled (`return; // Skip VR tests` in every step, zero
committed references) and used only an A/B model: the page with optimisations bypassed
(`?nowprocket`) against the optimised page, same run, no stored baseline. So the active model is
that A/B check, diffed with pixelmatch + pngjs (the engine Playwright uses internally, browser-free
and unit-testable). A committed-baseline helper (`screenshot.ts`, `toHaveScreenshot`) exists as
wiring only; if it is ever activated, generate baselines in the CI image or container, commit them
per project and mask dynamic regions.

As built: README, "Visual regression"; AGENTS.md, "Visual testing". The `@visual` scenarios land
with WP Rocket's port.

### 2.13 Device profiles

Device is a per-scenario client concern, orthogonal to cells and editions (it never multiplies the
matrix or touches the binding), so it is tag-driven and desktop by default. Sizes come from the
baseline: desktop 1600×700, mobile 389×829. `@mobile` applies a full `devices[…]` preset (viewport,
`isMobile`, `hasTouch`, mobile user agent, `deviceScaleFactor`) as a `use` override at context
creation — declarative, where standalone Cucumber forced imperative `setViewportSize` calls.

As built: `src/common/config/devices.ts`; AGENTS.md, "Device profiles".

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
| 7 Terminal output | next | below |
| 8 CI on real cells | dropped | below |
| 9 Orchestrator | moved | orchestrator plan |
| 10 Cleanup & validation | open | below |
| 11 Shared SSH server profiles | open — after Phase 7 | below |
| WP Rocket port | after Phase 10 | phase-6 plan, "After Phase 10 — WP Rocket" |

Phase 10 states no dependencies, effort or parallelism; Phases 7 and 11 state theirs below.

Phase 6: the three install-hook obligations this plan set (consume `pluginArtifact`, stage the zip
for `ssh`/`docker`, clean the staging area in worker teardown) are done (6A; `releaseBoundSite`).
Its open note on retries — "maybe 0 retries for local is not the best, must assess this" — has been
acted on: 2 retries everywhere, local runs included, `E2E_RETRIES` overriding
(`src/common/config/project.ts`); whether that is the final answer stays the phase-6 plan's to
judge. Acceptance this plan set, beyond 6A's and still open: a review checklist confirms no 1:1
carry-over from the baseline (WP Rocket's port included).

Phase 7 — Terminal output (next; decided 2026-10-22). The suite and the orchestrator.

- Goal: on a terminal, a run and the orchestrator are easy to scan: a short header, live progress
  (done/remaining, passed/failed/flaky), one aligned line per scenario, a failure block naming the
  scenario, the failed step and where to look, and a summary with the report paths. Piped, redirected,
  `CI`, `NO_COLOR`, `TERM=dumb` and narrow or non-UTF-8 terminals get the same information as plain,
  stable lines. No styling ever reaches a log, a report or `results.jsonl`.
- Today: `list` is the only configured reporter that prints worker output — `BaseReporter` only
  stores it, `ListReporter` dumps it — so removing it silently hides `[artifacts]`, `[site]`,
  `[auth]` and every worker warning. `run-summary.ts` prints one aligned block at the end, already
  honours `NO_COLOR` through `styleText` and already begins with a blank line. The orchestrator
  prints one timestamped line per event (`orchestrator/log.ts`); nothing shows a failed step while it
  happens, and no live state exists.
- Decisions:
  - One renderer, two front ends: a side-effect-free `src/common/terminal/` (capabilities, palette,
    layout, live region, stream helpers) used by the suite's reporter and by the orchestrator's
    logger. Add its modules to `orchestrator/suite-imports.json` one at a time;
    `import-boundary.spec.ts` must stay green. Nothing reads env, installs listeners or starts a
    timer at import: every capability is a parameter.
  - Style is a sink, never data: build strings once on plain text, then style. Every external string
    (title parts, error messages, paths, URLs, log chunks) goes through `plain` → masking → width
    cut. `plain` = `withoutControls` (`toWellFormed()`, VT sequences stripped, other C0/C1 a space)
    then Cf dropped (an emoji's ZWJ too: the sequence shows as its parts), runs of combining marks
    (Mn/Mc/Me) capped at 8 (real text has ≤ 5) and a trim. The layout takes plain text only: each
    function runs `withoutControls` first (never preserves an escape, never throws) and its output
    is styled after. The file sinks (`orchestrator.log`, `run.log`, `results.jsonl`, reports) stay
    byte-plain; tests assert no `\x1b` in them and no control characters in parsed values (`JSON`
    escapes `\u001b`).
  - Colour: `styleText` is the emitter, never the decision-maker. `detectCapabilities({ env, stream,
    mode?, context?, forceColorWithoutTty? })` owns the precedence (size from `stream.columns`/`rows`;
    `context` `run|ui|watch|list`, only `run` may redraw; `forceColorWithoutTty`, default `true`, the
    suite's, `false` for the orchestrator) and returns `{ tty, color, live, unicode }`; when colour is
    on, the palette calls
    `styleText(format, text, { validateStream: false })` (measured to bypass Node's own env checks),
    so a TTY under `CI` keeps its colour while the live region stays off. When off, identity. Named
    ANSI colours and bold/dim only — no 256/truecolor, no background fills. Semantic tokens: `ok`
    green, `fail` red, `warn`/`stop` yellow, `id` cyan, `dim` metadata and paths, `command` bold.
    Every status also has a symbol and a word; the word is dropped only on a TTY with colour on, and
    never for flaky (it shares `⚠` and `warn` with warning), so a CI log (even a `FORCE_COLOR` pipe,
    whose escapes get stripped) and a screen reader never see a colour-only status.
  - Precedence, once: `E2E_OUTPUT=plain` (the suite's switch) wins over everything; else a non-TTY
    stream of a caller passing `forceColorWithoutTty: false` (the orchestrator) has no colour; else
    `FORCE_COLOR` present (`0`/`false` in any case off, anything else on, empty included) wins; else
    a non-empty `NO_COLOR`, `NODE_DISABLE_COLORS` (any value, empty included), `TERM` `dumb`, unset or
    empty, or a non-TTY stream turns colour off; else a TTY turns it on. `CI` never turns colour off
    by itself; it only turns the live region off. `TERM` unset or empty is `dumb` for colour and live,
    but its symbols follow the locale.
  - `E2E_OUTPUT=auto|plain|fancy` (default `auto`, read by the suite only): `auto` = fancy on a TTY,
    plain otherwise; `plain` = no colour, no cursor movement, ASCII; `fancy` = live on a TTY even
    under `CI`, but never colour where the precedence says no and never cursor movement without a
    TTY. An invalid value fails fast at the env boundary, as `E2E_RETRIES` does. The orchestrator
    reads no `E2E_*` (0.5 §4.9) and detects from its own stream and the standard variables.
  - Symbols (`SYMBOLS`, Unicode → ASCII): `✔`→`OK`, `✘`→`x`, `⚠`→`!`, `■`→`#`, `▸`→`>`, `↻`→`~`,
    `█`→`#`, `░`→`-`, `✓`→`ok`, `✗`→`x`, `·`→`.`, `—`→`-`, `→`→`->`, `│`→`|`, `├`→`+`, `└`→`+`,
    `─`→`-`, `━`→`=`, `›`→`>`, `…`→`...`. ASCII when `TERM=dumb`, the locale is not UTF-8, or output
    is plain. The locale (first non-empty of `LC_ALL`, `LC_CTYPE`, `LANG`) is judged by name: unset is
    UTF-8; a codeset decides (`*.UTF-8`/`utf8`); a name without one (`C`, `POSIX`, `en_US`, `c`) is
    ASCII, except a bare `UTF-8` (7V16). A C/POSIX locale changes only the symbols, never colour or
    live. ASCII spellings can be wider (`OK`, `->`, `...`): layout measures the glyph.
  - Width: `stream.columns` when a finite integer > 0, else `COLUMNS` when digits only and > 0, else
    80; clamped 20–120. A TTY keeps its columns under `TERM=dumb`, a C locale or `plain`. Measure,
    per grapheme (`Intl.Segmenter`): max(`string-width` of the cluster, Σ `string-width` of its code
    points), ambiguous width narrow (`string-width`'s default; user decision 2026-10-27): never
    below what tmux draws, wider only for clusters a terminal draws narrower than their code points
    (an emoji with a skin tone counts 4, a ZWJ sequence its parts; 7V20, 7V21). Live rows are
    hard-cut to the width (`cutToWidth`: whole graphemes, the palette's ellipsis measured, shown
    only after at least one grapheme, else what fits bare); permanent lines are never truncated
    except a 500-code-point safety cap (`capLine`: whole graphemes, a longer-than-a-line grapheme
    cut by code point, the ellipsis itself capped), and commands and paths are never cut. A rule's
    title is never cut. A width argument is sanitised once: non-finite or negative 0, floored,
    capped at 500. `columns`/`rows` of 0 (BSD `script`) means no live region, not width 0.
  - Live region: only on a TTY, `rows` > 0 and `columns` ≥ 20 (the layout's minimum: narrower, a
    live row would wrap), not `CI` (unless `fancy`), not `--ui`/`--watch`, not `--list`; content
    redraws at most 2/s, height-capped at `rows - 1`; one writer owns the run's stdout and stderr.
    Setup: `openLiveTerminal(stream)` (`terminal/stream.ts`, explicit, nothing at import) makes a TTY
    non-blocking (`unblockTerminal`) and installs a no-op `error` listener — a real pty emits one
    `error` per queued write after `EIO`, a closed pipe `EPIPE`, and an unheard one crashes the
    process; the region learns of failures from write callbacks. `createLiveRegion` takes only what it
    returns (a branded `LiveTerminal`, checked at run time too); the drain waits on its `sink`.
    Cursor contract, byte-tested; inside a live region every line ends `\r\n` (7V27): after a draw
    the cursor is on the block's last row, column 0, no trailing line end; clearing N rows writes
    `\r\x1b[2K` then `\x1b[1A\r\x1b[2K` × (N-1), ending on the block's first row, column 0; a print
    (`print(text | lines[])`) clears the block, writes its lines there and leaves height 0; one
    repaint (of the newest rows, pending or shown) follows on the next event-loop turn and ≥ 50 ms
    after the last draw (`REPAINT_GAP_MS`), so a burst costs one repaint and spread prints ≤ 20/s
    (7V26). A permanent line is written before any backlog check and never dropped by the region;
    draws are skipped over the backlog bound (`TERMINAL_BACKLOG_BYTES`, 1 MiB, shared with the
    orchestrator's logger) and retried no sooner than 50 ms. A resize erases the old block as far as
    it can without touching a permanent line: up N-1, `\r\x1b[2K`, save, down 1, `\x1b[J`, restore —
    never `\x1b[J` from the top-left, which tmux's `scroll-on-clear` turns into scrolling the screen
    into history (7V22) —, resets to height 0 and redraws at the next throttle slot. Residue that
    stays (7V24, 7V25), never a permanent line: a narrowed block's split parts beyond its height,
    rows a shorter pane pushed into history, and in tmux 3.8 only up to half a widened block holding
    CJK rows. Rows: plain text or `{ text, style }` segments, cut first, styled after; a style is kept
    only if removing SGR (`\x1b\[[0-9;:]*m`) from its output gives the text back, and a styled row
    ends with `\x1b[0m`. Printed text keeps SGR and loses every other escape and control
    (`sgrOnly`), an open SGR closed at the line's end. No method throws (non-text rows draw as
    nothing). The cursor is never hidden; the region is closed in `onEnd` (before the HTML hint and
    the summary) and on every stop path, then the stream drained: a paused terminal costs the drain
    bound, never a frozen event loop (Playwright's runner itself then waits for stdout before it
    exits: a paused run ends when resumed, 7V54). A write that fails (`EPIPE`, `EIO`, a destroyed stream) turns
    the region off for good and is never thrown: a throwing reporter fails a run that passed.
    SIGKILL can leave it (the guide says so); the suite's session clears it on SIGTERM/SIGHUP (7V51).
  - One writer: `terminal.reporter.ts` implements `onStdOut`/`onStdErr` (cut into lines and print
    each **as it comes** — a SIGKILLed run's `run.log` keeps the hung scenario's last lines — under a
    `▸` begin line whenever the source differs from the last line's; strip VT codes, mask the whole
    line, then cap; print as permanent indented lines) and every suite
    reporter that writes during a run goes through its sink (`cell-notice`, `results-stream`'s
    warnings, `run-facts`'s). This keeps the setup lines and warnings visible once `list` is gone,
    and keeps `run.log` plain: workers are started with `FORCE_COLOR=1`, so their `styleText` output
    carries ANSI even when the runner's env says otherwise. The run's environment needs no colour
    variables: its allowlist already excludes `FORCE_COLOR`/`NO_COLOR`, and the reporter strips what
    the workers force.
  - Secrets: the failure block never prints a `result.steps` title or `params` — Playwright titles
    API steps with typed values (`Fill "…"`). It uses `firstError()`
    (`REPORTABLE_CATEGORIES`, `cleanMessage`) and `scenarioPlace()`. Every rendered field goes
    through `plain` → `redactSecrets` (shape) and, in the orchestrator, `maskValues` (by value) →
    cut; the suite holds no secret values, so a typed value is never shown because it is never
    printed. A canary typed with `enterSecret` plus a failing assertion proves it, including a
    title, `E2E_RUN_NAME` and `REPORT_ROOT` carrying an escape (`failure-block.run.spec.ts`, 7V59).
    `cleanMessage` drops format characters before masking (one inside a token defeated it, 7V64); a
    credential-shaped title withholds the attachment paths, whose folder name carries it (7V64).
  - `--list`, `--ui`, `PW_TEST_REPORTER`: the reporter is quiet and `printsToStdio()` returns
    `false`, so Playwright adds its own (`--list` keeps its listing; `PW_TEST_REPORTER=junit|null` gets
    `line`/`dot`, never a silent run). Watch mode does not intercept stdio (7V31): the reporter prints.
    The live region is inert under `--ui`/watch. `--reporter` replaces the whole suite stack (stream,
    reports, summary), not just this reporter; `--add-reporter` is not detected (an added printing
    reporter doubles every line; an added `list` prints errors unmasked); both documented.
- Suite (7.2a–7.2c):
  - 7.2a, the sink and plain output: replace `list` with `src/common/reporting/terminal.reporter.ts`;
    a `[run]` line after the unchanged `[cell]` notice (`product · cell (edition) · run id ·
    requested ref · N scenarios`) or, on a TTY, the same words as a `━━` rule; one line per
    scenario at its final attempt (`✔ 18.4s  Backups › …`, `✘ failed 8.1s  … attempt 2/2` when
    colour is off); a `↻` line per failed attempt due a retry; setup lines and the summary
    unchanged; no live block yet. Output stays bounded (one line per final scenario, one block per
    final failure, a capped error, worker output 200 lines per attempt and stream) so the 64 KiB log
    tail a run's reason quotes keeps `bddgen`'s cause. Worker output prints live everywhere, named by
    `▸` begin lines (7V33); the summary honours `E2E_OUTPUT=plain` (no colour; its glyphs are 7.2c's).
  - 7.2b, the live block: bar, counts (`done/total · % · passed · flaky · failed · running ·
    elapsed`) and at most one current line per worker (`▸ feature › scenario · site · elapsed`),
    bottom-pinned through the cursor contract, starting with the first `scenario.begin` so a long
    build shows setup lines, not a 0 % bar; nothing in plain. While the block is shown, the runner's
    own `process.stdout.write`/`process.stderr.write` are wrapped so every line — Playwright's
    warnings, `emitWarning`, another reporter's `console.*` — is printed above the block through the
    region, masked (`redactSecrets`); both are restored on close and on every stop path (user
    decision) but SIGKILL — SIGTERM/SIGHUP clear the block, then are re-sent (exit 143/129).
  - 7.2c, failures and the summary (built): a block under each final failure, its `--grep` from the
    raw titles (file, Feature, scenario; anchored, so that scenario and its exact duplicates only),
    pinned to the build tested on the test's own cell, never cut (refused, saying why, when unsafe);
    setups get their own; the summary's `Failed` list, width-aware rule, token `Styler`, shared
    palette. As built: `docs/architecture/execution-model.md` (Watching a run), 7V57–7V67.
  - Header contents: product/cell, run id, requested ref, planned scenario count — what `onBegin`
    knows. Plugin and site facts stay in the `[artifacts]`/`[site]` lines they already print and in
    the summary; they do not exist yet at `onBegin` and are not printed twice.
- Orchestrator (7.3a–7.3b):
  - Data (7.3a, built): `onActivity` replaces `onRunBegun` — `begun` (`id`, `runId`, `reportDir`,
    `startedAt`), `stopping` (level in force), `ended`, `notStarted` (an attempt that began no run),
    `cooling`, `loopEnded`; synchronous, a throw or rejection is a line. Counts come from a per-run
    tail of `results.jsonl` folded by `readRunResults`' own fold, line rule and decoding
    (`RunResultsFold`, `resultLines`, `scenarioCounts`), so the table counts what `run.finished`
    counts; never from stdout (a run's stdout is its log's fd). The tailer keeps an offset, slices at
    the last newline before decoding, skips a line with no newline within `3 × MAX_LINE_LENGTH + 1`
    bytes, starts over when the file shrinks or its dev/inode/first 256 bytes change, ignores a
    stream naming another `RUN_ID`, stops past `MAX_RESULTS_BYTES` (`unknown`), tolerates a missing
    file or FIFO, and holds no fd between polls; `stop()` never waits for a read. Scenario titles are
    `plain`ed again if ever shown: JSON preserves control characters.
  - States, from the orchestrator's own record: `starting` (launched, no `run.begin` yet),
    `setup n/m` (setups arriving, `run.end` not read), `running`, `stopping` (a stop asked), `cooling`
    (`next run HH:MM:SS` and the last outcome, or `not started · failed|stopped`), then `done`/
    `stopped`/`loop failed`. No `building`: the artifact build is inside the run's setup project.
  - Table (7.3b, built: `screen.ts`, `status/table-rows.ts`): bottom-pinned through the live region,
    one row per task (`TASK RUN CELL PROGRESS ELAPSED STATE`), the region opened with the first table;
    redrawn at most once a second (the region's throttle, `minIntervalMs` 1,000) and after a resize;
    cleared before every permanent line and, on every path, before `exiting` and before the give-up's
    lines; height-aware rows (`rows - 2`; the header dropped before any row, every run in flight —
    `starting` to `stopping` — first, then config order, `and N more`); columns dropped in order
    (bar, elapsed, cell, counts) down to one line per task below 50 columns; styled after the cut
    (header and count dim, the task's id in its task's colour, a status mark in its status's);
    Buffers under the 1 MiB backlog (skipped draws coalesce, never counted as lost lines); timers
    `unref`ed. The sink is the screen's when the terminal is live and `StartDeps.status` gives none.
    While the table shows, the process's own stdout and (a TTY's) stderr writes are captured
    (`terminal/stdio-capture.ts`, as the suite's live block) and printed above it through
    `safeBlock` (masked by shape and by the config's secrets); `uncaughtExceptionMonitor` and `exit`
    clear it on a crash (7V74, 7V75).
  - Permanent lines (7.3b, built: `line-style.ts`): today's words, in today's order; on a TTY the time
    dim, the scope in its task's colour (`Palette.series`, never a status's colour), a line wider than
    the terminal wrapped at its spaces with continuation lines aligned under the message (a word —
    path, command — never broken; no wrap when under 20 columns are left); a block — an empty line
    first — only for a run's end (its outcome line) and a stop's escalation (`LineOptions.opensBlock`).
    `--dry-run`, `--help` and refusals keep their exact text and stay unstyled (7V68).
  - `orchestrator.log` stays `ISO <scope>  <text>`; a piped stdout stays today's bytes (no table, no
    colour, Unicode kept). Slack, Datator, `run.finished` and `run.log` are untouched.
- Shape (TTY, abbreviated):

  ```text
  [cell] backwpup/pro@nginx, pinned by E2E_CELL: …
  ━━ BackWPup · pro@nginx (pro) ━━ bpng-42 · develop · 52 scenarios ━━━━━━━━━━━━━━━━━━━━━━━━━━
  [artifacts] …
  [site] https://bwu3.example: WordPress 7.1.2 · PHP 8.5.10 (fpm-fcgi) · nginx · database 8.4.5 (mysqli)

    ✔ 18.4s  Backups › Create a backup from the dashboard
    ✘  8.1s  Restore › Restore an archive                                   attempt 2/2
      └ When I choose the archive to restore                       features/restore.feature
        expected 200, got 500
        Screenshot reports/…/test-failed-1.png · Trace reports/…/trace.zip
        Rerun  E2E_CELL=pro@nginx E2E_PLUGIN_REF=<sha> npm run test:backwpup -- --grep="Restore an archive"
    ███████░░░ 23/52 · 44% · 20 passed · 1 flaky · 2 failed · 3 running · 4m 12s
      ▸ Backups › Download a backup · bwu4 · 1m 03s
  ```

  ```text
  TASK  RUN      CELL       PROGRESS                     ELAPSED  STATE
  bpng  bpng-12  pro@nginx  ███████░░░ 38/52 · 1 failed  18m 04s  running
  bfap  —        free@nginx ✔ passed · 52 scenarios      54m 10s  next 11:14:42

  10:15:30  orchestrator  started · 2 tasks (bpng, bfap) · .orchestrator/ · pid 4242
  ```

- Compatibility contract:

  | Sink / env                        | Colour                                                                            | Live              | Symbols          | Width                       |
  | --------------------------------- | --------------------------------------------------------------------------------- | ----------------- | ---------------- | --------------------------- |
  | TTY, UTF-8, no `CI`               | unless `NO_COLOR`/`NODE_DISABLE_COLORS`/`FORCE_COLOR=0`                           | yes               | Unicode          | `columns`, else `COLUMNS`, else 80 |
  | TTY, `CI`                         | as the precedence says                                                            | no (`fancy`: yes) | Unicode          | `columns`, else `COLUMNS`, else 80 |
  | TTY, `NO_COLOR`                   | no                                                                                | yes               | Unicode          | `columns`, else `COLUMNS`, else 80 |
  | TTY, `TERM=dumb`                  | no, unless `FORCE_COLOR`                                                          | no                | ASCII            | `columns`, else `COLUMNS`, else 80 |
  | TTY, `TERM` unset or empty        | no, unless `FORCE_COLOR`                                                          | no                | by locale        | `columns`, else `COLUMNS`, else 80 |
  | TTY, `C`/`POSIX`/non-UTF-8 locale | as the precedence says                                                            | as the rows above | ASCII            | `columns`, else `COLUMNS`, else 80 |
  | Pipe/file (`fancy` too)           | no, unless `FORCE_COLOR` and the caller allows it (suite yes, orchestrator never) | no                | Unicode if UTF-8 | `columns`, else `COLUMNS`, else 80 |
  | `plain`                           | no                                                                                | no                | ASCII            | `columns`, else `COLUMNS`, else 80 |

  `NO_COLOR` follows no-color.org (present and not empty); `FORCE_COLOR=0`/`false` disables, any other
  value enables and wins over `NO_COLOR` (Node then warns once on stderr; no palette option avoids it,
  7V17). `CI` is `true` when present and not empty/`0`/`false`; that only disables live. Every row is
  a case in `capabilities.spec.ts`; the TTY rows are also measured on a real pty
  (`terminal.pty.spec.ts`).
- Sub-phases:

  | #   | Delivers                                                                                                                        | Depends  | Parallel | Effort | Done when                                                                                                                                                                                                                                                                              |
  | --- | ------------------------------------------------------------------------------------------------------------------------------- | -------- | -------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 7.1a | **Done.** `terminal/capabilities.ts` and `palette.ts`: the precedence above, semantic tokens, identity palette; unit specs.     | —        | 7.1b     | S, ½ d | Every branch tested with injected env/stream objects; the `styleText` precedence measured through a real pty (`script -q /dev/null`, `stty`), never a fake `isTTY`; `validateStream` pinned; no visible change.                                                                          |
  | 7.1b | **Done.** `terminal/layout.ts`: width, grapheme-safe cut, padding, rules, line cap; `plain` gains `toWellFormed`, a combining-mark cap and the shared `withoutControls`; live needs ≥ 20 columns; `string-width` (dev dependency). | —        | 7.1a     | S, ½ d | Property tests: emoji/ZWJ/flags (odd too)/keycaps/CJK/combining/tabs/lone surrogates/escapes, `width(cut(s, n)) <= n`, no control in any output; tmux-measured widths pinned; `npm run typecheck`/`lint` green.                                                                                                                                       |
  | 7.1c | **Done.** `terminal/live.ts` and `stream.ts` (`unblockTerminal`/`drainTerminal` moved out of `orchestrator/terminal.ts`; `openLiveTerminal`, `writeSafely`, `TERMINAL_BACKLOG_BYTES`): draw/clear, print batching, resize, backlog, drain. | 7.1a, 7.1b | —       | M, 1 d | Byte-exact fake-sink contract; tmux 40×10 and 80×24 (3.8 macOS, 3.4 CI) keep every permanent line over 4 phases with a tall block at each resize, residue only within 7V24's bound; a real closed pipe does not crash, a paused pty does not freeze the loop (`script`); non-TTY prints only. |
  | 7.2a | **Done.** Suite sink: `terminal.reporter.ts` replaces `list` (pure parts `terminal-lines.ts`, `worker-output.ts`, `terminal-mode.ts`; `terminal-sink.ts` the one-writer registry); plain lines; `onStdOut`/`onStdErr` printed live with `▸` attribution, masked before any cut; `--list`/`--ui`/`PW_TEST_REPORTER` quiet with Playwright's fallback, watch active (7V30, 7V31); EPIPE-safe; the other suite reporters' lines through the sink, never cut; `E2E_OUTPUT` accessor (summary too). Audited twice (7V33–7V36). | 7.1a, 7.1b | 7.3a     | M, 1½ d | A real run on the Docker cell (`npm run env:up`) on a TTY and `\| cat` shows every setup line, warning and scenario once; `--list` lists; `results.jsonl` unchanged; a fake worker chunk with ANSI lands plain.                                                                          |
  | 7.2b | **Done.** The live block (`live-block.ts` rows, `live-session.ts` lifecycle): bar, counts (the reporter's `RunTally`, the summary's), one row per busy worker with its site (`siteLabel`, the terminal reporter's `sites` option), from the first scenario's begin to `onEnd`; the runner's own `process.stdout`/`stderr` `write` wrapped meanwhile (`terminal/stdio-capture.ts`; stderr only on a TTY; the region writes through a `bypassWriter`), restored on close, a callback's throw, a throw while drawing (tick, resize, first draw: closed and warned once, never retried), a failed write, `exit`, and `SIGTERM`/`SIGHUP` (cleared, then re-sent: 143/129); foreign lines masked; one block per terminal; narrow rows keep the time, then the scenario's name (feature path first to go); resize redraws; `onExit` drains, then re-blocks a drained terminal. Audited twice, fixed (7V51–7V56). 7V46–7V56. | 7.1c, 7.2a | 7.3b     | M, 1½ d | A 40×10 tmux pane shows 20 draws with a 120-char title and a worker warning, no residue, no lost permanent line; resize mid-run; `NO_COLOR` keeps live but no colour. |
  | 7.2c | **Done.** `failure-block.ts` (pure): under each final failure (or interrupted final attempt) `Step`/`Hook` (`failedStep` in `results.ts`: the Gherkin step, never an API title), `Feature`, `Error`, `Screenshot`/`Trace`, `Rerun` (the test's cell, also in a run of every cell; `pluginPin`: operator's zip when used, else `release:<tag>`, else `commit:<sha>` + `E2E_PLUGIN_VERSION`, else — targeted runs only — the operator's zip/ref/version; `--grep` of the escaped raw file, describes and title, each `(?: @\S+)*`, anchored at `$`; controls/format/marks past 8 as `\uXXXX`; `=` quoted; refused over 2,000 chars, a control in a value, a credential's shape, which also withholds attachment paths); setups' own block (`--project=<setup>`); a final timeout says `timed out`. Summary: `Failed` list (10, then `and N more`), `rule()` to the terminal's width, token `Styler`, palette glyphs (ASCII under plain), report paths plain; palette `Status` gains `could-not-test`/`interrupted`. `RunDescription` gains `pluginRef`/`pluginZip`/`pluginVersion`. Audited twice, fixed (7V62–7V67). 7V57–7V67. | 7.2a     | 7.4a     | M, 1½ d | Each failure kind names the scenario and the failed Gherkin step (never an API step); the canary never appears; the summary lists failures, 10 then `and N more`; exact-output specs updated deliberately. |
  | 7.3a | **Done.** Orchestrator seam (`tasks/activity.ts`: `onActivity` replaces `onRunBegun` — `begun` with `id`, `runId`, `reportDir`, `startedAt`; `stopping`; `ended`; `notStarted`; `cooling`; `loopEnded`), `status/` (`tail.ts` results.jsonl tailer on the end reader's own line rule, `progress.ts` on its fold and counts, `board.ts` states, `table.ts` plain table, `view.ts` `forceColorWithoutTty: false`, `watch.ts` shell behind `StartDeps.status`); palette `Status` gains `error`/`killed` (the suite's `error` mark now the palette's). Nothing new printed: production passes no sink (7V37–7V40). Audited twice, fixed (7V41–7V45). | 7.1a, 7.1b | 7.2a     | M, 1½ d | The fake suite renders `starting`/`setup`/`running`/`cooling`; a partial line, truncation, a missing file, a crash without `run.end` and `--once` are handled; no timer or fd leaks (soak).                                                                                              |
  | 7.3b | **Done.** `screen.ts` (on a TTY: styled lines, the table in a live region; none for a pipe), `line-style.ts`, `status/table-rows.ts`, `renderTableLines`, `Palette.series`; the process's own stdout/stderr printed above the table, cleared on a crash; `start.ts` opens the screen with the log, makes it the status sink when live, closes it before the give-up's lines and `exiting` on every path; `LineOptions.opensBlock` (outcome, escalation); `log.ts` on `writeSafely`/`backlogBytes` (an unreadable backlog is a gone terminal, never a throw). Piped bytes identical (7V69); tmux spec (7V70); soak flat with the screen drawn (7V72); gates (7V73). Audit fixes 7V74–7V80. 7V68–7V80. | 7.1c, 7.3a | 7.2b     | M, 1 d | TTY table and piped log on the fake suite; `SIGINT`/`SIGTERM`/`--once` clear it; `orchestrator.log`/`run.log` byte-plain; event, Slack and Datator payloads identical.                                                                                                                    |
  | 7.4a | Call-site migration: `verify`, `preflight`, `elevation-report`, `apvm`, `healthcheck`, `warm-artifacts`, `capture-backwpup-fixtures`; thrown reports become plain text, styled only when printed. Adds an emphasis token for bold labels (today `["bold","red"]`, `["bold"]` in `preflight.ts`/`verify.ts`; the summary's and failure block's labels and the summary's header use `command` until then); `→` becomes `symbol("arrow")`. | 7.1a     | 7.2a–7.3b | M, 1 d | `NO_COLOR`/`E2E_OUTPUT=plain` honoured everywhere; `formatFailureReport`/`buildReport` throw plain text; `npm run healthcheck > fleet.log` has no `\x1b`; specs updated deliberately.                                                                                                       |
  | 7.4b | Compatibility matrix, pty/tmux tests, docs, measured facts.                                                                     | all      | —        | M, 1½ d | The matrix is covered by tests; README/AGENTS/configuration/execution-model/orchestrator guide document the modes; all four gates green.                                                                                                                                                |

- Tests: the capability matrix against a real pty (`NO_COLOR` empty/non-empty, `FORCE_COLOR`
  `0`/`1`/`true`/empty, `NODE_DISABLE_COLORS`, `TERM=dumb`, `CI` empty/`false`, `COLUMNS` garbage,
  `C` locale), never a hand-built `isTTY` object (`styleText` rejects it or takes the wrong branch);
  layout properties; the live contract on a fake sink and in tmux; the reporter with fake Playwright
  events (final vs retry, flaky, timeout, hook/beforeAll failure, failed setup, drained, multi-error,
  worker output); a secrets canary typed with `enterSecret`; `--list`, `--ui` and `--reporter`; the
  orchestrator's fake suite (partial line, truncation, ENOENT, crash, SIGINT/SIGTERM, `--once`, a
  stalled terminal); byte-level checks that file sinks and parsed values stay plain. No new test
  dependency: `script -q /dev/null` with `stty` on macOS, `script -qec` on Linux; without `script` the
  pty specs (`terminal.pty.spec.ts`, `stream.spec.ts`'s paused pty) skip locally and fail under `CI`;
  likewise tmux for `live.tmux.spec.ts`, which CI's unit jobs install with apt (7V23).
- Phase 7 — measured (2026-10-23, Node 24.21.0 and 26.12.1, macOS; a real pty unless said):

  | #    | Claim                                                                                                                                                                                                                                 | Evidence                                                                                                     |
  | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
  | 7V1  | `styleText` on a pty: plain under non-empty `NO_COLOR`, any `CI` (even empty/`false`/`0`), non-empty `NODE_DISABLE_COLORS` (an empty one keeps Node's colour; the precedence still turns colour off for any value), `TERM=dumb`, an unset `TERM` and `FORCE_COLOR=0`; colour otherwise; a `FORCE_COLOR` Node reads as on (7V15) wins over all of them, warning if `NO_COLOR` is set; `NO_COLOR=""` does not disable. | pty probes, both Nodes                                                                                        |
  | 7V2  | A hand-built `{isTTY:true}` stream is not a pty: `styleText` rejects a plain object (`ERR_INVALID_ARG_TYPE`); a `Writable` with `isTTY: true` reads only `FORCE_COLOR`, so it colours under `NO_COLOR`, `CI`, `TERM=dumb` or no `TERM`, where a pty does not. Test with `script`. | `terminal.pty.spec.ts` measures both per case                                                                |
  | 7V3  | `styleText(..., { validateStream: false })` bypasses every env check and emits SGR, so a palette that decides first can style deterministically (including `CI` + colour).                                                             | pty probes                                                                                                    |
  | 7V4  | Playwright starts workers with `FORCE_COLOR=1`, so a worker's `styleText` emits ANSI into its output; `list` strips it (`StripAnsiStream`) only because it controls the screen.                                                        | `playwright/lib/runner/index.js` (WorkerHost)                                                                 |
  | 7V5  | `BaseReporter.onStdOut/onStdErr` only stores worker output; `ListReporter` is what prints it. Removing `list` without implementing both loses `[artifacts]`, `[site]`, `[auth]` and warnings from the terminal.                       | `runner/index.js` (BaseReporter, ListReporter)                                                                |
  | 7V6  | `firstError()`/`REPORTABLE_CATEGORIES` already pick a safe step chain; raw `TestStep` titles and `params` can hold typed values (`Fill "…"`). The BDD step's `location` is the generated spec, not the `.feature` line.                | `src/common/reporting/results.ts`; `playwright-bdd/dist/runtime/bddStepInvoker.js`                            |
  | 7V7  | A run's stdout and stderr are its `run.log` fd (`stdio: ["ignore", fd, fd]`), so the orchestrator cannot pump or strip them; only the reporter's `onStdOut`/`onStdErr` can.                                                          | `orchestrator/runs/launch.ts`                                                                                 |
  | 7V8  | `run.json` has no `reportDir`, and `onRunBegun` carries only `(id, taskId)`; `RunIdentity` has `reportDir` and `startedAt` at launch.                                                                                                 | `orchestrator/runs/record.ts`, `cycle.ts`, `start.ts`                                                         |
  | 7V9  | BSD `script` and util-linux `script` (2.39.3) both give a pty `columns=0`, `rows=0` when their stdin is not a terminal; `stty cols/rows` inside the session fixes it; `script -qec` is util-linux only.                            | measured; `terminal.pty.spec.ts` (unsized case), macOS and Ubuntu 24.04                                       |
  | 7V10 | The draw/clear contract above leaves no residue and loses no permanent line in a 40×12 tmux pane over five cycles (no resize: 7V22, 7V24).                                                                                                                    | tmux capture                                                                                                  |
  | 7V11 | `run-summary` already begins with a blank line and already drops colour under `NO_COLOR` (it passes `process.stdout`). The summary's `WIDTH` is a fixed 88 and its marks are literal Unicode.                                          | `run-summary.ts`; pty probe                                                                                   |
  | 7V12 | `reporting.spec.ts` pins `"list"` (position and neighbours); `--reporter` replaces the whole configured stack, stream and summary included.                                                                                            | `src/common/config/reporting.spec.ts`; `run-pruning.run.spec.ts`                                              |
  | 7V13 | `--ui`/`--watch` create the config reporters and replace `process.stdout.write`/`stderr.write` with dispatchers, so a live region must stay inert there.                                                                               | `runner/index.js` (`disableConfigReporters`, `_setInterceptStdio`)                                            |
  | 7V14 | util-linux `script` exits 0 when SIGTERMed (BSD: 143), so a spawn `timeout` passes a killed probe off as finished: the pty spec times probes with its own timer, then SIGKILL.                                                       | 2026-10-27, Ubuntu 24.04 container, util-linux 2.39.3                                                         |
  | 7V15 | Node's `styleText` reads `FORCE_COLOR` `yes`, `FALSE`, `False` as no colour (pipe and pty); `2`, `3`, empty as colour. The precedence reads `yes` as on, `FALSE` as off.                                                              | 2026-10-27, Node 24.21.0 macOS; pinned in `terminal.pty.spec.ts`                                              |
  | 7V16 | Codeset-less locales: Ubuntu 24.04 gives `en_US`, `c`, `UTF-8`, `c.utf8` (and every uninstalled locale) the charmap `ANSI_X3.4-1968`; macOS reports none for `en_US`/`de_DE` (their `LC_CTYPE` links `C.UTF-8`'s; `nl_langinfo` fails) and `UTF-8` for `LC_CTYPE=UTF-8`. Hence by name: codeset-less is ASCII except bare `UTF-8`. | `locale charmap`, Python `nl_langinfo`, 2026-10-27                                                            |
  | 7V17 | Node's "NO_COLOR is ignored due to FORCE_COLOR" warning fires once, when anything loads Node's colour helpers — the ESM or tsx loader at start-up already does — so `validateStream: false` cannot keep it off stderr; a bare CommonJS bypass call does not warn. | `node --trace-warnings`, 2026-10-27; pinned in `terminal.pty.spec.ts`                                         |
  | 7V18 | Playwright's workers inherit `FORCE_COLOR=1`, so an in-process palette spec passes even without `validateStream: false` unless it removes `FORCE_COLOR` and sets `NO_COLOR`/`CI`/`TERM=dumb`; `palette.spec.ts` does, per test. | mutation run, 2026-10-27                                                                                      |
  | 7V19 | `string-width` 8.3.0 (2026-09-24; deps `strip-ansi`, `get-east-asian-width`; Node ≥ 20): `ambiguousIsNarrow` default `true`; a cluster counts its first visible code point's width (plus spacing marks), RGI emoji, ZWJ sequences and keycaps 2, a tab and a lone surrogate 0. Node's `stripVTControlCharacters` leaves DCS/APC/PM/SOS and C1 OSC bodies (their `ESC`/C1 then become spaces), so payload text may show but no control passes. | `node_modules/string-width/index.js`; Node 24.21 probe, 2026-10-27 |
  | 7V20 | tmux 3.8 (macOS, `en_US.UTF-8`; cursor column after printing): every palette Unicode symbol 1 column (ambiguous drawn narrow); Thai KO KAI+SARA AM ×4 8, Devanagari KSSA ×3 6, `a` + 5 / 30 skin-tone modifiers 11 / 61, 3 regional indicators 3 (a lone one 1), keycap+VS16 2, CJK 2 each, `é`/`e`+U+0301/`±` 1. `string-width` alone gives 4, 3 and 1 for those three: a live row would wrap, hence the per-code-point sum. | `layout.spec.ts` table (both columns), 2026-10-27 |
  | 7V21 | Where tmux 3.8 draws less than the measure (pads short, never wraps): ZWJ family 2 vs 6, rainbow flag 2 vs 3, emoji+modifier 2 vs 4, keycap without VS16 1 vs 2, Hangul L+V jamo 2 vs 3, Devanagari consonant+spacing mark 1 vs 2, a Burmese syllable 1 vs 4. Real text with 5 marks (cantillated Hebrew, Burmese, a Tibetan stack) draws 1 column. | tmux probe, 2026-10-27 |
  | 7V22 | tmux on resize: wider, rows stay whole and the cursor leaves column 0 (col 20 after 40→60); narrower, rows wider than the pane split and the cursor goes to the last part; shorter, blank rows below go first, then the top into history, out of cursor-up's reach. `\x1b[J` with the cursor at the top-left is tmux's `scroll-on-clear` case (default on, 3.4 and 3.8): the screen scrolls into history, the old block with it — the first resize erase (up N-1, `\r\x1b[J`) left the whole 12-row block after a height-only shrink 80×24→80×10. `\n` + redraw (the first design) left the whole old block. xterm.js 5.5 has no such case. | erase-matrix probe (tmux panes; xterm.js headless), tmux 3.8 macOS, 3.4 Ubuntu 24.04, xterm.js 5.5 headless, 2026-10-28 |
  | 7V23 | GitHub's `ubuntu-24.04` image (20261023.334.3) has no tmux (its readme's apt list skips from `tk` to `tree`); Ubuntu 24.04's apt gives 3.4, on which the terminal specs pass under `CI=true` (×5 each, `--repeat-each=5`). CI installs it in both unit shards with `DPkg::Lock::Timeout=60`, one retry, `--no-install-recommends`. `script` (util-linux) is on the image. | runner-images readme; ubuntu:24.04 container, 2026-10-28 |
  | 7V24 | Resize erase, residue lines left (12-row block, 8 lines above; tmux 3.8 / 3.4 / xterm.js), old `up N-1, \r\x1b[J` → new `up N-1, \r\x1b[2K, save, down 1, \x1b[J, restore`: 80→60 narrow 6→6 (all three); 80×24→60×10 12→7 (tmux), 7→7 (xterm.js); height-only 24→10 rows 12→2 (tmux), 2→2 (xterm.js); 40×12→40×4 (11 rows) 11→7; widen 80→100 with CJK rows: tmux 3.8 6 of 12 either way (its reflow moves wide-char rows above the cursor), 0 on 3.4 and xterm.js. No permanent line lost or altered in any of 180 cases per terminal. Erasing more (reflow arithmetic) would erase permanent lines on a terminal that truncates instead of reflowing, so the rest is accepted. | erase matrix, 2026-10-28 |
  | 7V25 | `live.tmux.spec.ts` (8-row block at each resize, 50 ms throttle pending), residue / bound per window, identical over 3 runs: 40×10 → 60×14 0/4, → 40×10 4/7, → 40×6 2/3; 80×24 → 100×30 2/4 on tmux 3.8 (0 on 3.4), → 80×24 3/5, → 80×20 0/0. It fails on: resize writing nothing, erasing one row, the old top-left `\x1b[J`, keeping the old geometry. | tmux 3.8 macOS, 3.4 container, 2026-10-28 |
  | 7V26 | Print cost (1,000 lines, 42,890 B, under a 10×120 block): repaint per print 1,228,890 B written (28.7×, 1,001 writes); batched, one burst 43,976 B (1.03×) and one repaint; one print every 2 ms 104,835 B (2.44×), the gap capping repaints at 20/s. | burst probe (fake sink), 2026-10-28 |
  | 7V27 | `\n` returns to column 0 on a cooked pty and under Node's `setRawMode(true)` (libuv keeps `ONLCR`), not after `stty -onlcr` (staircase): hence `\r\n` inside the live region; passthrough keeps `\n` so piped bytes are unchanged. | tmux 3.8 capture, 2026-10-28 |
  | 7V28 | A pipe closed after 20 bytes: without an `error` listener the process dies on `EPIPE` (unhandled `error`); with `openLiveTerminal` it prints on, the region dead, `onFailure` once. A pty nobody reads (`script`, its stdout unread) behind 4 MB: blocking, a 100 ms timer never fires in 8 s; via `openLiveTerminal`, it fires in ~0.3 s. | `stream.spec.ts`, macOS and Ubuntu 24.04, 2026-10-28 |
  | 7V29 | macOS: a process's first use of `process.stderr` reopens its tty by name (`uv_tty_init`), which blocks once the pty's master is gone, so the tmux driver's give-up path writes fd 2 with `writeSync`. With it, SIGINT or SIGKILL of the spec mid-phase leaves no driver, server or socket folder within 3 s (macOS and container, ×4 each). | `sample` of a stuck driver; interrupt probe (SIGINT/SIGKILL of the runner's process group), 2026-10-28 |
  | 7V30 | `--ui` runs the config reporters (`createReporters`, `_mode: "test"`) in the CLI process (its `argv` holds `--ui*`) under a test server that replaced `process.stdout.write` with an own property of the stream (`_setInterceptStdio`); a plain run leaves it the prototype's. Driving `TestServerDispatcher` with `interceptStdio: true` on the Docker cell: the own property is set during `runTests`, the `[cell]` notice and summary reach the UI's stdio pane, the terminal reporter prints nothing. | `runner/index.js` (`runUIMode`, `createReporters`, `_setInterceptStdio`); in-process test-server probe, 2026-10-28 |
  | 7V31 | 1.63 has no `--watch` flag: watch mode is `PWTEST_WATCH` (`cli/testActions.js`), config reporters on, stdio not intercepted. `PW_TEST_REPORTER` and `--add-reporter` both append to the configured stack; only the first is detected (`--add-reporter` with a printing reporter prints twice). `ListReporter.onError` was the only printer of errors outside tests: the terminal reporter prints them. | `cli/testActions.js`, `common/index.js` (`additionalReporters`), `runner/index.js`; `results-stream.run.spec.ts` |
  | 7V32 | Docker cell (`wp-rocket/apache`), the terminal reporter on a pty (`script`, `stty cols 100 rows 30`) and piped: each of 11 `[auth]`/`[site]`/`[artifacts]`/APVM lines and the `[artifacts]` warning a `list` run printed appears exactly once (in the `│` gutter); `[cell]` once; 5 test lines; the TTY rule 100 columns; the pipe holds no `\x1b`. `results.jsonl` equals a `list` run's event for event once `at`, `durationMs` and `runId` are dropped (10 events). | real runs, 2026-10-28 |
  | 7V33 | 7.2a audit, fixed: worker output held to the attempt's end was lost from a SIGKILLed run (the tail showed the previous scenario), and two setups running at once printed under one begin line. Now live, named per source: 8 workers interleaving 240 lines (half split over two writes) — every line once, under its own `▸` line (×3); SIGKILL of the group mid-run — each worker's lines a gap-free prefix, all named; the 2-setup fixture alternates `▸ auth` / `▸ artifacts` per line. A global timeout calls `onEnd` before the running tests' `onTestEnd` (`--global-timeout`): their open lines print with the late end. | fixtures (`p2`, 8-worker, `kill.mjs`, `--global-timeout`); `results-stream.run.spec.ts`, 2026-10-28 |
  | 7V34 | 7.2a audit, fixed: raw lines were cut to 4,096 units **before** masking — `FORCE_COLOR` escapes inflate a line, so the cut fell inside `https://admin:…@` or a `ghp_` token and printed the head unmasked (real runner). Now a 64 KiB memory bound that drops the word the cut falls in, then `plain` → `redactSecrets` on the whole line → `capLine`; the same inputs print `https://***@…` and `token ***`. | `t6/leak.spec.ts` before/after; `worker-output.spec.ts` (every cut offset); run spec, 2026-10-28 |
  | 7V35 | Playwright 1.63 adds `line` (`dot` under `CI`) only when no reporter `printsToStdio()`: a quiet reporter answering `true` left `PW_TEST_REPORTER=junit`/`null` runs silent but for `[cell]` and the summary. `printsToStdio()` is now `false` whenever quiet; both runs print `1 passed`. `--quiet` (`config.quiet`) made `list` drop worker output only: matched. | `createReporters` (`runner/index.js`); run spec, 2026-10-28 |
  | 7V36 | A reader closing early (`… \| head -1`) crashed the runner with an unhandled `EPIPE` before `run.end` (as `list` did). With the reporter's `error` listener (kept after `onExit` once the stream failed, so the summary's writes fail silently too): exit 0 for a passing run, `run.end` written, no stderr. | fixture and run spec, 2026-10-28 |
  | 7V37 | 7.3a: the fake suite (real `start`, real processes, stream appended over 2 s, a line split inside an emoji) renders `starting` → `setup 0/2` → `setup 1/2` → `running` → `ended` → `next HH:MM:SS` → `stopped`; `--once` ends `done`; a runner that dies without `run.end` (a half last line) shows `running`, then `✘ error · 3 scenarios`; a stream that never appears stays `starting`. ×3 green. | `status/start-status.spec.ts`, 2026-10-28 |
  | 7V38 | 7.3a: piped stdout of the real CLI over the fake suite (`--once`, and stopped by one SIGINT once cooling) is byte-identical to c95da2c's once times, PIDs and temp paths are normalised; the table is never printed (production passes no sink). | `swap-start` runs of both trees, `diff`, 2026-10-28 |
  | 7V39 | 7.3a soak, 50 runs ×2 with the status sink at a 20 ms poll: listeners 15, resources 6, timers 2, fds 22 at every sample; each run shown ≥ 3 times, the last table `over`. The tail opens and closes the stream on each poll (no fd held between polls). | `ORCHESTRATOR_SOAK_RUNS=50 npm run orchestrator:soak`, 2026-10-28 |
  | 7V40 | 7.3a mutation pass: 43 mutants over `status/*.ts` (tail 11, progress 6, board 7, table 11, view 3, watch 5); 6 survived the first run, 5 then killed by new tests (setups counted, a stepped-back clock, a floored bar, an ended run's tail never read again, a read settling after stop); 1 equivalent (`takeChunk` skipping to the newline rather than past it: the empty line is dropped by `parseResults`). Every file restored byte-identically (SHA-256 checked). | scratch harness, 2026-10-28 |
  | 7V41 | 7.3a audit, fixed — counts: the tail's own looser schemas counted a `scenario.end` `run.finished` drops (no `feature`) as `1 failed`; `ProgressFold` now runs the end reader's `RunResultsFold`/`scenarioCounts`, the tail its `resultLines` and `Buffer` decoding (BOM kept: `TextDecoder` stripped one per read). Probe, 140k-unit/280 KB line: before tail 0 / end reader 1 scenario, after 1/1 (window `3 × MAX_LINE_LENGTH + 1` B). `pollBytes` 100 under a 466-B line: before offset 0 forever, after read (budget ≥ one window). Truncate-and-regrow: before `reset: false`, mixed counts; after reset (dev/ino + first 256 B + size). A stream naming another `RUN_ID` counts nothing; past 8 MiB it shows `unknown` and is no longer read. | `B-probe` rerun, `tail`/`progress` specs, 2026-10-28 |
  | 7V42 | 7.3a audit, fixed — lifecycle: `stop()` awaited a read in flight, so a never-settling read held the start's exit and its lock; it is now synchronous (results after it dropped, the poll loop breaks). A FIFO in the stream's place: `not a file` in 0 ms (`O_NONBLOCK`; a blocking open is still blocked after 1 s). A sink or listener returning a rejecting promise was an unhandled rejection; it is now dropped (table) or a line (loop, cycle), both typed `=> undefined`. Specs: read pending across `stop`, two runs one timer and no concurrent read, `hasRef() === false`, the start's give-up and `--once` exits read and show nothing after return. | `watch`/`start`/`cycle`/`loop` specs, 2026-10-28 |
  | 7V43 | 7.3a audit, fixed — states: `setup n/m` shown after `run.end` (a failed dependency) → `running`; an attempt that began no run kept the last healthy outcome (`✔ passed … next`) → `notStarted` activity, `✘ not started · failed`; `stopping` carried the level asked, not in force; a short table kept the header over a row (height 3: 1 row + `and 3 more` → 2 rows + `and 2 more`). | `board`/`table`/`loop`/`cycle` specs, 2026-10-28 |
  | 7V44 | `start-status.spec.ts` under 12 `yes` burners, `--workers=8 --repeat-each=20`: before (timed appends) 20/20 of its first test failed (missing `setup 0/2`); after (fake `gateDir` handshake opened by the `read` seam, `exitAfterAppends`) 80/80 passed. | load harness, 2026-10-28 |
  | 7V45 | After the fixes: `test:unit` 4,392 passed; soak 200 runs flat (listeners 15, resources 6, timers 2, fds 22), a run's stream read (`mostDone ≥ 1`); piped stdout/stderr/state of 5 modes byte-identical to c95da2c once normalised (the fake's own source swapped back: `run.log` quotes it). Mutations: 82 audit mutants adapted + 27 new, 109: 100 killed; 9 equivalent (T1, T2, T9, T18 tail byte edges; T17 poll budget now ≥ a window; W1, W7 redundant stop guards; N11 fold guard behind `progress()`'s `tooLarge`; S4 start's own-run map). Every file restored byte-identically. | scratch harness, 2026-10-28 |
  | 7V46 | 7.2b, `live-block.run.spec.ts` (real `bddgen`/runner/reporters; 19 scenarios, 1 s steps, 2 workers on placeholder sites; a 120-char title, a worker warning, the runner writing `console.error`/`console.log`/`emitWarning`/a line in two writes): a 40×10 pane shows ≥ 10 distinct sampled progress rows and ≥ 20 draws in its `pipe-pane` bytes (37 measured) over ≥ 10 s (any `formatDuration` unit parsed), every permanent line once and whole, 0 residue lines, the summary last; narrowed 60×14→40×10 mid-run, lines intact (bound 3, one block; 1 measured, a split progress row: 7V24; without resize handling, dozens); a lone 5 s scenario (`--grep`) drawn ≥ 8 times by the tick alone (11 measured; 1 s tick ~5, none 1) with its row's time at 1–4 s; `NO_COLOR` keeps the block with no SGR in our lines. Corrected by 7V53 (it first claimed 20 draws from 10 sampled rows and resized widening first). ×5 green: macOS tmux 3.8 and `p71a-audit-b` (Ubuntu 24.04, fresh `npm ci`, tmux 3.4, `CI=true`, the spec passing `E2E_OUTPUT=fancy`). Not ours: Playwright's HTML-report hint is cyan under `NO_COLOR`, a foreign coloured write keeps its SGR. | tmux runs, 2026-11-01 |
  | 7V47 | Without the stdio wrap (mutant E1) the runner's own lines vanish under the block: `console.error`, the two-write line and the `emitWarning` 0× in the joined capture, 2 residue lines. Piped (`E2E_OUTPUT=fancy`, `TERM` set): no `\r`, no escape of ours, no block byte; a foreign partial line interleaves with the reporter's lines there (nothing holds it), as before 7.2b. | mutant + run spec, 2026-11-01 |
  | 7V48 | Docker cell `wp-rocket/apache` (2-site pool: :8100 and :8101), tmux 100×30, `--repeat-each=4`: APVM/`[site]`/`[artifacts]` lines print plain during the 1.1 m setup, no bar; from the first scenario `░░░░░░░░░░ 0/12 · 0% · 0 passed · 1 running · 1m 07s` / `  ▸ WP Rocket test runner scaffolding › The WP Rocket project is wired up · localhost:8100 · 0s`; final screen ends with the summary, no residue, exit 0. | real run, 2026-11-01 |
  | 7V49 | (Superseded by 7V55.) 7.2b mutation pass: 64 unit-level mutants (stdio-capture 16, live-block 19, live-session 13, reporter 10, `siteLabel` 4, `reblockTerminal` 1) + 3 against the tmux spec. 61 killed once 3 tests were added (C13 a stream given twice restored to the prototype, B19/R9 elapsed from the run's start); 3 equivalent redundant guards (C15 restore's own idempotence, S13 a dead session's print, R10 `dead` on failure — the next print sets it). Run level: E1 killed; E2 (no close in `onEnd`/`onExit`: the `exit` hook clears) and E3 (no drain: a fast pty loses nothing) survive the tmux spec, their unit twins R3/R7/S6/S7 killed. Every file restored byte-identically (SHA-256). | scratch harness, 2026-11-01 |
  | 7V50 | `run-summary.spec.ts`'s pruning case was a date bomb: reports dated 2026-10-01..03 crossed the 30-day rule on 2026-10-31, so the reason read `older than 30 days` (fails on 2232fba too); now 3–5 days before now. `orchestrator/cli.spec.ts:328` timed out once under the full suite's load and passed alone (the Phase 10 deferral's flake). | 2026-11-01 |
  | 7V51 | 7.2b audit A-F1, reproduced (auditor's `tm.sh term`/`hup`): SIGTERM/SIGHUP while the block showed → no `exit` event, block left, `EXITED 143`/`129` written over its last row. Playwright's runner has no SIGTERM/SIGHUP listener (its worker's are no-ops); signal-exit (execa) re-raises only when alone, so the session re-sends only when no listener is left — else two polite handlers would keep the process alive. After: block cleared, capture restored, still 143/129, fds blocking after. | tmux runs, 2026-11-01 |
  | 7V52 | 7.2b audit A, reproduced and fixed: F2 `maskSiteUrl("https://user:123/secretpw@host.example/")` showed `user:123/secretpw@host.example` (pre-existing in every `maskSiteUrl` caller, `siteLabel` inherited it) and `;jsessionid=…` — now all before the path's last `@` is `***@`, `;` parameters `;***` (a plainly written path credential still shows unless its shape is known); F4 12 sessions → 12 `error` listeners + MaxListenersExceededWarning, now 1 (keyed by `UNDERLYING_STREAM`); F5 a `DataView` skipped the capture, now any `ArrayBuffer.isView`; F6 documented (bytes of the given encoding shown as a UTF-8 terminal would); U1 a throwing rows source escaped the timer and left the capture (and the constructor left it), now closed + `onError`; U2 a foreign `https://admin:pw@…` printed whole, now `redactSecrets`; U3 a second terminal reporter's block was captured and printed as lines, now one block per stream. | unit repros, 2026-11-01 |
  | 7V53 | 7.2b audit B, reproduced and fixed: F1 the resize test widened first (no-resize mutant survived), now narrows 60×14→40×10, bound 3; F2 `, in (\d+)s` → NaN past 60 s (load), now every unit; F3 under load `ENOTEMPTY` on cleanup and "never ended" at 120 s, now the group is waited for, `rmSync` retries, `RUN_TIMEOUT_MS` 240 s (see 7V56); F4 draws and tick unproven, now 7V46; F5 a long `TMPDIR` (> 104-byte socket) failed with "File name too long", now `/tmp/e2e-lb-*`, passes; F6 header and `ci.yml` (both shards) name both tmux specs and Chromium; F7 44×7 rows all `The live block,…`, now the feature path goes first (8 workers at 40/44 cols name each scenario), progress row keeps the time over `running`; F8 M46/M51/M58/M69/M34 now killed. | tmux + unit, 2026-11-01 |
  | 7V54 | 7.2b audits, not fixed: U4 a partial line held at close is written raw (the next line joins it, as without the capture: the writer never ended it); U5 permanent lines queue unbounded while paused (as Node's own stream queue; 7.1c's bound applies to repaints); U6 the runner on a paused terminal (Ctrl-S) lingers until resumed — Playwright writes `""` to stdout/stderr and awaits the callbacks before exiting — `stream.ts` now says so; `cutLines` re-splitting the held line: 65,536 one-char writes then `\n` take 91 ms (1.4 µs/write), immaterial; a SIGKILLed spec runner leaves its tmux server until the pane's `sleep 30` ends and the socket folder (documented); fakes calling back synchronously: the drain's async path is 7.1c's real-stream specs'. | measured, 2026-11-01 |
  | 7V55 | 7.2b mutation pass after the fixes: 105 unit mutants (64 from audit B still applicable + 41 for the fixes) — 97 killed after 6 tests were added; 8 equivalent: M19/N14 redundant (restore idempotent, `region.close` never throws), M36/M63 (a dead region refuses anyway; the next print marks it), M38 (`rows > 0` gives 0 too), M52 (a site exactly fitting is uncut either way), M55 (`didNotRun ≤ total`), M66 (an empty site is no site). One dead branch removed (`attemptRow`'s name-whole candidate). Run level B1–B8: B1, B2, B4 (resize), B5 (no tick), B6 (1 s tick), B7 killed; B3 (close only in `onExit`) and B8 (no drain) equivalent on a fast pty, their unit twins killed. Every file restored byte-identically (SHA-256). | scratch harness, 2026-11-01 |
  | 7V56 | 7.2b load harness (`live-block.run.spec.ts --repeat-each=10 --workers=4` beside 12 `yes`, 12 cores, load average 50–70): runs took 117–237 s (15–20 s alone); 16 of 60 failed, every one at the 240 s bound (8 "never ended", 8 piped runs timed out), no other error, no `ENOTEMPTY`; 4 project folders leaked — a timed-out piped test never reached its `finally`, its runner refilling the folder after removal. Fixed: afterEach kills and awaits every piped group (a forced 6 s timeout leaves nothing). Rerun on the final code, `--repeat-each=2 --workers=4` + 12 `yes`: 12/12 passed in 12.1 m, no folder, socket, tmux server or burner left. Gates: `test:unit` 4,496 passed, 10 skipped; tmux spec ×5 macOS (tmux 3.8), ×3 `p71a-audit-b` (`CI=true`, tmux 3.4). | load harness, 2026-11-01 |
  | 7V57 | Playwright 1.63 `--grep` (`forceRegExp`, `lib/util.js`): a value matching `^\/(.*)\/([gi]*)$` is that pattern with those flags, anything else `gi` (case-insensitive); `.` there crosses no line terminator, so a raw newline in a title breaks the slash form. It is tested against `_grepTitleWithTags()` — `""`, the project, then the file and each describe each followed by its tags, the test's title, its tags, joined by spaces (an untitled describe left out, as from `titlePath()`); a tag is `@` and no space up to the next. Corrected by 7V62: the first claim, "a title cannot be anchored, only matched as a substring", was wrong — the end and the file/describes can be. Dependency projects are built from the unfiltered suites (`createRootSuite`), so a `--grep` rerun still runs the setups. Failure attachments are named `screenshot` (`SnapshotRecorder`), `trace` (`workerProcessEntry.js`) and `video`. | `node_modules/playwright` 1.63 source |
  | 7V58 | 7.2c decision: a title's controls (C0/C1), format characters (bidi overrides, ZWJ, tags), line/paragraph separators, lone surrogates and combining marks past the eighth in a run go into the `--grep` as `\uXXXX` regex escapes (per UTF-16 unit; no `u` flag, so an astral one matches as its two units) — the command is then visible characters only and still selects the test. Chosen over ANSI-C `$'…'` quoting (not POSIX `sh`; the regex escape works in every shell and through npm) and over refusing (a ZWJ emoji, a common case, would lose its command). A zip path or ref with such a character cannot be escaped: the command is refused, as it is past 2,000 characters or when it, the raw title or the pin quotes a credential's shape (with today's `redactSecrets` shapes the command alone already shows each — the value check is a guard against a future shape the escapes could break; its mutant survives as equivalent). `sh`, `bash`, `zsh` and `dash` each read every command word back byte-identical for 14 hostile titles (`failure-block.spec.ts`). | unit specs, 2026-11-01 |
  | 7V59 | `failure-block.run.spec.ts` (real `bddgen`/runner/reporters, placeholder cell): a secret typed with `enterSecret` and a control with `fill()`, then a failing check — neither appears on stdout or stderr, the control does appear in Allure's results (its `Fill "…"` step), the block names `When a secret and a control are typed, then a check fails`; a title with metacharacters, quotes, `$`, a backtick, a backslash, ZWJ emoji, CJK, an SGR sequence and a bidi override prints plain, and its `Rerun` word, read back by `/bin/sh` and given to `--list`, selects exactly that scenario (a near-miss sharing its prefix is not). It found a pre-existing leak: the summary printed the report folder raw, so a `REPORT_ROOT` holding an escape reached the terminal — now plain (`displayText`). `E2E_RUN_NAME` with an OSC and an `ED` sequence: no escape on stdout or stderr. | run spec, 2026-11-01 |
  | 7V60 | Playwright names a test's output folder from a cut title: a ZWJ emoji was cut mid-pair, and Node writes the lone surrogate as U+FFFD on disk (`fs.mkdirSync` measured), so the block's `Trace` path, made well-formed, is the folder's real name. | run spec + Node probe, 2026-11-01 |
  | 7V61 | 7.2c gates: `typecheck`, `lint`, `format:check` green; `test:unit` 4,581 passed, 10 skipped (a second run: 4,580 and `orchestrator/cli.spec.ts:328` timed out at 30 s under the full suite, passing alone, 40/40 — the Phase 10 flake). Mutants on `failure-block.ts`: no `\uXXXX` escaping killed (12 specs), `pluginPin` ignoring the setup's source killed; the raw-value credential check survives as equivalent (7V58). | 2026-11-01 |
  | 7V62 | 7.2c audit A-F2, reproduced (`probeD`: `--grep='/Create a backup/'` listed it, `Create a backup encrypted` and `Untagged Create a backup`) and fixed: `grepPattern(title, above)` — `above` is `titlePath()` between the project and the title (the generated spec's path, the Feature, any Rule/Outline) — writes ` <file>(?: @\S+)* <Feature>(?: @\S+)* … <title>(?: @\S+)*$`, each title escaped; the shape is Playwright's (`_collectGrepTitlePath`, `_grepTitleWithTags`, `lib/common/index.js`; playwright-bdd tags the test with its Feature's and its own tags). Anchoring the end alone still let `Untagged …` in, and the Feature alone `Old Backups` (unit); the file closes both. After: each of the three lists only itself; `failure-block.run.spec.ts` shows 3 by substring, 1 by the printed rerun. The generated path is per cell (`.features-gen/<product>/<cell>/`), so a run of every cell's pattern selects its test under `E2E_CELL` (measured, 1 of 1). | probes + source, 2026-11-01 |
  | 7V63 | 7.2c audit A-F1, reproduced (auth setup failing its preflight: `Step  Worker Cleanup › Fixture "browser" · running when the attempt ended`; tree: Before Hooks, After Hooks, Worker Cleanup, none errored) and fixed: `lastBegun` never takes `After Hooks`/`Worker Cleanup`, and takes a Before hook only if it never ended — Playwright leaves a step a crashed worker never ended at `duration: -1` (`StepLike.duration`; `_onStepBegin`/`_onStepEnd`, `lib/runner/index.js`); else no step, and `laterHookAside` then blames none (the first error stands, not the later hook's). After: no `Step` line. | probe + source, 2026-11-01 |
  | 7V64 | 7.2c audit A-F7/F8/F9, reproduced and fixed. F8: `ghp_…<ZWSP>…` showed `***j0K1l2M3n4O5p6Q7r8` — masked before `plain` joined it, so masking again could not help; `cleanMessage` now drops format characters first (`withoutFormat`, `text.ts`), which fixes every consumer (block, summary `Setup`/`Error`, stream); every other field was already plain-then-mask (`displayText`, `suiteLine`). F9: a credential-shaped title left 27 of 36 token characters in the `Trace` path; now each kind prints `not shown: its folder is named after a title shaped like a credential`. F7: plain printed `›` in hook paths and `…` from `cut`; `FailedStep.path` is joined, and `cut` ends, with the palette's glyphs. Decision: under plain the summary's own glyphs are ASCII and the phrases shared with the reports keep their `·` (README, `execution-model.md`, TSDoc now say so). After: a plain run of `probeA` prints no non-ASCII line. | probes, 2026-11-01 |
  | 7V65 | 7.2c audit A-F3/F4/F5/F6 and U1, reproduced on the audited copy and fixed. F3: `E2E_PLUGIN_VERSION=1.0` was dropped; F4: a `release:3.17.4` record reran `release:latest-stable`; F6: a run of every cell printed `E2E_PLUGIN_REF=feature/x npm run …` — no cell, and a ref that sweep had ignored. Now the pin takes the documented form (`plugin-artifacts.md` Pinning, `pin.ts`): `release:<tag>`, else `commit:<sha>` + `E2E_PLUGIN_VERSION=<the zip's version>`; with no record, the operator's zip/ref/version only in a targeted run; the cell is the test's own. U1: the resolver hands `E2E_PLUGIN_REF` to APVM unparsed (`request.ts` tests only `release:`), so a bare SHA relied on APVM's guess; no longer printed. F5: zsh read `X=/builds/v1:=ls.zip` as `ls.zip not found` and `X==ls` as `/bin/ls` (sh, bash, dash literal); `=` is no longer shell-safe — 8 values (`=ls`, `a:~/b`, `release:…`, `pro@nginx`, …) read back byte-identical through `printenv` in all four. | probes + shells, 2026-11-01 |
  | 7V66 | 7.2c audit B, fixed: B-F1 the live-block reporter case checks `Feature` and `Error` exactly again; B-F2 `problems()` requires the failing scenario's `Rerun` once and whole (a doubled-line mutant fails the tmux spec); B-F3 S4, F16, F28 (`abcdef1 x`, uppercase, 41 hex), R6, S14 (`COLUMNS` 100/61 through `RunSummaryReporter`), S3, F9 (exactly 2,000 printed, 2,001 refused), D1, S8 now killed; R5/F12/F14 equivalent, left. Mutation pass on the fixes: 42 mutants (pattern 7, pin 9, quoting 3, step choice 5, reporter 4, withheld/mask 2, glyphs 4, B-F3 8) — 41 killed by unit specs; Q2 (the pin values' own credential check) survives, equivalent as 7V58's; run level, the anchoring and file mutants (G1, G2, G4, R3) and the dropped version (R4) fail the run specs. Every file restored (SHA-256). | scratch harness, 2026-11-01 |
  | 7V67 | 7.2c fix gates: `typecheck`, `lint`, `format:check` green; `test:unit` 4,608 passed, 10 skipped (27 more tests than 7V61), first run, no flake; the live-block tmux spec 6/6 (macOS, tmux). No plan reference in code. | 2026-11-01 |
  | 7V68 | 7.3b decisions. "Continuation lines" = a TTY line wider than the terminal (20–120) wrapped at its spaces under the message, a word never broken (a path or command stays copyable; the terminal wraps it); "blocks" = an empty line before a run's outcome line and each escalation line, nothing else. Task colours are `Palette.series` (cyan, magenta, blue and their bright forms, cycled), shared by the scope and the table's TASK cell; other scopes unstyled. `--dry-run`, `--help` and refusals stay unstyled: their exact text is pinned, they print before the start's work through Node's blocking default, and styling them adds nothing a reader needs. The screen is created only for a TTY (pipe: the logger's own plain path, untouched); its region opens with the first table, so lines before it are `\n`-ended as before; a failed write (line or draw) makes the terminal gone for both. The orchestrator's own stdout/stderr writes are captured while the table shows (7V74; first shipped uncaptured, which left table rows for good, not "until the next draw"). | design, 2026-11-01 |
  | 7V69 | Piped stdout unchanged: the real CLI over the fake suite (`swap-start`), 5 modes (`--once`, one SIGINT, one SIGTERM, a config error, `--dry-run`) on acb8432 and on 7.3b — stdout, stderr, exit code, `orchestrator.log`, `run.json`, `run-finished.json`, `run.log`: 27 files byte-identical once times, PIDs, durations and paths are normalised; no `\x1b` in any piped output or log. | `bytes.sh` harness, 2026-11-01 |
  | 7V70 | `status/table.tmux.spec.ts` (real CLI, two tasks writing results every 0.4–1 s, tmux 3.8 macOS): `--once` with a narrowing 100×16→70×12 mid-run (rows stay whole: it never exercised the resize erase — 7V78 adds a splitting one), one Ctrl-C (drain), three (kill, runners ignoring drain and SIGINT), SIGTERM — each: ≥ 3 counts of a run seen, `1 flaky` counted, 0 table lines in the joined history, every `orchestrator.log` line once and whole, the exit line last; ×3 green, ~8 s. A mutant that never closes the region left the screen identical (the exit line's print clears the block, its repaint never comes before `process.exit`): the spec also checks the exit line's raw bytes end `\r\n` (pty `onlcr` of a `\n`), not the region's `\r\r\n` — killed. The pane's shell must `trap : INT`: a Ctrl-C reaches the whole foreground group and otherwise ended the shell (no exit line, server gone). Linux (tmux 3.4) is CI's. | tmux runs + mutant, 2026-11-01 |
  | 7V71 | `log.ts` before: `toTerminal` compared `writableLength` itself, so a getter that throws threw out of `Logger.line`, and a destroyed stream was written. After (`writeSafely`/`backlogBytes`): both make the terminal gone once — `terminal gone (its backlog cannot be read)`, `(unknown error)` — never thrown; a line spanning several terminal lines is skipped and counted as one. | `log.spec.ts`, 2026-11-01 |
  | 7V72 | Soak, `ORCHESTRATOR_SOAK_RUNS=50` ×2 (capped, uncapped) with the soak's stdout a 100×30 TTY stand-in, the real screen drawing (≥ 2 tables checked): listeners 13, resources 6, timers 2, fds 22 at every sample; pruning 0.49 ms a folder. | `npm run orchestrator:soak`, 2026-11-01 |
  | 7V73 | 7.3b gates: `typecheck`, `lint`, `format:check` green; `test:unit` 4,663 passed, 10 skipped (55 more than 7V67), one failure: `orchestrator/cli.spec.ts:328` timed out at 30 s under the full suite and passed alone ×5 (the Phase 10 flake). No plan reference in code. | 2026-11-01 |
  | 7V74 | Audit A-F1, reproduced (tmux 100×30, `emitWarning` mid-run): the warning moved the cursor below the table, so the next clear started from the wrong row — header and row, then a second header, stayed in screen and history after `exiting`. Fixed: while the table shows, `screen.ts` captures stdout's `write` and, when a TTY, stderr's (`stdio-capture.ts`, admitted to `suite-imports.json` once `import-boundary.spec.ts` passed; the region writes through `bypassWriter`), each line `safeBlock`ed (shape and config secrets, controls dropped) above the table; restored on close and when the terminal is gone. After: both warnings above the table, 0 table lines. Not logged to `orchestrator.log` (it never was). Soak on a TTY: listeners 15 flat (13 + the two end listeners), pipe 13. | tmux repro, `screen.spec.ts`, `table.tmux.spec.ts`, 2026-11-01 |
  | 7V75 | Audit A-F3, reproduced: an uncaught exception or rejection left header and row, the stack over them. Fixed: while the table shows, `uncaughtExceptionMonitor` (runs before Node prints the error; changes neither handling nor exit code) and `exit` close the screen synchronously — rows cleared, streams put back. After: no table line, stack whole, exit 1 (throw and rejection). Listeners are a seam (`ScreenOptions.process`), removed on close and on a gone terminal. | tmux repro, specs, 2026-11-01 |
  | 7V76 | Audit A-F2, reproduced: Enter mid-run leaves one header line for good (tty echo moves the cursor). Documented in the guide beside SIGKILL (`clear`/`reset`); echo not disabled — changing the tty's mode is riskier than the residue, and a SIGKILL would leave it off. U2 (narrowing below the table's width leaves a stale row, 7V24's accepted residue) documented likewise. | tmux repro, 2026-11-01 |
  | 7V77 | U1, reproduced: `wrapWords("aaaaa  bbbb", 5)` → `["aaaaa", " bbbb"]`, `wrapWords("aaaa bbbb ", 4)` → a trailing `""`. Now empty words are dropped when a text is cut (a text that fits is kept as is): `["aaaaa", "bbbb"]`, `["aaaa", "bbbb"]`. Spec changed on purpose: "keeps every character" compared `lines.join(" ")` with a double-spaced text; it now checks every word, in order. | `line-style.spec.ts`, 2026-11-01 |
  | 7V78 | Audit B-F1: narrowing 100×16→40 or →50 columns leaves 1 table line with the code and with mutant S10 (no `region.resize()`) alike, ×4/×3 — the table renders for the current width and a deferred clear covers the same rows. →16 columns (below the region's 20-column minimum) splits every row: the code leaves 2 (the old table's top rows, 7V24), S10 6 (stale geometry: it keeps drawing), ×3 each. New tmux test bounds it at 2, no log line lost or doubled; `screen.spec.ts` asserts `resetBytes(3)` right after `resize`. Also added: palette cycling index 7 = 1 (P5), show after close before any draw (S5), the 20-column boundary (LS5), the start's clock/stderr/secrets handed to the screen (ST12), a screen close that throws (ST10). Mutants killed: capture removed, end hooks removed, release on failure removed, mask removed, S10, S5, U1, LS5, P5, ST12, stderr not passed, ST10 (12/12). | measurements + mutation, 2026-11-01 |
  | 7V79 | Audit B-F2: the soak runs the capped test on a TTY and on a pipe (≥ 2 tables on the TTY; 0 tables and every line written on the pipe), 50 runs each: listeners 15/13, resources 6, timers 2, fds 22 at every sample; uncapped 0.507 ms a folder. B-F3: the root cause was `stop()` reading `pgid` at the record's top level — it is `process.pgid`, so no run group was ever killed by it; a crash test leaked its folder every time. Now: SIGSTOP the pane's group, kill the recorded groups and the stopped command's unrecorded children's (`ps`), wait, kill the server, remove (retried; a failure throws). Forced 4.5 s and 6.5 s test timeouts (10 failed): 0 folders, 0 processes left. The started line is waited for up to 90 s (`START_WAIT_MS`), later waits timed from it; test timeout 180 s. Under 12 busy loops on 12 cores: 7/7 ×2 (1.2 min, 53 s). | runs, 2026-11-01 |
  | 7V80 | Audit-fix gates: `typecheck`, `lint`, `format:check` green; `test:unit` 4,679 passed, 11 skipped, 0 failed (16 more than 7V73); `table.tmux.spec.ts` 7/7 ×3 (~8 s); piped output vs acb8432 (`bytes.sh`, 27 files) identical but for milliseconds and durations, no `\x1b`. No plan reference in code. | 2026-11-01 |

- Docs, by sub-phase: 7.1 — AGENTS' tree, `package.json`/lock, `suite-imports.json`, the boundary spec;
  7.2b (done) — `execution-model.md` (the live block, the stdio wrap, when it is off), AGENTS "Watching a run" and tree; 7.2a (done) — `reporting.ts` and `cell-notice.ts` TSDoc, `execution-model.md` (reporters, the cell
  line, `[run]`, `E2E_OUTPUT`), AGENTS "Watching a run" and tree, `.env.example` and `configuration.md`'s
  table row for `E2E_OUTPUT` (7.4b adds the prose); 7.2c (done) — `run-summary.ts`'s example, README "Reporting",
  `execution-model.md` (failure blocks, the summary), AGENTS "Watching a run" and tree; 7.3 (done) —
  `docs/guides/orchestrator.md` (TTY vs piped, the table), `log.ts` TSDoc, the 0.5 plan's §4.9/§4.11/
  §5/§7.1, AGENTS' orchestrator entry, `ci.yml`'s tmux comments; 7.4b — `configuration.md`, `.env.example`, README "Environment",
  AGENTS' env accessors, and that an orchestrator's runs are plain (its env allowlist carries no
  `E2E_OUTPUT`). Phase 11 rebases its `configuration.md`/`.env.example` edits on 7.4b.
- Specs updated deliberately (never weakened): `src/common/config/reporting.spec.ts` (`list` →
  terminal reporter; 7.2a: the summary gets `output` too), `auth/secrets.run.spec.ts` (7.2a: `list`'s "4 failed" → four `✘ failed` lines; the
  canaries now also checked absent from the terminal), `run-summary.spec.ts` (7.2c: the styler by token —
  `<bold,green>` became `<command><ok>`; plain is ASCII too, so only the lines after the header match
  auto's; a pruned warning is the `warn` token; 7V66: a failure's step is its path, an array),
  `terminal.reporter.spec.ts` (7.2c: a final failure's `  Error: …` line became its block; 7V62/7V65: each
  `Rerun` holds the anchored pattern and `commit:<sha>`, a run of every cell names the test's cell and
  drops the operator's override, one title in two features gives two commands), `results.spec.ts`
  (7V63: a crash in a Before hook gives the hook Playwright's `duration: -1` — an ended hook proves
  nothing), `live-block.run.spec.ts` (7.2c: the block's and `Failed` lines are
  permanent lines; 7V66: the `Rerun` line once and whole), `results-stream.run.spec.ts`
  (summary marker, `--list`; 7.2a adds the terminal lines, live worker output and its `▸` lines, masked
  escape-inflated credentials, SIGKILL, `--global-timeout`, `PW_TEST_REPORTER` (`dot`, `junit`, `null`),
  an early-closed pipe, `--reporter`, `FORCE_COLOR`, `E2E_OUTPUT`; `runCell` takes an options object; 7.2c:
  the final `  Error: boom (attempt 2)` became the block's `Error` line, the block and its rerun checked
  (7V62: its anchored pattern),
  and plain mode's summary is checked ASCII and colourless instead of being skipped), `orchestrator/log.spec.ts` (7.3b: cases
  added — the screen's path, an unreadable backlog; none changed), `start.spec.ts` (7.3b: the screen's
  lifecycle added), `elevation-report.spec.ts` (plain thrown text, styled print),
  `orchestrator/soak.spec.ts` (7.3b: its stdout stand-in is a TTY, so the real screen draws the
  table throughout; a drawn-table check added, the flatness checks unchanged),
  `__fixtures__/fake-start.ts` (7.3b: a second cell, `FAKE_RESULTS_MS`, `FAKE_IGNORE_STOPS`; its
  default runs unchanged).
- Out: the dashboard's UI, a web progress view, log colouring, CI annotations, interactive prompts,
  animations/spinners in CI, and changing `results.jsonl` or events.
- Effort: 11–14 engineer-days over ten small slices, medium difficulty; no dependency on Phase 6, so
  it runs before 6H.

Phase 8 — CI on real cells (dropped). It planned a CI matrix of real cells (one job per product ×
cell). Real-cell runs, PRs included, belong to the orchestrator; CI keeps its quality, unit and
`@noauth` smoke jobs (`.github/workflows/ci.yml`).

Phase 9 — Orchestrator (moved): a long-running service with phases of its own. Report pruning (done
there as 0F), the pre-warm call and the Free/Pro single build moved with it.

Phase 10 — Cleanup & validation (open).

- A `deps:check` script (e.g. `depcheck`) catching unused dependencies.
- No dependency on §5's drop list reappears.
- `lint`, `typecheck` and `format:check` green; the reports generate.
- Remove every mention of plan phases from code comments (AGENTS.md forbids citing plans in code).
- Deferred: `orchestrator/cli.spec.ts`'s child-process tests are flaky under load: `:564` ("npm run
  orchestrator -- start --dry-run is the dry run…") timed out once at 30 s on CI run 40700750051
  (2026-10-28, shard 2/2), passing in 1.3 s on rerun; `:328` timed out once under the full local suite
  (2026-11-01, 7V50), passing alone. Investigate them all (npm/Node start-up under load, a missing
  timeout on the child, or a hang) and fix.
- Deferred (7.2c audit): `Step … running when the attempt ended` names the body's last step begun
  when no step carries the error; a body that throws outside any step *after* one ended (no setup
  does today: the auth setup has no step, the artifacts setup's only one is `test.attach`) would
  name that ended step. Tell it by the attempt's status (`timedOut`) or the step's `duration`, then
  drop the claim. Also unconfirmed (audit A, U2): a terminal's copy may turn U+00A0, Hangul fillers,
  unassigned or private-use characters into others, so a pasted `--grep` would select nothing;
  measure on macOS Terminal, iTerm2 and tmux, and escape them like format characters if so.
  `failure-block.run.spec.ts` and `results-stream.run.spec.ts` time out under heavy load (12 `yes`
  on 12 cores: 90 s child timeouts; audit B, U1) — the same family as the `cli.spec.ts` flakes above.
- Deferred (7.2c): a failure's rerun command pins only the plugin under test (`E2E_PLUGIN_REF`/
  `E2E_PLUGIN_ZIP`); a product with a `previous` role (WP Rocket) reruns against that role's default,
  which a moving `release:latest-stable` may change. Pin `E2E_PREVIOUS_REF` (`release:<tag>`, or
  `commit:<sha>` with `E2E_PREVIOUS_VERSION`) or the zip from the artifacts setup's `previous` record
  the same way (`pluginPin`), once comparison tests exist.
- Deferred (7.3b): the table is cleared before `bus.settle()` by the loops' own `stopStatus` and again
  before `exiting`; no spec tells the first from the second (mutant ST1 survives) — add one with a bus
  whose settle waits, if that order ever matters. Keys typed mid-run (Enter) echo below the table and
  leave a stale row; a narrowing below the table's width leaves the old table's top rows — both
  documented in the guide, not fixed (7V76). `table.tmux.spec.ts` covers one
  and three Ctrl-Cs, not two alone: a runner that ignores SIGINT waits for the 4-minute interrupt
  budget; add it once the fake start takes a shorter budget. Its Linux run (tmux 3.4) is CI's first.
- Deferred: `src/common/wp/exec.ssh.spec.ts` is flaky (~0.7 % of runs): ssh2 1.17.0's
  `generateKeyPairSync("ed25519")` yields a key its own `parseKey` rejects 0.34 % of the time
  (68/20,000). Regenerate until `parseKey` accepts it, or commit fixed test keys.

Phase 11 — Shared SSH server profiles (open; scheduled after Phase 7). Configuration and transport;
depends on nothing (independent of Phase 6 and Phase 10; may run beside 7.2–7.4 or 6H). Stack:
existing TypeScript on Node 24, `node-ssh` as already used, the repo's Playwright unit runner, and
`node:fs`/`node:path`; no new dependency.

- Goal: stop repeating what belongs to the server. A site's `transport` still says `"mode": "ssh"`,
  and `rootDir` stays required on every site, but `host`, `username`, `privateKeyPath` and `port`
  may come from a named profile, the `default` profile, or environment variables. A field the site
  declares wins. Existing sites files that declare everything keep loading unchanged.
- Today: every SSH site repeats `host`, `username` and `privateKeyPath` in its sites file, and
  [`sites.ts`](../../src/common/config/sites.ts) requires all three; `port` is not configurable
  (node-ssh's 22), and `rootDir` is the only transport path a site must give. `loadSites` is shared
  by manual runs, the healthcheck and the orchestrator, so a file-based default reaches all three;
  the orchestrator sets `E2E_LOAD_DOTENV=false`, so `.env` alone cannot reach its runs.
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
  `elevate` or `fileOwner`.
- Site selector: `transport.profile` is an optional safe single token
  (`[a-z][a-z0-9_-]{0,31}`, 1–32 characters); omitted selects `default` when present. A named
  profile that is not defined is a hard error, never a silent fallback to `default`. Site fields
  win over the profile, so a one-off host or key stays possible.
- Precedence, field by field: site value → selected profile, merged over `default` → `default` →
  env → error (`port` falls back to 22). Blank env is unset; a malformed env value is an error only
  when that field is needed. A blank site field is refused, never treated as absent.
- Env fallback: `E2E_SSH_HOST`, `E2E_SSH_USERNAME`, `E2E_SSH_PRIVATE_KEY_PATH`, `E2E_SSH_PORT`.
  Add all four to the orchestrator's `INHERITED_VARIABLES`, so a run gets them when the operator
  uses env instead of the file; nothing else about the run contract changes.
- Required per site: `mode` (`"ssh"`; never inferred) and `rootDir`; `baseURL` and the WordPress
  login stay per site too. `stagingDir`, `elevate` and `fileOwner` stay per-site (staging keeps its
  existing `E2E_SITE_STAGING_DIR` fallback): they are policy/ownership, not connection details.
- Port: `SshTransport.port` is a resolved number (1–65535, default 22). [`exec.ts`](../../src/common/wp/exec.ts)
  passes it to node-ssh and includes it in `connectionKey`/`targetKey`; [`preflight.ts`](../../src/common/setup/preflight.ts)
  names it in the connection hint and adds `-p` to the sample `ssh` command. Out: passphrases and
  encrypted keys, `ssh-agent`, `ProxyJump`/`ProxyCommand`, `~/.ssh/config` discovery, key contents,
  and any non-SSH transport change.
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
    shared `describeValue`/string/number helpers to a small module if needed to avoid a
    `sites.ts` ↔ `ssh-servers.ts` cycle; re-export `describeValue` from `sites.ts` for its specs.
  - `types.ts`: `SshTransport` gains `port: number`; `profile` is config-only and dropped after
    resolution.
  - `exec.ts`, `preflight.ts`: port end-to-end.
  - `orchestrator/runs/environment.ts`: the four env names in `INHERITED_VARIABLES`.
- Tests:
  - `ssh-servers.spec.ts`: missing/empty/malformed file; default; inheritance; complete profile;
    unknown profile; unknown key; wrong types; blank strings; port bounds; profile-name bounds; no
    quoted values; precedence for every field; env fallback, blank and malformed env; site
    override; `rootDir`/`stagingDir`/`elevate`/`fileOwner` refused in a profile.
  - `sites.spec.ts`: `{ mode, rootDir }` resolves; full transports unchanged (plus the default port
    once 11.2 lands); `profile` dropped; a missing field names the site and env var; a sibling
    `ssh.servers.json` in the temp config dir is read; overlays and the example fallback unaffected.
  - `exec.spec.ts`/`exec.ssh.spec.ts`: port reaches node-ssh; two ports do not share a pooled
    connection; preflight hints use the port. Update every fixture that constructs an `SshTransport`
    (the orchestrator's included) with `port: 22` once the field is required.
  - `orchestrator/runs/environment.spec.ts`: the four vars pass when set; other vars still do not.
  - Live: a cell configured with only `mode` + `rootDir` (profile `default`) passes
    `npm run healthcheck` and one `@noauth`/`@smoke` run; the orchestrator's once path passes the
    same resolved transport.
- Docs: [configuration.md](../guides/configuration.md) (new "SSH server profiles" section,
  precedence table, env fallback, `rootDir` stays per site),
  [wordpress-automation.md](../architecture/wordpress-automation.md) (transport fields, port,
  cache), `.env.example`, `ssh.servers.example.json`, README's sites-files paragraph, AGENTS.md's
  configuration mechanism, the [orchestrator guide](../guides/orchestrator.md) (profiles on the
  runner; `.env` still not reaching runs). Keep `sites.example.json` self-contained (full
  transports) so a fresh checkout loads without a global file; document profile-only sites in
  configuration.md. Code never cites a plan phase.
- Definition of done: a site with only `mode` + `rootDir` passes the healthcheck and a real run; an
  existing full transport behaves identically (same endpoint, port 22); a missing field fails at
  load naming the fix; an orchestrator run gets env-only profiles; all gates and docs are green.
- Sub-phases:

  | #    | Delivers                                                                                                         | Depends     | Parallel | Effort     | Done when                                                                                                                                                                  |
  | ---- | ---------------------------------------------------------------------------------------------------------------- | ----------- | -------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | 11.1 | `ssh-servers.ts`, sibling file, optional `host`/`username`/`privateKeyPath`, `profile` selector; no port yet.   | —           | —        | S/M, 1–2 d | A `{ mode, rootDir }` site resolves from `default`; every precedence and error case is a unit test; existing full transports load identically.                              |
  | 11.2 | `port` end-to-end: site/profile, `SshTransport`, exec, cache key, preflight.                                    | 11.1        | —        | S, 0.5 d   | Profile `port: 2222` reaches node-ssh; two ports do not share a connection; hints show `-p`.                                                                                |
  | 11.3 | Env fallback (`E2E_SSH_*`) and orchestrator allowlist.                                                          | 11.1, 11.2  | —        | S, 0.5 d   | Without a file, env-only resolves; a run started by the orchestrator receives the four vars when set; blank/malformed cases covered.                                        |
  | 11.4 | Docs, examples, live check, full gates.                                                                         | 11.1–11.3   | —        | S, 0.5–1 d | The live cell passes; docs and examples describe the shipped behaviour; typecheck, lint, format and unit tests green.                                                       |

- Out: a repo-wide profile file, profiles for `local`/`docker`, global
  `rootDir`/`stagingDir`/`elevate`/`fileOwner`, passphrases/agents/jump hosts, auto-importing
  `~/.ssh/config`, and changing the orchestrator config schema.
- Effort: 2–4 engineer-days, low/medium difficulty; no dependency on Phase 6 or Phase 10, so it can
  start beside 7.2–7.4 and finish before 6H.

## 4. Feature-parity matrix

Baseline capability → target design → status. WP Rocket's port starts from the pending rows.

1. WP-CLI exec (local/Docker/SSH) → `wp/exec.ts`: execa (local, `docker exec`), node-ssh (remote),
   `exitCode` on every mode. Built.
2. Server/env config → typed env accessors; the transport union (default `ssh`); per-product config
   and sites files (§2.5). Built, except the `services` ← `overrides` merge (open, §2.5).
3. Plugin/theme lifecycle → WP-CLI wrappers and UI page objects; idempotent cleanup, asserted
   removal under test, distinct errors (§2.10). Plugins built; themes not.
4. DB ops → `wp db query` through exec. `dbQuery` built; the baseline's `seedData`/`checkData` come
   with WP Rocket.
5. Visual regression → the A/B check (§2.12). Built; scenarios come with WP Rocket.
6. Settings export/import diff → `expect` deep-equality; `microdiff` if a diff object is needed.
   Pending (WP Rocket).
7. Auth (login/logout) → per-site `storageState`, per-cell setup project, `@noauth` (§2.7). Built;
   multi-user pending.
8. POM (sections/selectors) → plain POM fixtures, thin steps, edition-divergent pages through a
   factory (§2.11). Built.
9. Lifecycle hooks → playwright-bdd `Before`/`After`/`BeforeAll`/`AfterAll` with `{ tags }`. Built.
10. Health check / open report / archiving → `styleText`; `npm run report`; a CI artifact upload or
    a small `fs` script. Health check and opener built; archiving not assessed.
11. `debug.log` scan → tag-scoped hooks, the log attached on failure. Built (`@plugin`).
12. Local WP env → `docker` = Apache + Nginx; `local` = any server; `@wordpress/env` optional
    (§2.9). Built.
13. Execution / parallelism (new) → (product × cell) run units, site pools, per-cell reports (§2.1).
    Built; the orchestrator is in progress.
14. Plugin editions (new) → one product, per-cell edition selecting package, scenarios and POM
    branch (§2.6). Built.
15. Credential safety (new) → pools through an in-process registry, never report-serialised metadata
    (§2.2). Built.
16. Plugin zip selection (new; the baseline's `new_release` / `previous_stable` zips in
    `utils/plugin-builder.ts`) → per-run `plugin`/`previous` roles built from any git ref through
    APVM or provided, identity-verified per product and edition, staged onto `ssh`/`docker` sites
    (§7). Built.

## 5. Dependency disposition

The baseline declares `axios`, `boxen`, `node-zip`, direct `ssh2` and
`multiple-cucumber-html-reporter` but never imports them. Its "beautiful report" is the stock
Cucumber HTML formatter: media-rich on failure (base64 screenshot and video) but static — no trace
viewer, no trends. Most other libraries have modern, often built-in replacements.

- Drop, never carry over (Phase 10 checks it): `axios`, `@types/axios` (deprecated stub), `boxen`,
  `node-zip`, direct `ssh2` and `@types/ssh2` (ssh2 stays a transitive dependency of node-ssh),
  `multiple-cucumber-html-reporter`, `@types/cucumber` (deprecated stub), `eslint-plugin-es5`, and
  the duplicate `playwright` (redundant with `@playwright/test`). Proven unused by repo-wide
  inspection.
- Replace:
  - `backstopjs` (+ types, `backstop.json`) → the A/B check over pixelmatch + pngjs (§2.12).
  - `shelljs` (+ types) → execa: promise-based, array args (no injection), structured errors, ESM.
  - `chalk` → `node:util` `styleText`: no dependency; emits no escapes off a TTY and honours
    `NO_COLOR` (verified on Node 24).
  - Add `string-width@8.3.0` (ESM, Node ≥ 20) as a dev dependency, like every package here (`npm ci`
    installs them for runs): the terminal's width cuts need real display columns for emoji, CJK and
    combining marks. No `slice-ansi`/`wrap-ansi` — layout runs on plain text and permanent lines let
    the terminal wrap; `Intl.Segmenter` gives the grapheme boundaries for the cut.
  - `ts-node` → `tsx` for the root scripts, the runner's own transpile for tests (the Cucumber CLI
    is gone).
  - `json-diff` (+ types) → `expect` deep-equality; `microdiff` if a diff object is needed.
  - `dotenv` → `node:util` `parseEnv`, the parser of `process.loadEnvFile()` (`config/dotenv.ts`).
- Not needed: the standalone Cucumber runner (playwright-bdd bundles the reporter);
  `@playwright/browser-chromium` (below); a pattern-matching library (transport dispatch is a native
  discriminated `switch` with a fail-fast `default`); a validation library for the suite's own
  config (hand-rolled; zod serves only the orchestrator).
- Optional, not added: `ts-pattern`, `microdiff`, `http-server` (serving a mode-B report),
  `@wordpress/env`.
- `adm-zip` 0.6.0 bundles its own types (no `@types/adm-zip`) and patches CVE-2026-39244; its
  breaking changes (`extractEntryTo`, Node 12) do not touch the read-only use. `apvm-napi`: §7.1.
- Browsers: `postinstall` runs `playwright install chromium`, so a fresh `npm install` is runnable;
  the committed `.npmrc` sets `ignore-scripts=false` so the hook runs where scripts are disabled
  globally (`npm run setup` reruns it). `@playwright/browser-chromium` is not used: the postinstall
  always matches the installed Playwright, one version fewer to keep in step. The runner uses the
  bundled Chromium (`devices["Desktop Chrome"]`, no `channel`).

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

Phases 1–5 done (2026-07-14 to 2026-07-28) and audited. As built:
[plugin-artifacts.md](../architecture/plugin-artifacts.md) (roles, manifest, request model,
resolution, identity preflight, consumption, pre-warm, pinning),
[configuration.md](../guides/configuration.md#plugin-artifacts-build--verify) (the six `E2E_*`
variables and their rules) and [wordpress-automation.md](../architecture/wordpress-automation.md)
("Site staging & file transfer"). Kept here: the facts the design rests on, decisions and rejected
alternatives, limits, open obligations.

### 7.1 Verified foundations

APVM, measured at `develop` (npm `3.0.0`); pinned as
`github:wp-media/automation-plugin-version-manager#cli/v3.0.0`, the `cli/vX.Y.Z` tag pattern:

- Install: a plain git dependency with prebuilt `.node` binaries committed for darwin-arm64/x64,
  linux-x64/arm64-gnu and win32-x64-msvc — no musl, no Rust, no postinstall; engines
  `node >=22.22.1`. Its `prepare: husky` is blocked by the repo's `allowScripts` gate; `.npmrc`'s
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
- Cache: `~/.apvm/cache` by default; `APVM_CACHE_DIR` overrides it for every instance — never set
  here. Keyed by resolved commit and version, so keyword refs re-resolve, then hit the cache. Its
  concurrency and per-variant layout: the orchestrator plan (0A.5, the Free/Pro single build).
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

Identity — the slug, main file and `Plugin Name:` expectations are in plugin-artifacts.md; what
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
- node-ssh interpolates `exec` arguments into a shell string, escaped by `shell-escape`. Fuzzed with
  4000 random arguments (quotes, `$()`, backticks, newlines, `;`, `|`, `&`) through `/bin/sh`: no
  argv mismatch, except that an empty-string argument disappears — unreachable today, since every
  value is a literal or refused when empty. Only the arguments are escaped, never the command, so no
  dynamic value may sit in the program position.

### 7.2 Decisions and rejected alternatives

- Variable names `E2E_PLUGIN_*` / `E2E_PREVIOUS_*` (`_REF`, `_ZIP`, `_VERSION`): `E2E_` scopes them
  without colliding with generic or CI-reserved names; the role words match how the artifacts are
  discussed. Rejected: `E2E_CANDIDATE_*` / `E2E_BASELINE_*` ("baseline" already names the legacy
  repo, and longer without being clearer); `E2E_TARGET_*` / `E2E_REFERENCE_*` ("target" is
  overloaded, `E2E_REFERENCE_REF` stutters); the baseline's `new_release` / `previous_stable` (the
  tested artifact is usually `develop`, and the comparison ref need be neither previous nor stable).
- Overrides on a serial (cell-less) run warn and fall back to defaults: an earlier draft failed
  fast, softened so a stray or shared variable cannot abort a broad run. `E2E_PREVIOUS_*` on a
  product without the role warns too: cells of several products may share one shell or CI env.
- BackWPup's version defaults differ per role — `plugin` `9.99.99`, `previous` one patch lower,
  `9.99.98` — so an update or rollback test sees `previous` as older with nobody picking versions;
  one patch is the smallest guaranteed-older delta under semver. Pass `E2E_PREVIOUS_VERSION` to test
  a real upgrade. Only `plugin`'s default exists until the role lands (§7.4).
- Edition and APVM variant stay two words: edition is the language-blind behavioural tier that
  `@free`/`@pro` need; a variant is an exact buildable package; APVM has no edition concept.
- Static identity preflight (`adm-zip`; `yauzl` the fallback) rather than an install-based probe: no
  WordPress needed, milliseconds, cannot mutate a site, identical for built and provided zips. The
  suite's first install proves installability minutes later anyway, and an uninstall–install–list
  loop per artifact is slow, serial and adds failure modes. Dropped from the first draft: "exactly
  one `.zip` in the role dir" — one artifact per role is enforced at resolution (`pickArtifact`),
  and a `release:*` ref legitimately delivers every variant's zip into the dir.
- APVM's cache is the only reuse layer: every execution wipes and re-resolves (a cache hit is a ~15
  MB copy), and provided zips are copied in (uniform layout, immune to the source moving). Roles
  resolve sequentially (readable logs, no assumptions about APVM's workspaces). Workers never
  resolve: APVM per worker would race on the wipe and duplicate copies.
- The transfer primitive lives in `exec.ts`, which already owns the cached SSH connection and the
  per-mode dispatch; a standalone `transfer.ts` importing an exported connection was rejected as
  leakier.
- The site's `stagingDir` beats `E2E_SITE_STAGING_DIR`: the site's declaration is the specific
  statement ("this host's docroot is not writable"), so a global default must not override it. Paths
  are absolute throughout, since the copy primitives ignore the exec working directory — why the
  pure path builder takes the root instead of hard-coding `.e2e_temp`.
- The staging-root guard sits at the point of use, not in `sites.ts`: docker's root is unknown at
  load, and one authoritative check cannot drift from a second. A relative `rootDir` is refused only
  by the staging layer: `exec` has always accepted one as a working directory, and failing it at
  load would break sites that work.
- `cleanSiteStaging` throws on a real failure (a dirty site should be visible); the teardown caller
  makes it best-effort. `mkdir` and `rm` are shelled out even on `local`: uniform behaviour across
  transports beats a special case.
- A bare numeric ref (`5.6.8`) is treated as a build ref although APVM may resolve it to a release;
  the version default is then sent needlessly and ignored in favour of the tag. Narrowing it would
  reimplement APVM's ref detection.
- `--project` is matched exactly against cell names, while Playwright's own filter ignores case and
  expands `*` (its `filterProjects`). Mirroring it would duplicate a third-party internal or let
  `--project='*'` apply one operator's override to every cell; exact matching degrades visibly
  (overrides warn and drop), never silently.
- Trap (execution-model.md, "Reading the selection from a worker"): a worker has no CLI argv. An
  argv-derived selection once silently dropped every `E2E_*` override while the warmer, with its
  argv intact, honoured them.

### 7.3 Limits

- Sites sharing one absolute staging root — several sites on one host given the same absolute
  `stagingDir` or `E2E_SITE_STAGING_DIR` — can collide when run concurrently. Within one invocation
  it cannot happen (one worker per site). Namespacing staging by `RUN_ID` was rejected: a killed
  run's folder would then be cleaned by nobody, leaving zips in a web-reachable docroot. The
  scheduler must know which roots are shared: the orchestrator plan's 0A.3.
- Two processes that both miss APVM's cache both build in full (its writes stay safe); pre-warming
  exists to avoid that (the orchestrator plan's 0A.5).
- A relative `E2E_*_ZIP` resolves against the repo root, never the process working directory;
  absolute is recommended.
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
- Version-aware tests: `resolution.json` exposes each role's verified version and commit; BackWPup's
  CLI feature already asserts `wp backwpup version` against it.
- Deeper zip validation (a CRC pass, a trial install) only if a real failure class appears, behind
  the same aggregated report.
- Free/Pro single build (one APVM call for both variants of one ref and version): the orchestrator
  plan.
- `.e2e_temp` is served by the web server on these cells (wordpress-automation.md); the guard is the
  phase-6 plan's 6J.

Done since: `cleanSiteStaging` runs in worker teardown (`wp/teardown.ts`, the `releaseBoundSite`
fixture).

## 8. Site file ownership (done)

Phases 0–6.5 done (2026-08-26) after five audit rounds; the full BackWPup suite passed on both cells
with it (2026-08-28). As built: wordpress-automation.md ("File ownership", "Path guards", "Left-over
plugin data"), configuration.md (`fileOwner`, `elevate`), AGENTS.md (the MUST and the pre-flight
reports), `src/common/wp/ownership.ts` (BusyBox and `id` parsing in its TSDoc). Kept here: cell
facts, decisions and rejected alternatives, limits, open obligations.

The problem: on an `ssh` cell WP-CLI runs as the transport's user (`ubuntu`, umask `0002`) and PHP
as the web server (`www-data`), so what the suite installs lands `ubuntu:ubuntu 775/664` and the web
server's next write into it fails — a raw `EACCES` inside `WP_Filesystem_Direct`, not an FTP prompt.
`normalizeOwnership` hands it to the owner detected from the install.

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
  WordPress (its `rootDir` was fixed in the git-ignored sites file). The same host serves WP
  Rocket's site to the same `ubuntu@host`, owned `sftp_wprocket:www-data` (uid 1002) — why ownership
  caches are per install, not per host.
- Group membership is host state: `ubuntu` was added to `www-data` on both hosts (`usermod -aG`,
  2026-08-26; `qa-auto-e2e-apache`: `www-data:x:33:sftp_backwpup,sftp_wprocket,ubuntu`; `qa-lnmp`:
  `www-data:x:33:ubuntu`). A check earlier that day found `qa-lnmp`'s group with no members and the
  change had to be reapplied, so membership is measured on every run, never configured. A fresh SSH
  session sees a new membership at once (node-ssh opens new sessions).
- sudo probes, measured with a sudoer and a non-sudoer (`www-data`): `sudo -n true` works (exit 0,
  else exit 1 with `sudo: a password is required`); `sudo -n -l` works but adds nothing;
  `sudo -n -v` is a false negative — exit 1 even for a passwordless sudoer, since `-v` validates the
  credential cache and tests no command. Never use it. "Not a sudoer" and "sudoer needing a
  password" print the same message by design, so pre-flight reports one state and names both causes.
- Known probe limit: a `NOPASSWD` grant for a command list excluding `true` fails `sudo -n true`
  while permitting `chown`. The fleet grants `ALL` (`/etc/sudoers.d/`).
- MariaDB 10.11.14 on `pro@apache` (2026-08-28): an `.ibd` file with no data-dictionary entry
  (`wp_bwpup_backups.ibd`, dated 2026-05-04) made every `CREATE TABLE` of that name fail with errno
  184 "Tablespace already exists", and `DROP TABLE IF EXISTS` does not remove it. `mariadbd`'s own
  message prescribes removing the file; it was moved aside (reversible), after which create and drop
  behaved again. An orphan is absent from `SHOW TABLES` and from
  `information_schema.INNODB_SYS_TABLES` (queried as root); moving it is safe while the server runs
  (no open handle) — re-check the dictionary just before acting. A sweep of every schema on the host
  found only that orphan.

### 8.2 Decisions and rejected alternatives

- The owner is detected with `stat` on `wp-content` (else the WordPress root), never from the
  web-server process: `ps` says `www-data` on both cells, wrong on `pro@apache`, where
  `chown www-data:www-data` would strip `sftp_backwpup`, the host's SFTP deployment account, off the
  tree.
- Rejected: running WP-CLI as the docroot owner. `sudo -n -u <owner> wp …` works, even for the
  `nologin` `sftp_backwpup`, but there is no single correct user (on `pro@apache` that owner's
  primary gid is 123 and its umask `0022`, so it would create `sftp_backwpup:sftp_backwpup 755`
  files the web server cannot write); `sudo -u` sets the target's `HOME` — `/var/www` on nginx,
  `/public` (absent) on apache — where WP-CLI puts its cache; and it changes every WP-CLI call to
  fix file creation.
- Rejected: a `www-data:www-data` fallback when detection fails. It is wrong on `pro@apache`, and a
  wrong owner applied as root is worse than none; detection cannot fail alone (pre-flight already
  asserts root access and a booting WordPress); and the real failure, missing elevation, leaves
  nothing able to apply any value. So an undetectable owner is warned about and skipped.
- The grant's scope is measured from the transport user's groups (`ug+rwX`; `o+rwX` added only when
  it is neither the owner nor in the group): a membership that can silently vanish does not belong
  in the sites file. The `o+rwX` branch matches these cells' existing `777` and the reasoning behind
  `DATA_DIR_MODE = "0777"`; it is avoidable, so it announces the fix. Both branches were exercised
  on both cells by temporarily removing the membership.
- The detected owner is memoised per worker process, not persisted: pre-flight runs in the setup
  process and scenarios in workers, and a file (as `resolution.json`) would buy a lifecycle and a
  staleness window to save one `stat` per worker per site over a pooled connection. Pre-flight
  reports the decision (`planOwnership`) without being its source of truth.
- Data-directory preparation sets the mode first, then hands the directory over — the reverse of the
  plugin's grant-then-chown — because the mode is changed while the directory is still the transport
  user's; normalising first would need privileges for a `chmod` that needs none. The hand-over is
  recursive, so it also reaches what the plugin's own activation created as WP-CLI — closed by
  construction, not by BackWPup's `activate()` creating no directories (`class-install.php`,
  2026-08).
- `fileOwner` is absent from the `sites.example.json` files: JSON has no comments, and neither other
  optional knob (`elevate`, `stagingDir`) appears there, so showing only the rarest would read as
  something a checkout needs. It is documented beside `elevate` in configuration.md.
- Pre-flight reports elevation up front: a host without it degrades quietly (residue left behind,
  `debug.log` perhaps not cleared, ownership not corrected), better learnt at a run's start than
  from a full disk weeks later. The banner has one pure renderer (results in, text out) called by
  pre-flight and the healthcheck, so the two cannot drift.

### 8.3 Known limits

- The fast path (the transport user's uid and gid equal the target's) skips the grant. A host where
  the transport user owns the docroot while the web server is another account relying on group bits
  could be judged `unnecessary` under umask `022` and stay unwritable by the web server. No cell has
  that shape (on `docker` the web user is the owner), and detecting a third user is what owner
  detection rejects as unreliable.
- `docker` is not literally untouched: each worker runs `stat` and `id` (and `pwd` without a
  declared `rootDir`) before the fast path — reads only, nothing privileged, nothing changed.

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
  now takes 44–50 s (73 s beside another run on the same server) of its 120 s budget, plus
  `LEFT_WORK_ALLOWANCE_MS` for stopping a killed run's work (`HOOK_TIMEOUT_MS`'s comment,
  `src/common/hooks/plugin-lifecycle.ts`). It is latency, not work: `mkdir`, `chmod`, `chmod -R` and
  `chown -R` take several operands, so one command per step instead of per path would cut it about
  threefold. Deferred: it changes `normalizeOwnership`'s one-path contract and needs its own tests.
  Revisit when a product declares more than a handful of data paths, or the Before hook nears its
  budget. (Residue removal is already batched — wordpress-automation.md.)
- Running WP-CLI as the docroot owner (§8.2): rejected on evidence, not forgotten. If installing
  call sites keep leaking ownership, revisit as a per-site opt-in (`transport.runWpAs`), never a
  default.

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
