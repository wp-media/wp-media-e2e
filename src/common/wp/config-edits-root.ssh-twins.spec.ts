import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

import { putBackHeld } from "./config-edits-root";
import { recordStemFor } from "./config-edits";
import {
  disposeConnections,
  resetElevationCaches,
  wpRootDir,
} from "./transport-exec";
import {
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  sshTwinsEnabled,
  twinSite,
  withTwin,
} from "../__fixtures__/ssh-twins";
import type { HeldPutBack } from "./config-edits-declaration";
import type { ConfigEdits, Transport } from "../config/types";

/**
 * The root fallback through the real transport on the nginx twin (in its resting variant): `sudo`
 * over SSH, the resolved-path check, the script. The record is ubuntu's (the transport's user, as
 * outside `site`), the file the web server's. Opt-in (`E2E_SSH_TWINS=1`, twins up).
 */

/** WP Rocket's nginx cell: any twin site with sudo would do. */
const TWIN = TWIN_CELLS.find((cell) => cell.cell === "twin-nginx");

/** A folder of the docroot this spec owns, and the declared file in it. */
const FOLDER = "e2e-put-back-spec";
const EDITS: ConfigEdits = {
  files: [
    {
      path: `${FOLDER}/conf.txt`,
      operations: [
        { name: "op", steps: [{ pattern: "/a/", replacement: "b", limit: 1 }] },
      ],
    },
  ],
};

/** Runs a shell line as root in the twin; its stdout, trimmed. */
function asRoot(line: string, ...args: string[]): string {
  return execFileSync(
    "docker",
    ["exec", "wpme-ssh-nginx", "sh", "-c", line, "sh", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  ).trim();
}

/**
 * Makes the record (ubuntu's `0700` folder at the stem, its copy `recorded\n`) and the file
 * `edited\n` (www-data's, 664) at `filePath`; returns what the engine would hold.
 */
function arrange(stem: string, filePath: string): HeldPutBack {
  const [uid, dev, ino, sha256, judged] = asRoot(
    'uid=$(id -u ubuntu); d="$1-$uid"; rm -rf -- "$d"; install -d -o ubuntu -g ubuntu -m 0700 "$d" && ' +
      'printf "recorded\\n" > "$d/file-0" && chown ubuntu:ubuntu "$d/file-0" && chmod 600 "$d/file-0" && ' +
      'printf "edited\\n" > "$2" && chown www-data:www-data "$2" && chmod 664 "$2" && ' +
      'echo "$uid $(stat -c "%d %i" -- "$2") $(sha256sum < "$d/file-0" | cut -c1-64) $(sha256sum < "$2" | cut -c1-64)"',
    stem,
    filePath,
  ).split(" ");
  return {
    dir: `${stem}-${String(uid)}`,
    copy: "file-0",
    uid: Number(uid),
    dev: dev ?? "",
    ino: ino ?? "",
    sha256: sha256 ?? "",
    judged: judged ?? "",
    mode: 0o644,
    write: true,
    resumed: false,
  };
}

test.describe("SSH twins: the root put-back", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);

  test("writes the record's bytes into the web server's file in place; refuses a path leading out of the root", async () => {
    if (TWIN === undefined) throw new Error("no twin-nginx cell");
    const transport: Transport = twinSite(TWIN).transport;
    const stem = recordStemFor(transport, "e2e-put-back-spec");
    await withTwin(TWIN.stack, async () => {
      resetElevationCaches();
      const root = await wpRootDir(transport);
      const folder = `${root}/${FOLDER}`;
      const file = `${folder}/conf.txt`;
      try {
        asRoot('mkdir -p -- "$1"', folder);
        const held = arrange(stem, file);
        const inode = asRoot('stat -c %i -- "$1"', file);
        expect(
          await putBackHeld(transport, stem, EDITS, [
            { kind: "file", index: 0, result: "unwritable", held },
          ]),
        ).toEqual(new Map([[0, { kind: "done", found: 0o664, now: 0o644 }]]));
        expect(
          asRoot(
            'echo "$(stat -c "%i %U:%G %a" -- "$1") $(cat -- "$1")"',
            file,
          ),
        ).toBe(`${inode} www-data:www-data 644 recorded`);
        // The record folder stays ubuntu's 0700: root read it, never loosened it.
        expect(asRoot('stat -c "%U %a" -- "$1"', held.dir)).toBe("ubuntu 700");

        // The same declared path, its folder now a link out of the root: refused before any write.
        asRoot(
          'rm -rf -- "$1" /root/e2e-put-back-outside && mkdir /root/e2e-put-back-outside && ln -s /root/e2e-put-back-outside "$1"',
          folder,
        );
        const outside = arrange(stem, "/root/e2e-put-back-outside/conf.txt");
        expect(
          await putBackHeld(transport, stem, EDITS, [
            { kind: "file", index: 0, result: "unwritable", held: outside },
          ]),
        ).toEqual(new Map([[0, { kind: "outside" }]]));
        expect(asRoot("cat /root/e2e-put-back-outside/conf.txt")).toBe(
          "edited",
        );
      } finally {
        asRoot(
          'rm -rf -- "$1" /root/e2e-put-back-outside "$2"-*',
          folder,
          stem,
        );
        disposeConnections();
      }
    });
  });

  test("refuses a record copy another user owns inside the identity's own folder, leaving the file untouched", async () => {
    if (TWIN === undefined) throw new Error("no twin-nginx cell");
    const transport: Transport = twinSite(TWIN).transport;
    const stem = recordStemFor(transport, "e2e-put-back-spec");
    await withTwin(TWIN.stack, async () => {
      resetElevationCaches();
      const root = await wpRootDir(transport);
      const folder = `${root}/${FOLDER}`;
      const file = `${folder}/conf.txt`;
      try {
        asRoot('mkdir -p -- "$1"', folder);
        const held = arrange(stem, file);
        // The folder stays ubuntu's 0700; only the copy changes hands, its bytes (SHA-256) kept.
        asRoot('chown www-data:www-data -- "$1/$2"', held.dir, held.copy);
        expect(
          await putBackHeld(transport, stem, EDITS, [
            { kind: "file", index: 0, result: "unwritable", held },
          ]),
        ).toEqual(new Map([[0, { kind: "refused" }]]));
        expect(
          asRoot('echo "$(stat -c "%U:%G %a" -- "$1") $(cat -- "$1")"', file),
        ).toBe("www-data:www-data 664 edited");
      } finally {
        asRoot('rm -rf -- "$1" "$2"-*', folder, stem);
        disposeConnections();
      }
    });
  });
});
