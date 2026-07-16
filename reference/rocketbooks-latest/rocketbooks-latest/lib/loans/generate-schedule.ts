/**
 * Pure amortization-schedule generator. Given a loan's terms, produce
 * the per-period principal/interest breakdown for the life of the loan.
 *
 * MVP assumptions:
 *   - Monthly compounding (APR ÷ 12 per period).
 *   - 30/360 day-count basis — i.e. every month earns one period of
 *     interest regardless of actual day count. This matches every
 *     consumer/SMB amortizing loan we care about today.
 *   - Fixed rate, fully amortizing (final balance = 0).
 *   - Monthly payment frequency only. Weekly/bi-weekly are deferred.
 *
 * All currency arithmetic happens in integer cents to avoid the float
 * drift that turns a 360-payment schedule into a multi-cent rounding
 * party. The final row's principal absorbs whatever drift the loop
 * accumulated so the closing balance is exactly zero.
 *
 * Caller is responsible for persisting the rows (this function never
 * touches the DB) and for deciding whether to use the supplied
 * `paymentAmount` override or the `computedPaymentAmount` we derive.
 */

export interface GenerateScheduleInput {
	/** Original principal in dollars (e.g. 25000.00). */
	originalPrincipal: number;
	/** APR as a decimal: 0.0625 = 6.25%. */
	apr: number;
	/** Total number of monthly payments. */
	termMonths: number;
	/** First payment date as YYYY-MM-DD. Subsequent dates are +1 calendar month. */
	firstPaymentDate: string;
	/** Optional payment override. If omitted, we compute the standard
	 *  fully-amortizing payment. If supplied, we honor it but may not
	 *  fully amortize (final balance may differ from zero — caller is
	 *  warned via the returned `amortizesCleanly` flag). */
	paymentAmount?: number;
}

export interface ScheduleRow {
	paymentNumber: number;
	dueDate: string;
	principalAmount: number;
	interestAmount: number;
	/** Balance remaining AFTER this payment posts. Last row = 0 when
	 *  amortizesCleanly is true. */
	remainingBalance: number;
}

export interface GenerateScheduleOutput {
	rows: ScheduleRow[];
	/** The payment we used (input override if supplied, otherwise our
	 *  computed standard amortization payment), in dollars. */
	paymentAmount: number;
	/** Our standard amortization payment for reference, in dollars. */
	computedPaymentAmount: number;
	/** False when caller supplied a paymentAmount that doesn't fully
	 *  amortize within the term — i.e. last row's remainingBalance is
	 *  not zero. UI can use this to surface a warning before save. */
	amortizesCleanly: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function addMonthsISO(iso: string, months: number): string {
	const [y, m, d] = iso.split('-').map(Number);
	// Date in UTC to avoid TZ drift on month boundaries.
	const dt = new Date(Date.UTC(y, m - 1 + months, d));
	// Roll-back for short months (e.g. Jan 31 + 1mo → Mar 3 → want Feb 28/29).
	if (dt.getUTCMonth() !== ((m - 1 + months) % 12 + 12) % 12) {
		dt.setUTCDate(0);
	}
	const yy = dt.getUTCFullYear();
	const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
	const dd = String(dt.getUTCDate()).padStart(2, '0');
	return `${yy}-${mm}-${dd}`;
}

function toCents(dollars: number): number {
	return Math.round(dollars * 100);
}

function toDollars(cents: number): number {
	return Math.round(cents) / 100;
}

/**
 * Standard amortization payment formula:
 *   PMT = P · r / (1 - (1 + r)^-n)
 * Where r = monthly rate, n = term in months. Handles the r=0 edge case
 * (interest-free loan → equal-principal payments).
 */
function computeMonthlyPayment(principalCents: number, monthlyRate: number, termMonths: number): number {
	if (monthlyRate === 0) {
		return Math.round(principalCents / termMonths);
	}
	const factor = monthlyRate / (1 - Math.pow(1 + monthlyRate, -termMonths));
	return Math.round(principalCents * factor);
}

export function generateSchedule(input: GenerateScheduleInput): GenerateScheduleOutput {
	if (input.originalPrincipal <= 0) {
		throw new Error('originalPrincipal must be > 0');
	}
	if (input.apr < 0) {
		throw new Error('apr must be >= 0');
	}
	if (input.termMonths < 1) {
		throw new Error('termMonths must be >= 1');
	}
	if (!DATE_RE.test(input.firstPaymentDate)) {
		throw new Error('firstPaymentDate must be YYYY-MM-DD');
	}

	const principalCents = toCents(input.originalPrincipal);
	const monthlyRate = input.apr / 12;

	const computedPaymentCents = computeMonthlyPayment(principalCents, monthlyRate, input.termMonths);
	const paymentCents = input.paymentAmount !== undefined
		? toCents(input.paymentAmount)
		: computedPaymentCents;

	const rows: ScheduleRow[] = [];
	let balanceCents = principalCents;

	for (let i = 1; i <= input.termMonths; i++) {
		// Round per-period interest to whole cents to match how a lender
		// actually computes the bill. Without this, sub-cent fractions
		// compound and the final balance drifts even with cent arithmetic.
		const interestCents = Math.round(balanceCents * monthlyRate);
		let principalThisPeriodCents = paymentCents - interestCents;

		// Last row absorbs whatever drift the loop accumulated. With the
		// standard payment this is usually 0–2¢; with a user-supplied
		// payment it can be larger and we flag via amortizesCleanly below.
		if (i === input.termMonths) {
			principalThisPeriodCents = balanceCents;
		}

		// Guard against over-payment (a too-large user-supplied payment
		// could push principal > remaining balance on the second-to-last
		// row). Cap and stop.
		if (principalThisPeriodCents > balanceCents) {
			principalThisPeriodCents = balanceCents;
		}

		balanceCents -= principalThisPeriodCents;

		rows.push({
			paymentNumber: i,
			dueDate: addMonthsISO(input.firstPaymentDate, i - 1),
			principalAmount: toDollars(principalThisPeriodCents),
			interestAmount: toDollars(interestCents),
			remainingBalance: toDollars(balanceCents),
		});

		if (balanceCents <= 0) break;
	}

	const amortizesCleanly = balanceCents === 0;
	return {
		rows,
		paymentAmount: toDollars(paymentCents),
		computedPaymentAmount: toDollars(computedPaymentCents),
		amortizesCleanly,
	};
}
