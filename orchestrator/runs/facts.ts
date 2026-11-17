import { z } from "zod";

import { isSuiteVersion } from "../../src/common/config/suite-version";

/**
 * What a run tested, read back from the suite's `run-facts.json`: the edition, the plugin built, each
 * site's versions, and the setups that failed. Only the fields the orchestrator reports are read, and
 * each is checked: a fact of another shape reads as unknown, never as an error — a run's facts
 * describe it, and must never turn its outcome into a crash.
 */

/** The facts' file, in the run's report folder. */
export const RUN_FACTS_FILE = "run-facts.json";

/** The facts' schema version this reader knows. */
const RUN_FACTS_VERSION = 1;

/** The plugin under test, as the artifacts setup resolved it. */
export interface PluginFacts {
  /** The `Plugin Name:` header: `BackWPup Pro`. */
  readonly name?: string;
  readonly version?: string;
  /** The ref built: `develop`, `release:latest-stable`. */
  readonly ref?: string;
  /** The full commit built; absent for a release's zip. */
  readonly commit?: string;
}

/** One site of the pool, and its versions when the auth setup read them. */
export interface SiteFacts {
  readonly baseURL: string;
  readonly wordpress?: string;
  readonly php?: string;
}

/** A setup that failed, and its first error's first line. */
export interface SetupFailureFact {
  readonly setup: string;
  readonly message: string;
}

/** What the orchestrator reads of a run's facts. */
export interface RunFactsRead {
  readonly edition?: string;
  /** The suite's version the run used (`1.1.0`); absent when the run did not record a valid one. */
  readonly suiteVersion?: string;
  /** The plugin under test (role `plugin`), when it was resolved. */
  readonly plugin?: PluginFacts;
  /** The pool's sites, in pool order. */
  readonly sites: readonly SiteFacts[];
  readonly setupFailures: readonly SetupFailureFact[];
}

/** One field, any value: kept when it is a string, else read as unknown. */
const optionalText = z.string().optional().catch(undefined);

/**
 * The suite's version: kept only when it is one the suite would show (SemVer 2.0, at most 64
 * characters), so a hand-edited or foreign file's text never reaches a message as a version.
 */
const suiteVersion = optionalText.transform((value) =>
  isSuiteVersion(value) ? value : undefined,
);

/**
 * A list whose malformed items are dropped, and which reads as empty when it is not a list.
 *
 * @param item - one item's schema; an item it refuses is dropped, never the list.
 */
function lenientList<T extends z.ZodType>(item: T) {
  return z
    .array(z.unknown())
    .catch([])
    .transform((items) =>
      items.flatMap((value) => {
        const parsed = item.safeParse(value);
        return parsed.success ? [parsed.data] : [];
      }),
    );
}

/** The part of `run-facts.json` read here; every other field is ignored. */
const factsSchema = z.object({
  v: z.literal(RUN_FACTS_VERSION),
  edition: optionalText,
  suiteVersion,
  setupFailures: lenientList(
    z.object({ setup: z.string(), message: z.string() }),
  ),
  cells: lenientList(
    z.object({
      cell: z.string(),
      plugins: lenientList(
        z.object({
          role: z.string(),
          ok: z.literal(true),
          name: optionalText,
          version: optionalText,
          ref: optionalText,
          commit: optionalText,
        }),
      ),
      sites: lenientList(
        z.object({
          baseURL: z.string(),
          versions: z
            .object({ wordpress: optionalText, php: optionalText })
            .optional()
            .catch(undefined),
        }),
      ),
    }),
  ),
});

/**
 * Reads a run's facts for one cell.
 *
 * @param text - `run-facts.json`'s text.
 * @param cell - the run's cell.
 * @returns the facts, or `undefined` when the text is not facts of a version this reader knows.
 */
export function readRunFacts(
  text: string,
  cell: string,
): RunFactsRead | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = factsSchema.safeParse(json);
  if (!parsed.success) return undefined;
  const facts = parsed.data;
  const record = facts.cells.find((entry) => entry.cell === cell);
  const plugin = record?.plugins.find((entry) => entry.role === "plugin");
  return {
    ...defined({ edition: facts.edition, suiteVersion: facts.suiteVersion }),
    ...(plugin === undefined
      ? {}
      : {
          plugin: defined({
            name: plugin.name,
            version: plugin.version,
            ref: plugin.ref,
            commit: plugin.commit,
          }),
        }),
    sites: (record?.sites ?? []).map((site) => ({
      baseURL: site.baseURL,
      ...defined({
        wordpress: site.versions?.wordpress,
        php: site.versions?.php,
      }),
    })),
    setupFailures: facts.setupFailures,
  };
}

/**
 * `fields` without its `undefined` values, so an absent fact stays absent under
 * `exactOptionalPropertyTypes`-style reading and in JSON.
 *
 * @param fields - optional strings.
 * @returns the ones that are set.
 */
function defined<K extends string>(
  fields: Readonly<Record<K, string | undefined>>,
): Partial<Record<K, string>> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<Record<K, string>>;
}
