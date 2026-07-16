import 'server-only';
import { eq } from 'drizzle-orm';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { db } from '@/db/client';
import { signatureRequests, signatureRecipients, signatureFields } from '@/db/schema/schema';
import { downloadSignatureObject, uploadSignatureObject } from '@/lib/storage/signatures';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { signingUrl } from './tokens';
import { recordEvent } from './store';
import { logger } from '@/lib/logger';

const num = (v: unknown) => Number(v ?? 0);

/**
 * Finalize a request once every recipient has signed: stamp all field values
 * and drawn signatures onto the source PDF (pdf-lib), append a 1-page audit
 * certificate, store completed.pdf, flip the request to completed, and email
 * everyone a link back to download it.
 */
export async function completeRequestIfReady(requestId: string): Promise<boolean> {
  const recipients = await db.select().from(signatureRecipients).where(eq(signatureRecipients.requestId, requestId));
  if (recipients.length === 0) return false;
  const allSigned = recipients.every((r) => r.status === 'signed');
  if (!allSigned) return false;

  const [req] = await db.select().from(signatureRequests).where(eq(signatureRequests.id, requestId)).limit(1);
  if (!req || !req.sourcePdfPath) return false;
  if (req.status === 'completed') return true; // idempotent

  const fields = await db.select().from(signatureFields).where(eq(signatureFields.requestId, requestId));

  const srcBytes = await downloadSignatureObject(req.sourcePdfPath);
  const pdf = await PDFDocument.load(srcBytes);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pages = pdf.getPages();

  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const { width: pw, height: ph } = page.getSize();
    const boxW = num(f.w) * pw;
    const boxH = num(f.h) * ph;
    const x = num(f.x) * pw;
    // Our coords are top-based; PDF origin is bottom-left.
    const topY = ph - num(f.y) * ph;
    const bottomY = topY - boxH;

    if ((f.type === 'signature' || f.type === 'initials') && f.signatureImagePath) {
      try {
        const png = await downloadSignatureObject(f.signatureImagePath);
        const img = await pdf.embedPng(png);
        const scale = Math.min(boxW / img.width, boxH / img.height);
        const dw = img.width * scale;
        const dh = img.height * scale;
        page.drawImage(img, { x: x + (boxW - dw) / 2, y: bottomY + (boxH - dh) / 2, width: dw, height: dh });
      } catch (err) {
        logger.warn({ err: err instanceof Error ? err.message : String(err), fieldId: f.id }, 'signature image stamp failed');
      }
    } else if (f.type === 'checkbox') {
      if (f.value && f.value !== 'false') {
        page.drawText('X', { x: x + boxW * 0.2, y: bottomY + boxH * 0.15, size: Math.min(boxH, 14), font: helvBold, color: rgb(0.1, 0.1, 0.1) });
      }
    } else if (f.value) {
      const size = Math.max(8, Math.min(boxH * 0.7, 13));
      page.drawText(f.value.slice(0, 200), { x, y: bottomY + (boxH - size) / 2 + 1, size, font: helv, color: rgb(0.1, 0.1, 0.1) });
    }
  }

  // --- audit certificate page ---
  const audit = pdf.addPage([612, 792]);
  let y = 792 - 64;
  audit.drawText('Certificate of Completion', { x: 64, y, size: 18, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
  y -= 28;
  audit.drawText(`Document: ${req.title || 'Untitled'}`, { x: 64, y, size: 11, font: helv, color: rgb(0.2, 0.2, 0.2) });
  y -= 16;
  audit.drawText(`Request ID: ${req.id}`, { x: 64, y, size: 9, font: helv, color: rgb(0.4, 0.4, 0.4) });
  y -= 28;
  audit.drawText('Signers', { x: 64, y, size: 12, font: helvBold, color: rgb(0.1, 0.1, 0.1) });
  y -= 18;
  for (const r of recipients) {
    const lines = [
      `${r.name || '(no name)'}  <${r.email}>`,
      `Signed: ${r.signedAt ? new Date(r.signedAt).toUTCString() : '—'}   IP: ${r.signedIp ?? '—'}`,
    ];
    for (const ln of lines) {
      if (y < 64) {
        y = 792 - 64;
        pdf.addPage([612, 792]);
      }
      audit.drawText(ln, { x: 72, y, size: 10, font: helv, color: rgb(0.25, 0.25, 0.25) });
      y -= 14;
    }
    y -= 6;
  }

  const outBytes = await pdf.save();
  const completedPath = `${req.organizationId}/${req.id}/completed.pdf`;
  await uploadSignatureObject({ path: completedPath, contentType: 'application/pdf', bytes: outBytes });

  await db
    .update(signatureRequests)
    .set({ status: 'completed', completedAt: new Date().toISOString(), completedPdfPath: completedPath })
    .where(eq(signatureRequests.id, requestId));
  await recordEvent({ requestId, type: 'completed' });

  // Notify all signers (link back to their token page, which serves the download).
  for (const r of recipients) {
    if (!r.email) continue;
    await sendTransactionalEmail({
      to: r.email,
      subject: `Completed: ${req.title || 'Document'} is fully signed`,
      text: `"${req.title || 'Document'}" has been signed by all parties.\n\nDownload the completed document:\n${signingUrl(r.token)}`,
      brandForOrgId: req.organizationId,
      usage: { userId: req.userId ?? null, orgId: req.organizationId, actor: 'system', feature: 'signature-completed' },
    });
  }

  logger.info({ requestId }, 'signature request completed');
  return true;
}
