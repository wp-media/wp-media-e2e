import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";

import { SKIP_SUDO_OPTIONS } from "./fake-sudo";

/**
 * The options every fake `sudo` reads, run through the system's `/bin/sh`: what is left in `"$@"`,
 * and who it exported, for each `sudo` line the suite sends.
 */

/**
 * Runs {@link SKIP_SUDO_OPTIONS} on `argv`, then prints the exported user and group and what is left.
 *
 * @param argv - `sudo`'s arguments.
 * @returns its exit code, stdout and stderr.
 */
function skip(argv: readonly string[]): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  const script = `${SKIP_SUDO_OPTIONS}
printf '%s|%s|' "\${E2E_FAKE_SUDO_USER:-}" "\${E2E_FAKE_SUDO_GROUP:-}"
printf '[%s]' "$@"`;
  const {
    E2E_FAKE_SUDO_USER: _u,
    E2E_FAKE_SUDO_GROUP: _g,
    ...env
  } = process.env;
  const result = spawnSync("/bin/sh", ["-c", script, "sudo", ...argv], {
    encoding: "utf8",
    env,
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

for (const [label, argv, left] of [
  ["root's command", ["-n", "--", "rm", "-rf", "x"], "||[rm][-rf][x]"],
  ["the capability probe, with no --", ["-n", "true"], "||[true]"],
  [
    "the site's identity",
    ["-n", "-u", "www-data", "-g", "#33", "--", "/bin/sh", "-c", "-n"],
    "www-data|#33|[/bin/sh][-c][-n]",
  ],
  ["arguments after -- that look like options", ["--", "-u", "x"], "||[-u][x]"],
] as const) {
  test(`${label}: options read, the command left as given`, () => {
    expect(skip(argv)).toEqual({ status: 0, stdout: left, stderr: "" });
  });
}

test("an option a stub does not know fails, running nothing", () => {
  const result = skip(["-E", "--", "rm", "x"]);

  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe("sudo (fake): unsupported option -E\n");
});
