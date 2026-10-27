# WordPress automation layer

`src/common/wp/` drives a WordPress site over WP-CLI, **transport-agnostic**: the same code serves a
local, Docker or SSH site.

## Transport & exec ([`wp/exec.ts`](../../src/common/wp/exec.ts))

A [`Transport`](../../src/common/config/types.ts), discriminated on `mode`:

| Mode     | Fields                                                                                   | Dispatch                                        |
| -------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `local`  | `rootDir`, `stagingDir?`, `elevate?`, `fileOwner?`                                       | `execa`, run in `rootDir`.                      |
| `docker` | `container`, `rootDir?`, `stagingDir?`, `elevate?`, `fileOwner?`                         | `docker exec <container> …` (see `dockerArgv`). |
| `ssh`    | `host`, `username`, `privateKeyPath`, `rootDir`, `stagingDir?`, `elevate?`, `fileOwner?` | `node-ssh` (its `exec` shell-escapes the args). |

- A command is a **file + args array**, never a shell string: no interpolation, no injection.
- `exec(transport, file, args, opts?)` returns [`ExecResult`](../../src/common/wp/exec.ts)
  `{ exitCode, stdout, stderr }`; callers branch on `exitCode`. Failing to _run_ at all (missing
  binary, unreachable host, killed by signal) **throws** — an environment fault, not an outcome.
  `wpCli(transport, args, opts?)` runs `wp …` and is the primary entry point.
- **An exec error names the program and the reason, never the arguments.** The argv carries a
  `--key=` value and every value a `wp eval` snippet embeds (`phpLiteral`'s base64 is an encoding, not
  a cipher). execa's messages quote the command line, so on `local`/`docker` the message is built from
  `isMaxBuffer` (checked first: endless output arrives killed by `SIGPIPE`), `signal` and `code`
  (`ENOENT` means a missing program or a missing working directory alike). The label is the program
  only (`wp`, `sudo rm`, `docker exec <container> wp`; `docker cp`'s adds the suite's own paths). No
  execa error rides along as a `cause`; a call execa refuses outright is re-raised naming the program.
  An argument holding a NUL byte is refused before any transport sees it, by position (execa's refusal quotes it; ssh2's is a
  bare `Unable to exec`). `ssh` messages never quoted anything. Pinned in `exec.spec.ts` and
  `exec.ssh.spec.ts` with a secret planted in each argv. Not covered: a running command's argv is
  visible in the host's process list.
- **Every command runs in the WordPress root** (`rootDir` for `local`/`ssh`, the container `WORKDIR`
  for `docker`), so a relative path means the same everywhere.
- **No command is handed input.** node-ssh ends the channel's input, `local` passes
  `stdin: "ignore"`, `docker exec` without `-i` attaches none. A `[y/n]` prompt (WP-CLI's `confirm()`,
  shown by a destructive command without `--yes`) therefore reads end-of-input and declines at once,
  exit 0, nothing done — measured on all three modes. With execa's default open stdin the prompt
  waited forever on `local` (pinned in `exec.spec.ts`), as on `docker` with `-i`.
- SSH connections are cached per endpoint; `disposeConnections()` closes them (worker teardown).
- **A broken SSH link fails the command on it, never the run.** Each connection is probed every 10 s
  (`SSH_KEEPALIVE`), so a silent link is dropped within ~40 s (unprobed, a command was still waiting
  after 70 s). node-ssh listens for errors only while connecting or opening a channel, and an
  unhandled `error` event ends the worker (measured: `ECONNRESET` mid-command), so the transport keeps
  its own listener: the command fails with `the connection to <host> was lost (<reason>)` and the next
  one reconnects. A connection that died **between** commands costs a reconnect, not a failure: once
  ssh2 half-closes its socket (after a protocol error or a server's disconnect) it refuses every request with `Not connected` before sending anything,
  while node-ssh still reports it connected (minutes on a failing link; met twice by a runner waking
  from sleep). That refusal alone is retried once on a new connection, for commands and uploads
  (`withConnection`); nothing sent is ever re-sent. An unopenable connection fails as
  `could not connect to <user>@<host>: <reason>`. Pinned against ssh2's in-process server in
  `exec.ssh.spec.ts`.

### Elevated housekeeping

Some cleanup cannot be done as the transport's user: a plugin writes as the **web-server** user, and
a directory only that user can write (BackWPup's restore area: `0755 www-data`, from Monolog's `mkdir`
under the default umask) cannot be emptied by anyone else. An unprivileged `rm -rf` exits 1 and the
site keeps a database dump from every scenario.

`execElevated(transport, file, args, opts?)` runs a command with privileges;
`elevationSupport(transport)` answers `available` / `unavailable` / `disabled` first.

| Mode           | How                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- |
| `local`, `ssh` | `sudo -n -- <file> <args…>` (`sudoArgv`).                                                   |
| `docker`       | `docker exec -u 0:0 …` — the `wordpress:cli` image ships no `sudo`; the daemon is root.     |

Limits:

- **Housekeeping only** — removing leftovers, clearing `debug.log`, copying `wp-content` around a
  command under test that rewrites it. **Never `wp`**: WP-CLI refuses root without `--allow-root`, and
  files it made as root would be unwritable by the web server. `wpCli` cannot request elevation, so
  the rule is structural.
- **Never on a path a scenario asserts against**: it cannot make a product pass, only removes what the product left, after the
  verdict.
- **Second, never first**: callers try as themselves and escalate only what failed, so a
  correctly-permissioned host never runs a privileged command, not even the probe. Two exceptions. Ownership normalisation elevates `chmod` and `chown` directly (only the owner or root may `chown`,
  and the owner is by then known not to be us), yet decides before probing and skips both when the
  transport user already owns the install ([File ownership](#file-ownership-wpownershipts)). BackWPup's guard around `wp backwpup restore` (`support/content-copy.ts`) copies `wp-content` and
  puts it back as root from the start (only root reads every file and restores every owner), refusing
  to run the command where it cannot; so does settling a copy a reboot orphaned
  (`support/content-copy-leftover.ts`). Root acts on the copy only inside its directory, once proved
  root's, not a link and — for the run that made it — still holding its token (`IN_COPY_SCRIPT`).
- **Never interactive**: `sudo -n` fails instead of waiting for a password; `--` stops sudo parsing
  the target's flags.
- **Refusable per site** (`transport.elevate: false`), enforced by `execElevated` throwing. The probe
  is cached per target; the first real use is announced once, so a privileged run is never silent.

The module also owns **file transfer** (same dispatch, same cached SSH connection):

- `wpRootDir(transport)` → the **absolute** WordPress root: declared for `local`/`ssh`; for `docker`
  the container `WORKDIR`, read once with `pwd` and cached (declare `rootDir` to skip it).
- `copyIntoTarget(transport, localAbs, targetAbs)` → copies a runner file onto the target,
  overwriting: `node:fs` (`local`), `docker cp` (`dockerCpArgv`), SFTP `putFile` (`ssh`). It does not
  create the parent; staging does.
- `assertResolvedInsideRoot` — where a path really leads ([Symlinks](#symlinks)).

## Playwright ≥ 1.62 is a floor, not a preference

**Do not downgrade below 1.62.** On 1.61 an ordinary wp-admin save (post/redirect/get) could leave
the tab **permanently unable to produce frames**: `requestAnimationFrame` dropped to 0 and stayed
there across navigations and reloads; only a new tab was clean. Primitives needing a frame broke while
DOM reads kept working, so it looked like a locator problem:

| Primitive                                  | Needs a frame                                          | On a wedged tab                    |
| ------------------------------------------ | ------------------------------------------------------ | ---------------------------------- |
| `click()` (actionability's `stable` step)  | yes — an unbounded `rAF` loop with no internal timeout | never dispatches; burns the budget |
| `toBeInViewport()`                         | yes — `IntersectionObserver` + an `rAF` nudge          | never answers                      |
| `page.screenshot()`, video                 | yes                                                    | hangs / records nothing            |
| `toBeVisible()`, text, counts, `evaluate`  | no — synchronous layout reads                          | answer instantly                   |

Cause: Chromium's **`RenderDocument`**, which Playwright 1.61 disabled as a temporary fix for its own
CI (microsoft/playwright#37715, tracked by #37714). Chromium fixed the defect in **147+** and
Playwright re-enabled it in **1.62** (Puppeteer too). Verified on a real cell: on 1.61 the chain
wedges at the submit and screenshots time out; on 1.62.1 it holds ~61 frames/0.5 s and screenshots
take ~35 ms. No launch flag involved. The trigger is not fully characterised: it reproduces on a real
site, but a synthetic POST → 302 → GET (with latency, composited, fixed-position or large documents)
and `wp-login.php`'s own redirect never wedged. The floor removes the cause regardless.

## Site staging & file transfer ([`wp/staging.ts`](../../src/common/wp/staging.ts))

WP-CLI reads the **site's** filesystem, so a file handed to `wp` must be there first; only `local`
shares the runner's filesystem. One directory per site holds such files, by **category**:

```text
<WP root>/.e2e_temp/            ← on the SITE, not in the repo
├── plugins/<name>.zip          → wp plugin install
├── imports/<name>.xml          → wp import        (future)
└── <category>/<name>           → any artifact a test needs on the target
```

It sits at the WordPress root (already every transport's working directory) and is generic:
`plugins/` is just the first category.

| Function                                                  | Purpose                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `stageArtifact(transport, localPath, { category, as? })`  | `mkdir -p` the category, copy the file in, return its **absolute target path**.                                                 |
| `stageAndInstallPlugin(transport, localZip, opts?)`       | Stage into `plugins` → `installPlugin`, then **restore the plugin's ownership** when `opts.slug` is given ([File ownership](#file-ownership-wpownershipts)). |
| `siteStagingDir(transport)`                               | The site's absolute staging directory.                                                                                          |
| `cleanSiteStaging(transport, ...path)`                    | `rm -rf` the whole area, or one category or entry in it.                                                                        |
| `stagingPath(root, ...segments)`                          | Pure POSIX path builder; validates each segment.                                                                                |

```ts
const artifact = pluginArtifact("plugin");
const zip = await stageAndInstallPlugin(site.transport, artifact.zipPath, {
  activate: true,
  // Without the slug the unpacked directory is unknown, and the plugin stays owned by the transport's user.
  slug: artifact.slug,
});
```

- **Location**: `transport.stagingDir` (absolute, or relative to the WP root) beats
  `E2E_SITE_STAGING_DIR`, which beats `.e2e_temp` — for a host whose user cannot write the root, or to
  keep files out of the docroot. A failed `mkdir -p` names the override.
- **Idempotent**: the copy overwrites, so re-staging and a crashed run's residue are harmless.
- **Safe by construction**: `category` and filename are single segments (no `/`, no `..`); the source
  must be an absolute path to an existing file; the WP root must be absolute (a relative one makes SFTP
  stage into the login's home). Since cleanup removes the area whole, a staging root is rejected when
  it resolves to the WP root or an ancestor (however spelled, an absolute `E2E_SITE_STAGING_DIR` equal
  to `rootDir` included), has fewer than two segments (`/`, `/var`), or is relative and escapes the
  root. Elsewhere is fine as an absolute path.
- On `local`, staging a file onto itself is detected (device + inode) and skipped: a self-copy can
  truncate it.
- **Cleanup**: `cleanSiteStaging` throws on failure so a dirty site is visible; a teardown hook should call it
  best-effort (catch + log).
- **Concurrency**: one worker per site per invocation, so no two workers share a staging area. Runs on
  one host can still meet in a shared _absolute_ staging root — tracked in the
  [orchestrator plan](../plans/orchestrator-plan.md) (Phase 0A.3).
- **Exposure**: on our cells the WP root is the docroot, so `.e2e_temp/…` is served — measured on both
  nginx cells: a file there gets 200, one inside a folder only the transport's user may enter 404,
  directories 403 (not listed). For anything sensitive use such a folder (as BackWPup's private folder
  does) or stage outside the docroot (the Location override). Wiped in teardown.

## Plugin lifecycle ([`wp/plugin.ts`](../../src/common/wp/plugin.ts))

Removal runs `wp plugin uninstall`, **not** `delete`: `delete` removes only files, `uninstall` first
runs the plugin's own uninstall (`uninstall.php` / `register_uninstall_hook()`), clearing its
database footprint.

An active plugin is **deactivated as its own WP-CLI call first** — never `uninstall --deactivate`.
That flag does both in one PHP process where the plugin's main file is already loaded, so a
well-behaved `uninstall.php` sees itself loaded and skips its cleanup. A separate plain `uninstall`
runs in a fresh process that never loads it.

Two removal intents, with opposite semantics:

| Function                              | Intent                           | Already absent                    |
| ------------------------------------- | -------------------------------- | --------------------------------- |
| `ensurePluginAbsent(transport, slug)` | **Cleanup** (Before/After hooks) | Success (no-op).                  |
| `uninstallPlugin(transport, slug)`    | **Removal under test**           | Throws `PluginNotInstalledError`. |

`wp plugin uninstall` exits non-zero for both "not found" and a real failure, so its exit code is not
trusted. **"Absent" means nothing at the plugin's path**, never "WordPress lists no plugin there" (all
`is-installed` can say), so both intents judge removal by the path
([below](#plugin-folders-wordpress-cannot-see-wpplugin-dirts)):

- `ensurePluginAbsent` **heals**. A listed plugin is deactivated and uninstalled through WordPress; if
  that uninstall fails, it is first taken off `active_plugins` with **no plugin loaded**
  (`wp --skip-plugins plugin deactivate`, verified by `--skip-plugins plugin is-active` exiting 1, else
  `PluginDeactivationFailedError`, nothing removed) — a copy that cannot boot makes plain `is-active`
  exit 1, read as inactive, and the next `install --activate` would find it "already active" and skip
  its activation (measured) — then its folder is removed by path. An unlisted folder is removed by
  path. Returns what it removed (`ClearedPluginDir`, `cause`: `unlisted`, `uninstall-left`, or
  `uninstall-failed` with the first error line) for the hooks to report. A clean site pays one read.
- `uninstallPlugin` **judges**: anything left at the path throws `PluginUninstallFailedError` naming
  it, left for the cleanup after it; an unlisted plugin throws `PluginNotInstalledError`, naming what
  is at the path, if anything.

Also: `isPluginInstalled` / `isPluginActive` (WordPress's view), `ensurePluginDeactivated`
(idempotent), `pluginBreaksBoot` (the fatal WordPress dies on with the plugin loaded, when it boots
with `--skip-plugins=<slug>`; asked only after a failure, since that boot logs the fatal), `activatePlugin`, and `installPlugin(transport, source, opts?)` — a slug, a zip path
**on the site**, or a URL ([`InstallPluginOptions`](../../src/common/wp/plugin.ts)
`{ activate?, force? }`); a runner zip goes through `stageAndInstallPlugin`. "Destination folder
already exists" becomes `PluginDestinationExistsError`, saying whether WordPress lists a plugin in the
folder. WordPress takes only a folder for one in the way, so a file or a dangling link at the path
fails as `Warning: Could not create directory. "<path>/"`, exit 1 (measured), which becomes
`PluginDestinationBlockedError` naming what is there — only when the path is the plugin's own and
something is at it (an unwritable plugins folder fails the same way with nothing there). The asserted wp-admin flow lives in [`PluginsPage`](../../src/common/pages/plugins.page.ts)
([authoring-tests.md](../guides/authoring-tests.md)); its `delete` reads WordPress's `delete-plugin`
answer — `success: false` fails `PluginDeletionFailedError` quoting its `errorMessage`, a non-JSON
answer (a killed request's gateway page) fails naming its status.

## Plugin folders WordPress cannot see ([`wp/plugin-dir.ts`](../../src/common/wp/plugin-dir.ts))

WordPress removes a plugin **entry by entry** (`WP_Filesystem_Direct::delete`, WP-CLI's `rm -rf`). A
removal stopped part-way — the QA servers restart PHP-FPM and reboot several times a week — leaves
part of `<WP_PLUGIN_DIR>/<slug>`, which part following directory order. Both shapes were reproduced
on the QA servers by SIGTERM-ing core's `delete_plugins()`:

| Shape | Seen on | WordPress | Blocked before this module |
| --- | --- | --- | --- |
| Main file gone | nginx (`backwpup.php` 1st in directory order) | Lists nothing; `delete` says "already deleted" | Every install: "Destination folder already exists" |
| Main file kept, `vendor` half gone | apache (`backwpup.php` 15th) | Lists it; `uninstall.php` dies on a missing `require_once` | Every uninstall |

- `inspectPluginDirs(transport, slugs)` / `inspectPluginDir` — one `wp eval` (plugins and themes
  skipped, so a broken copy cannot stop it): `absent`, `recognised` (a `<slug>/<file>.php` key of
  `get_plugins()` — WordPress's own list; not `get_plugins( '/<slug>' )`, which also finds a header a
  folder deeper) or `orphaned`, with the type (`lstat`: a link is never walked), an entry count
  (`capped` past `ENTRY_COUNT_CAP`), the first top-level names, owner and age by the site's clock.
- `removePluginDir(transport, slug, { recognised? })` — cleanup only; refuses a listed plugin unless
  told its uninstall failed. The path is the site's own `WP_PLUGIN_DIR` (under a symlinked `rootDir`,
  accepted under the root's real path), held inside the root lexically and where its **parent** leads
  (`assertResolvedInsideRoot`; a link at the slug is removed as a link). Removed through
  `residue.ts`'s `removeEscalating`, then inspected again: anything left throws
  `PluginDirRemovalFailedError` — thrown, unlike data residue, since the next install cannot succeed.
- `describePluginDir` — the one-line plain-text description reports, errors and pre-flight share.
- Only the slug the cell installs is inspected (pre-flight: `resolveIdentity` of the manifest and the
  cell's edition): shared sites hold other teams' unlisted folders, and another edition's is not the
  cell's to clear.
- An **active** copy of the second shape kills every request that loads it (measured on apache: `wp
  eval` exit 1 on its fatal, `wp-login.php` HTTP 500; `core is-installed` still exit 0), so the auth
  setup failed before any `@plugin` hook could heal it. The pre-flight blames the cell's plugin only
  when WordPress boots with that slug skipped, then removes it with `ensurePluginAbsent` before
  logging in; the healthcheck reports it and changes nothing
  ([`setup/cell-plugin.ts`](../../src/common/setup/cell-plugin.ts)).

## Error types ([`wp/errors.ts`](../../src/common/wp/errors.ts))

Distinct classes so steps and reports tell failure modes apart:

- `PluginNotInstalledError` — an expected plugin is not listed; names what is at its path, if anything.
- `PluginActivationFailedError` / `PluginDeactivationFailedError` — a UI or WP-CLI action failed.
- `PluginUninstallBrokenError` — the plugin's own uninstall failed and cleanup removed it by path; the
  `@plugin` teardown fails the scenario with it.
- `PluginUninstallFailedError` — something still at the path after `wp plugin uninstall`, named.
- `PluginDeletionFailedError` — the admin-UI Delete failed: WordPress refused, gave no answer, or still
  lists the plugin.
- `PluginDirRemovalFailedError` — cleanup could not remove what is at a plugin's path, named, with
  advice for the site's elevation state.
- `PluginDestinationExistsError` — an install met a folder at the plugin's path.
- `PluginDestinationBlockedError` — an install met a file or a dangling link at the plugin's path.
- `DebugLogFatalError` — PHP wrote a fatal to `debug.log` during a scenario; carries every fatal and
  quotes the first few, so the reporter alone diagnoses it.

## Debug-log scanning ([`wp/log.ts`](../../src/common/wp/log.ts))

Reads and categorises `wp-content/debug.log` to catch PHP errors a UI assertion misses.

- Reads and clears via `wp --skip-plugins --skip-themes eval` (resolves a custom `WP_CONTENT_DIR`,
  which `wp-config.php` sets; core sets up `WP_DEBUG_LOG` before any plugin loads). No plugin is
  loaded: a copy that cannot boot would kill the read and, through `WP_DEBUG_LOG`, write its fatal
  into the log being judged (measured). A boot that still fails logs and **falls back** to a direct
  file read/removal.
- **`wp eval` exits 0 even when its PHP failed** (a denied write to the web server's `debug.log` is
  only a warning), so each snippet reports its own outcome: the clear prints `cleared`/`kept`, and a
  read that cannot open an existing log exits non-zero instead of returning `""`. A log that never
  clears would make one scenario's fatal fail every later one; a read quietly returning `""` would disable the fatal gate.
- Clearing **removes** the file (needs write on the directory, usually the transport user's) rather
  than truncating it (needs write on the file, the web server's); WordPress recreates it. If it
  survives both routes, `clearDebugLog` throws.

API: `clearDebugLog(transport)` (in a `Before` hook), `readDebugLog(transport)` (`""` if absent),
`scanDebugLog(transport, opts?)` → [`DebugLogScan`](../../src/common/wp/log.ts)
`{ raw, fatals, warnings, notices }` by PHP severity. [`ScanDebugLogOptions`](../../src/common/wp/log.ts):
`ignore` — patterns excluded everywhere (only noise confirmed from real runs); `source` — categorise
only lines matching these (a plugin's path); `raw` is always the whole log.

Presets in `src/projects/<product>/support/debug-log.ts`: `*_LOG_OPTIONS` scans every source;
`*_OWN_LOG_OPTIONS` only that plugin (BackWPup matches Free and Pro paths; only the installed
edition's appears).

**Most scenarios need none of this**: a product declares its preset as `ProductConfig.debugLog` and
the `@plugin` hooks clear the log before a scenario and fail it on a fatal, log attached (see
[AGENTS.md → Shared scenario hooks](../../AGENTS.md#shared-scenario-hooks)). Call `scanDebugLog` only
when a step asserts on the log:

```ts
import { scanDebugLog } from "../../../common/wp/log";
import { WP_ROCKET_OWN_LOG_OPTIONS } from "../support/debug-log";

const scan = await scanDebugLog(site.transport, WP_ROCKET_OWN_LOG_OPTIONS);
expect(scan.warnings).toEqual([]);
```

## Worker teardown ([`wp/teardown.ts`](../../src/common/wp/teardown.ts))

`releaseSite(site)` removes the site's staging area, then closes pooled SSH connections; the
`releaseBoundSite` fixture runs it once per worker.

- **Best-effort**: assertions are done by then, so a removal failure warns, never throws.
  Connections close either way (a leaked SSH client keeps the worker alive).
- **Unconditional, not tracked**, so a crashed run's residue goes too.
- **Placeholder sites are skipped**: no reachable transport, so it would only warn.

## Left-over plugin data ([`wp/residue.ts`](../../src/common/wp/residue.ts))

An uninstall removes a plugin's code and (via `uninstall.php`) its database footprint, but not the
files it wrote — the user's data. A suite reinstalling per scenario leaks them. BackWPup's uninstall
touches no files and each install writes under a new random directory: **6.8 GB across 28
directories** on the QA cell before this existed.

- A product declares them as `ProductConfig.siteResidue` (paths relative to the WP root); the `@plugin`
  teardown clears them after every tagged scenario, reading the per-process registry (no product
  import).
- `removeSiteResidue(transport, paths)` validates **every** path before removing any, removes them,
  and **confirms they are gone** rather than trusting `rm -rf`'s exit code. Every path is attempted;
  the error names all survivors.
- **Two passes**: as the transport's user, then whatever survived
  [with privileges](#elevated-housekeeping) — a correctly-permissioned host never elevates, one whose
  data the web server owns still ends clean. Before a privileged `rm -rf`, `rootDir` must be plausible
  (absolute, not top-level, target resolving inside it) — the half `normaliseResiduePath` cannot see.
  The passes are exported as `removeEscalating(transport, root, paths)` (`removed`, or the survivors
  and the elevation that could not clear them) for the plugin folders above; the caller checks
  containment first.
- **Cost does not grow with what it finds.** Each command is a round-trip (~0.8 s over SSH);
  one-at-a-time removal (~6 commands each) once took the teardown past its 120 s budget on a site with
  28. So the root is resolved once (`assertAllResolvedInsideRoot`), a family is checked once via its
  parent (its members are listed directories, never links, so inside the root exactly when the parent
  is), each pass removes everything in one `rm -rf` (chunked at 200 paths) and re-reads with one
  listing per family plus a `test -e p -o -L p` per path (a dangling link counts). A failed re-listing with the parent still there counts
  every member as a survivor: "could not look" never reads "gone".
- `normaliseResiduePath` rejects anything not below the root: absolute, escaping, a directory
  WordPress owns (`wp-content/uploads` and friends), or inside `wp-admin`/`wp-includes`. It guards
  against a config typo, not a hostile config.
- A **family** (`SiteResidueFamily`) declares directories a plugin names at runtime: a parent and a
  name pattern, e.g. `{ parent: "wp-content/uploads", name: /^backwpup-restore-[0-9a-f]{20}$/ }`.
  `parseResidueDeclaration` holds the parent to the path rules (it may be a WordPress directory, being
  only listed, but not the root; no segment edged with whitespace). The pattern must bound the
  **whole** name with `^`…`$` (a `\$` is no anchor; no alternation, not multiline, global or sticky)
  and open with the plugin's fixed prefix, three characters at least (`/^[a-z0-9]+$/` would take every
  year folder in `uploads`); one that would match a WordPress directory is refused. Patterns breaking
  these rules were measured removing another plugin's directory and a media year folder. Removal lists
  the parent with `find -H -type d` (a linked parent is followed, nothing below it: no files, no links,
  nothing deeper), escalating as removal does, matches whole names (one edged with whitespace never
  matches) and re-validates each match — catching what a killed run left too. An unlistable parent
  does not stop the other paths; it fails the teardown afterwards. `resolveSiteResidue` answers what
  the declarations name now. A family names nothing to create, so preparation skips it.
- `prepareSiteDataDirs(transport, paths)` is the other half, run by the **Before** hook on the same
  list: per path it creates the directory, opens it `0777` to every user sharing the docroot, then
  hands it to the site's ownership with `normalizeOwnership` (this too writes as the transport's
  user). The mode is a floor that holds where ownership cannot be fixed; the correction adds the owner
  and, where it has anything to do, is **recursive**, reaching a subtree the mode cannot (one an earlier scenario wrote as the web
  server, or the plugin's activation just created via WP-CLI). Where the transport user already owns
  the install (`docker`) it is `unnecessary` and only the mode applies; it is best-effort anyway, so a host refusing it still gets prepared directories. Preparation escalates when the transport's user is refused, so it runs the same root-plausibility guard as removal, and refuses a path
  that is a symlink wherever it leads (`chmod` follows it: a data directory linked at the root once
  opened the root `0777`) — else a top-level `rootDir` would get world-writable root-owned directories
  at `/` that teardown then refuses to remove.
  **Why**: on a real cell WP-CLI (`ubuntu` over SSH) and the web server (`www-data` under PHP-FPM)
  differ, and the plugin creates these directories under whichever umask it runs with, so the first
  writer locks the other out. Observed on the QA cell: `uploads/backwpup-restore` created
  `drwxrwxr-x ubuntu:ubuntu` by WP-CLI at 15:38:49, the next admin request dead at 15:38:50 on
  `Folder "…/backwpup-restore" is not writable` (`BackWPup_File::check_folder`). It stayed hidden while removal was failing, because a copy the web server made months earlier never went away. `0777` is what the plugin asks itself
  (`mkdir($dir, 0777, true)`, narrowed only by the umask) and what `wp_mkdir_p` produces (inheriting
  `wp-content/uploads`, already `0777` on these cells).
- `prepareResolvedDataDirs(transport, resolved, declared)` prepares the same way the directories a
  product resolves after each install (`ProductConfig.resolveSiteDataDirs`) — names only the installed
  plugin knows. Each must be covered by a declaration (`isDeclaredResidue`), or it would never be
  removed: refused before anything is created. The resolver is asked before any directory is prepared, since asking boots
  WordPress over WP-CLI as the transport's user. BackWPup's restore working directory is resolved this
  way: since `214ad9d` it is `uploads/backwpup-restore-<20 hex>`, and a WP-CLI backup listing creates
  it `0775` as the transport's user, after which every admin page listing backups died with HTTP 500 on
  develop (measured).

**Best-effort against permissions, strict about everything else.** A survivor means privileges did
not help either: the site cannot escalate (no passwordless `sudo`, or `elevate: false`) or something
other than permissions holds the path; the error says which ("make it writable" is useless once root
already tried). That is a fact about the cell and breaks
no later scenario, so it is reported (console warning + `uncleared-site-data` attachment), not failed.
An unusable declaration, an implausible `rootDir` for a privileged delete, or a transport that cannot
run a command still throws.

## Left-over plugin footprint ([`wp/db-residue.ts`](../../src/common/wp/db-residue.ts))

The mirror image: a plugin's database cleanup lives in its own `uninstall.php`, so it runs only
**while its files are still there**. A site whose plugin directory went while its rows stayed — or
whose folder cleanup removed by path after a failed uninstall — has no uninstall left to run, and the
next install lands on the old state. Measured on `pro@apache`: the forbidden
`wp plugin uninstall <slug> --deactivate` ([Plugin lifecycle](#plugin-lifecycle-wpplugints)) deletes
the files and leaves **26 options and `wp_bwpup_backups`**; the next run then fails with _"a freshly
installed BackWPup should owe its onboarding"_ — the plugin reads its leftover `backwpup_version`,
takes it for an upgrade and never sets the onboarding flag. So the sweep keys off the **footprint**,
never off `is-installed`.

- Declared as `ProductConfig.siteDbResidue`: `optionsContaining` (option-name fragments), `tables`
  (unprefixed), `roles` and `capabilities` (exact names); the `@plugin` hooks sweep whatever they find,
  via the registry.
- **Roles, because activation cannot replace them**: `add_role()` returns without a change when the
  role exists (`class-wp-roles.php`), so BackWPup's "add/overwrite roles" keeps a leftover role's
  capabilities. Measured on `pro@apache`: a planted `backwpup_check` kept its planted capabilities
  through a fresh install; swept, it got the artifact's. A failed uninstall leaves the three roles and
  11 administrator capabilities. Roles go whole (`remove_role`); a declared capability is taken from
  every other role holding it (`WP_Role::remove_cap`), read from the `<prefix>user_roles` row, not a
  cache. A site whose roles live in code (`$wp_user_roles`) or whose row is unreadable is refused.
- **Fragments match anywhere in a name**, since a plugin's transients are options whose names do not begin with its prefix
  (`backwpup_<jobid>_gdrive` is stored as `_site_transient_backwpup_<jobid>_gdrive`, observed). Matched
  literally (`%`, `_` escaped with `esc_like`). A fragment under three characters is refused: it would
  sweep the site.
- **Ordering is the guarantee**: both callers sweep right after `ensurePluginAbsent`, which throws if
  anything survives at the plugin's path. Measured: sweeping with the plugin active deletes the rows, and the next request
  re-creates all 26 options and the table on `init`.
- Rows go through **`delete_option`**, not `DELETE`, so WordPress invalidates its caches (no flush
  needed); tables are dropped `IF EXISTS`. Removal is **verified by re-reading** from the database in a
  second process: `DROP` reports success for a table it never touched, and `delete_option` returns
  false both for "absent" and "a filter refused".
- WordPress loads **`--skip-plugins`**, so other plugins hooking option writes cannot change the
  outcome; core (`delete_option`) is unaffected.
- **Guards against a wrong declaration** (not a hostile one): `PROTECTED_TABLES` refuses one of
  WordPress's tables at declaration time; `PROTECTED_ROLES` / `PROTECTED_CAPABILITIES` (core's
  `populate_roles()` set) refuse a core role or capability, and every role and capability must be
  lowercase `[a-z0-9_-]` and carry one of the `optionsContaining` fragments (keeps out another plugin's); `PROTECTED_OPTIONS` is checked against what the query
  actually **matched** (only the site knows what a fragment reaches) and refuses the **whole** sweep
  before deleting anything if it reached `siteurl`, `active_plugins`, `cron`, the prefixed
  `user_roles` or the rest of that list — the same bet `PROTECTED_SITE_PATHS` makes for a privileged `rm -rf`.
- **Never elevated** (WP-CLI and SQL only). Verified on both cells: sweeping a clean site leaves
  options, tables, user meta, roles, capabilities and cron byte-identical and runs no privileged
  command.
- **Multisite is refused**: its options live in `sitemeta` per network, and looking in the wrong table
  would call a dirty site clean.

**Scope**: what makes an install land on old state — options (read to decide it was installed
before), tables (its installer creates them again), roles and capabilities (activation keeps them).
User meta is left: notices re-create it, no install reads it, the next uninstall removes it.

## File ownership ([`wp/ownership.ts`](../../src/common/wp/ownership.ts))

**WP-CLI unpacks a plugin as the transport's user, so the web server cannot write inside it.** On a
real cell `wp` runs as e.g. `ubuntu` (umask `0002`) and the install arrives `ubuntu:ubuntu`, `775`
dirs and `664` files; the web server (`www-data`, say) is denied its next write: a plugin's own working
directory, an update, a wp-admin delete. It is **not** the "WordPress wants FTP credentials" symptom:
`get_filesystem_method()` (WP 7.1 core, read on the cell) compares a _core_ file's owner with a temp
file's, both `www-data`, so it picks `direct` and then fails with a plain permission error.

**The owner is detected, never assumed**: `stat -c '%U:%G:%u:%g'` on `wp-content` (else the WP root).
It is not always the web server — a docroot deployed over SFTP belongs to the deployment account, the
web server only sharing the group. Measured:

| Cell   | Web/PHP process user | Docroot owner                |
| ------ | -------------------- | ---------------------------- |
| nginx  | `www-data`           | `www-data:www-data`          |
| apache | `www-data`           | **`sftp_backwpup:www-data`** |

Probing the web-server process would say `www-data` on both — wrong on the second. Override per site
with `transport.fileOwner` ([configuration.md](../guides/configuration.md#transport-modes-transport)).

### What it does, and in what order

`normalizeOwnership(transport, sitePath)` (path relative to the WP root):

1. Decides via `planOwnership` — the same function pre-flight uses to _report_, so the two never
   disagree.
2. **Does nothing** when the transport's user already owns the install with the same uid _and_ gid —
   the `docker` case (wp-cli containers run as `33:33`, like the `wordpress` ones) — before any
   privilege probe.
3. Otherwise grants the mode **first**, then chowns (`local`/`ssh` shown; `docker` uses
   `docker exec -u 0:0`):

   ```
   sudo -n -- chmod -R -- <mode> <abs>
   sudo -n -- chown -Rh -- <user>:<group> <abs>
   ```

   Chowning first would leave the tree owned by the site's user with no grant yet — locking the
   transport user out of `wp plugin uninstall`. Granting first means a failed chown leaves the tree as
   it was.
4. **Verifies** by re-reading ownership, never from `chown`'s exit code.

The grant keeps both users working:

| The transport user is…                   | Grant                                           |
| ---------------------------------------- | ----------------------------------------------- |
| the target owner, or in the target group | `ug+rwX`                                        |
| neither                                  | `ug+rwX,o+rwX` — world-writable, and it says so |

`ug+rwX` always, because after the chown owner and group are the docroot's pair, and where those are
two accounts the **group is the web server's only access**. `o+rwX` only when the transport user is
outside both, so it can still remove what it installed, with a one-time notice naming the fix (add the
transport user to the site's group). Modes are additive (`+`, never `=`), so a host is never
tightened, and use `X` so directories become traversable without making PHP files executable.

### Symlinks

The guards in [`wp/paths.ts`](../../src/common/wp/paths.ts) are **lexical**. Whether a link is followed differs per command — measured on GNU coreutils 9.4 (Ubuntu, kernel 6.8) and BusyBox 1.37:

|             | A link as the **operand**                                  | A link found during **recursion** |
| ----------- | ---------------------------------------------------------- | --------------------------------- |
| `chmod -R`  | **followed** — and it recurses into the referent's tree    | not followed                      |
| `chown -Rh` | not followed — `-h` acts on the link                       | not followed                      |
| `rm -rf`    | not followed — removes the link                            | not followed                      |

Recursion is safe in all three (GNU's `-P` is the default under `-R`; `-h` covers `chown`'s operand).
But a link in any **parent** is resolved by the kernel first: with `wp-content/uploads` linked out,
`rm -rf <root>/wp-content/uploads/backwpup` deleted `/out/backwpup` and `mkdir -p` created
`/out/newdir` (measured), while every lexical guard agreed.

So `assertResolvedInsideRoot` ([`wp/exec.ts`](../../src/common/wp/exec.ts)) asks **where the path really leads**: it resolves target and root with
`readlink -f` and requires the first inside the second. A path not yet there cannot be a link, so it
walks up to the deepest existing ancestor (not relying on `readlink -f` tolerating one missing
component, which GNU and BusyBox do and others do not). An unresolvable path is **refused**: unknown reads as no. It runs
before every privileged path: ownership normalisation (warns, returns `failed`), data-directory
preparation and residue removal (both throw). Removal is guarded before **both** passes: the unprivileged pass still runs as root when the transport's user is root (a container, a root SSH login), and deleting elsewhere is wrong at any privilege. Verified on a live container: with a linked ancestor, preparation and removal both
refused and the outside directory kept its contents and `0700` mode.

It is check-then-act: the path could be swapped in between, and `chmod` has no "do not follow" flag, so the window cannot be closed here.
Winning that race needs write access to the docroot (on these cells, the plugin under test); before
the check there was no race, only an open door. Because of the resolution check, a data directory relocated outside the
root is refused, not followed: point `rootDir` at the real location, or declare a path within it.

`--` ends option parsing in both commands, because `chown` permutes options anywhere: without it a
`fileOwner` of `--reference=/etc/hostname` reaches root as a flag and takes ownership from that file (measured; with `--` it is an
"invalid user" error).

### It never fails a run

Ownership is housekeeping, so `normalizeOwnership` **never throws**: it returns `normalized` /
`unnecessary` / `skipped` / `disabled` / `failed` and warns once per site _per reason_. Without
passwordless `sudo` it cannot run at all (`chown` needs root); pre-flight and the run-level warning
report that, as no fault. The elevation probe, like the ownership probes, remembers a `sudo` that **ran and refused**, never a
transport that could not be asked (one dropped connection must not disable escalation for the rest of
the worker). Detection, identity and notices are cached **per install**, not per host: one machine
serves sites that disagree (apache cell: `sftp_backwpup:www-data` and `sftp_wprocket:www-data` under
one `ubuntu@host`).

> **MUST — code that writes into a site's docroot as the transport's user calls
> `normalizeOwnership` on what it wrote.** Never `chown`/`chmod` directly, never elevate `wp` (root's
> files would be unwritable by the web server). `stageAndInstallPlugin` does it given the `slug` —
> pass it. Deliberately left alone: the staging area (only the transport user reads it), and a mode a
> scenario sets to test a refusal (`makeLogReadOnly` takes the write bits off a plugin log the scenario's run
> wrote; handing it back would undo that; it runs unelevated and goes with the plugin's residue).

**Linux only.** `stat -c` and `id` are read in GNU form; BusyBox (`wordpress:cli`) differs on unmapped
ids (`stat -c %U` prints `UNKNOWN`, `id` bare ids) and is handled. Each read is confined to one
function, so a BSD branch would stay local.

## Path guards ([`wp/paths.ts`](../../src/common/wp/paths.ts))

The guards between a typo and a privileged `rm -rf` / `chown -R` on a system path, in one module
because a copied guard drifts.

- `normaliseSitePath(declared, describeRejection)` — the **relative** half: inside the WP root, never a
  directory WordPress owns (`PROTECTED_SITE_PATHS`).
- `assertSafeElevatedTarget(target, root, describeRejection)` — the other half: the root is plausible
  (absolute, ≥ 2 segments; `/` and `/tmp` are not) and the join stayed inside it. Run by residue removal, data-directory preparation and ownership normalisation, the operations composing a privileged target from `rootDir`; the other elevated callers compose none
  (staging has its own guard, `debug.log` is a fixed path), and unprivileged callers have the user's
  own permissions as backstop.
- `pluginSitePath(slug)` — `wp-content/plugins/<slug>`, slug a **single segment** (`posix.join` would
  resolve `..` into a WordPress directory). Throws its own fixed message.
- `isPathSegment(name)` — the one-segment rule (not empty, `.` or `..`; no `/` or `\`), shared by
  `pluginSitePath`, staging categories and filenames, and products' joined names.
- `pathInsideRoot(path, root)` — a site-reported absolute path (`WP_CONTENT_DIR`, uploads) as the
  root-relative form, or `undefined` unless strictly inside; both halves normalised so `..` cannot
  escape.

The two guards take the caller's message builder, so a failure reads in the caller's terms with its
remedy. They guard against our own mistakes, not hostile input — expensive ones where the suite can
`sudo`. Both are lexical: see [Symlinks](#symlinks).

## Options ([`wp/options.ts`](../../src/common/wp/options.ts))

Reads what a plugin persisted, rather than the screen that rendered it.

- `getOption(transport, name)` → the raw value, `undefined` when unset (`""` stays `""`).
- `getOptionJson<T>(transport, name)` → the `--format=json` value. **A PHP array is not always a JSON
  array**: WP-CLI emits an object once keys are not a 0-based sequence (deleting from a list's middle),
  so list callers accept both.

`wp option get` exits non-zero for a missing option **and** for a WordPress that cannot boot; only
WP-CLI's "Does it exist?" wording reads as `undefined`, anything else throws (a broken site read as
"no such option" is the false negative these readers exist to prevent). Single-site only (network
options: `wp site option`).

## Database ([`wp/db.ts`](../../src/common/wp/db.ts))

`dbQuery(transport, sql)` runs `wp db query`, returns stdout, throws on non-zero exit.
`tablePrefix(transport)` returns `wp db prefix` (`$wpdb->prefix`, with multisite's per-blog segment) —
never hard-code `wp_`, which would assert the wrong tables on a site not using it.

## WP-Cron ([`wp/cron.ts`](../../src/common/wp/cron.ts))

For a scheduled feature's two questions: **is the event registered**, and **what happens when it
fires**.

- `nextScheduled(transport, hook, args?)` → the next run's Unix timestamp, or `undefined`. Asks
  `wp_next_scheduled` (`wp cron event list` prints a formatted date and cannot tell two events on one
  hook apart). WordPress keys an event by hook **and** args, so a per-job event (BackWPup) needs both.
- `triggerScheduledEvent(transport, hook, args?)` → moves **that one event** into the past and hands it
  to WordPress's `spawn_cron()`. Throws if it is not scheduled, so nothing the product never registered can be "triggered". A recurring event stays recurring (its
  schedule is read back and re-applied). Anything else already due runs alongside, as on a real tick.
  Returns once WordPress accepted the work (core's cron request is non-blocking): wait on the product's
  own evidence that it finished.

**Why not `wp cron event run <hook>`** (both measured live):

1. **Not selective**: WP-CLI 2.12's help says it "runs the next scheduled cron event for the given
   hook", yet with three events on one hook it ran **all three**, one hours ahead included. `--due-now` restricts it to due events — why the trigger makes only the
   target due.
2. **It runs inside the WP-CLI process**, configured nothing like the web server. With CLI
   `memory_limit = -1`, BackWPup's "grow the limit" step computes a finite limit from current usage (`(int) '-1'` is `-1`, so any requirement looks larger) and the job dies against it — a fatal in a run that always succeeds through the web server.

`spawn_cron()` posts to `wp-cron.php`, so the event runs in the web context, whether the host disables
WordPress's cron for a system crontab or not (neither gates `spawn_cron()`). `ALTERNATE_WP_CRON`
cannot be served (its branch reads `$_SERVER['REQUEST_METHOD']`, always declining under WP-CLI): such a
site fails loudly.

`spawn_cron()` declines while another run holds the `doing_cron` lock, so the trigger retries. The lock
is **never deleted**:

- Core declines only while the lock is younger than `WP_CRON_LOCK_TIMEOUT`
  (`if ( $lock + WP_CRON_LOCK_TIMEOUT > $gmt_time ) return false;`), so deleting a stale one changes
  nothing.
- Deleting one a slow run still holds truncates it: `wp-cron.php` re-reads the lock between events and
  stops once it changed, and a lock is never refreshed, so any backup outlasting the timeout has a lock
  that merely _looks_ abandoned.
- So the trigger outlasts the lock, its budget read from the site
  (`min( 300, max( 70, WP_CRON_LOCK_TIMEOUT + 10 ) )`, since a site may raise the constant; capped against extreme values); the
  timeout is named in the failure.

The event is unscheduled before re-scheduling as due: `wp_schedule_single_event`'s duplicate guard
counts all past identical events as duplicates when the new timestamp is within ten minutes. If re-scheduling fails, the original is **put
back**, so the site never loses the schedule.

## Talking PHP to a site ([`php.ts`](../../src/common/wp/php.ts))

Every module asking WordPress what no WP-CLI command answers goes through here.

- `phpLiteral(value)` embeds a value as `json_decode( base64_decode( '…' ), true )`. The snippet gets
  only `A-Za-z0-9+/=`, which holds no PHP metacharacter, so quotes, backslashes, newlines and `$` cannot
  end the literal or interpolate — safe for values **read off a site**. A value with no JSON form
  (`undefined`, a function, a symbol) throws here, naming the mistake.
- `evalPhp(transport, php, what, scope, options)` runs the snippet and turns a non-zero exit into a
  throw carrying what PHP or WP-CLI said (a snippet's own `WP_CLI::error()` included).
- `options.skipPlugins` boots **without plugins** (`--skip-plugins`) for an answer that must not depend
  on other plugins (a cleanup, a plugin that should be gone); core, `$wpdb` and the option API behave
  normally. Off by default (a running site's question needs the site as it runs). The flag leads the
  argv: WP-CLI reads globals before dispatching, and one after the snippet becomes an `eval` argument.

**Any value from outside this codebase — site data, scenario input, a fixture — goes through
`phpLiteral`.** No exceptions: it is SQL injection's twin, avoidable in one line. A compile-time
constant of ours in snippet _source_ (a budget, a destination slug) is not such a value; those few
sites say so inline.

**Every `wp eval` runs through `evalPhp`.** A caller interpreting the reply validates the _returned
string_ afterwards (`isJobRunning` insists on `"0"` or `"1"`). Guards that must survive a plugin that
will not load belong in the **PHP**, not in exit-code branching: `isJobRunning`'s snippet asks
`class_exists( 'BackWPup' )` first and answers "nothing is running".

## File properties ([`files.ts`](../../src/common/wp/files.ts))

All computed on the site, so nothing large moves.

- `fileChecksum(transport, path)` → SHA-256, lower-case hex: the honest proof a file arrived intact
  (size misses in-place corruption or a padded truncation). A reply that is not a digest (a notice
  first, empty, upper-case) throws rather than failing later as "the download differs".
- `listFiles(transport, dir, { digests?, missingAsEmpty? })` → the regular files directly inside: name,
  size, mtime, whether the **transport's** user may write it (`is_writable()` inside WP-CLI, what a
  plugin command checks before deleting), and SHA-256 on request; links and subdirectories left out. A
  missing directory **throws** — "no files" would pass a "was removed" assertion on a wrong path; only
  a directory a scenario may never have made passes `missingAsEmpty`.
- `listLocatedFiles(transport, locate, what, options)` → the same for a directory only the site can
  name (`locate` is PHP setting `$dir`, e.g. from a plugin's settings), in one request, returning where
  it was found too. Every listing goes through these two; they run `FILE_LIST_PHP`, read by
  `parseFileList`.
- `backdateFile(transport, path, seconds)` → sets a file's mtime back by the **site's** clock (the one
  an age rule uses), verified by reading back; only on a file the transport's user owns.
- `locateFromWorkingDir(transport, locate, what)` → the path from WP-CLI's working directory (the WP
  root) to a target (`locate` is PHP setting `$path`); `pathFromWorkingDir(located, what)` derives it
  from the site's `realpath()` of the target and `getcwd()`. Both ends are symlink-resolved, so each
  step is a real directory (from configured paths, climbing out of a root reached through a link would
  climb out of the link's target). An unresolvable target throws.

## Looking inside an archive ([`archive.ts`](../../src/common/wp/archive.ts))

A file of the right size proves nothing about its contents, and a real files backup runs to
**gigabytes**, so the archive is asked in place through `tar`:

- `findArchiveEntries(transport, archive, pattern)` — members matching a name or glob; empty when none;
  **throws** when the archive cannot be read.
- `readArchiveEntry(transport, archive, member)` — one member's contents on stdout, nothing extracted.

Decisions:

- **The member is named to `tar`**, not listed and filtered here: that keeps the _output_ small, not
  the work — without `--occurrence` tar scans to the end, and on a compressed archive decompresses all of it. Measured on a
  200 MB `.tar.gz`: full list 1.373 s, pattern list 1.386 s, miss 1.385 s, first-member extract
  1.393 s; 0.160 s with `--occurrence=1`. An uncompressed `.tar` is seekable and cheap. `--occurrence`
  is **not** used: a name can match two members (a docroot file sharing the dump's name), both wanted.
- **Compression is not declared**: GNU tar detects it, so one path serves `.tar` and `.tar.gz`. `.zip`
  (also a BackWPup `archiveformat`) is out of scope: tar refuses it — an error, not a wrong answer.
- **"Absent" and "unreadable" look alike**: both exit 2, and a _truncated_ archive prints only
  `<pattern>: Not found in archive` (measured). So when a pattern matches nothing, the archive is listed
  with no pattern and only the exit status is believed — else a corrupt backup would pass every
  absence assertion.

## Type guards ([`guards.ts`](../../src/common/guards.ts))

Domain-free guards: `isObject` (non-null, non-array object) and `isNonEmptyString`. Module-specific
validation builds on them locally.
