import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, contacts, organizations } from '@/db/schema/schema';
import { chatCompletion } from '@/lib/ai/openai';

export interface ProcessW9Result {
  ok: boolean;
  updated?: boolean;
  skipped?: boolean;
  reason?: string;
}

/**
 * Apply a vendor's W-9 reply: an LLM pulls the TIN (and legal name) out of the
 * free-text reply, we file it on the contact and flip w9_status to 'on_file'.
 * Best-effort; idempotent (marks the outreach resolved).
 */
export async function processW9Reply(outreachId: string, replyText: string): Promise<ProcessW9Result> {
  const [outreach] = await db
    .select({ orgId: aiClientOutreach.organizationId, issueType: aiClientOutreach.issueType, status: aiClientOutreach.status, context: aiClientOutreach.context })
    .from(aiClientOutreach)
    .where(eq(aiClientOutreach.id, outreachId))
    .limit(1);
  if (!outreach || outreach.issueType !== 'w9_request') return { ok: true, skipped: true, reason: 'not_w9' };
  if (outreach.status === 'resolved') return { ok: true, skipped: true, reason: 'already_processed' };

  const orgId = outreach.orgId;
  const contactId = (outreach.context as { contactId?: string } | null)?.contactId;
  if (!contactId) return { ok: true, skipped: true, reason: 'no_contact' };

  const [org] = await db.select({ ownerUserId: organizations.ownerUserId }).from(organizations).where(eq(organizations.id, orgId)).limit(1);

  const system =
    `Extract W-9 details from a vendor's email reply. Return strict JSON: ` +
    `{"tax_id":"<EIN or SSN, digits only or with dashes, or empty>","legal_name":"<name or empty>","entity_type":"<sole_proprietor|llc|partnership|s_corp|c_corp|other|empty>"}. ` +
    `Only include tax_id if the reply actually contains a 9-digit taxpayer ID. Omit anything not present.`;
  const user = `Vendor reply:\n"""${replyText.slice(0, 4000)}"""\n\nReturn JSON.`;

  let extracted: { tax_id?: string; legal_name?: string; entity_type?: string } = {};
  try {
    const c = await chatCompletion(
      { userId: org?.ownerUserId ?? null, orgId, actor: 'system', feature: 'w9_reply' },
      { model: process.env.AI_CATEGORIZE_MODEL ?? 'gpt-4o', messages: [{ role: 'system', content: system }, { role: 'user', content: user }], response_format: { type: 'json_object' }, temperature: 0 },
    );
    extracted = JSON.parse(c.choices[0]?.message?.content ?? '{}');
  } catch (e) {
    console.error('w9-reply: extraction failed', e);
    return { ok: false, reason: 'ai_failed' };
  }

  // A TIN is 9 digits (EIN 12-3456789, SSN 123-45-6789). Validate before filing.
  const rawTin = (extracted.tax_id ?? '').trim();
  const digits = rawTin.replace(/\D/g, '');
  const hasTin = digits.length === 9;

  const set: { w9Status: string; updatedAt: string; taxId?: string } = {
    w9Status: hasTin ? 'on_file' : 'requested',
    updatedAt: new Date().toISOString(),
  };
  if (hasTin) set.taxId = rawTin;

  let updated = false;
  try {
    const r = await db
      .update(contacts)
      .set(set)
      .where(and(eq(contacts.id, contactId), eq(contacts.organizationId, orgId)))
      .returning({ id: contacts.id });
    updated = r.length > 0;
  } catch (e) {
    console.error('w9-reply: contact update failed', e);
  }

  await db.update(aiClientOutreach).set({ status: 'resolved', updatedAt: new Date().toISOString() }).where(eq(aiClientOutreach.id, outreachId));
  return { ok: true, updated };
}
