/**
 * Every key and session shape hoppy's hide() takes out (see it in hoppy.ts for the two rules).
 * Global, for String.replace; a test that only tests for a match builds its own RegExp from source.
 */
export const KEY_SHAPES = /(?:(?<![A-Za-z0-9])|(?<=\x1b\[[0-9;]*[A-Za-z]))(?:ak|ses)_[A-Za-z0-9_-]{4,}|ak_[0-9a-f]{48}|ses_[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]/g;

/**
 * A JSON value with hide() run over every string in it, field names included, at any depth.
 * Returns a plain JSON value (what JSON.stringify would keep), safe to serialize as many times as
 * needed: each copy says the same and none holds what hide() takes out.
 *
 * Hiding has to happen on the value, never on its JSON text: once serialized, a newline before a
 * key is the letters \n, so the key no longer starts a word hide() can find.
 */
export function hiddenValue(value: unknown, hide: (text: string) => string): unknown {
  // Through JSON first, so what is hidden is exactly what will be written: toJSON, dropped
  // undefined fields and the like are settled before any name or string is looked at.
  const text = JSON.stringify(value);
  return text === undefined ? null : walk(JSON.parse(text), hide);
}

function walk(v: unknown, hide: (text: string) => string): unknown {
  if (typeof v === 'string') return hide(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, hide));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [hide(k), walk(x, hide)]));
  return v;
}
