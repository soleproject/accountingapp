import Link from 'next/link';
import { and, count, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	assetCategories,
	documentRecords,
	fixedAssets,
	rentalProperties,
	trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { listTemplates } from '@/lib/resolutions/registry';
import type { Signer, TemplateCategory } from '@/lib/resolutions/types';
import { InlineDeleteButton } from './_components/InlineDeleteButton';

const CATEGORY_LABELS: Record<TemplateCategory, string> = {
	foundational: 'Foundational',
	corpus: 'Corpus / Funding',
	operating: 'Operating',
	annual: 'Annual',
	governance: 'Governance',
};

const STATUS_PALETTE: Record<string, string> = {
	rendering: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
	draft: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
	signed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
	failed: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
};

/**
 * Templates that EVERY irrevocable non-grantor trust must have at
 * least one of, regardless of activity. These drive the "Compliance
 * baseline" callout at the top of the page so a user can see at a
 * glance whether the trust has the four foundational artifacts on
 * file.
 *
 *   utc-813-initial-notice    — statutory 60-day notice to qualified
 *                                beneficiaries; without it, breach-
 *                                of-trust limitation periods never
 *                                start running.
 *   investment-policy-statement — UPIA §2(b); without it, every
 *                                investment is naked under the
 *                                prudent-investor rule.
 *   schedule-a                 — initial corpus declaration; ties
 *                                the §671 grantor / non-grantor
 *                                determination to a written list of
 *                                what was contributed.
 *   trustee-compensation       — §708 reasonableness + §802 fairness;
 *                                an explicit zero-comp resolution
 *                                also satisfies the gap, but until
 *                                ONE compensation resolution exists
 *                                every fee payment is voidable.
 *
 * Order in the array is the display order in the baseline card.
 */
const BASELINE_REQUIRED_TEMPLATE_IDS = [
	'utc-813-initial-notice',
	'investment-policy-statement',
	'schedule-a',
	'trustee-compensation',
] as const;

type TemplateStats = {
	count: number;
	/** ISO string of the most-recent createdAt — used for "last drafted YYYY-MM-DD". */
	lastDraftedAt: string | null;
};

/**
 * Three-tab layout driven by `?tab=` search param:
 *   suggested (default) — Compliance baseline + Activity-based gaps
 *   completed           — Recent documents table
 *   list                — Full template catalog
 *
 * Each tab is server-rendered (deep-linkable, no client hydration
 * needed). Tab nav lives just below the header and surfaces badges
 * showing how many items are flagged / completed.
 */
type Tab = 'suggested' | 'completed' | 'list';
const VALID_TABS: readonly Tab[] = ['suggested', 'completed', 'list'] as const;

interface PageProps {
	searchParams: Promise<{ tab?: string; focus?: string }>;
}

export default async function TrustDocumentsPage({ searchParams }: PageProps) {
	const sp = await searchParams;
	const tab: Tab = (VALID_TABS as readonly string[]).includes(sp.tab ?? '')
		? (sp.tab as Tab)
		: 'suggested';
	const orgId = await getCurrentOrgId();

	// Aggregated stats per template — single round-trip, accurate
	// across the full history (the 200-row "recent" query below covers
	// only the table on the bottom of the page).
	const statsRows = await db
		.select({
			templateId: documentRecords.templateId,
			n: count().as('n'),
			lastDraftedAt: sql<string | null>`max(${documentRecords.createdAt})`.as('last_drafted_at'),
		})
		.from(documentRecords)
		.where(eq(documentRecords.organizationId, orgId))
		.groupBy(documentRecords.templateId);

	const statsByTemplate = new Map<string, TemplateStats>();
	for (const r of statsRows) {
		statsByTemplate.set(r.templateId, {
			count: Number(r.n),
			lastDraftedAt: r.lastDraftedAt,
		});
	}

	const rows = await db
		.select({
			id: documentRecords.id,
			templateId: documentRecords.templateId,
			resolutionType: documentRecords.resolutionType,
			status: documentRecords.status,
			signers: documentRecords.signers,
			createdAt: documentRecords.createdAt,
			updatedAt: documentRecords.updatedAt,
		})
		.from(documentRecords)
		.where(eq(documentRecords.organizationId, orgId))
		.orderBy(desc(documentRecords.createdAt))
		.limit(200);

	const templates = listTemplates();
	const templatesByCategory = new Map<TemplateCategory, typeof templates[number][]>();
	for (const t of templates) {
		const arr = templatesByCategory.get(t.category) ?? [];
		arr.push(t);
		templatesByCategory.set(t.category, arr);
	}
	const templatesById = new Map(templates.map((t) => [t.id, t]));
	const baselineEntries = BASELINE_REQUIRED_TEMPLATE_IDS.map((id) => {
		const tmpl = templatesById.get(id);
		const stats = statsByTemplate.get(id);
		return { id, label: tmpl?.label ?? id, stats: stats ?? { count: 0, lastDraftedAt: null } };
	});
	const baselineMissingCount = baselineEntries.filter((e) => e.stats.count === 0).length;

	// ────────────────────────────────────────────────────────────────
	// Activity-based gap detection
	//
	// Beyond the always-required baseline, surface conditional gaps
	// that depend on the trust's actual GL activity:
	//   - Purchased real-property fixed_assets without a
	//     real-estate-purchase document on file
	//   - Disposed real-property fixed_assets without a
	//     real-estate-sale document on file
	//   - Active fixed_assets without an insurance-authorization on
	//     file (soft gap — informational only)
	//   - Open TRUST_DEMAND_NOTE_MISSING_NOTE findings (promissory-note
	//     drafting opportunity)
	//
	// Each gap surfaces a single deep-link to the prefilled draft page
	// so the user can act in one click. Counts are computed in JS from
	// two range queries (assets + linked-doc lookup) rather than via a
	// LEFT JOIN; the asset population is small enough that the simpler
	// path is fast and easier to reason about.
	// ────────────────────────────────────────────────────────────────

	const realPropertyAssets = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
			status: fixedAssets.status,
			acquisitionType: fixedAssets.acquisitionType,
		})
		.from(fixedAssets)
		.innerJoin(assetCategories, eq(assetCategories.id, fixedAssets.categoryId))
		.where(
			and(
				eq(fixedAssets.organizationId, orgId),
				sql`(
					lower(${assetCategories.name}) LIKE '%land%'
					OR lower(${assetCategories.name}) LIKE '%building%'
					OR lower(${assetCategories.name}) LIKE '%real%'
					OR lower(${assetCategories.name}) LIKE '%property%'
				)`,
			),
		);

	// All active assets — for the insurance-coverage gap.
	const activeAssets = await db
		.select({
			id: fixedAssets.id,
			name: fixedAssets.name,
		})
		.from(fixedAssets)
		.where(
			and(
				eq(fixedAssets.organizationId, orgId),
				sql`${fixedAssets.status} = 'active'`,
			),
		);

	const activeAssetIds = activeAssets.map((a) => a.id);
	const realPropertyAssetIds = realPropertyAssets.map((a) => a.id);

	// Pull document_records keyed by sourceId for any asset linked
	// above. One round-trip covers all three template types.
	const allRelevantAssetIds = Array.from(new Set([...realPropertyAssetIds, ...activeAssetIds]));
	const linkedAssetDocs = allRelevantAssetIds.length > 0
		? await db
				.select({
					sourceId: documentRecords.sourceId,
					templateId: documentRecords.templateId,
					status: documentRecords.status,
				})
				.from(documentRecords)
				.where(
					and(
						eq(documentRecords.organizationId, orgId),
						eq(documentRecords.sourceKind, 'fixed_asset'),
						inArray(documentRecords.sourceId, allRelevantAssetIds),
						inArray(documentRecords.templateId, [
							'real-estate-purchase',
							'real-estate-sale',
							'insurance-authorization',
						]),
						sql`${documentRecords.status} <> 'voided'`,
					),
				)
		: [];

	// For O(1) lookups: assetId → set of templateIds with a non-voided
	// doc.
	const docsByAsset = new Map<string, Set<string>>();
	for (const d of linkedAssetDocs) {
		if (!d.sourceId) continue;
		const arr = docsByAsset.get(d.sourceId) ?? new Set<string>();
		arr.add(d.templateId);
		docsByAsset.set(d.sourceId, arr);
	}

	// Active rental properties — for the lease-resolution gap.
	const activeRentalProps = await db
		.select({
			id: rentalProperties.id,
			displayName: rentalProperties.displayName,
		})
		.from(rentalProperties)
		.where(
			and(
				eq(rentalProperties.organizationId, orgId),
				sql`${rentalProperties.status} = 'active'`,
			),
		);

	// Linked lease-resolution docs per rental property, non-voided.
	const activeRentalIds = activeRentalProps.map((p) => p.id);
	const linkedLeaseDocs = activeRentalIds.length > 0
		? await db
				.select({
					sourceId: documentRecords.sourceId,
				})
				.from(documentRecords)
				.where(
					and(
						eq(documentRecords.organizationId, orgId),
						eq(documentRecords.sourceKind, 'rental_property'),
						inArray(documentRecords.sourceId, activeRentalIds),
						eq(documentRecords.templateId, 'lease-resolution'),
						sql`${documentRecords.status} <> 'voided'`,
					),
				)
		: [];
	const leasedRentalIds = new Set(linkedLeaseDocs.map((d) => d.sourceId).filter((id): id is string => !!id));

	// Promissory-note gap signal — count of open (not dismissed)
	// TRUST_DEMAND_NOTE_MISSING_NOTE findings.
	const openDemandNoteFindings = await db
		.select({
			id: trustReviewFindings.id,
		})
		.from(trustReviewFindings)
		.where(
			and(
				eq(trustReviewFindings.organizationId, orgId),
				eq(trustReviewFindings.code, 'TRUST_DEMAND_NOTE_MISSING_NOTE'),
				isNull(trustReviewFindings.dismissedAt),
			),
		);

	// Gap aggregation. Each gap has a template + a list of items
	// (asset / finding) that need a doc, plus a deep-link generator.
	type GapItem = { id: string; label: string; deepLink: string };
	type ActivityGap = {
		key: string;
		title: string;
		description: string;
		severity: 'high' | 'medium' | 'info';
		items: GapItem[];
	};
	const activityGaps: ActivityGap[] = [];

	const rePurchaseGapItems: GapItem[] = realPropertyAssets
		.filter((a) => a.acquisitionType === 'purchased')
		.filter((a) => !(docsByAsset.get(a.id)?.has('real-estate-purchase')))
		.map((a) => ({
			id: a.id,
			label: a.name,
			deepLink: `/trust-documents/new?template=real-estate-purchase&fromAsset=${a.id}`,
		}));
	if (rePurchaseGapItems.length > 0) {
		activityGaps.push({
			key: 'real-estate-purchase',
			title: 'Real Estate Purchase resolution',
			description: 'Purchased real property without a backing purchase resolution. Without it, vesting language, prudent-investor finding, and recording instructions are undocumented.',
			severity: 'high',
			items: rePurchaseGapItems,
		});
	}

	const reSaleGapItems: GapItem[] = realPropertyAssets
		.filter((a) => a.status === 'disposed')
		.filter((a) => !(docsByAsset.get(a.id)?.has('real-estate-sale')))
		.map((a) => ({
			id: a.id,
			label: a.name,
			deepLink: `/trust-documents/new?template=real-estate-sale&fromAsset=${a.id}`,
		}));
	if (reSaleGapItems.length > 0) {
		activityGaps.push({
			key: 'real-estate-sale',
			title: 'Real Estate Sale resolution',
			description: 'Disposed real property without a backing sale resolution. §1001 gain calc, §1250 split, and §121 ineligibility recital all live in this document.',
			severity: 'high',
			items: reSaleGapItems,
		});
	}

	const insuranceGapItems: GapItem[] = activeAssets
		.filter((a) => !(docsByAsset.get(a.id)?.has('insurance-authorization')))
		.map((a) => ({
			id: a.id,
			label: a.name,
			deepLink: `/trust-documents/new?template=insurance-authorization&fromAsset=${a.id}`,
		}));
	if (insuranceGapItems.length > 0) {
		activityGaps.push({
			key: 'insurance-authorization',
			title: 'Insurance Authorization',
			description: 'Active assets without a UTC §809 insurance authorization on file. Soft gap — trust can carry uninsured assets, but each is exposure under §809.',
			severity: 'info',
			items: insuranceGapItems,
		});
	}

	const leaseGapItems: GapItem[] = activeRentalProps
		.filter((p) => !leasedRentalIds.has(p.id))
		.map((p) => ({
			id: p.id,
			label: p.displayName,
			deepLink: `/trust-documents/new?template=lease-resolution&fromRental=${p.id}`,
		}));
	if (leaseGapItems.length > 0) {
		activityGaps.push({
			key: 'lease-resolution',
			title: 'Lease Resolution',
			description: 'Active rental properties without a backing lease resolution on file. UTC §816(8)–(9) authority + market-rate evidence + tenant relationship screening all live in this document.',
			severity: 'high',
			items: leaseGapItems,
		});
	}

	if (openDemandNoteFindings.length > 0) {
		activityGaps.push({
			key: 'promissory-note',
			title: 'Promissory Note',
			description: 'Open TRUST_DEMAND_NOTE_MISSING_NOTE warnings indicate 250/260 demand-note activity without a backing note. Below-AFR or undocumented advances can be recharacterized as taxable distributions under IRC §7872.',
			severity: 'high',
			items: openDemandNoteFindings.map((f) => ({
				id: f.id,
				label: 'Open demand-note warning',
				deepLink: `/trust-documents/new?template=promissory-note&fromFinding=${f.id}`,
			})),
		});
	}

	const totalGapItems = activityGaps.reduce((acc, g) => acc + g.items.length, 0);

	// Counts that drive the badges next to each tab. Computed once
	// regardless of active tab so the user always sees the at-a-glance
	// state of every tab.
	const suggestedFlagCount = baselineMissingCount + totalGapItems;
	const completedCount = rows.length;
	const templateCount = templates.length;

	const tabs: ReadonlyArray<{ id: Tab; label: string; badge: string | null; badgeTone: 'flag' | 'muted' }> = [
		{
			id: 'suggested',
			label: 'AI Suggested',
			badge: suggestedFlagCount > 0 ? String(suggestedFlagCount) : null,
			badgeTone: 'flag',
		},
		{
			id: 'completed',
			label: 'Completed',
			badge: completedCount > 0 ? String(completedCount) : null,
			badgeTone: 'muted',
		},
		{
			id: 'list',
			label: 'List',
			badge: String(templateCount),
			badgeTone: 'muted',
		},
	];

	return (
		<div className="flex flex-col gap-6">
			<header>
				<h1 className="text-2xl font-semibold">Trust Documents</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					Resolutions, bills of sale, and other artifacts generated from the trust&rsquo;s
					GL state. Drafted PDFs render in the background; refresh in a moment if a
					new draft shows &ldquo;rendering&rdquo;.
				</p>
			</header>

			<nav className="flex items-center gap-1 border-b border-zinc-200 dark:border-zinc-800">
				{tabs.map((t) => {
					const active = t.id === tab;
					return (
						<Link
							key={t.id}
							href={`/trust-documents?tab=${t.id}`}
							className={`inline-flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
								active
									? 'border-blue-600 text-blue-700 dark:border-blue-400 dark:text-blue-300'
									: 'border-transparent text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
							}`}
							aria-current={active ? 'page' : undefined}
						>
							<span>{t.label}</span>
							{t.badge && (
								<span
									className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium tabular-nums ${
										t.badgeTone === 'flag'
											? active
												? 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200'
												: 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300'
											: active
												? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
												: 'bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400'
									}`}
								>
									{t.badge}
								</span>
							)}
						</Link>
					);
				})}
			</nav>

			{tab === 'suggested' && (<>

			<section>
				<div className="mb-2 flex items-center justify-between">
					<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
						Compliance baseline
					</h2>
					<span
						className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
							baselineMissingCount === 0
								? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
								: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
						}`}
					>
						{baselineMissingCount === 0
							? 'All on file'
							: `${baselineMissingCount} of ${baselineEntries.length} missing`}
					</span>
				</div>
				<div
					className={`grid gap-3 rounded-xl border bg-white p-4 shadow-lg ring-1 ring-zinc-900/5 md:grid-cols-2 lg:grid-cols-4 dark:bg-zinc-900 dark:ring-white/10 ${
						baselineMissingCount === 0
							? 'border-emerald-200 shadow-emerald-200/40 dark:border-emerald-900/40 dark:shadow-emerald-900/30'
							: 'border-amber-200 shadow-amber-200/40 dark:border-amber-900/40 dark:shadow-amber-900/30'
					}`}
				>
					{baselineEntries.map((e) => {
						const onFile = e.stats.count > 0;
						return (
							<Link
								key={e.id}
								href={onFile ? `/trust-documents?focus=${e.id}` : `/trust-documents/new?template=${e.id}`}
								className={`flex flex-col gap-1 rounded-lg border p-3 transition-colors ${
									onFile
										? 'border-emerald-300 bg-emerald-50/60 hover:bg-emerald-50 dark:border-emerald-900/50 dark:bg-emerald-950/30 dark:hover:bg-emerald-950/50'
										: 'border-amber-300 bg-amber-50/60 hover:bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30 dark:hover:bg-amber-950/50'
								}`}
							>
								<div className="flex items-center justify-between">
									<span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
										{e.label}
									</span>
									<span className={`text-xs font-medium ${onFile ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-300'}`}>
										{onFile ? '✓' : '!'}
									</span>
								</div>
								<span className="text-xs text-zinc-500 dark:text-zinc-400">
									{onFile
										? `${e.stats.count} on file${e.stats.lastDraftedAt ? ` · last ${e.stats.lastDraftedAt.slice(0, 10)}` : ''}`
										: 'Not yet drafted — click to draft'}
								</span>
							</Link>
						);
					})}
				</div>
			</section>

			{activityGaps.length === 0 && baselineMissingCount === 0 && (
				<section className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-6 text-center text-sm text-emerald-800 dark:border-emerald-900/40 dark:bg-emerald-950/20 dark:text-emerald-200">
					Nothing flagged — baseline complete and no activity-based gaps detected.
				</section>
			)}

			{activityGaps.length > 0 && (
				<section>
					<div className="mb-2 flex items-center justify-between">
						<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
							Activity-based gaps
						</h2>
						<span className="inline-flex items-center rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium uppercase tracking-wide text-orange-800 dark:bg-orange-900/40 dark:text-orange-200">
							{totalGapItems} item{totalGapItems === 1 ? '' : 's'} flagged
						</span>
					</div>
					<div className="flex flex-col gap-3">
						{activityGaps.map((gap) => {
							const sevBorder =
								gap.severity === 'high' ? 'border-orange-200 bg-orange-50/40 dark:border-orange-900/40 dark:bg-orange-950/20'
								: gap.severity === 'medium' ? 'border-amber-200 bg-amber-50/40 dark:border-amber-900/40 dark:bg-amber-950/20'
								: 'border-sky-200 bg-sky-50/40 dark:border-sky-900/40 dark:bg-sky-950/20';
							const sevPill =
								gap.severity === 'high' ? 'bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200'
								: gap.severity === 'medium' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
								: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200';
							const sevLabel =
								gap.severity === 'high' ? 'High priority'
								: gap.severity === 'medium' ? 'Recommended'
								: 'Informational';
							return (
								<div key={gap.key} className={`rounded-xl border p-4 ${sevBorder}`}>
									<div className="mb-2 flex items-start justify-between gap-3">
										<div className="min-w-0 flex-1">
											<div className="flex items-center gap-2">
												<span className="font-semibold text-zinc-900 dark:text-zinc-100">
													{gap.title}
												</span>
												<span className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${sevPill}`}>
													{sevLabel}
												</span>
											</div>
											<p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
												{gap.description}
											</p>
										</div>
										<span className="shrink-0 text-xs font-medium text-zinc-500">
											{gap.items.length} flagged
										</span>
									</div>
									<ul className="flex flex-wrap gap-2">
										{gap.items.map((item) => (
											<li key={item.id}>
												<Link
													href={item.deepLink}
													className="inline-flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2.5 py-1 text-xs font-medium text-zinc-800 hover:border-zinc-400 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:border-zinc-600 dark:hover:bg-zinc-800"
													title={`Draft prefilled from ${item.label}`}
												>
													<span className="truncate" style={{ maxWidth: '20ch' }}>
														{item.label}
													</span>
													<span className="text-zinc-400">→ Draft</span>
												</Link>
											</li>
										))}
									</ul>
								</div>
							);
						})}
					</div>
				</section>
			)}

			</>)}

			{tab === 'list' && (
			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Draft a new resolution
				</h2>
				<div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
					{Array.from(templatesByCategory.entries()).map(([cat, items]) => (
						<div
							key={cat}
							className="rounded-xl border border-zinc-300 bg-white p-4 shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 transition-all hover:shadow-blue-500/60 hover:ring-2 hover:ring-blue-500/70 dark:border-zinc-700 dark:bg-zinc-900 dark:shadow-black/60 dark:ring-white/10"
						>
							<div className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
								{CATEGORY_LABELS[cat]}
							</div>
							<ul className="flex flex-col gap-1.5 text-sm">
								{items.map((t) => {
									const s = statsByTemplate.get(t.id);
									const n = s?.count ?? 0;
									const last = s?.lastDraftedAt ?? null;
									return (
										<li key={t.id}>
											<div className="flex items-baseline justify-between gap-2">
												<Link
													href={`/trust-documents/new?template=${t.id}`}
													className="font-medium text-blue-600 hover:underline dark:text-blue-400"
												>
													{t.label}
												</Link>
												{n > 0 ? (
													<span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-300">
														{n} · {last ? last.slice(0, 10) : ''}
													</span>
												) : (
													<span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
														none yet
													</span>
												)}
											</div>
											<div className="text-xs text-zinc-500 dark:text-zinc-400">
												{t.description}
											</div>
										</li>
									);
								})}
							</ul>
						</div>
					))}
				</div>
			</section>
			)}

			{tab === 'completed' && (
			<section>
				<h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
					Recent documents
				</h2>
				{rows.length === 0 ? (
					<div className="rounded-lg border border-zinc-200 bg-white p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950">
						No documents yet. Drafts you create from the catalog above will appear here.
					</div>
				) : (
					<div className="overflow-hidden rounded-xl border border-zinc-300 bg-white shadow-lg shadow-zinc-300/60 ring-1 ring-zinc-900/5 dark:border-zinc-700 dark:bg-zinc-900">
						<table className="w-full text-sm">
							<thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
								<tr>
									<th className="px-4 py-2 font-medium">Type</th>
									<th className="px-4 py-2 font-medium">Status</th>
									<th className="px-4 py-2 font-medium">Signers</th>
									<th className="px-4 py-2 font-medium">Created</th>
									<th className="px-4 py-2 text-right font-medium">
										<span className="sr-only">Open</span>
									</th>
								</tr>
							</thead>
							<tbody>
								{rows.map((r) => {
									const signers = (r.signers ?? []) as Signer[];
									const signedN = signers.filter((s) => !!s.signedAt).length;
									const tmpl = templates.find((t) => t.id === r.templateId);
									return (
										<tr key={r.id} className="border-t border-zinc-100 dark:border-zinc-800">
											<td className="px-4 py-2 align-top">
												<div className="font-medium">{tmpl?.label ?? r.templateId}</div>
												<div className="font-mono text-xs text-zinc-500">{r.id.slice(0, 8)}</div>
											</td>
											<td className="px-4 py-2 align-top">
												<span
													className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium uppercase tracking-wide ${
														STATUS_PALETTE[r.status] ?? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
													}`}
												>
													{r.status}
												</span>
											</td>
											<td className="px-4 py-2 align-top text-xs text-zinc-700 dark:text-zinc-300">
												{signedN} / {signers.length} signed
											</td>
											<td className="px-4 py-2 align-top text-xs text-zinc-700 dark:text-zinc-300">
												{r.createdAt.slice(0, 10)}
											</td>
											<td className="px-4 py-2 text-right">
												<div className="flex items-center justify-end gap-2">
													<Link
														href={`/trust-documents/${r.id}`}
														className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800"
													>
														Open
													</Link>
													<InlineDeleteButton documentRecordId={r.id} signedCount={signedN} />
												</div>
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
			</section>
			)}
		</div>
	);
}
