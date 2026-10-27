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
  readsBackWhole,
  stampCopy,
} from "./content-copy";
import {
  parseDatabaseDefaults,
  restoreDatabaseDefaults,
} from "./database-defaults";
import type { CopyPlace } from "./content-copy";
import type { DatabaseDefaults } from "./database-defaults";
import type { SiteConfig, Transport } from "../../../common/config/types";

/**
 * A copy of `wp-content` an earlier run left (`./content-copy.ts`), found before a run uses the site
 * (the auth setup's preflight, then every BackWPup worker): refused, since the site's `wp-content` may
 * be damaged and the copy may be the only way back — unless it is provably orphaned, when it is
 * settled and the run goes on.
 *
 * **A whole copy is orphaned when stamped by another boot of the host, and no process uses it.**
 * Every use of a copy is stamped with the boot id just before it ({@link CONTENT_COPY_STAMP}); a stamp
 * from another boot means every use so far ran under a kernel since gone. A use that could start
 * after the reboot from an older stamp — a runner on another machine reconnecting, or the replacement
 * of a worker whose teardown was abandoned — is caught by the second half: no process whose argv names
 * a copy of this site or that works in one, and no `wp backwpup restore` running in its WordPress root
 * (`IN_USE_SCRIPT`); checked before the claim and again after it. That narrows the window, it does
 * not close it: a use starting between the second check and the put-back is not seen — and the run
 * that made the copy refuses its own command if the host rebooted after the copy was taken, checked
 * just before the command, which narrows the reboot-after-stamp window the same way. No stamp (a copy
 * an older suite took), an unreadable one, or this boot's → refused: a live run may be between its
 * stamp and its command. Rejected: wall-clock times (a stepped clock moves `btime`; a sleeping runner wakes up) and
 * an age limit.
 *
 * **A copy holding none to put back is removed whenever no process uses it**, whatever its boot: no
 * restore ran from it, or it is back already, so it protects nothing — and a removal cut short (files
 * gone, directory left, stamp included) must not leave the site refused for good. A live run whose
 * copy this is fails safe at its next step: the in-copy script finds the directory gone (its copy or
 * seal fails, and the restore never runs), or its put-back had already succeeded.
 *
 * **Inspected read-only first**; claimed only to act: an elevated `mv -T` to a unique sibling
 * ({@link RECOVERING_PREFIX}) — atomic, so of two runs one wins and the other finds the source gone
 * and looks again — then judged again, checked for users again, and stamped, so another run reads it
 * as in use. A recovery cut off by a reboot leaves a claimed copy stamped by that boot, settled the
 * same way later.
 *
 * **Settled by what it holds** ({@link heldCopy}): the whole copy put back if it reads back, then
 * removed — and, when its restore reached the database too, the database's defaults saved beside it
 * set back, the operator told the database may be partly restored; none to put back — nothing, the
 * partial copy (the command runs only once the copy is whole), or the one already back — removed;
 * anything else refused.
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
}

/** What a leftover calls for. */
export type Verdict =
  | { readonly action: "put-back" | "discard" }
  | { readonly action: "refuse"; readonly why: string };

/** What is known about a leftover, read without changing it. */
export interface LeftoverFacts {
  /** Its directory's entries, or `undefined` when they could not be read. */
  readonly entries: readonly string[] | undefined;
  /** Its stamp's contents, or `undefined` when there is none or it could not be read. */
  readonly stamp: string | undefined;
  /** The host's current boot id, as read, or `undefined` when it could not be. */
  readonly bootId: string | undefined;
}

/**
 * What a leftover calls for: one holding none to put back is removed; a whole copy is put back only
 * when its stamp is provably another boot's; anything else is refused. Whether a process uses it is
 * asked separately, for both.
 *
 * @param facts - what was read.
 */
export function judgeLeftover(facts: LeftoverFacts): Verdict {
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
  if (stamp === bootId) {
    return {
      action: "refuse",
      why: "it was used since the host last booted, so a run may still be using it",
    };
  }
  return { action: "put-back" };
}

/**
 * Refuses a site holding a copy an earlier run left unless it is provably orphaned, which is then
 * settled — see the module header. A product's `settleLeftovers`, for the auth setup's preflight, and
 * the `contentCopyLeftover` worker fixture's body.
 *
 * Found as the transport's user. A site that cannot be asked is warned about, not refused — its
 * scenarios then fail in their own words — and a placeholder site is skipped.
 *
 * @param site - the site, or `undefined` when the project has none.
 * @param setDefaults - sets the database's defaults back after a put-back; the real one by default.
 * @throws {@link Error} naming the copy and how to settle it, when one is there and was not settled.
 */
export async function assertNoContentCopyLeft(
  site: Pick<SiteConfig, "baseURL" | "transport"> | undefined,
  setDefaults: SetDatabaseDefaults = restoreDatabaseDefaults,
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
      { transport, root, setDefaults },
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
  const verdict = judgeLeftover(facts);
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

  // Between the look and the claim, it may have changed or a use begun: the same checks, on what
  // was claimed — then stamped, so any other run reads it as in use.
  const again = await inspect(transport, claimed.dir);
  const reverdict = judgeLeftover(again);
  if (reverdict.action !== verdict.action) {
    throw refuse(
      claimed,
      reverdict.action === "refuse"
        ? reverdict.why
        : "it changed while it was claimed",
      again.entries,
    );
  }
  await assertUnused(transport, root, (why) =>
    refuse(claimed, why, again.entries),
  );
  const stamped = await stampCopy(transport, claimed.dir);
  if (stamped.exitCode !== 0) {
    throw refuse(
      claimed,
      `it could not be stamped (${inCopyProblem(stamped)})`,
      again.entries,
    );
  }
  await (verdict.action === "put-back"
    ? putBackClaimed(site, claimed, again.entries ?? [])
    : discardClaimed(transport, claimed, again.entries ?? []));
  return "settled";
}

/**
 * Reads, as root and changing nothing, what a leftover holds, its stamp and the current boot id.
 * Anything unreadable is `undefined`, which {@link judgeLeftover} refuses.
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
  const stamp =
    entries?.includes(CONTENT_COPY_STAMP) === true
      ? await inCopy(transport, dir, ["cat", "--", CONTENT_COPY_STAMP])
      : undefined;
  const boot = await exec(transport, "cat", [BOOT_ID_PATH]);
  return {
    entries,
    stamp: stamp?.exitCode === 0 ? stamp.stdout : undefined,
    bootId: boot.exitCode === 0 ? boot.stdout : undefined,
  };
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
  const users = await copyUsers(transport, root);
  if (users === undefined) {
    throw refuse("whether a process still uses it could not be checked");
  }
  const [first] = users;
  if (first !== undefined) {
    throw refuse(
      `a process still uses it (${String(users.length)}; first: ${first})`,
    );
  }
}

/**
 * Puts a claimed whole copy back, if it reads back, then removes it — and, when its restore reached
 * the database too, sets the database's defaults back; says so.
 *
 * @param site - the site, its WordPress root, and how to set its database's defaults back.
 * @param claimed - where the claimed copy is.
 * @param entries - what it holds.
 * @throws {@link Error} — the copy then kept — if it does not read back or could not be put back.
 */
async function putBackClaimed(
  site: SettleSite,
  claimed: CopyPlace,
  entries: readonly string[],
): Promise<void> {
  const { transport } = site;
  const target = describeTarget(transport);
  const read = await readBack(transport, claimed.dir, CONTENT_COPY_FILE);
  if (!readsBackWhole(read)) {
    throw new Error(
      `${leftoverMessage(target, claimed, [CONTENT_COPY_FILE])} Left: it does not read back ` +
        `(${inCopyProblem(read)}), so it was not put back.`,
    );
  }
  const defaults = entries.includes(CONTENT_COPY_DB_DEFAULTS)
    ? await savedDefaults(transport, claimed.dir)
    : undefined;
  await putBackCopy(transport, claimed);
  const removed = await discardCopy(transport, claimed);
  console.warn(
    `[backwpup/content-copy] ${target}: put back a copy of wp-content an earlier boot of the host ` +
      `orphaned${removed ? ", then removed it" : ""} (${claimed.dir}).` +
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
