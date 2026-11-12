/**
 * What `sudo -n -l` says about one setting the site identity depends on: whether sudo writes the
 * command lines it runs to the system log (`log_allowed`, on by default). Site commands run through
 * `sudo` carry `--key=` values, so a host should set `Defaults:<ssh user> !log_allowed`.
 *
 * Pure: the caller runs `env LC_ALL=C sudo -n -l` (English headers, whatever the host's locale) as the
 * SSH user and hands the result in. Only the `Defaults` blocks are read; the commands sudo lists are
 * never parsed, kept or quoted.
 */

/** What the listing says. */
export type SudoListing =
  /** sudo listed; `logAllowed` is whether it logs the command lines it runs as the identity. */
  | { readonly kind: "listed"; readonly logAllowed: boolean }
  /** sudo refused to list (no rule, or a password asked for): it reports a missing rule as this. */
  | { readonly kind: "refused" }
  /** An answer this parser does not know (another format, a crash): the setting is unknown. */
  | { readonly kind: "unreadable" };

/** The header of the global, host and user `Defaults` that apply (absent when none do). */
const MATCHING_HEADER = /^Matching Defaults entries for .+:$/;

/** The header of `Defaults>runas` and `Defaults!command` entries. */
const RUNAS_HEADER = /^Runas and Command-specific defaults for .+:$/;

/** The header of the rules: present in every successful listing. */
const RULES_HEADER = /^User .+ may run the following commands on .+:$/;

/** One sudo refusal line (`sudo: a password is required`, `Sorry, user … may not run sudo …`). */
const REFUSAL_LINE = /^(?:sudo: .+|Sorry, user .+)$/;

/**
 * The indented lines under the line `header` matches, up to the first blank or unindented line.
 *
 * @param lines - the listing's lines.
 * @param header - the block's header.
 * @returns the block's lines, trimmed; empty when the header is absent.
 */
function block(lines: readonly string[], header: RegExp): string[] {
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!/^\s+\S/.test(line)) break;
    out.push(line.trim());
  }
  return out;
}

/**
 * A `Defaults` value list split into its entries: on commas sudo did not escape (`secure_path`
 * escapes its own as `\:`, a comma inside a value as `\,`).
 *
 * @param text - the entries, comma-separated.
 */
function entries(text: string): string[] {
  return text
    .split(/(?<!\\),/)
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");
}

/**
 * `log_allowed` after `list`'s entries, in the order sudo printed them (a later one wins).
 *
 * A known limit: sudo applies global, then host, then user `Defaults` whatever their order in the
 * file, while the listing gives them in one block, unlabelled. Read in print order, a sudoers that
 * sets `log_allowed` for the user *before* a global `!log_allowed` is reported as not logging though
 * sudo logs (the reverse misreading, a global `log_allowed` after the user's `!log_allowed`, only
 * warns for nothing). Only a file setting both ways is misread; the usual single line
 * (`Defaults:<ssh user> !log_allowed`) is read right.
 *
 * @param current - the value before them.
 * @param list - the entries.
 */
function applyLogAllowed(current: boolean, list: readonly string[]): boolean {
  let value = current;
  for (const entry of list) {
    if (entry === "log_allowed") value = true;
    else if (entry === "!log_allowed") value = false;
  }
  return value;
}

/**
 * The `Defaults>user,…` entries of the runas block, each with its users and settings. sudo 1.9.15
 * prints several on one line with no separator but spaces (measured), so they are split before each
 * `Defaults` word; `Defaults!command` and `Defaults@host` entries are skipped (they apply to other
 * commands or hosts than the identity's shell).
 *
 * @param lines - the runas block's lines.
 */
function runasEntries(
  lines: readonly string[],
): { readonly users: readonly string[]; readonly settings: string[] }[] {
  return lines
    .join(" ")
    .split(/\s+(?=Defaults[>!@:])/)
    .flatMap((item) => {
      const match = /^Defaults>(\S+)\s+(.+)$/.exec(item.trim());
      if (match === null) return [];
      const [, users = "", settings = ""] = match;
      return [{ users: users.split(","), settings: entries(settings) }];
    });
}

/**
 * Reads `sudo -n -l`'s answer.
 *
 * @param result - its exit code and output, run as the SSH user with `LC_ALL=C`.
 * @param runAs - the names the identity goes by (its user name, and `#uid` when sudo is given one):
 * `Defaults>` entries naming one of them (or `ALL`) apply on top of the matching ones. Empty when no
 * identity is known.
 * @returns whether sudo logs the identity's command lines, or why that is unknown.
 * @example
 * ```ts
 * parseSudoListing({ exitCode: 0, stdout: "Matching Defaults entries for u on h:\n    env_reset, !log_allowed\n\nUser u may run the following commands on h:\n    (ALL) NOPASSWD: ALL", stderr: "" }, ["www-data"]);
 * // { kind: "listed", logAllowed: false }
 * ```
 */
export function parseSudoListing(
  result: {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  runAs: readonly string[],
): SudoListing {
  if (result.exitCode !== 0) {
    const said = result.stderr
      .split("\n")
      .map((line) => line.replace(/\r$/, ""))
      .filter((line) => line.trim() !== "");
    return result.exitCode === 1 &&
      said.length > 0 &&
      said.every((line) => REFUSAL_LINE.test(line))
      ? { kind: "refused" }
      : { kind: "unreadable" };
  }
  const lines = result.stdout
    .split("\n")
    .map((line) => line.replace(/\r$/, ""));
  if (!lines.some((line) => RULES_HEADER.test(line))) {
    return { kind: "unreadable" };
  }
  let logAllowed = applyLogAllowed(
    true,
    entries(block(lines, MATCHING_HEADER).join(",")),
  );
  for (const { users, settings } of runasEntries(block(lines, RUNAS_HEADER))) {
    if (users.some((user) => user === "ALL" || runAs.includes(user))) {
      logAllowed = applyLogAllowed(logAllowed, settings);
    }
  }
  return { kind: "listed", logAllowed };
}
