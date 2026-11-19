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
- **Comments, docs or calibration only:** APVM 3.3.0 (its pin change needs `--allow-git=all` once), pixelmatch 8 (new colour metric) and Allure 3.33 (new history keys).
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

### P4 — APVM 3.3.0 · s/medium · deps: P1 · independent of: P2, P3, P6–P10

- **Pin** `github:wp-media/automation-plugin-version-manager#v3.3.0`.
  - The tag scheme changed: no `cli/` prefix.
  - **Change it with `npm i --allow-git=all`** (one time). A plain `npm i` fails with `EALLOWGIT` under `allow-git=root`.
  - Then `npm ci` (with `root`) must install it.
- **API we import** (`apvm.ts`, `resolve.ts`, `warm.ts`): unchanged, and `engines` ≥22.22.1.
  - The enums (`JsBuildPhase`, …) are now runtime enums, not `const enum`.
- **Behaviour changes to check against our code:**
  - **WP Rocket zips:** a build now excludes `php*`/`package*` only at the plugin root, so fresh zips change content and SHA-256. Cached builds are still served.
  - **Ref parsing:** bare refs are still auto-detected, and `commit:` matches only commits; our pins are full SHAs.
  - **Build tools get empty stdin.**
  - **APVM's logs go to stderr:** check `apvm.ts`'s event printing and any test that captures it.
  - **An empty `NO_COLOR=`** no longer disables colour.
  - **Tokens:** fine-grained `github_pat_` tokens from `gh auth token` are picked up and validated. Re-run the V257 check that no token appears in errors or events.
  - **`APVM_CACHE_DIR`** is read at `create()`, so check where warm and resolve set it.
  - **Only one copy of the addon may load per process:** warm, resolve and the auth setup must never load two.
- **Docs:** the pin text in `AGENTS.md` (≈ :502) and in the plans, and `pin.ts:7` ("measured on apvm-napi 3.0.0").
- **Done:**
  - Gates and `npm run artifacts:warm` pass.
  - An offline commit-pin cache hit still works (sandbox-exec, no network).
  - Live: BackWPup (private source) and a freshly built WP Rocket both pass the artifacts setup.

### P5 — Lint and format toolchain · xs/easy · deps: P4 · independent of: P2, P3, P6–P10

- `npm i -D eslint@10.15.0 typescript-eslint@8.73.0 globals@17.14.0 prettier@3.10.1 lint-staged@17.6.1`.
- **New strict rule `no-unsafe-enum-assignment`** flags exactly 3 casts: `src/common/artifacts/apvm.spec.ts:90-91` and `warm.spec.ts:558`.
  - Use `as unknown as JsBuildPhase`, **not** the enum members.
    - A value import would load the native addon in those specs.
    - It would also break `apvm.ts`'s rule: "the only module that imports `apvm-napi`".
  - Reword the comment at `apvm.spec.ts:89`: the enum is no longer `const`, but the specs stay type-only to keep the addon out.
  - This changes test code only, never what is asserted; say so in the commit message.
- **Prettier 3.10.1** reformats 0 files (measured).
- **Done:** gates pass, and `npm audit` drops the eslint `minimatch` chain.

### P6 — Playwright 1.65.1 · m/medium · deps: P1 · independent of: P2–P5, P7–P10

- `npm i -D @playwright/test@1.65.1`; the root `postinstall` downloads Chromium 159.
- **Breaking (1.64): presets now apply `screen`.**
  - `DESKTOP`/`MOBILE` (`src/common/config/devices.ts`) spread presets, so `@mobile` (Pixel 5) would report 1920×1080.
  - 1.65.1 exposes `screen` as an option fixture (`contextOptions.screen`), so the existing tag-driven pattern works.
  - **Fix:**
    - Add `screen` to `DeviceProfile` as a sixth override in `src/common/fixtures.ts`.
    - Delete the "Deliberately not applied: the preset's `screen`" comment in `devices.ts`.
    - Extend `devices.spec.ts`: desktop 1920×1080, `@mobile` 393×851, both taken from the presets rather than hard-coded.
    - Assert `window.screen` in `observedDevice` (`src/common/steps/world.steps.ts`) against the selected profile's `screen`, so the `@mobile` smoke checks it.
- **Other 1.64/1.65 changes, checked as not affecting us:**
  - Elements in hidden iframes now count as hidden: we use no iframes or frame locators in `src`.
  - `--update-snapshots=missing` now passes: we don't use `updateSnapshots`.
  - JSX follows the tsconfig: we have no JSX.
  - Class fields follow `useDefineForClassFields`: one initializer reads `this` (`table-padding.php.spec.ts:39`), and it reads another field, which is safe.
  - Fix the `tsconfig.json` comment: Playwright transpiles with Babel, not esbuild.
- **Internals we rely on, unchanged in 1.65.1** (source-diffed):
  - `PLAYWRIGHT_NO_COPY_PROMPT`, `PW_TEST_REPORTER`, `_mode`, `PWTEST_WATCH`, `PLAYWRIGHT_HTML_TITLE`, `captureGitInfo`;
  - trace `snapshots.dom:false`;
  - project filtering, the retry rule, drain signals;
  - a worker's env handed on at stop;
  - graceful-fs patch marks;
  - `forceRegExp` and `_grepTitleWithTags`.
  - `secrets.run.spec.ts`, `results-stream.run.spec.ts`, `import-boundary.spec.ts` and the tmux/pty specs exercise them.
- **Playwright Docker image** (`@visual`; README, authoring-tests.md): ships Node 24 up to 1.63 and Node 26 from 1.65.1 (Dockerfile.noble `ARG NODE_VERSION`), so the container matches `engines` only from here. A mismatch only warns: `.npmrc` has no `engine-strict`.
- **Comments naming 1.63 to update:**
  - source: `terminal-mode.ts`, `authenticate.ts`, `results.ts`, `cell-pin.ts`, `import-probe.ts`, `__fixtures__/reporter-fakes.ts`;
  - specs: `outcome.spec.ts`, `failure-block.spec.ts`, `results.spec.ts`.
- **Done:**
  - Gates pass with browsers installed normally; the `*.run.spec.ts` specs need the real Chromium.
  - The `@noauth` smoke passes on both products, and the `@mobile` smoke checks a 393-wide screen.
  - Live `@plugin` runs pass on both products.

### P7 — Allure 3.33 · s/medium · deps: P1 · independent of: P2–P6, P8–P10

- `npm i -D allure@3.33.0 allure-playwright@3.15.0`. Allure needs Node ≥22.18.
- **Unchanged (diffed):**
  - the analytics block `allure-analytics.ts` removes;
  - `generate -o -c --name`;
  - the `awesome/` + `dashboard/` layout and `allurerc.mjs`;
  - the trace content type and step shape (`allure-results.ts`).
- **Changed:** history lines are keyed by `retryHash` (since 3.19).
  - Old lines map through `legacyHistoryId`, for the default environment only.
  - `allure-history.ts` relies only on the top-level `timestamp` and one line per generation, which still hold.
  - **Risk:** trend and flaky marks may not continue from 3.18 runs.
- **Comments:** `allure-analytics.ts` ("through 3.22.1"), `allure-history.ts` ("3.18").
- **Audit:** Allure 3.33 still pulls `glob@13.0.7` (GHSA-3g3m-2fjr-6pw4) and `minimatch@10.2.6` (GHSA-g3hv-75wg-m249).
  - Try `overrides` to their fixed versions: glob 14.0.6 (a major) and minimatch ≥ 11.0.1.
  - Keep them only if the "with the real Allure CLI" specs and `report:allure` pass; otherwise leave them in the deferred list.
- **Done:**
  - Gates pass, including the real-Allure-CLI block in `allure-report.spec.ts`.
  - `npm run report:allure` on a cell with 3.18 history shows its trend; if not, document a one-time reset.
  - `npm audit` no longer lists dompurify, follow-redirects, markdown-it or fast-xml-parser (measured on the upgraded tree).

### P8 — node-ssh 14 · m/hard · deps: P1 · independent of: P2–P7, P9, P10

- **Add the override to `package.json` first:** `"overrides": { "@types/ssh2": { "@types/node": "$@types/node" } }`.
  - Then run `npm i -D node-ssh@14.0.0 @types/ssh2@^1.15.6`.
  - Added afterwards, the nested `@types/node` 18.19.130 stays in the lockfile as `invalid` (measured).
  - `npm ls @types/node` must show one, deduped copy.
- **Breaking (#132): `execCommand` rejects** with ssh2's error when the connection dies mid-command, where 13.x resolved `code: null`.
  - `transport-exec.ts:646-660` builds "the connection to X was lost (<reason>) while "<program>" was running…" only on `code === null`.
  - `exec.ssh.spec.ts:223` and `:285` expect `(read ECONNRESET)` / `(Keepalive timeout)` in it. With node-ssh 14 and no fix, exactly those two fail (measured), which proves the specs catch it.
  - **Fix:** wrap `ssh.execCommand` in a try/catch.
    - **`NOT_CONNECTED`:** rethrow unchanged, because `withConnection` retries on it.
    - **A recorded connection loss** (`connectionLosses.get(ssh)` set; node-ssh's own listener runs first in the same emit, so it is recorded by then): throw the existing "lost (<reason>)" message. Factor it into one helper shared with the `code === null` branch.
    - **Anything else** (`Unable to exec`, `ERR_OUTPUT_TOO_LARGE`, `ETIMEDOUT`, a throwing callback): throw "<program> could not run over SSH on <site>: <error code or message>". Name the program, never the argv, and attach no `cause`; this is the exec-error rule in AGENTS.md.
    - Keep the `code === null` branch for a channel closed without an error.
  - **Specs:** add one for the "anything else" path (e.g. the test server refusing `exec`), asserting that no argument appears.
- **Also:**
  - Pass `noBuffer: true`: we collect the chunks ourselves, and without it `ERR_OUTPUT_TOO_LARGE` can reject.
  - Fix stale comments: the error listener (≈ :437-442; node-ssh now listens for the connection's whole life) and "ssh2 types do not resolve" (`transport-exec.ts:367`, `ssh-server.ts:684`, `exec.ssh.spec.ts:66`).
  - Replace the stand-in types (`ErrorEmitter`, `Connect`, `Observable`) with `@types/ssh2` types where they fit.
- **Unaffected:**
  - only named `{ NodeSSH }` imports;
  - no `cwd` option;
  - the test SSH server loads ssh2 itself.
- **Done:**
  - Gates pass, and so do the SSH-twins specs.
  - Live runs pass on both products.
  - A connection killed mid-command shows the "lost" message, naming only the program.

### P9 — string-width 9 · s/medium · deps: P1 · independent of: P2–P8, P10

- `npm i -D string-width@9.0.0`.
- **Measured with v9** (official Node 26) against `layout.spec.ts` (`[name, text, columns, columns tmux drew]`):
  - **Flag:** whole = 2, but the per-code-point sum = 4, so 4.
  - **Lone regional indicator:** 2. It is a single code point, so `graphemeWidth` (`layout.ts:273`) returns string-width's width early.
  - **Three indicators:** a flag plus a lone indicator.
  - **Keycap `1⃣`:** 1.
  - `cutToWidth`'s flag case (`layout.spec.ts:441`) fails too.
- **Fix (D2) in `graphemeWidth`:**
  - A cluster that is a single regional indicator returns 1.
  - In the per-code-point sum, a regional indicator counts 1.
  - Result: flag 2, lone 1, three indicators 3, all equal to tmux's column.
- **Spec change:** the keycap row's measure changes 2 → 1. v9 now matches tmux's measured 1, which still respects the invariant "never below what a terminal draws". State this in the commit message.
- **Run the whole table on v9** and list any other changed row. Treat it the same way: fix the code if the new width falls below tmux's column; otherwise change the row only to tmux's measured value.
- **Done:**
  - Gates pass, including the tmux/pty specs, `live-block.spec.ts`, `orchestrator/line-style.spec.ts` and `orchestrator/status/table.spec.ts`.

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
| Allure history discontinuity                                         | P7 checks a cell with 3.18 history; document a one-time reset if needed                                   |
| Undici 8 HTTP/2 against Slack/Datator                                | The notify specs plus one real post in P11                                                               |
| One phase's failure hides another's                                  | Sequential phases, one install each, gates after each; P0 baseline on both runtimes                        |
| Lockfile drift                                                       | Targeted `npm i` per phase; review the `package-lock.json` diff for unrelated moves                        |

## Deferred (open obligations)

- **TypeScript 7:** wait for 7.1 stable plus typescript-eslint support (#10940). The three TS-API spec helpers then move to the 7.1 API.
- **Docker local env images (D5).**
- **ssh2 native crypto on Node 26** (mscdex/ssh2#1531): once fixed, drop `orchestrator.md`'s install note.
- **Allure's glob/minimatch advisories,** if P7's overrides fail.
- **pixelmatch threshold re-tune** with the first `@visual` scenario.
- **Unit-suite robustness** (found on RemoteDesktopQA, Ubuntu 24.04; not dependency issues, same on Node 24):
  - umask 0002 (Ubuntu's default for a user with its own group) fails 23 orchestrator specs (`state/` counter, run-retention, orphans; `runs/launch`): fixture folders come out 775, which the code rightly refuses as group-writable; the specs should set their own umask or modes.
  - `src/common/__fixtures__/temp-dir.spec.ts` (2 tests) fails when the checkout itself lives under the OS temp folder (`/tmp/…`).
  - `src/projects/wp-rocket/support/config-edits.php.spec.ts` (9 tests) fails on PHP 7.4: `__fixtures__/wp-rocket-edits-harness.php:136` uses `str_contains()` (PHP ≥ 8); polyfill it, or skip with a reason when the local PHP is older.
  - `src/projects/backwpup/support/content-copy-put-back.spec.ts:474` ("the old put-back … fails while the site writes") once did not reproduce the old failure there: its reproduction is timing-dependent.

## Status

| Phase | State   | Date | Outcome |
| ----- | ------- | ---- | ------- |
| P0    | done | 2026-11-18 | 24.22.3 and 26.13.1 green: 6511 passed, 130 skipped, no flake; audit 18 (1 critical, 2 high, 14 moderate, 1 low; picomatch advisory withdrawn); 2 dead allowScripts entries |
| P1    | done | 2026-11-19 | `.nvmrc` 26, `engines` >=26.13.1, @types/node 26.6.6, setup-node v7; gates green (6511 passed, 130 skipped); live pro@nginx 70/70, free@nginx 53/53, twins 4/4 + 4/4, twin specs 122; no Node-26 warning |
| P2    | done | 2026-11-19 | npm 12.2.3 (devEngines, onFail error); CI caches ~/.npm itself (setup-node's npm cache runs npm 11); allowScripts: fsevents@2.3.2 dropped, APVM deny key kept; clean `npm ci` ok; `.node-version` 26; hook runs `lint-staged` |
| P3    | pending |      |         |
| P4    | pending |      |         |
| P5    | pending |      |         |
| P6    | pending |      |         |
| P7    | pending |      |         |
| P8    | pending |      |         |
| P9    | pending |      |         |
| P10   | pending |      |         |
| P11   | pending |      |         |
