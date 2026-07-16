import 'server-only';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetCategories,
	fixedAssets,
	loans,
	rentalProperties,
	tagDimensions as tagDimensionsTable,
	tagDimensionValues,
} from '@/db/schema/schema';

/**
 * Catalogue of every tag dimension the JE-line tagging system knows
 * about. Memory, auto-tag, TagsPanel, BulkBar, and the resolution UI
 * all iterate over dimensions returned by loadAllDimensionsForOrg()
 * rather than referencing individual dimensions by name.
 *
 * System dimensions are hardcoded here (rental_property, fixed_asset,
 * loan). User-defined dimensions live in the tag_dimensions /
 * tag_dimension_values tables and are merged in per-org at load time.
 *
 * Contact (vendor / customer) is intentionally NOT a dimension here:
 * it's already typed on journal_entry_lines.contact_id with semantics
 * (drives memory, drives trust-rule routing) distinct from the "tag
 * for reporting rollups" use case.
 */

/** System dimensions backed by typed entity tables. */
export type SystemTagEntityType = 'rental_property' | 'fixed_asset' | 'loan';

/**
 * Tag entity_type is any non-empty slug — system (the literals above)
 * or a user-defined dimension slug. The store accepts any string;
 * validation against an actual entity happens at validateEntity time.
 */
export type TagEntityType = string;

export interface TagOption {
	id: string;
	label: string;
	subLabel?: string;
}

export interface TagDimensionMeta {
	entityType: TagEntityType;
	/** Long label for the panel ("Rental property"). */
	label: string;
	/** Short label for the BulkBar row ("Property"). */
	shortLabel: string;
	emoji: string;
	/** 'system' = hardcoded in this file. 'user' = row in tag_dimensions. */
	kind: 'system' | 'user';
	/** Fetch picker options. For system dimensions: query the typed
	 *  entity table. For user dimensions: query tag_dimension_values. */
	loadOptions(orgId: string): Promise<TagOption[]>;
	/** Confirm the value belongs to the org. */
	validateEntity(orgId: string, entityId: string): Promise<boolean>;
	/** Optional detail-page URL builder. */
	detailPath?(entityId: string): string;
	/** Whether to fold this dimension into auto-tag memory. */
	participatesInAutoTag: boolean;
}

const rentalPropertyDim: TagDimensionMeta = {
	entityType: 'rental_property',
	label: 'Rental property',
	shortLabel: 'Property',
	emoji: '🏠',
	kind: 'system',
	async loadOptions(orgId) {
		const rows = await db
			.select({ id: rentalProperties.id, displayName: rentalProperties.displayName })
			.from(rentalProperties)
			.where(
				and(
					eq(rentalProperties.organizationId, orgId),
					eq(rentalProperties.status, 'active'),
				),
			)
			.orderBy(asc(rentalProperties.displayName));
		return rows.map((r) => ({ id: r.id, label: r.displayName }));
	},
	async validateEntity(orgId, entityId) {
		const [r] = await db
			.select({ id: rentalProperties.id })
			.from(rentalProperties)
			.where(
				and(
					eq(rentalProperties.id, entityId),
					eq(rentalProperties.organizationId, orgId),
				),
			)
			.limit(1);
		return !!r;
	},
	detailPath: (id) => `/rental-properties/${id}`,
	participatesInAutoTag: true,
};

const fixedAssetDim: TagDimensionMeta = {
	entityType: 'fixed_asset',
	label: 'Fixed asset',
	shortLabel: 'Asset',
	emoji: '🏷',
	kind: 'system',
	async loadOptions(orgId) {
		const rows = await db
			.select({
				id: fixedAssets.id,
				name: fixedAssets.name,
				assetNumber: fixedAssets.assetNumber,
				categoryName: assetCategories.name,
			})
			.from(fixedAssets)
			.leftJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
			.where(
				and(
					eq(fixedAssets.organizationId, orgId),
					inArray(fixedAssets.status, ['active', 'draft']),
				),
			)
			.orderBy(asc(fixedAssets.name));
		return rows.map((r) => ({
			id: r.id,
			label: r.assetNumber ? `${r.assetNumber} · ${r.name}` : r.name,
			subLabel: r.categoryName ?? undefined,
		}));
	},
	async validateEntity(orgId, entityId) {
		const [r] = await db
			.select({ id: fixedAssets.id })
			.from(fixedAssets)
			.where(and(eq(fixedAssets.id, entityId), eq(fixedAssets.organizationId, orgId)))
			.limit(1);
		return !!r;
	},
	detailPath: (id) => `/assets/${id}`,
	participatesInAutoTag: true,
};

const loanDim: TagDimensionMeta = {
	entityType: 'loan',
	label: 'Loan',
	shortLabel: 'Loan',
	emoji: '💵',
	kind: 'system',
	async loadOptions(orgId) {
		const rows = await db
			.select({ id: loans.id, displayName: loans.displayName })
			.from(loans)
			.where(and(eq(loans.organizationId, orgId), eq(loans.status, 'active')))
			.orderBy(asc(loans.displayName));
		return rows.map((r) => ({ id: r.id, label: r.displayName }));
	},
	async validateEntity(orgId, entityId) {
		const [r] = await db
			.select({ id: loans.id })
			.from(loans)
			.where(and(eq(loans.id, entityId), eq(loans.organizationId, orgId)))
			.limit(1);
		return !!r;
	},
	detailPath: (id) => `/loans/${id}`,
	participatesInAutoTag: true,
};

/** Hard-coded list of system dimensions. */
export const SYSTEM_TAG_DIMENSIONS: ReadonlyArray<TagDimensionMeta> = [
	rentalPropertyDim,
	fixedAssetDim,
	loanDim,
];

const SYSTEM_BY_TYPE: Record<string, TagDimensionMeta> = {
	rental_property: rentalPropertyDim,
	fixed_asset: fixedAssetDim,
	loan: loanDim,
};

/** Reserved slugs — can't be used for user-defined dimensions. */
export const RESERVED_DIMENSION_SLUGS: ReadonlySet<string> = new Set(
	Object.keys(SYSTEM_BY_TYPE),
);

/** Sync system-only lookup. Use loadDimensionMeta(orgId, slug) for
 *  the org-aware version that also resolves user-defined slugs. */
export function getSystemTagDimension(entityType: string): TagDimensionMeta | null {
	return SYSTEM_BY_TYPE[entityType] ?? null;
}

export function isSystemTagEntityType(value: string): value is SystemTagEntityType {
	return value in SYSTEM_BY_TYPE;
}

/** Build the runtime TagDimensionMeta for a user-defined dimension row. */
function buildUserDimensionMeta(row: {
	id: string;
	slug: string;
	label: string;
	emoji: string | null;
}): TagDimensionMeta {
	return {
		entityType: row.slug,
		label: row.label,
		shortLabel: row.label,
		emoji: row.emoji ?? '🏷',
		kind: 'user',
		async loadOptions(orgId) {
			const values = await db
				.select({
					id: tagDimensionValues.id,
					label: tagDimensionValues.label,
				})
				.from(tagDimensionValues)
				.where(
					and(
						eq(tagDimensionValues.organizationId, orgId),
						eq(tagDimensionValues.dimensionId, row.id),
						isNull(tagDimensionValues.archivedAt),
					),
				)
				.orderBy(asc(tagDimensionValues.sortOrder), asc(tagDimensionValues.label));
			return values.map((v) => ({ id: v.id, label: v.label }));
		},
		async validateEntity(orgId, entityId) {
			const [r] = await db
				.select({ id: tagDimensionValues.id })
				.from(tagDimensionValues)
				.where(
					and(
						eq(tagDimensionValues.id, entityId),
						eq(tagDimensionValues.organizationId, orgId),
						eq(tagDimensionValues.dimensionId, row.id),
						isNull(tagDimensionValues.archivedAt),
					),
				)
				.limit(1);
			return !!r;
		},
		detailPath: (id) => `/tags/${row.slug}/${id}`,
		// User dimensions don't participate in auto-tag memory in v1 —
		// the semantics are unknown (e.g. a "Department" tag isn't
		// vendor-stable). Can be opt-in later via a column.
		participatesInAutoTag: false,
	};
}

/**
 * Load every dimension (system + user-defined) available to the org.
 * This replaces the static TAG_DIMENSIONS export — UI/memory callers
 * use this so user-defined dimensions show up automatically as soon
 * as they're created in Manage.
 */
export async function loadDimensionsForOrg(orgId: string): Promise<TagDimensionMeta[]> {
	const userRows = await db
		.select({
			id: tagDimensionsTable.id,
			slug: tagDimensionsTable.slug,
			label: tagDimensionsTable.label,
			emoji: tagDimensionsTable.emoji,
		})
		.from(tagDimensionsTable)
		.where(eq(tagDimensionsTable.organizationId, orgId))
		.orderBy(asc(tagDimensionsTable.sortOrder), asc(tagDimensionsTable.label));
	const userDims = userRows.map(buildUserDimensionMeta);
	return [...SYSTEM_TAG_DIMENSIONS, ...userDims];
}

/**
 * Org-aware lookup that resolves either a system or user-defined slug
 * into a TagDimensionMeta. Returns null if the slug doesn't exist in
 * either.
 */
export async function loadDimensionMeta(
	orgId: string,
	entityType: string,
): Promise<TagDimensionMeta | null> {
	const sys = SYSTEM_BY_TYPE[entityType];
	if (sys) return sys;
	const [row] = await db
		.select({
			id: tagDimensionsTable.id,
			slug: tagDimensionsTable.slug,
			label: tagDimensionsTable.label,
			emoji: tagDimensionsTable.emoji,
		})
		.from(tagDimensionsTable)
		.where(
			and(
				eq(tagDimensionsTable.organizationId, orgId),
				eq(tagDimensionsTable.slug, entityType),
			),
		)
		.limit(1);
	if (!row) return null;
	return buildUserDimensionMeta(row);
}

export interface AllDimensionOptions {
	dimension: TagDimensionMeta;
	options: TagOption[];
}

/**
 * Load ALL pickers (system + user-defined) for the org in one shot.
 */
export async function loadAllDimensionOptions(orgId: string): Promise<AllDimensionOptions[]> {
	const dims = await loadDimensionsForOrg(orgId);
	return Promise.all(
		dims.map(async (d) => ({
			dimension: d,
			options: await d.loadOptions(orgId),
		})),
	);
}

/**
 * Resolve a single entity's display label. Falls back to a truncated
 * id when the entity is gone (deleted, or in a state the loader
 * filters out).
 */
export async function getEntityLabel(args: {
	organizationId: string;
	entityType: string;
	entityId: string;
}): Promise<{ label: string; subLabel?: string } | null> {
	const dim = await loadDimensionMeta(args.organizationId, args.entityType);
	if (!dim) return null;
	const opts = await dim.loadOptions(args.organizationId);
	const opt = opts.find((o) => o.id === args.entityId);
	if (opt) return { label: opt.label, subLabel: opt.subLabel };
	return { label: `${dim.label} ${args.entityId.slice(0, 8)}` };
}

/** Sync auto-tag filter — system-only. User dimensions opt out of
 *  memory in v1. */
export const AUTO_TAG_DIMENSIONS = SYSTEM_TAG_DIMENSIONS.filter((d) => d.participatesInAutoTag);
