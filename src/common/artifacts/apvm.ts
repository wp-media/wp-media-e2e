/**
 * The APVM boundary: a lazily-created, per-process {@link Apvm} instance, the token rules that
 * gate private-repo builds, and a progress reporter that turns APVM's event stream into concise
 * console lines while buffering command output for failure diagnostics.
 *
 * This is the only module that imports `apvm-napi` (loading its native binding), so pure logic
 * (`request.ts`, `manifest.ts`) and the identity preflight (`verify.ts`) stay free of it and of
 * the native dependency. `resolve.ts` (a run) and `warm.ts` (pre-warming) are its callers.
 */

import { Apvm } from "apvm-napi";
import type { JsBuildEvent } from "apvm-napi";

import { env } from "../config/env";
import { workerPrinters } from "../config/output";
import type { Printers } from "../config/output";
import { maskValues, plain, redactSecrets, withoutFormat } from "../text";
import type { ArtifactOrigin } from "./types";

/**
 * Projects whose source repository is **private**, so a build/warm needs a GitHub token.
 * BackWPup builds from `wp-media/backwpup-pro` (private); WP Rocket and Imagify are public
 * (a token there only raises rate limits). Kept as data so adding a private
 * product later is a one-line change.
 */
const TOKEN_REQUIRED_PROJECTS: ReadonlySet<string> = new Set(["backwpup"]);

/** The fix shown whenever a token is required but absent — the two ways to provide one. */
export const TOKEN_HINT =
  "Set GITHUB_TOKEN (a PAT with `repo` scope) or run `gh auth login`, then re-run.";

/** Whether building {@link project} requires a GitHub token (its source repo is private). */
export function requiresToken(project: string): boolean {
  return TOKEN_REQUIRED_PROJECTS.has(project);
}

/**
 * The process-wide {@link Apvm} instance, created once. Cached as the **promise** (not the
 * resolved value) so concurrent callers share a single `createWithTokenResolution` — which may
 * shell out to `gh auth token` — rather than racing to build several instances.
 */
let instance: Promise<Apvm> | undefined;

/**
 * Returns the lazily-created, process-wide {@link Apvm}. Token resolution follows APVM's own
 * order (config → `GITHUB_TOKEN` → `GH_TOKEN` → `gh` CLI → gh config); we never set `cacheDir`,
 * leaving APVM's cache at its default `~/.apvm/cache`. Created only on first build —
 * a placeholder-only run that skips resolution never triggers token resolution.
 */
export function getApvm(): Promise<Apvm> {
  instance ??= Apvm.createWithTokenResolution({}).catch((error: unknown) => {
    // Drop the failed promise so a later role/request retries rather than inheriting a
    // one-off failure (token resolution may shell out to `gh`, which can fail transiently).
    instance = undefined;
    throw error;
  });
  return instance;
}

/**
 * Narrows APVM's per-artifact `origin` string to our {@link ArtifactOrigin}. An unknown value reads
 * as `"built"` — the conservative claim, since it never suggests a build was skipped.
 */
export function toArtifactOrigin(origin: string): ArtifactOrigin {
  return origin === "built" || origin === "cache" || origin === "downloaded"
    ? origin
    : "built";
}

/**
 * Throws an actionable error if {@link project} needs a token and {@link apvm} has none — caught
 * *before* any clone/download is attempted, so a missing token surfaces as one clear message
 * with the fix, not a deep-in-the-build git failure.
 */
export function assertToken(
  apvm: Pick<Apvm, "hasToken">,
  project: string,
): void {
  if (requiresToken(project) && !apvm.hasToken()) {
    throw new Error(
      `Building "${project}" needs a GitHub token — its source repository is private. ${TOKEN_HINT}`,
    );
  }
}

// A private-repo build authenticates with a GitHub token, and raw builder output is third-party
// text: everything kept from it reaches a console log and the error a Playwright HTML/Allure report
// keeps, which CI publishes — so it is masked (`redactBuildText`) on its way out.

/**
 * A build's or a warm's text with every credential masked: by shape ({@link redactSecrets}), and the
 * GitHub tokens this process holds by value — a legacy token is 40 hex digits, which no pattern can
 * tell from a commit. A token APVM reads from its own config or `gh` is masked by shape alone.
 * Invisible format characters go first: one inside a token hides it from both masks, and a printer
 * that later drops it would show the token whole.
 *
 * @param text - what APVM, git or a build step said.
 */
export function redactBuildText(text: string): string {
  return redactSecrets(
    maskValues(withoutFormat(text), [env("GITHUB_TOKEN"), env("GH_TOKEN")]),
  );
}

/** How many trailing command-output lines to retain for a failed build's error context. */
const OUTPUT_TAIL = 40;

/** A build/warm progress reporter: the APVM callback plus the failure context it accumulates. */
export interface BuildReporter {
  /** Pass as the `onProgress` argument to `apvm.build()` / `apvm.warmCache()`. */
  readonly onProgress: (err: Error | null, event: JsBuildEvent) => void;
  /**
   * A formatted tail of the build — the `build_failed` reason and the last command-output lines —
   * to append to a thrown error when a build rejects. Empty when nothing noteworthy was seen.
   */
  failureContext(): string;
}

/**
 * Creates a {@link BuildReporter} for one build. Progress maps to concise console lines
 * (`phase_started`, `warning`); `command_output` stays quiet but is buffered, so on failure the
 * reason and the last {@link OUTPUT_TAIL} output lines can be attached to the error.
 *
 * Redaction placement follows where the text *escapes*: lines printed as they arrive are
 * scrubbed on arrival (made one {@link plain} line first: no escape reaches the terminal), while the buffer — private to this closure and only ever read by
 * {@link BuildReporter.failureContext} — is scrubbed once on the way out. A build emits tens of
 * thousands of output lines and at most one failure context, so this is the same guarantee for a
 * fraction of the work.
 *
 * @param label - short identifier for the artifact being built (e.g. `plugin develop`), prefixed
 * onto each line so parallel-free serial builds still read clearly.
 * @param printers - where progress (`out`) and warnings (`err`) go, each with its stream's palette.
 * By default a test worker's: `console.log`/`console.warn`, colourless (the run's reporter prints a
 * worker's output) with the run's symbols. A script printing to a terminal passes its own.
 */
export function createBuildReporter(
  label: string,
  printers: Printers = workerPrinters(),
): BuildReporter {
  const { out, err: warn } = printers;
  const tail: string[] = [];
  let failureReason: string | undefined;

  const onProgress = (err: Error | null, event: JsBuildEvent): void => {
    // Error-first callback: ignore transport errors and absent events (per apvm-napi's contract).
    if (err !== null || (event as JsBuildEvent | undefined) === undefined)
      return;
    switch (event.type) {
      case "phase_started":
        out.print(
          `  ${out.palette.paint("dim", `[${label}]`)} ${String(event.phase)}` +
            (event.message !== undefined
              ? `: ${redactBuildText(plain(event.message))}`
              : ""),
        );
        break;
      case "warning":
        if (event.message !== undefined) {
          warn.print(
            `  ${warn.palette.paint("warn", `[${label}] warning:`)} ${redactBuildText(plain(event.message))}`,
          );
        }
        break;
      case "command_output":
        if (event.line !== undefined) {
          tail.push(event.line);
          if (tail.length > OUTPUT_TAIL) tail.shift();
        }
        break;
      case "build_failed":
        failureReason = event.reason;
        break;
      default:
        break;
    }
  };

  const failureContext = (): string => {
    const parts: string[] = [];
    if (failureReason !== undefined) parts.push(`\n  reason: ${failureReason}`);
    if (tail.length > 0) {
      parts.push(
        `\n  last output:\n${tail.map((line) => `    ${line}`).join("\n")}`,
      );
    }
    // Scrub on the way out — this is the only place the buffer and the reason are exposed.
    return redactBuildText(parts.join(""));
  };

  return { onProgress, failureContext };
}
