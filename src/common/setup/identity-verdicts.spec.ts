import { test, expect } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { missingVerdictReason, registerRunVerdict } from "./identity-verdicts";
import { removeTempDir } from "../__fixtures__/temp-dir";
import { installKey } from "../wp/exec";
import { SITE_IDENTITY_FILE, writeSiteIdentityFile } from "../wp/web-identity";
import type { SiteIdentityVerdict } from "../wp/web-identity";
import type { SiteInput, SshTransport } from "../config/types";

/**
 * A worker's read of the auth setup's verdict file: only an `auto` site reads it, its own verdict is
 * registered, and a missing, stale, invalid or incomplete file is warned once, the site masked.
 */

const VERDICT: SiteIdentityVerdict = {
  verdict: "owner-is-web",
  owner: { user: "www-data", group: "www-data", uid: 33, gid: 33 },
  web: { euid: 33, egid: 33, umask: "0022", sapi: "fpm-fcgi" },
};

/**
 * A site over ssh with `runAs`.
 *
 * @param runAs - its `runAs`; absent for the default.
 */
const siteWith = (runAs?: SshTransport["runAs"]): SiteInput => ({
  baseURL: "https://user:secret@site.test/",
  username: "admin",
  password: "pw",
  transport: {
    mode: "ssh",
    host: "site.test",
    username: "ubuntu",
    privateKeyPath: "/k",
    rootDir: "/srv/site",
    ...(runAs === undefined ? {} : { runAs }),
  },
});

let dir: string;
let warnings: string[];
let registered: ReadonlyMap<string, SiteIdentityVerdict>[];

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-verdicts-"));
  warnings = [];
  registered = [];
});

test.afterEach(() => {
  removeTempDir(dir);
});

/**
 * Runs {@link registerRunVerdict} for `site` against the temp folder, run `run-1`.
 *
 * @param site - the worker's site.
 */
const register = (site: SiteInput): Promise<void> =>
  registerRunVerdict(
    site,
    dir,
    "run-1",
    (message) => warnings.push(message),
    (entries) => registered.push(entries),
  );

test.describe("registerRunVerdict", () => {
  test("an auto site's verdict in this run's file is registered, silently", async () => {
    const site = siteWith("auto");
    await writeSiteIdentityFile(
      dir,
      "run-1",
      new Map([[installKey(site.transport), VERDICT]]),
    );

    await register(site);

    expect(registered).toEqual([
      new Map([[installKey(site.transport), VERDICT]]),
    ]);
    expect(warnings).toEqual([]);
  });

  test("runAs false, absent or declared: the file is never read, nothing said", async () => {
    // A file that would warn if read.
    writeFileSync(join(dir, SITE_IDENTITY_FILE), "not json");
    for (const runAs of [false, undefined, "www-data:www-data"] as const) {
      await register(siteWith(runAs));
    }
    expect(registered).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test("an auto site without its verdict: warned once, the address masked, nothing registered", async () => {
    const site = siteWith("auto");
    const cases: [() => Promise<unknown>, string][] = [
      [() => Promise.resolve(), "no verdict file"],
      [
        () =>
          writeSiteIdentityFile(
            dir,
            "run-0",
            new Map([[installKey(site.transport), VERDICT]]),
          ),
        "another run's",
      ],
      [
        () => {
          writeFileSync(join(dir, SITE_IDENTITY_FILE), "{");
          return Promise.resolve();
        },
        "unreadable (not JSON)",
      ],
      [
        () => writeSiteIdentityFile(dir, "run-1", new Map()),
        "left no verdict for it",
      ],
    ];
    for (const [arrange, words] of cases) {
      warnings = [];
      await arrange();
      await register(site);
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(words);
      expect(warnings[0]).toContain(
        "site commands run as the transport's user (unverified)",
      );
      expect(warnings[0]).not.toContain("secret");
    }
    expect(registered).toEqual([]);
  });
});

test.describe("missingVerdictReason", () => {
  test("none when the file held the site's verdict; a reason per other case", () => {
    const read = { kind: "read", verdicts: new Map() } as const;
    expect(missingVerdictReason(read, true)).toBeUndefined();
    expect(missingVerdictReason(read, false)).toContain("left no verdict");
    expect(missingVerdictReason({ kind: "missing" }, false)).toContain(
      "--no-deps",
    );
    expect(
      missingVerdictReason({ kind: "stale", runId: "x" }, false),
    ).toContain("another run's");
    expect(
      missingVerdictReason({ kind: "invalid", why: "no runId" }, false),
    ).toContain("unreadable (no runId)");
  });
});
