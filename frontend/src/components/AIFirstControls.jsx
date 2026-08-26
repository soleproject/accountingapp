// AI-First Beta — industry template picker + categorization mode toggle.
// Standard onboarding picks the template first; Settings holds the mode.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

// Reusable industry picker — used both in onboarding (as a required
// step) and in Settings (to change the template later).
export function IndustryTemplatePicker({ companyId, value, onChange, autoSaveOnPick = true }) {
  const [templates, setTemplates] = useState([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    api.get("/industry-templates").then(r => setTemplates(r.data?.templates || []));
  }, []);
  const pick = async (slug) => {
    if (!autoSaveOnPick) { onChange?.(slug); return; }
    setSaving(true);
    try {
      const r = await api.post(`/companies/${companyId}/industry-template`, { template: slug });
      toast.success(`Template set · ${r.data.seeded_accounts} accounts added`);
      onChange?.(slug);
    } catch (e) {
      toast.error(`Could not set template: ${e.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="grid grid-cols-2 gap-2" data-testid="industry-template-picker">
      {templates.map(t => (
        <button
          key={t.slug}
          type="button"
          onClick={() => pick(t.slug)}
          disabled={saving}
          data-testid={`industry-template-${t.slug}`}
          className={
            "text-left rounded-lg border p-3 hover:border-indigo-500 hover:bg-indigo-50/30 transition-colors disabled:opacity-50 " +
            (value === t.slug ? "border-indigo-600 bg-indigo-50 ring-1 ring-indigo-600" : "border-slate-300 bg-white")
          }
        >
          <div className="flex items-baseline gap-2">
            <span className="text-lg">{t.icon}</span>
            <span className="font-semibold text-slate-900 text-sm">{t.label}</span>
          </div>
          <div className="text-[10px] text-slate-500 mt-0.5">{t.account_count} accounts</div>
        </button>
      ))}
    </div>
  );
}

// Settings toggle — Standard vs AI-First Beta.
export function CategorizationModeToggle({ companyId, initialMode }) {
  const [mode, setMode] = useState(initialMode || "standard");
  const [saving, setSaving] = useState(false);
  const flip = async (newMode) => {
    if (newMode === mode) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/categorization-mode`, { mode: newMode });
      setMode(newMode);
      toast.success(
        newMode === "ai_first"
          ? "AI-First Beta enabled — next batch of transactions will use the AI pipeline"
          : "Reverted to Standard categorization"
      );
    } catch (e) {
      toast.error(`Could not save: ${e.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="categorization-mode-toggle">
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name="cat-mode"
          checked={mode === "standard"}
          disabled={saving}
          onChange={() => flip("standard")}
          className="mt-1"
          data-testid="cat-mode-standard"
        />
        <span className="text-sm">
          <span className="font-semibold text-slate-900">Standard</span>
          <span className="text-slate-500 ml-2 text-xs">
            (recommended) — deterministic categorization with human review
          </span>
        </span>
      </label>
      <label className="flex items-start gap-2 cursor-pointer">
        <input
          type="radio"
          name="cat-mode"
          checked={mode === "ai_first"}
          disabled={saving}
          onChange={() => flip("ai_first")}
          className="mt-1"
          data-testid="cat-mode-ai-first"
        />
        <span className="text-sm">
          <span className="font-semibold text-indigo-700">⭐ AI-First (Beta)</span>
          <span className="text-slate-500 ml-2 text-xs">
            single intelligent AI pass with your CoA + prior corrections as context
          </span>
        </span>
      </label>
    </div>
  );
}
