/**
 * AdminProductLaunches — /admin/product-launches (Round 7.21, Feb 2026).
 * Superadmin-only. Toggle preview / public / subscription mode per
 * product + manage per-product allowlists.
 *
 * Accounting stays locked at `public` — the toggle is rendered but
 * disabled with a tooltip so a superadmin can't accidentally lock
 * every user out of the anchor product.
 */
import { useEffect, useState, useMemo, useCallback } from "react";
import { toast } from "sonner";
import {
  Users, Briefcase, Building2, Calculator, Rocket, Search, X,
  Loader2, Sparkles, Lock,
} from "lucide-react";
import { api } from "@/lib/api";

const PRODUCT_META = {
  crm:        { label: "CRM",        icon: Users,      hex: "#7C3AED" },
  projects:   { label: "Projects",   icon: Briefcase,  hex: "#D97706" },
  team:       { label: "Team",       icon: Building2,  hex: "#059669" },
  accounting: { label: "Accounting", icon: Calculator, hex: "#0891B2" },
};

const MODES = [
  { key: "preview",       label: "Preview",       hint: "Only superadmins + allowlisted testers see this product." },
  { key: "public",        label: "Public",        hint: "Every user has access. Use this for the anchor product." },
  { key: "subscription",  label: "Subscription",  hint: "Requires the paid add-on subscription. (Phase 2 — Stripe wiring pending.)" },
];

export default function AdminProductLaunches() {
  const [launches, setLaunches] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.get("/superadmin/product-launches");
      setLaunches(r.data?.launches || []);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to load product launches");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const setMode = async (pk, mode) => {
    try {
      await api.patch(`/superadmin/product-launches/${pk}`, { mode });
      toast.success(`${PRODUCT_META[pk].label} set to ${mode}`);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Update failed");
    }
  };
  const addUser = async (pk, userId) => {
    try {
      await api.post(`/superadmin/product-launches/${pk}/allowlist`, { user_id: userId });
      toast.success("Added to allowlist");
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Add failed");
    }
  };
  const removeUser = async (pk, userId) => {
    try {
      await api.delete(`/superadmin/product-launches/${pk}/allowlist/${userId}`);
      toast.success("Removed from allowlist");
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Remove failed");
    }
  };

  return (
    <div className="max-w-4xl space-y-6" data-testid="admin-product-launches">
      <div>
        <h1 className="font-heading text-3xl font-bold tracking-tight flex items-center gap-2">
          <Rocket size={22} className="text-fuchsia-600" />
          Product Launch
        </h1>
        <p className="text-slate-500 text-sm mt-1">
          Control which products are visible to which users. Preview mode
          restricts a product to superadmins + explicitly allowlisted
          testers. Public opens the product to everyone. Subscription mode
          gates behind the per-product add-on (Phase 2).
        </p>
      </div>

      {loading ? (
        <div className="rounded-xl border border-dashed p-10 text-center text-slate-500 flex items-center justify-center gap-2">
          <Loader2 size={16} className="animate-spin"/> Loading…
        </div>
      ) : (
        <div className="space-y-4">
          {launches.map(row => (
            <ProductRow
              key={row.product_key} row={row}
              onSetMode={setMode} onAddUser={addUser} onRemoveUser={removeUser}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ProductRow({ row, onSetMode, onAddUser, onRemoveUser }) {
  const meta = PRODUCT_META[row.product_key];
  const Icon = meta?.icon || Sparkles;
  const isAccounting = row.product_key === "accounting";
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5"
              data-testid={`product-launch-row-${row.product_key}`}>
      <div className="flex items-start gap-4">
        <div className="w-10 h-10 rounded-lg flex items-center justify-center"
              style={{ backgroundColor: `${meta?.hex}15`, color: meta?.hex }}>
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">{meta?.label}</h2>
            {isAccounting && (
              <span className="inline-flex items-center gap-1 text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 border border-slate-200 font-semibold">
                <Lock size={9} /> Core
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAccounting
              ? "Accounting is the anchor product — every user must have access. Mode locked to Public."
              : "Preview mode makes this invisible to everyone except superadmins + allowlisted testers."}
          </p>

          {/* Mode segmented control */}
          <div className="mt-4 inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
            {MODES.map(m => {
              const active = row.mode === m.key;
              const disabled = isAccounting && m.key !== "public";
              return (
                <button
                  key={m.key}
                  onClick={() => !disabled && !active && onSetMode(row.product_key, m.key)}
                  disabled={disabled}
                  data-testid={`product-launch-mode-${row.product_key}-${m.key}`}
                  title={disabled ? "Accounting is a core product and cannot be gated." : m.hint}
                  className={`px-3 py-1.5 rounded-md text-xs font-medium transition ${
                    active
                      ? "bg-white shadow-sm text-slate-900 border border-slate-200"
                      : disabled
                        ? "text-slate-300 cursor-not-allowed"
                        : "text-slate-600 hover:text-slate-900"
                  }`}
                >
                  {m.label}
                </button>
              );
            })}
          </div>
          <div className="text-[11px] text-slate-500 mt-2">
            {MODES.find(m => m.key === row.mode)?.hint}
          </div>

          {/* Allowlist section — hidden for Accounting since it's public */}
          {!isAccounting && (
            <AllowlistPicker
              row={row}
              onAddUser={onAddUser}
              onRemoveUser={onRemoveUser}
            />
          )}
        </div>
      </div>
    </section>
  );
}

function AllowlistPicker({ row, onAddUser, onRemoveUser }) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  useEffect(() => {
    if (!debouncedQ) { setResults([]); return; }
    let cancelled = false;
    (async () => {
      setSearching(true);
      try {
        const r = await api.get(`/superadmin/users/search?q=${encodeURIComponent(debouncedQ)}`);
        if (!cancelled) setResults(r.data?.users || []);
      } catch { if (!cancelled) setResults([]); }
      finally { if (!cancelled) setSearching(false); }
    })();
    return () => { cancelled = true; };
  }, [debouncedQ]);

  const chosenIds = useMemo(() => new Set(row.allowlist_user_ids || []), [row]);

  return (
    <div className="mt-5 pt-5 border-t border-slate-100">
      <div className="text-[10px] uppercase tracking-widest text-slate-500 font-semibold mb-2">
        Preview allowlist ({(row.allowlist_users || []).length})
      </div>

      {/* Existing chips */}
      {(row.allowlist_users || []).length === 0 ? (
        <div className="text-xs text-slate-400 italic mb-3">
          No testers yet. Search below to add users who should see this product while it's in preview.
        </div>
      ) : (
        <div className="flex flex-wrap gap-2 mb-4">
          {row.allowlist_users.map(u => (
            <span key={u.id}
                  data-testid={`product-launch-chip-${row.product_key}-${u.id}`}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-violet-50 border border-violet-200 text-xs text-violet-800">
              <span className="font-medium">{u.name || u.email}</span>
              <span className="text-violet-400">·</span>
              <span className="text-[10px] uppercase">{u.role}</span>
              <button onClick={() => onRemoveUser(row.product_key, u.id)}
                      data-testid={`product-launch-chip-remove-${row.product_key}-${u.id}`}
                      className="ml-1 rounded-full hover:bg-violet-100 p-0.5">
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Search box */}
      <div className="relative">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Add user by email or name…"
          data-testid={`product-launch-search-${row.product_key}`}
          className="w-full pl-8 pr-3 py-2 text-sm rounded-md border border-slate-200 bg-white focus:outline-none focus:border-slate-400"
        />
      </div>
      {debouncedQ && (
        <div className="mt-1 rounded-md border border-slate-200 bg-white shadow-sm divide-y divide-slate-100 max-h-64 overflow-y-auto">
          {searching ? (
            <div className="p-3 text-xs text-slate-400 flex items-center gap-2">
              <Loader2 size={12} className="animate-spin"/> Searching…
            </div>
          ) : results.length === 0 ? (
            <div className="p-3 text-xs text-slate-400 italic">No matches.</div>
          ) : (
            results.map(u => {
              const already = chosenIds.has(u.id);
              return (
                <button key={u.id}
                        onClick={() => !already && onAddUser(row.product_key, u.id)}
                        disabled={already}
                        data-testid={`product-launch-search-result-${row.product_key}-${u.id}`}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 disabled:opacity-50 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-sm text-slate-900 truncate">{u.name || "—"}</div>
                    <div className="text-xs text-slate-500 truncate">{u.email}</div>
                  </div>
                  <span className="text-[9px] uppercase tracking-wider text-slate-500 shrink-0">{u.role}</span>
                  {already && <span className="text-[10px] text-violet-600">✓ added</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
