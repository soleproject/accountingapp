import { NextRequest } from 'next/server';
import { verifyGhlWebhook } from '@/lib/ghl/webhook';
import { loadConnectionsByLocationId } from '@/lib/ghl/connection';
import { safeSend } from '@/lib/inngest';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

// Inbound GoHighLevel webhook (real-time payment events). Path uses /api/crm/
// because GHL rejects URLs containing "ghl". This route is listed in
// PUBLIC_PATHS (lib/supabase/proxy.ts) so GHL's unauthenticated POST isn't
// redirected to /login — it enforces its own auth via signature verification.
//
// On a verified event we don't trust the payload's contents; we just use the
// locationId to trigger a sync, which re-pulls transactions through the same
// deduped ingest path. So a spoofed/garbage body that somehow passed
// verification still can't inject data.
export async function POST(req: NextRequest) {
  const raw = await req.text();

  if (!verifyGhlWebhook(raw, req.headers)) {
    logger.warn('ghl webhook: signature verification failed');
    return new Response('invalid signature', { status: 401 });
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response('bad json', { status: 400 });
  }

  const locationId =
    (payload.locationId as string | undefined) ?? (payload.location_id as string | undefined);
  const eventType = (payload.type as string | undefined) ?? 'unknown';

  if (!locationId) {
    logger.info({ eventType }, 'ghl webhook: no locationId; acknowledged, nothing to do');
    return new Response('ok', { status: 200 });
  }

  const connections = await loadConnectionsByLocationId(locationId);
  if (connections.length === 0) {
    // Not a location we have connected (or disconnected) — ack so GHL stops retrying.
    logger.info({ locationId, eventType }, 'ghl webhook: no connection for location; acknowledged');
    return new Response('ok', { status: 200 });
  }

  for (const c of connections) {
    await safeSend({
      name: 'ghl/sync.requested',
      data: { connectionId: c.id, trigger: 'webhook' },
    });
  }

  logger.info(
    { locationId, eventType, connections: connections.length },
    'ghl webhook: verified, sync triggered',
  );
  return new Response('ok', { status: 200 });
}
