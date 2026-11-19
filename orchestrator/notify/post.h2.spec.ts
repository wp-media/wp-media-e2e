import { test, expect } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  execInChildNode,
  importable,
} from "../../src/common/__fixtures__/child-node";
import { removeTempDir } from "../../src/common/__fixtures__/temp-dir";
import {
  makeTestCert,
  startH2Sink,
  type H2Answer,
  type H2Sink,
  type TestCert,
} from "../__fixtures__/h2-sink";
import { MAX_ANSWER_BYTES, MAX_DETAIL, type Delivery } from "./post";

/**
 * `postJson` over HTTPS and HTTP/2, as the global `fetch` (Undici, h2 by ALPN) reaches Slack and
 * Datator; `post.spec.ts` covers the rest over plain HTTP/1.1. Each post runs in a child Node that
 * trusts the throwaway certificate through `NODE_EXTRA_CA_CERTS` — this worker's TLS settings stay
 * untouched, and verification on.
 */

/** The module under test, for the child's `import()`. */
const POST_MODULE = join(import.meta.dirname, "post.ts");

/** A Slack-shaped webhook secret: the URL's last segment, also echoed back by one answer. */
const SECRET = "hook-secret-1234567890";

/** The child's post: Slack's acceptance, its secret masked, a time limit well inside the test's. */
const CHILD_BODY = `
import { postJson } from ${importable(POST_MODULE)};
const sent = await postJson(process.env.H2_URL, { text: "hi" }, {
  timeoutMs: 5000,
  accept: (status, body) => status === 200 && body === "ok",
  secrets: [process.env.H2_SECRET],
});
console.log(JSON.stringify(sent));
`;

/** The private temporary folder holding the certificate, removed after all tests. */
let dir = "";
/** The throwaway certificate; `undefined` when no `openssl` could make one (local runs skip). */
let cert: TestCert | undefined;
/** The h2 sink every test posts to, started once the certificate exists. */
let server: H2Sink | undefined;
/** What the sink answers, set by each test. */
let answer: H2Answer = (_request, response) => response.end();
/** Kills a test's child if the test ends first. */
let stop = new AbortController();

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "e2e-h2-"));
  cert = await makeTestCert(dir);
  // On CI a skip would pass vacuously: the HTTP/2 path would go untested unnoticed.
  if (cert === undefined && process.env.CI)
    throw new Error("openssl is required on CI to make the test certificate");
  if (cert !== undefined) server = await startH2Sink(cert, () => answer);
});

test.beforeEach(() => {
  test.skip(
    cert === undefined,
    "no openssl on PATH to make a test certificate",
  );
  stop = new AbortController();
});

test.afterEach(() => {
  stop.abort();
});

test.afterAll(async () => {
  await server?.close();
  removeTempDir(dir);
});

/**
 * Posts to the sink from a child Node.
 *
 * @param trust - whether the child trusts the test certificate.
 * @returns the child's {@link Delivery}, and the URL it posted to.
 */
async function postFromChild(
  trust = true,
): Promise<{ sent: Delivery; url: string }> {
  if (server === undefined || cert === undefined) throw new Error("no h2 sink");
  const url = `${server.url}/services/T0/B0/${SECRET}`;
  const { stdout } = await execInChildNode(CHILD_BODY, {
    cwd: import.meta.dirname,
    signal: stop.signal,
    diesWithParent: true,
    env: {
      H2_URL: url,
      H2_SECRET: SECRET,
      ...(trust ? { NODE_EXTRA_CA_CERTS: cert.certPath } : {}),
    },
  });
  const sent = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as Delivery;
  // Neither the URL (its path is the credential) nor the secret may reach a message.
  if (!sent.ok) {
    expect(sent.detail).not.toContain(server.url);
    expect(sent.detail).not.toContain(SECRET);
  }
  return { sent, url };
}

test.describe("postJson over HTTPS and HTTP/2", () => {
  test("accepts Slack's 200 ok, received by the server as an HTTP/2 POST of the JSON body", async () => {
    answer = (_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
    };
    const { sent } = await postFromChild();
    expect(sent).toEqual({ ok: true, status: 200 });
    const request = server?.requests.at(-1);
    expect(request?.httpVersion).toBe("2.0");
    expect(request?.path).toBe(`/services/T0/B0/${SECRET}`);
    expect(JSON.parse(request?.body ?? "")).toEqual({ text: "hi" });
  });

  test("reports Slack's 404 no_team with its status and its body as the detail", async () => {
    answer = (_request, response) => {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("no_team");
    };
    const { sent } = await postFromChild();
    expect(sent).toEqual({ ok: false, status: 404, detail: "no_team" });
    expect(server?.requests.at(-1)?.httpVersion).toBe("2.0");
  });

  test("masks a secret the answer echoes", async () => {
    answer = (_request, response) => {
      response.writeHead(403);
      response.end(`invalid_token ${SECRET}`);
    };
    const { sent } = await postFromChild();
    expect(sent).toEqual({
      ok: false,
      status: 403,
      detail: "invalid_token ***",
    });
  });

  test("reads an endless answer only up to its cap, then closes the stream", async () => {
    let written = 0;
    answer = (_request, response) => {
      response.writeHead(500);
      const chunk = "x".repeat(1024);
      /** Writes chunks until backpressure, then again on `drain`, until the client resets the stream. */
      const pump = (): void => {
        while (!response.stream.destroyed && response.write(chunk))
          written += chunk.length;
        if (!response.stream.destroyed) response.once("drain", pump);
      };
      pump();
    };
    const { sent } = await postFromChild();
    expect(sent).toMatchObject({ ok: false, status: 500 });
    // The cut answer's start, its tail withheld, at most MAX_DETAIL code points.
    expect(!sent.ok && sent.detail).toMatch(/^x+…?$/);
    expect(!sent.ok && Array.from(sent.detail).length).toBeLessThanOrEqual(
      MAX_DETAIL,
    );
    expect(written).toBeGreaterThan(MAX_ANSWER_BYTES);
    const request = server?.requests.at(-1);
    expect(request?.httpVersion).toBe("2.0");
    // Closed by the read, well before the 5 s time limit would abort it; timed from the sink's first
    // write, so the child's start-up does not count.
    if (request === undefined) throw new Error("the sink received no request");
    expect((await request.closed) - request.receivedAt).toBeLessThan(2_500);
  });

  test("refuses the certificate when the child does not trust it: verification stays on", async () => {
    answer = (_request, response) => {
      response.writeHead(200);
      response.end("ok");
    };
    const before = server?.requests.length;
    const { sent } = await postFromChild(false);
    expect(sent).toEqual({
      ok: false,
      detail: expect.stringMatching(
        /^request failed: (DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_VERIFY_LEAF_SIGNATURE)$/,
      ) as unknown,
    });
    expect(server?.requests.length).toBe(before);
  });
});
