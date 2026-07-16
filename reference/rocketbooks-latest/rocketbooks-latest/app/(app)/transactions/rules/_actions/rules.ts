'use server';

import { revalidatePath } from 'next/cache';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { hasAnyPermission } from '@/lib/auth/permissions';
import { assertNotDemo } from '@/lib/auth/demo';
import { promoteRule, deleteRule } from '@/lib/accounting/rule-promotion';

const ACCOUNTANT_KEYS = [
  'accounting.transactions.accountant_review',
  'enterprise.dashboard.view',
  'enterprise.clients.view',
];

async function gateOrg(): Promise<string | null> {
  await requireSession();
  const orgId = await getCurrentOrgId();
  if (!(await hasAnyPermission(ACCOUNTANT_KEYS))) return null;
  return orgId;
}

/** Create a categorization rule (from a suggestion or manual entry). */
export async function createRuleAction(formData: FormData): Promise<void> {
  const orgId = await gateOrg();
  if (!orgId) return;
  assertNotDemo(orgId, 'create categorization rule');
  await promoteRule(
    orgId,
    String(formData.get('pattern') ?? ''),
    String(formData.get('categoryAccountId') ?? ''),
  );
  revalidatePath('/transactions/rules');
  revalidatePath('/transactions');
}

export async function deleteRuleAction(formData: FormData): Promise<void> {
  const orgId = await gateOrg();
  if (!orgId) return;
  assertNotDemo(orgId, 'delete categorization rule');
  await deleteRule(orgId, String(formData.get('ruleId') ?? ''));
  revalidatePath('/transactions/rules');
  revalidatePath('/transactions');
}
