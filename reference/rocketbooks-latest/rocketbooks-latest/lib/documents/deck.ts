/**
 * Deck (slideshow) model + parser, shared by the slide preview and the .pptx
 * exporter. Client-safe (no server imports).
 *
 * Authoring convention (the AI emits this as the artifact `body`):
 *   # Slide title
 *   - bullet
 *   - bullet
 *   > speaker note line(s)
 *   img: image generation prompt
 *   imgsrc: https://…  <- persisted URL once "Generate images" has run
 *   ---            <- separates slides
 *   # Next slide
 *   ...
 */

export interface Slide {
  title: string;
  bullets: string[];
  notes: string;
  /** Optional image-generation prompt for this slide (an `img:` line). */
  imagePrompt?: string;
  /** Persisted public URL of the generated image (an `imgsrc:` line), written
   *  back into the body after generation so it survives reload. */
  imageUrl?: string;
}

export function parseDeck(body: string): Slide[] {
  const chunks = body
    .replace(/\r\n/g, '\n')
    .split(/^\s*---\s*$/m)
    .map((c) => c.trim())
    .filter(Boolean);

  const slides: Slide[] = [];
  for (const chunk of chunks) {
    let title = '';
    let imagePrompt = '';
    let imageUrl = '';
    const bullets: string[] = [];
    const noteLines: string[] = [];
    for (const raw of chunk.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (/^imgsrc:\s*/i.test(line)) {
        if (!imageUrl) imageUrl = line.replace(/^imgsrc:\s*/i, '').trim();
      } else if (/^img:\s*/i.test(line)) {
        if (!imagePrompt) imagePrompt = line.replace(/^img:\s*/i, '').trim();
      } else if (/^#{1,3}\s+/.test(line)) {
        if (!title) title = line.replace(/^#{1,3}\s+/, '');
      } else if (/^[-*]\s+/.test(line)) {
        bullets.push(line.replace(/^[-*]\s+/, '').replace(/\*\*/g, ''));
      } else if (/^>\s?/.test(line)) {
        noteLines.push(line.replace(/^>\s?/, ''));
      } else if (!title) {
        // First plain line with no heading marker becomes the title.
        title = line.replace(/\*\*/g, '');
      } else {
        // Stray prose under a titled slide → treat as a bullet so it isn't lost.
        bullets.push(line.replace(/\*\*/g, ''));
      }
    }
    if (title || bullets.length || noteLines.length || imagePrompt) {
      slides.push({
        title: title || 'Untitled slide',
        bullets,
        notes: noteLines.join('\n'),
        imagePrompt: imagePrompt || undefined,
        imageUrl: imageUrl || undefined,
      });
    }
  }
  return slides;
}

/**
 * Write generated image URLs back into the deck body as `imgsrc:` lines (one
 * per slide, keyed by the slide's `img:` prompt) so they persist via autosave.
 * Adds the line right after the slide's `img:` line, or replaces an existing
 * `imgsrc:`. Slides without a matching url in the map are left untouched.
 */
export function withImageUrls(body: string, urlByPrompt: Record<string, string>): string {
  const parts = body.replace(/\r\n/g, '\n').split(/^(\s*---\s*)$/m); // keep separators
  return parts
    .map((part) => {
      if (/^\s*---\s*$/.test(part)) return part; // a separator, leave as-is
      const promptLine = part.split('\n').find((l) => /^img:\s*/i.test(l.trim()));
      if (!promptLine) return part;
      const prompt = promptLine.trim().replace(/^img:\s*/i, '').trim();
      const url = urlByPrompt[prompt];
      if (!url) return part;
      const lines = part.split('\n').filter((l) => !/^\s*imgsrc:\s*/i.test(l)); // drop old
      const idx = lines.findIndex((l) => /^img:\s*/i.test(l.trim()));
      lines.splice(idx + 1, 0, `imgsrc: ${url}`);
      return lines.join('\n');
    })
    .join('');
}

export interface DeckTheme {
  key: string;
  label: string;
  /** Hex without leading '#': [background, title, body text, accent bar]. */
  bg: string;
  title: string;
  text: string;
  accent: string;
}

export const DECK_THEMES: DeckTheme[] = [
  { key: 'classic', label: 'Classic', bg: 'FFFFFF', title: '1E1B4B', text: '27272A', accent: '4F46E5' },
  { key: 'midnight', label: 'Midnight', bg: '0F172A', title: 'FFFFFF', text: 'E2E8F0', accent: '818CF8' },
  { key: 'sunrise', label: 'Sunrise', bg: 'FFF7ED', title: '9A3412', text: '27272A', accent: 'EA580C' },
];

export function getTheme(key: string): DeckTheme {
  return DECK_THEMES.find((t) => t.key === key) ?? DECK_THEMES[0];
}

/** '#'-prefixed for CSS use in the preview. */
export const hash = (hex: string) => `#${hex}`;
