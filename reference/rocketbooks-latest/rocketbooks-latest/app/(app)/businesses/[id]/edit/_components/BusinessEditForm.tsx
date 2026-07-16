'use client';

import { useActionState } from 'react';
import type { UpdateBusinessState } from '../../_actions/updateBusiness';

interface AddressInitial {
  line1: string;
  line2: string;
  city: string;
  state: string;
  postal: string;
  country: string;
}

interface Initial {
  name: string;
  businessDescription: string;
  accountingMethod: 'accrual' | 'cash';
  email: string;
  phone: string;
  fax: string;
  website: string;
  address: AddressInitial;
}

interface Props {
  action: (
    prev: UpdateBusinessState | undefined,
    formData: FormData,
  ) => Promise<UpdateBusinessState | undefined>;
  initial: Initial;
  readOnly?: boolean;
}

const inputClass =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 disabled:opacity-50';
const labelClass = 'text-xs font-medium uppercase tracking-wide text-zinc-500';

export function BusinessEditForm({ action, initial, readOnly = false }: Props) {
  const [state, formAction, pending] = useActionState<UpdateBusinessState | undefined, FormData>(
    action,
    undefined,
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <fieldset disabled={readOnly} className="contents">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className={labelClass}>Name</label>
            <input name="name" required defaultValue={initial.name} className={inputClass} />
          </div>
          <div className="flex flex-col gap-1 sm:col-span-2">
            <label className={labelClass}>What it does</label>
            <textarea
              name="businessDescription"
              rows={3}
              defaultValue={initial.businessDescription}
              className={inputClass}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className={labelClass}>Accounting method</label>
            <select name="accountingMethod" defaultValue={initial.accountingMethod} className={inputClass}>
              <option value="accrual">Accrual</option>
              <option value="cash">Cash</option>
            </select>
            <p className="mt-1 text-xs text-zinc-500">
              Reports default to this basis; the toggle on each report still lets you switch ad-hoc.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Contact</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Email</label>
              <input name="email" type="email" defaultValue={initial.email} className={inputClass} placeholder="hello@example.com" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Website</label>
              <input name="website" type="url" defaultValue={initial.website} className={inputClass} placeholder="https://example.com" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Phone</label>
              <input name="phone" type="tel" defaultValue={initial.phone} className={inputClass} placeholder="(555) 555-1234" />
            </div>
            <div className="flex flex-col gap-1">
              <label className={labelClass}>Fax</label>
              <input name="fax" type="tel" defaultValue={initial.fax} className={inputClass} />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Address</h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-6">
            <div className="flex flex-col gap-1 sm:col-span-6">
              <label className={labelClass}>Street</label>
              <input name="address.line1" defaultValue={initial.address.line1} className={inputClass} placeholder="123 Main St" />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-6">
              <label className={labelClass}>Suite / Unit</label>
              <input name="address.line2" defaultValue={initial.address.line2} className={inputClass} placeholder="Optional" />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-3">
              <label className={labelClass}>City</label>
              <input name="address.city" defaultValue={initial.address.city} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-1">
              <label className={labelClass}>State</label>
              <input name="address.state" defaultValue={initial.address.state} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className={labelClass}>ZIP / Postal</label>
              <input name="address.postal" defaultValue={initial.address.postal} className={inputClass} />
            </div>
            <div className="flex flex-col gap-1 sm:col-span-3">
              <label className={labelClass}>Country</label>
              <input name="address.country" defaultValue={initial.address.country} className={inputClass} placeholder="United States" />
            </div>
          </div>
        </div>
      </fieldset>

      <div className="flex items-center gap-3 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <button
          type="submit"
          disabled={pending || readOnly}
          className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
        >
          {pending ? 'Saving…' : 'Save changes'}
        </button>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}
