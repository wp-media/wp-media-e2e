import { test, expect } from "@playwright/test";
import {
  execFileSync,
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { removeTempDir } from "../src/common/__fixtures__/temp-dir";
import { escapeRegExp } from "../src/common/text";
import { FAKE_LINES, waitForText } from "./__fixtures__/fake-suite";

/**
 * The real command in a child process, as the `orchestrator` script runs it: `node --import tsx
 * orchestrator/cli.ts …`, its outputs pipes. Help, usage errors, config errors, `--task` and the dry
 * run go through `cli.ts` itself — none of them runs anything — in a copy of the checkout whose
 * BackWPup sites file declares the example config's cells with sites that are not placeholders: the
 * suite reads its sites files from its own folder, and a checkout's own may not have those cells.
 * The signals go through the same command, its `start` swapped for the fake suite's by a preload
 * (`__fixtures__/swap-start.mjs`), started directly and under `npm run`, each in a process group of its
 * own. No child ever runs in the real checkout, whose sites files are real: every one runs in the copy,
 * or in a test's own temporary folder, and every `start` is given a temporary `--config`. Every child
 * still running when a test ends is SIGKILLed, its group too.
 */

test.describe.configure({ mode: "parallel" });

/** tsx's loader, by its file URL: a child's working directory need not hold `node_modules`. */
const TSX = import.meta.resolve("tsx");

/** The checkout: `cli.ts`'s, and the real `orchestrator` script's. */
const CHECKOUT = join(import.meta.dirname, "..");

/** The preload that swaps the real `start.ts` for the fake suite's, under the real script. */
const SWAP_START = join(import.meta.dirname, "__fixtures__", "swap-start.mjs");

/** A password with no shape a mask recognises: only its URL's shape can hide it. */
const PASSWORD = "Hunter2-No-Shape-0123";

/** How often each signal pattern is tried per test: a race shows only over many tries. */
const TRIES = 10;

/**
 * The checkout's `orchestrator` script.
 *
 * @returns it, as `package.json` holds it.
 */
function realScript(): string {
  const { scripts } = JSON.parse(
    readFileSync(join(CHECKOUT, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  return scripts.orchestrator ?? "";
}

/** What a child process left. */
interface Exited {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The environment a child gets: `PATH` and `HOME` only, so no variable of this process — `.env`'s,
 * npm's own — leaks into it; and, inside a test, `XDG_STATE_HOME` in the test's own folder, so a
 * start's cell locks are the test's, never this user's nor another test's.
 *
 * @param extra - variables to add.
 * @returns the environment.
 */
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    npm_config_update_notifier: "false",
    ...(root === "" ? {} : { XDG_STATE_HOME: join(root, "state-home") }),
    ...extra,
  };
}

/** Every child a test started, until it ends: what `afterEach` kills, with its process group. */
const children = new Set<ChildProcess>();

/**
 * Spawns a child the test owns, always the leader of a process group of its own, so that it is
 * SIGKILLed with everything it started — npm's script, a run — if it still runs when the test ends.
 * An orphan left by a killed npm, its copy of the checkout then removed, was seen spinning for minutes.
 *
 * @param file - the program.
 * @param args - its arguments.
 * @param options - Node's spawn options.
 * @returns the child.
 */
function spawnOwned(
  file: string,
  args: readonly string[],
  options: SpawnOptions,
): ChildProcess {
  const child = spawn(file, args, { ...options, detached: true });
  children.add(child);
  child.on("exit", () => children.delete(child));
  return child;
}

/**
 * SIGKILLs a process, or a group by its negated id, unless it is gone: `ESRCH`, or — macOS, for a group
 * left only with its unreaped leader — `EPERM`, which never kills anything either.
 *
 * @param target - a PID, or a group's negated.
 */
function killHard(target: number): void {
  try {
    process.kill(target, "SIGKILL");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ESRCH" && code !== "EPERM") throw error;
  }
}

test.afterEach(() => {
  for (const child of children)
    if (child.pid !== undefined) {
      killHard(-child.pid);
      killHard(child.pid);
    }
  children.clear();
});

/**
 * Runs a command to its end, its outputs piped.
 *
 * @param file - the program.
 * @param args - its arguments.
 * @param cwd - its working directory.
 * @param env - variables beyond {@link childEnv}'s.
 * @returns how it exited and what it wrote.
 */
function run(
  file: string,
  args: readonly string[],
  cwd: string,
  env: Record<string, string> = {},
): Promise<Exited> {
  return new Promise((resolve, reject) => {
    const child = spawnOwned(file, args, { cwd, env: childEnv(env) });
    let stdout = "";
    let stderr = "";
    child.stdout
      ?.setEncoding("utf8")
      .on("data", (text: string) => (stdout += text));
    child.stderr
      ?.setEncoding("utf8")
      .on("data", (text: string) => (stderr += text));
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code, signal, stdout, stderr });
    });
  });
}

/** The copy of the checkout the command runs in, made once for the file. */
let copy = "";

/** A sites file of the checkout: never copied, the copy has its own. */
const SITES_FILE = /^sites(\.[^.]+)?\.json$/;

test.beforeAll(async () => {
  copy = await mkdtemp(join(tmpdir(), "e2e-cli-checkout-"));
  for (const dir of ["src", "orchestrator"])
    await cp(join(CHECKOUT, dir), join(copy, dir), {
      recursive: true,
      filter: (source) =>
        !SITES_FILE.test(basename(source)) ||
        basename(source) === "sites.example.json",
    });
  for (const file of ["package.json", "tsconfig.json"])
    await copyFile(join(CHECKOUT, file), join(copy, file));
  await symlink(join(CHECKOUT, "node_modules"), join(copy, "node_modules"));
  // The example's BackWPup cells, their sites real hosts rather than placeholders.
  const sites = join(copy, "src", "projects", "backwpup", "config");
  await writeFile(
    join(sites, "sites.json"),
    readFileSync(join(sites, "sites.example.json"), "utf8").replaceAll(
      ".example.test",
      ".qa.test",
    ),
  );
});

test.afterAll(() => {
  removeTempDir(copy);
  copy = "";
});

/**
 * Runs the real command in the copy, as the `orchestrator` script does.
 *
 * @param args - its arguments.
 * @returns how it exited and what it wrote.
 */
function cli(...args: string[]): Promise<Exited> {
  return run(
    process.execPath,
    ["--import", TSX, join(copy, "orchestrator", "cli.ts"), ...args],
    copy,
  );
}

/**
 * Every entry under a folder: its kind, mode, size and modification time — what a dry run must
 * leave as it found.
 *
 * @param dir - the folder.
 * @returns each entry's description, by its path relative to the folder.
 */
function snapshot(dir: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (relative: string): void => {
    const path = join(dir, relative);
    const stat = lstatSync(path);
    entries[relative || "."] = [
      stat.isDirectory() ? "dir" : stat.isFile() ? "file" : "other",
      stat.mode.toString(8),
      String(stat.size),
      String(stat.mtimeMs),
    ].join(" ");
    if (stat.isDirectory())
      for (const name of readdirSync(path)) walk(join(relative, name));
  };
  walk("");
  return entries;
}

/**
 * The test's own temporary folder, `""` until `mkdtemp` made it — an interrupted `beforeEach` leaves it
 * so, and the `afterEach` then removes nothing; its state directory, `0700`; and its config's path.
 */
let root = "";
let stateDir = "";
let config = "";

test.beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "e2e-cli-"));
  stateDir = join(root, ".orchestrator");
  await mkdir(stateDir, { mode: 0o700 });
  config = join(stateDir, "config.json");
});

test.afterEach(() => {
  removeTempDir(root);
  root = "";
});

/** Writes the committed example config, as it is, as the test's config, `0600`. */
async function writeExampleConfig(): Promise<void> {
  await copyFile(join(import.meta.dirname, "config.example.json"), config);
  await chmod(config, 0o600);
}

test.describe("the command, in a child process", () => {
  test("--help prints every command, whole, through a pipe; exit 0", async () => {
    const out = await cli("--help");
    expect(out).toMatchObject({ code: 0, stderr: "" });
    expect(out.stdout).toMatch(
      /^Usage: orchestrator \[options\] \[command\]\n/,
    );
    expect(out.stdout).toMatch(
      / {2}help \[command\] +display help for command\n$/,
    );
  });

  test("start --help prints its options, exit codes and examples, whole; exit 0", async () => {
    const out = await cli("start", "--help");
    expect(out).toMatchObject({ code: 0, stderr: "" });
    expect(out.stdout).toMatch(/^Usage: orchestrator start \[options\]\n/);
    for (const option of [
      "--config <file>",
      "--task <id...>",
      "--once",
      "--dry-run",
    ])
      expect(out.stdout).toContain(option);
    expect(out.stdout).toMatch(/\n {2}npm run orchestrator -- start\n$/);
  });

  test("--version prints the checkout's version; exit 0", async () => {
    const { version } = JSON.parse(
      readFileSync(join(CHECKOUT, "package.json"), "utf8"),
    ) as { version: string };
    expect(await cli("--version")).toMatchObject({
      code: 0,
      stdout: `${version}\n`,
      stderr: "",
    });
  });

  test("an unknown option is a usage error: exit 1, said on stderr, nothing on stdout", async () => {
    const out = await cli("start", "--bogus", `--config=${config}`);
    expect(out).toMatchObject({
      code: 1,
      stdout: "",
      stderr: "error: unknown option '--bogus'\n(add --help for usage)\n",
    });
  });

  test("an unknown command, or no command, exits 1", async () => {
    expect(await cli("stop")).toMatchObject({ code: 1, stdout: "" });
    const none = await cli();
    expect(none).toMatchObject({ code: 1, stdout: "" });
    expect(none.stderr).toContain("Usage: orchestrator");
  });

  for (const dryRun of [false, true])
    test(`an unknown --task${dryRun ? " in a dry run" : ""} is refused before anything is taken: exit 1, masked stderr`, async () => {
      await writeExampleConfig();
      const before = snapshot(stateDir);
      const out = await cli(
        "start",
        "--config",
        config,
        "--task",
        "bpng",
        `https://admin:${PASSWORD}@x.test/`,
        ...(dryRun ? ["--dry-run"] : []),
      );
      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(
        `orchestrator: ${dryRun ? "dry run failed" : "not started"}: --task names no task of ${config}: "https://***@x.test/"`,
      );
      expect(out.stderr).not.toContain(PASSWORD);
      expect(snapshot(stateDir)).toEqual(before);
    });

  for (const [name, text] of [
    ["is missing", undefined],
    ["is not JSON", "{"],
  ] as const)
    for (const dryRun of [false, true])
      test(`a config that ${name} is refused${dryRun ? " by the dry run" : ""}: exit 1, said on stderr`, async () => {
        if (text !== undefined) await writeFile(config, text, { mode: 0o600 });
        const out = await cli(
          "start",
          `--config=${config}`,
          ...(dryRun ? ["--dry-run"] : []),
        );
        expect(out.code).toBe(1);
        expect(out.stdout).toBe("");
        expect(out.stderr).toContain(
          `orchestrator: ${dryRun ? "dry run failed" : "not started"}: `,
        );
        expect(out.stderr).toContain(config);
        expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(false);
      });

  test("--dry-run on the example config prints the report on stdout and writes nothing; exit 0", async () => {
    await writeExampleConfig();
    const before = snapshot(stateDir);
    const out = await cli("start", "--dry-run", "--once", "--config", config);
    expect(out.code).toBe(0);
    expect(out.stdout.split("\n")).toEqual([
      `dry run · nothing is run · config ${config} · state ${stateDir}/`,
      "2 tasks (bpng, bfap)",
      "bpng · BackWPup Pro on nginx",
      "  backwpup pro@nginx · develop · version 9.99.99 · every scenario · cooldown 5m",
      "  site https://backwpup.pro-nginx.qa.test · 203.0.113.21",
      "bfap · BackWPup Free on Apache, smoke only",
      "  backwpup free@apache · develop (default) · version 9.99.99 (default) · grep @smoke · cooldown 5m",
      "  site https://backwpup.free-apache.qa.test · 203.0.113.20",
      "servers: 203.0.113.21 (bpng), 203.0.113.20 (bfap)",
      "runs: retries 2 · reports kept 20",
      "reports: bundle archive · Allure traces strip",
      'notifications: slack ("E2E Orchestrator", scp from auto-e2e) · datator',
      "secrets for the runs: GITHUB_TOKEN, BWP_S3_ACCESS_KEY_ID, BWP_S3_SECRET_ACCESS_KEY",
      "no warnings",
      "",
    ]);
    // Only the suite's own notice that WP Rocket has no sites file of its own.
    expect(out.stderr).toMatch(
      /^\[sites\] No sites\.json [^\n]*wp-rocket[^\n]*\n$/,
    );
    expect(snapshot(stateDir)).toEqual(before);
  });

  test("--dry-run beside a live orchestrator's lock warns, leaves it, and exits 0", async () => {
    await writeExampleConfig();
    // A live process holding the lock, as a running orchestrator does.
    const lockPath = join(stateDir, "orchestrator.lock");
    const holder = spawnOwned(
      process.execPath,
      [
        "--import",
        TSX,
        "--input-type=module",
        "--eval",
        `import { acquireLock } from ${JSON.stringify(new URL("./state/lock.ts", import.meta.url).href)};
         await acquireLock(${JSON.stringify(stateDir)});
         process.stdout.write("held\\n");
         setInterval(() => {}, 1000);`,
      ],
      { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "inherit"] },
    );
    try {
      await new Promise<void>((resolve) =>
        holder.stdout?.once("data", () => {
          resolve();
        }),
      );
      const before = snapshot(stateDir);
      const out = await cli("start", "--dry-run", "--config", config);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain(`warning: a start would be refused: `);
      expect(out.stdout).toContain(`(pid ${String(holder.pid)} `);
      expect(snapshot(stateDir)).toEqual(before);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
    }
  });

  for (const what of ["help", "dry run"] as const)
    test(`a ${what} into a closed pipe ends with its own exit code, no crash and no stack trace`, async () => {
      await writeExampleConfig();
      const child = spawnOwned(
        process.execPath,
        [
          "--import",
          TSX,
          join(copy, "orchestrator", "cli.ts"),
          "start",
          ...(what === "help" ? ["--help"] : ["--dry-run", "--config", config]),
        ],
        { cwd: copy, env: childEnv(), stdio: ["ignore", "pipe", "pipe"] },
      );
      // The reader goes away before anything is written: every write meets a closed pipe.
      child.stdout?.destroy();
      let stderr = "";
      child.stderr?.setEncoding("utf8").on("data", (text: string) => {
        stderr += text;
      });
      const code = await new Promise<number | null>((resolve) =>
        child.on("close", (exitCode) => {
          resolve(exitCode);
        }),
      );
      expect(code).toBe(0);
      expect(stderr).not.toMatch(/EPIPE|Error|\n {4}at /);
    });

  for (const [variable, value] of [
    ["npm_config_dry_run", "true"],
    ["npm_config_once", "true"],
    ["npm_config_task", "bpng"],
    ["npm_config_config", "c.json"],
  ] as const)
    test(`what npm 11 hands a script it took an option from (${variable}) is refused: exit 1, nothing written`, async () => {
      await writeExampleConfig();
      const before = snapshot(root);
      // npm 11, `npm run orchestrator start --once` (no "--"): the script gets ["start"] and the variable.
      const out = await run(
        process.execPath,
        ["--import", TSX, join(copy, "orchestrator", "cli.ts"), "start"],
        root,
        { [variable]: value, INIT_CWD: root },
      );
      expect(out.code).toBe(1);
      expect(out.stdout).toBe("");
      expect(out.stderr).toContain(`as its own setting (${variable} is set)`);
      expect(snapshot(root)).toEqual(before);
    });

  test("cli.ts is one statement: the command's exit code handed to process.exit, nothing before or after", () => {
    // Only `process.exit` ends a process a paused terminal or a run's pending wait keeps alive, and any
    // listener, delay or code here would run outside every test of `runCommand`.
    const code = readFileSync(join(import.meta.dirname, "cli.ts"), "utf8")
      .replace(/\/\*\*[\s\S]*?\*\//g, "")
      .replace(/\s+/g, " ")
      .trim();
    expect(code).toBe(
      'import { runCommand } from "./command"; process.exit(await runCommand(process.argv.slice(2)));',
    );
  });

  test("the orchestrator script runs cli.ts in Node itself, in the shell's place, never through the tsx CLI", () => {
    // The tsx CLI runs the code in a child and relays signals to it: repeated SIGINTs to its PID made
    // it SIGKILL the child, the lock and the runs left behind. Without `exec`, Ubuntu's dash stays
    // between npm and Node, and a signal to npm's PID never reaches the orchestrator.
    expect(realScript()).toBe("exec node --import tsx orchestrator/cli.ts");
  });

  test("npm run orchestrator runs the command: help exits 0, a usage error 1", async () => {
    const help = await run(
      "npm",
      [
        "run",
        "--silent",
        "orchestrator",
        "--",
        "start",
        "--help",
        "--config",
        config,
      ],
      copy,
    );
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/^Usage: orchestrator start \[options\]\n/);
    const bogus = await run(
      "npm",
      [
        "run",
        "--silent",
        "orchestrator",
        "--",
        "start",
        "--bogus",
        "--config",
        config,
      ],
      copy,
    );
    expect(bogus.code).toBe(1);
    expect(bogus.stderr).toContain("error: unknown option '--bogus'");
  });
});

test.describe("the command under npm, in a child process", () => {
  /**
   * Runs `npm run orchestrator` in the copy of the checkout.
   *
   * @param cwd - where npm is run.
   * @param args - npm's arguments after the script's name.
   * @returns how it exited and what it wrote.
   */
  function npmRun(cwd: string, ...args: string[]): Promise<Exited> {
    return run("npm", ["run", "--silent", "orchestrator", ...args], cwd);
  }

  test("npm run orchestrator start --dry-run, without --, is refused: npm ran it without --dry-run; nothing is written", async () => {
    const state = join(copy, ".orchestrator");
    expect(existsSync(state)).toBe(false);
    const out = await npmRun(copy, "start", "--dry-run");
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain(
      "orchestrator: npm took --dry-run as its own setting (npm_config_dry_run is set) and ran the script without it; nothing was run.",
    );
    expect(existsSync(state)).toBe(false);
  });

  test("npm run orchestrator -- start --dry-run is the dry run: npm sets no dry run of its own", async () => {
    await writeExampleConfig();
    const before = snapshot(stateDir);
    const out = await npmRun(
      copy,
      "--",
      "start",
      "--dry-run",
      `--config=${config}`,
    );
    expect(out.code).toBe(0);
    expect(out.stdout).toMatch(/^dry run · nothing is run · /);
    expect(snapshot(stateDir)).toEqual(before);
  });

  test("a relative --config is from the folder npm was run in, not the package's", async () => {
    const sub = join(copy, "sub");
    try {
      await mkdir(join(sub, ".orchestrator"), { recursive: true, mode: 0o700 });
      await chmod(join(sub, ".orchestrator"), 0o700);
      await copyFile(
        join(import.meta.dirname, "config.example.json"),
        join(sub, ".orchestrator", "config.json"),
      );
      await chmod(join(sub, ".orchestrator", "config.json"), 0o600);
      const out = await npmRun(
        sub,
        "--",
        "start",
        "--dry-run",
        "--config",
        ".orchestrator/config.json",
      );
      expect(out.code).toBe(0);
      // Shown from the checkout: the file under sub/, never the package's own .orchestrator/.
      expect(out.stdout.split("\n")[0]).toBe(
        "dry run · nothing is run · config sub/.orchestrator/config.json · state sub/.orchestrator/",
      );
    } finally {
      await rm(sub, { recursive: true, force: true });
    }
  });
});

test("the dry run's output reaches a reader slower than 5 s, whole, however long", async () => {
  test.setTimeout(60_000);
  const line = "x".repeat(99);
  const lines = 20_000; // 2 MB: far beyond a pipe's buffer and Node's
  const body = `
    import { runCommand } from ${JSON.stringify(new URL("./command.ts", import.meta.url).href)};
    const lines = Array.from({ length: ${String(lines)} }, () => ${JSON.stringify(line)});
    process.exit(await runCommand(["start", "--dry-run", "--config", ${JSON.stringify("CONFIG")}], {
      env: {},
      start: () => { throw new Error("no start here"); },
      prepareStart: async () => ({ loaded: { stateDir: "/s" }, selected: [] }),
      inspectState: async () => [],
      report: () => lines,
    }));
  `;
  const child = spawnOwned(
    process.execPath,
    [
      "--import",
      TSX,
      "--input-type=module",
      "--eval",
      body.replace('"CONFIG"', JSON.stringify(config)),
    ],
    { cwd: root, env: childEnv(), stdio: ["ignore", "pipe", "inherit"] },
  );
  const stdout = child.stdout;
  if (stdout === null) throw new Error("no stdout");
  const exit = new Promise<number | null>((resolve) =>
    child.on("exit", (code) => {
      resolve(code);
    }),
  );
  stdout.pause();
  await delay(6_000);
  let received = 0;
  stdout.on("data", (chunk: Buffer) => {
    received += chunk.length;
  });
  const closed = new Promise((resolve) => stdout.on("end", resolve));
  stdout.resume();
  expect(await exit).toBe(0);
  await closed;
  expect(received).toBe(lines * (line.length + 1));
});

test.describe("the command, stopped by real signals", () => {
  test.describe.configure({ timeout: 180_000 });

  /**
   * The test's own folder, set up as a package: the copy's `package.json` (the checkout's
   * `orchestrator` script as it is) and its `orchestrator/` — whose `start`, should the swap fail, reads
   * only the copy's stand-in sites — and `node_modules`, linked.
   */
  let pkg = "";

  test.beforeEach(async () => {
    pkg = root;
    for (const name of ["orchestrator", "node_modules"])
      await symlink(join(copy, name), join(pkg, name));
    await copyFile(join(copy, "package.json"), join(pkg, "package.json"));
    // A cell only the fake product list has: should the swap ever fail, the real start refuses it.
    await writeFile(
      config,
      JSON.stringify({
        tasks: [
          {
            id: "bpng",
            type: "loop",
            product: "backwpup",
            cell: "fake@cell",
            cooldownMinutes: 1,
          },
        ],
      }),
      { mode: 0o600 },
    );
  });

  /**
   * The environment of every Node the script starts: tsx, then the swap — in that order, so its hook
   * comes after tsx's — preloaded through `NODE_OPTIONS`, which reaches whatever the script runs.
   *
   * @param extra - variables to add.
   * @returns the variables.
   */
  function swapEnv(extra: Record<string, string> = {}): Record<string, string> {
    return {
      NODE_OPTIONS: `--import=${TSX} --import=${SWAP_START}`,
      FAKE_CLI_CHECKOUT: pkg,
      FAKE_PARENT_WATCH_MS: "100",
      ...extra,
    };
  }

  /**
   * Starts the real command over the fake suite in a process group of its own — the checkout's
   * script's own words run directly (as its shell's `exec` would), or `npm run orchestrator --` — and
   * waits until its run is under way.
   *
   * @param via - `node`: the script's command directly; `npm`: through npm.
   * @param extra - variables to add.
   * @returns the launcher's PID (its group's), the orchestrator's own PID, and the launcher's exit.
   */
  async function launch(
    via: "node" | "npm",
    extra: Record<string, string> = {},
  ): Promise<{
    group: number;
    pid: number;
    exit: Promise<number | null>;
  }> {
    removeTempDir(join(stateDir, "runs"));
    removeTempDir(join(stateDir, "tasks"));
    await rm(join(stateDir, "orchestrator.log"), { force: true });
    const args = ["start", "--config", config];
    const [program = "", ...words] = realScript()
      .replace(/^exec /, "")
      .split(" ");
    const child = spawnOwned(
      via === "npm" ? "npm" : program === "node" ? process.execPath : program,
      via === "npm"
        ? ["run", "orchestrator", "--", ...args]
        : [...words, ...args],
      {
        cwd: pkg,
        env: childEnv(swapEnv(extra)),
        detached: true,
        stdio: "ignore",
      },
    );
    const exit = new Promise<number | null>((resolve) =>
      child.on("exit", (code) => {
        resolve(code);
      }),
    );
    await waitForText(runLog(), FAKE_LINES.ready, 30_000);
    const pid = Number(/ · pid (\d+)/.exec(logText())?.[1]);
    const group = child.pid ?? 0;
    // The script's process is the orchestrator itself: spawned directly, or npm's own child — no
    // shell or tsx CLI between, which would hold or mishandle a signal sent to the script's PID.
    expect(via === "node" ? pid : parentOf(pid)).toBe(group);
    return { group, pid, exit };
  }

  /**
   * The run's `run.log`.
   *
   * @returns its path.
   */
  function runLog(): string {
    return join(stateDir, "runs", "bpng-1", "run.log");
  }

  /**
   * The orchestrator's log.
   *
   * @returns its text; empty until it exists.
   */
  function logText(): string {
    try {
      return readFileSync(join(stateDir, "orchestrator.log"), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * A process's parent.
   *
   * @param pid - the process.
   * @returns its parent's PID.
   */
  function parentOf(pid: number): number {
    return Number(
      execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], {
        encoding: "utf8",
      }).trim(),
    );
  }

  /**
   * Sends a signal, unless the process has already ended — a drain can finish within 31 ms.
   *
   * @param target - a PID, or a group's negated.
   * @param signal - SIGINT by default.
   */
  function send(target: number, signal: NodeJS.Signals = "SIGINT"): void {
    try {
      process.kill(target, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  /**
   * Waits until a process is gone.
   *
   * @param pid - its PID.
   */
  async function gone(pid: number): Promise<void> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        process.kill(pid, 0);
      } catch {
        return;
      }
      if (Date.now() > deadline)
        throw new Error(`pid ${String(pid)} never ended`);
      await delay(20);
    }
  }

  /**
   * Asserts the orchestrator drained exactly once and exited 130, its lock released and its run
   * recorded stopped.
   *
   * @param launcherExit - the launcher's exit code.
   * @param expected - what it must be: the orchestrator's 130, through npm too, or `null` for an npm
   *   a SIGHUP ended.
   */
  function assertDrainedOnce(
    launcherExit: number | null,
    expected: number | null = 130,
  ): void {
    const log = logText();
    expect(launcherExit).toBe(expected);
    expect(log).toContain("exiting 130");
    expect(log.match(/ stopping: /g)).toHaveLength(1);
    expect(log).not.toContain("interrupting every run");
    const out = readFileSync(runLog(), "utf8");
    expect(out).toContain(FAKE_LINES.drained);
    expect(out).not.toContain(FAKE_LINES.sigint);
    expect(
      JSON.parse(
        readFileSync(join(stateDir, "runs", "bpng-1", "run.json"), "utf8"),
      ),
    ).toMatchObject({ status: "stopped" });
    expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(false);
  }

  /**
   * Starts, stops one way, and asserts one drain — {@link TRIES} times.
   *
   * @param via - how it is started.
   * @param stop - sends the signals; told the try's index.
   * @param expected - the launcher's exit code.
   */
  async function tryStopping(
    via: "node" | "npm",
    stop: (target: { group: number; pid: number }, i: number) => Promise<void>,
    expected: number | null = 130,
  ): Promise<void> {
    for (let i = 0; i < TRIES; i++) {
      const { group, pid, exit } = await launch(via);
      try {
        const t0 = performance.now();
        await stop({ group, pid }, i);
        const code = await exit;
        await gone(pid);
        assertDrainedOnce(code, expected);
        // A drain of the fake takes milliseconds, the parent watch 100 ms here: nothing may hold the exit.
        expect(performance.now() - t0).toBeLessThan(4_000);
      } finally {
        // Never an orchestrator left behind by a try that failed: its group, then itself.
        killHard(-group);
        killHard(pid);
      }
    }
  }

  for (const via of ["node", "npm"] as const) {
    test(`${via}: repeated SIGINTs to the orchestrator's PID, 1 ms apart, drain once; exit 130`, async () => {
      await tryStopping(via, async ({ pid }) => {
        for (let n = 0; n < 3; n++) {
          send(pid);
          await delay(1);
        }
      });
    });

    test(`${via}: npm's pattern — the group's SIGINT, then one to the PID 1–31 ms later — drains once; exit 130`, async () => {
      await tryStopping(via, async ({ group, pid }, i) => {
        send(-group);
        await delay(1 + ((i * 7) % 31)); // 1, 8, 15, 22, 29, 5, … ms
        send(pid);
      });
    });

    test(`${via}: SIGHUP to the process group drains once`, async () => {
      // npm takes the group's SIGHUP's default action: it ends, killed, and its exit code is null.
      await tryStopping(
        via,
        ({ group }) => {
          send(-group, "SIGHUP");
          return Promise.resolve();
        },
        via === "npm" ? null : 130,
      );
    });
  }

  test("npm: repeated SIGINTs to npm's own PID, 1 ms apart, reach the orchestrator, which drains once; exit 130", async () => {
    await tryStopping("npm", async ({ group }) => {
      for (let n = 0; n < 3; n++) {
        send(group);
        await delay(1);
      }
    });
  });

  test("npm: SIGTERM to npm's own PID reaches the orchestrator, which drains once; exit 130", async () => {
    await tryStopping("npm", ({ group }) => {
      send(group, "SIGTERM");
      return Promise.resolve();
    });
  });

  test("npm: SIGHUP to npm's own PID ends npm alone; the orchestrator sees its parent gone and drains once", async () => {
    await tryStopping(
      "npm",
      ({ group }) => {
        send(group, "SIGHUP");
        return Promise.resolve();
      },
      null,
    );
    expect(logText()).toMatch(
      /the parent process \d+ ended \(now \d+\): stopping as on a hangup/,
    );
  });

  test("npm: SIGHUP to npm's own PID while the orchestrator still boots stops it all the same; exit 130, nothing left running", async () => {
    // From as soon as npm's child appears — the orchestrator not yet booted, its parent's PID not yet
    // read — to past its boot.
    for (const afterMs of [0, 0, 50, 150, 300, 600]) {
      removeTempDir(join(stateDir, "runs"));
      removeTempDir(join(stateDir, "tasks"));
      await rm(join(stateDir, "orchestrator.log"), { force: true });
      const npm = spawnOwned(
        "npm",
        ["run", "orchestrator", "--", "start", "--config", config],
        {
          cwd: pkg,
          env: childEnv(swapEnv()),
          detached: true,
          stdio: "ignore",
        },
      );
      const group = npm.pid ?? 0;
      let pid = 0;
      try {
        pid = await childOf(group);
        await delay(afterMs);
        send(group, "SIGHUP");
        await gone(pid);
        const log = logText();
        expect(log, `${String(afterMs)} ms`).toContain("exiting 130");
        // A run begun before the parent was seen gone is drained, never left running.
        const run = join(stateDir, "runs", "bpng-1", "run.json");
        if (existsSync(run))
          expect(JSON.parse(readFileSync(run, "utf8"))).toMatchObject({
            status: "stopped",
          });
        expect(existsSync(join(stateDir, "orchestrator.lock"))).toBe(false);
      } finally {
        // Its group, the orchestrator reparented but still in it, and a run's own group.
        killHard(-group);
        if (pid !== 0) killHard(pid);
        killRunGroups();
      }
    }
  });

  /**
   * The first child of a process, once it has one: npm's script, the orchestrator.
   *
   * @param parent - the parent's PID.
   * @returns the child's PID.
   */
  async function childOf(parent: number): Promise<number> {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const found = Number(
          execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
            .trim()
            .split("\n")[0],
        );
        if (found > 0) return found;
      } catch {
        // None yet: pgrep exits 1.
      }
      if (Date.now() > deadline)
        throw new Error(`pid ${String(parent)} never had a child`);
      await delay(5);
    }
  }

  /** SIGKILLs the group every run record of the test's state directory names: its own runs alone. */
  function killRunGroups(): void {
    const runs = join(stateDir, "runs");
    for (const name of existsSync(runs) ? readdirSync(runs) : [])
      try {
        const record = JSON.parse(
          readFileSync(join(runs, name, "run.json"), "utf8"),
        ) as { process?: { pgid?: unknown } };
        const pgid = record.process?.pgid;
        if (typeof pgid === "number" && pgid > 1) killHard(-pgid);
      } catch {
        // No record, or none readable: nothing it names.
      }
  }

  test("a dry run in progress ends at once on SIGINT, by Node's default: it holds no signal", async () => {
    const [program = "", ...words] = realScript()
      .replace(/^exec /, "")
      .split(" ");
    expect(program).toBe("node");
    const child = spawnOwned(
      process.execPath,
      [...words, "start", "--dry-run", "--config", config],
      {
        cwd: pkg,
        env: childEnv(swapEnv({ FAKE_SLOW_PREPARE: "1" })),
        stdio: ["ignore", "ignore", "pipe"],
      },
    );
    const exit = new Promise<NodeJS.Signals | null>((resolve) =>
      child.on("exit", (_code, signal) => {
        resolve(signal);
      }),
    );
    await new Promise<void>((resolve) =>
      child.stderr?.on("data", (text: Buffer) => {
        if (text.toString().includes("preparing")) resolve();
      }),
    );
    const t0 = performance.now();
    child.kill("SIGINT");
    expect(await exit).toBe("SIGINT");
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  test("two orchestrators on two state directories racing for one cell: one runs it, the other is refused at its start, naming it, and never runs", async () => {
    // Both under this test's XDG_STATE_HOME (childEnv): one user's cell locks.
    const second = join(root, "second");
    await mkdir(second, { mode: 0o700 });
    const configs = [config, join(second, "config.json")];
    await copyFile(config, configs[1] ?? "");
    const [program = "", ...words] = realScript()
      .replace(/^exec /, "")
      .split(" ");
    expect(program).toBe("node");
    for (let i = 0; i < 5; i++) {
      for (const dir of [stateDir, second]) {
        removeTempDir(join(dir, "runs"));
        removeTempDir(join(dir, "tasks"));
        await rm(join(dir, "orchestrator.log"), { force: true });
      }
      const started = configs.map((file) => {
        const child = spawnOwned(
          process.execPath,
          [...words, "start", "--once", "--config", file],
          { cwd: pkg, env: childEnv(swapEnv()), stdio: "ignore" },
        );
        return {
          child,
          exit: new Promise<number | null>((resolve) =>
            child.on("exit", (code) => {
              resolve(code);
            }),
          ),
        };
      });
      try {
        // The loser exits at once with --once: refused at its start — by the check, or as its loop took the site.
        const loser = await Promise.race(
          started.map(({ exit }, index) =>
            exit.then((code) => ({ index, code })),
          ),
        );
        expect(loser.code).toBe(1);
        const winner = 1 - loser.index;
        const dirs = [stateDir, second];
        const winnerDir = dirs[winner] ?? "";
        await waitForText(
          join(winnerDir, "runs", "bpng-1", "run.log"),
          FAKE_LINES.ready,
          30_000,
        );
        const winnerLog = readFileSync(
          join(winnerDir, "orchestrator.log"),
          "utf8",
        );
        const winnerPid = / · pid (\d+)/.exec(winnerLog)?.[1] ?? "?";
        const loserLog = readFileSync(
          join(dirs[loser.index] ?? "", "orchestrator.log"),
          "utf8",
        );
        // The winner's run named once it had one; taken at its loop's start, the site names none yet.
        expect(loserLog).toMatch(
          new RegExp(
            `bpng {2}not started: Another orchestrator \\(pid ${winnerPid}[^)]* — running backwpup fake@cell on site a\\.qa\\.test(, run bpng-1 \\(${escapeRegExp(join(winnerDir, "runs", "bpng-1", "run.json"))}\\))?\\)`,
          ),
        );
        // Never a run of the loser: no number taken, no run folder.
        expect(existsSync(join(dirs[loser.index] ?? "", "runs"))).toBe(false);
        const winnerChild = started[winner]?.child;
        winnerChild?.kill("SIGINT");
        expect(await started[winner]?.exit).toBe(130);
      } finally {
        for (const { child } of started)
          if (child.pid !== undefined) {
            killHard(-child.pid);
            killHard(child.pid);
          }
      }
    }
  });

  test("an orchestrator cooling down keeps its cell: a second, on another state directory, is refused at its start and never runs", async () => {
    const second = join(root, "second");
    await mkdir(second, { mode: 0o700 });
    const secondConfig = join(second, "config.json");
    await copyFile(config, secondConfig);
    const [, ...words] = realScript()
      .replace(/^exec /, "")
      .split(" ");
    // Runs that end at once: the first orchestrator is soon in its one-minute cooldown.
    const env = childEnv(swapEnv({ FAKE_RUN_MS: "0" }));
    const first = spawnOwned(
      process.execPath,
      [...words, "start", "--config", config],
      { cwd: pkg, env, stdio: "ignore" },
    );
    const firstExit = new Promise<number | null>((resolve) =>
      first.on("exit", (code) => {
        resolve(code);
      }),
    );
    try {
      await waitForText(join(stateDir, "orchestrator.log"), "next run", 30_000);
      const secondRun = await run(
        process.execPath,
        [...words, "start", "--once", "--config", secondConfig],
        pkg,
        swapEnv({ FAKE_RUN_MS: "0" }),
      );
      expect(secondRun.code).toBe(1);
      const log = readFileSync(join(second, "orchestrator.log"), "utf8");
      expect(log).toMatch(
        new RegExp(
          `bpng {2}not started: Another orchestrator \\(pid \\d+[^)]* — running backwpup fake@cell on site a\\.qa\\.test, run bpng-1 \\(${escapeRegExp(join(stateDir, "runs", "bpng-1", "run.json"))}\\)\\)`,
        ),
      );
      expect(existsSync(join(second, "runs"))).toBe(false);
      first.kill("SIGINT");
      expect(await firstExit).toBe(130);
    } finally {
      if (first.pid !== undefined) {
        killHard(-first.pid);
        killHard(first.pid);
      }
    }
  });

  test("a signal after start returned, before process.exit, cannot kill the process: exit 130", async () => {
    for (let i = 0; i < TRIES; i++) {
      // The fake start sends itself a SIGINT once the real start has returned and removed its handlers.
      const { pid, exit } = await launch("node", {
        FAKE_LATE_SIGNAL: "SIGINT",
      });
      send(pid);
      const code = await exit;
      await gone(pid);
      assertDrainedOnce(code);
    }
  });
});
