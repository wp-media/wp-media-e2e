import { effectiveRunAs, runAsIdentity } from "../config/run-as";
import type { RunAs, ServerMode, Transport } from "../config/types";
import {
  FALLBACK_REASONS,
  describeIdentityState,
  idsOf,
} from "../wp/site-identity";
import type { IdentityState } from "../wp/site-identity";
import { writeFailure } from "../wp/web-identity";
import type {
  SiteIdentityVerdict,
  WebIdentity,
  WebProbeFailure,
} from "../wp/web-identity";
import { describeWpUserDrop } from "../wp/wp-user";
import type { WpUserCheck } from "../wp/wp-user";
import type { CheckResult } from "./preflight";
import type { SudoListing } from "./sudo-listing";
import { slowSudoLookup } from "./sudo-lookup";
import type { SudoLookup } from "./sudo-lookup";

/**
 * The pre-flight's "Site identity" report: who a site's commands run as, whether the web server was
 * seen running as the same identity, what a host still lacks (`!log_allowed`, a safe umask), and
 * what its sudo costs when the host's own name does not resolve. Pure: the facts are gathered by
 * `preflight.ts`, rendered here as one check (never a gate) and as the issues the run-level banner
 * lists (`elevation-report.ts`).
 *
 * The banner is silent when every site runs as its identity (`site`) or already is it (`same-user`),
 * that identity is the web server's as seen over HTTP, and sudo, where site commands go through it,
 * keeps their command lines out of its log — or opted out (`runAs` false: `disabled`, a choice, not a
 * fault) — and no sudo call waits a second or more on the host's own name (any state: root steps use
 * sudo too). Everything else the check reports (umask, WP-CLI's `--user`, a WP-CLI config that no
 * longer applies) stays on the site's own lines.
 */

/** The check's name in reports. */
export const SITE_IDENTITY_CHECK = "Site identity";

/** What the web probe gave: the verdict, or the message of the error that stopped it. */
export type WebProbeOutcome =
  | { readonly kind: "verdict"; readonly verdict: SiteIdentityVerdict }
  | { readonly kind: "error"; readonly detail: string };

/** The WordPress login's check: WP-CLI's verdict, or the message of the error that stopped it. */
export type WpUserOutcome =
  WpUserCheck | { readonly kind: "error"; readonly detail: string };

/** Everything the report needs about one site; absent fields were not asked. */
export interface IdentityFacts {
  readonly mode: ServerMode;
  /** `effectiveRunAs`: `undefined` off `ssh`. */
  readonly runAs: RunAs | undefined;
  /** The resolved state, or the message of the probe error that stopped its resolution. */
  readonly state:
    IdentityState | { readonly kind: "error"; readonly detail: string };
  /** The web probe's outcome; asked only where `runAs` names or detects an identity. */
  readonly web?: WebProbeOutcome;
  /** The WordPress login's check; asked only when the site has a login. */
  readonly wpUser?: WpUserOutcome;
  /** `sudo -n -l` read; asked only where site commands do or would go through sudo. */
  readonly sudo?: SudoListing;
  /** Whether the SSH user has `~/.wp-cli/config.yml`; asked only in the `site` state. */
  readonly wpCliConfig?: boolean;
  /** What the host's name costs each sudo call; asked only where the run sends commands through sudo. */
  readonly sudoLookup?: SudoLookup;
}

/** One thing the banner lists for a site: what is wrong, and how to fix it. */
export interface IdentityIssue {
  readonly what: string;
  /** How to fix it; absent when nothing is required (`what` then says so). */
  readonly fix?: string;
}

/**
 * Whether a transport asks to run as an identity: `ssh` with an effective `runAs` of `"auto"` or
 * `"user:group"` (`effectiveRunAs` is `undefined` off `ssh`). Only
 * such a site gets the web probe and `sudo -n -l` (an absent `runAs` is `"auto"`); one with `runAs`
 * false gets neither.
 *
 * @param transport - the site's transport.
 */
export function asksForIdentity(transport: Transport): boolean {
  const runAs = effectiveRunAs(transport);
  return runAs !== undefined && runAs !== false;
}

/**
 * Whether a umask leaves "other" its write bit (`0000`, `0001`, `0004`…): every file the identity
 * creates is then world-writable. The loader accepts such a umask on purpose; the report says so.
 *
 * @param umask - octal digits.
 */
export function worldWritable(umask: string): boolean {
  return (Number.parseInt(umask, 8) & 0o002) === 0;
}

/** How the web server's identity compares with who site commands run as. */
type Agreement =
  /** No comparison applies: commands run as the transport's user by design, or off `ssh`. */
  | { readonly kind: "n/a" }
  | { readonly kind: "matches" }
  | { readonly kind: "differs"; readonly runAs: string; readonly web: string }
  /** No web identity to compare: the probe was not asked, failed or could not read it. */
  | { readonly kind: "unknown"; readonly why: string };

/**
 * A web identity as `user(uid):group(gid)`.
 *
 * @param web - the identity.
 */
function webIds(web: WebIdentity): string {
  return idsOf(web.user, web.euid, web.group, web.egid);
}

/**
 * Whether a declared half (`name` or digits) is the web identity's.
 *
 * @param half - the declared user or group.
 * @param name - the web identity's name, if mapped.
 * @param id - its id.
 */
function sameHalf(half: string, name: string | undefined, id: number): boolean {
  return half === name || half === String(id);
}

/**
 * The web identity a verdict read, if any.
 *
 * @param web - the probe's outcome.
 * @returns it, or why there is none.
 */
function webIdentityOf(
  web: WebProbeOutcome | undefined,
): { readonly identity: WebIdentity } | { readonly why: string } {
  if (web === undefined) return { why: "no web probe ran" };
  if (web.kind === "error") return { why: "the web probe failed" };
  if (web.verdict.verdict === "unverified") {
    return { why: UNVERIFIED_WORDS[web.verdict.reason] };
  }
  return { identity: web.verdict.web };
}

/**
 * How the web identity compares with the run identity.
 *
 * @param facts - the site's facts.
 */
function agreement(facts: IdentityFacts): Agreement {
  const { state, runAs } = facts;
  if (state.kind === "site") {
    const seen = webIdentityOf(facts.web);
    if ("why" in seen) return { kind: "unknown", why: seen.why };
    const { identity } = state;
    return seen.identity.euid === identity.uid &&
      seen.identity.egid === identity.gid
      ? { kind: "matches" }
      : {
          kind: "differs",
          runAs: idsOf(
            identity.user,
            identity.uid,
            identity.group,
            identity.gid,
          ),
          web: webIds(seen.identity),
        };
  }
  if (state.kind !== "same-user" || state.reason === "mode") {
    return { kind: "n/a" };
  }
  // `auto` is `same-user` only once the verdict said PHP runs as the owner the SSH user is.
  if (runAs === "auto" || runAs === undefined || runAs === false) {
    return { kind: "matches" };
  }
  const seen = webIdentityOf(facts.web);
  if ("why" in seen) return { kind: "unknown", why: seen.why };
  const declared = runAsIdentity(runAs, "transport.runAs");
  return sameHalf(declared.user, seen.identity.user, seen.identity.euid) &&
    sameHalf(declared.group, seen.identity.group, seen.identity.egid)
    ? { kind: "matches" }
    : {
        kind: "differs",
        runAs: `${declared.user}:${declared.group}`,
        web: webIds(seen.identity),
      };
}

/** Each reason the web identity could not be read, in words. */
const UNVERIFIED_WORDS: Readonly<Record<WebProbeFailure | "no-owner", string>> =
  {
    "not-writable": "the probe file could not be written into the root",
    unreachable: "the site did not answer the probe",
    "not-served":
      "the probe was not served (WordPress in a subfolder of the root, or a docroot elsewhere)",
    "not-probe-output": "the web server did not run the probe as PHP",
    "no-posix": "PHP has no posix extension, so it cannot say who it runs as",
    "no-owner": "the docroot's owner could not be read",
  };

/**
 * What the web probe found, as one line, and whether it is a warning.
 *
 * @param web - the probe's outcome.
 */
function webLine(web: WebProbeOutcome): Note {
  if (web.kind === "error") {
    return warn(`The web server's identity could not be probed: ${web.detail}`);
  }
  const { verdict } = web;
  if (verdict.verdict === "unverified") {
    const noExcl =
      verdict.reason === "not-writable" &&
      writeFailure(verdict.detail) === "no-excl"
        ? " This host's `dd` has no `conv=excl` (BSD or BusyBox), so the probe is never written here."
        : "";
    return warn(
      `The web server's identity could not be read: ${UNVERIFIED_WORDS[verdict.reason]} ` +
        `(${verdict.detail}).${noExcl}`,
    );
  }
  const { web: who, owner } = verdict;
  const docroot = idsOf(owner.user, owner.uid, owner.group, owner.gid);
  return note(
    `The web server's PHP runs as ${webIds(who)}, umask ${who.umask} (${who.sapi}); the docroot is ` +
      `${docroot}${verdict.verdict === "owner-is-web" ? ", the same" : ""}.`,
  );
}

/** A line of the check's detail, and whether it is a warning. */
interface Note {
  readonly text: string;
  readonly warn: boolean;
}

/**
 * A note.
 *
 * @param text - its words.
 */
const note = (text: string): Note => ({ text, warn: false });

/**
 * A warning.
 *
 * @param text - its words.
 */
const warn = (text: string): Note => ({ text, warn: true });

/** The fix for sudo logging site commands' lines. */
const LOG_FIX =
  "add `Defaults:<ssh user> !log_allowed` in /etc/sudoers.d/ (sudo then keeps command lines out of " +
  "the system log)";

/**
 * Whether site commands do, or would once fixed, go through sudo: `site`, or a fallback of a site
 * asking for an identity.
 *
 * @param facts - the site's facts.
 */
function sudoMatters(facts: IdentityFacts): boolean {
  return facts.state.kind === "site" || facts.state.kind === "fallback";
}

/**
 * What `sudo -n -l` says, as a line, when it says anything worth one.
 *
 * @param facts - the site's facts.
 */
function sudoLogLine(facts: IdentityFacts): Note | undefined {
  const { sudo } = facts;
  if (sudo === undefined || !sudoMatters(facts)) return undefined;
  switch (sudo.kind) {
    case "listed":
      return sudo.logAllowed
        ? warn(
            "sudo logs every command line it runs, `--key=` values included. Fix: " +
              `${LOG_FIX}.`,
          )
        : note("sudo keeps command lines out of its log (`!log_allowed`).");
    case "refused":
      // `no-sudo` already says the rule is missing; anywhere else sudo works, so this is unknown.
      return facts.state.kind === "fallback" && facts.state.reason === "no-sudo"
        ? undefined
        : warn(sudoUnknown());
    case "unreadable":
      return warn(sudoUnknown());
  }
}

/** The line for a `sudo -n -l` that could not be read. */
const sudoUnknown = (): string =>
  `Whether sudo logs command lines is unknown (\`sudo -n -l\` gave no listing). Fix: ${LOG_FIX}.`;

/**
 * The WordPress login's line.
 *
 * @param outcome - its check.
 */
function wpUserLine(outcome: WpUserOutcome): Note {
  switch (outcome.kind) {
    case "use":
      return note(
        "WP-CLI runs WordPress as the site's WordPress login (`--user`).",
      );
    case "drop":
      return warn(describeWpUserDrop(outcome.reason));
    case "unknown":
      return warn(
        "The site's WordPress login could not be checked (WordPress gave no answer); WP-CLI runs " +
          "without --user until it can be.",
      );
    case "error":
      return warn(
        `The site's WordPress login could not be checked: ${outcome.detail}`,
      );
  }
}

/**
 * The state's own line.
 *
 * @param state - the state, or its resolution's error.
 */
function stateLine(state: IdentityFacts["state"]): Note {
  if (state.kind === "error") {
    return warn(`Could not be resolved: ${state.detail}`);
  }
  const text = describeIdentityState(state);
  const sentence = `${text.charAt(0).toUpperCase()}${text.slice(1)}${text.endsWith(".") ? "" : "."}`;
  return state.kind === "fallback" ? warn(sentence) : note(sentence);
}

/**
 * Every line of the check, in order.
 *
 * @param facts - the site's facts.
 */
function notes(facts: IdentityFacts): Note[] {
  const { state } = facts;
  const lines: Note[] = [stateLine(state)];
  if (facts.web !== undefined) lines.push(webLine(facts.web));
  const agreed = agreement(facts);
  if (agreed.kind === "differs") {
    lines.push(
      warn(
        `Commands run as ${agreed.runAs}, but the web server as ${agreed.web}: what the suite writes ` +
          "is not the website's.",
      ),
    );
  }
  if (state.kind === "site") {
    const seen = webIdentityOf(facts.web);
    if ("identity" in seen && seen.identity.umask !== state.umask) {
      lines.push(
        warn(
          `The web server's umask is ${seen.identity.umask}; site commands use ${state.umask}. ` +
            `Fix: set \`transport.umask\` to "${seen.identity.umask}".`,
        ),
      );
    }
    if (worldWritable(state.umask)) {
      lines.push(
        warn(
          `umask ${state.umask} leaves "other" write access: every file the identity creates is ` +
            "world-writable. Fix: a umask with the 2 bit, e.g. 0022.",
        ),
      );
    }
  }
  if (facts.wpUser !== undefined) lines.push(wpUserLine(facts.wpUser));
  const wait = slowSudoLookup(facts.sudoLookup);
  if (wait !== undefined) {
    lines.push(
      warn(
        `Every sudo call waits ${wait} for this host's own name, which does not resolve: site ` +
          "commands and root steps run, each that much slower.",
      ),
    );
  }
  const sudoLine = sudoLogLine(facts);
  if (sudoLine !== undefined) lines.push(sudoLine);
  if (state.kind === "site" && facts.wpCliConfig === true) {
    lines.push(
      warn(
        "The SSH user's ~/.wp-cli/config.yml no longer applies: WP-CLI runs as the identity, with " +
          "its own home. Move what it sets to the site's wp-cli.yml if the site needs it.",
      ),
    );
  }
  return lines;
}

/**
 * The "Site identity" check. Always passes (a host's property, never a gate); `warning` when a line
 * is one.
 *
 * @param facts - the site's facts.
 * @returns the check, its detail one line per finding, the state first.
 */
export function identityCheck(facts: IdentityFacts): CheckResult {
  const lines = notes(facts);
  return {
    name: SITE_IDENTITY_CHECK,
    ok: true,
    detail: lines.map((line) => line.text).join("\n"),
    ...(lines.some((line) => line.warn) ? { warning: true } : {}),
  };
}

/**
 * What the run-level banner lists for a site; empty when the site needs nothing (the banner's
 * silence: `site`/`same-user`, the web server seen running as that identity, and sudo, where it
 * matters, not logging command lines; or `disabled`, an opt-out — and sudo not slowed by the host's
 * name).
 *
 * @param facts - the site's facts.
 */
export function identityIssues(facts: IdentityFacts): IdentityIssue[] {
  const { state } = facts;
  const issues: IdentityIssue[] = [];
  switch (state.kind) {
    case "error":
      issues.push({
        what: `who site commands run as could not be resolved (${state.detail})`,
        fix: "check the transport; this site's checks above say more",
      });
      break;
    case "fallback": {
      const { what, fix } = FALLBACK_REASONS[state.reason];
      issues.push({ what: `${what} (${state.detail})`, fix });
      break;
    }
    case "disabled":
      // Never listed: `runAs` false is a deliberate opt-out (its check line says so), and a copy made
      // "as today" for one scenario is no host's property.
      break;
    default: {
      const agreed = agreement(facts);
      if (agreed.kind === "unknown") {
        issues.push({
          what: `the web server's identity was not verified: ${agreed.why}`,
          fix:
            "let the pre-flight's probe (e2e-identity-<hex>.php in the WordPress root) be written " +
            "and run by PHP at the site's address",
        });
      } else if (agreed.kind === "differs") {
        issues.push({
          what: `site commands run as ${agreed.runAs}, the web server as ${agreed.web}`,
          fix: 'set `runAs` to the web server\'s user and group, or "auto"',
        });
      }
    }
  }
  const sudoLine = sudoLogLine(facts);
  if (sudoLine?.warn === true) {
    issues.push({
      what:
        facts.sudo?.kind === "listed"
          ? "sudo logs every command line it runs, `--key=` values included"
          : "whether sudo logs command lines is unknown (`sudo -n -l` gave no listing)",
      fix: LOG_FIX,
    });
  }
  const wait = slowSudoLookup(facts.sudoLookup);
  if (wait !== undefined) {
    issues.push({
      what: `every sudo call waits ${wait} for this host's own name, which does not resolve; nothing is required: the run goes on, slower, until it does`,
    });
  }
  return issues;
}
