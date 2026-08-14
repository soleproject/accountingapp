/**
 * QboEnvToggle — per-company QuickBooks environment picker.
 *
 * Renders above the "Danger zone" section in Company Settings. Fetches
 * the current selection + lock state from `GET /companies/:cid/qbo/env`.
 * Flips via `PATCH /companies/:cid/qbo/env`.
 *
 * Lock behavior — while the company has an active QBO connection the
 * server returns `locked: true`. We render both radio options as
 * disabled and surface `lock_reason` so the user knows they need to
 * click "Disconnect QuickBooks" on the /connections/qbo page first.
 * The backend rejects the flip with 409 as a safety net too.
 *
 * Default — brand-new companies with no `qbo_env` field selected
 * come back as "production" (per `QBO_ENV_DEFAULT`). Existing
 * sandbox-connected companies were backfilled to "sandbox" at
 * startup so the toggle reflects reality on Feb 2026 rollout.
 */
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { Cloud, TestTube2, Loader2, Lock } from "lucide-react";

export default function QboEnvToggle({ companyId }) {
  const [state, setState] = useState(null); // { env, locked, lock_reason, connection_env, default }
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!companyId) return;
    try {
      const r = await api.get(`/companies/${companyId}/qbo/env`);
      setState(r.data);
    } catch (e) {
      // Non-fatal — the toggle just won't render if we can't fetch.
      // Silent to avoid noise; the backend endpoint is new.
      setState(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setLoading(true);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId]);

  const flip = async (next) => {
    if (!state || state.env === next || state.locked || saving) return;
    setSaving(true);
    try {
      const r = await api.patch(`/companies/${companyId}/qbo/env`, { env: next });
      setState((s) => ({ ...s, env: r.data.env }));
      toast.success(
        `QuickBooks environment switched to ${
          next === "production" ? "Production" : "Sandbox"
        }`,
      );
    } catch (e) {
      const detail = e?.response?.data?.detail || e.message;
      toast.error(`Failed to switch: ${detail}`);
      // Re-fetch — the row may have gained a connection since load.
      load();
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div
        data-testid="qbo-env-toggle-loading"
        className="rounded-xl border border-slate-200 bg-white p-5"
      >
        <div className="flex items-center gap-2 text-slate-500 text-sm">
          <Loader2 size={14} className="animate-spin" /> Loading QuickBooks environment…
        </div>
      </div>
    );
  }

  if (!state) return null;

  const options = [
    {
      key: "production",
      label: "Production",
      description:
        "Connect to your real QuickBooks Online company. Uses your live Intuit credentials — every sync writes to actual books.",
      icon: Cloud,
      accent: "emerald",
    },
    {
      key: "sandbox",
      label: "Sandbox",
      description:
        "Connect to an Intuit-provided QBO sandbox company. Safe for testing mappings, rules, and integrations without touching real books.",
      icon: TestTube2,
      accent: "amber",
    },
  ];

  return (
    <div
      data-testid="qbo-env-toggle"
      className="rounded-xl border border-slate-200 bg-white p-5 space-y-4"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-heading font-semibold text-lg text-slate-900">
            QuickBooks environment
          </h3>
          <p className="text-sm text-slate-600 mt-1">
            Choose which Intuit environment this company connects to when you
            click <span className="font-medium">Connect QuickBooks</span>.
            {" "}Existing connections keep their original environment until you
            disconnect and reconnect.
          </p>
        </div>
        {state.locked && (
          <span
            data-testid="qbo-env-locked-pill"
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-100 text-slate-600 text-xs font-medium border border-slate-200 shrink-0"
            title={state.lock_reason || ""}
          >
            <Lock size={11} /> Locked · connected to {state.connection_env}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {options.map((opt) => {
          const selected = state.env === opt.key;
          const disabled = state.locked || saving;
          const Icon = opt.icon;
          const accentBorder =
            opt.accent === "emerald" ? "border-emerald-500" : "border-amber-500";
          const accentBg =
            opt.accent === "emerald" ? "bg-emerald-50" : "bg-amber-50";
          const accentDot =
            opt.accent === "emerald" ? "bg-emerald-500" : "bg-amber-500";
          return (
            <button
              key={opt.key}
              type="button"
              data-testid={`qbo-env-option-${opt.key}`}
              disabled={disabled}
              onClick={() => flip(opt.key)}
              className={[
                "text-left rounded-lg border-2 p-4 transition-all",
                selected
                  ? `${accentBorder} ${accentBg} shadow-sm`
                  : "border-slate-200 bg-white hover:border-slate-300",
                disabled
                  ? "opacity-60 cursor-not-allowed"
                  : "cursor-pointer",
              ].join(" ")}
              aria-pressed={selected}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Icon
                  size={16}
                  className={
                    opt.accent === "emerald" ? "text-emerald-700" : "text-amber-700"
                  }
                />
                <span className="font-semibold text-slate-900 text-sm">
                  {opt.label}
                </span>
                {selected && (
                  <span
                    data-testid={`qbo-env-selected-${opt.key}`}
                    className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-slate-700"
                  >
                    <span className={`w-2 h-2 rounded-full ${accentDot}`} />
                    Selected
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-600 leading-relaxed">
                {opt.description}
              </p>
            </button>
          );
        })}
      </div>

      {state.locked && state.lock_reason && (
        <p
          data-testid="qbo-env-lock-reason"
          className="text-xs text-slate-500 border-l-2 border-slate-300 pl-3"
        >
          {state.lock_reason}
        </p>
      )}
    </div>
  );
}
