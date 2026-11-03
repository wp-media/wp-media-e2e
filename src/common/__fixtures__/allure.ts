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
 * What a stub CLI does: succeed; fail with exit 3 after printing more than an error keeps; hang; or
 * hang and, on SIGTERM, write into its output 300 ms later before exiting (`slow-stop`).
 */
export type StubBehaviour = "ok" | "fail" | "hang" | "slow-stop";

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
 * writes a partial output and never ends; `slow-stop` too, but answers SIGTERM by writing into its
 * output 300 ms later, then exiting.
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
// A file without an extension, outside any package: CommonJS, so a top-level return ends the script.
if (behaviour === "slow-stop") {
  process.on("SIGTERM", () => setTimeout(() => {
    fs.mkdirSync(path.join(out, "late"), { recursive: true });
    process.exit(0);
  }, 300));
}
if (behaviour === "hang" || behaviour === "slow-stop") { setInterval(() => {}, 1000); return; }
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
