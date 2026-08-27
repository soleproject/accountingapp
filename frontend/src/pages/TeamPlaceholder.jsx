import { Building2, Sparkles, Users, ClipboardList, CalendarDays, Timer, Megaphone } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * Team landing — placeholder for Phase B (employees, tasks by
 * person, team calendar, assignments, and basic time tracking).
 */
const FEATURES = [
  { icon: Users,       title: "Employees",       desc: "Directory of everyone on the team. Each is a user with role-based access — Owner, Manager, Bookkeeper, Field Employee." },
  { icon: ClipboardList,title: "Assignments",   desc: "Assign employees to projects, phases, or specific tasks. See workload at a glance." },
  { icon: Timer,        title: "Time tracking",  desc: "Log hours to a project + phase. Rolls into project P&L using the configured hourly cost rate." },
  { icon: CalendarDays, title: "Team calendar",  desc: "Every task + event by assignee. Perfect for weekly stand-ups." },
  { icon: Megaphone,    title: "Announcements",  desc: "Post company-wide notices with read receipts. Keeps remote teams aligned." },
];

export default function TeamPlaceholder() {
  return (
    <div className="max-w-3xl mx-auto py-16 space-y-6" data-testid="team-placeholder">
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-emerald-100 text-emerald-600 flex items-center justify-center">
          <Building2 size={28} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-emerald-600 font-semibold">Team · Phase B</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            Run the day-to-day human side.
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Employees, tasks, calendar, and light time tracking — connected to your projects so the labor cost side of job costing writes itself.
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-gradient-to-br from-emerald-50 to-white p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-emerald-800 mb-3">
          <Sparkles size={14} /> Coming in Phase B
        </div>
        <ul className="grid sm:grid-cols-2 gap-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-white border border-emerald-200 text-emerald-600 flex items-center justify-center shrink-0">
                <f.icon size={14} />
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">{f.title}</div>
                <div className="text-xs text-slate-600 leading-snug">{f.desc}</div>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="text-xs text-slate-500 italic">
        You already have the Tasks drawer in the top bar — <span className="text-emerald-700">press ⌘⇧T</span> to try it now.
        Full task pages and per-employee views land in Phase B.
        <div className="mt-1">Need Projects? <Link to="/accounting/projects" className="text-emerald-700 hover:underline">Jump there</Link>.</div>
      </div>
    </div>
  );
}
