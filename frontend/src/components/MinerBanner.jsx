import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Sparkles, X } from "lucide-react";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * Dashboard banner surfaced when the AI rules miner has silently
 * auto-applied one or more `(merchant → category)` rules — usually
 * right after a fresh QBO migration or a bulk historical reclassify.
 *
 * Pros need to know these rules landed without their input so they
 * can review them on /accounting/rules. Dismissable per-company:
 * once dismissed, only NEW auto-applied rules re-trigger the banner
 * (based on `companies.miner_banner_dismissed_at`).
 *
 * Feb 28 2026.
 */
export default function MinerBanner() {
  const { currentId } = useCompany();
  const [payload, setPayload] = useState(null);
  const [hiding, setHiding] = useState(false);

  useEffect(() => {
    if (!currentId) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.get(`/companies/${currentId}/miner-notification`);
        if (!cancelled) setPayload(r.data);
      } catch {
        /* silent — banner just hides */
      }
    })();
    return () => { cancelled = true; };
  }, [currentId]);

  const dismiss = async () => {
    setHiding(true);
    try {
      await api.post(`/companies/${currentId}/miner-notification/dismiss`);
    } catch {
      /* ignore */
    }
    setPayload(null);
  };

  const count = payload?.new_rules_count || 0;
  if (!count || hiding) return null;

  const samples = payload.sample_rules || [];

  return (
    <div
      data-testid="miner-banner"
      className="relative rounded-xl border border-indigo-200 bg-gradient-to-r from-indigo-50 via-violet-50 to-fuchsia-50 p-4 pr-10 shadow-sm"
    >
      <button
        type="button"
        onClick={dismiss}
        data-testid="miner-banner-dismiss"
        className="absolute right-3 top-3 rounded-full p-1 text-slate-500 hover:bg-white/60 hover:text-slate-900 transition"
        aria-label="Dismiss"
      >
        <X size={16} />
      </button>

      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 rounded-lg bg-white/70 p-2 ring-1 ring-indigo-200">
          <Sparkles size={18} className="text-indigo-600" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-900">
            {count} categorization rule{count === 1 ? "" : "s"} auto-applied from your ledger history
          </div>
          <div className="mt-0.5 text-xs text-slate-600">
            {samples.length > 0 ? (
              <>
                Includes{" "}
                {samples.map((s, i) => (
                  <span key={i}>
                    {i > 0 && (i === samples.length - 1 ? ", and " : ", ")}
                    <span className="font-medium text-slate-800">
                      {s.match_value}
                    </span>
                    {" → "}
                    <span className="text-slate-700">{s.account_name}</span>
                  </span>
                ))}
                . New categorizations will follow these rules automatically.
              </>
            ) : (
              <>New categorizations will follow these rules automatically.</>
            )}
          </div>
          <Link
            to="/accounting/rules"
            data-testid="miner-banner-review-link"
            className="mt-2 inline-flex items-center gap-1 text-xs font-medium text-indigo-700 hover:text-indigo-900"
          >
            Review rules →
          </Link>
        </div>
      </div>
    </div>
  );
}
