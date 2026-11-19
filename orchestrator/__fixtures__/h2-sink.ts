import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  createSecureServer,
  type Http2ServerRequest,
  type Http2ServerResponse,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * A local HTTPS server speaking HTTP/2 only (`allowHTTP1: false`), standing in for Slack or Datator
 * as Node's `fetch` reaches them: Undici negotiates h2 by ALPN, which the plain-HTTP `http-sink.ts`
 * never exercises. Its certificate is a throwaway one made at test time by `openssl`, trusted by a
 * child Node through `NODE_EXTRA_CA_CERTS` — verification stays on.
 */

const execFileAsync = promisify(execFile);

/** A throwaway self-signed certificate for `127.0.0.1`, as PEM files and their text. */
export interface TestCert {
  /** The certificate's file: what `NODE_EXTRA_CA_CERTS` names. */
  readonly certPath: string;
  /** The certificate's PEM text, served by the sink. */
  readonly cert: string;
  /** Its private key's PEM text (unencrypted). */
  readonly key: string;
}

/**
 * Makes a one-day self-signed P-256 certificate for `127.0.0.1` (IP SAN: a hostname check would
 * refuse a CN alone) in `dir`, which the caller removes. Works with OpenSSL 3+ and LibreSSL 3.3+.
 *
 * @param dir - a private temporary folder.
 * @returns the certificate, or `undefined` when no `openssl` is on `PATH`.
 * @throws {@link Error} when `openssl` is there but fails.
 */
export async function makeTestCert(dir: string): Promise<TestCert | undefined> {
  const certPath = join(dir, "cert.pem");
  const keyPath = join(dir, "key.pem");
  try {
    await execFileAsync("openssl", [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ]);
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    throw error;
  }
  const [cert, key] = await Promise.all([
    readFile(certPath, "utf8"),
    readFile(keyPath, "utf8"),
  ]);
  return { certPath, cert, key };
}

/** A request the h2 sink received. */
export interface H2Request {
  /** The request's path and query (`:path`): a Slack URL's credential. */
  readonly path: string;
  /** `"2.0"` for HTTP/2: the point of this sink. */
  readonly httpVersion: string;
  /** The request body, read whole, as UTF-8. */
  readonly body: string;
  /**
   * `Date.now()` once the body was read, just before the answer starts: timings measured from it
   * leave out the client's own start-up.
   */
  readonly receivedAt: number;
  /** Settles with `Date.now()` when the request's stream closes, whoever closed it. */
  readonly closed: Promise<number>;
}

/** What answers a request: may leave the response open. */
export type H2Answer = (
  request: H2Request,
  response: Http2ServerResponse,
) => void;

/** A running h2 sink. */
export interface H2Sink {
  /** Its base URL, `https://127.0.0.1:<port>`. */
  readonly url: string;
  /** What it received, in order. */
  readonly requests: H2Request[];
  /** Stops it, destroying every open session. */
  close(): Promise<void>;
}

/**
 * Starts an HTTP/2-only TLS server on `127.0.0.1`, answering each request with `answer` (looked up
 * per request, so a test may swap it) once its body is read.
 *
 * @param cert - its certificate and key.
 * @param answer - writes each answer.
 * @returns the sink, listening.
 */
export async function startH2Sink(
  cert: TestCert,
  answer: () => H2Answer,
): Promise<H2Sink> {
  const requests: H2Request[] = [];
  const server = createSecureServer(
    { cert: cert.cert, key: cert.key, allowHTTP1: false },
    (incoming: Http2ServerRequest, response: Http2ServerResponse) => {
      const closed = new Promise<number>((resolve) =>
        incoming.stream.once("close", () => {
          resolve(Date.now());
        }),
      );
      const chunks: Buffer[] = [];
      incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
      incoming.on("end", () => {
        const request: H2Request = {
          receivedAt: Date.now(),
          path: incoming.url,
          httpVersion: incoming.httpVersion,
          body: Buffer.concat(chunks).toString("utf8"),
          closed,
        };
        requests.push(request);
        answer()(request, response);
      });
    },
  );
  // A session the client resets (a cancelled read) must not crash the spec's worker.
  server.on("sessionError", () => undefined);
  const sessions = new Set<{ destroy(): void }>();
  server.on("session", (session) => {
    sessions.add(session);
    session.once("close", () => sessions.delete(session));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${String(port)}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const session of sessions) session.destroy();
        server.close(() => {
          resolve();
        });
      }),
  };
}
