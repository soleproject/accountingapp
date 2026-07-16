/**
 * Build a normalized "match key" from a contact name. Used at every contact-
 * matching site (Plaid promote, Veryfi promote, manual categorize action,
 * AI extracted_name comparison, dedupe script) so two names that humans
 * would consider "the same vendor" collapse to the same key:
 *
 *   "GitHub"          → "github"
 *   "GitHub, Inc."    → "github"
 *   "GITHUB  "        → "github"
 *   "Apple Inc"       → "apple"
 *   "Apple Computer"  → "apple computer"   (kept distinct — not a suffix-only diff)
 *   "Capital One, NA" → "capital one"
 *   "AT&T Inc"        → "at&t"
 *
 * The original (un-normalized) form is what gets stored in
 * contacts.contact_name; this helper is only used for *comparison*.
 *
 * Conservative-by-design: strips only well-defined corporate suffixes (Inc,
 * LLC, Co, Ltd, Corp, Corporation, Limited, NA) plus surrounding punctuation.
 * Does NOT lemmatize or stem — "Apple" vs "Apples" stays distinct.
 */
export function normalizeContactNameForMatch(name: string | null | undefined): string {
  if (!name) return '';
  let s = name.toLowerCase().trim();
  // collapse internal whitespace
  s = s.replace(/\s+/g, ' ');
  // strip trailing corp suffixes, possibly comma-separated, possibly with
  // trailing punctuation. Repeat to handle "Foo Inc., LLC" type cases.
  // Anchored at end-of-string; case is already lowered.
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/[\s,.]+$/g, '');
    s = s.replace(
      /\s*,?\s*\b(incorporated|corporation|limited|inc|llc|l\.l\.c\.|co|ltd|corp|n\.a\.|na|plc|gmbh|s\.a\.|s\.a|sa|s\.r\.l\.?|srl)\.?$/,
      '',
    );
    s = s.replace(/[\s,.]+$/g, '');
    if (s === before) break;
  }
  return s.trim();
}
