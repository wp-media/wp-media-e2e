# Orchestrator Plan

Status:

- Concept: agreed (§1–§3); stack decided (§3); APVM additions filed upstream (§5 Q1).
- Phase 0, make the suite ready: done and audited, 2026-10-05 → 2026-10-12 (§6). Its
  orchestrator-side recommendations (0A.3–0A.5, 0B.2's consumption, 0C's orchestrator half) are
  design inputs for Phase 1+.
- Phase 0.5, the minimal orchestrator: done 2026-10-19 (§7); its first deployment needs the runner.
- Later phases: one planned slice — [report delivery](orchestrator-report-delivery-plan.md): Allure
  generated at each run's end and a prepared `report.tar.gz` for one-file download; the rest not
  planned yet.

Replaces the [modernization plan](e2e-modernization-plan.md)'s orchestrator section and Phase 9.

Name: orchestrator — it lives in this repo, unlike the separate AutoE2E tool; "AutoE2E" may still
label some outputs (§4).

## TL;DR

- A long-running service on one 24/7 Linux runner that runs the suite's real cells as tasks
  (scheduled, loop, on-demand; `watch` later), never two runs of one cell at once, and lets people
  manage them through one API behind a command and a dashboard (§1–§3).
- The orchestrator builds each run's plugin first, through APVM's Node library, and pins the run to
  the commit built; every run ends in one `run.finished` event that feeds Slack, Datator, the
  dashboard and later external tools; reports are kept 30 days (§2–§3).
- Phase 0 made the suite safe to drive this way — cell pin, allowlisted environment, the drain, run
  facts, the results stream, pruning. The run contract (§6.2) is the interface every phase relies
  on; §6 keeps each item's decision and points to where it is documented.
- Phase 0.5 is the smallest version: `loop` tasks from a JSON config, Slack and Datator, replacing
  AutoE2E's BackWPup instances (§7, its own plan).
- Facts the design rests on are in §8 (V-ids shared with the Phase 0.5 plan).

## 1. What it is

A long-running service on one 24/7 Linux server that runs the suite's cells in the background and
lets people manage those runs. Personal machines do not run it: there, cells run by hand
(`E2E_CELL=<cell> npm run test:<product>`).

It replaces AutoE2E ([`wp-media/auto-e2e`](https://github.com/wp-media/auto-e2e)), a small Node
tool: on one server, four Linux users each loop one instance of the legacy `wp-rocket-e2e`
(wp-rocket apache/nginx, backwpup-pro apache/nginx, V38). It builds the plugin, drops the zip where
the legacy suite reads it, runs the suite and reports every cycle to Slack and Datator (V23). Here
the suite builds its own zips (`artifacts:<cell>`) and the orchestrator only pre-warms them, so both
share this repo.

- One server, one orchestrator instance. It runs any number of cells of any product at once,
  never the same cell twice (V1; two runs would share its sites' databases). Cells on different
  sites of one WordPress server may run together (0A.3).
- Dedicated sites. Runs use the AutoE2E sites, which nothing else uses; a cell moves over only
  once its legacy instance is stopped (`pro@apache`'s was, 2026-09-28; V5).
- Real cells only. Cells come from each product's sites files, as for a manual run;
  placeholder-only cells are skipped.
- No health check. `npm run healthcheck` is the operator's setup step. A site that breaks later
  fails its own run at the preflight (`setup:<cell>`), with the reason.
- CI neither uses it nor runs real cells (modernization Phase 8 dropped). Real-cell runs, PRs
  included, happen here — `run --ref` now, `watch` tasks later; CI keeps its quality, unit and smoke
  jobs.
- Not configured by the suite's env. The orchestrator never reads `E2E_*` vars; a run's plugin
  settings come only from its task (§2), its environment only from an allowlist (§6.2).
- APVM through its Node library only, never its CLI — a rule for the whole repo (AGENTS.md).
- Lives in `orchestrator/` at the repo root, apart from the test projects. It reuses suite
  modules (`warmArtifacts`, sites loading, the identity check) only through the import boundary
  (`orchestrator/suite-imports.json`, AGENTS.md).

## 2. Tasks and runs

A task says what to run and when, and runs many times. Each execution is a run: one
Playwright invocation of the task's run unit (product × cell). Not "job": that is BackWPup's backup
job, which this suite tests constantly. Not "run unit": that already names product × cell.

Task

| Field | Notes |
| --- | --- |
| `id` | 4 chars: lowercase letters and digits without look-alikes (`0 o 1 l i`), starting with a letter — e.g. `k7qx`. Redrawn on a clash; `node:crypto`, no dependency. |
| `type` | `scheduled` (tentative default): once at a time, hourly, every N hours, daily, every N days, weekly… · `loop`: again after a cooldown (e.g. 5 min) once a run ends · `on-demand`: once, now · `watch`: runs when a watched ref gets a new commit, a PR opens or a release ships — deferred (formerly `event`, a word Events below now owns). |
| `product`, `cell` | The run unit. One cell per task — it maps 1:1 onto logs, reports and the one-run-per-cell rule; "several cells" is a shortcut that creates several tasks. |
| `plugin` | For the `plugin` role (and `previous`, for products that test an update path): an APVM ref with the version where the product needs one — default the product's — or a provided zip (below). |
| extras | A name, paused, a test filter (tags / `--grep`). |

Provided zips — a build devs hand over, with no commit behind it.

- A zip goes wherever a ref can: on a task (every run tests it) or on one run
  (`run <task> --zip <file>`; the task's next runs test its own plugin again).
- The dashboard uploads it; the command takes a file already on the server. The orchestrator keeps
  its own copy named by its SHA-256, so one zip is stored once and a run can always be repeated with
  exactly what it tested.
- Checked on arrival with the suite's identity check (`verifyArtifact` against the cell's
  `resolveIdentity`: top-level slug and `Plugin Name:` header), so a Free zip cannot land on a Pro
  cell, nor another product's; its version is read from its header.
- Nothing to build: the build step skips it, as `warmArtifacts` does, and the run receives it as
  `E2E_PLUGIN_ZIP`, a path outside `.artifacts/` (the suite's rules:
  [configuration.md](../guides/configuration.md#plugin-artifacts-build--verify)).
- A zip run records the zip's name, SHA-256 and header version where a built run records its commit;
  reports and events show the same. The suite hashes every resolved zip (0D.2), so the orchestrator
  compares that digest with the one it stored.
- A zip is kept while a task uses it or a kept report refers to it.

A busy cell: a scheduled slot that finds the task's own previous run still going is skipped and
recorded; anything else queues — behind another task's run, or a manual run behind its task's own.

Run once. `run <task> --ref <ref>` or `--zip <file>`, optionally `--name "<name>"` (dashboard:
"Run once…" on the task, pre-filled), runs the task once, now, changing only what is passed. The
task is untouched, so nothing needs stopping, editing or reverting, and its next runs test its own
plugin again. The name labels that run in its history, reports and events; without one it is the
task's. A busy cell makes it wait its turn — stop the current run to go first. It shows in the
task's history like any run, labeled with its ref and commit or its zip (as GitHub Actions lists
manual runs beside scheduled ones). With no task on the cell, `run <product>/<cell> --ref <ref>` (or
`--zip`) creates an on-demand one. To change every following run, edit the task.

Task status. `active`, `paused`, or `done` (a one-off that has run). An active task is idle
until its next trigger, queued, running, or cooling down (loop), and shows its last result and next
run.

Groups — tasks that fire as one. First version: `rotate` only — each firing runs the next task
in turn, then back to the first (e.g. `pro@nginx` one day, `free@nginx` the next); other modes are
deferred (§4). A group has what a task has for firing — an id (same id space as tasks), a name, a
type, paused, a status — plus an ordered list of tasks. Each task keeps its own settings. A task is
in at most one group, and while there its own trigger is suspended (restored if it leaves).

- Like one task. A firing lasts until its run has ended. A slot that finds the previous firing,
  or the run of the task whose turn it is, still going is skipped and recorded, and the turn does
  not advance: the next slot runs the skipped task, so skips never break the rotation. A cell busy
  with another task's run makes the group's run queue, like any run.
- The turn advances when a firing launches its run, whatever the result, so a broken task cannot
  stall the others. Paused members are passed over; a manual `run` of a member is not its turn.
- `run <group>` fires the group once, now. Cells that share a host (0A.3) never run at once in a
  group.

Run status

| Status | Meaning |
| --- | --- |
| `queued` | Waiting to start, the reason shown: its build (under way since the run was created; a cold one takes minutes, V9), its cell, a free slot, or a loop's cooldown. |
| `running` | With live progress: done / total, failures so far. |
| `stopping` | A graceful stop is under way. |
| `passed` · `flaky` · `failed` | `flaky`: passed only on retry. |
| `error` | Could not test — its build failed (Builds, below), a setup failed, or the process died — so a broken branch or site never reads as a regression. |
| `stopped` · `killed` | By request, graceful or hard; a hard kill can leave the site dirty until the next run (0C). |

A run's end status is read from its processes' exits, how far it was stopped and its results stream
(0E); the rules' first version is `orchestrator/runs/outcome.ts` (Phase 0.5).

A run records its task, name, trigger, times and status; the plugin it was given — a ref, or a
zip's name and SHA-256 — and what it tested: the full commit (a ref like `develop` moves) or the
zip's header version, plus the site's own WordPress and PHP versions (V28); its output and its
reports. Its id is `<task>-<n>` (`k7qx-12`), and its `RUN_ID` is `<timestamp>-<run id>` (the suite's
`formatRunId`), so the report folder names its run and still sorts by time.

Builds — the orchestrator builds; a run never does

- Build first. A run's build starts the moment the run is created, in a worker process of the
  orchestrator's (0A.5), planned by the suite's request builder (`warmArtifacts`; the parity
  invariant). The run starts only once its build is in APVM's cache. A loop's next run is created as
  its last one ends, so its build overlaps the cooldown. A zip run has nothing to build.
- One build per artifact. Runs needing the same build share the one under way.
- Pinned. The run is handed the pin its build returned (0B.2): `commit:<sha>` with the version
  built — a cache hit with no network (V17, V176) — or `release:<tag>`, which still asks GitHub's
  API (V176). So `develop` or a PR moving meanwhile changes nothing, and the run records what it
  really tested. The age-based cache clean (§3) never removes what a run is about to use: its build
  step has just used it (V18).
- Place kept. A run holds its place in its cell's line while it builds; if the cell frees first,
  the cell waits for it rather than let a later run jump ahead. E.g. `run k7qx --ref pr:123` while
  `k7qx` is at scenario 51/52: the PR builds meanwhile; if 52 ends first, the cell waits, runs the
  PR, then the loop resumes.
- Side by side. Different builds may run at once (APVM supports it within one process), capped
  so they do not starve running tests.
- Failures. A failed build ends every run waiting on it as `error`, with APVM's reason and the
  tail of its output (secrets redacted, as the suite's APVM wrapper does) — in the run's log and
  status, its task's last result, the dashboard, the events and the orchestrator's log. No automatic
  retry (the task's next trigger or a `run` retries), and a loop backs off after `error` runs — its
  cooldown doubles, capped, and a run that tests resets it — so a broken branch or a down site is
  not retried every few minutes. A GitHub outage surfaces the same way (V21).
- Cancel. APVM can neither cancel nor time out a build (V15, V27; Q1a); killing the build
  worker's process group does both (0A.5), by request or on timeout. A stopped run's build still
  finishes into the cache, since other runs may share it (One build per artifact); whether stopping
  the only run waiting on a build should kill it is Q3.

Output and logs

- Run output — its build step, then the Playwright invocation's stdout/stderr — goes to one log
  per run and streams live: follow it while the run goes (`logs -f`, the dashboard), read it after.
- The orchestrator's own log — triggers, queue, starts, stops, errors.
- Live progress comes from the suite's results stream (0E); live counts and `run.finished` are
  both built from it. The terminal rendering — live table, colors, plain fallback — is modernization
  Phase 7 (done): its shared renderer styles this process too. The table tails each run's
  `results.jsonl`; the loop hands it the run's report folder and next-run time (Phase 7's seam),
  never stdout, which is the run's log. The orchestrator's log and each run's log stay plain text,
  with no ANSI, for `grep`, Slack tails and the dashboard's log view.
- Tasks, groups (with whose turn it is), run records, logs and provided zips live in one state
  directory, so a restart loses nothing.

Reports

- Listed by task, run (scheduled or one-off), cell, product, status and date — in the command
  and the dashboard.
- Say what they tested, up front — product, cell, edition, run id and name, the plugin (ref and
  full commit, or zip name and SHA-256) and version, the site's WordPress and PHP versions — in all
  three reports. Done in the suite (0D.1); the orchestrator only sets the run's name and requested
  ref.
- Opened from the dashboard directly, behind its login: Playwright HTML with its trace viewer,
  Cucumber, and Allure, generated when the run ends. The command prints their paths.
- Planned delivery: each run's end also prepares a minimal `report.tar.gz` — a landing page,
  Playwright, Cucumber, Allure and the run facts — for one `scp`. The raw folder stays for
  debugging. Traces stay in the Playwright report; the bundle strips them before generating
  Allure's single-file report. See the
  [report delivery plan](orchestrator-report-delivery-plan.md).
- Kept for a while, then removed (§3 Report retention); any report can also be removed by hand.

Events — the orchestrator announces what happens, and any part of it can subscribe.

- The events: a run queued, started and finished; a build started, finished and failed; a task
  or group created, changed or removed; a new suite version found, an update started, finished and
  failed (§3 Updating the suite); a server's warnings (0A.3); the orchestrator started and stopping.
- `run.finished` fires once per run, whatever the outcome (`error`, `stopped` and `killed`
  included), carrying everything about it: task, run id and name, trigger; product, cell, edition;
  the plugin (ref and commit, or zip name and SHA-256) and version; the site's WordPress and PHP
  versions; status, times, duration; counts (total, passed, failed, flaky, skipped); every scenario
  with its feature, status and, for a failure, the first failing step's message; and where the
  reports are (path on the server, dashboard link). That covers what AutoE2E sends (V23).
- Subscribers are modules inside the orchestrator. Each picks its events and can be scoped to
  tasks, groups or products. One stream feeds them all — the dashboard's live view, the command's
  `watch`, notifications — and later external tools (§3 API).
- A subscriber never holds up a run: a slow or failing one is timed out and logged, and no run's
  status depends on it.
- Slack — one message per run, like AutoE2E: outcome, counts, failed scenarios, the cell (what
  AutoE2E took from `AUTO_E2E_INSTANCE_NAME`), product, plugin (ref and commit, or zip), the site's
  WordPress and PHP versions (not WP-CLI's, which AutoE2E reports and which is wrong on the nginx
  cells, V28), the report's path and dashboard link. Through an incoming webhook, as AutoE2E does.
- Datator — each run's results, as AutoE2E posts them (V23): product, cell (AutoE2E's
  `test_suite`), start time, counts, commit (none for a zip run), duration, and every scenario's
  feature, name, status and first error.
- Secrets — webhook URLs, API keys — live in the orchestrator's own config, never in the repo,
  and are masked in the API, the dashboard and the logs.

## 3. Planned

Stack — decided 2026-10-05.

| Layer | Choice | Why |
| --- | --- | --- |
| Host | A separate runner server, reaching the sites over SSH (the suite's `ssh` transport) | Keeps browsers and builds off the WordPress servers. How many instances share it is Q2. |
| Language | TypeScript on Node 24, run with `tsx` | The suite's relative imports carry no extension, which Node's own type stripping cannot resolve (V110). |
| State | SQLite through `node:sqlite`, one file in the state directory; plain SQL, numbered migrations, no ORM | Built in, no native addon; "Release candidate" in Node 24.21, no warning (V111). `better-sqlite3` is the fallback behind the same repository layer. |
| API | Hono + `@hono/node-server`: one app on a Unix socket (command) and on HTTP (dashboard) | Its typed client (`hc`) gives both clients the server's types — parity by construction; SSE and static serving built in (V112). |
| Validation | zod 4 | One schema per input — task, config, API body — typing server, command and dashboard alike. |
| Command | commander, colour through `node:util` `styleText` | ~40 subcommands are too many for `parseArgs`. |
| Scheduling | croner for calendar triggers; our own timer for loops and cooldowns | Time zones and DST handled for calendar triggers; loop timing is a small pure function. |
| Run supervision | `node:child_process` `spawn` with `detached` (own process group) | 0C signals the group (stop file, one SIGINT, then SIGKILL; never SIGTERM); execa's `kill()` signals one pid. |
| Logs | pino for the orchestrator's log (its `redact` masks secrets); plain text per run | |
| Dashboard | React + Vite + Tailwind + shadcn/ui, built to static files the orchestrator serves | One process and one origin: the API, the dashboard and the reports share it. |
| Auth | `node:crypto` (scrypt passwords, hashed scoped API tokens); no login on the loopback listener; a login and session cookie only on a separate listener for other modes; TLS from a reverse proxy off a private network | No auth dependency. Only the SSH tunnel is a confirmed way in (VPN, Tailscale unconfirmed). |
| Tests | The repo's unit runner (`*.spec.ts`); Playwright for the dashboard later | Same conventions as the suite. |

Versions are taken at implementation time (2026-10-05: hono 4.13, @hono/node-server 2.1, zod 4.6,
commander 15, croner 10, pino 10, react 19.3, vite 8.3, tailwindcss 4.3).

- systemd keeps the orchestrator alive. It is already on the server (PM2's own boot start is a
  systemd unit it generates, V14), and it tracks every process the orchestrator starts, so no run
  outlives a crash unseen. `KillMode=mixed` sends the stop signal to the orchestrator alone, which
  then stops its runs gracefully (0C); systemd SIGKILLs what is left after `TimeoutStopSec` (V13).
- One instance at a time, plus an optional cap on concurrent runs (each run already uses
  `pool.length` workers).
- Shared SSH server profiles (modernization plan, Phase 11): a site's `transport` may omit `host`,
  `username`, `privateKeyPath` and `port`; they resolve from the product's `ssh.servers.json`
  profiles or `E2E_SSH_*`. `loadSites` resolves them for the orchestrator too, and a run's
  environment forwards the four variables; no config schema change.
- The command — on the server only, over SSH: tasks (add, edit, pause, resume, remove, run
  once), groups (the same, plus add, move, remove and reorder their tasks), runs (list, status, logs
  and live output, results, stop, kill), reports (list, paths, remove), provided zips (add, list,
  remove), notifications (list, send a test), cells (busy or free, and their tasks), the
  orchestrator itself (status, stop), and a `watch` view.
- The dashboard — the same features in a web UI, plus opening reports and uploading zips. Bind:
  local only (reached over an SSH tunnel), local network (VPN, Tailscale), or remote. Only the SSH
  tunnel is confirmed (2026-10-05), so it is the default and the mode built first. Off a private
  network it requires TLS: a scenario's retained trace carries the site's session cookies (live
  until the cell's next run) and any secret its DOM held (0D.4). Over the tunnel
  (`ssh -L 8080:127.0.0.1:<port> runner`, then `http://localhost:8080`):
  - bind `127.0.0.1` on the runner, and name `127.0.0.1` in `-L` — `localhost` there may resolve to
    `::1`;
  - no login (decided 2026-10-05): reaching the runner's loopback — an SSH login, or an account on
    the runner — is the access control;
  - decided by listener, never by client address: the loopback listener has no login; any other mode
    is a separate listener that always requires it. A reverse proxy on the runner connects from
    `127.0.0.1` too, so "no login from 127.0.0.1" would wave every remote visitor through; it must
    point at the authenticated listener;
  - `Origin` and `Host` are checked, since no cookie stands in the way: any web page the user has
    open can send a request to `http://localhost:8080`. Every state-changing request needs an
    `Origin` equal to its own origin (plain form posts included), and `Host` must be `localhost`,
    `127.0.0.1` or `[::1]` on any port (the local port is the user's) — against DNS rebinding;
  - where a login exists (the authenticated listener), its cookie is `Secure` only on HTTPS: WebKit
    drops a `Secure` cookie on `http://localhost`, Chromium and Firefox keep it (V113). Always
    `HttpOnly`, `SameSite=Strict`, a name of our own;
  - relative links only inside the dashboard, so any local port works; links sent out (Slack,
    events) use a configured `dashboardUrl`, defaulting to the documented tunnel's
    `http://localhost:8080`;
  - SSE passes through the tunnel unchanged; a comment line every ~15 s keeps idle streams alive.
- Parity between the command and the dashboard: whatever one offers, the other does too, unless
  it makes no sense there — viewing an HTML report is the dashboard's; the command prints its path.
- One API behind both — the command over a local socket, the dashboard over HTTP — so their
  features match by construction. It is also the door for external tools (e.g. from our own
  machines): versioned from the start, each client with its own token and scopes (read-only or
  control), TLS off a private network, every control action audited, the event stream exposed
  through it. No external client is planned yet; adding one needs no redesign.
- One report per run, never merged (modernization D4).
- Report retention. On a schedule, the orchestrator removes reports older than X —
  configurable, default 30 days — with their logs and any zip only they referred to. Each task's
  newest report outlives X, but only up to Y — configurable, default 6 months — and any report
  can be removed by hand (command, dashboard). A run's summary record stays (it is small), so
  history and trends survive. It reuses the suite's planner, grouped by task (0F). Until then the
  suite prunes each cell as a run ends; before the orchestrator takes over, the suite needs a switch
  turning its own pruning off (`E2E_REPORTS_KEEP=0` lifts only the cap; 0F, V293).
- Report delivery — at each run's end generate Allure and prepare a minimal `report.tar.gz` (one
  file for `scp`): landing page, Playwright, Cucumber, Allure and the run facts; no raw results.
  Traces stay in Playwright; Allure strips them by default because `singleFile` embeds every
  attachment (measured: 53.8 MB of traces → 82.6 MB HTML). `reports.bundle.mode` is
  `archive`/`folder`/`both`/`none`, `reports.bundle.traces` is `strip`/`keep`. Four phases, about
  4–6 days. See the [report delivery plan](orchestrator-report-delivery-plan.md).
- Updating the suite — decided 2026-10-05: stop, update, resume. One checkout serves every cell,
  and a run reads its files while it runs (`bddgen`, step files, `node_modules`), so nothing is
  updated under a running cell. Until this exists, the suite is updated by hand while the
  orchestrator is stopped (the [Phase 0.5 plan](orchestrator-phase-0.5-plan.md)'s D3).
  - A new version is announced: the orchestrator checks the suite's branch (default `develop`) for a
    new commit; the dashboard and the command warn, naming the current and the new commit, and an
    event fires.
  - Auto-update, a setting: when on, a new commit is applied by itself — no new run starts, the
    running ones finish, then the update, then everything resumes.
  - Update now — a dashboard button, or the command — first says that every run will be stopped, and
    asks: y/N in the command, a Continue / Cancel modal in the dashboard. On confirming, every run
    stops gracefully (0C), the update runs, and everything resumes.
  - Scheduled update (deferred): a third choice in the same prompt, "at 04:00 UTC" (configurable),
    stopping everything then and updating. The first version offers y/N and Continue / Cancel only.
  - The update: a fast-forward pull of the branch, then `npm ci` (its `postinstall` also installs
    the matching Chromium), then the orchestrator restarts, since its own code lives in the
    checkout.
  - To iterate: how often to check, auto-update's default, a failed pull or install, the command's
    name, and what the y/N does without a terminal.
- APVM cache retention (deferred until APVM's Node library can clean, Q1c). The orchestrator
  will periodically remove cache entries unused for longer than X — configurable, default 10 days
  — and log what it removed. Every cache hit refreshes an entry's last use (V18), so anything a task
  still builds stays. APVM's CLI can already clean, but this project never uses the CLI (AGENTS.md).
- Later optimization — one APVM build for Free and Pro. When a Free and a Pro cell resolve the
  same ref and version (the default: both `develop`), warm both in one call instead of cloning and
  installing the same commit twice: group the warm's deduped requests on
  `{project, gitRef, version}` and union their `variants` (APVM's `free`/`pro-en`, not our
  editions). `buildArtifactPlan` already knows every cell's request up front and the warm already
  dedupes on it, so only the warmer changes; each cell's single-variant `build()` then hits the
  cache (V10). Measure the saving when implementing.

## 4. To explore

- More group modes, deferred from the first version: `sequence` — every task, one after another,
  each firing (their builds overlap; a failure does not stop the rest); `parallel` — every task at
  once.
- Stream the headless browser's screen through the dashboard.
- `watch` tasks (deferred): a new commit, PR or release — e.g. a GitHub webhook.
- Zips from a link (e.g. a CI artifact URL) instead of an upload.
- Mark a site as in use across machines (e.g. with a support plugin), checked by the preflight.
  Needs an atomic take, an owner, an expiry (a crashed run must not lock a site forever), a release,
  and a preflight message naming the owner. Phase 0.5's site locks cover one user on one machine
  only (AGENTS.md, "One cell, one orchestrator run").
- Pause a cell across a host's maintenance window instead of failing every run there: the QA
  servers kill PHP by design — the apache server reboots twice a day, `qa-lnmp` restarts PHP-FPM a
  few times a week — and a removal in flight then leaves a half-removed plugin (phase-6 V231; the
  suite survives it since phase-6's 6H.0).
- Run the orchestrator in a container (e.g. the Playwright image: pinned browser and system
  packages, deterministic `@visual` rendering).
- Retention of Allure history (reports, run logs and APVM's cache are planned, §3).
- Where "AutoE2E" appears (outputs, dashboard).

## 5. Open questions

| # | Question | Notes |
| --- | --- | --- |
| Q1 | APVM additions (ours) | (a) Cancel / timeout for a build — it has neither (V15, V27): [APVM #2](https://github.com/wp-media/automation-plugin-version-manager/issues/2); the orchestrator's half is 0A.5. (b) Coordinate identical builds: two processes that both miss the cache both build in full; the store itself is locked and atomic (V25, V26): [APVM #3](https://github.com/wp-media/automation-plugin-version-manager/issues/3). (c) Cache clean in the Node library — not there even in 3.2.0 (V19); being planned in APVM for a 3.3.0, which cache retention waits for (§3): expose the storage crate's `ArtifactStore::clean` (e.g. `cleanCache({ olderThan, project, target, dryRun })` returning its `CleanReport`), so builds and cleaning share one dependency, one version and one cache handle; `apvm-napi` is updated only once that release is tagged. (d) Set aside 2026-09-28, not filed: no token in a private clone's URL, or at least a 0700 work folder (V78); a `gc` in the Node library, for the `.apvm-tmp-*` part-files a kill leaves (V11; whether the CLI's `gc` sweeps them is unverified). The orchestrator's private build folders (0A.5) keep the token out of shared temp space meanwhile. |
| Q2 | Instances on the runner server | One orchestrator instance per WordPress server (nginx, apache): do both run on the one runner server (two state directories, two systemd units, a combined cap on browsers), or on one runner each? Decide before the service is built. |
| Q3 | Stopping the only run waiting on a build | Should it kill that build (0A.5's kill) or let it finish into the cache, where a later run may use it (0C, recommendation 7)? |

## 6. Phase 0 — Make the suite ready (done)

Done 2026-10-05 → 2026-10-12, audited. Suite changes are documented where pointed below; the
orchestrator-side recommendations (status list) are kept in full as Phase 1+ inputs, with what Phase
0.5 built marked. Phase 0's open questions are answered; its P7 is §5 Q1d.

### 6.1 Method and cells

- Measured with Playwright 1.63.0, playwright-bdd 9.2.1, allure 3.18.0 + allure-playwright 3.12.2,
  apvm-napi 3.0.0 (source read at APVM `cli/v3.0.0`, V179), Node 24.21.0 and npm 12.0.2 on the macOS
  runner. Playwright line references are to its 1.63.0 bundle (`lib/runner/index.js`,
  `lib/common/index.js`).
- Evidence: §8.
- The cells: `free@nginx` = `bwu2.e2e` (158 MB docroot) and `pro@nginx` = `bwu3.e2e` (2.9 GB on
  2026-09-24, 2.4 GB of it `wp-content/bigFiles`, emptied 2026-09-30), in the worktree's own
  git-ignored sites file. They share host `qa-lnmp` (V36) with the main checkout's `bwu` (Free) and
  `simple` (Pro): four BackWPup sites on one disk (V4). Up to about four parallel suites per server
  are fine; name the sites a live run uses first (V5; this replaced the earlier one-at-a-time rule,
  phase-6 V72, V162).
- They match `bwu`/`simple` (V70) except, until 2026-09-30, in cron: `bwu`/`simple` define
  `DISABLE_WP_CRON` and a system cron requests `wp-cron.php` every minute, while on `bwu2`/`bwu3`
  every WP-CLI command and page load ran WP-Cron (V71) — and BackWPup leans on WP-Cron while a job
  runs (V72). Since 2026-09-30 every `bwu2`–`bwu9` has both (crontab line first, then the constant;
  proven by a probe event and the cron log, then by WP-CLI and page loads no longer running cron).
  Measurements on `bwu2`/`bwu3` before that date (the 0C live checks of 2026-09-25) do not carry
  over to cron-dependent features; those checks test the suite's teardown, which their feature keeps
  independent of WP-Cron.
- Left as they are: no Imagify or Query Monitor on `bwu2`/`bwu3`; `bwu2` has no `bigFiles`.
- BackWPup behaviour seen along the way, reported, not investigated: Free leaving options after its
  deletion on `bwu2` (V230); the restore working folder's ownership race in both directions (V269).

### 6.2 The run contract

How the orchestrator starts, feeds, watches and stops a run — the interface every phase relies on.
Phase 0.5 built it in `orchestrator/runs/` (`commands.ts`, `environment.ts`, `launch.ts`, `stop.ts`,
`shutdown.ts`); the suite's side is in [execution-model.md](../architecture/execution-model.md).

- Start. Two direct spawns, never through npm, npx or a shell (a shell kept SIGINT from the
  runner, V46): Node running
  `node_modules/playwright-bdd/dist/cli/index.js --config playwright.<product>.config.ts`, then —
  only if it exited 0 and no stop was asked —
  `node_modules/@playwright/test/cli.js test --config …`, a task's filter as one `--grep=<value>`
  argument and nothing else: no `--reporter` (it would drop the stream, the facts and the pruning,
  V60), no `--project` (the pin selects). Each is `detached` into its own process group and session,
  runs in the checkout's root and writes stdout and stderr to the run's log. The PID held is the
  runner's, the one process that turns SIGINT into a graceful stop.
- Environment, from an allowlist, never inherited (0A.1, 0B.1): the orchestrator's own process
  may carry `.env`'s values, a `RUN_ID` or `PLAYWRIGHT_BDD_CONFIGS` (V84). A run gets:
  - `PATH`, `HOME` (APVM's cache and `gh`'s login live under it, V83), `LANG` and `TMPDIR`, when
    set;
  - `E2E_LOAD_DOTENV=false`, `RUN_ID=<timestamp>-<run id>`, `E2E_CELL=<cell>`, and
    `E2E_INTERNAL_STOP_FILE` — absolute, in the run's own folder of the state directory, which
    exists for the run's lifetime, the file not there yet;
  - the plugin as the task sets it (`E2E_PLUGIN_REF`, `E2E_PLUGIN_VERSION`); display only,
    `E2E_REQUESTED_REF` (the ref asked for) and `E2E_RUN_NAME` (the task's name);
  - `E2E_RETRIES` and `E2E_REPORTS_KEEP` when configured;
  - the configured secrets, whose names may only be `GITHUB_TOKEN`, `GH_TOKEN` (a private product's
    run asks APVM for a token even on a cache hit, V83) and `BWP_*` — forwarded by prefix, never a
    hand-kept list, which would silently blank a credential added later (V87); they reach every
    local or docker `wp` child, not an SSH one (V91);
  - never `CI`, `PRODUCT`, `E2E_INTERNAL_SELECTED_CELLS`, `PLAYWRIGHT_BDD_CONFIGS`, `HEALTHCHECK_*`,
    `CAPTURE_*` or anything else.

  Later phases add: the build's pin as `E2E_PLUGIN_REF`/`_VERSION` (0B.2), `E2E_PLUGIN_ZIP` for a
  zip run, `E2E_PREVIOUS_*`, `REPORT_MODE`, the four `*_ROOT` roots, `E2E_SITE_STAGING_DIR` only if
  a task sets it (a site's own `transport.stagingDir` wins anyway), a private `TMPDIR` (a run that
  misses the cache builds in its runner and clones there, V78; 0A.5) and the switch turning the
  suite's own pruning off (0F).
- Watch. `<report dir>/results.jsonl` streams every attempt and the totals (0E);
  `<report dir>/run-facts.json` says what was tested (0D.1). Read complete lines from an offset and
  ignore unknown types and fields; `v` is bumped for any breaking change. No `run.end` means the
  runner died (its exit says how: 130, 143, 137); no file means Playwright never started.
- Stop. Create the stop file (the drain) → one SIGINT to the runner → SIGKILL to its process
  group: each step at most once, never SIGTERM, never a second SIGINT (0C). While `bddgen` runs, its
  group is killed outright (nothing to drain). No SIGINT once the stream holds `run.end`: the runner
  then has no handler left and would die writing its reports. A process has ended when its group is
  empty (`kill(-pgid, 0)` → `ESRCH`, V47), not when it exits. A group that outlives its leader by 5
  min (past the interrupt budget) is SIGKILLed; one that still will not empty holds its run and
  cell, said every 5 min (`launch.ts`).
- After. `run.end` and the exits give the status (§2); the reports are complete once the group
  is empty; Allure is generated from `allure-results/`, named from the facts (not in Phase 0.5).

### 6.3 0A — Running side by side

0A.1 — `bddgen` rewrote every cell's specs (done 2026-10-06).

- Finding: `bddgen` deletes and rewrites every cell's specs of the product (V2), so two cells
  started together failed 2 of 80 (V29, V30); only the environment reaches `bddgen` (V31).
- Decision: pin the run unit through the environment, `E2E_CELL=<cell>`. The config then holds that
  cell alone, so `bddgen` regenerates only its specs (0 of 80 failed, V29); a `[cell]` line names
  the cell; an unknown pin, a `--project` the pin cannot satisfy, or an inherited
  `PLAYWRIGHT_BDD_CONFIGS` fails naming the variable.
- Rejected: per-run spec folders keyed by `RUN_ID` (a manual `bddgen` and its runner stamp different
  RUN_IDs, every cell still regenerates, folders pile up, Allure's `fullName` changes every run);
  generating once and running without `bddgen` (any regeneration still deletes every cell's specs;
  nothing for manual runs); atomic generation by a temp folder and rename or a symlink swap
  (`bddgen` writes straight into its `outputDir`; a non-empty folder cannot be swapped atomically);
  a generation lock (workers load specs to the end, so it serialises whole runs); upstream "write
  only what changed" (worth proposing, no issue filed; it cannot cover real changes); checking an
  inherited `PLAYWRIGHT_BDD_CONFIGS` key's checkout by realpath (playwright-bdd resolves the folder
  against the config's own location, so legitimate keys were refused; the orchestrator never passes
  the variable).
- As built: execution-model.md "The cell pin"; configuration.md (`E2E_CELL`).
- Left: unpinned invocations of a checkout — the `--project` form, `test:ui`, sweeps — still
  regenerate every cell, so on the server only the orchestrator runs from its checkout. Optional
  hardening: unpinned runs generate under `.features-gen/<product>/_all/<cell>`, which makes pinned
  runs immune.

0A.2 — the root `test-results/` was shared (done 2026-10-06).

- Finding: Playwright empties every selected project's output folder (V3); the setup projects and
  unit runs used the root, so they deleted running cells' traces, and a missing attachment file
  crashes the Cucumber reporter, failing a run with no failed test (V34).
- Decision: a project writes in `<product>/<cell>` only when the run targets that cell whole, any
  other run in `<product>/_all/<cell>`, unit runs in `_unit`; cell names are checked at load
  (`^[a-z0-9][a-z0-9@._-]*$`, not `_all`: a `/` or `..` would escape the folder, and case alone
  would let Playwright's filter match two cells). Reports and logins are absolute paths in the
  checkout, since allure-playwright's `resultsDir` and a `storageState` path follow the working
  directory (V133).
- Rejected: setup folders alone (a run without `--project` still wipes its product's cells); per-run
  output folders (they pile up and break `--last-failed`); preserving the output (only UI and watch
  mode can, V3).
- As built: execution-model.md "Artifact directories & lifecycle".
- Left: two runs of one cell still share its auth, bdd and artifacts folders, so a cell takes one
  run at a time (0A.4), and the orchestrator never runs a setup project alone.

0A.3 — cells that share a server (the orchestrator's; no suite change).

- Finding: `qa-lnmp` is shared with work not ours — one MySQL, one PHP-FPM pool, 26 docroots (V36);
  a files backup including `wp-content/bigFiles` (phase-6 V50) was about 3 GB until the operator
  emptied those folders (2026-09-30), normally about 150 MB; two WordPress servers (V5). An absolute
  `transport.stagingDir` or `E2E_SITE_STAGING_DIR` is shared by every site of its host and wiped
  whole by a worker's teardown, so two runs on one host would delete each other's staged zips; no
  site uses one today ([wordpress-automation.md](../architecture/wordpress-automation.md), "Site
  staging").
- "One server, one orchestrator" means one orchestrator instance per machine, not one run per
  WordPress host. The operator allows about four parallel suites per server and asks to be told
  which sites a run uses (the same sites host AI-driven QA sessions).
- Recommended:
  - A run holds resources derived from its cell's sites: each site's identity (0A.4), each transport
    host, each resolved staging root. Runs sharing a site or a staging root never overlap —
    correctness, not capacity: they would destroy each other's state.
  - No limit per server (decided by the user, 2026-10-05): the orchestrator never holds, queues or
    refuses a run because of how many already run on its server.
  - A warning instead, once a server's busy-run threshold is reached — default 4 (the operator's
    estimate), configurable per server, runs counted per transport host (resolved, 0A.4) — never
    blocking. Command: starting a run (`run`, a task's trigger shown by `status`) that brings a
    server to or past it prints the server, its running cells and the threshold; `status` and the
    cells view mark the server while it stays there. Dashboard: a banner on the server and its
    cells, and the same warning in the "Run once…" confirmation. Events `server.threshold.reached`
    and `.cleared`; the log records both.
  - Disk warning (decided by the user, 2026-10-05), never blocking: before a run, check each of its
    hosts' free space (`df` through the suite's `exec`); below a configured threshold the run starts
    anyway, with the same warning channels (events `server.disk.low` and `.cleared`) naming the
    host, its free space and the threshold. Its default comes from measuring a files backup's peak
    disk use — not measured yet.
  - Measure V6 per host: one, two, then four cells at once against one at a time — failures,
    durations, load, FPM children, MySQL threads, disk peak. On `qa-lnmp`: four `bwu*` sites, named
    to the operator first; database-only features first, files backups last, `df` watched
    throughout.
- Rejected: namespacing staging by `RUN_ID` (the deferred remedy in the [modernization
  plan](e2e-modernization-plan.md)'s Limits: sites sharing one absolute staging root): a killed
  run's folder would be cleaned by nobody, leaving staged zips in a web-reachable docroot. Staging
  per site already exists; the scheduler only has to know which roots are shared.
- Phase 0.5 built a first version: at start, every server that `serverWarningThreshold` or more of
  the selected tasks reach is warned about (`orchestrator/config/check.ts`).

0A.4 — two runs on one site (the orchestrator's; partly built in Phase 0.5).

- Finding: the sites loader accepts one WordPress listed by three cells — `baseURL` differing only
  in case and a trailing slash, `rootDir` only in a trailing slash — and keeps the values verbatim;
  it rejects only a cell defined in two files (V39).
- Recommended: at start and whenever a sites file changes, check that no site appears in two cells
  of any product, comparing two normalized keys; a match on either is a conflict, reported naming
  both cells:
  - URL: the origin (host lowercased, default port dropped) plus the path without its trailing
    slash;
  - location: `ssh://<host, lowercased><rootDir, normalized>`, `docker://<container><rootDir>`,
    `local://<realpath of rootDir>`;
  - optional: the same check within one product in `loadSites`, which protects manual runs cheaply;
  - limits: an IP and a DNS name for one machine, or two URLs for one WordPress, are not seen
    statically. Resolving SSH hosts (`dns.lookup`) also serves 0A.3's per-server count.
- Phase 0.5 built the URL key (`orchestrator/config/site-key.ts`), compared over the selected tasks
  (two tasks on one site refused), and a lock per site shared by every orchestrator of the user on
  the machine (AGENTS.md, "One cell, one orchestrator run"). Still to do: the location key, the
  check over every cell of every product, the re-check when a sites file changes, and the optional
  loader check.

0A.5 — APVM's cache under concurrent processes (the orchestrator's; no suite change).

- Finding: writes are safe — `StoreLock` serialises them and they are atomic (V25) — but two
  processes that both miss the cache both build in full (V26; Q1b). A build killed at any point
  measured left the cache consistent, but left `.apvm-tmp-*` part-files and a 65–782 MB work folder
  in `TMPDIR` (V11). The library reacts to no signal: SIGTERM or SIGINT ends Node at once and
  orphans the build's children, which share its process group (V77). A kill during a private clone
  leaves the GitHub token in the work folder (V78). A pinned run starts no build (V176), so this
  concerns the orchestrator's builds and a manual run's artifacts setup, which builds in its runner.
- Recommended:
  - Each build runs in its own worker process, spawned detached (its own process group) with a
    private `TMPDIR` (mode 0700) under the orchestrator's state folder; progress and the result
    (0B.2) come back as JSON lines on its stdout.
  - Stop, cancel and timeout are all: SIGKILL the worker's group, then remove its `TMPDIR`. That is
    a working cancel today — the orchestrator's half of Q1a — and the cache stays consistent at
    every point measured.
  - On startup, kill the recorded worker groups still alive (checking each process's start time
    against PID reuse), sweep stale `TMPDIR`s, and plan interrupted builds again: a warm is
    idempotent — a complete entry is a cache hit, anything else rebuilds. systemd's cgroup kill is
    the backstop after a crash.
  - Upstream: §5 Q1a, Q1b, Q1d.
- Rejected: builds inside the orchestrator's process (no cancel and no timeout, a native crash takes
  the orchestrator down, and a crash orphans the build's children); relying on systemd alone
  (nothing for a live cancel, nor on developer machines).
- Not verified: on Linux, the shared `/tmp`'s exposure and systemd killing detached workers; whether
  APVM derives `~/.apvm` from `$HOME`; whether the CLI's `gc` sweeps part-files; a kill inside a
  build's store (only a release's store window was hit).

### 6.4 0B — What a run is given

0B.1 — a run's settings (done 2026-10-08).

- Finding: the suite loaded every key of `.env` — unknown ones included, from the working directory
  — into the runner and every worker, so blanking the known `E2E_*` vars, the first plan, blocks
  only those names (V81). Importing `run-context.ts` loads `.env` and stamps `RUN_ID` (V84).
- Decision: `E2E_LOAD_DOTENV=false` in the environment makes the suite skip `.env` in every process,
  and the orchestrator builds each run's environment from an allowlist (§6.2). The suite reads and
  applies the file itself (`util.parseEnv`, then each key the environment lacks, V163), so it reads
  the switch first and warns about a copy inside the file, where it is inert; an unreadable `.env`
  fails the run. A switch, not a path: should a secrets file ever be wanted, Node's `--env-file` on
  the spawn reaches the runner and every worker (V90).
- Rejected: blanking every known variable (an unknown key still leaks, V81); keeping the server's
  checkout free of `.env` (the first operator who writes one for a manual run or a healthcheck
  silently changes every orchestrated run); another working directory (it would skip `.env`, but
  Allure's results follow the working directory, V133).
- As built: configuration.md (`.env`, `E2E_LOAD_DOTENV`); `src/common/config/dotenv.ts`.
- Left: `CI="false"` or whitespace still turns CI mode on (V82); the allowlist never passes `CI`.
  BackWPup's storage credentials (`BWP_*`) reach every process from the environment or `.env` alike,
  but nothing consumes the product's `services` or a site's `overrides` yet — the merge
  configuration.md describes is not implemented (V87). When phase-6's 6H lands: implement the merge,
  or correct `types.ts`, configuration.md ("Any can be overridden per site") and the modernization
  plan; and 6H's skip gate must name the missing variable, so a credential the orchestrator does not
  pass cannot turn into a silently green run.

0B.2 — the build hands back its commit (suite side done 2026-10-08; consumption: the
orchestrator's).

- Finding (V16, V17, V176; proving it: V175, §6.9): APVM returns the full commit, a release's as
  `release-<tag>`; a moving ref's warm fills the cache a `commit:` pin hits; offline, a commit pin
  is a cache hit only given its version, and a release pin fails.
- Decision: each warm returns a `WarmedBuild` and its `Pin {ref, version?}`: `commit:<full sha>`
  with the version built (never the one requested: APVM's cache is keyed by commit and version), or
  `release:<tag>`, checked first (pinning a release to its commit would build the source, not the
  released zip). A release still named by a selector (`latest-stable`, APVM matches those ignoring
  case), no full SHA, or zips APVM failed to store fail the warm, so no run is left on a moving ref.
- Rejected: handing the run the cached zip as `E2E_PLUGIN_ZIP` (network-free too, but the run would
  record a provided zip instead of its ref and commit, undoing 0D).
- As built: plugin-artifacts.md "Pre-warming" (pinning); configuration.md ("Pinning a moving ref").
- The orchestrator (Phase 1+): plan each run's build through
  `warmArtifacts([unit], envFromTask, warmer)` — its environment is injectable — never through
  `readArtifactEnv()`, which reads its own `process.env`; hand the run `E2E_PLUGIN_REF=<pin.ref>`
  and, when set, `E2E_PLUGIN_VERSION=<pin.version>`, with the ref asked for in `E2E_REQUESTED_REF`.
  A release pin still needs network. Not verified: a cold `commit:` rebuild of a pull request from a
  fork once its cache entry is gone. Done when, live: a warm of a moving ref (`develop` or a PR),
  then a run pinned to its `Pin`, whose `run-facts.json` commit equals the warm's; and a
  commit-pinned run passes with the network denied (`sandbox-exec`, not a proxy: §6.9).

0B.3 — one product list (done 2026-10-05).

- Finding: `healthcheck.ts`, `warm-artifacts.ts` and `playwright.config.ts` each hard-coded the
  products, and a misspelt `PRODUCT` silently ran WP Rocket. Importing a product's config reads its
  sites files and `BWP_*`, so the environment must be final first (V84).
- Decision: `src/projects/products.ts` — outside `src/common/`, which must not import product code —
  with a drift-guard spec; a `PRODUCT` typo fails. The orchestrator imports only what
  `orchestrator/suite-imports.json` admits, and the product list only through `loadProductList`.
- Rejected: lazy `import()` loaders (every consumer imports both products; async loading complicates
  Playwright's and `bddgen`'s config for no gain at two or three products).
- As built: execution-model.md "The product list"; AGENTS.md "Improvement gate".
- Left manual, on purpose: CI's per-product smoke steps in `ci.yml` (a new product may have no
  `@noauth` scenario yet, and its step would fail "No tests found"); reminders in authoring-tests.md
  ("Adding a product") and above the steps in `ci.yml`.

### 6.5 0C — Stopping a run

Suite side done 2026-10-08 (the drain; the `@plugin` Before hook stopping running work first); the
orchestrator's first version in Phase 0.5.

- Finding: Playwright 1.63 stops gracefully only by timing (V8, V41–V47): one SIGINT abandons the
  running step, so the scenario's remaining steps run beside its teardown (V73), or the teardown is
  cut (V75); SIGTERM writes no report (V8); a kill leaves the site dirty for the next run to recover
  (V7, V74); the reports disagree on an interrupted scenario (V45); a shell can swallow SIGINT
  (V46); after a crash systemd SIGKILLs every run (V13).
- Decision: the drain (a suite change) — once the stop file exists, each scenario's first attempt is
  skipped (not retries, which would turn a failure into "flaky"), so the scenario in flight finishes
  and the reports stay true — then §6.2's escalation. The `@plugin` Before hook stops the product's
  running work first, within `LEFT_WORK_ALLOWANCE_MS` (V185), so recovering from a kill is complete.
- Rejected: a plain SIGINT as the stop (it abandons hooks, runs the remaining steps against a site
  being torn down, V73, and Cucumber never says interrupted); SIGTERM (no reports); the npm scripts
  (shell-dependent, V46); a second SIGINT (orphans the workers, drops the scenario); Playwright's
  internal `PWTEST_*` timeouts (not public API); the test server's `stopTests` (the same interrupt);
  gating `@plugin` scenarios only (misses the others); `KillMode=process` or a systemd scope per run
  (a restarted orchestrator cannot wait on processes that are not its children).
- As built: execution-model.md "Stopping a run: the drain"; AGENTS.md "Core concepts";
  `orchestrator/runs/stop.ts`, `shutdown.ts`.
- The orchestrator, recommended (Phase 0.5 built 1–6; 7 and 8 are Phase 1+):
  1. Spawn directly (§6.2).
  2. Stop now = one SIGINT to the runner's PID, when the drain's budget runs out or on request.
     Record the run as stopped by interrupt: its scenario in flight may have been cut, and the
     reports misstate it (V45).
  3. Kill = SIGKILL to the process group, never the runner alone. Record it killed; the results
     stream is then its only record.
  4. Never SIGTERM a run, never send a second SIGINT.
  5. Budgets, to tune from 0E's durations: drain 15 min (BackWPup adds 10 min per backup to a
     scenario's timeout); interrupt to kill 4 min (a 120 s hook, 30 s of fixtures, 30 s of browser
     close, the reports).
  6. Orchestrator shutdown: start nothing new; drain every run, interrupt, kill, exit. As built
     (`shutdown.ts`): the first SIGINT, or a SIGTERM or SIGHUP, drains for 15 min, then interrupts
     for 4 min, then kills; a second SIGINT interrupts at once, a third kills. Under systemd,
     `TimeoutStopSec` must exceed those budgets plus the settle — about 20 min; the default 90 s
     SIGKILLs every run mid-drain (the Phase 0.5 plan's systemd caveat). On restart, runs still
     recorded as running were killed by the crash (Phase 0.5 records a dead one as `lost` and
     refuses to start beside a live one, `orchestrator/state/orphans.ts`).
  7. Queued or building runs are cancelled by a stop; a build already under way still finishes into
     APVM's cache — it may serve other runs (§2 One build per artifact); cancelling it is 0A.5's
     kill, by request or on timeout (§5 Q3).
  8. After a kill, or an interrupt that landed in a hook, the site can hold the plugin, its
     footprint, gigabytes of partial archives on a shared disk, and the staged zip: run the suite's
     cleanup chain for that cell (`ensurePluginAbsent` → `removeSiteDbResidue` → `removeSiteResidue`
     → `cleanSiteStaging`) before anything else runs there, instead of waiting for the cell's next
     scenario.

### 6.6 0D — Reports say what they tested

0D.1 — up front in every report (done 2026-10-12).

- Finding: each report has one up-front slot — the HTML report's title (V52), a banner spliced
  before the Cucumber report's last `</body>` (V54), Allure's `--name` and `environment.properties`
  (V55); reporters get a shallow copy of their options and every `onEnd` runs before any `onExit`
  (V53); a reporter that throws turns a green run red (V67).
- Decision: a run-facts reporter after `list` and before the reports, writing `run-facts.json`,
  Allure's properties, the HTML title and metadata in `onEnd` (a kill before `onExit` keeps them)
  and the Cucumber banner in `onExit`; a missing fact says why, never blank; only whitelisted
  values, credentials masked; everything caught.
- Rejected: values at config time (evaluated before the setups, and again in every worker);
  `config.metadata` alone (collapsed, V52); a getter or a later mutation of a reporter's options
  (frozen by the shallow copy, V53); allurerc `variables` (read at generation only); Cucumber hook
  messages (they render below the scenarios); a "run info" test (it pollutes the counts);
  post-processing by the orchestrator (manual runs would miss it, and the HTML report's data is a
  zipped blob).
- As built: execution-model.md "Saying what a run tested"; configuration.md (`E2E_RUN_NAME`,
  `E2E_REQUESTED_REF`).

0D.2 — the full commit, and every zip's SHA-256 (done 2026-10-08).

- Finding: the suite stored `commitShort`; two builds of one commit are different files, so only a
  digest names the zip tested, and hashing costs 5–19 ms (V57).
- Decision: record the full commit (40 hex, else omitted: a release is named by its `pinRef`) and a
  SHA-256 of every resolved zip — the copy installed. The orchestrator, which stores a provided zip
  by its SHA-256, compares the two; no suite input needed.
- As built: plugin-artifacts.md; AGENTS.md "Plugin artifacts" ("What was tested").

0D.3 — the site's own versions (done 2026-10-09).

- Finding: Site Health's "Copy site info" text holds the web's PHP version and SAPI, the web server,
  and the WordPress and database versions, omitting WordPress's private fields (V58); WP-CLI's PHP
  differs on the nginx cells and `X-Powered-By` is absent (V28).
- Decision: read it in the auth setup after the login, cut down in the page to whitelisted lines (a
  traced call records what it returns, V313); best-effort, a failure is a warning, never a failed
  setup.
- As built: AGENTS.md (the auth setup's step 3); `src/common/setup/site-info.ts`.

0D.4 — no credential in a report (done 2026-10-09).

- Finding: Playwright titles a `fill()` with its value and has no masking (V194), so every report
  held the site password; a failed setup's trace holds `storageState()`'s result (V203); the failure
  snapshot `error-context.md` prints every field's value (V202); a scenario's retained trace holds
  the WordPress session cookies.
- Decision: secrets typed by `evaluate` and checked in the page (V195); the auth setup traces
  without DOM snapshots and turns its tests' failure snapshot off, back on only after a pass (a
  setup worker hands its changed variables to the scenarios' workers, V209); a failed or timed-out
  setup ends the sessions it saved; each run's setup ends the session the cell's previous run saved
  — not a `teardown` project, which would kill the login `--no-deps` reuses and does not run after a
  SIGINT (V204) — through `WP_Session_Tokens` (V220), the cookie recognised by its value's shape
  (V214).
- Rejected: a boxed `test.step` around `fill()` (hides nothing, V194); `pressSequentially` or
  `keyboard.insertText` (titled with the value too); redacting reports afterwards (Allure writes per
  attempt, the HTML report embeds zips, a missed format leaks); traces off everywhere (no
  diagnostics for the failures that need them); DOM snapshots off for the orchestrator's scenario
  traces (no live cookie, but no DOM or network to debug with) — ending the session won instead.
- As built: AGENTS.md ("No site password in a report; traces still need care"); authoring-tests.md
  ("Typing a secret"); the canary `src/common/auth/secrets.run.spec.ts`.
- Accepted: what AGENTS.md lists under "No site password in a report"; also a basic-auth `baseURL`
  in every trace's context options; the site username, typed by `fill()`, in every report (the auth
  setup's `Fill "<user>"` step in the HTML report's data and Allure's results); and the
  healthcheck's logins, never ended (they expire). Open, the user's choice: turning scenarios'
  failure snapshots off would hide those values but cost every failure its page context.
- Open (V137): `sites.ts` keeps `JSON.parse`'s error as the `cause` of a malformed sites file's
  error, and Playwright prints that cause, which can quote up to 10 characters of an unquoted value
  — on the terminal and in a run's `run.log`, whose last lines a run's reason quotes into Slack and
  Datator, masked only by known secret values. The orchestrator's own path drops causes
  (`ConfigError`, `loadProductList`); the healthcheck is unchecked. Keep only the position in
  `sites.ts`, or accept it.

### 6.7 0E — Machine-readable results (done 2026-10-12)

- Finding: the stream must be a configured reporter (V60); results arrive per attempt, and the
  dispatcher, not the reporters' guess, decides a retry (V61, V233); a failed setup's scenarios get
  no result at all (V63); no existing reporter streams (V64); where errors land (V62); step params
  and call logs can carry secrets (V62, V234); Playwright's own end of run names only the HTML
  report (V102).
- Decision: a JSON-lines reporter, schema v1, always on (decided with the user, 2026-09-28: it
  writes nothing to the terminal), `<report dir>/results.jsonl`, listed before the reports so
  `run.end` lands before their slow `onEnd`; never params, API steps, attachments, call logs or
  output; credentials masked. Manual runs get an end-of-run summary from the last reporter, printing
  in `onExit` (V53).
- Rejected: the JSON, JUnit, blob or Cucumber `message` reporters (end only, nothing on SIGTERM);
  tailing `allure-results/` (no finality, no totals, a format not ours); parsing the `list`
  reporter's text; final lines only (they lose "running now" and the retries).
- As built: execution-model.md "Watching a run"; `src/common/reporting/results-schema.ts`.
- Left: `npm run report:allure` opens a cell's newest results, not a given run's; a run-folder
  argument is a small follow-up.

### 6.8 0F — Report pruning (done 2026-10-12)

- Finding: a killed run's report folder looks like one in progress (V68); a pinned RUN_ID can be
  anything; a failed `rmSync` leaves a partial run (V108); dating by files' times is wrong — npm
  dates package files 1985 (V288), and generating an Allure report makes an old run look new.
- Decision (with the user, 2026-09-28): at most 20 reports per cell (FIFO, `E2E_REPORTS_KEEP`), none
  older than 30 days, but the newest complete one kept up to 182 days; empty runs (`--list`, no
  tests) never count. Each run prunes its own cell as it ends (pruning at the start instead cost a
  complete report to a run killed right after); `npm run report:prune` does every cell. A run is
  dated by its RUN_ID or its stream's `run.begin`, never by a file's time; a removal renames first.
- Rejected: the newest N per cell alone (a 5-minute loop would keep minutes of history); age alone
  (a retired cell loses its last report, a busy cell is unbounded); mtime as the age; a `.running`
  marker (a writer in every run, and stale markers to handle — the 1-day floor and the
  orchestrator's records cover it); deleting by default.
- As built: execution-model.md "Report retention"; configuration.md (`E2E_REPORTS_KEEP`).
- Left for the orchestrator: it prunes per task itself — several tasks can share a cell — at each
  run's end and on its schedule, also dropping each report's logs and zips, protecting its active
  runs and saving each run's summary from `results.jsonl` before the report goes (§3).
  `E2E_REPORTS_KEEP=0` lifts only the cap (V293): before the orchestrator prunes, the suite needs a
  separate switch turning its end-of-run pruning off, so no report goes before its summary is saved.
  Another run of the same cell still in progress is ranked under the cap like a killed one — the run
  contract forbids it. Risk: disk — 20 runs a day at the mean 4.3 MB keep about 2.6 GB per cell over
  30 days (per run: median 1.5 MB, p99 37 MB, at most 154 MB, over 153 real runs, 2026-09-28);
  measure on the server before settling the default (V278). The pruning has no time limit of its
  own: a hung filesystem holds the run's exit until the orchestrator's kill (a removal left
  half-done is finished by a later prune).

### 6.9 Traps

Non-obvious failures an audit found, not stated in the docs or the code:

- APVM's GitHub API client ignores `HTTPS_PROXY`, so a logging proxy cannot prove a run
  network-free: deny the network instead (`sandbox-exec`, V175).
- A spec's child process under `spawnSync` cannot be cut by the test timeout: run children
  asynchronously, with a limit of their own (V134).
- On a real cell each SSH command costs about 0.8 s, so a sweep that runs a few per leftover can
  overrun its hook: keep a sweep's command count independent of what it finds (V159).
- A paced BackWPup job (about 11 s) ends before a next run gets through `bddgen`, its setups and its
  worker's padding sweep, so a killed run's job never meets the next run's Before hook: lengthen the
  job first (500 empty `wp_e2e_audit_NNN` tables kept the paced dump running past start-up; drop
  them after), as the 0C live check L3'' did (V74).
- A WP-CLI call has no time limit of its own (`exec.ts`): a hung `wp` holds its caller until the
  hook's or the test's timeout. Bound a best-effort call with `withinBudget`
  (`src/common/deadline.ts`).

## 7. Phase 0.5 — The minimal orchestrator

Detailed in the [Phase 0.5 plan](orchestrator-phase-0.5-plan.md) — findings, decisions D1–D6,
verification rows; operating it: [`docs/guides/orchestrator.md`](../guides/orchestrator.md).

The smallest orchestrator that replaces AutoE2E's BackWPup instances: one foreground command,
`npm run orchestrator -- start`, kept in `tmux`, that cycles one or more cells (`loop` tasks only)
from a fixed JSON config. Each run builds its own plugin through the suite (no warm, no pin), runs
under the run contract (§6.2) and stops through the drain. One event, `run.finished` (§2), reaches
two subscribers: Slack, one message per run, and Datator, AutoE2E's payload for runs that tested.
Each piece is the first version of one §2–§3 plan, in the shape later phases extend. It relies on
every Phase 0 item but 0B.2. Out: systemd, the API, the dashboard, other task types, groups,
provided zips, the orchestrator's own builds.

## 8. Verification

Facts the design rests on, and decisions. V-ids are shared with the Phase 0.5 plan; ids missing here
were merged into another row, or dropped as history, superseded, or held by the docs and code.
Playwright line references are to 1.63.0's bundle, as in §6.1.

| # | Fact | Evidence |
| --- | --- | --- |
| V1 | `parallelIndex` is global per invocation — `0` to `workers - 1`, never shared by workers running at once — so one cell per run | Playwright docs and maintainers (microsoft/playwright#38953), rechecked in 1.63.0's `TestInfo.parallelIndex` docs; guarded in `project.ts` |
| V2 | `bddgen` generates every registered BDD config (the first in the main thread, the rest in worker threads), and each generation removes every `*.spec.js` in the cell's output folder before writing (`clearOutputDir`, then `saveFiles`) | playwright-bdd 9.2.1 (as 9.2.0) `dist/cli/commands/test.js`, `dist/generate/index.js:36–37`; 2026-09-24: one BackWPup `bddgen` gave all 10 specs of both cells new inodes; a folder no longer registered was left alone |
| V3 | A run empties the output folder of every project it selects (`filterProjects`: the projects named, never their dependencies; every project without `--project`); only the test server's UI and watch modes set `preserveOutputDir`. `--project` matches case-insensitively, each `*` a wildcard, everything else literal; an exact name matching nothing throws "Project(s) … not found", a wildcard only when the whole selection matches nothing. `.last-run.json` goes into the first selected project's output folder | Playwright 1.63.0 (as 1.62.1) `createRemoveOutputDirsTask`, `runner/index.js:2137–2177`, `:6398–6418`, `:6606–6614`; marker measurements 2026-09-24 and 2026-10-06; `cell-pin.spec.ts` checks the installed `filterProjects` |
| V4 | The dev cells `pro@nginx` and `free@nginx` share host `qa-lnmp` with the orchestrator worktree's `bwu2` (Free) and `bwu3` (Pro): four BackWPup docroots (3.6, 2.6, 0.16 and 2.9 GB) on one volume | Sites files; 2026-09-24: 84 % full, 17 GB free (phase-6 V72 had 20 GB) |
| V5 | Two WordPress servers: AutoE2E's `backwpup@nginx` and `wp-rocket@nginx` on the nginx one (`qa-lnmp`, also the dev cells'), `backwpup@apache` and `wp-rocket@apache` on the apache one; of our cells only `pro@apache` was AutoE2E's (its instance stopped 2026-09-28). Up to about four parallel suites per server are fine; name the sites a run uses first | The operator, 2026-09-28 |
| V6 | Side-by-side runs on one host stay reliable — open, to measure (0A.3) | — |
| V7 | A mid-scenario kill leaves the plugin installed and the next run recovers; killing only the Playwright parent lets its worker finish the teardown (within 30 s, V43) | Live on `pro@apache`, `pro@nginx`: phase-6 V53, V61 |
| V8 | Playwright on signals. First SIGINT to the runner: it stops dispatching and stops its workers, which abandon the running step or hook, run the After hooks and fixture teardown, close the browser and exit; the runner writes every report and exits 130. SIGINTs within 1 s count once; a later second one makes the runner write its reports and exit while its workers finish orphaned (up to 30 s), the scenario reading "did not run". SIGTERM: no handler — the runner dies at once, with no HTML or JSON report and a 0-byte Cucumber file. Workers ignore both signals and exit when the runner's IPC channel closes | `runner/index.js:6045–6111`, `:6136–6190`, `:2017–2037`, `:6313–6316`; `common/index.js:1916–1962`; lab cases 01–06, 26 (2026-09-25) |
| V9 | A cold BackWPup build takes minutes: 13.7 min once, 5.4 min for `pro-en` alone | 13.7 min: an earlier real build; 5.4 min: 2026-09-23, `develop` @ `f1ebfd0`, twice (V17, V20) |
| V10 | A multi-variant warm serves each cell's single-variant `build()` from the cache: per-variant zips sit side by side under `<project>/commits/<version>/<commit>/`; APVM's `origin` reports partial builds | A real cache, 2026-07-28 |
| V11 | APVM's cache stays consistent after a build killed mid-way: 7 build kills (SIGKILL, SIGTERM, SIGINT — in the clone, in composer, 71 ms after `build_succeeded`) and 8 kills of a release's store at 0–30 ms left no row without its file nor file without its row, SQLite's integrity check `ok`, every re-warm byte-identical, one entry at the end. A kill leaves `.apvm-tmp-*` part-files in the cache (no later store removes them) and a 65–782 MB work folder in `TMPDIR` (handled failures clean theirs up) | Throwaway caches, runs K1–K8b, 2026-09-25, apvm-napi 3.0.0 |
| V13 | systemd `KillMode=mixed`: a stop signals the main process only; the kill stage signals the whole cgroup — so after a crash, with nothing left to SIGTERM, the cgroup is SIGKILLed at once | systemd `unit_kill_context()` (`unit.c`), `service.c`, via Context7; the server's systemd version not checked |
| V14 | PM2 stops with SIGINT, then SIGKILL after 1.6 s by default; `pm2 startup` generates a systemd unit | pm2.keymetrics.io, via Context7 |
| V15 | APVM's `build()` / `warmCache()` take no cancel, abort, signal or timeout option | `apvm-napi` `index.d.ts` 3.0.0, byte-identical in 3.2.0 (V19) |
| V16 | `warmCache()` and `build()` return a `JsBuildOutput`: the full `commit` (equal to `resolvedRef.commitSha`) beside `commitShort`, `branch`, `description`, `fromCache`, `resolvedRef` and `result` (`version`, `artifacts[]` with `variantId`, `path`, `filename`, `size`, `origin`) — no digest (the cache's database has one). A release's `commit` is `release-<tag>`, with no `commitSha`. A git build always reports the full SHA, an annotated tag peeled; `commit:` takes 7–40 hex. A later `build()` of the same ref is a cache hit | `index.d.ts` 3.0.0; a cold `develop` pro-en build (318.6 s) returned `f1ebfd05…`; `release:latest-stable` returned `release-5.7.6` |
| V17 | A `commit:<sha>` build is served from the cache a warm of a moving ref (`develop`, `pr:N`) filled at that commit | 2026-09-23: a `develop` warm built `f1ebfd0` (325 s); `commit:f1ebfd0…`, planned by the suite, came from the cache in 0.9 s, the same zip. 2026-10-08: again 0.7–0.9 s, same SHA-256; `release:5.7.6` hit the entry a `latest-stable` warm filled |
| V18 | A cache hit through the Node library refreshes an entry's last use, so `cache clean --older-than` keeps it | 2026-09-23: after 75 s unused, `cache clean --older-than 1m --dry-run` listed the build, after one library hit none; the CLI (3.2.0) read the cache the library (3.0.0) wrote; the storage crate's `CleanOptions.older_than` spares recently hit entries |
| V19 | The Node library has no cache clean, in 3.0.0 or 3.2.0; the CLI's `cache clean --older-than <d>` removes entries unused within the window (units `m h d w`; `--dry-run`, `--project`, `--builds`/`--releases`). Cleaning lives in the Rust storage crate — `ArtifactStore::clean(CleanOptions { project, older_than, target, dry_run }) → CleanReport { builds_deleted, releases_deleted, bytes_freed, failures }`, plus `usage`, `gc`, `verify`, `repair` — which only the CLI calls | 2026-09-23: both versions loaded, identical runtime exports, byte-identical `index.d.ts`; `apvm cache clean --help` (3.2.0) |
| V20 | A plain `build()` through the Node library fills the cache by itself — no `warmCache`, no CLI | 2026-09-23, throwaway cache: `release:latest-stable` (5.7.6) downloaded, then from cache in 0.48 s; `develop` @ `f1ebfd0` built in 324 s, then 1.0 s |
| V21 | A build that cannot reach GitHub throws `GenericFailure` carrying git's own message | 2026-09-23: `git clone`/`ls-remote` failed after the 75 s connect timeout, one GitHub address (`140.82.114.4`) unreachable from the runner |
| V23 | AutoE2E posts one Slack message per cycle through an incoming webhook — `✅`/`❌`, counts, failed "Feature - Scenario" names, `WordPress: x \| PHP: y` (WP-CLI over SSH: `wp core version`, `wp eval "echo PHP_VERSION;"`), an `scp` command for the Cucumber HTML, an optional `AUTO_E2E_INSTANCE_NAME` prefix, and "❌ Auto E2E Script Error!" when a cycle crashes — and posts each run to Datator (`X-API-Key`: product, suite, start time, counts, full commit, duration, per test feature / name / status / error). Since `fa0a5b6` (2026-10-02) it also sends `website_url` (V115) | `wp-media/auto-e2e` @ `be4ed43`: `auto-e2e.js` (`sendSlackMessage`, `getSiteVersions`, `sendDataToDatator`, `analyzeCucumberReport`), `.env.example`, README |
| V25 | APVM's store serialises writes across processes — `StoreLock`, a blocking `flock` on `<cache>/.apvm.lock`, held by `store()`, `delete_build()`, release storage and maintenance; writes go through temp files + `persist`; SQLite in WAL with a 5 s busy timeout and upserts — but nothing is held from the cache lookup to `store()` | APVM `cli/v3.2.0`: `crates/storage/src/{lock.rs, store.rs:157, store.rs:398, fsx.rs, db/builds.rs}`; lookup `crates/core/src/commands/build.rs:353` (`find_by_commit`), store `:2158` |
| V26 | Two processes building the same thing at once both run the full build; the store stays consistent | 2026-09-24, throwaway cache: two `build()`s (`develop`, `pro-en`) started together both missed the cache at 1 s and both cloned, checked out and ran composer; one finished (278 s), the other died in `composer install` while GitHub was flaky (V21), which proves nothing; a third build came from the cache (2.5 s, same SHA-256); one entry |
| V27 | tokio's `Command::kill_on_drop` defaults to false, and APVM's step runner sets neither it nor a timeout, so dropping a build leaves its processes running | docs.rs `tokio::process::Command::get_kill_on_drop`; APVM `crates/core/src/build/runner.rs:184–198` (`sh -c … .output().await`) |
| V28 | The site's own PHP version comes from Site Health → Info, not WP-CLI and not `X-Powered-By` (absent everywhere). The "Copy site info" text (debug format, stable keys) gave `php_version` 8.5.10 on `pro@nginx`, `free@nginx`, `bwu2` and `bwu3` — where `wp eval "echo PHP_VERSION;"` answers 8.3.33 (`/usr/bin/php8.3`) — and 8.3.33 on `pro@apache`, where the two agree; `php_sapi` `fpm-fcgi` everywhere; nginx 1.24.0 / Apache 2.4.58; WordPress 7.1.2 (WP-CLI agrees); MySQL 8.0.46 / MariaDB 10.11.14. About 1–1.3 s after login; read-only. By 2026-10-09: WordPress 7.1.3, PHP 8.5.11 on `bwu2`/`bwu3` | Live, logged in, 2026-09-24/25 and 2026-10-09 |
| V29 | Two runs of different cells of one product started together fail: 2 of 80, one `bddgen` crashing (`ENOENT`) on a spec the other had deleted; staggered 0–5 s, 0 of 80. Re-measured through `npm run test:wp-rocket`: unpinned 4 of 80, pinned (`E2E_CELL`) 0 of 80 | Placeholder wp-rocket cells, 40 iterations per mode, 2026-09-25 and 2026-10-06; playwright-bdd `generate/index.js:31–38`, `:124–130` |
| V30 | A regeneration leaves a cell's specs missing for 2–11 ms (p50 3.8); a collection overlapping it fails with `Cannot find module` (1 of 10 runs under a regeneration loop). Workers run the code compiled at collection: a rewritten spec is harmless, only a missing one breaks a worker that loads it | A poller over 30 generations; `common/index.js:135–141`, `:1262–1264`; `runner/index.js:5597` |
| V31 | `bddgen` accepts no `--project` (`unknown option`) and never sees `-- --project`: npm passes `-- args` only to a script's last command (`bddgen`'s argv is `--config …`); `npm run x --cell=…` fails (`EUNKNOWNCONFIG`). An environment variable reaches `bddgen`, the runner and every worker | npm 12.0.2; probes |
| V34 | Deleting a project's output folder mid-run loses the attachments made before it from all three reports; a missing attachment file (a failed attempt's screenshot, a file attached by path) crashes the Cucumber reporter, failing a run with no failed test (V67) | `runner/index.js:3801–3809`; playwright-bdd `attachments/external.js:52–90`; control against deletion runs |
| V36 | `qa-lnmp`: 4 vCPU, 14.6 GB RAM; 97 GB disk, 17 GB free; MySQL 8.0.46 (`max_connections` 151, peak 118); one PHP-FPM 8.5 pool for every 8.5 site (70 children, `max_execution_time` 30 s, 128 MB); 26 docroots, about 22 of them other people's | 2026-09-25: `nproc`, `free`, `df`, `SHOW VARIABLES`/`STATUS`, `pool.d/www.conf`, `/var/www/html` |
| V38 | AutoE2E runs four instances — `auto-e2e-bkwp`, `-bkwp-apache`, `-wpr`, `-wpr-apache` — whose sites are defined only on its server | `wp-media/auto-e2e`: `scripts/manage-e2e/manage-e2e.sh:25–39`, README |
| V39 | `loadSites` accepts one site listed by three cells (`baseURL` differing in case and a trailing slash, `rootDir` in a trailing slash), keeping the values verbatim; it rejects only a cell defined in two files | A scratch sites file through the real loader, 2026-09-25; no such check in `sites.ts` on 2026-10-18 |
| V41 | An interrupt abandons the running step or hook without cancelling it: landing in a step, the teardown runs beside it; in the Before hook, the install goes on past the teardown; in the After hook, the teardown is cut short | Lab cases 01, 18, 22; `workerProcessEntry.js:376–379` |
| V42 | Under an interrupt the After hooks get max(project, test timeout), capped at 120 s by playwright-bdd; fixtures share 30 s. SIGINT to exit: 26.5 s with a 20 s After hook, 128.4 s with a 130 s one | Lab cases 10, 10b, 29; `workerProcessEntry.js:1661–1663`, `:1855–1857`; playwright-bdd `hooks/scenario.js:70–82` |
| V43 | Once their runner dies, workers finish gracefully within 30 s (internal `PWTEST_FORCE_EXIT_TIMEOUT`); killing only the runner cuts a longer teardown | `common/index.js:1917`, `:1953–1958`; lab cases 03, 07, 09, 09b, 09c |
| V44 | SIGKILL to the process group ends the runner, workers and browsers at once; only finished tests' Allure results and a 0-byte Cucumber file remain | Lab case 08 (macOS); Linux not checked |
| V45 | The reports disagree on an interrupted scenario: Playwright interrupted, JSON skipped, Allure failed; Cucumber never says interrupted — passed in the lab, failed live with V73's error | Lab case 01; playwright-bdd `messagesBuilder/TestStepRun.js:116–140`; live L1 |
| V46 | npm and npx forward SIGINT and SIGTERM to their child, but through the suite's `bddgen && playwright test` scripts macOS's bash 3.2 kept SIGINT from the runner (the run finished, exit 0); dash execs the runner | Lab cases 11–15b, npm 12.0.2 |
| V47 | The process group outlives the runner while orphaned workers tear down; `kill(-pgid, 0)` → `ESRCH` marks the end | Lab case 26: runner gone at 18.9 s, group empty at 39.4 s |
| V52 | The HTML report's only up-front slot is its title (`title` option or `PLAYWRIGHT_HTML_TITLE`, read in its own `onEnd`; one line, newlines collapse). `config.metadata` sits in a collapsed panel, keys other than Playwright's shown only with `#?show-metadata-other` in the URL; `actualWorkers` stays hidden | `runner/index.js:3471–3485`; `htmlReport/report.js`; rendered |
| V53 | Reporters are built in config order from a shallow copy of their options (a later mutation does not reach them). Every `onEnd` is awaited, in order, before the first `onExit`; `onExit`s run in order; a throw in either sets `hasReporterErrors`. So `config.metadata` and `PLAYWRIGHT_HTML_TITLE` set in an earlier reporter's `onEnd` reach the HTML report, and setup attachments reach `onTestEnd` even when the setup then skips or fails. On SIGINT `onEnd` and `onExit` still run, on SIGTERM neither. Terminal order: first reporter's `onEnd`, `list`'s lines, last reporter's `onEnd`, first reporter's `onExit`, the HTML hint, last reporter's `onExit` — on a pass, a failure, a failed setup and a SIGINT | `runner/index.js:5208–5220`, `:1642–1653`, `:6310–6320`; marker reporters |
| V54 | The Cucumber report has a fixed header (runtime, OS), no title or metadata option, omits non-BDD projects (the setups), and is complete by the end of its `onEnd`. Its file ends `</script>\n</body>\n</html>`, its messages escape `<` as `\x3C` and its bundle holds no `</body>`, so the last `</body>` is the document's; a banner inserted there and moved to the top renders above the header, in both modes and with no scenario run | playwright-bdd 9.2.1 `messagesBuilder/Meta.js`, `reporter/cucumber/index.js:46–58`, `reporter/cucumber/html/index.js`; html-formatter 23.1 `CucumberHtmlStream.js`, `index.mustache`; rendered |
| V55 | Allure 3.18 shows `allure-results/environment.properties` as the front page's Metadata (in file order, 8 visible) and `--name` as the header. allure-playwright 3.12.2 writes that file only when `environmentInfo` is set, never empties its results folder, and replaces files by temporary file + rename | allure-js-commons `ReporterRuntime.js:409–413`, `FileSystemWriter.js`; rendered |
| V57 | Two builds of one commit are different files (`languages/backwpup.pot` is regenerated at build time; 1,070 entries' mtimes differ): only a SHA-256 names the zip tested. Hashing a BackWPup zip costs 5–19 ms | The main checkout's `pro@nginx` and `pro@apache` zips at `f1ebfd0`, `shasum` |
| V58 | After login, `wp-admin/site-health.php?tab=debug` holds the "Copy site info" text on exactly one button (`getByRole('button', { name: 'Copy site info to clipboard' })`), in `data-clipboard-text`: about 6.5 KB, 13 `### section (N) ###` blocks of `key: value` lines (lists tab-indented) between backtick lines — `WP_Debug_Data::format()` — ready 1.3–1.4 s after login. It omits WordPress's private fields (database user, host, name) but holds paths, `WP_HOME`/`WP_SITEURL`, the user count, plugin names; the tab's hidden DOM still holds "Database username". The page's own `directory-sizes` REST request (89–223 ms) can be aborted with the text intact | Live `bwu2`, `bwu3`, 2026-09-25 and 2026-10-09 |
| V60 | Reporters run only in the runner — also under `--list` and for "No tests found" (exit 1), each leaving a report folder of about 1.5 MB; a command-line `--reporter` replaces the configured list. `onBegin`'s total includes the cell's setup tests whatever `--grep` says; `config.projects` holds every cell. Every reporter's options carry `_mode` (`list` under `--list`, else `test`), undocumented — nothing else tells `--list` from a run interrupted before its first test | `runner/index.js:5195–5260`, `:6308–6317`; probes; `results-stream.run.spec.ts` guards `_mode` |
| V61 | `onTestEnd` fires per attempt; an interrupted attempt reads `outcome() === "skipped"` and is never retried. Playwright's reporters guess a retry as `outcome() === "unexpected" && results.length <= retries`, which is not what the dispatcher does (V233) | `runner/index.js:1295–1297`, `:605–631` |
| V62 | Each Gherkin step is a `test.step` titled with its keyword; a Background's steps sit under `Before Hooks › Background`; a hook's error on `Before/After Hooks › BeforeEach/AfterEach Hooks › <hook>` (a named hook titled by its name); a fixture's on `Before Hooks › Fixture "<name>"`; a hook timeout on `BeforeEach Hooks`, none on the hook; a step timeout or a crash (`worker process exited unexpectedly`) leaves no step error; a skip puts `Test is skipped: …` on its step. Messages carry ANSI codes; `TestStep.params` can carry `fill()` values | Playwright 1.63, playwright-bdd 9.2: probe runs, a step-tree reporter; `testReporter.d.ts:880–905` |
| V63 | A failed setup gives the cell's scenarios no `onTestEnd` at all | Probes |
| V64 | The JSON, JUnit, blob and playwright-bdd Cucumber reporters (its NDJSON `message` one included) write only in `onEnd`; allure-playwright writes per attempt, with no final status, flaky flag, totals or end | `runner/index.js:4064`, `:4292`, `:3087–3135`; playwright-bdd `reporter/cucumber/index.js:46–52` |
| V66 | `test.id` is stable across runs of one cell and differs across cells | 12 of 12 identical across two runs |
| V67 | A reporter that throws is caught but flags the run: `result()` returns `failed` with no failed test | `runner/index.js:1673–1679`, `:6290`; a passing run whose attached file was deleted exited 1 |
| V68 | A killed run's report folder has no `playwright/` and a 0-byte `cucumber/index.html` (created at start, filled in `onEnd`) — the same as a run in progress | 6 of 153 real runs |
| V70 | `bwu2`/`bwu3` match `bwu`/`simple` — WordPress, the PHP-FPM pool, the nginx vhost, debug constants, ownership, `sudo` — except in cron (until 2026-09-30, §6.1), Imagify, Query Monitor and, on `bwu2`, `bigFiles`; healthcheck 7/7 on both | Live 2026-09-24/25: WP-CLI, vhosts, `wp-config.php` constants, `du` |
| V71 | On a site without `DISABLE_WP_CRON`, one plain WP-CLI command runs a due WP-Cron event within 4 s, while no outside traffic ran it in 20 s | Live `bwu2`: a probe event, checked by processes that cannot spawn cron (`--exec` defines the constant for them) |
| V72 | While a job runs, BackWPup reschedules a `restart` event every 60 s; its Information page shows "Disabled WP Cron" | BackWPup `inc/class-cron.php:23`, `inc/class-page-settings.php:270` |
| V73 | One SIGINT mid-job during a real `@plugin` scenario (`free@nginx`, L1): exit 130 after 21.4 s; the After hook stopped the job and removed everything; every report written. But the abandoned body ran on to its last step, which queried BackWPup after the teardown had removed the plugin (`'backwpup' is not a registered wp command`), and that error became the scenario's in every report — nowhere "interrupted" | Live 2026-09-25, BackWPup `develop@af1ab5c`; the site's state before and after |
| V74 | A SIGKILL of the run's group mid-job (L3) left the plugin active, its whole footprint (26 options, `wp_bwpup_backups`, 3 roles, 11 capabilities), both data folders and the staged zip; the cell's next normal run restored the site. Killed while the job still ran (L3', L3''), the next run's Before hook found the job and stopped it before the removal | Live 2026-09-25 and 2026-10-08, `bwu2`/`bwu3` |
| V75 | A SIGINT landing inside the After hook, after the uninstall (L4), exited 130 in 0.8 s, left the plugin's data folders (on a files job, gigabytes on a shared disk), and reported a scenario whose steps all passed as interrupted; the worker's teardown still removed the staging area | Live 2026-09-25 |
| V77 | APVM's library reacts to no signal: SIGTERM or SIGINT ends the Node process within 4 ms and orphans its children (composer ran on 27 s, and about 120 s with a download); they share the build's process group, so a SIGKILL of the group leaves no survivor; work folders follow `TMPDIR` | Runs K2, K4, K5, K7, K8, K8b, 2026-09-25 |
| V78 | A kill during a private clone leaves the GitHub token in `<TMPDIR>/backwpup-XXXXXX/backwpup-pro/.git/config` (mode 0644, folders 0755), for good; once the clone completes APVM cleans the URL | K1, K5, K7 (×3); the exposure on a Linux server's shared `/tmp` not checked |
| V81 | `.env` as the suite loaded it before 0B.1 (`process.loadEnvFile()`): every key, unknown ones included, from the working directory, into the runner and every worker; a real variable wins, even a blank one (Node fills only missing keys); a missing, unreadable or malformed file was silently ignored. Blanking named keys blocks only those | Node 24.21; probes |
| V82 | The suite's `CI` check counts `"false"` and whitespace as set | `project.ts` (`isCI`, non-empty); probes; unchanged on 2026-10-18 |
| V83 | A private product's run asks APVM for a token even when its build is a cache hit (`GITHUB_TOKEN`, `GH_TOKEN`, then `gh`), and the suite never sets APVM's cache folder (`~/.apvm/cache`): a run shares the orchestrator's `HOME` and cache | `resolve.ts`, `apvm.ts` |
| V84 | Importing `run-context.ts` — and so `resolve.ts`, `consume.ts` or `project.ts` — loads `.env` and stamps `RUN_ID`; `products`, `warm`, `verify` and `sites` do neither; a product config's import runs `loadSites` and reads `BWP_*` | An import-effects probe, 2026-09-25 |
| V87 | BackWPup's `BWP_*` are read when its product config is imported, in every process of a run (`bddgen`, the runner, each worker), from the environment or `.env` alike (with `E2E_LOAD_DOTENV=false`, only the environment's; a site's `overrides` still load from the sites file). Nothing reads the product's `services` or a site's `overrides`: the documented merge is not implemented, no scenario uses storage credentials, and a missing one changes nothing | `backwpup.config.ts`; a search of `src/`, `scripts/` and the entry configs (only `sites.ts` validates them); a run with none, exit 0; still so on 2026-10-18 |
| V90 | Node's `--env-file` on the runner's spawn reaches the runner and every worker | Probe |
| V91 | execa gives its children the whole `process.env`, so an environment-borne credential reaches local `wp` and docker children from either source; SSH forwards nothing | execa `lib/arguments/options.js:53`, `:92`; `exec.ts` |
| V102 | Playwright's own end of run names only the HTML report, and only with a TTY stdin, `CI` unset and a test run; logs and piped output name none | `runner/index.js:3486–3503`; captured ends |
| V108 | A failing `rmSync(…, { recursive: true })` is partial (it had already deleted a run's `playwright/`); it unlinks a link inside a folder, and a link to a folder, leaving the target intact; `renameSync` of a missing path throws `ENOENT` | Node 24.21: a locked-folder run; lab |
| V110 | Node 24.21 strips types natively ("Stability: 2 - Stable"), but not for the suite's modules: 0 relative imports under `src/` carry `.ts`, 518 carry no extension, and an extension-less `import "./b"` fails `ERR_MODULE_NOT_FOUND` | 2026-10-05; `typescript.md` at v24.21.0 |
| V111 | `node:sqlite` works on Node 24.21 with no flag or warning; documented "Stability: 1.2 - Release candidate" | 2026-10-05: `DatabaseSync(":memory:")` create/insert/select, SQLite 3.53.4, nothing on stderr; `sqlite.md` at v24.21.0 |
| V112 | `@hono/node-server` listens on a Unix socket (`createAdaptorServer(app).listen(path)`) and serves static files (`serveStatic`) | honojs/node-server README and API reference, via Context7 |
| V113 | Over plain `http://localhost` / `http://127.0.0.1` (what an SSH tunnel gives the browser), Chromium and Firefox keep a `Secure` (and `__Host-`) cookie; WebKit drops it and keeps only the non-`Secure` one. All three report a secure context | 2026-10-05: Playwright against a Node server on `127.0.0.1`, Chromium 153, Firefox 155, WebKit 26.6, both hostnames; browser side only — a real tunnel is checked when the dashboard exists |
| V130 | Importing `products.ts` in a fresh Node (tsx, only `PATH` and `HOME`) from a folder whose `.env` sets a sentinel changes no environment variable; `run-context.ts`, `resolve.ts` and `consume.ts` each load the sentinel and stamp `RUN_ID`; each probe takes under 1 s | 2026-10-05: the products spec's child probe, and by hand |
| V133 | Playwright resolves a config's own paths (globs, output and report folders) against the config's folder, so a run started from another working directory works; but allure-playwright's relative `resultsDir` and a relative `storageState` resolve against the working directory, and `.env` is read from there | 2026-10-05: a copy of the worktree run from an empty folder with a sentinel `.env`; Playwright 1.63.0 docs (`browserContext.storageState`), via Context7 |
| V134 | Under `spawnSync`, a spec's child that never exits held its test 61 s, past the 30 s test timeout; under async `execFile` with a 15 s limit it fails at 16 s (`killed after 15000 ms`) and leaves no process | 2026-10-05, a probe test |
| V135 | ESLint's `no-restricted-imports`, and typescript-eslint's, flag no dynamic `import()` (exit 0); a `no-restricted-syntax` `ImportExpression` selector does. `ts.preProcessFile` (TypeScript 6.0.3) reports static, `import type`, side-effect, `export … from`, `export *`, dynamic, template-literal and `typeof import()` forms, and nothing from a comment or a string | 2026-10-05: a probe file linted, a scanner probe per form |
| V137 | Most of Node 24.21's `JSON.parse` errors name only a position ("Expected ','…", "Bad control character…", "Unexpected end"), but an unexpected token is quoted with the 10 characters before it and the 10 from it (a source of 20 characters or fewer, whole): `..."assword": hunter2sec"...`. So a malformed sites file's error `cause` can carry a fragment of an unquoted value, and Playwright 1.63 prints a config-load error's `[cause]`: a run on such a file shows it on the terminal and in its log (the orchestrator's `ConfigError` drops causes for this reason) | `node -e` probes, 2026-10-05; the quoting found 2026-10-18; Playwright 1.63.0 config-load probe (a config throwing the `sites.ts` error shape), 2026-10-19 |
| V159 | Over SSH to `bwu3`, each `exec`, `execElevated` or `readlink -f` takes about 0.78 s (n = 10 each): a sweep issuing a few commands per leftover overran a 120 s teardown at 28 leftovers. `find -H … -type d` never lists a linked member and follows a linked parent; `readlink -f` with several operands drops those it cannot resolve | 2026-10-07; GNU on `bwu3` (coreutils 9.4, findutils 4.9.0) and BSD (macOS 26.7) |
| V163 | `util.parseEnv` reads a file as `process.loadEnvFile()` does — a duplicate's last value, `export`, quotes, multi-line values, comments, a leading BOM kept in the first key's name — but not in the file's order; both stable since Node 24.10.0. On a directory `loadEnvFile` throws `ERR_INVALID_ARG_TYPE`, `readFileSync` `EISDIR`; a dangling link reads as `ENOENT` (`lstat` finds it). `process.env` inherits `Object.prototype`, so `"toString" in process.env` is true: presence needs `Object.hasOwn` | Node 24.21.0, scratch files (the BOM rechecked 2026-10-18); the docs' history tables |
| V175 | APVM's GitHub API client ignores `HTTPS_PROXY`: through a logging CONNECT proxy, pinned `commit:` and `release:` runs logged nothing, while the same `release:5.7.7` run fails under `sandbox-exec` with `GitHub API error: … (Connect)`. The proxy does see git (`develop`, `tag:latest-stable` → `github.com`) and a cold release download (`api.github.com`, `release-assets.githubusercontent.com`) | 2026-10-08; `sandbox-exec` with `(deny network-outbound (remote ip "*:*"))`, which refuses `curl` |
| V176 | With all outbound network denied: BackWPup `commit:` pins (of `develop`, and of tag 5.7.7) given version 9.99.99 and their variant are cache hits (7–9 ms); WP Rocket `commit:3a96b66…` without a version detects its version, then clones and fails, and with its built version `3.23.5.1` is a cache hit; `release:5.7.7` fails on GitHub's API. A whole commit-pinned run (`bddgen`, the runner, the artifacts setup) passes sandboxed; a release-pinned one fails naming the API error | 2026-10-08; APVM `cli/v3.0.0` `crates/core/src/commands/build.rs` (`try_cache_fast_path` needs the version or `detect_version_pre_clone`), `git/resolver.rs` (`resolve_commit` tolerates an API error, keeping the SHA) |
| V179 | The installed apvm-napi 3.0.0 darwin-arm64 binary is the one APVM's `cli/v3.0.0` builds (same SHA-256): read APVM's source at that tag | 2026-10-08; a local checkout was at `cli/v3.2.0-6` |
| V185 | playwright-bdd times a hook with `Promise.race` and never cancels it: a hook past its timeout runs on beside what follows. The `@plugin` Before hook's worst case — BackWPup's stop (30 s + 30 s + probes, about 70 s) beside a 44–73 s install — exceeded its 120 s, hence `LEFT_WORK_ALLOWANCE_MS` (90 s on top) | playwright-bdd 9.2.1 `dist/utils/index.js:63–73` (`callWithTimeout`); live 2026-10-08 |
| V194 | Playwright 1.63 titles a `Fill`/`Type`/`Insert` step with its value (`renderParams`) and passes it in the step's params; `box: true` hides nothing; there is no masking API — the docs say to treat traces and reports as sensitive | `playwright-core` `coreBundle.js` metainfo; lab; Context7 `/microsoft/playwright/v1.63.0` |
| V195 | Entering a value with `locator.evaluate` (the native `value` setter, then `input` and `change`) leaves no step title, param or Allure entry, and `evaluate`'s argument is in no trace entry; the trace still gets the value from the next action's DOM snapshot and from `inputValue()`'s result. With the check made in the page and `snapshots: { dom: false }` — which also empties every `.network` entry — reporter steps, Allure and the trace are clean | Labs scanning each channel for a canary value; the live failed-setup trace, 2026-10-09 |
| V202 | On a failed test, Playwright 1.63 writes the page's accessibility tree into `error-context.md` — every textbox's value, a password field's included — when a context is still open at the test's end (a setup timing out mid-login); every report copies it. `PLAYWRIGHT_NO_COPY_PROMPT` (undocumented, read per worker in `_takePageSnapshot`) turns it off | `playwright/lib/index.js:657–674`; the canary before the fix |
| V203 | `storageState()`'s result is a traced call: the cookies are in the trace with DOM snapshots off, and in its network entries too with them on | The canary's trace entries |
| V204 | A `teardown` project runs after its setup's dependents, also when one fails or a sibling setup fails, and with `--project=setup:<cell>` alone; not with `--no-deps`, and not after a SIGINT | Lab: a scratch config, six selections and one SIGINT |
| V209 | A setup worker hands every variable it changed to its dependent projects' workers (`__env_produced__`, diffed at `__stop__`, before worker fixtures tear down); and a failed test's `afterEach`/`afterAll` run before its failure snapshot is taken. So a switch set in a setup file reaches the scenarios, and one restored in `afterAll` is restored too early | `common/index.js:1913–1934`, `runner/index.js:6556–6576`; labs |
| V214 | The cells' auth cookies are host-only, value `login\|expiration\|token\|hmac`, the token 43 alphanumerics, the HMAC 64 hex on the cells (40 also occurs; the matcher takes both); the name `wordpress_logged_in_…` is only a default (`LOGGED_IN_COOKIE`). PHP's `setcookie` encodes with `rawurlencode`: a space as `%20`, `+` as `%2B`, `\|` as `%7C` | Live `bwu2`'s saved login (lengths and classes only); PHP 8.1's built-in server and `curl -D -` |
| V216 | `wp --skip-plugins` still loads the must-use plugins; `session_token_manager` is `WP_User_Meta_Session_Tokens` on both cells, plugins loaded or skipped | Live, `get_included_files()` on `bwu2`, `bwu3` |
| V220 | `WP_Session_Tokens::get` returns `null` for an unknown or expired session (`is_still_valid`); `destroy` unsets that verifier alone | `class-wp-session-tokens.php:82–85, 172–175, 202–204`, `class-wp-user-meta-session-tokens.php:61–64, 74–80`, WordPress 7.1.3 |
| V230 | BackWPup Free (`develop` @ `1dceea8966`) left about 25 options after its deletion on `bwu2`, failing the plugin-deletion scenarios there, which had passed on 2026-10-06 and -07; the same without the 0E change (an A/B run) — a product or site matter, reported, not investigated | Live 2026-10-12 |
| V233 | Playwright's dispatcher retries a test in `_failedTests` — a failure, or a skip Playwright imposed (after a failed `beforeAll` or a worker crash it reports the next tests `skipped`, `expectedStatus` `passed`, `parallelIndex` −1, then retries them) — unless marked non-retriable (a screenshot with no baseline: one attempt of two allowed), while `results.length < retries + 1`. A skip the test chose ends with `expectedStatus: "skipped"`; a soft assertion's error reaches its step. `retryStrategy` defaults to `immediate` | `runner/index.js:5755–5775`, `:5861–5965` (`JobDispatcher._onDone`); `common/index.js:496`; lab 2026-10-12 |
| V234 | A locator error's message carries Playwright's call log, which quotes the element's markup with its attribute values (`locator resolved to <input value="…"/>`) — on BackWPup's restore wizard, the database password | Lab 2026-10-12 |
| V257 | APVM 3.0.0's errors and events carry no token (9 failure modes, fake and real tokens, online and offline) and its clone URL has no user. git 2.43 (`ubuntu:24.04`) and 2.56 drop a URL's user and password from their own errors but print `?access_token=…` verbatim. Playwright 1.63's `page.goto` error quotes `http://u:<pw>@host/…` whole in its first line | 2026-10-12: a probe of `apvm-napi` with a throwaway cache; `git ls-remote`/`clone`; a `goto` probe |
| V269 | BackWPup's restore working folder (`uploads/backwpup-restore-<20 hex>`, since `develop@ab4a2e2`) locks out whichever user did not create it. Created first by WP-CLI, the web server's requests die (phase-6 V194). The other direction: created first by the web server (`www-data`, 0755), a WP-CLI command dies "Restore working directory … is not writable" (Pro's `wp backwpup backup`). `free@nginx` hit it too: the first attempt of "The version command…" failed on that fatal and passed on retry; not investigated | Live: Pro on `bwu3`, 2026-10-06 (the 12 failures' `error-context.md`); Free on `bwu2`, 2026-10-12 |
| V278 | A dry run over the main checkout's `reports/`: 198 runs, 920.2 MB; the default policy would remove 146 (673.1 MB: 106 older than 30 days, 40 beyond the newest 20), keeping each cell's newest complete report; age alone 106 (537.9 MB). A first real prune of a copy of its `pro@nginx` (102 runs, 529 MB) removed 82 (369.9 MB) in 380 ms; the next took 2 ms | 2026-10-12: `npm run report:prune` with `REPORT_ROOT` on the main checkout; a timed copy |
| V288 | npm dates installed package files 1985, so anything dating a folder by its files reads `node_modules/<package>/dist` as decades old: with `REPORT_ROOT` set to a checkout, a prune dating runs that way removed `node_modules/playwright-bdd/{dist,src}` as "older than 30 days" | Lab, 2026-10-12 |
| V293 | `E2E_REPORTS_KEEP=0` lifts the cap only; the 30- and 182-day rules still run at each run's end. A switch turning the suite's own pruning off is deferred to the orchestrator's per-task pruning (§6.8) | Decided with the user, 2026-10-12 |
| V313 | In a trace without DOM snapshots, `getAttribute` puts the attribute's value in its result and in the `locator resolved to <button … data-clipboard-text=…>` log; `locator.evaluate` still waits through `waitForSelector`, which logs it; one `page.evaluate` that finds the element and returns only whitelisted lines leaves none | Trace scans, 2026-10-12 |
| V320 | Playwright 1.63 prepends every `@word` of the feature and scenario titles to `test.tags`, so a title naming a tag repeats it | `common/index.js:2752–2760` |
