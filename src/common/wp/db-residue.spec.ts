import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  PROTECTED_CAPABILITIES,
  PROTECTED_CRON_HOOKS,
  PROTECTED_OPTIONS,
  PROTECTED_ROLES,
  PROTECTED_TABLES,
  assertNoProtectedOptions,
  findSiteDbResidue,
  isEmptyDbResidue,
  normaliseOptionFragment,
  normaliseResidueCapability,
  normaliseResidueCronHook,
  normaliseResidueRole,
  normaliseResidueTable,
  removeSiteDbResidue,
} from "./db-residue";
import type { CapabilityGrant, CronEvent } from "./db-residue";
import { SiteDbResidueRemovalFailedError } from "./errors";
import type { LocalTransport } from "../config/types";

/**
 * The database-footprint sweep, driven over the `local` transport against a stub `wp`.
 *
 * The stub replies from a script — one line of JSON per call — because the interesting behaviour is
 * a *sequence*: scan, remove, then re-read to check. Only a stub that can answer differently the
 * third time can prove the verification is real rather than decorative.
 */

const STUB_WP = `#!/usr/bin/env bash
printf '%s' "$*" | tr '\\n' ' ' >> "$WP_STUB_CALLS"
printf '\\n' >> "$WP_STUB_CALLS"
n=$(cat "$WP_STUB_N" 2>/dev/null || echo 0)
n=$((n + 1))
printf '%s' "$n" > "$WP_STUB_N"
if [ -n "$WP_STUB_FAIL" ]; then printf '%s' "$WP_STUB_FAIL" >&2; exit 1; fi
reply=$(sed -n "\${n}p" "$WP_STUB_REPLIES")
if [ -z "$reply" ]; then reply=$(tail -n 1 "$WP_STUB_REPLIES"); fi
printf '%s' "$reply"
`;

let binDir: string;
let rootDir: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "wp-dbres-stub-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "wp-dbres-stub-root-"));
  const wp = join(binDir, "wp");
  writeFileSync(wp, STUB_WP);
  chmodSync(wp, 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_CALLS = join(binDir, "calls.txt");
  process.env.WP_STUB_N = join(binDir, "n.txt");
  process.env.WP_STUB_REPLIES = join(binDir, "replies.txt");
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  delete process.env.WP_STUB_CALLS;
  delete process.env.WP_STUB_N;
  delete process.env.WP_STUB_REPLIES;
  delete process.env.WP_STUB_FAIL;
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

test.beforeEach(() => {
  writeFileSync(join(binDir, "calls.txt"), "");
  writeFileSync(join(binDir, "n.txt"), "0");
  writeFileSync(join(binDir, "replies.txt"), "");
  delete process.env.WP_STUB_FAIL;
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Queues the stub's replies, one per `wp` call; the last is repeated if calls outrun it. */
function replies(...docs: string[]): void {
  writeFileSync(join(binDir, "replies.txt"), `${docs.join("\n")}\n`);
}

/** A scan reply in the shape the snippet emits. */
function found(
  options: string[] = [],
  tables: string[] = [],
  roles: string[] = [],
  capabilities: CapabilityGrant[] = [],
  cronEvents: CronEvent[] = [],
): string {
  return JSON.stringify({
    prefix: "wp_",
    options,
    tables,
    roles,
    capabilities,
    cronEvents,
  });
}

/** Every `wp` invocation so far, as the stub recorded it. */
function calls(): string[] {
  return readFileSync(join(binDir, "calls.txt"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const BACKWPUP = { optionsContaining: ["backwpup"], tables: ["bwpup_backups"] };

/** A declaration with a role and a capability, for the cases about the roles option. */
const WITH_ROLES = {
  ...BACKWPUP,
  roles: ["backwpup_check"],
  capabilities: ["backwpup_jobs"],
};

/** A capability BackWPup grants a role it does not own, as the scan reports it. */
const ADMIN_GRANT = { role: "administrator", capability: "backwpup_jobs" };

/** A declaration with WP-Cron hooks, for the cases about the `cron` option. */
const WITH_CRON = {
  ...BACKWPUP,
  cronHooks: ["backwpup_cron", "backwpup_check_cleanup"],
};

/** A job's event left behind, as the scan reports it. */
const JOB_EVENT: CronEvent = {
  hook: "backwpup_cron",
  time: 1_900_000_000,
  args: '{"arg":4}',
};

/** The values a snippet carries as base64 literals, decoded — how a declaration reaches the PHP. */
function decodedLiterals(call: string): string[] {
  return [...call.matchAll(/base64_decode\( '([^']+)' \)/g)].map((match) =>
    Buffer.from(match[1] ?? "", "base64").toString("utf8"),
  );
}

test.describe("normaliseOptionFragment", () => {
  test("accepts a plugin-shaped fragment and trims it", () => {
    expect(normaliseOptionFragment("  backwpup  ")).toBe("backwpup");
  });

  // A fragment is matched anywhere in a name, so a very short one reaches options that belong to
  // the site rather than the product. Refused where it can still be explained.
  test("refuses a fragment too short to identify a product", () => {
    expect(() => normaliseOptionFragment("id")).toThrow(
      /shorter than 3 characters/,
    );
  });

  // The fragment is escaped before it reaches SQL, so a `%` here cannot widen the match — it would
  // silently match nothing instead. Either way it is not what the author meant.
  test("refuses anything that looks like a wildcard", () => {
    expect(() => normaliseOptionFragment("backwpup%")).toThrow(
      /matched literally/,
    );
    expect(() => normaliseOptionFragment("back'wpup")).toThrow(
      /matched literally/,
    );
  });
});

test.describe("normaliseResidueTable", () => {
  test("accepts an unprefixed table name", () => {
    expect(normaliseResidueTable(" bwpup_backups ")).toBe("bwpup_backups");
  });

  // The name is spliced into `DROP TABLE` as an identifier, which no placeholder can carry, so the
  // charset restriction is the whole guard rather than a tidiness rule.
  test("refuses a name that is not a bare identifier", () => {
    expect(() => normaliseResidueTable("wp_posts; DROP")).toThrow(
      /letters, digits and underscores/,
    );
    expect(() => normaliseResidueTable("a`b")).toThrow(
      /letters, digits and underscores/,
    );
  });

  test("refuses WordPress's own tables, however they are cased", () => {
    expect(() => normaliseResidueTable("posts")).toThrow(
      /one of WordPress's own tables/,
    );
    expect(() => normaliseResidueTable("Users")).toThrow(
      /one of WordPress's own tables/,
    );
    expect(PROTECTED_TABLES).toContain("options");
  });
});

test.describe("normaliseResidueRole", () => {
  const fragments = ["backwpup", "bwpup"];

  test("accepts a role carrying one of the product's names and trims it", () => {
    expect(normaliseResidueRole(" backwpup_check ", fragments)).toBe(
      "backwpup_check",
    );
  });

  // Removing a core role strands every user holding it; `administrator` locks the site out.
  test("refuses each of WordPress's own roles", () => {
    for (const role of PROTECTED_ROLES) {
      expect(() => normaliseResidueRole(role, [role])).toThrow(
        /one of WordPress's own roles/,
      );
    }
    expect(PROTECTED_ROLES).toContain("administrator");
  });

  // Another plugin's role, or a site's own, carries none of the product's names.
  test("refuses a role that carries none of the product's names", () => {
    expect(() => normaliseResidueRole("shop_manager", fragments)).toThrow(
      /carries none of the product's names \(backwpup, bwpup\)/,
    );
  });

  test("refuses a role when the declaration names no fragment at all", () => {
    expect(() => normaliseResidueRole("backwpup_check", [])).toThrow(
      /names no `optionsContaining` fragment/,
    );
  });

  // WordPress keys roles case-sensitively, so `Administrator` would be a different role; lowercase
  // only keeps a case variant of a core name from slipping past the protected list.
  test("refuses anything but lowercase letters, digits, underscore and hyphen", () => {
    for (const role of ["Backwpup_check", "backwpup check", "backwpup'x", ""]) {
      expect(() => normaliseResidueRole(role, fragments)).toThrow(
        /only lowercase letters/,
      );
    }
  });
});

test.describe("normaliseResidueCapability", () => {
  const fragments = ["backwpup"];

  test("accepts a capability carrying one of the product's names", () => {
    expect(normaliseResidueCapability("backwpup_jobs", fragments)).toBe(
      "backwpup_jobs",
    );
  });

  // Removed from every role, so a core capability would leave nobody able to administer the site —
  // refused even when a careless fragment would admit it.
  test("refuses each of WordPress's own capabilities", () => {
    for (const capability of PROTECTED_CAPABILITIES) {
      expect(() =>
        normaliseResidueCapability(capability, [capability]),
      ).toThrow(/one of WordPress's own capabilities/);
    }
    expect(PROTECTED_CAPABILITIES).toEqual(
      expect.arrayContaining(["manage_options", "activate_plugins", "read"]),
    );
  });

  test("refuses another plugin's capability", () => {
    expect(() =>
      normaliseResidueCapability("manage_woocommerce", fragments),
    ).toThrow(/carries none of the product's names/);
  });
});

test.describe("normaliseResidueCronHook", () => {
  const fragments = ["backwpup", "bwpup"];

  test("accepts a hook carrying one of the product's names and trims it", () => {
    expect(normaliseResidueCronHook(" backwpup_cron ", fragments)).toBe(
      "backwpup_cron",
    );
  });

  // Unscheduling one stops core's update checks, clean-ups or scheduled posts — refused even when a
  // careless fragment would admit it.
  test("refuses each of WordPress's own hooks", () => {
    for (const hook of PROTECTED_CRON_HOOKS) {
      expect(() => normaliseResidueCronHook(hook, [hook])).toThrow(
        /one of WordPress's own WP-Cron hooks/,
      );
    }
    // The whole list, pinned: dropping one would let a product unschedule it unnoticed.
    expect(PROTECTED_CRON_HOOKS).toEqual([
      "delete_expired_transients",
      "do_pings",
      "importer_scheduled_cleanup",
      "publish_future_post",
      "recovery_mode_clean_expired_keys",
      "update_network_counts",
      "upgrader_scheduled_cleanup",
      "wp_delete_temp_updater_backups",
      "wp_https_detection",
      "wp_maybe_auto_update",
      "wp_privacy_delete_old_export_files",
      "wp_privacy_personal_data_cleanup_requests",
      "wp_scheduled_auto_draft_delete",
      "wp_scheduled_delete",
      "wp_site_health_scheduled_check",
      "wp_split_shared_term_batch",
      "wp_update_comment_type_batch",
      "wp_update_plugins",
      "wp_update_themes",
      "wp_update_user_counts",
      "wp_version_check",
    ]);
  });

  test("refuses another plugin's hook", () => {
    expect(() =>
      normaliseResidueCronHook("woocommerce_cleanup_sessions", fragments),
    ).toThrow(/carries none of the product's names \(backwpup, bwpup\)/);
  });

  test("refuses a hook when the declaration names no fragment at all", () => {
    expect(() => normaliseResidueCronHook("backwpup_cron", [])).toThrow(
      /names no `optionsContaining` fragment/,
    );
  });

  test("refuses anything but lowercase letters, digits, underscore and hyphen", () => {
    for (const hook of [
      "Backwpup_cron",
      "backwpup cron",
      "backwpup'cron",
      "backwpup/cron",
      "",
    ]) {
      expect(() => normaliseResidueCronHook(hook, fragments)).toThrow(
        /only lowercase letters/,
      );
    }
  });
});

test.describe("assertNoProtectedOptions", () => {
  /** The guard under test, wrapped so a void call can be handed to `toThrow`. */
  const check =
    (options: string[], prefix: string): (() => void) =>
    () => {
      assertNoProtectedOptions(options, prefix);
    };

  test("passes for options that belong to a product", () => {
    expect(
      check(["backwpup_version", "bwpup_backups_version"], "wp_"),
    ).not.toThrow();
  });

  test("refuses when the match reached an option WordPress owns", () => {
    expect(check(["backwpup_version", "siteurl"], "wp_")).toThrow(
      /belong to WordPress itself — siteurl/,
    );
    expect(PROTECTED_OPTIONS).toContain("active_plugins");
  });

  // `user_roles` carries the site's prefix, so it can only be recognised once the prefix is known —
  // and losing it locks every user out of wp-admin.
  test("recognises the protected options that carry the site's prefix", () => {
    expect(check(["wp_user_roles"], "wp_")).toThrow(/wp_user_roles/);
    expect(check(["xy_user_roles"], "xy_")).toThrow(/xy_user_roles/);
    // The same name under a different prefix is not this site's roles option.
    expect(check(["xy_user_roles"], "wp_")).not.toThrow();
  });
});

test.describe("findSiteDbResidue", () => {
  // A product that declares nothing must not pay a round-trip for it, mirroring the filesystem
  // sweep's contract.
  test("asks the site nothing when nothing is declared", async () => {
    expect(await findSiteDbResidue(local(), {})).toEqual({
      options: [],
      tables: [],
      roles: [],
      capabilities: [],
      cronEvents: [],
    });
    expect(calls()).toEqual([]);
  });

  test("reports what the site said it holds", async () => {
    replies(found(["backwpup_version"], ["wp_bwpup_backups"]));
    expect(await findSiteDbResidue(local(), BACKWPUP)).toEqual({
      options: ["backwpup_version"],
      tables: ["wp_bwpup_backups"],
      roles: [],
      capabilities: [],
      cronEvents: [],
    });
  });

  test("reports the declared roles and capabilities the site holds", async () => {
    replies(found([], [], ["backwpup_check"], [ADMIN_GRANT]));
    expect(await findSiteDbResidue(local(), WITH_ROLES)).toEqual({
      options: [],
      tables: [],
      roles: ["backwpup_check"],
      capabilities: [ADMIN_GRANT],
      cronEvents: [],
    });
  });

  test("carries the declared roles and capabilities into the snippet", async () => {
    replies(found());
    await findSiteDbResidue(local(), WITH_ROLES);
    expect(decodedLiterals(calls()[0] ?? "")).toEqual(
      expect.arrayContaining(['["backwpup_check"]', '["backwpup_jobs"]']),
    );
  });

  // Every kind is required in the reply: a site that left one out must not read as holding none.
  test("refuses a reply missing roles or carrying a malformed capability", async () => {
    for (const missing of ["roles", "capabilities", "cronEvents"]) {
      const reply: Record<string, unknown> = {
        prefix: "wp_",
        options: [],
        tables: [],
        roles: [],
        capabilities: [],
        cronEvents: [],
      };
      Reflect.deleteProperty(reply, missing);
      replies(JSON.stringify(reply));
      await expect(findSiteDbResidue(local(), WITH_ROLES)).rejects.toThrow(
        /did not describe a footprint/,
      );
    }
    replies(
      JSON.stringify({
        prefix: "wp_",
        options: [],
        tables: [],
        roles: [],
        capabilities: [{ role: "administrator" }],
        cronEvents: [],
      }),
    );
    await expect(findSiteDbResidue(local(), WITH_ROLES)).rejects.toThrow(
      /did not describe a footprint/,
    );
  });

  test("reports the events of declared WP-Cron hooks the site holds", async () => {
    const cleanup = { hook: "backwpup_check_cleanup", time: 5, args: "[]" };
    replies(found([], [], [], [], [cleanup, JOB_EVENT]));
    expect(await findSiteDbResidue(local(), WITH_CRON)).toEqual({
      options: [],
      tables: [],
      roles: [],
      capabilities: [],
      cronEvents: [cleanup, JOB_EVENT],
    });
  });

  test("carries the declared WP-Cron hooks into the snippet", async () => {
    replies(found());
    await findSiteDbResidue(local(), WITH_CRON);
    expect(decodedLiterals(calls()[0] ?? "")).toContain(
      '["backwpup_cron","backwpup_check_cleanup"]',
    );
    expect(calls()[0]).toContain("_get_cron_array()");
  });

  // A malformed event must not read as no event.
  test("refuses a reply carrying a malformed WP-Cron event", async () => {
    for (const event of [
      { hook: "backwpup_cron", time: 1, args: { arg: 4 } },
      { hook: "backwpup_cron", time: "1", args: "[]" },
      { hook: "backwpup_cron", time: 1.5, args: "[]" },
      { time: 1, args: "[]" },
    ]) {
      replies(
        JSON.stringify({
          prefix: "wp_",
          options: [],
          tables: [],
          roles: [],
          capabilities: [],
          cronEvents: [event],
        }),
      );
      await expect(findSiteDbResidue(local(), WITH_CRON)).rejects.toThrow(
        /did not describe a footprint/,
      );
    }
  });

  test("asks the site nothing for a declaration whose every list is empty", async () => {
    expect(
      isEmptyDbResidue(
        await findSiteDbResidue(local(), {
          optionsContaining: [],
          tables: [],
          roles: [],
          capabilities: [],
          cronHooks: [],
        }),
      ),
    ).toBe(true);
    expect(calls()).toEqual([]);
  });

  // Plugins stay out of the request: the product's own plugin re-creates its footprint on `init`,
  // so a sweep that loaded it could undo itself. Pinned because the flag is invisible in the result.
  test("loads WordPress without its plugins", async () => {
    replies(found());
    await findSiteDbResidue(local(), BACKWPUP);
    expect(calls()[0]).toMatch(/^--skip-plugins eval /);
  });

  // The declaration has to reach the snippet, and it travels as a base64 literal rather than as
  // interpolated text — so the check is that the snippet decodes to the fragments.
  test("carries the declared fragments and tables into the snippet", async () => {
    replies(found());
    await findSiteDbResidue(local(), BACKWPUP);
    const decoded = decodedLiterals(calls()[0] ?? "");
    expect(decoded).toContain('["backwpup"]');
    expect(decoded).toContain('["bwpup_backups"]');
  });

  // A site that printed a notice before its JSON must not be read as "nothing found" — that is the
  // one wrong answer that makes a sweep silently skip a dirty site.
  test("refuses a reply that is not the expected shape", async () => {
    replies("Notice: something\n{}");
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /reply was not JSON/,
    );
    replies(JSON.stringify({ prefix: "wp_", options: [1], tables: [] }));
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /did not describe a footprint/,
    );
  });

  test("reports a site that could not answer at all", async () => {
    process.env.WP_STUB_FAIL = "Error: Cannot connect to the database";
    await expect(findSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /Cannot connect to the database/,
    );
  });
});

test.describe("removeSiteDbResidue", () => {
  test("does nothing at all when nothing is declared", async () => {
    expect(await removeSiteDbResidue(local(), {})).toEqual({
      options: [],
      tables: [],
      roles: [],
      capabilities: [],
      cronEvents: [],
    });
    expect(calls()).toEqual([]);
  });

  // The common case by far. A site that was left clean should cost one read and no write — and in
  // particular must not run a `DELETE` that matches nothing.
  test("stops after the scan when the site is already clean", async () => {
    replies(found());
    expect(isEmptyDbResidue(await removeSiteDbResidue(local(), BACKWPUP))).toBe(
      true,
    );
    expect(calls()).toHaveLength(1);
  });

  test("removes what it found and reports it", async () => {
    replies(
      found(["backwpup_version"], ["wp_bwpup_backups"]),
      found(),
      found(),
    );
    expect(await removeSiteDbResidue(local(), BACKWPUP)).toEqual({
      options: ["backwpup_version"],
      tables: ["wp_bwpup_backups"],
      roles: [],
      capabilities: [],
      cronEvents: [],
    });
    // Scan, remove, verify — and the middle one is the only call that deletes.
    expect(calls()).toHaveLength(3);
    expect(calls()[1]).toContain("delete_option");
    expect(calls()[1]).toContain("DROP TABLE IF EXISTS");
    expect(calls()[2]).not.toContain("delete_option");
  });

  // Removal is verified by re-reading rather than inferred from an exit code: `DROP` succeeds for a
  // table it never touched, and `delete_option` reports false both for "absent" and for "refused".
  test("fails when the footprint survived the removal", async () => {
    replies(
      found(["backwpup_version"], ["wp_bwpup_backups"]),
      found(),
      found(["backwpup_version"], ["wp_bwpup_backups"]),
    );
    const error = await removeSiteDbResidue(local(), BACKWPUP).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SiteDbResidueRemovalFailedError);
    expect((error as SiteDbResidueRemovalFailedError).options).toEqual([
      "backwpup_version",
    ]);
    expect((error as Error).message).toMatch(/re-creates its own/);
    // Only WP-Cron events earn a second removal; nor is a WP-Cron run named as a cause here.
    expect(calls()).toHaveLength(3);
    expect((error as Error).message).not.toContain("WP-Cron run");
  });

  test("removes the roles and capabilities it found and reports them", async () => {
    replies(found([], [], ["backwpup_check"], [ADMIN_GRANT]), found(), found());
    expect(await removeSiteDbResidue(local(), WITH_ROLES)).toEqual({
      options: [],
      tables: [],
      roles: ["backwpup_check"],
      capabilities: [ADMIN_GRANT],
      cronEvents: [],
    });
    expect(calls()).toHaveLength(3);
    expect(calls()[1]).toContain("remove_role( $role )");
    expect(calls()[1]).toContain("->remove_cap( $grant['capability'] )");
    expect(calls()[2]).not.toContain("remove_role");
  });

  // The roles option is rewritten through the role API, and only a re-read proves it took.
  test("fails naming a role or capability that survived the removal", async () => {
    replies(
      found([], [], ["backwpup_check"], [ADMIN_GRANT]),
      found(),
      found([], [], ["backwpup_check"], [ADMIN_GRANT]),
    );
    const error = await removeSiteDbResidue(local(), WITH_ROLES).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SiteDbResidueRemovalFailedError);
    expect((error as SiteDbResidueRemovalFailedError).roles).toEqual([
      "backwpup_check",
    ]);
    expect((error as SiteDbResidueRemovalFailedError).capabilities).toEqual([
      ADMIN_GRANT,
    ]);
    expect((error as Error).message).toMatch(/role {7}backwpup_check/);
    expect((error as Error).message).toMatch(
      /capability backwpup_jobs \(on administrator\)/,
    );
  });

  test("refuses a core role or capability without asking the site anything", async () => {
    await expect(
      removeSiteDbResidue(local(), { ...BACKWPUP, roles: ["administrator"] }),
    ).rejects.toThrow(/one of WordPress's own roles/);
    await expect(
      removeSiteDbResidue(local(), {
        ...BACKWPUP,
        capabilities: ["manage_options"],
      }),
    ).rejects.toThrow(/one of WordPress's own capabilities/);
    expect(calls()).toEqual([]);
  });

  test("removes the WP-Cron events it found, hook by hook, and reports them", async () => {
    replies(found([], [], [], [], [JOB_EVENT]), found(), found());
    expect(await removeSiteDbResidue(local(), WITH_CRON)).toEqual({
      options: [],
      tables: [],
      roles: [],
      capabilities: [],
      cronEvents: [JOB_EVENT],
    });
    expect(calls()).toHaveLength(3);
    expect(calls()[1]).toContain("wp_unschedule_hook( $hook )");
    expect(calls()[2]).not.toContain("wp_unschedule_hook");
  });

  // `wp_unschedule_hook` can be answered by a filter without touching the `cron` option; only a
  // re-read proves the events went. The removal is retried once first (a WP-Cron run in flight can
  // put a recurring event back), so the stub answers the same survivor to both re-reads.
  test("fails naming a WP-Cron event that survived the removal and its retry", async () => {
    replies(
      found([], [], [], [], [JOB_EVENT]),
      found(),
      found([], [], [], [], [JOB_EVENT]),
      found(),
      found([], [], [], [], [JOB_EVENT]),
    );
    const error = await removeSiteDbResidue(local(), WITH_CRON).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(SiteDbResidueRemovalFailedError);
    expect((error as SiteDbResidueRemovalFailedError).cronEvents).toEqual([
      JOB_EVENT,
    ]);
    expect((error as Error).message).toContain(
      'cron event backwpup_cron {"arg":4}',
    );
    expect((error as Error).message).toMatch(
      /WP-Cron run in progress .* retried once/,
    );
    expect(calls()).toHaveLength(5);
    expect(calls()[3]).toContain("wp_unschedule_hook( $hook )");
  });

  // A WP-Cron run that read the array before the removal wrote it reschedules a recurring event
  // right after; one more removal clears it.
  test("removes WP-Cron events a second time when only they survived the first", async () => {
    replies(
      found([], [], [], [], [JOB_EVENT]),
      found(),
      found([], [], [], [], [JOB_EVENT]),
      found(),
      found(),
    );
    expect((await removeSiteDbResidue(local(), WITH_CRON)).cronEvents).toEqual([
      JOB_EVENT,
    ]);
    expect(calls()).toHaveLength(5);
  });

  // Anything beside the events is not a WP-Cron run's doing: no retry.
  test("does not retry when an option survived beside a WP-Cron event", async () => {
    replies(
      found(["backwpup_version"], [], [], [], [JOB_EVENT]),
      found(),
      found(["backwpup_version"], [], [], [], [JOB_EVENT]),
    );
    await expect(removeSiteDbResidue(local(), WITH_CRON)).rejects.toThrow(
      SiteDbResidueRemovalFailedError,
    );
    expect(calls()).toHaveLength(3);
  });

  // An event's arguments are the site's data: a credential in them is masked, a huge list capped.
  test("masks and caps a surviving WP-Cron event's arguments in the message", async () => {
    const leaky: CronEvent = {
      hook: "backwpup_cron",
      time: 1,
      args: '{"url":"https://admin:hunter2secret@example.com/"}',
    };
    const huge: CronEvent = {
      hook: "backwpup_cron",
      time: 2,
      args: "x".repeat(2000),
    };
    replies(
      found([], [], [], [], [leaky, huge]),
      found(),
      found([], [], [], [], [leaky, huge]),
    );
    const error = await removeSiteDbResidue(local(), WITH_CRON).catch(
      (caught: unknown) => caught,
    );
    const message = (error as Error).message;
    expect(message).not.toContain("hunter2secret");
    expect(message).toContain("https://***@example.com/");
    const hugeLine = message.split("\n").find((line) => line.includes("xxx"));
    expect(hugeLine).toBeDefined();
    // ASCII plus "…", one UTF-16 unit each: the length is the code-point count capLine caps at 500.
    expect(hugeLine).toHaveLength(500);
    expect(hugeLine?.endsWith("…")).toBe(true);
    // The field keeps what the site holds; only the message is masked.
    expect((error as SiteDbResidueRemovalFailedError).cronEvents).toEqual([
      leaky,
      huge,
    ]);
  });

  test("refuses a core WP-Cron hook without asking the site anything", async () => {
    await expect(
      removeSiteDbResidue(local(), {
        ...BACKWPUP,
        cronHooks: ["wp_version_check"],
      }),
    ).rejects.toThrow(/one of WordPress's own WP-Cron hooks/);
    expect(calls()).toEqual([]);
  });

  // The guard has to fire *before* anything is deleted, or it is only a nicer way to describe a
  // site that has already lost its home URL.
  test("refuses the whole sweep when the match reached a protected option", async () => {
    replies(found(["backwpup_version", "siteurl"]));
    await expect(removeSiteDbResidue(local(), BACKWPUP)).rejects.toThrow(
      /nothing has been removed/,
    );
    expect(calls()).toHaveLength(1);
  });

  // A declaration is validated in full before the site is touched, so one bad entry cannot leave a
  // site half-swept.
  test("refuses a bad declaration without asking the site anything", async () => {
    await expect(
      removeSiteDbResidue(local(), {
        optionsContaining: ["backwpup"],
        tables: ["users"],
      }),
    ).rejects.toThrow(/one of WordPress's own tables/);
    expect(calls()).toEqual([]);
  });
});
