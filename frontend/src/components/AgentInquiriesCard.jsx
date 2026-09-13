/**
 * AgentInquiriesCard — single card that groups every open agent finding
 * for one company by the agent that raised it, and lets the CPA
 * decision each inquiry inline (Apply / Undo / Dismiss / Review) so
 * they don't have to bounce to /cockpit/agents.
 *
 * Mounted on:
 *   • ClientCockpit (`/cockpit/client`)
 *   • ToDo         (`/accounting/todo`)
 *
 * Data source is the same `/api/cockpit/agent-findings?company_id=...`
 * endpoint the Agents page uses. We render a compact per-agent
 * accordion instead of the flat list the Agents page shows.
 */
import React, { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { toast } from "sonner";
import {
  Bot, ChevronDown, ChevronRight, Loader2, RefreshCw, CheckCircle2,
  XCircle, MessageSquareWarning,
} from "lucide-react";

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

// Map finding.kind → colour classes for the tiny severity chip.
const KIND_TONE = {
  contact_mismatch:  "bg-amber-50 border-amber-200 text-amber-800",
  category_mismatch: "bg-blue-50 border-blue-200 text-blue-800",
};

const _pluralize = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export default function AgentInquiriesCard({ companyId, dense = false }) {
  const [busy, setBusy] = useState(true);
  const [findings, setFindings] = useState([]);
  const [templateByKey, setTemplateByKey] = useState({});
  const [cardOpen, setCardOpen] = useState(true);      // whole-card toggle
  const [openAgents, setOpenAgents] = useState({});    // per-agent toggle

  const load = async () => {
    if (!companyId) return;
    setBusy(true);
    try {
      const [f, t] = await Promise.all([
        api.get("/cockpit/agent-findings", { params: { company_id: companyId, status: "open" } }),
        api.get("/cockpit/agents/templates"),
      ]);
      setFindings(f.data?.findings || []);
      const map = {};
      for (const tpl of (t.data?.templates || t.data || [])) {
        if (tpl && tpl.key) map[tpl.key] = tpl;
      }
      setTemplateByKey(map);
    } catch (e) {
      // Non-fatal — quiet failure keeps the card out of the way. The
      // Agents page will surface the full error if there's something wrong.
      console.warn("AgentInquiriesCard load failed", e);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, [companyId]);

  // Group findings by template_key. Preserve created_at desc within each group.
  const groups = useMemo(() => {
    const byKey = new Map();
    for (const f of findings) {
      const k = f.template_key || "__unknown__";
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(f);
    }
    return Array.from(byKey.entries())
      .map(([key, items]) => ({
        key,
        label: templateByKey[key]?.name || key.replace(/_/g, " "),
        items: items.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")),
      }))
      .sort((a, b) => b.items.length - a.items.length || a.label.localeCompare(b.label));
  }, [findings, templateByKey]);

  // Action handlers — mirror the Cockpit Agents page so a decision made
  // here has the same effect as one made there.
  const withReload = async (label, fn) => {
    try {
      await fn();
      await load();
    } catch (e) {
      toast.error(e?.response?.data?.detail || `${label} failed.`);
    }
  };
  const applyContact  = (f) => withReload("Apply",   async () => { await api.post(`/cockpit/agent-findings/${f.id}/apply-contact-fix`);  toast.success("Contact reassigned."); });
  const undoContact   = (f) => withReload("Undo",    async () => { await api.post(`/cockpit/agent-findings/${f.id}/undo-contact-fix`);   toast.success("Reverted."); });
  const applyCategory = (f) => withReload("Apply",   async () => { const r = await api.post(`/cockpit/agent-findings/${f.id}/apply-category-fix`); toast.success(`Reassigned ${r.data?.applied_count || 0} txns.`); });
  const undoCategory  = (f) => withReload("Undo",    async () => { const r = await api.post(`/cockpit/agent-findings/${f.id}/undo-category-fix`);  toast.success(`Reverted ${r.data?.reverted_count || 0} txns.`); });
  const dismiss       = (f) => withReload("Dismiss", async () => { await api.patch(`/cockpit/agent-findings/${f.id}`, { status: "dismissed" }); toast.success("Dismissed."); });

  const total = findings.length;

  // Empty state — hide the card entirely rather than showing "0 inquiries".
  // Rationale: on Client Cockpit / To Do this is one card among many; when
  // there's nothing, it should get out of the way. The card returns to
  // life the next time the audit runs.
  if (!busy && total === 0) return null;

  return (
    <div
      className={`rounded-xl border bg-white ${dense ? "p-3" : "p-4"}`}
      data-testid="agent-inquiries-card"
    >
      <button
        onClick={() => setCardOpen(v => !v)}
        className="w-full flex items-center gap-2 text-left"
        data-testid="agent-inquiries-card-toggle"
      >
        <MessageSquareWarning size={16} className="text-indigo-600 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-[10px] uppercase tracking-widest text-slate-400 font-semibold">
            Agent Inquiries
          </div>
          <div className="text-sm font-semibold text-slate-900">
            {busy
              ? "Loading agent findings…"
              : `${_pluralize(total, "open item")} across ${_pluralize(groups.length, "agent")}`}
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); load(); }}
          className="text-slate-400 hover:text-slate-700 p-1"
          title="Refresh"
          data-testid="agent-inquiries-card-refresh"
          aria-label="Refresh inquiries"
        >
          {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={12} />}
        </button>
        {cardOpen
          ? <ChevronDown size={14} className="text-slate-400 shrink-0" />
          : <ChevronRight size={14} className="text-slate-400 shrink-0" />}
      </button>

      {cardOpen && !busy && (
        <div className="mt-3 space-y-1.5">
          {groups.map((g) => {
            const agentOpen = openAgents[g.key] ?? (groups.length === 1);
            return (
              <div
                key={g.key}
                className="rounded-md border border-slate-200 bg-slate-50/60"
                data-testid={`agent-inquiries-group-${g.key}`}
              >
                <button
                  onClick={() => setOpenAgents(o => ({ ...o, [g.key]: !agentOpen }))}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left hover:bg-slate-100/60"
                  data-testid={`agent-inquiries-group-toggle-${g.key}`}
                  aria-expanded={agentOpen}
                >
                  {agentOpen
                    ? <ChevronDown size={12} className="text-slate-400 shrink-0" />
                    : <ChevronRight size={12} className="text-slate-400 shrink-0" />}
                  <Bot size={12} className="text-indigo-500 shrink-0" />
                  <span className="flex-1 truncate font-medium text-slate-800">{g.label}</span>
                  <span className="text-[11px] font-mono-num text-slate-600 shrink-0">
                    ×{g.items.length}
                  </span>
                </button>
                {agentOpen && (
                  <ul
                    className="divide-y divide-slate-200 border-t border-slate-200 bg-white rounded-b-md"
                    data-testid={`agent-inquiries-items-${g.key}`}
                  >
                    {g.items.map((f) => (
                      <InquiryRow
                        key={f.id}
                        finding={f}
                        onApplyContact={applyContact}
                        onUndoContact={undoContact}
                        onApplyCategory={applyCategory}
                        onUndoCategory={undoCategory}
                        onDismiss={dismiss}
                      />
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// One row per finding — inline decision affordances
// -----------------------------------------------------------------------------

function InquiryRow({
  finding, onApplyContact, onUndoContact, onApplyCategory, onUndoCategory, onDismiss,
}) {
  const [expanded, setExpanded] = useState(false);
  const m = finding.meta || {};
  const kind = finding.kind;
  const applied = !!m.applied;

  const isContact  = kind === "contact_mismatch";
  const isCategory = kind === "category_mismatch";
  const catVerdict = m.verdict || "";
  const hasContactProposal = !!(m.proposed_contact_id || m.would_create_new);
  const catCanApply = isCategory && catVerdict === "hard_wrong"
    && !!m.expected_account_name
    && (m.affected_txn_ids || []).length > 0
    && !(m.on_closed_period === "block" && (m.closed_txn_ids || []).length > 0);
  const catBlockedClosed = isCategory && catVerdict === "hard_wrong"
    && m.on_closed_period === "block" && (m.closed_txn_ids || []).length > 0;

  const chip = KIND_TONE[kind] || "bg-slate-100 border-slate-300 text-slate-700";

  return (
    <li
      className="px-3 py-2 text-[13px] text-slate-700"
      data-testid={`agent-inquiries-item-${finding.id}`}
    >
      <div className="flex items-start gap-2">
        <button
          onClick={() => setExpanded(v => !v)}
          className="text-slate-400 hover:text-slate-700 shrink-0 mt-0.5"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <div className="flex-1 min-w-0">
          <div className="font-medium text-slate-900 line-clamp-2">{finding.title}</div>
          <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2">
            <span className={`text-[10px] px-1.5 py-0.5 rounded uppercase tracking-wider font-semibold border ${chip}`}>
              {kind.replace("_mismatch", "")}
            </span>
            {new Date(finding.created_at).toLocaleDateString()}
            {finding.count > 1 && <span className="font-mono-num">· {finding.count} txns</span>}
          </div>
          {expanded && finding.detail && (
            <div className="mt-1.5 text-[12px] text-slate-600 whitespace-pre-wrap">
              {finding.detail}
            </div>
          )}
          {expanded && isCategory && (m.reasonable_set?.length || m.expected_secondary?.length) > 0 && (
            <div className="mt-1.5 text-[11px] text-slate-500">
              <span className="text-slate-400">Also OK:</span>{" "}
              {(m.reasonable_set || m.expected_secondary || []).slice(0, 6).join(", ")}
            </div>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {/* Contact-mismatch buttons */}
          {isContact && !applied && hasContactProposal && (
            <button
              onClick={() => onApplyContact(finding)}
              className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
              data-testid={`agent-inquiries-apply-contact-${finding.id}`}
            >
              Apply
            </button>
          )}
          {isContact && applied && (
            <button
              onClick={() => onUndoContact(finding)}
              className="text-[11px] px-2 py-1 rounded bg-white border border-slate-300 hover:bg-slate-50"
              data-testid={`agent-inquiries-undo-contact-${finding.id}`}
            >
              Undo
            </button>
          )}
          {/* Category-mismatch buttons */}
          {catCanApply && !applied && (
            <button
              onClick={() => onApplyCategory(finding)}
              className="text-[11px] px-2 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 font-medium"
              data-testid={`agent-inquiries-apply-category-${finding.id}`}
              title={`Reassign ${m.affected_txn_ids?.length || 0} txns to ${m.expected_account_name}`}
            >
              Apply
            </button>
          )}
          {isCategory && applied && (
            <button
              onClick={() => onUndoCategory(finding)}
              className="text-[11px] px-2 py-1 rounded bg-white border border-slate-300 hover:bg-slate-50"
              data-testid={`agent-inquiries-undo-category-${finding.id}`}
            >
              Undo
            </button>
          )}
          {catBlockedClosed && (
            <span
              className="text-[10px] px-2 py-1 rounded bg-amber-100 text-amber-800 border border-amber-300"
              title="Closed period — reopen the period or change the agent's closed-period policy."
              data-testid={`agent-inquiries-blocked-${finding.id}`}
            >
              Closed period
            </span>
          )}
          {/* Non-actionable open link */}
          {!isContact && !isCategory && finding.action_route && (
            <a
              href={finding.action_route}
              className="text-[11px] px-2 py-1 rounded bg-white border border-slate-300 hover:bg-slate-50"
              data-testid={`agent-inquiries-open-${finding.id}`}
            >
              {finding.action_label || "Open"}
            </a>
          )}
          {/* Dismiss — always available (soft-review, uncertain, etc.) */}
          <button
            onClick={() => onDismiss(finding)}
            className="text-slate-400 hover:text-slate-600 p-1"
            title="Dismiss"
            data-testid={`agent-inquiries-dismiss-${finding.id}`}
            aria-label="Dismiss"
          >
            <XCircle size={14} />
          </button>
        </div>
      </div>
    </li>
  );
}
