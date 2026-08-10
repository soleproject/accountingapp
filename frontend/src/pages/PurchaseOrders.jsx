/**
 * Purchase Orders — list + inline create + convert-to-bill.
 * Mirror of Estimates.jsx for the vendor side.
 */
import React, { useEffect, useState, useMemo } from "react";
import axios from "axios";
import { useNavigate } from "react-router-dom";
import { useCompany } from "../contexts/CompanyContext";
import { toast } from "sonner";
import { Plus, FileText, ArrowRight, Trash2 } from "lucide-react";
import { Button } from "../components/ui/button";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "../components/ui/select";

const API = process.env.REACT_APP_BACKEND_URL;

const STATUS_TONES = {
  open:      "bg-sky-100 text-sky-800",
  closed:    "bg-slate-200 text-slate-600",
  converted: "bg-indigo-100 text-indigo-800",
};


export default function PurchaseOrders() {
  const { activeCompanyId } = useCompany();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [vendors, setVendors] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState({
    number: "", contact_id: "", issue_date: "",
    due_date: "",
    line: { expense_account_id: "", amount: 0, description: "" },
  });

  const cid = activeCompanyId;
  const auth = { Authorization: `Bearer ${localStorage.getItem("token")}` };

  const load = async () => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await axios.get(
        `${API}/api/companies/${cid}/purchase-orders`,
        { headers: auth });
      setRows(r.data.purchase_orders || []);
    } catch (e) {
      toast.error("Failed to load purchase orders");
    } finally { setLoading(false); }
  };

  const loadRefs = async () => {
    if (!cid) return;
    const [v, a] = await Promise.all([
      axios.get(`${API}/api/companies/${cid}/contacts?type=vendor`,
        { headers: auth }),
      axios.get(`${API}/api/companies/${cid}/accounts`, { headers: auth }),
    ]);
    setVendors(v.data.contacts || []);
    // Only expense-type accounts make sense for PO lines.
    const acs = (a.data.accounts || []).filter(x =>
      (x.type || "").toLowerCase() === "expense" && x.active !== false,
    );
    setAccounts(acs);
  };

  useEffect(() => { load(); loadRefs(); }, [cid]);

  const openCreate = () => {
    const today = new Date().toISOString().slice(0, 10);
    const inThirty = new Date(Date.now() + 30 * 86400_000)
      .toISOString().slice(0, 10);
    setForm({
      number: "", contact_id: "", issue_date: today, due_date: inThirty,
      line: { expense_account_id: "", amount: 0, description: "" },
    });
    setDialogOpen(true);
  };

  const create = async () => {
    if (!form.contact_id) { toast.error("Pick a vendor"); return; }
    const amt = Number(form.line.amount) || 0;
    const payload = {
      number: form.number || "",
      contact_id: form.contact_id,
      contact_name: vendors.find(v => v.id === form.contact_id)
                            ?.display_name || "",
      issue_date: form.issue_date,
      due_date: form.due_date,
      status: "open",
      line_items: [{
        expense_account_id: form.line.expense_account_id || null,
        description: form.line.description || "",
        amount: amt,
      }],
    };
    try {
      await axios.post(`${API}/api/companies/${cid}/purchase-orders`,
        payload, { headers: auth });
      toast.success("Purchase order created");
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Create failed");
    }
  };

  const convert = async (row) => {
    if (!window.confirm(`Convert ${row.number || "PO"} to a bill?`))
      return;
    try {
      const r = await axios.post(
        `${API}/api/companies/${cid}/purchase-orders/${row.id}/convert`,
        {}, { headers: auth });
      toast.success("Bill created");
      nav(`/bills/${r.data.id}/edit`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Convert failed");
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete PO ${row.number || row.id.slice(0,8)}?`))
      return;
    await axios.delete(
      `${API}/api/companies/${cid}/purchase-orders/${row.id}`,
      { headers: auth });
    toast.success("Deleted");
    load();
  };

  const listing = useMemo(() => rows.map(r => ({
    ...r,
    _statusPill: STATUS_TONES[r.status] || STATUS_TONES.open,
  })), [rows]);

  return (
    <div className="space-y-6" data-testid="purchase-orders-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">Purchase Orders</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Commitments sent to vendors before you receive their bill.
            Convert to a bill with one click when the goods arrive.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="new-po-btn" className="gap-2">
          <Plus size={16} /> New PO
        </Button>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Number</th>
              <th className="text-left px-4 py-3">Vendor</th>
              <th className="text-left px-4 py-3">Issued</th>
              <th className="text-left px-4 py-3">Due</th>
              <th className="text-right px-4 py-3">Total</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading && (
              <tr><td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                Loading…
              </td></tr>
            )}
            {!loading && listing.length === 0 && (
              <tr><td colSpan={7} className="px-4 py-12 text-center text-slate-400">
                No purchase orders yet.
              </td></tr>
            )}
            {listing.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {r.number || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">{r.contact_name || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.issue_date || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.due_date || "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${Number(r.total || 0).toFixed(2)}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r._statusPill}`}>
                    {r.status || "open"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  {r.status !== "converted" && (
                    <button
                      onClick={() => convert(r)}
                      data-testid={`convert-po-${r.id}`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100">
                      <ArrowRight size={12} /> Convert
                    </button>
                  )}
                  {r.status === "converted" && r.converted_bill_id && (
                    <button
                      onClick={() => nav(`/bills/${r.converted_bill_id}/edit`)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                      <FileText size={12} /> View bill
                    </button>
                  )}
                  <button
                    onClick={() => remove(r)}
                    data-testid={`delete-po-${r.id}`}
                    className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-rose-200 bg-white text-rose-700 hover:bg-rose-50">
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>New Purchase Order</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Number</Label>
                <Input value={form.number}
                       onChange={e => setForm({ ...form, number: e.target.value })}
                       data-testid="po-number-input"
                       placeholder="PO-001" />
              </div>
              <div>
                <Label>Vendor</Label>
                <Select value={form.contact_id}
                        onValueChange={v => setForm({ ...form, contact_id: v })}>
                  <SelectTrigger data-testid="po-vendor-select">
                    <SelectValue placeholder="Pick a vendor" />
                  </SelectTrigger>
                  <SelectContent>
                    {vendors.map(v =>
                      <SelectItem key={v.id} value={v.id}>
                        {v.display_name || v.name}
                      </SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Issue date</Label>
                <Input type="date" value={form.issue_date}
                       onChange={e => setForm({ ...form, issue_date: e.target.value })} />
              </div>
              <div>
                <Label>Due</Label>
                <Input type="date" value={form.due_date}
                       onChange={e => setForm({ ...form, due_date: e.target.value })} />
              </div>
            </div>
            <div className="border-t border-slate-200 pt-3">
              <Label>Line item</Label>
              <div className="grid grid-cols-3 gap-2 mt-2">
                <Select value={form.line.expense_account_id}
                        onValueChange={v => setForm({ ...form, line: {
                          ...form.line, expense_account_id: v }})}>
                  <SelectTrigger className="col-span-2">
                    <SelectValue placeholder="Expense account" />
                  </SelectTrigger>
                  <SelectContent>
                    {accounts.map(a =>
                      <SelectItem key={a.id} value={a.id}>{a.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="number" placeholder="Amount"
                       value={form.line.amount}
                       onChange={e => setForm({ ...form, line: {
                         ...form.line, amount: e.target.value }})} />
              </div>
              <Input value={form.line.description}
                     className="mt-2"
                     placeholder="Description"
                     onChange={e => setForm({ ...form, line: {
                       ...form.line, description: e.target.value }})} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button onClick={create} data-testid="save-po-btn">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
