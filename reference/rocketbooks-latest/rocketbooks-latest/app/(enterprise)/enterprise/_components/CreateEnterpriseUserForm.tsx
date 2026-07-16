'use client';

import { useState } from 'react';
import Link from 'next/link';
import { createEnterpriseUserAction } from '../_actions/createUser';
import { startFirmBillingSetupAction } from '../_actions/firmBilling';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS, type AccountingTierKey } from '@/lib/accounting/tiers';
import { WelcomeEmailEditor, type WelcomeEmailConfig } from './WelcomeEmailEditor';
import { BookingSetupModal } from './BookingSetupModal';

interface PermissionSetOption {
  id: string;
  name: string;
}

interface Props {
  permissionSets: PermissionSetOption[];
  enterpriseId: string;
  enterpriseName: string;
  /**
   * True when the signed-in actor is an enterprise_owner_demo user. Demo
   * owners can only create one Paying User client with an org "now", so
   * the form trims away every choice the server would reject anyway --
   * Enterprise Owner / Staff disabled, orgMode forced to "now", and the
   * permission-set dropdown narrowed to Paying User.
   */
  isDemoOwner?: boolean;
  /** Firm's default who-pays + pricing — defaults the per-client controls. */
  clientBillingMode?: string | null;
  clientPriceMode?: string | null;
  /** Firm-pays per client is only offered to Private Label firms. */
  privateLabelEnabled?: boolean;
  /** Firm branding + welcome-email defaults for the per-client experience controls. */
  logoUrl?: string | null;
  firmName?: string;
  brandColor?: string;
  aiName?: string;
  firmBookingUrl?: string;
  firmWelcomeEmailConfig?: WelcomeEmailConfig | null;
  firmWelcomeEmailConfigSwitching?: WelcomeEmailConfig | null;
  /** Whether the firm has a card on file — required before firm-pays clients can be created. */
  firmHasCard?: boolean;
}

export function CreateEnterpriseUserForm({
  permissionSets,
  enterpriseId,
  enterpriseName,
  isDemoOwner = false,
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
}: Props) {
  // Enterprise users overwhelmingly create Paying Users, so pre-select that
  // type + matching role checkbox. Default the org-creation mode to "later"
  // so the client sets up their own books on first sign-in. Demo owners
  // start at "now" since the server requires it.
  const payingUserPermSetId = permissionSets.find((p) => p.name.toLowerCase() === 'paying user')?.id ?? '';
  const visiblePermSets = isDemoOwner
    ? permissionSets.filter((p) => p.name.toLowerCase() === 'paying user')
    : permissionSets;

  const [roles, setRoles] = useState({
    enterpriseOwner: false,
    enterpriseStaff: false,
    payingUser: true,
  });
  const [permissionSetId, setPermissionSetId] = useState<string>(payingUserPermSetId);
  const [passwordMode, setPasswordMode] = useState<'invite' | 'auto' | 'manual'>('invite');
  const [orgMode, setOrgMode] = useState<'now' | 'later'>(isDemoOwner ? 'now' : 'later');
  const [billingChoice, setBillingChoice] = useState<'client_pays' | 'firm_pays'>(
    clientBillingMode === 'firm_pays' && privateLabelEnabled ? 'firm_pays' : 'client_pays',
  );
  const [priceChoice, setPriceChoice] = useState<'standard_referral' | 'discount_69'>(
    clientPriceMode === 'discount_69' ? 'discount_69' : 'standard_referral',
  );
  const [clientType, setClientType] = useState<'new' | 'switching'>('new');
  const [accountingTier, setAccountingTier] = useState<AccountingTierKey>('starter');
  // New-client setup + welcome-email + booking overrides for this client (default
  // to AI self-onboarding; email/booking default from the firm's settings).
  const [handoff, setHandoff] = useState<'self' | 'meeting' | 'pro'>('self');
  const [clientBookingUrl, setClientBookingUrl] = useState(firmBookingUrl || '');
  const [welcomeEmailConfig, setWelcomeEmailConfig] = useState<WelcomeEmailConfig | null>(firmWelcomeEmailConfig);
  const [welcomeEmailConfigSwitching, setWelcomeEmailConfigSwitching] = useState<WelcomeEmailConfig | null>(
    firmWelcomeEmailConfigSwitching,
  );
  const [bookingModalOpen, setBookingModalOpen] = useState(false);

  const toggleRole = (k: keyof typeof roles) => setRoles((r) => ({ ...r, [k]: !r[k] }));
  const noneSelected = !roles.enterpriseOwner && !roles.enterpriseStaff && !roles.payingUser;

  // Plan price for a tier — the DISCOUNTED rate when the firm pays or the pro
  // chose the discounted rate, else standard. Keeps plan + pricing consistent.
  const planPriceLabel = (key: AccountingTierKey) => {
    const t = ACCOUNTING_TIERS[key];
    const discounted = billingChoice === 'firm_pays' || priceChoice === 'discount_69';
    return `$${Math.round((discounted ? t.reducedPriceCents : t.priceCents) / 100)}/mo`;
  };
  // When the firm pays, what it's billed for this client = the selected tier's reduced price.
  const firmMonthlyPerClient = Math.round(ACCOUNTING_TIERS[accountingTier].reducedPriceCents / 100);

  // Picking a permission set in the dropdown auto-selects the matching role
  // checkbox (and clears the others). Choosing "— None —" leaves roles alone
  // so a user mid-edit doesn't lose their selection.
  const onPermissionSetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const id = e.target.value;
    setPermissionSetId(id);
    if (!id) return;
    const name = permissionSets.find((p) => p.id === id)?.name.toLowerCase() ?? '';
    if (name === 'paying user') {
      setRoles({ payingUser: true, enterpriseOwner: false, enterpriseStaff: false });
    } else if (name === 'enterprise owner') {
      setRoles({ payingUser: false, enterpriseOwner: true, enterpriseStaff: false });
    } else if (name === 'enterprise staff') {
      setRoles({ payingUser: false, enterpriseOwner: false, enterpriseStaff: true });
    }
  };

  return (
    <form action={createEnterpriseUserAction} className="flex flex-col gap-6">
      <input type="hidden" name="enterpriseId" value={enterpriseId} />

      <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Full name <span className="text-red-500">*</span></span>
          <input
            type="text"
            name="fullName"
            required
            placeholder="John Doe"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Email <span className="text-red-500">*</span></span>
          <input
            type="email"
            name="email"
            required
            placeholder="user@example.com"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </section>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">User Type (Permission Set)</span>
        <select
          name="permissionSetId"
          value={permissionSetId}
          onChange={onPermissionSetChange}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="">— None —</option>
          {visiblePermSets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">
          {isDemoOwner
            ? 'Demo trial — only Paying User is available; no charges apply.'
            : 'Optional — picking a type also selects the matching role below.'}
        </span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">Password Setup</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="passwordMode" value="invite" checked={passwordMode === 'invite'} onChange={() => setPasswordMode('invite')} />
          <span>User will create password on first login (invite email)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="passwordMode" value="auto" checked={passwordMode === 'auto'} onChange={() => setPasswordMode('auto')} />
          <span>Auto-generate strong password (shown once after creation)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" name="passwordMode" value="manual" checked={passwordMode === 'manual'} onChange={() => setPasswordMode('manual')} />
          <span>Admin sets password manually</span>
        </label>
        {passwordMode === 'manual' && (
          <input
            type="password"
            name="password"
            minLength={8}
            required
            placeholder="At least 8 characters"
            className="mt-1 max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        )}
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">User Roles</legend>
        <label className={`flex items-center gap-2 text-sm ${isDemoOwner ? 'cursor-not-allowed' : ''}`}>
          {/* Demo mode: keep the input enabled (disabled inputs don't
              submit, which would trip "Pick at least one role" on the
              server). Lock the toggle by making onChange a no-op and
              dim visually via the label cursor. */}
          <input
            type="checkbox"
            name="role_payingUser"
            checked={roles.payingUser}
            onChange={() => {
              if (isDemoOwner) return;
              toggleRole('payingUser');
            }}
            aria-readonly={isDemoOwner || undefined}
          />
          <span>{isDemoOwner ? 'Paying User (demo)' : 'Paying User'}</span>
          <span className="text-xs text-zinc-500">
            {isDemoOwner
              ? '— your one demo client; no charges, 7-day full-access trial'
              : '— client of this enterprise; pays the bill'}
          </span>
        </label>
        <label className={`flex items-center gap-2 text-sm ${isDemoOwner ? 'opacity-50' : ''}`}>
          <input
            type="checkbox"
            name="role_enterpriseOwner"
            checked={roles.enterpriseOwner}
            disabled={isDemoOwner}
            onChange={() => toggleRole('enterpriseOwner')}
          />
          <span>Enterprise Owner</span>
          <span className="text-xs text-zinc-500">
            {isDemoOwner
              ? '— disabled in demo; upgrade to add more users'
              : '— additional owner of this enterprise'}
          </span>
        </label>
        <label className={`flex items-center gap-2 text-sm ${isDemoOwner ? 'opacity-50' : ''}`}>
          <input
            type="checkbox"
            name="role_enterpriseStaff"
            checked={roles.enterpriseStaff}
            disabled={isDemoOwner}
            onChange={() => toggleRole('enterpriseStaff')}
          />
          <span>Enterprise Staff</span>
          <span className="text-xs text-zinc-500">
            {isDemoOwner
              ? '— disabled in demo; upgrade to add more users'
              : '— works inside this enterprise (sees its clients)'}
          </span>
        </label>
        {noneSelected && (
          <span className="text-xs text-red-600 dark:text-red-400">Pick at least one role.</span>
        )}
      </fieldset>

      <section className="rounded-md border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
        <h3 className="mb-1 text-sm font-medium">Enterprise</h3>
        <p className="mb-2 text-xs text-zinc-500">
          This user will be added to <span className="font-medium text-zinc-700 dark:text-zinc-300">{enterpriseName}</span>.
          You can only create users for your own enterprise.
        </p>

        {roles.payingUser && (
          <div className="mt-4 flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <h4 className="text-sm font-medium">Who is paying?</h4>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientBillingMode" value="client_pays" checked={billingChoice === 'client_pays'} onChange={() => setBillingChoice('client_pays')} className="accent-blue-600" />
                My client pays directly in the platform
              </label>
              {privateLabelEnabled && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="radio" name="clientBillingMode" value="firm_pays" checked={billingChoice === 'firm_pays'} onChange={() => setBillingChoice('firm_pays')} className="accent-blue-600" />
                  I pay for this client
                </label>
              )}
              {billingChoice === 'firm_pays' && firmHasCard && (
                <div className="mt-1 rounded-md border border-blue-200 bg-blue-50/70 px-3 py-2 text-sm text-blue-800 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-200">
                  You pay for this client — <span className="font-semibold">${firmMonthlyPerClient}/mo</span> ({ACCOUNTING_TIERS[accountingTier].label} plan) billed to your firm&apos;s card on file.
                </div>
              )}
              {billingChoice === 'firm_pays' && !firmHasCard && (
                <div className="mt-1 rounded-md border border-amber-300 bg-amber-50/70 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                  <p className="font-medium">Add your firm&apos;s card to cover clients.</p>
                  <p className="mt-0.5 text-xs text-amber-800/80 dark:text-amber-300/80">
                    You&apos;re covering this client, but your firm has no card on file — so you can&apos;t create it yet. Set up billing first (you&apos;ll come right back).
                  </p>
                  <input type="hidden" name="returnPath" value="/enterprise/clients/new" />
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
              {billingChoice === 'client_pays' && (
                <div className="mt-1 flex flex-col gap-1.5 border-t border-zinc-200 pt-2 dark:border-zinc-800">
                  <div className="text-xs font-medium uppercase tracking-wide text-zinc-500">Client pricing</div>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="clientPriceMode" value="discount_69" checked={priceChoice === 'discount_69'} onChange={() => setPriceChoice('discount_69')} className="accent-blue-600" />
                    Give this client the discounted rate
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input type="radio" name="clientPriceMode" value="standard_referral" checked={priceChoice === 'standard_referral'} onChange={() => setPriceChoice('standard_referral')} className="accent-blue-600" />
                    Charge the standard rate and take the referral fee
                  </label>
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Plan</span>
              <select
                name="accountingTier"
                value={accountingTier}
                onChange={(e) => setAccountingTier(e.target.value as AccountingTierKey)}
                className="max-w-md rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                {ACCOUNTING_TIER_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {ACCOUNTING_TIERS[key].label} — {planPriceLabel(key)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-zinc-500">The tier this client is on — the price follows the pricing choice above.</span>
            </label>

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">Client type</h4>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientType" value="new" checked={clientType === 'new'} onChange={() => setClientType('new')} className="accent-blue-600" />
                New client
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientType" value="switching" checked={clientType === 'switching'} onChange={() => setClientType('switching')} className="accent-blue-600" />
                Switching from another system
              </label>
              <span className="text-xs text-zinc-500">Picks which welcome email this client receives.</span>
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">New-client setup</h4>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientOnboardingHandoff" value="self" checked={handoff === 'self'} onChange={() => setHandoff('self')} className="accent-blue-600" />
                The AI onboards the client
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientOnboardingHandoff" value="meeting" checked={handoff === 'meeting'} onChange={() => setHandoff('meeting')} className="accent-blue-600" />
                AI books a setup meeting with me
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="clientOnboardingHandoff" value="pro" checked={handoff === 'pro'} onChange={() => setHandoff('pro')} className="accent-blue-600" />
                I set up this client myself
              </label>
              <span className="text-xs text-zinc-500">Sets how this client gets onboarded — and which welcome email they receive.</span>
            </div>

            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-medium">Client welcome email</h4>
              <p className="text-xs text-zinc-500">Customize the email this client receives. Defaults to your firm&apos;s copy.</p>
              {handoff === 'meeting' && (
                <div className="rounded-lg border-2 border-blue-300 bg-blue-50/70 p-3 dark:border-blue-800 dark:bg-blue-950/20">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="flex h-6 w-6 items-center justify-center rounded-full bg-blue-600 text-xs" aria-hidden>📅</span>
                    <span className="text-sm font-semibold text-blue-900 dark:text-blue-100">Where should clients book?</span>
                  </div>
                  <p className="mb-2 text-xs text-blue-800/70 dark:text-blue-200/70">This link powers the &quot;Book your setup call&quot; button in the welcome email.</p>
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
            <h4 className="text-sm font-medium">Organization Creation Mode</h4>
            <label className="flex items-center gap-2 text-sm">
              <input type="radio" name="orgMode" value="now" checked={orgMode === 'now'} onChange={() => setOrgMode('now')} />
              <span>Create organization now</span>
            </label>
            {!isDemoOwner && (
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="orgMode" value="later" checked={orgMode === 'later'} onChange={() => setOrgMode('later')} />
                <span>User to create (user will create organizations later)</span>
              </label>
            )}
            <span className="text-xs text-zinc-500">
              {isDemoOwner
                ? 'Demo trial — the client\'s company is created now so the 7-day trial can start.'
                : 'Controls who creates the organizations (books) for this user.'}
            </span>

            {orgMode === 'now' && (
              <div className="mt-2 flex flex-col gap-3 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Company Name <span className="text-red-500">*</span></span>
                  <input
                    type="text"
                    name="companyName"
                    placeholder="Acme Inc"
                    required={orgMode === 'now'}
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Company Type</span>
                  <input
                    type="text"
                    name="companyType"
                    placeholder="LLC, Corporation, etc."
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Industry</span>
                  <input
                    type="text"
                    name="industry"
                    placeholder="Technology, Healthcare, etc."
                    className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                  />
                </label>
              </div>
            )}

            {/* Submit the controlled welcome-email + booking overrides. */}
            <input type="hidden" name="clientBookingUrl" value={clientBookingUrl} />
            <input type="hidden" name="welcomeEmailConfig" value={welcomeEmailConfig ? JSON.stringify(welcomeEmailConfig) : ''} />
            <input
              type="hidden"
              name="welcomeEmailConfigSwitching"
              value={welcomeEmailConfigSwitching ? JSON.stringify(welcomeEmailConfigSwitching) : ''}
            />
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
      </section>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <Link
          href="/enterprise/clients"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={noneSelected || (roles.payingUser && billingChoice === 'firm_pays' && !firmHasCard)}
          title={roles.payingUser && billingChoice === 'firm_pays' && !firmHasCard ? 'Add your firm card first' : undefined}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Create User
        </button>
      </div>
    </form>
  );
}
