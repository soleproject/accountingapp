'use client';

import { useActionState, useMemo, useState, useTransition } from 'react';
import { categorizeTransaction, applyToMatchingAction, type CategorizeState, type ApplyMatchingState } from '../_actions/categorize';
import { groupAccountsByGaap } from './account-groups';
import { CategorySelect, type BillOption, type CategoryPickerValue, type InvoiceOption } from './CategorySelect';
import { ContactSelect } from './ContactSelect';

interface Account {
  id: string;
  accountNumber: string;
  accountName: string;
  gaapType: string;
}
interface Contact {
  id: string;
  name: string;
}
interface Props {
  transactionId: string;
  currentCategoryAccountId: string | null;
  currentContactId: string | null;
  /** Parent-controlled contact id. When provided, the form mirrors it
   *  via the existing in-body ContactSelect so the header field and
   *  the form picker stay in sync. */
  controlledContactId?: string;
  onContactChange?: (id: string) => void;
  currentIntent: '' | 'bill_payment' | 'invoice_payment';
  currentIntentTargetId: string;
  /** Controlled by the panel — same values passed to the split form so user
   *  input doesn't get lost on mode switch. */
  date: string;
  description: string;
  accountId: string;
  type: 'deposit' | 'withdrawal' | '';
  accounts: Account[];
  contacts: Contact[];
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  alreadyPosted: boolean;
  /** Hook the panel can pass in to switch into split mode pre-populated
   *  with a directional line (bill or invoice payment) plus a remainder
   *  line when the picked target was overpaid. */
  onAutoSplit?: (args: {
    intent: 'bill_payment' | 'invoice_payment';
    targetId: string;
    targetAmount: number;
    remainder: number;
  }) => void;
}

interface AISuggestion {
  accountId: string | null;
  accountNumber: string | null;
  accountName: string | null;
  contactId: string | null;
  contactName: string | null;
  confidence: number;
  reason: string;
}

export function CategorizeForm({
  transactionId,
  currentCategoryAccountId,
  currentContactId,
  controlledContactId,
  onContactChange,
  currentIntent,
  currentIntentTargetId,
  date,
  description,
  accountId: txnAccountId,
  type,
  accounts,
  contacts,
  outstandingBills,
  outstandingInvoices,
  alreadyPosted,
  onAutoSplit,
}: Props) {
  const [state, action, pending] = useActionState<CategorizeState | undefined, FormData>(
    categorizeTransaction,
    undefined,
  );
  const [applyState, applyAction, applyPending] = useActionState<ApplyMatchingState | undefined, FormData>(
    applyToMatchingAction,
    undefined,
  );
  const [suggestion, setSuggestion] = useState<AISuggestion | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiPending, startAi] = useTransition();
  const [category, setCategory] = useState<CategoryPickerValue>({
    categoryAccountId: currentIntent ? '' : (currentCategoryAccountId ?? ''),
    intent: currentIntent,
    intentTargetId: currentIntentTargetId,
  });
  // When a parent controls the contact (the panel header lifts it),
  // mirror their value and notify upward on changes. Otherwise keep
  // local state for backward compat.
  const [localContactId, setLocalContactId] = useState(currentContactId ?? '');
  const contactId = controlledContactId ?? localContactId;
  const setContactId = (id: string) => {
    if (controlledContactId !== undefined && onContactChange) onContactChange(id);
    else setLocalContactId(id);
  };
  const [dismissed, setDismissed] = useState(false);
  const accountGroups = useMemo(() => groupAccountsByGaap(accounts), [accounts]);

  const askAI = () => {
    setAiError(null);
    startAi(async () => {
      try {
        const r = await fetch('/api/ai/categorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ transactionId }),
        });
        if (!r.ok) {
          setAiError(`AI failed: ${r.status}`);
          return;
        }
        const data: AISuggestion = await r.json();
        setSuggestion(data);
        if (data.accountId) {
          setCategory({ categoryAccountId: data.accountId, intent: '', intentTargetId: '' });
        }
        if (data.contactId) setContactId(data.contactId);
      } catch (e) {
        setAiError(e instanceof Error ? e.message : 'AI request failed');
      }
    });
  };

  const showApplyPrompt =
    state?.ok &&
    !dismissed &&
    !applyState?.ok &&
    state.matchingUncategorizedCount != null &&
    state.matchingUncategorizedCount > 0 &&
    state.matchingTransactionIds &&
    state.appliedCategoryAccountId;

  const accountLabel = accounts.find((a) => a.id === state?.appliedCategoryAccountId);

  return (
    <div className="flex flex-col gap-4">
      <form action={action} className="flex flex-col gap-4">
        <input type="hidden" name="transactionId" value={transactionId} />
        <input type="hidden" name="date" value={date} />
        <input type="hidden" name="userDescription" value={description} />
        <input type="hidden" name="accountId" value={txnAccountId} />
        <input type="hidden" name="type" value={type} />
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">{alreadyPosted ? 'Update categorization' : 'Categorize'}</h2>
          <button
            type="button"
            onClick={askAI}
            disabled={aiPending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            {aiPending ? 'AI thinking…' : 'Ask AI ✨'}
          </button>
        </div>

        {suggestion && (
          <div className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm dark:border-blue-900 dark:bg-blue-950">
            <div className="font-medium text-blue-900 dark:text-blue-100">
              AI suggests: {suggestion.accountNumber ? `${suggestion.accountNumber} · ${suggestion.accountName}` : '(no clear match)'}
            </div>
            <div className="text-xs text-blue-800 dark:text-blue-200">
              confidence: {Math.round(suggestion.confidence * 100)}% · {suggestion.reason}
            </div>
          </div>
        )}
        {aiError && <span className="text-sm text-red-600">{aiError}</span>}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Category account</label>
            <CategorySelect
              namePrefix=""
              value={category}
              onChange={setCategory}
              accountGroups={accountGroups}
              outstandingBills={outstandingBills}
              outstandingInvoices={outstandingInvoices}
              required
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {category.intent === 'bill_payment'
                ? 'Vendor'
                : category.intent === 'invoice_payment'
                  ? 'Customer'
                  : 'Contact'}
            </label>
            {category.intent === 'bill_payment' ? (
              <div className="flex items-center justify-between rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                <span>
                  {outstandingBills.find((b) => b.id === category.intentTargetId)?.vendorName ?? '—'}
                </span>
                <span className="text-xs text-zinc-400">from bill</span>
              </div>
            ) : category.intent === 'invoice_payment' ? (
              <div className="flex items-center justify-between rounded-md border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400">
                <span>
                  {outstandingInvoices.find((i) => i.id === category.intentTargetId)?.customerName ?? '—'}
                </span>
                <span className="text-xs text-zinc-400">from invoice</span>
              </div>
            ) : (
              <ContactSelect
                name="contactId"
                value={contactId}
                onChange={setContactId}
                contacts={contacts}
                placeholder="—"
              />
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            {pending ? 'Saving…' : alreadyPosted ? 'Update' : 'Categorize & post JE'}
          </button>
          {state?.error && !state.overpayment && (
            <span className="text-sm text-red-600">{state.error}</span>
          )}
          {state?.ok && <span className="text-sm text-emerald-600">Saved.</span>}
        </div>

        {state?.overpayment && onAutoSplit && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/30">
            <p className="font-medium text-amber-900 dark:text-amber-100">
              {state.overpayment.targetLabel} balance is ${state.overpayment.targetBalance.toFixed(2)}, but this transaction is ${state.overpayment.txnAmount.toFixed(2)}.
            </p>
            <p className="mt-1 text-xs text-amber-800 dark:text-amber-200">
              Apply ${state.overpayment.targetBalance.toFixed(2)} to {state.overpayment.targetLabel} and split the remaining ${state.overpayment.remaining.toFixed(2)} into a second line you can categorize.
            </p>
            <div className="mt-2">
              <button
                type="button"
                onClick={() =>
                  onAutoSplit({
                    intent: state.overpayment!.intent,
                    targetId: state.overpayment!.targetId,
                    targetAmount: state.overpayment!.targetBalance,
                    remainder: state.overpayment!.remaining,
                  })
                }
                className="rounded-md border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900/40 dark:text-amber-100 dark:hover:bg-amber-900/60"
              >
                Split for me
              </button>
            </div>
          </div>
        )}
      </form>

      {showApplyPrompt && (
        <form
          action={applyAction}
          className="rounded-lg border border-blue-300 bg-blue-50 p-4 dark:border-blue-800 dark:bg-blue-950/30"
        >
          {state.matchingTransactionIds!.map((id) => (
            <input key={id} type="hidden" name="ids" value={id} />
          ))}
          <input type="hidden" name="categoryAccountId" value={state.appliedCategoryAccountId} />
          {state.appliedContactId && <input type="hidden" name="contactId" value={state.appliedContactId} />}

          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-medium text-blue-900 dark:text-blue-100">
                Found {state.matchingUncategorizedCount} other uncategorized transaction(s) for &ldquo;{state.merchantLabel}&rdquo;
              </p>
              <p className="mt-1 text-xs text-blue-800 dark:text-blue-200">
                Apply <strong>{accountLabel ? `${accountLabel.accountNumber} · ${accountLabel.accountName}` : 'the same category'}</strong> and post their JEs?
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setDismissed(true)}
                className="rounded-md border border-blue-300 px-3 py-1.5 text-sm hover:bg-blue-100 dark:border-blue-700 dark:hover:bg-blue-900/40"
              >
                Skip
              </button>
              <button
                type="submit"
                disabled={applyPending}
                className="rounded-md bg-blue-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50"
              >
                {applyPending ? 'Applying…' : `Apply to ${state.matchingUncategorizedCount} more`}
              </button>
            </div>
          </div>
          {applyState?.error && <p className="mt-2 text-sm text-red-700 dark:text-red-300">{applyState.error}</p>}
        </form>
      )}

      {applyState?.ok && (
        <div className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100">
          ✓ Queued {applyState.queued} matching transaction(s) for auto-categorize. Refresh in a minute.
        </div>
      )}
    </div>
  );
}
