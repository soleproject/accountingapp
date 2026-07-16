'use client';

import { useState } from 'react';
import { createUserAction } from '../_actions/createUser';
import {
  ENTERPRISE_TIER_KEYS,
  ENTERPRISE_TIERS,
  type EnterpriseTierKey,
} from '@/lib/enterprise/tiers';

interface PermissionSetOption {
  id: string;
  name: string;
}

interface OrgOption {
  id: string;
  name: string;
}

interface EnterpriseOption extends OrgOption {
  tier: string | null;
}

interface Props {
  permissionSets: PermissionSetOption[];
  enterprises: EnterpriseOption[];
  organizations: OrgOption[];
}

export function CreateUserForm({ permissionSets, enterprises, organizations }: Props) {
  const [roles, setRoles] = useState({
    baseUser: false,
    enterpriseOwner: false,
    enterpriseOwnerDemo: false,
    enterpriseStaff: false,
    payingUser: true,
    supportUser: false,
  });
  const [passwordMode, setPasswordMode] = useState<'invite' | 'auto' | 'manual'>('invite');
  const [orgMode, setOrgMode] = useState<'now' | 'later'>('now');
  const [createNewEnterprise, setCreateNewEnterprise] = useState(false);
  const [selectedEnterpriseId, setSelectedEnterpriseId] = useState('');
  // '' = nothing picked yet, 'regular' = explicit no-tier (untiered/referral),
  // else one of the paid tier keys.
  const [tier, setTier] = useState<EnterpriseTierKey | 'regular' | ''>('');

  // When the user picks an existing enterprise that already has a tier,
  // lock the radio to that tier so this form never silently overwrites it.
  const selectedEnterprise = enterprises.find((e) => e.id === selectedEnterpriseId);
  const lockedTier: EnterpriseTierKey | null =
    selectedEnterprise && isTierKey(selectedEnterprise.tier) ? selectedEnterprise.tier : null;
  const tierIsLocked = !createNewEnterprise && lockedTier !== null;
  const effectiveTier: EnterpriseTierKey | 'regular' | '' = tierIsLocked ? lockedTier! : tier;

  const needsEnterprise = roles.enterpriseOwner || roles.enterpriseStaff || roles.payingUser;
  const tierRequired = roles.enterpriseOwner && createNewEnterprise;

  // Demo flips the form into a streamlined "auto-provision everything"
  // mode: enterprise is auto-created, the demo user can't combine with
  // other roles, and the standard enterprise picker disappears.
  const toggleRole = (k: keyof typeof roles) => setRoles((r) => {
    const next = { ...r, [k]: !r[k] };
    if (k === 'enterpriseOwnerDemo' && next.enterpriseOwnerDemo) {
      // Clear all other roles when turning demo on -- mutually exclusive.
      return {
        baseUser: false,
        enterpriseOwner: false,
        enterpriseOwnerDemo: true,
        enterpriseStaff: false,
        payingUser: false,
        supportUser: false,
      };
    }
    if (k !== 'enterpriseOwnerDemo' && next.enterpriseOwnerDemo) {
      // Turning on a different role auto-disables demo.
      next.enterpriseOwnerDemo = false;
    }
    return next;
  });

  return (
    <form action={createUserAction} className="flex flex-col gap-6">
      {/* effectiveTier may be the locked value rather than the radio's state,
          so emit it via a hidden field to make sure the server sees it. */}
      {roles.enterpriseOwner && effectiveTier && (
        <input type="hidden" name="enterpriseTier" value={effectiveTier} />
      )}
      {/* Identity */}
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

      {/* Permission set */}
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">User Type (Permission Set)</span>
        <select
          name="permissionSetId"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          defaultValue=""
        >
          <option value="">— None —</option>
          {permissionSets.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
        <span className="text-xs text-zinc-500">Optional — bundles a set of permissions onto the user.</span>
      </label>

      {/* Password setup */}
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

      {/* User roles */}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">User Roles</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_baseUser" checked={roles.baseUser} onChange={() => toggleRole('baseUser')} />
          <span>Base User</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_enterpriseOwner" checked={roles.enterpriseOwner} onChange={() => toggleRole('enterpriseOwner')} />
          <span>Enterprise Owner</span>
          <span className="text-xs text-zinc-500">— heads an enterprise</span>
        </label>
        {roles.enterpriseOwner && (
          <div className="ml-6 mt-1 flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Enterprise Owner Tier</span>
              {tierIsLocked && (
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Locked — tier of selected enterprise
                </span>
              )}
            </div>
            {ENTERPRISE_TIER_KEYS.map((key) => {
              const t = ENTERPRISE_TIERS[key];
              const checked = effectiveTier === key;
              return (
                <label
                  key={key}
                  className={`flex items-start gap-2 text-sm ${tierIsLocked && !checked ? 'opacity-40' : ''}`}
                >
                  <input
                    type="radio"
                    name="enterpriseTierRadio"
                    value={key}
                    checked={checked}
                    disabled={tierIsLocked}
                    required={tierRequired && !tierIsLocked}
                    onChange={() => setTier(key)}
                    className="mt-1"
                  />
                  <span className="flex flex-col">
                    <span className="font-medium">{t.label}</span>
                    <span className="text-xs text-zinc-500">
                      ${(t.priceCents / 100).toLocaleString()}/{t.interval} · {t.includedCompaniesCap} companies included · then 50/50 split on $50
                    </span>
                  </span>
                </label>
              );
            })}
            <label
              className={`flex items-start gap-2 text-sm ${tierIsLocked && effectiveTier !== 'regular' ? 'opacity-40' : ''}`}
            >
              <input
                type="radio"
                name="enterpriseTierRadio"
                value="regular"
                checked={effectiveTier === 'regular'}
                disabled={tierIsLocked}
                required={tierRequired && !tierIsLocked}
                onChange={() => setTier('regular')}
                className="mt-1"
              />
              <span className="flex flex-col">
                <span className="font-medium">Regular</span>
                <span className="text-xs text-zinc-500">
                  No tier or platform fee — the owner picks private label &amp; client pricing during onboarding. Earns the 20% referral share per paying client.
                </span>
              </span>
            </label>
            {tierRequired && !effectiveTier && (
              <span className="text-xs text-red-600">Pick a tier for the new enterprise.</span>
            )}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_enterpriseOwnerDemo" checked={roles.enterpriseOwnerDemo} onChange={() => toggleRole('enterpriseOwnerDemo')} />
          <span>Enterprise Owner Demo</span>
          <span className="text-xs text-zinc-500">— 7-day full-access trial; capped to 1 client; demo enterprise auto-created</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_enterpriseStaff" checked={roles.enterpriseStaff} onChange={() => toggleRole('enterpriseStaff')} />
          <span>Enterprise Staff</span>
          <span className="text-xs text-zinc-500">— works inside an enterprise (sees its clients)</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_payingUser" checked={roles.payingUser} onChange={() => toggleRole('payingUser')} />
          <span>Paying User</span>
          <span className="text-xs text-zinc-500">— company owner who pays the bill</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_supportUser" checked={roles.supportUser} onChange={() => toggleRole('supportUser')} />
          <span>Invited User (Support User)</span>
          <span className="text-xs text-zinc-500">— invited to a specific company with limited access</span>
        </label>
      </fieldset>

      {/* Demo mode info -- replaces the enterprise picker since demo always
          auto-creates its own enterprise. */}
      {roles.enterpriseOwnerDemo && (
        <section className="rounded-md border border-sky-200 bg-sky-50/60 p-4 text-sm dark:border-sky-900/60 dark:bg-sky-950/30">
          <h3 className="mb-1 font-medium text-sky-900 dark:text-sky-200">Demo trial</h3>
          <p className="text-xs text-sky-800 dark:text-sky-300">
            A new enterprise named &ldquo;{'{Full name}'}&apos;s Demo&rdquo; will be auto-created.
            The user lands on the Enterprise Dashboard. When they create their one
            client, that client&apos;s org gets a 7-day trial subscription.
          </p>
        </section>
      )}

      {/* Enterprise picker — shows for any enterprise-related role */}
      {needsEnterprise && (
        <section className="rounded-md border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h3 className="mb-3 text-sm font-medium">Enterprise</h3>
          <p className="mb-2 text-xs text-zinc-500">
            {roles.payingUser ? 'Paying users must belong to exactly one enterprise.' : 'Pick the enterprise this role applies to.'}
          </p>
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <select
                name="enterpriseId"
                disabled={createNewEnterprise}
                value={selectedEnterpriseId}
                onChange={(e) => setSelectedEnterpriseId(e.target.value)}
                className="flex-1 rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">Select an enterprise *</option>
                {enterprises.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                    {isTierKey(e.tier) ? ` — ${ENTERPRISE_TIERS[e.tier].shortLabel}` : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => {
                  setCreateNewEnterprise((v) => {
                    const next = !v;
                    // Switching to "new" clears the selected existing
                    // enterprise so the tier radio unlocks; switching back
                    // to picker mode resets the radio so we don't carry a
                    // stale value into a different enterprise.
                    if (next) setSelectedEnterpriseId('');
                    else setTier('');
                    return next;
                  });
                }}
                className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors ${
                  createNewEnterprise
                    ? 'border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300 dark:hover:bg-zinc-900'
                }`}
              >
                {createNewEnterprise ? '✕ Cancel new' : '+ New Enterprise'}
              </button>
            </div>
            {createNewEnterprise && (
              <input
                type="text"
                name="newEnterpriseName"
                placeholder="New enterprise name"
                className="rounded-md border border-blue-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-blue-700 dark:bg-zinc-950"
              />
            )}
          </div>

          {/* Paying-user-specific: organization creation mode */}
          {roles.payingUser && (
            <div className="mt-5 flex flex-col gap-3">
              <h4 className="text-sm font-medium">Organization Creation Mode</h4>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="orgMode" value="now" checked={orgMode === 'now'} onChange={() => setOrgMode('now')} />
                <span>Create organization now</span>
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="radio" name="orgMode" value="later" checked={orgMode === 'later'} onChange={() => setOrgMode('later')} />
                <span>User to create (user will create organizations later)</span>
              </label>
              <span className="text-xs text-zinc-500">
                Controls who creates the organizations (books) for this user, not enterprise assignment.
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
                  <label className="flex flex-col gap-1 text-sm">
                    <span className="font-medium">Status</span>
                    <select
                      name="companyStatus"
                      defaultValue="active"
                      className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    >
                      <option value="active">Active</option>
                      <option value="inactive">Inactive</option>
                    </select>
                  </label>
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {/* Support user — pick org */}
      {roles.supportUser && (
        <section className="rounded-md border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h3 className="mb-3 text-sm font-medium">Support Access</h3>
          <p className="mb-2 text-xs text-zinc-500">
            Pick the organization (company) this support user has access to.
          </p>
          <select
            name="supportOrgId"
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
            defaultValue=""
          >
            <option value="">Select an organization *</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </section>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <a
          href="/super-admin/all-users"
          className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
        >
          Cancel
        </a>
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Create User
        </button>
      </div>
    </form>
  );
}

function isTierKey(value: string | null | undefined): value is EnterpriseTierKey {
  return value != null && (ENTERPRISE_TIER_KEYS as readonly string[]).includes(value);
}
