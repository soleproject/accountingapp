import { NextRequest, NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { verifyDigestUnsubToken } from '@/lib/digest/unsubscribe-token';
import { logger } from '@/lib/logger';

/**
 * Public, login-free unsubscribe for the weekly digest. Auth is the HMAC-signed
 * token (verified here); listed in proxy.ts PUBLIC_PATHS. Clears the user's
 * opt-in. Idempotent.
 */
function page(message: string): NextResponse {
  const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>RocketBooks</title></head><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:480px;margin:64px auto;padding:0 20px;text-align:center;color:#18181b"><h2 style="font-size:18px">RocketBooks</h2><p style="color:#52525b">${message}</p></body></html>`;
  return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export async function GET(req: NextRequest) {
  const token = req.nextUrl.searchParams.get('token') ?? '';
  const userId = verifyDigestUnsubToken(token);
  if (!userId) {
    return page('This unsubscribe link is invalid or has expired. You can manage the weekly digest from Settings.');
  }
  try {
    await db.update(users).set({ weeklyDigestOptInAt: null }).where(eq(users.id, userId));
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : String(err) }, 'digest unsubscribe failed');
    return page('Something went wrong unsubscribing. Please turn the weekly digest off in Settings instead.');
  }
  return page("You've been unsubscribed from the weekly digest. You can re-enable it anytime in Settings.");
}
