# Dependency and Node 26 update plan (2026-11-18)

## TLDR

- **Moves the suite to Node 26** (Active LTS since 2026-10-28), **npm 12** and every dependency's latest stable version.
  - One small phase per package group, done one after another, each on its own branch merged into `develop` before the next.
- **Node 26:** every package in the upgraded tree accepts it, and no Node 25/26 removal or deprecation hits our code.
  - Only config and docs change: `.nvmrc`, `engines`, `@types/node` 26, CI.
  - Known side effect: ssh2's optional native crypto no longer compiles, so it falls back to slower pure JS, which is already what CI and local use.
- **npm 12** (D6) blocks dependency install scripts unless `allowScripts` lists them. Our `allowScripts` block needs cleaning, and CI needs npm 12 installed.
- **Four upgrades need code changes:**
  - Playwright 1.65: `@mobile` would report a desktop screen.
  - node-ssh 14: a lost connection now rejects, and our "lost" message is built only on the old path.
  - string-width 9: flag and lone-regional-indicator widths change.
  - typescript-eslint 8.73: 3 casts in specs.
- **Comments, docs or calibration only:** APVM 3.3.0 (its pin change needs `--allow-git=all` once), pixelmatch 8 (new colour metric) and Allure 3.33 (history keys unchanged; comments, a glob override, its server on loopback, no git facts in reports).
- **TypeScript 7.0 is not possible yet:** it ships no compiler API, and no typescript-eslint version supports it. Stay on 6.0.3, the newest 6.x.
- **Audited adversarially** (2026-11-18). All its findings are folded in. The load-bearing ones (EALLOWGIT, the "lost" message, regional indicators, npm `allowScripts`/npm 12, Node paths) were reproduced by hand. The rest are the auditor's measurements.

## Inventory

Sources: `npm outdated`, `npm view`, GitHub releases. Every installed version matches the lockfile, and every target is npm's or GitHub's `latest`.

| Package                                                                                           | Installed     | Target                 | Kind                               | Phase    |
| ------------------------------------------------------------------------------------------------- | ------------- | ---------------------- | ---------------------------------- | -------- |
| Node (`.nvmrc`, `engines`)                                                                        | 24, ≥24.16    | 26, ≥26.13.1           | runtime major                      | P1       |
| @types/node                                                                                       | 24.13.6       | ^26.6.6                | major (follows runtime)            | P1       |
| actions/setup-node                                                                                | v6            | v7                     | CI major                           | P1       |
| npm                                                                                               | 11.19/11.20   | 12.2.3                 | **major**                          | P2       |
| execa                                                                                             | 10.0.1        | 10.2.1                 | minor                              | P3       |
| commander                                                                                         | 15.0.0        | 15.1.0                 | minor                              | P3       |
| apvm-napi (git)                                                                                   | `#cli/v3.0.0` | `#v3.3.0`              | minor, same API                    | P4       |
| eslint                                                                                            | 10.11.0       | 10.15.0                | minor                              | P5       |
| typescript-eslint                                                                                 | 8.70.1        | 8.73.0                 | minor, new strict rules            | P5       |
| globals                                                                                           | 17.12.0       | 17.14.0                | minor                              | P5       |
| prettier                                                                                          | 3.9.9         | 3.10.1                 | minor (0 files reformat, measured) | P5       |
| lint-staged                                                                                       | 17.5.1        | 17.6.1                 | minor                              | P5       |
| @playwright/test                                                                                  | 1.63.0        | 1.65.1                 | minor, **breaking** (`screen`)     | P6       |
| allure                                                                                            | 3.18.0        | 3.33.0                 | minor, history format              | P7       |
| allure-playwright                                                                                 | 3.12.2        | 3.15.0                 | minor                              | P7       |
| node-ssh                                                                                          | 13.2.1        | 14.0.0                 | **major**                          | P8       |
| @types/ssh2 (new)                                                                                 | —             | ^1.15.6                | optional peer of node-ssh 14       | P8       |
| string-width                                                                                      | 8.3.0         | 9.0.0                  | **major**                          | P9       |
| pixelmatch                                                                                        | 7.2.0         | 8.0.0                  | **major**                          | P10      |
| typescript                                                                                        | 6.0.3         | stay (7.0.2 blocked)   | —                                  | deferred |
| zod, adm-zip, pngjs, @types/pngjs, tsx, husky, playwright-bdd, @eslint/js, eslint-config-prettier | latest        | —                      | —                                  | —        |

The other CI actions (checkout v7, upload-artifact v7, cache v6, buildx v4, build-push v7) are already on their latest major.

## Facts the phases rely on

### Node 26

Sources: nodejs.org/dist/index.json, the v25.0.0/v26.0.0 release notes, `deprecations.md@v26.13.1`.

- **Official builds:**

  | Build   | npm     | V8   | OpenSSL | ICU  | ABI |
  | ------- | ------- | ---- | ------- | ---- | --- |
  | 24.16.0 | 11.13.0 | 13.6 | 3.5.6   | 78.3 | 137 |
  | 24.22.3 | 11.19.1 | —    | —       | 78.3 | —   |
  | 26.13.1 | 11.20.0 | 14.6 | 3.5.9   | 78.3 | 147 |

  ICU is the same, so CI's Unicode data doesn't change. npm ≥ 11.16 (`allowScripts`) is bundled from Node 26.3.0.
- **`engines` accepts 26.13.1 everywhere:** all 235 ranges in the fully upgraded tree (lockfile-only resolve), with no peer warnings.
- **Removals and deprecations:** none affect us.
  - Removed: DEP0176 `fs.*_OK` (we use `constants.X_OK`) and DEP0147 `rmdir {recursive}` (`orchestrator/runs/launch.ts:224` calls `rmdir(dir)`).
  - DEP0205 `module.register()` is never triggered: tsx 4.23.15 and Playwright use `module.registerHooks`, and `--trace-deprecation --import tsx` prints nothing.
- **Undici 8:** `orchestrator/notify/post.ts` uses only `status`, `redirect: "manual"`, `AbortSignal` and a body reader, so it is unaffected.
  - HTTP/2 against Slack/Datator is now negotiated by default (unverified live).
- **Unchanged in 26:**
  - TTY `_handle.setBlocking` (`terminal/stream.ts`);
  - child_process, process-group and signal behaviour;
  - `Error.stackTraceLimit` (10).
- **apvm-napi** is a Node-API addon (v1–v4 functions): ABI-stable, and it loads on 26.13.1.
- **ssh2's optional `sshcrypto` addon fails to compile on 26** (mscdex/ssh2#1531, open).
  - ssh2 then falls back to pure-JS crypto, reported 5–13× slower.
  - CI (`npm ci --ignore-scripts`) and the local `node_modules` don't build it today.
- **Playwright 1.65** supports Node 22/24/26.
- **Measured:** `tsc` 6.0.3 passes against `@types/node` 26.6.6.
- **Measured: the unit suite passes on 24.22.3 and 26.13.1 with today's tree** (6511 passed, 130 skipped; P0).
  - One spec failed once under full-suite load and then passed 15/15 alone: `report-bundle.spec.ts`, "…killed through the bundle's own grace". That's a timing flake.
- **The default `node` is Homebrew's 26.13.1** (OpenSSL 4.1, ICU 79.1), not the official build.
  - The official builds are fnm's: `~/.local/share/fnm/node-versions/v{24.22.3,26.13.1}/installation/bin`.
- **Runner hosts:** no orchestrator is deployed yet. The AutoE2E server runs AutoE2E on nvm Node 18, and that stays as it is.

### npm (verified on npm 11.19.1, 11.20.0 and the npm 12.0.0 release notes)

- **npm 11.16+ reads `allowScripts`** but only **warns** about unlisted dependency scripts (`strict-allow-scripts=false`).
- **npm 12 blocks them by default** and defaults `allow-git` to `none`; our `.npmrc` sets `root`.
  - npm 12 also turns unknown CLI flags into errors and needs Node `^22.22.2 || ^24.15.0 || >=26.0.0`.
  - Node 26.13.1 bundles 11.20, so npm 12 is a separate global install.
- **`allowScripts` doesn't govern the root project's own `postinstall`** (`playwright install chromium`).
- **CI installs with `npm ci --ignore-scripts`** and installs Chromium itself, so CI never exercises `allowScripts`.
- **`npm install-scripts prune --dry-run` reports two dead entries:**
  - `fsevents@2.3.2` (not installed);
  - the APVM key (`github:…automation-plugin-version-manager: false`; its `prepare` runs `husky`). A misreport, not dead: see P2's Measured.
- **`allow-git=root` refuses a *changed* git pin:** `npm i` fails with `EALLOWGIT` (reproduced on 11.19.1 and 11.20.0).
  - `npm i --allow-git=all` once, or `npm i --package-lock-only`, works; `npm ci` with `root` then installs the new pin.

## Stack

Node 26.13.1 LTS, npm 12.2.3, TypeScript 6.0.3, Playwright 1.65.1 (Chromium 159), playwright-bdd 9.2.1, Allure 3.33.0, node-ssh 14.0.0 on ssh2 1.17.0, APVM `apvm-napi` 3.3.0.

## Decisions (recommended defaults, taken unless you say otherwise)

- **D1 — TypeScript 7: stay on 6.0.3.**
  - TS 7.0 has no compiler API, which `layering.spec.ts`, `__fixtures__/import-scan.ts` and `orchestrator/__fixtures__/import-boundary.ts` use.
  - typescript-eslint pins `typescript <6.1.0` (#10940).
  - A side-by-side alias works (`tsc` 8.4 s → 0.95 s), but brings a `.bin/tsc` ordering trap and an `ERESOLVE` warning.
- **D2 — string-width:** measure regional indicators as tmux draws them: flag 2, a lone indicator 1.
  - Spec rows change only where string-width 9 now equals what tmux drew (keycap `1⃣`: 2 → 1). Tmux's width is the spec's own invariant: never below what a terminal draws.
- **D3 — Node 26: in scope (P1).**
  - `engines` becomes `>=26.13.1`, the version everything was measured on; it is a security release.
- **D4 — pixelmatch 8: upgrade.**
  - No `@visual` scenario exists yet, so nothing calibrated can break.
  - Correct the docs that claim parity with Playwright's YIQ engine, and re-tune with the first real A/B scenario.
- **D5 — Docker local env: not in this plan.**
  - `nginx:1.27-alpine` is EOL, `wordpress:php8.3-*` gets security fixes only, and `mariadb:11.4` LTS is fine.
  - These should mirror the QA servers; ask before changing them.
- **D6 — npm 12: in scope (P2).**
  - It is the latest stable, and its default script blocking is the policy our `allowScripts` already declares.
  - Pin it with `devEngines.packageManager` (`npm`, `>=12.2.3`, `onFail: "error"`) and install it in CI (`npm i -g npm@12.2.3`).

## Implementing this plan (read before P0)

- **Start:**
  - Read `AGENTS.md`, this whole plan, and the Status table at the end.
  - Resume at the first phase that is not `done`.
  - Each phase gets its own Orca worktree and branch `chore/deps-pN-<slug>`, created from `develop` (branch named without the GitHub user).
  - Merge it into `develop`, push and wait for CI before the next phase starts.
- **Per phase:**
  1. Implement exactly that phase.
  2. Run the gates.
  3. Run an isolated audit of the phase's diff (a fresh reviewer on a copy of the tree), and verify every finding before fixing it.
  4. Do the live check if the phase's **Done** asks for one.
  5. Set the phase's Status row (`done`, date, one-line outcome) and remove detail from its section that no longer adds value.
- **Commits:** one Conventional Commit per phase (the user asked for this process), merged into `develop`; never a `Co-Authored-By` line.
  - Any test changed must say why in the commit message (P5 casts, P9 keycap row).
- **Repo rules that bite here:**
  - Code never references plans: no plan paths, phase names or `§` in code, comments or messages.
  - TSDoc on every function.
  - Exec errors name the program, never its arguments.
  - Keep AGENTS.md and the docs in sync (P11 sweeps, but each phase updates what it changes).
- **Live checks:**
  - Under `caffeinate -i`. First make sure no run is live: `ps` for `playwright`/`orchestrator`, and the newest `results.jsonl` has a `run.end`.
  - Run cells concurrently, never one after the other, and restore any site you change.
  - **BackWPup — preferred: `bwu2` (`free@nginx`) and `bwu3` (`pro@nginx`).** These are pre-approved and need no asking.
    - Their sites file is backed up at `~/.local/share/wp-media-e2e/backups/orchestrator-worktree-2026-10-19/sites.backwpup.json`.
    - Their cell names clash with the main checkout's `sites.json`, so use them from that phase's worktree, with that file copied to `src/projects/backwpup/config/sites.json` (`chmod 600`).
  - **BackWPup — main checkout:** `pro@nginx` (simple), `free@nginx` (bwu, the user's QA site) and `pro@apache` (AutoE2E's). Name them and ask the user before using any of these.
  - **WP Rocket:** the SSH twins only (`npm run env:cells:up`, then `E2E_CELL=<apache|nginx> npm run test:wp-rocket`).
    - The twins' unit specs run with `E2E_SSH_TWINS=1`.
    - Twins need Docker. If Docker is down, ask the user to start it; never start it yourself.
  - **Commands:**
    - `E2E_CELL=<cell> npm run test:<product>`;
    - add `-- --grep @noauth` for the smoke;
    - `npm run artifacts:warm -- --product=<p> --cell=<c>`.
- **Evidence:** the measurements in this plan were taken on 2026-11-18 on throwaway copies. Re-measure where a phase says so; don't trust a number without its source.

## Phases

- **Order:** phases run **one after another**, each on its own branch from `develop`, merged and CI-green before the next.
  - Each edits `package.json` and `package-lock.json`, and P3 and P8 both edit `transport-exec.ts`.
  - "Independent of" means the phase may be reordered or skipped without breaking another; it doesn't mean simultaneous.
- **Gates:** run with `PATH=~/.local/share/fnm/node-versions/v26.13.1/installation/bin:$PATH` (official build; from P2 on, with npm 12 installed there).
  - The gates are `npm run typecheck && npm run lint && npm run format && npm run test:unit`.
  - A timing spec failing once under load is re-run alone; it is never ignored.
- **Live:** a pinned run on real cells under `caffeinate -i`.
  - BackWPup on `bwu2`/`bwu3` (pre-approved), concurrently.
  - WP Rocket on the SSH twins (`E2E_SSH_TWINS=1`; ask the user to start Docker if it is down).
  - First check that no run is live (`ps` plus `results.jsonl`).

### P0 — Baseline · xs/easy · deps: — · independent of: —

Baseline on the untouched tree (6ec1573), official 24.22.3/npm 11.19.1 and 26.13.1/npm 11.20.0; later phases compare against it:

- **Gates:** green on both; unit 6511 passed, 130 skipped, 0 flaky (`report-bundle.spec.ts`'s known flake did not recur).
- **`npm audit`:** 18 (1 critical, 2 high, 14 moderate, 1 low), the same on both npm versions.
  - critical dompurify; high follow-redirects, markdown-it; low fast-xml-parser;
  - moderate: glob, minimatch and the packages pulling them (allure, `@allurereport/{ci,core,plugin-testops}`, eslint, `@eslint/config-array`, typescript-eslint and its 5 `@typescript-eslint/*`).
  - The picomatch advisory (GHSA-fc5q-39xc-vjpf) was withdrawn on 2026-11-18, so picomatch is no longer listed (the plan had counted 23).
- **`npm install-scripts prune --dry-run`:** the 2 dead entries, `fsevents@2.3.2` and the APVM key.

### P1 — Node 26 · s/medium · deps: P0 · independent of: —

Based on `develop` d603ce1: `.nvmrc` 26, `engines` `>=26.13.1`, `@types/node` ^26.6.6 (lockfile: only it and `undici-types` 8.9.0), `actions/setup-node@v7` (`ci.yml`, `setup-chromium`), `ssh-twins.yml` also triggered by `.nvmrc`; Node 26 in AGENTS.md, README, the orchestrator docs and help text, plus the ssh2 native-crypto note in `orchestrator.md`'s install. CI's ubuntu-24.04 image caches only Node 22/24, so each job downloads 26. Verified on official 26.13.1:

- **Gates:** Mac green, unit 6511 passed, 130 skipped. RemoteDesktopQA (Ubuntu 24.04): typecheck, lint, format:check pass; `test:unit` fails only environmentally, identically on 24.22.3 (Deferred → unit-suite robustness).
- **Live:** BackWPup pro@nginx 70/70 and free@nginx 53/53, concurrently on RemoteDesktopQA; WP Rocket twin-apache 4/4, twin-nginx 4/4, twin specs 122 passed (Mac). No Node-26 warning in the logs (no `DeprecationWarning`/`ExperimentalWarning`, no ssh2/cpu-features message).
- An earlier bwu3 interruption was not Node 26: BackWPup's content-copy put-back raced the live site (fixed in `fix/content-copy-put-back`, merged as d603ce1).

### P2 — npm 12 · s/medium · deps: P1 · independent of: P3–P10

- **Install npm 12:**
  - `npm i -g npm@12.2.3` into the official 26 (fnm).
  - In CI: one step in `ci.yml` and `setup-chromium/action.yml` after setup-node.
- **Pin it:** add `devEngines.packageManager` to `package.json` (`{ "name": "npm", "version": ">=12.2.3", "onFail": "error" }`).
- **Clean `allowScripts`:**
  - Run `npm install-scripts prune --dry-run` on macOS, then remove only the dead `fsevents@2.3.2` by hand.
  - The APVM key stays (prune misreports git dependencies: see Measured), and so do `esbuild@0.28.2`, `ssh2@1.17.0`, `cpu-features@0.0.10` and `fsevents@2.3.3`.
    - ssh2's script compiles nothing on 26 but must still be allowed, so its JS fallback is chosen the same way it is today.
  - Never prune on Linux: fsevents is macOS-only, so prune always lists `fsevents@2.3.3` there.
- **Prove the install on a clean clone:** `rm -rf node_modules && npm ci` (no `--ignore-scripts`).
  - The root `postinstall` must install Chromium, and npm must report no blocked script.
  - The APVM git pin must install with `allow-git=root`.
- **Docs:**
  - Fix the `.npmrc` comments (they predate npm 12 shipping).
  - State npm 12 in AGENTS.md's key technologies and in the orchestrator install docs (`npm i -g npm@12`).
- **Edge cases:**
  - `devEngines` is checked before `install`, `ci` **and `run`**, so `npm run …` fails on any machine still on npm 11. That includes the orchestrator's child commands, if they go through `npm` (grep `orchestrator/runs/commands.ts`).
    - Install npm 12 on the dev machine, in CI and on the runner (install docs) before this phase lands.
  - npm 12 errors on unknown or abbreviated CLI flags. Grep `package.json` scripts, `.github/`, `docker/` and the docs for `npm` invocations and confirm every flag is spelled in full.
- **Done:**
  - Gates pass.
  - The clean `npm ci` behaves as above.
  - CI passes.
  - On macOS after an install, `npm install-scripts ls` reports nothing and `npm install-scripts prune --dry-run` lists only the APVM key.
- **Measured** (2026-11-19, official 26.13.1, npm 12.2.3 installed globally into it):
  - **Prune misreports the git dependency.** Its answer depends on whether npm reads the hidden lockfile (`node_modules/.package-lock.json`, current after an install; neither lockfile flags apvm-napi's `prepare`) or the installed tree (no hidden lockfile, or `node_modules` touched after it):
    - hidden lockfile: `ls` none; prune lists the APVM key as having no install scripts;
    - tree, APVM key removed: `ls` reports `apvm-napi@3.0.0 (prepare: husky)` unreviewed, prune lists `fsevents@2.3.3`; with the key, `ls` none, prune `fsevents@2.3.3`;
    - a changed pin (`#cli/v3.2.0`, `npm install --allow-git=all`) without the key: npm warns APVM's `prepare` blocked; with it, silent (the audit's measurement). c3854a8 added the key for this.
    - So only `fsevents@2.3.2` (not installed) was removed; the key stays. On Linux prune also lists `fsevents@2.3.3` (not installed there). The lockfile has install scripts only in cpu-features, esbuild, fsevents 2.3.3, ssh2. `devEngines` leaves `package-lock.json` unchanged.
  - **Clean `npm ci`** (tracked files copied, fresh npm cache and `PLAYWRIGHT_BROWSERS_PATH`): exit 0, 341 packages; the root `postinstall` downloaded Chromium, FFmpeg and the headless shell; `prepare` set husky; no blocked-script warning. cpu-features built, esbuild's binary in place, ssh2's crypto build failed quietly (`bindingAvailable: false`, the JS fallback). APVM installed from its git pin under `allow-git=root`.
  - **Negative controls:** `esbuild` taken out of `allowScripts` → `npm warn install-scripts … esbuild@0.28.2 (postinstall: node install.js)` blocked (a warning, exit 0); `--allow-git=none` → `EALLOWGIT`; a changed pin (`#v3.3.0`) under `root` → `EALLOWGIT` on npm 12 too (P4's `--allow-git=all` holds).
  - **npm 11 (11.19.1, 11.20.0) in the checkout:** `ci`, `install`, `run`, `exec`/`npx`, `ls`, `pkg`, `config get` all fail `EBADDEVENGINES`; `--version` and `npm i -g npm@12.2.3` work; `--force` bypasses with a warning.
  - **CI:** setup-node's `cache: npm` (and its automatic cache, which `devEngines.packageManager` turns on) runs `npm config get cache` in the checkout with Node 26's own npm 11 (11.20.0 since 26.11.0; 11.12.1–11.19.1 before, nodejs.org/dist/index.json), which fails, and setup-node fails the step (v7 source). So both places use `package-manager-cache: false`, then `npm install --global npm@12.2.3`, then `actions/cache@v6` on `~/.npm` keyed by the lockfile.
  - **Flags:** every npm/npx flag in scripts, `.github/`, `docker/`, `.husky/` and docs is spelled in full and accepted by npm 12 (`--ignore-scripts`, `--global`/`-g`, `--silent`, `--dry-run`, `--no-git-tag-version`, `--allow-git=…`, `--package-lock-only`, npx `--no-install`). An abbreviation (`--ignore-script`) now exits 1 with `Invalid abbreviated flag`; an unknown flag, such as `--once`/`--task=x`/`--config=c.json` before `--` in `npm run orchestrator`, exits 1 with `EUNKNOWNCONFIG` from npm itself (only `--dry-run` reaches the script, refused as before). The orchestrator's runs never go through npm (`runs/commands.ts`).
  - **npm 12 prints script banners** as `npm notice run …` on stderr (npm 11: `> …` on stdout); nothing parses them. `npx` prints one too, its arguments line by line, so `cells.sh`'s `npx --no-install tsx --eval '<script>'` echoed the whole script: it passes `--loglevel=warn` (errors and the child's exit code kept).
  - **`.node-version`** (fnm and other managers read it) still said 24: now 26, like `.nvmrc`; no other file pins Node.
  - **npm 11 first on `PATH`** (e.g. Homebrew's Node 26, whose own npm is 11.20.0) fails every npm command in the checkout: `.husky/pre-commit` ran `npx lint-staged` and blocked commits, so it runs `lint-staged` (husky 9 puts `node_modules/.bin` on `PATH`; a commit in a scratch clone with Homebrew's npm first passed and ran ESLint). `cli.spec.ts`'s `npm run` tests use `PATH`'s npm, as an operator does (the npm beside `process.execPath` would not help: Homebrew's is npm 11 too); AGENTS.md and the README state npm 12 first on `PATH`.
  - **`npm audit`:** 18 (2 high, 14 moderate, 2 low, no critical): dompurify is now rated low by the advisory data, identically on npm 11.19.1, so not an npm 12 change.

### P3 — Low-risk runtime bumps · xs/easy · deps: P1 · independent of: P2, P4–P10

- `npm i -D execa@10.2.1 commander@15.1.0`.
- **execa 10.2:** going over `maxBuffer` now kills the child with `killSignal`.
  - `fromExeca` checks `isMaxBuffer` before `signal` (`src/common/wp/transport-exec.ts` ≈ :202), so the outcome is unchanged.
  - Re-measure, then fix the stale comment at ≈ :195-201 ("still reports the child's own exit code — measured").
- **commander 15.1:** only deprecates `storeOptionsAsProperties` and `combineFlagAndOptionalValue`, which we don't use.
- **Done:** gates pass and the comment states the newly measured behaviour.
- **Measured** (2026-11-19, official 26.13.1; both still npm's `latest`; lockfile: only these two change, `pretty-ms`/`yoctocolors` ranges in execa's entry, installed versions unchanged):
  - **maxBuffer probe** (raw execa, `reject: false`, `maxBuffer: 1000` unless noted; 10.0.1 → 10.2.1), always `isMaxBuffer: true`:
    - writes then exits 0 / 2: exit code kept on both;
    - writes, then `sleep 3; exit 2`: 10.0.1 exit 2 after 3 s; 10.2.1 `SIGTERM`, usually still 3 s (the `sleep` grandchild holds stderr, and execa destroys only the overflowing stdout, then waits for the other pipes; ~11 ms when SIGTERM lands before `sh` starts `sleep`), 15 ms with `exec sleep 3`;
    - a descendant holding only stderr delays the result (~2 s for `sleep 2`), only stdout not (~24 ms);
    - SIGTERM ignored (`trap '' TERM; exec sleep 8`): `SIGKILL` at ~5 s (`forceKillAfterDelay` defaults to 5 s); only the direct child is signalled (`killDescendants` false);
    - `yes` (small and default cap): `SIGPIPE` on both (the broken pipe comes before the kill);
    - spec cases at the default cap (`yes | head -c 100000001` exit 0; `yes` `SIGPIPE`): unchanged.
  - So `fromExeca`'s outcome is unchanged (`isMaxBuffer` first); comment rewritten, `wordpress-automation.md` names `SIGTERM` too. New `exec.spec.ts` case "from a command still running" (`…; exec sleep 60`): passes on 10.2.1 in 3.8 s; on 10.0.1 its 15 s deadline fails it ("waited on, not ended").
  - **execa 10.1.0–10.2.1 notes, against our options** (`reject: false`, `stdin: "ignore"`, `cwd`, `timeout` in `preflight.ts`; no `all`, `killSignal`, `forceKillAfterDelay`, `cancelSignal`, `maxBuffer`, `encoding`, `extendEnv`, sync methods): only "invalid `timeout`/`forceKillAfterDelay` values fixed" and wrong-typed options now refused touch them, and ours are valid literals. `orchestrator/runs/leader.ts`'s `maxBuffer` is `node:child_process`'s.
  - **commander 15.1.0:** no deprecated API used; its fixes (negative-number `E` exponent, Unicode variadic placeholders, inspector ports, help groups, `getOptionValueSourceWithGlobals`, `InvalidOptionArgumentError` undeprecated) touch nothing in `orchestrator/command.ts` (`command.spec.ts`'s verbatim messages pass).
  - **Gates:** green; unit 6619 passed, 134 skipped, 1 load flake passing alone 3×: `job-runs.spec.ts:284` (`expect.poll`'s 1 s timeout abandons an in-flight stub `wp`, which writes its count file while `afterEach` removes the folder: `ENOTEMPTY`; not execa's).

### P4 — APVM 3.3.0 · s/medium · deps: P1 · independent of: P2, P3, P6–P10

- **Pin** `github:wp-media/automation-plugin-version-manager#v3.3.0` (tags lost the `cli/` prefix), changed once with `npm i --allow-git=all` (`root` → `EALLOWGIT`); `npm ci` under `root` installs it.
- **Done:** gates and `npm run artifacts:warm` pass; an offline commit-pin cache hit works; live, a fresh BackWPup (private source) and a fresh WP Rocket build pass the artifacts setup.
- **Measured** (2026-11-19, official 26.13.1, npm 12.2.3; sources: the `cli/v3.0.0...v3.3.0` commits — the 3.1.0–3.2.0 release notes are compare links only and v3.3.0's cover only `cli/v3.2.0...v3.3.0`; the commits add the CLI-only update checker 55188a2b and the WP Rocket zip fix d04cb20c — plus the tag's `crates/` and the installed package):
  - **Pin:** lockfile changes only apvm-napi (3.3.0, `#f229113…`, the tag's commit). Clean `npm ci`: no blocked script; `install-scripts ls` none, `prune --dry-run` only the APVM key (3.3.0 still has `prepare: husky`).
  - **API:** `index.d.ts` 3.0.0 → 3.3.0 only turns the three `const enum`s into runtime `enum`s (same members) and adds cache APIs (`ApvmCache`, `cache()`, `cacheStatus()`, clean/gc/verify); every type we import is unchanged; `engines` still `>=22.22.1`. Specs stay type-only (the `apvm.spec.ts` comment says why).
  - **WP Rocket zips:** `wpr.rs` now excludes `php*`/`package*` only at the plugin root (`*/php*` had dropped nested vendor trees). A fresh build of `develop` 9f29447 vs the cached 3.0.0 zip: 1938 vs 1935 entries (+ `vendor/cloudflare/cf-ip-rewrite/phpunit.xml.dist`, `vendor/wp-media/plugin-family/package{,-lock}.json`), new SHA-256 (cached `d5ae3d10…`; fresh `2594574d…` in a throwaway cache, `0dba886e…` in the live run), version 3.24.2-alpha1; `verifyArtifact` passes. Cached zips are served as they are.
  - **Refs:** `commit:` accepts only a SHA (`commit:develop` → `Invalid commit SHA`); bare `develop` still resolves. Our pins (`commit:<40 hex>`) and defaults (`develop`, `tag:latest-stable`) are unaffected.
  - **Empty stdin** for build tools (`Stdio::null()`): nothing of ours feeds it; composer and npm builds pass.
  - **Logs to stderr, `NO_COLOR=`:** CLI-only; the addon installs no `tracing` subscriber (`RUST_LOG=trace` warm: stderr empty). Our lines come from `onProgress` through injected printers; our colour rule already treats an empty `NO_COLOR` as unset.
  - **Tokens:** env tokens taken as given; `gh auth token` output must be one `[A-Za-z0-9_]` value with a known prefix (`github_pat_` accepted; `…@evil`, `Token: gho_…`, unprefixed → no token, so `assertToken`'s message).
  - **V257 re-run:** 14 failing builds (online and offline; real, fake `ghp_`/`github_pat_` and `gh` tokens; private and public repos): no token value or token/`user@` shape in any error (own properties, stack included) or event.
  - **`APVM_CACHE_DIR`** is read at each `create()`: an instance keeps its dir. No repo file sets it; `getApvm()` creates lazily after `.env` loads.
  - **One addon copy per process** (`single_copy.rs`, keyed on `globalThis`; a second `.node` copy is refused): one apvm-napi in the tree and one value import (`apvm.ts`); warm and the artifacts setup never hit it.
  - **Offline** (sandbox-exec, network denied): commit pins plus versions → cache hits, exit 0; WP Rocket without a version → clone fails; `release:` → GitHub API error. `pin.ts`'s note now names 3.0.0 and 3.3.0.
  - **Gates:** green; unit 6618 passed, 134 skipped, 2 load flakes passing alone 3× (`ssh-server.spec.ts:101`, `launch.spec.ts:579`; not APVM).
  - **Live** (official 26.13.1 + npm 12.2.3, fresh APVM cache per run): BackWPup pro@nginx built fresh (`develop` a98abb68, 9.99.99) 70/70, free@nginx built fresh 53/53 (RemoteDesktopQA, concurrent); WP Rocket twin-apache built fresh `develop` 9f294470 (3.24.2-alpha1) and `tag:latest-stable` v3.24.1, 4/4. No token text in logs or reports.

### P5 — Lint and format toolchain · xs/easy · deps: P4 · independent of: P2, P3, P6–P10

- `npm i -D eslint@10.15.0 typescript-eslint@8.73.0 globals@17.14.0 prettier@3.10.1 lint-staged@17.6.1`.
- **`no-unsafe-enum-assignment`** (new in 8.71.0, `strictTypeChecked`) flagged exactly the 3 casts in `apvm.spec.ts`/`warm.spec.ts`: now `as unknown as JsBuildPhase`, never the enum members (a value import loads the native addon and breaks `apvm.ts`'s "only importer" rule). Test code only, nothing asserted changes.
- **Measured** (2026-11-19, official 26.13.1, npm 12.2.3; all five still npm's `latest`; sources: GitHub releases, prettier's CHANGELOG and 3.10 blog post):
  - **Lockfile:** the five plus their own trees only: `@eslint/config-array` 0.23.6, ten `@typescript-eslint/*` 8.73.0, minimatch 11.0.9 nested under eslint, config-array and typescript-estree, `ignore` 7.0.16, `semver` 7.8.6, `string-argv` 0.4.0; no install script. New: `@isaacs/nonrecursive-glob-match` 1.1.0, pulled by minimatch 11.0.9 (SLSA provenance); it has no provenance and no `repository` field (sole maintainer isaacs, no dependencies, no install hooks).
  - **Lint:** only those 3 errors; 8.73.0's `no-unsafe-class-instance-assignment` (`strictTypeChecked`) flags nothing; a probe file still trips every gate it tried (`waitForTimeout`, `networkidle`, `src/common` → `src/projects`).
  - **Changelogs vs our config:** no option, default or config-API change in eslint 10.12–10.15 (rule fixes; minimatch floor raised), typescript-eslint 8.71–8.73 (new rules above; lazy rule loading; experimental `tsgo` backend, see Deferred; `typescript` peer still `<6.1.0`), globals 17.13–17.14 (data; `globals.node` identical), prettier 3.9.10–3.10.1 (formatting fixes; 0 files reformat). lint-staged 17.6.0 stages every tracked file a task modifies (ours edit only staged files) and runs nested task arrays in parallel (ours are flat).
  - **Hook** (real commits in a scratch clone, husky + `lint-staged` 17.6.1): staged `.ts`/`.json` committed formatted; a partially staged file's unstaged hunk and an unrelated unstaged file stayed unstaged; an ESLint error blocked the commit and restored the index.
  - **Audit:** 18 → 10 (2 low, 6 moderate, 2 high): eslint, `@eslint/config-array`, typescript-eslint and its 5 listed `@typescript-eslint/*` gone; minimatch 10.2.6 stays only under allure's glob (P7).
  - **Gates:** green; unit 6620 passed, 134 skipped, no flake.

### P6 — Playwright 1.65.1 · m/medium · deps: P1 · independent of: P2–P5, P7–P10

- `npm i -D @playwright/test@1.65.1`; a targeted `npm i` runs no root `postinstall`, so Chromium 159 (revision 1255) came only from `npm run setup` (`npm ci`/`npm install` run it).
- **Measured** (2026-11-19, official 26.13.1, npm 12.2.3; 1.65.1 still npm's `latest`; sources: GitHub releases v1.64.0–v1.65.1, the installed bundles diffed against 1.63.0, probes run on both):
  - **Lockfile:** only `@playwright/test`, `playwright`, `playwright-core` (1.63.0 → 1.65.1); range `^1.65.1`.
  - **`screen` (breaking, 1.64):** presets now apply `screen`, an option fixture new in 1.64; on 1.63 a file overriding it does not load, so 1.64 is the floor (AGENTS.md, `wordpress-automation.md`). `DeviceProfile` gains `screen` (sixth override in `fixtures.ts`), read by `presetScreen` (`devices.ts`; `DeviceDescriptor`'s type omits it and 92 of 207 presets lack it); `observedDevice` asserts `window.screen` (Desktop Chrome 1920×1080, Pixel 5 393×851). Without the override the `@mobile` smoke fails.
  - **Transpiler:** Babel, not esbuild (tsx's): `useDefineForClassFields` true for `esnext` (`tsc` checks define semantics, TS2729); `tsconfig.json` and AGENTS.md corrected.
  - **Internals the suite relies on** (`PLAYWRIGHT_NO_COPY_PROMPT`, `PW_TEST_REPORTER`/`printsToStdio`, `_mode`, `PWTEST_WATCH`, `PLAYWRIGHT_HTML_TITLE`, `captureGitInfo`, trace `snapshots.dom`, `forceRegExp`/`_grepTitleWithTags`, retries, SIGINT/worker stop, the produced environment, `TEST_WORKER_INDEX`, output-folder removal, graceful-fs marks): identical to 1.63.0 but bundler renames. `filterProjects` drops `default: false` projects only without `--project` (none set; `cell-pin.spec.ts`'s named path unchanged). No `RenderDocument` in Chromium's disabled features. By probe, identical: step trees, the locator-timeout and basic-auth `goto` messages, `globalTimeout`'s errors.
  - **Other release notes** (grep): nothing used (frame locators, `updateSnapshots`, JSX, cookie APIs, `proxy`, request `params`, `.css` imports, blob reporter, CJS, `retryStrategy`).
  - **Docker image** (`@visual`): v1.65.1's `Dockerfile.noble` ships Node 26 (NodeSource `node_26.x`; 24 up to v1.64.1); README states the tag and Node.
  - **Gates:** green; unit 6625 passed (+5 `devices.spec.ts`), 134 skipped; every `*.run.spec.ts` on Chromium 159. Smoke (`@noauth`, every cell): BackWPup 4/4, WP Rocket 6/6.
  - **Live** (Chromium 159 rev 1255): BackWPup pro@nginx 70/70 (52.0 min), free@nginx 53/53 (33.9 min), concurrent on RemoteDesktopQA, as long as on `develop`; WP Rocket twin-apache 4/4, twin-nginx 4/4 (concurrent, Mac twins); `@mobile` and desktop device scenarios passed. No retry, `[page-loads]`, settle-request, wp-login or inert-wait timeout. Twin unit specs 122/123: `housekeeping.ssh-twins.spec.ts:406` exceeded `withTwin`'s lock wait under 6 workers, passed alone (Deferred).

### P7 — Allure 3.33 · s/medium · deps: P1 · independent of: P2–P6, P8–P10

- `npm i -D allure@3.33.0 allure-playwright@3.15.0` (Allure needs Node ≥22.18), plus `overrides: { allure: { glob: "^14.0.6" } }`; comments in `allure-analytics.ts` ("through 3.33.0") and `allure-history.ts` ("3.18 to 3.33") updated.
- **Measured** (2026-11-19, official 26.13.1, npm 12.2.3; both still npm's `latest`, allure 3.22.1 → 3.33.0 has no release between; sources: GitHub releases allure3 v3.19.0–v3.33.0 and allure-js v3.13.0–v3.15.0, the installed 3.18.0 and 3.33.0 packages diffed, real CLI runs; results from real `@noauth` smoke runs on the placeholder `wp-rocket/apache`, on 3.12.2 and 3.15.0, with and without `--trace on`):
  - **Lockfile:** `allure` and 28 `@allurereport/*` 3.18.0 → 3.33.0, plus new `plugin-metrics`, `plugin-xray` and `@marcbachmann/cel-js` 8.0.0 (MIT, sole maintainer, no dependencies or install script, no provenance); `allure-playwright`/`allure-js-commons` 3.15.0. No new install script; `allowScripts` unchanged.
  - **Unchanged, by diff and real output:** the analytics template block (byte-identical in awesome and dashboard; `analyticsEnable: true` still hard-coded; `ALLURE_NO_ANALYTICS` still reaches only allure2); `generate`'s `-o`, `-c`, `--name` (new: `--clean`, `--host`); `open <report>` serves a folder holding a `summary.json` and binds every interface by default, as 3.18 did; the output layout (`awesome/`, `dashboard/`, `index.html`, `test-results.json`; single file: `index.html` + `summary.json`); `allurerc.mjs` loads, with categories and the `currentStatus`/`statusDynamics` layout drawn; a broken history line still fails `generate` (exit 1); a failed append still only logs. allure-playwright 3.15.0's results match 3.12.2's exactly (keys, `historyId`/`testCaseId`, labels, step trees, `application/vnd.allure.playwright-trace` in a `trace` step); `strip` removes all 5 real traces.
  - **History:** lines are keyed by `retryHash` = `<testCaseHash>.<parametersHash>` (`.<environmentHash>` only with named environments, which we have none of). That is the key 3.18 already used (`historyId` = `<testCase.id>.<md5(params)>`), so 3.33 reads 3.18 lines directly; the `legacyHistoryId` path (allure-playwright's `<testCaseId>:<hash>`) is never needed. Measured: two runs reported with 3.18 (one scenario failed, then passed), then a 3.15.0 run (it failed again) with 3.33 through `report:allure`: 3 trend points, that test's history `[passed, failed]`, flaky (3.33's detector: ≥ 2 status changes), transition `regressed`, in "Flaky tests", no test new — identical to the same three runs reported with 3.33 only. **No reset needed.** New lines add `retries`, `flaky`, `transition`, `retryHash` (no `historyId`); `allure-history.ts` still needs only `timestamp` and one line per generation.
  - **Audit:** 10 (2 low, 6 moderate, 2 high) → 6 moderate with the bump alone (dompurify, follow-redirects, markdown-it, fast-xml-parser gone) → **0** with the override. glob 14 (minimatch 11, `Matcher` instead of `RegExp`; renames, `debug` removed, `ignore` rooted like patterns) takes every option Allure passes (`nodir`, `dot`, `absolute`, `mark`, `windowsPathsNoEscape`, `cwd`, a relative `ignore`); it pulls minimatch 11.0.9 and path-scurry 3.0.0, deduped with ESLint's (the separate minimatch override is not needed). Kept: the Allure specs (real CLI included), `report:allure` (default newest run; the 3.18-history cell above) and `allure open` pass with it. Drop it once Allure depends on glob ≥ 14.0.2.
  - **Server on loopback** (audit F1): `open` bound `*:<port>` (lsof; reachable from the LAN), and a report keeps traces (session cookies; BackWPup's restore markup holds the DB password). `allurerc.mjs` sets `host: "127.0.0.1"`, which `open`, `serve` and `generate --open` read (`--host` overrides), so a manual `allure open -c allurerc.mjs` is covered too: now `127.0.0.1:<port>` only, URL `http://127.0.0.1:<port>`, LAN refused. A `keep` bundle is served outside the checkout (no config), so its landing command is now `npx --yes allure@3.33.0 open --host 127.0.0.1 allure` (`ALLURE_SERVE`, `bundle-manifest.ts`; exact version, so npx never takes an older Allure without `--host`; a spec keeps it equal to the installed one): from an empty folder with a fresh npm cache it fetched 3.33.0 and listened on `127.0.0.1` only. README/AGENTS/`orchestrator.md`: remote use via `ssh -L`. Specs: the config's `host`, the command.
  - **No git facts** (audit F2): with no CI detected, Allure's `local` detector runs `git` from the work folder (inside the checkout) and wrote the origin URL with its credentials, branch and commit into `index.html`, `awesome/index.html` and both `summary.json`. `allureEnv` now sets `GIT_DIR=/dev/null/not-a-repository` (`NO_GIT_DIR`): a scratch repo with a `ghp_FAKE` token origin on `feature/secret-x` leaves none of token, branch, SHA or repository in any file, exit 0, the report renders. Nothing of ours reads Allure's git fields (the facts line comes from `run-facts`). Specs: the env, the path, and a real-CLI generation inside such a repo (fails without the fix). CI detectors (GitHub etc.) still read their env vars: repository, branch, commit, no credentials.
  - **Gates:** green; unit 6625 passed, 134 skipped, no flake; after the audit fixes the reporting specs (`allure*`, `report-bundle*`, `bundle-*`) plus `orchestrator/runs/bundle`, `notify/slack`: 355 passed.

### P8 — node-ssh 14 · m/hard · deps: P1 · independent of: P2–P7, P9, P10

- `overrides: { "@types/ssh2": { "@types/node": "$@types/node" } }` **first**, then `npm i -D node-ssh@14.0.0 @types/ssh2@^1.15.6` (in the other order the nested `@types/node` 18.19.130 stays in the lockfile as `invalid`). Lockfile: `ssh2` still 1.17.0; `make-dir`, `semver` 6.3.1 and node-ssh's nested `is-stream` gone; no new install script; one `@types/node` (26.6.6).
- **#132:** `execCommand` now rejects where 13.x resolved `code: null`; without the fix exactly `exec.ssh.spec.ts:221` and `:283` fail. `sshExecFailure` (`transport-exec.ts`) sorts a rejection, every message without argv or `cause` (ssh2's exec errors are fixed strings or the server's channel-open text); `failureReason` = a non-empty string `code`, else the message:
  - ssh2's `Not connected` → returned unchanged, so `withConnection` retries;
  - a recorded loss (node-ssh's `error` listener runs before ours, and `fail` rejects asynchronously) → `lostConnection`'s `lost (<reason>) while "<program>" was running`;
  - a client no longer `isConnected()` → `closed before "<program>" was confirmed started (<reason>), so whether it ran is unknown`, never retried: a clean close after the exec request fails it as `Unable to exec` (measured: the command had run). Except `No response from server`, which only a channel still opening gets, before the exec request is sent;
  - anything else (a refusal on a live connection) → `"<program>" could not run over SSH on <site>: <reason>`.
  - `code === null` kept: a disposed connection, or a server closing the session, still resolves with neither status nor signal.
- **`noBuffer: true`:** node-ssh skips its own string copy (stdout/stderr come back `""`), so `ERR_OUTPUT_TOO_LARGE` cannot reject; `onStdout`/`onStderr` as before. The ssh path has no output cap of its own (only execa's `maxBuffer` on local/docker).
- **Types:** `ErrorEmitter`, `Connect`, `Observable` removed (`ssh.connection` is `Client | null`; prototype patches typed with `Config`/`SSHExecCommandOptions`, one `unbound-method` disable each: called with `.call(this)`); the test server uses `@types/ssh2`'s server types, still loading ssh2 itself; `OPEN`'s `attrs` read as `Partial<Attributes>` (typed complete, no `mode` from `fastPut`).
- **Other 14.0 changes:** `isConnected()` false until `ready` (we pool only after `connect` resolves); `dispose()` nulls the connection at once, ends it after ≤ 2 s of pending SFTP closes; `TCP_NODELAY` set; `cwd` now `cd … || exit`, and timeouts/`AbortSignal`/`atomic`/`skipUnchanged`, unused.
- **Specs:** the test server's `refuseExec` and `dropOnExec` (records the command, then `conn.end()` unanswered) pin both paths (exact message, no `cause` or secret, sent once, the connection reused or replaced); `noBuffer`/`noTrim`/no `cwd` asserted; `sshExecFailure` and `failureReason` cases (+16).
- **Gates:** green; unit 6639 passed, 134 skipped (flakes: Deferred); twin specs 123 passed.
- **Connection killed mid-command, live** (twin-apache, `sh -c 'sleep …' e2e --key=SECRET-…` through `execAsTransport`): `SIGSTOP` on the session's `sshd: ubuntu@notty` → after 40.1 s `[wp/exec] the connection to ubuntu@127.0.0.1:2210 was lost (Keepalive timeout) while "sh" was running, so how it ended is unknown.`, no `cause`, no secret. `SIGKILL` on it → sshd closes the session cleanly: 1.5 s, the "neither an exit status nor a signal (its channel closed)" message. `SIGKILL` on `[priv]` alone: the session lives on. A reset (`ss -K`) is refused in the container (no `CAP_NET_ADMIN`); `read ECONNRESET` is pinned by `exec.ssh.spec.ts:221`.
- **Live** (2026-11-19, Node 26.13.1, npm 12.2.3): BackWPup pro@nginx 70/70 (45.5 min; `develop` 52.0), free@nginx 53/53 (29.8; 33.9), concurrent on RemoteDesktopQA, healthcheck exit 0; WP Rocket twin-apache 4/4, twin-nginx 4/4 (Mac). No lost, could-not-run, `Not connected` or SFTP error line; teardown not slowed by `dispose`'s SFTP wait. Run on the build before the "closed before confirmed started" branch, which only a rejected exec reaches (0 in all four runs); specs cover it.

### P9 — string-width 9 · s/medium · deps: P1 · independent of: P2–P8, P10

- `string-width` `^9.0.0` (2026-11-11; Node ≥ 22; deps already at its ranges). Lock diff: that package only; only importer `layout.ts`.
- **What v9 changed** (vs 8.3.0, Node 26 probe): over every code point, only the 26 regional indicators (1 → 2), 12 prepended concatenation marks (U+0600–0605, 06DD, 0890, 0891, 08E2, 110BD, 110CD; 0 → 1) and lone surrogates (0 → 1, read as U+FFFD; `withoutControls` makes text well-formed first). Over ~363k probed clusters the only decreases: the 12 unqualified keycaps `[#*0-9]`+U+20E3 (2 → 1), all drawn 1 in tmux. On `layout.spec.ts`'s 35 rows: 4 changed, regional indicators (flag 4, lone 2, three 6 vs tmux 2, 1, 3; `cutToWidth`'s flag case too) and the keycap (1, tmux 1).
- **Fix (D2):** `codePointWidth` counts a regional indicator (U+1F1E6–U+1F1FF) 1, alone and in the sum: flag 2, lone 1, three 3.
- **Basis:** keycap 2 → 1 and lone indicator 1 rest on tmux 3.8's drawn columns (other terminals not measured); accepted per D2 and the invariant "never below what a terminal draws", as measured in tmux.
- **Rows added** (tmux 3.8, `en_US.UTF-8`, 2026-11-19): flag between letters 4, two flags 4, A and Z indicators 1, U+1F200 2, indicator + VS16 2; `cutToWidth` at 1 column keeps a lone indicator, drops a flag. Mutations of the rule (removed, either path alone, range to U+1F200) each fail the spec.

### P10 — pixelmatch 8 · xs/easy · deps: P1 · independent of: P2–P9

- `npm i -D pixelmatch@8.0.0`.
- **API:** unchanged, and it ships its own types; `output` is typed `… | null | undefined`.
- **Metric:** YIQ is replaced by OKLab/HyAB; `threshold` keeps its 0–1 scale.
- **Docs:** fix the parity claims at `src/common/visual/compare.ts:7-9` and `src/common/config/visual.ts:4-7`.
- **Open obligation:** re-tune `DEFAULT_PIXEL_THRESHOLD` with the first real `@visual` scenario.
- **Spec:** add a near-colour pair to `compare.spec.ts` (indistinguishable colours give 0 diff), so the metric's behaviour is pinned.
- **Done:** gates pass.

### P11 — Docs sync and final audit · s/easy · deps: P1–P10 · independent of: —

- **Docs:**
  - AGENTS.md: key technologies (Node 26, npm 12), the APVM pin, the Playwright floor (does `screen` make 1.64 the floor?).
  - `docs/architecture/*` and `docs/guides/*`.
  - A `CHANGELOG.md` entry for the Node ≥ 26.13.1/npm 12 requirement under the next release.
  - The version-pinned rows in `e2e-modernization-plan.md` and `orchestrator-plan.md`.
- **Audit:** an isolated full audit of the diff; verify every finding before fixing it.
- **Final runs**, all on official 26.13.1 + npm 12:
  - a full live run on both products, on concurrent cells;
  - `npm run orchestrator:soak`;
  - one real Slack/Datator post (Undici 8, HTTP/2).
- **Close-out:**
  - Record the final `npm audit` against P0's 18.
  - Trim this plan to its decisions and open obligations.
- **Done:** all green, the docs match the code, and the work is ready for review and commit.

## Risks and mitigations

| Risk                                                                 | Mitigation                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| npm 12 blocks a needed dependency script, or rejects a flag          | P2 runs a clean `npm ci` without `--ignore-scripts`; greps every `npm` invocation; CI runs npm 12           |
| The APVM pin change fails with `EALLOWGIT`                           | P4 uses `npm i --allow-git=all` once; `npm ci` with `root` proves the result                               |
| Local Homebrew Node differs from CI's official build                 | Gates use fnm's official 26.13.1; CI is the reference                                                      |
| ssh2 pure-JS crypto is slower on 26                                  | Already today's state in CI and local; documented for runner hosts; revisit when #1531 closes               |
| node-ssh 14 changes SSH failure messages                             | P8: the two message specs fail without the fix (measured); a new spec for other errors; twins plus a forced drop live |
| Chromium 159 or `screen` changes layout for `@mobile`/BackWPup        | P6 live `@plugin` on both products; `observedDevice` asserts the screen                                   |
| APVM 3.3 changes the WP Rocket zip content and SHA, stderr logs, tokens | Expected; the artifacts setup verifies the new zip; P4 checks each behaviour change and re-runs V257  |
| Allure history discontinuity                                         | Measured: none (P7: 3.33 keys history as 3.18 did)                                                         |
| Undici 8 HTTP/2 against Slack/Datator                                | The notify specs plus one real post in P11                                                               |
| One phase's failure hides another's                                  | Sequential phases, one install each, gates after each; P0 baseline on both runtimes                        |
| Lockfile drift                                                       | Targeted `npm i` per phase; review the `package-lock.json` diff for unrelated moves                        |

## Deferred (open obligations)

- **TypeScript 7:** wait for 7.1 stable plus typescript-eslint support (#10940). The three TS-API spec helpers then move to the 7.1 API.
  - typescript-eslint 8.73.0 adds an experimental `tsgo` backend (optional peer `@typescript/native` ≥ 7.1.0 dev/beta); still experimental.
- **Docker local env images (D5).**
- **ssh2 native crypto on Node 26** (mscdex/ssh2#1531): once fixed, drop `orchestrator.md`'s install note.
- **SSH loss wording:** when an `error` event drops the connection before the command started (channel still opening, or exec reply pending), the recorded-loss message still says `lost (…) while "<program>" was running`, though whether it started is unknown (found by reading, not measured; pre-existing wording); a fix would track the start via node-ssh's `onChannel`.
- **pixelmatch threshold re-tune** with the first `@visual` scenario.
- **Plain output:** under `E2E_OUTPUT=plain`, Playwright's own "To open last HTML report run" line still carries ANSI colour when piped through `tee` (seen on `develop` too, not from P4).
- **Unit-suite robustness** (found on RemoteDesktopQA, Ubuntu 24.04; not dependency issues, same on Node 24):
  - umask 0002 (Ubuntu's default for a user with its own group) fails 23 orchestrator specs (`state/` counter, run-retention, orphans; `runs/launch`): fixture folders come out 775, which the code rightly refuses as group-writable; the specs should set their own umask or modes.
  - `src/common/__fixtures__/temp-dir.spec.ts` (2 tests) fails when the checkout itself lives under the OS temp folder (`/tmp/…`).
  - `src/projects/wp-rocket/support/config-edits.php.spec.ts` (9 tests) fails on PHP 7.4: `__fixtures__/wp-rocket-edits-harness.php:136` uses `str_contains()` (PHP ≥ 8); polyfill it, or skip with a reason when the local PHP is older.
  - `src/projects/backwpup/support/content-copy-put-back.spec.ts:474` ("the old put-back … fails while the site writes") once did not reproduce the old failure there: its reproduction is timing-dependent.
- **Flaky under load:** fixed on `fix/unit-flakes` (load reproduced in a 3-CPU container, 12 busy loops, 12 workers).
  - `launch.spec.ts:529`/`:579` (36/40 failed): the fake's child lived a fixed time while the group wait counts 20 ms polls, which stretch under load; the child now ends on a file the test writes from `onStuck` (`childUntil`; `:508` too). 60/60 pass.
  - `ssh-server.spec.ts:101`/`:132` (4/220 on the Mac): not a cold connection; a fake-`sudo` call spawns ~30 processes, 0.2–1.5 s on macOS, against the shared server's 1 s limit. Shared server at the default 20 s; only the time-limit test gets its own 1 s server. 220/220.
  - `job-runs.spec.ts`: the abandoned stub call's write races `rmSync` (measured: 50/200 `ENOTEMPTY` with a writer); `afterEach` renames the folder aside, then removes it with retries (0/200).
  - `withTwin`: the 10 min bound now applies to one holding and restarts on each hand-over (polling is not FIFO: a waiter can lose many). Twin specs at 3 workers: holds up to 118 s, a waiter 122 s over 11 hand-overs, so 6 workers queueing ~5 deep could pass 600 s. 124 passed (28.5 min).
  - `ssh-twins.yml`: "Twin specs" took 21.4–34.8 min over 22 passing runs under the 35 min limit, and one timed out at 35, so its timeout is now 50 min and the job's 85. Possible speed-up: the WP Rocket lifecycle file (~16 min, 16 tests) runs alone at the end on one worker. Parallel mode would need concurrent APVM resolution shown to be safe.

## Status

| Phase | State   | Date | Outcome |
| ----- | ------- | ---- | ------- |
| P0    | done | 2026-11-18 | 24.22.3 and 26.13.1 green: 6511 passed, 130 skipped, no flake; audit 18 (1 critical, 2 high, 14 moderate, 1 low; picomatch advisory withdrawn); 2 dead allowScripts entries |
| P1    | done | 2026-11-19 | `.nvmrc` 26, `engines` >=26.13.1, @types/node 26.6.6, setup-node v7; gates green (6511 passed, 130 skipped); live pro@nginx 70/70, free@nginx 53/53, twins 4/4 + 4/4, twin specs 122; no Node-26 warning |
| P2    | done | 2026-11-19 | npm 12.2.3 (devEngines, onFail error); CI caches ~/.npm itself (setup-node's npm cache runs npm 11); allowScripts: fsevents@2.3.2 dropped, APVM deny key kept; clean `npm ci` ok; `.node-version` 26; hook runs `lint-staged` |
| P3    | done | 2026-11-19 | execa 10.2.1, commander 15.1.0; maxBuffer re-measured (still-running child now SIGTERM, outcome unchanged), comment + doc fixed, spec added |
| P4    | done | 2026-11-19 | apvm-napi `#v3.3.0` (allow-git=all once); API superset, enums runtime; fresh WP Rocket zips +3 nested vendor files (new SHA); V257 clean; offline commit pins hit; live pro@nginx 70/70, free@nginx 53/53, twin-apache 4/4, all built fresh |
| P5    | done | 2026-11-19 | eslint 10.15.0, typescript-eslint 8.73.0, globals 17.14.0, prettier 3.10.1 (0 reformats), lint-staged 17.6.1 (hook proven); 3 enum casts `as unknown as`; audit 18 → 10, eslint minimatch chain gone |
| P6    | done | 2026-11-19 | @playwright/test 1.65.1 (Chromium 159); `screen` override + `presetScreen`, floor 1.64; internals unchanged; live pro@nginx 70/70, free@nginx 53/53, twins 4/4 + 4/4, twin specs 122/123 (a lock-wait flake) |
| P7    | done | 2026-11-19 | allure 3.33.0, allure-playwright 3.15.0; 3.18 history continues (same key, measured); glob 14 override, audit 10 → 0; server on 127.0.0.1 (`allurerc.mjs`); no git facts in reports (`GIT_DIR`) |
| P8    | done | 2026-11-19 | node-ssh 14.0.0, @types/ssh2 1.15.6 (one @types/node); #132 fixed (`Not connected` retried; lost / closed before started / could not run, no argv); `noBuffer`; stand-in types gone; unit 6639, twin specs 123; live pro@nginx 70/70, free@nginx 53/53, twins 4/4 + 4/4 |
| P9    | done | 2026-11-19 | string-width 9.0.0; regional indicator counts 1 (flag 2, lone 1); keycap row 2 → 1 (= tmux); 6 rows added; gates green (6652 passed, 134 skipped) |
| P10   | pending |      |         |
| P11   | pending |      |         |
