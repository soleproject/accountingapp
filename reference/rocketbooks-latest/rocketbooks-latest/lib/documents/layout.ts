/**
 * Client-safe document-layout types + pure helpers shared by all three render
 * surfaces (React preview, Word/Print HTML, jsPDF). No DB / server-only imports
 * here so the canvas (a client component) can use it.
 */

export type DocKind = 'letter' | 'email' | 'text' | 'resolution' | 'deck';

export interface DocBranding {
  orgName: string;
  logoUrl: string | null;
  addressLines: string[];
  phone: string | null;
  email: string | null;
  website: string | null;
  /** e.g. 'LLC', 'C-Corporation' — used in legal headings. */
  entityLabel: string | null;
  /** Default signatory for letters/resolutions (configured in letterhead
   *  settings). Fed to the AI so drafts sign with the right name + title. */
  signatoryName: string | null;
  signatoryTitle: string | null;
  /** Master toggle — when false, no letterhead is rendered on any surface. */
  showLetterhead: boolean;
}

/** Phone · email · website, joined for the line under the org name. */
export function contactLine(b: DocBranding): string {
  return [b.phone, b.email, b.website].filter(Boolean).join('  ·  ');
}

/** Letterhead-bearing kinds — printed documents. Text is an SMS; no letterhead. */
export function usesLetterhead(kind: DocKind): boolean {
  return kind === 'letter' || kind === 'resolution' || kind === 'email';
}

/** Serif (formal print) vs sans. Letters/resolutions read as legal documents. */
export function isSerif(kind: DocKind): boolean {
  return kind === 'letter' || kind === 'resolution';
}
