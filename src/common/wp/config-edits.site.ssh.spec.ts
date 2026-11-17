import { test, expect } from "@playwright/test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  recordConfigEdits,
  recordStemFor,
  restoreConfigEdits,
} from "./config-edits";
import { disposeConnections, installKey, resetElevationCaches } from "./exec";
import { phpLiteral } from "./php-literal";
import {
  registerSiteIdentityVerdicts,
  resetSiteIdentityCaches,
} from "./site-identity";
import { startSshServer, steerNodeSsh } from "../__fixtures__/ssh-server";
import type { SshTestServer } from "../__fixtures__/ssh-server";
import type { ConfigEdits, SshTransport } from "../config/types";

/**
 * Who may hold a file for root, at the record and restore steps' call sites: never in `site` (the
 * record is the web server's), else the engine holds, root runs, then the engine runs again without
 * holding. Over a server running what it is sent: a fake `wp` logs whether it was asked to hold and
 * answers held only then; a fake `timeout` (what root runs) logs and answers as the script does.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

const SLUG = "e2e-config-edits-spec";
const UID = 1000;

const EDITS: ConfigEdits = {
  files: [
    {
      path: "wp-config.php",
      operations: [
        { name: "op", steps: [{ pattern: "/a/", replacement: "b", limit: 1 }] },
      ],
    },
  ],
};

/** The fake `id`: www-data under `sudo -u`, else the transport's user. */
const FAKE_ID =
  'if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo "uid=33(www-data) gid=33(www-data) groups=33(www-data)"; ' +
  'else echo "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)"; fi';

/** Where the fakes log, one line per call: `<mode> hold=<bool>` or `root`. */
const log = (): string => join(server.base, "calls.log");

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  started.addProgram("stat", "echo 'www-data:www-data:33:33'");
  started.addProgram("id", FAKE_ID);
  started.addProgram("readlink", 'shift 2; printf "%s\\n" "$1"');
  // The snippet's own lines, as the engine is given them, tell the mode and whether it holds; any
  // other `wp` call (the identity's own checks) answers nothing.
  for (const [name, line] of [
    ["record", `$e2e_mode = ${phpLiteral("record")};`],
    ["restore", `$e2e_mode = ${phpLiteral("restore")};`],
    ["hold", `$e2e_hold = ${phpLiteral(true)};`],
  ]) {
    writeFileSync(join(started.base, `${String(name)}.pattern`), String(line));
  }
  started.addProgram(
    "wp",
    `B='${started.base}'; ` +
      `if printf '%s' "$*" | grep -qF -f "$B/record.pattern"; then m=record; ` +
      `elif printf '%s' "$*" | grep -qF -f "$B/restore.pattern"; then m=restore; else exit 0; fi; ` +
      `if printf '%s' "$*" | grep -qF -f "$B/hold.pattern"; then h=true; else h=false; fi; ` +
      `echo "$m hold=$h" >> "$B/calls.log"; cat "$B/answer-$m-$h.json"`,
  );
  started.addProgram(
    "timeout",
    `echo root >> '${join(started.base, "calls.log")}'; echo "664 644"`,
  );
  writeFileSync(join(started.root, "wp-config.php"), "b\n");
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetElevationCaches();
  rmSync(log(), { force: true });
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * Writes the fake engine's answers: held (and the record kept) only when asked to hold.
 *
 * @param transport - the site, whose record stem the held answer names.
 */
function answers(transport: SshTransport): void {
  const held = {
    kind: "file",
    index: 0,
    result: "unwritable",
    held: {
      dir: `${recordStemFor(transport, SLUG)}-${String(UID)}`,
      copy: "file-0",
      uid: UID,
      dev: "1",
      ino: "2",
      sha256: "a".repeat(64),
      judged: "c".repeat(64),
      mode: 0o644,
      write: true,
      resumed: false,
    },
  };
  const unchanged = { kind: "file", index: 0, result: "unchanged" };
  const record = (reconciled: unknown, more: object = {}) =>
    JSON.stringify({
      reconciled: [reconciled],
      unusable: null,
      discarded: false,
      swept: 0,
      ...more,
    });
  const files: Record<string, string> = {
    "record-true": record(held, { held: true }),
    "record-false": record(unchanged),
    "restore-true": JSON.stringify({ outcomes: [held], held: true }),
    "restore-false": JSON.stringify({ outcomes: [unchanged] }),
  };
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(server.base, `answer-${name}.json`), `${body}\n`);
  }
}

/** The fakes' log, one entry per call. */
function calls(): string[] {
  return readFileSync(log(), "utf8").trim().split("\n");
}

/** Root's put-back as the merge reports it: the bytes written, the mode set back. */
const BY_ROOT = {
  kind: "file",
  index: 0,
  result: "restored",
  mode: { found: 0o664, recorded: 0o644, restored: true },
  asRoot: "wrote",
};

test.describe("the in-place cleanup's root fallback, at its call sites", () => {
  test("in site neither step asks the engine to hold, so root never runs", async () => {
    const transport = server.transport({ runAs: "auto" });
    registerSiteIdentityVerdicts(
      new Map([
        [
          installKey(transport),
          {
            verdict: "owner-is-web",
            owner: { user: "www-data", group: "www-data", uid: 33, gid: 33 },
            web: {
              euid: 33,
              egid: 33,
              user: "www-data",
              group: "www-data",
              umask: "0022",
              sapi: "fpm-fcgi",
            },
          },
        ],
      ]),
    );
    answers(transport);

    expect(
      (await recordConfigEdits(transport, SLUG, EDITS)).reconciled,
    ).toEqual([{ kind: "file", index: 0, result: "unchanged" }]);
    expect(await restoreConfigEdits(transport, SLUG, EDITS)).toEqual({
      kind: "restored",
      held: false,
      outcomes: [{ kind: "file", index: 0, result: "unchanged" }],
    });
    expect(calls()).toEqual(["record hold=false", "restore hold=false"]);
  });

  test("outside site each step holds, root puts the file back, then the engine runs again without holding", async () => {
    const transport = server.transport({ runAs: false });
    answers(transport);

    const recorded = await recordConfigEdits(transport, SLUG, EDITS);
    expect(recorded.held).toBe(false);
    expect(recorded.reconciled).toEqual([BY_ROOT]);
    expect(await restoreConfigEdits(transport, SLUG, EDITS)).toEqual({
      kind: "restored",
      held: false,
      outcomes: [BY_ROOT],
    });
    expect(calls()).toEqual([
      "record hold=true",
      "root",
      "record hold=false",
      "restore hold=true",
      "root",
      "restore hold=false",
    ]);
  });

  test("with elevate: false nothing is held and root never runs", async () => {
    const transport = server.transport({ runAs: false, elevate: false });
    answers(transport);

    await recordConfigEdits(transport, SLUG, EDITS);
    await restoreConfigEdits(transport, SLUG, EDITS);
    expect(calls()).toEqual(["record hold=false", "restore hold=false"]);
  });
});
