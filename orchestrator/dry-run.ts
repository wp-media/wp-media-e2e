import { buildArtifactPlan } from "../src/common/artifacts/request";
import { serverOf, tasksByServer, type CheckedTask } from "./config/check";
import type { OrchestratorConfig } from "./config/schema";
import { allSecretValues } from "./config/secrets";
import { bundleSettings } from "./runs/bundle";
import type { PreparedStart } from "./start";
import { tasksText } from "./start-lines";
import { showPath } from "./tasks/run-lines";
import { failureLine, safeLine, safeSiteUrl, shellWord } from "./text";

/**
 * `start --dry-run`'s report, pure: what a start with this config and `--task` would run — each task,
 * its product, cell, the plugin it builds, its filter and cooldown, its sites and their servers — then
 * the runs' settings, the notifications and secrets configured (by name), and the warnings, the state
 * directory's among them (`state/inspect.ts`, read beforehand). It never prints a field that holds a
 * secret — no site password, no storage credential, no webhook URL, no API key, no secret's value —
 * and masks every value it does print by every secret the orchestrator holds (`allSecretValues`), as
 * written, before anything normalises it.
 */

/** The longest line printed, in code points: a long path or warning is cut, never wrapped. */
const MAX_LINE = 2_000;

/** One site of a checked cell. */
type Site = CheckedTask["cell"]["sites"][number];

/** What the report reads: what `prepareStart` returns. */
export type DryRunInput = Pick<PreparedStart, "list" | "loaded" | "selected">;

/** What the report is told besides the start's preparation. */
export interface DryRunOptions {
  /** The folder paths are shown from (the checkout); absolute paths when absent. */
  readonly checkout?: string;
  /** What would stop a start on the state directory (`inspectState`), shown first among the warnings. */
  readonly stateWarnings?: readonly string[];
}

/**
 * Every line of the dry run's report, safe to print as they are, one per line.
 *
 * @param prepared - what `prepareStart` returns: the product list, the config loaded and checked, the
 *   tasks selected.
 * @param options - the checkout paths are shown from, and the state directory's warnings.
 * @returns the lines, masked and each one line.
 *
 * @example
 * ```ts
 * const prepared = await prepareStart(options);
 * const stateWarnings = await inspectState(prepared.loaded.stateDir);
 * const lines = dryRunReport(prepared, { checkout: CHECKOUT, stateWarnings });
 * process.stdout.write(`${lines.join("\n")}\n`);
 * ```
 */
export function dryRunReport(
  prepared: DryRunInput,
  options: DryRunOptions = {},
): string[] {
  const { list, loaded, selected } = prepared;
  const { config } = loaded;
  const { checkout } = options;
  const secrets = allSecretValues(config, loaded.tasks);
  /** A path as shown: from the checkout when it is known. */
  const show = (path: string): string =>
    checkout === undefined ? path : showPath(path, checkout);
  const warnings = [
    ...(options.stateWarnings ?? []),
    ...loaded.warnings,
    ...checkoutWarnings(checkout, config.reports?.sshHost),
  ];
  const lines = [
    `dry run · nothing is run · config ${show(loaded.file)} · state ${show(loaded.stateDir)}/`,
    tasksText(selected.map(({ task }) => task.id)),
    ...selected.flatMap((checked) =>
      taskLines(
        checked,
        list.productByName(checked.task.product).artifacts,
        secrets,
      ),
    ),
    serversLine(selected),
    runsLine(config),
    reportsLine(config),
    notificationsLine(config),
    secretsLine(config),
    ...(warnings.length === 0
      ? ["no warnings"]
      : warnings.map((warning) => `warning: ${warning}`)),
  ];
  return lines.map((line) => safeIndented(line, secrets));
}

/**
 * A line made safe ({@link safeLine}, within {@link MAX_LINE}) with its leading indentation kept,
 * which `safeLine` would trim.
 *
 * @param line - the line, its indentation of our own.
 * @param secrets - the values to mask.
 * @returns the line.
 */
function safeIndented(line: string, secrets: readonly string[]): string {
  const body = line.trimStart();
  const indent = line.slice(0, line.length - body.length);
  return indent + safeLine(body, MAX_LINE - indent.length, secrets);
}

/**
 * One task's lines: `bpng · BackWPup Pro on nginx`, then what it runs —
 * `backwpup pro@nginx · develop (default) · version 9.99.99 (default) · every scenario · cooldown 5m`
 * — then each site and its server, as written.
 *
 * @param checked - the task, joined to its cell.
 * @param artifacts - its product's artifact manifest.
 * @param secrets - the values a site's address is masked by before it is parsed.
 * @returns its lines.
 */
function taskLines(
  checked: CheckedTask,
  artifacts: PluginSource["artifacts"],
  secrets: readonly string[],
): string[] {
  const { task, cell } = checked;
  return [
    task.name === undefined ? task.id : `${task.id} · ${task.name}`,
    "  " +
      [
        `${task.product} ${task.cell}`,
        pluginText({ artifacts, edition: cell.edition, plugin: task.plugin }),
        task.grep === undefined ? "every scenario" : `grep ${task.grep}`,
        `cooldown ${String(task.cooldownMinutes)}m`,
      ].join(" · "),
    ...cell.sites.map(
      (site) =>
        `  site ${safeSiteUrl(site.baseURL, MAX_LINE, secrets)} · ${hostAsWritten(site)}`,
    ),
  ];
}

/** What decides the plugin a task's runs build. */
export interface PluginSource {
  /** The product's artifact manifest: its default ref and version policy. */
  readonly artifacts: Parameters<typeof buildArtifactPlan>[0]["product"];
  /** The cell's edition. */
  readonly edition: CheckedTask["cell"]["edition"];
  /** The task's `plugin`. */
  readonly plugin: CheckedTask["task"]["plugin"];
}

/**
 * The plugin a task's runs build, by the suite's own planner (`buildArtifactPlan`, given what the run
 * is given: `E2E_PLUGIN_REF` and `E2E_PLUGIN_VERSION` from the task): `develop (default) · version
 * 9.99.99 (default)`; a release's version `from the release`, a task's own there `ignored`; a product
 * whose source names its version `from the source`.
 *
 * @param source - the manifest, the edition and the task's `plugin`.
 * @returns the text.
 */
export function pluginText(source: PluginSource): string {
  const planned = plannedBuild(source);
  if ("problem" in planned) return planned.problem;
  return `${planned.ref} · ${versionText(planned.gitRef, planned.version, source.plugin?.version)}`;
}

/**
 * The ref a task's runs build, as {@link pluginText} shows it — `develop (default)`, `main` — for the
 * line each run starts with, so the dry run and the runs name it alike.
 *
 * @param source - the manifest, the edition and the task's `plugin`.
 * @returns the ref; `undefined` when the planner refuses the task's plugin.
 */
export function builtRef(source: PluginSource): string | undefined {
  const planned = plannedBuild(source);
  return "problem" in planned ? undefined : planned.ref;
}

/** The build the planner makes of a task's plugin, or why it makes none. */
type PlannedBuild =
  | {
      /** The ref as shown: `(default)` when the product's manifest chose it. */
      readonly ref: string;
      /** The ref as the planner names it: `develop`, `release:latest-stable`. */
      readonly gitRef: string;
      /** The version the build is given; none when its source or release names it. */
      readonly version: string | undefined;
    }
  | { readonly problem: string };

/**
 * Plans a task's plugin as a run would: by the suite's own planner, from what the run is given.
 *
 * @param source - the manifest, the edition and the task's `plugin`.
 * @returns the build, or the problem as the dry run says it; never throws.
 */
function plannedBuild(source: PluginSource): PlannedBuild {
  const { ref, version } = source.plugin ?? {};
  let request;
  try {
    request = buildArtifactPlan({
      product: source.artifacts,
      edition: source.edition,
      serial: false,
      env: { pluginRef: ref, pluginVersion: version },
    }).requests.find(({ role }) => role === "plugin");
  } catch (error) {
    return {
      problem: `plugin cannot be planned: ${failureLine(error, MAX_LINE)}`,
    };
  }
  // Without a zip, the planner always builds the plugin.
  if (request?.kind !== "build") return { problem: "plugin cannot be planned" };
  const { gitRef, version: built } = request.params;
  return {
    ref: `${gitRef}${request.source === "default-ref" ? " (default)" : ""}`,
    gitRef,
    version: built,
  };
}

/**
 * The version a build gets, and where it comes from.
 *
 * @param gitRef - the ref built.
 * @param built - the version the planner sends, if any.
 * @param asked - the task's own version, if any.
 * @returns the text.
 */
function versionText(
  gitRef: string,
  built: string | undefined,
  asked: string | undefined,
): string {
  if (built !== undefined)
    return `version ${built}${asked === undefined ? " (default)" : ""}`;
  if (gitRef.startsWith("release:"))
    return asked === undefined
      ? "version from the release"
      : `version ${asked} ignored: from the release`;
  return "version from the source";
}

/**
 * A site's server as its file writes it: an SSH host as written — {@link serverOf} lowercases it, for
 * counting only.
 *
 * @param site - the site.
 * @returns the host, or `this machine`.
 */
function hostAsWritten(site: Site): string {
  return site.transport.mode === "ssh" ? site.transport.host : serverOf(site);
}

/**
 * The servers the selected tasks reach, each with its tasks, each as first written:
 * `servers: qa-lnmp (bpng, bfng)`.
 *
 * @param selected - the selected tasks.
 * @returns the line.
 */
function serversLine(selected: readonly CheckedTask[]): string {
  const sites = selected.flatMap(({ cell }) => cell.sites);
  const servers = [...tasksByServer(selected)].map(([server, tasks]) => {
    const written = sites.find((site) => serverOf(site) === server);
    const name = written === undefined ? server : hostAsWritten(written);
    return `${name} (${tasks.map(({ task }) => task.id).join(", ")})`;
  });
  return `servers: ${servers.join(", ")}`;
}

/**
 * The runs' settings: `runs: retries 2 · reports kept 20`, the suite's default for each not set.
 *
 * @param config - the config.
 * @returns the line.
 */
function runsLine(config: Pick<OrchestratorConfig, "runs">): string {
  const { retries, reportsKeep } = config.runs ?? {};
  return [
    `runs: retries ${retries === undefined ? "the suite's default" : String(retries)}`,
    `reports kept ${reportsKeep === undefined ? "the suite's default" : reportsKeep === 0 ? "without a cap" : String(reportsKeep)}`,
  ].join(" · ");
}

/**
 * A warning when Slack's `scp` commands name paths in a checkout whose path a pasted `scp` may not
 * survive: the commands quote it for the local shell, then `scp` hands it to SFTP's glob (a backslash is an
 * escape there) or, with `scp -O`, to the remote shell, which reads it again (a space, a quote, `$`, a
 * backtick). Only characters no shell treats specially are safe in both.
 *
 * @param checkout - the checkout; nothing to say when unknown.
 * @param sshHost - `reports.sshHost`; without it no `scp` command is given.
 * @returns the warning, or none.
 */
export function checkoutWarnings(
  checkout: string | undefined,
  sshHost: string | undefined,
): string[] {
  if (checkout === undefined || sshHost === undefined) return [];
  if (shellWord(checkout) === checkout) return [];
  return [
    `the checkout ${JSON.stringify(checkout)} has characters besides letters, digits and _@%+=:,./- — a pasted scp command may fail; move it to such a path`,
  ];
}

/**
 * Each run's download bundle: `reports: bundle archive (default) · Allure traces strip (default)` —
 * what `reports.bundle` chose, or the default in force.
 *
 * @param config - the config.
 * @returns the line.
 */
function reportsLine(config: Pick<OrchestratorConfig, "reports">): string {
  const chosen = config.reports?.bundle;
  const { mode, traces } = bundleSettings(config.reports);
  /** A setting, marked when it is the default's. */
  const said = (value: string, set: boolean): string =>
    set ? value : `${value} (default)`;
  return mode === "none"
    ? "reports: bundle none · no Allure report"
    : `reports: bundle ${said(mode, chosen?.mode !== undefined)} · Allure traces ${said(traces, chosen?.traces !== undefined)}`;
}

/**
 * The notifications configured, named only — never a URL or key: `notifications: slack ("AutoE2E
 * nginx", scp from auto-e2e) · datator`, or `none`. The instance and the scp host shape Slack's
 * messages, so they are said with it.
 *
 * @param config - the config.
 * @returns the line.
 */
function notificationsLine(
  config: Pick<OrchestratorConfig, "notifications" | "instance" | "reports">,
): string {
  const { slack, datator } = config.notifications ?? {};
  const slackDetails = [
    ...(config.instance === undefined ? [] : [JSON.stringify(config.instance)]),
    ...(config.reports?.sshHost === undefined
      ? []
      : [`scp from ${config.reports.sshHost}`]),
  ];
  const named = [
    ...(slack === undefined
      ? []
      : [
          slackDetails.length === 0
            ? "slack"
            : `slack (${slackDetails.join(", ")})`,
        ]),
    ...(datator === undefined ? [] : ["datator"]),
  ];
  return `notifications: ${named.length === 0 ? "none" : named.join(" · ")}`;
}

/**
 * The secrets the runs receive, by name: `secrets for the runs: GITHUB_TOKEN, BWP_S3_ACCESS_KEY_ID`.
 *
 * @param config - the config.
 * @returns the line.
 */
function secretsLine(config: Pick<OrchestratorConfig, "secrets">): string {
  const names = Object.keys(config.secrets ?? {});
  return `secrets for the runs: ${names.length === 0 ? "none" : names.join(", ")}`;
}
