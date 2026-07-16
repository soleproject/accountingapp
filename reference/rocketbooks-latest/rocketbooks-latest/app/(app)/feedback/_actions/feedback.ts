'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { feedbackReports, feedbackReportComments } from '@/db/schema/feedback';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId, isSuperAdmin } from '@/lib/auth/org';

export type FeedbackKind = 'bug' | 'recommendation';

const VALID_KINDS: readonly FeedbackKind[] = ['bug', 'recommendation'] as const;

export interface SubmitResult {
  ok: boolean;
  error?: string;
  id?: string;
}

export async function submitFeedbackAction(input: {
  kind: FeedbackKind;
  title: string;
  description: string;
  pageUrl?: string;
}): Promise<SubmitResult> {
  const user = await requireSession();
  const kind = input.kind;
  if (!VALID_KINDS.includes(kind)) return { ok: false, error: 'Pick bug or recommendation' };

  const title = input.title.trim();
  const description = input.description.trim();
  if (!title) return { ok: false, error: 'Title is required' };
  if (title.length > 200) return { ok: false, error: 'Title must be 200 characters or fewer' };
  if (!description) return { ok: false, error: 'Description is required' };
  if (description.length > 8000) return { ok: false, error: 'Description must be 8000 characters or fewer' };

  // Best-effort org capture — feedback without a workspace (e.g. a brand-new
  // user) still records, with organization_id left null.
  let orgId: string | null = null;
  try {
    orgId = await getCurrentOrgId();
  } catch {
    orgId = null;
  }

  const id = randomUUID();
  await db.insert(feedbackReports).values({
    id,
    organizationId: orgId,
    reporterUserId: user.id,
    kind,
    title,
    description,
    status: 'open',
    pageUrl: input.pageUrl?.slice(0, 1000) ?? null,
  });

  revalidatePath('/feedback');
  revalidatePath('/super-admin/feedback');
  return { ok: true, id };
}

export interface CommentResult {
  ok: boolean;
  error?: string;
}

export async function addFeedbackCommentAction(formData: FormData): Promise<CommentResult> {
  const user = await requireSession();
  const reportId = String(formData.get('reportId') ?? '');
  const body = String(formData.get('body') ?? '').trim();
  if (!reportId) return { ok: false, error: 'Missing report' };
  if (!body) return { ok: false, error: 'Comment cannot be empty' };
  if (body.length > 8000) return { ok: false, error: 'Comment must be 8000 characters or fewer' };

  // Authorize: must be the reporter, OR a super admin.
  const [report] = await db
    .select({ reporterUserId: feedbackReports.reporterUserId })
    .from(feedbackReports)
    .where(eq(feedbackReports.id, reportId))
    .limit(1);
  if (!report) return { ok: false, error: 'Report not found' };
  const admin = await isSuperAdmin();
  if (report.reporterUserId !== user.id && !admin) return { ok: false, error: 'Not authorized' };

  await db.insert(feedbackReportComments).values({
    id: randomUUID(),
    reportId,
    authorUserId: user.id,
    isAdmin: admin,
    body,
  });

  // Touch the parent row so list sorts by recent activity.
  await db
    .update(feedbackReports)
    .set({ updatedAt: new Date().toISOString() })
    .where(eq(feedbackReports.id, reportId));

  revalidatePath('/feedback');
  revalidatePath(`/feedback/${reportId}`);
  revalidatePath('/super-admin/feedback');
  revalidatePath(`/super-admin/feedback/${reportId}`);
  return { ok: true };
}

const VALID_STATUSES = ['open', 'in_progress', 'resolved', 'closed'] as const;
type FeedbackStatus = (typeof VALID_STATUSES)[number];

export async function setFeedbackStatusAction(formData: FormData): Promise<void> {
  await requireSession();
  if (!(await isSuperAdmin())) throw new Error('Not authorized');
  const reportId = String(formData.get('reportId') ?? '');
  const status = String(formData.get('status') ?? '') as FeedbackStatus;
  if (!reportId) throw new Error('Missing report');
  if (!VALID_STATUSES.includes(status)) throw new Error('Invalid status');

  await db
    .update(feedbackReports)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(feedbackReports.id, reportId));

  revalidatePath('/feedback');
  revalidatePath(`/feedback/${reportId}`);
  revalidatePath('/super-admin/feedback');
  revalidatePath(`/super-admin/feedback/${reportId}`);
}

// Suppress unused import warning — `and` may come in handy when we add filters.
void and;
