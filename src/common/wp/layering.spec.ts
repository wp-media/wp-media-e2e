import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

import { createResolver } from "../__fixtures__/import-scan";

/**
 * `exec`/`wpCli` (`exec.ts`) ask the identity resolver who to run as, and `planOwnership`
 * (`ownership.ts`) asks it who commands run as; the resolver and every probe it, or the pre-flight's
 * verdict, is decided from must therefore never load either module at run time. A probe reaching
 * `exec` would run through the resolver it feeds (recursion, or a probe run as an answer it is still
 * computing), and an import cycle would make module order decide what is defined. Type-only imports
 * are erased (`verbatimModuleSyntax`), so they are not followed: `config/types.ts` names types of
 * modules that use `exec`.
 */

/** `src/common/wp/`, where this file sits. */
const WP_DIR = fileURLToPath(new URL(".", import.meta.url));

/** The repository's TypeScript resolution. */
const resolveImport = createResolver(
  fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
);

/** The modules the identity state is decided from. */
const PROBE_LAYER = [
  "transport-exec.ts",
  "run-as-argv.ts",
  "owner-probe.ts",
  "site-identity.ts",
  "web-identity.ts",
].map((name) => join(WP_DIR, name));

/** What the probe layer must never reach. */
const ABOVE = ["exec.ts", "ownership.ts"].map((name) => join(WP_DIR, name));

/**
 * The relative specifiers `source` loads at run time: import and export declarations that are not
 * `import type`/`export type`, nor made only of `type` specifiers. A dynamic `import()` is not read
 * here: {@link runtimeClosure} reports any file holding one as unfollowed.
 *
 * @param file - the file's path, for the parser.
 * @param source - its text.
 */
function valueImports(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest);
  const found: string[] = [];
  for (const node of sourceFile.statements) {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause?.phaseModifier === ts.SyntaxKind.TypeKeyword ||
        (clause?.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
      if (!typeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
        found.push(node.moduleSpecifier.text);
      }
    } else if (
      ts.isExportDeclaration(node) &&
      !node.isTypeOnly &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push(node.moduleSpecifier.text);
    }
  }
  return found;
}

/**
 * Every repository file `entries` load at run time, transitively.
 *
 * @param entries - absolute paths.
 * @returns the files reached (entries included), and what could not be followed.
 */
function runtimeClosure(entries: readonly string[]): {
  readonly files: string[];
  readonly unfollowed: string[];
} {
  const seen = new Set<string>();
  const unfollowed: string[] = [];
  const queue = [...entries];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    if (/\bimport\s*\(/.test(source)) unfollowed.push(`${file} import()`);
    for (const specifier of valueImports(file, source)) {
      const resolved = resolveImport(specifier, file);
      if (resolved.kind === "file") queue.push(resolved.path);
      else if (resolved.kind === "unresolved") {
        unfollowed.push(`${file} ${specifier}`);
      }
    }
  }
  return { files: [...seen].sort(), unfollowed };
}

test("the identity resolver and its probes never load exec.ts or ownership.ts", () => {
  const { files, unfollowed } = runtimeClosure(PROBE_LAYER);

  expect(files).toEqual(expect.arrayContaining(PROBE_LAYER));
  expect(files.filter((file) => ABOVE.includes(file))).toEqual([]);
  expect(unfollowed).toEqual([]);
});

test("exec.ts and ownership.ts do reach the resolver: the check above guards a real edge", () => {
  for (const module of ABOVE) {
    expect(runtimeClosure([module]).files).toContain(
      join(WP_DIR, "site-identity.ts"),
    );
  }
});

/**
 * The product registries are loaded by every config process (`config/project.ts`), which runs no site
 * command: validating a declaration there must not load the modules that do (`exec`, `ssh`).
 */
test("config/metadata.ts loads only path rules from wp/, never a command-running module", () => {
  const { files, unfollowed } = runtimeClosure([
    join(WP_DIR, "..", "config", "metadata.ts"),
  ]);

  expect(files.filter((file) => file.startsWith(WP_DIR))).toEqual([
    join(WP_DIR, "paths.ts"),
  ]);
  expect(unfollowed).toEqual([]);
});

test.describe("valueImports reads what loads at run time, and only that", () => {
  for (const [label, source, expected] of [
    ["an import", 'import { a } from "./a";', ["./a"]],
    ["a side-effect import", 'import "./a";', ["./a"]],
    ["a re-export", 'export { a } from "./a";', ["./a"]],
    ["a star re-export", 'export * from "./a";', ["./a"]],
    ["a namespace import", 'import * as a from "./a";', ["./a"]],
    [
      "an import mixing a value and a type",
      'import { a, type B } from "./a";',
      ["./a"],
    ],
    ["import type", 'import type { B } from "./a";', []],
    [
      "an import of type specifiers only",
      'import { type B, type C } from "./a";',
      [],
    ],
    ["export type … from", 'export type { B } from "./a";', []],
  ] as const) {
    test(`${label}: ${expected.length === 0 ? "skipped" : "followed"}`, () => {
      expect(valueImports("probe.ts", source)).toEqual(expected);
    });
  }
});
