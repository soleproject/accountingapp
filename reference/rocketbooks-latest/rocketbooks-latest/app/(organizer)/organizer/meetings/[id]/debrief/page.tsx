import { notFound } from 'next/navigation';
import { and, eq, asc } from 'drizzle-orm';
import { db } from '@/db/client';
import {
	appointments,
	contacts,
	meetingActionItems,
	meetingFollowups,
	recordingOutputs,
} from '@/db/schema/schema';
import { requireSession } from '@/lib/auth/session';
import { getCurrentOrgId } from '@/lib/auth/org';
import { DebriefReview, type DebriefItem } from './_components/DebriefReview';

interface PageProps {
	params: Promise<{ id: string }>;
}

export default async function MeetingDebriefPage({ params }: PageProps) {
	await requireSession();
	const orgId = await getCurrentOrgId();
	const { id: appointmentId } = await params;

	const [fu] = await db
		.select({
			followupId: meetingFollowups.id,
			state: meetingFollowups.state,
			notesSource: meetingFollowups.notesSource,
			recordingId: meetingFollowups.recordingId,
			title: appointments.title,
			contactName: contacts.contactName,
			endedAt: meetingFollowups.meetingEndedAt,
		})
		.from(meetingFollowups)
		.innerJoin(appointments, eq(appointments.id, meetingFollowups.appointmentId))
		.leftJoin(contacts, eq(contacts.id, appointments.contactId))
		.where(and(eq(meetingFollowups.appointmentId, appointmentId), eq(meetingFollowups.organizationId, orgId)))
		.limit(1);

	if (!fu) notFound();

	const itemRows = await db
		.select({
			id: meetingActionItems.id,
			description: meetingActionItems.description,
			ownerType: meetingActionItems.ownerType,
			ownerName: contacts.contactName,
			dueHint: meetingActionItems.dueHint,
			status: meetingActionItems.status,
			resultTaskId: meetingActionItems.resultTaskId,
		})
		.from(meetingActionItems)
		.leftJoin(contacts, eq(contacts.id, meetingActionItems.ownerContactId))
		.where(eq(meetingActionItems.followupId, fu.followupId))
		.orderBy(asc(meetingActionItems.createdAt));

	const items: DebriefItem[] = itemRows.map((r) => ({
		id: r.id,
		description: r.description,
		ownerLabel: r.ownerType === 'contact' && r.ownerName ? r.ownerName : 'You',
		dueHint: r.dueHint,
		status: r.status,
		resultTaskId: r.resultTaskId,
	}));

	let summary: { summaryMd: string | null; decisions: string[] } | null = null;
	if (fu.recordingId) {
		const [out] = await db
			.select({ summaryMd: recordingOutputs.summaryMd, decisions: recordingOutputs.decisions })
			.from(recordingOutputs)
			.where(eq(recordingOutputs.recordingId, fu.recordingId))
			.limit(1);
		if (out) {
			summary = {
				summaryMd: out.summaryMd ?? null,
				decisions: Array.isArray(out.decisions)
					? (out.decisions as unknown[]).filter((d): d is string => typeof d === 'string')
					: [],
			};
		}
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
			<header>
				<h1 className="text-2xl font-semibold">Call Debrief</h1>
				<p className="text-sm text-zinc-500 dark:text-zinc-400">
					{fu.title}
					{fu.contactName ? ` · ${fu.contactName}` : ''}
				</p>
			</header>

			{summary?.summaryMd && (
				<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
					<header className="border-b border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900">
						<h2 className="text-sm font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Summary</h2>
					</header>
					<div className="whitespace-pre-wrap px-4 py-3 text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
						{summary.summaryMd}
					</div>
					{summary.decisions.length > 0 && (
						<div className="border-t border-zinc-100 px-4 py-3 text-sm dark:border-zinc-800">
							<div className="mb-1 font-medium text-zinc-700 dark:text-zinc-300">Decisions</div>
							<ul className="list-disc pl-5 text-zinc-600 dark:text-zinc-400">
								{summary.decisions.map((d, i) => (
									<li key={i}>{d}</li>
								))}
							</ul>
						</div>
					)}
				</section>
			)}

			<DebriefReview
				appointmentId={appointmentId}
				state={fu.state}
				notesSource={fu.notesSource}
				hasRecording={!!fu.recordingId}
				items={items}
			/>
		</div>
	);
}
