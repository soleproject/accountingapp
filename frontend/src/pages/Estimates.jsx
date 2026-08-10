/**
 * Estimates — list + inline create dialog + convert-to-invoice.
 *
 * This is a minimum-viable-page cut. It intentionally reuses the
 * `contacts` and `items` fetches already loaded by InvoiceEditor
 * style pages elsewhere in the app, but keeps its own local state
 * so it stays a single-file drop-in. Polish (line-editor grid,
 * PDF preview, attachments) can layer on top later without any
 * structural rewrite.
 */
import React, { useEffect, useState, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";
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

const STATUS_TONES = {
  draft:     "bg-slate-100 text-slate-700",
  sent:      "bg-sky-100 text-sky-800",
  accepted:  "bg-emerald-100 text-emerald-800",
  rejected:  "bg-rose-100 text-rose-800",
  closed:    "bg-slate-200 text-slate-600",
  converted: "bg-indigo-100 text-indigo-800",
};


export default function Estimates() {
  const { currentId: cid } = useCompany();
  const nav = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [customers, setCustomers] = useState([]);
  const [items, setItems] = useState([]);
  const [form, setForm] = useState({
    number: "", contact_id: "", issue_date: "",
    expiration_date: "", line: { item_id: "", quantity: 1,
                                    rate: 0, description: "" },
  });

  const load = async () => {
    if (!cid) return;
    setLoading(true);
    try {
      const r = await api.get(`/companies/${cid}/estimates`);
      setRows(r.data.estimates || []);
    } catch (e) {
      toast.error("Failed to load estimates");
    } finally { setLoading(false); }
  };

  const loadRefs = async () => {
    if (!cid) return;
    try {
      const [c, i] = await Promise.all([
        api.get(`/companies/${cid}/contacts`),
        api.get(`/companies/${cid}/items?usage=sales`),
      ]);
      // Contacts endpoint returns ALL types; filter customer-side here.
      const all = c.data.contacts || [];
      setCustomers(all.filter(x =>
        (x.type || "").toLowerCase() === "customer" && x.active !== false,
      ));
      setItems((i.data.items || []).filter(x => x.active !== false));
    } catch (e) {
      // Silent fail on refs — the dropdowns just show empty.
    }
  };

  useEffect(() => { load(); loadRefs(); }, [cid]);

  const openCreate = () => {
    const today = new Date().toISOString().slice(0, 10);
    const inThirty = new Date(Date.now() + 30 * 86400_000)
      .toISOString().slice(0, 10);
    setForm({
      number: "", contact_id: "", issue_date: today,
      expiration_date: inThirty,
      line: { item_id: "", quantity: 1, rate: 0, description: "" },
    });
    setDialogOpen(true);
  };

  const create = async () => {
    if (!form.contact_id) { toast.error("Pick a customer"); return; }
    const item = items.find(x => x.id === form.line.item_id);
    const qty = Number(form.line.quantity) || 1;
    const rate = Number(form.line.rate) || Number(item?.price || 0);
    const payload = {
      number: form.number || "",
      contact_id: form.contact_id,
      contact_name: customers.find(c => c.id === form.contact_id)
                              ?.display_name || "",
      issue_date: form.issue_date,
      expiration_date: form.expiration_date,
      status: "draft",
      line_items: [{
        item_id: form.line.item_id || null,
        item_name: item?.name || "",
        description: form.line.description || item?.name || "",
        quantity: qty, rate,
        amount: Number((qty * rate).toFixed(2)),
      }],
    };
    try {
      await api.post(`/companies/${cid}/estimates`, payload);
      toast.success("Estimate created");
      setDialogOpen(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Create failed");
    }
  };

  const convert = async (row) => {
    if (!window.confirm(`Convert ${row.number || "estimate"} to an invoice?`))
      return;
    try {
      const r = await api.post(
        `/companies/${cid}/estimates/${row.id}/convert`, {});
      toast.success("Invoice created");
      nav(`/invoices/${r.data.id}/edit`);
    } catch (e) {
      toast.error(e.response?.data?.detail || "Convert failed");
    }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete estimate ${row.number || row.id.slice(0,8)}?`))
      return;
    await api.delete(`/companies/${cid}/estimates/${row.id}`);
    toast.success("Deleted");
    load();
  };

  const listing = useMemo(() => rows.map(r => ({
    ...r,
    _statusPill: STATUS_TONES[r.status] || STATUS_TONES.draft,
  })), [rows]);

  return (
    <div className="space-y-6" data-testid="estimates-page">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-semibold text-slate-900 tracking-tight">Estimates</h1>
          <p className="text-slate-500 mt-1 text-sm">
            Quotes sent to customers before you invoice. Convert
            to an invoice with one click when accepted.
          </p>
        </div>
        <Button onClick={openCreate} data-testid="new-estimate-btn"
                className="gap-2">
          <Plus size={16} /> New Estimate
        </Button>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-500 uppercase text-xs">
            <tr>
              <th className="text-left px-4 py-3">Number</th>
              <th className="text-left px-4 py-3">Customer</th>
              <th className="text-left px-4 py-3">Issued</th>
              <th className="text-left px-4 py-3">Expires</th>
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
                No estimates yet. Create your first quote to get started.
              </td></tr>
            )}
            {listing.map(r => (
              <tr key={r.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {r.number || <span className="text-slate-400">—</span>}
                </td>
                <td className="px-4 py-3">{r.contact_name || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.issue_date || "—"}</td>
                <td className="px-4 py-3 text-slate-600">{r.expiration_date || "—"}</td>
                <td className="px-4 py-3 text-right tabular-nums">
                  ${Number(r.total || 0).toFixed(2)}
                </td>
                <td className="px-4 py-3">
                  <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${r._statusPill}`}>
                    {r.status || "draft"}
                  </span>
                </td>
                <td className="px-4 py-3 text-right space-x-2">
                  {r.status !== "converted" && (
                    <button
                      onClick={() => convert(r)}
                      data-testid={`convert-estimate-${r.id}`}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100">
                      <ArrowRight size={12} /> Convert
                    </button>
                  )}
                  {r.status === "converted" && r.converted_invoice_id && (
                    <button
                      onClick={() => nav(`/invoices/${r.converted_invoice_id}/edit`)}
                      className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded border border-slate-200 bg-white text-slate-700 hover:bg-slate-50">
                      <FileText size={12} /> View invoice
                    </button>
                  )}
                  <button
                    onClick={() => remove(r)}
                    data-testid={`delete-estimate-${r.id}`}
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
            <DialogTitle>New Estimate</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Number</Label>
                <Input value={form.number}
                       onChange={e => setForm({ ...form, number: e.target.value })}
                       data-testid="estimate-number-input"
                       placeholder="EST-001" />
              </div>
              <div>
                <Label>Customer</Label>
                <Select value={form.contact_id}
                        onValueChange={v => setForm({ ...form, contact_id: v })}>
                  <SelectTrigger data-testid="estimate-customer-select">
                    <SelectValue placeholder="Pick a customer" />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map(c =>
                      <SelectItem key={c.id} value={c.id}>
                        {c.display_name || c.name}
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
                <Label>Expiration</Label>
                <Input type="date" value={form.expiration_date}
                       onChange={e => setForm({ ...form, expiration_date: e.target.value })} />
              </div>
            </div>
            <div className="border-t border-slate-200 pt-3">
              <Label>Line item</Label>
              <div className="grid grid-cols-4 gap-2 mt-2">
                <Select value={form.line.item_id}
                        onValueChange={v => {
                          const it = items.find(x => x.id === v);
                          setForm({ ...form, line: {
                            ...form.line, item_id: v,
                            rate: it?.price || form.line.rate,
                            description: it?.name || form.line.description,
                          }});
                        }}>
                  <SelectTrigger className="col-span-2">
                    <SelectValue placeholder="Item" />
                  </SelectTrigger>
                  <SelectContent>
                    {items.map(it =>
                      <SelectItem key={it.id} value={it.id}>{it.name}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input type="number" placeholder="Qty"
                       value={form.line.quantity}
                       onChange={e => setForm({ ...form, line: {
                         ...form.line, quantity: e.target.value }})} />
                <Input type="number" placeholder="Rate"
                       value={form.line.rate}
                       onChange={e => setForm({ ...form, line: {
                         ...form.line, rate: e.target.value }})} />
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
            <Button onClick={create} data-testid="save-estimate-btn">Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
