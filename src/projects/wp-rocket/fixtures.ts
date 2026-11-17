import { createBdd } from "playwright-bdd";

import { test as base } from "../../common/fixtures";
import { AnonymousVisitor } from "./support/visitor";

/**
 * WP Rocket's test instance: the shared one from `common/fixtures.ts` plus this product's scenario
 * state. Extending the shared instance (never importing product code into it) keeps the dependency
 * pointing product → common; playwright-bdd picks the most-extended instance a scenario's steps use,
 * so common and WP Rocket steps mix. This file must be in the product's `steps` config, or generation
 * fails ("Can't guess test instance").
 */
interface WpRocketFixtures {
  /**
   * A visitor who is not logged in, asking the bound site for pages over HTTP (no browser), and the
   * visits made so far — what a page cache serves to the public.
   */
  visitor: AnonymousVisitor;
  /**
   * When this scenario's install of WP Rocket happened (a Unix timestamp, the site's clock), once a
   * step has read it: a cached page dated before it is an earlier run's copy, never this install's.
   */
  pageCache: { installedAt: number | undefined };
}

/** A session with no cookies and no origin storage: a visitor who never logged in. */
const NO_SESSION = { cookies: [], origins: [] };

export const test = base.extend<WpRocketFixtures>({
  // eslint-disable-next-line no-empty-pattern -- Playwright derives deps from this destructuring; this fixture has none.
  pageCache: async ({}, use) => {
    await use({ installedAt: undefined });
  },
  visitor: async ({ playwright, baseURL }, use) => {
    // An empty session given explicitly: inside a test, `playwright.request.newContext` takes the
    // project's `use` options, the scenario's saved login included (measured: the admin bar).
    await use(
      new AnonymousVisitor(() =>
        playwright.request.newContext({ baseURL, storageState: NO_SESSION }),
      ),
    );
  },
});

export const { Given, When, Then, Step, Before, After, BeforeAll, AfterAll } =
  createBdd(test);
