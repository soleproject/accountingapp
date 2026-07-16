import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeSend } from '@/lib/inngest';

export const dynamic = 'force-dynamic';

export async function POST() {
  const user = await requireSession();
  const orgId = await getCurrentOrgId();

  const [connection] = await db
    .select({ realmId: qboConnections.realmId })
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);

  if (!connection) {
    return Response.json({ error: 'qbo_not_connected' }, { status: 409 });
  }

  const queued = await safeSend({
    name: 'qbo/sync.requested',
    data: { organizationId: orgId, realmId: connection.realmId, userId: user.id },
  });

  return Response.json({ queued, status: queued ? 'queued' : 'queue_unavailable' }, { status: queued ? 202 : 503 });
}
