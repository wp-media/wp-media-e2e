import type { Palette } from "../terminal/palette";
import { printableLines } from "../text";
import type { CheckResult } from "./preflight";

/**
 * One family of check lists — the pre-flight report, the artifact report and the fleet healthcheck —
 * rendered by one function, so the three always read alike. Pure: text in, lines out; the palette
 * decides colour and symbols (`TEXT_PALETTE` for a thrown report, a stream's for a
 * printed one).
 */

/**
 * Where the lines go. `report`: a thrown report's data, each detail as the check wrote it (the
 * report's reader cleans it). `printed`: straight to a terminal or a log, so every detail and hint
 * line is made safe there ({@link printableLines}: no escape or control, credentials masked), a
 * detail's further lines indented under its first.
 */
export type CheckLinesTarget = "report" | "printed";

/**
 * The lines for a list of checks: `✓ name: detail` for a pass; `✗ name: detail` for a failure, its
 * name emphasised, then each line of its hint under it as `→ hint`, two columns further in.
 *
 * @param checks - the checks, in the order they ran.
 * @param indent - what each check line starts with (spaces).
 * @param palette - colour and symbols.
 * @param target - a thrown report's (default) or printed lines; see {@link CheckLinesTarget}.
 * @returns one line per check and per hint line (printed: per detail line too).
 * @example
 * ```ts
 * checkLines([{ name: "SSH", ok: false, detail: "refused", hint: "Is sshd up?" }], "  ", TEXT_PALETTE);
 * // ["  ✗ SSH: refused", "    → Is sshd up?"]
 * ```
 */
export function checkLines(
  checks: readonly CheckResult[],
  indent: string,
  palette: Palette,
  target: CheckLinesTarget = "report",
): string[] {
  const { paint, symbol } = palette;
  const printed = target === "printed";
  const lines: string[] = [];
  for (const check of checks) {
    // A report keeps a detail whole on its line; printed, its first line goes there, the rest under it.
    const [first = "", ...rest] = printed
      ? printableLines(check.detail)
      : [check.detail];
    const mark = check.ok
      ? paint("ok", symbol("check"))
      : paint("fail", symbol("cross"));
    const name = check.ok ? check.name : paint("emphasis", check.name);
    lines.push(`${indent}${mark} ${name}: ${first}`);
    lines.push(...rest.map((line) => `${indent}  ${line}`));
    if (check.ok || check.hint === undefined) continue;
    const hints = printed ? printableLines(check.hint) : check.hint.split("\n");
    for (const hintLine of hints) {
      lines.push(`${indent}  ${paint("warn", symbol("arrow"))} ${hintLine}`);
    }
  }
  return lines;
}
