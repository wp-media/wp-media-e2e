import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import {
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  wpRootDir,
} from "../../../common/wp/exec";
import { isPlaceholderSite } from "../../../common/config/sites";
import { errorMessage } from "../../../common/guards";
import { SETTLE_LEFTOVERS_ALLOWANCE_MS } from "../../../common/setup/preflight";
import { maskSiteUrl } from "../../../common/text";
import {
  BOOT_ID_PATH,
  CONTENT_COPY_DB_DEFAULTS,
  DEFAULT_LEASE,
  CONTENT_COPY_FILE,
  CONTENT_COPY_STAMP,
  RECOVERING_PREFIX,
  assertRootMayActOn,
  copyPlaceIn,
  copyUsers,
  discardCopy,
  findLeftovers,
  heldCopy,
  heldEntries,
  inCopy,
  inCopyProblem,
  leftoverMessage,
  parseBootId,
  putBackCopy,
  readBack,
  readDirIdentity,
  readsBackWhole,
  stampCopy,
} from "./content-copy";
import { parseDirIdentity } from "./content-copy-fence";
import {
  parseDatabaseDefaults,
  restoreDatabaseDefaults,
} from "./database-defaults";
import {
  CONTENT_COPY_LEASE,
  UPTIME_PATH,
  judgeLease,
} from "./content-copy-lease";
import type { CopyPlace, LeaseTerms } from "./content-copy";
import type { DatabaseDefaults } from "./database-defaults";
import type { SiteConfig, Transport } from "../../../common/config/types";

/**
 * A copy of `wp-content` an earlier run left (`./content-copy.ts`), found before a run uses the site
 * (the auth setup's preflight, then every BackWPup worker): refused, since the site's `wp-content` may
 * be damaged and the copy may be the only way back — unless it is provably orphaned, when it is
 * settled and the run goes on.
 *
 * **A whole copy is orphaned when no run may still use it, and no process uses it.** No run may when
 * it is stamped by another boot of the host ({@link CONTENT_COPY_STAMP}: every use is stamped just
 * before it, so every use so far ran under a kernel since gone), or — stamped in this boot — when its
 * lease lapsed (`./content-copy-lease.ts`: expired on the host's boot-time clock, given up by its run,
 * or held by this invocation's own worker slot, which proves that worker gone). No stamp, an unreadable one,
 * no lease (an older suite's copy) or a live one → refused. Wall-clock times and age limits were
 * rejected: a stepped clock moves them, and a runner on another machine keeps its own.
 *
 * **No process uses it** — none whose argv names a copy of this site or that works in one, and no
 * `wp backwpup restore` running in its WordPress root (`IN_USE_SCRIPT`) — checked before the claim and
 * again after it. Even a lapsed lease may belong to a live run (asleep, cut off): it is fenced, not
 * trusted — its root commands find the copy gone, and its restore refuses to start (its fence checks
 * the copy's directory is still at its path) — so a recovery only ever settles a copy no step of that
 * run can touch any more. The run that made the copy also refuses its own command if the host
 * rebooted after the copy was taken.
 *
 * **A copy holding none to put back is removed whenever no process uses it**, whatever its boot or
 * lease: no restore ran from it, or it is back already, so it protects nothing — and a removal cut
 * short (files gone, directory left, stamp included) must not leave the site refused. A live run
 * whose copy this is fails safe at its next step: the in-copy script finds the directory gone (its
 * copy or seal fails, and the restore never runs), or its put-back had already succeeded.
 *
 * **Inspected read-only first**; claimed only to act: an elevated `mv -T` to a unique sibling
 * ({@link RECOVERING_PREFIX}) — atomic, so of two runs one wins and the other finds the source gone
 * and looks again — then judged again, checked for users again, and stamped with a lease of the
 * settling run's own, so another run reads it as in use. Refused at any of these (its run renewed it
 * from inside meanwhile, say), it is handed back to its path when nothing took that since, so a run
 * still using it carries on. A recovery cut off leaves a claimed copy whose lease lapses, settled the
 * same way later.
 *
 * **Settled by what it holds** ({@link heldCopy}): the whole copy put back if it reads back — the same
 * swap a run's own put-back makes, safe on a live site — then removed, and, when its restore reached
 * the database too, the database's defaults saved beside it set back, the operator told the database
 * may be partly restored; none to put back — nothing, the partial copy (the command runs only once the
 * copy is whole), or the one already back — removed; anything else refused.
 *
 * Root acts only inside the directory it proved is the copy's (`IN_COPY_SCRIPT`), so swapping it for
 * a link after a check cannot redirect root. Not covered: the WordPress root itself swapped, by
 * whoever may write its parent.
 */

/** How often the check looks again after another run claimed the copy it was about to. */
const CLAIM_PASSES = 2;

/** The `contentCopyLeftover` worker fixture's options: settling may rewrite all of `wp-content`. */
export const LEFTOVER_FIXTURE_OPTIONS = {
  scope: "worker",
  auto: true,
  box: true,
  timeout: SETTLE_LEFTOVERS_ALLOWANCE_MS,
} as const;

/** Sets a database's defaults back — `restoreDatabaseDefaults`, or a spec's stand-in. */
export type SetDatabaseDefaults = (
  transport: Transport,
  defaults: DatabaseDefaults,
) => Promise<void>;

/** What settling a leftover needs of its site. */
interface SettleSite {
  readonly transport: Transport;
  /** The WordPress root's absolute path. */
  readonly root: string;
  readonly setDefaults: SetDatabaseDefaults;
  /** The lease a settling run stamps a claimed copy with: its own holder. */
  readonly terms: LeaseTerms;
  /** The asking worker's holder, when it is one: its own leftover is settled at once. */
  readonly self: string | undefined;
}

/** What a leftover calls for. */
export type Verdict =
  | { readonly action: "discard" }
  | { readonly action: "put-back" | "refuse"; readonly why: string };

/** What is known about a leftover, read without changing it. */
export interface LeftoverFacts {
  /** Its directory's entries, or `undefined` when they could not be read. */
  readonly entries: readonly string[] | undefined;
  /** Its stamp's contents, or `undefined` when there is none or it could not be read. */
  readonly stamp: string | undefined;
  /** The host's current boot id, as read, or `undefined` when it could not be. */
  readonly bootId: string | undefined;
  /** Its lease's contents, or `undefined` when there is none or it could not be read. */
  readonly lease?: string | undefined;
  /** `/proc/uptime` as read after the lease, or `undefined` when it could not be. */
  readonly uptime?: string | undefined;
}

/**
 * What a leftover calls for: one holding none to put back is removed; a whole copy is put back only
 * when its stamp is another boot's, or this boot's with its lease lapsed; anything else is refused.
 * Whether a process uses it is asked separately, for both.
 *
 * @param facts - what was read.
 * @param self - the asking worker's lease holder, if it is one.
 */
export function judgeLeftover(facts: LeftoverFacts, self?: string): Verdict {
  const { entries } = facts;
  if (entries === undefined) {
    return { action: "refuse", why: "what it holds could not be read" };
  }
  const held = heldCopy(entries);
  if (held === "unknown") {
    return { action: "refuse", why: "it holds what no copy does" };
  }
  if (held === "none") return { action: "discard" };
  const stamp = parseBootId(facts.stamp);
  if (stamp === undefined) {
    return {
      action: "refuse",
      why: entries.includes(CONTENT_COPY_STAMP)
        ? "its boot stamp is unreadable"
        : "it has no boot stamp, so which boot used it last is unknown",
    };
  }
  const bootId = parseBootId(facts.bootId);
  if (bootId === undefined) {
    return { action: "refuse", why: "the host's boot id could not be read" };
  }
  if (stamp !== bootId) {
    return {
      action: "put-back",
      why: "an earlier boot of the host stamped its last use",
    };
  }
  const lease = judgeLease(facts.lease, bootId, facts.uptime, self);
  if (lease.state === "lapsed") return { action: "put-back", why: lease.why };
  return {
    action: "refuse",
    why: `it was used since the host last booted, so a run may still be using it: ${lease.why}`,
  };
}

/**
 * Refuses a site holding a copy an earlier run left unless it is provably orphaned, which is then
 * settled — see the module header. A product's `settleLeftovers`, for the auth setup's preflight, and
 * the `contentCopyLeftover` worker fixture's body.
 *
 * Found as the identity site commands run as (the web server's in the `site` state). A site that cannot be asked is warned about, not refused — its
 * scenarios then fail in their own words — and a placeholder site is skipped.
 *
 * @param site - the site, or `undefined` when the project has none.
 * @param setDefaults - sets the database's defaults back after a put-back; the real one by default.
 * @param holder - the asking worker's lease holder (`holderFor`): it settles its own worker slot's
 * copy at once, and stamps any copy it claims with it. None outside a worker.
 * @throws {@link Error} naming the copy and how to settle it, when one is there and was not settled.
 */
export async function assertNoContentCopyLeft(
  site: Pick<SiteConfig, "baseURL" | "transport"> | undefined,
  setDefaults: SetDatabaseDefaults = restoreDatabaseDefaults,
  holder?: string,
): Promise<void> {
  if (site === undefined || isPlaceholderSite(site)) return;
  const { transport } = site;
  for (let pass = 1; pass <= CLAIM_PASSES; pass += 1) {
    let root: string;
    let found: string[];
    try {
      root = await wpRootDir(transport);
      found = await findLeftovers(transport, root);
    } catch (error) {
      console.warn(
        `[backwpup/content-copy] could not check ${maskSiteUrl(site.baseURL)} for a copy of wp-content an earlier ` +
          `run left: ${errorMessage(error)}`,
      );
      return;
    }
    const [dir, ...more] = found;
    if (dir === undefined) return;
    const outcome = await settleLeftover(
      {
        transport,
        root,
        setDefaults,
        terms: { ...DEFAULT_LEASE, holder: holder ?? DEFAULT_LEASE.holder },
        self: holder,
      },
      dir,
      more,
    );
    if (outcome === "settled") {
      return;
    }
  }
  throw new Error(
    `[backwpup/content-copy] ${describeTarget(transport)}: another run claimed the copy of ` +
      `wp-content an earlier run left each time this one tried to settle it (${String(CLAIM_PASSES)} ` +
      "times); BackWPup runs refuse this site until it is settled — see that run's output.",
  );
}

/**
 * Settles the one copy found, or refuses.
 *
 * @param site - the site, its WordPress root, and how to set its database's defaults back.
 * @param dir - the first copy's directory ({@link findLeftovers}).
 * @param more - any other copies' directories, which make it refused.
 * @returns `"lost"` when another run claimed it first, so the caller looks again.
 * @throws {@link Error} when it may not or could not be settled.
 */
async function settleLeftover(
  site: SettleSite,
  dir: string,
  more: readonly string[],
): Promise<"settled" | "lost"> {
  const { transport, root } = site;
  const target = describeTarget(transport);
  const found = [dir, ...more];
  const place = copyPlaceIn(root, dir);
  if (more.length > 0) {
    throw new Error(
      `[backwpup/content-copy] ${target}: ${String(found.length)} copies of wp-content are in ` +
        `${root} (${found.map((path) => posix.basename(path)).join(", ")}), so which one holds the ` +
        `site as it was is unknown. ${leftoverMessage(target, place)}`,
    );
  }
  const refuse = (
    at: CopyPlace,
    why: string,
    entries?: readonly string[],
  ): Error =>
    new Error(`${leftoverMessage(target, at, entries)} Left: ${why}.`);
  const elevation = await elevationSupport(transport);
  if (elevation !== "available") {
    throw refuse(
      place,
      `this host cannot elevate (${elevation}), so what it holds cannot be read`,
    );
  }
  const describe = (reason: string): string =>
    `[backwpup/content-copy] ${target}: refusing to settle ${dir} as root — ${reason}. ` +
    leftoverMessage(target, place);
  await assertRootMayActOn(transport, root, [place.content, dir], describe);

  const facts = await inspect(transport, dir);
  const verdict = judgeLeftover(facts, site.self);
  if (verdict.action === "refuse")
    throw refuse(place, verdict.why, facts.entries);
  await assertUnused(transport, root, (why) =>
    refuse(place, why, facts.entries),
  );

  const claimed = copyPlaceIn(
    root,
    posix.join(root, `${RECOVERING_PREFIX}${randomBytes(6).toString("hex")}`),
  );
  // A fresh random name, so nothing is there to guard; what lands there is proved by the in-copy
  // script before root acts in it.
  const moved = await execElevated(transport, "mv", [
    "-T",
    "--",
    dir,
    claimed.dir,
  ]);
  if (moved.exitCode !== 0) {
    if ((await exec(transport, "test", ["-e", dir])).exitCode !== 0) {
      return "lost";
    }
    throw new Error(
      describe(
        `it could not be claimed (mv exited ${String(moved.exitCode)}: ` +
          `${moved.stderr.trim().slice(0, 300) || "no output"})`,
      ),
    );
  }

  // Between the look and the claim, it may have changed or a use begun — its run renewing it from
  // inside, say: the same checks, on what was claimed — then stamped and leased as this run's, so any
  // other run reads it as in use. Refused, it is handed back to its path, so a run still using it
  // carries on.
  const again = await inspect(transport, claimed.dir);
  const reverdict = judgeLeftover(again, site.self);
  const handBack = async (why: string): Promise<Error> => {
    const where = await returnClaim(transport, claimed.dir, dir);
    if (where === "moved") {
      return new Error(
        `[backwpup/content-copy] ${target}: a copy of wp-content an earlier run left, claimed from ` +
          `${dir} to be settled as ${claimed.dir}, was refused (${why}) and has since moved on: ` +
          "another run claimed it, and settles it or says why it cannot. BackWPup runs refuse this " +
          "site until it is settled.",
      );
    }
    return refuse(where === "back" ? place : claimed, why, again.entries);
  };
  if (reverdict.action !== verdict.action) {
    throw await handBack(
      reverdict.action === "refuse"
        ? reverdict.why
        : "it changed while it was claimed",
    );
  }
  const users = await copyUsers(transport, root);
  const busy = usersProblem(users);
  if (busy !== undefined) throw await handBack(busy);
  const stamped = await stampCopy(transport, claimed.dir, site.terms);
  if (stamped.exitCode !== 0) {
    throw await handBack(`it could not be stamped (${inCopyProblem(stamped)})`);
  }
  await (reverdict.action === "put-back"
    ? putBackClaimed(site, claimed, again.entries ?? [], reverdict.why)
    : discardClaimed(transport, claimed, again.entries ?? []));
  return "settled";
}

/**
 * Reads, as root and changing nothing, what a leftover holds, its stamp and lease — then the current
 * boot id and the host's clock, read after the lease so the clock is never older than it. Anything
 * unreadable is `undefined`, which {@link judgeLeftover} refuses.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 */
async function inspect(
  transport: Transport,
  dir: string,
): Promise<LeftoverFacts> {
  const listed = await inCopy(transport, dir, ["ls", "-A"]);
  const entries =
    listed.exitCode === 0
      ? listed.stdout.split("\n").filter((name) => name !== "")
      : undefined;
  const note = async (name: string): Promise<string | undefined> => {
    if (entries?.includes(name) !== true) return undefined;
    const read = await inCopy(transport, dir, ["cat", "--", name]);
    return read.exitCode === 0 ? read.stdout : undefined;
  };
  // Each host file read on its own, so one that cannot be read is never blamed on the other.
  const hostFile = async (path: string): Promise<string | undefined> => {
    const read = await exec(transport, "cat", [path]);
    return read.exitCode === 0 ? read.stdout : undefined;
  };
  const stamp = await note(CONTENT_COPY_STAMP);
  const lease = await note(CONTENT_COPY_LEASE);
  const bootId = await hostFile(BOOT_ID_PATH);
  const uptime = await hostFile(UPTIME_PATH);
  return { entries, stamp, bootId, lease, uptime };
}

/**
 * Refuses while any process may use the site's copies (`copyUsers`), or when that cannot be told.
 *
 * @param transport - the site.
 * @param root - the WordPress root's absolute path.
 * @param refuse - builds the refusal from why.
 * @throws {@link Error} built by `refuse`.
 */
async function assertUnused(
  transport: Transport,
  root: string,
  refuse: (why: string) => Error,
): Promise<void> {
  const busy = usersProblem(await copyUsers(transport, root));
  if (busy !== undefined) throw refuse(busy);
}

/**
 * Why the copy may not be settled, from its users ({@link copyUsers}).
 *
 * @param users - their `pid program` lines, or `undefined` when they could not be told.
 * @returns `undefined` when none uses it.
 */
export function usersProblem(
  users: readonly string[] | undefined,
): string | undefined {
  if (users === undefined) {
    return "whether a process still uses it could not be checked";
  }
  const [first] = users;
  return first === undefined
    ? undefined
    : `a process still uses it (${String(users.length)}; first: ${first})`;
}

/** Where a claimed copy is once handed back ({@link returnClaim}): unknown when `moved`. */
type HandedBack = "back" | "claimed" | "moved";

/**
 * Hands a claimed copy back to its path, when nothing took that path since: `mv -T -n` never replaces
 * what is there. Back only when the directory then at the path is the one claimed (its `dev:ino`,
 * read as root inside each); still claimed when the claimed name is there; else moved on — another
 * run claimed it meanwhile, so neither path holds it. A claimed name swapped for a link, or one whose
 * identity cannot be read, stays where it is: no link, nor anything unproved, is moved to the path.
 *
 * @param transport - the site.
 * @param claimed - the claimed directory.
 * @param dir - the path it was claimed from.
 * @returns where the copy is.
 */
async function returnClaim(
  transport: Transport,
  claimed: string,
  dir: string,
): Promise<HandedBack> {
  const identity = async (path: string): Promise<string | undefined> => {
    const read = await readDirIdentity(transport, path);
    return read.exitCode === 0 ? parseDirIdentity(read.stdout) : undefined;
  };
  const stillClaimed = async (): Promise<HandedBack> =>
    (await exec(transport, "test", ["-e", claimed])).exitCode === 0
      ? "claimed"
      : "moved";
  try {
    if ((await exec(transport, "test", ["-L", claimed])).exitCode === 0) {
      return "claimed";
    }
    const was = await identity(claimed);
    if (was === undefined) return await stillClaimed();
    await execElevated(transport, "mv", ["-T", "-n", "--", claimed, dir]);
    if ((await identity(dir)) === was) return "back";
    return await stillClaimed();
  } catch {
    return "claimed";
  }
}

/**
 * Puts a claimed whole copy back, if it reads back, then removes it — and, when its restore reached
 * the database too, sets the database's defaults back; says so.
 *
 * @param site - the site, its WordPress root, and how to set its database's defaults back.
 * @param claimed - where the claimed copy is.
 * @param entries - what it holds.
 * @param why - why it is orphaned, for the warning.
 * @throws {@link Error} — the copy then kept, its lease expired — if it does not read back or could
 * not be put back.
 */
async function putBackClaimed(
  site: SettleSite,
  claimed: CopyPlace,
  entries: readonly string[],
  why: string,
): Promise<void> {
  const { transport } = site;
  const target = describeTarget(transport);
  let defaults: DatabaseDefaults | string | undefined;
  try {
    const read = await readBack(transport, claimed.dir, CONTENT_COPY_FILE);
    if (!readsBackWhole(read)) {
      throw new Error(
        `${leftoverMessage(target, claimed, [CONTENT_COPY_FILE])} Left: it does not read back ` +
          `(${inCopyProblem(read)}), so it was not put back.`,
      );
    }
    defaults = entries.includes(CONTENT_COPY_DB_DEFAULTS)
      ? await savedDefaults(transport, claimed.dir)
      : undefined;
    await putBackCopy(transport, claimed, site.terms);
  } catch (error) {
    // Given up: expired, so the next run tries again once nothing uses it, not after the lease —
    // best-effort, never masking why it failed (unexpired, the lease lapses by itself).
    await stampCopy(transport, claimed.dir, { ...site.terms, ttlS: 0 }).catch(
      () => undefined,
    );
    throw error;
  }
  const removed = await discardCopy(transport, claimed);
  console.warn(
    `[backwpup/content-copy] ${target}: put back a copy of wp-content an earlier run left ` +
      `orphaned (${why}; no process used it)${removed ? ", then removed it" : ""}: ` +
      `${claimed.dir}.` +
      (defaults === undefined
        ? ""
        : ` ${await setDefaultsBack(site, defaults)}`),
  );
}

/**
 * The database's defaults saved beside a copy.
 *
 * @param transport - the site.
 * @param dir - the copy's directory.
 * @returns them, or the reason they could not be read.
 */
async function savedDefaults(
  transport: Transport,
  dir: string,
): Promise<DatabaseDefaults | string> {
  const read = await inCopy(transport, dir, [
    "cat",
    "--",
    CONTENT_COPY_DB_DEFAULTS,
  ]);
  if (read.exitCode !== 0) return inCopyProblem(read);
  try {
    return parseDatabaseDefaults(read.stdout);
  } catch (error) {
    return errorMessage(error);
  }
}

/**
 * Sets the database's defaults back after a put-back, and says what the operator must know: the
 * restore cut off reached the database too, which may be partly restored either way.
 *
 * @param site - the site and how to set its database's defaults back.
 * @param defaults - what was saved, or why it could not be read.
 * @returns the sentence for the warning.
 */
async function setDefaultsBack(
  site: SettleSite,
  defaults: DatabaseDefaults | string,
): Promise<string> {
  const head =
    "Its restore reached the database too, which may be partly restored — check it; its default " +
    "character set and collation";
  if (typeof defaults === "string") {
    return `${head} could not be read back from the copy (${defaults}).`;
  }
  try {
    await site.setDefaults(site.transport, defaults);
    return `${head} were set back to ${defaults.charset} / ${defaults.collation}.`;
  } catch (error) {
    return `${head} could not be set back to ${defaults.charset} / ${defaults.collation}: ${errorMessage(error)}`;
  }
}

/**
 * Removes a claimed copy holding none to put back; says so.
 *
 * @param transport - the site.
 * @param claimed - where the claimed copy is.
 * @param entries - what it held, for the message.
 */
async function discardClaimed(
  transport: Transport,
  claimed: CopyPlace,
  entries: readonly string[],
): Promise<void> {
  const removed = await discardCopy(transport, claimed);
  const held = heldEntries(entries);
  console.warn(
    `[backwpup/content-copy] ${describeTarget(transport)}: a copy of wp-content no process uses ` +
      `held none to put back (${held.join(", ") || "nothing"}): no restore ` +
      "ran from it, or it was back already, so wp-content was left as it is" +
      (removed ? ` and the copy removed (${claimed.dir}).` : "."),
  );
}
