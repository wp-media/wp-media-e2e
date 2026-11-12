import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sha256File } from "../artifacts/digest";
import {
  disposeConnections,
  execAsTransport,
  execElevated,
  installKey,
  resetElevationCaches,
  wpCli,
} from "./exec";
import { fileChecksum } from "./files";
import { resetOwnershipCaches } from "./ownership";
import {
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "./site-identity";
import { INBOX_PREFIX } from "./site-staging";
import {
  cleanSiteStaging,
  siteStagingDir,
  stageAndInstallPlugin,
} from "./staging";
import { checkWebIdentity } from "./web-identity";
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
import { removeTempDir } from "../__fixtures__/temp-dir";
import type { Transport } from "../config/types";

/**
 * Staging on the SSH twins. In `site` (a `755 www-data` docroot, `ubuntu` outside its group) a plugin
 * zip goes through an inbox in `/tmp`, lands `www-data:www-data 644` with the runner's SHA-256, and
 * installs; staging a fallback run left as `ubuntu` is removed and made again; the inbox is gone and
 * an hour-old one is swept. In `legacy-777` (`fallback/owner-not-web`) staging is today's: the file is
 * the transport user's, and no inbox is made.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin, resets it,
 * and puts it back in {@link RESTING_VARIANT}.
 */

/** The probe plugin's slug: a folder no product uses. */
const SLUG = "e2e-inbox-probe";

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

let zipDir: string | undefined;
let zipPath: string;

test.beforeAll(() => {
  if (!sshTwinsEnabled()) return;
  zipDir = mkdtempSync(join(tmpdir(), "e2e-inbox-zip-"));
  mkdirSync(join(zipDir, SLUG));
  writeFileSync(
    join(zipDir, SLUG, `${SLUG}.php`),
    `<?php\n/**\n * Plugin Name: E2E inbox probe\n * Version: 1.0.0\n */\n`,
  );
  execFileSync("zip", ["-qr", `${SLUG}.zip`, SLUG], { cwd: zipDir });
  zipPath = join(zipDir, `${SLUG}.zip`);
});

test.afterAll(() => {
  if (zipDir !== undefined) removeTempDir(zipDir);
});

test.describe("SSH twins: staging through an inbox", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);
  // A reset (~6 s), the web probe, remote WP-CLI booting WordPress several times.
  test.setTimeout(240_000);

  test.afterEach(() => {
    disposeConnections();
  });

  for (const twin of CELLS) {
    test(`${twin.stack} site: a zip staged through an inbox lands as www-data, installs, and the inbox is gone`, async ({
      playwright,
    }) => {
      await onVariant(twin, "site", async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        await expect(inboxes(transport)).resolves.toEqual([]);

        const staged = await stageAndInstallPlugin(transport, zipPath, {
          slug: SLUG,
        });

        await expect(ownerAndMode(transport, staged)).resolves.toBe(
          "www-data:www-data 644",
        );
        await expect(fileChecksum(transport, staged)).resolves.toBe(
          await sha256File(zipPath),
        );
        expect(
          (await wpCli(transport, ["plugin", "is-installed", SLUG])).exitCode,
        ).toBe(0);
        await expect(inboxes(transport)).resolves.toEqual([]);
      });
    });

    test(`${twin.stack} site: staging a fallback run left as ubuntu is removed and made again`, async ({
      playwright,
    }) => {
      await onVariant(twin, "site", async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        const root = await siteStagingDir(transport);
        // What a fallback run leaves: the area and a staged zip, ubuntu's, 775/664.
        const planted = await execElevated(transport, "sh", [
          "-c",
          'mkdir -p -- "$1/plugins" && touch -- "$1/plugins/old.zip" && chown -R ubuntu:ubuntu -- "$1" && chmod -R u=rwX,g=rwX,o=rX -- "$1"',
          "plant",
          root,
        ]);
        expect(planted.exitCode).toBe(0);

        const staged = await stageAndInstallPlugin(transport, zipPath, {
          slug: SLUG,
        });

        await expect(ownerAndMode(transport, root)).resolves.toBe(
          "www-data:www-data 755",
        );
        await expect(ownerAndMode(transport, staged)).resolves.toBe(
          "www-data:www-data 644",
        );
        await expect(
          execAsTransport(transport, "test", ["-e", `${root}/plugins/old.zip`]),
        ).resolves.toMatchObject({ exitCode: 1 });
      });
    });

    test(`${twin.stack} site: cleaning the area sweeps the login's hour-old inbox, not a young one`, async ({
      playwright,
    }) => {
      await onVariant(twin, "site", async (transport) => {
        await verify(twin, transport, playwright.request, "site");
        const old = `/tmp/${INBOX_PREFIX}1-twinold`;
        const young = `/tmp/${INBOX_PREFIX}1-twinyoung`;
        const made = await execAsTransport(transport, "sh", [
          "-c",
          'mkdir -m 0711 -- "$1" "$2" && touch -- "$1/upload" && touch -d "2 hours ago" -- "$1"',
          "plant",
          old,
          young,
        ]);
        expect(made.exitCode).toBe(0);
        try {
          await cleanSiteStaging(transport);
          await expect(inboxes(transport)).resolves.toEqual([young]);
        } finally {
          await execAsTransport(transport, "rm", ["-rf", "--", old, young]);
        }
      });
    });

    test(`${twin.stack} legacy-777: staging is today's — the transport user's file, no inbox`, async ({
      playwright,
    }) => {
      await onVariant(twin, "legacy-777", async (transport) => {
        await verify(twin, transport, playwright.request, "fallback");

        const staged = await stageAndInstallPlugin(transport, zipPath, {
          slug: SLUG,
        });

        await expect(ownerAndMode(transport, staged)).resolves.toMatch(
          /^ubuntu:ubuntu /,
        );
        await expect(inboxes(transport)).resolves.toEqual([]);
      });
    });
  }
});

/**
 * Holds `twin`, resets it to `variant`, runs `work` on its transport with fresh caches, then removes
 * the probe plugin and the staging area and puts the twin back in {@link RESTING_VARIANT}.
 *
 * @param twin - the cell.
 * @param variant - the variant to test.
 * @param work - the checks.
 */
async function onVariant(
  twin: TwinCell,
  variant: TwinVariant,
  work: (transport: Transport) => Promise<void>,
): Promise<void> {
  await withTwin(twin.stack, async () => {
    resetTwin(twin.stack, variant);
    resetSiteIdentityCaches();
    resetElevationCaches();
    resetOwnershipCaches();
    try {
      await work(twinSite(twin).transport);
    } finally {
      disposeConnections();
      resetTwin(twin.stack, RESTING_VARIANT);
    }
  });
}

/**
 * Registers the pre-flight's verdict, asked of the twin's web server, and checks the state reached.
 *
 * @param twin - the cell.
 * @param transport - its transport.
 * @param request - Playwright's `request`, for the web probe.
 * @param kind - the state's kind it must reach.
 */
async function verify(
  twin: TwinCell,
  transport: Transport,
  request: Parameters<typeof checkWebIdentity>[1],
  kind: "site" | "fallback",
): Promise<void> {
  const verdict = await checkWebIdentity(twinSite(twin), request);
  registerSiteIdentityVerdicts(new Map([[installKey(transport), verdict]]));
  expect((await resolveSiteIdentity(transport)).kind).toBe(kind);
}

/**
 * `user:group mode` of a path, read as the transport's user.
 *
 * @param transport - the twin's transport.
 * @param path - the path.
 */
async function ownerAndMode(
  transport: Transport,
  path: string,
): Promise<string> {
  const { stdout } = await execAsTransport(transport, "stat", [
    "-c",
    "%U:%G %a",
    "--",
    path,
  ]);
  return stdout;
}

/**
 * The login's inboxes in `/tmp`, sorted.
 *
 * @param transport - the twin's transport.
 * @throws when `find` fails, so an unreadable `/tmp` never reads as "no inbox".
 */
async function inboxes(transport: Transport): Promise<string[]> {
  const { exitCode, stdout, stderr } = await execAsTransport(
    transport,
    "find",
    ["/tmp", "-mindepth", "1", "-maxdepth", "1", "-name", `${INBOX_PREFIX}*`],
  );
  expect(exitCode, stderr).toBe(0);
  return stdout === "" ? [] : stdout.split("\n").sort();
}
