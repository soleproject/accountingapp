/**
 * PlaidItemStartDateEditor — lists all linked Plaid institutions
 * (one row per `plaid_items` doc) and lets the user edit each one's
 * "Download from" cutoff without disconnecting.
 *
 * Behaviour:
 *   * Reads from GET /companies/{cid}/plaid/items on mount.
 *   * Inline pencil → date input pre-populated with the current cutoff.
 *   * "Save" PATCHes /companies/{cid}/plaid/items/{item_id} and shows
 *     a toast plus (when moving to a later date) a confirm dialog
 *     surfacing `already_imported_older_count` so the user knows how
 *     many existing rows will fall behind the new cutoff.
 *   * "None (pull everything)" clears the cutoff.
 *
 * Guardrails inherit from the backend `_safe_import_date` — anything
 * malformed or > 24 months old is silently downgraded there. The
 * date input also enforces the same bounds on the client side.
 */
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { Calendar, Loader2, Pencil, Check, X, Info } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const _pad = (n) => String(n).padStart(2, "0");
const _isoOf = (d) => `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`;
const _maxLookbackIso = () => {
  const d = new Date();
  d.setDate(d.getDate() - 730);
  return _isoOf(d);
};

export default function PlaidItemStartDateEditor({ companyId }) {
  const [items, setItems] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState("");
  const [saving, setSaving] = useState(false);
  // Confirm dialog for "later" moves — the backend tells us how many
  // rows will fall behind and we surface it here before actually
  // committing (already saved by then; the dialog is informational).
  const [confirmState, setConfirmState] = useState(null);

  const bounds = useMemo(() => ({
    min: _maxLookbackIso(),
    max: _isoOf(new Date()),
  }), []);

  const load = async () => {
    if (!companyId) return;
    try {
      const r = await api.get(`/companies/${companyId}/plaid/items`);
      setItems(r.data.items || []);
    } catch (e) {
      // Non-fatal — just don't render the editor if fetch fails.
      setItems([]);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [companyId]);

  const startEdit = (it) => {
    setEditingId(it.item_id);
    setEditValue(it.import_start_date || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValue("");
  };

  const save = async (itemId, valueOverride) => {
    setSaving(true);
    try {
      const value = valueOverride !== undefined ? valueOverride : editValue;
      const r = await api.patch(
        `/companies/${companyId}/plaid/items/${itemId}`,
        { import_start_date: value || null },
      );
      const {
        direction, already_imported_older_count: older,
        import_start_date, previous_import_start_date,
      } = r.data;

      // Optimistically patch the local list.
      setItems((prev) => (prev || []).map(
        (it) => it.item_id === itemId
          ? { ...it, import_start_date }
          : it
      ));
      setEditingId(null);

      // Direction-specific messaging.
      if (direction === "unchanged") {
        toast.info("No change — same date as before");
      } else if (direction === "cleared") {
        toast.success("Cutoff removed — future syncs will pull everything Plaid offers");
      } else if (direction === "earlier") {
        toast.success(
          "New cutoff saved. Note: Plaid will only include older " +
            "transactions on new syncs going forward — existing history " +
            "isn't automatically re-pulled.",
          { duration: 12000 },
        );
      } else if (direction === "set" || direction === "later") {
        if (older > 0) {
          // Show confirm dialog with the count. Purely informational —
          // save has already committed.
          setConfirmState({
            itemId, older, direction, previous_import_start_date,
            import_start_date,
          });
        } else {
          toast.success("Cutoff saved");
        }
      }
    } catch (e) {
      toast.error(e.response?.data?.detail || "Failed to update cutoff");
    } finally {
      setSaving(false);
    }
  };

  if (items === null) {
    return (
      <div className="text-xs text-slate-500 flex items-center gap-2 mt-3">
        <Loader2 size={12} className="animate-spin" /> Loading connections…
      </div>
    );
  }
  if (items.length === 0) return null;

  return (
    <div
      data-testid="plaid-item-start-date-editor"
      className="mt-4 space-y-2"
    >
      <div className="flex items-center gap-2 text-xs font-semibold text-slate-700 uppercase tracking-wide">
        <Calendar size={13} className="text-slate-400" />
        Transaction Download Settings
      </div>
      <div className="rounded-lg border border-slate-200 bg-white overflow-hidden">
        {items.map((it) => {
          const isEditing = editingId === it.item_id;
          return (
            <div
              key={it.item_id}
              data-testid={`plaid-item-row-${it.item_id}`}
              className="flex items-center gap-3 px-4 py-3 border-b border-slate-100 last:border-b-0"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-slate-900 truncate">
                  {it.institution_name}
                </div>
                <div className="text-xs text-slate-500">
                  {it.account_count} account{it.account_count === 1 ? "" : "s"}
                </div>
              </div>

              {isEditing ? (
                <div className="flex items-center gap-2">
                  <input
                    data-testid={`plaid-item-date-input-${it.item_id}`}
                    type="date"
                    min={bounds.min}
                    max={bounds.max}
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    className="px-2 py-1 border border-slate-300 rounded text-sm w-44"
                  />
                  <button
                    data-testid={`plaid-item-date-clear-${it.item_id}`}
                    onClick={() => save(it.item_id, "")}
                    disabled={saving}
                    title="Clear cutoff — pull everything Plaid offers"
                    className="text-xs text-slate-500 hover:text-slate-800 underline"
                  >
                    None
                  </button>
                  <button
                    data-testid={`plaid-item-date-save-${it.item_id}`}
                    onClick={() => save(it.item_id)}
                    disabled={saving}
                    className="p-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white"
                    aria-label="Save"
                  >
                    {saving ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />}
                  </button>
                  <button
                    data-testid={`plaid-item-date-cancel-${it.item_id}`}
                    onClick={cancelEdit}
                    disabled={saving}
                    className="p-1 rounded text-slate-500 hover:bg-slate-100"
                    aria-label="Cancel"
                  >
                    <X size={13} />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-600 font-mono-num">
                    {it.import_start_date
                      ? `Since ${it.import_start_date}`
                      : <span className="italic text-slate-400">All available history</span>}
                  </span>
                  <button
                    data-testid={`plaid-item-date-edit-${it.item_id}`}
                    onClick={() => startEdit(it)}
                    className="p-1 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
                    aria-label="Edit"
                  >
                    <Pencil size={12} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <p className="text-[11px] text-slate-500 flex items-start gap-1">
        <Info size={11} className="mt-0.5 shrink-0" />
        <span>
          Changing to a <b>later date</b> stops pulling older transactions but
          keeps ones already imported. Changing to an <b>earlier date</b> only
          affects future syncs — use the backfill flow to pull the gap.
        </span>
      </p>

      <AlertDialog
        open={!!confirmState}
        onOpenChange={(v) => !v && setConfirmState(null)}
      >
        <AlertDialogContent data-testid="plaid-item-later-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Cutoff saved — a note on older transactions</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-slate-600">
                <p>
                  We&apos;ll keep the{" "}
                  <b>{confirmState?.older?.toLocaleString?.() || confirmState?.older}</b>{" "}
                  transaction{confirmState?.older === 1 ? "" : "s"} you already
                  have from before <b>{confirmState?.import_start_date}</b>.
                  They stay in your ledger — just no <i>new</i> ones from
                  before that date will come in on future syncs.
                </p>
                <p className="text-xs text-slate-500">
                  Want to remove them? Archive them from the Transactions
                  page individually or in bulk.
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction
              data-testid="plaid-item-later-confirm-ok"
              onClick={() => setConfirmState(null)}
            >
              Got it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
