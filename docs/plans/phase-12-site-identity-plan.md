# Phase 12 — Run as the site: the web server's identity for every site command

Status: **done 2026-11-17** (12.0a–12.16, each merged into `develop` from a `p12-*` branch). Parent:
[e2e-modernization-plan.md](e2e-modernization-plan.md) (§3 phase table); reverses its §8.2 rejection
of "running WP-CLI as the docroot owner". Part B was the prerequisite of WP Rocket's port
([phase-6 plan §6](phase-6-feature-porting-plan.md#6-after-phase-10--wp-rocket)).

Kept here: facts measured or read from third-party source (§1), decisions and why where the docs do
not hold them (§2, §4), rejected alternatives (§2.2), risks, limits and open items (§5, §6), rules for
future work (§7) and checks to re-measure (§8). How the layer works:
[wordpress-automation.md → Site identity](../architecture/wordpress-automation.md#site-identity-wpsite-identityts)
and the sections it links; server setup and rollout:
[configuration.md → Server checklist for `runAs`](../guides/configuration.md#server-checklist-for-runas);
the twins: [configuration.md → SSH twins](../guides/configuration.md#ssh-twins). Per-sub-phase specs,
mutants and audits: git history.

## TL;DR

- **Goal:** what the suite does on a site looks as if the website did it. Over `ssh` every site
  command runs as the web server's user and group (the docroot owner, once the pre-flight verified PHP
  runs as it), through `sudo -n -u <u> -g <g> -- /bin/sh -c <wrapper>`; every `wpCli` call adds
  `--user=<the site's WordPress login>`.
- **Operator decision (2026-11-10):** we control the servers: docroots chowned to
  `<web user>:<web group>`, the SSH user has passwordless sudo plus `Defaults:<ssh user> !log_allowed`
  (sudo otherwise logs every command line, `--key=` values included: F19).
- **Fallbacks always warn, never fail a run**: missing sudo, `wp` under sudo, identity, verification or
  login → the transport's user, `normalizeOwnership` and the declared install outputs handed over, as
  before. **The identity never changes mid-process**: a transport failure is an error, never a
  fallback.
- **"As today"** where a premise needs it: `asTransportUser(transport)` (SSH user, no sudo, no
  `--user`). BackWPup's one two-user scenario opts back in its Gherkin.
- **Per site:** `transport.runAs` (`ssh` only) `"auto"` (default since 2026-11-13), `"user:group"` or
  `false` (opt-out).
- **Part A (12.0a–12.11):** the identity layer. **Part B (12.12–12.16):** WP Rocket's lifecycle
  (install outputs, licence, settling request, deactivation recovery, in-place
  `.htaccess`/`wp-config.php` cleanup, one lifecycle scenario).

## 1. Facts

Re-measure on the twins (`docker/ssh-cells/`, §8) before a change leans on one; add what you find
here, dated.

### 1.1 Measured on Docker copies of the cells (2026-11-10)

Ubuntu 24.04; Apache 2.4.58 + PHP-FPM 8.3.6; nginx 1.24 + PHP-FPM 8.5.12; sudo 1.9.15p5, WP-CLI
2.12.0, WordPress 7.2-beta1 / 6.8.3, WP Rocket 3.24 (licensed with dummy `WP_ROCKET_KEY`/`_EMAIL`
constants, S1). Docroot `www-data:www-data` 755/644 and 775/664; `ubuntu` outside the group unless
stated. PHP-FPM was started by hand with `umask 022`, so its umask is no evidence about real servers.

| # | Fact |
| --- | --- |
| F1 | Which `sudo -n -u U -g G` a passwordless rule allows: `ubuntu ALL=(ALL) NOPASSWD: ALL` → any `U`, `G` any group `U` belongs to (primary or supplementary); `(ALL:ALL)` → any `G`; `(www-data:www-data)` → only that pair. For `www-data:www-data` all three work. |
| F2 | Every sudo refusal prints `sudo: a password is required`, exit 1, a group outside the rule included. `-n` never waits for a password. |
| F3 | `sudo -u www-data` gives umask **`0002` whatever the caller's** (`pam_umask` in `common-session-noninteractive`); root gets `0022`. A wrapper running `umask "$0"` (dash) gives exactly the umask passed. |
| F4 | 23 hostile arguments (quotes, `$(id)`, backticks, newline, CR, tab, `--key=a b`, `-n`, `--`, a 64 KiB base64 string) came through node-ssh byte-identical, direct and through sudo + wrapper. |
| F5 | node-ssh's `exec` drops an empty-string argument (`shell-escape@0.2.0`) and runs `cd <cwd> ; <cmd>`, so a missing `cwd` ran the command in `$HOME`. Fixed by 12.1 (own quoting, `execCommand` only). |
| F6 | Under sudo: `HOME=/var/www`; `PATH` = `secure_path` (`/usr/local/bin/wp` found, `~/bin/wp` not); cwd kept; environment dropped unless passed through `env VAR=…`. |
| F7 | WP-CLI writes nothing to `HOME` for zip installs, `eval`, `option`, `plugin list`. Only download installs try `/var/www/.wp-cli/cache`: they warn, then succeed. |
| F8 | An unresolvable hostname makes every sudo call add `sudo: unable to resolve host <name>[: <reason>]` to **stderr** (other `sudo:` warnings, e.g. a world-writable `sudo.conf`, may precede it); exit codes and stdout unchanged. Cost per call (2026-11-13): ~4 ms when the resolver answers or refuses; **~20 s** when it never answers (glibc's 5 s × 2 attempts, A and AAAA; 2 s with `timeout:1 attempts:1`). |
| F9 | sudo + wrapper add ≤ 10 ms per call (83–88 → 87–98 ms per round trip). |
| F10 | A killed runner leaves the remote command running, with or without sudo; only the same identity, or root, can kill it. |
| F11 | `--user=<login>`: `get_current_user_id()` is that user, also with `--skip-plugins --skip-themes`; no database change. A missing login → exit 1 `Error: Invalid user ID, email or login: '<login>'` (login raw) from every WordPress-loading command; `core is-installed`, `cli info`, `core version`, `config get`, `db query` ignore it. It runs `Fetchers\User::get_check` (ID if numeric — warning when also a login —, email if email-shaped then login, else login); `ADMIN`, `QA@Example.Test` and `1` all resolve the admin (MySQL's case-insensitive match; re-measured 2026-11-11, PHP 8.5, after 53 `Deprecated:` lines on stderr). |
| F12 | WP Rocket installed as `www-data` with `--user=admin`, both stacks and modes: every file `www-data:www-data`, the page cache works, owners and modes as a wp-admin upload install; modes follow the docroot (WordPress's `FS_CHMOD_*`), except the empty `index.html` stubs, which follow the umask. |
| F13 | Left after uninstall: `define( 'WP_CACHE', false ); // Added by WP Rocket`, a 0-byte `advanced-cache.php`, an empty `wp-content/cache/`, `wp-content/upgrade/`, and on Apache the `.htaccess` block (written only by the first wp-admin request, never removed by WP-CLI: S2). |
| F14 | `wp-config.php` `root:www-data 644`: activation writes no `WP_CACHE`, nothing is cached, and **`wp plugin deactivate wp-rocket` exits 0 with the plugin still active**. Deactivation works with a `rocket_prevent_deactivation` filter removing `wpconfig` (at `PHP_INT_MAX`), or `rocket_set_wp_cache_constant` → `__return_false`, then `deactivate_plugins()`. |
| F15 | `wp-config.php` kept its inode and mode at every step (a 644→664 change seen on 2026-11-09 did not reproduce; see 12.15b's `web-config` for when it does). |
| F16 | Staging: `ubuntu` can neither create `<root>/.e2e_temp` nor upload into a www-data directory. What works: SFTP into a directory `ubuntu` owns (≥ `0711`, file ≥ `0644`), then `cp` as `www-data`. A `0700` directory fails with a misleading `Invalid plugin slug`. |
| F17 | A probe `<root>/e2e-identity-<hex>.php` fetched over HTTP reports the PHP worker's euid/egid/names/umask/SAPI (`posix` on both stacks). Inside `.e2e_temp/` it is served unless a dot-path deny rule precedes PHP handling (nginx). |
| F18 | On a docroot another account owns (`sftp_x:www-data`), WordPress's wp-admin install asks for FTP credentials (no `FS_METHOD`). |
| F19 | **sudo logs every command line it runs**, arguments included (`COMMAND=/usr/bin/echo --key=SECRET_X`; Ubuntu: syslog, `authpriv`). `Defaults:ubuntu !log_allowed` stops it; a **refused** call is still logged. `sudo -n -l` lists the matching `Defaults`. |

### 1.2 Read from WP Rocket's source (3.24; re-read at 3.24.1 for 12.12–12.16)

| # | Fact |
| --- | --- |
| S1 | Licence: `rocket_valid_key()` (`inc/functions/options.php:430`) needs an 8-character `consumer_key` and `secret_key === hash('crc32', consumer_email)`; offline, a dummy key works. `Options_Data::get` returns, in order: the `pre_get_rocket_option_<key>` filter, the `WP_ROCKET_KEY`/`WP_ROCKET_EMAIL` constants if defined, the option. `wp-rocket.php` always includes `licence-data.php`, which defines both constants as `''` unless already defined: **the option alone never licenses**. Without a valid key no `WP_CACHE` (`update_wp_cache`, `is_user_allowed`). |
| S2 | Deactivation (`inc/Engine/Deactivation/Deactivation.php:60-80`): causes = `'htaccess'` (only if `$is_apache` and `.htaccess` is unwritable; `$is_apache` is false under WP-CLI, measured) plus the `rocket_prevent_deactivation` filter, where `WPCache::maybe_prevent_deactivation` appends `'wpconfig'` (`find_wpconfig_path()` returns false for an unwritable file). A refusal stores transient `<current user id>_donotdeactivaterocket` (`0_…` without `--user`), redirects and `die()`s; core runs `deactivate_{$plugin}` before `update_option('active_plugins')`, so the plugin stays active, exit 0. Otherwise it deletes the config file and calls `flush_rocket_htaccess(true)` (a no-op under WP-CLI). A `rocket_nonce`/`force_deactivation` nonce (the admin notice's link) bypasses every cause. |
| S3 | `WP_CACHE` (`WPCache.php:145-165`): writes `define( 'WP_CACHE', <value> ); // Added by <plugin name>`; returns early when the constant already has the value; writes through `put_contents(…, rocket_get_filesystem_perms('file'))` (the mode may change). Absent → `preg_replace('/(<\?php)/i', "<?php\r\n<line>\r\n", …, 1)` (`<?PHP` becomes `<?php`). Present with another value → `/^\s*define\(\s*\'WP_CACHE\'\s*,\s*([^\s\)]*)\s*\).+/m`, no limit: `^\s*` also eats preceding blank lines, `.+` a trailing `\r`. Measured: activation leaves `<?php\r\ndefine(…true…)…\r\n\n`, deactivation `<?php\r\ndefine(…false…)…\n\n`. `find_wpconfig_path` also edits a `wp-config.php` one level up. |
| S4 | `.htaccess` markers `# BEGIN WP Rocket` … `# END WP Rocket` (`inc/functions/htaccess.php:63-64`). `flush_rocket_htaccess` rtrims each line and re-joins with `\n` (a CRLF file comes back LF); leaves the file untouched (CRLF too) when the rules already match; on a file with **no** block it **adds** one, first. |
| S5 | `advanced-cache.php` comes from `views/cache/advanced-cache.php` (defines `WP_ROCKET_ADVANCED_CACHE`); deactivation empties it. |
| S6 | Uninstall (`inc/Engine/WPRocketUninstall.php`) deletes `cache/{wp-rocket,min,busting,critical-css,used-css,fonts,background-css}`, `wp-content/wp-rocket-config/`, its tables, options, transients and the `rocket_boxes` user meta; not `cache/` itself. `$events` lists 18 WP-Cron hooks. |
| S7 | `WP_ROCKET_DEBUG` is written by `Logger::define_debug` (`Logger.php:584-622`) on a settings POST. |
| S8 | Page-cache signal (`Buffer/class-cache.php` `get_rocket_footprint`/`maybe_process_buffer`): the footprint comment ends the page; only the cache file holds ` - Debug: cached@<time>`. `cache_logged_user` is 0 on first install (`rocket_first_install`) and the logged-in cookie is a rejected cookie. |
| S9 | `Buffer\Config::get_config_file_path()` tests the config file with `realpath()`, which PHP-FPM answers from its realpath cache (`realpath_cache_ttl` 120 s): for 2 min after a deactivation deletes `wp-rocket-config/<host>.php`, each request in a worker that had resolved it logs two `include(): Failed to open stream` warnings (reproduced: 8 requests → 16). Back-to-back WP Rocket `@plugin` scenarios log them (warnings, not failures). |
| S10 | Tables install on `init` (`AbstractTable::maybe_upgrade`, BerlinDB `CREATE TABLE` without `IF NOT EXISTS`), so concurrent first requests after activation (its `preload_homepage` spawns WP-Cron beside the settle) log `Table 'wp_wpr_…' already exists for query CREATE TABLE`; harmless (the table exists). |

### 1.3 Measured while building it (2026-11-10 → 11-17, twins unless stated)

Hosts and tools:
- nginx sets its own umask to `0000` when it daemonizes; only PHP-FPM's (`0022`) matters for files.
  The PPA's PHP 8.5 `php-fpm.conf` names no pid file: start it with `--pid`.
- A `'` in `wp core install --admin_password` makes that login fail over the web
  (`wp user update --user_pass` with the same value logs in): hence the twins' password charset.
- dash's `exec` takes no `--` (a program starting with `-` is refused); dash names the wrapper by `$0`
  in its errors (`e2e-run-as: 1: cd: can't cd to …`).
- sudo's explicit deny (sudo 1.9.15p5): no `sudo:` prefix, multi-line `Sorry, user … is not allowed to
  execute '…'` quoting the arguments — never quote it. sudo 1.9.15 prints several `Defaults>user`
  runas entries on one line in `sudo -n -l`.
- sudo translates its hostname line under a locale it has a catalogue for (`language-pack-de-base`,
  `LANG=de_DE.UTF-8`). Its `env_check` passes `LANG`/`LC_*` to the command (`LC_ALL=C` reached `wp`,
  PHP, tar); `LC_ALL=C` turns tar's listing of `café.txt` into `caf\303\251.txt`; `LC_MESSAGES=C`
  loses to a session's `LC_ALL`; PHP's own locale stays `C.UTF-8`.
- `dd conv=excl` refuses any existing path, a symlink included, while dash/bash `set -C` writes
  through one to a FIFO or device (coreutils 9.4); `dd` on a full disk leaves an empty file. BSD and
  BusyBox 1.37 `dd` lack `conv=excl`.
- GNU `chmod -R` follows an operand link (coreutils 9.4: a link to a `700` folder → `777`). BSD
  `chmod` reads `--` after the mode as a file. `cp` onto an existing directory copies into it (`-T` is
  GNU-only).
- BusyBox `test -x` reads mode bits ("no" for root at `000`); BusyBox `readlink -f` resolves a dangling
  **relative** link from the working directory; macOS's `readlink -f` drops a trailing newline.
- node-ssh's `execCommand` decoded each chunk alone, turning a UTF-8 character split between chunks
  into `U+FFFD` (fixed: `decodeOutput`). ssh2's **server** refuses packets over 35,000 bytes (a line
  over ~34 KB fails as `Unable to exec` in the test server; OpenSSH took 64 KiB); ssh2 1.17 writes an
  unparsable ed25519 key ~1 in 360.
- A FIFO swapped in between a type check and an open blocks the open (hence `timeout` in root's
  put-back). `stat -c %a` prints `40`, `4` for short modes.
- macOS resolves the overlays' `localhost` to `::1` first: a `::1`-only listener answered the runs.
  `COMPOSE_PROGRESS=quiet|json` hid a recreate in `compose up --dry-run`'s text.

WordPress and WP-CLI:
- WP-CLI searches `wp-cli.yml` upward from the working directory; a `wp-cli.yml` requiring a missing
  file breaks WP-CLI. WP-CLI spawns no WP-Cron.
- `debug.log` removed, WP-CLI's PHP 8.5 `Deprecated:` lines recreate it as the CLI user's `644`, so
  PHP-FPM cannot append and web-side fatals are lost (Apache's PHP 8.3 CLI wrote nothing first). Fixed
  in `wp/log.ts` (the clear keeps or hands over the log).
- On a docroot `sftp_twin` owns, a web request's `get_filesystem_method()` is `ftpext` (no
  `FS_METHOD`): BackWPup's `start_http` then dies on `ftp_fput(null)`
  (`class-wp-filesystem-ftpext.php:266`); on nginx the fatal was lost (`fastcgi_finish_request`, and the
  log above). The twins define `FS_METHOD` `direct` whenever the docroot is not www-data's.
- A lost `spawn_cron` loopback leaves `doing_cron` set 60 s with no run.
- PHP-FPM's opcache runs the old `wp-config.php` for up to `opcache.revalidate_freq` (2 s on the
  twins) after the web server rewrote it.
- Inside a test, `playwright.request.newContext` takes the project's `use` options, the saved login
  included: an anonymous client needs an empty `storageState`.

WP Rocket at runtime (3.24.1):
- Activation over WP-CLI writes no `wp-rocket-config/<host>.php` nor `wp_rocket_settings`: **pages are
  cached only after an admin request** (the settle) writes it, as the web server; on Apache that request
  also writes the `.htaccess` block. Licensed CLI activation creates `advanced-cache.php`,
  `cache/{wp-rocket,min,busting,critical-css}`, `wp-rocket-config`; `background-css` comes on a later
  request.
- A lost plugin folder leaves 20 options (50 after the settle), 8 BerlinDB tables (`wp_wpr_*`) and 10
  `rocket_*` capabilities on `administrator`; deactivate + uninstall leaves none.
- Background work after the settle: its admin `shutdown` takes Action Scheduler's
  `async-request-runner` lock and dispatches `admin-ajax.php?action=as_async_request_queue_runner`
  (nginx 499, FPM runs on), which runs `rocket-preload` batches (`preload_url`, `blocking => false`),
  then `sleep(5)` (`AsyncRequest_QueueRunner::handle`): alive ~7 s, ~6 s past the settle. WP-Cron
  (`doing_cron`, 60 s) and WP Rocket's `*_process_lock` site transients are the other sources. AS
  gives a batch 30 s and releases a dead claim at 300 s. Teardown waits measured 9–52 s (80 runs).
- A half-deleted plugin folder (`RocketLazyload/Assets.php` gone) makes League's container pass the
  class name as a string: `Lazyload\Subscriber::__construct() … Argument #2 ($assets) … string given`.
- `web-config` variant: WP-CLI (ubuntu, group member) cannot set `WP_CACHE` in a web-server-owned
  `wp-config.php`; the settle's `admin_init` → `maybe_set_wp_cache` does. With files 664
  (`FS_CHMOD_FILE` from `index.php`) WP Rocket's write makes `wp-config.php` 664.

BackWPup (5.7.8 source and twins):
- Activation does not depend on the user; the `wp-cli` history trigger comes from the job's start
  type; user meta is written only on admin/AJAX/REST hooks; the debug log's "Runs with user:" line
  differs with `--user`. KSES: the admin has `unfiltered_html`, the kses filter is off with `--user`
  as without.
- `wp backwpup kill` → `BackWPup_Job::user_abort` deletes the running file and flags the working data;
  the job routes its errors into its own job log, so a stop adds nothing to `debug.log` but the job's
  end. As `www-data` it works ("Aborting a running backup…").
- It accepts a private folder outside `ABSPATH` (`backup-download`, job export/import, key files).
- `LogShow.php` keys logs by `filemtime` seconds: two runs in one second make "latest" arbitrary.
- The first-backup screen redirects itself to `page=backwpup` as the job ends (a navigation race with
  a step opening the dashboard).
- Root commands per full BackWPup run: legacy ~680 (324 ownership handovers), `site-775` 41
  (`cliRestore`'s content copy + `sudo -n true`), `site` adds only the web probe's write and `rm`.

## 2. Design

The states, probes, verdict hand-off, wrapper, `--user` rule and `asTransportUser` are documented in
[wordpress-automation.md](../architecture/wordpress-automation.md#site-identity-wpsite-identityts)
(and its [Transport & exec](../architecture/wordpress-automation.md#transport--exec-wpexects) and
[`--user`](../architecture/wordpress-automation.md#wordpress-runs-as-the-sites-administrator---user-wpwp-userts)
sections). The reasons behind them:

- **`auto` needs the pre-flight's verdict** (owner = PHP's identity over HTTP) and checks it before
  "the transport's user already is it": this keeps `auto` from running as a deployment account
  (`sftp_*`) the web server reaches only through group bits.
- **A probe throw is rethrown, never answered**: answering would run that one call as another user —
  the mixed ownership this phase removes. Probes run as the transport's user (`execAsTransport`), so
  none recurses through the resolver, and `elevationSupport` keeps measuring the SSH user.
- **Two caches**: the transport identity and the run identity; every cache whose answer depends on who
  runs commands is keyed by `installKey` plus the state's identity, so an `asTransportUser` copy never
  reads a `site` answer.
- **The wrapper does the `cd`**, so the SSH user never needs access to the root; transport and root
  commands keep `cd -- <cwd> &&` as the SSH user (12.4).
- **umask** default `0022` (systemd's default for apache2 and php-fpm), applied only in `site`, because
  sudo forces `0002` (F3).
- **The verdict file** lives in the cell's auth folder, not the artifacts folder: the artifacts setup
  wipes that one and runs beside the auth setup. It counts only for this `RUN_ID` and while the owner's
  uid/gid are unchanged.
- **`same-user` needs user and primary group** to match: another group changes who else may write.

### 2.1 BackWPup

- Runs on the site identity like every product. A scenario whose premise is two users opts back:
  `Given WP-CLI runs as the SSH user, not the web server` (`cli.runAsSshUser()`, before any command;
  its permission checks through `cli.transport`). Only a refusal to read the site skips it; another
  failure fails the step. It runs in `site` too (`wp-config.php` is world-readable there). Today one
  scenario ("Deleting a backup the web server made is refused…"); the 12.10 comparison found no other.
- **The private folder leaves the docroot in `site`** (`/tmp/e2e-private-<key>`, `0700`, the
  identity's): it holds downloaded backups, job exports and encryption keys, servable once owned by the
  web user. Usage: [authoring-tests.md](../guides/authoring-tests.md#backwpups-fixtures).

### 2.2 Rejected

| Alternative | Why not |
| --- | --- |
| BackWPup opting out product-wide | Rejected with the operator (2026-11-10): one scenario's outcome depends on two users; it would keep two models alive and test the new system on WP Rocket alone. |
| Faking the two-user premise with `chmod a-w` | Tests a read-only file, not a web server writing as another user. |
| `auto` = the docroot owner without verification | On a deployment-account docroot it writes `644/755` files the web server cannot write. |
| Answering a probe throw with `fallback` | One call would run as another user mid-scenario. |
| Mirroring `wp-content`'s mode as umask | WordPress applies the docroot's modes anyway (F12); copy the website's umask. |
| An environment variable as the switch | Orchestrator runs never load `.env` and get only allow-listed variables; the rollout is per server anyway. |
| Uploading through `sudo … tee` / stdin | The exec layer never feeds input; inbox + `cp` uses existing primitives (F16). |
| Setting `WP_CLI_CACHE_DIR` | Zip installs only (F7); documented, not set. |
| Licensing through the `wp_rocket_settings` option | Never licenses (S1). |
| Restoring `wp-config.php` by stripping WP Rocket's lines | Its regexes change line endings and blank lines (S3, S4); 12.15 replays its own transforms on the record instead. |
| Narrowing `DATA_DIR_MODE` (`0777`) in `site` | Measured 2026-11-12: at `0755` the opt-back scenario's `backup-delete` died "Restore working directory … is not writable" (`WorkingDirectoryProtector.php:81`): an opt-back scenario makes two writers in `site` too. |
| Storing `wp-config.php`'s bytes in staging | Staging is in the docroot and servable (F17); the record lives in `/tmp`. |
| Editing each server's `/etc/hosts` for F8 | User decision (2026-11-13): the suite runs on many servers over time; the project absorbs the line (12.11b). |
| Every sudo-routed command under `LC_ALL=C` / `LC_MESSAGES=C` | §1.3: changes tar's listings, loses to a session's `LC_ALL`, and changes the line every non-`site` state sends. |
| Removing declared residue before the install (instead of reclaiming) | Misses outputs that are not residue, deletes more than ownership needs, must not run on a part-way reinstall (wordpress-automation.md → Install outputs). |
| Batching install-output handovers | Not needed: a whole `@plugin` install on `legacy-777` took 4.0–4.3 s; real cells ≈ 12 s worst of the 30 s budget. |
| The settle through the `context` fixture | It launches a browser, which page-less (BackWPup CLI) scenarios must not; `request.newContext({ baseURL, storageState })` is the same site and session. |
| The settle waiting for quiet | The race is with removal, closed in both hooks; waiting would hide post-activation behaviour and cost ~10 s per scenario. |
| WP Rocket's `force_deactivation` nonce | Skips every cause, not only WP Rocket's own. |
| `assertResolvedInsideRoot` for root's put-back | Measured: a parent linked into a folder the SSH user cannot enter did not resolve and the walk up passed it (fixed for every target in 12.15c); `resolvesInPlace` stays stricter (no link at all). |
| Keeping a cut-short put-back's record and warning | The next record step needs the folder, and the site (an empty `wp-config.php`) is broken until written back: a strict prefix is resumed instead. |

## 3. Stack

Node ≥ 26.13.1, TypeScript 6 strict; `node-ssh` (`execCommand` only), execa, Playwright
(`request.newContext` for the probe and the settle); no new dependency. Target hosts: Ubuntu 24.04,
sudo ≥ 1.9, `/bin/sh` = dash, GNU coreutils. Twins: `ubuntu:24.04`; apache2 + php8.3-fpm; nginx +
php8.5-fpm (`ondrej/php` PPA, minor pinned); MariaDB (apache) / MySQL (nginx); openssh-server; sudo;
WP-CLI 2.12.0 phar (SHA-512 pinned).

## 4. Sub-phases (all done)

| # | Delivered | Done |
| --- | --- | --- |
| 12.0a | Twin images, `site.sh` variants, `check.sh` | 2026-11-10 |
| 12.0b | Compose, `env:cells:*`, overlays, `transport.port`, twin CI | 2026-11-10 |
| 12.1 | ssh command line: own quoting, `cd -- <cwd> && exec …`; executing ssh test server | 2026-11-10 |
| 12.2 | Config: `runAs`, `umask`, `wpUser` | 2026-11-10 |
| 12.3 | `wp/site-identity.ts`, `wp/web-identity.ts`, `wp/run-as-argv.ts` | 2026-11-10 |
| 12.4 | Exec wiring: `transport-exec.ts` split, `execAsTransport`, probes moved | 2026-11-11 |
| 12.5 | Staging through an inbox (`wp/site-staging.ts`) | 2026-11-11 |
| 12.6 | `--user=<login>` (`wp/wp-user.ts`) | 2026-11-11 |
| 12.7 | Ownership, residue, log, files in `site` | 2026-11-11 |
| 12.8 | Install outputs (`wp/install-outputs.ts`), guarded grant | 2026-11-12 |
| 12.9 | Pre-flight, healthcheck, reports, banner, login-shell gate | 2026-11-12 |
| 12.10 | BackWPup on the new system; opt-back step; private folder | 2026-11-12 |
| 12.11 | Docs, live rollout, default `"auto"` | 2026-11-13 |
| 12.11b | sudo's hostname line absorbed (`wp/sudo-noise.ts`, `setup/sudo-lookup.ts`) | 2026-11-13 |
| 12.12 | WP Rocket declarations and offline licence | 2026-11-13 |
| 12.13 | Settling admin request; WP Rocket's `stopRunningWork` | 2026-11-13 |
| 12.14 | Deactivation-recovery chain, WP Rocket's force | 2026-11-16 |
| 12.15 | In-place cleanup (a: engine; b: root fallback) | 2026-11-16 |
| 12.15c | Resolved-path guard fail-closed | 2026-11-16 |
| 12.16 | WP Rocket lifecycle scenario | 2026-11-17 |

### Twin variants (12.0a) and what each must produce

| Variant | Docroot | `ubuntu` | sudo | Expected state (`runAs: "auto"`) | Expected suite outcome |
| --- | --- | --- | --- | --- | --- |
| `legacy-777` | `sftp_twin:www-data` 777 | in group | `(ALL)` + `!log_allowed` | `fallback/owner-not-web` | as before Phase 12 (baseline) |
| `site` | `www-data:www-data` 755/644 | outside group | `(ALL)` + `!log_allowed` | `site` | green |
| `site-775` | `www-data:www-data` 775/664 | in group | `(ALL)` + `!log_allowed` | `site` | green; the refused-delete scenario runs (not skipped) |
| `no-sudo` | `www-data:www-data` 777 | in group | none | `fallback/no-sudo` | green as before; warns |
| `owner-mismatch` | `sftp_twin:www-data` 775/664 | in group | `(ALL)` | `fallback/owner-not-web`, plus a `!log_allowed` warning | as before; warns |
| `no-wp` | as `site`, `wp` only in `~ubuntu/bin` | outside group | `(ALL)` + `!log_allowed` | `fallback/no-wp` | as `legacy` requirements; warns |
| `wpconfig-root` | as `site`, `wp-config.php` `root:www-data 644` | outside group | `(ALL)` + `!log_allowed` | `site` | WP Rocket's scenario skipped (neither user can write `wp-config.php`), its teardown green via 12.14 |
| `web-config` | `sftp_twin:www-data` 775/644; `wp-config.php`, `.htaccess` `www-data:www-data 644` | in group | `(ALL)` + `!log_allowed` | `fallback/owner-not-web` | WP Rocket's edits put back by root (12.15b) |

- `legacy-777` and `owner-mismatch` (docroot not the web server's) define `FS_METHOD` `direct` (F18,
  §1.3); every other variant leaves it undefined. `check.sh` proves both, and that a web request's
  `get_filesystem_method()` is `direct` in every variant.
- `!log_allowed` on every sudo variant but `owner-mismatch`, so each variant isolates one condition.
  `no-wp`: ubuntu's `.bashrc` puts `~/bin` on `PATH` for non-interactive SSH too (a per-user install
  that works over SSH but is off `secure_path`).
- The twins' sudo log (`/var/log/sudo-twin.log`, emptied per reset) holds refused calls even under
  `!log_allowed` (F19): assert "no allowed `COMMAND=` line", never "no line". `sudo -n -l` on the twins
  lists `logfile=…`, absent on the cells: the listing parser ignores it.
- Twins run WordPress 7.1.4 (the cells ran 7.2-beta1 and 6.8.3 then); Apache's CLI `memory_limit` 256M
  as on `pro@apache`. The ondrej/php key is pinned by fingerprint (`B8DC7E53…4AD4CAB6`), PPA packages
  by minor only (the PPA keeps current builds only). What a reset clears: `site.sh`'s header.

### 12.0b — Compose, scripts, overlays

Usage: [configuration.md → SSH twins](../guides/configuration.md#ssh-twins). Why:
- `transport.port` (default 22) is part of `connectionKey`/`targetKey`/`installKey` and
  `describeTarget` (`user@host:port`): both twins share one host and root.
- A compose project apart from `docker/docker-compose.yml`, so `env:down` never removes the twins.
- The key is per user (`TWIN_KEY_DIR`), not per checkout: the twins' names are fixed, and a
  per-checkout key made a second checkout's `up` recreate them and break the first's overlays
  (measured). Another checkout's `up` compares compose's `config-hash` label and the image, not
  `--dry-run`'s text (§1.3).
- Free ports are checked on `127.0.0.1` and `::1`, the site on `localhost` and `127.0.0.1` (§1.3).
  Ports bound to `127.0.0.1` only; overlays `0600` (they hold the password).

### 12.1 — ssh command line

`sshCommandLine`: `cd -- <cwd> && exec <file> <args…>`, every word quoted, sent with `execCommand`
(no node-ssh `cwd`; F5). It refuses a non-absolute `cwd` (`cd -- ''` is a no-op) and a program starting
with `-` (§1.3); every transport refuses a lone surrogate like a NUL (it would go as `U+FFFD`). A
signal kill throws `CommandKilledError` on every transport: with `exec` no shell is left to return
`128 + n`. `wp` must be an executable on the login's `PATH`, the login shell POSIX (gated since 12.9).

### 12.2 — Config

Rules and reasons: [configuration.md](../guides/configuration.md#server-checklist-for-runas) (`runAs`,
`umask`). Also:
- Root is refused as user and group by name or all-zero id; a non-root **name** mapped to uid 0 is left
  to the run probe (`no-identity`).
- `username` with surrounding whitespace is refused: `--user` matches exactly. Every site requires
  `username`, so every loaded transport has a `wpUser`; hand-built (unit) transports have none.
- Nothing serialises a transport (project metadata carries only routing; the orchestrator reads
  `host`), so reports and run facts gain nothing from these fields.
- **Open:** unknown keys are refused on a transport and a site only; those of a cell object
  (`{ edition, sites }`), of `overrides` and of its `storage.ftp`/`storage.s3` are still dropped
  silently (checked 2026-11-19: `sites.ts` calls `refuseUnknownFields` for those two only).

### 12.3 — Identity modules

- The web probe file is written by a constant `sh -c` (`printf | dd conv=excl`), not `evalPhp`: one
  argv for the transport's user and root (`wp` never runs as root), no WordPress boot, no recursion
  through the resolver. `O_EXCL`, never `set -C` (§1.3); details:
  [wordpress-automation.md](../architecture/wordpress-automation.md#site-identity-wpsite-identityts).
- The probe's TLS follows the login's (no `ignoreHTTPSErrors`). A declared `Content-Length` past
  16 KiB is refused before reading (Playwright 1.63 had already buffered the body whole).
- Unmapped web names are omitted from the verdict file and read back as absent.

### 12.4 — Exec wiring

- Decided, kept: transport-level and root commands still start with `cd -- <cwd>` as the SSH user. The
  pre-flight's "rootDir accessible" gate (`ls -d <root>/.` as the SSH user) fails a docroot the SSH
  user cannot enter (`750 www-data`) with its fix. Running them from `/` (relative operands made
  absolute first, `log.ts`'s elevated `rm`/`cat`) is left for a host that needs it.
- Decided, kept: `ownership.ts`'s `warnOnce` dedupes per install + reason across states (an
  `asTransportUser` copy shares an install's warnings).
- A `sudo` refusal after verification throws `SiteIdentityRefusedError` and forgets only that
  resolution: read as the program's exit 1 it had turned `isPluginInstalled` true into false.
- **Known limit:** a program run as the site that itself exits 1 printing only `sudo:` lines is read as
  sudo's refusal (none of the suite's does).

### 12.5 — Staging through an inbox

How it works and its shared-root limit: [wordpress-automation.md → Staging in the `site`
state](../architecture/wordpress-automation.md#staging-in-the-site-state-wpsite-stagingts). Not in
`copyIntoTarget`: `transport-exec.ts` is the probe layer and may not resolve the state nor reach
`fileChecksum`. The site checksum stays WP-CLI (`--skip-plugins --skip-themes`), not `sha256sum`, as
`files.ts` chose. The runner's SHA-256 is taken first (a bad source makes nothing remote); the inbox
file is `upload` (no caller name in a remote path). **Limits:** `cp` onto an existing directory
copies into it (the checksum then refuses, leaving `<target>/upload` until teardown); the
resolved-path checks precede their `rm` (a link swapped in between is not seen).

### 12.6 — `--user`

Decided: live on every cell at merge, `runAs: false` included, with no gate. Evidence: BackWPup
`cli-reads` + `cli-runs` identical with and without `--user` on `legacy-777` (both twins), and its
source (§1.3). A refusal or unknown verdict waits `RECHECK_AFTER_MS` (30 s) before checking again:
re-checking at once would cost three calls per call should the check and the command ever disagree.

### 12.7 — Ownership, residue, log in `site`

Documented in [wordpress-automation.md → File ownership](../architecture/wordpress-automation.md#file-ownership-wpownershipts)
and [Elevated housekeeping](../architecture/wordpress-automation.md#elevated-housekeeping). The root
fallbacks of residue and log have no state gate: gating would let an unreadable log pass the fatal
gate. Data directories root had to `mkdir -p` in `site` are handed to the identity (component by
component, never past the root): only `0777` had hidden them staying `root:root`.

### 12.8 — Install outputs

Documented in [wordpress-automation.md → Install outputs](../architecture/wordpress-automation.md#install-outputs-wpinstall-outputsts).
- Ownership's grant refuses a link operand (`GRANT_SCRIPT`, exit 90 → `bad-target`) for every
  `normalizeOwnership` caller: `assertResolvedInsideRoot` accepts a link resolving inside the root, and
  `chmod -R` follows it (§1.3). Residual window: the shell's two steps, needing write access to the
  path's parent.
- `SETTLE_BUDGET_MS` 30 s against a Before measured ≤ 73 s of 120 s.
- **Limit:** an output written inside a pre-existing undeclared folder is not seen: declare it.

### 12.9 — Pre-flight, healthcheck, reports

Order and checks: [execution-model.md → The auth
setup](../architecture/execution-model.md#the-auth-setup-and-the-health-check), step 1. Why:
- The login-shell check is a gate and the identity report never is: the first protects command
  integrity, the second reports a host property (a fallback runs as before).
- `verifyPool` checks the login shell first (read-only), settles only sites that passed it (settling
  writes, as root on BackWPup), then `verifySite` reuses that result. An `auto` site settles as the
  transport's user (`unverified`). The web probe precedes the locale check so it, a heal and the
  reports run as scenarios will; it follows the gates, so a broken transport is reported by them, not
  by a probe.
- **`runAs: false` stays out of the identity banner** (deviation from the first design, kept at 12.11):
  `false` is the operator's choice, stated on the site's check line every run ("as configured (`runAs`
  is false); nothing to fix"), as the elevation banner is silent for `elevate: false`. Revisit if an
  opted-out site is ever found forgotten.
- What a `runAs: false` site receives, all read-only: the login-shell `printf` round trip, the `--user`
  check's `wp eval`, and with elevation `available` `env LC_ALL=C sudo -n true` (plus `env LC_ALL=C
  true` when sudo prints the host line); no probe file, `sudo -n -l`, `getent` (unless the shell check
  fails) or `.wp-cli` read.
- **Known limit (`setup/sudo-listing.ts`):** `sudo -n -l` prints global/host/user `Defaults` in one
  unlabelled block, read in print order, while sudo applies them global → host → user: only a sudoers
  setting `log_allowed` both ways is misread.

### 12.10 — BackWPup on the new system

Compared on the twins (`E2E_RETRIES=0`, 70 scenarios per cell): `legacy-777`/`runAs: false` baseline
apache 68/2, nginx 67/3; `site` 69/1 and 70/0; `site-775` 69/1 each; after the two suite fixes below,
70/70 on each stack in `site` (12.11). Fixed on the way: the twins' `FS_METHOD` and the lost web
fatals (§1.3), the onboarding navigation race (`DashboardPage.goto` waits for the page's own
navigation) and `cli-logs`' ambiguous "latest" log (its Background backdates the older run's log).

**Accepted limits** (no phase owns them):
- In `site` the opt-back scenario's WP-CLI runs as the SSH user, which cannot append to the web
  server's `debug.log`: a fatal of that one command reaches only its stderr.
- `wp/log.ts`'s clear without PHP's `posix` cannot tell an emptied log's owner, so a stale log the SSH
  user owns is left as is. Without `posix` the web probe cannot verify, so `auto` never reaches `site`
  there; every host in use has it.
- On `no-sudo` (no elevation) a log WP-CLI's user makes stays its own until the next clear removes it.

### 12.11 — Rollout and default `"auto"`

- **Live, 2026-11-13** (orchestrator drained per cell, configuration.md's procedure): `pro@nginx`
  (qa-lnmp) and `pro@apache` (qa-auto-e2e-apache) → `site` `www-data:www-data`, umask `0022`, verified
  over HTTP. Server changes: `/etc/sudoers.d/e2e-ubuntu` (`Defaults:ubuntu !log_allowed`, host-wide)
  on both; the apache docroot chowned `www-data:www-data` (3613 entries were `sftp_backwpup:www-data`).
  Results: `pro@apache` 69 passed, 1 flaky (the host reboots 04:00/16:00 UTC); `pro@nginx` 58/8
  flaky/4 failed: every failure and most flakies from the **free** BackWPup 5.7.9 active on
  `simple.e2e`, which recreates `backwpup_*` options and roles on every request (deactivated
  temporarily: 24/24); one restore flaky from another operator's `php8.5-fpm` reload.
- `free@nginx` had an explicit `"runAs": false` (to be removed once qa-lnmp's bwu site passes the
  checklist). This machine's `sites.json` no longer sets `runAs` on any cell (checked 2026-11-19);
  whether that site passed the checklist was not recorded, and other machines' sites files were not
  checked — an explicit `false` there stays until its server passes
  ([configuration.md → Server checklist](../guides/configuration.md#server-checklist-for-runas)).
- Since the default flipped, a site without `runAs` gets the web probe file in its docroot each
  pre-flight (as root through the path guards when the transport's user is refused), removed after.
  With no verdict (`--no-deps` loops) it warns `fallback/unverified` once per worker and runs as the
  transport's user.
- **Open (site setup, the user's):** the free BackWPup plugin active on `simple.e2e` (`pro@nginx`)
  breaks BackWPup's own scenarios there until removed.

### 12.11b — sudo's hostname line

Every consumer of sudo's output strips F8's line (`wp/sudo-noise.ts`: only among sudo's leading
`sudo:` lines, untranslated text only); `execAsTransport` stays raw. Before it, BackWPup's content
copy refused a tar exit 1 with only benign warnings because sudo's line came first (the restore not
run). The pre-flight times one sudo call where the run sends commands through sudo (`site` → as the
identity, never root; else root only when elevation is `available`; `docker` none): ≥ 1 s is a ⚠ line
and a banner note in any state.
- **Known limit:** a server whose SSH sessions run under a translated locale keeps the line in what it
  reports (quoted in messages, never a wrong pass).
- **Deferred (latent, pre-existing):** under such a locale tar's own warnings are translated too
  (`Datei … nicht gefunden`), so `benignCopyWarnings` refuses a copy that only raced a changing file —
  fail-safe (the restore is not run). Fix with the content copy's tar under `LC_MESSAGES=C` if a
  translated host appears (still open 2026-11-19).

### 12.12 — WP Rocket declarations and licence

Declarations in `src/projects/wp-rocket/support/` (`residue.ts`, `db-residue.ts`; read from 3.24.1 and
measured, §1.3):
- Option fragments are WP Rocket-specific (`wp_rocket_`, `rocketcdn`, `donotdeactivaterocket`, one per
  `rocket_…`/`wpr_…` family) — never bare `rocket_`/`wpr_`, which take Lazy Load by WP Rocket's and
  Royal Elementor Addons' options. `plugin_family_dismiss_promote_imagify` is not swept: Imagify's
  plugin family writes it too. Not swept by design: `rocket_boxes` user meta, `_rocket_exclude_*` post
  meta, Action Scheduler's tables and options (shared library; its uninstall keeps them).
- **Open:** its 18 WP-Cron hooks (S6) are not declared: six carry none of its option fragments, and a
  fragment for them would widen the option sweep too. The phase-6 plan's §6 makes it the first task
  before porting WP Rocket scenarios.
- Its folders and the licence file are remove-only residue (`{ path, prepare: false }`): a plain
  `siteResidue` path is also a data directory the Before creates `0777`.
- **Licence:** must-use plugin `wp-content/mu-plugins/e2e-wp-rocket-licence.php` (three
  `pre_get_rocket_option_*` filters, dummy `E2EDUMMY` / `e2e-licence@example.invalid`, `secret_key`
  computed in PHP with `hash('crc32', …)`, not `crc32b`), written before activation; `wp-config.php`
  never edited. A `mu-plugins` folder it had to create stays, empty; outside `site` the transport
  user's (`normalizeOwnership` refuses that protected path). Accepted: WordPress never writes there.
- **Deferred — a real key**, when a scenario needs a remote feature: `RocketLicence` from
  `WPR_CONSUMER_KEY`/`WPR_CONSUMER_EMAIL` through `env.ts`, plus the secret-name pattern, the guide,
  phase-0.5 plan §4 and AGENTS.md (this sub-phase's original plan in git history lists them). A real
  key reaches the site in a staged file, never in `wp eval`'s argv (`ps`, sudo's log). The operator
  offered one: ask; never commit it.
- `no-sudo`: new outputs cannot be handed over (nothing can `chown`); the handover is attempted and
  warned.

### 12.13 — Settling request and background work

How it works: [wordpress-automation.md → The `@plugin` scenario
hooks](../architecture/wordpress-automation.md#the-plugin-scenario-hooks-hookspluginhooksts). Why
the numbers in `support/background-work.ts`:
- Only WP Rocket's own Action Scheduler groups count (`rocket*`: `rocket`, `-preload`, `-rucss`,
  `-cdn`, `-insights`, `-performance-hints-warmup` in 3.24); the shared runner lock only while WP
  Rocket is on the site (counting every group made the stop wait out another plugin's work).
- Quiet = 12 s since its last action or the runner lock (5 s sleep × 2 for a chained runner + 2 s);
  gives up at 65 s (> WP-Cron's 60 s lock). A claim or action older than 65 s is stale (only a request
  killed outright leaves one; AS releases it at 300 s): warned, never waited for.
- A `doing_cron` mark counts only when begun while WP Rocket was loadable (a lost spawn leaves one
  60 s: §1.3).
- Teardown: the stop runs **first**, then the log scan: the work logs until it ends, and the next
  Before's clear would erase it. A stop that had to act in the Before re-clears `debug.log`.
- **Twin-spec trap:** a login whose 302 Playwright follows to `/wp-admin/` runs `admin_init` →
  `rocket_upgrader` and writes the config file itself, hiding a missing settle; the opener logs in
  with `maxRedirects: 0` and opens a fresh context from the saved state.
- **Decision (reversed 2026-11-16):** S10's table race is ignored by `WP_ROCKET_LOG_OPTIONS`
  (`WP_ROCKET_TABLE_CREATE_RACE`: exact message, only its own tables); any other database error stays
  fatal. **Open:** report it to WP Rocket.

### 12.14 — Deactivation recovery

Chain: [wordpress-automation.md → Plugin lifecycle](../architecture/wordpress-automation.md#plugin-lifecycle-wpplugints).
Decisions:
- `uninstallPlugin` (under test) stops at the plain deactivation: a refusal is its verdict.
- Reaching the last resort (`--skip-plugins` off `active_plugins`) in the teardown fails the scenario
  (`PluginDeactivationBrokenError`): it is the artifact under test not deactivating (e.g. a fatal in its
  deactivation hook). The product's force taking stays a reported warning; in the Before and the
  pre-flight heal the last resort only warns (the copy is an earlier run's).
- WP Rocket's force lifts `htaccess` too: its own admin force link bypasses both causes, and under
  WP-CLI `$is_apache` is false anyway. A `<id>_donotdeactivaterocket` transient stored by a user since
  demoted is left (its notice shows only to them).
- The stop deactivates first, so it meets the refusal first and uses the force (≤ 3 calls; a failed
  force is returned, never thrown). Worst case ≈ 94 s at ~5 s per call → `LEFT_WORK_ALLOWANCE_MS`
  100 s.

### 12.15 — In-place cleanup

Engine, record and root fallback:
[wordpress-automation.md → In-place cleanup](../architecture/wordpress-automation.md#in-place-cleanup-wpconfig-editsts).
WP Rocket's patterns are copied verbatim with file:line in `support/config-edits.ts`. Why:
- `wp eval --skip-wordpress`: putting `wp-config.php` back must not need it to boot.
- The record name carries the euid: two identities' records on one install (`site` vs `fallback`) never
  meet.
- A record folder that is not safe is never used, warned, the run going on unrecorded; an untrusted
  record is discarded, warned: refusing either would block every later Before, for good under sticky
  `/tmp`.
- Stale records are swept after 30 days (a record must outlive a killed run until its site's next
  scenario; the inboxes' 1 h would defeat it). **Limit:** `/tmp` is cleared on boot (AutoE2E reboots
  twice daily): a reboot between a kill and the next run loses the record, and the site keeps WP
  Rocket's edits.
- `.htaccess` rules depend on settings, so the candidate is WP Rocket's add with the rules captured
  from the file. **Not replayed** (warned, untouched): an end marker before the start, a start without
  end, the "unchanged rules" exit on a CRLF file, a white-labelled `WP_ROCKET_PLUGIN_NAME`, a
  `wp-config.php` above the root, an `.htaccess` that `get_home_path()` puts elsewhere.
- `WP_ROCKET_DEBUG`'s runtime-constant guard is not replayed (a guarded no-op is a shorter chain).
- The After also gets `LEFT_WORK_ALLOWANCE_MS`: WP Rocket's stop (≈ 94 s) beside its ≈ 23 s teardown
  overran 120 s.
- Root fallback (12.15b): never in `site` (the record is the web server's, and a file it cannot write
  is not the plugin's doing); removals are never held (a docroot the identity cannot write cannot take
  the plugin's install either). `timeout` 20 s (a swapped-in FIFO blocks, §1.3) keeps WP Rocket's three
  files inside a hook's margin. Only a write that began fails the hook, so a host that always fails root
  (no sudo rule for `timeout`, no GNU tools) never sticks the site.

### 12.15c — Resolved-path guard fail-closed

`assertResolvedInsideRoot` stepped up past **any** `readlink -f` failure: `<root>/wp-content/link ->
/root/x` (`EACCES`) passed at the root, so every elevated target (residue `rm -rf`, grants, plugin-dir
removal, staging, the web probe, BackWPup's content copy) could act through a link anyone writing the
docroot can plant. Now it steps up only past a path proved absent, checks the parent too, and retries
an unsearchable folder as the identity, then root ([wordpress-automation.md → Path
guards](../architecture/wordpress-automation.md#path-guards-wppathsts)). Residue's re-read had also read
such leftovers as removed. **Not changed:** `resolveOnTarget` (root, `resolvesInPlace`'s file,
plugin-dir) still trusts one `readlink -f` (a name ending `\r` loses it; `resolvesInPlace`'s exact
comparison then refuses); callers other than residue get root's retry only (in `site` their folders
are the identity's own).

### 12.16 — WP Rocket lifecycle scenario

`features/plugin-lifecycle.feature` (steps `steps/page-cache.steps.ts`, fixtures `visitor`/`pageCache`).
Decisions:
- Named for what it proves: WP Rocket does not leave the site as found (`WP_CACHE` false, an emptied
  `advanced-cache.php`); byte identity of `wp-config.php`/`.htaccess`/`advanced-cache.php` is the
  teardown's put-back, proved by `lifecycle.ssh-twins.spec.ts`.
- Cached = the `cached@` footprint (S8), never timing; a `cached@` older than the plugin's main file's
  mtime (WordPress's unzip dates it) is a killed run's copy; never the Given's own time (preload may
  cache the page before it). The visitor is logged out (S8) with an
  empty `storageState` (§1.3).
- `WP_CACHE` on is skipped only when **neither** the site's commands nor the web server can write
  `wp-config.php` (`wpconfig-root`), judged from the file's mode (group-writable counts; unknown → may
  write → fail, never skip). The home page is peeked ≤ 15 s for a footprint: opcache (§1.3).
- A forced deactivation at removal is judged by WP Rocket's own causes as the site's commands
  (`support/deactivation-causes.ts`): none → fail (a WP Rocket regression), else warned like the hooks.
  Reachable on `web-config`.
- Verified on the twins (3.24.1, both stacks): `site`, `no-sudo`, `web-config` green, `wpconfig-root`
  skipped naming both users; tracked paths identical before/after, no record left in `/tmp`.
  `web-config`'s `chmod(): Operation not permitted` warnings are WordPress's direct filesystem on a file
  another user owns.
- **Open:** run it on a real WP Rocket cell once the operator creates one (none exists).

## 5. Risks

| Risk | Mitigation |
| --- | --- |
| Command-line secrets in the system log (F19) | `!log_allowed` in the checklist and twins; the pre-flight warns when missing; twin specs assert no allowed `COMMAND=` line. |
| `auto` runs as a deployment account | `site` only with the pre-flight's verdict that owner = web identity. |
| The identity changes mid-process | Probe throws propagate; probes never go through the resolver; separate caches (§2). |
| sudo's forced umask `0002` (F3) | The wrapper sets the umask; twin specs assert modes. |
| sudoers refuses a group (F1) yet says "a password is required" (F2) | The run probe uses the exact wrapper; the report names `(ALL:ALL)`. |
| A resolver that never answers (F8) | Each sudo call pays its timeout: measured and reported from 1 s, never failed. |
| Private files servable once owned by the web user | Private folder and record outside the docroot in `site`; staging still holds plugin zips (not secret), and 6J keeps the staging area off the web. |
| A new scenario silently depends on two users | Compare it on the twins in `site` and `legacy-777`; give a two-user premise the opt-back step. |
| A killed runner leaves web-user processes (F10) | Anything that stops one uses the same identity. |
| The probe file served publicly | 128-bit random name, constant content, deleted in `finally`, swept after 1 h. |
| WP Rocket's edits not reversible byte for byte | Its own transforms replayed on the record; anything else warned and left. |
| Phase 11 profiles carrying identity fields | Phase 11's refused list names `runAs`/`umask`/`wpUser` and adds `profile` to the transport allow-lists ([modernization plan](e2e-modernization-plan.md), Phase 11). |

## 6. Out of scope and open items

Out of scope: identity in Phase 11 profiles; `local`/`docker` run-as; chowning docroots and sudoers
(the operator's); stopping remote processes a killed runner left; WP Rocket's feature port (phase-6
plan §6).

Open (each detailed above): unknown keys of cell objects and `overrides` (12.2); WP Rocket's WP-Cron
hooks (12.12, phase-6 §6's first task); a real WP Rocket key (12.12); translated tar warnings (12.11b);
the table race to report to WP Rocket (12.13); the free BackWPup on `simple.e2e` (12.11, the user's);
a real WP Rocket cell (12.16); running transport/root commands from `/` (12.4, only if a host needs it);
confirming `free@nginx`'s site reaches `site` (healthcheck) on every machine that runs it (12.11).

## 7. Rules for future work

- **Live cells are shared:** the orchestrator cycles them. Never run anything on them without the
  operator; up to about four parallel suites per server once agreed, naming the sites first. Build and
  verify on the twins.
- **Docker:** local (OrbStack on the operator's Mac); if it is down, ask the operator — never start
  Docker Desktop. Touch only this phase's containers and images (`wpme-ssh-*`) and throwaways you
  remove.
- **Plugin zips:** the suite resolves them (`pluginArtifact`, APVM); BackWPup needs `GITHUB_TOKEN` or
  `gh auth login`. For a manual measurement build with APVM's CLI in a shell.
- **Long runs:** keep the runner awake (`caffeinate -i`).
- **Measure, never assume:** re-measure any fact in §1 a change leans on, on the twins, and add it here
  dated. Code never cites this plan.

## 8. Reference checks

The twins are `docker/ssh-cells/` (`npm run env:cells:up`, `env:cells:reset -- <stack> <variant>`).

- **Log in and load wp-admin without a browser:** `curl -c jar -b
  'wordpress_test_cookie=WP%20Cookie%20check' -d 'log=admin&pwd=<pw>&testcookie=1'
  <url>/wp-login.php`, then `curl -b jar <url>/wp-admin/`.
- **WP Rocket served from cache:** request the URL twice; the second page's footprint carries
  `cached@` (S8).
- **Owners and modes:** `find <root> -path ./wp-admin -prune -o -path ./wp-includes -prune -o
  -printf '%u:%g %m %p\n'` before and after, plus `sha256sum` and `stat -c %i` of `wp-config.php`
  and `.htaccess`.
- **sudo's umask:** `su ubuntu -c "umask 0077; sudo -n -u www-data -g www-data -- sh -c umask"` →
  `0002`; through the wrapper → the umask passed (F3).
- **sudo's log:** add `Defaults logfile=/tmp/sudo.log`, run a command with a fake `--key=` argument,
  read the file; with `!log_allowed` no allowed `COMMAND=` line (F19). To count root calls on a twin:
  a drop-in `/etc/sudoers.d/99-e2e-log-allowed` with `Defaults:ubuntu log_allowed` and `loglinelen=0`
  makes each allowed call one `USER=` line in `/var/log/sudo-twin.log` (remove it after).
- **Group rule:** `sudo -n -u <user> -g <group> -- id` for each pair in F1, under each sudoers line.
- **WP Rocket's file transforms:** run its regexes (S3, S4) with `php -r` (or `php:8.3-cli` in Docker)
  on sample `wp-config.php` texts and dump with `od -c`: how the `\r` loss was found.
- **Reading a log without booting the site:** a `wp-cli.yml` **above** the docroot requiring a file
  that exits 1 (WP-CLI searches upward; remove it first when the required file goes).
- **WP Rocket's source:** unzip the resolved zip (`test-results/…/artifacts`, or APVM's cache) into a
  scratch folder; §1.2's paths are inside it.
