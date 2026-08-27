import { useEffect, useState } from "react";
import { Briefcase, Layers, Tags } from "lucide-react";
import { useCompany } from "@/lib/company";
import { api } from "@/lib/api";

/**
 * Compact pill-card that renders Class / Project / Phase pickers
 * conditional on the company's Advanced-Features flags. Designed to
 * be embedded in the Invoice / Bill / Estimate editors above the
 * customer form so a PM can link the doc to a specific job without
 * leaving the page.
 *
 * Props:
 *   - value: { class_id, project_id, phase_id }
 *   - onChange({ class_id?, project_id?, phase_id? }): partial update
 *   - contactId (optional): filters projects to this customer only
 *   - direction: "customer" | "vendor" — projects filter only for customer docs
 */
export default function ProjectPhaseClassPicker({
  value, onChange, contactId, direction = "customer",
}) {
  const { currentId, classesEnabled, projectsEnabled } = useCompany();
  const [classes, setClasses] = useState([]);
  const [projects, setProjects] = useState([]);
  const [phases, setPhases] = useState([]);

  useEffect(() => {
    if (!currentId) return;
    if (classesEnabled) {
      api.get(`/companies/${currentId}/classes`)
        .then(r => setClasses(r.data?.classes || []))
        .catch(() => setClasses([]));
    }
    if (projectsEnabled) {
      api.get(`/companies/${currentId}/projects`)
        .then(r => {
          let rows = r.data?.projects || [];
          // Customer-side docs (invoice/estimate) filter to this
          // customer's projects only. Vendor-side (bill) shows all.
          if (direction === "customer" && contactId) {
            rows = rows.filter(p => p.contact_id === contactId);
          }
          setProjects(rows);
        })
        .catch(() => setProjects([]));
    }
  }, [currentId, classesEnabled, projectsEnabled, contactId, direction]);

  // Fetch phases whenever project changes.
  useEffect(() => {
    if (!currentId || !value?.project_id) { setPhases([]); return; }
    api.get(`/companies/${currentId}/projects/${value.project_id}/phases`)
      .then(r => setPhases(r.data?.phases || []))
      .catch(() => setPhases([]));
  }, [currentId, value?.project_id]);

  if (!classesEnabled && !projectsEnabled) return null;

  return (
    <div className="rounded-lg border bg-white shadow-sm p-3 flex flex-wrap gap-3 items-end text-sm"
         data-testid="doc-project-picker">
      {classesEnabled && (
        <div className="min-w-[180px]">
          <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1">
            <Tags size={11} /> Class
          </label>
          <select value={value?.class_id || ""}
                  onChange={(e) => onChange({ class_id: e.target.value || null })}
                  data-testid="doc-class-picker"
                  className="w-full border rounded px-2 py-1.5 text-sm bg-white">
            <option value="">— None —</option>
            {classes.filter(c => c.active !== false).map(c => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
      )}
      {projectsEnabled && (
        <>
          <div className="min-w-[220px]">
            <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1">
              <Briefcase size={11} /> Project
            </label>
            <select value={value?.project_id || ""}
                    onChange={(e) => {
                      // Changing the project must clear the phase — one
                      // phase belongs to exactly one project.
                      onChange({ project_id: e.target.value || null, phase_id: null });
                    }}
                    data-testid="doc-project-picker-select"
                    className="w-full border rounded px-2 py-1.5 text-sm bg-white">
              <option value="">— None —</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.contact_name ? ` · ${p.contact_name}` : ""}
                </option>
              ))}
            </select>
            {direction === "customer" && contactId && projects.length === 0 && (
              <div className="text-[10px] text-slate-400 mt-0.5 italic">
                No projects for this customer yet.
              </div>
            )}
          </div>
          {value?.project_id && phases.length > 0 && (
            <div className="min-w-[180px]">
              <label className="text-[10px] uppercase tracking-wide text-slate-500 mb-1 flex items-center gap-1">
                <Layers size={11} /> Phase
              </label>
              <select value={value?.phase_id || ""}
                      onChange={(e) => onChange({ phase_id: e.target.value || null })}
                      data-testid="doc-phase-picker"
                      className="w-full border rounded px-2 py-1.5 text-sm bg-white">
                <option value="">— None —</option>
                {phases.map(ph => (
                  <option key={ph.id} value={ph.id}>{ph.name}</option>
                ))}
              </select>
            </div>
          )}
        </>
      )}
    </div>
  );
}
