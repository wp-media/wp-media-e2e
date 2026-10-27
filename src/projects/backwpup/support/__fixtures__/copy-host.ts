import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOOT_ID_PATH,
  CONTENT_COPY_DB_DEFAULTS,
  CONTENT_COPY_FILE,
  CONTENT_COPY_RESTORED,
  CONTENT_COPY_STAMP,
  CONTENT_COPY_TOKEN,
  RECOVERING_PREFIX,
} from "../content-copy";
import type { LocalTransport } from "../../../../common/config/types";

/**
 * A stubbed host for the copy of `wp-content` (`../content-copy.ts`, `../content-copy-leftover.ts`):
 * stubs on `PATH`, recording every argv, that do the directory work for real — `mkdir`, `mv`
 * (emulating GNU `-T`, which macOS lacks), `rm`, `rmdir`, `ls`, and the copy's root scripts under the
 * real `sh` — and answer the rest from the environment:
 *
 * - `stat -c %u:%a .`: `H_OWNER` (default `0:700`, root's alone).
 * - the boot id (`cp`/`cat` of {@link BOOT_ID_PATH}): `H_BOOT` (default {@link BOOT}); `cat` exits
 *   `H_BOOT_EXIT`, `cp` `H_CP_EXIT`; a stamp's `cat` exits `H_STAMP_EXIT`, the saved database
 *   defaults' `H_DEFAULTS_EXIT` (each after printing).
 * - `tar`: `-cf` makes an empty archive (exit `COPY_TAR_EXIT`, stderr `COPY_TAR_ERR`); `-tf` lists a
 *   copy (exit `H_LIST_EXIT`); `-xpf` exits `H_PUT_EXIT`.
 * - `du`/`df`: `COPY_DU_KB`, `COPY_DU_EMPTY`, `COPY_FREE_KB`; `sync`: `H_SEAL_EXIT`; `ls`:
 *   `H_LS_EXIT`; `rmdir`: `H_RMDIR_EXIT`; marking a copy back: `H_MARK_EXIT`.
 * - the in-use probe: `H_INUSE` printed, exit `H_INUSE_EXIT`, from its `H_INUSE_FROM`th call (default
 *   1) to its `H_INUSE_UNTIL`th; otherwise the real probe runs (no `/proc` on macOS: nothing found).
 * - `H_LOSE_ROOT`: `sync` moves the WordPress root away, so the next command cannot start (throws);
 *   `H_MKDIR_RACE`: `mkdir` finds another run's directory made first; `H_MKDIR_TOKENDIR`: it makes a
 *   directory where the token goes, so writing the token fails.
 * - `H_SWAP_TOKEN`: the stamp written when the copy is made also swaps its token for another run's;
 *   `H_SWAP_TOKEN_ON_TF`: so does reading a copy back. `H_SUDO_REFUSE_MAKE`: `sudo` refuses making
 *   the copy (exit 1), another run's copy appearing there meanwhile.
 * - a claim (`sudo mv` to a claimed name), `H_MV`: `race` — another run claims (and stamps) it first;
 *   `race-old` — the same, unstamped; `gone` — another run claimed and settled it; `fail` — the
 *   rename fails, source kept; `swap` — it succeeds, then the claimed directory is swapped for a link;
 *   `shrink` — it succeeds, and the whole copy is gone from it.
 */

/** The boot id the stubbed host reports as current. */
export const BOOT = "11111111-1111-4111-8111-111111111111";

/** A boot id from another boot. */
export const OLD_BOOT = "22222222-2222-4222-8222-222222222222";

/** Every variable the stubs read, cleared after each test. */
const ENV = [
  "H_OWNER",
  "H_BOOT",
  "H_BOOT_EXIT",
  "H_CP_EXIT",
  "H_STAMP_EXIT",
  "H_DEFAULTS_EXIT",
  "COPY_TAR_EXIT",
  "COPY_TAR_ERR",
  "H_LIST_EXIT",
  "H_PUT_EXIT",
  "COPY_DU_KB",
  "COPY_DU_EMPTY",
  "COPY_FREE_KB",
  "H_SEAL_EXIT",
  "H_LS_EXIT",
  "H_RMDIR_EXIT",
  "H_MARK_EXIT",
  "H_INUSE",
  "H_INUSE_EXIT",
  "H_INUSE_FROM",
  "H_INUSE_UNTIL",
  "H_MV",
  "H_LOSE_ROOT",
  "H_MKDIR_RACE",
  "H_MKDIR_TOKENDIR",
  "H_SWAP_TOKEN",
  "H_SWAP_TOKEN_ON_TF",
  "H_SUDO_REFUSE_MAKE",
];

/** A stubbed host and a scratch WordPress root on it. */
export interface CopyHost {
  /** The WordPress root, holding an empty `wp-content`. */
  readonly root: string;
  /** A local transport to it. */
  readonly transport: LocalTransport;
  /** Every stubbed command run so far, as `name args…`. */
  log(): string[];
  /** Removes it all and restores `PATH` and the environment. */
  dispose(): void;
}

/**
 * Writes a stub on `PATH` that records its argv, then runs `body`.
 *
 * @param binDir - the stubs' directory.
 * @param name - the command.
 * @param body - bash.
 */
function stub(binDir: string, name: string, body: string): void {
  writeFileSync(
    join(binDir, name),
    // One log line per call: a root script's newlines folded.
    `#!/usr/bin/env bash\nline="${name} $*"; printf '%s\\n' "\${line//$'\\n'/ ⏎ }" >> "${join(binDir, "log")}"\n${body}\n`,
  );
  chmodSync(join(binDir, name), 0o755);
}

/**
 * Sets up a stubbed host — see the module header. Call {@link CopyHost.dispose} after.
 */
export function copyHost(): CopyHost {
  const binDir = mkdtempSync(join(tmpdir(), "bwp-host-bin-"));
  const root = mkdtempSync(join(tmpdir(), "bwp-host-root-"));
  mkdirSync(join(root, "wp-content"));
  const realPath = process.env.PATH ?? "";
  process.env.PATH = `${binDir}:${realPath}`;
  stub(
    binDir,
    "sudo",
    `shift 2
case "$1" in
  true) exit 0 ;;
  du) [ -n "\${COPY_DU_EMPTY:-}" ] && exit 1; printf '%s\\t%s\\n' "\${COPY_DU_KB:-1000}" "$4"; exit 0 ;;
  rmdir) [ -n "\${H_RMDIR_EXIT:-}" ] && exit "$H_RMDIR_EXIT"; exec "$@" ;;
  mv)
    src="$4" dst="$5"
    case "\${H_MV:-}" in
      race|race-old) new="$(mktemp -u "$(dirname "$src")/${RECOVERING_PREFIX}wXXXXXX")"; /bin/mv "$src" "$new"
        [ "$H_MV" = race ] && printf '%s\\n' "\${H_BOOT:-${BOOT}}" > "$new/${CONTENT_COPY_STAMP}"
        echo "mv: cannot stat" >&2; exit 1 ;;
      shrink) /bin/mv "$src" "$dst"; rm -f "$dst/${CONTENT_COPY_FILE}"; exit 0 ;;
      gone) rm -r "$src"; echo "mv: cannot stat" >&2; exit 1 ;;
      fail) echo "mv: cannot move: Device or resource busy" >&2; exit 1 ;;
      swap) /bin/mv "$src" "$dst.real"; ln -s "$dst.real" "$dst"; exit 0 ;;
    esac
    exec /bin/mv "$src" "$dst" ;;
  sh)
    case "$3" in
      *e2e-content-copy-in-use-probe*)
        n=$(( $(cat "${binDir}/probes" 2>/dev/null || echo 0) + 1 )); echo "$n" > "${binDir}/probes"
        if [ -n "\${H_INUSE+x}" ] && [ "$n" -ge "\${H_INUSE_FROM:-1}" ] && [ "$n" -le "\${H_INUSE_UNTIL:-999999}" ]; then printf '%s' "$H_INUSE"; exit "\${H_INUSE_EXIT:-0}"; fi ;;
    esac
    if [ -n "\${H_SUDO_REFUSE_MAKE:-}" ] && [ "$5" = make ]; then
      /bin/mkdir -p "$6"; : > "$6/theirs"; echo "sudo: a password is required" >&2; exit 1
    fi
    exec "$@" ;;
esac
exec "$@"`,
  );
  stub(binDir, "stat", 'echo "${H_OWNER:-0:700}"');
  stub(
    binDir,
    "cp",
    `if [ "$2" = ${BOOT_ID_PATH} ]; then
  [ -n "\${H_CP_EXIT:-}" ] && exit "$H_CP_EXIT"
  printf '%s\\n' "\${H_BOOT:-${BOOT}}" > "$3"
  [ -n "\${H_SWAP_TOKEN:-}" ] && printf 'another-run\\n' > ${CONTENT_COPY_TOKEN}
  exit 0
fi
exec /bin/cp "$@"`,
  );
  stub(
    binDir,
    "cat",
    `if [ "$1" = ${BOOT_ID_PATH} ]; then printf '%s\\n' "\${H_BOOT:-${BOOT}}"; exit "\${H_BOOT_EXIT:-0}"; fi
if [ "$2" = ${CONTENT_COPY_DB_DEFAULTS} ] && [ -n "\${H_DEFAULTS_EXIT:-}" ]; then /bin/cat "$@"; exit "$H_DEFAULTS_EXIT"; fi
if [ -n "\${H_STAMP_EXIT:-}" ]; then /bin/cat "$@"; exit "$H_STAMP_EXIT"; fi
exec /bin/cat "$@"`,
  );
  stub(
    binDir,
    "tar",
    `case "$1" in
  -cf) : > "$2"; [ -n "\${COPY_TAR_ERR:-}" ] && printf '%s\\n' "$COPY_TAR_ERR" >&2; exit "\${COPY_TAR_EXIT:-0}" ;;
  -tf) [ -n "\${H_SWAP_TOKEN_ON_TF:-}" ] && printf 'another-run\\n' > ${CONTENT_COPY_TOKEN}
    [ "\${H_LIST_EXIT:-0}" = 0 ] && printf 'wp-content/\\nwp-content/index.php\\n' || echo "tar: Unexpected EOF in archive" >&2; exit "\${H_LIST_EXIT:-0}" ;;
  -xpf) [ "\${H_PUT_EXIT:-0}" != 0 ] && echo "tar: ./f1: Cannot open: File exists" >&2; exit "\${H_PUT_EXIT:-0}" ;;
esac
exit 0`,
  );
  stub(
    binDir,
    "sync",
    `if [ -n "\${H_LOSE_ROOT:-}" ]; then /bin/mv "${root}" "${root}.gone"; fi
exit "\${H_SEAL_EXIT:-0}"`,
  );
  stub(
    binDir,
    "mkdir",
    `if [ -n "\${H_MKDIR_TOKENDIR:-}" ]; then d="\${@: -1}"; /bin/mkdir "$@" && /bin/mkdir "$d/${CONTENT_COPY_TOKEN}"; exit; fi
if [ -n "\${H_MKDIR_RACE:-}" ]; then d="\${@: -1}"; /bin/mkdir -- "$d"; : > "$d/theirs"; echo "mkdir: File exists" >&2; exit 1; fi
exec /bin/mkdir "$@"`,
  );
  stub(
    binDir,
    "mv",
    `[ "$1" = -T ] && shift; [ "$1" = -- ] && shift
[ "$2" = ${CONTENT_COPY_RESTORED} ] && [ -n "\${H_MARK_EXIT:-}" ] && exit "$H_MARK_EXIT"
exec /bin/mv "$@"`,
  );
  stub(
    binDir,
    "ls",
    '[ -n "${H_LS_EXIT:-}" ] && exit "$H_LS_EXIT"; exec /bin/ls "$@"',
  );
  stub(
    binDir,
    "df",
    `printf 'Filesystem 1024-blocks Used Available Capacity Mounted\\n'
printf '/dev/x 100 50 %s 50%% /\\n' "\${COPY_FREE_KB:-99999999}"`,
  );
  return {
    root,
    transport: { mode: "local", rootDir: root },
    log: () =>
      existsSync(join(binDir, "log"))
        ? readFileSync(join(binDir, "log"), "utf8").trim().split("\n")
        : [],
    dispose: () => {
      process.env.PATH = realPath;
      for (const key of ENV) Reflect.deleteProperty(process.env, key);
      rmSync(binDir, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(`${root}.gone`, { recursive: true, force: true });
    },
  };
}
