import { randomBytes } from "node:crypto";
import { posix } from "node:path";

import { exec } from "../../../common/wp/exec";
import { listFiles, pathFromWorkingDir } from "../../../common/wp/files";
import { evalPhp, phpLiteral } from "../../../common/wp/php";
import { resolveSiteIdentity } from "../../../common/wp/site-identity";
import { staleDirSweepScript } from "../../../common/wp/site-staging";
import {
  cleanSiteStaging,
  siteStagingDir,
  stagingPath,
} from "../../../common/wp/staging";
import { errorMessage, isObject } from "../../../common/guards";
import type { TestInfo } from "@playwright/test";
import type { SiteFile } from "../../../common/wp/files";
import type { Transport } from "../../../common/config/types";

/**
 * A folder of the scenario's own on the site, for the files a `wp backwpup …` command writes or reads
 * there — a downloaded backup, an exported job, a file the scenario made, a key.
 *
 * **It is on the site, not the runner**, because that is where the commands run: inside WP-CLI there,
 * resolving a relative path against the directory WP-CLI runs in — the WordPress root, on every
 * transport this suite drives. So the folder is handed to a command as a path relative to that
 * directory, worked out on the site from where the folder and WP-CLI really are once every symlink is
 * resolved, and read back by its absolute path.
 *
 * **It is private to the identity site commands run as**, because what lands in it can be a copy of
 * a backup — the site's whole database — an export naming that database, or a private key. Commands
 * and the assertions that check them all run as that identity, so it creates the folder with mode
 * `0700` (verified) and nobody else needs to read it. Where it lives depends on who that is
 * ({@link privateFolderHome}):
 *
 * - **Outside the `site` identity state** (commands as the SSH user), in this suite's own staging area,
 *   in a category of its own. The staging area is inside the docroot, and the web server serves any
 *   file there it can read (measured on the cells: HTTP 200); a folder only another user may enter is
 *   one it cannot read from (HTTP 404). Only the scenario's own folder is removed afterwards, never
 *   the category: a staging root declared as an absolute path is shared by every site on the host.
 * - **In the `site` state** (commands as the web server's identity) mode `0700` keeps nothing from
 *   the web server: it *is* the owner. So the folder leaves the docroot, as `/tmp/e2e-private-<name>`
 *   (made without `-p`, so a path already there, a planted link included, fails instead of being
 *   used), removed afterwards; one a killed run left is swept once an hour old.
 *
 * Its name carries a random part either way, so it cannot be guessed from the repository.
 */

/** Where a scenario's private folder lives on its site — see the module comment. */
export type PrivateHome =
  /** In the site's staging area, category {@link PRIVATE_CATEGORY}. */
  | { readonly kind: "staging" }
  /** Directly in `root`, an absolute folder outside the docroot, named `e2e-private-<key>`. */
  | { readonly kind: "outside"; readonly root: string };

/** Every private folder outside the docroot is named with this prefix; the sweep matches nothing else. */
export const OUTSIDE_PREFIX = "e2e-private-";

/** How old, in minutes, a private folder outside the docroot must be before a sweep removes it. */
export const OUTSIDE_MAX_AGE_MINUTES = 60;

/**
 * The private folder's home on a site whose commands run as the web server: `/tmp`, outside the
 * docroot, world-writable and sticky on every POSIX host.
 */
const OUTSIDE_HOME: PrivateHome = { kind: "outside", root: "/tmp" };

/**
 * Where the private folder lives on this site: outside the docroot in the `site` identity state
 * (ssh, commands as the web server), else in the staging area.
 *
 * @param transport - the scenario's site.
 * @throws Error if the identity state could not be resolved (a probe's transport failed).
 */
export async function privateFolderHome(
  transport: Transport,
): Promise<PrivateHome> {
  return transport.mode === "ssh" &&
    (await resolveSiteIdentity(transport)).kind === "site"
    ? OUTSIDE_HOME
    : { kind: "staging" };
}

/** The staging-area category the scenarios' private folders live in. */
export const PRIVATE_CATEGORY = "private";

/**
 * What a file placed without content of its own holds, so "left as it was" is a comparison against a
 * known value rather than against a copy taken earlier.
 */
export const PLACED_FILE_CONTENT = "A file the scenario placed here.\n";

/** A folder name: the scenario's test id, its attempt and a random part, all of these characters. */
const KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/**
 * The folder's name for one attempt at one scenario: its test id and retry number, so a leftover can
 * be traced back to the scenario that left it, then a random part, so the name cannot be guessed from
 * the repository the test id is derived from.
 *
 * @throws {@link Error} if the id holds anything but letters, digits and hyphens — the name ends up
 * on a command line split on whitespace, and in a path.
 */
export function privateFolderKey(
  testInfo: Pick<TestInfo, "testId" | "retry">,
): string {
  const key = `${testInfo.testId}-r${String(testInfo.retry)}-${randomBytes(8).toString("hex")}`;
  if (!KEY.test(key)) {
    throw new Error(
      `[backwpup/private-folder] cannot name a folder after the test id "${testInfo.testId}": ` +
        "it holds characters a path or a command line would not carry.",
    );
  }
  return key;
}

/** The end of both preparing snippets: the folder's mode, where it really is, where WP-CLI runs. */
const REPORT_PREPARED =
  "clearstatcache( true, $dir );\n" +
  "echo wp_json_encode( [ 'mode' => decoct( fileperms( $dir ) & 0777 ), 'path' => realpath( $dir ), 'cwd' => getcwd() ] );";

/**
 * PHP that creates `dir` so that only its owner may enter it, then reports the mode it ended up with,
 * where it really is and where WP-CLI really runs. Only the folder itself is made private, by the mode
 * it is created with — which a `umask` can only narrow, and the reply shows.
 *
 * In the staging area the parents are created as WordPress creates any folder, and a folder already
 * there is reused. Outside it (`strict`) nothing but the folder is created, and only by this call:
 * `mkdir` fails on anything already at the path, a link included, so a folder another user planted in
 * a shared directory is never written into.
 *
 * @param dir - the folder, absolute.
 * @param strict - the folder must be new, its parent must exist.
 */
function createPrivatelyPhp(dir: string, strict: boolean): string {
  const create = strict
    ? "if ( ! mkdir( $dir, 0700 ) ) {\n"
    : "if ( ! wp_mkdir_p( dirname( $dir ) ) ) {\n" +
      "\tWP_CLI::error( 'could not create ' . dirname( $dir ) );\n" +
      "}\n" +
      "if ( ! is_dir( $dir ) && ! mkdir( $dir, 0700 ) ) {\n";
  return (
    `$dir = ${phpLiteral(dir)};\n` +
    create +
    "\tWP_CLI::error( 'could not create ' . $dir );\n" +
    "}\n" +
    REPORT_PREPARED
  );
}

/**
 * The path a command run in WP-CLI's working directory reaches the folder by, read from what
 * {@link createPrivatelyPhp} reported — once the folder is shown to have come out private.
 *
 * @param reply - what the snippet printed.
 * @param dir - the folder as this suite names it, for messages.
 * @throws {@link Error} if the reply is not JSON, the folder did not come out private, or the site
 * could not say where it or WP-CLI is.
 */
export function preparedFolderPath(reply: string, dir: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply);
  } catch {
    throw new Error(
      `[backwpup/private-folder] preparing ${dir} did not come back as JSON: ${reply.slice(0, 300) || "(empty)"}`,
    );
  }
  const mode = isObject(parsed) ? parsed.mode : undefined;
  if (mode !== "700") {
    throw new Error(
      `[backwpup/private-folder] ${dir} came out with mode ${JSON.stringify(mode)}, not 700 — the ` +
        "mode that keeps what is written there to the identity site commands run as.",
    );
  }
  return pathFromWorkingDir(parsed, dir);
}

/** One scenario's private folder — see the module comment. */
export class PrivateFolder {
  /** The site the folder is on. */
  private readonly transport: Transport;

  /** Its name: inside the private category, or after {@link OUTSIDE_PREFIX}. */
  private readonly key: string;

  /** Decides where the folder lives; asked once. */
  private readonly decideHome: () => Promise<PrivateHome>;

  /** Where the folder lives, once asked. */
  private home: Promise<PrivateHome> | undefined;

  /** Whether it was handed out, and so may hold something to remove. */
  private used = false;

  /** The folder's creation, once asked for; the path a command reaches it by, once done. */
  private prepared: Promise<string> | undefined;

  /**
   * A folder by that name, not created yet — nothing happens on the site until a step uses it.
   *
   * @param transport - the site the folder is on.
   * @param key - its name, from {@link privateFolderKey}.
   * @param home - where it lives; default {@link privateFolderHome}, asked when first needed.
   * @throws {@link Error} if the name holds anything but letters, digits and hyphens.
   */
  constructor(
    transport: Transport,
    key: string,
    home: () => Promise<PrivateHome> = () => privateFolderHome(transport),
  ) {
    if (!KEY.test(key)) {
      throw new Error(
        `[backwpup/private-folder] "${key}" is not a usable folder name.`,
      );
    }
    this.transport = transport;
    this.key = key;
    this.decideHome = home;
  }

  /** Where the folder is on the site, absolute — for reading back what a command wrote there. */
  async absolutePath(): Promise<string> {
    const home = await this.where();
    return home.kind === "outside"
      ? posix.join(home.root, `${OUTSIDE_PREFIX}${this.key}`)
      : stagingPath(
          await siteStagingDir(this.transport),
          PRIVATE_CATEGORY,
          this.key,
        );
  }

  /**
   * Where a file in the folder is on the site, absolute.
   *
   * @param name - the file's name; a single path segment.
   * @throws {@link Error} if the name is not a single segment.
   */
  async absolutePathTo(name: string): Promise<string> {
    return stagingPath(await this.absolutePath(), name);
  }

  /**
   * The folder as a command is given it: relative to the directory WP-CLI runs in — created first,
   * private to the identity site commands run as, so nothing a command writes there is ever served.
   *
   * @throws {@link Error} if the folder could not be created, did not come out private, or could not
   * be located from where WP-CLI runs.
   */
  relativePath(): Promise<string> {
    return this.prepare();
  }

  /**
   * A file in the folder as a command is given it — see {@link PrivateFolder.relativePath}. The
   * folder is created, the file is not: a command may be about to write it.
   *
   * @param name - the file's name; a single path segment, checked before anything is created.
   * @throws {@link Error} if the name is not a single segment, or the folder could not be prepared.
   */
  async relativePathTo(name: string): Promise<string> {
    await this.absolutePathTo(name);
    return posix.join(await this.relativePath(), name);
  }

  /**
   * What the folder holds, with digests — nothing at all while it does not exist.
   *
   * @throws {@link Error} if the folder exists but cannot be read.
   */
  async list(): Promise<readonly SiteFile[]> {
    return listFiles(this.transport, await this.absolutePath(), {
      digests: true,
      missingAsEmpty: true,
    });
  }

  /**
   * Places a file in the folder, creating the folder first, and checks it reads back as written.
   *
   * @param name - the file's name; a single path segment, checked before anything is created.
   * @param content - what it holds; {@link PLACED_FILE_CONTENT} when the scenario only needs a file
   * it can recognise later.
   * @throws {@link Error} if the name is not a single segment, the folder could not be prepared, or
   * the file did not read back as written.
   */
  async place(name: string, content = PLACED_FILE_CONTENT): Promise<void> {
    const path = await this.absolutePathTo(name);
    await this.prepare();
    const php =
      `$path = ${phpLiteral(path)};\n` +
      `$content = ${phpLiteral(content)};\n` +
      "if ( false === file_put_contents( $path, $content ) ) {\n" +
      "\tWP_CLI::error( 'could not write ' . $path );\n" +
      "}\n" +
      "echo file_get_contents( $path ) === $content ? 'placed' : 'differs';";
    const reply = await evalPhp(
      this.transport,
      php,
      `placing ${name} in the private folder`,
      "backwpup/private-folder",
    );
    if (reply !== "placed") {
      throw new Error(
        `[backwpup/private-folder] ${name} did not read back as written (${JSON.stringify(reply)}).`,
      );
    }
  }

  /**
   * Removes the folder if this scenario used it — its own folder only, since the category may hold
   * another run's. Outside the docroot, also sweeps the identity's private folders a killed run left
   * there over {@link OUTSIDE_MAX_AGE_MINUTES} minutes ago (a younger one may be another run's).
   * Teardown, so it never throws: a failure is reported; the worker's own teardown removes the whole
   * staging area anyway, and the next sweep a folder outside it.
   */
  async release(): Promise<void> {
    if (!this.used) return;
    try {
      const home = await this.where();
      if (home.kind === "staging") {
        await cleanSiteStaging(this.transport, PRIVATE_CATEGORY, this.key);
        return;
      }
      await this.removeOutside(home.root);
    } catch (error) {
      console.warn(
        `[backwpup/private-folder] could not remove the scenario's private folder: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Removes the folder outside the docroot, then the stale ones, as the identity that made them.
   *
   * @param root - the folder they are in.
   * @throws Error naming the step that failed.
   */
  private async removeOutside(root: string): Promise<void> {
    const dir = await this.absolutePath();
    // No trailing slash: a link swapped in at the path is removed itself, never followed.
    const removed = await exec(this.transport, "rm", ["-rf", "--", dir]);
    if (removed.exitCode !== 0) {
      throw new Error(
        `rm exited ${String(removed.exitCode)} for ${dir}: ${removed.stderr.trim() || "no output"}`,
      );
    }
    const swept = await exec(this.transport, "sh", [
      "-c",
      staleDirSweepScript(OUTSIDE_PREFIX),
      "e2e-private-sweep",
      root,
      String(OUTSIDE_MAX_AGE_MINUTES),
    ]);
    if (swept.exitCode !== 0) {
      throw new Error(
        `sweeping stale private folders in ${root} exited ${String(swept.exitCode)}: ` +
          (swept.stderr.trim() || "no output"),
      );
    }
  }

  /** Where the folder lives, decided once. */
  private where(): Promise<PrivateHome> {
    this.home ??= this.decideHome();
    return this.home;
  }

  /**
   * Creates the folder the first time it is needed, private to the identity site commands run as —
   * every later call reuses that. Marks it used before anything is created, so even a creation that
   * failed half-way is cleaned up.
   */
  private prepare(): Promise<string> {
    this.used = true;
    this.prepared ??= this.createPrivately();
    return this.prepared;
  }

  /** Creates the folder with mode `0700`, and returns the path a command reaches it by. */
  private async createPrivately(): Promise<string> {
    const strict = (await this.where()).kind === "outside";
    const dir = await this.absolutePath();
    const reply = await evalPhp(
      this.transport,
      createPrivatelyPhp(dir, strict),
      "preparing the private folder",
      "backwpup/private-folder",
    );
    return preparedFolderPath(reply, dir);
  }
}
