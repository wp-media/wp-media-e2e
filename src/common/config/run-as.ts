/**
 * The site identity fields of an `ssh` transport: `runAs` (who site commands run as) and `umask`
 * (what they create files with), parsed at load and given their defaults here.
 *
 * Parsed where every other site field is, so a bad value fails the load naming the field instead of
 * surfacing as a fallback warning mid-run; a misspelled key (`"runas"`) fails too, as an unknown
 * transport field (`sites.ts`). Dependency-free like `file-owner.ts`, whose `"user:group"` rule
 * `runAs` reuses, so one spelling is valid in both fields.
 *
 * `exec`/`wpCli` read them through the identity state (`wp/site-identity.ts`); probes and root
 * commands never do.
 */

import { parseOwnerSpec, type OwnerSpec } from "./file-owner";
import type { RunAs, Transport } from "./types";

/** A `runAs` naming an identity: neither `"auto"` nor `false`. */
export type RunAsIdentity = Exclude<RunAs, "auto" | false>;

/**
 * What an `ssh` site without `runAs` gets: `false`, its transport's own user, as before the field
 * existed. Changing it to `"auto"` switches every such site at once, so it moves only after the
 * identity layer is proven; `docker`/`local` never run as another identity, whatever this says.
 */
export const DEFAULT_SSH_RUN_AS: RunAs = false;

/**
 * The umask a site command gets when `umask` is absent: systemd's default for apache2 and php-fpm,
 * so files come out as the website itself would write them (`644`/`755`).
 */
export const DEFAULT_UMASK = "0022";

/** The `runAs` rule, in the words an error message uses. */
export const RUN_AS_RULE =
  '"auto", "user:group" (the web server\'s user and group, e.g. "www-data:www-data", either half a ' +
  "name or a numeric id), or false";

/** The `umask` rule, in the words an error message uses. */
export const UMASK_RULE =
  'an octal umask as a text of 3 or 4 digits ("022" or "0022") that keeps the owner\'s read, write ' +
  "and search bits (its owner digit is 0): the identity must be able to use what it creates";

/** Three octal digits, optionally after a leading `0`: no sign, prefix, space or special bits. */
const UMASK_PATTERN = /^0?[0-7]{3}$/;

/** A user or group naming root: the name, or an id of only zeros (`0`, `00`, …). */
const ROOT_NAME = /^(?:root|0+)$/;

/** The largest numeric id a host can assign: `2^32 - 1` is `(uid_t) -1`, "no id" to the kernel. */
export const MAX_ID = 4_294_967_294;

/**
 * True when a parsed owner name is a numeric id no host can assign (above {@link MAX_ID}): sudo would
 * refuse it only once commands run, as a fallback instead of the config error it is.
 *
 * @param name - one half of a `"user:group"`, already valid per `parseOwnerSpec`.
 * @returns whether it is all digits and above {@link MAX_ID}; a name is never out of range.
 */
export function idOutOfRange(name: string): boolean {
  return /^\d+$/.test(name) && BigInt(name) > BigInt(MAX_ID);
}

/**
 * True when a parsed owner name means root. Only what the text itself says: a non-root name mapped to
 * uid 0 on the host is caught by the probe that resolves the identity there.
 *
 * @param name - one half of a `"user:group"`, already valid per `parseOwnerSpec`.
 * @returns whether it is `root` or a numeric id equal to 0.
 */
export function namesRoot(name: string): boolean {
  return ROOT_NAME.test(name);
}

/**
 * Validates a declared `transport.runAs` text (the loader handles `false` and non-texts).
 *
 * @param declared - the text read from the sites file.
 * @param path - where it sits (`<file> → <cell>.sites[<i>].transport.runAs`), for the message.
 * @returns `"auto"`, or the identity as `"user:group"`, trimmed.
 * @throws Error naming `path` and the rule (see {@link checkIdentity}).
 */
export function parseRunAs(declared: string, path: string): RunAs {
  if (declared === "auto") return declared;
  const { user, group } = checkIdentity(declared, `[sites] ${path}`);
  return `${user}:${group}`;
}

/**
 * The user and group of a `runAs` identity, apart, for building a command that runs as them. Checked
 * again with the loader's rule, so a transport built some other way (by hand, in a spec) is held to it.
 *
 * @param runAs - a resolved transport's `runAs` identity.
 * @param context - prefixed to the error (e.g. `[exec] transport.runAs`).
 * @returns the trimmed user and group.
 * @throws Error under the loader's rule (see {@link checkIdentity}).
 */
export function runAsIdentity(
  runAs: RunAsIdentity,
  context: string,
): OwnerSpec {
  return checkIdentity(runAs, context);
}

/**
 * The `runAs` identity rule: `parseOwnerSpec`'s `"user:group"`, neither half root nor a numeric id
 * above {@link MAX_ID}.
 *
 * A group of root is refused like a user of root: the web server never runs with group 0, and every
 * file the suite wrote would grant root's group its access, the exposure the field exists to remove.
 *
 * @param declared - the identity text.
 * @param context - prefixed to the error.
 * @returns the trimmed user and group.
 * @throws Error naming `context` and the rule; a refused text is described by its length, never quoted
 * (the sites file holds credentials).
 */
function checkIdentity(declared: string, context: string): OwnerSpec {
  let spec: OwnerSpec;
  try {
    spec = parseOwnerSpec(declared, context);
  } catch {
    throw new Error(
      `${context} must be ${RUN_AS_RULE} — got a text of ` +
        `${String(Array.from(declared).length)} characters.`,
    );
  }
  const halves = (test: (name: string) => boolean): string =>
    [
      ...(test(spec.user) ? ["user"] : []),
      ...(test(spec.group) ? ["group"] : []),
    ].join(" and ");
  const root = halves(namesRoot);
  if (root !== "") {
    throw new Error(
      `${context} names root as its ${root}: site commands never run as root. ` +
        'Name the web server\'s user and group (e.g. "www-data:www-data"), or use "auto" or false.',
    );
  }
  const huge = halves(idOutOfRange);
  if (huge !== "") {
    throw new Error(
      `${context} names a numeric id above ${String(MAX_ID)} as its ${huge}: no host assigns one. ` +
        "Name the web server's user and group, or their ids.",
    );
  }
  return spec;
}

/**
 * Validates a declared `transport.umask` text (the loader refuses non-texts: a JSON number `22` would
 * read as decimal, and `0o22` is not JSON).
 *
 * @param declared - the text read from the sites file.
 * @param path - where it sits, for the message.
 * @returns the umask normalised to four digits (`"022"` → `"0022"`).
 * @throws Error naming `path` and the rule; a text of the octal shape is quoted (it can hold nothing
 * else), any other is described by its length.
 */
export function parseUmask(declared: string, path: string): string {
  const refuse = (got: string): Error =>
    new Error(`[sites] ${path} must be ${UMASK_RULE} — got ${got}.`);
  if (!UMASK_PATTERN.test(declared)) {
    throw refuse(`a text of ${String(Array.from(declared).length)} characters`);
  }
  const umask = declared.padStart(4, "0");
  // Masking any owner bit leaves the identity unable to read, write or enter what it just created.
  if ((Number.parseInt(umask, 8) & 0o700) !== 0) {
    throw refuse(JSON.stringify(declared));
  }
  return umask;
}

/**
 * Who a transport's site commands are meant to run as, its default applied.
 *
 * @param transport - a resolved transport.
 * @returns its `runAs`, else {@link DEFAULT_SSH_RUN_AS} over `ssh`; `undefined` for `docker` and
 * `local`, which have no `runAs` at all. Never `false` there: `false` means the opt-out (`disabled`),
 * while those modes always run as themselves (`same-user`), so a caller must tell the two apart.
 */
export function effectiveRunAs(transport: Transport): RunAs | undefined {
  return transport.mode === "ssh"
    ? (transport.runAs ?? DEFAULT_SSH_RUN_AS)
    : undefined;
}

/**
 * The umask a transport's site commands get when they run as the site's identity.
 *
 * @param transport - a resolved transport.
 * @returns its `umask`, else {@link DEFAULT_UMASK}, over `ssh`; `undefined` for `docker` and `local`,
 * whose commands keep the umask they start with.
 */
export function effectiveUmask(transport: Transport): string | undefined {
  return transport.mode === "ssh"
    ? (transport.umask ?? DEFAULT_UMASK)
    : undefined;
}
