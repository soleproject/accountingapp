'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { intervalSuffix } from '@/lib/billing/interval';
import { startAddOnSubscriptionCheckoutAction, startUnlockCheckoutAction } from '../_actions/billing';

type BillingTab = 'accounting' | 'partner';

type Entitlement = {
  id: string;
  periodYear: number;
  unitAmountCents: number;
  currency: string;
  grantedAt: string | null;
  productName: string | null;
};

type AddOnOffer = {
  id: string;
  name: string;
  description: string | null;
  featureKey: string;
  stripePriceId: string | null;
  unitAmountCents: number;
  currency: string;
};

type UnlockOffer = AddOnOffer & { displayYear: number };

type DeferredPayload = {
  entitlements: Entitlement[];
  accountingAddOns: AddOnOffer[];
  partnerAddOns: AddOnOffer[];
  unlockOffers: UnlockOffer[];
};

function formatCurrency(cents: number | null | undefined, currency = 'usd'): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function DeferredBillingSections({
  activeTab,
  activeSubFeatureKeys,
}: {
  activeTab: BillingTab;
  activeSubFeatureKeys: string[];
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [payload, setPayload] = useState<DeferredPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const activeSet = useMemo(() => new Set(activeSubFeatureKeys), [activeSubFeatureKeys]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch('/api/billing/deferred', { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Deferred billing details failed: ${response.status}`);
        const json = (await response.json()) as DeferredPayload;
        if (!cancelled) setPayload(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Deferred billing details failed');
      }
    };

    const timer = window.setTimeout(() => {
      void load();
    }, 2500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (error) {
    return (
      <section ref={ref} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-4 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
        Billing details did not load. Refresh to try again.
      </section>
    );
  }

  if (!payload) {
    return (
      <section ref={ref} className="rounded-lg border border-zinc-200 bg-white px-4 py-6 text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
        Loading billing details…
      </section>
    );
  }

  if (activeTab === 'partner') {
    return <PartnerAddOns offers={payload.partnerAddOns} activeSet={activeSet} refNode={ref} />;
  }

  return (
    <div ref={ref} className="flex flex-col gap-6">
      <AddOns title="Add-ons" offers={payload.accountingAddOns} activeSet={activeSet} />
      <YearUnlocks entitlements={payload.entitlements} unlockOffers={payload.unlockOffers} />
    </div>
  );
}

function AddOns({ title, offers, activeSet }: { title: string; offers: AddOnOffer[]; activeSet: Set<string> }) {
  if (offers.length === 0) return null;
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">{title}</h2>
      </header>
      <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
        {offers.map((p) => <AddOnRow key={p.id} offer={p} activeSet={activeSet} />)}
      </div>
    </section>
  );
}

function PartnerAddOns({ offers, activeSet, refNode }: { offers: AddOnOffer[]; activeSet: Set<string>; refNode: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={refNode}>
      <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
        <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Partner tiers</h2>
        </header>
        {offers.length === 0 ? (
          <p className="px-4 py-6 text-sm text-zinc-500 dark:text-zinc-400">
            No partner-tier products configured. Ask a super-admin to add them in /super-admin/products.
          </p>
        ) : (
          <div className="divide-y divide-zinc-100 dark:divide-zinc-800">
            {offers.map((p) => <AddOnRow key={p.id} offer={p} activeSet={activeSet} />)}
          </div>
        )}
      </section>
    </div>
  );
}

function AddOnRow({ offer: p, activeSet }: { offer: AddOnOffer; activeSet: Set<string> }) {
  const subscribed = activeSet.has(p.featureKey);
  const stripeReady = Boolean(p.stripePriceId);
  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-3">
      {subscribed ? (
        <span className="rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-medium text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300">Active</span>
      ) : stripeReady ? (
        <form action={startAddOnSubscriptionCheckoutAction}>
          <input type="hidden" name="billingProductId" value={p.id} />
          <button type="submit" className="rounded-md bg-emerald-600 px-3 py-2 text-sm font-medium text-white shadow-sm hover:bg-emerald-700">
            Subscribe — {formatCurrency(p.unitAmountCents, p.currency)}{intervalSuffix(p.featureKey)}
          </button>
        </form>
      ) : (
        <span className="rounded-md border border-dashed border-zinc-300 px-3 py-2 text-xs text-zinc-500 dark:border-zinc-700 dark:text-zinc-400" title="The product has not been linked to Stripe yet">
          Not yet available
        </span>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">{p.name}</span>
        {p.description && <span className="text-xs text-zinc-500 dark:text-zinc-400">{p.description}</span>}
        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {formatCurrency(p.unitAmountCents, p.currency)}{intervalSuffix(p.featureKey)}
        </span>
      </div>
    </div>
  );
}

function YearUnlocks({ entitlements, unlockOffers }: { entitlements: Entitlement[]; unlockOffers: UnlockOffer[] }) {
  return (
    <section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <header className="flex items-center justify-between border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Year unlocks</h2>
      </header>
      <div className="px-4 py-4">
        <p className="text-xs text-zinc-500 dark:text-zinc-400">
          Your base subscription covers months from the day you subscribed forward. To enter transactions dated before that — or in any prior year — purchase the matching year unlock.
        </p>
        {entitlements.length > 0 && (
          <div className="mt-4 overflow-hidden rounded-md border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500 dark:bg-zinc-900">
                <tr>
                  <th className="px-4 py-2.5">Year</th>
                  <th className="px-4 py-2.5">Purchased product</th>
                  <th className="px-4 py-2.5 text-right">Price paid</th>
                  <th className="px-4 py-2.5">Granted</th>
                </tr>
              </thead>
              <tbody>
                {entitlements.map((e) => (
                  <tr key={e.id} className="border-t border-zinc-100 dark:border-zinc-800">
                    <td className="px-4 py-2.5 font-medium">{e.periodYear}</td>
                    <td className="px-4 py-2.5">{e.productName ?? '—'}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(e.unitAmountCents, e.currency)}</td>
                    <td className="px-4 py-2.5">{formatDate(e.grantedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {unlockOffers.length > 0 ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {unlockOffers.map((p) => (
              <form key={p.id} action={startUnlockCheckoutAction}>
                <input type="hidden" name="billingProductId" value={p.id} />
                <button type="submit" className="rounded-md border border-blue-300 bg-blue-50 px-3 py-2 text-sm font-medium text-blue-700 hover:bg-blue-100 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                  Buy {p.displayYear} unlock — {formatCurrency(p.unitAmountCents, p.currency)}
                </button>
              </form>
            ))}
          </div>
        ) : (
          <p className="mt-4 text-sm text-zinc-500 dark:text-zinc-400">
            {entitlements.length === 0 ? 'No year-unlock products configured. Ask a super-admin to add them in /super-admin/products.' : 'All configured years are already unlocked.'}
          </p>
        )}
      </div>
    </section>
  );
}
