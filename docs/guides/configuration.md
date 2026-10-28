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
| `username`  | yes      | WordPress admin login.                                                                     |
| `password`  | yes      | WordPress admin password.                                                                  |
| `transport` | yes      | How WP-CLI reaches the site (below).                                                       |
| `overrides` | no       | Per-site service-credential overrides. Validated only: not merged or read yet (phase-6 6H). |

The resolved [`SiteConfig`](../../src/common/config/types.ts) adds a computed `storageState` path (the
worker's saved login).

### Transport modes ([`Transport`](../../src/common/config/types.ts))

Discriminated on `mode`; dispatch in [wordpress-automation.md](../architecture/wordpress-automation.md).

| `mode`   | Required fields                                 | Optional fields                                 |
| -------- | ----------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`                                       | `stagingDir`, `elevate`, `fileOwner`            |
| `docker` | `container`                                     | `rootDir`, `stagingDir`, `elevate`, `fileOwner` |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir` | `stagingDir`, `elevate`, `fileOwner`            |

- **`rootDir`** — the WordPress root (holding `wp-load.php`) and every WP-CLI command's working
  directory. Optional for `docker` only because the container's `WORKDIR` is that root; declare it to
  skip the one-off `pwd` lookup, or when a custom image's `WORKDIR` differs.
- **`stagingDir`** — where test artifacts (plugin zips, imports, dumps) are copied **on the site**:
  absolute, or relative to `rootDir`. Beats `E2E_SITE_STAGING_DIR`; both default to `.e2e_temp` under
  the root. It must be **dedicated** (cleanup removes it whole), so the root, its ancestors and
  top-level paths like `/var` are rejected
  ([staging](../architecture/wordpress-automation.md#site-staging--file-transfer-wpstagingts)).
- **`elevate`** (default: allowed) — whether **cleanup** may re-run a command with privileges when the
  transport's user cannot finish it. A plugin writes as the web-server user, some files in directories
  only that user can write, so without it the site grows every run. Cleanup tries unprivileged first
  and escalates only what survived; `wp` is never elevated. Needs passwordless `sudo` for the
  transport's user on `local`/`ssh` (nothing on `docker`). `false` where that user must stay
  unprivileged; cleanup then reports what it could not remove
  ([elevated housekeeping](../architecture/wordpress-automation.md#elevated-housekeeping)).
- **`fileOwner`** (**leave it unset**) — who should own the files the suite installs, `"user:group"`,
  or `false` to switch ownership normalisation off for the site. WP-CLI installs as the transport's
  user, which the web server is not, so the suite restores the ownership the install already uses, read
  from `wp-content`. That detection is right wherever a site is consistently owned (a deployment
  account as owner included), so this exists only for one that is not.
  - **Both halves are required**, checked **at load** like every site field: `"www-data"` (no group),
    `"a:b:c"` or a value with spaces fail quoting the value; a non-string (`5`, `true`) fails naming
    the field and rule (a value with no readable spelling is not quoted). The group is never guessed: where the docroot owner is not the web server, the
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
| `E2E_OUTPUT`             | `auto`                     | Terminal output: `auto`, `plain` (no colour, ASCII marks) or `fancy`; else fails. |
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
