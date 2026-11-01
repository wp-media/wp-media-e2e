import { Console } from "node:console";
import { PassThrough } from "node:stream";

import { test, expect } from "@playwright/test";

import { FakeTerminal } from "../__fixtures__/terminal-fakes";
import {
  bypassWriter,
  captureStdio,
  cutLines,
  MAX_PENDING_CHARS,
  toBytes,
  type StdioCaptureOptions,
} from "./stdio-capture";
import { openLiveTerminal } from "./stream";

/**
 * The stdio capture on fake streams: whole lines printed through the owner, partial lines held,
 * callbacks and return values kept, what the owner cannot print sent to the stream, no loop, and the
 * streams put back exactly — on restore, whatever happened before.
 */

/** A capture of `streams`, the lines it printed, and deferred callbacks run on demand. */
function harness(
  streams: readonly FakeTerminal[],
  print?: StdioCaptureOptions["print"],
) {
  const printed: string[][] = [];
  const deferred: (() => void)[] = [];
  const capture = captureStdio({
    streams: streams,
    print:
      print ??
      ((lines) => {
        printed.push([...lines]);
        return true;
      }),
    defer: (callback) => deferred.push(callback),
  });
  return { capture, printed, deferred };
}

/** Calls the stream's current `write` as a caller would. */
function write(stream: FakeTerminal, ...args: unknown[]): unknown {
  return (stream.write as (...a: unknown[]) => unknown)(...args);
}

test.describe("captureStdio — lines", () => {
  test("prints each whole line through the owner, holds a partial line until its end, drops a \\r before \\n", () => {
    const out = new FakeTerminal();
    const { printed } = harness([out]);
    write(out, "one\r\ntwo\nthr");
    write(out, "ee");
    expect(printed).toEqual([["one", "two"]]);
    write(out, "\n");
    expect(printed).toEqual([["one", "two"], ["three"]]);
    expect(out.chunks).toEqual([]);
  });

  test("joins a UTF-8 character split over two byte writes, and decodes text in its encoding", () => {
    const out = new FakeTerminal();
    const { printed } = harness([out]);
    const bytes = Buffer.from("é✔\n", "utf8");
    write(out, bytes.subarray(0, 1));
    write(out, bytes.subarray(1, 4));
    write(out, bytes.subarray(4));
    write(out, Buffer.from("hex\n").toString("hex"), "hex");
    write(out, Buffer.from("b64\n").toString("base64"), "base64");
    expect(printed.flat()).toEqual(["é✔", "hex", "b64"]);
  });

  test("an open line past the bound is printed as a line of its own", () => {
    const out = new FakeTerminal();
    const { printed } = harness([out]);
    write(out, "x".repeat(MAX_PENDING_CHARS));
    expect(printed).toEqual([]);
    write(out, "y");
    expect(printed).toEqual([[`${"x".repeat(MAX_PENDING_CHARS)}y`]]);
  });

  test("each stream keeps its own open line; a stream given twice is captured once", () => {
    const out = new FakeTerminal();
    const err = new FakeTerminal();
    const { capture, printed } = harness([out, err, out]);
    write(out, "out ");
    write(err, "err\n");
    write(out, "line\n");
    expect(printed).toEqual([["err"], ["out line"]]);
    capture.restore();
    // Captured once, so restored to the prototype's write, not to a first capture's.
    expect(Object.hasOwn(out, "write")).toBe(false);
  });

  test("console.* written to captured streams lands as lines", () => {
    const out = new FakeTerminal();
    const err = new FakeTerminal();
    const { printed } = harness([out, err]);
    const console = new Console({
      stdout: out as unknown as NodeJS.WritableStream,
      stderr: err as unknown as NodeJS.WritableStream,
    });
    console.log("a %s", "log");
    console.warn("a warning\nof two lines");
    expect(printed.flat()).toEqual(["a log", "a warning", "of two lines"]);
  });
});

test.describe("captureStdio — a write keeps its meaning", () => {
  test("returns true and calls its callback later, with no error, whichever argument holds it", () => {
    const out = new FakeTerminal();
    const { deferred } = harness([out]);
    const calls: unknown[] = [];
    expect(write(out, "a\n", (e: unknown) => calls.push(e))).toBe(true);
    expect(write(out, "b", "utf8", (e: unknown) => calls.push(e))).toBe(true);
    expect(calls).toEqual([]);
    for (const callback of deferred) callback();
    expect(calls).toEqual([null, null]);
  });

  test("what the stream itself would refuse goes to it unchanged: no text or bytes, an unknown encoding", () => {
    const out = new FakeTerminal();
    out.mode = "throw";
    const { printed } = harness([out]);
    expect(() => write(out, 42)).toThrow("write EIO");
    expect(() => write(out, "a\n", "klingon")).toThrow("write EIO");
    expect(printed).toEqual([]);
  });

  test("lines the owner cannot print (false, or a throw) go to the stream they were written to", () => {
    const out = new FakeTerminal();
    harness([out], () => false);
    write(out, "a\nb\npartial");
    expect(out.all).toBe("a\nb\n");
    const err = new FakeTerminal();
    harness([err], () => {
      throw new Error("dead");
    });
    write(err, "c\n");
    expect(err.all).toBe("c\n");
  });

  test("a write made while a line is printed goes straight to the stream: no loop", () => {
    const out = new FakeTerminal();
    let calls = 0;
    harness([out], (lines) => {
      calls += 1;
      write(out, `echo ${lines.join(",")}\n`);
      return true;
    });
    write(out, "x\n");
    expect(calls).toBe(1);
    expect(out.all).toBe("echo x\n");
  });
});

test.describe("captureStdio — restore", () => {
  test("a write from the prototype is removed again; writes then go to the stream itself", () => {
    const out = new FakeTerminal();
    const { capture, printed } = harness([out]);
    expect(Object.hasOwn(out, "write")).toBe(true);
    expect(capture.active).toBe(true);
    capture.restore();
    expect(capture.active).toBe(false);
    expect(Object.hasOwn(out, "write")).toBe(false);
    write(out, "after\n");
    expect(out.all).toBe("after\n");
    expect(printed).toEqual([]);
  });

  test("an own write is set back to the very same function", () => {
    const out = new FakeTerminal();
    const own = (): boolean => true;
    (out as { write: unknown }).write = own;
    const { capture } = harness([out]);
    expect(Reflect.get(out, "write")).not.toBe(own);
    capture.restore();
    expect(Reflect.get(out, "write")).toBe(own);
  });

  test("writes what each stream still held, as it was, and is idempotent", () => {
    const out = new FakeTerminal();
    const err = new FakeTerminal();
    const { capture } = harness([out, err]);
    write(out, "open ");
    write(err, Buffer.from("é", "utf8").subarray(0, 1));
    capture.restore();
    capture.restore();
    expect(out.chunks).toEqual(["open "]);
    // Half a character decodes as the replacement character, as a stream's reader would show it.
    expect(err.chunks).toEqual(["\uFFFD"]);
  });

  test("a write replaced after the capture is left to its owner; the capture's then passes through", () => {
    const out = new FakeTerminal();
    const { capture, printed } = harness([out]);
    const ours = out.write.bind(out);
    const theirs = (chunk: string): boolean => ours(chunk);
    (out as { write: unknown }).write = theirs;
    capture.restore();
    expect(Reflect.get(out, "write")).toBe(theirs);
    write(out, "through\n");
    expect(printed).toEqual([]);
    expect(out.all).toBe("through\n");
  });
});

test.describe("captureStdio — all or nothing", () => {
  test("a stream that refuses a new write puts back the ones already captured, and the error is thrown", () => {
    const out = new FakeTerminal();
    const frozen = Object.freeze(new FakeTerminal());
    expect(() =>
      captureStdio({ streams: [out, frozen], print: () => true }),
    ).toThrow(TypeError);
    expect(Object.hasOwn(out, "write")).toBe(false);
    write(out, "raw\n");
    expect(out.all).toBe("raw\n");
  });
});

test.describe("cutLines and toBytes", () => {
  test("cutLines: whole lines, \\r dropped only before \\n, the rest kept", () => {
    expect(cutLines("a\r\nb\rc\nd")).toEqual({
      lines: ["a", "b\rc"],
      rest: "d",
    });
    expect(cutLines("")).toEqual({ lines: [], rest: "" });
    expect(cutLines("\n\n")).toEqual({ lines: ["", ""], rest: "" });
  });

  test("toBytes: text in its encoding, byte views as they are, anything else undefined", () => {
    expect(toBytes("é")?.toString("utf8")).toBe("é");
    expect(toBytes("e9", "hex")?.[0]).toBe(0xe9);
    expect(toBytes("a", "nope")).toBeUndefined();
    const view = new Uint8Array([0, 0x61, 0x62, 0]).subarray(1, 3);
    expect(toBytes(view)?.toString()).toBe("ab");
    expect(toBytes(42)).toBeUndefined();
    expect(toBytes(null)).toBeUndefined();
    // A stream refuses a bare ArrayBuffer: so does the capture, which hands it on.
    expect(toBytes(new ArrayBuffer(2))).toBeUndefined();
  });

  test("toBytes: every byte view is bytes — a DataView, a Uint16Array — its own window only", () => {
    const bytes = Buffer.from("xxline\nyy");
    const data = new DataView(bytes.buffer, bytes.byteOffset + 2, 5);
    expect(toBytes(data)?.toString()).toBe("line\n");
    const wide = new Uint16Array([0x6261, 0x0a63]);
    expect(toBytes(wide)?.toString()).toBe("abc\n");
  });

  test("text in another encoding prints as a UTF-8 terminal would show the bytes it is", () => {
    const out = new FakeTerminal();
    const { printed, capture } = harness([out]);
    write(out, "caf\u00e9\n", "latin1");
    write(out, "6869210a", "hex");
    const view = Buffer.from("view\n");
    write(out, new DataView(view.buffer, view.byteOffset, 5));
    capture.restore();
    expect(printed.flat()).toEqual(["caf\uFFFD", "hi!", "view"]);
    expect(out.all).toBe("");
  });
});

test.describe("bypassWriter", () => {
  test("writes through the stream's write as it was when made, so a capture never sees its bytes", () => {
    const out = new FakeTerminal();
    const view = bypassWriter(out as never);
    const { printed } = harness([out]);
    const calls: unknown[] = [];
    view.write(Buffer.from("block\n"), (e) => calls.push(e));
    expect(out.all).toBe("block\n");
    expect(printed).toEqual([]);
    expect(calls).toEqual([null]);
  });

  test("reads the stream's queue, state, terminal-ness and handle live, and forwards its error event", () => {
    const out = new FakeTerminal();
    const view = bypassWriter(out as never) as ReturnType<
      typeof bypassWriter
    > & { _handle: unknown };
    out.writableLength = 7;
    out.destroyed = true;
    out.isTTY = false;
    expect(view.writableLength).toBe(7);
    expect(view.destroyed).toBe(true);
    expect(view.isTTY).toBe(false);
    expect(view._handle).toBe(out._handle);
    const seen: unknown[] = [];
    view.on("error", (error) => seen.push(error));
    out.emit("error", "boom");
    expect(seen).toEqual(["boom"]);
  });

  test("twelve stand-ins opened for a live region put one error listener on the stream, each made non-blocking", () => {
    const out = new FakeTerminal();
    const opened = Array.from({ length: 12 }, () =>
      openLiveTerminal(bypassWriter(out as never)),
    );
    expect(out.listenerCount("error")).toBe(1);
    expect(new Set(opened).size).toBe(12);
    expect(opened.every((terminal) => terminal.unblocked)).toBe(true);
    expect(out.blocking).toEqual(Array.from({ length: 12 }, () => false));
    // The stream itself, opened after its stand-ins, is not listened to twice either.
    openLiveTerminal(out as never);
    expect(out.listenerCount("error")).toBe(1);
  });

  test("a real stream behind twelve stand-ins gets one error listener: no MaxListeners warning", () => {
    const stream = new PassThrough();
    for (let i = 0; i < 12; i += 1) openLiveTerminal(bypassWriter(stream));
    expect(stream.listenerCount("error")).toBe(1);
  });
});
