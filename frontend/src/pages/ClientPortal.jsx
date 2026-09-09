import React, { useEffect, useState, useRef } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import {
  CheckCircle2, Upload, MessageSquare, Paperclip, Loader2, AlertTriangle,
  Sparkles,
} from "lucide-react";

// --------------------------------------------------------------------------
// Client Portal — one shareable magic-link URL per (company, client_email).
// Public: no auth required. The token in the URL IS the auth.
//
// A client lands here after their accountant sends them a portal invite.
// They see:
//   • Firm branding (name, logo, primary color)
//   • Every open question / request in one queue
//   • A drag-and-drop upload zone for receipts + docs
//   • Recently answered items (so they can see the trail)
// --------------------------------------------------------------------------

const API_BASE = process.env.REACT_APP_BACKEND_URL;
const api = axios.create({ baseURL: `${API_BASE}/api` });

export default function ClientPortal() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState(null);
  const [openId, setOpenId] = useState(null);

  const load = async () => {
    try {
      const r = await api.get(`/portal/${token}`);
      setData(r.data);
      setErr(null);
    } catch (e) {
      setErr(e?.response?.data?.detail || "This portal link is not available.");
      setData(null);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [token]);

  if (busy) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <Loader2 className="animate-spin text-indigo-500" size={32} />
      </div>
    );
  }

  if (err) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-6">
        <div className="max-w-md bg-white rounded-xl border border-red-200 p-8 text-center">
          <AlertTriangle className="mx-auto text-red-500 mb-3" size={32} />
          <div className="text-lg font-semibold text-slate-900">Portal unavailable</div>
          <div className="text-sm text-slate-600 mt-2">{err}</div>
          <div className="text-xs text-slate-400 mt-4">
            Please ask your accountant for a new link.
          </div>
        </div>
      </div>
    );
  }

  const brand = data.brand || {};
  const primaryColor = brand.primary_color || "#6366F1";
  const openQs = data.open_questions || [];
  const recentQs = data.recent_questions || [];

  return (
    <div className="min-h-screen bg-slate-50" data-testid="client-portal-page">
      {/* Branded header */}
      <header
        className="text-white"
        style={{ background: primaryColor }}
      >
        <div className="max-w-3xl mx-auto px-6 py-8">
          <div className="flex items-center gap-3 mb-2 opacity-90">
            {brand.logo_url ? (
              <img src={brand.logo_url} alt="" className="w-10 h-10 rounded object-cover bg-white/20 p-1" />
            ) : (
              <div className="w-10 h-10 rounded bg-white/20 flex items-center justify-center">
                <Sparkles size={20} />
              </div>
            )}
            <div className="text-sm font-semibold uppercase tracking-wider">
              {brand.company_name || "Your books"}
            </div>
          </div>
          <h1 className="text-3xl font-bold">
            {data.client_name ? `Hi ${data.client_name.split(" ")[0]}` : "Your portal"}
          </h1>
          <p className="text-white/90 text-sm mt-1">
            {openQs.length === 0
              ? "You're all caught up. Your accountant will drop new requests here when they need something."
              : `You have ${openQs.length} thing${openQs.length === 1 ? "" : "s"} to look at.`}
          </p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 py-6 pb-24">
        {/* Open questions */}
        {openQs.length > 0 && (
          <section className="mb-8" data-testid="client-portal-open-section">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-3">
              Needs your input
            </h2>
            <div className="space-y-2">
              {openQs.map((q) => (
                <QuestionCard
                  key={q.id}
                  q={q}
                  primaryColor={primaryColor}
                  open={openId === q.id}
                  onToggle={() => setOpenId(openId === q.id ? null : q.id)}
                  onAnswered={load}
                  token={token}
                />
              ))}
            </div>
          </section>
        )}

        {/* Empty state */}
        {openQs.length === 0 && (
          <section className="mb-8">
            <div className="bg-white rounded-lg border border-slate-200 p-10 text-center" data-testid="client-portal-empty">
              <CheckCircle2 className="mx-auto text-emerald-500 mb-3" size={40} />
              <div className="text-lg font-semibold text-slate-900">All caught up.</div>
              <div className="text-sm text-slate-600 mt-1">
                No open requests right now.
              </div>
            </div>
          </section>
        )}

        {/* Standalone upload */}
        {data.allow_upload && (
          <section className="mb-8" data-testid="client-portal-upload-section">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-3">
              Send a receipt or document
            </h2>
            <UploadDropzone token={token} primaryColor={primaryColor} onDone={load} />
          </section>
        )}

        {/* Recently answered */}
        {recentQs.length > 0 && (
          <section data-testid="client-portal-recent-section">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-slate-700 mb-3">
              Recently answered
            </h2>
            <div className="space-y-1.5">
              {recentQs.slice(0, 8).map((q) => (
                <div
                  key={q.id}
                  className="bg-white rounded border border-slate-200 px-3 py-2 text-sm"
                  data-testid={`client-portal-recent-${q.id}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-slate-700 line-clamp-1">{q.question}</span>
                    <span className="text-[10px] text-emerald-600 font-semibold shrink-0">
                      {q.status.toUpperCase()}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

// --------------------------------------------------------------------------
// Question card — expandable with an inline answer input + per-question upload
// --------------------------------------------------------------------------

function QuestionCard({ q, primaryColor, open, onToggle, onAnswered, token }) {
  const [answer, setAnswer] = useState("");
  const [saving, setSaving] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const fileRef = useRef(null);

  const submit = async () => {
    if (!answer.trim()) return;
    setSaving(true);
    try {
      await api.post(`/portal/${token}/answer/${q.id}`, { answer: answer.trim() });
      setAnswer("");
      onAnswered();
    } catch (e) {
      alert(e?.response?.data?.detail || "Failed to save answer.");
    } finally {
      setSaving(false);
    }
  };

  const uploadForQuestion = async (file) => {
    if (!file) return;
    setUploadBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("question_id", q.id);
      await api.post(`/portal/${token}/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      onAnswered();
    } catch (e) {
      alert(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setUploadBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  return (
    <div
      className="bg-white rounded-lg border border-slate-200 overflow-hidden"
      data-testid={`client-portal-question-${q.id}`}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3 hover:bg-slate-50 flex items-start gap-3"
      >
        <MessageSquare size={18} className="text-slate-400 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-sm text-slate-900 font-medium">{q.question}</div>
          <div className="text-xs text-slate-500 mt-0.5">
            {q.asked_by_name ? `${q.asked_by_name} · ` : ""}
            {q.txn_count > 0 && `${q.txn_count} transaction${q.txn_count === 1 ? "" : "s"} · `}
            {relativeAge(q.sent_at)}
          </div>
        </div>
      </button>

      {open && (
        <div className="px-4 pb-4 pt-2 border-t border-slate-100 space-y-3">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            placeholder="Type your answer here…"
            rows={3}
            className="w-full text-sm px-3 py-2 border border-slate-300 rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 resize-none"
            data-testid={`client-portal-answer-input-${q.id}`}
          />
          <div className="flex items-center justify-between flex-wrap gap-2">
            <label className="text-xs text-slate-600 flex items-center gap-1.5 cursor-pointer hover:text-slate-900">
              <Paperclip size={12} />
              <span>Attach a file</span>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => uploadForQuestion(e.target.files?.[0])}
                data-testid={`client-portal-question-upload-${q.id}`}
              />
              {uploadBusy && <Loader2 size={12} className="animate-spin" />}
            </label>
            <button
              onClick={submit}
              disabled={saving || !answer.trim()}
              style={{ background: answer.trim() ? primaryColor : undefined }}
              className="text-sm font-semibold text-white rounded-md px-4 py-1.5 disabled:bg-slate-300 disabled:cursor-not-allowed"
              data-testid={`client-portal-answer-submit-${q.id}`}
            >
              {saving ? "Sending…" : "Send answer"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------
// Standalone upload dropzone
// --------------------------------------------------------------------------

function UploadDropzone({ token, primaryColor, onDone }) {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const inputRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      if (note.trim()) fd.append("note", note.trim());
      await api.post(`/portal/${token}/upload`, fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      setNote("");
      onDone();
    } catch (e) {
      alert(e?.response?.data?.detail || "Upload failed.");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  return (
    <div>
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          upload(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        className={`rounded-lg border-2 border-dashed p-8 text-center cursor-pointer transition-colors ${
          dragging
            ? "border-indigo-400 bg-indigo-50"
            : "border-slate-300 bg-white hover:border-slate-400"
        }`}
        data-testid="client-portal-upload-dropzone"
      >
        {busy ? (
          <Loader2 className="mx-auto animate-spin text-indigo-500" size={28} />
        ) : (
          <Upload className="mx-auto text-slate-400 mb-2" size={28} />
        )}
        <div className="text-sm font-semibold text-slate-800">
          {busy ? "Uploading…" : "Drop a file or click to browse"}
        </div>
        <div className="text-xs text-slate-500 mt-1">
          Receipts, invoices, PDFs, images — up to 15 MB
        </div>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => upload(e.target.files?.[0])}
          data-testid="client-portal-upload-input"
        />
      </div>
      <input
        type="text"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Optional note (e.g. 'Client dinner - Feb 8')"
        className="mt-3 w-full text-sm px-3 py-2 border border-slate-300 rounded focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500"
        data-testid="client-portal-upload-note"
      />
    </div>
  );
}

function relativeAge(iso) {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  } catch {
    return "";
  }
}
