import 'server-only';
import { getActionCards, type ActionCard } from '@/lib/server/action-cards';
import { signDigestUnsubToken } from './unsubscribe-token';

/**
 * Build the weekly digest email for one org from the existing action-card
 * worklist. Returns { subject, html, text }. When there are no action items it
 * produces a short "all clear" check-in (opted-in owners still hear from us
 * weekly). Pure-ish: only reads via getActionCards. Sender branding is handled
 * by sendTransactionalEmail({ brandForOrgId }) at the send site.
 */

const APP_BASE = 'https://app.rocketbooks.ai';

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cardHref(card: ActionCard): string {
  return card.action.kind === 'navigate' ? APP_BASE + card.action.href : APP_BASE + '/dashboard';
}

function wrap(inner: string, unsub: string): string {
  return `<div style="max-width:560px;margin:0 auto;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#18181b;font-size:14px;line-height:1.5">
  <h1 style="font-size:18px;margin:0 0 16px">Your weekly book review</h1>
  ${inner}
  <p style="margin-top:28px;color:#a1a1aa;font-size:12px">You're getting this weekly summary because you turned it on in Settings. <a href="${unsub}" style="color:#a1a1aa">Unsubscribe</a>.</p>
</div>`;
}

export interface DigestEmail {
  subject: string;
  html: string;
  text: string;
  cardCount: number;
}

export async function buildWeeklyDigest(
  orgId: string,
  ownerUserId: string,
  orgName?: string | null,
): Promise<DigestEmail> {
  const cards = await getActionCards(orgId);
  cards.sort((a, b) => (a.tier !== b.tier ? (a.tier === 'blocking' ? -1 : 1) : a.priority - b.priority));

  const unsub = `${APP_BASE}/api/digest/unsubscribe?token=${encodeURIComponent(signDigestUnsubToken(ownerUserId))}`;
  const who = orgName ?? 'your business';

  if (cards.length === 0) {
    const subject = 'Your books are in good shape this week ✓';
    const html = wrap(`<p>Good news — nothing needs your attention in ${escapeHtml(who)}'s books this week. We'll keep watching and flag anything that comes up.</p>`, unsub);
    const text = `Good news — nothing needs your attention in ${who}'s books this week. We'll keep watching.\n\nUnsubscribe: ${unsub}`;
    return { subject, html, text, cardCount: 0 };
  }

  const rows = cards
    .map((c) => {
      const body = c.body ? `<div style="color:#71717a;font-size:13px;margin-top:2px">${escapeHtml(c.body)}</div>` : '';
      return `<tr><td style="padding:10px 0;border-bottom:1px solid #ececec"><a href="${cardHref(c)}" style="color:#18181b;text-decoration:none;font-weight:600">${escapeHtml(c.title)}</a>${body}</td></tr>`;
    })
    .join('');
  const textRows = cards.map((c) => `• ${c.title}${c.body ? ` — ${c.body}` : ''}\n  ${cardHref(c)}`).join('\n');

  const n = cards.length;
  const subject = `${n} thing${n === 1 ? '' : 's'} need your attention in ${who}`;
  const html = wrap(
    `<p>Here's what needs your attention in ${escapeHtml(who)}'s books this week:</p>
  <table style="width:100%;border-collapse:collapse">${rows}</table>
  <p style="margin-top:20px"><a href="${APP_BASE}/dashboard" style="background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;display:inline-block">Open RocketBooks</a></p>`,
    unsub,
  );
  const text = `Here's what needs your attention in ${who}'s books this week:\n\n${textRows}\n\nOpen RocketBooks: ${APP_BASE}/dashboard\n\nUnsubscribe: ${unsub}`;
  return { subject, html, text, cardCount: n };
}
