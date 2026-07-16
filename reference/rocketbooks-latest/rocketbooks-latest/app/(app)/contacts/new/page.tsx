import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { ContactForm } from '../_components/ContactForm';

export default async function NewContactPage() {
  const orgId = await getCurrentOrgId();
  const trustEnabled = await getOrgFeature(orgId, 'beneficial_trust');
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New contact</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">Create a customer, vendor, or both.</p>
      </header>
      <ContactForm trustEnabled={trustEnabled} />
    </div>
  );
}
