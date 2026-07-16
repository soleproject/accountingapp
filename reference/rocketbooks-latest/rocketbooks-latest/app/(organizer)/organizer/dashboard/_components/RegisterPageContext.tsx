'use client';

import { useEffect } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';

interface Props {
  openTaskCount: number;
  recentNoteCount: number;
  nextTaskTitle: string | null;
  todaysAppointmentCount: number;
  openInboxCount: number;
}

export function RegisterPageContext({
  openTaskCount,
  recentNoteCount,
  nextTaskTitle,
  todaysAppointmentCount,
  openInboxCount,
}: Props) {
  const { setPageContext } = useAssistant();
  useEffect(() => {
    setPageContext({
      pageId: 'organizer-dashboard',
      pageTitle: 'Organizer Dashboard',
      route: '/organizer/dashboard',
      data: {
        open_task_count: openTaskCount,
        recent_note_count: recentNoteCount,
        next_task: nextTaskTitle,
        todays_appointment_count: todaysAppointmentCount,
        open_inbox_count: openInboxCount,
        capabilities: [
          'create_note — save a note for the user (optionally linked to a contact)',
          'create_task — open a new follow-up task',
          'complete_task — mark a task done by id',
          'update_task — edit title / description / dueDate / priority / contactId of a task',
          'delete_task — permanently delete a task by id (confirm with user first)',
          'list_my_open_tasks — list what the user already has on their plate',
          'create_appointment — add a calendar appointment',
          'update_appointment — reschedule or edit an appointment by id',
          'delete_appointment — cancel an appointment by id (confirm with user first)',
          'list_my_appointments — list upcoming or today\'s appointments',
          'list_inbox — list open inbound messages (emails/SMS) for the user',
          'triage_inbox_message — mark an inbox message as triaged or archived',
          'send_email — send an email after reading the draft back to the user',
          'lookup_contact — resolve a contact id by name before linking',
          'get_contact_context — load recent notes / tasks / appointments / inbox for a contact in one call',
        ],
      },
    });
    return () => setPageContext(null);
  }, [
    setPageContext,
    openTaskCount,
    recentNoteCount,
    nextTaskTitle,
    todaysAppointmentCount,
    openInboxCount,
  ]);
  return null;
}
