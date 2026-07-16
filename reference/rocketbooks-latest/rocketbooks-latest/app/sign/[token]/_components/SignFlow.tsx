'use client';

import { useEffect, useMemo, useState } from 'react';
import { PdfCanvas } from '@/components/pdf/PdfCanvas';
import { SignaturePad } from './SignaturePad';
import { submitSignatureAction, declineAction, markViewedAction, type FieldSubmission } from '../_actions/sign';
import type { Field } from '@/lib/signatures/store';

interface Props {
  token: string;
  pdfUrl: string;
  title: string;
  message: string;
  senderName: string;
  recipientName: string;
  fields: Field[];
}

type Values = Record<string, { value?: string; signatureDataUrl?: string }>;

function todayStr(): string {
  return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function SignFlow({ token, pdfUrl, title, message, senderName, recipientName, fields }: Props) {
  const [values, setValues] = useState<Values>({});
  const [consent, setConsent] = useState(false);
  const [padField, setPadField] = useState<Field | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'signed' | 'declined' | null>(null);

  // Prefill date → today, name → recipient name. Mark the link viewed.
  useEffect(() => {
    const initial: Values = {};
    for (const f of fields) {
      if (f.type === 'date') initial[f.id] = { value: todayStr() };
      else if (f.type === 'name') initial[f.id] = { value: recipientName };
    }
    setValues(initial);
    void markViewedAction(token);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const requiredRemaining = useMemo(
    () =>
      fields.filter((f) => {
        if (!f.required) return false;
        const v = values[f.id];
        return !((v?.value && v.value.trim()) || v?.signatureDataUrl);
      }).length,
    [fields, values],
  );

  const setField = (id: string, patch: { value?: string; signatureDataUrl?: string }) =>
    setValues((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

  const submit = async () => {
    setBusy(true);
    setError(null);
    const submissions: FieldSubmission[] = fields.map((f) => ({ id: f.id, value: values[f.id]?.value, signatureDataUrl: values[f.id]?.signatureDataUrl }));
    const res = await submitSignatureAction(token, consent, submissions);
    setBusy(false);
    if (res.ok) setDone('signed');
    else setError(res.error ?? 'Could not submit.');
  };

  const decline = async () => {
    const reason = window.prompt('Optionally, why are you declining?') ?? '';
    setBusy(true);
    const res = await declineAction(token, reason);
    setBusy(false);
    if (res.ok) setDone('declined');
    else setError(res.error ?? 'Could not decline.');
  };

  if (done === 'signed') {
    return <Centered title="Thank you — you’ve signed." body="All parties will be notified once everyone has signed. You can close this page." tone="emerald" />;
  }
  if (done === 'declined') {
    return <Centered title="You declined to sign." body="The sender has been notified. You can close this page." tone="zinc" />;
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title || 'Please sign'}</h1>
        <p className="mt-0.5 text-sm text-zinc-500 dark:text-zinc-400">{senderName} requested your signature.</p>
        {message && <p className="mt-2 rounded-lg bg-zinc-50 p-2.5 text-sm text-zinc-600 dark:bg-zinc-950 dark:text-zinc-300">{message}</p>}
      </div>

      <div className="overflow-auto rounded-2xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-950/40">
        <PdfCanvas
          url={pdfUrl}
          renderPageOverlay={(pageIndex, size) => (
            <div className="absolute inset-0">
              {fields
                .filter((f) => f.page === pageIndex)
                .map((f) => {
                  const v = values[f.id];
                  const style: React.CSSProperties = {
                    left: f.x * size.width,
                    top: f.y * size.height,
                    width: f.w * size.width,
                    height: f.h * size.height,
                  };
                  const filled = (v?.value && v.value.trim()) || v?.signatureDataUrl;
                  const baseCls = `absolute flex items-center justify-center rounded text-[11px] ${filled ? 'border border-emerald-400 bg-emerald-50/70 dark:bg-emerald-950/30' : 'border-2 border-dashed border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/30'}`;
                  if (f.type === 'signature' || f.type === 'initials') {
                    return (
                      <button key={f.id} type="button" style={style} className={baseCls} onClick={() => setPadField(f)}>
                        {v?.signatureDataUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={v.signatureDataUrl} alt="" className="max-h-full max-w-full object-contain" />
                        ) : (
                          <span className="capitalize text-indigo-600 dark:text-indigo-300">{f.type}</span>
                        )}
                      </button>
                    );
                  }
                  if (f.type === 'checkbox') {
                    return (
                      <button key={f.id} type="button" style={style} className={baseCls} onClick={() => setField(f.id, { value: v?.value === 'true' ? 'false' : 'true' })}>
                        {v?.value === 'true' ? '✓' : ''}
                      </button>
                    );
                  }
                  // date / name / text → inline input
                  return (
                    <input
                      key={f.id}
                      style={style}
                      value={v?.value ?? ''}
                      onChange={(e) => setField(f.id, { value: e.target.value })}
                      placeholder={f.type}
                      className={`${baseCls} bg-white/90 px-1 capitalize text-zinc-800 outline-none dark:bg-zinc-900/90 dark:text-zinc-100`}
                    />
                  );
                })}
            </div>
          )}
        />
      </div>

      <div className="sticky bottom-0 mt-4 rounded-2xl border border-zinc-200 bg-white p-4 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
        <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} className="mt-0.5" />
          <span>I agree to use electronic records and signatures, and that my electronic signature is legally binding (ESIGN / UETA).</span>
        </label>
        {error && <p className="mt-2 text-sm text-rose-600">{error}</p>}
        <div className="mt-3 flex items-center gap-2">
          <button type="button" onClick={submit} disabled={busy || !consent || requiredRemaining > 0} className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50">
            {busy ? 'Submitting…' : requiredRemaining > 0 ? `${requiredRemaining} field${requiredRemaining > 1 ? 's' : ''} left` : 'Finish & sign'}
          </button>
          <button type="button" onClick={decline} disabled={busy} className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800">
            Decline
          </button>
        </div>
      </div>

      {padField && (
        <SignaturePad
          label={padField.type === 'initials' ? 'initials' : 'signature'}
          onApply={(dataUrl) => {
            setField(padField.id, { signatureDataUrl: dataUrl });
            setPadField(null);
          }}
          onCancel={() => setPadField(null)}
        />
      )}
    </div>
  );
}

function Centered({ title, body, tone }: { title: string; body: string; tone: 'emerald' | 'zinc' }) {
  const ring = tone === 'emerald' ? 'border-emerald-200 bg-emerald-50/50 dark:border-emerald-900/40 dark:bg-emerald-950/20' : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900';
  return (
    <div className="mx-auto max-w-md py-20 text-center">
      <div className={`rounded-2xl border p-8 ${ring}`}>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">{title}</h1>
        <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-300">{body}</p>
      </div>
    </div>
  );
}
