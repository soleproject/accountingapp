import React, { useState } from "react";
import { api } from "@/lib/api";
import { Loader2, Check } from "lucide-react";
import { toast } from "sonner";

export default function ImportAccountConfirm({ companyId, row, onDone }) {
  const p = row.account_proposal || {};
  const [choice, setChoice] = useState(p.matched ? p.account_id : "");
  const [busy, setBusy] = useState(false);
  const label = `${p.bank_name || "Statement"}${p.last4 ? ` ···${p.last4}` : ""}`;

  const submit = async (body) => {
    setBusy(true);
    try {
      const { data } = await api.post(`/companies/${companyId}/statements/imports/${row.id}/confirm-account`, body);
      toast.success(data?.status === "needs_review"
        ? `${row.filename}: account set — held for review before posting.`
        : `${row.filename} → posted to ${data?.account?.name || data?.account_name || "account"}`);
      onDone?.();
    } catch (e) {
      toast.error(e?.response?.data?.detail || "Could not confirm account");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="mx-4 my-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-xs text-amber-900"
      onClick={(e) => e.stopPropagation()}
      data-testid={`stmt-account-confirm-${row.id}`}
    >
      {p.matched ? (
        <div className="font-medium">
          {label} looks like <span className="font-semibold">{p.account_name}</span>. Post {row.transaction_count ?? ""} transactions there?
        </div>
      ) : (
        <div className="font-medium">
          I don't see an account ending in {p.last4 || "—"} for {p.bank_name || "this statement"}. Where should these {row.transaction_count ?? ""} transactions go?
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          disabled={busy}
          className="rounded border border-amber-300 bg-white px-2 py-1 text-xs text-slate-800 min-w-[260px]"
          data-testid={`stmt-account-confirm-select-${row.id}`}
        >
          <option value="">— Choose an existing account —</option>
          {(p.candidates || []).map((a) => (
            <option key={a.id} value={a.id}>{a.code} · {a.name}</option>
          ))}
        </select>
        <button
          type="button"
          disabled={busy || !choice}
          onClick={() => submit({ account_id: choice })}
          className="inline-flex items-center gap-1 rounded-full bg-indigo-600 text-white px-3 py-1 font-semibold hover:bg-indigo-700 disabled:opacity-50"
          data-testid={`stmt-account-confirm-use-${row.id}`}
        >
          {busy ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {p.matched && choice === p.account_id ? "Yes, post here" : "Post to this account"}
        </button>
        <span className="text-amber-700">or</span>
        <button
          type="button"
          disabled={busy}
          onClick={() => submit({ create: true })}
          className="rounded-full border border-amber-400 bg-white px-3 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
          data-testid={`stmt-account-confirm-create-${row.id}`}
        >
          Create “{p.suggested_name || `${label} (new)`}”
        </button>
      </div>
      <div className="mt-1.5 text-[11px] text-amber-700">Once confirmed, future statements for {label} post here automatically.</div>
    </div>
  );
}
