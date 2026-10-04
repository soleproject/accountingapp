import React, { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Receipt, FileText, Camera } from "lucide-react";
import StatementsTab from "@/components/StatementsTab";
import { Card, Pill, Button, fmtDay } from "./ui";

const FILTERS = ["All", "Receipts", "Statements"];

export default function DocumentsTab({ data, companyId }) {
  const navigate = useNavigate();
  const { documents } = data;
  const [filter, setFilter] = useState("All");
  const rows = documents.rows.filter(r => filter === "All" || (filter === "Receipts" ? r.type === "receipt" : r.type === "statement"));
  return (
    <div data-testid="owner-documents-tab">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card data-testid="owner-documents-upload">
          <h2 className="font-heading text-xl mb-1">Send documents to your team</h2>
          <p className="text-xs text-slate-500 mb-4">Bank or card statements go here. We read them, match them to the bank, and file them.</p>
          <StatementsTab companyId={companyId} bare />
          <div className="mt-4 flex items-center justify-between rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3">
            <div className="flex items-center gap-3"><Receipt size={16} className="text-slate-500" /><div><div className="text-sm font-semibold">Have a receipt?</div><div className="text-xs text-slate-500">Snap or upload it — we'll match it to the right purchase.</div></div></div>
            <Button onClick={() => navigate("/receipts")} data-testid="owner-documents-receipts-link">Add receipt</Button>
          </div>
        </Card>
        <Card eyebrow={documents.missing_receipts.length ? `${documents.missing_receipts.length} item${documents.missing_receipts.length > 1 ? "s" : ""} need${documents.missing_receipts.length > 1 ? "" : "s"} you` : "All caught up"} title={documents.missing_receipts.length ? `Help finish ${data.books.period_label}'s books.` : "No paperwork is missing."} data-testid="owner-documents-missing">
          {documents.missing_receipts.length === 0 && <div className="text-sm text-slate-500">Every expense your team flagged has its receipt.</div>}
          <div className="divide-y divide-slate-200">
            {documents.missing_receipts.map(m => (
              <div key={m.id} className="flex items-center gap-3.5 py-3.5" data-testid={`owner-missing-receipt-${m.id}`}>
                <span className="flex-none w-9 h-9 rounded-xl grid place-items-center bg-amber-50 text-amber-700 border border-amber-200"><Camera size={15} /></span>
                <div className="flex-1 min-w-0"><div className="text-sm font-semibold truncate">{m.title}</div><div className="text-xs text-slate-500 truncate">{m.detail}</div></div>
                <Button primary disabled={!m.href} onClick={() => m.href && navigate(m.href)} data-testid={`owner-missing-receipt-snap-${m.id}`}>Snap receipt</Button>
              </div>
            ))}
          </div>
          {documents.missing_receipts.length > 0 && <div className="text-xs text-slate-500 mt-2">Your team found the payment but needs the receipt to support the expense.</div>}
        </Card>
      </div>

      <Card className="mt-4" data-testid="owner-documents-list">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h2 className="font-heading text-xl">Your documents</h2>
          <div className="flex gap-1.5">{FILTERS.map(f => <button key={f} onClick={() => setFilter(f)} className={`text-xs px-3 py-1 rounded-full border ${filter === f ? "bg-slate-900 text-white border-slate-900" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`} data-testid={`owner-documents-filter-${f.toLowerCase()}`}>{f}</button>)}</div>
        </div>
        {rows.length === 0 ? (
          <div className="text-sm text-slate-500 py-8 text-center">Nothing here yet. Statements and receipts you send will show up with their status.</div>
        ) : (
          <table className="w-full text-sm mt-2">
            <thead><tr className="text-[10px] tracking-[0.1em] uppercase text-slate-500 border-b border-slate-200"><th className="text-left py-2 font-semibold">Document</th><th className="text-left py-2 font-semibold">Added</th><th className="text-left py-2 font-semibold">Status</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={`${r.type}-${r.id}`} className="border-b border-slate-100" data-testid={`owner-document-row-${r.id}`}>
                  <td className="py-3 flex items-center gap-2">{r.type === "receipt" ? <Receipt size={14} className="text-slate-400" /> : <FileText size={14} className="text-slate-400" />}{r.title}</td>
                  <td className="py-3 text-slate-600">{fmtDay(r.added)}</td>
                  <td className="py-3"><Pill tone={r.tone}>{r.status}</Pill></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
