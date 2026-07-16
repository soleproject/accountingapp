import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { organizations } from '@/db/schema/schema';
import { getByToken } from '@/lib/signatures/store';
import { getSignatureSignedUrl } from '@/lib/storage/signatures';
import { SignFlow } from './_components/SignFlow';
import { CompletedDownload } from './_components/CompletedDownload';

interface PageProps {
  params: Promise<{ token: string }>;
}

function Message({ title, body }: { title: string; body: string }) {
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <div className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
      </div>
    </div>
  );
}

/** Public, unauthenticated signing page. The token is the authorization. */
export default async function SignPage({ params }: PageProps) {
  const { token } = await params;
  const ctx = await getByToken(token);

  return (
    <main className="min-h-screen bg-zinc-100 px-4 py-8 dark:bg-zinc-950">
      {await renderState(token, ctx)}
    </main>
  );
}

async function renderState(token: string, ctx: Awaited<ReturnType<typeof getByToken>>) {
  if (!ctx) return <Message title="This signing link isn’t valid" body="The link may have expired or been mistyped. Ask the sender for a new one." />;

  const { request, recipient, fields } = ctx;

  if (request.status === 'voided') return <Message title="This request was cancelled" body="The sender cancelled this signature request." />;
  if (request.status === 'completed') return <CompletedDownload token={token} />;
  if (recipient.status === 'declined') return <Message title="You declined this document" body="No signature was recorded. Contact the sender if this was a mistake." />;
  if (recipient.status === 'signed') return <Message title="You’ve already signed" body="Thanks! You’ll be notified when everyone has signed." />;

  const pdfUrl = request.sourcePdfPath ? await getSignatureSignedUrl(request.sourcePdfPath).catch(() => null) : null;
  if (!pdfUrl) return <Message title="Document unavailable" body="We couldn’t load this document. Please ask the sender to resend." />;

  const [org] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, request.organizationId)).limit(1);

  return (
    <SignFlow
      token={token}
      pdfUrl={pdfUrl}
      title={request.title}
      message={request.message}
      senderName={org?.name || 'The sender'}
      recipientName={recipient.name}
      fields={fields}
    />
  );
}
