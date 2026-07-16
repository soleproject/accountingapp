'use client';

import { useState } from 'react';
import { updateUserRolesAction } from '../../../../_actions/admin';
import {
  ENTERPRISE_TIER_KEYS,
  ENTERPRISE_TIERS,
  type EnterpriseTierKey,
} from '@/lib/enterprise/tiers';

interface OrgOption {
  id: string;
  name: string;
}

interface EnterpriseOption extends OrgOption {
  tier: string | null;
}

export interface UserRolesInitial {
  baseUser: boolean;
  enterpriseOwner: boolean;
  enterpriseStaff: boolean;
  payingUser: boolean;
  supportUser: boolean;
}

interface Props {
  userId: string;
  initial: UserRolesInitial;
  /** True when the user already heads an enterprise (owns the org or has an
   *  owner staff row). When true the Owner checkbox is locked checked — you
   *  can edit the tier but un-owning happens on the enterprise page. */
  isCurrentlyOwner: boolean;
  /** The headed enterprise's current tier ('regular' when untiered), used to
   *  preselect the radio. Null when the user isn't an owner yet. */
  currentTier: EnterpriseTierKey | 'regular' | null;
  headedEnterpriseName: string | null;
  enterprises: EnterpriseOption[];
  organizations: OrgOption[];
}

export function UserRolesEditor({
  userId,
  initial,
  isCurrentlyOwner,
  currentTier,
  headedEnterpriseName,
  enterprises,
  organizations,
}: Props) {
  const [roles, setRoles] = useState<UserRolesInitial>(initial);
  const [tier, setTier] = useState<EnterpriseTierKey | 'regular' | ''>(currentTier ?? '');
  const [selectedEnterpriseId, setSelectedEnterpriseId] = useState('');

  const toggle = (k: keyof UserRolesInitial) => setRoles((r) => ({ ...r, [k]: !r[k] }));

  // A role "needs an enterprise picked" only when it's being NEWLY added (it
  // wasn't set before). Already-satisfied roles don't re-prompt.
  const needsStaffEnterprise = roles.enterpriseStaff && !initial.enterpriseStaff;
  const needsPayingEnterprise = roles.payingUser && !initial.payingUser;
  const needsEnterprisePicker = needsStaffEnterprise || needsPayingEnterprise;
  const needsSupportOrg = roles.supportUser && !initial.supportUser;

  // Promoting to owner = checking the box when they don't already head one.
  const promotingToOwner = roles.enterpriseOwner && !isCurrentlyOwner;

  return (
    <form action={updateUserRolesAction} className="flex flex-col gap-4">
      <input type="hidden" name="userId" value={userId} />
      {/* Emit the effective tier whenever the owner box is checked. */}
      {roles.enterpriseOwner && tier && <input type="hidden" name="enterpriseTier" value={tier} />}

      <fieldset className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_baseUser" checked={roles.baseUser} onChange={() => toggle('baseUser')} />
          <span>Base User</span>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            name="role_enterpriseOwner"
            checked={roles.enterpriseOwner}
            disabled={isCurrentlyOwner}
            onChange={() => toggle('enterpriseOwner')}
          />
          <span>Enterprise Owner</span>
          <span className="text-xs text-zinc-500">— heads an enterprise</span>
          {isCurrentlyOwner && (
            <span className="text-[10px] uppercase tracking-wide text-zinc-400">locked — already an owner</span>
          )}
        </label>

        {roles.enterpriseOwner && (
          <div className="ml-6 mt-1 flex flex-col gap-2 rounded-md border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-zinc-700 dark:text-zinc-300">Enterprise Owner Tier</span>
              {isCurrentlyOwner && headedEnterpriseName && (
                <span className="text-[10px] uppercase tracking-wide text-zinc-500">
                  Editing tier of {headedEnterpriseName}
                </span>
              )}
            </div>

            {ENTERPRISE_TIER_KEYS.map((key) => {
              const t = ENTERPRISE_TIERS[key];
              return (
                <label key={key} className="flex items-start gap-2 text-sm">
                  <input
                    type="radio"
                    name="enterpriseTierRadio"
                    value={key}
                    checked={tier === key}
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
            {/* Regular = untiered / referral (enterprise_tier NULL). */}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="enterpriseTierRadio"
                value="regular"
                checked={tier === 'regular'}
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

            {promotingToOwner && (
              <div className="mt-1 flex flex-col gap-1.5 border-t border-zinc-100 pt-2 dark:border-zinc-800">
                <span className="text-xs text-zinc-500">
                  A new enterprise headed by this user will be created. Name it (optional):
                </span>
                <input
                  type="text"
                  name="newEnterpriseName"
                  placeholder="(defaults to “{name}’s Enterprise”)"
                  className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
                />
                {!tier && <span className="text-xs text-red-600">Pick a tier (or Regular) for the new enterprise.</span>}
              </div>
            )}
          </div>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_enterpriseStaff" checked={roles.enterpriseStaff} onChange={() => toggle('enterpriseStaff')} />
          <span>Enterprise Staff</span>
          <span className="text-xs text-zinc-500">— works inside an enterprise (sees its clients)</span>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_payingUser" checked={roles.payingUser} onChange={() => toggle('payingUser')} />
          <span>Paying User</span>
          <span className="text-xs text-zinc-500">— company owner who pays the bill</span>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="role_supportUser" checked={roles.supportUser} onChange={() => toggle('supportUser')} />
          <span>Invited User (Support User)</span>
          <span className="text-xs text-zinc-500">— invited to a specific company with limited access</span>
        </label>
      </fieldset>

      {/* Enterprise picker — only when newly adding a staff/paying role. */}
      {needsEnterprisePicker && (
        <section className="rounded-md border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h3 className="mb-2 text-sm font-medium">Enterprise</h3>
          <p className="mb-2 text-xs text-zinc-500">Pick the enterprise this user joins as {needsStaffEnterprise ? 'staff' : 'a paying client'}.</p>
          <select
            name="enterpriseId"
            value={selectedEnterpriseId}
            onChange={(e) => setSelectedEnterpriseId(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">Select an enterprise *</option>
            {enterprises.map((e) => (
              <option key={e.id} value={e.id}>{e.name}</option>
            ))}
          </select>
        </section>
      )}

      {/* Support org picker — only when newly adding the support role. */}
      {needsSupportOrg && (
        <section className="rounded-md border border-zinc-200 bg-zinc-50/50 p-4 dark:border-zinc-800 dark:bg-zinc-900/30">
          <h3 className="mb-2 text-sm font-medium">Support Access</h3>
          <p className="mb-2 text-xs text-zinc-500">Pick the organization (company) this support user can access.</p>
          <select
            name="supportOrgId"
            defaultValue=""
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">Select an organization *</option>
            {organizations.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </section>
      )}

      <p className="text-xs text-zinc-500">
        Saving provisions the matching enterprise memberships so access works immediately. Owned organizations are never
        deleted, and removing enterprise ownership is done on the enterprise page, not here.
      </p>

      <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
        >
          Save roles &amp; access
        </button>
      </div>
    </form>
  );
}
