import Link from 'next/link';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { createPermissionSetAction } from '../../_actions/admin';

export default function NewPermissionSetPage() {
  return (
    <AdminPage
      title="Create Permission Set"
      crumbs={[
        { label: 'SuperAdmin', href: '/super-admin/dashboard' },
        { label: 'Permission Sets', href: '/super-admin/permission-sets' },
        { label: 'New' },
      ]}
    >
      <Panel>
        <form action={createPermissionSetAction} className="flex max-w-xl flex-col gap-4">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Name</span>
            <input
              type="text"
              name="name"
              required
              placeholder="Documents Editor"
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Description</span>
            <textarea
              name="description"
              rows={3}
              placeholder="Can view and edit documents but not delete them."
              className="rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <div className="mt-2 flex items-center gap-2">
            <button type="submit" className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700">
              Create
            </button>
            <Link href="/super-admin/permission-sets" className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
              Cancel
            </Link>
          </div>
        </form>
      </Panel>
    </AdminPage>
  );
}
