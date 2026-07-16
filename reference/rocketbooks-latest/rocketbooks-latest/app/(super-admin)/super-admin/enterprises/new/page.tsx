import Link from 'next/link';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { createEnterpriseAction } from '../../_actions/admin';

export default function NewEnterprisePage() {
  return (
    <AdminPage
      title="Create Enterprise"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Enterprises', href: '/super-admin/enterprises' },
        { label: 'New' },
      ]}
    >
      <Panel>
        <form action={createEnterpriseAction} className="flex max-w-xl flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Enterprise name</span>
            <input
              type="text"
              name="name"
              required
              placeholder="Acme Bookkeeping, LLC"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Domain (optional)</span>
            <input
              type="text"
              name="domain"
              placeholder="acmebooks.com"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Owner email</span>
            <input
              type="email"
              name="ownerEmail"
              required
              placeholder="owner@acmebooks.com"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
            <span className="text-xs text-zinc-500">The user must already exist. They become the owner of the enterprise organization.</span>
          </label>
          <div className="mt-2 flex items-center gap-2">
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Create Enterprise
            </button>
            <Link href="/super-admin/enterprises" className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Cancel
            </Link>
          </div>
        </form>
      </Panel>
    </AdminPage>
  );
}
