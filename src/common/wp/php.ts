import { wpCli } from "./exec";
import type { Transport } from "../config/types";

export { phpLiteral } from "./php-literal";

/**
 * Running small PHP snippets on a site through `wp eval`.
 *
 * Every caller of `wp eval` faces the same two problems, and they are solved once here: getting a
 * value *into* a snippet without inventing an escaping scheme, and telling "PHP refused" apart from
 * "the command could not run at all". Modules that read or change WordPress state through PHP build
 * on these rather than assembling snippets and error handling of their own. `phpLiteral` lives in
 * `./php-literal.ts` (no imports, so `./wp-user.ts`, below `./exec.ts`, can use it) and is re-exported.
 */

/** How a snippet wants WordPress loaded before it runs. */
export interface EvalPhpOptions {
  /**
   * Boot WordPress **without its plugins** (`--skip-plugins`).
   *
   * For snippets whose answer must not depend on what else is installed on the site — a cleanup
   * step, or anything asking about a plugin that is supposed to be gone. Core is fully loaded
   * either way, so `$wpdb` and the option API behave normally; only plugin code, and the filters it
   * registers, stay out. Off by default: a snippet that asks about a *running* site needs the site
   * as it really runs.
   */
  readonly skipPlugins?: boolean;
  /**
   * Boot WordPress **without its active theme** (`--skip-themes`) — for the same kind of snippet, when
   * a theme's own code could stop it from running at all.
   */
  readonly skipThemes?: boolean;
}

/**
 * Runs a `wp eval` snippet and returns its trimmed standard output.
 *
 * A non-zero exit is a failure of the *question*, not of the transport, so it throws with whatever
 * PHP or WP-CLI said — including a snippet's own `WP_CLI::error()`, which is how a snippet reports
 * a refusal in the site's own words.
 *
 * @param transport - the site to run on.
 * @param php - the snippet, without its opening tag.
 * @param what - what was being attempted, phrased to complete "… failed".
 * @param scope - the module reporting the failure, for the message prefix.
 * @param options - how WordPress should be loaded; see {@link EvalPhpOptions}.
 * @returns the snippet's output, trimmed.
 * @throws {@link Error} if the command exited non-zero.
 */
export async function evalPhp(
  transport: Transport,
  php: string,
  what: string,
  scope = "wp/php",
  options: EvalPhpOptions = {},
): Promise<string> {
  // The flags lead the argv: WP-CLI reads global parameters before it dispatches the subcommand,
  // and one placed after the snippet would be handed to `eval` as another positional argument.
  const argv = [
    ...(options.skipPlugins === true ? ["--skip-plugins"] : []),
    ...(options.skipThemes === true ? ["--skip-themes"] : []),
    "eval",
    php,
  ];
  const { stdout, stderr, exitCode } = await wpCli(transport, argv);
  if (exitCode !== 0) {
    throw new Error(
      `[${scope}] ${what} failed (exit ${String(exitCode)}): ` +
        ((stderr || stdout).trim() || "(no output)"),
    );
  }
  return stdout.trim();
}
