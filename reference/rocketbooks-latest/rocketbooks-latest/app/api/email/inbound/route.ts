import { NextRequest, NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { verifyOutreachToken } from '@/lib/email/inbound-token';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
// Processing a contact-inquiry reply can categorize + back-propagate to sibling
// transactions (2 AI calls + a bounded batch of posts), so allow more headroom.
export const maxDuration = 60;

/**
 * Inbound email webhook. The email provider (e.g. Resend Inbound) POSTs each
 * received message as JSON. Replies to firm outreach arrive at
 * reply+<token>@<INBOUND_DOMAIN>; we decode the token to the originating
 * outreach row and store the reply so the firm sees it in-app.
 *
 * Auth: ?key=<INBOUND_WEBHOOK_SECRET> — configure the same secret in the
 * provider's webhook URL. Without it, anyone could inject fake replies.
 */
export async function POST(req: NextRequest) {
  const secret = process.env.INBOUND_WEBHOOK_SECRET;
  if (!secret || req.nextUrl.searchParams.get('key') !== secret) {
    return new NextResponse('forbidden', { status: 403 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = (await req.json()) as Record<string, unknown>;
  } catch {
    return new NextResponse('bad request', { status: 400 });
  }

  // Tolerate provider shape variance: some nest under `data`.
  const data = (payload.data as Record<string, unknown>) ?? payload;
  const toRaw = data.to ?? data.recipient ?? data.envelope_to;
  const recipients: string[] = Array.isArray(toRaw)
    ? toRaw.map((t) => (typeof t === 'string' ? t : ((t as { email?: string })?.email ?? '')))
    : typeof toRaw === 'string'
      ? [toRaw]
      : [];

  // Find the reply+<token>@… recipient and decode it.
  let outreachId: string | null = null;
  const raw = JSON.stringify(payload);
  for (const addr of recipients) {
    const m = addr.match(/reply\+([^@\s"]+)@/i);
    if (m) {
      outreachId = verifyOutreachToken(m[1]);
      if (outreachId) break;
    }
  }
  // Fallback: provider payload shapes vary — scan the whole body for the token.
  if (!outreachId) {
    const g = raw.match(/reply\+([A-Za-z0-9.\-]+)@/i);
    if (g) outreachId = verifyOutreachToken(g[1]);
  }

  // Denormalize enterprise/org from the originating outreach row when matched.
  let enterpriseId: string | null = null;
  let organizationId: string | null = null;
  if (outreachId) {
    const [row] = await db.execute(
      sql`select enterprise_id, organization_id from ai_client_outreach where id = ${outreachId} limit 1`,
    );
    enterpriseId = (row as { enterprise_id?: string } | undefined)?.enterprise_id ?? null;
    organizationId = (row as { organization_id?: string } | undefined)?.organization_id ?? null;
  }

  const fromVal = data.from;
  const fromEmail =
    typeof fromVal === 'string'
      ? fromVal
      : ((fromVal as { email?: string; address?: string })?.email ?? (fromVal as { address?: string })?.address ?? null);
  const subject = (data.subject as string) ?? null;
  let body: string | null =
    (data.text as string) ?? (data.html as string) ?? (data.body as string) ?? (data.TextBody as string) ?? null;

  // Resend's inbound webhook is metadata-only (no body). Fetch the content by
  // id with a read-capable key when one is configured (best-effort).
  const emailId = (data.email_id as string) ?? (data.id as string) ?? null;
  const readKey = process.env.RESEND_READ_API_KEY;
  if (!body && emailId && readKey) {
    try {
      const r = await fetch(`https://api.resend.com/emails/inbound/${emailId}`, {
        headers: { Authorization: `Bearer ${readKey}` },
      });
      if (r.ok) {
        const full = (await r.json()) as { text?: string; html?: string };
        body = full.text ?? full.html ?? null;
      }
    } catch {
      /* best effort — keep the row even if content fetch fails */
    }
  }

  // Always capture — even on a token mismatch — so replies are never lost and
  // the raw payload is available to inspect.
  await db.execute(sql`
    insert into email_inbound (id, outreach_id, enterprise_id, organization_id, from_email, to_email, subject, body, raw, received_at)
    values (${randomUUID()}, ${outreachId}, ${enterpriseId}, ${organizationId}, ${fromEmail}, ${recipients[0] ?? null}, ${subject}, ${body}, ${raw}::jsonb, now())
  `);

  logger.info({ outreachId, matched: !!outreachId }, 'email inbound — stored');

  // If this reply answers a "what's this?" contact inquiry, apply it: the LLM
  // maps the reply → category + contact, categorizes the txns, optionally makes
  // a rule. Best-effort — never fail the webhook over it.
  if (outreachId && body) {
    try {
      const [o] = await db.execute(
        sql`select issue_type from ai_client_outreach where id = ${outreachId} limit 1`,
      );
      const issueType = (o as { issue_type?: string } | undefined)?.issue_type;
      if (issueType === 'contact_inquiry') {
        const { processContactInquiryReply } = await import('@/lib/accounting/contact-inquiry-reply');
        const res = await processContactInquiryReply(outreachId, body);
        logger.info({ outreachId, ...res }, 'email inbound — contact inquiry processed');
      } else if (issueType === 'substantiation_request') {
        const { processSubstantiationReply } = await import('@/lib/accounting/substantiation-reply');
        const res = await processSubstantiationReply(outreachId, body);
        logger.info({ outreachId, ...res }, 'email inbound — substantiation reply processed');
      } else if (issueType === 'w9_request') {
        const { processW9Reply } = await import('@/lib/accounting/w9-reply');
        const res = await processW9Reply(outreachId, body);
        logger.info({ outreachId, ...res }, 'email inbound — w9 reply processed');
      }
    } catch (e) {
      logger.error({ outreachId, err: e instanceof Error ? e.message : String(e) }, 'email inbound — reply processing failed');
    }
  }

  return NextResponse.json({ ok: true, matched: !!outreachId });
}
