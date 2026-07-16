import 'server-only';
import { sql, eq, and } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';
import { deleteOrganizationCascade } from './delete-organization';
import { logger } from '@/lib/logger';

// The default name createFreshOrganization() gives a brand-new workspace before
// the user names it during onboarding. An org still carrying this name with no
// activity is an abandoned/never-finished "Add business" shell.
const PLACEHOLDER_NAME = 'My Business';

interface OrgRow {
  id: string;
  created_at: string;
  is_empty_placeholder: boolean;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] }).rows ?? []) as T[];
}

// One pro org per row + a flag for "empty placeholder" (still named My Business,
// no description, no transactions / Plaid / imports, onboarding not completed).
async function loadOwnerOrgs(ownerUserId: string): Promise<OrgRow[]> {
  const result = await db.execute(sql`
    select o.id, o.created_at,
      (o.name = ${PLACEHOLDER_NAME}
        and coalesce(o.business_description, '') = ''
        and not exists (select 1 from transactions t where t.organization_id = o.id)
        and not exists (select 1 from plaid_accounts p where p.linked_organization_id = o.id)
        and not exists (select 1 from imports i where i.organization_id = o.id)
        and not coalesce((select os.completed from onboarding_state os where os.org_id = o.id), false)
      ) as is_empty_placeholder
    from organizations o
    where o.owner_user_id = ${ownerUserId} and o.plan_type = 'pro'
  `);
  return rowsOf<OrgRow>(result);
}

/**
 * Remove leftover empty "My Business" placeholder orgs for a user:
 *   - If they have ANY real org, delete ALL of their empty placeholders.
 *   - If they have none, keep the newest placeholder (their workspace-in-
 *     progress) and delete the rest.
 * `excludeOrgId` (the org that just became real) is always kept. Repoints any
 * active/primary-org pointer off a deleted org to a survivor. Best-effort:
 * a failure on one org is logged and skipped, never thrown to the caller.
 * Returns how many orgs were deleted.
 */
export async function pruneEmptyPlaceholderOrgs(ownerUserId: string, excludeOrgId?: string): Promise<number> {
  if (!ownerUserId) return 0;
  const list = await loadOwnerOrgs(ownerUserId);

  const empties = list.filter((o) => o.is_empty_placeholder && o.id !== excludeOrgId);
  const realCount = list.filter((o) => !o.is_empty_placeholder || o.id === excludeOrgId).length;
  if (empties.length === 0) return 0;

  let toDelete = empties;
  if (realCount === 0) {
    // Keep the newest empty placeholder as the workspace they're still setting up.
    toDelete = [...empties]
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
      .slice(1);
  }
  if (toDelete.length === 0) return 0;

  const deleteIds = new Set(toDelete.map((o) => o.id));
  const survivor = list.find((o) => !deleteIds.has(o.id))?.id ?? null;

  let deleted = 0;
  for (const o of toDelete) {
    try {
      if (survivor) {
        await db
          .update(users)
          .set({ activeOrganizationId: survivor })
          .where(and(eq(users.id, ownerUserId), eq(users.activeOrganizationId, o.id)));
        await db
          .update(users)
          .set({ organizationId: survivor })
          .where(and(eq(users.id, ownerUserId), eq(users.organizationId, o.id)));
      }
      await deleteOrganizationCascade(o.id);
      deleted++;
    } catch (err) {
      logger.warn(
        { orgId: o.id, ownerUserId, err: err instanceof Error ? err.message : String(err) },
        'prune empty placeholder failed',
      );
    }
  }
  if (deleted) logger.info({ ownerUserId, deleted }, 'pruned empty placeholder orgs');
  return deleted;
}

/**
 * An existing empty placeholder org to REUSE instead of stacking another one
 * (the "Add business" free path). Newest first. Null when none exists.
 */
export async function findEmptyPlaceholderOrg(ownerUserId: string): Promise<{ id: string } | null> {
  const list = await loadOwnerOrgs(ownerUserId);
  const empty = list
    .filter((o) => o.is_empty_placeholder)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
  return empty ? { id: empty.id } : null;
}
