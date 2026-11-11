import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeSSH } from "node-ssh";

import { copyIntoTarget, disposeConnections, exec } from "../wp/exec";
import {
  KEY_ATTEMPTS,
  decodeArgv,
  decodeSudoLog,
  generateParsableKeyPair,
  PRINT_ARGV_PROGRAM,
  processGone,
  startSshServer,
  steerNodeSsh,
  type KeyPair,
  type SshTestServer,
} from "./ssh-server";

/**
 * The executing SSH server later specs lean on: its fake `sudo`, its keys, and that it never leaves a
 * process or a folder behind — whether a command ends, its client goes away, the server closes under
 * it, or the server never started.
 */

let server: SshTestServer;
/** Where node-ssh is steered: this file's server unless a test points it at its own. */
let port: number;
/**
 * What `afterAll` undoes, newest first; each step is pushed only once what it undoes exists, so a
 * failed `beforeAll` (which still runs `afterAll`) is not hidden behind a second error.
 */
const teardown: (() => void | Promise<void>)[] = [];

test.beforeAll(async () => {
  const started = await startSshServer({ commandTimeoutMs: 1_000 });
  server = started;
  port = started.port;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port })));
});

test.afterEach(() => {
  disposeConnections();
  server.denySudo(false);
  port = server.port;
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * A process's `ps` state, read independently of {@link processGone}.
 *
 * @param pid - the process.
 * @returns e.g. `S`, `Z+`; empty when there is none.
 */
function psStat(pid: number): string {
  try {
    return execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * Starts a command that writes its pid, then runs until killed; resolves once the pid is written.
 *
 * @param on - the server it runs on.
 * @returns the command's outcome (its rejection caught) and its pid.
 */
async function longCommand(
  on: SshTestServer,
): Promise<{ readonly pending: Promise<unknown>; readonly pid: number }> {
  const pidFile = join(on.home, "long.pid");
  const pending = exec(on.transport(), "sh", [
    "-c",
    `echo $$ > '${pidFile}.tmp' && mv '${pidFile}.tmp' '${pidFile}' && exec sleep 30`,
  ]).catch((error: unknown) => error);
  await expect.poll(() => existsSync(pidFile), { timeout: 5_000 }).toBe(true);
  return { pending, pid: Number(readFileSync(pidFile, "utf8")) };
}

test("the fake sudo records the call and runs the command after --, skipping -u and -g", async () => {
  const before = server.sudoCalls().length;

  const result = await exec(server.transport(), "sudo", [
    "-n",
    "-u",
    "www-data",
    "-g",
    "www-data",
    "--",
    PRINT_ARGV_PROGRAM,
    "",
    "a b",
  ]);

  expect(decodeArgv(result.stdout)).toEqual(["", "a b"]);
  expect(server.sudoCalls().slice(before)).toEqual([
    [
      "-n",
      "-u",
      "www-data",
      "-g",
      "www-data",
      "--",
      PRINT_ARGV_PROGRAM,
      "",
      "a b",
    ],
  ]);
});

test("the fake sudo exports the -u and -g values it was given to the command it runs", async () => {
  const asked = await exec(server.transport(), "sudo", [
    "-n",
    "-u",
    "#33",
    "-g",
    "www data",
    "--",
    "sh",
    "-c",
    'printf "%s|%s" "$E2E_FAKE_SUDO_USER" "$E2E_FAKE_SUDO_GROUP"',
  ]);
  const plain = await exec(server.transport(), "sh", [
    "-c",
    'printf "%s|%s" "${E2E_FAKE_SUDO_USER-unset}" "${E2E_FAKE_SUDO_GROUP-unset}"',
  ]);

  expect(asked.stdout).toBe("#33|www data");
  expect(plain.stdout).toBe("unset|unset");
});

test("the commands' dd takes conv=excl, whatever the runner's own dd is", async () => {
  const path = join(server.root, "excl-check");
  const write = () =>
    exec(server.transport(), "sh", [
      "-c",
      'printf x | dd of="$1" conv=excl status=none',
      "sh",
      path,
    ]);
  try {
    await expect(write()).resolves.toMatchObject({ exitCode: 0 });
    await expect(write()).resolves.toMatchObject({ exitCode: 1 });
  } finally {
    rmSync(path, { force: true });
  }
});

test("a denied fake sudo refuses the way sudo -n without a rule does, running nothing", async () => {
  server.denySudo(true);
  const marker = join(server.home, "ran-as-root");

  const result = await exec(server.transport(), "sudo", [
    "-n",
    "--",
    "touch",
    marker,
  ]);

  expect(result).toEqual({
    stdout: "",
    stderr: "sudo: a password is required",
    exitCode: 1,
  });
  expect(existsSync(marker)).toBe(false);
});

test("a command's background processes are killed once it ends", async () => {
  const pidFile = join(server.home, "background.pid");

  await exec(server.transport(), "sh", [
    "-c",
    `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`,
  ]);

  const pid = Number(readFileSync(pidFile, "utf8"));
  await expect.poll(() => processGone(pid), { timeout: 2_000 }).toBe(true);
});

test("a command past its time limit is killed, and reported so", async () => {
  await expect(exec(server.transport(), "sleep", ["30"])).rejects.toThrow(
    /terminated by signal SIGKILL/,
  );
});

// Its own server, whose time limit (20 s) is far past the wait: only the closed channel can kill it.
test("a command whose client goes away is killed, long before its time limit", async () => {
  const own = await startSshServer();
  try {
    port = own.port;
    const { pending, pid } = await longCommand(own);

    disposeConnections();

    expect(await pending).toBeInstanceOf(Error);
    await expect.poll(() => processGone(pid), { timeout: 2_000 }).toBe(true);
  } finally {
    await own.close();
  }
});

test("closing the server mid-command, its client still connected, kills the command and removes its folder", async () => {
  const own = await startSshServer();
  port = own.port;
  const { pending, pid } = await longCommand(own);

  await own.close();

  expect(processGone(pid)).toBe(true);
  expect(existsSync(own.base)).toBe(false);
  expect(await pending).toBeInstanceOf(Error);
});

// node-ssh keeps its connection open between commands: `close` must not wait for it to hang up.
test("closing the server with an idle client still connected ends that connection", async () => {
  const own = await startSshServer();
  port = own.port;
  await exec(own.transport(), "true", []);

  await own.close();

  expect(existsSync(own.base)).toBe(false);
});

// The transport always `cd`s first; a line without one shows where a missed `cd` would leave a command.
test("a command line that changes no folder runs in the login's home, not the root", async () => {
  const ssh = await new NodeSSH().connect({
    host: "site.test",
    username: "tester",
    privateKeyPath: server.keyPath,
  });
  try {
    expect((await ssh.execCommand("pwd")).stdout).toBe(server.home);
  } finally {
    ssh.dispose();
  }
});

// No mode is sent with an upload (ssh2's fastPut): the file is created 0644 under the umask, as
// OpenSSH creates it from 0666 under a 022 umask.
test("an upload writes the file's bytes, created 0644 under this process's umask", async () => {
  const local = join(server.home, "upload-source");
  const reference = join(server.home, "reference");
  const target = join(server.root, "uploaded");
  writeFileSync(local, "zip bytes", { mode: 0o600 });
  writeFileSync(reference, "", { mode: 0o644 });

  await copyIntoTarget(server.transport(), local, target);

  expect(readFileSync(target, "utf8")).toBe("zip bytes");
  expect(statSync(target).mode & 0o777).toBe(statSync(reference).mode & 0o777);
});

test("the argv printer's output is refused when its count disagrees with its lines", () => {
  expect(decodeArgv("2\n61\n62")).toEqual(["a", "b"]);
  expect(() => decodeArgv("2\n61")).toThrow(/not e2e-print-argv's output/);
  expect(() => decodeArgv("1\n61\n62")).toThrow(/not e2e-print-argv's output/);
});

test("the sudo log decodes empty and multi-byte arguments, one call per line", () => {
  const hex = (text: string): string => Buffer.from(text).toString("hex");

  expect(decodeSudoLog(`:${hex("-n")}:\n:${hex("é ✓")}\n\n`)).toEqual([
    ["-n", ""],
    ["é ✓"],
  ]);
});

test("a program an earlier step added can be removed, so the system's is found again", async () => {
  server.addProgram("printf", "echo fake\n");
  expect((await exec(server.transport(), "printf", ["real"])).stdout).toBe(
    "fake",
  );

  server.removeProgram("printf");

  expect((await exec(server.transport(), "printf", ["real"])).stdout).toBe(
    "real",
  );
});

test.describe("keys", () => {
  // ssh2 1.17 wrote an unparsable key about once in 360: unfiltered, 2,000 all but surely hit one.
  test("2,000 generated pairs all parse back, so neither the server nor a client fails on one", () => {
    for (let index = 0; index < 2_000; index++) {
      expect(generateParsableKeyPair().private).toContain(
        "BEGIN OPENSSH PRIVATE KEY",
      );
    }
  });

  test("an unparsable key is generated again, and the parsable one returned", () => {
    const good = generateParsableKeyPair();
    const keys: KeyPair[] = [
      { private: "not a key", public: "" },
      { private: good.private.replace(/[A-Za-z]/g, "A"), public: "" },
      good,
    ];
    let calls = 0;

    const pair = generateParsableKeyPair(() => {
      const next = keys[calls++];
      if (next === undefined) throw new Error("asked once too often");
      return next;
    });

    expect(pair).toBe(good);
    expect(calls).toBe(3);
  });

  test("a generator that never yields a parsable key fails after its bounded attempts", () => {
    let calls = 0;

    expect(() =>
      generateParsableKeyPair(() => {
        calls++;
        return { private: "never a key", public: "" };
      }),
    ).toThrow(
      `ssh-server: none of ${String(KEY_ATTEMPTS)} generated keys could be parsed back by ssh2.`,
    );
    expect(calls).toBe(KEY_ATTEMPTS);
  });
});

test("a server's temporary folder is made where it is told", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ssh-server-root-"));
  try {
    const own = await startSshServer({ tempRoot });
    expect(readdirSync(tempRoot)).toHaveLength(1);
    expect(own.base).toBe(
      join(realpathSync(tempRoot), readdirSync(tempRoot)[0] ?? ""),
    );
    await own.close();
    expect(readdirSync(tempRoot)).toEqual([]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a server that cannot listen fails its start, and leaves no temporary folder", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "ssh-server-root-"));
  const taken = net.createServer();
  await new Promise<void>((resolve) => {
    taken.listen(0, "127.0.0.1", resolve);
  });
  try {
    const { port: busy } = taken.address() as net.AddressInfo;

    await expect(startSshServer({ port: busy, tempRoot })).rejects.toThrow(
      /EADDRINUSE/,
    );

    expect(readdirSync(tempRoot)).toEqual([]);
  } finally {
    taken.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test.describe("processGone", () => {
  test("a running process is not gone; one that exited and was reaped is", async () => {
    const child = spawn("sleep", ["30"], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("sleep did not start");
    expect(processGone(pid)).toBe(false);

    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;

    expect(processGone(pid)).toBe(true);
  });

  // `sleep 0`'s parent becomes `sleep 30` (the shell `exec`s it), which never reaps a child: the
  // shape every orphan takes in a container whose PID 1 is not an init.
  test("a zombie, which kill(pid, 0) still finds, is gone", async () => {
    const parent = spawn("sh", ["-c", "sleep 0 & echo $!; exec sleep 30"], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      const zombie = Number(
        await new Promise<string>((resolve) =>
          parent.stdout.once("data", (chunk: Buffer) => {
            resolve(chunk.toString().trim());
          }),
        ),
      );
      await expect
        .poll(() => psStat(zombie).startsWith("Z"), { timeout: 5_000 })
        .toBe(true);

      expect(() => process.kill(zombie, 0)).not.toThrow();
      expect(processGone(zombie)).toBe(true);
    } finally {
      if (parent.pid !== undefined) process.kill(-parent.pid, "SIGKILL");
    }
  });

  test("a pid no process holds is gone", () => {
    // Past every platform's pid limit (Linux: 2^22; macOS: 99,999).
    expect(processGone(2 ** 22 + 1)).toBe(true);
  });
});
