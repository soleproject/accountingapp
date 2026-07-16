import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { DEFAULT_AUTO_POST_THRESHOLD } from './automation-levels';

/**
 * Resolved per-org AI categorization automation settings, read by the
 * auto-categorize job. Falls back to the historical env default
 * (AUTO_CATEGORIZE_CONFIDENCE_THRESHOLD) then 0.85 so existing orgs behave
 * exactly as before until someone changes the setting.
 */
export interface OrgAutomationSettings {
  autoPostEnabled: boolean;
  autoPostThreshold: number;
}

function envDefaultThreshold(): number {
  const raw = process.env.AUTO_CATEGORIZE_CONFIDENCE_THRESHOLD;
  if (!raw) return DEFAULT_AUTO_POST_THRESHOLD;
  const n = parseFloat(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_AUTO_POST_THRESHOLD;
}

export async function getOrgAutomationSettings(organizationId: string): Promise<OrgAutomationSettings> {
  const [org] = await db
    .select({
      enabled: organizations.aiAutoPostEnabled,
      threshold: organizations.aiAutoPostThreshold,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1);
  return {
    autoPostEnabled: org?.enabled ?? true,
    autoPostThreshold: org?.threshold ?? envDefaultThreshold(),
  };
}
