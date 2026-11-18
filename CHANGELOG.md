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

- No file ownership handover when commands already run as the site's user.
- CI: unit tests in two shards; SSH twins in CI.

### Fixed

- Plugin leftovers: a half-removed plugin folder, its roles, capabilities and WP-Cron events are
  cleaned before install; a broken copy is healed before login.
- BackWPup: a `wp-content` copy orphaned by a server reboot is recovered.
- SSH: command line built and quoted by the suite; `sudo`'s unresolvable-hostname line removed.
- Stuck page navigations fail fast and report the requests the page lost.

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
