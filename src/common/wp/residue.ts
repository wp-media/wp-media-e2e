import { posix } from "node:path";

import {
  describeTarget,
  elevationSupport,
  exec,
  execElevated,
  assertAllResolvedInsideRoot,
  assertResolvedInsideRoot,
  wpRootDir,
} from "./exec";
import { normalizeOwnership } from "./ownership";
import { resolveSiteIdentity } from "./site-identity";
import {
  PROTECTED_SITE_PATHS,
  assertSafeElevatedTarget,
  isPathSegment,
  normaliseSitePath,
} from "./paths";
import { SiteResidueRemovalFailedError } from "./errors";
import { errorMessage } from "../guards";
import type { ElevationSupport, ExecResult } from "./exec";
import type { SiteResidue, Transport } from "../config/types";

/**
 * The data a plugin writes to the site's **filesystem**: opening those directories before a scenario
 * ({@link prepareSiteDataDirs}), and removing them after it ({@link removeSiteResidue}). Both work
 * from the same product-declared list, and both exist because the suite reinstalls the plugin for
 * every scenario while the files the plugin wrote outlive it.
 *
 * Uninstalling a plugin removes its code and — if it implements `uninstall.php` properly — its
 * database footprint. It does not remove the files the plugin *wrote while running*, and it
 * generally should not: those are the user's data. BackWPup is the clear case, and the reason this
 * module exists: its uninstall touches no files at all, so every backup archive, log and temp file
 * it produced stays behind, under a **new randomly-named directory per install**. A suite that
 * installs the plugin once per scenario therefore leaves a fresh copy of the site's own archive on
 * disk every time, and the cell fills up. (Measured on the QA cell: 6.8 GB across 28 such
 * directories, from a few days of runs.)
 *
 * Some of that residue is worse than bulky. BackWPup's restore working directory can hold a
 * `restore.dat.bkp` containing **plaintext database credentials** — the plugin ships an admin
 * notice warning about exactly that — so clearing it is hygiene in both senses.
 *
 * **The transport's user often cannot do this alone, and that is normal.** The plugin writes as the
 * web-server user, and a directory it creates with `0755` (BackWPup's restore area, from Monolog's
 * `mkdir` under the default umask) cannot be emptied by anyone else — so an unprivileged `rm -rf`
 * fails and the site keeps a copy of its own database dump from every scenario that ever ran. So
 * removal escalates: **as ourselves first, then with privileges for whatever survived**, which keeps
 * a correctly-permissioned host from ever running `rm` as root while still finishing the job on the
 * hosts that need it. See `./exec.ts` for the limits on elevation.
 *
 * **And the transport's user is not the only user of these directories** — the other half of the
 * story. WP-CLI and the web server are different users on a real cell, so a directory either one
 * creates under its own umask locks the other out, and one created by WP-CLI is additionally owned
 * by the wrong user entirely. {@link prepareSiteDataDirs} settles both up front — mode *and*
 * ownership — instead of leaving it to whichever happened to write first.
 *
 * Which paths a product leaves is the product's own knowledge, so it declares them
 * (`ProductConfig.siteResidue`) and the shared scenario hooks read them from the per-process
 * registry. This module only knows how to prepare and remove such a path safely on any transport.
 *
 * **A plugin may also name a directory at runtime**, under a fixed prefix and a random tail — BackWPup
 * names its restore working directory `uploads/backwpup-restore-<20 hex>`, the tail kept in an option
 * and drawn afresh on every install. Such a family is declared as its parent and an anchored name
 * pattern (`SiteResidueFamily`, {@link parseResidueDeclaration}) and found on the site at removal
 * time, which also catches the directories earlier installs left under names nobody remembers. It
 * names nothing to create up front; a product that can ask the installed plugin for the current name
 * resolves it after each install instead ({@link prepareResolvedDataDirs}).
 */

/**
 * Validates one declared residue path and returns it normalised.
 *
 * The rules — relative, inside the root, never a directory WordPress itself owns — are shared with
 * every other privileged operation and live in {@link normaliseSitePath}; this only supplies the
 * wording, so a bad declaration is reported in the vocabulary of the thing that would have happened
 * to it.
 *
 * @param declared - the path as the product declared it, relative to the WordPress root.
 * @returns the normalised path, still relative.
 * @throws Error naming the path and the rule it broke.
 */
export function normaliseResiduePath(declared: string): string {
  return normaliseSitePath(
    declared,
    (reason) =>
      `[wp/residue] "${declared}" cannot be removed as leftover data: ${reason}. Declare a path ` +
      'relative to the WordPress root that the product itself created, e.g. "wp-content/uploads/<plugin>".',
  );
}

/**
 * One residue declaration, parsed: a path, or a family of directories the plugin names at runtime.
 *
 * A `family` matches the **directories** directly inside `parent` whose whole name `name` matches —
 * never a file, never a symbolic link, never anything deeper, never the parent itself.
 */
export type ResidueDeclaration =
  | { readonly kind: "path"; readonly path: string }
  | {
      readonly kind: "family";
      readonly parent: string;
      readonly name: RegExp;
    };

/**
 * A family pattern's opening: `^`, then the plugin's fixed prefix spelled out — three literal
 * characters at least, none made optional by a quantifier after it. What makes a family "a fixed
 * prefix and a tail the plugin picks" rather than any name at all (`/^[a-z0-9]+$/` would take every
 * year folder in `uploads`), and what keeps it from ever matching `.` or `..`.
 */
const LITERAL_PREFIX = /^\^[A-Za-z0-9_-]{3,}(?![*+?{])/;

/**
 * A pattern source ending in a real `$` anchor — not an escaped `\$`, which is a literal dollar sign
 * and anchors nothing.
 */
const ENDS_WITH_ANCHOR = /(?:^|[^\\])(?:\\\\)*\$$/;

/**
 * Parses and validates one residue declaration.
 *
 * A path is validated by {@link normaliseResiduePath}. A family's parent must be a relative path
 * inside the root, short of the root itself, no segment edged with whitespace — it may be a directory
 * WordPress owns, since it is only ever listed. Its name pattern must make `^` and `$` bound the
 * **whole** name: anchored at both ends, no alternation (which can leave a branch unanchored), not
 * multiline (which lets them match at a line break), not global or sticky (stateful) — and open with
 * the plugin's fixed prefix ({@link LITERAL_PREFIX}). It must match no directory WordPress owns in
 * that parent: every match is validated again before removal, so this cannot delete one, but it makes
 * the mistake fail at declaration rather than on the first site that happens to hold the directory.
 *
 * @param declared - the declaration as the product made it.
 * @returns the parsed declaration, normalised.
 * @throws Error naming the declaration and the rule it broke.
 */
export function parseResidueDeclaration(
  declared: SiteResidue,
): ResidueDeclaration {
  if (typeof declared === "string") {
    return { kind: "path", path: normaliseResiduePath(declared) };
  }
  const { parent, name } = declared;
  const refuse = (reason: string): Error =>
    new Error(
      `[wp/residue] the directories "${parent}/${name.source}" cannot be removed as leftover data: ` +
        `${reason}. Declare a parent inside the WordPress root and an anchored name pattern as ` +
        "tight as the plugin's naming, e.g. /^<plugin>-[0-9a-f]{20}$/.",
    );
  const rejection = familyPatternRejection(name);
  if (rejection !== undefined) throw refuse(rejection);
  if (parent.split("/").some((segment) => segment !== segment.trim())) {
    throw refuse(
      "a segment of its parent begins or ends with whitespace, which would name a directory " +
        "nobody meant — and a family whose parent is not there is silently empty",
    );
  }
  const sample = normaliseSitePath(
    posix.join(parent, "x"),
    (reason) => refuse(`its parent is unusable — ${reason}`).message,
  );
  const parentPath = posix.dirname(sample);
  if (parentPath === ".") throw refuse("its parent is the WordPress root");
  const owned = PROTECTED_SITE_PATHS.find(
    (protectedPath) =>
      posix.dirname(protectedPath) === parentPath &&
      name.test(posix.basename(protectedPath)),
  );
  if (owned !== undefined) {
    throw refuse(
      `it would match "${owned}", a directory WordPress itself owns`,
    );
  }
  return { kind: "family", parent: parentPath, name };
}

/**
 * The rule a family's name pattern breaks, or `undefined` when `^` and `$` bound the whole name and it
 * opens with a fixed prefix — see {@link parseResidueDeclaration}.
 *
 * @param name - the declared pattern.
 * @returns the reason it is unusable, or `undefined` when it is fine.
 */
function familyPatternRejection(name: RegExp): string | undefined {
  if (!name.source.startsWith("^") || !ENDS_WITH_ANCHOR.test(name.source)) {
    return "its name pattern is not anchored at both ends, so it would match parts of names";
  }
  if (name.source.includes("|")) {
    return "its name pattern has an alternation, which can leave one branch unanchored";
  }
  if (name.global || name.sticky) {
    return "its name pattern is global or sticky, which makes every test depend on the last";
  }
  if (name.multiline) {
    return "its name pattern is multiline, so ^ and $ would match at a line break inside a name";
  }
  if (!LITERAL_PREFIX.test(name.source)) {
    return (
      "its name pattern does not open with the plugin's fixed prefix spelled out (three " +
      "characters at least), so it could match directories of any name"
    );
  }
  return undefined;
}

/**
 * Whether a directory name belongs to a family: one path segment its pattern matches whole. Checked
 * on what the site lists, so a listing that went wrong cannot widen a removal.
 *
 * A name edged with whitespace is never a member: the shared path rules trim, so it could not be
 * addressed exactly — removal and its verification would act on a different, trimmed path.
 */
function inFamily(
  declaration: Extract<ResidueDeclaration, { kind: "family" }>,
  name: string,
): boolean {
  return (
    isPathSegment(name) && name === name.trim() && declaration.name.test(name)
  );
}

/**
 * Whether `path` is one of the declared leftovers — named by a path declaration, or a directory of a
 * declared family. The check that keeps a resolved data directory from being prepared and then never
 * removed.
 *
 * @param path - a validated path relative to the WordPress root.
 * @param declarations - the product's parsed declarations.
 */
export function isDeclaredResidue(
  path: string,
  declarations: readonly ResidueDeclaration[],
): boolean {
  return declarations.some((declaration) =>
    declaration.kind === "path"
      ? declaration.path === path
      : posix.dirname(path) === declaration.parent &&
        inFamily(declaration, posix.basename(path)),
  );
}

/**
 * The directories of a family on the site right now, relative to the root.
 *
 * The names are matched here, whole, against the declared pattern ({@link inFamily}). A parent that
 * is not there holds nothing; one that could not be listed throws, because "nothing matched" must
 * never stand in for "could not look".
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param declaration - the family to expand.
 * @throws Error if the parent exists but could not be listed.
 */
async function expandFamily(
  transport: Transport,
  root: string,
  declaration: Extract<ResidueDeclaration, { kind: "family" }>,
): Promise<string[]> {
  const listing = await listDirectories(
    transport,
    root,
    posix.join(root, declaration.parent),
    declaration.name,
  );
  return listing
    .split("\0")
    .filter((entry) => entry !== "")
    .map((entry) => posix.basename(entry))
    .filter((name) => inFamily(declaration, name))
    .map((name) => normaliseResiduePath(posix.join(declaration.parent, name)));
}

/**
 * The directories directly inside `parent`, NUL-separated — empty when it is not there.
 *
 * `find -H` follows `parent` itself when it is a link, so a relocated `uploads` is listed where it
 * leads (every match is then held to the root before anything acts on it), but nothing below it: a
 * link is never a match. As the transport's user first, and with privileges only when that was
 * refused — the plugin writes as the web server, which may leave a parent others cannot list.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param parent - the absolute directory to list.
 * @param name - the family's pattern, for the message.
 * @throws Error if the parent is there but could not be listed at any privilege available.
 */
async function listDirectories(
  transport: Transport,
  root: string,
  parent: string,
  name: RegExp,
): Promise<string> {
  const argv = listingArgv(parent);
  let listing = await exec(transport, "find", argv);
  if (listing.exitCode === 0) return listing.stdout;
  // A parent that is not there is the usual failure, and telling so needs no privileges.
  if ((await exec(transport, "test", ["-e", parent])).exitCode !== 0) return "";
  const elevation = await elevationSupport(transport);
  if (elevation === "available") {
    assertSafeElevatedTarget(parent, root, describeRemoval(root));
    listing = await execElevated(transport, "find", argv);
    if (listing.exitCode === 0) return listing.stdout;
  }
  throw new Error(
    `[wp/residue] ${describeTarget(transport)}: could not list "${parent}" to find the leftovers ` +
      `named ${String(name)} (exit ${String(listing.exitCode)}: ` +
      `${(listing.stderr || listing.stdout).trim() || "no output"}; elevation: ${elevation}).`,
  );
}

/**
 * `find`'s arguments for listing the directories directly inside `parent`, NUL-separated. `-H`
 * follows `parent` itself when it is a link but nothing below it, and `-type d` then never lists a
 * link — so every directory listed lies directly inside wherever `parent` really leads (measured with
 * GNU findutils 4.9 and macOS's BSD `find`), which is what lets removal check a family once, through
 * its parent, rather than member by member.
 */
function listingArgv(parent: string): string[] {
  return [
    "-H",
    parent,
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "d",
    "-print0",
  ];
}

/** A family's directories found on the site, relative to the root. */
interface FoundFamily {
  /** The family's parent directory. */
  readonly parent: string;
  /** Its directories found there, each a path directly inside {@link FoundFamily.parent}. */
  readonly members: readonly string[];
}

/** What the declarations name on the site now, and the families that could not be looked for. */
interface FoundResidue {
  /** Every path found, relative to the root, each once — declared paths and family members alike. */
  readonly paths: readonly string[];
  /** The families found with at least one directory, so removal can check and verify each at once. */
  readonly families: readonly FoundFamily[];
  /** Why each family that could not be listed could not be. */
  readonly unlisted: readonly Error[];
}

/**
 * Every path the declarations name on the site right now: the declared paths as they are, and each
 * family expanded to its directories there. A family that cannot be listed does not stop the others,
 * so removal can still clear what it can before saying what it could not look at.
 */
async function findResidue(
  transport: Transport,
  root: string,
  declarations: readonly ResidueDeclaration[],
): Promise<FoundResidue> {
  const paths = new Set<string>();
  const families: FoundFamily[] = [];
  const unlisted: Error[] = [];
  for (const declaration of declarations) {
    if (declaration.kind === "path") {
      paths.add(declaration.path);
      continue;
    }
    try {
      const members = await expandFamily(transport, root, declaration);
      for (const path of members) paths.add(path);
      if (members.length > 0) {
        families.push({ parent: declaration.parent, members });
      }
    } catch (error) {
      unlisted.push(
        error instanceof Error ? error : new Error(errorMessage(error)),
      );
    }
  }
  return { paths: [...paths], families, unlisted };
}

/**
 * What a product's residue declarations name on the site right now — the paths as declared, and each
 * family's directories as found — relative to the WordPress root. For a caller that must leave those
 * paths alone, as a copy of the content directory must.
 *
 * @param transport - the target site's transport.
 * @param declared - the product's declarations.
 * @throws Error if a declaration is unusable, or a family's parent could not be listed.
 */
export async function resolveSiteResidue(
  transport: Transport,
  declared: readonly SiteResidue[],
): Promise<readonly string[]> {
  const declarations = declared.map(parseResidueDeclaration);
  if (declarations.length === 0) return [];
  const found = await findResidue(
    transport,
    await wpRootDir(transport),
    declarations,
  );
  const [unlisted] = found.unlisted;
  if (unlisted !== undefined) throw unlisted;
  return found.paths;
}

/** Runs one command against the site — either as the transport's user, or with privileges. */
type Runner = (file: string, args: string[]) => Promise<ExecResult>;

/**
 * Mode the data directories are opened to. World-writable, and deliberately so.
 *
 * On a real cell **WP-CLI and the web server run as different users** — `ubuntu` over SSH, `www-data`
 * under PHP-FPM — sharing one docroot. Whichever of them creates one of these directories first does
 * so under its own umask (`0775`/`0755`, owned by itself), which locks the other out of a directory
 * they must both write: WP-CLI because the plugin's CLI commands log into it, the web server because
 * the plugin's admin pages do. It is not a hypothetical — see {@link prepareSiteDataDirs}.
 *
 * `0777` is what the plugin itself asks for (`mkdir($dir, 0777, true)`, narrowed only by the umask)
 * and what WordPress's own `wp_mkdir_p` would produce here, since it inherits the containing
 * directory's mode and `wp-content/uploads` on these cells is already `0777` for this very reason.
 * The sites are disposable QA installs, and removal now genuinely clears the sensitive contents
 * after every scenario where before it could not — so the exposure goes down, not up.
 *
 * It is a **floor, not the whole answer**: it makes the directory writable by both users but leaves
 * it owned by whichever created it, and says nothing about a subtree an earlier run left behind.
 * {@link normalizeOwnership} supplies both, so this stays the one bit that grant cannot infer — the
 * cheap guarantee that holds even on a site whose ownership cannot be corrected at all.
 */
const DATA_DIR_MODE = "0777";

/**
 * Creates a product's data directories up front, so that **which user happens to get there first
 * stops deciding whether the other one can write them.**
 *
 * Found the hard way, and only once removal started working: BackWPup's restore area used to survive
 * every teardown, so the copy created long ago by the web server was always the one in use. With it
 * genuinely removed after each scenario, the next scenario's first writer creates it instead — and
 * when that writer was a WP-CLI call, the directory arrived as `drwxrwxr-x ubuntu:ubuntu` and the
 * plugin's very next admin request died on `Folder "…/backwpup-restore" is not writable`
 * (`BackWPup_File::check_folder`, via `create_project_temp_dir`). Observed directly on the cell: the
 * directory appearing owned by the transport user at 15:38:49, the fatal at 15:38:50.
 *
 * Creating them here — before anything runs — makes that race impossible rather than unlikely. Each
 * step escalates only if the transport's user is refused, and the whole thing is idempotent, so a
 * directory an earlier run left behind is simply re-opened to both users.
 *
 * **Three steps, and each does something the previous one cannot.** `mkdir` settles who creates the
 * directory; {@link DATA_DIR_MODE} makes it writable by both users whatever happens next; and
 * {@link normalizeOwnership} hands it to the ownership the *site* uses. The third is not decoration
 * on the second: this suite writing into a site's docroot as the transport's user is precisely what
 * that primitive exists for, and its grant is **recursive**, so it also reaches a subtree the mode
 * above cannot — one an earlier scenario's plugin wrote as the web server, or one the plugin's own
 * activation created a moment ago as WP-CLI. Ownership correction is best-effort by contract, which
 * is why the mode is applied independently rather than left to it.
 *
 * A family is skipped: its directories have no name until the plugin picks one, so there is nothing
 * to create here — see {@link prepareResolvedDataDirs}.
 *
 * @param transport - the target site's transport.
 * @param paths - the product's declared paths, as {@link removeSiteResidue} takes them. Nothing to
 * create does nothing at all, not even resolving the root.
 * @throws Error if a declaration is not usable (see {@link parseResidueDeclaration}), if the root is
 * unusable for a privileged step (see {@link assertSafeElevatedTarget}), if a path is a symbolic link
 * rather than a directory, or if a directory can be neither created nor opened to both users.
 * Handing over ownership never throws; a host that cannot do it is warned about.
 */
export async function prepareSiteDataDirs(
  transport: Transport,
  paths: readonly SiteResidue[],
): Promise<void> {
  // Validated before the site is touched at all, so a typo in one declaration cannot leave the
  // others half-prepared.
  const relative = paths
    .map(parseResidueDeclaration)
    .flatMap((declaration) =>
      declaration.kind === "path" ? [declaration.path] : [],
    );
  if (relative.length === 0) return;
  const root = await wpRootDir(transport);

  for (const path of relative) {
    await prepareOneDataDir(transport, root, path);
  }
}

/**
 * Prepares the data directories only the installed plugin can name, exactly as
 * {@link prepareSiteDataDirs} prepares the declared ones — after **each** install, since an install
 * is what draws the name.
 *
 * Every resolved directory must be one the product's residue declarations cover, or it would be
 * opened up and then never removed; that is refused before anything is created.
 *
 * @param transport - the target site's transport.
 * @param resolved - what the product's resolver answered, relative to the WordPress root.
 * @param declared - the product's residue declarations, as {@link removeSiteResidue} takes them.
 * @throws Error if a resolved path is unusable or undeclared, or on anything
 * {@link prepareSiteDataDirs} throws for.
 */
export async function prepareResolvedDataDirs(
  transport: Transport,
  resolved: readonly string[],
  declared: readonly SiteResidue[],
): Promise<void> {
  const declarations = declared.map(parseResidueDeclaration);
  const paths = resolved.map((path) =>
    normaliseSitePath(
      path,
      (reason) =>
        `[wp/residue] the product resolved "${path}" as a data directory, which cannot be ` +
        `prepared: ${reason}. A resolver answers paths relative to the WordPress root.`,
    ),
  );
  const undeclared = paths.filter(
    (path) => !isDeclaredResidue(path, declarations),
  );
  if (undeclared.length > 0) {
    throw new Error(
      `[wp/residue] the product resolved ${undeclared.map((path) => `"${path}"`).join(", ")} as a ` +
        "data directory, but none of its residue declarations covers it, so it would be prepared and " +
        "never removed. Declare it, or a family matching it, in `ProductConfig.siteResidue`.",
    );
  }
  await prepareSiteDataDirs(transport, paths);
}

/**
 * The three steps for one declared path: make it exist, open it, hand it over.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param path - one already-normalised declared path, relative to that root.
 * @throws Error if the root is unusable for a privileged step, if the path is a symbolic link, or if
 * the directory can be neither created nor opened to both users. Handing over ownership never
 * throws.
 */
async function prepareOneDataDir(
  transport: Transport,
  root: string,
  path: string,
): Promise<void> {
  const target = posix.join(root, path);
  // Preparation escalates, so it needs the same root guard removal has: `normaliseResiduePath`
  // constrains the relative half, and this is the half it cannot see. Without it a site whose
  // `rootDir` is a top-level directory would have world-writable directories created **as root**
  // at the filesystem root — and teardown would then refuse to remove what setup created.
  const describe = (reason: string): string =>
    `[wp/residue] refusing to prepare the plugin's data directories: this site's WordPress root ` +
    `("${root}") cannot be used for it — ${reason}. Preparation may need privileges, so it will ` +
    "not aim one at a path it cannot place inside the site; fix the site's `rootDir`, or declare a " +
    "data path that stays within it.";
  assertSafeElevatedTarget(target, root, describe);
  // The guard above compares strings; this one asks the filesystem. A symlink **anywhere** in the
  // path — `wp-content/uploads` relocated, not just the last component — would otherwise let a
  // privileged `chmod 0777` and, later, a privileged `rm -rf` act outside the site while every
  // lexical check agreed. Measured: content outside the root was removed that way. Checked before
  // `mkdir`, which happily follows a linked parent and would hide it.
  await assertResolvedInsideRoot(transport, target, root, describe);
  // The guard above lets a link that stays inside the site through — and `chmod` follows the link it
  // is given: a data directory linked at the root would open the root itself `0777`, as root if need
  // be. A data directory is a directory; a link where one belongs is refused, wherever it leads.
  if ((await exec(transport, "test", ["-L", target])).exitCode === 0) {
    throw new Error(
      `[wp/residue] refusing to prepare "${target}": it is a symbolic link where the plugin's data ` +
        "directory belongs, and opening it would open whatever it points at. Remove the link.",
    );
  }
  // `--` ends option parsing, as the ownership commands do. The guard above already proves
  // `target` is absolute so it cannot begin with a dash — this keeps that from being the only
  // thing standing between a future refactor and a flag.
  await escalateIfDenied(transport, "mkdir", ["-p", "--", target], (mkdir) =>
    handBackWhatRootMakes(transport, root, target, describe, mkdir),
  );
  await escalateIfDenied(transport, "chmod", ["--", DATA_DIR_MODE, target]);
  // Last, so the grant is applied while the directory is still ours to change: normalising first
  // would hand it to the site's user and make the mode above need privileges it did not need.
  await normalizeOwnership(transport, path);
}

/**
 * In the `site` identity state, hands what a root `mkdir -p` of `target` creates back to the
 * identity, so the data directory (and any parent it had to make) ends the web server's, as if the
 * site had made it — else root's, which only {@link DATA_DIR_MODE} would hide. Every other state
 * leaves it to {@link normalizeOwnership}, as before.
 *
 * What was missing is read **as root before** the `mkdir`, from `target` up to the first component
 * that exists, never past `root`: so only what this call created is handed over, never a parent that
 * was already there (the identity might not see it, and would then hand it over). The `chown` is
 * root's, `-h` (never through a link), each path behind {@link assertSafeElevatedTarget}. A failed
 * `chown` warns and leaves the directory working (the mode above still opens it): best-effort, as
 * {@link normalizeOwnership} is.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param target - the data directory, absolute, already proved inside `root`.
 * @param describe - the refusal message {@link assertSafeElevatedTarget} throws with.
 * @param mkdir - the root `mkdir -p` itself.
 * @returns what that `mkdir` returned.
 * @throws Error if a path to hand over fails the guard, or the transport fails.
 */
async function handBackWhatRootMakes(
  transport: Transport,
  root: string,
  target: string,
  describe: (reason: string) => string,
  mkdir: () => Promise<ExecResult>,
): Promise<ExecResult> {
  const state = await resolveSiteIdentity(transport);
  if (state.kind !== "site") return mkdir();
  const missing: string[] = [];
  for (
    let path = target;
    path !== root && path.startsWith(`${root}/`);
    path = posix.dirname(path)
  ) {
    if ((await execElevated(transport, "test", ["-e", path])).exitCode === 0) {
      break;
    }
    missing.push(path);
  }
  const made = await mkdir();
  if (made.exitCode !== 0 || missing.length === 0) return made;
  for (const path of missing) assertSafeElevatedTarget(path, root, describe);
  const { uid, gid } = state.identity;
  const chown = await execElevated(transport, "chown", [
    "-h",
    "--",
    `${String(uid)}:${String(gid)}`,
    ...missing,
  ]);
  if (chown.exitCode !== 0) {
    console.warn(
      `[wp/residue] ${describeTarget(transport)}: root made ${missing.join(", ")} but could not hand ` +
        `${missing.length === 1 ? "it" : "them"} to ${state.identity.user}:${state.identity.group} ` +
        `(exit ${String(chown.exitCode)}: ${chown.stderr.trim() || "no output"}); left root's, ` +
        `opened ${DATA_DIR_MODE}.`,
    );
  }
  return made;
}

/**
 * Runs `file args…` as the site's commands run (the identity in the `site` state, else the
 * transport's user), retrying with privileges if it was refused.
 *
 * Used for the preparation steps above, where a non-zero exit means "not permitted" rather than a
 * legitimate answer. Reports the *unprivileged* failure when escalation is unavailable or also fails,
 * because that is the one an operator can act on.
 *
 * @param transport - the target site's transport.
 * @param file - the command to run.
 * @param args - its arguments, as an array so nothing is shell-interpreted.
 * @param elevated - wraps the privileged retry (given it as a thunk), for a step that must act around
 * it; default: just the retry.
 * @throws Error naming the site, the command, the path and how far privileges reached.
 */
async function escalateIfDenied(
  transport: Transport,
  file: string,
  args: string[],
  elevated: (retry: () => Promise<ExecResult>) => Promise<ExecResult> = (
    retry,
  ) => retry(),
): Promise<void> {
  const first = await exec(transport, file, args);
  if (first.exitCode === 0) return;

  const elevation = await elevationSupport(transport);
  if (elevation === "available") {
    const retried = await elevated(() => execElevated(transport, file, args));
    if (retried.exitCode === 0) return;
  }
  throw new Error(
    `[wp/residue] ${describeTarget(transport)}: could not \`${file} ${args.join(" ")}\` ` +
      `(exit ${String(first.exitCode)}: ${(first.stderr || first.stdout).trim() || "no output"}; ` +
      `elevation: ${elevation}). The plugin's data directories must be writable by both the ` +
      "transport's user and the web server, which share this site's docroot — grant the transport's " +
      "user passwordless `sudo`, or make the parent directory writable by it.",
  );
}

/**
 * Most paths one `rm` is handed. Far below any platform's argument limit at a site path's length,
 * and still one command for every leftover pile a run has met (28, measured).
 */
const MAX_TARGETS_PER_COMMAND = 200;

/** `items` cut into runs of at most `size`. */
function chunked<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    chunks.push(items.slice(start, start + size));
  }
  return chunks;
}

/** What one removal pass works on: absolute paths, the family members grouped by absolute parent. */
interface RemovalTargets {
  /** Declared paths, absolute. */
  readonly paths: readonly string[];
  /** Family members, absolute, keyed by their absolute parent. */
  readonly families: ReadonlyMap<string, readonly string[]>;
}

/** Every target of a pass, absolute. */
function allTargets(targets: RemovalTargets): string[] {
  return [...targets.paths, ...[...targets.families.values()].flat()];
}

/**
 * `rm -rf`s every target with `run`, and returns the ones still there afterwards.
 *
 * **One `rm` for all of them, and one re-read per family.** Every command is a round-trip to the
 * site (~0.8 s over SSH, measured), and a removal that paid several per target made the teardown's
 * cost grow with the leftovers it found: 28 of them took it past its budget. `rm -rf` carries on past
 * a path it cannot remove, so every path is still attempted, and a caller still learns **all** the
 * survivors rather than the first.
 *
 * Removal is verified rather than inferred: `rm -rf` reports success for a path it never had to
 * touch. The re-read runs at the **same privilege** as the removal: a family by listing its parent
 * again — a listing that fails while the parent is still there counts every member as a survivor,
 * because "could not look" must never read as "gone" — and a declared path by {@link stillThere},
 * which sees a dangling link too.
 *
 * @param targets - what this pass removes.
 * @param run - how to run one command, at the privilege this pass uses.
 * @returns what is still present afterwards, in the same shape.
 */
async function removeAll(
  targets: RemovalTargets,
  run: Runner,
): Promise<RemovalTargets> {
  for (const chunk of chunked(allTargets(targets), MAX_TARGETS_PER_COMMAND)) {
    await run("rm", ["-rf", "--", ...chunk]);
  }
  const paths: string[] = [];
  for (const path of targets.paths) {
    if (await stillThere(path, run)) paths.push(path);
  }
  const families = new Map<string, readonly string[]>();
  for (const [parent, members] of targets.families) {
    const left = await membersStillThere(parent, members, run);
    if (left.length > 0) families.set(parent, left);
  }
  return { paths, families };
}

/**
 * Whether anything is still at `path`, a link included — dangling or not. `test -e` alone follows a
 * link, so a dangling one the transport's user could not unlink would read as gone and never be
 * retried with privileges. One command (`-o`, which GNU, BusyBox and BSD `test` all take), so the
 * check costs no extra round-trip; `test` takes no `--`, and the path is absolute, so it cannot be
 * read as an operator.
 *
 * @param path - the absolute path removal acted on.
 * @param run - how to run one command, at the privilege this pass uses.
 */
async function stillThere(path: string, run: Runner): Promise<boolean> {
  return (await run("test", ["-e", path, "-o", "-L", path])).exitCode === 0;
}

/**
 * Which of `members` a fresh listing of `parent` still shows, at `run`'s privilege — all of them when
 * the parent is still there but cannot be listed, none when the parent itself is gone.
 *
 * @param parent - the family's parent, absolute, as it was listed to find the members.
 * @param members - the members removal acted on, absolute, each directly inside `parent`.
 * @param run - how to run one command, at the privilege this pass uses.
 */
async function membersStillThere(
  parent: string,
  members: readonly string[],
  run: Runner,
): Promise<string[]> {
  const listing = await run("find", listingArgv(parent));
  if (listing.exitCode !== 0) {
    const parentGone = (await run("test", ["-e", parent])).exitCode !== 0;
    return parentGone ? [] : [...members];
  }
  const listed = new Set(
    listing.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => posix.basename(entry)),
  );
  return members.filter((member) => listed.has(posix.basename(member)));
}

/** The wording removal uses when a path cannot be placed inside the site, shared by both guards. */
function describeRemoval(root: string): (reason: string) => string {
  return (reason) =>
    `[wp/residue] refusing to remove leftover data: this site's WordPress root ("${root}") cannot ` +
    `be used for it — ${reason}. Fix the site's \`rootDir\`, or declare a residue path that stays ` +
    "inside the site.";
}

/**
 * Refuses a privileged `rm -rf` whose WordPress root is not a plausible site root.
 *
 * The rule is shared with every other elevated operation ({@link assertSafeElevatedTarget}); this
 * only supplies the wording, so an operator is told which of *this* operation's knobs fixes it.
 *
 * @param target - the absolute path the privileged `rm -rf` would act on.
 * @param root - the site's resolved WordPress root.
 * @throws Error naming the value and the rule it broke.
 */
function assertSafeElevatedRemoval(target: string, root: string): void {
  assertSafeElevatedTarget(
    target,
    root,
    (reason) =>
      `[wp/residue] refusing to remove leftover data with elevated privileges: this site's ` +
      `WordPress root ("${root}") cannot be used for it — ${reason}. Fix the site's \`rootDir\`, ` +
      "or set `transport.elevate: false` to keep cleanup unprivileged.",
  );
}

/**
 * Removes the declared leftovers from a site, and confirms they are gone.
 *
 * Two passes, and the order is the point: everything is attempted as the transport's own user, and
 * only what **survived** is retried with privileges. A host whose permissions are already right
 * therefore never runs a privileged command, while a host where the web-server user owns the data
 * still ends up clean. Re-running is safe either way — a path that is already gone is simply
 * confirmed gone.
 *
 * A family is expanded to its directories on the site now, so whatever an earlier, killed run left
 * under such a name goes too. One whose parent cannot be listed does not stop the rest from being
 * removed; it is reported once they have been.
 *
 * @param transport - the target site's transport.
 * @param paths - the product's declarations (see {@link parseResidueDeclaration}). An empty list does
 * nothing at all, not even resolving the root, so a product that leaves nothing behind pays nothing.
 * @throws Error if a declaration is not usable (see {@link parseResidueDeclaration}), if a family's
 * parent could not be listed (naming any survivors too), or if a path or the root is unusable for
 * removal (see {@link assertSafeElevatedRemoval}); or {@link SiteResidueRemovalFailedError} naming
 * whatever survived, and how far privileges reached.
 */
export async function removeSiteResidue(
  transport: Transport,
  paths: readonly SiteResidue[],
): Promise<void> {
  if (paths.length === 0) return;
  // Validate every declaration before touching the site: a typo in one should not leave the site
  // half-cleaned.
  const declarations = paths.map(parseResidueDeclaration);
  const root = await wpRootDir(transport);
  const found = await findResidue(transport, root, declarations);
  // Kept as thrown, so a `SiteResidueRemovalFailedError` still reaches the teardown as one.
  let removal: Error | undefined;
  try {
    await removeFound(transport, root, found);
  } catch (error) {
    removal = error instanceof Error ? error : new Error(errorMessage(error));
  }
  if (found.unlisted.length > 0) {
    throw new Error(
      [...found.unlisted, ...(removal === undefined ? [] : [removal])]
        .map((error) => error.message)
        .join("\n"),
    );
  }
  if (removal !== undefined) throw removal;
}

/**
 * The two removal passes over what was found — see {@link removeSiteResidue}.
 *
 * What it costs does not grow with what it finds: the root is resolved once, a family is checked
 * once through its parent, and each pass removes in one `rm` and re-reads in one listing per family
 * (see {@link removeAll}).
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param found - what the declarations name on the site now.
 * @throws Error if a path or the root is unusable for removal; or
 * {@link SiteResidueRemovalFailedError} naming whatever survived.
 */
async function removeFound(
  transport: Transport,
  root: string,
  found: FoundResidue,
): Promise<void> {
  const members = new Set(found.families.flatMap((family) => family.members));
  const targets: RemovalTargets = {
    paths: found.paths
      .filter((path) => !members.has(path))
      .map((path) => posix.join(root, path)),
    families: new Map(
      found.families.map((family) => [
        posix.join(root, family.parent),
        family.members.map((member) => posix.join(root, member)),
      ]),
    ),
  };

  // Before **either** pass, not just the privileged one. A path that resolves outside the site must
  // not be removed at any privilege: "unprivileged" is only a bound while the transport's user is
  // not root, which a `docker` container or a root SSH login does not guarantee — and deleting
  // another part of the filesystem is wrong either way. Measured before this existed: a symlinked
  // `wp-content/uploads` let `rm -rf` remove content outside the WordPress root. A family member is
  // a directory its parent's listing found, never a link (`listingArgv`), so it lies inside the root
  // exactly when that parent does: checking the parent checks every member.
  await assertAllResolvedInsideRoot(
    transport,
    [...targets.paths, ...targets.families.keys()],
    root,
    describeRemoval(root),
  );

  const removal = await removeTargetsEscalating(transport, root, targets);
  if (removal.kind === "left") {
    throw new SiteResidueRemovalFailedError(removal.paths, removal.elevation);
  }
}

/** What an escalating removal ended with — see {@link removeEscalating}. */
export type EscalatedRemoval =
  | { readonly kind: "removed" }
  | {
      readonly kind: "left";
      /** The targets still present, absolute. */
      readonly paths: readonly string[];
      /** How far privileges could go on this site — what makes advice about the survivors actionable. */
      readonly elevation: ElevationSupport;
    };

/**
 * `rm -rf`s absolute paths on the site: every one as the transport's user first, then only the
 * survivors with privileges — the order {@link removeSiteResidue} explains — and says what is left.
 *
 * Shared by everything that removes what the web server wrote, so the escalation and its guards live
 * once. **The caller has already checked that each target really resolves inside `root`**
 * (`assertAllResolvedInsideRoot`, or its parent's, for a link removed as a link): this only refuses a
 * root that is no plausible site root before going privileged.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param paths - the absolute paths to remove; a link is removed as a link, never followed.
 * @returns `removed`, or the survivors and the elevation that could not clear them.
 * @throws Error if the root or a target is unusable for a privileged removal.
 */
export async function removeEscalating(
  transport: Transport,
  root: string,
  paths: readonly string[],
): Promise<EscalatedRemoval> {
  return removeTargetsEscalating(transport, root, {
    paths,
    families: new Map(),
  });
}

/**
 * {@link removeEscalating} over a pass's targets, family members included.
 *
 * @param transport - the target site's transport.
 * @param root - the site's resolved WordPress root.
 * @param targets - what to remove, each already shown to resolve inside `root`.
 */
async function removeTargetsEscalating(
  transport: Transport,
  root: string,
  targets: RemovalTargets,
): Promise<EscalatedRemoval> {
  const survivors = await removeAll(targets, (file, args) =>
    exec(transport, file, args),
  );
  if (allTargets(survivors).length === 0) return { kind: "removed" };

  // Probed only now: a clean cell should not pay a round-trip asking about privileges it never needs.
  const elevation = await elevationSupport(transport);
  if (elevation !== "available") {
    return { kind: "left", paths: allTargets(survivors), elevation };
  }

  for (const target of allTargets(survivors)) {
    assertSafeElevatedRemoval(target, root);
  }
  const stubborn = await removeAll(survivors, (file, args) =>
    execElevated(transport, file, args),
  );
  return allTargets(stubborn).length === 0
    ? { kind: "removed" }
    : { kind: "left", paths: allTargets(stubborn), elevation };
}
