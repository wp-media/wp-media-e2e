# Dependency and Node 26 update plan (2026-11-18, done 2026-11-19)

Done. Kept: decisions, the facts behind standing code and config choices (per phase), and open
obligations ([Deferred](#deferred-open-obligations)). Per-phase detail lives in git (`chore/deps-pN-*`
merges into `develop`).

## TLDR

- Suite moved to **Node 26.13.1** (Active LTS), **npm 12.2.3** and every dependency's latest stable, one
  phase per package group, CI green each time; `npm audit` 18 → 0. TypeScript stays 6 (D1).
- Code changed only for Playwright 1.65 (`screen`), node-ssh 14 (rejection mapping), string-width 9
  (regional indicators), typescript-eslint 8.73 (spec casts) and Allure 3.33 (loopback, no git facts,
  glob override); the rest needed comments, docs or calibration notes.
- Open: [Deferred](#deferred-open-obligations). A real Slack/Datator post is the user's check, on their
  instance.

## Stack

Node 26.13.1 LTS, npm 12.2.3, TypeScript 6.0.3, Playwright 1.65.1 (Chromium 159), playwright-bdd 9.2.1,
Allure 3.33.0 (allure-playwright 3.15.0), node-ssh 14.0.0 on ssh2 1.17.0, execa 10.2.1, commander
15.1.0, string-width 9.0.0, pixelmatch 8.0.0, ESLint 10.15.0, typescript-eslint 8.73.0, APVM
`apvm-napi` 3.3.0.

## Decisions

- **D1 — TypeScript 6.0.3, not 7:** TS 7.0 has no compiler API (`layering.spec.ts`,
  `__fixtures__/import-scan.ts`, `orchestrator/__fixtures__/import-boundary.ts` use it), and
  typescript-eslint pins `typescript <6.1.0` (#10940).
- **D2 — string-width:** regional indicators measured as tmux draws them (P9).
- **D3 — `engines` `>=26.13.1`:** the security release everything was measured on.
- **D4 — pixelmatch 8:** no `@visual` scenario calibrated yet; re-tune with the first one (P10).
- **D5 — Docker local env out of scope:** its images should mirror the QA servers; ask first.
- **D6 — npm 12:** its default script blocking is the policy `allowScripts` already declared; pinned by
  `devEngines.packageManager` (`npm`, `>=12.2.3`, `onFail: "error"`).

## Phases

### P0 — Baseline · xs/easy · deps: —

Baseline on 24.22.3 and 26.13.1; nothing standing.

### P1 — Node 26 · s/medium · deps: P0

- `.nvmrc`/`.node-version` 26, `@types/node` 26, `actions/setup-node@v7`.
- **ssh2's `sshcrypto` addon does not compile on 26** (mscdex/ssh2#1531): pure-JS fallback, reported
  5–13× slower; noted in `orchestrator.md`'s install.
- **Undici 8 negotiates HTTP/2 by ALPN** (`allowH2: true`): `notify/post.ts` behaves as on HTTP/1.1
  (`post.h2.spec.ts` proves it); only a reset's code differs (`ERR_HTTP2_STREAM_ERROR` vs
  `UND_ERR_SOCKET`), both URL-free.
- **Homebrew's Node 26 is not the official build** (OpenSSL 4.1, ICU 79.1, npm 11): measure on the
  official one (fnm).

### P2 — npm 12 · s/medium · deps: P1

- Unknown or abbreviated flags are errors: every flag in the repo is spelled in full;
  `npm run orchestrator -- …` needs the `--`.
- **`allow-git` defaults to `none`** (`.npmrc`: `root`); `root` refuses a _changed_ git pin
  (`EALLOWGIT`): change it once with `npm i --allow-git=all` (or `--package-lock-only`), then `npm ci`
  installs it.
- **`allowScripts` keeps APVM's deny key** (`prepare: husky`): without it a changed pin warns APVM's
  `prepare` blocked. `install-scripts prune` misreports git dependencies; never prune on Linux (it
  lists macOS-only `fsevents@2.3.3`). ssh2's script stays allowed so its fallback is chosen as before.
  The root `postinstall` is not governed by it.
- **npm 11 first on `PATH` fails every npm command here** (`EBADDEVENGINES`; `--version` and
  `npm i -g npm@12.2.3` still work): hence `.husky/pre-commit` runs `lint-staged`, not `npx`.
- **CI:** setup-node's npm cache would run Node 26's npm 11 in the checkout and fail, so
  `package-manager-cache: false`, `npm install --global npm@12.2.3`, then `actions/cache` on `~/.npm`
  keyed by the lockfile. CI installs with `--ignore-scripts`, so it never exercises `allowScripts`.
- npm 12 prints script banners (`npm notice run …`) on stderr; `cells.sh`'s `npx` passes
  `--loglevel=warn`.

### P3 — execa 10.2, commander 15.1 · xs/easy · deps: P1

execa 10.2 kills a child over `maxBuffer` with `SIGTERM` (then `SIGKILL` after 5 s, direct child only);
`fromExeca` checks `isMaxBuffer` before `signal`, so the outcome is unchanged (`exec.spec.ts` pins it).

### P4 — APVM 3.3.0 · s/medium · deps: P1

Pin `#v3.3.0` (tags lost the `cli/` prefix). API is a superset (`const enum`s now runtime enums); specs
stay type-only. Fresh WP Rocket zips keep nested vendor `php*`/`package*` files (new SHA-256). `commit:`
takes only a SHA. The addon logs nothing; no token text in any error or event (V257 re-run).

### P5 — Lint and format toolchain · xs/easy · deps: P4

`no-unsafe-enum-assignment`: 3 spec casts are `as unknown as JsBuildPhase`, never the enum members — a
value import loads the native addon, breaking `apvm.ts`'s only-importer rule.

### P6 — Playwright 1.65.1 · m/medium · deps: P1

**Floor 1.64:** presets apply `screen`, an option fixture new in 1.64 (on 1.63 a file overriding it does
not load). `DeviceProfile.screen`, the sixth override in `fixtures.ts`, is read by `presetScreen`
(`DeviceDescriptor`'s type omits it); without it the `@mobile` smoke fails.

### P7 — Allure 3.33 · s/medium · deps: P1

- **History continues from 3.18:** lines keyed by `retryHash` = 3.18's `historyId`; no reset needed.
- **`overrides: { allure: { glob: "^14.0.6" } }`** clears its audit findings; glob 14 accepts every
  option Allure passes. Drop once Allure depends on glob ≥ 14.0.2.
- **Loopback:** `open` bound every interface; `allurerc.mjs` sets `host: "127.0.0.1"`; a `keep`
  bundle's landing command pins `npx --yes allure@3.33.0 open --host 127.0.0.1 allure` (a spec keeps the
  version equal to the installed one). Remote: `ssh -L`.
- **No git facts:** the `local` detector wrote the origin URL (credentials), branch and commit;
  `allureEnv` sets `GIT_DIR=NO_GIT_DIR`. CI detectors read env vars only (no credentials).

### P8 — node-ssh 14 · m/hard · deps: P1

- **`@types/ssh2` override** (`{ "@types/node": "$@types/node" }`), else a nested `@types/node` 18 stays
  in the lockfile as `invalid`.
- **#132:** `execCommand` rejects where 13.x resolved `code: null`. `sshExecFailure`
  (`transport-exec.ts`) maps it, never with argv or `cause`: `Not connected` → unchanged (retried); a
  recorded loss → "lost (…) while … was running"; a client no longer connected → "closed before … was
  confirmed started" (never retried; the command may have run), except `No response from server`;
  anything else → "could not run over SSH". `code === null` still means a disposed connection or a
  server closing the session.
- `noBuffer: true`: no `ERR_OUTPUT_TOO_LARGE`; the ssh path has no output cap of its own.

### P9 — string-width 9 · s/medium · deps: P1

v9 counts regional indicators 2, keycaps (`[#*0-9]`+U+20E3) 1, lone surrogates 1 (`withoutControls`
makes text well-formed first). **Rule (D2):** `codePointWidth` counts U+1F1E6–U+1F1FF as 1, alone and in
a sum (flag 2, lone 1). Basis: tmux 3.8's drawn columns (the only terminal measured) and "never below
what a terminal draws".

### P10 — pixelmatch 8 · xs/easy · deps: P1

Metric YIQ → OKLab lightness + HyAB; `threshold` keeps its 0–1 scale. Playwright 1.65.1 still bundles a
YIQ pixelmatch, so our 0.2 equals its number, not its sensitivity (blue vs navy: v7 0.16, v8 0.32).
`compare.spec.ts` pins the metric with three colour pairs.

### P11 — Docs sync and final audit · s/easy · deps: P1–P10

Docs synced to the locked versions (floors raised to them); final live runs, soak and audit green.

## Deferred (open obligations)

- **TypeScript 7:** wait for 7.1 stable plus typescript-eslint support (#10940); then move the three
  TS-API spec helpers to the 7.1 API (typescript-eslint's `tsgo` backend is still experimental).
- **Docker local env images (D5).**
- **ssh2 native crypto on Node 26** (#1531): once fixed, drop `orchestrator.md`'s install note.
- **SSH loss wording:** an `error` event before the command started (channel opening, exec reply
  pending) still says `lost (…) while "<program>" was running`, though the start is unknown (read, not
  measured; pre-existing); fix by tracking the start via node-ssh's `onChannel`.
- **pixelmatch re-tune** (`DEFAULT_PIXEL_THRESHOLD`) with the first `@visual` scenario; add a colour pair
  just either side of the chosen value (today's pairs pass for 0.05–0.32).
- **Plain output:** under `E2E_OUTPUT=plain`, Playwright's "To open last HTML report run" line keeps ANSI
  colour when piped through `tee` (also on `develop`).
- **Unit-suite robustness** (RemoteDesktopQA, Ubuntu 24.04; same on Node 24):
  - umask 0002 fails 23 orchestrator specs (`state/` counter, run-retention, orphans; `runs/launch`):
    fixture folders come out 775, rightly refused as group-writable; specs should set their umask or
    modes.
  - `src/common/__fixtures__/temp-dir.spec.ts` fails when the checkout is under the OS temp folder.
  - `src/projects/wp-rocket/support/config-edits.php.spec.ts` fails on PHP 7.4:
    `__fixtures__/wp-rocket-edits-harness.php:136` uses `str_contains()`; polyfill it or skip with a
    reason.
  - `src/projects/backwpup/support/content-copy-put-back.spec.ts:474` ("the old put-back … fails while
    the site writes") is timing-dependent: once did not reproduce the old failure.
- **Twin CI speed-up** (optional; "Twin specs" 21–35 min, limit 50): the WP Rocket lifecycle file (~16
  min) runs alone on one worker at the end; parallel mode needs concurrent APVM resolution shown safe.

## Status

All phases done (P0 2026-11-18, P1–P11 2026-11-19), each merged into `develop` with CI green.

| Phase | Outcome                                                                        |
| ----- | ------------------------------------------------------------------------------ |
| P0    | Baseline green on Node 24 and 26; audit 18                                     |
| P1    | Node 26.13.1, @types/node 26                                                   |
| P2    | npm 12.2.3 (`devEngines`), CI's own `~/.npm` cache, APVM deny key kept         |
| P3    | execa 10.2.1, commander 15.1.0; maxBuffer outcome unchanged                    |
| P4    | apvm-napi `#v3.3.0`                                                            |
| P5    | ESLint 10.15, typescript-eslint 8.73, prettier 3.10, lint-staged 17.6          |
| P6    | Playwright 1.65.1; `screen` override, floor 1.64                               |
| P7    | Allure 3.33.0; history kept, glob 14 override, loopback, no git facts; audit 0 |
| P8    | node-ssh 14.0.0; rejection mapping                                             |
| P9    | string-width 9.0.0; regional indicator 1                                       |
| P10   | pixelmatch 8.0.0; HyAB metric pinned                                           |
| P11   | Docs synced; final runs green                                                  |
