# Orchestrator Report Delivery — prepared download bundles

Status: R1 done (2026-11-03); R2–R4 planned; a Phase 1 slice; modernization Phase 7's renderer, which
R3 needs, is done.
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
  (absolute path or `null`). Any failure is one log line and a `null` bundle; the run keeps its
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
  Build it as `<run>/.bundle-tmp/<name>/` and pack with `tar -czf … -C <run>/.bundle-tmp <name>`;
  never `--transform`/`-s` (GNU and BSD tar differ). `folder`/`both` then rename it to
  `<run>/report/`; the temp folder is always removed. `report/` is 0700 and `report.tar.gz` is
  0600.
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

**R2 — Build and archive the bundle.** Depends: none. Parallel: R1. Effort: 1–2 days; medium.
Goal: `buildReportBundle({ runDir, name, mode, traces })` → `report/` and/or `report.tar.gz`.

- Manifest, copy, landing page, tar, permissions, missing reports, size logging; no raw results.
- Tests: manifest; the archive's single top-level entry is `<name>/`; rich Cucumber; missing
  Playwright `data/`/`trace/`; HTML escaping; archive contents; no `allure-results`/
  `results.jsonl`; `none`/`folder`/`both`; permissions; a failure leaves no partial output.
- Done: a fixture run yields a bundle whose `index.html` links every present report.

**R3 — Wire into the run end.** Depends: R1, R2, modernization Phase 7's 7.1a–7.1b (the
terminal renderer). Effort: 1 day; medium.
Goal: every completed run with a folder prepares its bundle; `run.finished.report.bundle`;
Slack, CLI, config, dry run and docs.

- Call after the reporters, bounded by 240 s; `bundleCommand`; fallback to the raw path; no
  bundle for a run refused before its folder; retention untouched. The end summary's terminal
  lines use modernization Phase 7's renderer (`src/common/terminal`), never a second one; the
  landing page is static HTML and does not.
- Stopping: pass the run's stop as `generateAllureReport`'s `signal` (Allure gets SIGTERM and is
  waited for); a SIGKILL — the stop budgets' last step, or of the orchestrator itself — leaves the
  work folder `<run>/.allure-work-*` (a full results copy) until the next generation in that run,
  which may never come: remove it with the run, or sweep it at start-up.
- Tests: integration with the fake suite; `bundleCommand` (exact string, quoting of a path with a
  space or `'`, over `MAX_SHOWN` → path, no `sshHost`, `folder` mode); executing the command
  against a local `scp` stub leaves `<name>/index.html` and no archive, and a failing stub or a
  corrupt archive leaves the archive and no `rm`; archive failure → raw hint; budget exceeded →
  raw hint, no temp output; a stop mid-bundle; `none`; killed run; event schema; dry run.
- Done: a real or fake run's Slack command, pasted in a shell, leaves `<name>/index.html` and no
  archive; it opens.

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
- Slack's one pasted command leaves `./<name>/index.html` and no archive; it and every linked
  report open offline (Cucumber rich mode notes the HTTP requirement).
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

- Allure 3.18's awesome and dashboard plugins hard-code `analyticsEnable: true`: every report loads
  Google Tag Manager when opened online (`ALLURE_NO_ANALYTICS` affects only the allure2 plugin).
  That breaks "no external assets" for the bundle's Allure: accept, or strip the tag in R2.
- `keep` (folder mode) does not open from `file://`: like rich Cucumber, the landing page must note
  the HTTP requirement (R2), or `keep` uses single file and accepts Allure's size limit.
- `archive` removes `report/` after packing; `both` keeps it for the dashboard and debugging. Disk:
  a heavy failed run duplicates trace zips; measure on the runner before settling retention.
- Include `results.jsonl` in the archive for tooling, or keep it raw-only? Recommended: raw-only;
  the landing page is for people.
- Should a failed Allure generation fail the run? No: reports are derived; the run's verdict is the
  suite's.
- `REPORT_MODE=rich`: copy the Cucumber `data/` and `trace/` folders and note the HTTP requirement
  in the landing page, or force a portable Cucumber copy in the bundle. Recommended: copy and note;
  rich is opt-in.
