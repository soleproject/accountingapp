'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';
import type { ProductFormState } from '../_actions/products';

const KNOWN_KEYS = [
  'base_seat',
  'qbo_mirroring',
  'demo_full',
  'enterprise_seat_pl_495',
  'enterprise_seat_pl_995',
  'enterprise_seat_cp1',
  'current_year_unlock',
  'prior_year',
];

interface ProductFormValues {
  id?: string;
  name?: string;
  description?: string | null;
  featureKey?: string;
  kind?: string;
  periodYear?: number | null;
  unitAmountCents?: number;
  currency?: string;
  active?: boolean;
}

interface Props {
  // Server action, wired through useActionState so it can return errors inline.
  action: (prev: ProductFormState, formData: FormData) => Promise<ProductFormState>;
  initial?: ProductFormValues;
  submitLabel: string;
}

export function ProductForm({ action, initial, submitLabel }: Props) {
  const [state, formAction, pending] = useActionState(action, {});
  const v = initial ?? {};
  // A stored key that isn't one of the known presets is a custom SKU — start
  // the dropdown on "Custom…" and prefill the typed key.
  const initialIsCustom = Boolean(v.featureKey) && !KNOWN_KEYS.includes(v.featureKey as string);
  const [choice, setChoice] = useState(initialIsCustom ? '__custom__' : (v.featureKey ?? 'base_seat'));
  const isCustom = choice === '__custom__';
  return (
    <form action={formAction} className="flex max-w-2xl flex-col gap-4">
      {v.id && <input type="hidden" name="id" value={v.id} />}

      {state?.error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          {state.error}
        </div>
      )}
      {state?.ok && (
        <div className="rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          Saved.
        </div>
      )}

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Name</span>
        <input
          type="text"
          name="name"
          required
          defaultValue={v.name ?? ''}
          placeholder="Base monthly subscription"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Description</span>
        <textarea
          name="description"
          rows={2}
          defaultValue={v.description ?? ''}
          placeholder="$89/mo platform subscription, billed per organization."
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Feature key</span>
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="base_seat">base_seat — recurring monthly subscription</option>
          <option value="qbo_mirroring">qbo_mirroring — recurring monthly add-on</option>
          <option value="demo_full">demo_full — recurring trial entitlement</option>
          <option value="enterprise_seat_pl_495">enterprise_seat_pl_495 — Private Label (Starter), monthly</option>
          <option value="enterprise_seat_pl_995">enterprise_seat_pl_995 — Private Label (Pro), monthly</option>
          <option value="enterprise_seat_cp1">enterprise_seat_cp1 — Certified Partner L1, yearly</option>
          <option value="current_year_unlock">current_year_unlock — one-time, current calendar year</option>
          <option value="prior_year">prior_year — one-time, set year below</option>
          <option value="__custom__">Custom — new SKU…</option>
        </select>

        {isCustom ? (
          <div className="mt-1 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <input
              type="text"
              name="featureKey"
              required
              defaultValue={initialIsCustom ? (v.featureKey as string) : ''}
              placeholder="base_seat_49"
              pattern="[a-z][a-z0-9_]{2,48}"
              title="lowercase snake_case (letters, digits, underscore), 3–49 chars"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <select
              name="customKind"
              defaultValue={v.kind ?? 'subscription'}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            >
              <option value="subscription">Subscription — monthly</option>
              <option value="one_time">One-time</option>
            </select>
          </div>
        ) : (
          <input type="hidden" name="featureKey" value={choice} />
        )}

        <span className="text-xs text-zinc-500 dark:text-zinc-400">
          {isCustom
            ? 'New SKU. A monthly subscription grants the same software access as the base plan (any active subscription unlocks the app). Pick a unique snake_case key.'
            : 'Billing kind is derived from the key. Each key allows ONE product (prior_year is per-year) — if it already exists, edit that one instead.'}
        </span>
      </label>

      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Period year</span>
        <input
          type="number"
          name="periodYear"
          min={2000}
          max={2100}
          defaultValue={v.periodYear ?? ''}
          placeholder="Required only when feature key = prior_year (e.g. 2024)"
          className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <div className="grid grid-cols-2 gap-4">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Unit amount (cents)</span>
          <input
            type="number"
            name="unitAmountCents"
            required
            min={0}
            defaultValue={v.unitAmountCents ?? ''}
            placeholder="8900"
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">$89 = 8900 cents. Display only — Stripe Price is the source of truth at charge time.</span>
        </label>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Currency</span>
          <input
            type="text"
            name="currency"
            maxLength={3}
            defaultValue={v.currency ?? 'usd'}
            className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm uppercase outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="active"
          defaultChecked={v.active ?? true}
          className="rounded border-zinc-300 dark:border-zinc-700"
        />
        <span className="font-medium">Active</span>
        <span className="text-xs text-zinc-500 dark:text-zinc-400">— inactive products are hidden from customer-facing purchase flows.</span>
      </label>

      <div className="mt-2 flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:opacity-60"
        >
          {pending ? 'Saving…' : submitLabel}
        </button>
        <Link href="/super-admin/products" className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Cancel
        </Link>
      </div>
    </form>
  );
}
