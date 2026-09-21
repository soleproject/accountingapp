/**
 * CheckinAnswerForm — the inline substantiation form that expands
 * inside a `CheckinItemsTile` row when the accountant (or client)
 * clicks "Answer". One form component switches on `item.item_type`
 * to render the field set the IRS / bookkeeping workflow needs:
 *
 *   • Meals (§274, type 10)   — attendees, business purpose, receipt (>$75)
 *   • Travel (§274, type 14)  — destination, purpose, dates, receipt
 *   • Missing Receipt (type 3) — receipt upload + optional memo
 *   • Liability Payment (9)   — statement upload OR manual split fields
 *   • Checks (type 13)        — payee name (MVP: name-only; full ledger
 *                                allocator stays on the Quick Check-in)
 *
 * All submissions go through the firm-authenticated shim endpoint
 *   POST /api/companies/{cid}/checkin/items/{item_id}/submit
 * which mirrors the token-side effects (batch answered, source doc
 * updated, receipt mirrored to /receipts, IRS substantiation written
 * onto the transaction).
 */
import React, { useRef, useState } from "react";
import { api } from "@/lib/api";
import { useMoneyFmt } from "@/lib/company";
import { toast } from "sonner";
import {
  Paperclip, Loader2, X, Send, FileText, Info, Mic, Square, Sparkles,
} from "lucide-react";
import useVoiceRecorder from "@/hooks/useVoiceRecorder";

const IRS_MEALS = 10;
const IRS_TRAVEL = 14;
const MISSING_RECEIPT = 3;
const LIABILITY_SPLIT = 9;
const CHECK_NO_PAYEE = 13;

// IRS §274 substantiation: a written record is required regardless of
// amount, but a *receipt* is only required for meals ≥ $75. Enforced
// client-side so the CPA sees an inline warning; server accepts either.
const MEALS_RECEIPT_THRESHOLD = 75;

const FIELD_ROW = "space-y-1";
const LABEL_CLS = "block text-[11px] uppercase tracking-widest text-slate-500 font-semibold";
const INPUT_CLS = "w-full text-sm px-3 py-2 border border-slate-300 rounded-md bg-white focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 transition-all";
// Applied for ~1.8s after voice-fill so the user sees which fields
// the AI just populated. Uses Tailwind ring + a subtle scale nudge
// so the glow reads even against the indigo form background.
const SPARKLE_CLS = "ring-2 ring-emerald-400 ring-offset-1 ring-offset-emerald-50 bg-emerald-50/60";

export default function CheckinAnswerForm({ companyId, item, onCancel, onSubmitted }) {
  const fmtMoney = useMoneyFmt();
  const t = item.item_type;
  const amt = typeof item.amount === "number" ? Math.abs(item.amount) : null;

  // Common fields across types (only rendered where they apply).
  const [attendees, setAttendees]         = useState("");
  const [businessPurpose, setBusPurpose]  = useState("");
  const [destination, setDestination]     = useState("");
  const [tripStart, setTripStart]         = useState("");
  const [tripEnd, setTripEnd]             = useState("");
  const [memo, setMemo]                   = useState("");
  const [payeeName, setPayeeName]         = useState("");
  const [principal, setPrincipal]         = useState("");
  const [interest, setInterest]           = useState("");
  const [escrow, setEscrow]               = useState("");
  const [fees, setFees]                   = useState("");
  const [file, setFile]                   = useState(null);
  const [busy, setBusy]                   = useState(false);

  // Voice-fill state — one mic per form instance. On stop, we hit
  // /voice-extract, sparkle-fill any EMPTY fields with the AI's
  // structured output (never overwrites typed content), and keep the
  // transcript visible so the user can copy/paste anything the AI
  // missed. Set of field names that were just AI-filled (for the
  // brief animation).
  const [transcribing, setTranscribing]   = useState(false);
  const [transcript, setTranscript]       = useState("");
  const [sparkle, setSparkle]             = useState(new Set());
  // Which field the user has manually typed into — used to protect
  // it from being overwritten by voice-fill.
  const touchedRef = useRef(new Set());
  const markTouched = (k) => touchedRef.current.add(k);

  const setters = {
    attendees:        setAttendees,
    business_purpose: setBusPurpose,
    destination:      setDestination,
    trip_start:       setTripStart,
    trip_end:         setTripEnd,
    notes:            setMemo,
    payee_name:       setPayeeName,
  };
  const currentValues = {
    attendees, business_purpose: businessPurpose, destination,
    trip_start: tripStart, trip_end: tripEnd, notes: memo,
    payee_name: payeeName,
  };

  const handleTranscribed = async (blob) => {
    setTranscribing(true);
    const form = new FormData();
    form.append("audio", blob, "utterance.webm");
    form.append("item_type", String(t));
    form.append("txn_context_json", JSON.stringify({
      merchant: item.description || item.prompt || "",
      amount: item.amount,
      date: item.date,
    }));
    try {
      const r = await api.post(
        `/companies/${companyId}/checkin/voice-extract`,
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      const { transcript: tx = "", extracted = {} } = r.data || {};
      setTranscript(tx);
      const filled = new Set();
      for (const [k, v] of Object.entries(extracted)) {
        if (!v || !setters[k]) continue;
        // Skip fields the user typed into OR that already have text.
        if (touchedRef.current.has(k)) continue;
        if ((currentValues[k] || "").trim()) continue;
        setters[k](String(v));
        filled.add(k);
      }
      if (filled.size) {
        setSparkle(filled);
        // Clear the sparkle after animation.
        setTimeout(() => setSparkle(new Set()), 1800);
      } else if (tx) {
        toast.info("Nothing to auto-fill — transcript saved to Notes.");
        if (!(memo || "").trim() && !touchedRef.current.has("notes")) {
          setMemo(tx);
        }
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Transcription failed");
    } finally {
      setTranscribing(false);
    }
  };

  const voice = useVoiceRecorder(handleTranscribed);

  const receiptRequired =
    t === MISSING_RECEIPT ||
    (t === IRS_MEALS && amt !== null && amt >= MEALS_RECEIPT_THRESHOLD) ||
    t === IRS_TRAVEL;

  const submit = async (e) => {
    e?.preventDefault?.();

    // Build the structured payload per item type.
    const payload = {};
    if (t === IRS_MEALS) {
      if (!businessPurpose.trim()) return toast.error("Business purpose is required for §274 compliance.");
      if (!attendees.trim()) return toast.error("Attendees are required for §274 compliance.");
      payload.attendees = attendees.trim();
      payload.business_purpose = businessPurpose.trim();
      if (receiptRequired && !file) {
        return toast.error(`Receipt is required for meals ≥ $${MEALS_RECEIPT_THRESHOLD}.`);
      }
    } else if (t === IRS_TRAVEL) {
      if (!businessPurpose.trim()) return toast.error("Business purpose is required for §274 compliance.");
      if (!destination.trim()) return toast.error("Destination is required for §274 compliance.");
      payload.business_purpose = businessPurpose.trim();
      payload.destination = destination.trim();
      if (attendees.trim()) payload.attendees = attendees.trim();
      if (tripStart) payload.trip_start = tripStart;
      if (tripEnd) payload.trip_end = tripEnd;
    } else if (t === MISSING_RECEIPT) {
      if (!file) return toast.error("Please attach the receipt to close this item.");
    } else if (t === LIABILITY_SPLIT) {
      // Two modes: upload statement (AI splits) or manual amounts.
      const p = parseFloat(principal || "0") || 0;
      const i = parseFloat(interest || "0") || 0;
      const e2 = parseFloat(escrow || "0") || 0;
      const f = parseFloat(fees || "0") || 0;
      const sum = +(p + i + e2 + f).toFixed(2);
      if (!file && sum <= 0) {
        return toast.error("Upload the statement OR enter at least one split amount.");
      }
      if (sum > 0) {
        payload.flow = "manual_split";
        payload.split = { principal: p, interest: i, escrow: e2, fees: f, total: sum };
        if (amt !== null && Math.abs(sum - amt) > 0.02) {
          return toast.error(`Split total $${sum.toFixed(2)} doesn't match transaction $${amt.toFixed(2)}.`);
        }
      }
    } else if (t === CHECK_NO_PAYEE) {
      if (!payeeName.trim()) return toast.error("Enter the payee name.");
      payload.payee_name = payeeName.trim();
    }

    const answerText = memo.trim() || _defaultAnswerString(t, payload);

    // Multipart submit — file may be null.
    const form = new FormData();
    form.append("answer", answerText);
    form.append("payload_json", JSON.stringify(payload));
    if (file) form.append("file", file);

    setBusy(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/checkin/items/${item.id}/submit`,
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      toast.success(r.data?.detail || "Answer recorded");
      onSubmitted?.(item.id);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Submit failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="mt-2 rounded-md border border-indigo-200 bg-indigo-50/40 p-3 space-y-3"
      data-testid={`checkin-answer-form-${item.id}`}
    >
      {/* Voice-fill bar — one mic per form instance. Non-destructive:
          only fills empty fields, never overwrites typed content. */}
      <VoiceFillBar
        recording={voice.recording}
        elapsedMs={voice.elapsedMs}
        onStart={voice.start}
        onStop={voice.stop}
        error={voice.error}
        transcribing={transcribing}
        transcript={transcript}
        onClearTranscript={() => setTranscript("")}
      />

      {/* Type-specific fields */}
      {t === IRS_MEALS && (
        <>
          <MealsSubstantiationHelper amount={amt} threshold={MEALS_RECEIPT_THRESHOLD} />
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Attendees *</label>
            <input
              className={INPUT_CLS + (sparkle.has("attendees") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. John Smith (Acme Corp), Jane Doe (client)"
              value={attendees}
              onChange={(e) => { markTouched("attendees"); setAttendees(e.target.value); }}
              data-testid="meals-attendees-input"
              required
            />
          </div>
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Business purpose *</label>
            <input
              className={INPUT_CLS + (sparkle.has("business_purpose") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. Q1 pricing review; strategy discussion"
              value={businessPurpose}
              onChange={(e) => { markTouched("business_purpose"); setBusPurpose(e.target.value); }}
              data-testid="meals-purpose-input"
              required
            />
          </div>
        </>
      )}

      {t === IRS_TRAVEL && (
        <>
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>IRS §274: a written record of purpose + destination is required. Attach lodging receipt if this trip included an overnight stay.</span>
          </div>
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Destination *</label>
            <input
              className={INPUT_CLS + (sparkle.has("destination") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. Chicago, IL — client HQ"
              value={destination}
              onChange={(e) => { markTouched("destination"); setDestination(e.target.value); }}
              data-testid="travel-destination-input"
              required
            />
          </div>
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Business purpose *</label>
            <input
              className={INPUT_CLS + (sparkle.has("business_purpose") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. On-site audit fieldwork · client kickoff"
              value={businessPurpose}
              onChange={(e) => { markTouched("business_purpose"); setBusPurpose(e.target.value); }}
              data-testid="travel-purpose-input"
              required
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className={FIELD_ROW}>
              <label className={LABEL_CLS}>Trip start</label>
              <input
                type="date"
                className={INPUT_CLS + (sparkle.has("trip_start") ? " " + SPARKLE_CLS : "")}
                value={tripStart}
                onChange={(e) => { markTouched("trip_start"); setTripStart(e.target.value); }}
                data-testid="travel-start-input"
              />
            </div>
            <div className={FIELD_ROW}>
              <label className={LABEL_CLS}>Trip end</label>
              <input
                type="date"
                className={INPUT_CLS + (sparkle.has("trip_end") ? " " + SPARKLE_CLS : "")}
                value={tripEnd}
                onChange={(e) => { markTouched("trip_end"); setTripEnd(e.target.value); }}
                data-testid="travel-end-input"
              />
            </div>
          </div>
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Attendees (optional)</label>
            <input
              className={INPUT_CLS + (sparkle.has("attendees") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. team of 3 — Amy, Ben, Carlos"
              value={attendees}
              onChange={(e) => { markTouched("attendees"); setAttendees(e.target.value); }}
              data-testid="travel-attendees-input"
            />
          </div>
        </>
      )}

      {t === MISSING_RECEIPT && (
        <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-700">
          <Info size={12} className="mt-0.5 shrink-0" />
          <span>Attach the receipt to close this item. It'll also appear on the Receipts page for this client.</span>
        </div>
      )}

      {t === LIABILITY_SPLIT && (
        <>
          <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-700">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>
              Upload the statement (AI will parse the split) <b>or</b> enter the split amounts manually. Total must match{" "}
              {amt !== null ? <b>${amt.toFixed(2)}</b> : "the transaction amount"}.
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <NumField label="Principal" value={principal} onChange={setPrincipal} testId="liab-principal" />
            <NumField label="Interest" value={interest} onChange={setInterest} testId="liab-interest" />
            <NumField label="Escrow" value={escrow} onChange={setEscrow} testId="liab-escrow" />
            <NumField label="Fees" value={fees} onChange={setFees} testId="liab-fees" />
          </div>
        </>
      )}

      {t === CHECK_NO_PAYEE && (
        <>
          <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-[11px] text-slate-700">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>For a full multi-line allocation (bills + GL split), use the Quick Check-in page. This inline form captures payee only.</span>
          </div>
          <div className={FIELD_ROW}>
            <label className={LABEL_CLS}>Payee *</label>
            <input
              className={INPUT_CLS + (sparkle.has("payee_name") ? " " + SPARKLE_CLS : "")}
              placeholder="e.g. State Farm Insurance"
              value={payeeName}
              onChange={(e) => { markTouched("payee_name"); setPayeeName(e.target.value); }}
              data-testid="check-payee-input"
              required
            />
          </div>
        </>
      )}

      {/* Optional memo — always shown */}
      <div className={FIELD_ROW}>
        <label className={LABEL_CLS}>Notes (optional)</label>
        <textarea
          className={INPUT_CLS + " resize-y min-h-[52px]" + (sparkle.has("notes") ? " " + SPARKLE_CLS : "")}
          placeholder="Anything else worth recording..."
          value={memo}
          onChange={(e) => { markTouched("notes"); setMemo(e.target.value); }}
          data-testid={`checkin-answer-memo-${item.id}`}
        />
      </div>

      {/* File attach — shown for all types that can carry a receipt */}
      {t !== CHECK_NO_PAYEE && (
        <div className={FIELD_ROW}>
          <label className={LABEL_CLS}>
            {t === LIABILITY_SPLIT ? "Statement upload" : "Receipt"}
            {receiptRequired && <span className="ml-1 text-red-500">*</span>}
          </label>
          <FilePicker file={file} setFile={setFile} testId={`checkin-answer-file-${item.id}`} />
        </div>
      )}

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 pt-1 border-t border-indigo-100">
        <button
          type="button"
          onClick={onCancel}
          className="text-[11px] px-2.5 py-1.5 rounded-md border border-slate-300 bg-white hover:bg-slate-50 text-slate-700"
          data-testid={`checkin-answer-cancel-${item.id}`}
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={busy}
          className="text-[11px] px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 inline-flex items-center gap-1 disabled:opacity-50"
          data-testid={`checkin-answer-submit-${item.id}`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
          Submit
        </button>
      </div>
    </form>
  );
}

function NumField({ label, value, onChange, testId }) {
  return (
    <div className={FIELD_ROW}>
      <label className={LABEL_CLS}>{label}</label>
      <input
        type="number"
        inputMode="decimal"
        step="0.01"
        placeholder="0.00"
        className={INPUT_CLS + " font-mono-num"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-testid={testId}
      />
    </div>
  );
}

function FilePicker({ file, setFile, testId }) {
  return (
    <label
      className="flex items-center gap-2 text-sm px-3 py-2 border border-dashed border-slate-300 rounded-md bg-white hover:bg-slate-50 cursor-pointer"
      data-testid={`${testId}-label`}
    >
      <Paperclip size={14} className="text-slate-500" />
      {file ? (
        <span className="flex-1 truncate text-slate-900">
          <FileText size={12} className="inline mr-1 text-slate-500" />
          {file.name}
          <span className="text-slate-500 ml-2">({(file.size / 1024).toFixed(0)} KB)</span>
        </span>
      ) : (
        <span className="flex-1 text-slate-500">Choose an image or PDF (max 8 MB)</span>
      )}
      {file && (
        <button
          type="button"
          onClick={(e) => { e.preventDefault(); setFile(null); }}
          className="p-0.5 text-slate-400 hover:text-slate-700"
          data-testid={`${testId}-clear`}
        >
          <X size={12} />
        </button>
      )}
      <input
        type="file"
        accept="image/*,.pdf"
        className="hidden"
        onChange={(e) => setFile(e.target.files?.[0] || null)}
        data-testid={testId}
      />
    </label>
  );
}

function MealsSubstantiationHelper({ amount, threshold }) {
  const needsReceipt = amount !== null && amount >= threshold;
  return (
    <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] text-amber-800">
      <Info size={12} className="mt-0.5 shrink-0" />
      <span>
        IRS §274 requires the <b>who</b> and <b>why</b> for every business meal.
        {needsReceipt
          ? ` Amount is $${amount.toFixed(2)} — a receipt is also required (over $${threshold}).`
          : ` No receipt is legally required below $${threshold}, but attach one if you have it.`}
      </span>
    </div>
  );
}

// Fallback answer string for the item's `answer` field — used when the
// user doesn't type a free-text note. Keeps the pro-side "answered"
// summary readable in the batch log.
function _defaultAnswerString(t, payload) {
  if (t === IRS_MEALS)      return `Meals substantiation recorded — ${payload.business_purpose}`;
  if (t === IRS_TRAVEL)     return `Travel substantiation recorded — ${payload.destination}`;
  if (t === MISSING_RECEIPT) return "Receipt attached";
  if (t === LIABILITY_SPLIT) {
    if (payload.split) {
      const s = payload.split;
      return `Manual split — Principal $${s.principal.toFixed(2)} / Interest $${s.interest.toFixed(2)} / Escrow $${s.escrow.toFixed(2)} / Fees $${s.fees.toFixed(2)}`;
    }
    return "Statement attached — AI will split";
  }
  if (t === CHECK_NO_PAYEE)  return `Payee: ${payload.payee_name}`;
  return "Answered";
}


/**
 * VoiceFillBar — top-of-form recorder. Single mic button that flips
 * between "Speak" / "Stop" / "Transcribing…" states, shows a live
 * elapsed timer while recording, and renders the raw transcript
 * below itself once we get one back (so the user can see what the
 * AI heard even if the field-fill missed something).
 */
function VoiceFillBar({
  recording, elapsedMs, onStart, onStop, error,
  transcribing, transcript, onClearTranscript,
}) {
  const secs = Math.floor(elapsedMs / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(1, "0");
  const ss = String(secs % 60).padStart(2, "0");

  const disabled = transcribing;
  const label = transcribing ? "Transcribing…"
              : recording   ? `Stop · ${mm}:${ss}`
              : "Speak to fill";

  return (
    <div className="rounded-md border border-indigo-200 bg-white/60 px-3 py-2 space-y-2"
         data-testid="voice-fill-bar">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={recording ? onStop : onStart}
          disabled={disabled}
          className={`inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-full font-medium border transition-all ${
            recording
              ? "bg-red-600 text-white border-red-600 animate-pulse"
              : transcribing
                ? "bg-slate-200 text-slate-600 border-slate-300 cursor-wait"
                : "bg-indigo-600 text-white border-indigo-600 hover:bg-indigo-700"
          }`}
          data-testid="voice-fill-toggle"
        >
          {transcribing ? <Loader2 size={13} className="animate-spin" />
           : recording  ? <Square size={12} />
                        : <Mic size={13} />}
          {label}
        </button>
        <span className="text-[11px] text-slate-500">
          <Sparkles size={11} className="inline mr-1 text-indigo-500" />
          Describe the transaction — the AI fills the fields.
        </span>
      </div>
      {error && (
        <div className="text-[11px] text-red-600" data-testid="voice-fill-error">
          {error}
        </div>
      )}
      {transcript && (
        <div className="flex items-start gap-2 text-[11px] text-slate-700 bg-slate-50 rounded-md px-2 py-1.5 border border-slate-200"
             data-testid="voice-fill-transcript">
          <Sparkles size={11} className="mt-0.5 shrink-0 text-emerald-500" />
          <div className="flex-1 italic">"{transcript}"</div>
          <button
            type="button"
            onClick={onClearTranscript}
            className="p-0.5 text-slate-400 hover:text-slate-700 shrink-0"
            data-testid="voice-fill-transcript-clear"
          >
            <X size={11} />
          </button>
        </div>
      )}
    </div>
  );
}
