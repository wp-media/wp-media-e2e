import { test, expect } from "@playwright/test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { normaliseConfigEdits } from "./config-edits-declaration";
import {
  engineSandbox,
  HAS_PHP,
  runEngine,
} from "../__fixtures__/config-edits-engine";
import { removeTempDir } from "../__fixtures__/temp-dir";
import type { EngineSandbox } from "../__fixtures__/config-edits-engine";
import type { ConfigEdits } from "../config/types";

/**
 * The in-place cleanup engine run for real on this machine's PHP, outside WordPress, on a product-
 * agnostic declaration: the record's privacy and refusals, the reconcile path, every outcome. WP
 * Rocket's own transforms are pinned in its `config-edits.php.spec.ts`. Skipped without PHP.
 */

/** A plugin that appends a line to `conf.txt` and inserts rules it builds into `rules.txt`. */
const EDITS: ConfigEdits = normaliseConfigEdits(
  {
    files: [
      {
        path: "conf.txt",
        operations: [
          {
            name: "append",
            steps: [
              {
                pattern: "/\\z/",
                replacement: "added by the plugin\n",
                limit: 1,
                when: { kind: "lacks", pattern: "/added by the plugin/" },
              },
            ],
          },
        ],
      },
      {
        path: "rules.txt",
        operations: [
          {
            name: "rules",
            steps: [
              {
                pattern: "/\\A/",
                replacement: "<rules>{{body}}</rules>\n",
                limit: 1,
              },
            ],
          },
        ],
        captures: [
          { name: "body", pattern: "/^<rules>(.*)<\\/rules>$/m", group: "1" },
        ],
      },
    ],
    createdFiles: [{ path: "dropin.php", marks: ["PLUGIN_MARK"] }],
    createdDirs: ["made"],
  },
  "spec",
);

let sandbox: EngineSandbox;

test.beforeEach(() => {
  sandbox = engineSandbox();
});

test.afterEach(() => {
  // A test may leave a file unwritable or a folder closed: open them so the removal can.
  chmodTree(sandbox.base);
  removeTempDir(sandbox.base);
});

/** Makes every directory and file under `path` writable by its owner. */
function chmodTree(path: string): void {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (!stat.isDirectory()) return;
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) chmodTree(join(path, name));
}

/** A path in the sandbox's root. */
function at(name: string): string {
  return join(sandbox.root, name);
}

/** Runs the engine and returns its parsed answer, failing on a non-zero exit. */
function engine(mode: "record" | "restore"): Record<string, unknown> {
  const run = runEngine(sandbox, mode, EDITS);
  expect(run.status, run.stdout).toBe(0);
  return JSON.parse(run.stdout.trim().split("\n").at(-1) ?? "") as Record<
    string,
    unknown
  >;
}

/** An engine run's parsed answer: its last line. */
function answerOf(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Record<
    string,
    unknown
  >;
}

/** The result for one outcome of an answer's list. */
function resultOf(outcomes: unknown, kind: string, index = 0): unknown {
  return (outcomes as { kind: string; index: number; result: string }[]).find(
    (o) => o.kind === kind && o.index === index,
  )?.result;
}

test.describe("the in-place cleanup engine", () => {
  test.skip(!HAS_PHP, "PHP is not installed here");

  test("records into a private folder (0700, files 0600) and commits it with meta.json last", () => {
    writeFileSync(at("conf.txt"), "secret = 1\n");
    expect(engine("record")).toEqual({
      reconciled: null,
      unusable: null,
      discarded: false,
      swept: 0,
      unswept: 0,
    });
    expect(statSync(sandbox.recordDir).mode & 0o777).toBe(0o700);
    expect(readdirSync(sandbox.recordDir).sort()).toEqual([
      "file-0",
      "meta.json",
    ]);
    for (const name of readdirSync(sandbox.recordDir)) {
      expect(statSync(join(sandbox.recordDir, name)).mode & 0o777).toBe(0o600);
    }
    expect(
      readFileSync(join(sandbox.recordDir, "meta.json"), "utf8"),
    ).not.toContain("secret");
  });

  test("restores only what the declared edits explain, then removes the record", () => {
    writeFileSync(at("conf.txt"), "a = 1");
    writeFileSync(at("rules.txt"), "x $1 \\1\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a = 1added by the plugin\n");
    // Captured text with back-reference look-alikes goes in literally.
    writeFileSync(at("rules.txt"), "<rules>$1 \\0 ${x}</rules>\nx $1 \\1\n");
    const answer = engine("restore");
    expect(resultOf(answer.outcomes, "file", 0)).toBe("restored");
    expect(resultOf(answer.outcomes, "file", 1)).toBe("restored");
    expect(readFileSync(at("conf.txt"), "utf8")).toBe("a = 1");
    expect(readFileSync(at("rules.txt"), "utf8")).toBe("x $1 \\1\n");
    expect(existsSync(sandbox.recordDir)).toBe(false);
  });

  test("with no record, restore answers so and changes nothing", () => {
    writeFileSync(at("conf.txt"), "changed");
    expect(engine("restore")).toEqual({ none: true });
    expect(readFileSync(at("conf.txt"), "utf8")).toBe("changed");
  });

  test("a killed run's record is reconciled first: restored from, then recorded anew", () => {
    writeFileSync(at("conf.txt"), "a = 1\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a = 1\nadded by the plugin\n");
    const answer = engine("record");
    expect(resultOf(answer.reconciled, "file", 0)).toBe("restored");
    expect(readFileSync(at("conf.txt"), "utf8")).toBe("a = 1\n");
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(true);
    expect(resultOf(engine("restore").outcomes, "file", 0)).toBe("unchanged");
  });

  test("an unfinished record (no meta.json) is discarded and taken anew", () => {
    mkdirSync(sandbox.recordDir, { mode: 0o700 });
    writeFileSync(join(sandbox.recordDir, "file-0"), "half");
    expect(engine("record")).toMatchObject({
      reconciled: null,
      discarded: true,
    });
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(true);
  });

  for (const [name, make] of [
    [
      "open to others",
      () => {
        mkdirSync(sandbox.recordDir, { mode: 0o755 });
      },
    ],
    [
      "a symbolic link",
      () => {
        mkdirSync(join(sandbox.base, "elsewhere"), { mode: 0o700 });
        symlinkSync(join(sandbox.base, "elsewhere"), sandbox.recordDir);
      },
    ],
    [
      "a file",
      () => {
        writeFileSync(sandbox.recordDir, "");
      },
    ],
  ] as const) {
    test(`a record folder that is ${name} is never used: nothing recorded or put back, and the run goes on`, () => {
      make();
      if (name === "open to others") chmodSync(sandbox.recordDir, 0o755);
      writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
      for (const mode of ["record", "restore"] as const) {
        expect(engine(mode), mode).toEqual({ blocked: sandbox.recordDir });
      }
      expect(existsSync(join(sandbox.base, "elsewhere", "file-0"))).toBe(false);
      expect(readFileSync(at("conf.txt"), "utf8")).toBe(
        "a\nadded by the plugin\n",
      );
      expect(existsSync(sandbox.recordDir)).toBe(true);
    });
  }

  test("a tracked path that is a link is never followed or touched", () => {
    writeFileSync(join(sandbox.base, "target"), "target\n");
    symlinkSync(join(sandbox.base, "target"), at("conf.txt"));
    engine("record");
    writeFileSync(
      join(sandbox.base, "target"),
      "target\nadded by the plugin\n",
    );
    expect(resultOf(engine("restore").outcomes, "file", 0)).toBe("link");
    expect(readFileSync(join(sandbox.base, "target"), "utf8")).toBe(
      "target\nadded by the plugin\n",
    );
  });

  test("absent before: removed when only the edits explain it, else left; gone since: missing", () => {
    writeFileSync(at("rules.txt"), "kept\n");
    engine("record");
    writeFileSync(at("conf.txt"), "added by the plugin\n");
    const first = engine("restore");
    expect(resultOf(first.outcomes, "file", 0)).toBe("removed");
    expect(existsSync(at("conf.txt"))).toBe(false);
    expect(resultOf(first.outcomes, "file", 1)).toBe("unchanged");

    engine("record");
    writeFileSync(at("conf.txt"), "someone else's\n");
    chmodSync(at("rules.txt"), 0o644);
    writeFileSync(at("rules.txt"), "");
    rmSync(at("rules.txt"));
    const second = engine("restore");
    expect(resultOf(second.outcomes, "file", 0)).toBe("appeared");
    expect(readFileSync(at("conf.txt"), "utf8")).toBe("someone else's\n");
    expect(resultOf(second.outcomes, "file", 1)).toBe("missing");
  });

  test("an edit the identity cannot write is left with the plugin's change, and said", () => {
    test.skip(process.getuid?.() === 0, "root writes anything");
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
    chmodSync(at("conf.txt"), 0o444);
    expect(resultOf(engine("restore").outcomes, "file", 0)).toBe("unwritable");
    expect(readFileSync(at("conf.txt"), "utf8")).toBe(
      "a\nadded by the plugin\n",
    );
  });

  test("a record that cannot be trusted is discarded unused: the files are not touched", () => {
    const meta = join(sandbox.recordDir, "meta.json");
    for (const [reason, spoil] of [
      [
        "damaged",
        () => {
          writeFileSync(join(sandbox.recordDir, "file-0"), "tampered");
        },
      ],
      [
        "other-root",
        () => {
          writeFileSync(
            meta,
            readFileSync(meta, "utf8").replace(
              /"root":"[^"]*"/,
              '"root":"\\/other\\/"',
            ),
          );
        },
      ],
      [
        "unreadable",
        () => {
          writeFileSync(meta, "{");
        },
      ],
    ] as const) {
      writeFileSync(at("conf.txt"), "a\n");
      engine("record");
      spoil();
      writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
      expect(engine("restore"), reason).toEqual({ unusable: reason });
      expect(readFileSync(at("conf.txt"), "utf8")).toBe(
        "a\nadded by the plugin\n",
      );
      expect(existsSync(sandbox.recordDir), reason).toBe(false);
    }
    // In the Before too: said, then recorded anew.
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    writeFileSync(meta, "{");
    expect(engine("record")).toMatchObject({
      reconciled: null,
      unusable: "unreadable",
      discarded: false,
    });
    expect(existsSync(meta)).toBe(true);
  });

  test("conditions read the operation's input, not what an earlier step made of it", () => {
    const edits = normaliseConfigEdits(
      {
        files: [
          {
            path: "conf.txt",
            operations: [
              {
                name: "two",
                steps: [
                  {
                    pattern: "/\\z/",
                    replacement: "X",
                    limit: 1,
                    when: { kind: "lacks", pattern: "/X/" },
                  },
                  {
                    pattern: "/\\z/",
                    replacement: "Y",
                    limit: 1,
                    when: { kind: "lacks", pattern: "/X/" },
                  },
                ],
              },
              {
                // WP Rocket's "replace only when set to another value": never when already that value.
                name: "set v",
                steps: [
                  {
                    pattern: "/v=\\w*/",
                    replacement: "v=new",
                    limit: 1,
                    when: {
                      kind: "differs",
                      pattern: "/v=(?<value>\\w*)/",
                      group: "value",
                      value: "same",
                    },
                  },
                ],
              },
            ],
          },
          {
            path: "rules.txt",
            operations: [
              {
                name: "rules",
                steps: [
                  {
                    pattern: "/\\A/",
                    replacement: "<rules>{{body}}</rules>\n",
                    limit: 1,
                  },
                ],
              },
            ],
            captures: [
              {
                name: "body",
                pattern: "/^<rules>(\\d+)<\\/rules>$/m",
                group: "1",
              },
            ],
          },
        ],
      },
      "spec",
    );
    const run = (mode: "record" | "restore"): Record<string, unknown> => {
      const result = runEngine(sandbox, mode, edits);
      expect(result.status, result.stdout).toBe(0);
      return JSON.parse(result.stdout.trim()) as Record<string, unknown>;
    };
    writeFileSync(at("conf.txt"), "v=same ");
    writeFileSync(at("rules.txt"), "r\n");
    run("record");
    writeFileSync(at("conf.txt"), "v=same XY");
    expect(resultOf(run("restore").outcomes, "file", 0)).toBe("restored");

    run("record");
    // What the edit would make had it ignored its own value check.
    writeFileSync(at("conf.txt"), "v=new ");
    // No capture (the rules are digits) in the file: the rules operation is not one the plugin made.
    writeFileSync(at("rules.txt"), "<rules>{{body}}</rules>\nr\n");
    const answer = run("restore");
    expect(resultOf(answer.outcomes, "file", 0)).toBe("unrecognized");
    expect(resultOf(answer.outcomes, "file", 1)).toBe("unrecognized");
  });

  test("a private file where the record folder belongs is never used", () => {
    writeFileSync(sandbox.recordDir, "", { mode: 0o600 });
    expect(engine("record")).toEqual({ blocked: sandbox.recordDir });
    expect(readFileSync(sandbox.recordDir, "utf8")).toBe("");
  });

  test("a created folder that existed before is kept, even empty", () => {
    mkdirSync(at("made"));
    engine("record");
    expect(resultOf(engine("restore").outcomes, "dir")).toBe("kept");
    expect(existsSync(at("made"))).toBe(true);
  });

  test("created files and folders: only what was absent and is empty or marked goes", () => {
    writeFileSync(at("dropin.php"), "someone's\n");
    engine("record");
    writeFileSync(at("dropin.php"), "changed\n");
    mkdirSync(at("made"));
    writeFileSync(join(at("made"), "x"), "");
    let answer = engine("restore");
    expect(resultOf(answer.outcomes, "created-file")).toBe("changed");
    expect(resultOf(answer.outcomes, "dir")).toBe("not-empty");
    expect(existsSync(at("made/x"))).toBe(true);

    rmSync(at("dropin.php"));
    rmSync(at("made"), { recursive: true });
    engine("record");
    writeFileSync(at("dropin.php"), "<?php // other plugin\n");
    mkdirSync(at("made"));
    answer = engine("restore");
    expect(resultOf(answer.outcomes, "created-file")).toBe("foreign");
    expect(resultOf(answer.outcomes, "dir")).toBe("removed");

    rmSync(at("dropin.php"));
    engine("record");
    writeFileSync(at("dropin.php"), "<?php define( 'PLUGIN_MARK', 1 );\n");
    expect(resultOf(engine("restore").outcomes, "created-file")).toBe(
      "removed",
    );
    expect(existsSync(at("dropin.php"))).toBe(false);
  });

  test("stale records of this user are swept, recent ones and other names kept", () => {
    const parent = dirname(sandbox.recordDir);
    const stale = join(parent, "e2e-record-stale0000000000");
    const fresh = join(parent, "e2e-record-fresh0000000000");
    const other = join(parent, "e2e-private-x");
    for (const dir of [stale, fresh, other]) {
      mkdirSync(dir, { mode: 0o700 });
      writeFileSync(join(dir, "meta.json"), "{}");
    }
    const old = new Date(Date.now() - 31 * 86_400_000);
    utimesSync(stale, old, old);
    utimesSync(other, old, old);
    expect(engine("record")).toMatchObject({ swept: 1 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  test("a pattern PHP rejects fails the restore naming the file and operation", () => {
    const broken: ConfigEdits = {
      files: [
        {
          path: "conf.txt",
          operations: [
            {
              name: "broken",
              steps: [{ pattern: "/(/", replacement: "", limit: 1 }],
            },
          ],
        },
      ],
    };
    writeFileSync(at("conf.txt"), "a\n");
    expect(runEngine(sandbox, "record", broken).status).toBe(0);
    writeFileSync(at("conf.txt"), "b\n");
    const run = runEngine(sandbox, "restore", broken);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/conf\.txt broken step 1: PCRE error/);
  });

  test("each identity keeps its own record folder: another uid's at the same name is never read or touched", () => {
    const other = `${sandbox.recordStem}-${String((process.geteuid?.() ?? 0) + 4242)}`;
    mkdirSync(other, { mode: 0o700 });
    writeFileSync(join(other, "meta.json"), "{}");
    writeFileSync(at("conf.txt"), "a\n");
    expect(engine("record")).toMatchObject({
      reconciled: null,
      unusable: null,
      discarded: false,
    });
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(true);
    expect(readFileSync(join(other, "meta.json"), "utf8")).toBe("{}");
    engine("restore");
    expect(existsSync(other)).toBe(true);
  });

  test("a stale record that will not go is counted, never a failure; one open to others is never swept", () => {
    const parent = dirname(sandbox.recordDir);
    const stuck = join(parent, "e2e-record-stuck00000000000-1");
    const open = join(parent, "e2e-record-open000000000000-1");
    mkdirSync(join(stuck, "sub"), { recursive: true });
    chmodSync(stuck, 0o700);
    mkdirSync(open);
    chmodSync(open, 0o755);
    const old = new Date(Date.now() - 31 * 86_400_000);
    for (const dir of [stuck, open]) utimesSync(dir, old, old);
    expect(engine("record")).toMatchObject({ swept: 0, unswept: 1 });
    expect(existsSync(join(stuck, "sub"))).toBe(true);
    expect(existsSync(open)).toBe(true);
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(true);
  });

  test("a file swapped for a link after it was judged is never written through", () => {
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
    const target = join(sandbox.base, "target");
    writeFileSync(target, "someone else's\n");
    const run = runEngine(sandbox, "restore", EDITS, {
      after: "$cut = ! $explained",
      swap: { path: at("conf.txt"), target },
    });
    expect(run.status, run.stdout).toBe(0);
    expect(resultOf(answerOf(run.stdout).outcomes, "file", 0)).toBe("replaced");
    expect(readFileSync(target, "utf8")).toBe("someone else's\n");
  });

  test("a mode is set back only on the file put back, never through a link swapped in after", () => {
    writeFileSync(at("conf.txt"), "a\n");
    chmodSync(at("conf.txt"), 0o600);
    engine("record");
    writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
    chmodSync(at("conf.txt"), 0o644);
    const target = join(sandbox.base, "target");
    writeFileSync(target, "t\n");
    chmodSync(target, 0o644);
    const run = runEngine(sandbox, "restore", EDITS, {
      after: "$result = $cut ? 'resumed' : 'restored';",
      swap: { path: at("conf.txt"), target },
    });
    expect(run.status, run.stdout).toBe(0);
    const outcome = (
      answerOf(run.stdout).outcomes as { kind: string; mode?: unknown }[]
    ).find((o) => o.kind === "file");
    expect(outcome).toMatchObject({ result: "restored" });
    expect(outcome?.mode).toBeUndefined();
    expect(statSync(target).mode & 0o777).toBe(0o644);
  });

  test("a record is removed index first: one killed mid-removal is an unfinished record, never an unusable one", () => {
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    // Killed once the removal has taken its first entry: as it looks at the second.
    const run = runEngine(sandbox, "restore", EDITS, {
      after: "$s = $e2e_stat( $dir . '/' . $name );",
      nth: 2,
    });
    expect(run.status).toBe(137);
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(false);
    expect(existsSync(join(sandbox.recordDir, "file-0"))).toBe(true);
    expect(engine("record")).toMatchObject({
      unusable: null,
      discarded: true,
    });
  });

  for (const [name, cut] of [
    ["empty", ""],
    ["cut part-way", "a\nb"],
  ] as const) {
    test(`a file found ${name}, a prefix of its record, is put back in full`, () => {
      writeFileSync(at("conf.txt"), "a\nb\nc\n");
      engine("record");
      writeFileSync(at("conf.txt"), cut);
      expect(resultOf(engine("restore").outcomes, "file", 0)).toBe("resumed");
      expect(readFileSync(at("conf.txt"), "utf8")).toBe("a\nb\nc\n");
    });
  }

  test("a put-back that does not land names where the recorded bytes are kept, and keeps them", () => {
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
    const target = join(sandbox.base, "target");
    writeFileSync(target, "other\n");
    const run = runEngine(sandbox, "restore", EDITS, {
      after: "flock( $h, LOCK_UN );",
      swap: { path: at("conf.txt"), target },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(
      `does not hold its recorded bytes, which are kept in ${sandbox.recordDir}`,
    );
    expect(existsSync(join(sandbox.recordDir, "meta.json"))).toBe(true);
  });

  test("a record step failing after it reconciled says so in its error", () => {
    writeFileSync(at("conf.txt"), "a\n");
    engine("record");
    writeFileSync(at("conf.txt"), "a\nadded by the plugin\n");
    // The killed run's record is put back and removed; then its folder's name is taken by a link.
    const run = runEngine(sandbox, "record", EDITS, {
      after: "$e2e_context = ' (after",
      swap: {
        path: sandbox.recordDir,
        target: join(sandbox.base, "elsewhere"),
      },
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(
      /creating the record folder .* failed \(after a killed run's record was put back first: 4 path\(s\) judged\)/,
    );
    expect(readFileSync(at("conf.txt"), "utf8")).toBe("a\n");
  });
});
