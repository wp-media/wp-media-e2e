import { test, expect } from "@playwright/test";
import {
  appendFileSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { disposeConnections } from "./exec";
import {
  OUTPUTS_CHECK_SCRIPT,
  recordInstallOutputs,
  settleInstallOutputs,
} from "./install-outputs";
import { resetOwnershipCaches } from "./ownership";
import { resetSiteIdentityCaches, resolveSiteIdentity } from "./site-identity";
import {
  startSshServer,
  steerNodeSsh,
  type SshTestServer,
} from "../__fixtures__/ssh-server";
import type { Transport } from "../config/types";

/**
 * Install outputs over a server that runs what it is sent: one batched check before the install, one
 * after, and only what appeared in between is handed over (as root, through the ownership handover)
 * or, in the `site` state, verified with no root call. The fake `stat` answers per path, so an output
 * owned by someone else shows; the fake `sudo` records every call (root: no `-u`).
 */

let server: SshTestServer;
/** What `afterAll` undoes, newest first. */
const teardown: (() => void | Promise<void>)[] = [];
let warnings: string[];
let realWarn: typeof console.warn;

const WWW_ID = "uid=33(www-data) gid=82(web) groups=82(web)";
const UBUNTU_ID = "uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu)";

/** The declared outputs: a file, a shared parent, two children of it, a folder of their own. */
const OUTPUTS = [
  "wp-content/advanced-cache.php",
  "wp-content/cache",
  "wp-content/cache/e2e-pages",
  "wp-content/cache/e2e-min",
  "wp-content/e2e-config",
] as const;

test.beforeAll(async () => {
  const started = await startSshServer();
  server = started;
  teardown.push(() => started.close());
  teardown.push(steerNodeSsh(() => ({ port: started.port })));
  started.addProgram(
    "id",
    `if [ -n "$E2E_FAKE_SUDO_USER" ]; then echo '${WWW_ID}'; else echo '${UBUNTU_ID}'; fi`,
  );
  started.addProgram("wp", "echo 'WP-CLI 2.12.0'");
  // Root's `chown` cannot run here; the fake `stat` then reads the target's owner back.
  started.addProgram("chown", "exit 0");
  // `stat -c FMT [--] PATH`: a path given an answer in `owners` (`<answer> <path>` lines, see
  // `ownedBy`) gets it, `-` failing as an unreadable one does; every other is www-data's; a missing
  // one fails as stat does.
  const owners = join(started.base, "owners");
  started.addProgram(
    "stat",
    `for p do :; done
[ -e "$p" ] || [ -h "$p" ] || { echo "stat: cannot statx '$p'" >&2; exit 1; }
answer=$([ -e '${owners}' ] && awk -v p="$p" 'substr($0, index($0, " ") + 1) == p { print substr($0, 1, index($0, " ") - 1) }' '${owners}')
[ "$answer" = - ] && { echo "stat: cannot read '$p'" >&2; exit 1; }
echo "\${answer:-www-data:web:33:82}"`,
  );
});

test.beforeEach(() => {
  resetSiteIdentityCaches();
  resetOwnershipCaches();
  server.denySudo(false);
  rmSync(join(server.base, "owners"), { force: true });
  server.addProgram("chown", "exit 0");
  rmSync(join(server.root, "wp-content"), { recursive: true, force: true });
  mkdirSync(join(server.root, "wp-content", "plugins"), { recursive: true });
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
});

test.afterEach(() => {
  console.warn = realWarn;
  disposeConnections();
});

test.afterAll(async () => {
  for (const undo of teardown.splice(0).reverse()) await undo();
});

/**
 * Makes the fake `stat` answer `answer` for `relative`.
 *
 * @param relative - a path under the root.
 * @param answer - `user:group:uid:gid`, or `-` for a `stat` that fails (an unreadable owner).
 */
function ownedBy(relative: string, answer: string): void {
  appendFileSync(
    join(server.base, "owners"),
    `${answer} ${join(server.root, relative)}\n`,
  );
}

/** Creates `relative` under the root: a folder, or a file when it ends in `.php`. */
function create(relative: string): void {
  const path = join(server.root, relative);
  if (relative.endsWith(".php")) writeFileSync(path, "<?php");
  else mkdirSync(path, { recursive: true });
}

/** The root paths `chown` was run on since index `from` of the fake sudo's calls. */
function chownedSince(from: number): string[] {
  return server
    .sudoCalls()
    .slice(from)
    .filter((argv) => !argv.includes("-u") && argv.includes("chown"))
    .map((argv) => argv.at(-1) ?? "");
}

/** Every root call since index `from` (`sudo -n true` included). */
function rootCallsSince(from: number): string[][] {
  return server
    .sudoCalls()
    .slice(from)
    .filter((argv) => !argv.includes("-u"));
}

/**
 * Records, runs `install` (what activation does), settles: the module's whole cycle.
 *
 * @param transport - the site.
 * @param install - what the install writes.
 */
async function cycle(
  transport: Transport,
  install: () => void,
): Promise<Awaited<ReturnType<typeof settleInstallOutputs>>> {
  const before = await recordInstallOutputs(transport, OUTPUTS);
  install();
  return settleInstallOutputs(transport, before);
}

test.describe("no declared outputs", () => {
  test("sends no command, before or after", async () => {
    const transport = server.transport();
    const sent = server.commands.length;
    const sudo = server.sudoCalls().length;

    const before = await recordInstallOutputs(transport, []);
    await expect(settleInstallOutputs(transport, before)).resolves.toEqual([]);

    expect(server.commands.length).toBe(sent);
    expect(server.sudoCalls().length).toBe(sudo);
  });
});

test.describe("the check", () => {
  test("passes each output as its own absolute argument, never inside the script", async () => {
    const transport = server.transport();
    const sent = server.commands.length;
    await recordInstallOutputs(transport, ["wp-content/a b$(id)'c"]);

    const [line] = server.commands.slice(sent);
    // The script is one quoted word, the path another: the shell parses neither.
    expect(line).toContain(`'${OUTPUTS_CHECK_SCRIPT.split("\n")[0] ?? ""}`);
    expect(line).toContain(`'${server.root}/wp-content/a b$(id)'\\''c'`);
    expect(server.commands.length).toBe(sent + 1);
  });

  test("a failed check before the install hands nothing over, and says so", async () => {
    const transport = server.transport();
    server.addProgram("sh", "exit 3");
    try {
      const before = await recordInstallOutputs(transport, OUTPUTS);
      expect(before).toBeUndefined();
      const from = server.sudoCalls().length;
      create("wp-content/e2e-config");
      server.removeProgram("sh");
      await expect(settleInstallOutputs(transport, before)).resolves.toEqual(
        [],
      );
      expect(rootCallsSince(from)).toEqual([]);
    } finally {
      server.removeProgram("sh");
    }
    expect(warnings.join("\n")).toMatch(
      /\[wp\/install-outputs\].*exist before the install \(its check exited non-zero\), so none was handed over/,
    );
  });

  test("a failed check after the install hands nothing over, and says so", async () => {
    const transport = server.transport();
    const before = await recordInstallOutputs(transport, OUTPUTS);
    create("wp-content/e2e-config");
    server.addProgram("sh", "exit 3");
    try {
      const from = server.sudoCalls().length;
      await expect(settleInstallOutputs(transport, before)).resolves.toEqual(
        [],
      );
      expect(rootCallsSince(from)).toEqual([]);
    } finally {
      server.removeProgram("sh");
    }
    expect(warnings.join("\n")).toMatch(/exist after the install/);
  });
});

test.describe("a check that cannot run", () => {
  // `exec` makes the shell the command: killing itself, it ends the command by SIGKILL, which every
  // transport throws as a killed command — the throw both catches must turn into a warning.
  const KILLED_SH = "kill -9 $$";

  test("before the install: resolves undefined, warns, and nothing runs as root", async () => {
    const transport = server.transport();
    server.addProgram("sh", KILLED_SH);
    let before: Awaited<ReturnType<typeof recordInstallOutputs>>;
    try {
      before = await recordInstallOutputs(transport, OUTPUTS);
    } finally {
      server.removeProgram("sh");
    }
    expect(before).toBeUndefined();
    const from = server.sudoCalls().length;
    create("wp-content/e2e-config");

    await expect(settleInstallOutputs(transport, before)).resolves.toEqual([]);
    expect(rootCallsSince(from)).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /could not read which install outputs exist before the install \(.*terminated by signal SIGKILL/,
    );
  });

  test("after the install: resolves empty, warns, and nothing runs as root", async () => {
    const transport = server.transport();
    const before = await recordInstallOutputs(transport, OUTPUTS);
    create("wp-content/e2e-config");
    const from = server.sudoCalls().length;
    server.addProgram("sh", KILLED_SH);
    try {
      await expect(settleInstallOutputs(transport, before)).resolves.toEqual(
        [],
      );
    } finally {
      server.removeProgram("sh");
    }
    expect(rootCallsSince(from)).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /could not read which install outputs exist after the install \(.*terminated by signal SIGKILL/,
    );
  });

  test("past its budget: resolves empty at once, warns, and the step ends on its own", async () => {
    const transport = server.transport();
    const before = await recordInstallOutputs(transport, OUTPUTS);
    create("wp-content/e2e-config");
    const from = server.sudoCalls().length;
    // The check after the install outlasts the budget, then fails: nothing is handed over late.
    server.addProgram("sh", "sleep 1; exit 3");
    try {
      const started = Date.now();
      await expect(
        settleInstallOutputs(transport, before, 100),
      ).resolves.toEqual([]);
      expect(Date.now() - started).toBeLessThan(900);
      expect(warnings.join("\n")).toMatch(
        /handing over \(or verifying\) the install outputs had not finished after 0\.1 s; the install went on without it/,
      );
      // The abandoned step still ends, warning as it does: no command outlives the test.
      await expect
        .poll(() => warnings.join("\n"), { timeout: 5_000 })
        .toMatch(/exist after the install \(its check exited non-zero\)/);
    } finally {
      server.removeProgram("sh");
    }
    expect(rootCallsSince(from)).toEqual([]);
  });
});

test.describe("transport.fileOwner: false", () => {
  test("outside the site state: no check at all, before or after", async () => {
    const transport = server.transport({ runAs: false, fileOwner: false });
    expect((await resolveSiteIdentity(transport)).kind).toBe("disabled");
    const sent = server.commands.length;
    const sudo = server.sudoCalls().length;

    await expect(
      cycle(transport, () => {
        create("wp-content/e2e-config");
      }),
    ).resolves.toEqual([]);
    expect(server.commands.length).toBe(sent);
    expect(server.sudoCalls().length).toBe(sudo);
  });

  test("in the site state: still verified, since the identity wrote them", async () => {
    const transport = server.transport({
      runAs: "www-data:web",
      fileOwner: false,
    });
    expect((await resolveSiteIdentity(transport)).kind).toBe("site");
    const sent = server.commands.length;

    await expect(
      cycle(transport, () => {
        create("wp-content/e2e-config");
      }),
    ).resolves.toEqual([{ path: "wp-content/e2e-config", kind: "owned" }]);
    expect(server.commands.length - sent).toBe(2);
  });
});

test.describe("handed over where commands run as the transport's user", () => {
  test("only what the install created; a new shared parent covers its children", async () => {
    const transport = server.transport({ runAs: false });
    expect((await resolveSiteIdentity(transport)).kind).toBe("disabled");
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      create("wp-content/advanced-cache.php");
      create("wp-content/cache/e2e-pages");
      create("wp-content/e2e-config");
    });

    expect(results).toEqual([
      {
        path: "wp-content/advanced-cache.php",
        kind: "handed-over",
        outcome: "normalized",
      },
      { path: "wp-content/cache", kind: "handed-over", outcome: "normalized" },
      {
        path: "wp-content/cache/e2e-pages",
        kind: "covered",
        by: "wp-content/cache",
        outcome: "normalized",
      },
      {
        path: "wp-content/e2e-config",
        kind: "handed-over",
        outcome: "normalized",
      },
    ]);
    expect(chownedSince(from)).toEqual([
      join(server.root, "wp-content/advanced-cache.php"),
      join(server.root, "wp-content/cache"),
      join(server.root, "wp-content/e2e-config"),
    ]);
  });

  test("fallback (sudo refused to the identity) hands over as disabled does", async () => {
    server.denySudo({ user: "www-data" });
    const transport = server.transport({ runAs: "www-data:web" });
    expect((await resolveSiteIdentity(transport)).kind).toBe("fallback");
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      create("wp-content/e2e-config");
    });

    expect(results).toEqual([
      {
        path: "wp-content/e2e-config",
        kind: "handed-over",
        outcome: "normalized",
      },
    ]);
    expect(chownedSince(from)).toEqual([
      join(server.root, "wp-content/e2e-config"),
    ]);
  });

  test("a shared parent that existed is never handed over; its new children are, one by one", async () => {
    create("wp-content/cache");
    create("wp-content/cache/e2e-min");
    create("wp-content/advanced-cache.php");
    const transport = server.transport();
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      create("wp-content/cache/e2e-pages");
      writeFileSync(join(server.root, "wp-content/advanced-cache.php"), "x");
    });

    expect(results).toEqual([
      {
        path: "wp-content/cache/e2e-pages",
        kind: "handed-over",
        outcome: "normalized",
      },
    ]);
    expect(chownedSince(from)).toEqual([
      join(server.root, "wp-content/cache/e2e-pages"),
    ]);
  });

  test("nothing new: no handover, nothing as root", async () => {
    for (const path of OUTPUTS) create(path);
    const transport = server.transport();
    const from = server.sudoCalls().length;

    await expect(cycle(transport, () => undefined)).resolves.toEqual([]);
    expect(rootCallsSince(from)).toEqual([]);
  });

  test("a covered output carries its parent's outcome: a failed handover is not reported as done", async () => {
    // Root's `chown` refused: the parent's handover fails, and so, through it, does its child's.
    server.addProgram("chown", "exit 1");
    const transport = server.transport({ runAs: false });

    const results = await cycle(transport, () => {
      create("wp-content/cache/e2e-pages");
    });

    expect(results).toEqual([
      { path: "wp-content/cache", kind: "handed-over", outcome: "failed" },
      {
        path: "wp-content/cache/e2e-pages",
        kind: "covered",
        by: "wp-content/cache",
        outcome: "failed",
      },
    ]);
  });

  test("a child declared before its parent is still covered, by the outermost new one", async () => {
    const transport = server.transport({ runAs: false });
    const from = server.sudoCalls().length;
    const outputs = [
      "wp-content/cache/e2e-pages/deep",
      "wp-content/cache/e2e-pages",
      "wp-content/cache",
    ];

    const before = await recordInstallOutputs(transport, outputs);
    create("wp-content/cache/e2e-pages/deep");
    const results = await settleInstallOutputs(transport, before);

    expect(results).toEqual([
      {
        path: "wp-content/cache/e2e-pages/deep",
        kind: "covered",
        by: "wp-content/cache",
        outcome: "normalized",
      },
      {
        path: "wp-content/cache/e2e-pages",
        kind: "covered",
        by: "wp-content/cache",
        outcome: "normalized",
      },
      { path: "wp-content/cache", kind: "handed-over", outcome: "normalized" },
    ]);
    expect(chownedSince(from)).toEqual([join(server.root, "wp-content/cache")]);
  });

  test("only a new parent that is no link covers: a linked one leaves its child handed over itself", async () => {
    create("wp-content/e2e-real-cache");
    const transport = server.transport({ runAs: false });
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      symlinkSync(
        join(server.root, "wp-content/e2e-real-cache"),
        join(server.root, "wp-content/cache"),
      );
      create("wp-content/cache/e2e-pages");
    });

    expect(results).toEqual([
      { path: "wp-content/cache", kind: "symlink" },
      {
        path: "wp-content/cache/e2e-pages",
        kind: "handed-over",
        outcome: "normalized",
      },
    ]);
    expect(chownedSince(from)).toEqual([
      join(server.root, "wp-content/cache/e2e-pages"),
    ]);
  });

  test("a new symbolic link is left alone and named", async () => {
    const transport = server.transport();
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      symlinkSync("/etc", join(server.root, "wp-content/e2e-config"));
    });

    expect(results).toEqual([
      { path: "wp-content/e2e-config", kind: "symlink" },
    ]);
    expect(rootCallsSince(from)).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /"wp-content\/e2e-config", which the install created, is a symbolic link/,
    );
  });
});

test.describe("verified in the site state", () => {
  test("outputs the identity owns pass, one it does not is warned, and nothing runs as root", async () => {
    const transport = server.transport({ runAs: "www-data:web" });
    expect((await resolveSiteIdentity(transport)).kind).toBe("site");
    create("wp-content/cache");
    const from = server.sudoCalls().length;
    const sent = server.commands.length;
    ownedBy("wp-content/e2e-config", "ubuntu:ubuntu:1000:1000");

    const results = await cycle(transport, () => {
      create("wp-content/cache/e2e-pages");
      create("wp-content/e2e-config");
    });

    expect(results).toEqual([
      { path: "wp-content/cache/e2e-pages", kind: "owned" },
      {
        path: "wp-content/e2e-config",
        kind: "not-owned",
        owner: { user: "ubuntu", group: "ubuntu", uid: 1000, gid: 1000 },
      },
    ]);
    expect(rootCallsSince(from)).toEqual([]);
    // Both checks ran as the site (the wrapper), and nothing else was sent.
    expect(server.commands.length - sent).toBe(2);
    const calls = server.sudoCalls().slice(from);
    expect(calls).toHaveLength(2);
    expect(calls.every((argv) => argv.includes("-u"))).toBe(true);
    expect(warnings.join("\n")).toMatch(
      /"wp-content\/e2e-config", which the install created, is owned by ubuntu:ubuntu, not by www-data:web/,
    );
  });
  test("a new symbolic link is left alone and named, with no root call", async () => {
    const transport = server.transport({ runAs: "www-data:web" });
    expect((await resolveSiteIdentity(transport)).kind).toBe("site");
    const from = server.sudoCalls().length;

    const results = await cycle(transport, () => {
      symlinkSync("/etc", join(server.root, "wp-content/e2e-config"));
    });

    expect(results).toEqual([
      { path: "wp-content/e2e-config", kind: "symlink" },
    ]);
    expect(rootCallsSince(from)).toEqual([]);
    expect(warnings.join("\n")).toMatch(
      /"wp-content\/e2e-config", which the install created, is a symbolic link/,
    );
  });

  test("the identity's user in another group, or an unreadable owner, is not owned", async () => {
    const transport = server.transport({ runAs: "www-data:web" });
    expect((await resolveSiteIdentity(transport)).kind).toBe("site");
    ownedBy("wp-content/e2e-config", "www-data:other:33:1001");
    ownedBy("wp-content/advanced-cache.php", "-");

    const results = await cycle(transport, () => {
      create("wp-content/advanced-cache.php");
      create("wp-content/e2e-config");
    });

    expect(results).toEqual([
      {
        path: "wp-content/advanced-cache.php",
        kind: "not-owned",
        owner: undefined,
      },
      {
        path: "wp-content/e2e-config",
        kind: "not-owned",
        owner: { user: "www-data", group: "other", uid: 33, gid: 1001 },
      },
    ]);
    const said = warnings.join("\n");
    expect(said).toMatch(
      /"wp-content\/advanced-cache\.php", which the install created, is owned by nobody readable/,
    );
    expect(said).toMatch(
      /"wp-content\/e2e-config", which the install created, is owned by www-data:other, not by www-data:web/,
    );
  });
});
