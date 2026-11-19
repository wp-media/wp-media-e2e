import { isObject } from "../guards";
import { escapeRegExp } from "../text";
import { env } from "./env";
import { cellProjectNames } from "./project-names";

/**
 * The cell pin: `E2E_CELL=<cell>` holds a run to one cell of its product.
 *
 * `bddgen` regenerates the specs of every cell its config holds, deleting each cell's files before
 * writing them again, so a run of one cell could find its specs missing while another cell's run
 * started. `bddgen` takes no `--project`, and npm hands `-- args` to a script's last command only,
 * so the environment is the one channel that reaches `bddgen`, the runner and every worker alike.
 * Pinned, the config holds that cell alone: `bddgen` touches only its specs, and the run selects
 * its three projects without any `--project`.
 */

/** The variable that pins a run to one cell. */
export const CELL_PIN_ENV = "E2E_CELL";

/**
 * playwright-bdd's own channel to `bddgen` and the workers: every BDD config a process has defined,
 * as JSON keyed by each config's absolute output folder (`config/env.js`). `bddgen` generates every
 * config listed there, including one the process merely **inherited** (measured).
 */
export const BDD_CONFIGS_ENV = "PLAYWRIGHT_BDD_CONFIGS";

/** Where a pin may come from, for messages: an operator who never typed it set it in `.env`. */
const PIN_SOURCE =
  "it comes from your environment or from the .env in the working directory";

/**
 * The cell `E2E_CELL` pins this run to, verbatim, or `undefined` when it is unset or blank — the
 * same "blank means unset" rule as every other variable of the suite. Surrounding whitespace is
 * kept, so a stray space fails {@link assertPinKnown} instead of pinning a cell nobody named.
 */
export function pinnedCell(): string | undefined {
  const pin = env(CELL_PIN_ENV);
  return pin === "" ? undefined : pin;
}

/**
 * Refuses a pin that names none of the product's cells.
 *
 * @param pin - the pinned cell, from {@link pinnedCell}.
 * @param product - the product's name.
 * @param cells - the product's cells.
 * @throws {@link Error} naming the variable, its value, the product's cells and the fix.
 */
export function assertPinKnown(
  pin: string,
  product: string,
  cells: readonly string[],
): void {
  if (cells.includes(pin)) return;
  throw new Error(
    `[cell] ${CELL_PIN_ENV}=${JSON.stringify(pin)} is not a cell of ${product}; its cells: ` +
      `${cells.length > 0 ? cells.join(", ") : "(none)"}. Set ${CELL_PIN_ENV} to one of ` +
      `them, or unset it to run without a pin (${PIN_SOURCE}).`,
  );
}

/**
 * Whether a `--project` filter selects a project, by Playwright's own rule (`filterProjects`, 1.65.1):
 * case-insensitive, and each `*` matches any run of characters.
 *
 * @param filter - one `--project` value, as typed.
 * @param name - a project's name.
 */
export function matchesProjectFilter(filter: string, name: string): boolean {
  const pattern = filter.toLocaleLowerCase();
  const target = name.toLocaleLowerCase();
  if (!pattern.includes("*")) return pattern === target;
  const source = pattern.split("*").map(escapeRegExp).join(".*");
  return new RegExp(`^${source}$`, "i").test(target);
}

/**
 * The cells a `--project` selection reaches, by Playwright's own matching ({@link matchesProjectFilter}):
 * each cell one of whose projects — its scenarios, `setup:`, `artifacts:` — some value selects. Wider
 * than the values that name a cell exactly: `SMALL` or `sm*` reach the cell `small` too.
 *
 * @param cells - the product's cells, as the config builds them.
 * @param selection - the run's `--project` values, verbatim.
 * @returns the cells reached, in `cells`' order.
 */
export function cellsReached(
  cells: readonly string[],
  selection: readonly string[],
): string[] {
  return cells.filter((cell) =>
    Object.values(cellProjectNames(cell)).some((name) =>
      selection.some((filter) => matchesProjectFilter(filter, name)),
    ),
  );
}

/**
 * Refuses a `--project` that selects none of the pinned cell's projects. Playwright would refuse it
 * too, but as a bare "Project(s) … not found" that never names `E2E_CELL` — a puzzle when the pin
 * came from `.env`. A wildcard that selects none is refused here as well, which is stricter than
 * Playwright (it accepts one such pattern beside others that select): in a pinned run it can only
 * mean another cell.
 *
 * @param pin - the pinned cell, already known to the product.
 * @param pinProjects - the pinned cell's project names.
 * @param selection - the run's `--project` values, verbatim.
 * @throws {@link Error} naming each such value, the pin, its projects and the fix.
 */
export function assertSelectionFitsPin(
  pin: string,
  pinProjects: readonly string[],
  selection: readonly string[],
): void {
  const strays = selection.filter(
    (filter) => !pinProjects.some((name) => matchesProjectFilter(filter, name)),
  );
  if (strays.length === 0) return;
  const named = strays.map((value) => JSON.stringify(value)).join(", ");
  throw new Error(
    `[cell] --project ${named} selects nothing in this run: ${CELL_PIN_ENV} pins it to ` +
      `${JSON.stringify(pin)}, whose projects are ${pinProjects.join(", ")}. Drop --project ` +
      `(the pin selects the cell), or set ${CELL_PIN_ENV} to the cell you meant (${PIN_SOURCE}).`,
  );
}

/** What follows `/.features-gen/` in a generated-spec folder: `<product>/<cell>`. */
const GENERATED_TAIL = /\/\.features-gen\/(.+)$/;

/**
 * Refuses a pinned run that inherited playwright-bdd's list of BDD configs naming another cell's
 * generated specs. `bddgen` would regenerate those too — deleting them first, under whatever run is
 * using them — while the pin promises it touches only its own (measured: pinned to `free@nginx` with
 * an inherited list, it rewrote every `pro@nginx` spec). Only a process started from inside another
 * run inherits such a list.
 *
 * Compared by the folder's tail, `<product>/<cell>`, so a checkout reached through a symlink still
 * recognises its own entry; a key that is no generated-spec folder at all is not this check's to
 * judge, so a change in playwright-bdd's format cannot make every pinned run fail. The tail alone
 * cannot tell the same cell's folder in another checkout (a run started from inside a sibling
 * worktree's run): playwright-bdd resolves the folder against the config's own location, which this
 * check cannot know before the config defines it. The orchestrator never hands a run this variable.
 *
 * @param inherited - the variable's value **before** this process defines its own BDD config.
 * @param product - the product's name.
 * @param pin - the pinned cell.
 * @throws {@link Error} naming the variable, the foreign folders and the fix.
 */
export function assertNoForeignBddConfigs(
  inherited: string | undefined,
  product: string,
  pin: string,
): void {
  if (inherited === undefined || inherited.trim() === "") return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(inherited);
  } catch {
    return;
  }
  if (!isObject(parsed)) return;
  const own = `${product}/${pin}`;
  const foreign = Object.keys(parsed)
    .map((key) => GENERATED_TAIL.exec(key.replace(/\/+$/, ""))?.[1])
    .filter((tail): tail is string => tail !== undefined && tail !== own);
  if (foreign.length === 0) return;
  throw new Error(
    `[cell] ${BDD_CONFIGS_ENV} came into this run naming other cells' specs ` +
      `(${foreign.join(", ")}), so bddgen would regenerate them although ${CELL_PIN_ENV} pins ` +
      `the run to ${JSON.stringify(pin)}. It is playwright-bdd's own variable, inherited from an ` +
      `enclosing run: unset it (\`env -u ${BDD_CONFIGS_ENV}\`) and start again.`,
  );
}
