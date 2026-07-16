'use server';

import { randomUUID } from 'crypto';
import { and, count, eq } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { db } from '@/db/client';
import {
	journalEntryLineTags,
	tagDimensions,
	tagDimensionValues,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { RESERVED_DIMENSION_SLUGS } from '@/lib/tags/dimensions';

export interface DimResult {
	ok: boolean;
	error?: string;
}

const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/;

function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 50);
}

/**
 * Create a user-defined tag dimension. Slug is auto-derived from the
 * label unless one is supplied. Reserved slugs (system dimensions)
 * are rejected, and the (org, slug) UNIQUE constraint catches
 * duplicates.
 */
export async function createDimension(args: {
	label: string;
	slug?: string;
	emoji?: string;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const label = args.label.trim();
	if (!label) return { ok: false, error: 'Label is required' };
	const slug = (args.slug ?? slugify(label)).trim();
	if (!slug || !SLUG_RE.test(slug)) {
		return {
			ok: false,
			error: 'Slug must be lowercase letters, numbers, _ or - (max 50 chars)',
		};
	}
	if (RESERVED_DIMENSION_SLUGS.has(slug)) {
		return { ok: false, error: `Slug "${slug}" is reserved for a system dimension` };
	}
	const emoji = (args.emoji ?? '').trim() || null;

	try {
		await db.insert(tagDimensions).values({
			id: randomUUID(),
			organizationId: orgId,
			slug,
			label,
			emoji,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('tag_dimensions_org_slug_unique')) {
			return { ok: false, error: `A dimension with slug "${slug}" already exists` };
		}
		return { ok: false, error: msg };
	}

	revalidatePath('/tags');
	return { ok: true };
}

export async function updateDimension(args: {
	dimensionId: string;
	label: string;
	emoji?: string;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const label = args.label.trim();
	if (!label) return { ok: false, error: 'Label is required' };

	const [existing] = await db
		.select({ id: tagDimensions.id })
		.from(tagDimensions)
		.where(
			and(
				eq(tagDimensions.id, args.dimensionId),
				eq(tagDimensions.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Dimension not found' };

	await db
		.update(tagDimensions)
		.set({
			label,
			emoji: args.emoji?.trim() || null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(tagDimensions.id, args.dimensionId));

	revalidatePath('/tags');
	return { ok: true };
}

/**
 * Delete a user-defined dimension. Blocked when any tag (live or
 * historical) still references its values — preserves audit trail.
 * The user can archive individual values or null out tags from the
 * Tags panel before deleting if they really want to remove it.
 */
export async function deleteDimension(args: {
	dimensionId: string;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [existing] = await db
		.select({ id: tagDimensions.id, slug: tagDimensions.slug })
		.from(tagDimensions)
		.where(
			and(
				eq(tagDimensions.id, args.dimensionId),
				eq(tagDimensions.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Dimension not found' };

	const [tagCount] = await db
		.select({ n: count() })
		.from(journalEntryLineTags)
		.where(
			and(
				eq(journalEntryLineTags.organizationId, orgId),
				eq(journalEntryLineTags.entityType, existing.slug),
			),
		);
	if ((tagCount?.n ?? 0) > 0) {
		return {
			ok: false,
			error: `Cannot delete — ${tagCount.n} JE line(s) still tagged. Untag them or archive the dimension's values first.`,
		};
	}

	await db.delete(tagDimensions).where(eq(tagDimensions.id, args.dimensionId));

	revalidatePath('/tags');
	return { ok: true };
}

export async function createDimensionValue(args: {
	dimensionId: string;
	label: string;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const label = args.label.trim();
	if (!label) return { ok: false, error: 'Label is required' };

	const [dim] = await db
		.select({ id: tagDimensions.id })
		.from(tagDimensions)
		.where(
			and(
				eq(tagDimensions.id, args.dimensionId),
				eq(tagDimensions.organizationId, orgId),
			),
		)
		.limit(1);
	if (!dim) return { ok: false, error: 'Dimension not found' };

	try {
		await db.insert(tagDimensionValues).values({
			id: randomUUID(),
			organizationId: orgId,
			dimensionId: args.dimensionId,
			label,
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('tag_dimension_values_dim_label_unique')) {
			return { ok: false, error: `Value "${label}" already exists in this dimension` };
		}
		return { ok: false, error: msg };
	}

	revalidatePath('/tags');
	return { ok: true };
}

export async function setValueArchived(args: {
	valueId: string;
	archived: boolean;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const [existing] = await db
		.select({ id: tagDimensionValues.id })
		.from(tagDimensionValues)
		.where(
			and(
				eq(tagDimensionValues.id, args.valueId),
				eq(tagDimensionValues.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Value not found' };

	await db
		.update(tagDimensionValues)
		.set({
			archivedAt: args.archived ? new Date().toISOString() : null,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(tagDimensionValues.id, args.valueId));

	revalidatePath('/tags');
	return { ok: true };
}

export async function renameDimensionValue(args: {
	valueId: string;
	label: string;
}): Promise<DimResult> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const label = args.label.trim();
	if (!label) return { ok: false, error: 'Label is required' };

	const [existing] = await db
		.select({ id: tagDimensionValues.id })
		.from(tagDimensionValues)
		.where(
			and(
				eq(tagDimensionValues.id, args.valueId),
				eq(tagDimensionValues.organizationId, orgId),
			),
		)
		.limit(1);
	if (!existing) return { ok: false, error: 'Value not found' };

	try {
		await db
			.update(tagDimensionValues)
			.set({ label, updatedAt: new Date().toISOString() })
			.where(eq(tagDimensionValues.id, args.valueId));
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes('tag_dimension_values_dim_label_unique')) {
			return { ok: false, error: `Value "${label}" already exists in this dimension` };
		}
		return { ok: false, error: msg };
	}

	revalidatePath('/tags');
	return { ok: true };
}
