import { test, expect } from "@playwright/test";

import {
  SITE_IDENTITY_CHECK,
  asksForIdentity,
  identityCheck,
  identityIssues,
  worldWritable,
} from "./site-identity-report";
import type { IdentityFacts } from "./site-identity-report";
import { FALLBACK_REASONS } from "../wp/site-identity";
import type { FallbackReason, IdentityState } from "../wp/site-identity";
import type { SiteIdentityVerdict, WebIdentity } from "../wp/web-identity";
import { describeWpUserDrop } from "../wp/wp-user";
import type { SshTransport, Transport } from "../config/types";

/**
 * The "Site identity" check and the banner's issues, for every state, fallback reason, web verdict,
 * login outcome and sudo listing; the banner stays silent only for a verified `site`/`same-user` site
 * whose sudo keeps command lines out of its log.
 */

const WWW: WebIdentity = {
  euid: 33,
  egid: 33,
  user: "www-data",
  group: "www-data",
  umask: "0022",
  sapi: "fpm-fcgi",
};
const WWW_OWNER = { user: "www-data", group: "www-data", uid: 33, gid: 33 };

/** The `site` state as www-data, umask `umask`. */
const site = (umask = "0022", sudoNoise = false): IdentityState => ({
  kind: "site",
  target: { user: "www-data", group: "www-data" },
  identity: {
    user: "www-data",
    group: "www-data",
    uid: 33,
    gid: 33,
    groupIds: [33],
    groupNames: ["www-data"],
  },
  umask,
  sudoNoise,
});

/** An `owner-is-web` verdict, the web server as `web`. */
const verified = (web: WebIdentity = WWW): IdentityFacts["web"] => ({
  kind: "verdict",
  verdict: { verdict: "owner-is-web", owner: WWW_OWNER, web },
});

/** The facts of a healthy `auto` site in `site`, overridden by `over`. */
const facts = (over: Partial<IdentityFacts> = {}): IdentityFacts => ({
  mode: "ssh",
  runAs: "auto",
  state: site(),
  web: verified(),
  wpUser: { kind: "use" },
  sudo: { kind: "listed", logAllowed: false },
  wpCliConfig: false,
  ...over,
});

/** The check's detail lines. */
const lines = (input: IdentityFacts): string[] =>
  identityCheck(input).detail.split("\n");

test.describe("identityCheck / identityIssues — the healthy site", () => {
  test("site, verified, !log_allowed: every line a note, no warning, nothing for the banner", () => {
    const check = identityCheck(facts());
    expect(check).toEqual({
      name: SITE_IDENTITY_CHECK,
      ok: true,
      detail: [
        "Runs as www-data(33):www-data(33), umask 0022.",
        "The web server's PHP runs as www-data(33):www-data(33), umask 0022 (fpm-fcgi); the docroot is www-data(33):www-data(33), the same.",
        "WP-CLI runs WordPress as the site's WordPress login (`--user`).",
        "sudo keeps command lines out of its log (`!log_allowed`).",
      ].join("\n"),
    });
    expect(identityIssues(facts())).toEqual([]);
  });

  test("same-user off ssh (docker/local): one line, nothing else asked, nothing for the banner", () => {
    const input: IdentityFacts = {
      mode: "docker",
      runAs: undefined,
      state: { kind: "same-user", reason: "mode" },
    };
    expect(identityCheck(input)).toEqual({
      name: SITE_IDENTITY_CHECK,
      ok: true,
      detail: "Runs as the transport's user (this mode has no other identity).",
    });
    expect(identityIssues(input)).toEqual([]);
  });

  test("auto, the SSH user already the verified owner: same-user, nothing for the banner", () => {
    const input = facts({
      state: { kind: "same-user", reason: "transport-user" },
      sudo: undefined,
      wpCliConfig: undefined,
    });
    expect(identityCheck(input).warning).toBeUndefined();
    expect(identityIssues(input)).toEqual([]);
  });
});

test.describe("the check is never a gate", () => {
  const states: IdentityFacts["state"][] = [
    site(),
    { kind: "same-user", reason: "mode" },
    { kind: "disabled", reason: "config" },
    { kind: "fallback", reason: "no-sudo", detail: "x" },
    { kind: "error", detail: "connection reset" },
  ];
  for (const state of states) {
    test(`passes in ${state.kind}`, () => {
      expect(identityCheck(facts({ state })).ok).toBe(true);
    });
  }
});

test.describe("fallback — each reason with its fix, on the line and in the banner", () => {
  for (const reason of Object.keys(FALLBACK_REASONS) as FallbackReason[]) {
    test(reason, () => {
      const input = facts({
        state: { kind: "fallback", reason, detail: "seen this" },
        sudo: { kind: "listed", logAllowed: false },
        wpCliConfig: undefined,
      });
      const check = identityCheck(input);
      const { what, fix } = FALLBACK_REASONS[reason];
      expect(check.warning).toBe(true);
      expect(lines(input)[0]).toBe(
        `Runs as the transport's user: ${what} (seen this). Fix: ${fix}.`,
      );
      expect(identityIssues(input)).toEqual([
        { what: `${what} (seen this)`, fix },
      ]);
    });
  }

  test("no-sudo: sudo refusing to list is the same missing rule, not a second issue", () => {
    const input = facts({
      state: { kind: "fallback", reason: "no-sudo", detail: "x" },
      sudo: { kind: "refused" },
    });
    expect(identityIssues(input)).toHaveLength(1);
    expect(identityCheck(input).detail).not.toContain("sudo -n -l");
  });

  test("owner-not-web without !log_allowed: both issues (the twins' owner-mismatch)", () => {
    const input = facts({
      state: { kind: "fallback", reason: "owner-not-web", detail: "x" },
      sudo: { kind: "listed", logAllowed: true },
    });
    expect(identityIssues(input).map((issue) => issue.what)).toEqual([
      `${FALLBACK_REASONS["owner-not-web"].what} (x)`,
      "sudo logs every command line it runs, `--key=` values included",
    ]);
  });

  test("the /etc/hosts fix shows wherever the run probe saw sudo's noise", () => {
    const input = facts({
      state: {
        kind: "fallback",
        reason: "no-wp",
        detail: "x",
        sudoNoise: true,
      },
    });
    expect(identityCheck(input).detail).toContain(
      "Fix: add the host's name to /etc/hosts.",
    );
    expect(
      identityCheck(facts({ state: site("0022", true) })).detail,
    ).toContain("/etc/hosts");
    expect(identityCheck(facts()).detail).not.toContain("/etc/hosts");
  });
});

test.describe("disabled and unresolved", () => {
  test("runAs false: an opt-out, a note on the line and nothing in the banner; no sudo asked", () => {
    const input: IdentityFacts = {
      mode: "ssh",
      runAs: false,
      state: { kind: "disabled", reason: "config" },
      wpUser: { kind: "use" },
    };
    const check = identityCheck(input);
    expect(check.warning).toBeUndefined();
    expect(lines(input)[0]).toBe(
      "Runs as the transport's user, as configured (`runAs` is false); nothing to fix.",
    );
    expect(identityIssues(input)).toEqual([]);
  });

  test("an as-today copy is never listed", () => {
    expect(
      identityIssues({
        mode: "ssh",
        runAs: false,
        state: { kind: "disabled", reason: "as-transport-user" },
      }),
    ).toEqual([]);
  });

  test("a state whose probe threw: a warning naming the error, and an issue", () => {
    const input = facts({ state: { kind: "error", detail: "ECONNRESET" } });
    expect(lines(input)[0]).toBe("Could not be resolved: ECONNRESET");
    expect(identityCheck(input).warning).toBe(true);
    expect(identityIssues(input)[0]?.what).toContain("ECONNRESET");
  });
});

test.describe("web identity versus the run identity", () => {
  test("site without a web probe, or with one that failed or could not tell: unverified in the banner", () => {
    const cases: [IdentityFacts["web"], string][] = [
      [undefined, "no web probe ran"],
      [{ kind: "error", detail: "boom" }, "the web probe failed"],
      [
        {
          kind: "verdict",
          verdict: {
            verdict: "unverified",
            reason: "not-served",
            detail: "HTTP 404",
          },
        },
        "the probe was not served",
      ],
    ];
    for (const [web, why] of cases) {
      const input = facts({ runAs: "www-data:www-data", web });
      const [issue] = identityIssues(input);
      expect(issue?.what).toContain(
        `the web server's identity was not verified: ${why}`,
      );
    }
  });

  test("each unverified reason in words, warned", () => {
    const reasons: [SiteIdentityVerdict & { verdict: "unverified" }, string][] =
      [
        [
          { verdict: "unverified", reason: "not-writable", detail: "d" },
          "could not be written",
        ],
        [
          { verdict: "unverified", reason: "unreachable", detail: "d" },
          "did not answer",
        ],
        [
          { verdict: "unverified", reason: "not-served", detail: "d" },
          "was not served",
        ],
        [
          { verdict: "unverified", reason: "not-probe-output", detail: "d" },
          "did not run the probe",
        ],
        [
          { verdict: "unverified", reason: "no-posix", detail: "d" },
          "no posix extension",
        ],
        [
          { verdict: "unverified", reason: "no-owner", detail: "d" },
          "owner could not be read",
        ],
      ];
    for (const [verdict, words] of reasons) {
      const input = facts({
        state: { kind: "fallback", reason: "unverified", detail: "x" },
        web: { kind: "verdict", verdict },
      });
      expect(lines(input)[1]).toContain(words);
      expect(identityCheck(input).warning).toBe(true);
    }
  });

  test("a dd without conv=excl is named", () => {
    const input = facts({
      state: { kind: "fallback", reason: "unverified", detail: "x" },
      web: {
        kind: "verdict",
        verdict: {
          verdict: "unverified",
          reason: "not-writable",
          detail: "dd: unknown conversion excl",
        },
      },
    });
    expect(lines(input)[1]).toContain("has no `conv=excl` (BSD or BusyBox)");
  });

  test("a web probe that threw is a warning naming the error", () => {
    const input = facts({
      state: { kind: "fallback", reason: "unverified", detail: "x" },
      web: { kind: "error", detail: "ECONNRESET" },
    });
    expect(lines(input)[1]).toBe(
      "The web server's identity could not be probed: ECONNRESET",
    );
  });

  test("owner-not-web: both identities named, the docroot not 'the same'", () => {
    const input = facts({
      state: { kind: "fallback", reason: "owner-not-web", detail: "x" },
      web: {
        kind: "verdict",
        verdict: {
          verdict: "owner-not-web",
          owner: { user: "sftp_twin", group: "www-data", uid: 1002, gid: 33 },
          web: WWW,
        },
      },
    });
    expect(lines(input)[1]).toBe(
      "The web server's PHP runs as www-data(33):www-data(33), umask 0022 (fpm-fcgi); the docroot is sftp_twin(1002):www-data(33).",
    );
  });

  test("a declared identity the web server is not: warned and listed", () => {
    const nginx: WebIdentity = {
      ...WWW,
      euid: 101,
      egid: 101,
      user: "nginx",
      group: "nginx",
    };
    const input = facts({ runAs: "www-data:www-data", web: verified(nginx) });
    expect(identityCheck(input).detail).toContain(
      "Commands run as www-data(33):www-data(33), but the web server as nginx(101):nginx(101)",
    );
    expect(identityIssues(input)).toEqual([
      {
        what: "site commands run as www-data(33):www-data(33), the web server as nginx(101):nginx(101)",
        fix: 'set `runAs` to the web server\'s user and group, or "auto"',
      },
    ]);
  });

  test("site: a web server differing only in its user, or only in its group, is another identity", () => {
    for (const other of [
      { ...WWW, euid: 1000, user: "deploy" },
      { ...WWW, egid: 1000, group: "deploy" },
    ]) {
      const input = facts({ web: verified(other) });
      expect(identityCheck(input).detail).toContain(
        "Commands run as www-data(33):www-data(33), but the web server as",
      );
      expect(identityIssues(input)[0]?.what).toMatch(
        /^site commands run as www-data\(33\):www-data\(33\), the web server as /,
      );
    }
  });

  test("declared same-user: a web server differing only in its group is listed", () => {
    const issues = identityIssues(
      facts({
        runAs: "www-data:www-data",
        state: { kind: "same-user", reason: "transport-user" },
        sudo: undefined,
        web: verified({ ...WWW, egid: 1000, group: "deploy" }),
      }),
    );
    expect(issues[0]?.what).toBe(
      "site commands run as www-data:www-data, the web server as www-data(33):deploy(1000)",
    );
  });

  test("declared same-user: matched by name or id, else listed", () => {
    const sameUser = { kind: "same-user", reason: "transport-user" } as const;
    for (const runAs of [
      "www-data:www-data",
      "33:33",
      "www-data:33",
    ] as const) {
      expect(
        identityIssues(facts({ runAs, state: sameUser, sudo: undefined })),
      ).toEqual([]);
    }
    const issues = identityIssues(
      facts({ runAs: "deploy:deploy", state: sameUser, sudo: undefined }),
    );
    expect(issues[0]?.what).toBe(
      "site commands run as deploy:deploy, the web server as www-data(33):www-data(33)",
    );
    expect(
      identityIssues(
        facts({ runAs: "www-data:www-data", state: sameUser, web: undefined }),
      ),
    ).toHaveLength(1);
  });
});

test.describe("umask", () => {
  test("worldWritable: only a umask without the other-write bit", () => {
    for (const umask of ["0000", "0001", "0004", "0020", "0005"]) {
      expect(worldWritable(umask)).toBe(true);
    }
    for (const umask of ["0002", "0022", "0027", "0077", "0007"]) {
      expect(worldWritable(umask)).toBe(false);
    }
  });

  test("a world-writable umask in site warns on the line, never in the banner", () => {
    const input = facts({
      state: site("0000"),
      web: verified({ ...WWW, umask: "0000" }),
    });
    expect(identityCheck(input).detail).toContain(
      'umask 0000 leaves "other" write access',
    );
    expect(identityCheck(input).warning).toBe(true);
    expect(identityIssues(input)).toEqual([]);
    expect(identityCheck(facts()).detail).not.toContain("world-writable");
  });

  test("the web server's umask differing from the run's warns with the fix", () => {
    const input = facts({ web: verified({ ...WWW, umask: "0002" }) });
    expect(identityCheck(input).detail).toContain(
      'The web server\'s umask is 0002; site commands use 0022. Fix: set `transport.umask` to "0002".',
    );
    expect(identityIssues(input)).toEqual([]);
  });
});

test.describe("sudo's log", () => {
  test("logging: a warning and an issue; unknown (unreadable, or refused while sudo works): both", () => {
    for (const sudo of [
      { kind: "listed", logAllowed: true },
      { kind: "unreadable" },
      { kind: "refused" },
    ] as const) {
      const input = facts({ sudo });
      expect(identityCheck(input).warning).toBe(true);
      const issues = identityIssues(input);
      expect(issues).toHaveLength(1);
      expect(issues[0]?.fix).toContain("Defaults:<ssh user> !log_allowed");
    }
  });

  test("not asked, or a state that never uses sudo: nothing said", () => {
    expect(identityCheck(facts({ sudo: undefined })).detail).not.toContain(
      "sudo",
    );
    const sameUser = facts({
      state: { kind: "same-user", reason: "transport-user" },
      sudo: { kind: "listed", logAllowed: true },
    });
    expect(identityIssues(sameUser)).toEqual([]);
  });
});

test.describe("the WordPress login and WP-CLI's config", () => {
  test("each drop reason is its own warning, never the login", () => {
    for (const reason of ["missing", "numeric", "not-admin"] as const) {
      const input = facts({ wpUser: { kind: "drop", reason } });
      expect(lines(input)).toContain(describeWpUserDrop(reason));
      expect(identityCheck(input).warning).toBe(true);
      expect(identityIssues(input)).toEqual([]);
    }
  });

  test("unknown and a failed check are warnings", () => {
    expect(
      identityCheck(facts({ wpUser: { kind: "unknown" } })).detail,
    ).toContain("could not be checked (WordPress gave no answer)");
    expect(
      identityCheck(facts({ wpUser: { kind: "error", detail: "boom" } }))
        .detail,
    ).toContain("could not be checked: boom");
  });

  test("no login: no line", () => {
    expect(identityCheck(facts({ wpUser: undefined })).detail).not.toContain(
      "WordPress login",
    );
  });

  test("the SSH user's ~/.wp-cli/config.yml no longer applies in site", () => {
    const input = facts({ wpCliConfig: true });
    expect(identityCheck(input).detail).toContain(
      "~/.wp-cli/config.yml no longer applies",
    );
    expect(identityIssues(input)).toEqual([]);
    expect(
      identityCheck(
        facts({
          state: { kind: "fallback", reason: "no-sudo", detail: "x" },
          wpCliConfig: true,
        }),
      ).detail,
    ).not.toContain("config.yml");
  });
});

test.describe("asksForIdentity", () => {
  const ssh = (runAs?: SshTransport["runAs"]): Transport => ({
    mode: "ssh",
    host: "h",
    username: "u",
    privateKeyPath: "/k",
    rootDir: "/r",
    ...(runAs === undefined ? {} : { runAs }),
  });

  test("ssh with auto or a declared identity asks; false, absent (the default) and other modes do not", () => {
    expect(asksForIdentity(ssh("auto"))).toBe(true);
    expect(asksForIdentity(ssh("www-data:www-data"))).toBe(true);
    expect(asksForIdentity(ssh(false))).toBe(false);
    expect(asksForIdentity(ssh())).toBe(false);
    expect(asksForIdentity({ mode: "local", rootDir: "/r" })).toBe(false);
    expect(asksForIdentity({ mode: "docker", container: "c" })).toBe(false);
  });
});
