import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  OUTSIDE_MAX_AGE_MINUTES,
  PrivateFolder,
  privateFolderHome,
} from "./private-folder";
import { disposeConnections } from "../../../common/wp/exec";
import {
  asTransportUser,
  resetSiteIdentityCaches,
} from "../../../common/wp/site-identity";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../../../common/__fixtures__/ssh-server";

/**
 * The private folder in the `site` identity state, over a server that runs what it is sent: it leaves
 * the docroot for `/tmp`, and is made, removed and swept as the identity (`sudo -u`), never as the
 * SSH user or root. The fake `sudo` records every call.
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];

const WWW_ID = "uid=33(www-data) gid=82(web) groups=82(web)";
const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  // `id` answers as the identity `sudo -u` asked for, else as the transport's user.
  started.addProgram(
    "id",
    `if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`,
  );
  started.addProgram("stat", "echo 'www-data:web:33:82'");
  answerPrepared("/nowhere");
});

/**
 * The fake `wp`: `--info` for the run probe; any snippet answered as the preparing one, with `path`.
 *
 * @param path - the folder's real path the site reports.
 */
function answerPrepared(path: string): void {
  server.addProgram(
    "wp",
    `if [ "$1" = --info ]; then echo 'WP-CLI 2.12.0'; exit 0; fi
printf '{"mode":"700","path":"%s","cwd":"%s"}' '${path}' "$PWD"`,
  );
}

test.beforeEach(() => {
  resetSiteIdentityCaches();
});

test.afterEach(() => {
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/** The program each call from index `from` on ran as the site (`sudo -u`, the wrapper's command). */
const siteProgramsSince = (from: number): string[] =>
  server
    .sudoCalls()
    .slice(from)
    .filter((argv) => argv.includes("-u"))
    .map((argv) => argv[argv.indexOf("e2e-run-as") + 3] ?? "");

test("in the site state the folder lives in /tmp; as the SSH user, in the staging area", async () => {
  const transport = server.transport({ runAs: "www-data:web" });

  expect(await privateFolderHome(transport)).toEqual({
    kind: "outside",
    root: "/tmp",
  });
  expect(await privateFolderHome(asTransportUser(transport))).toEqual({
    kind: "staging",
  });
});

test("made, removed and swept as the identity, with nothing as root", async () => {
  const transport = server.transport({ runAs: "www-data:web" });
  const outsideRoot = mkdtempSync(join(server.base, "outside-"));
  const own = join(outsideRoot, "e2e-private-abc-r0");
  const folder = new PrivateFolder(transport, "abc-r0", () =>
    Promise.resolve({ kind: "outside", root: outsideRoot }),
  );
  await privateFolderHome(transport);
  const from = server.sudoCalls().length;
  answerPrepared(own);
  try {
    const relative = await folder.relativePath();
    mkdirSync(own);

    await folder.release();

    expect(relative).toMatch(/e2e-private-abc-r0$/);
    expect(existsSync(own)).toBe(false);
    expect(siteProgramsSince(from)).toEqual(["wp", "rm", "sh"]);
    // The sweep is told the folder and the age past which another run's folder counts as left.
    const sweep = server
      .sudoCalls()
      .slice(from)
      .find((argv) => argv.includes("e2e-private-sweep"));
    expect(sweep?.slice(-3)).toEqual([
      "e2e-private-sweep",
      outsideRoot,
      String(OUTSIDE_MAX_AGE_MINUTES),
    ]);
    expect(
      server
        .sudoCalls()
        .slice(from)
        .filter((argv) => !argv.includes("-u")),
    ).toEqual([]);
  } finally {
    rmSync(outsideRoot, { recursive: true, force: true });
  }
});
