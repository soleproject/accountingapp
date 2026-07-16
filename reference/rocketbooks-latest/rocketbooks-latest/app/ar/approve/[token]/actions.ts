'use server';

import { redirect } from 'next/navigation';
import { lookupArApprove, markOutreachApproved, sendArRemindersForOutreach } from '@/lib/enterprise/ar-collections';

/**
 * The client tapped "Approve & send" (POST only — GET never sends, so email
 * scanners can't trigger it). Single-use: markOutreachApproved gates re-fires;
 * the AR engine also has a 7-day per-customer cooldown.
 */
export async function approveArAction(formData: FormData): Promise<void> {
  const token = String(formData.get('token') ?? '');
  const back = (status: string, extra = '') => `/ar/approve/${encodeURIComponent(token || 'invalid')}?status=${status}${extra}`;
  if (!token) redirect(back('error'));

  const info = await lookupArApprove(token);
  if (!info) redirect(back('error'));
  if (info.alreadyApproved) redirect(back('already'));

  // Atomic single-use claim — if another click already approved, bail.
  const claimed = await markOutreachApproved(info.outreachId);
  if (!claimed) redirect(back('already'));

  const res = await sendArRemindersForOutreach(info.outreachId);
  redirect(back('sent', `&n=${res.sent}`));
}
