import { wpCli } from "../../../common/wp/exec";
import type { ExecResult } from "../../../common/wp/exec";
import type { Transport } from "../../../common/config/types";

/**
 * Running `wp backwpup …` when the **command itself is what is under test**.
 *
 * This is the deliberate opposite of `support/backups.ts`, which runs some of the same commands as
 * *instrumentation* and throws on a non-zero exit — there, a failing command means the scenario's
 * arrangement broke. Here a non-zero exit is an observation to assert: half the surface's contract
 * is how it refuses (a missing archive, an unknown field, a second job while one is running). One
 * module cannot hold both stances without every caller passing a "do I throw?" flag, so the two
 * live side by side and this one never throws for an outcome. It still throws when the command
 * could not be run at all — that distinction is `common/wp/exec.ts`'s and is inherited unchanged.
 *
 * Assertions read {@link CliResult.notices} rather than hunting substrings in raw output: WP-CLI
 * prefixes its own status lines with `Success:` / `Warning:` / `Error:`, and all 17 commands speak
 * it, so matching it structurally keeps a reworded sentence a visible mismatch instead of a
 * silently passing `.includes()`.
 */

/** The severity word WP-CLI prefixes a status line with. */
export type CliLevel = "success" | "warning" | "error";

/** One status line WP-CLI tagged with its own severity, with that prefix removed. */
export interface CliNotice {
  readonly level: CliLevel;
  readonly message: string;
}

/** What one `wp backwpup …` invocation reported. */
export interface CliResult extends ExecResult {
  /** The full argv as run, so a failure message names the command rather than describing it. */
  readonly argv: readonly string[];
  /** WP-CLI's own status lines — see {@link parseCliNotices} for what ordering does and does not mean. */
  readonly notices: readonly CliNotice[];
}

/**
 * WP-CLI's status prefixes, mapped to the level they mean.
 *
 * Exhaustive by construction: the regex below is built to match exactly these keys, so a lookup
 * cannot miss — but it is still checked, which keeps the parser free of a type assertion.
 */
const LEVELS: Readonly<Record<string, CliLevel>> = {
  Success: "success",
  Warning: "warning",
  Error: "error",
};

/** A status line: one of WP-CLI's prefixes at the very start of a line, then its message. */
const NOTICE = new RegExp(`^(${Object.keys(LEVELS).join("|")}): ?(.*)$`);

/**
 * A WP-CLI debug line — printed only under `--debug`, as `Debug (bootstrap): …` or `Debug: …` —
 * which ends the notice above it without being one.
 */
const DEBUG_LINE = /^Debug(?: \([^)]*\))?:/;

/**
 * ANSI colour codes, which WP-CLI emits only when it believes it is writing to a terminal.
 *
 * Every transport this suite uses pipes its output, so today nothing is coloured — verified live
 * over `ssh`. Stripping anyway costs one pass and means a transport that ever does allocate a TTY
 * (a `docker exec -t`, a future runner) degrades to plain text rather than to every notice
 * assertion failing on invisible bytes.
 */
// eslint-disable-next-line no-control-regex -- matching the escape character is the point.
const ANSI = /\u001B\[[0-9;]*m/g;

/** How much command output a failure message carries before it stops being readable. */
const OUTPUT_EXCERPT = 1000;

/** A `--key=` argument: `backup-encrypt`'s and `backup-decrypt`'s key, or the file holding one. */
const KEY_ARGUMENT = /^--key=(.+)$/;

/** What a key reads as in a description. */
const HIDDEN_KEY = "<hidden>";

/**
 * Pulls WP-CLI's status lines out of one stream.
 *
 * @param text - the stream's contents.
 * @param continued - whether a line that is not a status line continues the notice above it, which
 * is how stderr is read — see {@link parseCliNotices}. A blank or debug line ends a notice either way.
 */
function noticesIn(text: string, continued: boolean): CliNotice[] {
  const found: { readonly level: CliLevel; readonly lines: string[] }[] = [];
  let open = false;
  for (const line of text.replace(ANSI, "").split(/\r?\n/)) {
    const match = NOTICE.exec(line);
    const level = match === null ? undefined : LEVELS[match[1] ?? ""];
    if (level !== undefined) {
      found.push({ level, lines: [(match?.[2] ?? "").trim()] });
      open = continued;
    } else if (line.trim() === "" || DEBUG_LINE.test(line)) {
      open = false;
    } else if (open) {
      found.at(-1)?.lines.push(line.trim());
    }
  }
  return found.map(({ level, lines }) => ({
    level,
    message: lines.join("\n"),
  }));
}

/**
 * Every status line WP-CLI emitted, stdout's before stderr's.
 *
 * That ordering is **not** the order they were printed in and must not be read as one: the two
 * streams arrive down separate pipes, which carry no shared sequence. What survives is the order
 * *within* each stream, which is what a caller asserting "it warned twice" actually needs. In
 * practice WP-CLI puts `Success:` on stdout and `Warning:`/`Error:` on stderr, so a level is
 * usually enough to find a line without caring where it came from.
 *
 * **A notice can span lines, so the two streams are read differently.** WP-CLI writes each notice
 * whole, and its own refusals do span lines — `Parameter errors:`, then one line per parameter it
 * rejected, sometimes a `Did you mean …?` after that — so on stderr, which carries little else, a
 * line that is not a status line continues the one above it, joined with a newline. Stdout is read
 * line by line: the command's own output shares it, and a continuation there cannot be told apart
 * from whatever the command printed next. BackWPup's own notices are all single-line, so this only
 * ever changes what WP-CLI's refusals read as.
 *
 * @param stdout - the command's standard output.
 * @param stderr - the command's standard error.
 * @returns the notices found, in the order described above; empty when the command said nothing
 * WP-CLI tagged, which is normal for the list commands.
 */
export function parseCliNotices(
  stdout: string,
  stderr: string,
): readonly CliNotice[] {
  return [...noticesIn(stdout, false), ...noticesIn(stderr, true)];
}

/**
 * The WP-CLI argv for a `wp backwpup …` subcommand — the namespace {@link backwpupCli} supplies, so
 * a message can name a command before it has answered.
 */
export function backwpupArgv(args: readonly string[]): readonly string[] {
  return ["backwpup", ...args];
}

/**
 * Runs a `wp backwpup …` subcommand and reports everything it said.
 *
 * The `backwpup` namespace is supplied here rather than by the caller: every command in this
 * surface lives under it, and fixing it means an unrelated WP-CLI command cannot be run through
 * the path reserved for the plugin under test.
 *
 * @param transport - the site to run on.
 * @param args - the subcommand and its arguments, e.g. `["job", "--format=count"]`.
 * @param globals - WP-CLI global arguments the suite adds before them (a restore's fence), kept out
 * of the result's `argv`, which messages name the command by.
 * @returns the outcome, whatever it was — a non-zero exit is returned, never thrown.
 * @throws {@link Error} only if the command could not be run at all (the transport failed), which
 * `common/wp/exec.ts` distinguishes from a command that ran and refused.
 */
export async function backwpupCli(
  transport: Transport,
  args: readonly string[],
  globals: readonly string[] = [],
): Promise<CliResult> {
  const argv = backwpupArgv(args);
  const result = await wpCli(transport, [...globals, ...argv]);
  return {
    ...result,
    argv,
    notices: parseCliNotices(result.stdout, result.stderr),
  };
}

/** The messages of every notice at one level, in {@link parseCliNotices}'s order. */
export function noticesAt(
  result: CliResult,
  level: CliLevel,
): readonly string[] {
  return result.notices
    .filter((notice) => notice.level === level)
    .map((notice) => notice.message);
}

/**
 * What a command printed on stdout, one entry per non-blank line, each trimmed — how `--field=<name>`
 * answers, and how `log-show` prints a log.
 */
export function outputLines(result: CliResult): readonly string[] {
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/**
 * How a message names a command: `wp …`, with a `--key=` value read as `--key=<hidden>`.
 *
 * The one place that mask lives, so every message naming a command of this surface — a failure, a
 * time limit, a parse error — hides a key the same way. A failure message is one of the few places a
 * scenario's words are kept.
 *
 * @param argv - the WP-CLI argv, without `wp`.
 */
export function commandLine(argv: readonly string[]): string {
  const shown = argv.map((arg) =>
    KEY_ARGUMENT.test(arg) ? `--key=${HIDDEN_KEY}` : arg,
  );
  return `wp ${shown.join(" ")}`;
}

/**
 * A command's output with every `--key=` value its argv carries hidden, wherever it appears — before
 * any excerpt is cut, so no part of a key is left at the cut.
 */
function hideKeys(output: string, argv: readonly string[]): string {
  const keys = argv.flatMap((arg) => {
    const key = KEY_ARGUMENT.exec(arg)?.[1];
    return key === undefined ? [] : [key];
  });
  return keys.reduce((text, key) => text.split(key).join(HIDDEN_KEY), output);
}

/** At most {@link OUTPUT_EXCERPT} characters of `text`, marked when cut. */
function excerptOf(text: string): string {
  return text.length > OUTPUT_EXCERPT
    ? `${text.slice(0, OUTPUT_EXCERPT)}…`
    : text;
}

/**
 * One line naming the command, its exit code and what it printed — for assertion messages.
 *
 * **A `--key=` value never appears in it** — not in the command ({@link commandLine}), and not where
 * the output repeats it. Output is otherwise quoted as it came — so this is not for `job-export
 * --passwords`, which prints stored credentials, and which nothing here runs.
 */
export function describeCli(result: CliResult): string {
  const output = hideKeys(
    [result.stdout, result.stderr]
      .map((stream) => stream.trim())
      .filter((stream) => stream !== "")
      .join("\n"),
    result.argv,
  );
  const excerpt = excerptOf(output);
  return (
    `\`${commandLine(result.argv)}\` exited ${String(result.exitCode)}` +
    (excerpt === "" ? " with no output" : `:\n${excerpt}`)
  );
}

/**
 * Reads WP-CLI's `--format=json` output as a list.
 *
 * An **empty string** reads as an empty list: some commands print nothing rather than `[]` for an
 * empty result, and a caller cannot tell the two apart from the outside. Anything else that is not
 * a JSON array throws with the output attached, because quietly returning `[]` would turn a broken
 * command into a passing "nothing there yet" assertion — the precise false negative these readers
 * exist to prevent. A scenario that needs the literal reply (that `job` answers `[]` and not
 * silence) asserts on `stdout` instead, where the difference survives.
 *
 * @param stdout - the command's standard output.
 * @param argv - the WP-CLI argv, without `wp`, for the failure message — named as {@link commandLine}
 * names it, so a key is hidden there and in the output quoted.
 * @throws {@link Error} if the output is neither empty nor a JSON array.
 */
export function parseJsonList(
  stdout: string,
  argv: readonly string[],
): readonly unknown[] {
  const trimmed = stdout.trim();
  if (trimmed === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `[backwpup/cli] \`${commandLine(argv)}\` did not return JSON. Output was: ` +
        excerptOf(hideKeys(trimmed, argv)),
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      `[backwpup/cli] \`${commandLine(argv)}\` returned ${typeof parsed}, expected a JSON array.`,
    );
  }
  return parsed;
}

/**
 * {@link parseJsonList} for a result that carries its own argv.
 *
 * Refuses a command that failed, before parsing: WP-CLI writes its `Error:` to stderr and leaves
 * stdout empty, which would otherwise read as an empty list and pass.
 *
 * @throws {@link Error} if the command exited non-zero, or if its output is not a JSON array.
 */
export function readJsonList(result: CliResult): readonly unknown[] {
  if (result.exitCode !== 0) {
    throw new Error(
      `[backwpup/cli] cannot read JSON from a command that failed — ${describeCli(result)}`,
    );
  }
  return parseJsonList(result.stdout, result.argv);
}
