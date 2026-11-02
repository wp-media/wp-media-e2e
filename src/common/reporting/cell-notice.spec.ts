import { test, expect } from "@playwright/test";
import type { FullConfig } from "@playwright/test/reporter";

import CellNoticeReporter, { actualWorkers, cellNotice } from "./cell-notice";
import type { CellNoticeOptions } from "./cell-notice";
import { registerTerminalSink } from "./terminal-sink";

/**
 * The one line a run prints before the terminal reporter's `[run]` header: the cell, how it was chosen — which decides whether
 * another cell of the product may run beside it — the workers, and where the report goes.
 */

const REPORT = "reports/backwpup/pro@nginx/2026-10-06T00-00-00-000Z-1";

const PINNED: CellNoticeOptions = {
  product: "backwpup",
  cell: "pro@nginx",
  pinned: true,
  reportDir: REPORT,
};

test.describe("cellNotice", () => {
  test("a pinned run: only its specs are generated", () => {
    expect(cellNotice(PINNED, 2)).toBe(
      "[cell] backwpup/pro@nginx, pinned by E2E_CELL: bddgen generates only its specs. " +
        `2 workers; report in ${REPORT}`,
    );
  });

  test("a run selected by --project: warns it is unsafe beside another, and names the pin", () => {
    expect(cellNotice({ ...PINNED, pinned: false }, 1)).toBe(
      "[cell] backwpup/pro@nginx, selected by --project: bddgen generates every cell's specs, " +
        "which breaks another backwpup run started beside this one; E2E_CELL=pro@nginx instead " +
        `lets cells run side by side. 1 worker; report in ${REPORT}`,
    );
  });

  test("a run of no single cell: serial, every cell's specs generated", () => {
    const { cell: _cell, ...none } = PINNED;
    expect(
      cellNotice(
        { ...none, pinned: false, reportDir: "reports/backwpup/_all/r" },
        1,
      ),
    ).toBe(
      "[cell] backwpup: no single cell selected, so the run is serial and bddgen generates " +
        "every cell's specs. 1 worker; report in reports/backwpup/_all/r",
    );
  });
});

// Playwright's own "Running … using N workers" counts `metadata.actualWorkers` — the configured
// workers capped by the test groups to run (measured: workers 4, one test → "using 1 worker").
test.describe("actualWorkers", () => {
  test("takes Playwright's own count when it set one", () => {
    expect(actualWorkers({ workers: 4, metadata: { actualWorkers: 1 } })).toBe(
      1,
    );
  });

  test("falls back to the configured workers otherwise", () => {
    for (const metadata of [{}, { actualWorkers: 0 }, { actualWorkers: "2" }]) {
      expect(
        actualWorkers({ workers: 4, metadata }),
        JSON.stringify(metadata),
      ).toBe(4);
    }
  });
});

test.describe("CellNoticeReporter", () => {
  test("prints the notice once as the run begins, with the run's real worker count", () => {
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      // onBegin reads only `workers` and `metadata`; the rest of FullConfig is irrelevant here.
      new CellNoticeReporter(PINNED).onBegin({
        workers: 4,
        metadata: { actualWorkers: 1 },
      } as unknown as FullConfig);
    } finally {
      process.stdout.write = original;
    }
    expect(written).toEqual([`${cellNotice(PINNED, 1)}\n`]);
  });

  test("prints through the run's terminal sink when there is one, never to stdout itself", () => {
    const printed: string[] = [];
    const unregister = registerTerminalSink({
      print: (text) => {
        printed.push(text);
      },
    });
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string | Uint8Array): boolean => {
      written.push(String(chunk));
      return true;
    };
    try {
      new CellNoticeReporter(PINNED).onBegin({
        workers: 2,
        metadata: {},
      } as unknown as FullConfig);
    } finally {
      process.stdout.write = original;
      unregister();
    }
    expect(written).toEqual([]);
    expect(printed).toEqual([cellNotice(PINNED, 2)]);
  });

  test("does not claim the terminal, so Playwright keeps a progress reporter", () => {
    expect(new CellNoticeReporter(PINNED).printsToStdio()).toBe(false);
  });
});
