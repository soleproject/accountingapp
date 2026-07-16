import { requireSession } from '@/lib/auth/session';
import { getUserShareData } from '@/lib/referral/share-data';
import { ShareView } from '@/components/referral/ShareView';

export const dynamic = 'force-dynamic';

export default async function SharePage() {
  // Per-user referral: the link + earnings follow the person, not the current
  // workspace. Works in any workspace (including the demo) since the slug and
  // attribution live on the user, not the org.
  const user = await requireSession();
  const fullName =
    (user.user_metadata?.full_name as string | undefined)?.trim() ||
    user.email ||
    'you';

  const data = await getUserShareData(user.id, fullName);

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold">Share</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Refer others and earn 20% of what they pay — for as long as they pay.
        </p>
      </header>
      <ShareView data={data} />
    </div>
  );
}
