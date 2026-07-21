import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { CheckCircle2, Loader2, AlertTriangle, Send, Sparkles } from "lucide-react";

// Public page — no auth required. Clients arrive here via the magic-link
// in the ask-client email. Uses raw axios (not `api`) so the request
// carries no JWT and hits the wide-open `/api/q/:token` endpoint.
const BASE = process.env.REACT_APP_BACKEND_URL;

export default function AskClientAnswer() {
  const { token } = useParams();
  const [q, setQ] = useState(null);
  const [error, setError] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    axios.get(`${BASE}/api/q/${token}`)
      .then(r => setQ(r.data))
      .catch(e => setError(e.response?.data?.detail || "This link is invalid or expired."));
  }, [token]);

  const submit = async () => {
    if (!answer.trim()) { toast.error("Please type an answer"); return; }
    setBusy(true);
    try {
      await axios.post(`${BASE}/api/q/${token}/answer`, { answer: answer.trim() });
      setDone(true);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Something went wrong.");
    } finally { setBusy(false); }
  };

  if (error) return <Wrap><ErrorState msg={error} /></Wrap>;
  if (!q)    return <Wrap><Loading /></Wrap>;

  if (done || q.status === "answered") {
    return <Wrap>
      <div className="text-center space-y-3 py-8" data-testid="answer-done">
        <CheckCircle2 size={48} className="text-emerald-500 mx-auto" />
        <div className="text-lg font-semibold text-slate-900">Thanks — your answer is with your accountant.</div>
        <div className="text-sm text-slate-500 max-w-md mx-auto">
          You can close this window. If you need to add anything, just email
          {q.asked_by_name ? <> <b>{q.asked_by_name}</b></> : " them"} directly.
        </div>
      </div>
    </Wrap>;
  }

  return (
    <Wrap>
      <div className="space-y-5" data-testid="answer-form">
        <div className="flex items-center gap-2 text-xs text-cyan-700">
          <Sparkles size={14} /> Question from your accountant
        </div>
        <div>
          <h1 className="font-heading text-2xl font-bold text-slate-900">
            {q.txns && q.txns.length > 1
              ? <>Hi — questions about {q.counterparty_label || `${q.txns.length} transactions`}</>
              : <>Hi — quick question about a transaction</>
            }
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            {q.asked_by_name || "Your accountant"} is reviewing the books for <b>{q.company_name}</b> and wants your help.
          </p>
        </div>

        {q.txns && q.txns.length > 1 ? (
          <div className="rounded-lg border bg-slate-50 p-4 text-sm">
            <div className="text-xs text-slate-500 mb-2">
              {q.txns.length} transactions from {q.counterparty_label || "this vendor"}
            </div>
            <div className="divide-y">
              {q.txns.map(t => (
                <div key={t.id} className="grid grid-cols-[95px_1fr_100px] items-center gap-3 py-1.5">
                  <span className="text-xs text-slate-500 font-mono-num">{t.date}</span>
                  <span className="text-xs text-slate-800 truncate">{t.description}</span>
                  <span className={`text-xs text-right font-mono-num ${Number(t.amount) < 0 ? "text-slate-800" : "text-emerald-700 font-semibold"}`}>
                    {Number(t.amount) < 0 ? "-" : ""}${Math.abs(Number(t.amount || 0)).toFixed(2)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : q.txn && (
          <div className="rounded-lg border bg-slate-50 p-4 text-sm space-y-1">
            <div><span className="text-slate-500 text-xs">Date:</span> <span className="font-mono-num">{q.txn.date}</span></div>
            <div><span className="text-slate-500 text-xs">Description:</span> {q.txn.description}</div>
            <div><span className="text-slate-500 text-xs">Amount:</span>{" "}
              <span className={`font-mono-num font-semibold ${Number(q.txn.amount) < 0 ? "text-rose-600" : "text-emerald-700"}`}>
                {Number(q.txn.amount) < 0 ? "-" : ""}${Math.abs(Number(q.txn.amount || 0)).toFixed(2)}
              </span>
            </div>
          </div>
        )}

        <div className="rounded-lg border-l-4 border-cyan-400 bg-cyan-50/60 px-4 py-3 text-sm text-slate-800">
          {q.question}
        </div>

        <div>
          <label className="text-xs text-slate-600 font-medium">Your answer</label>
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={5}
            placeholder="e.g. That was for the annual software subscription — please categorize it as software."
            className="mt-1 w-full text-sm border rounded-md px-3 py-2"
            data-testid="answer-textarea"
          />
        </div>
        <div>
          <button
            onClick={submit}
            disabled={busy || !answer.trim()}
            data-testid="answer-submit"
            className="inline-flex items-center gap-2 px-5 py-2 rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50 font-medium"
          >
            {busy ? <Loader2 className="animate-spin" size={16} /> : <Send size={16} />}
            {busy ? "Sending…" : "Send answer"}
          </button>
        </div>
      </div>
    </Wrap>
  );
}

function Wrap({ children }) {
  return (
    <div className="min-h-screen bg-slate-50 py-12 px-4">
      <div className="max-w-xl mx-auto bg-white rounded-xl shadow-sm border p-8">
        {children}
        <div className="mt-8 pt-4 border-t text-xs text-slate-400 text-center">
          Axiom Ledger · <span className="font-mono-num">accountingapp.ai</span>
        </div>
      </div>
    </div>
  );
}

function Loading() {
  return <div className="py-16 text-center text-slate-500">
    <Loader2 className="animate-spin mx-auto mb-2" size={24} />
    Loading…
  </div>;
}

function ErrorState({ msg }) {
  return <div className="py-8 text-center space-y-3" data-testid="answer-error">
    <AlertTriangle size={40} className="text-amber-500 mx-auto" />
    <div className="text-lg font-semibold text-slate-900">Link unavailable</div>
    <div className="text-sm text-slate-600 max-w-md mx-auto">{msg}</div>
  </div>;
}
