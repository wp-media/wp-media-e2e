import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkoutVersion,
  configBase,
  dryRun,
  npmTookOption,
  optionValue,
  runCommand,
  taskIds,
  toStartOptions,
  type CommandDeps,
  type Output,
} from "./command";
import { ConfigError } from "./config/errors";
import type { PreparedStart, StartOptions } from "./start";
import type { ExitCode } from "./start-lines";

/**
 * The command line in this process: commander's parse mapped to `start`'s options, the dry run's
 * wiring, help, version, usage errors and their exit codes, masking, and the outputs waited for —
 * every collaborator a stand-in. `cli.spec.ts` runs the real command in a child.
 */

/** A password with no shape a mask recognises: only its URL's shape can hide it. */
const PASSWORD = "Hunter2-No-Shape-0123";

/** A URL whose userinfo holds {@link PASSWORD}. */
const CREDENTIAL_URL = `https://admin:${PASSWORD}@site.test/`;

/** A stand-in output: what it was given, and a queue the test sets. */
class FakeOutput implements Output {
  text = "";
  writableLength = 0;
  /**
   * Keeps the text.
   *
   * @param text - what was written.
   * @returns `true`.
   */
  write(text: string): boolean {
    this.text += text;
    return true;
  }
}

/** A run of the command with stand-ins, and what they saw. */
interface Rig {
  readonly stdout: FakeOutput;
  readonly stderr: FakeOutput;
  /** Every `start` call's options. */
  readonly started: StartOptions[];
  /** Every `prepareStart` call's options. */
  readonly prepared: StartOptions[];
  /** Every state directory inspected. */
  readonly inspected: string[];
  /** Every signal handler the command installed. */
  readonly held: string[];
  /** The deps handed to `runCommand`. */
  readonly deps: CommandDeps;
}

/** What the stand-in `prepareStart` returns: only the state directory and the selected cells are read by the command. */
const PREPARED = {
  loaded: { stateDir: "/state" },
  selected: [
    {
      task: { id: "a", product: "backwpup", cell: "pro@nginx" },
      cell: { sites: [{ baseURL: "https://a.qa.test" }] },
    },
  ],
} as unknown as PreparedStart;

/**
 * A rig.
 *
 * @param more - deps replacing the stand-ins.
 * @param startCode - what `start` returns.
 * @returns it.
 */
function rig(more: Partial<CommandDeps> = {}, startCode: ExitCode = 0): Rig {
  const stdout = new FakeOutput();
  const stderr = new FakeOutput();
  const started: StartOptions[] = [];
  const prepared: StartOptions[] = [];
  const inspected: string[] = [];
  const held: string[] = [];
  return {
    stdout,
    stderr,
    started,
    prepared,
    inspected,
    held,
    deps: {
      stdout,
      stderr,
      version: "1.2.3",
      checkout: "/checkout",
      exitWaitMs: 1_000,
      env: {},
      cwd: "/cwd",
      signals: {
        on: (signal, listener) => {
          listener(); // a held signal does nothing
          held.push(signal);
        },
      },
      start: (options) => {
        started.push(options);
        return Promise.resolve(startCode);
      },
      prepareStart: (options) => {
        prepared.push(options);
        return Promise.resolve(PREPARED);
      },
      inspectState: (stateDir) => {
        inspected.push(stateDir);
        return Promise.resolve(["the state is open"]);
      },
      report: (_prepared, options) => [
        "report",
        `checkout ${options?.checkout ?? "-"}`,
        ...(options?.stateWarnings ?? []).map((w) => `warning: ${w}`),
      ],
      ...more,
    },
  };
}

test.describe("toStartOptions", () => {
  test("maps every option, and nothing absent; a relative --config from the base", () => {
    expect(toStartOptions({}, "/b")).toEqual({});
    expect(
      toStartOptions(
        { config: "c.json", task: ["a", "b", "a"], once: true, dryRun: true },
        "/b",
      ),
    ).toEqual({ config: "/b/c.json", tasks: ["a", "b", "a"], once: true });
    expect(toStartOptions({ config: "/abs/c.json" }, "/b")).toEqual({
      config: "/abs/c.json",
    });
  });

  test("keeps only well-typed values", () => {
    expect(
      toStartOptions({ config: 1, task: ["a", 2, "b"], once: "yes" }, "/b"),
    ).toEqual({ tasks: ["a", "b"] });
    expect(toStartOptions({ task: "a", once: false }, "/b")).toEqual({});
    expect(toStartOptions({ task: [] }, "/b")).toEqual({});
  });
});

test.describe("configBase, optionValue and taskIds", () => {
  test("a relative --config is from where npm was run, else the working directory", () => {
    expect(configBase({ INIT_CWD: "/shell" }, "/pkg")).toBe("/shell");
    expect(configBase({ INIT_CWD: "" }, "/pkg")).toBe("/pkg");
    expect(configBase({}, "/pkg")).toBe("/pkg");
  });

  test("a value starting with '-' is refused: the option is missing its value", () => {
    expect(optionValue("bpng")).toBe("bpng");
    expect(optionValue("./-x.json")).toBe("./-x.json");
    expect(() => optionValue("--dry-run")).toThrow("cannot start with '-'");
    expect(() => optionValue("-")).toThrow("cannot start with '-'");
  });

  test("--task's ids are kept in order across occurrences, each one checked", () => {
    expect(taskIds("a", undefined)).toEqual(["a"]);
    expect(taskIds("b", ["a"])).toEqual(["a", "b"]);
    expect(() => taskIds("--once", ["a"])).toThrow("cannot start with '-'");
  });
});

test.describe("checkoutVersion", () => {
  /** A folder of the test's own. */
  let dir = "";

  test.beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "e2e-command-"));
  });

  test.afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("is the checkout's package.json version", () => {
    const checkout = join(import.meta.dirname, "..");
    const { version } = JSON.parse(
      readFileSync(join(checkout, "package.json"), "utf8"),
    ) as { version: string };
    expect(checkoutVersion(checkout)).toBe(version);
  });

  for (const [name, text] of [
    ["no package.json", undefined],
    ["a package.json that is not JSON", "{"],
    ["a package.json that is not an object", "null"],
    ["a version that is not a string", '{"version":1}'],
    ["an empty version", '{"version":""}'],
    ["a version that is not SemVer: a leading v", '{"version":"v1.1.0"}'],
    ["a version that is not SemVer: two numbers", '{"version":"1.1"}'],
    ["a version over 64 characters", `{"version":"1.1.0-${"a".repeat(60)}"}`],
  ] as const)
    test(`is "unknown" for ${name}`, async () => {
      if (text !== undefined)
        await writeFile(join(dir, "package.json"), text, "utf8");
      expect(checkoutVersion(dir)).toBe("unknown");
    });

  for (const [name, text, version] of [
    ["a prerelease and build", '{"version":"2.0.0-rc.1+b7"}', "2.0.0-rc.1+b7"],
    ["a file with a byte order mark", '\uFEFF{"version":"1.1.0"}', "1.1.0"],
  ] as const)
    test(`is a valid SemVer version as written: ${name}`, async () => {
      await writeFile(join(dir, "package.json"), text, "utf8");
      expect(checkoutVersion(dir)).toBe(version);
    });
});

test.describe("runCommand — start", () => {
  test("hands start every option as given, and returns its code", async () => {
    const r = rig({}, 130);
    expect(
      await runCommand(
        [
          "start",
          "--config",
          "c.json",
          "--task",
          "a",
          "b",
          "--task=a",
          "--once",
        ],
        r.deps,
      ),
    ).toBe(130);
    expect(r.started).toEqual([
      { config: "/cwd/c.json", tasks: ["a", "b", "a"], once: true },
    ]);
    expect(r.prepared).toEqual([]);
    expect(r.stdout.text + r.stderr.text).toBe("");
  });

  test("holds every shutdown signal before start runs, and never lets go: a late one cannot kill", async () => {
    const order: string[] = [];
    const r = rig({
      start: () => {
        order.push("start");
        return Promise.resolve(0);
      },
    });
    const on = r.deps.signals?.on.bind(r.deps.signals);
    const deps: CommandDeps = {
      ...r.deps,
      signals: {
        on: (signal, listener) => {
          order.push(signal);
          return on?.(signal, listener);
        },
      },
    };
    expect(await runCommand(["start"], deps)).toBe(0);
    expect(order).toEqual(["SIGINT", "SIGTERM", "SIGHUP", "start"]);
  });

  test("the dry run, help and usage errors hold no signal", async () => {
    for (const argv of [
      ["start", "--dry-run"],
      ["--help"],
      ["start", "--bogus"],
    ]) {
      const r = rig();
      await runCommand(argv, r.deps);
      expect(r.held).toEqual([]);
    }
  });

  test("with no option, start runs every task, looping", async () => {
    const r = rig({}, 1);
    expect(await runCommand(["start"], r.deps)).toBe(1);
    expect(r.started).toEqual([{}]);
  });

  test("returns start's code at once: start emptied the terminal itself", async () => {
    const r = rig({ exitWaitMs: 2_000 });
    r.stdout.writableLength = 10; // never taken
    const t0 = performance.now();
    expect(await runCommand(["start"], r.deps)).toBe(0);
    expect(performance.now() - t0).toBeLessThan(1_000);
  });

  test("a start that rejects, against its contract, is said and exits 1", async () => {
    const r = rig({
      start: () => Promise.reject(new Error(`boom ${CREDENTIAL_URL}`)),
    });
    expect(await runCommand(["start"], r.deps)).toBe(1);
    expect(r.stderr.text).toContain("orchestrator: failed: boom https://");
    expect(r.stderr.text).not.toContain(PASSWORD);
  });
});

test.describe("runCommand — npm's own settings", () => {
  for (const [variable, value, option, form] of [
    ["npm_config_dry_run", "true", "--dry-run", "--dry-run"],
    ["npm_config_once", "true", "--once", "--once"],
    ["npm_config_task", "bpng", "--task", "--task <id>"],
    ["npm_config_config", "c.json", "--config", "--config <file>"],
  ] as const)
    test(`refuses, running nothing, when npm took ${option} as its own setting (${variable})`, async () => {
      const r = rig({ env: { [variable]: value } });
      expect(await runCommand(["start"], r.deps)).toBe(1);
      expect(r.started).toEqual([]);
      expect(r.prepared).toEqual([]);
      expect(r.held).toEqual([]);
      expect(r.stdout.text).toBe("");
      expect(r.stderr.text).toBe(
        `orchestrator: npm took ${option} as its own setting (${variable} is set) and ran the script without it; nothing was run. Put every option after "--": npm run orchestrator -- start ${form}. If you did write "--", ${variable} comes from an .npmrc or the environment: remove it.\n`,
      );
    });

  test("a variable set while its option is there takes nothing away: no refusal (a global dry-run=true)", async () => {
    const all = {
      npm_config_dry_run: "true",
      npm_config_once: "true",
      npm_config_task: "a",
      npm_config_config: "c.json",
    };
    for (const [argv, env] of [
      [["start", "--dry-run"], { npm_config_dry_run: "true" }],
      [
        ["start", "--once", "--task", "a", "--config", "c.json", "--dry-run"],
        all,
      ],
      [["start", "--task=a", "--config=c.json", "--once", "--dry-run"], all],
    ] as const) {
      const r = rig({ env });
      expect(await runCommand(argv, r.deps)).toBe(0);
      expect(r.stderr.text).toBe("");
    }
  });

  test("runs as asked when npm's variables are off or absent", async () => {
    for (const env of [
      {},
      { npm_config_dry_run: "false", npm_config_once: "false" },
      { npm_config_dry_run: "", npm_config_task: "", npm_config_config: "" },
    ]) {
      const r = rig({ env });
      expect(await runCommand(["start"], r.deps)).toBe(0);
      expect(r.started).toEqual([{}]);
    }
  });

  test("npmTookOption names the first option taken, in a fixed order", () => {
    expect(npmTookOption(["start"], {})).toBeUndefined();
    expect(
      npmTookOption(["start"], {
        npm_config_once: "true",
        npm_config_task: "a",
      }),
    ).toEqual({ variable: "npm_config_once", option: "--once" });
    expect(
      npmTookOption(["start", "--onceX"], { npm_config_once: "true" }),
    ).toEqual({ variable: "npm_config_once", option: "--once" });
  });

  test("a refusal waits for its message to be taken before returning", async () => {
    const r = rig({ env: { npm_config_once: "true" }, exitWaitMs: 5_000 });
    r.stderr.writableLength = 10;
    setTimeout(() => {
      r.stderr.writableLength = 0;
    }, 300);
    const t0 = performance.now();
    expect(await runCommand(["start"], r.deps)).toBe(1);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(250);
  });

  test("an output failure is dropped: a listener on both outputs, before anything is written", async () => {
    const listeners: string[] = [];
    const r = rig();
    const deps: CommandDeps = {
      ...r.deps,
      stdout: Object.assign(r.stdout, {
        on: (event: "error", listener: (error: Error) => void) => {
          listeners.push(`stdout ${event}`);
          listener(Object.assign(new Error("EPIPE"), { code: "EPIPE" }));
        },
      }),
      stderr: Object.assign(r.stderr, {
        on: (event: "error", listener: (error: Error) => void) => {
          listeners.push(`stderr ${event}`);
          listener(new Error("EIO"));
        },
      }),
    };
    expect(await runCommand(["--help"], deps)).toBe(0);
    expect(listeners).toEqual(["stdout error", "stderr error"]);
  });

  test("a relative --config is resolved from where npm was run", async () => {
    const r = rig({ env: { INIT_CWD: "/shell" } });
    await runCommand(["start", "--config", "sub/c.json"], r.deps);
    await runCommand(["start", "--dry-run", "--config", "c.json"], r.deps);
    expect(r.started).toEqual([{ config: "/shell/sub/c.json" }]);
    expect(r.prepared).toEqual([{ config: "/shell/c.json" }]);
  });
});

test.describe("runCommand — the dry run", () => {
  test("prints the report on stdout, warnings or not, and exits 0; start never runs", async () => {
    const r = rig();
    expect(
      await runCommand(
        ["start", "--dry-run", "--task", "a", "--config", "c.json"],
        r.deps,
      ),
    ).toBe(0);
    expect(r.prepared).toEqual([{ config: "/cwd/c.json", tasks: ["a"] }]);
    expect(r.inspected).toEqual(["/state"]);
    expect(r.started).toEqual([]);
    expect(r.stdout.text).toBe(
      "report\ncheckout /checkout\nwarning: the state is open\n",
    );
    expect(r.stderr.text).toBe("");
  });

  test("judges the selected tasks' cells with the state directory", async () => {
    const units: unknown[] = [];
    const r = rig({
      inspectState: (_stateDir, options) => {
        units.push(...options.units);
        return Promise.resolve([]);
      },
    });
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(0);
    expect(units).toEqual([
      { product: "backwpup", cell: "pro@nginx", sites: ["https://a.qa.test"] },
    ]);
  });

  test("with --once, is the same dry run: --once changes nothing", async () => {
    const r = rig();
    expect(await runCommand(["start", "--once", "--dry-run"], r.deps)).toBe(0);
    expect(r.started).toEqual([]);
    expect(r.stdout.text).toContain("report\n");
  });

  test("the dry run's preparation reads the suite's version from the checkout its paths are shown from", async () => {
    const checkouts: (string | undefined)[] = [];
    const r = rig({
      prepareStart: (_options, deps) => {
        checkouts.push(deps?.checkout);
        return Promise.resolve(PREPARED);
      },
    });
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(0);
    expect(checkouts).toEqual(["/checkout"]);
    expect(r.stdout.text).toContain("checkout /checkout\n");
  });

  test("a config error goes to stderr alone, masked, and exits 1", async () => {
    const r = rig({
      prepareStart: () =>
        Promise.reject(
          new ConfigError(
            `The config names what the suite cannot run:\n  tasks[0].cell: ${CREDENTIAL_URL}`,
          ),
        ),
    });
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(1);
    expect(r.stdout.text).toBe("");
    expect(r.stderr.text).toBe(
      "orchestrator: dry run failed: The config names what the suite cannot run:\n  tasks[0].cell: https://***@site.test/\n",
    );
  });

  test("a report that throws is a failed dry run, never a crash", async () => {
    const r = rig({
      report: () => {
        throw new Error("no product");
      },
    });
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(1);
    expect(r.stdout.text).toBe("");
    expect(r.stderr.text).toBe("orchestrator: dry run failed: no product\n");
  });

  test("a failure with no message still says it failed", async () => {
    const r = rig({ prepareStart: () => Promise.reject(new Error("")) });
    expect(await dryRun({}, r.deps)).toBe(1);
    expect(r.stderr.text).toBe("orchestrator: dry run failed: failed\n");
  });

  test("an output that throws loses the line, never the exit code", async () => {
    const r = rig({
      prepareStart: () => Promise.reject(new ConfigError("bad")),
      stderr: {
        writableLength: 0,
        write: () => {
          throw new Error("EPIPE");
        },
      },
    });
    expect(await dryRun({}, r.deps)).toBe(1);
  });

  test("--task still collects ids, across occurrences, with its own parser", async () => {
    const r = rig();
    await runCommand(
      ["start", "--task", "a", "b", "--task", "c", "--task=d"],
      r.deps,
    );
    expect(r.started).toEqual([{ tasks: ["a", "b", "c", "d"] }]);
  });

  test("waits for the outputs to take the report before returning", async () => {
    const r = rig({ exitWaitMs: 5_000 });
    r.stdout.writableLength = 10;
    setTimeout(() => {
      r.stdout.writableLength = 0;
    }, 300);
    const t0 = performance.now();
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(0);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2_000);
  });

  test("gives up on an output that never empties after the exit's bound", async () => {
    const r = rig({ exitWaitMs: 300 });
    r.stderr.writableLength = 10;
    const t0 = performance.now();
    expect(await runCommand(["start", "--dry-run"], r.deps)).toBe(0);
    const took = performance.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(2_000);
  });
});

test.describe("runCommand — help, version and usage errors", () => {
  test("--help prints the commands on stdout and exits 0", async () => {
    const r = rig();
    expect(await runCommand(["--help"], r.deps)).toBe(0);
    expect(r.stdout.text).toContain("Usage: orchestrator [options] [command]");
    expect(r.stdout.text).toContain("start [options]");
    expect(r.stderr.text).toBe("");
    expect(r.started).toEqual([]);
  });

  for (const argv of [
    ["start", "--help"],
    ["start", "-h"],
    ["help", "start"],
  ])
    test(`${argv.join(" ")} prints start's options, how it is run and its exit codes; exits 0`, async () => {
      const r = rig();
      expect(await runCommand(argv, r.deps)).toBe(0);
      for (const text of [
        "Usage: orchestrator start [options]",
        "--config <file>",
        "--task <id...>",
        "--once",
        "--dry-run",
        "npm run orchestrator -- start [options]",
        "130  stopped: Ctrl-C, SIGTERM or SIGHUP",
        "the dry run was refused (the config,\n       --task)",
        'everything after "--" is the orchestrator\'s',
        "A relative --config is from the directory npm\nwas run in.",
      ])
        expect(r.stdout.text).toContain(text);
      expect(r.stderr.text).toBe("");
      expect(r.started).toEqual([]);
    });

  for (const flag of ["--version", "-V"])
    test(`${flag} prints the version and exits 0`, async () => {
      const r = rig();
      expect(await runCommand([flag], r.deps)).toBe(0);
      expect(r.stdout.text).toBe("1.2.3\n");
    });

  test("--version prints unknown for a version the started line would not name", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-command-"));
    try {
      await writeFile(join(dir, "package.json"), '{"version":"v1.1.0"}');
      const r = rig({ checkout: dir });
      const { version: _omitted, ...deps } = r.deps;
      expect(await runCommand(["--version"], deps)).toBe(0);
      expect(r.stdout.text).toBe("unknown\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the version is the given checkout's when not given", async () => {
    const dir = await mkdtemp(join(tmpdir(), "e2e-command-"));
    try {
      await writeFile(join(dir, "package.json"), '{"version":"7.7.7-x"}');
      const r = rig({ checkout: dir });
      const { version: _omitted, ...deps } = r.deps;
      expect(await runCommand(["--version"], deps)).toBe(0);
      expect(r.stdout.text).toBe("7.7.7-x\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("no command prints the help on stderr and exits 1", async () => {
    const r = rig();
    expect(await runCommand([], r.deps)).toBe(1);
    expect(r.stdout.text).toBe("");
    expect(r.stderr.text).toContain("Usage: orchestrator [options] [command]");
  });

  for (const [argv, error] of [
    [["start", "--bogus"], "error: unknown option '--bogus'"],
    [["stop"], "error: unknown command 'stop'"],
    [["start", "extra"], "error: too many arguments for 'start'"],
    [["start", "--task"], "error: option '--task <id...>' argument missing"],
    [["start", "--config"], "error: option '--config <file>' argument missing"],
    [["start", "--once=yes"], "error: unknown option '--once=yes'"],
    [
      ["start", "--task", "--dry-run"],
      "error: option '--task <id...>' argument '--dry-run' is invalid. a value cannot start with '-'",
    ],
    [
      ["start", "--task", "a", "--task", "-b"],
      "error: option '--task <id...>' argument '-b' is invalid.",
    ],
    [
      ["start", "--config", "--dry-run"],
      "error: option '--config <file>' argument '--dry-run' is invalid. a value cannot start with '-'",
    ],
    [
      ["start", "--config=-x.json"],
      "error: option '--config <file>' argument '-x.json' is invalid.",
    ],
  ] as const)
    test(`${argv.join(" ")} is a usage error: said on stderr with the hint, exit 1, nothing run`, async () => {
      const r = rig();
      expect(await runCommand(argv, r.deps)).toBe(1);
      expect(r.stderr.text).toContain(error);
      expect(r.stderr.text).toContain("(add --help for usage)");
      expect(r.stdout.text).toBe("");
      expect(r.started).toEqual([]);
      expect(r.prepared).toEqual([]);
    });

  test("a usage error quoting a credential is masked", async () => {
    const r = rig();
    expect(
      await runCommand(["start", `--site=${CREDENTIAL_URL}`], r.deps),
    ).toBe(1);
    expect(r.stderr.text).toContain("unknown option '--site=https://***@");
    expect(r.stderr.text).not.toContain(PASSWORD);
  });
});
