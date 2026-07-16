'use client';

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { PdfCanvas } from '@/components/pdf/PdfCanvas';
import { saveBuilderAction, sendRequestAction, type BuilderPayload } from '../_actions/builder';
import type { DeliveryChannel, RecipientLink } from '@/lib/signatures/notify';
import type { FieldType } from '@/lib/signatures/store';

interface UIRecipient {
  id: string;
  name: string;
  email: string;
  phone: string;
}
interface UIField {
  id: string;
  recipientId: string;
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  type: FieldType;
  required: boolean;
}

interface Props {
  requestId: string;
  pdfUrl: string;
  initialTitle: string;
  initialMessage: string;
  initialSequential: boolean;
  initialRecipients: UIRecipient[];
  initialFields: UIField[];
}

const RECIPIENT_COLORS = ['#4f46e5', '#059669', '#d97706', '#e11d48', '#0284c7', '#7c3aed'];
const TOOLS: { type: FieldType; label: string; w: number; h: number }[] = [
  { type: 'signature', label: 'Signature', w: 0.25, h: 0.07 },
  { type: 'initials', label: 'Initials', w: 0.1, h: 0.06 },
  { type: 'date', label: 'Date', w: 0.16, h: 0.04 },
  { type: 'name', label: 'Name', w: 0.22, h: 0.04 },
  { type: 'text', label: 'Text', w: 0.22, h: 0.04 },
  { type: 'checkbox', label: 'Checkbox', w: 0.035, h: 0.028 },
];

function uid(): string {
  return crypto.randomUUID();
}

export function SignatureBuilder({ requestId, pdfUrl, initialTitle, initialMessage, initialSequential, initialRecipients, initialFields }: Props) {
  const router = useRouter();
  const [title, setTitle] = useState(initialTitle);
  const [message, setMessage] = useState(initialMessage);
  const [sequential, setSequential] = useState(initialSequential);
  const [recipients, setRecipients] = useState<UIRecipient[]>(
    initialRecipients.length > 0 ? initialRecipients : [{ id: uid(), name: '', email: '', phone: '' }],
  );
  const [fields, setFields] = useState<UIField[]>(initialFields);
  const [activeRecipientId, setActiveRecipientId] = useState(recipients[0]?.id ?? '');
  const [armed, setArmed] = useState<FieldType | null>(null);
  const [channels, setChannels] = useState<DeliveryChannel[]>(['email', 'link']);
  const [busy, setBusy] = useState<'save' | 'send' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [links, setLinks] = useState<RecipientLink[] | null>(null);

  const colorFor = (rid: string) => RECIPIENT_COLORS[Math.max(0, recipients.findIndex((r) => r.id === rid)) % RECIPIENT_COLORS.length];
  const activeRecipient = recipients.find((r) => r.id === activeRecipientId) ?? recipients[0];

  const dragRef = useRef<{ id: string; startX: number; startY: number; origX: number; origY: number; pw: number; ph: number } | null>(null);

  const buildPayload = (): BuilderPayload => ({
    title,
    message,
    sequential,
    recipients: recipients.map((r, i) => ({ id: r.id, name: r.name, email: r.email, phone: r.phone || null, signingOrder: i })),
    fields: fields.map((f) => ({ id: f.id, recipientId: f.recipientId, page: f.page, x: f.x, y: f.y, w: f.w, h: f.h, type: f.type, required: f.required })),
  });

  const moveRecipient = (id: string, dir: -1 | 1) =>
    setRecipients((prev) => {
      const i = prev.findIndex((r) => r.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });

  // --- recipient ops ---
  const addRecipient = () => {
    const r = { id: uid(), name: '', email: '', phone: '' };
    setRecipients((prev) => [...prev, r]);
    setActiveRecipientId(r.id);
  };
  const updateRecipient = (id: string, patch: Partial<UIRecipient>) =>
    setRecipients((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  const removeRecipient = (id: string) => {
    setRecipients((prev) => prev.filter((r) => r.id !== id));
    setFields((prev) => prev.filter((f) => f.recipientId !== id));
    if (activeRecipientId === id) setActiveRecipientId(recipients.find((r) => r.id !== id)?.id ?? '');
  };

  // --- field placement ---
  const dropField = (pageIndex: number, e: React.MouseEvent<HTMLDivElement>, size: { width: number; height: number }) => {
    if (!armed || !activeRecipient) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const tool = TOOLS.find((t) => t.type === armed)!;
    const x = (e.clientX - rect.left) / size.width - tool.w / 2;
    const y = (e.clientY - rect.top) / size.height - tool.h / 2;
    setFields((prev) => [
      ...prev,
      {
        id: uid(),
        recipientId: activeRecipient.id,
        page: pageIndex,
        x: Math.max(0, Math.min(1 - tool.w, x)),
        y: Math.max(0, Math.min(1 - tool.h, y)),
        w: tool.w,
        h: tool.h,
        type: armed,
        required: true,
      },
    ]);
  };

  const onFieldPointerDown = (f: UIField, e: React.PointerEvent, size: { width: number; height: number }) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { id: f.id, startX: e.clientX, startY: e.clientY, origX: f.x, origY: f.y, pw: size.width, ph: size.height };
  };
  const onFieldPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const nx = d.origX + (e.clientX - d.startX) / d.pw;
    const ny = d.origY + (e.clientY - d.startY) / d.ph;
    setFields((prev) => prev.map((f) => (f.id === d.id ? { ...f, x: Math.max(0, Math.min(1 - f.w, nx)), y: Math.max(0, Math.min(1 - f.h, ny)) } : f)));
  };
  const onFieldPointerUp = () => {
    dragRef.current = null;
  };

  // --- persistence ---
  const save = async () => {
    setBusy('save');
    setError(null);
    const res = await saveBuilderAction(requestId, buildPayload());
    setBusy(null);
    if (!res.ok) setError(res.error ?? 'Save failed.');
  };

  const send = async () => {
    setBusy('send');
    setError(null);
    const res = await sendRequestAction(requestId, buildPayload(), channels);
    setBusy(null);
    if (!res.ok) {
      setError(res.error ?? 'Send failed.');
      return;
    }
    setLinks(res.links ?? []);
  };

  const toggleChannel = (c: DeliveryChannel) =>
    setChannels((prev) => (prev.includes(c) ? prev.filter((x) => x !== c) : [...prev, c]));

  if (links) return <SentConfirmation links={links} requestId={requestId} onDone={() => router.push('/organizer/signatures')} />;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
      {/* Left: document with field overlay */}
      <div className="overflow-auto rounded-2xl border border-zinc-200/80 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
        <PdfCanvas
          url={pdfUrl}
          renderPageOverlay={(pageIndex, size) => (
            <div
              className="absolute inset-0"
              style={{ cursor: armed ? 'crosshair' : 'default' }}
              onClick={(e) => dropField(pageIndex, e, size)}
            >
              {fields
                .filter((f) => f.page === pageIndex)
                .map((f) => (
                  <div
                    key={f.id}
                    onPointerDown={(e) => onFieldPointerDown(f, e, size)}
                    onPointerMove={onFieldPointerMove}
                    onPointerUp={onFieldPointerUp}
                    className="group absolute flex items-center justify-center rounded text-[10px] font-medium"
                    style={{
                      left: f.x * size.width,
                      top: f.y * size.height,
                      width: f.w * size.width,
                      height: f.h * size.height,
                      border: `1.5px solid ${colorFor(f.recipientId)}`,
                      background: `${colorFor(f.recipientId)}1a`,
                      color: colorFor(f.recipientId),
                      cursor: 'move',
                      touchAction: 'none',
                    }}
                    title={`${f.type} · ${recipients.find((r) => r.id === f.recipientId)?.name || 'recipient'}`}
                  >
                    <span className="pointer-events-none select-none capitalize">{f.type}</span>
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={(e) => {
                        e.stopPropagation();
                        setFields((prev) => prev.filter((x) => x.id !== f.id));
                      }}
                      className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center rounded-full bg-white text-zinc-500 shadow ring-1 ring-zinc-300 group-hover:flex dark:bg-zinc-800 dark:ring-zinc-600"
                      aria-label="Remove field"
                    >
                      ×
                    </button>
                  </div>
                ))}
            </div>
          )}
        />
      </div>

      {/* Right: controls */}
      <aside className="flex h-fit flex-col gap-4 lg:sticky lg:top-4">
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-400">Title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className="mb-3 w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
          <label className="mb-1 block text-xs font-semibold uppercase tracking-wide text-zinc-400">Message (optional)</label>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={2} placeholder="A note included in the signing invite…" className="w-full resize-none rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
        </div>

        {/* Recipients */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-400">Recipients</h2>
            <button type="button" onClick={addRecipient} className="text-xs font-medium text-indigo-600 hover:underline dark:text-indigo-400">+ Add</button>
          </div>
          {recipients.length > 1 && (
            <label className="mb-2 flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
              <input type="checkbox" checked={sequential} onChange={(e) => setSequential(e.target.checked)} />
              Sign in order (each signer is invited after the previous one finishes)
            </label>
          )}
          <div className="flex flex-col gap-3">
            {recipients.map((r, idx) => (
              <div
                key={r.id}
                onClick={() => setActiveRecipientId(r.id)}
                className={`cursor-pointer rounded-lg border p-2.5 ${activeRecipientId === r.id ? 'border-indigo-300 ring-1 ring-indigo-200 dark:border-indigo-700 dark:ring-indigo-900' : 'border-zinc-200 dark:border-zinc-800'}`}
              >
                <div className="mb-1.5 flex items-center gap-2">
                  {sequential && recipients.length > 1 && (
                    <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-zinc-200 text-[10px] font-semibold text-zinc-600 dark:bg-zinc-700 dark:text-zinc-200">{idx + 1}</span>
                  )}
                  <span className="h-3 w-3 shrink-0 rounded-full" style={{ background: colorFor(r.id) }} />
                  <span className="text-[11px] font-medium text-zinc-500">{activeRecipientId === r.id ? 'Placing fields for this signer' : 'Click to place fields'}</span>
                  <div className="ml-auto flex items-center gap-1">
                    {sequential && recipients.length > 1 && (
                      <>
                        <button type="button" disabled={idx === 0} onClick={(e) => { e.stopPropagation(); moveRecipient(r.id, -1); }} className="text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200" aria-label="Move up">↑</button>
                        <button type="button" disabled={idx === recipients.length - 1} onClick={(e) => { e.stopPropagation(); moveRecipient(r.id, 1); }} className="text-xs text-zinc-400 hover:text-zinc-700 disabled:opacity-30 dark:hover:text-zinc-200" aria-label="Move down">↓</button>
                      </>
                    )}
                    {recipients.length > 1 && (
                      <button type="button" onClick={(e) => { e.stopPropagation(); removeRecipient(r.id); }} className="text-xs text-zinc-400 hover:text-rose-500">Remove</button>
                    )}
                  </div>
                </div>
                <input value={r.name} onChange={(e) => updateRecipient(r.id, { name: e.target.value })} placeholder="Full name" className="mb-1.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
                <input value={r.email} onChange={(e) => updateRecipient(r.id, { email: e.target.value })} placeholder="Email" type="email" className="mb-1.5 w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
                <input value={r.phone} onChange={(e) => updateRecipient(r.id, { phone: e.target.value })} placeholder="Phone (for SMS, optional)" className="w-full rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-100" />
              </div>
            ))}
          </div>
        </div>

        {/* Field palette */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Fields</h2>
          <p className="mb-2 text-[11px] text-zinc-400">Pick a field, then click on the document to place it for the selected signer.</p>
          <div className="flex flex-wrap gap-1.5">
            {TOOLS.map((t) => (
              <button
                key={t.type}
                type="button"
                onClick={() => setArmed((a) => (a === t.type ? null : t.type))}
                className={`rounded-md border px-2.5 py-1 text-xs font-medium capitalize ${armed === t.type ? 'border-indigo-400 bg-indigo-50 text-indigo-700 dark:border-indigo-600 dark:bg-indigo-950/40 dark:text-indigo-300' : 'border-zinc-200 text-zinc-600 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
          {armed && <p className="mt-2 text-[11px] text-indigo-500">Click the document to drop a {armed} field. Click the field again here to stop.</p>}
        </div>

        {/* Delivery + send */}
        <div className="rounded-2xl border border-zinc-200/80 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Send via</h2>
          <div className="mb-3 flex flex-col gap-1.5 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={channels.includes('email')} onChange={() => toggleChannel('email')} /> Email link</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={channels.includes('sms')} onChange={() => toggleChannel('sms')} /> SMS link (needs phone)</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked disabled /> Copyable link (always)</label>
          </div>
          {error && <p className="mb-2 text-sm text-rose-600">{error}</p>}
          <div className="flex items-center gap-2">
            <button type="button" onClick={save} disabled={busy !== null} className="rounded-full border border-zinc-300 px-3.5 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" onClick={send} disabled={busy !== null} className="rounded-full bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
              {busy === 'send' ? 'Sending…' : 'Send for signature'}
            </button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function SentConfirmation({ links, requestId, onDone }: { links: RecipientLink[]; requestId: string; onDone: () => void }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (url: string, id: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard blocked */
    }
  };
  return (
    <div className="mx-auto max-w-xl rounded-2xl border border-emerald-200/70 bg-emerald-50/50 p-6 text-center dark:border-emerald-900/40 dark:bg-emerald-950/20">
      <h1 className="text-lg font-semibold text-emerald-800 dark:text-emerald-300">Request sent</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-300">Each signer has a unique link. Copy any link to share it directly.</p>
      <div className="mt-4 flex flex-col gap-2 text-left">
        {links.map((l) => (
          <div key={l.recipientId} className="flex items-center gap-2 rounded-lg border border-zinc-200 bg-white p-2.5 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <div className="min-w-0 flex-1">
              <div className="font-medium text-zinc-800 dark:text-zinc-100">{l.name || l.email}</div>
              <div className="truncate text-xs text-zinc-400">{[l.emailed ? 'emailed' : null, l.smsed ? 'texted' : null].filter(Boolean).join(' · ') || 'link only'}</div>
            </div>
            <button type="button" onClick={() => copy(l.url, l.recipientId)} className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800">
              {copied === l.recipientId ? 'Copied' : 'Copy link'}
            </button>
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-center gap-2">
        <button type="button" onClick={onDone} className="rounded-full bg-zinc-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900">Done</button>
        <a href={`/organizer/signatures/${requestId}`} className="rounded-full border border-zinc-300 px-4 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200">View status</a>
      </div>
    </div>
  );
}
