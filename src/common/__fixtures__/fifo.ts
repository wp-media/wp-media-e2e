import { spawnSync } from "node:child_process";
import { closeSync, constants, openSync, readSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

import { errnoCode } from "../reporting/report-tree";

/**
 * For specs that hold code under test on a FIFO (`mkfifo`): its blocking `open` for reading waits
 * until something opens the FIFO for writing, so a spec decides when that read may go on, no sleeps.
 */

/** How long {@link releaseFifoReader} waits for a reader by default: far past any healthy one. */
export const FIFO_READER_TIMEOUT_MS = 5_000;

/** The pause between two attempts to open the FIFO for writing. */
const RETRY_MS = 5;

/**
 * Lets a FIFO's reader go on: opens the FIFO for writing once something has it open for reading,
 * then closes it, so the reader's `open` returns and its read sees end of file.
 *
 * @param path - the FIFO.
 * @param timeoutMs - how long to wait for a reader; default {@link FIFO_READER_TIMEOUT_MS}.
 * @throws as {@link openFifoWriter}.
 */
export async function releaseFifoReader(
  path: string,
  timeoutMs = FIFO_READER_TIMEOUT_MS,
): Promise<void> {
  await (await openFifoWriter(path, timeoutMs)).close();
}

/**
 * Opens a FIFO for writing once something has it open for reading: the reader's `open` returns and
 * its reads wait for what the spec writes, until the handle is closed (end of file).
 *
 * A plain `open(path, "w")` would wait for that reader forever, in a libuv thread no test timeout
 * frees: code that regressed into never reading hung its spec for minutes. `O_RDWR` never blocks, but
 * neither does it wait: closed before the reader opens, it leaves that reader blocked instead. So
 * `O_WRONLY | O_NONBLOCK`, which fails with `ENXIO` while no reader has the FIFO open (a reader blocked
 * in its own `open` counts, on macOS and Linux alike), retried until `timeoutMs`. Writes are
 * non-blocking: keep each under the pipe's buffer (a few KiB is safe).
 *
 * @param path - the FIFO.
 * @param timeoutMs - how long to wait for a reader; default {@link FIFO_READER_TIMEOUT_MS}.
 * @returns the open handle; the caller closes it.
 * @throws Error naming the FIFO when nothing opened it for reading in time; the open's own error when
 *   it fails for another reason (not a FIFO, missing).
 */
export async function openFifoWriter(
  path: string,
  timeoutMs = FIFO_READER_TIMEOUT_MS,
): Promise<FileHandle> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await open(path, constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (error) {
      if (errnoCode(error) !== "ENXIO") throw error;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Nothing opened the FIFO ${path} for reading within ${String(timeoutMs)} ms.`,
      );
    }
    await delay(RETRY_MS);
  }
}

/** A FIFO with this process holding its read end: what {@link tapFifo} returns. */
export interface FifoTap {
  /** Everything written into the FIFO so far, as text; `""` when nothing was. */
  drain(): string;
  /** Closes the read end. */
  close(): void;
}

/**
 * Creates a FIFO at `path` (`mkfifo`) and holds its read end open, non-blocking, so a writer's `open`
 * returns at once and what it writes waits in the pipe — never blocking a writer, never left behind
 * as a process. For proving that nothing was written through a path that leads to it.
 *
 * @param path - where to create the FIFO; must not exist.
 * @returns the tap; the caller closes it.
 * @throws Error when `mkfifo` fails.
 */
export function tapFifo(path: string): FifoTap {
  const made = spawnSync("mkfifo", [path], { stdio: "ignore" });
  if (made.status !== 0) throw new Error(`mkfifo ${path} failed.`);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  return {
    drain() {
      const chunks: Buffer[] = [];
      const buffer = Buffer.alloc(65_536);
      for (;;) {
        let read: number;
        try {
          read = readSync(fd, buffer);
        } catch (error) {
          // EAGAIN: open for writing by someone, but empty for now.
          if (errnoCode(error) === "EAGAIN") break;
          throw error;
        }
        if (read === 0) break;
        chunks.push(Buffer.from(buffer.subarray(0, read)));
      }
      return Buffer.concat(chunks).toString("utf8");
    },
    close() {
      closeSync(fd);
    },
  };
}
