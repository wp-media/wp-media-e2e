import { test, expect } from "@playwright/test";

import { verifySite } from "./preflight";
import {
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  sshTwinsEnabled,
  twinSite,
  withTwin,
} from "../__fixtures__/ssh-twins";
import { disposeConnections } from "../wp/exec";

/**
 * Today's pre-flight on the SSH twins, as freshly started in `legacy-777` (the cells' current shape):
 * every twin cell of both products connects over ssh on its own port and passes every check —
 * transport, WP-CLI, root, boot, locale, ownership and elevation reports.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done): `npm run test:unit` skips it.
 */
test.describe("SSH twins: the pre-flight", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // Remote WP-CLI boots WordPress several times per site.
  test.setTimeout(120_000);

  test.afterAll(() => {
    disposeConnections();
  });

  for (const twin of TWIN_CELLS) {
    test(`${twin.product} ${twin.cell}: every pre-flight check passes over ssh on the ${twin.stack} twin`, async () => {
      const site = twinSite(twin);
      expect(site.transport.mode).toBe("ssh");

      // Held, so a spec resetting this twin to another variant never lands mid-check.
      const result = await withTwin(twin.stack, () => verifySite(site, 0));

      // Each failed check with its detail, so a red run says why.
      expect(
        result.checks
          .filter((check) => !check.ok)
          .map((check) => `${check.name}: ${check.detail}`),
      ).toEqual([]);
      // Past the transport: WordPress booted, so the boot-dependent checks and reports ran too.
      expect(result.elevation).toBeDefined();
      expect(result.checks.length).toBeGreaterThan(2);
    });
  }
});
