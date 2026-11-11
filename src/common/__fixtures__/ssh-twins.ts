import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { parseBoolean } from "../config/env";
import { loadSites } from "../config/sites";
import type { CellMap, SiteInput } from "../config/types";

/**
 * For specs run against the SSH twins (`docker/ssh-cells/`, `npm run env:cells:up`): whether they
 * run, and the twins' sites as the overlays the twins wrote declare them, loaded the way a run loads
 * them. Twin specs are opt-in, so `npm run test:unit` (and the main CI) never needs Docker.
 */

/** The variable turning twin specs on (`E2E_SSH_TWINS=1`), set by the twins' workflow. */
export const SSH_TWINS_ENV = "E2E_SSH_TWINS";

/** Why a twin spec skipped, shown in its report. */
export const SSH_TWINS_SKIP_REASON = `twin specs run only with ${SSH_TWINS_ENV}=1 and the twins up (npm run env:cells:up)`;

/**
 * Whether twin specs run. A value other than a boolean fails the spec file's load, never skips it:
 * a typo in CI would otherwise turn every twin spec into a silent skip.
 *
 * @param source - the environment to read; `process.env` unless a spec holds another.
 * @returns `true` when {@link SSH_TWINS_ENV} is `1`/`true`; `false` when `0`/`false`, blank or unset.
 * @throws Error naming the variable, the values it takes and what each does.
 */
export function sshTwinsEnabled(
  source: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = source[SSH_TWINS_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  const enabled = parseBoolean(raw);
  if (enabled !== undefined) return enabled;
  throw new Error(
    `${SSH_TWINS_ENV} takes 1 or true (run the twin specs; the twins must be up: npm run env:cells:up) ` +
      `or 0, false or unset (skip them), got ${JSON.stringify(raw)}.`,
  );
}

/** The twins' two stacks, one container each. */
export type TwinStack = "apache" | "nginx";

/** One product's cell on one twin. */
export interface TwinCell {
  /** The product folder under `src/projects/`. */
  readonly product: "backwpup" | "wp-rocket";
  /** The cell the product's `sites.twins.json` declares. */
  readonly cell: string;
  /** The twin it runs on. */
  readonly stack: TwinStack;
}

/** Every cell the twins' overlays declare (`cells.sh`): BackWPup's need an edition, WP Rocket's none. */
export const TWIN_CELLS: readonly TwinCell[] = [
  { product: "backwpup", cell: "pro@twin-apache", stack: "apache" },
  { product: "backwpup", cell: "pro@twin-nginx", stack: "nginx" },
  { product: "wp-rocket", cell: "twin-apache", stack: "apache" },
  { product: "wp-rocket", cell: "twin-nginx", stack: "nginx" },
];

/** The checkout's root, three folders up from this file. */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * The one site of a twin cell, from `cells` (a product's loaded sites files).
 *
 * @param cells - the product's merged cells, as {@link loadSites} returns them.
 * @param twin - which cell.
 * @returns its only site.
 * @throws Error naming the cell when it is absent or its pool is not exactly one site: the overlay
 * is missing (the twins are down) or was not written by `cells.sh`.
 */
export function twinSiteIn(cells: CellMap, twin: TwinCell): SiteInput {
  const sites = cells[twin.cell]?.sites ?? [];
  const [site] = sites;
  if (site === undefined || sites.length !== 1) {
    throw new Error(
      `${twin.product}: cell "${twin.cell}" should hold exactly one site, found ${String(sites.length)}. ` +
        "Run npm run env:cells:up first: it writes the twins' sites.twins.json.",
    );
  }
  return site;
}

/**
 * A twin cell's site, loaded from its product's sites files exactly as a run loads them: the whole
 * config folder, so a real `sites.json` beside the overlay is read too (only the twin's site is ever
 * contacted). A clash between them (a twin cell `sites.json` also declares, mixed editions) then fails
 * here, loudly, as it would fail the run.
 *
 * @param twin - which cell.
 * @returns its only site.
 * @throws Error when the sites files do not load or the cell is not there.
 */
export function twinSite(twin: TwinCell): SiteInput {
  return twinSiteIn(
    loadSites(join(REPO_ROOT, "src", "projects", twin.product, "config")),
    twin,
  );
}
