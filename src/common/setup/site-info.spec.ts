import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";

import { createPalette } from "../terminal/palette";
import { describeSiteInfo, parseSiteInfo, readSiteInfo } from "./site-info";

/**
 * The versions a report records, from Site Health's copy text: the parser on a text shaped like
 * WordPress's own (`WP_Debug_Data::format()`, as captured on a live cell — sections with and without
 * counts, list fields on tab-indented lines, the backtick wrapping), the terminal line, and the
 * best-effort read against a mocked wp-admin.
 */

/** A copy text with the shape of a real one; values shortened, paths made up. */
const TEXT = [
  "`",
  "### wp-core ###",
  "",
  "version: 7.1.3",
  "site_language: en_US",
  "multisite: false",
  "",
  "### wp-paths-sizes ###",
  "",
  "wordpress_path: /var/www/html/site",
  "",
  "### wp-active-theme ###",
  "",
  "name: Twenty Twenty-Five (twentytwentyfive)",
  "version: 1.3",
  "",
  "### wp-plugins-active (2) ###",
  "",
  "BackWPup: version: 5.7.7, author: WP Media",
  "Query Monitor: version: 3.20.0, author: John Blackbourn",
  "",
  "### wp-media ###",
  "",
  "image_editor: WP_Image_Editor_Imagick",
  "imagick_limits: ",
  "\timagick::RESOURCETYPE_AREA: 122 GB",
  "\tversion: 9.9.9",
  "",
  "### wp-server ###",
  "",
  "server_architecture: Linux 6.8.0 x86_64",
  "httpd_software: nginx/1.24.0",
  "php_version: 8.5.11 64bit",
  "php_sapi: fpm-fcgi",
  "",
  "### wp-database ###",
  "",
  "extension: mysqli",
  "server_version: 8.0.46-0ubuntu0.24.04.4",
  "client_version: mysqlnd 8.5.11",
  "",
  "`",
].join("\n");

/** Everything {@link TEXT} should yield. */
const VERSIONS = {
  wordpress: "7.1.3",
  php: "8.5.11 64bit",
  phpSapi: "fpm-fcgi",
  webServer: "nginx/1.24.0",
  database: "8.0.46-0ubuntu0.24.04.4",
  databaseExtension: "mysqli",
};

test.describe("parseSiteInfo", () => {
  test("keeps the whitelisted fields, and nothing else", () => {
    expect(parseSiteInfo(TEXT)).toEqual(VERSIONS);
  });

  test("takes a field only from its own section, never a list's tab-indented line", () => {
    // `version` is also the active theme's field, and a line inside wp-media's list: neither is
    // WordPress's version.
    const moved = TEXT.replace("version: 7.1.3\n", "");
    expect(parseSiteInfo(moved).wordpress).toBeUndefined();
  });

  test("reads Windows line endings", () => {
    expect(parseSiteInfo(TEXT.replaceAll("\n", "\r\n"))).toEqual(VERSIONS);
  });

  test("leaves out a field that is missing, empty, or `undefined`", () => {
    const sparse = TEXT.replace("php_sapi: fpm-fcgi", "php_sapi: undefined")
      .replace("httpd_software: nginx/1.24.0", "httpd_software: ")
      .replace("extension: mysqli\n", "");
    const { phpSapi, webServer, databaseExtension, ...rest } = VERSIONS;
    expect([phpSapi, webServer, databaseExtension]).toHaveLength(3);
    expect(parseSiteInfo(sparse)).toEqual(rest);
  });

  test("keeps a field's first value: a later section's text cannot pose as an earlier field", () => {
    const text = [
      "### wp-core ###",
      "version: 7.1.3",
      "### wp-plugins-active (1) ###",
      "Evil: line one",
      "### wp-core ###",
      "version: 1.0-fake",
    ].join("\n");
    expect(parseSiteInfo(text).wordpress).toBe("7.1.3");
  });

  test("removes control characters from a value: the site's text is printed to a terminal", () => {
    const text =
      "### wp-server ###\nhttpd_software: nginx\u001b]0;pwned\u0007/1.24\u001b[2J\u202e";
    expect(parseSiteInfo(text).webServer).toBe("nginx/1.24");
  });

  test("finds nothing in a text that is not Site Health's", () => {
    expect(parseSiteInfo("")).toEqual({});
    expect(parseSiteInfo("version: 7.1.3\nphp_version: 8")).toEqual({});
    expect(parseSiteInfo("<!doctype html><html></html>")).toEqual({});
  });
});

test.describe("describeSiteInfo", () => {
  test("names every version on one line", () => {
    expect(
      describeSiteInfo({ baseURL: "https://a.test", versions: VERSIONS }),
    ).toBe(
      "https://a.test: WordPress 7.1.3 · PHP 8.5.11 64bit (fpm-fcgi) · nginx/1.24.0 · " +
        "database 8.0.46-0ubuntu0.24.04.4 (mysqli)",
    );
  });

  test("says unknown for a missing version, never leaves it blank", () => {
    expect(
      describeSiteInfo({
        baseURL: "https://a.test",
        versions: { wordpress: "7.1.3" },
      }),
    ).toBe(
      "https://a.test: WordPress 7.1.3 · PHP unknown · web server unknown · database unknown",
    );
  });

  test("names the reason when nothing could be read", () => {
    expect(
      describeSiteInfo({ baseURL: "https://a.test", error: "timed out" }),
    ).toBe("https://a.test: versions unknown — timed out");
  });

  test("spells its separators in ASCII with an ASCII palette", () => {
    const ascii = createPalette({ tty: false, color: false, unicode: false });
    expect(
      describeSiteInfo(
        { baseURL: "https://a.test", versions: VERSIONS },
        ascii,
      ),
    ).toBe(
      "https://a.test: WordPress 7.1.3 . PHP 8.5.11 64bit (fpm-fcgi) . nginx/1.24.0 . " +
        "database 8.0.46-0ubuntu0.24.04.4 (mysqli)",
    );
    expect(
      describeSiteInfo(
        { baseURL: "https://a.test", error: "timed out" },
        ascii,
      ),
    ).toBe("https://a.test: versions unknown - timed out");
  });
});

test.describe("readSiteInfo", () => {
  test.use({ baseURL: "http://wp.test" });

  /** Serves the Info tab with `body`. */
  async function serve(page: Page, body: string): Promise<void> {
    await page.route(/site-health\.php/, (route) =>
      route.fulfill({ contentType: "text/html", body }),
    );
  }

  /** The Info tab's copy button, holding `text`. */
  function infoTab(text: string): string {
    const escaped = text
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;");
    return `<!doctype html><html><body>
      <button type="button" class="button copy-button" data-clipboard-text="${escaped}">Copy site info to clipboard</button>
    </body></html>`;
  }

  test("reads the versions of a logged-in site", async ({ page }) => {
    await serve(page, infoTab(TEXT));
    expect(await readSiteInfo(page, "http://wp.test", 5_000)).toEqual({
      baseURL: "http://wp.test",
      versions: VERSIONS,
    });
  });

  test("records why, and never throws, when the page has no copy button", async ({
    page,
  }) => {
    await serve(page, "<!doctype html><html><body>Log in</body></html>");
    const entry = await readSiteInfo(page, "http://wp.test", 500);
    expect(entry).toEqual({
      baseURL: "http://wp.test",
      error: expect.stringMatching(/one 'Copy site info to clipboard' button/),
    });
    // One line: the call log Playwright appends stays out of the report.
    expect("error" in entry && entry.error.includes("\n")).toBe(false);
  });

  test("the page load and the wait for its button share one budget", async ({
    page,
  }) => {
    // A slow page with no button: the wait gets what the load left, not a budget of its own.
    await page.route(/site-health\.php/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 500));
      await route.fulfill({ contentType: "text/html", body: "<p>Slow</p>" });
    });
    const started = Date.now();
    const entry = await readSiteInfo(page, "http://wp.test", 800);
    expect("error" in entry).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_250);
  });

  test("records a text that names no version as an error", async ({ page }) => {
    await serve(page, infoTab("`\n### wp-core ###\n\nsite_language: en_US\n`"));
    expect(await readSiteInfo(page, "http://wp.test", 5_000)).toEqual({
      baseURL: "http://wp.test",
      error: "Site Health's site info named no version",
    });
  });
});

test.describe("readSiteInfo — a site whose URL carries basic-auth credentials", () => {
  const BASE_URL = "http://admin:SECRETPW@wp.test";
  test.use({ baseURL: BASE_URL });

  test("records its URL, and the navigation error quoting it, with the credentials masked", async ({
    page,
  }) => {
    await page.route(/site-health\.php/, (route) => route.abort());
    const entry = await readSiteInfo(page, BASE_URL, 2_000);
    expect(entry).toEqual({
      baseURL: "http://***@wp.test",
      error: expect.stringMatching(
        /^page\.goto: .* at http:\/\/\*\*\*@wp\.test\//,
      ),
    });
    expect(JSON.stringify(entry)).not.toContain("SECRETPW");
  });
});

test.describe("readSiteInfo — a site whose baseURL is no URL", () => {
  test("records the stand-in, never the text", async ({ page }) => {
    await page.route(/./, (route) => route.abort());
    const entry = await readSiteInfo(
      page,
      "https://admin:pa ss-word9@bad host/",
      500,
    );
    expect(entry.baseURL).toBe("(not a valid http(s) URL)");
    expect(JSON.stringify(entry.baseURL)).not.toContain("ss-word9");
  });
});
