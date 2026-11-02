import type { Page } from "@playwright/test";

import { errorMessage } from "../guards";
import { SiteHealthPage } from "../pages/site-health.page";
import { TEXT_PALETTE } from "../terminal/palette";
import type { Palette } from "../terminal/palette";
import { maskSiteUrl, plain, redactSecrets } from "../text";

/**
 * The versions a site actually runs, as its reports record them: WordPress, PHP **as the web server
 * runs it** (WP-CLI's PHP can differ on the same host), the web server, the database.
 *
 * Read from Site Health's "Copy site info" text after the auth setup's login — the same values a
 * person pastes into a support ticket — and kept to a whitelist: the text also holds paths, constants
 * and plugin names, which no report needs. Best-effort: a site whose versions cannot be read is
 * recorded with the reason, and the run goes on.
 */

/** Each version this module keeps, by the Site Health section and field it comes from. */
const FIELDS = {
  wordpress: ["wp-core", "version"],
  php: ["wp-server", "php_version"],
  phpSapi: ["wp-server", "php_sapi"],
  webServer: ["wp-server", "httpd_software"],
  database: ["wp-database", "server_version"],
  databaseExtension: ["wp-database", "extension"],
} as const satisfies Record<string, readonly [string, string]>;

/** Every field {@link FIELDS} reads, as `section.key`: all of the copy text that leaves the page. */
export const SITE_INFO_FIELDS: readonly string[] = Object.values(FIELDS).map(
  ([section, key]) => `${section}.${key}`,
);

/** The versions read from one site; a field Site Health did not report is absent. */
export type SiteVersions = Partial<Record<keyof typeof FIELDS, string>>;

/** One site's entry in the setup's `site-info.json` attachment. */
export type SiteInfoEntry =
  | {
      /** The site, as the sites file names it — its only field a report shows. */
      readonly baseURL: string;
      /** What Site Health reported. */
      readonly versions: SiteVersions;
    }
  | {
      readonly baseURL: string;
      /** Why the versions could not be read: one line. */
      readonly error: string;
    };

/** A section header: `### wp-core ###`, or `### wp-plugins-active (7) ###` with a count. */
const SECTION_HEADER = /^### (\S+)(?: \(\d+\))? ###$/;

/** A field line, at the start of a line: `key: value`. A tab-indented line belongs to the one above. */
const FIELD_LINE = /^([\w-]+): ?(.*)$/;

/**
 * Picks the whitelisted versions out of Site Health's copy text.
 *
 * The text is WordPress's `WP_Debug_Data::format()` output: wrapped in lines of backticks, one
 * `### section ###` block per section, `key: value` lines, and tab-indented lines for a field whose
 * value is a list. WordPress writes `undefined` for an empty value; that is read as absent. A field's
 * **first** value is the one kept — a later section's multi-line value cannot pose as an earlier
 * section's field — and control characters are removed: the value comes from the site under test and
 * is printed to a terminal.
 *
 * @param text - the button's `data-clipboard-text`.
 * @returns the whitelisted fields found; none for a text that is not Site Health's.
 */
export function parseSiteInfo(text: string): SiteVersions {
  const found = new Map<string, string>();
  let section = "";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const header = SECTION_HEADER.exec(line);
    if (header !== null) {
      section = header[1] ?? "";
      continue;
    }
    const field = FIELD_LINE.exec(line);
    if (field === null || section === "") continue;
    const value = (field[2] ?? "").trim();
    const name = `${section}.${field[1] ?? ""}`;
    if (value !== "" && value !== "undefined" && !found.has(name)) {
      found.set(name, plain(value));
    }
  }
  const versions: SiteVersions = {};
  for (const [name, [section, key]] of Object.entries(FIELDS)) {
    const value = found.get(`${section}.${key}`);
    if (value !== undefined) versions[name as keyof typeof FIELDS] = value;
  }
  return versions;
}

/**
 * One line naming a site's versions, for the terminal only (`site-info.json` keeps the entry, not
 * this line): its separators and dash are the palette's, so ASCII under `E2E_OUTPUT=plain`.
 *
 * @param entry - the site's versions, or why they are unknown.
 * @param palette - the symbols of the stream it is printed to; plain Unicode by default.
 * @example
 * ```ts
 * describeSiteInfo(entry);
 * // "https://bwu2.example: WordPress 7.1.3 · PHP 8.5.11 64bit (fpm-fcgi) · nginx/1.24.0 · database 8.0.46 (mysqli)"
 * ```
 */
export function describeSiteInfo(
  entry: SiteInfoEntry,
  palette: Palette = TEXT_PALETTE,
): string {
  const { symbol } = palette;
  if ("error" in entry) {
    return `${entry.baseURL}: versions unknown ${symbol("dash")} ${entry.error}`;
  }
  const v = entry.versions;
  const unknown = "unknown";
  const parts = [
    `WordPress ${v.wordpress ?? unknown}`,
    `PHP ${v.php ?? unknown}${v.phpSapi === undefined ? "" : ` (${v.phpSapi})`}`,
    v.webServer ?? `web server ${unknown}`,
    `database ${v.database ?? unknown}${
      v.databaseExtension === undefined ? "" : ` (${v.databaseExtension})`
    }`,
  ];
  return `${entry.baseURL}: ${parts.join(` ${symbol("separator")} `)}`;
}

/**
 * Reads a logged-in site's versions from Site Health. Never throws: a failure is the entry's
 * `error`, so the versions stay best-effort and never fail the setup that asks. The entry is what the
 * reports keep, so its URL and error have every credential masked — a sites file's URL may carry
 * basic-auth credentials, which a navigation error quotes.
 *
 * @param page - a page logged in to the site, whose context's `baseURL` is the site.
 * @param baseURL - the site's URL, recorded with the result, masked.
 * @param budgetMs - how long the whole read may take: the page load and the wait for its button
 *   share it.
 */
export async function readSiteInfo(
  page: Page,
  baseURL: string,
  budgetMs: number,
): Promise<SiteInfoEntry> {
  const deadline = Date.now() + budgetMs;
  const site = maskSiteUrl(baseURL);
  try {
    const siteHealth = new SiteHealthPage(page);
    await siteHealth.goto({ timeout: budgetMs });
    const versions = parseSiteInfo(
      await siteHealth.siteInfoFields(SITE_INFO_FIELDS, {
        // At least 1 ms: Playwright reads a timeout of 0 as "no limit".
        timeout: Math.max(1, deadline - Date.now()),
      }),
    );
    if (Object.keys(versions).length === 0) {
      return {
        baseURL: site,
        error: "Site Health's site info named no version",
      };
    }
    return { baseURL: site, versions };
  } catch (error) {
    // The first line: Playwright appends a multi-line call log to its messages.
    const message = redactSecrets(
      errorMessage(error).split("\n")[0]?.trim() ?? "",
    );
    return {
      baseURL: site,
      error: message === "" ? "reading Site Health failed" : message,
    };
  }
}
