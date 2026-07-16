import 'server-only';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { orgEntityType, organizations } from '@/db/schema/schema';

export type OrgEntityType = (typeof orgEntityType.enumValues)[number];

const VALUES = new Set<string>(orgEntityType.enumValues);

/**
 * Narrows a free-form string (e.g. from a form field) to the OrgEntityType
 * enum. Returns null for null/undefined/empty/unknown values so the column
 * stays nullable for orgs that haven't picked a type yet.
 */
export function toOrgEntityType(value: string | null | undefined): OrgEntityType | null {
	if (!value) return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	return VALUES.has(trimmed) ? (trimmed as OrgEntityType) : null;
}

/**
 * Returns whether the entity-type onboarding step should be shown for the
 * given org. The toggle lives on the org's parent Enterprise (the org owner
 * is a client of that Enterprise via enterprise_clients). Returns false when
 * the org has no enterprise affiliation (standalone Paying User) or when the
 * parent Enterprise hasn't opted in. Safe to call for any org.
 */
export async function getEntityTypeOnboardingEnabledForOrg(orgId: string): Promise<boolean> {
	const [row] = await db
		.select({ enabled: organizations.entityTypeOnboardingEnabled })
		.from(organizations)
		.where(
			sql`${organizations.id} in (
				select enterprise_id from enterprise_clients
				where client_user_id = (select owner_user_id from organizations where id = ${orgId})
			)`,
		)
		.limit(1);
	return row?.enabled ?? false;
}
