'use client';

import { useState, useTransition } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { sendReplyAction } from '../_actions/sendReply';
import { regenerateDraftAction } from '../_actions/regenerateDraft';

/**
 * Reply editor: Tiptap pre-filled with the AI draft (or empty if the
 * user hit "draft anyway" on a skipped message). Three actions:
 *   - Send       → sendReplyAction (flips message to sent + triaged)
 *   - Regenerate → regenerateDraftAction (re-asks the AI)
 *   - Discard    → would mark skipped_noise; v1 leaves this as Cancel
 *                  back to the message view since we don't want a
 *                  one-click "destroy the draft" trap.
 *
 * The editor is uncontrolled w.r.t. parent re-renders; we capture the
 * latest HTML on every keystroke for the send payload, and let parent
 * navigation drive any reset.
 */

interface Props {
	messageId: string;
	initialSubject: string;
	initialHtml: string;
	/** Recipient address — display only, used by the action via lookup. */
	toAddress: string;
	/** Non-Gmail providers may not auto-save to Sent; show a soft notice. */
	mayNotShowInSent: boolean;
}

export function ReplyComposer({ messageId, initialSubject, initialHtml, toAddress, mayNotShowInSent }: Props) {
	const [subject, setSubject] = useState<string>(initialSubject);
	const [html, setHtml] = useState<string>(initialHtml);
	const [error, setError] = useState<string | null>(null);
	const [isSending, startSendTransition] = useTransition();
	const [isRegenerating, startRegenTransition] = useTransition();

	const editor = useEditor({
		extensions: [
			StarterKit,
			Link.configure({
				openOnClick: false,
				autolink: true,
				HTMLAttributes: { rel: 'noopener noreferrer' },
			}),
		],
		content: initialHtml,
		immediatelyRender: false,
		editorProps: {
			attributes: {
				class:
					'min-h-[180px] max-h-[480px] overflow-y-auto rounded-b-md border border-t-0 border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none dark:border-zinc-800 dark:bg-zinc-950 prose prose-sm dark:prose-invert max-w-none',
			},
		},
		onUpdate: ({ editor }) => setHtml(editor.getHTML()),
	});

	const handleSend = () => {
		setError(null);
		// Plain-text fallback: strip tags from the current editor HTML.
		const text = (editor?.getText() ?? '').trim();
		if (!text) {
			setError('Cannot send an empty reply');
			return;
		}
		startSendTransition(async () => {
			const r = await sendReplyAction({ messageId, subject, html, text });
			if (!r.ok) setError(r.error ?? 'Send failed');
			// On success the server-side revalidatePath causes the page to
			// re-render with ai_status='sent', which hides this composer.
		});
	};

	const handleRegenerate = () => {
		setError(null);
		startRegenTransition(async () => {
			const r = await regenerateDraftAction({ messageId });
			if (!r.ok) setError(r.error ?? 'Regenerate failed');
			// Server-side revalidate causes re-render; the parent will
			// pass new initialHtml/initialSubject in via key changes.
		});
	};

	const isBusy = isSending || isRegenerating;

	return (
		<div className="flex flex-col gap-3">
			<div className="text-xs text-zinc-500">
				Reply to <span className="font-mono">{toAddress}</span>
			</div>

			<label className="flex flex-col gap-1 text-sm">
				<span className="font-medium text-zinc-700 dark:text-zinc-300">Subject</span>
				<input
					type="text"
					value={subject}
					onChange={(e) => setSubject(e.target.value)}
					className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
				/>
			</label>

			<div>
				<Toolbar editor={editor} />
				<EditorContent editor={editor} />
			</div>

			{mayNotShowInSent && (
				<div className="text-xs text-zinc-500">
					Heads up: with non-Gmail providers, the sent reply may take a minute to appear in your provider's Sent folder.
				</div>
			)}

			{error && (
				<div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-300">
					{error}
				</div>
			)}

			<div className="flex items-center justify-end gap-2">
				<button
					type="button"
					onClick={handleRegenerate}
					disabled={isBusy}
					className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
				>
					{isRegenerating ? 'Regenerating…' : 'Regenerate'}
				</button>
				<button
					type="button"
					onClick={handleSend}
					disabled={isBusy || !subject.trim() || !html.trim()}
					className="rounded-md bg-blue-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
				>
					{isSending ? 'Sending…' : 'Send reply'}
				</button>
			</div>
		</div>
	);
}

function Toolbar({ editor }: { editor: Editor | null }) {
	if (!editor) return null;
	return (
		<div className="flex flex-wrap items-center gap-1 rounded-t-md border border-zinc-200 bg-zinc-50 px-2 py-1 dark:border-zinc-800 dark:bg-zinc-900">
			<Btn active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()} label="Bold"><span className="font-bold">B</span></Btn>
			<Btn active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()} label="Italic"><span className="italic">I</span></Btn>
			<Btn active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()} label="Bullet list">•</Btn>
			<Btn active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()} label="Numbered list">1.</Btn>
		</div>
	);
}

function Btn({
	children,
	onClick,
	active,
	disabled,
	label,
}: {
	children: React.ReactNode;
	onClick: () => void;
	active: boolean;
	disabled?: boolean;
	label: string;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			aria-label={label}
			title={label}
			className={`flex h-7 min-w-[28px] items-center justify-center rounded px-2 text-xs transition-colors ${
				active
					? 'bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300'
					: 'text-zinc-700 hover:bg-zinc-200 dark:text-zinc-300 dark:hover:bg-zinc-800'
			} ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
		>
			{children}
		</button>
	);
}
