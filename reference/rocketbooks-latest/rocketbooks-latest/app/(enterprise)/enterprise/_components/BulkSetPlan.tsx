'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  ACCOUNTING_TIER_KEYS,
  ACCOUNTING_TIERS,
  maybeGetAccountingTier,
} from '@/lib/accounting/tiers';
import { bulkSetEnterpriseClientTierAction } from '../_actions/clients';

export interface BulkPlanClient {
  userId: string;
  name: string;
  /** Current tier key, or '' for grandfathered flat $89. */
  tier: string;
}

function planLabel(tier: string): string {
  const t = maybeGetAccountingTier(tier);
  return t ? `${t.label} · ${t.shortLabel}` : 'Legacy $89';
}

/**
 * Multi-select "Set plan" for a firm's clients. Pick clients + a plan, apply in
 * one call (bulkSetEnterpriseClientTierAction), which stamps each client's org
 * tier + permission set. Additive panel above the clients table so the existing
 * server-rendered table stays untouched.
 */
export function BulkSetPlan({ clients }: { clients: BulkPlanClient[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [tier, setTier] = useState<string>('starter');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  if (clients.length === 0) return null;

  const allSelected = selected.size === clients.length;
  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(clients.map((c) => c.userId)));

  async function apply() {
    if (selected.size === 0) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await bulkSetEnterpriseClientTierAction([...selected], tier);
      setMsg(
        `${res.updated} updated${res.failed ? `, ${res.failed} failed` : ''}.` +
          (res.errors.length ? ` (${res.errors[0]})` : ''),
      );
      setSelected(new Set());
      router.refresh();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Bulk update failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between text-left text-sm font-medium"
      >
        <span>Bulk set plan</span>
        <span className="text-xs text-zinc-500">{open ? 'Hide' : `Change the plan for several clients at once`}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-xs uppercase text-zinc-500">Plan to apply</span>
              <select
                value={tier}
                onChange={(e) => setTier(e.target.value)}
                className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950"
              >
                <option value="">Legacy ($89/mo flat)</option>
                {ACCOUNTING_TIER_KEYS.map((key) => {
                  const t = ACCOUNTING_TIERS[key];
                  return (
                    <option key={key} value={key}>{t.label} — {t.shortLabel}</option>
                  );
                })}
              </select>
            </label>
            <button
              type="button"
              onClick={apply}
              disabled={busy || selected.size === 0}
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-50"
            >
              {busy ? 'Applying…' : `Apply to ${selected.size} selected`}
            </button>
            {msg && <span className="text-sm text-zinc-600 dark:text-zinc-400">{msg}</span>}
          </div>

          <div className="overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <label className="flex items-center gap-2 border-b border-zinc-100 bg-zinc-50 px-3 py-2 text-sm font-medium dark:border-zinc-800 dark:bg-zinc-900">
              <input type="checkbox" checked={allSelected} onChange={toggleAll} className="accent-blue-600" />
              Select all ({clients.length})
            </label>
            <ul className="max-h-64 divide-y divide-zinc-100 overflow-y-auto text-sm dark:divide-zinc-800">
              {clients.map((c) => (
                <li key={c.userId}>
                  <label className="flex items-center justify-between gap-2 px-3 py-1.5">
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(c.userId)}
                        onChange={() => toggle(c.userId)}
                        className="accent-blue-600"
                      />
                      {c.name}
                    </span>
                    <span className="text-xs text-zinc-500">{planLabel(c.tier)}</span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
