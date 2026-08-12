import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { useAuth } from "@/lib/auth";
import { useBranding, THEME_PRESETS, THEME_TOKEN_META, resolvePalette } from "@/lib/branding";
import PlanComparisonCard from "@/components/PlanComparisonCard";
import { Loader2, Upload, Trash2, Check, Save, Palette, ImageIcon, Link as LinkIcon, RotateCcw, Type, Sparkles, Lock } from "lucide-react";

// Pro-firm branding — slice B: 4 logo variants, per-token custom colors
// with a live preview card, and a public sign-in subdomain.
// Reached via the profile chip → Settings in the topbar.
export default function ProSettings() {
  const { user } = useAuth();
  const { branding, refresh } = useBranding();
  const [subdomain, setSubdomain] = useState("");
  // Private-label display name — used for the browser tab title, outbound
  // email sender name, and every other place the firm wants their own
  // brand instead of "SmartBooks". Blank string clears it (falls back to
  // the pro's own user name via `firm_name_fallback`).
  const [firmName, setFirmName] = useState("");
  const [savingFirmName, setSavingFirmName] = useState(false);
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
  // Public branding config — private-label root domain (e.g. "accountingapp.ai").
  // Fetched from the backend so ops can change it via env var without a rebuild.
  const [labelRoot, setLabelRoot] = useState("accountingapp.ai");
  const [hideDemo, setHideDemo] = useState(false);
  const [savingHideDemo, setSavingHideDemo] = useState(false);
  const [hideSignup, setHideSignup] = useState(false);
  const [savingHideSignup, setSavingHideSignup] = useState(false);
  const [tagline, setTagline] = useState("");
  const [savingTagline, setSavingTagline] = useState(false);
  const [heroImage, setHeroImage] = useState("");
  const [savingHero, setSavingHero] = useState(false);
  const heroFileRef = useRef(null);
  const [buyPageUrl, setBuyPageUrl] = useState("");
  const [savingBuyPage, setSavingBuyPage] = useState(false);
  const [plansOpen, setPlansOpen] = useState(false);
  // Live availability check state: null=idle, "checking", "ok", or an error string.
  const [subStatus, setSubStatus] = useState(null);
  // White-label unlock state — read from branding. Locked pros see
  // greyed-out sections + an "Upgrade to unlock" CTA that opens Stripe.
  const unlocked = !!branding?.whitelabel_unlocked;
  const unlockSource = branding?.whitelabel_source || null;
  const [unlockBusy, setUnlockBusy] = useState(false);
  // Superadmins can always edit branding on any tenant they impersonate.
  const bypassLock = user?.role === "superadmin";
  const isLocked = !unlocked && !bypassLock;

  const startCheckout = async () => {
    setUnlockBusy(true);
    try {
      const r = await api.post("/pro/branding/whitelabel-checkout", {
        origin_url: window.location.origin,
      });
      if (r.data?.already_unlocked) {
        toast.success("Already unlocked — refreshing…");
        await refresh();
        return;
      }
      if (r.data?.checkout_url) {
        window.location.href = r.data.checkout_url;
        return;
      }
      toast.error("Couldn't start checkout.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't start checkout");
    } finally { setUnlockBusy(false); }
  };

  // Post-checkout landing — Stripe returns to /pro/settings?whitelabel=success.
  // Poll /pro/branding a few times so the webhook has a chance to flip the
  // flag, then show a success toast. The URL param is stripped on unmount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const flag = params.get("whitelabel");
    if (!flag) return;
    if (flag === "success") {
      let cancelled = false;
      let tries = 0;
      const poll = async () => {
        if (cancelled) return;
        tries += 1;
        await refresh();
        // eslint-disable-next-line no-await-in-loop
        const r = await api.get("/pro/branding").catch(() => null);
        if (r?.data?.whitelabel_unlocked) {
          toast.success("White-label unlocked — every branding field is live.");
          return;
        }
        if (tries < 6) setTimeout(poll, 1200);
        else toast.message("Payment received — refresh in a moment if branding isn't unlocked yet.");
      };
      poll();
    } else if (flag === "cancel") {
      toast("Checkout canceled — no changes made.");
    }
    // Strip the query param so a browser reload doesn't retrigger.
    const url = new URL(window.location.href);
    url.searchParams.delete("whitelabel");
    url.searchParams.delete("session_id");
    window.history.replaceState(null, "", url.toString());
    return () => {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api.get("/branding/config")
      .then(r => setLabelRoot(r.data?.private_label_root || "accountingapp.ai"))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!branding) return;
    setSubdomain(branding.signin_subdomain || "");
    setFirmName(branding.firm_name_raw || "");
    setPreset(branding.theme_preset || "default");
    setCustom(branding.theme_custom || {});
    setHideDemo(!!branding.hide_demo_accounts);
    setHideSignup(!!branding.hide_signup_link);
    setTagline(branding.signin_tagline || "");
    setHeroImage(branding.signin_hero_image || "");
    setBuyPageUrl(branding.buy_page_url || "");
  }, [branding]);

  // Debounced availability check as the user types. Prevents them saving a
  // taken/invalid subdomain — reflects the same rules the backend enforces.
  useEffect(() => {
    if (!subdomain || subdomain === (branding?.signin_subdomain || "")) {
      setSubStatus(null);
      return;
    }
    setSubStatus("checking");
    const t = setTimeout(async () => {
      try {
        const r = await api.get(`/branding/subdomain-available?sub=${encodeURIComponent(subdomain)}`);
        setSubStatus(r.data?.available ? "ok" : (r.data?.reason || "Unavailable"));
      } catch { setSubStatus("Check failed"); }
    }, 350);
    return () => clearTimeout(t);
  }, [subdomain, branding?.signin_subdomain]);

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

  const isPartner = user?.role === "partner";

  if (user && !["pro", "superadmin", "partner"].includes(user.role)) {
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

  const toggleHideDemo = async (next) => {
    // Optimistic flip so the checkbox stays responsive; roll back on error.
    setHideDemo(next);
    setSavingHideDemo(true);
    try {
      await api.patch("/pro/branding", { hide_demo_accounts: next });
      await refresh();
      toast.success(
        next
          ? "Demo accounts hidden on your sign-in page."
          : "Demo accounts visible on your sign-in page.",
      );
    } catch (e) {
      setHideDemo(!next);
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingHideDemo(false); }
  };

  const toggleHideSignup = async (next) => {
    setHideSignup(next);
    setSavingHideSignup(true);
    try {
      await api.patch("/pro/branding", { hide_signup_link: next });
      await refresh();
      toast.success(
        next
          ? "Signup link hidden — clients onboard by invite only."
          : "Signup link visible on your sign-in page.",
      );
    } catch (e) {
      setHideSignup(!next);
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingHideSignup(false); }
  };

  const saveTagline = async () => {
    setSavingTagline(true);
    try {
      await api.patch("/pro/branding", { signin_tagline: tagline });
      await refresh();
      toast.success(tagline.trim() ? "Custom tagline saved." : "Tagline reset to default.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingTagline(false); }
  };

  const pickHeroImage = () => heroFileRef.current?.click();
  const onHeroFileChange = async (e) => {
    const file = e.target?.files?.[0];
    if (!file) return;
    if (file.size > 2_000_000) {
      toast.error("Hero image too large — keep under 2 MB.");
      e.target.value = "";
      return;
    }
    // Read as a data URL so it round-trips through the JSON patch endpoint.
    const dataUrl = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    setSavingHero(true);
    try {
      await api.patch("/pro/branding", { signin_hero_image: dataUrl });
      setHeroImage(dataUrl);
      await refresh();
      toast.success("Hero image updated.");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Upload failed");
    } finally {
      setSavingHero(false);
      e.target.value = "";
    }
  };
  const clearHeroImage = async () => {
    setSavingHero(true);
    try {
      await api.patch("/pro/branding", { signin_hero_image: "" });
      setHeroImage("");
      await refresh();
      toast.success("Hero image cleared.");
    } catch (err) {
      toast.error(err.response?.data?.detail || "Save failed");
    } finally { setSavingHero(false); }
  };

  const saveBuyPageUrl = async () => {
    setSavingBuyPage(true);
    try {
      await api.patch("/pro/branding", { buy_page_url: buyPageUrl });
      await refresh();
      toast.success(buyPageUrl.trim()
        ? "Buy page URL saved — your referral link now points there."
        : "Buy page URL cleared — referrals go to the platform signup.");
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingBuyPage(false); }
  };

  const saveFirmName = async () => {
    setSavingFirmName(true);
    try {
      await api.patch("/pro/branding", { firm_name: firmName });
      await refresh();
      toast.success(
        firmName.trim()
          ? `Private label name saved — everything now brands as "${firmName.trim()}".`
          : "Private label name cleared — reverting to your account name."
      );
    } catch (e) {
      toast.error(e.response?.data?.detail || "Save failed");
    } finally { setSavingFirmName(false); }
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
        <h1 className="font-heading text-3xl font-semibold">
          {isPartner ? "Partner settings" : "Enterprise settings"}
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          {isPartner
            ? "Customize how your partner brand shows up to your enterprises and their clients — anything you set here cascades down UNLESS an enterprise has its own private-label turned on."
            : "Customize how your firm shows up to your team and your clients."}
        </p>
      </div>

      {/* ---------- Which plan is right for me? — modal launcher ---------- */}
      <section
        className="rounded-xl border border-indigo-100 bg-gradient-to-r from-indigo-50/60 to-white p-4 flex items-center gap-3"
        data-testid="plan-compare-launcher"
      >
        <div className="w-9 h-9 rounded-md bg-indigo-100 flex items-center justify-center shrink-0">
          <Sparkles size={16} className="text-indigo-700" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-semibold text-slate-800">
            Not sure which plan you're on?
          </div>
          <div className="text-xs text-slate-500">
            Side-by-side Free vs White-label features — the checklist for
            unlocking your custom subdomain and fully-branded emails.
          </div>
        </div>
        <button
          onClick={() => setPlansOpen(true)}
          className="shrink-0 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium"
          data-testid="plan-compare-open"
        >
          Compare plans
        </button>
      </section>
      {plansOpen && (
        <PlanComparisonCard
          variant="modal"
          loggedIn={true}
          paidCurrent={unlocked}
          onClose={() => setPlansOpen(false)}
        />
      )}

      {/* ---------- White-label unlock banner ---------- */}
      {isLocked ? (
        <section
          className="rounded-xl border-2 border-dashed border-indigo-200 bg-gradient-to-br from-indigo-50/70 via-white to-fuchsia-50/40 p-5"
          data-testid="whitelabel-lock-banner"
        >
          <div className="flex items-start gap-4">
            <div className="w-10 h-10 rounded-lg bg-indigo-100 flex items-center justify-center shrink-0">
              <Lock size={18} className="text-indigo-700" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-slate-900 mb-0.5">
                White-label is locked on your firm
              </div>
              <div className="text-xs text-slate-600">
                Every field on this page — private label name, subdomain,
                theme, hero image, logos — stays greyed out until you
                unlock white-labeling. Ask your platform admin for a comp
                grant, or upgrade below to unlock instantly.
              </div>
            </div>
            <button
              onClick={startCheckout}
              disabled={unlockBusy}
              className="shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-md bg-indigo-600 hover:bg-indigo-700 text-white text-sm font-medium disabled:opacity-60"
              data-testid="whitelabel-upgrade-btn"
            >
              {unlockBusy ? <Loader2 size={13} className="animate-spin" /> : <Sparkles size={13} />}
              Upgrade to unlock
            </button>
          </div>
        </section>
      ) : unlocked ? (
        <section
          className="rounded-xl border border-emerald-200 bg-emerald-50/60 px-4 py-2.5 flex items-center gap-3"
          data-testid="whitelabel-unlocked-banner"
        >
          <Check size={14} className="text-emerald-700 shrink-0" />
          <div className="text-xs text-emerald-900">
            <b>White-label unlocked</b>
            {unlockSource === "comp"
              ? " — comped by your platform admin. All branding controls are enabled."
              : " — thank you for upgrading! All branding controls are enabled."}
          </div>
        </section>
      ) : null}

      {/* ---------- Private Label Name ---------- */}
      <LockedSection isLocked={isLocked} testId="branding-firm-name-card-locked">
      <section className="rounded-xl border bg-white p-6" data-testid="branding-firm-name-card">
        <div className="flex items-center gap-2 mb-2">
          <Type size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Private label name</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          The name every part of the app uses when it shows your firm — browser tab title,
          outbound email sender ("From" name), client sign-in header, and PDF footers.
          Leave blank to fall back to your account name.
        </p>
        <div className="flex items-center gap-2 flex-wrap">
          <input
            value={firmName}
            onChange={(e) => setFirmName(e.target.value)}
            placeholder={branding?.firm_name_fallback || "e.g. Synergy AI CPAs"}
            className="border rounded-md px-3 py-1.5 text-sm w-80"
            data-testid="branding-firm-name-input"
            maxLength={60}
          />
          <button
            onClick={saveFirmName}
            disabled={savingFirmName || firmName === (branding?.firm_name_raw || "")}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
            data-testid="branding-firm-name-save"
          >
            {savingFirmName ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
        <p className="text-[11px] text-slate-500 mt-2">
          Currently branding as:{" "}
          <span className="font-mono-num text-slate-700" data-testid="branding-firm-name-current">
            {branding?.firm_name || "—"}
          </span>
          {!branding?.firm_name_raw && branding?.firm_name_fallback && (
            <span className="text-slate-400"> (falling back to your account name)</span>
          )}
        </p>
        <p className="text-[11px] text-slate-400 mt-1">
          Up to 60 characters. Changes apply on next page load — no rebuild required.
        </p>
      </section>
      </LockedSection>

      {/* ---------- Sign-in address ---------- */}
      <LockedSection isLocked={isLocked} testId="branding-signin-card-locked">
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
          <span className="text-sm text-slate-500">.{labelRoot}</span>
          <button
            onClick={saveSubdomain}
            disabled={savingSub || (subStatus && subStatus !== "ok" && subStatus !== null && subStatus !== "checking" ? true : false)}
            className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-slate-900 text-white text-sm hover:bg-slate-800 disabled:opacity-50"
            data-testid="branding-subdomain-save"
          >
            {savingSub ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
            Save
          </button>
        </div>
        {/* Live availability + validation feedback under the input */}
        {subStatus === "checking" && (
          <p className="text-[11px] text-slate-500 mt-2">Checking availability…</p>
        )}
        {subStatus === "ok" && (
          <p className="text-[11px] text-emerald-600 mt-2" data-testid="branding-subdomain-available">
            ✓ Available — clients will sign in at{" "}
            <span className="font-mono-num">{subdomain}.{labelRoot}</span>
          </p>
        )}
        {subStatus && subStatus !== "ok" && subStatus !== "checking" && (
          <p className="text-[11px] text-rose-600 mt-2" data-testid="branding-subdomain-error">{subStatus}</p>
        )}
        {branding?.signin_subdomain && (
          <div className="text-[11px] text-slate-500 mt-2 space-y-1">
            <div>
              Live at:{" "}
              <a
                href={`https://${branding.signin_subdomain}.${labelRoot}/login`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-700 hover:underline font-mono-num"
                data-testid="branding-subdomain-live-link"
              >
                {branding.signin_subdomain}.{labelRoot}
              </a>
            </div>
            <div>
              Preview here:{" "}
              <a
                href={`/login?firm=${branding.signin_subdomain}`}
                target="_blank"
                rel="noreferrer"
                className="text-cyan-700 hover:underline font-mono-num"
                data-testid="branding-subdomain-preview-link"
              >
                /login?firm={branding.signin_subdomain}
              </a>
            </div>
          </div>
        )}
        <p className="text-[11px] text-slate-400 mt-2">
          3–40 chars, lowercase letters, digits, and hyphens. Must be unique across all firms.
        </p>
      </section>
      </LockedSection>

      {/* ---------- Sign-in page options ---------- */}
      <LockedSection isLocked={isLocked} testId="branding-signin-options-card-locked">
      <section className="rounded-xl border bg-white p-6" data-testid="branding-signin-options-card">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles size={16} className="text-slate-500" />
          <h2 className="font-heading font-semibold">Sign-in page options</h2>
        </div>
        <p className="text-sm text-slate-500 mb-4">
          Fine-tune what shows on your firm's sign-in page. Applies to
          {branding?.signin_subdomain
            ? <> <span className="font-mono-num text-slate-700">{branding.signin_subdomain}.{labelRoot}</span></>
            : " your private-label root once you set a subdomain above"}.
        </p>
        <label
          className="flex items-start gap-3 cursor-pointer select-none"
          data-testid="branding-hide-demo-accounts-toggle"
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-slate-300 text-cyan-700 focus:ring-cyan-500"
            checked={hideDemo}
            disabled={savingHideDemo}
            onChange={(e) => toggleHideDemo(e.target.checked)}
          />
          <span className="flex-1">
            <span className="block text-sm font-medium text-slate-800">
              Hide "Demo Accounts" block on my sign-in page
            </span>
            <span className="block text-[12px] text-slate-500 mt-0.5">
              Recommended once you have real end-users so the seeded demo shortcut
              (Client / Accounting Pro / Superadmin buttons) doesn't leak.
            </span>
          </span>
        </label>

        <label
          className="flex items-start gap-3 cursor-pointer select-none mt-4 pt-4 border-t border-slate-100"
          data-testid="branding-hide-signup-link-toggle"
        >
          <input
            type="checkbox"
            className="mt-1 h-4 w-4 rounded border-slate-300 text-cyan-700 focus:ring-cyan-500"
            checked={hideSignup}
            disabled={savingHideSignup}
            onChange={(e) => toggleHideSignup(e.target.checked)}
          />
          <span className="flex-1">
            <span className="block text-sm font-medium text-slate-800">
              Hide "Create one" signup link
            </span>
            <span className="block text-[12px] text-slate-500 mt-0.5">
              For invite-only firms — clients only reach the app via magic-link
              invitations, so a public signup path never appears.
            </span>
          </span>
        </label>

        {/* Custom tagline — inline save. */}
        <div className="mt-4 pt-4 border-t border-slate-100" data-testid="branding-tagline-field">
          <label htmlFor="signin-tagline" className="block text-sm font-medium text-slate-800">
            Sign-in tagline
          </label>
          <p className="text-[12px] text-slate-500 mb-2">
            Replaces the default "Welcome back. Let's get to the numbers."
            Leave blank to restore the default. Max 120 characters.
          </p>
          <div className="flex gap-2">
            <input
              id="signin-tagline"
              type="text"
              value={tagline}
              onChange={(e) => setTagline(e.target.value)}
              maxLength={120}
              placeholder="Welcome back. Let's get to the numbers."
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
            />
            <button
              type="button"
              onClick={saveTagline}
              disabled={savingTagline || tagline === (branding?.signin_tagline || "")}
              className="px-3 py-2 rounded-md bg-slate-900 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1"
              data-testid="branding-tagline-save"
            >
              {savingTagline ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>

        {/* Affiliate — firm's buy-page URL. */}
        <div className="mt-4 pt-4 border-t border-slate-100" data-testid="branding-buy-page-field">
          <label htmlFor="buy-page-url" className="block text-sm font-medium text-slate-800">
            Affiliate buy page URL
          </label>
          <p className="text-[12px] text-slate-500 mb-2">
            Where your <span className="font-mono">Refer &amp; earn</span> link
            sends prospects. Paste your own pricing / checkout URL — we'll
            append <span className="font-mono">?ref=&lt;your-slug&gt;</span>
            so purchases are still credited to you. Leave blank to fall
            back to the platform signup page.
          </p>
          <div className="flex gap-2">
            <input
              id="buy-page-url"
              type="url"
              value={buyPageUrl}
              onChange={(e) => setBuyPageUrl(e.target.value)}
              maxLength={500}
              placeholder="https://yourfirm.com/pricing"
              className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm focus:outline-none focus:border-slate-500"
              data-testid="branding-buy-page-input"
            />
            <button
              type="button"
              onClick={saveBuyPageUrl}
              disabled={savingBuyPage || buyPageUrl === (branding?.buy_page_url || "")}
              className="px-3 py-2 rounded-md bg-slate-900 text-white text-sm font-medium disabled:opacity-50 flex items-center gap-1"
              data-testid="branding-buy-page-save"
            >
              {savingBuyPage ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>

        {/* Marketing sidebar hero image. */}
        <div className="mt-4 pt-4 border-t border-slate-100" data-testid="branding-hero-image-field">
          <label className="block text-sm font-medium text-slate-800">
            Marketing sidebar image
          </label>
          <p className="text-[12px] text-slate-500 mb-2">
            Replaces the SmartBooks hero on the left half of the sign-in page
            on desktop. Recommended: 1200×1600 (portrait), under 2 MB, PNG or
            JPG. Clients on mobile see just the form as usual.
          </p>
          <div className="flex items-start gap-3">
            <div className="flex-1">
              {heroImage ? (
                <div className="rounded-md border border-slate-200 overflow-hidden bg-slate-50">
                  <img
                    src={heroImage}
                    alt="Sign-in hero preview"
                    className="w-full max-h-56 object-cover"
                  />
                </div>
              ) : (
                <div className="rounded-md border border-dashed border-slate-300 h-32 flex items-center justify-center text-xs text-slate-400">
                  No custom hero — SmartBooks default renders in its place.
                </div>
              )}
            </div>
            <div className="flex flex-col gap-2 w-32">
              <input
                ref={heroFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onHeroFileChange}
                data-testid="branding-hero-file-input"
              />
              <button
                type="button"
                onClick={pickHeroImage}
                disabled={savingHero}
                className="px-3 py-2 rounded-md bg-slate-900 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                data-testid="branding-hero-upload-btn"
              >
                {savingHero ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {heroImage ? "Replace" : "Upload"}
              </button>
              {heroImage && (
                <button
                  type="button"
                  onClick={clearHeroImage}
                  disabled={savingHero}
                  className="px-3 py-2 rounded-md border border-slate-300 text-slate-700 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-1"
                  data-testid="branding-hero-clear-btn"
                >
                  <Trash2 size={14} /> Clear
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
      </LockedSection>

      {/* ---------- Logos (4 variants) ---------- */}
      <LockedSection isLocked={isLocked} testId="branding-logos-card-locked">
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
      </LockedSection>

      {/* ---------- Theme (presets + custom pickers + live preview) ---------- */}
      <LockedSection isLocked={isLocked} testId="branding-theme-card-locked">
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
      </LockedSection>
    </div>
  );
}

// LockedSection — greys out gated branding sections and swallows pointer
// events when the firm hasn't unlocked white-label. The wrapped children
// still render (so pros can see WHAT they're unlocking) but no click or
// keystroke reaches them.
function LockedSection({ isLocked, testId, children }) {
  if (!isLocked) return <>{children}</>;
  return (
    <div className="relative" data-testid={testId}>
      <div className="pointer-events-none select-none opacity-50 grayscale-[40%]">
        {children}
      </div>
      <div className="absolute top-4 right-4 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-indigo-100 border border-indigo-200 text-[11px] font-medium text-indigo-800 shadow-sm">
        <Lock size={11} /> Locked
      </div>
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
