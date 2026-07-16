'use server';

import { randomUUID } from 'crypto';
import { and, eq, inArray } from 'drizzle-orm';
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

const Schema = z.object({
	displayName: z.string().min(1).max(120),
	lenderContactId: z.string().min(1).optional().or(z.literal('')),
	noteDocumentUrl: z.string().max(500).optional().or(z.literal('')),
	originalPrincipal: z.coerce.number().positive(),
	// APR comes off the form as a percent string ("6.25") and is normalized
	// to a decimal (0.0625) before persistence.
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

export interface CreateLoanState {
	error?: string;
}

/**
 * Create a loan and persist its full amortization schedule in one tx.
 * Validates the picked accounts belong to the org (defense against a
 * tampered form post) and that the lender contact, if supplied, also
 * belongs to the org.
 */
export async function createLoan(
	_prev: CreateLoanState | undefined,
	formData: FormData,
): Promise<CreateLoanState | undefined> {
	await requireSession();
	const orgId = await getCurrentOrgId();

	const parsed = Schema.safeParse({
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
	const apr = data.aprPercent / 100;

	// Authorize: both accounts must belong to this org. Single round-trip
	// for both IDs.
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

	// Authorize: lender contact, if supplied, must belong to this org.
	if (data.lenderContactId) {
		const [c] = await db
			.select({ id: contacts.id })
			.from(contacts)
			.where(and(eq(contacts.id, data.lenderContactId), eq(contacts.organizationId, orgId)))
			.limit(1);
		if (!c) return { error: 'Lender contact not in this organization' };
	}

	// Authorize: collateral asset, if supplied, must belong to this org
	// and not be disposed (linking to a disposed asset doesn't make sense).
	if (data.collateralAssetId) {
		const [a] = await db
			.select({ id: fixedAssets.id, status: fixedAssets.status })
			.from(fixedAssets)
			.where(and(eq(fixedAssets.id, data.collateralAssetId), eq(fixedAssets.organizationId, orgId)))
			.limit(1);
		if (!a) return { error: 'Collateral asset not in this organization' };
		if (a.status === 'disposed') return { error: 'Cannot link a loan to a disposed asset' };
	}

	// Generate the schedule before opening the tx so a bad input fails
	// fast without holding a write lock.
	let schedule;
	try {
		schedule = generateSchedule({
			originalPrincipal: data.originalPrincipal,
			apr,
			termMonths: data.termMonths,
			firstPaymentDate: data.firstPaymentDate,
			paymentAmount: typeof data.paymentAmount === 'number' ? data.paymentAmount : undefined,
		});
	} catch (err) {
		return { error: err instanceof Error ? err.message : 'Schedule generation failed' };
	}

	const loanId = randomUUID();

	await db.transaction(async (tx) => {
		await tx.insert(loans).values({
			id: loanId,
			organizationId: orgId,
			liabilityAccountId: data.liabilityAccountId,
			interestExpenseAccountId: data.interestExpenseAccountId,
			lenderContactId: data.lenderContactId || null,
			displayName: data.displayName.trim(),
			originalPrincipal: String(data.originalPrincipal),
			currentPrincipal: String(data.originalPrincipal),
			annualInterestRate: String(apr),
			termMonths: data.termMonths,
			paymentAmount: String(schedule.paymentAmount),
			firstPaymentDate: data.firstPaymentDate,
			startDate: data.startDate,
			status: 'active',
			noteDocumentUrl: data.noteDocumentUrl || null,
			collateralAssetId: data.collateralAssetId || null,
		});

		await tx.insert(loanAmortizationSchedules).values(
			schedule.rows.map((r) => ({
				id: randomUUID(),
				loanId,
				paymentNumber: r.paymentNumber,
				dueDate: r.dueDate,
				principalAmount: String(r.principalAmount),
				interestAmount: String(r.interestAmount),
				remainingBalance: String(r.remainingBalance),
			})),
		);
	});

	revalidatePath('/loans');
	redirect(`/loans/${loanId}`);
}
