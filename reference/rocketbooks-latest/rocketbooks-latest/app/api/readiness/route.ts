import { getCloudflareContext } from '@opennextjs/cloudflare';
import postgres from 'postgres';

export const dynamic = 'force-dynamic';

type HyperdriveBinding = { connectionString?: string };
type Check = { ok: boolean; name: string; detail?: string };

function envIsSet(name: string): boolean {
  return Boolean(process.env[name] && String(process.env[name]).trim().length > 0);
}

function getHyperdriveUrl(): string | undefined {
  try {
    const { env } = getCloudflareContext();
    return ((env as unknown as Record<string, unknown>).HYPERDRIVE as HyperdriveBinding | undefined)?.connectionString;
  } catch {
    return undefined;
  }
}

async function checkDatabase(): Promise<Check> {
  const url = getHyperdriveUrl() ?? process.env.POSTGRES_URL;
  if (!url) return { ok: false, name: 'database', detail: 'missing POSTGRES_URL/Hyperdrive binding' };

  const sql = postgres(url, {
    prepare: false,
    max: 1,
    connect_timeout: 5,
    idle_timeout: 1,
    max_lifetime: 30,
    connection: { statement_timeout: 5000 },
  });

  try {
    const rows = await sql<{ ok: number }[]>`select 1 as ok`;
    return { ok: rows[0]?.ok === 1, name: 'database' };
  } catch (error) {
    return { ok: false, name: 'database', detail: error instanceof Error ? error.message : 'unknown database error' };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => undefined);
  }
}

function envGroup(name: string, vars: string[], required = false): Check {
  const missing = vars.filter((envName) => !envIsSet(envName));
  return {
    ok: missing.length === 0 || !required,
    name,
    detail: missing.length === 0 ? 'configured' : `missing: ${missing.join(', ')}`,
  };
}

export async function GET() {
  const checks: Check[] = [
    envGroup('supabase-public', ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'], true),
    envGroup('supabase-service', ['SUPABASE_SERVICE_ROLE_KEY'], true),
    await checkDatabase(),
    envGroup('plaid', ['PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV']),
    envGroup('stripe', ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET']),
    envGroup('resend', ['RESEND_API_KEY', 'RESEND_FROM']),
    envGroup('twilio', ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']),
    envGroup('veryfi', ['VERYFI_CLIENT_ID', 'VERYFI_USERNAME', 'VERYFI_API_KEY']),
    envGroup('deepgram', ['DEEPGRAM_API_KEY']),
    envGroup('openai', ['OPENAI_API_KEY']),
  ];

  const ok = checks.every((check) => check.ok);
  return Response.json(
    {
      ok,
      service: 'rocketsuite',
      timestamp: new Date().toISOString(),
      checks,
    },
    {
      status: ok ? 200 : 503,
      headers: { 'Cache-Control': 'no-store' },
    },
  );
}
