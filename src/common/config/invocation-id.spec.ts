import { test, expect } from "@playwright/test";

import { INVOCATION_ENV, resolveInvocationId } from "./invocation-id";

/**
 * The invocation's token: shared by a runner and its workers, never by two invocations — even ones
 * sharing a pinned `RUN_ID`, or one started inside another (from a worker, or by the runner itself).
 */

const TOKEN = "0123456789abcdef0123456789abcdef";
const OTHER = "fedcba9876543210fedcba9876543210";

test.describe("resolveInvocationId", () => {
  test("a runner with none inherited makes one and publishes it under its own pid", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(
      resolveInvocationId({ env, pid: 10, ppid: 1, fresh: () => TOKEN }),
    ).toBe(TOKEN);
    expect(env[INVOCATION_ENV]).toBe(`10:${TOKEN}`);
  });

  // Playwright sets `TEST_WORKER_INDEX` in each worker before it loads the config (measured, 1.65.1).
  test("a worker takes its runner's, writing nothing", () => {
    const env: NodeJS.ProcessEnv = {
      [INVOCATION_ENV]: `10:${TOKEN}`,
      TEST_WORKER_INDEX: "0",
    };
    expect(
      resolveInvocationId({ env, pid: 11, ppid: 10, fresh: () => OTHER }),
    ).toBe(TOKEN);
    expect(env[INVOCATION_ENV]).toBe(`10:${TOKEN}`);
  });

  test("the runner itself, importing again, keeps its own", () => {
    const env: NodeJS.ProcessEnv = { [INVOCATION_ENV]: `10:${TOKEN}` };
    expect(
      resolveInvocationId({ env, pid: 10, ppid: 1, fresh: () => OTHER }),
    ).toBe(TOKEN);
  });

  // A run started from inside another inherits the outer runner's token, which is not its own.
  test("a runner whose inherited token is another process's makes its own", () => {
    const env: NodeJS.ProcessEnv = { [INVOCATION_ENV]: `10:${TOKEN}` };
    expect(
      resolveInvocationId({ env, pid: 30, ppid: 20, fresh: () => OTHER }),
    ).toBe(OTHER);
    expect(env[INVOCATION_ENV]).toBe(`30:${OTHER}`);
  });

  // Its parent wrote the token, but it is no worker: another invocation, which must not share it.
  test("a runner its parent runner started directly makes its own", () => {
    const env: NodeJS.ProcessEnv = { [INVOCATION_ENV]: `10:${TOKEN}` };
    expect(
      resolveInvocationId({ env, pid: 11, ppid: 10, fresh: () => OTHER }),
    ).toBe(OTHER);
    expect(env[INVOCATION_ENV]).toBe(`11:${OTHER}`);
  });

  test("a child claiming a worker index that is not one makes its own", () => {
    for (const index of ["", "x", "-1", "1.5"]) {
      const env: NodeJS.ProcessEnv = {
        [INVOCATION_ENV]: `10:${TOKEN}`,
        TEST_WORKER_INDEX: index,
      };
      expect(
        resolveInvocationId({ env, pid: 11, ppid: 10, fresh: () => OTHER }),
        index,
      ).toBe(OTHER);
    }
  });

  test("a malformed value is replaced, never believed", () => {
    for (const value of [
      "",
      TOKEN,
      `10:${TOKEN.toUpperCase()}`,
      `10:${TOKEN}0`,
      `x:${TOKEN}`,
      `10:${TOKEN}:1`,
      `-10:${TOKEN}`,
    ]) {
      // A worker's, so only the value can be what refuses it.
      const env: NodeJS.ProcessEnv = {
        [INVOCATION_ENV]: value,
        TEST_WORKER_INDEX: "0",
      };
      expect(
        resolveInvocationId({ env, pid: 11, ppid: 10, fresh: () => OTHER }),
        value,
      ).toBe(OTHER);
    }
  });

  test("a fresh token is 32 hex digits, a new one each time", () => {
    const a = resolveInvocationId({ env: {}, pid: 1, ppid: 0 });
    const b = resolveInvocationId({ env: {}, pid: 1, ppid: 0 });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
});
