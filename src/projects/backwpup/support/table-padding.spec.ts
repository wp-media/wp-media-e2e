import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  MAX_PADDING_TABLES,
  REMOVE_PADDING_PHP,
  TablePadding,
  checkPaddingTarget,
  padTables,
  padTablesPhp,
  parsePaddingOutcome,
  parseRemovalOutcome,
  removePaddingTables,
  sweepPaddingLeftovers,
} from "./table-padding";
import type { LocalTransport } from "../../../common/config/types";

// A stub `wp` on PATH answers as the site would, over the real exec layer, and logs each call so a
// test can tell whether the site was asked at all. The PHP itself is run against a fake `$wpdb` in
// `table-padding.php.spec.ts` (skipped where PHP is not installed), and live on every cell.
const STUB_WP = `#!/usr/bin/env bash
printf '%s\\n' "$1" >> "$WP_STUB_LOG"
case "$*" in
  *"CREATE TABLE"*) reply="$WP_STUB_PAD" ;;
  *) reply="$WP_STUB_REMOVE" ;;
esac
if [ "$reply" = "fail" ]; then printf 'Error: CREATE TABLE failed: Disk full\\n' >&2; exit 1; fi
printf '%s' "$reply"
`;

let binDir: string;
let rootDir: string;
let callLog: string;
let originalPath: string | undefined;

test.beforeAll(() => {
  binDir = mkdtempSync(join(tmpdir(), "bwp-padding-bin-"));
  rootDir = mkdtempSync(join(tmpdir(), "bwp-padding-root-"));
  callLog = join(binDir, "calls.log");
  writeFileSync(join(binDir, "wp"), STUB_WP);
  chmodSync(join(binDir, "wp"), 0o755);
  originalPath = process.env.PATH;
  process.env.PATH = `${binDir}:${originalPath ?? ""}`;
  process.env.WP_STUB_LOG = callLog;
});

test.beforeEach(() => {
  rmSync(callLog, { force: true });
  process.env.WP_STUB_PAD =
    '{"before":18,"created":82,"total":100,"padding":82}';
  process.env.WP_STUB_REMOVE = '{"dropped":82,"left":0}';
});

test.afterAll(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  for (const name of ["WP_STUB_LOG", "WP_STUB_PAD", "WP_STUB_REMOVE"]) {
    Reflect.deleteProperty(process.env, name);
  }
  rmSync(binDir, { recursive: true, force: true });
  rmSync(rootDir, { recursive: true, force: true });
});

const local = (): LocalTransport => ({ mode: "local", rootDir });

/** Runs `work` with `console[level]` captured, and returns what it printed. */
async function capturing(
  level: "info" | "warn",
  work: () => Promise<void>,
): Promise<string> {
  const printed: string[] = [];
  // The descriptor, not the method: it is put back exactly as it was, with no unbound reference.
  const original = Object.getOwnPropertyDescriptor(console, level);
  console[level] = (...args: unknown[]) => {
    printed.push(args.map(String).join(" "));
  };
  try {
    await work();
  } finally {
    if (original !== undefined) Object.defineProperty(console, level, original);
  }
  return printed.join("\n");
}

/** How many times the stub `wp` was run. */
const calls = (): number =>
  existsSync(callLog)
    ? readFileSync(callLog, "utf8").split("\n").filter(Boolean).length
    : 0;

test.describe("checkPaddingTarget", () => {
  for (const target of [0, -1, 1.5, MAX_PADDING_TABLES + 1, Number.NaN]) {
    test(`refuses ${String(target)}`, () => {
      expect(() => {
        checkPaddingTarget(target);
      }).toThrow(/can be padded to 1–999 tables/);
    });
  }

  test("accepts the bounds", () => {
    expect(() => {
      checkPaddingTarget(1);
      checkPaddingTarget(MAX_PADDING_TABLES);
    }).not.toThrow();
  });
});

test.describe("the padding PHP", () => {
  // The target comes from feature text, so it travels as a literal and never as snippet source.
  test("embeds the target and the name stem as literals", () => {
    const php = padTablesPhp(100);
    expect(php).toContain(
      `(int) json_decode( base64_decode( '${Buffer.from("100").toString("base64")}' ), true )`,
    );
    expect(php).toContain(
      `$wpdb->prefix . json_decode( base64_decode( '${Buffer.from('"e2e_pace_"').toString("base64")}' ), true )`,
    );
  });

  // Both drop exactly the same set: the earlier padding goes before counting, and nothing else ever.
  test("both snippets drop only names of the padding's shape", () => {
    const drop =
      /preg_grep\( '\/\^' \. preg_quote\( \$stem, '\/' \) \. '\\d\{3\}\$\/'/;
    expect(padTablesPhp(100)).toMatch(drop);
    expect(REMOVE_PADDING_PHP).toMatch(drop);
    const php = padTablesPhp(100);
    expect(php.indexOf("DROP TABLE")).toBeGreaterThan(-1);
    expect(php.indexOf("DROP TABLE")).toBeLessThan(
      php.indexOf("SHOW FULL TABLES"),
    );
  });
});

test.describe("parsePaddingOutcome", () => {
  test("reads what the padding did", () => {
    expect(
      parsePaddingOutcome(
        '{"before":18,"created":82,"total":100,"padding":82}',
        100,
      ),
    ).toEqual({ before: 18, created: 82, total: 100 });
  });

  test("reads a site that already had enough", () => {
    expect(
      parsePaddingOutcome(
        '{"before":120,"created":0,"total":120,"padding":0}',
        100,
      ),
    ).toEqual({ before: 120, created: 0, total: 120 });
  });

  for (const reply of ["", "Error: nope", "[]", "null", '"x"']) {
    test(`refuses a reply that is not an outcome (${JSON.stringify(reply)})`, () => {
      expect(() => parsePaddingOutcome(reply, 100)).toThrow(
        /did not report the padding's outcome/,
      );
    });
  }

  for (const reply of [
    '{"before":18,"created":82,"total":100}',
    '{"before":-1,"created":82,"total":100,"padding":82}',
    '{"before":18,"created":8.2,"total":100,"padding":82}',
    '{"before":"18","created":82,"total":100,"padding":82}',
  ]) {
    test(`refuses a count that is not one (${reply})`, () => {
      expect(() => parsePaddingOutcome(reply, 100)).toThrow(/to be a count/);
    });
  }

  // Either would leave the paced backup shorter than the scenario was told it is.
  test("refuses a database left short of the target", () => {
    expect(() =>
      parsePaddingOutcome(
        '{"before":18,"created":80,"total":98,"padding":80}',
        100,
      ),
    ).toThrow(
      "should hold at least 100 tables, 80 of them padding; it holds 98, 80 of them padding.",
    );
  });

  test("refuses a padding table that is not there", () => {
    expect(() =>
      parsePaddingOutcome(
        '{"before":18,"created":82,"total":100,"padding":81}',
        100,
      ),
    ).toThrow(/82 of them padding; it holds 100, 81 of them padding/);
  });
});

test.describe("padTables", () => {
  test("pads the site and reports what it did", async () => {
    expect(await padTables(local(), 100)).toEqual({
      before: 18,
      created: 82,
      total: 100,
    });
    expect(calls()).toBe(1);
  });

  test("refuses a bad target before asking the site anything", async () => {
    await expect(padTables(local(), 0)).rejects.toThrow(/1–999/);
    expect(calls()).toBe(0);
  });

  test("passes on the database's own refusal", async () => {
    process.env.WP_STUB_PAD = "fail";
    await expect(padTables(local(), 100)).rejects.toThrow(
      /padding the database to 100 tables failed \(exit 1\): Error: CREATE TABLE failed: Disk full/,
    );
  });
});

test.describe("parseRemovalOutcome", () => {
  test("reads how many were dropped", () => {
    expect(parseRemovalOutcome('{"dropped":15,"left":0}')).toBe(15);
    expect(parseRemovalOutcome('{"dropped":0,"left":0}')).toBe(0);
  });

  // Verified, never inferred from the statements having run.
  test("refuses a padding table still there afterwards", () => {
    expect(() => parseRemovalOutcome('{"dropped":15,"left":3}')).toThrow(
      "3 padding table(s) are still in the database after removal.",
    );
  });

  for (const reply of ["0", "", '{"dropped":15}', '{"dropped":-1,"left":0}']) {
    test(`refuses a reply that is not a removal's (${JSON.stringify(reply)})`, () => {
      expect(() => parseRemovalOutcome(reply)).toThrow(
        /did not report the removal's outcome|to be a count/,
      );
    });
  }
});

test.describe("removePaddingTables", () => {
  test("returns how many it dropped", async () => {
    expect(await removePaddingTables(local())).toBe(82);
  });

  test("passes on a removal the site could not finish", async () => {
    process.env.WP_STUB_REMOVE = "fail";
    await expect(removePaddingTables(local())).rejects.toThrow(
      /removing the padding tables failed \(exit 1\)/,
    );
  });
});

/**
 * The sweep a BackWPup worker runs before its first scenario, for the padding a killed run left —
 * reproduced live: a run killed once its padding existed left 15 tables, and a later run of another
 * feature kept them.
 */
test.describe("sweepPaddingLeftovers", () => {
  const site = { baseURL: "https://bwu.e2e.test", transport: local() };

  test("asks nothing when the worker has no site", async () => {
    await sweepPaddingLeftovers(undefined);
    expect(calls()).toBe(0);
  });

  // A placeholder site has no reachable transport, so asking would only fail.
  test("asks nothing of a placeholder site", async () => {
    await sweepPaddingLeftovers({
      baseURL: "https://site-1.example.test",
      transport: local(),
    });
    expect(calls()).toBe(0);
  });

  test("says what it removed, naming the site", async () => {
    process.env.WP_STUB_REMOVE = '{"dropped":15,"left":0}';
    const printed = await capturing("info", () => sweepPaddingLeftovers(site));
    expect(calls()).toBe(1);
    expect(printed).toBe(
      "[backwpup/table-padding] removed 15 padding table(s) an earlier run left on https://bwu.e2e.test.",
    );
  });

  test("says nothing when there was nothing to remove", async () => {
    process.env.WP_STUB_REMOVE = '{"dropped":0,"left":0}';
    expect(await capturing("info", () => sweepPaddingLeftovers(site))).toBe("");
    expect(calls()).toBe(1);
  });

  // Housekeeping: an unreachable site fails the scenarios that need it, in their own words.
  for (const reply of ["fail", '{"dropped":15,"left":2}']) {
    test(`reports a sweep that failed instead of throwing (${reply})`, async () => {
      process.env.WP_STUB_REMOVE = reply;
      const printed = await capturing("warn", () =>
        expect(sweepPaddingLeftovers(site)).resolves.toBeUndefined(),
      );
      expect(printed).toMatch(
        /^\[backwpup\/table-padding\] could not sweep the padding an earlier run may have left on https:\/\/bwu\.e2e\.test: /,
      );
    });
  }
});

test.describe("TablePadding", () => {
  test("asks nothing of a site it never padded", async () => {
    await new TablePadding(local()).release();
    expect(calls()).toBe(0);
  });

  test("removes what it padded", async () => {
    const padding = new TablePadding(local());
    await padding.padTo(100);
    await padding.release();
    expect(calls()).toBe(2);
  });

  // The site may hold some of the tables by the time the padding failed.
  test("still removes a padding that failed half-way", async () => {
    process.env.WP_STUB_PAD = "fail";
    const padding = new TablePadding(local());
    await expect(padding.padTo(100)).rejects.toThrow(/Disk full/);
    await padding.release();
    expect(calls()).toBe(2);
  });

  test("marks nothing used for a target it refused", async () => {
    const padding = new TablePadding(local());
    await expect(padding.padTo(1000)).rejects.toThrow(/1–999/);
    await padding.release();
    expect(calls()).toBe(0);
  });

  // Teardown: a failed removal is reported, never thrown over the scenario's own verdict.
  test("reports a removal that failed instead of throwing", async () => {
    process.env.WP_STUB_REMOVE = '{"dropped":80,"left":2}';
    const padding = new TablePadding(local());
    await padding.padTo(100);
    const printed = await capturing("warn", () =>
      expect(padding.release()).resolves.toBeUndefined(),
    );
    expect(printed).toBe(
      "[backwpup/table-padding] could not remove this scenario's padding tables — empty, named " +
        "<prefix>e2e_pace_NNN, and dropped by the next run on this site: [backwpup/table-padding] 2 " +
        "padding table(s) are still in the database after removal.",
    );
  });
});
