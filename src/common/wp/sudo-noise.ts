/**
 * sudo's unresolvable-host line, and how to take it out of a command's stderr. Pure and
 * dependency-free: the exec layer, the identity probe and the pre-flight's readers share it.
 *
 * When a host cannot resolve its own name, `sudo` (1.9.15, measured on Ubuntu 24.04) prints
 * `sudo: unable to resolve host <name>: <reason>` on every call — whether it then runs the command,
 * refuses it, or only lists — with the exit code and stdout unchanged. The reason is the resolver's:
 * `Name or service not known` (the name is unknown), `Temporary failure in name resolution` (no
 * resolver answered); older versions print none. The suite cannot fix the host, so it removes the
 * line wherever it reads stderr from a command `sudo` carried: left in, it would be quoted as the
 * command's own words, hide stdout behind `stderr || stdout`, or turn an all-benign warning list
 * into an unknown one.
 *
 * Only sudo's untranslated text is recognised: sudo localises it under a locale it has a catalogue for
 * (measured: `LANG=de_DE.UTF-8` with `language-pack-de-base` prints `sudo: Hostname … kann nicht
 * aufgelöst werden: …`), and such a line is left as printed.
 */

/** sudo's line for an unresolvable host name, whole: with or without the resolver's reason. */
const HOSTNAME_NOISE = /^sudo: unable to resolve host \S.*$/;

/** How sudo prefixes its own warnings and refusals. */
const SUDO_PREFIX = "sudo: ";

/**
 * The index of the first line past sudo's own leading lines: the `sudo:` lines it prints before the
 * command runs (other warnings, such as a world-writable `sudo.conf`, may come before the host line,
 * measured).
 *
 * @param lines - stderr split on `\n`.
 */
function preambleEnd(lines: readonly string[]): number {
  const end = lines.findIndex((line) => !line.startsWith(SUDO_PREFIX));
  return end === -1 ? lines.length : end;
}

/**
 * Whether one line is sudo's unresolvable-host line (a trailing `\r` ignored).
 *
 * @param line - one line of stderr.
 */
function isNoise(line: string): boolean {
  return HOSTNAME_NOISE.test(line.replace(/\r$/, ""));
}

/**
 * `stderr` without sudo's unresolvable-host lines. Only those among sudo's **leading** `sudo:` lines
 * are removed — sudo prints them before the command runs; the same text later is the program's own
 * and stays, as does every other line, byte for byte.
 *
 * @param stderr - the stderr of a command `sudo` carried (any other text comes back unchanged unless
 * it opens with such a line).
 * @returns the rest of the text.
 * @example
 * ```ts
 * withoutSudoNoise("sudo: unable to resolve host web1: Name or service not known\nls: denied");
 * // "ls: denied"
 * ```
 */
export function withoutSudoNoise(stderr: string): string {
  const lines = stderr.split("\n");
  const end = preambleEnd(lines);
  if (!lines.slice(0, end).some(isNoise)) return stderr;
  return [
    ...lines.slice(0, end).filter((line) => !isNoise(line)),
    ...lines.slice(end),
  ].join("\n");
}

/**
 * Whether sudo's leading lines in `stderr` hold its unresolvable-host line.
 *
 * @param stderr - the stderr of a command `sudo` carried.
 */
export function hasSudoNoise(stderr: string): boolean {
  const lines = stderr.split("\n");
  return lines.slice(0, preambleEnd(lines)).some(isNoise);
}
