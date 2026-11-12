/**
 * Embedding values in PHP snippets: {@link phpLiteral}, the one way a value from outside this codebase
 * enters a `wp eval` snippet. Free of any import, so a module below `./exec.ts` (which must never load
 * it) can build snippets too; `./php.ts` re-exports it beside `evalPhp`.
 */

/**
 * Whether any string in `value` holds an unpaired UTF-16 surrogate.
 *
 * Such a string survives `JSON.stringify` as a `\uD800`-style escape, and PHP's `json_decode` then
 * rejects the **whole** document and returns `null` — so a snippet built from it would run with an
 * empty value and report nothing wrong. Caught here, where it can still be explained.
 *
 * Given the **decoded** JSON rather than the original value, which matters twice over: a surrogate
 * is a surrogate again there (under the `u` flag a correctly paired one is a single non-surrogate
 * code point and does not match, while a lone one does), and a `toJSON()` method — which
 * `JSON.stringify` honours and a walk of the original object would never see — has already had its
 * say.
 */
function hasLoneSurrogate(value: unknown): boolean {
  if (typeof value === "string") return /\p{Surrogate}/u.test(value);
  if (Array.isArray(value)) return value.some(hasLoneSurrogate);
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).some(
      ([key, nested]) => /\p{Surrogate}/u.test(key) || hasLoneSurrogate(nested),
    );
  }
  return false;
}

/**
 * Embeds a value in a PHP snippet as a literal expression.
 *
 * The value is JSON-encoded and then **base64**-encoded, so what lands in the snippet is drawn from
 * `A-Za-z0-9+/=` — an alphabet containing no PHP metacharacter. Quotes, backslashes, newlines and
 * `$` in the data therefore cannot end the literal or interpolate, whatever it holds. That is why
 * this is safe for values taken from a site rather than written by hand.
 *
 * @param value - anything `JSON.stringify` accepts; objects and arrays keep their shape.
 * @returns a PHP expression evaluating to the value, with objects decoded as associative arrays.
 * @throws {@link Error} if the value cannot be carried faithfully: one with no JSON form
 * (`undefined`, a function, a symbol), one `JSON.stringify` itself rejects (a BigInt, a circular
 * reference), or a string holding an unpaired UTF-16 surrogate — which PHP's `json_decode` rejects,
 * turning the whole literal into `null` without a word. Each would otherwise surface far from here.
 */
export function phpLiteral(value: unknown): string {
  // Held as `unknown` deliberately: TypeScript types `stringify` as returning `string`, while it
  // really returns `undefined` for a value with no JSON form. Taking the result at its declared type
  // would make the guard below provably dead and it would be optimised — and linted — away.
  let json: unknown;
  try {
    json = JSON.stringify(value);
  } catch (cause) {
    // A BigInt or a circular reference. Re-thrown in this function's own terms, because the raw
    // TypeError names neither the caller nor what it was trying to embed.
    throw new Error(
      `[wp/php] a value of type ${typeof value} cannot be embedded in a snippet: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
  if (typeof json !== "string") {
    throw new Error(
      `[wp/php] a value of type ${typeof value} cannot be embedded in a snippet: it has no JSON form.`,
    );
  }
  // Checked on the **decoded JSON**, not on `value`: that is what PHP will receive, so it also sees
  // through a `toJSON()` that produces a surrogate the original object never contained. Wrapped
  // because a deeply nested structure can overflow the stack here even when `JSON.stringify` coped,
  // and a bare RangeError would name neither this function nor the caller.
  let unsafe: boolean;
  try {
    unsafe = hasLoneSurrogate(JSON.parse(json));
  } catch (cause) {
    throw new Error(
      `[wp/php] a value of type ${typeof value} could not be checked before embedding: ` +
        (cause instanceof Error ? cause.message : String(cause)),
      { cause },
    );
  }
  if (unsafe) {
    throw new Error(
      "[wp/php] the value contains an unpaired UTF-16 surrogate, which PHP's json_decode rejects — " +
        "embedding it would silently produce null instead of the value.",
    );
  }
  const encoded = Buffer.from(json, "utf8").toString("base64");
  return `json_decode( base64_decode( '${encoded}' ), true )`;
}
