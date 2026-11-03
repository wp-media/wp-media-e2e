import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { releaseFifoReader } from "./fifo";

/** The FIFO release the Allure specs block their code under test on. */

let dir = "";

test.beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "e2e-fifo-"));
});

test.afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/**
 * Makes a FIFO in the spec's folder.
 *
 * @returns its path.
 */
function makeFifo(): string {
  const fifo = join(dir, "fifo");
  execFileSync("mkfifo", [fifo]);
  return fifo;
}

test("a reader blocked in its open goes on and reads end of file", async () => {
  const fifo = makeFifo();
  const reading = readFile(fifo, "utf8");

  await releaseFifoReader(fifo);

  expect(await reading).toBe("");
});

test("a reader that opens only after the first attempts is still waited for", async () => {
  const fifo = makeFifo();
  const releasing = releaseFifoReader(fifo);
  // Several retries in: the reader arrives late, as code under test does after its own awaits.
  await new Promise((settle) => setTimeout(settle, 50));
  const reading = readFile(fifo, "utf8");

  await releasing;

  expect(await reading).toBe("");
});

test("no reader fails within its deadline, naming the FIFO, instead of hanging", async () => {
  const fifo = makeFifo();
  const started = Date.now();

  await expect(releaseFifoReader(fifo, 100)).rejects.toThrow(
    `Nothing opened the FIFO ${fifo} for reading within 100 ms.`,
  );
  expect(Date.now() - started).toBeLessThan(2_000);
});

test("a path that is missing fails with the open's own error, at once", async () => {
  await expect(
    releaseFifoReader(join(dir, "absent"), 60_000),
  ).rejects.toMatchObject({
    code: "ENOENT",
  });
});

test("a regular file is opened and closed at once, never waited on", async () => {
  const file = join(dir, "file");
  writeFileSync(file, "kept");

  await releaseFifoReader(file, 60_000);

  expect(await readFile(file, "utf8")).toBe("kept");
});
