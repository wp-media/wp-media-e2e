import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { PLAYWRIGHT_TRACE_TYPE } from "../reporting/allure-results";

/**
 * For the Allure specs: a run's raw results as allure-playwright writes them, and a stub Allure CLI
 * that does in a few milliseconds what the real one does to its output and history — or fails, or
 * hangs, as a spec needs.
 */

/** The fixture's file names, so specs can find each one. */
export const FIXTURE = {
  /** A passing test with a stdout attachment at the top. */
  passed: "aaaa-result.json",
  /** A failing test with a screenshot and a trace, each in a wrapper step, and a nested trace. */
  failed: "bbbb-result.json",
  container: "cccc-container.json",
  stdout: "a1-attachment.txt",
  screenshot: "b1-attachment.png",
  trace: "b2-attachment.zip",
  nestedTrace: "b3-attachment.zip",
  fixtureTrace: "c1-attachment.zip",
  environment: "environment.properties",
} as const;

/**
 * Writes a results folder: two tests, a container, attachments (three traces among them) and the run
 * facts' `environment.properties`.
 *
 * @param dir - the folder; created.
 * @returns it.
 */
export function writeAllureResults(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const attachment = (name: string, source: string, type: string) => ({
    name,
    source,
    type,
  });
  const wrapper = (name: string, source: string, type: string) => ({
    name,
    status: "passed",
    steps: [],
    attachments: [attachment(name, source, type)],
  });
  const results: Record<string, unknown> = {
    [FIXTURE.passed]: {
      uuid: "aaaa",
      name: "a passing scenario",
      historyId: "h-a",
      status: "passed",
      attachments: [attachment("stdout", FIXTURE.stdout, "text/plain")],
      steps: [
        {
          name: "Given it works",
          status: "passed",
          steps: [],
          attachments: [],
        },
      ],
      start: 1,
      stop: 2,
    },
    [FIXTURE.failed]: {
      uuid: "bbbb",
      name: "a failing scenario",
      historyId: "h-b",
      status: "failed",
      statusDetails: { message: "boom" },
      attachments: [],
      steps: [
        {
          name: "When it breaks",
          status: "failed",
          // A trace nested in a step that holds more: the attachment goes, the step stays.
          steps: [
            { name: "click", status: "passed", steps: [], attachments: [] },
          ],
          attachments: [
            attachment("trace", FIXTURE.nestedTrace, PLAYWRIGHT_TRACE_TYPE),
          ],
        },
        wrapper("screenshot", FIXTURE.screenshot, "image/png"),
        wrapper("trace", FIXTURE.trace, PLAYWRIGHT_TRACE_TYPE),
      ],
      start: 3,
      stop: 4,
    },
    [FIXTURE.container]: {
      uuid: "cccc",
      children: ["aaaa"],
      befores: [
        {
          name: "fixture",
          steps: [],
          attachments: [
            attachment("trace", FIXTURE.fixtureTrace, PLAYWRIGHT_TRACE_TYPE),
          ],
        },
      ],
      afters: [],
    },
  };
  for (const [name, content] of Object.entries(results)) {
    writeFileSync(join(dir, name), JSON.stringify(content));
  }
  writeFileSync(join(dir, FIXTURE.stdout), "hello\n");
  writeFileSync(join(dir, FIXTURE.screenshot), Buffer.alloc(64, 1));
  for (const zip of [
    FIXTURE.trace,
    FIXTURE.nestedTrace,
    FIXTURE.fixtureTrace,
  ]) {
    writeFileSync(join(dir, zip), Buffer.alloc(4096, 7));
  }
  writeFileSync(join(dir, FIXTURE.environment), "Plugin = BackWPup\n");
  return dir;
}

/**
 * What a stub CLI does: succeed; succeed after 1.5 s, any signal in that time killing it as it would
 * Allure (`slow-ok`); succeed with a page nobody may read (`unreadable-page`: its
 * `awesome/index.html` mode 000); fail with exit 3 after printing more than an error keeps; hang; or
 * hang and, on SIGTERM, write into its output 300 ms later before exiting (`slow-stop`); or hang and
 * ignore SIGTERM, so only SIGKILL ends it (`ignore-term`). A hanging stub exits on its own after
 * {@link STUB_HANG_MS}, so a spec that fails to stop one never leaves it running.
 */
export type StubBehaviour =
  | "ok"
  | "slow-ok"
  | "unreadable-page"
  | "fail"
  | "hang"
  | "slow-stop"
  | "ignore-term";

/** How long a hanging stub runs before it exits on its own: far past any spec's deadline. */
export const STUB_HANG_MS = 60_000;

/** How long a spec waits for a stopped build or generation to end: seconds, never a spec's timeout. */
export const STOP_DEADLINE_MS = 10_000;

/**
 * What a promise settles to, or a named failure once `ms` have passed: a stop that no longer ends a
 * child fails its spec in seconds, saying what hung, instead of at the spec's timeout.
 *
 * @param promise - what should settle.
 * @param what - what it is, for the failure: `the stopped build`.
 * @param ms - the deadline; {@link STOP_DEADLINE_MS} by default.
 * @returns its value.
 * @throws {@link Error} `<what> did not end within <ms> ms` when it does not settle in time.
 */
export async function endsWithin<T>(
  promise: Promise<T>,
  what: string,
  ms: number = STOP_DEADLINE_MS,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${what} did not end within ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** The first line the `fail` stub prints: far more than an error keeps comes after it. */
export const STUB_OUTPUT_HEAD = "stub: first line";

/** What a stub recorded about the call: written to `calls.jsonl` beside it. */
export interface StubCall {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly pid: number;
  readonly history: string | undefined;
  readonly singleFile: string | undefined;
  /** The results folder's entries, as the stub saw them. */
  readonly results: readonly string[];
}

/**
 * Writes a stub `allure` CLI. Like `allure generate`, it writes into `-o` (`index.html` holding
 * `--name`) and appends one line to `ALLURE_HISTORY`; `fail` also does both before exiting 3 after
 * printing {@link STUB_OUTPUT_HEAD}, 20 KiB of two-byte characters and a last line on stderr; `hang`
 * writes a partial output and ends only when killed (or after {@link STUB_HANG_MS}, exit 9);
 * `slow-stop` too, but answers SIGTERM by writing into its output 300 ms later, then exiting.
 *
 * @param dir - where it goes; its calls are logged to `<dir>/calls.jsonl`.
 * @param behaviour - what it does.
 * @returns its path.
 */
export function writeAllureStub(dir: string, behaviour: StubBehaviour): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, `allure-${behaviour}`);
  const calls = join(dir, "calls.jsonl");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const out = args[args.indexOf("-o") + 1];
const name = args[args.indexOf("--name") + 1];
const results = args[1];
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  args, cwd: process.cwd(), pid: process.pid,
  history: process.env.ALLURE_HISTORY, singleFile: process.env.ALLURE_SINGLE_FILE,
  results: fs.readdirSync(results).sort(),
}) + "\\n");
fs.mkdirSync(path.join(out, "awesome"), { recursive: true });
fs.writeFileSync(path.join(out, "awesome", "index.html"), "<title>" + name + "</title>");
const behaviour = ${JSON.stringify(behaviour)};
if (behaviour === "unreadable-page") fs.chmodSync(path.join(out, "awesome", "index.html"), 0o000);
// A file without an extension, outside any package: CommonJS, so a top-level return ends the script.
if (behaviour === "slow-stop") {
  process.on("SIGTERM", () => setTimeout(() => {
    fs.mkdirSync(path.join(out, "late"), { recursive: true });
    process.exit(0);
  }, 300));
}
if (behaviour === "ignore-term") process.on("SIGTERM", () => {});
if (behaviour === "hang" || behaviour === "slow-stop" || behaviour === "ignore-term") {
  setTimeout(() => process.exit(9), ${String(STUB_HANG_MS)});
  return;
}
// Blocks without a handler: a signal now ends it as its default action would end Allure.
if (behaviour === "slow-ok") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
fs.appendFileSync(process.env.ALLURE_HISTORY, JSON.stringify({ name }) + "\\n");
if (behaviour === "fail") {
  // Written synchronously: a pipe is asynchronous on macOS, and the exit would cut it short.
  fs.writeSync(2, ${JSON.stringify(STUB_OUTPUT_HEAD)} + "\\n" + "é".repeat(10240) + "\\n");
  fs.writeSync(2, "stub: generation exploded\\n");
  process.exit(3);
}
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * Writes a stub `allure` for `allure open`: records its arguments to `<dir>/serve.json` and exits
 * with `exitCode`.
 *
 * @param dir - where it goes.
 * @param exitCode - its exit status.
 * @returns its path.
 */
export function writeServeStub(dir: string, exitCode: number): string {
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, "allure-serve");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
require("node:fs").writeFileSync(${JSON.stringify(join(dir, "serve.json"))}, JSON.stringify(process.argv.slice(2)));
process.exit(${String(exitCode)});
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * The calls a stub recorded.
 *
 * @param dir - the folder the stub was written to.
 */
export function stubCalls(dir: string): StubCall[] {
  const calls = join(dir, "calls.jsonl");
  if (!existsSync(calls)) return [];
  return readFileSync(calls, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as StubCall);
}
