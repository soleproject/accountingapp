import { toast } from "sonner";

export function renderTpl(text, ctx = {}) {
  return (text || "").replace(/\{([a-z_]+)\}/g, (m, k) => (ctx[k] !== undefined && ctx[k] !== null && ctx[k] !== "" ? String(ctx[k]) : m));
}

export function findTemplate(toolkit, id) {
  return (toolkit?.toolkit?.templates || []).find(t => t.id === id) || null;
}

export function buildMessage(toolkit, templateId, ctx = {}) {
  const t = findTemplate(toolkit, templateId);
  if (!t) return null;
  const merged = { ...(toolkit?.ctx || {}), ...ctx };
  return { ...t, text: renderTpl(t.body, merged), subject: t.subject ? renderTpl(t.subject, merged) : null };
}

export async function copyText(text, label = "Copied") {
  try { await navigator.clipboard.writeText(text); toast.success(label); } catch { toast.error("Couldn't copy"); }
}

export function smsHref(phone, text) {
  const num = (phone || "").replace(/[^\d+]/g, "");
  return `sms:${num}${num ? "?" : "?"}&body=${encodeURIComponent(text)}`.replace("?&", "?");
}

export function mailtoHref(email, subject, text) {
  return `mailto:${email || ""}?subject=${encodeURIComponent(subject || "")}&body=${encodeURIComponent(text)}`;
}

export const STAGE_META = {
  new:          { label: "New lead",     cls: "bg-indigo-50 text-indigo-700 border-indigo-200", col: "bg-slate-100" },
  contacted:    { label: "Contacted",    cls: "bg-blue-50 text-blue-700 border-blue-200",       col: "bg-slate-100" },
  signed_up:    { label: "Signed up",    cls: "bg-cyan-50 text-cyan-700 border-cyan-200",       col: "bg-slate-100" },
  trial_ending: { label: "Trial ending", cls: "bg-orange-50 text-orange-700 border-orange-200", col: "bg-orange-50" },
  paying:       { label: "Paying",       cls: "bg-emerald-50 text-emerald-700 border-emerald-200", col: "bg-emerald-50" },
  lost:         { label: "Lost",         cls: "bg-red-50 text-red-700 border-red-200",          col: "bg-red-50" },
};

export function fmtUsd(cents) {
  return "$" + ((cents || 0) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function ago(iso) {
  if (!iso) return "";
  const d = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86400000));
  return d === 0 ? "today" : `${d}d ago`;
}
