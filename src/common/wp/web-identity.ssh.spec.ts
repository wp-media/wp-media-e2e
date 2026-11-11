import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  lutimesSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { CommandKilledError } from "./errors";
import { disposeConnections, resetElevationCaches } from "./exec";
import { PROBE_PHP, ROOT_WRITE_SCRIPT, probeWebIdentity } from "./web-identity";
import { tapFifo } from "../__fixtures__/fifo";
import {
  startProbeWebServer,
  type ProbeWebServer,
} from "../__fixtures__/probe-web-server";
import {
  decodeSudoLog,
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";

/**
 * The web probe over ssh into a root the SSH user cannot write: written, and removed, as root through
 * `sudo` — here a `sudo` that stands in for root by lending the user write access to the root for the
 * one command (and setting `E2E_ROOT=1` for it) — or reported `not-writable` when elevation is refused
 * or unavailable. A wrapped `readlink` (the resolved-path guard's tool) can answer "outside the root"
 * for one path, or plant a symlink at it right after answering: the race between guard and write.
 */

let server: SshTestServer;
let web: ProbeWebServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];
/** The stand-in `sudo`'s log: one line per call, its command after `--`. */
let sudoLog = "";
/** Exists: the stand-in `sudo` refuses as `sudo -n` without a rule does. */
let sudoDenied = "";
/** The wrapped `readlink`'s mode: absent (pass through), `outside`, `segv` (dies by a signal) or `plant`. */
let readlinkMode = "";
/** The path the wrapped `readlink` acts on. */
let readlinkTarget = "";
/** What `plant` links the target to. */
let plantTo = "";
/** Exists: the wrapped `rm` refuses as the transport's user (root's still runs). */
let rmDenied = "";
/** Exists: the wrapped `dd` run as root creates its file, then fails as a full disk does. */
let ddFull = "";

const NAME = `e2e-identity-${"7".repeat(32)}.php`;

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  sudoLog = join(started.base, "root-sudo.log");
  sudoDenied = join(started.base, "root-sudo.deny");
  readlinkMode = join(started.base, "readlink.mode");
  readlinkTarget = join(started.base, "readlink.target");
  plantTo = join(started.base, "readlink.plant");
  rmDenied = join(started.base, "rm.deny");
  ddFull = join(started.base, "dd.full");
  const real = (name: string): string =>
    execFileSync("/bin/sh", ["-c", `command -v ${name}`], {
      encoding: "utf8",
    }).trim();
  started.addProgram(
    "readlink",
    [
      `mode=$(cat '${readlinkMode}' 2>/dev/null); target=$(cat '${readlinkTarget}' 2>/dev/null)`,
      'last=; for a in "$@"; do last=$a; done',
      'if [ "$mode" = outside ] && [ "$last" = "$target" ]; then echo /elsewhere/probe.php; exit 0; fi',
      'if [ "$mode" = segv ] && [ "$last" = "$target" ]; then kill -SEGV $$; fi',
      `'${real("readlink")}' "$@"; s=$?`,
      'if [ "$mode" = plant ] && [ "$last" = "$target" ]; then',
      `  chmod u+w '${started.root}'; ln -s "$(cat '${plantTo}')" "$target"; chmod u-w '${started.root}'`,
      `  rm -f '${readlinkMode}'`,
      "fi",
      "exit $s",
      "",
    ].join("\n"),
  );
  // The `dd` the server would run: its `conv=excl` stand-in where it installed one, else the system's.
  const shim = join(started.base, "bin", "dd");
  const ddReal = existsSync(shim) ? join(started.base, "dd.real") : real("dd");
  if (existsSync(shim)) copyFileSync(shim, ddReal);
  started.addProgram(
    "dd",
    [
      `if [ -n "$E2E_ROOT" ] && [ -e '${ddFull}' ]; then`,
      '  for a in "$@"; do case $a in of=*) of=${a#of=} ;; esac; done',
      '  : > "$of"; cat >/dev/null',
      `  echo "dd: error writing '$of': No space left on device" >&2; exit 1`,
      "fi",
      `exec '${ddReal}' "$@"`,
      "",
    ].join("\n"),
  );
  started.addProgram(
    "rm",
    `[ -z "$E2E_ROOT" ] && [ -e '${rmDenied}' ] && { echo 'rm: Permission denied' >&2; exit 1; }\nexec '${real("rm")}' "$@"\n`,
  );
  started.addProgram(
    "sudo",
    [
      `[ -e '${sudoDenied}' ] && { echo 'sudo: a password is required' >&2; exit 1; }`,
      'while [ "$#" -gt 0 ]; do case $1 in --) shift; break ;; -n) shift ;; -u|-g) shift 2 ;; *) break ;; esac; done',
      "line=",
      `for arg in "$@"; do line="$line:$(printf '%s' "$arg" | od -An -v -tx1 | tr -d ' \\n')"; done`,
      `printf '%s\\n' "$line" >> '${sudoLog}'`,
      `chmod u+w '${started.root}'; E2E_ROOT=1 "$@"; s=$?; chmod u-w '${started.root}'; exit $s`,
      "",
    ].join("\n"),
  );
  web = await startProbeWebServer(started.root);
  teardown.push(() => web.close());
});

test.beforeEach(() => {
  resetElevationCaches();
  writeFileSync(sudoLog, "");
  for (const file of [
    sudoDenied,
    readlinkMode,
    readlinkTarget,
    rmDenied,
    ddFull,
  ]) {
    rmSync(file, { force: true });
  }
  chmodSync(server.root, 0o555);
});

test.afterEach(() => {
  chmodSync(server.root, 0o755);
  // What a test planted or left: the root is the server's, emptied for the next.
  for (const name of readdirSync(server.root)) {
    rmSync(join(server.root, name), { recursive: true, force: true });
  }
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** The stand-in `sudo`'s calls, each the argv after its options. */
const sudoCalls = (): string[][] =>
  decodeSudoLog(readFileSync(sudoLog, "utf8"));

test("a root the SSH user cannot write gets the probe as root, removed as root", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  const before = web.requests.length;

  const result = await probeWebIdentity(
    { transport: server.transport(), baseURL: web.baseURL },
    playwright.request,
    { name: NAME },
  );

  expect(result).toMatchObject({ kind: "identified" });
  expect(web.requests.slice(before)).toEqual([
    { path: `/${NAME}`, content: PROBE_PHP, mode: 0o644 },
  ]);
  const path = join(server.root, NAME);
  expect(sudoCalls()).toEqual([
    ["true"],
    [
      "sh",
      "-c",
      ROOT_WRITE_SCRIPT,
      "sh",
      PROBE_PHP,
      NAME,
      server.root,
      realpathSync(server.root),
    ],
    ["rm", "-f", "--", path],
  ]);
  expect(readdirSync(server.root)).toEqual([]);
});

test("root's write that fails after creating the file is removed as root, both failures named", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  writeFileSync(ddFull, "");
  const before = web.requests.length;

  const result = await probeWebIdentity(
    { transport: server.transport(), baseURL: web.baseURL },
    playwright.request,
    { name: NAME },
  );

  expect(result).toMatchObject({ kind: "unverified", reason: "not-writable" });
  expect(result.kind === "unverified" ? result.detail : "").toMatch(
    /^the transport's user's write failed \(.*Permission denied\), and root's too \(.*No space left on device\)$/,
  );
  expect(sudoCalls().map(([program]) => program)).toEqual(["true", "sh", "rm"]);
  expect(web.requests.length).toBe(before);
  expect(readdirSync(server.root)).toEqual([]);
});

for (const [label, setup, elevation] of [
  ["refused by the site (elevate: false)", "disabled", "disabled"],
  ["unavailable (sudo -n refused)", "deny", "unavailable"],
] as const) {
  test(`with elevation ${label}, the probe is not-writable and nothing is written`, async ({
    playwright,
  }) => {
    test.skip(process.getuid?.() === 0, "root writes through any mode");
    if (setup === "deny") writeFileSync(sudoDenied, "");
    const before = web.requests.length;

    const result = await probeWebIdentity(
      {
        transport: server.transport(
          setup === "disabled" ? { elevate: false } : {},
        ),
        baseURL: web.baseURL,
      },
      playwright.request,
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: "not-writable",
    });
    expect(result.kind === "unverified" ? result.detail : "").toContain(
      `elevation is ${elevation}`,
    );
    expect(web.requests.length).toBe(before);
    expect(sudoCalls().filter(([program]) => program === "sh")).toEqual([]);
    expect(readdirSync(server.root)).toEqual([]);
  });
}

/**
 * Collects `console.warn` lines while `run` runs.
 *
 * @param run - the code under test.
 * @returns its result and the warnings.
 */
async function withWarnings<T>(
  run: () => Promise<T>,
): Promise<{ readonly result: T; readonly warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), warnings };
  } finally {
    console.warn = original;
  }
}

test("a symlink to a FIFO planted between the guards and root's write is never written through", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  const path = join(server.root, NAME);
  const fifo = tapFifo(join(server.base, "planted.fifo"));
  try {
    writeFileSync(readlinkTarget, path);
    writeFileSync(plantTo, join(server.base, "planted.fifo"));
    writeFileSync(readlinkMode, "plant");

    const result = await probeWebIdentity(
      { transport: server.transport(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    );

    expect(existsSync(readlinkMode)).toBe(false); // the plant ran
    expect(result).toMatchObject({
      kind: "unverified",
      reason: "not-writable",
    });
    // The user's own refusal stays named beside root's.
    expect(result.kind === "unverified" ? result.detail : "").toMatch(
      /^the transport's user's write failed \(.*Permission denied\), and root's too \(.*File exists\)$/,
    );
    expect(sudoCalls().map(([program]) => program)).toEqual(["true", "sh"]);
    expect(fifo.drain()).toBe("");
    expect(lstatSync(path).isSymbolicLink()).toBe(true);
  } finally {
    fifo.close();
  }
});

test("a probe path resolving outside the root is refused before root writes anything", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  writeFileSync(readlinkTarget, join(server.root, NAME));
  writeFileSync(readlinkMode, "outside");

  await expect(
    probeWebIdentity(
      { transport: server.transport(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    ),
  ).rejects.toThrow(/refusing a privileged write or removal .* outside it/);
  expect(sudoCalls()).toEqual([["true"]]);
  expect(readdirSync(server.root)).toEqual([]);
});

test("a leftover the guards refuse to remove as root is a warning; the probe goes on", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  const leftover = join(server.root, `e2e-identity-${"9".repeat(32)}.php`);
  chmodSync(server.root, 0o755);
  writeFileSync(leftover, "x");
  const then = new Date(Date.now() - 2 * 3_600_000);
  lutimesSync(leftover, then, then);
  chmodSync(server.root, 0o555);
  writeFileSync(readlinkTarget, leftover);
  writeFileSync(readlinkMode, "outside");

  const { result, warnings } = await withWarnings(() =>
    probeWebIdentity(
      { transport: server.transport(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    ),
  );

  expect(result).toMatchObject({ kind: "identified" });
  expect(warnings.join("\n")).toMatch(
    /could not remove 1 identity probe file\(s\) a killed run left/,
  );
  expect(sudoCalls()).not.toContainEqual(["rm", "-f", "--", leftover]);
  expect(readdirSync(server.root)).toEqual([posixBase(leftover)]);
});

test("a transport failure while guarding a leftover's removal is thrown, never taken for a refusal", async ({
  playwright,
}) => {
  test.skip(process.getuid?.() === 0, "root writes through any mode");
  const leftover = join(server.root, `e2e-identity-${"9".repeat(32)}.php`);
  chmodSync(server.root, 0o755);
  writeFileSync(leftover, "x");
  const then = new Date(Date.now() - 2 * 3_600_000);
  lutimesSync(leftover, then, then);
  chmodSync(server.root, 0o555);
  writeFileSync(readlinkTarget, leftover);
  writeFileSync(readlinkMode, "segv");

  await expect(
    probeWebIdentity(
      { transport: server.transport(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    ),
  ).rejects.toBeInstanceOf(CommandKilledError);
  expect(sudoCalls()).toEqual([["true"]]);
  expect(readdirSync(server.root)).toEqual([posixBase(leftover)]);
});

test("a probe the transport's user wrote but cannot remove is a warning, never removed as root", async ({
  playwright,
}) => {
  chmodSync(server.root, 0o755);
  writeFileSync(rmDenied, "");

  const { result, warnings } = await withWarnings(() =>
    probeWebIdentity(
      { transport: server.transport(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    ),
  );

  expect(result).toMatchObject({ kind: "identified" });
  expect(warnings.join("\n")).toMatch(/could not remove the identity probe/);
  expect(sudoCalls()).toEqual([]);
  expect(readdirSync(server.root)).toEqual([NAME]);
});

/**
 * A path's last segment.
 *
 * @param path - an absolute path.
 */
function posixBase(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}
