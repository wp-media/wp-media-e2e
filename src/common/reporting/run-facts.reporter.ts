import { join } from "node:path";

import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
} from "@playwright/test/reporter";

import { setupKindOf } from "../config/project-names";
import { errorMessage } from "../guards";
import {
  ARTIFACTS_ATTACHMENT,
  SITE_INFO_ATTACHMENT,
} from "../setup/attachments";
import { spliceIntoTail, writeFileAtomic } from "./report-files";
import { RunTally, firstError, type TestStatus } from "./results";
import {
  readRunDescription,
  reporterMode,
  type RunDescription,
} from "./run-description";
import {
  ALLURE_ENVIRONMENT_FILE,
  ALLURE_RESULTS_DIR,
  CUCUMBER_REPORT_FILE,
  RUN_FACTS_FILE,
  bannerHtml,
  bannerSplice,
  beginFacts,
  endFacts,
  factEntries,
  metadataOf,
  runFactsJson,
  titleLine,
  toProperties,
  withSetupAttachment,
  withSetupEnded,
  type RunFacts,
} from "./run-facts";
import { readJsonAttachment } from "./setup-facts";
import { printLine } from "./terminal-sink";

/**
 * Says what a run tested, up front in every report (`run-facts.ts` holds the facts and their
 * formats). Listed before the reports in `reporters()`, because what it sets in its `onEnd` — the
 * HTML report's title and metadata — is read in theirs.
 *
 * - `onBegin`: what is known — product, cell, run — into `config.metadata`, `run-facts.json` and
 *   Allure's `environment.properties`;
 * - `onTestEnd`, for a setup: folds in what it attached, and its end, and rewrites both files — so a
 *   run killed later still leaves them, saying it was running;
 * - `onEnd`: the verdict into the files and the metadata, and the title line into
 *   `PLAYWRIGHT_HTML_TITLE` (unless the environment set one);
 * - `onExit`: the banner, into the Cucumber report its own `onEnd` finished writing.
 *
 * Never fails a run: everything is caught, and the first failure warns once, through the run's
 * terminal sink or else on stderr (a reporter
 * that throws turns a green run red). Silent on the terminal otherwise, and inert for `--list`.
 */
export default class RunFactsReporter implements Reporter {
  /** What the config factory said about the run, or the field it forgot. */
  private readonly run: RunDescription | { readonly missing: string };
  /** The reporters' mode: nothing is written for `--list`. */
  private readonly mode: "test" | "list";
  /** The run's tally: which attempt is a setup's last, and the scenarios' counts for the verdict. */
  private readonly tally = new RunTally();
  /** The facts so far; `undefined` until the run begins, and for a run this reporter sits out. */
  private facts: RunFacts | undefined;
  /** The run's config, whose metadata the HTML report shows. */
  private config: FullConfig | undefined;
  /** The metadata keys this reporter set last, so a fact that went away leaves no stale key. */
  private metadataKeys: readonly string[] = [];
  /** Whether a failure was reported already. */
  private warned = false;

  /** @param options - a {@link RunDescription}, plus what Playwright adds. */
  constructor(options: unknown) {
    this.run = readRunDescription(options);
    this.mode = reporterMode(options);
  }

  /**
   * Starts the facts from the run's plan, and publishes them.
   *
   * @param config - the run's resolved config.
   * @param suite - every test the run plans.
   */
  onBegin(config: FullConfig, suite: Suite): void {
    this.guard(() => {
      if ("missing" in this.run) {
        this.warn(`the reporter's options lack "${this.run.missing}"`);
        return;
      }
      if (this.mode === "list") return;
      const tests = suite.allTests();
      this.tally.begin(tests);
      this.config = config;
      this.facts = beginFacts(
        this.run,
        tests.map((test) => test.parent.project()?.name ?? ""),
        new Date(),
      );
      this.publish();
    });
  }

  /**
   * Counts the attempt and, for a setup, folds in what it attached and how it ended.
   *
   * @param test - the test.
   * @param result - the attempt.
   */
  onTestEnd(test: TestCase, result: TestResult): void {
    this.guard(() => {
      if (this.facts === undefined) return;
      const verdict = this.tally.attemptEnded(test, result);
      const project = test.parent.project()?.name ?? "";
      // A scenario changes no fact until the run ends: only the tally counts it.
      if (setupKindOf(project) === undefined) return;
      this.recordSetup(
        project,
        result,
        verdict.final ? verdict.status : undefined,
      );
      this.publish();
    });
  }

  /**
   * Keeps an error raised outside any test, for the verdict.
   *
   * @param error - the error.
   */
  onError(error: TestError): void {
    this.guard(() => {
      this.tally.runError(error);
    });
  }

  /**
   * Settles the setups whose retry never ran, records the verdict, publishes the final facts and
   * hands the HTML report its title. Returns nothing: a returned status would replace the run's.
   *
   * @param result - the run's status and duration.
   */
  onEnd(result: FullResult): void {
    this.guard(() => {
      if (this.facts === undefined) return;
      for (const settled of this.tally.settle()) {
        const project = settled.test.parent.project()?.name ?? "";
        this.recordSetup(project, settled.result, settled.status);
      }
      this.facts = endFacts(
        this.facts,
        {
          status: result.status,
          durationMs: result.duration,
          scenarios: this.tally.scenarios,
          runErrors: this.tally.runErrors,
        },
        new Date(),
      );
      this.publish();
      setHtmlTitle(titleLine(this.facts));
    });
  }

  /** Puts the banner on the Cucumber report, which is complete once every `onEnd` has run. */
  onExit(): Promise<void> {
    this.guard(() => {
      if (this.facts?.endedAt === undefined || "missing" in this.run) return;
      const banner = bannerHtml(this.facts);
      const path = join(this.run.reportPath, CUCUMBER_REPORT_FILE);
      if (!spliceIntoTail(path, (tail) => bannerSplice(tail, banner))) {
        this.warn(
          `${path} got no banner: it has no </body> (the report was cut short), or a banner already`,
        );
      }
    });
    return Promise.resolve();
  }

  /** Writes nothing to the terminal, so Playwright's own terminal reporter is never displaced. */
  printsToStdio(): boolean {
    return false;
  }

  /**
   * Folds a setup's attempt into the facts: its attachment always, its end when it is the last.
   * Nothing for a scenario's.
   *
   * @param project - the test's project.
   * @param result - the attempt.
   * @param status - the setup's final status; `undefined` when a retry is due.
   */
  private recordSetup(
    project: string,
    result: TestResult,
    status: TestStatus | undefined,
  ): void {
    const kind = setupKindOf(project);
    if (this.facts === undefined || kind === undefined) return;
    const name =
      kind === "artifacts" ? ARTIFACTS_ATTACHMENT : SITE_INFO_ATTACHMENT;
    let facts = withSetupAttachment(
      this.facts,
      project,
      readJsonAttachment(result, name),
    );
    if (status !== undefined) {
      facts = withSetupEnded(
        facts,
        project,
        status,
        firstError(result)?.message,
      );
    }
    this.facts = facts;
  }

  /**
   * Publishes the facts everywhere they are read: `config.metadata`, `run-facts.json` and Allure's
   * `environment.properties`. Each is tried on its own, so one that fails does not stop the others.
   */
  private publish(): void {
    if (this.facts === undefined || "missing" in this.run) return;
    const entries = factEntries(this.facts);
    const facts = this.facts;
    const folder = this.run.reportPath;
    this.guard(() => {
      this.setMetadata(metadataOf(entries));
    });
    this.guard(() => {
      writeFileAtomic(join(folder, RUN_FACTS_FILE), runFactsJson(facts));
    });
    this.guard(() => {
      writeFileAtomic(
        join(folder, ALLURE_RESULTS_DIR, ALLURE_ENVIRONMENT_FILE),
        toProperties(entries),
      );
    });
  }

  /**
   * Replaces this reporter's keys in the run's metadata, leaving everyone else's alone.
   *
   * @param metadata - the facts as flat keys.
   */
  private setMetadata(metadata: Record<string, string>): void {
    if (this.config === undefined) return;
    const target = this.config.metadata as Record<string, unknown>;
    for (const key of this.metadataKeys) Reflect.deleteProperty(target, key);
    Object.assign(target, metadata);
    this.metadataKeys = Object.keys(metadata);
  }

  /**
   * Runs a step, or one piece of side work, turning any throw into the one warning — so the next
   * piece still runs, and the run is never failed.
   *
   * @param work - the work.
   */
  private guard(work: () => void): void {
    try {
      work();
    } catch (error) {
      this.warn(errorMessage(error));
    }
  }

  /**
   * Warns once — through the run's terminal sink, else on stderr: the reports go on without the
   * facts that could not be written.
   *
   * @param reason - what went wrong.
   */
  private warn(reason: string): void {
    if (this.warned) return;
    this.warned = true;
    try {
      printLine(
        `[run-facts] ${reason}. The reports may not say what the run tested.`,
        "stderr",
      );
    } catch {
      // Nothing is left to tell.
    }
  }
}

/** The title this process last gave the HTML report, told apart from one the environment set. */
let ownTitle: string | undefined;

/**
 * Hands the HTML report its title through `PLAYWRIGHT_HTML_TITLE`, which it reads in its own `onEnd`
 * — unless the environment set one, which is the operator's to keep.
 *
 * @param title - the run's {@link titleLine}.
 */
export function setHtmlTitle(title: string): void {
  const current = process.env.PLAYWRIGHT_HTML_TITLE;
  if (current !== undefined && current !== "" && current !== ownTitle) return;
  process.env.PLAYWRIGHT_HTML_TITLE = title;
  ownTitle = title;
}
