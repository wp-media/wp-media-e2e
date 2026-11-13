import { TEXT_PALETTE } from "../terminal/palette";
import type { Palette } from "../terminal/palette";
import { maskSiteUrl, printableLine, printableLines } from "../text";
import type { ElevationSupport } from "../wp/exec";
import type { IdentityIssue } from "./site-identity-report";

/**
 * The run-level warnings: sites that cannot run a privileged housekeeping command, and sites holding a
 * plugin folder WordPress no longer lists ({@link renderPluginDirWarning}).
 *
 * Elevation is otherwise a **silent** dependency: it is probed lazily, deep inside a teardown, and a
 * host without it degrades quietly — leftover plugin data is never removed, `debug.log` may not be
 * clearable, and the plugin under test keeps the transport user's ownership so the web server cannot
 * write it. Every one of those surfaces days later as a disk-full alert or an unexplained failure,
 * which is why this says so at the *start* of a run instead.
 *
 * It is a **warning, not a failure**: nothing is broken, and a suite on such a host still runs. So
 * this only ever renders text — the caller prints it and carries on, and no site's pass/fail verdict
 * depends on it.
 *
 * Kept apart from `preflight.ts` because it is wanted in two places (the auth setup's pool
 * verification and the standalone fleet healthcheck) and because a pure results-in/string-out
 * function can be tested without a terminal, a transport, or a WordPress. Colour and symbols come
 * from the caller's palette — the stream it prints to decides them; plain Unicode text by default.
 * Both are printed, never thrown, so each site's values (address, transport, folders) are made safe
 * to print ({@link siteLine}, {@link printableLines}).
 */

/** One site's elevation state, as the banner needs to name it. */
export interface SiteElevation {
  /** The site's base URL, as reports identify it. */
  readonly baseURL: string;
  /** The site's transport, already rendered (e.g. `ssh: ubuntu@203.0.113.10`). */
  readonly transport: string;
  /** What `elevationSupport` answered for it. */
  readonly support: ElevationSupport;
  /**
   * Whether this site's files actually need handing to another owner. `false` when the transport's
   * user already owns the install — the normal `docker` shape — or the site is in the `site` identity
   * state (commands write as the web server), where losing privileges costs cleanup but not
   * ownership. Kept per site so the banner cannot assert a cost the pre-flight check
   * printed directly above it denies.
   */
  readonly ownershipPending: boolean;
}

/**
 * What every affected site loses without privileges, in the order an operator will notice it. Kept
 * as one list because they share a cause, and reporting them separately would invite fixing one.
 */
const COSTS: readonly ((arrow: string) => string)[] = [
  (arrow) =>
    `leftover plugin data is NOT removed ${arrow} the site accumulates it every scenario`,
  () => "`debug.log` may not be clearable between scenarios",
];

/**
 * The cost that applies only where a handover was actually needed.
 *
 * Stated separately because it is the one an operator can check: pre-flight prints each site's
 * ownership decision, and a site whose transport user already owns the install (or in the `site`
 * identity state) is told there that nothing will be changed. Listing this unconditionally would
 * contradict that line one paragraph later, which is how a banner stops being read.
 */
const ownershipCost = (arrow: string): string =>
  `plugin file ownership is NOT normalized ${arrow} the web server cannot write into the plugin it is testing`;

/**
 * Renders the warning for whichever sites answered `unavailable`.
 *
 * `disabled` is deliberately **not** reported: the site declares `transport.elevate: false`, so the
 * operator already chose this and warning about it every run would train them to ignore the banner
 * that matters.
 *
 * @param sites - every real site checked in this run, with the elevation each reported.
 * @param palette - colour and symbols for the stream it is printed to; plain Unicode text by default.
 * @returns the banner, styled by `palette` and padded with blank lines above and below so it cannot
 * be lost in tightly-packed output — or `undefined` when no site needs it, which is the normal case
 * and must print nothing at all.
 */
export function renderElevationWarning(
  sites: readonly SiteElevation[],
  palette: Palette = TEXT_PALETTE,
): string | undefined {
  const affected = sites.filter((site) => site.support === "unavailable");
  if (affected.length === 0) return undefined;

  const lines: string[] = [""];
  // Counted as affected sites only, with no denominator: the caller passes the sites that got far
  // enough to be *asked*, so "2 of 2" would be the reading on a run where a third site failed its
  // transport outright — a denominator that quietly means something other than "the fleet".
  // Sites *and* hosts: the remedy below is one `sudoers.d` edit per host, and a fleet where ten
  // sites share one box would otherwise read as ten things to fix.
  const hosts = new Set(affected.map((site) => site.transport));
  const scope =
    hosts.size === affected.length
      ? `${String(affected.length)} site(s)`
      : `${String(affected.length)} site(s) across ${String(hosts.size)} host(s)`;
  const { paint, symbol } = palette;
  const arrow = symbol("arrow");
  lines.push(
    headline(
      palette,
      `ELEVATION UNAVAILABLE ${symbol("dash")} cleanup will be incomplete on ${scope}`,
    ),
  );
  lines.push("");
  const pending = affected.filter((site) => site.ownershipPending);
  for (const site of affected) {
    // Marked rather than listed twice: the operator needs one list of sites and one remedy, and the
    // marker is what ties the extra cost below to the sites it is true for.
    const mark = site.ownershipPending
      ? `  ${symbol("backArrow")}  ownership handover pending`
      : "";
    lines.push(`${siteLine(site)}${mark}`);
  }
  lines.push("");
  // Both causes are named because `sudo` reports them identically — it will not say whether a user
  // is a sudoer — and the remedy is the same either way.
  lines.push(
    "     `sudo -n true` failed for this transport's user. Either it is not a sudoer, or",
  );
  lines.push(
    `     sudo requires a password ${symbol("dash")} sudo reports both identically, so this cannot tell`,
  );
  lines.push("     them apart.");
  lines.push("");
  lines.push("     What this costs on each site above:");
  const bullet = symbol("bullet");
  for (const cost of COSTS) {
    lines.push(`       ${bullet} ${cost(arrow)}`);
  }
  if (pending.length > 0) {
    lines.push(`       ${bullet} ${ownershipCost(arrow)}`);
    lines.push(
      "         (on the sites marked above; the others already own their install)",
    );
  }
  lines.push("");
  lines.push(
    `     ${paint("warn", arrow)} grant passwordless sudo, e.g. \`<user> ALL=(ALL) NOPASSWD:ALL\` in /etc/sudoers.d/`,
  );
  lines.push(
    `     ${paint("warn", arrow)} or accept it deliberately: set \`transport.elevate: false\` on the site to`,
  );
  lines.push("       silence this warning and keep the suite unprivileged.");
  lines.push("");
  return lines.join("\n");
}

/** One site's plugin folders WordPress lists no plugin in, as the banner names them. */
export interface SitePluginDirs {
  /** The site's base URL, as reports identify it. */
  readonly baseURL: string;
  /** The site's transport, already rendered (e.g. `ssh: ubuntu@203.0.113.10`). */
  readonly transport: string;
  /** Each leftover folder, already described (`describePluginDir`). */
  readonly leftovers: readonly string[];
}

/**
 * Renders the warning for sites holding part of a plugin WordPress no longer lists, at the slug their
 * cell installs as — what a removal stopped part-way leaves, and what blocks every install of that
 * plugin until it goes.
 *
 * A **warning, not a failure**: the cell's next `@plugin` scenario on the site removes it and says so. Shown
 * at the start of a run — and by the fleet healthcheck — so the cause is visible before a scenario
 * pays for it.
 *
 * @param sites - every real site checked in this run, with its leftover folders.
 * @param palette - colour and symbols for the stream it is printed to; plain Unicode text by default.
 * @returns the banner, padded like {@link renderElevationWarning}'s, or `undefined` when no site
 * holds one.
 */
export function renderPluginDirWarning(
  sites: readonly SitePluginDirs[],
  palette: Palette = TEXT_PALETTE,
): string | undefined {
  const affected = sites.filter((site) => site.leftovers.length > 0);
  if (affected.length === 0) return undefined;

  const lines: string[] = [""];
  const { symbol } = palette;
  lines.push(
    headline(
      palette,
      `LEFTOVER PLUGIN FOLDERS ${symbol("dash")} WordPress lists no plugin in them, on ${String(affected.length)} site(s)`,
    ),
  );
  lines.push("");
  for (const site of affected) {
    lines.push(siteLine(site));
    for (const leftover of site.leftovers) {
      const [first = "", ...rest] = printableLines(leftover);
      lines.push(
        `       ${symbol("bullet")} ${first}`,
        ...rest.map((line) => `         ${line}`),
      );
    }
  }
  lines.push("");
  lines.push(
    `     A removal stopped part-way ${symbol("dash")} a PHP-FPM restart, a reboot ${symbol("dash")} leaves these, and each blocks`,
  );
  lines.push(
    "     every install of its plugin. The next @plugin scenario on the site removes it and says so.",
  );
  lines.push("");
  return lines.join("\n");
}

/** One site's site identity issues, as the banner names them. */
export interface SiteIdentityIssues {
  /** The site's base URL, as reports identify it. */
  readonly baseURL: string;
  /** The site's transport, already rendered (e.g. `ssh: ubuntu@203.0.113.10`). */
  readonly transport: string;
  /** What `identityIssues` found; empty when nothing. */
  readonly issues: readonly IdentityIssue[];
}

/**
 * Renders the warning for sites whose commands do not run as the web server's identity, whose
 * identity was not verified over HTTP, or whose sudo logs command lines (`--key=` values included).
 * A site listed twice (one install, two products' cells) is shown once.
 *
 * A **warning, not a failure**: a fallback runs as it always did (the transport's user, files handed
 * over); any other site runs as its check says. Silent when no site has an issue: every site runs as
 * its verified identity, already is it, or opted out (`runAs` false), sudo keeps site commands' lines
 * out of its log, and — in any state, `runAs` false included — no sudo call the run makes waits 1 s or
 * more for the host's own name. An issue with nothing to fix (that wait) gets no fix line, and a
 * banner of only such issues is headed "to note", not "need attention".
 *
 * @param sites - every real site checked in this run, with its issues.
 * @param palette - colour and symbols for the stream it is printed to; plain Unicode text by default.
 * @returns the banner, padded like {@link renderElevationWarning}'s, or `undefined` when no site has
 * an issue.
 */
export function renderIdentityWarning(
  sites: readonly SiteIdentityIssues[],
  palette: Palette = TEXT_PALETTE,
): string | undefined {
  // One install checked by two products (a twin, a shared host) is listed once.
  const seen = new Set<string>();
  const affected = sites.filter((site) => {
    const key = `${site.baseURL}\u0000${site.transport}`;
    if (site.issues.length === 0 || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (affected.length === 0) return undefined;

  const { paint, symbol } = palette;
  // Only notes (nothing to fix, e.g. a slow host lookup): nothing "needs attention".
  const toFix = affected.some((site) =>
    site.issues.some((issue) => issue.fix !== undefined),
  );
  const lines: string[] = [
    "",
    headline(
      palette,
      `SITE IDENTITY ${symbol("dash")} ${String(affected.length)} site(s) ${toFix ? "need attention" : "to note"}`,
    ),
    "",
  ];
  for (const site of affected) {
    lines.push(siteLine(site));
    for (const { what, fix } of site.issues) {
      const [first = "", ...rest] = printableLines(what);
      lines.push(
        `       ${symbol("bullet")} ${first}`,
        ...rest.map((line) => `         ${line}`),
      );
      if (fix === undefined) continue;
      const [fixFirst = "", ...fixRest] = printableLines(fix);
      lines.push(
        `         ${paint("warn", symbol("arrow"))} ${fixFirst}`,
        ...fixRest.map((line) => `           ${line}`),
      );
    }
  }
  lines.push("");
  lines.push(
    `     None of these fails a site ${symbol("dash")} a fallback runs as the transport's user, handing files`,
  );
  lines.push(
    '     over as before; the rest run as their "Site identity" check says, which says more.',
  );
  lines.push("");
  return lines.join("\n");
}

/**
 * A site as a banner names it: its address and transport, each made safe to print — they come from a
 * sites file and a site, and the banner becomes a setup's output, which the reports keep (a basic-auth
 * `baseURL` is masked).
 *
 * @param site - the site's address and rendered transport.
 * @returns `     address  [transport]`.
 */
function siteLine(site: {
  readonly baseURL: string;
  readonly transport: string;
}): string {
  return `     ${printableLine(maskSiteUrl(site.baseURL))}  [${printableLine(site.transport)}]`;
}

/**
 * A banner's headline: the warning mark and the words, both bold and in the warning colour, so the
 * line reads as a warning wherever colour survives — and by its mark wherever it does not.
 *
 * @param palette - colour and symbols.
 * @param text - the headline's words.
 * @returns `  ⚠  text`, styled.
 */
function headline(palette: Palette, text: string): string {
  const { paint, symbol } = palette;
  return paint("emphasis", paint("warn", `  ${symbol("warning")}  ${text}`));
}
