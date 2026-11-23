# Orchestrator Report Delivery — prepared download bundles

Status: done (R1–R4, 2026-11-09); a Phase 1 slice of the [orchestrator plan](orchestrator-plan.md)
(§2 Reports, §3 Planned). As built: [orchestrator guide → Report
bundle](../guides/orchestrator.md#report-bundle) (modes, Slack's command, budget, stopping,
leftovers, disk, security); `src/common/reporting/` (`allure-*`, `report-bundle`, `bundle-*`,
`child-group`) and `orchestrator/runs/bundle.ts`. Kept here: measured facts, decisions and why,
rejected alternatives, limits. Phase instructions and audit detail are in git (`a0e988b` for R1–R3).

## TL;DR

At each run's end the orchestrator generates Allure and packs only what a person opens — a landing
page, the Playwright, Cucumber and Allure reports, `run-facts.json` — as `<run>/report.tar.gz`
(`reports.bundle.mode`: `archive` default, `folder`, `both`, `none`). Slack gives one paste-ready
command that downloads, unpacks into a folder named after the run and deletes the archive; the raw
run folder stays untouched. Bounded (240 s) and best-effort: never changes a run's verdict. Allure is
generated from a copy with Playwright traces removed (`reports.bundle.traces`: `strip` default,
`keep`), because `singleFile` inlines every attachment as base64.

## Why

- Slack used to give `scp -r` of the raw run folder: a measured passing run had 95 files / 4.6 MB,
  and `scp` in SFTP mode pays per-file round trips. `allure-results/` is raw JSON, not viewable until
  `allure generate` runs.
- The orchestrator owns the report folder and runs where the results are, so it builds the derived
  reports once, when they are complete.

## Measured facts

Allure 3.18 unless dated; MB = 10⁶ bytes.

- `singleFile` (set in `allurerc.mjs` for the awesome and dashboard plugins) keeps every report file
  in memory and inlines it base64 into `index.html`, attachments included (`InMemoryReportDataWriter`
  → `reportFiles()` → `createReportDataScript`). `allure-playwright` attaches traces as
  `application/vnd.allure.playwright-trace`. One failed run (`backwpup/pro@nginx`
  `2026-10-06T02-47-17-617Z-36442`, 83 trace attachments, 53.8 MB, largest 28.6 MB):
  `awesome/index.html` 82.55 MB, output 88 MB (tar.gz 62.5 MB) in 6.7 s; without traces 11 MB (tar.gz
  4.1 MB). Too large a report exits with "The report is too large to be generated in the single file
  mode!" on a `RangeError`.
- `allure generate`: exit 0 on empty or malformed results (hence a pre-check); an existing output is
  not cleared; no SIGTERM handler in `generate`. A
  folder report opened from `file://` shows nothing (Chromium blocks its `fetch`); served, it loads
  with one 404 (Allure's own optional `widgets/metrics.json`).
- Allure 2 chart types draw nothing in 3.18; `allurerc.mjs`'s dashboard uses `currentStatus` +
  `statusDynamics`.
- No new dependency: the Allure CLI in `node_modules` and the system `tar` (runner and macOS).
- A failed history append is logged and exits 0 (`@allurereport/core` `report.js`). Allure's line
  reader splits on a lone CR. `analyticsEnable: true` (a Google Tag Manager loader) is hard-coded in
  the awesome and dashboard plugins through 3.33.0, with no option or variable
  (`ALLURE_NO_ANALYTICS` reaches only allure2).
- A `keep` Allure's trace button opens `https://trace.playwright.dev/` and hands it the trace by
  `postMessage` (its `app-*.js`): it needs the internet, and the trace (session cookies) reaches that
  site's code in the browser; Playwright documents the site as processing traces locally.
- Playwright's HTML report is a folder (`index.html` + `data/` + `trace/`) when it has attachments,
  one `index.html` when it has none; Cucumber is one file by default, a folder with
  `REPORT_MODE=rich`.
- bsdtar adds `com.apple.provenance` pax records and `._*` entries; `COPYFILE_DISABLE=1` plus
  `--no-xattrs --no-acls` (both tars accept them) remove both. `--transform` / `-s` differ between
  GNU and BSD tar. `fs.cp` throws on a FIFO or socket unless filtered.
- The cell's history grew 110–180 KB a run (~26 runs a day), read whole: past V8's string limit
  (~3,600 runs) every later generation of the cell would fail.
- R4, replayed copies of real runs (macOS):

  | Run (raw)         | Traces      | strip: archive / unpacked / Allure / time | keep: archive / unpacked / Allure / time |
  | ----------------- | ----------- | ----------------------------------------- | ---------------------------------------- |
  | `…91708` (7.1 MB) | 23, 1.06 MB | 6.6 / 16.8 / 11.9 MB / 1.7 s              | 6.7 / 15.4 / 10.4 MB / 3.1 s             |
  | `…68871` (6.2 MB) | 11, 0.50 MB | 5.8 / 16.3 / 11.6 MB / 1.3 s              | 5.4 / 14.2 / 9.5 MB / 2.8 s              |
  | `…68872` (6.1 MB) | 1, 0.06 MB  | 5.7 / 16.2 / 11.9 MB / 1.4 s              | 4.8 / 13.7 / 9.4 MB / 2.8 s              |

  With few traces `strip` is the larger (single file: base64, data inlined per plugin); with many it
  is far smaller. `folder` 1.0 s, `both` 3.2 s. Passing runs (2.26 / 1.57 MB): archive 4.5 / 4.3 MB
  `strip`, 3.7 / 3.6 MB `keep` (1.6–2.7×); `folder` 11.3 / 10.4 MB `strip`, 9.6 / 8.9 MB `keep`
  (4.3–6.6×) — Allure's ~9 MB of pages dominate. History streaming (M-series Mac): 20 MiB of `{}`
  lines (7 M objects) 2.4 s, a stop honoured within ~100 ms, a sparse 600 MB file ~0.2 s.
- Slack's command pasted unchanged against an `scp` server (Docker `ubuntu:24.04`): macOS
  `zsh`/`bash`/`sh` (bsdtar 3.5.3) and Ubuntu 24.04 `bash`/`dash` (GNU tar 1.35, root and a plain
  user) — exit 0, only `./<name>/`, empty stderr, same files on both.

## Decisions

- **Allure is the analytics report; traces belong in the Playwright report.** The bundle strips
  trace attachments from a **copy** of `allure-results` (the raw results are never modified): trace
  entries at any depth (result, steps, container `befores`/`afters`), a step only in
  allure-playwright's exact wrapper shape, a zip only when nothing else references it; links and
  folders are never followed. `keep` is opt-in and a folder report, never `singleFile`, served with
  `npx --yes allure@<installed> open --host 127.0.0.1 allure` (loopback; the exact version has
  `--host`). `allurerc.mjs` keeps `singleFile` for manual runs; `ALLURE_SINGLE_FILE=false` switches
  it.
- Allure is generated per run (`report:allure` shares the module, so it names a run, not just the
  newest), into a 0700 work folder in the run, then renamed over the output (the old one aside, back
  on failure): a failure never overwrites a good report. The output must share the run's filesystem.
- The archive's single top-level entry is `<name>/` = `<product>-<cell>-<RUN_ID>`: unique per run, so
  runs unpacked side by side never mix. Built in `<run>/.bundle-work-<pid>-<hex>/<name>/` and packed
  with `-C`, never `--transform`/`-s`. Names refused: empty, `.`/`..`, a separator, a control, a
  leading `-`, `.` or `@`, a `:`, over 255 bytes. Copies are folders and regular files only.
  `report/` 0700, `report.tar.gz` 0600.
- Slack's command (`bundleCommand`): `R=<name> && scp <host>:<archive> "$R.tar.gz" && tar -xzf
  "$R.tar.gz" && rm "$R.tar.gz" && cd "./$R"` — the name once in `R` (2026-11-22; it was repeated in
  three words), `"$R"` always quoted (any `IFS`), the `cd` `./`-anchored (any `CDPATH`); POSIX shells
  only (fish, csh/tcsh stop at `R=`). `&&` keeps the archive after a failed download or unpack; plain
  `rm`, never `-f`/`-r`; re-running from the same folder (not from inside the unpacked one, where the
  `cd` left the shell) rewrites it. The name and paths through `shellWord`. Never cut (a cut command
  is a broken one): too long for Slack, the archive's path instead. `folder`: `R=<name> && scp -r
  <host>:<run>/report "$R" && cd "./$R"`.
  `none`, or a missing or failed bundle: the raw-folder hint.
- Best-effort, one 240 s budget for Allure, copy and tar: reports are derived, so no failure changes
  the run's status; it is one log line and a `null` `report.bundle`.
- `run.finished` gains `report.bundle: { kind: "archive" | "folder", path, name } | null` within
  `v: 1`: a new field misleads no subscriber (`both` names the archive).
- Stopping: a drain lets the bundle run; an interrupt or kill aborts it. Allure and `tar` lead their
  own process groups (`child-group.ts`), so a Ctrl-C or SIGHUP to the orchestrator's group never
  reaches them; an abort sends SIGTERM, then SIGKILL after 5 s, so shutdown budgets hold without
  growing.
- Leftovers: each bundle sweeps its cell's runs; a work folder goes only when its pid is dead **and**
  nothing in it changed for the budget + 5 s (a pid is per host).
- Landing page: no script or external asset (CSP `default-src 'none'; style-src 'unsafe-inline'`),
  light/dark, facts whitelisted and masked, every report linked or "not in this bundle: <why>", serve
  notes for what needs HTTP. `REPORT_MODE=rich` Cucumber is copied whole and the page says to serve
  it.
- Allure's Google Tag Manager loader is removed: the exact template block is cut from each page at
  the report's top and one folder down; a page not matching exactly is left byte for byte and named
  (`analytics.left`).
- `results.jsonl`, logs and `allure-results/` stay raw-only: the bundle is for people.
- Retention: no separate policy; a bundle is pruned with its run (`runs.reportsKeep`). The cell's
  `allure-history.jsonl` survives retention, so it has its own bound:
  - One line per run, tagged `"e2eRun": "<RUN_ID>"`, replacing that run's earlier line in its first
    place and time. Allure is given only the lines before the run's own first line (all when it has
    none): given its earlier line, a regenerated run drew itself twice, and an older run drew later
    runs as earlier ones.
  - The newest 100 runs (`HISTORY_LIMIT`, ≤ ~20 MB; Allure's trend draws 10), trimmed by us after
    Allure's append, not by Allure's `historyLimit`, so the run's place holds.
  - Streamed 64 KiB at a time, the stop checked per chunk; bounds (`HISTORY_BOUNDS`) keep every
    string far below V8's limit: a line over 8 MiB dropped unread, at most 56 MiB kept, 8 MiB left
    for Allure's line. Only a regular file is read, opened non-blocking (a FIFO had held the read past
    a stop).
  - Lines Allure cannot read (not a JSON object, a lone CR) are dropped and counted
    (`historyDropped`, `report:allure` warns); an unterminated last line is terminated. When
    Allure's output is not its input plus one line, the cell's history is kept plus any readable
    appended lines.
  - The tag and time are spliced into Allure's text, never re-serialised: an escape Allure wrote
    (`\u2603`, `\u00e9`) came back, re-serialised, as a character the `latin1` write cannot hold,
    and a numeric round trip turned `1e400` into `null`. The file's mode is kept (a new one `0600`).
- Security: the bundle is as sensitive as the raw folder (traces hold session cookies); never serve
  it without the dashboard's auth; no secrets in the landing page.
- Not built: the later dashboard, which would serve `report/index.html` (`folder` or `both`).

## Limits

- A build of the same run in another mode leaves the other mode's earlier output beside it (a stale
  `report.tar.gz` or `report/`); unreachable from the orchestrator, which bundles a run once.
- The serve commands need Node and `npx` (network) on the viewer's machine. Rich Cucumber served by
  `show-report` is unverified on a real rich report (none exists).
- `keep`'s trace button sends the trace to `trace.playwright.dev`'s code (above); not changed: `keep`
  is opt-in and the guide says so.
- Two generations of one cell at once both succeed, but the history keeps only the later one's line
  (no lock across processes).
- The pasted-command check on macOS and Ubuntu (Docker) is manual: CI runs Linux only.
