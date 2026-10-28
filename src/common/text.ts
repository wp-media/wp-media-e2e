import { stripVTControlCharacters } from "node:util";

/** Small, pure string helpers shared across the suite: escaping, masking credentials, plain text. */

/**
 * `value` with every regular-expression metacharacter escaped, for safe interpolation into a
 * `RegExp` source — the same character set Playwright escapes in its own `--project` filter.
 *
 * @example
 * ```ts
 * new RegExp(`^${escapeRegExp("a.b")}$`).test("axb"); // false
 * ```
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Each character HTML gives a meaning to, and its entity. */
const HTML_ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/**
 * `value` as HTML text, safe in an element's content and in a quoted attribute alike: every character
 * that could open a tag, an entity or end an attribute becomes its entity.
 *
 * @param value - the text.
 * @example
 * ```ts
 * escapeHtml(`<b title="x">&</b>`); // "&lt;b title=&quot;x&quot;&gt;&amp;&lt;/b&gt;"
 * ```
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char] ?? char);
}

/** What a masked credential is replaced with. */
const MASK = "***";

/** A GitHub token in every issued form: `ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_` and `github_pat_`. */
const GITHUB_TOKEN = /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{10,}/g;

/**
 * Credentials in a URL — `scheme://user:password@`, `scheme://token@` — up to the authority's **last**
 * `@`, as a URL parser reads it: a password holding a bare `@` is masked whole. The scheme is kept.
 * A scheme starts only where a run of scheme characters does (the lookbehind): tried from inside a
 * run too, as `\b` allows after each `.`, a long dotted text costs quadratic time.
 */
const URL_USERINFO = /(?<![a-z\d+.-])([a-z][a-z\d+.-]*:\/\/)[^\s/?#"'<>`]+@/gi;

/**
 * A URL's password that {@link URL_USERINFO} would cut short: one holding `/`, `?`, `#` or `@`
 * (`https://admin:p@ss/word@host`), which a URL parser refuses or splits. It takes a user (no
 * `/ ? # : @` nor space), a `:`, then a password with **no whitespace** that does not read as a port
 * (digits, then the authority's end), up to the **last** `@` before the next space, within 256
 * characters — so it never runs past a word, and each scheme costs a bounded scan. Applied before
 * {@link URL_USERINFO}, which would otherwise mask only up to the password's first `@`. A password
 * holding a space has no shape to tell it from text: a site's `baseURL` is shown through
 * {@link maskSiteUrl} instead, which never prints one.
 */
const URL_LOOSE_PASSWORD =
  /(?<![a-z\d+.-])([a-z][a-z\d+.-]*:\/\/)[^\s/?#:@"'<>`]*:(?!\d*(?:[\s/?#:]|$))[^\s"'<>`]{0,256}?@(?=[^\s@]*(?:[\s"'<>`]|$))/gi;

/** A credential passed as a URL parameter (`?access_token=…`), which git quotes verbatim. */
const URL_CREDENTIAL_PARAM =
  /([?&#;](?:access_token|token|password|passwd|pwd|secret|client_secret|api_?key)=)[^\s&#;"'<>`]+/gi;

/** An HTTP authorization header's credential: `Authorization: Basic …`, `Bearer …`, `token …`. */
const AUTHORIZATION =
  /(\bAuthorization:\s*(?:Basic|Bearer|token)\s+)[A-Za-z0-9._~+/=-]+/gi;

/** A WordPress login cookie's value (`wordpress_logged_in_<hash>=…`, `wordpress_sec_<hash>=…`). */
const WORDPRESS_AUTH_COOKIE =
  /(\bwordpress_(?:logged_in|sec)_[0-9a-f]+=)[^\s;,"'<>`]+/gi;

/**
 * `text` with every credential it may quote masked, by its shape: a GitHub token, a URL's user and
 * password (one a parser would refuse too), a credential URL parameter (`pwd` — WordPress's login form — included), an HTTP
 * `Authorization` header, a WordPress login cookie. A credential with no recognisable shape — a
 * legacy 40-hex token, a password quoted bare — is masked only by its value ({@link maskValues}). The
 * last line of defence before an error reaches a log or a report — a
 * page's URL with basic-auth credentials is quoted by Playwright's navigation errors, a URL parameter
 * by git's — never a substitute for not passing secrets around. Idempotent, so text masked twice on
 * its way through nested handlers is unchanged.
 *
 * Mask before cutting a text short: a cut can split a credential from the `@` or prefix that marks it.
 *
 * @param text - what a tool, a site or a test said.
 * @example
 * ```ts
 * redactSecrets("fatal: unable to access 'https://x-access-token:ghp_abc…@github.com/o/r.git/'");
 * // "fatal: unable to access 'https://***@github.com/o/r.git/'"
 * ```
 */
export function redactSecrets(text: string): string {
  // Only `replace`, which resets a global pattern's `lastIndex`: `test`/`exec` on these shared
  // patterns would make the next call skip the start of its text.
  return text
    .replace(GITHUB_TOKEN, MASK)
    .replace(AUTHORIZATION, `$1${MASK}`)
    .replace(WORDPRESS_AUTH_COOKIE, `$1${MASK}`)
    .replace(URL_LOOSE_PASSWORD, `$1${MASK}@`)
    .replace(URL_USERINFO, `$1${MASK}@`)
    .replace(URL_CREDENTIAL_PARAM, `$1${MASK}`);
}

/** What {@link maskSiteUrl} shows for an address that is not an `http(s)` URL: never its text. */
export const NOT_A_SITE_URL = "(not a valid http(s) URL)";

/**
 * A URL's scheme, its authority (to the first `/` or `\\`, as a parser ends it) and the rest, as
 * written: what {@link maskSiteUrl} shows of an address the parser accepted.
 */
const URL_PARTS = /^([a-z][a-z\d+.-]*:)[\\/]{2}([^\\/]*)(.*)$/is;

/**
 * A site's `baseURL` as safe to show, judged by a URL parser rather than by a shape: an `http(s)` URL
 * keeps its host, port and path **as written** (nothing re-encoded or case-folded, so a secret in them
 * is still masked by its value later), its user and password shown as `***@`, its query and fragment
 * dropped (either may carry a token); anything else — text that does not parse, another scheme — is
 * {@link NOT_A_SITE_URL}, since a sites file may hold anything pasted there (a password with a space
 * included). The same when applied again.
 *
 * @param baseURL - the site's address, as its sites file writes it.
 * @returns the address to show.
 * @example
 * ```ts
 * maskSiteUrl("http://admin:pw@wp.test"); // "http://***@wp.test"
 * maskSiteUrl("https://admin:hunter 2@bad host/"); // "(not a valid http(s) URL)"
 * ```
 */
export function maskSiteUrl(baseURL: string): string {
  if (!URL.canParse(baseURL)) return NOT_A_SITE_URL;
  const url = new URL(baseURL);
  if (url.protocol !== "http:" && url.protocol !== "https:")
    return NOT_A_SITE_URL;
  const credentials =
    url.username !== "" || url.password !== "" ? `${MASK}@` : "";
  const parts = URL_PARTS.exec(baseURL.split(/[?#]/, 1)[0] ?? "");
  // The authority's host is after its last `@`, as the parser reads it.
  const written = parts?.[2]?.split("@").at(-1);
  if (parts === null || written === undefined)
    // Written some other way the parser still takes (`https:host`): shown as it reads it.
    return `${url.protocol}//${credentials}${url.host}${url.pathname}`;
  return `${url.protocol}//${credentials}${written}${parts[3] ?? ""}`;
}

/** The shortest value {@link maskValues} masks: a shorter one would mask ordinary words. */
export const MIN_MASKED_LENGTH = 8;

/**
 * `text` with each of `values` masked wherever it appears verbatim — for a credential no pattern can
 * tell from ordinary text, such as a legacy GitHub token, 40 hex digits like any commit. Blank and
 * short values (under {@link MIN_MASKED_LENGTH} characters) are ignored. Every occurrence of every
 * value is found in `text` as given, then each run of overlapping or touching ones becomes one mask,
 * so the order of `values` never matters: masking one value first would break another that overlaps
 * it (`abcdefgh12` and `12345678zz` in `abcdefgh12345678zz`) and leave that one's rest in clear.
 *
 * @param text - what a tool said.
 * @param values - the secrets the process holds.
 * @example
 * ```ts
 * maskValues("auth failed for 0123…cdef", [process.env.GITHUB_TOKEN]); // "auth failed for ***"
 * ```
 */
export function maskValues(
  text: string,
  values: readonly (string | undefined)[],
): string {
  // `ends[i]`: the furthest end of a value found starting at `i`.
  const ends = new Map<number, number>();
  for (const value of values) {
    const secret = value?.trim() ?? "";
    if (secret.length < MIN_MASKED_LENGTH) continue;
    // From the next character, not past the match: a value can overlap itself (`aaaaaaaaa`).
    for (
      let at = text.indexOf(secret);
      at !== -1;
      at = text.indexOf(secret, at + 1)
    )
      ends.set(at, Math.max(ends.get(at) ?? 0, at + secret.length));
  }
  let masked = "";
  // Where the mask being built ends; -1 before the first.
  let end = -1;
  for (const start of [...ends.keys()].sort((a, b) => a - b)) {
    if (start > end) masked += `${text.slice(Math.max(end, 0), start)}${MASK}`;
    end = Math.max(end, ends.get(start) ?? start);
  }
  return masked + text.slice(Math.max(end, 0));
}

/**
 * Every control character: C0 (newlines and tabs included), DEL, C1, and the line and paragraph
 * separators U+2028/U+2029 — each one breaks or moves a line.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/**
 * Invisible format characters (Unicode `Cf`): the bidirectional overrides that make text display in
 * another order than it is stored (U+202E), zero-width spaces and joiners.
 */
const FORMAT = /\p{Cf}/gu;

/**
 * The most combining marks (Unicode `M`: nonspacing, spacing and enclosing) kept in a row. Real
 * text stays whole: Vietnamese stacks 2; cantillated Hebrew, Burmese syllables and Tibetan stacks
 * 5. "Zalgo" text, whose dozens of stacked marks draw over the lines above and below and cost a
 * renderer per mark, is cut to it.
 */
export const MAX_COMBINING_MARKS = 8;

/** A run of combining marks longer than {@link MAX_COMBINING_MARKS}: its first ones, then the rest. */
const EXCESS_MARKS = new RegExp(
  `(\\p{M}{${String(MAX_COMBINING_MARKS)}})\\p{M}+`,
  "gu",
);

/**
 * `text` with nothing in it that drives a terminal: lone surrogates (half an emoji, cut by a byte
 * limit) made U+FFFD, escape sequences removed, every other control character (a tab, a newline,
 * an `ESC` or C1 left of a sequence Node does not recognise, such as DCS or an unterminated OSC) a
 * space. Nothing else changes (no trim): spacing is kept. The first half of {@link plain}, and what
 * the terminal layout runs on its input.
 *
 * @param text - any text.
 * @example
 * ```ts
 * withoutControls("\u001b[31mred\u001b[0m\tnext"); // "red next"
 * ```
 */
export function withoutControls(text: string): string {
  return stripVTControlCharacters(text.toWellFormed()).replace(CONTROL, " ");
}

/**
 * A value as one line of plain text: {@link withoutControls}, then invisible format characters
 * dropped (the ZWJ of an emoji sequence too, which then shows as its parts), runs of combining marks
 * capped at {@link MAX_COMBINING_MARKS}, and the ends trimmed. What sites, setups and the
 * environment report — Site Health's text, an error, a run's name — is printed and shown in the
 * reports, and none of it may move the cursor, recolour the terminal, break a line, spill over other
 * lines or display as something it is not.
 *
 * @param text - the value.
 * @example
 * ```ts
 * plain("\u001b[31mred\u001b[0m\nnext"); // "red next"
 * ```
 */
export function plain(text: string): string {
  return withoutControls(text)
    .replace(FORMAT, "")
    .replace(EXCESS_MARKS, "$1")
    .trim();
}
