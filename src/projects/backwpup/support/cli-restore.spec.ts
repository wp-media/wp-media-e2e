import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

import {
  CliRestore,
  RESTORE_PRECONDITIONS_PHP,
  contentKeptOut,
  isRestoreCommand,
  parseRestorePreconditions,
  restoreReach,
  restoreRefusal,
} from "./cli-restore";
import { FILE_MARKER_NAME } from "./markers";
import type { RestorePreconditions, RestoreSite } from "./cli-restore";
import type { SiteMarkers } from "./markers";
import type { DatabaseDefaults } from "./database-defaults";

/**
 * `wp backwpup restore`, run so a shared site is left as found: what each argv reaches, what must
 * hold before it may run, and — against recording fakes of the site, the command and the copy — the
 * order the guards run in, how each failure is handled, and how the scenario's runs are undone.
 */

const HAS_PHP = spawnSync("php", ["-v"]).status === 0;

test.describe("restoreReach", () => {
  test("defaults to both halves, as the command does", () => {
    expect(restoreReach(["restore", "/a.tar", "--yes"])).toEqual({
      files: true,
      database: true,
    });
  });

  test("reads --type", () => {
    expect(restoreReach(["restore", "--type=db"])).toEqual({
      files: false,
      database: true,
    });
    expect(restoreReach(["restore", "--type=file"])).toEqual({
      files: true,
      database: false,
    });
    expect(restoreReach(["restore", "--type=full"])).toEqual({
      files: true,
      database: true,
    });
  });

  // WP-CLI keeps the last of a repeated option.
  test("goes by the last --type, as WP-CLI does", () => {
    expect(restoreReach(["restore", "--type=file", "--type=db"])).toEqual({
      files: false,
      database: true,
    });
  });

  test("guards a type it does not know as both", () => {
    for (const argv of [
      ["restore", "--type=FILE"],
      ["restore", "--type", "file"],
      ["restore", "--type="],
    ]) {
      expect(restoreReach(argv), argv.join(" ")).toEqual({
        files: true,
        database: true,
      });
    }
  });
});

test.describe("isRestoreCommand", () => {
  test("is the restore and its alias, nothing else", () => {
    expect(isRestoreCommand(["restore", "x"])).toBe(true);
    expect(isRestoreCommand(["backup-restore", "x"])).toBe(true);
    for (const argv of [["backup", "restore"], ["job"], []]) {
      expect(isRestoreCommand(argv), argv.join(" ")).toBe(false);
    }
  });
});

test.describe("contentKeptOut", () => {
  test("leaves out the plugin under test, BackWPup's data as found, and the file marker", () => {
    expect(
      contentKeptOut("backwpup-pro", [
        "wp-content/uploads/backwpup",
        "wp-content/uploads/backwpup-restore-0123456789abcdef0123",
      ]),
    ).toEqual([
      "plugins/backwpup-pro",
      "uploads/backwpup",
      "uploads/backwpup-restore-0123456789abcdef0123",
      FILE_MARKER_NAME,
    ]);
  });

  test("ignores residue outside wp-content", () => {
    expect(contentKeptOut("backwpup", [".e2e_temp/x"])).toEqual([
      "plugins/backwpup",
      FILE_MARKER_NAME,
    ]);
  });
});

/** A site whose restore may run: plain layout, nothing beyond the prefix in its database. */
const CLEAN: RestorePreconditions = {
  root: "/var/www/site",
  content: "/var/www/site/wp-content",
  linked: false,
  foreign: [],
  routines: 0,
  events: 0,
  triggers: 0,
};

test.describe("parseRestorePreconditions", () => {
  test("reads the site's answer", () => {
    expect(parseRestorePreconditions(JSON.stringify(CLEAN))).toEqual(CLEAN);
  });

  // `realpath()` answers false for a path that is not there.
  for (const [label, reply] of [
    ["nothing", ""],
    ["an empty object", "{}"],
    [
      "a content directory realpath() could not find",
      JSON.stringify({ ...CLEAN, content: false }),
    ],
    [
      "a table name that is no string",
      JSON.stringify({ ...CLEAN, foreign: [1] }),
    ],
    ["a count that is no number", JSON.stringify({ ...CLEAN, events: "0" })],
  ] as const) {
    test(`refuses ${label}`, () => {
      expect(() => parseRestorePreconditions(reply)).toThrow(
        /unexpected answer/,
      );
    });
  }

  test("the snippet parses as PHP", () => {
    test.skip(!HAS_PHP, "no php binary on this machine");
    const result = spawnSync("php", ["-l"], {
      input: `<?php\n${RESTORE_PRECONDITIONS_PHP}`,
      encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});

test.describe("restoreRefusal", () => {
  const BOTH = { files: true, database: true };

  test("lets a plain site through", () => {
    expect(restoreRefusal(CLEAN, BOTH)).toBeUndefined();
  });

  // The copy is of <root>/wp-content; a relocated or linked one would leave the real one unguarded.
  test("refuses a files restore when wp-content is not where the copy looks", () => {
    for (const site of [
      { ...CLEAN, content: "/srv/content" },
      { ...CLEAN, linked: true },
    ]) {
      expect(restoreRefusal(site, { files: true, database: false })).toMatch(
        /copy taken first would guard the wrong directory/,
      );
      expect(
        restoreRefusal(site, { files: false, database: true }),
      ).toBeUndefined();
    }
  });

  // `wp db reset` drops the whole database; BackWPup dumps only the site's prefixed tables.
  test("refuses a database restore when the database holds what the backup cannot bring back", () => {
    const refusal = restoreRefusal(
      {
        ...CLEAN,
        foreign: ["other_users", "v_report"],
        routines: 1,
        events: 2,
        triggers: 3,
      },
      { files: false, database: true },
    );
    expect(refusal).toMatch(
      /2 table\(s\) or view\(s\) outside the site's own \(other_users, v_report\), 1 routine\(s\), 2 event\(s\), 3 trigger\(s\), which `wp db reset` would drop/,
    );
    expect(
      restoreRefusal(
        { ...CLEAN, triggers: 1 },
        { files: true, database: false },
      ),
    ).toBeUndefined();
  });
});

/** Recording fakes of everything a run touches, sharing one call log. */
function rig(
  options: {
    readonly preconditions?: RestorePreconditions;
    readonly command?: () => Promise<void>;
    readonly restoreDefaults?: () => Promise<void>;
    readonly listings?: readonly (readonly string[])[];
    readonly holds?: Record<string, { file: boolean; database: boolean }>;
    readonly putBack?: () => Promise<void>;
    readonly stamp?: () => Promise<void>;
  } = {},
): { calls: string[]; restore: CliRestore; site: RestoreSite } {
  const calls: string[] = [];
  const listings = [...(options.listings ?? [])];
  const site: RestoreSite = {
    preconditions: () => {
      calls.push("preconditions");
      return Promise.resolve(options.preconditions ?? CLEAN);
    },
    readDatabaseDefaults: () => {
      calls.push("read defaults");
      return Promise.resolve({
        charset: "utf8mb4",
        collation: "utf8mb4_general_ci",
      });
    },
    restoreDatabaseDefaults: () => {
      calls.push("restore defaults");
      return options.restoreDefaults?.() ?? Promise.resolve();
    },
    listSnapshots: () => {
      calls.push("list snapshots");
      return Promise.resolve({
        dir: "/tmp/",
        snapshots: listings.shift() ?? [],
      });
    },
    snapshotHolds: (snapshot) =>
      Promise.resolve(
        options.holds?.[snapshot] ?? { file: false, database: false },
      ),
    removeSnapshot: (snapshot) => {
      calls.push(`remove ${snapshot}`);
      return Promise.resolve();
    },
  };
  let kept = false;
  const content = {
    get kept() {
      return kept;
    },
    keep: () => {
      calls.push("keep");
      kept = true;
      return Promise.resolve();
    },
    keepDatabaseDefaults: (defaults: DatabaseDefaults) => {
      calls.push(`keep defaults ${defaults.collation}`);
      return Promise.resolve();
    },
    stamp: () => {
      calls.push("stamp");
      return options.stamp?.() ?? Promise.resolve();
    },
    putBack: async () => {
      calls.push("put back");
      await (options.putBack?.() ?? Promise.resolve());
      kept = false;
    },
  };
  const cli = {
    run: async (argv: readonly string[]) => {
      calls.push(`run ${argv.join(" ")}`);
      await (options.command?.() ?? Promise.resolve());
      return { exitCode: 0, stdout: "", stderr: "", notices: [] } as never;
    },
  };
  const changed = {
    values: { file: "changed-file", database: "changed-db" } as SiteMarkers,
  };
  return {
    calls,
    site,
    restore: new CliRestore(site, cli, content, changed, 200),
  };
}

const SNAP = "/tmp/backwpup-snapshot-6ac41.559";

test.describe("CliRestore — running", () => {
  // The copy is the guard, so it comes before the command — every time files are reached.
  test("guards a full restore in order: refusal checked, copy taken, defaults read, snapshots listed — then the command", async () => {
    const { calls, restore } = rig();
    await restore.run(["restore", "/a.tar", "--yes"]);
    expect(calls).toEqual([
      "preconditions",
      "keep",
      "read defaults",
      "keep defaults utf8mb4_general_ci",
      "list snapshots",
      "stamp",
      "run restore /a.tar --yes",
      "list snapshots",
      "restore defaults",
    ]);
  });

  test("takes no copy for a database restore, and leaves the defaults alone for a files one", async () => {
    const db = rig();
    await db.restore.run(["restore", "--type=db"]);
    expect(db.calls).not.toContain("keep");
    expect(db.calls).toContain("keep defaults utf8mb4_general_ci");
    const files = rig();
    await files.restore.run(["restore", "--type=file"]);
    expect(files.calls).not.toContain("read defaults");
    expect(files.calls.some((call) => call.startsWith("keep defaults"))).toBe(
      false,
    );
    expect(files.calls).not.toContain("restore defaults");
  });

  // Unstamped, a reboot during the command would leave a copy no later run could prove orphaned.
  test("runs no command over a copy it could not stamp, and still puts the copy back", async () => {
    const { calls, restore } = rig({
      stamp: () => Promise.reject(new Error("could not stamp")),
    });
    await expect(restore.run(["restore", "/a.tar"])).rejects.toThrow(
      "could not stamp",
    );
    expect(calls.some((call) => call.startsWith("run "))).toBe(false);
    await restore.release();
    expect(calls).toContain("put back");
  });

  test("refuses a site that would lose what the backup cannot bring back, running nothing", async () => {
    const { calls, restore } = rig({
      preconditions: { ...CLEAN, foreign: ["other_users"] },
    });
    await expect(restore.run(["restore", "--type=db"])).rejects.toThrow(
      /refusing to run `wp backwpup restore` on this site: its database holds 1 table/,
    );
    expect(calls).toEqual(["preconditions"]);
  });

  test("refuses an argv that is not a restore, running nothing", async () => {
    const { calls, restore } = rig();
    await expect(restore.run(["backup", "--yes"])).rejects.toThrow(
      /expected a `restore` command, got `backup`/,
    );
    expect(calls).toEqual([]);
  });

  // The command failing is what matters most, so it is what the step reports — and the site is still
  // put right behind it.
  test("still sets the defaults back and notes snapshots when the command fails, then reports the command", async () => {
    const { calls, restore } = rig({
      command: () => Promise.reject(new Error("the transport dropped")),
      restoreDefaults: () => Promise.reject(new Error("ALTER failed")),
    });
    await expect(restore.run(["restore"])).rejects.toThrow(
      "the transport dropped",
    );
    expect(calls.slice(-2)).toEqual(["list snapshots", "restore defaults"]);
  });

  // Measured before the isolation: a defaults failure skipped the snapshot listing, and the
  // world-readable export it would have removed stayed in /tmp.
  test("notes the snapshots even when setting the defaults back fails, and reports that failure", async () => {
    const { calls, restore } = rig({
      restoreDefaults: () => Promise.reject(new Error("ALTER failed")),
      listings: [[], [SNAP]],
      holds: { [SNAP]: { file: true, database: true } },
    });
    await expect(restore.run(["restore", "--pre-backup"])).rejects.toThrow(
      "ALTER failed",
    );
    await restore.release();
    expect(calls).toContain(`remove ${SNAP}`);
  });
});

test.describe("CliRestore — after the command, each duty on its own", () => {
  test("sets the defaults back even when the snapshots cannot be listed, and reports that", async () => {
    let listed = 0;
    const { calls, restore, site } = rig();
    const list = site.listSnapshots.bind(site);
    site.listSnapshots = () =>
      ++listed === 2 ? Promise.reject(new Error("no listing")) : list();
    await expect(restore.run(["restore"])).rejects.toThrow("no listing");
    expect(calls.at(-1)).toBe("restore defaults");
  });
});

test.describe("CliRestore — snapshots", () => {
  const OURS = SNAP;
  const SHORT = "/tmp/backwpup-snapshot-6ac42.1";
  const THEIRS = "/tmp/backwpup-snapshot-6ac43.2";
  const BEFORE = "/tmp/backwpup-snapshot-6ac40.9";

  // Any run may make one — WP-CLI reads `--no-pre-backup` as set — so every run is watched.
  test("are watched on every run, not only one asking for them", async () => {
    const { restore } = rig({
      listings: [[], [OURS]],
      holds: { [OURS]: { file: true, database: true } },
    });
    await restore.run(["restore", "--no-pre-backup"]);
    expect(await restore.snapshots()).toEqual([OURS]);
  });

  // One cut short after its export holds only the database marker; another run's holds neither.
  test("are this scenario's by either changed marker, never by having appeared", async () => {
    const { calls, restore } = rig({
      listings: [[BEFORE], [BEFORE, OURS, SHORT, THEIRS]],
      holds: {
        [OURS]: { file: true, database: true },
        [SHORT]: { file: false, database: true },
      },
    });
    await restore.run(["restore", "--pre-backup"]);
    expect(await restore.snapshots()).toEqual([OURS, SHORT]);
    await restore.release();
    expect(calls.filter((call) => call.startsWith("remove"))).toEqual([
      `remove ${OURS}`,
      `remove ${SHORT}`,
    ]);
  });
});

test.describe("CliRestore — release", () => {
  test("puts the content back, then removes the scenario's snapshots", async () => {
    const { calls, restore } = rig({
      listings: [[], [SNAP]],
      holds: { [SNAP]: { file: true, database: false } },
    });
    await restore.run(["restore"]);
    await restore.release();
    expect(calls.slice(-2)).toEqual(["put back", `remove ${SNAP}`]);
  });

  test("still removes the snapshots when the content will not go back, then reports it", async () => {
    const { calls, restore } = rig({
      listings: [[], [SNAP]],
      holds: { [SNAP]: { file: true, database: true } },
      putBack: () => Promise.reject(new Error("tar exited 2")),
    });
    await restore.run(["restore"]);
    await expect(restore.release()).rejects.toThrow("tar exited 2");
    expect(calls).toContain(`remove ${SNAP}`);
  });

  // A timed-out step leaves its command running on the site; putting wp-content back under it would
  // leave neither as found.
  test("waits for a run still in flight before putting anything back", async () => {
    let finish: () => void = () => undefined;
    const { calls, restore } = rig({
      command: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const abandoned = restore.run(["restore"]);
    const released = restore.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).not.toContain("put back");
    finish();
    await abandoned;
    await released;
    expect(calls.indexOf("put back")).toBeGreaterThan(
      calls.indexOf("restore defaults"),
    );
  });

  test("puts nothing back when the run is still in flight after the bound, and says so", async () => {
    const { calls, restore } = rig({
      command: () => new Promise(() => undefined),
    });
    void restore.run(["restore"]);
    await expect(restore.release()).rejects.toThrow(
      /still running .* after its step ended, so nothing was put back.*The copy of wp-content stays/s,
    );
    expect(calls).not.toContain("put back");
  });
});
