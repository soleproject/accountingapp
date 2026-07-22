import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useBranding, THEME_PRESETS, THEME_TOKEN_META, resolvePalette } from "@/lib/branding";
import { Loader2, Upload, Trash2, Check, Save, Palette, ImageIcon, Link as LinkIcon, RotateCcw } from "lucide-react";

// Pro-firm branding — slice B: 4 logo variants, per-token custom colors
// with a live preview card, and a public sign-in subdomain.
// Reached via the profile chip → Settings in the topbar.
export default function ProSettings() {
  const { user } = useAuth();
  const { branding, refresh } = useBranding();
  const [subdomain, setSubdomain] = useState("");
  const [preset, setPreset] = useState("default");
  // Local, unsaved custom palette overrides. Auto-saved with a short debounce
  // whenever the user edits a color, so there's no separate "Save" step to
  // discover. Debounce lets sliders/pickers dispatch bursts without flooding
  // the API.
  const [custom, setCustom] = useState({});
  // Bumped whenever the user actually edits (not on initial load) — the
  // debounced saver only runs when this changes.
  const [customEditTick, setCustomEditTick] = useState(0);
  const [customSaving, setCustomSaving] = useState(false);
  const [customSavedAt, setCustomSavedAt] = useState(null);
  const [savingSub, setSavingSub] = useState(false);

  useEffect(() => {
    if (!branding) return;
    setSubdomain(branding.signin_subdomain || "");
    setPreset(branding.theme_preset || "default");
    setCustom(branding.theme_custom || {});
  }, [branding]);

  // Debounced auto-save for custom colors. Kicks in only when the user
  // actually edits (customEditTick), not on the initial state hydration
  // from `branding` above.
  useEffect(() => {
    if (customEditTick === 0) return;
    const t = setTimeout(async () => {
      setCustomSaving(true);
      try {
        await api.patch("/pro/branding", { theme_custom: custom });
        await refresh();
        setCustomSavedAt(Date.now());
      } catch (e) {
        toast.error(e.response?.data?.detail || "Save failed");
      } finally { setCustomSaving(false); }
    }, 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customEditTick]);

  if (user && !["pro", "superadmin"].includes(user.role)) {
    return (
      <div className="max-w-2xl mx-auto py-8">
        <div className="rounded-xl border bg-white p-6 text-sm text-slate-600">
          Enterprise settings are available to accounting professionals only.
        </div>
      </div>
    );
  }

  const saveSubdomain = async () => {
    setSavingSub(true);
    try {
      await api.patch("/pro/branding", { signin_subdomain: subdomain });
      await refresh();
      toast.success("Sign-in URL saved.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingSub(false); }
  };

  const pickPreset = async (p) => {
    setPreset(p);
    setCustom({});
    try {
      // Preset change also clears any lingering per-token custom overrides
      // so the new preset shows exactly as designed.
      await api.patch("/pro/branding", { theme_preset: p, theme_custom: {} });
      await refresh();
      toast.success(`Theme set to ${p.charAt(0).toUpperCase() + p.slice(1)}.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    }
  };

  const editToken = (key, val) => {
    setCustom(c => ({ ...c, [key]: val }));
    setCustomEditTick(t => t + 1);
  };

  const clearToken = (key) => {
    setCustom(c => { const n = { ...c }; delete n[key]; return n; });
    setCustomEditTick(t => t + 1);
  };

  const resetTheme = async () => {
    setCustom({});
    try {
      await api.patch("/pro/branding", { theme_custom: {} });
      await refresh();
      toast.success("Reverted to preset defaults.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Reset failed");
    }
  };

  const preview = resolvePalette(preset, custom);
  const logos = branding?.logos || {};

  return (
    <div className="max-w-5xl mx-auto py-8 space-y-6" data-testid="pro-settings">
      <div>
        <h1 className="font-heading text-3xl font-semibold">Enterprise settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Customize how your firm shows up to your team and your clients.
        </p>
      </div>

      {/* ---------- Logos (4 variants) ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-logos-card">
        <div className="flex items-center gap-2 mb-2">
          <ImageIcon size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Logos</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          The <b>light logo</b> is the default; the others are used when the sidebar is dark or collapsed.
          Only the light logo is required.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <LogoSlot variant="logo_light"  label="Logo · light"  bg="bg-slate-50"  url={logos.logo_light}  refresh={refresh} />
          <LogoSlot variant="logo_dark"   label="Logo · dark"   bg="bg-slate-900" url={logos.logo_dark}   refresh={refresh} />
          <LogoSlot variant="icon_light"  label="Icon · light"  bg="bg-slate-50"  url={logos.icon_light}  refresh={refresh} square />
          <LogoSlot variant="icon_dark"   label="Icon · dark"   bg="bg-slate-900" url={logos.icon_dark}   refresh={refresh} square />
        </div>
      </section>

      {/* ---------- Sign-in address ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-signin-card">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Sign-in address</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Give your clients a branded sign-in URL — they log in at your own subdomain with no SmartBooks branding.
          Works instantly once saved.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={subdomain}
            onChange={(e) => setSubdomain(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
            placeholder="acme"
            className="border rounded-md px-3 py-1.5 text-sm w-56"
            data-testid="branding-subdomain-input"
            maxLength={32}
          />
          <span className="text-sm text-slate-500">.{(process.env.REACT_APP_PRIVATE_LABEL_ROOT || "accountingapp.ai")}</span>
          <button
            onClick={saveSubdomain}
            disabled={savingSub}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
            data-testid="branding-subdomain-save"
          >
            {savingSub ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
        {branding?.signin_subdomain && (
          <p className="text-[11px] text-slate-500 mt-2">
            Preview:{" "}
            <a
              href={`/login?firm=${branding.signin_subdomain}`}
              target="_blank"
              rel="noreferrer"
              className="text-cyan-700 hover:underline font-mono-num"
              data-testid="branding-subdomain-preview-link"
            >
              /login?firm={branding.signin_subdomain}
            </a>
          </p>
        )}
        <p className="text-[11px] text-slate-400 mt-2">
          1–32 chars, lowercase letters, digits, and hyphens. Must be unique across all firms.
        </p>
      </section>

      {/* ---------- Theme (presets + custom pickers + live preview) ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-theme-card">
        <div className="flex items-center gap-2 mb-2">
          <Palette size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Theme</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Start from a preset, then tweak any individual color. Applies to primary buttons,
          the sidebar, the top bar, and focus rings — for you, your staff, and your clients.
        </p>

        {/* Presets */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          {Object.entries(THEME_PRESETS).map(([key, colors]) => {
            const isActive = preset === key;
            return (
              <button
                key={key}
                onClick={() => pickPreset(key)}
                data-testid={`branding-theme-${key}`}
                className={`rounded-lg border p-3 text-left transition ${
                  isActive
                    ? "border-slate-900 ring-2 ring-slate-900 ring-offset-1"
                    : "border-slate-200 hover:border-slate-400"
                }`}
              >
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium capitalize">{key}</span>
                  {isActive && <Check size={14} className="text-slate-900" />}
                </div>
                <div className="flex items-center gap-1">
                  <span className="w-6 h-6 rounded border" style={{ background: colors.primary }} />
                  <span className="w-6 h-6 rounded border" style={{ background: colors.accent }} />
                  <span className="w-6 h-6 rounded border" style={{ background: colors.sidebar_bg }} />
                </div>
              </button>
            );
          })}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Custom color pickers */}
          <div className="space-y-2" data-testid="branding-theme-pickers">
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
              Fine-tune
            </div>
            {THEME_TOKEN_META.map(t => (
              <ColorRow
                key={t.key}
                label={t.label}
                token={t.key}
                value={custom[t.key] || preview[t.key]}
                isCustom={Boolean(custom[t.key])}
                onChange={(v) => editToken(t.key, v)}
                onClear={() => clearToken(t.key)}
              />
            ))}
            <div className="flex items-center gap-3 pt-3">
              {customSaving ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500" data-testid="branding-theme-status">
                  <Loader2 size={12} className="animate-spin" /> Saving…
                </span>
              ) : customSavedAt ? (
                <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-700" data-testid="branding-theme-status">
                  <Check size={12} /> Saved. Changes apply everywhere.
                </span>
              ) : (
                <span className="text-[11px] text-slate-400" data-testid="branding-theme-status">
                  Changes save automatically.
                </span>
              )}
              <button
                onClick={resetTheme}
                disabled={Object.keys(custom).length === 0}
                data-testid="branding-theme-reset"
                className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-40"
              >
                <RotateCcw size={13} /> Reset to preset
              </button>
            </div>
          </div>

          {/* Live preview card */}
          <div>
            <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
              Live preview
            </div>
            <ThemePreviewCard palette={preview} logo={logos.logo_light || logos.icon_light} />
          </div>
        </div>
      </section>
    </div>
  );
}

// --- Sub-components -----------------------------------------------------

function LogoSlot({ variant, label, bg, url, refresh, square }) {
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("variant", variant);
      await api.post("/pro/branding/logo", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await refresh();
      toast.success(`${label} updated.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Upload failed");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.delete(`/pro/branding/logo?variant=${variant}`);
      await refresh();
      toast.success(`${label} removed.`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Remove failed");
    } finally { setBusy(false); }
  };

  return (
    <div className="space-y-2" data-testid={`branding-slot-${variant}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`${bg} rounded-md border ${square ? "aspect-square" : "h-24"} flex items-center justify-center overflow-hidden`}>
        {url ? (
          <img src={url} alt={label} className="max-h-[80%] max-w-[80%] object-contain" />
        ) : (
          <span className="text-[11px] text-slate-400">None</span>
        )}
      </div>
      <div className="flex items-center gap-1">
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,image/webp"
          onChange={(e) => upload(e.target.files?.[0])}
          className="hidden"
          data-testid={`branding-slot-input-${variant}`}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={busy}
          className="flex-1 inline-flex items-center justify-center gap-1 px-2 py-1 rounded-md bg-slate-900 text-white text-xs hover:bg-slate-800 disabled:opacity-50"
          data-testid={`branding-slot-upload-${variant}`}
        >
          {busy ? <Loader2 size={11} className="animate-spin" /> : <Upload size={11} />}
          {url ? "Replace" : "Upload"}
        </button>
        {url && (
          <button
            onClick={remove}
            disabled={busy}
            className="p-1.5 rounded-md border text-red-700 hover:bg-red-50 disabled:opacity-50"
            title="Remove"
            data-testid={`branding-slot-remove-${variant}`}
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
    </div>
  );
}

function ColorRow({ label, token, value, isCustom, onChange, onClear }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <input
        type="color"
        value={value || "#000000"}
        onChange={(e) => onChange(e.target.value.toLowerCase())}
        className="w-9 h-9 rounded cursor-pointer border"
        data-testid={`branding-color-${token}`}
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm">{label}</div>
        <div className="text-[11px] font-mono-num text-slate-500">{value || "—"}</div>
      </div>
      {isCustom ? (
        <button
          onClick={onClear}
          className="text-[11px] text-slate-400 hover:text-slate-700"
          title="Revert to preset default"
          data-testid={`branding-color-reset-${token}`}
        >
          reset
        </button>
      ) : (
        <span className="text-[10px] uppercase tracking-widest text-slate-300">preset</span>
      )}
    </div>
  );
}

function ThemePreviewCard({ palette, logo }) {
  // Miniature mock of the app chrome, driven entirely by the palette so
  // users see exactly what their choices will produce before saving.
  return (
    <div className="rounded-lg border overflow-hidden shadow-sm" data-testid="branding-preview-card">
      {/* Fake topbar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b" style={{ background: palette.topbar_bg }}>
        <span className="ml-auto w-6 h-6 rounded-full bg-slate-900 text-white text-[10px] flex items-center justify-center">PP</span>
      </div>
      <div className="flex" style={{ minHeight: 200 }}>
        {/* Fake sidebar */}
        <div className="w-32 shrink-0 border-r p-2 space-y-1" style={{ background: palette.sidebar_bg }}>
          {logo ? (
            <img src={logo} alt="preview" className="h-8 max-w-full object-contain object-left mb-2" />
          ) : (
            <div className="text-[11px] font-heading font-bold mb-2" style={{ color: contrastText(palette.sidebar_bg) }}>
              Your Firm
            </div>
          )}
          <div className="rounded px-2 py-1 text-[11px]" style={{
            background: palette.sidebar_active_bg,
            color: contrastText(palette.sidebar_active_bg),
          }}>
            Dashboard
          </div>
          <div className="px-2 py-1 text-[11px]" style={{ color: contrastText(palette.sidebar_bg) }}>Invoices</div>
          <div className="px-2 py-1 text-[11px]" style={{ color: contrastText(palette.sidebar_bg) }}>Reports</div>
        </div>
        {/* Fake main */}
        <div className="flex-1 p-3 space-y-2 bg-white">
          <div className="text-xs font-semibold text-slate-900">Profit & Loss</div>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md px-2 py-1 text-[11px] text-white"
              style={{ background: palette.primary }}
            >
              New entry
            </button>
            <button
              className="text-[11px] underline"
              style={{ color: palette.accent }}
            >
              View all
            </button>
          </div>
          <div className="text-[10px] text-slate-500">Looks great.</div>
        </div>
      </div>
    </div>
  );
}

// Naive luminance check to keep sidebar text legible against any bg color.
function contrastText(hex) {
  if (!hex || hex.length !== 7) return "#0f172a";
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 128 ? "#0f172a" : "#e2e8f0";
}
