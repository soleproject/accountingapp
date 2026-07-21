import { useEffect, useState } from "react";
import { api, fmtMoney } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { toast } from "sonner";
import { HelpCircle, Send, X, Sparkles } from "lucide-react";

// Pro-facing modal that emails the client owner a magic-link asking them
// to explain a transaction. The client's answer flows back onto the txn
// via `client_answer` (see routes/communications.py::public_answer_question).
//
// Modes:
//   • Self-triggered — default. Renders its own inline "Ask client" trigger
//     that opens the modal.
//   • Controlled — pass `open` + `onClose`; the parent decides when the
//     modal is visible. Used by the row-menu integration on the Transactions
//     page so no extra trigger buttons appear per row.
export default function AskClientButton({
  txn,
  onAsked,
  open: controlledOpen,
  onClose,
}) {
  const controlled = controlledOpen !== undefined;
  const { currentId } = useCompany();
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlled ? controlledOpen : internalOpen;
  const setOpen = (v) => (controlled ? (!v && onClose?.()) : setInternalOpen(v));
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState("");
  const [overrideTo, setOverrideTo] = useState("");

  // Seed the question fresh every time the modal opens for a new txn so
  // the prompt looks contextual rather than stale from a prior click.
  useEffect(() => {
    if (open && txn) {
      setQuestion(
        `Hi — what was this ${fmtMoney(Math.abs(txn.amount || 0))} charge from ${
          txn.description || txn.merchant || "this vendor"
        } for?`
      );
      setOverrideTo("");
    }
  }, [open, txn?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const ask = async () => {
    if (!question.trim()) { toast.error("Please write your question"); return; }
    setBusy(true);
    try {
      const body = { txn_id: txn.id, question: question.trim() };
      if (overrideTo.trim()) body.to = overrideTo.trim();
      const r = await api.post(`/companies/${currentId}/transactions/${txn.id}/ask-client`, body);
      if (r.data?.status === "skipped_pref_off") {
        toast.info("Ask-client emails are turned off in Settings — question recorded but no email sent.");
      } else {
        toast.success("Question sent to your client.");
      }
      setOpen(false);
      onAsked?.();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Send failed");
    } finally { setBusy(false); }
  };

  return (
    <>
      {!controlled && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid={`ask-client-btn-${txn?.id}`}
          className="inline-flex items-center gap-1 text-xs text-cyan-700 hover:text-cyan-800"
          title="Email your client to ask about this transaction"
        >
          <HelpCircle size={12} /> Ask client
        </button>
      )}

      {open && txn && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
          onClick={() => !busy && setOpen(false)}
          data-testid="ask-client-modal"
        >
          <div
            className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <h3 className="font-heading font-semibold text-lg flex items-center gap-2">
                  <Sparkles size={16} className="text-cyan-600" /> Ask your client
                </h3>
                <p className="text-xs text-slate-500 mt-1">
                  They'll get a magic-link email; their answer lands on this transaction automatically.
                </p>
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-700">
                <X size={16} />
              </button>
            </div>

            <div className="rounded-md border bg-slate-50 p-3 text-xs space-y-0.5">
              <div><span className="text-slate-500">Date:</span> <span className="font-mono-num">{txn?.date}</span></div>
              <div><span className="text-slate-500">Description:</span> {txn?.description}</div>
              <div><span className="text-slate-500">Amount:</span> <span className="font-mono-num">{fmtMoney(txn?.amount)}</span></div>
            </div>

            <div>
              <label className="text-xs text-slate-600 font-medium">Your question</label>
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                rows={4}
                className="mt-1 w-full text-sm border rounded-md px-3 py-2"
                data-testid="ask-client-question"
              />
            </div>

            <div>
              <label className="text-xs text-slate-600 font-medium">Send to (optional — defaults to the client owner)</label>
              <input
                type="email"
                value={overrideTo}
                onChange={(e) => setOverrideTo(e.target.value)}
                placeholder="e.g. owner@client.com"
                className="mt-1 w-full text-sm border rounded-md px-3 py-2"
                data-testid="ask-client-to-override"
              />
            </div>

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                onClick={() => setOpen(false)}
                disabled={busy}
                className="px-3 py-1.5 text-sm rounded-md border"
              >
                Cancel
              </button>
              <button
                onClick={ask}
                disabled={busy}
                data-testid="ask-client-send"
                className="inline-flex items-center gap-1.5 px-4 py-1.5 text-sm rounded-md bg-cyan-600 text-white hover:bg-cyan-700 disabled:opacity-50"
              >
                <Send size={13} /> {busy ? "Sending…" : "Send question"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
