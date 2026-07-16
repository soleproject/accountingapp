import Link from 'next/link';
import { notFound } from 'next/navigation';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations, enterpriseClients } from '@/db/schema/schema';
import { AdminPage, Panel } from '@/components/admin/AdminPage';
import { listAccessibleEnterprises } from '@/lib/auth/enterprise';
import { ACCOUNTING_TIER_KEYS, ACCOUNTING_TIERS } from '@/lib/accounting/tiers';
import { updateBusinessAction } from '../../../_actions/clients';
import { DeleteBusinessSection } from '../../../_components/DeleteBusinessSection';
import { resolveEffectiveOwner, parseResponsibilities } from '@/lib/enterprise/task-catalog';
import { TaskResponsibilitiesMatrix } from '../../../_components/TaskResponsibilitiesMatrix';
import { US_STATES } from '@/lib/geo/us-states';
import { generateRecurringTasksAction } from '../../../_actions/recurringTasks';

export const dynamic = 'force-dynamic';

const inputCls =
  'rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-950';

export default async function EditBusinessPage({
  params,
  searchParams,
}: {
  params: Promise<{ orgId: string }>;
  searchParams?: Promise<{ generated?: string; firm?: string; client?: string; skipped?: string }>;
}) {
  const { orgId } = await params;
  const sp = (await searchParams) ?? {};

  const enterprises = await listAccessibleEnterprises();
  if (enterprises.length === 0) notFound();
  const accessibleIds = enterprises.map((e) => e.id);

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      businessDescription: organizations.businessDescription,
      booksManagedBy: organizations.booksManagedBy,
      accountingTier: organizations.accountingTier,
      ownerUserId: organizations.ownerUserId,
      taskResponsibilities: organizations.taskResponsibilities,
      formationState: organizations.formationState,
      annualReportDue: organizations.annualReportDue,
    })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  if (!org) notFound();

  // The org's owner must be a client of an enterprise the signed-in user can
  // access — same gate the owner-edit page uses, keyed off the business owner.
  const [link] = await db
    .select({ id: enterpriseClients.id, enterpriseId: enterpriseClients.enterpriseId })
    .from(enterpriseClients)
    .where(
      and(
        eq(enterpriseClients.clientUserId, org.ownerUserId),
        inArray(enterpriseClients.enterpriseId, accessibleIds),
      ),
    )
    .limit(1);
  if (!link) notFound();

  const [ent] = await db
    .select({ defaults: organizations.enterpriseDefaultResponsibilities })
    .from(organizations)
    .where(eq(organizations.id, link.enterpriseId))
    .limit(1);

  const booksManagedBy = org.booksManagedBy === 'firm' ? 'firm' : 'client';
  const savedResp = parseResponsibilities(org.taskResponsibilities);
  const enterpriseDefaults = parseResponsibilities(ent?.defaults);

  return (
    <AdminPage
      title={`Edit ${org.name}`}
      crumbs={[
        { label: 'Enterprise', href: '/enterprise/dashboard' },
        { label: 'Client Businesses', href: '/enterprise/businesses' },
        { label: org.name, href: `/enterprise/clients/${org.ownerUserId}/bookkeeping` },
        { label: 'Edit' },
      ]}
    >
      {sp.generated != null && (
        <div className="mb-4 rounded-md border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">
          Generated {sp.generated} task{sp.generated === '1' ? '' : 's'} from the matrix
          {sp.firm ? ` — ${sp.firm} for your firm` : ''}
          {sp.client ? `, ${sp.client} for the client` : ''}
          {sp.skipped && sp.skipped !== '0' ? ` (${sp.skipped} already existed)` : ''}.
        </div>
      )}
      <Panel>
        <form action={updateBusinessAction} className="flex flex-col gap-4">
          <input type="hidden" name="orgId" value={org.id} />

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">
              Business name <span className="text-red-500">*</span>
            </span>
            <input type="text" name="name" required defaultValue={org.name ?? ''} className={inputCls} />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">What does the business do?</span>
            <textarea
              name="businessDescription"
              rows={3}
              defaultValue={org.businessDescription ?? ''}
              className={inputCls}
            />
            <span className="text-xs text-zinc-500">
              Used as context for the AI assistant and shown on reports.
            </span>
          </label>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Who does the books?</span>
              <select name="booksManagedBy" defaultValue={booksManagedBy} className={inputCls}>
                <option value="firm">Our firm does the books</option>
                <option value="client">Client does the books (we oversee)</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Accounting plan</span>
              <select name="accountingTier" defaultValue={org.accountingTier ?? ''} className={inputCls}>
                <option value="">Legacy (flat plan)</option>
                {ACCOUNTING_TIER_KEYS.map((k) => (
                  <option key={k} value={k}>
                    {ACCOUNTING_TIERS[k].label}
                  </option>
                ))}
              </select>
              <span className="text-xs text-zinc-500">
                Changing this updates the client&apos;s permission set and billing.
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Registration state</span>
              <select name="formationState" defaultValue={org.formationState ?? ''} className={inputCls}>
                <option value="">—</option>
                {US_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Annual report due (MM-DD)</span>
              <input
                type="text"
                name="annualReportDue"
                defaultValue={org.annualReportDue ?? ''}
                placeholder="e.g. 05-01"
                inputMode="numeric"
                className={inputCls}
              />
              <span className="text-xs text-zinc-500">
                We&apos;ll remind before this date each year — check your state&apos;s filing deadline.
              </span>
            </label>
          </div>

          <div className="border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <h3 className="text-sm font-semibold">Task responsibilities</h3>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Assign each recurring task to your firm or the client. Defaults follow who keeps the
              books; these drive who&apos;s responsible as work gets generated.
            </p>
            <div className="mt-3">
              <TaskResponsibilitiesMatrix
                ownerFor={(t) => resolveEffectiveOwner(t, savedResp, enterpriseDefaults, booksManagedBy)}
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <Link
              href="/enterprise/businesses"
              className="rounded-md border border-zinc-300 px-4 py-2 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900"
            >
              Cancel
            </Link>
            <button
              type="submit"
              className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Save changes
            </button>
          </div>
        </form>
      </Panel>

      <div className="mt-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h3 className="text-sm font-semibold">Generate this period&apos;s tasks</h3>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              Creates this month/quarter/year&apos;s tasks from the matrix above — firm tasks for your
              team, client tasks for the business owner. Safe to re-run; existing tasks aren&apos;t
              duplicated.
            </p>
          </div>
          <form action={generateRecurringTasksAction}>
            <input type="hidden" name="orgId" value={org.id} />
            <button
              type="submit"
              className="shrink-0 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700"
            >
              Generate tasks
            </button>
          </form>
        </div>
      </div>

      <DeleteBusinessSection orgId={org.id} orgName={org.name} />
    </AdminPage>
  );
}
