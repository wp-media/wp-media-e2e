import { test, expect } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describeValue, loadSites, quotePath } from "./sites";
import type { SshTransport } from "./types";

/**
 * Transport parsing, from the JSON an operator writes to the object the exec layer receives.
 *
 * Narrow on purpose: `validateTransport` rebuilds the transport field by field rather than spreading
 * the parsed object, so a field nobody wires through is **silently dropped**. That is harmless for a
 * value like `stagingDir` (the default is fine) and not harmless at all for `elevate`, whose whole
 * job is to *withhold* privileged cleanup — a site that asked for unprivileged cleanup and quietly
 * got the privileged kind is the one failure mode worth a test of its own.
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

  test("a mode, an edition or a fileOwner holding a password is refused without it", () => {
    const messages: string[] = [];
    const failure = (load: () => unknown): string => {
      try {
        load();
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
      throw new Error("the load should fail");
    };
    messages.push(failure(() => loadTransport({ ...SSH, mode: PASSWORD })));
    messages.push(
      failure(() => loadTransport({ ...SSH, fileOwner: PASSWORD })),
    );
    messages.push(failure(() => loadTransport({ ...SSH, fileOwner: ["x"] })));
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
