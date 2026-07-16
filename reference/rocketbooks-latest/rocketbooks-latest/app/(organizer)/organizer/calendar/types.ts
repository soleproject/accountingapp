/** Shared calendar types. Kept out of page.tsx so client components can
 *  import them without pulling a server module into the client bundle. */

export interface CalendarAppointment {
  id: string;
  title: string;
  startsAt: string;
  endsAt: string | null;
  location: string | null;
  contactId: string | null;
  contactName: string | null;
  googleEventId: string | null;
  videoEnabled: boolean | null;
  guestEmails: string | null;
  /** The company this meeting is "regarding" — the appointment's org. */
  organizationId: string | null;
  organizationName: string | null;
}

/** A company the current user can assign an appointment's "regarding" to. */
export interface RegardingOrgOption {
  id: string;
  name: string;
}

export interface ContextNote {
  id: string;
  body: string;
  source: string;
  createdAt: string;
}

export interface ContextTask {
  id: string;
  title: string;
  dueDate: string | null;
  priority: string | null;
}

export interface ContextEmail {
  id: string;
  subject: string | null;
  body: string;
  source: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string;
  status: string;
}

export interface ContextText {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  createdAt: string;
}

/** Payload returned by GET /api/organizer/appointments/[id]. */
export interface AppointmentContext {
  appointment: {
    id: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    contactId: string | null;
    contactName: string | null;
    googleEventId: string | null;
    videoEnabled: boolean | null;
    guestEmails: string | null;
    organizationId: string | null;
    organizationName: string | null;
  };
  notes: ContextNote[];
  tasks: ContextTask[];
  emails: ContextEmail[];
  texts: ContextText[];
  /** False when the Texts feature isn't enabled for this user/org. */
  textsEnabled: boolean;
}
