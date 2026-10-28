# The orchestrator — operator's guide

One foreground command, `npm run orchestrator -- start`, runs E2E cells in loops on one machine (a run,
a cooldown, the next run) and reports each run to Slack and Datator, replacing AutoE2E's BackWPup
instances. Each run is the suite's own (`bddgen`, then Playwright, pinned to one cell), building its
plugin through the suite (`artifacts:<cell>`, APVM).

Not yet (later phases): run as a service (systemd), take commands while running
(`status`, `stop`, a dashboard), schedules or on-demand runs, back off after failures, build or pin
plugins itself, warn about disk space, clean a site after a killed run (the cell's next run does),
generate Allure at run end and prepare a one-file `report.tar.gz`
([plan](../plans/orchestrator-report-delivery-plan.md)). The config is read once: a change needs a
restart.

Design and the decisions behind it: [`docs/plans/orchestrator-phase-0.5-plan.md`](../plans/orchestrator-phase-0.5-plan.md).

## Install on the runner

1. Tools: Node ≥ 24.16 and npm; git; for BackWPup builds composer (PHP CLI) and `gulp-cli`
   (`npm install --global gulp-cli`); `tmux`. Chromium's system libraries, once:
   `npx playwright install-deps chromium` (it asks for `sudo`); `npm ci` installs Chromium itself.
   No X server: runs are headless.
2. A checkout of `develop`, then `npm ci`. Never `--omit=dev` nor `NODE_ENV=production`: tsx, zod and
   commander are dev dependencies.
3. The cells' sites files (`src/projects/<product>/config/sites*.json`, `chmod 600`), with SSH keys
   reaching the WordPress servers. `npm run healthcheck` must pass for those cells.
4. GitHub access to the plugin repositories (BackWPup's is private): `gh auth login` as this user,
   or `secrets.GITHUB_TOKEN` in the config.
5. Stop AutoE2E's instance for those cells first: a cell's sites are dedicated to one runner.

## Configure

```bash
mkdir -p .orchestrator && chmod 700 .orchestrator
cp orchestrator/config.example.json .orchestrator/config.json
chmod 600 .orchestrator/config.json
```

The config's folder is the **state directory** (runs, logs, the lock); `--config <file>` picks another
file, and with it another state directory. It must be yours and closed to other writers: Ubuntu's default umask
(`002`) makes a `mkdir`'d folder `0775`, which the start refuses, naming `chmod go-w`.

```json
{
  "instance": "E2E Orchestrator",
  "tasks": [
    {
      "id": "bpng",
      "name": "BackWPup Pro on nginx",
      "type": "loop",
      "product": "backwpup",
      "cell": "pro@nginx",
      "plugin": { "ref": "develop", "version": "9.99.99" },
      "cooldownMinutes": 5
    }
  ],
  "runs": { "retries": 2, "reportsKeep": 20 },
  "secrets": { "GITHUB_TOKEN": "…", "BWP_S3_ACCESS_KEY_ID": "…" },
  "notifications": {
    "slack": { "webhookUrl": "https://hooks.slack.com/services/…" },
    "datator": {
      "url": "https://datator.wp-media.me/e2e_tests/results/",
      "apiKey": "…"
    }
  },
  "reports": { "sshHost": "auto-e2e" },
  "serverWarningThreshold": 5
}
```

| Field                            | Rule                                                                                                                                                                         |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `instance`                       | Optional, ≤ 100 characters. Prefixes Slack messages (`*[E2E Orchestrator]*`)                                                                                                  |
| `tasks[]`                        | At least one; every task loops at once                                                                                                                                       |
| `.id`                            | 4 characters: a lowercase letter, then lowercase letters or digits, never `0 o 1 l i`. Unique                                                                                |
| `.name`                          | Optional, ≤ 100. The run's name in its reports                                                                                                                               |
| `.type`                          | `"loop"`, required (the only type)                                                                                                                                           |
| `.product`, `.cell`              | A product and one of its cells (from its sites files), every site real — no placeholder. A product × cell once                                                               |
| `.plugin`                        | Optional `ref` (an APVM ref: a branch, tag, commit, PR or `release:*`) and `version`; else the product's defaults. A `version` beside a `release:` ref is ignored (a warning) |
| `.cooldownMinutes`               | 1–1440, default 5. Counted from the run's end                                                                                                                                |
| `.grep`                          | Optional, ≤ 500. Playwright's `--grep` (`@smoke`, `/backup/i`)                                                                                                               |
| `runs.retries`                   | 0–10. Unset: the suite's default                                                                                                                                             |
| `runs.reportsKeep`               | 0–10,000. Reports and run folders kept per cell. Unset: 20. `0` lifts the cap only (see [Retention](#retention))                                                             |
| `secrets`                        | `GITHUB_TOKEN`, `GH_TOKEN`, `BWP_*` only: what each run receives. Nothing else from your environment reaches a run                                                           |
| `notifications.slack.webhookUrl` | An incoming webhook, `https://hooks.slack.com/services/…`. Omit `slack` to turn it off                                                                                       |
| `notifications.datator`          | `url`: HTTPS, ending with `/` (Datator answers `301` without it). `apiKey`. Omit `datator` to turn it off                                                                    |
| `reports.sshHost`                | Optional host or `user@host`: Slack's report paths become `scp` commands from it                                                                                             |
| `serverWarningThreshold`         | 1–1000, default 5: warns when that many tasks share one server                                                                                                               |

Checked at start and by `--dry-run`: a misspelt key, a value out of bounds, an unknown product or
cell, a placeholder site, two selected tasks on one site, or a site whose `baseURL` is no http(s) URL,
too long to lock (over 2,048 characters as a site key), or holds a password with `/` or `@` unescaped
(write them `%2F`, `%40`) are refused, one `path: problem` line each. No message quotes a value, nor
a key that is no plain name: the file holds secrets.

## Try it

```bash
npm run orchestrator -- start --dry-run          # check the config, print what would run
npm run orchestrator -- start --task bpng --once # one real run of one task, then exit
```

The dry run runs, locks and writes nothing (safe beside a running orchestrator). It names each task's
cell, plugin (as the run will build it), sites and servers, settings, the notifications and secrets
**by name**, then every warning, what a start would refuse included:

```text
dry run · nothing is run · config .orchestrator/config.json · state .orchestrator/
1 task (bpng)
bpng · BackWPup Pro on nginx
  backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m
  site https://bwu2.qa.test · qa-lnmp
servers: qa-lnmp (bpng)
runs: retries 2 · reports kept 20
notifications: slack ("E2E Orchestrator", scp from auto-e2e) · datator
secrets for the runs: GITHUB_TOKEN, BWP_S3_ACCESS_KEY_ID
no warnings
```

`--once` posts to Slack and Datator like any run ([exit codes](#the-command)).

## Run it

```bash
tmux new -d -s orchestrator 'npm run orchestrator -- start'
tmux attach -t orchestrator                 # watch; leave with Ctrl-b d
tail -f .orchestrator/orchestrator.log      # or read its log
tmux send-keys -t orchestrator C-c          # stop: the drain (below)
```

Use `tmux`, never `nohup` or `… &`: it stops when its terminal closes (SIGHUP) or its parent ends, so
anything that backgrounds it and exits stops it at once. In a container, only with `--pid=host`:
a container restarting into a new PID namespace reads its own lock as another's and refuses to start.

One line per event; a run's own output goes to its `run.log`:

```text
10:15:30 orchestrator  started · 1 task (bpng) · .orchestrator/ · pid 4242
10:15:31 bpng  bpng-12 started · backwpup pro@nginx · develop · .orchestrator/runs/bpng-12/run.log
11:09:41 bpng  bpng-12 ⚠ flaky · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/backwpup/pro@nginx/<RUN_ID>
11:09:42 bpng  slack ✓ · datator ✓ 201
11:09:42 bpng  next run 11:14:41 (cooldown 5m)
```

The `slack … · datator …` line comes once both deliveries end, before or after `next run`; a failure
shows `✗` with the status or our reason (`✗ 404 no_service`, `✗ no answer within 15000 ms`).

Outcomes: `✔` passed, `⚠` flaky, `✘` failed or error (could not test — [What a run is](#what-a-run-is)), `■` stopped or killed. A run that could not test gives its
reason and log. A failing run never stops its loop: it fails, and says so, every cycle.

These lines are all it prints, on a terminal and piped alike. A per-task status table (`TASK RUN
CELL PROGRESS ELAPSED STATE`) is built from the loops and each run's `results.jsonl`
(`orchestrator/status/`), counted as `run.finished` counts, but not shown yet; once it is, only on a
terminal: a pipe never gets the table or colour, even under `FORCE_COLOR`. STATE: `starting` (no
run yet, or launched with no `run.begin` read), `setup n/m`, `running` (also once `run.end` is read),
`stopping`, `ended` (recorded and announced, cooldown not armed), `next HH:MM:SS` (PROGRESS: the
last outcome, or `not started · failed|stopped` for an attempt that began no run), then `done`
(`--once`), `stopped` or `loop failed`. A stream past 8 MiB (the cap `run.finished` reads) shows
`unknown` and is no longer read.

## The command

```text
npm run orchestrator -- start [--config <file>] [--task <id>…] [--once] [--dry-run]
npm run orchestrator -- start --help
```

- **Every option goes after `--`.** Before it npm takes the option for itself (`--dry-run` on npm 11
  and 12; also `--once`, `--task=…`, `--config=…` on npm 11) and the orchestrator would start every
  task for real. It notices and refuses (exit 1), naming the `--` form.
- `--task a b --task c` selects tasks; an unknown id is refused. Without it, every task runs.
- A relative `--config` is from the folder you ran npm in.
- Run it only through `npm run orchestrator`, never `npx`, `npm exec` or the `tsx` CLI: they put a
  process between you and it, and signals then go astray.

| Exit  | When                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `0`   | `--once`: every run passed or was flaky. `--dry-run`: the report printed, warnings or not. `--help`, `--version`                                                                                      |
| `1`   | `--once`: a run did not pass. Without `--once`: every loop broke. A refused start (the config, `--task`, the lock, a run still running or whose record cannot be read, a site held elsewhere) or dry run. A usage error              |
| `130` | Stopped: Ctrl-C, SIGTERM or SIGHUP to it or its process group, SIGINT or SIGTERM to npm's PID, or its parent ending                                                                                  |

## Stopping

| Signal to the orchestrator                  | Effect                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Ctrl-C (SIGINT), first                      | No new run; cooldowns end; each run finishes the scenario in progress. After 15 min: interrupt |
| Ctrl-C, second                              | Interrupt every run now (Playwright stops, reports written). After 4 min: kill             |
| Ctrl-C, third                               | Kill every run now (SIGKILL of its process group)                                          |
| SIGTERM, SIGHUP, its parent ending          | As the first Ctrl-C when nothing is stopping yet; otherwise nothing                        |

- Only Ctrl-C escalates, so an SSH session closing after a Ctrl-C cannot cut the drain short.
  Ctrl-Cs less than 1 s apart count as one (npm delivers one Ctrl-C twice).
- Each step is said: `stopping: …`, `interrupting every run: …`, `killing every run: …`.
- After a kill it waits 60 s more for the runs to end, then names any run left behind — with its
  `kill -KILL -<pgid>` when the group is shown to be the run's, else how to check it first. Stopped and killed runs are still sent to Slack, never to Datator.
- A killed run leaves its site dirty (the plugin installed, a backup half made) until the cell's next
  run, whose setup cleans it.
- By hand: SIGINT or SIGTERM to the orchestrator's PID (the `started` line's) or to npm's; SIGHUP to
  the process group. A SIGHUP to npm's PID alone ends npm; the orchestrator notices its parent gone —
  against the parent it booted under, at once as it starts and every second after — and drains
  (before any run, it exits 130). npm run as PID 1 (a container's command) reads as npm gone: run
  `node --import tsx orchestrator/cli.ts start` there.
- Under systemd (not shipped; unmeasured): `Type=simple` or `exec`, never `forking`;
  `KillMode=mixed` (the default would SIGTERM the runs too); `TimeoutStopSec` of about 20 min (the
  default 90 s kills everything mid-drain).

## What a run is

- Its id is `<task>-<n>` (`bpng-12`); `n` never repeats while `tasks/<id>.json` is kept. Its folder
  `.orchestrator/runs/<id>/` holds `run.log` (both processes' output, our `[orchestrator]` lines),
  `run.json` (its record), `run-finished.json` (everything Slack was told), `datator.json` (the record
  posted) and, once drained, `stop` (the drain's stop file).
- Its reports are the suite's: `reports/<product>/<cell>/<RUN_ID>/`.
- Its environment is an allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR`, `PLAYWRIGHT_BROWSERS_PATH`,
  `XDG_CACHE_HOME`, the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, either
  case; `NODE_USE_ENV_PROXY`) and CA files (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `SSL_CERT_DIR`);
  the run's own settings (`E2E_CELL`, `RUN_ID`, the plugin ref and version, `E2E_REQUESTED_REF`,
  retries, `reportsKeep`, the task's name, `E2E_INTERNAL_STOP_FILE`, `E2E_LOAD_DOTENV=false`); and the
  config's `secrets`. `.env` is not loaded; nothing else of your environment reaches it. Its log names
  the variables, never their values.
- Statuses, first match wins: `killed` (by the orchestrator), `stopped` (interrupted or drained while
  its runner ran — a stop asked once the runner exited on its own is not taken: its own end is the
  verdict, and a kill then only clears its leftover processes), `error` (could not test: generation or
  a setup failed, no scenario ran, an error outside the tests, the runner died, a process could not
  start — `bddgen could not start: ENOENT`), `failed`, `flaky`, `passed`.

## Notifications

- **Slack**: one message per run, every status — the outcome, counts, plugin and commit, each site's
  WordPress and PHP, up to 20 failed then flaky scenarios with their first error line, the reason for
  a run that did not test or was stopped, and where its report is (an `scp` command with
  `reports.sshHost`). Success is `200 ok`; anything else is logged, no retry.
- **Datator**: only runs that tested — `passed`, `flaky`, `failed`. `test_suite` is the cell
  (`pro@nginx`, or `pro@nginx @smoke` with a `grep`); a flaky scenario counts as passed;
  `website_url` is the first site's address without its credentials. Success is `201`; anything else
  is logged, no retry.
- Behind a proxy, set `HTTPS_PROXY` (and `NO_PROXY`) in the orchestrator's environment: runs inherit
  them, for APVM and `gh`. Set `NODE_USE_ENV_PROXY=1` too: Node's `fetch` (Slack, Datator, Node inside
  a run) ignores proxy variables otherwise. A TLS-inspecting proxy's CA: `NODE_EXTRA_CA_CERTS` (Node),
  `SSL_CERT_FILE` or `SSL_CERT_DIR` (APVM). A proxy URL's password is masked like any secret.

## State, files and secrets

```text
.orchestrator/                  the state directory: yours, closed to other writers (go-w)
  config.json                   0600; holds every secret
  orchestrator.lock             one orchestrator per state directory
  orchestrator.log              the terminal's lines, dated; 0600
  tasks/<id>.json               each task's run counter
  runs/<run id>/                0700: run.log, run.json, run-finished.json, datator.json, stop
~/.local/state/wp-media-e2e/site-locks/   (or $XDG_STATE_HOME/…) one lock per site; both
                                          folders 0700, yours, never links
```

- Secrets are masked everywhere the orchestrator writes or sends (terminal, log, records, Slack,
  Datator) — by value, URL- and JSON-encoded forms included, also with spaces around it trimmed and
  invisible characters dropped, and by shape (tokens, passwords in URLs, cookies). Still treat the state directory, `reports/` and `test-results/` like the sites files: a
  run's traces hold WordPress session cookies.
- `orchestrator.log` is never rotated by the orchestrator (~1–1.4 MB a day)
  and stays open: a
  `logrotate` that renames it leaves the orchestrator writing the renamed file. Use `copytruncate`,
  or no rotation.

### Retention

At each run's end the suite prunes the cell's reports, and the orchestrator the task's run folders,
by one policy: keep at most `runs.reportsKeep` (20), none older than 30 days except the newest
complete one (up to 182 days). At ~55 min a cycle, 20 runs cover ~18 h; raise it for more history.
`0` removes the cap, not the 30-day rule — and each run's end, and each start, reads every run
folder kept (about 0.3–0.5 ms each: 8,000 folders take seconds). Keep a cap.

## One run per site

Two runs on one site corrupt each other. So:

- Within one config, two selected tasks on one site are refused (start and dry run alike).
- Across every orchestrator of **this user on this machine**, whatever its config: a loop takes a lock
  on each of its cell's sites (keyed by `baseURL`: host, port and path normalised) as it starts and
  holds them until it ends. A site held by a live orchestrator refuses the start, naming its PID,
  cell and run; the dry run warns, once the state directory and its lock are sound. A dead orchestrator's lock is taken over once the run it names is
  over.
- **Not covered**: other users, other machines, runs started by hand (`npm run test:<product>`), an
  orchestrator with another `HOME` or `XDG_STATE_HOME`, and one site under two addresses (a host and
  its IP, two host names, a path differing in case). Keep those apart yourself.

## After a crash: runs left behind

Runs are separate process groups, so they outlive an orchestrator killed with SIGKILL or a crash. The
next start checks every run folder still recorded as running and refuses if one may still be alive:

```text
Task bpng still has run bpng-7 running, in process group 51234: an orchestrator stopped without
ending it, and a second run would share its sites. End it with: kill -KILL -51234
```

When it cannot confirm the group is the run's (`may still have run … — unconfirmed`), it says how to
check first (`ps -o pid,user,lstart,command -g <pgid>`, or `lsof -- <run.log>`). If nothing of the run
is alive, mark it over: set `"state"` to `"lost"` in that `run.json`. A run folder whose `run.json`
cannot be read, or is not one, refuses the start too (`may still be running — unconfirmed: its
record …`): if nothing writes its `run.log` (`lsof`), repair the record or set it aside
(`mv run.json run.json.unread`). A run provably over — its group gone, or its leader started before
this machine's last reboot — is marked `lost` by the start itself. Lost runs are never announced.

## Updating

Stop it and wait for the drain, then `git pull --ff-only && npm ci`, then start again. Never update
the checkout under a running orchestrator: a run reads its files as it goes.

## When it refuses

| Message names                                         | Do                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `chmod go-w` / `chown`                                | The state directory (or `runs/`) is open to others or not yours: run what it names     |
| `chmod 600`                                           | A warning: the config is readable by others                                            |
| a lock held by a live orchestrator                    | One already runs on this state directory: attach to its `tmux`                         |
| a lock written in another PID space (`--pid=host`)    | A container restarted, or another host wrote it: remove the lock once sure none runs   |
| `still has run …`, `may still … — unconfirmed`        | See [After a crash](#after-a-crash-runs-left-behind)                                   |
| a site held elsewhere                                 | Another orchestrator of yours runs that site: stop it, or drop the task                |
| `npm took --… as its own setting`                     | Put every option after `--`; if you did, remove it from `.npmrc` or the environment    |

## Testing the orchestrator

- `npm run test:unit -- --project=orchestrator` runs its specs alone: real processes and signals over
  a fake suite, no site.
- `npm run orchestrator:soak` runs the real `start` for hundreds of runs over the fake suite (a few
  minutes; `ORCHESTRATOR_SOAK_RUNS` sets how many), the status table followed throughout. It fails if
  listeners, handles, timers or file descriptors grow, if pruning lets run folders pass the cap, or if pruning costs 1 ms a folder or
  more.
