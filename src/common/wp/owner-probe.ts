import { posix } from "node:path";

import { execAsTransport, wpRootDir } from "./transport-exec";
import type { Transport } from "../config/types";

/**
 * Who owns a site's files and who the transport's user is: the read-only probes and their parsers,
 * run as the **transport's user** whatever the site's identity state, since that state is decided
 * from them (`./site-identity.ts`) and `./ownership.ts` acts on them. Apart from `./ownership.ts` so
 * neither the identity resolver nor the web probe imports what imports them.
 *
 * Linux only: `stat -c` and `id` in their GNU/coreutils form, BusyBox's unmapped-name answers
 * handled (see {@link parseStatOwnership} and {@link parseIdentity}).
 */

/** The user and group a path belongs to, by name and by id. */
export interface SiteOwnership {
  readonly user: string;
  readonly group: string;
  readonly uid: number;
  readonly gid: number;
}

/**
 * Who the transport's own commands run as, and every group they carry — **by id and by name**.
 *
 * Both spellings are kept because a target's ownership is not always known in both: a site that
 * declares `transport.fileOwner` names a user and group without ids, and resolving them would cost
 * two more round-trips for a value `id` already reported. Comparing on whichever the target has is
 * what keeps a declared override from being mistaken for "not a member of anything" — an error that
 * would silently make the tree world-writable.
 */
export interface TransportIdentity {
  readonly uid: number;
  readonly gid: number;
  /** Every group id in the process's group set, including the primary one. */
  readonly groupIds: readonly number[];
  /** The user's name, absent when the passwd database cannot map the uid. */
  readonly user?: string;
  /**
   * The names of the groups in {@link groupIds} that the group database could map — so possibly
   * fewer entries, and never positionally aligned with it. The primary group is included whenever
   * `id` named it, even if `groups=` did not repeat it.
   */
  readonly groupNames: readonly string[];
}

/**
 * Parses `stat -c '%U:%G:%u:%g'`.
 *
 * The name halves are whatever `stat` could look up, and the two implementations this suite meets
 * disagree about failure: GNU prints the numeric id, **BusyBox prints the literal `UNKNOWN`**
 * (measured on 1.37.0, the `wordpress:cli-php8.3` image — `wp-content` there reads
 * `UNKNOWN:UNKNOWN:33:33`). A name is only ever handed straight back to `chown`, and
 * `chown UNKNOWN:UNKNOWN` can never succeed, so an unmapped name is replaced by the id from the
 * same call — which is what the kernel stores anyway, and what `matches` (`./ownership.ts`) verifies against.
 *
 * @param stdout - the raw output of `stat -c '%U:%G:%u:%g'`.
 * @returns the ownership, or `undefined` if the output is not the expected shape.
 */
export function parseStatOwnership(stdout: string): SiteOwnership | undefined {
  const [user, group, uid, gid, ...rest] = stdout.trim().split(":");
  if (
    user === undefined ||
    group === undefined ||
    uid === undefined ||
    gid === undefined ||
    rest.length > 0 ||
    user === "" ||
    group === ""
  ) {
    return undefined;
  }
  // Tested as digits rather than through `Number`, which reads "" as 0 (root) and "0x21" as 33.
  if (!/^\d+$/.test(uid) || !/^\d+$/.test(gid)) return undefined;
  return {
    user: mappedName(user, uid),
    group: mappedName(group, gid),
    uid: Number(uid),
    gid: Number(gid),
  };
}

/**
 * The name to use for a `chown` argument: the one `stat` reported, or the id when it reported none.
 *
 * Substituting is safe even for a host with a real account called `UNKNOWN`: the id comes from the
 * same `stat` call, so it names the same owner either way.
 */
function mappedName(name: string, id: string): string {
  return name === "UNKNOWN" ? id : name;
}

/**
 * Parses bare `id` output: `uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),33(www-data)`.
 *
 * One command answers every question needed to choose the mode grant — who we are, and every group
 * we carry, in both spellings — so the decision costs one round-trip rather than three. A name is
 * absent for an id the passwd/group database cannot map, which is why the ids are read
 * independently of the names rather than from them.
 *
 * @param stdout - the raw output of `id`, run with no arguments.
 * @returns the identity, or `undefined` if `uid=` or `gid=` is missing.
 */
export function parseIdentity(stdout: string): TransportIdentity | undefined {
  // The single line `id` printed, not the whole stream. A shell that greets on a non-interactive
  // channel (a `.bashrc` echo, an MOTD) would otherwise let a banner containing `uid=0(root)` supply
  // the uid while the real line supplies the gid — a chimera identity, and one that decides whether
  // a tree is made world-writable.
  const line = /^\s*uid=\d+.*$/m.exec(stdout)?.[0] ?? "";
  const uid = /(?:^|\s)uid=(\d+)/.exec(line)?.[1];
  const gid = /(?:^|\s)gid=(\d+)/.exec(line)?.[1];
  if (uid === undefined || gid === undefined) return undefined;

  // Captured to end of line, not as a run of non-spaces: a group name may contain a space
  // (`513(domain users)` on a directory-joined host), and stopping at it would silently drop every
  // group after it — including, potentially, the one that keeps the tree from being world-writable.
  const groups = /(?:^|\s)groups=(.*)$/.exec(line)?.[1] ?? "";
  const { ids, names } = parseGroupSet(groups);

  const gidNumber = Number(gid);
  const user = /(?:^|\s)uid=\d+\(([^)]*)\)/.exec(line)?.[1];
  const primaryGroup = /(?:^|\s)gid=\d+\(([^)]*)\)/.exec(line)?.[1];
  return {
    uid: Number(uid),
    gid: gidNumber,
    // The primary group is not always repeated in `groups=`, and treating it as absent would push a
    // correctly-configured host onto the world-writable branch. Both spellings are backfilled, not
    // just the id: a site that declares `transport.fileOwner` by name is compared by name, so
    // backfilling only the id would leave exactly that host world-writable for a false reason.
    groupIds: ids.includes(gidNumber) ? ids : [...ids, gidNumber],
    groupNames:
      primaryGroup === undefined || names.includes(primaryGroup)
        ? names
        : [...names, primaryGroup],
    ...(user !== undefined ? { user } : {}),
  };
}

/**
 * Splits the `groups=` list into ids and names, accepting both spellings `id` is written in.
 *
 * GNU prints `1000(ubuntu),33(www-data)`; BusyBox prints bare ids (`33,1000`) when it cannot map
 * them. Each entry is anchored to the start of the list or to a comma, so digits *inside* a group
 * name are never read as an id, and a name containing a space keeps it. A name is optional per
 * entry, which is what stops a nameless host from losing its memberships altogether — every lost
 * membership is a step towards a world-writable grant.
 *
 * @param groups - the raw value of `groups=`, to end of line.
 * @returns the ids, and the names of those entries that carried one.
 */
function parseGroupSet(groups: string): {
  readonly ids: number[];
  readonly names: string[];
} {
  const ids: number[] = [];
  const names: string[] = [];
  for (const match of groups.matchAll(/(?:^|,)\s*(\d+)(?:\(([^)]*)\))?/g)) {
    const [, id, name] = match;
    if (id !== undefined) ids.push(Number(id));
    if (name !== undefined) names.push(name);
  }
  return { ids, names };
}

/**
 * Reads the ownership of one absolute path on the target.
 *
 * `undefined` means the command **ran** and the answer was unusable — the path does not exist, or
 * `stat` printed something unparseable. A transport that could not run it at all **throws**, which
 * is the distinction the memoising callers depend on: only a real answer is worth remembering.
 */
export async function probeOwnership(
  transport: Transport,
  path: string,
): Promise<SiteOwnership | undefined> {
  const { exitCode, stdout } = await execAsTransport(transport, "stat", [
    "-c",
    "%U:%G:%u:%g",
    path,
  ]);
  return exitCode === 0 ? parseStatOwnership(stdout) : undefined;
}

/**
 * Reads who the transport's own user is (`id`, as the transport's user whatever the site runs as).
 * Throws if it could not be asked — see {@link probeOwnership}.
 */
export async function probeIdentity(
  transport: Transport,
): Promise<TransportIdentity | undefined> {
  const { exitCode, stdout } = await execAsTransport(transport, "id", []);
  return exitCode === 0 ? parseIdentity(stdout) : undefined;
}

/**
 * The ownership this site's WordPress install uses, unmemoised: `wp-content`'s, else the root's (a
 * relocated `wp-content`).
 *
 * For a caller that must tell "could not answer" from "the transport failed", which
 * {@link detectSiteOwnership} folds together.
 *
 * @param transport - the target site's transport.
 * @returns the ownership, or `undefined` when neither path could be read.
 * @throws Error if the transport failed.
 */
export async function probeSiteOwnership(
  transport: Transport,
): Promise<SiteOwnership | undefined> {
  const root = await wpRootDir(transport);
  return (
    (await probeOwnership(transport, posix.join(root, "wp-content"))) ??
    (await probeOwnership(transport, root))
  );
}
