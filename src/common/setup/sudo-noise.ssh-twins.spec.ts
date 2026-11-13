import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { verifySite } from "./preflight";
import type { SitePreflightResult } from "./preflight";
import { SITE_IDENTITY_CHECK } from "./site-identity-report";
import { SLOW_SUDO_LOOKUP_MS, probeSudoLookup } from "./sudo-lookup";
import {
  disposeConnections,
  exec,
  execAsTransport,
  execElevated,
  resetElevationCaches,
} from "../wp/exec";
import { resetOwnershipCaches } from "../wp/ownership";
import {
  resetSiteIdentityCaches,
  resolveSiteIdentity,
} from "../wp/site-identity";
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
} from "../__fixtures__/ssh-twins";

/**
 * A host that cannot resolve its own name, on the twins' real sudo (1.9.15, Ubuntu 24.04): its
 * `/etc/hosts` entry removed and its resolver replaced inside the container, so every sudo call prints
 * `sudo: unable to resolve host …` (checked before anything is judged). The suite must recover by
 * itself: the same checks, decisions and banner as on the resolvable host, no message quoting the line,
 * and — only when the resolver does not answer, so each sudo call waits — the wait reported.
 *
 * Opt-in (`E2E_SSH_TWINS=1`, with `npm run env:cells:up` done). Each test holds its twin
 * ({@link withTwin}), puts the container's files back, and the twin in {@link RESTING_VARIANT}.
 */

/** One cell per twin: the stack is what varies. */
const CELLS = TWIN_CELLS.filter((cell) => cell.product === "backwpup");

/**
 * How the host's resolver answers a name it has no entry for: `refusing` at once (nothing listens on
 * it: sudo's line, no wait), `silent` never (an unreachable address, 1 s per try: ~2 s per sudo call,
 * A and AAAA — glibc's defaults would make it ~20 s, measured).
 */
type Resolver = "refusing" | "silent";

/** Each resolver's `/etc/resolv.conf`. */
const RESOLV_CONF: Readonly<Record<Resolver, string>> = {
  refusing: "nameserver 127.0.0.1\n",
  silent: "nameserver 10.255.255.1\noptions timeout:1 attempts:1\n",
};

/**
 * Runs a shell script as root in a twin's container.
 *
 * @param twin - the cell.
 * @param script - the script.
 * @param input - its stdin.
 * @returns its stdout.
 */
function asRootIn(twin: TwinCell, script: string, input = ""): string {
  return execFileSync(
    "docker",
    ["exec", "-i", `wpme-ssh-${twin.stack}`, "sh", "-c", script],
    { input, encoding: "utf8" },
  );
}

/**
 * Makes the container's own name unresolvable, as {@link Resolver} says.
 *
 * @param twin - the cell.
 * @param resolver - how the resolver answers.
 * @returns what puts both files back as they were (written in place: Docker bind-mounts them).
 */
function unresolvableHost(twin: TwinCell, resolver: Resolver): () => void {
  const hosts = asRootIn(twin, "cat /etc/hosts");
  const resolv = asRootIn(twin, "cat /etc/resolv.conf");
  const name = asRootIn(twin, "hostname").trim();
  const kept = hosts
    .split("\n")
    .filter((line) => !line.split(/\s+/).slice(1).includes(name))
    .join("\n");
  asRootIn(twin, "cat > /etc/hosts", kept);
  asRootIn(twin, "cat > /etc/resolv.conf", RESOLV_CONF[resolver]);
  return () => {
    asRootIn(twin, "cat > /etc/hosts", hosts);
    asRootIn(twin, "cat > /etc/resolv.conf", resolv);
  };
}

/** Forgets every per-process answer, so each pass is judged afresh. */
function resetCaches(): void {
  disposeConnections();
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  resetElevationCaches();
  resetWpUserCaches();
}

/**
 * Runs `work` on a twin reset to `site`, putting the container's files and the twin back however it
 * ends.
 *
 * @param twin - the cell.
 * @param work - what to do; given what makes the host's name unresolvable.
 */
async function onSiteVariant(
  twin: TwinCell,
  work: (unresolvable: (resolver: Resolver) => void) => Promise<void>,
): Promise<void> {
  await withTwin(twin.stack, async () => {
    let restore: (() => void) | undefined;
    try {
      resetTwin(twin.stack, "site");
      resetCaches();
      await work((resolver) => {
        restore = unresolvableHost(twin, resolver);
      });
    } finally {
      restore?.();
      resetCaches();
      resetTwin(twin.stack, RESTING_VARIANT);
    }
  });
}

/**
 * The site's "Site identity" check detail.
 *
 * @param result - the site's result.
 */
const identityDetail = (result: SitePreflightResult): string =>
  result.checks.find((check) => check.name === SITE_IDENTITY_CHECK)?.detail ??
  "";

test.describe("SSH twins: a host that cannot resolve its own name", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);

  for (const twin of CELLS) {
    test(`${twin.stack}: sudo's line on every call changes no check, decision or message`, async ({
      playwright,
    }) => {
      // Two resets (~6 s each) and two pre-flights.
      test.setTimeout(240_000);
      await onSiteVariant(twin, async (unresolvable) => {
        const site = twinSite(twin);
        const options = { request: playwright.request };
        const resolvable = await verifySite(site, 0, [], undefined, options);
        resetCaches();
        unresolvable("refusing");
        const raw = await execAsTransport(site.transport, "sudo", [
          "-n",
          "true",
        ]);
        expect(raw.stderr).toMatch(/^sudo: unable to resolve host \S+: /);

        const noisy = await verifySite(site, 0, [], undefined, options);

        expect(noisy.checks).toEqual(resolvable.checks);
        expect(noisy.identityIssues).toEqual(resolvable.identityIssues);
        expect(noisy.elevation).toBe("available");
        expect((await resolveSiteIdentity(site.transport)).kind).toBe("site");
        const missing = ["/nonexistent-e2e"];
        const said =
          "ls: cannot access '/nonexistent-e2e': No such file or directory";
        for (const result of [
          await exec(site.transport, "ls", missing),
          await execElevated(site.transport, "ls", missing),
        ]) {
          expect(result).toEqual({ stdout: "", stderr: said, exitCode: 2 });
        }
        expect(JSON.stringify(noisy)).not.toContain("resolve host");
        // A resolver that refuses at once costs nothing worth a line.
        const lookup = await probeSudoLookup(site.transport, { kind: "root" });
        expect(lookup?.kind).toBe("unresolved");
        expect(
          lookup?.kind === "unresolved" ? lookup.waitMs : Infinity,
        ).toBeLessThan(SLOW_SUDO_LOOKUP_MS);
      });
    });
  }

  test("nginx: a resolver that never answers makes each sudo call wait; reported, never failed", async ({
    playwright,
  }) => {
    // Two resets (~6 s each) and a pre-flight whose every sudo call waits ~2 s.
    test.setTimeout(420_000);
    const twin = CELLS.find((cell) => cell.stack === "nginx");
    if (twin === undefined) throw new Error("no nginx twin cell");
    await onSiteVariant(twin, async (unresolvable) => {
      const site = twinSite(twin);
      unresolvable("silent");

      const result = await verifySite(site, 0, [], undefined, {
        request: playwright.request,
      });

      expect(result.checks.filter((check) => !check.ok)).toEqual([]);
      expect((await resolveSiteIdentity(site.transport)).kind).toBe("site");
      expect(identityDetail(result)).toMatch(
        /^Every sudo call waits about \d+\.\d s for this host's own name, which does not resolve/m,
      );
      expect(result.identityIssues?.map((issue) => issue.what)).toEqual([
        expect.stringMatching(/^every sudo call waits about \d+\.\d s/),
      ]);
      expect(JSON.stringify(result)).not.toMatch(/resolve host|\/etc\/hosts/);
      const lookup = await probeSudoLookup(site.transport, { kind: "root" });
      expect(
        lookup?.kind === "unresolved" ? lookup.waitMs : 0,
      ).toBeGreaterThanOrEqual(1500);
    });
  });
});
