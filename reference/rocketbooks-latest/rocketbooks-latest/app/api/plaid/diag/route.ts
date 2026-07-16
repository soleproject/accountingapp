import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';

export async function GET() {
  await requireSession();
  return NextResponse.json({
    PLAID_ENV: process.env.PLAID_ENV ?? '(unset, defaults to sandbox)',
    PLAID_CLIENT_ID_set: !!process.env.PLAID_CLIENT_ID,
    PLAID_SECRET_set: !!process.env.PLAID_SECRET,
    PLAID_WEBHOOK_URL: process.env.PLAID_WEBHOOK_URL ?? '(unset)',
    PLAID_ENCRYPTION_KEY_set: !!process.env.PLAID_ENCRYPTION_KEY,
    INNGEST_EVENT_KEY_set: !!process.env.INNGEST_EVENT_KEY,
    INNGEST_SIGNING_KEY_set: !!process.env.INNGEST_SIGNING_KEY,
    OPENAI_API_KEY_set: !!process.env.OPENAI_API_KEY,
    VERYFI_CLIENT_ID_set: !!process.env.VERYFI_CLIENT_ID,
    VERYFI_API_KEY_set: !!process.env.VERYFI_API_KEY,
  });
}
