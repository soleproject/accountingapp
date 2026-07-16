'use client';

import { useEffect } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  contactId: string;
  contactName: string;
  email: string | null;
  phone: string | null;
  openTaskCount: number;
  noteCount: number;
  upcomingAppointmentCount: number;
  recentInboxCount: number;
}

export function RegisterContactPageContext({
  contactId,
  contactName,
  email,
  phone,
  openTaskCount,
  noteCount,
  upcomingAppointmentCount,
  recentInboxCount,
}: Props) {
  const { setPageContext } = useAssistant();
  useEffect(() => {
    setPageContext({
      pageId: 'organizer-contact',
      pageTitle: `Organizer · ${contactName}`,
      route: `/organizer/contacts/${contactId}`,
      data: {
        contact_id: contactId,
        contact_name: contactName,
        email,
        phone,
        open_task_count: openTaskCount,
        note_count: noteCount,
        upcoming_appointment_count: upcomingAppointmentCount,
        recent_inbox_count: recentInboxCount,
        capabilities: [
          'get_contact_context — load recent activity for this contact (call this FIRST when the user logs a conversation).',
          'create_note — save a note. PREFER attaching it to this contact via contactId.',
          'create_task — open a follow-up. PREFER attaching to this contact via contactId.',
          'complete_task — mark an existing task done by id.',
          'update_task — edit an existing task by id (title, dueDate, priority, etc).',
          'delete_task — permanently delete a task by id (confirm with user first).',
          'create_appointment — schedule with this contact (pass contactId).',
          'update_appointment — reschedule or edit an existing appointment by id.',
          'delete_appointment — cancel an appointment by id (confirm with user first).',
          'list_inbox — list open inbound messages for the user.',
          'triage_inbox_message — mark an inbox message as triaged or archived.',
          'send_email — draft + confirm + send to this contact.',
        ],
      },
    });
    return () => setPageContext(null);
  }, [
    setPageContext,
    contactId,
    contactName,
    email,
    phone,
    openTaskCount,
    noteCount,
    upcomingAppointmentCount,
    recentInboxCount,
  ]);
  return null;
}
