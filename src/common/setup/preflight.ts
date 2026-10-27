import { existsSync, statSync } from "node:fs";
import { styleText } from "node:util";

import { execa } from "execa";

import { elevationSupport, exec } from "../wp/exec";
import type { ElevationSupport, ExecResult } from "../wp/exec";
import { planOwnership } from "../wp/ownership";
import type { OwnershipPlan } from "../wp/ownership";
import { firstError } from "../wp/plugin";
import { describePluginDir, inspectPluginDirs } from "../wp/plugin-dir";
import {
  blameCellPlugin,
  healFailedCheck,
  healedCheck,
  reportedCheck,
} from "./cell-plugin";
import type { HealCellPlugin } from "./cell-plugin";
import {
  renderElevationWarning,
  renderPluginDirWarning,
} from "./elevation-report";
import type { SiteElevation } from "./elevation-report";
import { errorMessage } from "../guards";
import { isPlaceholderSite } from "../config/sites";
import { maskSiteUrl } from "../text";
import type {
  DockerTransport,
  LocalTransport,
  SettleLeftovers,
  SiteConfig,
  SiteInput,
  SshTransport,
  Transport,
} from "../config/types";

/**
 * What a product's `settleLeftovers` may take — added once to the auth setup's timeout (sites settle
 * concurrently) and the bound of a product fixture running the same settling: putting a copy back
 * rewrites a whole content directory.
 */
export const SETTLE_LEFTOVERS_ALLOWANCE_MS = 15 * 60 * 1000;

/**
 * Pre-flight transport verification — runs before authentication and tests.
 *
 * Validates that every real (non-placeholder) site's transport is reachable and
 * functional BEFORE the test suite attempts authentication or any WP-CLI commands.
 * This surfaces environment problems (SSH unreachable, container stopped, WP-CLI
 * missing, wrong path) with actionable guidance instead of letting them cascade into
 * cryptic test failures spread across many scenarios.
 *
 * Checks by transport mode (each ends by confirming a real, installed WordPress answers):
 *   ssh    — SSH connection + WP-CLI in PATH + rootDir accessible + WordPress installed
 *   docker — container exists + is running + WP-CLI in container + WordPress installed
 *   local  — rootDir exists + WP-CLI in PATH + WordPress installed
 *
 * "WordPress installed" runs `wp core is-installed`, which checks WordPress's standard DB
 * tables — so it proves the core files load, the database connects, and the install is
 * complete, not merely that the `wp` binary exists.
 *
 * All sites in the pool are checked concurrently. If any fail, a formatted report
 * is thrown as an Error so Playwright's setup project surfaces it clearly, skips
 * the dependent BDD project, and preserves the full error message in the report.
 */

// ── Result types ──────────────────────────────────────────────────────────────

/** The outcome of one named check within a site's pre-flight (e.g. "WP-CLI", "rootDir accessible"). */
export interface CheckResult {
  /** Short, stable label for the check, shown in reports (e.g. "WP-CLI", "WordPress installed"). */
  readonly name: string;
  /** Whether the check passed. */
  readonly ok: boolean;
  /** Human-readable outcome, always present: the success message when `ok`, the failure reason otherwise. */
  readonly detail: string;
  /** Actionable next step, shown only on failure. Omitted when `detail` alone is already actionable. */
  readonly hint?: string;
}

/** The full pre-flight result for one site: its identity plus every check run against it. */
export interface SitePreflightResult {
  /** The site's position in its pool (matches the `parallelIndex` a worker binds to), for report labeling. */
  readonly index: number;
  /** The site's configured base URL, shown in reports. */
  readonly baseURL: string;
  /** The site's transport, shown in reports via {@link transportLabel}. */
  readonly transport: Transport;
  /** Every check run for this site, in execution order. The site is healthy iff every entry is `ok`. */
  readonly checks: CheckResult[];
  /**
   * What privileges this site's transport can reach, when it was asked. Carried alongside the checks
   * rather than parsed back out of one, so the run-level warning
   * ({@link renderElevationWarning}) reads a typed value. Absent when the site never got far enough
   * to be asked — a transport that cannot connect has a louder problem.
   */
  readonly elevation?: ElevationSupport;
  /**
   * Whether this site's files actually need handing to another owner — `planOwnership` returned a
   * grant. Carried so the run-level warning states the ownership cost only where it is true, rather
   * than contradicting the ownership check printed one line above it. Absent alongside
   * {@link elevation}, and for the same reason.
   */
  readonly ownershipPending?: boolean;
  /**
   * Each folder at the cell's slug that WordPress lists no plugin in, described — for the run-level
   * warning ({@link renderPluginDirWarning}). Absent when no slug was given or a gating check failed
   * first; empty when nothing is left, or the folder could not be inspected (its check says so).
   */
  readonly leftoverPluginDirs?: readonly string[];
  /**
   * What was said on removing a broken copy of the cell's plugin that stopped WordPress booting
   * (`./cell-plugin.ts`), for {@link verifyPool} to print; absent when none was removed.
   */
  readonly healedCellPlugin?: string;
}

// ── Transport label (used in error output) ─────────────────────────────────────

/** Human-readable label for a site's transport, e.g. `ssh: ubuntu@203.0.113.10`. Used in reports. */
export function transportLabel(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `ssh: ${transport.username}@${transport.host}`;
    case "docker":
      return `docker: ${transport.container}`;
    case "local":
      return `local: ${transport.rootDir}`;
  }
}

// ── Shared WP-CLI / WordPress checks ────────────────────────────────────────────

/** Extracts the version from `wp --info` stdout (the `WP-CLI version:` line), or "unknown". */
function wpCliVersion(stdout: string): string {
  const line = stdout.split("\n").find((l) => l.startsWith("WP-CLI version:"));
  return line?.split(":")[1]?.trim() ?? "unknown";
}

/**
 * Confirms the `wp` binary is present and runnable through the transport (`wp --info`). This
 * proves WP-CLI exists and executes — NOT that a WordPress install is present; pair it with
 * {@link checkWordPress}, which is only meaningful once this passes.
 *
 * @param transport - transport to run `wp` through.
 * @param name - report label (wording differs per transport, e.g. "WP-CLI in container").
 * @param notFoundHint - actionable guidance shown when `wp` is missing or errors.
 */
async function checkWpCli(
  transport: Transport,
  name: string,
  notFoundHint: string,
): Promise<CheckResult> {
  try {
    const result = await exec(transport, "wp", ["--info"]);
    if (result.exitCode === 0) {
      return {
        name,
        ok: true,
        detail: `wp-cli ${wpCliVersion(result.stdout)}.`,
      };
    }
    return {
      name,
      ok: false,
      detail:
        `WP-CLI exited ${String(result.exitCode)}` +
        (result.stderr.trim() ? `: ${result.stderr.trim()}` : "."),
      hint: notFoundHint,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      ok: false,
      detail: `WP-CLI is not accessible: ${msg}`,
      hint: notFoundHint,
    };
  }
}

/**
 * WordPress's own "PHP is too old to run me" bootstrap message, matched on the stable middle of
 * the sentence core emits from `wp_check_php_mysql_versions()`.
 *
 * This case is exactly why {@link classifyIsInstalled} must read stdout, not just stderr: core
 * prints this line with `printf()` (to STDOUT) and `exit(1)` *before* WP-CLI can wrap it into a
 * stderr `Error:`. By exit code alone it is indistinguishable from "not installed" (both exit 1),
 * so only the text tells them apart — and matching it lets the hint point at PHP instead of a
 * phantom missing database.
 */
const PHP_VERSION_ERROR_RE =
  /running PHP version .+ but WordPress .+ requires at least/i;

/**
 * Classifies the outcome of `wp core is-installed` into a {@link CheckResult}. Pure (no I/O), so
 * the exit-code/stream matrix that separates the three real-world outcomes is unit-testable in
 * isolation.
 *
 * `is-installed` has a deliberately narrow contract: exit 0 = installed; exit 1 with NO output =
 * not installed (its tables are missing) — it is silent on that path by design. So ANY output on a
 * non-zero exit, on EITHER stream, means WordPress could not even be evaluated — its bootstrap
 * failed (PHP too old, database down, a fatal in a must-use plugin) — which is a DIFFERENT problem
 * from "not installed" and must never be reported as one. Mislabeling the former as the latter is
 * the false negative this fixes.
 *
 * @param name - the check's report label.
 * @param result - the raw {@link ExecResult} from `wp core is-installed`.
 */
function classifyIsInstalled(name: string, result: ExecResult): CheckResult {
  if (result.exitCode === 0) {
    return {
      name,
      ok: true,
      detail: "WordPress is installed and its database is reachable.",
    };
  }

  // Merge both streams: the PHP-version guard prints to stdout, database/other bootstrap
  // failures to stderr. `is-installed` emits nothing only when WordPress is genuinely not installed.
  const output = [result.stdout, result.stderr]
    .map((stream) => stream.trim())
    .filter((stream) => stream !== "")
    .join("\n");

  // Silent exit 1 — the one and only "not installed" verdict.
  if (output === "" && result.exitCode === 1) {
    return {
      name,
      ok: false,
      detail: `WordPress is not installed at the target (exit ${String(result.exitCode)}): its database tables are missing.`,
      hint: [
        "The target boots WordPress but has no install. Confirm the transport points at the",
        "intended site; if it is genuinely empty, install it (`wp core install`).",
      ].join("\n"),
    };
  }

  // A PHP-too-old bootstrap failure disguised as exit 1 — report it as a PHP problem, not a
  // missing install, and aim the hint at the PHP version WP-CLI used.
  if (PHP_VERSION_ERROR_RE.test(output)) {
    return {
      name,
      ok: false,
      detail: `WordPress could not be evaluated (exit ${String(result.exitCode)}): ${output}`,
      hint: [
        "WordPress rejected the PHP version WP-CLI ran it under — a PHP problem, not a missing",
        "install. Point WP-CLI at a new-enough PHP (the `php` on PATH, or set WP_CLI_PHP) that",
        "satisfies this WordPress, then re-run.",
      ].join("\n"),
    };
  }

  // Any other non-zero exit: WordPress could not boot. Surface whatever it said, verbatim.
  return {
    name,
    ok: false,
    detail: output
      ? `WordPress could not be evaluated (exit ${String(result.exitCode)}): ${output}`
      : `WordPress could not be evaluated (exit ${String(result.exitCode)}) and produced no output.`,
    hint: [
      "`wp core is-installed` failed before it could answer — WordPress could not boot. Common",
      "causes: the database is down or wp-config.php credentials are wrong, a fatal in a",
      "plugin/theme, or the wrong rootDir/container. Run it there directly to see the full error.",
    ].join("\n"),
  };
}

/**
 * Locales whose admin UI is English, so role- and label-based locators written against English
 * strings resolve. `en_US` is WordPress's built-in default (reported when no language is installed);
 * the other English variants ship translations, but leave admin strings in English.
 */
const ENGLISH_LOCALES = new Set([
  "en_US",
  "en_GB",
  "en_AU",
  "en_CA",
  "en_NZ",
  "en_ZA",
]);

/** {@link checkAdminLocale}'s check, and — when its `wp eval` ran and failed — the line it died on. */
type LocaleCheck = CheckResult & { readonly bootError?: string };

/**
 * Runs `determine_locale()` as the user, with every plugin loaded unless one is skipped.
 *
 * @param transport - the site.
 * @param username - the user whose admin language counts.
 * @param skipped - a plugin slug to leave out (`--skip-plugins=<slug>`), already checked usable.
 */
function readAdminLocale(
  transport: Transport,
  username: string,
  skipped?: string,
): Promise<ExecResult> {
  return exec(transport, "wp", [
    ...(skipped === undefined ? [] : [`--skip-plugins=${skipped}`]),
    "eval",
    "echo determine_locale();",
    `--user=${username}`,
  ]);
}

/**
 * Confirms the site's admin UI is in English.
 *
 * Every page object locates controls by their **visible English name** (`getByRole`,
 * `getByLabel`) — the first rule of the locator policy, and the reason the suite is readable. A
 * translated admin silently invalidates all of them at once, and the symptom is dozens of
 * indistinguishable locator timeouts spread across unrelated scenarios. Asserting the locale once,
 * here, converts that into a single failure that names the cause.
 *
 * The verdict comes from **`determine_locale()`**, which is the function WordPress itself calls to
 * choose the language of an admin request. That matters: the locale can come from the user's own
 * profile, the site option, a `WPLANG` constant in `wp-config.php`, or a filter, and only
 * `determine_locale()` accounts for all of them — `get_option('WPLANG')` alone reports an empty
 * string on a perfectly English site *and* misses a per-user override. It is evaluated as the
 * configured admin user (`--user`), because a user-profile language beats the site default.
 *
 * The PHP is a fixed, read-only literal; the only interpolated value is the username, passed as a
 * separate argument that the exec layer escapes.
 *
 * @returns the check, with the line WordPress died on when the command ran and failed.
 */
async function checkAdminLocale(
  transport: Transport,
  username: string,
): Promise<LocaleCheck> {
  const name = "Admin locale is English";
  try {
    const result = await readAdminLocale(transport, username);
    if (result.exitCode !== 0) {
      return {
        name,
        ok: false,
        detail:
          `Could not read the admin locale (exit ${String(result.exitCode)})` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : "."),
        hint: `Check that the user "${username}" exists on this site.`,
        bootError: firstError(result),
      };
    }
    const locale = result.stdout.trim();
    if (ENGLISH_LOCALES.has(locale)) {
      return { name, ok: true, detail: `${locale}.` };
    }
    return {
      name,
      ok: false,
      detail: `The admin UI for "${username}" renders in "${locale}", not English.`,
      hint: [
        "Page objects locate controls by their visible English names, so a translated admin would",
        "fail as many unrelated locator timeouts instead of once here. Set the site language to",
        "English (Settings → General → Site Language), or clear this user's own language override",
        `(Users → ${username} → Language).`,
      ].join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      ok: false,
      detail: `Could not read the admin locale: ${msg}`,
      hint: "Verify the transport reaches the target and `wp` is available there.",
    };
  }
}

/**
 * Confirms a real, installed WordPress answers through the transport via `wp core is-installed`.
 *
 * Exit 0 proves the core files load, the database connects, AND the install is complete. A
 * non-zero exit is classified by {@link classifyIsInstalled}, which separates "genuinely not
 * installed" from "WordPress could not boot" (PHP too old, DB down, fatal) so an environment
 * fault is never mislabeled as a missing install. Run only after {@link checkWpCli} passes, so a
 * missing `wp` is not reported twice.
 */
async function checkWordPress(transport: Transport): Promise<CheckResult> {
  const name = "WordPress installed";
  try {
    const result = await exec(transport, "wp", ["core", "is-installed"]);
    return classifyIsInstalled(name, result);
  } catch (err) {
    // Could not run the command at all (transport dropped, `wp` vanished): an environment fault,
    // not a WordPress verdict — mirrors the exec layer's "couldn't run ⇒ throw" contract.
    const msg = err instanceof Error ? err.message : String(err);
    return {
      name,
      ok: false,
      detail: `Could not run \`wp core is-installed\`: ${msg}`,
      hint: "Verify the transport reaches the target and `wp` is available there.",
    };
  }
}

// ── SSH checks ────────────────────────────────────────────────────────────────

async function verifySsh(transport: SshTransport): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];
  let wpCliOk = false;

  // Check 1: SSH connectivity + WP-CLI in PATH.
  // A single `wp --info` call validates both: it requires an SSH connection AND
  // that `wp` is executable. If the connection itself fails, exec() throws.
  try {
    const result = await exec(transport, "wp", ["--info"]);
    if (result.exitCode === 0) {
      wpCliOk = true;
      checks.push({
        name: "SSH + WP-CLI",
        ok: true,
        detail: `Connected. wp-cli ${wpCliVersion(result.stdout)}.`,
      });
    } else {
      checks.push({
        name: "SSH + WP-CLI",
        ok: false,
        detail:
          `WP-CLI exited ${String(result.exitCode)}` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : "."),
        hint: `Ensure 'wp' is in PATH on ${transport.host} for user '${transport.username}'.`,
      });
      // We connected (the command ran), so we still check rootDir below.
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "SSH connection",
      ok: false,
      detail: msg,
      hint: [
        `Verify host "${transport.host}" is reachable on port 22.`,
        `Test locally: ssh -i "${transport.privateKeyPath}" ${transport.username}@${transport.host} "echo ok"`,
      ].join("\n"),
    });
    // Cannot connect → rootDir check is moot.
    return checks;
  }

  // Check 2: rootDir exists, is a directory, and the SSH user can traverse INTO it —
  // which is what WP-CLI needs, since the exec layer runs `wp` with cwd = rootDir. The
  // trailing `/.` forces `ls` to resolve into the directory, so this requires execute
  // (search) permission on rootDir itself and fails on a non-directory. Plain
  // `ls -d <path>` only stats the entry via its parent, so it would pass even for a
  // regular file or a directory the user cannot enter — neither of which is usable here.
  // (It does NOT require read/list permission on the directory, which WP-CLI never needs.)
  try {
    const result = await exec(transport, "ls", [
      "-d",
      `${transport.rootDir}/.`,
    ]);
    if (result.exitCode === 0) {
      checks.push({
        name: "rootDir accessible",
        ok: true,
        detail: `"${transport.rootDir}" exists and is a traversable directory.`,
      });
    } else {
      checks.push({
        name: "rootDir accessible",
        ok: false,
        detail:
          `"${transport.rootDir}" is not a usable directory (exit ${String(result.exitCode)})` +
          (result.stderr.trim() ? `: ${result.stderr.trim()}` : "."),
        hint: [
          `Confirm the path exists, is a directory, and user "${transport.username}" can enter it`,
          `(WP-CLI runs from this directory, so it needs execute/search permission — not read):`,
          `  ssh -i "${transport.privateKeyPath}" ${transport.username}@${transport.host} "ls -ld '${transport.rootDir}'"`,
          `  If access is restricted, grant traverse rights via chmod, ACLs, or group membership.`,
        ].join("\n"),
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "rootDir accessible",
      ok: false,
      detail: `Error checking "${transport.rootDir}": ${msg}`,
      hint: `Verify the rootDir path in your sites.json is correct.`,
    });
  }

  // Check 3: a real, installed WordPress answers (only worth running once `wp` works).
  if (wpCliOk) {
    checks.push(await checkWordPress(transport));
  }

  return checks;
}

// ── Docker checks ─────────────────────────────────────────────────────────────

async function verifyDocker(
  transport: DockerTransport,
): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Check 1: container exists and its current status.
  // `docker inspect --format '{{.State.Status}}' <container>` prints the status
  // (running | exited | paused | …) and exits 0 only when the container exists.
  try {
    const inspectResult = await execa(
      "docker",
      ["inspect", "--format", "{{.State.Status}}", transport.container],
      { reject: false, timeout: 15_000 },
    );

    // When Docker is not installed or the daemon is not running, the process
    // may fail to spawn (exitCode undefined) rather than exit non-zero.
    const exitCode: number | undefined =
      typeof inspectResult.exitCode === "number"
        ? inspectResult.exitCode
        : undefined;

    if (exitCode === undefined) {
      checks.push({
        name: "Docker daemon",
        ok: false,
        detail:
          "Cannot reach the Docker daemon (is Docker installed and running?).",
        hint: `Verify Docker is installed and the daemon is running: docker info`,
      });
      return checks;
    }

    if (exitCode !== 0) {
      checks.push({
        name: "Container exists",
        ok: false,
        detail: `Container "${transport.container}" does not exist.`,
        hint: [
          `Run 'docker ps -a' to list all containers.`,
          `If using the project's Docker setup: npm run env:up`,
        ].join("\n"),
      });
      return checks;
    }

    const status = inspectResult.stdout.trim();
    if (status !== "running") {
      checks.push({
        name: "Container running",
        ok: false,
        detail: `Container "${transport.container}" exists but is not running (status: ${status}).`,
        hint: [
          `Start the container: docker start ${transport.container}`,
          `Or with compose: docker compose up -d  (or: npm run env:up)`,
        ].join("\n"),
      });
      return checks;
    }

    checks.push({
      name: "Container running",
      ok: true,
      detail: `Container "${transport.container}" is running.`,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    checks.push({
      name: "Docker check",
      ok: false,
      detail: `docker inspect failed: ${msg}`,
      hint: `Ensure Docker is installed and running: docker info`,
    });
    return checks;
  }

  // Check 2: WP-CLI accessible inside the running container.
  const wpCli = await checkWpCli(
    transport,
    "WP-CLI in container",
    `Verify the container image includes WP-CLI: docker exec ${transport.container} wp --info`,
  );
  checks.push(wpCli);

  // Check 3: a real, installed WordPress is reachable inside the container.
  if (wpCli.ok) {
    checks.push(await checkWordPress(transport));
  }

  return checks;
}

// ── Local checks ──────────────────────────────────────────────────────────────

async function verifyLocal(transport: LocalTransport): Promise<CheckResult[]> {
  const checks: CheckResult[] = [];

  // Check 1: rootDir exists and is a directory.
  let isDir = false;
  try {
    isDir =
      existsSync(transport.rootDir) &&
      statSync(transport.rootDir).isDirectory();
  } catch {
    // isDir stays false
  }

  if (isDir) {
    checks.push({
      name: "rootDir exists",
      ok: true,
      detail: `"${transport.rootDir}" is a directory.`,
    });
  } else {
    const exists = existsSync(transport.rootDir);
    checks.push({
      name: "rootDir exists",
      ok: false,
      detail: exists
        ? `"${transport.rootDir}" exists but is not a directory.`
        : `"${transport.rootDir}" does not exist.`,
      hint: [
        `Update rootDir in your sites.json to the WordPress root directory`,
        `(the directory that contains wp-load.php).`,
      ].join("\n"),
    });
    return checks;
  }

  // Check 2: WP-CLI accessible from the host.
  const wpCli = await checkWpCli(
    transport,
    "WP-CLI",
    `Ensure 'wp' is installed and in PATH. See: https://wp-cli.org/#installing`,
  );
  checks.push(wpCli);

  // Check 3: a real, installed WordPress is reachable at rootDir.
  if (wpCli.ok) {
    checks.push(await checkWordPress(transport));
  }

  return checks;
}

// ── Ownership & elevation (informational) ─────────────────────────────────────

/**
 * What this site will do about the ownership of the files the suite installs.
 *
 * **Never fails.** It reports a property of the host that the suite adapts to rather than depends
 * on: a site whose ownership cannot be corrected still runs its scenarios, it merely leaves the web
 * server unable to write the plugin under test. Reported here so that is visible at the start of a
 * run rather than inferred from a plugin misbehaving in the middle of one.
 *
 * The decision comes from `planOwnership`, the same function that later carries it out, so this can
 * never describe something different from what will happen — but `planOwnership` deliberately says
 * nothing about *privileges*, and a handover needs them. So the elevation answer is folded in here:
 * a site that needs a handover it may not perform must be told that, not told the handover will
 * happen.
 *
 * @param plan - the decision `planOwnership` reached for this site, taken by the caller so the
 * elevation check can be told the same thing.
 * @param elevation - what the same site's elevation probe answered, already taken by the caller.
 * @returns a check describing what will and will not happen to this site's files. It fails only for
 * a `fileOwner` that cannot be parsed, which is a mistake in configuration rather than a property of
 * the host.
 */
function checkFileOwnership(
  plan: OwnershipPlan,
  elevation: ElevationSupport,
): CheckResult {
  const name = "File ownership";
  switch (plan.kind) {
    case "disabled":
      return {
        name,
        ok: true,
        detail:
          "Normalization is off for this site (`transport.fileOwner: false`).",
      };
    case "bad-owner":
      // The one failing case: everything else here describes a host, but this is our own
      // configuration being unreadable, and rendering an error message as a green tick is how it
      // gets ignored. The sites loader rejects the same value, so reaching this means the transport
      // was built in code.
      return { name, ok: false, detail: plan.message };
    case "unknown-ownership":
      return {
        name,
        ok: true,
        detail:
          "Could not be read, so installed files will keep the transport user's ownership. " +
          'Declare `transport.fileOwner` ("user:group") for this site if the web server cannot write them.',
      };
    case "unknown-identity":
      return {
        name,
        ok: true,
        detail: `Site files are ${plan.target.user}:${plan.target.group}, but which user this site's commands run as could not be read; ownership will be left alone.`,
      };
    case "unnecessary":
      return {
        name,
        ok: true,
        detail: `${plan.target.user}:${plan.target.group} — the transport's user already owns the install, so nothing is changed.`,
      };
    case "grant": {
      const owner = `${plan.target.user}:${plan.target.group}`;
      if (elevation !== "available") {
        return {
          name,
          ok: true,
          detail:
            `Installed files need handing to ${owner}, but cannot be: that requires privileges and ` +
            `elevation is ${elevation}. The web server may be unable to write the plugin under test.`,
        };
      }
      return {
        name,
        ok: true,
        detail:
          `Installed files will be handed to ${owner} with \`${plan.mode}\`` +
          (plan.worldWritable
            ? ", which includes world-write because this site's commands run as a user outside that " +
              `group; adding it to "${plan.target.group}" would keep the grant group-scoped.`
            : "."),
      };
    }
  }
}

/**
 * Whether this site can run a privileged housekeeping command.
 *
 * **Never fails**, for the same reason as above — but an `unavailable` answer also feeds the
 * run-level warning ({@link renderElevationWarning}), because a single check line among many is
 * exactly the thing an operator scrolls past.
 *
 * @param support - what this site's elevation probe answered.
 * @returns an always-passing check naming what housekeeping can and cannot do.
 */
function elevationCheck(
  support: ElevationSupport,
  plan: OwnershipPlan,
): CheckResult {
  const name = "Elevation";
  switch (support) {
    case "available":
      return {
        name,
        ok: true,
        detail: "Passwordless `sudo` is available for housekeeping.",
      };
    case "disabled":
      return {
        name,
        ok: true,
        detail:
          "Declined by this site (`transport.elevate: false`); cleanup stays unprivileged.",
      };
    case "unavailable":
      return {
        name,
        ok: true,
        // Only the two plans that *know* nothing is pending may say so. `unknown-ownership`,
        // `unknown-identity` and `bad-owner` know nothing at all, and the ownership check one line
        // above already says that — claiming "needs no change" beside it is a contradiction.
        detail:
          plan.kind === "unnecessary" || plan.kind === "disabled"
            ? "`sudo -n true` failed — cleanup will be incomplete on this site. Ownership needs no change here."
            : "`sudo -n true` failed — cleanup and ownership normalization will be incomplete on this site.",
      };
  }
}

// ── Leftover plugin folders (informational) ───────────────────────────────────

/**
 * Whether the cell's plugin slug holds a folder WordPress lists no plugin in — part of a plugin a
 * removal stopped part-way left, which blocks every install of it.
 *
 * **Never fails**: the cell's next `@plugin` scenario removes such a folder and says so, so this only
 * makes the cause visible before a scenario pays for it. Only the slug the cell installs is looked at
 * — the one its scenarios clear; another edition's folder, or another team's, is not this cell's to
 * judge or remove. A folder WordPress *does* list is an installed plugin, which the next scenario
 * uninstalls as usual, so it is not reported.
 *
 * @param transport - the site's transport.
 * @param slugs - the slug(s) the cell installs as.
 * @returns the check, and each leftover folder described for the run-level warning.
 */
export async function checkPluginDirs(
  transport: Transport,
  slugs: readonly string[],
): Promise<{ check: CheckResult; leftovers: string[] }> {
  const name = "Plugin folders";
  try {
    const states = await inspectPluginDirs(transport, slugs);
    const leftovers = [...states.values()].flatMap((state) =>
      state.kind === "orphaned" ? [describePluginDir(state)] : [],
    );
    const detail =
      leftovers.length === 0
        ? `Nothing WordPress cannot see at ${slugs.join(", ")}.`
        : `${String(leftovers.length)} folder(s) WordPress lists no plugin in, each blocking every ` +
          `install of its plugin; the next @plugin scenario removes it: ${leftovers.join("; ")}`;
    return { check: { name, ok: true, detail }, leftovers };
  } catch (error) {
    return {
      check: {
        name,
        ok: true,
        detail: `Could not be inspected: ${errorMessage(error)}`,
      },
      leftovers: [],
    };
  }
}

// ── Per-site dispatcher ───────────────────────────────────────────────────────

/**
 * Runs the transport + WordPress checks for one site. Exported so callers other than
 * {@link verifyPool} (e.g. the standalone `healthcheck.ts`) can run and report per-site
 * results without throwing. Takes a bare {@link SiteInput} — it never reads `storageState`.
 *
 * @param site - the site to check.
 * @param index - its position in its pool.
 * @param slugs - the slug(s) the cell installs as, for {@link checkPluginDirs} and for blaming a
 * WordPress that cannot boot; none skips both.
 * @param heal - removes a broken copy of the cell's plugin that stops WordPress booting — the auth
 * setup's; omitted, it is only reported (the healthcheck changes nothing).
 */
export async function verifySite(
  site: SiteInput,
  index: number,
  slugs: readonly string[] = [],
  heal?: HealCellPlugin,
): Promise<SitePreflightResult> {
  let checks: CheckResult[];
  switch (site.transport.mode) {
    case "ssh":
      checks = await verifySsh(site.transport);
      break;
    case "docker":
      checks = await verifyDocker(site.transport);
      break;
    case "local":
      checks = await verifyLocal(site.transport);
      break;
  }

  // The locale check needs a WordPress that boots, so it only runs once every transport-level check
  // has passed — otherwise a site with no database would report two failures for one cause, and the
  // second would be the less useful one.
  if (!checks.every((check) => check.ok)) {
    return { index, baseURL: site.baseURL, transport: site.transport, checks };
  }
  const boot = await checkBootAndLocale(site, slugs, heal);
  checks.push(...boot.checks);

  // Same gate, and for a stronger reason: both of these run commands on the site, so asking a
  // transport that has already failed would only produce a second way of saying so. Neither can fail
  // the site — they describe what housekeeping will and will not be able to do.
  const elevation = await elevationSupport(site.transport);
  // Taken once and shared: both checks describe the same decision, and computing it twice is how
  // two lines about one site come to disagree.
  const plan = await planOwnership(site.transport);
  checks.push(checkFileOwnership(plan, elevation));
  checks.push(elevationCheck(elevation, plan));
  const pluginDirs =
    slugs.length === 0
      ? undefined
      : await checkPluginDirs(site.transport, slugs);
  if (pluginDirs !== undefined) checks.push(pluginDirs.check);

  return {
    index,
    baseURL: site.baseURL,
    transport: site.transport,
    checks,
    elevation,
    ownershipPending: plan.kind === "grant",
    ...(pluginDirs === undefined
      ? {}
      : { leftoverPluginDirs: pluginDirs.leftovers }),
    ...(boot.healed === undefined ? {} : { healedCellPlugin: boot.healed }),
  };
}

/**
 * The admin locale check, and — when WordPress could not boot for it — whether the cell's own plugin
 * is why ({@link blameCellPlugin}): then that copy is removed with `heal` and the locale asked again, or,
 * with no `heal`, reported in place of the locale check, one failure for one cause.
 *
 * @param site - the site, its transport verified.
 * @param slugs - the slug(s) the cell installs as.
 * @param heal - how to remove the cell's plugin; omitted where nothing may change.
 * @returns the checks to add, and — when a broken copy was removed — what was said about it.
 */
async function checkBootAndLocale(
  site: SiteInput,
  slugs: readonly string[],
  heal: HealCellPlugin | undefined,
): Promise<{ checks: CheckResult[]; healed?: string }> {
  const { transport, username } = site;
  const askLocale = async (): Promise<{
    check: CheckResult;
    bootError?: string;
  }> => {
    const { bootError, ...check } = await checkAdminLocale(transport, username);
    return bootError === undefined ? { check } : { check, bootError };
  };
  const locale = await askLocale();
  if (locale.bootError === undefined) return { checks: [locale.check] };
  const slug = await blameCellPlugin(slugs, async (candidate) => {
    try {
      return (
        (await readAdminLocale(transport, username, candidate)).exitCode === 0
      );
    } catch {
      return false;
    }
  });
  if (slug === undefined) return { checks: [locale.check] };

  const broken = { slug, error: locale.bootError };
  if (heal === undefined) return { checks: [reportedCheck(broken)] };
  let healed: CheckResult;
  try {
    healed = healedCheck(broken, await heal(transport, slug));
  } catch (error) {
    return { checks: [healFailedCheck(broken, errorMessage(error))] };
  }
  return {
    checks: [healed, (await askLocale()).check],
    healed: healed.detail,
  };
}

// ── Pool verification ─────────────────────────────────────────────────────────

/**
 * Verifies the transport for every real (non-placeholder) site in the pool.
 * All sites are checked concurrently. If any fail, a formatted report is thrown so
 * Playwright's setup project surfaces it clearly, skips the dependent BDD project,
 * and preserves the full error in the test report.
 *
 * Call this in the auth setup project before the authentication loop. Placeholder
 * sites (example.test hostnames) are silently skipped — they have no real transport.
 *
 * @param pool - the cell's sites.
 * @param product - the product, for the report.
 * @param cell - the cell, for the report.
 * @param slugs - the slug(s) the cell installs as, for {@link verifySite}.
 * @param heal - see {@link verifySite}.
 * @param settle - the product's `settleLeftovers`, run on every site before its checks
 * ({@link settleSiteLeftovers}); the healthcheck, calling {@link verifySite} alone, never settles.
 */
export async function verifyPool(
  pool: readonly SiteConfig[],
  product: string,
  cell: string,
  slugs: readonly string[] = [],
  heal?: HealCellPlugin,
  settle?: SettleLeftovers,
): Promise<void> {
  const real = pool
    .map((site, i) => ({ site, i }))
    .filter(({ site }) => !isPlaceholderSite(site));

  if (real.length === 0) return;

  if (settle !== undefined) {
    await Promise.all(
      real.map(({ site }) => settleSiteLeftovers(site, settle)),
    );
  }

  const results = await Promise.all(
    real.map(({ site, i }) => verifySite(site, i, slugs, heal)),
  );

  // Changed a site before any scenario: always said, on a passing pool too.
  for (const { baseURL, healedCellPlugin } of results) {
    if (healedCellPlugin !== undefined) {
      console.warn(`[preflight] ${maskSiteUrl(baseURL)}: ${healedCellPlugin}`);
    }
  }

  // Printed before the early return below, because a *passing* pool prints nothing otherwise — and a
  // pool that cannot elevate passes. Never throws and never changes a verdict: it warns.
  warnAboutElevation(results);
  warnAboutPluginDirs(results);

  const failed = results.filter((r) => r.checks.some((c) => !c.ok));
  if (failed.length === 0) return;

  throw new Error(buildReport(failed, results.length, product, cell));
}

/**
 * Settles what a product's killed runs left on one site, before the gates — which that damage could
 * fail, skipping the very fixtures that settle it. Best-effort: a refusal or failure is a warning, and
 * the gates and the product's own checks then judge the site as they find it.
 *
 * @param site - the site.
 * @param settle - the product's `settleLeftovers`.
 */
export async function settleSiteLeftovers(
  site: SiteInput,
  settle: SettleLeftovers,
): Promise<void> {
  try {
    await settle(site);
  } catch (error) {
    console.warn(
      `[preflight] ${maskSiteUrl(site.baseURL)}: left as found — ${errorMessage(error)}`,
    );
  }
}

/**
 * Prints the run-level elevation warning, if any site needs it.
 *
 * Exported and called by the standalone healthcheck too, so a fleet check and a suite run print the
 * identical banner from the identical mapping — one implementation, not two that agree today.
 *
 * `flatMap` rather than filter-then-map: it drops the sites that were never asked *and* narrows the
 * optional away, so no `?? "unavailable"` fallback is needed — one that would silently relabel a
 * site as unable to elevate if the two steps were ever reordered.
 *
 * @param results - every site verified in this run. Sites that never got far enough to be asked
 * about privileges are skipped; a transport that cannot connect has a louder problem.
 * @param print - where to send it. Defaults to `console.warn` (stderr), which is right for a
 * Playwright setup project, where the banner is an aside to a test run. The fleet healthcheck passes
 * `console.log` instead: its whole output *is* the report, and a documented `healthcheck > fleet.log`
 * would otherwise capture every line except this one.
 */
export function warnAboutElevation(
  results: readonly SitePreflightResult[],
  print: (message: string) => void = console.warn,
): void {
  const banner = renderElevationWarning(
    results.flatMap((result): SiteElevation[] =>
      result.elevation === undefined
        ? []
        : [
            {
              baseURL: result.baseURL,
              transport: transportLabel(result.transport),
              support: result.elevation,
              ownershipPending: result.ownershipPending === true,
            },
          ],
    ),
  );
  if (banner !== undefined) print(banner);
}

/**
 * Prints the run-level warning for leftover plugin folders, if any site holds one — shared with the
 * healthcheck, as {@link warnAboutElevation} is.
 *
 * @param results - every site verified in this run.
 * @param print - where to send it; see {@link warnAboutElevation}.
 */
export function warnAboutPluginDirs(
  results: readonly SitePreflightResult[],
  print: (message: string) => void = console.warn,
): void {
  const banner = renderPluginDirWarning(
    results.map((result) => ({
      baseURL: result.baseURL,
      transport: transportLabel(result.transport),
      leftovers: result.leftoverPluginDirs ?? [],
    })),
  );
  if (banner !== undefined) print(banner);
}

// ── Error report formatting ───────────────────────────────────────────────────

function buildReport(
  failed: SitePreflightResult[],
  total: number,
  product: string,
  cell: string,
): string {
  const lines: string[] = [];

  lines.push(
    styleText(
      ["bold"],
      `[preflight] Transport verification failed — ${String(failed.length)} of ${String(total)} site(s) in "${product}/${cell}" could not be verified.`,
    ),
  );
  lines.push("Fix the issues below before re-running the suite:\n");

  for (const result of failed) {
    const label = `Site ${String(result.index)} — ${maskSiteUrl(result.baseURL)}  [${transportLabel(result.transport)}]`;
    lines.push(
      `  ${styleText(["bold", "red"], "✗")} ${styleText(["bold"], label)}`,
    );

    for (const check of result.checks) {
      if (check.ok) {
        lines.push(
          `    ${styleText(["green"], "✓")} ${check.name}: ${check.detail}`,
        );
      } else {
        lines.push(
          `    ${styleText(["red"], "✗")} ${styleText(["bold"], check.name)}: ${check.detail}`,
        );
        if (check.hint !== undefined) {
          for (const hintLine of check.hint.split("\n")) {
            lines.push(`      ${styleText(["yellow"], "→")} ${hintLine}`);
          }
        }
      }
    }
    lines.push("");
  }

  const passed = total - failed.length;
  lines.push(
    passed > 0
      ? `${String(passed)} of ${String(total)} site(s) passed. Resolve the issues above and re-run.`
      : `All sites failed pre-flight. Resolve the issues above and re-run.`,
  );

  return lines.join("\n");
}
