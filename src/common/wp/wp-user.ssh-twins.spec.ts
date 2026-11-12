import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";

import { disposeConnections, exec, installKey, wpCli } from "./exec";
import { resetOwnershipCaches } from "./ownership";
import {
  asTransportUser,
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import { checkWebIdentity } from "./web-identity";
import { resetWpUserCaches } from "./wp-user";
import {
  RESTING_VARIANT,
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  resetTwin,
  sshTwinsEnabled,
  twinSite,
  withTwin,
  type TwinVariant,
} from "../__fixtures__/ssh-twins";
import type { Transport } from "../config/types";

/**
 * `wpCli`'s `--user=<login>` against the twins' real WP-CLI (2.12, PHP 8.5): who WordPress runs as
 * (`get_current_user_id()`) for the site's own admin login in another case and accented, its email in another
 * case, a numeric login read as another user's ID, a numeric login that is its own user's ID too
 * (WP-CLI's warning on every call, avoided), a subscriber, a login naming nobody, and an
 * administrator deleted mid-process (the call retried once without `--user`); the as-today copy
 * runs as nobody. In `legacy-777` (fallback: the SSH user) and `site` (`www-data` through sudo).
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin
 * ({@link withTwin}), resets it, removes the users it made, and puts it back in {@link RESTING_VARIANT}.
 */

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

/** The variants run: one per runner (the SSH user, the site's identity). */
const VARIANTS: readonly TwinVariant[] = ["legacy-777", "site"];

/** Asks WordPress who it runs as. */
const WHO = ["eval", "echo get_current_user_id();"];

/**
 * `transport` with another WordPress login.
 *
 * @param transport - the twin's transport.
 * @param wpUser - the login.
 */
const as = (transport: Transport, wpUser: string): Transport => ({
  ...transport,
  wpUser,
});

/**
 * The user ID WordPress ran `wp eval` as.
 *
 * @param transport - the site, with its login.
 */
async function currentUser(transport: Transport): Promise<string> {
  const result = await wpCli(transport, WHO);
  expect(result.exitCode).toBe(0);
  return result.stdout.trim();
}

/** Warnings printed while `work` runs. */
async function warningsDuring<T>(
  work: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await work(), warnings };
  } finally {
    console.warn = original;
  }
}

/**
 * Creates a user as the site's admin and returns its ID.
 *
 * @param transport - the twin's transport.
 * @param login - its login.
 * @param role - its role.
 */
async function createUser(
  transport: Transport,
  login: string,
  role: string,
): Promise<string> {
  const created = await wpCli(transport, [
    "user",
    "create",
    login,
    `${login}@example.test`,
    `--role=${role}`,
    "--porcelain",
  ]);
  expect(created.exitCode).toBe(0);
  return created.stdout.trim();
}

test.describe("SSH twins: wpCli's --user", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // A reset (~6 s), the web probe, and a dozen remote WP-CLI boots.
  test.setTimeout(240_000);

  test.afterEach(() => {
    disposeConnections();
  });

  for (const twin of CELLS) {
    for (const variant of VARIANTS) {
      test(`${twin.stack} ${variant}: WordPress runs as the site's administrator, or as nobody when the login cannot be used`, async ({
        playwright,
      }) => {
        await withTwin(twin.stack, async () => {
          resetTwin(twin.stack, variant);
          try {
            await checkLogins(twin, variant, playwright.request);
          } finally {
            disposeConnections();
            resetTwin(twin.stack, RESTING_VARIANT);
          }
        });
      });
    }
  }
});

/**
 * Every login case on one freshly reset twin.
 *
 * @param twin - the cell.
 * @param variant - the variant it was reset to.
 * @param request - Playwright's `request`, for the web probe.
 */
async function checkLogins(
  twin: (typeof CELLS)[number],
  variant: TwinVariant,
  request: Parameters<typeof checkWebIdentity>[1],
): Promise<void> {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetWpUserCaches();
  const site = twinSite(twin);
  const { transport } = site;
  registerSiteIdentityVerdicts(
    new Map([[installKey(transport), await checkWebIdentity(site, request)]]),
  );
  const state = await resolveSiteIdentity(transport);
  expect(
    state.kind === "fallback" ? `fallback/${state.reason}` : state.kind,
  ).toBe(variant === "site" ? "site" : "fallback/owner-not-web");

  const suffix = randomBytes(4).toString("hex");
  const subscriber = `e2e-sub-${suffix}`;
  const doomed = `e2e-admin-${suffix}`;
  // The site's own login (`admin`, ID 1 on the twins): every call runs as it.
  expect(transport.wpUser).toBe("admin");
  expect(await currentUser(transport)).toBe("1");
  expect(await currentUser(asTransportUser(transport))).toBe("0");

  const made: string[] = [];
  try {
    const email = await wpCli(transport, [
      "user",
      "get",
      "1",
      "--field=user_email",
    ]);
    expect(
      await currentUser(as(transport, email.stdout.trim().toUpperCase())),
    ).toBe("1");
    // The database's collation, not ours, decides which login names whom.
    expect(await currentUser(as(transport, "ADMIN"))).toBe("1");
    expect(await currentUser(as(transport, "Admín"))).toBe("1");

    const subscriberId = await createUser(transport, subscriber, "subscriber");
    made.push(subscriberId);
    // A login equal to its own ID (the next one): WP-CLI warns, quoting it, on every `--user` call.
    const ownId = String(Number(subscriberId) + 1);
    expect(await createUser(transport, ownId, "administrator")).toBe(ownId);
    made.push(ownId);
    const raw = await exec(transport, "wp", [`--user=${ownId}`, ...WHO]);
    expect(raw.stdout.trim()).toBe(ownId);
    expect(raw.stderr).toContain(
      `Ambiguous user match detected (both ID and user_login exist for identifier '${ownId}')`,
    );
    const own = await warningsDuring(() => wpCli(as(transport, ownId), WHO));
    expect(own.value).toMatchObject({ exitCode: 0, stdout: "0" });
    expect(own.value.stderr).not.toContain("Ambiguous");
    expect(own.warnings).toHaveLength(1);
    expect(own.warnings[0]).toContain("is numeric");
    const doomedId = await createUser(transport, doomed, "administrator");
    made.push(doomedId);

    for (const [login, words] of [
      [subscriber, "not an administrator"],
      [`e2e-nobody-${suffix}`, "names no user"],
      // WP-CLI reads it as user ID 1, whose login is `admin`.
      ["1", "is numeric"],
    ] as const) {
      const { value, warnings } = await warningsDuring(() =>
        currentUser(as(transport, login)),
      );
      expect(value, login).toBe("0");
      expect(warnings, login).toHaveLength(1);
      expect(warnings[0]).toContain(words);
      // "1" is in the endpoint's address; the other logins appear nowhere.
      expect(login === "1" || !(warnings[0] ?? login).includes(login)).toBe(
        true,
      );
    }

    // An administrator removed mid-process: the call is retried once without --user.
    const removable = as(transport, doomed);
    expect(await currentUser(removable)).toBe(doomedId);
    expect(
      (await wpCli(transport, ["user", "delete", doomedId, "--yes"])).exitCode,
    ).toBe(0);
    made.pop();
    const { value, warnings } = await warningsDuring(() =>
      wpCli(removable, WHO),
    );
    expect(value).toMatchObject({ exitCode: 0, stdout: "0" });
    expect(value.stderr).not.toContain(doomed);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("no longer names a user");
    expect(warnings[0]).not.toContain(doomed);
    // The site's own login is untouched by another login's answers.
    expect(await currentUser(transport)).toBe("1");
  } finally {
    for (const id of made) {
      await wpCli(transport, ["user", "delete", id, "--yes"]);
    }
  }
}
