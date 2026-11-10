# Phase 12 — Run as the site: the web server's identity for every site command

Status: planned 2026-11-10, audited the same day (§7); next, before Phase 11. Parent:
[e2e-modernization-plan.md](e2e-modernization-plan.md) (§3 phase table). Reverses that plan's §8.2
rejection of "running WP-CLI as the docroot owner". Part B is a prerequisite of WP Rocket's port
([phase-6 plan §6](phase-6-feature-porting-plan.md#6-after-phase-10--wp-rocket)).

## TL;DR

- **Goal:** what the suite does on a site should look as if the website did it.
  - Over `ssh`, every site command runs as the web server's user and group. That is the docroot
    owner, once the pre-flight has verified it is who PHP runs as:
    `sudo -n -u <user> -g <group> -- /bin/sh -c 'umask "$0" && cd -- "$1" && shift && exec "$@"' 0022 <root> <cmd> …`.
  - Every `wp` call through `wpCli` adds `--user=<the site's WordPress login>`.
- **Operator decision (2026-11-10):** we control the servers. Docroots are chowned to
  `<web user>:<web group>`, and the SSH user has passwordless sudo, plus `Defaults:<ssh user>
  !log_allowed` so sudo does not write command lines (`--key=` values) to the system log.
- **Fallbacks stay, and always warn:**
  - When sudo, `wp` under sudo, the identity, its verification or the WordPress login is missing,
    the suite does what it does today: the transport's user, `normalizeOwnership`, and the outputs a
    product declares its activation creates are handed over.
  - The pre-flight names every condition that is not met.
  - Nothing here fails a run.
  - The identity never changes in the middle of a process: a transport failure is an error, never a
    fallback.
- **"As today", where a scenario needs it:** `asTransportUser(transport)` gives back a transport
  whose commands are byte-identical to today's (SSH user, no sudo, no `--user`).
  - BackWPup and WP Rocket both run on the new system.
  - BackWPup's one scenario whose premise is "WP-CLI and the web server are different users" opts
    back in its Gherkin (12.10).
  - A whole-suite comparison on the twins finds any other.
- **Rollout per site:** `transport.runAs` (`ssh` only) is `"auto"`, `"user:group"` or `false`.
  - Defaults to `false` until 12.11, then `"auto"`.
  - The orchestrator's runs read the same sites files; the operator drains a cell's task while
    switching it.
- **Part A (12.0–12.11):** the identity layer. **Part B (12.12–12.16):** WP Rocket's lifecycle
  (install outputs, licence, settling request, deactivation recovery, in-place
  `.htaccess`/`wp-config.php` cleanup, one lifecycle scenario).
- **Order:**
  1. 12.0a, 12.1 and 12.2 in parallel;
  2. 12.0b and 12.3;
  3. 12.4;
  4. 12.5, 12.6 and 12.7 in parallel;
  5. 12.8, 12.9 and 12.10;
  6. 12.11;
  7. Part B: 12.12 and 12.13 in parallel, then 12.14, then 12.15, then 12.16.

## 1. Facts this plan rests on

### 1.1 Measured on Docker copies of the cells (2026-11-10)

Setup:
- Ubuntu 24.04; Apache 2.4.58 + PHP-FPM 8.3.6; nginx 1.24 + PHP-FPM 8.5.12.
- sudo 1.9.15p5, WP-CLI 2.12.0, WordPress 7.2-beta1 / 6.8.3, WP Rocket 3.24.
- Docroot `www-data:www-data` 755/644 and 775/664; `ubuntu` outside the group unless stated.
- The WP Rocket runs were licensed with dummy `WP_ROCKET_KEY`/`WP_ROCKET_EMAIL` constants in
  `wp-config.php` (S1).
- PHP-FPM was started by hand with `umask 022`, so the umask it reported is not evidence about real
  servers.

Scripts and logs were in the session scratchpad, not kept: re-measure on the twins (12.0) when in
doubt.

| # | Fact |
| --- | --- |
| F1 | Which `sudo -n -u U -g G` a passwordless rule allows: <ul><li>`ubuntu ALL=(ALL) NOPASSWD: ALL`: any `U`, and `G` = any group `U` belongs to (primary or supplementary).</li><li>`(ALL:ALL)`: any `G`.</li><li>`(www-data:www-data)`: only that pair.</li></ul>For `www-data:www-data` all three work. |
| F2 | Every sudo refusal prints `sudo: a password is required`, exit 1, including a group outside the rule. `-n` never waits for a password. |
| F3 | `sudo -u www-data` gives umask **`0002` whatever the caller's** (0000/0022/0077): `pam_umask` in `common-session-noninteractive`. Root gets `0022`. A wrapper running `umask "$0"` (dash) gives exactly the umask passed. |
| F4 | 23 hostile arguments came through node-ssh byte-identical, direct and through sudo + wrapper: quotes, `$(id)`, backticks, newline, CR, tab, `--key=a b`, `-n`, `--`, a 64 KiB base64 string. |
| F5 | **Pre-existing:** node-ssh's `exec` drops an empty-string argument (`shell-escape@0.2.0`: `wp option update x ""` → `wp option update x `). It runs `cd <cwd> ; <cmd>`, so a missing `cwd` runs the command in `$HOME` (`node_modules/node-ssh/lib/cjs/index.js:279-280`). |
| F6 | Under sudo: `HOME=/var/www`; `PATH` = secure_path (`/usr/local/bin/wp` found, `~/bin/wp` not); cwd kept; environment dropped unless passed through `env VAR=…`. |
| F7 | WP-CLI writes nothing to `HOME` for zip installs, `eval`, `option`, `plugin list`. Only download installs try `/var/www/.wp-cli/cache`: they warn, then succeed. |
| F8 | An unresolvable hostname makes every sudo call add `sudo: unable to resolve host …` to **stderr**. Exit codes and stdout are unchanged. |
| F9 | sudo + wrapper add ≤ 10 ms per call (83–88 ms → 87–98 ms per round-trip). |
| F10 | A killed runner leaves the remote command running, with or without sudo (as today). Only the same identity, or root, can kill it. |
| F11 | `--user=<login>`: `get_current_user_id()` is that user, also with `--skip-plugins --skip-themes`. No database change from the flag. A missing login → exit 1 `Error: Invalid user ID, email or login: '<login>'` from every WordPress-loading command. `core is-installed`, `cli info`, `core version`, `config get` and `db query` ignore it. |
| F12 | WP Rocket installed as `www-data` with `--user=admin`, both stacks, both modes: <ul><li>every file `www-data:www-data`; the page cache works;</li><li>the same owners and modes as a wp-admin upload install;</li><li>modes follow the docroot (WordPress's `FS_CHMOD_*`), except the empty `index.html` stubs, which follow the umask.</li></ul> |
| F13 | Leftovers after uninstall: <ul><li>`define( 'WP_CACHE', false ); // Added by WP Rocket`;</li><li>a 0-byte `advanced-cache.php`;</li><li>an empty `wp-content/cache/`;</li><li>`wp-content/upgrade/`;</li><li>on Apache, the `.htaccess` block: written only by the first wp-admin request, never removed by WP-CLI (S2).</li></ul> |
| F14 | `wp-config.php` `root:www-data 644`: activation writes no `WP_CACHE` and nothing is cached. **`wp plugin deactivate wp-rocket` exits 0 and the plugin stays active.** Deactivating works with `add_filter('rocket_prevent_deactivation', fn($c) => array_values(array_diff((array) $c, ['wpconfig'])), PHP_INT_MAX)`, or `add_filter('rocket_set_wp_cache_constant', '__return_false')`, followed by `deactivate_plugins()`. |
| F15 | `wp-config.php` kept its inode and mode at every step. (A 644→664 change seen on 2026-11-09 did not reproduce; 12.15 keeps a mode check.) |
| F16 | Staging: `ubuntu` cannot create `<root>/.e2e_temp` nor upload into a www-data directory. What works: SFTP upload to a directory `ubuntu` owns (≥ `0711`, file ≥ `0644`), then `cp` as `www-data`. A `0700` directory fails with a misleading `Invalid plugin slug`. |
| F17 | A probe `<root>/e2e-identity-<hex>.php` fetched over HTTP reports the PHP worker's `euid`/`egid`/names/umask/SAPI (`posix` present on both stacks). Inside `.e2e_temp/` it is served unless a dot-path deny rule precedes PHP handling (nginx). |
| F18 | On a docroot owned by another account (`sftp_x:www-data`), WordPress's own wp-admin install asks for FTP credentials (no `FS_METHOD`). |
| F19 | **sudo logs every command line it runs**, arguments included (`COMMAND=/usr/bin/echo --key=SECRET_X`; Ubuntu's sudo logs to syslog, facility `authpriv`). `Defaults:ubuntu !log_allowed` stops it (measured with a `logfile`). `sudo -n -l` lists the matching `Defaults`. |

### 1.2 Read from WP Rocket 3.24's source (the zip the cells install)

| # | Fact |
| --- | --- |
| S1 | Licence: `rocket_valid_key()` (`inc/functions/options.php:430`) needs `consumer_key` of 8 characters and `secret_key === hash('crc32', consumer_email)`. Offline: a dummy key works. `Options_Data::get` (`inc/classes/admin/class-options-data.php:57-68`) returns, in order: the `pre_get_rocket_option_<key>` filter's value; the `WP_ROCKET_KEY`/`WP_ROCKET_EMAIL` constants if defined; the option. `wp-rocket.php:93-94` always includes `licence-data.php`, which defines both constants as `''` unless already defined. **So the option alone never licenses**; constants in `wp-config.php` or the filters do. `update_wp_cache` and `is_user_allowed` (`inc/Engine/Cache/WPCache.php`) need a valid key: without one no `WP_CACHE`. |
| S2 | Deactivation (`inc/Engine/Deactivation/Deactivation.php:60-80`): causes = `'htaccess'` (only if `$is_apache` and `.htaccess` is not writable; never under WP-CLI), plus the `rocket_prevent_deactivation` filter, where `WPCache::maybe_prevent_deactivation` appends `'wpconfig'` (a list). A refusal stores transient `<current user id>_donotdeactivaterocket` (`0_…` without `--user`), redirects and `die()`s. Otherwise it deletes the config file and calls `flush_rocket_htaccess(true)` (a no-op under WP-CLI). |
| S3 | `WP_CACHE` (`WPCache.php:145-165`): writes `define( 'WP_CACHE', <value> ); // Added by <plugin name>`. Absent → `preg_replace('/(<\?php)/i', "<?php\r\n<line>\r\n", …, 1)` (so `<?PHP` becomes `<?php`). Present with another value → `preg_replace('/^\s*define\(\s*\'WP_CACHE\'\s*,\s*([^\s\)]*)\s*\).+/m', <line>, …)` with no limit: `^\s*` also eats preceding blank lines, `.+` eats a trailing `\r`. **Measured:** activation leaves `<?php\r\ndefine(…true…)…\r\n\n`; deactivation leaves `<?php\r\ndefine(…false…)…\n\n`. |
| S4 | `.htaccess` markers `# BEGIN WP Rocket` … `# END WP Rocket` (`inc/functions/htaccess.php:63-64`). `flush_rocket_htaccess` (`:81-140`) rtrims each line and re-joins with `\n`, so a CRLF `.htaccess` comes back LF. |
| S5 | `advanced-cache.php` is generated from `views/cache/advanced-cache.php` (defines `WP_ROCKET_ADVANCED_CACHE`). On deactivation `update_advanced_cache` empties it. |
| S6 | Uninstall (`inc/Engine/WPRocketUninstall.php`) deletes `cache/{wp-rocket,min,busting,critical-css,used-css,fonts,background-css}`, `wp-content/wp-rocket-config/`, its tables, options, transients and the `rocket_boxes` user meta. It does not delete `cache/` itself. |

### 1.3 Read from this repository (2026-11-10)

| Fact | Where |
| --- | --- |
| Over `ssh`, every command runs as `transport.username`; root is `sudo -n --`; uploads are SFTP `putFile` as that user. | `src/common/wp/exec.ts` (`runSsh`, `sudoArgv`, `copyIntoTarget`) |
| Probes go through `exec`: `detectSiteOwnership` (`stat`), `probeIdentity` (`id`), declared-owner lookups (`id -u`, `getent`), `elevationSupport` (`sudo -n true`), docker `pwd`, `resolveOnTarget` (`readlink -f`). | `ownership.ts:297, 309, 509-510`; `exec.ts:637, 860, 718` |
| The pre-flight calls `exec(transport, "wp", …)` directly (not `wpCli`): `wp --info` (gate, hint names `transport.username`), the locale check with its own `--user`, `core is-installed`. | `setup/preflight.ts:158, 301-305, 386, 411` |
| Every `wp/*` function takes only a `Transport`; the WordPress login is `SiteInput.username`. | `config/types.ts:147` |
| One install path for Before and part-way reinstalls: `installFresh`, used by `installPluginUnderTest` and `replacePluginUnderTest`. `ensurePluginDeactivated(transport, slug)` re-asserts the state; it is also reached from `ensurePluginAbsent`, the pre-flight's heal and `capture-backwpup-fixtures.ts`. | `hooks/plugin-lifecycle.ts:262, 334, 373`; `wp/plugin.ts:79-88` |
| Data directories are opened `0777` (`DATA_DIR_MODE`) because two users share them. | `wp/residue.ts:409-429` |
| Orchestrator runs: `E2E_LOAD_DOTENV=false`, only `INHERITED_VARIABLES` (`:38`), secrets only `GITHUB_TOKEN`, `GH_TOKEN`, `BWP_*`. | `orchestrator/runs/environment.ts`; `orchestrator/config/schema.ts:43` |
| BackWPup: only one scenario's **outcome** depends on two users: "Deleting a backup the web server made is refused…". Its step "WP-CLI's user may not write the {word} backup" skips when the archive is writable. **One premise is about safety, not outcome:** the private folder (`support/private-folder.ts:26-36`, staging, `0700` "private to the transport's user") holds downloaded backups, job exports and encryption keys, and is servable once its owner is the web user. CLI output is parsed from stderr too (`support/cli.ts:163-167` `parseCliNotices`). | `features/cli-backups.feature:44-53`; `steps/cli-backups.steps.ts:100-121`; `fixtures.ts:202` (`new CliSession(site.transport)`) |
| The healthcheck runs `verifySite` (`:187`) before it opens a browser context (`checkLogin`, `:153`). The auth setup calls `verifyPool` once with `{ browser }` only (`auth.setup.ts:47, 76`). | `healthcheck.ts`; `src/common/auth/auth.setup.ts` |
| Artifacts resolved by a setup project are read by workers from the run's folder (`readResolvedArtifact`): the pattern for handing the identity verdict to workers. | `src/common/fixtures.ts:149-150`; `artifacts/` |
| WP Rocket has no real sites file and no `@plugin` scenario. Editions are all-or-none per product (BackWPup's twin cells need an edition). `sites.*.json` overlays are git-ignored. | `src/projects/wp-rocket/config/`; configuration.md "Editions"; `.gitignore:58-60` |

## 2. Design

### 2.1 Identity states (per install, per process, memoised by `installKey`)

| State | When | Commands run as | Reported |
| --- | --- | --- | --- |
| `site` | `ssh`; `runAs` is `"auto"` (owner verified as the web identity) or `"user:group"`; the run probe passes | identity, via sudo + wrapper | ✓ "runs as `<user>:<group>`, umask `<m>`" |
| `same-user` | the transport user already is the identity, or mode `docker`/`local` | itself (no sudo); umask as today | ✓ |
| `fallback` | `runAs` asks for it but there is a reason (below) | transport user + today's hand-over | ⚠ the reason and its fix |
| `disabled` | `runAs: false` (default until 12.11), or a transport from `asTransportUser` | transport user + today's hand-over | note (silent for `asTransportUser`) |

Fallback reasons, each with its fix:
- `no-sudo`: the run probe is refused (F2) → the sudoers line;
- `no-wp`: `wp --info` fails under sudo (F6) → install `wp` on `secure_path`;
- `no-root-access`: the identity cannot enter `rootDir`;
- `no-identity`: the owner is undetectable, or root → `chown -R`;
- `owner-not-web`: the pre-flight probe says PHP runs as someone else;
- `unverified`: `auto`, but no pre-flight verdict for this run;
- `probe-mismatch`: the run probe returned other ids.

- **Identity:** `runAs: "user:group"` (the operator vouches; the web probe still reports), else
  (`auto`) the owner and group of `wp-content`.
  - Numeric ids become `#uid`/`#gid` for sudo.
  - Root (uid 0 or `root`) is refused: a config error at load, `fallback/no-identity` when detected.
- **`auto` needs the pre-flight's verdict.** The auth setup (and the healthcheck) probe the web
  server over HTTP (12.3) and write `site-identity.json` beside the run's resolved artifacts, keyed
  by `installKey`: owner, web identity, web umask, verdict.
  - Workers read it. `site` only when the web identity equals the owner.
  - No verdict (e.g. `--no-deps`) → `fallback/unverified`.
  - This is what keeps `auto` from running as a deployment account (`sftp_*`) that the web server
    reaches only through group bits.
- **umask:** `transport.umask`, default `0022` (systemd's default for apache2 and php-fpm). Applied
  only in `site`. The pre-flight warns when the web server reports another one.
- **The run probe** (worker and pre-flight): one wrapped call, `id && wp --info`, run with
  `rootDir` as working directory.
  - It proves sudo, the group rule (F1), `/bin/sh`, entering the root, `wp` on `secure_path`, and
    the ids (parsed by `parseIdentity`).
  - A refusal or failure → the matching fallback, cached for the process.
  - **A throw (transport failure) is rethrown, never answered**: answering would run that one call
    as another user.
- **Probes always run as the transport user** (`execAsTransport`, never through the resolver): `stat`,
  `id`, `getent`/`id -u`, `sudo -n true`, docker `pwd`. This avoids recursion, and keeps
  `elevationSupport` measuring the SSH user.
- **Two caches, never one:**
  - the transport identity (`probeIdentity`'s cache, unchanged meaning);
  - the run identity (the resolved state).

  `planOwnership` takes the run identity from the resolved state instead of running `id`. Every
  cache whose answer depends on who runs commands (ownership plans, `--user` check) is keyed by
  `installKey` plus the state's identity, so an `asTransportUser` copy never reads a `site` answer.

### 2.2 What runs as whom

| Identity | What | API |
| --- | --- | --- |
| Site (`site` state) | every `exec`/`wpCli`/`evalPhp`, reads included | unchanged signatures |
| Transport user | probes (§2.1); SFTP into the inbox and its removal (12.5); the pre-flight's "SSH user can reach the root" check | `execAsTransport` (exported for `wp/`, `setup/`) |
| As today | a scenario whose premise is two users (12.10), or any single call that must be | `asTransportUser(transport)` → a copy with `runAs: false` and no `wpUser` |
| Root (unchanged) | `execElevated`: housekeeping fallbacks, BackWPup's content copy, fallback `chown` | unchanged |

- The wrapper does the `cd` (TL;DR), so the SSH user never needs access to the root. `execAsTransport`
  keeps the plain `cd -- <cwd> &&` of 12.1.
- `docker`/`local`: `runAs` is refused at load; both are `same-user`; both get `--user`.

### 2.3 `--user`

- **One rule:** `wpCli` prepends `--user=<wpUser>` whenever `wpUser` is set and the check passed,
  whatever the run state. Only `asTransportUser` drops it. Direct `exec(…, "wp", …)` calls get none
  (the pre-flight's three are deliberate; the locale check passes its own).
- `validateSite` copies `site.username` into a resolved-only `transport.wpUser`; a sites file
  setting it is refused.
- The check, once per install per process, with `--skip-plugins --skip-themes`:
  1. `wp user get <login> --field=ID`;
  2. `user_can(<id>, 'manage_options')` via `evalPhp`, the login through `phpLiteral`.

  Outcomes:
  - Only the exact `Invalid user ID, email or login` answer, or a non-admin, is cached as "drop":
    warn once and drop `--user` for that install.
  - Any other failure (WordPress cannot boot yet) is not cached.
  - WP-CLI reads a numeric `--user` as an ID, so the check compares the returned user's
    `user_login` with the login and drops `--user`, with a warning, on a mismatch.
- Mid-process removal (a DB reset or restore): when a `wpCli` call fails with that exact error, warn
  once, mark the install "drop" and retry the call once without `--user`.
- Never printed: messages say "the site's WordPress login". Unit transports carry no `wpUser`.

### 2.4 BackWPup: the new system, plus "as today" where a premise needs it

- BackWPup runs on the site identity like every product: shared hooks, support modules, the CLI
  under test, restores.
- **A scenario whose premise is two users opts back** in its Gherkin:
  `Given WP-CLI runs as the SSH user, not the web server`.
  - It calls `cli.runAsSshUser()`, which swaps the `CliSession`'s transport for
    `asTransportUser(site.transport)` before any command.
  - The scenario's permission check uses the session's transport.
  - The step first checks that WordPress boots for the SSH user (`wp core is-installed` as it). If
    not, the scenario is skipped, naming the reason, as it already skips on a one-user host.
- Today that is one scenario (§1.3). 12.10's comparison proves there are no others.
- **The private folder moves out of the docroot in `site`.**
  - A per-scenario folder under `/tmp/e2e-private-<16 hex>`, created as the run identity with
    `0700`, still private: the web server serves nothing outside the docroot.
  - 12.10 verifies BackWPup accepts targets outside `ABSPATH`. If it refuses one, keep the folder in
    staging with its random name and record the residual risk here.
- Why not a product-wide opt-out: §2.5.

### 2.5 Rejected

| Alternative | Why not |
| --- | --- |
| BackWPup opting out product-wide | Rejected with the operator (2026-11-10): it counted every module that runs a command, when one scenario's outcome depends on two users. It would leave the largest suite on the old path, keep two models alive, and test the new system on WP Rocket alone. |
| Faking the two-user premise with `chmod a-w` | It would test a read-only file, not a site whose web server writes as another user. |
| `auto` = the docroot owner without verification | On a deployment-account docroot (`sftp_*:www-data`) it would write `644/755` files the web server cannot write, worse than today (audit, 2026-11-10). |
| Answering a probe throw with `fallback` | One call would run as another user mid-scenario: the mixed ownership this plan removes. |
| Mirroring `wp-content`'s mode as umask | WordPress applies the docroot's modes anyway (F12); the website's umask is what to copy. |
| An environment variable as the switch | Orchestrator runs never see `.env` and get only allow-listed variables (§1.3); the rollout is per server anyway. |
| Uploading through `sudo … tee` / stdin | The exec layer never feeds input; inbox + `cp` uses existing primitives (F16). |
| Setting `WP_CLI_CACHE_DIR` | The suite installs from zips only (F7). Documented, not set. |
| Licensing through the `wp_rocket_settings` option alone | Never licenses: `licence-data.php` defines empty constants that win (S1). |
| Restoring `wp-config.php` by stripping WP Rocket's lines | WP Rocket's regexes change line endings and blank lines (S3, S4); stripping would never match. 12.15 applies WP Rocket's own transforms to the record instead. |
| Making `DATA_DIR_MODE` depend on the state | The "as today" scenario and fallback states still mix two users in BackWPup's data directories. Revisit with modernization §8.4. |
| Storing `wp-config.php`'s bytes in staging | Staging is in the docroot and servable (F17); the record goes outside it (12.15). |

## 3. Stack

| Part | Version |
| --- | --- |
| Runtime and language | Node ≥ 24.16, TypeScript 6.0.x strict |
| Libraries | `node-ssh` ^13.2.1 (its `shell-escape` 0.2.0 bypassed by 12.1); execa ^10; `@playwright/test` ^1.62 (`request.newContext` for the probe; `BrowserContext.request` for the settling request, which shares the context's cookies); no new dependency |
| Target hosts | Ubuntu 24.04, sudo ≥ 1.9, `/bin/sh` = dash, GNU coreutils |
| Twins | `ubuntu:24.04`; apache2 + php8.3-fpm; nginx + php8.5-fpm (`ondrej/php` PPA, minor pinned); MariaDB (apache) / MySQL (nginx); openssh-server; sudo; WP-CLI 2.12.0 phar (SHA-512 pinned) |

## 4. Sub-phases

Every sub-phase ends with:
- the four gates: `npm run typecheck`, `npm run lint`, `npm run format`, `npm run test:unit`;
- the docs it touches;
- a twin run where stated.

Code never cites this plan; docs may.

| # | Delivers | Depends | Parallel with | Effort / difficulty |
| --- | --- | --- | --- | --- |
| 12.0a | Twin images, `system.sh`, `site.sh` variants | — | 12.1, 12.2 | M / M |
| 12.0b | Compose, npm scripts, sites overlays, docs; optional CI | 12.0a | 12.3 | S / S |
| 12.1 | ssh command line: our quoting, `cd … &&`; an executing ssh test server | — | 12.0a, 12.2 | S / M |
| 12.2 | Config: `runAs`, `umask`, `wpUser` | — | 12.0a, 12.1 | S / S |
| 12.3 | `wp/site-identity.ts`: states, probes, web probe and verdict file, `asTransportUser` | 12.2 | 12.0b | M / H |
| 12.4 | Exec wiring: wrapper, `execAsTransport`, probe callers moved, stderr noise | 12.1, 12.3 | — | M / H |
| 12.5 | Staging through an inbox; staging owned by another identity | 12.4 | 12.6, 12.7 | S / M |
| 12.6 | `--user=<login>` | 12.4 | 12.5, 12.7 | S / M |
| 12.7 | Ownership, residue, log, files in the `site` state | 12.4 | 12.5, 12.6 | M / M |
| 12.8 | Install outputs, handed over in fallback | 12.7 | 12.9, 12.10 | S / S |
| 12.9 | Pre-flight and healthcheck reports, banner, sudoers checks | 12.3–12.6 | 12.8, 12.10 | M / M |
| 12.10 | BackWPup on the new system; the two-user scenario opts back; private folder | 12.0b, 12.5–12.7 | 12.8, 12.9 | M / M |
| 12.11 | Docs, decision record, live verification, default `"auto"` | 12.0b–12.10 | — | M / M |
| 12.12 | WP Rocket declarations and licence | 12.11 | 12.13 | S / M |
| 12.13 | Settling admin request after install | 12.11 | 12.12 | S / M |
| 12.14 | Deactivation-recovery chain | 12.12 | — | S / M |
| 12.15 | In-place cleanup of `wp-config.php`, `.htaccess`, `advanced-cache.php` | 12.14 | — | M / H |
| 12.16 | WP Rocket lifecycle scenario | 12.12–12.15 | — | S / M |

### Twin variants (12.0a) and what each must produce

| Variant | Docroot | `ubuntu` | sudo | Expected state (`runAs: "auto"`) | Expected suite outcome |
| --- | --- | --- | --- | --- | --- |
| `legacy-777` | `sftp_twin:www-data` 777 | in group | `(ALL)` + `!log_allowed` | `fallback/owner-not-web` | as today (baseline) |
| `site` | `www-data:www-data` 755/644 | outside group | `(ALL)` + `!log_allowed` | `site` | green |
| `site-775` | `www-data:www-data` 775/664 | in group | `(ALL)` + `!log_allowed` | `site` | green; the refused-delete scenario runs (not skipped) |
| `no-sudo` | `www-data:www-data` 777 | in group | none | `fallback/no-sudo` | green as today; warns |
| `owner-mismatch` | `sftp_twin:www-data` 775/664 | in group | `(ALL)` | `fallback/owner-not-web`, plus a `!log_allowed` warning | as today; warns |
| `no-wp` | as `site`, `wp` only in `~ubuntu/bin` | outside group | `(ALL)` | `fallback/no-wp` | as `legacy` requirements; warns |
| `wpconfig-root` | as `site`, `wp-config.php` `root:www-data 644` | outside group | `(ALL)` | `site` | WP Rocket scenario green via 12.14 |

### 12.0a — Twin images and variants

- `docker/ssh-cells/`:
  - `Dockerfile.apache` and `Dockerfile.nginx` (§3);
  - `system.sh`:
    - users: `ubuntu` with a login shell; `www-data`; `sftp_twin` in group `www-data`;
    - sshd with key-only login; the vhost; the DB;
    - PHP-FPM started with `umask 022`;
    - upload limits 64M (`upload_max_filesize`, `post_max_size`, nginx `client_max_body_size`);
    - the hostname in `/etc/hosts`;
  - `site.sh <variant>`: resets the site to one of the variants in the table, the DB included.
- Mirror what scenarios depend on: `DISABLE_WP_CRON` and a system cron as on `pro@nginx`
  (phase-6 plan V44); PHP memory limits.
- Pins: WP-CLI phar by version and SHA-512; WordPress by version.
- Edge cases: arm64 hosts; a PPA outage fails the build clearly.
- Done: both images build; `site.sh` produces each variant (a script asserts owners, modes,
  membership and sudoers).

### 12.0b — Compose, scripts, overlays, docs

- `docker-compose.yml`: containers `wpme-ssh-apache`, `wpme-ssh-nginx`; SSH on fixed, configurable
  high ports.
- A throw-away key in `docker/ssh-cells/.keys/` (git-ignored).
- npm scripts `env:cells:up`, `env:cells:down`, `env:cells:reset -- <apache|nginx> <variant>`.
- `env:cells:up` writes git-ignored overlays (`runAs` omitted until 12.4 lands, then `"auto"`):
  - BackWPup `sites.twins.json`: `pro@twin-apache` and `pro@twin-nginx`, `edition: "pro"`;
  - WP Rocket `sites.twins.json`: `twin-apache` and `twin-nginx`.
- `env:cells:down` removes containers, volumes, overlays and the key.
- CI: `.github/workflows/ssh-twins.yml` (`workflow_dispatch`, plus pushes touching
  `src/common/wp/**`, `src/common/setup/**`, `docker/ssh-cells/**`) runs the twin specs
  (`E2E_SSH_TWINS=1`). In scope; the main CI is unchanged.
- Docs: configuration.md "SSH twins"; README, one line; AGENTS.md NPM commands and structure.
- Done: `npm run healthcheck` passes on both twins in `legacy-777` with today's code; the CI
  workflow runs green once.

### 12.1 — ssh command line (pre-existing defects, F5)

- `exec.ts`: a pure, exported `shellQuote(arg)`. Every argument is single-quoted, `'` becomes
  `'\''`, and `""` becomes `''`.
- `runSsh` builds `cd -- <quoted cwd> && exec <quoted file> <quoted args…>` and calls
  `ssh.execCommand` with no `cwd`.
  - Keep `noTrim: true`.
  - Map `{ code, signal }` exactly as `runSsh` does today.
- **Test seam:** extend `exec.ssh.spec.ts`'s ssh2 in-process server to **execute** the command with
  `sh -c` in a temp directory, with a fake `sudo` script on its `PATH`. 12.4 and 12.5 reuse it, so
  the main CI covers the wrapper and the inbox.
- Pre-flight: run `wp --info` (check 1) with cwd `/`, so a missing `rootDir` is reported by the root
  check, not as "wp not in PATH".
- Tests:
  - a `shellQuote` table: empty, `'`, newline, CR, tab, `$`, backtick, `-x`, `--`, unicode, 64 KiB;
  - round-trips of `""` and F4's set through the executing server;
  - a missing `cwd` runs nothing;
  - mutants (no `''` case; `;` instead of `&&`) fail.

### 12.2 — Config

- `SshTransport` only:
  - `runAs?: "auto" | string | false`, where a string is `"user:group"` through `parseOwnerSpec`.
    Refused: uid `0` or the name `root`.
  - `umask?: string` matching `/^0?[0-7]{3}$/` with the owner bits `rw` kept (`(n & 0o600) === 0`),
    normalised to four digits.
- `docker`/`local` with `runAs` or `umask` → a load error naming the site and the field.
- `wpUser?: string` on every transport: resolved-only, filled by `validateSite` from `username`; a
  sites file that sets it is refused.
- Default: `runAs` absent means `false`. 12.11 changes it to `"auto"` for `ssh` only — one constant
  with its spec.
- Phase 11: add `runAs` and `umask` to the fields a profile may not carry.
- Tests (`sites.spec.ts`): every valid and invalid form, root, umask bounds, the docker/local
  refusals, `wpUser` filled and refused from the file.
- Docs: configuration.md transport table; AGENTS.md configuration mechanism.

### 12.3 — `wp/site-identity.ts`

- **Pure core:** `decideIdentityState(inputs): IdentityState`, a discriminated union with a
  `reason`. Inputs: mode, `runAs`, the detected owner, the transport identity, the verdict, the run
  probe result. Plus `describeIdentityState()` for messages.
- **Web probe** (`probeWebIdentity(transport, request)`), used by the pre-flight and the
  healthcheck:
  1. write `<root>/e2e-identity-<32 hex>.php` through `evalPhp` with `file_put_contents`, mode
     0644, constant content printing JSON `{euid, egid, user, group, umask, sapi}`. Written as root
     if the transport user cannot write the root, since the identity is not known yet;
  2. GET `new URL("e2e-identity-<hex>.php", baseURL + "/")` with a per-site
     `request.newContext({ baseURL, ignoreHTTPSErrors })` using the same TLS settings as the
     login;
  3. delete the file in `finally`;
  4. sweep `e2e-identity-*.php` older than 1 h first.
  - A WordPress whose root is not the URL root (WordPress in a subdirectory with `rootDir` above
    it) gives a 404 → `unverified`.
- **Verdict file:** `site-identity.json` in the run's folder, written by the auth setup, read by
  workers (the `resolution.json` pattern). Keyed by `installKey`, never holding credentials.
- **`resolveSiteIdentity(transport)`**:
  1. `runAs: false` → `disabled`;
  2. `docker`/`local` → `same-user`;
  3. probes as the transport user: owner (`detectSiteOwnership`), transport identity (`id`);
  4. equal → `same-user`;
  5. `auto`: the verdict must say the web identity equals the owner, else
     `fallback/owner-not-web` or `fallback/unverified`;
  6. the run probe (§2.1).
  - Memoised per `installKey`; a throw propagates and is not cached.
  - `resetSiteIdentityCaches()` for specs.
- `asTransportUser(transport)`: a frozen copy, `runAs: false`, no `wpUser`. Idempotent.
- Edge cases: the docroot owned by root; BusyBox `UNKNOWN` names → numeric `#uid`/`#gid`; F8 noise
  (read the ids from stdout); a probe printing other ids.
- Tests:
  - table-driven over every state and reason;
  - a throw propagates and is not cached;
  - the exact probe argv;
  - the probe JSON parser (malformed, extra fields, HTML error page);
  - URL building with and without a path;
  - the sweep's age filter;
  - verdict file round-trip;
  - `asTransportUser` keeps every other field.

### 12.4 — Exec wiring

- `runAsArgv(identity, umask, cwd, file, args)` (pure) returns
  `["sudo", "-n", "-u", u, "-g", g, "--", "/bin/sh", "-c", 'umask "$0" && cd -- "$1" && shift && exec "$@"', umask, cwd, file, ...args]`.
  - The script is a constant; values only travel as positional arguments.
  - The outer command has no `cd`.
- `dispatch`:
  - `exec`/`wpCli` resolve the state;
  - `execAsTransport` forces the transport user;
  - `execElevated` stays root.
- Move every probe in §1.3's row to `execAsTransport`. `planOwnership` reads the run identity from
  the resolved state (§2.1).
- Under the wrapper, `runSsh` removes lines `^sudo: unable to resolve host .*$` from stderr (F8):
  `parseCliNotices`, `describeExit` and `evalPhp` errors read stderr.
- Error labels name the program, never `sudo`.
- `exec.ts` header: "WP-CLI is never root"; site commands run as the site's identity when the state
  is `site`; the root rules are unchanged; `execElevated`'s notice text updated.
- Tests:
  - argv per state;
  - the executing ssh test server (12.1) runs the wrapper with a fake `sudo`;
  - shared fake-`sudo` stubs learn `-u`/`-g`: `exec.spec.ts`, `residue.spec.ts`, `log.spec.ts`,
    `staging.spec.ts`, `plugin-dir.spec.ts`, `support/__fixtures__/copy-host.ts`;
  - `content-copy-leftover.spec.ts`'s `^sudo -n -- mv -T` stays;
  - twin spec (`E2E_SSH_TWINS=1`), every variant: the expected state; `id`; hostile arguments; a
    `wp option` round-trip; a written file's owner and mode; `elevationSupport` still `available`.
- Done: every variant reaches its expected state (table); `site` writes `www-data:www-data` with
  644 stubs; `legacy-777`/`no-sudo` reproduce today's argv byte for byte.

### 12.5 — Staging through an inbox

In the `site` state, `copyIntoTarget` (ssh) does:
1. `execAsTransport mkdir -m 0711 /tmp/e2e-inbox-<pid>-<16 hex>`. No `-p`: an existing path, a
   planted symlink included, fails.
2. SFTP `putFile`, then `execAsTransport chmod 0644`.
3. Ensure the staging directory, as the site.
4. `cp --` from the inbox to the target, as the site.
5. Compare `fileChecksum` (as the site) with the runner's `sha256`.
6. In `finally`, `execAsTransport rm -rf --` the inbox.

- **Staging made by another identity** (a fallback run, a killed run, an absolute
  `stagingDir`/`E2E_SITE_STAGING_DIR`): if the run identity cannot write it, remove it the way
  `cleanSiteStaging` already escalates, then recreate it. For an absolute shared root, remove only
  this site's category folder.
- `cleanSiteStaging` also removes the transport user's `/tmp/e2e-inbox-*` older than 1 h.
- Update `staging.ts`'s header.
- Tests: unit (sequence; cleanup after each failing step; the heal path); executing ssh server;
  twin `site` variant (zip into a 755 docroot, `ubuntu` outside the group).

### 12.6 — `--user=<login>`

- Per §2.3: injection in `wpCli`, the check, the drop-and-retry-once on the exact error. The
  "drop" cache is keyed per §2.1.
- Tests:
  - argv with and without `wpUser`;
  - missing / non-admin / not-booting (not cached) / numeric login;
  - the retry on the exact error, once;
  - no `--user` on the check or under `asTransportUser`;
  - the login never appears in a message.
- Docs: wordpress-automation.md "Transport & exec".

### 12.7 — Ownership, residue, log and files in the `site` state

- `planOwnership` in `site` → `unnecessary` (the writer is the web user); the module header says so.
  Fallback unchanged: grant, then root `chown`.
- Residue: unprivileged first (as the site), then root. Twin spec: zero root escalations in `site`.
- `log.ts`: root fallbacks stay; in `site` they never run (twin assert).
- `files.ts`: `is_writable` means "writable by the identity commands run as". Update the TSDoc of
  `listLocatedFiles`/`SiteFile` (`files.ts:72-75`).
- Tests: a twin spec takes a tiny fake plugin through `stageAndInstallPlugin`, data directories and
  residue removal, asserting owners, modes and no `sudo -n --`.

### 12.8 — Install outputs

- `ProductConfig.installOutputs?: readonly string[]`: paths, relative to the root, that the plugin's
  **activation** may create outside its own folder.
  - Validated by `normaliseSitePath`, registered via `registerInstallOutputs`. Never created by the
    suite.
- In `installFresh`:
  1. before install, record which outputs exist (one `test -e` batch);
  2. after the active-state re-assert, take the outputs that are **new**:
     - fallback/disabled: `normalizeOwnership` on each;
     - `site`: verify the identity owns each, warn otherwise.
- A shared parent such as `wp-content/cache` may be declared: it is handed over only when the
  install created it.
- Removal stays `siteResidue` and 12.15.
- Risk kept as today: fallback's `o+rwX` grant (`grantModeFor`, when the SSH user is outside the
  group) makes handed-over PHP files world-writable, as it already does for plugin files. The
  pre-flight already names the fix (group membership).
- Tests: validation; new-only hand-over; hook order; a twin `no-sudo` run.

### 12.9 — Pre-flight, healthcheck, reports

- Run the web probe (12.3) and write the verdict, in the auth setup and the healthcheck. The
  healthcheck writes no file and uses its own verdict in memory.
- A "Site identity" check in `verifySite` beside "File ownership" and "Elevation":
  - state, identity, umask;
  - fallback reason and fix (§2.1);
  - web identity and umask versus the run identity;
  - the WordPress login result;
  - F8 noise → the `/etc/hosts` fix;
  - **`!log_allowed` missing** from `sudo -n -l` for the SSH user → warn (F19), in every state that
    uses sudo;
  - an existing `~/.wp-cli/config.yml` of the SSH user → "no longer applies in `site`".
- `wp --info` gate (`preflight.ts:411`): its hint names the identity it ran as.
- Banner: one pure renderer (`setup/elevation-report.ts`) for both callers; fields on
  `SitePreflightResult` and the healthcheck's `SiteResult`. Silent when every site is
  `site`/`same-user`, verified, and `!log_allowed` is set.
- Never a gate.
- Tests: renderers for every state and reason; the `sudo -n -l` parser; twin runs of every variant.

### 12.10 — BackWPup on the new system

1. **Baseline**, before this phase's changes: the full BackWPup suite on both twins in `legacy-777`
   with `runAs: false` (`E2E_RETRIES=0`). Record each scenario's outcome (`results.jsonl`).
2. **The opt-back step.**
   - `CliSession.runAsSshUser()` (`support/cli-session.ts`) swaps the transport for
     `asTransportUser(...)` before any command; calling it later throws.
   - `CliSession.transport` is exposed read-only.
   - The step `Given WP-CLI runs as the SSH user, not the web server` (`steps/cli.steps.ts`) checks
     that WordPress boots as the SSH user (else skip with the reason), then calls it.
   - Add the step to "Deleting a backup the web server made is refused…" before its premise step.
   - The premise step (`steps/cli-backups.steps.ts:100-121`) reads writability through
     `cli.transport`.
   - Update the Feature text (it says both commands act as WP-CLI's own user).
3. **Private folder** (`support/private-folder.ts`): in `site`, root it at
   `/tmp/e2e-private-<16 hex>` per scenario (§2.4).
   - Verify `backup-download`, job export and the encryption-key flows accept it.
   - Remove it in the scenario's teardown; sweep `/tmp/e2e-private-*` older than 1 h.
   - Update its TSDoc and authoring-tests.md "BackWPup's fixtures".
4. **Compare:** the suite with `runAs: "auto"` in `site` and `site-775`.
   - A scenario passing in the baseline that fails or skips is investigated: a two-user outcome gets
     the step; anything else is fixed in the shared layer.
   - Also check:
     - `plugin-deletion.feature` / `footprint.ts` (user meta) with `--user`;
     - `cli-runs.feature`'s history trigger `"wp-cli"`;
     - `onboarding.ts` `isPristineActivation`;
     - `wp backwpup kill` (`job-runs.ts:290`) now running as the web user.
5. **TSDoc premises** that name "the transport's user", reworded to "the identity commands run as"
   where that is now true: `makeLogReadOnly`, `backdateFile`, `content-copy.ts` `findLeftovers`,
   `restore-snapshots.ts:142`, `markers.ts:76`, `backups.ts:460`, `cli-restore.ts:29`; the Feature
   texts of `cli-logs` and `cli-job-transfer`.

- Tests: `runAsSshUser` swaps, refuses after a command, and yields today's argv; the private-folder
  root per state; `bddgen` compiles the step.
- Done:
  - no scenario passing in the baseline fails or skips in `site`/`site-775`, except the opt-back
    scenario skipping in `site` with its reason;
  - the opt-back scenario runs in `site-775`;
  - private files never under the docroot in `site`.

### 12.11 — Docs, decision record, live verification, default `"auto"`

- AGENTS.md:
  - WordPress-layer MUSTs: "never elevate `wp`" → "`wp` never runs as root; site commands run as the
    site's identity"; `normalizeOwnership` "in the fallback states";
  - Coding conventions, "Never write to a docroot without restoring its ownership" → "… outside the
    `site` state";
  - the `@plugin` hook text ("open to both WP-CLI's and the web server's user");
  - BackWPup fixture notes (`cli` can run as the SSH user);
  - structure line for `wp/site-identity.ts`; "In-progress plans".
- wordpress-automation.md: Transport & exec, Elevated housekeeping, staging, File ownership,
  residue.
- configuration.md: `runAs`, `umask`, and the **operator server checklist**:
  - `chown -R <web user>:<web group> <docroot>`;
  - `ubuntu ALL=(ALL) NOPASSWD: ALL` (`(ALL:ALL)` only if the group is not one of the web user's,
    F1);
  - `Defaults:ubuntu !log_allowed` (F19);
  - the hostname in `/etc/hosts`;
  - `wp` in `/usr/local/bin`;
  - the PHP-FPM pool user = the docroot owner.
- Modernization plan §8.2 records the reversal; §8.4's `runWpAs` obligation closed.
- **Live, per cell:**
  1. drain or stop the cell's orchestrator task (orchestrator guide);
  2. the operator chowns the docroot and adds the sudoers lines;
  3. set `runAs: "auto"` in its sites file;
  4. healthcheck, then one full suite run;
  5. restart the task.
  - Start with `pro@nginx`; the twins first, every variant.
- Then the default becomes `"auto"` (`ssh` only).
- Done: green on the twins and `pro@nginx`; the banner states what it should; docs merged.

### 12.12 — WP Rocket declarations and licence

- `wp-rocket.config.ts`:
  - `installOutputs`: `wp-content/advanced-cache.php`, `wp-content/cache`,
    `wp-content/cache/{wp-rocket,min,busting,critical-css,used-css,fonts,background-css}`,
    `wp-content/wp-rocket-config`.
  - `siteResidue`: the seven cache folders and `wp-content/wp-rocket-config` (S6).
    `wp-content/cache` and `advanced-cache.php` are 12.15's.
  - `siteDbResidue`: from `WPRocketUninstall.php` at the ref under test, plus the refusal transient
    `<n>_donotdeactivaterocket` as a name pattern (S2).
- Licence (S1): a must-use plugin `wp-content/mu-plugins/e2e-wp-rocket-licence.php`, written by the
  suite before activation, removed in the After hook and declared as residue.
  - It adds `pre_get_rocket_option_consumer_key`, `_consumer_email` and `_secret_key` filters,
    values embedded with `phpLiteral`.
  - Default: a dummy key (8 characters, `secret_key = crc32(email)`): the check is offline.
  - A real key from `.env` (`WPR_CONSUMER_KEY`, `WPR_CONSUMER_EMAIL`, through `env.ts`) only when a
    scenario needs remote features. Only then add `WPR_[A-Z0-9_]+` to `SECRET_NAME_PATTERN`, its
    message, the orchestrator guide, the phase-0.5 plan §4 and AGENTS' orchestrator entry.
  - `wp-config.php` is never edited for the licence.
  - Measure on a twin first that the filters license (`WP_CACHE` written, pages cached).
- Tests: declarations; the mu-plugin's PHP through a stub; its removal.
- Done: a twin install in `site` shows outputs verified and caching; in `no-sudo`, new outputs
  handed over.

### 12.13 — Settling admin request after install

- `ProductConfig.settleAfterInstall?: "admin-request"`. After `installFresh`, the `@plugin` Before
  binding (`plugin.hooks.ts`, which gains `context`) and `replacePluginUnderTest`'s callers:
  1. `context.request.get("/wp-admin/")`;
  2. check the final URL is under `/wp-admin/`, not `wp-login.php` (a `@noauth` scenario or an
     expired login → a warning naming it);
  3. one GET of the front page.

  On Apache this writes WP Rocket's `.htaccess` block, `WP_CACHE` and config files as the web
  server, before any step (F13).
- A failed request is a warning. WP Rocket opts in.
- Tests: opt-in, order and the login check (unit, fake request); twin: the block is there before the
  first step.

### 12.14 — Deactivation-recovery chain

- `ProductConfig.forceDeactivate?: (transport, slug) => Promise<void>`, registered via
  `registerForceDeactivate`/`getForceDeactivate` (`common/` never imports product code).
- `ensurePluginDeactivated(transport, slug, options?)` gains an optional `forceDeactivate`:
  `plugin-lifecycle.ts` passes the product's, tried when the plain deactivate leaves the plugin
  active, then re-asserted.
  - The pre-flight heal, `ensurePluginAbsent` without it, and `capture-backwpup-fixtures.ts` keep
    today's path. The last resort below covers them.
- WP Rocket's (`evalPhp`):
  1. the `rocket_prevent_deactivation` filter with `array_diff` (never unset);
  2. `deactivate_plugins('wp-rocket/wp-rocket.php')`;
  3. delete transients `*_donotdeactivaterocket`.
- Last resort, generic: `--skip-plugins` removal from `active_plugins` (today's `ensurePluginAbsent`
  path). It skips WP Rocket's deactivation, so 12.15 restores the files.
- Each needed step is reported.
- Tests: chain order (unit); twin `wpconfig-root` finishes and leaves the site clean.

### 12.15 — In-place cleanup

- **Record** (Before hook, before install), **outside the docroot**, crash-safe:
  `/tmp/e2e-record-<sha256(installKey)[:16]>/`, `0700`, owned by the run identity.
  - For `wp-config.php` and `.htaccess`: bytes, sha256, mode, owner, inode.
  - For `advanced-cache.php`: exists, sha256.
  - For `wp-content/cache`: exists.
  - **A record already there** (a killed run) is reconciled first: restore from it (below), then
    re-record.
- **Restore** (after 12.14's uninstall), `evalPhp` with `--skip-plugins --skip-themes`, as the site
  (or root in fallback, through `assertResolvedInsideRoot`, refusing symlinks):
  1. Build the candidates WP Rocket's own code makes from the recorded bytes, using its exact
     regexes (S3, S4):
     - insert `true`, then replace with `false`;
     - insert only;
     - replace an existing line;
     - `.htaccess` block added and removed with the LF re-join.
  2. If the current file equals one candidate, write the recorded bytes back in place
     (`file_put_contents`: same inode and owner).
  3. Otherwise → a warning naming the file; never touched.
  - `advanced-cache.php`: delete only if the record says absent and it is empty or defines
    `WP_ROCKET_ADVANCED_CACHE` (S5).
  - `wp-content/cache`: remove only if empty and the record says absent.
  - A mode that differs from the record (F15) → restore it.
  - Delete the record last.
- Generic: `ProductConfig.configEdits` declares the transforms as data (pattern, replacement,
  limit); WP Rocket declares S3 and S4. The engine stays product-agnostic.
- Tests:
  - the transforms pinned against WP Rocket's PHP regexes (a PHP fixture run in the unit job, or
    golden outputs generated once from them): CRLF and LF, no trailing newline, `<?PHP`, blank lines
    before an existing `WP_CACHE`, two `WP_CACHE` lines, a CRLF `.htaccess`, a third party's edit;
  - the reconcile path;
  - twin: byte-identical tracked files after a full lifecycle on both stacks, and after a run killed
    mid-scenario.

### 12.16 — WP Rocket lifecycle scenario

- `src/projects/wp-rocket/features/plugin-lifecycle.feature`, `@plugin`:
  > WP Rocket serves a cached page once activated and leaves the site as it found it when removed.
  - "Cached" means the footer comment plus a second request served from cache.
- Runs on both twins in `site`, `no-sudo` and `wpconfig-root`. On a WP Rocket cell once the operator
  creates one (none exists, §1.3).
- Done: green everywhere; tracked files byte-identical after each run; no warning in `site`.

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Command-line secrets in the system log (F19) | `!log_allowed` in the checklist and twins; the pre-flight warns when missing; the twins assert no `COMMAND=` line. |
| Switching identity breaks cells the orchestrator v0.5 runs on | `runAs` stays `false` until 12.11; whole-suite comparison on the twins (12.10); per-cell procedure drains the task first (12.11). |
| `auto` runs as a deployment account | `site` only with the pre-flight's verdict that owner = web identity (§2.1). |
| The identity changes mid-process | Probe throws propagate; probes never go through the resolver; separate caches (§2.1). |
| sudo's forced umask `0002` (F3) | The wrapper sets it; the twin spec asserts stub modes. |
| sudoers refuses a group (F1) and says "a password is required" (F2) | The run probe uses the exact wrapper; the report names `(ALL:ALL)`. |
| Hostname noise in stderr (F8) | Stripped in `runSsh` under the wrapper; the pre-flight names the fix. |
| Private files servable once owned by the web user | The private folder leaves the docroot in `site` (12.10); the record too (12.15). Staging still holds plugin zips (not secret); 6J keeps the staging area off the web. |
| `--user` changes plugin behaviour or breaks mid-run | No DB writes from the flag (F11); drop-and-retry on the exact error (§2.3); 12.10 checks the BackWPup places it could touch. |
| A BackWPup scenario silently depends on two users | 12.10's baseline-versus-new comparison; a new skip or failure blocks the phase. |
| A killed runner leaves web-user processes (F10) | Unchanged from today; anything that stops one uses the same identity. |
| The probe file served publicly | 128-bit random name, constant content (ids, umask, SAPI), deleted in `finally`, swept after 1 h. |
| Empty-argument and `cd ;` defects (F5) | 12.1 lands first, independently. |
| WP Rocket's file edits not reversible byte for byte | 12.15 replays WP Rocket's own transforms on the record; anything else is warned and left. |
| Phase 11 profiles carrying identity fields | 12.2 adds `runAs`/`umask` to Phase 11's refused list. |

## 6. Out of scope

- Identity in Phase 11 profiles.
- `local`/`docker` run-as.
- Chowning docroots and sudoers (operator).
- Stopping remote processes a killed runner left.
- WP Rocket's feature port (phase-6 plan §6).

## 7. Audit (2026-11-10)

An adversarial review produced 28 findings. Each was checked against the code, WP Rocket's source
or a container before it was applied:
- **F19:** sudo logs argv, measured.
- **S1:** licence constants, from source.
- **S3:** CRLF loss, reproduced with WP Rocket's regexes.
- **§1.3:** private folder, pre-flight `exec` calls, healthcheck order and stderr parsing, read in
  the code.

Applied:
- secrets in sudo's log;
- the `wp-config.php` record kept out of the docroot;
- the private folder;
- `wp` under `secure_path`;
- probe throws;
- probe recursion and caches;
- `auto` on deployment-account docroots;
- the licence;
- the cleanup transforms;
- the 12.10 baseline;
- the `--user` rule and its recovery;
- `cd` inside the wrapper;
- staging owned by another identity;
- the probe's HTTP client;
- stderr noise;
- `forceDeactivate` plumbing;
- `wp-content/cache` hand-over;
- twin variants;
- the CI test seam;
- the rollout procedure;
- record reconciliation;
- settling-request login check;
- config bounds;
- references;
- phase sizes;
- the docs list.

Rejected: making `DATA_DIR_MODE` depend on the state (§2.5). The two unverified suspicions are checks
in 12.10: `wp backwpup kill`, and WordPress booting for the SSH user.
