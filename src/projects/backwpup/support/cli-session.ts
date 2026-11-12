import { backwpupArgv, backwpupCli, commandLine } from "./cli";
import { asTransportUser } from "../../../common/wp/site-identity";
import { printableLine } from "../../../common/text";
import type { ExecResult } from "../../../common/wp/exec";
import type { CliResult } from "./cli";
import type { Transport } from "../../../common/config/types";

/**
 * One scenario's `wp backwpup …` conversation: the command it wrote, and what came back.
 *
 * The steps that drive this surface are two halves of one sentence — a `When` that runs a command
 * and a `Then` that judges what it said — so the result has to outlive the step that produced it.
 * A scenario-scoped fixture holding it is the sanctioned way to do that here: nothing is shared
 * between scenarios, and no step has to hand a value to the next one through the feature text.
 */

/** Quoting characters — both quotes and the backslash — which the split below would mangle. */
const QUOTING = /["'\\]/;

/**
 * A value a scenario cannot spell out in advance, written in braces where it belongs — `run {job}`,
 * `backup-delete {oldest backup} --yes`. The plugin allocates a job's id and names each archive and
 * log itself, so a feature can only say *which* one it means. Whatever the braces hold is taken as
 * the name, so a misspelt one — `{job_id}` for `{job}` — is refused by name rather than sent on as
 * text, which the plugin would read as job `0`.
 */
const PLACEHOLDER = /\{([^{}]*)\}/;

/** A brace, which no argument of this surface holds once its placeholders are filled. */
const BRACE = /[{}]/;

/** A value that could not travel as one argument of a command split on whitespace. */
const NOT_ONE_ARGUMENT = /[\s"'\\{}]/;

/**
 * How to find each placeholder's value, by name. Each is asked only when a command uses it, so a
 * placeholder costs nothing — not even a question to the site — in a command that does not.
 */
export type PlaceholderResolvers = ReadonlyMap<string, () => Promise<string>>;

/**
 * Writes the value of every placeholder a command names into it.
 *
 * Each value is looked up once, however often the command repeats it, and must fit in **one**
 * argument: the command is split on whitespace next, so a value holding a space, a quote, a
 * backslash or a brace would silently become something else — two arguments, or a placeholder
 * again.
 *
 * @param text - the command as written in the feature, e.g. `backup-delete {oldest backup} --yes`.
 * @param resolvers - the placeholders this step can fill.
 * @returns the command with every placeholder filled.
 * @throws {@link Error} if the text names a placeholder the step cannot fill (listing those it can),
 * or a value is empty or could not travel as a single argument.
 */
export async function fillPlaceholders(
  text: string,
  resolvers: PlaceholderResolvers,
): Promise<string> {
  const everywhere = new RegExp(PLACEHOLDER.source, "g");
  const names = new Set(
    [...text.matchAll(everywhere)].map((match) => match[1] ?? ""),
  );
  const values = new Map<string, string>();
  for (const name of names) {
    const resolve = resolvers.get(name);
    if (resolve === undefined) {
      const known = [...resolvers.keys()].map((key) => `{${key}}`).join(", ");
      throw new Error(
        `[backwpup/cli] the command "${text}" names {${name}}, which no step fills. The ` +
          `placeholders a command may use are ${known || "(none)"}.`,
      );
    }
    const value = await resolve();
    if (value === "" || NOT_ONE_ARGUMENT.test(value)) {
      throw new Error(
        `[backwpup/cli] {${name}} came out as ${JSON.stringify(value)}, which cannot travel as a ` +
          `single argument of "${text}".`,
      );
    }
    values.set(name, value);
  }
  return text.replace(
    everywhere,
    (placeholder, name: string) => values.get(name) ?? placeholder,
  );
}

/** Names that mean the caller re-typed a prefix {@link backwpupCli} already supplies. */
const IMPLIED_PREFIXES = new Set(["wp", "backwpup"]);

/**
 * WP-CLI's global parameters that decide **where** a command runs, as whom, with what code — or,
 * for `--prompt`, where its arguments come from.
 *
 * WP-CLI honours a global anywhere on the line, after the subcommand too — measured: `wp backwpup
 * version --path=<elsewhere>` looked for another WordPress, and `--skip-plugins` unloaded BackWPup.
 * The runner and the scenario's own text already fix all of that, so one of these in a scenario's
 * command would quietly run something else — and `--path` or `--ssh`, on a host shared with another
 * site, would run it against that site. Only the globals that change nothing but presentation are
 * left out: `--quiet`, `--[no-]color`, and `--debug`, which `wp backwpup version` documents as an
 * option of its own.
 */
const RUN_GLOBALS = new Set([
  "path",
  "url",
  "ssh",
  "http",
  "user",
  "skip-plugins",
  "skip-themes",
  "skip-packages",
  "require",
  "exec",
  "context",
  "prompt",
]);

/** The global an argument sets, if it sets one of {@link RUN_GLOBALS}; its `--no-` form too. */
function runGlobalIn(arg: string): string | undefined {
  const name = /^--(?:no-)?([^=]+)/.exec(arg)?.[1];
  return name !== undefined && RUN_GLOBALS.has(name) ? name : undefined;
}

/**
 * Turns the command a scenario wrote into an argv.
 *
 * The split is plain whitespace, so **no argument may contain a space, a quote or a backslash**.
 * That covers every command in this surface — flags, numeric ids, hex keys and the plugin's own
 * hyphen-and-underscore filenames — and a scenario that ever needs more is better served by a step
 * of its own than by a quoting dialect invented here. All three are refused rather than mangled.
 *
 * Three more refusals keep the text a BackWPup command and nothing else. `wp` and `backwpup` as the
 * first word: {@link backwpupCli} supplies both, and repeating them would run `wp backwpup wp
 * backwpup …`, failing as an unregistered subcommand several lines from the real mistake. Any of
 * {@link RUN_GLOBALS}, which would move the command off the site the scenario is bound to. And any
 * brace — a placeholder nobody filled ({@link fillPlaceholders} runs first) or one left unclosed —
 * which the plugin would read as a literal, as job `0` for `{job}`, and answer about something that
 * does not exist.
 *
 * @param text - the command as written in the feature, without `wp backwpup`.
 * @returns the subcommand and its arguments.
 * @throws {@link Error} if the text is empty, quotes anything, repeats the implied prefix, sets a
 * global that decides where the command runs, or still holds a brace.
 */
export function parseCommandText(text: string): readonly string[] {
  if (QUOTING.test(text)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" quotes or escapes an argument, which this step cannot ` +
        "honour — arguments are split on whitespace. Write a step of its own for such a value.",
    );
  }
  if (BRACE.test(text)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" still holds a brace, which would reach the plugin as ` +
        "text — a placeholder is written {name}, and is filled before the command is parsed.",
    );
  }
  const args = text.split(/\s+/).filter((arg) => arg !== "");
  const [first] = args;
  if (first === undefined) {
    throw new Error("[backwpup/cli] no command was given to run.");
  }
  if (IMPLIED_PREFIXES.has(first)) {
    throw new Error(
      `[backwpup/cli] the command "${text}" starts with "${first}", which is already supplied — ` +
        'write the subcommand alone, e.g. "job --format=count".',
    );
  }
  const global = args.map(runGlobalIn).find((name) => name !== undefined);
  if (global !== undefined) {
    throw new Error(
      `[backwpup/cli] the command "${text}" sets WP-CLI's --${global}, which decides where or how ` +
        "the command runs rather than what it does — the runner already runs it on this " +
        "scenario's site. Leave it out.",
    );
  }
  return args;
}

/**
 * Whether one argument, as written, leads off the site: an absolute path, or one climbing out with
 * `..`. For `--name=value` the value is what is judged.
 */
function leadsOffTheSite(arg: string): boolean {
  const value = arg.startsWith("-") ? arg.slice(arg.indexOf("=") + 1) : arg;
  return value.startsWith("/") || value.split("/").includes("..");
}

/**
 * Refuses a command whose text, as written, names a path off the site — an absolute one, or one that
 * climbs out with `..`.
 *
 * WP-CLI resolves a relative path in the WordPress root, so a command written without either stays
 * on the site it runs against. With one, a slip in a feature — `backup-download … /var/www/other/
 * wp-config.php --yes` — would overwrite a file of another site on the same host. A command that
 * must reach further is handed its path by a placeholder the suite proves on the site, which is why
 * this judges the text **before** its placeholders are filled.
 *
 * @param text - the command as written in the feature.
 * @throws {@link Error} naming the argument that leads off the site.
 */
export function refusePathsOffTheSite(text: string): void {
  const off = text.split(/\s+/).find(leadsOffTheSite);
  if (off !== undefined) {
    throw new Error(
      `[backwpup/cli] the command "${text}" names "${off}", a path that leads off the site — write ` +
        "one relative to the WordPress root, or take it from a placeholder.",
    );
  }
}

/**
 * Settles with `work`, unless `budgetMs` passes first.
 *
 * The command itself cannot be stopped from here — the exec layer has no way to — so it is left to
 * finish on its own; racing it still turns "it never came back" into a failure that says so.
 *
 * @param work - the command, running.
 * @param budgetMs - how long it may take.
 * @param args - the subcommand and its arguments, named as {@link commandLine} names them — a
 * `--key=` value hidden.
 * @throws {@link Error} naming the command, if the budget ran out first.
 */
async function withinBudget<T>(
  work: Promise<T>,
  budgetMs: number,
  args: readonly string[],
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `[backwpup/cli] \`${commandLine(backwpupArgv(args))}\` had not answered after ` +
            `${String(budgetMs / 1000)} s.`,
        ),
      );
    }, budgetMs);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * What `wp core is-installed`, run as the SSH user, says about running a scenario's commands as it.
 */
export type SshUserBoot =
  /** WordPress booted and is installed: the SSH user can run them. */
  | { readonly kind: "boots" }
  /** The SSH user may not read the site's files: a skip, with `reason`. */
  | { readonly kind: "refused"; readonly reason: string }
  /** Anything else (a database down, a fatal, a site not installed): a failure, with `message`. */
  | { readonly kind: "failed"; readonly message: string };

/**
 * How WP-CLI says the SSH user may not read the site (measured on a twin whose files only the web
 * server may read): a PHP or shell "Permission denied" (an unreadable `wp-config.php`, a root it
 * cannot enter), or WP-CLI not recognising a root whose core files it cannot read. The site commands
 * already ran there as the site's identity, so the root itself is right.
 */
const READ_REFUSED =
  /Permission denied|This does not seem to be a WordPress installation/;

/**
 * Classifies `wp core is-installed` run as the SSH user: only a refusal to read the site is a reason
 * to skip; any other non-zero exit is a failure, never hidden as a skip.
 *
 * @param result - the run.
 * @returns the verdict; a reason or message is one printable line (a credential masked) naming the
 * exit and the line that explains it.
 */
export function sshUserBoot(result: ExecResult): SshUserBoot {
  if (result.exitCode === 0) return { kind: "boots" };
  const lines = `${result.stderr}\n${result.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const refusal = lines.find((line) => READ_REFUSED.test(line));
  const said = printableLine(
    refusal ??
      lines.find((line) => line.startsWith("Error:")) ??
      lines[0] ??
      "",
  ).slice(0, 300);
  const exit = `exit ${String(result.exitCode)}${said === "" ? "" : `: ${said}`}`;
  return refusal === undefined
    ? {
        kind: "failed",
        message:
          `[backwpup/cli] \`wp core is-installed\` failed as the SSH user (${exit}), and not for ` +
          "lack of read access, so the scenario cannot tell whether its premise holds.",
      }
    : {
        kind: "refused",
        reason:
          `The SSH user may not read this site (\`wp core is-installed\`: ${exit}), so this ` +
          "scenario's two-user premise cannot be set up on it.",
      };
}

/**
 * The commands one scenario has run against its site, remembering the last of them.
 *
 * Deliberately keeps only the latest result: every assertion in this surface is about the command
 * immediately above it, and a history would invite steps that reach back past the sentence they
 * are part of.
 */
export class CliSession {
  /** The site every command runs against: the scenario's bound site, or its as-the-SSH-user copy. */
  private site: Transport;

  /** The most recent result, or `undefined` until the scenario has run something. */
  private result: CliResult | undefined;

  /** Whether a command was started, after which who runs them may no longer change. */
  private started = false;

  /**
   * @param transport - the scenario's bound site; commands run as its identity state decides.
   */
  constructor(transport: Transport) {
    this.site = transport;
  }

  /**
   * The transport commands run through — what a step asks to judge the site as the command under
   * test sees it (e.g. whether WP-CLI's user may write a file).
   */
  get transport(): Transport {
    return this.site;
  }

  /**
   * Runs every command of this session as the SSH user, with no `--user`
   * ({@link asTransportUser}): for a scenario whose premise is that WP-CLI and the web server are two
   * users, which running as the site's identity (the web server's) would erase. Idempotent before the
   * first command.
   *
   * @throws {@link Error} once a command has been started: a session must not change identity
   * half-way, or two of its commands would act as different users.
   */
  runAsSshUser(): void {
    if (this.started) {
      throw new Error(
        "[backwpup/cli] WP-CLI can only be switched to the SSH user before the scenario's first " +
          "BackWPup command; move that step above it.",
      );
    }
    this.site = asTransportUser(this.site);
  }

  /**
   * Runs one `wp backwpup …` subcommand and remembers what it said.
   *
   * @param args - the subcommand and its arguments, e.g. `["job", "--format=count"]`.
   * @param budgetMs - how long the command may take, for one that blocks on something else — as
   * `status` does on a running job. Omit for a command that simply answers.
   * @returns the outcome, whatever it was — a refusal is a result here, never a throw.
   * @throws {@link Error} if the command could not be run, or was still running when its budget ran
   * out — it is then left to finish on the site. Either way the previous result is already
   * forgotten, so no assertion can judge an earlier command in place of the one that never answered.
   */
  async run(args: readonly string[], budgetMs?: number): Promise<CliResult> {
    this.result = undefined;
    this.started = true;
    const pending = backwpupCli(this.site, args);
    const result =
      budgetMs === undefined
        ? await pending
        : await withinBudget(pending, budgetMs, args);
    this.result = result;
    return result;
  }

  /**
   * What the last command said.
   *
   * @throws {@link Error} if no command has answered — which is a feature written with an assertion
   * ahead of the command it judges, and is worth saying plainly rather than failing as a mismatch
   * against an empty result.
   */
  get last(): CliResult {
    if (this.result === undefined) {
      throw new Error(
        "[backwpup/cli] no BackWPup command has answered in this scenario yet, so there is " +
          "nothing to assert on. Run one before asserting what it reported.",
      );
    }
    return this.result;
  }
}
