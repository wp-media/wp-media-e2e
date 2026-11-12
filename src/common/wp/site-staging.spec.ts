import { test, expect } from "@playwright/test";

import {
  INBOX_PREFIX,
  ensureSiteStagingDir,
  inboxPath,
  stageThroughInbox,
  staleDirSweepScript,
} from "./site-staging";
import type { ExecResult } from "./exec";
import type { InboxStagingRequest, SiteStagingOps } from "./site-staging";

/**
 * Staging through an inbox, over recorded fake operations: the order of every step and who it runs
 * as, the inbox removed after each step that can fail (and never when its own `mkdir` failed), and
 * the heal of the site's own area another user made (an absolute root's is refused).
 */

const HEX = "0123456789abcdef";
const INBOX = `/tmp/${INBOX_PREFIX}4242-${HEX}`;
const UPLOAD = `${INBOX}/upload`;
const SUM = "a".repeat(64);

const REQUEST: InboxStagingRequest = {
  localPath: "/runner/artifacts/plugin.zip",
  target: "/var/www/site/.e2e_temp/plugins/plugin.zip",
  categoryDir: "/var/www/site/.e2e_temp/plugins",
  healDir: "/var/www/site/.e2e_temp",
  inboxRoot: "/tmp",
  pid: 4242,
  site: "ubuntu@site.test",
};

/** The identity's one-call "another user's? else make it, and can I write it?" script. */
const ENSURE_SCRIPT =
  'for d in "$2" "$1"; do if [ -d "$d" ] && ! { [ -w "$d" ] && [ -x "$d" ]; }; then exit 3; fi; ' +
  'done; mkdir -p -- "$1" && test -w "$1" -a -x "$1"';

/** That script for the request's category and area. */
const ENSURE = `site sh -c ${ENSURE_SCRIPT} e2e-staging ${REQUEST.categoryDir} ${String(REQUEST.healDir)}`;

/** The resolved-path check before the area is removed. */
const CONFINE = `confine ${String(REQUEST.healDir)}`;

/** Every step of a staging that succeeds, in order. */
const HAPPY_PATH = [
  `runner-sum ${REQUEST.localPath}`,
  `transport mkdir -m 0711 -- ${INBOX}`,
  `upload ${REQUEST.localPath} ${UPLOAD}`,
  `transport chmod 0644 ${UPLOAD}`,
  ENSURE,
  `site cp -f -- ${UPLOAD} ${REQUEST.target}`,
  `site-sum ${REQUEST.target}`,
  `transport rm -rf -- ${INBOX}`,
];

/** How a recorded call is answered: an outcome, or a throw. */
type Answer = ExecResult | Error;

const OK: ExecResult = { exitCode: 0, stdout: "", stderr: "" };

/**
 * Builds fake operations that record each call as one line and answer from `answers` (keyed by the
 * line; the first matching prefix wins, else success).
 *
 * @param answers - lines (or prefixes) and how to answer them; an array answers successive calls.
 * @param options - the site's checksum, and whether the site can elevate.
 */
function fakeOps(
  answers: Readonly<Record<string, Answer | Answer[]>> = {},
  options: { readonly siteSum?: string; readonly canElevate?: boolean } = {},
): { ops: SiteStagingOps; calls: string[]; warnings: string[] } {
  const calls: string[] = [];
  const warnings: string[] = [];
  const answer = async (line: string): Promise<ExecResult> => {
    calls.push(line);
    const key = Object.keys(answers).find((prefix) => line.startsWith(prefix));
    const entry = key === undefined ? undefined : answers[key];
    const next = Array.isArray(entry) ? entry.shift() : entry;
    if (next instanceof Error) throw next;
    return Promise.resolve(next ?? OK);
  };
  const ops: SiteStagingOps = {
    asTransport: (file, args) => answer(["transport", file, ...args].join(" ")),
    asSite: (file, args) => answer(["site", file, ...args].join(" ")),
    asRoot: async (file, args) =>
      options.canElevate === false
        ? undefined
        : answer(["root", file, ...args].join(" ")),
    confineToSite: async (path) => {
      await answer(`confine ${path}`);
    },
    upload: async (local, remote) => {
      await answer(`upload ${local} ${remote}`);
    },
    siteChecksum: async (path) => {
      await answer(`site-sum ${path}`);
      return options.siteSum ?? SUM;
    },
    runnerChecksum: async (path) => {
      await answer(`runner-sum ${path}`);
      return SUM;
    },
    randomHex: () => HEX,
    warn: (message) => warnings.push(message),
  };
  return { ops, calls, warnings };
}

const FAILED: ExecResult = { exitCode: 1, stdout: "", stderr: "denied" };

/** The ensure script's answer for "it exists, and another user's". */
const NOT_WRITABLE: ExecResult = { exitCode: 3, stdout: "", stderr: "" };

test.describe("inboxPath (pure)", () => {
  test("names the inbox after the runner's pid and a random part, in the root", () => {
    expect(inboxPath("/tmp", 7, HEX)).toBe(`/tmp/e2e-inbox-7-${HEX}`);
    expect(inboxPath("/srv/scratch/", 7, HEX)).toBe(
      `/srv/scratch/e2e-inbox-7-${HEX}`,
    );
  });

  test("refuses a relative root", () => {
    expect(() => inboxPath("tmp", 7, HEX)).toThrow(/not an absolute path/);
  });
});

test.describe("stageThroughInbox", () => {
  test("runs every step in order, each as its user, and removes the inbox last", async () => {
    const { ops, calls, warnings } = fakeOps();
    await stageThroughInbox(ops, REQUEST);
    expect(calls).toEqual(HAPPY_PATH);
    expect(warnings).toEqual([]);
  });

  test("a failed inbox mkdir (the path exists, a planted symlink) stops at once and removes nothing", async () => {
    const { ops, calls } = fakeOps({
      "transport mkdir": { exitCode: 1, stdout: "", stderr: "File exists" },
    });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(
      `could not create the upload inbox "${INBOX}" on ubuntu@site.test (exit 1): File exists`,
    );
    expect(calls).toEqual(HAPPY_PATH.slice(0, 2));
  });

  test("an inbox mkdir that throws (transport failure) removes nothing", async () => {
    const { ops, calls } = fakeOps({
      "transport mkdir": new Error("connection lost"),
    });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(
      "connection lost",
    );
    expect(calls).toEqual(HAPPY_PATH.slice(0, 2));
  });

  test("a runner file that cannot be hashed fails before anything is made on the site", async () => {
    const { ops, calls } = fakeOps({ "runner-sum": new Error("ENOENT") });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow("ENOENT");
    expect(calls).toEqual(HAPPY_PATH.slice(0, 1));
  });

  // Every step after the inbox exists: the step's own error surfaces, and the inbox still goes.
  const afterInbox: readonly [string, string, Answer, string | RegExp][] = [
    [
      "upload",
      "upload",
      new Error("sftp: Permission denied"),
      "sftp: Permission denied",
    ],
    ["chmod", "transport chmod", FAILED, `could not make "${UPLOAD}" readable`],
    [
      "cp",
      "site cp",
      FAILED,
      /could not copy the upload to ".*plugin\.zip" as the site's identity/,
    ],
    [
      "site checksum",
      "site-sum",
      new Error("wp eval failed"),
      "wp eval failed",
    ],
  ];
  for (const [label, prefix, failure, message] of afterInbox) {
    test(`a failed ${label} still removes the inbox, and its own error is thrown`, async () => {
      const { ops, calls, warnings } = fakeOps({ [prefix]: failure });
      await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(message);
      const failedAt = HAPPY_PATH.findIndex((line) => line.startsWith(prefix));
      expect(calls).toEqual([
        ...HAPPY_PATH.slice(0, failedAt + 1),
        `transport rm -rf -- ${INBOX}`,
      ]);
      expect(warnings).toEqual([]);
    });
  }

  test("a staging directory that cannot be made still removes the inbox", async () => {
    const { ops, calls } = fakeOps({
      "site sh": NOT_WRITABLE,
      "site rm": FAILED,
      "root rm": FAILED,
    });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(
      /is not writable by the site's identity, and ".*\.e2e_temp" could not be removed/,
    );
    expect(calls.at(-1)).toBe(`transport rm -rf -- ${INBOX}`);
  });

  test("a site copy whose SHA-256 differs fails naming both sums, after removing the inbox", async () => {
    const { ops, calls } = fakeOps({}, { siteSum: "b".repeat(64) });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(
      `does not match "${REQUEST.localPath}" (SHA-256 ${"b".repeat(64)} on the site, ${SUM} on the runner)`,
    );
    expect(calls).toEqual(HAPPY_PATH);
  });

  test("an inbox that cannot be removed is warned about, never thrown, on success", async () => {
    const { ops, warnings } = fakeOps({ "transport rm": FAILED });
    await expect(stageThroughInbox(ops, REQUEST)).resolves.toBeUndefined();
    expect(warnings).toEqual([
      `[wp/staging] ubuntu@site.test: could not remove the upload inbox "${INBOX}" (denied); it is removed once 60 minutes old by the next teardown.`,
    ]);
  });

  test("an inbox removal that throws never replaces the step's own error", async () => {
    const { ops, warnings } = fakeOps({
      "site cp": FAILED,
      "transport rm": new Error("connection lost"),
    });
    await expect(stageThroughInbox(ops, REQUEST)).rejects.toThrow(
      /could not copy the upload/,
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("(connection lost)");
  });
});

test.describe("ensureSiteStagingDir", () => {
  test("a directory the identity can write is used as it is", async () => {
    const { ops, calls, warnings } = fakeOps();
    await ensureSiteStagingDir(ops, REQUEST);
    expect(calls).toEqual([ENSURE]);
    expect(warnings).toEqual([]);
  });

  test("the site's own area another user made is checked, removed as the identity and made again, then warned", async () => {
    const { ops, calls, warnings } = fakeOps({ "site sh": [NOT_WRITABLE, OK] });
    await ensureSiteStagingDir(ops, REQUEST);
    expect(calls).toEqual([
      ENSURE,
      CONFINE,
      `site rm -rf -- ${String(REQUEST.healDir)}`,
      ENSURE,
    ]);
    expect(warnings).toEqual([
      `[wp/staging] ubuntu@site.test: "${String(REQUEST.healDir)}" was not writable by the site's identity (made by another user); removed it and made it again.`,
    ]);
  });

  test("when the identity cannot remove it, root does", async () => {
    const { ops, calls } = fakeOps({
      "site sh": [NOT_WRITABLE, OK],
      "site rm": FAILED,
    });
    await ensureSiteStagingDir(ops, REQUEST);
    expect(calls).toEqual([
      ENSURE,
      CONFINE,
      `site rm -rf -- ${String(REQUEST.healDir)}`,
      `root rm -rf -- ${String(REQUEST.healDir)}`,
      ENSURE,
    ]);
  });

  test("an area resolving outside the site (a linked parent) is refused before anything is removed", async () => {
    const { ops, calls, warnings } = fakeOps({
      "site sh": NOT_WRITABLE,
      confine: new Error("really resolves to /var/www/other/wp-content"),
    });
    await expect(ensureSiteStagingDir(ops, REQUEST)).rejects.toThrow(
      "really resolves to /var/www/other/wp-content",
    );
    expect(calls).toEqual([ENSURE, CONFINE]);
    expect(warnings).toEqual([]);
  });

  test("an absolute root: a category another user made is refused, never removed, naming the override", async () => {
    const shared = {
      categoryDir: "/srv/e2e-staging/plugins",
      healDir: undefined,
      site: "ubuntu@site.test",
    };
    const { ops, calls, warnings } = fakeOps({ "site sh": NOT_WRITABLE });
    await expect(ensureSiteStagingDir(ops, shared)).rejects.toThrow(
      "the staging directory \"/srv/e2e-staging/plugins\" exists but the site's identity cannot write it: another user made it under an absolute staging root, which other sites may share, so it is never removed. Remove it, or give each site its own root (E2E_SITE_STAGING_DIR or the site's `transport.stagingDir`)",
    );
    // The category stands in for the area: an absolute root's own directory is not the site's.
    expect(calls).toEqual([
      `site sh -c ${ENSURE_SCRIPT} e2e-staging /srv/e2e-staging/plugins /srv/e2e-staging/plugins`,
    ]);
    expect(warnings).toEqual([]);
  });

  test("any other failure to make it (a full disk, a parent it cannot write) is never healed", async () => {
    const full: ExecResult = {
      exitCode: 1,
      stdout: "",
      stderr: "mkdir: No space left on device",
    };
    const { ops, calls, warnings } = fakeOps({ "site sh": full });
    await expect(ensureSiteStagingDir(ops, REQUEST)).rejects.toThrow(
      `could not create the staging directory "${REQUEST.categoryDir}" as the site's identity. If it cannot write there, set E2E_SITE_STAGING_DIR or the site's \`transport.stagingDir\` to a directory it can on ubuntu@site.test (exit 1): mkdir: No space left on device`,
    );
    expect(calls).toEqual([ENSURE]);
    expect(warnings).toEqual([]);
  });

  test("no elevation and an identity that cannot remove it: fails naming both paths, no warning", async () => {
    const { ops, calls, warnings } = fakeOps(
      { "site sh": NOT_WRITABLE, "site rm": FAILED },
      { canElevate: false },
    );
    await expect(ensureSiteStagingDir(ops, REQUEST)).rejects.toThrow(
      `the staging directory "${REQUEST.categoryDir}" is not writable by the site's identity, and "${String(REQUEST.healDir)}" could not be removed to make it again on ubuntu@site.test (exit 1): denied`,
    );
    expect(calls).toEqual([
      ENSURE,
      CONFINE,
      `site rm -rf -- ${String(REQUEST.healDir)}`,
    ]);
    expect(warnings).toEqual([]);
  });

  test("removed but not made again: the error says it was removed, and nothing warns it was remade", async () => {
    const { ops, warnings } = fakeOps({ "site sh": [NOT_WRITABLE, FAILED] });
    await expect(ensureSiteStagingDir(ops, REQUEST)).rejects.toThrow(
      /".*\.e2e_temp" \(made by another user\) was removed, but the staging directory ".*plugins" could not be made again as the site's identity\. .*E2E_SITE_STAGING_DIR/,
    );
    expect(warnings).toEqual([]);
  });
});

test.describe("staleDirSweepScript", () => {
  test("removes only the runner's own first-level directories of that prefix, past the age", () => {
    expect(staleDirSweepScript("e2e-private-")).toBe(
      `find -H "$1" -mindepth 1 -maxdepth 1 -type d -name 'e2e-private-*' ` +
        `-user "$(id -u)" -mmin +"$2" -exec rm -rf -- {} +`,
    );
  });

  // The prefix is embedded in the script: anything a shell or `find` would read is refused.
  for (const prefix of ["", "e2e'*", "a b", "E2E-", "-name", "x/../"]) {
    test(`refuses the prefix ${JSON.stringify(prefix)}`, () => {
      expect(() => staleDirSweepScript(prefix)).toThrow(
        /cannot prefix the directories a sweep removes/,
      );
    });
  }
});
