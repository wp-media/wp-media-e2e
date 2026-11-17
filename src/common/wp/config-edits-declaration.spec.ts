import { test, expect } from "@playwright/test";

import {
  blockedMessage,
  configEditsReport,
  normaliseConfigEdits,
  outcomeMessage,
  parseRecordAnswer,
  parseRestoreAnswer,
  unusableMessage,
} from "./config-edits-declaration";
import { recordStemFor, configEditsPhp } from "./config-edits";
import { phpLiteral } from "./php";
import type {
  ConfigEditStep,
  ConfigEdits,
  EditedFile,
  SshTransport,
} from "../config/types";

/** A file with one operation of one step. */
function file(
  step: Partial<ConfigEditStep> = {},
  extra: Partial<EditedFile> = {},
): EditedFile {
  return {
    path: "wp-config.php",
    operations: [
      {
        name: "op",
        steps: [{ pattern: "/a/", replacement: "b", limit: 1, ...step }],
      },
    ],
    ...extra,
  };
}

/** The one step of {@link file}. */
const STEP: ConfigEditStep = { pattern: "/a/", replacement: "b", limit: 1 };

const EDITS: ConfigEdits = {
  files: [file()],
  createdFiles: [{ path: "wp-content/advanced-cache.php", marks: ["MARK"] }],
  createdDirs: ["wp-content/cache"],
};

/** A file held for root to write back, as the engine answers it. */
const HELD = {
  dir: "/tmp/e2e-record-0123456789abcdef-33",
  copy: "file-0",
  uid: 33,
  dev: "64768",
  ino: "18446744073709551615",
  sha256: "a".repeat(64),
  judged: "c".repeat(64),
  mode: 0o644,
  write: true,
  resumed: false,
};

/** Only the mode held: the file holds the recorded bytes, so they are what was judged. */
const MODE_ONLY = { ...HELD, write: false, judged: HELD.sha256 };

test.describe("normaliseConfigEdits", () => {
  test("normalises every path and keeps the rest as declared", () => {
    expect(
      normaliseConfigEdits(
        {
          files: [{ ...file(), path: "./wp-config.php" }],
          createdDirs: ["wp-content/cache/"],
        },
        "p",
      ),
    ).toEqual({
      files: [{ ...file(), captures: [] }],
      createdFiles: [],
      createdDirs: ["wp-content/cache"],
    });
  });

  for (const [what, edits, message] of [
    [
      "an absolute path",
      { files: [{ ...file(), path: "/etc/passwd" }] },
      /"\/etc\/passwd" cannot be tracked: it is absolute/,
    ],
    [
      "a path out of the root",
      { files: [], createdDirs: ["../x"] },
      /escapes the WordPress root/,
    ],
    [
      "a path twice",
      { files: [file()], createdDirs: ["wp-config.php"] },
      /"wp-config.php" is declared twice/,
    ],
    ["nothing", { files: [] }, /it tracks nothing/],
    [
      "no operation",
      { files: [{ path: "a", operations: [] }] },
      /declares no operation/,
    ],
    [
      "an operation twice",
      {
        files: [
          {
            path: "a",
            operations: [
              { name: "x", steps: [STEP] },
              { name: "x", steps: [STEP] },
            ],
          },
        ],
      },
      /operation "x" is unnamed or declared twice/,
    ],
    [
      "a step-less operation",
      { files: [{ path: "a", operations: [{ name: "x", steps: [] }] }] },
      /has no step/,
    ],
    [
      "a pattern without delimiters",
      { files: [file({ pattern: "a" })] },
      /"a" is not a \/…\/flags PCRE pattern/,
    ],
    [
      "an unknown flag",
      { files: [file({ pattern: "/a/q" })] },
      /not a \/…\/flags PCRE pattern/,
    ],
    [
      "limit 0",
      { files: [file({ limit: 0 })] },
      /limit 0 is neither -1 nor a positive count/,
    ],
    ["limit -2", { files: [file({ limit: -2 })] }, /limit -2/],
    ["limit 1.5", { files: [file({ limit: 1.5 })] }, /limit 1.5/],
    [
      "a $1 back-reference",
      { files: [file({ replacement: "x$1" })] },
      /replacements are literal/,
    ],
    [
      "a \\1 back-reference",
      { files: [file({ replacement: "x\\1" })] },
      /replacements are literal/,
    ],
    [
      "a ${ back-reference",
      { files: [file({ replacement: "${x}" })] },
      /replacements are literal/,
    ],
    [
      "an unknown capture",
      { files: [file({ replacement: "{{nope}}" })] },
      /"\{\{nope\}\}" names no capture/,
    ],
    [
      "a capture twice",
      {
        files: [
          file(
            {},
            {
              captures: [
                { name: "c", pattern: "/a/", group: "1" },
                { name: "c", pattern: "/a/", group: "1" },
              ],
            },
          ),
        ],
      },
      /capture "c" is unusable or declared twice/,
    ],
    [
      "a capture with no group",
      {
        files: [
          file({}, { captures: [{ name: "c", pattern: "/a/", group: "" }] }),
        ],
      },
      /names no group/,
    ],
    [
      "a bad condition pattern",
      { files: [file({ when: { kind: "lacks", pattern: "x" } })] },
      /condition: "x" is not/,
    ],
    [
      "a differs without group",
      {
        files: [
          file({
            when: { kind: "differs", pattern: "/a/", group: "", value: "v" },
          }),
        ],
      },
      /condition names no group/,
    ],
    [
      "a mark-less created file",
      { files: [], createdFiles: [{ path: "a", marks: [] }] },
      /needs at least one mark/,
    ],
    [
      "an empty mark",
      { files: [], createdFiles: [{ path: "a", marks: [""] }] },
      /needs at least one mark/,
    ],
  ] as const) {
    test(`refuses ${what}, naming the product`, () => {
      expect(() =>
        normaliseConfigEdits(edits as ConfigEdits, "spec-product"),
      ).toThrow(/\[wp\/config-edits\] spec-product's configEdits: /);
      expect(() =>
        normaliseConfigEdits(edits as ConfigEdits, "spec-product"),
      ).toThrow(message);
    });
  }

  test("accepts a replacement naming a declared capture, and money signs that are no reference", () => {
    expect(() =>
      normaliseConfigEdits(
        {
          files: [
            file(
              { replacement: "{{c}} costs $ 5" },
              { captures: [{ name: "c", pattern: "/a/", group: "1" }] },
            ),
          ],
        },
        "p",
      ),
    ).not.toThrow();
  });
});

test.describe("the engine's answers", () => {
  test("a record answer, with and without a reconciled record", () => {
    expect(
      parseRecordAnswer(
        'notice\n{"reconciled":null,"discarded":true,"swept":3}',
        EDITS,
      ),
    ).toEqual({
      blocked: undefined,
      reconciled: undefined,
      unusable: undefined,
      discarded: true,
      swept: 3,
      unswept: 0,
      held: false,
    });
    expect(
      parseRecordAnswer(
        '{"reconciled":[{"kind":"file","index":0,"result":"restored","mode":{"found":420,"recorded":416,"restored":false},"owner":{"found":"1:2","recorded":"3:4"}}],"discarded":false,"swept":0}',
        EDITS,
      ).reconciled,
    ).toEqual([
      {
        kind: "file",
        index: 0,
        result: "restored",
        mode: { found: 0o644, recorded: 0o640, restored: false },
        owner: { found: "1:2", recorded: "3:4" },
      },
    ]);
  });

  test("a restore answer: outcomes, or none", () => {
    const dir = "/tmp/e2e-record-0123456789abcdef-33";
    expect(parseRestoreAnswer(JSON.stringify({ blocked: dir }), EDITS)).toEqual(
      { kind: "blocked", dir },
    );
    expect(parseRecordAnswer(JSON.stringify({ blocked: dir }), EDITS)).toEqual({
      blocked: dir,
      reconciled: undefined,
      unusable: undefined,
      discarded: false,
      swept: 0,
      unswept: 0,
      held: false,
    });
    expect(
      parseRecordAnswer(
        '{"reconciled":null,"discarded":false,"swept":1,"unswept":2}',
        EDITS,
      ),
    ).toMatchObject({ swept: 1, unswept: 2 });
    // Only a folder the engine names: an absolute record path ending in its uid.
    for (const blocked of [
      "/tmp/e2e-record-0123456789abcdef",
      "e2e-record-0123456789abcdef-33",
      "/tmp/other-33",
      "/tmp/e2e-record-0123456789abcdef-33\n",
      33,
    ]) {
      expect(() =>
        parseRestoreAnswer(JSON.stringify({ blocked }), EDITS),
      ).toThrow(/unreadable/);
    }
    expect(() =>
      parseRecordAnswer(
        '{"reconciled":null,"discarded":false,"swept":0,"unswept":"x"}',
        EDITS,
      ),
    ).toThrow(/unreadable/);
    expect(parseRestoreAnswer('{"none":true}', EDITS)).toEqual({
      kind: "none",
    });
    expect(parseRestoreAnswer('{"unusable":"damaged"}', EDITS)).toEqual({
      kind: "unusable",
      reason: "damaged",
    });
    expect(
      parseRecordAnswer(
        '{"reconciled":null,"unusable":"other-root","discarded":false,"swept":0}',
        EDITS,
      ).unusable,
    ).toBe("other-root");
    expect(
      parseRestoreAnswer(
        '{"outcomes":[{"kind":"dir","index":0,"result":"not-empty"}]}',
        EDITS,
      ),
    ).toEqual({
      kind: "restored",
      outcomes: [{ kind: "dir", index: 0, result: "not-empty" }],
      held: false,
    });
  });

  for (const [what, answer] of [
    ["not JSON", "Fatal error"],
    ["no outcomes", '{"outcomes":3}'],
    ["an unknown unusable reason", '{"unusable":"tired"}'],
    [
      "an index past its list",
      '{"outcomes":[{"kind":"created-file","index":1,"result":"removed"}]}',
    ],
    [
      "a negative index",
      '{"outcomes":[{"kind":"file","index":-1,"result":"restored"}]}',
    ],
    [
      "a result of another kind",
      '{"outcomes":[{"kind":"dir","index":0,"result":"restored"}]}',
    ],
    [
      "an unknown kind",
      '{"outcomes":[{"kind":"other","index":0,"result":"kept"}]}',
    ],
    [
      "a mode out of range",
      '{"outcomes":[{"kind":"file","index":0,"result":"restored","mode":{"found":99999,"recorded":1,"restored":true}}]}',
    ],
    [
      "an owner that is no uid:gid",
      '{"outcomes":[{"kind":"file","index":0,"result":"restored","owner":{"found":"root","recorded":"1:1"}}]}',
    ],
  ] as const) {
    test(`refuses ${what}`, () => {
      expect(() => parseRestoreAnswer(answer, EDITS)).toThrow(
        /\[wp\/config-edits\] the engine answered something unreadable/,
      );
    });
  }

  test("a held outcome is read whole, and either answer says it held", () => {
    const outcome = {
      kind: "file",
      index: 0,
      result: "unwritable",
      held: HELD,
    };
    expect(
      parseRestoreAnswer(
        JSON.stringify({ outcomes: [outcome], held: true }),
        EDITS,
      ),
    ).toEqual({ kind: "restored", outcomes: [outcome], held: true });
    expect(
      parseRecordAnswer(
        JSON.stringify({
          reconciled: [outcome],
          unusable: null,
          discarded: false,
          swept: 0,
          unswept: 0,
          held: true,
        }),
        EDITS,
      ),
    ).toMatchObject({ reconciled: [outcome], held: true });
    // Only the mode left: a file whose bytes are as recorded.
    const modeOnly = {
      kind: "file",
      index: 0,
      result: "restored",
      held: MODE_ONLY,
    };
    expect(
      parseRestoreAnswer(JSON.stringify({ outcomes: [modeOnly] }), EDITS),
    ).toEqual({ kind: "restored", outcomes: [modeOnly], held: false });
    expect(() =>
      parseRestoreAnswer('{"outcomes":[],"held":"yes"}', EDITS),
    ).toThrow(/unreadable/);
    expect(() =>
      parseRecordAnswer(
        '{"reconciled":null,"discarded":false,"swept":0,"held":1}',
        EDITS,
      ),
    ).toThrow(/unreadable/);
  });

  for (const [what, outcome] of [
    ["held on a created file", { kind: "created-file", result: "unwritable" }],
    ["held bytes on a file not unwritable", { result: "unrecognized" }],
    ["a held mode on an unwritable file", { held: MODE_ONLY }],
    [
      "a held mode on a file left untouched",
      { result: "replaced", held: MODE_ONLY },
    ],
    [
      "a resumed mode alone",
      { result: "restored", held: { ...MODE_ONLY, resumed: true } },
    ],
    ["a folder of no record", { held: { ...HELD, dir: "/tmp/x-33" } }],
    [
      "a folder of another uid",
      { held: { ...HELD, dir: "/tmp/e2e-record-0123456789abcdef-34" } },
    ],
    ["a negative uid", { held: { ...HELD, uid: -1 } }],
    ["a copy outside the folder", { held: { ...HELD, copy: "../file-0" } }],
    ["a numeric inode", { held: { ...HELD, ino: 12 } }],
    ["a signed device", { held: { ...HELD, dev: "-1" } }],
    ["a short checksum", { held: { ...HELD, sha256: "ab" } }],
    ["no judged checksum", { held: { ...HELD, judged: undefined } }],
    ["a short judged checksum", { held: { ...HELD, judged: "cd" } }],
    [
      "a mode alone judged on other bytes than the record's",
      { result: "restored", held: { ...MODE_ONLY, judged: HELD.judged } },
    ],
    ["no mode", { held: { ...HELD, mode: 0o10000 } }],
    ["no write flag", { held: { ...HELD, write: "yes" } }],
    ["no resumed flag", { held: { ...HELD, resumed: null } }],
    ["not an object", { held: "file-0" }],
  ] as const) {
    test(`refuses a held outcome with ${what}`, () => {
      const entry = {
        kind: "file",
        index: 0,
        result: "unwritable",
        held: HELD,
        ...outcome,
      };
      expect(() =>
        parseRestoreAnswer(JSON.stringify({ outcomes: [entry] }), EDITS),
      ).toThrow(/unreadable/);
    });
  }

  test("refuses a record answer without its counts, and cuts what it quotes", () => {
    expect(() => parseRecordAnswer('{"reconciled":null}', EDITS)).toThrow(
      /unreadable/,
    );
    let message = "";
    try {
      parseRecordAnswer(`\u001b[31m${"x".repeat(500)}`, EDITS);
    } catch (error) {
      message = String(error);
    }
    expect(message).not.toContain("\u001b");
    expect(message.length).toBeLessThan(300);
  });
});

test.describe("configEditsReport", () => {
  test("is silent for what went back, warns for what was left, notes a mode set back", () => {
    const said = configEditsReport(
      [
        {
          kind: "file",
          index: 0,
          result: "restored",
          mode: { found: 0o644, recorded: 0o640, restored: true },
        },
        {
          kind: "file",
          index: 0,
          result: "unchanged",
          mode: { found: 0o600, recorded: 0o640, restored: false },
          owner: { found: "0:0", recorded: "33:33" },
        },
        { kind: "created-file", index: 0, result: "foreign" },
        { kind: "dir", index: 0, result: "removed" },
      ],
      EDITS,
    );
    expect(said.notes).toEqual([
      '"wp-config.php"\'s mode set back to 0640 (the scenario left 0644).',
    ]);
    expect(said.warnings).toEqual([
      '"wp-config.php"\'s mode is 0600, 0640 before the scenario: it could not be set back.',
      '"wp-config.php" is owned by 0:0 (uid:gid), 33:33 before the scenario: ownership is never changed here.',
      '"wp-content/advanced-cache.php" did not exist before the scenario and is not the plugin\'s (neither empty nor marked): left.',
    ]);
  });

  test("what root finished is noted, and said once; what it refused is a warning naming why", () => {
    const said = configEditsReport(
      [
        { kind: "file", index: 0, result: "restored", asRoot: "wrote" },
        {
          kind: "file",
          index: 0,
          result: "restored",
          asRoot: "wrote",
          mode: { found: 0o664, recorded: 0o644, restored: true },
        },
        {
          kind: "file",
          index: 0,
          result: "restored",
          asRoot: "mode",
          mode: { found: 0o664, recorded: 0o644, restored: true },
        },
        {
          kind: "file",
          index: 0,
          result: "unchanged",
          asRoot: "mode",
          mode: { found: 0o664, recorded: 0o644, restored: false },
        },
        { kind: "file", index: 0, result: "resumed", asRoot: "wrote" },
        { kind: "file", index: 0, result: "unwritable", asRoot: "refused" },
      ],
      EDITS,
    );
    expect(said.notes).toEqual([
      '"wp-config.php" put back as root: this run\'s commands cannot write it.',
      '"wp-config.php" put back as root: this run\'s commands cannot write it.',
      '"wp-config.php"\'s mode set back to 0644 as root (the scenario left 0664).',
      '"wp-config.php"\'s mode set back to 0644 as root (the scenario left 0664).',
    ]);
    expect(said.warnings).toEqual([
      '"wp-config.php"\'s mode is 0664, 0644 before the scenario: it could not be set back.',
      '"wp-config.php" was found cut short (a write interrupted part-way): put back in full from the record, as root.',
      "\"wp-config.php\" holds only the plugin's edits, but this run's commands cannot write it, and root would " +
        "not use its record copy (no longer this run's private, single-link file holding the recorded bytes): " +
        "left as it is.",
    ]);
    // A root that could not run, or wrote a file then moved away, is a warning of its own.
    expect(
      configEditsReport(
        [
          {
            kind: "file",
            index: 0,
            result: "unwritable",
            asRoot: "failed",
            rootError: "exit 1: sudo: a password is required",
          },
          { kind: "file", index: 0, result: "moved", asRoot: "wrote" },
        ],
        EDITS,
      ),
    ).toEqual({
      notes: [],
      warnings: [
        "\"wp-config.php\" holds only the plugin's edits, but this run's commands cannot write it: left as it is.",
        '"wp-config.php" could not be finished as root (exit 1: sudo: a password is required): left as ' +
          "this run's commands could leave it.",
        '"wp-config.php" was put back as root, but moved or replaced at its path right after: what is ' +
          "there now is left untouched.",
      ],
    });
    // Without the fallback, the words are as they always were.
    expect(outcomeMessage("unwritable", "p")).toBe(
      "\"p\" holds only the plugin's edits, but this run's commands cannot write it: left as it is.",
    );
    expect(outcomeMessage("resumed", "p", "mode")).toBe(
      '"p" was found cut short (a write interrupted part-way): put back in full from the record.',
    );
  });

  test("a record folder never used names itself, what that costs, and how to resume", () => {
    const dir = "/tmp/e2e-record-0123456789abcdef-33";
    expect(blockedMessage(dir, "before")).toBe(
      `the record folder ${dir} is not a private folder of this run's user (another user's, a link, or ` +
        "open to others), so it is never used: nothing was recorded, so the plugin's edits will stay " +
        "after this scenario. Remove it to resume.",
    );
    expect(blockedMessage(dir, "after")).toContain(
      "never used: nothing was put back.",
    );
  });

  test("a discarded record says why and that nothing was touched", () => {
    expect(unusableMessage("damaged")).toBe(
      "the record of them was discarded unused (a copy in it no longer matches its checksum): they are left as they were found.",
    );
    expect(unusableMessage("other-root")).toMatch(/another WordPress root/);
    expect(unusableMessage("unreadable")).toMatch(/index could not be read/);
  });

  test("every result that leaves a path says so; the normal ones say nothing", () => {
    for (const result of [
      "unrecognized",
      "unwritable",
      "resumed",
      "replaced",
      "missing",
      "link",
      "not-a-file",
      "not-a-dir",
      "appeared",
      "not-recorded",
      "changed",
      "foreign",
      "not-empty",
    ]) {
      expect(outcomeMessage(result, "p"), result).toMatch(/^"p" /);
    }
    for (const result of [
      "unchanged",
      "restored",
      "removed",
      "absent",
      "kept",
    ]) {
      expect(outcomeMessage(result, "p"), result).toBeUndefined();
    }
  });
});

test.describe("the record folder and the snippet", () => {
  const ssh: SshTransport = {
    mode: "ssh",
    host: "h",
    username: "u",
    privateKeyPath: "/k",
    rootDir: "/var/www/a",
  };

  test("is /tmp/e2e-record-<16 hex>, per install and per plugin", () => {
    const one = recordStemFor(ssh, "wp-rocket");
    expect(one).toMatch(/^\/tmp\/e2e-record-[0-9a-f]{16}$/);
    expect(recordStemFor(ssh, "wp-rocket")).toBe(one);
    expect(recordStemFor(ssh, "backwpup")).not.toBe(one);
    expect(
      recordStemFor({ ...ssh, rootDir: "/var/www/b" }, "wp-rocket"),
    ).not.toBe(one);
  });

  test("holds for root only when asked", () => {
    expect(configEditsPhp("restore", "/tmp/s", EDITS)).toContain(
      `$e2e_hold = ${phpLiteral(false)};`,
    );
    expect(configEditsPhp("record", "/tmp/s", EDITS, true)).toContain(
      `$e2e_hold = ${phpLiteral(true)};`,
    );
  });

  test("embeds every input as a literal: no declared text reaches the snippet raw", () => {
    const php = configEditsPhp(
      "restore",
      "/tmp/e2e-record-x'; system('id'); //",
      {
        files: [file({ replacement: "'); system('id'); //" })],
      },
    );
    expect(php).not.toContain("system('id')");
  });
});
