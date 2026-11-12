import { SiteIdentityRefusedError } from "./errors";
import { isSudoRefusal } from "./run-as-argv";
import { forgetSiteIdentity, resolveSiteIdentity } from "./site-identity";
import { describeTarget, execAsSite, execAsTransport } from "./transport-exec";
import {
  forgetWpUser,
  isUnknownUserError,
  shouldUseWpUser,
  withWpUser,
  wpUserCheckArgs,
  wpUserKey,
} from "./wp-user";
import type { ExecOptions, ExecResult } from "./transport-exec";
import type { Transport } from "../config/types";

export * from "./transport-exec";

/**
 * The WordPress layer's entry point for site commands: {@link exec} and {@link wpCli} run as the
 * site's **identity state** decides (`./site-identity.ts`), everything else (transports, elevation,
 * transfer, path resolution) is `./transport-exec.ts`, re-exported here unchanged.
 *
 * - **`site`** (over `ssh`, once verified): as the web server's user and group, through
 *   `sudo -n -u <user> -g <group> -- /bin/sh -c <constant wrapper> e2e-run-as <umask> <cwd> <file> <args…>`,
 *   so what the suite writes looks as if the website wrote it. The wrapper sets the umask and enters
 *   the working directory as the identity; `sudo`'s leading unresolvable-host lines are removed from
 *   stderr. A later refusal by `sudo` itself (exit 1, stderr wholly sudo's: `sudo:` lines or its
 *   explicit deny, `Sorry, user … is not allowed to execute '<command>' …`; a rule changed mid-run) is
 *   no answer from the program: {@link SiteIdentityRefusedError}, never quoting sudo (whose deny quotes
 *   the arguments), and that resolution is forgotten, so the next command resolves again.
 * - **every other state** (`same-user`, `fallback`, `disabled`; always on `docker`/`local`): as the
 *   transport's user, byte for byte the command line it always was.
 *
 * {@link wpCli} also runs WordPress as the site's administrator (`--user=<login>`, `./wp-user.ts`);
 * {@link exec} adds nothing to a `wp` it is given.
 *
 * WP-CLI is never root: {@link wpCli} has no way to ask for it, and the root rules
 * (`execElevated`: housekeeping only, attempted second, refusable) are unchanged. Probes the state
 * is decided from use `execAsTransport`, never this module, so none recurses through the resolver.
 *
 * Resolving the state may run its probes once per install per process (`stat`, `id`, then the
 * `sudo` run probe); a transport failure there is thrown from the command that asked, which never
 * runs as a guess.
 */

/**
 * Runs `file args…` on the site, as its identity state decides (see this module's header).
 *
 * @param transport - the site's transport.
 * @param file - the program.
 * @param args - its arguments.
 * @param options - see {@link ExecOptions}.
 * @returns the outcome: branch on `exitCode`.
 * @throws {@link SiteIdentityRefusedError} if `sudo` refused the verified identity (the state is
 * forgotten); Error if the state could not be resolved (a probe's transport failed) or the command
 * could not run, naming the program, never its arguments.
 */
export async function exec(
  transport: Transport,
  file: string,
  args: string[],
  options: ExecOptions = {},
): Promise<ExecResult> {
  // Kept, so a refusal forgets this resolution only, never a newer one made since.
  const resolution = resolveSiteIdentity(transport);
  const state = await resolution;
  if (state.kind === "site") {
    if (transport.mode !== "ssh") {
      // Unreachable: the resolver decides `site` over ssh only.
      throw new Error(
        `[wp/exec] refusing to run "${file}": a ${transport.mode} transport has no site identity.`,
      );
    }
    const result = await execAsSite(transport, state, file, args, options);
    if (isSudoRefusal(result)) {
      forgetSiteIdentity(transport, resolution);
      throw new SiteIdentityRefusedError(file, describeTarget(transport));
    }
    return result;
  }
  return execAsTransport(transport, file, args, options);
}

/**
 * Runs WP-CLI (`wp args…`) through the transport. The primary entry point for the WP layer.
 *
 * As the site's identity in the `site` state, else as the transport's user; never root, and
 * deliberately unable to be: files WP-CLI created as root would be unwritable by the web server.
 *
 * With `transport.wpUser` set (every loaded site; an `asTransportUser` copy and a hand-built
 * transport have none), `--user=<login>` leads the arguments once the install's check passed
 * (`./wp-user.ts`: one `wp eval` per install per process, itself without `--user`, run in the
 * WordPress root without `options`: its verdict serves every caller). Should WP-CLI then refuse the
 * login as naming nobody (it was removed mid-process), that answer is discarded, the verdict
 * forgotten (warned once; checked again after a wait) and the call run once more without `--user`.
 * The command never ran: WP-CLI resolves `--user` in an `init` hook (priority 0), after
 * `wp-config.php`, plugins and theme loaded (they load again on the retry, as on any call) but before
 * the command dispatches.
 *
 * @param transport - the site's transport.
 * @param args - WP-CLI's arguments.
 * @param options - see {@link ExecOptions}.
 * @returns the outcome, as {@link exec}.
 * @throws as {@link exec}; also Error if the `--user` check could not run (the transport failed).
 */
export async function wpCli(
  transport: Transport,
  args: string[],
  options?: ExecOptions,
): Promise<ExecResult> {
  const login = transport.wpUser;
  if (login === undefined) return exec(transport, "wp", args, options);
  const key = wpUserKey(transport, await resolveSiteIdentity(transport), login);
  const useLogin = await shouldUseWpUser(transport, key, login, () =>
    exec(transport, "wp", wpUserCheckArgs(login)),
  );
  if (!useLogin) return exec(transport, "wp", args, options);
  const result = await exec(transport, "wp", withWpUser(login, args), options);
  if (!isUnknownUserError(result, login)) return result;
  forgetWpUser(transport, key);
  return exec(transport, "wp", args, options);
}
