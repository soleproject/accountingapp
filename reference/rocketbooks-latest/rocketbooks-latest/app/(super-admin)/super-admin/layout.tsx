import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/auth/session';
import { isSuperAdmin } from '@/lib/auth/org';
import { listAccessibleWorkspaces } from '@/lib/auth/workspace';
import { SuperAdminSidebar } from '@/components/layout/SuperAdminSidebar';
import { AdminTopBar } from '@/components/layout/AdminTopBar';

export default async function SuperAdminLayout({ children }: { children: React.ReactNode }) {
  const user = await requireSession();
  if (!(await isSuperAdmin())) redirect('/dashboard');
  const workspaces = await listAccessibleWorkspaces();

  return (
    <div className="flex min-h-screen bg-zinc-50 dark:bg-zinc-950">
      <SuperAdminSidebar workspaces={workspaces} />
      <div className="flex flex-1 flex-col">
        <AdminTopBar email={user.email ?? ''} />
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
