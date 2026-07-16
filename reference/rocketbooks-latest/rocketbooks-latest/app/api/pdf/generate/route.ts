import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { documentRecords } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { safeSend } from '@/lib/inngest';

export const dynamic = 'force-dynamic';

const Body = z.object({ documentRecordId: z.string().min(1) });

export async function POST(req: Request) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const parsed = Body.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: 'invalid_body' }, { status: 400 });

  const [doc] = await db
    .select({ id: documentRecords.id, organizationId: documentRecords.organizationId })
    .from(documentRecords)
    .where(eq(documentRecords.id, parsed.data.documentRecordId))
    .limit(1);

  if (!doc || (doc.organizationId && doc.organizationId !== orgId)) {
    return Response.json({ error: 'document_not_found' }, { status: 404 });
  }

  const jobId = randomUUID();
  await db.execute(sql`
    INSERT INTO pdf_jobs (id, document_record_id, organization_id, status, created_at, updated_at)
    VALUES (${jobId}, ${parsed.data.documentRecordId}, ${orgId}, 'queued', now(), now())
  `);

  const queued = await safeSend({
    name: 'pdf/generate.requested',
    data: { jobId, documentRecordId: parsed.data.documentRecordId, organizationId: orgId },
  });

  if (!queued) {
    await db.execute(sql`UPDATE pdf_jobs SET status = 'failed', error_message = 'Inngest queue unavailable', updated_at = now() WHERE id = ${jobId}`);
    return Response.json({ jobId, queued: false, status: 'queue_unavailable' }, { status: 503 });
  }

  return Response.json({ jobId, queued: true, status: 'queued' }, { status: 202 });
}
