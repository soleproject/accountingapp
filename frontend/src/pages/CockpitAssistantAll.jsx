/**
 * CockpitAssistantAll — Full-list "Human Assistant Can Help" view.
 *
 * Opened from Today v7's AssistantPanel via the "View all →" link.
 * Same data pipeline (GET /api/cockpit/today-v4) + same derivation
 * helper (`deriveAssistantItems`) so the compact panel and this
 * page can never drift.
 */
import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { deriveAssistantItems } from "@/lib/cockpitAssistant";
import { ArrowLeft, CheckCircle2, Loader2, UserRound } from "lucide-react";

export default function CockpitAssistantAll() {
  const [items, setItems] = useState(null);
  const [busy, setBusy] = useState(true);
  const navigate = useNavigate();

  useEffect(() => {
    let cancel = false;
    api.get(`/cockpit/today-v4?days=14`)
      .then(r => { if (!cancel) setItems(deriveAssistantItems(r.data)); })
      .catch(() => { if (!cancel) setItems([]); })
      .finally(() => { if (!cancel) setBusy(false); });
    return () => { cancel = true; };
  }, []);

  return (
    <div className="min-h-screen bg-slate-50" data-testid="cockpit-assistant-all-page">
      <div className="max-w-[1000px] mx-auto px-6 py-6 space-y-4">
        <button
          type="button"
          onClick={() => navigate("/cockpit/today-v7")}
          data-testid="assistant-all-back"
          className="inline-flex items-center gap-1.5 text-[12px] text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft size={13} />
          <span>Back to Today</span>
        </button>

        <div className="rounded-2xl border-2 border-sky-200 bg-sky-50/50 p-5">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-full bg-sky-100 text-sky-700 flex items-center justify-center">
              <UserRound size={15} />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Human Assistant Can Help</div>
              <div className="text-[11px] text-slate-500">
                All clients where automation has hit diminishing returns — a warm human touch is likely to help.
              </div>
            </div>
          </div>
        </div>

        {busy && (
          <div className="py-16 flex justify-center">
            <Loader2 className="animate-spin text-slate-400" />
          </div>
        )}

        {!busy && items?.length === 0 && (
          <div className="rounded-xl border border-slate-200 bg-white p-8 text-center">
            <div className="text-sm text-slate-500">
              Nothing needs a human touch right now — AI is handling everything.
            </div>
          </div>
        )}

        {!busy && items?.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3" data-testid="assistant-all-grid">
            {items.map(it => (
              <div key={it.id}
                   className="rounded-lg bg-white border border-sky-100 p-4"
                   data-testid={`assistant-all-card-${it.id}`}>
                <div className="text-sm font-semibold text-slate-900 mb-1">{it.company}</div>
                <div className="text-[12px] text-slate-600 mb-2">{it.headline}</div>
                <div className="text-[11px] text-slate-500 mb-1">AI already:</div>
                <ul className="mb-2 space-y-0.5">
                  {it.steps.map((s, i) => (
                    <li key={i} className="text-[12px] text-slate-700 flex items-start gap-1.5">
                      <CheckCircle2 size={11} className="text-emerald-500 mt-1 shrink-0" /> {s}
                    </li>
                  ))}
                </ul>
                <div className="text-[11px] font-semibold text-sky-700">Suggested human action:</div>
                <div className="text-[12px] text-slate-800 mb-2">{it.suggested}</div>
                <div className="flex gap-2">
                  <button onClick={() => navigate(it.route)}
                          className="text-[11px] px-2.5 py-1 rounded-md bg-sky-600 text-white hover:bg-sky-700">
                    Open client
                  </button>
                  <button className="text-[11px] px-2.5 py-1 rounded-md border border-slate-200 text-slate-700 hover:bg-white">
                    Mark contacted
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
