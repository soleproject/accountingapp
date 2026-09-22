/**
 * PaymentsAppResumeCard — shared "you have an unfinished payments
 * application" nudge. Renders in three places:
 *   1. Sidebar (compact pill under the main nav)
 *   2. Pro Cockpit (per-client tile)
 *   3. Client Cockpit (client-facing tile)
 *
 * The component fetches `/companies/{cid}/payments-app/status` and
 * only paints when `exists && status === "draft"` — a submitted app
 * or an untouched company shows nothing.
 */

import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { CreditCard, ArrowRight } from "lucide-react";

import { api } from "@/lib/api";

export default function PaymentsAppResumeCard({ companyId, variant = "sidebar" }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${companyId}/payments-app/status`);
        if (!cancelled) setStatus(r.data || null);
      } catch { /* silent */ }
    })();
    return () => { cancelled = true; };
  }, [companyId]);

  if (!status || !status.exists || status.status !== "draft") return null;

  const pct = Math.round(status.pct || 0);

  if (variant === "sidebar") {
    return (
      <Link
        to="/welcome/payments"
        className="mx-2 my-2 rounded-md border border-emerald-200 bg-emerald-50 p-2 flex items-center gap-2 text-left hover:bg-emerald-100 transition"
        data-testid="payments-app-resume-sidebar"
      >
        <div className="w-7 h-7 rounded bg-white border border-emerald-200 flex items-center justify-center shrink-0">
          <CreditCard size={13} className="text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-emerald-900 leading-tight truncate">
            Finish payments app
          </div>
          <div className="text-[10px] text-emerald-700 font-mono-num">{pct}% complete</div>
        </div>
        <ArrowRight size={12} className="text-emerald-700 shrink-0" />
      </Link>
    );
  }

  // Cockpit variant — wider tile with a progress bar.
  return (
    <Link
      to="/welcome/payments"
      className="block rounded-lg border border-emerald-200 bg-emerald-50 p-3 hover:bg-emerald-100 transition"
      data-testid={`payments-app-resume-${variant}`}
    >
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-white border border-emerald-200 flex items-center justify-center shrink-0">
          <CreditCard size={16} className="text-emerald-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-emerald-900 text-sm">Finish payments application</div>
          <div className="text-[11px] text-emerald-700">Get paid faster — {pct}% complete</div>
        </div>
        <ArrowRight size={14} className="text-emerald-700 shrink-0" />
      </div>
      <div className="mt-2 h-1.5 bg-white/60 rounded overflow-hidden">
        <div className="h-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </Link>
  );
}
