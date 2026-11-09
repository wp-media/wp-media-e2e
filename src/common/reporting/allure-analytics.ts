import {
  chmod,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

/**
 * Keeping Allure's reports from phoning home. Allure 3's awesome and dashboard plugins write a
 * Google Tag Manager loader into their `index.html` unconditionally (`analyticsEnable: true` is
 * hard-coded, with no option or variable to turn it off, through Allure 3.22.1), so every report
 * opened online would load Google's script and send its plugin, Allure version and report id. This
 * removes that loader — the exact block the plugins' template renders, and nothing else — from a
 * freshly generated report. Fail-safe: a file where the block is not found exactly once, or that
 * still names the tag manager afterwards, is left as Allure wrote it and named, never half-edited.
 */

/** The text that marks a file as loading the tag manager; checked again after removal. */
export const ANALYTICS_MARKER = "googletagmanager.com";

/**
 * The loader as the plugins' template renders it: Google's script tag, then the inline `gtag` setup
 * whose values are the plugin's name, Allure's version, the report's UUID and the single-file flag.
 * Every line is matched whole, indentation and line end included, so the block goes with its own
 * line breaks and nothing around it changes. The tag id must be the same in both places.
 */
const ANALYTICS_BLOCK = new RegExp(
  [
    String.raw`[ \t]*<script async src="https://www\.googletagmanager\.com/gtag/js\?id=(G-[A-Z0-9]{4,16})"></script>\n`,
    String.raw`[ \t]*<script>\n`,
    String.raw`[ \t]*window\.dataLayer = window\.dataLayer \|\| \[\];\n`,
    String.raw`[ \t]*function gtag\(\)\{dataLayer\.push\(arguments\);\}\n`,
    String.raw`[ \t]*gtag\('js', new Date\(\)\);\n`,
    String.raw`[ \t]*gtag\('config', '\1', \{\n`,
    String.raw`[ \t]*"report": "[a-z0-9-]{1,32}",\n`,
    String.raw`[ \t]*"allureVersion": "[0-9A-Za-z.+-]{1,64}",\n`,
    String.raw`[ \t]*"reportUuid": "[0-9a-fA-F-]{1,64}",\n`,
    String.raw`[ \t]*"single_file": "(?:true|false)"\n`,
    String.raw`[ \t]*\}\);\n`,
    String.raw`[ \t]*</script>\n`,
  ].join(""),
  "g",
);

/** What {@link withoutAnalytics} made of one page. */
export type AnalyticsRemoval =
  /** The page never named the tag manager: nothing to do. */
  | { readonly kind: "none" }
  /** The one loader block was removed. */
  | { readonly kind: "removed"; readonly html: string }
  /** The page names the tag manager but not as exactly one known block: left as it is. */
  | { readonly kind: "unrecognised"; readonly blocks: number };

/**
 * A page without Allure's analytics loader. Works on any text; callers pass a file decoded as
 * `latin1`, so every byte comes back as it was.
 *
 * @param html - the page.
 * @returns `none` when it never names the tag manager; `removed` with the page minus the one block;
 *   `unrecognised` (with how many blocks matched) when the block is absent, repeated, or the tag
 *   manager is still named once it is gone — the page must then stay as it is.
 * @example
 * ```ts
 * withoutAnalytics(page); // { kind: "removed", html: "…" }
 * ```
 */
export function withoutAnalytics(html: string): AnalyticsRemoval {
  if (!html.includes(ANALYTICS_MARKER)) return { kind: "none" };
  const blocks = html.match(ANALYTICS_BLOCK)?.length ?? 0;
  if (blocks !== 1) return { kind: "unrecognised", blocks };
  const stripped = html.replace(ANALYTICS_BLOCK, "");
  return stripped.includes(ANALYTICS_MARKER)
    ? { kind: "unrecognised", blocks }
    : { kind: "removed", html: stripped };
}

/** What {@link removeAllureAnalytics} did to a report. */
export interface AnalyticsCleanup {
  /** The pages the loader was removed from, relative to the report (`awesome/index.html`). */
  readonly cleaned: readonly string[];
  /** The pages that name the tag manager but were left as they are (not recognised), relative. */
  readonly left: readonly string[];
}

/**
 * Removes the analytics loader from a generated report's pages: the `*.html` files at its top and one
 * folder down (one per plugin), where Allure writes them. Each changed page is written beside itself
 * and renamed over it, keeping its mode, so it is never half-written. Links are never followed.
 *
 * @param reportDir - the report, freshly generated (not yet in place).
 * @returns which pages were cleaned, and which were left.
 * @throws the filesystem's error when a page cannot be read or written.
 */
export async function removeAllureAnalytics(
  reportDir: string,
): Promise<AnalyticsCleanup> {
  const cleaned: string[] = [];
  const left: string[] = [];
  for (const page of await allureReportPages(reportDir)) {
    const path = join(reportDir, page);
    const original = await readFile(path, "latin1");
    const outcome = withoutAnalytics(original);
    if (outcome.kind === "none") continue;
    if (outcome.kind === "unrecognised") {
      left.push(page);
      continue;
    }
    const beside = `${path}.analytics.tmp`;
    try {
      await writeFile(beside, outcome.html, "latin1");
      await chmod(beside, (await stat(path)).mode & 0o7777);
      await rename(beside, path);
    } finally {
      await rm(beside, { force: true });
    }
    cleaned.push(page);
  }
  return { cleaned, left };
}

/**
 * A report's HTML pages, where Allure writes them: at its top and in each plugin's folder, sorted.
 * Links are never followed.
 *
 * @param reportDir - the report.
 * @returns their paths relative to it, `/`-separated.
 */
export async function allureReportPages(reportDir: string): Promise<string[]> {
  const pages: string[] = [];
  for (const entry of await readdir(reportDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".html")) pages.push(entry.name);
    if (!entry.isDirectory()) continue;
    for (const inner of await readdir(join(reportDir, entry.name), {
      withFileTypes: true,
    })) {
      if (inner.isFile() && inner.name.endsWith(".html")) {
        pages.push(`${entry.name}/${inner.name}`);
      }
    }
  }
  return pages.sort();
}

/**
 * The pages of a report that still name the tag manager: for a report whose cleanup result is not
 * at hand (its generation failed after the report went in). A page that cannot be read is listed
 * too: it cannot be shown clean.
 *
 * @param reportDir - the report.
 * @returns their paths relative to it, sorted; `[]` when the report cannot be listed.
 */
export async function pagesNamingAnalytics(
  reportDir: string,
): Promise<string[]> {
  const pages = await allureReportPages(reportDir).catch(() => []);
  const naming: string[] = [];
  for (const page of pages) {
    const html = await readFile(join(reportDir, page), "latin1").catch(
      () => ANALYTICS_MARKER,
    );
    if (html.includes(ANALYTICS_MARKER)) naming.push(page);
  }
  return naming;
}
