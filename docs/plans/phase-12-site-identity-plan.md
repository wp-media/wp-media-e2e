# Phase 12 — Run as the site: the web server's identity for every site command

Status: planned 2026-11-10, audited the same day (§7); next, before Phase 11. 12.0a, 12.0b, 12.1, 12.2 and 12.3 done 2026-11-10; 12.4, 12.5, 12.6 and 12.7 done 2026-11-11; 12.8, 12.9 and 12.10 done 2026-11-12; 12.11 (live rollout, default `"auto"`), 12.11b and 12.12 done 2026-11-13; 12.13 next. Parent:
[e2e-modernization-plan.md](e2e-modernization-plan.md) (§3 phase table). Reverses that plan's §8.2
rejection of "running WP-CLI as the docroot owner". Part B is a prerequisite of WP Rocket's port
([phase-6 plan §6](phase-6-feature-porting-plan.md#6-after-phase-10--wp-rocket)).

## TL;DR

- **Goal:** what the suite does on a site should look as if the website did it.
  - Over `ssh`, every site command runs as the web server's user and group. That is the docroot
    owner, once the pre-flight has verified it is who PHP runs as:
    `sudo -n -u <user> -g <group> -- /bin/sh -c 'umask "$1" && cd -- "$2" && shift 2 && exec "$@"' e2e-run-as 0022 <root> <cmd> …`.
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
  - Defaults to `"auto"` since 12.11 (2026-11-13); `false` opts a site out.
  - The orchestrator's runs read the same sites files; the operator drains a cell's task while
    switching it.
- **New session?** Read §8 (working rules) and §9 (measurement checks) first: this file and the repository are
  all you need.
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

The measurement scripts were throwaway; `docker/ssh-cells/` (12.0a) rebuilds the setup and §9 holds
the checks to repeat on the twins. Re-measure when in doubt.

| # | Fact |
| --- | --- |
| F1 | Which `sudo -n -u U -g G` a passwordless rule allows: <ul><li>`ubuntu ALL=(ALL) NOPASSWD: ALL`: any `U`, and `G` = any group `U` belongs to (primary or supplementary).</li><li>`(ALL:ALL)`: any `G`.</li><li>`(www-data:www-data)`: only that pair.</li></ul>For `www-data:www-data` all three work. |
| F2 | Every sudo refusal prints `sudo: a password is required`, exit 1, including a group outside the rule. `-n` never waits for a password. |
| F3 | `sudo -u www-data` gives umask **`0002` whatever the caller's** (0000/0022/0077): `pam_umask` in `common-session-noninteractive`. Root gets `0022`. A wrapper running `umask "$0"` (dash) gives exactly the umask passed. |
| F4 | 23 hostile arguments came through node-ssh byte-identical, direct and through sudo + wrapper: quotes, `$(id)`, backticks, newline, CR, tab, `--key=a b`, `-n`, `--`, a 64 KiB base64 string. |
| F5 | **Pre-existing:** node-ssh's `exec` drops an empty-string argument (`shell-escape@0.2.0`: `wp option update x ""` → `wp option update x `). It runs `cd <cwd> ; <cmd>`, so a missing `cwd` runs the command in `$HOME` (`node_modules/node-ssh/lib/cjs/index.js:279-280`). |
| F6 | Under sudo: `HOME=/var/www`; `PATH` = secure_path (`/usr/local/bin/wp` found, `~/bin/wp` not); cwd kept; environment dropped unless passed through `env VAR=…`. |
| F7 | WP-CLI writes nothing to `HOME` for zip installs, `eval`, `option`, `plugin list`. Only download installs try `/var/www/.wp-cli/cache`: they warn, then succeed. |
| F8 | An unresolvable hostname makes every sudo call add `sudo: unable to resolve host <name>[: <reason>]` to **stderr** (`Name or service not known`, or `Temporary failure in name resolution` when no resolver answers; other `sudo:` warnings, e.g. a world-writable `sudo.conf`, may precede it). Exit codes and stdout are unchanged. Cost per call (sudo 1.9.15, 2026-11-13, ubuntu:24.04 and the twins): ~4 ms when the resolver answers or refuses; **~20 s** when it never answers (glibc's 5 s × 2 attempts, A and AAAA; 2 s with `timeout:1 attempts:1`). The suite absorbs the line itself, never asking for the host to change (12.11b). |
| F9 | sudo + wrapper add ≤ 10 ms per call (83–88 ms → 87–98 ms per round-trip). |
| F10 | A killed runner leaves the remote command running, with or without sudo (as today). Only the same identity, or root, can kill it. |
| F11 | `--user=<login>`: `get_current_user_id()` is that user, also with `--skip-plugins --skip-themes`. No database change from the flag. A missing login → exit 1 `Error: Invalid user ID, email or login: '<login>'` from every WordPress-loading command. `core is-installed`, `cli info`, `core version`, `config get` and `db query` ignore it. Re-measured 2026-11-11 (twins, WP-CLI 2.12, PHP 8.5): the login quoted raw (`'o'b"$(id)'`), after 53 PHP 8.5 `Deprecated:` lines on stderr; `--user` runs `Fetchers\User::get_check` in `Runner` (ID if numeric — warning when also a login —, email if email-shaped then login, else login; `Invalid user login: '…'` under `WP_CLI_FORCE_USER_LOGIN`); `ADMIN`, `QA@Example.Test` and `1` all resolve the admin (MySQL's case-insensitive match). |
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
| Probes go through `exec`: `detectSiteOwnership` (`stat`), `probeIdentity` (`id`), declared-owner lookups (`id -u`, `getent`), `elevationSupport` (`sudo -n true`), docker `pwd`, `resolveOnTarget` (`readlink -f`). | `ownership.ts:297, 309, 509-510`; `exec.ts:743, 966, 828` |
| The pre-flight calls `exec(transport, "wp", …)` directly (not `wpCli`): `wp --info` (gate, hint names `transport.username`), the locale check with its own `--user`, `core is-installed`. | `setup/preflight.ts:159, 302-306, 403, 446` |
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
| `same-user` | mode `docker`/`local` (checked first: `effectiveRunAs` is `undefined` there), or the transport user already is the identity (`auto`: only once verified — else `owner-not-web`/`unverified`) | itself (no sudo); umask as today | ✓ |
| `fallback` | `runAs` asks for it but there is a reason (below) | transport user + today's hand-over | ⚠ the reason and its fix |
| `disabled` | `runAs: false` (the opt-out), or a transport from `asTransportUser` | transport user + today's hand-over | note (silent for `asTransportUser`) |

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
  server over HTTP (12.3) and write `site-identity.json` in the cell's auth folder, keyed
  by `installKey`: owner, web identity, web umask, verdict.
  - Workers read it. `site` only when the web identity equals the owner.
  - No verdict (e.g. `--no-deps`) → `fallback/unverified`, decided before any probe.
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
| As today | a scenario whose premise is two users (12.10), or any single call that must be | `asTransportUser(transport)` → a copy with no `wpUser`, and `runAs: false` on `ssh` (docker/local have no `runAs`) |
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
- The check, once per install, runner and login per process, without `--user`, in the root: one
  `wp --skip-plugins --skip-themes eval` of WP-CLI's own `Fetchers\User::get_check(<login>)` (what
  `--user` runs, §1.1 F11; the login through `phpLiteral`), echoing one marked line: `is_numeric`,
  `user_can(…, 'manage_options')`.

  Outcomes:
  - Cached as "drop", warned once: the exact `Invalid user ID, email or login` answer; a numeric login
    (WP-CLI reads it as an ID: another user, or its own ID and an `Ambiguous user match` warning
    quoting it on every call); a non-admin. Any other user found is the one `--user` will act as (the
    database's collation matched it), so it is trusted.
  - Unknown (WordPress cannot boot yet, no marked line): not cached; that call and every call for
    30 s run without `--user`, then one checks again.
- Mid-process removal (a DB reset or restore): when a `wpCli` call fails with that exact error (SGR
  escapes removed: `color: true` colours `Error:`), warn once, retry the call once without `--user`,
  and make the verdict unknown (checked again after the 30 s). Safe: WP-CLI resolves `--user` in an
  `init` hook, before the command dispatches.
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
| Libraries | `node-ssh` ^13.2.1 (`execCommand` only since 12.1: its `exec`'s `shell-escape` 0.2.0 bypassed); execa ^10; `@playwright/test` ^1.62 (`request.newContext` for the probe; `BrowserContext.request` for the settling request, which shares the context's cookies); no new dependency |
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
| 12.0b | Compose, npm scripts, sites overlays, `transport.port`, twin CI (done 2026-11-10) | 12.0a | 12.3 | S / S |
| 12.1 | ssh command line: our quoting, `cd … &&`; an executing ssh test server (done 2026-11-10) | — | 12.0a, 12.2 | S / M |
| 12.2 | Config: `runAs`, `umask`, `wpUser` (done 2026-11-10) | — | 12.0a, 12.1 | S / S |
| 12.3 | `wp/site-identity.ts`: states, probes, web probe and verdict file, `asTransportUser` (done 2026-11-10) | 12.2 | 12.0b | M / H |
| 12.4 | Exec wiring: wrapper, `execAsTransport`, probe callers moved, stderr noise (done 2026-11-11) | 12.1, 12.3 | — | M / H |
| 12.5 | Staging through an inbox; staging owned by another identity (done 2026-11-11) | 12.4 | 12.6, 12.7 | S / M |
| 12.6 | `--user=<login>` (done 2026-11-11) | 12.4 | 12.5, 12.7 | S / M |
| 12.7 | Ownership, residue, log, files in the `site` state (done 2026-11-11) | 12.4 | 12.5, 12.6 | M / M |
| 12.8 | Install outputs, handed over in fallback (done 2026-11-12) | 12.7 | 12.9, 12.10 | S / S |
| 12.9 | Pre-flight and healthcheck reports, banner, sudoers checks (done 2026-11-12) | 12.3–12.6 | 12.8, 12.10 | M / M |
| 12.10 | BackWPup on the new system; the two-user scenario opts back; private folder (done 2026-11-12) | 12.0b, 12.5–12.7; step 4 also 12.9 | 12.8, 12.9 (steps 1–3) | M / M |
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
| `no-wp` | as `site`, `wp` only in `~ubuntu/bin` | outside group | `(ALL)` + `!log_allowed` | `fallback/no-wp` | as `legacy` requirements; warns |
| `wpconfig-root` | as `site`, `wp-config.php` `root:www-data 644` | outside group | `(ALL)` + `!log_allowed` | `site` | WP Rocket scenario green via 12.14 |

`legacy-777` and `owner-mismatch` (docroot not the web server's) define `FS_METHOD` `direct`; every
other variant leaves it undefined. `check.sh` proves both, and that a web request's
`get_filesystem_method()` is `direct` in every variant (12.10).

### 12.0a — Twin images and variants (done 2026-11-10)

`docker/ssh-cells/`; its scripts' headers say what each does. Build from that folder:
`docker build -f Dockerfile.<apache|nginx> -t wpme-ssh-<stack> .`. Reset: `docker exec <c>
/opt/twin/site.sh <variant>` (it ends with `check.sh <variant>`, which proves owners, modes,
membership, sudo's rule and logging, `wp`'s location, cron, PHP limits, no stray process, and an HTTP
login). Every variant passed on both stacks; both images also build and pass on amd64 (emulated).

What 12.0b must know:
- **Container env:** `TWIN_AUTHORIZED_KEY` (required for SSH), `TWIN_HTTP_PORT` (publish it as
  `<port>:<port>`: the site listens on 80 and that port, so `http://localhost:<port>` works from the
  host and for WordPress's loopback and the system cron), optional `TWIN_SITE_URL`,
  `TWIN_ADMIN_USER`/`TWIN_ADMIN_PASSWORD` (default `admin` / `twin-admin-password`; safe characters
  only), `TWIN_VARIANT` (first boot, default `legacy-777`). Healthy = verified site + a static file on
  both ports.
- **Restarts:** a boot keeps a verified site as runs left it; a reset cut short is redone on the next
  boot. `docker stop` takes ~2 s; set `stop_grace_period: 30s` anyway.
- **The sudo log** (`/var/log/sudo-twin.log`, emptied per reset) holds refused calls even under
  `!log_allowed`: check.sh logs one as its control, so assert "no allowed `COMMAND=` line", not "no
  line". `sudo -n -l` on the twins lists `logfile=…`, absent on the cells: 12.9's parser must ignore it.

Decisions:
- `!log_allowed` on every sudo variant but `owner-mismatch`, so each variant isolates one condition.
- WordPress 7.1.4 (current stable; the cells run 7.2-beta1 and 6.8.3). Apache's CLI `memory_limit`
  256M, as on `pro@apache`.
- The ondrej/php key is pinned by fingerprint (`B8DC7E53…4AD4CAB6`), not taken from
  `add-apt-repository`; PPA packages are pinned by minor only (it keeps current builds only).
- `no-wp`: ubuntu's `.bashrc` puts `~/bin` on `PATH` for non-interactive SSH too, modelling a
  per-user install that works over SSH but is off sudo's `secure_path`.
- A reset kills every process outside the twin's own (sudo's root children and orphans included),
  stops sshd and cron for its whole length, and clears crontabs, extra sudoers files and databases,
  `/tmp`, `/var/tmp`, PHP sessions, `/var/www` (but `html`) and ubuntu's home (but its dotfiles and
  `.ssh`). Root runs the site's PHP only on the pristine copy; checks run WP-CLI as `www-data`.

Facts found (2026-11-10, both twins):
- nginx sets its own umask to `0000` when it daemonizes; only PHP-FPM's (`0022`) matters for files.
- The PPA's PHP 8.5 `php-fpm.conf` names no pid file: start it with `--pid`.
- With `!log_allowed`, sudo still logs a refused call (`-g` a group outside the rule).
- A `'` in `wp core install --admin_password` makes that login fail over the web;
  `wp user update --user_pass` with the same value logs in. Hence the twins' password charset.

### 12.0b — Compose, scripts, overlays, docs (done 2026-11-10)

Usage and settings: [configuration.md → SSH twins](../guides/configuration.md#ssh-twins). What later
phases use:
- `npm run env:cells:up` (key, build, free-port check, `compose up --wait`, host-side port proof,
  overlays, a `loadSites` check), `env:cells:reset -- <apache|nginx> <variant>` (~6 s),
  `env:cells:down [-- --force] [-- --purge-key]` (overlays, containers, volumes; images kept).
  `docker/ssh-cells/cells.sh` + `docker-compose.yml` (project `wpme-ssh`).
- Overlays: `ssh` to `127.0.0.1:2210` (apache) / `:2211` (nginx) as `ubuntu`, `rootDir`
  `/var/www/site/public`, site `http://localhost:8110` / `:8111`, `runAs` absent. **12.4 adds
  `"runAs": "auto"`** in `cells.sh`'s `write_overlays`.
- Twin specs: gate and sites in `src/common/__fixtures__/ssh-twins.ts` (`sshTwinsEnabled`,
  `TWIN_CELLS`, `twinSite`); first spec `src/common/setup/ssh-twins.spec.ts` (`verifySite` on all four
  cells). A spec needing a variant holds the twin (`withTwin`, 12.4), resets it (`resetTwin`) and
  puts `legacy-777` back.
- CI: `.github/workflows/ssh-twins.yml` builds both images with `docker/build-push-action` (GitHub
  layer cache per stack), `env:cells:up` with `TWIN_SKIP_BUILD=1`, then the twin specs and
  `npm run healthcheck`; `env:cells:down` always.

Decisions:
- **`transport.port`** (`ssh` only, whole number 1–65535, default 22): the twins share a host, and no
  port existed. Part of `connectionKey`/`targetKey`/`installKey` and of `describeTarget`
  (`user@host:port`), since both twins have one host and root.
- A compose project apart from `docker/docker-compose.yml`: `env:down` never removes the twins.
- **Deviation: the key is per user, not `docker/ssh-cells/.keys/`** —
  `~/.local/share/wp-media-e2e/ssh-twins/` (`TWIN_KEY_DIR`). The twins' names are fixed, so every
  checkout shares one set; a per-checkout key made a second checkout's `up` recreate them and break
  the first's overlays (measured). Containers carry their creating checkout
  (`wpme.ssh-twins.checkout`, physical path); another checkout's `up` never builds (shared tags) and
  refuses a missing twin, a `config-hash` label unlike `compose config --hash` or an image unlike its
  tag's (not `--dry-run`'s text: `COMPOSE_PROGRESS=quiet|json` hid a recreate), its `down` refuses
  without `--force`; `--purge-key` alone removes the key. The key folder is used or purged only when
  `cells.sh` made it (marker `.wpme-ssh-twins` + key comment `wpme-ssh-twins`): never `~/.ssh`.
- Free ports checked on `127.0.0.1` and `::1`, the site on `localhost` and `127.0.0.1`: macOS resolves
  the overlays' `localhost` to `::1` first, so a `::1`-only listener answered the runs (measured).
- Ports on `127.0.0.1` only; overlays 0600 (they hold the password).
- Overlays alone (no `sites.json`) replace the example: every run then sees only the twin cells
  (measured: `E2E_CELL=twin-nginx npm run test:wp-rocket -- --grep @noauth` passes against the twin).
  CI's smoke has no overlay, so it is unchanged.

Verified 2026-11-10 (macOS arm64, Docker Compose 5.5): `env:cells:up` from clean (both builds, ~2.5 min;
again ~3 s); healthcheck 4/4 in `legacy-777` (WP Rocket `twin-apache`/`twin-nginx`, BackWPup
`pro@twin-apache`/`pro@twin-nginx`, 8/8 checks each); twin spec 4/4 (a wrong port in an overlay fails
it); `reset -- nginx site` then `legacy-777`; `env:cells:down` leaves nothing. After the audit fixes
(2026-11-11, ports 2230/2231/8130/8131): a second checkout's `up` keeps both containers (same IDs;
its rebuilt images get new IDs, compose keeps the twins) and both checkouts' healthchecks pass 4/4;
its `up` with another password and its `down` both refuse; a taken port fails `up` naming it, and
with that check bypassed the host-side proof fails naming the port (and the twin's port stayed
unreachable after the listener left, though compose reported it healthy); a `sites.json` clash
removes the overlays and prints the loader's message; `down` with Docker unreachable (a stub `docker`
failing `info`) removes the overlays (and the key with `--purge-key`), exit 1. **Open:** the workflow's
first green run on GitHub (done criterion; run by the supervisor on push).

### 12.1 — ssh command line (done 2026-11-10)

`exec.ts`: `shellQuote`, `sshCommandLine` (`cd -- <cwd> && exec <file> <args…>`, every word quoted,
the program too), sent with `execCommand` and no node-ssh `cwd`. The ssh pre-flight runs `wp --info`
and the root check from `/`, and `core is-installed` only once both passed.

Audit fixes (2026-11-10, two audits; mutants re-run):
- `sshCommandLine` refuses a non-absolute `cwd` (`cd -- ''` is a no-op) and a program starting with
  `-` (dash's `exec` takes no `--`, measured in `ubuntu:24.04`); `sites.ts` refuses a non-absolute
  `rootDir` on every transport.
- Every transport refuses a lone surrogate like a NUL (sent as `U+FFFD` otherwise).
- A signal kill throws `CommandKilledError` on every transport (over ssh `exec` left no shell to
  return `128 + n`, as dash or bash < 5.1 did with the old `cd …; wp` line); `readDebugLog`/
  `clearDebugLog` fall back on it, the pre-flight names it a crash (check 1 stays WP-CLI's failure,
  its own hint, and still checks the root). Neither status nor signal (connection disposed) is a
  plain `Error`.
- A crash reading the admin locale is a boot failure: the cell-plugin recovery and `pluginBreaksBoot`
  blame the plugin only when WordPress boots with its slug skipped (a crash there too is not its).
- `sites.ts` quotes a relative `rootDir` (JSON, ≤ 200 code points): a path is no secret.
- Documented: `wp` must be an executable on the login's `PATH`; the login shell must be POSIX
  (probed since 12.9: the login-shell gate).

**Test seam for 12.4/12.5** (`src/common/__fixtures__/ssh-server.ts`): `startSshServer()` runs each
command line with `/bin/sh -c` as the runner's user, from a temp `home`, with `bin/` first on `PATH`.
- `bin/sudo` (fake) logs its argv (`sudoCalls()`), refuses as F2 while `denySudo(true)`, else skips
  `-n`, `-u X`, `-g X` up to `--` and `exec`s the rest; `addProgram`/`removeProgram` manage more;
  `e2e-print-argv` + `decodeArgv` prove an argv byte for byte.
- SFTP OPEN/WRITE/CLOSE write real files (others: `OP_UNSUPPORTED`); `commands` records each line.
- `transport()` is rooted at `root` (a path with a space); `steerNodeSsh` points node-ssh at the port.
- Bounded: each command's process group is killed on channel close (the channel is drained, or it
  never emits `close`), after 20 s, and at `close()`, which first ends every client connection. A
  failed start removes its temp folder; keys are regenerated until ssh2 parses them (ssh2 1.17
  writes an unparsable ed25519 key ~1 in 360); `processGone` counts a zombie as dead (containers
  without init). Spec hooks undo only what `beforeAll` set up.
- ssh2's server refuses packets over 35,000 bytes, so a line over ~34 KB fails as `Unable to exec`
  there (OpenSSH took 64 KiB, F4); the 64 KiB case is a `shellQuote` table row.

Found (measured 2026-11-10 with the seam): node-ssh's `execCommand` decodes each output chunk alone
(`chunk.toString()`), so a multi-byte UTF-8 character split between chunks becomes `U+FFFD`
(200,000 × `é` came back with one). Fixed in 12.4.

### 12.2 — Config (done 2026-11-10)

`config/run-as.ts` (`parseRunAs`, `parseUmask`, `namesRoot`, `idOutOfRange`, `runAsIdentity`,
`effectiveRunAs`, `effectiveUmask`, `DEFAULT_SSH_RUN_AS` (`false` then), `DEFAULT_UMASK = "0022"`), wired in
`sites.ts`; `RunAs` type and the
fields in `types.ts`. No command reads them yet: 12.3 reads `effectiveRunAs`/`effectiveUmask`, 12.6
`wpUser`; 12.11 flipped `DEFAULT_SSH_RUN_AS` to `"auto"` (`run-as.spec.ts` pins it).

- `runAs` (`ssh`): `"auto"`, `false`, or `"user:group"` through `parseOwnerSpec`, stored trimmed as
  `user:group`. Root refused as user **and group**: by name `root` or an all-zero id (`0`, `00`); a
  non-root name mapped to uid 0 is left to 12.3's probe. A group of 0 is refused because the web
  server never runs with it and every file written would grant root's group access. A numeric id
  above 4294967294 (`(uid_t) -1` and up) is refused too.
- `effectiveRunAs`: `undefined` off `ssh` (never `false`, the opt-out); `effectiveUmask` likewise.
- `umask` (`ssh`): a text matching `/^0?[0-7]{3}$/`, stored as four digits; **owner digit 0**
  (`& 0o700`, stricter than the first draft's `& 0o600`): `0177` makes new directories `0600`, which
  their owner cannot enter. A JSON number is refused.
- `docker`/`local`: `runAs` or `umask` present, any value (`false` too), fails the load.
- Unknown keys refused, on a transport (allow-list per mode) and on a site, quoting the key escaped
  to printable ASCII (≤ 64 code points, first five keys) and listing the allowed ones. Phase 11 must
  add `profile` to the transport lists. Still dropped silently (follow-up): unknown keys of a cell
  object (`{ edition, sites }`) and of `overrides` and its `storage.ftp`/`storage.s3`.
- `username` with surrounding whitespace refused (never quoted): `--user` matches exactly.
- `wpUser`: every transport, copied verbatim from `username`; any declared value refused. Every site
  requires `username` (placeholders included), so every loaded transport has one; hand-built (unit)
  transports have none.
- Messages: `[sites] <file> → <cell>.sites[<i>].transport.<field> …` (`<cell>[<i>]…` for a cell
  written as a bare site array) with the rule; a refused text is
  described by its length, never quoted, except a umask of the octal shape.
- Nothing serialises a transport (project metadata carries only routing; the orchestrator reads
  `host`), so reports and run facts gain nothing.

### 12.3 — `wp/site-identity.ts` (done 2026-11-10)

Three modules, documented in [wordpress-automation.md](../architecture/wordpress-automation.md#site-identity-wpsite-identityts):
- `wp/site-identity.ts`: `IdentityState` (`site` with `target`/`identity`/`umask`;
  `same-user` `mode`|`transport-user`; `fallback` `reason`+`detail`; `disabled`
  `config`|`as-transport-user`),
  `decideIdentityState` (pure: state, or the next probe `site`|`run`), `FALLBACK_REASONS` (what +
  fix), `describeIdentityState`, `runProbeArgv`, `classifyRunProbe`, `runIdentityFrom`,
  `resolveSiteIdentity` (memo per `installKey`+`runAs`+`umask`, shared promise, a throw rethrown and
  dropped), `registerSiteIdentityVerdicts`, `resetSiteIdentityCaches`, `asTransportUser`.
- `wp/web-identity.ts`: `PROBE_PHP`, `WRITE_SCRIPT`/`ROOT_WRITE_SCRIPT`, `writeFailure`, `probeWebIdentity`, `sweepProbeFiles`, `checkWebIdentity`,
  `webVerdict`, `writeSiteIdentityFile`/`readSiteIdentityFile`/`parseSiteIdentityFile`.
- `wp/run-as-argv.ts` (pure, imports nothing of `wp/`): `RUN_AS_SCRIPT`, `RUN_AS_NAME`, `runAsArgv`, `sudoName`/
  `isSudoName` (`#id` for digits) — 12.4's argv, built here so the run probe uses the exact wrapper.
  F8's `withoutSudoNoise`/`hasSudoNoise` live in `wp/sudo-noise.ts` (12.11b).
- `ownership.ts` exports `probeSiteOwnership` (unmemoised, throws); the fake `sudo` exports
  `$E2E_FAKE_SUDO_USER`/`$E2E_FAKE_SUDO_GROUP` so a fake `id` answers as the identity. Spec fixtures:
  `probe-web-server.ts` (HTTP/HTTPS, gzip/chunked replies), `excl-dd.ts` (a `conv=excl` `dd` where the
  runner's, BSD, lacks it; the ssh fixture installs it), `fifo.ts`'s `tapFifo`, `tether.ts` (a
  spawned shell command SIGKILLed with its group when the spec's worker dies; `php -S`, ssh-server).

Decisions (the plan left them open, or the code showed better):
- **The probe file is written by `sh -c 'umask 022 && printf "%s" "$1" | dd of="$2" conv=excl
  status=none'`, not `evalPhp`:** one argv for the transport's user and root (`wp` never runs as root),
  no WordPress boot, no recursion through the resolver once 12.4 routes `wpCli` through it. Content
  constant, path an argument. **`O_EXCL`, not `set -C`** (audit): the web user may own the root and
  plant a symlink between the guards and root's write; dash/bash `set -C` writes through one to a FIFO
  or device, `dd conv=excl` refuses any existing path (measured, coreutils 9.4). A `dd` without
  `conv=excl` (BSD, BusyBox 1.37) refuses the operand before opening → `not-writable` naming it, no
  root retry. Root only when the user's write is refused for permission and elevation is `available`,
  after both path guards, from inside the root (`cd -P`, `pwd -P` = the guards' resolved root, else
  exit 3; `O_EXCL` covers the last component only: a root swapped for a symlink was written through
  before, measured). A failed write but `File exists` is followed by `rm -f` as its writer (`dd` on a
  full disk leaves an empty file, measured); the user's error stays in the detail. Removal by the
  writer (a transport-written file is never removed as root); the sweep escalates; a guard refusing a
  removal is a warning.
- **`auto` checks the verdict before "the transport's user already is it"** (audit): an SSH user that
  owns a docroot PHP reaches through its group (`sftp_x:www-data`) is `owner-not-web`/`unverified`,
  not `same-user`. A declared `runAs` goes through `runAsIdentity` (hand-built `root:root` →
  `no-identity`, no sudo call) and needs no verdict.
- `RUN_AS_SCRIPT`'s `$0` is `e2e-run-as`, umask/cwd `$1`/`$2`: dash names the wrapper in its errors
  (`e2e-run-as: 1: cd: can't cd to …`, measured), never the umask.
- **The verdict file lives in the cell's auth folder** (`dirs(product, cell).auth`, beside the
  logins), not the artifacts folder: the artifacts setup wipes that one and runs beside the auth setup.
  `wp/` takes `(dir, runId)` as arguments (it never imports `run-context.ts`).
- A verdict counts only for this `RUN_ID` (`stale` otherwise → `unverified`) and only when its owner's
  uid/gid equal the owner the process reads now (else `unverified`, "owner changed").
- `same-user` needs user **and** primary group to match (another group would change who else may
  write). Wanted halves compare by id when known (the owner, or digits), else by name.
- The run probe is `echo e2e-run-probe && { id || exit 91; } && { wp --info >/dev/null || exit 92; }`:
  the mark tells "the wrapper got in" from a refusal, and ids are read only after it (a banner cannot
  supply them). A `stat` name sudo cannot take (`-x`, `#…`, control characters) → `no-identity`.
- The probe's TLS: the login sets no `ignoreHTTPSErrors`, so neither does the probe (unit-proved with
  a self-signed server). The body: a declared `Content-Length` past 16 KiB is refused before reading
  (Playwright 1.63 has already buffered it whole), else its length read; a UTF-8 BOM is accepted.
- Unmapped web names are omitted from the verdict file and read back as absent (was: whole file
  `invalid`).
- Unit-proved `probeWebIdentity` against real PHP (`php -S`, skipped where `php` is absent).

Verified on the twins (2026-11-10, both images, containers removed): `site` (nginx) → probe written as
root (ubuntu outside the group, 755 root), `fpm-fcgi` www-data 33:33 umask `0022`, `owner-is-web`, state
`site` through the real sudo; `site` (apache) → `site`; `legacy-777` → `owner-not-web`
(`sftp_twin(1002):www-data(33)`); `no-sudo` → `no-sudo`; `no-wp` → `no-wp` (`/bin/sh: 1: wp: not
found`). The sweep removed a 2 h-old root-owned probe (escalated) and kept a fresh one; no allowed
`COMMAND=` line in the sudo log (`!log_allowed`); no probe file left. After the audit fixes (nginx
`site`): `owner-is-web` → `site` through the real sudo and the new wrapper; with
`readlink` slowed 0.8 s and a `www-data` watcher planting a symlink to a root-read FIFO, 3/3 planted,
3/3 `not-writable` (`dd: … File exists`), 0 bytes through; the old `set -C` line, same plant, delivered
its payload.

### 12.4 — Exec wiring (done 2026-11-11)

Documented in [wordpress-automation.md → Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects).
- **Split, to break the cycle:** `wp/exec.ts` → `wp/transport-exec.ts` (git rename; everything but
  `exec`/`wpCli`, plus `ExecAs` = `transport`|`root`|`site`, `execAsTransport`, `execAsSite`,
  `sshWrappedLine`, `decodeOutput`); the new `wp/exec.ts` re-exports it (`export *`) and adds
  `exec`/`wpCli`, which call `resolveSiteIdentity`: `site` → `execAsSite(transport, state, …)`, else
  `execAsTransport`. `ownership.ts`'s probes and parsers moved to `wp/owner-probe.ts` (re-exported by
  `ownership.ts`). `transport-exec`, `run-as-argv`, `owner-probe`, `site-identity`, `web-identity`
  never load `exec.ts`/`ownership.ts` at run time (`layering.spec.ts`, type-only imports not followed).
- **Line in `site`:** `exec <runAsArgv quoted>` (no outer `cd`); stderr through `withoutSudoNoise`
  (root's too since 12.11b; the transport's untouched); messages name the program. Output: `onStdout`/`onStderr`
  buffers decoded once. A `sudo` refusal after verification (`isSudoRefusal`: exit 1, stderr only
  `sudo:` lines and/or the unprefixed, multi-line `Sorry, user … is not allowed to execute '…'`)
  throws `SiteIdentityRefusedError` (program + site, no stderr: sudo quotes the command) and
  `forgetSiteIdentity(transport, promise)` drops that resolution only (`resolveSiteIdentity` returns
  the memoised promise itself), so the next command re-resolves once.
- **Moved to `execAsTransport`:** `stat`, `id`, `id -u`/`getent` (owner-probe, ownership), the run
  probe and `id` (site-identity), the probe's `sh` write, `find`, `rm` (web-identity), `sudo -n true`,
  `readlink -f`, docker `pwd`, and the pre-flight's `ls -d <root>/.` check (its hint names the SSH
  user). The pre-flight's `wp --info` and `core is-installed` stay `exec` (as the site in `site`).
- **`planOwnership`** reads who commands run as: `site` → the state's identity (`RunIdentity` gained
  `groupIds`/`groupNames`); else `probeIdentity`'s cache (transport user only). A throw resolving the
  state → `unknown-identity`, not cached. (12.7 replaced the `site` comparison; see there.)
- **Overlays:** `cells.sh` writes `"runAs": "auto"`; since 12.9 runs and the healthcheck verify it.
- **Test seams:** `__fixtures__/fake-sudo.ts` `SKIP_SUDO_OPTIONS` (`-n`, `-u`/`-g` exported, `--` or
  first non-option; unknown option → exit 1), used by `ssh-server.ts` and the stubs in `exec.spec`,
  `log.spec`, `residue.spec`, `staging.spec`, `plugin-dir.spec`, `copy-host.ts` (its `sudo -n true`
  now parsed, not shifted away); `denySudo({ user })` refuses only `-u <user>` (root and
  `sudo -n true` still run); `__fixtures__/hostile-arguments.ts`; `ssh-twins.ts` `TWIN_VARIANTS`
  (pinned to `lib.sh`), `resetTwin`, `withTwin` (lock folder in the fixed `/tmp/wpme-ssh-twins/`, `1777`,
  `lockDir`/`pollMs` for specs; made whole with its pid and renamed onto the path; a dead holder's
  lock taken over under `<lock>.takeover`, re-judged, renamed away and checked; released by rename,
  loud if no longer ours; another user's stale lock waited on; a pid counts only as `[1-9]\d*`, else
  the pidless-age rule; a lock folder of another user's that is not sticky + world-writable is
  refused): the pre-flight twin spec holds it too.
- **Specs:** `exec.site.ssh.spec.ts` (22: today's line for `runAs` absent/false, `fallback/no-sudo`
  and `owner-not-web` with the probes' exact lines, an `asTransportUser` copy; in `site`: hostile args
  through the wrapper, `wpCli`, umask/cwd/missing cwd, `#33`, noise, kill label, probes/root
  unwrapped, partial refusal → `no-sudo` with elevation `available`, the pre-flight's two lines,
  `planOwnership`; UTF-8 split on both paths). `exec.ssh-twins.spec.ts` (14: every variant × stack).
  15 mutants, all killed (decode, noise ×2, routing, outer `cd`, `planOwnership`, layering, label,
  per-user deny, groups, pre-flight `ls`, `elevationSupport`, run probe's `/`, `-u` export, lock).
- **Audit fixes (2026-11-11):** sudo refusal mid-run thrown + re-resolved (was read as the
  program's exit 1: `isPluginInstalled` true → false); noise stripped only when leading; `auto` with
  no verdict decided before `stat`/`id`; `withTwin`'s racy takeover (8 processes on a dead lock lost
  holds) and per-user `$TMPDIR` lock folder replaced (above). New specs: `exec.site.ssh.spec.ts` +6
  (refusal, late noise + root stderr kept, program's own exit 1, `www-data:deploy` user/group in
  place + per-user deny, `execAsSite` on docker/local, `planOwnership` run-probe failure →
  `unknown-identity` then `unnecessary`), `isSudoRefusal`/noise cases, `layering.spec.ts`
  `valueImports` cases, `ssh-twins.spec.ts` lock cases (8 processes × 12 rounds on a planted dead
  lock), `exec.ssh-twins.spec.ts` +2 (rule withdrawn mid-run, real sudo). 25 mutants: 24 killed;
  1 equivalent (the takeover's post-move check, unreachable under the takeover folder).
- **Re-review fixes (2026-11-11):** sudo's explicit deny (`Sorry, user …`, measured on sudo 1.9.15p5,
  no prefix, quoting the arguments over several lines) now a refusal in `exec` and `no-sudo` in
  `classifyRunProbe`, never quoted (`SUDO_DENIED`); a late refusal forgets only its own resolution;
  lock: pid shape, foreign non-sticky folder refused. Specs: explicit deny (unit + fake sudo
  `denySudo(…, "explicit")`), late refusal (one extra run probe), refusal on one of two installs (none),
  lock: aged `.takeover`, swap between judging and moving (`removeIfStale`'s `beforeMove` seam),
  EPERM waited on (`tryLock`'s `takeOver` seam), pids `0`/empty/`-1`, `ensureLockBase(base, uid)`.
- **Verified on the twins** (2026-11-11, ports 2270/2271/8170/8171): every variant reached its state
  on both stacks — `legacy-777`/`owner-mismatch` → `fallback/owner-not-web`, `no-sudo` → `no-sudo`
  (elevation `unavailable`), `no-wp` → `no-wp`, `site`/`site-775`/`wpconfig-root` → `site`; `id -un`
  `www-data` in `site`, `ubuntu` otherwise; the 25 hostile arguments byte-identical through the real
  sudo; a `wp option` round-trip (UTF-8, `$(id)`, quotes); a new `wp-content` file `www-data:www-data
  644` in `site`, `ubuntu:ubuntu 664` in fallback (ubuntu's umask `0002`), refused in `no-wp` (755,
  outside the group); `elevationSupport` `available` (but `no-sudo`). Pre-flight twin spec 4/4 and
  healthcheck 4/4 in `legacy-777` and in `site` (`unverified` → as today). BackWPup
  `pro@twin-nginx`, 2 `@plugin` scenarios (`cli-reads`): `legacy-777` green; `site` with `auto` fails
  as today (`.e2e_temp` not creatable by `ubuntu`); `site` with a declared `www-data:www-data` reaches
  `site`: staging is created as `www-data`, then the SFTP upload as `ubuntu` fails — 12.5's inbox.

Left open (owners named):
- **12.5 (done):** staging in `site` (above, measured).
- **12.7 (decided: kept):** `ownership.ts`'s `warnOnce` dedupes per install + reason across states
  (an `asTransportUser` copy shares an install's warnings). In `site` only `bad-input`/`bad-owner` can
  warn (state-independent text); every other state warns the same text and fix for the same reason.
- **12.9 (done):** the `wp --info` gate's hint names the identity in `site`. (Root's sudo stderr kept
  F8's line until 12.11b, which strips it there too.)
- **Known limit:** a program run as the site that itself exits 1 printing only `sudo:` lines is read
  as sudo's refusal (none of the suite's does).
- **12.9 (decided: gate, kept):** transport-level and root commands still start with `cd -- <cwd>` as
  the SSH user (default `cwd` = the root). The pre-flight's existing "rootDir accessible" check
  (`ls -d <root>/.` as the SSH user) already fails a docroot the SSH user cannot enter (`750 www-data`)
  with its fix, so it stays the gate; running them from `/` (relative operands made absolute first,
  `log.ts`'s elevated `rm`/`cat`) is left for a host that needs it.

### 12.5 — Staging through an inbox (done 2026-11-11)

Documented in [wordpress-automation.md → Staging in the `site` state](../architecture/wordpress-automation.md#staging-in-the-site-state-wpsite-stagingts).
- **Where:** `wp/site-staging.ts` (`stageThroughInbox`, `ensureSiteStagingDir`, `sweepStaleInboxes`,
  `inboxPath`; every remote step behind `SiteStagingOps`). `stageArtifact` routes: ssh in `site` →
  inbox; else `mkdir -p` + `copyIntoTarget`, unchanged. Not in `copyIntoTarget`: `transport-exec.ts`
  is the probe layer and may not resolve the state nor reach `fileChecksum` (`layering.spec.ts`).
- **Decisions:** runner SHA-256 first (a bad source makes nothing remote); inbox file named `upload`
  (no caller name in a path); `chmod 0644 <abs>` without `--` (BSD `chmod` reads `--` after the mode
  as a file); `cp -f` (replaces a target file it cannot open); the identity's ensure is one constant
  `sh -c` exiting 3 only when the area or category exists unwritable (another user's), so a full disk
  or an unwritable parent never heals; heal only the **relative** area, after
  `assertResolvedInsideRoot` (a linked parent would carry the `rm -rf` out of the site), warned once
  remade; an **absolute** root is never healed (it may be shared: refused naming the override);
  `cleanSiteStaging`'s root `rm` refuses a target a link carries out (relative: inside the WP root;
  absolute: the root no link, the target inside it); the site checksum `--skip-plugins
  --skip-themes` (their output would break the digest; WP-CLI kept over `sha256sum`, as `files.ts`
  chose); inbox removal never throws (warns); `inboxRoot` must be absolute; the sweep only on
  whole-area cleanup in `site` (a per-entry clean stays narrow), `find -H` (a linked root such as
  macOS's `/tmp` is followed, nothing below it), `-user "$(id -u)"` in a constant `sh -c` (no extra
  probe), `-type d`.
- **Known limits:** `cp` onto an existing **directory** copies into it (GNU and BSD; `-T` is GNU-only):
  the checksum then refuses, leaving `<target>/upload` until teardown. A shared absolute root
  (`E2E_SITE_STAGING_DIR` is global) used by sites of different identities or states fails on a
  category another made — `site`: the refusal; fallback: the upload error, naming the shared root —
  and never deletes; fix: a `transport.stagingDir` per site. The resolved-path checks precede their
  `rm` (a link swapped in between is not seen).
- **Specs:** `site-staging.spec.ts` (22: order and users; the inbox removed after each failing step,
  never after its own `mkdir`; checksum mismatch; removal warn-only; heal only on exit 3, confined
  first, as identity then root, warned only once remade; absolute refused; other failures never
  healed); `staging.site.ssh.spec.ts` (26: the exact lines in `site`, missing inbox root, mismatch,
  `cp` failure, directory target; relative heal (`readlink` before `rm`, the warning), a linked parent
  refused with the outside kept, a file in the category's place never healed; absolute: refused with
  another site's file kept, a fallback upload's hint; runAs absent/false/`asTransportUser`/`no-sudo`
  send today's single `mkdir -p`, and their whole-area cleanup one `rm` and no sweep; the sweep
  against old/young/wrongly-named/link entries and through a linked root, its full `find` argv;
  `cleanSiteStaging`'s root `rm` refused for a linked parent and a linked absolute root, run for a
  plain one; `siteStagingOps.asRoot` without and with elevation); `staging.ssh-twins.spec.ts` (8).
  Mutants, all killed: 12 at implementation (routing, `-p`, `finally`, checksum, age, `-type d`,
  `asSite` as transport, root escalation, …) and 12 from the audit: sweep gated on `runAs` (killed by
  the no-sudo/as-today cleanup), no `-user`, `asRoot` always,
  no confine before heal, absolute heals its category, heal on any failure, warn before remade,
  checksum booting plugins, no `-H`, `cleanSiteStaging` unguarded / its root-link check off, the area
  unchecked by ensure.
- **Verified on the twins** (2026-11-11, both stacks): `site` — a plugin zip staged through `/tmp`
  lands `www-data:www-data 644` with the runner's SHA-256 and `wp plugin install` takes it, no inbox
  left; a fallback run's `ubuntu` 775 area is removed (root) and made `www-data 755`; cleanup sweeps a
  2 h-old inbox and keeps a young one. `legacy-777` (`fallback/owner-not-web`): today's path, the file
  `ubuntu:ubuntu`, no inbox.

### 12.6 — `--user=<login>` (done 2026-11-11)

Documented in [wordpress-automation.md → `--user`](../architecture/wordpress-automation.md#wordpress-runs-as-the-sites-administrator---user-wpwp-userts).
- **Where:** `wp/wp-user.ts` (pure parts + the memo; no import of `exec.ts`, the check's runner is
  handed in); `wpCli` (`exec.ts`) resolves the state, asks `shouldUseWpUser`, prepends `--user`,
  retries once on `isUnknownUserError`. `phpLiteral` moved to import-free `wp/php-literal.ts`
  (re-exported by `php.ts`) so `wp-user.ts` can embed the login without the `php.ts` → `exec.ts` cycle.
- **Decisions:** every transport and state, per §2.3 (live runs with `runAs: false` get `--user`
  too); the check is **one** `wp --skip-plugins --skip-themes eval` of `Fetchers\User::get_check`
  (§1.1 F11; no login as a positional WP-CLI could read as a flag), not through `evalPhp` (which goes
  through `wpCli`: recursion), in the root without the caller's `cwd` (its verdict serves every
  caller); numeric logins dropped (WP-CLI 2.12 `Fetchers\User::get`: ID lookup, plus a warning
  quoting the login when it is also a login); any other user found trusted (the database's collation decides, as for `--user`:
  `ADMIN` and `Admín` name `admin` on the twins' `utf8mb4_unicode_520_ci`); the refusal matched as a whole stderr line quoting
  that login, exit 1, both fetcher messages, SGR escapes removed from stderr, stdout and the login;
  the retry's result replaces the refused one (its stderr quotes the login); unknown and a refusal
  wait `RECHECK_AFTER_MS` (30 s, clock injectable) before the next check — a refusal re-checking at
  once would cost three calls per call should the check and the command ever disagree; a thrown
  check is rethrown, not kept; warnings once per key and reason, naming the endpoint only.
- **Behaviour change:** WP-CLI calls `kses_remove_filters` only without `--user`; with it the admin's
  `unfiltered_html` decides (wordpress-automation.md). The locale pre-flight still passes its own
  `--user` via `exec`.
- **Lands live before 12.10, no gate (decided):** every cell gets `--user=<username>` at merge,
  `runAs: false` included. Evidence: on `legacy-777` (today's live case), BackWPup `cli-reads` +
  `cli-runs` on `pro@twin-apache` and `pro@twin-nginx` identical with and without `--user` (13 pass,
  the same 2 fail on both sides, below); BackWPup 5.7.8 source: activation does not depend on the
  user, the `wp-cli` history trigger comes from the job's start type, user meta is written only on
  admin/AJAX/REST hooks, and the debug log's "Runs with user:" line differs. The rest is 12.10's.
- **Specs:** `wp-user.spec.ts` (39: argv incl. the leading newline, the exact refusal plain/coloured
  and near-misses, every verdict, marked-line parsing with noise and escapes, key per
  install/runner/login, memo: concurrency, unknown/refusal waits on a fake clock, an old check never
  removing a newer one, throws not kept, warnings once per key × reason without the login);
  `wp-user.ssh.spec.ts` (19: lines without/with `wpUser`, email, missing / non-admin / numeric, not
  booting waiting, the retry once (plain and coloured) and its second refusal returned, the caller's
  `cwd` on every path and never on the check, a command's own refusal of `bob` kept,
  `asTransportUser`, `site` through sudo with no `--user` on the check, one answer per runner);
  `wp-user.ssh-twins.spec.ts` (4: both stacks × `legacy-777`/`site`: `get_current_user_id()` 1 for
  `admin`, `ADMIN`, `Admín` and the upper-cased email, 0 for the as-today copy, a subscriber, a nobody, `1`
  and a login equal to its own ID (raw `--user` shows WP-CLI's `Ambiguous` warning; `wpCli` none), an
  administrator deleted mid-process → retried, 0, warned). 51 mutants, all killed (the audit's 34
  plus escapes, waits, numeric, `cwd`, warning keys).
- **Verified on the twins** (2026-11-11): the twin specs above, and the existing twin specs (`exec`,
  `staging`, pre-flight) green with every loaded site carrying `--user=admin`. BackWPup on
  `pro@twin-{apache,nginx}`, with and without `--user`: in `legacy-777` the same 2 fail on both sides
  ("After a backup has run…", "A job run in the background…"; 12.10); in `site` all 15 failed at the
  `@plugin` hook's staging `mkdir` (no verdict yet), and pass since 12.9.

### 12.7 — Ownership, residue, log and files in the `site` state (done 2026-11-11)

Documented in [wordpress-automation.md → File ownership](../architecture/wordpress-automation.md#file-ownership-wpownershipts)
and [Elevated housekeeping](../architecture/wordpress-automation.md#elevated-housekeeping).
- **`planOwnership`:** `disabled` and `bad-owner` first (config), then `site` → `unnecessary`, before
  `unknown-ownership`, the declared ids and any comparison; `target` = `ownershipOf(identity)`, `site`
  = `{ installOwner?, declared? }` for the pre-flight. A declared `fileOwner` is neither resolved (no
  `id -u`/`getent`) nor enforced in `site`. `commandIdentity` returns `site`|`transport`; a throw
  resolving the state → `undefined` (`unknown-identity`), never the transport's user. `fromRunIdentity`
  deleted (dead). Fallback/disabled unchanged (grant, then root `chown`).
- **Pre-flight (`checkFileOwnership`, exported, returns checks):** in `site` "File ownership" names the
  identity as the writer, plus the install's owner when it differs (uid or gid); a declared
  `fileOwner` naming someone else (either half, by name or id) adds a passing "File owner override"
  line. Elsewhere `unnecessary` keeps "the transport's user already owns the install".
- **Residue, log:** both already ran "as themselves" through `exec` (the site in `site`) and escalated
  only what failed; the root fallbacks stay (a survivor another user left, a log the identity is
  refused). No state gate on root: gating would let an unreadable log pass the fatal gate. **Audit
  fix:** a data directory root had to `mkdir -p` in `site` stayed `root:root` (only `0777` hid it):
  now the missing components (read as root before the `mkdir`, from the target up to the first
  existing one, never past the root) get a root `chown -h -- <uid>:<gid>`, each behind
  `assertSafeElevatedTarget`; a failed `chown` warns (best-effort). Other states unchanged.
- **`files.ts`:** `SiteFile.writable`/`listLocatedFiles` TSDoc: the identity commands run as.
- **Root detection on the twins:** sudo's own log (`/var/log/sudo-twin.log`), with a drop-in
  `/etc/sudoers.d/99-e2e-log-allowed` (`Defaults:ubuntu log_allowed`, `loglinelen=0`; removed in
  `finally`, by the reset, and by `env:cells:up` from a twin whose spec lock has no live pid) so each
  allowed call is one `USER=` line. Negative control: one
  `execElevated(true)` → exactly one `USER=root … COMMAND=…/true` line.
- **Specs:** `housekeeping.site.ssh.spec.ts` (19, fake sudo, per-operand refusals as the site only;
  identity `www-data:web` 33/82 so swaps show): `site` unnecessary with another owner / unreadable
  owner / declared `fileOwner` (no `getent`), a state that cannot resolve → `unknown-identity`, no
  root; disabled/bad-owner kept; `runAs` false/absent, `asTransportUser`, `fallback/no-sudo` → exact
  root argv `-n true`, `chmod -R`, `chown -Rh`; data dirs as the site (`test`,`mkdir`,`chmod`); a
  refused `mkdir` → root `test -e` up to the first existing, `mkdir -p`, `chown -h -- 33:82` of only
  what was missing (nested parents too); a failed root `mkdir` hands nothing over; fallback hands
  nothing back itself; residue removed with no root, root `rm` only for the refused survivor;
  `debug.log` via `wp eval`, direct read/removal as the site, root only after a refusal.
  `preflight.spec.ts` +8 (`checkFileOwnership` lines). `ownership.spec.ts`: `fromRunIdentity`'s 2
  removed, `ownershipOf` 1 added. `exec.site.ssh.spec.ts` (12.4): 2 expectations gained
  `site: { installOwner }` (the plan's new field; same decision). `housekeeping.ssh-twins.spec.ts`
  (8: both stacks): `site` — fake plugin through `stageAndInstallPlugin` (`www-data:www-data`
  755/644, `unnecessary`), data dir 777, a written file 644, `listFiles` writable `true` / as-today
  copy `false`, log read + cleared through `wp eval` and through the direct route, residue + plugin +
  staging removed, zero `USER=root`, >10 `USER=www-data`; a root-owned `uploads` → root makes the data
  dir and its parent, both handed to `www-data` (`chown -h -- 33:33 …/made …/e2e-housekeeping`),
  `uploads` stays `root:root 755`, root only `true`/`test`/`mkdir`/`chown`; a root-owned survivor →
  root only `true`/`rm`/`test`; `legacy-777` → the install's owner via a root `chown -Rh`.
- **Twin spec hygiene (audit):** the direct log route's `wp-cli.yml` goes **above** the docroot
  (WP-CLI searches upward; measured on the twin) and requires a file exiting 1 only for 120 s (an
  expired copy boots, measured; `wp-cli.yml` removed first, since one requiring a missing file breaks
  WP-CLI); cleanups independent (drop-in, resting reset, host cleanup each run; `work`'s error wins);
  the probe zip is built per test in its output folder (emptied by the next run). SIGKILL mid-test
  (log route planted) left: the drop-in, the two files above the root, probe plugin, data dir,
  `.e2e_temp`, the zip, the lock folder; WP-CLI booted again once the 120 s passed, `env:cells:up`
  removed the drop-in, `env:cells:reset` the rest, the next unit run the zip, `withTwin` takes the
  stale lock.
- **Mutants (46: 39 unit + 7 twin, all killed, in an isolated copy):** the 19 above (reconstructed: site branch off /
  always; ids resolved before the site branch; `ownershipOf` swaps; site identity read as the
  transport's; prepare root-first / always escalating; removal root-for-all / root-first; log read
  escalating always; clear escalating after removal; log root fallbacks removed; chown before chmod;
  twins: branch always on `legacy-777`, prepare always escalating, removal root-first, log read
  escalating always, clear escalating after removal); the audits' M1–M11 (M1/M2/M8/M9 survived the
  audit: `ownershipOf` unit test, distinct ids, the pre-flight line tests, the resolve-throw test —
  `exec.site.ssh.spec.ts` already caught M9 but was outside the audit's spec list); A1 (9 + 2 twin: no
  handback, missing read as the identity, no stop at the first existing, handback in every state,
  ids swapped, chown after a failed mkdir, existing parent handed over, no `-h`, never wired; twins:
  no handback — the bug reproduced on the twin — and existing parent handed over); A2 (7: gid ignored,
  owner sentence dropped / wrong, override on one matching half, ids not the identity, override
  failing, site branch ignored).
- **Deferred to 12.10:** `DATA_DIR_MODE` `0777` is still applied in `site`, where one user writes;
  it can now be narrowed there safely (root-made data dirs are handed back to the identity, so the
  mode no longer hides a `root:root` owner). Decide with the private folder. Decided there: kept.

### 12.8 — Install outputs (done 2026-11-12)

Documented in [wordpress-automation.md → Install outputs](../architecture/wordpress-automation.md#install-outputs-wpinstall-outputsts).
- **`ProductConfig.installOutputs?`**: validated by `normaliseInstallOutputs` (`wp/paths.ts`:
  `normaliseSitePath` per path, deduplicated; there so `config/metadata.ts` loads no exec/ssh module,
  pinned by `layering.spec.ts`) inside `registerInstallOutputs`, so a bad path fails the config build (the only registry that validates on
  registration); `getInstallOutputs` → `undefined` when undeclared; carried by `declaredResidue`, so
  `replacePluginUnderTest` checks too. Never created or removed by the suite.
- **`installFresh`:** `recordInstallOutputs` right after the database sweep, right before
  `stageAndInstallPlugin`; `settleInstallOutputs` right after the active-state re-assert (none if
  activation fails), before the data directories. Undeclared or empty: no command at all; nor with
  `fileOwner: false` outside `site` (nothing would be handed over; `site` still verifies). Settle is
  bounded by `SETTLE_BUDGET_MS` (30 s: ≈ 4 s per handover, ~5 round trips; WP Rocket's fresh install
  ≈ 3 top-level outputs; Before measured ≤ 73 s of 120 s): past it warned, the install goes on, the
  step ends on its own.
- **The check (one per side):** `exec` (as whoever commands run as, i.e. who wrote them) of
  `sh -c <constant script> e2e-install-outputs <absolute paths…>` (absolute: docker's working directory
  is its image's); prints `<index> <user:group:uid:gid>` (`stat -c`, empty when unreadable) or
  `<index> L` for a symbolic link (`-h` first: never followed, a dangling one present). Exit ≠ 0 or a
  throw → warned, nothing handed over (never "all new").
- **New = present after, absent before.** `site` → `matches(owner, ownershipOf(identity))`, warned
  otherwise; every other state → `normalizeOwnership` per new output, skipping one inside a new output
  already handed over (`covered` by the outermost new non-link ancestor, whatever the declared order,
  carrying its `outcome`: a failed parent reads as failed). Symbolic links: left alone and warned in
  every state (`chmod` follows an operand).
- **Ownership's grant refuses a link operand (audit fix, pre-existing since 916a724):** a comment
  cited a `refuseSymlink` that never existed; `assertResolvedInsideRoot` accepts a link resolving
  inside the root, and GNU `chmod -R` follows an operand link (re-measured, coreutils 9.4 in the
  twin image: a link to a `700` folder → `777`). The grant now runs as `sudo -n -- sh -c GRANT_SCRIPT
  e2e-ownership-grant <mode> <abs>` (`[ -h "$2" ] && exit 90; exec chmod -R -- "$1" "$2"`): exit 90
  → warned (`bad-target`), `failed`, no chown, for every `normalizeOwnership` caller (plugin folder,
  data dirs, install outputs). Residual window: the shell's two steps, needing write access to the
  path's parent. Pre-12.8 argv expectations changed only in the grant's shape (`ownership.spec.ts`
  ×2, `residue.spec.ts`, `housekeeping.site.ssh.spec.ts`): still root, grant before chown, same mode
  and target; the recursion now lives in the script (its own spec runs it on this machine's `sh`). A pre-existing shared
  parent is never touched: its new children are handed over one by one.
- **Specs:** `install-outputs.spec.ts` (17: validation and dedupe, parse incl. an empty owner half — a
  bug the spec caught —, `newOutputs`, `coveringPath` incl. a sibling sharing a prefix,
  `outermostCovering`, the script on
  this machine's `sh` with hostile names, links, dangling links); `install-outputs.ssh.spec.ts` (20,
  fake server: none declared → zero commands; paths as their own quoted arguments; failed check before /
  after → nothing as root; disabled: only new, a new parent covers its children; fallback/no-sudo same;
  pre-existing parent never chowned, its new child is; nothing new → no root call; symlink left; `site`:
  owned / not-owned warned, exactly two sudo `-u` calls, no root call; audit: a killed check before /
  after → resolves, warned, no root call; past a 100 ms budget → resolves at once, warned, the step
  ends; `fileOwner: false` → no command outside `site`, still verified in it; a covered child carries
  a failed parent's outcome; child declared before parent; a linked new parent covers nothing; `site`:
  a link, `www-data:other` and an unreadable owner are not owned); `ownership.spec.ts` +4 (a link
  inside the root refused by the grant, no chown; `GRANT_SCRIPT` on this machine's `sh`: link and
  dangling link → 90 with the pointee untouched, hostile path granted, chmod's own failure ≠ 90);
  `housekeeping.site.ssh.spec.ts` +1 (fake server: root ran only `-n true` and the guarded grant);
  `layering.spec.ts` +1 (`config/metadata.ts` reaches only `wp/paths.ts`);
  `plugin-lifecycle.spec.ts` +5 (a recording `sh` in the stub log: the checks sit right before
  `plugin install` and right after `plugin is-active`; none when undeclared or `[]`; the reinstall
  checks; a failed activation checks once); `metadata.spec.ts` +3, `project.spec.ts` +1 (factory
  registers, refuses `../x`). No pre-12.8 test changed but the grant's argv (above; the lifecycle stub gained an opt-in
  `WP_STUB_ACTIVATION_OUTPUT`).
- **Twins** (`hooks/install-outputs.ssh-twins.spec.ts`, 6: both stacks × `no-sudo`, `legacy-777`,
  `site`): a probe plugin whose activation writes `wp-content/e2e-io-drop-in.php` and
  `wp-content/e2e-io-cache/e2e-io-pages` under a pre-existing `root:root` parent, through
  `replacePluginUnderTest`. `no-sudo` (`fallback/no-sudo`): green, outputs stay `ubuntu:ubuntu`, the
  elevation warning; `legacy-777` (`fallback/owner-not-web`): both outputs `sftp_twin:www-data`;
  `site`: both `www-data:www-data`, no install-outputs warning (the check ran through real sudo + dash
  + GNU stat). The parent stays `root:root` everywhere. `wp/housekeeping.ssh-twins.spec.ts` +2 (both
  stacks, `legacy-777`): a link at the plugin path to a `root:root 700` folder in uploads →
  `failed`, the folder unchanged, sudo's log shows the `sh -c` grant and no `chmod`/`chown`. Run
  2026-11-12: install-outputs + housekeeping + staging twin specs, 24 passed.
- **Audit mutants (2026-11-12, 40, all killed in an isolated copy, baseline green):** the 21 unit ones
  below again; auditor's 7 (record / settle rethrow, before-check via `execAsTransport`, `verifyOwned`'s
  link branch removed, user-only compare, an unreadable owner as owned, covering over links); 12 new
  (grant guard removed, bare `chmod` again, exit 90 not told apart, a refused link still chowned, `$1`
  tested instead of `$2`, no budget, budget parameter ignored, `fileOwner: false` skip removed / taken
  in `site` too, `metadata.ts` through `install-outputs.ts`, covered always `normalized`, nearest
  instead of outermost). Twin: the guard removed → both stacks' link test fails (`normalized`).
- **Mutants (22: 21 unit + 1 twin, all killed, in an isolated copy):** new-only filter dropped; check
  before moved after the install; settle before the active re-assert; settle never called; state branch
  inverted / always verify / always hand over; covered by any present (not only new) parent; covering
  prefix without `/`; no covering; validation skipped in the registry; no dedupe; `-h` removed from the
  script; symlinks handed over; parse requiring the owner half; empty list still checking; an unknown
  "before" read as nothing existing; `site` always owned; relative paths in the check;
  `declaredResidue` without outputs; factory never registering; twin (nginx `legacy-777`): new-only
  filter dropped → the pre-existing parent handed to `sftp_twin`.
- **Kept as before:** fallback's `o+rwX` grant (SSH user outside the group) makes handed-over PHP files
  world-writable, as for plugin files; the pre-flight names the fix (group membership).
- **Limits:** an output a plugin writes *inside* a pre-existing undeclared folder is not seen (declare
  it); an output an earlier killed run left is reclaimed only when the transport's user owns its whole
  tree and no declared output lies beneath it (12.12);
  handovers are one `normalizeOwnership` each (~5 round trips; not batched, 12.12 measured); the `no-sudo` twin cannot tell the outputs' skipped handover from the plugin folder's (same
  warning, deduplicated) — the fake-server specs prove the call.

### 12.9 — Pre-flight, healthcheck, reports (done 2026-11-12)

Documented in AGENTS.md ("Auth fixture / setup" step 1, healthcheck) and
[wordpress-automation.md → Site identity](../architecture/wordpress-automation.md#site-identity-wpsite-identityts).
- **Order in `verifySite`** (ssh): today's gates (`wp --info` from `/`, `rootDir`, `core is-installed`)
  → **login shell** (the one new gate) → web probe (only `asksForIdentity`: effective `runAs`
  `"auto"`/`"user:group"`; verdict registered in-process at once) → boot/locale (+ heal) → ownership,
  elevation → **Site identity** (never a gate) → plugin folders. The probe precedes the locale check so
  it, a heal and the reports run as scenarios will; it follows the gates so a broken transport is
  reported by them, not by a probe. `verifyPool` runs the login-shell check first (read-only, per ssh
  site), then `settleLeftovers` only on sites that passed it (settling writes, as root on BackWPup),
  then `verifySite`, which reuses that result (one probe per site). An `auto` site settles as the
  transport's user (`unverified`), as before this phase. The healthcheck never settles.
- **"Never a gate" vs "a gate on that site":** the identity report never fails a site (§2.1: a
  fallback runs as today; §8: nothing here fails a run); the login-shell check does, because it
  protects command integrity, not a host property. `setup/login-shell.ts`: `printf '%s' <probe>` as the
  SSH user, from `/`, must come back byte for byte (`!`, newline, `\\`, `$`, backtick, both quotes:
  csh/tcsh and fish fail it); `getent passwd` (exit 0 only) names the shell only when it changed or
  refused the probe. The probe back whole with text around it is a startup file printing (fails,
  never blamed on the shell); a round-trip that throws is "could not be checked" (fails, a gate like
  the transport's: no `getent`, no blame).
- **Verdict hand-off:** `verifyPool` writes `site-identity.json` (12.3's `writeSiteIdentityFile`) in
  `dirs(product, cell).auth` whenever a site asks for an identity, with no entry when its probe threw
  (so a worker says the probe failed, never "stale"; a write failure warns); `boundSite` reads
  it per worker for `auto` sites only (`setup/identity-verdicts.ts`: missing/stale/invalid/no entry →
  one warning, `fallback/unverified`). Healthcheck: in memory, no file. Setup timeout +
  `SITE_IDENTITY_ALLOWANCE_PER_SITE_MS` (`PROBE_TIMEOUT_MS` + 45 s) per probed site.
- **Check content** (`setup/site-identity-report.ts`, pure): state (`describeIdentityState`, fallback
  with fix), web identity/umask/SAPI vs docroot, run-vs-web mismatch (declared `runAs`), web umask ≠
  run umask, world-writable umask (`umask & 0o002 === 0`), the `--user` check (an unmemoised
  `wp --skip-plugins --skip-themes eval` of `wpUserCheckArgs`), F8's per-call wait (≥ 1 s; 12.11b), `sudo -n -l`
  in `site`/`fallback` (§ variant table wants it in `owner-not-web`), `~/.wp-cli/config.yml` in `site`.
  ⚠ (`CheckResult.warning`, rendered by `checkLines`) when a line warns; `disabled` is a note.
- **`sudo -n -l` parser** (`setup/sudo-listing.ts`, `env LC_ALL=C`): `Matching Defaults` entries split on
  unescaped commas, last `log_allowed`/`!log_allowed` wins; `Defaults>user` runas entries naming the
  identity (or `ALL`) apply on top — sudo 1.9.15 prints several on one line (measured); `Defaults!cmd`
  ignored. Exit 1 with only `sudo:`/`Sorry, user` lines → `refused`; else `unreadable`. Rules never kept.
  Known limit (accepted, documented in its TSDoc): the listing prints global/host/user `Defaults` in
  one unlabelled block, read in print order, while sudo applies them global → host → user; only a
  sudoers setting `log_allowed` both ways is misread (a false "not logging" needs the user's
  `log_allowed` before a global `!log_allowed`).
- **Banner** (`renderIdentityWarning`, `elevation-report.ts`, both callers): per site the issues
  (`identityIssues`): fallback reason + fix, unresolved state, `site`/`same-user` not verified or the
  web server another identity, sudo logging or unknown. Silent otherwise. One install (same address
  and transport) under two products' cells is listed once. **Deviation (audit):** `disabled/config`
  (`runAs: false`) is never listed, though the literal design was "silent only when every site is
  `site`/`same-user`": `false` was the documented setting for real sites until 12.11 (kept out
  after the flip too), so the banner would print on every live run and healthcheck, contradicting
  its own ✓ line and the elevation banner's "silent when opted out". The check line says it instead: "Runs as the
  transport's user, as configured (`runAs` is false); nothing to fix."
- **What a `runAs: false` site now receives** (pinned in `preflight.identity.ssh.spec.ts`): the
  `printf` round-trip and the `--user` check `wp eval`, both read-only; no probe file, `sudo -n -l`,
  `getent` (unless the shell check fails), or `.wp-cli` read.
- Tests: `sudo-listing`, `login-shell`, `site-identity-report` (every state/reason), `identity-verdicts`,
  `elevation-report`/`check-lines` additions, `preflight.identity.ssh` (argv, gate, verdict file,
  hint); `preflight.ssh-twins` (every variant × both twins = the variant table's state, banner
  issues, no failed check, no probe left; `runAs` false). 15 mutants, all killed (state→line,
  disabled issue, unverified issue, banner filter, `!log_allowed` ×2, runas entries, umask predicate,
  gate return, shell compare, no probe for `false`, worker read only for `auto`, in-process
  registration, ⚠ mark); one equivalent (a redundant `asks` guard before `sudo -n -l`) removed.
- **Audit fixes (2026-11-12):** D1 banner deviation (above); login shell before settle (L1); verdict file
  written with no verdict (L2); `sudo -n -l` order limit documented (L3); a thrown round-trip
  "could not be checked" (L4); startup-file output named as such (L5). New tests pin each, plus
  auditor B's survivors: probe before the locale check (fake `wp` answering German unless run as the
  identity), only-uid/only-gid web mismatch, `sudo -n -l` read with the identity's names (`Defaults>`),
  WP-CLI config exit 1 ⇒ none, a refusal's words under exit 127, same address over two transports,
  `getent` exit ≠ 0. Mutants in an isolated copy: 48/48 killed (the 7 fixes reverted, auditor B's 8
  survivors, the implementer's 15, 20 more); one equivalent (`shellFromPasswd`'s field-count guard)
  removed from code. Auditor B's own 44 were not on disk to re-run; their survivors are in the 48.
- Verified: BackWPup `cli-reads` + `cli-runs` on `pro@twin-apache` and `pro@twin-nginx` in the `site`
  variant, `runAs: "auto"`, `E2E_RETRIES=0`: 15/15 each (verdict `owner-is-web`, no unverified warning).
  The healthcheck on the twins (nginx `site`, apache `legacy-777`): banner lists apache's
  `owner-not-web` only, once for both products; with both overlays at `runAs: false`: no banner, each
  check line "Runs as the transport's user, as configured (`runAs` is false); nothing to fix."

### 12.10 — BackWPup on the new system (done 2026-11-12)

1. **Baseline**, before this phase's changes: the full BackWPup suite on both twins in `legacy-777`
   with `runAs: false` (`E2E_RETRIES=0`). Record each scenario's outcome (`results.jsonl`).
   Done 2026-11-12, after the twin fix below: 70 scenarios per cell, none skipped; apache 68/2
   (onboarding "Only the files…"/"Only the database…": `page.goto` interrupted by the first-backup
   page's own navigation, likely a race), nginx 67/3 (the three backup-history restores: the
   unwritable `debug.log` below).
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
   - Decide `residue.ts`'s `DATA_DIR_MODE` (`0777`, for two users) in `site`, where one user writes
     (from 12.7): safe to narrow there now, since every data dir in `site` ends the identity's.
     **Decided 2026-11-12: kept `0777` in every state.** Measured: narrowed to the umask's `0755`
     in `site`, the opt-back scenario failed on both twins (`site`, `site-775`): its `backup-delete`
     as the SSH user died on "Restore working directory … is not writable"
     (`WorkingDirectoryProtector.php:81`). An opt-back scenario makes two writers in `site` too.
4. **Compare:** the suite with `runAs: "auto"` in `site` and `site-775`.
   - A scenario passing in the baseline that fails or skips is investigated: a two-user outcome gets
     the step; anything else is fixed in the shared layer.
   - Also check:
     - `plugin-deletion.feature` / `footprint.ts` (user meta) with `--user`;
     - `cli-runs.feature`'s history trigger `"wp-cli"`;
     - `onboarding.ts` `isPristineActivation`;
     - `wp backwpup kill` (`job-runs.ts:290`) now running as the web user.
   - `--user` is already live (12.6, no gate); still to check with it: `plugin-deletion.feature` /
     `footprint.ts` (above), the debug log's "Runs with user:" line wherever a step reads it, and
     KSES (WP-CLI removes its filters only without `--user`) for anything BackWPup saves through
     WP-CLI.
   - 12.9's verdict makes `auto` `site` in a full run (its `cli-reads` + `cli-runs` pass there).
   - **Twin limit (resolved 2026-11-12):** on `legacy-777` "After a backup has run…" and "A job run
     in the background…" failed. One cause on both stacks: the docroot is `sftp_twin`'s, so in a web
     request `get_filesystem_method()` is `ftpext` (the owner of `wp-admin/includes/file.php` ≠ that of a
     temp file the worker writes in `WP_CONTENT_DIR`, `ftp` loaded, no `FS_METHOD`; read in the
     twin's WordPress 7.1.4); `BackWPup_Job::start_http` writes `.backwpup_job_started` through
     `WP_Filesystem` → `ftp_fput(null)` TypeError (`class-wp-filesystem-ftpext.php:266`). Nginx
     looked different only because `wp-cron.php` answers before the work (`fastcgi_finish_request`)
     and the fatal was lost: `debug.log` was `ubuntu:ubuntu 644` (see below). Fix: `site.sh` defines
     `FS_METHOD` `direct` whenever the docroot is not `www-data`'s (`legacy-777`, `owner-mismatch`),
     as a real site deployed by another account needs (F18; `simple` defines it); `check.sh` proves
     the constant and a web request's method.
   - **Lost web fatals on `legacy-777` nginx (suite, open):** `clearDebugLog` removes `debug.log`;
     WP-CLI's PHP 8.5 `Deprecated:` lines then recreate it as `ubuntu:ubuntu 644` (umask 0022), so
     PHP-FPM (`www-data`) cannot append and a web-side fatal never reaches the After scan. Apache's
     PHP 8.3 CLI writes nothing first, so the web creates it. It also hangs BackWPup's `restore_dir`
     stream (3 history restores failed in the baseline; the same scenario passed in 14 s with the
     log kept writable). Gone in `site` (one identity); still the case in every fallback state.
     **Fixed 2026-11-12** (`wp/log.ts`): the clear empties a writable log in place (owner and mode
     kept), else replaces it with an empty one (`O_EXCL`, a link never followed); a log the identity
     owns is then kept in `site` (it is the web server's), elsewhere only once handed over
     (`normalizeOwnership` → `normalized`), else removed as before — `unnecessary` outside `site`
     (WP-CLI's user owns the install; the web server may be another) and `disabled` included (audit
     A1). Reproduced first (1/1 "A full restore from the backup history…"
     failed, log `ubuntu:ubuntu 644`); after: the three history restores 3/3 on nginx `legacy-777`
     with `runAs: false`, log `sftp_twin:www-data 664`. Twin spec: `housekeeping.ssh-twins.spec.ts`
     "legacy-777: a debug.log WP-CLI's user made is handed over by a clear…" (fails without the fix).
     Left: on `no-sudo` (fallback, no elevation) a log WP-CLI's user makes stays its own until the
     next clear removes it, as before.
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
- **Progress 2026-11-12 (steps 2, 3, 5 done; step 4 next):**
  - Step 2 as designed; `sshUserBoot` decides the skip: only a refusal to read the site
    ("Permission denied", or WP-CLI not recognising a root it cannot read; measured on a twin) skips,
    any other failure (database down, not installed, a fatal) fails the step (audit A3).
    - Intended, behaviour-neutral (B6): the step changes the "Deleting a backup the web server made
      is refused…" scenario in every state — one extra `wp core is-installed`, and no `--user` on its
      BackWPup commands (`asTransportUser` drops `wpUser`), as before 12.6; 12.6 measured
      `cli-reads`/`cli-runs` identical with and without `--user`. The opt-back scenario **runs** in `site`
    too (not skipped): WordPress boots for `ubuntu` there (`wp-config.php` world-readable). Twins:
    `cli-backups` 4/4 on nginx `site`, apache `site-775` and apache `legacy-777`.
  - Step 3: `privateFolderHome` → `/tmp/e2e-private-<key>` in `site` (the key keeps the test id for
    tracing, then 16 hex), strict `mkdir($dir, 0700)` (no parents, nothing reused), removed as the
    identity, `staleDirSweepScript` (shared with the inbox sweep) removing the identity's own over
    1 h. BackWPup accepts it: `backup-download`, `job-export`/`job-import`, the key files all pass on
    nginx `site` (`{private folder}` = `../../../../tmp/e2e-private-…`); `legacy-777` keeps
    `.e2e_temp/private/`. No folder left in `/tmp` after the runs.
  - Same `site` run (nginx): `cli-backup-encryption`, `cli-job-transfer`, `cli-restore`, `restore`
    and `cli-logs` all pass; "Showing a job's log…" failed once (two runs in one second: the plugin's
    "newest" log is ambiguous; passed on rerun and on apache), a timing flake outside this phase.
  - Step 5 reworded where true (plus `cli-logs.steps.ts`, `plugin-folders.ts`, `encryption-keys.ts`,
    the private folder, `cli-backups` Feature text).
  - **Step 4 measured 2026-11-12** (twins, `E2E_RETRIES=0`, both cells concurrently; state `site`
    confirmed: `site-identity.json` `owner-is-web`). Passed/failed of 70, none skipped:
    `site` apache 69/1, nginx 70/0; `site-775` 69/1 each; legacy-777 `runAs: false` re-run apache
    69/1, nginx 68/2 (baseline 68/2, 67/3).
    - nginx's 3 history restores pass in every mode (step 2's log fix; 2/2 alone in legacy).
    - Onboarding "Only the files…"/"Only the database…": a suite race, identity-independent: the
      first-backup screen redirects itself to `page=backwpup` as the job ends, and `I open the
      BackWPup dashboard` navigates there at the same moment. Alone ×3 each: 3/6 fail with `runAs:
      false` and 3/6 with `auto`; also once on nginx. **Fixed** (F1): `DashboardPage.goto` waits
      for the page's own load when that navigation took over its own and goes to the dashboard
      (Playwright says "interrupted by another navigation to …", or `net::ERR_ABORTED` before a
      commit); anything else still throws.
    - cli-logs "Showing a job's log…" failed in `site-775` (both) and nginx legacy: its Background's
      2 runs land in one second, and `LogShow.php` keys logs by `filemtime` seconds, so "latest" is
      arbitrary; 3/3 alone in `site`. **Fixed** (F2): the Background sets the oldest run's log a
      minute back (`backdateFile`).
    - Root, measured with root sudo logging: legacy ~680 commands per run (324 ownership
      handovers), `site-775` 41 (`cliRestore`'s content copy + `sudo -n true`), `site` adds only the
      web probe's write and `rm`; `wp` never root.
    - Checklist: opt-back runs and passes in `site`/`site-775`; plugin-deletion passes, no user
      meta left; `"wp-cli"` trigger passes; `isPristineActivation` only the known nginx cron race
      (reinstalled); `kill` as www-data passes ("Aborting a running backup…"; `stopRunningWork`
      never triggered); no step reads "Runs with user:"; KSES: admin has `unfiltered_html` and the
      kses filter is off with `--user` as without. No leftovers, every docroot file www-data's.
  - **Audit fixes 2026-11-12** (each verified first; twins, `E2E_RETRIES=0`): A1 log kept only in
    `site` or once `normalized` (twin spec "legacy-777: with no handover…" fails with the old rule);
    A2 `check.sh`'s web probe made by the docroot's owner (`dd conv=excl`, random name,
    `--max-time`, removed on exit; shown failing with `FS_METHOD` deleted); A3 above; B4 above;
    F1 onboarding pair 16/16 on apache `site` (failed 3/6 before), 2/2 on nginx `site`; F2
    `cli-logs` 21/21 (×3) on nginx `site-775`; opt-back passes on nginx `site`; `restore` 5/5 on
    nginx `legacy-777` `runAs: false` (log `sftp_twin:www-data 664`); `check.sh` green on all 7
    variants of both stacks; housekeeping + staging twin specs 22/22.
  - **Open from step 2**, accepted at 12.11 (no Part B phase owns them; 12.12–12.16 are WP Rocket's):
    - In `site`, the opt-back scenario's WP-CLI runs as the SSH user, which cannot append to the
      web server's `debug.log`: its PHP messages reach only the command's stderr, so the After scan
      cannot see a fatal from that one command. Accepted: one BackWPup scenario, two users by design;
      that command's own stderr still carries them.
    - `wp/log.ts`'s clear on a host without PHP's `posix` extension cannot tell an emptied log's
      owner (`ours: null`), so a stale log the SSH user owns is left as is (no handover), and the
      web server may still be unable to append to it. Accepted: without `posix` the web probe cannot
      verify, so `auto` never reaches `site` there (checklist item 1); every host in use (twins, both
      QA servers, verified over HTTP) has it.

### 12.11 — Docs, decision record, live verification, default `"auto"` (done 2026-11-13)

- **Docs** (2026-11-12): AGENTS.md, wordpress-automation.md, configuration.md ("Server checklist for
  `runAs`" and the switch of a cell that opted out), modernization §8.2 (the reversal) and §8.4
  (obligation closed).
- **Twins**, every variant × both stacks, `runAs: "auto"`: healthcheck exit 0 each, states and
  banners as "Twin variants" (`legacy-777`/`owner-mismatch` → `owner-not-web`, `no-sudo`,
  `no-wp` fallbacks with their fixes; `site`, `site-775`, `wpconfig-root` → `site`, silent). Full
  BackWPup suite in `site`, `E2E_RETRIES=0`: 70/70 on each stack. Twin specs 96/96 (`withTwin`'s
  load-flaky wait fixed on the way: it now counts poll end to poll end).
- **Live rollout, 2026-11-13** (orchestrator drained per cell, configuration.md's procedure):
  `pro@nginx` (qa-lnmp) and `pro@apache` (qa-auto-e2e-apache) switched to `"auto"`, both `site`
  `www-data:www-data` umask `0022`, verified over HTTP.
  - Server changes: `/etc/sudoers.d/e2e-ubuntu` (`Defaults:ubuntu !log_allowed`, host-wide) on both;
    the apache docroot chowned `www-data:www-data` (3613 entries were `sftp_backwpup:www-data`).
  - `pro@apache`: 69 passed, 1 flaky (the host reboots 04:00/16:00 UTC by root's cron).
  - `pro@nginx`: 58 passed, 8 flaky, 4 failed — every failure and most flakies from the **free**
    BackWPup 5.7.9 left active on `simple.e2e`, which recreates `backwpup_*` options and roles on
    every request. Proved by deactivating it temporarily: the 4 affected features 24/24; re-activated
    after (site left as found). One restore flaky from another operator's `php8.5-fpm` reload.
- **Real sites files**, checked before the merge: the only one is this machine's (no server holds a
  checkout); `free@nginx` stays an explicit `"runAs": false` (remove it once its server, qa-lnmp's
  bwu site, passes the checklist).
- **Rollout fact:** a site without `runAs` now gets the pre-flight's web probe file written into its
  docroot (as root through path-guarded elevation when the transport's user is refused), removed
  afterwards.
- **Default `"auto"`** (`DEFAULT_SSH_RUN_AS`, 2026-11-13). Re-pinned specs: `run-as`,
  `identity-verdicts` (absent reads the verdict), `site-identity-report` (`asksForIdentity`),
  `housekeeping.site.ssh` (absent → `fallback/unverified`), `site-identity.ssh` (absent shares
  `auto`'s state); "runAs absent" relabelled in `staging.site.ssh`/`exec.site.ssh`. Cost, by design:
  with no verdict (`--no-deps` loops) an ssh site without `runAs` warns `fallback/unverified` once per
  worker and runs as the transport's user. The residue preparation's refusal now names who ran the
  refused step (the identity in `site`, never called the web server's) and a fix that fits the step
  (`chmod` needs ownership) and elevation (`elevate: false` → turn it back on); every fallback's fix
  but `probe-mismatch`'s ends with the `"runAs": false` opt-out.
- **Decision: an explicit `runAs: false` stays out of the identity banner.** The banner lists what
  needs fixing on a host; `false` is the operator's choice, already stated on the site's check line
  every run ("as configured (`runAs` is false); nothing to fix"), as the elevation banner is silent
  for `elevate: false`. Revisit if an opted-out site is ever found forgotten.
- **Open (site setup, owned by the user, not the suite):** the free BackWPup plugin active on
  `simple.e2e` (`pro@nginx`) breaks BackWPup's own scenarios there until it is removed.

### 12.11b — Recover from sudo's hostname line in-project (done 2026-11-13)

- **Decision (user, 2026-11-13):** the `/etc/hosts` fix is dropped from the plan, docs and the
  pre-flight's advice. The suite runs on many servers over time and nobody edits each one's
  `/etc/hosts`: the project absorbs F8 itself.
- **Audit — every consumer of sudo's output:** the `site` wrapper (already stripped); `execElevated`
  over `ssh`/`local` — ownership grant (`chmod`/`chown` messages), residue (`find`, `chown`, retries,
  messages), staging/site-staging removal messages, `debug.log` read/clear fallbacks, the web probe's
  root write (`writeFailure`) and removal, BackWPup's content copy (`benignCopyWarnings`: tar's exit 1
  with only benign warnings **was refused** with sudo's line first — the restore not run — a real
  outcome change) and its leftover claim (`mv` message); `sudo -n true` (exit only); the run probe
  (stripped itself); `sudo -n -l`'s parser (a lone line read as a refusal). All stripped now: in
  `transport-exec.ts` for every command it routes through sudo, in the parser for `sudo -n -l`; the
  run probe already was. `execAsTransport` stays raw (documented).
- **Stripper** (`wp/sudo-noise.ts`): only `^sudo: unable to resolve host \S.*$` lines among sudo's
  leading `sudo:` lines (a world-writable `sudo.conf` warning can precede it, measured); everything
  else byte for byte; the untranslated text only (sudo localises it under a locale it has a catalogue
  for: measured with `language-pack-de-base` and `LANG=de_DE.UTF-8`; known limit: a server whose SSH
  sessions run under such a locale keeps the line in what it reports).
- **Cost and report:** F8's measurements. `sudoNoise` is gone from the state and run probe (no fix
  to name). Instead the pre-flight times one sudo call only where the run sends commands through sudo
  (`sudoLookupAs`, pure): `site` → `env LC_ALL=C sudo -n -u <user> -g <group> true` (never root, so a
  site opting out of root or refused it runs nothing as root); else elevation `available` → `env
  LC_ALL=C sudo -n true` (what the elevation probe already ran); `docker`, or a site with neither
  (`fallback`/`disabled`/`same-user` without root) → none (the run pays no wait there, so none is
  reported). Only when the line shows, `env LC_ALL=C true` for the round trip. `LC_ALL=C`: sudo
  translates the line under a locale it has a catalogue for. ≥ 1 s per call is a ⚠ line in the "Site
  identity" check and a banner note in any state (no fix line; a banner of only notes is headed "to
  note"); below it, nothing. Cost per site per run: one round trip (two when the line shows); a
  silent resolver makes the timed call itself wait ~20 s, as every other sudo call the pre-flight
  and run make does.
- **New commands on a live `runAs: false` site:** elevation `available` → `env LC_ALL=C sudo -n true`
  as the SSH user from `/` (root runs `true`, the same call the elevation probe already makes), plus
  `env LC_ALL=C true` only when sudo prints the host line; elevation `disabled`/`unavailable` → none.
  Both read-only (pinned in `preflight.identity.ssh.spec.ts`). Every other change only strips stderr.
- **English for every sudo-routed command — rejected (measured 2026-11-13, ubuntu:24.04, sudo
  1.9.15p5, `language-pack-de-base`):** sudo's `env_check` passes `LANG`/`LC_*` to the command (not
  in `env_keep`; `env LC_ALL=C sudo -n -u www-data -g www-data env` shows `LC_ALL=C`), so the change
  reaches `wp`, PHP and tar. `LC_ALL=C` turns tar's listing of `café.txt` into `caf\303\251.txt`
  (`wp/archive.ts` parses listings); PHP's own locale is unaffected (`C.UTF-8` either way).
  `LC_MESSAGES=C` keeps names but loses to a session's `LC_ALL` (measured: still German), and either
  changes the line every non-`site` state sends byte for byte (root steps on `runAs: false` sites).
  The limit stays: a session under a translated locale keeps sudo's line in stderr (quoted in
  messages, never a wrong pass). **Deferred (latent, pre-existing):** under such a locale tar's own
  warnings are translated too (`Datei … nicht gefunden`), so the content copy's `benignCopyWarnings`
  refuses a copy that only raced a changing file — fail-safe (the restore is not run); fix with the
  content copy's own tar under `LC_MESSAGES=C` if a translated host appears.
- **Tests:** `sudo-noise.spec.ts` (forms, CRLF, preceding warnings, later lines kept, nothing else
  touched), `sudo-lookup.spec.ts`, `sudo-listing.spec.ts`, `site-identity-report.spec.ts`; the fake
  `sudo`s (in-process SSH server, local, the content copy's host) gained a noise switch:
  `exec.site.ssh`, `exec`, `content-copy`, `preflight.identity.ssh` prove identical outcomes and clean
  messages; `sudo-noise.ssh-twins.spec.ts` does it on real sudo (hostname removed, resolver refusing:
  same checks/issues as resolvable, clean `ls` errors as site and root; resolver silent: the wait
  reported, ~2 s). Without the fixes the root, listing, copy and stripper specs fail. Audit fixes
  (2026-11-13): `sudoLookupAs` every mode × state × elevation, the in-process gate (`site` with root
  opted out → as the identity; `fallback` without root, `runAs: false` without root → no lookup),
  `LC_ALL=C` pinned, the banner's note without a fix line; each mutant (old gate, no `site` branch,
  always root, no `docker` exclusion, no `LC_ALL=C`) fails them.

### 12.12 — WP Rocket declarations and licence (done 2026-11-13)

Read at `develop` @ 9788d19 (3.24.1-beta2, APVM); S1, S2, S5, S6 still hold there.
- **Declarations** (`src/projects/wp-rocket/support/`):
  - `installOutputs` (`residue.ts`): `advanced-cache.php`, `cache`, the seven `cache/*` folders,
    `wp-rocket-config`. Measured (licensed, CLI activation): `advanced-cache.php`,
    `cache/{wp-rocket,min,busting,critical-css}`, `wp-rocket-config`; `background-css` appears on a
    later request.
  - `siteResidue`: the seven cache folders, `wp-rocket-config` and the licence file, all
    **remove-only** (below). `cache` and `advanced-cache.php` stay 12.15's.
  - `siteDbResidue` (`db-residue.ts`): 47 WP Rocket-specific fragments (`wp_rocket_`, `rocketcdn`,
    `donotdeactivaterocket`, one per `rocket_…`/`wpr_…` family its source reads or writes — never bare
    `rocket_`/`wpr_`, which take Lazy Load by WP Rocket's and Royal Elementor Addons' options); they
    cover every option/transient of `WPRocketUninstall` but `plugin_family_dismiss_promote_imagify`
    (Imagify's plugin family writes it too; the sweep runs with WP Rocket absent), its tables' version
    and `_exists` rows, background-process rows, per-user transients (`declarations.spec.ts`); the 8
    BerlinDB tables (`wp_wpr_*`, measured); the 10 `rocket_*` capabilities on `administrator`
    (`Capabilities/Manager.php`, measured). No role. Measured: a deactivate + uninstall leaves none of
    it; a lost plugin folder leaves 20 options, 8 tables, 10 grants, all swept. Not swept (by design):
    user meta `rocket_boxes`, post meta `_rocket_exclude_*`, the 18 cron hooks its uninstall clears
    (in core's `cron`, which the sweep protects), Action Scheduler's tables/options (shared library,
    the uninstall keeps them too), core rows.
- **Contradiction found → `SiteResidueRemoveOnly`:** every plain `siteResidue` path is also a data
  directory the Before creates `0777` and hands over (`prepareSiteDataDirs`). WP Rocket's folders
  would lose their `0755` and the licence file would be `mkdir`ed. `{ path, prepare: false }` is only
  removed (`parseResidueDeclaration` → `prepare`); plain strings unchanged.
- **Licence (S1):** `ProductConfig.prepareActivation` (new registry; `installFresh` runs it after the
  DB sweep, before `recordInstallOutputs`; a failure ends the install). WP Rocket's
  `writeLicencePlugin` (`licence.ts`): removes a leftover copy (residue removal, escalating), then
  `evalPhp` (`--skip-plugins --skip-themes`, as the site's commands run) writes
  `wp-content/mu-plugins/e2e-wp-rocket-licence.php` (refused when `WPMU_PLUGIN_DIR` is elsewhere;
  `wp_mkdir_p` when missing), then `normalizeOwnership` on the file. The file: `ABSPATH` guard, three
  `pre_get_rocket_option_*` filters; key and email via `phpLiteral`, `secret_key = hash('crc32', email)`
  computed in PHP (PHP's `crc32`, not `crc32b`). Dummy `E2EDUMMY` / `e2e-licence@example.invalid`.
  `wp-config.php` never edited.
  - Measured (twin `site`, 2026-11-13): without it activation writes no `WP_CACHE`; with it
    `rocket_valid_key()` is true and `WP_CACHE` is written. **Pages are cached only after an admin
    request** writes `wp-rocket-config/<host>.php` (activation over WP-CLI writes no config file nor
    `wp_rocket_settings`): 12.13's job; the twin spec makes that request itself.
  - A `mu-plugins` folder it creates stays (empty after the teardown); outside `site` it stays the
    transport user's (`0755`, readable): `normalizeOwnership` refuses `wp-content/mu-plugins`
    (protected). Accepted: WordPress never writes there.
  - **Real key:** no scenario needs a remote feature yet, so no `WPR_*` variable and no
    `SECRET_NAME_PATTERN` change. When one does: `RocketLicence` from `WPR_CONSUMER_KEY`/
    `WPR_CONSUMER_EMAIL` via `env.ts`, plus the secret-pattern, guide, phase-0.5 §4 and AGENTS updates
    listed in this sub-phase's original plan (git history). A real key reaches the site in a staged
    file, never in `wp eval`'s argv (`ps`, sudo's log).
- **Deferred 12.8 item, decided — reclaim, not pre-removal:** a pre-existing output owned by the
  transport's uid (not already the site's) while `planOwnership` is `grant` is handed over like a new
  one (`reclaimed`; warned once `normalized`, silent when the handover is skipped and warns itself),
  only when the recursion reaches nothing else: no declared output beneath it (a shared parent such as
  `cache` is left, its new children handed over one by one) and its whole tree that uid's
  (`RECLAIM_CHECK_SCRIPT`, one `find <p> ! -uid <uid> -print -quit` per candidate in one `sh` as the
  transport's user; non-zero or unreadable → not ours). Either refusal is warned. Never in `site`.
  Why: removing declared residue before the install would miss non-residue outputs
  (`advanced-cache.php`, `cache`), delete more than ownership needs, and must not run on a part-way
  reinstall.
- **Batching: not needed.** Whole `@plugin` install on `legacy-777` (record, licence, install,
  settle of 3 new + 2 reclaimed outputs): 4.0 s apache, 4.3 s nginx — settle far under
  `SETTLE_BUDGET_MS` (30 s). Real cells (~0.8 s/round trip): ≈ 3 handovers × 5 ≈ 12 s worst.
- **Done, proved on the twins** (`lifecycle.ssh-twins.spec.ts`, 8 green, both stacks): `site` —
  licensed, outputs `www-data:www-data` with no install-outputs warning, footer + a cached file, the
  teardown leaves no declared file or row; a lost plugin folder's rows swept; `legacy-777` — outputs
  and the licence `sftp_twin:www-data`, ubuntu-owned `advanced-cache.php`/`cache/wp-rocket` reclaimed,
  ubuntu-owned `cache` (shared parent) and `cache/min` (holding root's `0600` file) left as they were,
  caching.
  **Plan's "`no-sudo`: new outputs handed over" is impossible** (no sudo, nothing can chown): proved
  instead that the handover is attempted and refused with the elevation warning, outputs
  `ubuntu:ubuntu`, licensed (`WP_CACHE`), teardown clean.
- **Specs:** `declarations.spec.ts` (14: validation, uninstall-list coverage, refusal transient,
  core/Action Scheduler untouched, remove-only, wiring, licence validation and literal-only
  embedding, preparation/removal on a local root); `licence.php.spec.ts` (7, real PHP through
  `__fixtures__/licence-harness.php`, skipped where PHP is not installed: `php -l`, filter answers vs PHP's own
  `hash('crc32')`, hostile email, no-op outside WordPress, write/replace/refuse a moved
  `WPMU_PLUGIN_DIR`); `install-outputs.spec.ts` +4 (`keptEntries`, `ownedByTransportUser`);
  `install-outputs.ssh.spec.ts` +4 (reclaim with a covered child, other owner, `site`, no sudo);
  `plugin-lifecycle.spec.ts` +4 (registry carry, order after removal/before install, reinstall,
  failure stops the install); `residue.spec.ts` +4 (remove-only parse/rules/prepare/remove);
  `metadata.spec.ts` +1, `project.spec.ts` +1. Changed: `residue.spec.ts` "reads a string as a path"
  (the parsed shape gained `prepare: true`).
- **Audit fixes (2026-11-13, each reproduced first):** (1, medium) reclaim decided on the top-level
  owner only, so its `chmod -R`/`chown -Rh` opened another plugin's `0600` file in an ubuntu-owned
  `cache` to `0666` and a root `0700` declared child to `0777`: now the two rules above; (2) no spec
  pinned `prepareActivation` between the DB sweep and the outputs check; (3)
  `prepareResolvedDataDirs` would open a resolved path declared remove-only: refused before anything
  is created; (4, medium) bare `rocket_`/`wpr_` fragments swept other plugins' options
  (`rocket_lazyload_options`, `wpr_google_map_api_key`, …): replaced by specific ones; (5)
  `plugin_family_dismiss_promote_imagify` dropped (shared with Imagify); (6) "CI has no PHP" removed
  from 5 spec comments (ubuntu runners ship it); (7, 8) plan/TSDoc lines above. Specs:
  `install-outputs.spec.ts` +6 (`sharedParents`, `parseReclaimCheck`, the script on this machine's
  `sh`/`find`: whole tree, other uid, unreadable, a link never walked); `install-outputs.ssh.spec.ts`
  +2 (a fake `find` over the fake `stat`; the fake `sudo` runs the grant, so modes are real): a shared
  parent and a leaf holding root's file keep every mode, no root call; an unreadable tree is left;
  `plugin-lifecycle.spec.ts` +1 (sweep → preparer → check); `residue.spec.ts` +1 (remove-only
  refused, modes kept); `declarations.spec.ts` +2 (source-read names reached; other plugins'
  options left). Changed: `install-outputs.ssh.spec.ts` "reclaimed; its new children covered" (now
  `cache` is a shared parent: left, its child `handed-over`, a whole-tree leaf `reclaimed`) and "without
  elevation" (`cache` → leaf `e2e-config`, same rule); `declarations.spec.ts` "reaches every option"
  (`plugin_family_…` now expected unswept, item 5); twin legacy-777 case (above: `cache` can no
  longer be reclaimed by rule; `cache/wp-rocket` added as a reclaimable leftover and `cache/min` with
  root's file as one that must be left). Mutants killed: no shared-parent rule (2 ssh specs), no
  whole-tree check (2 ssh specs + twin), preparer after the record (lifecycle spec), no remove-only
  refusal (residue spec). Twins 2026-11-13: WP Rocket lifecycle (8) + install-outputs (6), 14 passed.

### 12.13 — Settling admin request after install

- `ProductConfig.settleAfterInstall?: "admin-request"`. After `installFresh`, the `@plugin` Before
  binding (`plugin.hooks.ts`, which gains `context`) and `replacePluginUnderTest`'s callers:
  1. `context.request.get("/wp-admin/")`;
  2. check the final URL is under `/wp-admin/`, not `wp-login.php` (a `@noauth` scenario or an
     expired login → a warning naming it);
  3. one GET of the front page.

  On Apache this writes WP Rocket's `.htaccess` block, `WP_CACHE` and config files as the web
  server, before any step (F13).
- A failed request is a warning. WP Rocket opts in. Measured in 12.12: without this request a
  licensed WP-CLI install caches nothing (no `wp-rocket-config/<host>.php` yet).
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
| Switching identity breaks cells the orchestrator v0.5 runs on | Per-cell switch before the default flipped (12.11, done); `false` opts a site out; whole-suite comparison on the twins (12.10); per-cell procedure drains the task first (12.11). |
| `auto` runs as a deployment account | `site` only with the pre-flight's verdict that owner = web identity (§2.1). |
| The identity changes mid-process | Probe throws propagate; probes never go through the resolver; separate caches (§2.1). |
| sudo's forced umask `0002` (F3) | The wrapper sets it; the twin spec asserts stub modes. |
| sudoers refuses a group (F1) and says "a password is required" (F2) | The run probe uses the exact wrapper; the report names `(ALL:ALL)`. |
| Hostname noise in stderr (F8) | Stripped from every command sudo carries (site, root over `ssh`/`local`); callers running sudo themselves strip it; unit, in-process and twin specs prove identical outcomes and clean messages (12.11b). A resolver that never answers costs each call its timeout: measured and reported from 1 s, never failed. |
| Private files servable once owned by the web user | The private folder leaves the docroot in `site` (12.10); the record too (12.15). Staging still holds plugin zips (not secret); 6J keeps the staging area off the web. |
| `--user` changes plugin behaviour or breaks mid-run (live at 12.6's merge, before 12.10) | No DB writes from the flag (F11); BackWPup `cli-reads`/`cli-runs` identical with and without it on `legacy-777` (12.6); retry and a later re-check on the exact error (§2.3); 12.10 checks the BackWPup places it could touch. |
| A BackWPup scenario silently depends on two users | 12.10's baseline-versus-new comparison; a new skip or failure blocks the phase. |
| A killed runner leaves web-user processes (F10) | Unchanged from today; anything that stops one uses the same identity. |
| The probe file served publicly | 128-bit random name, constant content (ids, umask, SAPI), deleted in `finally`, swept after 1 h. |
| Empty-argument and `cd ;` defects (F5) | Fixed by 12.1 (done). |
| WP Rocket's file edits not reversible byte for byte | 12.15 replays WP Rocket's own transforms on the record; anything else is warned and left. |
| Phase 11 profiles carrying identity fields | Phase 11's refused list names `runAs`/`umask`/`wpUser` (modernization plan, 12.2). |

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

## 8. Working rules for whoever implements this

Everything a session needs is in this repository; nothing relies on a previous session's notes or
scratch files.

- **Live cells are shared.**
  - The cells (modernization plan §8.1) are cycled by the orchestrator v0.5.
  - Never run anything on them without the operator, and only per 12.11's procedure. Up to about
    four parallel suites per server are acceptable once agreed (phase-6 plan, 6I); name the sites
    first.
  - Build and verify on the twins (12.0).
- **Docker:**
  - local Docker (OrbStack on the operator's Mac);
  - if it is down, ask the operator — never start Docker Desktop yourself;
  - touch only the containers and images this plan creates (`wpme-ssh-*`, `own*`-style throwaways
    you remove);
  - never other projects' containers.
- **Plugin zips:** the suite resolves them itself (`pluginArtifact`, APVM, AGENTS.md "Plugin
  artifacts"); BackWPup needs `GITHUB_TOKEN` or `gh auth login`. For a manual measurement, build
  with APVM's CLI in a shell.
- **WP Rocket licence:** a dummy key licenses (S1). The operator offered a real one if a remote
  feature ever needs it: ask; never commit it.
- **Long runs:** keep the runner awake (`caffeinate -i` on macOS, AGENTS.md).
- **Measure, never assume:** re-measure any fact in §1 that a change leans on, on the twins, and add
  what you find to §1 with its date.
- **Each sub-phase:** implement, then an adversarial review whose findings are verified before
  fixing, then the four gates, then merge. Record facts and decisions here, not in code comments
  (code never cites this plan).

## 9. Reference checks (from the 2026-11-10 measurements)

The twins themselves are `docker/ssh-cells/` (12.0a); its scripts replaced the build recipes.

### 9.1 Checks used in the measurements

- **Log in and load wp-admin without a browser:**
  1. `curl -c jar -b 'wordpress_test_cookie=WP%20Cookie%20check' -d 'log=admin&pwd=<pw>&testcookie=1' <url>/wp-login.php`;
  2. `curl -b jar <url>/wp-admin/`.
- **WP Rocket served from cache:** the page ends with `<!-- This website is like a Rocket, isn't
  it? Performance optimized by WP Rocket.` and a second request of the same URL carries the cached
  marker. Hit the URL twice.
- **Owners and modes:** `find <root> -path ./wp-admin -prune -o -path ./wp-includes -prune -o -printf '%u:%g %m %p
'`,
  before and after; also `sha256sum` and `stat -c %i` (inode) of `wp-config.php` and `.htaccess`.
- **sudo's umask:** `su ubuntu -c "umask 0077; sudo -n -u www-data -g www-data -- sh -c umask"` →
  `0002`; through the wrapper → the umask passed (F3).
- **sudo's log:** add `Defaults logfile=/tmp/sudo.log`, run a command with a fake `--key=` argument,
  read the file; with `!log_allowed` it stays absent (F19).
- **Group rule:** `sudo -n -u <user> -g <group> -- id` for each pair in F1, under each sudoers line.
- **WP Rocket's file transforms:** run its regexes from S3/S4 with `php -r` (or `php:8.3-cli` in
  Docker) on sample `wp-config.php` texts and dump with `od -c`. This is how the `
` loss was
  found.
- **WP Rocket's source:** unzip the resolved zip (`test-results/…/artifacts`, or APVM's cache) into
  a scratch folder; the files cited in §1.2 are paths inside it.
