import "./src/common/config/load-env";

import { mkdir, writeFile } from "node:fs/promises";
import { basename } from "node:path";

import { chromium, expect } from "@playwright/test";
import type { Browser, Locator, Page } from "@playwright/test";

import { loginViaUi } from "./src/common/auth/login";
import { boolEnv, env, intEnv } from "./src/common/config/env";
import { consolePrinters } from "./src/common/config/output";
import { rule } from "./src/common/terminal/layout";
import type { SiteInput, Transport } from "./src/common/config/types";
import { disposeConnections, wpCli } from "./src/common/wp/exec";
import { ensurePluginAbsent } from "./src/common/wp/plugin";
import { stageAndInstallPlugin } from "./src/common/wp/staging";
import { backwpup } from "./src/projects/backwpup/config/backwpup.config";
import { prepareResolvedDataDirs } from "./src/common/wp/residue";
import { BackupHistoryTable } from "./src/projects/backwpup/pages/backup-history.table";
import { ProRestorePage } from "./src/projects/backwpup/pages/restore.page";
import { WizardWatch } from "./src/projects/backwpup/pages/wizard-watch";
import { BACKWPUP_SITE_RESIDUE } from "./src/projects/backwpup/support/residue";
import { runScheduledBackup } from "./src/projects/backwpup/support/backups";
import {
  handRestoreWorkingDirToSite,
  resolveRestoreWorkingDirs,
} from "./src/projects/backwpup/support/restore-dir";

/**
 * Re-captures BackWPup's locator-contract fixtures from a real site, and reports what differs
 * between the **onboarding page** and the **dashboard**.
 *
 * The fixtures under `src/projects/backwpup/pages/__fixtures__/` are only worth anything if nobody
 * hand-wrote them (see the header of `locator-contract.spec.ts`). This script is what makes that
 * claim checkable: it drives a real WordPress, pulls whole containers straight out of the live DOM,
 * and sanitises exactly two classes of per-capture noise. Re-running it is the supported way to
 * refresh the directory after a plugin change.
 *
 * **Why two sidebar captures rather than one.** BackWPup renders the *same* panel templates under
 * different roots depending on the screen — `parts/sidebar/select-files.php` fills its own
 * `#sidebar-select-files` article during onboarding but is embedded inside `#sidebar-settings-data-type`
 * on a job card — so a single "sidebars" fixture can only ever prove one screen's shape. Each screen
 * therefore gets its own capture, and the contract spec asserts both.
 *
 * Usage: `npm run fixtures:capture` (add `--headed` to watch it work). It **mutates the target site**:
 * it removes any existing BackWPup (files *and* options), installs the plugin fresh, flips
 * `backwpup_onboarding` to re-enter onboarding, and completes it — and last, on Pro, backs the site up
 * through its one scheduled job and restores the database from that backup, through the restore
 * wizard it captures step by step (`CAPTURE_SKIP_RESTORE=true` leaves that out;
 * `CAPTURE_RESTORE_ONLY=true` captures only the wizard, installing nothing, on a Pro site already set
 * up with exactly one scheduled job). The removal is what keeps the fixtures a description of the
 * plugin rather than of whatever the site was last used for.
 * Point it only at a disposable QA cell — it reads the site from the product's `sites.json`.
 */

// ── Configuration ────────────────────────────────────────────────────────────────

/** Which cell/site of the product's pool to drive. Single-site pools are the norm here. */
const CELL = env("CAPTURE_CELL", "pro@nginx");
const SITE_INDEX = intEnv("CAPTURE_SITE_INDEX", 0, 0, 64);

/**
 * The plugin zip to install. Defaults to the latest-stable Pro build in the APVM cache, because that
 * is the ref the fixtures should describe; override to capture from any other build.
 */
const PLUGIN_ZIP = env(
  "CAPTURE_PLUGIN_ZIP",
  `${process.env.HOME ?? ""}/.apvm/cache/backwpup/commits/5.7.5/707cf43/backwpup-pro-en-5.7.5-707cf43f.zip`,
);

/**
 * Capture the restore wizard **only**, on a Pro site already set up with exactly one scheduled job —
 * leaving every other fixture as it is. Installs nothing: an install would remove that job.
 */
const RESTORE_ONLY = boolEnv("CAPTURE_RESTORE_ONLY", false);

/** Skip the install and capture whatever is already active. Useful when iterating on the captures. */
const SKIP_INSTALL = boolEnv("CAPTURE_SKIP_INSTALL", false) || RESTORE_ONLY;

/**
 * Skip onboarding and re-capture only the dashboard, against whatever state the site is already in.
 * The onboarding phase is destructive and slow, so this is what makes iterating on the dashboard
 * captures practical; it assumes onboarding has been completed at least once.
 */
const SKIP_ONBOARDING = boolEnv("CAPTURE_SKIP_ONBOARDING", false);

/**
 * Skip the restore wizard. Its capture runs a real restore — a database-only one, the cheapest that
 * walks every step — so it is last, and can be left out when iterating on the other captures.
 */
const SKIP_RESTORE = boolEnv("CAPTURE_SKIP_RESTORE", false);

const HEADED =
  process.argv.includes("--headed") || boolEnv("CAPTURE_HEADED", false);

const FIXTURES_DIR = "src/projects/backwpup/pages/__fixtures__";
const TIMEOUT = intEnv("CAPTURE_TIMEOUT_MS", 30_000, 1_000, 300_000);

/** Budget for the backup onboarding starts on submit. Generous: it is a real backup of a real site. */
const RUN_TIMEOUT = intEnv(
  "CAPTURE_RUN_TIMEOUT_MS",
  300_000,
  10_000,
  1_800_000,
);

/** Placeholders the fixtures use for per-capture noise, matching what is already committed. */
const HOST_PLACEHOLDER = "wordpress.test";
const NONCE_PLACEHOLDER = "0000000000";

/**
 * What a restore working directory's name is written as. Its 20-hex tail is that web-served
 * directory's only protection on nginx — the plugin itself redacts it from its logs — so no capture
 * may carry a real one.
 */
const RESTORE_DIR_PLACEHOLDER = "backwpup-restore-00000000000000000000";

// stdout's palette: colour as the stream and `E2E_OUTPUT` allow, ASCII symbols where Unicode is not.
const { paint, symbol } = consolePrinters().out.palette;

const RULE = rule({ width: 78, line: symbol("rule") });

/** "From one page to a panel of it", in step titles. */
const ARROW = symbol("arrow");

// ── Reporting ────────────────────────────────────────────────────────────────────

interface Finding {
  readonly topic: string;
  readonly onboarding: string;
  readonly dashboard: string;
  readonly verdict: "same" | "different";
}

const findings: Finding[] = [];
const notes: string[] = [];

/** Credential-bearing fields whose values were blanked before writing — reported at the end. */
const redactedFields = new Set<string>();

function record(
  topic: string,
  onboarding: string,
  dashboard: string,
  verdict: "same" | "different",
): void {
  findings.push({ topic, onboarding, dashboard, verdict });
  const tag =
    verdict === "same" ? paint("ok", "SAME     ") : paint("warn", "DIFFERENT");
  console.log(`  ${tag} ${topic}`);
  console.log(`            onboarding: ${onboarding}`);
  console.log(`            dashboard:  ${dashboard}`);
}

/**
 * Runs one optional capture step, turning a failure into a note instead of losing the whole run.
 *
 * Reserved for panels that enrich a fixture rather than define it: re-capturing everything else is
 * expensive (the onboarding phase runs a real backup), so one flaky header control must not cost it.
 */
async function openBestEffort(
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    const first = (
      error instanceof Error ? error.message : String(error)
    ).split("\n")[0];
    notes.push(`could not open ${label}: ${first ?? "unknown error"}`);
    console.log(
      `  ${paint("warn", "skipped")} ${label} ${symbol("dash")} ${first ?? ""}`,
    );
  }
}

/**
 * Clicks a panel trigger and waits for the panel it should open.
 *
 * `force` is deliberate. Right after onboarding the dashboard is still settling — admin notices and
 * nudges insert above the header, and the open sidebar toggles `body.overflow-hidden`, which removes
 * the scrollbar and reflows the page — so Playwright's stability check can spin until it times out on
 * a button that is perfectly clickable. Skipping that check is safe **because the outcome is asserted**:
 * if the click misses, the panel never appears and this throws anyway. A product test should never do
 * this; a capture tool, whose job is to reach a state rather than to prove clickability, should.
 */
async function openPanel(
  trigger: Locator,
  panelSelector: string,
): Promise<void> {
  const page = trigger.page();
  await page.waitForLoadState("networkidle").catch(() => undefined);
  await trigger.click({ force: true });
  await page
    .locator(panelSelector)
    .waitFor({ state: "visible", timeout: TIMEOUT });
  // A visible article is NOT proof the sidebar opened. Closing parks the whole aside off-screen with
  // `translate-x-[450px]`, and a translated element still reports a bounding box — so every article
  // inside it keeps passing `toBeVisible()` while being unreachable. Being in the viewport is the only
  // honest "the sidebar is open" signal, and without it the next click fails far away with
  // "element is outside of the viewport".
  await expect(page.locator("#backwpup-sidebar")).toBeInViewport({
    timeout: TIMEOUT,
  });
}

/**
 * Prints a step's title, after a blank line.
 *
 * @param message - what the capture does next.
 */
function step(message: string): void {
  console.log(`\n${paint("id", `${symbol("current")} ${message}`)}`);
}

// ── WP-CLI helpers ───────────────────────────────────────────────────────────────

/** Runs WP-CLI and throws on a non-zero exit, since `wpCli` reports failure in the result. */
async function wp(transport: Transport, args: string[]): Promise<string> {
  const result = await wpCli(transport, args);
  if (result.exitCode !== 0) {
    throw new Error(
      `[capture] wp ${args.join(" ")} failed (exit ${String(result.exitCode)}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

/** Runs WP-CLI and returns null instead of throwing — for reads that may legitimately be unset. */
async function wpMaybe(
  transport: Transport,
  args: string[],
): Promise<string | null> {
  const result = await wpCli(transport, args);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

// ── Capture + sanitisation ───────────────────────────────────────────────────────

/**
 * Extracts one container's `outerHTML` with `<svg>`/`<script>`/`<style>` removed.
 *
 * The strip happens on a **clone inside the page**, not by regex afterwards: `<svg>` subtrees nest
 * and carry arbitrary attributes, so a regex would either miss cases or eat real markup. The live DOM
 * is left untouched, so capturing does not disturb the state the next capture depends on.
 */
async function grabContainer(page: Page, selector: string): Promise<string> {
  const target = page.locator(selector);
  if ((await target.count()) === 0) {
    throw new Error(`[capture] "${selector}" is not present on ${page.url()}`);
  }
  const result = await target.first().evaluate((element) => {
    const clone = element.cloneNode(true) as Element;
    clone.querySelectorAll("svg, script, style").forEach((node) => {
      node.remove();
    });

    // Redact anything credential-shaped. This matters here and not on most pages: a storage panel
    // renders the provider's saved settings straight into `value` attributes — `storage-FTP.php`
    // even runs `BackWPup_Encryption::decrypt()` on `ftppass` first — so a capture of a configured
    // job would otherwise commit live credentials to a tracked file.
    // `db_*`: the restore wizard's database step renders the site's connection settings as values.
    const SECRET =
      /pass|secret|key|token|licen[cs]e|auth|ftpuser|ftphost|db_(?:host|name|user)/i;
    // Fields whose names merely *contain* a trigger word but hold nothing sensitive. Without this,
    // `ftphostport` (the FTP port, "21") gets blanked purely because it contains "host".
    const BENIGN = /port|timeout|maxbackups|nodelete|dir$/i;
    const redacted: string[] = [];
    clone.querySelectorAll("input, textarea").forEach((field) => {
      const name = `${field.getAttribute("name") ?? ""} ${field.getAttribute("id") ?? ""}`;
      const isSecret =
        field.getAttribute("type") === "password" || SECRET.test(name);
      if (!isSecret || BENIGN.test(name)) return;
      if ((field.getAttribute("value") ?? "") !== "") {
        field.setAttribute("value", "REDACTED");
        redacted.push(name.trim());
      }
      // A <textarea> carries its value as text, not as an attribute.
      if (field.tagName === "TEXTAREA" && field.textContent !== "") {
        field.textContent = "REDACTED";
        redacted.push(`${name.trim()} (text)`);
      }
    });
    return { html: clone.outerHTML, redacted };
  });
  for (const field of result.redacted) redactedFields.add(field);
  return result.html;
}

/**
 * Replaces the per-capture noise — the host, nonces and auth keys, the restore directory's token — then
 * refuses to emit anything still nonce- or token-shaped.
 *
 * WordPress nonces rotate per user and per session, so leaving them in would make every re-capture a
 * noisy diff — and would commit a (short-lived) credential. The final scan is the safety net: it is
 * better to fail the capture than to write a real nonce into a tracked file.
 */
function sanitise(html: string, host: string): string {
  const escapedHost = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let out = html.replace(new RegExp(escapedHost, "g"), HOST_PLACEHOLDER);

  // Any key whose name mentions a nonce or an auth key, plus BackWPup's own `*_action=<hex>` download
  // tokens. Two things this pattern has to get right, both learned from a leak this file's own guard
  // caught:
  //  - **Not anchored on `?`/`&`**: inside an HTML attribute the separator is the entity `&amp;`, so an
  //    anchored pattern silently misses every parameter after the first.
  //  - **A length range, not `{10}`**: WordPress nonces are 10 hex chars, but BackWPup's job-run auth
  //    key is 32 (`wp-cron.php?_nonce=<jobrunauthkey>` — the link that lets anyone trigger the job), and
  //    `{10}\b` cannot match the head of a 32-char token because the boundary never lands there.
  out = out.replace(
    /([\w-]*(?:nonce|authkey)[\w-]*=["']?)[0-9a-f]{8,64}\b/gi,
    `$1${NONCE_PLACEHOLDER}`,
  );
  out = out.replace(
    /(backwpup[\w-]*action=["']?)[0-9a-f]{8,64}\b/gi,
    `$1${NONCE_PLACEHOLDER}`,
  );
  out = out.replace(
    /backwpup-restore-[0-9a-f]{20}(?![0-9a-f])/g,
    RESTORE_DIR_PLACEHOLDER,
  );
  const token = out.match(/backwpup-restore-(?!0{20}\b)[0-9a-f]{20}/g);
  if (token !== null) {
    throw new Error(
      "[capture] refusing to write a capture naming a restore directory's token.",
    );
  }

  const leaked = out.match(
    /[\w-]*(?:nonce|authkey)[\w-]*=["']?(?!0{10}\b)[0-9a-f]{8,64}\b/gi,
  );
  if (leaked !== null) {
    throw new Error(
      `[capture] refusing to write a capture with un-sanitised nonces: ${[...new Set(leaked)].join(", ")}`,
    );
  }
  return out;
}

async function writeFixture(
  name: string,
  html: string,
  host: string,
): Promise<void> {
  await mkdir(FIXTURES_DIR, { recursive: true });
  const path = `${FIXTURES_DIR}/${name}`;
  await writeFile(path, `${sanitise(html, host)}\n`, "utf8");
  const lines = html.split("\n").length;
  console.log(`  ${paint("ok", "wrote")} ${path} (${String(lines)} lines)`);
}

// ── DOM probes used for the onboarding-vs-dashboard comparison ───────────────────

/** How many element children a container has — 0 proves an "empty shell". */
async function childCount(page: Page, selector: string): Promise<number> {
  const target = page.locator(selector);
  if ((await target.count()) === 0) return -1;
  return target.first().evaluate((element) => element.children.length);
}

/** The `value`s a `<select>` offers, in render order. */
async function optionValues(select: Locator): Promise<string[]> {
  if ((await select.count()) === 0) return [];
  return select
    .first()
    .evaluate((element) =>
      [...(element as HTMLSelectElement).options].map((option) => option.value),
    );
}

/** Describes a container as "absent", "empty shell" or "populated (N children)". */
async function describeContainer(
  page: Page,
  selector: string,
): Promise<string> {
  const count = await childCount(page, selector);
  if (count === -1) return `${selector} absent`;
  if (count === 0) return `${selector} present but EMPTY`;
  return `${selector} populated (${String(count)} children)`;
}

// ── Onboarding phase ─────────────────────────────────────────────────────────────

interface OnboardingObservations {
  readonly selectFiles: string;
  readonly selectTables: string;
  readonly storages: string;
  readonly frequencyOptions: string[];
  readonly storageTileShape: string;
}

async function captureOnboarding(
  page: Page,
  site: SiteInput,
): Promise<OnboardingObservations> {
  step("Onboarding page");
  await page.goto("/wp-admin/admin.php?page=backwpuponboarding");
  await page
    .getByRole("heading", { name: "Ready to set up your first backup?" })
    .waitFor({ timeout: TIMEOUT });

  // Panels onboarding renders server-side need no interaction; this proves which those are.
  const selectFiles = await describeContainer(page, "#sidebar-select-files");
  const selectTables = await describeContainer(page, "#sidebar-select-tables");
  const storages = await describeContainer(page, "#sidebar-storages");
  console.log(`  at first paint: ${selectFiles}`);
  console.log(`  at first paint: ${selectTables}`);
  console.log(`  at first paint: ${storages}`);

  await writeFixture(
    "onboarding.html",
    await grabContainer(page, "#wpbody-content"),
    new URL(site.baseURL).host,
  );

  // Step 2 holds the advanced-frequency trigger; open it so the capture carries a loaded
  // #sidebar-frequency, and read back which intervals onboarding offers.
  const pane2 = page.locator(
    '#backwpup-onboarding-panes article[data-step="2"]',
  );
  await page
    .locator('#backwpup-onboarding-panes article[data-step="1"]')
    .locator(".js-backwpup-onboarding-step-2")
    .click();
  await pane2.waitFor({ state: "visible", timeout: TIMEOUT });
  await pane2
    .locator('.js-backwpup-load-and-open-sidebar[data-content="frequency"]')
    .first()
    .click();
  await page
    .locator("#sidebar-frequency .js-backwpup-frequency-job")
    .waitFor({ timeout: TIMEOUT });
  const frequencyOptions = await optionValues(
    page.locator("#sidebar-frequency .js-backwpup-frequency-job"),
  );
  console.log(`  frequency options: ${frequencyOptions.join(", ")}`);
  await page
    .locator("#sidebar-frequency .js-backwpup-close-sidebar")
    .first()
    .click();

  // Step 3's storage tiles. During onboarding these are `onboarding/storage-item.php`, one button that
  // *is* the toggle and contains the checkbox; the dashboard uses a two-button variant.
  await pane2.locator(".js-backwpup-onboarding-step-3").click();
  const pane3 = page.locator(
    '#backwpup-onboarding-panes article[data-step="3"]',
  );
  await pane3.waitFor({ state: "visible", timeout: TIMEOUT });
  const storageTileShape = await describeStorageTiles(pane3);
  console.log(`  storage tiles: ${storageTileShape}`);

  // Open a couple of provider panels so the capture carries real per-provider markup.
  for (const slug of ["FOLDER", "FTP", "S3"]) {
    const tile = pane3.locator(
      `button.js-backwpup-toggle-storage[data-storage="${slug}"]`,
    );
    if ((await tile.count()) === 0) {
      notes.push(`onboarding: no storage tile for ${slug}`);
      continue;
    }
    await tile.click();
    await page
      .locator(`#sidebar-storage-${slug}`)
      .waitFor({ state: "visible", timeout: TIMEOUT });
    await page
      .locator(`#sidebar-storage-${slug} .js-backwpup-close-sidebar`)
      .first()
      .click()
      .catch(() => undefined);
  }

  await writeFixture(
    "sidebars-onboarding.html",
    await grabAsideAndModal(page),
    new URL(site.baseURL).host,
  );

  return {
    selectFiles,
    selectTables,
    storages,
    frequencyOptions,
    storageTileShape,
  };
}

/**
 * Finishes onboarding for real, rather than just clearing the option behind its back.
 *
 * The dashboard will not list the job the installer creates while it is still flagged `tempjob`
 * (`class-install.php:191`) — deleting `backwpup_onboarding` by hand yields a dashboard with **no job
 * cards**, and therefore no "Data"/"Frequency"/"Storage" links to capture. Completing onboarding is
 * what promotes that job, so the dashboard capture depends on going through it.
 *
 * `FOLDER` (Website Server) is the destination used because it needs no credentials.
 */
async function completeOnboarding(
  page: Page,
  site: SiteInput,
  transport: Transport,
): Promise<void> {
  step("Completing onboarding");
  // Reload first: a provider sub-panel's close control is inert (see StorageSidebar's note), so the
  // aside can still be covering the onboarding page after the capture above.
  await page.goto("/wp-admin/admin.php?page=backwpuponboarding");
  const pane1 = page.locator(
    '#backwpup-onboarding-panes article[data-step="1"]',
  );
  await pane1.waitFor({ state: "visible", timeout: TIMEOUT });
  await pane1.locator(".js-backwpup-onboarding-step-2").click();
  const pane2 = page.locator(
    '#backwpup-onboarding-panes article[data-step="2"]',
  );
  await pane2.waitFor({ state: "visible", timeout: TIMEOUT });
  await pane2.locator(".js-backwpup-onboarding-step-3").click();
  const pane3 = page.locator(
    '#backwpup-onboarding-panes article[data-step="3"]',
  );
  await pane3.waitFor({ state: "visible", timeout: TIMEOUT });

  // Choosing a destination is two steps: open its settings, then save them. The plugin ticks the
  // hidden checkbox itself once the save succeeds, which is the only honest "selected" signal.
  await pane3
    .locator('button.js-backwpup-toggle-storage[data-storage="FOLDER"]')
    .click();
  await page
    .locator("#sidebar-storage-FOLDER")
    .waitFor({ state: "visible", timeout: TIMEOUT });
  await page
    .locator("#sidebar-storage-FOLDER .js-backwpup-test-FOLDER-storage")
    .click();
  await expect(page.locator("#destination-FOLDER")).toBeChecked({
    timeout: TIMEOUT,
  });

  const submit = pane3.locator(".js-backwpup-onboarding-submit-form");
  await expect(submit).toBeEnabled({ timeout: TIMEOUT });
  await submit.click();
  await expect(page.locator("#backwpup-onboarding-form")).toHaveCount(0, {
    timeout: TIMEOUT,
  });

  // The screen onboarding hands over to, captured at its **first** render — the state a scenario
  // meets, with the progress region on show and `#first-congratulations` still behind its inline
  // `display: none`. It has to be grabbed now rather than after a wait: that first render posts
  // `startbackup` and reloads half a second later, and if the backup has already finished by then
  // the reloaded page is redirected to the dashboard instead. Best-effort for the same reason — a
  // capture lost to that race is a note, not a failed run.
  try {
    await expect(page.locator("#wpbody-content")).toBeVisible({
      timeout: TIMEOUT,
    });
    await writeFixture(
      "first-backup.html",
      await grabContainer(page, "#wpbody-content"),
      new URL(site.baseURL).host,
    );
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    notes.push(
      `first-backup.html not captured — the page moved on first (${reason.split("\n", 1).join("")})`,
    );
  }

  // The plugin deletes the option on save; assert that rather than assuming it.
  const stillOnboarding = await wpMaybe(transport, [
    "option",
    "get",
    "backwpup_onboarding",
  ]);
  if (stillOnboarding !== null) {
    notes.push(
      `onboarding option survived submit (value ${stillOnboarding}) — deleting it explicitly`,
    );
    await wp(transport, ["option", "delete", "backwpup_onboarding"]);
  } else {
    console.log("  backwpup_onboarding deleted by the plugin, as expected");
  }
}

/** Reports whether a storage toggle contains its own checkbox, and how many buttons a tile has. */
async function describeStorageTiles(scope: Locator): Promise<string> {
  const toggles = scope.locator(
    'button.js-backwpup-toggle-storage[data-storage="FOLDER"]',
  );
  if ((await toggles.count()) === 0) return "no FOLDER toggle found";
  const holdsCheckbox =
    (await toggles.first().locator("#destination-FOLDER").count()) > 0;
  const selectButtons = await scope
    .locator('button.js-backwpup-select-storage[data-storage="FOLDER"]')
    .count();
  return `js-backwpup-toggle-storage ${holdsCheckbox ? "CONTAINS" : "does NOT contain"} #destination-FOLDER; js-backwpup-select-storage buttons: ${String(selectButtons)}`;
}

/** The two containers every sidebar and modal lives in, concatenated as one fixture. */
async function grabAsideAndModal(page: Page): Promise<string> {
  const aside = await grabContainer(page, "#backwpup-sidebar");
  const modal = await grabContainer(page, "#backwpup-modal").catch(
    () => "<!-- #backwpup-modal absent on this screen -->",
  );
  return `${aside}\n${modal}`;
}

// ── Dashboard phase ──────────────────────────────────────────────────────────────

interface DashboardObservations {
  readonly selectFilesShell: string;
  readonly filesPaneNested: string;
  readonly frequencyOptions: string[];
  readonly storages: string;
  readonly storageTileShape: string;
}

async function captureDashboard(
  page: Page,
  site: SiteInput,
): Promise<DashboardObservations> {
  step("Dashboard");
  // Retried once, because we arrive here straight off the first-backup screen and that page has a
  // navigation of its own in flight — it posts `startbackup` and then either reloads or is
  // redirected to the dashboard. A `goto` that collides with it is aborted (`ERR_ABORTED`) rather
  // than failing on anything about the destination, so the second attempt simply succeeds.
  try {
    await page.goto("/wp-admin/admin.php?page=backwpup");
  } catch {
    await page.goto("/wp-admin/admin.php?page=backwpup");
  }
  await page
    .getByRole("heading", { name: "Next Scheduled Backups" })
    .waitFor({ timeout: TIMEOUT });

  /**
   * Let the backup onboarding kicked off finish before touching anything.
   *
   * Submitting onboarding starts a run immediately, and while it runs the dashboard polls and
   * re-renders the job cards — so every card link is a moving target and Playwright rightly refuses to
   * click one as "not stable". Waiting here is also what keeps `dashboard.html` from being a snapshot
   * of a transient mid-run layout. Absence counts as hidden, so this is a no-op when nothing is running.
   */
  const running = page.locator("#runningjob");
  await running.waitFor({ state: "hidden", timeout: RUN_TIMEOUT }).catch(() => {
    notes.push(
      `#runningjob still visible after ${String(RUN_TIMEOUT)}ms — the dashboard may have been captured mid-run`,
    );
  });
  await page.reload();
  await page
    .getByRole("heading", { name: "Next Scheduled Backups" })
    .waitFor({ timeout: TIMEOUT });

  // Read the job id off the rendered card rather than from `backwpup_first_backup_job_id`: the cards
  // arrive from a `getjobslist` fetch after load, and which jobs the list contains is exactly what
  // completing onboarding changes.
  const firstCard = page
    .locator("#backwup-next-scheduled-backups .backwpup-job-card")
    .first();
  await firstCard.waitFor({ timeout: TIMEOUT });
  const cardId = await firstCard.getAttribute("id");
  const jobId = /^backwpup-(\d+)-options$/.exec(cardId ?? "")?.[1];
  if (jobId === undefined) {
    throw new Error(
      `[capture] could not read a job id from the first job card (id="${cardId ?? "null"}")`,
    );
  }
  console.log(`  driving job card ${jobId}`);

  await writeFixture(
    "dashboard.html",
    await grabContainer(page, "#wpbody-content"),
    new URL(site.baseURL).host,
  );

  const card = page.locator(`#backwpup-${jobId}-options`);

  /**
   * Every job-card link ships `disabled` while the job's schedule is off (`job-item.php:175`), and the
   * schedule toggle's own handler flips `disabled` on the card's buttons the moment it changes
   * (`backwpup-admin.js:1239`). So the condition is checked on the **link we need**, not on the toggle:
   * driving off the toggle's state risks turning a working card off, which is exactly what an earlier
   * version of this script did.
   */
  const enableCardLinks = async (): Promise<void> => {
    const dataLink = card.getByRole("button", { name: "Data" });
    if (await dataLink.isEnabled()) return;
    await page.locator(`label[for="next_backup_${jobId}"]`).first().click();
    await expect(page.locator(`#next_backup_${jobId}`).first()).toBeChecked({
      timeout: TIMEOUT,
    });
    await expect(dataLink).toBeEnabled({ timeout: TIMEOUT });
  };
  await enableCardLinks();

  /**
   * Advanced settings goes first, and the order is load-bearing.
   *
   * Every panel loads into the one `#backwpup-sidebar` aside and stays in the DOM afterwards, which is
   * what lets a single capture carry them all. But an *open* aside is a fixed overlay pinned to the
   * right edge, and this trigger lives in the page header underneath it — so clicking it after any
   * panel is open fails with "subtree intercepts pointer events". Everything below is reached either
   * from the job card (left of the aside) or from inside the aside itself, so nothing else collides.
   */
  step(`Dashboard ${ARROW} Advanced settings sidebar`);
  await openBestEffort("advanced-settings", () =>
    openPanel(
      page
        .locator('.js-backwpup-open-sidebar[data-content="advanced-settings"]')
        .filter({ visible: true })
        .first(),
      "#sidebar-advanced-settings",
    ),
  );

  step(`Dashboard ${ARROW} Data sidebar (the chooser)`);
  await openPanel(
    card.getByRole("button", { name: "Data" }),
    "#sidebar-settings-data-type .js-data-main-setting",
  );

  // The claim the page-object fix rests on: the top-level article stays an empty shell here.
  const shell = await describeContainer(page, "#sidebar-select-files");
  const nested = await describeContainer(
    page,
    "#sidebar-settings-data-type .js-file-settings-section",
  );
  console.log(`  ${shell}`);
  console.log(`  ${nested}`);

  // Prove the gear actually reveals the pane, and that the pane's own back arrow shares the attribute.
  const gear = page.locator(
    '#sidebar-settings-data-type .js-data-main-setting [data-toggle-setting-panel="files"]',
  );
  const filesPane = page.locator(
    "#sidebar-settings-data-type .js-file-settings-section",
  );
  const hiddenBefore = !(await filesPane.isVisible());
  await openPanel(
    gear.first(),
    "#sidebar-settings-data-type .js-file-settings-section",
  );
  const unscopedToggles = await page
    .locator('[data-toggle-setting-panel="files"]')
    .count();
  notes.push(
    `dashboard: files pane hidden before gear click: ${String(hiddenBefore)}; revealed after: true; unscoped [data-toggle-setting-panel="files"] matches ${String(unscopedToggles)} elements`,
  );
  console.log(
    `  gear reveals files pane: hidden before = ${String(hiddenBefore)}, unscoped toggles = ${String(unscopedToggles)}`,
  );

  // Back to the chooser via the pane's own arrow, then reveal the database pane, so the capture
  // carries both panes loaded and the round trip is proven to work.
  await openPanel(
    filesPane.locator('[data-toggle-setting-panel="files"]').first(),
    "#sidebar-settings-data-type .js-data-main-setting",
  );
  await openPanel(
    page
      .locator(
        '#sidebar-settings-data-type .js-data-main-setting [data-toggle-setting-panel="database"]',
      )
      .first(),
    "#sidebar-settings-data-type .js-database-settings-section",
  );

  step(`Dashboard ${ARROW} Frequency sidebar`);
  await openPanel(
    card.getByRole("button", { name: "Frequency" }),
    "#sidebar-frequency .js-backwpup-frequency-job",
  );
  const dashboardFrequency = await optionValues(
    page.locator("#sidebar-frequency .js-backwpup-frequency-job"),
  );
  console.log(`  frequency options: ${dashboardFrequency.join(", ")}`);

  step(`Dashboard ${ARROW} Storage sidebar (the picker)`);
  await openPanel(
    card.getByRole("button", { name: "Storage" }),
    "#sidebar-storages",
  );
  const dashboardStorages = await describeContainer(page, "#sidebar-storages");
  const dashboardTiles = await describeStorageTiles(
    page.locator("#sidebar-storages"),
  );
  console.log(`  ${dashboardStorages}`);
  console.log(`  storage tiles: ${dashboardTiles}`);

  // One provider panel, fetched per job on this screen (unlike onboarding's pre-rendered panels).
  const ftpTrigger = page
    .locator('#sidebar-storages [data-content="storage-FTP"]')
    .first();
  if ((await ftpTrigger.count()) > 0) {
    await openBestEffort("storage-FTP", () =>
      openPanel(ftpTrigger, "#sidebar-storage-FTP"),
    );
  }

  // Re-open the Data sidebar last, so the panel showing in the capture is the one this work is about.
  await openPanel(
    card.getByRole("button", { name: "Data" }),
    "#sidebar-settings-data-type .js-data-main-setting",
  );

  await writeFixture(
    "sidebars-dashboard.html",
    await grabAsideAndModal(page),
    new URL(site.baseURL).host,
  );

  return {
    selectFilesShell: shell,
    filesPaneNested: nested,
    frequencyOptions: dashboardFrequency,
    storages: dashboardStorages,
    storageTileShape: dashboardTiles,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────────

/**
 * Captures the restore wizard's steps 2–6, by restoring the newest backup's **database** through Pro's
 * deep link — the strategy that walks every step (3, the connection; 4, the migration; 5, start) — so
 * the wizard's page object is held to the markup it really drives.
 *
 * Each step replaces the page with the next (`location.replace`), so each is captured once its URL
 * says it has arrived. The backup is made here, after the login: a database restore keeps only the
 * sessions its dump knows, so an older backup would end this one before the last step. The restore's
 * working directory is opened to the web server first, as the `@plugin` hook and the restore steps
 * do: WP-CLI may have created it, and every wizard request writes there.
 */
async function captureRestore(
  page: Page,
  site: SiteInput,
  transport: Transport,
): Promise<void> {
  step("Restore wizard");
  const host = new URL(site.baseURL).host;
  await runScheduledBackup(transport);
  await prepareResolvedDataDirs(
    transport,
    await resolveRestoreWorkingDirs(transport),
    BACKWPUP_SITE_RESIDUE,
  );
  await handRestoreWorkingDirToSite(transport);

  await page.goto("/wp-admin/admin.php?page=backwpup");
  const history = new BackupHistoryTable(page);
  await history.waitForLoaded();
  // The page object's own watch, so a failing wizard fails the capture at once rather than after
  // RUN_TIMEOUT; the clicks themselves are spelled out here because each step is captured between.
  const watch = new WizardWatch(page);
  await new ProRestorePage(page).startFrom(history.newestRow);

  /** Waits for step `n` and its card, failing as soon as the wizard's traffic does. */
  const atStep = async (n: number): Promise<void> => {
    await Promise.race([
      page.waitForURL((url) => url.searchParams.get("step") === String(n), {
        timeout: RUN_TIMEOUT,
      }),
      watch.failed,
    ]);
    await page.locator("#bwpr-action-card").waitFor({ timeout: TIMEOUT });
  };
  /** The step's action card, as captured. */
  const card = (): Promise<string> => grabContainer(page, "#bwpr-action-card");

  await atStep(2);
  await writeFixture("restore-step2.html", await card(), host);
  await page
    .locator("#restore_step")
    .getByRole("button", { name: "Database Only", exact: true })
    .click();
  await atStep(3);
  await writeFixture("restore-step3.html", await card(), host);
  await page
    .locator("#db-settings-form")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await atStep(4);
  await writeFixture("restore-step4.html", await card(), host);
  await page
    .locator("#migration-settings-form")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await atStep(5);
  await writeFixture("restore-step5.html", await card(), host);
  await page
    .locator("#restore_step")
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await Promise.race([
    page.waitForURL((url) => url.searchParams.get("step") === "6", {
      timeout: RUN_TIMEOUT,
    }),
    watch.failed,
  ]);
  await page.getByRole("heading", { name: "Success", exact: true }).waitFor({
    timeout: TIMEOUT,
  });
  await writeFixture(
    "restore-step6.html",
    await grabContainer(page, ".bwpr-content"),
    host,
  );
}

async function main(): Promise<void> {
  const cell = backwpup.sites[CELL];
  const site = cell?.sites[SITE_INDEX];
  if (site === undefined) {
    throw new Error(
      `[capture] no site at ${CELL}[${String(SITE_INDEX)}] — cells: ${Object.keys(backwpup.sites).join(", ")}`,
    );
  }
  const { transport } = site;
  console.log(RULE);
  console.log(
    `BackWPup fixture capture ${ARROW} ${site.baseURL}  (cell ${CELL})`,
  );
  console.log(RULE);

  if (!SKIP_INSTALL) {
    step(`Installing ${basename(PLUGIN_ZIP)}`);
    // Remove the DB footprint first, not just the files. A `force` install overwrites the plugin
    // but leaves every option it wrote, so a site that has been driven before hands the capture a
    // job carrying *those* settings — and the fixture then records, say, "Plugins unchecked" as if
    // it were the shape of a new install. The whole value of these fixtures is that they describe
    // the plugin rather than the site, so the install has to be genuinely fresh.
    await ensurePluginAbsent(transport, "backwpup-pro");
    await ensurePluginAbsent(transport, "backwpup");
    await stageAndInstallPlugin(transport, PLUGIN_ZIP, {
      activate: true,
      force: true,
    });
  }
  const version = await wpMaybe(transport, [
    "plugin",
    "get",
    "backwpup-pro",
    "--field=version",
  ]);
  const freeVersion =
    version === null
      ? await wpMaybe(transport, [
          "plugin",
          "get",
          "backwpup",
          "--field=version",
        ])
      : null;
  const activeVersion = version ?? freeVersion ?? "unknown";
  // The wizard is captured from Pro: Free has neither the deep link nor the migration step.
  const pro = version !== null;
  if (RESTORE_ONLY && !pro) {
    throw new Error(
      "[capture] CAPTURE_RESTORE_ONLY needs BackWPup Pro active — the wizard is captured from Pro's deep link.",
    );
  }
  console.log(`  active plugin version: ${activeVersion}`);
  notes.push(`captured from BackWPup ${activeVersion} on ${site.baseURL}`);

  const jobId = await wpMaybe(transport, [
    "option",
    "get",
    "backwpup_first_backup_job_id",
  ]);
  if (jobId === null) {
    throw new Error(
      "[capture] backwpup_first_backup_job_id is unset — activation should have created the first job",
    );
  }
  console.log(`  first backup job id: ${jobId}`);

  if (!SKIP_ONBOARDING && !RESTORE_ONLY) {
    step("Re-entering onboarding");
    await wp(transport, ["option", "update", "backwpup_onboarding", "1"]);
  }

  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: !HEADED });
    const context = await browser.newContext({ baseURL: site.baseURL });
    context.setDefaultTimeout(TIMEOUT);
    const page = await context.newPage();
    await loginViaUi(page, site, { timeoutMs: TIMEOUT });

    if (RESTORE_ONLY) {
      await captureRestore(page, site, transport);
      await context.close();
      return;
    }

    const onboarding = SKIP_ONBOARDING
      ? null
      : await captureOnboarding(page, site);
    if (!SKIP_ONBOARDING) await completeOnboarding(page, site, transport);

    const dashboard = await captureDashboard(page, site);

    // ── The comparison the report exists for ──
    if (onboarding === null) {
      notes.push(
        "onboarding phase skipped (CAPTURE_SKIP_ONBOARDING) — no comparison performed",
      );
    } else {
      step("Onboarding vs dashboard");
      const same = (a: string, b: string): "same" | "different" =>
        a === b ? "same" : "different";
      record(
        "Select Files pane root",
        onboarding.selectFiles,
        `${dashboard.selectFilesShell}; content lives at ${dashboard.filesPaneNested}`,
        "different",
      );
      record(
        "Select Tables pane root",
        onboarding.selectTables,
        "nested in #sidebar-settings-data-type .js-database-settings-section",
        "different",
      );
      record(
        "Frequency sidebar root",
        "#sidebar-frequency (fetched via getblock)",
        "#sidebar-frequency (fetched via getblock)",
        "same",
      );
      record(
        "Frequency intervals offered",
        onboarding.frequencyOptions.join(", "),
        dashboard.frequencyOptions.join(", "),
        same(
          onboarding.frequencyOptions.join(","),
          dashboard.frequencyOptions.join(","),
        ),
      );
      record(
        "Storage picker (#sidebar-storages)",
        onboarding.storages,
        dashboard.storages,
        same(onboarding.storages, dashboard.storages),
      );
      record(
        "Storage tile markup",
        onboarding.storageTileShape,
        dashboard.storageTileShape,
        same(onboarding.storageTileShape, dashboard.storageTileShape),
      );
    }

    if (!SKIP_RESTORE && pro) await captureRestore(page, site, transport);
    if (!SKIP_RESTORE && !pro) {
      notes.push(
        "restore wizard skipped — it is captured from Pro, whose deep link and migration step Free lacks",
      );
    }

    await context.close();
  } finally {
    if (browser !== null) await browser.close();
    disposeConnections();
  }

  console.log(`\n${RULE}`);
  console.log("Findings");
  console.log(RULE);
  for (const finding of findings) {
    console.log(
      `${finding.verdict === "same" ? "=" : symbol("notEqual")} ${finding.topic}\n    onboarding: ${finding.onboarding}\n    dashboard:  ${finding.dashboard}`,
    );
  }
  if (redactedFields.size > 0) {
    console.log("\nRedacted before writing (credential-shaped fields)");
    for (const field of [...redactedFields].sort()) console.log(`  - ${field}`);
  }
  console.log("\nNotes");
  for (const note of notes) console.log(`  - ${note}`);
}

await main();
