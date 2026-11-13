import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REMOVE_PADDING_PHP, padTablesPhp } from "./table-padding";

/**
 * The padding's PHP, run for real against a fake `$wpdb` (`__fixtures__/fake-wpdb.php`), whose state
 * carries over from one call to the next so a sequence of runs can be replayed — killed runs included.
 *
 * These snippets drop tables on real sites, so what is pinned is what they drop: only padding, and
 * every earlier padding before counting, so leftovers can never pile up. Skipped where PHP is not
 * installed; the snippets also run live on every cell.
 */

const HARNESS = join(
  dirname(fileURLToPath(import.meta.url)),
  "__fixtures__",
  "fake-wpdb.php",
);

/** Whether a `php` binary can run here. */
const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

/** What one snippet did. */
interface SnippetRun {
  readonly output: string;
  /** The `WP_CLI::error()` message it stopped with, if it did. */
  readonly error: string | null;
  readonly statements: readonly string[];
}

/** One fake database, persisted in a state file between snippet runs. */
class FakeDatabase {
  private readonly dir = mkdtempSync(join(tmpdir(), "bwp-fake-wpdb-"));
  private readonly stateFile = join(this.dir, "state.json");

  constructor(state: {
    readonly prefix?: string;
    readonly tables: readonly string[];
    readonly failCreateAt?: number;
  }) {
    writeFileSync(
      this.stateFile,
      JSON.stringify({
        prefix: state.prefix ?? "wp_",
        tables: state.tables,
        fail_create_at: state.failCreateAt ?? null,
      }),
    );
  }

  /** Runs one snippet against this database. */
  run(php: string): SnippetRun {
    const file = join(this.dir, "snippet.php");
    writeFileSync(file, `<?php\n${php}`);
    const result = spawnSync("php", [HARNESS, file, this.stateFile], {
      encoding: "utf8",
    });
    if (result.status !== 0) {
      throw new Error(`the fake wpdb harness failed: ${result.stderr}`);
    }
    return JSON.parse(result.stdout) as SnippetRun;
  }

  /** The tables it holds now. */
  get tables(): readonly string[] {
    return (
      JSON.parse(readFileSync(this.stateFile, "utf8")) as { tables: string[] }
    ).tables;
  }

  /** Its padding tables. */
  get padding(): readonly string[] {
    return this.tables.filter((name) => /^wp_e2e_pace_\d{3}$/.test(name));
  }

  dispose(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** A site's own tables, `wp_own_1` … `wp_own_<n>`. */
const own = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `wp_own_${String(i + 1)}`);

test.describe("the padding PHP, against a fake database", () => {
  test.skip(!HAS_PHP, "php is not installed here");

  let db: FakeDatabase | undefined;
  test.afterEach(() => {
    db?.dispose();
    db = undefined;
  });

  test("pads a site's tables to the target with names of its own", () => {
    db = new FakeDatabase({ tables: own(18) });
    expect(db.run(padTablesPhp(100)).output).toBe(
      '{"before":18,"created":82,"total":100,"padding":82}',
    );
    expect(db.padding).toHaveLength(82);
    expect(db.padding[0]).toBe("wp_e2e_pace_001");
    expect(db.padding.at(-1)).toBe("wp_e2e_pace_082");
  });

  test("creates nothing on a site that already holds enough", () => {
    db = new FakeDatabase({ tables: own(120) });
    expect(db.run(padTablesPhp(100)).output).toBe(
      '{"before":120,"created":0,"total":120,"padding":0}',
    );
  });

  // The question this was built for: a run killed before its teardown, again and again.
  test("never piles up: runs killed before their teardown leave one padding at most", () => {
    db = new FakeDatabase({ tables: own(18) });
    for (let killed = 0; killed < 3; killed++) {
      expect(db.run(padTablesPhp(100)).output).toBe(
        '{"before":18,"created":82,"total":100,"padding":82}',
      );
    }
    expect(db.tables).toHaveLength(100);
    expect(db.run(REMOVE_PADDING_PHP).output).toBe('{"dropped":82,"left":0}');
    expect(db.tables).toEqual(own(18));
  });

  // What the next run's sweep sees on a clean site: nothing to say.
  test("drops nothing where there is no padding", () => {
    db = new FakeDatabase({ tables: own(18) });
    expect(db.run(REMOVE_PADDING_PHP)).toEqual({
      output: '{"dropped":0,"left":0}',
      error: null,
      statements: [],
    });
  });

  test("never drops a table that only looks like padding", () => {
    const lookalikes = [
      "wp_e2e_pace_0001",
      "wp_e2e_pace_01",
      "wp_e2e_pace_abc",
      "wpXe2e_pace_001",
      "wp_e2eXpace_001",
      "other_e2e_pace_001",
      "wp_e2e_pace_001_x",
    ];
    db = new FakeDatabase({ tables: [...own(10), ...lookalikes] });
    db.run(padTablesPhp(100));
    const removal = db.run(REMOVE_PADDING_PHP);
    expect(db.tables).toEqual([...own(10), ...lookalikes]);
    for (const statement of removal.statements) {
      expect(statement).toMatch(/^DROP TABLE IF EXISTS `wp_e2e_pace_\d{3}`$/);
    }
  });

  test("names its tables after the site's own prefix", () => {
    db = new FakeDatabase({ prefix: "wp_2_", tables: own(18) });
    db.run(padTablesPhp(20));
    expect(db.tables).toEqual([
      ...own(18),
      "wp_2_e2e_pace_001",
      "wp_2_e2e_pace_002",
    ]);
  });

  test("stops at a failed statement with the database's own words, and removal still takes all", () => {
    db = new FakeDatabase({ tables: own(18), failCreateAt: 50 });
    const run = db.run(padTablesPhp(100));
    expect(run.error).toBe(
      "CREATE TABLE `wp_e2e_pace_033` ( id INT NOT NULL PRIMARY KEY ) failed: The table is full",
    );
    expect(run.output).toBe("");
    expect(db.padding).toHaveLength(32);
    expect(db.run(REMOVE_PADDING_PHP).output).toBe('{"dropped":32,"left":0}');
    expect(db.tables).toEqual(own(18));
  });
});
