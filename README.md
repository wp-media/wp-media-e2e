# wp-media-e2e

End-to-end tests for WP Media products (WP Rocket, BackWPup), on [Playwright](https://playwright.dev) +
[playwright-bdd](https://vitalets.github.io/playwright-bdd/) (Cucumber/Gherkin). ESM, Node 24,
TypeScript 6 (strict). Design: [`docs/plans/e2e-modernization-plan.md`](docs/plans/e2e-modernization-plan.md).

## Quick start

```bash
npm install          # also downloads Chromium (see "Browsers")
E2E_CELL=apache npm run test:wp-rocket
```

A fresh checkout has no `sites.json` / `sites.*.json`, so placeholder data is used: the auth setup is
skipped and the `@noauth` smoke scenarios pass, proving the harness is wired. `--grep @noauth` runs
**only** those (what CI does); anything else needs a real WordPress.

## Concepts

- **Product** — `wp-rocket` / `backwpup`, each with its features, steps, sites and (BackWPup only)
  service credentials; configs in `src/projects/<product>/config/`.
- **Cell** — a named environment (`apache`, `nginx`, `pro@nginx`): the merged top-level keys of a
  product's sites files.
- **Pool** — a cell's interchangeable WordPress sites; each worker binds to one by `parallelIndex`, spreading
  scenarios over the pool.
- **Run unit** — one `(product × cell)`. Run exactly one cell per invocation, pinned with
  `E2E_CELL=<cell>`; two cells at once fail fast (the global `parallelIndex` would overflow the smaller
  pool — [execution-model.md](docs/architecture/execution-model.md)).

## Running

```bash
E2E_CELL=<cell> npm run test:wp-rocket     # one product, one cell
E2E_CELL=<cell> npm run test:backwpup
E2E_CELL=apache npm run test:wp-rocket -- --grep @smoke
```

`E2E_CELL` pins `bddgen`, the runner and its workers to one cell (the config holds it alone), so `bddgen` regenerates only its
specs and runs of different cells of one product can go side by side. `--project=<cell>` also runs one
cell, but `bddgen` never sees it and deletes and regenerates **every** cell's specs, breaking another
run of the product started beside it. Each run prints a `[cell]` line before `Running …`: its cell, how
it was chosen, its workers and report folder. A pin naming no cell of the product, or a `--project`
selecting none of the pinned cell's projects, fails at once naming `E2E_CELL`. With a pin, `--project` narrows within the cell (`--project=artifacts:<cell>` resolves its zips only).

Never set `E2E_CELL` in `.env`: read from the working directory, it would pin every run started there.
A command-line `--reporter` replaces the configured reporters, the `[cell]` line with them.

## Health check

```bash
npm run healthcheck       # headless
npm run healthcheck:ui    # same checks, browser visible (watch a login, debug a flaky site)
```

Checks every configured site across **all** products, cells and pools (`healthcheck.ts`): transport,
WP-CLI, a real installed WordPress, a working UI login. Output is grouped per product; each site is
checked independently and printed as soon as it finishes (✔/✘/⚠), listing every check it ran, with the
failing check and a hint on failure. Styled on a terminal only (`NO_COLOR`, `E2E_OUTPUT=plain` and a
redirect honoured: `npm run healthcheck > fleet.log` holds no escape unless `FORCE_COLOR` is set); what a
site or tool wrote into a check is printed plain, credentials masked. A placeholder-only cell is skipped, not failed. Exits `0` only
when every real site passed, else `1` (fit for CI or cron). Tune with `HEALTHCHECK_CONCURRENCY` /
`HEALTHCHECK_LOGIN_TIMEOUT_MS`.

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
`src/projects/<product>/config/`: `sites.json` plus any `sites.<name>.json` overlays (`sites.docker.json`,
`sites.ssh.json`, …), merged alphabetically; each file owns disjoint cells (a cell in two files is a hard
error). With none, the committed `sites.example.json` (placeholder `.example.test` data) is used, so a
fresh checkout still loads and passes the `@noauth` smoke.

```bash
cp src/projects/wp-rocket/config/sites.example.json src/projects/wp-rocket/config/sites.json
```

Credentials live only in sites files and never enter Playwright reports. Schema:
[configuration.md](docs/guides/configuration.md).

## Environment

Copy `.env.example` to `.env` and fill what you need (BackWPup storage credentials, optional runtime flags).
Real environment variables always win; `E2E_LOAD_DOTENV=false` in the environment skips the file.
Terminal output (`E2E_OUTPUT=auto|plain|fancy`, `NO_COLOR`, `FORCE_COLOR`, `TERM`, the locale; the
orchestrator and its runs included): [configuration.md → Terminal output](docs/guides/configuration.md#terminal-output).

## Browsers

`npm install` downloads Chromium via `postinstall`; the committed `.npmrc` sets `ignore-scripts=false`
so it runs even where install scripts are disabled globally. If browsers are missing:
`npm run setup` (`playwright install chromium`).

## Local WordPress (Docker) — the `docker` transport

[`docker/`](docker/) runs two **independent** installs over one MariaDB — **Apache** on `:8100`,
**Nginx** (php-fpm) on `:8101` — each with a kept-alive `wp-cli` container the suite drives via
`docker exec`.

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

## Reporting

Each run writes `reports/<product>/<cell>/<RUN_ID>/`:

- **`playwright/`** — Playwright's HTML report: **trace viewer**, video, screenshots. Open the newest
  with `npm run report` (`-- <product> <cell>` to target one), or one with
  `npx playwright show-report reports/<product>/<cell>/<RUN_ID>/playwright`.
- **`cucumber/`** — the Gherkin report: one portable HTML, screenshots/video embedded on failure;
  `REPORT_MODE=rich` makes it external with the trace viewer embedded (serve over http, not `file://`).
- **`allure-results/`** — raw results for **Allure** (history/trends, flaky detection, dashboard).
- **`results.jsonl`** — every attempt and the totals, one JSON line each, written as the run goes:
  what a script watches and what the orchestrator reads at the end. Schema:
  [`results-schema.ts`](src/common/reporting/results-schema.ts).
- **`run-facts.json`** — what the run tested: the plugin (ref, full commit, zip, **SHA-256**), each
  site's WordPress, PHP, web server and database, the run's name and verdict. Rewritten as each setup
  ends, so a killed run's still says what it had (`"status": "running"`).

**Every report says up front what it tested**, in one line —
`backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 · WordPress 7.1.3 · PHP 8.5.11 64bit · <run>`,
plus `RUNNING`, `INTERRUPTED`, `STOPPED`, `COULD NOT TEST` or `NO TESTS` (which the reports cannot say
themselves) — as the Playwright report's title (every fact in its Metadata panel, with
`#?show-metadata-other` in the URL), a banner above the Cucumber report (expand it for every fact), and
the Allure report's name and Metadata. An unknown fact says why (`site unknown: auth setup failed`).
`E2E_RUN_NAME` names the run and `E2E_REQUESTED_REF` shows the ref asked for (both display only); a
`PLAYWRIGHT_HTML_TITLE` you set wins.

Under each scenario that fails for good, the terminal prints a block: the Gherkin step it failed in,
its `.feature` file, the first error, the screenshot and trace paths, and a command that reruns just
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

The `--grep` matches the scenario's generated file, Feature and title literally and case-sensitively,
anchored at the end, so `Create a backup encrypted` is not rerun with it; only an exact duplicate is.
The build is the one the run tested: the release tag (`release:3.17.4`) or commit it built, else the
zip, ref and version you set. A run of every cell reruns the scenario's own cell. A failed setup gets
its own block, rerunning `--project=<setup>`. A title shaped like a credential gets no command, and
its screenshot and trace paths (its folder carries the title) are not shown.

The run ends with a summary below everything: the verdict (`✘ COULD NOT TEST` when a setup failed,
`■ STOPPED` when stopped), counts, the failed scenarios with their failed step (ten, then `and N
more`), the plugin and sites tested, how to open each report, and which old reports it pruned. Its rule
spans the terminal; `E2E_OUTPUT=plain` makes it colourless and its own glyphs ASCII, the counts'
separators included (the plugin and site phrases it shares with the reports keep their `·`).

**Old reports are pruned as each run ends**, for its cell only: at most `E2E_REPORTS_KEEP` (20; `0`
lifts the cap, not the age rules), none older than 30 days except the cell's newest complete report,
kept up to 182 days. Prune a cell that no longer runs by hand:

```bash
npm run report:prune                                   # dry run: every report, its decision and why
npm run report:prune -- --apply                        # remove what the policy says goes
npm run report:prune -- --product backwpup --cell pro@nginx --keep 5 --older-than 2w --apply
```

Allure, from the newest run:

```bash
npm run report:allure                              # newest run of any cell
npm run report:allure -- wp-rocket apache          # a specific product/cell
npm run report:allure -- wp-rocket apache --open   # generate and serve in the browser
```

It lands in `reports/<product>/<cell>/<RUN_ID>/allure/`, named by the run's facts line. **Trends
accumulate** via a per-cell `reports/<product>/<cell>/allure-history.jsonl`, so the trend chart fills
from the second run; flaky tests are flagged per run from retries. Content (categories, widgets,
single-file output) is set in [`allurerc.mjs`](allurerc.mjs).

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
[`src/common/config/visual.ts`](src/common/config/visual.ts). Tag such scenarios `@visual` to run them as a group, and run
them in the Playwright container image for pixel-deterministic rendering:

```bash
E2E_CELL=apache npm run test:wp-rocket -- --grep @visual
```

## Quality gates

```bash
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm run format:check # prettier --check .
npm run test:unit    # unit/integration specs
```
