import 'server-only';
import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { adminAuditLog } from '@/db/schema/schema';
import { getSession } from '@/lib/auth/session';
import { getImpersonatedUserId } from '@/lib/auth/impersonate';

/**
 * When the current session is a firm acting inside a client's books (the
 * enterprise "Open books" / impersonation flow), returns the firm + client
 * user ids; otherwise null. The impersonation-cookie check short-circuits with
 * no DB work for normal (non-impersonated) sessions, so this is cheap to call
 * from any mutation.
 */
export async function getFirmActor(): Promise<{ firmUserId: string; clientUserId: string } | null> {
  const clientUserId = await getImpersonatedUserId();
  if (!clientUserId) return null;
  const real = await getSession();
  if (!real || real.id === clientUserId) return null;
  return { firmUserId: real.id, clientUserId };
}

export interface FirmChange {
  /** Short verb, e.g. 'categorize', 'period_closed', 'journal_entry'. */
  action: string;
  /** The client company the change landed in. */
  orgId: string;
  /** 'transaction' | 'period' | 'journal_entry' | 'finding' | … */
  entityType: string;
  entityId?: string;
  /** Human-readable one-liner shown in the firm-activity feed. */
  summary: string;
}

/**
 * Record a change a firm user made inside a client's books — attributed to the
 * FIRM user (not the impersonated client), so an edit's author is the
 * accountant. No-op for a client's own edits. Best-effort: never blocks or
 * fails the underlying mutation.
 *
 * Stored in admin_audit_log with targetId = the client (owner) user id, so the
 * per-client bookkeeping view can read its firm-activity feed off the indexed
 * target_id column.
 */
export async function recordFirmChange(change: FirmChange): Promise<void> {
  try {
    const actor = await getFirmActor();
    if (!actor) return;
    await db.insert(adminAuditLog).values({
      id: randomUUID(),
      adminUserId: actor.firmUserId,
      action: `firm.edit.${change.action}`,
      targetType: 'client_books',
      targetId: actor.clientUserId,
      auditMetadata: {
        orgId: change.orgId,
        entityType: change.entityType,
        entityId: change.entityId ?? null,
        summary: change.summary,
      },
    });
  } catch {
    // Attribution is best-effort — never break the edit over a logging hiccup.
  }
}
