import 'server-only';
import { desc, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach } from '@/db/schema/schema';
import type { OutreachChannel, OutreachIssueType, OutreachStatus } from './ai-actions';

export interface OutreachRecord {
  organizationId: string;
  issueType: OutreachIssueType;
  status: OutreachStatus;
  channel: OutreachChannel | null;
  lastMessageBody: string | null;
  lastContactAt: Date | null;
}

/** key = `${orgId}:${issueType}` */
export type OutreachMap = Map<string, OutreachRecord>;

export function outreachKey(orgId: string, issueType: string): string {
  return `${orgId}:${issueType}`;
}

/**
 * Latest outreach record per (client org, issue type) across the given client
 * orgs. Pulls all matching rows newest-first and keeps the first seen per key
 * (= the latest). Empty map for no orgs.
 */
export async function getOutreachMap(orgIds: string[]): Promise<OutreachMap> {
  const map: OutreachMap = new Map();
  if (orgIds.length === 0) return map;

  const rows = await db
    .select({
      organizationId: aiClientOutreach.organizationId,
      issueType: aiClientOutreach.issueType,
      status: aiClientOutreach.status,
      channel: aiClientOutreach.channel,
      lastMessageBody: aiClientOutreach.lastMessageBody,
      lastContactAt: aiClientOutreach.lastContactAt,
    })
    .from(aiClientOutreach)
    .where(inArray(aiClientOutreach.organizationId, orgIds))
    .orderBy(desc(aiClientOutreach.updatedAt));

  for (const r of rows) {
    const key = outreachKey(r.organizationId, r.issueType);
    if (map.has(key)) continue; // first seen is the latest (ordered desc)
    map.set(key, {
      organizationId: r.organizationId,
      issueType: r.issueType as OutreachIssueType,
      status: (r.status as OutreachStatus) ?? 'none',
      channel: (r.channel as OutreachChannel | null) ?? null,
      lastMessageBody: r.lastMessageBody ?? null,
      lastContactAt: r.lastContactAt ? new Date(r.lastContactAt) : null,
    });
  }
  return map;
}
