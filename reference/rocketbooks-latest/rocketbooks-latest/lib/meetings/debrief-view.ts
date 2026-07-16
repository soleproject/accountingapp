import 'server-only';
import { and, asc, eq } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	appointments,
	contacts,
	meetingActionItems,
	meetingFollowups,
	recordingOutputs,
	recordingSegments,
	users,
} from '@/db/schema/schema';

export interface DebriefItemView {
	id: string;
	description: string;
	dueHint: string | null;
	status: string;
	ownerName: string | null;
	bucket: 'ai' | 'user' | 'other';
	actionLabel: string;
	resultTaskId: string | null;
	resultDocId: string | null;
}

export interface DebriefView {
	appointmentId: string;
	state: string;
	notesSource: string | null;
	hasRecording: boolean;
	meetingTitle: string;
	contactName: string | null;
	summaryMd: string | null;
	decisions: string[];
	transcript: Array<{ speaker: string; text: string }>;
	buckets: { ai: DebriefItemView[]; user: DebriefItemView[]; other: DebriefItemView[] };
}

function actionLabel(bucket: string, proposedAction: unknown, ownerName: string | null): string {
	const a = (proposedAction ?? {}) as { kind?: string; docKind?: string };
	if (bucket === 'ai') {
		if (a.kind === 'send_booking_link') return 'RocketSuite drafts an email with your booking link';
		if (a.kind === 'draft_document') {
			const k = a.docKind === 'contract' ? 'contract (draft — not legal advice)' : a.docKind ?? 'document';
			return `RocketSuite drafts the ${k}`;
		}
		if (a.kind === 'create_note') return 'RocketSuite saves a note';
		return 'RocketSuite handles it';
	}
	if (bucket === 'other') return `Task for ${ownerName ?? 'the other party'}`;
	return 'Task on your list';
}

/** Load everything the debrief view needs for one meeting, in serializable form. */
export async function loadDebriefView(orgId: string, appointmentId: string): Promise<DebriefView | null> {
	const [fu] = await db
		.select({
			state: meetingFollowups.state,
			notesSource: meetingFollowups.notesSource,
			recordingId: meetingFollowups.recordingId,
			followupId: meetingFollowups.id,
			meetingTitle: appointments.title,
			contactName: contacts.contactName,
		})
		.from(meetingFollowups)
		.innerJoin(appointments, eq(appointments.id, meetingFollowups.appointmentId))
		.leftJoin(contacts, eq(contacts.id, appointments.contactId))
		.where(and(eq(meetingFollowups.appointmentId, appointmentId), eq(meetingFollowups.organizationId, orgId)))
		.limit(1);
	if (!fu) return null;

	let summaryMd: string | null = null;
	let decisions: string[] = [];
	const transcript: Array<{ speaker: string; text: string }> = [];

	if (fu.recordingId) {
		const [out] = await db
			.select({ summaryMd: recordingOutputs.summaryMd, decisions: recordingOutputs.decisions })
			.from(recordingOutputs)
			.where(eq(recordingOutputs.recordingId, fu.recordingId))
			.limit(1);
		if (out) {
			summaryMd = out.summaryMd ?? null;
			decisions = Array.isArray(out.decisions)
				? (out.decisions as unknown[]).filter((d): d is string => typeof d === 'string')
				: [];
		}

		const segs = await db
			.select({
				label: recordingSegments.speakerLabel,
				text: recordingSegments.text,
				speakerUserId: recordingSegments.speakerUserId,
				contactName: contacts.contactName,
				userName: users.fullName,
			})
			.from(recordingSegments)
			.leftJoin(contacts, eq(contacts.id, recordingSegments.speakerContactId))
			.leftJoin(users, eq(users.id, recordingSegments.speakerUserId))
			.where(eq(recordingSegments.recordingId, fu.recordingId))
			.orderBy(asc(recordingSegments.startMs));
		for (const s of segs) {
			const speaker = s.speakerUserId ? 'You' : s.contactName ?? s.label;
			transcript.push({ speaker, text: s.text });
		}
	}

	const itemRows = await db
		.select({
			id: meetingActionItems.id,
			description: meetingActionItems.description,
			dueHint: meetingActionItems.dueHint,
			status: meetingActionItems.status,
			bucket: meetingActionItems.bucket,
			proposedAction: meetingActionItems.proposedAction,
			resultTaskId: meetingActionItems.resultTaskId,
			resultDocId: meetingActionItems.resultDocId,
			ownerName: contacts.contactName,
		})
		.from(meetingActionItems)
		.leftJoin(contacts, eq(contacts.id, meetingActionItems.ownerContactId))
		.where(eq(meetingActionItems.followupId, fu.followupId))
		.orderBy(asc(meetingActionItems.createdAt));

	const buckets = { ai: [] as DebriefItemView[], user: [] as DebriefItemView[], other: [] as DebriefItemView[] };
	for (const r of itemRows) {
		const bucket = (['ai', 'user', 'other'].includes(r.bucket) ? r.bucket : 'user') as 'ai' | 'user' | 'other';
		const view: DebriefItemView = {
			id: r.id,
			description: r.description,
			dueHint: r.dueHint,
			status: r.status,
			ownerName: r.ownerName,
			bucket,
			actionLabel: actionLabel(bucket, r.proposedAction, r.ownerName),
			resultTaskId: r.resultTaskId,
			resultDocId: r.resultDocId,
		};
		buckets[bucket].push(view);
	}

	return {
		appointmentId,
		state: fu.state,
		notesSource: fu.notesSource,
		hasRecording: !!fu.recordingId,
		meetingTitle: fu.meetingTitle,
		contactName: fu.contactName,
		summaryMd,
		decisions,
		transcript,
		buckets,
	};
}
