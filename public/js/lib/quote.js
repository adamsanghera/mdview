/**
 * Finds `quote` in `text`, treating any run of whitespace as one space, so a
 * reflowed paragraph still matches. Picks the occurrence nearest `hint`.
 * Returns [start, end) offsets into `text`, or null.
 */
export function findQuote(text, quote, hint) {
  const needle = quote.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  let flat = "";
  const from = [];
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]);
    if (space && flat.endsWith(" ")) continue;
    flat += space ? " " : text[i];
    from.push(i);
  }
  let best = null;
  for (let at = flat.indexOf(needle); at !== -1; at = flat.indexOf(needle, at + 1)) {
    const span = [from[at], from[at + needle.length - 1] + 1];
    if (!best || Math.abs(span[0] - hint) < Math.abs(best[0] - hint)) best = span;
  }
  return best;
}
