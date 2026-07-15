import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, fmtMoney, BACKEND_URL } from "@/lib/api";
import { useCompany } from "@/lib/company";
import { TID } from "@/constants/testIds";
import { Download, Loader2 } from "lucide-react";

const startYtd = () => new Date(new Date().getFullYear(), 0, 1).toISOString().slice(0, 10);
const today = () => new Date().toISOString().slice(0, 10);

export default function ReportView() {
  const { kind } = useParams();
  const { currentId, current } = useCompany();
  const [basis, setBasis] = useState("accrual");
  const [start, setStart] = useState(startYtd());
  const [end, setEnd] = useState(today());
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const fetchData = async () => {
    if (!currentId) return;
    setBusy(true);
    const params = kind === "balance-sheet"
      ? `as_of=${end}&basis=${basis}`
      : `start=${start}&end=${end}&basis=${basis}`;
    try {
      const r = await api.get(`/companies/${currentId}/reports/${kind}?${params}`);
      setData(r.data);
    } finally { setBusy(false); }
  };

  useEffect(() => { fetchData(); /* eslint-disable-next-line */ }, [currentId, kind]);

  const downloadPdf = async () => {
    const params = kind === "balance-sheet"
      ? `as_of=${end}&basis=${basis}`
      : `start=${start}&end=${end}&basis=${basis}`;
    const token = localStorage.getItem("axiom_token");
    const r = await fetch(`${BACKEND_URL}/api/companies/${currentId}/reports/${kind}/pdf?${params}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `${kind}.pdf`; a.click();
    URL.revokeObjectURL(url);
  };

  const title = {
    "trial-balance": "Trial Balance",
    "balance-sheet": "Balance Sheet",
    "income-statement": "Income Statement",
    "general-ledger": "General Ledger",
    "cash-flow": "Statement of Cash Flows",
    "sales-tax": "Sales Tax Liability",
    "1099-summary": "1099 Summary",
  }[kind] || kind;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="font-heading text-3xl font-bold tracking-tight">{title}</h1>
        <div className="ml-auto flex items-center gap-2">
          {kind !== "balance-sheet" && kind !== "trial-balance" && (
            <div className="inline-flex rounded-md border bg-white text-xs" data-testid={TID.reportBasisToggle}>
              {["accrual", "cash"].map(b => (
                <button key={b} onClick={() => setBasis(b)}
                        className={`px-3 py-1.5 ${basis === b ? "bg-slate-900 text-white" : "text-slate-600"}`}>
                  {b[0].toUpperCase() + b.slice(1)}
                </button>
              ))}
            </div>
          )}
          {kind !== "balance-sheet" && (
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          )}
          <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="border rounded px-2 py-1 text-xs" />
          <button data-testid={TID.reportApply} onClick={fetchData} className="px-3 py-1.5 rounded-md border bg-white text-xs">Apply</button>
          <button data-testid={TID.reportExportPdf} onClick={downloadPdf}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs">
            <Download size={13} /> Export PDF
          </button>
        </div>
      </div>

      {busy && <div className="flex items-center gap-2 text-slate-500 text-sm"><Loader2 size={14} className="animate-spin" /> Computing…</div>}

      {data && (
        <div className="report-page mx-auto">
          <div className="text-center border-b pb-4 mb-6">
            <div className="font-heading text-2xl font-bold">{data.company_name || current?.name}</div>
            <div className="uppercase tracking-widest text-sm mt-1">{title}</div>
            <div className="text-xs text-slate-500 mt-1">
              {kind === "balance-sheet"
                ? `As of ${data.as_of} · ${data.basis} basis`
                : kind === "1099-summary"
                ? `Tax year ${data.year}`
                : `${data.period_start} to ${data.period_end}${data.basis ? ` · ${data.basis} basis` : ""}`}
            </div>
          </div>

          {kind === "income-statement" && (
            <IncomeStatementBody data={data} />
          )}
          {kind === "balance-sheet" && (
            <BalanceSheetBody data={data} />
          )}
          {kind === "trial-balance" && (
            <TrialBalanceBody data={data} />
          )}
          {kind === "general-ledger" && (
            <GeneralLedgerBody data={data} />
          )}
          {kind === "cash-flow" && (
            <CashFlowBody data={data} />
          )}
          {kind === "sales-tax" && (
            <SalesTaxBody data={data} />
          )}
          {kind === "1099-summary" && (
            <Form1099Body data={data} />
          )}
        </div>
      )}
    </div>
  );
}

function Section({ title }) {
  return (
    <div className="mt-4 mb-1 uppercase text-xs tracking-widest font-semibold text-slate-700 bg-slate-50 px-3 py-1.5 rounded">
      {title}
    </div>
  );
}
function Row({ code, name, amount, bold }) {
  return (
    <div className={`grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100 ${bold ? "font-semibold border-slate-800" : ""}`}>
      <div className="col-span-2 font-mono-num text-xs text-slate-500">{code}</div>
      <div className="col-span-7">{name}</div>
      <div className="col-span-3 text-right font-mono-num">{fmtMoney(amount)}</div>
    </div>
  );
}

function IncomeStatementBody({ data }) {
  return (
    <div className="text-sm">
      <Section title="Revenue" />
      {data.revenue.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Revenue" amount={data.total_revenue} bold />
      <Section title="Operating Expenses" />
      {data.expenses.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Expenses" amount={data.total_expense} bold />
      <div className="mt-4 grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net Income</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_income)}</div>
      </div>
    </div>
  );
}

function BalanceSheetBody({ data }) {
  return (
    <div className="text-sm">
      <Section title="Assets" />
      {data.assets.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Assets" amount={data.total_assets} bold />
      <Section title="Liabilities" />
      {data.liabilities.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Liabilities" amount={data.total_liabilities} bold />
      <Section title="Equity" />
      {data.equity.map(r => <Row key={r.code} {...r} />)}
      <Row code="" name="Total Equity" amount={data.total_equity} bold />
      <div className="mt-4 grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Total Liabilities &amp; Equity</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.total_liabilities_equity)}</div>
      </div>
    </div>
  );
}

function TrialBalanceBody({ data }) {
  return (
    <div className="text-sm">
      <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-50 rounded text-xs uppercase tracking-wider font-semibold text-slate-600">
        <div className="col-span-2">Code</div><div className="col-span-6">Account</div>
        <div className="col-span-2 text-right">Debit</div><div className="col-span-2 text-right">Credit</div>
      </div>
      {data.rows.map(r => (
        <div key={r.code} className="grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100">
          <div className="col-span-2 font-mono-num text-xs text-slate-500">{r.code}</div>
          <div className="col-span-6">{r.name}</div>
          <div className="col-span-2 text-right font-mono-num">{r.debit ? fmtMoney(r.debit) : ""}</div>
          <div className="col-span-2 text-right font-mono-num">{r.credit ? fmtMoney(r.credit) : ""}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 mt-2 font-semibold">
        <div className="col-span-8">Total</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_debit)}</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_credit)}</div>
      </div>
    </div>
  );
}

function GeneralLedgerBody({ data }) {
  const badge = (src) => {
    const map = {
      Txn:   "bg-indigo-100 text-indigo-700",
      Split: "bg-violet-100 text-violet-700",
      JE:    "bg-amber-100 text-amber-800",
    };
    return `text-[10px] font-medium px-1.5 py-0.5 rounded ${map[src] || "bg-slate-100 text-slate-600"}`;
  };
  return (
    <div className="text-sm space-y-4">
      {data.sections.map(sec => (
        <div key={sec.code}>
          <div className="uppercase text-xs tracking-widest font-semibold text-slate-700 bg-slate-50 px-3 py-1.5 rounded">
            {sec.code} · {sec.name}
          </div>
          <div className="grid grid-cols-12 gap-2 px-3 py-1 text-[10px] uppercase tracking-wider text-slate-500 font-semibold border-b">
            <div className="col-span-2">Date</div>
            <div className="col-span-1">Source</div>
            <div className="col-span-4">Description</div>
            <div className="col-span-2 text-right">Debit</div>
            <div className="col-span-1 text-right">Credit</div>
            <div className="col-span-2 text-right">Balance</div>
          </div>
          <div className="grid grid-cols-12 gap-2 px-3 py-1 border-b border-slate-100 text-[12px] text-slate-500 italic">
            <div className="col-span-7">Opening balance</div>
            <div className="col-span-3 text-right"></div>
            <div className="col-span-2 text-right font-mono-num">{fmtMoney(sec.opening_balance)}</div>
          </div>
          {sec.entries.map((e, i) => (
            <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1 border-b border-slate-100 text-[13px] hover:bg-slate-50">
              <div className="col-span-2 font-mono-num text-xs text-slate-500">{e.date}</div>
              <div className="col-span-1">
                <span className={badge(e.source)}>{e.source}</span>
              </div>
              <div className="col-span-4 truncate" title={e.reference}>{e.description}</div>
              <div className="col-span-2 text-right font-mono-num">{e.debit ? fmtMoney(e.debit) : ""}</div>
              <div className="col-span-1 text-right font-mono-num">{e.credit ? fmtMoney(e.credit) : ""}</div>
              <div className="col-span-2 text-right font-mono-num text-slate-600">{fmtMoney(e.balance)}</div>
            </div>
          ))}
          <div className="text-right px-3 py-1.5 font-semibold border-t border-slate-800">
            Ending: <span className="font-mono-num">{fmtMoney(sec.total)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CashFlowBody({ data }) {
  return (
    <div className="text-sm space-y-2">
      {[["Operating Activities", data.operating],
        ["Investing Activities", data.investing],
        ["Financing Activities", data.financing]].map(([k, v]) => (
        <div key={k} className="grid grid-cols-12 gap-2 px-3 py-2 border-b">
          <div className="col-span-9">{k}</div>
          <div className="col-span-3 text-right font-mono-num">{fmtMoney(v)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded mt-3">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net Change in Cash</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_change)}</div>
      </div>
    </div>
  );
}

function SalesTaxBody({ data }) {
  return (
    <div className="text-sm space-y-1">
      {data.rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 px-3 py-2 border-b">
          <div className="col-span-9">{r.label}</div>
          <div className="col-span-3 text-right font-mono-num">{fmtMoney(r.amount)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 bg-slate-50 rounded mt-3">
        <div className="col-span-9 font-heading font-bold uppercase text-sm">Net sales tax liability owed</div>
        <div className="col-span-3 text-right font-mono-num font-bold">{fmtMoney(data.net_liability)}</div>
      </div>
      <div className="mt-3 text-xs text-slate-500">
        Based on {data.invoices_count} invoices and {data.bills_count} bills in the period.
      </div>
    </div>
  );
}

function Form1099Body({ data }) {
  if (!data.rows.length) {
    return (
      <div className="text-sm text-slate-500 py-6 text-center">
        No contractors met the $600 reporting threshold in {data.year}.
      </div>
    );
  }
  return (
    <div className="text-sm">
      <div className="grid grid-cols-12 gap-2 px-3 py-2 bg-slate-50 rounded text-xs uppercase tracking-wider font-semibold text-slate-600">
        <div className="col-span-5">Contractor</div>
        <div className="col-span-3">TIN / EIN</div>
        <div className="col-span-2 text-center">W-9</div>
        <div className="col-span-2 text-right">Total Paid</div>
      </div>
      {data.rows.map((r, i) => (
        <div key={i} className="grid grid-cols-12 gap-2 px-3 py-1.5 border-b border-slate-100">
          <div className="col-span-5">{r.contact_name}</div>
          <div className="col-span-3 font-mono-num text-xs text-slate-600">{r.tin || "—"}</div>
          <div className="col-span-2 text-center">
            {r.w9_on_file
              ? <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">Yes</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-100 text-orange-700">Missing</span>}
          </div>
          <div className="col-span-2 text-right font-mono-num">{fmtMoney(r.total_paid)}</div>
        </div>
      ))}
      <div className="grid grid-cols-12 gap-2 px-3 py-2 border-t-2 border-slate-800 mt-2 font-semibold">
        <div className="col-span-10">Total reportable</div>
        <div className="col-span-2 text-right font-mono-num">{fmtMoney(data.total_reportable)}</div>
      </div>
    </div>
  );
}
