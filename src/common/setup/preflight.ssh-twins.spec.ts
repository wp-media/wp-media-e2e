import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { verifySite } from "./preflight";
import type { SitePreflightResult } from "./preflight";
import { renderIdentityWarning } from "./elevation-report";
import { SITE_IDENTITY_CHECK } from "./site-identity-report";
import { disposeConnections, resetElevationCaches } from "../wp/exec";
import { resetOwnershipCaches } from "../wp/ownership";
import {
  FALLBACK_REASONS,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "../wp/site-identity";
import type { FallbackReason } from "../wp/site-identity";
import { resetWpUserCaches } from "../wp/wp-user";
import {
  RESTING_VARIANT,
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  resetTwin,
  sshTwinsEnabled,
  twinSite,
  withTwin,
  type TwinCell,
  type TwinVariant,
} from "../__fixtures__/ssh-twins";
import type { SiteInput } from "../config/types";

/**
 * The pre-flight's site identity report on the twins' real sudo, PHP and web servers, every variant
 * `site.sh` makes, `runAs: "auto"` (the twins' overlay): the state each variant must produce (the
 * plan's variant table), the banner's issues (silent only where the site runs as its verified identity
 * and sudo keeps command lines out of its log), no check failing, and no probe file left. One more per
 * twin with `runAs` false: no probe, nothing in the banner (an opt-out).
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin
 * ({@link withTwin}), resets it, and puts it back in {@link RESTING_VARIANT} however it ends.
 */

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

/** What a variant must produce: `site`, or a fallback's reason; and whether sudo logs command lines. */
const EXPECTED: Readonly<
  Record<
    TwinVariant,
    { readonly state: "site" | FallbackReason; readonly logs: boolean }
  >
> = {
  "legacy-777": { state: "owner-not-web", logs: false },
  site: { state: "site", logs: false },
  "site-775": { state: "site", logs: false },
  // sudo refuses to list: the missing rule is the one issue.
  "no-sudo": { state: "no-sudo", logs: false },
  "owner-mismatch": { state: "owner-not-web", logs: true },
  "no-wp": { state: "no-wp", logs: false },
  "wpconfig-root": { state: "site", logs: false },
};

/** The banner's issue for sudo logging command lines. */
const LOGS = "sudo logs every command line it runs, `--key=` values included";

/**
 * Probe files left in a twin's root, listed as root inside the container.
 *
 * @param twin - the cell.
 */
function probeFilesLeft(twin: TwinCell): string[] {
  const out = execFileSync(
    "docker",
    [
      "exec",
      `wpme-ssh-${twin.stack}`,
      "sh",
      "-c",
      "ls -a /var/www/site/public",
    ],
    { encoding: "utf8" },
  );
  return out.split("\n").filter((name) => name.startsWith("e2e-identity-"));
}

/** Forgets every per-process answer, so each variant is judged afresh. */
function resetCaches(): void {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  resetWpUserCaches();
}

/**
 * Runs `work` on a twin reset to `variant`, putting it back however it ends.
 *
 * @param twin - the cell.
 * @param variant - the variant.
 * @param work - what to do.
 */
async function onVariant(
  twin: TwinCell,
  variant: TwinVariant,
  work: () => Promise<void>,
): Promise<void> {
  await withTwin(twin.stack, async () => {
    try {
      resetTwin(twin.stack, variant);
      resetCaches();
      await work();
    } finally {
      disposeConnections();
      resetCaches();
      resetTwin(twin.stack, RESTING_VARIANT);
    }
  });
}

/**
 * The pre-flight's site identity check line, and the banner for this one site.
 *
 * @param result - the site's result.
 */
function reported(result: SitePreflightResult): {
  readonly detail: string;
  readonly banner: string | undefined;
} {
  const check = result.checks.find(
    (entry) => entry.name === SITE_IDENTITY_CHECK,
  );
  return {
    detail: check?.detail ?? "",
    banner: renderIdentityWarning([
      {
        baseURL: result.baseURL,
        transport: "t",
        issues: result.identityIssues ?? [],
      },
    ]),
  };
}

test.describe("SSH twins: the pre-flight's site identity report", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // Two resets (~6 s each), the web probe, a few remote WP-CLI boots.
  test.setTimeout(240_000);

  for (const twin of CELLS) {
    for (const [variant, expected] of Object.entries(EXPECTED) as [
      TwinVariant,
      (typeof EXPECTED)[TwinVariant],
    ][]) {
      test(`${twin.stack} ${variant}: ${expected.state}${expected.logs ? ", sudo logs" : ""}, never a failure`, async ({
        playwright,
      }) => {
        await onVariant(twin, variant, async () => {
          const site = twinSite(twin);
          const result = await verifySite(site, 0, [], undefined, {
            request: playwright.request,
          });

          expect(result.checks.filter((check) => !check.ok)).toEqual([]);
          const state = await resolveSiteIdentity(site.transport);
          expect(state.kind === "fallback" ? state.reason : state.kind).toBe(
            expected.state,
          );
          const issues = (result.identityIssues ?? []).map(
            (issue) => issue.what,
          );
          const { detail, banner } = reported(result);
          if (expected.state === "site") {
            expect(detail.split("\n")[0]).toBe(
              "Runs as www-data(33):www-data(33), umask 0022.",
            );
            expect(detail).toContain("sudo keeps command lines out of its log");
            expect(banner).toBeUndefined();
          } else {
            expect(issues[0]).toContain(FALLBACK_REASONS[expected.state].what);
            expect(issues.includes(LOGS)).toBe(expected.logs);
            expect(issues).toHaveLength(expected.logs ? 2 : 1);
            expect(banner).toContain(FALLBACK_REASONS[expected.state].fix);
          }
          expect(detail).toContain(
            "WP-CLI runs WordPress as the site's WordPress login",
          );
          expect(probeFilesLeft(twin)).toEqual([]);
        });
      });
    }

    test(`${twin.stack} runAs false: no probe, nothing in the banner, nothing failed`, async ({
      playwright,
    }) => {
      await onVariant(twin, RESTING_VARIANT, async () => {
        const base = twinSite(twin);
        const site: SiteInput = {
          ...base,
          transport: {
            ...base.transport,
            runAs: false,
          } as SiteInput["transport"],
        };
        const result = await verifySite(site, 0, [], undefined, {
          request: playwright.request,
        });

        expect(result.checks.filter((check) => !check.ok)).toEqual([]);
        expect(result.identityVerdict).toBeUndefined();
        expect(reported(result).detail.split("\n")[0]).toBe(
          "Runs as the transport's user, as configured (`runAs` is false); nothing to fix.",
        );
        expect(result.identityIssues).toEqual([]);
      });
    });
  }
});
