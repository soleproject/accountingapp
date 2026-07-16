import 'server-only';
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';

// US-Letter, 1-inch margins.
const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 72;
const CONTENT_W = PAGE_W - MARGIN * 2;

interface Line {
  text: string;
  size: number;
  bold: boolean;
  gapAfter: number;
  indent: number;
}

/** Strip the tiny markdown subset the app emits down to plain runs. */
function stripInline(s: string): string {
  return s.replace(/\*\*(.+?)\*\*/g, '$1');
}

function wrap(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const next = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) > maxWidth && cur) {
      lines.push(cur);
      cur = word;
    } else {
      cur = next;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/**
 * Render a created document (title + small-markdown body) to a clean, readable
 * PDF for signing. Not a pixel-perfect letterhead render — v1 freezes the
 * content into a flat, immutable document signers can read and sign. Uploaded
 * PDFs skip this entirely and are used as-is.
 */
export async function renderTextPdf(title: string, body: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  // Build a flat list of laid-out lines from the markdown-ish body.
  const out: Line[] = [];
  if (title.trim()) out.push({ text: stripInline(title.trim()), size: 18, bold: true, gapAfter: 14, indent: 0 });

  for (const raw of body.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    if (/^#\s+/.test(line)) {
      for (const w of wrap(stripInline(line.replace(/^#\s+/, '')), bold, 14, CONTENT_W)) out.push({ text: w, size: 14, bold: true, gapAfter: 4, indent: 0 });
    } else if (/^##\s+/.test(line)) {
      for (const w of wrap(stripInline(line.replace(/^##\s+/, '')), bold, 12, CONTENT_W)) out.push({ text: w, size: 12, bold: true, gapAfter: 3, indent: 0 });
    } else if (/^[-*]\s+/.test(line)) {
      const items = wrap(stripInline(line.replace(/^[-*]\s+/, '')), font, 11, CONTENT_W - 16);
      items.forEach((w, i) => out.push({ text: i === 0 ? `•  ${w}` : `   ${w}`, size: 11, bold: false, gapAfter: i === items.length - 1 ? 4 : 1, indent: 16 }));
    } else if (line.trim() === '') {
      out.push({ text: '', size: 11, bold: false, gapAfter: 6, indent: 0 });
    } else {
      const items = wrap(stripInline(line), font, 11, CONTENT_W);
      items.forEach((w, i) => out.push({ text: w, size: 11, bold: false, gapAfter: i === items.length - 1 ? 6 : 1, indent: 0 }));
    }
  }

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;
  for (const ln of out) {
    const lineHeight = ln.size * 1.3;
    if (y - lineHeight < MARGIN) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
    }
    if (ln.text) {
      page.drawText(ln.text, {
        x: MARGIN + ln.indent,
        y: y - ln.size,
        size: ln.size,
        font: ln.bold ? bold : font,
        color: rgb(0.1, 0.1, 0.1),
      });
    }
    y -= lineHeight + ln.gapAfter;
  }

  return pdf.save();
}
