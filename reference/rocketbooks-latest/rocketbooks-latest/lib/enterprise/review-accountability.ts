import 'server-only';
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { enterpriseClients, organizations, users, transactions, aiClientOutreach } from '@/db/schema/schema';

/**
 * Firm-level review accountability: for each of an enterprise's client orgs, how
 * many transactions are waiting in the review queue, how stale the oldest is, and
 * when the client was last sent a "review_request" nudge. Powers the chase list
 * so the firm knows who to push. Reuses the enterprise→client join the dashboard
 * uses (organizations owned by enterprise_clients.client_user_id).
 */

export interface ClientReviewRow {
  orgId: string;
  orgName: string;
  ownerEmail: string | null;
  pendingCount: number;
  oldestDays: number | null;
  lastRequestAt: string | null;
  lastRequestStatus: string | null;
}

/** The enterprise's client org ids (excludes enterprise orgs). */
export async function listEnterpriseClientOrgIds(enterpriseId: string): Promise<string[]> {
  const rows = await db
    .select({ orgId: organizations.id })
    .from(enterpriseClients)
    .innerJoin(organizations, eq(organizations.ownerUserId, enterpriseClients.clientUserId))
    .where(
      and(eq(enterpriseClients.enterpriseId, enterpriseId), sql`${organizations.planType} <> 'enterprise'`),
    );
  return [...new Set(rows.map((r) => r.orgId))];
}

export async function loadClientReviewAccountability(enterpriseId: string): Promise<ClientReviewRow[]> {
  const orgs = await db
    .select({
      orgId: organizations.id,
      orgName: organizations.name,
      ownerEmail: users.email,
    })
    .from(enterpriseClients)
    .innerJoin(organizations, eq(organizations.ownerUserId, enterpriseClients.clientUserId))
    .leftJoin(users, eq(users.id, organizations.ownerUserId))
    .where(
      and(eq(enterpriseClients.enterpriseId, enterpriseId), sql`${organizations.planType} <> 'enterprise'`),
    );
  if (orgs.length === 0) return [];

  const orgIds = [...new Set(orgs.map((o) => o.orgId))];

  // Pending review per client org (reviewed is false/null), with the oldest.
  const pending = await db
    .select({
      orgId: transactions.organizationId,
      n: sql<number>`count(*)::int`,
      oldest: sql<string | null>`min(${transactions.createdAt})`,
    })
    .from(transactions)
    .where(
      and(
        inArray(transactions.organizationId, orgIds),
        or(eq(transactions.reviewed, false), isNull(transactions.reviewed)),
      ),
    )
    .groupBy(transactions.organizationId);
  const pendMap = new Map(pending.map((p) => [p.orgId, p]));

  // Latest review_request outreach per org (DESC → first seen is newest).
  const outreach = await db
    .select({
      orgId: aiClientOutreach.organizationId,
      lastContactAt: aiClientOutreach.lastContactAt,
      status: aiClientOutreach.status,
    })
    .from(aiClientOutreach)
    .where(
      and(inArray(aiClientOutreach.organizationId, orgIds), eq(aiClientOutreach.issueType, 'review_request')),
    )
    .orderBy(desc(aiClientOutreach.updatedAt));
  const outMap = new Map<string, { lastContactAt: string | null; status: string | null }>();
  for (const o of outreach) {
    if (!outMap.has(o.orgId)) outMap.set(o.orgId, { lastContactAt: o.lastContactAt, status: o.status });
  }

  const seen = new Set<string>();
  const rows: ClientReviewRow[] = [];
  for (const o of orgs) {
    if (seen.has(o.orgId)) continue;
    seen.add(o.orgId);
    const p = pendMap.get(o.orgId);
    const oldestDays =
      p?.oldest ? Math.floor((Date.now() - new Date(p.oldest).getTime()) / 86_400_000) : null;
    const out = outMap.get(o.orgId);
    rows.push({
      orgId: o.orgId,
      orgName: o.orgName,
      ownerEmail: o.ownerEmail ?? null,
      pendingCount: p?.n ?? 0,
      oldestDays,
      lastRequestAt: out?.lastContactAt ?? null,
      lastRequestStatus: out?.status ?? null,
    });
  }

  // Most pending first, then oldest-aging first.
  rows.sort((a, b) => b.pendingCount - a.pendingCount || (b.oldestDays ?? -1) - (a.oldestDays ?? -1));
  return rows;
}
