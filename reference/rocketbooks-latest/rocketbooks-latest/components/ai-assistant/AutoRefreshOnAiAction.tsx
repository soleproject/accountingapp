'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

const REFRESH_TOOLS = new Set([
  'create_note',
  'create_task',
  'complete_task',
  'update_task',
  'delete_task',
  'create_appointment',
  'update_appointment',
  'delete_appointment',
  'triage_inbox_message',
  'send_email',
]);

/**
 * Re-renders the current server route whenever a mutating AI tool reports
 * success, so AI-driven changes (new appointments, tasks, notes, …) show up
 * without a manual reload. Shared by the organizer dashboard and calendar;
 * it refreshes whatever route it's mounted under, not a specific page.
 */
export function AutoRefreshOnAiAction() {
  const router = useRouter();
  const { registerToolResultHandler } = useAssistant();

  useEffect(() => {
    return registerToolResultHandler((name, output) => {
      if (!REFRESH_TOOLS.has(name)) return;
      // Successful outputs all look like { ok: true, ... }. The contract is
      // loose so just skip on an explicit ok=false; everything else (no ok
      // field, or ok=true) is treated as a successful mutation.
      const o = output as { ok?: boolean } | null;
      if (o && o.ok === false) return;
      router.refresh();
    });
  }, [registerToolResultHandler, router]);

  return null;
}
