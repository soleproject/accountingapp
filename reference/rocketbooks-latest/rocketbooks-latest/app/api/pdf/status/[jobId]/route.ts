import { sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';

export const dynamic = 'force-dynamic';

type RouteParams = { params: Promise<{ jobId: string }> };

export async function GET(_req: Request, { params }: RouteParams) {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const { jobId } = await params;

  const result = await db.execute(sql`
    SELECT id, document_record_id, status, pdf_url, error_message, created_at, updated_at
    FROM pdf_jobs
    WHERE id = ${jobId} AND organization_id = ${orgId}
    LIMIT 1
  `);
  const rows = result as unknown as Array<Record<string, unknown>>;
  const row = rows[0];
  if (!row) return Response.json({ error: 'job_not_found' }, { status: 404 });

  return Response.json({ job: row });
}
