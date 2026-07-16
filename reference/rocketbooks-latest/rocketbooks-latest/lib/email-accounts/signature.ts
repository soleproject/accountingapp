import 'server-only';
import { eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { users } from '@/db/schema/schema';

/**
 * Per-user email signature — the block appended to the bottom of every
 * outgoing email reply. Configured on the Settings page and stored on the
 * user's row (users.email_signature). It's per-user (not per-org) because
 * replies go out from each person's own connected email account.
 *
 * The AI reply drafter is told not to add its own sign-off (see
 * lib/email-accounts/ai-draft), so this is the single, consistent signature
 * on outbound mail.
 */

/** Load the user's saved email signature, or null if none/blank. */
export async function getUserEmailSignature(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ signature: users.emailSignature })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  const sig = row?.signature?.trim();
  return sig ? sig : null;
}

/** Marker on the wrapper div so we never double-append a signature. */
const HTML_MARKER = 'data-rb-signature';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Append the signature to an HTML email body. No-op if the signature is
 * empty or the body already carries a signature block (idempotent — guards
 * against a re-send or a draft that already includes it).
 */
export function appendSignatureHtml(html: string, signature: string | null): string {
  if (!signature) return html;
  if (html.includes(HTML_MARKER)) return html;
  const lines = signature.split('\n').map((l) => escapeHtml(l)).join('<br />');
  const block = `<div ${HTML_MARKER} style="margin-top:16px;color:#52525b;font-size:13px;line-height:1.5;">${lines}</div>`;
  return `${html}\n${block}`;
}

/** Standard "-- " sigdash delimiter so clients can fold the signature. */
const TEXT_DELIM = '\n\n-- \n';

/** Append the signature to a plain-text email body (idempotent). */
export function appendSignatureText(text: string, signature: string | null): string {
  if (!signature) return text;
  if (text.includes(TEXT_DELIM.trim()) && text.includes(signature)) return text;
  return `${text}${TEXT_DELIM}${signature}`;
}
