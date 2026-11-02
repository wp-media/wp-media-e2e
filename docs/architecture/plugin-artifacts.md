# Plugin artifacts — the zips under test

Every run resolves **and verifies** the plugin zips it tests before any scenario runs
(`src/common/artifacts/`). The operator's env-var table is in
[configuration.md](../guides/configuration.md#plugin-artifacts-build--verify).

The problem: a run unit `(product × cell)` needs one or two zips, chosen per execution — `develop` by
default, any branch/PR/tag on demand, or a hand-built zip — with no one copying files into place and no
run silently testing the wrong plugin or edition.

## Roles

Each product declares up to two **roles**, a word used verbatim by the env vars, the directories and
the fixture:

| Role       | Meaning                                                     | Declared by                               |
| ---------- | ----------------------------------------------------------- | ----------------------------------------- |
| `plugin`   | The artifact under test. Every product has it.              | `artifacts.defaultRef.plugin` (mandatory) |
| `previous` | An older artifact some tests compare against (update path). | `artifacts.defaultRef.previous` (opt-in)  |

Declaring `defaultRef.previous` is the **single** signal a product supports the role: resolution, the
preflight and the fixture are manifest-driven, so it enables the second artifact everywhere. WP Rocket
has it; BackWPup deliberately not yet ([Deferred obligations](#deferred-obligations)).

## Module map (`src/common/artifacts/`)

| Module               | Responsibility                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `types.ts`           | The domain's types (roles, manifest, requests, resolution). Types only.                            |
| `manifest.ts`        | Pure accessors over a manifest (roles, default ref, edition → variant).                            |
| `request.ts`         | Reads the six `E2E_*` vars; **pure** `buildArtifactPlan` → one request per role.                   |
| `apvm.ts`            | Lazy `Apvm` singleton, token diagnostics, progress → console, masked (`redactSecrets`, `text.ts`). |
| `resolve.ts`         | Wipe → build/copy per role → hash → `resolution.json`.                                             |
| `digest.ts`          | A zip's SHA-256 (`sha256File`, streamed) and its format check (`isSha256`).                        |
| `pin.ts`             | **Pure**: the full commit (`fullCommit`) and the pin that rebuilds a build (`pinOf`, `requirePin`). |
| `verify.ts`          | Static identity preflight (`adm-zip`) + aggregated report formatting.                              |
| `consume.ts`         | Reads a role back for a test (memo → `resolution.json`), with the role guards.                     |
| `registry.ts`        | Per-process manifest + resolution registries (the `metadata.ts` idiom).                            |
| `warm.ts`            | Pre-warm: dedupe requests, prime APVM's cache serially, return each pinned build.                  |
| `artifacts.setup.ts` | The `artifacts:<cell>` setup project — thin orchestration of the above.                            |

## The product manifest

`ProductConfig.artifacts` ([`ProductArtifacts`](../../src/common/artifacts/types.ts)) is **required**,
so no product ships without a build source. Authored in
`src/projects/<product>/config/<product>.config.ts`: the APVM `project` id, per-role default refs, the
version policy, and the edition policy (holding the identity expectations).

| Product     | `plugin` default | `previous` default  | Version policy                                   | Edition → APVM variant            |
| ----------- | ---------------- | ------------------- | ------------------------------------------------ | --------------------------------- |
| `wp-rocket` | `develop`        | `tag:latest-stable` | `embedded` — no default; an override rewrites it | — (editionless)                   |
| `backwpup`  | `develop`        | _none yet_          | `required` — `plugin` → `9.99.99`                | `free` → `free`, `pro` → `pro-en` |
| `imagify`   | _(not wired)_    | _(not wired)_       | _(verify from its build definition)_             | — (expected)                      |

- **`embedded`** — the version lives in source; nothing goes to APVM unless an operator pins one, which
  APVM then writes into the source (reported as `versionOverride`).
- **`required`** — APVM cannot build without one (BackWPup), so every supported role has a default,
  **staggered** one patch apart (`plugin` newer, e.g. `9.99.99` / `9.99.98`) so an update-path test
  sees `previous` as older with no manual pinning.
- A `release:*` ref never gets a version under either policy: the tag supplies it.

### Edition vs. variant (two namespaces, on purpose)

Our **edition** (`free` / `pro`) is the binary, language-blind behavioural tier driving scenario
filtering and page objects. APVM's **variant** (`free` / `pro-de` / `pro-en`) names an exact package.
The manifest maps each edition to the **one** variant it builds — a projection, not an identity:
`pro` → `pro-en` (`pro-de` differs only in licensing endpoints, so `pro-en` stands in for it); `free` →
`free` merely coincides. One variant, because each role resolves to one zip; the request builder wraps
it into APVM's `variants` array.

## Requests: `(manifest, edition, env)` → what to fetch

[`buildArtifactPlan`](../../src/common/artifacts/request.ts) is **pure** (no `process.env`, no
filesystem) and returns one request per supported role plus warnings. A request is either:

- `{ kind: "build", params: { project, gitRef, version?, variants? } }` — APVM builds it;
- `{ kind: "zip", rawPath }` — an operator's zip is copied in.

It is the **only** planner, used by the resolver _and_ the pre-warmer, which makes their APVM params
identical (the [parity invariant](#pre-warming)) and lets the precedence matrix be unit-tested with
plain inputs.

Precedence per role: `E2E_<ROLE>_ZIP` > `E2E_<ROLE>_REF` > the manifest default; ref and zip are
**mutually exclusive**.

| Situation                                                  | Behaviour                         |
| ---------------------------------------------------------- | --------------------------------- |
| A role's `_REF` and `_ZIP` both set, on a targeted cell run | **Throws** (naming both vars)     |
| Any override on a serial (cell-less) run                   | Warn + use defaults               |
| `_VERSION` beside that role's `_ZIP`, or a `release:*` ref | Warn + ignore                     |
| `E2E_PREVIOUS_*` on a product with no `previous` role      | Warn + ignore                     |
| `plugin` and `previous` resolving to the identical request | Warn (degenerate comparison)      |
| An edition-ful product whose cell declares no edition      | Throws (a config/programming bug) |

Only a misconfiguration that would silently do the wrong thing throws. The rest warns: several
products' cells can share one shell or CI environment, and a leftover variable must never abort a broad
run.

### Why overrides need an explicitly named cell

An override describes _one_ run unit; a serial sweep has none, so overrides are dropped (with a warning
naming them) and defaults used. The predicate is
[`isCellTargeted(cell, projectName)`](../../src/common/config/run-context.ts): true for a run pinned to
the cell (`E2E_CELL=<cell>`), `--project=<cell>`, and `--project=artifacts:<cell>` (resolving a cell's
zips without its scenarios). The setup runs in a **worker**, forked without the CLI argv, so the answer
rides the environment ([execution-model.md](execution-model.md#reading-the-selection-from-a-worker)).
The cell name is compared **exactly**, so an unpinned `--project='pro*'` runs the cell but reads here
as broad and warns, rather than applying one operator's override to cells never named. A pinned run
holds one cell whatever `--project` adds, so it is always targeted.

## Resolution: wipe → resolve → verify → publish

```text
.artifacts/<product>/<cell>/         ← gitignored, EPHEMERAL: wiped whole at each resolution
├── plugin/<one>.zip                 ← role subdirs ⇒ no filename collisions,
├── previous/<one>.zip                  and a role is derivable from the path alone
└── resolution.json                  ← this execution's role → artifact map
```

- **Every execution wipes and re-resolves**: refs are rebuilt (a cache hit is a ~15 MB copy), provided
  zips copied in (uniform layout, immune to the source moving mid-run). We make no cross-execution reuse
  decision: **APVM's cache is the only reuse layer**, and each artifact reports which applied
  (`origin: built | cache | downloaded | copied`). Since the wipe runs first, an `E2E_*_ZIP` pointing
  **inside** the cell's own directory is rejected _before_ anything is deleted (else the operator's file
  would be destroyed, then reported missing).
- **Every resolved zip is normalised to `0644`.** A build lands `0600`, and getting it onto a site
  copies it verbatim: `docker cp` preserves host mode _and_ numeric owner (meaningless in a container),
  so WP-CLI there cannot open it and `wp plugin install` fails with an opaque
  `PCLZIP_ERR_READ_OPEN_FAIL` — as on a `local` site whose `wp` runs as another user. Normalising once at
  resolution fixes every transport at no per-scenario cost.
- **Every resolved zip is hashed** (SHA-256, after the `chmod`), built and provided alike (the one funnel both share). The digest
  names the artifact; a commit only names its source, and two builds of one commit differ (a build
  regenerates `languages/*.pot` and stamps every entry's mtime). The role dir's copy is hashed — the
  bytes this run installs, as long as nothing re-resolves the cell meanwhile (the digest is taken once, not re-checked per install).
- **A build records its full commit** (40 hex, never APVM's `commitShort`) and its `pinRef`, the ref
  that rebuilds exactly it ([Pinning](#pre-warming)). A release download has no commit (APVM reports
  `release-<tag>` there); its `pinRef` (`release:5.7.7`) is the only record of the tag a
  `release:latest-stable` chose. The summary line shows `pin=` only for a release (a commit pin repeats
  the commit).
- The root is `ARTIFACTS_ROOT` (repository-relative or absolute), resolved by `cellArtifactsDir`
  (`consume.ts`) for setup and readers alike; `<product>/<cell>` is always appended, so two cells never share a directory. Two runs resolving
  one cell (a run of the cell, or `--project=artifacts:<cell>` alone) share it, and the second wipes
  the first's zips: one such run per cell at a time.
- Roles resolve **sequentially** (readable logs, no assumptions about concurrent APVM workspaces). A
  per-role failure is a **value**, never thrown: `previous` is still resolved and verified when
  `plugin` fails, so one report names every problem.

APVM (`apvm-napi`, pinned to a `cli/vX.Y.Z` tag in `package.json`) ships prebuilt native binaries (no
Rust toolchain, no build step) and is driven **only** through this Node library, never the `apvm` CLI:
a CLI-only capability waits for a library release. BackWPup builds from a **private** repo, so it needs
a GitHub token (`GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth login`), asserted **before** any clone; every
string APVM emits is scrubbed of tokens and URL userinfo before reaching a console or report
(`redactBuildText`: invisible format characters dropped first, so none hides a token); a printed
progress line is one `plain` line, and warm's printed errors go through `printableLines`.

## Identity preflight

**Static zip inspection**, not an install probe: no WordPress needed (so it runs before transports are
checked), milliseconds, cannot touch a site, identical for built and provided zips. The suite's first
install proves installability minutes later anyway, with better context.

Per artifact, via `adm-zip` (read-only: central directory plus one entry):

1. The zip parses and has a **single top-level directory**, ignoring a macOS `__MACOSX/` sidecar
   (WordPress's unzipper skips it, so a Finder-made archive installs and must verify).
2. That directory equals the expected **slug** — one check pinning product _and_ edition.
3. `<mainFile>` exists there and its `Plugin Name:` header **equals** the expectation (never a prefix:
   `BackWPup` cannot pass for `BackWPup Pro`), cleaned exactly as core's `_cleanup_header_comment()`
   does, so equality never fails on a value WordPress reads correctly. It is read from the archive's **actual** top-level directory, so a wrong-edition zip still
   reports its header: two independent witnesses.
4. Reported, not asserted: header `Version:`, zip filename, source, full commit, SHA-256, origin. The
   header's `Version:` **becomes the artifact's `version`** — what WordPress installs and reports, and
   for a provided zip the only version there is (none is recorded on copy; a `_VERSION` is ignored
   beside it). The build's own report is the fallback for a header declaring none.

| Product / edition | Top-level dir (slug) | Main file       | `Plugin Name:` |
| ----------------- | -------------------- | --------------- | -------------- |
| WP Rocket         | `wp-rocket/`         | `wp-rocket.php` | `WP Rocket`    |
| BackWPup Free     | `backwpup/`          | `backwpup.php`  | `BackWPup`     |
| BackWPup Pro      | `backwpup-pro/`      | `backwpup.php`  | `BackWPup Pro` |

Ground truth: APVM's builders (`crates/core/src/build/plugins/`) and `wp-media/backwpup-pro`'s
`gulpfile.ts`, whose `compressPackage` zips `dist/<packageName>` (so the top-level directory _is_ the
slug) and whose `free` task rewrites the header.

**Aggregation is the user-visible contract.** Every role is resolved and verified even after an
earlier failure; errors and mismatches are collected into one report (the `CheckResult` lines of
[`preflight.ts`](../../src/common/setup/preflight.ts), `setup/check-lines.ts`; plain text, since it is
thrown): each artifact with ✓/✗ per check,
expected vs found, and a hint (e.g. a wrong-edition zip on a `pro` cell). One `Error` at the end fails
the setup, skipping the BDD project. On success the same data prints one line per role and is attached
to the test as JSON, so it lands in the HTML/Allure report.

## Run wiring

The config factory emits `artifacts:<cell>` as a third per-cell project, a sibling of the auth setup:

```text
artifacts:<cell> ─┐
setup:<cell>     ─┴─→ <cell>  (BDD; dependencies: [both])
```

The two setups are independent: either **failing** skips the scenarios; a placeholder-only cell
**skips** both without blocking (a fresh checkout's `npm run test` clones nothing, builds nothing, needs no
token).
The artifacts setup has a generous timeout: a cold build runs composer/npm.

## Consumption

A scenario never resolves; it reads the result through the `pluginArtifact` fixture:

```ts
const a = pluginArtifact("plugin");
await stageAndInstallPlugin(site.transport, a.zipPath, { activate: true, slug: a.slug });
```

It returns the role's [`ResolvedArtifact`](../../src/common/artifacts/types.ts)
(`{ slug, zipPath, zipFilename, source, ref?, commit?, pinRef?, version?, sha256?, origin, resolvedAt }`).
The resolver always sets `sha256`; the parser rejects a malformed one and tolerates its absence (a
`resolution.json` predating it stays readable for a `--no-deps` run).

**`slug`** is the plugin directory the artifact installs as (`backwpup` vs `backwpup-pro`), so a test
or hook addresses the plugin without branching on edition
(`ensurePluginAbsent(site.transport, pluginArtifact("plugin").slug)`). It is the cell's expected slug,
stamped at resolution; the preflight proves the archive matches it and `resolution.json` is written
**only** after every role passed, so a slug read back is always verified. `parseResolution` requires
it, rejecting a resolution predating the field.

> **`zipPath` is a path on the runner.** Only a `local` transport's `wp` reads it directly (plain
> `installPlugin`); `stageAndInstallPlugin` copies it into the site's staging area (any transport) and, given the
> `slug`, restores the plugin's ownership so the web server can write it
> ([wordpress-automation.md](wordpress-automation.md#site-staging--file-transfer-wpstagingts)).

Workers are separate processes that never resolve, so the channel is `resolution.json`, read lazily and memoized per process, with
four guards:

- A role the product does not declare **throws before any file read**: a comparison test can never
  consume an unresolved, unverified role.
- A missing `resolution.json` throws with the fix (the setup did not run for this cell: use
  `E2E_CELL=<cell>`, not `--no-deps`).
- A resolution from a **different** `runId` warns once per cell — non-fatal to keep the fast
  `--no-deps` loop, never silent since the zips may be older than expected.
- A resolved zip since deleted throws naming the path, rather than an opaque `wp plugin install`
  failure.

## Pre-warming

N cells wanting one uncached build must not build it N times, and build minutes should not count as
test time. `warmCache()` runs `build()`'s pipeline but delivers nothing, so the later per-cell `build()`
is a cache copy.

```bash
npm run artifacts:warm                                          # every real cell
npm run artifacts:warm -- --product=backwpup --cell=pro@nginx   # one unit
```

[`warmArtifacts`](../../src/common/artifacts/warm.ts) plans every unit through `buildArtifactPlan` with
`serial: false` (a one-cell run's mode, so overrides apply identically), **skips** provided-zip roles,
**dedupes** by `{project, gitRef, version, variants}`, then warms each distinct request serially.
Failures are collected per request, never thrown (one bad ref does not abort the batch); an unknown
`--product`/`--cell` exits `1` rather than report a cache never primed.

**The parity invariant**: warm and run must compute the _same_ APVM params or the warm is never hit —
hence one planner. A keyword ref (`tag:latest-stable`) is re-resolved at warm and at run, so a release
cut in between makes the run build fresh: correct, just slower.

**Pinning.** A moving ref (`develop`, `release:latest-stable`) can change between a warm and its run.
So each successful warm returns a `WarmedBuild` (`WarmResult.build`: whether cached, the full commit,
the version, the cached zips, the resolved ref) and its `pin` ([`pin.ts`](../../src/common/artifacts/pin.ts)),
which an orchestrator hands the run as `E2E_<ROLE>_REF=<pin.ref>` and, when set,
`E2E_<ROLE>_VERSION=<pin.version>`:

| Build                         | `pin.ref`       | `pin.version`     | The pinned run, measured with all network denied                                       |
| ----------------------------- | --------------- | ----------------- | -------------------------------------------------------------------------------------- |
| Git (branch, PR, tag, commit) | `commit:<sha>`  | the version built | served from the cache; APVM's commit check against GitHub fails and is tolerated       |
| Release download              | `release:<tag>` | — (its tag's)     | **needs network**: APVM fetches the release from GitHub's API, then copies the cached asset |

- A release is checked first: pinning it to a commit would build the source, not the released zip.
- The version is the one **built**, never the one requested: APVM's cache is keyed by commit and
  version, and an embedded-version product (WP Rocket) given none fetches its version file from GitHub
  before the cache, and clones when it cannot. Given its built version (which matches its source) nothing is rewritten — unless
  the warm itself overrode it (`E2E_PLUGIN_VERSION`), when a cold rebuild from the pin rewrites it to
  the same value.
- A build that cannot be pinned (no full SHA, or a release still named by a selector, which APVM
  matches ignoring case) is a **failed** warm, as is one whose zips are not in the cache (APVM stores
  best-effort; an unwritable cache leaves only gone temporary paths). So no run is left on a moving
  ref. `artifacts:warm` prints each pin.

## Deferred obligations

- **BackWPup `previous` role (MUST, when its comparison tests arrive).** Add
  `previous: "release:latest-stable"` **and** a `previous` default version to
  [`backwpup.config.ts`](../../src/projects/backwpup/config/backwpup.config.ts) (the release derives its
  version from the tag, but `E2E_PREVIOUS_REF` could point at a build ref). Releases carry
  `free`/`pro-en`/`pro-de` assets and the variant filter applies to downloads, so `pro-en` is
  selectable. Declaring the role enables the second artifact's verification, which **must not** be
  skipped; the only exemption is a test that builds inside its own scenario and owns its verification.
  Mirrored as a comment on that manifest; until then the fixture hard-errors.
- **Imagify** — add a manifest (verifying its identity row from its build definition) when wired
  ([Adding a product](../guides/authoring-tests.md#adding-a-product)); the rest is data-driven.
- **Version-aware tests** — `resolution.json` already exposes each role's verified version (the zip's
  header) and commit, for migration or version-gated-notice assertions; BackWPup's CLI feature asserts
  `wp backwpup version` against it.
- **Deeper zip validation** (full CRC pass / trial install) — only if a real failure class appears;
  it slots behind the same report.
- **Shared-ref multi-variant builds** — a Free and a Pro cell resolving the same ref _and_ version
  could build both variants in one APVM call; see the [orchestrator plan](../plans/orchestrator-plan.md).

## References

- [configuration.md](../guides/configuration.md#plugin-artifacts-build--verify) — the six `E2E_*` vars.
- [execution-model.md](execution-model.md) — per-cell projects, artifact directories, cell selection.
- [wordpress-automation.md](wordpress-automation.md#site-staging--file-transfer-wpstagingts) — getting a zip onto an `ssh`/`docker` site.
- [authoring-tests.md](../guides/authoring-tests.md#fixtures-srccommonfixturests) — the `pluginArtifact` fixture.
- APVM: [repo](https://github.com/wp-media/automation-plugin-version-manager); its `index.d.ts` is the authoritative API.
