import { test, expect } from "@playwright/test";

import {
  renderElevationWarning,
  renderIdentityWarning,
  renderPluginDirWarning,
} from "./elevation-report";
import type { SiteElevation, SiteIdentityIssues } from "./elevation-report";
import { createPalette } from "../terminal/palette";

/**
 * The run-level elevation warning, tested as what it is: a pure function from results to text.
 *
 * The properties worth pinning are the ones a terminal would hide — that it stays silent when
 * nothing is wrong, that a *deliberate* opt-out is never nagged about, that the affected sites are
 * named, and that the block is padded so it cannot be lost in tightly-packed output.
 */

/** One site's elevation state. Ownership is pending unless a case says otherwise. */
const site = (
  host: string,
  support: SiteElevation["support"],
  ownershipPending = true,
): SiteElevation => ({
  baseURL: `https://${host}`,
  transport: `ssh: ubuntu@${host}`,
  support,
  ownershipPending,
});

/**
 * ESC, built rather than written into a regex literal — lint bans a control character there, and
 * rightly: an invisible byte in a pattern is unreviewable in a diff.
 */
const ESC = String.fromCharCode(27);

/** ANSI colour sequences, for stripping. */
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

/** The banner with colour escapes stripped, so assertions read as the operator sees it. */
function plain(sites: readonly SiteElevation[]): string {
  return (renderElevationWarning(sites) ?? "").replace(ANSI, "");
}

test("says nothing when every site can elevate", () => {
  expect(
    renderElevationWarning([
      site("a.test", "available"),
      site("b.test", "available"),
    ]),
  ).toBeUndefined();
});

// The site declared `transport.elevate: false`. Warning about a choice the operator made every run
// is how a banner gets ignored when it finally matters.
test("says nothing about a site that declined privileges deliberately", () => {
  expect(
    renderElevationWarning([
      site("a.test", "disabled"),
      site("b.test", "available"),
    ]),
  ).toBeUndefined();
});

test("says nothing at all when there are no sites", () => {
  expect(renderElevationWarning([])).toBeUndefined();
});

test("names every affected site, and only those", () => {
  const text = plain([
    site("broken.test", "unavailable"),
    site("fine.test", "available"),
    site("opted-out.test", "disabled"),
    site("also-broken.test", "unavailable"),
  ]);

  expect(text).toContain("broken.test");
  expect(text).toContain("also-broken.test");
  expect(text).not.toContain("fine.test");
  expect(text).not.toContain("opted-out.test");
  // Counted as affected sites only. A denominator here would be the number of sites that got far
  // enough to be *asked* about privileges, not the fleet — so "2 of 2" on a run where a third site
  // failed its transport outright would quietly mean something other than it appears to.
  expect(text).toContain("on 2 site(s)");
  expect(text).not.toMatch(/\d+ of \d+/);
});

test("states both possible causes, because sudo reports them identically", () => {
  const text = plain([site("broken.test", "unavailable")]);
  expect(text).toMatch(/not a sudoer/);
  expect(text).toMatch(/requires a password/);
  expect(text).toMatch(/cannot tell\s+them apart/);
});

test("names the concrete cost and both remedies", () => {
  const text = plain([site("broken.test", "unavailable")]);
  expect(text).toMatch(/ownership is NOT normalized/);
  expect(text).toMatch(/leftover plugin data is NOT removed/);
  expect(text).toMatch(/debug\.log/);
  expect(text).toMatch(/NOPASSWD/);
  expect(text).toMatch(/transport\.elevate: false/);
});

// The whole point of the block: it must survive being printed between other output.
test("is padded with a blank line above and below", () => {
  const lines = plain([site("broken.test", "unavailable")]).split("\n");
  expect(lines[0]).toBe("");
  expect(lines.at(-1)).toBe("");
});

/** A coloured terminal's palette, an ASCII one (plain mode, a dumb terminal, a C locale). */
const COLOUR = createPalette({ tty: true, color: true, unicode: true });
const ASCII = createPalette({ tty: false, color: false, unicode: false });

/**
 * Unstyled by default: the banner is data until a printer styles it for its own stream. A worker's
 * banner goes through the run's reporter, which strips escapes anyway; `healthcheck > fleet.log` must
 * hold none. The padding and the `⚠` are what make it stand out there.
 */
test("is plain text by default, the warning carried by its mark", () => {
  const raw =
    renderElevationWarning([site("broken.test", "unavailable")]) ?? "";
  expect(raw).not.toContain(ESC);
  expect(raw).toContain(
    "  ⚠  ELEVATION UNAVAILABLE — cleanup will be incomplete",
  );
  expect(raw).toContain("     → grant passwordless sudo");
  expect(raw).toContain(
    "       • leftover plugin data is NOT removed → the site",
  );
  expect(raw).toContain("  ←  ownership handover pending");
});

// Printed to a coloured terminal (the healthcheck on a TTY): the headline bold yellow, the remedies'
// arrows yellow — and nothing else styled, so a copied line pastes clean.
test("styles the headline and the remedies' arrows with a coloured palette", () => {
  const raw =
    renderElevationWarning([site("broken.test", "unavailable")], COLOUR) ?? "";
  const lines = raw.split("\n");
  expect(lines[1]).toBe(
    `${ESC}[1m${ESC}[33m  ⚠  ELEVATION UNAVAILABLE — cleanup will be incomplete on 1 site(s)${ESC}[39m${ESC}[22m`,
  );
  expect(lines).toContain(
    `     ${ESC}[33m→${ESC}[39m grant passwordless sudo, e.g. \`<user> ALL=(ALL) NOPASSWD:ALL\` in /etc/sudoers.d/`,
  );
  expect(lines).toContain(
    `     ${ESC}[33m→${ESC}[39m or accept it deliberately: set \`transport.elevate: false\` on the site to`,
  );
  expect(raw.replace(ANSI, "")).toBe(
    renderElevationWarning([site("broken.test", "unavailable")]),
  );
});

// Plain mode, a dumb terminal or a C locale: every glyph has an ASCII spelling.
test("spells every symbol in ASCII with an ASCII palette", () => {
  const raw =
    renderElevationWarning([site("broken.test", "unavailable")], ASCII) ?? "";
  expect(raw).not.toContain(ESC);
  expect(raw).toMatch(/^[\x20-\x7e\n]*$/);
  expect(raw).toContain(
    "  !  ELEVATION UNAVAILABLE - cleanup will be incomplete",
  );
  expect(raw).toContain("  <-  ownership handover pending");
  expect(raw).toContain(
    "       * leftover plugin data is NOT removed -> the site",
  );
  expect(raw).toContain("     -> grant passwordless sudo");
});

/**
 * The banner must not assert a cost the pre-flight check printed one line above it denies. A site
 * whose transport user already owns the install is told there that nothing will be changed; saying
 * "ownership is NOT normalized" for it in the next paragraph is how a warning stops being read.
 */
test("claims the ownership cost only for sites that actually needed a handover", () => {
  const owned = plain([site("owns-it.test", "unavailable", false)]);
  expect(owned).not.toContain("ownership is NOT normalized");
  expect(owned).not.toContain("ownership handover pending");
  // The costs that are true for every affected site are still stated.
  expect(owned).toContain("leftover plugin data is NOT removed");

  const needs = plain([site("needs-it.test", "unavailable", true)]);
  expect(needs).toContain("ownership is NOT normalized");

  // Mixed: the cost appears once, and only the site it is true for is marked.
  const mixed = plain([
    site("owns-it.test", "unavailable", false),
    site("needs-it.test", "unavailable", true),
  ]);
  expect(mixed).toContain("ownership is NOT normalized");
  expect(
    mixed
      .split("\n")
      .filter((line) => line.includes("ownership handover pending")),
  ).toHaveLength(1);
  expect(mixed).toContain("needs-it.test  [ssh: ubuntu@needs-it.test]  ←");
});

test("names each site by maskSiteUrl: credentials ***@, a baseURL that is no URL never printed", () => {
  const banner = plain([
    {
      baseURL: "https://admin:pw-0001@creds.test/wp?k=v",
      transport: "ssh: ubuntu@creds.test",
      support: "unavailable",
      ownershipPending: true,
    },
    {
      baseURL: "https://admin:pa ss-word9@bad host/",
      transport: "ssh: ubuntu@bad",
      support: "unavailable",
      ownershipPending: true,
    },
  ]);
  expect(banner).toContain(
    "https://***@creds.test/wp  [ssh: ubuntu@creds.test]",
  );
  expect(banner).toContain("(not a valid http(s) URL)  [ssh: ubuntu@bad]");
  for (const secret of ["pw-0001", "ss-word9", "k=v"])
    expect(banner).not.toContain(secret);
});

test.describe("renderPluginDirWarning", () => {
  const sites = (leftovers: readonly string[][]) =>
    leftovers.map((dirs, i) => ({
      baseURL: `https://site${String(i)}.test`,
      transport: `ssh: ubuntu@site${String(i)}.test`,
      leftovers: dirs,
    }));

  test("says nothing when no site holds a leftover folder", () => {
    expect(renderPluginDirWarning(sites([[], []]))).toBeUndefined();
    expect(renderPluginDirWarning([])).toBeUndefined();
  });

  test("names only the affected sites, each folder, the cause and what happens next", () => {
    const banner = (
      renderPluginDirWarning(sites([[], ["/p/backwpup-pro: a folder …"]])) ?? ""
    ).replace(ANSI, "");
    expect(banner).toContain("LEFTOVER PLUGIN FOLDERS");
    expect(banner).toContain("on 1 site(s)");
    expect(banner).not.toContain("site0.test");
    expect(banner).toContain("https://site1.test  [ssh: ubuntu@site1.test]");
    expect(banner).toContain("• /p/backwpup-pro: a folder …");
    expect(banner).toContain("PHP-FPM restart, a reboot");
    expect(banner).toContain(
      "The next @plugin scenario on the site removes it",
    );
    // Padded like the elevation banner, so it cannot be lost in packed output.
    expect(banner.startsWith("\n")).toBe(true);
    expect(banner.endsWith("\n")).toBe(true);
  });

  test("is plain by default, styled and spelt by the palette it is given", () => {
    const leftovers = sites([["/p/backwpup-pro: a folder"]]);
    const raw = renderPluginDirWarning(leftovers) ?? "";
    expect(raw).not.toContain(ESC);
    expect(raw.split("\n")[1]).toBe(
      "  ⚠  LEFTOVER PLUGIN FOLDERS — WordPress lists no plugin in them, on 1 site(s)",
    );
    const coloured = renderPluginDirWarning(leftovers, COLOUR) ?? "";
    expect(coloured.split("\n")[1]).toBe(
      `${ESC}[1m${ESC}[33m  ⚠  LEFTOVER PLUGIN FOLDERS — WordPress lists no plugin in them, on 1 site(s)${ESC}[39m${ESC}[22m`,
    );
    const ascii = renderPluginDirWarning(leftovers, ASCII) ?? "";
    expect(ascii).toMatch(/^[\x20-\x7e\n]*$/);
    expect(ascii).toContain("       * /p/backwpup-pro: a folder");
    expect(ascii).toContain(
      "A removal stopped part-way - a PHP-FPM restart, a reboot - leaves",
    );
  });

  test("masks credentials in a site's address", () => {
    const banner = renderPluginDirWarning([
      {
        baseURL: "https://user:secret@site.test",
        transport: "local",
        leftovers: ["x"],
      },
    ]);
    expect(banner).not.toContain("secret");
  });
});

/** What a sites file or a site may hold: a screen clear, an OSC 52 clipboard write, a token. */
test.describe("site values are printed safe", () => {
  const BEL = String.fromCharCode(7);
  const TOKEN = "ghp_16CharsOrMoreAAAA";

  test("the elevation banner: an address and a transport with escapes or a token", () => {
    const raw =
      renderElevationWarning([
        {
          baseURL: `https://site.test/${ESC}[2J`,
          transport: `ssh: ${TOKEN}@site.test${ESC}]52;c;eA==${BEL}`,
          support: "unavailable",
          ownershipPending: false,
        },
      ]) ?? "";
    expect(raw.split("\n")[3]).toBe(
      "     https://site.test/  [ssh: ***@site.test]",
    );
    expect(raw).not.toContain(ESC);
    expect(raw).not.toContain(TOKEN);
  });

  test("the leftover-folder banner: a folder's text line by line, its further lines indented", () => {
    const raw =
      renderPluginDirWarning([
        {
          baseURL: "https://site.test",
          transport: `local: /var/${ESC}[2Jwww`,
          leftovers: [
            `/p/x${ESC}[2J: ${TOKEN.slice(0, 6)}\u200b${TOKEN.slice(6)}\n  owned by root`,
          ],
        },
      ]) ?? "";
    expect(raw.split("\n").slice(3, 6)).toEqual([
      "     https://site.test  [local: /var/www]",
      "       • /p/x: ***",
      "           owned by root",
    ]);
  });
});

/**
 * The site identity banner: silent without an issue, each affected site once (one install checked by
 * two products' cells), each issue with its fix, site values made safe to print.
 */
test.describe("renderIdentityWarning", () => {
  /** A site with `issues`. */
  const identitySite = (
    host: string,
    issues: SiteIdentityIssues["issues"],
  ): SiteIdentityIssues => ({
    baseURL: `https://${host}`,
    transport: `ssh: ubuntu@${host}`,
    issues,
  });
  const ISSUE = {
    what: "sudo refused to run as the site's identity (x)",
    fix: "add the rule",
  };

  test("silent when no site has an issue, or there are no sites", () => {
    expect(renderIdentityWarning([])).toBeUndefined();
    expect(
      renderIdentityWarning([
        identitySite("a.test", []),
        identitySite("b.test", []),
      ]),
    ).toBeUndefined();
  });

  test("names each affected site once, each issue and its fix, padded with blank lines", () => {
    const banner = renderIdentityWarning([
      identitySite("a.test", [ISSUE]),
      identitySite("a.test", [ISSUE]),
      identitySite("b.test", []),
      identitySite("c.test", [ISSUE, { what: "two\nlines", fix: "f" }]),
    ]);
    expect(banner?.split("\n")).toEqual([
      "",
      "  ⚠  SITE IDENTITY — 2 site(s) need attention",
      "",
      "     https://a.test  [ssh: ubuntu@a.test]",
      "       • sudo refused to run as the site's identity (x)",
      "         → add the rule",
      "     https://c.test  [ssh: ubuntu@c.test]",
      "       • sudo refused to run as the site's identity (x)",
      "         → add the rule",
      "       • two",
      "         lines",
      "         → f",
      "",
      "     None of these fails a site — a fallback runs as the transport's user, handing files",
      '     over as before; the rest run as their "Site identity" check says, which says more.',
      "",
    ]);
  });

  test("one address over two transports is two installs, each listed", () => {
    const banner = renderIdentityWarning([
      identitySite("a.test", [ISSUE]),
      { ...identitySite("a.test", [ISSUE]), transport: "ssh: deploy@a.test" },
    ]);
    expect(banner).toContain("SITE IDENTITY — 2 site(s) need attention");
    expect(banner).toContain("https://a.test  [ssh: ubuntu@a.test]");
    expect(banner).toContain("https://a.test  [ssh: deploy@a.test]");
  });

  test("masks the address, strips escapes from what a host said, and spells ASCII when asked", () => {
    const ascii = createPalette({ tty: false, color: false, unicode: false });
    const banner =
      renderIdentityWarning(
        [
          {
            baseURL: "https://user:pass@d.test/",
            transport: "ssh: ubuntu@d.test",
            issues: [{ what: `PHP runs as evil\u001b[31m`, fix: "fix" }],
          },
        ],
        ascii,
      ) ?? "";
    expect(banner).not.toContain("pass@");
    expect(banner).not.toContain("\u001b");
    expect(banner).toContain("  !  SITE IDENTITY - 1 site(s) need attention");
    expect(banner).toContain("         -> fix");
  });

  test("a colour palette styles the headline and arrows only", () => {
    const colour = createPalette({ tty: true, color: true, unicode: true });
    const banner =
      renderIdentityWarning([identitySite("a.test", [ISSUE])], colour) ?? "";
    expect(banner).toContain("\u001b[");
    expect(banner).toContain("https://a.test  [ssh: ubuntu@a.test]");
  });
});
