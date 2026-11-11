import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

import {
  disposeConnections,
  elevationSupport,
  exec,
  execAsTransport,
  installKey,
  resetElevationCaches,
  wpCli,
} from "./exec";
import { resetOwnershipCaches } from "./ownership";
import {
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import { SiteIdentityRefusedError } from "./errors";
import { checkWebIdentity } from "./web-identity";
import { HOSTILE_ARGUMENTS } from "../__fixtures__/hostile-arguments";
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
import type { ElevationSupport } from "./exec";
import type { IdentityState } from "./site-identity";

/**
 * `exec`/`wpCli` on the SSH twins, every variant on both stacks, with `runAs: "auto"` (the twins'
 * overlays) and the pre-flight's verdict asked of the twin's web server: the state each variant must
 * reach, who commands then run as, arguments surviving the real `sudo` and wrapper byte for byte, a
 * WordPress option round-trip, a written file's owner and mode, and elevation still measured as the
 * SSH user.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done): `npm run test:unit` skips it. Each
 * test holds its twin ({@link withTwin}), resets it, and puts it back in {@link RESTING_VARIANT}.
 */

/** What one variant must produce. */
interface Expected {
  /** The state, `kind` or `kind/reason`. */
  readonly state: string;
  /** Who `id -un` says commands run as. */
  readonly runsAs: "www-data" | "ubuntu";
  /** A new file's `user:group mode`, or `refused` when the transport's user cannot write there. */
  readonly written: string;
  readonly elevation: ElevationSupport;
}

/** Per variant (`docker/ssh-cells/site.sh` makes each). The transport's user writes with its login's umask, `0002`. */
const EXPECTED: Readonly<Record<TwinVariant, Expected>> = {
  "legacy-777": {
    state: "fallback/owner-not-web",
    runsAs: "ubuntu",
    written: "ubuntu:ubuntu 664",
    elevation: "available",
  },
  site: {
    state: "site",
    runsAs: "www-data",
    written: "www-data:www-data 644",
    elevation: "available",
  },
  "site-775": {
    state: "site",
    runsAs: "www-data",
    written: "www-data:www-data 644",
    elevation: "available",
  },
  "no-sudo": {
    state: "fallback/no-sudo",
    runsAs: "ubuntu",
    written: "ubuntu:ubuntu 664",
    elevation: "unavailable",
  },
  "owner-mismatch": {
    state: "fallback/owner-not-web",
    runsAs: "ubuntu",
    written: "ubuntu:ubuntu 664",
    elevation: "available",
  },
  // As `site` (755, ubuntu outside the group), but no `wp` under sudo: the transport's user, which
  // cannot write the docroot — today's shape on such a host.
  "no-wp": {
    state: "fallback/no-wp",
    runsAs: "ubuntu",
    written: "refused",
    elevation: "available",
  },
  "wpconfig-root": {
    state: "site",
    runsAs: "www-data",
    written: "www-data:www-data 644",
    elevation: "available",
  },
};

/**
 * A state as `kind` or `kind/reason`.
 *
 * @param state - the resolved state.
 */
function stateLabel(state: IdentityState): string {
  return state.kind === "fallback" ? `fallback/${state.reason}` : state.kind;
}

/** One cell per twin: the stack is what varies, not the product. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

test.describe("SSH twins: exec as the site's identity", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // A reset (~6 s), the web probe, and remote WP-CLI booting WordPress, twice per variant.
  test.setTimeout(240_000);

  test.afterEach(() => {
    disposeConnections();
  });

  for (const twin of CELLS) {
    for (const variant of Object.keys(EXPECTED) as TwinVariant[]) {
      const expected = EXPECTED[variant];
      test(`${twin.stack} ${variant}: ${expected.state}, commands as ${expected.runsAs}`, async ({
        playwright,
      }) => {
        await withTwin(twin.stack, async () => {
          resetTwin(twin.stack, variant);
          try {
            await checkVariant(twin, expected, playwright.request);
          } finally {
            disposeConnections();
            resetTwin(twin.stack, RESTING_VARIANT);
          }
        });
      });
    }
  }

  for (const twin of CELLS) {
    test(`${twin.stack}: sudo's rule withdrawn mid-run — the next command throws, the one after runs as ubuntu`, async ({
      playwright,
    }) => {
      await withTwin(twin.stack, async () => {
        resetTwin(twin.stack, "site");
        try {
          await withdrawnRule(twin, playwright.request);
        } finally {
          disposeConnections();
          resetTwin(twin.stack, RESTING_VARIANT);
        }
      });
    });
  }
});

/**
 * A `site` twin whose sudo rule is removed once the state is verified: the real `sudo`'s refusal is
 * thrown, never returned as the program's exit 1, and the state is resolved again (`no-sudo`).
 *
 * @param twin - the cell.
 * @param request - Playwright's `request`, for the web probe.
 */
async function withdrawnRule(
  twin: (typeof CELLS)[number],
  request: Parameters<typeof checkWebIdentity>[1],
): Promise<void> {
  resetSiteIdentityCaches();
  const { transport } = twinSite(twin);
  registerSiteIdentityVerdicts(
    new Map([
      [installKey(transport), await checkWebIdentity(twinSite(twin), request)],
    ]),
  );
  expect(stateLabel(await resolveSiteIdentity(transport))).toBe("site");

  // The twin's sudoers rule for ubuntu (`TWIN_SUDOERS` in docker/ssh-cells/lib.sh).
  execFileSync("docker", [
    "exec",
    `wpme-ssh-${twin.stack}`,
    "rm",
    "/etc/sudoers.d/90-ubuntu",
  ]);

  await expect(
    wpCli(transport, ["plugin", "is-installed", "e2e-none"]),
  ).rejects.toBeInstanceOf(SiteIdentityRefusedError);
  await expect(exec(transport, "id", ["-un"])).resolves.toMatchObject({
    exitCode: 0,
    stdout: "ubuntu",
  });
  expect(stateLabel(await resolveSiteIdentity(transport))).toBe(
    "fallback/no-sudo",
  );
}

/**
 * Every check of one variant, on a freshly reset twin.
 *
 * @param twin - the cell.
 * @param expected - what the variant must produce.
 * @param request - Playwright's `request`, for the web probe.
 */
async function checkVariant(
  twin: (typeof CELLS)[number],
  expected: Expected,
  request: Parameters<typeof checkWebIdentity>[1],
): Promise<void> {
  resetSiteIdentityCaches();
  resetElevationCaches();
  resetOwnershipCaches();
  const site = twinSite(twin);
  const { transport } = site;
  expect(transport.mode === "ssh" ? transport.runAs : undefined).toBe("auto");

  const verdict = await checkWebIdentity(site, request);
  registerSiteIdentityVerdicts(new Map([[installKey(transport), verdict]]));
  expect(stateLabel(await resolveSiteIdentity(transport))).toBe(expected.state);

  const id = await exec(transport, "id", ["-un"]);
  expect(id).toMatchObject({ exitCode: 0, stdout: expected.runsAs });

  // Byte for byte through the real sudo, the wrapper and OpenSSH: each argument NUL-terminated.
  const echoed = await exec(transport, "printf", [
    "%s\\0",
    ...HOSTILE_ARGUMENTS,
  ]);
  expect(echoed.stdout.split("\0").slice(0, -1)).toEqual(HOSTILE_ARGUMENTS);

  const name = `e2e_twin_exec_${randomBytes(4).toString("hex")}`;
  const value = `café ✓ $(id) 'q' "d" --key=x`;
  try {
    expect(
      (await wpCli(transport, ["option", "add", name, value])).exitCode,
    ).toBe(0);
    const read = await wpCli(transport, ["option", "get", name]);
    expect(read).toMatchObject({ exitCode: 0, stdout: value });
  } finally {
    await wpCli(transport, ["option", "delete", name]);
  }

  await expect(writtenFile(transport)).resolves.toBe(expected.written);
  await expect(elevationSupport(transport)).resolves.toBe(expected.elevation);
}

/**
 * Writes a new file into `wp-content` as commands run, reads its owner and mode as the transport's
 * user, and removes it as its writer.
 *
 * @param transport - the twin's transport.
 * @returns `user:group mode`, or `refused` when the write failed.
 */
async function writtenFile(
  transport: Parameters<typeof exec>[0],
): Promise<string> {
  const path = `${transport.rootDir ?? ""}/wp-content/e2e-twin-exec-${randomBytes(4).toString("hex")}.txt`;
  const touched = await exec(transport, "touch", ["--", path]);
  if (touched.exitCode !== 0) return "refused";
  try {
    const stat = await execAsTransport(transport, "stat", [
      "-c",
      "%U:%G %a",
      "--",
      path,
    ]);
    return stat.stdout;
  } finally {
    await exec(transport, "rm", ["-f", "--", path]);
  }
}
