import {
  effectiveRunAs,
  effectiveUmask,
  runAsIdentity,
} from "../config/run-as";
import { errorMessage } from "../guards";
import { printableLine } from "../text";
import { execAsTransport, installKey, wpRootDir } from "./transport-exec";
import { parseIdentity, probeSiteOwnership } from "./owner-probe";
import { isSudoName, quotesSudoDenial, runAsArgv } from "./run-as-argv";
import { withoutSudoNoise } from "./sudo-noise";
import type { RunAs, ServerMode, Transport } from "../config/types";
import type { ExecResult } from "./transport-exec";
import type { SiteOwnership } from "./owner-probe";
import type { SudoTarget } from "./run-as-argv";
import type { SiteIdentityVerdict } from "./web-identity";

/**
 * Who a site's commands run as — its **identity state** — decided once per install per process.
 *
 * Over `ssh` the suite can run site commands as the web server's user and group (through `sudo`), so
 * what it writes looks as if the website wrote it. Whether it may is a chain of facts about the host:
 * the site's `transport.runAs`, the docroot's owner, who the transport's user already is, the
 * pre-flight's verdict on who PHP runs as (`web-identity.ts`), and one **run probe** through the
 * exact `sudo` wrapper commands will use. {@link decideIdentityState} is that chain as a pure state
 * machine: given what is known it returns the state, or the next probe it needs;
 * {@link resolveSiteIdentity} runs those probes and memoises the answer per install.
 *
 * Four states ({@link IdentityState}): `site` (run as the identity), `same-user` (the transport's user
 * already is it, or the mode has no other), `fallback` (asked for, not possible: a reason and its fix)
 * and `disabled` (`runAs: false`, or a copy from {@link asTransportUser}). Every state but `site`
 * runs commands as the transport's user, as before this module existed.
 *
 * **A probe that throws is never answered**: a transport failure is rethrown and nothing is cached, so
 * one dropped connection can never make a single call run as another user mid-scenario. Only a probe
 * that ran and said no becomes a `fallback`, kept for the process.
 *
 * Probes run as the transport's user (`id`, `stat`, the `sudo` probe itself), through
 * `./transport-exec.ts`'s `execAsTransport`, never through `exec` (`./exec.ts`), which asks this module
 * who to run as: what they measure must not depend on the answer they are computing, and this module
 * never imports `./exec.ts`.
 */

// ── States ───────────────────────────────────────────────────────────────────────────────────────

/** Why a site that asked to run as its identity runs as the transport's user instead. */
export type FallbackReason =
  /** `sudo -n` refused the run probe (no rule, or a group outside it), or there is no `sudo`. */
  | "no-sudo"
  /** `wp` failed under `sudo`: not on its `secure_path`, or broken there. */
  | "no-wp"
  /** The identity could not enter the WordPress root. */
  | "no-root-access"
  /** No identity to run as: the owner unreadable, root, or an account the host does not have. */
  | "no-identity"
  /** `auto`, and the pre-flight found PHP running as someone other than the docroot's owner. */
  | "owner-not-web"
  /** `auto`, and no pre-flight verdict for this run says the owner is PHP's identity. */
  | "unverified"
  /** The run probe ran as other ids than the identity asked for. */
  | "probe-mismatch";

/** Who site commands run as in the `site` state, as the run probe's `id` reported it. */
export interface RunIdentity {
  /** The user's name, else its uid as digits. */
  readonly user: string;
  /** The group's name, else its gid as digits. */
  readonly group: string;
  readonly uid: number;
  readonly gid: number;
  /** Every group id it carries, the primary one included (`id`'s `groups=`). */
  readonly groupIds: readonly number[];
  /** The names of those groups the host could map, the primary one included when `id` named it. */
  readonly groupNames: readonly string[];
}

/** A site's identity state. Every state but `site` runs commands as the transport's user. */
export type IdentityState =
  | {
      readonly kind: "site";
      /** What `sudo` is given (`runAsArgv`'s target). */
      readonly target: SudoTarget;
      /** Who the run probe ran as: `target`, resolved. */
      readonly identity: RunIdentity;
      /** The umask commands get, four octal digits. */
      readonly umask: string;
    }
  | {
      readonly kind: "same-user";
      /**
       * `mode`: docker/local have no other identity; `transport-user`: it already is the identity
       * (`runAs`'s, or for `auto` the docroot's owner the pre-flight saw PHP run as).
       */
      readonly reason: "mode" | "transport-user";
    }
  | {
      readonly kind: "fallback";
      readonly reason: FallbackReason;
      /** One printable line saying what was seen; never a credential. */
      readonly detail: string;
    }
  | {
      readonly kind: "disabled";
      /** `config`: `runAs: false`; `as-transport-user`: a copy from {@link asTransportUser}. */
      readonly reason: "config" | "as-transport-user";
    };

// ── The run probe ────────────────────────────────────────────────────────────────────────────────

/** The run probe's first line, so its output is told from a login shell's banner. */
const RUN_PROBE_MARK = "e2e-run-probe";

/** The run probe's exit when `id` failed. */
const ID_FAILED = 91;

/** The run probe's exit when `wp --info` failed. */
const WP_FAILED = 92;

/**
 * What the identity runs, inside the wrapper, in the WordPress root: the mark, `id`, then `wp --info`
 * (its output dropped: only whether it works matters), each failure its own exit code.
 */
const RUN_PROBE_SCRIPT =
  `echo ${RUN_PROBE_MARK} && { id || exit ${String(ID_FAILED)}; } && ` +
  `{ wp --info >/dev/null || exit ${String(WP_FAILED)}; }`;

/**
 * The run probe's argv, from `sudo` on: the wrapper every site command will use, running
 * {@link RUN_PROBE_SCRIPT} in `root`. One call proves `sudo`, the group rule, `/bin/sh`, entering the
 * root, `wp` on `secure_path` and the ids.
 *
 * @param target - who to run as.
 * @param umask - four octal digits.
 * @param root - the WordPress root.
 */
export function runProbeArgv(
  target: SudoTarget,
  umask: string,
  root: string,
): string[] {
  return runAsArgv(target, umask, root, "/bin/sh", ["-c", RUN_PROBE_SCRIPT]);
}

/** What the run probe found. */
export type RunProbeOutcome =
  /** It ran in the root with `wp` working; the ids `id` printed (`undefined`: unreadable). */
  | {
      readonly kind: "ran";
      readonly identity: RunIdentity | undefined;
    }
  /** It did not run (or ran but failed), and why, as a fallback reason. */
  | {
      readonly kind: "failed";
      readonly reason: Extract<
        FallbackReason,
        | "no-sudo"
        | "no-wp"
        | "no-root-access"
        | "no-identity"
        | "probe-mismatch"
      >;
      readonly detail: string;
    };

/** The detail for sudo's explicit deny, said in place of its message (which quotes the command). */
export const SUDO_DENIED =
  "sudo: a rule denies the transport's user this command as the site's identity";

/** The `sudo` messages for an account the host does not have. */
const UNKNOWN_ACCOUNT = /^sudo: unknown (?:user|group)\b/m;

/**
 * Reads the run probe's result. Pure. sudo's hostname noise is dropped first; the ids are read from
 * the lines after the mark only.
 *
 * - The mark printed: the wrapper got in → exit 0 is `ran`, {@link ID_FAILED} an unreadable `id`,
 *   {@link WP_FAILED} `no-wp`.
 * - No mark, and `sudo:` said an account is unknown → `no-identity`; any other `sudo:` line, sudo's
 *   explicit deny (`Sorry, user … is not allowed to execute …`), or no `sudo` at all (127) →
 *   `no-sudo`; otherwise the wrapper's `umask`/`cd` failed → `no-root-access`.
 *
 * The detail never quotes sudo's explicit deny, which quotes the command: it is named instead.
 *
 * @param result - what {@link runProbeArgv} returned.
 */
export function classifyRunProbe(result: ExecResult): RunProbeOutcome {
  const stderr = withoutSudoNoise(result.stderr).trim();
  const lines = result.stdout.split("\n");
  const mark = lines.findIndex((line) => line.trim() === RUN_PROBE_MARK);
  const said = quotesSudoDenial(stderr)
    ? SUDO_DENIED
    : detailLine(stderr, result.exitCode);
  /**
   * A failed outcome.
   *
   * @param reason - the fallback it leads to.
   */
  const failed = (
    reason: Extract<RunProbeOutcome, { kind: "failed" }>["reason"],
  ): RunProbeOutcome => ({ kind: "failed", reason, detail: said });
  if (mark !== -1) {
    if (result.exitCode === WP_FAILED) return failed("no-wp");
    if (result.exitCode !== 0 && result.exitCode !== ID_FAILED) {
      return failed("probe-mismatch");
    }
    const identity =
      result.exitCode === 0
        ? runIdentityFrom(lines.slice(mark + 1).join("\n"))
        : undefined;
    return { kind: "ran", identity };
  }
  if (UNKNOWN_ACCOUNT.test(stderr)) return failed("no-identity");
  if (
    /^sudo: /m.test(stderr) ||
    quotesSudoDenial(stderr) ||
    result.exitCode === 127
  ) {
    return failed("no-sudo");
  }
  return failed("no-root-access");
}

/**
 * The ids an `id` line reports, names where it gave them, ids as digits where not (BusyBox).
 *
 * @param stdout - `id`'s output.
 * @returns the identity, or `undefined` when no `uid=`/`gid=` line is there.
 */
export function runIdentityFrom(stdout: string): RunIdentity | undefined {
  const parsed = parseIdentity(stdout);
  if (parsed === undefined) return undefined;
  // `parseIdentity` keeps every group name but not which one is the primary's: read it off its line.
  const line = /^\s*uid=\d+.*$/m.exec(stdout)?.[0] ?? "";
  const group = /(?:^|\s)gid=\d+\(([^)]*)\)/.exec(line)?.[1];
  return {
    user: parsed.user ?? String(parsed.uid),
    group: group ?? String(parsed.gid),
    uid: parsed.uid,
    gid: parsed.gid,
    groupIds: parsed.groupIds,
    groupNames: parsed.groupNames,
  };
}

/**
 * A command's stderr as one printable line for a state's detail.
 *
 * @param stderr - its stderr, noise removed.
 * @param exitCode - its exit, said when stderr is empty.
 */
function detailLine(stderr: string, exitCode: number): string {
  const first = printableLine(stderr.split("\n", 1)[0] ?? "").slice(0, 200);
  return first === "" ? `exit ${String(exitCode)}` : first;
}

// ── The decision ─────────────────────────────────────────────────────────────────────────────────

/** What the transport's user learnt about the site, before any `sudo`. */
export interface SiteProbes {
  /** The docroot's owner (`wp-content`, else the root); `undefined` when unreadable. */
  readonly owner: SiteOwnership | undefined;
  /** Who the transport's user is; `undefined` when `id` was unusable. */
  readonly transportUser: RunIdentity | undefined;
}

/** Everything {@link decideIdentityState} may need; the probes' fields are filled in as they run. */
export interface IdentityInputs {
  readonly mode: ServerMode;
  /** `effectiveRunAs`: `undefined` off `ssh`. */
  readonly runAs: RunAs | undefined;
  /** The transport came from {@link asTransportUser}. */
  readonly transportUserCopy: boolean;
  /** `effectiveUmask`: `undefined` off `ssh`. */
  readonly umask: string | undefined;
  /** The pre-flight's verdict for this install, this run; `auto` needs it. */
  readonly verdict?: SiteIdentityVerdict;
  /** Owner and transport identity, once probed. */
  readonly site?: SiteProbes;
  /** The run probe's outcome, once run. */
  readonly runProbe?: RunProbeOutcome;
}

/** A probe {@link decideIdentityState} needs before it can decide. */
export type PendingProbe =
  | { readonly kind: "pending"; readonly probe: "site" }
  | {
      readonly kind: "pending";
      readonly probe: "run";
      readonly target: SudoTarget;
    };

/** Who `auto` or a declared `runAs` asks for, with the ids when known (from the owner). */
interface Wanted {
  readonly target: SudoTarget;
  readonly uid?: number;
  readonly gid?: number;
}

/**
 * The identity state, or the probe still needed to decide it. Pure; the order is the rule:
 *
 * 1. not `ssh` → `same-user/mode` (no `runAs` there, never `disabled`);
 * 2. `runAs` false → `disabled` (absent is `auto`);
 * 3. `auto` with no verdict → `fallback/unverified`, before any probe: none could change it (its fix,
 *    running the pre-flight, also reports an owner that is root or unreadable);
 * 4. owner and transport identity unknown → probe them;
 * 5. the identity: the declared `user:group` (re-checked by `runAsIdentity`; needs no verdict), or
 *    (`auto`) the owner — refused, unreadable or root → `fallback/no-identity`;
 * 6. `auto`: the verdict must say PHP runs as this owner → else `owner-not-web` or `unverified`, even
 *    when the transport's user is that owner (a deployment account PHP reaches through its group);
 * 7. the transport's user already is it → `same-user/transport-user`;
 * 8. no run probe yet → run it;
 * 9. its failure → that fallback; ids other than wanted (or root) → `probe-mismatch`/`no-identity`;
 *    else `site`.
 *
 * @param inputs - what is known.
 * @returns the state, or the probe to run next.
 */
export function decideIdentityState(
  inputs: IdentityInputs,
): IdentityState | PendingProbe {
  if (inputs.mode !== "ssh") return { kind: "same-user", reason: "mode" };
  const { runAs } = inputs;
  if (runAs === undefined || runAs === false) {
    return {
      kind: "disabled",
      reason: inputs.transportUserCopy ? "as-transport-user" : "config",
    };
  }
  if (runAs === "auto" && inputs.verdict === undefined) {
    return fallback(
      "unverified",
      "no pre-flight verdict for this site in this run",
    );
  }
  if (inputs.site === undefined) return { kind: "pending", probe: "site" };
  const wanted = wantedIdentity(runAs, inputs.site.owner);
  if ("kind" in wanted) return wanted;
  // `auto` reached here with a verdict (step 3) and an owner (step 5 settles a missing one).
  if (
    runAs === "auto" &&
    inputs.verdict !== undefined &&
    inputs.site.owner !== undefined
  ) {
    const refused = refuseByVerdict(inputs.verdict, inputs.site.owner);
    if (refused !== undefined) return refused;
  }
  const { transportUser } = inputs.site;
  if (transportUser !== undefined && isWanted(transportUser, wanted)) {
    return { kind: "same-user", reason: "transport-user" };
  }
  if (inputs.runProbe === undefined) {
    return { kind: "pending", probe: "run", target: wanted.target };
  }
  return afterRunProbe(inputs.runProbe, wanted, inputs.umask);
}

/**
 * Step 5: who to run as.
 *
 * @param runAs - `"auto"` or a declared identity.
 * @param owner - the docroot's owner, if read.
 * @returns who, or the `fallback/no-identity` state saying why nobody.
 */
function wantedIdentity(
  runAs: Exclude<RunAs, false>,
  owner: SiteOwnership | undefined,
): Wanted | IdentityState {
  let wanted: Wanted;
  if (runAs !== "auto") {
    try {
      // The loader's rule again (no root, no id past the range): a transport built by hand is held to it.
      wanted = {
        target: runAsIdentity(runAs, "[wp/site-identity] transport.runAs"),
      };
    } catch (error) {
      return fallback("no-identity", printableLine(errorMessage(error)));
    }
  } else if (owner === undefined) {
    return fallback("no-identity", "the docroot's owner could not be read");
  } else if (owner.uid === 0 || owner.gid === 0) {
    return fallback("no-identity", "the docroot is owned by root");
  } else {
    wanted = {
      target: { user: owner.user, group: owner.group },
      uid: owner.uid,
      gid: owner.gid,
    };
  }
  if (!isSudoName(wanted.target.user) || !isSudoName(wanted.target.group)) {
    return fallback(
      "no-identity",
      "the identity's name cannot be given to sudo",
    );
  }
  return wanted;
}

/**
 * Step 6: `auto` whose verdict does not say this owner is PHP's identity.
 *
 * @param verdict - the pre-flight's.
 * @param owner - the owner this process read (a verdict about another owner is not evidence).
 * @returns the fallback, or `undefined` to go on.
 */
function refuseByVerdict(
  verdict: SiteIdentityVerdict,
  owner: SiteOwnership,
): IdentityState | undefined {
  if (verdict.verdict === "unverified") {
    return fallback(
      "unverified",
      `the pre-flight could not tell (${verdict.reason}: ${verdict.detail})`,
    );
  }
  if (verdict.owner.uid !== owner.uid || verdict.owner.gid !== owner.gid) {
    return fallback(
      "unverified",
      "the docroot's owner changed since the pre-flight",
    );
  }
  if (verdict.verdict === "owner-not-web") {
    return fallback(
      "owner-not-web",
      `PHP runs as ${idsOf(verdict.web.user, verdict.web.euid, verdict.web.group, verdict.web.egid)}, ` +
        `the docroot is ${idsOf(owner.user, owner.uid, owner.group, owner.gid)}`,
    );
  }
  return undefined;
}

/**
 * Step 9: the run probe's outcome.
 *
 * @param outcome - what it found.
 * @param wanted - who it was asked to run as.
 * @param umask - the umask commands will get.
 */
function afterRunProbe(
  outcome: RunProbeOutcome,
  wanted: Wanted,
  umask: string | undefined,
): IdentityState {
  if (outcome.kind === "failed") {
    return fallback(outcome.reason, outcome.detail);
  }
  const { identity } = outcome;
  if (identity === undefined) {
    return fallback("probe-mismatch", "`id` printed no identity under sudo");
  }
  if (identity.uid === 0 || identity.gid === 0) {
    return fallback("no-identity", "the identity is root on this host");
  }
  if (!isWanted(identity, wanted)) {
    return fallback(
      "probe-mismatch",
      `sudo ran as ${idsOf(identity.user, identity.uid, identity.group, identity.gid)}, not ` +
        `${wanted.target.user}:${wanted.target.group}`,
    );
  }
  return {
    kind: "site",
    target: wanted.target,
    identity,
    umask: umask ?? "0022",
  };
}

/**
 * Whether an identity is the one wanted: by id where the wanted half has one (from the owner, or
 * declared as digits), by name otherwise. User and group both: the group decides who else may write.
 *
 * @param identity - who something runs as.
 * @param wanted - who it should be.
 */
function isWanted(identity: RunIdentity, wanted: Wanted): boolean {
  /**
   * One half (user or group) compared.
   *
   * @param name - the wanted name, or an id as digits.
   * @param id - the wanted id, when known.
   * @param actual - the name the identity has.
   * @param actualId - the id it has.
   */
  const half = (
    name: string,
    id: number | undefined,
    actual: string,
    actualId: number,
  ): boolean => {
    if (id !== undefined) return actualId === id;
    return /^\d+$/.test(name) ? actualId === Number(name) : actual === name;
  };
  return (
    half(wanted.target.user, wanted.uid, identity.user, identity.uid) &&
    half(wanted.target.group, wanted.gid, identity.group, identity.gid)
  );
}

/**
 * `user(uid):group(gid)` for a detail line.
 *
 * @param user - the name, if known.
 * @param uid - the id.
 * @param group - the name, if known.
 * @param gid - the id.
 */
export function idsOf(
  user: string | undefined,
  uid: number,
  group: string | undefined,
  gid: number,
): string {
  /**
   * `name(id)`, or the id alone when the name is unknown or is the id.
   *
   * @param name - the name, if known.
   * @param id - the id.
   */
  const one = (name: string | undefined, id: number): string =>
    name === undefined || name === String(id)
      ? String(id)
      : `${name}(${String(id)})`;
  return `${one(user, uid)}:${one(group, gid)}`;
}

/**
 * A fallback state.
 *
 * @param reason - why.
 * @param detail - what was seen.
 */
function fallback(reason: FallbackReason, detail: string): IdentityState {
  return { kind: "fallback", reason, detail };
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

/** How a site stops asking for an identity: the end of each fix below but one. */
export const RUN_AS_OPT_OUT = 'or set `"runAs": false` to opt the site out';

/**
 * Each fallback reason in words, and its fix. Every fix but `probe-mismatch`'s (sudo misbehaving,
 * worth a look before anything else) ends with {@link RUN_AS_OPT_OUT}: since `runAs` defaults to
 * `"auto"`, a host that cannot meet the checklist is otherwise warned on every run.
 */
export const FALLBACK_REASONS: Readonly<
  Record<FallbackReason, { readonly what: string; readonly fix: string }>
> = {
  "no-sudo": {
    what: "sudo refused to run as the site's identity",
    fix:
      "give the SSH user passwordless sudo (`<ssh user> ALL=(ALL) NOPASSWD: ALL`; `(ALL:ALL)` when " +
      "the group is not one of the web user's) and `Defaults:<ssh user> !log_allowed`, " +
      RUN_AS_OPT_OUT,
  },
  "no-wp": {
    what: "WP-CLI does not run under sudo",
    fix: `install \`wp\` on sudo's secure_path (e.g. /usr/local/bin/wp), ${RUN_AS_OPT_OUT}`,
  },
  "no-root-access": {
    what: "the site's identity cannot enter the WordPress root",
    fix: `give the web server's user search access to the root and its parents, ${RUN_AS_OPT_OUT}`,
  },
  "no-identity": {
    what: "there is no usable identity to run as",
    fix:
      "chown -R the docroot to the web server's user and group (never root), set `runAs` to an " +
      `account the host has, ${RUN_AS_OPT_OUT}`,
  },
  "owner-not-web": {
    what: "PHP does not run as the docroot's owner",
    fix:
      "chown -R the docroot to the user and group PHP runs as, set `runAs` to them explicitly, " +
      RUN_AS_OPT_OUT,
  },
  unverified: {
    what: "the web server's identity was not verified in this run",
    fix:
      "run with the auth setup (not --no-deps) so the pre-flight asks the web server, set `runAs` " +
      `to the web server's user and group, ${RUN_AS_OPT_OUT}`,
  },
  "probe-mismatch": {
    what: "sudo ran the probe as another identity than asked",
    fix: "check the sudoers rule and the identity's name on the host",
  },
};

/**
 * A state in one line for a report or warning, never naming a credential.
 *
 * @param state - the state.
 * @returns e.g. `runs as www-data(33):www-data(33), umask 0022`, or a fallback's reason, detail and fix.
 */
export function describeIdentityState(state: IdentityState): string {
  switch (state.kind) {
    case "site":
      return (
        `runs as ${idsOf(state.identity.user, state.identity.uid, state.identity.group, state.identity.gid)}, ` +
        `umask ${state.umask}`
      );
    case "same-user":
      return state.reason === "mode"
        ? "runs as the transport's user (this mode has no other identity)"
        : "runs as the transport's user, which already is the identity asked for (`runAs`'s, or the " +
            "docroot's owner the web server runs as)";
    case "fallback": {
      const { what, fix } = FALLBACK_REASONS[state.reason];
      return `runs as the transport's user: ${what} (${state.detail}). Fix: ${fix}.`;
    }
    case "disabled":
      return state.reason === "config"
        ? "runs as the transport's user, as configured (`runAs` is false); nothing to fix"
        : "runs as the transport's user, as this scenario asks";
    default: {
      const exhaustive: never = state;
      throw new Error(
        `[wp/site-identity] unknown state ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// ── Resolution, memoised ─────────────────────────────────────────────────────────────────────────

/** Resolved (or resolving) states, per {@link memoKey}; a rejected one is removed. */
const resolved = new Map<string, Promise<IdentityState>>();

/** The pre-flight's verdicts this process was given, per `installKey`. */
const verdicts = new Map<string, SiteIdentityVerdict>();

/** Transports {@link asTransportUser} made, so their `disabled` state says why. */
const transportUserCopies = new WeakSet<Transport>();

/**
 * The cache key: the install, plus what decides the state from it (`runAs`, `umask`), so a copy with
 * another `runAs` never reads this one's answer.
 *
 * @param transport - an `ssh` transport with `runAs` set.
 */
function memoKey(transport: Transport): string {
  return `${installKey(transport)}\u0000${String(effectiveRunAs(transport))}\u0000${String(effectiveUmask(transport))}`;
}

/**
 * Gives this process the pre-flight's verdicts (the auth setup's own, or a worker's read of the
 * verdict file). Forgets any state already resolved for those installs, so a state decided before the
 * verdict arrived is decided again: call it before any site command.
 *
 * @param entries - verdicts per `installKey`.
 */
export function registerSiteIdentityVerdicts(
  entries: ReadonlyMap<string, SiteIdentityVerdict>,
): void {
  for (const [key, verdict] of entries) {
    verdicts.set(key, verdict);
    for (const memo of resolved.keys()) {
      if (memo.startsWith(`${key}\u0000`)) resolved.delete(memo);
    }
  }
}

/**
 * The site's identity state, resolved once per install per process (concurrent callers share one
 * resolution).
 *
 * @param transport - the site's transport.
 * @returns the state: for a probed one, the memoised promise itself (every caller gets the same
 * object), which {@link forgetSiteIdentity} is handed to forget exactly that resolution.
 * @throws Error if a probe could not run (the transport failed): rejected, never answered, never
 * cached — the next call asks again.
 */
export function resolveSiteIdentity(
  transport: Transport,
): Promise<IdentityState> {
  let base: IdentityInputs;
  let immediate: ReturnType<typeof decideIdentityState>;
  try {
    base = baseInputs(transport);
    immediate = decideIdentityState(base);
  } catch (error) {
    // Rejected, never thrown: callers `await` it, or `.catch` it, as they would an async function.
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
  // `disabled` and `same-user/mode` need no probe, so they are neither cached nor shared.
  if (immediate.kind !== "pending") return Promise.resolve(immediate);
  const key = memoKey(transport);
  const cached = resolved.get(key);
  if (cached !== undefined) return cached;
  const resolution = runProbes(transport, base);
  resolved.set(key, resolution);
  resolution.catch(() => {
    if (resolved.get(key) === resolution) resolved.delete(key);
  });
  return resolution;
}

/**
 * The inputs known without a probe.
 *
 * @param transport - the site's transport.
 */
function baseInputs(transport: Transport): IdentityInputs {
  const verdict = verdicts.get(installKey(transport));
  return {
    mode: transport.mode,
    runAs: effectiveRunAs(transport),
    transportUserCopy: transportUserCopies.has(transport),
    umask: effectiveUmask(transport),
    ...(verdict !== undefined ? { verdict } : {}),
  };
}

/** The most probes a decision can need: the site's, then the run probe. */
const MAX_STEPS = 2;

/**
 * Runs the probes {@link decideIdentityState} asks for until it decides.
 *
 * @param transport - the site's transport.
 * @param base - the inputs known without a probe.
 * @throws Error from a probe that could not run.
 */
async function runProbes(
  transport: Transport,
  base: IdentityInputs,
): Promise<IdentityState> {
  let inputs = base;
  for (let step = 0; step <= MAX_STEPS; step += 1) {
    const decision = decideIdentityState(inputs);
    if (decision.kind !== "pending") return decision;
    if (decision.probe === "site") {
      const owner = await probeSiteOwnership(transport);
      const transportUser = await probeTransportUser(transport);
      inputs = { ...inputs, site: { owner, transportUser } };
    } else {
      inputs = {
        ...inputs,
        runProbe: await runRunProbe(transport, decision.target, inputs.umask),
      };
    }
  }
  // Each step fills one input the decision then has, so this is unreachable unless the rule changes.
  throw new Error(
    "[wp/site-identity] the identity decision asked for a probe it already had.",
  );
}

/**
 * Runs the run probe as the transport's user, from `/` (the wrapper enters the root itself).
 *
 * @param transport - the site's transport.
 * @param target - who to run as.
 * @param umask - the umask, `undefined` only off `ssh` (never reached there).
 * @throws Error if the transport failed.
 */
async function runRunProbe(
  transport: Transport,
  target: SudoTarget,
  umask: string | undefined,
): Promise<RunProbeOutcome> {
  const argv = runProbeArgv(
    target,
    umask ?? "0022",
    await wpRootDir(transport),
  );
  const [file = "sudo", ...args] = argv;
  return classifyRunProbe(
    await execAsTransport(transport, file, args, { cwd: "/" }),
  );
}

/**
 * Who the transport's user is, from `id` with no arguments.
 *
 * @param transport - the site's transport.
 * @returns the identity, or `undefined` when `id` failed or printed none.
 * @throws Error if the transport failed.
 */
async function probeTransportUser(
  transport: Transport,
): Promise<RunIdentity | undefined> {
  const { exitCode, stdout } = await execAsTransport(transport, "id", []);
  return exitCode === 0 ? runIdentityFrom(stdout) : undefined;
}

/**
 * Forgets the state resolved for this transport (its install, `runAs` and umask), so the next command
 * resolves it again: `exec` calls it when `sudo` refuses an identity it had verified. Only `resolution`
 * is forgotten: a refusal arriving late, from a command started on an older resolution, leaves a newer
 * one alone (else every command in flight would resolve again). Verdicts stay.
 *
 * @param transport - the site's transport.
 * @param resolution - the promise {@link resolveSiteIdentity} gave the refused command.
 */
export function forgetSiteIdentity(
  transport: Transport,
  resolution: Promise<IdentityState>,
): void {
  const key = memoKey(transport);
  if (resolved.get(key) === resolution) resolved.delete(key);
}

/** Forgets every resolved state and verdict. For specs; a run never changes its mind. */
export function resetSiteIdentityCaches(): void {
  resolved.clear();
  verdicts.clear();
}

// ── "As today" ───────────────────────────────────────────────────────────────────────────────────

/**
 * The transport as commands ran before the site identity existed: the transport's own user, no
 * `sudo`, no `--user`. A frozen copy without `wpUser`; over `ssh` also `runAs: false`
 * (`docker`/`local` have no `runAs`: they stay `same-user`, and only `--user` goes). Idempotent: a
 * copy is returned as it is.
 *
 * @param transport - a site's transport.
 * @returns the copy.
 */
export function asTransportUser(transport: Transport): Transport {
  if (transportUserCopies.has(transport)) return transport;
  const { wpUser: _dropped, ...rest } = transport;
  const copy: Transport = Object.freeze(
    rest.mode === "ssh" ? { ...rest, runAs: false as const } : rest,
  );
  transportUserCopies.add(copy);
  return copy;
}
