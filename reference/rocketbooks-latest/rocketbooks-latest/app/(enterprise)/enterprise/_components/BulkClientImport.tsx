'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import readXlsxFile from 'read-excel-file/browser';
import {
  bulkImportClientsAction,
  type BulkImportRow,
  type BulkImportResult,
} from '../_actions/bulkImportClients';
import { extractClientsFromImageAction } from '../_actions/extractClients';
import { startFirmBillingSetupAction } from '../_actions/firmBilling';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS, type AccountingTierKey } from '@/lib/accounting/tiers';
import { WelcomeEmailEditor, type WelcomeEmailConfig } from './WelcomeEmailEditor';
import { BookingSetupModal } from './BookingSetupModal';

/** Serialize rows back into the editable "Name, Email, Company" textarea format. */
function rowsToText(rows: BulkImportRow[]): string {
  return rows.map((r) => [r.fullName, r.email, r.companyName ?? ''].join(', ')).join('\n');
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('Could not read file'));
    fr.readAsDataURL(file);
  });
}

function parseClients(text: string): { rows: BulkImportRow[]; invalid: number } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return { rows: [], invalid: 0 };
  // Drop a header row if the first line looks like one.
  const first = lines[0].toLowerCase();
  const start = first.includes('email') && (first.includes('name') || first.includes('company')) ? 1 : 0;

  const rows: BulkImportRow[] = [];
  let invalid = 0;
  for (const line of lines.slice(start)) {
    const parts = line.split(',').map((s) => s.trim());
    let name = '';
    let email = '';
    let company = '';
    if (parts.length === 1) {
      if (parts[0].includes('@')) {
        email = parts[0];
        name = email.split('@')[0];
      }
    } else {
      name = parts[0];
      email = parts[1] ?? '';
      company = parts[2] ?? '';
      // tolerate "email, name" order
      if (!email.includes('@') && name.includes('@')) {
        const t = email;
        email = name;
        name = t || email.split('@')[0];
      }
    }
    if (!email.includes('@')) {
      invalid++;
      continue;
    }
    if (!name) name = email.split('@')[0];
    rows.push({ fullName: name, email, companyName: company || undefined });
  }
  return { rows, invalid };
}

export function BulkClientImport({
  clientBillingMode = null,
  clientPriceMode = null,
  privateLabelEnabled = false,
  logoUrl = null,
  firmName = 'your firm',
  brandColor = '#2563eb',
  aiName = 'your assistant',
  firmBookingUrl = '',
  firmWelcomeEmailConfig = null,
  firmWelcomeEmailConfigSwitching = null,
  firmHasCard = true,
}: {
  clientBillingMode?: string | null;
  clientPriceMode?: string | null;
  privateLabelEnabled?: boolean;
  logoUrl?: string | null;
  firmName?: string;
  brandColor?: string;
  aiName?: string;
  firmBookingUrl?: string;
  firmWelcomeEmailConfig?: WelcomeEmailConfig | null;
  firmWelcomeEmailConfigSwitching?: WelcomeEmailConfig | null;
  firmHasCard?: boolean;
} = {}) {
  const router = useRouter();
  const [text, setText] = useState('');
  const [importing, setImporting] = useState(false);
  const [reading, setReading] = useState<null | string>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [result, setResult] = useState<BulkImportResult | null>(null);
  // Default the who-pays + pricing choice from the firm's own settings; the pro
  // can override for this import. firm_pays only offered with Private Label.
  const [billingChoice, setBillingChoice] = useState<'client_pays' | 'firm_pays'>(
    clientBillingMode === 'firm_pays' && privateLabelEnabled ? 'firm_pays' : 'client_pays',
  );
  const [priceChoice, setPriceChoice] = useState<'standard_referral' | 'discount_69'>(
    clientPriceMode === 'discount_69' ? 'discount_69' : 'standard_referral',
  );
  const [clientType, setClientType] = useState<'new' | 'switching'>('new');
  const [accountingTier, setAccountingTier] = useState<AccountingTierKey>('starter');
  // How these imported clients get onboarded — drives their welcome email copy.
  // Defaults to AI self-onboarding for imports.
  const [handoff, setHandoff] = useState<'self' | 'meeting' | 'pro'>('self');
  // Welcome-email + booking overrides for THIS import — default from the firm's
  // own settings; edits apply only to this import (via inviteEnterpriseClient's
  // emailOverride). null config = use the handoff-derived default copy.
  const [clientBookingUrl, setClientBookingUrl] = useState(firmBookingUrl || '');
  const [welcomeEmailConfig, setWelcomeEmailConfig] = useState<WelcomeEmailConfig | null>(firmWelcomeEmailConfig);
  const [welcomeEmailConfigSwitching, setWelcomeEmailConfigSwitching] = useState<WelcomeEmailConfig | null>(
    firmWelcomeEmailConfigSwitching,
  );
  const [bookingModalOpen, setBookingModalOpen] = useState(false);

  const { rows, invalid } = useMemo(() => parseClients(text), [text]);

  // The plan-picker price for one tier — the DISCOUNTED rate when the firm pays
  // (clients get the discounted rate) or when the pro chose the discounted rate;
  // the standard rate only when clients pay the standard-plus-referral rate.
  const planPriceLabel = (key: AccountingTierKey) => {
    const t = ACCOUNTING_TIERS[key];
    const discounted = billingChoice === 'firm_pays' || priceChoice === 'discount_69';
    const cents = discounted ? t.reducedPriceCents : t.priceCents;
    return `$${Math.round(cents / 100)}/mo`;
  };
  // When the firm pays, what it's billed per client = the selected tier's reduced price.
  const firmMonthlyPerClient = Math.round(ACCOUNTING_TIERS[accountingTier].reducedPriceCents / 100);

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    setReadError(null);
    const name = file.name.toLowerCase();
    try {
      if (file.type.startsWith('image/')) {
        setReading('Reading image with AI…');
        const dataUrl = await readAsDataUrl(file);
        const res = await extractClientsFromImageAction(dataUrl);
        if (res.error) setReadError(res.error);
        else if (res.rows.length === 0) setReadError('No clients found in that image.');
        else setText((prev) => (prev.trim() ? prev + '\n' : '') + rowsToText(res.rows));
      } else if (name.endsWith('.xlsx') || name.endsWith('.xls') || file.type.includes('spreadsheet') || file.type.includes('excel')) {
        setReading('Reading spreadsheet…');
        const sheet = (await readXlsxFile(file)) as unknown as unknown[][];
        const csv = sheet
          .map((r) => r.map((c) => (c == null ? '' : String(c))).join(', '))
          .join('\n');
        setText(csv);
      } else {
        setText(await file.text());
      }
    } catch (err) {
      setReadError(err instanceof Error ? err.message : 'Could not read that file.');
    } finally {
      setReading(null);
    }
  }

  async function run() {
    if (!rows.length) return;
    setImporting(true);
    setResult(null);
    const batch = {
      clientType,
      accountingTier,
      clientBillingMode: billingChoice,
      clientPriceMode: billingChoice === 'client_pays' ? priceChoice : null,
      clientOnboardingHandoff: handoff,
      clientBookingUrl: clientBookingUrl.trim() || null,
      welcomeEmailConfig,
      welcomeEmailConfigSwitching,
    };
    const res = await bulkImportClientsAction(rows, batch);
    setImporting(false);
    setResult(res);
    router.refresh();
  }

  const problems = result?.results.filter((r) => r.status !== 'created') ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Add one client per line as <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">Name, Email, Company</code>{' '}
          (Company optional). Each client gets an email invite. Paste a list, or upload a{' '}
          <strong>CSV, Excel, or a photo/screenshot</strong> of your client list — our AI reads it into the
          table below for you to review before importing.
        </p>
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1.5 text-sm font-medium">Who is paying?</div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkBilling" checked={billingChoice === 'client_pays'} onChange={() => setBillingChoice('client_pays')} className="accent-blue-600" />
              My clients pay directly in the platform
            </label>
            {privateLabelEnabled && (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="bulkBilling" checked={billingChoice === 'firm_pays'} onChange={() => setBillingChoice('firm_pays')} className="accent-blue-600" />
                I pay for these clients
              </label>
            )}
          </div>
          {billingChoice === 'firm_pays' && firmHasCard && (
            <p className="mt-2 rounded border border-amber-200 bg-amber-50/60 px-2 py-1.5 text-xs text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200">
              We&apos;ll bill your firm&apos;s card the plan rate for each of these clients — the charge starts when they&apos;re imported.
            </p>
          )}
          {billingChoice === 'firm_pays' && !firmHasCard && (
            <div className="mt-2 rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              <p className="font-medium">Add your firm&apos;s card to cover clients.</p>
              <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
                You&apos;re covering these clients, but your firm has no card on file — so you can&apos;t import them yet. Set up billing first (you&apos;ll come right back).
              </p>
              <form action={startFirmBillingSetupAction} className="mt-2">
                <input type="hidden" name="returnPath" value="/enterprise/clients/import" />
                <button type="submit" className="inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
                  Set up firm billing →
                </button>
              </form>
            </div>
          )}
          {billingChoice === 'client_pays' && (
            <div className="mt-2 flex flex-col gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
              <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Client pricing</div>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="bulkPrice" checked={priceChoice === 'discount_69'} onChange={() => setPriceChoice('discount_69')} className="accent-blue-600" />
                Give clients the discounted rate
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="bulkPrice" checked={priceChoice === 'standard_referral'} onChange={() => setPriceChoice('standard_referral')} className="accent-blue-600" />
                Charge the standard rate and take the referral fee
              </label>
              <span className="text-xs text-zinc-400">The plan prices below update to match.</span>
            </div>
          )}
          <span className="mt-2 block text-xs text-zinc-500">Applies to everyone in this import. You can change individual clients later.</span>
        </div>
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1.5 text-sm font-medium">Plan for these clients</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            {ACCOUNTING_TIER_KEYS.map((key) => {
              const tier = ACCOUNTING_TIERS[key];
              return (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="bulkAccountingTier"
                    checked={accountingTier === key}
                    onChange={() => setAccountingTier(key)}
                    className="accent-blue-600"
                  />
                  {tier.label} <span className="text-zinc-500">({planPriceLabel(key)})</span>
                </label>
              );
            })}
          </div>
          <span className="text-xs text-zinc-500">Which tier these clients are on — the price follows your client-pricing choice above.</span>
        </div>
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1.5 text-sm font-medium">These clients are…</div>
          <div className="flex flex-wrap gap-x-6 gap-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkClientType" checked={clientType === 'new'} onChange={() => setClientType('new')} className="accent-blue-600" />
              New clients
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkClientType" checked={clientType === 'switching'} onChange={() => setClientType('switching')} className="accent-blue-600" />
              Switching from another system
            </label>
          </div>
          <span className="text-xs text-zinc-500">Picks which welcome email everyone in this import receives.</span>
        </div>
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1.5 text-sm font-medium">New-client setup</div>
          <div className="flex flex-col gap-1.5">
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkHandoff" checked={handoff === 'self'} onChange={() => setHandoff('self')} className="accent-blue-600" />
              The AI onboards the client
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkHandoff" checked={handoff === 'meeting'} onChange={() => setHandoff('meeting')} className="accent-blue-600" />
              AI books a setup meeting with me
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="bulkHandoff" checked={handoff === 'pro'} onChange={() => setHandoff('pro')} className="accent-blue-600" />
              I set up each client myself
            </label>
          </div>
          <span className="mt-2 block text-xs text-zinc-500">Sets how these clients get onboarded — and which welcome email they receive.</span>
        </div>
        <div className="mb-3 rounded-md border border-zinc-200 bg-zinc-50/60 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
          <div className="mb-1.5 text-sm font-medium">Client welcome email</div>
          <p className="mb-2.5 text-xs text-zinc-500">
            Customize the email these clients receive. Defaults to your firm&apos;s copy — edits apply to this import only.
          </p>
          {handoff === 'meeting' && (
            <div className="mb-3 rounded-lg border-2 border-blue-300 bg-blue-50/70 p-3 dark:border-blue-800 dark:bg-blue-950/20">
              <div className="mb-1 flex items-center gap-2">
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs" aria-hidden>
                  📅
                </span>
                <span className="text-sm font-semibold text-blue-900 dark:text-blue-100">Where should clients book?</span>
              </div>
              <p className="mb-2 text-xs text-blue-800/70 dark:text-blue-200/70">
                This link powers the &quot;Book your setup call&quot; button in the welcome email.
              </p>
              <input
                value={clientBookingUrl}
                onChange={(e) => setClientBookingUrl(e.target.value)}
                placeholder="Paste your Calendly / scheduling link"
                className="w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
              <button
                type="button"
                onClick={() => setBookingModalOpen(true)}
                className="mt-2 inline-flex items-center rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
              >
                Set up a RocketBooks booking page →
              </button>
            </div>
          )}
          <WelcomeEmailEditor
            logoUrl={logoUrl}
            firmName={firmName}
            brandColor={brandColor}
            aiName={aiName}
            handoff={handoff}
            configNew={welcomeEmailConfig}
            configSwitching={welcomeEmailConfigSwitching}
            onChangeNew={setWelcomeEmailConfig}
            onChangeSwitching={setWelcomeEmailConfigSwitching}
          />
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={8}
          placeholder={'Jane Doe, jane@acme.com, Acme LLC\nJohn Smith, john@widgets.co'}
          className="w-full rounded-md border border-zinc-300 px-3 py-2 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        {readError && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{readError}</p>}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className={`rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900 ${reading ? 'cursor-default opacity-50' : 'cursor-pointer'}`}>
            {reading ? 'Reading…' : 'Upload file or photo'}
            <input
              type="file"
              accept=".csv,text/csv,text/plain,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,image/png,image/jpeg,image/webp,image/gif"
              onChange={onFile}
              disabled={!!reading}
              className="hidden"
            />
          </label>
          <span className="text-sm text-zinc-500">
            {reading ? reading : (
              <>
                {rows.length} ready{invalid > 0 && <span className="text-amber-600 dark:text-amber-400"> · {invalid} unparseable</span>}
              </>
            )}
          </span>
          <button
            type="button"
            onClick={run}
            disabled={importing || rows.length === 0 || (billingChoice === 'firm_pays' && !firmHasCard)}
            className="ml-auto rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
          >
            {importing ? 'Importing…' : `Import ${rows.length} ${rows.length === 1 ? 'client' : 'clients'}`}
          </button>
        </div>
      </div>

      {billingChoice === 'firm_pays' && rows.length > 0 && (
        <div className="mt-2 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
          You pay for {rows.length} client{rows.length === 1 ? '' : 's'} — {rows.length} × ${firmMonthlyPerClient}/mo ={' '}
          <span className="font-semibold">${(rows.length * firmMonthlyPerClient).toLocaleString()}/mo</span> billed to your firm.
        </div>
      )}

      {rows.length > 0 && !result && (
        <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Email</th>
                <th className="px-4 py-2">Company</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 20).map((r, i) => (
                <tr key={i} className="border-t border-zinc-100 dark:border-zinc-800">
                  <td className="px-4 py-2">{r.fullName}</td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{r.email}</td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">{r.companyName ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 20 && (
            <div className="border-t border-zinc-100 px-4 py-2 text-xs text-zinc-500 dark:border-zinc-800">
              + {rows.length - 20} more
            </div>
          )}
        </div>
      )}

      {result && (
        <div className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-950">
          <div className="flex flex-wrap gap-4 text-sm">
            <span className="font-medium text-emerald-700 dark:text-emerald-300">{result.created} created</span>
            <span className="text-zinc-500">{result.skipped} skipped</span>
            {result.failed > 0 && <span className="text-red-600 dark:text-red-400">{result.failed} failed</span>}
          </div>
          {result.needsFirmCardSetup && (
            <div className="mt-3 rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
              <p className="font-medium">Add your firm&apos;s card to start billing these clients.</p>
              <p className="mt-0.5 text-xs text-blue-700/80 dark:text-blue-300/80">
                You cover these clients, but no card is on file yet — nothing charges until you add one. We&apos;ll then bill your firm for each.
              </p>
              <form action={startFirmBillingSetupAction} className="mt-2">
                <input type="hidden" name="returnPath" value="/enterprise/clients" />
                <button type="submit" className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
                  Set up firm billing →
                </button>
              </form>
            </div>
          )}
          {problems.length > 0 && (
            <ul className="mt-3 divide-y divide-zinc-100 text-sm dark:divide-zinc-800">
              {problems.map((p, i) => (
                <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                  <span className="text-zinc-700 dark:text-zinc-300">{p.email}</span>
                  <span className={p.status === 'failed' ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}>
                    {p.status}{p.message ? ` — ${p.message}` : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4">
            <button
              type="button"
              onClick={() => router.push('/enterprise/clients')}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              View clients
            </button>
          </div>
        </div>
      )}

      {bookingModalOpen && (
        <BookingSetupModal
          onClose={() => setBookingModalOpen(false)}
          onUseLink={(url) => {
            setClientBookingUrl(url);
            setBookingModalOpen(false);
          }}
        />
      )}
    </div>
  );
}
