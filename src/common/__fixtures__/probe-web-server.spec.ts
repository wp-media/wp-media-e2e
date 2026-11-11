import { test, expect } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startProbeWebServer } from "./probe-web-server";
import { removeTempDir } from "./temp-dir";

/**
 * The probe web server serves regular files only: a FIFO at a probe's path is a 404, never read —
 * reading one blocks until something writes to it, freezing the whole spec process.
 */

test("a GET of a FIFO is a 404 and never reads it", async ({ playwright }) => {
  const root = mkdtempSync(join(tmpdir(), "probe-web-server-"));
  const web = await startProbeWebServer(root);
  const fifo = join(root, "probe.php");
  execFileSync("mkfifo", [fifo]);
  // A writer, so a server that did read the FIFO would get an answer instead of hanging the spec.
  const writer = spawn("/bin/sh", ["-c", 'printf "<?php" > "$0"', fifo], {
    stdio: "ignore",
  });
  const request = await playwright.request.newContext();
  try {
    const response = await request.get(`${web.baseURL}/probe.php`);

    expect(response.status()).toBe(404);
    expect(web.requests).toEqual([{ path: "/probe.php" }]);
  } finally {
    await request.dispose();
    writer.kill("SIGKILL");
    await web.close();
    removeTempDir(root);
  }
});
