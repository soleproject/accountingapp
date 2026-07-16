import { lookupArApprove } from '@/lib/enterprise/ar-collections';
import { approveArAction } from './actions';

export const dynamic = 'force-dynamic';

const wrap = 'mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4 text-center';
const cardCls = 'w-full rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950';

export default async function ArApprovePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ status?: string; n?: string }>;
}) {
  const { token } = await params;
  const { status, n } = await searchParams;
  const info = await lookupArApprove(token);

  if (!info) {
    return (
      <main className={wrap}>
        <div className={cardCls}>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Link not found</h1>
          <p className="mt-2 text-sm text-zinc-500">This approval link is invalid or has expired.</p>
        </div>
      </main>
    );
  }

  if (status === 'sent') {
    return (
      <main className={wrap}>
        <div className={cardCls}>
          <h1 className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">Reminders sent ✓</h1>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            We&rsquo;ve sent polite payment reminders to {n ?? 'your'} overdue customer{n === '1' ? '' : 's'} on your behalf. Replies will come straight to you.
          </p>
        </div>
      </main>
    );
  }

  if (info.alreadyApproved || status === 'already') {
    return (
      <main className={wrap}>
        <div className={cardCls}>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Already sent</h1>
          <p className="mt-2 text-sm text-zinc-500">
            These reminders were already approved{info.approvedAt ? ` on ${new Date(info.approvedAt).toLocaleDateString()}` : ''}. Nothing else to do.
          </p>
        </div>
      </main>
    );
  }

  if (info.customerCount === 0) {
    return (
      <main className={wrap}>
        <div className={cardCls}>
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Nothing to send</h1>
          <p className="mt-2 text-sm text-zinc-500">There are no overdue customers with an email on file right now.</p>
        </div>
      </main>
    );
  }

  return (
    <main className={wrap}>
      <div className={cardCls}>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Send payment reminders?</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
          We&rsquo;ll email a polite reminder to your{' '}
          <strong>
            {info.customerCount} overdue customer{info.customerCount === 1 ? '' : 's'}
          </strong>{' '}
          on your behalf. The emails come from your business name, and replies go straight to you.
        </p>
        {status === 'error' && <p className="mt-2 text-sm text-red-600">Something went wrong. Please try again.</p>}
        <form action={approveArAction} className="mt-4">
          <input type="hidden" name="token" value={token} />
          <button
            type="submit"
            className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
          >
            Approve &amp; send reminders
          </button>
        </form>
        <p className="mt-3 text-xs text-zinc-400">No reminders are sent until you tap the button above.</p>
      </div>
    </main>
  );
}
