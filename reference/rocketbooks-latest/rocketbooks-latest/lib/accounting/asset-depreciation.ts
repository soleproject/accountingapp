import 'server-only';

/**
 * Depreciation calculator. v1 supports straight-line; declining-balance
 * and MACRS are stubbed so the run engine can detect "not yet implemented
 * for this method" and skip the asset with a clear reason rather than
 * silently posting zero.
 *
 * All math is in cents (integer) to avoid float drift. Inputs that come
 * in as decimals get rounded at the boundary.
 */

export type DepreciationMethod =
	| 'straight_line'
	| 'declining_balance_150'
	| 'declining_balance_200'
	| 'macrs_gds'
	| 'macrs_ads';

export type DepreciationConvention = 'half_year' | 'mid_month' | 'mid_quarter' | 'full_month';

export interface DepreciationInputs {
	depreciableBasisCents: number;
	salvageValueCents: number;
	usefulLifeMonths: number;
	method: DepreciationMethod;
	convention: DepreciationConvention;
	inServiceDate: string;
	/** Most recent date the asset's accumulated depreciation has already
	 *  been computed through. Null when no prior depreciation has posted
	 *  (fresh asset). */
	accumulatedThroughDate: string | null;
	accumulatedToDateCents: number;
	/** The last day of the period this run is posting. The run computes
	 *  depreciation FROM (accumulatedThroughDate + 1 day or in-service
	 *  date) THROUGH this date. */
	periodEndDate: string;
}

export type DepreciationResult =
	| { ok: true; expenseCents: number; throughDate: string }
	| { ok: false; skipReason: string };

/**
 * Compute the depreciation expense for a single asset in a single run.
 * Returns the cents to post (0 when nothing's due — already current or
 * fully depreciated) plus the new accumulated-through-date, OR a skip
 * reason if the asset can't be processed (unimplemented method, bad
 * date math, etc.).
 */
export function computeDepreciation(input: DepreciationInputs): DepreciationResult {
	if (input.method !== 'straight_line') {
		return {
			ok: false,
			skipReason: `Method '${input.method}' not yet implemented — fall back to manual JE.`,
		};
	}

	if (input.usefulLifeMonths <= 0) {
		return { ok: false, skipReason: 'Useful life must be > 0 months' };
	}

	const totalDepreciable = input.depreciableBasisCents - input.salvageValueCents;
	if (totalDepreciable <= 0) {
		return { ok: false, skipReason: 'Basis equals or is less than salvage' };
	}

	if (input.accumulatedToDateCents >= totalDepreciable) {
		return { ok: false, skipReason: 'Already fully depreciated' };
	}

	// Period boundaries — clamp to the start of the asset's life and the
	// last day of the run period. periodEnd < inServiceDate means the run
	// predates the asset; nothing to do.
	const periodEnd = new Date(input.periodEndDate);
	const inService = new Date(input.inServiceDate);
	if (Number.isNaN(periodEnd.getTime()) || Number.isNaN(inService.getTime())) {
		return { ok: false, skipReason: 'Invalid date input' };
	}
	if (periodEnd < inService) {
		return { ok: false, skipReason: 'Period ends before in-service date' };
	}

	// Convention picks where in the first/last month depreciation starts.
	// For monthly runs we collapse all four conventions to a per-month
	// fraction of the in-service month:
	//   half_year     → 0.5 of in-service year (treated as 0.5 of first
	//                   month for monthly cadence — accepted simplification)
	//   mid_month     → 0.5 of in-service month (correct for real-estate)
	//   mid_quarter   → 0.5 of in-service month within the quarter
	//   full_month    → full month including the in-service month
	// This is precise for full_month and mid_month and a documented
	// simplification for the two annual conventions. Tax-book MACRS
	// requires the full annual convention math; we'll add it when the
	// MACRS calculator lands.
	const firstMonthFactor = input.convention === 'full_month' ? 1 : 0.5;

	// All math stays in CENTS so we never round through float dollars.
	// monthlyFullCents may have a fractional cents tail (e.g. 833.33...)
	// — we round at the end, after summing.
	const monthlyFullCents = totalDepreciable / input.usefulLifeMonths;
	const monthsAlreadyPosted = monthsBetween(
		input.inServiceDate,
		input.accumulatedThroughDate ?? prevDay(input.inServiceDate),
	);
	const totalMonthsThroughPeriod = monthsBetween(input.inServiceDate, input.periodEndDate);
	const newMonths = Math.max(0, totalMonthsThroughPeriod - monthsAlreadyPosted);
	if (newMonths === 0) {
		return { ok: false, skipReason: 'Already current through this period' };
	}

	// Apply the first-month factor only if this run is the one that
	// actually crosses the in-service month. After that, every month is
	// a full month.
	const isFirstPost = input.accumulatedThroughDate === null
		|| new Date(input.accumulatedThroughDate) < inService;
	const factorForFirstMonth = isFirstPost ? firstMonthFactor : 1;
	const fullMonthsInThisRun = newMonths - (isFirstPost ? 1 : 0);

	const rawCents = monthlyFullCents * factorForFirstMonth
		+ monthlyFullCents * fullMonthsInThisRun;

	// Cap at remaining depreciable basis so we don't blow past salvage.
	const remainingCents = totalDepreciable - input.accumulatedToDateCents;
	const expenseCents = Math.min(Math.round(rawCents), remainingCents);

	if (expenseCents <= 0) {
		return { ok: false, skipReason: 'Computed expense is zero or negative' };
	}

	return {
		ok: true,
		expenseCents,
		throughDate: input.periodEndDate,
	};
}

/**
 * Whole-month difference between two ISO dates, inclusive of the end
 * month. Used to count how many monthly periods sit between in-service
 * date and a given period end.
 */
function monthsBetween(startIso: string, endIso: string): number {
	const start = new Date(startIso);
	const end = new Date(endIso);
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return 0;
	if (end < start) return 0;
	const years = end.getUTCFullYear() - start.getUTCFullYear();
	const months = end.getUTCMonth() - start.getUTCMonth();
	let total = years * 12 + months;
	// Inclusive of the in-service month: if both dates are within the
	// same month, that's one month.
	if (end.getUTCDate() >= start.getUTCDate() || (years > 0 || months > 0)) total += 1;
	return Math.max(0, total);
}

function prevDay(iso: string): string {
	const d = new Date(iso);
	d.setUTCDate(d.getUTCDate() - 1);
	return d.toISOString().slice(0, 10);
}
