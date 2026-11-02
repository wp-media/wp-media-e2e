// First, so it is evaluated before any other module of the graph: it reads the parent's PID at boot.
import "./parent";

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { Command, CommanderError, InvalidArgumentError } from "commander";

import { dryRunReport } from "./dry-run";
import { SHUTDOWN_SIGNALS, type ShutdownSignal } from "./runs/shutdown";
import { CHECKOUT, prepareStart, start, type StartOptions } from "./start";
import type { ExitCode } from "./start-lines";
import { unitOf, type CellUnit } from "./state/cell-lock";
import { inspectState } from "./state/inspect";
import {
  drainTerminal,
  MAX_WAIT_MS,
  type DrainableTerminal,
} from "../src/common/terminal/stream";
import { safeBlock, textOf } from "./text";

/**
 * The command line, parsed by commander: `orchestrator start [--config <file>] [--task <id…>]
 * [--once] [--dry-run]`, `--help` and `--version`. `orchestrator/cli.ts` only hands it the arguments
 * and exits with what it returns; everything else is here, injectable, so a spec runs it in its own
 * process.
 *
 * `start` returns its exit code having emptied the terminal itself, so it is returned untouched; from
 * just before it runs until the process exits, the shutdown signals have a handler that does nothing
 * of its own, so a signal after `start` removed its own handlers cannot kill the process by Node's
 * default action before `process.exit`. Every other path — help, the version, a usage error, the dry
 * run — writes through Node's blocking default (standard output is made non-blocking only by `start`)
 * and waits, without a bound, for both outputs to be taken before returning, so `process.exit` drops
 * nothing a slow pipe still holds.
 *
 * Under npm, two things are npm's, not the command's. Without `--`, npm takes an option as its own
 * setting and runs the script **without** it — `--dry-run` on npm 11 and 12, `--once`, `--task=<id>`
 * and `--config=<file>` on npm 11 — so a dry run or a single task would become a real start of every
 * task; the command refuses when npm says it took one ({@link npmTookOption}). And npm runs a script in
 * the package's folder, so a relative `--config` is taken from where npm was run (`INIT_CWD`).
 *
 * A closed standard output or error (`… | head`) is no crash: the failure is dropped, the exit code
 * unchanged.
 */

/** The longest error printed, in code points: as `start` cuts its own refusals. */
const MAX_ERROR_LENGTH = 8_000;

/** The command's name, as its help shows it. */
const NAME = "orchestrator";

/** What the help ends with: how it is run, and what its exit code says. */
const START_HELP_AFTER = `
Run from the checkout as: npm run orchestrator -- start [options]

Exit codes:
  0    --once: every run passed or was flaky; --dry-run: the report is printed,
       warnings or not
  1    --once: a run did not pass; without --once: the loops ended unasked (a
       loop that broke, such as a run whose processes could not be watched);
       the start was refused (the config, --task, the lock, a run still
       running, a site held elsewhere); the dry run was refused (the config,
       --task); a usage error
  130  stopped: Ctrl-C, SIGTERM or SIGHUP to the orchestrator or its process
       group; SIGINT or SIGTERM to npm's PID; or its parent (npm) ending

Under npm, everything after "--" is the orchestrator's: without it, npm takes
--dry-run for itself (refused). A relative --config is from the directory npm
was run in. npm 11 (Node 24's own) also takes --once, --task=<id> and
--config=<file> before "--" (refused too).

Examples:
  npm run orchestrator -- start --dry-run
  npm run orchestrator -- start --task bpng --once
  npm run orchestrator -- start`;

/**
 * The options npm takes as its own settings when they come before `--`, by the variable npm then sets
 * (`npm_config_<name>`, `-` as `_`): npm 12 takes only `--dry-run`, npm 11 all four.
 */
export const NPM_TAKEN_OPTIONS = [
  { variable: "npm_config_dry_run", option: "--dry-run" },
  { variable: "npm_config_once", option: "--once" },
  { variable: "npm_config_task", option: "--task" },
  { variable: "npm_config_config", option: "--config" },
] as const;

/**
 * An option of the command that npm took for itself: its variable is set — to anything but empty or
 * `false` — and the arguments the script got lack the option. A variable set while the option is there
 * (an `.npmrc` with `dry-run=true`, and `-- start --dry-run`) takes nothing away, so it is no refusal.
 *
 * @param argv - the arguments after the script.
 * @param env - the environment.
 * @returns the first option taken, with its variable; `undefined` when none was.
 */
export function npmTookOption(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): (typeof NPM_TAKEN_OPTIONS)[number] | undefined {
  return NPM_TAKEN_OPTIONS.find(({ variable, option }) => {
    const value = env[variable];
    if (value === undefined || value === "" || value === "false") return false;
    return !argv.some((arg) => arg === option || arg.startsWith(`${option}=`));
  });
}

/** An output the command writes to: `process.stdout` or `process.stderr`, or a spec's stand-in. */
export interface Output extends DrainableTerminal {
  /**
   * Writes text.
   *
   * @param text - what to write.
   * @returns whatever the stream returns; not read.
   */
  write(text: string): unknown;
  /**
   * Listens for the stream's failures: a closed pipe's `EPIPE`.
   *
   * @param event - always `error`.
   * @param listener - called with the error.
   * @returns anything; not read.
   */
  on?(event: "error", listener: (error: Error) => void): unknown;
}

/** The options of `start` as commander parses them; every one absent unless given. */
export interface ParsedStartOptions {
  /** `--config <file>`: a string. */
  readonly config?: unknown;
  /** `--task <id...>`: an array of strings, every occurrence's ids in order. */
  readonly task?: unknown;
  /** `--once`: `true`. */
  readonly once?: unknown;
  /** `--dry-run`: `true`. */
  readonly dryRun?: unknown;
}

/** Where the command installs the handlers that outlive `start`: `process`, or a spec's stand-in. */
export interface SignalTarget {
  /**
   * Installs a signal's handler.
   *
   * @param signal - the signal.
   * @param listener - its handler.
   * @returns anything; not read.
   */
  on(signal: ShutdownSignal, listener: () => void): unknown;
}

/** The command's seams; production uses none. */
export interface CommandDeps {
  /** The orchestrator itself: `start` from `./start`. */
  readonly start?: (options: StartOptions) => Promise<ExitCode>;
  /** The dry run's preparation: `prepareStart` from `./start`. */
  readonly prepareStart?: typeof prepareStart;
  /** The state directory's and the selected cells' read-only check: `inspectState`. */
  readonly inspectState?: (
    stateDir: string,
    options: { readonly units: readonly CellUnit[] },
  ) => Promise<string[]>;
  /** The dry run's report: `dryRunReport`. */
  readonly report?: typeof dryRunReport;
  /** The checkout the dry run shows paths from; {@link CHECKOUT} by default. */
  readonly checkout?: string;
  /** What `--version` prints; the checkout's `package.json` version by default. */
  readonly version?: string;
  /** `process.stdout` by default. */
  readonly stdout?: Output;
  /** `process.stderr` by default. */
  readonly stderr?: Output;
  /** How long the outputs may take to empty before returning, but for `start`; unbounded by default. */
  readonly exitWaitMs?: number;
  /** The environment npm's variables are read from; `process.env` by default. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The working directory a relative `--config` is from outside npm; `process.cwd()` by default. */
  readonly cwd?: string;
  /** Where the handlers that outlive `start` go; `process` by default. */
  readonly signals?: SignalTarget;
}

/**
 * The folder a relative `--config` is resolved from: where npm was run (`INIT_CWD`) under npm, which
 * runs a script in the package's folder; else the working directory.
 *
 * @param env - the environment.
 * @param cwd - the working directory.
 * @returns the folder.
 */
export function configBase(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): string {
  const initCwd = env.INIT_CWD;
  return initCwd !== undefined && initCwd !== "" ? initCwd : cwd;
}

/**
 * An option's value as commander hands it, refused when it starts with `-`: commander gives an option
 * missing its value the next argument, so `--task --dry-run` would run a real start for a task named
 * `--dry-run`. A value that must start with `-` is written `./-…` (a path).
 *
 * @param value - the value.
 * @returns it.
 * @throws {@link InvalidArgumentError} when it starts with `-`.
 */
export function optionValue(value: string): string {
  if (value.startsWith("-"))
    throw new InvalidArgumentError(
      "a value cannot start with '-': the option is missing its value",
    );
  return value;
}

/**
 * `--task`'s parser: each id checked by {@link optionValue}, every occurrence's ids kept in order — a
 * parser of its own replaces commander's own collecting.
 *
 * @param value - one id.
 * @param previous - the ids so far.
 * @returns them, this one last.
 * @throws {@link InvalidArgumentError} when it starts with `-`.
 */
export function taskIds(
  value: string,
  previous: readonly string[] | undefined,
): string[] {
  return [...(previous ?? []), optionValue(value)];
}

/**
 * Maps commander's options to `start`'s, keeping only well-typed values: `--task`'s ids as they are
 * (repeated and duplicated ids included — `start` dedupes them and refuses an unknown one), and
 * `--config` resolved from `base` when it is relative.
 *
 * @param parsed - what commander parsed for `start`.
 * @param base - the folder a relative `--config` is from ({@link configBase}).
 * @returns the options `start` and the dry run take.
 */
export function toStartOptions(
  parsed: ParsedStartOptions,
  base: string,
): StartOptions {
  const tasks = Array.isArray(parsed.task)
    ? parsed.task.filter((id): id is string => typeof id === "string")
    : [];
  return {
    ...(typeof parsed.config === "string"
      ? { config: resolve(base, parsed.config) }
      : {}),
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(parsed.once === true ? { once: true } : {}),
  };
}

/**
 * Reads the checkout's version for `--version`.
 *
 * @param checkout - the checkout.
 * @returns its `package.json`'s `version`, or `unknown` when it cannot be read.
 */
export async function checkoutVersion(checkout: string): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(checkout, "package.json"), "utf8"),
    );
    const version: unknown =
      typeof parsed === "object" && parsed !== null
        ? Reflect.get(parsed, "version")
        : undefined;
    return typeof version === "string" && version !== "" ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Writes an error to standard error as one block, masked by shape (`safeBlock`): no secret value is
 * known yet — the config is not loaded, or failed to load.
 *
 * @param stderr - standard error.
 * @param text - the error.
 */
function writeError(stderr: Output, text: string): void {
  try {
    stderr.write(`${safeBlock(text, MAX_ERROR_LENGTH)}\n`);
  } catch {
    // Nowhere left to say it.
  }
}

/**
 * `start --dry-run`: what a start would run, on standard output; nothing is run, taken or written.
 *
 * @param options - the config file and `--task`; `--once` changes nothing here.
 * @param deps - the seams.
 * @returns `0` once the report is printed, warnings or not; `1` when the config, the product list or
 *   `--task` is refused, said on standard error.
 */
export async function dryRun(
  options: StartOptions,
  deps: CommandDeps = {},
): Promise<ExitCode> {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  try {
    const prepared = await (deps.prepareStart ?? prepareStart)(options);
    const stateWarnings = await (deps.inspectState ?? inspectState)(
      prepared.loaded.stateDir,
      { units: prepared.selected.map(unitOf) },
    );
    const lines = (deps.report ?? dryRunReport)(prepared, {
      checkout: deps.checkout ?? CHECKOUT,
      stateWarnings,
    });
    stdout.write(`${lines.join("\n")}\n`);
    return 0;
  } catch (error) {
    writeError(stderr, `${NAME}: dry run failed: ${textOf(error) || "failed"}`);
    return 1;
  }
}

/** What one parse decided. */
interface Outcome {
  /** The exit code. */
  code: number;
  /** Whether `start` ran: it emptied the terminal itself. */
  started: boolean;
}

/**
 * The command line's program: `start` and its options, help and version, every exit turned into a
 * thrown `CommanderError` and every error masked on its way to standard error.
 *
 * @param deps - the seams.
 * @param version - what `--version` prints.
 * @param outcome - where the action records its exit code.
 * @returns the program, ready to parse.
 */
function program(
  deps: CommandDeps,
  version: string,
  outcome: Outcome,
): Command {
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  // Settings first: `command()` copies them to the subcommand as it is made.
  const root = new Command()
    .name(NAME)
    .description(
      "Runs E2E cells in loops on this machine, and reports each run to Slack and Datator.",
    )
    .version(version)
    .exitOverride()
    .configureOutput({
      writeOut: (text) => stdout.write(text),
      writeErr: (text) => stderr.write(text),
      outputError: (text) => {
        writeError(stderr, text);
      },
    })
    .showHelpAfterError("(add --help for usage)");
  root
    .command("start")
    .description(
      "Runs every task of the config, each in its own loop, until stopped (Ctrl-C drains).",
    )
    .option(
      "--config <file>",
      "the config file; its folder is the state directory (default: .orchestrator/config.json in the checkout)",
      optionValue,
    )
    .option("--task <id...>", "run only these tasks (repeatable)", taskIds)
    .option("--once", "run each task once, then exit")
    .option(
      "--dry-run",
      "check the config and print what would run; runs, locks and writes nothing",
    )
    .addHelpText("after", START_HELP_AFTER)
    .action(async (parsed: ParsedStartOptions) => {
      const options = toStartOptions(
        parsed,
        configBase(deps.env ?? process.env, deps.cwd ?? process.cwd()),
      );
      if (parsed.dryRun === true) {
        outcome.code = await dryRun(options, deps);
        return;
      }
      outcome.started = true;
      holdSignals(deps.signals ?? process);
      outcome.code = await (deps.start ?? start)(options);
    });
  return root;
}

/**
 * Runs the command line.
 *
 * @param argv - the arguments after the script: `["start", "--once"]`.
 * @param deps - the seams; none in production.
 * @returns the exit code to call `process.exit` with at once: `start`'s; `0` for help, the version
 *   or a dry run; `1` for a usage error or a refused dry run. Never rejects.
 *
 * @example
 * ```ts
 * process.exit(await runCommand(process.argv.slice(2)));
 * ```
 */
export async function runCommand(
  argv: readonly string[],
  deps: CommandDeps = {},
): Promise<number> {
  const outcome: Outcome = { code: 0, started: false };
  dropOutputFailures(deps);
  const taken = npmTookOption(argv, deps.env ?? process.env);
  if (taken !== undefined) {
    writeError(
      deps.stderr ?? process.stderr,
      `${NAME}: npm took ${taken.option} as its own setting (${taken.variable} is set) and ran the script without it; nothing was run. Put every option after "--": npm run orchestrator -- start ${taken.option}${taken.option === "--task" ? " <id>" : taken.option === "--config" ? " <file>" : ""}. If you did write "--", ${taken.variable} comes from an .npmrc or the environment: remove it.`,
    );
    await drainOutputs(deps);
    return 1;
  }
  try {
    const version =
      deps.version ?? (await checkoutVersion(deps.checkout ?? CHECKOUT));
    await program(deps, version, outcome).parseAsync([...argv], {
      from: "user",
    });
  } catch (error) {
    if (error instanceof CommanderError) outcome.code = error.exitCode;
    else {
      // `start` and the dry run never reject: this is the parser itself failing.
      writeError(
        deps.stderr ?? process.stderr,
        `${NAME}: failed: ${textOf(error) || "failed"}`,
      );
      outcome.code = 1;
    }
  }
  if (!outcome.started) await drainOutputs(deps);
  return outcome.code;
}

/**
 * Gives standard output and error a failure listener that drops the failure: a reader that went away
 * (`… | head`, `EPIPE`) or a terminal gone with its session (`EIO`) is no crash with a stack trace —
 * what could not be written is lost either way, and the exit code is the command's. On `start`'s path
 * the logger has its own listener and stops writing to a terminal that failed.
 *
 * @param deps - the outputs.
 */
function dropOutputFailures(deps: CommandDeps): void {
  const outputs: Output[] = [
    deps.stdout ?? process.stdout,
    deps.stderr ?? process.stderr,
  ];
  for (const output of outputs)
    output.on?.("error", () => {
      // Nowhere left to say it.
    });
}

/**
 * Installs, for every shutdown signal, a handler that does nothing, and never removes it: `start`
 * removes its own handlers before it returns, and a signal arriving between then and `process.exit`
 * would otherwise end the process by Node's default action — killed by SIGINT rather than exiting
 * with `start`'s code. While `start` runs, its own handlers do the work beside these.
 *
 * @param target - `process`, or a stand-in.
 */
function holdSignals(target: SignalTarget): void {
  for (const signal of SHUTDOWN_SIGNALS)
    target.on(signal, () => {
      // Only so that Node takes no default action.
    });
}

/**
 * Waits for standard output and error to take what was written to them: unbounded by default — these
 * paths keep standard output blocking, and a slow reader must still get everything.
 *
 * @param deps - the outputs and the bound.
 */
async function drainOutputs(deps: CommandDeps): Promise<void> {
  const waitMs = deps.exitWaitMs ?? MAX_WAIT_MS;
  await Promise.all([
    drainTerminal(deps.stdout ?? process.stdout, waitMs),
    drainTerminal(deps.stderr ?? process.stderr, waitMs),
  ]);
}
