import { redirect } from 'next/navigation';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { qboConnections } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { revokeConnection } from '@/lib/qbo/client';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST() {
  await requireSession();
  const orgId = await getCurrentOrgId();

  const [connection] = await db
    .select()
    .from(qboConnections)
    .where(eq(qboConnections.orgId, orgId))
    .limit(1);

  if (connection) {
    try {
      await revokeConnection(connection);
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : String(err), orgId }, 'qbo revoke threw — proceeding with local cleanup');
    }
    await db.delete(qboConnections).where(eq(qboConnections.id, connection.id));
    logger.info({ orgId, realmId: connection.realmId }, 'qbo connection disconnected');
  }

  redirect('/integrations/qbo?disconnected=1');
}
