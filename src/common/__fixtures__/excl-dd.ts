import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { removeTempDir } from "./temp-dir";

/**
 * For specs: a `dd` that honours `conv=excl` on a runner whose own lacks it (macOS's BSD `dd`), so the
 * identity probe's write runs locally as it does on a site. The sites (Ubuntu, GNU coreutils) and CI
 * use their real `dd`; the stand-in is installed only where the system's refuses `conv=excl`.
 *
 * It accepts exactly the probe's operands (`of=`, `conv=excl`, `status=none`) and opens `of` with
 * `O_WRONLY|O_CREAT|O_EXCL`, mode `0666` less the umask — GNU's open — failing as GNU does
 * (`dd: failed to open '<path>': File exists`).
 */

/** The stand-in, in Perl (on every macOS and Ubuntu runner; its `sysopen` is `open(2)`). */
export const EXCL_DD_SHIM = `#!/usr/bin/perl
use strict;
use warnings;
use Fcntl qw(O_WRONLY O_CREAT O_EXCL);
my ($of, $excl);
for my $operand (@ARGV) {
  if ($operand =~ /\\Aof=(.*)\\z/s) { $of = $1; }
  elsif ($operand eq 'conv=excl') { $excl = 1; }
  elsif ($operand ne 'status=none') { print STDERR "dd (stand-in): unsupported operand\\n"; exit 1; }
}
unless (defined $of && $excl) { print STDERR "dd (stand-in): of= and conv=excl are required\\n"; exit 1; }
sysopen(my $out, $of, O_WRONLY | O_CREAT | O_EXCL, 0666)
  or do { print STDERR "dd: failed to open '$of': $!\\n"; exit 1; };
binmode STDIN;
binmode $out;
local $/;
my $data = <STDIN>;
print {$out} (defined $data ? $data : '') or exit 1;
close $out or exit 1;
exit 0;
`;

/** The system `dd`'s answer, once asked. */
let hostHasExcl: boolean | undefined;

/**
 * Whether the system's `dd` takes `conv=excl`: it creates a new file with it in a temporary folder.
 *
 * @returns `true` for GNU coreutils' `dd`.
 */
export function hostDdHasExcl(): boolean {
  if (hostHasExcl !== undefined) return hostHasExcl;
  const dir = mkdtempSync(join(tmpdir(), "excl-dd-"));
  try {
    const result = spawnSync(
      "/bin/sh",
      [
        "-c",
        'dd if=/dev/null of="$1" conv=excl status=none',
        "sh",
        join(dir, "f"),
      ],
      { stdio: "ignore" },
    );
    hostHasExcl = result.status === 0;
  } finally {
    removeTempDir(dir);
  }
  return hostHasExcl;
}

/**
 * Writes the stand-in as `<dir>/dd` when the system's `dd` lacks `conv=excl`.
 *
 * @param dir - a folder on the commands' `PATH`, ahead of the system's.
 * @returns whether it was written.
 */
export function installExclDd(dir: string): boolean {
  if (hostDdHasExcl()) return false;
  writeFileSync(join(dir, "dd"), EXCL_DD_SHIM, { mode: 0o755 });
  return true;
}

/**
 * Puts the stand-in ahead of this process's `PATH` (what a `local` transport's commands inherit) when
 * the system's `dd` lacks `conv=excl`.
 *
 * @returns the undo: `PATH` restored, the stand-in's folder removed.
 */
export function useExclDd(): () => void {
  if (hostDdHasExcl()) return () => undefined;
  const dir = mkdtempSync(join(tmpdir(), "excl-dd-bin-"));
  installExclDd(dir);
  const before = process.env.PATH;
  process.env.PATH = `${dir}${delimiter}${before ?? ""}`;
  return () => {
    if (before === undefined) delete process.env.PATH;
    else process.env.PATH = before;
    removeTempDir(dir);
  };
}
