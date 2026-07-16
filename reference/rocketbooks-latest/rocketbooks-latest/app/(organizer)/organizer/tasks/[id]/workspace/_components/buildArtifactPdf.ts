import { jsPDF } from 'jspdf';
import { type DocBranding, type DocKind, contactLine, isSerif, usesLetterhead } from '@/lib/documents/layout';

/**
 * Render an artifact (title + markdown body) to a real, text-selectable PDF
 * using jsPDF — no html2canvas, so the output is vector text, not a raster
 * image. Letters/resolutions get a serif (Times) face + a branded letterhead
 * (logo + org name + address/contact) so they read like a printed document.
 *
 * Markdown subset handled: # / ## headings, - / * bullets, **bold**, and
 * paragraphs, with word-level wrapping and automatic page breaks. Imported
 * dynamically (only when the PDF view opens) so jsPDF stays out of the bundle.
 */

export interface BuiltPdf {
  blob: Blob;
  /** Page count — lets the caller size the preview iframe to show the whole
   *  document at 100% instead of cramming it into a short scroll box. */
  pages: number;
}

type BlockType = 'h2' | 'h3' | 'p' | 'bullet';
interface Block {
  type: BlockType;
  text: string;
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line === '') continue;
    if (/^#\s+/.test(line)) blocks.push({ type: 'h2', text: line.replace(/^#\s+/, '') });
    else if (/^##\s+/.test(line)) blocks.push({ type: 'h3', text: line.replace(/^##\s+/, '') });
    else if (/^[-*]\s+/.test(line)) blocks.push({ type: 'bullet', text: line.replace(/^[-*]\s+/, '') });
    else blocks.push({ type: 'p', text: line });
  }
  return blocks;
}

interface Run {
  text: string;
  bold: boolean;
}

function toRuns(line: string): Run[] {
  const runs: Run[] = [];
  for (const part of line.split(/(\*\*[^*]+\*\*)/g)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**')) runs.push({ text: part.slice(2, -2), bold: true });
    else runs.push({ text: part, bold: false });
  }
  return runs;
}

/** Fetch the org logo and decode it to a data URL + natural dimensions. Returns
 *  null on any failure (network / CORS / non-image) so the letterhead falls
 *  back to text gracefully. Browser-only (runs when the PDF view is opened). */
async function loadLogo(
  url: string | null,
): Promise<{ dataUrl: string; format: 'PNG' | 'JPEG'; w: number; h: number } | null> {
  if (!url) return null;
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    const format: 'PNG' | 'JPEG' = blob.type.includes('jpeg') || blob.type.includes('jpg') ? 'JPEG' : 'PNG';
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = reject;
      img.src = dataUrl;
    });
    return { dataUrl, format, ...dims };
  } catch {
    return null;
  }
}

export async function buildArtifactPdf(
  kind: DocKind,
  title: string,
  body: string,
  branding: DocBranding,
): Promise<BuiltPdf> {
  const doc = new jsPDF({ unit: 'pt', format: 'letter' }); // 612 × 792 pt
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 56;
  const rightEdge = pageW - margin;
  const centerX = pageW / 2;
  const family = isSerif(kind) ? 'times' : 'helvetica';
  let y = margin;

  const setFont = (bold: boolean, size: number) => {
    doc.setFont(family, bold ? 'bold' : 'normal');
    doc.setFontSize(size);
  };
  const ensure = (lineH: number) => {
    if (y + lineH > pageH - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // Centered single line (used for letterhead + serif titles).
  const centerLine = (text: string, size: number, bold: boolean, color: [number, number, number] = [17, 17, 17]) => {
    setFont(bold, size);
    doc.setTextColor(...color);
    const lineH = size * 1.35;
    for (const ln of doc.splitTextToSize(text, rightEdge - margin)) {
      ensure(lineH);
      doc.text(ln, centerX, y, { align: 'center' });
      y += lineH;
    }
    doc.setTextColor(17, 17, 17);
  };

  // Letterhead (logo + org name + address + contact), centered, with a rule.
  if (usesLetterhead(kind) && branding.showLetterhead) {
    const logo = await loadLogo(branding.logoUrl);
    if (logo) {
      const maxW = 180;
      const maxH = 54;
      const scale = Math.min(maxW / logo.w, maxH / logo.h, 1);
      const w = logo.w * scale;
      const h = logo.h * scale;
      ensure(h + 6);
      try {
        doc.addImage(logo.dataUrl, logo.format, centerX - w / 2, y, w, h);
        y += h + 8;
      } catch {
        /* malformed image — skip, fall through to text */
      }
    }
    if (branding.orgName) centerLine(branding.orgName, kind === 'email' ? 14 : 16, true);
    if (branding.addressLines.length) centerLine(branding.addressLines.join('  ·  '), 9, false, [80, 80, 80]);
    const contact = contactLine(branding);
    if (contact) centerLine(contact, 9, false, [80, 80, 80]);

    const headerHadContent = logo || branding.orgName || branding.addressLines.length || contact;
    if (headerHadContent) {
      y += 6;
      ensure(2);
      doc.setDrawColor(34, 34, 34);
      doc.setLineWidth(kind === 'email' ? 0.5 : 1.2);
      doc.line(margin, y, rightEdge, y);
      y += 18;
    }
  }

  // Title.
  if (title.trim()) {
    if (isSerif(kind)) {
      centerLine(title.trim(), 18, true);
      y += 8;
    } else {
      setFont(true, 16);
      for (const ln of doc.splitTextToSize(title.trim(), rightEdge - margin)) {
        ensure(16 * 1.4);
        doc.text(ln, margin, y);
        y += 16 * 1.4;
      }
      y += 8;
    }
  }

  // Body — wrapped runs with inline bold + bullets.
  const writeBlock = (runs: Run[], size: number, forceBold: boolean, indent: number) => {
    const lineH = size * 1.5;
    const startX = margin + indent;
    let x = startX;
    ensure(lineH);
    const lineStartY = y;
    if (indent > 0) {
      setFont(false, size);
      doc.text('•', margin + 4, lineStartY);
    }
    let firstWordOnLine = true;
    for (const run of runs) {
      setFont(forceBold || run.bold, size);
      const spaceW = doc.getTextWidth(' ');
      for (const word of run.text.split(/\s+/).filter(Boolean)) {
        const w = doc.getTextWidth(word);
        const advance = (firstWordOnLine ? 0 : spaceW) + w;
        if (!firstWordOnLine && x + advance > rightEdge) {
          y += lineH;
          ensure(lineH);
          x = startX;
          firstWordOnLine = true;
        }
        if (!firstWordOnLine) x += spaceW;
        doc.text(word, x, y);
        x += w;
        firstWordOnLine = false;
      }
    }
    y += lineH;
  };

  for (const b of parseBlocks(body)) {
    const size = b.type === 'h2' ? 14 : b.type === 'h3' ? 12 : 11.5;
    const isHeading = b.type === 'h2' || b.type === 'h3';
    if (isHeading) y += 4;
    writeBlock(toRuns(b.text), size, isHeading, b.type === 'bullet' ? 16 : 0);
    y += isHeading ? 2 : 5;
  }

  return { blob: doc.output('blob'), pages: doc.getNumberOfPages() };
}
