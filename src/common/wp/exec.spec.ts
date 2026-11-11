import { test, expect } from "@playwright/test";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  copyIntoTarget,
  dockerArgv,
  dockerCpArgv,
  elevationSupport,
  exec,
  execElevated,
  describeTarget,
  installKey,
  resetElevationCaches,
  sudoArgv,
  targetKey,
  whyItDidNotExit,
  wpRootDir,
} from "./exec";
import { CommandKilledError } from "./errors";
import type {
  DockerTransport,
  LocalTransport,
  SshTransport,
} from "../config/types";

// The transfer primitive and the WP-root resolution are exercised on the `local` transport
// (a real filesystem) and, for `docker`, through the pure argv builder — `docker cp` itself
// needs a running daemon, so it is verified against a real container instead of here.

let workDir: string;
let local: LocalTransport;

test.beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "wp-exec-"));
  local = { mode: "local", rootDir: workDir };
});

test.afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

test.describe("wpRootDir", () => {
  test("returns the declared rootDir for local and ssh", async () => {
    expect(await wpRootDir(local)).toBe(workDir);
    expect(
      await wpRootDir({
        mode: "ssh",
        host: "h",
        username: "u",
        privateKeyPath: "/k",
        rootDir: "/var/www/html/site",
      }),
    ).toBe("/var/www/html/site");
  });

  test("prefers a declared rootDir for docker over probing the container", async () => {
    const docker: DockerTransport = {
      mode: "docker",
      container: "never-started",
      rootDir: "/var/www/html",
    };
    // No `docker` binary call happens: an unresolvable container would otherwise throw.
    expect(await wpRootDir(docker)).toBe("/var/www/html");
  });
});

test.describe("dockerCpArgv", () => {
  test("builds a `docker cp` (not `docker exec`) argv with the container-scoped target", () => {
    expect(
      dockerCpArgv("wpme-wpcli-nginx", "/tmp/a.zip", "/var/www/html/a.zip"),
    ).toEqual(["cp", "/tmp/a.zip", "wpme-wpcli-nginx:/var/www/html/a.zip"]);
  });
});

test.describe("copyIntoTarget — local transport", () => {
  test("copies a file to the target path", async () => {
    const source = join(workDir, "source.txt");
    const target = join(workDir, "target.txt");
    writeFileSync(source, "payload");

    await copyIntoTarget(local, source, target);
    expect(readFileSync(target, "utf8")).toBe("payload");
  });

  test("overwrites an existing target (staging must be idempotent)", async () => {
    const source = join(workDir, "new.txt");
    const target = join(workDir, "existing.txt");
    writeFileSync(source, "fresh");
    writeFileSync(target, "stale");

    await copyIntoTarget(local, source, target);
    expect(readFileSync(target, "utf8")).toBe("fresh");
  });

  test("skips a copy of a file onto itself instead of truncating it", async () => {
    const file = join(workDir, "self.zip");
    writeFileSync(file, "IMPORTANT");

    await copyIntoTarget(local, file, file);
    expect(readFileSync(file, "utf8")).toBe("IMPORTANT");

    // Same file reached through a symlink — dev+ino equality catches it too.
    const link = join(workDir, "self-link.zip");
    symlinkSync(file, link);
    await copyIntoTarget(local, file, link);
    expect(readFileSync(file, "utf8")).toBe("IMPORTANT");
  });

  test("throws naming both paths when the copy cannot happen", async () => {
    const target = join(workDir, "missing-dir", "x.txt");
    await expect(
      copyIntoTarget(local, join(workDir, "absent.txt"), target),
    ).rejects.toThrow(/could not copy .*absent\.txt.*to .*x\.txt/s);
  });
});

test.describe("exec — local transport", () => {
  // A command that stops to ask — WP-CLI's `[y/n]` confirm — must meet end-of-input and decline, as
  // it does over ssh. With stdin left open it would wait for an answer nobody can give; the race
  // turns that hang into a prompt failure instead of a test timeout.
  test("starts a command with its input already at an end", async () => {
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error("the command was still waiting on its stdin"));
      }, 5_000);
    });
    try {
      const { stdout, exitCode } = await Promise.race([
        exec(local, "sh", ["-c", 'read answer; echo "read=$?"']),
        hung,
      ]);
      expect({ stdout, exitCode }).toEqual({ stdout: "read=1", exitCode: 0 });
    } finally {
      clearTimeout(timer);
    }
  });
});

/**
 * A command that fails before it has an exit code names the program and the reason — never its
 * arguments, where the suite carries `--key=` values and every value a `wp eval` snippet embeds.
 * Each case plants a secret in the argv; execa's own message would quote it in every one (measured).
 */
test.describe("exec — a failure never quotes the command's arguments", () => {
  const SECRET = "SECRET-6G0-planted";
  const ARG = `--key=${SECRET}`;

  /** The message `run` rejects with, after checking it holds no trace of the secret. */
  async function failureOf(run: Promise<unknown>): Promise<string> {
    const error: unknown = await run.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const { message, cause } = error as Error;
    expect(message).not.toContain(SECRET);
    // A cause is printed with the error, and execa's holds the whole command line.
    expect(cause).toBeUndefined();
    return message;
  }

  test("a program that is not there", async () => {
    expect(
      await failureOf(exec(local, "no-such-program-e2e", ["eval", ARG])),
    ).toBe(
      `[wp/exec] "no-such-program-e2e" could not be started (ENOENT): no such program on this ` +
        `machine, or no directory "${workDir}" to run it in.`,
    );
  });

  // Node reports a missing working directory as ENOENT too, which is why that message names both.
  test("a working directory that is not there", async () => {
    const gone = join(workDir, "no-such-dir");
    expect(
      await failureOf(exec(local, "sh", ["-c", "true", ARG], { cwd: gone })),
    ).toBe(
      `[wp/exec] "sh" could not be started (ENOENT): no such program on this machine, or no ` +
        `directory "${gone}" to run it in.`,
    );
  });

  test("a command killed by a signal", async () => {
    expect(
      await failureOf(exec(local, "sh", ["-c", "kill -TERM $$", "sh", ARG])),
    ).toBe(
      '[wp/exec] "sh" was killed by SIGTERM (Termination) before it exited.',
    );
  });

  // Typed, so a caller with another way to its answer (the debug log's direct read) can tell it from
  // a transport that failed.
  test("a command killed by a signal is a CommandKilledError carrying the signal", async () => {
    const error: unknown = await exec(local, "sh", [
      "-c",
      "kill -KILL $$",
    ]).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandKilledError);
    expect((error as CommandKilledError).signal).toBe("SIGKILL");
  });

  test("a program that is not there is not a CommandKilledError", async () => {
    const error: unknown = await exec(local, "no-such-program-e2e", []).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(CommandKilledError);
  });

  // The capped output is the reason, even though the process ended at an exit code of its own.
  test("output over the capture cap, from a command that then exits", async () => {
    expect(
      await failureOf(
        exec(local, "sh", ["-c", "yes | head -c 100000001", "sh", ARG]),
      ),
    ).toBe(
      '[wp/exec] "sh" produced more output than can be captured, so its result was truncated ' +
        "and cannot be trusted.",
    );
  });

  // A command that never stops writing is ended by the broken pipe, so it has a signal and no exit
  // code; naming SIGPIPE would hide the cause. The `--` matters: GNU `yes` (CI, the cells) refuses
  // `--key=…` as an unknown option and exits at once, while BSD `yes` (macOS) just repeats it.
  test("output over the capture cap, from a command that never stops", async () => {
    expect(await failureOf(exec(local, "yes", ["--", ARG]))).toBe(
      '[wp/exec] "yes" produced more output than can be captured, so its result was truncated ' +
        "and cannot be trusted.",
    );
  });

  test("a docker transport with no docker on the PATH", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "wp-no-docker-"));
    const original = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      const docker: DockerTransport = { mode: "docker", container: "c-e2e" };
      expect(await failureOf(exec(docker, "wp", ["eval", ARG]))).toBe(
        '[wp/exec] "docker exec c-e2e wp" could not be started (ENOENT): no such program on this ' +
          "machine.",
      );
    } finally {
      process.env.PATH = original;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  // execa refuses one before starting anything, quoting it; ssh2 refuses it as a bare "Unable to
  // exec". Refused ahead of both, every transport says the same thing.
  test("an argument holding a NUL byte is refused by position, before any transport", async () => {
    expect(
      await failureOf(exec(local, "sh", ["-c", "true", `${ARG}\0x`])),
    ).toBe(
      '[wp/exec] refusing to run "sh": argument 3 holds a NUL byte, which no program can be handed.',
    );
  });

  // No UTF-8 form exists for a lone surrogate: sent, it would arrive as U+FFFD, a different argument.
  test("an argument holding a lone surrogate is refused by position, before any transport", async () => {
    expect(
      await failureOf(exec(local, "sh", ["-c", "true", `${ARG}\ud800`])),
    ).toBe(
      '[wp/exec] refusing to run "sh": argument 3 is not well-formed text (a lone surrogate), ' +
        "which no program can be handed.",
    );
  });

  // Docker's binary is never reached: the refusal comes first, whatever the transport.
  test("a lone surrogate is refused on the docker transport too, with no docker started", async () => {
    const docker: DockerTransport = { mode: "docker", container: "c-e2e" };
    expect(await failureOf(exec(docker, "wp", [ARG, "\udc00x"]))).toBe(
      '[wp/exec] refusing to run "wp": argument 2 is not well-formed text (a lone surrogate), ' +
        "which no program can be handed.",
    );
  });

  test("a program whose name holds a lone surrogate or a NUL byte is refused without naming it", async () => {
    expect(await failureOf(exec(local, "sh\ud83d", [ARG]))).toBe(
      "[wp/exec] refusing to run a program whose name is not well-formed text (a lone surrogate).",
    );
    expect(await failureOf(exec(local, "sh\0", [ARG]))).toBe(
      "[wp/exec] refusing to run a program whose name holds a NUL byte.",
    );
  });

  // A whole surrogate pair is ordinary text, not refused.
  test("an argument holding a whole surrogate pair runs", async () => {
    const result = await exec(local, "printf", ["%s", "a😀b"]);
    expect(result.stdout).toBe("a😀b");
  });

  // The one execa call no argument check stands in front of: its own refusal is replaced, not quoted.
  test("a call execa itself refuses", async () => {
    const docker: DockerTransport = { mode: "docker", container: "c-e2e" };
    const source = join(workDir, "cp-source.txt");
    writeFileSync(source, "x");
    const message = await failureOf(
      copyIntoTarget(docker, source, "/var/www/html/a\0.zip"),
    );
    expect(message).toMatch(
      /could not be started: execa refused the call \(TypeError\)\.$/,
    );
    expect(message).not.toContain("null bytes");
  });
});

test.describe("whyItDidNotExit", () => {
  const streams = { stdout: "", stderr: "" };

  test("names a signal without a description as it came", () => {
    expect(whyItDidNotExit({ ...streams, signal: "SIGUSR2" })).toBe(
      "was killed by SIGUSR2 before it exited",
    );
  });

  test("names any other start failure by its code", () => {
    expect(whyItDidNotExit({ ...streams, code: "EACCES" }, "/srv/wp")).toBe(
      "could not be started (EACCES)",
    );
  });

  // Only an identifier is quoted as it came: a code is copied from whatever error execa caught.
  test("leaves out a code that is not an error code", () => {
    expect(whyItDidNotExit({ ...streams, code: "eval --key=abc" })).toBe(
      "ended without an exit code, and execa gave no reason",
    );
  });

  test("says so when execa gave no reason at all", () => {
    expect(whyItDidNotExit(streams)).toBe(
      "ended without an exit code, and execa gave no reason",
    );
  });
});

/**
 * Elevation, split the way the code is: the **invocation** is pure argv and checked as such, while
 * the **capability probe** is exercised against a fake `sudo` on `PATH`.
 *
 * The fake is not a security stand-in — it exists so the escalation policy can be observed on a
 * machine that has no passwordless root, which is most of them. Each test gets its own WordPress
 * root because probe results are cached per target.
 */

/** Answers the `sudo -n true` probe, then runs the command; `FAKE_SUDO_DENY=1` refuses everything. */
const FAKE_SUDO = `#!/usr/bin/env bash
if [ "$FAKE_SUDO_DENY" = "1" ]; then exit 1; fi
[ "$1" = "-n" ] && shift
[ "$1" = "--" ] && shift
if [ "$1" = "true" ]; then exit 0; fi
exec "$@"
`;

let sudoDir: string;
let sudoPath: string;

test.beforeAll(() => {
  sudoDir = mkdtempSync(join(tmpdir(), "wp-fake-sudo-"));
  writeFileSync(join(sudoDir, "sudo"), FAKE_SUDO);
  chmodSync(join(sudoDir, "sudo"), 0o755);
  sudoPath = `${sudoDir}:${process.env.PATH ?? ""}`;
});

test.afterAll(() => {
  rmSync(sudoDir, { recursive: true, force: true });
});

/** A fresh `local` transport, so each test probes rather than reading another's cached answer. */
function freshLocal(elevate?: boolean): LocalTransport {
  const rootDir = mkdtempSync(join(tmpdir(), "wp-elevate-root-"));
  return {
    mode: "local",
    rootDir,
    ...(elevate === undefined ? {} : { elevate }),
  };
}

test.describe("sudoArgv", () => {
  test("never prompts, and stops sudo parsing the command's own flags", () => {
    expect(sudoArgv("rm", ["-rf", "/var/www/html/site/x"])).toEqual([
      "-n",
      "--",
      "rm",
      "-rf",
      "/var/www/html/site/x",
    ]);
  });
});

test.describe("dockerArgv", () => {
  test("runs as the container's own user by default", () => {
    expect(dockerArgv("wpme-wpcli-nginx", "rm", ["-rf", "/x"])).toEqual([
      "exec",
      "wpme-wpcli-nginx",
      "rm",
      "-rf",
      "/x",
    ]);
  });

  // `sudo` is not an option here: the official `wordpress:cli` image does not ship it, and the
  // daemon is already root — so elevation is a choice of user, made by the client.
  test("asRoot selects uid 0 rather than shelling out to sudo", () => {
    expect(
      dockerArgv("wpme-wpcli-nginx", "rm", ["-rf", "/x"], { asRoot: true }),
    ).toEqual(["exec", "-u", "0:0", "wpme-wpcli-nginx", "rm", "-rf", "/x"]);
  });
});

test.describe("elevationSupport", () => {
  test("docker is always available: `-u 0:0` cannot be refused", async () => {
    const docker: DockerTransport = { mode: "docker", container: "never-run" };
    expect(await elevationSupport(docker)).toBe("available");
  });

  // No command may run for this: a site that opted out must not be probed at all, which is also
  // what makes the answer safe to trust on an unreachable host.
  test("a site declaring elevate:false is disabled, without probing", async () => {
    const original = process.env.PATH;
    process.env.PATH = "/nonexistent";
    try {
      expect(await elevationSupport(freshLocal(false))).toBe("disabled");
    } finally {
      process.env.PATH = original;
    }
  });

  test("a passwordless sudo answers available", async () => {
    const original = process.env.PATH;
    process.env.PATH = sudoPath;
    try {
      expect(await elevationSupport(freshLocal())).toBe("available");
    } finally {
      process.env.PATH = original;
    }
  });

  test("a sudo that refuses answers unavailable", async () => {
    const original = process.env.PATH;
    process.env.PATH = sudoPath;
    process.env.FAKE_SUDO_DENY = "1";
    try {
      expect(await elevationSupport(freshLocal())).toBe("unavailable");
    } finally {
      process.env.PATH = original;
      delete process.env.FAKE_SUDO_DENY;
    }
  });

  // A host with no sudo binary makes the probe throw rather than exit non-zero (execa cannot start
  // it). That means the same thing, so it must not escape as an error from a cleanup path.
  test("a missing sudo binary answers unavailable rather than throwing", async () => {
    const emptyBin = mkdtempSync(join(tmpdir(), "wp-no-sudo-"));
    const original = process.env.PATH;
    process.env.PATH = emptyBin;
    try {
      expect(await elevationSupport(freshLocal())).toBe("unavailable");
    } finally {
      process.env.PATH = original;
      rmSync(emptyBin, { recursive: true, force: true });
    }
  });

  test("the probe is cached per target", async () => {
    const original = process.env.PATH;
    const transport = freshLocal();
    process.env.PATH = sudoPath;
    try {
      expect(await elevationSupport(transport)).toBe("available");
      // Same transport, no sudo reachable: a second probe would now answer differently.
      process.env.PATH = "/nonexistent";
      expect(await elevationSupport(transport)).toBe("available");
    } finally {
      process.env.PATH = original;
    }
  });
});

test.describe("execElevated", () => {
  // The opt-out is authoritative: a caller that forgot to check must fail, not quietly escalate.
  test("refuses a site that declared elevate:false", async () => {
    await expect(
      execElevated(freshLocal(false), "rm", ["-rf", "/tmp/nothing"]),
    ).rejects.toThrow(/elevate: false/);
  });
});

/**
 * The two target-identity helpers, tested directly and against each other.
 *
 * They exist because this layer caches two *different kinds* of fact. Passwordless `sudo` is a
 * property of a machine and a user, so asking once per host is right. File ownership is a property
 * of a **site**, and one host routinely serves several that need not agree — measured on a live
 * cell, two docroots under the same `ubuntu@host` owned `sftp_backwpup:www-data` and
 * `sftp_wprocket:www-data`. Keyed alike, whichever was probed first would answer for both.
 *
 * Pinned here rather than through a caller because for a `local` transport the two return the same
 * string: a caller-level test over `local` sites cannot tell them apart, and would keep passing with
 * the distinction removed.
 */
test.describe("targetKey vs installKey", () => {
  const ssh = (rootDir: string): SshTransport => ({
    mode: "ssh",
    host: "203.0.113.10",
    username: "ubuntu",
    privateKeyPath: "/home/ci/.ssh/id_ed25519",
    rootDir,
  });

  test("ssh: one host, two sites — same target, different installs", () => {
    const a = ssh("/var/www/site-a");
    const b = ssh("/var/www/site-b");
    expect(targetKey(a)).toBe(targetKey(b));
    expect(installKey(a)).not.toBe(installKey(b));
  });

  test("docker: one container, two roots — same target, different installs", () => {
    const a: DockerTransport = {
      mode: "docker",
      container: "wpcli",
      rootDir: "/var/www/a",
    };
    const b: DockerTransport = {
      mode: "docker",
      container: "wpcli",
      rootDir: "/var/www/b",
    };
    expect(targetKey(a)).toBe(targetKey(b));
    expect(installKey(a)).not.toBe(installKey(b));
  });

  // An undeclared docker rootDir must not collide with a declared one.
  test("docker: an undeclared root is its own install", () => {
    const declared: DockerTransport = {
      mode: "docker",
      container: "wpcli",
      rootDir: "/var/www/a",
    };
    const undeclared: DockerTransport = { mode: "docker", container: "wpcli" };
    expect(installKey(declared)).not.toBe(installKey(undeclared));
  });

  test("different hosts, users or keys are different targets", () => {
    const base = ssh("/var/www/site");
    expect(targetKey({ ...base, host: "203.0.113.11" })).not.toBe(
      targetKey(base),
    );
    expect(targetKey({ ...base, username: "deploy" })).not.toBe(
      targetKey(base),
    );
    expect(targetKey({ ...base, privateKeyPath: "/other/key" })).not.toBe(
      targetKey(base),
    );
  });

  // The SSH twins: one host, one root, told apart by their port alone.
  test("ssh: one host and root on two ports — different targets and installs", () => {
    const a = { ...ssh("/var/www/site/public"), port: 2210 };
    const b = { ...ssh("/var/www/site/public"), port: 2211 };
    expect(targetKey(a)).not.toBe(targetKey(b));
    expect(installKey(a)).not.toBe(installKey(b));
    expect(targetKey(a)).not.toBe(targetKey(ssh("/var/www/site/public")));
  });

  // The same site must answer the same way every time, or nothing would ever cache.
  test("both are stable for the same transport", () => {
    expect(targetKey(ssh("/var/www/site"))).toBe(
      targetKey(ssh("/var/www/site")),
    );
    expect(installKey(ssh("/var/www/site"))).toBe(
      installKey(ssh("/var/www/site")),
    );
  });

  // `local` is the case that cannot distinguish them: the root already identifies the machine's one
  // site. Stated so a future reader does not "fix" it by adding a local case that proves nothing.
  test("local: the two coincide, because the root already identifies the site", () => {
    const local: LocalTransport = { mode: "local", rootDir: "/var/www/site" };
    expect(installKey(local)).toBe(targetKey(local));
  });
});

/**
 * The elevation probe's answer is memoised for the whole process, and it gates every escalation
 * this suite performs. So the one thing it must never do is remember a **transport** failure: a
 * dropped connection during the probe would otherwise stop residue being removed and ownership being
 * corrected for every later scenario in that worker, on a host that can do both — with a single
 * deduplicated warning as the only trace.
 *
 * `PATH` is the stub directory alone, so the first call cannot even start `sudo` (the shape of a
 * transport that could not run the command), and the second can.
 */
test.describe("elevationSupport — a transport failure is not remembered", () => {
  let binDir: string;
  let realPath: string;
  let root: string;

  test.beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "wp-elev-bin-"));
    root = mkdtempSync(join(tmpdir(), "wp-elev-root-"));
    realPath = process.env.PATH ?? "";
    process.env.PATH = binDir;
    resetElevationCaches();
  });

  test.afterEach(() => {
    process.env.PATH = realPath;
    rmSync(binDir, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    resetElevationCaches();
  });

  test("so the next call asks again, and gets the real answer", async () => {
    const site: LocalTransport = { mode: "local", rootDir: root };
    expect(await elevationSupport(site)).toBe("unavailable");

    // The transport recovers: `sudo` can now be started, and says yes.
    writeFileSync(join(binDir, "sudo"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "sudo"), 0o755);
    expect(await elevationSupport(site)).toBe("available");
  });

  // A genuine refusal is still a real answer, and must stay cached — that is what keeps a
  // correctly-permissioned host from paying a round-trip per scenario.
  test("but a refusal is remembered, and not re-asked", async () => {
    const log = join(binDir, "calls.log");
    writeFileSync(
      join(binDir, "sudo"),
      `#!/bin/sh\necho x >> ${log}\nexit 1\n`,
    );
    chmodSync(join(binDir, "sudo"), 0o755);
    const site: LocalTransport = { mode: "local", rootDir: root };

    expect(await elevationSupport(site)).toBe("unavailable");
    expect(await elevationSupport(site)).toBe("unavailable");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

/** How an ssh site is named in messages: its port only when it declares one. */
test.describe("describeTarget — ssh", () => {
  const ssh: SshTransport = {
    mode: "ssh",
    host: "127.0.0.1",
    username: "ubuntu",
    privateKeyPath: "/keys/id_ed25519",
    rootDir: "/var/www/site/public",
  };

  test("user@host without a port, user@host:port with one", () => {
    expect(describeTarget(ssh)).toBe("ubuntu@127.0.0.1");
    expect(describeTarget({ ...ssh, port: 2210 })).toBe(
      "ubuntu@127.0.0.1:2210",
    );
  });

  // Unbracketed, `::1` on 2222 and a portless `::1:2222` would read, and key, the same.
  test("an IPv6 host is bracketed, with or without a port", () => {
    expect(describeTarget({ ...ssh, host: "::1" })).toBe("ubuntu@[::1]");
    expect(describeTarget({ ...ssh, host: "::1", port: 2222 })).toBe(
      "ubuntu@[::1]:2222",
    );
    expect(describeTarget({ ...ssh, host: "::1:2222" })).toBe(
      "ubuntu@[::1:2222]",
    );
  });

  test("an IPv6 host with a port and one whose address ends like it are different targets", () => {
    const withPort = { ...ssh, host: "::1", port: 2222 };
    const portless = { ...ssh, host: "::1:2222" };
    expect(targetKey(withPort)).not.toBe(targetKey(portless));
    expect(installKey(withPort)).not.toBe(installKey(portless));
  });
});
