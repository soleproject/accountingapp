'use client';

import { useEffect, useState, useTransition } from 'react';
import { useAssistant } from '@/components/ai-assistant/AssistantContext';
import { useCardFlip, type FlipCompose } from './CardFlipContext';
import { FlipComposeDraftControls } from './FlipComposeDraftControls';
import { AttachDocumentControl, type AttachedDoc } from './AttachDocumentControl';

const MAX_TEXT_CHARS = 1600;

/**
 * Compose editor shown on the back of the flipped Open Tasks card when an
 * outbound task ("Send Q2 letter to Brookfield") is opened. Unlike the reply
 * editors, this is a FRESH message addressed from the task's linked contact.
 *
 * - text: sends end-to-end via /api/texts/send (keys off contactId).
 * - email: draft + save only for now — there's no send-a-new-email path yet
 *   (the inbox only supports reply-by-message-id), so Send is disabled with a
 *   clear note rather than pretending to send.
 */
export function FlipComposeEditor({ target }: { target: FlipCompose }) {
  const { close } = useCardFlip();
  const { registerClientAction, setPageContext } = useAssistant();
  const isText = target.channel === 'text';
  const to = target.contactName ?? target.to ?? 'recipient';

  const [subject, setSubject] = useState(target.subject ?? '');
  const [body, setBody] = useState(target.initialBody ?? '');
  const [attachments, setAttachments] = useState<AttachedDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, start] = useTransition();

  // Let the assistant patch this message via generate_artifact → render_artifact
  // (same channel the canvas uses), so "add a line about X" updates the box.
  // Also publish the live draft as page context so the AI revises from it.
  useEffect(() => {
    return registerClientAction('render_artifact', (raw) => {
      const nextBody = typeof raw.body === 'string' ? raw.body : '';
      if (!nextBody.trim()) return;
      setBody(isText ? nextBody.slice(0, MAX_TEXT_CHARS) : nextBody);
      if (!isText && typeof raw.title === 'string' && raw.title.trim()) setSubject(raw.title);
    });
  }, [registerClientAction, isText]);

  useEffect(() => {
    setPageContext({
      pageId: 'task-workspace',
      pageTitle: `Task step — ${target.taskTitle}`,
      route: '/organizer/dashboard',
      data: {
        channel: target.channel,
        recipient: target.contactName ?? target.to,
        current_draft: { kind: target.channel, title: subject, body },
        capabilities: [
          `generate_artifact — revise the ${target.channel} on screen: return the FULL updated body (kind="${target.channel}"). Start from current_draft.body and apply only the requested change.`,
        ],
      },
    });
    return () => setPageContext(null);
  }, [setPageContext, target.taskTitle, target.channel, target.contactName, target.to, subject, body]);

  const addAttachment = (doc: AttachedDoc) =>
    setAttachments((prev) => (prev.some((a) => a.id === doc.id) ? prev : [...prev, doc]));
  const removeAttachment = (id: string) => setAttachments((prev) => prev.filter((a) => a.id !== id));

  // Email send-new isn't wired yet; text needs a linked contact id.
  const canSendText = isText && !!target.contactId;
  const accent = isText ? 'sky' : 'amber';

  const handleSendText = () => {
    setError(null);
    const trimmed = body.trim();
    if (!trimmed) {
      setError('Write a message first.');
      return;
    }
    if (!target.contactId) {
      setError('This task’s contact has no linked number, so it can’t be texted here.');
      return;
    }
    start(async () => {
      try {
        const res = await fetch('/api/texts/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contactId: target.contactId, body: trimmed }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          setError(data?.error ?? `Send failed (${res.status})`);
          return;
        }
        setSent(true);
        setTimeout(() => close(), 1000);
      } catch {
        setError('Send failed — network error.');
      }
    });
  };

  const headTone = isText
    ? 'bg-sky-100 text-sky-600 dark:bg-sky-900/40 dark:text-sky-300'
    : 'bg-amber-100 text-amber-600 dark:bg-amber-900/40 dark:text-amber-300';
  const len = body.length;

  return (
    // Viewport-relative min-h so the card reaches near the bottom of the page
    // (rather than a fixed 460px that leaves dead space), and stays uniform
    // whether it renders in the flip's fixed-height face (inbox/text reply) or
    // the task-step runner's flow-height face (where h-full alone collapses).
    <div className="flex h-full min-h-[calc(100vh-12rem)] flex-col rounded-2xl border border-zinc-200/80 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg shadow-sm ${headTone}`}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
            </svg>
          </span>
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            {isText ? 'New text' : 'New email'}
          </h2>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close composer"
          className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2">
        {/* What the task is, per the AI classification. */}
        {target.note && (
          <p className="rounded-md bg-zinc-50 px-3 py-1.5 text-[11px] text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
            For task: <span className="text-zinc-700 dark:text-zinc-300">{target.taskTitle}</span>
          </p>
        )}

        <div className="text-xs text-zinc-500 dark:text-zinc-400">
          To <span className="font-medium text-zinc-700 dark:text-zinc-300">{to}</span>
          {target.to && <span className="ml-1 font-mono text-[11px]">&lt;{target.to}&gt;</span>}
        </div>

        {!isText && (
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            disabled={pending || sent}
            placeholder="Subject"
            className="w-full rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm focus:border-amber-500 focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950"
          />
        )}

        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          disabled={pending || sent}
          maxLength={isText ? MAX_TEXT_CHARS : undefined}
          placeholder={isText ? `Text ${to}…` : `Write to ${to}…`}
          className={`min-h-0 flex-1 resize-none rounded-md border border-zinc-200 bg-white px-3 py-2 text-sm leading-relaxed focus:outline-none disabled:opacity-60 dark:border-zinc-800 dark:bg-zinc-950 ${
            isText ? 'focus:border-sky-500' : 'focus:border-amber-500'
          }`}
        />

        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {attachments.map((a) => (
              <span
                key={a.id}
                className="inline-flex items-center gap-1 rounded-full bg-zinc-100 py-0.5 pl-2 pr-1 text-[11px] text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                title={a.source === 'uploaded' ? 'Uploaded file' : 'Created document'}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                </svg>
                <span className="max-w-[140px] truncate">{a.title}</span>
                <button
                  type="button"
                  onClick={() => removeAttachment(a.id)}
                  aria-label={`Remove ${a.title}`}
                  className="ml-0.5 flex h-4 w-4 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700 dark:hover:bg-zinc-700 dark:hover:text-zinc-200"
                >
                  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
              </span>
            ))}
          </div>
        )}

        {!isText && (
          <p className="rounded-md border border-amber-200/70 bg-amber-50 px-3 py-1.5 text-[11px] text-amber-800 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-300">
            Draft &amp; save works now. Sending a brand-new email from here is coming soon — for
            now, copy the draft or open the task workspace to send.
            {attachments.length > 0 && ' Attached documents are recorded and will travel with the email once sending is enabled.'}
          </p>
        )}

        {error && (
          <div className="rounded-md border border-rose-300 bg-rose-50 px-3 py-2 text-xs text-rose-800 dark:border-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
            {error}
          </div>
        )}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <FlipComposeDraftControls
            taskId={target.taskId}
            channel={target.channel}
            accent={accent}
            disabled={pending || sent}
            onDraft={(text) => setBody(isText ? text.slice(0, MAX_TEXT_CHARS) : text)}
            onError={setError}
          />
          <AttachDocumentControl attached={attachments} onAttach={addAttachment} disabled={pending || sent} />
        </div>
        <div className="flex items-center gap-2">
          {sent ? (
            <span className="text-sm text-emerald-600 dark:text-emerald-400">Sent ✓</span>
          ) : isText ? (
            <span className={`text-[11px] ${len > MAX_TEXT_CHARS ? 'text-rose-600' : 'text-zinc-400'}`}>
              {len} / {MAX_TEXT_CHARS}
            </span>
          ) : null}
          <button
            type="button"
            onClick={close}
            disabled={pending}
            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
          >
            Cancel
          </button>
          {isText ? (
            <button
              type="button"
              onClick={handleSendText}
              disabled={pending || sent || !canSendText || !body.trim()}
              className="rounded-md bg-sky-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {pending ? 'Sending…' : 'Send text'}
            </button>
          ) : (
            <button
              type="button"
              disabled
              title="Sending a new email from here is coming soon"
              className="cursor-not-allowed rounded-md bg-zinc-300 px-4 py-1.5 text-sm font-medium text-white opacity-60 dark:bg-zinc-700"
            >
              Send email
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
