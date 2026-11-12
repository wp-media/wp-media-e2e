import { statSync } from "node:fs";
import { posix } from "node:path";
import { copyFile } from "node:fs/promises";

import { execa } from "execa";
import { NodeSSH } from "node-ssh";

import { CommandKilledError } from "./errors";
import { runAsArgv, withoutSudoNoise } from "./run-as-argv";

import type {
  DockerTransport,
  LocalTransport,
  SshTransport,
  Transport,
} from "../config/types";
import type { SudoTarget } from "./run-as-argv";

/**
 * Transport-level command execution **and file transfer** for the WordPress automation layer: who a
 * command runs as is chosen by the caller, never decided here. `./exec.ts` builds on this module —
 * it re-exports all of it and adds `exec`/`wpCli`, which run as the site's identity state decides —
 * and so does every probe that state is decided from (`./site-identity.ts`, `./owner-probe.ts`,
 * `./web-identity.ts`), which therefore never imports `./exec.ts`: no probe recurses through the
 * resolver it feeds.
 *
 * Three ways to run ({@link ExecAs}): {@link execAsTransport} (the transport's own user — probes, and
 * every command when the site does not run as its identity), {@link execAsSite} (over `ssh`, the
 * site's identity through `sudo` and a constant `/bin/sh` wrapper, `./run-as-argv.ts`) and
 * {@link execElevated} (root, for housekeeping). WP-CLI is never root.
 *
 * A command is given as a file + array of args — never a shell string — so there is no
 * shell interpolation and no injection. It is dispatched by the site's {@link Transport}:
 * `local`/`docker` via execa, `ssh` via node-ssh — given one command line this module builds itself,
 * every word single-quoted ({@link sshCommandLine}, {@link sshWrappedLine}), its output decoded from
 * whole buffers, and with node-ssh's own both-ends trimming switched off so every transport
 * normalises output the same way.
 *
 * Every mode returns a structured {@link ExecResult} with an `exitCode`, so callers branch
 * on the code (e.g. WP-CLI `is-installed`) instead of relying on thrown errors. A failure
 * to *run* the command at all — missing binary, unreachable SSH host — throws, because that is an
 * environment fault, not a command outcome. So does a command **killed by a signal**, on every
 * transport alike ({@link CommandKilledError}, so a caller with another way to its answer can tell it
 * apart): it never reached an exit code. Over `ssh` that holds because the line `exec`s the program
 * — no shell is left to turn the signal into an exit status `128 + n`, as a login shell that does
 * not `exec` the last command (dash, or bash before 5.1) did before.
 *
 * **No error quotes a command's arguments** — it names the program and why it failed. The argv is
 * where this suite puts what must never reach a report: a `--key=` value, and every value a `wp eval`
 * snippet embeds (`phpLiteral`'s base64 is an encoding, not a cipher). execa's own messages hold the
 * whole command line, so none is passed on, nor attached as a `cause`; ssh2's hold none.
 *
 * **Nothing is ever typed into a command**, so none is handed any input: node-ssh ends the channel's
 * stdin when given none, `local` ignores it, and `docker exec` without `-i` attaches none. A command
 * that stops to ask — WP-CLI's `confirm()` behind a `[y/n]` prompt — therefore reads end-of-input and
 * declines at once, on all three (measured). Left open, as execa leaves it by default, the same
 * prompt would wait forever on `local`, and on `docker` given `-i` (measured).
 *
 * **Some housekeeping cannot be done as the transport's user at all**, and that is not a
 * misconfiguration to work around. A plugin writes files as the *web-server* user; when it also
 * creates a directory only that user can write (BackWPup's restore area is `0755 www-data`), nothing
 * else can unlink inside it, and the site keeps that data for every scenario that ever ran. So this
 * layer offers {@link execElevated} — the same file+args dispatch, run with privileges — plus
 * {@link elevationSupport} so a caller can ask before relying on it.
 *
 * Elevation is deliberately **narrow**, because a test suite holding root is only safe while what it
 * does with it is boring:
 *
 *  - **Only ever housekeeping.** Removing leftover files, clearing `debug.log`, and the pre-flight's
 *    short-lived identity probe in a root the transport's user cannot write. Never `wp`: WP-CLI
 *    refuses to run as root without `--allow-root`, and files it created as root would be unwritable
 *    by the web server afterwards — the suite would break the site it is testing. `wpCli` has no way
 *    to request it, which is what makes that rule structural rather than a convention. (Running as
 *    the site's identity is not elevation: it is the web server's own user, never root.)
 *  - **Never on the path a scenario asserts against.** Elevation cannot make a product behaviour
 *    pass; it only removes what the product left behind after the verdict is in.
 *  - **Attempted second, never first.** Callers try as themselves and escalate only when the
 *    unprivileged attempt demonstrably failed, so a correctly-permissioned host never runs anything
 *    as root. One deliberate exception, and only around a command under test that rewrites the
 *    content directory wholesale: a copy of it taken and put back exactly, owners included, which
 *    only root can do — so it is privileged from the start, and refused outright without it (the
 *    command is then not run).
 *  - **Never interactive.** `sudo -n` fails immediately rather than waiting on a password prompt, so
 *    a host without passwordless sudo reports that instead of hanging a run.
 *  - **Refusable per site** (`transport.elevate: false`), and reported once per target when used.
 *
 * Running a command is not enough on its own: WP-CLI reads files from the **site's**
 * filesystem, so anything a test hands to `wp` (a plugin zip, a WXR import, a DB dump) must
 * exist there first. {@link copyIntoTarget} is that missing primitive, per transport
 * (`node:fs` copy / `docker cp` / SFTP), and {@link wpRootDir} resolves the absolute root the
 * copy target hangs off. Both live here, at the transport boundary, so the cached SSH
 * connection and the per-mode dispatch stay in one place; the staging-area layout and lifecycle
 * built on top of them live in `./staging.ts`.
 */

/** Structured outcome of a command run through a transport. */
export interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  /** The process exit code. A run that could never start throws instead of returning. */
  readonly exitCode: number;
}

/** Per-call options. */
export interface ExecOptions {
  /**
   * Working directory (local & ssh), the WordPress root by default. Ignored by `docker` — the
   * container defines it. One that does not exist runs nothing: `local` throws (execa cannot start
   * the program), `ssh` returns the shell's failed `cd` (non-zero exit, its reason on stderr).
   */
  readonly cwd?: string;
}

/** Strips a single trailing newline, matching execa's default so all transports agree. */
function stripFinalNewline(text: string): string {
  return text.replace(/\r?\n$/, "");
}

/**
 * What an execa result says about how a run ended — the only fields {@link fromExeca} may read.
 *
 * Those that hold the command line (`message`, `shortMessage`, `command`, `escapedCommand`) are left
 * out on purpose, so quoting one is a type error rather than a leak.
 */
export interface ExecaOutcome {
  readonly stdout: string;
  readonly stderr: string;
  /** Absent when the process could not be started or was killed. */
  readonly exitCode?: number;
  /** Node's code for a process that could not be started — `ENOENT`, `EACCES`. */
  readonly code?: string;
  readonly signal?: string;
  /** execa's plain-words name for {@link signal}, e.g. `Termination`. */
  readonly signalDescription?: string;
  readonly isMaxBuffer?: boolean;
}

/** A Node.js error code: the one part of a spawn failure quoted as it came. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]*$/;

/**
 * Why a run reached no exit code, in words that never include its arguments.
 *
 * `ENOENT` is ambiguous, and both readings are named: Node reports it for a program missing from the
 * `PATH` and for a working directory that does not exist alike (measured).
 *
 * @param outcome - the execa result.
 * @param cwd - the working directory the run was given, if it was given one.
 * @returns a phrase completing `"<program>" …`.
 */
export function whyItDidNotExit(outcome: ExecaOutcome, cwd?: string): string {
  if (outcome.signal !== undefined) {
    const description =
      outcome.signalDescription === undefined
        ? ""
        : ` (${outcome.signalDescription})`;
    return `was killed by ${outcome.signal}${description} before it exited`;
  }
  const code =
    outcome.code !== undefined && ERROR_CODE.test(outcome.code)
      ? outcome.code
      : undefined;
  if (code === "ENOENT") {
    return cwd === undefined
      ? "could not be started (ENOENT): no such program on this machine"
      : `could not be started (ENOENT): no such program on this machine, or no directory "${cwd}" to run it in`;
  }
  return code === undefined
    ? "ended without an exit code, and execa gave no reason"
    : `could not be started (${code})`;
}

/**
 * Maps an execa result (run with `reject: false`) to an {@link ExecResult}, or throws if it never ran
 * or its output was cut.
 *
 * @param label - the program, as a message names it: `wp`, `sudo rm`, `docker exec <container> wp`.
 * @param result - the execa result.
 * @param cwd - the working directory the run was given, if any — named when it may be what is missing.
 * @throws {@link CommandKilledError} when a signal ended it; Error naming `label` and the reason, never
 * the arguments, otherwise.
 */
function fromExeca(
  label: string,
  result: ExecaOutcome,
  cwd?: string,
): ExecResult {
  // execa caps captured output (100 MB of characters by default) and still reports **the child's own
  // exit code** — measured: `isMaxBuffer` with `exitCode` 0, 1 and 2 alike. A capped success is the
  // dangerous shape: the caller would read a silently shortened stdout as the whole answer, and an
  // assertion about what is *not* in it would pass. So it is raised rather than returned: the command
  // ran, but its answer cannot be trusted, which is "could not ask at all" and not an outcome.
  // Checked first, because a command that keeps writing is ended by the broken pipe (measured:
  // `yes` reports SIGPIPE), and naming the signal would hide the cause.
  // Applies to `local` and `docker` only — the ssh transport accumulates output with no cap at all.
  if (result.isMaxBuffer === true) {
    throw new Error(
      `[wp/exec] "${label}" produced more output than can be captured, so its result was ` +
        "truncated and cannot be trusted.",
    );
  }
  if (typeof result.exitCode !== "number") {
    const message = `[wp/exec] "${label}" ${whyItDidNotExit(result, cwd)}.`;
    throw result.signal === undefined
      ? new Error(message)
      : new CommandKilledError(message, result.signal);
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
}

/**
 * Runs `file args…` through execa and maps the outcome with {@link fromExeca}.
 *
 * execa checks its arguments before starting anything, and throws even with `reject: false` — quoting
 * the argument it refused (`Arguments cannot contain null bytes ("\0"): --key=…`, measured). Such a
 * throw is replaced by one naming `label` only.
 *
 * @param label - the program, as {@link fromExeca} names it.
 * @param file - the binary to run.
 * @param args - its arguments.
 * @param options - `cwd` for a local run; `stdin: "ignore"` for one that must never wait on input.
 * @throws Error naming `label`, if execa refused the call, the process never ran, or its output was cut.
 */
async function runExeca(
  label: string,
  file: string,
  args: readonly string[],
  options: { readonly cwd?: string; readonly stdin?: "ignore" },
): Promise<ExecResult> {
  let result: ExecaOutcome;
  try {
    result = await execa(file, args, { reject: false, ...options });
  } catch (error) {
    const kind = error instanceof Error ? ` (${error.name})` : "";
    // eslint-disable-next-line preserve-caught-error -- the caught error quotes the argv; leaving it off is the point.
    throw new Error(
      `[wp/exec] "${label}" could not be started: execa refused the call${kind}.`,
    );
  }
  return fromExeca(label, result, options.cwd);
}

// ── local & docker: execa (array args ⇒ no shell, no injection) ──────────────

/**
 * Runs `file args…` on this machine, in the WordPress root unless `options.cwd` says otherwise, with
 * no stdin; elevated through `sudo -n --` ({@link sudoArgv}). Messages name `file` (`sudo <file>`
 * when elevated), never the arguments.
 *
 * @param transport - the local transport.
 * @param file - the program.
 * @param args - its arguments.
 * @param options - see {@link ExecOptions}.
 * @param elevate - run as root.
 */
async function runLocal(
  transport: LocalTransport,
  file: string,
  args: string[],
  options: ExecOptions,
  elevate: boolean,
): Promise<ExecResult> {
  const [command, commandArgs, label] = elevate
    ? ["sudo", sudoArgv(file, args), `sudo ${file}`]
    : [file, args, file];
  return runExeca(label, command, commandArgs, {
    cwd: options.cwd ?? transport.rootDir,
    stdin: "ignore",
  });
}

/**
 * The `docker` argv (after the `docker` binary) to run `file args…` inside a running container.
 *
 * `asRoot` is how elevation works for this transport: the wp-cli containers run as `www-data`
 * (`user: "33:33"` in the compose file) so that files WP-CLI creates match the web server's
 * ownership, which leaves the same gap an SSH user has. `-u 0:0` is the answer rather than `sudo`,
 * because the official `wordpress:cli` image has no sudo binary — and there is nothing to escalate
 * *to*: the daemon already runs as root, so this only chooses which user it hands the process.
 */
export function dockerArgv(
  container: string,
  file: string,
  args: string[],
  options: { readonly asRoot?: boolean } = {},
): string[] {
  const asRoot = options.asRoot === true ? ["-u", "0:0"] : [];
  return ["exec", ...asRoot, container, file, ...args];
}

/**
 * The `sudo` argv (after the `sudo` binary) that runs `file args…` with privileges.
 *
 * `-n` never prompts — a host without passwordless sudo fails the call instead of blocking a run on
 * a password nobody will type. `--` ends sudo's own option parsing, so a target command or argument
 * beginning with `-` can never be read as a flag to sudo itself.
 */
export function sudoArgv(file: string, args: string[]): string[] {
  return ["-n", "--", file, ...args];
}

/**
 * Runs `file args…` in the transport's container through `docker exec` ({@link dockerArgv}): as the
 * container's user, or root (`-u 0:0`) when elevated. Messages name the container and `file`.
 *
 * @param transport - the docker transport.
 * @param file - the program.
 * @param args - its arguments.
 * @param elevate - run as root.
 */
async function runDocker(
  transport: DockerTransport,
  file: string,
  args: string[],
  elevate: boolean,
): Promise<ExecResult> {
  // Without `-i`, `docker exec` never attaches the client's stdin to the command (`AttachStdin` stays
  // false); ignoring it here too keeps the client from holding one open for nothing.
  return runExeca(
    `docker exec ${transport.container} ${file}`,
    "docker",
    dockerArgv(transport.container, file, args, { asRoot: elevate }),
    { stdin: "ignore" },
  );
}

// ── ssh: node-ssh, with a per-host connection cache reused across calls ───────

/**
 * Open SSH connections, one per endpoint (`connectionKey`), shared by every command to it until
 * lost or {@link disposeConnections}.
 */
const connections = new Map<string, NodeSSH>();

/**
 * How often an SSH connection is probed while it is open, and how many unanswered probes mean it is
 * dead.
 *
 * Without them a link that goes silent — no reset, just nothing arriving — is never noticed: through
 * a proxy that stopped forwarding, a command was still waiting after 70 s, with node-ssh reporting
 * the connection alive (measured). Probed every 10 s, a dead link is given up on within about 40 s
 * and the command on it fails rather than hangs. A healthy server answers a probe at once whatever
 * it is running, so a long command is not affected.
 */
export const SSH_KEEPALIVE = { intervalMs: 10_000, countMax: 3 } as const;

/** Why a pooled connection was lost, kept for the command that was running on it when it went. */
const connectionLosses = new WeakMap<NodeSSH, Error>();

/** ssh2's refusal of a request on a socket that no longer takes writes — raised before sending. */
const NOT_CONNECTED = "Not connected";

/**
 * The one part of ssh2's client this listens to. ssh2 ships no type declarations, so node-ssh's
 * `connection` field resolves to nothing the type checker can see; this names what is used.
 */
interface ErrorEmitter {
  on(event: "error", listener: (error: Error) => void): unknown;
}

/**
 * Cache key for one SSH endpoint (user + host + port + key), so calls to the same site reuse a
 * connection and two sites on one host but different ports never share one.
 */
function connectionKey(transport: SshTransport): string {
  return `${sshEndpoint(transport)}#${transport.privateKeyPath}`;
}

/**
 * A site's SSH endpoint as `user@host`, or `user@host:port` when it declares a port, for messages and
 * the connection pool: the twins share `127.0.0.1` and differ by port alone. A host holding `:` (an
 * IPv6 address) is always bracketed, so `::1` on port 2222 (`[::1]:2222`) never reads, or keys, as a
 * portless host `::1:2222` (`[::1:2222]`).
 *
 * @param transport - the site's ssh transport.
 * @returns the endpoint, never a secret.
 */
function sshEndpoint(transport: SshTransport): string {
  const port = transport.port === undefined ? "" : `:${String(transport.port)}`;
  return `${transport.username}@${scpHost(transport)}${port}`;
}

/**
 * The site's host as `scp`/`ssh` URLs write it: an IPv6 address (it holds `:`) in brackets, any
 * other host as is.
 *
 * @param transport - the site's ssh transport.
 * @returns the host, bracketed when it holds `:`.
 */
function scpHost(transport: SshTransport): string {
  return transport.host.includes(":") ? `[${transport.host}]` : transport.host;
}

/**
 * The pooled connection to a site's SSH endpoint, opened on first use and again whenever node-ssh
 * reports the pooled one disconnected.
 *
 * @throws Error naming the endpoint if a connection cannot be opened.
 */
async function connection(transport: SshTransport): Promise<NodeSSH> {
  const key = connectionKey(transport);
  const existing = connections.get(key);
  if (existing?.isConnected()) return existing;
  // A cached-but-dead client is replaced below; release its resources first.
  existing?.dispose();
  const ssh = new NodeSSH();
  // Named here because ssh2's own reason — `read ECONNRESET`, say — names neither the site nor the
  // step, and reaches a scenario's report as all there is to go on.
  await ssh
    .connect({
      host: transport.host,
      ...(transport.port !== undefined ? { port: transport.port } : {}),
      username: transport.username,
      privateKeyPath: transport.privateKeyPath,
      keepaliveInterval: SSH_KEEPALIVE.intervalMs,
      keepaliveCountMax: SSH_KEEPALIVE.countMax,
    })
    .catch((cause: unknown) => {
      throw new Error(
        `[wp/exec] could not connect to ${describeTarget(transport)}: ${cause instanceof Error ? cause.message : String(cause)}`,
        { cause },
      );
    });
  // node-ssh listens for connection errors only while connecting and while opening a channel. An
  // error after that — a keepalive timeout, a reset — would have no listener, and Node turns an
  // unhandled 'error' event into an uncaught exception that kills the worker process (measured, for
  // both). Either way the next call gets a new connection — at once after a reset or a timeout, and
  // through `withConnection`'s retry while ssh2 has only half-closed it; this listener only keeps the
  // reason, for the command that was running.
  (ssh.connection as ErrorEmitter | null)?.on("error", (error) => {
    connectionLosses.set(ssh, error);
  });
  connections.set(key, ssh);
  return ssh;
}

/**
 * Runs `work` on the site's pooled connection — and once more, on a new connection, if the pooled
 * one turns out to be dead before anything was sent.
 *
 * node-ssh reports a client connected until its socket has fully closed, but ssh2 stops writing
 * sooner: after a protocol error or a server's disconnect it half-closes the socket, and refuses
 * every request from then on with {@link NOT_CONNECTED}, checked before a byte goes out. On a failing
 * link the close can take minutes; a runner waking from sleep met exactly that, and lost a scenario
 * to it each time. Only that refusal is retried: a failure after a request went out is passed on,
 * so no command ever runs twice.
 */
async function withConnection<T>(
  transport: SshTransport,
  work: (ssh: NodeSSH) => Promise<T>,
): Promise<T> {
  const ssh = await connection(transport);
  try {
    return await work(ssh);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== NOT_CONNECTED) {
      throw error;
    }
    // Marks the client disconnected, which is what the pool checks — so it opens a new one. ssh2
    // offers no way to close a socket it has stopped writing to, so the old one lingers until the
    // server's own close reaches it.
    ssh.dispose();
    return work(await connection(transport));
  }
}

/**
 * One word for a POSIX shell, taken literally whatever it holds: wrapped in single quotes, inside
 * which nothing is special, each `'` written as `'\''` (close, an escaped quote, reopen). An empty
 * argument stays an argument (`''`), which node-ssh's own escaping dropped. NUL is not handled: no
 * argv can carry one, and {@link refuseUnsendable} refuses it before a command line is built.
 *
 * @param arg - the word.
 * @returns it quoted, ready to join with spaces.
 * @example
 * ```ts
 * shellQuote("it's"); // 'it'\''s'
 * shellQuote(""); // ''
 * ```
 */
export function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The command line an `ssh` command is sent as: `cd -- <cwd> && exec <file> <args…>`, every word
 * {@link shellQuote}d — the program too, so nothing in any position is ever read by the shell.
 *
 * `&&`, never `;`: a working directory that is missing or cannot be entered fails the call with the
 * shell's own message and a non-zero exit, instead of running the command wherever the login left it
 * (the SSH user's home). `--` keeps a directory beginning with `-` from being read as a `cd` option.
 * `exec` replaces the shell, so the exit status and a killing signal are the command's own; it finds
 * `file` on the login's `PATH` as an executable — a shell function or alias of that name is not run.
 *
 * Refused, because the line would not mean what it says: a `cwd` that is not absolute (`cd` would
 * resolve it from the login's home, or through `CDPATH`; an empty one changes nothing at all), and a
 * program whose name begins with `-` (`exec` would read it as an option, and dash's `exec` takes no
 * `--` — measured).
 *
 * @param cwd - the directory to run in, absolute on the target.
 * @param file - the program.
 * @param args - its arguments.
 * @returns the line for node-ssh's `execCommand`.
 * @throws Error naming the program and what is wrong, never the arguments.
 */
export function sshCommandLine(
  cwd: string,
  file: string,
  args: readonly string[],
): string {
  if (!posix.isAbsolute(cwd)) {
    throw new Error(
      `[wp/exec] refusing to run "${file}" over ssh: its working directory ${JSON.stringify(cwd)} is ` +
        "not an absolute path, which `cd` would resolve from the login's home.",
    );
  }
  if (file.startsWith("-")) {
    throw new Error(
      `[wp/exec] refusing to run "${file}" over ssh: a program name beginning with "-" would be read ` +
        "as an option to the shell's `exec`.",
    );
  }
  const command = [file, ...args].map(shellQuote).join(" ");
  return `cd -- ${shellQuote(cwd)} && exec ${command}`;
}

/**
 * The command line a wrapped `ssh` command is sent as: `exec <argv…>`, every word {@link shellQuote}d.
 * No `cd`: the argv is {@link runAsArgv}'s, whose wrapper enters the working directory as the
 * identity, so the SSH user never needs access to it.
 *
 * @param argv - the whole argv, program first (`sudo`).
 * @returns the line for node-ssh's `execCommand`.
 * @throws Error when the argv is empty or its program begins with `-` (dash's `exec` takes no `--`).
 */
export function sshWrappedLine(argv: readonly string[]): string {
  const [file] = argv;
  if (file === undefined || file === "" || file.startsWith("-")) {
    throw new Error(
      "[wp/exec] refusing to send a wrapped command over ssh: its program is missing or begins with " +
        '"-", which the shell\'s `exec` would read as an option.',
    );
  }
  return `exec ${argv.map(shellQuote).join(" ")}`;
}

/**
 * Decodes a command's output from its chunks, all at once, as UTF-8.
 *
 * Decoded whole, never chunk by chunk: a multi-byte character split between two chunks would become
 * two `U+FFFD` halves (node-ssh's own strings do exactly that, measured with 200,000 × `é`).
 *
 * @param chunks - the buffers the channel delivered, in order.
 * @returns the text.
 */
export function decodeOutput(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The line `runSsh` sends, and whether stderr carries `sudo`'s hostname noise to strip.
 *
 * @param file - the program.
 * @param args - its arguments.
 * @param cwd - the working directory.
 * @param as - who to run as.
 * @throws Error when the line would not mean what it says ({@link sshCommandLine}, {@link runAsArgv}).
 */
function sshLineFor(
  file: string,
  args: string[],
  cwd: string,
  as: ExecAs,
): { readonly line: string; readonly wrapped: boolean } {
  switch (as.kind) {
    case "transport":
      return { line: sshCommandLine(cwd, file, args), wrapped: false };
    case "root":
      return {
        line: sshCommandLine(cwd, "sudo", sudoArgv(file, args)),
        wrapped: false,
      };
    case "site":
      return {
        line: sshWrappedLine(runAsArgv(as.target, as.umask, cwd, file, args)),
        wrapped: true,
      };
    default: {
      const exhaustive: never = as;
      throw new Error(
        `[wp/exec] unknown identity ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Runs one command over SSH, in the WordPress root unless `options.cwd` says otherwise, as `as` says.
 *
 * Messages name `file`, the program asked for — never `sudo`, which only carries it. Under the site's
 * wrapper, stderr loses `sudo`'s `unable to resolve host` lines (a host missing from its own
 * `/etc/hosts` adds one to every call): whoever reads stderr would take them for the command's own.
 *
 * @throws {@link CommandKilledError} when a signal ended the command; Error if the line is refused
 * ({@link sshCommandLine}, {@link runAsArgv}), the connection could not be opened, or it was lost or
 * closed before the command exited, since how it ended is then unknown.
 */
async function runSsh(
  transport: SshTransport,
  file: string,
  args: string[],
  options: ExecOptions,
  as: ExecAs,
): Promise<ExecResult> {
  const { line, wrapped } = sshLineFor(
    file,
    args,
    options.cwd ?? transport.rootDir,
    as,
  );
  return withConnection(transport, async (ssh) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    // No `cwd` option: node-ssh would prepend its own `cd <cwd> ;`, running the command in the
    // login's home when that directory is missing. The line above does the `cd` itself.
    //
    // `noTrim` is load-bearing, not a detail: without it node-ssh trims **both ends** of stdout and
    // stderr, which is a different normalisation from every other transport's and silently eats
    // meaningful whitespace — the leading space of a tar member name, an option value stored with
    // one. Turning it off leaves `stripFinalNewline` to do the one normalisation all transports
    // agree on. Its strings are ignored: decoded per chunk, they break a split character.
    const result = await ssh.execCommand(line, {
      noTrim: true,
      onStdout: (chunk: Buffer) => stdout.push(chunk),
      onStderr: (chunk: Buffer) => stderr.push(chunk),
    });
    if (result.code === null) {
      const lost = connectionLosses.get(ssh);
      if (lost !== undefined) {
        throw new Error(
          `[wp/exec] the connection to ${describeTarget(transport)} was lost (${lost.message}) while "${file}" was ` +
            "running, so how it ended is unknown.",
        );
      }
      // Neither a status nor a signal: the channel closed under it (the connection disposed, the
      // server gone) — not a kill, so not typed as one.
      if (result.signal === null) {
        throw new Error(
          `[wp/exec] "${file}" on ${describeTarget(transport)} ended with neither an exit status nor a signal ` +
            "(its channel closed), so how it ended is unknown.",
        );
      }
      throw new CommandKilledError(
        `[wp/exec] "${file}" on ${describeTarget(transport)} was terminated by signal ${result.signal} before exiting.`,
        result.signal,
      );
    }
    const errors = decodeOutput(stderr);
    return {
      stdout: stripFinalNewline(decodeOutput(stdout)),
      stderr: stripFinalNewline(wrapped ? withoutSudoNoise(errors) : errors),
      exitCode: result.code,
    };
  });
}

/**
 * Why a word cannot reach a program as given, or `undefined` when it can.
 *
 * A NUL byte: an argv is NUL-terminated. A lone UTF-16 surrogate (not well-formed text): it has no
 * UTF-8 form, and every transport would silently send `U+FFFD` in its place (measured over ssh).
 *
 * @param word - the program's name or an argument.
 */
function unsendable(word: string): string | undefined {
  if (word.includes("\0")) return "holds a NUL byte";
  if (!word.isWellFormed()) return "is not well-formed text (a lone surrogate)";
  return undefined;
}

/**
 * Refuses a command whose program or argument no program can be handed unchanged, before any
 * transport sees it — see {@link unsendable}.
 *
 * Each transport refused a NUL its own way (measured): execa throws, quoting the argument, and
 * ssh2's request fails as a bare `Unable to exec`; a lone surrogate none refused. Refused here, every
 * transport says the same thing, naming the argument by position only.
 *
 * @throws Error naming the program (unless its own name is the offender) and the argument's position.
 */
function refuseUnsendable(file: string, args: readonly string[]): void {
  const inName = unsendable(file);
  if (inName !== undefined) {
    throw new Error(
      `[wp/exec] refusing to run a program whose name ${inName}.`,
    );
  }
  for (const [index, arg] of args.entries()) {
    const why = unsendable(arg);
    if (why !== undefined) {
      throw new Error(
        `[wp/exec] refusing to run "${file}": argument ${String(index + 1)} ${why}, ` +
          "which no program can be handed.",
      );
    }
  }
}

/**
 * Who a command runs as:
 * - `transport`: the transport's own user (SSH login, the docker exec user, the runner);
 * - `root`: `sudo -n --` (`docker exec -u 0:0`), for housekeeping only ({@link execElevated});
 * - `site`: over `ssh` only, the site's identity through `sudo -u -g` and the umask wrapper
 *   ({@link runAsArgv}).
 */
export type ExecAs =
  | { readonly kind: "transport" }
  | { readonly kind: "root" }
  | {
      readonly kind: "site";
      /** What `sudo -u`/`-g` are given (names, or ids as digits). */
      readonly target: SudoTarget;
      /** Four octal digits. */
      readonly umask: string;
    };

/** {@link ExecAs} `transport`, shared. */
const AS_TRANSPORT: ExecAs = { kind: "transport" };

/** {@link ExecAs} `root`, shared. */
const AS_ROOT: ExecAs = { kind: "root" };

/**
 * Runs `file args…` on the transport's target, as `as` says.
 *
 * `async` so that {@link refuseUnsendable} arrives as a rejection like every other failure here.
 *
 * @throws Error for `site` on `docker`/`local`, which have no other identity (a caller's bug).
 */
async function dispatch(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions,
  as: ExecAs,
): Promise<ExecResult> {
  refuseUnsendable(file, args);
  if (as.kind === "site" && transport.mode !== "ssh") {
    throw new Error(
      `[wp/exec] refusing to run "${file}" as the site's identity on a ${transport.mode} transport: ` +
        "only ssh runs commands as another identity.",
    );
  }
  const root = as.kind === "root";
  switch (transport.mode) {
    case "local":
      return runLocal(transport, file, args, options, root);
    case "docker":
      return runDocker(transport, file, args, root);
    case "ssh":
      return runSsh(transport, file, args, options, as);
    default: {
      // Exhaustiveness: assigning to `never` makes an unhandled transport mode a compile error.
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Runs `file args…` through the transport **as the transport's own user**, whatever the site's
 * identity state: for the probes that state is decided from (`stat`, `id`, `sudo -n true`, …), and
 * for a check whose subject is the transport's user. Every other site command goes through `exec`
 * (`./exec.ts`).
 *
 * @param transport - the site's transport.
 * @param file - the program.
 * @param args - its arguments.
 * @param options - see {@link ExecOptions}.
 * @returns the outcome; see this module's header for what throws.
 */
export function execAsTransport(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return dispatch(transport, file, args, options, AS_TRANSPORT);
}

/**
 * Runs `file args…` over `ssh` as the site's identity: `sudo -n -u <user> -g <group> -- /bin/sh -c
 * <wrapper> …`, the wrapper setting `umask` and entering the working directory as the identity. Only
 * `exec` (`./exec.ts`) calls it, once the identity state is `site`.
 *
 * @param transport - the site's ssh transport.
 * @param identity - who to run as, and with which umask.
 * @param file - the program, found on `sudo`'s `secure_path`.
 * @param args - its arguments.
 * @param options - see {@link ExecOptions}.
 * @returns the outcome, stderr without `sudo`'s hostname noise.
 * @throws Error naming the program (never `sudo`), as this module's header says.
 */
export function execAsSite(
  transport: SshTransport,
  identity: { readonly target: SudoTarget; readonly umask: string },
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  return dispatch(transport, file, args, options, {
    kind: "site",
    target: identity.target,
    umask: identity.umask,
  });
}

// ── Elevation ────────────────────────────────────────────────────────────────

/**
 * Whether this target can run a privileged housekeeping command.
 *
 *  - `available` — it can, and {@link execElevated} will work.
 *  - `unavailable` — the host has no passwordless `sudo` for the transport's user (or no `sudo` at
 *    all). Cleanup reports what it could not remove instead of escalating.
 *  - `disabled` — the site declared `transport.elevate: false`.
 */
export type ElevationSupport = "available" | "unavailable" | "disabled";

/**
 * Probe results, keyed per target so a runner talking to several sites asks each one once.
 *
 * Cached because the answer is a property of the host, not of the call — and one wasted `sudo -n
 * true` per cleanup, on every scenario, is a round-trip nobody gets anything for.
 */
const elevationProbes = new Map<string, ElevationSupport>();

/** Targets already reported as escalating, so the notice below is printed once each. */
const elevationNotices = new Set<string>();

/**
 * Identity of a target, for any cache holding a fact about the *host* rather than about a call —
 * elevation support here, detected file ownership in `./ownership.ts`.
 *
 * `local` is keyed by its WordPress root rather than globally: passwordless sudo is really a
 * property of the machine and user, so this asks at most one extra time per site, and in exchange
 * one site's answer is never attributed to another's.
 *
 * Exported so a sibling module memoises against the *same* notion of "the same target", instead of
 * inventing a second one that could disagree.
 */
export function targetKey(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `ssh:${connectionKey(transport)}`;
    case "docker":
      return `docker:${transport.container}`;
    case "local":
      return `local:${transport.rootDir}`;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Identity of one **WordPress install**, for a cache holding a fact about the install rather than
 * about the machine hosting it.
 *
 * {@link targetKey} is deliberately coarser — passwordless sudo is a property of a host and a user,
 * so asking once per host is right. File ownership is not: one host routinely serves several sites,
 * and they need not agree. Measured on a live cell, two docroots under the same `ubuntu@host`:
 * `sftp_backwpup:www-data` and `sftp_wprocket:www-data`. Keyed by host alone, whichever was probed
 * first would answer for both — misreporting one site in a fleet check, and, in any process that
 * normalised two sites, aiming a privileged `chown -R` at the wrong owner.
 *
 * The `rootDir` is used unresolved, because that is what distinguishes two sites in configuration;
 * a `docker` transport without one contributes an empty root, so the same container reached with and
 * without a declared `rootDir` keys separately rather than being assumed identical.
 */
export function installKey(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return `ssh:${connectionKey(transport)}#${transport.rootDir}`;
    case "docker":
      return `docker:${transport.container}#${transport.rootDir ?? ""}`;
    case "local":
      return `local:${transport.rootDir}`;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * How a target is described in operator-facing messages — enough to identify it, no secrets.
 * Exported so sibling modules name a site the same way this one does.
 */
export function describeTarget(transport: Transport): string {
  switch (transport.mode) {
    case "ssh":
      return sshEndpoint(transport);
    case "docker":
      return `container ${transport.container}`;
    case "local":
      return transport.rootDir;
    default: {
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

/**
 * Whether {@link execElevated} can be used against this target — asked before escalating, so a
 * caller can report the *reason* cleanup is stuck rather than a bare permission error.
 *
 * `docker` needs no probe: the daemon runs as root, so `-u 0:0` is a choice of user rather than an
 * escalation, and it cannot be refused by the container. Otherwise this runs `sudo -n true` once per
 * target. A missing `sudo` binary makes the probe *throw* on `local` (execa cannot start it) and
 * exit non-zero over `ssh`; both mean the same thing here, so both answer `unavailable`.
 */
export async function elevationSupport(
  transport: Transport,
): Promise<ElevationSupport> {
  if (transport.elevate === false) return "disabled";
  if (transport.mode === "docker") return "available";

  const key = targetKey(transport);
  const cached = elevationProbes.get(key);
  if (cached !== undefined) return cached;

  let support: ElevationSupport;
  try {
    // As the transport's user whatever the site runs as: `sudo` is the SSH user's, and the identity
    // has none.
    const { exitCode } = await execAsTransport(transport, "sudo", [
      "-n",
      "true",
    ]);
    support = exitCode === 0 ? "available" : "unavailable";
  } catch {
    // Answered, but **not remembered**. A throw means the transport failed, not that the host has
    // no passwordless sudo — and this value gates every escalation for the rest of the process, so
    // caching one dropped connection would silently stop residue being removed and ownership being
    // corrected, on a host that is fine. The ownership probes refuse this for the same reason.
    return "unavailable";
  }
  elevationProbes.set(key, support);
  return support;
}

/**
 * Forgets the memoised elevation answers. For tests, which change a target's `sudo` between cases;
 * a run has no reason to call it, since the answer is a property of the host.
 */
export function resetElevationCaches(): void {
  elevationProbes.clear();
  elevationNotices.clear();
}

/**
 * Runs `file args…` with privileges — for housekeeping only, under the limits in this module's
 * header.
 *
 * Callers are expected to have tried unprivileged first and to have checked
 * {@link elevationSupport}; this does not probe, so a target without sudo simply returns sudo's own
 * non-zero result. The first use against a target is announced once, because a suite quietly running
 * commands as root would be the wrong kind of surprise.
 *
 * @throws Error if the site declared `transport.elevate: false` — the opt-out is authoritative, so
 * it fails loudly here rather than being silently ignored by a caller that forgot to check.
 * `async` so that refusal arrives as a rejection like every other failure from this layer, rather
 * than as a synchronous throw a caller would have to guard differently.
 */
export async function execElevated(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  if (transport.elevate === false) {
    throw new Error(
      `[wp/exec] refusing to run "${file}" with elevated privileges: this site declares ` +
        "`transport.elevate: false`. Remove that to allow privileged cleanup, or make the paths " +
        "in question writable by the transport's user.",
    );
  }
  const key = targetKey(transport);
  if (!elevationNotices.has(key)) {
    elevationNotices.add(key);
    console.info(
      `[wp/exec] using elevated privileges on ${describeTarget(transport)} for housekeeping the ` +
        "transport's user is not permitted to do — removing files the web server owns, reading its " +
        "debug.log, keeping a copy of wp-content around a command that rewrites it, or dropping " +
        "the pre-flight's short-lived identity probe into the WordPress root. Only " +
        "housekeeping is ever elevated; WP-CLI is never root.",
    );
  }
  return dispatch(transport, file, args, options, AS_ROOT);
}

/**
 * What `absolutePath` really is on the target, with every symbolic link along it resolved.
 *
 * Exists because the guards in `./paths.ts` are **lexical**: they compare path strings, so a symlink
 * anywhere in the path — the final component, or any parent — makes them agree that a target is
 * inside the WordPress root when the kernel will resolve it somewhere else entirely. Measured: with
 * `wp-content/uploads` replaced by a link, a privileged `rm -rf` of a declared residue path deleted
 * content outside the root while every guard reported success.
 *
 * `readlink -f` is the portable choice — GNU and BusyBox both resolve links and both tolerate the
 * **last** component being absent, which a path about to be created always is. Neither resolves a
 * path missing more than that, which is why the caller falls back to the parent.
 *
 * @param transport - the target site's transport.
 * @param absolutePath - the path to resolve, absolute on the target.
 * @returns the fully resolved path, or `undefined` when it could not be resolved — which a caller
 * about to run a privileged command must treat as a refusal, never as permission.
 * @throws Error if the question could not be asked at all (the transport failed).
 */
export async function resolveOnTarget(
  transport: Transport,
  absolutePath: string,
): Promise<string | undefined> {
  const { exitCode, stdout } = await execAsTransport(transport, "readlink", [
    "-f",
    "--",
    absolutePath,
  ]);
  const resolved = stdout.trim();
  return exitCode === 0 && resolved !== "" ? resolved : undefined;
}

/**
 * Refuses a privileged target whose **resolved** path leaves the site's WordPress root.
 *
 * `assertSafeElevatedTarget` (in `./paths.ts`) settles the same question lexically; this settles it
 * against the filesystem, which is the half a string comparison cannot see. Both run, and they fail
 * for different reasons, so an operator is told which.
 *
 * A path that does not exist yet cannot be a symlink, so what matters is its **deepest existing
 * ancestor** — this walks up to it rather than relying on `readlink -f` tolerating an absent
 * component, which GNU and BusyBox do and other implementations do not. If nothing on the path
 * resolves, nothing is known about where a root command would land, and the only safe reading of
 * "unknown" is "no".
 *
 * @param transport - the target site's transport.
 * @param target - the absolute path the privileged command would act on.
 * @param root - the site's WordPress root, as the transport resolved it.
 * @param describeRejection - builds the message from the rule that was broken.
 * @throws Error built by `describeRejection`.
 */
export async function assertResolvedInsideRoot(
  transport: Transport,
  target: string,
  root: string,
  describeRejection: (reason: string) => string,
): Promise<void> {
  await assertAllResolvedInsideRoot(
    transport,
    [target],
    root,
    describeRejection,
  );
}

/**
 * {@link assertResolvedInsideRoot} for several targets, resolving the root **once** rather than once
 * per target: every command is a round-trip to the site (~0.8 s over SSH, measured), so a check
 * that repeats one per target makes a removal's cost grow with what it removes.
 *
 * @param transport - the target site's transport.
 * @param targets - the absolute paths privileged commands would act on; none does nothing.
 * @param root - the site's WordPress root, as the transport resolved it.
 * @param describeRejection - builds the message from the rule that was broken.
 * @returns the root as it resolved for the check (`undefined` with no targets): a caller re-checking
 * it at the moment it acts compares against this.
 * @throws Error built by `describeRejection`, for the first target that fails.
 */
export async function assertAllResolvedInsideRoot(
  transport: Transport,
  targets: readonly string[],
  root: string,
  describeRejection: (reason: string) => string,
): Promise<string | undefined> {
  if (targets.length === 0) return undefined;
  const realRoot = await resolveOnTarget(transport, root);
  for (const target of targets) {
    const realTarget = await resolveDeepestExisting(transport, target, root);
    if (realRoot === undefined || realTarget === undefined) {
      throw new Error(
        describeRejection(
          `"${target}" could not be resolved on this site, so where a privileged command would ` +
            "land is unknown",
        ),
      );
    }
    if (realTarget !== realRoot && !realTarget.startsWith(`${realRoot}/`)) {
      throw new Error(
        describeRejection(
          `"${target}" really resolves to "${realTarget}", which is outside it — a symbolic link ` +
            "on the way there points out of the site",
        ),
      );
    }
  }
  return realRoot;
}

/**
 * Resolves `target`, or its nearest ancestor that exists, without leaving `root`'s depth.
 *
 * @param transport - the target site's transport.
 * @param target - the absolute path to resolve.
 * @param root - the site's WordPress root; the walk stops once it is shorter than this.
 * @returns the resolved path of the deepest existing ancestor, or `undefined` if none resolved.
 */
async function resolveDeepestExisting(
  transport: Transport,
  target: string,
  root: string,
): Promise<string | undefined> {
  let current = target;
  while (current.length >= root.length) {
    const resolved = await resolveOnTarget(transport, current);
    if (resolved !== undefined) return resolved;
    const parent = posix.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** Closes all cached SSH connections. Call from a worker-teardown fixture. */
export function disposeConnections(): void {
  for (const ssh of connections.values()) {
    ssh.dispose();
  }
  connections.clear();
}

// ── WordPress root resolution ────────────────────────────────────────────────

/** Resolved container WORKDIRs, keyed by container name (a running container cannot change it). */
const dockerRoots = new Map<string, string>();

/**
 * The absolute WordPress root **on the target** — the directory every command already uses as its
 * working directory by default. Needed because a file copy cannot rely on that working
 * directory: `docker cp` and SFTP both resolve their target path themselves.
 *
 * `local`/`ssh` take it from the site's declared `rootDir`. For `docker` it is the container's
 * `WORKDIR`, which the images we use set to the WordPress root; it is read once with `pwd` and
 * cached per container, or skipped entirely when the transport declares `rootDir`.
 *
 * @throws Error if `pwd` fails in the container (e.g. it is not running) — the message names the
 * container and suggests declaring `rootDir`.
 */
export async function wpRootDir(transport: Transport): Promise<string> {
  if (transport.mode !== "docker") return transport.rootDir;
  if (transport.rootDir !== undefined) return transport.rootDir;

  const cached = dockerRoots.get(transport.container);
  if (cached !== undefined) return cached;

  const { exitCode, stdout, stderr } = await execAsTransport(
    transport,
    "pwd",
    [],
  );
  const root = stdout.trim();
  if (exitCode !== 0 || root === "") {
    throw new Error(
      `[wp/exec] could not resolve the WordPress root in container "${transport.container}" ` +
        `(\`pwd\` exited ${String(exitCode)}: ${stderr.trim() || "no output"}). ` +
        "Declare `rootDir` on the docker transport to skip this lookup.",
    );
  }
  dockerRoots.set(transport.container, root);
  return root;
}

// ── File transfer (runner → target) ──────────────────────────────────────────

/**
 * Whether two paths are the same file on this filesystem — compared by device + inode, so a
 * symlink, a hard link or a differently-spelled path to one file all count. A missing path is
 * simply "not the same file"; the copy that follows then reports the real problem.
 */
function isSameFile(a: string, b: string): boolean {
  try {
    const left = statSync(a);
    const right = statSync(b);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** The `docker` argv (after the `docker` binary) to copy a host file into a container. */
export function dockerCpArgv(
  container: string,
  localAbs: string,
  targetAbs: string,
): string[] {
  // `docker cp` is a top-level sub-command, NOT `docker exec` — it talks to the daemon and
  // needs no shell (or even a running shell) in the container.
  return ["cp", localAbs, `${container}:${targetAbs}`];
}

/**
 * Copies a file from the runner onto the target, overwriting `targetAbs` if it exists.
 *
 * Per transport: a same-filesystem copy (`local`), `docker cp` (`docker`), or SFTP over the
 * cached connection (`ssh`, always as the SSH login: in the `site` state staging uploads into an inbox
 * of the login's and the identity copies it in, `./site-staging.ts`). The parent directory of
 * `targetAbs` must already exist: `copyFile` and
 * `docker cp` do not create it, and SFTP only does so through node-ssh's retry after a failed
 * write — so callers create it first (see `staging.ts`, which does the `mkdir -p`).
 *
 * @param transport - the target site's transport.
 * @param localAbs - absolute path of the source file on the runner.
 * @param targetAbs - absolute destination path on the target.
 * @throws Error naming the transport and both paths when the copy fails.
 */
export async function copyIntoTarget(
  transport: Transport,
  localAbs: string,
  targetAbs: string,
): Promise<void> {
  switch (transport.mode) {
    case "local":
      // Source and destination can be the SAME file here — the runner and the site share one
      // filesystem, so re-staging an already-staged path, or a site whose root contains the
      // resolved artifacts, both reach this. Copying a file onto itself opens the destination
      // for truncation, which can empty the source before a byte is read; it is already staged,
      // so the copy is simply skipped.
      if (isSameFile(localAbs, targetAbs)) return;
      await copyFile(localAbs, targetAbs).catch((cause: unknown) => {
        throw new Error(
          `[wp/exec] could not copy "${localAbs}" to "${targetAbs}" on the local filesystem.`,
          { cause },
        );
      });
      return;
    case "docker": {
      const { exitCode, stderr } = await runExeca(
        `docker cp ${localAbs} ${transport.container}:${targetAbs}`,
        "docker",
        dockerCpArgv(transport.container, localAbs, targetAbs),
        {},
      );
      if (exitCode !== 0) {
        throw new Error(
          `[wp/exec] \`docker cp\` of "${localAbs}" into "${transport.container}:${targetAbs}" ` +
            `failed (exit ${String(exitCode)}): ${stderr.trim() || "no stderr"}`,
        );
      }
      return;
    }
    case "ssh":
      // SFTP upload over the connection `exec` already uses; overwrites.
      await withConnection(transport, (ssh) =>
        ssh.putFile(localAbs, targetAbs),
      ).catch((cause: unknown) => {
        throw new Error(
          `[wp/exec] could not upload "${localAbs}" to ${transport.username}@${scpHost(transport)}:"${targetAbs}"${transport.port === undefined ? "" : ` (port ${String(transport.port)})`}.`,
          { cause },
        );
      });
      return;
    default: {
      // Exhaustiveness: assigning to `never` makes an unhandled transport mode a compile error.
      const exhaustive: never = transport;
      throw new Error(
        `[wp/exec] unsupported transport: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}
