'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createClientCompanyAction } from '../_actions/createClientCompany';
import { startFirmBillingSetupAction } from '../_actions/firmBilling';
import { EmailPreview, defaultEmailCopy, type WelcomeEmailConfig } from './WelcomeEmailEditor';

interface FirmDefaults {
  enterpriseId: string;
  name: string;
  privateLabelEnabled: boolean;
  aiAssistantName: string;
  brandColorHex: string;
  logoUrl: string | null;
  clientBillingMode: string;
  clientPriceMode: string;
  clientOnboardingHandoff: string;
  clientBookingUrl: string;
  hasPaymentMethod: boolean;
  // Firm-wide default for who does the books: 'firm' | 'client' | 'both'. Pre-fills
  // the books step; 'both' means no default (the pro chooses).
  defaultBooksManagedBy: string;
}
interface ExistingClient {
  userId: string;
  name: string;
  email: string;
}
interface TierOption {
  key: string;
  label: string;
  standard: string;
  discounted: string;
}

const fieldCls =
  'w-full rounded-md border border-zinc-300 px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-900';

const COMPANY_TYPES = ['Sole proprietorship', 'LLC', 'S-Corporation', 'C-Corporation', 'Partnership', 'Nonprofit', 'Trust', 'Other'];

function Radio({
  name,
  checked,
  onChange,
  disabled,
  children,
}: {
  name: string;
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`flex items-start gap-2 text-sm ${disabled ? 'opacity-60' : ''}`}>
      <input
        type="radio"
        name={name}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        className="mt-0.5 accent-blue-600 disabled:opacity-50"
      />
      <span className="flex flex-col">{children}</span>
    </label>
  );
}

export function AddCompanyWizard({
  firm,
  clients,
  tiers,
  preselectedOwnerId,
}: {
  firm: FirmDefaults;
  clients: ExistingClient[];
  tiers: TierOption[];
  preselectedOwnerId: string | null;
}) {
  const [ownerMode, setOwnerMode] = useState<'existing' | 'new'>(clients.length > 0 ? 'existing' : 'new');
  const [ownerUserId, setOwnerUserId] = useState(preselectedOwnerId ?? clients[0]?.userId ?? '');
  const [newOwnerFullName, setNewOwnerFullName] = useState('');
  const [newOwnerEmail, setNewOwnerEmail] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [companyType, setCompanyType] = useState('LLC');
  const [industry, setIndustry] = useState('');
  const [accountingTier, setAccountingTier] = useState('');
  const [clientBillingMode, setClientBillingMode] = useState(
    firm.clientBillingMode === 'firm_pays' && firm.privateLabelEnabled ? 'firm_pays' : 'client_pays',
  );
  const [clientPriceMode, setClientPriceMode] = useState(
    firm.clientPriceMode === 'discount_69' ? 'discount_69' : 'standard_referral',
  );
  const [clientOnboardingHandoff, setClientOnboardingHandoff] = useState(firm.clientOnboardingHandoff || 'self');
  const [aiAssistantName, setAiAssistantName] = useState(firm.aiAssistantName || '');
  const [clientBookingUrl, setClientBookingUrl] = useState(firm.clientBookingUrl || '');
  const [clientType, setClientType] = useState<'new' | 'switching'>('new');
  const [booksManagedBy, setBooksManagedBy] = useState(
    firm.defaultBooksManagedBy === 'firm' || firm.defaultBooksManagedBy === 'client'
      ? firm.defaultBooksManagedBy
      : '',
  );
  const [welcomeEmailConfig, setWelcomeEmailConfig] = useState<WelcomeEmailConfig | null>(null);
  const [welcomeEmailConfigSwitching, setWelcomeEmailConfigSwitching] = useState<WelcomeEmailConfig | null>(null);
  const [emailVariant, setEmailVariant] = useState<'new' | 'switching'>('new');

  const firmPaysNeedsCard = clientBillingMode === 'firm_pays' && !firm.hasPaymentMethod;
  // Plan price follows the pricing choice: discounted when the firm pays or the pro
  // chose the discounted rate, else standard.
  const planDiscounted = clientBillingMode === 'firm_pays' || clientPriceMode === 'discount_69';
  // When the firm pays, what it's billed for this client = the selected tier's discounted price.
  const firmTier = tiers.find((t) => t.key === accountingTier);
  // Required to create: an owner, a company name, and who-does-the-books.
  const canSubmit =
    (ownerMode === 'existing' ? !!ownerUserId : newOwnerFullName.trim().length > 0 && newOwnerEmail.includes('@')) &&
    companyName.trim().length > 0 &&
    (booksManagedBy === 'firm' || booksManagedBy === 'client') &&
    // Can't create a firm-paid client until the firm has a card on file.
    !firmPaysNeedsCard;

  return (
    <form action={createClientCompanyAction} className="flex flex-col gap-5">
      <div className="flex flex-col gap-6">
        {/* Owner */}
        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-col gap-4">
            <h3 className="text-lg font-semibold">Who owns this company?</h3>
            <div className="flex flex-col gap-3">
              <Radio name="ownerModeUI" checked={ownerMode === 'existing'} disabled={clients.length === 0} onChange={() => setOwnerMode('existing')}>
                <span>Use an existing client</span>
                {clients.length === 0 && <span className="text-xs text-zinc-500">No existing clients yet — add a new user below.</span>}
              </Radio>
              {ownerMode === 'existing' && clients.length > 0 && (
                <select value={ownerUserId} onChange={(e) => setOwnerUserId(e.target.value)} className={`${fieldCls} ml-6 max-w-md`}>
                  {clients.map((c) => (
                    <option key={c.userId} value={c.userId}>
                      {c.name} ({c.email})
                    </option>
                  ))}
                </select>
              )}
              <Radio name="ownerModeUI" checked={ownerMode === 'new'} onChange={() => setOwnerMode('new')}>
                <span>Add a new user</span>
              </Radio>
              {ownerMode === 'new' && (
                <div className="ml-6 flex max-w-md flex-col gap-2">
                  <input value={newOwnerFullName} onChange={(e) => setNewOwnerFullName(e.target.value)} placeholder="Full name" className={fieldCls} />
                  <input value={newOwnerEmail} onChange={(e) => setNewOwnerEmail(e.target.value)} placeholder="Email" type="email" className={fieldCls} />
                  <p className="text-xs text-zinc-400">We&rsquo;ll create their login and send a branded welcome email to get started.</p>
                </div>
              )}
            </div>
          </div>
        </section>

        {/* Business */}
        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex max-w-md flex-col gap-4">
            <h3 className="text-lg font-semibold">About the business</h3>
            <label className="block">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Company name</div>
              <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} placeholder="Acme LLC" className={fieldCls} />
            </label>
            <label className="block">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Company type</div>
              <select value={companyType} onChange={(e) => setCompanyType(e.target.value)} className={fieldCls}>
                {COMPANY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">What does it do?</div>
              <input value={industry} onChange={(e) => setIndustry(e.target.value)} placeholder="e.g. landscaping, SaaS, consulting" className={fieldCls} />
            </label>
          </div>
        </section>

        {/* Client billing */}
        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-col gap-4">
            <h3 className="text-lg font-semibold">Client billing</h3>
            <div>
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Who pays?</div>
              <div className="flex flex-col gap-2">
                <Radio name="billing" checked={clientBillingMode === 'client_pays'} onChange={() => setClientBillingMode('client_pays')}>
                  This client pays directly in the platform
                </Radio>
                <Radio
                  name="billing"
                  checked={clientBillingMode === 'firm_pays'}
                  disabled={!firm.privateLabelEnabled}
                  onChange={() => setClientBillingMode('firm_pays')}
                >
                  <span>
                    I pay for this client (and charge more for my service)
                    {!firm.privateLabelEnabled && (
                      <span className="ml-1 text-xs italic text-emerald-600 dark:text-emerald-400">— available with Private Label</span>
                    )}
                  </span>
                </Radio>
              </div>
            </div>
            {clientBillingMode === 'firm_pays' && firm.hasPaymentMethod && (
              <div className="rounded-md border border-blue-200 bg-blue-50/70 p-3 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                You pay for this client{firmTier ? <> — <span className="font-semibold">{firmTier.discounted}</span></> : ' — the plan amount you select below'} billed to your firm&rsquo;s card on file.
              </div>
            )}
            {clientBillingMode === 'firm_pays' && !firm.hasPaymentMethod && (
              <div className="rounded-md border border-amber-300 bg-amber-50/70 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                <p className="font-medium">Add your firm&rsquo;s card to cover clients.</p>
                <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
                  You&rsquo;re covering this client, but your firm has no card on file — so you can&rsquo;t create it yet. Set up billing first (you&rsquo;ll come right back).
                </p>
                <input type="hidden" name="returnPath" value="/enterprise/clients/add-company" />
                <button
                  type="submit"
                  formAction={startFirmBillingSetupAction}
                  formNoValidate
                  className="mt-2 inline-flex items-center rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
                >
                  Set up firm billing →
                </button>
              </div>
            )}
            {clientBillingMode === 'client_pays' && (
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Client pricing</div>
                <div className="flex flex-col gap-2">
                  <Radio name="price" checked={clientPriceMode === 'discount_69'} onChange={() => setClientPriceMode('discount_69')}>
                    Give this client the discounted rate
                  </Radio>
                  <Radio name="price" checked={clientPriceMode === 'standard_referral'} onChange={() => setClientPriceMode('standard_referral')}>
                    Charge the standard rate and take the referral fee
                  </Radio>
                </div>
              </div>
            )}
            <label className="block max-w-md">
              <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Plan</div>
              <select value={accountingTier} onChange={(e) => setAccountingTier(e.target.value)} className={fieldCls}>
                <option value="">Legacy $89 (no tier)</option>
                {tiers.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label} — {planDiscounted ? t.discounted : t.standard}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-zinc-500">The tier this client is on — the price follows the pricing choice above.</p>
            </label>
          </div>
        </section>

        {/* Client experience */}
        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-col gap-6 lg:flex-row">
            <div className="flex flex-col gap-4 lg:w-[26rem] lg:shrink-0">
              <h3 className="text-lg font-semibold">Client experience</h3>
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">New-client setup</div>
                <div className="flex flex-col gap-2">
                  <Radio name="handoff" checked={clientOnboardingHandoff === 'self'} onChange={() => setClientOnboardingHandoff('self')}>
                    The AI onboards the client
                  </Radio>
                  <Radio name="handoff" checked={clientOnboardingHandoff === 'meeting'} onChange={() => setClientOnboardingHandoff('meeting')}>
                    AI books a setup meeting with me
                  </Radio>
                  <Radio name="handoff" checked={clientOnboardingHandoff === 'pro'} onChange={() => setClientOnboardingHandoff('pro')}>
                    I set up this company myself
                  </Radio>
                </div>
              </div>
              <label className="block">
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">AI assistant name</div>
                <input
                  value={aiAssistantName}
                  onChange={(e) => setAiAssistantName(e.target.value)}
                  disabled={!firm.privateLabelEnabled}
                  placeholder="e.g. Scotty"
                  className={fieldCls}
                />
                <p className="mt-1 text-xs text-zinc-400">
                  The name clients see for your AI assistant{!firm.privateLabelEnabled && ' (available with Private Label)'}.
                </p>
              </label>
              {clientOnboardingHandoff === 'meeting' && (
                <label className="block">
                  <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Where should they book?</div>
                  <input
                    value={clientBookingUrl}
                    onChange={(e) => setClientBookingUrl(e.target.value)}
                    placeholder="Paste your Calendly / scheduling link"
                    className={fieldCls}
                  />
                </label>
              )}
              <div>
                <div className="mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Client type</div>
                <div className="flex gap-4">
                  <Radio name="clientTypeUI" checked={clientType === 'new'} onChange={() => { setClientType('new'); setEmailVariant('new'); }}>
                    New client
                  </Radio>
                  <Radio name="clientTypeUI" checked={clientType === 'switching'} onChange={() => { setClientType('switching'); setEmailVariant('switching'); }}>
                    Switching from another system
                  </Radio>
                </div>
              </div>
            </div>
            <div className="lg:flex lg:flex-1 lg:justify-center">
              <div className="w-full max-w-md">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Client welcome email</span>
                  <span className="text-xs text-zinc-400">Click any text to edit</span>
                </div>
                <div className="mb-2 inline-flex rounded-md border border-zinc-200 p-0.5 text-xs dark:border-zinc-800">
                  {(['new', 'switching'] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => setEmailVariant(v)}
                      className={`rounded px-2.5 py-1 font-medium transition ${
                        emailVariant === v ? 'bg-blue-600 text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
                      }`}
                    >
                      {v === 'new' ? 'New client' : 'Switching client'}
                    </button>
                  ))}
                </div>
                {(() => {
                  const firmName = firm.name?.trim() || 'your firm';
                  const ai = aiAssistantName?.trim() || 'your assistant';
                  const activeConfig = emailVariant === 'switching' ? welcomeEmailConfigSwitching : welcomeEmailConfig;
                  const setActive = emailVariant === 'switching' ? setWelcomeEmailConfigSwitching : setWelcomeEmailConfig;
                  const emailValue = activeConfig ?? defaultEmailCopy(clientOnboardingHandoff, emailVariant, firmName, ai);
                  return (
                    <EmailPreview
                      value={emailValue}
                      customized={activeConfig != null}
                      logoUrl={firm.logoUrl}
                      firm={firmName}
                      brandColor={firm.brandColorHex}
                      onChange={(next) => setActive(next)}
                      onReset={() => setActive(null)}
                    />
                  );
                })()}
              </div>
            </div>
          </div>
        </section>

        {/* Who does the books */}
        <section className="rounded-lg border border-zinc-200 p-5 dark:border-zinc-800">
          <div className="flex flex-col gap-4">
            <h3 className="text-lg font-semibold">Who does the books?</h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              This sets expectations for who keeps this company&rsquo;s books up to date.
            </p>
            <div className="flex flex-col gap-2">
              <Radio name="books" checked={booksManagedBy === 'firm'} onChange={() => setBooksManagedBy('firm')}>
                <span>My firm does the books for this company</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">You categorize, reconcile, and close each month.</span>
              </Radio>
              <Radio name="books" checked={booksManagedBy === 'client'} onChange={() => setBooksManagedBy('client')}>
                <span>The client does the books — we oversee and help</span>
                <span className="text-xs text-zinc-500 dark:text-zinc-400">The client keeps up the books; you review and assist.</span>
              </Radio>
            </div>
          </div>
        </section>
      </div>

      {/* Hidden fields carry all answers to the server action on submit. */}
      <input type="hidden" name="enterpriseId" value={firm.enterpriseId} />
      <input type="hidden" name="ownerMode" value={ownerMode} />
      <input type="hidden" name="ownerUserId" value={ownerMode === 'existing' ? ownerUserId : ''} />
      <input type="hidden" name="newOwnerFullName" value={ownerMode === 'new' ? newOwnerFullName : ''} />
      <input type="hidden" name="newOwnerEmail" value={ownerMode === 'new' ? newOwnerEmail : ''} />
      <input type="hidden" name="companyName" value={companyName} />
      <input type="hidden" name="companyType" value={companyType} />
      <input type="hidden" name="industry" value={industry} />
      <input type="hidden" name="accountingTier" value={accountingTier} />
      <input type="hidden" name="clientBillingMode" value={clientBillingMode} />
      <input type="hidden" name="clientPriceMode" value={clientBillingMode === 'client_pays' ? clientPriceMode : ''} />
      <input type="hidden" name="clientOnboardingHandoff" value={clientOnboardingHandoff} />
      <input type="hidden" name="aiAssistantName" value={aiAssistantName} />
      <input type="hidden" name="clientBookingUrl" value={clientBookingUrl} />
      <input type="hidden" name="clientType" value={clientType} />
      <input type="hidden" name="booksManagedBy" value={booksManagedBy} />
      <input type="hidden" name="welcomeEmailConfig" value={welcomeEmailConfig ? JSON.stringify(welcomeEmailConfig) : ''} />
      <input type="hidden" name="welcomeEmailConfigSwitching" value={welcomeEmailConfigSwitching ? JSON.stringify(welcomeEmailConfigSwitching) : ''} />

      {/* Submit */}
      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Link
          href="/enterprise/businesses"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {firmPaysNeedsCard ? 'Continue to payment' : 'Create company'}
        </button>
      </div>
    </form>
  );
}
