# Orchestrator Phase 0.5 — The minimal orchestrator

Status: done — steps 0–7, 2026-10-12 to 2026-10-19; its first deployment needs the runner (§9).
After Phase 0 (done), before Phase 1 (not planned yet).
Reference: operating it, [`docs/guides/orchestrator.md`](../guides/orchestrator.md); §4 (design), §5
(code layout) and §6 (running it) describe it as built, in `orchestrator/`; where they and the code
differ, the code wins.
Parent: the [orchestrator plan](orchestrator-plan.md) keeps the concept and lists this phase in its
§7. Verification rows continue its numbering, from V114 (§11).
Measured with: Node 24.21.0, npm 12.0.2, tsx 4.23.15, Playwright 1.63.0, on the macOS runner and on
Ubuntu 24.04 (Docker); [`wp-media/auto-e2e`](https://github.com/wp-media/auto-e2e) @ `fa0a5b6`;
`wp-media/datator` @ `0cff7bc`; APVM `cli/v3.0.0`.

## TL;DR

The smallest orchestrator that replaces AutoE2E's BackWPup instances: one foreground command,
`npm run orchestrator -- start`, kept in `tmux`, that cycles one or more cells; each run builds its
own plugin through the suite and is reported to Slack and Datator through a one-event bus. It is the
parent's design cut to the bone, each piece the first version of one the parent plans, in the shape
later phases extend. Built, audited, live-checked on `bwu2`/`bwu3`, soaked and documented; only its
first deployment remains (§9).

| AutoE2E today (V114–V116) | Phase 0.5 |
| --- | --- |
| One PM2 process per Linux user, one suite each, under `xvfb-run` | One process, any number of cells — `npm run orchestrator -- start`, kept in `tmux`; headless, no X server (V126) |
| A cycle every 5 min while idle | `loop` tasks: again after a cooldown (default 5 min) once a run ends |
| Clones and compiles the plugin with its own scripts | The run builds it: the suite's `artifacts:<cell>` step, through APVM (V123) |
| `git reset --hard origin/develop` of the suite every cycle | Updated by hand while stopped (D3) |
| Cucumber JSON parsed afterwards | The suite's results stream and run facts (Phase 0's 0E, 0D) |
| Slack: ✅/❌, counts, failed names, WP/PHP (WP-CLI), `scp` hint; "Script Error!" on a crash | Slack: the same, with the plugin and commit, the site's real PHP (V28), the reason a run could not test |
| Datator over `curl`, an HTTP error unnoticed | Datator over `fetch`, anything but `201` logged; only runs that tested |
| Results kept 4 days | The suite's pruning (0F): 20 per cell by default, configurable |
| One log line per step to `auto-e2e.log` | The orchestrator's log, plus one log per run |

Out, for later phases: systemd, the socket API, the dashboard, other task types (scheduled,
on-demand, watch), groups, provided zips, run once (`run --ref`), any command but `start`, editing
anything while it runs, the orchestrator's own builds (warm, pin), backoff after errors, the disk
warning, the cleanup chain after a kill, Allure generation, APVM cache cleaning.

## 1. Scope

- Cells run in `loop` only — the parent's name for AutoE2E's cycle: a run, a cooldown, the next run.
  No schedule, no cron.
- Fixed configuration: one JSON file read at start — tasks, secrets, notification targets. A change
  needs a restart.
- The run builds its plugin: the task's ref (default the product's, `develop`) reaches the run as
  `E2E_PLUGIN_REF`; its `artifacts:<cell>` step builds through APVM or hits APVM's cache. No
  warming, no pinning. That reverses the parent's "the orchestrator builds; a run never does" for
  this phase only; Phase 1 restores it by changing what the run is given, nothing else (§8).
- One event, `run.finished`, with the parent's payload (parent §2), to two subscribers: Slack and
  Datator.
- Safety kept because it is cheap and its absence corrupts sites: never two runs on one site (§4.3:
  within a config by its check, across this user's orchestrators on one machine by a lock per site
  held for a task's whole loop); never two orchestrators on one state directory (§4.9); a graceful
  stop (Phase 0's 0C, §4.5).

## 2. AutoE2E, the floor (V114–V116)

- Process: `node auto-e2e.js <suite>` under PM2, one Linux user per instance (`auto-e2e-bkwp`,
  `-bkwp-apache`, `-wpr`, `-wpr-apache`), wrapped in `xvfb-run -a -s "-screen 0 1920x1080x24"`; PM2
  restarts it 5 s after a crash and `pm2 save` brings it back after a reboot. `e2em` (a bash script)
  starts, stops, lists and tails all four.
- Cycle: first at once, then `setInterval` every 5 min; a tick that finds a cycle running is
  skipped, so the next cycle starts 0–5 min after the last ends. Per cycle: fetch and `reset --hard`
  the plugin to `origin/develop`; compile with a script kept outside the repo (BackWPup
  `--ver 5.99.99`; WP Rocket after copying a pre-filled `licence-data.php`); move the zip where the
  legacy suite reads it; `reset --hard` the suite to `origin/develop`; `npm run <suite>`, output
  inherited; move `test-results/*` to `test-results-storage/<timestamp>/`, deleting folders older
  than 4 days; parse `cucumber-report.json`.
- Slack, one plain-text message per cycle through an incoming webhook:
  `✅ Auto E2E tests <suite> Ran Successfully!` with the passed count, or `❌ … Failed!` with the
  failed count and `Feature - Scenario` names; `WordPress: x | PHP: y` from WP-CLI over SSH; an
  `scp` command for the Cucumber HTML, the host masked as `xx.xx.xx.xx`; an optional
  `*[AUTO_E2E_INSTANCE_NAME]*` prefix. Any exception sends `❌ Auto E2E Script Error!`, with no
  detail.
- Datator, per cycle that produced a report: `product` (`wp_rocket`/`backwpup`), `test_suite` (the
  npm script, `test:bwpup`), `timestamp` (cycle start), counts, `git_commit` (the plugin clone's
  `HEAD`), `test_duration_seconds` (the whole cycle, build included), `website_url` (since
  2026-10-02, V115) and every scenario's feature, name, status and first error. A scenario with a
  skipped step counts as failed.
- Weak spots not to copy: `curl` without `-f` (an HTTP error reads as sent), JSON quoted into a
  shell command, a crash message with no reason, WP-CLI's PHP version (wrong on nginx, V28), skipped
  counted as failed.

## 3. What it needs from Phase 0

Every Phase 0 item it relies on is done (the [orchestrator plan](orchestrator-plan.md)'s Phase 0):
0A.1 the cell pin (two cells of one product side by side; 2 of 80 failed without it, V29), 0A.2 the
output folders, 0B.1 `E2E_LOAD_DOTENV`, 0B.3 one product list, 0C the drain with `stopRunningWork`
first, 0D.1 run facts, 0D.2 the full commit, 0D.3 site versions, 0E the results stream (the suite
writes no Cucumber JSON), 0F pruning (a loop writes ~25 reports a day per cell, V125). Not used:
0B.2 and 0A.3–0A.5, which serve the orchestrator's own builds and scheduling (later phases).

## 4. Design

As built. Module names are under `orchestrator/` (§5).

### 4.1 M1 — The command

- `npm run orchestrator -- start [--config <file>] [--task <id>…] [--once] [--dry-run]`, plus
  `--help` and `--version` (the checkout's `package.json` version, `unknown` if unreadable).
  Commander 15 in `command.ts`; the entry `cli.ts` is one statement,
  `process.exit(await runCommand(…))`.
- The script is `"orchestrator": "exec node --import tsx orchestrator/cli.ts"`. Never the `tsx` CLI:
  it runs the code in a child and relays signals, and repeated SIGINTs made it SIGKILL the child —
  lock and runs left behind (V443). `exec`, so no shell stays between npm and Node: Ubuntu's `sh`
  (dash) does not exec a lone command, and then a SIGINT to npm's PID never reached the orchestrator
  and a SIGTERM ended npm and left it running (V467). `npx`/`npm exec` keep dash in between: not how
  it is run.
- The process (`start.ts`), in order: signal handlers (§4.5) → stdout made non-blocking →
  `prepareStart` (the product list, the config, the `--task` selection; `--dry-run`'s seam) → the
  state directory's lock (§4.9) → `orchestrator.log` (opened under the lock, so only its holder
  writes it) → the lock's leftovers and the config's warnings → the orphan check (§4.4) → the
  selected sites' locks judged (§4.3) → a signal so far ends it, 130 → the bus and its subscribers →
  the `started` line → every selected task's loop at once → the wait, the `exiting N` line, the exit
  (§4.5). A refusal before the log is open goes to stderr, exit 1. `start` returns the exit code and
  never rejects (an unexpected throw is a line and 1).
- Every task in the config runs at once, each in its own loop (§4.3). `--task` selects: variadic and
  repeatable (`--task a b --task c`), duplicates dropped, an unknown id refused before the lock; the
  config's checks (server load, shared sites) then count only the selected tasks.
- Foreground: it holds the terminal until stopped, like `node auto-e2e.js`; on a server inside
  `tmux` (§6), so it outlives the SSH session. Closing the session without `tmux` stops it (SIGHUP),
  and so does its parent ending (§4.5).
- Later under systemd (unmeasured): `Type=simple` or `exec`, never `forking`; `KillMode=mixed` (the
  default `control-group` would SIGTERM the runs too; parent V13); `TimeoutStopSec` beyond the drain
  and interrupt budgets plus the settle, ~20 min (the default 90 s SIGKILLs everything mid-drain).
- `--once` runs each selected task once and exits (exit codes below): how a deployment is tried
  (§6).
- `--dry-run` checks the config and prints what would run (below); it runs, locks and writes
  nothing, so it runs beside a running orchestrator; it holds no signal handler, so Ctrl-C ends it
  at once. `--once` with it is accepted and changes nothing.
- Every option goes after `--`. Before it, npm takes an option as its own setting and runs the
  script without it — `--dry-run` on npm 12 and 11, and on npm 11 (Node 24's own) also `--once`,
  `--task=<id>` and `--config=<file>` — turning a dry run or one task into a real start of every
  task (V471, V479). The command refuses (exit 1, nothing read or written, naming the `--` form)
  when `npm_config_dry_run`, `_once`, `_task` or `_config` is set (not empty, not `false`) and its
  option is missing from the arguments; set while the option is there (an `.npmrc`'s
  `dry-run=true`), no refusal.
- A relative `--config` is from `INIT_CWD` (where npm was run; npm runs a script in the package's
  folder), else the working directory. An option value starting with `-` is a usage error, since
  commander hands an option missing its value the next argument (`--task --dry-run` would start for
  real); a path that must start with `-` is written `./-…`.
- Exit codes:

  | Code | When |
  | --- | --- |
  | `0` | `--once`: every run passed or was flaky; `--dry-run`: the report printed, warnings or not; `--help`, `--version` |
  | `1` | `--once`: a run did not pass. Without `--once`: every loop ended unasked (each broke — e.g. a run that could not be watched). A refused start: the config, the product list, `--task`, the lock, a run still running, a site held elsewhere. A refused dry run: the config, the product list, `--task`. A usage error (commander's, then `(add --help for usage)`), no command (the help on stderr), an option npm took |
  | `130` | Stopped: Ctrl-C, SIGTERM or SIGHUP to it or its process group; SIGINT or SIGTERM to npm's PID; its parent ending — even when every loop had already ended |

- Outputs: `start` makes stdout non-blocking (a paused terminal — Ctrl-S, a frozen client — would
  block every timer and signal handler, V409), caps the terminal's backlog at 1 MiB
  (`N lines not shown`; the log keeps them) and drains it, within 5 s, before returning
  (`process.exit` drops what a terminal has not taken, V410); the command then exits at once, every
  shutdown signal given a do-nothing handler from just before `start` until the exit, so a late
  signal cannot kill it by Node's default. Help, version, usage errors and the dry run stay blocking
  and wait for both outputs without a practical limit (2³¹−1 ms, Node's longest timer). A closed stdout or stderr (`… | head`) is dropped: no stack,
  the exit code unchanged. Refusals before the log is open go to stderr, masked (§4.10); usage
  errors by shape only.
- Terminal: one timestamped line per event, never a run's own output (runs interleave); the same
  lines go to `orchestrator.log` (§4.9):

  ```text
  10:15:30 orchestrator  started · 2 tasks (bpng, bfap) · .orchestrator/ · pid 4242
  10:15:31 bpng  bpng-12 started · backwpup pro@nginx · develop · .orchestrator/runs/bpng-12/run.log
  11:09:41 bpng  bpng-12 ⚠ flaky · 52 scenarios: 51 passed, 1 flaky · 54m 10s · reports/backwpup/pro@nginx/<RUN_ID>
  11:09:42 bpng  slack ✓ · datator ✓ 201
  11:09:42 bpng  next run 11:14:41 (cooldown 5m)
  ```

  - `started` names the tasks, then `· once` under `--once`, the state directory and the
    orchestrator's PID.
  - A run's started line, said once `bddgen` is spawned, names the ref the run builds as `--dry-run`
    does (`(default)` when the product's manifest chose it; planned once per task, at its first
    run), then the task's `grep` when set, then its log.
  - Outcome marks: `✔` passed, `⚠` flaky, `✘` failed and error, `■` stopped and killed; a run that
    did not test gives its reason and its log. A run refused before it had a folder ends at the
    duration.
  - The notification line: `slack ✓ · datator ✓ 201`; a failure `✗`, its status, then the answer or
    our own words (`✗ 404 no_service`, `✗ HTTP 500`, `✗ no answer within 15000 ms`, `✗ cancelled`,
    `✗ request failed: ECONNREFUSED`, `✗ not sent: …`); a run that did not test
    `datator not posted (stopped)`; Slack's success shows no status (it is only ever `200 ok`).
  - Shutdown lines say what happens now and next (§4.5).
- `--dry-run` prints to stdout, over the committed example (hosts from a stand-in sites file):

  ```text
  dry run · nothing is run · config .orchestrator/config.json · state .orchestrator/
  2 tasks (bpng, bfap)
  bpng · BackWPup Pro on nginx
    backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m
    site https://bwu2.qa.test · QA-LNMP
    site https://bwu3.qa.test · qa-lnmp
  bfap · BackWPup Free on Apache, smoke only
    backwpup free@apache · develop (default) · version 9.99.99 (default) · grep @smoke · cooldown 5m
    site https://bwu4.qa.test · qa-apache
  servers: QA-LNMP (bpng), qa-apache (bfap)
  runs: retries 2 · reports kept 20
  notifications: slack ("E2E Orchestrator", scp from auto-e2e) · datator
  secrets for the runs: GITHUB_TOKEN, BWP_S3_ACCESS_KEY_ID, BWP_S3_SECRET_ACCESS_KEY
  no warnings
  ```

  - The plugin is what the run will build, by the suite's own planner (`buildArtifactPlan`,
    `src/common/artifacts/request.ts`, given the task's ref and version as a run is): `(default)`
    for the product's defaults; a release `version from the release` (a task's own `ignored`); an
    embedded-version product `version from the source`. It ignores the orchestrator's own
    `E2E_PLUGIN_*`.
  - A site is its masked URL (`safeSiteUrl`, §4.10; anything but an http(s) URL is
    `(not a valid http(s) URL)`) and its server's host as written. Unset settings read
    `the suite's default`, `reportsKeep: 0` `without a cap`, no notification `none`. Notifications
    and secrets are named, never their URLs, keys or values.
  - Warnings, each `warning: …`: first the state directory's (`state/inspect.ts`, read-only) — what
    a start would refuse: the folder open to others or not this user's, with its
    `chmod go-w`/`chown`; a live, foreign-PID-space or unreadable lock; once the lock is free, a run
    an earlier start left running, with the orphan refusal's text (a stale one is never marked
    `lost` here); each selected task's site held elsewhere — then the config's (its mode, an ignored
    version, crowded servers).
  - A refusal (the config, the product list, `--task`, two tasks on one site) goes to stderr,
    `orchestrator: dry run failed: …`, exit 1.

### 4.2 M2 — Configuration

`.orchestrator/config.json` in the checkout by default, or `--config <file>`. Git-ignored like the
sites files, `0600` (any group or other bit is a warning naming `chmod 600`). The state lives in the
config file's folder (§4.9), so `--config` is the one switch. The committed
`orchestrator/config.example.json`:

```json
{
  "instance": "E2E Orchestrator",
  "tasks": [
    { "id": "bpng", "name": "BackWPup Pro on nginx", "type": "loop", "product": "backwpup",
      "cell": "pro@nginx", "plugin": { "ref": "develop", "version": "9.99.99" }, "cooldownMinutes": 5 },
    { "id": "bfap", "name": "BackWPup Free on Apache, smoke only", "type": "loop",
      "product": "backwpup", "cell": "free@apache", "grep": "@smoke" }
  ],
  "runs": { "retries": 2, "reportsKeep": 20 },
  "secrets": { "GITHUB_TOKEN": "…", "BWP_S3_ACCESS_KEY_ID": "…", "BWP_S3_SECRET_ACCESS_KEY": "…" },
  "notifications": {
    "slack": { "webhookUrl": "https://hooks.slack.com/services/T00000000/B00000000/replace-me" },
    "datator": { "url": "https://datator.wp-media.me/e2e_tests/results/", "apiKey": "replace-me" }
  },
  "reports": { "sshHost": "auto-e2e" },
  "serverWarningThreshold": 5
}
```

Its tasks name cells of `sites.example.json` (a spec checks it), so a fresh checkout's `--dry-run`
reaches the placeholder check, not "no cell".

| Field | Rule |
| --- | --- |
| `instance` | Optional, one line, ≤ 100 characters; prefixes Slack messages (`*[E2E Orchestrator]*`), as `AUTO_E2E_INSTANCE_NAME` did |
| `tasks[]` | At least one. The parent's task fields (parent §2), so Phase 1 imports them as they are |
| `.id` | The parent's 4-character rule: a lowercase letter, then lowercase letters or digits, without `0`, `o`, `1`, `l`, `i`; unique |
| `.name` | Optional, ≤ 100; the run's name (`E2E_RUN_NAME`) |
| `.type` | `"loop"`, required: the only value, explicit so a later default cannot change its meaning |
| `.product`, `.cell` | A product of the suite (0B.3); a cell of its sites files whose every site is real (a placeholder in a real pool is a mistake a worker bound to it would fail on); product × cell unique (a cell never runs twice, V1) |
| `.plugin` | Optional `ref` and `version`, each one token (≤ 200, no whitespace) not starting with `-`, else the product's defaults; no `zip` yet. A version with a `release:` ref is a warning: the suite ignores it |
| `.cooldownMinutes` | Whole minutes 1–1440, default 5: zero would hammer a broken site; a day or more is a schedule (later phases) |
| `.grep` | Optional, ≤ 500; a pattern Playwright's `--grep` accepts as Playwright reads it (`/source/flags` with `g`/`i`, else a source with `gi`, V362) |
| `runs.retries` | 0–10 → `E2E_RETRIES` (the suite's bounds); unset, the suite's default |
| `runs.reportsKeep` | 0–10,000 (retention's `MAX_REPORTS_KEEP`) → `E2E_REPORTS_KEEP`; unset, the suite's 20; `0` lifts only the cap (§4.9) |
| `secrets` | Names `GITHUB_TOKEN`, `GH_TOKEN` and any `BWP_*` — what a run may receive (Phase 0's run contract: by prefix, never a hand-kept list). Values: ≤ 32,768 UTF-16 units (Linux caps one `NAME=value` at 128 KiB, `MAX_ARG_STRLEN`, read from its source, not measured), no control character or broken Unicode. A token is printable ASCII without spaces; a `BWP_*` value keeps surrounding spaces (the suite reads storage passwords untrimmed on purpose) |
| `notifications.slack.webhookUrl` | `https://hooks.slack.com/services/<hook>` only: an incoming webhook, the payload §4.7 sends |
| `notifications.datator.url`, `.apiKey` | HTTPS, its path ending with `/` (without it Datator answers `301`, and the redirect drops the POST body, V119); the key printable ASCII, as an HTTP header value is (V369) |
| `reports.sshHost` | Optional host or `user@host`, ≤ 255, neither part starting with `-`, so it can never read as an `scp` option (V368); turns Slack's report path into an `scp` command |
| `serverWarningThreshold` | 1–1000, default 5: up to four suites share a QA server well |

- Both URLs must be written exactly as `URL` reads them back, with no user, password, port, query or
  fragment. Omitting `notifications.slack` or `.datator` turns that subscriber off, as AutoE2E's
  empty key did.
- Validated at start, and by `--dry-run`, with zod 4. Every object is strict: a misspelt key is an
  error, never a setting silently ignored. One `ConfigError`, one `path: problem` line per issue in
  the schema's order (`tasks[2].cell: repeats tasks[0]'s product and cell`); the uniqueness checks
  run beside any issue but an aborting one (a wrong type, a refused key), V360. Every bounded number
  has one message, `must be a whole number from A to B`, its unit after it where it has one
  (`… to 1440 minutes`).
- Then against the suite (`config/check.ts`): the product is known, the cell real, every site real;
  the selected tasks' sites are keyed as the site locks key them (§4.3) and a key two selected tasks
  share is refused, naming both and the site (`--task` selecting one of them passes); a site whose
  `baseURL` is no http(s) URL is refused, and so is one with credentials and an `@` in its path — a
  password holding `/` or `@` unescaped, which a parser reads as another host and a path carrying the
  password's tail into the site key — and one whose site key is over 2,048 characters, which no lock
  can carry. Warnings: an ignored version; every server reached by
  `serverWarningThreshold` selected tasks or more — an SSH site's host lowercased, a Docker or local
  site "this machine" — naming the server and its cells. All tasks loop at once, so that count is
  the live one. No limit per server (decided; 0A.3).
- The file is read through one non-blocking handle, `fstat`-checked as a regular file, within 1 MiB
  (a path read twice races a swapped link, and a FIFO blocks, V367); UTF-8 strictly (invalid bytes
  refused, never replaced; a leading BOM skipped); a missing file says to copy the example. Keys
  JSON or zod would lose — a repeated key (JSON keeps the last), `__proto__` (zod's record drops it)
  — are refused with their paths (V366).
- No message quotes a value: the file holds the runs' secrets. Zod's messages name types and bounds;
  a key is shown only when it reads as a name — camelCase, snake_case, an uppercase word or
  UPPER_SNAKE words with digits, ≤ 40 characters, not shaped like a GitHub token — else
  `a key of N characters` (zod quotes an unknown key raw, V360): a pasted credential is random (a
  legacy 40-hex token, an AWS key ID), which no such name is; an unknown product or cell is named
  by its path; a file that is not JSON by the position when Node's parser gives one in digits, never
  by `JSON.parse`'s message, which quotes the text (V361). Text fields (names, instance, product,
  cell) are one plain line: no surrounding whitespace, control, invisible or line-separator
  character.

### 4.3 M3 — The loop, and one run per site

- One loop per selected task, all started in one turn: a run → its end recorded and `run.finished`
  published → the cooldown → again. The first runs start at once; a task runs one run at a time.
- The cooldown counts from the run's end (`endedAt`; for a run that never started, from when its
  attempt settled, so a start that fails at once still waits and never spins), clamped to
  `[0, cooldown]`: a prune slower than the cooldown waits nothing, a clock stepped back waits the
  cooldown from now. Its timer stays referenced: while every task cools down, it is what keeps the
  process alive. A cooldown outside the config's bounds ends the loop `failed` before any run (Node
  turns a `NaN`, negative or over-2³¹−1 ms delay into 1 ms, V434).
- No backoff: a run that failed, could not test, or was stopped or killed by anything but its loop
  does not end the loop; a broken site or branch fails every cycle and says so each time, as AutoE2E
  does. The parent's backoff comes with Phase 1.
- A stop (§4.5) is handed to the run in flight on every call (so its escalation is the run's own),
  ends a cooldown at once (the timer cleared), and starts nothing more — wherever it lands: before
  the first run, while a run is created, as the cooldown is armed or fires. It ends the loop with
  `no next run: <why>`.
- The loop ends `failed`, never spinning, when: its cooldown is out of bounds; timers cannot arm;
  the clock throws; its site locks are refused as it starts (said once); a run's locks can no longer
  be named; a run could not be watched to its end — `unwatched`: its processes may still live, so
  the cell is not run again, its locks are kept and its record left `running` for the next start's
  orphan check (chosen over waiting on the recorded group, which would redo the watch that just
  failed).
- A loop that ends `failed` ends only itself: the other tasks keep looping and the process stays up;
  it exits once every loop has ended (1), or on a stop (130).
- `--once`: one run, no cooldown. A loop's verdict is `stopped` whenever it was stopped; else
  `passed` for a run `passed` or `flaky`; else `failed` — failed, could not test, never started, or
  stopped or killed by anything but this loop (130 would claim a stop the operator never asked for).
  The exit: `130` if any verdict is `stopped`, else `1` if any `failed`, else `0`.
- One run per site, since a run binds to its cell's sites:
  - Within one config, by its check (§4.2): no two selected tasks on one site.
  - Across every orchestrator of this user on this machine, whatever its config, state directory or
    checkout: one lock per site (`state/cell-lock.ts`) in
    `$XDG_STATE_HOME/wp-media-e2e/site-locks/<first 32 hex of the key's SHA-256>.lock`
    (`~/.local/state/…` without it; a relative `XDG_STATE_HOME` ignored; no absolute `HOME` either
    refuses the start). `wp-media-e2e` and `site-locks` are made `0700` and must be this user's real
    folders, never links — both judged, the parent first, before anything is made or read in it;
    missing folders above them get the default mode and are not judged. Not under
    `test-results/`, which Playwright empties.
  - A site's key (`config/site-key.ts`): its `baseURL`'s host as a URL parser writes it (lowercase,
    punycode, IPv4 in dotted decimal, IPv6 compressed) without a trailing dot; its port unless 80 or
    443 whatever the scheme, so `http` and `https` of one host are one site; its path resolved,
    escapes of unreserved characters decoded (`%7E` is `~`), the others uppercased, no trailing
    slash; no credentials, query or fragment. An `@` in the path of a URL with credentials is refused
    (§4.2).
  - Each is the state directory's lock in another place (§4.9: written whole, judged in its PID
    space, a dead holder's taken over under a claim, never through a link); its owner record also
    holds the site's `key`, the holding cell (`label`) and the latest run's `run.json` (`run`).
  - A loop takes all its cell's sites as it starts — sorted by key, all or nothing —, names each run
    in them before its launch (the lock rewritten whole through a rename, its token unchanged, only
    while still this holder's), and gives them back as it ends, kept after an `unwatched` run. Held
    for the whole loop, so two orchestrators never take turns on a site through each other's
    cooldowns.
  - A dead holder's lock is taken over only once the run it names is over, missing, or stale as the
    orphan check judges; still running, the refusal is the orphan refusal with its
    `kill -KILL -<pgid>`; an unreadable record refuses too. So a run left behind by an orchestrator
    killed with SIGKILL keeps its sites from every other orchestrator.
  - At start, every selected task's sites are judged read-only: one held by a live orchestrator, or
    by a dead one's run still running, refuses the start (`not started: …` under the task, naming
    the holder's PID, cell, site and run); `--dry-run` warns the same. A loop that then loses the
    race for its locks ends `failed` before any run, said once. A run whose locks can no longer be
    named (removed by hand, another's, a write that failed or threw) launches nothing, ends `error`, is
    announced once, and its loop ends `failed`.
  - Two cell names on one site exclude each other; one cell name on other sites does not.
  - Limits: another user, another machine, a run started by hand (`npm run test:<product>`), or an
    orchestrator with another `XDG_STATE_HOME` or `HOME` takes or sees no lock; one site under two
    addresses — a host and its IP, two names for one server, a path differing only in case — is two
    sites.

### 4.4 M4 — A run

- Identity (`runs/identity.ts`): `<task>-<n>` (`bpng-12`). `n` comes from `tasks/<task>.json`
  (`{"v":1,"lastRun":n}`), saved before the run starts so a crash never hands it out twice, always
  past both the counter and the task's highest run folder (a lost counter never restarts at 1), and
  never reset on a file it cannot trust (a refusal). `RUN_ID` is `formatRunId(start, id)`, 0F's
  formatter (`2026-10-13T10-15-31-042Z-bpng-12`; pruning dates it back to the start). The run folder
  `runs/<id>/` is created exclusively, `0700`, so a reused number fails before anything runs. The
  report folder `reports/<product>/<cell>/<RUN_ID>` comes from the suite's `runReportDir`
  (`run-id.ts`, which `run-context.ts` uses too), never from importing `run-context.ts`, which would
  load `.env` and stamp the orchestrator's own `RUN_ID` (V84); runs never get `REPORT_ROOT`.
- One run (`tasks/cycle.ts`), each step on its own (one failing never skips the next; each failure a
  masked line): the number → the identity → the run named in its site locks (§4.3) → `launchRun` →
  the started line → the wait → `endRun` → `run-finished.json` → `datator.json` → the `ended` record
  → the outcome line → `publish` → run-folder pruning (§4.9). A stop asked before the run has its
  number starts nothing; asked while the number is taken, the number is spent and nothing starts
  (`<id> not started: <why>`; no record, no `run.finished`); asked later but before `bddgen`'s
  starting record (while its site locks are named or during the launch), nothing is spawned and the
  run is recorded and published `stopped`. Its handle is `{ stop(level, why), done }`, `done` never
  rejecting; `onRunBegun` tells the start each run's id and task as it begins (§4.5's give-up names
  only those).
- Launch (`runs/launch.ts`), Phase 0's run contract unchanged: Node (`process.execPath`) runs
  `node_modules/playwright-bdd/dist/cli/index.js --config playwright.<product>.config.ts`, then, if
  it exited 0, `node_modules/@playwright/test/cli.js test --config playwright.<product>.config.ts`,
  plus `--grep=<grep>` as one argument (two would read a value starting with `-` as an option, and
  `--grep --` swallows the next argument, V368). The working directory is the checkout. Each process
  is `detached` — its own process group and session (V121). Before each spawn a `running` record
  names it as `starting`, so a crash between the spawn and the record still leaves a trace.
- `run.log` is created exclusively (`O_CREAT|O_EXCL|O_NOFOLLOW`, `0600`): both processes write into
  it, and our `[orchestrator]` lines, each on a line of its own, give the variables' names (never
  values), each command, each exit or signal, each stop. A launch that fails before its first record
  removes the folder it made (only if empty, never through a link), so no folder is left undated.
- Environment (`runs/environment.ts`), an allowlist — never the orchestrator's own:
  - `PATH`, `HOME` (APVM's cache and `gh` live under it), `LANG`, `TMPDIR`, `PLAYWRIGHT_BROWSERS_PATH`,
    `XDG_CACHE_HOME`, the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`, each
    in either case; `NODE_USE_ENV_PROXY`) and CA files (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
    `SSL_CERT_DIR`), when set and not empty — APVM's binary (reqwest, rustls) holds the proxy names in
    both cases and `SSL_CERT_*` (read from it, not measured behind a proxy);
  - `E2E_LOAD_DOTENV=false`, `RUN_ID`, `E2E_CELL`, `E2E_INTERNAL_STOP_FILE`;
  - the task's plugin: `E2E_PLUGIN_REF` and `E2E_PLUGIN_VERSION` when set, and `E2E_REQUESTED_REF`
    (display; equal to the ref here; when Phase 1 pins, only `E2E_PLUGIN_REF` changes);
  - `E2E_RUN_NAME` (the task's name), `E2E_RETRIES` and `E2E_REPORTS_KEEP` when configured;
  - the configured secrets, whose allowed names cannot replace any of the above.

  Nothing else: an inherited `NODE_OPTIONS`, `CI`, `GITHUB_TOKEN` or `RUN_ID` is dropped. macOS adds
  `__CF_USER_TEXT_ENCODING` to every process itself (V394).
- End: a process has ended once it has exited and its process group is empty (`kill(-pgid, 0)` →
  `ESRCH`; `EPERM` is alive — e.g. a root `sudo` child on a `local` cell; a group id under 2 is
  refused, since `-0` and `-1` reach the orchestrator's own group or every process). A group that
  outlives its process by 5 min (`LINGER_MS`: past the interrupt budget, so a worker's teardown is
  never cut, only a hang) is SIGKILLed — not a stop; the run's results stand. A group still not
  empty after a SIGKILL is said in the orchestrator's own lines at once and every 5 min, the SIGKILL
  sent again, naming `kill -KILL -<pgid>` (`… after its linger, never killed` when none reached it);
  the wait goes on.
- Outcome (`runs/end.ts`, `runs/outcome.ts`) from `results.jsonl` (0E; read up to 8 MiB, a line over
  256 KiB skipped unparsed — nested brackets cost ~70–100× their size to parse, V401; every field
  checked, a wrong line dropped, a wrong count read as 0), `run-facts.json` (0D.1; up to 1 MiB; only
  what is reported, each field checked, a malformed one unknown) and the log's last 40 lines (from
  its last 64 KiB, ours left out); each opened non-blocking and only when a regular file. First
  match wins:

  | When | Status |
  | --- | --- |
  | the orchestrator killed it | `killed` |
  | it was stopped — interrupted while it tested, or drained before it finished — by the orchestrator or by hand | `stopped` |
  | `bddgen` failed; `bddgen` or Playwright could not start (`<process> could not start: <code>`); Playwright ended without `run.end`; a setup failed; the run's time limit (`timedout`); an error outside any test (`run.error`, even beside scenarios that ran: its results cannot be trusted as a regression); no scenario passed or failed (none matched, or all skipped); a `failed` `run.end` with no failed scenario; an exit its results do not explain (0 for a failed run, 1 for a passed one, a signal) | `error` |
  | a scenario failed | `failed` |
  | a scenario was flaky | `flaky` |
  | otherwise | `passed` |

  - A stop that came too late to change anything is no stop: a drain that skipped nothing (`run.end`
    present, not interrupted, none drained), or an interrupt asked once the tests were over (not
    sent, §4.5) while the runner still ended on its own; so is a stop asked once the runner had
    exited on its own, which the launch never takes (§4.5). That run is judged by its results.
  - "No tests found", which a filter matching nothing writes as an error, is skipped by the suite's
    own rule (`isNoTestsFound`): the run reads `no scenario ran: none matched`. The time limit is
    checked before outside errors, since Playwright also writes one for it (V377).
  - The reason is one line, ≤ 500 code points, masked (§4.10): the failed setup's line from the
    facts, else the stream's; for `bddgen`, the log's first line naming an error, else its exit;
    otherwise the exit and the log's last three lines. A stream over its cap reads as such, not as a
    run that never finished. A launch that fails is `error`, `the run could not start: …`; an end
    that cannot be read is `killed` or `stopped` from the stop taken, else `error`.
- The record, `run.json` (`runs/record.ts`) — the one file the orchestrator reads back (orphan
  check, retention), so it stays small whatever the run did (a few KiB at most; read with a 1 MiB
  cap). States:
  - `running`: first with `starting: <process>`, then with the process, its group and its leader's
    start — Linux `/proc/<pid>/stat` field 22 with the boot id; macOS `ps -o lstart=` under
    `LC_ALL=C TZ=UTC` (V407); unreadable, recorded as such;
  - `ended`: how the processes ended (`notStarted`, the cause, for one that could not start), the stop
    taken, status, reason and counts — the whole event
    and the Datator record live beside it (§4.9);
  - `lost`: set by a later start's orphan check on a run provably over without an `ended` record,
    with `foundAt` and why; it keeps the process. Not `ended`, which promises the exits and the
    event a lost run lacks. A `lost` run is never announced.

  Writes go through one writer per run, in call order; once `ended` is written, a late `running`
  write is dropped. Every state file is written atomically (`state/atomic.ts`: a `wx` temporary file
  `0600`, synced, renamed, its folder synced), never through a link.
- Orphans (`state/orphans.ts`): a detached run outlives an orchestrator killed by SIGKILL or a
  crash, and nothing reports it. At start, under the lock, every task's run folders are read
  (selected or not; `state/run-folders.ts`, never through a link), and each `running` record is:
  - an orphan when its group is alive and its leader matches (same start time) — or when it is not
    provably over: a live group whose leader is gone (the kernel never hands out a live group's id
    again, and a Playwright worker outlives its runner's SIGKILL by ~30 s, V409, V411), a leader
    start unread, a group of another user's processes only (`EPERM`), a process recorded as
    `starting`. Any orphan refuses the start, naming the task and run, how to check
    (`ps -o pid,user,lstart,command -g <pgid>`, or `lsof -- <run.log>`), how to end it
    (`kill -KILL -<pgid>`, only when confirmed as the run's), and how to mark a false positive over
    (set `"state"` to `"lost"` in its `run.json`);
  - stale otherwise — its group gone, its group id now led by another process (V402), or its leader
    recorded in an earlier boot of this machine (`linux:<boot>:…`, judged by the lock's `earlierBoot`:
    host PID namespace, same machine id and host) — and rewritten `lost`.

  A run folder whose `run.json` is there but cannot be read (`EACCES`, a link, a FIFO, over its cap,
  malformed, naming another folder) is an unconfirmed orphan: nothing says its run is over, and every
  record is written atomically, so a failed write leaves none (a folder without `run.json` is passed
  over). Its refusal says how to find its processes (`lsof -- <run.log>`) and, none found, to repair
  the record or set it aside (`mv run.json run.json.unread`). An entry of `runs/` that is no folder is
  warned about and passed over.

### 4.5 M5 — Stopping

Per run, the orchestrator's half of Phase 0's 0C (`runs/stop.ts`): drain (create the stop file) →
one SIGINT to the Playwright process → SIGKILL to the group; ended on `ESRCH`. Never SIGTERM a run,
never a second SIGINT. A stop only goes further, each step at most once; an interrupt asked at once
drains first; a kill needs nothing before it. While `bddgen` runs, any stop kills its group
(generation has nothing to drain) and is taken as `drained`, so the run reads `stopped`, and the
runner is never started. No SIGINT once the results stream holds `run.end` (`runs/stream-end.ts`):
Playwright removes its SIGINT listener once the tests are over, so a SIGINT then would end the
runner mid-report (V399); the kill budget still guards a hang. A stop changes nothing once nothing
runs. Once the runner has exited on its own, its group still tearing down (`lingering`), no stop is
taken: a drain or interrupt has nothing to reach and does nothing, and a kill SIGKILLs the leftover
group once without being taken — so a crash still reads `error`, and a finished run keeps its
results. `bddgen` exiting changes nothing: its group's kill still keeps the runner from starting.

| Signal to the orchestrator | Effect |
| --- | --- |
| SIGINT (Ctrl-C), first | No new run; cooldowns end; every run drains. After 15 min, interrupt |
| SIGINT, second | Interrupt every run now. After 4 min, kill |
| SIGINT, third | Kill every run now |
| SIGTERM, SIGHUP, the parent ending | As the first SIGINT when nothing is stopping yet; otherwise nothing |

- The budgets (`runs/shutdown.ts`): the drain 15 min, since a BackWPup scenario's timeout grows by
  10 min per backup; interrupt to kill 4 min — a 120 s hook, 30 s of fixtures, 30 s of browser
  close, then the reports. SIGINTs less than 1 s after the last one counted are one (as in
  Playwright; a monotonic clock): one Ctrl-C under `npm run` arrives as two SIGINTs 1–31 ms apart
  (V122, V467).
- Only SIGINT escalates: an SSH session closing after a Ctrl-C (SIGHUP), or a service manager
  repeating SIGTERM, cannot cut the operator's drain short.
- Each escalation stops every loop (§4.3), not only the runs, so cooldowns end and nothing starts,
  and is said as what happens now and next: `stopping: …` (no new run; every run finishes its
  scenario in progress; Ctrl-C again to interrupt them; interrupted anyway after 15 min), then
  `interrupting every run: …`, `killing every run: …`. The reason names the cause and the escalation
  (`…(SIGINT); interrupted: the drain took over 15 min`).
- Runs are detached, so the terminal's Ctrl-C reaches the orchestrator alone (V121). SIGHUP covers
  an SSH session closed outside `tmux`; the closed terminal's writes then fail (`EPIPE`, `EIO`) and
  are dropped, the log keeps them.
- The parent watch (`parent.ts`): the parent's PID at boot, read as `command.ts`'s first import
  evaluates — before the module graph, the command line and the config —, compared with
  `process.ppid` once as `start` begins, then every second (unreferenced); a changed parent — npm
  killed by a SIGHUP, which npm does not relay (it relays SIGINT and SIGTERM, V471), or a reparent to
  a subreaper — is said and taken as SIGHUP. Under npm (`npm_lifecycle_event` set) a boot parent of
  PID 1 is npm gone already. Not caught: npm gone before that first import on a host whose orphans go
  to a subreaper.
- The handlers are installed first, so a signal at any point counts, and removed before `start`
  returns. A signal before any run: `stopped before any run started`, exit 130.
- The wait: the loops are awaited without a limit until the shutdown reaches `killed` (a third
  Ctrl-C or the budgets); from then, 60 s more (`KILL_SETTLE_MS`: a SIGKILLed group empties at once,
  the rest is reading and announcing the end). On running out,
  `stopped waiting: <task> did not end within 1 min of the kill`, then, for each run this start
  began whose record still says it runs, its group judged as the orphan check does: confirmed,
  `<run> left behind, still running in process group <pgid>: end it with kill -KILL -<pgid>`;
  unconfirmed, `may be left behind … — unconfirmed: <why>. Check it first: ps …`, no kill command;
  its group ended, `left nothing to kill`. The next start's orphan check refuses on a run still
  alive.
- The exit: settle the bus (each delivery bounded by its limit), close `orchestrator.log`, release
  the lock (after the log, so the log is only ever written under it; a later line goes to stderr),
  drain the terminal and standard error together (on macOS a pipe is written asynchronously and
  `process.exit` drops what it holds, V538); 130. From the exit code on, the shutdown is disposed and
  the parent watch stopped: a signal during the exit says nothing. Stopped and killed runs are still announced (`run.finished`).
- A killed run leaves its site dirty until its cell's next run, whose `@plugin` Before path (0C's
  `stopRunningWork` first) recovers it (Phase 0's 0C live check L3; again in 5J, V491). The parent's
  cleanup chain after a kill comes later.

### 4.6 M6 — Events

- `events/bus.ts`: `createEventBus({ timeoutMs, log, secrets })` with `on(type, handler, name)`,
  `publish(event)` and `settle()`. `publish` returns at once; each handler starts a turn later (an
  async wrapper would run its synchronous part inside `publish`, and a handler publishing again
  would recurse), runs beside the others, and gets an `AbortSignal` that aborts at its time limit
  (30 s by default), for `fetch`. A throw, a rejection or a timeout is one masked line under the
  subscriber's name and never reaches the run (parent §2: a subscriber never holds up a run);
  nothing in the bus can reject (a failing log drops its line; any thrown value becomes text).
  `settle()` waits for every delivery in flight, one published meanwhile included; synchronous work
  cannot be cut by the limit.
- Slack and Datator share one subscriber, `notifications` (`notify/subscribe.ts`) — two would need a
  join for the one line, which a timed-out one never reaches: both sent at once, each with the bus's
  signal and the secrets, then one line per run naming Slack first (§4.1); neither configured,
  nothing is subscribed. A formatter that throws is that sender's `✗ not sent: …`; the other still
  reports. Each sender's own 15 s limit is under the bus's 30 s. No unsubscribe: nothing publishes
  once the loops have ended.
- One event: `run.finished`, `v: 1` (`events/run-finished.ts`) — the parent's payload (parent §2)
  minus the dashboard link. Unknown facts are `null`, never absent, so a subscriber reads every
  field — but a scenario's `error`, absent when it has none:

  | Field | Content |
  | --- | --- |
  | `v`, `type`, `at` | `1`, `"run.finished"`, ISO time |
  | `run` | `id`, `runId` (`RUN_ID`), `name` (the task's, else the run's id), `trigger` (`"loop"`), `task` (`id`, `name`, `grep` — Datator's `test_suite` needs it) |
  | `unit` | `product`, `cell`, `edition` |
  | `plugin` | `requestedRef` (`null` for the product's default), `ref` built, `commit` (full; `null` for a release's zip), `version`, `name` (the `Plugin Name:` header) |
  | `sites` | per site of the pool, in pool order: `baseURL` (`safeSiteUrl`), `wordpress`, `php` (the site's own, V28) |
  | `status`, `reason` | the run's status (§4.4); the reason for `error`, `stopped`, `killed`, else `null` |
  | `startedAt`, `endedAt`, `durationMs` | |
  | `counts` | `total`, `passed`, `failed`, `flaky`, `skipped` (drained ones included), `didNotRun` (an interrupted one included) |
  | `scenarios` | each that finished, in first-ended order: `feature`, `name`, `path` (Rule and Outline titles, at most 8 deep), `status`, `attempts`, `durationMs`, `error` (the first, ANSI stripped, line feeds kept, ≤ 2,000 code points) |
  | `report` | `dir`, `log`, absolute; both `null` for a run refused before its launch made a folder |

- Built by a pure function (`buildRunFinished`) from the run, its outcome, results and facts, so
  every field is unit-testable. Its text is safe to send: masked (§4.10), terminal codes removed,
  control and invisible characters dropped (CR, U+0085 and U+2028 become line feeds in an error); a
  name ≤ 1,000 and a fact ≤ 300 code points, each one line. Each subscriber still escapes for its
  own format.
- Later events (`run.queued`, `build.*`, …) add types; this one keeps its shape, and a change that
  would mislead a subscriber bumps `v`.

### 4.7 M7 — Slack

- One message per run, every status (`notify/slack.ts`):
  `POST { text, unfurl_links: false, unfurl_media: false }` (the fields Slack's own webhook client
  sends) with `fetch`, 15 s, the bus's signal too, redirects not followed. Success is only `200`
  with body `ok`; anything else — Slack answers `invalid_payload`, `no_service`,
  `channel_is_archived`, … (V120) — is logged with its status and answer, the webhook masked whole,
  by its path and by its token. No retry.
- Text: `&`, `<`, `>` escaped as Slack requires (V120; `<!channel>` in a scenario's name would
  otherwise ping), a lone surrogate made U+FFFD, each run of three backticks or more written in `ˋ`
  (U+02CB) — Slack has no backtick escape, and two such names would make the lines between them one
  code block; every piece cut after escaping, never inside `&amp;`, so the worst message stays under
  20,000 characters, well under Slack's 40,000-character truncation. Slack's own formatting (`*`,
  `_`, a bare link, `:emoji:`) is left to it: a run can style its text, not ping, hide a link or
  reach past its line.

  ```text
  *[E2E Orchestrator]* ❌ FAILED — BackWPup Pro · pro@nginx
  52 scenarios: 49 passed · 1 flaky · 2 failed, in 54m 10s
  Plugin: BackWPup Pro 9.99.99 · develop @ f1ebfd0
  Site: https://simple.e2e.rocketlabsqa.ovh · WordPress 7.1.2 · PHP 8.5.10
  Failed:
  • Backups › A backup runs on demand — Expected "Done", received "Error" …
  • CLI › Logs are listed — Timeout 30000ms exceeded …
  Flaky:
  • Onboarding › The first backup is offered
  Report: scp -r auto-e2e:/home/…/reports/backwpup/pro@nginx/<RUN_ID> .
  ```

- Headlines: `✅ PASSED`, `⚠️ FLAKY`, `❌ FAILED`, `🚫 COULD NOT TEST`, `■ STOPPED`, `■ KILLED`, after
  the `*[instance]*` prefix, naming the plugin (`Plugin Name:`, else the product) and the cell.
- A count shows only when not 0 (`skipped` and `did not run` too). `Reason:` for every status that
  has one, so a stopped run says why beside what it tested. `COULD NOT TEST` drops the counts and
  lists and adds `Took:` and `Log:`. At most 20 scenarios, failed first, then flaky, each list
  ending `…and N more` when cut; a title ≤ 300 characters, its error's first non-blank line ≤ 200.
  One `Site:` line per site, at most 10, then `…and N more sites`. A commit with no ref reads
  `commit abc1234`; a nameless scenario `(unnamed)`. A run without a folder has no `Log:` or
  `Report:` line.
- `Report:` and `Log:` are code spans, so an `_` in a path is no italics (unless the path holds a
  backtick). With `reports.sshHost` they become `scp [-r] <host>:<path> .`, single-quoted when a
  shell would split them — quoting for the local shell only: scp's default SFTP mode globs `*`, `?`
  and `[` at the far end, and legacy `-O` hands the path to a remote shell unquoted (V390). The
  paths are the checkout's and the state directory's.
- **Next run in the message — the user's idea, 2026-10-22, not a decision.** Append, at the end of
  every Slack notification, when the next run starts — e.g. `Next Run in 60 minutes @ 19:53:23 UTC`
  for a 60-minute cooldown. The implementing agent must first assess whether this is the best
  presentation and data flow, and record the decision here. Position it last, after `Report:`/`Log:`,
  escaped like every other text.
  - The line is true only when another run is certain: never under `--once`, after a stop, in a
    `failed` loop (processes not watched to their end, cell lost, timers) or — in Phase 1 — when a
    backoff replaces the cooldown. `cycle.ts` builds and publishes `run.finished` in `conclude`
    before `loop.ts` decides to cool down or ends; `slack.ts` sees only the event and
    `instance`/`sshHost`. Do not guess `endedAt + cooldown` in Slack: it ignores prune time, the
    clamp, stops and backoff. Assess moving publication after the loop's decision, adding a schedule
    field to `run.finished`, or another flow; no second message.
  - The armed timer is `now + cooldownDelay(endedAt, now, cooldown)`, not always `endedAt +
    cooldown`: a prune longer than the cooldown waits nothing, a clock stepped back waits from now.
    `nextRunLine` (terminal) shows local `HH:MM:SS`; Slack needs the same instant. Decide between
    UTC (unambiguous, as in the example), the reader's local time (verify Slack's date markup), or
    both; relative time goes stale after sending, absolute does not. State the cooldown separately
    only if it adds value.
  - When there is no next run, omit the line or say why (`--once`, stopped, loop failed); never
    show a time that will not happen.
  - Tests must compare the line with the timer actually armed: a normal loop, `--once`, a stop
    during and after the run, an unwatched or otherwise failed loop, a clamped/stepped clock, a
    future backoff, UTC/DST, and the message limit. One spec must fail if the time is off.
- Node's `fetch` honours proxy variables only with `NODE_USE_ENV_PROXY`, the operator's choice (5J
  used it to reach local stand-ins).

### 4.8 M8 — Datator

- `POST` the configured URL with `X-API-Key`, JSON (`notify/datator.ts`); success is only `201`;
  anything else is logged with its status and the answer's first 500 characters, the key masked. 15
  s, no retry, redirects not followed (`fetch` would follow Datator's `301` with a `GET` and report
  the page it landed on, V384). The record posted is the one kept as `datator.json` (§4.9), frozen,
  so the file is the very object sent.
- Only runs that tested — `passed`, `flaky`, `failed`. Not `error`, `stopped` or `killed`: a broken
  branch or site is not a regression (parent §2), and AutoE2E posted nothing when a cycle crashed.
- Mapping, against Datator's own serializer (V117, V118, V385):

  | Field | Value |
  | --- | --- |
  | `product` | AutoE2E's codes: `backwpup`, `wp_rocket` (`wp-rocket`); otherwise the product's name |
  | `test_suite` | the cell, `pro@nginx`; with a filter, `pro@nginx @smoke` (D1); cut to 255 |
  | `timestamp` | the run's start, ISO UTC |
  | `total_tests` / `successful_tests` / `failed_tests` | every scenario / `passed` + `flaky` / `failed`; `skipped` is in neither (D2) |
  | `git_commit` | the full commit, `null` when there is none (a `release:` build) or it is not 40 or 64 hex digits |
  | `test_duration_seconds` | the run's duration, an integer — `845.7` is refused (V118) |
  | `website_url` | the pool's first site's `baseURL`, its user and password dropped (the event shows them `***@`, which would split the site's series), at most 255 once they are gone, `null` unless Django's `URLValidator` surely accepts it: kept only when the URL parser writes it back unchanged (a trailing `/` aside) and its host is `localhost`, an IPv4 address or a DNS name with a TLD — so `http://wp-apache`, a Docker cell's host, is dropped (V385, V388, V389) |
  | `test_cases` | per scenario: `feature_name` and `test_name` (prefixed with its Rule/Outline path) cut to 500 code points (501 is refused, V118), `(unnamed)` when blank after trimming; `status` `passed`, `failed` or `skipped` (`flaky` → `passed`, D2; an interrupted scenario `skipped`); `error_message` the first error, ≤ 4,000 characters |

- Each refusal loses the whole run, so what Datator refuses is avoided first (V385): blank names,
  lone surrogates (made U+FFFD), out-of-range lengths (counted in code points, as Python does), a
  non-integer duration, a URL its validator refuses. Datator checks nothing else: no enum on
  `product`, `test_suite` or `status`, no `total = successful + failed` (V117, V118). The caps keep
  a full run's body near 100 KB (500 failed scenarios at the caps ≈ 2 MB, accepted, V385); the app
  accepted 2.6 MB, but what sits in front of it in production is unknown.

### 4.9 M9 — State, logs and retention

```text
.orchestrator/                the state directory: the config's folder; this user's, closed to other writers (go-w)
  config.json                 git-ignored, 0600
  orchestrator.lock           its holder: PID, start, PID space, token
  orchestrator.log            the terminal's lines, each with its ISO date, time and offset; 0600
  tasks/<id>.json             a task's run counter (tasks/ 0700)
  runs/                       made 0700; this user's and go-w wherever it is made or read; never a link
    <run id>/                 0700: run.log, run.json, stop (once drained); run-finished.json, datator.json (0600) once ended
$XDG_STATE_HOME/wp-media-e2e/site-locks/   (else ~/.local/state/…) both 0700, never links; every config of this user
  <32 hex>.lock               a site's lock, 0600: its holder, the site's key, the cell, the latest run.json (§4.3)
```

- The state directory's lock (`state/lock.ts`) keeps one orchestrator per state directory, since two
  would run two loops on one cell:
  - written whole or not at all: a temporary file hard-linked into place, which never replaces nor
    follows (a filesystem without hard links gets a plain refusal);
  - its holder judged only in its own PID space (Linux: boot id, `/proc/self/ns/pid`, machine id;
    else the host): a lock from another container, host or boot is refused, naming where it was
    written — except one from an earlier boot of this machine (same machine id and host, host PID
    namespace), whose processes all ended. In its space the holder is dead when `kill(pid, 0)` finds
    no process or that PID's process started at another time (a reused PID); `EPERM` is alive;
  - an owner record over 8,192 bytes (what a lock is read with) is never written, so no lock is
    unreadable to its readers;
  - a dead holder's lock is taken over under an exclusive claim and a re-check; a dead claimant's
    claim is cleared the same way, three deep at most; a second start in one process is refused by
    its token. Leftovers (temporary files, claims) are swept at start — through a linked state
    directory to where it leads, `tasks/` never followed;
  - the state directory must be this user's and closed to other writers (`go-w`); `tasks/` and each
    run folder `0700`; each refusal names its `chown`/`chmod`.
  - Limit: a container restarting into a new PID namespace reads its own lock as another's and is
    refused until the lock is removed — it cannot tell that namespace is gone; the message names
    `--pid=host` (§6).
- What a run keeps: the lean `run.json` (§4.4); beside it `run-finished.json` (the whole event) and
  `datator.json` (only for a run that tested, Datator configured), each written atomically before
  the `ended` record — a failure a line, never keeping the `ended` record from being written — and
  never parsed back. They grow with the scenarios (≈ 2.2 MB each for 1,000 failed at the error cap),
  and a file no reader parses can never make a run folder undated (an undated folder is kept for
  ever). Limits, kept: a full disk that fails both the first and the `ended` record leaves a folder
  without `run.json` (said twice in the log); a `run.finished` that cannot be built leaves the
  `running` record for the next start's orphan check.
- Reports are pruned by the suite at each run's end (0F), per cell — one task per cell here, so per
  task too. `runs.reportsKeep` sets `E2E_REPORTS_KEEP` (default 20; `0` lifts only the cap, the 30-
  and 182-day rules still run). At ~55 min a cycle, 20 reports cover ~18 h; AutoE2E kept 4 days —
  raise it if that history is wanted.
- Run folders follow the same policy at each run's end (`state/run-retention.ts`, 0F's
  `planRetention` and `applyRetention`, a task one group, `keep` from `runs.reportsKeep`). A task's
  folders are those whose name `runIdOf` gives back exactly; each is dated by its record's
  `startedAt`, never its mtime; the run in progress and every `running` folder are kept; a `lost`
  one is dated and pruned; a malformed one is undated, kept and counted in a warning line.
- Retention's cost grows with what it keeps: each run's end and each start's orphan check read every
  run folder's `run.json` (8,000 folders: 2.3 s). `runs.reportsKeep: 0` leaves only the 30-day rule
  — at a 1-minute cooldown and runs that fail fast, tens of thousands of folders a month. Keep a
  cap.
- `orchestrator.log`: a few lines per run, never rotated by the orchestrator (worst case 0.75–1.4 MB
  a day). Opened `O_APPEND|O_NOFOLLOW|O_NONBLOCK` as a regular file of this user's with one link, a
  wider mode tightened to `0600` and said; one write queue; a half line after `ENOSPC` never merges
  with the next. It stays open for the process's life, so a `logrotate` that renames it leaves the
  orchestrator writing to the renamed file: rotate with `copytruncate` (the copy may lose the lines
  written during it), or not at all. The terminal's lines are `HH:MM:SS <scope>  <text>`, styled on a
  TTY by modernization Phase 7; the words and the file's line are unchanged.
- The orchestrator never reads `E2E_*` variables (parent §1); only its config and flags.

### 4.10 Secrets in output

- Everything the orchestrator writes or sends — terminal, log, stderr, `run.json`, the kept files,
  the event, Slack, Datator — is masked by value first, then by shape (a shape matching inside a
  secret would mask only that part and leave the rest, which no value then matches):
  - by value: every secret it holds (`config/secrets.ts`, `allSecretValues`: the runs' secrets; the
    Slack webhook whole, its path and its token; Datator's key; every task's sites' passwords,
    storage keys and `baseURL` passwords (as written and decoded), selected or not; the lowercased
    SSH hosts that hold a secret, as the crowded-server warning shows them), each trimmed and also as
    cleaning writes it (an invisible character dropped), in every form a service may echo — as
    written, URL- and form-encoded, JSON-escaped (PHP's `\/` too). Every occurrence of every form is
    found first and each run of overlapping ones masked as one, so no order can leave a secret's
    rest in clear (`maskValues`);
  - by shape: the suite's `redactSecrets` (a URL's userinfo, including a password a URL parser would
    refuse; a GitHub token; a credential URL parameter; an `Authorization` header; a WordPress login
    cookie).
- Masked before and after cleaning terminal codes and invisible characters: a token split by a
  zero-width space is joined whole by the cleaning, and a password holding a control character is
  split by it.
- Before every cut mark (the stream's `… [truncated]`, the run facts' and summary's `…`, our own
  cuts), the longest head of any form of any secret — four characters or more, never all — is masked
  (`maskCutTails`; over-masking is fail-safe). A notification answer cut by its 8 KiB read cap loses
  its last 256 code points, or the longest secret's length, after masking.
- A value under 8 characters is never masked by value (it would mask words); only never printing its
  field keeps it out, so no field holding a secret is printed anywhere (the dry run names them). A
  URL without `//` (`foo:user:pw@host`) matches no shape; the dry run shows a stand-in for it. An
  answer still quoting a secret in any form — each secret trimmed, and as cleaning writes it — is
  withheld:
  `HTTP 403 (its answer is withheld: it quotes a secret)`.
- Network failures are our own words (`ECONNREFUSED`, the time limit, `cancelled`), never `fetch`'s
  message, so a URL never reaches a log. A site is shown by `safeSiteUrl` (`text.ts`): masked by
  value, then the suite's `maskSiteUrl` (an http(s) URL's host, port and path as written,
  credentials `***@`, no query or fragment; anything else a stand-in), then masked again.
- Checked live: no secret in the state directory, reports, `test-results/` or terminal captures
  (V492, V536).

### 4.11 Not planned here, on purpose

The disk warning (0A.3) needs a remote `df` per run; a Slack test message, `status`, `logs` and
`stop` commands need the API. All belong with Phase 1's service. Per-run terminal progress arrives
earlier, from modernization Phase 7: a table tailing each run's `results.jsonl`.

## 5. Code layout

```text
orchestrator/
  cli.ts                    the entry: process.exit(await runCommand(…)), nothing else
  command.ts                commander: start, its help, npm's taken options refused
  start.ts, start-lines.ts  the process: lock, orphan check, site locks, loops, signals, exit code
  dry-run.ts                --dry-run's report (and the ref a run's started line names)
  config.example.json       the committed example (§4.2)
  suite-imports.json        the suite modules it may import (below)
  config/                   schema (zod), parse, json-keys, check, site-key, load, secrets, product-list, errors
  tasks/                    cycle.ts (one run), loop.ts (cycle, cooldown, --once), run-lines.ts
  runs/                     identity, environment, commands, launch, process-group, stream-end, stop,
                            shutdown, end, results, facts, outcome, record, leader
  events/                   bus, run-finished (types + builder)
  notify/                   post, slack, datator — pure formatters, thin senders; subscribe
  state/                    atomic, read, errors, lock, lock-owner, pid-space, leftovers, cell-lock,
                            counter, orphans, inspect, run-folders, runs-folder, run-retention
  log.ts                    a Logger (terminal + file now, pino behind it later); stdout non-blocking
                            through src/common/terminal/stream.ts
  text.ts, files.ts, folders.ts, error-code.ts   masking and cuts; bounded reads; folder rules
  soak.spec.ts              the soak: the real start over the fake suite (ORCHESTRATOR_SOAK=1)
  __fixtures__/             fake-suite, fake-start + swap-start.mjs, http-sink, import-boundary,
                            results, run-finished, file-handle, soak (+ its spec); slow-reader moved to
                            src/common/__fixtures__/
```

Every module takes its clock, paths, `kill` and launch as arguments, so the fake suite (a `node -e`
script that writes a results stream, traps SIGINT, watches the stop file and can leave a child in
its group) drives everything with real processes and signals and no site; `cli.spec.ts` runs the
real script, `cli.ts` and `command.ts` over it through `swap-start.mjs`.

- `tsconfig.json` includes `orchestrator/**/*`; `playwright.unit.config.ts` has one project per
  folder (`src`, `orchestrator`; its comments say why). To run the orchestrator's specs alone use
  `--project=orchestrator`: a path filter is a regex on the absolute path, and this worktree's path
  holds `orchestrator`. `.gitignore`: `/.orchestrator/`.
- Dependencies: `commander` 15 and `zod` 4.6.7 (ESM; V127, V359, V468), dev dependencies like tsx —
  hence `npm ci`, never `--omit=dev` (§6). Hono, SQLite, pino and React wait for the phases that
  need them.
- The import boundary. The orchestrator is long-lived and must keep the process-wide state it
  started with, while `run-context.ts` — and `resolve.ts`, `consume.ts`, `project.ts`, which import
  it — loads `.env` and stamps `RUN_ID` as it is imported (V84, V130). So it imports from the suite
  only what `suite-imports.json` lists: `src/common/artifacts/request.ts`, `config/run-env.ts`,
  `config/run-id.ts`, `config/sites.ts`, `reporting/results-reader.ts`,
  `reporting/results-schema.ts`, `reporting/retention.ts`, `src/common/terminal/capabilities.ts`,
  `terminal/palette.ts`, `src/common/text.ts`, `src/projects/products.ts` — each admitted only once the boundary spec passes with it. Not
  `reporting/run-facts.ts`, which imports the reporter's whole summary: `runs/facts.ts` reads the
  file itself (a spec checks its name against the suite's). Enforced twice, since a lint rule sees
  only an import's spelling, not where it leads or what that module imports, and misses `import()`
  (V135, V345):
  - ESLint (`eslint.config.js`, reading the same JSON, V335) refuses any other path into the suite,
    test code, the builtins `module`, `worker_threads`, `vm`, `inspector` and `repl` (each loads or
    runs code no guard sees, V349), `process.getBuiltinModule`, `eval` and `new Function`
    (`no-implied-eval` lints `.ts` only, V353). Test code (`*.spec.*`, `__fixtures__/`) is exempt
    from both guards and never importable by production code.
  - `orchestrator/import-boundary.spec.ts` reads TypeScript's syntax tree (V336), judges each import
    where it resolves (V337), refuses the same builtins and names, a computed `import()` and
    CommonJS files (`.cts`, `.cjs`, a `"commonjs"` `package.json`: they get `require`, V352), walks
    all an admitted module can load (never `load-env.ts` or `run-context.ts`, even lazily), then
    imports each admitted module and every orchestrator module but `cli.ts` (which runs as it is
    imported) in a fresh Node and proves the process unchanged (`import-probe.ts`: environment,
    listeners, working directory, exit code, umask, listener limits, `Error.stackTraceLimit`;
    `fetch`, `process.exit`, `cwd`, `chdir`, `fs.close`, `fs.closeSync` not replaced). Accepted by
    name, only by its own marks: graceful-fs's patch, which Playwright's bundles apply and the
    product list reaches (`GRACEFUL_FS_PATCH`, V511) — avoiding it would need a product list that
    never loads its products' support code.
  - Stated limits — the guards catch mistakes, not evasion: a module's output and globals (the
    product list prints `[sites]` warnings by design); what an unref'd timer or a function does
    after the import; what a package does; a name built at run time or reached through a string
    (`Reflect.get(process, "getBuiltinModule")`); a constructor reached at run time
    (`(async () => {}).constructor`); Node's internals (`process.binding("contextify")`,
    `process.dlopen`) (V354). A type-only import from the suite needs admitting like any other.
- The product list (`src/projects/products.ts`) builds every product's config as it is imported: it
  reads every sites file once, prints a `[sites]` warning for a product with none, and throws on one
  that is not valid JSON. So the orchestrator loads it only through `loadProductList`
  (`config/product-list.ts`), once, inside the start's error handling: a throw becomes a
  `ConfigError` keeping the failure's own message (it names the file) and no cause — `JSON.parse`'s
  message quotes the text around the error, credentials included, and a logged error prints its
  causes (V361). It returns `PRODUCTS`, `productByName` and `playwrightConfigFor`, frozen, never
  `productFromEnv` (which reads the environment). Node keeps a module whose evaluation threw, so a
  failed load is final for the process (V355): fine for once, at start.
  - Rejected: a static import (a broken WP Rocket sites file would crash a BackWPup-only
    orchestrator, with a stack, and a sites edit could never be a config error); a lazy product list
    (it changes the import contract of every cross-product entry point — the bare config, the
    healthcheck, the warm — which validate every product up front by design). Worth reconsidering
    only if a broken other-product file proves a real problem on the runner.

## 6. Running it on the runner

Which machine is D4. On it:

1. Tools: Node ≥ 24.16 and npm; git; for BackWPup builds composer (PHP CLI) and `gulp-cli` (V123);
   Chromium's system libraries (`npx playwright install-deps chromium`, once, with `sudo`; `npm ci`
   installs Chromium itself); `tmux`. No X server (V126).
2. A checkout of `develop` and `npm ci` — never `--omit=dev` nor `NODE_ENV=production`: tsx, zod and
   commander are dev dependencies. The cells' `sites.json` (`0600`), with SSH keys reaching the
   WordPress servers; `npm run healthcheck` passing for those cells — the parent's setup step.
3. GitHub: `gh auth login` as that user, or `secrets.GITHUB_TOKEN` (BackWPup's repository is
   private).
4. Config: `cp orchestrator/config.example.json .orchestrator/config.json`, then
   `chmod 600 .orchestrator/config.json`; one task per cell, AutoE2E's Slack webhook and the Datator
   key (D5); check it with `npm run orchestrator -- start --dry-run`; try one cell with
   `npm run orchestrator -- start --task <id> --once`. The state directory must be this user's and
   closed to other writers: Ubuntu's default user umask (`002`, with `USERGROUPS_ENAB`) makes a
   `mkdir`'d one `0775`, which the start refuses (and the dry run warns) naming `chmod go-w`. Run
   the orchestrator on the host, or in a container only with `--pid=host`: a container restarting
   into a new PID namespace reads its own lock as another's (§4.9).
5. Stop AutoE2E's instance for those cells first — the sites are dedicated (parent §1). AutoE2E's WP
   Rocket instances stay: this suite has only WP Rocket's three scaffolding scenarios (V125).
   **Done 2026-10-22:** the AutoE2E server (`qa-auto-e2e`, WordOps, nginx 1.28.2, 4 workers) served
   HTTP/3 on both sites with no `reuseport`, so its workers shared one UDP socket and lost 4.4%/8.7% of
   requests after idle gaps (phase-6 plan V293). `reuseport` added to `auto-e2e-backwpup`'s
   `conf/nginx/ssl.conf` quic lines (once per port, else nginx refuses "duplicate listen options"; it
   covers both sites; committed in that folder's git); probe after: 0 of 2 880 lost on each site. If
   that site is ever removed, move `reuseport` to another site's quic lines. Recheck:
   `node ~/.local/share/wp-media-e2e/probes/h3burst.mjs <origin> 8 10000 120` must report `"fail":0`.
6. Start, detached: `tmux new -d -s orchestrator 'npm run orchestrator -- start'`. Watch:
   `tmux attach -t orchestrator` (leave with Ctrl-b d), or `tail -f .orchestrator/orchestrator.log`.
   Stop: `tmux send-keys -t orchestrator C-c` (the drain, §4.5), or attach and Ctrl-C. Use `tmux`,
   not `nohup`: Node's own SIGHUP handler replaces the `SIG_IGN` `nohup` sets, so a hangup still
   stops it. A signal by hand: SIGINT or SIGTERM to the orchestrator's PID (the started line's) or
   to npm's; SIGHUP to the group (a SIGHUP to npm's PID alone ends npm, and the orchestrator drains
   within a second once it sees its parent gone). The same parent watch means no launcher that exits
   (a backgrounding wrapper, `… &` from cron, a forking service) can start it: it would drain at
   once. Every option goes after `--` (§4.1).
7. Update (D3): stop, wait for the drain; `git pull --ff-only && npm ci`; start again.

## 7. Implementation order

| Step | Delivered | Done |
| --- | --- | --- |
| 0 | The scaffold: `orchestrator/` in `tsconfig.json` and the unit config, `.gitignore`, both import guards (§5), each shown to fail on a forbidden import | 2026-10-12 |
| 0.1 | What step 0's audit left open: 0.1a `loadProductList` (§5); 0.1b the suite resolves an absolute `ARTIFACTS_ROOT` (`cellArtifactsDir`) instead of nesting it under the checkout; 0.1c the boundary's cheap routes closed (builtins, `eval`, `Function`, `getBuiltinModule`), the rest stated | 2026-10-13 |
| 1 | M2: `config/` and the example | 2026-10-13 |
| 2 | M4's pure parts (identity, environment, results, facts, outcome), M6 (`run.finished`, the bus), `text.ts`; the suite's `runReportDir` and `run-env.ts` | 2026-10-13 |
| 3 | M7 and M8: `notify/post.ts`, `slack.ts`, `datator.ts` | 2026-10-13 |
| 4 | M4's launch and end, M5's stop and shutdown machines, `run.json`, atomic writes, the fake suite | 2026-10-13 |
| 5A–5E | The logger and terminal; the lock and counter; the leader's identity, the record writer and the orphan check; run-folder retention; the notification subscribers | 2026-10-13 |
| 5F–5I | One run (`tasks/cycle.ts`), the loop, the process (`start.ts`), `--dry-run` (`dry-run.ts`, `state/inspect.ts`), the command and its script | 2026-10-14 |
| 5J | Live checks on `bwu2`/`bwu3` (V486, V489, V491–V493) | 2026-10-14 |
| 5K | Final audit: site locks held for a loop's life, an `unwatched` run ending its loop, cut-tail masking, `runs/` checked, stuck groups said; a quality and documentation pass; the site locks' live smoke (V534–V536) | 2026-10-15 |
| 6 | The docs: the operator's guide (`docs/guides/orchestrator.md`), README's quick start, AGENTS.md's pointers; the soak (`soak.spec.ts`, `npm run orchestrator:soak`, V537) | 2026-10-19 |
| 7 | Full audit (V539): the parent's PID read at boot; a stop once the runner exited on its own not taken (`lingering`); a process that cannot start keeps its cause; proxy, CA and browser-path variables reach a run; an unreadable run record refuses the start, a run from an earlier boot is `lost`; the site locks' parent folder judged; credential-shaped keys, a sites file's values and a split `baseURL` password never shown; overlapping secrets masked as one; `data:` imports refused; Slack code fences broken; Datator's `website_url` without credentials; stderr drained at the exit; live on `bwu3` (V540); the soak (V541) | 2026-10-19 |

### 7.1 Left after this phase

For later phases or the deployment: §8's changes and §4.11; a systemd unit (§4.1); backoff after
errors; a switch turning the suite's end-of-run pruning off (§8); the Slack next-run line (user's
idea, §4.7); on the runner, §6 end to end and V121/V122 there (§9, D4); the first production Slack
and Datator posts (D5, D6). Terminal rendering and the live table are modernization Phase 7, not
Phase 1's service (§4.11).

### 7.2 Traps

Non-obvious failures the audits found, stated as the general rule a new module (Phase 1's included)
must keep; the module each was found in documents its own case.

- Read imports from TypeScript's syntax tree: `ts.preProcessFile` is a token scanner and loses every
  import after a regex literal holding a backtick, `/*` or a quote (V336).
- Mask before and after cleaning terminal codes and invisible characters, and before every cut: a
  token split by a zero-width space passes masking and is joined whole by the cleaning; a secret cut
  by `…` shows its head (§4.10).
- An HTTP POST takes `redirect: "manual"`: `fetch` follows a `301` with a `GET` and reports the page
  it landed on (V384).
- A reader of untrusted JSON caps its bytes and its lines: nested brackets cost ~70–100× their size
  to parse (V401).
- A spec never removes a path joined from a variable its hook may not have set yet: `join("", "..")`
  is `..`: one `afterEach` could empty the checkout's parent (every worktree; `/` in Docker), and
  did in a reviewer's copy. Remove temporary folders through `removeTempDir`.
- A spec that runs the real command points it at a cell no sites file has (`fake@cell`): a first try
  of the swap's preload, ordered before tsx, did not swap `start`, and the real start ran a real
  `pro@nginx` run on `bwu3` — its auth setup ended that cell's saved login and an artifact was
  built; the drain skipped all 70 scenarios, so no plugin was installed.
- A spec SIGKILLs every child it started, with its process group, when the test ends: an orphan of a
  removed copy was found spinning, and a mutation run once left six for nearly two hours.
- As root (Docker), `start.spec.ts`'s stuck-run test fails: it relies on a read-only folder, which
  root ignores. A test environment's limit, not a bug.
- Probe what a module sees (`require`, `module`) from a file, never `node -e`: `-e` puts builtins
  such as `module` on `globalThis` (V352).
- A spec asserting an order, a no-op or a refusal must be able to fail: four passed whatever the
  code did (a flag set after an `await` or unconditionally, a result read before the act). Prove
  each with a mutation.
- A baseline a watch compares with is read when the process starts, never when the watch starts:
  the parent's PID read at `listen` was already the new parent when npm died during the boot (V539).
- Mask by finding every secret's occurrences first, then masking each overlapping run once:
  replacing one secret at a time breaks another that overlaps it and leaves its rest in clear (V539).
- A test of the command drives the real entry through its npm script (`swap-start.mjs`), never a
  copy of the entry's line: a copy left `cli.ts`'s exit and signal handling untested.

## 8. What later phases change, and keep

| Here | Later | Kept |
| --- | --- | --- |
| Tasks in a JSON file, read once | The task store (SQLite), edited through the API | The task fields and ids — imported as they are |
| The run builds its plugin | The orchestrator builds and pins (`E2E_PLUGIN_REF=commit:<sha>`) | Everything else the run is given |
| The suite prunes reports per cell | The orchestrator prunes per task, the suite's end-of-run pruning off — by a switch still to add (`E2E_REPORTS_KEEP=0` lifts only the cap; Phase 0's 0F) | 0F's planner |
| Raw report folders; Slack points at the folder | Allure generated at run end and a prepared `report.tar.gz` ([plan](orchestrator-report-delivery-plan.md)) | The three reports and the run facts |
| `start` in the foreground, in `tmux` | The same process under systemd; the command talks to it over the socket | Signals, stop, loop |
| One event, two subscribers | More events; dashboard, `watch` | The bus and `run.finished` v1 |
| Run records as JSON | Rows in the store | The record's fields |
| A `Logger` writing lines | pino | The interface |

## 9. Verification plan

Done: unit specs for every module, mutation-tested; the loop, stop, orphan and command paths against
the fake suite with real processes and signals (§5); every Datator payload against a local Datator
built from its own `e2e_tests` app (V385), and Slack against a local sink; the live checks on
`bwu2`/`bwu3` (5J, V486, V489, V491–V493; the site locks, V534–V536); the soak (V537); after the full audit, V539–V541. Open:

- On the runner (D4): §6 end to end, and on its own system one Ctrl-C under `npm run` must still
  read as one (V122) and reach no run (V121). Both were measured on Ubuntu 24.04 in Docker, not on
  the runner: V467 (with `exec`, a group SIGINT arrives as two SIGINTs, which the 1 s debounce makes
  one) and the command's signal tests (V121).
- Production receives its first Datator post, and AutoE2E's Slack webhook its first message, from
  the first real run (D5, D6).

## 10. Decisions

| # | Question | Decision |
| --- | --- | --- |
| D1 | Datator's `test_suite` for these runs | The cell (`pro@nginx`; `pro@nginx @smoke` when filtered) — 2026-10-05. Reusing AutoE2E's `test:bwpup` would merge two different suites into one series; dashboards filtering on `test:bwpup` need the new value |
| D2 | A flaky scenario in Datator | `passed`, as AutoE2E's three values — 2026-10-05. `flaky` is accepted (V118) but unknown to the dashboards; `skipped` scenarios count as neither passed nor failed, unlike AutoE2E |
| D3 | Updating the suite on the runner | By hand, while stopped (§6, step 7), until the planned update exists — 2026-10-05. One checkout serves every cell, and a run reads its files while it runs (`bddgen`, step files, `node_modules`), so updating it under a running cell breaks that run; AutoE2E avoids this with one checkout per instance. The planned update — a new-version notice, auto-update, "update now" after a y/N — is in the parent's §3, Updating the suite |
| D4 | The machine, and the cells and sites it runs | The user's, after this phase (2026-10-05). The phase keeps it easy: the example config, `--dry-run`, `--once`, and §6 as a copy-paste guide in `docs/guides/orchestrator.md` (step 6) |
| D5 | Slack destination | AutoE2E's: the same incoming webhook, so the same channel (`#wpmedia_auto-e2e-reports`) — 2026-10-05 |
| D6 | The first production Datator post | The first real run — 2026-10-05; development posts go to the local Datator only |

## 11. Verification

Facts outside this code, and the live checks. The parent's and Phase 0's rows are in the
[orchestrator plan](orchestrator-plan.md).

| # | Claim | Status | Evidence |
| --- | --- | --- | --- |
| V114 | AutoE2E's cycle: first at once, then a 5-minute `setInterval` that skips while a cycle runs; per cycle, plugin and suite `reset --hard origin/develop`, an out-of-repo compile script, `npm run <suite>` with output inherited, results moved to `test-results-storage/<timestamp>` and folders over 4 days deleted, `cucumber-report.json` parsed (a scenario with a skipped step counts as failed) | source | `auto-e2e.js` @ `fa0a5b6`: `start`, `runCycle`, `cloneOrUpdatePlugin`, `zipPlugin`, `updateE2ERepo`, `runE2ETests`, `saveTestResults`, `deleteOldTestResults`, `analyzeCucumberReport` |
| V115 | AutoE2E's messages: Slack text with an optional `*[instance]*` prefix, ✅/❌ and counts, failed `Feature - Scenario` names, WP-CLI versions, an `scp` hint with a masked host; `❌ Auto E2E Script Error!` with no reason on any exception. Datator through `curl` without `-f` — an HTTP error is not noticed — with `website_url` added on 2026-10-02 (PR #19; V23 predates it); nothing sent when a cycle throws | source | `auto-e2e.js` @ `fa0a5b6`: `sendSlackMessage`, `sendDataToDatator`, `getWebsiteUrl`; `git log` (`408dd79`, `fa0a5b6`) |
| V116 | AutoE2E runs as four PM2 processes, one per Linux user, under `xvfb-run -a -s "-screen 0 1920x1080x24"`, restarted 5 s after a crash; suites `test:bwpup` and `test:e2e` | source | `scripts/manage-e2e/manage-e2e.sh` (`get_suite_arg`, `start`), its README |
| V117 | Datator's E2E API: `POST /e2e_tests/results/`, `X-API-Key` compared to `E2E_TESTS_API_KEY` (else `403`); `201` on success, `400` with field errors; `product`, `test_suite` free text ≤ 255; `timestamp` a datetime; three required integers; `git_commit` ≤ 255, `test_duration_seconds` integer, `website_url` URL ≤ 255 — all three optional; `test_cases` optional, each `feature_name`/`test_name` ≤ 500, `status` ≤ 20 free text, `error_message` text. No enum, no cross-field check; DRF authentication classes empty | source | `wp-media/datator` @ `0cff7bc`: `e2e_tests/models.py`, `api/serializers.py`, `api/views.py`, `urls.py`, migrations `0001`–`0002`, `settings/base.py` |
| V118 | Datator's own view, run locally, accepts the planned payload and refuses its edges: `201` for a typical run, `flaky`, `total ≠ successful + failed`, `null` URL or commit, `release-5.7.6` as commit, `845.0`, a zone-less timestamp, no or empty `test_cases`, Unicode, a 2.6 MB body; `400` for a 501-character `test_name` or `feature_name`, a 21-character `status`, `845.7`; `403` without or with a wrong key | measured 2026-10-05 | Django 4.2.1 + DRF 3.14.0 (Datator's pins) in a venv, Datator's `e2e_tests` app unmodified, SQLite in memory, its URL and view through Django's test client; 22 payloads |
| V119 | Production answers at the URL AutoE2E uses: `GET` → `405`; without the trailing slash → `301` to it | measured 2026-10-05 | `curl` to `https://datator.wp-media.me/e2e_tests/results/` and `…/results` — read-only, nothing stored |
| V120 | Slack incoming webhooks: success is `200` with body `ok`; only `&`, `<`, `>` need escaping (as `&amp;`, `&lt;`, `&gt;`); `text` beyond 40,000 characters is truncated; errors include `invalid_payload`, `no_service`, `channel_is_archived`, `action_prohibited` | docs | docs.slack.dev (via Context7): formatting, "truncating really long messages", "sending messages using incoming webhooks" |
| V121 | A `detached` child is the leader of a new process group and session; a terminal-style SIGINT to the orchestrator's group reaches the orchestrator and an attached child, not a detached one; SIGKILL to the detached group works | docs; macOS 2026-10-05; Ubuntu 24.04 (Docker) 2026-10-14, not the runner | Node v24.21.0 `child_process.md:913`; a probe: parent and attached child got SIGINT, the detached child stayed alive, `kill(-pgid)` ended it. On Ubuntu 24.04 (Docker; Node 24.21.0, npm 12.0.2) the command's signal tests, the group-SIGINT routes included, passed 10/10 each with the detached fake runner never receiving a SIGINT (`cli.spec.ts`, `assertDrainedOnce`) |
| V122 | One Ctrl-C reaches a program as: 2 SIGINTs 1–31 ms apart under `npm run` (npm then waits for it); 2 under `npx tsx`; 3 under `npm exec`, whose npm exits in 76 ms and the program never finishes; 1 under `tsx` or `node --import tsx`. SIGTERM to `npm run` is relayed once | measured 2026-10-05, macOS | A signal-logging probe started each way in its own process group, which then got one group SIGINT; npm 12.0.2, tsx 4.23.15. Ubuntu: V467 |
| V123 | APVM's BackWPup build runs `composer install`, `npm install`, `gulp buildAssets`, `npx tailwindcss`, `gulp free/pro`; it declares npm, composer and gulp (`npm install --global gulp-cli`) as required tools, git underneath; the project is private (a token is required); v3.0.0 ships `linux-x64-gnu` and `linux-arm64-gnu` binaries | source | APVM `cli/v3.0.0`: `crates/core/src/build/plugins/bwu.rs` (`tool_dependencies`, `setup_commands`, `build_commands`), `projects/registry.rs`, the tag's file list |
| V124 | APVM's cache grows ~17 MB per BackWPup commit built (Free 8.4 MB + Pro 9.8 MB); `develop` had 9 commits in the last 30 days | measured 2026-10-05 | `~/.apvm/cache/backwpup/commits/9.99.99/*` (5 entries, 17 MB each); GitHub commits API since 2026-09-05 |
| V125 | The suite held 61 BackWPup scenarios in 12 features (9 of them in the two `@pro` features 6F.4 added); WP Rocket has 3 scaffolding scenarios, all `@noauth`. A full BackWPup run took about 50 minutes per cell at 42 scenarios (at 53/70: V493) | source, 2026-10-05 | `src/projects/*/features/*.feature`; phase-6 plan: 42/42 in 51.9 min (`pro@nginx`) and 49.2 min (`free@nginx`) |
| V126 | The suite never sets `headless`, so Playwright's default (headless) applies; only `*:headed` scripts and the healthcheck's `--headed` show a browser — no X server needed | source | `grep` of `src/`, `playwright*.config.ts`, `package.json`, `healthcheck.ts` |
| V127 | `commander` 15.0.0 is ESM with `node >= 22.12.0`; `zod` 4.6.5 is ESM with no engine constraint | registry | `npm view` |
| V334 | Playwright 1.63.0's file discovery skips `node_modules/` but walks dot-folders; with an explicit `testDir` it applies no `.gitignore` filtering (V338) | measured 2026-10-12 | A throwaway config, `testDir: "."`, `--list`: `.dotprobe/a.spec.ts` listed, `node_modules/zzprobe/a.spec.ts` not |
| V335 | Playwright's ESM loader refuses a JSON import without `with { type: "json" }` ("needs an import attribute"); TypeScript 6.0.3 and ESLint 10.11.0 accept the attribute | measured 2026-10-12 | The first unit run; `tsc`, `eslint .` |
| V336 | `ts.preProcessFile` misses every import after a regex literal holding a backtick, `/*` (`/\/*$/`) or a quote (`/"/`); TypeScript's syntax tree reads them all | measured 2026-10-13 | A script over both readers; reproduced in an orchestrator module that passed every gate and leaked `.env` and `RUN_ID` when called; the regex cases in `src/common/import-boundary.spec.ts` |
| V337 | `tsc` refuses an import ending in `.ts` (TS5097, no `allowImportingTsExtensions`) and accepts `.js`; ESLint compiles a `no-restricted-imports` `regex` case-insensitively (`"iu"`); TypeScript's bundler resolution maps `.js` to `.ts`, resolves `#` imports from `package.json`, and gives no resolution for `node:` builtins (ambient types) | measured 2026-10-13 | `tsc` on probe files; ESLint's source; `import-scan.spec.ts` |
| V338 | Playwright 1.63.0 sets `respectGitIgnore` to `!projectConfig.testDir && !config.testDir`; its UI mode, with no saved project choice, ticks the first project only, and saves the choice per config file | source | `playwright/lib/common/index.js:610`; `playwright-core/lib/vite/traceViewer/uiMode.CU5KtEkS.js` (`r.set(r.entries().next().value[0],!0)`) |
| V339 | Prettier 3.9 honours `.gitignore`: a malformed `.orchestrator/config.json` passes `--check` with no `.prettierignore` line, and fails once `.gitignore` no longer lists it | measured 2026-10-13 | A probe folder |
| V340 | Under `node --import tsx`, the first TS import adds no process listener (baseline: `newListener` 2, `removeListener` 2, `warning` 1); the four then admitted (`run-id.ts`, `sites.ts`, `retention.ts`, `products.ts`) add none, keep the working directory and exit code, and leave nothing running (`beforeExit` fires) | measured 2026-10-13 | A child probe importing a trivial module, then each admitted one, a turn apart |
| V345 | ESLint 10.11.0's core `no-restricted-imports` does not check an `import()` expression: a literal `import("../../src/common/config/run-context")` gets no error | measured 2026-10-13 | The `Linter` table in `orchestrator/import-boundary.spec.ts` |
| V349 | `node:inspector` (`Session.post("Runtime.evaluate")`) and `node:repl` (`repl.start` fed a stream) each run code in the importing process; `process.getBuiltinModule` is a function on Node 24.21.0 and returns `node:vm` | measured 2026-10-13 | `node --input-type=module -e` probes |
| V350 | ESLint 10.11.0: `no-restricted-properties` with `property` alone catches `process.getBuiltinModule(…)`, `globalThis.process["getBuiltinModule"]` and destructuring by name or string key; `no-eval` catches `eval()` and `globalThis.eval`; `no-restricted-imports`' `paths` miss `import("node:module")` and `require("node:vm")` — the full config refuses the `require` (`@typescript-eslint/no-require-imports`), not the `import()` | measured 2026-10-13 | The `Linter` table in `orchestrator/import-boundary.spec.ts`; `npx eslint` on a probe |
| V352 | tsx 4.23.15, file entry: an ES-module `.ts` sees no `require` and no `module`; a `.cts` sees `require` and `module.require` as functions; a `.js` under a nested `{"type":"commonjs"}` `package.json` sees `require`. Node's `-e` mode puts builtins such as `module` on `globalThis`, so an `-e` probe misleads | measured 2026-10-13 | Probe files in a copy of the worktree |
| V353 | ESLint 10.11.0, the full config: in an orchestrator `.js`, `new Function("…")` and `Function("…")` get no error (`@typescript-eslint/no-implied-eval` lints `.ts` only); `Reflect.construct(Function, …)` gets none in `.ts` either. `no-new-func` refuses both direct forms in every dialect | measured 2026-10-13 | `npx eslint` on probe files |
| V354 | Node 24.21.0: `setTimeout("…")` throws `ERR_INVALID_ARG_TYPE`; `(async () => {}).constructor("…")` runs code in the process; `process.binding("contextify")` returns `compileFunction` and `ContextifyScript` (DEP0111); `process.dlopen` is a function | measured 2026-10-13 | `node --input-type=module -e` probes |
| V355 | Node keeps a module whose evaluation threw: a second `loadProductList()` in one process, after the broken sites file is removed, fails with the first error | measured 2026-10-13 | A tsx entry in a copy of the worktree |
| V356 | Playwright 1.63.0 resolves a project's `outputDir` with `path.resolve(configDir, …)`; playwright-bdd 9.2.1 resolves its `outputDir` the same way | source | `playwright/lib/common/index.js:587` (`pathResolve`, `:616`); `playwright-bdd/dist/config/index.js:81` (`resolveOutputDir`) |
| V359 | `zod` 4.6.7 is the latest release (2026-10-12), ESM, with no dependencies; it and 4.6.5 were published by GitHub Actions as a trusted publisher, with SLSA provenance | registry | `npm view zod@4.6.7 dependencies dist.attestations _npmUser` |
| V360 | Zod 4.6.7's messages name types and bounds, never the input (`Invalid input: expected string, received number`) — but `Unrecognized key: "…"` quotes a key raw (`util.js` `stringifyPrimitive`); a refused record key arrives as `invalid_key` "Invalid key in record", the key schema's message inside it; an object's `superRefine` is skipped only after an aborting issue (wrong type, refused key, `abort: true`) and runs beside any other; `abort: true` stops a field's later checks | measured 2026-10-13 | A tsx probe over the schema; `schema.spec.ts` |
| V361 | Node 24.21.0's `JSON.parse`: an unexpected token is reported by quoting the text around it, with no position (`Unexpected token 's', ..."assword": s3cret }" is not valid JSON`); other errors give `at position N (line L column C)`; an empty text gives `Unexpected end of JSON input`. The sites loader's own message names only the file | measured 2026-10-13 | `node -e` probes; `load.spec.ts`, `product-list.spec.ts` |
| V362 | Playwright 1.63.0 reads `--grep` with `forceRegExp`: `/source/flags` (flags `g`, `i`) as written, anything else as `new RegExp(pattern, "gi")`; with `v` added, `[(]` would be refused | source | `playwright/lib/util.js:152`, `playwright/lib/common/index.js:353`; `node -e` |
| V366 | Node 24.21.0's `JSON.parse` keeps the last of two equal keys with no error; zod 4.6.7's `z.record` skips an own `__proto__` key (no issue, no pollution: the prototype stays `Object.prototype`); strict objects report it | measured 2026-10-13 | Probes; `json-keys.spec.ts`, `load.spec.ts` |
| V367 | `stat` then `readFile` by path: a symbolic link swapped between a small config and a 30 MiB one loaded the large one 200 times in 400; swapped to a FIFO, `readFile` blocked and the process outlived `process.exit`. With one `open(O_RDONLY \| O_NONBLOCK)` handle: 0 in 400, and 50 FIFO swaps never hang — a FIFO opens at once and `fstat` says it is not a file | measured 2026-10-13, macOS | A swap race before and after; `load.spec.ts` (a FIFO with no writer) |
| V368 | OpenSSH 10.3 refuses `ssh -G 'u@-oProxyCommand'` ("hostname contains invalid characters"); Playwright 1.63.0's CLI takes `-foo`, `-h` and `--list` as `--grep`'s value, and `--grep --` swallows the next argument | measured 2026-10-13 | A reviewer's probes |
| V369 | `new Headers({ "X-API-Key": "keyĀ" })` throws "Cannot convert argument to a ByteString", without the value; `TextDecoder("utf-8", { fatal: true })` refuses a stray `0xE9`, a truncated sequence and an encoded surrogate, and drops a leading BOM; `/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u` matches a lone surrogate, U+0085, U+009B, U+2028, U+202E and U+200B but not an emoji pair | measured 2026-10-13 | `node -e` probes; `load.spec.ts`, `schema.spec.ts` |
| V377 | Playwright 1.63, driven through the suite's real reporters over 13 run shapes and checked against 24 real streams: it exits 130 interrupted, 0 passed, 1 otherwise; it fails a run only for a failed test or an error outside any (a `failed` `run.end` with no failed test always came with a `run.error`); a filter matching nothing writes "No tests found" as an error and drops the setups; `globalTimeout` writes "Timed out waiting …" before `run.end` `timedout`. Seen live too: the real suite on `pro@nginx`, launched as a run is, with `--grep=@no-such-tag-e2e` — `bddgen` 0, the runner 1, no setup run, no site touched | measured 2026-10-13 | A reviewer's harness; `runner/index.js:6182–6186`; a tsx script over `launchRun` and `endRun` |
| V384 | Node 24.21.0's `fetch` with `redirect: "manual"` returns the `301` itself, one request made; Django's `CommonMiddleware` answers `301` to Datator's URL without its `/` | measured 2026-10-13 | `post.spec.ts` (a sink); `sendDatator` to `/e2e_tests/results` on V385's app → `{ ok: false, status: 301 }` |
| V385 | Datator's own app (`0cff7bc`, unmodified; Django 4.2.1, DRF 3.14.0, Python 3.14.8, over HTTP) answers `201` to 12 `datatorPayload` payloads — typical, passed, flaky with `grep`, release (`null` commit, no site), SHA-256 commit, a Docker host (dropped), `localhost`, 500-code-point emoji names with a 4,000-character error, blank names and a lone surrogate, a 500-character `grep`, 500 failed scenarios (2 MB), none — and `403` to a wrong key. Without the guards it answers `400`: `http://wp-apache` ("Enter a valid URL"), a lone surrogate ("Surrogate characters are not allowed"), a blank `feature_name`, 501 characters, `845.7`; 500 emoji pass (it counts code points), and a blank `error_message` passes | measured 2026-10-13 | Datator's `e2e_tests` app behind `CommonMiddleware`, SQLite in memory, `wsgiref`; posted by `sendDatator` |
| V388 | Datator's app answers `400` "Enter a valid URL" to `http://010.1.1.1/`, `https://a.com/my site`, `http:/a.com`, `http://127.1/` — URLs `new URL` rewrites or accepts | measured 2026-10-13 | Datator's app over HTTP |
| V389 | Of 2,790 URLs (6 schemes × 31 hosts × 15 endings), the `website_url` rule (an http(s) URL the parser writes back unchanged, a trailing `/` aside, whose host is `localhost`, an IPv4 address or a DNS name with a TLD — §4.8) keeps 240, and DRF 3.14.0's `URLField(max_length=255)` on Django 4.2.1 accepts every one | measured 2026-10-13 | `acceptedUrl` in tsx, then DRF's field in V385's venv |
| V390 | OpenSSH 10.3's `scp`, through `-S` to a fake `ssh`: the default sends the `sftp` subsystem and the path as given (globbed there); `-O` sends `scp -r -f /srv/my e2e/r` unquoted. Locally, `sh -c` hands a single-quoted path holding `'`, `$(…)`, a backtick or `;` to `scp` as one argument, nothing run | measured 2026-10-13 | Two reviewers |
| V394 | macOS adds `__CF_USER_TEXT_ENCODING` to the environment of every process it starts, whatever the parent passes; nothing else was added to a spawned run's environment | measured 2026-10-13, macOS | `launch.spec.ts` (the fake suite writes its variables' names) |
| V399 | Playwright 1.63.0, once the tests are over, disarms its SIGINT watcher and, with its last handler gone, removes its process `SIGINT` listener: a SIGINT while a reporter's `onEnd` or `onExit` runs ends the runner by the signal, the reporter never finishing. During the tests the same SIGINT gives exit 130 and `run.end` `interrupted` | source + measured 2026-10-13 | `playwright/lib/runner/index.js:6097–6110, 6176`; a slow-reporter probe |
| V401 | Parsing one line of nested brackets: 4 MiB took 418 MB resident, 32 MiB 2.3 GB; the largest real results stream in the checkout was 12 KB (25 streams) | measured 2026-10-13 | `/usr/bin/time -l` on a tsx probe of `readRunResults` |
| V402 | A recorded group id can be reused once its group ends: `kill(-pgid, 0)` answers alive for an unrelated live group whose number a stale record names | measured 2026-10-13 | A reviewer's probe |
| V407 | A process's start: Linux procfs (`ubuntu:24.04`, `node:24`; a command `x) y (z` parsed from the last `)`); macOS `ps -o lstart=` changes with `TZ` and the locale (`Tue Oct 13 18:57:39` → `mer. 14 oct. 08:57:39`), so it runs under `LC_ALL=C TZ=UTC`; `ps` exits 1 with nothing for a missing PID on both | measured 2026-10-13 | `docker run node:24`, `ubuntu:24.04`; `leader.spec.ts` |
| V409 | A real Playwright worker lived 30,059 ms after its runner's SIGKILL; a terminal nobody reads (a paused pty) freezes a process writing to it synchronously — its timers and a SIGTERM handler (macOS and Linux); two `node:24` containers on one volume give their Node the same PID (PID 1 without `--init`), so a PID-only lock let both hold it, with and without `--init`; with stdout non-blocking and nothing reading (`\| sleep 6`), Node's queue grew to 110 MB | measured 2026-10-13 | The reviewers' probes and containers |
| V410 | `process.exit` right after stdout was made non-blocking dropped what the terminal had not taken: 1,004 of 198,000 bytes reached a reading pty; a root `sudo` child left in a killed group makes `kill(-pgid, 0)` answer `EPERM` | measured 2026-10-13 | The re-auditors' probes; `node:24 --init` with a sudoer |
| V411 | Linux's PID allocator skips a live leaderless group's id (`ns_last_pid` set below it); a paused pty bounds the exit only by the wait given (~1 s) and a reading one receives all 2,000 lines; our 1 MiB terminal cap keeps stdout's queue flat under a stalled pipe; no `O_NONBLOCK` reaches children, stderr or the parent shell | measured 2026-10-13 | pty, pipe and container scripts, macOS and `node:24` |
| V434 | A cooldown of `NaN`, `-1`, `Infinity` or 40,000 minutes handed to `setTimeout` became a 1 ms timer (`TimeoutOverflowWarning`): runs back to back, and a `next run NaN:NaN:NaN` line | measured 2026-10-14 | The reviewers' probes of `runTask` |
| V443 | The `tsx` CLI (4.23.15) runs a script in a child Node of its own (the script's parent PID is tsx's) and relays a single SIGINT to it. Repeated SIGINTs (1 ms apart) to tsx's PID alone made tsx SIGKILL the child in about half the tries; the group's SIGINT plus a PID SIGINT (npm's pattern) was clean 18/18, and `node --import tsx` always | measured 2026-10-14 | `tsx t.ts &`, then `kill -INT` of tsx's PID; a probe |
| V467 | Ubuntu 24.04 (Docker; Node 24.21.0, npm 12.0.2, dash): `npm run` keeps `sh -c` between npm and Node (dash does not exec a lone command); then a group SIGINT reaches Node once (npm's relay goes to dash), a SIGINT to npm's PID never (still running after 4 s), a SIGTERM to npm's PID ends npm (143) and leaves Node running, unsignalled. With `exec`: group SIGINT → 2 SIGINTs, npm's SIGINT → 1, SIGTERM → 1, each exit 130. macOS's `sh` (bash) already execs: Node is npm's child. With the `exec` script on macOS: SIGINTs ×3 1 ms apart to the script's PID (directly and under npm), the group's SIGINT then one to the PID 1–31 ms later, SIGINT or SIGTERM to npm's PID — each drained once, exit 130 (npm's too) | measured 2026-10-14 | A signal-logging probe, ×2 per route; `cli.spec.ts`'s signal tests |
| V468 | commander 15.0.0 as used: ESM; `exitOverride`/`configureOutput` set before `command()` are inherited by `start`; a variadic `--task` collects repeats; `CommanderError.exitCode` 0 for help and version, 1 for usage errors; `--task --once` reads `--once` as an id. `npm ci` installs it beside `playwright-bdd`'s nested 13.1.0 | measured 2026-10-14 | A probe of the installed package; `npm ci --ignore-scripts` in a clean copy |
| V471 | npm 12.0.2: `npm run orchestrator start --dry-run` (no `--`) runs the script with argv `["start"]` and sets `npm_config_dry_run=true`. npm relays SIGINT and SIGTERM, not SIGHUP: a SIGHUP to npm's PID ended npm and left the orchestrator running, lock held (macOS 2/2, Linux 3/3, before the parent watch) | measured 2026-10-14 | The reviewers' harnesses |
| V479 | npm 11.21.0 hands `npm run o start --once`, `--task=a`, `--config=c.json` and `--dry-run` to the script as `["start"]`, setting `npm_config_once`, `_task`, `_config`, `_dry_run` (npm 12.0.2 takes `--dry-run` only and refuses the other three). Without an `error` listener on stdout, `--help` or the dry run into a closed pipe crashed with a stack | measured 2026-10-14 | Environment probes under both npm versions |
| V486 | 5J, the live checks, on `bwu2`/`bwu3` (`free@nginx`, `pro@nginx`, one server), the orchestrator in `tmux`; tasks `bpng`/`bfng`, a 1-minute cooldown, retries 1, a four-scenario `grep` (wired up, backup on demand, delete from history, files and database together) but in V489 and V493; Slack and Datator only to local stand-ins (D5, D6): `NODE_USE_ENV_PROXY=1` and `HTTPS_PROXY` to a sink that answers `hooks.slack.com` with `200 ok`, forwards `datator.e2e-local.test` to Datator's own `e2e_tests` app and refuses every other host, its CA through `NODE_EXTRA_CA_CERTS`. `start --dry-run`: `no warnings`, exit 0, the state directory unchanged. `start --once`, both cells together: 4/4 each, exit 0, one Slack `200` and one Datator `201` per run (`test_suite` the cell and its grep). `start` for two cycles each, then one Ctrl-C mid-scenario; and `kill -TERM <pid>`: both runs drained, `stopped`, Slack sent, Datator not posted, exit 130, no lock left, sites as found | live 2026-10-14 | bpng/bfng-1 (`--once`), -2–4 (Ctrl-C), -6 (SIGTERM) |
| V489 | Two Ctrl-C 3 s apart, in the first scenario's `@plugin` Before hook: `interrupting every run`, both `stopped` (`interrupted`, Playwright 130), the scenario in flight counted `didNotRun` with Playwright's interrupt wording (`Test timeout of 360000ms exceeded while running "beforeEach" hook`), exit 130, sites as found (the After hook ran) | live 2026-10-14 | bpng-10, bfng-10 |
| V491 | `kill -KILL <pid>`: npm exits 137; the next start refuses (exit 1) naming each run and its `kill -KILL -<pgid>`; once run, the next start marks both `lost` (`process group ended`) and runs; the killed runs' leftovers — the plugin active, `wp_bwpup_backups`, 28–29 options, `.e2e_temp`, a `backwpup-restore-<hex>` folder — are removed by that run's `@plugin` Before path | live 2026-10-14 | bpng-7/8, bfng-7/8 |
| V492 | The orchestrator idles: ≤ 18 % CPU in one start-up sample, else 0.0–0.5 %; RSS 14–180 MB, ≈ 1.4 s CPU over a 2-hour run. No site password, `GITHUB_TOKEN`, webhook or Datator key in `.orchestrator/`, the 22 run reports, `test-results/backwpup` or the terminal captures (1,096 files; as written, URL- and JSON-escaped) | live 2026-10-14 | `ps` samples; a secret scan |
| V493 | The full suite, ungrepped, both cells together under `--once`: Free 53/53 in 1 h 22 m, Pro 70/70 in 2 h 0 m (one cell alone took ≈ 70 min: the two share one server), exit 0, Slack `200` and Datator `201` each (53 and 70 test cases, `git_commit` `cd26255…`). Sites as found but for the suite's own teardown, by design: `bwu3`'s 2026-10-13 `uploads/backwpup` (a 209 MB backup and its log, earlier work's declared residue) and both `debug.log`s | live 2026-10-14 | bpng-11, bfng-11 |
| V511 | Importing `src/projects/products.ts` loads `@playwright/test`, whose bundles carry graceful-fs twice (`playwright-core`'s `utilsBundle.js`, `playwright`'s `expect.js`): `fs.close`, `fs.closeSync`, `process.cwd` and `process.chdir` are replaced (`chdir` two wrappers deep), `Symbol(graceful-fs.queue)` is added, and signal-exit's emitter and Node's own undici dispatcher are loaded; nothing else the probe compares changes | measured 2026-10-15, Playwright 1.63, Node 24.21 | A probe; `import-probe.spec.ts` |
| V534 | The site locks live, on `bwu2`/`bwu3`: the dry run warns of nothing and writes nothing; `start --once`, both cells together — 4/4 passed each, the site locks' folder `0700` and lock files `0600` holding `v`, `pid`, `token`, `start`, `host`, `label`, `run`, removed as each loop ended; Slack `200`, Datator `201` | live 2026-10-15 | The smoke's captures and lock log |
| V535 | A second config started during the first's cooldown is refused at its start naming the holder (PID, cell, site, run), its dry run warns the same, no `runs/` made; after Ctrl-C the first exits 130, the locks gone, and the second's `--once` runs 4/4. After a SIGKILL of the first, a start on its state directory refuses on the orphans, naming each run and its `kill -KILL -<pgid>`, before it looks at the site locks; the other config is refused by the dead holder's site lock; after `kill -KILL -<pgid>` the runs are marked `lost`, the locks taken over, 4/4 | live 2026-10-15 | The smoke's captures |
| V536 | Sites as found after every check (only `bwu3`'s 242-byte `debug.log` removed by the suite's teardown, by design); no secret in the 284 files scanned (state directory, reports, terminal captures) | live 2026-10-15 | State snapshots; a secret scan |
| V537 | The soak: the real `start` in one process over the fake suite, one task, a 50 ms cooldown, Slack and Datator over real sockets to a local sink; 1,000 runs capped (`reportsKeep` 20) and 1,000 uncapped, each run passed and announced (`slack ✓ · datator ✓ 201`). Listeners 15, resources 6, timers 2, descriptors 22 at every sample from run 10 to 1,000, and back after the stop; run folders held at 20; uncapped, pruning 0.35 ms a folder at 1,000 (348 ms), the heap 73 → 97 MiB (not judged). A leaked listener and descriptor per run failed it within 20 runs | measured 2026-10-19, macOS | `npm run orchestrator:soak` with `ORCHESTRATOR_SOAK_RUNS=1000` (10.3 min); a mutation of `tasks/cycle.ts` |
| V538 | On macOS, 200 KB written to a piped stderr then `process.exit` delivers 65,536 bytes: a pipe is written asynchronously, so the exit waits for standard error as for the terminal | measured 2026-10-19, macOS | Node 24.21.0; `start.spec.ts`'s slow-stderr refusal test |
| V539 | Full adversarial audit of the whole phase: six reviewers in isolated copies (the process and command; a run; state and locks; tasks, events, notifications; config, secrets and the import boundary; docs against code with 186 mutations), every finding reproduced before its fix and every fix's test shown to fail without it. Medium: npm dying while Node boots unseen (the parent read at `listen`); a runner that died on its own read `stopped` when a stop came while its group lingered; an unreadable `running` record only warned about; the site locks' parent folder unjudged; a secret holding an invisible character or two overlapping secrets left partly in clear; a credential-shaped key shown. Low: a process that could not start lost its cause; proxy, CA and browser-path variables never reached a run; a run from an earlier boot refused the start; a site key over 2,048 characters failed every loop late; a split `baseURL` password in the site key; a sites file's values quoted in its errors; `data:` imports past the boundary; Slack code fences; Datator storing `***@`; a short secret with spaces shown in an answer; a `setRun` rejection not ending its loop; stderr cut at the exit; specs not killing their process groups; 13 test gaps; docs drift and TSDoc gaps. 3,313 → 3,386 unit tests | audit 2026-10-19 | `typecheck`, `lint`, `format`, `test:unit` green |
| V540 | Live after the audit, `bwu3` (`pro@nginx`, two scenarios): `--dry-run` no warnings; `--once` passed 2/2; then one SIGINT to npm's PID mid-scenario: `stopping` said once, the scenario finished, the other skipped, `stopped`, exit 130, the site locks released, no process left. `bwu2`'s TLS certificate expired that day (02:44 UTC): its run read `error · the auth setup failed: … ERR_CERT_DATE_INVALID`, exit 1 — the host's, not the orchestrator's. No secret in the 82 files written (state directory, reports, terminal) but the config | live 2026-10-19 | notifications off (scratch config); bpng-1, bpng-2, bfng-1 |
| V541 | The soak after the audit: 200 runs, listeners 15, resources 6, timers 2, descriptors 22 at every sample; pruning 0.32 ms a folder at 200 | measured 2026-10-19, macOS | `npm run orchestrator:soak` (1.6 min) |
