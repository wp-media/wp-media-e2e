# wp-media-e2e

End-to-end tests for WP Media products (WP Rocket, BackWPup), on [Playwright](https://playwright.dev) +
[playwright-bdd](https://vitalets.github.io/playwright-bdd/) (Cucumber/Gherkin). ESM, Node 26,
npm 12, TypeScript 6 (strict). Contributor and agent guide: [`AGENTS.md`](AGENTS.md); design:
[`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md).

## Quick start

```bash
npm install --global npm@12.2.3   # once: Node 26 ships npm 11, which package.json's devEngines refuses
npm --version                     # 12.x: another npm 11 first on PATH (e.g. Homebrew's) still fails
npm install                       # also downloads Chromium (see "Browsers")
E2E_CELL=apache npm run test:wp-rocket
```

A fresh checkout has no `sites.json` / `sites.*.json`, so placeholder data is used: the auth setup is
skipped and the `@noauth` smoke scenarios pass, proving the harness is wired. `--grep @noauth` runs
**only** those (what CI does); anything else needs a real WordPress.

## Concepts

- **Product** — `wp-rocket` / `backwpup`: its features, steps and sites; configs in
  `src/projects/<product>/config/`.
- **Cell** — a named environment (`apache`, `nginx`, `pro@nginx`): the merged top-level keys of a
  product's sites files.
- **Pool** — a cell's interchangeable WordPress sites; each worker binds to one by `parallelIndex`.
- **Run unit** — one `(product × cell)`: one cell per invocation, pinned with `E2E_CELL=<cell>`
  ([execution-model.md](docs/architecture/execution-model.md)).

## Running

```bash
E2E_CELL=<cell> npm run test:wp-rocket     # one product, one cell
E2E_CELL=<cell> npm run test:backwpup      # also test:<product>:ui and test:<product>:headed
E2E_CELL=apache npm run test:wp-rocket -- --grep @smoke
```

`E2E_CELL` pins `bddgen`, the runner and its workers to one cell, so runs of different cells of one
product can go side by side. `--project=<cell>` also runs one cell, but `bddgen` regenerates **every**
cell's specs, breaking another run of the product started beside it; with a pin, `--project` narrows
within the cell (`--project=artifacts:<cell>` resolves its zips only). Each run prints a `[cell]` line:
its cell, how it was chosen, its workers and report folder. Never set `E2E_CELL` in `.env`: it would pin
every run started there. A command-line `--reporter` replaces the configured reporters, the `[cell]`
line with them.

## Health check

```bash
npm run healthcheck       # headless
npm run healthcheck:ui    # same checks, browser visible (watch a login, debug a flaky site)
```

Checks every configured site across **all** products, cells and pools: transport, WP-CLI, a real
installed WordPress, a POSIX login shell, who site commands run as, a working UI login — each site
printed as soon as it finishes, with the failing check and a hint. It writes nothing on a site but
the identity probe's short-lived file. Placeholder-only cells are skipped. Exits `0` only when every
real site passed (fit for CI or cron); `npm run healthcheck > fleet.log` holds no escape codes
unless `FORCE_COLOR` is set. Details: [execution-model.md → The auth setup and the health
check](docs/architecture/execution-model.md#the-auth-setup-and-the-health-check); tuning:
[configuration.md](docs/guides/configuration.md#fleet-health-check-npm-run-healthcheck).

## Orchestrator (cells in loops)

Runs cells on this machine in loops (a run, a cooldown, the next) and reports each run to Slack and
Datator. Every option goes after `--`.

```bash
mkdir -p .orchestrator && chmod 700 .orchestrator
cp orchestrator/config.example.json .orchestrator/config.json && chmod 600 .orchestrator/config.json
# edit it: one task per cell, the secrets, Slack's webhook, Datator's key
npm run orchestrator -- start --dry-run              # check it; runs and writes nothing
npm run orchestrator -- start --task <id> --once     # one run, exit 0 (passed/flaky), 1, or 130 if stopped
tmux new -d -s orchestrator 'npm run orchestrator -- start'   # every task, until stopped
tmux send-keys -t orchestrator C-c                   # stop: runs finish their scenario
```

Install, config fields, stopping, kept files, refusals: [docs/guides/orchestrator.md](docs/guides/orchestrator.md).

## Configuring sites

Sites are declared in git-ignored JSON files (they hold credentials) under
`src/projects/<product>/config/`: `sites.json` plus any `sites.<name>.json` overlays, merged
alphabetically; each file owns disjoint cells (a cell in two files is a hard error). With none, the
committed `sites.example.json` (placeholder data) is used.

```bash
cp src/projects/wp-rocket/config/sites.example.json src/projects/wp-rocket/config/sites.json
```

Credentials live only in sites files and never enter Playwright reports. Schema:
[configuration.md](docs/guides/configuration.md).

## Environment

Copy `.env.example` to `.env` and fill what you need (BackWPup storage credentials, optional runtime
flags). Real environment variables always win; `E2E_LOAD_DOTENV=false` in the environment skips the
file. Terminal output (`E2E_OUTPUT=auto|plain|fancy`, `NO_COLOR`, `FORCE_COLOR`, `TERM`, the locale):
[configuration.md → Terminal output](docs/guides/configuration.md#terminal-output).

## Browsers

`npm install` downloads Chromium via `postinstall`; the committed `.npmrc` sets `ignore-scripts=false`
so it runs even where install scripts are disabled globally. If browsers are missing:
`npm run setup` (`playwright install chromium`).

## Local WordPress (Docker) — the `docker` transport

[`docker/`](docker/) runs two **independent** installs over one MariaDB — **Apache** on `:8100`,
**Nginx** (php-fpm) on `:8101` (`APACHE_PORT` / `NGINX_PORT` override; then change the copied sites
file's `baseURL`s) — each with a kept-alive `wp-cli` container the suite drives via `docker exec`.

```bash
npm run env:up      # start containers + install both sites (idempotent); needs the Docker daemon
npm run env:down    # stop and remove everything (incl. volumes)
npm run env:logs    # tail container logs

# point a product at it
cp docker/sites.example.json src/projects/wp-rocket/config/sites.docker.json
E2E_CELL=apache npm run test:wp-rocket    # or E2E_CELL=nginx
```

The cells use `transport: { mode: "docker", container: "wpme-wpcli-apache" | "wpme-wpcli-nginx" }`
(the compose `container_name`s). Sites are installed as `admin` / `admin_password`.

**SSH twins** (Docker copies of the apache/nginx cells over the `ssh` transport):
`npm run env:cells:up` / `env:cells:reset -- <apache|nginx> <variant>` / `env:cells:down` — see
[configuration.md → SSH twins](docs/guides/configuration.md#ssh-twins).

## Reporting

Each run writes `reports/<product>/<cell>/<RUN_ID>/`:

- **`playwright/`** — Playwright's HTML report: **trace viewer**, video, screenshots. Open the newest
  with `npm run report` (`-- <product> <cell>` to target one), or one with
  `npx playwright show-report reports/<product>/<cell>/<RUN_ID>/playwright`.
- **`cucumber/`** — the Gherkin report: one portable HTML, screenshots/video embedded on failure;
  `REPORT_MODE=rich` makes it external with the trace viewer embedded (serve over http, not `file://`).
- **`allure-results/`** — raw results for **Allure** (history/trends, flaky detection, dashboard).
- **`results.jsonl`** — every attempt and the totals, one JSON line each, written as the run goes
  (schema: [`results-schema.ts`](src/common/reporting/results-schema.ts)).
- **`run-facts.json`** — what the run tested: the plugin (ref, full commit, zip, **SHA-256**), each
  site's WordPress, PHP, web server and database, the suite's version, the run's name and verdict;
  rewritten as each setup ends, so a killed run's still says what it had.

**Every report says up front what it tested**, in one line —
`backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 · WordPress 7.1.3 · PHP 8.5.11 64bit · <run>`,
plus `RUNNING`, `INTERRUPTED`, `STOPPED`, `COULD NOT TEST` or `NO TESTS` — as the Playwright report's
title (every fact in its Metadata panel, with `#?show-metadata-other` in the URL), a banner above the
Cucumber report, and the Allure report's name and Metadata. `E2E_RUN_NAME` names the run and
`E2E_REQUESTED_REF` shows the ref asked for (both display only); a `PLAYWRIGHT_HTML_TITLE` you set wins.
How: [execution-model.md → run facts](docs/architecture/execution-model.md#saying-what-a-run-tested-the-run-facts).

Under each scenario that fails for good, the terminal prints a block with a command that reruns just
that scenario on the same cell and plugin build:

```text
✘ failed 8.1s  Backups › Create a backup
  Step        When the backup runs
  Feature     src/projects/backwpup/features/backups.feature
  Error       Error: expect(locator).toBeVisible() failed
  Screenshot  test-results/backwpup/pro@nginx/…/test-failed-1.png
  Trace       test-results/backwpup/pro@nginx/…/trace.zip
  Rerun       E2E_CELL=pro@nginx E2E_PLUGIN_REF=commit:af1ab5c4d2… E2E_PLUGIN_VERSION=9.99.99 npm run test:backwpup -- --grep='/ \.features-gen/…/backups\.feature\.spec\.js(?: @\S+)* Backups(?: @\S+)* Create a backup(?: @\S+)*$/'
```

The `--grep` selects that scenario and only an exact duplicate (not `Create a backup encrypted`).
The run ends with a summary: the verdict, counts, the failed scenarios, the plugin and sites tested,
how to open each report, and which old reports it pruned. Rules: [execution-model.md → Watching a
run](docs/architecture/execution-model.md#watching-a-run-the-terminal-the-results-stream-and-the-summary).

**Old reports are pruned as each run ends**, for its cell only: at most `E2E_REPORTS_KEEP` (20; `0`
lifts the cap, not the age rules), none older than 30 days except the cell's newest complete report,
kept up to 182 days. Prune a cell that no longer runs by hand:

```bash
npm run report:prune                                   # dry run: every report, its decision and why
npm run report:prune -- --apply                        # remove what the policy says goes
npm run report:prune -- --product backwpup --cell pro@nginx --keep 5 --older-than 2w --apply
```

Allure, from the newest run or a given one:

```bash
npm run report:allure                                                    # newest run of any cell
npm run report:allure -- wp-rocket apache                                # a product/cell's newest
npm run report:allure -- backwpup pro@nginx 2026-10-22T10-04-03-625Z-26885   # that run
npm run report:allure -- wp-rocket apache --open                         # generate, then serve
```

`--open` serves on loopback only (`127.0.0.1`, the `host` in `allurerc.mjs`, as any
`allure open -c allurerc.mjs`): the report holds traces, session cookies included. From another
machine, tunnel to the port Allure prints: `ssh -L <port>:127.0.0.1:<port> <runner>`, then open
`http://127.0.0.1:<port>`.

It lands in `reports/<product>/<cell>/<RUN_ID>/allure/`, named by the run's facts line, one HTML file
per plugin (traces included) that opens from disk. **Trends accumulate** via a per-cell
`reports/<product>/<cell>/allure-history.jsonl` (one line per run, the newest 100, at most 64 MiB), so
the trend chart fills from the second run; a run reported again replaces its own line and draws the
trend it drew first. Flaky tests are flagged per run from retries. Generation replaces the report and
history only once Allure succeeded: a failure, or Ctrl-C (exit 130), leaves both as they were; empty or
malformed results are refused. Allure 3's plugins hard-code a Google Tag Manager loader, which
generation removes from every page (warning where it is not recognised). A run's end summary prints
the command for that very run. Content (categories, widgets, single-file output, the server's host):
[`allurerc.mjs`](allurerc.mjs); the code: [`allure-report.ts`](src/common/reporting/allure-report.ts).

A run's **download bundle** ([`report-bundle.ts`](src/common/reporting/report-bundle.ts), built by the
orchestrator after each run) holds only what a person opens — a landing `index.html`, `playwright/`,
`cucumber/`, a fresh `allure/`, `run-facts.json` — as `<run>/report/` and/or `<run>/report.tar.gz`;
Slack gives the command that fetches and unpacks it. Modes, contents, sizes:
[orchestrator guide → Report bundle](docs/guides/orchestrator.md#report-bundle).

## Visual regression

Visual checks assert a page renders the **same with optimizations active as bypassed** (`?nowprocket`),
i.e. lazy-load, CSS/JS handling etc. don't break it visually. Both renders are captured live in one run
and pixel-diffed against each other (no baseline), via [`src/common/visual/ab.ts`](src/common/visual/ab.ts):

```ts
import { expectOptimizedToMatchUnoptimized } from "../../../common/visual/ab";

await expectOptimizedToMatchUnoptimized(page, "/pricing");
await expectOptimizedToMatchUnoptimized(page, "/pricing", {
  mask: [page.locator(".ad-slot")], // ignore regions that legitimately differ
  maxDiffPixelRatio: 0.02, // loosen tolerance for this page
});
```

It loads the bypassed and the optimized page, stabilises each (scrolls to load lazy media, waits for
fonts) and fails if they differ beyond tolerance, attaching both renders and a highlighted diff. A size
difference fails too (a layout change is a regression). Tolerances:
[`src/common/config/visual.ts`](src/common/config/visual.ts). Tag such scenarios `@visual` to run them as
a group, and run them in the Playwright container image for pixel-deterministic rendering:
`mcr.microsoft.com/playwright:v<installed @playwright/test version>-noble`, which ships Node 26 (from
v1.65). Its npm is Node's own (11), so `npm install --global npm@12.2.3` there first:

```bash
E2E_CELL=apache npm run test:wp-rocket -- --grep @visual
```

## Quality gates

```bash
npm run typecheck    # tsc (type-check only: noEmit)
npm run lint         # eslint .
npm run format:check # prettier --check .
npm run test:unit    # unit/integration specs
```

CI ([`ci.yml`](.github/workflows/ci.yml)) runs these (the unit tests in two shards) and the `@noauth`
smoke on both products. On each suite release, bump `package.json`'s version
(`npm version <x.y.z> --no-git-tag-version`): the `[run]` header, run facts, the orchestrator and Slack
show it.
