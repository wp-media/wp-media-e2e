import { test, expect } from "@playwright/test";

import { captureWrites } from "../__fixtures__/reporter-fakes";
import {
  currentTerminalSink,
  printLine,
  registerTerminalSink,
  type TerminalSink,
} from "./terminal-sink";

/**
 * The run's one writer: lines go to the registered sink, the newest one; with none, to the stream
 * the caller names, unchanged — so a reporter used alone prints as it always did.
 */

/** A sink that records what it is handed. */
function recordingSink(): TerminalSink & { readonly printed: string[] } {
  const printed: string[] = [];
  return {
    printed,
    print: (text) => {
      printed.push(text);
    },
  };
}

/** Unregisters what a spec registered. */
const cleanups: (() => void)[] = [];

test.afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  expect(currentTerminalSink()).toBeUndefined();
});

test.describe("printLine", () => {
  test("with no sink, writes the text and a line end to the stream named", () => {
    expect(
      captureWrites(process.stdout, () => {
        printLine("[cell] x", "stdout");
      }),
    ).toEqual(["[cell] x\n"]);
    expect(
      captureWrites(process.stderr, () => {
        printLine("[results] y\nsecond", "stderr");
      }),
    ).toEqual(["[results] y\nsecond\n"]);
  });

  test("with a sink, hands it the text and writes neither stream", () => {
    const sink = recordingSink();
    cleanups.push(registerTerminalSink(sink));
    const writes = [
      ...captureWrites(process.stdout, () => {
        printLine("one", "stdout");
      }),
      ...captureWrites(process.stderr, () => {
        printLine("two", "stderr");
      }),
    ];
    expect(writes).toEqual([]);
    expect(sink.printed).toEqual(["one", "two"]);
  });

  test("never throws: not when the sink throws, not when the stream does", () => {
    cleanups.push(
      registerTerminalSink({
        print: () => {
          throw new Error("sink broke");
        },
      }),
    );
    expect(() => {
      printLine("x", "stdout");
    }).not.toThrow();
    for (const cleanup of cleanups.splice(0)) cleanup();

    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (): boolean => {
      throw new Error("stderr closed");
    };
    try {
      expect(() => {
        printLine("x", "stderr");
      }).not.toThrow();
    } finally {
      process.stderr.write = original;
    }
  });
});

test.describe("registerTerminalSink", () => {
  test("the newest sink prints; unregistering it hands back to the one before", () => {
    const first = recordingSink();
    const second = recordingSink();
    const unregisterFirst = registerTerminalSink(first);
    const unregisterSecond = registerTerminalSink(second);
    cleanups.push(unregisterFirst, unregisterSecond);

    printLine("a", "stdout");
    unregisterSecond();
    printLine("b", "stdout");
    expect(second.printed).toEqual(["a"]);
    expect(first.printed).toEqual(["b"]);
  });

  test("unregistering an older sink removes only it; twice does nothing", () => {
    const first = recordingSink();
    const second = recordingSink();
    const unregisterFirst = registerTerminalSink(first);
    const unregisterSecond = registerTerminalSink(second);
    cleanups.push(unregisterSecond);
    unregisterFirst();
    unregisterFirst();
    expect(currentTerminalSink()).toBe(second);
    unregisterSecond();
    expect(currentTerminalSink()).toBeUndefined();
  });

  test("the registry is shared through globalThis: another copy of the module finds the sink", async () => {
    const sink = recordingSink();
    cleanups.push(registerTerminalSink(sink));
    // A query string makes Node load the file as a second, separate module.
    const copy = (await import(
      `${new URL("./terminal-sink.ts", import.meta.url).href}?copy`
    )) as typeof import("./terminal-sink");
    copy.printLine("from the copy", "stdout");
    expect(sink.printed).toEqual(["from the copy"]);
  });
});
