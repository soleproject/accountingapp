'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { db } from '@/db/client';
import {
	chartOfAccounts,
	contacts,
	fixedAssets,
	loanAmortizationSchedules,
	loans,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { requireSession } from '@/lib/auth/session';
import { generateSchedule } from '@/lib/loans/generate-schedule';
import { syncLoanWithGL } from '@/lib/loans/sync';

const Schema = z.object({
	loanId: z.string().min(1),
	displayName: z.string().min(1).max(120),
	lenderContactId: z.string().min(1).optional().or(z.literal('')),
	noteDocumentUrl: z.string().max(500).optional().or(z.literal('')),
	originalPrincipal: z.coerce.number().positive(),
	aprPercent: z.coerce.number().min(0).max(100),
	termMonths: z.coerce.number().int().min(1).max(720),
	startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	firstPaymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
	paymentAmount: z.coerce.number().positive().optional().or(z.literal('')),
	liabilityAccountId: z.string().min(1),
	interestExpenseAccountId: z.string().min(1),
	collateralAssetId: z.string().optional().or(z.literal('')),
	notes: z.string().max(2000).optional().or(z.literal('')),
});

export interface UpdateLoanState {
	error?: string;
	/** When true, the action regenerated the schedule and the user needs
	 *  to walk the rebuild review (per-row accept/redo/reverse). Set when
	 *  terms changed AND payments were posted. */
	rebuildPending?: boolean;
}

/**
 * Edit a loan. Identity-only edits (name, lender, agreement URL, notes)
 * just patch the row. Term/accounting edits regenerate the schedule;
 * when there are posted payments the new schedule is staged with each
 * posted JE re-mapped to its new row by payment_number (with a
 * due_date fallback within ±7 days), and the user is redirected to a
 * review page to accept / re-record / reverse each one.
 *
 * Always runs syncLoanWithGL first so the postedCount we branch on
 * matches what the GL actually says.
 */
export async function updateLoan(
	_prev: UpdateLoanState | undefined,
	formData: FormData,
): Promise<UpdateLoanState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
		loanId: formData.get('loanId'),
		displayName: formData.get('displayName'),
		lenderContactId: formData.get('lenderContactId') || '',
		noteDocumentUrl: formData.get('noteDocumentUrl') || '',
		originalPrincipal: formData.get('originalPrincipal'),
		aprPercent: formData.get('aprPercent'),
		termMonths: formData.get('termMonths'),
		startDate: formData.get('startDate'),
		firstPaymentDate: formData.get('firstPaymentDate'),
		paymentAmount: formData.get('paymentAmount') || '',
		liabilityAccountId: formData.get('liabilityAccountId'),
		interestExpenseAccountId: formData.get('interestExpenseAccountId'),
		collateralAssetId: formData.get('collateralAssetId') || '',
		notes: formData.get('notes') || '',
	});
	if (!parsed.success) {
		return { error: parsed.error.issues[0]?.message ?? 'Invalid input' };
	}
	const data = parsed.data;
	const newApr = data.aprPercent / 100;

	await syncLoanWithGL({ orgId, loanId: data.loanId });

	const [existing] = await db
		.select({
			id: loans.id,
			organizationId: loans.organizationId,
			displayName: loans.displayName,
			lenderContactId: loans.lenderContactId,
			noteDocumentUrl: loans.noteDocumentUrl,
			originalPrincipal: loans.originalPrincipal,
			annualInterestRate: loans.annualInterestRate,
			termMonths: loans.termMonths,
			startDate: loans.startDate,
			firstPaymentDate: loans.firstPaymentDate,
			paymentAmount: loans.paymentAmount,
			liabilityAccountId: loans.liabilityAccountId,
			interestExpenseAccountId: loans.interestExpenseAccountId,
		})
		.from(loans)
		.where(and(eq(loans.id, data.loanId), eq(loans.organizationId, orgId)))
		.limit(1);
	if (!existing) return { error: 'Loan not found' };

	// Authorize: both accounts must belong to this org.
	const acctRows = await db
		.select({ id: chartOfAccounts.id })
		.from(chartOfAccounts)
		.where(
			and(
				eq(chartOfAccounts.organizationId, orgId),
				inArray(chartOfAccounts.id, [data.liabilityAccountId, data.interestExpenseAccountId]),
			),
		);
	const orgAccountIds = new Set(acctRows.map((r) => r.id));
	if (!orgAccountIds.has(data.liabilityAccountId)) {
		return { error: 'Liability account not in this organization' };
	}
	if (!orgAccountIds.has(data.interestExpenseAccountId)) {
		return { error: 'Interest expense account not in this organization' };
	}
	if (data.lenderContactId) {
		const [c] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(and(eq(contacts.id, data.lenderContactId), eq(contacts.organizationId, orgId)))
			.limit(1);
		if (!c) return { error: 'Lender contact not in this organization' };
	}
	if (data.collateralAssetId) {
		const [a] = await db
			.select({ id: fixedAssets.id, status: fixedAssets.status })
			.from(fixedAssets)
			.where(and(eq(fixedAssets.id, data.collateralAssetId), eq(fixedAssets.organizationId, orgId)))
			.limit(1);
		if (!a) return { error: 'Collateral asset not in this organization' };
		if (a.status === 'disposed') return { error: 'Cannot link a loan to a disposed asset' };
	}

	const termsChanged =
		Number(existing.originalPrincipal) !== data.originalPrincipal
		|| Number(existing.annualInterestRate) !== newApr
		|| existing.termMonths !== data.termMonths
		|| existing.startDate !== data.startDate
		|| existing.firstPaymentDate !== data.firstPaymentDate
		|| (existing.paymentAmount !== null && existing.paymentAmount !== undefined
			? Math.abs(Number(existing.paymentAmount) - (typeof data.paymentAmount === 'number' ? data.paymentAmount : 0)) > 0.005
			: typeof data.paymentAmount === 'number');
	const accountsChanged =
		existing.liabilityAccountId !== data.liabilityAccountId
		|| existing.interestExpenseAccountId !== data.interestExpenseAccountId;

	// Posted-row count (after sync, so it reflects reality).
	const postedRows = await db
		.select({
			id: loanAmortizationSchedules.id,
			paymentNumber: loanAmortizationSchedules.paymentNumber,
			dueDate: loanAmortizationSchedules.dueDate,
			postedJournalEntryId: loanAmortizationSchedules.postedJournalEntryId,
		})
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, data.loanId),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		);
	const postedCount = postedRows.length;

	// Shortening the term below the posted count would orphan some
	// posted JEs (no new schedule row to map them onto). Force the user
	// to reverse the excess payments first, since "what happens to those
	// JEs?" is too ambiguous to auto-resolve.
	if (postedCount > 0 && data.termMonths < postedCount) {
		return {
			error: `Cannot shorten term to ${data.termMonths} months — ${postedCount} payment(s) are already posted. Reverse the extra payments first, then try again.`,
		};
	}

	const identityUpdate: Record<string, unknown> = {
		displayName: data.displayName.trim(),
		lenderContactId: data.lenderContactId || null,
		noteDocumentUrl: data.noteDocumentUrl || null,
		collateralAssetId: data.collateralAssetId || null,
		updatedAt: new Date().toISOString(),
	};

	if (!termsChanged && !accountsChanged) {
		// Identity-only edit. One round-trip, no schedule touch.
		await db.update(loans).set(identityUpdate).where(eq(loans.id, data.loanId));
		revalidatePath('/loans');
		revalidatePath(`/loans/${data.loanId}`);
		redirect(`/loans/${data.loanId}`);
	}

	// Regenerate the schedule from the new terms.
	let schedule;
	try {
		schedule = generateSchedule({
			originalPrincipal: data.originalPrincipal,
			apr: newApr,
			termMonths: data.termMonths,
			firstPaymentDate: data.firstPaymentDate,
			paymentAmount: typeof data.paymentAmount === 'number' ? data.paymentAmount : undefined,
		});
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'Schedule generation failed' };
	}

	await db.transaction(async (tx) => {
		// Replace the schedule. Posted rows are about to be re-mapped onto
		// the new schedule by payment_number; their JE linkage rides along.
		// Match by payment_number first, due_date fallback (±7 days).
		const newRowsByNumber = new Map(schedule.rows.map((r) => [r.paymentNumber, r]));
		const remapped: Array<{ newId: string; postedJournalEntryId: string }> = [];

		// Drop old schedule rows. CASCADE doesn't apply (FK is on loan_id,
		// not row id) so this delete is the explicit reset.
		await tx
			.delete(loanAmortizationSchedules)
			.where(eq(loanAmortizationSchedules.loanId, data.loanId));

		// Insert new rows; remember which new id corresponds to each
		// payment_number so we can re-stamp the JE linkage in the next step.
		const newIdByNumber = new Map<number, string>();
		const newDueByNumber = new Map<number, string>();
		const insertRows = schedule.rows.map((r) => {
			const id = randomUUID();
			newIdByNumber.set(r.paymentNumber, id);
			newDueByNumber.set(r.paymentNumber, r.dueDate);
			return {
				id,
				loanId: data.loanId,
				paymentNumber: r.paymentNumber,
				dueDate: r.dueDate,
				principalAmount: String(r.principalAmount),
				interestAmount: String(r.interestAmount),
				remainingBalance: String(r.remainingBalance),
			};
		});
		if (insertRows.length > 0) {
			await tx.insert(loanAmortizationSchedules).values(insertRows);
		}

		// Re-map posted JEs onto the new schedule.
		for (const oldPosted of postedRows) {
			if (!oldPosted.postedJournalEntryId) continue;

			// Match by payment_number first.
			let newId = newIdByNumber.get(oldPosted.paymentNumber);

			// Fall back to closest dueDate within ±7 days.
			if (!newId) {
				const oldDue = oldPosted.dueDate;
				let bestNumber: number | null = null;
				let bestDelta = Infinity;
				for (const [num, due] of newDueByNumber) {
					const delta = Math.abs(daysBetween(due, oldDue));
					if (delta <= 7 && delta < bestDelta) {
						bestDelta = delta;
						bestNumber = num;
					}
				}
				if (bestNumber !== null) newId = newIdByNumber.get(bestNumber);
			}

			if (newId) {
				remapped.push({ newId, postedJournalEntryId: oldPosted.postedJournalEntryId });
			}
			// Orphans (no match): JE stays unlinked. The rebuild review page
			// surfaces them so the user can decide whether to reverse.
		}

		// Restamp the linkage on the matched new rows.
		for (const m of remapped) {
			await tx
				.update(loanAmortizationSchedules)
				.set({
					postedJournalEntryId: m.postedJournalEntryId,
					postedAt: new Date().toISOString(),
				})
				.where(eq(loanAmortizationSchedules.id, m.newId));
		}

		// Header update + current_principal recomputed from posted rows.
		// For identity+terms case, this updates everything in one shot.
		const currentPrincipal = await recomputeCurrentPrincipal(
			tx,
			data.loanId,
			data.originalPrincipal,
		);
		await tx
			.update(loans)
			.set({
				...identityUpdate,
				originalPrincipal: String(data.originalPrincipal),
				annualInterestRate: String(newApr),
				termMonths: data.termMonths,
				paymentAmount: String(schedule.paymentAmount),
				firstPaymentDate: data.firstPaymentDate,
				startDate: data.startDate,
				liabilityAccountId: data.liabilityAccountId,
				interestExpenseAccountId: data.interestExpenseAccountId,
				currentPrincipal: String(currentPrincipal),
			})
			.where(eq(loans.id, data.loanId));
	});

	revalidatePath('/loans');
	revalidatePath(`/loans/${data.loanId}`);

	if (postedCount > 0) {
		// Term change with posted payments → walk the rebuild review page.
		redirect(`/loans/${data.loanId}/rebuild`);
	}
	redirect(`/loans/${data.loanId}`);
}

async function recomputeCurrentPrincipal(
	tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
	loanId: string,
	originalPrincipal: number,
): Promise<number> {
	// Sum of principal on rows whose JE is still posted.
	const rows = await tx
		.select({
			principalAmount: loanAmortizationSchedules.principalAmount,
		})
		.from(loanAmortizationSchedules)
		.where(
			and(
				eq(loanAmortizationSchedules.loanId, loanId),
				isNotNull(loanAmortizationSchedules.postedJournalEntryId),
			),
		);
	const paid = rows.reduce((acc, r) => acc + Number(r.principalAmount ?? 0), 0);
	return Math.max(0, Math.round((originalPrincipal - paid) * 100) / 100);
}

function daysBetween(a: string, b: string): number {
	const [ay, am, ad] = a.split('-').map(Number);
	const [by, bm, bd] = b.split('-').map(Number);
	const dt1 = Date.UTC(ay, am - 1, ad);
	const dt2 = Date.UTC(by, bm - 1, bd);
	return Math.round((dt1 - dt2) / 86400000);
}
