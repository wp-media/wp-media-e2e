import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeValue, loadSites, quoteKey, quotePath } from "./sites";
import type { SshTransport } from "./types";

/**
 * Transport parsing, from the JSON an operator writes to the object the exec layer receives.
 *
 * Narrow on purpose: `validateTransport` rebuilds the transport field by field rather than spreading
 * the parsed object, so a field it allows but nobody wires through would be **silently dropped**
 * (unknown keys are refused). That matters most for `elevate`, whose whole job is to *withhold*
 * privileged cleanup — a site that asked for unprivileged cleanup and quietly got the privileged
 * kind is the one failure mode worth a test of its own.
 */

let configDir: string;

/** Writes a `sites.json` whose single site carries `transport`, and returns its parsed form. */
function loadTransport(transport: Record<string, unknown>): SshTransport {
  writeFileSync(
    join(configDir, "sites.json"),
    JSON.stringify({
      nginx: {
        sites: [
          {
            baseURL: "https://site.example.test",
            username: "admin",
            password: "pw",
            transport,
          },
        ],
      },
    }),
  );
  const site = loadSites(configDir).nginx?.sites[0];
  if (site === undefined) throw new Error("the pool should hold one site");
  return site.transport as SshTransport;
}

const SSH = {
  mode: "ssh",
  host: "203.0.113.10",
  username: "ubuntu",
  privateKeyPath: "/home/ci/.ssh/id_ed25519",
  rootDir: "/var/www/html/site",
};

/** Runs `load`, which must throw, and returns its message. */
function failure(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("the load should fail");
}

/** The site's path every transport field's message must start with. */
const SITE_PATH = /^\[sites\] .+sites\.json → nginx\.sites\[0\]\.transport\./;

test.beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "wp-sites-config-"));
});

test.afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
});

test.describe("a refused value is described, never quoted — the file holds credentials", () => {
  const PASSWORD = "S3cr3t-Pass word";

  test("describeValue: a text by its length, anything else by its kind", () => {
    expect(describeValue(PASSWORD)).toBe("a text of 16 characters");
    expect(describeValue("naïve")).toBe("a text of 5 characters");
    expect(describeValue(null)).toBe("null");
    expect(describeValue(7)).toBe("a number");
    expect(describeValue(false)).toBe("false");
    expect(describeValue([])).toBe("a list");
    expect(describeValue({})).toBe("an object");
  });

  test("a mode, an edition, a fileOwner, a runAs or a umask holding a password is refused without it", () => {
    const messages: string[] = [];
    messages.push(failure(() => loadTransport({ ...SSH, mode: PASSWORD })));
    messages.push(
      failure(() => loadTransport({ ...SSH, fileOwner: PASSWORD })),
    );
    messages.push(failure(() => loadTransport({ ...SSH, fileOwner: ["x"] })));
    messages.push(failure(() => loadTransport({ ...SSH, runAs: PASSWORD })));
    messages.push(
      failure(() => loadTransport({ ...SSH, runAs: `${PASSWORD}:x` })),
    );
    messages.push(failure(() => loadTransport({ ...SSH, umask: PASSWORD })));
    writeFileSync(
      join(configDir, "sites.json"),
      JSON.stringify({
        nginx: {
          edition: PASSWORD,
          sites: [
            {
              baseURL: "https://a.test",
              username: "u",
              password: "p",
              transport: SSH,
            },
          ],
        },
      }),
    );
    messages.push(failure(() => loadSites(configDir)));
    for (const message of messages) {
      expect(message).toContain("[sites]");
      expect(message).not.toContain("S3cr3t");
    }
    expect(messages[0]).toContain("(got a text of 16 characters)");
  });
});

// Every transport's root is a path on the site; a relative one would be resolved from wherever a
// command starts (over ssh, the login's home), not from the root the pre-flight checked.
test.describe("transport parsing — the WordPress root must be absolute", () => {
  const relative = "html/site";
  const cases: readonly (readonly [string, Record<string, unknown>])[] = [
    ["ssh", { ...SSH, rootDir: relative }],
    ["local", { mode: "local", rootDir: relative }],
    ["docker", { mode: "docker", container: "c", rootDir: relative }],
    ["ssh, a dot", { ...SSH, rootDir: "." }],
    ["ssh, a tilde", { ...SSH, rootDir: "~/site" }],
  ];
  for (const [name, transport] of cases) {
    test(`a relative root is refused, naming the field and quoting the value: ${name}`, () => {
      let message = "";
      try {
        loadTransport(transport);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(
        /^\[sites\] .+ → nginx\.sites\[0\]\.transport\.rootDir must be an absolute path on the site, starting with "\/" \(got ".+"\)\.$/,
      );
      // A path is no secret: quoted, the operator can find it in the file.
      expect(message).toContain(`(got ${JSON.stringify(transport.rootDir)}).`);
    });
  }

  test("a relative root's quote escapes control characters and is cut past 200 code points", () => {
    expect(quotePath("html/\nsite")).toBe(String.raw`"html/\nsite"`);
    const long = `${"é".repeat(199)}🙂🙂`;
    expect(quotePath(long)).toBe(`"${"é".repeat(199)}🙂"…`);
    expect(quotePath(long.slice(0, -2))).toBe(`"${"é".repeat(199)}🙂"`);
  });

  test("an absolute root is kept as written, on every transport", () => {
    expect(loadTransport(SSH).rootDir).toBe("/var/www/html/site");
    expect(loadTransport({ mode: "local", rootDir: "/srv/wp" }).rootDir).toBe(
      "/srv/wp",
    );
    expect(
      loadTransport({ mode: "docker", container: "c", rootDir: "/var/www" })
        .rootDir,
    ).toBe("/var/www");
  });

  test("docker may still leave its root out", () => {
    expect(
      loadTransport({ mode: "docker", container: "c" }).rootDir,
    ).toBeUndefined();
  });

  test("an empty root is refused as before", () => {
    expect(() => loadTransport({ ...SSH, rootDir: "" })).toThrow(
      /\.transport\.rootDir must be a non-empty string\./,
    );
  });
});

test.describe("transport parsing — the elevation opt-out", () => {
  test("elevate:false reaches the transport, so cleanup really stays unprivileged", () => {
    expect(loadTransport({ ...SSH, elevate: false }).elevate).toBe(false);
  });

  test("elevate:true reaches the transport", () => {
    expect(loadTransport({ ...SSH, elevate: true }).elevate).toBe(true);
  });

  // Absent rather than present-and-undefined, matching how `stagingDir` is handled: under
  // `exactOptionalPropertyTypes` the difference is a type error waiting to happen.
  test("an undeclared elevate is omitted entirely, not set to undefined", () => {
    const transport = loadTransport(SSH);
    expect("elevate" in transport).toBe(false);
  });

  // Coercion would be the dangerous default: `"false"` is a string, and reading it as truthy would
  // grant exactly the privilege its author was switching off.
  test("a non-boolean elevate is rejected, naming the field", () => {
    expect(() => loadTransport({ ...SSH, elevate: "false" })).toThrow(
      /transport\.elevate must be a boolean/,
    );
  });

  // The two share one construction step, so this pins that adding elevate did not displace it.
  test("stagingDir still survives alongside it", () => {
    const transport = loadTransport({
      ...SSH,
      stagingDir: "/srv/e2e-staging",
      elevate: false,
    });
    expect(transport.stagingDir).toBe("/srv/e2e-staging");
    expect(transport.elevate).toBe(false);
  });
});

/**
 * The same contract for `fileOwner`, and for the same reason twice over.
 *
 * A declared owner that never arrives makes the suite report that none could be *detected*, which
 * tells an operator to declare the field they just declared. And `false` is the opt-out from a
 * privileged `chown -R`: silently dropping it would run as root against a site whose owner
 * explicitly forbade it — the one failure mode an opt-out exists to prevent.
 */
test.describe("transport parsing — the file-ownership override", () => {
  test('a declared "user:group" reaches the transport', () => {
    expect(
      loadTransport({ ...SSH, fileOwner: "www-data:www-data" }).fileOwner,
    ).toBe("www-data:www-data");
  });

  test("fileOwner:false reaches the transport, so the opt-out is honoured", () => {
    expect(loadTransport({ ...SSH, fileOwner: false }).fileOwner).toBe(false);
  });

  test("an undeclared fileOwner is omitted entirely, not set to undefined", () => {
    expect("fileOwner" in loadTransport(SSH)).toBe(false);
  });

  // Coercion is the dangerous default here: `true` or `0` reaching the transport as-is would be
  // read by the ownership layer as "not the opt-out" and normalise anyway.
  test("a non-string, non-false fileOwner is rejected, naming the field", () => {
    for (const bad of [true, 0, 33, {}, [], ""]) {
      expect(
        () => loadTransport({ ...SSH, fileOwner: bad }),
        JSON.stringify(bad),
      ).toThrow(/transport\.fileOwner must be/);
    }
  });

  /**
   * The **shape** is checked here too, not just the type.
   *
   * Leaving it to the ownership layer would fail in the worst way available: normalisation never
   * fails a run, so a mistyped owner would be warned about once and then silently ignored for the
   * whole suite — on exactly the site somebody was trying to fix. A config typo is not a host
   * condition, and it belongs where it was written.
   */
  test("a malformed fileOwner is rejected at load, not deferred to run time", () => {
    for (const bad of [
      "www-data", // the realistic typo: group omitted
      "www-data:",
      ":www-data",
      "a:b:c",
      "www data:www-data",
      "--reference=/etc/hostname:x", // would reach `chown` as a flag
      "-R:www-data",
    ]) {
      expect(() => loadTransport({ ...SSH, fileOwner: bad }), bad).toThrow(
        /\[sites\].*transport\.fileOwner must be/,
      );
    }
  });

  test("all three site-level knobs survive together", () => {
    const transport = loadTransport({
      ...SSH,
      stagingDir: "/srv/e2e-staging",
      elevate: false,
      fileOwner: "sftp_backwpup:www-data",
    });
    expect(transport.stagingDir).toBe("/srv/e2e-staging");
    expect(transport.elevate).toBe(false);
    expect(transport.fileOwner).toBe("sftp_backwpup:www-data");
  });
});

test.describe("cell names — they name folders and Playwright projects", () => {
  const SITE = {
    baseURL: "https://site.example.test",
    username: "admin",
    password: "pw",
    transport: SSH,
  };

  /** Writes `file` with one single-site cell per name and returns the cells the folder loads as. */
  function loadCells(names: readonly string[], file = "sites.json"): string[] {
    writeFileSync(
      join(configDir, file),
      JSON.stringify(Object.fromEntries(names.map((name) => [name, [SITE]]))),
    );
    return Object.keys(loadSites(configDir));
  }

  test("accepts every cell name in use, and others of the same shape", () => {
    const names = [
      "apache",
      "nginx",
      "free@nginx",
      "pro@nginx",
      "free@apache",
      "pro@apache",
      "php8.3@nginx",
      "a_b-c",
      "0day",
    ];
    expect(loadCells(names)).toEqual(names);
  });

  test("refuses a name that is not one lowercase path segment, or that starts with _", () => {
    for (const bad of [
      "_all", // the folder of runs that target no cell
      "_unit", // the unit tests' folder
      "Pro@nginx", // `--project` ignores case: it would select pro@nginx too
      "pro@NGINX",
      "../escape",
      "a/b",
      "a\\b",
      "",
      " nginx",
      "nginx ",
      ".hidden",
      "-flag",
      "@nginx",
      "setup:nginx", // reads as one of a cell's own projects
      "pro*", // a `--project` wildcard
      "naïve",
    ]) {
      expect(() => loadCells([bad]), JSON.stringify(bad)).toThrow(
        `cell name ${JSON.stringify(bad)} must start with a lowercase letter or digit`,
      );
    }
  });

  test("names the file holding the bad name, overlays included", () => {
    expect(() => loadCells(["Nginx"], "sites.local.json")).toThrow(
      `[sites] ${join(configDir, "sites.local.json")}: cell name "Nginx"`,
    );
  });
});

/**
 * `runAs`: who an ssh site's commands run as. Parsed at load like `fileOwner`, with the same
 * `"user:group"` rule, plus `"auto"`, `false`, and never root.
 */
test.describe("transport parsing — runAs (ssh only)", () => {
  test('"auto" and false reach the transport as written', () => {
    expect(loadTransport({ ...SSH, runAs: "auto" }).runAs).toBe("auto");
    expect(loadTransport({ ...SSH, runAs: false }).runAs).toBe(false);
  });

  test("an undeclared runAs is omitted entirely, not set to undefined", () => {
    expect("runAs" in loadTransport(SSH)).toBe(false);
  });

  test('a "user:group" reaches the transport trimmed; names and numeric ids both count', () => {
    for (const [declared, parsed] of [
      ["www-data:www-data", "www-data:www-data"],
      ["  www-data:www-data\t", "www-data:www-data"],
      ["33:33", "33:33"],
      ["www-data:33", "www-data:33"],
      ["sftp_backwpup:www-data", "sftp_backwpup:www-data"],
      ["1000:01", "1000:01"], // a non-zero id with a leading 0 is not root
    ] as const) {
      expect(loadTransport({ ...SSH, runAs: declared }).runAs, declared).toBe(
        parsed,
      );
    }
  });

  test("a malformed text is refused naming the field and the rule, never quoting it", () => {
    for (const bad of [
      "",
      " ",
      "www-data", // the realistic typo: group omitted
      "www-data:",
      ":www-data",
      "a:b:c",
      "www data:www-data",
      "-R:www-data", // would reach sudo as a flag
      "wwẃ-data:www-data",
      "AUTO",
      " auto",
      "true",
    ]) {
      const message = failure(() => loadTransport({ ...SSH, runAs: bad }));
      expect(message, JSON.stringify(bad)).toMatch(SITE_PATH);
      expect(message).toContain(
        `transport.runAs must be "auto", "user:group" (`,
      );
      expect(message).toContain(
        `— got a text of ${String(Array.from(bad).length)} characters.`,
      );
      expect(message).not.toContain(`got ${JSON.stringify(bad)}`);
    }
  });

  test("a non-text, non-false runAs is refused by its kind", () => {
    for (const [bad, kind] of [
      [true, "true"],
      [0, "a number"],
      [33, "a number"],
      [null, "null"],
      [["www-data", "www-data"], "a list"],
      [{ user: "www-data" }, "an object"],
    ] as const) {
      expect(
        failure(() => loadTransport({ ...SSH, runAs: bad })),
        JSON.stringify(bad),
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}runAs must be "auto", .+, or false — got ${kind}\\.$`,
        ),
      );
    }
  });

  test("root, by name or by an id of zeros, is refused as the user and as the group", () => {
    for (const [declared, which] of [
      ["root:root", "user and group"],
      ["0:0", "user and group"],
      ["00:000", "user and group"],
      ["root:www-data", "user"],
      ["0:www-data", "user"],
      ["www-data:root", "group"],
      ["www-data:0", "group"],
    ] as const) {
      expect(
        failure(() => loadTransport({ ...SSH, runAs: declared })),
        declared,
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}runAs names root as its ${which}: site commands never run as root\\. ` +
            'Name the web server\'s user and group \\(e\\.g\\. "www-data:www-data"\\), or use "auto" or false\\.$',
        ),
      );
    }
  });

  test("a name merely containing root is not root", () => {
    expect(loadTransport({ ...SSH, runAs: "rooter:www-data" }).runAs).toBe(
      "rooter:www-data",
    );
    expect(loadTransport({ ...SSH, runAs: "10:100" }).runAs).toBe("10:100");
  });
});

/** `umask`: what site commands create files with once they run as the site's identity. */
test.describe("transport parsing — runAs numeric ids", () => {
  test("the largest assignable id, 4294967294, is accepted as user and group", () => {
    expect(
      loadTransport({ ...SSH, runAs: "4294967294:4294967294" }).runAs,
    ).toBe("4294967294:4294967294");
  });

  test("an id above 4294967294 is refused, naming which half", () => {
    for (const [declared, which] of [
      ["4294967295:33", "user"],
      ["33:4294967295", "group"],
      ["99999999999999999999:4294967296", "user and group"],
    ] as const) {
      expect(
        failure(() => loadTransport({ ...SSH, runAs: declared })),
        declared,
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}runAs names a numeric id above 4294967294 as its ${which}: no host assigns one\\.`,
        ),
      );
    }
  });
});

/** `port`: the SSH server's port, for hosts serving several sites (the SSH twins). */
test.describe("transport parsing — port (ssh only)", () => {
  test("a whole number from 1 to 65535 is kept", () => {
    for (const port of [1, 21, 23, 2210, 65535]) {
      expect(loadTransport({ ...SSH, port }).port, String(port)).toBe(port);
    }
  });

  // An explicit 22 is the default: kept, it would key a second connection to the same server.
  test("port 22 is dropped, so the site loads exactly as one declaring no port", () => {
    const declared = loadTransport({ ...SSH, port: 22 });
    expect("port" in declared).toBe(false);
    expect(declared).toEqual(loadTransport(SSH));
  });

  test("an undeclared port is omitted entirely, not set to undefined", () => {
    expect("port" in loadTransport(SSH)).toBe(false);
  });

  test("a port out of range or not whole is refused, quoting the number", () => {
    for (const bad of [0, -22, 65536, 22.5]) {
      expect(
        failure(() => loadTransport({ ...SSH, port: bad })),
        String(bad),
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}port must be a whole number from 1 to 65535 — got ${String(bad).replace(".", "\\.")}\\.$`,
        ),
      );
    }
  });

  // A text may hold anything an operator pasted, so it is described, never quoted.
  test("a non-number port is refused by its kind", () => {
    for (const [bad, kind] of [
      ["2210", "a text of 4 characters"],
      [null, "null"],
      [true, "true"],
    ] as const) {
      expect(
        failure(() => loadTransport({ ...SSH, port: bad })),
        kind,
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}port must be a whole number from 1 to 65535 — got ${kind}\\.$`,
        ),
      );
    }
  });
});

test.describe("transport parsing — umask (ssh only)", () => {
  test("three or four octal digits keeping the owner's bits, normalised to four", () => {
    for (const [declared, parsed] of [
      ["000", "0000"],
      ["0000", "0000"],
      ["022", "0022"],
      ["0022", "0022"],
      ["002", "0002"],
      ["077", "0077"],
      ["0077", "0077"],
    ] as const) {
      expect(loadTransport({ ...SSH, umask: declared }).umask, declared).toBe(
        parsed,
      );
    }
  });

  test("an undeclared umask is omitted entirely, not set to undefined", () => {
    expect("umask" in loadTransport(SSH)).toBe(false);
  });

  // The owner digit must be 0: masking read, write or search leaves the identity unable to use what
  // it just created (`177` makes every new directory 0600, which its owner cannot enter).
  test("a umask masking any owner bit is refused, quoting it", () => {
    for (const bad of ["0777", "777", "0600", "0700", "177", "0100", "400"]) {
      expect(
        failure(() => loadTransport({ ...SSH, umask: bad })),
        bad,
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}umask must be an octal umask as a text of 3 or 4 digits .+ — got "${bad}"\\.$`,
        ),
      );
    }
  });

  test("anything not 3 or 4 octal digits is refused, described by its length", () => {
    for (const bad of [
      "",
      " 022",
      "022 ",
      "8",
      "22",
      "088",
      "0o022",
      "0x12",
      "00022",
      "1022", // a special bit
      "-022",
      "+022",
      "٠٢٢", // Arabic-Indic digits
    ]) {
      expect(
        failure(() => loadTransport({ ...SSH, umask: bad })),
        JSON.stringify(bad),
      ).toMatch(
        new RegExp(
          `${SITE_PATH.source}umask must be .+ — got a text of ${String(Array.from(bad).length)} characters\\.$`,
        ),
      );
    }
  });

  // A JSON number is never read: `22` would be decimal 22, not octal 022.
  test("a non-text umask is refused by its kind", () => {
    for (const [bad, kind] of [
      [22, "a number"],
      [0, "a number"],
      [18, "a number"],
      [false, "false"],
      [null, "null"],
      [["022"], "a list"],
    ] as const) {
      expect(
        failure(() => loadTransport({ ...SSH, umask: bad })),
        JSON.stringify(bad),
      ).toMatch(
        new RegExp(`${SITE_PATH.source}umask must be .+ — got ${kind}\\.$`),
      );
    }
  });

  test("runAs and umask survive beside every other knob", () => {
    const transport = loadTransport({
      ...SSH,
      stagingDir: "/srv/e2e-staging",
      elevate: false,
      fileOwner: "www-data:www-data",
      runAs: "www-data:www-data",
      umask: "002",
    });
    expect(transport).toEqual({
      ...SSH,
      stagingDir: "/srv/e2e-staging",
      elevate: false,
      fileOwner: "www-data:www-data",
      runAs: "www-data:www-data",
      umask: "0002",
      wpUser: "admin",
    });
  });
});

// docker and local have no second identity and no server to reach: a field that would be silently
// ignored is refused, so an operator never believes a site runs as someone, or on a port, it does not.
test.describe("transport parsing — port, runAs and umask are refused off ssh", () => {
  const transports = {
    docker: { mode: "docker", container: "c" },
    local: { mode: "local", rootDir: "/srv/wp" },
  } as const;
  for (const [mode, transport] of Object.entries(transports)) {
    for (const [field, value] of [
      ["port", 2210],
      ["port", 22], // even the default: the field means nothing here
      ["runAs", "auto"],
      ["runAs", false], // even the opt-out: the field means nothing here
      ["runAs", "www-data:www-data"],
      ["umask", "0022"],
      ["umask", null],
    ] as const) {
      test(`${mode}: ${field}: ${JSON.stringify(value)} is a load error naming the site and the field`, () => {
        expect(
          failure(() => loadTransport({ ...transport, [field]: value })),
        ).toMatch(
          new RegExp(
            `${SITE_PATH.source}${field} applies to "ssh" transports only, and this one is "${mode}", ` +
              "which would ignore it\\. Remove the field\\.$",
          ),
        );
      });
    }
  }
});

/** `wpUser`: the WordPress login WP-CLI acts as, always the site's own `username`. */
test.describe("transport parsing — wpUser is resolved, never declared", () => {
  test("every transport gets the site's username", () => {
    for (const transport of [
      SSH,
      { mode: "docker", container: "c" },
      { mode: "local", rootDir: "/srv/wp" },
    ]) {
      expect(loadTransport(transport).wpUser, transport.mode).toBe("admin");
    }
  });

  test("the login is copied exactly as the site declares it", () => {
    writeFileSync(
      join(configDir, "sites.json"),
      JSON.stringify({
        apache: [
          {
            baseURL: "https://a.example.test",
            username: "Ädmin@example.com",
            password: "pw",
            transport: SSH,
          },
          {
            baseURL: "https://b.example.test",
            username: "editor",
            password: "pw",
            transport: SSH,
          },
        ],
      }),
    );
    const sites = loadSites(configDir).apache?.sites ?? [];
    expect(sites.map(({ transport }) => transport.wpUser)).toEqual([
      "Ädmin@example.com",
      "editor",
    ]);
  });

  test("a sites file setting it is refused on every transport, whatever its value", () => {
    for (const transport of [
      SSH,
      { mode: "docker", container: "c" },
      { mode: "local", rootDir: "/srv/wp" },
    ]) {
      for (const value of ["admin", "", null, false, 1]) {
        expect(
          failure(() => loadTransport({ ...transport, wpUser: value })),
          `${transport.mode} ${JSON.stringify(value)}`,
        ).toMatch(
          new RegExp(
            `${SITE_PATH.source}wpUser is not a sites-file field: it is filled from the site's "username"\\. Remove it\\.$`,
          ),
        );
      }
    }
  });

  test("a site without a username still fails on the username, not on wpUser", () => {
    writeFileSync(
      join(configDir, "sites.json"),
      JSON.stringify({
        nginx: [
          { baseURL: "https://a.example.test", password: "pw", transport: SSH },
        ],
      }),
    );
    expect(() => loadSites(configDir)).toThrow(
      /nginx\[0\]\.username must be a non-empty string\./,
    );
  });
});

/**
 * Unknown keys: refused, never dropped. A misspelt opt-out (`"runas": false`) would otherwise leave the
 * default in force while the operator believes it is off.
 */
test.describe("unknown keys are refused, naming them and what is allowed", () => {
  const ALLOWED = {
    ssh: "mode, stagingDir, elevate, fileOwner, host, port, username, privateKeyPath, rootDir, runAs, umask",
    docker: "mode, stagingDir, elevate, fileOwner, container, rootDir",
    local: "mode, stagingDir, elevate, fileOwner, rootDir",
  } as const;
  const TRANSPORTS = {
    ssh: SSH,
    docker: { mode: "docker", container: "c" },
    local: { mode: "local", rootDir: "/srv/wp" },
  } as const;

  for (const [mode, transport] of Object.entries(TRANSPORTS)) {
    test(`${mode}: a misspelt key fails the load, quoted, with the mode's fields`, () => {
      expect(
        failure(() => loadTransport({ ...transport, runas: false })),
      ).toMatch(
        new RegExp(
          `^\\[sites\\] .+sites\\.json → nginx\\.sites\\[0\\]\\.transport has unknown field "runas": ` +
            `a "${mode}" transport takes only ${ALLOWED[mode as keyof typeof ALLOWED]}\\. ` +
            "Fix the spelling or remove it\\.$",
        ),
      );
    });
  }

  test("every allowed key loads, on each mode", () => {
    expect(
      loadTransport({
        ...SSH,
        stagingDir: "/s",
        elevate: true,
        fileOwner: false,
        runAs: false,
        umask: "022",
      }).mode,
    ).toBe("ssh");
    expect(
      loadTransport({
        mode: "docker",
        container: "c",
        rootDir: "/var/www/html",
        stagingDir: "/s",
        elevate: true,
        fileOwner: false,
      }).mode,
    ).toBe("docker");
    expect(
      loadTransport({
        mode: "local",
        rootDir: "/srv/wp",
        stagingDir: "/s",
        elevate: true,
        fileOwner: false,
      }).mode,
    ).toBe("local");
  });

  // The more specific refusals win: they say why the field does not apply.
  test("an ssh-only field off ssh, or wpUser, keeps its own message", () => {
    expect(
      failure(() =>
        loadTransport({
          mode: "local",
          rootDir: "/srv/wp",
          umask: "022",
          x: 1,
        }),
      ),
    ).toContain('umask applies to "ssh" transports only');
    expect(
      failure(() => loadTransport({ ...SSH, wpUser: "a", x: 1 })),
    ).toContain("wpUser is not a sites-file field");
  });

  test("an unknown key is refused before a missing field it may be standing in for", () => {
    const { rootDir, ...rest } = SSH;
    expect(
      failure(() => loadTransport({ ...rest, rootdir: rootDir })),
    ).toContain('has unknown field "rootdir"');
  });

  test("several unknown keys: the first five named, the rest counted, plural wording", () => {
    const extra = Object.fromEntries(
      ["a", "b", "c", "d", "e", "f", "g"].map((key) => [key, 1]),
    );
    expect(failure(() => loadTransport({ ...SSH, ...extra }))).toMatch(
      /has unknown fields "a", "b", "c", "d", "e" and 2 more: .+ Fix the spelling or remove them\.$/,
    );
  });

  // A key names a field, so it is quoted; it still must not be able to rewrite the terminal line.
  test("a key is quoted escaped to printable ASCII and cut past 64 code points", () => {
    expect(quoteKey("runas")).toBe('"runas"');
    expect(quoteKey("a\nb")).toBe(String.raw`"a\nb"`);
    expect(quoteKey("\u001b[2Jx")).toBe(String.raw`"\u001b[2Jx"`);
    expect(quoteKey("\u202eabc")).toBe(String.raw`"\u202eabc"`);
    expect(quoteKey("é🙂")).toBe(String.raw`"\u00e9\ud83d\ude42"`);
    expect(quoteKey("k".repeat(64))).toBe(`"${"k".repeat(64)}"`);
    expect(quoteKey(`${"k".repeat(64)}🙂`)).toBe(`"${"k".repeat(64)}"…`);
    expect(
      failure(() => loadTransport({ ...SSH, "\u202erunas": false })),
    ).toContain(String.raw`unknown field "\u202erunas"`);
  });

  test("a site's own unknown key is refused, naming the site's fields", () => {
    writeFileSync(
      join(configDir, "sites.json"),
      JSON.stringify({
        nginx: [
          {
            baseURL: "https://a.example.test",
            username: "admin",
            password: "pw",
            transport: SSH,
            overides: {},
          },
        ],
      }),
    );
    expect(failure(() => loadSites(configDir))).toMatch(
      /^\[sites\] .+sites\.json → nginx\[0\] has unknown field "overides": a site takes only baseURL, username, password, transport, overrides\. Fix the spelling or remove it\.$/,
    );
  });
});

/** The site's `username` becomes WP-CLI's `--user`, looked up exactly: surrounding blanks name nobody. */
test.describe("a site's username with surrounding whitespace is refused", () => {
  for (const username of [
    " admin",
    "admin ",
    "\tadmin",
    "admin\n",
    "\u00a0admin",
  ]) {
    test(`refused, never quoted: ${JSON.stringify(username)}`, () => {
      writeFileSync(
        join(configDir, "sites.json"),
        JSON.stringify({
          nginx: [
            {
              baseURL: "https://a.example.test",
              username,
              password: "pw",
              transport: SSH,
            },
          ],
        }),
      );
      const message = failure(() => loadSites(configDir));
      expect(message).toMatch(
        /^\[sites\] .+ → nginx\[0\]\.username must not start or end with whitespace: WP-CLI looks the login up exactly\. Remove the spaces\.$/,
      );
      expect(message).not.toContain("admin");
    });
  }

  test("inner spaces stay allowed: WordPress logins may hold them", () => {
    writeFileSync(
      join(configDir, "sites.json"),
      JSON.stringify({
        nginx: [
          {
            baseURL: "https://a.example.test",
            username: "site admin",
            password: "pw",
            transport: SSH,
          },
        ],
      }),
    );
    expect(loadSites(configDir).nginx?.sites[0]?.username).toBe("site admin");
  });
});
