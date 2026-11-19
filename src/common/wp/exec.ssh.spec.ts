import { test, expect } from "@playwright/test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";

import { NodeSSH, type Config, type SSHExecCommandOptions } from "node-ssh";

import {
  SSH_KEEPALIVE,
  copyIntoTarget,
  disposeConnections,
  exec,
  execElevated,
  failureReason,
  resetElevationCaches,
  shellQuote,
  sshCommandLine,
  sshExecFailure,
} from "./exec";
import { CommandKilledError } from "./errors";
import { HOSTILE_ARGUMENTS } from "../__fixtures__/hostile-arguments";
import {
  PRINT_ARGV_PROGRAM,
  decodeArgv,
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";

/**
 * The ssh transport: the command line it sends, and what happens when the connection breaks — under
 * a running command, or between two.
 *
 * Against an in-process ssh2 server that **runs** each command line with `sh -c`, reached through a
 * local proxy the test can cut or hold half-open, so nothing leaves the machine and the client side
 * is exactly the code the cells use. What is pinned is that every argument reaches the program as it
 * was given, that a working directory that cannot be entered runs nothing, that a connection lost
 * under a command is reported as that — never as a kill, and never as the worker dying of an
 * unhandled `error` event, an uncaught exception — and the difference between a dead connection
 * costing a scenario and costing a reconnect.
 */

let server: SshTestServer;
let proxy: net.Server;
/** Where node-ssh is steered to connect: the proxy, unless a test points it at a dead port. */
let connectPort: number;
/** The proxy's own port. */
let proxyPort: number;
/** While set, the proxy passes neither side's FIN on, so a half-closed link stays half-open. */
let holdFin = false;
/** Every client-facing socket the proxy accepted, newest last — what a test cuts. */
const links: net.Socket[] = [];
/** The proxy's server-facing sockets, closed with the links after each test. */
const upstreams: net.Socket[] = [];
/** Every config node-ssh was asked to connect with, newest last. */
const configs: Config[] = [];
/** The options of every `execCommand` the transport made, newest last. */
const execOptions: SSHExecCommandOptions[] = [];
/** Resolves the moment the client has a command's channel open — see {@link runningCommand}. */
let channelOpened: (() => void) | undefined;
/** While set, the probing the client is steered to use instead of the transport's own. */
let keepaliveOverride:
  { readonly intervalMs: number; readonly countMax: number } | undefined;
/**
 * What `afterAll` undoes, newest first; each step is pushed only once what it undoes exists, so a
 * failed `beforeAll` (which still runs `afterAll`) is not hidden behind a second error.
 */
const teardown: (() => void | Promise<void>)[] = [];

const { prototype } = NodeSSH;
// eslint-disable-next-line @typescript-eslint/unbound-method -- only ever called with `.call(this, …)`.
const originalExecCommand = prototype.execCommand;

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());

  // Half-open on both sides, and ends passed on by hand, so a test can hold one back.
  proxy = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({
      port: started.port,
      host: "127.0.0.1",
      allowHalfOpen: true,
    });
    client.pipe(upstream, { end: false });
    upstream.pipe(client, { end: false });
    client.on("end", () => {
      if (!holdFin) upstream.end();
    });
    upstream.on("end", () => {
      if (!holdFin) client.end();
    });
    const end = (): void => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", end);
    upstream.on("error", end);
    links.push(client);
    upstreams.push(upstream);
  });
  const listening = proxy;
  teardown.push(() => {
    listening.close();
  });
  await new Promise<void>((resolve) => {
    listening.listen(0, "127.0.0.1", resolve);
  });
  proxyPort = (listening.address() as net.AddressInfo).port;
  connectPort = proxyPort;

  const unsteer = steerNodeSsh(
    () => ({
      port: connectPort,
      ...(keepaliveOverride === undefined
        ? {}
        : {
            keepaliveInterval: keepaliveOverride.intervalMs,
            keepaliveCountMax: keepaliveOverride.countMax,
          }),
    }),
    (config) => configs.push(config),
  );
  teardown.push(unsteer);
  // node-ssh calls `onChannel` once the server has accepted the command: from then on, an error on
  // the connection is one under a running command.
  prototype.execCommand = function (
    this: NodeSSH,
    command: string,
    options: SSHExecCommandOptions = {},
  ) {
    execOptions.push(options);
    return originalExecCommand.call(this, command, {
      ...options,
      onChannel: () => {
        channelOpened?.();
      },
    });
  };
});

test.afterEach(() => {
  disposeConnections();
  server.refuseExec(false);
  server.dropOnExec(false);
  holdFin = false;
  keepaliveOverride = undefined;
  connectPort = proxyPort;
  for (const socket of [...links.splice(0), ...upstreams.splice(0)]) {
    socket.destroy();
  }
});

test.afterAll(async () => {
  prototype.execCommand = originalExecCommand;
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** A site on the ssh transport, rooted in the server's folder; its host is never resolved. */
const transport = (): ReturnType<SshTestServer["transport"]> =>
  server.transport();

/**
 * Starts a command that never answers, and resolves once its channel is open on the client.
 *
 * Earlier than that, a reset would land on a command not yet running, not the case the tests below
 * pin. The pending command is wrapped rather than returned, since an async function returning a
 * promise would wait for it — and it never settles on its own.
 */
async function runningCommand(): Promise<{
  readonly pending: Promise<unknown>;
}> {
  const open = new Promise<void>((resolve) => {
    channelOpened = resolve;
  });
  const pending = exec(transport(), "sleep", ["30"]);
  await open;
  return { pending };
}

/**
 * Leaves the pooled connection the way ssh2 leaves one after a server's disconnect: its own side
 * closed, the server's still open, and node-ssh still calling it connected — until the server's
 * FIN arrives, which the proxy holds back. Resolves once the client has closed its side.
 */
async function halfClose(): Promise<void> {
  holdFin = true;
  const link = links.at(-1);
  const closed = new Promise<void>((resolve) => link?.once("end", resolve));
  server.connections.at(-1)?.end();
  await closed;
}

/**
 * Makes the newest link go silent both ways — nothing reset, nothing delivered — the way a proxy
 * that stopped forwarding does. What either side sends from then on is discarded.
 */
function silence(): void {
  for (const socket of [links.at(-1), upstreams.at(-1)]) {
    socket?.unpipe();
    socket?.on("data", () => undefined);
  }
}

/** A local port nothing listens on — found by listening on one and letting it go. */
async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => {
    probe.listen(0, "127.0.0.1", resolve);
  });
  const { port } = probe.address() as net.AddressInfo;
  await new Promise<void>((resolve) => {
    probe.close(() => {
      resolve();
    });
  });
  return port;
}

test("a reset under a running command fails that command, naming the lost connection", async () => {
  const { pending } = await runningCommand();
  links.at(-1)?.resetAndDestroy();

  // Unhandled, the same reset is an uncaught exception that ends the whole worker process.
  await expect(pending).rejects.toThrow(
    /the connection to tester@site\.test was lost \(read ECONNRESET\) while "sleep" was running/,
  );
});

test("the next command opens a fresh connection instead of reusing the lost one", async () => {
  const { pending } = await runningCommand();
  links.at(-1)?.resetAndDestroy();
  await pending.catch(() => undefined);

  const opened = configs.length;
  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("again");
  expect(configs.length).toBe(opened + 1);
});

// ssh2 refuses every request on such a connection before sending it, while node-ssh still reports
// it connected; left to that refusal, a live run lost a scenario.
test("a command on a connection ssh2 has half-closed runs on a new one instead of being refused", async () => {
  await exec(transport(), "echo", ["first"]);
  await halfClose();
  const opened = configs.length;

  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("again");
  expect(configs.length).toBe(opened + 1);
});

test("an upload over a connection ssh2 has half-closed goes through on a new one", async () => {
  const local = join(server.home, "runner-plugin.zip");
  const target = join(server.root, "plugin.zip");
  writeFileSync(local, "zip bytes");
  await exec(transport(), "echo", ["first"]);
  await halfClose();
  const opened = configs.length;

  await copyIntoTarget(transport(), local, target);

  expect(readFileSync(target, "utf8")).toBe("zip bytes");
  expect(configs.length).toBe(opened + 1);
});

// ssh2's own reason names neither the site nor the step, and is all a scenario's report would show.
test("a connection that cannot be opened fails naming the site it was for", async () => {
  connectPort = await closedPort();

  await expect(exec(transport(), "echo", ["unreachable"])).rejects.toThrow(
    /\[wp\/exec\] could not connect to tester@site\.test: connect ECONNREFUSED/,
  );
});

// A link that goes silent is never reset, so only probing notices it; unprobed, a command on it
// waits indefinitely. The probing is shortened here so the mechanism — ssh2's own probes going
// unanswered, and the transport turning that into the command's failure — runs in well under a
// second rather than the production forty; the test below pins the production values.
test("a link that goes silent under a running command fails that command once its probes go unanswered", async () => {
  keepaliveOverride = { intervalMs: 100, countMax: 2 };
  const { pending } = await runningCommand();
  silence();

  await expect(pending).rejects.toThrow(
    /the connection to tester@site\.test was lost \(Keepalive timeout\) while "sleep" was running/,
  );
});

// The argv carries what must never reach a report — a `--key=` value, a snippet's embedded values.
test("a command killed by a signal names the program and the signal, never its arguments", async () => {
  server.addProgram("kill-me", "kill -TERM $$\n");
  const failure = exec(transport(), "kill-me", ["--key=SECRET-ssh-planted"]);

  await expect(failure).rejects.toThrow(
    '[wp/exec] "kill-me" on tester@site.test was terminated by signal SIGTERM before exiting.',
  );
  await expect(failure).rejects.not.toThrow(/SECRET/);
});

// `exec` leaves no shell to turn the signal into an exit status 128 + n: the kill is the command's,
// typed as on every other transport, which is what lets the debug log fall back to a direct read.
test("a command killed by a signal is a CommandKilledError carrying the signal", async () => {
  server.addProgram("crash-me", "kill -SEGV $$\n");

  const error: unknown = await exec(transport(), "crash-me", []).catch(
    (caught: unknown) => caught,
  );

  expect(error).toBeInstanceOf(CommandKilledError);
  expect((error as CommandKilledError).signal).toBe("SIGSEGV");
});

// ssh2's reason is all there is to go on; the argv carries what must never reach a report.
test("a command the server refuses to run names the program and the reason, never its arguments", async () => {
  await exec(transport(), "echo", ["warm"]);
  server.refuseExec(true);
  const opened = configs.length;
  const sent = server.commands.length;

  const error: unknown = await exec(transport(), "wp", [
    "--key=SECRET-ssh-planted",
  ]).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(CommandKilledError);
  expect((error as Error).message).toBe(
    '[wp/exec] "wp" could not run over SSH on tester@site.test: Unable to exec.',
  );
  expect((error as Error).cause).toBeUndefined();
  expect(String((error as Error).stack)).not.toContain("SECRET");
  // Refused, not lost: no second connection, no second try.
  expect(configs.length).toBe(opened);
  expect(server.commands.length).toBe(sent);
});

test("a refused command leaves the connection usable for the next one", async () => {
  await exec(transport(), "echo", ["warm"]);
  server.refuseExec(true);
  await exec(transport(), "echo", ["refused"]).catch(() => undefined);
  server.refuseExec(false);
  const opened = configs.length;

  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("again");
  expect(configs.length).toBe(opened);
});

// ssh2 fails the pending request as `Unable to exec`, a refusal's words, yet the command line had
// gone out: the server may have started it. "Could not run" would tell an operator nothing happened.
test("a connection closed before the server confirms a command started says whether it ran is unknown", async () => {
  await exec(transport(), "echo", ["warm"]);
  server.dropOnExec(true);
  const opened = configs.length;
  const sent = server.commands.length;

  const error: unknown = await exec(transport(), "wp", [
    "--key=SECRET-ssh-planted",
  ]).catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(CommandKilledError);
  expect((error as Error).message).toBe(
    '[wp/exec] the connection to tester@site.test closed before "wp" was confirmed started ' +
      "(Unable to exec), so whether it ran is unknown.",
  );
  expect((error as Error).cause).toBeUndefined();
  expect(String((error as Error).stack)).not.toContain("SECRET");
  // Sent once, never retried: a second try could run it twice.
  expect(server.commands.length).toBe(sent + 1);
  expect(configs.length).toBe(opened);
});

test("a connection closed before a command was confirmed started leaves the next command a new one", async () => {
  await exec(transport(), "echo", ["warm"]);
  server.dropOnExec(true);
  await exec(transport(), "echo", ["dropped"]).catch(() => undefined);
  server.dropOnExec(false);
  const opened = configs.length;

  const result = await exec(transport(), "echo", ["again"]);

  expect(result.stdout).toBe("again");
  expect(configs.length).toBe(opened + 1);
});

test("a lost connection is not a CommandKilledError", async () => {
  const { pending } = await runningCommand();
  links.at(-1)?.resetAndDestroy();

  const error: unknown = await pending.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(CommandKilledError);
});

// node-ssh answers neither a status nor a signal when its own connection is disposed under a command.
test("a command whose connection is disposed under it fails, but not as a kill", async () => {
  const { pending } = await runningCommand();

  disposeConnections();
  const error: unknown = await pending.catch((caught: unknown) => caught);

  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(CommandKilledError);
  expect((error as Error).message).toBe(
    '[wp/exec] "sleep" on tester@site.test ended with neither an exit status nor a signal (its channel ' +
      "closed), so how it ended is unknown.",
  );
});

// Sent, it would arrive as U+FFFD (measured): a different argument, silently.
test("an argument holding a lone surrogate is refused before anything is sent", async () => {
  const opened = configs.length;
  const sent = server.commands.length;

  await expect(exec(transport(), "echo", ["a\udfffb"])).rejects.toThrow(
    '[wp/exec] refusing to run "echo": argument 1 is not well-formed text (a lone surrogate), ' +
      "which no program can be handed.",
  );
  expect(configs.length).toBe(opened);
  expect(server.commands.length).toBe(sent);
});

// Refused before a connection is even opened, in the words every transport uses.
test("an argument holding a NUL byte is refused before anything is sent", async () => {
  const opened = configs.length;

  await expect(
    exec(transport(), "echo", ["--key=SECRET-ssh-planted\0x"]),
  ).rejects.toThrow(
    '[wp/exec] refusing to run "echo": argument 1 holds a NUL byte, which no program can be handed.',
  );
  expect(configs.length).toBe(opened);
});

test("every connection is opened with the probing that gives a silent link up within a minute", async () => {
  await exec(transport(), "echo", ["probe"]);

  expect(configs.at(-1)).toMatchObject({
    keepaliveInterval: SSH_KEEPALIVE.intervalMs,
    keepaliveCountMax: SSH_KEEPALIVE.countMax,
  });
  expect(
    SSH_KEEPALIVE.intervalMs * (SSH_KEEPALIVE.countMax + 1),
  ).toBeLessThanOrEqual(60_000);
});

// ── What a rejected execCommand becomes ─────────────────────────────────────────────────────────

test.describe("sshExecFailure", () => {
  // Never connected — what a closed connection looks like to node-ssh — and no loss recorded for it.
  const closed = new NodeSSH();
  // A live connection, as far as the check reads one: a rejection on it is the server's refusal.
  const live = Object.assign(new NodeSSH(), { isConnected: () => true });

  test("ssh2's refusal of a request on a dead socket is passed on as it is, for the retry", () => {
    const refusal = new Error("Not connected");

    expect(sshExecFailure(closed, transport(), "wp", refusal)).toBe(refusal);
    expect(sshExecFailure(live, transport(), "wp", refusal)).toBe(refusal);
  });

  test("a rejection on a live connection names the program and the reason, with no cause", () => {
    const failure = sshExecFailure(
      live,
      transport(),
      "wp",
      new Error("Unable to exec"),
    ) as Error;

    expect(failure.message).toBe(
      '[wp/exec] "wp" could not run over SSH on tester@site.test: Unable to exec.',
    );
    expect(failure.cause).toBeUndefined();
  });

  test("a rejection on a closed connection says whether the program ran is unknown, with no cause", () => {
    const failure = sshExecFailure(
      closed,
      transport(),
      "wp",
      new Error("Unable to exec"),
    ) as Error;

    expect(failure.message).toBe(
      '[wp/exec] the connection to tester@site.test closed before "wp" was confirmed started ' +
        "(Unable to exec), so whether it ran is unknown.",
    );
    expect(failure.cause).toBeUndefined();
  });

  test("a closed connection's reason is its code, never a message that could quote an argument", () => {
    const failure = sshExecFailure(
      closed,
      transport(),
      "wp",
      Object.assign(new Error("--key=SECRET"), { code: "ECONNABORTED" }),
    ) as Error;

    expect(failure.message).toContain("(ECONNABORTED)");
    expect(failure.message).not.toContain("SECRET");
  });

  // ssh2 sends the command line only once the channel is open; a close before that is this error.
  test("a channel still opening when the connection closed could not run: nothing was sent", () => {
    const failure = sshExecFailure(
      closed,
      transport(),
      "wp",
      new Error("No response from server"),
    ) as Error;

    expect(failure.message).toBe(
      '[wp/exec] "wp" could not run over SSH on tester@site.test: No response from server.',
    );
    expect(failure.cause).toBeUndefined();
  });
});

test.describe("failureReason", () => {
  /** An Error carrying `code`, as ssh2's and node-ssh's do. */
  const coded = (message: string, code: unknown): Error =>
    Object.assign(new Error(message), { code });

  const cases: readonly (readonly [string, unknown, string])[] = [
    [
      "a string code wins over the message",
      coded("--key=SECRET", "ETIMEDOUT"),
      "ETIMEDOUT",
    ],
    ["no code: the message", new Error("Unable to exec"), "Unable to exec"],
    [
      "an empty code: the message",
      coded("Unable to exec", ""),
      "Unable to exec",
    ],
    [
      "a numeric code (SFTP's): the message",
      coded("No such file", 2),
      "No such file",
    ],
    [
      "no code and no message: the error's name",
      new RangeError(""),
      "RangeError",
    ],
    [
      "a thrown non-Error: never its text",
      "--key=SECRET",
      "a non-Error value was thrown",
    ],
  ];
  for (const [name, error, reason] of cases) {
    test(name, () => {
      expect(failureReason(error)).toBe(reason);
    });
  }
});

// ── The command line ─────────────────────────────────────────────────────────────────────────────

test.describe("shellQuote", () => {
  const big = "A".repeat(64 * 1024);
  const cases: readonly (readonly [string, string, string])[] = [
    ["an empty argument stays one", "", "''"],
    ["a single quote closes, escapes and reopens", "it's", `'it'\\''s'`],
    ["only quotes", "''", `''\\'''\\'''`],
    ["a newline is kept literally", "a\nb", "'a\nb'"],
    ["a carriage return is kept literally", "a\rb", "'a\rb'"],
    ["a tab is kept literally", "a\tb", "'a\tb'"],
    ["a dollar expands nothing", "$HOME $(id)", "'$HOME $(id)'"],
    ["a backtick runs nothing", "`id`", "'`id`'"],
    ["an option-like word is just quoted", "-x", "'-x'"],
    ["a double dash is just quoted", "--", "'--'"],
    ["unicode passes through", "café ✓ 日本", "'café ✓ 日本'"],
    ["a 64 KiB word is one word", big, `'${big}'`],
  ];
  for (const [name, input, expected] of cases) {
    test(name, () => {
      expect(shellQuote(input)).toBe(expected);
    });
  }
});

test("the command line changes into the folder, then replaces the shell with the quoted command", () => {
  expect(sshCommandLine("/var/www/my site", "wp", ["option", "get", ""])).toBe(
    "cd -- '/var/www/my site' && exec 'wp' 'option' 'get' ''",
  );
});

test.describe("sshCommandLine refuses a line that would not mean what it says", () => {
  // `cd -- ''` succeeds and changes nothing (bash 5.2 and dash), so the command would run in the
  // login's home; a relative one resolves from there, or through CDPATH.
  const notAbsolute: readonly (readonly [string, string])[] = [
    ["an empty working directory", ""],
    ["a relative working directory", "var/www/site"],
    ["a dot", "."],
    ["a tilde, which a quoted word never expands", "~/site"],
  ];
  for (const [name, cwd] of notAbsolute) {
    test(name, () => {
      expect(() => sshCommandLine(cwd, "wp", ["--key=SECRET"])).toThrow(
        `[wp/exec] refusing to run "wp" over ssh: its working directory ${JSON.stringify(cwd)} is ` +
          "not an absolute path, which `cd` would resolve from the login's home.",
      );
    });
  }

  // bash reads `exec -x` as an option; dash's `exec` takes no `--` at all (both measured).
  test("a program whose name begins with a dash", () => {
    expect(() => sshCommandLine("/", "-weird", ["--key=SECRET"])).toThrow(
      '[wp/exec] refusing to run "-weird" over ssh: a program name beginning with "-" would be ' +
        "read as an option to the shell's `exec`.",
    );
  });

  test("a dash inside a program's name or an argument is fine", () => {
    expect(sshCommandLine("/", "e2e-print-argv", ["-n", "--"])).toBe(
      "cd -- '/' && exec 'e2e-print-argv' '-n' '--'",
    );
  });
});

test("an empty working directory runs nothing, and nothing is sent", async () => {
  const sent = server.commands.length;

  await expect(
    exec(transport(), "touch", ["marker"], { cwd: "" }),
  ).rejects.toThrow(/its working directory "" is not an absolute path/);
  expect(server.commands.length).toBe(sent);
  expect(existsSync(join(server.home, "marker"))).toBe(false);
});

test("a site whose root is relative runs nothing, and nothing is sent", async () => {
  const sent = server.commands.length;

  await expect(
    exec(server.transport({ rootDir: "site root" }), "pwd", []),
  ).rejects.toThrow(
    /its working directory "site root" is not an absolute path/,
  );
  expect(server.commands.length).toBe(sent);
});

test("every argument, empty and hostile ones included, reaches the program exactly as given", async () => {
  const result = await exec(transport(), PRINT_ARGV_PROGRAM, [
    ...HOSTILE_ARGUMENTS,
  ]);

  expect(result.exitCode).toBe(0);
  expect(decodeArgv(result.stdout)).toEqual(HOSTILE_ARGUMENTS);
});

test("an empty argument keeps its place among the others", async () => {
  const result = await exec(transport(), PRINT_ARGV_PROGRAM, [
    "option",
    "update",
    "x",
    "",
  ]);

  expect(decodeArgv(result.stdout)).toEqual(["option", "update", "x", ""]);
});

test("an elevated command reaches sudo, and through it the program, with every argument intact", async () => {
  resetElevationCaches();
  const args = ["", "a b", "$(id)", "-n"];

  const result = await execElevated(transport(), PRINT_ARGV_PROGRAM, args);

  expect(decodeArgv(result.stdout)).toEqual(args);
  expect(server.sudoCalls().at(-1)).toEqual([
    "-n",
    "--",
    PRINT_ARGV_PROGRAM,
    ...args,
  ]);
});

test("a command runs in the WordPress root, a folder whose name holds a space", async () => {
  const result = await exec(transport(), "pwd", []);

  expect(result.stdout).toBe(server.root);
});

test("a command given its own working directory runs there", async () => {
  const result = await exec(transport(), "pwd", [], { cwd: server.home });

  expect(result.stdout).toBe(server.home);
});

test("a working directory that does not exist runs nothing and fails with the shell's reason", async () => {
  const marker = join(server.home, "ran-anyway");
  const missing = join(server.root, "no such folder");

  const result = await exec(transport(), "touch", [marker], { cwd: missing });

  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("no such folder");
  expect(existsSync(marker)).toBe(false);
});

test("a missing WordPress root runs nothing in the login's home", async () => {
  const before = readdirSync(server.home);
  const site = server.transport({ rootDir: join(server.root, "gone") });

  const result = await exec(site, "touch", ["relative-marker"]);

  expect(result.exitCode).not.toBe(0);
  expect(readdirSync(server.home)).toEqual(before);
});

test("the program's name is quoted too, so it can never run anything else", async () => {
  const result = await exec(transport(), "$(touch injected)", []);

  expect(result.exitCode).toBe(127);
  expect(existsSync(join(server.root, "injected"))).toBe(false);
});

test("a program whose name holds a space runs by that name", async () => {
  server.addProgram("odd name", "echo ran\n");

  const result = await exec(transport(), "odd name", []);

  expect(result).toEqual({ stdout: "ran", stderr: "", exitCode: 0 });
});

test("the exit status is the program's own, and output keeps its surrounding whitespace", async () => {
  const result = await exec(transport(), "sh", [
    "-c",
    "printf '  out  \\n'; printf '  err  \\n' >&2; exit 3",
  ]);

  expect(result).toEqual({ stdout: "  out  ", stderr: "  err  ", exitCode: 3 });
});

test("a program that is not installed exits 127", async () => {
  const result = await exec(transport(), "e2e-no-such-program", []);

  expect(result.exitCode).toBe(127);
});

test("node-ssh is sent the whole command line and left to change no folder of its own", async () => {
  await exec(transport(), "true", ["a b"]);

  expect(server.commands.at(-1)).toBe(
    `cd -- ${shellQuote(server.root)} && exec 'true' 'a b'`,
  );
  expect(execOptions.at(-1)?.cwd).toBeUndefined();
});

// The transport collects the chunks itself: a copy node-ssh kept as strings would be decoded chunk
// by chunk, trimmed at both ends, and could be refused as too large to return.
test("node-ssh is asked to keep no output of its own and to trim nothing", async () => {
  const result = await exec(transport(), "printf", ["  a\\n  "]);

  expect(result.stdout).toBe("  a\n  ");
  expect(execOptions.at(-1)).toMatchObject({ noBuffer: true, noTrim: true });
});

// The twins share a host and differ by port, so a declared port must reach node-ssh, and an
// undeclared one must leave node-ssh's own default (22) alone.
test("a declared port is what node-ssh connects to; without one, node-ssh is given none", async () => {
  await exec({ ...transport(), port: 2210 }, "true", []);
  expect(configs.at(-1)?.port).toBe(2210);

  await exec(transport(), "true", []);
  expect(configs.at(-1)).not.toHaveProperty("port");
});

// One host serves both twins: a message naming only the host would not say which site failed.
test.describe("a declared port is named wherever the site is", () => {
  test("a connection that cannot be opened names user@host:port", async () => {
    connectPort = await closedPort();

    await expect(
      exec({ ...transport(), port: 2210 }, "echo", ["unreachable"]),
    ).rejects.toThrow(
      /\[wp\/exec\] could not connect to tester@site\.test:2210: connect ECONNREFUSED/,
    );
  });

  test("a killed command names user@host:port", async () => {
    server.addProgram("kill-me", "kill -TERM $$\n");

    await expect(
      exec({ ...transport(), port: 2210 }, "kill-me", []),
    ).rejects.toThrow(
      '[wp/exec] "kill-me" on tester@site.test:2210 was terminated by signal SIGTERM before exiting.',
    );
  });

  // The scp form (`user@host:"path"`) has no room for a port, so it follows the path.
  test("a failed upload keeps the scp form and names the port after it", async () => {
    const local = join(server.home, "runner-upload.zip");
    const target = join(server.root, "no such folder", "plugin.zip");
    writeFileSync(local, "zip bytes");

    await expect(
      copyIntoTarget({ ...transport(), port: 2210 }, local, target),
    ).rejects.toThrow(
      `[wp/exec] could not upload "${local}" to tester@site.test:"${target}" (port 2210).`,
    );
    await expect(copyIntoTarget(transport(), local, target)).rejects.toThrow(
      `[wp/exec] could not upload "${local}" to tester@site.test:"${target}".`,
    );
  });
});
