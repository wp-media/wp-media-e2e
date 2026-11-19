import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { isObject } from "../guards";
import { execInChildNode } from "./child-node";

/**
 * For specs: what importing a module does to the process-wide state a long-lived process (the
 * orchestrator) keeps for its whole life — its environment variables, its listeners on process
 * events (one `SIGINT` listener is enough to turn off Node's exit on Ctrl-C), its working directory,
 * its exit code, its umask (every file it creates), its listener limits, `Error.stackTraceLimit`, and
 * the functions a module could wrap to watch or steer it: `fetch` (Slack's webhook and Datator's key
 * pass through it), `process.exit`, `process.cwd`, `process.chdir`, `fs.close` and `fs.closeSync`.
 * Output written and other globals set are not compared; nor is anything a module starts later than
 * its import, from a function or an unref'd timer.
 *
 * One change is accepted, by name ({@link GRACEFUL_FS_PATCH}): graceful-fs's. Playwright bundles it
 * (`playwright-core`'s `utilsBundle.js`, and again in `playwright`'s `expect.js`), and the product
 * list reaches Playwright through the products' support modules, so importing `products.ts` wraps
 * `fs.close`, `fs.closeSync`, `process.cwd` and `process.chdir` — measured with Playwright 1.65.1. The
 * wrappers keep what they wrap (a close retries graceful-fs's queued opens; `cwd` is cached and
 * `chdir` clears the cache), and avoiding them would mean a product list that never loads its
 * products' support code. It is recognised by its marks, not by name: all four at once, each close
 * wrapping the one before through graceful-fs's `previous` symbol, `chdir` the old one through its
 * prototype chain, and `cwd` still answering the same folder. Any other wrapper is reported.
 */

/** The functions the probe compares by identity, as each effect names them. */
export const WATCHED_FUNCTIONS = [
  "fetch",
  "fs.close",
  "fs.closeSync",
  "process.chdir",
  "process.cwd",
  "process.exit",
] as const;

/** graceful-fs's wrappers: accepted only together and with graceful-fs's own marks (see above). */
export const GRACEFUL_FS_PATCH = [
  "fs.close",
  "fs.closeSync",
  "process.chdir",
  "process.cwd",
] as const;

/** The variable the probe's `.env` sets: a module that loads `.env` shows it among its effects. */
export const PROBE_SENTINEL = "E2E_PROBE_SENTINEL";

/** The entry for what changed after the last import's reading, by the time the process went idle. */
export const SETTLED = "(once the imports settled)";

/** One imported file — or {@link SETTLED} — and what changed in the process after it. */
export interface ImportEffects {
  /** The file, as the caller named it, or {@link SETTLED}. */
  readonly file: string;
  /**
   * What changed, sorted: `env <NAME>` (added, changed or removed), `listener <event> <±n>`, `cwd`,
   * `exitCode`, `umask`, `maxListeners`, `defaultMaxListeners`, `Error.stackTraceLimit`,
   * `function <name>` (one of {@link WATCHED_FUNCTIONS} replaced; graceful-fs's patch excepted). Empty
   * when the process was left as it was.
   */
  readonly effects: readonly string[];
}

/**
 * Narrows the result file's JSON to the list {@link probeImports} returns.
 *
 * @param value - the parsed result file.
 * @returns whether it is that list.
 */
function isImportEffectsList(value: unknown): value is ImportEffects[] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        isObject(entry) &&
        typeof entry.file === "string" &&
        Array.isArray(entry.effects) &&
        entry.effects.every((effect: unknown) => typeof effect === "string"),
    )
  );
}

/**
 * The child's code: import each file, let it run one turn of the event loop — a change it deferred
 * with `setImmediate` is still its own — then read the process; once nothing is left to run,
 * `beforeExit` reads it a last time and writes the result to `resultFile`. A file, not stdout: a
 * module may print, even as the process exits, and must not be able to forge or garble the verdict.
 *
 * @param files - the files to import, absolute, in order.
 * @param resultFile - where the child writes its readings.
 * @returns the child's ES-module source.
 */
function probeBody(files: readonly string[], resultFile: string): string {
  return `
    import fs, { writeFileSync } from "node:fs";
    import { EventEmitter } from "node:events";
    import { pathToFileURL } from "node:url";

    const watched = {
      fetch: () => globalThis.fetch,
      "fs.close": () => fs.close,
      "fs.closeSync": () => fs.closeSync,
      "process.chdir": () => process.chdir,
      "process.cwd": () => process.cwd,
      "process.exit": () => process.exit,
    };
    // Set and set back: \`process.umask()\` with no argument, a plain read, is deprecated (DEP0139).
    const umask = () => {
      const mask = process.umask(0o22);
      process.umask(mask);
      return mask;
    };
    const snapshot = () => ({
      env: { ...process.env },
      listeners: Object.fromEntries(
        process.eventNames().map((name) => [String(name), process.listenerCount(name)]),
      ),
      cwd: process.cwd(),
      exitCode: process.exitCode,
      umask: umask(),
      maxListeners: process.getMaxListeners(),
      defaultMaxListeners: EventEmitter.defaultMaxListeners,
      stackTraceLimit: Error.stackTraceLimit,
      functions: Object.fromEntries(Object.entries(watched).map(([name, read]) => [name, read()])),
    });
    // Whether \`fn\` leads to \`original\` through \`next\`, within a few wrappers.
    const leadsTo = (fn, original, next) => {
      for (let at = fn, depth = 0; typeof at === "function" && depth < 8; at = next(at), depth++)
        if (at === original) return true;
      return false;
    };
    const previous = Symbol.for("graceful-fs.previous");
    // graceful-fs's patch, by its marks: all four replaced, each close wrapping the one before through
    // its \`previous\` symbol, chdir the old one through its prototype, cwd still the same folder.
    const isGracefulFsPatch = (before, after, replaced) =>
      ${JSON.stringify(GRACEFUL_FS_PATCH)}.every((name) => replaced.includes(name)) &&
      leadsTo(after.functions["fs.close"], before.functions["fs.close"], (f) => f[previous]) &&
      leadsTo(after.functions["fs.closeSync"], before.functions["fs.closeSync"], (f) => f[previous]) &&
      leadsTo(after.functions["process.chdir"], before.functions["process.chdir"], Object.getPrototypeOf) &&
      before.cwd === after.cwd;
    const changes = (before, after) => {
      const effects = [];
      for (const key of new Set([...Object.keys(before.env), ...Object.keys(after.env)])) {
        if (before.env[key] !== after.env[key]) effects.push("env " + key);
      }
      for (const name of new Set([...Object.keys(before.listeners), ...Object.keys(after.listeners)])) {
        const delta = (after.listeners[name] ?? 0) - (before.listeners[name] ?? 0);
        if (delta !== 0) effects.push("listener " + name + " " + (delta > 0 ? "+" : "") + delta);
      }
      for (const key of ["cwd", "exitCode", "umask", "maxListeners", "defaultMaxListeners"]) {
        if (before[key] !== after[key]) effects.push(key);
      }
      if (before.stackTraceLimit !== after.stackTraceLimit) effects.push("Error.stackTraceLimit");
      const replaced = Object.keys(watched).filter((name) => before.functions[name] !== after.functions[name]);
      const accepted = isGracefulFsPatch(before, after, replaced) ? ${JSON.stringify(GRACEFUL_FS_PATCH)} : [];
      for (const name of replaced) if (!accepted.includes(name)) effects.push("function " + name);
      return effects.sort();
    };

    const results = [];
    let settled = false;
    // Registered before the first reading, so the probe's own listener is part of the baseline.
    process.on("beforeExit", () => {
      if (settled) return;
      settled = true;
      results.push({ file: ${JSON.stringify(SETTLED)}, effects: changes(last, snapshot()) });
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify(results));
      // An exit code a module set is reported above; the child itself succeeded.
      process.exitCode = 0;
    });
    let last = snapshot();
    for (const file of ${JSON.stringify(files)}) {
      await import(pathToFileURL(file).href);
      await new Promise((resolve) => setImmediate(resolve));
      const now = snapshot();
      results.push({ file, effects: changes(last, now) });
      last = now;
    }
  `;
}

/**
 * Imports `files` — absolute paths — one after another in a fresh Node, and returns what each import
 * changed in the process, then what changed after the last one ({@link SETTLED}). The child starts in
 * a folder of its own whose `.env` sets {@link PROBE_SENTINEL}, so it never reads the repository's
 * `.env`, and a module that loads `.env` is caught. A change is charged to the first file whose import
 * made it, transitive imports included: a module an earlier file loaded is not run again.
 *
 * @param files - absolute paths, imported in this order.
 * @returns one entry per file, in order, then the {@link SETTLED} one.
 * @throws {@link Error} for a relative path; when an import fails, the child times out (a module keeps
 * the event loop busy), or a module ends the process, so the probe never finished; for a result it
 * cannot read.
 */
export async function probeImports(
  files: readonly string[],
): Promise<ImportEffects[]> {
  const relative = files.find((file) => !isAbsolute(file));
  if (relative !== undefined) {
    throw new Error(`probeImports needs absolute paths, got "${relative}"`);
  }
  const dir = await mkdtemp(join(tmpdir(), "e2e-import-probe-"));
  try {
    await writeFile(join(dir, ".env"), `${PROBE_SENTINEL}=from-dotenv\n`);
    const resultFile = join(dir, "result.json");
    const output = await execInChildNode(probeBody(files, resultFile), {
      cwd: dir,
    });
    const text = await readFile(resultFile, "utf8").catch(() => {
      throw new Error(
        "the import probe never finished: a module ended the process during its import " +
          `(stdout: ${output.stdout.trim().slice(-500)}; stderr: ${output.stderr.trim().slice(-500)})`,
      );
    });
    const result: unknown = JSON.parse(text);
    if (!isImportEffectsList(result)) {
      throw new Error(`the import probe wrote an unexpected result: ${text}`);
    }
    return result;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
