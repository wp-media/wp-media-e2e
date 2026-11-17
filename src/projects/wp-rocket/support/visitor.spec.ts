import { test, expect, type APIRequestContext } from "@playwright/test";

import { ENDING_CHARS, AnonymousVisitor } from "./visitor";

/** A fake client answering every GET with `body` and `status`, counting what was opened and disposed. */
function fakeClients(
  replies: readonly { readonly status: number; readonly body: string }[],
): {
  readonly open: () => Promise<APIRequestContext>;
  readonly opened: () => number;
  readonly disposed: () => number;
  readonly paths: string[];
} {
  let opened = 0;
  let disposed = 0;
  const paths: string[] = [];
  return {
    open: () => {
      const reply = replies[opened];
      opened += 1;
      const client = {
        get: (path: string) => {
          paths.push(path);
          if (reply === undefined)
            return Promise.reject(new Error("unreachable"));
          return Promise.resolve({
            status: () => reply.status,
            text: () => Promise.resolve(reply.body),
          });
        },
        dispose: () => {
          disposed += 1;
          return Promise.resolve();
        },
      };
      return Promise.resolve(client as unknown as APIRequestContext);
    },
    opened: () => opened,
    disposed: () => disposed,
    paths,
  };
}

const CACHED =
  "<html></html>\n<!-- This website is like a Rocket, isn't it? Performance optimized by WP Rocket. Learn more: https://wp-rocket.me - Debug: cached@100 -->";

test.describe("AnonymousVisitor", () => {
  test("records each visit with its status, footprint and ending, one fresh client per visit", async () => {
    const clients = fakeClients([
      { status: 200, body: "<html>plain</html>" },
      { status: 200, body: CACHED },
    ]);
    const visitor = new AnonymousVisitor(clients.open);
    await visitor.open("/");
    const second = await visitor.open("/about/");
    expect(second).toEqual({
      path: "/about/",
      status: 200,
      footprint: { kind: "cached", cachedAt: 100 },
      ending: CACHED.slice(-ENDING_CHARS),
    });
    expect(visitor.visits.map((visit) => visit.footprint.kind)).toEqual([
      "none",
      "cached",
    ]);
    expect(clients.paths).toEqual(["/", "/about/"]);
    expect([clients.opened(), clients.disposed()]).toEqual([2, 2]);
  });

  test("a peek is not recorded", async () => {
    const clients = fakeClients([{ status: 503, body: "busy" }]);
    const visitor = new AnonymousVisitor(clients.open);
    expect((await visitor.peek("/")).status).toBe(503);
    expect(visitor.visits).toEqual([]);
  });

  test("keeps only the page's end", async () => {
    const body = `${"x".repeat(1000)}END`;
    const visitor = new AnonymousVisitor(
      fakeClients([{ status: 200, body }]).open,
    );
    const visit = await visitor.open("/");
    expect(visit.ending).toHaveLength(ENDING_CHARS);
    expect(visit.ending.endsWith("END")).toBe(true);
  });

  test("a failed request is thrown, unrecorded, and its client still disposed", async () => {
    const clients = fakeClients([]);
    const visitor = new AnonymousVisitor(clients.open);
    await expect(visitor.open("/")).rejects.toThrow("unreachable");
    expect(visitor.visits).toEqual([]);
    expect(clients.disposed()).toBe(1);
  });
});
