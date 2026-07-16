'use client';

import { useEffect, useRef, useState } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import type { DocBranding } from '@/lib/documents/layout';
import { TaskCanvas, type Artifact, type ArtifactKind } from '@/app/(organizer)/organizer/tasks/[id]/workspace/_components/TaskCanvas';

export interface QueuedDeliverable {
	id: string;
	description: string;
	docKind: 'letter' | 'email' | 'resolution' | 'deck';
	docTitle: string;
}

interface Props {
	meetingTitle: string;
	contactName: string | null;
	summaryMd: string | null;
	queue: QueuedDeliverable[];
	branding: DocBranding;
}

const VALID_KINDS = new Set<ArtifactKind>(['letter', 'email', 'text', 'resolution', 'deck']);
const DRAFT_CTX_LIMIT = 4000;

/**
 * Post-approval interactive session. The assistant works through the queued
 * deliverables one at a time: it asks the user what it needs, drafts onto the
 * canvas (generate_artifact → render_artifact), and files each finished doc
 * (save_deliverable → debrief_advance, which clears the canvas and moves on).
 *
 * State that drives the AI lives in pageContext.data.current_item; the kickoff
 * is seeded once on mount. Chat behavior here can only be exercised live (no
 * headless coverage) — the wiring mirrors TaskWorkspaceClient/WorkspaceOpener.
 */
export function DebriefSession({ meetingTitle, contactName, summaryMd, queue, branding }: Props) {
	const { registerClientAction, setPageContext, requestSidecarOpen, seedPrompt } = useAssistant();

	const [index, setIndex] = useState(0);
	const [artifact, setArtifact] = useState<Artifact | null>(null);
	const [doneIds, setDoneIds] = useState<string[]>([]);
	const done = index >= queue.length;
	const current = done ? null : queue[index];

	// Debounced draft → page context (so the AI sees the live canvas on revisions).
	const [draftForCtx, setDraftForCtx] = useState<Artifact | null>(null);
	useEffect(() => {
		const t = setTimeout(() => setDraftForCtx(artifact), 300);
		return () => clearTimeout(t);
	}, [artifact]);

	// AI → canvas.
	useEffect(() => {
		return registerClientAction('render_artifact', (raw) => {
			const kind = String(raw.kind ?? '') as ArtifactKind;
			const body = typeof raw.body === 'string' ? raw.body : '';
			if (!VALID_KINDS.has(kind) || !body.trim()) return;
			setArtifact({ kind, title: typeof raw.title === 'string' ? raw.title : '', body });
		});
	}, [registerClientAction]);

	// AI saved a deliverable → clear canvas, advance the queue.
	useEffect(() => {
		return registerClientAction('debrief_advance', (raw) => {
			const savedId = typeof raw.savedItemId === 'string' ? raw.savedItemId : null;
			if (savedId) setDoneIds((p) => (p.includes(savedId) ? p : [...p, savedId]));
			setArtifact(null);
			setDraftForCtx(null);
			setIndex((i) => i + 1);
		});
	}, [registerClientAction]);

	// Page context: grounding + the item being worked + the live draft.
	useEffect(() => {
		setPageContext({
			pageId: 'meeting-debrief-session',
			pageTitle: `Debrief session — ${meetingTitle}`,
			route: undefined,
			data: {
				meeting: { title: meetingTitle, contact: contactName, summary: summaryMd },
				default_signatory: branding.signatoryName
					? { name: branding.signatoryName, title: branding.signatoryTitle ?? null }
					: null,
				queue: queue.map((q, i) => ({ position: i + 1, description: q.description, status: doneIds.includes(q.id) ? 'done' : i === index ? 'in_progress' : 'queued' })),
				current_item: current
					? { id: current.id, description: current.description, doc_kind: current.docKind, suggested_title: current.docTitle }
					: null,
				all_done: done,
				current_draft: draftForCtx
					? { kind: draftForCtx.kind, title: draftForCtx.title, body: draftForCtx.body.slice(0, DRAFT_CTX_LIMIT), truncated: draftForCtx.body.length > DRAFT_CTX_LIMIT }
					: null,
				capabilities: [
					'generate_artifact — draft OR revise the current deliverable on the canvas. Ground it in the meeting summary and what the user tells you; do not invent facts. On revisions, start from current_draft.body and return the FULL updated body.',
					'save_deliverable — file the finished deliverable (Documents) and advance to the next queued item. Call ONLY after the user confirms the draft is good; pass current_item.id as item_id.',
					'find_contact, get_contact_context — pull more detail about the contact when drafting.',
				],
			},
		});
		return () => setPageContext(null);
	}, [setPageContext, meetingTitle, contactName, summaryMd, branding, queue, doneIds, index, current, done, draftForCtx]);

	// Kick off the session once: open the sidecar and seed the first instruction.
	const kicked = useRef(false);
	useEffect(() => {
		if (kicked.current || queue.length === 0) return;
		kicked.current = true;
		const first = queue[0];
		requestSidecarOpen('side');
		seedPrompt(
			`The user just approved the debrief for "${meetingTitle}"${contactName ? ` with ${contactName}` : ''} and chose to create the deliverables together with you. ` +
				`There ${queue.length === 1 ? 'is 1 item' : `are ${queue.length} items`} to produce, one at a time. ` +
				`Start the FIRST item now: "${first.description}" (a ${first.docKind}). ` +
				`Greet briefly, say you'll work through ${queue.length === 1 ? 'it' : 'them'} one at a time, then ask the 1–3 specific questions you need to draft this ${first.docKind} well (tone, recipient, key points, numbers). ` +
				`Do NOT draft until the user answers. When they have, call generate_artifact; once they approve, call save_deliverable with item_id "${first.id}".`,
			{ mode: 'side', hidden: true },
		);
	}, [queue, meetingTitle, contactName, requestSidecarOpen, seedPrompt]);

	// Ask the AI to draft the current item without further questions (skippable).
	const justDraftIt = () => {
		if (!current) return;
		seedPrompt(
			`Skip the questions for "${current.description}" — draft this ${current.docKind} now using your best judgment and the meeting summary, then call generate_artifact. I'll review and tell you what to change.`,
			{ mode: 'side' },
		);
	};

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_18rem]">
			{/* Main canvas — the AI drafts here */}
			<div className="min-w-0">
				{done ? (
					<section className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-6 text-center dark:border-emerald-900/50 dark:bg-emerald-950/30">
						<p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">All deliverables created 🎉</p>
						<p className="mt-1 text-xs text-emerald-700/80 dark:text-emerald-300/70">
							Everything is saved to your Documents. You can close the assistant.
						</p>
					</section>
				) : (
					<TaskCanvas artifact={artifact} onChange={setArtifact} branding={branding} />
				)}
			</div>

			{/* Queue rail */}
			<aside className="flex flex-col gap-3">
				<section className="overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
					<header className="border-b border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-800 dark:bg-zinc-900">
						<h2 className="text-xs font-medium uppercase tracking-wide text-zinc-600 dark:text-zinc-400">Creating with AI</h2>
					</header>
					<ol className="divide-y divide-zinc-100 dark:divide-zinc-800">
						{queue.map((q, i) => {
							const state = doneIds.includes(q.id) ? 'done' : i === index ? 'current' : 'queued';
							return (
								<li key={q.id} className="flex items-start gap-2 px-3 py-2 text-sm">
									<span
										className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold ${
											state === 'done'
												? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300'
												: state === 'current'
													? 'bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300'
													: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400'
										}`}
									>
										{state === 'done' ? '✓' : i + 1}
									</span>
									<div className="min-w-0">
										<div className={`truncate ${state === 'current' ? 'font-medium text-zinc-900 dark:text-zinc-100' : 'text-zinc-600 dark:text-zinc-400'}`}>
											{q.docTitle}
										</div>
										<div className="text-[11px] text-zinc-400">{q.docKind}</div>
									</div>
								</li>
							);
						})}
					</ol>
				</section>

				{!done && current && (
					<button
						type="button"
						onClick={justDraftIt}
						className="rounded-md border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
					>
						Skip questions — just draft it
					</button>
				)}
			</aside>
		</div>
	);
}
