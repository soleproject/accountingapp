'use server';

import { randomUUID } from 'crypto';
import { revalidatePath } from 'next/cache';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '@/db/client';
import { assetCategories, chartOfAccounts, fixedAssets } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';

const Schema = z.object({
	id: z.string().optional(),
	name: z.string().min(1).max(80),
	assetAccountId: z.string().min(1),
	accumulatedDepAccountId: z.string().min(1),
	depExpenseAccountId: z.string().min(1),
	defaultMethod: z.enum(['straight_line', 'declining_balance_150', 'declining_balance_200', 'macrs_gds', 'macrs_ads']),
	defaultUsefulLifeMonths: z.coerce.number().int().positive(),
	defaultSalvagePct: z.coerce.number().min(0).max(100).default(0),
	defaultAutoDepreciate: z.boolean().default(false),
});

export interface SaveAssetCategoryResult {
	ok: boolean;
	error?: string;
	id?: string;
}

/**
 * Create OR update an asset category. When `id` is set, updates; else
 * inserts. The three GL account ids must all belong to the current org.
 * Existing assets in the category are NOT migrated when account ids
 * change — those assets still post to the OLD accounts on subsequent
 * runs. The category's bindings only affect NEW assets and NEW
 * depreciation runs going forward.
 *
 * Per the (org, name) unique constraint, name conflicts surface as a
 * "Category name is already in use" error rather than a 500.
 */
export async function saveAssetCategory(args: {
	id?: string;
	name: string;
	assetAccountId: string;
	accumulatedDepAccountId: string;
	depExpenseAccountId: string;
	defaultMethod: 'straight_line' | 'declining_balance_150' | 'declining_balance_200' | 'macrs_gds' | 'macrs_ads';
	defaultUsefulLifeMonths: number;
	defaultSalvagePct?: number;
	defaultAutoDepreciate?: boolean;
}): Promise<SaveAssetCategoryResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse(args);
	if (!parsed.success) {
		return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}

	// Validate every account id belongs to this org. Cheap single query.
	const accountIds = [
		parsed.data.assetAccountId,
		parsed.data.accumulatedDepAccountId,
		parsed.data.depExpenseAccountId,
	];
	const orgAccounts = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(eq(chartOfAccounts.organizationId, orgId));
	const orgAccountIds = new Set(orgAccounts.map((a) => a.id));
	if (accountIds.some((id) => !orgAccountIds.has(id))) {
		return { ok: false, error: 'One or more accounts are not in this organization' };
	}

	try {
		if (parsed.data.id) {
			const result = await db
				.update(assetCategories)
				.set({
					name: parsed.data.name,
					assetAccountId: parsed.data.assetAccountId,
					accumulatedDepAccountId: parsed.data.accumulatedDepAccountId,
					depExpenseAccountId: parsed.data.depExpenseAccountId,
					defaultMethod: parsed.data.defaultMethod,
					defaultUsefulLifeMonths: parsed.data.defaultUsefulLifeMonths,
					defaultSalvagePct: parsed.data.defaultSalvagePct.toFixed(2),
					defaultAutoDepreciate: parsed.data.defaultAutoDepreciate ?? false,
					updatedAt: new Date().toISOString(),
				})
				.where(
					and(
						eq(assetCategories.id, parsed.data.id),
						eq(assetCategories.organizationId, orgId),
					),
				)
				.returning({ id: assetCategories.id });
			if (result.length === 0) {
				return { ok: false, error: 'Category not found in this organization' };
			}
			revalidatePath('/assets/categories');
			revalidatePath('/assets/new');
			return { ok: true, id: result[0].id };
		}

		const id = randomUUID();
		await db.insert(assetCategories).values({
			id,
			organizationId: orgId,
			name: parsed.data.name,
			assetAccountId: parsed.data.assetAccountId,
			accumulatedDepAccountId: parsed.data.accumulatedDepAccountId,
			depExpenseAccountId: parsed.data.depExpenseAccountId,
			defaultMethod: parsed.data.defaultMethod,
			defaultUsefulLifeMonths: parsed.data.defaultUsefulLifeMonths,
			defaultSalvagePct: parsed.data.defaultSalvagePct.toFixed(2),
			defaultAutoDepreciate: parsed.data.defaultAutoDepreciate ?? false,
		});
		revalidatePath('/assets/categories');
		revalidatePath('/assets/new');
		return { ok: true, id };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes('unique') || message.includes('duplicate')) {
			return { ok: false, error: 'A category with that name already exists in this organization' };
		}
		return { ok: false, error: message };
	}
}

/**
 * Delete an asset category — only when no assets reference it.
 */
export async function deleteAssetCategory(args: { id: string }): Promise<SaveAssetCategoryResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [inUse] = await db
		.select({ id: fixedAssets.id })
		.from(fixedAssets)
		.where(
			and(
				eq(fixedAssets.organizationId, orgId),
				eq(fixedAssets.categoryId, args.id),
			),
		)
		.limit(1);
	if (inUse) {
		return { ok: false, error: 'Category has assets — can\'t delete. Reassign or dispose those assets first.' };
	}

	const result = await db
		.delete(assetCategories)
		.where(
			and(
				eq(assetCategories.id, args.id),
				eq(assetCategories.organizationId, orgId),
			),
		)
		.returning({ id: assetCategories.id });
	if (result.length === 0) {
		return { ok: false, error: 'Category not found in this organization' };
	}
	revalidatePath('/assets/categories');
	revalidatePath('/assets/new');
	return { ok: true };
}
