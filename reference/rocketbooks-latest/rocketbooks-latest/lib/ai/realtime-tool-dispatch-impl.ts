import 'server-only';
import { z } from 'zod';
import { eq, and, asc, desc, sql, ilike, or, gte, lte, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, chartOfAccounts, transactions, invoices, invoiceLines, bills, billLines, billPayments, billPaymentApplications } from '@/db/schema/schema';
import { findOrCreateContact } from '@/lib/accounting/ensure-contact';
import { saveInvoiceDraft, postInvoiceDraft, cancelInvoiceDraft } from '@/lib/accounting/invoice-draft';
import { categorizeTransaction } from '@/lib/accounting/categorize';
import { resolveAccount } from '@/lib/accounting/resolve-account';
import { resolveContact } from '@/lib/accounting/resolve-contact';
import { logger } from '@/lib/logger';
import {
  getOnboardingStatus,
  setBusinessInfo,
  advanceOnboarding,
  ONBOARDING_PHASES,
} from '@/lib/accounting/onboarding';

const REVENUE_TYPES = ['revenue', 'income', 'other_income'];
const ASSET_TYPES = ['asset', 'current_asset'];

// Categorization tools removed from this list — chat fall-through (lib/ai/tools.ts:default)
// no longer routes to them. The case labels in executeRealtimeTool's switch
// stay alive for direct callers (programmatic / tests).
export const REALTIME_TOOL_NAMES = [
  'lookup_contact',
  'create_contact',
  'list_revenue_accounts',
  'list_accounts',
  'save_invoice_draft',
  'post_invoice',
  'cancel_invoice_draft',
  'query_transactions',
  'query_invoices',
  'query_bills',
  'get_onboarding_status',
  'set_business_info',
  'advance_onboarding',
] as const;

export type RealtimeToolName = (typeof REALTIME_TOOL_NAMES)[number];

export function isRealtimeToolName(name: string): name is RealtimeToolName {
  return (REALTIME_TOOL_NAMES as readonly string[]).includes(name);
}

export async function executeRealtimeTool(
  orgId: string,
  name: string,
  args: Record<string, unknown>,
  turnId?: string,
): Promise<unknown> {
  switch (name) {
    case 'lookup_contact': {
      const q = String(args.name ?? '').trim();
      if (!q) return { matches: [] };
      const rows = await db
        .select({
          id: contacts.id,
          name: contacts.contactName,
          companyName: contacts.companyName,
          email: contacts.email,
          typeTags: contacts.typeTags,
        })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, orgId),
            or(
              ilike(contacts.contactName, `%${q}%`),
              ilike(contacts.companyName, `%${q}%`),
            )!,
          ),
        )
        .limit(8);
      return { matches: rows };
    }

    case 'create_contact': {
      const Schema = z.object({
        name: z.string().min(1),
        role: z.enum(['customer', 'vendor']),
        email: z.string().optional(),
        phone: z.string().optional(),
      });
      const v = Schema.parse(args);
      const id = await findOrCreateContact({
        organizationId: orgId,
        merchantName: v.name,
        type: v.role === 'customer' ? 'deposit' : 'withdrawal',
      });
      return { id, name: v.name, role: v.role };
    }

    case 'list_revenue_accounts': {
      const accounts = await db
        .select({
          id: chartOfAccounts.id,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
          gaapType: chartOfAccounts.gaapType,
        })
        .from(chartOfAccounts)
        .where(and(eq(chartOfAccounts.organizationId, orgId), eq(chartOfAccounts.isActive, true)))
        .orderBy(asc(chartOfAccounts.accountNumber));
      const revenue = accounts.filter((a) => REVENUE_TYPES.includes((a.gaapType ?? '').toLowerCase()));
      const ar = accounts.filter((a) => {
        const t = (a.gaapType ?? '').toLowerCase();
        const n = a.accountName.toLowerCase();
        return ASSET_TYPES.includes(t) && (n.includes('receivable') || n.includes('a/r'));
      });
      const arFallback = ar.length > 0 ? ar : accounts.filter((a) => ASSET_TYPES.includes((a.gaapType ?? '').toLowerCase()));
      return { revenue, ar: arFallback };
    }

    case 'save_invoice_draft': {
      const Schema = z.object({
        draftId: z.string().optional(),
        contactId: z.string().min(1),
        invoiceDate: z.string(),
        dueDate: z.string().optional(),
        invoiceNumber: z.string().optional(),
        memo: z.string().optional(),
        arAccountId: z.string().optional(),
        lines: z
          .array(
            z.object({
              description: z.string().min(1).max(500),
              quantity: z.number().positive(),
              unitPrice: z.number().nonnegative(),
              revenueAccountId: z.string().min(1),
            }),
          )
          .min(1),
      });
      const v = Schema.parse(args);
      return await saveInvoiceDraft({ ...v, organizationId: orgId });
    }

    case 'post_invoice': {
      const draftId = String(args.draftId ?? '');
      if (!draftId) throw new Error('draftId required');
      return await postInvoiceDraft({ organizationId: orgId, draftId });
    }

    case 'cancel_invoice_draft': {
      const draftId = String(args.draftId ?? '');
      if (!draftId) throw new Error('draftId required');
      return await cancelInvoiceDraft({ organizationId: orgId, draftId });
    }

    case 'query_transactions': {
      const Schema = z.object({
        from: z.string().optional(),
        to: z.string().optional(),
        contactId: z.string().optional(),
        contactName: z.string().optional(),
        type: z.enum(['deposit', 'withdrawal']).optional(),
        minAmount: z.number().optional(),
        maxAmount: z.number().optional(),
        accountName: z.string().optional(),
        onlyUnreviewed: z.boolean().optional(),
        uncategorizedOnly: z.boolean().optional(),
        searchText: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        sort: z.enum(['date_desc', 'date_asc', 'amount_desc', 'amount_asc']).optional(),
      });
      const v = Schema.parse(args);
      const limit = v.limit ?? 50;

      const conds = [eq(transactions.organizationId, orgId)];
      if (v.from) conds.push(gte(transactions.date, v.from));
      if (v.to) conds.push(lte(transactions.date, v.to));
      if (v.contactId) conds.push(eq(transactions.contactId, v.contactId));
      if (v.type) conds.push(eq(transactions.type, v.type));
      if (typeof v.minAmount === 'number') conds.push(gte(transactions.amount, v.minAmount));
      if (typeof v.maxAmount === 'number') conds.push(lte(transactions.amount, v.maxAmount));
      if (v.onlyUnreviewed) conds.push(eq(transactions.reviewed, false));
      if (v.uncategorizedOnly) conds.push(sql`${transactions.categoryAccountId} IS NULL`);

      if (!v.contactId && v.contactName) {
        const matched = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, orgId),
              or(
                ilike(contacts.contactName, `%${v.contactName}%`),
                ilike(contacts.companyName, `%${v.contactName}%`),
              )!,
            ),
          );
        if (matched.length === 0) {
          return { count: 0, totalAmount: 0, rows: [], filters: v, note: `No contact matched "${v.contactName}"` };
        }
        conds.push(inArray(transactions.contactId, matched.map((m) => m.id)));
      }

      if (v.accountName) {
        const matchedAccts = await db
          .select({ id: chartOfAccounts.id })
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.organizationId, orgId),
              ilike(chartOfAccounts.accountName, `%${v.accountName}%`),
            ),
          );
        if (matchedAccts.length === 0) {
          return { count: 0, totalAmount: 0, rows: [], filters: v, note: `No account matched "${v.accountName}"` };
        }
        conds.push(inArray(transactions.categoryAccountId, matchedAccts.map((a) => a.id)));
      }

      if (v.searchText) {
        conds.push(
          or(
            ilike(transactions.description, `%${v.searchText}%`),
            ilike(transactions.bankDescription, `%${v.searchText}%`),
          )!,
        );
      }

      // Secondary sort on transactions.id makes ordering deterministic across
      // ties (same-date transactions). categorize_contact_uncategorized_subset
      // relies on this so its index→UUID resolution matches what the AI saw.
      const orderBy =
        v.sort === 'date_asc' ? [asc(transactions.date), asc(transactions.id)] :
        v.sort === 'amount_desc' ? [desc(transactions.amount), asc(transactions.id)] :
        v.sort === 'amount_asc' ? [asc(transactions.amount), asc(transactions.id)] :
        [desc(transactions.date), asc(transactions.id)];

      const rows = await db
        .select({
          id: transactions.id,
          date: transactions.date,
          description: transactions.description,
          bankDescription: transactions.bankDescription,
          amount: transactions.amount,
          type: transactions.type,
          reviewed: transactions.reviewed,
          contactName: contacts.contactName,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
        })
        .from(transactions)
        .leftJoin(contacts, eq(transactions.contactId, contacts.id))
        .leftJoin(chartOfAccounts, eq(transactions.categoryAccountId, chartOfAccounts.id))
        .where(and(...conds))
        .orderBy(...orderBy)
        .limit(limit);

      const [agg] = await db
        .select({
          n: sql<string>`COUNT(*)`.as('n'),
          total: sql<string>`COALESCE(SUM(ABS(${transactions.amount})), 0)`.as('total'),
        })
        .from(transactions)
        .where(and(...conds));

      return {
        filters: v,
        count: Number(agg?.n ?? 0),
        totalAmount: Number(agg?.total ?? 0),
        truncated: Number(agg?.n ?? 0) > limit,
        rows: rows.map((r) => ({
          id: r.id,
          date: r.date,
          description: r.description ?? r.bankDescription ?? '',
          type: r.type,
          amount: Number(r.amount ?? 0),
          reviewed: r.reviewed ?? false,
          contactName: r.contactName,
          accountLabel: r.accountNumber && r.accountName ? `${r.accountNumber} · ${r.accountName}` : null,
        })),
      };
    }

    case 'query_invoices': {
      const Schema = z.object({
        status: z.enum(['all', 'overdue', 'outstanding', 'paid', 'draft', 'sent']).optional(),
        customerId: z.string().optional(),
        customerName: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        sort: z.enum(['date_desc', 'date_asc', 'due_asc', 'due_desc', 'amount_desc', 'amount_asc']).optional(),
      });
      const v = Schema.parse(args);
      const limit = v.limit ?? 50;
      const status = v.status ?? 'all';
      const today = new Date().toISOString().slice(0, 10);

      const conds = [eq(invoices.organizationId, orgId)];
      if (v.from) conds.push(gte(invoices.invoiceDate, v.from));
      if (v.to) conds.push(lte(invoices.invoiceDate, v.to));
      if (v.customerId) conds.push(eq(invoices.contactId, v.customerId));
      if (status === 'overdue') {
        conds.push(sql`${invoices.status} <> 'paid'`);
        conds.push(sql`${invoices.dueDate} < ${today}`);
      } else if (status === 'outstanding') {
        conds.push(sql`${invoices.status} <> 'paid'`);
      } else if (status === 'paid') {
        conds.push(eq(invoices.status, 'paid'));
      } else if (status === 'draft') {
        conds.push(eq(invoices.status, 'draft'));
      } else if (status === 'sent') {
        conds.push(eq(invoices.status, 'sent'));
      }

      if (!v.customerId && v.customerName) {
        const matched = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, orgId),
              or(
                ilike(contacts.contactName, `%${v.customerName}%`),
                ilike(contacts.companyName, `%${v.customerName}%`),
              )!,
            ),
          );
        if (matched.length === 0) {
          return {
            filters: { ...v, status },
            count: 0,
            totalAmount: 0,
            rows: [],
            note: `No customer matched "${v.customerName}"`,
          };
        }
        conds.push(inArray(invoices.contactId, matched.map((m) => m.id)));
      }

      // Sum each invoice's amount via invoice_lines.
      const lineTotal = db.$with('line_totals').as(
        db
          .select({
            invoiceId: invoiceLines.invoiceId,
            amount: sql<number>`coalesce(sum(${invoiceLines.amount}), 0)::float`.as('amount'),
          })
          .from(invoiceLines)
          .groupBy(invoiceLines.invoiceId),
      );

      const orderBy =
        v.sort === 'date_asc' ? [asc(invoices.invoiceDate), asc(invoices.id)] :
        v.sort === 'due_asc' ? [asc(invoices.dueDate), asc(invoices.id)] :
        v.sort === 'due_desc' ? [desc(invoices.dueDate), asc(invoices.id)] :
        v.sort === 'amount_desc' ? [desc(sql`coalesce(line_totals.amount, 0)`), asc(invoices.id)] :
        v.sort === 'amount_asc' ? [asc(sql`coalesce(line_totals.amount, 0)`), asc(invoices.id)] :
        [desc(invoices.invoiceDate), asc(invoices.id)];

      const rows = await db
        .with(lineTotal)
        .select({
          id: invoices.id,
          invoiceNumber: invoices.invoiceNumber,
          invoiceDate: invoices.invoiceDate,
          dueDate: invoices.dueDate,
          status: invoices.status,
          contactName: contacts.contactName,
          companyName: contacts.companyName,
          amount: sql<number>`coalesce(${lineTotal.amount}, 0)::float`,
        })
        .from(invoices)
        .leftJoin(contacts, eq(contacts.id, invoices.contactId))
        .leftJoin(lineTotal, eq(lineTotal.invoiceId, invoices.id))
        .where(and(...conds))
        .orderBy(...orderBy)
        .limit(limit);

      const totalAmount = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);

      return {
        filters: { ...v, status },
        count: rows.length,
        totalAmount,
        truncated: rows.length === limit,
        rows: rows.map((r) => {
          const customer = r.contactName ?? r.companyName ?? '—';
          const daysOverdue = r.dueDate && r.status !== 'paid'
            ? Math.max(0, Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86_400_000))
            : 0;
          return {
            id: r.id,
            invoiceNumber: r.invoiceNumber ?? '—',
            invoiceDate: r.invoiceDate,
            dueDate: r.dueDate ?? null,
            status: r.status,
            customer,
            amount: Number(r.amount ?? 0),
            daysOverdue,
          };
        }),
      };
    }

    case 'query_bills': {
      const Schema = z.object({
        status: z.enum(['all', 'overdue', 'outstanding', 'paid']).optional(),
        vendorId: z.string().optional(),
        vendorName: z.string().optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        sort: z.enum(['date_desc', 'date_asc', 'due_asc', 'due_desc', 'amount_desc', 'amount_asc']).optional(),
      });
      const v = Schema.parse(args);
      const limit = v.limit ?? 50;
      const status = v.status ?? 'all';
      const today = new Date().toISOString().slice(0, 10);

      const conds = [eq(bills.organizationId, orgId)];
      if (v.from) conds.push(gte(bills.billDate, v.from));
      if (v.to) conds.push(lte(bills.billDate, v.to));
      if (v.vendorId) conds.push(eq(bills.contactId, v.vendorId));

      if (!v.vendorId && v.vendorName) {
        const matched = await db
          .select({ id: contacts.id })
          .from(contacts)
          .where(
            and(
              eq(contacts.organizationId, orgId),
              or(
                ilike(contacts.contactName, `%${v.vendorName}%`),
                ilike(contacts.companyName, `%${v.vendorName}%`),
              )!,
            ),
          );
        if (matched.length === 0) {
          return {
            filters: { ...v, status },
            count: 0,
            totalAmount: 0,
            rows: [],
            note: `No vendor matched "${v.vendorName}"`,
          };
        }
        conds.push(inArray(bills.contactId, matched.map((m) => m.id)));
      }

      // Sum bill totals and paid-applied totals so we can compute the
      // outstanding amount per bill (= total - applied). The /bills page
      // derives "overdue / paid" labels from these same numbers rather
      // than the literal status column.
      const lineTotal = db.$with('line_totals').as(
        db
          .select({
            billId: billLines.billId,
            amount: sql<number>`coalesce(sum(${billLines.amount}), 0)::float`.as('amount'),
          })
          .from(billLines)
          .groupBy(billLines.billId),
      );
      const appliedTotal = db.$with('applied_totals').as(
        db
          .select({
            billId: billPaymentApplications.billId,
            applied: sql<number>`coalesce(sum(${billPaymentApplications.amountApplied}), 0)::float`.as('applied'),
          })
          .from(billPaymentApplications)
          .innerJoin(billPayments, eq(billPayments.id, billPaymentApplications.billPaymentId))
          .where(eq(billPayments.organizationId, orgId))
          .groupBy(billPaymentApplications.billId),
      );

      const orderBy =
        v.sort === 'date_asc' ? [asc(bills.billDate), asc(bills.id)] :
        v.sort === 'due_asc' ? [asc(bills.dueDate), asc(bills.id)] :
        v.sort === 'due_desc' ? [desc(bills.dueDate), asc(bills.id)] :
        v.sort === 'amount_desc' ? [desc(sql`coalesce(line_totals.amount, 0)`), asc(bills.id)] :
        v.sort === 'amount_asc' ? [asc(sql`coalesce(line_totals.amount, 0)`), asc(bills.id)] :
        [desc(bills.billDate), asc(bills.id)];

      const raw = await db
        .with(lineTotal, appliedTotal)
        .select({
          id: bills.id,
          billNumber: bills.billNumber,
          billDate: bills.billDate,
          dueDate: bills.dueDate,
          status: bills.status,
          contactName: contacts.contactName,
          companyName: contacts.companyName,
          amount: sql<number>`coalesce(${lineTotal.amount}, 0)::float`,
          applied: sql<number>`coalesce(${appliedTotal.applied}, 0)::float`,
        })
        .from(bills)
        .leftJoin(contacts, eq(contacts.id, bills.contactId))
        .leftJoin(lineTotal, eq(lineTotal.billId, bills.id))
        .leftJoin(appliedTotal, eq(appliedTotal.billId, bills.id))
        .where(and(...conds))
        .orderBy(...orderBy);

      // Filter by computed status (outstanding = amount - applied > 0).
      const enriched = raw.map((r) => {
        const total = Number(r.amount ?? 0);
        const applied = Number(r.applied ?? 0);
        const outstanding = Math.max(0, total - applied);
        const isPaid = r.status === 'paid' || outstanding <= 0;
        const daysOverdue = r.dueDate && !isPaid
          ? Math.max(0, Math.floor((Date.now() - new Date(r.dueDate).getTime()) / 86_400_000))
          : 0;
        const isOverdue = !isPaid && daysOverdue > 0;
        return {
          id: r.id,
          billNumber: r.billNumber ?? '—',
          billDate: r.billDate,
          dueDate: r.dueDate ?? null,
          status: r.status,
          vendor: r.contactName ?? r.companyName ?? '—',
          amount: total,
          outstanding,
          isPaid,
          isOverdue,
          daysOverdue,
        };
      });

      const filtered = enriched.filter((r) => {
        if (status === 'overdue') return r.isOverdue;
        if (status === 'outstanding') return !r.isPaid;
        if (status === 'paid') return r.isPaid;
        return true;
      });

      const sliced = filtered.slice(0, limit);
      const totalAmount = sliced.reduce((s, r) => s + r.outstanding, 0);

      return {
        filters: { ...v, status },
        count: filtered.length,
        totalAmount,
        truncated: filtered.length > limit,
        rows: sliced,
      };
    }

    case 'list_accounts': {
      const Schema = z.object({
        types: z.array(z.string()).optional(),
      });
      const v = Schema.parse(args);
      const rows = await db
        .select({
          id: chartOfAccounts.id,
          accountNumber: chartOfAccounts.accountNumber,
          accountName: chartOfAccounts.accountName,
          gaapType: chartOfAccounts.gaapType,
          normalBalance: chartOfAccounts.normalBalance,
        })
        .from(chartOfAccounts)
        .where(
          and(
            eq(chartOfAccounts.organizationId, orgId),
            eq(chartOfAccounts.isActive, true),
          ),
        )
        .orderBy(asc(chartOfAccounts.accountNumber));
      const wantedTypes = (v.types ?? []).map((t) => t.toLowerCase());
      const accounts =
        wantedTypes.length > 0
          ? rows.filter((r) => wantedTypes.includes((r.gaapType ?? '').toLowerCase()))
          : rows;
      return { accounts };
    }

    case 'categorize_transaction': {
      // Internal-only: removed from the public catalog after gpt-4o-mini
      // proved unable to handle transaction UUIDs reliably. The heterogeneous
      // fallback now goes through categorize_contact_uncategorized_subset
      // which uses contactId + row indices instead. Case retained as an
      // internal hatch for testing or future call sites that have a known
      // good UUID (e.g., a UI server action calling the dispatcher directly).
      const Schema = z.object({
        transactionId: z.string().min(1),
        accountId: z.string().min(1),
      });
      const v = Schema.parse(args);
      return await categorizeTransaction({
        organizationId: orgId,
        transactionId: v.transactionId,
        categoryAccountId: v.accountId,
      });
    }

    case 'categorize_contact_uncategorized': {
      // The AI never sees or handles transaction UUIDs. It picks a contact and an
      // account; the dispatcher fetches the contact's uncategorized transaction
      // IDs server-side and applies the category. Eliminates the UUID-hallucination
      // failure mode that broke gpt-4o-mini's bulk-categorization workflow.
      const Schema = z.object({
        contactId: z.string().nullable(),
        accountId: z.string().min(1),
        contactName: z.string().optional(),
      });
      const v = Schema.parse(args);

      const account = await resolveAccount(orgId, v.accountId);
      if (!account) {
        logger.warn(
          { tool: 'categorize_contact_uncategorized', accountId: v.accountId },
          'category account not found',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: 0,
          errors: [{ transactionId: '', error: 'Category account not in this organization' }],
          accountName: '',
          contactName: '',
        };
      }
      if (account.resolvedVia !== 'id') {
        logger.info(
          {
            tool: 'categorize_contact_uncategorized',
            field: 'accountId',
            providedAccountId: v.accountId,
            resolvedVia: account.resolvedVia,
            resolvedToId: account.id,
          },
          'account resolved via fallback',
        );
      }

      const contact = await resolveContact(orgId, v.contactId, v.contactName);
      if (!contact) {
        logger.warn(
          { tool: 'categorize_contact_uncategorized', contactId: v.contactId, contactName: v.contactName },
          'contact not found',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: 0,
          errors: [{ transactionId: '', error: 'Contact not in this organization' }],
          accountName: account.accountName,
          contactName: '',
        };
      }
      if (contact.resolvedVia !== 'id' && contact.resolvedVia !== 'null-bucket') {
        logger.info(
          {
            tool: 'categorize_contact_uncategorized',
            field: 'contactId',
            providedContactId: v.contactId,
            providedContactName: v.contactName,
            resolvedVia: contact.resolvedVia,
            resolvedToId: contact.id,
          },
          'contact resolved via fallback',
        );
      }

      const txnConds = [
        eq(transactions.organizationId, orgId),
        sql`${transactions.categoryAccountId} IS NULL`,
      ];
      if (contact.id === null) {
        txnConds.push(sql`${transactions.contactId} IS NULL`);
      } else {
        txnConds.push(eq(transactions.contactId, contact.id));
      }
      const rows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(...txnConds));

      const displayContactName = contact.contactName ?? '(no contact)';

      if (rows.length === 0) {
        return {
          ok: true,
          posted: 0,
          updated: 0,
          failed: 0,
          errors: [],
          accountName: account.accountName,
          contactName: displayContactName,
        };
      }

      let posted = 0;
      let updated = 0;
      const errors: Array<{ transactionId: string; error: string }> = [];

      for (const row of rows) {
        const result = await categorizeTransaction({
          organizationId: orgId,
          transactionId: row.id,
          categoryAccountId: account.id,
        });
        if (!result.ok) {
          if (errors.length < 10) errors.push({ transactionId: row.id, error: result.error });
          continue;
        }
        if (result.mode === 'posted') posted++;
        else updated++;
      }

      const failed = rows.length - posted - updated;
      return {
        ok: posted + updated > 0,
        posted,
        updated,
        failed,
        errors,
        accountName: account.accountName,
        contactName: displayContactName,
      };
    }

    case 'categorize_contact_uncategorized_subset': {
      // Heterogeneous fallback: AI passes 0-based indices into the contact's
      // uncategorized rows (ordered date desc, secondary id asc to match
      // query_transactions). Dispatcher resolves indices → UUIDs server-side.
      // The AI never handles a transaction UUID — closes the last UUID-passing
      // path that started with the deprecated categorize_transactions bulk tool.
      const Schema = z.object({
        contactId: z.string().nullable(),
        accountId: z.string().min(1),
        contactName: z.string().optional(),
        transactionIndices: z.array(z.number().int().min(0)).min(1).max(50),
      });
      const v = Schema.parse(args);

      const account = await resolveAccount(orgId, v.accountId);
      if (!account) {
        logger.warn(
          { tool: 'categorize_contact_uncategorized_subset', accountId: v.accountId },
          'category account not found',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: v.transactionIndices.length,
          errors: [{ transactionId: '', error: 'Category account not in this organization' }],
          accountName: '',
          contactName: '',
        };
      }
      if (account.resolvedVia !== 'id') {
        logger.info(
          {
            tool: 'categorize_contact_uncategorized_subset',
            field: 'accountId',
            providedAccountId: v.accountId,
            resolvedVia: account.resolvedVia,
            resolvedToId: account.id,
          },
          'account resolved via fallback',
        );
      }

      const contact = await resolveContact(orgId, v.contactId, v.contactName);
      if (!contact) {
        logger.warn(
          {
            tool: 'categorize_contact_uncategorized_subset',
            contactId: v.contactId,
            contactName: v.contactName,
          },
          'contact not found',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: v.transactionIndices.length,
          errors: [{ transactionId: '', error: 'Contact not in this organization' }],
          accountName: account.accountName,
          contactName: '',
        };
      }
      if (contact.resolvedVia !== 'id' && contact.resolvedVia !== 'null-bucket') {
        logger.info(
          {
            tool: 'categorize_contact_uncategorized_subset',
            field: 'contactId',
            providedContactId: v.contactId,
            providedContactName: v.contactName,
            resolvedVia: contact.resolvedVia,
            resolvedToId: contact.id,
          },
          'contact resolved via fallback',
        );
      }

      const subsetTxnConds = [
        eq(transactions.organizationId, orgId),
        sql`${transactions.categoryAccountId} IS NULL`,
      ];
      if (contact.id === null) {
        subsetTxnConds.push(sql`${transactions.contactId} IS NULL`);
      } else {
        subsetTxnConds.push(eq(transactions.contactId, contact.id));
      }
      const subsetRows = await db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(...subsetTxnConds))
        .orderBy(desc(transactions.date), asc(transactions.id));

      const subsetDisplayName = contact.contactName ?? '(no contact)';

      const subsetErrors: Array<{ transactionId: string; error: string }> = [];
      const resolvedRows: Array<{ id: string; index: number }> = [];
      for (const idx of v.transactionIndices) {
        if (idx < 0 || idx >= subsetRows.length) {
          if (subsetErrors.length < 10) {
            subsetErrors.push({
              transactionId: '',
              error: `Index ${idx} out of range; this contact has ${subsetRows.length} uncategorized transaction${subsetRows.length === 1 ? '' : 's'}`,
            });
          }
          continue;
        }
        resolvedRows.push({ id: subsetRows[idx].id, index: idx });
      }

      if (resolvedRows.length === 0) {
        logger.warn(
          {
            tool: 'categorize_contact_uncategorized_subset',
            requestedIndices: v.transactionIndices,
            availableCount: subsetRows.length,
          },
          'all indices out of range',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: v.transactionIndices.length,
          errors: subsetErrors,
          accountName: account.accountName,
          contactName: subsetDisplayName,
        };
      }

      logger.info(
        {
          tool: 'categorize_contact_uncategorized_subset',
          requestedIndices: v.transactionIndices,
          resolvedTransactionIds: resolvedRows.map((r) => r.id),
          availableCount: subsetRows.length,
        },
        'indices resolved to transaction ids',
      );

      let subsetPosted = 0;
      let subsetUpdated = 0;
      for (const row of resolvedRows) {
        const result = await categorizeTransaction({
          organizationId: orgId,
          transactionId: row.id,
          categoryAccountId: account.id,
        });
        if (!result.ok) {
          if (subsetErrors.length < 10) {
            subsetErrors.push({ transactionId: row.id, error: result.error });
          }
          continue;
        }
        if (result.mode === 'posted') subsetPosted++;
        else subsetUpdated++;
      }

      const subsetFailed = v.transactionIndices.length - subsetPosted - subsetUpdated;
      return {
        ok: subsetPosted + subsetUpdated > 0,
        posted: subsetPosted,
        updated: subsetUpdated,
        failed: subsetFailed,
        errors: subsetErrors,
        accountName: account.accountName,
        contactName: subsetDisplayName,
      };
    }

    case 'list_uncategorized_by_contact': {
      // One row per contact (plus one row for null-contact transactions).
      // The transaction IDs themselves are intentionally NOT returned — gpt-4o-mini
      // hallucinates UUIDs after the first batch when asked to repeat them. The AI
      // calls categorize_contact_uncategorized with just contactId; the dispatcher
      // fetches IDs server-side. Null-contact bucket emerges naturally because
      // Postgres GROUP BY treats NULL as one group.
      const groups = await db
        .select({
          contactId: transactions.contactId,
          contactName: contacts.contactName,
          transactionCount: sql<number>`COUNT(*)::int`.as('transaction_count'),
          totalAmount: sql<number>`COALESCE(SUM(ABS(${transactions.amount})), 0)::float`.as('total_amount'),
          oldestDate: sql<string | null>`MIN(${transactions.date})`.as('oldest_date'),
          newestDate: sql<string | null>`MAX(${transactions.date})`.as('newest_date'),
        })
        .from(transactions)
        .leftJoin(contacts, eq(contacts.id, transactions.contactId))
        .where(
          and(
            eq(transactions.organizationId, orgId),
            sql`${transactions.categoryAccountId} IS NULL`,
          ),
        )
        .groupBy(transactions.contactId, contacts.contactName)
        .orderBy(sql`COUNT(*) DESC, MAX(${transactions.date}) DESC`);

      const totalTransactions = groups.reduce((s, g) => s + Number(g.transactionCount), 0);
      return {
        groups: groups.map((g) => ({
          contactId: g.contactId,
          contactName: g.contactName,
          transactionCount: Number(g.transactionCount),
          totalAmount: Number(g.totalAmount),
          oldestDate: g.oldestDate,
          newestDate: g.newestDate,
        })),
        totalContacts: groups.length,
        totalTransactions,
      };
    }

    case 'categorize_transactions': {
      const Schema = z.object({
        transactionIds: z.array(z.string().min(1)).min(1).max(200),
        accountId: z.string().min(1),
      });
      const v = Schema.parse(args);

      // Resolve once up front via the tolerant resolver (UUID → accountNumber
      // → accountName). The helper resolves again per row, hitting the id
      // fast-path because we pass account.id forward.
      const account = await resolveAccount(orgId, v.accountId);
      if (!account) {
        logger.warn(
          { tool: 'categorize_transactions', accountId: v.accountId, idCount: v.transactionIds.length },
          'category account not found',
        );
        return {
          ok: false,
          posted: 0,
          updated: 0,
          failed: v.transactionIds.length,
          errors: v.transactionIds.slice(0, 10).map((id) => ({
            transactionId: id,
            error: 'Category account not in this organization',
          })),
          accountName: '',
        };
      }
      if (account.resolvedVia !== 'id') {
        logger.info(
          {
            tool: 'categorize_transactions',
            providedAccountId: v.accountId,
            resolvedVia: account.resolvedVia,
            resolvedToId: account.id,
          },
          'account resolved via fallback',
        );
      }

      let posted = 0;
      let updated = 0;
      const errors: Array<{ transactionId: string; error: string }> = [];

      for (const id of v.transactionIds) {
        const result = await categorizeTransaction({
          organizationId: orgId,
          transactionId: id,
          categoryAccountId: account.id,
        });
        if (!result.ok) {
          if (errors.length < 10) errors.push({ transactionId: id, error: result.error });
          continue;
        }
        if (result.mode === 'posted') posted++;
        else updated++;
      }

      const failed = v.transactionIds.length - posted - updated;
      return {
        ok: posted + updated > 0,
        posted,
        updated,
        failed,
        errors,
        accountName: account.accountName,
      };
    }

    case 'get_onboarding_status': {
      return await getOnboardingStatus(orgId);
    }

    case 'set_business_info': {
      const Beneficiary = z.object({
        full_name: z.string().min(1).max(200),
        date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
        is_incapacitated: z.boolean().optional(),
        relationship: z.string().max(200).optional().nullable(),
      });
      const Schema = z.object({
        name: z.string().min(1).max(200).optional(),
        description: z.string().max(2000).optional(),
        entity_type: z
          .enum(['llc', 'c_corp', 's_corp', 'partnership', 'sole_prop', 'beneficial_trust', 'business_trust', 'nonprofit', 'other'])
          .optional()
          .nullable(),
        beneficiaries: z.array(Beneficiary).optional(),
      });
      const v = Schema.parse(args);
      return await setBusinessInfo({
        organizationId: orgId,
        name: v.name,
        description: v.description,
        entityType: v.entity_type,
        beneficiaries: v.beneficiaries?.map((b) => ({
          fullName: b.full_name,
          dateOfBirth: b.date_of_birth ?? null,
          isIncapacitated: b.is_incapacitated ?? false,
          relationship: b.relationship ?? null,
        })),
        turnId,
      });
    }

    case 'advance_onboarding': {
      const Schema = z.object({
        to: z.enum([...ONBOARDING_PHASES, 'next'] as [string, ...string[]]).optional(),
      });
      const v = Schema.parse(args);
      return await advanceOnboarding({
        organizationId: orgId,
        to: v.to as 'next' | undefined,
        turnId,
      });
    }

    default:
      throw new Error(`Unknown realtime tool: ${name}`);
  }
}
