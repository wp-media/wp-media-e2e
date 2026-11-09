import { test, expect } from "@playwright/test";

import {
  allureEntry,
  bundleNameProblem,
  bundleOutputs,
  copiedReportEntry,
  isCopied,
  type ReportFolder,
} from "./bundle-manifest";

/** A finished report folder with the given subfolders. */
function finished(folders: string[] = []): ReportFolder {
  return { kind: "folder", indexBytes: 100, folders };
}

test.describe("bundleNameProblem", () => {
  test("accepts a run's name, and spaces, quotes and markup", () => {
    for (const name of [
      "backwpup-pro@nginx-2026-10-06T02-47-17-617Z-36442",
      `run "a" & 'b' <c>`,
      "é".repeat(127),
    ]) {
      expect(bundleNameProblem(name), name).toBeUndefined();
    }
  });

  test("refuses what is not one folder name tar reads as a name", () => {
    expect(bundleNameProblem("")).toBe("is empty");
    expect(bundleNameProblem(".")).toBe('is "."');
    expect(bundleNameProblem("..")).toBe('is ".."');
    expect(bundleNameProblem("a/b")).toBe("holds a path separator");
    expect(bundleNameProblem("a\\b")).toBe("holds a path separator");
    for (const control of ["\n", "\u0000", "\u001b", "\u007f", "\u009b"]) {
      expect(bundleNameProblem(`a${control}b`)).toBe(
        "holds a control character",
      );
    }
    expect(bundleNameProblem("-rf")).toBe(
      'starts with "-", which tar would read as an option',
    );
    expect(bundleNameProblem(".bundle-work-1-0123abcd")).toBe(
      'starts with ".": a hidden folder',
    );
    // 128 two-byte characters: 256 bytes.
    expect(bundleNameProblem("é".repeat(128))).toBe("is longer than 255 bytes");
    // bsdtar's `@archive` include; GNU tar's and scp's `host:path`, and bsdtar's `c:` drive letter.
    expect(bundleNameProblem("@run")).toBe(
      'starts with "@", which bsdtar would read as an archive to include',
    );
    for (const name of ["host:run", "c:run", "run:"]) {
      expect(bundleNameProblem(name), name).toBe(
        'holds ":", which tar and scp would read as a remote host',
      );
    }
  });
});

test("bundleOutputs: archive, folder, both, none", () => {
  expect(bundleOutputs("archive")).toEqual({ archive: true, folder: false });
  expect(bundleOutputs("folder")).toEqual({ archive: false, folder: true });
  expect(bundleOutputs("both")).toEqual({ archive: true, folder: true });
  expect(bundleOutputs("none")).toEqual({ archive: false, folder: false });
});

test.describe("copiedReportEntry", () => {
  test("a finished report is linked; one file needs no server", () => {
    expect(copiedReportEntry("playwright", finished())).toEqual({
      kind: "playwright",
      present: true,
      href: "playwright/index.html",
      pages: [],
    });
    // Attachments alone open from disk; only the trace viewer needs HTTP.
    expect(
      copiedReportEntry("playwright", finished(["data"])),
    ).not.toHaveProperty("serve");
    expect(copiedReportEntry("cucumber", finished())).not.toHaveProperty(
      "serve",
    );
  });

  test("Playwright with traces, and rich Cucumber, say how to serve them", () => {
    expect(
      copiedReportEntry("playwright", finished(["data", "trace"])),
    ).toMatchObject({
      serve: {
        why: expect.stringContaining("trace viewer"),
        command: "npx playwright show-report playwright",
      },
    });
    for (const folders of [["data"], ["trace"], ["data", "trace"]]) {
      expect(copiedReportEntry("cucumber", finished(folders))).toMatchObject({
        serve: {
          why: expect.stringContaining("rich mode"),
          command: "npx playwright show-report cucumber",
        },
      });
    }
  });

  test("anything else is missing, and says why", () => {
    const cases: [ReportFolder, string][] = [
      [{ kind: "missing", folders: [] }, "the run did not write it"],
      [
        { kind: "link", folders: [] },
        "it is a link, which is never followed: not copied",
      ],
      [{ kind: "file", folders: [] }, "it is not a folder: not copied"],
      [{ kind: "other", folders: [] }, "it is not a folder: not copied"],
      [{ kind: "unreadable", folders: [] }, "it could not be read"],
      [
        { kind: "folder", folders: ["data"] },
        "it has no index.html: the report was not finished (a killed or interrupted run)",
      ],
      [
        { kind: "folder", indexBytes: 0, folders: [] },
        "its index.html is empty: the report was not finished (a killed or interrupted run)",
      ],
    ];
    for (const [folder, reason] of cases) {
      expect(isCopied(folder)).toBe(false);
      expect(copiedReportEntry("cucumber", folder)).toEqual({
        kind: "cucumber",
        present: false,
        reason,
      });
    }
  });
});

test.describe("allureEntry", () => {
  test("links the front page, then each plugin's", () => {
    expect(
      allureEntry({
        ok: true,
        layout: "single-file",
        pages: ["awesome/index.html", "dashboard/index.html", "index.html"],
      }),
    ).toEqual({
      kind: "allure",
      present: true,
      href: "allure/index.html",
      pages: [
        {
          label: "Awesome (the full report)",
          href: "allure/awesome/index.html",
        },
        { label: "Dashboard (trends)", href: "allure/dashboard/index.html" },
      ],
    });
  });

  test("without a front page, the first plugin's is it; other pages are not linked", () => {
    expect(
      allureEntry({
        ok: true,
        layout: "single-file",
        pages: ["awesome/index.html", "widgets/index.html"],
      }),
    ).toEqual({
      kind: "allure",
      present: true,
      href: "allure/awesome/index.html",
      pages: [
        {
          label: "Awesome (the full report)",
          href: "allure/awesome/index.html",
        },
      ],
    });
  });

  test("a folder report says how to serve it", () => {
    expect(
      allureEntry({ ok: true, layout: "folder", pages: ["index.html"] }),
    ).toMatchObject({
      serve: {
        why: expect.stringContaining("served over HTTP"),
        command: "npx allure open allure",
      },
    });
  });

  test("no page, or a failure, is missing with the reason", () => {
    expect(allureEntry({ ok: true, layout: "folder", pages: [] })).toEqual({
      kind: "allure",
      present: false,
      reason: "Allure wrote no page",
    });
    expect(allureEntry({ ok: false, reason: "boom" })).toEqual({
      kind: "allure",
      present: false,
      reason: "boom",
    });
  });
});
