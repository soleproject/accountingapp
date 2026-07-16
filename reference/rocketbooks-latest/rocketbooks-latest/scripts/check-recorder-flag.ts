/**
 * Diagnostic: prints the user's active org and every org that has the
 * 'recorder' feature pack enabled (or has a row for it).
 * Run with: npx tsx scripts/check-recorder-flag.ts [email]
 */
import { config } from 'dotenv';
import { and, eq } from 'drizzle-orm';

config({ path: '.env.local' });

async function main() {
	const email = process.argv[2] ?? 'michael@bigsaas.ai';
	const { db } = await import('../db/client');
	const { users, organizations, organizationAccountingFeatures } = await import('../db/schema/schema');

	const [u] = await db
		.select({
			id: users.id,
			email: users.email,
			activeOrgId: users.activeOrganizationId,
			orgId: users.organizationId,
		})
		.from(users)
		.where(eq(users.email, email))
		.limit(1);

	if (!u) {
		console.log(`No user with email ${email}`);
		process.exit(1);
	}

	const activeOrgId = u.activeOrgId ?? u.orgId;
	console.log(`User ${u.email} (${u.id})`);
	console.log(`  active_organization_id: ${u.activeOrgId ?? '(null)'}`);
	console.log(`  organization_id:        ${u.orgId ?? '(null)'}`);
	console.log(`  resolved active:        ${activeOrgId ?? '(none)'}`);
	console.log();

	if (activeOrgId) {
		const [activeOrg] = await db
			.select({ name: organizations.name })
			.from(organizations)
			.where(eq(organizations.id, activeOrgId))
			.limit(1);
		console.log(`Active org name: ${activeOrg?.name ?? '(not found)'}`);

		const [flag] = await db
			.select({ enabled: organizationAccountingFeatures.enabled })
			.from(organizationAccountingFeatures)
			.where(
				and(
					eq(organizationAccountingFeatures.organizationId, activeOrgId),
					eq(organizationAccountingFeatures.featurePack, 'recorder'),
				),
			)
			.limit(1);
		console.log(`recorder flag on active org: ${flag ? (flag.enabled ? 'ENABLED' : 'disabled') : '(no row)'}`);
		console.log();
	}

	const allRows = await db
		.select({
			orgId: organizationAccountingFeatures.organizationId,
			enabled: organizationAccountingFeatures.enabled,
			orgName: organizations.name,
		})
		.from(organizationAccountingFeatures)
		.leftJoin(organizations, eq(organizations.id, organizationAccountingFeatures.organizationId))
		.where(eq(organizationAccountingFeatures.featurePack, 'recorder'));

	console.log(`Orgs with a recorder row (${allRows.length}):`);
	for (const r of allRows) {
		console.log(`  ${r.enabled ? 'ON ' : 'off'}  ${r.orgId}  ${r.orgName ?? '(no name)'}`);
	}

	process.exit(0);
}

main().catch((err) => {
	console.error('✗ failed:', err);
	process.exit(1);
});
