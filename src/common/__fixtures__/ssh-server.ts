import { execFileSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { createRequire } from "node:module";
import type net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSSH } from "node-ssh";

import type { SshTransport } from "../config/types";
import { installExclDd } from "./excl-dd";
import { killTethered, spawnTethered } from "./tether";
import { removeTempDir } from "./temp-dir";

/**
 * For specs: an in-process SSH server that **runs** what it is sent, so the ssh transport's command
 * line is proved by a real shell rather than by reading the string.
 *
 * Each `exec` request runs as `sh -c <command line>` in a fresh home folder, as this process's user,
 * with a folder of fake programs first on `PATH` — a recording `sudo` among them. Uploads over SFTP
 * write real files (OPEN's flags are ignored: every open truncates or creates, never `O_EXCL`).
 * Everything lives in one temporary folder, removed by {@link SshTestServer.close} — and when
 * {@link startSshServer} fails part-way; every command is killed (its whole process group) when its
 * channel closes, when it outlives its time limit ({@link COMMAND_TIMEOUT_MS} by default), or at
 * `close` — or when this process dies, even SIGKILLed (`tether.ts`) — so a spec can neither hang on
 * one nor leave one behind.
 *
 * Not a real server's limits: ssh2 refuses any packet over 35,000 bytes, so a command line longer
 * than about 34 KB fails as `Unable to exec` here, where OpenSSH takes far more.
 */

// ── ssh2's server API, as far as this file uses it (the package ships no type declarations) ──────

/** The channel one `exec` request runs on. */
export interface ExecStream {
  write(data: string | Buffer): void;
  /** Stderr's side of the channel. */
  readonly stderr: { write(data: string | Buffer): void };
  /** A number is an exit status; a string, the signal the command was killed by. */
  exit(statusOrSignal: number | string): void;
  end(): void;
  once(event: "close", listener: () => void): this;
  /** Reads (and drops) what the client sends, so the channel can end and emit `close`. */
  resume(): this;
}

/** ssh2's server side of one SFTP session. */
interface SftpSession {
  on(
    event: "OPEN",
    listener: (
      reqid: number,
      filename: string,
      flags: number,
      attrs: { mode?: number },
    ) => void,
  ): this;
  on(
    event: "WRITE",
    listener: (
      reqid: number,
      handle: Buffer,
      offset: number,
      data: Buffer,
    ) => void,
  ): this;
  on(event: "CLOSE", listener: (reqid: number, handle: Buffer) => void): this;
  handle(reqid: number, handle: Buffer): void;
  status(reqid: number, code: number): void;
}

/** One session on a connection: the requests a client makes on it. */
interface ServerSession {
  on(
    event: "exec",
    listener: (
      accept: () => ExecStream,
      reject: () => void,
      info: { command: string },
    ) => void,
  ): this;
  on(event: "sftp", listener: (accept: () => SftpSession) => void): this;
}

/** What a client authenticating offers. */
interface AuthContext {
  method: string;
  accept(): void;
  reject(methods: string[]): void;
}

/** One client connection, as the server sees it. */
export interface ServerConnection {
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "authentication", listener: (context: AuthContext) => void): this;
  on(event: "session", listener: (accept: () => ServerSession) => void): this;
  /** Sends the client a disconnect, then half-closes the socket. */
  end(): void;
}

/** ssh2's `Server`. */
interface Ssh2Server {
  listen(port: number, host: string, callback: () => void): void;
  address(): net.AddressInfo;
  close(callback?: () => void): void;
  once(event: "error", listener: (error: Error) => void): this;
  removeListener(event: "error", listener: (error: Error) => void): this;
}

/** An OpenSSH key pair, as ssh2 generates one. */
export interface KeyPair {
  readonly private: string;
  readonly public: string;
}

/** The parts of the `ssh2` module used here. */
interface Ssh2 {
  Server: new (
    config: { hostKeys: string[] },
    listener: (connection: ServerConnection) => void,
  ) => Ssh2Server;
  utils: {
    generateKeyPairSync(type: "ed25519"): KeyPair;
    /** The parsed key, or the Error saying why it could not be. */
    parseKey(key: string): unknown;
    sftp: {
      STATUS_CODE: { OK: number; FAILURE: number; NO_SUCH_FILE: number };
    };
  };
}

const ssh2 = createRequire(import.meta.url)("ssh2") as Ssh2;

// ── The fake programs ─────────────────────────────────────────────────────────────────────────────

/** How long a command may run before it is killed (SIGKILL) by default: past any spec's own need. */
export const COMMAND_TIMEOUT_MS = 20_000;

/**
 * A `sudo` standing in for the real one: it appends its whole argv to `$E2E_FAKE_SUDO_LOG` (each
 * argument hex-encoded, so any byte survives), then refuses as `sudo -n` without a rule does —
 * `sudo: a password is required`, exit 1 — while `$E2E_FAKE_SUDO_DENY` exists, and otherwise skips its
 * options (`-n`; `-u`/`-g` and their value) up to `--` and `exec`s the rest as the current user, with
 * the `-u`/`-g` values exported as `$E2E_FAKE_SUDO_USER`/`$E2E_FAKE_SUDO_GROUP` so a fake program
 * (`id`) can answer as the identity asked for.
 */
const FAKE_SUDO = `#!/bin/sh
line=
for arg in "$@"; do
  line="$line:$(printf '%s' "$arg" | od -An -v -tx1 | tr -d ' \\n')"
done
printf '%s\\n' "$line" >> "$E2E_FAKE_SUDO_LOG"
if [ -e "$E2E_FAKE_SUDO_DENY" ]; then
  echo 'sudo: a password is required' >&2
  exit 1
fi
while [ "$#" -gt 0 ]; do
  case $1 in
    --) shift; break ;;
    -n) shift ;;
    -u) E2E_FAKE_SUDO_USER=$2; export E2E_FAKE_SUDO_USER; shift 2 ;;
    -g) E2E_FAKE_SUDO_GROUP=$2; export E2E_FAKE_SUDO_GROUP; shift 2 ;;
    *) echo "sudo (fake): unsupported option $1" >&2; exit 1 ;;
  esac
done
exec "$@"
`;

/**
 * Prints its argument count, then each argument hex-encoded on a line of its own — read back with
 * {@link decodeArgv}. Hex, because only ASCII crosses the channel unchanged whatever its chunking.
 */
const PRINT_ARGV = `#!/bin/sh
echo "$#"
for arg in "$@"; do
  printf '%s' "$arg" | od -An -v -tx1 | tr -d ' \\n'
  echo
done
`;

/** The program {@link PRINT_ARGV} is installed as. */
export const PRINT_ARGV_PROGRAM = "e2e-print-argv";

/**
 * The argv a {@link PRINT_ARGV_PROGRAM} run printed.
 *
 * @param stdout - its output, as `exec` returns it (final newline stripped).
 * @returns the arguments it was given.
 * @throws Error when the output is not what that program prints.
 */
export function decodeArgv(stdout: string): string[] {
  const [count, ...lines] = stdout.split("\n");
  if (count === undefined || Number(count) !== lines.length) {
    throw new Error(`not ${PRINT_ARGV_PROGRAM}'s output: ${stdout}`);
  }
  return lines.map((hex) => Buffer.from(hex, "hex").toString("utf8"));
}

/**
 * Decodes the fake `sudo`'s log: one argv per call, oldest first.
 *
 * @param log - the log's text.
 * @returns each call's arguments.
 */
export function decodeSudoLog(log: string): string[][] {
  return log
    .split("\n")
    .filter((line) => line !== "")
    .map((line) =>
      line
        .split(":")
        .slice(1)
        .map((hex) => Buffer.from(hex, "hex").toString("utf8")),
    );
}

// ── Keys and processes ────────────────────────────────────────────────────────────────────────────

/** How many keys {@link generateParsableKeyPair} generates before giving up. */
export const KEY_ATTEMPTS = 10;

/**
 * An ed25519 key pair ssh2 can read back. ssh2 1.17's generator writes one it cannot parse about
 * once in 360 (`Malformed OpenSSH private key`, measured: 14 in 5,000) — a host key failing the
 * server's start, a client key failing every connection — so each is parsed and, if refused,
 * generated again.
 *
 * @param generate - the generator (ssh2's by default; a spec passes a broken one).
 * @param attempts - how many keys to try.
 * @returns the first pair whose private key parses.
 * @throws Error when none of `attempts` keys parsed.
 */
export function generateParsableKeyPair(
  generate: () => KeyPair = () => ssh2.utils.generateKeyPairSync("ed25519"),
  attempts: number = KEY_ATTEMPTS,
): KeyPair {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const pair = generate();
    if (!(ssh2.utils.parseKey(pair.private) instanceof Error)) return pair;
  }
  throw new Error(
    `ssh-server: none of ${String(attempts)} generated keys could be parsed back by ssh2.`,
  );
}

/**
 * Whether a process is gone: no such process, or a zombie — exited, never reaped — which `kill(pid,
 * 0)` still finds. A container without an init process (PID 1 a shell, not a reaper) keeps every
 * orphan's zombie (measured), so a killed command would otherwise look alive forever. Read with
 * `ps -o stat=` (procps on Linux, BSD on macOS: both print `Z…` for a zombie, nothing when absent).
 *
 * @param pid - the process.
 * @returns `true` when it no longer runs.
 */
export function processGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }
  let stat: string;
  try {
    stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    // `ps` exits 1 when no process matches: it ended between the two questions.
    return true;
  }
  return stat === "" || stat.startsWith("Z");
}

// ── The server ────────────────────────────────────────────────────────────────────────────────────

/** A running {@link startSshServer}. */
export interface SshTestServer {
  /** Where it listens, on `127.0.0.1`. */
  readonly port: number;
  /** The temporary folder holding everything below; gone once {@link close} resolves. */
  readonly base: string;
  /** The client's private key; any public key is accepted. */
  readonly keyPath: string;
  /** An existing folder standing in for the WordPress root. */
  readonly root: string;
  /** Each command's starting folder (the login's home) — where a missed `cd` would leave it. */
  readonly home: string;
  /** Every command line received, oldest first. */
  readonly commands: readonly string[];
  /** Every connection accepted, oldest first — what a spec disconnects. */
  readonly connections: readonly ServerConnection[];
  /**
   * Installs an executable `sh` script on the commands' `PATH`, ahead of the system's.
   *
   * @param name - the program's name.
   * @param body - the script after its `#!/bin/sh` line.
   */
  addProgram(name: string, body: string): void;
  /**
   * Removes a program {@link addProgram} installed, so the system's of that name is found again.
   *
   * @param name - the program's name.
   */
  removeProgram(name: string): void;
  /** Every call the fake `sudo` received, oldest first, as argv arrays. */
  sudoCalls(): string[][];
  /** Makes the fake `sudo` refuse every call (`true`) or run it (`false`, the default). */
  denySudo(deny: boolean): void;
  /**
   * An ssh transport for this server, rooted at {@link root}. Its host is never resolved: connect
   * through {@link steerNodeSsh}.
   *
   * @param overrides - fields to replace.
   */
  transport(overrides?: Partial<SshTransport>): SshTransport;
  /**
   * Ends every client connection (a connected client would otherwise keep the server open), kills
   * every command still running, stops listening and removes the temporary folder.
   */
  close(): Promise<void>;
}

/** The folders one server owns, all inside one temporary folder. */
interface Layout {
  readonly base: string;
  readonly bin: string;
  readonly home: string;
  readonly root: string;
  readonly keyPath: string;
  readonly sudoLog: string;
  readonly sudoDeny: string;
}

/**
 * Creates the server's folders, client key and fake programs; removes what it made if that fails.
 *
 * @param clientKey - the client's private key, written `0600`.
 * @param tempRoot - the folder to create the server's own in.
 * @returns where everything is; real paths, so a `pwd` matches them.
 */
function createLayout(clientKey: string, tempRoot: string): Layout {
  const base = realpathSync(mkdtempSync(join(tempRoot, "ssh-server-")));
  try {
    return populateLayout(base, clientKey);
  } catch (error) {
    removeTempDir(base);
    throw error;
  }
}

/**
 * Fills a fresh server folder: `bin/` with the fake programs (and a `dd` taking `conv=excl` where the
 * system's lacks it), `home/`, the root, the client key.
 *
 * @param base - the server's empty temporary folder.
 * @param clientKey - the client's private key, written `0600`.
 * @returns the layout.
 */
function populateLayout(base: string, clientKey: string): Layout {
  const layout: Layout = {
    base,
    bin: join(base, "bin"),
    home: join(base, "home"),
    root: join(base, "site root"),
    keyPath: join(base, "id"),
    sudoLog: join(base, "sudo.log"),
    sudoDeny: join(base, "sudo.deny"),
  };
  for (const dir of [layout.bin, layout.home, layout.root]) mkdirSync(dir);
  writeFileSync(layout.keyPath, clientKey, { mode: 0o600 });
  writeFileSync(layout.sudoLog, "");
  writeFileSync(join(layout.bin, "sudo"), FAKE_SUDO, { mode: 0o755 });
  writeFileSync(join(layout.bin, PRINT_ARGV_PROGRAM), PRINT_ARGV, {
    mode: 0o755,
  });
  // The identity probe writes with `dd conv=excl`, which BSD's `dd` lacks.
  installExclDd(layout.bin);
  return layout;
}

/**
 * Runs one command line with `sh -c` and relays its output, exit status or signal on `stream`.
 *
 * @param layout - the server's folders.
 * @param command - the line the client sent.
 * @param stream - the accepted channel.
 * @param running - the set of live commands, which this one joins until it ends.
 * @param timeoutMs - how long it may run before its group is killed.
 */
function runCommand(
  layout: Layout,
  command: string,
  stream: ExecStream,
  running: Set<ChildProcess>,
  timeoutMs: number,
): void {
  // Tethered: a killed worker cannot leave a command running (its own timer would die with it).
  const child = spawnTethered(command, [], {
    cwd: layout.home,
    output: "pipe",
    env: {
      PATH: `${layout.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
      HOME: layout.home,
      E2E_FAKE_SUDO_LOG: layout.sudoLog,
      E2E_FAKE_SUDO_DENY: layout.sudoDeny,
    },
  });
  running.add(child);
  const stop = (): void => {
    // Once it ended, its pid may be reused: never signalled again.
    if (running.has(child)) killTethered(child);
  };
  const timer = setTimeout(stop, timeoutMs);
  // The client went away (a cut link, a disposed connection): nobody is left to answer. The channel
  // emits `close` only once its incoming side is read to the end, which nothing else does: commands
  // get no input, so what the client sends (nothing) is drained here.
  stream.once("close", stop);
  stream.resume();
  child.stdout?.on("data", (chunk: Buffer) => {
    stream.write(chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stream.stderr.write(chunk);
  });
  child.on("error", (error) => {
    stream.stderr.write(`ssh-server: ${error.message}\n`);
  });
  child.on("close", (code, signal) => {
    clearTimeout(timer);
    // Anything it left running in the background goes with it.
    killTethered(child);
    running.delete(child);
    stream.exit(signal ?? code ?? 255);
    stream.end();
  });
}

/**
 * Answers an upload's open, write and close with real file operations; anything else ssh2 refuses
 * itself (`OP_UNSUPPORTED`). A path that cannot be opened answers `NO_SUCH_FILE` when a folder is
 * missing, `FAILURE` otherwise.
 *
 * @param sftp - the accepted session.
 */
function serveUploads(sftp: SftpSession): void {
  const { OK, FAILURE, NO_SUCH_FILE } = ssh2.utils.sftp.STATUS_CODE;
  const files = new Map<string, number>();
  let next = 0;
  sftp.on("OPEN", (reqid, filename, _flags, attrs) => {
    try {
      const fd = openSync(filename, "w", attrs.mode ?? 0o644);
      const handle = String(next++);
      files.set(handle, fd);
      sftp.handle(reqid, Buffer.from(handle));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      sftp.status(reqid, missing ? NO_SUCH_FILE : FAILURE);
    }
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const fd = files.get(handle.toString());
    let code = FAILURE;
    try {
      if (fd !== undefined) {
        writeSync(fd, data, 0, data.length, offset);
        code = OK;
      }
    } catch {
      // Answered FAILURE below.
    }
    sftp.status(reqid, code);
  });
  sftp.on("CLOSE", (reqid, handle) => {
    const fd = files.get(handle.toString());
    files.delete(handle.toString());
    if (fd !== undefined) closeSync(fd);
    sftp.status(reqid, fd === undefined ? FAILURE : OK);
  });
}

/** {@link startSshServer}'s options. */
export interface SshServerOptions {
  /** Each command's time limit ({@link COMMAND_TIMEOUT_MS} by default). */
  readonly commandTimeoutMs?: number;
  /** The port to listen on; `0` (the default) for a free one. */
  readonly port?: number;
  /**
   * The folder the server's temporary folder is made in: the system's by default. It must lie inside
   * the system's, the only place `removeTempDir` removes anything.
   */
  readonly tempRoot?: string;
}

/**
 * Starts an executing SSH server on `127.0.0.1`. Keys come first, so nothing is on disk until they
 * exist; a failure after that (the server refusing its key, the port taken) removes the temporary
 * folder before it is rethrown.
 *
 * @param options - see {@link SshServerOptions}.
 * @returns the server; `close` it in `afterAll`.
 * @throws Error when no key parses, or the server cannot start or listen.
 */
export async function startSshServer(
  options: SshServerOptions = {},
): Promise<SshTestServer> {
  const timeoutMs = options.commandTimeoutMs ?? COMMAND_TIMEOUT_MS;
  const hostKey = generateParsableKeyPair();
  const clientKey = generateParsableKeyPair();
  const layout = createLayout(clientKey.private, options.tempRoot ?? tmpdir());
  try {
    return await listen(layout, hostKey, options.port ?? 0, timeoutMs);
  } catch (error) {
    removeTempDir(layout.base);
    throw error;
  }
}

/**
 * Creates the ssh2 server over a ready layout and waits until it listens.
 *
 * @param layout - the server's folders.
 * @param hostKey - its host key.
 * @param port - where to listen; `0` for a free port.
 * @param timeoutMs - each command's time limit.
 * @returns the running server.
 * @throws Error when ssh2 refuses the key or the port cannot be listened on.
 */
async function listen(
  layout: Layout,
  hostKey: KeyPair,
  port: number,
  timeoutMs: number,
): Promise<SshTestServer> {
  const commands: string[] = [];
  const connections: ServerConnection[] = [];
  const running = new Set<ChildProcess>();

  const server = new ssh2.Server({ hostKeys: [hostKey.private] }, (conn) => {
    connections.push(conn);
    // Specs cut links on purpose; the server side has nothing to report.
    conn.on("error", () => undefined);
    conn.on("authentication", (context) => {
      if (context.method === "publickey") context.accept();
      else context.reject(["publickey"]);
    });
    conn.on("session", (accept) => {
      accept()
        .on("exec", (acceptExec, _reject, info) => {
          commands.push(info.command);
          runCommand(layout, info.command, acceptExec(), running, timeoutMs);
        })
        .on("sftp", (acceptSftp) => {
          serveUploads(acceptSftp());
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  return {
    port: server.address().port,
    base: layout.base,
    keyPath: layout.keyPath,
    root: layout.root,
    home: layout.home,
    commands,
    connections,
    addProgram(name, body) {
      writeFileSync(join(layout.bin, name), `#!/bin/sh\n${body}`, {
        mode: 0o755,
      });
    },
    removeProgram(name) {
      rmSync(join(layout.bin, name), { force: true });
    },
    sudoCalls: () => decodeSudoLog(readFileSync(layout.sudoLog, "utf8")),
    denySudo(deny) {
      if (deny) writeFileSync(layout.sudoDeny, "");
      else rmSync(layout.sudoDeny, { force: true });
    },
    transport: (overrides = {}) => ({
      mode: "ssh",
      host: "site.test",
      username: "tester",
      privateKeyPath: layout.keyPath,
      rootDir: layout.root,
      ...overrides,
    }),
    async close() {
      // A connected client keeps `server.close` waiting until it hangs up; ending each first sends
      // it a disconnect, which it answers by closing its side.
      for (const conn of connections) conn.end();
      for (const child of running) killTethered(child);
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      removeTempDir(layout.base);
    },
  };
}

// ── Steering node-ssh ─────────────────────────────────────────────────────────────────────────────

/** node-ssh's `connect`, typed here because the ssh2 types it is declared with do not resolve. */
type Connect = (
  this: NodeSSH,
  config: Record<string, unknown>,
) => Promise<NodeSSH>;

/**
 * Points every node-ssh connection at a local port, whatever port a transport declares; its host
 * is never resolved.
 *
 * @param target - called per connection: the port, plus any config to override (keepalives…).
 * @param seen - receives each config node-ssh was asked to connect with, before steering.
 * @returns a function restoring node-ssh's own `connect`.
 */
export function steerNodeSsh(
  target: () => { readonly port: number } & Record<string, unknown>,
  seen?: (config: Record<string, unknown>) => void,
): () => void {
  const prototype = NodeSSH.prototype as unknown as { connect: Connect };
  const original = prototype.connect;
  prototype.connect = function (config) {
    seen?.(config);
    return original.call(this, {
      ...config,
      host: "127.0.0.1",
      ...target(),
    });
  };
  return () => {
    prototype.connect = original;
  };
}
