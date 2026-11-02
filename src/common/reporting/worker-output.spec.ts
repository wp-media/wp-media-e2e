import { test, expect } from "@playwright/test";

import {
  CUT_MARK,
  OUTPUT_LIMITS,
  WorkerOutput,
  cutLine,
} from "./worker-output";

/**
 * Worker output, cut into lines per source as it arrives: chunks split anywhere (inside a line, inside
 * a UTF-8 character), line ends of either kind, an open last line, output outside any test (each chunk
 * its own lines), and the bounds that keep a flood out without ever cutting a credential in two.
 */

test.describe("WorkerOutput — lines per source, as they come", () => {
  test("returns each line once complete; the open line waits for its end or the source's end", () => {
    const output = new WorkerOutput();
    expect(output.append("t", "one\ntw")).toEqual(["one"]);
    expect(output.append("t", "o\r\nthr")).toEqual(["two"]);
    expect(output.append("t", "ee")).toEqual([]);
    expect(output.end("t")).toEqual({ lines: ["three"], dropped: 0 });
    // Forgotten once ended.
    expect(output.end("t")).toEqual({ lines: [], dropped: 0 });
    expect(output.keys()).toEqual([]);
  });

  test("keeps sources apart, listed in the order they first wrote", () => {
    const output = new WorkerOutput();
    output.append("b", "from b, open");
    output.append("o", "outside any test\n", true);
    output.append("a", "from a, open");
    expect(output.keys()).toEqual(["b", "o", "a"]);
    expect(output.end("a").lines).toEqual(["from a, open"]);
    expect(output.end("b").lines).toEqual(["from b, open"]);
    expect(output.keys()).toEqual(["o"]);
  });

  test("wholeChunks (output outside any test): each chunk ends its own line, two writers' halves never joined", () => {
    const output = new WorkerOutput();
    expect(output.append("o", "worker 1 half", true)).toEqual([
      "worker 1 half",
    ]);
    expect(output.append("o", "worker 2 line\nand half", true)).toEqual([
      "worker 2 line",
      "and half",
    ]);
    // Bytes too: an incomplete character is U+FFFD at once, never completed by another worker's chunk.
    const tick = Buffer.from("✔\n", "utf8");
    expect(output.append("o", tick.subarray(0, 2), true)).toEqual(["�"]);
    expect(output.append("o", Buffer.from("ok\n"), true)).toEqual(["ok"]);
    expect(output.end("o")).toEqual({ lines: [], dropped: 0 });
  });

  test("decodes a test's bytes across chunks: a UTF-8 character split across chunks is whole", () => {
    const output = new WorkerOutput();
    const bytes = Buffer.from("é✔\n", "utf8");
    expect(output.append("t", bytes.subarray(0, 1))).toEqual([]);
    output.append("u", Buffer.from("other\n"));
    expect(output.append("t", bytes.subarray(1, 3))).toEqual([]);
    expect(output.append("t", bytes.subarray(3))).toEqual(["é✔"]);
    // An incomplete character at the end becomes U+FFFD, never lost silently.
    output.append("v", Buffer.from([0xe2, 0x9c]));
    expect(output.end("v").lines).toEqual(["�"]);
  });

  test("a string after bytes keeps the order: the waiting bytes first, as U+FFFD", () => {
    const output = new WorkerOutput();
    output.append("t", Buffer.from("a"));
    output.append("t", Buffer.from([0xc3]));
    expect(output.append("t", "b\n")).toEqual(["a�b"]);
    // The decoder starts clean after it: whole characters in later bytes are whole.
    expect(output.append("t", Buffer.from("é\n", "utf8"))).toEqual(["é"]);
  });

  test("keeps empty lines and the escapes in them: cleaning is the printer's job", () => {
    const output = new WorkerOutput();
    expect(output.append("t", "\u001b[31mred\u001b[39m\n\n")).toEqual([
      "\u001b[31mred\u001b[39m",
      "",
    ]);
  });

  test("an unknown source has nothing", () => {
    expect(new WorkerOutput().end("x")).toEqual({ lines: [], dropped: 0 });
  });
});

test.describe("WorkerOutput — bounds", () => {
  test("shows at most maxLines per source until it ends, counting the rest; an end starts a new count", () => {
    const output = new WorkerOutput({ maxLines: 3, maxLineLength: 100 });
    expect(output.append("t", "1\n2\n")).toEqual(["1", "2"]);
    expect(output.append("t", "3\n4\n5\nopen")).toEqual(["3"]);
    expect(output.end("t")).toEqual({ lines: [], dropped: 3 });
    expect(output.append("t", "6\n")).toEqual(["6"]);
    expect(output.end("t")).toEqual({ lines: [], dropped: 0 });
  });

  test("wholeChunks: the count runs until the source ends, then starts again", () => {
    const output = new WorkerOutput({ maxLines: 2, maxLineLength: 100 });
    expect(output.append("o", "a\nb\nc", true)).toEqual(["a", "b"]);
    expect(output.append("o", "d\n", true)).toEqual([]);
    expect(output.end("o")).toEqual({ lines: [], dropped: 2 });
    expect(output.append("o", "e\n", true)).toEqual(["e"]);
  });

  test("a line past maxLineLength loses the word the cut fell in, and says it was cut", () => {
    const output = new WorkerOutput({ maxLines: 10, maxLineLength: 12 });
    expect(output.append("t", "abc defghijklmn\n")).toEqual([
      `abc ${CUT_MARK}`,
    ]);
    // An open line too, however it grows; the rest of a cut line, up to its end, is dropped.
    output.append("t", "ab cd");
    for (let i = 0; i < 1_000; i += 1) output.append("t", "efgh");
    expect(output.append("t", "tail\nnext\n")).toEqual([
      `ab ${CUT_MARK}`,
      "next",
    ]);
    // At the bound, kept whole.
    expect(output.append("u", "abcdefghijkl\n")).toEqual(["abcdefghijkl"]);
  });

  test("a cut never leaves a credential's half: the URL's password without its @, a token's head", () => {
    const max = OUTPUT_LIMITS.maxLineLength;
    // Escapes inflate a line far past what it shows (workers print with FORCE_COLOR=1).
    const pad = "\u001b[2m.\u001b[22m".repeat(Math.ceil(max / 10));
    for (const secret of [
      "https://admin:S3cretPassw0rd@site.example/",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789",
    ]) {
      // The cut falls after each of the secret's first `at` characters (from 4: shorter heads are
      // words of the mark itself).
      for (let at = 4; at < secret.length; at += 1) {
        const head = pad.slice(0, max - at - 1);
        const [line = ""] = new WorkerOutput().append(
          "t",
          `${head} ${secret} tail\n`,
        );
        expect(line.endsWith(CUT_MARK)).toBe(true);
        expect(line).not.toContain(secret.slice(0, at));
      }
    }
  });

  test("cutLine: back to the last whitespace; a line with none keeps only the mark", () => {
    expect(cutLine("one two three", 9)).toBe(`one two ${CUT_MARK}`);
    expect(cutLine("one two three", 8)).toBe(`one two ${CUT_MARK}`);
    expect(cutLine("one two three", 6)).toBe(`one ${CUT_MARK}`);
    expect(cutLine("x".repeat(50), 10)).toBe(CUT_MARK);
    // A surrogate pair split by the cut goes with its word.
    expect(cutLine("a 😀😀", 4)).toBe(`a ${CUT_MARK}`);
  });

  test("an open line is bounded as it grows: 600 MiB with no line end would pass V8's longest string", () => {
    const output = new WorkerOutput();
    const megabyte = "w".repeat(1024 * 1024);
    expect(() => {
      for (let i = 0; i < 600; i += 1) output.append("t", megabyte);
    }).not.toThrow();
    expect(output.end("t").lines).toEqual([CUT_MARK]);
  });

  test("the reporter's bounds: 200 lines, 64 KiB each — a memory bound, far past the 500 shown", () => {
    expect(OUTPUT_LIMITS).toEqual({ maxLines: 200, maxLineLength: 65_536 });
  });
});
