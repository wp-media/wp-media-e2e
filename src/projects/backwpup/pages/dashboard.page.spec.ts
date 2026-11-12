import { test, expect } from "@playwright/test";
import type { Page, Route } from "@playwright/test";

import { DashboardPage, classifyGotoFailure } from "./dashboard.page";

/**
 * `DashboardPage.goto` when a screen sends itself to the dashboard at the moment the step navigates
 * there (the first-backup screen as its job ends): Playwright fails the `goto` as interrupted, and
 * only a navigation to the dashboard itself may stand in for it. Reproduced in a real browser
 * against a routed, fake site, deterministically: the step's request is held until the page's own
 * script has navigated.
 */

/** The fake site's origin; nothing is fetched from the network. */
const ORIGIN = "http://bwp-dashboard.test";

/** Where the page starts: a screen that, like the first-backup screen, may move on by itself. */
const START = `${ORIGIN}/wp-admin/admin.php?page=backwpupfirstbackup`;

/** Playwright's message for an interrupted `goto`, as `page.goto` throws it. */
const interrupted = (to: string): Error =>
  new Error(
    `page.goto: Navigation to "${ORIGIN}/wp-admin/admin.php?page=backwpup" is interrupted by ` +
      `another navigation to "${to}"`,
  );

test.describe("classifyGotoFailure", () => {
  test("reads where an interrupting navigation went", () => {
    expect(classifyGotoFailure(interrupted(START))).toEqual({
      kind: "interrupted",
      to: START,
    });
  });

  test("tells a navigation cancelled before it committed", () => {
    expect(
      classifyGotoFailure(
        new Error(
          `page.goto: net::ERR_ABORTED at ${ORIGIN}/wp-admin/admin.php?page=backwpup`,
        ),
      ),
    ).toEqual({ kind: "aborted" });
  });

  test("is other for any other error, or a thrown non-error", () => {
    for (const error of [
      new Error("page.goto: net::ERR_CONNECTION_REFUSED"),
      new Error("page.goto: net::ERR_ABORTED_SOMETHING"),
      new Error("page.goto: Timeout 30000ms exceeded."),
      `is interrupted by another navigation to "${START}"`,
      undefined,
    ]) {
      expect(classifyGotoFailure(error)).toEqual({ kind: "other" });
    }
  });
});

test.describe("DashboardPage.goto", () => {
  /**
   * Serves the fake site: the start screen, and the dashboard — whose first request (the step's) is
   * never answered: while it is in flight the start screen navigates itself to `selfTo`, taking
   * over the step's navigation as the first-backup screen's redirect does. A click on a link does it:
   * Chromium lets a page's own navigation cancel a pending `goto` only with a user gesture, so a
   * plain `location.href` from `evaluate` is ignored at random (measured).
   *
   * @param page - the browser page.
   * @param selfTo - where the start screen sends itself, relative to the site.
   * @returns how many times the dashboard was requested.
   */
  async function serve(page: Page, selfTo: string): Promise<() => number> {
    let requests = 0;
    await page.route(`${ORIGIN}/**`, async (route: Route) => {
      const url = route.request().url();
      if (url === START) {
        await route.fulfill({
          contentType: "text/html",
          body:
            "<title>First backup</title>" +
            `<a href="${selfTo}" style="position:fixed;inset:0">First backup</a>`,
        });
        return;
      }
      requests += 1;
      if (requests === 1) {
        // Left unanswered: the browser drops it once the screen's own navigation takes over.
        page.mouse.click(5, 5).catch(() => undefined);
        return;
      }
      await route.fulfill({
        contentType: "text/html",
        body: "<title>Dashboard</title><h1>Next Scheduled Backups</h1>",
      });
    });
    return () => requests;
  }

  test("waits for the page's own navigation to the dashboard instead of failing", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    try {
      const requests = await serve(page, "/wp-admin/admin.php?page=backwpup");
      await page.goto(START);

      await new DashboardPage(page).goto();

      expect(requests()).toBe(2);
      expect(page.url()).toBe(`${ORIGIN}/wp-admin/admin.php?page=backwpup`);
      await expect(
        page.getByRole("heading", { name: "Next Scheduled Backups" }),
      ).toBeVisible();
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  });

  test("still fails when the page's own navigation goes anywhere but the dashboard", async ({
    browser,
  }) => {
    const context = await browser.newContext({ baseURL: ORIGIN });
    const page = await context.newPage();
    try {
      await serve(page, "/wp-admin/admin.php?page=backwpupfirstbackup");
      await page.goto(START);

      // Either form Playwright reports the takeover in: the message says where, or nothing does and
      // the page never reaches the dashboard.
      await expect(new DashboardPage(page, 2_000).goto()).rejects.toThrow(
        /interrupted by another navigation to "[^"]*page=backwpupfirstbackup"|net::ERR_ABORTED/,
      );
      expect(page.url()).toBe(START);
    } finally {
      await page.unrouteAll({ behavior: "ignoreErrors" });
      await context.close();
    }
  });
});
