import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Plus, Workflow } from "lucide-react";
import { api } from "@/lib/api";
import { PracticeShell } from "@/components/practice/PracticeShell";
import { UserFilter, ListFooter, HoverPill } from "@/components/practice/listParts";
import { Can } from "@/components/practice/perms";

const fmtDT = (s) => { const d = new Date(s); return `${d.toLocaleDateString("en-US")} ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`; };

export default function PracticeWorkflows() {
  const nav = useNavigate();
  const [rows, setRows] = useState(null);
  const [q, setQ] = useState("");
  const [by, setBy] = useState("");
  const load = () => api.get("/practice/workflows").then(r => setRows(r.data)).catch(() => setRows([]));
  useEffect(() => { load(); }, []);
  const del = async (w) => { if (!window.confirm(`Delete "${w.name}"?`)) return; try { await api.delete(`/practice/workflows/${w.id}`); toast.success("Workflow deleted."); load(); } catch { toast.error("Could not delete"); } };
  const clone = async (w) => { try { await api.post(`/practice/workflows/${w.id}/clone`); toast.success("Workflow cloned."); load(); } catch { toast.error("Could not clone"); } };
  const users = [...new Set((rows || []).map(r => r.created_by).filter(Boolean))];
  const shown = (rows || []).filter(r => !by || r.created_by === by).filter(r => r.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <PracticeShell withRail={false}>
      <div className="space-y-4" data-testid="practice-workflows-page">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3"><Workflow size={30} className="text-slate-600" strokeWidth={1.5} /><h1 className="text-3xl font-bold text-slate-800">Workflows</h1></div>
          <Can feature="Activities (Tasks, Events & Calls)" action="create"><button type="button" onClick={() => nav("/practice/workflows/new")} className="inline-flex items-center gap-1.5 rounded-full bg-[#43A047] px-4 py-1.5 text-sm font-semibold text-white hover:bg-[#388E3C]" data-testid="practice-workflows-new"><Plus size={14} /> New Workflow</button></Can>
        </div>
        <div className="flex items-center gap-2 text-sm text-slate-700"><span>Created By</span><UserFilter testId="practice-workflows-created-by" value={by} onChange={setBy} options={users} /></div>
        <div className="rounded border border-slate-200 bg-white overflow-hidden">
          <div className="flex items-center gap-3 px-3 py-2 border-b border-slate-200"><input value={q} onChange={e => setQ(e.target.value)} placeholder="Search..." className="flex-1 h-8 text-sm outline-none" data-testid="practice-workflows-search" /></div>
          <table className="w-full text-sm">
            <thead><tr className="text-left text-[12px] font-semibold uppercase tracking-wide text-slate-600">{["Name", "Permissions", "Created Date", "Created By"].map(c => <th key={c} className="px-4 py-3">{c}</th>)}</tr></thead>
            <tbody>
              {rows === null ? <tr><td colSpan={4} className="p-8 text-sm text-slate-500">Loading…</td></tr> : shown.length === 0 ? <tr><td colSpan={4} className="py-10 text-center text-sm text-slate-500">No workflows yet.</td></tr> : shown.map(w => (
                <tr key={w.id} className="group relative border-t border-slate-200 hover:bg-slate-100" data-testid={`practice-workflow-row-${w.id}`}>
                  <td className="px-4 py-5 relative">
                    <button type="button" onClick={() => nav(`/practice/workflows/${w.id}/edit`)} className="font-semibold text-[#1E88E5] underline text-[15px]" data-testid={`practice-workflow-link-${w.id}`}>{w.name}</button>
                    <HoverPill testId={`practice-workflow-actions-${w.id}`}>
                      <button type="button" onClick={() => nav(`/practice/workflows/${w.id}/edit`)} className="hover:text-[#1E88E5]" data-testid={`practice-workflow-edit-${w.id}`}>Edit</button>
                      <button type="button" onClick={() => del(w)} className="hover:text-[#1E88E5]" data-testid={`practice-workflow-delete-${w.id}`}>Delete</button>
                      <button type="button" onClick={() => clone(w)} className="hover:text-[#1E88E5]" data-testid={`practice-workflow-clone-${w.id}`}>Clone</button>
                    </HoverPill>
                  </td>
                  <td className="px-4 py-5 text-slate-700">{w.permissions === "Share this workflow with all users" ? "Public" : "Private"}</td>
                  <td className="px-4 py-5 text-slate-700">{fmtDT(w.created_at)}</td>
                  <td className="px-4 py-5"><button type="button" onClick={() => nav("/practice/users/me")} className="text-[#1E88E5] hover:underline">{w.created_by}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <ListFooter count={shown.length} />
        </div>
      </div>
    </PracticeShell>
  );
}
