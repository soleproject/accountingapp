import { notFound } from 'next/navigation';
import { eq, and, count } from 'drizzle-orm';
import { db } from '@/db/client';
import { contacts, transactions } from '@/db/schema/schema';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgFeature } from '@/lib/accounting/get-org-feature';
import { ContactForm } from '../_components/ContactForm';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditContactPage({ params }: PageProps) {
  const { id } = await params;
  const orgId = await getCurrentOrgId();
  const [contact] = await db
    .select({
      id: contacts.id,
      contactName: contacts.contactName,
      companyName: contacts.companyName,
      email: contacts.email,
      phone: contacts.phone,
      typeTags: contacts.typeTags,
      isActive: contacts.isActive,
      createdAt: contacts.createdAt,
      createdByAi: contacts.createdByAi,
      needsReview: contacts.needsReview,
      taxId: contacts.taxId,
      w9Status: contacts.w9Status,
      is1099Eligible: contacts.is1099Eligible,
    })
    .from(contacts)
    .where(and(eq(contacts.id, id), eq(contacts.organizationId, orgId)))
    .limit(1);
  if (!contact) notFound();

  // Reference count surfaces alongside the form so the user knows how much
  // history they're touching when they edit (or merge later).
  const [[refs], trustEnabled] = await Promise.all([
    db
      .select({ n: count() })
      .from(transactions)
      .where(and(eq(transactions.organizationId, orgId), eq(transactions.contactId, id))),
    getOrgFeature(orgId, 'beneficial_trust'),
  ]);

  const tags = Array.isArray(contact.typeTags) ? (contact.typeTags as string[]) : [];

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Edit contact</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {refs?.n ?? 0} transaction{refs?.n === 1 ? '' : 's'} reference this contact
          {contact.isActive === false && ' · archived'}
          {contact.createdByAi && ' · created by AI'}
          {contact.needsReview && ' · flagged for review'}
        </p>
      </header>
      <ContactForm
        initial={{
          id: contact.id,
          contactName: contact.contactName,
          companyName: contact.companyName,
          email: contact.email,
          phone: contact.phone,
          typeTags: tags,
          isActive: contact.isActive,
          taxId: contact.taxId,
          w9Status: contact.w9Status,
          is1099Eligible: contact.is1099Eligible,
        }}
        trustEnabled={trustEnabled}
      />
    </div>
  );
}
