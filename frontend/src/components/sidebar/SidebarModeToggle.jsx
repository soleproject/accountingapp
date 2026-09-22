import React from "react";

/**
 * SidebarModeToggle — three-way switch that controls the whole
 * sidebar layout:
 *
 *   • "todo" — only this toggle + the To Do card list. No menu.
 *   • "both" — the toggle, a reduced quick-links strip
 *              (Dashboard / Invoices / Bills / Transactions /
 *              Receipts / Reports), and the To Do card list.
 *   • "full" — the normal sidebar (search + Today / Pro Cockpit /
 *              modules …) with the toggle pinned above Dashboard.
 *
 * The mode is owned by Sidebar.jsx (persisted in localStorage) and
 * flows in as a controlled prop so the rest of the sidebar knows
 * which surface to render.
 */
const OPTIONS = [
  { value: "todo", label: "To Do" },
  { value: "both", label: "Both" },
  { value: "full", label: "Full" },
];

export default function SidebarModeToggle({ mode = "full", onChange }) {
  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden text-[11px] bg-white"
      role="tablist"
      aria-label="Sidebar view"
      data-testid="sidebar-mode-toggle"
    >
      {OPTIONS.map((o, i) => {
        const active = mode === o.value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange?.(o.value)}
            data-testid={`sidebar-mode-toggle-${o.value}`}
            className={`px-2.5 py-1 transition-colors ${
              i > 0 ? "border-l border-slate-300" : ""
            } ${
              active
                ? "bg-slate-500 text-white font-semibold"
                : "text-slate-700 hover:bg-slate-50"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
