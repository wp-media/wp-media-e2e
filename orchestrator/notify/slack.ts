import type {
  FinishedScenario,
  RunFinishedEvent,
} from "../events/run-finished";
import { webhookSecrets } from "../config/secrets";
import { downloadCommand } from "../runs/bundle";
import type { RunStatus } from "../runs/outcome";
import { shellWord } from "../text";
import { DEFAULT_POST_TIMEOUT_MS, postJson, type Delivery } from "./post";

/**
 * Slack: one message per run, whatever its status, to an incoming webhook — the plugin and commit
 * tested, the sites with their real versions, the counts, the scenarios that failed or were flaky
 * with their first error, and where the report is. A run that could not test says why instead.
 *
 * The event's text is already masked and one line per field (`run-finished.ts`); this escapes it as
 * Slack requires (`&`, `<`, `>` — else `<!channel>` in a scenario's name would ping a channel), breaks
 * every run of three backticks (two such names would make every line between them one code block),
 * and bounds every piece and every list, so a message stays far under Slack's 40,000-character
 * truncation. Slack's own formatting (`*bold*`, `_italic_`, a bare link) is left to it: a run can
 * style its text, not ping, link under false text or reach past its line. Links are not unfurled,
 * and the paths to copy are code, which Slack does not format.
 */

/** What a message adds beside the event: the config's `instance` and `reports.sshHost`. */
export interface SlackMessageOptions {
  /** Prefixes the headline, `*[AutoE2E nginx]*` — which instance is speaking. */
  readonly instance?: string;
  /** Turns report and log paths into `scp` commands from this host; a bundle into its download. */
  readonly sshHost?: string;
}

/** The most scenarios a message lists, failed first; then "…and N more". */
export const MAX_LISTED_SCENARIOS = 20;

/** The longest scenario title listed — feature › path › name — in characters, escapes included. */
export const MAX_TITLE = 300;

/** The longest error excerpt beside a listed scenario — its first line — escapes included. */
export const MAX_ERROR_EXCERPT = 200;

/** The longest reason, URL, path or fact shown, escapes included. */
export const MAX_SHOWN = 600;

/** The most sites a message lists, in pool order; then "…and N more sites". */
export const MAX_LISTED_SITES = 10;

/** What a scenario with neither a feature's name nor its own is listed as. */
const UNNAMED = "(unnamed)";

/** Each status's headline. */
const HEADLINES: Readonly<Record<RunStatus, string>> = {
  passed: "✅ PASSED",
  flaky: "⚠️ FLAKY",
  failed: "❌ FAILED",
  error: "🚫 COULD NOT TEST",
  stopped: "■ STOPPED",
  killed: "■ KILLED",
};

/**
 * What stands for each backtick of a run of three or more: U+02CB `ˋ`, which reads as one but is not
 * markup — Slack has no escape for a backtick, and an invisible character between them would be
 * a guess at its parser.
 */
export const FENCE_BREAK = "\u02cb";

/**
 * Text with every run of three backticks or more written in {@link FENCE_BREAK}s: Slack opens a code
 * block at three backticks and closes it at the next three, lines apart, so the text between two
 * such names would lose its formatting and read as one block. One or two backticks are kept.
 *
 * @param text - the text.
 * @returns the text, its length in UTF-16 units unchanged.
 */
function breakFences(text: string): string {
  return text.replace(/`{3,}/g, (run) => FENCE_BREAK.repeat(run.length));
}

/**
 * One character as Slack shows it literally: `&`, `<` and `>` escaped, as its message format
 * requires.
 *
 * @param char - one code point.
 * @returns it, escaped.
 */
function escapeChar(char: string): string {
  return char === "&"
    ? "&amp;"
    : char === "<"
      ? "&lt;"
      : char === ">"
        ? "&gt;"
        : char;
}

/**
 * Text as Slack shows it literally: `&`, `<` and `>` escaped, as its message format requires, a run of
 * three backticks or more broken ({@link breakFences}), and a lone surrogate — which no JSON reader
 * need accept — made U+FFFD.
 *
 * @param text - the text.
 * @returns the escaped text.
 */
export function escapeSlack(text: string): string {
  return breakFences(text.toWellFormed()).replace(/[&<>]/g, escapeChar);
}

/**
 * {@link escapeSlack}'s text, at most `max` characters once escaped: cut by code point, an ellipsis
 * closing a cut one, never inside an escape — so the bound holds whatever the text holds.
 *
 * @param text - the text.
 * @param max - the most characters (UTF-16 units) kept, the ellipsis included.
 * @returns the escaped, bounded text.
 * @throws {@link RangeError} when `max` is not a whole number from 1.
 */
export function escapeCut(text: string, max: number): string {
  if (!Number.isSafeInteger(max) || max < 1)
    throw new RangeError(
      `An escaped cut keeps a whole number of characters from 1, got ${String(max)}.`,
    );
  const whole = escapeSlack(text);
  if (whole.length <= max) return whole;
  let kept = "";
  // Fences broken before the cut, which reads one code point at a time and could not see a run.
  for (const char of breakFences(text.toWellFormed())) {
    const escaped = escapeChar(char);
    if (kept.length + escaped.length > max - 1) break;
    kept += escaped;
  }
  return `${kept}…`;
}

/**
 * A duration as a person reads it: `54m 10s`, `1h 2m 3s`, `45s`.
 *
 * @param ms - milliseconds; a negative or non-finite one reads as 0.
 * @returns the duration.
 */
export function formatDuration(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms / 1000) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0)
    return `${String(hours)}h ${String(minutes)}m ${String(seconds)}s`;
  if (minutes > 0) return `${String(minutes)}m ${String(seconds)}s`;
  return `${String(seconds)}s`;
}

/**
 * Where to find a file or folder, escaped and bounded: an `scp` command from `sshHost` when there is
 * one, else the path — as code, which Slack shows as written (an `_` in it is not italics), unless it
 * holds a backtick, which would end the code early. The path is quoted for the shell the command is
 * pasted in ({@link shellWord}); the far end still reads it: in scp's default SFTP mode a `*`, `?` or
 * `[` is a pattern, and its legacy mode (`-O`) hands it to a remote shell unquoted. The paths shown
 * here are the checkout's and the state directory's, which hold none of those unless their own
 * location does.
 *
 * @param path - the absolute path on this machine.
 * @param folder - whether it is a folder (`scp -r`).
 * @param sshHost - the host `scp` reaches this machine by.
 * @returns the text, escaped for Slack.
 */
function whereIs(path: string, folder: boolean, sshHost?: string): string {
  const text =
    sshHost === undefined
      ? path
      : `scp ${folder ? "-r " : ""}${sshHost}:${shellWord(path)} .`;
  return asCode(escapeCut(text, MAX_SHOWN));
}

/**
 * Escaped text as code, which Slack shows as written — unless it holds a backtick, which would end
 * the code early: then as it is.
 *
 * @param shown - text already escaped for Slack.
 * @returns it, in backticks when it can be.
 */
function asCode(shown: string): string {
  return shown.includes("`") ? shown : `\`${shown}\``;
}

/**
 * Whether a command is shown whole in Slack: its escaped form — `&&` is `&amp;&amp;` there — within
 * {@link MAX_SHOWN}. The one rule for Slack and the terminal, so both show the command or neither does.
 *
 * @param command - the command, raw.
 * @returns `true` when Slack shows it.
 */
export function fitsSlack(command: string): boolean {
  return escapeSlack(command).length <= MAX_SHOWN;
}

/**
 * The `Report:` line's text. A run with a bundle: with `sshHost`, the one command that downloads it
 * and leaves `./<name>/` (`bundleCommand`), never cut — a command longer than {@link MAX_SHOWN} once
 * escaped gives the bundle's path instead; without, the bundle's path. A run without one — the mode
 * is `none`, or the bundle failed, ran out of time or was stopped — gets the raw report folder, as
 * {@link whereIs} gives it. Slack's escaping writes `&&` as `&amp;&amp;`, which it shows as `&&`.
 *
 * @param dir - the run's report folder.
 * @param bundle - the run's bundle, or `null`.
 * @param sshHost - the `scp` host.
 * @returns the text, escaped for Slack.
 */
function reportWhere(
  dir: string,
  bundle: RunFinishedEvent["report"]["bundle"],
  sshHost?: string,
): string {
  if (bundle === null) return whereIs(dir, true, sshHost);
  if (sshHost !== undefined) {
    const command = downloadCommand(bundle, sshHost);
    if (fitsSlack(command)) return asCode(escapeSlack(command));
  }
  return whereIs(bundle.path, false);
}

/**
 * The run's message.
 *
 * @param event - the run's `run.finished`.
 * @param options - the instance's name and the `scp` host.
 * @returns the message's text, escaped for Slack.
 *
 * @example
 * ```ts
 * slackMessage(event, { instance: "AutoE2E nginx", sshHost: "auto-e2e" });
 * // *[AutoE2E nginx]* ❌ FAILED — BackWPup Pro · pro@nginx
 * // 52 scenarios: 49 passed · 1 flaky · 2 failed, in 54m 10s
 * // …
 * ```
 */
export function slackMessage(
  event: RunFinishedEvent,
  options: SlackMessageOptions = {},
): string {
  const tested = event.status !== "error";
  return [
    headline(event, options.instance),
    ...(tested ? [countsLine(event)] : []),
    ...(event.reason === null
      ? []
      : [`Reason: ${escapeCut(event.reason, MAX_SHOWN)}`]),
    pluginLine(event),
    ...siteLines(event.sites),
    ...(tested ? scenarioLists(event.scenarios) : []),
    ...(tested ? [] : [`Took: ${formatDuration(event.durationMs)}`]),
    // A run refused before it had a folder wrote neither: no path to point at.
    ...(tested || event.report.log === null
      ? []
      : [`Log: ${whereIs(event.report.log, false, options.sshHost)}`]),
    ...(event.report.dir === null
      ? []
      : [
          `Report: ${reportWhere(event.report.dir, event.report.bundle, options.sshHost)}`,
        ]),
  ].join("\n");
}

/**
 * `*[instance]* ❌ FAILED — BackWPup Pro · pro@nginx`: the plugin's name when the run read it, else
 * the product's.
 *
 * @param event - the run.
 * @param instance - the config's `instance`, shown in brackets first; none when absent.
 * @returns the message's first line, escaped for Slack.
 */
function headline(event: RunFinishedEvent, instance?: string): string {
  const prefix =
    instance === undefined ? "" : `*[${escapeCut(instance, MAX_SHOWN)}]* `;
  const what = event.plugin.name ?? event.unit.product;
  return `${prefix}${HEADLINES[event.status]} — ${escapeCut(what, MAX_SHOWN)} · ${escapeCut(event.unit.cell, MAX_SHOWN)}`;
}

/**
 * `52 scenarios: 49 passed · 1 flaky · 2 failed, in 54m 10s` — a count only when not 0.
 *
 * @param event - the run.
 * @returns the line; nothing in it needs escaping.
 */
function countsLine(event: RunFinishedEvent): string {
  const { counts } = event;
  const parts = (
    [
      [counts.passed, "passed"],
      [counts.flaky, "flaky"],
      [counts.failed, "failed"],
      [counts.skipped, "skipped"],
      [counts.didNotRun, "did not run"],
    ] as const
  )
    .filter(([count]) => count > 0)
    .map(([count, label]) => `${String(count)} ${label}`);
  const total = `${String(counts.total)} scenario${counts.total === 1 ? "" : "s"}`;
  return `${parts.length === 0 ? total : `${total}: ${parts.join(" · ")}`}, in ${formatDuration(event.durationMs)}`;
}

/**
 * `Plugin: BackWPup Pro 9.99.99 · develop @ f1ebfd0` — what the run built; the ref the task asked for
 * when the run never said, and nothing it does not know.
 *
 * @param event - the run.
 * @returns the line, escaped for Slack.
 */
function pluginLine(event: RunFinishedEvent): string {
  const { plugin } = event;
  const name = [plugin.name ?? event.unit.product, plugin.version]
    .filter((part) => part !== null)
    .join(" ");
  const ref = plugin.ref ?? plugin.requestedRef;
  const commit =
    plugin.commit === null ? "" : ` @ ${plugin.commit.slice(0, 7)}`;
  const built =
    ref !== null
      ? `${ref}${commit}`
      : plugin.commit === null
        ? ""
        : `commit ${plugin.commit.slice(0, 7)}`;
  return `Plugin: ${escapeCut(built === "" ? name : `${name} · ${built}`, MAX_SHOWN)}`;
}

/**
 * The pool's first {@link MAX_LISTED_SITES} sites, a line each, then how many more.
 *
 * @param sites - the pool, in its order.
 * @returns the lines; none when the event lists no site.
 */
function siteLines(sites: RunFinishedEvent["sites"]): string[] {
  const more = sites.length - MAX_LISTED_SITES;
  return [
    ...sites.slice(0, MAX_LISTED_SITES).map(siteLine),
    ...(more > 0 ? [`…and ${String(more)} more sites`] : []),
  ];
}

/**
 * `Site: https://… · WordPress 7.1.2 · PHP 8.5.10` — a version only when the run read it.
 *
 * @param site - one site of the pool.
 * @returns the line, escaped for Slack.
 */
function siteLine(site: RunFinishedEvent["sites"][number]): string {
  const parts = [
    site.baseURL,
    ...(site.wordpress === null ? [] : [`WordPress ${site.wordpress}`]),
    ...(site.php === null ? [] : [`PHP ${site.php}`]),
  ];
  return `Site: ${escapeCut(parts.join(" · "), MAX_SHOWN)}`;
}

/**
 * The failed scenarios, then the flaky ones, {@link MAX_LISTED_SCENARIOS} at most between them; a
 * list cut short ends with "…and N more".
 *
 * @param scenarios - the run's scenarios.
 * @returns the lines; none when nothing failed or was flaky.
 */
function scenarioLists(scenarios: readonly FinishedScenario[]): string[] {
  const lines: string[] = [];
  let room = MAX_LISTED_SCENARIOS;
  for (const [status, label] of [
    ["failed", "Failed:"],
    ["flaky", "Flaky:"],
  ] as const) {
    const listed = scenarios.filter((scenario) => scenario.status === status);
    if (listed.length === 0) continue;
    const shown = listed.slice(0, room);
    room -= shown.length;
    lines.push(label, ...shown.map(scenarioLine));
    if (listed.length > shown.length)
      lines.push(`…and ${String(listed.length - shown.length)} more`);
  }
  return lines;
}

/**
 * `• Backups › A backup runs on demand — Expected "Done", received "Error"`: the scenario's titles,
 * then its error's first non-blank line, each cut.
 *
 * @param scenario - a failed or flaky scenario.
 * @returns the line, escaped for Slack.
 */
function scenarioLine(scenario: FinishedScenario): string {
  const title =
    [scenario.feature, ...scenario.path, scenario.name]
      .filter((part) => part !== "")
      .join(" › ") || UNNAMED;
  const firstLine = scenario.error
    ?.split("\n")
    .find((line) => line.trim() !== "")
    ?.trim();
  return `• ${escapeCut(title, MAX_TITLE)}${firstLine === undefined ? "" : ` — ${escapeCut(firstLine, MAX_ERROR_EXCERPT)}`}`;
}

/** Where and how a message is sent. */
export interface SlackSendOptions {
  /** The incoming webhook — a credential: never logged. */
  readonly webhookUrl: string;
  /** The bus's signal, aborting at its time limit. */
  readonly signal?: AbortSignal;
  /** Secret values to mask in what Slack answers. */
  readonly secrets?: readonly string[];
  /** The time limit; {@link DEFAULT_POST_TIMEOUT_MS} by default. */
  readonly timeoutMs?: number;
  /** A seam for tests. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Sends a message. Success is Slack's `200` with the body `ok`; anything else — `invalid_payload`,
 * `no_service`, `channel_is_archived` — is a failed {@link Delivery} carrying Slack's answer. No retry.
 *
 * @param text - the message, as {@link slackMessage} makes it.
 * @param options - the webhook, the signal, the secrets to mask.
 * @returns how it went; never rejects.
 */
export function sendSlack(
  text: string,
  options: SlackSendOptions,
): Promise<Delivery> {
  return postJson(
    options.webhookUrl,
    // Links in a run's text are not previewed in the channel.
    { text, unfurl_links: false, unfurl_media: false },
    {
      timeoutMs: options.timeoutMs ?? DEFAULT_POST_TIMEOUT_MS,
      accept: (status, body) => status === 200 && body.trim() === "ok",
      signal: options.signal,
      // The webhook is the credential: masked should Slack quote it, or any part of it.
      secrets: [
        ...webhookSecrets(options.webhookUrl),
        ...(options.secrets ?? []),
      ],
      fetch: options.fetch,
    },
  );
}
