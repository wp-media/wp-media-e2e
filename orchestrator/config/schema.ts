import { z } from "zod";

import { BUNDLE_MODES } from "../../src/common/reporting/report-bundle";
import { MAX_REPORTS_KEEP } from "../../src/common/reporting/retention";

/**
 * The orchestrator's config file, as data: every rule that needs nothing but the file itself. What
 * needs the suite — a product that exists, a cell with real sites — is checked by `check.ts`.
 *
 * Every object is strict, so a misspelt key is an error rather than a setting silently ignored. No
 * message quotes a value: the file holds credentials (see `ConfigError`).
 */

/**
 * A task id: 4 characters, lowercase letters and digits without the look-alikes `0 o 1 l i`,
 * starting with a letter — short enough to type and read aloud, and the shape later versions of the
 * orchestrator draw ids in, so a task keeps its id.
 */
export const TASK_ID_PATTERN = /^[a-hjkmnp-z][a-hjkmnp-z2-9]{3}$/;

/** How long a loop task waits after a run ends before the next, unless it says otherwise. */
export const DEFAULT_COOLDOWN_MINUTES = 5;

/** The shortest cooldown accepted: none at all would hammer a broken site. */
export const MIN_COOLDOWN_MINUTES = 1;

/** The longest cooldown accepted: a day. Waiting longer is a schedule, not a loop. */
export const MAX_COOLDOWN_MINUTES = 1440;

/**
 * How many tasks may reach one server before the start warns about it. Up to four suites at once
 * share a QA server well, so the warning starts at five.
 */
export const DEFAULT_SERVER_WARNING_THRESHOLD = 5;

/** The highest `serverWarningThreshold`: far above any server's load, so the warning never fires. */
export const MAX_SERVER_WARNING_THRESHOLD = 1000;

/** The suite's own bounds for `E2E_RETRIES` (`project.ts`), which `runs.retries` becomes. */
export const MAX_RETRIES = 10;

/** The secrets a run may receive: APVM's GitHub token, and BackWPup's storage settings by prefix. */
export const SECRET_NAME_PATTERN = /^(GITHUB_TOKEN|GH_TOKEN|BWP_[A-Z0-9_]+)$/;

/**
 * The longest secret accepted. It becomes an environment variable, and Linux refuses to start a
 * process with one string of `NAME=value` over 128 KiB (`MAX_ARG_STRLEN`): 32,768 UTF-16 units are
 * at most 96 KiB of UTF-8.
 */
export const MAX_SECRET_LENGTH = 32_768;

/**
 * What text shown on one line must not hold: a control character (C0, DEL, C1 — `NEL` among them),
 * an invisible format character (bidi overrides, zero-width spaces), a line or paragraph separator,
 * or half of a surrogate pair. Each can forge a line, hide text, or reorder what a reader sees.
 */
const UNSAFE_IN_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u;

/** What a secret must not hold: a control character, or half a surrogate pair — neither survives as an environment variable. */
const UNSAFE_IN_SECRET = /[\p{Cc}\p{Cs}]/u;

/** Printable ASCII without spaces: a GitHub token, an HTTP header's value. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;

/**
 * A host for `scp`, optionally `user@host`: a letter, digit or `_` first in each part, so neither
 * part can read as an option (`-oProxyCommand=…`), and one `@` at most.
 */
const SSH_HOST_PATTERN =
  /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*@)?[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/**
 * Text shown on one line — a name, an instance, a product, a cell: not blank, no surrounding
 * whitespace, nothing {@link UNSAFE_IN_TEXT}.
 *
 * @param max - the longest accepted, in UTF-16 units.
 * @returns the schema.
 */
function lineOfText(max: number): z.ZodString {
  return z
    .string()
    .min(1, { error: "must not be empty" })
    .max(max, { error: `must be at most ${String(max)} characters` })
    .refine((value) => value.trim() === value, {
      error: "must not start or end with whitespace",
      abort: true,
    })
    .refine((value) => !UNSAFE_IN_TEXT.test(value), {
      error:
        "must be plain text on one line: no control, invisible or line-separator characters",
    });
}

/**
 * A git ref or a version, handed to APVM: one token — no whitespace — that cannot read as an option.
 */
const token = lineOfText(200)
  .refine((value) => !/\s/u.test(value), {
    error: "must not contain whitespace",
  })
  .refine((value) => !value.startsWith("-"), {
    error: 'must not start with "-"',
  });

/**
 * A whole number from `min` to `max`, with one message for every way of missing it — `1e300` is a
 * whole number too, just not a safe one.
 *
 * @param min - the smallest accepted.
 * @param max - the largest accepted.
 * @param unit - what it counts, for the message (`" minutes"`).
 * @returns the schema.
 */
function wholeNumber(min: number, max: number, unit = ""): z.ZodNumber {
  const range = `must be a whole number from ${String(min)} to ${String(max)}${unit}`;
  return z
    .number({ error: range })
    .refine(Number.isInteger, { error: range, abort: true })
    .min(min, { error: range })
    .max(max, { error: range });
}

/**
 * Whether Playwright accepts `pattern` as `--grep`: it reads `/source/flags` (flags `g`, `i`) as a
 * regular expression, and anything else as the source of one, with `gi` — its `forceRegExp`.
 *
 * @param pattern - the task's `grep`.
 * @returns whether Playwright can build a regular expression from it.
 */
export function isValidGrep(pattern: string): boolean {
  const literal = /^\/(.*)\/([gi]*)$/.exec(pattern);
  try {
    new RegExp(literal?.[1] ?? pattern, literal?.[2] ?? "gi");
    return true;
  } catch {
    return false;
  }
}

/**
 * `value` as an `https:` URL, or `undefined` when it is not one this file accepts: written exactly as
 * `URL` reads it back — so no space, backslash, uppercase host, default port, empty `@`, `%2e` or
 * anything else a parser would rewrite — with no user name, password, port, query or fragment. A
 * credential in a URL is logged wherever the URL is, and neither endpoint takes one there.
 *
 * @param value - the URL as written.
 * @returns the parsed URL, or `undefined`.
 */
function strictHttpsUrl(value: string): URL | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  const plain =
    url.href === value &&
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.search === "" &&
    url.hash === "";
  return plain ? url : undefined;
}

/**
 * Whether `value` is a Slack incoming webhook: `https://hooks.slack.com/services/` and the hook's
 * own path after it.
 *
 * @param value - the URL as written.
 * @returns whether it is one.
 */
export function isSlackWebhook(value: string): boolean {
  const url = strictHttpsUrl(value);
  return (
    url?.hostname === "hooks.slack.com" &&
    /^\/services\/[^/]/.test(url.pathname)
  );
}

/** One `loop` task: what to run (product, cell, plugin) and how (cooldown, filter). */
const taskSchema = z.strictObject({
  id: z.string().regex(TASK_ID_PATTERN, {
    error:
      "must be 4 characters: a lowercase letter, then lowercase letters or digits, without 0, o, 1, l or i (e.g. k7qx)",
  }),
  name: lineOfText(100).optional(),
  // Explicit, so a later default type cannot change what an existing task means.
  type: z.literal("loop", { error: 'must be "loop", the only type for now' }),
  product: lineOfText(100),
  cell: lineOfText(100),
  plugin: z
    .strictObject({ ref: token.optional(), version: token.optional() })
    .optional(),
  cooldownMinutes: wholeNumber(
    MIN_COOLDOWN_MINUTES,
    MAX_COOLDOWN_MINUTES,
    " minutes",
  ).default(DEFAULT_COOLDOWN_MINUTES),
  grep: lineOfText(500)
    .refine(isValidGrep, {
      error: "must be a regular expression Playwright's --grep accepts",
    })
    .optional(),
});

/**
 * A secret's value: not empty, at most {@link MAX_SECRET_LENGTH}, nothing {@link UNSAFE_IN_SECRET}.
 * Surrounding spaces are kept: the suite reads a storage password as it is, and a space can be part
 * of it. A token's own rule is stricter (see {@link configSchema}'s `secrets`).
 */
const secretValue = z
  .string({ error: "must be a string" })
  .min(1, { error: "must not be empty" })
  .max(MAX_SECRET_LENGTH, {
    error: `must be at most ${String(MAX_SECRET_LENGTH)} characters`,
  })
  .refine((value) => !UNSAFE_IN_SECRET.test(value), {
    error: "must not contain control characters or broken Unicode",
  });

/** The secrets that are tokens: printable ASCII, no spaces — a pasted newline or space is a mistake. */
const TOKEN_SECRETS: ReadonlySet<string> = new Set([
  "GITHUB_TOKEN",
  "GH_TOKEN",
]);

/** Slack's incoming webhook: what the run reports post to. */
const slackSchema = z.strictObject({
  webhookUrl: z.string().refine(isSlackWebhook, {
    error:
      "must be a Slack incoming webhook as Slack gives it: https://hooks.slack.com/services/…, nothing added",
  }),
});

/** Datator's results endpoint and its key. */
const datatorSchema = z.strictObject({
  url: z
    .string()
    .refine((value) => strictHttpsUrl(value) !== undefined, {
      error:
        "must be a plain https:// URL, written as a browser would show it: no user, password, port, query or fragment",
      abort: true,
    })
    // Without it Datator answers 301, and following the redirect drops the POST's body.
    .refine((value) => strictHttpsUrl(value)?.pathname.endsWith("/"), {
      error:
        'must end with "/": without it Datator redirects, and the redirect drops the results',
    }),
  // Sent as the `X-API-Key` header, which takes nothing else.
  apiKey: secretValue.refine((value) => PRINTABLE_ASCII.test(value), {
    error: "must be printable ASCII without spaces, as an HTTP header is",
  }),
});

/** The orchestrator's config file. */
export const configSchema = z
  .strictObject({
    // Prefixes every Slack message, as AutoE2E's instance name did.
    instance: lineOfText(100).optional(),
    tasks: z.array(taskSchema).min(1, { error: "must list at least one task" }),
    runs: z
      .strictObject({
        retries: wholeNumber(0, MAX_RETRIES).optional(),
        // 0 lifts only the cap: the suite's age rules still prune.
        reportsKeep: wholeNumber(0, MAX_REPORTS_KEEP).optional(),
      })
      .optional(),
    secrets: z
      .record(
        z.string().regex(SECRET_NAME_PATTERN, {
          error:
            "is not a secret a run receives: only GITHUB_TOKEN, GH_TOKEN and BWP_*",
        }),
        secretValue,
      )
      .superRefine((secrets, ctx) => {
        for (const [name, value] of Object.entries(secrets))
          if (TOKEN_SECRETS.has(name) && !PRINTABLE_ASCII.test(value))
            ctx.addIssue({
              code: "custom",
              path: [name],
              message:
                "must be printable ASCII without spaces, as a GitHub token is — a pasted newline or space included",
            });
      })
      .optional(),
    notifications: z
      .strictObject({
        slack: slackSchema.optional(),
        datator: datatorSchema.optional(),
      })
      .optional(),
    reports: z
      .strictObject({
        // Turns a report's path in Slack into an `scp` command from this host.
        sshHost: z
          .string()
          .max(255, { error: "must be at most 255 characters" })
          .regex(SSH_HOST_PATTERN, {
            error:
              "must be a host name or alias for scp, optionally user@host, without spaces",
          })
          .optional(),
        // Each run's download bundle: `report.tar.gz`, `report/`, both or none; Allure's traces.
        bundle: z
          .strictObject({
            mode: z.enum(BUNDLE_MODES).optional(),
            traces: z.enum(["strip", "keep"]).optional(),
          })
          .optional(),
      })
      .optional(),
    serverWarningThreshold: wholeNumber(
      1,
      MAX_SERVER_WARNING_THRESHOLD,
    ).default(DEFAULT_SERVER_WARNING_THRESHOLD),
  })
  // Zod skips this while a field has an aborting issue — a wrong type, a refused key, an aborting
  // check — and runs it otherwise, so a repeat may be reported only once those are fixed.
  .superRefine((config, ctx) => {
    // One task per id, and one per product × cell: a cell never runs twice at once.
    const firstById = new Map<string, number>();
    const firstByUnit = new Map<string, number>();
    config.tasks.forEach((task, index) => {
      const sameId = firstById.get(task.id);
      if (sameId === undefined) firstById.set(task.id, index);
      else
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: `repeats tasks[${String(sameId)}].id: ids are unique`,
        });
      const unit = `${task.product}\u0000${task.cell}`;
      const sameUnit = firstByUnit.get(unit);
      if (sameUnit === undefined) firstByUnit.set(unit, index);
      else
        ctx.addIssue({
          code: "custom",
          path: ["tasks", index, "cell"],
          message: `repeats tasks[${String(sameUnit)}]'s product and cell: a cell has one task, so it never runs twice at once`,
        });
    });
  });

/** A config as the file says it, defaults applied. */
export type OrchestratorConfig = z.output<typeof configSchema>;

/** One task of an {@link OrchestratorConfig}. */
export type TaskConfig = OrchestratorConfig["tasks"][number];
