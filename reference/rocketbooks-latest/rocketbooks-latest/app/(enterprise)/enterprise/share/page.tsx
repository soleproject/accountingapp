import { notFound } from 'next/navigation';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { AdminPage } from '@/components/admin/AdminPage';
import { getShareData } from '@/lib/referral/share-data';
import { ShareView } from '@/components/referral/ShareView';

export const dynamic = 'force-dynamic';

export default async function EnterpriseSharePage() {
  const current = await getCurrentEnterprise();
  if (!current) notFound();

  const data = await getShareData(current.id);

  return (
    <AdminPage title="Share" crumbs={[{ label: 'Enterprise' }, { label: 'Share' }]}>
      <ShareView data={data} />
    </AdminPage>
  );
}
