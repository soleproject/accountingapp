import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { TID } from "@/constants/testIds";
import { Users, Building, Briefcase, Shield } from "lucide-react";

export default function SuperadminDash() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get("/admin/overview").then(r => setData(r.data)); }, []);
  if (!data) return <div className="text-slate-500">Loading…</div>;
  const { users, companies, stats } = data;
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="text-indigo-500" size={22} />
        <h1 className="font-heading text-3xl font-bold tracking-tight">Superadmin</h1>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          ["Users", stats.total_users, Users, "#6366F1"],
          ["Accounting Pros", stats.total_pros, Briefcase, "#3B82F6"],
          ["Clients", stats.total_clients, Users, "#10B981"],
          ["Companies", stats.total_companies, Building, "#8B5CF6"],
        ].map(([label, val, Icon, col]) => (
          <div key={label} className="rounded-xl border bg-white p-4">
            <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-slate-500">
              <Icon size={13} style={{ color: col }} /> {label}
            </div>
            <div className="font-heading text-3xl font-bold mt-1">{val}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="rounded-xl border bg-white overflow-hidden">
          <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-600">Users</div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b">
              <tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Email</th><th className="px-3 py-2 text-left">Role</th></tr>
            </thead>
            <tbody>
              {users.map(u => (
                <tr key={u.id} className="border-b">
                  <td className="px-3 py-1.5">{u.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{u.email}</td>
                  <td className="px-3 py-1.5">
                    <span className="text-[10px] uppercase px-1.5 py-0.5 rounded bg-slate-100">{u.role}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rounded-xl border bg-white overflow-hidden">
          <div className="px-4 py-2 bg-slate-50 border-b text-xs uppercase font-semibold text-slate-600">Companies</div>
          <table className="w-full text-sm">
            <thead className="text-xs uppercase text-slate-500 border-b">
              <tr><th className="px-3 py-2 text-left">Name</th><th className="px-3 py-2 text-left">Type</th><th className="px-3 py-2">Onboarded</th></tr>
            </thead>
            <tbody>
              {companies.map(c => (
                <tr key={c.id} className="border-b">
                  <td className="px-3 py-1.5">{c.name}</td>
                  <td className="px-3 py-1.5 text-slate-500">{c.business_type}</td>
                  <td className="px-3 py-1.5 text-center">{c.onboarding_complete ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
