# Suite version in the terminal and Slack

## TLDR

Show the suite's own version (`package.json` `version`, now `1.1.0`) where an operator looks:

- **Suite run** — the `[run]` header ends `· suite 1.1.0`; the run's facts gain a `Suite` fact
  (`run-facts.json`, Allure's Metadata, the Cucumber banner).
- **Orchestrator** — its `started · …` line (terminal and `orchestrator.log`) and `--dry-run`'s report
  name it once at boot.
- **Slack** — a `Suite: 1.1.0` line, taken from the run's own facts (the version that ran), else the
  orchestrator's.

One small reader (`src/common/config/suite-version.ts`) serves both processes. Display only: a
missing or malformed version reads `unknown`, never fails a run.

## Stack

Existing only: Node ≥ 24.16 (`node:fs`), TypeScript 6, zod 4 (the orchestrator's facts reader),
Playwright's unit runner. No new dependency.

## Current state (verified 2026-11-13)

- `package.json`/`package-lock.json` hold `1.1.0` (bumped with `npm version 1.1.0
--no-git-tag-version`; no version lifecycle scripts exist). Nothing in `src/` or `orchestrator/`
  reads it; the suite's runs are launched as `node <cli.js>` (`orchestrator/runs/commands.ts`), so
  `npm_package_version` is **not** set there — read the file.
- Suite: `runHeaderLine` (`reporting/terminal-lines.ts`) prints the header from `RunHeader`, filled by
  `terminal.reporter.ts` `onBegin` from the reporter options (`RunDescription`,
  `reporting/run-description.ts`), which the config factory (`config/project.ts`) builds.
  `beginFacts`/`factEntries`/`titleLine` (`reporting/run-facts.ts`) build every report's facts.
- Orchestrator: `startedLine` (`start-lines.ts`), said once by `start.ts` (~l. 767) to the terminal and
  the log; `CHECKOUT` (`start.ts:118`) is the checkout root. `runs/facts.ts` reads `run-facts.json`
  (zod, unknown fields ignored, schema `v: 1`); `events/run-finished.ts` builds `run.finished` v1
  (fields may be **added** within v1); `notify/slack.ts` `slackMessage` renders it.
- The orchestrator may import only modules listed in `orchestrator/suite-imports.json`, proven by
  `orchestrator/import-boundary.spec.ts`; it never imports `package.json` as a module.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Source: `<checkout>/package.json`'s `version`, read with `readFileSync` + `JSON.parse` — never `import … with { type: "json" }` (the boundary spec forbids `package.json` imports) nor `npm_package_version` (unset in orchestrated runs).                                        |
| D2  | Valid only when a string matching SemVer 2.0 (official regex, prerelease/build allowed), ≤ 64 chars; else `undefined`, shown as `unknown`. Never throws: display only.                                                                                                           |
| D3  | Wording: terminal `suite 1.1.0`; facts label `Suite`; Slack `Suite: 1.1.0`. The word "suite" everywhere, no package name.                                                                                                                                                        |
| D4  | Slack shows the **run's** version (its `run-facts.json`), since a long-lived orchestrator may outlive a `git pull`; a run that left no facts falls back to the orchestrator's boot-time version; neither → `Suite: unknown`.                                                       |
| D5  | `run-facts.json` and `run.finished` stay at v1: additive optional fields, ignored by older readers.                                                                                                                                                                             |
| D6  | Out of scope: healthcheck, `artifacts:warm`, Datator (its payload has no such field). Each can reuse P1 later.                                                                                                                                                                  |

## Phases

### P1 — The reader · deps: — · parallel: — · effort XS · difficulty low

New `src/common/config/suite-version.ts`, imports only `node:fs`/`node:path`:

- `parseSuiteVersion(text: string): string | undefined` — pure: JSON-parses, returns `version` when it
  satisfies D2; `undefined` for bad JSON, a non-object, a missing/non-string/invalid version.
- `readSuiteVersion(root: string, read = readFileSync): string | undefined` — reads
  `join(root, "package.json")`; any read error → `undefined`.
- `suiteVersionText(version: string | undefined): string` — `version ?? "unknown"`.

Admit it to `orchestrator/suite-imports.json`. Spec `suite-version.spec.ts`: valid (`1.1.0`,
`1.1.0-rc.1+b5`), invalid (`v1.1.0`, `1.1`, `""`, number, 65 chars, control chars), bad JSON, missing
file, unreadable file (injected `read` throwing), the real `package.json` → `1.1.0`.

**Done:** gates green; `import-boundary.spec.ts` passes with the module admitted.

### P2.1 — Suite `[run]` header · deps: P1 · parallel: P3 · effort S · difficulty low

- `RunDescription` gains optional `suiteVersion?: string`; `readRunDescription` keeps it only when a
  string (a wrong type is ignored, not reported — it is optional).
- `config/project.ts`: read once with `readSuiteVersion(REPO_ROOT)` (module-level memo, so workers
  importing the config pay one small read) and pass it in the reporters' options.
- `RunHeader` gains `suiteVersion?: string`; `runHeaderLine` appends
  `suite ${suiteVersionText(v)}` as its last word (after the scenario count), through `displayText`,
  inside the existing `capLine`.

Specs: header with a version, without (`suite unknown`), ruled and plain styles; existing header
expectations gain the new word (a behaviour change, not a test bent to pass — say so in the commit).

**Done:** gates green; `E2E_CELL=apache npm run test:wp-rocket -- --grep @noauth` shows
`· suite 1.1.0` in the header, plain (`E2E_OUTPUT=plain`) and ruled.

### P2.2 — Run facts · deps: P2.1 · parallel: P3 · effort S · difficulty low

- `RunFacts` gains `suiteVersion?: string`, set by `beginFacts` from the description (through
  `factText`).
- `factEntries`: `["Suite", suiteVersionText(v)]` right after `Run ID` — Allure shows only the first
  eight entries on its front page; keep them as they are.
- `titleLine` unchanged (the report title stays about what was tested).

Specs: `beginFacts`, `factEntries` (position, `unknown`), `runFactsJson` holds `suiteVersion`;
`run-facts.run.spec.ts` sees it in a real run's `run-facts.json`.

**Done:** gates green; a real run's `run-facts.json`, Allure Metadata and Cucumber banner show it.

### P3 — Orchestrator start · deps: P1 · parallel: P2.1, P2.2 · effort S · difficulty low

- `start.ts`: `readSuiteVersion(checkout)` once in `prepareStart` (injectable through `deps` like
  `checkout`), kept on the prepared start.
- `startedLine` gains a `suiteVersion` parameter: `started · suite 1.1.0 · 1 task (bpng) · … · pid
4242`.
- `dry-run.ts`: its first line names it the same way.

Specs: `start-lines.spec.ts`, `dry-run.spec.ts`, `start.spec.ts` (an injected version reaches the line;
a missing `package.json` prints `suite unknown` and still starts).

**Done:** gates green; `npm run orchestrator -- start --dry-run` and a `--once` run print it in the
terminal and `orchestrator.log`.

### P4 — Slack · deps: P2.2, P3 · parallel: — · effort S · difficulty low

- `runs/facts.ts`: read optional `suiteVersion` (`optionalText`, then P1's validity rule) into
  `RunFactsRead`.
- `events/run-finished.ts`: add `suite: { version: string | null }` (D5) — facts' version, else the
  orchestrator's (input field `suiteVersion`), else `null`; cut to the event's short-fact limit.
- `notify/slack.ts`: `Suite: <version|unknown>` after the site lines, through `escapeCut`.

Specs: facts reader (present, absent, wrong type), event (facts win, fallback, `null`), Slack line
(escaping, `unknown`); `soak.spec.ts` unaffected.

**Done:** gates green; a `--once` run against a Slack sink (`__fixtures__` HTTP sink) carries the
line; one real orchestrated run on a free cell (bwu2/bwu3) posts it.

### P5 — Docs · deps: P2.2, P3, P4 · effort XS · difficulty low

`execution-model.md` (header format, the `Suite` fact), `orchestrator.md` (start line example, Slack
message, `run.finished` field), `orchestrator-phase-0.5-plan.md` (§4 examples, §6), `AGENTS.md`
(`config/` list gains `suite-version.ts`). Then delete this plan (nothing left to keep).

## Risks

| Risk                                                                    | Mitigation                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| A broken `package.json` crashes a run or the orchestrator.              | D2: never throws; `unknown` shown. Specs cover it.                                                  |
| Admitting a module breaks the orchestrator's import boundary.           | P1 imports only `node:fs`/`node:path`; the boundary spec must pass before admitting it.             |
| Slack shows a version the run did not use (checkout updated mid-loop). | D4: the run's own facts win; the boot-time version is only a fallback.                              |
| Older readers of `run-facts.json`/`run.finished` break.                 | D5: optional fields within v1; the orchestrator's zod reader ignores unknown keys.                  |
| Allure's front page loses a fact.                                       | `Suite` placed after `Run ID`, outside the first eight.                                             |
| Header grows past a narrow terminal.                                    | The words already go through `capLine`; the rule path already handles long titles.                 |
| Forgetting to bump the version on release.                              | Out of scope; note in the commit that the version is now displayed, so bumps matter.                |
