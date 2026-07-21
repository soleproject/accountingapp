import { useEffect, useRef, useState } from "react";
import { Outlet, Link } from "react-router-dom";
import Sidebar from "./Sidebar";
import AiPanel from "./AiPanel";
import { useCompany } from "@/lib/company";
import { useAuth } from "@/lib/auth";
import { TID } from "@/constants/testIds";
import { ChevronDown, LogOut, MessageSquare, Settings2, User, KeyRound, Loader2, X } from "lucide-react";
import { Toaster, toast } from "sonner";
import { AiFocusProvider } from "@/lib/aiFocus";
import { useActionListener } from "@/lib/createBus";
import { api } from "@/lib/api";

function CompanySwitcher() {
  const { companies, current, switchCompany } = useCompany();
  const [open, setOpen] = useState(false);
  if (!companies?.length) return null;
  return (
    <div className="relative">
      <button
        data-testid={TID.companySwitcher}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-200 hover:border-slate-300 bg-white text-sm"
      >
        <span className="font-heading font-semibold">{current?.name || "Select company"}</span>
        <ChevronDown size={14} className="text-slate-500" />
      </button>
      {open && (
        <div className="absolute z-50 top-full mt-1 w-72 rounded-md border bg-white shadow-lg py-1">
          {companies.map(c => (
            <button
              key={c.id}
              data-testid={`${TID.companySwitcherOption}-${c.id}`}
              onClick={() => { switchCompany(c.id); setOpen(false); }}
              className="w-full text-left px-3 py-2 hover:bg-slate-50 text-sm"
            >
              <div className="font-medium">{c.name}</div>
              <div className="text-[11px] text-slate-500">{c.business_type || "—"}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileMenu() {
  // Profile chip in the topbar. Replaces the previous "email · sign out"
  // strip with an avatar-initials pill that opens a dropdown for Settings,
  // Change password, and Sign out. Pros/superadmins additionally get a
  // link to the enterprise-branding settings surface.
  const { user, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);
  const ref = useRef(null);

  // Close on outside-click / Escape — cheap dropdown ergonomics.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!user) return null;
  const name = user.name || user.email?.split("@")[0] || "User";
  const initials = name.split(/\s+/).map(s => s[0]).slice(0, 2).join("").toUpperCase();
  const isPro = ["pro", "superadmin"].includes(user.role);

  return (
    <div className="relative" ref={ref}>
      <button
        data-testid="profile-menu-trigger"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-2 px-2 py-1 rounded-full hover:bg-slate-100 transition"
        title={user.email}
      >
        <span className="w-8 h-8 rounded-full bg-slate-900 text-white text-xs font-semibold flex items-center justify-center">
          {initials || <User size={14} />}
        </span>
        <span className="hidden md:flex flex-col items-start leading-tight">
          <span className="text-xs font-semibold text-slate-900">{name}</span>
          <span className="text-[10px] text-slate-500">{user.email}</span>
        </span>
        <ChevronDown size={14} className="text-slate-500" />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1 w-64 rounded-md border bg-white shadow-lg py-1 z-50"
          data-testid="profile-menu"
        >
          <div className="px-3 py-2 border-b">
            <div className="text-sm font-semibold truncate">{name}</div>
            <div className="text-[11px] text-slate-500 truncate">{user.email}</div>
            <div className="text-[10px] uppercase tracking-widest text-slate-400 mt-1">
              {user.role || "user"}
            </div>
          </div>
          {isPro && (
            <Link
              to="/pro/settings"
              onClick={() => setOpen(false)}
              data-testid="profile-menu-settings"
              className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"
            >
              <Settings2 size={14} className="text-slate-500" /> Settings
            </Link>
          )}
          <button
            onClick={() => { setOpen(false); setPwOpen(true); }}
            data-testid="profile-menu-change-password"
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50"
          >
            <KeyRound size={14} className="text-slate-500" /> Change password
          </button>
          <button
            data-testid={TID.signoutBtn}
            onClick={logout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-slate-50 text-red-700"
          >
            <LogOut size={14} /> Sign out
          </button>
        </div>
      )}
      {pwOpen && <ChangePasswordModal onClose={() => setPwOpen(false)} />}
    </div>
  );
}


function ChangePasswordModal({ onClose }) {
  // Small self-service password rotation modal. Verifies the current
  // password server-side (backend uses bcrypt), so a leaked JWT alone
  // can't hijack this flow. Existing sessions stay valid by design —
  // no forced logout after rotation.
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (next.length < 8) return toast.error("New password must be 8+ characters.");
    if (next !== confirm) return toast.error("New passwords don't match.");
    if (next === current) return toast.error("New password must be different from your current one.");
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      toast.success("Password updated.");
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.detail || "Couldn't change password.");
    } finally { setBusy(false); }
  };
  return (
    <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-2xl w-full max-w-md"
        onClick={(e) => e.stopPropagation()}
        data-testid="change-password-modal"
      >
        <div className="flex items-center justify-between px-5 py-3 border-b">
          <h3 className="font-heading font-semibold flex items-center gap-2">
            <KeyRound size={16} className="text-cyan-600" /> Change password
          </h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-slate-100"><X size={14} /></button>
        </div>
        <div className="p-5 space-y-3 text-sm">
          <div>
            <label className="text-xs text-slate-600">Current password</label>
            <input
              type="password" value={current} onChange={(e) => setCurrent(e.target.value)}
              autoFocus
              data-testid="cp-current"
              className="w-full mt-1 border rounded-md px-3 py-2"
            />
          </div>
          <div>
            <label className="text-xs text-slate-600">New password</label>
            <input
              type="password" value={next} onChange={(e) => setNext(e.target.value)}
              data-testid="cp-new"
              className="w-full mt-1 border rounded-md px-3 py-2"
              placeholder="8+ characters"
            />
          </div>
          <div>
            <label className="text-xs text-slate-600">Confirm new password</label>
            <input
              type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              data-testid="cp-confirm"
              className="w-full mt-1 border rounded-md px-3 py-2"
            />
          </div>
        </div>
        <div className="px-5 py-3 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md border text-sm">Cancel</button>
          <button
            onClick={submit} disabled={busy || !current || !next || !confirm}
            data-testid="cp-submit"
            className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-md bg-cyan-600 text-white text-sm disabled:opacity-50 hover:bg-cyan-700"
          >
            {busy && <Loader2 size={13} className="animate-spin" />} Update password
          </button>
        </div>
      </div>
    </div>
  );
}

export default function Layout() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [aiCollapsed, setAiCollapsed] = useState(false);
  // Row-level "Ask AI" buttons emit `ai-open` — expand the panel when it fires.
  useActionListener("ai-open", () => setAiCollapsed(false));

  return (
    <AiFocusProvider>
      <div className="flex h-screen overflow-hidden bg-[#F5F6F8]">
        <Sidebar collapsed={sidebarCollapsed} onToggle={() => setSidebarCollapsed(!sidebarCollapsed)} />

        <div className="flex-1 flex flex-col min-w-0">
          <header className="h-16 shrink-0 border-b bg-white flex items-center px-6 gap-4">
            <CompanySwitcher />
            <div className="ml-auto flex items-center gap-3">
              {aiCollapsed && (
                <button
                  data-testid={TID.aiPanelToggle + "-header"}
                  onClick={() => setAiCollapsed(false)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-slate-900 text-white text-xs"
                >
                  <MessageSquare size={13} /> Assistant
                </button>
              )}
              <ProfileMenu />
            </div>
          </header>

          <main className="flex-1 overflow-auto p-6 md:p-8">
            <Outlet />
          </main>
        </div>

        <AiPanel collapsed={aiCollapsed} onToggle={() => setAiCollapsed(!aiCollapsed)} />
        <Toaster position="bottom-right" />
      </div>
    </AiFocusProvider>
  );
}
