# Configuration reference

Two surfaces: **sites files** (per product, secret) and **`.env`** (runtime flags + service
credentials). Quick-start: the [README](../../README.md).

## Sites files (per product)

JSON files under `src/projects/<product>/config/`, all **git-ignored** (they hold credentials). Each
product commits a `sites.example.json` with placeholder data on the reserved `.example.test` domain.

### Which files are loaded

[`loadSites`](../../src/common/config/sites.ts) merges, in stable order:

1. **`sites.json`** — the primary file, if present.
2. **`sites.<name>.json` overlays** (`sites.docker.json`, `sites.local.json`, `sites.ssh.json`, …),
   alphabetically after it. One segment only: `sites.a.json` loads, `sites.a.b.json` is ignored.

Each file declares a **disjoint set of cells**; a cell in two files is a hard error naming both.
Edition consistency (all-or-none) is checked per file _and_ across the merge. With **none** present,
`sites.example.json` loads with a warning: the suite starts, `@noauth` smoke stays green, and auth setup
skips every placeholder site. Every field is validated with an error naming the cell and index.

### Shape

Top-level keys are **cell names** (`apache`, `nginx`, `pro@nginx`, …): a lowercase letter or digit
first, then only lowercase letters, digits, `@`, `.`, `_`, `-`, checked at load — a name is one safe
path segment (it names folders) and a Playwright project (whose `--project` filter ignores case).
`_`-prefixed names are reserved for the suite's folders (`_all`, `_unit`). A cell is a bare site array
(editionless) or `{ edition?, sites }`:

```jsonc
{
  // Editionless cell (e.g. WP Rocket): bare site array.
  "apache": [
    {
      "baseURL": "https://example.test",
      "username": "admin",
      "password": "…",
      "transport": { "mode": "ssh", "host": "203.0.113.10", "username": "ubuntu",
                     "privateKeyPath": "/home/ci/.ssh/id_ed25519",
                     "rootDir": "/var/www/html/site" },
      "overrides": { "storage": { "ftp": { "host": "ftp.alt.example" } } }
    }
  ],

  // Edition-ful cell (e.g. BackWPup): object with an edition.
  "pro@nginx": {
    "edition": "pro",
    "sites": [ { "baseURL": "…", "username": "…", "password": "…", "transport": { … } } ]
  }
}
```

### Site fields ([`SiteInput`](../../src/common/config/types.ts))

| Field       | Required | Notes                                                                                      |
| ----------- | -------- | ------------------------------------------------------------------------------------------ |
| `baseURL`   | yes      | The site's URL; each pooled worker navigates relative to its own.                          |
| `username`  | yes      | WordPress admin login; no surrounding whitespace (WP-CLI's `--user` matches it exactly).   |
| `password`  | yes      | WordPress admin password.                                                                  |
| `transport` | yes      | How WP-CLI reaches the site (below).                                                       |
| `overrides` | no       | Per-site service-credential overrides. Validated only: not merged or read yet (phase-6 6H). |

Any other key, on a site or a transport, fails the load naming it and the fields allowed there (a
misspelt `"runas": false` must not leave the default on). The resolved
[`SiteConfig`](../../src/common/config/types.ts) adds a computed `storageState` path (the worker's
saved login).

### Transport modes ([`Transport`](../../src/common/config/types.ts))

Discriminated on `mode`; dispatch in [wordpress-automation.md](../architecture/wordpress-automation.md).

| `mode`   | Required fields                                 | Optional fields                                                   |
| -------- | ----------------------------------------------- | ----------------------------------------------------------------- |
| `local`  | `rootDir`                                       | `stagingDir`, `elevate`, `fileOwner`                              |
| `docker` | `container`                                     | `rootDir`, `stagingDir`, `elevate`, `fileOwner`                   |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir` | `port`, `stagingDir`, `elevate`, `fileOwner`, `runAs`, `umask`    |

The loader adds `wpUser` to every transport, copied from the site's `username` (the WordPress login
`wpCli` acts as, `--user`, once checked to name an administrator; else dropped with a warning,
[details](../architecture/wordpress-automation.md#wordpress-runs-as-the-sites-administrator---user-wpwp-userts));
a sites file that sets it is refused.

`ssh` needs, on the site: a **POSIX login shell** for `username` (sh/dash/bash/zsh — never csh/tcsh,
which read `!` inside quotes, or fish, which reads `\\` inside them; the pre-flight fails a site whose
shell changes a quoted string, or whose startup files print text around a command's output), and `wp` as an **executable on that login's `PATH`** (a shell function or
alias is never run) ([the ssh command line](../architecture/wordpress-automation.md#transport--exec-wpexects)).

- **`port`** (`ssh` only, refused elsewhere; default `22`, and a declared `22` is dropped) — the SSH
  server's port: a JSON whole number 1–65535 (a text, fraction or out-of-range value fails the load).
  Part of the connection's identity, so two sites on one host and root (the [SSH twins](#ssh-twins))
  never share a connection or cached fact; messages name the site `user@host:port` (an IPv6 host
  bracketed: `user@[::1]:2222`).
- **`rootDir`** — the WordPress root (holding `wp-load.php`) and every WP-CLI command's working
  directory; **absolute** (`/…`) on every transport, refused at load otherwise (a relative one would
  resolve from the SSH login's home). Optional for `docker` only because the container's `WORKDIR` is that root; declare it to
  skip the one-off `pwd` lookup, or when a custom image's `WORKDIR` differs.
- **`stagingDir`** — where test artifacts (plugin zips, imports, dumps) are copied **on the site**:
  absolute, or relative to `rootDir`. Beats `E2E_SITE_STAGING_DIR`; both default to `.e2e_temp` under
  the root. It must be **dedicated** (cleanup removes it whole), so the root, its ancestors and
  top-level paths like `/var` are rejected
  ([staging](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts)).
- **`elevate`** (default: allowed) — whether **cleanup** may re-run a command with privileges when the
  site's commands (the identity in `site`, else the transport's user) cannot finish it. A plugin
  writes as the web-server user, some files in directories only that user can write, so without it
  the site grows every run. Cleanup tries as the site's commands first and escalates only what
  survived; `wp` is never elevated. Needs passwordless `sudo` for the
  transport's user on `local`/`ssh` (nothing on `docker`). `false` where that user must stay
  unprivileged; cleanup then reports what it could not remove
  ([elevated housekeeping](../architecture/wordpress-automation.md#elevated-housekeeping)).
- **`fileOwner`** (**leave it unset**) — who should own the files the suite installs, `"user:group"`,
  or `false` to switch ownership normalisation off for the site. WP-CLI installs as the transport's
  user, which the web server is not, so the suite restores the ownership the install already uses, read
  from `wp-content`. That detection is right wherever a site is consistently owned (a deployment
  account as owner included), so this exists only for one that is not.
  - **Both halves are required**, checked **at load** like every site field: `"www-data"` (no group),
    `"a:b:c"` or a value with spaces fail naming the field, the rule and the value's length, never
    the value (the file holds credentials); a non-string (`5`, `true`) by its kind. The group is never guessed: where the docroot owner is not the web server, the
    shared group is the web server's only write access. Checked at load because normalisation never fails a run, so
    a bad value checked later would be warned about once and then ignored on exactly the site being
    fixed. The same rule is enforced again before any privileged command, so the two never
    disagree.
  - Either half may be a **bare numeric id** (`"33:33"`, `"www-data:33"`) for a host whose passwd
    database cannot map the name. It is compared as an id: `stat` reports the _name_ for a mappable id,
    so treating `33` as a name would read every successful `chown` back as a failure, and would make
    the tree world-writable on the false belief that the transport user is outside its own group.
  - Normalisation needs privileges (`chown` always does): with `elevate: false` or no passwordless
    `sudo`, the site reports it cannot and carries on
    ([file ownership](../architecture/wordpress-automation.md#file-ownership-wpownershipts)).
  - In the `site` identity state (`runAs`, below) files are already the web server's: only `false`
    counts there (a malformed value still fails the load); a declared owner is neither resolved nor
    enforced, and the pre-flight says so when it differs from the identity.
- **`runAs`** (`ssh` only; absent = `false` until the
  [Phase 12](../plans/phase-12-site-identity-plan.md) rollout, then `"auto"`) — who site commands
  (`exec`/`wpCli`) run as: `"auto"` (the docroot's owner, once verified to be the web server's
  identity), `"user:group"` (the `fileOwner` rule, trimmed; root by name or id `0`, or an id above
  4294967294, refused as user **and** group: the web server never runs with group 0) or `false` (the
  transport's user, as today). The pre-flight verifies it (the web probe: a short-lived
  `<root>/e2e-identity-<32 hex>.php`, only for `"auto"`/`"user:group"`) and reports the state in its
  "Site identity" check; `"auto"` without this run's verdict (`--no-deps`) runs as the transport's user.
  **Keep real sites at `false` until Phase 12's rollout** (12.11) switches each, once its server
  passes the [checklist below](#server-checklist-for-runas).
- **`umask`** (`ssh` only; default `0022`) — the umask of commands run as the site's identity (the
  `site` state only): a text of 3–4 octal digits (`"022"`, `"0022"`), stored as four. Its owner digit
  must be `0` (`"0177"` would make new directories `0600`, unusable by their owner); a JSON number is
  refused (`22` would read as decimal).
- `runAs`/`umask` on `docker`/`local` fail the load: their commands have no second identity.

#### Server checklist for `runAs`

What an `ssh` site needs to reach the `site` state (`<ssh user>`: the transport's `username`). None
fails a run (a fallback runs as the transport's user). The pre-flight's "Site identity" check names
each one missing, with its fix; the run's banner lists only what keeps a site out of `site` (a
fallback's reason, an unverified or different web identity) and sudo's logging.

1. **Docroot owned by PHP's identity**: `chown -R <web user>:<web group> <docroot>`, and PHP (the
   PHP-FPM pool's `user`/`group`) runs as that pair. `"auto"` takes the owner of `wp-content` only
   once the web probe shows PHP runs as it, so a deployment account's docroot (`sftp_*:www-data`) stays
   a fallback (`owner-not-web`). The probe needs the WordPress root served by PHP at `baseURL` (a
   subdirectory install, another docroot or a cache answering for it leaves it unverified) and PHP's
   `posix` extension; unverified, `"auto"` falls back (`unverified`).
2. **Passwordless sudo** in `/etc/sudoers.d/`: `<ssh user> ALL=(ALL) NOPASSWD: ALL` — enough when
   the group is one of the web user's (primary or supplementary); otherwise `(ALL:ALL)` (else
   `no-sudo`). The SSH user needs no membership in the web group.
3. **`Defaults:<ssh user> !log_allowed`** beside it: sudo otherwise writes every command line,
   `--key=` values included, to the system log (warned from `sudo -n -l`).
4. **The host's own name in `/etc/hosts`**: else every sudo call prints `unable to resolve host …`
   (stripped from output, reported).
5. **`wp` on sudo's `secure_path`** (e.g. `/usr/local/bin/wp`; `~/bin` is not on it): else `no-wp`.
6. **The web user can traverse the root's parents** (search access on each): else `no-root-access`.
7. **`transport.umask`** equal to the web server's (systemd's default `0022` unless the unit sets
   another); the pre-flight warns when the web server reports a different one.

In `site` the SSH user's `~/.wp-cli/config.yml` no longer applies (WP-CLI runs with the identity's
home); move what the site needs to its `wp-cli.yml` (warned).

Switching a live cell: drain the orchestrator running it (one Ctrl-C,
[orchestrator.md](orchestrator.md)), apply the list, set `runAs: "auto"`, run `npm run healthcheck`
(its "Site identity" check must read `Runs as <user>(<uid>):<group>(<gid>)`) and one full suite run, then start the orchestrator
again.

## Editions (Free / Pro)

A product shipped as two packages (BackWPup) declares `edition` per cell, **all-or-none across its
cells**, so an edition-ful product never silently runs an editionless cell. The config factory turns it
into a Cucumber tag filter (`pro` → `not @free`, `free` → `not @pro`).

`edition` (our Free/Pro behavioural tier) is not an APVM build variant; the manifest maps each
edition to one (`pro` → `pro-en`) — see
[plugin-artifacts.md](../architecture/plugin-artifacts.md#edition-vs-variant-two-namespaces-on-purpose).

## `.env` ([`.env.example`](../../.env.example))

Copied to `.env` and loaded once from the **working directory** by
[`load-env.ts`](../../src/common/config/load-env.ts), imported first by every product Playwright config
and script (healthcheck, artifact warm, fixture capture, `report`, `report:allure`, `report:prune`),
never by the unit config. **Real environment variables always win**, even blank ones (CI secrets are
never overwritten). Every key is loaded, unknown ones included; a malformed line is skipped. A `.env`
that exists but cannot be read (a directory, no permission, a link to a missing file) fails the run
naming it; a missing one is fine. Values are validated only at this boundary, through the typed
accessors in [`env.ts`](../../src/common/config/env.ts) (`env`, `requireEnv`, `intEnv`, `boolEnv`).

### Runtime flags

| Var                      | Default                    | Purpose                                                                         |
| ------------------------ | -------------------------- | ------------------------------------------------------------------------------- |
| `E2E_CELL`               | _(unset)_ → no pin         | Pins the run to one cell (below).                                               |
| `E2E_LOAD_DOTENV`        | `true`                     | `false`/`0` in the environment skips `.env` (below).                            |
| `E2E_RETRIES`            | `2`                        | Retries per failed scenario (0–10; below).                                      |
| `E2E_REPORTS_KEEP`       | `20`                       | Reports a cell keeps (0–10000; below).                                          |
| `E2E_OUTPUT`             | `auto`                     | Terminal output: `auto`, `plain` or `fancy` ([below](#terminal-output)); else fails. |
| `CI`                     | _(unset)_                  | Non-empty enables `forbidOnly`.                                                 |
| `PRODUCT`                | `wp-rocket`                | Product for the bare `playwright.config.ts` (below).                            |
| `REPORT_MODE`            | _(unset)_ → self-contained | `rich` → external attachments + embedded trace viewer (serve over http).        |
| `RUN_ID`                 | auto-stamped               | Per-run report token; pin it to share one across a batch (below).               |
| `E2E_RUN_NAME`           | _(unset)_ → the `RUN_ID`   | **Display only**, never acted on: the run's name in the reports (below).        |
| `E2E_REQUESTED_REF`      | _(unset)_                  | **Display only**, never acted on: the plugin ref asked for (below).             |
| `REPORT_ROOT`            | `reports`                  | Report root (accumulates; pruned as each run ends).                             |
| `OUTPUT_ROOT`            | `test-results`             | Ephemeral Playwright output (below).                                            |
| `AUTH_ROOT`              | `.auth`                    | Ephemeral `storageState` root.                                                  |
| `ARTIFACTS_ROOT`         | `.artifacts`               | Resolved plugin-zip root, **wiped & rebuilt each run** ([below](#plugin-artifacts-build--verify)). |
| `E2E_SITE_STAGING_DIR`   | `.e2e_temp`                | Staging folder **on each site** (absolute, or relative to its WP root); a site's `transport.stagingDir` wins. |
| `E2E_INTERNAL_STOP_FILE` | _(unset)_ → no drain       | **Internal**, set by the orchestrator: the drain's stop file (below).           |

- **`E2E_CELL`** pins `bddgen`, the runner and its workers to one cell: the config holds it alone, so
  `bddgen` regenerates only its specs and cells run side by side. Exact name; blank = unset. An unknown
  name, or a `--project` selecting none of its projects, fails naming the variable. **Pass it per
  command, never in `.env`** (it would pin every run from that folder). Ignored by the healthcheck and
  the artifact warm, which span cells.
- **`E2E_LOAD_DOTENV`**: `false`/`0` **in the environment** skips `.env` in every process of the run,
  for a caller handing the run its whole environment (the orchestrator). Any value but
  `true`/`1`/blank fails naming it. Set inside `.env` it has no effect (the file is already being read)
  and a warning says so once per process reading it (twice for `npm run test:*`: `bddgen`, then the
  runner).
- **`E2E_RETRIES`**: every run, CI or local, scenario projects only (the auth and artifact setups never retry). `2` = three attempts; a scenario passing only on a retry is reported flaky; `0` fails fast
  while debugging. Unit tests never retry.
- **`E2E_REPORTS_KEEP`**: each run prunes its own cell beyond the newest this many, and anything older
  than 30 days but the newest complete report (kept up to 182 days). `0` = no cap (the age rules still
  apply; nothing turns pruning off). Outside 0–10000 the run fails at start naming it. Also
  `report:prune`'s default `--keep` ([retention](../architecture/execution-model.md#report-retention)).
- **`E2E_OUTPUT`** ([Terminal output](#terminal-output)): read by the suite and its scripts
  (healthcheck, artifact warm, fixture capture), never by the orchestrator. Case-insensitive, blank =
  `auto`; anything else fails the run as its config loads, naming the variable.
- **`PRODUCT`**: a name listed in [`products.ts`](../../src/projects/products.ts) (whitespace ignored);
  any other fails the run.
- **`RUN_ID`**: one folder name — no `/` or `\`, not hidden, no control character, ≤ 255 bytes — else
  the run fails naming it.
- **`E2E_RUN_NAME`** names the run in every report's title line, Cucumber banner and Allure name
  (`run-facts.json`); set by the orchestrator. **`E2E_REQUESTED_REF`** (`develop`) is shown instead of
  the pin the run builds from (`commit:<sha>`, once the orchestrator pins runs) and as "Requested ref".
- **`OUTPUT_ROOT`** holds `<product>/<cell>` for a run targeting that cell, `<product>/_all/<cell>`
  otherwise, `_unit` for unit tests.
- **`E2E_INTERNAL_STOP_FILE`**: an absolute path without surrounding whitespace, in a folder that
  exists for the run's lifetime, the file itself absent at start; any other value fails the run at
  start. Once the file exists, each scenario's first attempt is skipped as `stopped` while the one in
  flight finishes ([the drain](../architecture/execution-model.md#stopping-a-run-the-drain)).

Each `*_ROOT` is repository-relative or absolute (a root on another disk stays there), and
`<product>/<cell>` is always appended.

### Terminal output

What a terminal shows is decided once per stream, from `E2E_OUTPUT` and the standard variables
(`src/common/terminal/capabilities.ts`); nothing styled ever reaches a log, a report or
`results.jsonl`.

- **Modes**: `auto` — styled with a live block on a terminal, plain lines otherwise; `plain` — no
  colour, no cursor movement, ASCII marks and rules (the summary's Plugin and Site phrases, shared
  with the reports, keep their `·` and `—`); `fancy` — as `auto`, and live even under `CI`, but never
  colour where the rules below say no, never cursor movement without a terminal.
- **Colour**, first match wins: `plain`; a pipe or file for the orchestrator; `FORCE_COLOR` set
  (`0`/`false` off, anything else — empty too — on; it beats `NO_COLOR`, and Node then warns once);
  a non-empty `NO_COLOR`, any `NODE_DISABLE_COLORS`, `TERM` `dumb`, unset or empty, or a pipe: off; a
  terminal: on. `CI` never turns colour off.
- **Live** (the suite's block, the orchestrator's table): a terminal with a size (≥ 20 columns, at
  least one row), `TERM` set and not `dumb`, not `CI` (`true` unless empty, `0` or `false`) unless `fancy`,
  never `--list`, `--ui` or watch mode. Scripts are never live.
- **Symbols**: ASCII under `plain`, `TERM=dumb`, or a locale (first non-empty of `LC_ALL`,
  `LC_CTYPE`, `LANG`) without a UTF-8 codeset (`C`, `POSIX`, `en_US`, `*.ISO-8859-1`); unset is UTF-8.
- **Width**: the terminal's columns, else `COLUMNS` (digits only, > 0), else 80; clamped 20–120.

| Sink / env                    | Colour                                                  | Live                | Symbols   | Width            |
| ----------------------------- | ------------------------------------------------------- | ------------------- | --------- | ---------------- |
| TTY, UTF-8, no `CI`           | unless `NO_COLOR`/`NODE_DISABLE_COLORS`/`FORCE_COLOR=0` | yes                 | Unicode   | its columns      |
| TTY, `CI`                     | as above                                                | no (`fancy`: yes)   | Unicode   | its columns      |
| TTY, `NO_COLOR`               | no, unless `FORCE_COLOR`                                | yes                 | Unicode   | its columns      |
| TTY, `TERM=dumb`              | no, unless `FORCE_COLOR`                                | no                  | ASCII     | its columns      |
| TTY, `TERM` unset or empty    | no, unless `FORCE_COLOR`                                | no                  | by locale | its columns      |
| TTY, C/POSIX/non-UTF-8 locale | as the precedence says                                  | by `TERM` and `CI`  | ASCII     | its columns      |
| Pipe/file (`fancy` too)       | no, unless `FORCE_COLOR` (never for the orchestrator)   | no                  | by locale | `COLUMNS`, or 80 |
| `plain`                       | no                                                      | no                  | ASCII     | as its sink      |

A locale changes only the symbols, never colour or live. Per program: the suite's reporters and the
scripts follow the table; the scripts' rules stay 72 columns. The orchestrator reads no `E2E_*` (so
`plain` and `fancy` do nothing to it), never colours a pipe, wraps only on a terminal, and keeps its
lines' own glyphs (`✔`, `·`) in any locale — its table's marks follow the locale.
**The orchestrator's runs** get no `E2E_OUTPUT`, `TERM`, `CI` or colour variable (their environment
is an allowlist: [orchestrator.md](orchestrator.md#what-a-run-is)) and print into `run.log`, a file:
`auto` on no terminal — no colour, no live block, symbols by the `LANG` the orchestrator passes on.
`compat.pty.spec.ts` proves each row for each program on a real pty and a pipe.

### Plugin artifacts (build & verify)

Which zips a run resolves, builds (via [APVM](https://github.com/wp-media/automation-plugin-version-manager))
and verifies, per **role**: `plugin` (under test) and `previous` (an older one some tests compare
against, e.g. an update path). Model and rationale: [plugin-artifacts.md](../architecture/plugin-artifacts.md).

| Var                    | Applies            | Purpose                                                                        |
| ---------------------- | ------------------ | ------------------------------------------------------------------------------ |
| `E2E_PLUGIN_REF`       | `plugin` (a ref)   | APVM ref to build the artifact under test (branch/tag/commit/PR/`release:*`).  |
| `E2E_PLUGIN_ZIP`       | `plugin` (a zip)   | Path to a prebuilt zip of the artifact under test (absolute or repo-relative). |
| `E2E_PREVIOUS_REF`     | `previous` (a ref) | APVM ref to build the previous-version artifact.                               |
| `E2E_PREVIOUS_ZIP`     | `previous` (a zip) | Path to a prebuilt previous-version zip.                                       |
| `E2E_PLUGIN_VERSION`   | `plugin` build     | Version to build with (policy below).                                          |
| `E2E_PREVIOUS_VERSION` | `previous` build   | Version to build the previous-version artifact with.                           |

Rules ([`request.ts`](../../src/common/artifacts/request.ts); all unset → per-product defaults):

- **Ref XOR zip per role**: setting both of a role's `_REF` and `_ZIP` fails fast; neither wins.
- **Overrides need a cell, named exactly.** On a serial (cell-less) run they are **ignored with a
  warning** and defaults used — never a failure, so leftover env cannot abort a broad run. Apply them to
  one cell: `E2E_CELL=<cell>` or `--project=<cell>`; to resolve the zips without scenarios,
  `--project=artifacts:<cell>` alone (pinned or not). Unpinned, a wildcard or differently-cased
  `--project` still runs the cell but counts as broad here and warns: spell the cell out.
- **Pinning a moving ref.** `develop` or `release:latest-stable` can move between runs. To repeat what
  a warm cached, use the pin `npm run artifacts:warm` prints per request: its ref
  (`commit:<full sha>` or `release:<tag>`) as `_REF` and its version, if printed, as `_VERSION`. A
  cached commit pin resolves with no network; a release pin still asks GitHub which asset the tag is. A
  run's setup summary shows each role's full `commit`, zip `sha256`, and for a release the tag
  (`pin=release:<tag>`).
- **Values are trimmed** (a stray space in `.env` or CI YAML never joins a ref or path); blank means
  unset.
- **Don't keep a `_ZIP` under `ARTIFACTS_ROOT`**: each cell's directory is wiped whole on every
  resolution. A zip inside _its own_ cell's directory is rejected up front rather than deleted; anywhere
  else under the tree it disappears the next time that cell runs.
- **Version policy**: BackWPup **requires** a version; its `plugin` role defaults to `9.99.99` (a
  `previous` role, when added, gets one patch lower, so it is always older). WP Rocket / Imagify embed
  theirs, so `_VERSION` is optional and, when set, rewrites the built version. A `_VERSION` is ignored
  (with a warning) beside a `_ZIP` or a `release:*` ref.
- **Unsupported role**: `E2E_PREVIOUS_*` is ignored (with a warning) for a product with no `previous`
  role yet (BackWPup — [plugin-artifacts.md](../architecture/plugin-artifacts.md#deferred-obligations)).

### Fleet health check (`npm run healthcheck`)

| Var                            | Default | Purpose                                                                      |
| ------------------------------ | ------- | ---------------------------------------------------------------------------- |
| `HEALTHCHECK_CONCURRENCY`      | `4`     | Max sites checked at once within a product (1–32).                           |
| `HEALTHCHECK_LOGIN_TIMEOUT_MS` | `30000` | Per-site UI-login settle budget in ms (1000–300000); raise for slow remotes. |
| `HEALTHCHECK_HEADED`           | `false` | Headed (visible) browser; `npm run healthcheck:ui` sets it.                  |

### BackWPup storage credentials

Read by [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts) into the product's
`services` (ignored by WP Rocket); a site's `overrides` block can override any. From the environment or
`.env`; with `E2E_LOAD_DOTENV=false`, the environment only.

| Var                                                                   | Default     |
| --------------------------------------------------------------------- | ----------- |
| `BWP_FTP_HOST` / `BWP_FTP_USERNAME` / `BWP_FTP_PASSWORD`              | _(blank)_   |
| `BWP_FTP_PORT`                                                        | `21`        |
| `BWP_FTP_SECURE`                                                      | `true`      |
| `BWP_S3_ACCESS_KEY_ID` / `BWP_S3_SECRET_ACCESS_KEY` / `BWP_S3_BUCKET` | _(blank)_   |
| `BWP_S3_REGION`                                                       | `us-east-1` |

## Local WordPress via Docker

[`docker/`](../../docker/) runs Apache (`:8100`) and Nginx (`:8101`) over one MariaDB for the `docker`
transport. Copy [`docker/sites.example.json`](../../docker/sites.example.json) into a product's
`sites.docker.json` (or `sites.json`); commands (`env:up` / `env:down` / `env:logs`) in the README's "Local WordPress (Docker)" section.

## SSH twins

[`docker/ssh-cells/`](../../docker/ssh-cells/) builds Docker copies of the apache and nginx cells
(Ubuntu 24.04, sshd, sudo, WP-CLI; each script's header says what it does) for the `ssh` transport, so
site-identity work runs against real hosts' rules without touching a cell. Its own compose project
(`wpme-ssh`, `docker/ssh-cells/docker-compose.yml`), apart from the `docker` sites above: `env:down`
never removes a twin, and no port is shared.

| Command | Does |
| --- | --- |
| `npm run env:cells:up` | Removes this checkout's overlays, makes the shared key if absent, builds both images (cached; `TWIN_SKIP_BUILD=1` skips; never from another checkout than the twins' owner), refuses ports another program holds on `127.0.0.1` or `::1`, waits until both verified their site, proves each published port from the host (an `SSH-` banner; WordPress's `blank.gif` at `localhost` and `127.0.0.1`), writes and loads the overlays (a failed load removes them) |
| `npm run env:cells:reset -- <apache\|nginx> <variant>` | Resets one running twin to a variant and proves it (`check.sh`); refuses others, listing the variants |
| `npm run env:cells:down [-- --force] [-- --purge-key]` | Removes this checkout's overlays, then the containers and volumes (`--force`: even another checkout's); `--purge-key` also the shared key, its marker and (if then empty) its folder. With Docker stopped, the files still go (exit 1). The images stay |

- **Containers** `wpme-ssh-apache` / `wpme-ssh-nginx`, published on `127.0.0.1` only: SSH
  `TWIN_APACHE_SSH_PORT` / `TWIN_NGINX_SSH_PORT` (`2210` / `2211`), site `http://localhost:<port>` on
  `TWIN_APACHE_HTTP_PORT` / `TWIN_NGINX_HTTP_PORT` (`8110` / `8111`). Login `TWIN_ADMIN_USER` /
  `TWIN_ADMIN_PASSWORD` (`admin` / `twin-admin-password`; letters, digits, `._@%+=-`). A new container
  starts in `TWIN_VARIANT` (`legacy-777`); a kept or restarted one keeps its site. Changing a port,
  `TWIN_ADMIN_*`, `TWIN_VARIANT` or the image recreates the twin at the next `up`.
- **One twin set per machine, shared by every checkout.** The key is per user, outside any checkout:
  `TWIN_KEY_DIR` (absolute; default `~/.local/share/wp-media-e2e/ssh-twins/`, 0700, key 0600), so an
  `up` from another checkout keeps the twins. `cells.sh` uses or purges only a folder it made (its
  `.wpme-ssh-twins` marker) holding its own key (no passphrase, comment `wpme-ssh-twins`), and
  never changes an existing folder's mode: name a folder that does not exist yet (never `~/.ssh`).
- The containers are labelled with the checkout that created them (`wpme.ssh-twins.checkout`, its
  physical path: a symlinked path is the same owner). An `up` from another checkout builds nothing
  (the image tags are shared), uses them as they are, and refuses when compose would create or
  recreate one: a missing twin, a `config-hash` label differing from `docker compose config --hash`
  (settings, key), or a container image other than its tag's. A `down` from another checkout removes
  only its overlays and refuses the rest without `--force`. A `down` in the owner leaves other
  checkouts' overlays: run `down` there too.
- **Overlays** (git-ignored, 0600), one per product: BackWPup `sites.twins.json` → `pro@twin-apache`,
  `pro@twin-nginx` (`edition: "pro"`); WP Rocket → `twin-apache`, `twin-nginx`. Each: `ssh` to
  `127.0.0.1:<ssh port>` as `ubuntu` with the twins' key, `rootDir` `/var/www/site/public`,
  `runAs: "auto"` (verified by each run's pre-flight; twin specs register their own, asked of the
  twin's web server).
  They merge with a `sites.json` (disjoint cells; BackWPup's editions all-or-none hold, since every
  real cell declares one). **Without a `sites.json` the overlays are all that loads, never the
  example**: every run, `@noauth` included, and the healthcheck see only the twins' cells, and their
  setup needs the twins up — so `env:cells:down` removes the overlays with the twins.
- **Twin specs**: `*.spec.ts` gated on `E2E_SSH_TWINS=1` (skipped by `npm run test:unit`); twin cells
  and sites through [`__fixtures__/ssh-twins.ts`](../../src/common/__fixtures__/ssh-twins.ts). A spec
  touching a twin holds it with `withTwin(stack, …)` (a lock across workers); one needing a variant
  resets with `resetTwin(stack, variant)` inside it and puts `legacy-777` (`RESTING_VARIANT`) back. With
  the twins up: `E2E_SSH_TWINS=1 npx playwright test --config playwright.unit.config.ts ssh-twins`.
  CI: [`ssh-twins.yml`](../../.github/workflows/ssh-twins.yml) (manual, or a branch push touching
  `src/common/{wp,setup,config,auth}/`, the twin fixtures, `healthcheck.ts`, `package*.json`,
  `playwright.unit.config.ts`, `docker/ssh-cells/`, the Chromium action or the workflow) builds both
  images with GitHub's layer cache (written only by `develop` and manual runs), then runs the twin
  specs and `npm run healthcheck`.
- What each variant models and must produce:
  [Phase 12 plan → Twin variants](../plans/phase-12-site-identity-plan.md#twin-variants-120a-and-what-each-must-produce).
