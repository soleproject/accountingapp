import { useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Upload, Loader2, CheckCircle2, AlertTriangle, XCircle } from "lucide-react";

/**
 * Post-migration verification widget — customer uploads their QBO
 * Balance Sheet PDF, we extract each account balance with an LLM,
 * then diff against our computed BS and render a side-by-side table.
 *
 * v1 = read-only diff (CPA reviews and posts any adjustments via the
 * existing superadmin backfill panel). Feb 26 2026.
 */
export default function QboMigrationVerify({ companyId }) {
  const [file, setFile] = useState(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);

  const upload = async () => {
    if (!file) return;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await api.post(
        `/companies/${companyId}/qbo/verify-migration`,
        fd,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      setResult(r.data);
      toast.success(
        `Verified: ${r.data.match_count}/${r.data.row_count} accounts tie (${r.data.match_pct}%)`,
      );
    } catch (err) {
      const msg = err.response?.data?.detail || err.message;
      setError(msg);
      toast.error(`Verification failed: ${msg}`);
    } finally {
      setRunning(false);
    }
  };

  const iconFor = (status) => {
    if (status === "match")
      return <CheckCircle2 className="h-4 w-4 text-emerald-600" />;
    if (status === "minor")
      return <AlertTriangle className="h-4 w-4 text-amber-500" />;
    return <XCircle className="h-4 w-4 text-red-600" />;
  };
  const bgFor = (status) => {
    if (status === "match") return "";
    if (status === "minor") return "bg-amber-50";
    return "bg-red-50";
  };

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm"
      data-testid="qbo-verify-migration-panel"
    >
      <div className="mb-3">
        <h3 className="text-base font-semibold text-slate-900">
          Verify migration against QuickBooks
        </h3>
        <p className="mt-1 text-sm text-slate-600">
          Export your Balance Sheet from QuickBooks Online, upload it
          here, and we'll show a per-account side-by-side. Green rows
          tie to the penny; yellow rows are within 5%; red rows need
          a bookkeeper's eye.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <label
          className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-slate-300 bg-white px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          data-testid="qbo-verify-file-label"
        >
          <Upload className="h-4 w-4" />
          {file ? file.name : "Choose Balance Sheet PDF"}
          <input
            type="file"
            accept=".pdf,application/pdf"
            className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            data-testid="qbo-verify-file-input"
          />
        </label>
        <button
          type="button"
          onClick={upload}
          disabled={!file || running}
          data-testid="qbo-verify-run"
          className="inline-flex items-center gap-2 rounded-md bg-slate-900 px-3.5 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              Verifying…
            </>
          ) : (
            "Run verification"
          )}
        </button>
      </div>

      {error && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800"
          data-testid="qbo-verify-error"
        >
          {error}
        </div>
      )}

      {result && (
        <div className="mt-5" data-testid="qbo-verify-result">
          <div className="mb-3 flex flex-wrap items-center gap-4 text-sm">
            <span className="font-medium text-slate-700">
              As of {result.as_of}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                result.match_pct >= 90
                  ? "bg-emerald-100 text-emerald-800"
                  : result.match_pct >= 70
                    ? "bg-amber-100 text-amber-800"
                    : "bg-red-100 text-red-800"
              }`}
            >
              {result.match_count}/{result.row_count} accounts tie ·{" "}
              {result.match_pct}%
            </span>
          </div>
          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-left">Account</th>
                  <th className="px-3 py-2 text-right">QBO</th>
                  <th className="px-3 py-2 text-right">Ours</th>
                  <th className="px-3 py-2 text-right">Δ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {result.rows.map((r, i) => (
                  <tr
                    key={i}
                    className={bgFor(r.status)}
                    data-testid={`qbo-verify-row-${i}`}
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        {iconFor(r.status)}
                        <span className="text-xs text-slate-500 capitalize">
                          {r.status === "our_only" ? "extra" : r.status}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-800">
                      {r.account_name}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      ${r.qbo_amount.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-slate-700">
                      ${r.our_amount.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                    <td
                      className={`px-3 py-2 text-right tabular-nums ${
                        Math.abs(r.delta) < 0.01
                          ? "text-slate-400"
                          : "font-medium text-slate-900"
                      }`}
                    >
                      {r.delta >= 0 ? "+" : ""}
                      {r.delta.toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
