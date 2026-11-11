import { posix } from "node:path";

import {
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  installKey,
  assertResolvedInsideRoot,
  resetElevationCaches,
  wpRootDir,
} from "./exec";
import { assertSafeElevatedTarget, normaliseSitePath } from "./paths";
import { parseOwnerSpec } from "../config/file-owner";
import { errorMessage } from "../guards";
import type { ExecResult } from "./exec";
import type { OwnerSpec } from "../config/file-owner";
import type { Transport } from "../config/types";

/**
 * Restoring a site's own file ownership after this suite writes into its docroot.
 *
 * **The problem.** On a real cell WP-CLI and the web server are different users sharing one
 * docroot — `ubuntu` over SSH, `www-data` under PHP-FPM. Everything WP-CLI installs is therefore
 * created by `ubuntu` under its umask (`0775`/`0664`, owned by itself), and the web server cannot
 * write inside it. The symptom is not a WordPress "enter your FTP credentials" prompt — WordPress
 * still selects its `direct` filesystem method, because that decision compares *core file*
 * ownership — it is a plain permission denial on the next write, from an admin request, a plugin
 * update, or a delete through the UI.
 *
 * **Who the files should belong to.** Not "the web server": on a host whose docroot is deployed
 * over SFTP, the owner is the deployment account and the web-server user only shares the *group*.
 * Probing the running web-server process would name the wrong user there. So this module asks the
 * install itself — the ownership of `wp-content` — which is right in both shapes, and gets the
 * group for free. A site may override it with `transport.fileOwner`.
 *
 * **Both users must keep working.** Ownership alone is not enough, and getting this wrong swaps one
 * bug for a worse one: chowning a plugin to the web server at its natural mode locks out the
 * transport user, which is who later runs `wp plugin uninstall`. So the chown is paired with an
 * **additive** mode grant ({@link grantModeFor}) — `+`, never `=`, so this can never tighten a host
 * or lock anyone out, and never `x` where `X` will do.
 *
 * **It never fails a run.** Ownership is housekeeping: it makes no claim about the product under
 * test, so a host that cannot do it is warned about and stepped over, exactly as residue removal is.
 * Every outcome is reported, none throws — see {@link OwnershipOutcome}.
 *
 * **When to use it.** Any code that writes files into a site's docroot as the transport's user must
 * call {@link normalizeOwnership} on what it wrote. Never call `chown`/`chmod` directly, and never
 * elevate `wp` — WP-CLI as root would leave the site unwritable by the web server, which is this
 * module's problem in a more expensive form.
 *
 * **Linux only, deliberately.** `stat -c` and `id` are read in their GNU/coreutils form; targets are
 * Linux in every cell this suite runs against. BusyBox — what the `wordpress:cli` container provides
 * — accepts the same *flags* but does **not** print the same thing when a name cannot be resolved:
 * measured on 1.37.0 (`wordpress:cli-php8.3`), `stat` answers `UNKNOWN:UNKNOWN:33:33` where GNU
 * answers with the ids, and `id` answers `uid=33 gid=33 groups=33` with no names at all. Both
 * parsers handle that — see {@link parseStatOwnership} and {@link parseIdentity} — so a `docker`
 * cell resolves to the same owner GNU would report. Both reads are confined to
 * {@link probeOwnership} and {@link probeIdentity} so a future BSD branch stays a local change.
 */

/** What {@link normalizeOwnership} did. It never throws, so this is the whole result. */
export type OwnershipOutcome =
  /** Ownership was corrected and the result verified by re-reading it. */
  | "normalized"
  /** The transport's user already owns the tree as the site expects — nothing was run. */
  | "unnecessary"
  /**
   * Nothing was run: no target ownership could be resolved, the transport's own identity could not
   * be read, or privileges were unavailable. Warned once.
   */
  | "skipped"
  /** The site declares `transport.fileOwner: false`. */
  | "disabled"
  /**
   * A command failed, verification disagreed with it, or the attempt was refused before any
   * command ran (an unusable path, a malformed `fileOwner`, a symlink target). Warned; the run
   * continues.
   */
  | "failed";

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

// Every cache below is keyed per install (`installKey`), not per host: one machine can serve several
// sites whose ownership differs, and a host-scoped key would let the first one probed answer for all
// of them — a wrong report at best, and a privileged `chown` aimed at another site's owner at worst.

/** Detected site ownership, per install. `null` records a probe that ran and could not answer. */
const detectedOwnership = new Map<string, SiteOwnership | null>();

/** Ids looked up for a declared `transport.fileOwner`, per install and spec. */
const declaredIds = new Map<string, SiteOwnership | null>();

/** Transport identity, per install. */
const detectedIdentity = new Map<string, TransportIdentity | null>();

/** Installs already warned about, so a per-scenario call does not repeat itself every time. */
const warned = new Set<string>();

/** Installs already told about the world-write grant, which is worth saying exactly once. */
const worldWriteNotices = new Set<string>();

/**
 * Parses `stat -c '%U:%G:%u:%g'`.
 *
 * The name halves are whatever `stat` could look up, and the two implementations this suite meets
 * disagree about failure: GNU prints the numeric id, **BusyBox prints the literal `UNKNOWN`**
 * (measured on 1.37.0, the `wordpress:cli-php8.3` image — `wp-content` there reads
 * `UNKNOWN:UNKNOWN:33:33`). A name is only ever handed straight back to `chown`, and
 * `chown UNKNOWN:UNKNOWN` can never succeed, so an unmapped name is replaced by the id from the
 * same call — which is what the kernel stores anyway, and what {@link matches} verifies against.
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
 * The `chmod` mode that keeps everyone who needs this tree able to manage it.
 *
 * `ug+rwX` is always applied: after the chown, the owner and the group are exactly the pair the
 * site's own docroot uses, and on a host where those are two different accounts (deployment user
 * owning, web server in the group) the group half is the web server's only access.
 *
 * `o+rwX` is added only when the transport's user is *neither* — otherwise it could no longer
 * uninstall what it installed. That is world-writable and it is not applied lightly: it is
 * avoidable by putting the transport's user in the site's group, which is what the caller reports.
 *
 * `X` rather than `x` so directories become traversable without making PHP files executable, and
 * `+` throughout so a mode is only ever added — this can never tighten a host's permissions.
 *
 * @param identity - who the transport's commands run as, from {@link parseIdentity}.
 * @param target - the ownership the tree is being given, which may be known only by name.
 * @returns the mode argument for `chmod -R`, and whether it grants world-write.
 */
export function grantModeFor(
  identity: TransportIdentity,
  target: SiteOwnership,
): { readonly mode: string; readonly worldWritable: boolean } {
  // By id *or* by name. A target that came from `transport.fileOwner` has no ids — comparing only
  // numbers there would answer "not the owner, not a member" for every declared override, and every
  // override would make its tree world-writable while reporting a reason that is not true.
  const insider =
    identity.uid === target.uid ||
    identity.groupIds.includes(target.gid) ||
    identity.user === target.user ||
    identity.groupNames.includes(target.group);
  return insider
    ? { mode: "ug+rwX", worldWritable: false }
    : { mode: "ug+rwX,o+rwX", worldWritable: true };
}

/**
 * Reads the ownership of one absolute path on the target.
 *
 * `undefined` means the command **ran** and the answer was unusable — the path does not exist, or
 * `stat` printed something unparseable. A transport that could not run it at all **throws**, which
 * is the distinction the memoising callers depend on: only a real answer is worth remembering.
 */
async function probeOwnership(
  transport: Transport,
  path: string,
): Promise<SiteOwnership | undefined> {
  const { exitCode, stdout } = await exec(transport, "stat", [
    "-c",
    "%U:%G:%u:%g",
    path,
  ]);
  return exitCode === 0 ? parseStatOwnership(stdout) : undefined;
}

/** Reads who the transport's commands run as. Throws if it could not be asked — see above. */
async function probeIdentity(
  transport: Transport,
): Promise<TransportIdentity | undefined> {
  const { exitCode, stdout } = await exec(transport, "id", []);
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

/**
 * The ownership this site's WordPress install already uses, memoised per **install**.
 *
 * Probes `wp-content` — the directory plugins actually write into — and falls back to the
 * WordPress root, so a site whose `wp-content` is relocated still answers. A target that cannot
 * answer is remembered as such, so a run does not re-ask once per scenario.
 *
 * @param transport - the target site's transport.
 * @returns the detected ownership, or `undefined` when it could not be read.
 */
export async function detectSiteOwnership(
  transport: Transport,
): Promise<SiteOwnership | undefined> {
  const key = installKey(transport);
  const cached = detectedOwnership.get(key);
  if (cached !== undefined) return cached ?? undefined;

  let found: SiteOwnership | undefined;
  try {
    found = await probeSiteOwnership(transport);
  } catch {
    // Not cached. A throw means the *transport* failed, not that this site has no readable
    // ownership — remembering it would let one dropped connection disable normalisation for every
    // later scenario in this worker, on a site that is perfectly capable of answering.
    return undefined;
  }
  detectedOwnership.set(key, found ?? null);
  return found;
}

/** {@link probeIdentity}, memoised per **install** — several installs on one host may differ. */
async function transportIdentity(
  transport: Transport,
): Promise<TransportIdentity | undefined> {
  const key = installKey(transport);
  const cached = detectedIdentity.get(key);
  if (cached !== undefined) return cached ?? undefined;

  let found: TransportIdentity | undefined;
  try {
    found = await probeIdentity(transport);
  } catch {
    // Not cached, for the reason given in `detectSiteOwnership`.
    return undefined;
  }
  detectedIdentity.set(key, found ?? null);
  return found;
}

/**
 * Why a warning is being issued. Warnings are deduplicated per target **and per reason**: a site
 * that fails the same way every scenario should say so once, but a *different* failure must never be
 * swallowed by an earlier one — nothing consumes the return value, so a suppressed warning is an
 * invisible failure.
 */
type WarningReason =
  | "bad-input"
  /** The path itself cannot be operated on safely — today, a symlink operand. */
  | "bad-target"
  | "no-ownership"
  | "no-identity"
  | "no-elevation"
  | "chown-failed"
  | "chmod-failed"
  | "unverified"
  /** Something threw before a verdict was reached — the transport, or a guard rejecting the path. */
  | "errored";

/**
 * Warns about `transport` once per **worker process** for each distinct {@link WarningReason}.
 *
 * Per process, not per run: Playwright's workers are separate processes with their own module
 * state, so an N-worker run against one bad host prints the warning up to N times. That is the
 * honest scope — deduplicating across processes would need a channel none of this has — and it is
 * still bounded, where warning per scenario would not be.
 *
 * @param transport - the site the warning is about.
 * @param reason - what went wrong; two different reasons never silence each other.
 * @param message - the operator-facing text, already specific to this site.
 * @param distinguishBy - splits one reason into separate warnings. Used for `bad-input` and
 * `bad-target`, where each
 * distinct mistake deserves its own line but the same mistake repeated every scenario does not; the
 * host-state reasons deliberately omit it, so a flapping exit code cannot re-warn on every call.
 */
function warnOnce(
  transport: Transport,
  reason: WarningReason,
  message: string,
  distinguishBy = "",
): void {
  const key = `${installKey(transport)}:${reason}:${distinguishBy}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`[wp/ownership] ${describeTarget(transport)}: ${message}`);
}

/**
 * The ownership to apply: the site's declaration if it has one, else what was detected.
 *
 * A declared spec still needs the detected numeric ids to verify against afterwards, so when the
 * two name the same user the detected record is reused wholesale; when they differ, the ids are
 * left unknown (`NaN`) and both verification and the grant decision fall back to comparing names —
 * which is what `chown` was given anyway.
 *
 * @param declared - the site's `transport.fileOwner`, parsed, if it has one.
 * @param detected - what the install's own ownership reads as, if it could be read.
 * @returns the ownership to apply, or `undefined` when neither source could supply one.
 */
export function resolveTarget(
  declared: OwnerSpec | undefined,
  detected: SiteOwnership | undefined,
): SiteOwnership | undefined {
  if (declared === undefined) return detected;
  // The asymmetry is load-bearing, not an oversight: `declared.user` is non-nullable, so a true
  // first comparison narrows `detected` to defined and the second must *not* repeat `?.` — both
  // compilers say so, one as an error either way.
  const sameAsDetected =
    detected?.user === declared.user && detected.group === declared.group;
  return sameAsDetected
    ? detected
    : {
        ...declared,
        uid: declaredId(declared.user),
        gid: declaredId(declared.group),
      };
}

/**
 * The numeric id a declared half already **is**, or `NaN` when it names a user rather than an id.
 *
 * `transport.fileOwner` accepts a bare id (`"33:33"`) for a host whose passwd database cannot map
 * the name. Left as `NaN`, such a target would be compared by *name* everywhere: `stat` reports
 * `www-data` for uid 33, so verification would call every successful `chown` a failure — and worse,
 * {@link grantModeFor} would find the transport user neither the owner nor a group member and make
 * the tree world-writable, for a reason that is not true.
 *
 * @param half - one side of a parsed `transport.fileOwner`.
 * @returns the id, or `NaN` when the half names a user or group instead.
 */
function declaredId(half: string): number {
  return /^\d+$/.test(half) ? Number(half) : Number.NaN;
}

/**
 * Whether `actual` is the ownership `target` asked for, by id when known and by name otherwise.
 *
 * @param actual - what the tree reads as now.
 * @param target - what it was asked to become.
 */
export function matches(actual: SiteOwnership, target: SiteOwnership): boolean {
  // Per half, not for the pair: `transport.fileOwner` may name one side and number the other
  // ("www-data:33"), and judging both by the weaker spelling would fail a chown that worked.
  const userMatches = Number.isInteger(target.uid)
    ? actual.uid === target.uid
    : actual.user === target.user;
  const groupMatches = Number.isInteger(target.gid)
    ? actual.gid === target.gid
    : actual.group === target.group;
  return userMatches && groupMatches;
}

/**
 * The numeric ids behind a declared `transport.fileOwner`, asked of the host.
 *
 * Without them a declaration made by **name** carries `NaN` ids, and every later comparison falls
 * back to names — which fails on a host whose `id` prints none (BusyBox does). The consequences are
 * not cosmetic: {@link grantModeFor} reads "not a member" and makes the tree **world-writable** for
 * a reason that is not true, {@link matches} calls a successful `chown` a failure, and the
 * `"unnecessary"` fast path can never fire, so a site that needs nothing done pays two privileged
 * commands per scenario.
 *
 * Best-effort by design: a host that cannot answer leaves the ids unknown and behaves exactly as it
 * did before, so this can only ever add precision. Memoised per install, because it is two
 * round-trips and the answer is a property of the host.
 *
 * @param transport - the target site's transport.
 * @param spec - the declared owner, already validated.
 * @returns the declared owner with its ids filled in, or `undefined` if the host could not resolve
 * either half.
 */
async function resolveDeclaredIds(
  transport: Transport,
  spec: OwnerSpec,
): Promise<SiteOwnership | undefined> {
  const key = `${installKey(transport)}:${spec.user}:${spec.group}`;
  const cached = declaredIds.get(key);
  if (cached !== undefined) return cached ?? undefined;

  let found: SiteOwnership | undefined;
  try {
    // No `--`: neither `id` nor `getent` accepts it, and `parseOwnerSpec` has already refused a
    // leading dash, so the name cannot be read as an option.
    const [user, group] = await Promise.all([
      exec(transport, "id", ["-u", spec.user]),
      exec(transport, "getent", ["group", spec.group]),
    ]);
    const uid = user.exitCode === 0 ? user.stdout.trim() : "";
    // `getent group` answers `name:x:gid:members`; the gid is the third field.
    const gid = group.exitCode === 0 ? (group.stdout.split(":")[2] ?? "") : "";
    if (/^\d+$/.test(uid) && /^\d+$/.test(gid)) {
      found = { ...spec, uid: Number(uid), gid: Number(gid) };
    }
  } catch {
    // A transport failure, not an answer — see `detectSiteOwnership`. Not remembered.
    return undefined;
  }
  declaredIds.set(key, found ?? null);
  return found;
}

/**
 * What this site needs done to it, decided without doing any of it.
 *
 * Extracted so that **reporting and acting share one decision.** Pre-flight tells an operator what
 * will happen to a site's files; {@link normalizeOwnership} then makes it happen. Two
 * implementations of that reasoning would drift, and the one that drifted would be the report — the
 * half nobody can tell is wrong by looking at the site.
 */
export type OwnershipPlan =
  /** The site declares `transport.fileOwner: false`. */
  | { readonly kind: "disabled" }
  /** `transport.fileOwner` is not a usable `"user:group"`. Nothing can be decided from it. */
  | { readonly kind: "bad-owner"; readonly message: string }
  /** The site's own ownership could not be read and none was declared. */
  | { readonly kind: "unknown-ownership" }
  /** Which user the site's commands run as could not be read. */
  | { readonly kind: "unknown-identity"; readonly target: SiteOwnership }
  /** The transport's user already owns the install exactly as the site expects. */
  | { readonly kind: "unnecessary"; readonly target: SiteOwnership }
  /** Ownership must be handed over, and this is the grant that keeps both users working. */
  | {
      readonly kind: "grant";
      readonly target: SiteOwnership;
      readonly identity: TransportIdentity;
      readonly mode: string;
      readonly worldWritable: boolean;
    };

/**
 * Works out what {@link normalizeOwnership} would do to this site, running only the two read-only
 * probes and **never** anything privileged.
 *
 * Deliberately says nothing about whether privileges are *available*: that is a separate question
 * with its own reporting, and a site can need a handover it is not allowed to perform.
 *
 * @param transport - the target site's transport.
 * @returns the decision, which the caller either reports or carries out.
 */
export async function planOwnership(
  transport: Transport,
): Promise<OwnershipPlan> {
  if (transport.fileOwner === false) return { kind: "disabled" };

  let declared: OwnerSpec | undefined;
  try {
    declared =
      transport.fileOwner === undefined
        ? undefined
        : parseOwnerSpec(
            transport.fileOwner,
            "[wp/ownership] `transport.fileOwner`",
          );
  } catch (error) {
    return { kind: "bad-owner", message: errorMessage(error) };
  }

  const [detected, identity] = await Promise.all([
    detectSiteOwnership(transport),
    transportIdentity(transport),
  ]);
  let target = resolveTarget(declared, detected);
  if (target === undefined) return { kind: "unknown-ownership" };
  // A declaration made by name carries no ids until the host is asked for them.
  if (declared !== undefined && !Number.isInteger(target.uid)) {
    target = (await resolveDeclaredIds(transport, declared)) ?? target;
  }
  if (identity === undefined) return { kind: "unknown-identity", target };

  // Nothing to correct: WP-CLI already runs as the account that owns this install, which is the
  // normal `docker` case. Decided before privileges are even asked about, so a correct host never
  // sudoes.
  if (identity.uid === target.uid && identity.gid === target.gid) {
    return { kind: "unnecessary", target };
  }
  return { kind: "grant", target, identity, ...grantModeFor(identity, target) };
}

/**
 * Gives a path this suite just wrote back to the ownership the site expects, and re-opens it to the
 * transport's user so it can still be managed from WP-CLI.
 *
 * Never throws, and does nothing at all on a target that already has it right — a `docker` cell,
 * where WP-CLI runs as the same user that owns the files, takes the `"unnecessary"` path without
 * running a single privileged command.
 *
 * @param transport - the target site's transport.
 * @param sitePath - what to fix, **relative to the WordPress root** (e.g.
 * `wp-content/plugins/backwpup-pro`). Relative because the absolute path is composed here from the
 * transport's own root, so a stray leading `/` can never aim a privileged `chown -R` at a system
 * directory; it is validated by the same guard residue removal uses.
 * @returns what happened, for a caller that wants to report it. Ignoring it is fine.
 *
 * @example
 * ```ts
 * await normalizeOwnership(site.transport, `wp-content/plugins/${artifact.slug}`);
 * ```
 */
export async function normalizeOwnership(
  transport: Transport,
  sitePath: string,
): Promise<OwnershipOutcome> {
  if (transport.fileOwner === false) return "disabled";

  let relative: string;
  try {
    relative = normaliseSitePath(
      sitePath,
      (reason) =>
        `[wp/ownership] "${sitePath}" cannot be used as an ownership target: ${reason}. Pass a ` +
        'path relative to the WordPress root that this suite wrote, e.g. "wp-content/plugins/<slug>".',
    );
  } catch (error) {
    // Our own mistake, not the host's, and it must not take a scenario down with it — but it must be
    // said, because nothing will normalise until it is fixed.
    const message = errorMessage(error);
    warnOnce(transport, "bad-input", message, message);
    return "failed";
  }

  const plan = await planOwnership(transport);
  switch (plan.kind) {
    case "disabled":
      return "disabled";
    case "bad-owner":
      warnOnce(transport, "bad-input", plan.message, plan.message);
      return "failed";
    case "unknown-ownership":
      warnOnce(
        transport,
        "no-ownership",
        "could not read this site's file ownership, so files this suite installs keep the transport " +
          "user's ownership and the web server may be unable to write them. Declare " +
          '`transport.fileOwner` ("user:group") for this site to fix it.',
      );
      return "skipped";
    case "unknown-identity":
      warnOnce(
        transport,
        "no-identity",
        "could not read which user this site's commands run as, so file ownership was left alone. " +
          "`id` did not answer on this transport; if that is expected, declare " +
          "`transport.fileOwner: false` for this site to stop asking.",
      );
      return "skipped";
    case "unnecessary":
      return "unnecessary";
    case "grant":
      break;
  }

  const elevation = await elevationSupport(transport);
  if (elevation !== "available") {
    warnOnce(
      transport,
      "no-elevation",
      `file ownership cannot be corrected (elevation: ${elevation}), so the web server may be ` +
        "unable to write the plugin this suite installs. Grant the transport's user passwordless " +
        "`sudo`, or set `transport.fileOwner: false` to accept this deliberately.",
    );
    return "skipped";
  }

  return applyOwnership(transport, relative, plan);
}

/**
 * The privileged half: grant, chown, verify. Split out so {@link normalizeOwnership} reads as the
 * decision it is, and this reads as the commands it runs.
 *
 * **The grant is applied before the chown, and the order is load-bearing.** The two commands
 * commute in their final effect, but their *intermediate* state does not: chowning first would
 * leave the tree owned by the site's user with no grant yet, which is exactly the state that locks
 * the transport user out of removing what it installed. Interrupt the run there — or hit a host
 * whose `sudo` allows `chown` but not `chmod` — and the site stays broken until someone intervenes.
 * Granting first means a failed `chown` leaves the tree as it was: still the transport user's, still
 * writable by it, merely not yet handed over.
 *
 * @param transport - the target site's transport.
 * @param relative - the already-validated path, relative to the WordPress root.
 * @param plan - the decision {@link planOwnership} reached, including the mode to grant.
 * @returns what happened; never throws, on the same terms as {@link normalizeOwnership}.
 */
async function applyOwnership(
  transport: Transport,
  relative: string,
  plan: Extract<OwnershipPlan, { kind: "grant" }>,
): Promise<OwnershipOutcome> {
  let absolute: string;
  try {
    absolute = await elevatedTarget(transport, relative);
    if (!(await grantThenChown(transport, absolute, relative, plan))) {
      return "failed";
    }
  } catch (error) {
    // Its own reason, not `chown-failed`: this catches the root guard, the symlink check and any
    // transport error, none of which is a chown refusal. Sharing that key would let whichever
    // happened first permanently silence the other — the precise thing per-reason dedupe exists to
    // stop.
    warnOnce(
      transport,
      "errored",
      `file ownership of "${relative}" could not be corrected: ${errorMessage(error)}`,
    );
    return "failed";
  }
  return verifyHandover(transport, absolute, relative, plan);
}

/**
 * Composes the absolute path the privileged commands will act on, and refuses an implausible root.
 *
 * `normaliseSitePath` has already constrained the relative half; this is the half it cannot see —
 * whether the site's own `rootDir` is somewhere a root command may be aimed at all.
 *
 * @param transport - the target site's transport.
 * @param relative - the already-validated path, relative to the WordPress root.
 * @returns the absolute path on the target.
 * @throws Error if the root cannot be resolved, or is not one this may elevate against.
 */
async function elevatedTarget(
  transport: Transport,
  relative: string,
): Promise<string> {
  const root = await wpRootDir(transport);
  const absolute = posix.join(root, relative);
  const describe = (reason: string): string =>
    `[wp/ownership] refusing to change file ownership with elevated privileges: this site's ` +
    `WordPress root ("${root}") cannot be used for it — ${reason}. Fix the site's \`rootDir\`, ` +
    "or set `transport.fileOwner: false` to leave ownership alone.";
  assertSafeElevatedTarget(absolute, root, describe);
  // …and again against the filesystem: the check above compares strings, so a symlink anywhere in
  // the path — not only the last component — would let it agree while the kernel resolves elsewhere.
  await assertResolvedInsideRoot(transport, absolute, root, describe);
  return absolute;
}

/**
 * Runs the two privileged commands, **grant first**.
 *
 * `--` ends option parsing in both, because `chown` permutes options anywhere in its argv: without
 * it a mistyped `fileOwner` beginning with a dash reaches root as a *flag* — `chown -Rh
 * --reference=/etc/hostname <path>` was measured taking its ownership from that file instead.
 *
 * `-h` acts on a symlink itself rather than its target. Measured on GNU coreutils 9.4: neither
 * `chown -R` nor `chmod -R` *traverses* a symlink found during recursion, and `-h` additionally
 * stops `chown` dereferencing the **operand**. `chmod` has no such flag, which is why the operand is
 * refused by {@link refuseSymlink} rather than handled here.
 *
 * @param transport - the target site's transport.
 * @param absolute - the composed target on the site.
 * @param relative - the same path as declared, for the messages.
 * @param plan - the grant to apply and the ownership to hand over to.
 * @returns whether both commands succeeded; a failure is warned about here.
 */
async function grantThenChown(
  transport: Transport,
  absolute: string,
  relative: string,
  plan: Extract<OwnershipPlan, { kind: "grant" }>,
): Promise<boolean> {
  const { mode, target } = plan;
  const chmod = await execElevated(transport, "chmod", [
    "-R",
    "--",
    mode,
    absolute,
  ]);
  if (chmod.exitCode !== 0) {
    warnOnce(
      transport,
      "chmod-failed",
      `could not grant "${mode}" on "${relative}", so its ownership was left alone ` +
        `(exit ${String(chmod.exitCode)}: ${describeExit(chmod)}).`,
      relative,
    );
    return false;
  }

  const chown = await execElevated(transport, "chown", [
    "-Rh",
    "--",
    `${target.user}:${target.group}`,
    absolute,
  ]);
  if (chown.exitCode !== 0) {
    warnOnce(
      transport,
      "chown-failed",
      `could not set ownership of "${relative}" to ${target.user}:${target.group} ` +
        `(exit ${String(chown.exitCode)}: ${describeExit(chown)}). Check that both names exist on ` +
        "the host, or declare `transport.fileOwner` for this site.",
      relative,
    );
    return false;
  }
  return true;
}

/** A failed command's output, preferring stderr, for a one-line message. */
function describeExit(result: ExecResult): string {
  return (result.stderr || result.stdout).trim() || "no output";
}

/**
 * Confirms the tree really reads back as the ownership it was asked for.
 *
 * Verified, never inferred from an exit code — the same discipline residue removal uses. The probe
 * throws when it cannot be asked, and this must not, so an unanswerable re-read is folded into the
 * same "could not confirm" verdict as an unparseable one.
 *
 * @param transport - the target site's transport.
 * @param absolute - the composed target on the site.
 * @param relative - the same path as declared, for the message.
 * @param plan - carries the expected ownership and whether world-write was granted.
 * @returns `"normalized"` when it matches, else `"failed"`.
 */
async function verifyHandover(
  transport: Transport,
  absolute: string,
  relative: string,
  plan: Extract<OwnershipPlan, { kind: "grant" }>,
): Promise<OwnershipOutcome> {
  const { target, worldWritable } = plan;
  const actual = await probeOwnership(transport, absolute).catch(
    (): undefined => undefined,
  );
  if (actual === undefined || !matches(actual, target)) {
    warnOnce(
      transport,
      "unverified",
      `ownership of "${relative}" still reads as ` +
        `${actual === undefined ? "unreadable" : `${actual.user}:${actual.group}`} after chown to ` +
        `${target.user}:${target.group}. The site's files were left as they are; re-run, or declare ` +
        "`transport.fileOwner` if the host resolves those names differently.",
      relative,
    );
    return "failed";
  }

  if (worldWritable) noteWorldWrite(transport, relative, target);
  return "normalized";
}

/**
 * Says, once per target, that world-write was granted and how to stop needing it.
 *
 * Separate from {@link warnOnce} on purpose: this is not a failure, and it must not silence the
 * warning an actual failure would want to print later.
 *
 * @param transport - the target site's transport, named in the notice.
 * @param relative - the path that was granted world-write.
 * @param target - the ownership it was handed to, whose group names the remedy.
 */
function noteWorldWrite(
  transport: Transport,
  relative: string,
  target: SiteOwnership,
): void {
  // Per path, not per install: one scenario normalises the plugin directory and every declared data
  // directory, so an install-wide key would announce the first grant and silence the rest.
  const key = `${installKey(transport)}:${relative}`;
  if (worldWriteNotices.has(key)) return;
  worldWriteNotices.add(key);
  console.info(
    `[wp/ownership] ${describeTarget(transport)}: granted world-write on "${relative}" because ` +
      `this site's commands run as a user that is neither "${target.user}" nor a member of ` +
      `"${target.group}", and it must still be able to remove what it installs. Adding that user ` +
      `to the "${target.group}" group keeps the grant group-scoped instead.`,
  );
}

/**
 * Forgets every memoised probe **and every once-only notice**, including the elevation answers held
 * in `./exec.ts` — a test that reset only these four would inherit a stale `sudo` verdict for any
 * target it reused. For tests, which change a target's state between cases; a run has
 * no reason to call it, since these facts are properties of the host.
 */
export function resetOwnershipCaches(): void {
  resetElevationCaches();
  detectedOwnership.clear();
  detectedIdentity.clear();
  declaredIds.clear();
  warned.clear();
  worldWriteNotices.clear();
}
