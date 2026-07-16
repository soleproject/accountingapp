'use client';

import { useActionState } from 'react';
import { createContact, type CreateContactState } from '../_actions/createContact';
import { updateContact, type UpdateContactState } from '../_actions/updateContact';

export interface ContactFormInitial {
  id: string;
  contactName: string;
  companyName: string | null;
  email: string | null;
  phone: string | null;
  typeTags: string[];
  /** Drives the Active checkbox in edit mode. Treated as true when null (legacy). */
  isActive: boolean | null;
  taxId?: string | null;
  w9Status?: string | null;
  is1099Eligible?: boolean | null;
}

interface Props {
  /** When supplied → edit mode. When omitted → create mode. */
  initial?: ContactFormInitial;
  /** True when the current org has the beneficial-trust feature pack enabled.
   *  Drives the "Trustee" tag checkbox visibility — meaningless on non-trust
   *  orgs since no rule consumes it there. */
  trustEnabled?: boolean;
}

/**
 * Dual-mode contact form. Without `initial` it submits to createContact and
 * inserts a new row. With `initial` it pre-fills, includes a hidden id, and
 * submits to updateContact. The two server actions share enough shape that
 * useActionState can be parameterized either way.
 */
export function ContactForm({ initial, trustEnabled }: Props) {
  const isEdit = !!initial;
  const [createState, createAction, createPending] = useActionState<CreateContactState | undefined, FormData>(
    createContact,
    undefined,
  );
  const [updateState, updateAction, updatePending] = useActionState<UpdateContactState | undefined, FormData>(
    updateContact,
    undefined,
  );
  const action = isEdit ? updateAction : createAction;
  const pending = isEdit ? updatePending : createPending;
  const state = isEdit ? updateState : createState;

  return (
    <form action={action} className="flex max-w-xl flex-col gap-4 rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
      {isEdit && <input type="hidden" name="id" value={initial!.id} />}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Field label="Name" name="contactName" defaultValue={initial?.contactName ?? ''} required />
        <Field label="Company" name="companyName" defaultValue={initial?.companyName ?? ''} />
        <Field label="Email" name="email" type="email" defaultValue={initial?.email ?? ''} />
        <Field label="Phone" name="phone" defaultValue={initial?.phone ?? ''} />
      </div>
      <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Tags</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isCustomer" defaultChecked={initial?.typeTags.includes('customer') ?? false} /> Customer
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="isVendor" defaultChecked={initial?.typeTags.includes('vendor') ?? false} /> Vendor
        </label>
        {trustEnabled && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="isTrustee" defaultChecked={initial?.typeTags.includes('trustee') ?? false} />{' '}
            Trustee{' '}
            <span className="text-xs text-zinc-500">
              (used by Trust Review — clears M&amp;E attribution warnings when this contact is on the line)
            </span>
          </label>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
        <legend className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">1099 / Tax</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="is1099Eligible" defaultChecked={initial?.is1099Eligible ?? false} /> 1099-eligible vendor
          <span className="text-xs text-zinc-500">(contractor you may need to issue a 1099-NEC)</span>
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Tax ID (EIN / SSN)" name="taxId" defaultValue={initial?.taxId ?? ''} />
          <div className="flex flex-col gap-1">
            <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">W-9 status</label>
            <select
              name="w9Status"
              defaultValue={initial?.w9Status ?? 'not_requested'}
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            >
              <option value="not_requested">Not requested</option>
              <option value="requested">Requested</option>
              <option value="on_file">On file</option>
            </select>
          </div>
        </div>
      </fieldset>
      {isEdit && (
        <fieldset className="flex flex-col gap-2 rounded-md border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-xs font-medium uppercase tracking-wide text-zinc-500">Status</legend>
          <label className="flex items-center gap-2 text-sm">
            {/* Default checked when isActive !== false (treats null as active
                so legacy contacts don't get archived by an accidental save). */}
            <input
              type="checkbox"
              name="isActive"
              defaultChecked={initial?.isActive !== false}
            />{' '}
            Active <span className="text-xs text-zinc-500">(uncheck to archive — hides from pickers, doesn&apos;t affect history)</span>
          </label>
        </fieldset>
      )}
      <div className="flex items-center gap-3">
        <button type="submit" disabled={pending} className="rounded-md bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white">
          {pending ? 'Saving…' : isEdit ? 'Save changes' : 'Create contact'}
        </button>
        <a href="/contacts" className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Cancel
        </a>
        {state?.error && <span className="text-sm text-red-600">{state.error}</span>}
      </div>
    </form>
  );
}

function Field({
  label,
  name,
  type = 'text',
  required = false,
  defaultValue,
}: {
  label: string;
  name: string;
  type?: string;
  required?: boolean;
  defaultValue?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</label>
      <input
        name={name}
        type={type}
        required={required}
        defaultValue={defaultValue}
        className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
      />
    </div>
  );
}
