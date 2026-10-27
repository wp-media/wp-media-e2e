import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  verifyPool,
  verifySite,
  warnAboutElevation,
  warnAboutPluginDirs,
} from "./preflight";
import { resetOwnershipCaches } from "../wp/ownership";
import type { CheckResult } from "./preflight";
import type { HealCellPlugin } from "./cell-plugin";
import type { ClearedPluginDir } from "../wp/plugin";
import type { SiteConfig } from "../config/types";

// A stub `wp` on PATH exercises the real exec layer + preflight with deterministic exit codes —
// no WordPress, no database. Behaviour is chosen per test via two env vars:
//   $WP_STUB_INFO       fail                     → `wp --info` exits 1 (WP-CLI "missing")
//   $WP_STUB_INSTALLED  no | nowp | phpold | *   → `wp core is-installed`:
//        no     → exit 1, silent            (genuinely not installed — tables missing)
//        nowp   → exit 1, stderr "Error…"   (target is not a WordPress directory)
//        phpold → exit 1, stdout PHP error  (installed, but PHP too old to boot — core printf()s
//                                            to STDOUT and exit(1); the historical false negative)
//        *      → exit 0                     (installed)
//   $WP_STUB_LOCALE     <locale> | fail | *  → `wp eval 'echo determine_locale();'`:
//        fail   → exit 1                    (could not be evaluated)
//        unset  → en_US                     (the English default)
//        other  → that locale               (e.g. fr_FR, to exercise the failure path)
//        fatal  → exit 1, a plugin's fatal on stderr (WordPress cannot boot — measured wording)
//   $WP_STUB_PLUGIN_DIRS  <json> | unset      → the plugin-folder inspection (`--skip-plugins … eval`):
//        unset  → exit 1                    (could not be inspected)
//        json   → printed as the reply
//   $WP_STUB_BOOTS_WITHOUT  <slug> | unset  → `wp --skip-plugins=<slug> eval …`: en_US for that slug,
//        else the fatal again (skipping that plugin does not help)
const STUB_WP = `#!/usr/bin/env bash
case "$1" in
  --skip-plugins=*)
    [ -n "$WP_STUB_LOG_CALLS" ] && echo "$1" >> "$WP_STUB_LOG_CALLS"
    if [ "$1" = "--skip-plugins=$WP_STUB_BOOTS_WITHOUT" ]; then printf en_US; exit 0; fi
    echo "Fatal error: Uncaught Error: still broken" >&2
    exit 1 ;;
esac
if [ "$1" = "--skip-plugins" ]; then
  [ -n "$WP_STUB_LOG_CALLS" ] && echo "inspect" >> "$WP_STUB_LOG_CALLS"
  [ -z "$WP_STUB_PLUGIN_DIRS" ] && { echo "Error: stub has no reply" >&2; exit 1; }
  printf '%s' "$WP_STUB_PLUGIN_DIRS"
  exit 0
fi
if [ "$1" = "--info" ]; then
  [ "$WP_STUB_INFO" = "fail" ] && { echo "wp: not found" >&2; exit 1; }
  echo "WP-CLI version: 2.10.0"
  exit 0
fi
if [ "$1 $2" = "core is-installed" ]; then
  case "$WP_STUB_INSTALLED" in
    no)     exit 1 ;;
    nowp)   echo "Error: This does not seem to be a WordPress installation." >&2; exit 1 ;;
    phpold) echo "Your server is running PHP version 7.3.33 but WordPress 7.0 requires at least 7.4."; exit 1 ;;
    *)      exit 0 ;;
  esac
fi
if [ "$1" = "eval" ]; then
  [ "$WP_STUB_LOCALE" = "fail" ] && exit 1
  if [ "$WP_STUB_LOCALE" = "fatal" ]; then
    echo 'Fatal error: Uncaught Error: Class "WPMedia\\BackWPup\\Dependencies\\BerlinDB\\Database\\Table" not found in /srv/site/wp-content/plugins/backwpup-pro/src/Common/Database/Tables/AbstractTable.php:12' >&2
    echo 'Stack trace:' >&2
    echo 'Error: There has been a critical error on this website.' >&2
    exit 1
  fi
  printf '%s' "\${WP_STUB_LOCALE:-en_US}"
  exit 0
fi
exit 0
`;

let stubDir: string;
let wpRoot: string;
let originalPath: string;

/**
 * A real, non-placeholder local site pointing `wp` at `wpRoot`.
 *
 * `elevate: false` by default, and deliberately: pre-flight now probes privileges, and a unit run
 * must not shell out to the real `sudo` on whatever machine happens to be running it — that would
 * make the result depend on the developer's sudoers file and leave failed-auth entries in the
 * system log. Tests that care about elevation set it explicitly.
 */
function localSite(baseURL = "http://localhost:8100"): SiteConfig {
  return {
    baseURL,
    username: "admin",
    password: "admin_password",
    transport: { mode: "local", rootDir: wpRoot, elevate: false },
    storageState: join(wpRoot, "state.json"),
  };
}

test.beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), "wp-stub-"));
  writeFileSync(join(stubDir, "wp"), STUB_WP);
  chmodSync(join(stubDir, "wp"), 0o755);
  // A real directory so the rootDir check passes; the stub ignores its contents.
  wpRoot = mkdtempSync(join(tmpdir(), "wp-root-"));
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${stubDir}:${originalPath}`;
});

test.afterAll(() => {
  process.env.PATH = originalPath;
  delete process.env.WP_STUB_INFO;
  delete process.env.WP_STUB_INSTALLED;
  delete process.env.WP_STUB_LOCALE;
  rmSync(stubDir, { recursive: true, force: true });
  rmSync(wpRoot, { recursive: true, force: true });
});

// The locale gate protects every role/label locator in the suite: a translated admin would otherwise
// surface as dozens of indistinguishable locator timeouts instead of one named failure here.
test.beforeEach(() => {
  // Every describe here shares one `wpRoot`, so they share one ownership cache entry too.
  resetOwnershipCaches();
});

// What a killed run left can stop WordPress booting; the gates would then skip the fixtures settling it.
test.describe("verifyPool — settling leftovers before the gates", () => {
  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    delete process.env.WP_STUB_LOCALE;
  });

  test("settles every real site first, so a site it repairs passes the gates", async () => {
    process.env.WP_STUB_INSTALLED = "no";
    const settled: string[] = [];
    await expect(
      verifyPool(
        [localSite(), localSite("https://p.example.test")],
        "backwpup",
        "local",
        [],
        undefined,
        (site) => {
          settled.push(site.baseURL);
          process.env.WP_STUB_INSTALLED = "yes";
          return Promise.resolve();
        },
      ),
    ).resolves.toBeUndefined();
    expect(settled).toEqual(["http://localhost:8100"]);
  });

  // The product's own checks refuse the site later, in their own words; the gates judge it as found.
  test("warns about a site it could not settle, and checks it as found", async () => {
    process.env.WP_STUB_INSTALLED = "yes";
    const warnings: string[] = [];
    const warn = console.warn;
    console.warn = (message: string) => warnings.push(message);
    try {
      await expect(
        verifyPool([localSite()], "backwpup", "local", [], undefined, () =>
          Promise.reject(new Error("a copy is left")),
        ),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = warn;
    }
    expect(warnings).toContain(
      "[preflight] http://localhost:8100: left as found — a copy is left",
    );
  });
});

test.describe("verifyPool — admin locale gate", () => {
  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "yes";
  });

  // Cleared after every test in this block: the other describes share the process and know nothing
  // about this variable, so a leaked non-English locale would fail them for the wrong reason.
  test.afterEach(() => {
    delete process.env.WP_STUB_LOCALE;
  });

  test("passes on the English default", async () => {
    delete process.env.WP_STUB_LOCALE;
    await expect(
      verifyPool([localSite()], "backwpup", "local"),
    ).resolves.toBeUndefined();
  });

  test("passes on other English variants", async () => {
    process.env.WP_STUB_LOCALE = "en_GB";
    await expect(
      verifyPool([localSite()], "backwpup", "local"),
    ).resolves.toBeUndefined();
  });

  test("fails with an actionable report on a translated admin", async () => {
    process.env.WP_STUB_LOCALE = "fr_FR";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("Admin locale is English");
    expect(message).toContain("fr_FR");
    // The hint must name the fix, since the cause is a site setting and not a code problem.
    expect(message).toContain("Site Language");
  });

  test("names a site in its report by maskSiteUrl: a baseURL that is no URL is never printed", async () => {
    process.env.WP_STUB_LOCALE = "fr_FR";
    const error = await verifyPool(
      [localSite("https://admin:pa ss-word9@bad host/")],
      "backwpup",
      "local",
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain("Site 0 — (not a valid http(s) URL)");
    expect(message).not.toContain("ss-word9");
  });

  test("reports a locale it cannot read, rather than assuming English", async () => {
    process.env.WP_STUB_LOCALE = "fail";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Could not read the admin locale",
    );
  });

  // A site whose WordPress does not boot must report that, not a second failure about its locale —
  // the locale check only runs once every transport-level check has passed.
  test("is not run when an earlier check already failed", async () => {
    process.env.WP_STUB_INSTALLED = "no";
    process.env.WP_STUB_LOCALE = "fr_FR";
    const error = await verifyPool([localSite()], "backwpup", "local").catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("WordPress is not installed");
    expect((error as Error).message).not.toContain("Admin locale");
  });
});

test.describe("verifyPool — local transport over a stub wp", () => {
  test("resolves when WP-CLI runs and WordPress is installed", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "yes";
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).resolves.toBeUndefined();
  });

  test("throws an actionable report when WordPress is not installed", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "no";
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("WordPress installed");
    expect(message).toContain("not installed");
    // The WP-CLI step still passed, so it is reported as a green check, not the failure.
    expect(message).toContain("wp-cli 2.10.0");
  });

  test("surfaces wp-cli's stderr when the target is not a WordPress install", async () => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "nowp";
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).rejects.toThrow(/does not seem to be a WordPress installation/);
  });

  test("reports a PHP-version bootstrap error as unusable, not 'not installed'", async () => {
    // The real-world false negative: WordPress IS installed, but WP-CLI ran it under a PHP older
    // than WordPress requires, so core printf()s its version error to STDOUT and exit(1) — which
    // by exit code alone is indistinguishable from a genuinely missing install.
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "phpold";
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    // Must NOT be misreported as a missing install...
    expect(message).not.toContain("not installed");
    expect(message).not.toContain("database tables are missing");
    // ...must surface WordPress's own message (which core prints to stdout, not stderr)...
    expect(message).toContain("requires at least 7.4");
    // ...and steer the operator toward PHP rather than a phantom missing database.
    expect(message).toMatch(/PHP/);
  });

  test("skips the WordPress check when WP-CLI itself is unavailable", async () => {
    process.env.WP_STUB_INFO = "fail";
    process.env.WP_STUB_INSTALLED = "yes"; // would pass — but must never be reached
    const error = await verifyPool([localSite()], "wp-rocket", "local").catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("WP-CLI");
    // Gated on the WP-CLI check, so the WordPress probe must not run or be reported.
    expect(message).not.toContain("WordPress installed");
  });

  test("silently skips placeholder (.example.test) sites", async () => {
    // Even with a broken WordPress, a placeholder site has no real transport to verify.
    process.env.WP_STUB_INSTALLED = "no";
    await expect(
      verifyPool(
        [localSite("https://shop.example.test")],
        "wp-rocket",
        "local",
      ),
    ).resolves.toBeUndefined();
  });
});

/**
 * The two informational checks.
 *
 * Neither describes a fault: a site whose ownership cannot be corrected, or which may not elevate,
 * still runs every scenario — it simply cleans up less. So the property under test is that they
 * *report* without ever changing a verdict, and that they run only once the transport itself is
 * known good.
 *
 * Elevation is pinned via `transport.elevate: false` rather than by probing `sudo`, because whether
 * the machine running these tests happens to have passwordless sudo is not a property of this code.
 */
test.describe("verifySite — ownership & elevation reporting", () => {
  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    delete process.env.WP_STUB_LOCALE;
    process.env.WP_STUB_INSTALLED = "yes";
    resetOwnershipCaches();
  });

  /** The named check from a site's results, or `undefined` if it never ran. */
  const check = (
    checks: readonly CheckResult[],
    name: string,
  ): CheckResult | undefined => checks.find((entry) => entry.name === name);

  test("reports both, and neither can fail the site", async () => {
    const result = await verifySite(localSite(), 0);

    expect(check(result.checks, "File ownership")?.ok).toBe(true);
    expect(check(result.checks, "Elevation")?.ok).toBe(true);
    expect(result.checks.every((entry) => entry.ok)).toBe(true);
  });

  test("carries the elevation state as a value, not only as prose", async () => {
    const result = await verifySite(localSite(), 0);

    // The run-level warning reads this rather than parsing a detail string back apart.
    expect(result.elevation).toBe("disabled");
    expect(check(result.checks, "Elevation")?.detail).toMatch(
      /transport\.elevate: false/,
    );
  });

  test("reports an ownership opt-out as the deliberate choice it is", async () => {
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, fileOwner: false } },
      0,
    );

    const ownership = check(result.checks, "File ownership");
    expect(ownership?.ok).toBe(true);
    expect(ownership?.detail).toMatch(/transport\.fileOwner: false/);
  });

  /**
   * The one ownership case that **fails** the site, and the exception proves the rule: every other
   * branch describes a property of the *host*, which the suite adapts to. This one is our own
   * configuration being unreadable, and a check that renders an error message beside a green tick is
   * a check nobody acts on. The sites loader rejects the same value, so reaching this at all means
   * the transport was built in code.
   */
  test("fails the site for a fileOwner that cannot be parsed", async () => {
    const site = localSite();
    const result = await verifySite(
      {
        ...site,
        transport: { ...site.transport, fileOwner: "not a valid spec" },
      },
      0,
    );

    expect(check(result.checks, "File ownership")?.ok).toBe(false);
    expect(check(result.checks, "File ownership")?.detail).toMatch(
      /must be "user:group"/,
    );
    // …and it is the only thing wrong: the host itself is fine.
    expect(
      result.checks.filter((entry) => !entry.ok).map((entry) => entry.name),
    ).toEqual(["File ownership"]);
  });

  /**
   * A site that needs a handover it may not perform must be told it **cannot** happen.
   *
   * `planOwnership` deliberately says nothing about privileges, so without folding the elevation
   * answer in, this line reads "will be handed to …" on a host that will never hand anything over —
   * and in the `disabled` case no run-level banner contradicts it, so the report is simply wrong
   * with nothing to catch it.
   *
   * Reaching that branch needs ownership that differs from the runner's, which is what the stubbed
   * `stat`/`id` provide.
   */
  test("says a needed handover cannot happen when privileges are unavailable", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "wp-pf-stub-"));
    const shim = (name: string, body: string): void => {
      writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(binDir, name), 0o755);
    };
    shim("stat", 'printf "%s" "www-data:www-data:33:33"');
    shim(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    const pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
    resetOwnershipCaches();

    try {
      const result = await verifySite(localSite(), 0);
      const ownership = check(result.checks, "File ownership");

      expect(ownership?.ok).toBe(true);
      expect(ownership?.detail).toMatch(/cannot be/);
      expect(ownership?.detail).toMatch(/elevation is disabled/);
      // …and it must not claim the handover as a future fact.
      expect(ownership?.detail).not.toMatch(/will be handed/);
    } finally {
      process.env.PATH = pathBefore;
      rmSync(binDir, { recursive: true, force: true });
      resetOwnershipCaches();
    }
  });

  // Both run commands on the site, so asking a transport that has already failed would only produce
  // a second way of saying the same thing.
  test("runs neither when the transport itself failed", async () => {
    process.env.WP_STUB_INSTALLED = "no";
    const result = await verifySite(localSite(), 0);

    expect(check(result.checks, "File ownership")).toBeUndefined();
    expect(check(result.checks, "Elevation")).toBeUndefined();
    expect(result.elevation).toBeUndefined();
  });

  test("a site that may not elevate still passes pre-flight", async () => {
    await expect(
      verifyPool([localSite()], "wp-rocket", "local"),
    ).resolves.toBeUndefined();
  });
});

/**
 * The only state that produces the run-level banner, end to end.
 *
 * Everything else about elevation is pinned against `disabled`, which is silent by design — so
 * without this, `verifySite` could stop populating `elevation`, or either caller could stop calling
 * `warnAboutElevation`, and the whole suite would still be green. `sudo` is shimmed rather than
 * real: the answer must not depend on the sudoers file of whatever machine runs the tests.
 */
test.describe("verifySite → warnAboutElevation — the wiring the banner depends on", () => {
  let binDir: string;
  let pathBefore: string;

  const shim = (name: string, body: string): void => {
    writeFileSync(join(binDir, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(binDir, name), 0o755);
  };

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-pf-elev-"));
    shim("sudo", "exit 1"); // a sudoer who is not passwordless, and never the real binary
    shim("stat", 'printf "%s" "www-data:www-data:33:33"');
    shim(
      "id",
      'printf "%s" "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)"',
    );
    pathBefore = process.env.PATH ?? "";
    process.env.PATH = `${binDir}:${pathBefore}`;
    resetOwnershipCaches();
  });

  test.afterEach(() => {
    process.env.PATH = pathBefore;
    rmSync(binDir, { recursive: true, force: true });
    resetOwnershipCaches();
  });

  test("carries the unavailable verdict and the pending handover onto the result", async () => {
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, elevate: undefined } },
      0,
    );

    const elevation = result.checks.find((entry) => entry.name === "Elevation");
    expect(result.elevation).toBe("unavailable");
    expect(result.ownershipPending).toBe(true);
    // Still not a failure: privileges are a property of the host, not a fault in it.
    expect(elevation?.ok).toBe(true);
  });

  /**
   * The call site, not just the renderer. Deleting `warnAboutElevation(results)` from `verifyPool`
   * leaves every other test in this file green, so this is the only thing standing between a silent
   * refactor and a run that never warns about a fleet it cannot clean up.
   */
  /**
   * The two checks describe one site and must not contradict each other. When ownership could not be
   * read at all, the elevation line may not answer "needs no change here" — the line directly above
   * it has just said the opposite.
   */
  test("does not claim ownership is settled when it could not be read", async () => {
    shim("stat", "exit 1");
    const site = localSite();
    const result = await verifySite(
      { ...site, transport: { ...site.transport, elevate: undefined } },
      0,
    );
    const ownership = result.checks.find((c) => c.name === "File ownership");
    const elevation = result.checks.find((c) => c.name === "Elevation");

    expect(ownership?.detail).toMatch(/Could not be read/);
    expect(elevation?.detail).not.toMatch(/needs no change/);
    expect(elevation?.detail).toMatch(
      /ownership normalization will be incomplete/,
    );
  });

  test("and pool verification actually prints it", async () => {
    const printed: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      printed.push(args.map(String).join(" "));
    };
    try {
      const site = localSite();
      await verifyPool(
        [{ ...site, transport: { ...site.transport, elevate: undefined } }],
        "wp-rocket",
        "local",
      );
    } finally {
      console.warn = realWarn;
    }

    expect(printed.join("\n")).toContain("ELEVATION UNAVAILABLE");
  });

  test("and that result is what makes the banner print", () => {
    const printed: string[] = [];
    warnAboutElevation(
      [
        {
          index: 0,
          baseURL: "http://broken.test",
          transport: { mode: "local", rootDir: "/var/www/broken" },
          checks: [],
          elevation: "unavailable",
          ownershipPending: true,
        },
      ],
      (message) => printed.push(message),
    );

    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain("ELEVATION UNAVAILABLE");
    expect(printed[0]).toContain("http://broken.test");
  });

  // The silent case, asserted rather than assumed: a site that opted out must not produce a banner.
  test("a site that declined privileges produces nothing", () => {
    const printed: string[] = [];
    warnAboutElevation(
      [
        {
          index: 0,
          baseURL: "http://opted-out.test",
          transport: { mode: "local", rootDir: "/var/www/opted-out" },
          checks: [],
          elevation: "disabled",
          ownershipPending: true,
        },
      ],
      (message) => printed.push(message),
    );

    expect(printed).toEqual([]);
  });
});

/**
 * The leftover plugin folders, end to end: the inspection, the always-passing check, the value the
 * run-level banner reads, and both call sites that print it.
 */
test.describe("verifySite — leftover plugin folders", () => {
  const orphaned = {
    kind: "orphaned",
    path: "/srv/site/wp-content/plugins/backwpup-pro",
    type: "directory",
    owner: "www-data",
    age: 7200,
    sample: ["src", "vendor"],
    entries: 3830,
    top: 2,
  };
  const reply = (pro: object): string =>
    JSON.stringify({
      backwpup: {
        kind: "absent",
        path: "/srv/site/wp-content/plugins/backwpup",
      },
      "backwpup-pro": pro,
    });
  const SLUGS = ["backwpup", "backwpup-pro"];
  let callLog: string;

  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    delete process.env.WP_STUB_LOCALE;
    process.env.WP_STUB_INSTALLED = "yes";
    callLog = join(wpRoot, "inspections.log");
    process.env.WP_STUB_LOG_CALLS = callLog;
  });

  test.afterEach(() => {
    delete process.env.WP_STUB_PLUGIN_DIRS;
    delete process.env.WP_STUB_LOG_CALLS;
    rmSync(callLog, { force: true });
  });

  const check = (result: {
    checks: readonly CheckResult[];
  }): CheckResult | undefined =>
    result.checks.find((entry) => entry.name === "Plugin folders");

  test("asks nothing when no slugs are given", async () => {
    const result = await verifySite(localSite(), 0);
    expect(check(result)).toBeUndefined();
    expect(result).not.toHaveProperty("leftoverPluginDirs");
    expect(existsSync(callLog)).toBe(false);
  });

  test("passes a site with nothing left over, naming the slugs it looked at", async () => {
    process.env.WP_STUB_PLUGIN_DIRS = reply({ kind: "absent", path: "/x" });
    const result = await verifySite(localSite(), 0, SLUGS);
    expect(check(result)).toEqual({
      name: "Plugin folders",
      ok: true,
      detail: "Nothing WordPress cannot see at backwpup, backwpup-pro.",
    });
    expect(result.leftoverPluginDirs).toEqual([]);
  });

  test("reports a folder WordPress lists no plugin in, without failing the site", async () => {
    process.env.WP_STUB_PLUGIN_DIRS = reply(orphaned);
    const result = await verifySite(localSite(), 0, SLUGS);
    expect(check(result)?.ok).toBe(true);
    expect(check(result)?.detail).toContain(
      "the next @plugin scenario removes it",
    );
    expect(result.leftoverPluginDirs).toEqual([
      "/srv/site/wp-content/plugins/backwpup-pro: a folder WordPress lists no plugin in, 3830 " +
        "entries (src, vendor); owner www-data; last changed 2 h ago",
    ]);
    expect(result.checks.every((entry) => entry.ok)).toBe(true);
  });

  // An installed plugin is the next scenario's to uninstall as usual — nothing to warn about.
  test("does not report a plugin WordPress lists", async () => {
    process.env.WP_STUB_PLUGIN_DIRS = reply({
      ...orphaned,
      kind: "recognised",
    });
    expect(
      (await verifySite(localSite(), 0, SLUGS)).leftoverPluginDirs,
    ).toEqual([]);
  });

  test("says when the folders could not be inspected, still passing", async () => {
    const result = await verifySite(localSite(), 0, SLUGS);
    expect(check(result)?.ok).toBe(true);
    expect(check(result)?.detail).toMatch(
      /^Could not be inspected: .*stub has no reply/,
    );
  });

  test("and pool verification prints the banner for it", async () => {
    process.env.WP_STUB_PLUGIN_DIRS = reply(orphaned);
    const printed: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      printed.push(args.map(String).join(" "));
    };
    try {
      await verifyPool([localSite()], "backwpup", "local", SLUGS);
    } finally {
      console.warn = realWarn;
    }
    expect(printed.join("\n")).toContain("LEFTOVER PLUGIN FOLDERS");
    expect(printed.join("\n")).toContain(
      "backwpup-pro: a folder WordPress lists no plugin in",
    );
  });

  test("prints nothing for sites with nothing left over", () => {
    const printed: string[] = [];
    warnAboutPluginDirs(
      [
        {
          index: 0,
          baseURL: "http://clean.test",
          transport: { mode: "local", rootDir: "/var/www/clean" },
          checks: [],
          leftoverPluginDirs: [],
        },
        {
          index: 1,
          baseURL: "http://unasked.test",
          transport: { mode: "local", rootDir: "/var/www/unasked" },
          checks: [],
        },
      ],
      (message) => printed.push(message),
    );
    expect(printed).toEqual([]);
  });
});

/**
 * A broken copy of the cell's own plugin that stops WordPress booting: blamed only when WordPress boots
 * with that slug skipped, removed only through the `heal` the auth setup passes, reported otherwise.
 */
test.describe("verifySite — a broken copy of the cell's plugin", () => {
  const SLUG = "backwpup-pro";
  const cleared: ClearedPluginDir = {
    cause: "uninstall-failed",
    uninstallError: "PHP Fatal error:  Uncaught Error: Class not found",
    dir: {
      kind: "recognised",
      path: "/srv/site/wp-content/plugins/backwpup-pro",
      type: "directory",
      owner: "www-data",
      ageSeconds: 60,
      sample: ["backwpup.php", "src", "vendor"],
      entries: 5000,
      topLevel: 3,
    },
  };
  let callLog: string;
  let healed: string[];

  /** A heal that removes the copy as the real one would: WordPress boots again afterwards. */
  const heal: HealCellPlugin = (_transport, slug) => {
    healed.push(slug);
    delete process.env.WP_STUB_LOCALE;
    return Promise.resolve(cleared);
  };
  const names = (result: { checks: readonly CheckResult[] }): string[] =>
    result.checks.map((check) => `${check.ok ? "✓" : "✗"} ${check.name}`);
  const probes = (): string[] =>
    existsSync(callLog)
      ? readFileSync(callLog, "utf8").trim().split("\n").filter(Boolean)
      : [];

  test.beforeEach(() => {
    delete process.env.WP_STUB_INFO;
    process.env.WP_STUB_INSTALLED = "yes";
    process.env.WP_STUB_LOCALE = "fatal";
    process.env.WP_STUB_BOOTS_WITHOUT = SLUG;
    callLog = join(wpRoot, "skips.log");
    process.env.WP_STUB_LOG_CALLS = callLog;
    healed = [];
  });

  test.afterEach(() => {
    delete process.env.WP_STUB_LOCALE;
    delete process.env.WP_STUB_BOOTS_WITHOUT;
    delete process.env.WP_STUB_LOG_CALLS;
    rmSync(callLog, { force: true });
  });

  test("removes it with heal, then asks the locale again: the site passes", async () => {
    const result = await verifySite(localSite(), 0, [SLUG], heal);

    expect(healed).toEqual([SLUG]);
    expect(probes()).toContain(`--skip-plugins=${SLUG}`);
    expect(names(result).slice(3, 5)).toEqual([
      "✓ Plugin under test",
      "✓ Admin locale is English",
    ]);
    expect(result.checks.every((check) => check.ok)).toBe(true);
    const detail = result.checks[3]?.detail ?? "";
    expect(detail).toContain(
      `WordPress cannot boot with the cell's plugin "${SLUG}" loaded (Fatal error: Uncaught Error: Class`,
    );
    expect(detail).toContain(
      "removed /srv/site/wp-content/plugins/backwpup-pro: a folder WordPress lists a plugin in",
    );
    expect(result.healedCellPlugin).toBe(detail);
  });

  test("without heal, only reports it, in place of the locale check, and changes nothing", async () => {
    const result = await verifySite(localSite(), 0, [SLUG]);

    expect(healed).toEqual([]);
    expect(names(result)).toContain("✗ Plugin under test");
    expect(names(result).join("\n")).not.toContain("Admin locale");
    expect(result).not.toHaveProperty("healedCellPlugin");
    const check = result.checks.find((c) => c.name === "Plugin under test");
    expect(check?.hint).toContain(
      `\`wp --skip-plugins plugin deactivate ${SLUG}\``,
    );
  });

  test("a site that does not boot with the slug skipped either fails as before, untouched", async () => {
    process.env.WP_STUB_BOOTS_WITHOUT = "some-other-plugin";
    const result = await verifySite(localSite(), 0, [SLUG], heal);

    expect(healed).toEqual([]);
    expect(probes()).toContain(`--skip-plugins=${SLUG}`);
    const locale = result.checks.find(
      (c) => c.name === "Admin locale is English",
    );
    expect(locale?.ok).toBe(false);
    expect(locale?.detail).toContain("Fatal error: Uncaught Error: Class");
    expect(names(result).join("\n")).not.toContain("Plugin under test");
  });

  test("a heal that fails fails the site, naming why and how to remove it by hand", async () => {
    const failing: HealCellPlugin = () =>
      Promise.reject(new Error("PluginDirRemovalFailedError: still there"));
    const result = await verifySite(localSite(), 0, [SLUG], failing);

    const check = result.checks.find((c) => c.name === "Plugin under test");
    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(
      /, and removing it failed: PluginDirRemovalFailedError: still there$/,
    );
    expect(check?.hint).toContain(`wp-content/plugins/${SLUG}`);
    expect(names(result).join("\n")).not.toContain("Admin locale");
  });

  test("asks nothing with the slug skipped when the locale was read, or no slug is given", async () => {
    process.env.WP_STUB_LOCALE = "fr_FR";
    await verifySite(localSite(), 0, [SLUG], heal);
    process.env.WP_STUB_LOCALE = "fatal";
    await verifySite(localSite(), 0, [], heal);

    expect(
      probes().filter((line) => line.startsWith("--skip-plugins=")),
    ).toEqual([]);
    expect(healed).toEqual([]);
  });

  test("and pool verification says it removed it, on a passing pool", async () => {
    const printed: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]): void => {
      printed.push(args.map(String).join(" "));
    };
    try {
      await expect(
        verifyPool([localSite()], "backwpup", "local", [SLUG], heal),
      ).resolves.toBeUndefined();
    } finally {
      console.warn = realWarn;
    }
    expect(printed.join("\n")).toMatch(
      /\[preflight\] http:\/\/localhost:8100: WordPress cannot boot with the cell's plugin "backwpup-pro"/,
    );
  });
});
