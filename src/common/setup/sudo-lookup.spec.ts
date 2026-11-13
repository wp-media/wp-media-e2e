import { test, expect } from "@playwright/test";

import {
  SLOW_SUDO_LOOKUP_MS,
  probeSudoLookup,
  slowSudoLookup,
  sudoLookupAs,
  sudoLookupFrom,
} from "./sudo-lookup";
import type { RunCommand, SudoLookupAs } from "./sudo-lookup";
import type { Transport } from "../config/types";
import type { IdentityState } from "../wp/site-identity";
import type { ElevationSupport, ExecResult } from "../wp/transport-exec";

/** What a host's unresolvable name costs each sudo call: the reading, the probe, the wording. */

const NOISE =
  "sudo: unable to resolve host web1: Temporary failure in name resolution";

const TRANSPORT: Transport = {
  mode: "ssh",
  host: "site.test",
  username: "tester",
  privateKeyPath: "/k",
  rootDir: "/r",
};

const ROOT: SudoLookupAs = { kind: "root" };
const AS_WEB: SudoLookupAs = {
  kind: "identity",
  target: { user: "www-data", group: "www-data" },
};

/**
 * A fake runner answering each program with a result after a delay on a fake clock.
 *
 * @param answers - per program (the one `env` runs, past its `NAME=value` words): its result and how
 * long it "takes".
 * @returns the runner, the clock, and the calls made.
 */
function fakeHost(
  answers: Record<string, { readonly result: ExecResult; readonly ms: number }>,
): {
  readonly run: RunCommand;
  readonly now: () => number;
  readonly calls: string[][];
} {
  let clock = 0;
  const calls: string[][] = [];
  const run: RunCommand = (_transport, file, args, options) => {
    calls.push([file, ...args, `cwd=${options?.cwd ?? ""}`]);
    const program =
      file === "env" ? args.find((arg) => !arg.includes("=")) : file;
    const answer = program === undefined ? undefined : answers[program];
    if (answer === undefined) return Promise.reject(new Error("lost"));
    clock += answer.ms;
    return Promise.resolve(answer.result);
  };
  return { run, now: () => clock, calls };
}

const ok = (stderr = ""): ExecResult => ({ stdout: "", stderr, exitCode: 0 });

test("sudoLookupFrom: no host line resolves; with one, the wait is sudo's time less the round trip, never negative", () => {
  expect(sudoLookupFrom("", 900)).toEqual({ kind: "resolves" });
  expect(sudoLookupFrom("sudo: a password is required", 900)).toEqual({
    kind: "resolves",
  });
  expect(sudoLookupFrom(NOISE, 20_900.4, 800)).toEqual({
    kind: "unresolved",
    waitMs: 20_100,
  });
  expect(sudoLookupFrom(NOISE, 700, 800)).toEqual({
    kind: "unresolved",
    waitMs: 0,
  });
  // The program's own late line is not sudo's.
  expect(sudoLookupFrom(`x\n${NOISE}`, 20_000, 0)).toEqual({
    kind: "resolves",
  });
});

const SUDO_AS_ROOT = ["env", "LC_ALL=C", "sudo", "-n", "true", "cwd=/"];
const PLAIN = ["env", "LC_ALL=C", "true", "cwd=/"];

test("sudoLookupAs: only where the run sends commands through sudo — the identity in site, else root when available, never docker", () => {
  const target = { user: "www-data", group: "www-data" };
  const states: Record<string, IdentityState | { readonly kind: "error" }> = {
    site: {
      kind: "site",
      target,
      identity: {
        user: "www-data",
        group: "www-data",
        uid: 33,
        gid: 33,
        groupIds: [33],
        groupNames: ["www-data"],
      },
      umask: "0022",
    },
    fallback: { kind: "fallback", reason: "no-sudo", detail: "refused" },
    disabled: { kind: "disabled", reason: "config" },
    "same-user": { kind: "same-user", reason: "transport-user" },
    error: { kind: "error" },
  };
  const elevations: ElevationSupport[] = [
    "available",
    "disabled",
    "unavailable",
  ];
  for (const mode of ["docker", "local", "ssh"] as const) {
    for (const [name, state] of Object.entries(states)) {
      for (const elevation of elevations) {
        const expected =
          mode === "docker"
            ? undefined
            : name === "site"
              ? { kind: "identity", target }
              : elevation === "available"
                ? ROOT
                : undefined;
        expect(
          sudoLookupAs(mode, state, elevation),
          `${mode} × ${name} × ${elevation}`,
        ).toEqual(expected);
      }
    }
  }
});

test("probeSudoLookup: in English, as the identity asked for; never root when the identity is asked", async () => {
  const host = fakeHost({ sudo: { result: ok(), ms: 800 } });
  await probeSudoLookup(TRANSPORT, AS_WEB, host.run, host.now);
  expect(host.calls).toEqual([
    [
      "env",
      "LC_ALL=C",
      "sudo",
      "-n",
      "-u",
      "www-data",
      "-g",
      "www-data",
      "true",
      "cwd=/",
    ],
  ]);
});

test("probeSudoLookup: a quiet sudo costs one call; a noisy one is compared with a plain call, both from /", async () => {
  const quiet = fakeHost({ sudo: { result: ok(), ms: 800 } });
  await expect(
    probeSudoLookup(TRANSPORT, ROOT, quiet.run, quiet.now),
  ).resolves.toEqual({ kind: "resolves" });
  expect(quiet.calls).toEqual([SUDO_AS_ROOT]);

  const slow = fakeHost({
    sudo: { result: ok(NOISE), ms: 20_800 },
    true: { result: ok(), ms: 800 },
  });
  await expect(
    probeSudoLookup(TRANSPORT, ROOT, slow.run, slow.now),
  ).resolves.toEqual({ kind: "unresolved", waitMs: 20_000 });
  expect(slow.calls).toEqual([SUDO_AS_ROOT, PLAIN]);

  // Refused (no passwordless sudo): sudo still looked the name up, so the wait is still measured.
  const refused = fakeHost({
    sudo: {
      result: {
        stdout: "",
        stderr: `${NOISE}\nsudo: a password is required`,
        exitCode: 1,
      },
      ms: 2_800,
    },
    true: { result: ok(), ms: 800 },
  });
  await expect(
    probeSudoLookup(TRANSPORT, ROOT, refused.run, refused.now),
  ).resolves.toEqual({ kind: "unresolved", waitMs: 2_000 });
});

test("probeSudoLookup: a failed transport answers nothing rather than a guess", async () => {
  const lost = fakeHost({});
  await expect(
    probeSudoLookup(TRANSPORT, ROOT, lost.run, lost.now),
  ).resolves.toBeUndefined();
  const lostAfter = fakeHost({ sudo: { result: ok(NOISE), ms: 5_000 } });
  await expect(
    probeSudoLookup(TRANSPORT, ROOT, lostAfter.run, lostAfter.now),
  ).resolves.toBeUndefined();
});

test("slowSudoLookup: worded from the threshold up, in seconds with one decimal", () => {
  expect(slowSudoLookup(undefined)).toBeUndefined();
  expect(slowSudoLookup({ kind: "resolves" })).toBeUndefined();
  expect(
    slowSudoLookup({ kind: "unresolved", waitMs: SLOW_SUDO_LOOKUP_MS - 1 }),
  ).toBeUndefined();
  expect(
    slowSudoLookup({ kind: "unresolved", waitMs: SLOW_SUDO_LOOKUP_MS }),
  ).toBe("about 1.0 s");
  expect(slowSudoLookup({ kind: "unresolved", waitMs: 20_086 })).toBe(
    "about 20.1 s",
  );
});
