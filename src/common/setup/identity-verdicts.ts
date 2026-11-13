import { effectiveRunAs } from "../config/run-as";
import type { SiteInput } from "../config/types";
import { maskSiteUrl, printableLine } from "../text";
import { registerSiteIdentityVerdicts } from "../wp/site-identity";
import { installKey } from "../wp/transport-exec";
import { readSiteIdentityFile } from "../wp/web-identity";
import type { SiteIdentityFileRead } from "../wp/web-identity";

/**
 * A worker's half of the site identity verdict: the auth setup's pre-flight asked each `auto` site's
 * web server who PHP runs as and wrote `site-identity.json` in the cell's auth folder; a worker reads
 * it before its first site command and gives this process its site's verdict. Without one, an `auto`
 * site runs as the transport's user (`fallback/unverified`), and the worker says why once.
 *
 * Only `auto` (also what an absent `runAs` means) needs a verdict: a site with `runAs` false or a
 * declared `"user:group"` reads nothing here.
 */

/**
 * Why a worker has no verdict for its site, in words; `undefined` when it has one. Pure.
 *
 * @param read - what reading the file found.
 * @param found - whether the file held this site's verdict.
 */
export function missingVerdictReason(
  read: SiteIdentityFileRead,
  found: boolean,
): string | undefined {
  switch (read.kind) {
    case "read":
      return found
        ? undefined
        : "this run's pre-flight left no verdict for it (its web probe failed)";
    case "missing":
      return "no verdict file (the auth setup did not run: --no-deps?)";
    case "stale":
      return "the verdict file is another run's (the auth setup did not run: --no-deps?)";
    case "invalid":
      return `the verdict file is unreadable (${read.why})`;
  }
}

/**
 * Reads this run's verdict file and registers the site's verdict; warns once (this is called once
 * per worker) when an `auto` site has none. Never throws: no verdict means today's behaviour.
 *
 * @param site - the worker's site.
 * @param dir - the cell's auth folder, absolute.
 * @param runId - this run's `RUN_ID`.
 * @param warn - where the warning goes (`console.warn`; the run's reporter prints a worker's output).
 * @param register - gives the process the verdict (`registerSiteIdentityVerdicts`; specs observe it).
 */
export async function registerRunVerdict(
  site: SiteInput,
  dir: string,
  runId: string,
  warn: (message: string) => void = console.warn,
  register: typeof registerSiteIdentityVerdicts = registerSiteIdentityVerdicts,
): Promise<void> {
  if (effectiveRunAs(site.transport) !== "auto") return;
  const read = await readSiteIdentityFile(dir, runId);
  const key = installKey(site.transport);
  const verdict = read.kind === "read" ? read.verdicts.get(key) : undefined;
  if (verdict !== undefined) {
    register(new Map([[key, verdict]]));
  }
  const reason = missingVerdictReason(read, verdict !== undefined);
  if (reason !== undefined) {
    warn(
      `[site-identity] ${printableLine(maskSiteUrl(site.baseURL))}: ${reason}; site commands run as ` +
        "the transport's user (unverified).",
    );
  }
}
