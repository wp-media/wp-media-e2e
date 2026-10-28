import { test, expect } from "@playwright/test";

import { orchestratorCapabilities, tableView } from "./view";

/**
 * The orchestrator's capabilities and table layout. The precedence itself is `capabilities.spec.ts`'s
 * (with a real pty); here, only what the orchestrator passes it.
 */

const TERM = { TERM: "xterm-256color", LANG: "en_US.UTF-8" };

test.describe("orchestratorCapabilities", () => {
  test("a pipe never gets colour, even under FORCE_COLOR", () => {
    for (const FORCE_COLOR of ["1", "3", ""])
      expect(
        orchestratorCapabilities({ ...TERM, FORCE_COLOR }, { isTTY: false })
          .color,
      ).toBe(false);
  });

  test("a terminal gets colour, and a live region when sized and not under CI", () => {
    expect(
      orchestratorCapabilities(TERM, { isTTY: true, columns: 80, rows: 24 }),
    ).toEqual({ tty: true, color: true, live: true, unicode: true });
    expect(
      orchestratorCapabilities(
        { ...TERM, CI: "true" },
        { isTTY: true, columns: 80, rows: 24 },
      ).live,
    ).toBe(false);
  });

  test("reads no E2E_* variable: E2E_OUTPUT=plain changes nothing", () => {
    const stream = { isTTY: true, columns: 80, rows: 24 };
    expect(
      orchestratorCapabilities({ ...TERM, E2E_OUTPUT: "plain" }, stream),
    ).toEqual(orchestratorCapabilities(TERM, stream));
  });
});

test.describe("tableView", () => {
  test("width from the stream, height its rows less two, colour off whatever the terminal", () => {
    const view = tableView(TERM, { isTTY: true, columns: 100, rows: 30 });
    expect(view.width).toBe(100);
    expect(view.height).toBe(28);
    expect(view.capabilities.color).toBe(true);
    expect(view.palette.paint("fail", "x")).toBe("x");
    expect(view.palette.status("passed")).toBe("✔ passed");
  });

  test("an unsized stream has no height; its width falls back to COLUMNS, then 80", () => {
    expect(tableView(TERM, { isTTY: false })).toMatchObject({ width: 80 });
    expect(tableView(TERM, { isTTY: false }).height).toBeUndefined();
    expect(tableView({ ...TERM, COLUMNS: "60" }, { rows: 0 }).width).toBe(60);
    expect(tableView(TERM, { rows: 0 }).height).toBeUndefined();
    expect(tableView(TERM, { rows: 1.5 }).height).toBeUndefined();
    expect(tableView(TERM, { rows: 1 }).height).toBe(0);
  });

  test("ASCII symbols under a C locale", () => {
    expect(
      tableView({ TERM: "xterm", LANG: "C" }, { isTTY: false }).palette.symbol(
        "dash",
      ),
    ).toBe("-");
  });
});
