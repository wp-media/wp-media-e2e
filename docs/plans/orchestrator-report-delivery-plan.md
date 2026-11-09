# Orchestrator Report Delivery — prepared download bundles

Status: R1 and R2 done (2026-11-03), R3 done (2026-11-09); R4 planned; a Phase 1 slice; modernization Phase 7's
renderer, which R3 needs, is done.
Parent: the [orchestrator plan](orchestrator-plan.md) (§2 Reports, §3 Planned). Phase 0.5 left
Allure generation out; this plan adds the missing delivery piece: one prepared download per run.

## TL;DR

At each run's end the orchestrator generates Allure and assembles `<run>/report/` with only what a
person opens — a landing page, the Playwright report folder, Cucumber and Allure — then packs it as
`<run>/report.tar.gz`. Slack gives one paste-ready command that downloads it, unpacks it into a
folder named after the run and deletes the archive; the raw run folder stays untouched for
debugging. Generation is bounded (240 s) and best-effort: a failure never changes a run's
verdict. Allure is generated from a copy with Playwright traces removed by default, because
`singleFile` embeds every attachment as base64: 53.8 MB of traces became an 82.6 MB HTML in a
measured failed run. Traces stay in the Playwright report. `reports.bundle.mode` chooses `archive`
(default), `folder`, `both` or `none`; `reports.bundle.traces` chooses `strip` (default) or `keep`.

## Why

- Slack today gives `scp -r` of the raw run folder. A measured passing run had 95 files / 4.6 MB,
  and `scp` in SFTP mode pays per-file round trips. The Allure folder is raw JSON and is not
  viewable until `allure generate` runs.
- The orchestrator already owns the report folder and runs where the results are, so it can build
  the derived reports once, when they are complete.
- Measured: the passing run's Playwright + Cucumber reports compress to 0.8 MB; Allure adds 1.9 MB
  (awesome only) or 4.1 MB (awesome + dashboard). A failed run is dominated by trace zips (one real
  run: 53.8 MB of traces, 61 MB Playwright folder).

## Confirmed: Allure `singleFile` and traces

- `allurerc.mjs` sets `singleFile: true` for the awesome and dashboard plugins. In that mode Allure
  keeps every report file in memory and inlines it base64 into `index.html`, attachments included
  (`InMemoryReportDataWriter` → `reportFiles()` → `createReportDataScript`).
- `allure-playwright` attaches Playwright traces to the test as
  `application/vnd.allure.playwright-trace`. The report archive here has 83 such trace
  attachments (median 44 KB, largest 28.6 MB).
- Measured with `reports/backwpup/pro@nginx/2026-10-06T02-47-17-617Z-36442` (53.8 MB of traces):
  `allure generate` took 6.7 s and `awesome/index.html` was **82.55 MB**; the whole output was
  88 MB (tar.gz 62.5 MB). A report without traces was 11 MB (tar.gz 4.1 MB).
- So `singleFile` loses no trace, but it inflates it by base64 (~33%) and makes the browser load
  everything at once; Allure exits with "The report is too large to be generated in the single
  file mode!" on a `RangeError`.
- Decision: Allure is the analytics report; traces belong in the Playwright report. The bundle
  strips trace attachments from a **copy** of `allure-results` before generation. `keep` is
  opt-in and uses folder mode (`singleFile: false`), never singleFile.
- Playwright's HTML report is a folder when it has attachments (`index.html` + `data/` + `trace/`)
  and a single `index.html` when it has none; Cucumber is one file by default and `index.html` +
  `data/` + `trace/` with `REPORT_MODE=rich`. The bundle copies each report folder whole.

## What the user gets

```text
<run>/
  report/                 # folder/both only (archive mode packs a temp copy)
    index.html            # landing: run facts, links, missing-report notes
    run-facts.json
    playwright/           # index.html + data/ + trace/ when present
    cucumber/             # index.html + data/ + trace/ in rich mode
    allure/               # index.html + awesome/ + dashboard/
  report.tar.gz           # one scp target; unpacks to <name>/ (below)
  ... raw folders untouched ...
```

`<name>` is `<product>-<cell>-<RUN_ID>` (e.g. `backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442`):
unique per run, so unpacking several runs side by side never mixes or overwrites them. Slack's
`Report:` line, pasted in a POSIX shell (macOS, Linux, WSL), leaves `./<name>/index.html` and no
archive:

```sh
scp auto-e2e:/path/to/wp-media-e2e/reports/backwpup/pro@nginx/2026-10-06T02-47-17-617Z-36442/report.tar.gz backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442.tar.gz && tar -xzf backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442.tar.gz && rm backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442.tar.gz
```

`folder` keeps `report/` only; `both` keeps both; `none` builds neither. The archive contains no
`allure-results/`, `results.jsonl`, run log or temp files.

## Design

- Pipeline: after the run's reporters finish and before `run.finished` is built, bounded (240 s,
  one budget for Allure, copy and tar together) and best-effort. The event gains `report.bundle`
  (`{ kind, path, name }` or `null`, R3). Any failure is one log line and a `null` bundle; the run keeps its
  status.
- Allure: `allure generate <filtered results> -o <run>/allure -c allurerc.mjs --name "<facts title>"`,
  with `ALLURE_HISTORY=<cell>/allure-history.jsonl`; write to a temp directory and rename, never
  overwriting a good report on failure. `allurerc.mjs` keeps its `singleFile: true` default for
  manual runs; the bundle passes a small bundle config (or an env switch) that sets
  `singleFile: false` for `keep`. Extract the logic from `scripts/allure.mjs` into a reusable
  module and make the script a thin caller; that also fixes its "newest run, not this run"
  limitation.
- Filter: copy `allure-results/` to a temp directory; walk every result's top-level and step
  attachments and, for each of type `application/vnd.allure.playwright-trace`, drop the entry and
  its `*-attachment.zip`. The raw results are never modified.
- Bundle: a pure manifest chooses entries; copy with `fs.cp`; generate a no-JS landing page
  (escaped facts, links only, system light/dark, no external assets); pack with the system `tar`.
  The archive's single top-level entry is `<name>/`, so `tar -xzf` yields `<name>/index.html`.
  Build it as `<run>/.bundle-work-<pid>-<hex>/<name>/` and pack with
  `COPYFILE_DISABLE=1 tar --no-xattrs --no-acls -czf … -C <work> <name>`; never `--transform`/`-s`
  (GNU and BSD tar differ). `folder`/`both` then rename it to `<run>/report/`; the work folder is
  always removed. `report/` is 0700 and `report.tar.gz` is 0600.
- Config:

  ```json
  "reports": {
    "sshHost": "auto-e2e",
    "bundle": { "mode": "archive", "traces": "strip" }
  }
  ```

  The dry run names both choices. `run.finished`'s existing `report.dir` and `report.log` stay as
  they are.
- Slack, `Report:` line — one command, built by a pure `bundleCommand(sshHost, archivePath, name)`:
  `scp <host>:<archive> <name>.tar.gz && tar -xzf <name>.tar.gz && rm <name>.tar.gz`.
  - `&&` chains it: a failed download or unpack stops there and keeps the archive; `rm` runs only
    after a complete unpack. Plain `rm`, never `-f`/`-r`. Re-running it overwrites the same run's
    folder with the same content.
  - Every word goes through `shellWord` (the remote path as today; `<name>` too, though its
    characters need no quoting). Never cut: `escapeCut` would leave a broken or partial command, so
    a command over `MAX_SHOWN` falls back to the archive's path alone. Slack's escaping turns `&&`
    into `&amp;&amp;` in the payload, which Slack shows as `&&`; a spec asserts the payload.
  - No `sshHost`: the archive's absolute path, as today. `folder` mode: `scp -r <host>:<run>/report
    <name>`. `none`, or a missing or failed bundle: today's raw-folder hint.
  - The command's end summary prints the same command, the archive and the raw folder.
- Retention: the bundle lives in the run folder, so 0F's per-run prune removes it; the cell-level
  `allure-history.jsonl` is outside and survives. Log the bundle's size; a heavy run is dominated
  by traces either way.
- Security: the bundle is as sensitive as the raw folder (traces hold session cookies, 0D.4);
  never serve it without the dashboard's auth; no secrets in the landing page; no external assets.
- Stopping: a stop during bundling aborts it (the Allure and `tar` children killed, temp output
  removed) and the run gets the raw-folder hint; the 240 s budget must fit `runs/shutdown.ts`'s
  stop budgets, or they grow by it — check both in R3.
- Later dashboard: serves `report/index.html` when `folder` or `both` keeps it; this plan does not
  build it.

## Phases

**R1 — Generate Allure for one run.** Done 2026-11-03.

- As built: `src/common/reporting/allure-report.ts` (`generateAllureReport`; also `layout`
  `single-file`/`folder`, default by `traces`; `stdio`; `signal`), `allure-results.ts` (copy, validate,
  `stripTraces`), `allure-errors.ts`, `allure-command.ts` (`report:allure`; `scripts/allure.mjs` wires
  it). Node builtins only, no `.env`/`RUN_ID`: added to `suite-imports.json` in a scratch copy, the
  orchestrator's boundary spec passed; R3 admits it. `allurerc.mjs` reads `ALLURE_SINGLE_FILE=false`.
- Work folder `<run>/.allure-work-<pid>-<hex>/` (0700; results copy, report, history copy, `target`:
  `outputDir`); on success the report replaces `outputDir` by rename (the old one moved aside to
  `previous/` first, back on failure), then the history; released in `finally`. The next generation in
  the run releases a work folder whose pid is dead, or this process's when not in use: a `previous/`
  whose `target` is empty goes back there (a kill between the renames), else it is removed. One that
  cannot go back stays, and the error names it. The output must share the run's filesystem (`EXDEV`
  is an error); the history falls back to copy + rename.
- Strip: trace entries go at any depth (result, steps, container `befores`/`afters`); a step goes too
  only in allure-playwright's exact wrapper shape (named after its one attachment, a trace; no
  status or `passed`, empty `statusDetails`, `parameters`, `steps`; no other key: all 83 such steps
  in the 1,705 result and container files under `reports/`); any other step keeps its place minus traces. A zip
  goes only when no other entry references it. Links and folders in results are never followed or
  copied (named in `skipped`).
- `report:allure` unchanged for valid input: newest by results mtime, traces kept, single file, same
  four lines; new: a third name (the run), `--help`; an unknown option or a fourth name exits 2;
  SIGINT/SIGTERM abort generation (Allure ended, work folder removed) and exit 130/143; with `--open`
  the status is the server's. The run summary's `Allure` line names its run (`… <cell> <RUN_ID>
  --open`). `npm run report` (Playwright) still opens a cell's newest; the summary prints the run's own
  `show-report` path, so it is left as is.
- Measured (Allure 3.18.0, macOS): exit 0 with an empty results folder (empty report + history entry)
  and with a malformed result (skipped, stack trace) — hence the pre-check; an existing output folder is
  not cleared (stale files stay); the history's folder is created; no history written when the output is
  unwritable (exit 1, log in `~/.allure/logs/`); no SIGTERM handler in `generate`. The trace-heavy run
  (`2026-10-06T02-47-17-617Z-36442`, 4 results, 2 traces, 53.8 MB): keep + single file (the script)
  83 MB `awesome/`; strip 16 MB total (`awesome` 11, `dashboard` 2.6, top `index.html` 2.4; tar.gz
  8.8 MB, its two videos included); keep + folder 66 MB; each ~0.6 s. A folder report opened from
  `file://` shows nothing (Chromium blocks its `fetch`); `allure open <report>` serves it.
- Tests: 87 (`allure-results` 19, `allure-report` 48 incl. 4 on the real CLI, `allure-command`
  20 incl. 4 through the real script). Mutation audit: 61 single mutations of the R1 code (and the
  summary's hint), 55 caught. Left, all without an observable effect: the abort check after the
  copies (a spawn with an aborted signal is killed at once, same error); `>=` for the newest run (a
  tie's pick is arbitrary either way); dropping the product/cell check when a run is given (the
  parser never yields a run without both); the own generation's `putBack` (only differs on a rename
  that fails, then succeeds); the target's `isAbsolute` check (a relative target only resolves
  against the working directory); the default server's signal (Ctrl-C reaches it with the group).
- Left: two generations of one cell at once both succeed, but the history keeps the later entry
  only (the site lock makes it rare); an abort sends SIGTERM only, no SIGKILL escalation, and a
  SIGKILLed generation leaves its work folder (a full results copy: 62 MB on the heavy run) until the
  next generation in that run (R3, with the stop budgets).

**R2 — Build and archive the bundle.** Done 2026-11-03.

- As built: `src/common/reporting/report-bundle.ts` (`buildReportBundle({ runDir, name, mode, traces,
  signal?, log? })` → `ReportBundle`: archive/folder paths and bytes, unpacked bytes, every report
  present or missing with why, skipped entries, `analyticsLeft`, `allureError`), `bundle-manifest.ts`
  (pure: modes, name rules, report entries, serve notes), `bundle-landing.ts` (pure page),
  `bundle-errors.ts`, `allure-analytics.ts` (GTM removal, below); spec helper
  `__fixtures__/tar-listing.ts` (reads raw headers: bsdtar hides its own `._*`/xattr entries when
  listing). Node builtins only, no `.env`/`RUN_ID`: added to `suite-imports.json` in a scratch copy, the
  boundary spec passed (and failed on a planted env write); R3 admits it.
- Flow: refuse a bad name (empty, `.`/`..`, a separator, a control, a leading `-`, `.` or `@`, a `:`,
  over 255 bytes; spaces and quotes are fine) or mode; `none` returns at once (no Allure either);
  release `.bundle-work-*` of dead pids (or this process's unused) as R1 does (`releaseWorkDir`: the
  work folder records `report/`'s place, so an earlier one a kill left aside goes back; one that cannot
  go back keeps its work folder); in a new 0700 work folder copy
  `run-facts.json` (read with `O_NOFOLLOW|O_NONBLOCK`, ≤256 KiB, only when it parses) and each of
  `playwright/`, `cucumber/` that is a real folder with a non-empty `index.html`, via `fs.cp` whose
  filter keeps only folders and regular files (links, FIFOs, sockets named in `skipped`; unfiltered,
  `fs.cp` throws on a FIFO or socket — `ERR_FS_CP_FIFO_PIPE`/`ERR_FS_CP_SOCKET`, measured on Node
  24.22 — and the bundle would fail; it never opens one); generate
  Allure into `<name>/allure` (R1, named by the facts title, the cell's history; any failure but a stop
  becomes the landing page's reason and the log's full message; a report already in place when only
  its history failed is kept); write the landing page; tar; put the folder in place (an existing
  `report/` moved aside), then the archive by rename; if the archive cannot go in, the folder is undone.
  A stop kills `tar`/Allure (SIGTERM, waited for) and puts nothing in place.
- Landing page: CSP `default-src 'none'; style-src 'unsafe-inline'`, no script or external asset,
  `prefers-color-scheme` light/dark (GitHub-like palette, AA), status in words, facts whitelisted and
  masked (`printableLine`), every report linked or "not in this bundle: <why>". Serve notes: Playwright
  with `trace/` (`npx playwright show-report playwright`; the trace viewer needs a service worker,
  refused on `file://`), Cucumber with any subfolder (rich: `npx playwright show-report cucumber`),
  Allure `folder` layout (`npx allure open allure`). Verified: `show-report` serves any static folder;
  `allure open <dir>` serves a generated report from a folder without config.
- Tar, measured: bsdtar 3.5.3 (macOS) adds `LIBARCHIVE.xattr.com.apple.provenance` pax records (GNU tar
  1.35 warns once per entry) and AppleDouble `._*` entries (a second top-level `._<name>` on GNU
  unpack); `COPYFILE_DISABLE=1` + `--no-xattrs --no-acls` (both tars accept them) remove both. A bundle
  built on macOS unpacks on Ubuntu 24.04 (GNU tar 1.35) with no warning, and one built on Ubuntu on
  macOS; files and modes identical (Allure aside: regenerated per build).
- Measured (macOS, real Allure 3.18): passing run `2026-10-22T10-04-03-625Z-26885` 11.3 MB unpacked,
  archive 4.5 MB, 1.3 s with Allure; trace-heavy `2026-10-06T02-47-17-617Z-36442` (`strip`) 89.1 MB
  unpacked, archive 75.2 MB (75.1 MB built on Linux), 2.7 s — its 53.8 MB of Playwright traces stay in
  `playwright/`. Every linked page opened from `file://` in Chromium with no external request.
- Found and fixed: `allurerc.mjs`'s dashboard layout used Allure 2 chart types (`trend`, `pie`): 3.18
  drew nothing and the dashboard failed on a missing `widgets/charts.json`; now `currentStatus` +
  `statusDynamics`.
- Audit (two reviewers, every finding reproduced first), fixed:
  - One history line per run (R1's code): every generation appended one, so a rebuilt bundle or a later
    `report:allure` gave a run two trend points (reproduced: 2 lines, same name, two uuids).
    `allure-history.ts` tags the line Allure appends with the run's folder (`"e2eRun": "<RUN_ID>"`) and
    puts it in place of that run's earlier line, keeping its `timestamp` (Allure 3.18 orders points by
    it); the key is never the report's name, which the orchestrator's `E2E_RUN_NAME` makes the same for
    every run of a task. Other runs', untagged and unparsable lines are kept byte for byte (`latin1`);
    a history that is not the given one plus exactly one object line is left as Allure wrote it. The
    work copy is rewritten before the report goes in, so it is still one rename. Real CLI: Allure
    reads the tagged history; two generations of a run and one of another leave 2 lines and a
    2-point `statusDynamics`.
  - A report in place whose history then failed reported `analyticsLeft: []`: now its placed pages are
    scanned (`pagesNamingAnalytics`; an unreadable page counts as left).
  - A build killed between moving `report/` aside and moving the new one in lost the earlier one at the
    next build's sweep (`rm -r`): its work folder now records `report/`'s place and is released with
    R1's `releaseWorkDir` (put back at the sweep; kept in `finally` while it holds the only copy).
  - Names starting with `@` (bsdtar reads an archive to include) or holding `:` (GNU tar and scp read a
    remote host; bsdtar strips `c:`) are refused.
  - The comments said a FIFO would block `fs.cp`; it throws instead, and the filter (which runs first)
    is what keeps the bundle from failing: verified with a FIFO and a socket, filtered and not. The
    spec's FIFO watcher (useless) is gone; a socket is now in the spec.
  - Spec gaps closed (each shown failing under its mutation): stop waits for `tar` (a stub writing into
    the work folder 300 ms after SIGTERM); `placeFolder`'s rollback (rename seam); the dashboard's
    Allure 3 chart types (real CLI: `dashboard/widgets/charts.json`, absent with Allure 2's); a dead
    pid's `.allure-work-*` decoy; bytes equal to the files'; analytics values, blank-line and
    non-`index.html` pages; cleanup before placing; a one-page warning; unlinked plugin pages; a run
    folder that is a file; unreadable and linked report entries; history-failed layout; rounding;
    `no-referrer`. bsdtar's `._*`/xattr guards only bite on macOS (CI is Linux); the cross-tar unpack
    above is the manual check.
- Tests: 98 new (`report-bundle` 47 incl. one on the real CLI, `bundle-manifest` 10, `bundle-landing`
  11, `allure-analytics` 14, `allure-history` 10, `allure-command` +3, `allure-report` +3 incl. 2 on
  the real CLI); R1's specs gained analytics assertions, and its two exact-history assertions the
  run's tag. 185 reporting-Allure/bundle specs. Mutation audit (B's 43 + 15 on the fixes, fresh
  copy): before the fixes 23 of the 43 survived; after, 6, the ones the audit judged without
  observable effect — the abort branch when Allure fails (the next abort check throws the same
  error), `errorOnExist`/`force` (the stage is always new), the facts' `trim`, the two `escapeHtml` on
  fixed ASCII hrefs/commands, `Number.isFinite` (JSON has no NaN/Infinity); the 15 on the fixes all
  caught (one after a case was added).
- Left: rich Cucumber served by `show-report` is unverified on a real rich report (none exists
  locally; only static serving was proved); the serve commands need Node and the network (`npx`) on the
  viewer's machine; two builds of one run at once both succeed, the later rename wins; a SIGKILLed
  build leaves its work folder until the next build of that run (R3, with R1's); in `keep` mode
  Allure's awesome plugin links traces to `trace.playwright.dev` (user-initiated, not removed).

**R3 — Wire into the run end.** Done 2026-11-09.

- As built: `orchestrator/runs/bundle.ts` — `bundleSettings` (defaults `archive`/`strip`),
  `runBundleName`, `eventBundle`, pure `bundleCommand`/`folderCommand`/`downloadCommand`,
  `sweepCellLeftovers`, `prepareBundle` (never rejects: `none` → nothing; a stop already past a drain
  → a line; else the 240 s budget armed first, then no report folder → a line, the cell's sweep and the
  build under `AbortSignal.any([stop, budget])`, the stop checked between them, the timer cleared after;
  a failure → `no report bundle: <why>`, `null`). `cycle.ts` calls it in `ended()` after the launch's
  `done` (reporters over) and `endedAt`, before `endRun`, so the duration excludes it;
  `CycleDeps.bundle` (absent → none, as `claimCell`), `bundleBudgetMs`; `start.ts` wires
  `buildReportBundle` (`LoopSeams` may replace it). Config `reports.bundle.{mode, traces}` (zod enums,
  optional; `BUNDLE_MODES`, `KILL_GRACE_MS` re-exported by `report-bundle.ts`, the one admitted module);
  dry run `reports: bundle archive (default) · Allure traces strip (default)` or `bundle none · no
  Allure report`, and a warning when `sshHost` is set and the checkout's path holds a character
  `shellWord` would quote (`checkoutWarnings`). Slack `Report:` (`reportWhere`): bundle + `sshHost` →
  the command when `fitsSlack` (escaped ≤ `MAX_SHOWN`), else the bundle's path; no `sshHost` → the
  bundle's path; no bundle → the raw hint as before. Terminal, under the outcome line, through the
  logger (Phase 7's line style): `<id> report: <bundle> · raw: <dir>` and, with `sshHost`, `<id> fetch:
  <command>` under the same `fitsSlack` rule and only when the log's cleaning leaves it unchanged
  (`safeLine`: masking, runs of spaces), logged `verbatim` (`LineOptions`/`LoggedLine`: `styleLine`
  never wraps it; a terminal soft-wraps it, so a copy is one command — chosen over printing the command
  alone: every log line keeps its time and scope, and the file and pipe lines were never wrapped); R2's
  `bundleLog` lines (sizes, missing reports) come before, `<id>: Report bundle …`.
- Event decision: `report.bundle: { kind: "archive" | "folder", path, name } | null`, **within `v: 1`**.
  The schema's rule bumps `v` only for a change that would mislead a subscriber; a new field under
  `report` misleads none (Slack/Datator read named fields; Datator never sends `report`), and keeping
  `null` (never absent) follows §4.6's "unknown is `null`". An object, not the planned bare path: Slack
  needs the kind and the unpacked name, which a path would make it re-derive. `both` names the archive.
- Stopping decision: a **drain lets the bundle run** (a drained run is still a finished run worth
  bundling; the drain's 15 min budget bounds it: its escalation aborts it); an **interrupt or kill
  aborts it** (`Cycle.stopBundle`: a stop asked of the cycle or taken by the launch ≥ `interrupted`),
  and a run already stopped that far builds none. Allure and `tar` run detached, each the leader of its
  own process group (`src/common/reporting/child-group.ts`: `runInOwnGroup`, `stopGroupOnAbort`), so
  the terminal's Ctrl-C (the drain) or SIGHUP never reaches them; the abort sends their group SIGTERM,
  then SIGKILL `killGraceMs` (default 5 s) later, and the child is still waited for. Budgets hold without
  growing: at worst the bundle ends 5 s after the interrupt, far inside the 4 min to the kill and
  `KILL_SETTLE_MS` (60 s). R1/R2's "SIGTERM only" gap is closed the same way. `report:allure`
  (`scripts/allure.mjs`) now also aborts on SIGHUP: Allure no longer shares its group, so the script's
  abort is the only stop it gets (tsx relays SIGINT/SIGTERM; on SIGHUP tsx itself dies, the script
  under it still stops Allure). Not interruptible: a stalled filesystem call (`fs.cp`, a rename);
  the size walk is now async and stops with the build (`treeBytesWithin`).
- Leftovers: `releaseLeftoverWorkDirs(runDir, sweep)` (report-bundle.ts: R2's `.bundle-work-*` release
  plus R1's `.allure-work-*`, now exported as `releaseStaleWorkDirs`); each bundle first sweeps every
  non-hidden real run folder of its cell, within its budget. The sweep releases a work folder only
  when its pid is dead (or this process's, idle) **and** nothing in it was modified for the budget plus
  `KILL_GRACE_MS` (`untouchedFor`, mtime of every entry): a pid is per host, so another host's live
  build in a shared `reports/` would otherwise look dead — the guide says never to share it. A build's
  own-run release (R1/R2) is unchanged. Chosen over a start-up sweep: no new start step, and it runs
  whenever the cell runs again. Retention: unchanged and checked — the suite's per-run prune removes
  the run folder whole, bundle and hidden work folders included (R2's retention spec: a bundled run
  stays one complete run); the orchestrator's `state/run-retention.ts` prunes
  `.orchestrator/runs/<id>/`, which holds no bundle.
- Measured: the command (built from a real-Allure bundle on macOS, bsdtar, under a path with a space
  and `'`) pasted in macOS `sh`/`bash`/`zsh` and in Docker `ubuntu:24.04` (bash 5.2.21, GNU tar 1.35;
  again after the audit fixes): `./<name>/index.html`, no archive, nothing on stderr; a corrupt
  download (`gzip: stdin: not in gzip format`, exit 2) and an `scp` failing after its copy (exit 1)
  keep the archive, no folder. The unpacked landing page, Allure and Playwright opened from `file://`
  in Chromium, no external request. Soak after the fixes (`ORCHESTRATOR_SOAK_RUNS=60`, its three
  tests: capped on a TTY and a pipe, uncapped): listeners 17/15/17, resources 6, timers 2, fds 22
  flat; pruning 0.362 ms a folder.
- Tests: 106 new (470 → 576 in the 15 specs touched, as `--list` counts them). As first built, 70:
  `runs/bundle.spec.ts` 34 (each failure mode of the command run in `sh`, `bash`, `zsh` against a stub
  `scp` and a real archive; skipped where a shell is missing — CI now installs zsh beside tmux),
  `cycle.spec` +13, `slack.spec` +7 (payload over the HTTP sink holds `&amp;&amp;`), `run-lines` +4,
  `allure-report` +5, `report-bundle` +3, `start.spec` +1 (the real wiring, Slack via the sink),
  schema, dry run, event +1 each. The audit fixes, +36: `child-group.spec` 10 (own group, the whole
  group stopped — a grandchild too —, the grace, listeners), `report-tree.spec` 7, `bundle.spec` +10
  (idle and stop terms of the sweep, budget before the sweep, the defensive branches), `dry-run` +4,
  `cycle` +2 (duration excludes bundling, `fetch:` verbatim), `run-lines` +2 (the `fitsSlack` boundary:
  raw fits, escaped does not; a command the log would change), `report-bundle` +2 (a SIGINT to the
  builder's own group mid-Allure and mid-`tar` still gives a full bundle with Allure; nothing armed
  after), `allure-command` +1 (SIGHUP, and no Allure left after any stop), `line-style` +1; the four
  `killAfterGrace` specs moved to `child-group` (`allure-report` −3 net). Hanging stubs end on their
  own after 60 s and every hang spec awaits through `endsWithin` (10 s, a named failure). Changed, as
  the schema change requires: exact `report` objects and fixtures gained `bundle: null`; the dry run's
  exact lines gained the `reports:` line.
- Mutation audit (fresh scratch copy). As first built: the implementer's 34 all caught, but review
  B's 20 independent ones left 12 survivors (sweep `.catch`, stop-reason type, budget-vs-stop
  precedence, the terminal's and Slack's caps, `endedAt` after the bundle, report path a file, both
  `disarm`s, the tar grace twice) and two caught only by 30 s timeouts. After the audit fixes, rerun
  on the fixed code (moved code mutated where it now lives; both `disarm`s are one in
  `runInOwnGroup`, plus its listener removal): B's 20 → 21 caught, the implementer's 34 caught (an
  early-stop check needed "a stopped run sweeps nothing"), 21 new on the fixes (detached, group
  kill, SIGTERM, `verbatim` through cycle/log/style, the clean-line check, `checkoutWarnings`, idle
  check, walk depth, stopped walk, idle time, sweep signal, stop checks in the sweep and both
  releases, size walk, `report:allure` SIGHUP, `fitsSlack`'s `<=`) all caught but one — a stop check
  right after the build's own-run release, equivalent (the copy loop checks first), so removed. No
  survivor; no catch by spec timeout (hang specs fail through `endsWithin` in 10 s); no
  `allure-hang`/`allure-ignore-term`/`sleep 60` left after the runs. A `detached: false` mutant once
  ended the mutation harness itself (the "group gone" spec signalled the runner's group): that spec now
  asserts the child leads its own group first.
- Left: an orchestrator killed outright (SIGKILL) or crashing leaves a running Allure/`tar` until it
  ends on its own (seconds); the sweep leaves its work folder while it writes (idle time). A stalled
  filesystem call holds the build past its budget (documented; a shutdown stays bounded). The docker
  paste check is manual (CI is Linux: `bash`/`sh`/`zsh` with GNU tar run there); `scp -r` of `folder`
  into an existing `./<name>` nests it (`<name>/report`).

**R4 — Real-run verification and docs.** Depends: R3. Effort: 1 day; low–medium.
Goal: prove sizes and both trace policies on a real failed run; update the guide.

- Replay a real failed run with traces; verify `strip` (Allure small, Playwright traces intact) and
  `keep` (folder mode); paste Slack's command on macOS (BSD tar) and Ubuntu (GNU tar) and open the
  result; measure; document `reports.bundle`; no new dependency.
- Done: both policies verified; `npm run typecheck`, `npm run lint`, `npm run format:check` and
  `npm run test:unit` green; guide updated.

## Definition of done

- Each completed run with a report folder has `report.tar.gz` (unless `none`) containing only the
  viewable reports and `run-facts.json`; no `allure-results`, `results.jsonl`, logs or temp files.
- Slack's one pasted command leaves `./<name>/index.html` and no archive; the landing page and every
  single-file report open offline from disk; what needs HTTP (Playwright's trace viewer, rich
  Cucumber, a `keep` Allure) is named on the landing page with the command that serves it.
- Allure is generated per run with its name and per-cell history; default strips traces; keep uses
  folder mode.
- A missing or failed Allure, a missing report or a failed tar never changes the run's status; the
  log says why and Slack falls back to the raw folder.
- Permissions 0700/0600; the bundle is pruned with its run.
- Tests: unit for R1/R2, integration for R3, real-run check for R4; the four gates green; docs
  updated.

## Stack

Existing TypeScript on Node 24, `tsx`, the repo's Playwright unit runner; the Allure 3.18 CLI
already in `node_modules` and `allurerc.mjs`; the system `tar` available on the runner and macOS;
Node `fs`/`path`. No new dependency. The later dashboard (React/Vite) serves `report/index.html`;
not in this plan.

## Open questions

- Decided (R2): Allure's Google Tag Manager loader is removed. No switch exists: `analyticsEnable: true`
  is hard-coded in the awesome and dashboard plugins through 3.22.1, the latest (`ALLURE_NO_ANALYTICS`
  reaches only allure2), so no bump helps. `generateAllureReport` removes the exact template block
  (both `G-` ids equal, every line matched, values constrained) from the report's `*.html` at its top
  and one folder down, in the work folder before the report goes in, so `report:allure` reports are
  clean too; a page with the block not exactly once, or still naming `googletagmanager.com` after, is
  left byte for byte and named (`analytics.left`; the command warns, the bundle logs). Pages are
  rewritten as latin1 (every byte kept), beside and renamed, mode kept.
- Decided (R2): `keep` stays a folder report; the landing page says it needs HTTP and gives
  `npx allure open allure`; `strip` stays single file.
- `archive` removes `report/` after packing; `both` keeps it for the dashboard and debugging. Disk:
  a heavy failed run duplicates trace zips; measure on the runner before settling retention.
- Include `results.jsonl` in the archive for tooling, or keep it raw-only? Recommended: raw-only;
  the landing page is for people.
- Should a failed Allure generation fail the run? No: reports are derived; the run's verdict is the
  suite's.
- `REPORT_MODE=rich`: copy the Cucumber `data/` and `trace/` folders and note the HTTP requirement
  in the landing page, or force a portable Cucumber copy in the bundle. Recommended: copy and note;
  rich is opt-in.
