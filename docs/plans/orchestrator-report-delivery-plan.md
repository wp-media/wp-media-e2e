# Orchestrator Report Delivery — prepared download bundles

Status: done (R1–R4, 2026-11-09); a Phase 1 slice.
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

All done: R1, R2 2026-11-03; R3, R4 2026-11-09. Each phase's mutation audit and test detail is in git
(this file at `a0e988b` for R1–R3).

**R1 — Generate Allure for one run.** `allure-report.ts` (`generateAllureReport`: layout `single-file`/
`folder`, default by `traces`; `signal`), `allure-results.ts` (copy, validate, `stripTraces`),
`allure-errors.ts`, `allure-command.ts` (`report:allure`, via `scripts/allure.mjs`); `allurerc.mjs`
reads `ALLURE_SINGLE_FILE=false`.

- Work folder `<run>/.allure-work-<pid>-<hex>/` (0700); the report replaces `outputDir` by rename (the
  old one aside first, back on failure), then the history; a dead pid's work folder is released by the
  next generation in that run. The output must share the run's filesystem.
- Strip: trace entries at any depth (result, steps, container `befores`/`afters`); a step only in
  allure-playwright's exact wrapper shape; a zip only when nothing else references it; links and
  folders in results are never followed.
- Allure 3.18 facts: exit 0 on empty or malformed results (hence the pre-check); an existing output is
  not cleared; no SIGTERM handler in `generate`; a folder report opened from `file://` shows nothing
  (Chromium blocks its `fetch`).

**R2 — Build and archive the bundle.** `report-bundle.ts` (`buildReportBundle`), `bundle-manifest.ts`
(pure), `bundle-landing.ts` (pure page), `bundle-errors.ts`, `allure-analytics.ts`, `allure-history.ts`.

- Names refused: empty, `.`/`..`, a separator, a control, a leading `-`, `.` or `@`, a `:`, over 255
  bytes. Copies are folders and regular files only (`fs.cp` throws on a FIFO or socket unfiltered).
- Landing page: CSP `default-src 'none'; style-src 'unsafe-inline'`, no script or external asset,
  light/dark, facts whitelisted and masked, every report linked or "not in this bundle: <why>", serve
  notes for what needs HTTP.
- Tar: bsdtar adds `com.apple.provenance` pax records and `._*` entries; `COPYFILE_DISABLE=1` +
  `--no-xattrs --no-acls` (both tars accept them) remove both.
- One history line per run: Allure's appended line is tagged `"e2eRun": "<RUN_ID>"` and replaces that
  run's earlier line, keeping its `timestamp` (R4 bounds the history and fixes what Allure is given).
- Fixed: `allurerc.mjs`'s dashboard used Allure 2 chart types (3.18 drew nothing); now `currentStatus` +
  `statusDynamics`.

**R3 — Wire into the run end.** `orchestrator/runs/bundle.ts` (`prepareBundle`, `bundleCommand`,
`folderCommand`, `sweepCellLeftovers`), called by `cycle.ts` after the launch's reporters and before
`endRun` (the run's duration excludes it); config `reports.bundle.{mode, traces}`; Slack `Report:` and the
terminal's `report:`/`fetch:` lines under one `fitsSlack` rule.

- Event: `report.bundle: { kind: "archive" | "folder", path, name } | null`, within `v: 1` (a new field
  misleads no subscriber; `both` names the archive).
- Stopping: a drain lets the bundle run; an interrupt or kill aborts it. Allure and `tar` lead their own
  process groups (`child-group.ts`): SIGTERM, SIGKILL after `KILL_GRACE_MS` (5 s), so shutdown budgets
  hold without growing.
- Leftovers: each bundle sweeps its cell's runs; a work folder goes only when its pid is dead and nothing
  in it changed for the budget + 5 s (a pid is per host).

**R4 — Real-run verification and docs.**

- Replayed copies of three real failed runs (`backwpup/pro@nginx` `…91708` 23 traces, `…68871` 11,
  `pro@apache` `…68872` 1) through `prepareBundle` + `buildReportBundle`, every mode and both trace
  policies, plus `report:allure` on one. Each time: raw files unchanged (sha256), Playwright trace zips
  identical in the bundle, archive one top-level `<name>/` without `allure-results`, `results.jsonl`,
  logs, work folders or `._*`; 0600/0700; no Google Tag Manager in any page; `keep` lands as a folder
  report and the landing page gives `npx allure open allure`.
- Slack's command (from `slackMessage`, equal to the terminal's `fetch:`) pasted unchanged against an
  `scp` server in Docker `ubuntu:24.04`: macOS `zsh`/`bash`/`sh` (bsdtar 3.5.3) and Ubuntu 24.04
  `bash`/`dash` (GNU tar 1.35, root and a plain user) — exit 0, only `./<name>/`, empty stderr, same
  files on both; `scp -r` of `folder` too. Opened from `file://` in headless Chromium: the landing page,
  Playwright, Cucumber and single-file Allure (failed tests listed), no console error, no request off
  `file://`. Served as the landing page says: `keep` Allure loads (one 404, Allure's own optional
  `widgets/metrics.json`) and the Playwright trace viewer opens a trace.
- A real `start --task bpng --once` on `pro@nginx` (bwu3, one scenario, Slack and Datator off): bundle
  4.4 MB, Slack's `Report:` from the run's `run-finished.json` equals the terminal's `fetch:`; pasted
  on both OSes and opened as above.
- Measured (macOS, Allure 3.18; MB = 10⁶ bytes):

  | Run (raw)         | Traces        | strip: archive / unpacked / Allure / time | keep: archive / unpacked / Allure / time |
  | ----------------- | ------------- | ----------------------------------------- | ---------------------------------------- |
  | `…91708` (7.1 MB) | 23, 1.06 MB   | 6.6 / 16.8 / 11.9 MB / 1.7 s              | 6.7 / 15.4 / 10.4 MB / 3.1 s             |
  | `…68871` (6.2 MB) | 11, 0.50 MB   | 5.8 / 16.3 / 11.6 MB / 1.3 s              | 5.4 / 14.2 / 9.5 MB / 2.8 s              |
  | `…68872` (6.1 MB) | 1, 0.06 MB    | 5.7 / 16.2 / 11.9 MB / 1.4 s              | 4.8 / 13.7 / 9.4 MB / 2.8 s              |

  With few traces `strip` is the larger (single file: base64, data inlined in each plugin); with many it
  is far smaller (R1: 53.8 MB of traces → 83 MB single file). `folder` 1.0 s, `both` 3.2 s. Passing
  runs (`…26885` 2.26 MB, `…16992` 1.57 MB; copies): archive 4.5 / 4.3 MB `strip`, 3.7 / 3.6 MB `keep`
  (1.6–2.7×); `folder` 11.3 / 10.4 MB `strip`, 9.6 / 8.9 MB `keep` (4.3–6.6×) — Allure's ~9 MB of pages
  dominate. `…68872`'s `folder`: 16.0 / 13.8 MB (2.2–2.6×).
- Found and fixed, the cell's history (`allure-history.ts`, each reproduced first):
  - A run's Allure generated again drew the run twice in its own trend (Allure was given its earlier
    line), and an older run's drew later runs as earlier ones. Allure is now given only the lines
    before the run's own first line (all when it has none); the file keeps the run's line in its
    first place and time. Real CLI: two generations → one `statusDynamics` point (was 2); r1, r2, r1
    again → r1's trend holds no r2 point (was 2 points), r2 again → 2.
  - The history grew forever (110–180 KB a run, ~26 runs a day) and was read whole: past V8's string
    limit (~3,600 runs) every later generation of the cell failed. It now keeps the newest 100 runs
    (trimmed by us after Allure's append, not Allure's `historyLimit`, so the run's place holds) and
    is streamed a 64 KiB chunk at a time, each split synchronously, the stop checked per chunk. Bounds
    (`HISTORY_BOUNDS`): a line over 8 MiB is dropped unread; the lines kept hold at most 56 MiB, the
    oldest past it dropped and counted, leaving 8 MiB for Allure's line (64 MiB written); Allure's
    output past one line's worth is not read. So no string nears V8's limit: 9 × 60 MiB lines failed
    with a raw `RangeError` (every later generation too) and now drop, the cell's history replaced
    by the bounded one. Measured (M-series Mac): 20 MiB of blank lines 0.28 s, of `x` lines 0.58 s,
    of `{}` lines (7 M objects, each parsed) 2.4 s (was 35.8 s for blank lines, one async step a
    line); a stop is honoured within ~100 ms (was 14.7 s); a sparse 600 MB file in ~0.2 s.
    Checked on Allure 3.18 with 200 real lines: given 100, the file stays 100 (14.5 MB), the trend
    draws its usual 10 points.
  - A line Allure cannot read (not a JSON object, a lone CR inside — its line reader splits there)
    failed every later generation; an unterminated last line was glued to Allure's. Such lines are
    now dropped and counted (`historyDropped`, `report:allure` warns), blank ones silently; an
    unterminated last line is terminated.
  - When Allure's output was not what it was given plus one line (3.18 logs a failed append and
    exits 0: `@allurereport/core` `report.js`), the run's earlier line was lost. Now the cell's
    history is kept, plus any readable lines Allure appended.
  - Any history failure is now an `AllureReportError` naming the file (was a raw filesystem error or
    `RangeError`); a stop is `AllureGenerationAbortedError`, even mid-read.
  - The history's mode was reset to `0644` by each generation; it is now kept (a new one `0600`).
  - Allure's line was re-serialised to add the tag: an escape it wrote (`\u2603`, or `\u00e9`) came
    back as a character the `latin1` write cannot hold (corrupt). The tag and time are now spliced
    into its text (replacing those members' values, else added before the `}`): its bytes are kept.
  - Tests: `allure-history.spec.ts` 35 (rewritten with the module: scan, merge, streaming, the 600 MB
    sparse file, a non-ASCII run name, a decoy naming the run outside its tag); `allure-report.spec.ts`
    +6 stub-CLI (another run's non-ASCII bytes kept and given as they are, a non-ASCII run folder,
    Allure appending nothing or two lines, the 100-run cut, dropped lines) and 2 real-CLI (the two
    trends above); `allure-command.spec.ts` +1 (the dropped-lines warning). Mutation: 48 single
    mutants of the new code and its wiring, all caught; of audit B's 22, 21 targeted removed functions
    (the 5 survivors among them: their behaviours now have N-mutants above, caught) and `latin1()`'s
    is caught.
  - Re-review C's four, tests: `allure-history.spec.ts` 35 → 59 (byte bound, bounded settle read,
    the 9 × 60 MiB sparse history, typed errors, a stop before and mid-read on a FIFO, the splice and
    `objectMembers`, a line end at a chunk's end); `allure-report.spec.ts` mode kept/`0600`, the stop
    mid-read; `fifo.spec.ts` +1 (`openFifoWriter`). Mutation: 100 mutants, each run in its own process
    group: all caught but 4 proven equivalent (the `{` pre-check and fast path only skip work; the
    pre-check makes `parseObject`'s object check and `objectMembers`' depth test redundant).
  - Review D's four (each reproduced): a FIFO history held the read past a stop (no writer, or an idle
    one) — the history is now opened non-blocking and only a regular file (or a folder, whose read
    fails) is read; anything else is one dropped line, replaced by the next history, and the stop is
    also checked once the file ends. Allure's line of exactly the line bound was refused unseen (the
    bound counted its `\n`), and a line its tag pushed past the bound was dropped by the next read:
    Allure may append `maxLineBytes` and `\n`, a line read may be `HISTORY_TAG_BYTES` (1 KiB) longer,
    and an append refused or a tagged line still too long is counted in `historyDropped`. The earlier
    line's `timestamp` is spliced as its text (`timestampText`; was a number round trip: `1e400` →
    `null`, `12345678901234567890` rounded). Specs: the FIFO stop specs became a stop at a chosen
    check on a regular file (`stopAtCheck`) plus FIFO-not-read specs; the `report:allure` signal specs
    signal once Allure runs. Mutation: 125 (C's 100 less the removed numeric `timestamp`, + 26
    new), all caught but the same 4 equivalent.
- Left:
  - A build of the same run in another mode leaves the other mode's earlier output beside it (a stale
    `report.tar.gz` or `report/`); unreachable from the orchestrator, which bundles a run once.
  - The serve commands need Node and `npx` (network) on the viewer's machine. Rich Cucumber served by
    `show-report` is unverified on a real rich report (none exists).
  - A `keep` Allure's trace button opens `https://trace.playwright.dev/` and hands it the trace by
    `postMessage` (its `app-*.js`): it needs the internet, and the trace (session cookies) goes to that
    site's code in the browser; Playwright documents the site as processing traces locally. Not
    changed: `keep` is opt-in; the guide says so.
  - Two generations of one cell at once both succeed, but the history keeps only the later one's
    line (no lock across processes).
  - The pasted-command check on macOS and Ubuntu (Docker) is manual: CI runs Linux only.

## Definition of done (met)

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

## Decisions

- Allure's Google Tag Manager loader is removed: `analyticsEnable: true` is hard-coded in the awesome
  and dashboard plugins through 3.22.1 (`ALLURE_NO_ANALYTICS` reaches only allure2). The exact template
  block is cut from each page at the report's top and one folder down; a page not matching exactly is
  left byte for byte and named (`analytics.left`).
- `keep` stays a folder report, served with `npx allure open allure`; `strip` stays single file.
- `results.jsonl` is raw-only: the bundle is for people.
- A failed Allure generation never fails the run: reports are derived.
- `REPORT_MODE=rich`: Cucumber is copied whole and the landing page says to serve it.
- Retention: no separate policy. `archive` keeps no `report/`; a bundle is pruned with its run under
  `runs.reportsKeep`. Allure's ~9–12 MB of pages are near fixed, so a small passing run's archive is
  1.6–2.7× it, a failed one's 0.78–0.95×, a trace-heavy one's 0.56× (R2's); `folder` is 2.2–6.6× and
  `both` archive + `folder`, opt-in for the later dashboard.
- A cell's Allure history keeps the newest 100 runs (≤ ~20 MB; Allure's trend draws 10), trimmed by
  us after each generation; it survives retention, so it needs its own bound.
