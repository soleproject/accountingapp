import Link from 'next/link';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { getOrgBranding } from '@/lib/documents/branding';
import { contactLine } from '@/lib/documents/layout';
import { LetterheadForm } from './_components/LetterheadForm';

/**
 * Letterhead settings — the document-specific bits (on/off + default signatory)
 * that don't live on the org profile. The identity fields (name / address /
 * logo / contact) are edited on the business profile; this page previews them
 * and links there.
 */
export default async function LetterheadSettingsPage() {
  await requireSession();
  const orgId = await getCurrentOrgId();
  const b = await getOrgBranding(orgId);
  const contact = contactLine(b);
  const hasLetterhead = !!(b.logoUrl || b.orgName || b.addressLines.length || contact);

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-2xl font-semibold">Letterhead</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          How generated letters and resolutions are branded and signed.
        </p>
      </header>

      {/* Live preview of the letterhead */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Preview
        </h2>
        {hasLetterhead ? (
          <div className="mx-auto max-w-[520px] border-b-2 border-zinc-800 pb-3 text-center font-serif dark:border-zinc-300">
            {b.logoUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={b.logoUrl} alt="" className="mx-auto mb-2 max-h-14 max-w-[200px] object-contain" />
            )}
            {b.orgName && <div className="text-lg font-bold tracking-wide text-zinc-900 dark:text-zinc-100">{b.orgName}</div>}
            {b.addressLines.length > 0 && (
              <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{b.addressLines.join('  ·  ')}</div>
            )}
            {contact && <div className="text-[11px] text-zinc-500 dark:text-zinc-400">{contact}</div>}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No business name, address, or logo set yet — your documents will have no letterhead.
          </p>
        )}
        <p className="mt-3 text-xs text-zinc-500 dark:text-zinc-400">
          Name, address, contact details, and logo come from your{' '}
          <Link href="/organizer/businesses" className="text-indigo-600 hover:underline dark:text-indigo-400">
            business profile
          </Link>
          .
        </p>
      </section>

      {/* Settings form */}
      <section className="rounded-lg border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-950">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">
          Settings
        </h2>
        <LetterheadForm
          initial={{
            enabled: b.showLetterhead,
            signatoryName: b.signatoryName ?? '',
            signatoryTitle: b.signatoryTitle ?? '',
          }}
        />
      </section>
    </div>
  );
}
