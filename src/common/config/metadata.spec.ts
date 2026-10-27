import { test, expect } from "@playwright/test";

import {
  getDebugLogOptions,
  getPool,
  getSiteResidue,
  getSettleLeftovers,
  getStopRunningWork,
  readRouting,
  registerDebugLogOptions,
  registerPool,
  registerSiteResidue,
  registerSettleLeftovers,
  registerStopRunningWork,
  routingMetadata,
} from "./metadata";
import type { SiteConfig } from "./types";

/**
 * The project-metadata contract and the per-process registries behind it.
 *
 * The registries are module-global and deliberately have no reset (the config factory populates
 * them once per process), so each test uses its own product/cell names for isolation.
 *
 * The properties worth pinning are the ones a silent regression would hide: routing rejects
 * anything it cannot trust rather than yielding a half-valid object; the pool registry throws when
 * a worker reads a pool its process never built; and the debug-log registry defaults to the
 * **strictest** preset, so a product that forgets to declare one gets a gate that is too strict
 * rather than one that quietly passes. The residue registry defaults the other way — to nothing —
 * because "this product leaves no files behind" is a legitimate state rather than an oversight.
 */

test.describe("routingMetadata / readRouting", () => {
  test("round-trips a cell with and without an edition", () => {
    expect(
      readRouting(routingMetadata("backwpup", "pro@nginx", "pro")),
    ).toEqual({ product: "backwpup", cell: "pro@nginx", edition: "pro" });
    // Editionless products must not gain an `edition: undefined` key, which would then be
    // serialized into reports as a meaningless field.
    const editionless = routingMetadata("wp-rocket", "apache");
    expect(editionless).not.toHaveProperty("edition");
    expect(readRouting(editionless)).toEqual({
      product: "wp-rocket",
      cell: "apache",
    });
  });

  test("rejects metadata it cannot trust, naming what was expected", () => {
    for (const bad of [undefined, null, "backwpup", []]) {
      expect(() => readRouting(bad)).toThrow(/expected \{ product, cell \}/);
    }
    for (const bad of [{}, { product: "backwpup" }, { cell: "apache" }]) {
      expect(() => readRouting(bad)).toThrow(
        /non-empty string `product` and `cell`/,
      );
    }
    expect(() =>
      readRouting({ product: "backwpup", cell: "x", edition: "enterprise" }),
    ).toThrow(/`edition` must be "free" \| "pro"/);
  });
});

test.describe("site-pool registry", () => {
  const site: SiteConfig = {
    baseURL: "https://example.test",
    username: "admin",
    password: "secret",
    transport: { mode: "local", rootDir: "/var/www/html" },
    storageState: ".auth/site-0.json",
  };

  test("registers and returns a pool, keyed by product AND cell", () => {
    registerPool("spec-product", "cell-a", [site]);
    registerPool("spec-product", "cell-b", []);
    expect(getPool("spec-product", "cell-a")).toEqual([site]);
    expect(getPool("spec-product", "cell-b")).toEqual([]);
  });

  test("throws for a pool this process never built", () => {
    // A worker rebuilds the config itself, so a miss means a programming error, not bad input.
    expect(() => getPool("spec-product", "never-registered")).toThrow(
      /no site pool registered for "spec-product\/never-registered"/,
    );
  });
});

test.describe("debug-log preset registry", () => {
  test("serves back the exact preset a product declared", () => {
    // Identity, not equality: the preset carries RegExps, which is precisely why it travels
    // through this registry instead of Playwright's JSON-serialized project metadata.
    const preset = { ignore: [/known-benign/], source: [/plugins\/thing\//] };
    registerDebugLogOptions("spec-with-preset", preset);
    expect(getDebugLogOptions("spec-with-preset")).toBe(preset);
  });

  test("defaults to the strictest preset for a product that declares none", () => {
    // `{}` = categorise every line, ignore nothing. A forgotten preset can only make the gate
    // stricter, never quieter — and unlike getPool this must never throw, because the shared
    // hooks have to work for any product.
    expect(getDebugLogOptions("spec-no-preset")).toEqual({});
    registerDebugLogOptions("spec-undefined-preset", undefined);
    expect(getDebugLogOptions("spec-undefined-preset")).toEqual({});
  });

  test("keeps products isolated from one another", () => {
    const a = { ignore: [/a/] };
    const b = { ignore: [/b/] };
    registerDebugLogOptions("spec-product-a", a);
    registerDebugLogOptions("spec-product-b", b);
    expect(getDebugLogOptions("spec-product-a")).toBe(a);
    expect(getDebugLogOptions("spec-product-b")).toBe(b);
  });
});

test.describe("leftover-settling registry", () => {
  test("serves back the function a product declared", () => {
    const settle = (): Promise<void> => Promise.resolve();
    registerSettleLeftovers("spec-with-leftovers", settle);
    expect(getSettleLeftovers("spec-with-leftovers")).toBe(settle);
  });

  test("is absent for a product that declares none", () => {
    expect(getSettleLeftovers("spec-no-leftovers")).toBeUndefined();
    registerSettleLeftovers("spec-undefined-leftovers", undefined);
    expect(getSettleLeftovers("spec-undefined-leftovers")).toBeUndefined();
  });
});

test.describe("running-work registry", () => {
  test("serves back the function a product declared", () => {
    const stop = (): Promise<string | undefined> => Promise.resolve(undefined);
    registerStopRunningWork("spec-with-work", stop);
    expect(getStopRunningWork("spec-with-work")).toBe(stop);
  });

  // Absent means "runs nothing in the background", so the teardown has nothing to ask — not a
  // default function that would cost every product a round trip for a question it cannot answer.
  test("is absent for a product that declares none", () => {
    expect(getStopRunningWork("spec-no-work")).toBeUndefined();
    registerStopRunningWork("spec-undefined-work", undefined);
    expect(getStopRunningWork("spec-undefined-work")).toBeUndefined();
  });
});

test.describe("site-residue registry", () => {
  test("serves back the paths a product declared", () => {
    const paths = ["wp-content/uploads/thing"];
    registerSiteResidue("spec-with-residue", paths);
    expect(getSiteResidue("spec-with-residue")).toBe(paths);
  });

  // Unlike the debug-log preset, an absent declaration is not an oversight to compensate for: a
  // product whose plugin cleans up after itself has nothing to sweep, and sweeping "just in case"
  // would mean guessing at paths on someone else's site.
  test("is empty for a product that declares none", () => {
    expect(getSiteResidue("spec-no-residue")).toEqual([]);
    registerSiteResidue("spec-undefined-residue", undefined);
    expect(getSiteResidue("spec-undefined-residue")).toEqual([]);
  });

  test("keeps products isolated from one another", () => {
    registerSiteResidue("spec-residue-a", ["wp-content/uploads/a"]);
    registerSiteResidue("spec-residue-b", ["wp-content/uploads/b"]);
    expect(getSiteResidue("spec-residue-a")).toEqual(["wp-content/uploads/a"]);
    expect(getSiteResidue("spec-residue-b")).toEqual(["wp-content/uploads/b"]);
  });
});
