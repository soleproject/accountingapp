import { Users, Sparkles, Target, PhoneCall, StickyNote, CalendarDays } from "lucide-react";
import { Link } from "react-router-dom";

/**
 * CRM landing — placeholder while Phase C is under construction.
 * Renders the vision so users understand what's coming and can
 * request early access via the CTA.
 */
const FEATURES = [
  { icon: Target,       title: "Deal pipeline",   desc: "Kanban board of Leads → Qualified → Proposal → Won. Drag cards to move stages." },
  { icon: Users,        title: "Contacts (CRM view)", desc: "Same customers you already know, with lead-source, deal history, and stage." },
  { icon: PhoneCall,    title: "Activities",       desc: "Log calls, emails, meetings on any contact or deal — unified timeline." },
  { icon: StickyNote,   title: "Notes",            desc: "Free-form notes attach to any contact/deal so nothing falls through." },
  { icon: CalendarDays, title: "Calendar",         desc: "See every scheduled activity across the pipeline in one view." },
];

export default function CrmPlaceholder() {
  return (
    <div className="max-w-3xl mx-auto py-16 space-y-6" data-testid="crm-placeholder">
      <div className="flex items-center gap-3">
        <div className="w-14 h-14 rounded-2xl bg-violet-100 text-violet-600 flex items-center justify-center">
          <Users size={28} />
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-violet-600 font-semibold">CRM · Phase C</div>
          <h1 className="font-heading text-3xl font-bold tracking-tight text-slate-900">
            Close more deals. Lose fewer leads.
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Sales pipeline, deal tracking, and activity logging — built on top of your accounting so a won deal becomes a project becomes an invoice, all in one system.
          </p>
        </div>
      </div>

      <div className="rounded-xl border bg-gradient-to-br from-violet-50 to-white p-5">
        <div className="flex items-center gap-2 text-sm font-semibold text-violet-800 mb-3">
          <Sparkles size={14} /> Coming in Phase C
        </div>
        <ul className="grid sm:grid-cols-2 gap-4">
          {FEATURES.map((f) => (
            <li key={f.title} className="flex gap-3">
              <div className="w-8 h-8 rounded-lg bg-white border border-violet-200 text-violet-600 flex items-center justify-center shrink-0">
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
        In the meantime you already have Contacts under Accounting →
        <Link to="/contacts" className="text-violet-600 hover:underline"> jump there</Link>.
      </div>
    </div>
  );
}
