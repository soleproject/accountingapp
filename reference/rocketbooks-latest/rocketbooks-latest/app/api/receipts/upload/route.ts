import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { validateReceiptFile } from '@/lib/receipts/validate-upload';
import { processReceiptUpload, VeryfiError } from '@/lib/receipts/process-upload';
import { DemoQuotaExceededError } from '@/lib/billing/demo-limits';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const maxDuration = 90;

export async function POST(req: NextRequest) {
  await requireSession();
  const orgId = await getCurrentOrgId();

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 });
  }
  const validation = validateReceiptFile(form.get('file'));
  if (!('ok' in validation)) return NextResponse.json({ error: validation.message }, { status: validation.status });

  try {
    const result = await processReceiptUpload(orgId, validation.file);
    return NextResponse.json({
      receiptId: result.id,
      vendorName: result.vendorName,
      total: result.total,
      date: result.date,
      lineCount: result.lineCount,
    });
  } catch (err) {
    if (err instanceof DemoQuotaExceededError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 403 });
    }
    const isVeryfi = err instanceof VeryfiError;
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'veryfi receipt processing failed',
    );
    return NextResponse.json(
      { error: isVeryfi ? 'Receipt could not be processed. Please try a clearer scan.' : 'Receipt processing failed' },
      { status: 502 },
    );
  }
}
