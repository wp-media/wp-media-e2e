# Execution model & architecture

How a run is structured, why one cell runs per invocation, and how the config factory turns a
product into Playwright projects.

## Vocabulary

- **Product** — a plugin under test (`wp-rocket`, `backwpup`): features, steps, sites, optional
  service credentials; `src/projects/<product>/config/<product>.config.ts`, listed in
  `src/projects/products.ts`.
- **Cell** — a named environment (`apache`, `nginx`, `pro@nginx`), **data-driven**: the top-level keys
  of the sites files (`sites.json` / `sites.*.json`).
- **Pool** — a cell's interchangeable sites (its `sites` array); scenarios are spread over it by worker.
- **Run unit** — one `(product × cell)`: one invocation, one report directory; `E2E_CELL=<cell>` pins
  it (or `--project=<cell>`).
- **Edition** — `free` / `pro` (a cell's optional `edition`), for products shipped as two packages
  (BackWPup); editionless products (WP Rocket) omit it.

## Worker → site binding (the load-bearing invariant)

Each worker pins itself to one site, `pool[parallelIndex]` (`boundSite` in
[`src/common/fixtures.ts`](../../src/common/fixtures.ts)). `parallelIndex` is **global across a run's
projects**, so it stays in range only when workers = the pool size of a single selected cell; two
cells with different pools would overflow the smaller. So
[`createProductConfig`](../../src/common/config/project.ts) sets the global `workers` to the selected
cell's pool size and **fails fast** when more than one known cell is selected.

> **Rule for agents:** run exactly one cell per invocation, pinned (`E2E_CELL=<cell>`). Never "select
> all projects". A cell-less run is forced serial (`workers = 1`): safe, but exercises no pool.

### The cell pin (`E2E_CELL`)

`bddgen` generates every BDD config the product's config registers (one per cell), deleting each
cell's specs before rewriting them. With every cell in the config, one run's `bddgen` deletes the specs
another run of the product is loading (measured: 2–4 in 80 paired runs of two cells failed, `ENOENT` /
`Cannot find module`; pinned, none). `bddgen` takes no `--project` and npm passes `-- args` to a
script's last command only, so the environment is the one channel reaching `bddgen`, the runner and
every worker.

`E2E_CELL=<cell>` ([`cell-pin.ts`](../../src/common/config/cell-pin.ts)) is that channel:

- the config holds that cell alone (its three projects, pool and BDD config), so `bddgen` regenerates
  only its specs and needs no `--project`;
- `selectedCells()` returns the pin, so the worker count, report folder and `isCellTargeted` agree in
  every process;
- a pin naming no cell of the product fails at once, in `bddgen` already, listing the cells;
- a `--project` selecting none of the pinned cell's projects (Playwright's own matching: any case,
  `*` wildcards) fails naming `E2E_CELL` — Playwright alone would say only "Project(s) … not found", a
  puzzle when the pin came from `.env`. One that fits narrows within the cell
  (`--project=artifacts:<cell>`);
- a run that **inherited** `PLAYWRIGHT_BDD_CONFIGS` (playwright-bdd's channel, carried by a process
  started inside another run) naming another cell's specs fails before generating anything: `bddgen`
  generates every config listed there, pin or not (measured).

Unpinned, `--project=<cell>` runs one cell but its `bddgen` regenerates every cell's specs: safe only
when no other run of the product is going. A blank `E2E_CELL` is no pin. `.env` is read from the
working directory into every process, so a pin there pins every run started from that folder. An
orchestrator run gets neither a `.env` nor an inherited variable
([its environment](../guides/orchestrator.md#what-a-run-is)). The healthcheck and the artifact warm
ignore the pin: they span cells (`--cell` narrows the warm).

**The `[cell]` notice.** Nothing else on the terminal names a run's cell, so the first reporter
([`reporting/cell-notice.ts`](../../src/common/reporting/cell-notice.ts)) prints one line before the
terminal reporter's `[run]` header: product and cell, whether `E2E_CELL` or `--project` chose it (so
whether another cell may run beside it), the workers (counted as Playwright's "Running … using N
workers" would) and the report folder. A reporter, because only the runner process runs reporters (the
config runs in every process). It prints through the terminal reporter's sink (below). A command-line
`--reporter` replaces the configured reporters, the notice with them.

### Reading the selection from a worker

`selectedCells()` ([`run-context.ts`](../../src/common/config/run-context.ts)) is the single source of
truth for which cells a run targets. A pin wins (every process inherits it). Otherwise it reads
`projectSelection()`, which parses the `--project` forms in `process.argv` up to a `--` (after which
Playwright reads file filters). But **a worker never receives the CLI argv** (it is forked with
`[node, workerProcessEntry.js]`), and the project `metadata` it reads is the copy it just rebuilt, not the runner's, so
an argv-derived decision cannot reach it.

It rides the **environment**, like `RUN_ID`: the config factory calls `seedSelectedCells()` while the
runner builds the config, and `projectSelection()` falls back to that value when argv is empty. The
seed names its writer (`{"pid", "cells"}`) and is believed only by that process's **direct children**
(Playwright forks its workers and out-of-process loader from the runner), so a run started inside
another overwrites the seed with its own, an empty one included, and never takes the enclosing run's.
Reading `process.argv` from worker-side code is a bug.

Worker-side code asks `isCellTargeted(cell, projectName)` rather than re-deriving it: it counts a pin
and a `--project=artifacts:<cell>` selection too, and gates whether per-run `E2E_*` overrides apply (a
broad sweep must not inherit one cell's override).

## Stopping a run: the drain

The starter names a stop file in `E2E_INTERNAL_STOP_FILE` and creates it to stop the run. From then
the automatic fixture `drainGate` ([`fixtures.ts`](../../src/common/fixtures.ts)) skips every
scenario's **first attempt** with a `stopped` annotation; the one in flight finishes normally, retries
included. Policy: [`config/drain.ts`](../../src/common/config/drain.ts) (`stopFileFromEnv`,
`assertStopFileFolder`, `drainReason`, `wasDrained`). Unset, there is no gate.

- **A gate that never closes fails silently** (every stop becomes an interrupt), so the path must be
  absolute, without surrounding whitespace, and the config factory refuses as the run starts a stop
  file whose folder is missing, not a folder or not searchable (`existsSync` reads "cannot tell" as
  "absent"; keep the folder for the run's lifetime), and one that **already exists**, which would skip
  everything and pass (`assertNotStoppedYet`). The already-exists check is skipped in a test worker: Playwright
  starts one whenever a worker is replaced, after a stop too.
- **First attempts only**: a retry finishes a scenario that already ran, so skipping it would turn a
  failure into "flaky". Nor is an attempt
  skipped once something in it failed (the gate then runs late, below): Playwright would take the skip
  as its verdict and leave the retry unrun, so a broken site would read "flaky" (measured).
- **Order**: Playwright's automatic fixtures, registered first, set up context options first, so
  `storageState` depends on `drainGate`, which then precedes the one option that can throw (a
  placeholder site's refusal). A worker fixture still precedes it; when one fails, the gate runs only as
  the After hooks are prepared — the case above.
- A fixture's skip runs **no Before hook** but **still the After hooks** (measured), so the `@plugin`
  After hook returns at once for a drained scenario: it installed nothing.
- Reports stay true: drained scenarios read "skipped" without error, the verdict is `STOPPED` (summary,
  run facts, report titles), `run.end` counts them as `drained`, and the exit status reflects what ran
  (0 when nothing that ran failed). The skip unwinds through the "Before Hooks" step, which carries it
  as an error (`Test is skipped: …`; Allure draws it red): judge a scenario by its result, never its
  steps' errors.

`config/drain.run.spec.ts` pins the whole behaviour: a synthetic product's scenarios on a placeholder
site through the real `bddgen`, runner and shared hooks.

If the drain takes too long, escalate: **one** SIGINT to the runner, then SIGKILL to its **process
group**. Never SIGTERM (no handler, no report), never a second SIGINT (workers orphaned, the scenario in
flight dropped), never SIGKILL of the runner alone (workers finish orphaned). A SIGINT abandons the
running step, so its teardown runs beside it. A killed run reaches no teardown; the next `@plugin`
Before hook stops whatever the plugin still does before removing it (`ProductConfig.stopRunningWork`),
within its own enforced budget (`LEFT_WORK_ALLOWANCE_MS`: past it, or work that will not stop, fails),
and clears `debug.log` again when it had to, so recovery from a kill is complete.

## Watching a run: the terminal, the results stream and the summary

Three of the suite's own always-on reporters (cell notice and run facts: below), given the run's
facts (`RunDescription`, `reporting/run-description.ts`) as options by the config factory:

- **The terminal reporter** ([`reporting/terminal.reporter.ts`](../../src/common/reporting/terminal.reporter.ts)),
  in Playwright's `list`'s place (after the stream). After the `[cell]` notice, a header —
  `[run] product · cell (edition) · RUN_ID · ref <E2E_REQUESTED_REF> · N scenarios · suite <version>`
  (`config/suite-version.ts`; `unknown` when unreadable or invalid), in a `━━` rule on a Unicode
  terminal; one line per test at its final attempt (`✔ 18.4s  Feature › Scenario`; a status's word —
  `failed`, `flaky`, `stopped` (drained), `skipped`, `interrupted` — kept unless a coloured terminal
  shows a mark no other status shares; suffixes `· attempt 2/3` past the first attempt or on a
  failure with retries, `· retry not run` for one settled at the end, `· passed unexpectedly` for a
  `test.fail()` that passed, `· timed out`); a `↻ retry` line per attempt due a retry, with how it
  ended (`failed`, `timed out`, `passed unexpectedly`, or `not run: its group failed` for a failed
  `beforeAll`) and its first error's line (past a bare `Error:`
  label); errors outside any test (`✘ error`, call log dropped, ≤ 12 lines; "No tests found" a `⚠
  warning`). Setups count as tests, not scenarios. Lines: `terminal-lines.ts` (pure).
  - **Failure blocks** (`failure-block.ts`, pure), under a test's final failure or interrupted final
    attempt, aligned `Label  value` lines: `Step` (the failing Gherkin step; else `Hook` with the
    hook or fixture's path; **never** a `pw:api`/`expect` title, which can quote what was typed —
    `failedStep` in `results.ts`), `Feature` (the `.feature` file, no line: the reported location is
    the generated spec), `Error` (first line), each `Screenshot` and `Trace` path (from the working
    directory, shell-quoted), `Rerun`. With no step carrying the error (a timeout, a crash), `Step`
    names the body's last step begun, `· running when the attempt ended` — never `After Hooks` or
    `Worker Cleanup`, a Before hook only if it never ended (Playwright's `duration: -1`); a body
    failing with no step of its own (a setup's plain `throw`) gets none. A failed setup's block
    opens with `Setup  <project> — no scenario of its cell runs without it`. Values are plain,
    masked, then capped. An attempt due a retry keeps its one error line.
  - **The rerun command**: `E2E_CELL=<cell> [E2E_PLUGIN_REF=<ref> [E2E_PLUGIN_VERSION=<v>] |
    E2E_PLUGIN_ZIP=<zip>] npm run test:<product> -- --grep=<pattern>` (or `--project=<setup>`). The
    cell is the test's own, also in a run of every cell, so its pin applies. The plugin
    (`pluginPin`) is what the cell's artifacts setup recorded, in the form a pinned run is handed
    ([plugin-artifacts.md](plugin-artifacts.md#pre-warming)): the operator's zip, else
    `release:<tag>`, else `commit:<sha>` with its zip's version; with no record (the setup failed or
    never ran), what the operator set — only in a run that targeted the cell, as a run of every cell
    ignores it. The pattern is the **raw** `titlePath()` titles (spec path, Feature, any Rule or
    Outline, scenario), each regex-escaped and followed by `(?: @\S+)*`, joined by spaces, anchored
    by a leading space and `$`: matched case-sensitively against `_grepTitleWithTags()`, it selects
    only that scenario and its exact duplicates (not `Create a backup encrypted` nor `Untagged
    Create a backup`). Controls, format characters, line separators, lone surrogates and combining
    marks past the eighth are `\uXXXX` escapes, so the command shows only visible characters and
    still selects the test. Values are single-quoted when a shell would read them otherwise (`=`
    too: zsh expands `=cmd`). Never cut: one quoting a credential's shape, holding a control (a zip
    path, ref or version can) or past 2,000 characters is refused, `Rerun  not shown: <why>`. A
    credential-shaped title also withholds the `Screenshot`/`Trace` paths (`not shown: …`):
    Playwright names the folder after the title, cut and hashed, past what masking can find.
  - **Worker output** (`onStdOut`/`onStdErr`; Playwright's `BaseReporter` only stores it, so the
    `[artifacts]`, `[site]`, `[auth]` lines and worker warnings would vanish): printed **as it comes**,
    terminal and pipe alike, in a `  │` gutter — so a run SIGKILLed mid-scenario (the orchestrator's
    escalation) leaves the hung scenario's last whole lines in `run.log`. Workers interleave: whenever
    a line's source (a test's attempt, or outside any test) differs from the last line's, a begin line
    names it (`▸ Feature › Scenario`, `· attempt 2/3`, `▸ outside any test`); the attempt's own line
    still comes at its end. Cut into lines per source and stream (`worker-output.ts`); output outside
    any test names no worker (Playwright gives none), so each chunk is its own
    line. Bounds: 200 lines per stream of an attempt (then `… N more lines of output not shown: the
    HTML report keeps them`), and of output outside any test until a test ends (the count alone: no
    report keeps it); a line held up to 64 KiB loses the word the cut fell in (a credential has no
    whitespace, so no half survives) and ends `[cut: the line was too long]`. Each line is made plain
    (workers run with `FORCE_COLOR=1`), masked whole (`redactSecrets`), then capped at 500 code points
    — as is every title and error. `--quiet` drops it, as `list` did. A global timeout ends the run
    before its running tests: their open lines print with their late `onTestEnd`, or in `onExit`.
    Bounded so the 64 KiB `run.log` tail an orchestrator failure quotes still holds `bddgen`'s cause.
  - **One writer** ([`reporting/terminal-sink.ts`](../../src/common/reporting/terminal-sink.ts)): it
    registers a sink as it is built; the `[cell]` notice and the stream's and run facts' warnings print
    through it (`printLine`), on stdout, plain and masked but **never cut** (`suiteLine`: the suite's
    own lines name paths and commands). With no sink (a reporter alone, `--list`, `--ui`,
    `PW_TEST_REPORTER`) they write their own stream. The registry hangs on `globalThis` (a reporter
    module loaded twice still finds it); `onExit` releases the sink.
  - **Styling**: `detectCapabilities` (`src/common/terminal/`) with `E2E_OUTPUT` (validated by the
    config factory: a bad value fails the run as its config loads) decides colour, live and Unicode
    ([the rules](../guides/configuration.md#terminal-output)). Nothing styled reaches
    `results.jsonl` or the reports. Setup projects' lines (`[artifacts]`, the elevation and
    plugin-folder banners, APVM's progress) use `workerPalette` (`config/output.ts`): never coloured,
    ASCII under `plain`, `TERM=dumb` or a C locale; a thrown report (`buildReport`,
    `formatFailureReport`) is plain Unicode text (`TEXT_PALETTE`) — the printer styles, never the
    data. Labels are the `emphasis` token, commands `command`. What a site or tool wrote that is
    printed rather than thrown (a check's detail and hint, warm's errors, APVM's progress, the
    banners' site values) goes through `printableLines` (`text.ts`): `plain` then `redactSecrets`,
    per line, indent kept.
  - **Live block** ([`live-block.ts`](../../src/common/reporting/live-block.ts) rows,
    [`live-session.ts`](../../src/common/reporting/live-session.ts) lifecycle): only when
    `capabilities.live` ([when](../guides/configuration.md#terminal-output)) and not quiet. From the
    first scenario's begin (setup lines print plain before it) to `onEnd`, bottom-pinned: `███░░ 23/52
    · 44% · 20 passed · 1 flaky · 3 running · 4m 12s` (`RunTally`'s counts) and one `▸ Feature ›
    Scenario · site · 1m 03s` row per busy worker (`siteLabel`: no user, password, query, fragment or
    `;` parameter, nothing before an `@` in the path). Narrow: the bar goes, then `running`, then the
    counts are cut (the time stays); a worker row drops the feature path first; taller than the
    terminal, `… N more running`. Redrawn on every event, a 500 ms tick and `resize`. **Stdio capture**
    ([`terminal/stdio-capture.ts`](../../src/common/terminal/stdio-capture.ts)): meanwhile the runner's
    own `process.stdout.write` (and `stderr`'s, when a TTY) is replaced, so foreign writes
    (Playwright's warnings, `emitWarning`, another reporter's `console.*`) are cut into lines (a
    partial one held until its end or 64 KiB), masked and printed above the block; the region writes
    through a `bypassWriter`; a child's writes to an inherited fd cannot be seen. **Ending**: `onEnd`
    clears it before the settled lines and summary; a callback's or drawing's throw (warned once), a
    failed write and `exit` close it too, undoing capture, listeners and tick. `SIGTERM`/`SIGHUP`:
    cleared, drained ≤ 500 ms, re-sent when no other listener handles it (exit status 143/129).
    `SIGKILL` leaves the block. `onExit` drains ≤ 2 s, then makes a drained terminal blocking again; a
    paused one (Ctrl-S) stays non-blocking and the run ends once resumed. A second terminal reporter
    (`--add-reporter`) prints plain lines above the first's block.
  - **Quiet** (prints nothing, registers no sink; `terminal-mode.ts`) for `--list`, `--ui` (`--ui*` in
    `argv`, or `process.stdout.write` replaced — Playwright's stdio interception, an editor's test
    server too) and `PW_TEST_REPORTER`. Quiet, `printsToStdio()` is `false`, so Playwright adds its own
    terminal reporter (`line`, `dot` under CI; its listing for `--list`): a `PW_TEST_REPORTER=junit` or
    `null` run is never silent — but that fallback prints worker output **unmasked**. Watch mode
    (`PWTEST_WATCH`) does not intercept stdio: the reporter prints there. `--add-reporter` is not
    detected: an added printing reporter doubles every line, an added `list` prints errors unmasked.
  - **Never fails a run**: callbacks are caught (one `[terminal]` warning on stderr). While it owns
    stdout it listens for its `error` event, so a closed pipe (`EPIPE`, `… | head -1`) never crashes
    the runner: the run ends as it would, `run.end` written; a failed write stops its output for
    good, the listener kept after `onExit` so the summary's writes fail silently too.
  - **Terminal primitives** ([`src/common/terminal/`](../../src/common/terminal/), side-effect free,
    shared with the orchestrator's screen): `capabilities.ts` (colour/live/Unicode, every input a
    parameter), `palette.ts` (semantic colours via `styleText`, ASCII fallback, `TEXT_PALETTE` for
    thrown text), `layout.ts` (display width, grapheme-safe cuts, width 20–120, 500-code-point
    `capLine`), `stream.ts` (`openLiveTerminal` — non-blocking TTY stdout plus a no-op `error`
    listener — is the only way to a live region; `drainTerminal` before exit; `writeSafely`, backlog
    bound), `live.ts` (the region: byte-exact `\r\n` cursor contract, throttled, one repaint per
    print burst, SGR-only style, dead after a failed write), `stdio-capture.ts` (the process's own
    writes printed above a live block, restored exactly: below).

- **The results stream** ([`reporting/results-stream.ts`](../../src/common/reporting/results-stream.ts))
  appends one JSON line per event to `<report dir>/results.jsonl` as it happens: `run.begin`,
  `setup.end`, `scenario.begin` (per attempt), `scenario.retry`, `scenario.end` (once, final; for a
  retry that never ran, as the run ends, with `retryNotRun`), `run.error`, `run.end`. Schema v1 in
  [`results-schema.ts`](../../src/common/reporting/results-schema.ts): every line has `v`, `type`, `at`,
  and readers ignore what they do not know
  ([`results-reader.ts`](../../src/common/reporting/results-reader.ts) reads complete lines only).
  Silent on the terminal; listed before the reports so `run.end` lands before their slow `onEnd`. A
  failed write warns once (through the terminal sink, else stderr), never fails the run. No `run.end` means the runner died (SIGTERM,
  SIGKILL); `mode: "list"`, or no tests, marks a run that ran nothing.
- **The end-of-run summary** ([`reporting/run-summary.ts`](../../src/common/reporting/run-summary.ts)),
  the last reporter, prints in `onExit`, below everything (Playwright's counts included), after a blank
  line and with none after it. Its header is a heavy rule as wide as the terminal (`COLUMNS`, else 80,
  in a pipe; never cutting its words); colours, the verdict's mark and its own glyphs come from the
  terminal palette, so `E2E_OUTPUT=plain` makes it colourless and ASCII (`== backwpup . pro@nginx
  (pro) == x FAILED ==`); the phrases it shares with the reports (the plugin, the site) keep their
  `·`. The verdict
  (`✔ PASSED`, `✘ FAILED`, `✘ COULD NOT TEST` for a failed setup, `■ INTERRUPTED`, `■ STOPPED` when the
  drain skipped a scenario, `NO TESTS` only when no error came from outside a test — a spec that would
  not load plans none either and is `FAILED`); the counts (drain skips as `stopped`) and duration;
  `Failed`: each scenario that failed for good, `Feature › Scenario — <failed step>` (`failedStep`),
  the first ten, then `and N more`; each outside-test error (`Error`) and failed setup's first line; the plugin and sites tested (from the
  setups' attachments, `setup-facts.ts`); the Playwright and Cucumber reports as paths from the working
  directory (plain, quoted when a shell would split them), Allure's as the `report:allure` command for
  this very run (its `RUN_ID`). Site and setup text is printed plain (no escape sequence or control
  character), credentials masked (`displayText`); an interrupted setup is not called failed. Silent for
  `--list`; a SIGTERM ends a run before any `onExit`. It first prunes the run's report group
  ([Report retention](#report-retention)); a `Pruned` line says what went, only when something did.

All three read the run through one pure module, [`reporting/results.ts`](../../src/common/reporting/results.ts),
so they never disagree:

- **Final attempt**: the dispatcher's rule (`willRetry`), not the guess Playwright's reporters make:
  with retries left, a failed attempt runs again, and so does one Playwright skipped unrun (a failed
  `beforeAll`, a crashed worker); one the test skipped itself, or an interrupted one, never does. A due
  retry that never runs (the run stopped first, or an error Playwright does not retry, like a screenshot
  without baseline) is settled as the run ends (`RunTally.settle`), its `scenario.end` then carrying
  `retryNotRun`.
- **Status**: `interrupted` if the last attempt was; else Playwright's `passed`, `failed` (timeouts
  included), `flaky` or `skipped`. A drained scenario is `skipped` with `drained: true`. `tags` are
  Playwright's, each once: Gherkin tags and any `@word` in a title.
- **First error**, only for a failed or interrupted test (a skip puts its reason on a step as an
  error): the first failing Gherkin step (a Background's included); else the innermost failing hook or
  fixture (`After Hooks › AfterEach Hooks › <hook>`, where a `DebugLogFatalError` lands); else, when no
  step carries one (a timeout inside a step, a crashed worker, a missing baseline), the last step begun —
  also when an After hook then failed cleaning up, since the first error is the cause. ANSI and
  Playwright's call log stripped (its element markup quotes attribute values), credentials masked, then
  at most 2,000 characters. Still as sensitive as the reports: an assertion quotes what it compared.
- **Never written**: step parameters, Playwright API steps' titles, attachments, output (Playwright
  titles a `fill()` with its value).
- **Counts**: scenarios and setups apart (a setup's project is `setup:<cell>` or `artifacts:<cell>`,
  `config/project-names.ts`); `didNotRun` for what never got a final result (every scenario of a cell
  whose setup failed, or what a stopped run never reached); `drained`, among the `skipped`, for the
  drain's. Errors from outside any test (`onError`), "No tests found" aside, are kept too.

## Saying what a run tested: the run facts

Another reporter, [`reporting/run-facts.reporter.ts`](../../src/common/reporting/run-facts.reporter.ts),
puts what the run tested up front in every report. Facts and formats are pure, in
[`reporting/run-facts.ts`](../../src/common/reporting/run-facts.ts): product, cell, edition, `RUN_ID`,
the display-only `E2E_RUN_NAME` and `E2E_REQUESTED_REF`, the plugin zips (ref, full commit, zip,
SHA-256 — the artifacts setup's attachment), each site's versions (the auth setup's), read through
`setup-facts.ts`, and the suite's version (`Suite`, the last fact so it never pushes one off Allure's
front page; `unknown` when unreadable or invalid; `run-facts.json`'s optional `suiteVersion`, absent
then; schema v1); the verdict is the summary's (`verdictOf`).

- **Position**: after the terminal reporter, before the reports (the HTML report reads title and
  metadata in its own later `onEnd`). Not first: the `[cell]` notice must precede the `[run]` header, and
  the stream must end before every report.
- **Writes**: `onBegin` — what is known, into `config.metadata` (flat keys), `<report dir>/run-facts.json`
  and `<report dir>/allure-results/environment.properties`; each setup's `onTestEnd` — its attachment and end, both
  files rewritten whole (temp file + rename), so a killed run's say `running`; `onEnd` —
  verdict, final files and metadata, and `PLAYWRIGHT_HTML_TITLE` (unless the environment set one);
  `onExit` — the banner, spliced before the Cucumber report's last `</body>` (only its last 64 KB read)
  and moved to the top by a script carrying no value.
- **Says**: one line — `backwpup · pro@nginx (pro) · BackWPup Pro 9.99.99 · develop @ 1dceea8966 ·
  WordPress 7.1.3 · PHP 8.5.11 64bit · <run name or RUN_ID>`, plus `RUNNING`, `INTERRUPTED`, `STOPPED`,
  `COULD NOT TEST` or `NO TESTS` (which the reports cannot say: Cucumber never says interrupted and omits
  setups) — as the HTML title, the Cucumber banner and Allure's `--name` (`reporting/allure-command.ts`); every
  fact, most important first, as Allure's Metadata (it shows eight), the HTML report's metadata and the
  banner's disclosure. An unknown fact says why (`unknown: auth setup failed`, `… skipped`,
  `… did not run`), never blank.
- **Keeps out**: of the sites file only `baseURL` gets in; every value is one plain line, credentials
  masked, HTML-escaped in the banner, escaped for the properties file (separators, `\`, controls,
  non-ASCII as `\uXXXX`, read back exact by Allure). `captureGitInfo` is off in the config factory:
  unset, Playwright enables it under CI and the HTML report would carry authors' emails and the PR's
  diff. Allure generates with `GIT_DIR` at a path git cannot open (`NO_GIT_DIR`, `allureEnv`): run in
  the checkout, it would write the origin URL (credentials included), branch and commit into the report.
- **Never fails a run**: every step is caught; the first failure warns once (terminal sink, else
  stderr). Nothing for
  `--list`, nor with a command-line `--reporter` (it replaces every configured reporter).

**Credentials** are masked before any cut by one helper, `redactSecrets`
([`text.ts`](../../src/common/text.ts)), wherever the suite's reporters show what a setup, step, site
or the environment said: the stream (`cleanMessage`), summary and facts (`displayText`), the site-info
attachment and APVM's output. It masks by shape: a GitHub token, a URL's user and password (to the
authority's last `@`), a credential URL parameter (`?access_token=`), an `Authorization` header, a
WordPress login cookie. The URL shapes are measured: Playwright's navigation errors quote a basic-auth
`baseURL` whole; git quotes a URL parameter (it hides URL credentials itself; APVM never puts its token
in a URL). A credential with no shape (a legacy 40-hex token, a bare password) is masked only by value
(`maskValues`: APVM's output, against `GITHUB_TOKEN`/`GH_TOKEN`). Playwright's own reports, traces and
Allure results keep errors as Playwright wrote them.

## The product list

[`src/projects/products.ts`](../../src/projects/products.ts) is the one product list, read by every
entry point spanning products: the bare `playwright.config.ts` (`productFromEnv` over `PRODUCT`), the
healthcheck, the artifact warm and the orchestrator (`productByName`, `playwrightConfigFor`). A
`playwright.<product>.config.ts` imports only its product, never loading another's sites files.

- **Import effects**: importing the list loads every product's sites files (a `[sites]` warning for a
  product with none, a **throw** for invalid JSON) and reads `BWP_*`, once. It never loads `.env`,
  stamps `RUN_ID`, adds a process listener or changes the working directory, so a long-lived process
  can import it and keep its own state, inside its error handling so a broken sites file is reported
  rather than fatal: the orchestrator uses `loadProductList`
  (`orchestrator/config/product-list.ts`), turning a broken sites file into one line naming it.
  Importing `run-context.ts` (so `project.ts`, `resolve.ts`, `consume.ts`) loads `.env` and stamps
  `RUN_ID`.
- **Drift guard**: `products.spec.ts` fails when the list disagrees with `src/projects/`'s folders, a
  product's features or own steps lie outside its folder, a product lacks a root entry config that builds it
  (checked in a child Node) or a `test:<product>` script running it, or a stray `playwright.*.config.ts`
  or script names an unlisted product.
- **Boundary**: nothing in `src/common/**` imports `src/projects/`, the list included. ESLint flags a
  static import; `src/common/import-boundary.spec.ts` also catches a dynamic `import()` or
  `typeof import()` (from TypeScript's syntax tree), and refuses a computed `import()` path outside test
  code.
- **The orchestrator's boundary**: `orchestrator/**` imports from the suite only what
  `orchestrator/suite-imports.json` admits (the list among them). ESLint refuses the rest by
  spelling; `orchestrator/import-boundary.spec.ts` judges each import where it really leads, walks
  all an admitted module can load (never `load-env.ts` or `run-context.ts`, even lazily) and imports
  the code in a fresh Node to prove the process unchanged (`probeImports`: environment, listeners,
  working directory, exit code, umask, listener limits, `Error.stackTraceLimit`; `fetch`,
  `process.exit`, `process.cwd`, `process.chdir`, `fs.close`, `fs.closeSync` not replaced — except
  graceful-fs's patch from Playwright's bundle, accepted only with all four of its marks,
  `GRACEFUL_FS_PATCH`). Admit a module only once that spec passes. Both refuse the builtins and
  names that load or run code no guard reads (`module`, `worker_threads`, `vm`, `inspector`, `repl`,
  `process.getBuiltinModule`, `eval`, `Function`), and the spec keeps it ES modules only (no `.cts`,
  `.cjs` or `package.json`): CommonJS hands every module a `require`.

## The config factory

[`createProductConfig(product)`](../../src/common/config/project.ts) expands a
[`ProductConfig`](../../src/common/config/types.ts) into a Playwright config. For **each** cell it holds
(every cell, or the pinned one) it emits three projects:

- **`setup:<cell>`** — a plain project running [`auth.setup.ts`](../../src/common/auth/auth.setup.ts):
  ends the previous run's saved session, logs in, attaches the site's versions (`site-info.json`). It
  traces **without DOM snapshots** (`snapshots: { dom: false }`, which also stops network recording),
  since a snapshot records the password field's value; its retained trace still holds `storageState()`'s
  result, so a failed setup ends the sessions it saved. Its tests also turn off Playwright's failure
  page snapshot (`keepSecretsOutOfFailureSnapshots`), back on only after a passing one: a setup worker
  hands its changed variables to dependent workers, so left off it would cost the scenarios their failure snapshots.
- **`artifacts:<cell>`** — a sibling setup (no browser) running
  [`artifacts.setup.ts`](../../src/common/artifacts/artifacts.setup.ts): resolves the cell's plugin zips
  (an APVM build of a git ref, or a copy of a provided zip) into a wiped `.artifacts/<product>/<cell>/`,
  verifies their identity, writes `resolution.json` ([plugin-artifacts.md](plugin-artifacts.md)).
- **`<cell>`** — the BDD project (`defineBddConfig`), `dependencies: ["setup:<cell>", "artifacts:<cell>"]`.
  The setups are **independent siblings**: either **failing** skips the scenarios; a placeholder-only
  cell **skips** both without blocking (nothing to log into or build, so the `@noauth` smoke runs).

Per-project knobs:

- `baseURL` defaults to the cell's first site; the `baseURL` fixture points each worker at its own.
- `retries: 2` on the scenario projects, local runs included (`E2E_RETRIES` overrides, 0–10); the
  setups never retry.
- Edition-ful cells generate only their edition's scenarios, via a Cucumber tag filter (`pro` → `not @free`, `free` → `not @pro`).
- `workers` per project is a defensive cap; correctness rests on the global single-cell `workers`.
- `navigationTimeout: 60_000` run-wide (`NAVIGATION_TIMEOUT_MS`): `goto`, `reload`, `waitForURL`, … are
  otherwise unbounded, and a page whose document was lost waits out the whole scenario (16 min measured).
  Measured worst navigation it bounds: 5.6 s (a cell's whole run); a call's own `timeout` still wins
  (measured), so the restore wizard's minutes-long waits keep theirs.

## The auth setup and the health check

[`auth.setup.ts`](../../src/common/auth/auth.setup.ts) (`setup:<cell>`, above) runs before the
scenarios, in three steps, per real site; it is skipped when a cell has only placeholder sites.

1. **Pre-flight** ([`setup/preflight.ts`](../../src/common/setup/preflight.ts)), gating:
   - First, settle what the product's killed runs left (`ProductConfig.settleLeftovers`; best-effort,
     a refusal is a warning; never in the healthcheck; on `ssh` only once the login shell passed),
     since that damage can stop WordPress booting.
   - The transport works (ssh: connection, WP-CLI, `rootDir`; docker: container up, WP-CLI inside;
     local: `rootDir`, WP-CLI on `PATH`) and `wp core is-installed` passes — a WordPress that cannot
     boot (old PHP, DB down, a fatal) is reported as that, never as "not installed".
   - Over `ssh` the **login shell** must pass a quoted string back unchanged and alone (`printf '%s'`
     of `!`, newline, `\\`, quotes, as the SSH user; csh/tcsh/fish fail it, `getent` names the shell;
     text a startup file prints around it fails too; a dropped connection is "could not be
     checked"): checked before settling and before anything the pre-flight writes, reported after the
     transport's gates ([`setup/login-shell.ts`](../../src/common/setup/login-shell.ts)).
   - A site asking for an identity (`transport.runAs` `"auto"`/`"user:group"`) has its **web server
     asked who PHP runs as** (`checkWebIdentity`); the verdict is registered in the setup process at
     once, so what follows runs as scenarios will, and written to `site-identity.json` for the workers
     ([Site identity](wordpress-automation.md#site-identity-wpsite-identityts)). `auto` without it runs
     `fallback/unverified`, warned; `runAs: false` gets no probe.
   - The **admin UI is English** (`determine_locale()` for the configured user, so per-user setting,
     site option, `WPLANG` and filters all count): page objects match English names, and a translated
     site would otherwise fail as many locator timeouts.
   - When WordPress cannot boot for that check but boots with the cell's own slug skipped
     (`--skip-plugins=<slug>`), the cell's plugin is a broken copy every login would die on: the setup
     removes it (`ensurePluginAbsent`) and says so in a **Plugin under test** line; the healthcheck
     only reports it ([`setup/cell-plugin.ts`](../../src/common/setup/cell-plugin.ts)).
   - A gate failure throws a formatted report and skips the scenarios.
   - Four **reports, never gates**: **File ownership** (the same `planOwnership` decision
     `normalizeOwnership` acts on, so report and action agree), **Elevation** (passwordless `sudo`?),
     **Site identity** (state, fallback reason + fix, the web server's identity and umask vs the run's,
     the login's `--user` check, `!log_allowed` from `sudo -n -l` where site commands do or would go
     through sudo, the SSH user's `~/.wp-cli/config.yml` in `site`, a world-writable umask, each sudo
     call's wait on a host name that does not resolve — only from 1 s
     ([`setup/sudo-lookup.ts`](../../src/common/setup/sudo-lookup.ts)), never advice to edit the
     host; ⚠ when any line warns) and **Plugin folders** (a folder WordPress lists no plugin in at the
     cell's slug, which its next `@plugin` scenario removes). No report fails a site for a property of
     the host; the one exception is an unparsable `transport.fileOwner` (our config, unreadable).
   - Reports fold into banners per run
     ([`setup/elevation-report.ts`](../../src/common/setup/elevation-report.ts)): elevation, silent when
     every site can elevate or opted out, naming the ownership cost only where a handover was needed;
     leftover plugin folders; site identity, silent when every site is `site`/`same-user`, verified
     over HTTP, and its sudo keeps command lines out of its log, or opted out (`runAs: false`: noted on
     its check line only) — except a sudo call waiting ≥ 1 s on the host's name, listed in any state
     (headed "to note", no fix).
2. **Authentication** ([`authenticate.ts`](../../src/common/auth/authenticate.ts)): end the session
   the cell's previous run saved (`auth/session.ts`: that token only, that host only, via
   `WP_Session_Tokens`), log in once through the UI, save `storageState`. A failing or timed-out setup
   ends the sessions it saved (from `afterEach`, `endSessionsWhenSetupFails` — a timeout abandons the
   body). Not at run end: the `--no-deps` loop reuses the login and an interrupted run skips
   teardown. Best-effort, bounded by `BEST_EFFORT_ALLOWANCE_PER_SITE_MS` (added to the setup's
   timeout): a session left open is a warning and expires in two days.
   [`auth/login.ts`](../../src/common/auth/login.ts) checks each field kept its value before
   submitting: WordPress re-focuses the username field, and a re-focus mid-`fill()` diverts text,
   failing much later as "login never settled". The password goes in with `enterSecret` and is
   checked with `holdsSecret`, both in the page ([`pages/secret-field.ts`](../../src/common/pages/secret-field.ts)).
3. **Site versions** — Site Health's "Copy site info", cut **in the page** to a whitelist (a traced
   call records what it returns): WordPress, the web server's PHP and SAPI, web server, database and
   its extension ([`setup/site-info.ts`](../../src/common/setup/site-info.ts)); a `[site]` line and
   `site-info.json`. A failure is a warning and an `error` entry.

**Secrets:** the setup traces without DOM snapshots and turns off its tests' `error-context.md` page
snapshot (`keepSecretsOutOfFailureSnapshots`, via the undocumented `PLAYWRIGHT_NO_COPY_PROMPT`)
([config factory](#the-config-factory));
[`secrets.run.spec.ts`](../../src/common/auth/secrets.run.spec.ts) proves no site password reaches a
report, through the real runner.

**Fleet health check** ([`healthcheck.ts`](../../healthcheck.ts), `npm run healthcheck`): the
pre-flight and login standalone (no test run, no `storageState` written) on **every** product × cell ×
site. Products run one section at a time, their sites concurrently; each site prints as soon as it is
done, with every check it ran (ownership, elevation and site identity reports included; the web
probe's verdict stays in memory, no file) and hints on failure; a summary per product ends it. The
banners are the auth setup's renderers, printed to **stdout** so `healthcheck > fleet.log` keeps it.
Its lines ([`setup/healthcheck-lines.ts`](../../src/common/setup/healthcheck-lines.ts)) are styled for
stdout as a run's are: no escape when redirected unless `FORCE_COLOR`; `E2E_OUTPUT=plain`,
`TERM=dumb` or a C locale spell its symbols in ASCII; a check's detail and hint, and the banners' site
values, are printed plain and masked (`printableLines`). Placeholder cells are skipped. Exit `0` only
if every real site passed. Knobs:
[configuration.md](../guides/configuration.md#fleet-health-check-npm-run-healthcheck).

## Credential handling: the in-memory pool registry

Playwright writes a project's `metadata` **verbatim into reports**, so it must never carry secrets
([`metadata.ts`](../../src/common/config/metadata.ts)):

- **`metadata`** holds only routing: `{ product, cell, edition? }` (`routingMetadata` / `readRouting`).
- The credential-bearing pool goes through an **in-process registry** (`registerPool` / `getPool`),
  filled as a side effect of building the config, which Playwright re-runs in every worker — so each
  worker rebuilds its pool from the sites files, never from a report-bound channel.

The same channel carries the rest of a product's policy to the **shared hooks**, which must not import
product code, and much of which JSON cannot hold (RegExps, functions). Each `register…` has a `get…`
twin:

- `registerDebugLogOptions` — the `debug.log` preset (RegExps);
- `registerSiteResidue` — paths left on disk (RegExps for runtime-named directory families);
- `registerSiteDbResidue` — the database footprint (would fit metadata; one channel is easier to follow);
- `registerSiteDataDirResolver` — how to ask the installed plugin for runtime-named data directories;
- `registerInstallOutputs` — what activation writes outside the plugin's folder; validated as registered;
- `registerConfigEdits` — files the plugin edits in place, with its own transforms; validated as
  registered;
- `registerPrepareActivation` — what the install writes before activation (WP Rocket's licence);
- `registerSettleAfterInstall` — what it asks of the site over HTTP once active;
- `registerStopRunningWork` — how to stop work it may still run;
- `registerForceDeactivate` — how to deactivate it when a plain deactivation leaves it active (WP
  Rocket with an unwritable `wp-config.php`);
- `registerSettleLeftovers` — for the auth preflight: settling what killed runs left, before the gates
  that damage could fail (never in the healthcheck).

The two validating registries make a bad declaration fail the config build. Hooks read everything but
the debug-log preset, the work stop and the leftover settle through `declaredResidue(product)`
(`hooks/plugin-lifecycle.ts`), as does a product step reinstalling mid-scenario, so the two never
prepare or sweep different things. Unlike `getPool`, no getter throws — declaring none is legitimate
and costs no round-trip: residue getters return an empty value, `getDebugLogOptions` `{}` (the
strictest scan: a forgotten preset is too strict, never lax), the others `undefined` ("nothing to
ask").

## Artifact directories & lifecycle

[`run-context.ts`](../../src/common/config/run-context.ts) resolves all paths via `dirs(product, cell)`:

| Kind | Path shape | Lifecycle |
| --- | --- | --- |
| **report** (accumulates) | `<REPORT_ROOT>/<product>/<cell>/<RUN_ID>/` | One per run — the three reports, `results.jsonl`, `run-facts.json`; pruned as each run ends ([Report retention](#report-retention)). |
| **output** | `<OUTPUT_ROOT>/<product>/<cell>/`, or `…/<product>/_all/<cell>/` | Ephemeral: Playwright empties it as a run selecting one of its projects starts (below). |
| **auth / bdd** | `<*_ROOT>/<product>/<cell>/` | Ephemeral, stable per `(product, cell)`; overwritten in place. |
| **artifacts** (ephemeral) | `<ARTIFACTS_ROOT>/<product>/<cell>/` | **Wiped whole** and re-resolved each run: the role zips + `resolution.json`. |

- `RUN_ID` is auto-stamped (filesystem-safe, lexically sortable) unless an orchestrator pins it to
  share one token across a batch. One formatter and one strict parser,
  [`config/run-id.ts`](../../src/common/config/run-id.ts): `<ISO time, ":" and "." as "-">-<suffix>`
  (the pid, or the orchestrator's run id). A pinned one may be any single folder name — not hidden, no
  `/`, no control character, ≤ 255 bytes, else the run fails naming `RUN_ID`; one the parser cannot read
  is dated by its stream's `run.begin`.
- `INVOCATION_ID` ([`config/invocation-id.ts`](../../src/common/config/invocation-id.ts)) is what
  tells two invocations apart where a shared `RUN_ID` cannot: 32 random hex digits made by the runner
  as it loads `run-context.ts`, carried to its workers as `E2E_INTERNAL_INVOCATION=<pid>:<token>`
  and believed only by that pid or a direct child carrying `TEST_WORKER_INDEX` (a Playwright worker;
  set before it loads the config): a run started from a worker, or directly by the runner, makes its
  own — except one started directly by a runner that itself inherited a worker's index. BackWPup
  names a copy's lease holder with it.
- `<product>/<cell>` is **always** appended, so two cells never share a directory whatever the
  `*_ROOT` overrides (`REPORT_ROOT`, `OUTPUT_ROOT`, `AUTH_ROOT`, `ARTIFACTS_ROOT`). Each root is repository-relative or absolute, kept as given by `dirs()` and
  resolved, never joined (`join` would nest an absolute root in the checkout): against `REPO_ROOT` by
  the suite's code, against the config's folder (the repository) by Playwright and playwright-bdd. Two
  runs of one cell share every folder but the report, so a cell takes one run at a time.
- **Output folders follow the selection** (`outputDirFor`): Playwright empties the output folder of
  every selected project before starting, so a cell's projects write in `<product>/<cell>` only in a run
  targeting that cell as a whole (`cellOwningOutput`: pinned without `--project`, or `--project=<cell>`
  pinned or not). Every other run writes in `<product>/_all/<cell>` (no pin and no `--project`, a setup
  project alone, a wildcard, another cell's project), so none can empty a running cell's folder. Unit
  runs write in `<OUTPUT_ROOT>/_unit`. Cell names are checked at load, so none is `_`-prefixed or
  escapes its folder.
- **Reports and logins are absolute paths in the checkout.** Playwright resolves the config's paths
  against its folder, but allure-playwright's `resultsDir` and a `storageState` path resolve against the
  working directory, so `reporters()` refuses a relative folder and each `storageState` is absolute. A
  run started anywhere writes in the checkout; `.env` is still read from the working directory.
- The artifacts dir is the only one **wiped** each run, so no stale zip survives and `resolution.json`
  (the channel BDD workers read through `pluginArtifact`) never describes a previous run; an `E2E_*_ZIP`
  pointing inside it is rejected before the wipe ([plugin-artifacts.md](plugin-artifacts.md#resolution-wipe--resolve--verify--publish)).
- A cell-less run reports to an `_all` bucket, never mislabeled as one cell.

### Report retention

[`reporting/retention.ts`](../../src/common/reporting/retention.ts) decides per group
(`<product>/<cell>`, `_all` included; a task, for the orchestrator), newest first by start time:

1. an **empty** run (`--list` or "No tests found", told by `results.jsonl`'s `run.begin`) takes no place
   under the cap and goes, unless protected;
2. a **protected** run (the one in progress) is kept, and so is one dated in the **future**, which takes
   no place under the cap and is never the newest complete report — a skewed clock or pinned RUN_ID
   cannot push a real report out;
3. the group's **newest complete** report (`playwright/index.html` written) is kept up to **182 days**
   whatever the cap, so a cell whose last runs were all killed keeps one readable report;
4. a run older than **30 days** goes (never under a day: a run in progress carries no marker), as does
   one beyond the newest **`E2E_REPORTS_KEEP`** (20). Killed runs count — and so would another run of
   the cell in progress, which nothing on disk tells from a killed one: one run per cell at a time. `0`
   lifts the cap only: the age rules still run, and nothing turns a run's own pruning off.

**When**: each run prunes its own group as it ends, in the summary's `onExit` (the last reporter, after
every report is written; `reporting/run-pruning.ts`), and the `Pruned` line says what went. So the 21st
run removes the oldest; a failing or interrupted run (one SIGINT included) still prunes; `--list`, a
killed run (the next run prunes) and a run whose command-line `--reporter` replaces the configured ones
do not. Other cells are never touched: `npm run report:prune` handles a cell that no longer runs (every
cell; a dry run unless `--apply`; `--keep`, `--older-than`, `--keep-newest-for`, `--product`, `--cell`;
exit 1 when a removal failed, 2 for bad arguments).

**How**: the listing never follows a link below the report root. A run is a folder holding a report
part, dated by the suite's own hand — its RUN_ID name, else its `results.jsonl`'s first line
(`run.begin`, whose `at` must read back exactly as written) — never by file time; anything else (a
`REPORT_ROOT` set to the repository finds `node_modules/<package>/dist`) is skipped, never removed. A
removal first renames the run to a hidden `.pruning-…` name in its group (atomic: no reader sees half a
run), then removes it (links inside are unlinked, targets untouched) and checks it is gone. Before and
after the rename the folder must still resolve below the report root (`outsideRoot`), so a cell or
product folder swapped for a link after the listing cannot redirect a removal out of the tree. Failures are
reported, never thrown: pruning cannot fail a run. A later prune removes an interrupted removal's leftovers after an hour. `npm run report`
and `report:allure` skip hidden folders.

**Bundles**: a run's download bundle (`report-bundle.ts`) lives inside its run folder — `report/`,
`report.tar.gz` and, while one is built, a hidden `.bundle-work-<pid>-<hex>/` — so it is listed,
measured and pruned with its run, which stays one complete run (`report/` is not among
`REPORT_PARTS`, so it never makes a folder a run). A killed build's work folder is released by the
next build of that run, an earlier `report/` it held aside put back first. The cell-level
`allure-history.jsonl` (one line per run, tagged `e2eRun`) is outside every run and survives.

## Mental model, end to end

```text
E2E_CELL=apache npm run test:wp-rocket
        │
        ├─ load-env.ts                 → .env into process.env (once; E2E_LOAD_DOTENV=false skips it)
        ├─ wp-rocket.config.ts         → ProductConfig { name, features, steps, sites, artifacts }
        └─ createProductConfig()       (in bddgen, the runner and every worker)
              ├─ E2E_CELL → holds apache alone (unknown pin / stray --project → fail)
              ├─ selectedCells() → ["apache"]  (fail fast if >1)
              ├─ global workers  = apache pool size
              ├─ project setup:apache     → leftovers settled, preflight + auth.setup.ts (end last session, login → storageState, site versions)
              ├─ project artifacts:apache → resolve + verify plugin zips (→ .artifacts/…/resolution.json)
              └─ project apache → depends on BOTH setups → bddgen specs → run, each worker bound to one site
```

Pre-warming APVM's cache (`npm run artifacts:warm`) is optional: see
[plugin-artifacts.md](plugin-artifacts.md#pre-warming). The orchestrator's later phases
([its plan](../plans/orchestrator-plan.md)) will warm before each run; Phase 0.5 lets each run build its
own.
