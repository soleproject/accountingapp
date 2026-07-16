'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { eq, and, inArray, isNotNull } from 'drizzle-orm';
import { db } from '@/db/client';
import {
  chartOfAccounts,
  contacts,
  journalEntries,
  journalEntryLines,
  trustReviewFindings,
} from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { evaluateBeneficialTrustJournalEntry } from '@/lib/accounting/rules/beneficial-trust';

const Schema = z.object({
  id: z.string().min(1),
  contactName: z.string().min(1).max(200),
  companyName: z.string().max(200).optional(),
  email: z.email().optional().or(z.literal('')),
  phone: z.string().max(50).optional(),
  typeTags: z.array(z.string()).default([]),
  isActive: z.boolean().default(true),
  taxId: z.string().max(40).optional(),
  w9Status: z.enum(['not_requested', 'requested', 'on_file']).default('not_requested'),
  is1099Eligible: z.boolean().default(false),
});

export interface UpdateContactState { error?: string; ok?: boolean }

export async function updateContact(
  _prev: UpdateContactState | undefined,
  formData: FormData,
): Promise<UpdateContactState | undefined> {
  const orgId = await getCurrentOrgId();

  const tags: string[] = [];
  if (formData.get('isCustomer') === 'on') tags.push('customer');
  if (formData.get('isVendor') === 'on') tags.push('vendor');
  if (formData.get('isTrustee') === 'on') tags.push('trustee');

  const parsed = Schema.safeParse({
    id: formData.get('id'),
    contactName: formData.get('contactName'),
    companyName: formData.get('companyName') || undefined,
    email: formData.get('email') || '',
    phone: formData.get('phone') || undefined,
    typeTags: tags,
    // The form's "Active" checkbox is checked by default in edit mode. If
    // the user unchecks it the field is absent from FormData entirely.
    isActive: formData.get('isActive') === 'on',
    taxId: formData.get('taxId') || undefined,
    w9Status: formData.get('w9Status') || 'not_requested',
    is1099Eligible: formData.get('is1099Eligible') === 'on',
  });
  if (!parsed.success) return { error: 'Invalid input — contact name is required' };

  const result = await db
    .update(contacts)
    .set({
      contactName: parsed.data.contactName,
      companyName: parsed.data.companyName ?? null,
      email: parsed.data.email && parsed.data.email !== '' ? parsed.data.email : null,
      phone: parsed.data.phone ?? null,
      typeTags: parsed.data.typeTags,
      isActive: parsed.data.isActive,
      taxId: parsed.data.taxId ?? null,
      w9Status: parsed.data.w9Status,
      is1099Eligible: parsed.data.is1099Eligible,
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(contacts.id, parsed.data.id), eq(contacts.organizationId, orgId)))
    .returning({ id: contacts.id });

  if (result.length === 0) return { error: 'Contact not found in this organization' };

  // Re-evaluate any open 710 findings that named this contact — toggling
  // the trustee tag should clear (or set) TRUST_710_ATTRIBUTION_REQUIRED
  // on existing M&E history without waiting for a backfill cron. Scoped
  // by org + trust-feature so non-trust orgs skip the work.
  const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');
  if (trustEnabled) {
    await reevaluateTenAttributionForContact(orgId, parsed.data.id);
  }

  revalidatePath('/contacts');
  revalidatePath(`/contacts/${parsed.data.id}`);
  revalidatePath('/trust-review');
  redirect('/contacts');
}

/**
 * Walk every JE on this org that has at least one line on a 710 (Meals &
 * Entertainment) account AND at least one line referencing the changed
 * contact. Re-run the trust rule pack against each, preserve dismissed
 * state by (je_id, code), and replace findings. Idempotent.
 *
 * Scoped to TRUST_710_ATTRIBUTION_REQUIRED-relevant JEs only — touching
 * unrelated findings risks losing dismissed marks on rules the trustee
 * tag has nothing to do with.
 */
async function reevaluateTenAttributionForContact(
  orgId: string,
  contactId: string,
): Promise<void> {
  const meAccts = await db
    .select({ id: chartOfAccounts.id })
    .from(chartOfAccounts)
    .where(
      and(
        eq(chartOfAccounts.organizationId, orgId),
        eq(chartOfAccounts.detailType, 'entertainment_meals'),
      ),
    );
  if (meAccts.length === 0) return;
  const meAccountIds = meAccts.map((a) => a.id);

  // Two-step intersection: avoids embedding a raw ANY() against an array
  // param (which Drizzle marshals as a scalar in this template position).
  // Pull the org's JE IDs touching the contact, pull the JE IDs touching
  // a 710 account, intersect.
  const [contactJeRows, meJeRows] = await Promise.all([
    db
      .selectDistinct({ id: journalEntryLines.journalEntryId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.organizationId, orgId),
          eq(journalEntryLines.contactId, contactId),
        ),
      ),
    db
      .selectDistinct({ id: journalEntryLines.journalEntryId })
      .from(journalEntryLines)
      .innerJoin(journalEntries, eq(journalEntries.id, journalEntryLines.journalEntryId))
      .where(
        and(
          eq(journalEntries.organizationId, orgId),
          inArray(journalEntryLines.accountId, meAccountIds),
        ),
      ),
  ]);
  const meJeSet = new Set(meJeRows.map((r) => r.id));
  const candidateJes = contactJeRows.filter((r) => meJeSet.has(r.id));
  if (candidateJes.length === 0) return;

  for (const { id: jeId } of candidateJes) {
    const [je] = await db
      .select({
        id: journalEntries.id,
        date: journalEntries.date,
        memo: journalEntries.memo,
        sourceType: journalEntries.sourceType,
        sourceId: journalEntries.sourceId,
      })
      .from(journalEntries)
      .where(eq(journalEntries.id, jeId))
      .limit(1);
    if (!je) continue;

    const lines = await db
      .select({
        accountId: journalEntryLines.accountId,
        debit: journalEntryLines.debit,
        credit: journalEntryLines.credit,
        contactId: journalEntryLines.contactId,
        memo: journalEntryLines.memo,
        beneficiaryId: journalEntryLines.beneficiaryId,
      })
      .from(journalEntryLines)
      .where(eq(journalEntryLines.journalEntryId, jeId));

    const fresh = await evaluateBeneficialTrustJournalEntry({
      organizationId: orgId,
      date: je.date,
      memo: je.memo,
      sourceType: je.sourceType,
      sourceId: je.sourceId,
      lines: lines.map((l) => ({
        accountId: l.accountId,
        debit: Number(l.debit),
        credit: Number(l.credit),
        contactId: l.contactId,
        memo: l.memo,
        beneficiaryId: l.beneficiaryId ?? null,
      })),
    });

    const nextHasTen = fresh.findings.some(
      (f) => f.code === 'TRUST_710_ATTRIBUTION_REQUIRED',
    );

    await db.transaction(async (tx) => {
      // Preserve dismissed state on this code only.
      const [priorTen] = await tx
        .select({
          dismissedAt: trustReviewFindings.dismissedAt,
          dismissedByUserId: trustReviewFindings.dismissedByUserId,
          dismissedNote: trustReviewFindings.dismissedNote,
        })
        .from(trustReviewFindings)
        .where(
          and(
            eq(trustReviewFindings.journalEntryId, jeId),
            eq(trustReviewFindings.code, 'TRUST_710_ATTRIBUTION_REQUIRED'),
            isNotNull(trustReviewFindings.dismissedAt),
          ),
        )
        .limit(1);

      await tx
        .delete(trustReviewFindings)
        .where(
          and(
            eq(trustReviewFindings.journalEntryId, jeId),
            eq(trustReviewFindings.code, 'TRUST_710_ATTRIBUTION_REQUIRED'),
          ),
        );

      if (nextHasTen) {
        const newF = fresh.findings.find(
          (f) => f.code === 'TRUST_710_ATTRIBUTION_REQUIRED',
        )!;
        await tx.insert(trustReviewFindings).values({
          id: randomUUID(),
          organizationId: orgId,
          journalEntryId: jeId,
          code: newF.code,
          severity: newF.severity,
          message: newF.message,
          metadata: newF.metadata ?? null,
          dismissedAt: priorTen?.dismissedAt ?? null,
          dismissedByUserId: priorTen?.dismissedByUserId ?? null,
          dismissedNote: priorTen?.dismissedNote ?? null,
        });
      }
    });
  }
}
