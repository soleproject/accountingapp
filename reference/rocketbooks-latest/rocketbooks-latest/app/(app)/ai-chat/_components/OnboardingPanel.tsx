'use client';

import Link from 'next/link';
import { useState, useTransition } from 'react';
import { EmbeddedPlaidLink } from './EmbeddedPlaidLink';
import { EmbeddedBankStatementUpload } from './EmbeddedBankStatementUpload';
import { EmbeddedReceiptUpload } from './EmbeddedReceiptUpload';

export interface OnboardingPlaidAccount {
  id: string;
  institutionName: string | null;
  accountName: string | null;
  last4: string | null;
  chartOfAccountId: string | null;
  chartOfAccountLabel: string | null;
  status: string | null;
  inScope: boolean;
}

export interface OnboardingImport {
  id: string;
  filename: string | null;
  status: string;
  transactionCount: number | null;
  createdAt: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface OnboardingReceipt {
  id: string;
  vendorName: string | null;
  total: number | null;
  receiptDate: string | null;
  status: string | null;
  posted: boolean;
}

export interface OnboardingAssetAccount {
  id: string;
  accountNumber: string;
  accountName: string;
}

export type OnboardingEntityType =
  | 'llc'
  | 'c_corp'
  | 's_corp'
  | 'partnership'
  | 'sole_prop'
  | 'beneficial_trust'
  | 'business_trust'
  | 'nonprofit'
  | 'other';

export interface OnboardingBeneficiaryView {
  id: string;
  fullName: string;
  dateOfBirth: string | null;
  isIncapacitated: boolean;
  relationship: string | null;
}

export interface OnboardingStatusView {
  organizationId: string;
  organizationName: string;
  businessDescription: string | null;
  phase:
    | 'business_info'
    | 'quickbooks'
    | 'plaid'
    | 'bank_statements'
    | 'receipts'
    | 'review'
    | 'complete';
  completed: boolean;
  signals: {
    hasBusinessInfo: boolean;
    plaidAccountsLinked: number;
    plaidAccountsInScope: number;
    bankStatementsImported: number;
    receiptsUploaded: number;
  };
  plaidAccounts: OnboardingPlaidAccount[];
  recentImports: OnboardingImport[];
  recentReceipts: OnboardingReceipt[];
  assetAccounts: OnboardingAssetAccount[];
  entityType: OnboardingEntityType | null;
  entityTypeOnboardingEnabled: boolean;
  beneficiaries: OnboardingBeneficiaryView[];
}

const ENTITY_TYPE_OPTIONS: ReadonlyArray<{ value: OnboardingEntityType; label: string }> = [
  { value: 'llc', label: 'LLC' },
  { value: 'c_corp', label: 'C Corporation' },
  { value: 's_corp', label: 'S Corporation' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'sole_prop', label: 'Sole Proprietorship' },
  { value: 'beneficial_trust', label: 'Beneficial Trust' },
  { value: 'business_trust', label: 'Business Trust' },
  { value: 'nonprofit', label: 'Nonprofit (501(c)(3))' },
  { value: 'other', label: 'Other' },
];

const TRUST_ENTITY_TYPES: ReadonlyArray<OnboardingEntityType> = ['beneficial_trust', 'business_trust'];

interface BeneficiaryFormRow {
  fullName: string;
  dateOfBirth: string;
  isIncapacitated: boolean;
  relationship: string;
}

function emptyBeneficiary(): BeneficiaryFormRow {
  return { fullName: '', dateOfBirth: '', isIncapacitated: false, relationship: '' };
}

const PHASES: Array<{ key: OnboardingStatusView['phase']; label: string }> = [
  { key: 'business_info', label: 'Business info' },
  { key: 'quickbooks', label: 'QuickBooks' },
  { key: 'plaid', label: 'Connect bank' },
  { key: 'bank_statements', label: 'Upload statements' },
  { key: 'receipts', label: 'Upload receipts' },
  { key: 'review', label: 'Review' },
  { key: 'complete', label: 'Done' },
];

function phaseIndex(p: OnboardingStatusView['phase']): number {
  const i = PHASES.findIndex((x) => x.key === p);
  return i < 0 ? 0 : i;
}

async function callTool<T>(name: string, args: object): Promise<T> {
  const res = await fetch('/api/ai/realtime/tools', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, args }),
  });
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok || (body as { error?: string }).error) {
    throw new Error((body as { error?: string }).error ?? `tool ${name} failed`);
  }
  return body;
}

export function OnboardingPanel({
  status,
  onChanged,
  onClose,
}: {
  status: OnboardingStatusView;
  onChanged?: (next: OnboardingStatusView) => void;
  onClose?: () => void;
}) {
  const idx = phaseIndex(status.phase);

  const refresh = async () => {
    const next = await callTool<OnboardingStatusView>('get_onboarding_status', {});
    onChanged?.(next);
  };

  return (
    <div className="shrink-0 overflow-hidden rounded-lg border border-violet-300 bg-white shadow-sm dark:border-violet-800 dark:bg-zinc-950">
      <div className="border-b border-violet-200 bg-violet-50 px-5 py-3 dark:border-violet-900 dark:bg-violet-950/30">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
              Onboarding · {status.organizationName}
            </div>
            <div className="text-lg font-semibold">
              {status.completed ? '✓ Complete' : PHASES[idx]?.label ?? '—'}
            </div>
          </div>
          <div className="flex items-start gap-3">
            <div className="text-right text-xs text-zinc-500">
              Step {Math.min(idx + 1, PHASES.length - 1)} of {PHASES.length - 1}
            </div>
            {onClose && (
              <button
                type="button"
                onClick={onClose}
                aria-label="Close onboarding panel"
                title="Close"
                className="-mt-1 -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-500 hover:bg-zinc-200 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
              >
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            )}
          </div>
        </div>
        <Stepper currentIndex={idx} />
      </div>

      <div className="p-5">
        <PhaseBody status={status} onChanged={onChanged} refresh={refresh} />
      </div>
    </div>
  );
}

function Stepper({ currentIndex }: { currentIndex: number }) {
  return (
    <div className="mt-3 flex items-center gap-1">
      {PHASES.slice(0, -1).map((p, i) => (
        <div key={p.key} className="flex flex-1 items-center gap-1">
          <div
            className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-medium ${
              i < currentIndex
                ? 'bg-emerald-600 text-white'
                : i === currentIndex
                  ? 'bg-violet-600 text-white'
                  : 'bg-zinc-200 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
            }`}
            title={p.label}
          >
            {i < currentIndex ? '✓' : i + 1}
          </div>
          {i < PHASES.length - 2 && (
            <div className={`h-0.5 flex-1 rounded ${i < currentIndex ? 'bg-emerald-500' : 'bg-zinc-200 dark:bg-zinc-800'}`} />
          )}
        </div>
      ))}
    </div>
  );
}

function PhaseBody({
  status,
  onChanged,
  refresh,
}: {
  status: OnboardingStatusView;
  onChanged?: (next: OnboardingStatusView) => void;
  refresh: () => Promise<void>;
}) {
  const advance = async () => {
    const next = await callTool<OnboardingStatusView>('advance_onboarding', { to: 'next' });
    onChanged?.(next);
  };

  switch (status.phase) {
    case 'business_info':
      return <BusinessInfoStep status={status} onChanged={onChanged} />;

    case 'quickbooks':
      return (
        <ConnectStep
          title="Connect QuickBooks"
          body="Optional. Mirrors your existing chart of accounts and balances if you already use QuickBooks Online. Skip if you don't use it."
          cta={{ href: '/integrations/qbo', label: 'Open QuickBooks integration' }}
          skipLabel="I don't use QuickBooks — skip"
          onAdvance={advance}
        />
      );

    case 'plaid': {
      const linked = status.signals.plaidAccountsLinked;
      const inScope = status.signals.plaidAccountsInScope;
      // Continue is always enabled (per design — Skip path stays open). Label
      // changes so users see why we'd recommend pausing if nothing is in scope.
      const primaryLabel =
        linked === 0
          ? 'Skip to upload statements'
          : inScope === 0
            ? 'Continue without adding any accounts to books'
            : 'Continue to upload statements';
      return (
        <div className="space-y-3">
          <EmbeddedPlaidLink accounts={status.plaidAccounts} onLinked={refresh} />
          <ContinueOrSkip primaryLabel={primaryLabel} onAdvance={advance} />
        </div>
      );
    }

    case 'bank_statements':
      return (
        <div className="space-y-3">
          <EmbeddedBankStatementUpload
            accounts={status.assetAccounts}
            imports={status.recentImports}
            onChanged={refresh}
          />
          <ContinueOrSkip
            primaryLabel={status.recentImports.length > 0 ? 'Continue to upload receipts' : 'Skip to upload receipts'}
            onAdvance={advance}
          />
        </div>
      );

    case 'receipts':
      return (
        <div className="space-y-3">
          <EmbeddedReceiptUpload receipts={status.recentReceipts} onChanged={refresh} />
          <ContinueOrSkip
            primaryLabel={status.recentReceipts.length > 0 ? 'Continue to review' : 'Skip to review'}
            onAdvance={advance}
          />
        </div>
      );

    case 'review':
      return <ReviewStep status={status} onComplete={advance} />;

    case 'complete':
      return <CompleteStep onRestart={async () => {
        const next = await callTool<OnboardingStatusView>('advance_onboarding', { to: 'business_info' });
        onChanged?.(next);
      }} />;
  }
}

function CompleteStep({ onRestart }: { onRestart: () => Promise<void> }) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium">You&apos;re all set up.</div>
      <p className="text-zinc-600 dark:text-zinc-400">
        Your books are live. Use the AI assistant or the sidebar to navigate. You can re-run onboarding at any time.
      </p>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/dashboard"
          className="inline-block rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700"
        >
          Open dashboard →
        </Link>
        <button
          type="button"
          onClick={() => startTransition(async () => onRestart())}
          disabled={pending}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {pending ? 'Restarting…' : 'Restart onboarding'}
        </button>
      </div>
    </div>
  );
}

function BusinessInfoStep({
  status,
  onChanged,
}: {
  status: OnboardingStatusView;
  onChanged?: (next: OnboardingStatusView) => void;
}) {
  const [name, setName] = useState(status.organizationName);
  const [description, setDescription] = useState(status.businessDescription ?? '');
  const [entityType, setEntityType] = useState<OnboardingEntityType | ''>(status.entityType ?? '');
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryFormRow[]>(() =>
    status.beneficiaries.length > 0
      ? status.beneficiaries.map((b) => ({
          fullName: b.fullName,
          dateOfBirth: b.dateOfBirth ?? '',
          isIncapacitated: b.isIncapacitated,
          relationship: b.relationship ?? '',
        }))
      : [emptyBeneficiary()],
  );
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  const showEntityTypeStep = status.entityTypeOnboardingEnabled;
  const showBeneficiaries = showEntityTypeStep && entityType === 'beneficial_trust';

  const addBeneficiary = () => setBeneficiaries((cur) => [...cur, emptyBeneficiary()]);
  const removeBeneficiary = (idx: number) =>
    setBeneficiaries((cur) => (cur.length <= 1 ? cur : cur.filter((_, i) => i !== idx)));
  const updateBeneficiary = (idx: number, patch: Partial<BeneficiaryFormRow>) =>
    setBeneficiaries((cur) => cur.map((b, i) => (i === idx ? { ...b, ...patch } : b)));

  const onSave = () => {
    if (!name.trim() || !description.trim()) {
      setErr('Both name and a short description are required.');
      return;
    }
    if (showEntityTypeStep && !entityType) {
      setErr('Please select an entity type.');
      return;
    }
    if (showBeneficiaries) {
      const valid = beneficiaries.filter((b) => b.fullName.trim().length > 0);
      if (valid.length === 0) {
        setErr('Add at least one beneficiary (with a name) for a beneficial trust.');
        return;
      }
    }
    setErr(null);
    startTransition(async () => {
      try {
        const args: Record<string, unknown> = { name, description };
        if (showEntityTypeStep && entityType) {
          args.entity_type = entityType;
          if (entityType === 'beneficial_trust') {
            args.beneficiaries = beneficiaries
              .filter((b) => b.fullName.trim().length > 0)
              .map((b) => ({
                full_name: b.fullName.trim(),
                date_of_birth: b.dateOfBirth.trim() || null,
                is_incapacitated: b.isIncapacitated,
                relationship: b.relationship.trim() || null,
              }));
          }
        }
        const next = await callTool<OnboardingStatusView>('set_business_info', args);
        onChanged?.(next);
      } catch (e) {
        setErr(e instanceof Error ? e.message : 'Failed');
      }
    });
  };

  return (
    <div className="space-y-3 text-sm">
      <p className="text-zinc-600 dark:text-zinc-400">
        Tell us about your business. This is used as context for the AI assistant and shows on reports.
      </p>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Business name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={pending}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="Acme LLC"
        />
      </label>
      <label className="block">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">What does the business do?</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={pending}
          rows={3}
          className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          placeholder="A boutique design studio that builds brand identities for direct-to-consumer startups."
        />
      </label>

      {showEntityTypeStep && (
        <label className="block">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Entity type</span>
          <select
            value={entityType}
            onChange={(e) => setEntityType(e.target.value as OnboardingEntityType | '')}
            disabled={pending}
            className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          >
            <option value="">Select…</option>
            {ENTITY_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {TRUST_ENTITY_TYPES.includes(entityType as OnboardingEntityType) && (
            <span className="mt-1 block text-xs text-violet-700 dark:text-violet-300">
              Trust-specific chart of accounts and posting rules will apply.
            </span>
          )}
        </label>
      )}

      {showBeneficiaries && (
        <div className="space-y-2 rounded-md border border-violet-300 bg-violet-50/50 p-3 dark:border-violet-800 dark:bg-violet-950/30">
          <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Beneficiaries</div>
          <p className="text-xs text-zinc-600 dark:text-zinc-400">
            Age and mental capacity gate certain accounts (Food/Clothing can only be paid for
            beneficiaries who are under 21 or incapacitated). Add every named beneficiary of the trust.
          </p>
          {beneficiaries.map((b, idx) => (
            <div
              key={idx}
              className="space-y-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-700 dark:bg-zinc-900"
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-zinc-500">Beneficiary {idx + 1}</span>
                {beneficiaries.length > 1 && (
                  <button
                    type="button"
                    onClick={() => removeBeneficiary(idx)}
                    disabled={pending}
                    className="text-xs text-red-600 hover:underline disabled:opacity-50 dark:text-red-400"
                  >
                    Remove
                  </button>
                )}
              </div>
              <label className="block">
                <span className="text-xs text-zinc-500">Full name</span>
                <input
                  value={b.fullName}
                  onChange={(e) => updateBeneficiary(idx, { fullName: e.target.value })}
                  disabled={pending}
                  className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  placeholder="Jane Doe"
                />
              </label>
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs text-zinc-500">Date of birth</span>
                  <input
                    type="date"
                    value={b.dateOfBirth}
                    onChange={(e) => updateBeneficiary(idx, { dateOfBirth: e.target.value })}
                    disabled={pending}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="block">
                  <span className="text-xs text-zinc-500">Relationship</span>
                  <input
                    value={b.relationship}
                    onChange={(e) => updateBeneficiary(idx, { relationship: e.target.value })}
                    disabled={pending}
                    className="mt-1 w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    placeholder="e.g. son, daughter"
                  />
                </label>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={b.isIncapacitated}
                  onChange={(e) => updateBeneficiary(idx, { isIncapacitated: e.target.checked })}
                  disabled={pending}
                />
                <span>Mentally incapacitated</span>
              </label>
            </div>
          ))}
          <button
            type="button"
            onClick={addBeneficiary}
            disabled={pending}
            className="rounded-md border border-violet-300 px-3 py-1 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-700 dark:text-violet-300 dark:hover:bg-violet-900/40"
          >
            + Add another beneficiary
          </button>
        </div>
      )}

      {err && <div className="text-sm text-red-700 dark:text-red-300">{err}</div>}
      <button
        type="button"
        onClick={onSave}
        disabled={pending}
        className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50"
      >
        {pending ? 'Saving…' : 'Save & continue'}
      </button>
    </div>
  );
}

function ConnectStep({
  title,
  body,
  cta,
  skipLabel,
  onAdvance,
}: {
  title: string;
  body: string;
  cta: { href: string; label: string };
  skipLabel: string;
  onAdvance: () => void | Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium">{title}</div>
      <p className="text-zinc-600 dark:text-zinc-400">{body}</p>
      <div className="flex flex-wrap gap-2">
        <Link
          href={cta.href}
          target="_blank"
          className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
        >
          {cta.label} ↗
        </Link>
        <button
          type="button"
          onClick={() => startTransition(async () => onAdvance())}
          disabled={pending}
          className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          {pending ? '…' : skipLabel}
        </button>
      </div>
    </div>
  );
}

function ContinueOrSkip({
  primaryLabel,
  onAdvance,
}: {
  primaryLabel: string;
  onAdvance: () => void | Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  return (
    <button
      type="button"
      onClick={() => startTransition(async () => onAdvance())}
      disabled={pending}
      className="rounded-md border border-violet-300 bg-violet-50 px-3 py-1.5 text-sm font-medium text-violet-900 hover:bg-violet-100 disabled:opacity-50 dark:border-violet-800 dark:bg-violet-950/30 dark:text-violet-100 dark:hover:bg-violet-900/40"
    >
      {pending ? '…' : `${primaryLabel} →`}
    </button>
  );
}

function ReviewStep({
  status,
  onComplete,
}: {
  status: OnboardingStatusView;
  onComplete: () => void | Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const items: Array<{ label: string; value: string; ok: boolean }> = [
    { label: 'Business name', value: status.organizationName, ok: !!status.organizationName },
    { label: 'Description', value: status.businessDescription ?? '—', ok: !!status.businessDescription },
    { label: 'Plaid accounts (linked / in books)', value: `${status.signals.plaidAccountsLinked} / ${status.signals.plaidAccountsInScope}`, ok: status.signals.plaidAccountsInScope > 0 },
    { label: 'Bank statements', value: String(status.signals.bankStatementsImported), ok: status.signals.bankStatementsImported > 0 },
    { label: 'Receipts', value: String(status.signals.receiptsUploaded), ok: status.signals.receiptsUploaded > 0 },
  ];
  return (
    <div className="space-y-3 text-sm">
      <div className="font-medium">Review</div>
      <ul className="divide-y divide-zinc-100 rounded-md border border-zinc-200 dark:divide-zinc-800 dark:border-zinc-800">
        {items.map((i) => (
          <li key={i.label} className="flex items-center justify-between gap-3 px-3 py-2">
            <span className="text-zinc-600 dark:text-zinc-400">{i.label}</span>
            <span className="flex items-center gap-2">
              <span className="max-w-xs truncate text-right text-zinc-700 dark:text-zinc-300">{i.value}</span>
              <span className={i.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'}>{i.ok ? '✓' : '○'}</span>
            </span>
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => startTransition(async () => onComplete())}
        disabled={pending}
        className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-50"
      >
        {pending ? '…' : 'Mark onboarding complete'}
      </button>
    </div>
  );
}
