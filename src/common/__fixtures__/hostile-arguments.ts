/**
 * For specs: arguments that must reach a program byte for byte, through every way a command is sent
 * (the transport's line, root's `sudo`, the site's `sudo` wrapper).
 */

/**
 * Arguments that once broke, or could break, a command line: those node-ssh was measured passing
 * through untouched, plus the empty one its own escaping dropped. The long one stops short of 64 KiB
 * (the size measured on a real server) only because ssh2's server refuses a packet over 35,000 bytes;
 * `shellQuote`'s table takes the full size.
 */
export const HOSTILE_ARGUMENTS: readonly string[] = [
  "",
  "'",
  '"',
  "it's",
  'say "hi"',
  "$(id)",
  "`id`",
  "${HOME}",
  "$HOME",
  "a\nb",
  "a\rb",
  "a\tb",
  "--key=a b",
  "--key=SECRET value; rm -rf /",
  "-n",
  "--",
  "a;b",
  "a|b",
  "a&b",
  "a>b",
  "*",
  "~",
  " leading and trailing ",
  "café ✓",
  Buffer.alloc(22 * 1024, "e2e").toString("base64"),
];
