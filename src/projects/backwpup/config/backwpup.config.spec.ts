import { test, expect } from "@playwright/test";

import { backwpup } from "./backwpup.config";
import { assertNoContentCopyLeft } from "../support/content-copy-leftover";

/**
 * The BackWPup product's policy the shared code reaches only through its config: dropped here, it
 * would be silently absent.
 */

test("settles a restore's orphaned copy of wp-content before the preflight's gates", () => {
  expect(backwpup.settleLeftovers).toBe(assertNoContentCopyLeft);
});
