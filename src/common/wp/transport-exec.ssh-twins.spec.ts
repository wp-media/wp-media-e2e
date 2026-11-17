import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";

import {
  assertAllResolvedInsideRoot,
  disposeConnections,
  execAsTransport,
  wpRootDir,
} from "./transport-exec";
import {
  SSH_TWINS_SKIP_REASON,
  TWIN_CELLS,
  sshTwinsEnabled,
  twinSite,
  withTwin,
} from "../__fixtures__/ssh-twins";

/**
 * The resolved-path guard through the real transport on both twins (Ubuntu 24.04, GNU coreutils), in
 * their resting variant: what the SSH user cannot search, root (passwordless `sudo` there) resolves —
 * a link in the docroot to a folder under `/root` is refused as leading out, the link and every path
 * beneath it, and a path under a `0700` folder of `www-data`'s passes; without elevation that path is
 * refused, naming the host's prerequisite. A path not created yet passes. Opt-in
 * (`E2E_SSH_TWINS=1`, twins up).
 */

/** A folder of the docroot this spec owns. */
const FOLDER = "e2e-resolve-spec";

/** The folder under `/root` the link leads to. */
const OUTSIDE = "/root/e2e-resolve-outside";

/** The rejection's text, as is. */
const asIs = (reason: string): string => reason;

/**
 * Runs a shell line as root in a twin.
 *
 * @param stack - which twin.
 * @param line - the `sh -c` line; `$1…` are `args`.
 * @param args - its arguments.
 * @returns its stdout, trimmed.
 */
function asRoot(stack: string, line: string, ...args: string[]): string {
  return execFileSync(
    "docker",
    ["exec", `wpme-ssh-${stack}`, "sh", "-c", line, "sh", ...args],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 },
  ).trim();
}

test.describe("SSH twins: the resolved-path guard", () => {
  test.skip(!sshTwinsEnabled(), SSH_TWINS_SKIP_REASON);

  for (const twin of TWIN_CELLS.filter(
    (cell) => cell.product === "wp-rocket",
  )) {
    test(`${twin.stack}: root resolves what the SSH user cannot search: a link into /root refused, a private folder's path passed`, async () => {
      const transport = twinSite(twin).transport;
      await withTwin(twin.stack, async () => {
        const root = await wpRootDir(transport);
        const folder = `${root}/${FOLDER}`;
        try {
          asRoot(
            twin.stack,
            'rm -rf -- "$1" "$2" && mkdir -p -- "$1/private/data" "$2/x" && ln -s "$2/x" "$1/link" && chown -R www-data:www-data -- "$1/private" && chmod 700 -- "$1/private"',
            folder,
            OUTSIDE,
          );
          // The premise: the SSH user's `readlink -f` cannot resolve either (EACCES), root can.
          for (const path of [
            `${folder}/link/sub`,
            `${folder}/private/data/x`,
          ]) {
            const { exitCode } = await execAsTransport(transport, "readlink", [
              "-f",
              "--",
              path,
            ]);
            expect(exitCode, path).not.toBe(0);
          }

          for (const target of [
            `${folder}/link`,
            `${folder}/link/sub`,
            `${folder}/link/sub/deeper`,
          ]) {
            await expect(
              assertAllResolvedInsideRoot(transport, [target], root, asIs),
            ).rejects.toThrow(
              /really resolves to "\/root\/[^"]*", which is outside it/,
            );
          }
          await expect(
            assertAllResolvedInsideRoot(
              transport,
              [`${folder}/private/data/x`],
              root,
              asIs,
            ),
          ).resolves.toBe(root);
          await expect(
            assertAllResolvedInsideRoot(
              { ...transport, elevate: false },
              [`${folder}/private/data/x`],
              root,
              asIs,
            ),
          ).rejects.toThrow(
            /cannot be searched by the transport's user, so .*passwordless `sudo`/,
          );
          await expect(
            assertAllResolvedInsideRoot(
              transport,
              [`${folder}/new`, `${folder}/a/b/c`],
              root,
              asIs,
            ),
          ).resolves.toBe(root);
        } finally {
          asRoot(twin.stack, 'rm -rf -- "$1" "$2"', folder, OUTSIDE);
          disposeConnections();
        }
      });
    });
  }
});
