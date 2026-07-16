'use server';

import { randomUUID } from 'crypto';
import { and, desc, eq, sql } from 'drizzle-orm';
import { db } from '@/db/client';
import { aiClientOutreach, organizations, users } from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentEnterprise } from '@/lib/auth/enterprise';
import { chatCompletion } from '@/lib/ai/openai';
import { sendTransactionalEmail } from '@/lib/email/resend';
import { sendTransactionalSms } from '@/lib/sms/twilio';
import {
  AI_ACTION_TAXONOMY,
  buildOutreachDraftMessages,
  outreachSubject,
  type OutreachChannel,
  type OutreachIssueType,
} from '@/lib/enterprise/ai-actions';
import { DEMO_ENTERPRISE_ID } from '@/lib/enterprise/demo';
import { getEnterpriseSenderIdentity } from '@/lib/enterprise/sender';
import { outreachReplyToAddress } from '@/lib/email/inbound-token';
import { requestOrigin } from '@/lib/http/origin';
import { arApproveUrl } from '@/lib/enterprise/ar-collections';
import { orgHasCapability } from '@/lib/accounting/entitlements';

function isIssueType(v: string): v is OutreachIssueType {
  return v in AI_ACTION_TAXONOMY;
}

/** Confirm the client org belongs to the current firm, and load the owner. */
async function resolveClientOwner(orgId: string) {
  const current = await getCurrentEnterprise();
  if (!current || current.id === DEMO_ENTERPRISE_ID) {
    return { error: 'Not available for this enterprise.' as const };
  }
  const [row] = await db
    .select({
      ownerName: users.fullName,
      ownerEmail: users.email,
      ownerPhone: users.phone,
      businessName: organizations.name,
    })
    .from(organizations)
    .innerJoin(users, eq(users.id, organizations.ownerUserId))
    .where(
      and(
        eq(organizations.id, orgId),
        sql`${organizations.ownerUserId} in (
          select client_user_id from enterprise_clients where enterprise_id = ${current.id}
        )`,
      ),
    )
    .limit(1);
  if (!row) return { error: 'Client not found for this enterprise.' as const };
  return { current, ...row };
}

export interface DraftResult {
  ok: boolean;
  subject?: string;
  body?: string;
  error?: string;
}

/**
 * Generate (but do not send) an AI outreach draft for a client issue. Returns
 * the proposed subject + body for the pro to review.
 */
export async function draftAiOutreachAction(input: {
  orgId: string;
  issueType: string;
  channel: OutreachChannel;
  detail: string;
}): Promise<DraftResult> {
  const session = await requireSession();
  if (!isIssueType(input.issueType)) return { ok: false, error: 'Unknown issue type.' };

  const owner = await resolveClientOwner(input.orgId);
  if ('error' in owner) return { ok: false, error: owner.error };

  const firstName = owner.ownerName?.trim().split(/\s+/)[0] ?? null;
  const { system, user } = buildOutreachDraftMessages({
    issueType: input.issueType,
    channel: input.channel,
    clientBusinessName: owner.businessName ?? 'your business',
    ownerFirstName: firstName,
    detail: input.detail,
    firmName: owner.current.name,
  });

  try {
    const res = await chatCompletion(
      { userId: session.id, orgId: input.orgId, actor: 'enterprise', feature: 'ai_outreach_draft' },
      {
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature: 0.5,
        max_tokens: 400,
      },
    );
    const body = res.choices[0]?.message?.content?.trim();
    if (!body) return { ok: false, error: 'The model returned an empty draft.' };
    return {
      ok: true,
      subject: outreachSubject(input.issueType, owner.businessName ?? 'your business'),
      body,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'Draft failed.' };
  }
}

export interface CommitResult {
  ok: boolean;
  status?: 'sent' | 'drafted';
  error?: string;
}

/**
 * Persist an outreach. mode='save' stores a draft only; mode='send' actually
 * delivers (email via Resend, SMS via Twilio; chat is logged for now) and
 * records the contact. Always writes a row to ai_client_outreach.
 */
export async function commitAiOutreachAction(input: {
  orgId: string;
  issueType: string;
  channel: OutreachChannel;
  subject: string;
  body: string;
  mode: 'send' | 'save';
}): Promise<CommitResult> {
  const session = await requireSession();
  if (!isIssueType(input.issueType)) return { ok: false, error: 'Unknown issue type.' };
  const body = input.body.trim();
  if (!body) return { ok: false, error: 'Message body is empty.' };

  const owner = await resolveClientOwner(input.orgId);
  if ('error' in owner) return { ok: false, error: owner.error };

  // AI AR collections is a Plus/Pro capability of the CLIENT's plan (legacy $89
  // clients keep it). Other outreach types (doc chasing, etc.) aren't gated.
  if (
    input.issueType === 'overdue_invoices' &&
    !(await orgHasCapability(input.orgId, 'aiCollections'))
  ) {
    return { ok: false, error: "AI collections isn't included in this client's plan." };
  }

  let status: 'sent' | 'drafted' = 'drafted';
  // Generate the outreach id up front so replies can route back to this row via
  // a signed reply-to token (when inbound email is configured).
  const outreachId = randomUUID();

  // AR collections (overdue_invoices): the client's message carries an Approve
  // link. Clicking it auto-sends the reminders to their overdue customers — so
  // the actual third-party send is gated on the client clicking this.
  const isAr = input.issueType === 'overdue_invoices';
  const approveToken = isAr && input.mode === 'send' ? randomUUID() : null;
  let outgoingBody = body;
  if (approveToken) {
    const origin = await requestOrigin();
    outgoingBody = `${body}\n\n▶ Approve & send the reminders: ${arApproveUrl(origin, approveToken)}`;
  }

  if (input.mode === 'send') {
    if (input.channel === 'email') {
      if (!owner.ownerEmail) return { ok: false, error: 'Client owner has no email on file.' };
      const current = await getCurrentEnterprise();
      const sender = current ? await getEnterpriseSenderIdentity(current.id) : { fromName: null, replyTo: null };
      // Prefer the inbound reply-to (so replies land in-app); fall back to the
      // firm's own address when inbound isn't configured.
      const replyTo = outreachReplyToAddress(outreachId) ?? sender.replyTo;
      const r = await sendTransactionalEmail({
        to: owner.ownerEmail,
        subject: input.subject || outreachSubject(input.issueType, owner.businessName ?? ''),
        text: outgoingBody,
        ...(sender.fromName ? { fromName: sender.fromName } : {}),
        ...(replyTo ? { replyTo } : {}),
        usage: { userId: session.id, orgId: input.orgId, actor: 'enterprise', feature: 'ai_outreach_email' },
      });
      if (!r.sent) return { ok: false, error: r.error ?? (r.skipped ? 'Email not configured.' : 'Email failed.') };
      status = 'sent';
    } else if (input.channel === 'sms') {
      if (!owner.ownerPhone) return { ok: false, error: 'Client owner has no phone on file.' };
      const r = await sendTransactionalSms({
        to: owner.ownerPhone,
        body: outgoingBody,
        usage: { userId: session.id, orgId: input.orgId, actor: 'enterprise', feature: 'ai_outreach_sms' },
      });
      if (!r.sent) return { ok: false, error: r.error ?? (r.skipped ? 'SMS not configured.' : 'SMS failed.') };
      status = 'sent';
    } else {
      // In-app chat delivery isn't wired yet — record it as sent/logged so the
      // dashboard reflects the outreach; real delivery is a follow-up.
      status = 'sent';
    }
  }

  // Carry the attempt counter forward from the latest row for this issue.
  const [prev] = await db
    .select({ attempts: aiClientOutreach.attempts })
    .from(aiClientOutreach)
    .where(and(eq(aiClientOutreach.organizationId, input.orgId), eq(aiClientOutreach.issueType, input.issueType)))
    .orderBy(desc(aiClientOutreach.updatedAt))
    .limit(1);
  const attempts = (prev?.attempts ?? 0) + (status === 'sent' ? 1 : 0);
  const now = new Date().toISOString();

  await db.insert(aiClientOutreach).values({
    id: outreachId,
    enterpriseId: owner.current.id,
    organizationId: input.orgId,
    issueType: input.issueType,
    channel: input.channel,
    status,
    targetType: 'client_owner',
    lastMessageSubject: input.subject || null,
    lastMessageBody: outgoingBody,
    lastContactAt: status === 'sent' ? now : null,
    attempts,
    approveToken: approveToken ?? null,
    createdByUserId: session.id,
    createdAt: now,
    updatedAt: now,
  });

  return { ok: true, status };
}

export interface RowSendResult {
  ok: boolean;
  sent: number;
  failed: number;
  error?: string;
}

/**
 * Draft + send outreach for a SINGLE issue across the chosen channels. One
 * network round-trip per row — the client fires these through a small
 * concurrency pool so a big bulk selection never blocks the UI or hammers the
 * providers. Used by the queue's bulk action (per-row spinners).
 */
export async function sendRowAiOutreachAction(input: {
  orgId: string;
  issueType: string;
  detail: string;
  channels: OutreachChannel[];
}): Promise<RowSendResult> {
  await requireSession();
  if (!isIssueType(input.issueType)) return { ok: false, sent: 0, failed: 0, error: 'Unknown issue type.' };
  const channels = input.channels.filter(
    (c): c is OutreachChannel => c === 'email' || c === 'sms' || c === 'chat',
  );
  const useChannels = channels.length ? channels : (['email'] as OutreachChannel[]);

  let sent = 0;
  let failed = 0;
  let firstError: string | undefined;
  for (const channel of useChannels) {
    const draft = await draftAiOutreachAction({ orgId: input.orgId, issueType: input.issueType, channel, detail: input.detail });
    if (!draft.ok || !draft.body) {
      failed++;
      firstError ??= draft.error;
      continue;
    }
    const res = await commitAiOutreachAction({
      orgId: input.orgId,
      issueType: input.issueType,
      channel,
      subject: draft.subject ?? '',
      body: draft.body,
      mode: 'send',
    });
    if (res.ok) sent++;
    else {
      failed++;
      firstError ??= res.error;
    }
  }
  return { ok: sent > 0, sent, failed, error: firstError };
}

export interface BulkResult {
  sent: number;
  failed: number;
  errors: string[];
}

/**
 * Bulk outreach: for each selected (org, issue) item and each chosen channel,
 * draft the message and SEND it immediately (no per-item review — that's the
 * point of bulk). Reuses the single-item draft + send so behavior stays
 * identical. Returns aggregate counts + up to 5 distinct error messages.
 */
export async function bulkAiOutreachAction(input: {
  items: { orgId: string; issueType: string; detail: string }[];
  channels: OutreachChannel[];
}): Promise<BulkResult> {
  await requireSession();
  const channels = input.channels.filter(
    (c): c is OutreachChannel => c === 'email' || c === 'sms' || c === 'chat',
  );
  const useChannels = channels.length ? channels : (['email'] as OutreachChannel[]);

  let sent = 0;
  let failed = 0;
  const errors: string[] = [];

  for (const item of input.items) {
    for (const channel of useChannels) {
      const draft = await draftAiOutreachAction({
        orgId: item.orgId,
        issueType: item.issueType,
        channel,
        detail: item.detail,
      });
      if (!draft.ok || !draft.body) {
        failed++;
        if (draft.error) errors.push(draft.error);
        continue;
      }
      const res = await commitAiOutreachAction({
        orgId: item.orgId,
        issueType: item.issueType,
        channel,
        subject: draft.subject ?? '',
        body: draft.body,
        mode: 'send',
      });
      if (res.ok) sent++;
      else {
        failed++;
        if (res.error) errors.push(res.error);
      }
    }
  }

  return { sent, failed, errors: Array.from(new Set(errors)).slice(0, 5) };
}
