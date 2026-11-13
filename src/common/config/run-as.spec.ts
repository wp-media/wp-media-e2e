import { test, expect } from "@playwright/test";

import {
  DEFAULT_SSH_RUN_AS,
  DEFAULT_UMASK,
  effectiveRunAs,
  effectiveUmask,
  idOutOfRange,
  MAX_ID,
  namesRoot,
  parseRunAs,
  parseUmask,
  runAsIdentity,
} from "./run-as";
import type { Transport } from "./types";

const SSH: Transport = {
  mode: "ssh",
  host: "203.0.113.10",
  username: "ubuntu",
  privateKeyPath: "/home/ci/.ssh/id_ed25519",
  rootDir: "/var/www/html/site",
};
const DOCKER: Transport = { mode: "docker", container: "c" };
const LOCAL: Transport = { mode: "local", rootDir: "/srv/wp" };

// The default: an ssh site without `runAs` asks for the web server's identity; `false` opts out.
test("an ssh site without runAs asks for the web server's identity by default", () => {
  expect(DEFAULT_SSH_RUN_AS).toBe("auto");
  expect(effectiveRunAs(SSH)).toBe("auto");
});

test("a declared runAs wins over the default", () => {
  expect(effectiveRunAs({ ...SSH, runAs: "auto" })).toBe("auto");
  expect(effectiveRunAs({ ...SSH, runAs: "www-data:www-data" })).toBe(
    "www-data:www-data",
  );
  expect(effectiveRunAs({ ...SSH, runAs: false })).toBe(false);
});

// `undefined`, never `false`: `false` is the opt-out (`disabled`), while these always run as
// themselves (`same-user`).
test("docker and local have no runAs, not the opt-out", () => {
  expect(effectiveRunAs(DOCKER)).toBeUndefined();
  expect(effectiveRunAs(LOCAL)).toBeUndefined();
});

test("the umask defaults to 0022 over ssh and is absent elsewhere", () => {
  expect(DEFAULT_UMASK).toBe("0022");
  expect(effectiveUmask(SSH)).toBe("0022");
  expect(effectiveUmask({ ...SSH, umask: "0002" })).toBe("0002");
  expect(effectiveUmask(DOCKER)).toBeUndefined();
  expect(effectiveUmask(LOCAL)).toBeUndefined();
});

test("namesRoot: root by name or by an id of zeros only", () => {
  for (const name of ["root", "0", "00", "0000"])
    expect(namesRoot(name)).toBe(true);
  for (const name of ["Root", "rooter", "toor", "10", "01", "www-data", ""]) {
    expect(namesRoot(name), name).toBe(false);
  }
});

// The loader's spec covers every form through a sites file; these pin the parsers' own contract.
test("parseRunAs returns auto or the trimmed identity", () => {
  expect(parseRunAs("auto", "p")).toBe("auto");
  expect(parseRunAs(" www-data:www-data ", "p")).toBe("www-data:www-data");
  expect(() => parseRunAs("root:www-data", "p")).toThrow(
    /^\[sites\] p names root as its user:/,
  );
});

test("idOutOfRange: only all-digit ids above 4294967294", () => {
  expect(MAX_ID).toBe(4_294_967_294);
  for (const name of [
    "4294967294",
    "0004294967294",
    "0",
    "33",
    "www-data",
    "4294967295x",
  ]) {
    expect(idOutOfRange(name), name).toBe(false);
  }
  for (const name of ["4294967295", "4294967296", "99999999999999999999999"]) {
    expect(idOutOfRange(name), name).toBe(true);
  }
});

test("runAsIdentity splits a valid identity, trimmed", () => {
  expect(runAsIdentity("www-data:33", "c")).toEqual({
    user: "www-data",
    group: "33",
  });
  expect(runAsIdentity(" 33:33 ", "c")).toEqual({ user: "33", group: "33" });
});

// A transport built by hand skips the loader: the exec layer must still never get root or garbage.
test("runAsIdentity holds a hand-built identity to the loader's rule", () => {
  expect(() => runAsIdentity("root:www-data", "[exec] x")).toThrow(
    /^\[exec\] x names root as its user:/,
  );
  expect(() => runAsIdentity("www-data:0", "[exec] x")).toThrow(
    /^\[exec\] x names root as its group:/,
  );
  expect(() => runAsIdentity("4294967295:33", "[exec] x")).toThrow(
    /^\[exec\] x names a numeric id above 4294967294 as its user:/,
  );
  expect(() => runAsIdentity("-R:x", "[exec] x")).toThrow(
    /^\[exec\] x must be "auto", .+ — got a text of 4 characters\.$/,
  );
});

// Characters are code points: an astral one (an emoji, two UTF-16 units) counts once.
test("a refused runAs or umask counts an astral character once", () => {
  expect(() => parseRunAs("🙂:🙂", "p")).toThrow(
    /got a text of 3 characters\.$/,
  );
  expect(() => parseUmask("🙂", "p")).toThrow(/got a text of 1 characters\.$/);
});

test("parseUmask pads to four digits and refuses an owner bit", () => {
  expect(parseUmask("022", "p")).toBe("0022");
  expect(() => parseUmask("0177", "p")).toThrow(
    /^\[sites\] p must be .+ — got "0177"\.$/,
  );
});
