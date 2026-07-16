import { eq, and, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { ReceiptForm } from '../_components/ReceiptForm';

export default async function NewReceiptPage() {
  const orgId = await getCurrentOrgId();
  const contactList = await db
    .select({ id: contacts.id, name: contacts.contactName })
    .from(contacts)
    .where(and(eq(contacts.organizationId, orgId), eq(contacts.isActive, true)))
    .orderBy(asc(contacts.contactName));

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">New receipt</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Manual entry for now. Upload + Veryfi OCR coming next.
        </p>
      </header>
      <ReceiptForm contacts={contactList} />
    </div>
  );
}
