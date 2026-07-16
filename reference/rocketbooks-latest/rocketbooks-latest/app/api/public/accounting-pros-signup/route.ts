import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { performEnterpriseSignup } from '@/lib/signup/perform-enterprise-signup';
import { sendFirmWelcomeEmail } from '@/lib/email/firm-welcome-email';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const ALLOWED_ORIGINS = new Set<string>([
  'https://rocketbooks.ai',
  'https://www.rocketbooks.ai',
  'https://app.rocketbooks.ai',
  'http://localhost:3000',
]);

const BodySchema = z.object({
  full_name: z.string().trim().min(1, 'Full name is required'),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firm_name: z.string().trim().min(1, 'Firm name is required'),
  // Optional intake field from the marketing form. Accept a number or a
  // numeric string ("10", "10-25" → first number); anything unparseable
  // becomes null and is simply not persisted.
  client_count: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((v) => {
      if (v == null) return null;
      const n = typeof v === 'number' ? v : parseInt(String(v).replace(/[^\d].*$/, ''), 10);
      return Number.isFinite(n) ? n : null;
    }),
});

function corsHeaders(origin: string | null): Record<string, string> {
  const allowed = origin && ALLOWED_ORIGINS.has(origin) ? origin : '';
  if (!allowed) return { Vary: 'Origin' };
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function appUrl(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(req.headers.get('origin')),
  });
}

export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin');
  const cors = corsHeaders(origin);

  // Origin enforcement: reject disallowed origins so the endpoint isn't usable
  // as a generic open signup oracle. A missing Origin (non-browser callers) is
  // allowed; a present-but-unlisted value is rejected.
  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    return NextResponse.json({ ok: false, error: 'Origin not allowed' }, { status: 403, headers: cors });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON' }, { status: 400, headers: cors });
  }

  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        error: 'Invalid input',
        fieldErrors: z.flattenError(parsed.error).fieldErrors,
      },
      { status: 400, headers: cors },
    );
  }
  const { full_name, email, password, firm_name, client_count } = parsed.data;

  const result = await performEnterpriseSignup({
    fullName: full_name,
    email,
    password,
    firmName: firm_name,
    clientCount: client_count,
    source: 'marketing_form',
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: result.status, headers: cors });
  }

  // Fire-and-forget RocketBooks-branded welcome email — sent before the auto
  // sign-in so it goes out even if the immediate sign-in fails. The user set
  // their password on the form, so the email's sign-in link works regardless.
  // Never blocks signup on Resend.
  void sendFirmWelcomeEmail({
    to: email,
    fullName: full_name,
    firmName: firm_name,
    appUrl: appUrl(),
    usage: { userId: result.userId, orgId: result.enterpriseId, actor: 'system', feature: 'firm-welcome-email' },
  }).catch((err) => {
    console.error('firm welcome email failed', err);
  });

  // Establish a session cookie on app.rocketbooks.ai. rocketbooks.ai →
  // app.rocketbooks.ai is same-site under the shared eTLD+1, so the browser
  // accepts the cookie and the subsequent top-level navigation to
  // /enterprise/dashboard sends it. If the cookie is rejected for any reason
  // the user lands at /login and signs in with the password they just chose.
  const supabase = await createClient();
  const { error: signInErr } = await supabase.auth.signInWithPassword({ email, password });
  if (signInErr) {
    return NextResponse.json(
      { ok: true, redirectTo: `${appUrl()}/login?email=${encodeURIComponent(email)}` },
      { status: 200, headers: cors },
    );
  }

  return NextResponse.json(
    { ok: true, redirectTo: `${appUrl()}/enterprise/dashboard` },
    { status: 200, headers: cors },
  );
}
