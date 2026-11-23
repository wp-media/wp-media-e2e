# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [1.1.0]

### Added

- **WP Rocket:** first `@plugin` scenario: page cache from activation to removal. Full lifecycle:
  offline dummy licence, a settling request after install, its background work waited out, forced
  deactivation, and the files it edits in place (`wp-config.php`, `.htaccess`) put back, as root when
  needed.
- **Site identity:** every SSH site command runs as the web server's user via `sudo`
  (`transport.runAs`, default `"auto"`; `transport.umask`); `wp` runs as the site's admin (`--user`).
  The pre-flight and healthcheck verify this identity and the login shell.
- **SSH twins** of the cells (Ubuntu 24.04, Apache/Nginx) for local and CI runs: `env:cells:*`.
- **Terminal output:** the suite's own reporter: a live progress block, a failure block with a
  `Rerun` command, a summary with failures listed; `E2E_OUTPUT=auto|plain|fancy`.
- **Reports:** per-run Allure report (`report:allure`) and download bundle (`report.tar.gz`); the
  orchestrator builds them after each run and puts the fetch command in Slack.
- **Orchestrator:** live status table on a terminal.
- **Suite version** (`package.json`) shown in the `[run]` header, `run-facts.json`, the orchestrator's
  start line and `--dry-run`, and Slack.

### Changed

- **Orchestrator:** Slack's `Report:` command names the bundle once, in a shell variable
  (`R=<name> && scp …`), and ends in the unpacked folder (`cd "./$R"`): paste the next one from the
  parent folder. POSIX shells only (`sh`, `bash`, `zsh`); fish and csh/tcsh stop at `R=` having done
  nothing.
- No file ownership handover when commands already run as the site's user.
- CI: unit tests in two shards; SSH twins in CI.
- **Requires Node ≥ 26.13.1 and npm ≥ 12.2.3** (`engines`, `devEngines`: npm 11 fails every npm
  command in the checkout). Node 26 ships npm 11 (Homebrew's too): put npm 12 first on `PATH`.
- Dependencies at their latest stable; `npm audit` 18 → 0:
  - Playwright 1.65.1 (Chromium 159); `@mobile` reports the Pixel 5 screen (393×851).
  - Allure 3.33: history from 3.18 reports continues; its server listens on `127.0.0.1` only
    (remote: `ssh -L`).
  - APVM 3.3.0: fresh WP Rocket zips keep nested vendor `php*`/`package*` files (new SHA-256).
  - node-ssh 14: a dropped SSH connection is reported as lost while the program ran, or closed
    before it was confirmed started (whether it ran unknown); never the command's arguments.
  - pixelmatch 8: OKLab/HyAB colour metric, so the A/B threshold (0.2) no longer matches
    Playwright's YIQ sensitivity.

### Fixed

- Plugin leftovers: a half-removed plugin folder, its roles, capabilities and WP-Cron events are
  cleaned before install; a broken copy is healed before login.
- BackWPup: a `wp-content` copy orphaned by a server reboot is recovered.
- SSH: command line built and quoted by the suite; `sudo`'s unresolvable-hostname line removed.
- Stuck page navigations fail fast and report the requests the page lost.
- Allure reports no longer embed the checkout's git origin URL (credentials included), branch or
  commit.
- Terminal widths: a flag counts 2 columns, a lone regional indicator 1, as tmux draws them.
- Unit and SSH-twin specs that flaked under load.

## [1.0.0]

First release: Playwright + Cucumber (`playwright-bdd`) E2E suite.

- **BackWPup:** backups (UI and WP-CLI), backup contents, encryption, job transfer, logs, running
  jobs, restore (wizard and WP-CLI), onboarding, plugin deletion. **WP Rocket:** smoke only.
- **Cells and pools** from per-product sites files; `local`, `docker` and `ssh` transports.
- **Plugin zips** built and verified through APVM; `@plugin` install and teardown with leftover sweep
  and `debug.log` scan.
- **Pre-flight**, login setup and fleet `healthcheck`.
- **Reports:** Playwright HTML, Cucumber HTML, Allure; `results.jsonl` stream; report retention.
- **Orchestrator:** runs cells in loops, posts to Slack and Datator.

[1.1.0]: https://github.com/wp-media/wp-media-e2e/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/wp-media/wp-media-e2e/releases/tag/v1.0.0
