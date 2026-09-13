import React from "react";
import { Outlet } from "react-router-dom";

// --------------------------------------------------------------------------
// CockpitLayout — shared shell for every /cockpit/* page.
//
// The secondary "Practice" rail (Today, Close, 1099, Agents, …) used to
// live here; it now sits in the main Sidebar as a Cockpit dropdown so
// every Cockpit page gets the full width of the content pane. This
// wrapper is kept as a stable outlet in case we later re-introduce a
// page-scoped rail on a subset of Cockpit surfaces.
// --------------------------------------------------------------------------

export default function CockpitLayout() {
  return (
    <div
      className="min-h-[calc(100vh-4rem)] bg-slate-50"
      data-testid="cockpit-shell"
    >
      <main className="flex-1 min-w-0" data-testid="cockpit-content">
        <Outlet />
      </main>
    </div>
  );
}
