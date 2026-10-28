import { test, expect } from "@playwright/test";

import {
  escapeHtml,
  escapeRegExp,
  maskSiteUrl,
  maskValues,
  NOT_A_SITE_URL,
  MAX_COMBINING_MARKS,
  plain,
  redactSecrets,
} from "./text";

/** A string escaped this way must match itself, literally, and nothing else. */
test.describe("escapeRegExp", () => {
  test("every metacharacter matches only itself", () => {
    const special = ".*+?^${}()|[]\\";
    const pattern = new RegExp(`^${escapeRegExp(special)}$`);
    expect(pattern.test(special)).toBe(true);
    expect(pattern.test("x".repeat(special.length))).toBe(false);
  });

  test("leaves ordinary text alone", () => {
    expect(escapeRegExp("pro@nginx_1-a")).toBe("pro@nginx_1-a");
  });
});

/** Escaped text renders as itself: no tag, entity or attribute end survives. */
test.describe("escapeHtml", () => {
  test("turns every HTML-significant character into its entity", () => {
    expect(escapeHtml(`<script>alert("x" & 'y')</script>`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot; &amp; &#39;y&#39;)&lt;/script&gt;",
    );
  });

  test("escapes an entity's own ampersand, so it shows as written", () => {
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });

  test("leaves other text, non-ASCII included, alone", () => {
    expect(escapeHtml("BackWPup Pro 9.99.99 · develop @ af1ab5c")).toBe(
      "BackWPup Pro 9.99.99 · develop @ af1ab5c",
    );
  });
});

/**
 * Every credential a log or report could quote is masked, and nothing else is touched. The shapes are
 * the ones measured: Playwright's navigation errors quote a URL's user and password verbatim, git
 * quotes a URL parameter verbatim (it hides only a URL's user and password itself), and a GitHub token
 * can be pasted anywhere.
 */
test.describe("redactSecrets", () => {
  test("masks a GitHub token in every issued prefix", () => {
    for (const token of [
      "ghp_16CharsOrMoreAAAA",
      "gho_16CharsOrMoreAAAA",
      "ghu_16CharsOrMoreAAAA",
      "ghs_16CharsOrMoreAAAA",
      "ghr_16CharsOrMoreAAAA",
      "github_pat_11ABCDEFG0aBcDeFgHiJkL",
    ]) {
      expect(redactSecrets(`bad credentials for ${token} here`)).toBe(
        "bad credentials for *** here",
      );
    }
  });

  test("masks a URL's user and password, or a lone token, keeping the scheme and host", () => {
    expect(
      redactSecrets(
        "fatal: unable to access 'https://x-access-token:SECRET@github.com/o/r.git/'",
      ),
    ).toBe("fatal: unable to access 'https://***@github.com/o/r.git/'");
    expect(
      redactSecrets(
        "page.goto: net::ERR_UNSAFE_PORT at http://admin:SECRET@127.0.0.1:9/wp-login.php",
      ),
    ).toBe(
      "page.goto: net::ERR_UNSAFE_PORT at http://***@127.0.0.1:9/wp-login.php",
    );
    expect(redactSecrets("ssh://TOKEN@host/x and HTTP://u:p@h")).toBe(
      "ssh://***@host/x and HTTP://***@h",
    );
  });

  test("masks a password holding a bare @ whole, to the authority's last @", () => {
    expect(redactSecrets("at https://user:p@ss@word@site.example/wp")).toBe(
      "at https://***@site.example/wp",
    );
  });

  test("stops at the authority: an @ in a path, query or the next word is not a credential", () => {
    for (const text of [
      "https://site.example/a@b",
      "https://site.example?mail=a@b",
      "https://site.example#a@b",
      "https://site.example and admin@site.example",
      "'https://site.example' <a@b>",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  test("masks a password a URL parser would refuse — with / ? # or @ — to its last @", () => {
    for (const [text, masked] of [
      ["https://admin:pa/ss-word9@host.test/", "https://***@host.test/"],
      ["https://admin:pa?ss-word9@host.test/x", "https://***@host.test/x"],
      ["https://admin:pa#ss-word9@host.test", "https://***@host.test"],
      ["https://admin:p@ss/word@host", "https://***@host"],
      [
        "at https://admin:a-long/loose?password#over16@host.test/ then",
        "at https://***@host.test/ then",
      ],
      ["https://admin:p/w@x@host.test/ then", "https://***@host.test/ then"],
      ["https://:pa/ss@host.test", "https://***@host.test"],
    ] as const)
      expect(redactSecrets(text)).toBe(masked);
  });

  test("never reaches a later @ through a port, a bare colon or a path: emails and paths stay", () => {
    for (const text of [
      "https://site.example:8080/x then mail admin@site.example",
      "https://site.example:8080 admin@site.example",
      "https://site.example:443: user admin@site.example not found",
      "https://site.example: user admin@site.example not found",
      "https://site.example/wp: user admin@site.example",
      "user admin@site.example could not log in to https://site.example",
      "https://a.test:wrong/ logged in as admin@a.test",
      "http://[2001:db8::1]/ user@host",
      "s3://bucket:key/path owner@x",
      "https://github.com:wp-media/x.git by dev@wp-media.me",
      "https://a.test/2024:report written by admin@a.test",
      "https://a.test/files/2024:report@archive.zip",
    ])
      expect(redactSecrets(text)).toBe(text);
  });

  test("a loose password ends at its own last @, never at a later word's", () => {
    expect(
      redactSecrets(
        "https://admin:pa/ss@host.test then mail admin@site.example",
      ),
    ).toBe("https://***@host.test then mail admin@site.example");
    // A space ends a password: one holding a space has no shape (see maskSiteUrl).
    expect(redactSecrets("https://admin:p w@host.test")).toBe(
      "https://admin:p w@host.test",
    );
  });

  test("masks a credential URL parameter to its end, whatever its case or place", () => {
    expect(
      redactSecrets(
        "unable to access 'https://h/r.git?access_token=SECRET/': refused",
      ),
    ).toBe("unable to access 'https://h/r.git?access_token=***': refused");
    expect(
      redactSecrets(
        "https://h/x?a=1&Token=S1&password=S2#api_key=S3;apikey=S4",
      ),
    ).toBe("https://h/x?a=1&Token=***&password=***#api_key=***;apikey=***");
    // A parameter merely ending in a credential's name is not one.
    expect(redactSecrets("https://h/x?csrf_token_id=7&mytoken=8")).toBe(
      "https://h/x?csrf_token_id=7&mytoken=8",
    );
  });

  test("leaves text with no credential untouched", () => {
    for (const text of [
      "Cloning into 'backwpup-pro' from https://github.com/wp-media/backwpup-pro.git",
      "fatal: Authentication failed for 'https://github.com/wp-media/backwpup-pro.git/'",
      "git@github.com:wp-media/backwpup-pro.git",
      "ghp_short",
      "",
    ]) {
      expect(redactSecrets(text)).toBe(text);
    }
  });

  test("is idempotent: text masked twice on its way through is unchanged", () => {
    const once = redactSecrets(
      "https://x-access-token:ghp_16CharsOrMoreAAAA@github.com/o/r.git?token=abc",
    );
    expect(once).toBe("https://***@github.com/o/r.git?token=***");
    expect(redactSecrets(once)).toBe(once);
  });

  test("takes linear time, so a long error cannot stall a reporter", () => {
    // 400,000 characters of `a.`: a scheme tried from inside each dotted run would take tens of
    // seconds (measured: 0.4 s at 40,000, growing with the square).
    const started = performance.now();
    redactSecrets("a.".repeat(200_000));
    redactSecrets(`https://${"a".repeat(400_000)}`);
    redactSecrets("https://a:b ".repeat(40_000));
    redactSecrets(`https://a:${"b".repeat(400_000)}`);
    redactSecrets(`https://a:b${"@".repeat(400_000)}`);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test("masks every match, call after call: its shared patterns keep no state", () => {
    const text = "http://a:b@h1 http://c:d@h2";
    expect(redactSecrets(text)).toBe("http://***@h1 http://***@h2");
    expect(redactSecrets(text)).toBe("http://***@h1 http://***@h2");
  });
});

test.describe("maskSiteUrl", () => {
  test("keeps an http(s) URL as written, a path only when it has one", () => {
    for (const url of [
      "https://bwu2.qa.test",
      "https://bwu2.qa.test/",
      "http://localhost:8100/wp",
      "https://a.qa.test:8443/wp/",
    ])
      expect(maskSiteUrl(url)).toBe(url);
  });

  test("shows a user and password as ***@ and drops a query and a fragment", () => {
    expect(maskSiteUrl("http://admin:SECRETPW@wp.test")).toBe(
      "http://***@wp.test",
    );
    expect(maskSiteUrl("https://token@a.test/wp/?pwd=x#y")).toBe(
      "https://***@a.test/wp/",
    );
    expect(maskSiteUrl("https://a.test?k=v")).toBe("https://a.test");
    // A quote stops every shape; the parser still finds the password.
    expect(maskSiteUrl('https://u:pa"ss-word@a.test/')).toBe(
      "https://***@a.test/",
    );
  });

  test("is the stand-in for anything but an http(s) URL — a password with a space included", () => {
    for (const url of [
      "not a url",
      "https://admin:hunter 22x@bad host/",
      "https://admin:s3cr3tpw@host.test:99999/",
      "foo:admin:s3cr3tpw@host",
      "file:///etc/passwd",
      "ftp://u:p@files.test/",
      "",
    ])
      expect(maskSiteUrl(url), url).toBe(NOT_A_SITE_URL);
  });

  test("is the same when applied again", () => {
    for (const url of [
      "http://admin:pw@wp.test",
      "https://a.test/wp?x=1",
      "bad url",
    ])
      expect(maskSiteUrl(maskSiteUrl(url))).toBe(maskSiteUrl(url));
  });
});

test.describe("plain", () => {
  test("one line: escape sequences gone, control characters and line separators a space", () => {
    expect(
      plain("\u001b[31mred\u001b[0m\nnext\ttab\u0085c1\u2028ls\u2029ps"),
    ).toBe("red next tab c1 ls ps");
  });

  test("drops the invisible format characters that make text display as something else", () => {
    // U+202E shows what follows right to left: "nightly‮gnp.exe" reads as "nightlyexe.png".
    expect(plain("nightly\u202egnp.exe")).toBe("nightlygnp.exe");
    expect(plain("zero\u200bwidth\ufeff")).toBe("zerowidth");
  });

  test("replaces lone surrogates, keeps pairs", () => {
    expect(plain("a\ud83d")).toBe("a\ufffd");
    expect(plain("\ude00b")).toBe("\ufffdb");
    expect(plain("\ud83d\ude00")).toBe("\ud83d\ude00");
    expect(plain("x\ud83d\u001b[31m\ude00").isWellFormed()).toBe(true);
  });

  test("the combining-mark cap is 8", () => {
    expect(MAX_COMBINING_MARKS).toBe(8);
  });

  test("caps each run of combining marks at the cap: Zalgo text", () => {
    const marks = "\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308";
    expect(plain(`e${marks}\u0309`)).toBe(`e${marks}`);
    expect(plain(`e${marks}\u0309a${marks}\u030a`)).toBe(`e${marks}a${marks}`);
    expect(plain(`e${marks.repeat(1000)}`)).toBe(`e${marks}`);
    expect(plain(`e${marks}`)).toBe(`e${marks}`);
    // Spacing (Mc) and enclosing (Me) marks count too; a joiner between marks does not split a run.
    expect(plain(`a${"\u093e".repeat(9)}`)).toBe(`a${"\u093e".repeat(8)}`);
    expect(plain(`a${"\u20dd".repeat(9)}`)).toBe(`a${"\u20dd".repeat(8)}`);
    expect(plain(`e${marks.slice(0, 3)}\u200d${marks.slice(3)}\u0309`)).toBe(
      `e${marks}`,
    );
  });

  /** Real text with its longest runs of marks, which must survive whole. */
  const scripts: readonly (readonly [string, string])[] = [
    ["Vietnamese", "Vi\u1ec7t e\u0323\u0302\u0301"],
    [
      "Burmese \u1019\u103b\u103e\u1031\u102c\u103a (5 marks)",
      "\u1019\u103b\u103e\u1031\u102c\u103a",
    ],
    [
      "Burmese \u101c\u103b\u103e\u1031\u102c\u1037 (5 marks)",
      "\u101c\u103b\u103e\u1031\u102c\u1037",
    ],
    ["cantillated Hebrew (5 marks)", "\u05e9\u05c1\u05bc\u05b8\u05bd\u0591"],
    ["a Tibetan stack (5 marks)", "\u0f67\u0fb9\u0fa8\u0fb3\u0fba\u0fbc"],
    [
      "Devanagari, with a spacing mark",
      "\u0915\u094d\u0937\u093f\u0924\u094d\u0930\u093f\u092f",
    ],
  ];
  for (const [name, text] of scripts) {
    test(`keeps every mark of real text: ${name}`, () => {
      expect(plain(text)).toBe(text);
    });
  }

  test("drops the joiner of an emoji sequence, which then shows as its parts", () => {
    expect(plain("\u{1f468}\u200d\u{1f469}")).toBe("\u{1f468}\u{1f469}");
  });
});

test.describe("redactSecrets — headers, cookies and login forms", () => {
  test("masks an Authorization header's credential, a WordPress login cookie and a pwd parameter", () => {
    expect(redactSecrets("Authorization: Basic dXNlcjpwYXNz")).toBe(
      "Authorization: Basic ***",
    );
    expect(redactSecrets("authorization: Bearer v1.abc-DEF_9")).toBe(
      "authorization: Bearer ***",
    );
    expect(redactSecrets("Authorization: token 0123abcd0123abcd")).toBe(
      "Authorization: token ***",
    );
    expect(
      redactSecrets(
        "cookie wordpress_logged_in_0a1b2c=admin%7C1790000000%7Ctok%7Cmac; path=/",
      ),
    ).toBe("cookie wordpress_logged_in_0a1b2c=***; path=/");
    expect(redactSecrets("POST /wp-login.php?log=admin&pwd=hunter22")).toBe(
      "POST /wp-login.php?log=admin&pwd=***",
    );
  });
});

test.describe("maskValues", () => {
  test("masks each value wherever it appears; blank and short values are left alone", () => {
    expect(
      maskValues("a secret0123 and secret0123 again; short abc", [
        "secret0123",
        "abc",
        "",
        undefined,
        "   ",
      ]),
    ).toBe("a *** and *** again; short abc");
  });

  test("masks overlapping and touching values as one, whatever their order", () => {
    for (const values of [
      ["abcdefgh12", "12345678zz"],
      ["12345678zz", "abcdefgh12"],
    ]) {
      expect(maskValues("<abcdefgh12345678zz>", values)).toBe("<***>");
      expect(maskValues("abcdefgh1212345678zz", values)).toBe("***");
    }
    // A value inside a longer one, either first.
    expect(
      maskValues("a Tr0ub4dor&3-and-more b", [
        "Tr0ub4dor&3",
        "Tr0ub4dor&3-and-more",
      ]),
    ).toBe("a *** b");
    expect(
      maskValues("a Tr0ub4dor&3-and-more b", [
        "Tr0ub4dor&3-and-more",
        "Tr0ub4dor&3",
      ]),
    ).toBe("a *** b");
    // A value overlapping itself.
    expect(maskValues("[aaaaaaaaaaa]", ["aaaaaaaa"])).toBe("[***]");
  });
});
