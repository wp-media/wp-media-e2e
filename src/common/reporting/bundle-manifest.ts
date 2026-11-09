import type { AllureLayout } from "./allure-report";

/**
 * What a run's report bundle holds, decided from what the run folder holds — pure, so every case
 * (a report missing, half-written, a link, served-only) is a plain unit test. The bundle holds only
 * what a person opens: the Playwright and Cucumber reports, a freshly generated Allure report and
 * `run-facts.json`; never the raw results (`allure-results/`, `results.jsonl`) or logs.
 */

/** Where the bundle goes: an archive, a folder, both, or nowhere (nothing is built). */
export type BundleMode = "archive" | "folder" | "both" | "none";

/** Every mode, in the order a person reads them. */
export const BUNDLE_MODES: readonly BundleMode[] = [
  "archive",
  "folder",
  "both",
  "none",
];

/** The reports a bundle can link. */
export type ReportKind = "playwright" | "cucumber" | "allure";

/** The reports the suite writes in the run folder, copied whole when finished. */
export const COPIED_REPORTS = ["playwright", "cucumber"] as const;

/** One of {@link COPIED_REPORTS}. */
export type CopiedReport = (typeof COPIED_REPORTS)[number];

/** The facts file, copied as it is. */
export const FACTS_FILE = "run-facts.json";

/** What a run folder's entry is; a link is a link, never what it leads to. */
export type EntryKind =
  "folder" | "file" | "link" | "other" | "missing" | "unreadable";

/** A report folder of the run, as found. */
export interface ReportFolder {
  readonly kind: EntryKind;
  /** Its `index.html`'s size, when that is a regular file. */
  readonly indexBytes?: number;
  /** The real folders directly inside it (`data`, `trace`), sorted. */
  readonly folders: readonly string[];
}

/** Why a report must be served over HTTP to work, and the one command that serves it. */
export interface ServeNote {
  readonly why: string;
  /** Run from the bundle's folder. */
  readonly command: string;
}

/** A link to a page of a report, relative to the bundle's root. */
export interface ReportLink {
  readonly label: string;
  readonly href: string;
}

/** One report, as the landing page shows it: linked, or said to be missing and why. */
export type BundledReport =
  | {
      readonly kind: ReportKind;
      readonly present: true;
      /** Its front page, relative to the bundle's root. */
      readonly href: string;
      /** Its other pages worth a link (Allure's plugins). */
      readonly pages: readonly ReportLink[];
      readonly serve?: ServeNote;
    }
  | {
      readonly kind: ReportKind;
      readonly present: false;
      readonly reason: string;
    };

/** How the Allure step ended: a report (its layout and pages), or why there is none. */
export type AllureOutcome =
  | {
      readonly ok: true;
      readonly layout: AllureLayout;
      /** Its HTML pages, relative to the report: `index.html`, `awesome/index.html`, … */
      readonly pages: readonly string[];
    }
  | { readonly ok: false; readonly reason: string };

/** The command that serves a Playwright report folder; it serves any static folder. */
const PLAYWRIGHT_SERVE = "npx playwright show-report";

/** Each Allure plugin's page, as the landing page names it. */
const ALLURE_PLUGINS: Readonly<Record<string, string>> = {
  "awesome/index.html": "Awesome (the full report)",
  "dashboard/index.html": "Dashboard (trends)",
};

/**
 * Why a bundle name cannot be used: it must be one folder name that `tar` reads as a name.
 *
 * @param name - the bundle's name (`<product>-<cell>-<RUN_ID>`).
 * @returns the problem, as the end of "The bundle name … "; `undefined` when it is fine.
 * @example
 * ```ts
 * bundleNameProblem("backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442"); // undefined
 * bundleNameProblem("-rf"); // "starts with \"-\", which tar would read as an option"
 * ```
 */
export function bundleNameProblem(name: string): string | undefined {
  if (name === "") return "is empty";
  if (name === "." || name === "..") return `is "${name}"`;
  if (/[/\\]/.test(name)) return "holds a path separator";
  // C0, DEL and C1 controls: a name a terminal or a Slack message would mangle.
  // eslint-disable-next-line no-control-regex -- matching control characters is the point.
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) {
    return "holds a control character";
  }
  if (name.startsWith("-")) {
    return 'starts with "-", which tar would read as an option';
  }
  if (name.startsWith(".")) return 'starts with ".": a hidden folder';
  // bsdtar reads `@name` as an archive to include; GNU tar reads `host:path` as a remote archive,
  // and scp a remote host; bsdtar strips a leading `c:` as a drive letter.
  if (name.startsWith("@")) {
    return 'starts with "@", which bsdtar would read as an archive to include';
  }
  if (name.includes(":")) {
    return 'holds ":", which tar and scp would read as a remote host';
  }
  if (Buffer.byteLength(name) > 255) return "is longer than 255 bytes";
  return undefined;
}

/**
 * Which outputs a mode builds.
 *
 * @param mode - the mode.
 */
export function bundleOutputs(mode: BundleMode): {
  readonly archive: boolean;
  readonly folder: boolean;
} {
  return {
    archive: mode === "archive" || mode === "both",
    folder: mode === "folder" || mode === "both",
  };
}

/**
 * Whether a report folder is copied: a real folder with a non-empty `index.html`. Anything else is
 * not viewable (a killed run leaves no Playwright index and an empty Cucumber one) or not the run's
 * own (a link).
 *
 * @param folder - the folder, as found.
 */
export function isCopied(folder: ReportFolder): boolean {
  return folder.kind === "folder" && (folder.indexBytes ?? 0) > 0;
}

/**
 * Why a report folder is not copied.
 *
 * @param folder - the folder, as found; one {@link isCopied} refuses.
 */
function missingReason(folder: ReportFolder): string {
  switch (folder.kind) {
    case "missing":
      return "the run did not write it";
    case "link":
      return "it is a link, which is never followed: not copied";
    case "file":
    case "other":
      return "it is not a folder: not copied";
    case "unreadable":
      return "it could not be read";
    case "folder":
      return folder.indexBytes === undefined
        ? "it has no index.html: the report was not finished (a killed or interrupted run)"
        : "its index.html is empty: the report was not finished (a killed or interrupted run)";
  }
}

/**
 * The landing page's entry for a report the suite writes: linked when copied, with the command that
 * serves it when part of it works only over HTTP — the Playwright trace viewer (a service worker,
 * which a `file://` page cannot register), and rich Cucumber's external attachments and trace viewer.
 *
 * @param kind - which report.
 * @param folder - its folder, as found in the run.
 */
export function copiedReportEntry(
  kind: CopiedReport,
  folder: ReportFolder,
): BundledReport {
  if (!isCopied(folder)) {
    return { kind, present: false, reason: missingReason(folder) };
  }
  const serve = serveNoteFor(kind, folder.folders);
  return {
    kind,
    present: true,
    href: `${kind}/index.html`,
    pages: [],
    ...(serve === undefined ? {} : { serve }),
  };
}

/**
 * The serve note a copied report needs, if any.
 *
 * @param kind - which report.
 * @param folders - the real folders inside it.
 */
function serveNoteFor(
  kind: CopiedReport,
  folders: readonly string[],
): ServeNote | undefined {
  if (kind === "playwright") {
    return folders.includes("trace")
      ? {
          why: "Its trace viewer works only when the report is served over HTTP, not opened as a file.",
          command: `${PLAYWRIGHT_SERVE} playwright`,
        }
      : undefined;
  }
  // Cucumber is one file unless REPORT_MODE=rich, which adds folders beside it.
  return folders.length > 0
    ? {
        why: "Written in rich mode: its attachments and trace viewer work only when served over HTTP.",
        command: `${PLAYWRIGHT_SERVE} cucumber`,
      }
    : undefined;
}

/**
 * The landing page's entry for the Allure report: linked (its front page, then each plugin's), with
 * the command that serves a folder report — browsers block its data from a `file://` page — or why
 * there is none.
 *
 * @param outcome - how the Allure step ended.
 */
export function allureEntry(outcome: AllureOutcome): BundledReport {
  if (!outcome.ok) {
    return { kind: "allure", present: false, reason: outcome.reason };
  }
  const plugins = outcome.pages.filter((page) => page in ALLURE_PLUGINS);
  const front = outcome.pages.includes("index.html")
    ? "index.html"
    : plugins[0];
  if (front === undefined) {
    return {
      kind: "allure",
      present: false,
      reason: "Allure wrote no page",
    };
  }
  return {
    kind: "allure",
    present: true,
    href: `allure/${front}`,
    pages: plugins.map((page) => ({
      label: ALLURE_PLUGINS[page] ?? page,
      href: `allure/${page}`,
    })),
    ...(outcome.layout === "folder"
      ? {
          serve: {
            why: "Kept with its Playwright traces, it is a folder report: it opens only when served over HTTP.",
            command: "npx allure open allure",
          },
        }
      : {}),
  };
}
