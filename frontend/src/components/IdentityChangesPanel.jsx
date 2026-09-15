import React, { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { History, Undo2, ChevronDown, ChevronRight, GitMerge, Split, Fingerprint, Loader2 } from "lucide-react";

/**
 * Recent Identity Changes — audit log of `contact_identity_events` with
 * one-click undo. Surfaces the moves the Feb-2026 identity harden makes
 * automatically (merchant_entity_id stamps, auto-splits when two real
 * merchants collide on name) plus any manual merges the CPA performed.
 *
 * Collapsed by default. Once expanded, polls once and refreshes on undo.
 */
const KIND_META = {
  merge: {
    label: "Merged",
    icon: GitMerge,
    tone: "text-indigo-700 bg-indigo-50 border-indigo-200",
    describe: (e) => {
      const losers = (e.loser_ids || []).length;
      return `Merged ${losers} contact${losers === 1 ? "" : "s"} into keeper`;
    },
  },
  auto_split: {
    label: "Auto-split",
    icon: Split,
    tone: "text-amber-700 bg-amber-50 border-amber-200",
    describe: (e) => {
      const child = e.evidence?.child_name;
      return child
        ? `Split "${child}" from keeper — different Plaid entity IDs`
        : "Fractured a name collision with different Plaid entity IDs";
    },
  },
  stamp_entity_id: {
    label: "Stamped ID",
    icon: Fingerprint,
    tone: "text-emerald-700 bg-emerald-50 border-emerald-200",
    describe: () => "Stamped Plaid entity ID onto existing contact",
  },
};

const fmtWhen = (iso) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function IdentityChangesPanel({ currentId, onChange }) {
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [undoing, setUndoing] = useState(null); // event_id being undone

  const load = async () => {
    if (!currentId) return;
    setLoading(true);
    try {
      const r = await api.get(
        `/companies/${currentId}/contacts/identity-events`,
        { params: { limit: 25, include_undone: true } }
      );
      setEvents(r.data.events || []);
    } catch {
      /* advisory */
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentId]);

  const doUndo = async (ev) => {
    if (!window.confirm(
      `Reverse this ${(KIND_META[ev.kind]?.label || ev.kind).toLowerCase()}?`
    )) return;
    setUndoing(ev.id);
    try {
      const r = await api.post(
        `/companies/${currentId}/contacts/identity-events/${ev.id}/undo`
      );
      toast.success(
        r.data?.reassigned
          ? `Reversed. ${r.data.reassigned.transactions ?? 0} transaction(s) moved back.`
          : "Reversed."
      );
      await load();
      if (onChange) onChange();
    } catch (err) {
      toast.error(err.response?.data?.detail || "Undo failed");
    } finally {
      setUndoing(null);
    }
  };

  // Show a stub row count on the trigger even before we've loaded, so
  // the panel indicates whether there's anything to see without a click.
  const liveCount = events.filter((e) => !e.undone_at).length;

  return (
    <div className="rounded-xl border bg-white overflow-hidden" data-testid="identity-changes-panel">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center gap-2 px-4 py-3 border-b bg-slate-50/60 hover:bg-slate-100/60 transition-colors text-left"
        data-testid="identity-changes-toggle"
      >
        {open ? <ChevronDown size={14} className="text-slate-500" /> : <ChevronRight size={14} className="text-slate-500" />}
        <History size={14} className="text-slate-500" />
        <span className="font-heading font-semibold text-slate-800 text-sm">
          Recent identity changes
        </span>
        <span className="text-[11px] text-slate-500 ml-1">
          {open
            ? `${events.length} event${events.length === 1 ? "" : "s"}`
            : "Automatic splits, stamped Plaid IDs, and merges — with one-click undo"}
        </span>
        {liveCount > 0 && open && (
          <span className="ml-auto text-[10px] px-2 py-0.5 rounded-full bg-slate-900 text-white">
            {liveCount} active
          </span>
        )}
      </button>

      {open && (
        <div className="divide-y">
          {loading && events.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
              <Loader2 size={12} className="animate-spin" /> Loading…
            </div>
          )}
          {!loading && events.length === 0 && (
            <div className="px-4 py-6 text-center text-xs text-slate-500">
              No identity changes yet. Splits and stamps appear here automatically as Plaid syncs run.
            </div>
          )}
          {events.map((ev) => {
            const meta = KIND_META[ev.kind] || {
              label: ev.kind,
              icon: History,
              tone: "text-slate-700 bg-slate-50 border-slate-200",
              describe: () => ev.kind,
            };
            const Icon = meta.icon;
            const undone = !!ev.undone_at;
            return (
              <div
                key={ev.id}
                className={`px-4 py-3 flex items-start gap-3 ${undone ? "bg-slate-50/40 opacity-70" : ""}`}
                data-testid={`identity-event-${ev.id}`}
              >
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md border text-[10px] font-semibold uppercase tracking-wide shrink-0 mt-0.5 ${meta.tone}`}>
                  <Icon size={11} /> {meta.label}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-800 truncate">
                    {meta.describe(ev)}
                  </div>
                  <div className="text-[11px] text-slate-500 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{fmtWhen(ev.created_at)}</span>
                    <span className="text-slate-300">·</span>
                    <span>by {ev.actor?.replace(/^system:/, "system · ") || "system"}</span>
                    {undone && (
                      <>
                        <span className="text-slate-300">·</span>
                        <span className="text-slate-500 italic">
                          reversed {fmtWhen(ev.undone_at)}
                        </span>
                      </>
                    )}
                  </div>
                </div>
                {!undone && (
                  <button
                    onClick={() => doUndo(ev)}
                    disabled={undoing === ev.id}
                    className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white text-slate-700 text-[11px] hover:bg-slate-50 disabled:opacity-50"
                    data-testid={`identity-event-undo-${ev.id}`}
                    title="Reverse this identity change"
                  >
                    {undoing === ev.id ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />}
                    Reverse
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
