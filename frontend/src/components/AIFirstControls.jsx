// AI-First Beta — industry template picker + categorization mode toggle.
// Standard onboarding picks the template first; Settings holds the mode.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";

// Reusable industry picker — used both in onboarding (as a required
// step) and in Settings (to change the template later).
//
// When the user picks a NEW slug while a previous industry template
// is already set on the company, we run a dry-run preview against
// the backend. If any old-industry accounts can be safely removed
// (no transactions, journal-entry lines, or rules reference them),
// we surface a confirmation modal listing what will be added AND
// removed, then commit with `confirm_cleanup=true` on OK. If the
// account is in use, we just skip cleanup and additively seed.
export function IndustryTemplatePicker({ companyId, value, onChange, autoSaveOnPick = true }) {
  const [templates, setTemplates] = useState([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(null); // { slug, would_add, would_remove, blocked_remove }
  useEffect(() => {
    api.get("/industry-templates").then(r => setTemplates(r.data?.templates || []));
  }, []);

  const commit = async (slug, { confirmCleanup } = {}) => {
    setSaving(true);
    try {
      const r = await api.post(`/companies/${companyId}/industry-template`, {
        template: slug,
        confirm_cleanup: !!confirmCleanup,
      });
      const seeded = r.data?.seeded_accounts ?? 0;
      const removed = r.data?.removed_accounts ?? 0;
      const renamed = r.data?.renamed_accounts ?? 0;
      const parts = [`Template set · ${seeded} added`];
      if (renamed) parts.push(`${renamed} renamed`);
      if (removed) parts.push(`${removed} removed`);
      toast.success(parts.join(" · "));
      onChange?.(slug);
    } catch (e) {
      toast.error(`Could not set template: ${e.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
      setPreview(null);
    }
  };

  const pick = async (slug) => {
    if (!autoSaveOnPick) { onChange?.(slug); return; }
    // If there's no prior template on the company, or user re-picked
    // the same slug, fall through to a plain additive commit.
    if (!value || value === slug) {
      commit(slug);
      return;
    }
    // Prior template exists and user is switching — ask backend for
    // a preview of what would change.
    setSaving(true);
    try {
      const r = await api.post(`/companies/${companyId}/industry-template`, {
        template: slug, dry_run: true,
      });
      const d = r.data || {};
      const totalChanges =
        (d.would_add?.length || 0) +
        (d.would_remove?.length || 0) +
        (d.would_rename?.length || 0) +
        (d.blocked_remove?.length || 0);
      if (totalChanges === 0) {
        toast.success("Template updated");
        onChange?.(slug);
        setSaving(false);
        return;
      }
      // If there's nothing to remove AND nothing to rename, save
      // additively (adds don't need confirmation).
      if ((d.would_remove?.length || 0) === 0 && (d.would_rename?.length || 0) === 0) {
        setSaving(false);
        await commit(slug); // additive only
        return;
      }
      setPreview({ slug, ...d });
    } catch (e) {
      toast.error(`Could not preview switch: ${e.response?.data?.detail || e.message}`);
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

      {preview && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="industry-switch-confirm">
          <div className="bg-white rounded-lg shadow-xl p-5 max-w-lg w-full max-h-[80vh] overflow-y-auto">
            <div className="font-semibold text-slate-900 text-base mb-1">
              Switch industry template?
            </div>
            <div className="text-sm text-slate-600 mb-3">
              We&apos;ll adjust your Chart of Accounts to fit the new template.
              Manually-added accounts and anything referenced by transactions,
              journal entries, or rules is left untouched.
            </div>

            {preview.would_add?.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold uppercase text-emerald-700 mb-1">
                  Will add ({preview.would_add.length})
                </div>
                <ul className="text-xs text-slate-700 space-y-0.5 max-h-40 overflow-y-auto" data-testid="switch-would-add">
                  {preview.would_add.map(a => (
                    <li key={a.code} className="flex gap-2">
                      <span className="text-slate-400 font-mono">{a.code}</span>
                      <span>{a.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.would_rename?.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold uppercase text-indigo-700 mb-1">
                  Will rename ({preview.would_rename.length})
                </div>
                <ul className="text-xs text-slate-700 space-y-0.5 max-h-40 overflow-y-auto" data-testid="switch-would-rename">
                  {preview.would_rename.map(a => (
                    <li key={a.code} className="flex gap-2 items-baseline">
                      <span className="text-slate-400 font-mono">{a.code}</span>
                      <span className="text-slate-500 line-through">{a.old_name}</span>
                      <span className="text-slate-400">→</span>
                      <span className="text-slate-800">{a.new_name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.would_remove?.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold uppercase text-rose-700 mb-1">
                  Will remove ({preview.would_remove.length}) — unused
                </div>
                <ul className="text-xs text-slate-700 space-y-0.5 max-h-40 overflow-y-auto" data-testid="switch-would-remove">
                  {preview.would_remove.map(a => (
                    <li key={a.code} className="flex gap-2">
                      <span className="text-slate-400 font-mono">{a.code}</span>
                      <span>{a.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {preview.blocked_remove?.length > 0 && (
              <div className="mb-3">
                <div className="text-xs font-semibold uppercase text-slate-500 mb-1">
                  Kept ({preview.blocked_remove.length}) — in use
                </div>
                <ul className="text-xs text-slate-500 space-y-0.5 max-h-24 overflow-y-auto" data-testid="switch-blocked-remove">
                  {preview.blocked_remove.map(a => (
                    <li key={a.code} className="flex gap-2">
                      <span className="font-mono">{a.code}</span>
                      <span>{a.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex gap-2 justify-end mt-4">
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                data-testid="industry-switch-cancel"
                disabled={saving}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => commit(preview.slug, { confirmCleanup: true })}
                className="text-sm px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                data-testid="industry-switch-confirm-btn"
                disabled={saving}
              >
                {saving ? "Switching…" : "Confirm switch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Settings toggle — Standard vs Standard+.
export function CategorizationModeToggle({ companyId, initialMode }) {
  const [mode, setMode] = useState(initialMode || "standard");
  const [saving, setSaving] = useState(false);
  const flip = async (newMode) => {
    if (newMode === mode) return;
    setSaving(true);
    try {
      await api.post(`/companies/${companyId}/categorization-mode`, { mode: newMode });
      setMode(newMode);
      const msg = {
        standard_plus: "Standard+ Beta enabled — next batch will use Standard + Global Vendor Rules",
        standard: "Reverted to Standard categorization",
      }[newMode] || "Categorization mode updated";
      toast.success(msg);
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
          checked={mode === "standard_plus"}
          disabled={saving}
          onChange={() => flip("standard_plus")}
          className="mt-1"
          data-testid="cat-mode-standard-plus"
        />
        <span className="text-sm">
          <span className="font-semibold text-emerald-700">Standard+ (Beta)</span>
          <span className="text-slate-500 ml-2 text-xs">
            Standard cascade + curated global vendor rules for ~500 top merchants
          </span>
        </span>
      </label>

      {mode === "standard_plus" && (
        <StandardPlusApplyButton companyId={companyId} />
      )}

      {/* Directory sweep is available for BOTH modes — the ingest-time
          tier only helps new rows, so all tenants benefit from a
          retroactive apply after this feature shipped. */}
      <StandardDirectoryApplyButton companyId={companyId} />

      <ProvenanceBadgesToggle companyId={companyId} />
    </div>
  );
}

// Provenance-badges toggle — off by default. When enabled, every txn
// row on the Transactions page shows a subtle 8px colored dot next
// to the category name indicating the tier that decided the answer
// (Custom Rule > Rules Miner > Global Rule > PFC > LLM). Advanced
// CPA UX — most end-users leave it off.
function ProvenanceBadgesToggle({ companyId }) {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    api.get(`/companies/${companyId}`).then(r => {
      setEnabled(!!r.data?.show_categorization_source_badges);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, [companyId]);

  const flip = async (next) => {
    setSaving(true);
    try {
      await api.patch(`/companies/${companyId}`, {
        show_categorization_source_badges: next,
      });
      setEnabled(next);
      toast.success(next
        ? "Provenance dots enabled — reload Transactions to see them"
        : "Provenance dots hidden");
    } catch (e) {
      toast.error(`Could not save: ${e.response?.data?.detail || e.message}`);
    } finally {
      setSaving(false);
    }
  };

  if (!loaded) return null;
  return (
    <div className="mt-3 pt-3 border-t border-slate-200">
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={enabled}
          disabled={saving}
          onChange={(e) => flip(e.target.checked)}
          data-testid="provenance-badges-toggle"
        />
        <span className="text-sm">
          <span className="font-semibold text-slate-800">Show categorization source badges</span>
          <span className="text-slate-500 ml-2 text-xs">
            small colored dot on each transaction showing which tier decided the category (advanced)
          </span>
        </span>
      </label>
    </div>
  );
}

// Standard+ retroactive apply button — visible only when the company
// is on Standard+ mode. Runs `/standard-plus/apply-rules` with
// all=true so every existing txn gets re-scanned by Global Rules +
// PFC fallback. Idempotent (tenant priority guard ensures customer's
// custom rules stay intact).
function StandardPlusApplyButton({ companyId }) {
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/standard-plus/apply-rules`,
        { all: true },
      );
      const s = r.data?.stats || {};
      const scanned = r.data?.total_scanned || 0;
      toast.success(
        `Applied to ${scanned} txns — ${s.overridden || 0} categories updated ` +
        `(${s.matched_via_rule || 0} rule matches, ${s.matched_via_pfc || 0} PFC matches, ` +
        `${s.skipped_tenant_priority || 0} preserved from your own rules)`,
        { duration: 8000 },
      );
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-200">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={running}
        data-testid="standard-plus-apply-btn"
        className="text-sm px-3 py-1.5 rounded-md border border-emerald-600 text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
      >
        {running ? "Applying rules…" : "Apply Global Rules to existing transactions"}
      </button>
      <div className="text-[11px] text-slate-500 mt-1">
        Retroactively re-categorizes every transaction using the Standard+ rules and Plaid PFC fallback. Your own custom rules stay untouched.
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="standard-plus-apply-confirm">
          <div className="bg-white rounded-lg shadow-xl p-5 max-w-md w-full">
            <div className="font-semibold text-slate-900 text-base mb-2">Apply Global Rules to all transactions?</div>
            <div className="text-sm text-slate-600 mb-4">
              This will re-scan every transaction on this company and override the category for any row where a Standard+ rule or Plaid PFC has a higher-quality match. Rows already categorized by your own custom rules or merchant memory will be left untouched.
              <br /><br />
              This runs in under 5 seconds for most companies.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                data-testid="standard-plus-apply-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                className="text-sm px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700"
                data-testid="standard-plus-apply-confirm-btn"
              >
                Apply now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


// Standard cascade — Global Contact Directory retroactive apply.
// Runs the 5,221-entry curated directory against every existing txn
// on the company. Fills the gap for rows ingested before the
// directory shipped. Available in BOTH Standard and Standard+ mode
// because the ingest-time tier only helps NEW rows.
function StandardDirectoryApplyButton({ companyId }) {
  const [running, setRunning] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const run = async () => {
    setConfirmOpen(false);
    setRunning(true);
    try {
      const r = await api.post(
        `/companies/${companyId}/standard/apply-directory`,
        {},
      );
      const s = r.data?.stats || {};
      toast.success(
        `Scanned ${s.scanned || 0} txns — ${s.overridden || 0} categories updated ` +
        `via the Global Contact Directory (${s.skipped_tenant_priority || 0} preserved ` +
        `from your own rules, ${s.skipped_no_hint || 0} unknown merchants left alone)`,
        { duration: 9000 },
      );
    } catch (e) {
      toast.error(`Failed: ${e.response?.data?.detail || e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="mt-3 pt-3 border-t border-slate-200">
      <button
        type="button"
        onClick={() => setConfirmOpen(true)}
        disabled={running}
        data-testid="standard-directory-apply-btn"
        className="text-sm px-3 py-1.5 rounded-md border border-violet-600 text-violet-700 hover:bg-violet-50 disabled:opacity-50"
      >
        {running ? "Applying directory…" : "Apply Global Contact Directory to existing transactions"}
      </button>
      <div className="text-[11px] text-slate-500 mt-1">
        Retroactively categorizes existing rows by matching each merchant against our curated 5,000+ well-known-companies directory. Skips anything already categorized by your custom rules, merchant memory, or manual overrides.
      </div>

      {confirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" data-testid="standard-directory-apply-confirm">
          <div className="bg-white rounded-lg shadow-xl p-5 max-w-md w-full">
            <div className="font-semibold text-slate-900 text-base mb-2">Apply Global Contact Directory to all transactions?</div>
            <div className="text-sm text-slate-600 mb-4">
              This scans every transaction on this company and re-categorizes any AI-decided or Uncategorized row where the merchant matches an entry in our curated 5,000+ directory. Your custom rules, learned rules, merchant memory, and manual overrides are never touched.
              <br /><br />
              Safe to run repeatedly — it's idempotent.
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="text-sm px-3 py-1.5 rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50"
                data-testid="standard-directory-apply-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={run}
                className="text-sm px-3 py-1.5 rounded-md bg-violet-600 text-white hover:bg-violet-700"
                data-testid="standard-directory-apply-confirm-btn"
              >
                Apply now
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
