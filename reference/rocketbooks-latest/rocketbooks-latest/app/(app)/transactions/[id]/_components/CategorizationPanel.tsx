'use client';

import { useState } from 'react';
import { CategorizeForm } from './CategorizeForm';
import { ContactSelect } from './ContactSelect';
import { SplitTransactionForm } from '../split/_components/SplitTransactionForm';
import { SplitsPanel } from './SplitsPanel';
import type { SplitTransactionState } from '../_actions/splitTransaction';
import type { UnsplitTransactionState } from '../_actions/unsplitTransaction';
import type { BillOption, InvoiceOption } from './CategorySelect';

interface Account {
  id: string;
  accountNumber: string | null;
  accountName: string;
  gaapType: string | null;
}

interface BankAccount {
  id: string;
  accountNumber: string | null;
  accountName: string;
}

interface Contact {
  id: string;
  name: string;
}

interface SplitView {
  id: string;
  categoryLabel: string;
  contactLabel: string | null;
  memo: string | null;
  amount: number;
}

interface InitialLine {
  categoryAccountId: string;
  amount: string;
  memo: string;
  contactId: string;
  intent?: '' | 'bill_payment' | 'invoice_payment';
  intentTargetId?: string;
}

interface Props {
  transactionId: string;
  txnType: 'deposit' | 'withdrawal' | null;
  txnAmount: number | null;
  txnDate: string;
  txnAccountId: string | null;
  // Categorize form props
  currentCategoryAccountId: string | null;
  currentContactId: string | null;
  currentDescription: string | null;
  currentIntent: '' | 'bill_payment' | 'invoice_payment';
  currentIntentTargetId: string;
  accounts: Account[];
  bankAccounts: BankAccount[];
  contacts: Contact[];
  alreadyPosted: boolean;
  // Split form props
  categoryAccounts: Account[];
  outstandingBills: BillOption[];
  outstandingInvoices: InvoiceOption[];
  splits: SplitView[];
  initialSplitLines: InitialLine[];
  splitAction: (
    prev: SplitTransactionState | undefined,
    formData: FormData,
  ) => Promise<SplitTransactionState | undefined>;
  unsplitAction: (
    prev: UnsplitTransactionState | undefined,
    formData: FormData,
  ) => Promise<UnsplitTransactionState | undefined>;
}

type Mode = 'single' | 'view-split' | 'edit-split';

export function CategorizationPanel(props: Props) {
  const hasSplits = props.splits.length > 0;
  const splittable =
    (props.txnType === 'deposit' || props.txnType === 'withdrawal') && props.txnAmount != null;
  const [mode, setMode] = useState<Mode>(hasSplits ? 'view-split' : 'single');

  // Panel-level state for the "main info" fields — these stay visible
  // across mode switches so user input doesn't get lost when toggling
  // between single and split.
  const [date, setDate] = useState(props.txnDate);
  const [description, setDescription] = useState(props.currentDescription ?? '');
  const [accountId, setAccountId] = useState(props.txnAccountId ?? '');
  const [type, setType] = useState<'deposit' | 'withdrawal' | ''>(props.txnType ?? '');
  // Txn-level contact — shared by every split when present (e.g.
  // receipt-applied transactions whose vendor is the same across every
  // line item). Single mode binds this back into CategorizeForm so the
  // user sees one Contact field, not two.
  const [contactId, setContactId] = useState(props.currentContactId ?? '');
  // When the categorize action rejects a bill payment as an overpayment,
  // we offer "Split for me" — this is the pre-filled split state that
  // takes precedence over props.initialSplitLines while it's set.
  const [splitOverride, setSplitOverride] = useState<InitialLine[] | null>(null);

  const autoSplit = (a: {
    intent: 'bill_payment' | 'invoice_payment';
    targetId: string;
    targetAmount: number;
    remainder: number;
  }) => {
    setSplitOverride([
      {
        categoryAccountId: '',
        amount: a.targetAmount.toFixed(2),
        memo: '',
        contactId: '',
        intent: a.intent,
        intentTargetId: a.targetId,
      },
      {
        categoryAccountId: '',
        amount: a.remainder.toFixed(2),
        memo: '',
        contactId: '',
        intent: '',
        intentTargetId: '',
      },
    ]);
    setMode('edit-split');
  };

  // Reshape Account[] for CategorizeForm which requires non-null fields.
  const categorizeAccounts = props.accounts
    .filter((a) => a.accountNumber != null && a.gaapType != null)
    .map((a) => ({
      id: a.id,
      accountNumber: a.accountNumber!,
      accountName: a.accountName,
      gaapType: a.gaapType!,
    }));

  // Cast for SplitTransactionForm — keep gaapType so the dropdown can group.
  const splitFormAccounts = props.categoryAccounts.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    accountName: a.accountName,
    gaapType: a.gaapType,
  }));

  const header = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Date</label>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Description
        </label>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Write a description"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Account</label>
        <select
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">— Select —</option>
          {props.bankAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.accountNumber ? `${a.accountNumber} · ` : ''}
              {a.accountName}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Type</label>
        <select
          value={type}
          onChange={(e) => setType(e.target.value as 'deposit' | 'withdrawal' | '')}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        >
          <option value="">— Select —</option>
          <option value="deposit">Deposit</option>
          <option value="withdrawal">Withdrawal</option>
        </select>
      </div>
      <div className="flex flex-col gap-1 sm:col-span-2">
        <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">Contact</label>
        <ContactSelect
          // No `name=` — the parent forms (CategorizeForm / SplitTransactionForm)
          // each emit their own `contactId` hidden input wired to this same
          // controlled value, so submissions stay consistent in either mode.
          name=""
          value={contactId}
          onChange={setContactId}
          contacts={props.contacts}
          placeholder="—"
        />
      </div>
    </div>
  );

  // View-split mode: render the same Date/Description/Account/Type
  // header that single + edit-split modes show, then the read-only
  // SplitsPanel below. Header inputs are local state — they don't save
  // until the user clicks "Edit splits" (which preserves the values
  // into the split form) or "Remove split" → single mode.
  if (mode === 'view-split' && hasSplits) {
    return (
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
          {header}
        </div>
        <SplitsPanel
          transactionId={props.transactionId}
          splits={props.splits}
          unsplitAction={props.unsplitAction}
          onEdit={() => setMode('edit-split')}
        />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-6 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        {header}
        {mode === 'single' ? (
          <CategorizeForm
            transactionId={props.transactionId}
            currentCategoryAccountId={props.currentCategoryAccountId}
            currentContactId={props.currentContactId}
            controlledContactId={contactId}
            onContactChange={setContactId}
            currentIntent={props.currentIntent}
            currentIntentTargetId={props.currentIntentTargetId}
            date={date}
            description={description}
            accountId={accountId}
            type={type}
            accounts={categorizeAccounts}
            contacts={props.contacts}
            outstandingBills={props.outstandingBills}
            outstandingInvoices={props.outstandingInvoices}
            alreadyPosted={props.alreadyPosted}
            onAutoSplit={autoSplit}
          />
        ) : (
          splittable && (
            <SplitTransactionForm
              action={props.splitAction}
              transactionAmount={props.txnAmount!}
              categoryAccounts={splitFormAccounts}
              contacts={props.contacts}
              outstandingBills={props.outstandingBills}
              outstandingInvoices={props.outstandingInvoices}
              date={date}
              description={description}
              accountId={accountId}
              type={type}
              initialCategoryAccountId={props.currentCategoryAccountId}
              initialLines={
                splitOverride ??
                (props.initialSplitLines.length ? props.initialSplitLines : undefined)
              }
              onCancel={() => {
                setSplitOverride(null);
                setMode(hasSplits ? 'view-split' : 'single');
              }}
            />
          )
        )}
      </div>

      {mode === 'single' && splittable && (
        <div>
          <button
            type="button"
            onClick={() => setMode('edit-split')}
            className="rounded-full border border-blue-500 px-4 py-1.5 text-sm font-medium text-blue-600 hover:bg-blue-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950/40"
          >
            Split transaction
          </button>
        </div>
      )}
    </div>
  );
}
