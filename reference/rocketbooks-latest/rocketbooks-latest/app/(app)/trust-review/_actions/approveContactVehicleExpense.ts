'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	assetCategories,
	chartOfAccounts,
	fixedAssets,
	journalEntryLines,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { getEffectiveUserId } from '@/lib/auth/impersonate';

export interface ApproveContactVehicleExpenseResult {
	ok: boolean;
	processed: number;
	failed: Array<{ findingId: string; error: string }>;
	error?: string;
}

/**
 * Confirm a TRUST_605_VERIFY_TRUST_OWNED_VEHICLE finding by binding the
 * 605 line(s) on each selected finding's JE to a specific trust-owned
 * vehicle (fixed_asset). No GL movement — the line stays on 605 — but
 * the journal_entry_lines.fixed_asset_id is set so downstream reporting
 * can group per-vehicle. A TRUST_605_TAGGED_TO_VEHICLE audit lands on
 * the same JE; the originating finding is dismissed.
 *
 * The 605 line is located by detail_type='auto' on the joined CoA — that's
 * the trust CoA's vehicle-expense detail type (account 605). Lines on any
 * other 'auto'-typed account get the same treatment, so an org with
 * multiple 'auto' detail accounts is handled uniformly.
 *
 * Sequential per finding so a single bad JE doesn't abort the rest.
 */
export async function approveContactVehicleExpense(args: {
	/** Source contact when scoped to a single sub-group / row. Null
	 *  when called from the toolbar across multiple contacts. */
	contactId?: string | null;
	findingIds: string[];
	vehicleId: string;
}): Promise<ApproveContactVehicleExpenseResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const userId = await getEffectiveUserId();

	if (args.findingIds.length === 0) {
		return { ok: false, processed: 0, failed: [], error: 'No findings selected' };
	}
	if (!args.vehicleId) {
		return { ok: false, processed: 0, failed: [], error: 'No vehicle picked' };
	}

	// Verify the vehicle belongs to this org AND is in the Vehicles asset
	// category. The category-name match is the source of truth for "is
	// this a vehicle" — same filter the picker uses.
	const [vehicle] = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			categoryName: assetCategories.name,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(
			and(
				eq(fixedAssets.id, args.vehicleId),
				eq(fixedAssets.organizationId, orgId),
			),
		)
		.limit(1);
	if (!vehicle) return { ok: false, processed: 0, failed: [], error: 'Vehicle not in this organization' };
	if ((vehicle.categoryName ?? '').toLowerCase() !== 'vehicles') {
		return { ok: false, processed: 0, failed: [], error: `${vehicle.name} isn't in the Vehicles category` };
	}

	const failed: Array<{ findingId: string; error: string }> = [];
	let processed = 0;

	for (const findingId of args.findingIds) {
		try {
			const ok = await approveOneFinding({ orgId, userId, findingId, vehicle });
			if (ok.ok) processed += 1;
			else failed.push({ findingId, error: ok.error ?? 'Failed' });
		} catch (err) {
			failed.push({
				findingId,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	revalidatePath('/trust-review');
	revalidatePath('/assets');
	revalidatePath(`/assets/${args.vehicleId}`);
	return { ok: failed.length === 0, processed, failed };
}

async function approveOneFinding(args: {
	orgId: string;
	userId: string | null;
	findingId: string;
	vehicle: { id: string; name: string };
}): Promise<{ ok: true } | { ok: false; error: string }> {
	const { orgId, userId, findingId, vehicle } = args;

	const [finding] = await db
		.select({
			id: trustReviewFindings.id,
			code: trustReviewFindings.code,
			organizationId: trustReviewFindings.organizationId,
			journalEntryId: trustReviewFindings.journalEntryId,
		})
		.from(trustReviewFindings)
		.where(eq(trustReviewFindings.id, findingId))
		.limit(1);
	if (!finding) return { ok: false, error: 'Finding not found' };
	if (finding.organizationId !== orgId) return { ok: false, error: 'Not authorized' };
	if (finding.code !== 'TRUST_605_VERIFY_TRUST_OWNED_VEHICLE') {
		return { ok: false, error: `approveContactVehicleExpense doesn't apply to ${finding.code}` };
	}

	// Find every 605-class line (detail_type 'auto') on the JE and stamp
	// its fixed_asset_id. Usually exactly one such line per JE; if there
	// are multiple, all get tagged to the same vehicle.
	const vehicleLines = await db
		.select({ accountId: journalEntryLines.accountId })
		.from(journalEntryLines)
		.innerJoin(chartOfAccounts, eq(chartOfAccounts.id, journalEntryLines.accountId))
		.where(
			and(
				eq(journalEntryLines.journalEntryId, finding.journalEntryId),
				eq(chartOfAccounts.organizationId, orgId),
				eq(chartOfAccounts.detailType, 'auto'),
			),
		);
	if (vehicleLines.length === 0) {
		return { ok: false, error: 'No 605 (auto) line on this JE — nothing to tag' };
	}
	const accountIds = Array.from(new Set(vehicleLines.map((l) => l.accountId)));

	try {
		await db.transaction(async (tx) => {
			await tx
				.update(journalEntryLines)
				.set({ fixedAssetId: vehicle.id })
				.where(
					and(
						eq(journalEntryLines.journalEntryId, finding.journalEntryId),
						inArray(journalEntryLines.accountId, accountIds),
					),
				);

			await tx.insert(trustReviewFindings).values({
				id: randomUUID(),
				organizationId: orgId,
				journalEntryId: finding.journalEntryId,
				code: 'TRUST_605_TAGGED_TO_VEHICLE',
				severity: 'warn',
				message: `605 line tagged to ${vehicle.name} — trust-owned vehicle confirmed.`,
				metadata: {
					vehicleId: vehicle.id,
					vehicleName: vehicle.name,
				},
			});

			await tx
				.update(trustReviewFindings)
				.set({
					dismissedAt: new Date().toISOString(),
					dismissedByUserId: userId,
					dismissedNote: `Auto-dismissed: 605 line tagged to ${vehicle.name}.`,
					updatedAt: new Date().toISOString(),
				})
				.where(eq(trustReviewFindings.id, finding.id));
		});
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : 'Failed to tag vehicle' };
	}

	return { ok: true };
}
