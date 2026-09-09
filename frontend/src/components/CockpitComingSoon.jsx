import React from "react";
import { Sparkles } from "lucide-react";

// Reusable "Coming soon" empty state for the Cockpit rails that ship
// as IA slots in Phase 1 but haven't been fully built yet. Each rail
// passes its own title + tagline + phase estimate.
export default function CockpitComingSoon({ title, tagline, phase, features, testid }) {
  return (
    <div className="p-6 max-w-3xl mx-auto" data-testid={testid || "cockpit-coming-soon"}>
      <div className="bg-white rounded-xl border border-slate-200 p-8">
        <div className="flex items-center gap-2 text-fuchsia-600 mb-2">
          <Sparkles size={16} />
          <span className="text-[10px] uppercase tracking-widest font-semibold">
            Coming soon · {phase}
          </span>
        </div>
        <h1 className="font-heading text-3xl font-bold text-slate-900 tracking-tight">
          {title}
        </h1>
        <p className="text-slate-600 mt-2">{tagline}</p>
        {features && features.length > 0 && (
          <div className="mt-6 pt-6 border-t border-slate-100">
            <div className="text-xs uppercase tracking-wider text-slate-500 font-semibold mb-3">
              What's coming
            </div>
            <ul className="space-y-2">
              {features.map((f, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className="text-fuchsia-500 mt-0.5">•</span>
                  <span>{f}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
