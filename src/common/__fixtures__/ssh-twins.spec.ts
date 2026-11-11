import { test, expect } from "@playwright/test";

import {
  SSH_TWINS_ENV,
  TWIN_CELLS,
  sshTwinsEnabled,
  twinSiteIn,
} from "./ssh-twins";
import type { CellMap, SiteInput } from "../config/types";

/** The twin specs' gate and cell lookup: what decides whether they run and which site they use. */

const SITE: SiteInput = {
  baseURL: "http://localhost:8110",
  username: "admin",
  password: "pw",
  transport: {
    mode: "ssh",
    host: "127.0.0.1",
    port: 2210,
    username: "ubuntu",
    privateKeyPath: "/keys/id_ed25519",
    rootDir: "/var/www/site/public",
  },
};

test("twin specs run only when E2E_SSH_TWINS is 1 or true", () => {
  expect(sshTwinsEnabled({})).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "" })).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "0" })).toBe(false);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "1" })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "true" })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: " TRUE " })).toBe(true);
  expect(sshTwinsEnabled({ [SSH_TWINS_ENV]: "false" })).toBe(false);
});

// A typo must fail loudly, never turn every twin spec into a skip, and say what would work.
test("any other value is refused, naming the variable and the values it takes", () => {
  expect(() => sshTwinsEnabled({ [SSH_TWINS_ENV]: "yes" })).toThrow(
    `${SSH_TWINS_ENV} takes 1 or true (run the twin specs; the twins must be up: npm run env:cells:up) ` +
      'or 0, false or unset (skip them), got "yes".',
  );
});

test("each product has one cell per twin, matching the overlays' names", () => {
  expect(TWIN_CELLS.map((twin) => `${twin.product} ${twin.cell}`)).toEqual([
    "backwpup pro@twin-apache",
    "backwpup pro@twin-nginx",
    "wp-rocket twin-apache",
    "wp-rocket twin-nginx",
  ]);
});

test.describe("twinSiteIn", () => {
  const twin = TWIN_CELLS[0];
  if (twin === undefined) throw new Error("TWIN_CELLS is empty");

  test("returns the cell's only site", () => {
    const cells: CellMap = { [twin.cell]: { sites: [SITE] } };
    expect(twinSiteIn(cells, twin)).toBe(SITE);
  });

  test("an absent cell or a pool of two is refused, naming the cell and the way out", () => {
    for (const cells of [
      {},
      { [twin.cell]: { sites: [SITE, SITE] } },
    ] as CellMap[]) {
      expect(() => twinSiteIn(cells, twin)).toThrow(
        new RegExp(`"${twin.cell}" should hold exactly one site.+env:cells:up`),
      );
    }
  });
});
