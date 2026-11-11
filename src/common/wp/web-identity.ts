import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";

import {
  assertAllResolvedInsideRoot,
  elevationSupport,
  exec,
  execElevated,
  wpRootDir,
} from "./exec";
import { assertSafeElevatedTarget } from "./paths";
import { probeSiteOwnership } from "./ownership";
import { MAX_ID } from "../config/run-as";
import { errorMessage, isObject } from "../guards";
import { printableLine } from "../text";
import type { APIRequest } from "@playwright/test";
import type { ExecResult } from "./exec";
import type { SiteOwnership } from "./ownership";
import type { Transport } from "../config/types";

/**
 * Who the website's PHP runs as, asked of the web server itself, and the verdict a run's workers read.
 *
 * Running site commands as the docroot's owner is only right when that owner **is** the web server's
 * identity: on a deployment-account docroot (`sftp_x:www-data`, the web server reaching it through
 * the group) it would write files the web server cannot write. Nothing on the host's shell says which
 * user PHP-FPM or Apache runs PHP as, so the pre-flight asks the web server: it drops a tiny PHP file
 * into the WordPress root, fetches it over HTTP, and reads back the worker's effective ids, names,
 * umask and SAPI ({@link probeWebIdentity}). {@link checkWebIdentity} turns that and the docroot's
 * owner into a {@link SiteIdentityVerdict}; the setup writes every site's verdict to
 * {@link SITE_IDENTITY_FILE}, and workers read it back (the `resolution.json` pattern).
 *
 * The file is a live, servable script, so it is kept harmless and short-lived: its content is a
 * constant (no value from anywhere is written into it), its name holds 128 random bits, it is created
 * `0644` by an `O_EXCL` open that never follows or replaces anything already there (not even a
 * symlink planted after the path guards ran), it is removed in a `finally`, and each
 * probe first sweeps the copies older than an hour a killed run left — matching exactly
 * `e2e-identity-<32 hex>.php`, in the root only.
 *
 * Every command here runs as the **transport's** user, root only when that user cannot write the root
 * (the identity is what is being found out, so it cannot be used yet), under the elevation rules of
 * `exec.ts`: the lexical and resolved path guards, and `transport.elevate: false` refusing it.
 */

// ── The probe file ───────────────────────────────────────────────────────────────────────────────

/** The probe file's name: the prefix, 32 lower-case hex digits (128 random bits), `.php`. */
export const PROBE_FILE_NAME = /^e2e-identity-[0-9a-f]{32}\.php$/;

/** What the probe prints in its `e2e` field, so an unrelated JSON page is never read as an answer. */
const PROBE_MARK = "identity";

/**
 * The probe's PHP, a constant. It prints one JSON object: the worker's effective uid and gid, their
 * names (`null` when the system cannot map one), the umask as four octal digits, and the SAPI. Without
 * the `posix` extension, or with any of its four functions disabled, it says so (`"error": "no-posix"`)
 * rather than guessing: `getmyuid()` is the file's owner, not the process's.
 */
export const PROBE_PHP = `<?php
header( 'Content-Type: application/json' );
header( 'Cache-Control: no-store' );
if ( ! function_exists( 'posix_geteuid' ) || ! function_exists( 'posix_getegid' )
	|| ! function_exists( 'posix_getpwuid' ) || ! function_exists( 'posix_getgrgid' ) ) {
	echo json_encode( array( 'e2e' => '${PROBE_MARK}', 'error' => 'no-posix' ) );
	return;
}
$e2e_user  = posix_getpwuid( posix_geteuid() );
$e2e_group = posix_getgrgid( posix_getegid() );
echo json_encode(
	array(
		'e2e'   => '${PROBE_MARK}',
		'euid'  => posix_geteuid(),
		'egid'  => posix_getegid(),
		'user'  => is_array( $e2e_user ) ? $e2e_user['name'] : null,
		'group' => is_array( $e2e_group ) ? $e2e_group['name'] : null,
		'umask' => sprintf( '%04o', umask() ),
		'sapi'  => PHP_SAPI,
	)
);
`;

/**
 * Writes `$1` to the new file `$2`, mode `0644` (`umask 022`). `dd conv=excl` opens with
 * `O_CREAT|O_EXCL`, which fails on **any** existing last component, a symlink included, and never
 * follows one: a symlink planted between the path guards and the write (the web server's user may own
 * the root) is refused, never written through (the parents: {@link ROOT_WRITE_SCRIPT}). Not the
 * shell's `set -C`: dash and bash open a path that resolves to a non-regular file (a FIFO, a device)
 * without `O_EXCL` (measured). A `dd` without `conv=excl` (BSD, BusyBox) refuses the operand before
 * opening anything: reported as that, never retried as root.
 */
export const WRITE_SCRIPT = `umask 022 && printf '%s' "$1" | dd of="$2" conv=excl status=none`;

/** {@link ROOT_WRITE_SCRIPT}'s exit when it refused to write: the root no longer is the one checked. */
export const ROOT_MOVED_EXIT = 3;

/**
 * Root's write: {@link WRITE_SCRIPT}'s, run from **inside** the root. `O_EXCL` guards the last path
 * component only; a root renamed and replaced by a symlink between the guards and the write would
 * lead an absolute `of=` elsewhere. So it enters the root (`cd -P`), refuses ({@link ROOT_MOVED_EXIT},
 * nothing written) unless `pwd -P` is the root as the guards resolved it, and writes `./<name>`
 * relative to that directory, which no later rename can move. Residual: another directory renamed
 * onto the resolved path itself still takes the write, at that path — staging it needs write access
 * to the root's parent. `$1` the content, `$2` the file name, `$3` the root, `$4` its resolved path.
 */
export const ROOT_WRITE_SCRIPT = [
  `if ! { cd -P -- "$3" && [ "$(pwd -P)" = "$4" ]; }; then`,
  `  echo 'the WordPress root no longer resolves to the path the guards checked' >&2; exit ${String(ROOT_MOVED_EXIT)}`,
  "fi",
  `umask 022 && printf '%s' "$1" | dd of="./$2" conv=excl status=none`,
].join("\n");

/**
 * How a probe write failed, read from its stderr:
 * - `no-excl`: this `dd` lacks `conv=excl` and refused the operand before opening anything — BSD's
 *   `unknown conversion excl`, BusyBox's `invalid argument 'excl' to 'conv'`, older GNU's
 *   `invalid conversion: 'excl'` (measured on the first two; GNU's is coreutils' wording);
 * - `exists`: something is already at the path (`O_EXCL`), never ours to remove;
 * - `denied`: a permission refusal (`EACCES`), the one failure root may get past;
 * - `other`: anything else (a full disk, a read-only file system…), which may have left a partial file.
 */
export type WriteFailure = "no-excl" | "exists" | "denied" | "other";

/** `dd`'s wordings for an unknown `conv=excl`, BSD/older GNU and BusyBox. */
const NO_EXCL =
  /(?:unknown|invalid) conversion:?\W*excl\b|invalid argument\W+excl\W+to\W+conv\b/;

/**
 * Classifies a failed probe write. Pure.
 *
 * @param stderr - the write's stderr.
 * @returns see {@link WriteFailure}.
 */
export function writeFailure(stderr: string): WriteFailure {
  if (NO_EXCL.test(stderr)) return "no-excl";
  if (stderr.includes("File exists")) return "exists";
  if (stderr.includes("Permission denied")) return "denied";
  return "other";
}

/**
 * A fresh probe file name.
 *
 * @param random - 16 random bytes (injectable for specs).
 * @returns `e2e-identity-<32 hex>.php`.
 */
export function probeFileName(random: Buffer = randomBytes(16)): string {
  return `e2e-identity-${random.toString("hex")}.php`;
}

/**
 * The URL the probe file is served at: the name, resolved against `baseURL` read as a directory, so a
 * site under a path (`https://host/blog`) keeps it; `baseURL`'s query and fragment are dropped.
 *
 * @param baseURL - the site's address.
 * @param name - the probe file's name.
 * @returns the absolute URL.
 * @throws TypeError when `baseURL` is not a URL.
 * @example
 * ```ts
 * probeUrl("https://host/blog", "e2e-identity-….php"); // "https://host/blog/e2e-identity-….php"
 * ```
 */
export function probeUrl(baseURL: string, name: string): string {
  const base = new URL(baseURL);
  base.search = "";
  base.hash = "";
  let end = base.pathname.length;
  // A loop, not `/\/+$/`, which backtracks quadratically on a long run of slashes.
  while (end > 0 && base.pathname.charCodeAt(end - 1) === 47) end -= 1;
  base.pathname = `${base.pathname.slice(0, end)}/`;
  return new URL(name, base).href;
}

// ── What the web server answered ─────────────────────────────────────────────────────────────────

/** Who the web server's PHP runs as, read from the probe's output. */
export interface WebIdentity {
  readonly euid: number;
  readonly egid: number;
  /** The user's name; absent when the server could not map the id. */
  readonly user?: string;
  /** The group's name; absent when the server could not map the id. */
  readonly group?: string;
  /** Four octal digits. */
  readonly umask: string;
  /** PHP's SAPI (`fpm-fcgi`, `apache2handler`, …). */
  readonly sapi: string;
}

/** What {@link parseProbeOutput} read: an identity, or the probe's own "no posix" answer. */
export type ProbeOutput =
  | { readonly kind: "identity"; readonly identity: WebIdentity }
  | { readonly kind: "no-posix" };

/** A name or SAPI the probe may report: printable, no `:` (it would split `user:group`), at most 64 code points. */
const PRINTABLE_WORD = /^[^\p{C}:]{1,64}$/u;

/**
 * An id as the probe prints it.
 *
 * @param value - a parsed JSON value.
 */
function isId(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_ID
  );
}

/**
 * A name field: `null` or absent (unmapped; the verdict file omits it) or a printable word.
 *
 * @param value - a parsed JSON value.
 * @returns the name, `undefined` for `null` or absent, or `false` when the value is neither.
 */
function nameField(value: unknown): string | undefined | false {
  if (value === null || value === undefined) return undefined;
  return typeof value === "string" && PRINTABLE_WORD.test(value)
    ? value
    : false;
}

/**
 * Reads the probe's response body. Strict on what it needs, tolerant of extra fields and of a UTF-8 BOM
 * before the JSON (a BOM-saved `wp-config.php` or `auto_prepend_file` prints one); anything else (an
 * HTML error page, PHP source served as text, another JSON) is not an answer.
 *
 * @param body - the response body.
 * @returns what the probe said, or `undefined` when the body is not the probe's output.
 */
export function parseProbeOutput(body: string): ProbeOutput | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(body.startsWith("\uFEFF") ? body.slice(1) : body);
  } catch {
    return undefined;
  }
  if (!isObject(doc) || doc.e2e !== PROBE_MARK) return undefined;
  if (doc.error === "no-posix") return { kind: "no-posix" };
  const identity = webIdentityFrom(doc);
  return identity === undefined ? undefined : { kind: "identity", identity };
}

/**
 * The {@link WebIdentity} fields of a parsed object, validated; other fields ignored.
 *
 * @param doc - the probe's output, or a stored verdict's `web`.
 * @returns the identity, or `undefined` when a field is missing or malformed.
 */
function webIdentityFrom(
  doc: Record<string, unknown>,
): WebIdentity | undefined {
  const { euid, egid, umask, sapi } = doc;
  const user = nameField(doc.user);
  const group = nameField(doc.group);
  if (
    !isId(euid) ||
    !isId(egid) ||
    user === false ||
    group === false ||
    typeof umask !== "string" ||
    !/^[0-7]{4}$/.test(umask) ||
    typeof sapi !== "string" ||
    !PRINTABLE_WORD.test(sapi)
  ) {
    return undefined;
  }
  return {
    euid,
    egid,
    ...(user !== undefined ? { user } : {}),
    ...(group !== undefined ? { group } : {}),
    umask,
    sapi,
  };
}

/** Why the web server's identity could not be read. */
export type WebProbeFailure =
  /** Neither the transport's user nor root (unavailable or refused) could write the probe file. */
  | "not-writable"
  /** The request failed: no connection, TLS, a timeout. */
  | "unreachable"
  /** Not a 200: a 404 is WordPress in a subdirectory of the root, or a docroot elsewhere. */
  | "not-served"
  /** A 200 that is not the probe's output: PHP not run for the file, an error page, a cache. */
  | "not-probe-output"
  /** PHP runs without the `posix` extension, so it cannot say who it runs as. */
  | "no-posix";

/** What {@link probeWebIdentity} found. */
export type WebProbeResult =
  | { readonly kind: "identified"; readonly identity: WebIdentity }
  | {
      readonly kind: "unverified";
      readonly reason: WebProbeFailure;
      /** One printable line for a report; never a credential. */
      readonly detail: string;
    };

// ── Writing, fetching and removing the probe ─────────────────────────────────────────────────────

/** Who wrote the probe file, so the same identity removes it. */
type Writer = "transport" | "root";

/** Options for {@link probeWebIdentity}; the defaults are what a run uses. */
export interface WebProbeOptions {
  /** How long the request may take, in milliseconds. */
  readonly timeoutMs?: number;
  /** The file name (specs pin one); a fresh {@link probeFileName} by default. */
  readonly name?: string;
  /** The largest body read as an answer, in bytes; a bigger one is not the probe's. */
  readonly maxBodyBytes?: number;
}

/** The request's default time limit: past a slow site's first PHP-FPM spawn. */
export const PROBE_TIMEOUT_MS = 15_000;

/** The largest probe body accepted: the probe prints well under a kilobyte. */
const MAX_BODY_BYTES = 16_384;

/**
 * The rule broken when a privileged write or removal of the probe file would land outside the root.
 *
 * @param reason - the guard's reason.
 */
function rootRejection(reason: string): string {
  return (
    `[wp/web-identity] refusing a privileged write or removal of the identity probe: the WordPress ` +
    `root ${reason}.`
  );
}

/**
 * Runs the path guards for a privileged command on `paths` (lexical, then resolved on the site).
 *
 * @param transport - the site.
 * @param root - its WordPress root.
 * @param paths - the absolute paths the command acts on.
 * @returns the root as the check resolved it when they pass, else the refusal's message.
 * @throws Error if the transport failed while resolving (a refusal is returned, never thrown).
 */
async function guardRefusal(
  transport: Transport,
  root: string,
  paths: readonly string[],
): Promise<{ readonly refused: string } | { readonly realRoot: string }> {
  // The guards throw a plain Error either way: the callback marks which throws are refusals.
  let refused: string | undefined;
  /**
   * The guards' message builder, recording that a refusal (not the transport) threw.
   *
   * @param reason - the rule broken.
   */
  const reject = (reason: string): string => {
    refused = rootRejection(reason);
    return refused;
  };
  try {
    for (const path of paths) assertSafeElevatedTarget(path, root, reject);
    const realRoot = await assertAllResolvedInsideRoot(
      transport,
      paths,
      root,
      reject,
    );
    // Never undefined with paths to check; an empty list is no caller's.
    return { realRoot: realRoot ?? root };
  } catch (error) {
    if (refused !== undefined) return { refused };
    throw error;
  }
}

/**
 * Creates the probe file as the transport's user, else as root when that user's write was refused
 * for permission and elevation is available. A failed write that may have created a partial file is
 * followed by its removal as the same identity (`rm -f` unlinks a symlink, never its target).
 *
 * @param transport - the site.
 * @param root - its WordPress root.
 * @param path - the probe file's absolute path, inside `root`.
 * @returns who wrote it, or why nobody could (the user's own failure always named).
 * @throws Error if the transport failed, or a guard refused the privileged write (a root that leads
 * out of itself is a misconfiguration to stop on, not a probe to give up).
 */
async function writeProbeFile(
  transport: Transport,
  root: string,
  path: string,
): Promise<{ readonly writer: Writer } | { readonly refused: string }> {
  const own = await exec(
    transport,
    "sh",
    ["-c", WRITE_SCRIPT, "sh", PROBE_PHP, path],
    { cwd: "/" },
  );
  if (own.exitCode === 0) return { writer: "transport" };
  const failure = writeFailure(own.stderr);
  if (failure === "no-excl") {
    return {
      refused:
        `the site's dd lacks conv=excl (${firstLine(own)}), which the probe's write needs to never ` +
        "follow what is already at its path; nothing was written",
    };
  }
  const userFailed = `the transport's user's write failed (${firstLine(own)})`;
  await clearFailedWrite(transport, root, path, failure, "transport");
  if (failure !== "denied") return { refused: userFailed };
  const elevation = await elevationSupport(transport);
  if (elevation !== "available") {
    return { refused: `${userFailed} and elevation is ${elevation}` };
  }
  const guard = await guardRefusal(transport, root, [path]);
  if ("refused" in guard) throw new Error(guard.refused);
  const argv = [
    "-c",
    ROOT_WRITE_SCRIPT,
    "sh",
    PROBE_PHP,
    posix.basename(path),
    root,
    guard.realRoot,
  ];
  const elevated = await execElevated(transport, "sh", argv, { cwd: "/" });
  if (elevated.exitCode === 0) return { writer: "root" };
  if (elevated.exitCode !== ROOT_MOVED_EXIT) {
    await clearFailedWrite(
      transport,
      root,
      path,
      writeFailure(elevated.stderr),
      "root",
    );
  }
  return { refused: `${userFailed}, and root's too (${firstLine(elevated)})` };
}

/**
 * Removes what a failed write may have created (a full disk fails `dd` after its open created the
 * file), unless it failed because something was already there or it never opened. A removal that
 * fails is a warning: the sweep takes the file once it is an hour old.
 *
 * @param transport - the site.
 * @param root - its WordPress root.
 * @param path - the probe file's absolute path.
 * @param failure - how the write failed.
 * @param writer - who wrote, so who removes.
 * @throws Error if the transport failed.
 */
async function clearFailedWrite(
  transport: Transport,
  root: string,
  path: string,
  failure: WriteFailure,
  writer: Writer,
): Promise<void> {
  if (failure === "exists" || failure === "no-excl") return;
  if (await removeProbeFiles(transport, root, [path], writer)) return;
  console.warn(
    `[wp/web-identity] could not remove what a failed write of the identity probe may have left at ` +
      `${path}; the next probe removes it once it is an hour old.`,
  );
}

/**
 * Removes probe files as `writer`. Never throws for a refusal, a guard's included: it returns `false`.
 *
 * @param transport - the site.
 * @param root - its WordPress root.
 * @param paths - absolute paths inside `root`, each named like a probe file.
 * @param writer - who may remove them: the transport's user first, root after a refusal when it wrote
 * them or may be used.
 * @returns whether they are gone.
 * @throws Error if the transport failed.
 */
async function removeProbeFiles(
  transport: Transport,
  root: string,
  paths: readonly string[],
  writer: Writer | "either",
): Promise<boolean> {
  if (paths.length === 0) return true;
  const argv = ["-f", "--", ...paths];
  if (writer !== "root") {
    const own = await exec(transport, "rm", argv, { cwd: "/" });
    if (own.exitCode === 0 || writer === "transport") return own.exitCode === 0;
  }
  if ((await elevationSupport(transport)) !== "available") return false;
  // A path swapped for a symlink out of the root since it was listed: left for a person, never thrown.
  if ("refused" in (await guardRefusal(transport, root, paths))) return false;
  const elevated = await execElevated(transport, "rm", argv, { cwd: "/" });
  return elevated.exitCode === 0;
}

/**
 * A command's first line of output, printable, for a reason in a report.
 *
 * @param result - what the command returned.
 */
function firstLine(result: ExecResult): string {
  const said = (result.stderr || result.stdout).trim().split("\n", 1)[0] ?? "";
  const line = printableLine(said).slice(0, 200);
  return line === "" ? `exit ${String(result.exitCode)}` : line;
}

/** The age past which a probe file is a killed run's leftover, in minutes: `find -mmin +60`. */
export const SWEEP_AGE_MINUTES = 60;

/**
 * The `find` argv listing the root's probe-file candidates older than {@link SWEEP_AGE_MINUTES}: the
 * root only (`-mindepth 1 -maxdepth 1`), regular files only (a symlink is not followed or matched),
 * named like a probe file. `?` stands for each hex digit, so the caller still checks the name.
 *
 * @param root - the WordPress root; a trailing `/` makes `find` enter a root that is a symlink.
 */
export function sweepArgv(root: string): string[] {
  return [
    `${root.replace(/\/+$/, "")}/`,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    `e2e-identity-${"?".repeat(32)}.php`,
    "-mmin",
    `+${String(SWEEP_AGE_MINUTES)}`,
    "-print",
  ];
}

/**
 * The probe files a `find` listing names: each line's last segment, kept only when it is exactly a
 * probe file's name, then deduplicated.
 *
 * @param stdout - {@link sweepArgv}'s output.
 * @returns the names.
 */
export function sweptNames(stdout: string): string[] {
  const names = stdout
    .split("\n")
    .map((line) => posix.basename(line.replace(/\r$/, "")))
    .filter((name) => PROBE_FILE_NAME.test(name));
  return [...new Set(names)];
}

/**
 * Removes the probe files older than an hour that killed runs left in the root.
 *
 * @param transport - the site.
 * @returns the names removed; a removal that failed or a guard refused is warned about and left to the
 * next sweep.
 * @throws Error if the transport failed.
 */
export async function sweepProbeFiles(transport: Transport): Promise<string[]> {
  const root = await wpRootDir(transport);
  const listing = await exec(transport, "find", sweepArgv(root), { cwd: "/" });
  // A listing cut short by an unreadable entry still names what it reached.
  const names = sweptNames(listing.stdout);
  if (names.length === 0) return [];
  const paths = names.map((name) => posix.join(root, name));
  if (await removeProbeFiles(transport, root, paths, "either")) return names;
  console.warn(
    `[wp/web-identity] could not remove ${String(names.length)} identity probe file(s) a killed ` +
      `run left in ${root}: ${names.join(", ")}. Remove them by hand.`,
  );
  return [];
}

/**
 * Asks the web server who its PHP runs as, through a probe file in the WordPress root.
 *
 * In order: sweep the leftovers; write the probe file; GET it with a context of its own
 * (`request.newContext({ baseURL })`, the login's TLS settings: certificates verified); remove it in a
 * `finally`. A failure to learn the answer is an `unverified` result, never a throw: the site then
 * runs as today.
 *
 * @param site - the site's transport and address.
 * @param request - Playwright's `request` (`APIRequest`).
 * @param options - see {@link WebProbeOptions}.
 * @returns the identity, or why it is unknown.
 * @throws Error if the transport failed (the answer would be a guess), a guard refused the privileged
 * write, or `options.name` is not a probe file's name; TypeError, before anything is written, when
 * `baseURL` is not a URL. A removal's failure or refusal is a warning, never a throw.
 */
export async function probeWebIdentity(
  site: { readonly transport: Transport; readonly baseURL: string },
  request: APIRequest,
  options: WebProbeOptions = {},
): Promise<WebProbeResult> {
  const { transport, baseURL } = site;
  const name = options.name ?? probeFileName();
  if (!PROBE_FILE_NAME.test(name)) {
    throw new Error(
      "[wp/web-identity] the probe file's name is not e2e-identity-<32 hex>.php.",
    );
  }
  // Built before anything is written: a `baseURL` that is no URL throws here, leaving nothing behind.
  const url = probeUrl(baseURL, name);
  const root = await wpRootDir(transport);
  await sweepProbeFiles(transport);
  const path = posix.join(root, name);
  const written = await writeProbeFile(transport, root, path);
  if ("refused" in written) {
    return {
      kind: "unverified",
      reason: "not-writable",
      detail: written.refused,
    };
  }
  try {
    return await fetchProbe(request, baseURL, url, options);
  } finally {
    // A removal that fails or throws must not hide the answer or the error already on its way.
    let gone: boolean;
    try {
      gone = await removeProbeFiles(transport, root, [path], written.writer);
    } catch {
      gone = false;
    }
    if (!gone) {
      console.warn(
        `[wp/web-identity] could not remove the identity probe ${path}; the next probe removes it ` +
          "once it is an hour old.",
      );
    }
  }
}

/**
 * GETs the probe and reads the answer.
 *
 * @param request - Playwright's `request`.
 * @param baseURL - the site's address, the context's base.
 * @param url - the probe's absolute URL.
 * @param options - the time limit and body cap.
 * @returns what was learnt.
 */
async function fetchProbe(
  request: APIRequest,
  baseURL: string,
  url: string,
  options: WebProbeOptions,
): Promise<WebProbeResult> {
  /**
   * An `unverified` result.
   *
   * @param reason - why.
   * @param detail - what was seen, one printable line.
   */
  const unverified = (
    reason: WebProbeFailure,
    detail: string,
  ): WebProbeResult => ({
    kind: "unverified",
    reason,
    detail,
  });
  let context;
  try {
    context = await request.newContext({ baseURL });
    const response = await context.get(url, {
      failOnStatusCode: false,
      timeout: options.timeoutMs ?? PROBE_TIMEOUT_MS,
    });
    if (response.status() !== 200) {
      return unverified("not-served", `HTTP ${String(response.status())}`);
    }
    const cap = options.maxBodyBytes ?? MAX_BODY_BYTES;
    // Playwright has already read the whole body (it buffers every response); a declared length past
    // the cap is refused without copying it again. Without one, the length read decides.
    const declared = Number(response.headers()["content-length"]);
    if (Number.isFinite(declared) && declared > cap) {
      return unverified(
        "not-probe-output",
        `a body of ${String(declared)} bytes`,
      );
    }
    const body = await response.body();
    if (body.length > cap) {
      return unverified(
        "not-probe-output",
        `a body of ${String(body.length)} bytes`,
      );
    }
    const output = parseProbeOutput(body.toString("utf8"));
    if (output === undefined) {
      return unverified(
        "not-probe-output",
        "the response is not the probe's JSON",
      );
    }
    return output.kind === "no-posix"
      ? unverified("no-posix", "PHP has no posix extension")
      : { kind: "identified", identity: output.identity };
  } catch (error) {
    // Playwright's first line names the failure; the call log after it repeats the URL.
    const said = errorMessage(error).split("\n", 1)[0] ?? "";
    return unverified(
      "unreachable",
      printableLine(said).slice(0, 200) || "the request failed",
    );
  } finally {
    await context?.dispose().catch(() => undefined);
  }
}

// ── The verdict ──────────────────────────────────────────────────────────────────────────────────

/**
 * What the pre-flight concluded about one install, as workers read it:
 * - `owner-is-web`: the web server's PHP runs as the docroot's owner (uid and gid);
 * - `owner-not-web`: it runs as someone else (a deployment-account docroot);
 * - `unverified`: the question could not be answered (`reason`).
 */
export type SiteIdentityVerdict =
  | {
      readonly verdict: "owner-is-web" | "owner-not-web";
      readonly owner: SiteOwnership;
      readonly web: WebIdentity;
    }
  | {
      readonly verdict: "unverified";
      readonly reason: WebProbeFailure | "no-owner";
      readonly detail: string;
      readonly owner?: SiteOwnership;
    };

/**
 * The verdict for an owner and a probe result. Pure.
 *
 * @param owner - the docroot's ownership, `undefined` when it could not be read.
 * @param probe - what the web server said.
 */
export function webVerdict(
  owner: SiteOwnership | undefined,
  probe: WebProbeResult,
): SiteIdentityVerdict {
  if (probe.kind === "unverified") {
    return {
      verdict: "unverified",
      reason: probe.reason,
      detail: probe.detail,
      ...(owner !== undefined ? { owner } : {}),
    };
  }
  if (owner === undefined) {
    return {
      verdict: "unverified",
      reason: "no-owner",
      detail: "the docroot's owner could not be read",
    };
  }
  const same =
    probe.identity.euid === owner.uid && probe.identity.egid === owner.gid;
  return {
    verdict: same ? "owner-is-web" : "owner-not-web",
    owner,
    web: probe.identity,
  };
}

/**
 * The pre-flight's question for one site: its docroot's owner, then the web server's identity, as a
 * verdict. The owner is read as the transport's user, unmemoised (a throw is the transport's).
 *
 * @param site - the site's transport and address.
 * @param request - Playwright's `request`.
 * @param options - see {@link WebProbeOptions}.
 * @throws Error as {@link probeWebIdentity} does.
 */
export async function checkWebIdentity(
  site: { readonly transport: Transport; readonly baseURL: string },
  request: APIRequest,
  options: WebProbeOptions = {},
): Promise<SiteIdentityVerdict> {
  const owner = await probeSiteOwnership(site.transport);
  return webVerdict(owner, await probeWebIdentity(site, request, options));
}

// ── The verdict file ─────────────────────────────────────────────────────────────────────────────

/** The verdict file's name, in the cell's auth folder beside the saved logins. */
export const SITE_IDENTITY_FILE = "site-identity.json";

/** The verdict file's format version. */
const FILE_VERSION = 1;

/**
 * Writes every verdict of a run's sites at once (one writer per cell: the auth setup), atomically: a
 * temporary file renamed over the old one, so a worker never reads half a file.
 *
 * Holds owners, web identities, umasks, SAPIs and reason lines, keyed by `installKey` (user, host, port,
 * key path, root): no password, key or token.
 *
 * @param dir - the folder (the cell's auth folder); created if missing.
 * @param runId - this run's `RUN_ID`: a worker trusts only its own run's verdicts.
 * @param verdicts - per {@link installKey}.
 * @returns the file's path.
 */
export async function writeSiteIdentityFile(
  dir: string,
  runId: string,
  verdicts: ReadonlyMap<string, SiteIdentityVerdict>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, SITE_IDENTITY_FILE);
  const temporary = `${path}.${String(process.pid)}.tmp`;
  const doc = {
    version: FILE_VERSION,
    runId,
    sites: Object.fromEntries(verdicts),
  };
  try {
    await writeFile(temporary, `${JSON.stringify(doc, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return path;
}

/** What reading the verdict file found. */
export type SiteIdentityFileRead =
  | {
      readonly kind: "read";
      readonly verdicts: ReadonlyMap<string, SiteIdentityVerdict>;
    }
  /** No file: the setup did not run (`--no-deps`), or wrote none. */
  | { readonly kind: "missing" }
  /** Another run's file: its verdicts are not this run's evidence. */
  | { readonly kind: "stale"; readonly runId: string }
  /** Not a verdict file this code wrote. */
  | { readonly kind: "invalid"; readonly why: string };

/**
 * Reads the verdict file. Never throws: a worker without its run's verdicts runs `auto` sites as
 * today and says why.
 *
 * @param dir - the folder {@link writeSiteIdentityFile} wrote to.
 * @param runId - this run's `RUN_ID`.
 */
export async function readSiteIdentityFile(
  dir: string,
  runId: string,
): Promise<SiteIdentityFileRead> {
  let text: string;
  try {
    text = await readFile(join(dir, SITE_IDENTITY_FILE), "utf8");
  } catch (error) {
    if (isObject(error) && error.code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid", why: `unreadable: ${errorMessage(error)}` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { kind: "invalid", why: "not JSON" };
  }
  return parseSiteIdentityFile(doc, runId);
}

/**
 * Validates a parsed verdict file. Pure.
 *
 * @param doc - the parsed JSON.
 * @param runId - this run's `RUN_ID`.
 */
export function parseSiteIdentityFile(
  doc: unknown,
  runId: string,
): SiteIdentityFileRead {
  if (!isObject(doc) || doc.version !== FILE_VERSION) {
    return {
      kind: "invalid",
      why: `not a version ${String(FILE_VERSION)} verdict file`,
    };
  }
  if (typeof doc.runId !== "string")
    return { kind: "invalid", why: "no runId" };
  if (doc.runId !== runId) return { kind: "stale", runId: doc.runId };
  if (!isObject(doc.sites)) return { kind: "invalid", why: "no sites" };
  const verdicts = new Map<string, SiteIdentityVerdict>();
  for (const [key, entry] of Object.entries(doc.sites)) {
    const verdict = parseVerdict(entry);
    if (verdict === undefined)
      return { kind: "invalid", why: "a malformed verdict" };
    verdicts.set(key, verdict);
  }
  return { kind: "read", verdicts };
}

/** The reasons an `unverified` verdict may carry. */
const UNVERIFIED_REASONS: ReadonlySet<unknown> = new Set<
  WebProbeFailure | "no-owner"
>([
  "not-writable",
  "unreachable",
  "not-served",
  "not-probe-output",
  "no-posix",
  "no-owner",
]);

/**
 * One verdict, validated.
 *
 * @param entry - a parsed value.
 * @returns the verdict, or `undefined` when it is not one.
 */
function parseVerdict(entry: unknown): SiteIdentityVerdict | undefined {
  if (!isObject(entry)) return undefined;
  const owner =
    entry.owner === undefined ? undefined : parseOwnership(entry.owner);
  if (owner === false) return undefined;
  if (entry.verdict === "unverified") {
    if (
      !UNVERIFIED_REASONS.has(entry.reason) ||
      typeof entry.detail !== "string"
    ) {
      return undefined;
    }
    return {
      verdict: "unverified",
      reason: entry.reason as WebProbeFailure | "no-owner",
      detail: entry.detail,
      ...(owner !== undefined ? { owner } : {}),
    };
  }
  if (entry.verdict !== "owner-is-web" && entry.verdict !== "owner-not-web")
    return undefined;
  const web = isObject(entry.web) ? webIdentityFrom(entry.web) : undefined;
  if (owner === undefined || web === undefined) return undefined;
  return { verdict: entry.verdict, owner, web };
}

/**
 * A stored ownership, validated.
 *
 * @param value - a parsed value.
 * @returns it, or `false` when it is not one.
 */
function parseOwnership(value: unknown): SiteOwnership | false {
  if (!isObject(value)) return false;
  const { user, group, uid, gid } = value;
  return typeof user === "string" &&
    user !== "" &&
    typeof group === "string" &&
    group !== "" &&
    isId(uid) &&
    isId(gid)
    ? { user, group, uid, gid }
    : false;
}
