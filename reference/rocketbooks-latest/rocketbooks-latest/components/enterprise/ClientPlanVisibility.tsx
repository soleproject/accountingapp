'use client';

import { useState } from 'react';

export interface GatedProductView {
  id: string;
  name: string;
  featureKey: string;
  unitAmountCents: number;
  currency: string;
  active: boolean;
  stripeLinked: boolean;
}

function fmt(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() }).format(cents / 100);
}

/**
 * Checkbox picker of gated (custom-SKU) products an enterprise exposes to its
 * clients on /billing. Used identically by the SuperAdmin enterprise editor and
 * the enterprise-owner settings page — both POST to /api/enterprise/client-products
 * (which authorizes via listAccessibleEnterprises).
 */
export function ClientPlanVisibility({
  enterpriseId,
  products,
  initialSelected,
}: {
  enterpriseId: string;
  products: GatedProductView[];
  initialSelected: string[];
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set(initialSelected));
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const res = await fetch('/api/enterprise/client-products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enterpriseId, productIds: [...selected] }),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `Save failed (${res.status})`);
      }
      setMsg({ ok: true, text: 'Saved.' });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setSaving(false);
    }
  };

  if (products.length === 0) {
    return (
      <p className="text-sm text-zinc-500 dark:text-zinc-400">
        No custom plans exist yet. Create one under{' '}
        <span className="font-mono text-xs">/super-admin/products</span> (Feature key → Custom), then it&rsquo;ll
        appear here to expose to clients.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2">
        {products.map((p) => (
          <label key={p.id} className="flex items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={selected.has(p.id)}
              onChange={() => toggle(p.id)}
              className="mt-1"
            />
            <span className="flex flex-col gap-0.5">
              <span className="font-medium">
                {p.name}
                {!p.active && <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">(inactive)</span>}
                {!p.stripeLinked && (
                  <span className="ml-2 text-xs text-amber-600 dark:text-amber-400">(not linked to Stripe)</span>
                )}
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                <span className="font-mono">{p.featureKey}</span> · {fmt(p.unitAmountCents, p.currency)}/mo
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        {msg && (
          <span className={`text-xs ${msg.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400'}`}>
            {msg.text}
          </span>
        )}
      </div>
    </div>
  );
}
