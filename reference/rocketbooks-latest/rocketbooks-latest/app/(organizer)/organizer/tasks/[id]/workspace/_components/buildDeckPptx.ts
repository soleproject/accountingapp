import pptxgen from 'pptxgenjs';
import { type Slide, type DeckTheme } from '@/lib/documents/deck';

/** Fetch a (persisted) image URL and return it as a base64 data URL so it can
 *  be embedded in the .pptx. Null on failure so the slide just drops the image. */
async function urlToDataUrl(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Build a real .pptx from parsed slides + a theme, as a Blob. 16:9 layout, one
 * slide per Slide: accent bar, title, bullets, speaker notes, and (if present)
 * the slide's persisted image. Imported dynamically (only when the user
 * exports) so pptxgenjs stays out of the bundle.
 */
export async function buildDeckPptx(slides: Slide[], theme: DeckTheme): Promise<Blob> {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_16x9'; // 10 × 5.63 in

  // Resolve all slide images to base64 up front (parallel).
  const imageData = await Promise.all(slides.map((s) => (s.imageUrl ? urlToDataUrl(s.imageUrl) : Promise.resolve(null))));

  slides.forEach((s, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: theme.bg };
    // Accent bar across the top.
    slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: '100%', h: 0.18, fill: { color: theme.accent } });
    slide.addText(s.title, { x: 0.5, y: 0.45, w: 9, h: 0.9, fontSize: 30, bold: true, color: theme.title });

    const img = imageData[i];
    // With an image, bullets take the left half and the image the right half.
    const bulletsW = img ? 4.3 : 8.6;
    if (s.bullets.length > 0) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, breakLine: true } })),
        { x: 0.7, y: 1.6, w: bulletsW, h: 3.6, fontSize: 18, color: theme.text, valign: 'top', lineSpacingMultiple: 1.2 },
      );
    }
    if (img) {
      slide.addImage({ data: img, x: 5.2, y: 1.6, w: 4.3, h: 3.4, sizing: { type: 'contain', w: 4.3, h: 3.4 } });
    }
    if (s.notes.trim()) slide.addNotes(s.notes);
  });

  // In the browser, write() with outputType 'blob' resolves to a Blob.
  return (await pptx.write({ outputType: 'blob' })) as Blob;
}
