import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useBranding, THEME_PRESETS } from "@/lib/branding";
import { Loader2, Upload, Trash2, Check, Save, Palette, ImageIcon, Link as LinkIcon } from "lucide-react";

// Pro-firm branding page. Reached via the profile chip in the topbar.
// Slice A scope: single light logo, sign-in subdomain, 4 preset themes.
export default function ProSettings() {
  const { user } = useAuth();
  const { branding, refresh } = useBranding();
  const [subdomain, setSubdomain] = useState("");
  const [preset, setPreset] = useState("default");
  const [savingSub, setSavingSub] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileRef = useRef(null);

  // Sync local form state to branding whenever it (re)loads. We stash
  // subdomain and theme in local state so users can preview/edit without
  // mutating the shared context.
  useEffect(() => {
    if (!branding) return;
    setSubdomain(branding.signin_subdomain || "");
    setPreset(branding.theme_preset || "default");
  }, [branding]);

  // Gate the whole page — this settings surface is pro-only.
  if (user && !["pro", "superadmin"].includes(user.role)) {
    return (
      <div className="max-w-2xl mx-auto py-8">
        <div className="rounded-xl border bg-white p-6 text-sm text-slate-600">
          Enterprise settings are available to accounting professionals only.
        </div>
      </div>
    );
  }

  const onLogoChange = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      await api.post("/pro/branding/logo", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      await refresh();
      toast.success("Logo updated — you'll see it in the sidebar.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Upload failed");
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removeLogo = async () => {
    setRemoving(true);
    try {
      await api.delete("/pro/branding/logo");
      await refresh();
      toast.success("Logo removed.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Remove failed");
    } finally {
      setRemoving(false);
    }
  };

  const saveSubdomain = async () => {
    setSavingSub(true);
    try {
      await api.patch("/pro/branding", { signin_subdomain: subdomain });
      await refresh();
      toast.success("Sign-in URL saved.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally {
      setSavingSub(false);
    }
  };

  const pickPreset = async (p) => {
    setPreset(p);
    try {
      await api.patch("/pro/branding", { theme_preset: p });
      await refresh();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    }
  };

  const logoUrl = branding?.logo_data_url;

  return (
    <div className="max-w-4xl mx-auto py-8 space-y-6" data-testid="pro-settings">
      <div>
        <h1 className="font-heading text-3xl font-semibold">Enterprise settings</h1>
        <p className="text-sm text-slate-500 mt-1">
          Customize how your firm shows up to your team and your clients.
        </p>
      </div>

      {/* ---------- Logo ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-logo-card">
        <div className="flex items-center gap-2 mb-2">
          <ImageIcon size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Logo</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Shown in the sidebar in place of "Axiom LEDGER" for you, your staff, and every client of your firm.
          PNG, JPG, SVG, or WebP up to 500 KB.
        </p>
        <div className="flex items-center gap-6 flex-wrap">
          <div className="w-40 h-20 rounded-md border bg-slate-50 flex items-center justify-center overflow-hidden">
            {logoUrl ? (
              <img src={logoUrl} alt="Logo preview" className="max-h-16 max-w-[140px] object-contain" />
            ) : (
              <span className="text-xs text-slate-400">No logo yet</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/svg+xml,image/webp"
              onChange={(e) => onLogoChange(e.target.files?.[0])}
              className="hidden"
              data-testid="branding-logo-input"
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
              data-testid="branding-logo-upload"
            >
              {uploading ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
              {logoUrl ? "Replace" : "Upload logo"}
            </button>
            {logoUrl && (
              <button
                onClick={removeLogo}
                disabled={removing}
                className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                data-testid="branding-logo-remove"
              >
                {removing ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
                Remove
              </button>
            )}
          </div>
        </div>
      </section>

      {/* ---------- Sign-in URL ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-signin-card">
        <div className="flex items-center gap-2 mb-2">
          <LinkIcon size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Sign-in address</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Give your clients a branded sign-in URL — they log in at your own subdomain with no Axiom branding.
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
          <span className="text-sm text-slate-500">.axiomledger.ai</span>
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
        <p className="text-[11px] text-slate-400 mt-2">
          1–32 chars, lowercase letters, digits, and hyphens. Must be unique across all firms.
        </p>
      </section>

      {/* ---------- Theme presets ---------- */}
      <section className="rounded-xl border bg-white p-6" data-testid="branding-theme-card">
        <div className="flex items-center gap-2 mb-2">
          <Palette size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Theme</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Pick an accent palette. Applies to primary buttons and focus rings across your firm and your clients' apps.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
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
                </div>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
