import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Search, X, ArrowRight, User, Briefcase, FileText, Receipt,
  ClipboardList, Users, Sparkles,
} from "lucide-react";

import { api } from "@/lib/api";
import { useCompany } from "@/lib/company";

/**
 * CommandPalette — global ⌘K launcher (Phase B-3 polish, Feb 2026).
 *
 * Mounts at the app root, listens for ⌘K / Ctrl+K anywhere, and
 * offers unified search over customers, projects, invoices, bills,
 * tasks, and employees. Selecting a result navigates directly.
 *
 * Recents (last 5 selections) are cached in localStorage so the
 * palette feels instant on repeat visits.
 */
const KIND_META = {
  customer:  { icon: User,          color: "text-cyan-600",   bg: "bg-cyan-50",   label: "Customer" },
  contact:   { icon: User,          color: "text-slate-500",  bg: "bg-slate-100", label: "Contact"  },
  project:   { icon: Briefcase,     color: "text-amber-600",  bg: "bg-amber-50",  label: "Project"  },
  invoice:   { icon: FileText,      color: "text-indigo-600", bg: "bg-indigo-50", label: "Invoice"  },
  bill:      { icon: Receipt,       color: "text-rose-600",   bg: "bg-rose-50",   label: "Bill"     },
  task:      { icon: ClipboardList, color: "text-emerald-600",bg: "bg-emerald-50",label: "Task"     },
  employee:  { icon: Users,         color: "text-emerald-700",bg: "bg-emerald-50",label: "Employee" },
};

const LS_RECENTS = "axiom_cmd_recents_v1";

export default function CommandPalette() {
  const { currentId } = useCompany();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [cursor, setCursor] = useState(0);
  const [recents, setRecents] = useState(() => readRecents());
  const inputRef = useRef(null);
  const debounceRef = useRef(null);

  // Global ⌘K / Ctrl+K listener.
  useEffect(() => {
    const onKey = (e) => {
      const isMeta = e.metaKey || e.ctrlKey;
      if (isMeta && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen(v => !v);
        return;
      }
      if (e.key === "Escape" && open) {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Autofocus + reset on open.
  useEffect(() => {
    if (open) {
      setQ(""); setResults([]); setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!currentId || !open) return;
    clearTimeout(debounceRef.current);
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const r = await api.get(
          `/companies/${currentId}/search?q=${encodeURIComponent(q)}&limit=8`);
        setResults(r.data?.results || []);
        setCursor(0);
      } catch { setResults([]); }
      finally { setLoading(false); }
    }, 180);
    return () => clearTimeout(debounceRef.current);
  }, [q, currentId, open]);

  const displayList = useMemo(() => {
    if (q.trim().length >= 2) return results;
    return recents;
  }, [q, results, recents]);

  const pick = (r) => {
    // Cache in recents (dedupe by kind+id, cap 5).
    const filtered = (recents || []).filter(x => !(x.kind === r.kind && x.id === r.id));
    const nextRecents = [r, ...filtered].slice(0, 5);
    setRecents(nextRecents);
    writeRecents(nextRecents);
    setOpen(false);
    if (r.url) nav(r.url);
  };

  const onInputKey = (e) => {
    if (!displayList.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor(c => (c + 1) % displayList.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor(c => (c - 1 + displayList.length) % displayList.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(displayList[cursor]);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[1100] flex items-start justify-center pt-24 px-4"
          role="dialog" aria-modal="true"
          data-testid="command-palette">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]"
            onClick={() => setOpen(false)} />
      <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-xl overflow-hidden border border-slate-200">
        <div className="flex items-center gap-2 px-4 py-3 border-b">
          <Search size={16} className="text-slate-400" />
          <input ref={inputRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  onKeyDown={onInputKey}
                  placeholder="Search customers · projects · invoices · bills · tasks · employees"
                  data-testid="command-palette-input"
                  className="flex-1 border-0 focus:ring-0 focus:outline-none text-sm placeholder:text-slate-400" />
          <kbd className="text-[10px] uppercase tracking-wider bg-slate-100 text-slate-500 rounded px-1.5 py-0.5">ESC</kbd>
          <button onClick={() => setOpen(false)}
                  className="p-1 rounded hover:bg-slate-100 text-slate-400"
                  data-testid="command-palette-close">
            <X size={14} />
          </button>
        </div>

        {q.trim().length < 2 && (
          <div className="px-4 pt-3 text-[10px] uppercase tracking-wider text-slate-400 flex items-center gap-1">
            <Sparkles size={10} /> {recents.length ? "Recent" : "Start typing to search"}
          </div>
        )}

        <ul className="max-h-[420px] overflow-y-auto" data-testid="command-palette-results">
          {loading && (
            <li className="px-4 py-6 text-center text-xs text-slate-500">Searching…</li>
          )}
          {!loading && displayList.length === 0 && q.trim().length >= 2 && (
            <li className="px-4 py-8 text-center text-xs text-slate-500">
              No matches for “{q.trim()}”.
              <div className="text-[10px] text-slate-400 italic mt-1">Try a customer name, invoice number, or project keyword.</div>
            </li>
          )}
          {!loading && displayList.map((r, i) => {
            const meta = KIND_META[r.kind] || KIND_META.contact;
            const Icon = meta.icon;
            return (
              <li key={`${r.kind}-${r.id}`}
                  onClick={() => pick(r)}
                  onMouseEnter={() => setCursor(i)}
                  data-testid={`command-palette-result-${r.kind}-${r.id}`}
                  className={`px-4 py-2.5 flex items-center gap-3 cursor-pointer border-l-2 ${
                    cursor === i
                      ? "bg-slate-50 border-emerald-500"
                      : "border-transparent hover:bg-slate-50"
                  }`}>
                <div className={`w-7 h-7 rounded ${meta.bg} ${meta.color} flex items-center justify-center shrink-0`}>
                  <Icon size={13} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-slate-800 truncate">{r.label}</div>
                  <div className="text-[11px] text-slate-500 truncate">{r.sublabel || meta.label}</div>
                </div>
                <span className="text-[9px] uppercase tracking-wider text-slate-400">{meta.label}</span>
                {cursor === i && <ArrowRight size={12} className="text-emerald-600" />}
              </li>
            );
          })}
        </ul>

        <div className="px-4 py-2 border-t bg-slate-50 flex items-center justify-between text-[10px] text-slate-500">
          <span>↑↓ navigate · <kbd className="px-1 rounded bg-white border border-slate-200">Enter</kbd> to open</span>
          <span><kbd className="px-1 rounded bg-white border border-slate-200">⌘K</kbd> anywhere</span>
        </div>
      </div>
    </div>
  );
}

function readRecents() {
  try {
    const s = localStorage.getItem(LS_RECENTS);
    return s ? JSON.parse(s) : [];
  } catch { return []; }
}
function writeRecents(list) {
  try { localStorage.setItem(LS_RECENTS, JSON.stringify(list)); } catch { /* silent */ }
}
