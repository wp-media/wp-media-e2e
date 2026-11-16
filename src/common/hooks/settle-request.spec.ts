import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

import {
  ADMIN_PATH,
  FRONT_PATH,
  SETTLE_ALLOWANCE_MS,
  SETTLE_REQUEST_TIMEOUT_MS,
  adminLanding,
  adminResponseWarnings,
  settleAfterInstall,
  statusWarnings,
} from "./settle-request";
import type { SettleClient, SettleResponse } from "./settle-request";

/** A response at `path` of a fake site, with `status`. */
function response(path: string, status = 200): SettleResponse {
  return { url: () => `https://site.test${path}`, status: () => status };
}

/** What {@link fakeClient} records. */
interface FakeClient {
  readonly client: SettleClient;
  /** The paths asked, in order. */
  readonly calls: string[];
  /** Each request's timeout, in order. */
  readonly timeouts: number[];
  /** How often the client was disposed. */
  readonly disposed: () => number;
}

/** A fake client answering each path from `answers` (rejecting with an `Error` one), recording calls. */
function fakeClient(
  answers: Record<string, SettleResponse | Error>,
): FakeClient {
  const calls: string[] = [];
  const timeouts: number[] = [];
  let disposed = 0;
  const client: SettleClient = {
    get: (url, { timeout }) => {
      calls.push(url);
      timeouts.push(timeout);
      const answer = answers[url] ?? new Error(`unexpected request: ${url}`);
      return answer instanceof Error
        ? Promise.reject(answer)
        : Promise.resolve(answer);
    },
    dispose: () => {
      disposed += 1;
      return Promise.resolve();
    },
  };
  return { client, calls, timeouts, disposed: () => disposed };
}

/** A report recording its attachments. */
function reportSink(): {
  readonly title: string;
  readonly attached: Map<string, string>;
  attach: (name: string, body: string) => Promise<void>;
} {
  const attached = new Map<string, string>();
  return {
    title: "a scenario",
    attached,
    attach: (name, body) => {
      attached.set(name, body);
      return Promise.resolve();
    },
  };
}

let warnings: string[];
let realWarn: typeof console.warn;

test.beforeEach(() => {
  warnings = [];
  realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map(String).join(" "));
  };
});

test.afterEach(() => {
  console.warn = realWarn;
});

test.describe("adminLanding", () => {
  test("reads a path under /wp-admin/ as wp-admin, at the root or in a subfolder", () => {
    expect(adminLanding("https://site.test/wp-admin/")).toBe("admin");
    expect(adminLanding("https://site.test/wp-admin/index.php?x=1")).toBe(
      "admin",
    );
    expect(adminLanding("https://site.test/blog/wp-admin/")).toBe("admin");
  });

  test("reads wp-login.php as the login page, whatever its redirect_to says", () => {
    expect(
      adminLanding(
        "https://site.test/wp-login.php?redirect_to=https%3A%2F%2Fsite.test%2Fwp-admin%2F&reauth=1",
      ),
    ).toBe("login");
  });

  test("reads anything else — the front page, a bare /wp-admin, garbage — as elsewhere", () => {
    expect(adminLanding("https://site.test/")).toBe("elsewhere");
    expect(adminLanding("https://site.test/wp-admin")).toBe("elsewhere");
    expect(adminLanding("https://site.test/?wp-admin/")).toBe("elsewhere");
    // `/wp-admin/` in the query alone: only the path is read, never the whole URL.
    expect(adminLanding("https://site.test/maintenance?next=/wp-admin/")).toBe(
      "elsewhere",
    );
    expect(adminLanding("not a url")).toBe("elsewhere");
  });
});

test.describe("adminResponseWarnings", () => {
  test("says nothing for wp-admin answered 200", () => {
    expect(adminResponseWarnings(response("/wp-admin/"))).toEqual([]);
  });

  test("names the login page and both likely causes", () => {
    const [warning, ...rest] = adminResponseWarnings(
      response("/wp-login.php?redirect_to=x"),
    );
    expect(rest).toEqual([]);
    expect(warning).toMatch(/login page \(wp-login\.php\)/);
    expect(warning).toMatch(/@noauth/);
    expect(warning).toMatch(/expired/);
  });

  test("names where it ended outside wp-admin by path only, and an error status", () => {
    const said = adminResponseWarnings({
      url: () => "https://user:secret@site.test/maintenance?token=abc",
      status: () => 503,
    }).join("; ");
    expect(said).toMatch(/ended outside wp-admin, at \/maintenance/);
    expect(said).toMatch(/HTTP 503/);
    expect(said).not.toMatch(/secret|token|site\.test/);
  });

  test("warns about an error status in wp-admin", () => {
    expect(adminResponseWarnings(response("/wp-admin/", 500))).toEqual([
      "/wp-admin/ answered HTTP 500",
    ]);
  });
});

test.describe("budget", () => {
  test("allows two bounded requests plus a margin for the client's opening and disposal", () => {
    expect(SETTLE_REQUEST_TIMEOUT_MS).toBe(30_000);
    expect(SETTLE_ALLOWANCE_MS).toBe(2 * SETTLE_REQUEST_TIMEOUT_MS + 10_000);
  });
});

test.describe("statusWarnings", () => {
  test("warns from 400 up, never below", () => {
    expect(statusWarnings("/", 399)).toEqual([]);
    expect(statusWarnings("/", 200)).toEqual([]);
    expect(statusWarnings("/", 400)).toEqual(["/ answered HTTP 400"]);
  });
});

test.describe("settleAfterInstall", () => {
  test("a product without a settle opens nothing", async () => {
    let opened = 0;
    await settleAfterInstall(
      undefined,
      () => {
        opened += 1;
        return Promise.reject(new Error("never"));
      },
      reportSink(),
    );
    expect(opened).toBe(0);
    expect(warnings).toEqual([]);
  });

  test("asks wp-admin then the front page, each bounded, disposes the client, and says nothing when all is well", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: response("/wp-admin/"),
      [FRONT_PATH]: response("/"),
    });
    const report = reportSink();
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      report,
    );
    expect(fake.calls).toEqual(["/wp-admin/", "/"]);
    expect(fake.timeouts).toEqual([
      SETTLE_REQUEST_TIMEOUT_MS,
      SETTLE_REQUEST_TIMEOUT_MS,
    ]);
    expect(fake.disposed()).toBe(1);
    expect(warnings).toEqual([]);
    expect(report.attached.size).toBe(0);
  });

  test("a login page is warned, named with the scenario and attached, and the front page still asked", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: response("/wp-login.php?redirect_to=x"),
      [FRONT_PATH]: response("/"),
    });
    const report = reportSink();
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      report,
    );
    expect(fake.calls).toEqual(["/wp-admin/", "/"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[hooks\] before "a scenario", /);
    expect(warnings[0]).toMatch(/login page/);
    expect(report.attached.get("settle-request")).toBe(warnings[0]);
  });

  test("failed requests are warned with their first line, credentials masked, never thrown", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: new Error(
        "apiRequestContext.get: Timeout 30000ms exceeded.\nCall log:\n  - → GET https://u:p@site.test/wp-admin/",
      ),
      [FRONT_PATH]: new Error(
        "apiRequestContext.get: connect ECONNREFUSED https://admin:hunter2@site.test/",
      ),
    });
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      reportSink(),
    );
    const said = warnings.join("\n");
    expect(said).toMatch(
      /\/wp-admin\/ failed \(apiRequestContext\.get: Timeout 30000ms exceeded\.\)/,
    );
    expect(said).toMatch(
      /\/ failed \(apiRequestContext\.get: connect ECONNREFUSED/,
    );
    expect(said).not.toMatch(/Call log|u:p@|hunter2/);
    expect(fake.disposed()).toBe(1);
  });

  test("a failure's escape and control characters never reach the warning", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: new Error(
        "apiRequestContext.get: \u001b[2J\u001b]0;owned\u0007socket \u0000hang up\r",
      ),
      [FRONT_PATH]: response("/"),
    });
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      reportSink(),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(
      /\/wp-admin\/ failed \(apiRequestContext\.get: /,
    );
    expect(warnings[0]).toMatch(/socket/);
    // eslint-disable-next-line no-control-regex -- the point: none of them survives
    expect(warnings[0]).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  test("a credential split by a format character is still masked", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: new Error(
        "apiRequestContext.get: refused ghp_\u200bAbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
      ),
      [FRONT_PATH]: response("/"),
    });
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      reportSink(),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/refused \*\*\*/);
    expect(warnings[0]).not.toMatch(/AbCdEf/);
  });

  test("an error status on the front page is warned", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: response("/wp-admin/"),
      [FRONT_PATH]: response("/", 500),
    });
    await settleAfterInstall(
      "admin-request",
      () => Promise.resolve(fake.client),
      reportSink(),
    );
    expect(warnings.join("\n")).toMatch(/\/ answered HTTP 500/);
  });

  test("a client that cannot be opened, or none given, is a warning", async () => {
    await settleAfterInstall(
      "admin-request",
      () => Promise.reject(new Error("no storage state file")),
      reportSink(),
    );
    await settleAfterInstall("admin-request", undefined);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(
      /could not be opened \(no storage state file\)/,
    );
    expect(warnings[1]).toMatch(
      /^\[hooks\] after installing, .*no HTTP client/,
    );
  });

  test("a dispose or attachment that fails changes nothing", async () => {
    const fake = fakeClient({
      [ADMIN_PATH]: response("/wp-login.php"),
      [FRONT_PATH]: response("/"),
    });
    const client: SettleClient = {
      get: (url, options) => fake.client.get(url, options),
      dispose: () => Promise.reject(new Error("already closed")),
    };
    await settleAfterInstall("admin-request", () => Promise.resolve(client), {
      title: "a scenario",
      attach: () => Promise.reject(new Error("reporter gone")),
    });
    expect(warnings.join("\n")).toMatch(/login page/);
    expect(warnings.join("\n")).toMatch(
      /could not attach the settle-request report/,
    );
  });
});

// The client the Before hook opens — Playwright's request context, bound by `baseURL` and given the
// scenario's storage state — against a local site that sends a visitor without its cookie to
// wp-login.php, as WordPress does.
test.describe("settleAfterInstall over Playwright's request context", () => {
  let server: Server;
  let baseURL: string;
  let seen: string[];

  test.beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      seen.push(`${path} ${req.headers.cookie ?? "-"}`);
      if (
        path.startsWith("/wp-admin/") &&
        req.headers.cookie !== "logged_in=1"
      ) {
        res.writeHead(302, {
          location: `/wp-login.php?redirect_to=${encodeURIComponent(path)}`,
        });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<html></html>");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    baseURL = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  test.beforeEach(() => {
    seen = [];
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  });

  test("a saved login reaches wp-admin, then the front page, silently", async ({
    playwright,
  }) => {
    const storageState = {
      cookies: [
        {
          name: "logged_in",
          value: "1",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax" as const,
        },
      ],
      origins: [],
    };
    await settleAfterInstall(
      "admin-request",
      () => playwright.request.newContext({ baseURL, storageState }),
      reportSink(),
    );
    expect(seen).toEqual(["/wp-admin/ logged_in=1", "/ logged_in=1"]);
    expect(warnings).toEqual([]);
  });

  test("an empty session (@noauth) follows the redirect to wp-login.php and is warned", async ({
    playwright,
  }) => {
    await settleAfterInstall(
      "admin-request",
      () =>
        playwright.request.newContext({
          baseURL,
          storageState: { cookies: [], origins: [] },
        }),
      reportSink(),
    );
    expect(seen).toEqual([
      "/wp-admin/ -",
      "/wp-login.php?redirect_to=%2Fwp-admin%2F -",
      "/ -",
    ]);
    expect(warnings.join("\n")).toMatch(/login page \(wp-login\.php\)/);
  });
});
