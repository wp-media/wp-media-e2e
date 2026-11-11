import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installKey } from "./exec";
import {
  PROBE_FILE_NAME,
  PROBE_PHP,
  ROOT_MOVED_EXIT,
  ROOT_WRITE_SCRIPT,
  SITE_IDENTITY_FILE,
  checkWebIdentity,
  parseProbeOutput,
  parseSiteIdentityFile,
  probeFileName,
  probeUrl,
  probeWebIdentity,
  readSiteIdentityFile,
  sweepArgv,
  sweepProbeFiles,
  sweptNames,
  webVerdict,
  writeFailure,
  writeSiteIdentityFile,
} from "./web-identity";
import { useExclDd } from "../__fixtures__/excl-dd";
import { tapFifo } from "../__fixtures__/fifo";
import { killTethered, spawnTethered } from "../__fixtures__/tether";
import { removeTempDir } from "../__fixtures__/temp-dir";
import {
  selfSignedCertificate,
  startProbeWebServer,
  type ProbeWebServer,
} from "../__fixtures__/probe-web-server";
import type {
  SiteIdentityVerdict,
  WebIdentity,
  WebProbeResult,
} from "./web-identity";
import type { LocalTransport } from "../config/types";

/**
 * The web probe: its output parser, its URL, the sweep of killed runs' files (by real file ages), the
 * probe end to end on a `local` site behind a stand-in web server (and behind PHP's own server, when
 * `php` is installed), the verdict and the verdict file.
 */

const HEX = "0123456789abcdef0123456789abcdef";
const NAME = `e2e-identity-${HEX}.php`;
const WEB: WebIdentity = {
  euid: 33,
  egid: 33,
  user: "www-data",
  group: "www-data",
  umask: "0022",
  sapi: "fpm-fcgi",
};

// ── Pure parts ───────────────────────────────────────────────────────────────────────────────────

test("the probe's output is read strictly, extra fields ignored", () => {
  const body = { e2e: "identity", ...WEB };
  expect(parseProbeOutput(JSON.stringify(body))).toEqual({
    kind: "identity",
    identity: WEB,
  });
  expect(
    parseProbeOutput(JSON.stringify({ ...body, extra: [1], php: "8.3" })),
  ).toEqual({
    kind: "identity",
    identity: WEB,
  });
  expect(
    parseProbeOutput(JSON.stringify({ ...body, user: null, group: null })),
  ).toEqual({
    kind: "identity",
    identity: { euid: 33, egid: 33, umask: "0022", sapi: "fpm-fcgi" },
  });
  expect(parseProbeOutput('{"e2e":"identity","error":"no-posix"}')).toEqual({
    kind: "no-posix",
  });
  // A BOM a BOM-saved wp-config.php or prepend file prints before the JSON.
  expect(parseProbeOutput(`\uFEFF${JSON.stringify(body)}`)).toEqual({
    kind: "identity",
    identity: WEB,
  });
});

for (const [label, body] of [
  ["an HTML error page", "<!doctype html><title>404</title>"],
  ["PHP source served as text", PROBE_PHP],
  ["another JSON", JSON.stringify({ ...WEB })],
  ["a JSON array", "[1,2]"],
  ["empty", ""],
  [
    "a missing euid",
    JSON.stringify({ e2e: "identity", ...WEB, euid: undefined }),
  ],
  ["a negative id", JSON.stringify({ e2e: "identity", ...WEB, egid: -1 })],
  ["a fractional id", JSON.stringify({ e2e: "identity", ...WEB, euid: 33.5 })],
  [
    "an id past the largest",
    JSON.stringify({ e2e: "identity", ...WEB, euid: 4_294_967_295 }),
  ],
  ["an id as text", JSON.stringify({ e2e: "identity", ...WEB, euid: "33" })],
  [
    "a three-digit umask",
    JSON.stringify({ e2e: "identity", ...WEB, umask: "022" }),
  ],
  [
    "a name with a control character",
    JSON.stringify({ e2e: "identity", ...WEB, user: "a\u001bb" }),
  ],
  [
    "a user name with a colon",
    JSON.stringify({ e2e: "identity", ...WEB, user: "www:data" }),
  ],
  [
    "a group name with a colon",
    JSON.stringify({ e2e: "identity", ...WEB, group: "www:data" }),
  ],
  ["two BOMs", `\uFEFF\uFEFF${JSON.stringify({ e2e: "identity", ...WEB })}`],
  [
    "a name of 65 characters",
    JSON.stringify({ e2e: "identity", ...WEB, group: "g".repeat(65) }),
  ],
  ["an empty SAPI", JSON.stringify({ e2e: "identity", ...WEB, sapi: "" })],
] as const) {
  test(`the probe parser refuses ${label}`, () => {
    expect(parseProbeOutput(body)).toBeUndefined();
  });
}

test("the probe URL keeps the site's path, with exactly one slash before the name", () => {
  expect(probeUrl("https://site.test", NAME)).toBe(`https://site.test/${NAME}`);
  expect(probeUrl("https://site.test/", NAME)).toBe(
    `https://site.test/${NAME}`,
  );
  expect(probeUrl("https://site.test/blog", NAME)).toBe(
    `https://site.test/blog/${NAME}`,
  );
  expect(probeUrl("https://site.test/blog///", NAME)).toBe(
    `https://site.test/blog/${NAME}`,
  );
  expect(probeUrl("http://site.test:8100/a/b?x=1#y", NAME)).toBe(
    `http://site.test:8100/a/b/${NAME}`,
  );
  expect(() => probeUrl("not a url", NAME)).toThrow(TypeError);
});

test("a probe file name is 32 random lower-case hex digits", () => {
  const names = new Set(Array.from({ length: 50 }, () => probeFileName()));
  expect(names.size).toBe(50);
  for (const name of names) expect(name).toMatch(PROBE_FILE_NAME);
  expect(probeFileName(Buffer.from(HEX, "hex"))).toBe(NAME);
});

test("the probe's PHP is a constant holding no value from outside, checking every posix call it makes", () => {
  expect(PROBE_PHP.startsWith("<?php\n")).toBe(true);
  expect(PROBE_PHP).not.toMatch(
    /\$_(GET|POST|REQUEST|SERVER|COOKIE|ENV)|base64|eval\(/,
  );
  const called = new Set(PROBE_PHP.match(/posix_\w+(?=\()/g));
  for (const name of called) {
    expect(PROBE_PHP).toContain(`function_exists( '${name}' )`);
  }
  expect([...called].sort()).toEqual([
    "posix_getegid",
    "posix_geteuid",
    "posix_getgrgid",
    "posix_getpwuid",
  ]);
});

test("the sweep lists the root only, regular files named like a probe, older than an hour", () => {
  expect(sweepArgv("/var/www/html")).toEqual([
    "/var/www/html/",
    "-mindepth",
    "1",
    "-maxdepth",
    "1",
    "-type",
    "f",
    "-name",
    `e2e-identity-${"?".repeat(32)}.php`,
    "-mmin",
    "+60",
    "-print",
  ]);
  expect(sweepArgv("/var/www/html/")[0]).toBe("/var/www/html/");
});

test("only exact probe names are taken from a listing, once each", () => {
  const listing = [
    `/r/${NAME}`,
    `/r//${NAME}`,
    `/r/e2e-identity-${HEX.toUpperCase()}.php`,
    `/r/e2e-identity-${HEX.replace("f", "g")}.php`,
    "/r/e2e-identity-0123.php",
    `/r/x${NAME}`,
    `/r/${NAME}\r`,
    "",
  ].join("\n");
  expect(sweptNames(listing)).toEqual([NAME]);
});

test("the verdict compares the web server's ids with the owner's, uid and gid", () => {
  const owner = { user: "www-data", group: "www-data", uid: 33, gid: 33 };
  const identified: WebProbeResult = { kind: "identified", identity: WEB };

  expect(webVerdict(owner, identified)).toEqual({
    verdict: "owner-is-web",
    owner,
    web: WEB,
  });
  expect(
    webVerdict({ ...owner, uid: 1001, user: "sftp_x" }, identified),
  ).toMatchObject({
    verdict: "owner-not-web",
  });
  expect(webVerdict({ ...owner, gid: 1001 }, identified)).toMatchObject({
    verdict: "owner-not-web",
  });
  expect(webVerdict(undefined, identified)).toEqual({
    verdict: "unverified",
    reason: "no-owner",
    detail: "the docroot's owner could not be read",
  });
  expect(
    webVerdict(owner, {
      kind: "unverified",
      reason: "not-served",
      detail: "HTTP 404",
    }),
  ).toEqual({
    verdict: "unverified",
    reason: "not-served",
    detail: "HTTP 404",
    owner,
  });
});

test("a failed probe write is classified by what dd said", () => {
  for (const [said, expected] of [
    ["dd: unknown conversion excl", "no-excl"], // BSD (macOS)
    ["dd: invalid argument 'excl' to 'conv'", "no-excl"], // BusyBox
    ["dd: invalid conversion: 'excl'", "no-excl"], // older GNU
    ["dd: failed to open '/r/p.php': File exists", "exists"],
    ["dd: failed to open '/r/p.php': Permission denied", "denied"],
    ["dd: writing to '/r/p.php': No space left on device", "other"],
    ["dd: failed to open '/r/p.php': Read-only file system", "other"],
    ["dd: invalid conversion: 'bogus'", "other"],
    ["", "other"],
  ] as const) {
    expect(writeFailure(said), said).toBe(expected);
  }
});

// ── On a local site ──────────────────────────────────────────────────────────────────────────────

test.describe("on a local site", () => {
  let root = "";
  let web: ProbeWebServer | undefined;
  /** Undoes {@link useExclDd}. */
  let undoDd: () => void = () => undefined;

  test.beforeAll(() => {
    undoDd = useExclDd();
  });

  test.afterAll(() => {
    undoDd();
  });

  test.beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "web-identity-"));
  });

  test.afterEach(async () => {
    await web?.close();
    web = undefined;
    if (root !== "" && existsSync(root)) chmodSync(root, 0o755);
    removeTempDir(root);
  });

  const local = (): LocalTransport => ({
    mode: "local",
    rootDir: root,
    elevate: false,
  });

  /** Backdates a path by `minutes`, without following a symlink. */
  const age = (path: string, minutes: number): void => {
    const then = new Date(Date.now() - minutes * 60_000);
    lutimesSync(path, then, then);
  };

  test("the sweep removes only the root's probe files older than an hour", async () => {
    const old = `e2e-identity-${"a".repeat(32)}.php`;
    const fresh = `e2e-identity-${"b".repeat(32)}.php`;
    const decoys = [
      `e2e-identity-${"a".repeat(31)}.php`,
      "e2e-identity-ABCDEF0123456789ABCDEF0123456789.php",
      `e2e-identity-${"c".repeat(32)}.php.bak`,
      "index.php",
    ];
    for (const name of [old, fresh, ...decoys])
      writeFileSync(join(root, name), "x");
    mkdirSync(join(root, "sub"));
    const nested = join(root, "sub", `e2e-identity-${"d".repeat(32)}.php`);
    writeFileSync(nested, "x");
    const outside = mkdtempSync(join(tmpdir(), "web-identity-outside-"));
    const target = join(outside, "kept.php");
    writeFileSync(target, "x");
    const link = `e2e-identity-${"e".repeat(32)}.php`;
    symlinkSync(target, join(root, link));
    const directory = `e2e-identity-${"f".repeat(32)}.php`;
    mkdirSync(join(root, directory));
    for (const name of [old, ...decoys, link, directory])
      age(join(root, name), 61);
    age(nested, 61);
    age(target, 61);
    age(join(root, fresh), 59);

    try {
      await expect(sweepProbeFiles(local())).resolves.toEqual([old]);
      expect(readdirSync(root).sort()).toEqual(
        [fresh, ...decoys, "sub", link, directory].sort(),
      );
      expect(existsSync(nested)).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      removeTempDir(outside);
    }
  });

  test("a sweep with nothing to remove runs nothing more", async () => {
    await expect(sweepProbeFiles(local())).resolves.toEqual([]);
  });

  test("the probe is written 0644 with the constant PHP, fetched under the site's path, then removed", async ({
    playwright,
  }) => {
    web = await startProbeWebServer(root, "/blog");

    const result = await probeWebIdentity(
      { transport: local(), baseURL: web.baseURL },
      playwright.request,
      { name: NAME },
    );

    expect(result).toEqual({ kind: "identified", identity: WEB });
    expect(web.requests).toEqual([
      { path: `/blog/${NAME}`, content: PROBE_PHP, mode: 0o644 },
    ]);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a probe sweeps a killed run's leftover first, and leaves a fresh one alone", async ({
    playwright,
  }) => {
    web = await startProbeWebServer(root);
    const leftover = `e2e-identity-${"9".repeat(32)}.php`;
    const recent = `e2e-identity-${"8".repeat(32)}.php`;
    writeFileSync(join(root, leftover), "x");
    writeFileSync(join(root, recent), "x");
    age(join(root, leftover), 120);

    await probeWebIdentity(
      { transport: local(), baseURL: web.baseURL },
      playwright.request,
    );

    expect(readdirSync(root)).toEqual([recent]);
  });

  for (const [label, reply, expected] of [
    [
      "a 404 (WordPress below the URL root)",
      { status: 404, body: "nope" },
      { reason: "not-served", detail: "HTTP 404" },
    ],
    [
      "a 500",
      { status: 500, body: "boom" },
      { reason: "not-served", detail: "HTTP 500" },
    ],
    [
      "a 200 HTML page",
      { status: 200, body: "<html>hi</html>" },
      { reason: "not-probe-output" },
    ],
    [
      "PHP served as source",
      { status: 200, body: PROBE_PHP, type: "text/plain" },
      { reason: "not-probe-output" },
    ],
    [
      "a body far past the probe's",
      { status: 200, body: "x".repeat(20_000) },
      { reason: "not-probe-output", detail: "a body of 20000 bytes" },
    ],
    [
      "a body past the probe's sent with no length",
      { status: 200, body: "x".repeat(20_000), encoding: "chunked" },
      { reason: "not-probe-output", detail: "a body of 20000 bytes" },
    ],
    [
      // Random bytes do not compress: a declared length past the cap, a decoded body at it.
      "a declared length past the probe's",
      {
        status: 200,
        body: randomBytes(16_384),
        encoding: "gzip",
      },
      {
        reason: "not-probe-output",
        detail: expect.stringMatching(/^a body of 16\d{3} bytes$/),
      },
    ],
    [
      "the probe's JSON with a status other than 200",
      {
        status: 201,
        body: JSON.stringify({ e2e: "identity", ...WEB }),
        type: "application/json",
      },
      { reason: "not-served", detail: "HTTP 201" },
    ],
    [
      "PHP without posix",
      { status: 200, body: '{"e2e":"identity","error":"no-posix"}' },
      { reason: "no-posix" },
    ],
  ] as const) {
    test(`${label} is unverified, and the file is still removed`, async ({
      playwright,
    }) => {
      web = await startProbeWebServer(root);
      web.reply = reply;

      const result = await probeWebIdentity(
        { transport: local(), baseURL: web.baseURL },
        playwright.request,
      );

      expect(result).toMatchObject({ kind: "unverified", ...expected });
      expect(readdirSync(root)).toEqual([]);
    });
  }

  /** What may already sit at the probe's path; each must be refused, never followed or replaced. */
  const PLANTED: readonly (readonly [string, (path: string) => void])[] = [
    [
      "a dangling symlink",
      (path) => {
        symlinkSync(join(root, "nowhere"), path);
      },
    ],
    [
      "a file",
      (path) => {
        writeFileSync(path, "planted");
      },
    ],
    [
      "a directory",
      (path) => {
        mkdirSync(path);
      },
    ],
  ];

  for (const [label, plant] of PLANTED) {
    test(`${label} already at the probe's path is refused, untouched, and nothing is fetched`, async ({
      playwright,
    }) => {
      web = await startProbeWebServer(root);
      const path = join(root, NAME);
      plant(path);
      const before = lstatSync(path);

      const result = await probeWebIdentity(
        { transport: local(), baseURL: web.baseURL },
        playwright.request,
        { name: NAME },
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: "not-writable",
      });
      expect(web.requests).toEqual([]);
      const after = lstatSync(path);
      expect([after.ino, after.mode, after.size]).toEqual([
        before.ino,
        before.mode,
        before.size,
      ]);
      expect(existsSync(join(root, "nowhere"))).toBe(false);
    });
  }

  test("a symlink to a FIFO at the probe's path is never written through", async ({
    playwright,
  }) => {
    // `set -C` opens a path resolving to a non-regular file without O_EXCL: dash and bash both
    // would feed the probe into the FIFO. `dd conv=excl` refuses it.
    web = await startProbeWebServer(root);
    const outside = mkdtempSync(join(tmpdir(), "web-identity-fifo-"));
    const fifo = tapFifo(join(outside, "fifo"));
    try {
      symlinkSync(join(outside, "fifo"), join(root, NAME));

      const result = await probeWebIdentity(
        { transport: local(), baseURL: web.baseURL },
        playwright.request,
        { name: NAME },
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: "not-writable",
      });
      expect(result.kind === "unverified" ? result.detail : "").toMatch(
        /File exists/,
      );
      expect(fifo.drain()).toBe("");
      expect(lstatSync(join(root, NAME)).isSymbolicLink()).toBe(true);
    } finally {
      fifo.close();
      removeTempDir(outside);
    }
  });

  test("a site nobody answers for is unverified/unreachable, and the file is removed", async ({
    playwright,
  }) => {
    const port = await closedPort();

    const result = await probeWebIdentity(
      { transport: local(), baseURL: `http://127.0.0.1:${String(port)}` },
      playwright.request,
    );

    expect(result).toMatchObject({ kind: "unverified", reason: "unreachable" });
    expect(result.kind === "unverified" ? result.detail : "").toMatch(
      /ECONNREFUSED/,
    );
    expect(result.kind === "unverified" ? result.detail : "").not.toContain(
      "\n",
    );
    expect(readdirSync(root)).toEqual([]);
  });

  test("a certificate the runner does not trust is unverified/unreachable: TLS is verified, as the login's", async ({
    playwright,
  }) => {
    const tls = selfSignedCertificate();
    test.skip(tls === undefined, "no openssl on this runner");
    web = await startProbeWebServer(root, "", tls);

    const result = await probeWebIdentity(
      { transport: local(), baseURL: web.baseURL },
      playwright.request,
    );

    expect(result).toMatchObject({ kind: "unverified", reason: "unreachable" });
    expect(result.kind === "unverified" ? result.detail : "").toMatch(
      /certificate/i,
    );
    expect(web.requests).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  /**
   * Puts a `dd` that fails as told ahead of `PATH` for one test: it prints `say`, creating an empty
   * file at its `of=` first when `create` (a full disk fails after the open).
   *
   * @param say - its error line.
   * @param create - whether it creates the file first.
   * @returns the undo.
   */
  const failingDd = (say: string, create: boolean): (() => void) => {
    const bin = mkdtempSync(join(tmpdir(), "web-identity-dd-"));
    writeFileSync(
      join(bin, "dd"),
      [
        "#!/bin/sh",
        'for a in "$@"; do case $a in of=*) of=${a#of=} ;; esac; done',
        ...(create ? [': > "$of"'] : []),
        "cat >/dev/null",
        `printf '%s\\n' '${say.replaceAll("'", "'\\''")}' >&2`,
        "exit 1",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const before = process.env.PATH;
    process.env.PATH = `${bin}:${before ?? ""}`;
    return () => {
      process.env.PATH = before;
      removeTempDir(bin);
    };
  };

  test("a write that fails after creating the file (a full disk) removes it and names the cause, never escalating", async ({
    playwright,
  }) => {
    web = await startProbeWebServer(root);
    const undo = failingDd(
      `dd: error writing '${join(root, NAME)}': No space left on device`,
      true,
    );
    try {
      const result = await probeWebIdentity(
        { transport: local(), baseURL: web.baseURL },
        playwright.request,
        { name: NAME },
      );

      expect(result).toMatchObject({
        kind: "unverified",
        reason: "not-writable",
      });
      const detail = result.kind === "unverified" ? result.detail : "";
      expect(detail).toMatch(
        /^the transport's user's write failed \(dd: error writing .*No space left on device\)$/,
      );
      // Only a permission refusal asks for elevation: `elevate: false` would otherwise be named.
      expect(detail).not.toContain("elevation");
      expect(readdirSync(root)).toEqual([]);
      expect(web.requests).toEqual([]);
    } finally {
      undo();
    }
  });

  for (const said of [
    "dd: unknown conversion excl",
    "dd: invalid argument 'excl' to 'conv'",
    "dd: invalid conversion: 'excl'",
    "dd: invalid conversion: `excl'",
  ]) {
    test(`a dd without conv=excl (${said}) is named as such, never as a root the user cannot write`, async ({
      playwright,
    }) => {
      web = await startProbeWebServer(root);
      const undo = failingDd(said, false);
      try {
        const result = await probeWebIdentity(
          { transport: local(), baseURL: web.baseURL },
          playwright.request,
          { name: NAME },
        );

        expect(result).toMatchObject({
          kind: "unverified",
          reason: "not-writable",
        });
        const detail = result.kind === "unverified" ? result.detail : "";
        expect(detail).toBe(
          `the site's dd lacks conv=excl (${said}), which the probe's write needs to never follow ` +
            "what is already at its path; nothing was written",
        );
        expect(readdirSync(root)).toEqual([]);
        expect(web.requests).toEqual([]);
      } finally {
        undo();
      }
    });
  }

  test("root's write enters the root and writes there only while it resolves to the checked path", () => {
    /** Runs {@link ROOT_WRITE_SCRIPT} as this user, `cwd` `/`. */
    const run = (dir: string, realRoot: string) =>
      spawnSync(
        "/bin/sh",
        ["-c", ROOT_WRITE_SCRIPT, "sh", PROBE_PHP, NAME, dir, realRoot],
        { cwd: "/", encoding: "utf8" },
      );
    const real = realpathSync(root);
    const site = join(root, "site");
    mkdirSync(site);

    const ok = run(site, join(real, "site"));
    expect(ok.status).toBe(0);
    expect(readFileSync(join(site, NAME), "utf8")).toBe(PROBE_PHP);
    expect(statSync(join(site, NAME)).mode & 0o777).toBe(0o644);
    rmSync(join(site, NAME));

    // The root swapped for a symlink elsewhere after the guards resolved it.
    const elsewhere = join(root, "elsewhere");
    mkdirSync(elsewhere);
    rmSync(site, { recursive: true });
    symlinkSync(elsewhere, site);
    const moved = run(site, join(real, "site"));
    expect(moved.status).toBe(ROOT_MOVED_EXIT);
    expect(moved.stderr).toMatch(/no longer resolves/);
    expect(readdirSync(elsewhere)).toEqual([]);

    // A root gone: refused the same way, nothing written.
    expect(run(join(root, "gone"), join(real, "gone")).status).toBe(
      ROOT_MOVED_EXIT,
    );
  });

  test("a root the transport's user cannot write, elevation refused, is unverified/not-writable", async ({
    playwright,
  }) => {
    test.skip(process.getuid?.() === 0, "root writes through any mode");
    web = await startProbeWebServer(root);
    chmodSync(root, 0o555);

    const result = await probeWebIdentity(
      { transport: local(), baseURL: web.baseURL },
      playwright.request,
    );

    expect(result).toMatchObject({
      kind: "unverified",
      reason: "not-writable",
    });
    expect(result.kind === "unverified" ? result.detail : "").toMatch(
      /elevation is disabled/,
    );
    expect(web.requests).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  test("a probe file name that is not e2e-identity-<32 hex>.php, or a baseURL that is no URL, is refused before anything is written", async ({
    playwright,
  }) => {
    await expect(
      probeWebIdentity(
        { transport: local(), baseURL: "http://127.0.0.1:9" },
        playwright.request,
        { name: "../index.php" },
      ),
    ).rejects.toThrow(/32 hex/);
    await expect(
      probeWebIdentity(
        { transport: local(), baseURL: "not a url" },
        playwright.request,
      ),
    ).rejects.toThrow(TypeError);
    expect(readdirSync(root)).toEqual([]);
  });

  test("checkWebIdentity puts the docroot's owner and the web server's answer into a verdict", async ({
    playwright,
  }) => {
    // A `stat` answering as GNU's would for a www-data docroot, whatever this runner's `stat` is.
    const bin = mkdtempSync(join(tmpdir(), "web-identity-bin-"));
    writeFileSync(
      join(bin, "stat"),
      "#!/bin/sh\necho www-data:www-data:33:33\n",
      { mode: 0o755 },
    );
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    try {
      web = await startProbeWebServer(root);
      const site = { transport: local(), baseURL: web.baseURL };
      const owner = { user: "www-data", group: "www-data", uid: 33, gid: 33 };

      await expect(checkWebIdentity(site, playwright.request)).resolves.toEqual(
        {
          verdict: "owner-is-web",
          owner,
          web: WEB,
        },
      );
      web.identity = { ...web.identity, euid: 1001, user: "sftp_x" };
      await expect(
        checkWebIdentity(site, playwright.request),
      ).resolves.toMatchObject({
        verdict: "owner-not-web",
        owner,
        web: { euid: 1001, user: "sftp_x" },
      });
    } finally {
      process.env.PATH = path;
      removeTempDir(bin);
    }
  });

  test("real PHP runs the probe and reports this process's identity", async ({
    playwright,
  }) => {
    test.skip(spawnSync("php", ["-v"]).status !== 0, "no php on this runner");
    const port = await closedPort();
    // Tethered, so a killed worker cannot leave PHP serving; the umask gives the probe one to report.
    const php = spawnTethered('umask 0027 && exec php -S "$0" -t "$1"', [
      `127.0.0.1:${String(port)}`,
      root,
    ]);
    try {
      const baseURL = `http://127.0.0.1:${String(port)}`;
      await expect
        .poll(
          async () => (await fetch(baseURL).catch(() => undefined))?.status,
          { timeout: 10_000 },
        )
        .toBeDefined();

      const result = await probeWebIdentity(
        { transport: local(), baseURL },
        playwright.request,
      );

      const hasPosix = spawnSync("php", [
        "-r",
        "echo function_exists('posix_geteuid') ? 1 : 0;",
      ]);
      if (hasPosix.stdout.toString() !== "1") {
        expect(result).toMatchObject({
          kind: "unverified",
          reason: "no-posix",
        });
        return;
      }
      expect(result).toMatchObject({
        kind: "identified",
        identity: {
          euid: process.geteuid?.(),
          egid: process.getegid?.(),
          umask: "0027",
          sapi: "cli-server",
        },
      });
      expect(readdirSync(root)).toEqual([]);
    } finally {
      killTethered(php);
    }
  });
});

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

// ── The verdict file ─────────────────────────────────────────────────────────────────────────────

test.describe("the verdict file", () => {
  let dir = "";
  const RUN = "2026-11-10T10-00-00-000Z-1";
  const owner = { user: "www-data", group: "www-data", uid: 33, gid: 33 };
  const verdicts = new Map<string, SiteIdentityVerdict>([
    [
      installKey({
        mode: "ssh",
        host: "h",
        username: "u",
        privateKeyPath: "/k",
        rootDir: "/r",
      }),
      { verdict: "owner-is-web", owner, web: WEB },
    ],
    [
      "ssh:u@h#/k#/other",
      {
        verdict: "owner-not-web",
        owner: { ...owner, uid: 1001, user: "sftp" },
        web: WEB,
      },
    ],
    [
      "local:/x",
      {
        verdict: "unverified",
        reason: "not-served",
        detail: "HTTP 404",
        owner,
      },
    ],
    [
      "local:/y",
      { verdict: "unverified", reason: "no-owner", detail: "unreadable" },
    ],
  ]);

  test.beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "site-identity-file-"));
  });

  test.afterEach(() => {
    removeTempDir(dir);
  });

  test("round-trips every verdict for its own run, written 0600 with nothing but verdicts", async () => {
    const path = await writeSiteIdentityFile(join(dir, "auth"), RUN, verdicts);

    expect(path).toBe(join(dir, "auth", SITE_IDENTITY_FILE));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(
      Object.keys(JSON.parse(readFileSync(path, "utf8")) as object),
    ).toEqual(["version", "runId", "sites"]);
    expect(readdirSync(join(dir, "auth"))).toEqual([SITE_IDENTITY_FILE]);
    await expect(readSiteIdentityFile(join(dir, "auth"), RUN)).resolves.toEqual(
      {
        kind: "read",
        verdicts,
      },
    );
  });

  test("a web identity without names round-trips: both missing, or one", async () => {
    const { user: _user, group: _group, ...unnamed } = WEB;
    const { group: _onlyGroup, ...userOnly } = WEB;
    const nameless = new Map<string, SiteIdentityVerdict>([
      ["local:/a", { verdict: "owner-not-web", owner, web: unnamed }],
      ["local:/b", { verdict: "owner-is-web", owner, web: userOnly }],
    ]);
    await writeSiteIdentityFile(dir, RUN, nameless);

    await expect(readSiteIdentityFile(dir, RUN)).resolves.toEqual({
      kind: "read",
      verdicts: nameless,
    });
    // The probe's own `null`s, as a hand-written file might carry them, read the same.
    expect(
      parseSiteIdentityFile(
        {
          version: 1,
          runId: RUN,
          sites: {
            k: {
              verdict: "owner-is-web",
              owner,
              web: { ...unnamed, user: null, group: null },
            },
          },
        },
        RUN,
      ),
    ).toEqual({
      kind: "read",
      verdicts: new Map([
        ["k", { verdict: "owner-is-web", owner, web: unnamed }],
      ]),
    });
  });

  test("a file that cannot be read is invalid, not missing", async () => {
    mkdirSync(join(dir, SITE_IDENTITY_FILE));
    await expect(readSiteIdentityFile(dir, RUN)).resolves.toMatchObject({
      kind: "invalid",
      why: expect.stringMatching(/^unreadable: /),
    });
  });

  test("a write that cannot land throws and leaves no temporary file", async () => {
    // A non-empty directory where the file goes: the rename fails after the temporary is written.
    mkdirSync(join(dir, SITE_IDENTITY_FILE));
    writeFileSync(join(dir, SITE_IDENTITY_FILE, "keep"), "x");

    await expect(writeSiteIdentityFile(dir, RUN, verdicts)).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([SITE_IDENTITY_FILE]);
    expect(readdirSync(join(dir, SITE_IDENTITY_FILE))).toEqual(["keep"]);
  });

  test("a write replaces what is there by rename: a new 0600 file, a symlink's target untouched", async () => {
    const path = join(dir, SITE_IDENTITY_FILE);
    writeFileSync(path, "old", { mode: 0o644 });
    await writeSiteIdentityFile(dir, RUN, verdicts);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    const outside = join(dir, "outside.json");
    writeFileSync(outside, "outside");
    rmSync(path);
    symlinkSync(outside, path);
    await writeSiteIdentityFile(dir, RUN, verdicts);

    expect(lstatSync(path).isSymbolicLink()).toBe(false);
    expect(readFileSync(outside, "utf8")).toBe("outside");
    await expect(readSiteIdentityFile(dir, RUN)).resolves.toMatchObject({
      kind: "read",
    });
  });

  test("another run's file is stale, a missing one missing", async () => {
    await writeSiteIdentityFile(dir, RUN, verdicts);
    await expect(readSiteIdentityFile(dir, "other-run")).resolves.toEqual({
      kind: "stale",
      runId: RUN,
    });
    await expect(readSiteIdentityFile(join(dir, "none"), RUN)).resolves.toEqual(
      { kind: "missing" },
    );
  });

  test("a file that is not JSON is invalid, never a throw", async () => {
    writeFileSync(join(dir, SITE_IDENTITY_FILE), "{");
    await expect(readSiteIdentityFile(dir, RUN)).resolves.toEqual({
      kind: "invalid",
      why: "not JSON",
    });
  });

  const good = { verdict: "owner-is-web", owner, web: WEB };
  for (const [label, doc] of [
    ["another version", { version: 2, runId: RUN, sites: {} }],
    ["no runId", { version: 1, sites: {} }],
    ["no sites", { version: 1, runId: RUN }],
    [
      "an unknown verdict",
      { version: 1, runId: RUN, sites: { k: { ...good, verdict: "maybe" } } },
    ],
    [
      "an unknown reason",
      {
        version: 1,
        runId: RUN,
        sites: { k: { verdict: "unverified", reason: "x", detail: "" } },
      },
    ],
    [
      "an identified verdict without its owner",
      {
        version: 1,
        runId: RUN,
        sites: { k: { verdict: "owner-is-web", web: WEB } },
      },
    ],
    [
      "a malformed owner",
      {
        version: 1,
        runId: RUN,
        sites: { k: { ...good, owner: { ...owner, uid: -1 } } },
      },
    ],
    [
      "a malformed web identity",
      {
        version: 1,
        runId: RUN,
        sites: { k: { ...good, web: { ...WEB, umask: 22 } } },
      },
    ],
    [
      "a detail that is not text",
      {
        version: 1,
        runId: RUN,
        sites: {
          k: { verdict: "unverified", reason: "not-served", detail: 404 },
        },
      },
    ],
  ] as const) {
    test(`a file with ${label} is invalid`, () => {
      expect(parseSiteIdentityFile(doc, RUN)).toMatchObject({
        kind: "invalid",
      });
    });
  }
});
