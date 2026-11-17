import { posix } from "node:path";

import { assertSafeElevatedTarget } from "./paths";
import { resolveSiteIdentity } from "./site-identity";
import {
  elevationSupport,
  execElevated,
  resolveOnTarget,
  wpRootDir,
} from "./transport-exec";
import { plain } from "../text";
import type {
  ConfigEditOutcome,
  HeldPutBack,
} from "./config-edits-declaration";
import type { ExecResult } from "./transport-exec";
import type { IdentityState } from "./site-identity";
import type { ConfigEdits, Transport } from "../config/types";

/**
 * The root fallback of the in-place cleanup (`./config-edits.ts`): an edited file the run's identity
 * judged restorable — equal to a candidate the plugin's own edits make from the record, or a strict
 * prefix of it — but cannot write, or whose mode it cannot set back, is finished by root.
 *
 * - **The identity judges, root only writes.** The engine, run as the identity, vouches for the file
 *   (its device, inode and bytes as judged), the record copy and its SHA-256; root writes those bytes
 *   and nothing else, through {@link PUT_BACK_SCRIPT}, only while the file is still as judged. `wp`
 *   and PHP never run as root.
 * - **Only a write that began fails.** A refusal, or a failure known to precede any write, is an
 *   answer: the engine's next run settles the file as without root, and warns.
 * - **Only where the record is the transport's user's**: every identity state but `site`, where
 *   commands already run as the web server — which wrote the plugin's edits, so a file it cannot
 *   write was changed by someone else — and whose record root must not take bytes from. Never with
 *   `transport.elevate: false` or without passwordless sudo: the file is then warned about and left.
 * - **In place**: same inode, owner; the bytes verified by SHA-256 through the opened file; the mode
 *   set back through it. A link at the path or in any parent (lexical and resolved checks), or a
 *   path no longer leading to the judged file, is refused.
 * - The record folder stays the identity's `0700`: root reads it, never loosens it.
 */

/** `$0` of {@link PUT_BACK_SCRIPT}'s shell, so a process listing (and `sudo`'s log) says what it is. */
const PUT_BACK_NAME = "e2e-config-put-back";

/**
 * How long, in seconds, root's put-back may take: a FIFO swapped in at a path would block its open.
 * A config file's write takes milliseconds; three held files stay inside a hook's budget at worst.
 */
export const PUT_BACK_TIMEOUT_S = 20;

/** {@link PUT_BACK_SCRIPT}'s exits besides 0. */
export const PUT_BACK_EXIT = {
  /** The record's copy, or its folder, is not the identity's private single-link file holding the bytes. */
  copyRefused: 91,
  /** Written, but the path no longer leads to the file written (moved or replaced just after). */
  moved: 92,
  /** The path no longer leads to the judged file (a link, another file), or its bytes changed since. */
  replaced: 93,
  /** Writing began but the file does not hold the recorded bytes (cut short, or stopped mid-write). */
  notPutBack: 94,
  /** Root could not stage the copy (`mktemp`, a full disk): nothing written. */
  noStaging: 95,
  /** The host lacks what the script needs (GNU `stat`, `sha256sum`): nothing done. */
  noTools: 96,
} as const;

/**
 * Exits after which nothing was written, besides the script's own: `sudo` refusing or not finding the
 * command (1), `timeout` failing or not finding its command (125–127), the script killed by `timeout`
 * before it wrote (143: `--preserve-status`; once writing it turns the signal into
 * {@link PUT_BACK_EXIT}'s `notPutBack`). Any other exit may have cut a write short.
 */
const NOTHING_WRITTEN = new Set<number>([
  1,
  PUT_BACK_EXIT.noStaging,
  PUT_BACK_EXIT.noTools,
  125,
  126,
  127,
  143,
]);

/**
 * Run as root as `sh -c PUT_BACK_SCRIPT e2e-config-put-back <target> <record folder> <copy> <uid>
 * <dev> <ino> <sha256> <mode> <write|mode> <judged sha256>`, every value an argument (no shell parses
 * one):
 *
 * 1. GNU `stat` and `sha256sum` must be there.
 * 2. `write` only: the folder must be a directory, not a link, owned by `uid`, closed to group and
 *    others; the copy is opened once (fd 4) and the **opened** file must be a regular one owned by
 *    `uid` with one link — swapping the path for a link after the check reaches nothing.
 * 3. The target must be a regular file, not a link; it is opened read-only (no create, no truncate)
 *    and the **opened** file must be the judged one (`dev`, `ino`) with one link, the path still
 *    leading to it, and its bytes still the judged ones (`judged`: a rewrite in place since the
 *    engine's verdict is never overwritten). Only that file is touched (`/dev/fd/3` reopens it).
 * 4. `write`: the copy's bytes, read from fd 4 into a root-private temporary file that must hold
 *    `sha256`, are written over it (truncate, then write: a write cut short leaves a strict prefix,
 *    which the next run resumes); then it must hold `sha256`, and its path still lead to it. `mode`:
 *    `judged` is `sha256`.
 * 5. The mode is set back through the opened file, and the modes before and after are printed
 *    (`<found> <now>`, octal, as `stat %a` prints them: no leading zero).
 *
 * Exits {@link PUT_BACK_EXIT}. Opening is the one step a FIFO swapped in could block; the caller's
 * `timeout` bounds it. A `TERM` once writing began exits `notPutBack`.
 */
export const PUT_BACK_SCRIPT = [
  "stat -c %u / >/dev/null 2>&1 && sha256sum </dev/null >/dev/null 2>&1 || exit 96;",
  'if [ "$9" = write ]; then',
  '[ -d "$2" ] && [ ! -h "$2" ] && [ "$(stat -c %u -- "$2")" = "$4" ] && [ $((0$(stat -c %a -- "$2") & 63)) -eq 0 ] || exit 91;',
  '[ ! -h "$2/$3" ] && command exec 4< "$2/$3" || exit 91;',
  '[ -f /dev/fd/4 ] && [ "$(stat -L -c %u:%h /dev/fd/4)" = "$4:1" ] || exit 91;',
  "fi;",
  '[ -f "$1" ] && [ ! -h "$1" ] || exit 93;',
  'command exec 3< "$1" || exit 93;',
  '[ "$(stat -L -c %d:%i:%h /dev/fd/3)" = "$5:$6:1" ] || exit 93;',
  '[ "$(sha256sum < /dev/fd/3)" = "${10}  -" ] || exit 93;',
  '[ "$(stat -c %d:%i -- "$1")" = "$5:$6" ] || exit 93;',
  "found=$(stat -L -c %a /dev/fd/3);",
  'if [ "$9" = write ]; then',
  "t=$(mktemp) || exit 95;",
  `trap 'rm -f -- "$t"' EXIT; trap 'exit 143' TERM;`,
  'cat <&4 > "$t" || exit 95;',
  '[ "$(sha256sum < "$t")" = "$7  -" ] || exit 91;',
  "trap 'exit 94' TERM;",
  'cat -- "$t" > /dev/fd/3 || exit 94;',
  '[ "$(sha256sum < /dev/fd/3)" = "$7  -" ] || exit 94;',
  '[ "$(stat -c %d:%i -- "$1")" = "$5:$6" ] || exit 92;',
  "fi;",
  'chmod -- "$8" /dev/fd/3 2>/dev/null;',
  'echo "$found $(stat -L -c %a /dev/fd/3)"',
].join(" ");

/** What root did with one held file. */
export type RootPutBack =
  /** Written (or, mode only, found holding the record); `found`/`now`: its mode before and after. */
  | { readonly kind: "done"; readonly found: number; readonly now: number }
  /** Written, but the path no longer leads to it: what is there now is untouched. */
  | { readonly kind: "moved" }
  /** The path no longer leads to the judged file, or its bytes changed: untouched. */
  | { readonly kind: "replaced" }
  /** A link at the path or in a parent (or a path that does not resolve): untouched. */
  | { readonly kind: "outside" }
  /** The record's copy failed root's checks: untouched. */
  | { readonly kind: "refused" }
  /** Root could not run it (no rule, tools, staging, a time-out before writing): untouched. */
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Whether the engine may hold a file for root: never with `transport.elevate: false`, and never in
 * `site`, where the record is the web server's (see the module doc). Whether sudo works is asked only
 * once something is held ({@link putBackHeld}).
 *
 * @param transport - the site.
 * @param state - who its commands run as.
 */
export function rootMayFinish(
  transport: Transport,
  state: IdentityState,
): boolean {
  return transport.elevate !== false && state.kind !== "site";
}

/**
 * {@link rootMayFinish} for the site's current identity state; resolves it only when elevation is
 * not refused outright.
 *
 * @param transport - the site.
 */
export async function mayHoldForRoot(transport: Transport): Promise<boolean> {
  if (transport.elevate === false) return false;
  return rootMayFinish(transport, await resolveSiteIdentity(transport));
}

/** A held edited file, with its declared path. */
export interface HeldFile {
  readonly index: number;
  readonly path: string;
  readonly held: HeldPutBack;
}

/**
 * The held files of an engine answer, each checked to be this run's: its path is the declaration's
 * (never the site's), its record folder the stem's for its uid.
 *
 * @param stem - the record folder without its identity (`recordStemFor`).
 * @param edits - the declaration the outcomes index.
 * @param outcomes - the engine's outcomes.
 * @throws Error on a held file whose record is not under `stem`: nothing is then written as root.
 */
export function heldFiles(
  stem: string,
  edits: ConfigEdits,
  outcomes: readonly ConfigEditOutcome[],
): HeldFile[] {
  return outcomes.flatMap((outcome): HeldFile[] => {
    const { held } = outcome;
    if (outcome.kind !== "file" || held === undefined) return [];
    const path = edits.files[outcome.index]?.path;
    if (path === undefined || held.dir !== `${stem}-${String(held.uid)}`) {
      throw new Error(
        `[wp/config-edits] the engine held "${String(path)}" for root with a record that is not this ` +
          "run's: nothing was written as root.",
      );
    }
    return [{ index: outcome.index, path, held }];
  });
}

/**
 * The script's arguments for one held file.
 *
 * @param target - the edited file's absolute path on the site.
 * @param held - what the engine vouched for.
 */
export function putBackArgv(target: string, held: HeldPutBack): string[] {
  return [
    "--preserve-status",
    "-s",
    "TERM",
    String(PUT_BACK_TIMEOUT_S),
    "sh",
    "-c",
    PUT_BACK_SCRIPT,
    PUT_BACK_NAME,
    target,
    held.dir,
    held.copy,
    String(held.uid),
    held.dev,
    held.ino,
    held.sha256,
    `0${held.mode.toString(8).padStart(3, "0")}`,
    held.write ? "write" : "mode",
    held.judged,
  ];
}

/**
 * Reads the script's result. Only a write that began and may be cut short throws: every refusal, and
 * every failure known to come before any write — one a host may give on every run (no sudo rule for
 * `timeout`, no GNU tools) — is an answer, so the engine's next run settles the file as it would
 * without root and the site is never stuck on it.
 *
 * @param result - what `timeout sh -c PUT_BACK_SCRIPT …` returned.
 * @param path - the declared path, for messages.
 * @param held - what was asked: its record folder is named when the put-back failed.
 * @returns what root did.
 * @throws Error when writing began and the file may not hold the recorded bytes, or the script ended
 * in a way not known to precede the write: the record is kept, the next run resumes.
 */
export function readPutBack(
  result: ExecResult,
  path: string,
  held: HeldPutBack,
): RootPutBack {
  const output = (): string =>
    plain((result.stderr || result.stdout).trim()).slice(0, 200) || "no output";
  switch (result.exitCode) {
    case 0: {
      // `stat %a` prints no leading zero: `40`, `4`.
      const modes = /^([0-7]{1,4}) ([0-7]{1,4})$/.exec(result.stdout.trim());
      // Exit 0 comes only after the bytes were verified: an odd answer loses nothing.
      if (modes === null) {
        return { kind: "failed", reason: `unreadable answer: ${output()}` };
      }
      return {
        kind: "done",
        found: Number.parseInt(modes[1] ?? "", 8),
        now: Number.parseInt(modes[2] ?? "", 8),
      };
    }
    case PUT_BACK_EXIT.moved:
      return { kind: "moved" };
    case PUT_BACK_EXIT.replaced:
      return { kind: "replaced" };
    case PUT_BACK_EXIT.copyRefused:
      return { kind: "refused" };
    case PUT_BACK_EXIT.notPutBack:
      throw new Error(
        `[wp/config-edits] putting "${path}" back as root failed: it does not hold its recorded bytes, ` +
          `which are kept in ${held.dir} (the site's next scenario puts them back).`,
      );
    default:
      break;
  }
  if (NOTHING_WRITTEN.has(result.exitCode)) {
    return {
      kind: "failed",
      reason: `exit ${String(result.exitCode)}: ${output()}`,
    };
  }
  throw new Error(
    `[wp/config-edits] putting "${path}" back as root failed (exit ${String(result.exitCode)}: ` +
      `${output()}); its record is kept in ${held.dir}.`,
  );
}

/**
 * Has root finish every held file of an engine answer, one at a time; none when nothing is held.
 *
 * @param transport - the site.
 * @param stem - the record folder without its identity (`recordStemFor`): a held folder must be it.
 * @param edits - the declaration the outcomes index: paths are taken from it, never from the site.
 * @param outcomes - the engine's outcomes.
 * @returns each held outcome's result, keyed by its index; `undefined` when root cannot be used (no
 * passwordless sudo): the engine's next run then answers as it would without the fallback.
 * @throws Error when a put-back may be cut short (`readPutBack`) or the site cannot be asked; the
 * record is kept.
 */
export async function putBackHeld(
  transport: Transport,
  stem: string,
  edits: ConfigEdits,
  outcomes: readonly ConfigEditOutcome[],
): Promise<ReadonlyMap<number, RootPutBack> | undefined> {
  const held = heldFiles(stem, edits, outcomes);
  const done = new Map<number, RootPutBack>();
  if (held.length === 0) return done;
  if ((await elevationSupport(transport)) !== "available") return undefined;
  const root = await wpRootDir(transport);
  for (const file of held) {
    done.set(
      file.index,
      await putBackOne(transport, root, file.path, file.held),
    );
  }
  return done;
}

/**
 * Whether the file, as the site resolves it, is exactly at its declared place in the root: no link
 * at the path or in any parent, even one staying inside the root. Stricter than
 * `assertResolvedInsideRoot`, which walks up to an ancestor when a path does not resolve — measured:
 * a parent linked into a folder the transport's user cannot enter (`/root/…`) does not resolve, and
 * the walk then passes it. The file was just judged, so it exists: one that does not resolve is
 * refused.
 *
 * @param realRoot - the root, resolved (`undefined`: it did not resolve).
 * @param realTarget - the file, resolved (`undefined`: it did not resolve).
 * @param path - the declared path, relative to the root.
 */
export function resolvesInPlace(
  realRoot: string | undefined,
  realTarget: string | undefined,
  path: string,
): boolean {
  return (
    realRoot !== undefined &&
    realTarget !== undefined &&
    realTarget === posix.join(realRoot, path)
  );
}

/**
 * Root's put-back of one file, behind the lexical check and {@link resolvesInPlace}.
 *
 * @param transport - the site.
 * @param root - the WordPress root, as the transport resolved it.
 * @param path - the declared path.
 * @param held - what the engine vouched for.
 * @throws Error when the site cannot be asked, or the put-back may be cut short (`readPutBack`).
 */
async function putBackOne(
  transport: Transport,
  root: string,
  path: string,
  held: HeldPutBack,
): Promise<RootPutBack> {
  const target = posix.join(root, path);
  try {
    assertSafeElevatedTarget(
      target,
      root,
      (reason) => `the WordPress root ${reason}`,
    );
  } catch (error) {
    // The same on every run: an answer, so the site is not stuck on it.
    return {
      kind: "failed",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  const [realRoot, realTarget] = await Promise.all([
    resolveOnTarget(transport, root),
    resolveOnTarget(transport, target),
  ]);
  if (!resolvesInPlace(realRoot, realTarget, path)) return { kind: "outside" };
  return readPutBack(
    await execElevated(transport, "timeout", putBackArgv(target, held)),
    path,
    held,
  );
}

/**
 * The final outcomes once root has run: the engine's first answer, each held file replaced by what
 * root did, checked against the engine's second answer (taken after root, when it also removed the
 * record).
 *
 * - Not held: the first answer stands (the second finds what it left).
 * - Held, root not used (`root` undefined, or no entry): the second answer's — what the engine says
 *   without the fallback.
 * - Held, done: `restored`/`resumed` by root (bytes), or the first verdict with its mode set back
 *   (mode only), the owner as the second answer reads it — unless the second answer finds the file
 *   changed again (any result but `unchanged`): that verdict stands.
 * - Held, replaced: `replaced` (bytes), or the first verdict with its mode not set back (mode only).
 * - Held, outside: `link` (bytes), or as replaced (mode only).
 * - Held, moved (bytes written, the path then led elsewhere): `moved`, by root.
 * - Held, refused: the second answer's, marked `refused` for its wording.
 * - Held, failed: the second answer's, marked `failed` with root's reason.
 *
 * @param first - the engine's answer that held files.
 * @param root - {@link putBackHeld}'s results.
 * @param second - the engine's answer after root (empty when it gave none).
 */
export function mergeRootPutBack(
  first: readonly ConfigEditOutcome[],
  root: ReadonlyMap<number, RootPutBack> | undefined,
  second: readonly ConfigEditOutcome[],
): ConfigEditOutcome[] {
  return first.map((outcome) => {
    const { held, ...judged } = outcome;
    if (held === undefined) return judged;
    const after = second.find(
      (o) => o.kind === outcome.kind && o.index === outcome.index,
    );
    const done = root?.get(outcome.index);
    if (done === undefined) return after ?? judged;
    if (done.kind === "refused") {
      return { ...(after ?? judged), asRoot: "refused" };
    }
    if (done.kind === "failed") {
      return { ...(after ?? judged), asRoot: "failed", rootError: done.reason };
    }
    if (done.kind === "moved") {
      return {
        kind: outcome.kind,
        index: outcome.index,
        result: "moved",
        asRoot: "wrote",
      };
    }
    if (done.kind !== "done") {
      if (!held.write) return judged;
      return {
        kind: outcome.kind,
        index: outcome.index,
        result: done.kind === "outside" ? "link" : "replaced",
      };
    }
    if (after !== undefined && after.result !== "unchanged") return after;
    // Root's `found` is the mode the scenario left, before its chmod: the same for bytes or mode alone.
    const owner = after === undefined ? judged.owner : after.owner;
    return {
      kind: judged.kind,
      index: judged.index,
      result: held.write
        ? held.resumed
          ? "resumed"
          : "restored"
        : judged.result,
      ...(done.found === held.mode
        ? {}
        : {
            mode: {
              found: done.found,
              recorded: held.mode,
              restored: done.now === held.mode,
            },
          }),
      ...(owner === undefined ? {} : { owner }),
      asRoot: held.write ? "wrote" : "mode",
    };
  });
}
