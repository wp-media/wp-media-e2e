import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer, type RequestListener } from "node:http";
import { createServer as createTlsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { gzipSync } from "node:zlib";

import { removeTempDir } from "./temp-dir";

/**
 * For specs: a web server standing in for a site's, serving the identity probe from a folder. It
 * answers a GET for a file that exists there with a fixed JSON identity, as PHP would run the probe —
 * recording what the file held and its mode at that moment — or with whatever a spec asks for instead
 * (a status, an HTML page). Listens on `127.0.0.1`, any free port, over HTTP or (given a certificate)
 * HTTPS; {@link ProbeWebServer.close} stops it.
 */

/** What the server answers with. */
export type ProbeReply =
  /** The probe's JSON for {@link ProbeWebServer.identity}, when the file exists (else 404). */
  | "probe"
  /**
   * This status and body, whatever was asked: gzip-encoded (`Content-Length` the compressed size), or
   * chunked (no `Content-Length`), when asked.
   */
  | {
      readonly status: number;
      readonly body: string | Buffer;
      readonly type?: string;
      readonly encoding?: "gzip" | "chunked";
    };

/** One request the server received. */
export interface ProbeRequest {
  /** The request's path. */
  readonly path: string;
  /** The served file's text, when it existed. */
  readonly content?: string;
  /** Its mode's permission bits, when it existed. */
  readonly mode?: number;
}

/** A running probe web server. */
export interface ProbeWebServer {
  /** `http://127.0.0.1:<port>`, plus the path it was started with. */
  readonly baseURL: string;
  /** Every request, oldest first. */
  readonly requests: readonly ProbeRequest[];
  /** What the next requests get; `"probe"` by default. */
  reply: ProbeReply;
  /** The identity `"probe"` answers with (extra fields are passed through). */
  identity: Record<string, unknown>;
  /** Stops listening. */
  close(): Promise<void>;
}

/** A certificate and its key, PEM. */
export interface TlsIdentity {
  readonly key: string;
  readonly cert: string;
}

/**
 * A self-signed certificate for `127.0.0.1`, valid a day, made with the `openssl` CLI.
 *
 * @returns it, or `undefined` when `openssl` is not installed.
 */
export function selfSignedCertificate(): TlsIdentity | undefined {
  const dir = mkdtempSync(join(tmpdir(), "probe-tls-"));
  try {
    const made = spawnSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-subj",
        "/CN=127.0.0.1",
        "-days",
        "1",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
    if (made.status !== 0) return undefined;
    return {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
  } finally {
    removeTempDir(dir);
  }
}

/**
 * Writes a {@link ProbeReply} that is not `"probe"`.
 *
 * @param response - the response.
 * @param reply - what to send.
 */
function sendReply(
  response: Parameters<RequestListener>[1],
  reply: Exclude<ProbeReply, "probe">,
): void {
  const headers: Record<string, string> = {
    "content-type": reply.type ?? "text/html",
  };
  if (reply.encoding === "gzip") {
    const body = gzipSync(reply.body);
    headers["content-encoding"] = "gzip";
    headers["content-length"] = String(body.length);
    response.writeHead(reply.status, headers).end(body);
    return;
  }
  response.writeHead(reply.status, headers);
  // A write before `end` makes Node send the body chunked, with no length.
  if (reply.encoding === "chunked") response.write(reply.body);
  response.end(reply.encoding === "chunked" ? undefined : reply.body);
}

/**
 * Starts a probe web server for `root`.
 *
 * @param root - the folder standing in for the WordPress root.
 * @param basePath - the site's path (`/blog`), stripped from a request before the file is looked up.
 * @param tls - serve HTTPS with this certificate (`https://127.0.0.1:<port>`).
 */
export async function startProbeWebServer(
  root: string,
  basePath = "",
  tls?: TlsIdentity,
): Promise<ProbeWebServer> {
  const requests: ProbeRequest[] = [];
  const state: Pick<ProbeWebServer, "reply" | "identity"> = {
    reply: "probe",
    identity: {
      e2e: "identity",
      euid: 33,
      egid: 33,
      user: "www-data",
      group: "www-data",
      umask: "0022",
      sapi: "fpm-fcgi",
    },
  };
  const listener: RequestListener = (request, response) => {
    const path = new URL(request.url ?? "/", "http://x").pathname;
    const relative = path.startsWith(`${basePath}/`)
      ? path.slice(basePath.length + 1)
      : undefined;
    const file =
      relative === undefined ? undefined : join(root, posix.basename(relative));
    let seen: ProbeRequest = { path };
    try {
      // A regular file only: reading a FIFO a spec planted would block this whole process.
      const stats = file === undefined ? undefined : statSync(file);
      if (
        file !== undefined &&
        stats?.isFile() === true &&
        relative === posix.basename(relative ?? "")
      ) {
        seen = {
          path,
          content: readFileSync(file, "utf8"),
          mode: stats.mode & 0o777,
        };
      }
    } catch {
      // Not there: a 404 below.
    }
    requests.push(seen);
    const { reply } = state;
    if (reply !== "probe") {
      sendReply(response, reply);
      return;
    }
    if (seen.content === undefined) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(state.identity));
  };
  const server =
    tls === undefined ? createServer(listener) : createTlsServer(tls, listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return Object.assign(state, {
    baseURL: `${tls === undefined ? "http" : "https"}://127.0.0.1:${String(port)}${basePath}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  });
}
